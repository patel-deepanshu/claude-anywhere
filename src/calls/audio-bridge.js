'use strict';

/**
 * Call audio routing (docs/CALLS-DESIGN.md §5): our cloned voice goes into the call through a
 * virtual microphone, and the caller's audio comes back to the sidecar for speech recognition. The
 * routing lasts only while the assistant handles a call and is always restored, also after a crash.
 *
 *   Linux   PulseAudio or PipeWire (pipewire-pulse) through `pactl`:
 *             anywhere_tts   null sink our voice is played into (pacat)
 *             anywhere_mic   remap-source of anywhere_tts.monitor: the virtual microphone (Chromium hides
 *                            monitor sources, so the remap is required)
 *             anywhere_call  null sink the browser's sink-inputs are moved to; parec records its monitor
 *             loopback       anywhere_call.monitor -> the user's speakers, so the user still hears the caller
 *           engage: set-default-source anywhere_mic, move the browser's sink-inputs to anywhere_call and its
 *           mic source-outputs to anywhere_mic (and keep following new streams); release restores all of it.
 *   Windows VB-CABLE: the sidecar plays into "CABLE Input", the default recording device is switched to
 *   / WSL   "CABLE Output" through the PowerShell host (IPolicyConfig: ops audioDefaultGet/audioDefaultSet),
 *           and the caller is captured with WASAPI loopback of the speakers (python soundcard).
 *   macOS   BlackHole 2ch as the microphone (default input switched by the sidecar through CoreAudio), the
 *           caller captured with ScreenCaptureKit, or BlackHole 16ch + a Multi-Output Device as the fallback.
 *   speakers  No virtual devices (calls.audio.mode 'speakers', or 'auto' when they are missing): our voice
 *           plays through the speakers and the physical mic picks it up; capture is the system loopback
 *           (Linux: <default sink>.monitor; Windows: WASAPI loopback) or the mic (macOS). Half duplex.
 *
 * Crash safety: everything needed to undo the routing is written to <state>/run/calls-audio.json before it
 * is changed. restoreFromCrash() (daemon start) and restoreSync() (process 'exit') undo a left-over state.
 *
 * Exports: AudioBridge, AudioSelfTest (§5.5, the routes are mounted by routes-calls.js from
 * SELF_TEST_ROUTES), doctorChecks() (§5.6 rows in `anywhere doctor` format), and the pure helpers
 * buildPactlPlan(), parseSinkInputs(), parsePactlStreams(), parsePactlInfo(), parseShortList(),
 * parseShortModules(), phraseScore(), wavLevel().
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const proc = require('../shared/proc');
const paths = require('../shared/paths');
const { createLogger } = require('../shared/log');

const log = createLogger('calls-audio');

const STATE_VERSION = 1;
const STATE_FILE = 'calls-audio.json';
const SELF_TEST_FILE = 'calls-audio-test.json';
const OWN_ID = 'claude-anywhere';

/** Pulse object names (our modules are recognized by them, also after a crash). */
const NAMES = Object.freeze({ tts: 'anywhere_tts', mic: 'anywhere_mic', call: 'anywhere_call' });
const DESCRIPTIONS = Object.freeze({
  tts: 'Claude-Anywhere-Voice-Out',
  mic: 'Claude-Anywhere-Mic',
  call: 'Claude-Anywhere-Call-Capture',
});

/** Virtual devices per OS: the recording device the call app uses, and the device our voice is played into. */
const VIRTUAL = Object.freeze({
  linux: { mic: NAMES.mic, playback: NAMES.tts },
  win32: { mic: 'CABLE Output', playback: 'CABLE Input' },
  darwin: { mic: 'BlackHole 2ch', playback: 'BlackHole 2ch', fallbackCapture: 'BlackHole 16ch' },
});

const HINTS = Object.freeze({
  pactl: 'Install the PulseAudio tools (Debian/Ubuntu: sudo apt install pulseaudio-utils; Fedora: sudo dnf install pulseaudio-utils). They work with PulseAudio and with PipeWire (pipewire-pulse).',
  pulseDown: 'Start the sound server: systemctl --user start pipewire-pulse (PipeWire) or pulseaudio --start (PulseAudio).',
  vbcable:
    'Install VB-CABLE (free) from https://vb-audio.com/Cable/ : unzip the driver pack, run VBCABLE_Setup_x64.exe as administrator, then reboot. ' +
    'Claude Anywhere does not install drivers itself.',
  blackhole: 'Install BlackHole 2ch (free): brew install blackhole-2ch (or the installer from https://existential.audio/blackhole/), then restart the call app.',
  blackhole16: 'For caller capture without ScreenCaptureKit: brew install blackhole-16ch, create a Multi-Output Device (your speakers + BlackHole 16ch) in Audio MIDI Setup and choose it as the output of the browser or of macOS.',
  sck: 'ScreenCaptureKit (macOS 13+) captures the call audio; it needs the Screen Recording permission that screenshots already use.',
  tccMic: 'Reading BlackHole as an input makes macOS ask for the Microphone permission of the app that runs Claude Code; allow it in System Settings > Privacy & Security > Microphone.',
  speakers: 'Speaker mode works without virtual devices but sounds worse: the caller hears room echo, headphones break it, and the assistant cannot be interrupted (half duplex).',
  pinnedMic: 'If the call app has a specific microphone selected, choose "Default" in its audio settings so it follows the virtual microphone during AI-answered calls.',
  selfTest: 'Run the audio self-test: anywhere calls test-audio',
  sidecar: 'Install the voice runtime first: anywhere clone-voice install',
});

/** Process names of browsers and desktop call apps (matched against application.process.binary / application.name). */
const APP_BINARIES = Object.freeze({
  chrome: ['chrome', 'google-chrome', 'google-chrome-stable', 'google chrome'],
  chromium: ['chromium', 'chromium-browser'],
  brave: ['brave', 'brave-browser', 'brave browser'],
  edge: ['msedge', 'microsoft-edge', 'microsoft edge'],
  firefox: ['firefox', 'firefox-bin', 'firefox-esr', 'firefox.real'],
  opera: ['opera'],
  vivaldi: ['vivaldi', 'vivaldi-bin'],
  zoom: ['zoom', 'zoomwebviewhost', 'zoom.us'],
  teams: ['teams', 'ms-teams', 'teams-for-linux'],
  slack: ['slack'],
  cliq: ['cliq', 'zoho cliq'],
});
const BROWSER_KEYS = ['chrome', 'chromium', 'brave', 'edge', 'firefox', 'opera', 'vivaldi'];
/** Chromium-family names share the binary "chrome" (Brave's flatpak too), so these aliases also match it. */
const CHROMIUM_FAMILY = new Set(['chrome', 'chromium', 'brave', 'edge', 'opera', 'vivaldi']);

// Digits and plain words, different per direction (a capture that hears the mic phrase must not pass).
const MIC_PHRASE = 'Testing one two three. Can you hear the microphone?';
const CAPTURE_PHRASE = 'Four five six. The sound from this tab is working.';

const DEFAULT_VAD = Object.freeze({ threshold: 0.5, minSilenceMs: 600, minSpeechMs: 250 });
const HALF_DUPLEX_VAD = Object.freeze({ threshold: 0.5, minSilenceMs: 800, minSpeechMs: 250 });

function bridgeError(message, code, hint, extra) {
  const e = new Error(message);
  e.code = code || 'AUDIO_BACKEND';
  if (hint) e.hint = hint;
  if (extra) Object.assign(e, extra);
  return e;
}

function lower(s) {
  return String(s == null ? '' : s).toLowerCase();
}

// ---------------------------------------------------------------------------------------- pactl parsing

/**
 * `pactl info` (run with LC_ALL=C).
 * @returns {{serverName:string, serverVersion:string, defaultSink:string|null, defaultSource:string|null, pipewire:boolean}}
 */
function parsePactlInfo(text) {
  const get = (label) => {
    const m = new RegExp(`^${label}:\\s*(.*)$`, 'mi').exec(String(text || ''));
    return m ? m[1].trim() : '';
  };
  const serverName = get('Server Name');
  const sink = get('Default Sink');
  const source = get('Default Source');
  return {
    serverName,
    serverVersion: get('Server Version'),
    defaultSink: sink && sink !== '(null)' && sink !== 'n/a' ? sink : null,
    defaultSource: source && source !== '(null)' && source !== 'n/a' ? source : null,
    pipewire: /pipewire/i.test(serverName),
  };
}

/**
 * `pactl list short sinks|sources|sink-inputs|source-outputs|clients` rows (tab separated).
 * @returns {Array<{index:string, name:string, driver:string, spec:string, state:string, fields:string[]}>}
 */
function parseShortList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (!/^\d+$/.test(f[0])) continue;
    out.push({ index: f[0], name: f[1] || '', driver: f[2] || '', spec: f[3] || '', state: (f[4] || '').trim(), fields: f });
  }
  return out;
}

/** `pactl list short modules` → [{index, name, args}] */
function parseShortModules(text) {
  return parseShortList(text).map((r) => ({ index: r.index, name: r.name, args: (r.fields[2] || '').trim() }));
}

function unquotePropValue(v) {
  const s = String(v || '').trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return s;
}

/**
 * The long `pactl list sink-inputs` / `pactl list source-outputs` output (LC_ALL=C).
 * @returns {Array<{kind:'sink-input'|'source-output', index:string, driver:string, ownerModule:string|null,
 *   client:string|null, sink?:string, source?:string, corked:boolean, mute:boolean, props:Object<string,string>}>}
 */
function parsePactlStreams(text) {
  const out = [];
  let cur = null;
  let inProps = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const head = /^(Sink Input|Source Output) #(\d+)\s*$/.exec(raw.trim());
    if (head && !/^\s/.test(raw)) {
      cur = { kind: head[1] === 'Sink Input' ? 'sink-input' : 'source-output', index: head[2], driver: '', ownerModule: null, client: null, corked: false, mute: false, props: {} };
      out.push(cur);
      inProps = false;
      continue;
    }
    if (!cur) continue;
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^\t\t|^ {8}/.test(line) && inProps) {
      const m = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(line);
      if (m) cur.props[m[1].trim()] = unquotePropValue(m[2]);
      continue;
    }
    const kv = /^\s*([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    inProps = key === 'Properties';
    if (key === 'Driver') cur.driver = val;
    else if (key === 'Owner Module') cur.ownerModule = /^\d+$/.test(val) ? val : null;
    else if (key === 'Client') cur.client = /^\d+$/.test(val) ? val : null;
    else if (key === 'Sink') cur.sink = val;
    else if (key === 'Source') cur.source = val;
    else if (key === 'Corked') cur.corked = val === 'yes';
    else if (key === 'Mute') cur.mute = val === 'yes';
  }
  return out;
}

/** `pactl list sink-inputs` → the sink-input records of parsePactlStreams(). */
function parseSinkInputs(text) {
  return parsePactlStreams(text).filter((s) => s.kind === 'sink-input');
}

/** One of our own streams (pacat/parec of the sidecar or the self-test), or a module's internal stream. */
function isOwnStream(s) {
  if (!s) return true;
  const p = s.props || {};
  if (lower(p['application.id']) === OWN_ID) return true;
  if (/^claude[- ]anywhere/i.test(p['application.name'] || '')) return true;
  if (/^module-/i.test(s.driver || '')) return true; // remap-source, loopback, null-sink internals
  if (p['media.name'] === 'Remapped Stream' || p['media.role'] === 'filter') return true;
  return false;
}

function appNamesOf(s) {
  const p = (s && s.props) || {};
  const names = [p['application.process.binary'], p['application.name'], p['application.icon_name'], p['pipewire.access.portal.app_id'], p['application.id']]
    .filter(Boolean)
    .map((x) => lower(x).replace(/\.exe$/, ''));
  return names;
}

/**
 * Does the stream belong to `app` (a key of APP_BINARIES, a process name, or empty for "any browser or
 * call app")?
 */
function streamMatchesApp(s, app) {
  if (isOwnStream(s)) return false;
  const names = appNamesOf(s);
  if (!names.length) return false;
  const want = lower(app).trim();
  let keys;
  if (!want) keys = Object.keys(APP_BINARIES);
  else if (APP_BINARIES[want]) keys = CHROMIUM_FAMILY.has(want) ? Array.from(new Set([want, 'chrome', 'chromium'])) : [want];
  else keys = null;
  const candidates = keys ? keys.flatMap((k) => APP_BINARIES[k]) : [want];
  return names.some((n) => candidates.some((c) => n === c || n.startsWith(`${c} `) || n.startsWith(`${c}-`) || (c.length >= 5 && n.startsWith(c))));
}

/**
 * The pactl commands of the Linux routing (pure). Module load commands carry their role, so setup can
 * record which module index is which; engage/release commands are built from the recorded moves.
 * @param {{defaultSink?:string|null, rate?:number, latencyMs?:number, loopback?:boolean,
 *   modules?:Array<{index:string|number}>, savedSource?:string|null,
 *   moves?:{sinkInputs?:Array<{index:string, from?:string|null}>, sourceOutputs?:Array<{index:string, from?:string|null}>}}} [opts]
 * @returns {{setup:Array<{role:string, module:string, args:string[], command:string[]}>, engage:string[][], release:string[][], teardown:string[][]}}
 */
function buildPactlPlan({ defaultSink = null, rate = 48000, latencyMs = 60, loopback = true, modules = [], savedSource = null, moves = {} } = {}) {
  const mod = (role, module, args) => ({ role, module, args, command: ['load-module', module, ...args] });
  const setup = [
    mod('tts', 'module-null-sink', [`sink_name=${NAMES.tts}`, `rate=${rate}`, 'channels=1', `sink_properties=device.description=${DESCRIPTIONS.tts}`]),
    mod('mic', 'module-remap-source', [`master=${NAMES.tts}.monitor`, `source_name=${NAMES.mic}`, `source_properties=device.description=${DESCRIPTIONS.mic}`]),
    mod('call', 'module-null-sink', [`sink_name=${NAMES.call}`, `sink_properties=device.description=${DESCRIPTIONS.call}`]),
  ];
  // The user keeps hearing the caller. Only with a real default sink: a loop into one of our own sinks
  // would feed the capture back into itself.
  if (loopback && defaultSink && !isOurName(defaultSink)) {
    setup.push(
      mod('monitor', 'module-loopback', [
        `source=${NAMES.call}.monitor`,
        `sink=${defaultSink}`,
        `latency_msec=${latencyMs}`,
        'source_dont_move=true',
        `sink_input_properties=application.id=${OWN_ID}`,
      ]),
    );
  }
  const si = (moves && moves.sinkInputs) || [];
  const so = (moves && moves.sourceOutputs) || [];
  const engage = [['set-default-source', NAMES.mic], ...si.map((m) => ['move-sink-input', String(m.index), NAMES.call]), ...so.map((m) => ['move-source-output', String(m.index), NAMES.mic])];
  const release = [];
  if (savedSource && !isOurName(savedSource)) release.push(['set-default-source', savedSource]);
  for (const m of si) release.push(['move-sink-input', String(m.index), m.from && !isOurName(m.from) ? m.from : defaultSink && !isOurName(defaultSink) ? defaultSink : '@DEFAULT_SINK@']);
  for (const m of so) {
    const back = m.from && !isOurName(m.from) ? m.from : savedSource && !isOurName(savedSource) ? savedSource : '@DEFAULT_SOURCE@';
    release.push(['move-source-output', String(m.index), back]);
  }
  const teardown = (modules || [])
    .slice()
    .reverse()
    .map((m) => ['unload-module', String(m.index)]);
  return { setup, engage, release, teardown };
}

function isOurName(name) {
  return /^anywhere_(tts|mic|call)(\.monitor)?$/.test(String(name || ''));
}

/** Does a loaded module (from `pactl list short modules`) belong to us, and with which role? */
function ourModuleRole(m) {
  const a = ` ${String((m && m.args) || '')} `;
  if (m.name === 'module-null-sink' && a.includes(` sink_name=${NAMES.tts} `)) return 'tts';
  if (m.name === 'module-remap-source' && a.includes(` source_name=${NAMES.mic} `)) return 'mic';
  if (m.name === 'module-null-sink' && a.includes(` sink_name=${NAMES.call} `)) return 'call';
  if (m.name === 'module-loopback' && a.includes(` source=${NAMES.call}.monitor `)) return 'monitor';
  return null;
}

// ---------------------------------------------------------------------------------------- audio helpers

/**
 * The first channel of a PCM16 or float32 WAV buffer.
 * @returns {{ok:true, rate:number, channels:number, samples:Float32Array}|{ok:false, error:string}}
 */
function decodeWav(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return { ok: false, error: 'not a WAV file' };
    let off = 12;
    let fmt = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      let size = buf.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'fmt ') {
        let tag = buf.readUInt16LE(body);
        if (tag === 0xfffe && size >= 26) tag = buf.readUInt16LE(body + 24);
        fmt = { tag, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
      } else if (id === 'data' && fmt) {
        if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
        const width = fmt.bits / 8;
        if (!((fmt.tag === 1 && fmt.bits === 16) || (fmt.tag === 3 && fmt.bits === 32)) || fmt.channels < 1 || fmt.rate < 1000) return { ok: false, error: 'unsupported WAV encoding' };
        const frames = Math.floor(size / (width * fmt.channels));
        const samples = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          const p = body + i * width * fmt.channels;
          samples[i] = fmt.tag === 3 ? buf.readFloatLE(p) : buf.readInt16LE(p) / 32768;
        }
        return { ok: true, rate: fmt.rate, channels: fmt.channels, samples };
      }
      off = body + size + (size % 2);
    }
    return { ok: false, error: 'the WAV file has no audio data' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const dbOf = (x) => (x > 1e-9 ? Math.round(20 * Math.log10(x) * 10) / 10 : -120);

/**
 * Level of a PCM16 or float32 WAV buffer.
 * @returns {{ok:boolean, rate:number, channels:number, seconds:number, peakDbfs:number, rmsDbfs:number}|{ok:false, error:string}}
 */
function wavLevel(buf) {
  const d = decodeWav(buf);
  if (!d.ok) return d;
  let peak = 0;
  let sum = 0;
  for (const v of d.samples) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  const n = d.samples.length;
  return { ok: true, rate: d.rate, channels: d.channels, seconds: n / d.rate, peakDbfs: dbOf(peak), rmsDbfs: dbOf(n ? Math.sqrt(sum / n) : 0) };
}

/**
 * The WAV with leading and trailing silence cut (20 ms frames against max(noise floor x 3.16, -50 dBFS),
 * keeping `marginMs`), as 16-bit mono. Moonshine returns nothing for some clips that start with a second
 * of digital silence, which a call capture or a browser recording often does. Null without speech.
 * @returns {Buffer|null}
 */
function trimWav(buf, { marginMs = 150 } = {}) {
  const d = decodeWav(buf);
  if (!d.ok || !d.samples.length) return null;
  const frame = Math.max(1, Math.round(d.rate * 0.02));
  const n = Math.floor(d.samples.length / frame);
  if (n < 3) return null;
  const rms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * frame; k < (i + 1) * frame; k++) s += d.samples[k] * d.samples[k];
    rms[i] = Math.sqrt(s / frame);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noise = sorted[Math.floor(n * 0.1)];
  // (a clip that is speech from end to end has its "noise floor" at the speech level)
  const thr = Math.max(Math.min(noise * 3.16, sorted[n - 1] * 0.25), 0.00316);
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (rms[i] > thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  const pad = Math.round((marginMs / 1000) * d.rate);
  const a = Math.max(0, first * frame - pad);
  const b = Math.min(d.samples.length, (last + 1) * frame + pad);
  const pcm = Buffer.alloc((b - a) * 2);
  for (let i = a; i < b; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(d.samples[i] * 32767))), (i - a) * 2);
  return pcmToWav(pcm, d.rate);
}

/** 16-bit mono WAV of raw s16le PCM. */
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const NUMBER_WORDS = { zero: '0', oh: '0', one: '1', won: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4', fore: '4', five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9' };

function phraseWords(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/(\d)/g, ' $1 ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] || w);
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/**
 * How much of the expected test phrase a transcript contains (words in any order; words of 4+ letters
 * match at edit distance ≤ len/3; "any where" matches "anywhere").
 * @returns {{score:number, pass:boolean, matched:string[], missing:string[]}}
 */
function phraseScore(expected, transcript, { threshold = 0.6 } = {}) {
  const want = phraseWords(expected).filter((w) => !['the', 'a', 'an'].includes(w));
  const got = phraseWords(transcript);
  const pool = got.slice();
  for (let i = 0; i + 1 < got.length; i++) pool.push(got[i] + got[i + 1]);
  const matched = [];
  const missing = [];
  for (const w of want) {
    const ok = pool.some((g) => g === w || (w.length >= 4 && g.length >= 3 && editDistance(w, g) <= Math.floor(w.length / 3)));
    (ok ? matched : missing).push(w);
  }
  const score = want.length ? Math.round((matched.length / want.length) * 100) / 100 : 0;
  return { score, pass: score >= threshold, matched, missing };
}

/** "pulse:<source>", "wasapi-loopback[:<speaker>]", "sck[:<app>]", "device:<name>", or a bare pulse source name. */
function parseCaptureOverride(value, platform) {
  const s = String(value || '').trim();
  if (!s) return null;
  const m = /^(pulse|wasapi-loopback|sck|device):(.*)$/i.exec(s);
  if (m) {
    const backend = m[1].toLowerCase();
    const rest = m[2].trim();
    if (backend === 'sck') return { backend, device: '', app: rest };
    return { backend, device: rest };
  }
  if (/^(wasapi-loopback|sck)$/i.test(s)) return { backend: s.toLowerCase(), device: '' };
  return platform === 'linux' ? { backend: 'pulse', device: s } : { backend: 'device', device: s };
}

/** VB-Audio pairs "X Output" (recording) with "X Input" (playback); BlackHole uses one name for both. */
function playbackFor(virtualMic, platform) {
  const s = String(virtualMic || '');
  if (platform === 'win32') {
    if (/\bOutput\b/i.test(s)) return s.replace(/\bOutput\b/i, 'Input');
    return s;
  }
  if (platform === 'linux') return s === NAMES.mic ? NAMES.tts : s;
  return s;
}

function audioConfig(config) {
  const c = (config && config.calls && config.calls.audio) || {};
  const mode = ['auto', 'virtual', 'speakers'].includes(c.mode) ? c.mode : 'auto';
  return {
    mode,
    virtualMic: typeof c.virtualMic === 'string' ? c.virtualMic.trim() : '',
    capture: typeof c.capture === 'string' ? c.capture.trim() : '',
    switchDefaultInput: c.switchDefaultInput !== false,
  };
}

function findDevice(list, name) {
  const want = lower(name).trim();
  if (!want) return null;
  const arr = Array.isArray(list) ? list : [];
  return arr.find((d) => lower(d && d.name) === want) || arr.find((d) => lower(d && d.name).startsWith(want)) || arr.find((d) => lower(d && d.name).includes(want)) || null;
}

function bootTime() {
  return Math.round((Date.now() - os.uptime() * 1000) / 60000) * 60000;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function writePrivate(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------- AudioBridge

class AudioBridge extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.platformInfo]   shared/platform info() ({platform, isWSL})
   * @param {Function} [opts.runner]       (cmd, args, {timeoutMs, env, input}) => {code, stdout, stderr, error, timedOut}
   * @param {object|Function} [opts.sidecar] SidecarClient, or a function resolving to one (CloneService.getSidecar)
   * @param {object|Function} [opts.psHost]  Windows/WSL: the win32 driver (or its PsHost), or a function resolving to it
   * @param {object|Function} [opts.config]  the config, or a getter
   * @param {string} [opts.stateFile]      default <state>/run/calls-audio.json
   * @param {Function} [opts.which]
   * @param {object} [opts.env]
   * @param {number} [opts.followMs=1000]  how often new browser streams are moved while engaged (Linux)
   * @param {Function} [opts.spawn]        child_process.spawn (Node-side recording)
   * @param {Function} [opts.spawnSync]    child_process.spawnSync (restoreSync)
   */
  constructor(opts = {}) {
    super();
    const pi = opts.platformInfo || require('../shared/platform').info();
    this.platformInfo = pi;
    /** The audio side: WSL calls run in the Windows browser, so its audio is the Windows one (§5.4). */
    this.platform = pi.isWSL ? 'win32' : pi.platform === 'darwin' || pi.platform === 'win32' ? pi.platform : 'linux';
    this.isWSL = Boolean(pi.isWSL);
    this.runner = typeof opts.runner === 'function' ? opts.runner : proc.run;
    this.sidecarRef = opts.sidecar || null;
    this.psRef = opts.psHost || null;
    this.configRef = opts.config || null;
    this.which = typeof opts.which === 'function' ? opts.which : proc.which;
    this.env = opts.env || process.env;
    this.followMs = opts.followMs == null ? 1000 : opts.followMs;
    this.spawnFn = typeof opts.spawn === 'function' ? opts.spawn : childProcess.spawn;
    this.spawnSyncFn = typeof opts.spawnSync === 'function' ? opts.spawnSync : childProcess.spawnSync;
    this.stateFile = opts.stateFile || path.join(paths.runDir(), STATE_FILE);
    this.pid = opts.pid || process.pid;
    this.hostname = opts.hostname || os.hostname();
    this._chain = Promise.resolve();
    this._follow = null;
    this._following = false;
    this._mode = null;
    this._lastCheck = null;
    // F3-SAFE-F1: who holds the audio route ('call', 'selftest'): release() undoes the routing only when
    // the last holder lets go, so a self-test ending cannot pull the route out from under a call.
    this._owners = new Set();
    this.state = this._readState() || null;
    if (this.state && this.state.pid !== this.pid) this.state = null; // someone else's (restoreFromCrash handles it)
  }

  // ------------------------------------------------------------ small plumbing

  _cfg() {
    const c = typeof this.configRef === 'function' ? this.configRef() : this.configRef;
    return audioConfig(c || {});
  }

  async _sidecar() {
    const ref = this.sidecarRef;
    if (!ref) throw bridgeError('The voice runtime is not available', 'NO_SIDECAR', HINTS.sidecar);
    const sc = typeof ref === 'function' && typeof ref.request !== 'function' ? await ref() : ref;
    if (!sc || typeof sc.request !== 'function') throw bridgeError('The voice runtime is not available', 'NO_SIDECAR', HINTS.sidecar);
    this._scResolved = sc; // for restoreSync (python path), which cannot await a getter
    return sc;
  }

  /** A sidecar request with local paths converted for the child (WSL: Windows paths). */
  async _sc(op, params = {}, opts = {}) {
    const sc = await this._sidecar();
    const conv = (v) => (typeof v === 'string' && path.isAbsolute(v) && typeof sc.childPath === 'function' ? sc.childPath(v) : v);
    const p = { ...params };
    for (const k of ['wav', 'out']) if (p[k]) p[k] = conv(p[k]);
    return sc.request(op, p, opts);
  }

  async _ps() {
    const ref = this.psRef;
    if (!ref) throw bridgeError('The Windows audio switch needs the PowerShell host', 'NO_PS_HOST', 'Run Claude Anywhere on Windows or WSL with the desktop driver available (anywhere doctor).');
    const h = typeof ref === 'function' && typeof ref.request !== 'function' && typeof ref.audioDefaultGet !== 'function' ? await ref() : ref;
    if (!h) throw bridgeError('The Windows desktop driver is not available', 'NO_PS_HOST');
    this._psResolved = h; // for restoreSync (the host's command line), which cannot await a getter
    const req = (cmd, args, timeoutMs) => {
      if (typeof h[cmd] === 'function') return h[cmd](args);
      const host = typeof h.request === 'function' ? h : h.host;
      if (!host || typeof host.request !== 'function') throw bridgeError('The Windows desktop driver cannot switch audio devices', 'NO_PS_HOST');
      return host.request(cmd, args, { timeoutMs });
    };
    return {
      get: (flow) => req('audioDefaultGet', { flow }, 20000),
      set: (args) => req('audioDefaultSet', args, 20000),
      raw: h,
    };
  }

  async _pactl(args, { timeoutMs = 6000, allowFail = false } = {}) {
    const r = await this.runner('pactl', args, { timeoutMs, env: { ...this.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: '' } });
    const ok = r && !r.error && !r.timedOut && r.code === 0;
    if (!ok && !allowFail) {
      const why = (r && (r.error ? r.error.message : r.timedOut ? 'timed out' : String(r.stderr || '').trim())) || 'failed';
      const missing = r && r.error && r.error.code === 'ENOENT';
      throw bridgeError(`pactl ${args[0]} failed: ${why}`, missing ? 'PACTL_MISSING' : 'AUDIO_BACKEND', missing ? HINTS.pactl : HINTS.pulseDown);
    }
    return { ok, stdout: String((r && r.stdout) || ''), stderr: String((r && r.stderr) || '') };
  }

  /** Serialize routing changes (engage, release, follow ticks, teardown). */
  _serial(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  // ------------------------------------------------------------ crash-safe state file

  _readState(file = this.stateFile) {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      return s && typeof s === 'object' && s.version === STATE_VERSION ? s : null;
    } catch {
      return null;
    }
  }

  _writeState() {
    if (!this.state) return;
    this.state.updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      writePrivate(this.stateFile, JSON.stringify(this.state, null, 1));
    } catch (err) {
      log.warn(`could not write ${this.stateFile}: ${err.message}`);
    }
  }

  _clearState() {
    this.state = null;
    try {
      fs.unlinkSync(this.stateFile);
    } catch {
      /* already gone */
    }
  }

  _ensureState() {
    if (!this.state) {
      this.state = {
        version: STATE_VERSION,
        pid: this.pid,
        host: this.hostname,
        bootTime: bootTime(),
        platform: this.platform,
        wsl: this.isWSL,
        createdAt: new Date().toISOString(),
      };
    }
    return this.state;
  }

  // ------------------------------------------------------------ public API

  /** {mode, engaged, setup, platform, state} without touching the system. */
  status() {
    const s = this.state || {};
    return {
      platform: this.platform,
      wsl: this.isWSL,
      mode: this._mode || (this._lastCheck && this._lastCheck.mode) || null,
      setup: Boolean(s.pulse && s.pulse.modules && s.pulse.modules.length),
      engaged: Boolean((s.pulse && s.pulse.engaged) || (s.win32 && s.win32.engaged) || (s.darwin && s.darwin.engaged) || (s.speakers && s.speakers.engaged)),
      following: Boolean(this._follow),
    };
  }

  /**
   * What would be used and what is missing. Never changes routing. `deep` may start the sidecar (doctor).
   * @returns {Promise<{mode:'virtual'|'speakers', requested:string, ready:boolean, platform:string, backend:string,
   *   virtualMic:string, playback:string, capture:object|null, issues:Array<{code:string, level:'error'|'warn'|'info', message:string, hint?:string}>,
   *   server?:string, defaultSource?:string|null, defaultSink?:string|null}>}
   */
  async check({ deep = false } = {}) {
    const cfg = this._cfg();
    let r;
    if (this.platform === 'linux') r = await this._checkLinux(cfg);
    else if (this.platform === 'win32') r = await this._checkWin(cfg, deep);
    else r = await this._checkMac(cfg, deep);
    r.requested = cfg.mode;
    r.platform = this.platform;
    r.wsl = this.isWSL;
    r.switchDefaultInput = cfg.switchDefaultInput;
    // Effective mode: 'auto' falls back to the speakers when the virtual devices are missing.
    if (cfg.mode === 'speakers') r.mode = 'speakers';
    else if (cfg.mode === 'virtual') r.mode = 'virtual';
    else r.mode = r.virtualOk ? 'virtual' : 'speakers';
    if (cfg.mode === 'auto' && !r.virtualOk && r.speakersOk) {
      r.issues.push({ code: 'SPEAKERS_FALLBACK', level: 'warn', message: 'No virtual microphone: calls use the speakers and the microphone (works, lower quality).', hint: HINTS.speakers });
    }
    r.ready = r.mode === 'virtual' ? Boolean(r.virtualOk) : Boolean(r.speakersOk);
    if (r.mode === 'speakers' && cfg.mode === 'speakers') r.issues.push({ code: 'SPEAKER_MODE', level: 'info', message: 'Speaker mode (calls.audio.mode = speakers).', hint: HINTS.speakers });
    delete r.virtualOk;
    delete r.speakersOk;
    this._lastCheck = r;
    this._mode = r.mode;
    return r;
  }

  async _checkLinux(cfg) {
    const issues = [];
    const r = { backend: 'pulse', virtualMic: NAMES.mic, playback: NAMES.tts, capture: { backend: 'pulse', device: `${NAMES.call}.monitor` }, issues, virtualOk: false, speakersOk: false };
    if (!this.which('pactl')) {
      issues.push({ code: 'PACTL_MISSING', level: 'error', message: 'pactl is not installed.', hint: HINTS.pactl });
      return r;
    }
    let info;
    try {
      info = parsePactlInfo((await this._pactl(['info'])).stdout);
    } catch (err) {
      issues.push({ code: 'PULSE_UNREACHABLE', level: 'error', message: `The sound server does not answer: ${err.message}`, hint: HINTS.pulseDown });
      return r;
    }
    r.server = info.serverName + (info.serverVersion ? ` ${info.serverVersion}` : '');
    r.pipewire = info.pipewire;
    r.defaultSink = info.defaultSink;
    r.defaultSource = info.defaultSource;
    const tools = ['parec', 'pacat', 'paplay'].filter((t) => !this.which(t));
    if (tools.length) issues.push({ code: 'PULSE_TOOLS_MISSING', level: 'error', message: `${tools.join(', ')} not installed.`, hint: HINTS.pactl });
    const sinkOk = Boolean(info.defaultSink && !isOurName(info.defaultSink));
    if (!sinkOk) issues.push({ code: 'NO_OUTPUT_DEVICE', level: 'warn', message: 'No speakers or headphones are the default output, so you will not hear the caller during AI-answered calls.' });
    const mods = parseShortModules((await this._pactl(['list', 'short', 'modules'], { allowFail: true })).stdout);
    r.setup = mods.filter((m) => ourModuleRole(m)).map((m) => ({ index: m.index, role: ourModuleRole(m) }));
    r.virtualOk = !tools.length;
    r.speakersOk = !tools.length && sinkOk;
    const override = parseCaptureOverride(cfg.capture, 'linux');
    if (override) r.capture = override;
    if (cfg.virtualMic && cfg.virtualMic !== NAMES.mic) {
      issues.push({ code: 'VIRTUAL_MIC_IGNORED', level: 'info', message: `calls.audio.virtualMic "${cfg.virtualMic}" is not used on Linux: Claude Anywhere creates its own virtual microphone (${DESCRIPTIONS.mic}).` });
    }
    return r;
  }

  async _checkWin(cfg, deep) {
    const issues = [];
    const micName = cfg.virtualMic || VIRTUAL.win32.mic;
    const r = {
      backend: 'wasapi',
      virtualMic: micName,
      playback: playbackFor(micName, 'win32'),
      capture: parseCaptureOverride(cfg.capture, 'win32') || { backend: 'wasapi-loopback', device: '' },
      issues,
      virtualOk: false,
      speakersOk: false,
    };
    let all = null;
    try {
      const ps = await this._ps();
      all = await ps.get('all');
    } catch (err) {
      issues.push({ code: 'DEFAULT_SWITCH_UNAVAILABLE', level: 'error', message: `Cannot read the Windows audio devices: ${err.message}`, hint: err.hint });
    }
    if (all) {
      const cap = (all.capture && all.capture.devices) || [];
      const ren = (all.render && all.render.devices) || [];
      const vm = findDevice(cap, micName);
      const pb = findDevice(ren, r.playback);
      r.defaultSource = all.capture && all.capture.console ? all.capture.console.name : null;
      r.defaultSink = all.render && all.render.console ? all.render.console.name : null;
      if (!vm || !pb) issues.push({ code: 'VB_CABLE_MISSING', level: 'error', message: `The virtual cable is not installed (${!vm ? micName : r.playback} not found).`, hint: HINTS.vbcable });
      if (r.defaultSink && /cable input|vb-audio/i.test(r.defaultSink)) {
        issues.push({ code: 'CABLE_IS_DEFAULT_OUTPUT', level: 'warn', message: `${r.defaultSink} is the default output, so you would not hear the caller and the loopback would capture our own voice.`, hint: 'Choose your speakers or headphones as the default output in Sound settings.' });
      }
      r.virtualOk = Boolean(vm && pb);
      r.speakersOk = Boolean(r.defaultSink);
    }
    if (deep) await this._checkSidecarDevices(r, ['wasapi-loopback']);
    issues.push({ code: 'PINNED_MIC', level: 'info', message: HINTS.pinnedMic });
    return r;
  }

  async _checkMac(cfg, deep) {
    const issues = [];
    const micName = cfg.virtualMic || VIRTUAL.darwin.mic;
    const r = {
      backend: 'coreaudio',
      virtualMic: micName,
      playback: playbackFor(micName, 'darwin'),
      capture: parseCaptureOverride(cfg.capture, 'darwin') || { backend: 'sck', device: '', app: '' },
      issues,
      virtualOk: false,
      speakersOk: false,
    };
    let devs = null;
    try {
      devs = await this._sc('audio.devices', {}, { timeoutMs: 20000 });
    } catch (err) {
      issues.push({ code: err.code === 'NO_SIDECAR' ? 'NO_SIDECAR' : 'DEVICES_UNREADABLE', level: 'error', message: `Cannot list the audio devices: ${err.message}`, hint: err.hint || HINTS.sidecar });
    }
    if (devs) {
      const vm = findDevice(devs.inputs, micName);
      const pb = findDevice(devs.outputs, r.playback);
      if (!vm || !pb) issues.push({ code: 'BLACKHOLE_MISSING', level: 'error', message: `${micName} is not installed.`, hint: HINTS.blackhole });
      const sck = (devs.loopbacks || []).find((l) => l && l.backend === 'sck' && l.available !== false);
      const bh16 = findDevice(devs.inputs, VIRTUAL.darwin.fallbackCapture);
      if (r.capture.backend === 'sck' && !sck) {
        if (bh16) r.capture = { backend: 'device', device: bh16.name };
        else issues.push({ code: 'CAPTURE_UNAVAILABLE', level: 'error', message: 'Neither ScreenCaptureKit nor BlackHole 16ch is available to capture the caller.', hint: `${HINTS.sck} ${HINTS.blackhole16}` });
      }
      r.defaultSource = devs.defaults ? devs.defaults.input : null;
      r.defaultSink = devs.defaults ? devs.defaults.output : null;
      r.virtualOk = Boolean(vm && pb && (r.capture.backend !== 'sck' || sck || bh16));
      r.speakersOk = Boolean((devs.inputs || []).length && (devs.outputs || []).length);
      issues.push({ code: 'TCC_MICROPHONE', level: 'info', message: HINTS.tccMic });
    }
    if (deep && devs) r.loopbacks = devs.loopbacks || [];
    return r;
  }

  async _checkSidecarDevices(r, wantBackends) {
    try {
      const devs = await this._sc('audio.devices', {}, { timeoutMs: 20000 });
      r.loopbacks = devs.loopbacks || [];
      const have = new Set((devs.backends && Object.keys(devs.backends).filter((k) => devs.backends[k])) || []);
      for (const b of wantBackends) {
        if (b === 'wasapi-loopback' && !have.has('soundcard') && !(devs.loopbacks || []).length) {
          r.issues.push({ code: 'LOOPBACK_UNAVAILABLE', level: 'error', message: 'WASAPI loopback capture is not available in the voice runtime (python soundcard).', hint: 'Reinstall the voice runtime: anywhere clone-voice install --force' });
        }
      }
      if (devs.outputs && !findDevice(devs.outputs, r.playback) && r.virtualOk) {
        r.issues.push({ code: 'PLAYBACK_NOT_IN_RUNTIME', level: 'warn', message: `The voice runtime does not see "${r.playback}".` });
      }
    } catch (err) {
      r.issues.push({ code: 'NO_SIDECAR', level: 'warn', message: `The voice runtime did not list devices: ${err.message}`, hint: err.hint || HINTS.sidecar });
    }
  }

  /** Create the virtual devices (Linux; elsewhere they are installed by the user). Idempotent. */
  async setup() {
    await this._crashCheck();
    return this._serial(() => this._setup());
  }

  /** Before the first change: undo what a crashed daemon left (its state file would be overwritten). */
  async _crashCheck() {
    if (this._crashChecked) return;
    this._crashChecked = true;
    const st = this._readState();
    if (!st || st.pid === this.pid) return;
    try {
      await this.restoreFromCrash();
    } catch (err) {
      log.warn(`restoring the audio routing of process ${st.pid} failed: ${err.message}`);
    }
  }

  async _setup() {
    if (this.platform !== 'linux') {
      const c = this._lastCheck || (await this.check());
      return { ok: c.ready, mode: c.mode, modules: [] };
    }
    const mode = this._mode || (await this.check()).mode;
    if (mode === 'speakers') return { ok: true, mode, modules: [] };
    const info = parsePactlInfo((await this._pactl(['info'])).stdout);
    const st = this._ensureState();
    st.pulse = st.pulse || { modules: [], engaged: false };
    if (!st.pulse.savedDefaultSink) st.pulse.savedDefaultSink = info.defaultSink;
    if (!st.pulse.savedDefaultSource) st.pulse.savedDefaultSource = info.defaultSource;
    st.pulse.server = info.serverName;
    const existing = parseShortModules((await this._pactl(['list', 'short', 'modules'])).stdout);
    const plan = buildPactlPlan({ defaultSink: info.defaultSink && !isOurName(info.defaultSink) ? info.defaultSink : st.pulse.savedDefaultSink });
    const adopted = [];
    for (const step of plan.setup) {
      const have = existing.find((m) => ourModuleRole(m) === step.role);
      if (have) {
        const rec = st.pulse.modules.find((m) => m.role === step.role);
        if (!rec) st.pulse.modules.push({ index: have.index, role: step.role, name: have.name, adopted: true });
        else if (rec.index !== have.index) Object.assign(rec, { index: have.index, adopted: true });
        adopted.push(step.role);
        continue;
      }
      if (st.pulse.modules.some((m) => m.role === step.role)) st.pulse.modules = st.pulse.modules.filter((m) => m.role !== step.role);
      const out = await this._pactl(step.command, { timeoutMs: 10000 });
      const index = (out.stdout.trim().match(/^\d+/) || [''])[0];
      st.pulse.modules.push({ index, role: step.role, name: step.module });
      this._writeState(); // after every module: a crash in between still knows what to unload
    }
    this._writeState();
    // A new sink or source can become the default (module-switch-on-connect, PipeWire priorities).
    const after = parsePactlInfo((await this._pactl(['info'])).stdout);
    if (isOurName(after.defaultSink) && st.pulse.savedDefaultSink && !isOurName(st.pulse.savedDefaultSink)) await this._pactl(['set-default-sink', st.pulse.savedDefaultSink], { allowFail: true });
    if (isOurName(after.defaultSource) && !st.pulse.engaged && st.pulse.savedDefaultSource && !isOurName(st.pulse.savedDefaultSource)) {
      await this._pactl(['set-default-source', st.pulse.savedDefaultSource], { allowFail: true });
    }
    return { ok: true, mode, modules: st.pulse.modules.map((m) => ({ ...m })), adopted };
  }

  /**
   * Route the call's audio through us (before or right after Accept). Also used by the self-test.
   * @param {{browserApp?:string}} [opts] the call app's browser/app key (chrome, brave, edge, firefox, teams, zoom ...); empty = any
   * @returns {Promise<{ok:true, mode:string, capture:object, playback:object, halfDuplex:boolean, startParams:object, moved?:object}>}
   */
  async engage({ browserApp = '', owner = 'call' } = {}) {
    await this._crashCheck();
    if (!this._mode) await this.check();
    if (this.platform === 'linux' && this._mode === 'virtual') await this.setup();
    return this._serial(async () => {
      let r;
      if (this._mode === 'speakers') r = await this._engageSpeakers();
      else if (this.platform === 'linux') r = await this._engageLinux(browserApp);
      else if (this.platform === 'win32') r = await this._engageWin();
      else r = await this._engageMac(browserApp);
      // A call's app wins over a self-test's "any browser".
      if (owner === 'call' || !this._owners.has('call')) this._browserApp = browserApp;
      this._owners.add(String(owner || 'call'));
      r.startParams = this.startParams();
      this.emit('engaged', { mode: this._mode, platform: this.platform });
      return r;
    });
  }

  async _engageSpeakers() {
    const st = this._ensureState();
    st.speakers = { engaged: true, at: new Date().toISOString() };
    if (this.platform === 'linux') {
      const info = parsePactlInfo((await this._pactl(['info'])).stdout);
      st.speakers.sink = info.defaultSink && !isOurName(info.defaultSink) ? info.defaultSink : null;
    }
    this._writeState();
    return { ok: true, mode: 'speakers', ...this._endpoints(), halfDuplex: true };
  }

  async _engageLinux(browserApp) {
    const st = this._ensureState();
    const info = parsePactlInfo((await this._pactl(['info'])).stdout);
    st.pulse = st.pulse || { modules: [], engaged: false };
    if (!st.pulse.engaged) {
      st.pulse.engage = {
        at: new Date().toISOString(),
        browserApp,
        savedDefaultSource: info.defaultSource && !isOurName(info.defaultSource) ? info.defaultSource : st.pulse.savedDefaultSource || null,
        moved: { sinkInputs: [], sourceOutputs: [] },
      };
    }
    st.pulse.engaged = true;
    this._writeState(); // before anything changes
    if (this._cfg().switchDefaultInput) await this._pactl(['set-default-source', NAMES.mic]);
    const moved = await this._syncStreams(browserApp);
    this._startFollowing(browserApp);
    return { ok: true, mode: 'virtual', ...this._endpoints(), halfDuplex: false, moved };
  }

  /** Move the call app's streams that are not routed yet (Linux). Runs every followMs while engaged. */
  async syncStreams() {
    if (this.platform !== 'linux' || !this.state || !this.state.pulse || !this.state.pulse.engaged) return { sinkInputs: 0, sourceOutputs: 0 };
    return this._serial(() => this._syncStreams(this._browserApp || ''));
  }

  async _syncStreams(browserApp) {
    const st = this.state && this.state.pulse;
    if (!st || !st.engaged) return { sinkInputs: 0, sourceOutputs: 0 };
    const eng = st.engage || (st.engage = { moved: { sinkInputs: [], sourceOutputs: [] } });
    const [sinks, sources, sis, sos] = await Promise.all([
      this._pactl(['list', 'short', 'sinks']).then((r) => parseShortList(r.stdout)),
      this._pactl(['list', 'short', 'sources']).then((r) => parseShortList(r.stdout)),
      this._pactl(['list', 'sink-inputs']).then((r) => parsePactlStreams(r.stdout)),
      this._pactl(['list', 'source-outputs']).then((r) => parsePactlStreams(r.stdout)),
    ]);
    const sinkName = (idx) => (sinks.find((s) => s.index === String(idx)) || {}).name || null;
    const sourceName = (idx) => (sources.find((s) => s.index === String(idx)) || {}).name || null;
    const callSink = sinks.find((s) => s.name === NAMES.call);
    const micSource = sources.find((s) => s.name === NAMES.mic);
    if (!callSink || !micSource) throw bridgeError('The virtual audio devices are gone (was the sound server restarted?)', 'DEVICES_GONE', 'Run: anywhere calls audio setup');
    let nSi = 0;
    let nSo = 0;
    for (const s of sis) {
      if (s.kind !== 'sink-input' || s.sink === callSink.index || !streamMatchesApp(s, browserApp)) continue;
      const r = await this._pactl(['move-sink-input', s.index, NAMES.call], { allowFail: true });
      if (!r.ok) continue; // the stream ended meanwhile
      if (!eng.moved.sinkInputs.some((m) => m.index === s.index)) eng.moved.sinkInputs.push({ index: s.index, from: sinkName(s.sink), app: appNamesOf(s)[0] || '' });
      nSi++;
    }
    for (const s of sos) {
      if (s.kind !== 'source-output' || s.source === micSource.index || !streamMatchesApp(s, browserApp)) continue;
      const from = sourceName(s.source);
      if (from && /\.monitor$/.test(from)) continue; // a tab recording its own audio, not the mic
      const r = await this._pactl(['move-source-output', s.index, NAMES.mic], { allowFail: true });
      if (!r.ok) continue;
      if (!eng.moved.sourceOutputs.some((m) => m.index === s.index)) eng.moved.sourceOutputs.push({ index: s.index, from, app: appNamesOf(s)[0] || '' });
      nSo++;
    }
    if (nSi || nSo) {
      this._writeState();
      this.emit('moved', { sinkInputs: nSi, sourceOutputs: nSo });
    }
    return { sinkInputs: nSi, sourceOutputs: nSo };
  }

  _startFollowing(browserApp) {
    this._stopFollowing();
    if (!(this.followMs > 0)) return;
    this._follow = setInterval(() => {
      if (this._following) return;
      this._following = true;
      this._serial(() => this._syncStreams(browserApp))
        .catch((err) => {
          log.warn(`following the call's audio streams failed: ${err.message}`);
          this.emit('warning', { code: err.code || 'AUDIO_BACKEND', message: err.message, hint: err.hint });
        })
        .finally(() => {
          this._following = false;
        });
    }, this.followMs);
    if (this._follow.unref) this._follow.unref();
  }

  _stopFollowing() {
    if (this._follow) clearInterval(this._follow);
    this._follow = null;
  }

  async _engageWin() {
    const ps = await this._ps();
    const cfg = this._cfg();
    const micName = cfg.virtualMic || VIRTUAL.win32.mic;
    const cap = await ps.get('capture');
    const vm = findDevice(cap.devices, micName);
    if (!vm) throw bridgeError(`${micName} (VB-CABLE) is not installed`, 'VB_CABLE_MISSING', HINTS.vbcable);
    const st = this._ensureState();
    if (!(st.win32 && st.win32.engaged)) {
      st.win32 = {
        engaged: true,
        virtualId: vm.id,
        virtualName: vm.name,
        saved: {
          console: cap.console ? cap.console.id : null,
          multimedia: cap.multimedia ? cap.multimedia.id : null,
          communications: cap.communications ? cap.communications.id : null,
        },
        savedNames: {
          console: cap.console ? cap.console.name : null,
          communications: cap.communications ? cap.communications.name : null,
        },
        at: new Date().toISOString(),
      };
      this._writeState(); // before the switch
    }
    if (cfg.switchDefaultInput) await ps.set({ flow: 'capture', id: vm.id, roles: ['console', 'multimedia', 'communications'] });
    return { ok: true, mode: 'virtual', ...this._endpoints(), halfDuplex: false };
  }

  async _engageMac(browserApp) {
    const cfg = this._cfg();
    const micName = cfg.virtualMic || VIRTUAL.darwin.mic;
    const st = this._ensureState();
    if (!(st.darwin && st.darwin.engaged)) {
      const cur = await this._sc('audio.defaultInput', {}, { timeoutMs: 10000 });
      st.darwin = { engaged: true, savedInput: cur && cur.name, savedUid: cur && cur.uid, virtualInput: micName, at: new Date().toISOString() };
      this._writeState();
    }
    if (cfg.switchDefaultInput) await this._sc('audio.defaultInput', { set: micName }, { timeoutMs: 10000 });
    this._macApp = browserApp;
    return { ok: true, mode: 'virtual', ...this._endpoints(), halfDuplex: false };
  }

  /** {capture, playback} of the current mode. */
  _endpoints() {
    const cfg = this._cfg();
    const check = this._lastCheck || {};
    const override = parseCaptureOverride(cfg.capture, this.platform);
    if (this._mode === 'speakers') {
      if (this.platform === 'linux') {
        const sink = (this.state && this.state.speakers && this.state.speakers.sink) || check.defaultSink || '@DEFAULT_SINK@';
        return { capture: override || { backend: 'pulse', device: sink === '@DEFAULT_SINK@' ? '@DEFAULT_MONITOR@' : `${sink}.monitor` }, playback: { backend: 'pulse', device: sink } };
      }
      if (this.platform === 'win32') return { capture: override || { backend: 'wasapi-loopback', device: '' }, playback: { backend: 'device', device: '' } };
      return { capture: override || { backend: 'device', device: '' }, playback: { backend: 'device', device: '' } };
    }
    if (this.platform === 'linux') return { capture: override || { backend: 'pulse', device: `${NAMES.call}.monitor` }, playback: { backend: 'pulse', device: NAMES.tts } };
    if (this.platform === 'win32') {
      const mic = cfg.virtualMic || VIRTUAL.win32.mic;
      return { capture: override || { backend: 'wasapi-loopback', device: '' }, playback: { backend: 'device', device: playbackFor(mic, 'win32') } };
    }
    const mic = cfg.virtualMic || VIRTUAL.darwin.mic;
    let capture = override || (check.capture && check.capture.backend ? { ...check.capture } : { backend: 'sck', device: '', app: '' });
    if (capture.backend === 'sck' && !capture.app) capture = { ...capture, app: this._macApp || '' };
    return { capture, playback: { backend: 'device', device: playbackFor(mic, 'darwin') } };
  }

  /** Parameters for the sidecar's `audio.start` (§3.4) in the current mode. */
  startParams({ asr = true } = {}) {
    const half = this._mode === 'speakers';
    const ep = this._endpoints();
    return {
      capture: ep.capture,
      playback: ep.playback,
      vad: { ...(half ? HALF_DUPLEX_VAD : DEFAULT_VAD) },
      bargeIn: half ? null : { minSpeechMs: 400, stopPlayback: true },
      halfDuplex: half,
      tailMs: half ? 300 : 0,
      asr,
      levelIntervalMs: 500,
    };
  }

  /**
   * Undo engage() for one holder ('call' by default): when no other holder is left, the user's
   * microphone is the default again and the streams are back where they were.
   * @param {{owner?:string}} [opts]
   */
  async release({ owner = 'call' } = {}) {
    return this._serial(() => {
      this._owners.delete(String(owner || 'call'));
      if (this._owners.size) return { ok: true, restored: false, keptFor: [...this._owners] };
      this._stopFollowing();
      return this._release();
    });
  }

  /** Who holds the audio route now ('call', 'selftest'). */
  holders() {
    return [...this._owners];
  }

  async _release() {
    const st = this.state;
    if (!st) return { ok: true, restored: false };
    const out = { ok: true, restored: false, errors: [] };
    if (st.speakers && st.speakers.engaged) {
      st.speakers.engaged = false;
      out.restored = true;
    }
    if (st.pulse && st.pulse.engaged) {
      await this._releasePulse(st.pulse, out);
      out.restored = true;
    }
    if (st.win32 && st.win32.engaged) {
      await this._releaseWin(st.win32, out);
      out.restored = true;
    }
    if (st.darwin && st.darwin.engaged) {
      await this._releaseMac(st.darwin, out);
      out.restored = true;
    }
    this._writeState();
    if (out.errors.length) out.ok = false;
    this.emit('released', out);
    return out;
  }

  async _releasePulse(p, out) {
    const eng = p.engage || { moved: { sinkInputs: [], sourceOutputs: [] } };
    try {
      const info = parsePactlInfo((await this._pactl(['info'])).stdout);
      const [sinks, sources, sis, sos] = await Promise.all([
        this._pactl(['list', 'short', 'sinks']).then((r) => parseShortList(r.stdout)),
        this._pactl(['list', 'short', 'sources']).then((r) => parseShortList(r.stdout)),
        this._pactl(['list', 'sink-inputs']).then((r) => parsePactlStreams(r.stdout)),
        this._pactl(['list', 'source-outputs']).then((r) => parsePactlStreams(r.stdout)),
      ]);
      const sinkExists = (n) => n && sinks.some((s) => s.name === n);
      const sourceExists = (n) => n && sources.some((s) => s.name === n);
      const userSink = [p.savedDefaultSink, info.defaultSink].find((n) => n && !isOurName(n) && sinkExists(n)) || (sinks.find((s) => !isOurName(s.name)) || {}).name || null;
      const userSource =
        [eng.savedDefaultSource, p.savedDefaultSource].find((n) => n && !isOurName(n) && sourceExists(n)) ||
        (sources.find((s) => !isOurName(s.name) && !/\.monitor$/.test(s.name)) || {}).name ||
        null;
      // Only when it is still ours: the user may have picked another microphone meanwhile.
      if (info.defaultSource === NAMES.mic && userSource) await this._pactl(['set-default-source', userSource]);
      const callSink = sinks.find((s) => s.name === NAMES.call);
      const micSource = sources.find((s) => s.name === NAMES.mic);
      for (const s of sis) {
        if (!callSink || s.sink !== callSink.index || isOwnStream(s)) continue;
        const rec = eng.moved.sinkInputs.find((m) => m.index === s.index);
        const to = rec && sinkExists(rec.from) && !isOurName(rec.from) ? rec.from : userSink;
        if (to) await this._pactl(['move-sink-input', s.index, to], { allowFail: true });
      }
      for (const s of sos) {
        if (!micSource || s.source !== micSource.index || isOwnStream(s)) continue;
        const rec = eng.moved.sourceOutputs.find((m) => m.index === s.index);
        const to = rec && sourceExists(rec.from) && !isOurName(rec.from) ? rec.from : userSource;
        if (to) await this._pactl(['move-source-output', s.index, to], { allowFail: true });
      }
    } catch (err) {
      out.errors.push({ code: err.code || 'AUDIO_BACKEND', message: err.message });
    }
    p.engaged = false;
    p.engage = null;
  }

  async _releaseWin(w, out) {
    try {
      const ps = await this._ps();
      const cap = await ps.get('capture');
      for (const role of ['console', 'multimedia', 'communications']) {
        const saved = w.saved && w.saved[role];
        const cur = cap[role] && cap[role].id;
        if (!saved || saved === w.virtualId) continue;
        if (cur && cur !== w.virtualId) continue; // changed by the user meanwhile
        try {
          await ps.set({ flow: 'capture', id: saved, roles: [role] });
        } catch (err) {
          out.errors.push({ code: err.code || 'AUDIO_BACKEND', message: `${role}: ${err.message}` });
        }
      }
    } catch (err) {
      out.errors.push({ code: err.code || 'AUDIO_BACKEND', message: err.message });
      if (out.errors.length) return; // keep the state: restoreFromCrash retries
    }
    w.engaged = false;
  }

  async _releaseMac(d, out) {
    try {
      const cur = await this._sc('audio.defaultInput', {}, { timeoutMs: 10000 });
      if (d.savedInput && (!cur || lower(cur.name) === lower(d.virtualInput))) {
        await this._sc('audio.defaultInput', d.savedUid ? { set: d.savedInput, uid: d.savedUid } : { set: d.savedInput }, { timeoutMs: 10000 });
      }
      d.engaged = false;
    } catch (err) {
      out.errors.push({ code: err.code || 'AUDIO_BACKEND', message: err.message });
    }
  }

  /** Release, then remove the virtual devices (Linux) and the state file (disarm, shutdown). */
  async teardown() {
    this._stopFollowing();
    return this._serial(async () => {
      this._owners.clear();
      const out = await this._release();
      const st = this.state;
      if (st && st.pulse && this.platform === 'linux') await this._unloadModules(st.pulse, out);
      const busy = st && ((st.win32 && st.win32.engaged) || (st.darwin && st.darwin.engaged));
      if (!busy) this._clearState();
      else this._writeState();
      this._mode = null;
      return out;
    });
  }

  async _unloadModules(p, out) {
    let current = [];
    try {
      current = parseShortModules((await this._pactl(['list', 'short', 'modules'])).stdout);
    } catch (err) {
      out.errors = out.errors || [];
      out.errors.push({ code: err.code || 'AUDIO_BACKEND', message: err.message });
      return;
    }
    // Recorded modules first (reverse load order), verified by their arguments since indexes are reused
    // after a sound-server restart; then any other module of ours (an older crash).
    const order = ['monitor', 'call', 'mic', 'tts'];
    const victims = current.filter((m) => ourModuleRole(m)).sort((a, b) => order.indexOf(ourModuleRole(a)) - order.indexOf(ourModuleRole(b)));
    for (const m of victims) {
      const r = await this._pactl(['unload-module', m.index], { allowFail: true });
      if (!r.ok) (out.errors = out.errors || []).push({ code: 'AUDIO_BACKEND', message: `unload-module ${m.index}: ${r.stderr.trim()}` });
    }
    p.modules = [];
    out.unloaded = victims.length;
  }

  /**
   * Undo what a crashed daemon left behind (call at daemon start). Leaves a state file of another live
   * process on this boot alone unless `force`.
   * @returns {Promise<{restored:boolean, reason?:string, errors?:Array}>}
   */
  async restoreFromCrash({ force = false } = {}) {
    this._crashChecked = true;
    const st = this._readState();
    if (!st) return { restored: false, reason: 'nothing to restore' };
    if (st.pid === this.pid && !force) return { restored: false, reason: 'owned by this process' };
    const sameBoot = Math.abs((st.bootTime || 0) - bootTime()) <= 5 * 60000;
    if (!force && sameBoot && st.pid !== this.pid && pidAlive(st.pid) && st.host === this.hostname) {
      return { restored: false, reason: `in use by process ${st.pid}` };
    }
    this.state = { ...st, pid: this.pid };
    const plat = st.platform || this.platform;
    if (plat !== this.platform) {
      this._clearState();
      return { restored: false, reason: `state of another platform (${plat})` };
    }
    const out = await this.teardown();
    log.info(`restored the audio routing left by process ${st.pid}${out.errors && out.errors.length ? ` (with ${out.errors.length} error(s))` : ''}`);
    return { restored: true, from: st.pid, errors: out.errors || [] };
  }

  /**
   * Synchronous best-effort restore for process.on('exit'): default input back, streams back, modules
   * unloaded (Linux), default recording device back (Windows through a one-shot PowerShell host,
   * macOS through SwitchAudioSource or audio_io.py's CLI). Never throws.
   */
  restoreSync() {
    this._stopFollowing();
    const st = this.state || this._readState();
    if (!st || (st.pid && st.pid !== this.pid)) return { restored: false };
    const done = [];
    try {
      if (st.pulse && this.platform === 'linux') {
        const pactl = (args) => this.spawnSyncFn('pactl', args, { timeout: 4000, encoding: 'utf8', env: { ...this.env, LC_ALL: 'C', LANG: 'C' } });
        const info = parsePactlInfo((pactl(['info']) || {}).stdout || '');
        const eng = st.pulse.engage || {};
        const back = [eng.savedDefaultSource, st.pulse.savedDefaultSource].find((n) => n && !isOurName(n));
        // (moves of the release plan below go to the recorded sinks and sources, else the defaults)
        if (info.defaultSource === NAMES.mic && back) pactl(['set-default-source', back]);
        const plan = buildPactlPlan({ defaultSink: st.pulse.savedDefaultSink || info.defaultSink, savedSource: null, moves: (eng && eng.moved) || {} });
        for (const cmd of plan.release) pactl(cmd);
        const mods = parseShortModules((pactl(['list', 'short', 'modules']) || {}).stdout || '');
        const order = ['monitor', 'call', 'mic', 'tts'];
        for (const m of mods.filter((x) => ourModuleRole(x)).sort((a, b) => order.indexOf(ourModuleRole(a)) - order.indexOf(ourModuleRole(b)))) pactl(['unload-module', m.index]);
        done.push('pulse');
      }
      if (st.win32 && st.win32.engaged) {
        const h = this._psCommand();
        if (h) {
          const lines = ['console', 'multimedia', 'communications']
            .filter((role) => st.win32.saved && st.win32.saved[role] && st.win32.saved[role] !== st.win32.virtualId)
            .map((role, i) => JSON.stringify({ id: i + 1, cmd: 'audioDefaultSet', args: { flow: 'capture', id: st.win32.saved[role], roles: [role], onlyIf: st.win32.virtualId } }));
          if (lines.length) this.spawnSyncFn(h.exe, h.args, { input: `${lines.join('\n')}\n`, timeout: 20000, windowsHide: true, cwd: h.cwd, env: this.env });
          done.push('win32');
        }
      }
      if (st.darwin && st.darwin.engaged && st.darwin.savedInput) {
        const sas = this.which('SwitchAudioSource');
        if (sas) this.spawnSyncFn(sas, ['-t', 'input', '-s', st.darwin.savedInput], { timeout: 5000 });
        else if (this._pythonCmd()) {
          const py = this._pythonCmd();
          this.spawnSyncFn(py.python, ['-I', py.audioIo, 'set-default-input', '--name', st.darwin.savedInput], { timeout: 8000 });
        }
        done.push('darwin');
      }
    } catch (err) {
      log.warn(`synchronous audio restore failed: ${err.message}`);
    }
    if (done.length) this._clearState();
    return { restored: done.length > 0, done };
  }

  _psCommand() {
    for (const ref of [this._psResolved, this.psRef]) {
      const h = ref && typeof ref === 'object' ? (ref.host && ref.host.exe ? ref.host : ref.exe ? ref : null) : null;
      if (h && h.exe && Array.isArray(h.args)) return { exe: h.exe, args: h.args, cwd: h.cwd };
    }
    return null;
  }

  _pythonCmd() {
    for (const ref of [this._scResolved, this.sidecarRef]) {
      const sc = ref && typeof ref === 'object' ? ref : null;
      // (a WSL sidecar is a Windows python.exe: its script path is converted by the client, not here)
      if (sc && sc.python && sc.script) return { python: sc.python, audioIo: path.join(path.dirname(sc.script), 'audio_io.py') };
    }
    return null;
  }

  // ------------------------------------------------------------ self-test and doctor helpers

  /** Play a WAV file into the virtual microphone (speakers in speaker mode). */
  async playToMic(wav, { timeoutMs = 30000 } = {}) {
    const ep = this._endpoints();
    if (this.platform === 'linux' && ep.playback.backend === 'pulse') {
      const r = await this.runner('paplay', [`--device=${ep.playback.device}`, `--client-name=${OWN_ID}`, `--property=application.id=${OWN_ID}`, wav], { timeoutMs, env: this.env });
      if (!r || r.error || r.code !== 0) throw bridgeError(`paplay failed: ${(r && (r.error ? r.error.message : String(r.stderr || '').trim())) || 'failed'}`, r && r.error && r.error.code === 'ENOENT' ? 'PULSE_TOOLS_MISSING' : 'AUDIO_BACKEND', HINTS.pactl);
      return { ok: true };
    }
    return this._sc('audio.play', { wav, playback: ep.playback, wait: true }, { timeoutMs });
  }

  /**
   * Record the caller-capture backend for `seconds` into `out` (a 16 kHz mono WAV).
   * Linux records with parec here (no sidecar needed); elsewhere the sidecar's record.start.
   * @returns {Promise<{out:string, seconds:number, peakDbfs:number, rmsDbfs:number}>}
   */
  async recordCapture({ out, seconds = 6 } = {}) {
    const ep = this._endpoints();
    const secs = Math.max(0.2, Math.min(30, Number(seconds) || 6));
    if (this.platform === 'linux' && ep.capture.backend === 'pulse') {
      const pcm = await this._parec(ep.capture.device, secs);
      fs.writeFileSync(out, pcmToWav(pcm, 16000), { mode: 0o600 });
      const lv = wavLevel(fs.readFileSync(out));
      return { out, seconds: lv.seconds || 0, peakDbfs: lv.peakDbfs, rmsDbfs: lv.rmsDbfs };
    }
    const r = await this._sc('record.start', { ...ep.capture, out, seconds: secs, wait: true }, { timeoutMs: (secs + 15) * 1000 });
    return { out, seconds: r.seconds, peakDbfs: r.peak != null ? r.peak : r.peakDbfs, rmsDbfs: r.rms != null ? r.rms : r.rmsDbfs };
  }

  _parec(device, seconds) {
    return new Promise((resolve, reject) => {
      let child;
      const chunks = [];
      let size = 0;
      try {
        child = this.spawnFn(
          'parec',
          [`--device=${device}`, '--format=s16le', '--rate=16000', '--channels=1', '--raw', '--latency-msec=30', `--client-name=${OWN_ID}`, `--property=application.id=${OWN_ID}`],
          { stdio: ['ignore', 'pipe', 'pipe'], env: this.env },
        );
      } catch (err) {
        reject(bridgeError(`parec failed: ${err.message}`, 'PULSE_TOOLS_MISSING', HINTS.pactl));
        return;
      }
      const max = Math.ceil(seconds * 16000) * 2;
      let err = '';
      const finish = () => {
        clearTimeout(timer);
        try {
          child.kill('SIGTERM');
        } catch {
          /* gone */
        }
        resolve(Buffer.concat(chunks).subarray(0, max));
      };
      const timer = setTimeout(finish, seconds * 1000 + 300);
      child.stdout.on('data', (d) => {
        chunks.push(d);
        size += d.length;
        if (size >= max) finish();
      });
      child.stderr.on('data', (d) => {
        err += d;
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(bridgeError(`parec failed: ${e.message}`, e.code === 'ENOENT' ? 'PULSE_TOOLS_MISSING' : 'AUDIO_BACKEND', HINTS.pactl));
      });
      child.on('close', (code) => {
        if (size === 0 && code && code !== 0) {
          clearTimeout(timer);
          reject(bridgeError(`parec exited with ${code}: ${err.trim().slice(0, 300)}`, 'AUDIO_BACKEND', HINTS.pulseDown));
        }
      });
    });
  }

  /** The current default recording device, without changing anything (doctor's dry run). */
  async readDefaultInput() {
    if (this.platform === 'linux') {
      const info = parsePactlInfo((await this._pactl(['info'])).stdout);
      return { name: info.defaultSource, via: 'pactl' };
    }
    if (this.platform === 'win32') {
      const ps = await this._ps();
      const cap = await ps.get('capture');
      return { name: cap.console ? cap.console.name : null, id: cap.console ? cap.console.id : null, communications: cap.communications ? cap.communications.name : null, via: 'IPolicyConfig' };
    }
    const cur = await this._sc('audio.defaultInput', {}, { timeoutMs: 10000 });
    return { name: cur && cur.name, uid: cur && cur.uid, via: cur && cur.via ? cur.via : 'CoreAudio' };
  }
}

// ---------------------------------------------------------------------------------------- self-test (§5.5)

/**
 * The routes of the browser self-test page (src/ui/calls-audio-test.html). routes-calls.js mounts each as
 *   add(r.method, r.path, (ctx) => selfTest.route(r.step, ctx), { noAuth: true, raw: r.raw, noBody: r.noBody })
 * They need no token: `begin` trades the single-use code (from POST /api/calls/audio-test/start →
 * selfTest.mint()) for a test id that the other steps carry as ?test=.
 */
const SELF_TEST_ROUTES = Object.freeze([
  { method: 'POST', path: '/api/calls/audio-test/begin', step: 'begin' },
  { method: 'POST', path: '/api/calls/audio-test/speak', step: 'speak' },
  { method: 'POST', path: '/api/calls/audio-test/upload', step: 'upload', raw: true },
  { method: 'POST', path: '/api/calls/audio-test/capture', step: 'capture' },
  { method: 'POST', path: '/api/calls/audio-test/result', step: 'result' },
  { method: 'POST', path: '/api/calls/audio-test/finish', step: 'finish' },
]);

class AudioSelfTest extends EventEmitter {
  /**
   * @param {object} opts
   * @param {AudioBridge} opts.bridge
   * @param {(wav:string)=>Promise<string>} [opts.transcribe]  local STT (CloneService.transcribe); without it only levels are checked
   * @param {(text:string, out:string)=>Promise<string|void>} [opts.renderSpeech] writes speech as WAV to `out` (Piper or the
   *   cloned voice; default: espeak-ng / say)
   * @param {string} [opts.tmpDir]       default <state>/run/voice-tmp
   * @param {string} [opts.resultFile]   default <state>/run/calls-audio-test.json
   * @param {number} [opts.codeTtlMs=120000]
   * @param {number} [opts.testTtlMs=180000]
   */
  constructor(opts = {}) {
    super();
    if (!opts.bridge) throw new Error('AudioSelfTest needs a bridge');
    this.bridge = opts.bridge;
    this.transcribe = typeof opts.transcribe === 'function' ? opts.transcribe : null;
    this.renderSpeech = typeof opts.renderSpeech === 'function' ? opts.renderSpeech : defaultRenderSpeech({ runner: opts.runner, which: opts.which, platform: opts.bridge.platform });
    this.tmpDir = opts.tmpDir || path.join(paths.runDir(), 'voice-tmp');
    this.resultFile = opts.resultFile || path.join(paths.runDir(), SELF_TEST_FILE);
    this.codeTtlMs = opts.codeTtlMs || 120000;
    this.testTtlMs = opts.testTtlMs || 180000;
    this.micMs = opts.micMs || 6000;
    this.captureMs = opts.captureMs || 6000;
    this.recordLeadMs = opts.recordLeadMs == null ? 400 : opts.recordLeadMs;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.codes = new Map(); // code -> expiresAt
    this.tests = new Map(); // id -> test
  }

  /** A single-use code for the page URL (valid codeTtlMs). */
  mint() {
    this._sweep();
    const code = crypto.randomBytes(16).toString('hex');
    const expiresAt = this.now() + this.codeTtlMs;
    this.codes.set(code, expiresAt);
    return { code, path: `/calls-audio-test.html?code=${code}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  _sweep() {
    const t = this.now();
    for (const [c, exp] of this.codes) if (exp <= t) this.codes.delete(c);
    for (const [id, test] of this.tests) {
      if (test.expiresAt <= t) {
        this.tests.delete(id);
        if (test.engaged) this.bridge.release({ owner: 'selftest' }).catch(() => {});
      }
    }
  }

  _test(url) {
    this._sweep();
    const id = (url && url.searchParams && url.searchParams.get('test')) || '';
    const test = /^[a-f0-9]{32}$/.test(id) ? this.tests.get(id) : null;
    if (!test) throw httpErr(403, 'This audio test expired; start it again with: anywhere calls test-audio');
    return test;
  }

  /** The last result (also after a restart), for `anywhere calls doctor`. */
  lastResult() {
    try {
      return JSON.parse(fs.readFileSync(this.resultFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async _file(test, name) {
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    const f = path.join(this.tmpDir, `selftest-${test.id.slice(0, 12)}-${name}`);
    test.files.add(f);
    return f;
  }

  async _clip(test, phrase, name) {
    const f = await this._file(test, name);
    const r = await this.renderSpeech(phrase, f);
    const file = typeof r === 'string' && r ? r : f;
    if (!fs.existsSync(file)) throw httpErr(503, 'Could not render the test phrase', { hint: 'Install a voice: anywhere voice install' });
    test.files.add(file);
    return file;
  }

  async _verdict(phrase, file, buf) {
    const data = buf || fs.readFileSync(file);
    const lv = wavLevel(data);
    let transcript = null;
    let transcribeError = null;
    if (this.transcribe) {
      try {
        const trimmed = trimWav(data);
        let target = file;
        if (trimmed) {
          target = file.replace(/\.wav$/i, '') + '-trimmed.wav';
          fs.writeFileSync(target, trimmed, { mode: 0o600 });
          if (this._current) this._current.files.add(target);
        }
        transcript = trimmed ? String((await this.transcribe(target)) || '').trim() : '';
      } catch (err) {
        transcribeError = err.message;
      }
    }
    const heard = lv.ok && lv.rmsDbfs > -50 && lv.peakDbfs > -35;
    if (transcript != null) {
      const s = phraseScore(phrase, transcript);
      return { pass: s.pass, verified: 'transcript', transcript, score: s.score, level: lv.ok ? { peakDbfs: lv.peakDbfs, rmsDbfs: lv.rmsDbfs, seconds: Math.round(lv.seconds * 10) / 10 } : null, heard };
    }
    return {
      pass: heard,
      verified: 'level',
      transcript: null,
      transcribeError,
      level: lv.ok ? { peakDbfs: lv.peakDbfs, rmsDbfs: lv.rmsDbfs, seconds: Math.round(lv.seconds * 10) / 10 } : null,
      heard,
    };
  }

  /**
   * One step of the page's protocol.
   * @param {'begin'|'speak'|'upload'|'capture'|'result'|'finish'} step
   * @param {{url:URL, raw?:Buffer, body?:object}} ctx
   */
  async route(step, { url, raw } = {}) {
    if (step === 'begin') return this._begin(url);
    const test = this._test(url);
    this._current = test;
    test.calls[step] = (test.calls[step] || 0) + 1;
    if (test.calls[step] > 3) throw httpErr(429, 'Too many attempts; start the audio test again');
    if (step === 'speak') return this._speak(test);
    if (step === 'upload') return this._upload(test, raw);
    if (step === 'capture') return this._capture(test);
    if (step === 'result') return this._result(test);
    if (step === 'finish') return this._finish(test);
    throw httpErr(404, 'Unknown step');
  }

  async _begin(url) {
    this._sweep();
    const code = (url && url.searchParams && url.searchParams.get('code')) || '';
    if (!/^[a-f0-9]{32}$/.test(code) || !this.codes.has(code)) throw httpErr(403, 'This test link expired or was already used; run: anywhere calls test-audio');
    this.codes.delete(code); // single use
    for (const t of this.tests.values()) await this._finish(t, { silent: true }); // one test at a time
    const id = crypto.randomBytes(16).toString('hex');
    const test = { id, expiresAt: this.now() + this.testTtlMs, files: new Set(), calls: {}, result: { at: null, mic: null, capture: null }, engaged: false };
    this.tests.set(id, test);
    // An abandoned page must not leave the virtual microphone as the default.
    test.timer = setTimeout(() => {
      if (this.tests.get(id) === test) this._finish(test).catch(() => {});
    }, this.testTtlMs);
    if (test.timer.unref) test.timer.unref();
    const check = await this.bridge.check();
    test.result.mode = check.mode;
    test.result.platform = check.platform;
    // Route first: the page's getUserMedia must open the virtual mic, and its audio must reach our capture.
    let engaged = null;
    try {
      engaged = await this.bridge.engage({ browserApp: '', owner: 'selftest' });
      test.engaged = true;
    } catch (err) {
      test.result.error = { code: err.code, message: err.message, hint: err.hint };
    }
    let clip = null;
    try {
      const file = await this._clip(test, CAPTURE_PHRASE, 'clip.wav');
      clip = { mime: 'audio/wav', base64: fs.readFileSync(file).toString('base64') };
    } catch (err) {
      test.result.clipError = err.message;
    }
    return {
      ok: Boolean(engaged),
      test: id,
      mode: check.mode,
      platform: check.platform,
      issues: check.issues.filter((i) => i.level !== 'info'),
      error: test.result.error || null,
      micMs: this.micMs,
      captureMs: this.captureMs,
      micPhrase: MIC_PHRASE,
      capturePhrase: CAPTURE_PHRASE,
      clip,
      expiresAt: new Date(test.expiresAt).toISOString(),
    };
  }

  async _speak(test) {
    if (!test.engaged) throw httpErr(409, 'The audio routing is not active', { hint: test.result.error && test.result.error.hint });
    const file = test.micClip || (test.micClip = await this._clip(test, MIC_PHRASE, 'mic.wav'));
    const t0 = this.now();
    await this.bridge.playToMic(file);
    return { ok: true, ms: this.now() - t0, phrase: MIC_PHRASE };
  }

  async _upload(test, raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 44) throw httpErr(400, 'Upload the recording as audio/wav');
    if (raw.length > 4 * 1024 * 1024) throw httpErr(413, 'The recording is too large');
    if (raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 8, 12) !== 'WAVE') throw httpErr(415, 'The recording must be a WAV file');
    const file = await this._file(test, 'mic-recording.wav');
    fs.writeFileSync(file, raw, { mode: 0o600 });
    const v = await this._verdict(MIC_PHRASE, file, raw);
    test.result.mic = v;
    this._save(test);
    return { ok: true, direction: 'mic', ...v };
  }

  async _capture(test) {
    if (!test.engaged) throw httpErr(409, 'The audio routing is not active', { hint: test.result.error && test.result.error.hint });
    if (test.recording) throw httpErr(409, 'Already recording');
    // The page created its playback stream before this call: route it now instead of on the next tick.
    try {
      await this.bridge.syncStreams();
    } catch (err) {
      log.warn(`self-test stream sync failed: ${err.message}`);
    }
    const out = await this._file(test, 'capture.wav');
    test.recording = this.bridge.recordCapture({ out, seconds: this.captureMs / 1000 }).then(
      (r) => ({ ok: true, ...r }),
      (err) => ({ ok: false, error: { code: err.code, message: err.message, hint: err.hint } }),
    );
    // The recorder needs a moment to open the device before the page starts playing (a failure to
    // start ends the wait early and shows in the result).
    const early = await Promise.race([test.recording, new Promise((r) => setTimeout(() => r(null), this.recordLeadMs))]);
    if (early && !early.ok) return { ok: false, recording: false, error: early.error };
    return { ok: true, recording: true, seconds: this.captureMs / 1000 };
  }

  async _result(test) {
    if (!test.recording) throw httpErr(409, 'Start the capture first');
    const rec = await test.recording;
    test.recording = null;
    if (!rec.ok) {
      test.result.capture = { pass: false, error: rec.error };
      this._save(test);
      return { ok: false, direction: 'capture', pass: false, error: rec.error };
    }
    const v = await this._verdict(CAPTURE_PHRASE, rec.out);
    test.result.capture = v;
    this._save(test);
    return { ok: true, direction: 'capture', ...v };
  }

  async _finish(test, { silent = false } = {}) {
    this.tests.delete(test.id);
    if (test.timer) clearTimeout(test.timer);
    test.timer = null;
    let released = null;
    if (test.engaged) {
      test.engaged = false;
      try {
        released = await this.bridge.release({ owner: 'selftest' });
      } catch (err) {
        released = { ok: false, error: err.message };
      }
    }
    for (const f of test.files) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* gone */
      }
    }
    test.files.clear();
    if (!silent) this._save(test);
    const r = test.result;
    return { ok: true, released: Boolean(released && released.ok !== false), mic: r.mic, capture: r.capture, pass: Boolean(r.mic && r.mic.pass && r.capture && r.capture.pass) };
  }

  _save(test) {
    const r = test.result;
    r.at = new Date(this.now()).toISOString();
    r.pass = Boolean(r.mic && r.mic.pass && r.capture && r.capture.pass);
    try {
      fs.mkdirSync(path.dirname(this.resultFile), { recursive: true, mode: 0o700 });
      writePrivate(this.resultFile, JSON.stringify(r, null, 1));
    } catch (err) {
      log.warn(`could not save the audio test result: ${err.message}`);
    }
    this.emit('result', r);
  }

  /** Release any running test (daemon shutdown). */
  async close() {
    for (const t of Array.from(this.tests.values())) await this._finish(t, { silent: true });
    this.codes.clear();
  }
}

function httpErr(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

/**
 * Speech for the self-test when no better voice is injected: espeak-ng/espeak (Linux), say (macOS),
 * System.Speech (Windows). routes-calls.js should pass Piper or the cloned voice instead.
 */
function defaultRenderSpeech({ runner = proc.run, which = proc.which, platform = process.platform } = {}) {
  return async (text, out) => {
    if (platform === 'darwin' && which('say')) {
      const r = await runner('say', ['-o', out, '--file-format=WAVE', '--data-format=LEI16@22050', text], { timeoutMs: 20000 });
      if (r.code === 0) return out;
    }
    const espeak = which('espeak-ng') || which('espeak');
    if (espeak) {
      const r = await runner(espeak, ['-v', 'en-us', '-s', '150', '-w', out, text], { timeoutMs: 20000 });
      if (r.code === 0) return out;
    }
    if (platform === 'win32') {
      const ps = which('powershell') || which('pwsh');
      if (ps) {
        const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
        const cmd = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile(${q(out)}); $s.Speak(${q(text)}); $s.Dispose()`;
        const r = await runner(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeoutMs: 30000 });
        if (r.code === 0) return out;
      }
    }
    throw httpErr(503, 'No voice is available to speak the test phrase', { hint: 'Install the natural voice: anywhere voice install' });
  };
}

// ---------------------------------------------------------------------------------------- doctor (§5.6)

/**
 * The audio rows of `anywhere calls doctor` / `anywhere doctor`, in the doctor's check format
 * ({id, label, status:'ok'|'warn'|'fail', detail, fix, notes, critical}). Changes nothing; `record`
 * also records 1 s from the caller-capture backend (Linux: parec; elsewhere the sidecar).
 * @param {{bridge?:AudioBridge, platformInfo?:object, runner?:Function, sidecar?:object|Function, psHost?:object|Function,
 *   config?:object, record?:boolean, resultFile?:string, tmpDir?:string, which?:Function}} [opts]
 * @returns {Promise<Array<{id:string,label:string,status:string,detail:string,fix:string,notes:string[],critical:boolean}>>}
 */
async function doctorChecks(opts = {}) {
  const bridge = opts.bridge || new AudioBridge(opts);
  const rows = [];
  const row = (id, label, status, detail, fix = '', notes = []) => rows.push({ id, label, status, detail, fix, notes, critical: false });
  let check = null;
  try {
    check = await bridge.check({ deep: Boolean(opts.deep) });
    const errors = check.issues.filter((i) => i.level === 'error');
    const warns = check.issues.filter((i) => i.level === 'warn');
    const infos = check.issues.filter((i) => i.level === 'info').map((i) => i.message);
    const where = check.mode === 'virtual' ? `virtual microphone ${check.virtualMic}` : 'speakers + microphone (half duplex, lower quality)';
    const server = check.server ? ` - ${check.server}` : '';
    if (!check.ready) row('calls-audio', 'Call audio', 'fail', `${where}: not ready${server}`, (errors[0] || warns[0] || {}).hint || '', [...errors, ...warns].map((i) => i.message).concat(infos));
    else if (warns.length || check.mode === 'speakers') row('calls-audio', 'Call audio', 'warn', `${where}${server}`, (warns[0] || {}).hint || HINTS.speakers, warns.map((i) => i.message).concat(infos));
    else row('calls-audio', 'Call audio', 'ok', `${where}${server}`, '', infos);
  } catch (err) {
    row('calls-audio', 'Call audio', 'fail', err.message, err.hint || '');
  }

  try {
    const d = await bridge.readDefaultInput();
    row('calls-audio-default', 'Default-input switch', 'ok', `current default microphone: ${d.name || 'unknown'} (${d.via}; switched only during AI-answered calls)`);
  } catch (err) {
    const status = check && check.mode === 'speakers' ? 'warn' : 'fail';
    row('calls-audio-default', 'Default-input switch', status, `cannot read the default microphone: ${err.message}`, err.hint || '');
  }

  if (opts.record && check && check.ready) {
    const tmp = opts.tmpDir || path.join(paths.runDir(), 'voice-tmp');
    const out = path.join(tmp, `doctor-capture-${process.pid}.wav`);
    // Linux records from anywhere_call.monitor, which exists only while the devices are set up: set them
    // up for the probe and remove them again when they were not there before.
    const tempSetup = bridge.platform === 'linux' && check.mode === 'virtual' && !(check.setup && check.setup.length);
    try {
      fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
      if (tempSetup) await bridge.setup();
      const r = await bridge.recordCapture({ out, seconds: 1 });
      row('calls-audio-capture', 'Caller capture', 'ok', `${check.capture ? check.capture.backend : ''} works: 1 s recorded, level ${r.rmsDbfs} dBFS (silence is expected without a call)`);
    } catch (err) {
      row('calls-audio-capture', 'Caller capture', 'fail', `recording 1 s failed: ${err.message}`, err.hint || '');
    } finally {
      try {
        fs.unlinkSync(out);
      } catch {
        /* none */
      }
      if (tempSetup) await bridge.teardown().catch(() => {});
    }
  }

  const resultFile = opts.resultFile || path.join(paths.runDir(), SELF_TEST_FILE);
  let last = null;
  try {
    last = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } catch {
    last = null;
  }
  if (!last || !last.at) row('calls-audio-selftest', 'Browser audio self-test', 'warn', 'never run', HINTS.selfTest);
  else {
    const part = (x) => (!x ? 'not run' : x.pass ? `pass${x.verified === 'level' ? ' (level only)' : ''}` : `fail${x.transcript ? ` (heard "${String(x.transcript).slice(0, 60)}")` : x.error ? ` (${x.error.message})` : ''}`);
    const detail = `${last.at.replace('T', ' ').slice(0, 16)}: microphone ${part(last.mic)}, capture ${part(last.capture)}`;
    row('calls-audio-selftest', 'Browser audio self-test', last.pass ? 'ok' : 'warn', detail, last.pass ? '' : `${HINTS.selfTest}. ${HINTS.pinnedMic}`);
  }
  return rows;
}

module.exports = {
  AudioBridge,
  AudioSelfTest,
  SELF_TEST_ROUTES,
  doctorChecks,
  defaultRenderSpeech,
  buildPactlPlan,
  parsePactlInfo,
  parseShortList,
  parseShortModules,
  parsePactlStreams,
  parseSinkInputs,
  isOwnStream,
  streamMatchesApp,
  ourModuleRole,
  isOurName,
  wavLevel,
  decodeWav,
  trimWav,
  pcmToWav,
  phraseScore,
  parseCaptureOverride,
  playbackFor,
  audioConfig,
  NAMES,
  DESCRIPTIONS,
  VIRTUAL,
  HINTS,
  APP_BINARIES,
  BROWSER_KEYS,
  MIC_PHRASE,
  CAPTURE_PHRASE,
  STATE_FILE,
  SELF_TEST_FILE,
};
