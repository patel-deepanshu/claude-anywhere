'use strict';

/**
 * Call audio (docs/CALLS-DESIGN.md §5):
 *  - src/calls/audio-bridge.js: the pactl plan and parsers on output captured from PulseAudio 16.1, the
 *    Linux bridge against a stateful fake pactl (modules, default devices, moving only the call app's
 *    streams, following new ones, crash-safe state file, release, teardown, restoreFromCrash and
 *    restoreSync), speaker mode, Windows/WSL with a fake PowerShell host (VB-CABLE, IPolicyConfig
 *    defaults with onlyIf restore), macOS with a fake sidecar (BlackHole, ScreenCaptureKit), the
 *    self-test protocol (single-use code, both directions, expiry) also over a real DaemonServer, and
 *    the doctor rows;
 *  - src/voice/clone/audio_io.py through the real sidecar.py in fake mode with the test file backends:
 *    VAD and recognition events, clause playback with playedChars, barge-in, tts.stop, half duplex,
 *    queued utterances, WAV playback, recording, path confinement (skipped without python3);
 *  - the new win32 host ops: driver methods against a fake host; under pwsh (when installed) the
 *    script parses, the Core Audio bridge compiles as C# 5 and the ops say UNSUPPORTED off Windows;
 *  - the self-test page: runAudioTest() with fakes, and in headless Chromium (fake media devices)
 *    against a DaemonServer with a fake bridge (skipped without Chromium or a global WebSocket).
 * No network, no audio hardware.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-calls-audio-')));
process.env.ANYWHERE_HOME = path.join(TMP, 'home');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const ab = require('../src/calls/audio-bridge');
const { AudioBridge, AudioSelfTest } = ab;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tmpN = 0;
const tmpFile = (name) => path.join(TMP, `${(tmpN += 1)}-${name}`);

async function until(pred, ms = 4000, step = 20) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

/** A 16-bit mono WAV of tone (true) / silence (false) segments: [[seconds, tone], ...]. */
function wavOf(rate, segments, freq = 300, amp = 0.3) {
  const total = segments.reduce((n, [s]) => n + Math.round(s * rate), 0);
  const b = Buffer.alloc(44 + total * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + total * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(total * 2, 40);
  let i = 0;
  for (const [s, tone] of segments) {
    const n = Math.round(s * rate);
    for (let k = 0; k < n; k++, i++) b.writeInt16LE(tone ? Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767) : 0, 44 + i * 2);
  }
  return b;
}

// ------------------------------------------------------------------------------------------------ fixtures
// Captured from PulseAudio 16.1 (pactl 16.1) in this research, with a Chromium-like playback and mic stream.

const PACTL_INFO = `Server String: unix:/run/user/1000/pulse/native
Library Protocol Version: 35
Server Protocol Version: 35
Is Local: yes
Client Index: 0
Tile Size: 65472
User Name: root
Host Name: vm
Server Name: pulseaudio
Server Version: 16.1
Default Sample Specification: s16le 2ch 44100Hz
Default Channel Map: front-left,front-right
Default Sink: speakers
Default Source: hwmic
Cookie: b810:f8dd
`;

const PACTL_INFO_PIPEWIRE = `Server String: /run/user/1000/pulse/native
Server Name: PulseAudio (on PipeWire 1.0.5)
Server Version: 15.0.0
Default Sink: alsa_output.pci-0000_00_1f.3.analog-stereo
Default Source: alsa_input.pci-0000_00_1f.3.analog-stereo
`;

const MODULES_SHORT = [
  '0\tmodule-native-protocol-unix\tauth-anonymous=1 socket=/tmp/pulse/native\t',
  '1\tmodule-null-sink\tsink_name=speakers sink_properties=device.description=Fake-Speakers\t',
  '4\tmodule-stream-restore\t\t',
  '6\tmodule-null-sink\tsink_name=anywhere_tts rate=48000 channels=1 sink_properties=device.description=Claude-Anywhere-Voice-Out\t',
  '7\tmodule-remap-source\tmaster=anywhere_tts.monitor source_name=anywhere_mic source_properties=device.description=Claude-Anywhere-Mic\t',
  '',
].join('\n');

const SINKS_SHORT = '0\tspeakers\tmodule-null-sink.c\ts16le 2ch 44100Hz\tRUNNING\n2\tanywhere_tts\tmodule-null-sink.c\ts16le 1ch 48000Hz\tIDLE\n';

// Design appendix A.2 (Chromium playing an <audio> element) plus the corked second stream.
const SINK_INPUTS = `Sink Input #1
\tDriver: protocol-native.c
\tOwner Module: 0
\tClient: 6
\tSink: 0
\tSample Specification: float32le 2ch 44100Hz
\tChannel Map: front-left,front-right
\tCorked: no
\tMute: no
\tProperties:
\t\tapplication.icon_name = "chromium-browser"
\t\tmedia.name = "Playback"
\t\tapplication.name = "Chromium"
\t\tapplication.process.id = "30695"
\t\tapplication.process.binary = "chrome"
\t\twindow.x11.display = ":98"

Sink Input #2
\tDriver: protocol-native.c
\tOwner Module: 0
\tClient: 6
\tSink: 0
\tCorked: yes
\tMute: no
\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
\t        balance 0.00
\tProperties:
\t\tapplication.name = "Chromium"
\t\tapplication.process.binary = "chrome"
\t\tmedia.name = "Playback \\"quoted\\""
`;

const SOURCE_OUTPUTS = `Source Output #0
\tDriver: module-remap-source.c
\tOwner Module: 3
\tClient: n/a
\tSource: 1
\tCorked: no
\tMute: no
\tProperties:
\t\tmedia.name = "Remapped Stream"
\t\tmedia.role = "filter"

Source Output #2
\tDriver: protocol-native.c
\tOwner Module: 0
\tClient: 5
\tSource: 4
\tSample Specification: s16le 2ch 44100Hz
\tFormat: pcm, format.sample_format = "\\"s16le\\""  format.rate = "44100"
\tCorked: no
\tMute: no
\tResample method: speex-float-1
\tProperties:
\t\tapplication.name = "Chromium input"
\t\tapplication.process.binary = "chrome"
\t\tmedia.name = "Chromium input"
\t\tmodule-stream-restore.id = "source-output-by-application-name:Chromium input"
`;

// ------------------------------------------------------------------------------------------------ fake pactl

/** A small PulseAudio model behind a pactl-compatible runner (LC_ALL=C text output). */
class FakePulse {
  constructor({ sink = 'alsa_output.pci-0000_00_1f.3.analog-stereo', source = 'alsa_input.pci-0000_00_1f.3.analog-stereo', newSinkBecomesDefault = false } = {}) {
    this.nextModule = 10;
    this.nextSink = 0;
    this.nextSource = 0;
    this.nextStream = 100;
    this.modules = [{ index: '0', name: 'module-native-protocol-unix', args: 'auth-anonymous=1' }];
    this.sinks = [];
    this.sources = [];
    this.sinkInputs = [];
    this.sourceOutputs = [];
    this.newSinkBecomesDefault = newSinkBecomesDefault;
    this.addSink(sink, null);
    this.addSource(source, null);
    this.defaultSink = sink;
    this.defaultSource = source;
    this.calls = [];
    this.other = [];
    this.down = false;
    this.onCall = null;
    this.runner = (cmd, args, opts) => this.run(cmd, args, opts);
  }

  addSink(name, module) {
    const s = { index: String(this.nextSink++), name, module };
    this.sinks.push(s);
    this.addSource(`${name}.monitor`, module);
    return s;
  }

  addSource(name, module) {
    const s = { index: String(this.nextSource++), name, module };
    this.sources.push(s);
    return s;
  }

  sink(n) {
    const name = n === '@DEFAULT_SINK@' ? this.defaultSink : n;
    return this.sinks.find((s) => s.name === name || s.index === name) || null;
  }

  source(n) {
    const name = n === '@DEFAULT_SOURCE@' ? this.defaultSource : n === '@DEFAULT_MONITOR@' ? `${this.defaultSink}.monitor` : n;
    return this.sources.find((s) => s.name === name || s.index === name) || null;
  }

  addSinkInput(props, sinkName = this.defaultSink, { driver = 'protocol-native.c', module = '0', corked = false } = {}) {
    const s = { index: String(this.nextStream++), sink: this.sink(sinkName).index, props, driver, module, corked };
    this.sinkInputs.push(s);
    return s;
  }

  addSourceOutput(props, sourceName = this.defaultSource, { driver = 'protocol-native.c', module = '0' } = {}) {
    const s = { index: String(this.nextStream++), source: this.source(sourceName).index, props, driver, module };
    this.sourceOutputs.push(s);
    return s;
  }

  sinkOf(si) {
    return this.sinks.find((s) => s.index === si.sink) || {};
  }

  sourceOf(so) {
    return this.sources.find((s) => s.index === so.source) || {};
  }

  streamText(kind, list) {
    return list
      .map((s) => {
        const props = Object.entries(s.props)
          .map(([k, v]) => `\t\t${k} = "${String(v).replace(/(["\\])/g, '\\$1')}"`)
          .join('\n');
        const where = kind === 'Sink Input' ? `\tSink: ${s.sink}` : `\tSource: ${s.source}`;
        return `${kind} #${s.index}\n\tDriver: ${s.driver}\n\tOwner Module: ${s.module}\n\tClient: n/a\n${where}\n\tCorked: ${s.corked ? 'yes' : 'no'}\n\tMute: no\n\tProperties:\n${props}\n`;
      })
      .join('\n');
  }

  async run(cmd, args = []) {
    if (cmd === 'pactl' && this.onCall) await this.onCall(args);
    return this.runSync(cmd, args);
  }

  runSync(cmd, args = []) {
    if (cmd !== 'pactl') {
      this.other.push([cmd, ...args]);
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: false };
    }
    this.calls.push(args.slice());
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', error: null, timedOut: false });
    const fail = (stderr) => ({ code: 1, stdout: '', stderr, error: null, timedOut: false });
    if (this.down) return fail('Connection failure: Connection refused');
    const [a, b, c, d] = args;
    if (a === 'info') {
      return ok(`Server Name: pulseaudio\nServer Version: 16.1\nDefault Sink: ${this.defaultSink || '(null)'}\nDefault Source: ${this.defaultSource || '(null)'}\n`);
    }
    if (a === 'list' && b === 'short') {
      if (c === 'modules') return ok(this.modules.map((m) => `${m.index}\t${m.name}\t${m.args}\t\n`).join(''));
      if (c === 'sinks') return ok(this.sinks.map((s) => `${s.index}\t${s.name}\tmodule-null-sink.c\ts16le 2ch 44100Hz\tIDLE\n`).join(''));
      if (c === 'sources') return ok(this.sources.map((s) => `${s.index}\t${s.name}\tmodule-null-sink.c\ts16le 2ch 44100Hz\tIDLE\n`).join(''));
      return fail('unknown list');
    }
    if (a === 'list' && b === 'sink-inputs') return ok(this.streamText('Sink Input', this.sinkInputs));
    if (a === 'list' && b === 'source-outputs') return ok(this.streamText('Source Output', this.sourceOutputs));
    if (a === 'load-module') {
      const kv = {};
      for (const x of args.slice(2)) {
        const i = x.indexOf('=');
        kv[x.slice(0, i)] = x.slice(i + 1);
      }
      const idx = String(this.nextModule++);
      if (b === 'module-null-sink') {
        if (this.sink(kv.sink_name)) return fail('Failure: Module initialization failed');
        this.addSink(kv.sink_name, idx);
        if (!this.defaultSink || this.newSinkBecomesDefault) this.defaultSink = kv.sink_name;
      } else if (b === 'module-remap-source') {
        if (!this.source(kv.master)) return fail('Failure: Module initialization failed');
        this.addSource(kv.source_name, idx);
        this.addSourceOutput({ 'media.name': 'Remapped Stream', 'media.role': 'filter' }, kv.master, { driver: 'module-remap-source.c', module: idx });
      } else if (b === 'module-loopback') {
        if (!this.source(kv.source) || !this.sink(kv.sink)) return fail('Failure: Module initialization failed');
        this.addSinkInput({ 'application.id': 'claude-anywhere', 'media.name': 'Loopback' }, kv.sink, { driver: 'module-loopback.c', module: idx });
        this.addSourceOutput({ 'media.name': 'Loopback' }, kv.source, { driver: 'module-loopback.c', module: idx });
      } else return fail('Failure: No such entity');
      this.modules.push({ index: idx, name: b, args: args.slice(2).join(' ') });
      return ok(`${idx}\n`);
    }
    if (a === 'unload-module') {
      const m = this.modules.find((x) => x.index === b);
      if (!m) return fail('Failure: No such entity');
      this.modules = this.modules.filter((x) => x !== m);
      const goneSinks = this.sinks.filter((s) => s.module === b).map((s) => s.index);
      this.sinks = this.sinks.filter((s) => s.module !== b);
      this.sources = this.sources.filter((s) => s.module !== b);
      this.sinkInputs = this.sinkInputs.filter((s) => s.module !== b);
      this.sourceOutputs = this.sourceOutputs.filter((s) => s.module !== b);
      if (!this.sink(this.defaultSink)) this.defaultSink = this.sinks[0] ? this.sinks[0].name : null;
      if (!this.source(this.defaultSource)) this.defaultSource = (this.sources.find((s) => !s.name.endsWith('.monitor')) || {}).name || null;
      for (const si of this.sinkInputs) if (goneSinks.includes(si.sink)) si.sink = this.sink(this.defaultSink).index;
      for (const so of this.sourceOutputs) if (!this.sources.some((s) => s.index === so.source)) so.source = this.source(this.defaultSource).index;
      return ok();
    }
    if (a === 'set-default-source') {
      if (!this.source(b)) return fail('Failure: No such entity');
      this.defaultSource = this.source(b).name;
      return ok();
    }
    if (a === 'set-default-sink') {
      if (!this.sink(b)) return fail('Failure: No such entity');
      this.defaultSink = this.sink(b).name;
      return ok();
    }
    if (a === 'move-sink-input') {
      const si = this.sinkInputs.find((s) => s.index === b);
      if (!si || !this.sink(c)) return fail('Failure: No such entity');
      si.sink = this.sink(c).index;
      return ok();
    }
    if (a === 'move-source-output') {
      const so = this.sourceOutputs.find((s) => s.index === b);
      if (!so || !this.source(c)) return fail('Failure: No such entity');
      so.source = this.source(c).index;
      return ok();
    }
    return fail(`unknown command ${a} ${d || ''}`);
  }
}

const allTools = () => (n) => `/usr/bin/${n}`;
const cfgOf = (audio = {}) => ({ calls: { audio: { mode: 'auto', virtualMic: '', capture: '', switchDefaultInput: true, ...audio } } });

function linuxBridge(pulse, { config = cfgOf(), followMs = 0, which = allTools(), stateFile = tmpFile('calls-audio.json'), pid } = {}) {
  return new AudioBridge({ platformInfo: { platform: 'linux', isWSL: false }, runner: pulse.runner, which, config, stateFile, followMs, env: {}, pid });
}

const CHROME = { 'application.name': 'Chromium', 'application.process.binary': 'chrome' };
const CHROME_MIC = { 'application.name': 'Chromium input', 'application.process.binary': 'chrome' };

// ------------------------------------------------------------------------------------------------ pure helpers

test('parsers read captured pactl output (PulseAudio 16.1, PipeWire)', () => {
  const info = ab.parsePactlInfo(PACTL_INFO);
  assert.deepEqual(info, { serverName: 'pulseaudio', serverVersion: '16.1', defaultSink: 'speakers', defaultSource: 'hwmic', pipewire: false });
  const pw = ab.parsePactlInfo(PACTL_INFO_PIPEWIRE);
  assert.equal(pw.pipewire, true);
  assert.equal(pw.defaultSource, 'alsa_input.pci-0000_00_1f.3.analog-stereo');
  assert.equal(ab.parsePactlInfo('Default Sink: (null)\n').defaultSink, null);

  const mods = ab.parseShortModules(MODULES_SHORT);
  assert.equal(mods.length, 5);
  assert.deepEqual(mods[3], { index: '6', name: 'module-null-sink', args: 'sink_name=anywhere_tts rate=48000 channels=1 sink_properties=device.description=Claude-Anywhere-Voice-Out' });
  assert.deepEqual(mods.map(ab.ourModuleRole), [null, null, null, 'tts', 'mic']);
  assert.deepEqual(
    ab.parseShortList(SINKS_SHORT).map((s) => [s.index, s.name, s.state]),
    [['0', 'speakers', 'RUNNING'], ['2', 'anywhere_tts', 'IDLE']],
  );

  const sis = ab.parseSinkInputs(SINK_INPUTS);
  assert.equal(sis.length, 2);
  assert.equal(sis[0].index, '1');
  assert.equal(sis[0].sink, '0');
  assert.equal(sis[0].client, '6');
  assert.equal(sis[0].props['application.process.binary'], 'chrome');
  assert.equal(sis[0].props['window.x11.display'], ':98');
  assert.equal(sis[1].corked, true);
  assert.equal(sis[1].props['media.name'], 'Playback "quoted"');
  assert.ok(!('Volume' in sis[1].props) && !('balance 0.00' in sis[1].props), 'volume lines are not properties');

  const sos = ab.parsePactlStreams(SOURCE_OUTPUTS);
  assert.deepEqual(sos.map((s) => [s.kind, s.index, s.source, s.driver]), [['source-output', '0', '1', 'module-remap-source.c'], ['source-output', '2', '4', 'protocol-native.c']]);
  assert.equal(sos[0].client, null);
  assert.equal(sos[1].props['application.name'], 'Chromium input');
  assert.equal(ab.parsePactlStreams('').length, 0);
});

test('own and module streams are never routed; call apps are matched by process name', () => {
  const [remap, mic] = ab.parsePactlStreams(SOURCE_OUTPUTS);
  assert.equal(ab.isOwnStream(remap), true, 'remapped stream');
  assert.equal(ab.isOwnStream(mic), false);
  assert.equal(ab.isOwnStream({ driver: 'protocol-native.c', props: { 'application.id': 'claude-anywhere' } }), true);
  assert.equal(ab.isOwnStream({ driver: 'protocol-native.c', props: { 'application.name': 'claude-anywhere' } }), true);
  assert.equal(ab.isOwnStream({ driver: 'module-loopback.c', props: {} }), true);
  const s = (props) => ({ driver: 'protocol-native.c', props });
  assert.equal(ab.streamMatchesApp(s(CHROME), ''), true, 'any browser');
  assert.equal(ab.streamMatchesApp(s(CHROME), 'chrome'), true);
  assert.equal(ab.streamMatchesApp(s(CHROME), 'brave'), true, 'Brave and Edge run as "chrome" on Linux too');
  assert.equal(ab.streamMatchesApp(s({ 'application.name': 'Brave', 'application.process.binary': 'brave' }), 'brave'), true);
  assert.equal(ab.streamMatchesApp(s({ 'application.name': 'Firefox', 'application.process.binary': 'firefox' }), 'chrome'), false);
  assert.equal(ab.streamMatchesApp(s({ 'application.name': 'Firefox', 'application.process.binary': 'firefox-bin' }), 'firefox'), true);
  assert.equal(ab.streamMatchesApp(s({ 'application.name': 'Teams', 'application.process.binary': 'teams-for-linux' }), 'teams'), true);
  assert.equal(ab.streamMatchesApp(s({ 'application.name': 'Spotify', 'application.process.binary': 'spotify' }), ''), false, 'not a call app');
  assert.equal(ab.streamMatchesApp(s({ 'application.name': 'Chrome.exe' }), 'chrome'), true);
  assert.equal(ab.streamMatchesApp(s({}), ''), false);
});

test('buildPactlPlan: the §5.1 modules, loopback only to a real speaker, engage/release/teardown commands', () => {
  const p = ab.buildPactlPlan({ defaultSink: 'speakers', savedSource: 'hwmic', modules: [{ index: 6 }, { index: 7 }, { index: 8 }, { index: 9 }], moves: { sinkInputs: [{ index: '1', from: 'speakers' }, { index: '5', from: null }], sourceOutputs: [{ index: '2', from: 'hwmic' }] } });
  assert.deepEqual(p.setup.map((m) => m.command), [
    ['load-module', 'module-null-sink', 'sink_name=anywhere_tts', 'rate=48000', 'channels=1', 'sink_properties=device.description=Claude-Anywhere-Voice-Out'],
    ['load-module', 'module-remap-source', 'master=anywhere_tts.monitor', 'source_name=anywhere_mic', 'source_properties=device.description=Claude-Anywhere-Mic'],
    ['load-module', 'module-null-sink', 'sink_name=anywhere_call', 'sink_properties=device.description=Claude-Anywhere-Call-Capture'],
    ['load-module', 'module-loopback', 'source=anywhere_call.monitor', 'sink=speakers', 'latency_msec=60', 'source_dont_move=true', 'sink_input_properties=application.id=claude-anywhere'],
  ]);
  assert.deepEqual(p.setup.map((m) => m.role), ['tts', 'mic', 'call', 'monitor']);
  assert.deepEqual(p.engage, [['set-default-source', 'anywhere_mic'], ['move-sink-input', '1', 'anywhere_call'], ['move-sink-input', '5', 'anywhere_call'], ['move-source-output', '2', 'anywhere_mic']]);
  assert.deepEqual(p.release, [['set-default-source', 'hwmic'], ['move-sink-input', '1', 'speakers'], ['move-sink-input', '5', 'speakers'], ['move-source-output', '2', 'hwmic']]);
  assert.deepEqual(p.teardown, [['unload-module', '9'], ['unload-module', '8'], ['unload-module', '7'], ['unload-module', '6']]);
  // No speakers (headless) or a default that is one of ours: no loopback, which would feed the capture back into itself.
  assert.equal(ab.buildPactlPlan({ defaultSink: null }).setup.length, 3);
  assert.equal(ab.buildPactlPlan({ defaultSink: 'anywhere_call' }).setup.length, 3);
  assert.equal(ab.buildPactlPlan({ defaultSink: 'speakers', loopback: false }).setup.length, 3);
  // Never restore "to" one of our own devices.
  assert.deepEqual(ab.buildPactlPlan({ savedSource: 'anywhere_mic', moves: { sourceOutputs: [{ index: '3', from: 'anywhere_mic' }] } }).release, [['move-source-output', '3', '@DEFAULT_SOURCE@']]);
});

test('phraseScore, wavLevel and the small helpers', () => {
  const mic = ab.MIC_PHRASE;
  assert.equal(ab.phraseScore(mic, 'Testing 1, 2, 3. Can you hear the microphone?').score, 1);
  assert.equal(ab.phraseScore(mic, 'Testing 1-3 Can you hear the microphone?').pass, true, 'a real Moonshine transcript (espeak voice)');
  assert.equal(ab.phraseScore(mic, 'testing won to three can you here the micro phone').pass, true, 'number words, split words, a near miss');
  assert.equal(ab.phraseScore(mic, '').pass, false);
  assert.equal(ab.phraseScore(mic, 'please assign me a ticket from the sprint').pass, false);
  const cap = ab.phraseScore(ab.CAPTURE_PHRASE, '4, 5, 6. The sound from this tab is working.');
  assert.equal(cap.score, 1);
  assert.deepEqual(cap.missing, []);
  // The directions cannot pass for each other.
  assert.equal(ab.phraseScore(ab.CAPTURE_PHRASE, 'Testing 1, 2, 3. Can you hear the microphone?').pass, false);
  assert.equal(ab.phraseScore(mic, 'Four five six. The sound from this tab is working.').pass, false);

  // Silence is cut before transcription (Moonshine returns nothing for some clips that start with ~1 s of zeros).
  const padded = wavOf(16000, [[1.0, false], [0.5, true], [0.7, false]]);
  const trimmed = ab.trimWav(padded);
  const tl = ab.wavLevel(trimmed);
  assert.ok(Math.abs(tl.seconds - 0.8) < 0.03, `trimmed to ${tl.seconds} s (0.5 s + 2 x 150 ms)`);
  assert.equal(ab.trimWav(wavOf(16000, [[1, false]])), null, 'no speech');
  assert.equal(ab.trimWav(Buffer.from('x')), null);
  assert.ok(Math.abs(ab.wavLevel(ab.trimWav(wavOf(16000, [[1, true]]))).seconds - 1) < 0.01, 'all speech: kept whole');

  const w = wavOf(16000, [[0.5, false], [0.5, true]]);
  const lv = ab.wavLevel(w);
  assert.equal(lv.ok, true);
  assert.equal(lv.rate, 16000);
  assert.ok(Math.abs(lv.seconds - 1) < 0.001);
  assert.ok(lv.peakDbfs > -11 && lv.peakDbfs < -10, `peak ${lv.peakDbfs}`);
  assert.ok(lv.rmsDbfs < lv.peakDbfs);
  assert.equal(ab.wavLevel(Buffer.from('nope')).ok, false);
  assert.equal(ab.wavLevel(ab.pcmToWav(Buffer.alloc(3200), 16000)).rmsDbfs, -120);

  assert.deepEqual(ab.parseCaptureOverride('device:BlackHole 16ch', 'darwin'), { backend: 'device', device: 'BlackHole 16ch' });
  assert.deepEqual(ab.parseCaptureOverride('sck:Brave Browser', 'darwin'), { backend: 'sck', device: '', app: 'Brave Browser' });
  assert.deepEqual(ab.parseCaptureOverride('wasapi-loopback', 'win32'), { backend: 'wasapi-loopback', device: '' });
  assert.deepEqual(ab.parseCaptureOverride('alsa_output.x.monitor', 'linux'), { backend: 'pulse', device: 'alsa_output.x.monitor' });
  assert.equal(ab.parseCaptureOverride('', 'linux'), null);
  assert.equal(ab.playbackFor('CABLE Output', 'win32'), 'CABLE Input');
  assert.equal(ab.playbackFor('CABLE-A Output', 'win32'), 'CABLE-A Input');
  assert.equal(ab.playbackFor('BlackHole 2ch', 'darwin'), 'BlackHole 2ch');
  assert.deepEqual(ab.audioConfig({}), { mode: 'auto', virtualMic: '', capture: '', switchDefaultInput: true });
  assert.equal(ab.audioConfig({ calls: { audio: { mode: 'bogus' } } }).mode, 'auto');
});

// ------------------------------------------------------------------------------------------------ Linux bridge

test('Linux check: ready with pactl, problems without it or without a sound server', async () => {
  const pulse = new FakePulse();
  const r = await linuxBridge(pulse).check();
  assert.equal(r.mode, 'virtual');
  assert.equal(r.ready, true);
  assert.equal(r.platform, 'linux');
  assert.equal(r.virtualMic, 'anywhere_mic');
  assert.deepEqual(r.capture, { backend: 'pulse', device: 'anywhere_call.monitor' });
  assert.equal(r.defaultSource, 'alsa_input.pci-0000_00_1f.3.analog-stereo');
  assert.deepEqual(r.issues.filter((i) => i.level !== 'info'), []);
  assert.ok(!pulse.calls.some((c) => c[0] === 'load-module' || c[0].startsWith('set-')), 'check changes nothing');

  const none = await linuxBridge(pulse, { which: () => null }).check();
  assert.equal(none.ready, false);
  assert.equal(none.issues[0].code, 'PACTL_MISSING');
  assert.match(none.issues[0].hint, /pulseaudio-utils/);

  pulse.down = true;
  const down = await linuxBridge(pulse).check();
  assert.equal(down.ready, false);
  assert.equal(down.issues[0].code, 'PULSE_UNREACHABLE');
  assert.match(down.issues[0].hint, /pipewire-pulse/);

  const noTools = await linuxBridge(new FakePulse(), { which: (n) => (n === 'pactl' ? '/usr/bin/pactl' : null) }).check();
  assert.equal(noTools.ready, false);
  assert.ok(noTools.issues.some((i) => i.code === 'PULSE_TOOLS_MISSING'));
});

test('Linux setup loads the four modules once, records each before the next, and keeps the user default sink', async () => {
  const pulse = new FakePulse({ newSinkBecomesDefault: true }); // like module-switch-on-connect
  const stateFile = tmpFile('state.json');
  const seen = [];
  pulse.onCall = (args) => {
    if (args[0] === 'load-module') seen.push(fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).pulse.modules.length : 0);
  };
  const b = linuxBridge(pulse, { stateFile });
  const r = await b.setup();
  assert.equal(r.ok, true);
  assert.deepEqual(r.modules.map((m) => m.role), ['tts', 'mic', 'call', 'monitor']);
  assert.deepEqual(seen, [0, 1, 2, 3], 'the state file lists every module loaded so far');
  const loads = pulse.calls.filter((c) => c[0] === 'load-module');
  assert.equal(loads.length, 4);
  assert.ok(loads[3].includes('sink=alsa_output.pci-0000_00_1f.3.analog-stereo'), 'loopback to the real speakers');
  assert.equal(pulse.defaultSink, 'alsa_output.pci-0000_00_1f.3.analog-stereo', 'default sink restored after the new sinks took it');
  assert.equal(pulse.defaultSource, 'alsa_input.pci-0000_00_1f.3.analog-stereo');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(st.version, 1);
  assert.equal(st.pid, process.pid);
  assert.equal(st.pulse.savedDefaultSource, 'alsa_input.pci-0000_00_1f.3.analog-stereo');
  assert.equal((fs.statSync(stateFile).mode & 0o777).toString(8), '600');

  // Idempotent, also for a fresh process that finds the modules loaded (they are adopted, not duplicated).
  await b.setup();
  const b2 = linuxBridge(pulse, { stateFile: tmpFile('state2.json') });
  const r2 = await b2.setup();
  assert.deepEqual(r2.adopted, ['tts', 'mic', 'call', 'monitor']);
  assert.equal(pulse.calls.filter((c) => c[0] === 'load-module').length, 4);
});

test('Linux engage routes only the call app, follows new streams, and release puts everything back', async () => {
  const pulse = new FakePulse();
  const userSink = pulse.defaultSink;
  const userMic = pulse.defaultSource;
  pulse.addSink('headphones', null);
  const si1 = pulse.addSinkInput(CHROME, 'headphones');
  const si2 = pulse.addSinkInput(CHROME, userSink, { corked: true });
  const ff = pulse.addSinkInput({ 'application.name': 'Firefox', 'application.process.binary': 'firefox' });
  const own = pulse.addSinkInput({ 'application.name': 'claude-anywhere', 'application.id': 'claude-anywhere' });
  const mic = pulse.addSourceOutput(CHROME_MIC);
  const tabRec = pulse.addSourceOutput(CHROME, `${userSink}.monitor`);
  const stateFile = tmpFile('state.json');
  let stateAtSwitch = null;
  pulse.onCall = (args) => {
    if (args[0] === 'set-default-source' && args[1] === 'anywhere_mic') stateAtSwitch = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  };
  const b = linuxBridge(pulse, { stateFile, followMs: 25 });
  const r = await b.engage({ browserApp: 'chrome' });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'virtual');
  assert.equal(r.halfDuplex, false);
  assert.deepEqual(r.moved, { sinkInputs: 2, sourceOutputs: 1 });
  assert.deepEqual(r.startParams.capture, { backend: 'pulse', device: 'anywhere_call.monitor' });
  assert.deepEqual(r.startParams.playback, { backend: 'pulse', device: 'anywhere_tts' });
  assert.deepEqual(r.startParams.vad, { threshold: 0.5, minSilenceMs: 600, minSpeechMs: 250 });
  assert.deepEqual(r.startParams.bargeIn, { minSpeechMs: 400, stopPlayback: true });
  assert.ok(stateAtSwitch && stateAtSwitch.pulse.engaged === true, 'the state file is written before the default changes');
  assert.equal(stateAtSwitch.pulse.engage.savedDefaultSource, userMic);
  assert.equal(pulse.defaultSource, 'anywhere_mic');
  const call = pulse.sink('anywhere_call').index;
  assert.equal(si1.sink, call);
  assert.equal(si2.sink, call, 'corked streams move too');
  assert.notEqual(ff.sink, call, 'another app is left alone');
  assert.notEqual(own.sink, call, 'our own stream is left alone');
  assert.equal(mic.source, pulse.source('anywhere_mic').index, "the browser's open mic moves to the virtual mic");
  assert.equal(tabRec.source, pulse.source(`${userSink}.monitor`).index, 'a tab recording a monitor is not a mic');
  assert.equal(b.status().engaged, true);
  assert.equal(b.status().following, true);

  // A stream the call app opens later (the call audio starts after Accept) is followed.
  const late = pulse.addSinkInput(CHROME);
  assert.ok(await until(() => late.sink === call), 'the new stream was moved');

  // The user picks another default microphone during the call: release must not undo that.
  const r2 = await b.release();
  assert.equal(r2.ok, true);
  assert.equal(r2.restored, true);
  assert.equal(pulse.defaultSource, userMic);
  assert.equal(si1.sink, pulse.sink('headphones').index, 'back to the sink it came from');
  assert.equal(si2.sink, pulse.sink(userSink).index);
  assert.equal(late.sink, pulse.sink(userSink).index);
  assert.equal(mic.source, pulse.source(userMic).index);
  assert.equal(b.status().engaged, false);
  assert.equal(b.status().following, false);
  const n = pulse.calls.length;
  await sleep(80);
  assert.equal(pulse.calls.length, n, 'no more following after release');

  await b.engage({ browserApp: 'chrome' });
  pulse.defaultSource = 'anywhere_tts.monitor';
  await b.release();
  assert.equal(pulse.defaultSource, 'anywhere_tts.monitor', "a default the user chose meanwhile is kept");
  await b.teardown();
});

test('Linux teardown unloads in reverse order and removes the state file; a crashed daemon is restored at start', async () => {
  const pulse = new FakePulse();
  const stateFile = tmpFile('state.json');
  const b = linuxBridge(pulse, { stateFile });
  await b.setup();
  await b.teardown();
  const unloads = pulse.calls.filter((c) => c[0] === 'unload-module').map((c) => c[1]);
  assert.deepEqual(unloads, ['13', '12', '11', '10'], 'monitor, call, mic, tts');
  assert.ok(!pulse.modules.some((m) => ab.ourModuleRole(m)));
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(pulse.defaultSource, 'alsa_input.pci-0000_00_1f.3.analog-stereo');

  // A daemon that died while engaged (its pid is gone): the next daemon undoes everything.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  const userMic = pulse.defaultSource;
  const si = pulse.addSinkInput(CHROME);
  const crashed = linuxBridge(pulse, { stateFile, pid: deadPid });
  await crashed.engage({ browserApp: '' });
  assert.equal(pulse.defaultSource, 'anywhere_mic');
  crashed._stopFollowing();
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(st.pid, deadPid);

  const next = linuxBridge(pulse, { stateFile });
  assert.equal(next.status().engaged, false, "another process's state is not taken as ours");
  const r = await next.restoreFromCrash();
  assert.equal(r.restored, true);
  assert.equal(r.from, deadPid);
  assert.equal(pulse.defaultSource, userMic);
  assert.equal(si.sink, pulse.sink(pulse.defaultSink).index);
  assert.ok(!pulse.modules.some((m) => ab.ourModuleRole(m)));
  assert.equal(fs.existsSync(stateFile), false);
  assert.deepEqual(await next.restoreFromCrash(), { restored: false, reason: 'nothing to restore' });

  // A live daemon's file (this very process, seen from a bridge with another pid) is left alone…
  const live = linuxBridge(pulse, { stateFile });
  await live.setup();
  const other = linuxBridge(pulse, { stateFile, pid: deadPid });
  const skip = await other.restoreFromCrash();
  assert.equal(skip.restored, false);
  assert.match(skip.reason, /in use by process/);
  assert.ok(pulse.modules.some((m) => ab.ourModuleRole(m)));
  // …unless forced.
  assert.equal((await other.restoreFromCrash({ force: true })).restored, true);
  assert.ok(!pulse.modules.some((m) => ab.ourModuleRole(m)));
});

test('Linux restoreSync (process exit) undoes the routing with synchronous pactl calls', async () => {
  const pulse = new FakePulse();
  const stateFile = tmpFile('state.json');
  const b = linuxBridge(pulse, { stateFile });
  const si = pulse.addSinkInput(CHROME);
  await b.engage({ browserApp: 'chrome' });
  b._stopFollowing();
  const sync = [];
  b.spawnSyncFn = (cmd, args) => {
    sync.push([cmd, ...args]);
    const res = pulse.runSync(cmd, args);
    return { status: res.code, stdout: res.stdout };
  };
  const r = b.restoreSync();
  assert.equal(r.restored, true);
  assert.ok(sync.some((c) => c[1] === 'set-default-source' && c[2] === 'alsa_input.pci-0000_00_1f.3.analog-stereo'));
  assert.ok(sync.some((c) => c[1] === 'move-sink-input' && c[2] === si.index));
  assert.equal(sync.filter((c) => c[1] === 'unload-module').length, 4);
  assert.equal(fs.existsSync(stateFile), false);
  assert.deepEqual(b.restoreSync(), { restored: false });
});

test('speaker mode: no virtual devices, the default sink monitor, half duplex; auto falls back to it', async () => {
  const pulse = new FakePulse();
  const b = linuxBridge(pulse, { config: cfgOf({ mode: 'speakers' }) });
  const c = await b.check();
  assert.equal(c.mode, 'speakers');
  assert.equal(c.ready, true);
  assert.ok(c.issues.some((i) => i.code === 'SPEAKER_MODE'));
  const r = await b.engage();
  assert.equal(r.mode, 'speakers');
  assert.equal(r.halfDuplex, true);
  assert.deepEqual(r.startParams.capture, { backend: 'pulse', device: 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor' });
  assert.deepEqual(r.startParams.playback, { backend: 'pulse', device: 'alsa_output.pci-0000_00_1f.3.analog-stereo' });
  assert.equal(r.startParams.halfDuplex, true);
  assert.equal(r.startParams.tailMs, 300);
  assert.equal(r.startParams.bargeIn, null);
  assert.equal(r.startParams.vad.minSilenceMs, 800);
  assert.ok(!pulse.calls.some((x) => x[0] === 'load-module' || x[0] === 'set-default-source'), 'nothing is rerouted');
  await b.teardown();

  // Windows without VB-CABLE in auto mode: speakers, with a warning.
  const ps = fakePsHost({ cable: false });
  const w = new AudioBridge({ platformInfo: { platform: 'win32' }, psHost: ps, config: cfgOf(), stateFile: tmpFile('w.json') });
  const wc = await w.check();
  assert.equal(wc.mode, 'speakers');
  assert.equal(wc.ready, true);
  assert.ok(wc.issues.some((i) => i.code === 'VB_CABLE_MISSING' && /vb-audio\.com/.test(i.hint)));
  assert.ok(wc.issues.some((i) => i.code === 'SPEAKERS_FALLBACK'));
  assert.deepEqual(w.startParams().capture, { backend: 'wasapi-loopback', device: '' });
  assert.equal(w.startParams().halfDuplex, true);
  // calls.audio.mode = virtual insists: not ready.
  const strict = new AudioBridge({ platformInfo: { platform: 'win32' }, psHost: ps, config: cfgOf({ mode: 'virtual' }), stateFile: tmpFile('w2.json') });
  const sc = await strict.check();
  assert.equal(sc.mode, 'virtual');
  assert.equal(sc.ready, false);
});

// ------------------------------------------------------------------------------------------------ Windows / WSL

const CABLE_OUT = '{0.0.1.00000000}.{11111111-2222-3333-4444-555555555555}';
const CABLE_IN = '{0.0.0.00000000}.{11111111-2222-3333-4444-666666666666}';
const USER_MIC = '{0.0.1.00000000}.{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}';
const HEADSET = '{0.0.1.00000000}.{aaaaaaaa-bbbb-cccc-dddd-ffffffffffff}';
const SPEAKERS = '{0.0.0.00000000}.{aaaaaaaa-bbbb-cccc-dddd-000000000000}';

/** The audio ops of the PowerShell host, as a driver-like object. */
function fakePsHost({ cable = true } = {}) {
  const capture = [{ id: USER_MIC, name: 'Microphone (Realtek(R) Audio)' }, { id: HEADSET, name: 'Headset Microphone (Jabra)' }];
  const render = [{ id: SPEAKERS, name: 'Speakers (Realtek(R) Audio)' }];
  if (cable) {
    capture.push({ id: CABLE_OUT, name: 'CABLE Output (VB-Audio Virtual Cable)' });
    render.push({ id: CABLE_IN, name: 'CABLE Input (VB-Audio Virtual Cable)' });
  }
  const host = {
    defaults: { capture: { console: USER_MIC, multimedia: USER_MIC, communications: HEADSET }, render: { console: SPEAKERS, multimedia: SPEAKERS, communications: SPEAKERS } },
    calls: [],
    exe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoLogo', '-File', 'C:\\x\\win32-host.ps1'],
    flow(f) {
      const list = f === 'capture' ? capture : render;
      const rec = (id) => {
        const d = list.find((x) => x.id === id);
        return d ? { id: d.id, name: d.name } : null;
      };
      const d = this.defaults[f];
      return { flow: f, console: rec(d.console), multimedia: rec(d.multimedia), communications: rec(d.communications), devices: list.slice() };
    },
    async audioDefaultGet(arg) {
      const f = typeof arg === 'string' ? arg : arg.flow;
      this.calls.push(['get', f]);
      if (f === 'all') return { capture: this.flow('capture'), render: this.flow('render') };
      return this.flow(f);
    },
    async audioDefaultSet(a) {
      this.calls.push(['set', a]);
      for (const role of a.roles) this.defaults[a.flow || 'capture'][role] = a.id;
      return { ok: true, id: a.id, roles: a.roles, skipped: [] };
    },
  };
  return host;
}

test('Windows: VB-CABLE as the mic through IPolicyConfig, restored per role, also after a crash', async () => {
  const ps = fakePsHost();
  const stateFile = tmpFile('w.json');
  const b = new AudioBridge({ platformInfo: { platform: 'win32' }, psHost: ps, config: cfgOf(), stateFile });
  const c = await b.check();
  assert.equal(c.mode, 'virtual');
  assert.equal(c.ready, true);
  assert.equal(c.virtualMic, 'CABLE Output');
  assert.equal(c.playback, 'CABLE Input');
  assert.equal(c.defaultSource, 'Microphone (Realtek(R) Audio)');
  assert.ok(c.issues.some((i) => i.code === 'PINNED_MIC' && i.level === 'info'));

  let saved = null;
  const origSet = ps.audioDefaultSet.bind(ps);
  ps.audioDefaultSet = async (a) => {
    if (!saved) saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return origSet(a);
  };
  const r = await b.engage({ browserApp: 'brave' });
  assert.equal(r.mode, 'virtual');
  assert.deepEqual(r.startParams.capture, { backend: 'wasapi-loopback', device: '' });
  assert.deepEqual(r.startParams.playback, { backend: 'device', device: 'CABLE Input' });
  assert.equal(saved.win32.engaged, true, 'saved before switching');
  assert.deepEqual(saved.win32.saved, { console: USER_MIC, multimedia: USER_MIC, communications: HEADSET });
  assert.deepEqual(ps.defaults.capture, { console: CABLE_OUT, multimedia: CABLE_OUT, communications: CABLE_OUT });

  // The user moves the communications device to the headset during the call: that choice stays.
  ps.defaults.capture.communications = HEADSET;
  const rel = await b.release();
  assert.equal(rel.ok, true);
  assert.deepEqual(ps.defaults.capture, { console: USER_MIC, multimedia: USER_MIC, communications: HEADSET });
  const sets = ps.calls.filter((x) => x[0] === 'set').map((x) => x[1]);
  assert.deepEqual(sets.slice(1).map((s) => [s.id, s.roles.join()]), [[USER_MIC, 'console'], [USER_MIC, 'multimedia']]);

  // Crash while engaged → restored by the next daemon.
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const crashed = new AudioBridge({ platformInfo: { platform: 'win32' }, psHost: ps, config: cfgOf(), stateFile, pid: dead });
  await crashed.engage();
  assert.equal(ps.defaults.capture.console, CABLE_OUT);
  const next = new AudioBridge({ platformInfo: { platform: 'win32' }, psHost: ps, config: cfgOf(), stateFile });
  const rr = await next.restoreFromCrash();
  assert.equal(rr.restored, true);
  assert.deepEqual(ps.defaults.capture, { console: USER_MIC, multimedia: USER_MIC, communications: HEADSET });
  assert.equal(fs.existsSync(stateFile), false);

  // switchDefaultInput off: routing without touching the default.
  const ps2 = fakePsHost();
  const keep = new AudioBridge({ platformInfo: { platform: 'win32' }, psHost: ps2, config: cfgOf({ switchDefaultInput: false }), stateFile: tmpFile('w3.json') });
  await keep.engage();
  assert.equal(ps2.calls.filter((x) => x[0] === 'set').length, 0);
  await keep.teardown();

  // VB-CABLE missing in virtual mode: engage fails with the install hint, nothing changed.
  const ps3 = fakePsHost({ cable: false });
  const nocable = new AudioBridge({ platformInfo: { platform: 'win32' }, psHost: ps3, config: cfgOf({ mode: 'virtual' }), stateFile: tmpFile('w4.json') });
  await assert.rejects(nocable.engage(), (e) => e.code === 'VB_CABLE_MISSING' && /VBCABLE_Setup_x64/.test(e.hint));
  assert.equal(ps3.calls.filter((x) => x[0] === 'set').length, 0);
});

test('Windows restoreSync sends one-shot audioDefaultSet lines with onlyIf to a fresh PowerShell host', async () => {
  const ps = fakePsHost();
  const stateFile = tmpFile('w.json');
  // A lazily resolved driver (as routes-calls passes getDriver) whose host has the command line.
  const driver = { host: ps, audioDefaultGet: ps.audioDefaultGet.bind(ps), audioDefaultSet: ps.audioDefaultSet.bind(ps) };
  const b = new AudioBridge({ platformInfo: { platform: 'win32' }, psHost: () => Promise.resolve(driver), config: cfgOf(), stateFile });
  await b.engage();
  const spawned = [];
  b.spawnSyncFn = (exe, args, opts) => {
    spawned.push({ exe, args, input: opts.input });
    return { status: 0 };
  };
  const r = b.restoreSync();
  assert.equal(r.restored, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].exe, ps.exe);
  assert.deepEqual(spawned[0].args, ps.args);
  const lines = spawned[0].input.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.cmd, l.args.id, l.args.roles.join(), l.args.onlyIf]), [
    ['audioDefaultSet', USER_MIC, 'console', CABLE_OUT],
    ['audioDefaultSet', USER_MIC, 'multimedia', CABLE_OUT],
    ['audioDefaultSet', HEADSET, 'communications', CABLE_OUT],
  ]);
  assert.equal(fs.existsSync(stateFile), false);
});

test('WSL uses the Windows devices through the PowerShell host (§5.4)', async () => {
  const ps = fakePsHost();
  const b = new AudioBridge({ platformInfo: { platform: 'linux', isWSL: true }, psHost: () => Promise.resolve(ps), config: cfgOf(), stateFile: tmpFile('wsl.json') });
  assert.equal(b.platform, 'win32');
  const r = await b.engage();
  assert.deepEqual(r.startParams.playback, { backend: 'device', device: 'CABLE Input' });
  assert.equal(ps.defaults.capture.console, CABLE_OUT);
  await b.teardown();
  assert.equal(ps.defaults.capture.console, USER_MIC);
});

// ------------------------------------------------------------------------------------------------ macOS

function fakeMacSidecar({ blackhole = true, sck = true, bh16 = false } = {}) {
  const sc = {
    input: { name: 'MacBook Pro Microphone', uid: 'BuiltInMicrophoneDevice' },
    calls: [],
    python: '/Users/me/.claude-anywhere/voice/clone-venv/bin/python',
    script: '/pkg/src/voice/clone/sidecar.py',
    async request(op, p = {}) {
      this.calls.push([op, p]);
      if (op === 'audio.devices') {
        const inputs = [{ name: 'MacBook Pro Microphone', backend: 'device' }];
        const outputs = [{ name: 'MacBook Pro Speakers', backend: 'device' }];
        if (blackhole) {
          inputs.push({ name: 'BlackHole 2ch', backend: 'device', virtual: true });
          outputs.push({ name: 'BlackHole 2ch', backend: 'device', virtual: true });
        }
        if (bh16) inputs.push({ name: 'BlackHole 16ch', backend: 'device', virtual: true });
        return { inputs, outputs, loopbacks: [{ name: 'ScreenCaptureKit', backend: 'sck', available: sck }], defaults: { input: this.input.name, output: 'MacBook Pro Speakers' } };
      }
      if (op === 'audio.defaultInput') {
        if (p.set) this.input = { name: p.set, uid: p.uid || p.set };
        return { ...this.input, via: 'CoreAudio' };
      }
      throw Object.assign(new Error(`unexpected ${op}`), { code: 'BAD_REQUEST' });
    },
  };
  return sc;
}

test('macOS: BlackHole as the mic, ScreenCaptureKit or BlackHole 16ch for the caller, default input restored', async () => {
  const sc = fakeMacSidecar();
  const b = new AudioBridge({ platformInfo: { platform: 'darwin' }, sidecar: sc, config: cfgOf(), stateFile: tmpFile('m.json') });
  const c = await b.check();
  assert.equal(c.mode, 'virtual');
  assert.equal(c.ready, true);
  assert.equal(c.capture.backend, 'sck');
  assert.ok(c.issues.some((i) => i.code === 'TCC_MICROPHONE'));
  const r = await b.engage({ browserApp: 'Brave Browser' });
  assert.deepEqual(r.startParams.capture, { backend: 'sck', device: '', app: 'Brave Browser' });
  assert.deepEqual(r.startParams.playback, { backend: 'device', device: 'BlackHole 2ch' });
  assert.equal(sc.input.name, 'BlackHole 2ch');
  await b.release();
  assert.equal(sc.input.name, 'MacBook Pro Microphone');
  assert.equal(sc.input.uid, 'BuiltInMicrophoneDevice');

  const fb = new AudioBridge({ platformInfo: { platform: 'darwin' }, sidecar: fakeMacSidecar({ sck: false, bh16: true }), config: cfgOf(), stateFile: tmpFile('m2.json') });
  const fc = await fb.check();
  assert.equal(fc.ready, true);
  assert.deepEqual(fc.capture, { backend: 'device', device: 'BlackHole 16ch' });

  const none = new AudioBridge({ platformInfo: { platform: 'darwin' }, sidecar: fakeMacSidecar({ blackhole: false, sck: false }), config: cfgOf(), stateFile: tmpFile('m3.json') });
  const nc = await none.check();
  assert.equal(nc.mode, 'speakers');
  assert.ok(nc.issues.some((i) => i.code === 'BLACKHOLE_MISSING' && /brew install blackhole-2ch/.test(i.hint)));
  assert.ok(nc.issues.some((i) => i.code === 'CAPTURE_UNAVAILABLE'));
  assert.deepEqual(none.startParams().capture, { backend: 'device', device: '' }, 'speaker mode records the physical mic');

  // restoreSync on macOS: SwitchAudioSource when installed, else audio_io.py's command line.
  const st = tmpFile('m4.json');
  const lazy = fakeMacSidecar();
  const sync = new AudioBridge({ platformInfo: { platform: 'darwin' }, sidecar: () => Promise.resolve(lazy), config: cfgOf(), stateFile: st, which: () => null });
  await sync.engage();
  const spawned = [];
  sync.spawnSyncFn = (cmd, args) => {
    spawned.push([cmd, ...args]);
    return { status: 0 };
  };
  assert.equal(sync.restoreSync().restored, true);
  assert.deepEqual(spawned, [['/Users/me/.claude-anywhere/voice/clone-venv/bin/python', '-I', path.join('/pkg/src/voice/clone', 'audio_io.py'), 'set-default-input', '--name', 'MacBook Pro Microphone']]);
});

// ------------------------------------------------------------------------------------------------ self-test

function fakeBridge(extra = {}) {
  const log = [];
  return {
    log,
    platform: 'linux',
    async check() {
      log.push('check');
      return { mode: 'virtual', platform: 'linux', ready: true, issues: [{ code: 'X', level: 'info', message: 'hidden' }] };
    },
    async engage(o) {
      log.push(['engage', o]);
      return { ok: true };
    },
    async release() {
      log.push('release');
      return { ok: true };
    },
    async syncStreams() {
      log.push('sync');
      return {};
    },
    async playToMic(f) {
      log.push(['play', path.basename(f), fs.existsSync(f)]);
      return { ok: true };
    },
    async recordCapture({ out, seconds }) {
      log.push(['record', seconds]);
      fs.writeFileSync(out, wavOf(16000, [[0.3, false], [0.5, true]]));
      return { out, seconds: 0.8, peakDbfs: -10, rmsDbfs: -20 };
    },
    ...extra,
  };
}

const urlOf = (q) => new URL(`http://127.0.0.1/x?${new URLSearchParams(q)}`);

test('self-test: single-use code, both directions verified by transcript, results saved, routing released', async () => {
  const bridge = fakeBridge();
  const tmpDir = path.join(TMP, 'st-tmp');
  const resultFile = tmpFile('st.json');
  const heard = { mic: 'Testing 1, 2, 3. Can you hear the microphone?', capture: 'four five six the sound from this tab is working' };
  const st = new AudioSelfTest({
    bridge,
    tmpDir,
    resultFile,
    recordLeadMs: 5,
    transcribe: async (f) => (/mic-recording/.test(f) ? heard.mic : heard.capture),
    renderSpeech: async (text, out) => {
      fs.writeFileSync(out, wavOf(22050, [[0.4, true]]));
      return out;
    },
  });
  const m = st.mint();
  assert.match(m.code, /^[a-f0-9]{32}$/);
  assert.equal(m.path, `/calls-audio-test.html?code=${m.code}`);
  await assert.rejects(st.route('begin', { url: urlOf({ code: 'f'.repeat(32) }) }), (e) => e.status === 403);
  const b = await st.route('begin', { url: urlOf({ code: m.code }) });
  assert.equal(b.ok, true);
  assert.match(b.test, /^[a-f0-9]{32}$/);
  assert.equal(b.mode, 'virtual');
  assert.deepEqual(b.issues, [], 'info notes are not shown on the page');
  assert.equal(b.clip.mime, 'audio/wav');
  assert.equal(Buffer.from(b.clip.base64, 'base64').toString('ascii', 0, 4), 'RIFF');
  // The self-test holds the route as its own owner, so its end never releases a call's route (F3-SAFE-F1).
  assert.deepEqual(bridge.log.slice(0, 2), ['check', ['engage', { browserApp: '', owner: 'selftest' }]]);
  await assert.rejects(st.route('begin', { url: urlOf({ code: m.code }) }), (e) => e.status === 403, 'the code works once');

  const q = { url: urlOf({ test: b.test }) };
  const sp = await st.route('speak', q);
  assert.equal(sp.ok, true);
  assert.deepEqual(bridge.log.find((x) => x[0] === 'play'), ['play', `selftest-${b.test.slice(0, 12)}-mic.wav`, true]);
  await assert.rejects(st.route('upload', { ...q, raw: Buffer.from('not a wav file at all, but long enough to pass the size check....') }), (e) => e.status === 415);
  const up = await st.route('upload', { ...q, raw: wavOf(16000, [[1, true]]) });
  assert.equal(up.pass, true);
  assert.equal(up.verified, 'transcript');
  assert.equal(up.transcript, heard.mic);
  assert.equal(up.direction, 'mic');

  const cap = await st.route('capture', q);
  assert.deepEqual(cap, { ok: true, recording: true, seconds: 6 });
  assert.ok(bridge.log.includes('sync'), 'streams routed before recording');
  const res = await st.route('result', q);
  assert.equal(res.pass, true);
  assert.equal(res.score, 1);
  const fin = await st.route('finish', q);
  assert.equal(fin.pass, true);
  assert.equal(fin.released, true);
  assert.equal(bridge.log[bridge.log.length - 1], 'release');
  await assert.rejects(st.route('speak', q), (e) => e.status === 403, 'finished tests are gone');
  const saved = st.lastResult();
  assert.equal(saved.pass, true);
  assert.equal(saved.mic.pass, true);
  assert.equal(saved.capture.pass, true);
  assert.equal((fs.statSync(resultFile).mode & 0o777).toString(8), '600');
  assert.deepEqual(fs.readdirSync(tmpDir).filter((f) => f.startsWith('selftest-')), [], 'temporary audio removed');

  // A wrong transcript fails; without a recognizer only the level counts.
  heard.mic = 'please assign me a ticket';
  const m2 = st.mint();
  const b2 = await st.route('begin', { url: urlOf({ code: m2.code }) });
  const fail = await st.route('upload', { url: urlOf({ test: b2.test }), raw: wavOf(16000, [[1, true]]) });
  assert.equal(fail.pass, false);
  st.transcribe = null;
  const lvl = await st.route('upload', { url: urlOf({ test: b2.test }), raw: wavOf(16000, [[1, true]]) });
  assert.equal(lvl.pass, true);
  assert.equal(lvl.verified, 'level');
  const quiet = await st.route('upload', { url: urlOf({ test: b2.test }), raw: wavOf(16000, [[1, false]]) });
  assert.equal(quiet.pass, false);
  await assert.rejects(st.route('upload', { url: urlOf({ test: b2.test }), raw: wavOf(16000, [[1, false]]) }), (e) => e.status === 429, 'attempts are limited');
  await st.close();
  assert.equal(bridge.log.filter((x) => x === 'release').length, 2);
});

test('self-test: an abandoned page releases the routing when the test expires; begin reports routing errors', async () => {
  const bridge = fakeBridge();
  const st = new AudioSelfTest({ bridge, tmpDir: path.join(TMP, 'st2'), resultFile: tmpFile('st2.json'), testTtlMs: 60, renderSpeech: async (t, out) => fs.writeFileSync(out, wavOf(16000, [[0.2, true]])) });
  const b = await st.route('begin', { url: urlOf({ code: st.mint().code }) });
  assert.equal(b.ok, true);
  assert.ok(await until(() => bridge.log.includes('release'), 2000), 'released after the TTL');
  await assert.rejects(st.route('speak', { url: urlOf({ test: b.test }) }), (e) => e.status === 403);

  const broken = fakeBridge({
    async engage() {
      throw Object.assign(new Error('VB-CABLE is not installed'), { code: 'VB_CABLE_MISSING', hint: 'Install VB-CABLE' });
    },
  });
  const st2 = new AudioSelfTest({ bridge: broken, tmpDir: path.join(TMP, 'st3'), resultFile: tmpFile('st3.json'), renderSpeech: async (t, out) => fs.writeFileSync(out, wavOf(16000, [[0.2, true]])) });
  const b2 = await st2.route('begin', { url: urlOf({ code: st2.mint().code }) });
  assert.equal(b2.ok, false);
  assert.deepEqual(b2.error, { code: 'VB_CABLE_MISSING', message: 'VB-CABLE is not installed', hint: 'Install VB-CABLE' });
  await assert.rejects(st2.route('speak', { url: urlOf({ test: b2.test }) }), (e) => e.status === 409 && e.hint === 'Install VB-CABLE');
  const f = await st2.route('finish', { url: urlOf({ test: b2.test }) });
  assert.equal(f.pass, false);
  assert.ok(!broken.log.includes('release'), 'nothing to release');
});

test('self-test routes on a real DaemonServer: no token needed, code-guarded, raw WAV upload, the page is served', async () => {
  const srv = await startServerWithSelfTest(fakeBridge());
  try {
    const { base, st, token } = srv;
    const page = await fetch(`${base}/calls-audio-test.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await page.text(), /calls-audio-test\.js/);
    assert.equal((await fetch(`${base}/calls-audio-test.js`)).status, 200);

    const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', body, headers });
    assert.equal((await post('/api/calls/audio-test/begin?code=0000')).status, 403);
    const { code } = st.mint();
    const r = await post(`/api/calls/audio-test/begin?code=${code}`);
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.ok, true);
    const bad = await post(`/api/calls/audio-test/speak?test=${b.test}`, undefined, { Origin: 'http://evil.example' });
    assert.equal(bad.status, 403, 'cross-origin requests are refused by the server');
    const up = await post(`/api/calls/audio-test/upload?test=${b.test}`, wavOf(16000, [[0.5, true]]), { 'Content-Type': 'audio/wav' });
    assert.equal(up.status, 200);
    assert.equal((await up.json()).verified, 'level');
    const fin = await post(`/api/calls/audio-test/finish?test=${b.test}`);
    assert.equal((await fin.json()).released, true);
    assert.equal(typeof token, 'string');
  } finally {
    await srv.close();
  }
});

async function startServerWithSelfTest(bridge, opts = {}) {
  const { createServer } = require('../src/daemon/server');
  const { Hub } = require('../src/daemon/hub');
  const { QuestionBroker } = require('../src/daemon/questions');
  const { Bridge } = require('../src/daemon/bridge');
  const configMod = require('../src/shared/config');
  const config = configMod.load();
  config.port = 0;
  const hub = new Hub();
  const token = crypto.randomBytes(16).toString('hex');
  const permissions = { pending: () => [], resolve() {}, denyAll() {}, on() {}, list: () => [] };
  const server = createServer({ hub, session: null, permissions, questions: new QuestionBroker({ hub }), bridge: new Bridge({ hub }), config, token, instanceId: 'calls-audio', version: '0.0.0' });
  const st = new AudioSelfTest({
    bridge,
    tmpDir: path.join(TMP, `srv-${(tmpN += 1)}`),
    resultFile: tmpFile('srv.json'),
    recordLeadMs: 5,
    renderSpeech: async (t, out) => fs.writeFileSync(out, wavOf(16000, [[0.6, true]])),
    ...opts,
  });
  // What routes-calls.js does with SELF_TEST_ROUTES.
  for (const r of ab.SELF_TEST_ROUTES) server.routes.set(`${r.method} ${r.path}`, { fn: (ctx) => st.route(r.step, ctx), noAuth: true, raw: Boolean(r.raw) });
  const port = await server.listen(0);
  return { base: `http://127.0.0.1:${port}`, st, token, server, close: () => server.close() };
}

test('doctorChecks: rows in the doctor format, a 1 s capture probe, the last self-test', async () => {
  const pulse = new FakePulse();
  const b = linuxBridge(pulse);
  b.spawnFn = () => fakeParec(16000 * 2);
  const resultFile = tmpFile('doc.json');
  let rows = await ab.doctorChecks({ bridge: b, resultFile, record: true, tmpDir: path.join(TMP, 'doc') });
  assert.deepEqual(rows.map((r) => r.id), ['calls-audio', 'calls-audio-default', 'calls-audio-capture', 'calls-audio-selftest']);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['critical', 'detail', 'fix', 'id', 'label', 'notes', 'status']);
    assert.equal(r.critical, false);
  }
  assert.equal(rows[0].status, 'ok');
  assert.match(rows[0].detail, /virtual microphone anywhere_mic - pulseaudio 16\.1/);
  assert.match(rows[1].detail, /alsa_input/);
  assert.equal(rows[2].status, 'ok', rows[2].detail);
  assert.match(rows[2].detail, /1 s recorded/);
  assert.ok(!pulse.modules.some((m) => ab.ourModuleRole(m)), 'the probe removed the devices it set up');
  assert.equal(rows[3].status, 'warn');
  assert.match(rows[3].fix, /anywhere calls test-audio/);

  fs.writeFileSync(resultFile, JSON.stringify({ at: '2026-10-18T14:05:00.000Z', pass: false, mic: { pass: true, verified: 'transcript' }, capture: { pass: false, transcript: 'hello' } }));
  rows = await ab.doctorChecks({ bridge: b, resultFile });
  const last = rows.find((r) => r.id === 'calls-audio-selftest');
  assert.equal(last.status, 'warn');
  assert.match(last.detail, /2026-10-18 14:05: microphone pass, capture fail \(heard "hello"\)/);

  pulse.down = true;
  rows = await ab.doctorChecks({ bridge: linuxBridge(pulse), resultFile });
  assert.equal(rows[0].status, 'fail');
  assert.match(rows[0].fix, /pipewire-pulse/);
});

/** A parec stand-in that writes `bytes` of a tone and stays open until killed. */
function fakeParec(bytes) {
  const { EventEmitter } = require('events');
  const { PassThrough } = require('stream');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    setImmediate(() => child.emit('close', null, 'SIGTERM'));
  };
  setImmediate(() => {
    const pcm = Buffer.alloc(bytes);
    for (let i = 0; i < bytes / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 5) * 3000), i * 2);
    child.stdout.write(pcm);
  });
  return child;
}

// ------------------------------------------------------------------------------------------------ win32 driver

const win32 = require('../src/os/win32');
const FAKE_HOST_SRC = `
const readline = require('readline');
const fs = require('fs');
const rl = readline.createInterface({ input: process.stdin });
const CAP = { flow: 'capture', console: { id: '${USER_MIC}', name: 'Mic' }, multimedia: { id: '${USER_MIC}', name: 'Mic' }, communications: null,
  devices: [{ id: '${USER_MIC}', name: 'Mic' }, { id: '${CABLE_OUT}', name: 'CABLE Output (VB-Audio Virtual Cable)' }] };
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, line + '\\n');
  let result;
  switch (req.cmd) {
    case 'ping': result = { pong: true, protocol: 1, windows: true, native: true, pid: process.pid }; break;
    case 'audioDefaultGet': result = req.args.flow === 'all' ? { capture: CAP, render: { flow: 'render', console: null, devices: { id: '${CABLE_IN}', name: 'CABLE Input' } } } : CAP; break;
    case 'audioDefaultSet': result = { ok: true, id: req.args.id || '${CABLE_OUT}', name: 'CABLE Output', flow: req.args.flow, roles: req.args.roles, skipped: [] }; break;
    case 'toastTexts': result = { toasts: { process: 'ShellExperienceHost', pid: 42, className: 'Windows.UI.Core.CoreWindow', name: 'New notification',
      texts: ['Google Chrome', 'Ankit Sharma', 'cliq.zoho.com', 'Incoming audio call'], bounds: { x: 1500, y: 800, width: 364, height: 120 } }, ms: 12 }; break;
    case 'desktopPath': result = { path: 'C:\\\\Users\\\\me\\\\OneDrive\\\\Desktop', exists: true, registry: 'C:\\\\Users\\\\me\\\\OneDrive\\\\Desktop', oneDrive: 'C:\\\\Users\\\\me\\\\OneDrive', userProfile: 'C:\\\\Users\\\\me' }; break;
    default: process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: { message: 'unknown', code: 'UNKNOWN_COMMAND' } }) + '\\n'); return;
  }
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, result }) + '\\n');
});
`;

test('win32 driver: audioDefaultGet/Set, toastTexts and desktopPath requests and normalized results', async () => {
  const script = tmpFile('fake-audio-host.js');
  fs.writeFileSync(script, FAKE_HOST_SRC);
  const logFile = tmpFile('fake-audio-host.log');
  const env = { ...process.env, ANYWHERE_PS_EXE: process.execPath, ANYWHERE_PS_ARGS: JSON.stringify([script]), FAKE_LOG: logFile };
  const d = await win32.createDriver({ wsl: false, env });
  const dw = await win32.createDriver({ wsl: true, env });
  try {
    const cap = await d.audioDefaultGet('capture');
    assert.equal(cap.console.id, USER_MIC);
    assert.equal(cap.communications, null);
    assert.equal(cap.devices.length, 2);
    const all = await d.audioDefaultGet({ flow: 'all' });
    assert.deepEqual(all.render.devices, [{ id: CABLE_IN, name: 'CABLE Input' }], 'a single device (unwrapped by ConvertTo-Json) is still a list');
    await assert.rejects(d.audioDefaultGet('speakers'), (e) => e.code === 'BAD_ARGS');

    const set = await d.audioDefaultSet({ id: CABLE_OUT, roles: ['console', 'communications'], onlyIf: USER_MIC });
    assert.deepEqual(set, { ok: true, id: CABLE_OUT, name: 'CABLE Output', flow: 'capture', roles: ['console', 'communications'], skipped: [] });
    await d.audioDefaultSet({ name: 'CABLE Output' });
    await assert.rejects(d.audioDefaultSet({ id: 'C:\\evil' }), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(d.audioDefaultSet({ id: CABLE_OUT, roles: ['everything'] }), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(d.audioDefaultSet({ id: CABLE_OUT, onlyIf: 'x' }), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(d.audioDefaultSet({}), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(d.audioDefaultSet({ id: CABLE_OUT, flow: 'all' }), (e) => e.code === 'BAD_ARGS');

    const toasts = await d.toastTexts({ budgetMs: 999999, processes: ['ShellExperienceHost', 'ms-teams'] });
    assert.deepEqual(toasts, [{ process: 'ShellExperienceHost', pid: 42, className: 'Windows.UI.Core.CoreWindow', name: 'New notification', texts: ['Google Chrome', 'Ankit Sharma', 'cliq.zoho.com', 'Incoming audio call'], bounds: { x: 1500, y: 800, width: 364, height: 120 } }]);
    await assert.rejects(d.toastTexts({ processes: [] }), (e) => e.code === 'BAD_ARGS');

    const desk = await d.desktopPath();
    assert.equal(desk.path, 'C:\\Users\\me\\OneDrive\\Desktop');
    assert.equal(desk.exists, true);
    assert.equal(desk.oneDrive, 'C:\\Users\\me\\OneDrive');
    assert.equal('wslPath' in desk, false);
    assert.equal((await dw.desktopPath()).wslPath, '/mnt/c/Users/me/OneDrive/Desktop');

    const reqs = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.cmd !== 'ping');
    const byCmd = (c) => reqs.filter((r) => r.cmd === c).map((r) => r.args);
    assert.deepEqual(byCmd('audioDefaultSet')[0], { flow: 'capture', roles: ['console', 'communications'], id: CABLE_OUT, onlyIf: USER_MIC });
    assert.deepEqual(byCmd('audioDefaultSet')[1], { flow: 'capture', roles: ['console', 'multimedia', 'communications'], name: 'CABLE Output' });
    assert.deepEqual(byCmd('toastTexts')[0], { budgetMs: 10000, maxNodes: 400, processes: ['ShellExperienceHost', 'ms-teams'] });

    // The bridge drives the real driver object.
    const b = new AudioBridge({ platformInfo: { platform: 'win32' }, psHost: d, config: cfgOf(), stateFile: tmpFile('drv.json') });
    const c = await b.check();
    assert.equal(c.ready, true, JSON.stringify(c.issues));
    assert.equal(c.mode, 'virtual');
    const def = await b.readDefaultInput();
    assert.deepEqual(def, { name: 'Mic', id: USER_MIC, communications: null, via: 'IPolicyConfig' });
  } finally {
    await d.close();
    await dw.close();
  }
});

const PWSH = (() => {
  for (const p of ['/usr/local/bin/pwsh', '/usr/bin/pwsh', '/opt/microsoft/powershell/7/pwsh']) if (fs.existsSync(p)) return p;
  return null;
})();

test('pwsh: the host parses, the Core Audio bridge compiles as C# 5, and the new ops answer off Windows', { skip: !PWSH && 'pwsh not installed' }, () => {
  const r = spawnSync(
    PWSH,
    [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop";$t=$null;$e=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:HOST_PS1,[ref]$t,[ref]$e);"errors=" + $e.Count;' +
        '$a=$ast.Find({param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq "`$AudioSource"},$true);' +
        'Add-Type -TypeDefinition $a.Right.Expression.Value -CompilerOptions "-langversion:5"; "type=" + [AnywhereAudio].FullName + " " + ([AnywhereAudio].GetMethod("SetDefault") -ne $null)',
    ],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, HOST_PS1: win32.HOST_SCRIPT } },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /errors=0/);
  assert.match(r.stdout, /type=AnywhereAudio True/);

  const lines = ['audioDefaultGet', 'audioDefaultSet', 'toastTexts', 'desktopPath'].map((cmd, i) => JSON.stringify({ id: i + 1, cmd, args: cmd === 'audioDefaultSet' ? { id: CABLE_OUT } : {} }));
  const h = spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', win32.HOST_SCRIPT], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 120000 });
  const out = h.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(out.slice(0, 3).map((o) => [o.id, o.ok, o.error && o.error.code]), [[1, false, 'UNSUPPORTED'], [2, false, 'UNSUPPORTED'], [3, false, 'UNSUPPORTED']]);
  assert.equal(out[3].ok, true);
  assert.deepEqual(Object.keys(out[3].result), ['path', 'exists', 'registry', 'oneDrive', 'userProfile']);
});

test('win32-host.ps1 stays pure ASCII', () => {
  const buf = fs.readFileSync(win32.HOST_SCRIPT);
  assert.equal(buf.findIndex((b) => b > 0x7f), -1);
});

// ------------------------------------------------------------------------------------------------ audio_io.py

const PYTHON = (() => {
  for (const cmd of [process.env.ANYWHERE_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const r = spawnSync(cmd, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    const m = /^(\d+)\.(\d+)/.exec(String(r.stdout || '').trim());
    if (r.status === 0 && m && (Number(m[1]) > 3 || Number(m[2]) >= 9)) return cmd;
  }
  return null;
})();
const PY_SKIP = PYTHON ? false : 'no python3 on this machine';
const SIDECAR = path.join(__dirname, '..', 'src', 'voice', 'clone', 'sidecar.py');
const models = require('../src/voice/clone/models');
const { SidecarClient } = require('../src/voice/clone/client');

function makeHome() {
  const state = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'state-')));
  for (const d of ['run/voice-tmp', 'voice/clone/profiles', 'voice/clone/sessions', 'voice/clone-models']) fs.mkdirSync(path.join(state, d), { recursive: true, mode: 0o700 });
  return { state, models: path.join(state, 'voice', 'clone-models'), tmp: path.join(state, 'run', 'voice-tmp') };
}

/** A consent-verified test profile and fake model files, so the fake engine can "speak" (tests only). */
async function loadFakeVoice(c, home) {
  for (const id of models.ENGINES.pocket.assets) {
    const p = models.assetPaths(id, home.models);
    for (const [role, f] of Object.entries(p.files)) {
      if (role === 'data_dir') fs.mkdirSync(f, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, 'x');
      }
    }
  }
  await c.request('tts.load', models.ttsLoadParams('pocket', home.models, { threads: 1 }));
  const dir = path.join(home.state, 'voice', 'clone', 'profiles', 'default');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const ref = wavOf(24000, [[12, true]]);
  fs.writeFileSync(path.join(dir, 'reference.wav'), ref, { mode: 0o600 });
  const manifest = {
    version: 1,
    engine: 'pocket',
    consent: { verified: true, verifiedAt: new Date().toISOString() },
    reference: { file: 'reference.wav', seconds: 12, sha256: crypto.createHash('sha256').update(ref).digest('hex'), text: 'x' },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  await c.request('tts.setVoice', { profileDir: dir });
}

async function startSidecar(home, { env = {} } = {}) {
  const c = new SidecarClient({
    python: PYTHON,
    script: SIDECAR,
    args: ['--state', home.state, '--models', home.models],
    env: { ...process.env, ANYWHERE_CLONE_FAKE: '1', ANYWHERE_CLONE_NO_AUDIO_IO: '', ANYWHERE_CLONE_FAKE_TRANSCRIPT: 'please assign me a ticket', ...env },
    startTimeoutMs: 15000,
    requestTimeoutMs: 20000,
  });
  const events = [];
  c.on('event', (e) => events.push({ ...e, at: Date.now() }));
  const hello = await c.start();
  return { c, hello, events };
}

const evs = (events, name) => events.filter((e) => e.event === name);

test('audio_io: loads as the sidecar plug-in and lists its ops; test backends only in fake mode', { skip: PY_SKIP }, async () => {
  const home = makeHome();
  const { c, hello } = await startSidecar(home);
  try {
    assert.equal(hello.audioIo.available, true, JSON.stringify(hello.audioIo));
    assert.deepEqual(hello.audioIo.ops, ['audio.defaultInput', 'audio.devices', 'audio.play', 'audio.start', 'audio.status', 'audio.stop', 'record.start', 'record.stop', 'tts.say']);
    const d = await c.request('audio.devices');
    assert.equal(d.platform, process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux');
    for (const k of ['inputs', 'outputs', 'loopbacks']) assert.ok(Array.isArray(d[k]));
    const st = await c.request('audio.status');
    assert.deepEqual(st, { session: null, player: { backend: null, playing: null, queued: 0, active: false }, recording: false });
    await assert.rejects(c.request('tts.say', { text: 'Hello there.', utteranceId: 'u1' }), (e) => e.code === 'PROFILE_INVALID', 'no consented voice loaded');
    await assert.rejects(c.request('audio.start', { capture: { backend: 'alsa' } }), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(c.request('audio.start', { capture: { backend: 'pulse', device: 'x; rm -rf /' } }), (e) => e.code === 'BAD_REQUEST');
    // Files outside the state folder are never played or recorded.
    const outside = tmpFile('outside.wav');
    fs.writeFileSync(outside, wavOf(16000, [[0.2, true]]));
    await assert.rejects(c.request('audio.play', { wav: outside, playback: { backend: 'file', device: path.join(home.tmp, 'o.wav') } }), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(c.request('record.start', { backend: 'file', device: path.join(home.tmp, 'x.wav'), out: outside, seconds: 1 }), (e) => e.code === 'BAD_REQUEST');
    assert.deepEqual(await c.request('audio.stop'), { stopped: false, session: null });
  } finally {
    await c.stop();
  }

  // Outside fake mode the file backends do not exist (the runtime is absent here, the plug-in still loads).
  const real = await startSidecar(home, { env: { ANYWHERE_CLONE_FAKE: '' } });
  try {
    const wav = path.join(home.tmp, 'in.wav');
    fs.writeFileSync(wav, wavOf(16000, [[0.5, true]]));
    await assert.rejects(real.c.request('record.start', { backend: 'file', device: wav, out: path.join(home.tmp, 'rec.wav'), seconds: 0.2, wait: true }), (e) => e.code === 'BAD_REQUEST' && /tests only/.test(e.message));
  } finally {
    await real.c.stop();
  }
});

test('audio_io: capture → VAD → recognition events, levels, and recording to a WAV', { skip: PY_SKIP }, async () => {
  const home = makeHome();
  const { c, events } = await startSidecar(home);
  try {
    const input = path.join(home.tmp, 'caller.wav');
    fs.writeFileSync(input, wavOf(16000, [[0.4, false], [1.0, true], [1.0, false], [0.7, true], [1.2, false]]));
    const r = await c.request('audio.start', { capture: { backend: 'file', device: input, realtime: false }, vad: { minSilenceMs: 600, minSpeechMs: 250 }, asr: true, levelIntervalMs: 200 });
    assert.equal(r.started, true);
    assert.equal(r.vad, 'energy', 'fake mode has no Silero');
    assert.ok(await until(() => evs(events, 'asr.final').length >= 2, 8000), JSON.stringify(events.slice(-5)));
    const starts = evs(events, 'vad.start');
    const ends = evs(events, 'vad.end');
    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2);
    assert.ok(Math.abs(starts[0].t - 0.62) < 0.1, `first start at ${starts[0].t}`);
    assert.ok(Math.abs(ends[0].ms - 1300) < 60, `first segment ${ends[0].ms} ms (200 ms pre-roll + 1 s + 100 ms tail)`);
    assert.ok(Math.abs(ends[0].t - 2.0) < 0.1, `end detected after 600 ms of silence (${ends[0].t})`);
    const finals = evs(events, 'asr.final');
    assert.equal(finals[0].text, 'please assign me a ticket');
    assert.ok(finals[0].t0 < finals[0].t1 && finals[0].t1 <= finals[1].t0);
    assert.ok(Math.abs(finals[0].t0 - 0.2) < 0.06 && Math.abs(finals[0].t1 - 1.5) < 0.06, `${finals[0].t0}-${finals[0].t1}`);
    assert.ok(evs(events, 'level').some((e) => e.db > -20) && evs(events, 'level').some((e) => e.db === -120));
    const st = await c.request('audio.status');
    assert.equal(st.session.vad, 'energy');
    assert.equal(st.session.stats.finals, 2);
    const t0 = Date.now();
    const stop = await c.request('audio.stop');
    assert.ok(Date.now() - t0 < 500, 'audio.stop answers at once');
    assert.equal(stop.stopped, true);

    // record.start with wait: a 16 kHz WAV of the capture.
    const out = path.join(home.tmp, 'probe.wav');
    const rec = await c.request('record.start', { backend: 'file', device: input, realtime: false, out, seconds: 1.5, wait: true });
    assert.equal(rec.out, out);
    assert.equal(rec.seconds, 1.5);
    assert.ok(rec.peak > -11 && rec.peak < -10, `peak ${rec.peak}`);
    const lv = ab.wavLevel(fs.readFileSync(out));
    assert.equal(lv.rate, 16000);
    assert.equal((fs.statSync(out).mode & 0o777).toString(8), '600');
    // record.start without wait + record.stop; a second recording is refused while one runs.
    const out2 = path.join(home.tmp, 'probe2.wav');
    assert.deepEqual(await c.request('record.start', { backend: 'file', device: input, out: out2 }), { recording: true, out: out2, seconds: null });
    await assert.rejects(c.request('record.start', { backend: 'file', device: input, out: out2 }), (e) => e.code === 'BAD_REQUEST');
    await sleep(300);
    const r2 = await c.request('record.stop');
    assert.ok(r2.seconds > 0.1 && r2.seconds < 2, `${r2.seconds}`);
    assert.ok(evs(events, 'record.done').length >= 2);
  } finally {
    await c.stop();
  }
});

test('audio_io: tts.say speaks clause by clause in the enrolled voice; queue, playedChars, tts.stop, WAV playback', { skip: PY_SKIP }, async () => {
  const home = makeHome();
  const { c, events } = await startSidecar(home);
  try {
    await loadFakeVoice(c, home);
    const outFile = path.join(home.tmp, 'played.wav');
    const pb = { backend: 'file', device: outFile, realtime: false };
    const text = 'Sure, let me check that. I have assigned you the ticket.';
    const r1 = await c.request('tts.say', { text, utteranceId: 'a1', playback: pb });
    assert.deepEqual(r1, { queued: true, utteranceId: 'a1', position: 1 });
    await c.request('tts.say', { text: 'Anything else?', utteranceId: 'a2' });
    assert.ok(await until(() => evs(events, 'playback.end').length >= 2, 5000));
    const ends = evs(events, 'playback.end');
    assert.deepEqual(ends.map((e) => e.utteranceId), ['a1', 'a2'], 'in order');
    assert.equal(ends[0].interrupted, false);
    assert.equal(ends[0].started, true);
    assert.equal(ends[0].playedChars, text.length);
    assert.equal(ends[0].chars, text.length);
    assert.deepEqual(evs(events, 'playback.start').map((e) => [e.utteranceId, e.rate]), [['a1', 24000], ['a2', 24000]]);
    // The fake voice is 0.06 s per character of each clause.
    const secs = ab.wavLevel(fs.readFileSync(outFile)).seconds;
    const expect = ['Sure, let me check that.', 'I have assigned you the ticket.', 'Anything else?'].reduce((n, s) => n + Math.max(0.3, 0.06 * s.length), 0);
    assert.ok(Math.abs(secs - expect) < 0.05, `${secs} vs ${expect}`);

    // A pre-rendered WAV (filler) through audio.play, waiting for the end.
    const filler = path.join(home.tmp, 'filler.wav');
    fs.writeFileSync(filler, wavOf(22050, [[0.5, true]]));
    const p = await c.request('audio.play', { wav: filler, text: 'Okay, one moment.', utteranceId: 'f1', wait: true });
    assert.equal(p.played, true);
    assert.equal(p.playedChars, 'Okay, one moment.'.length);
    assert.equal(p.playedMs, 500);

    // tts.stop in real time: the end event comes at once, marked interrupted, with a partial playedChars.
    const rt = { backend: 'file', device: path.join(home.tmp, 'rt.wav'), realtime: true };
    const long = 'This is a long answer that keeps going for quite a while, so that it can be stopped in the middle of speaking.';
    await c.request('tts.say', { text: long, utteranceId: 'L', playback: rt });
    await c.request('tts.say', { text: 'Queued after it.', utteranceId: 'Q' });
    assert.ok(await until(() => evs(events, 'playback.start').some((e) => e.utteranceId === 'L'), 3000));
    await sleep(700);
    const t0 = Date.now();
    await c.request('tts.stop');
    assert.ok(await until(() => evs(events, 'playback.end').some((e) => e.utteranceId === 'L'), 1000));
    const endL = evs(events, 'playback.end').find((e) => e.utteranceId === 'L');
    assert.ok(endL.at - t0 < 300, `stopped within ${endL.at - t0} ms`);
    assert.equal(endL.interrupted, true);
    // About 0.7-1 s heard of the first clause (12 words, 0.06 s per character): a few characters, not most of it.
    assert.ok(endL.playedChars >= 8 && endL.playedChars <= 22, `playedChars ${endL.playedChars}`);
    assert.ok(endL.playedMs >= 500 && endL.playedMs < 1200, `playedMs ${endL.playedMs}`);
    const endQ = await until(() => evs(events, 'playback.end').find((e) => e.utteranceId === 'Q'), 1000);
    assert.equal(endQ.started, false, 'the queued one never started');
    assert.equal(endQ.interrupted, true);
    await sleep(200);
    assert.equal((await c.request('audio.status')).player.active, false);
  } finally {
    await c.stop();
  }
});

test('audio_io: the caller talking over us stops our playback (barge-in); half duplex ignores the capture while we speak', { skip: PY_SKIP }, async () => {
  const home = makeHome();
  const { c, events } = await startSidecar(home);
  try {
    await loadFakeVoice(c, home);
    const caller = path.join(home.tmp, 'caller.wav');
    fs.writeFileSync(caller, wavOf(16000, [[0.8, false], [1.5, true], [2, false]]));
    const long = 'Let me read you the whole description of the ticket, which is rather long and detailed, in full right now.';
    await c.request('audio.start', {
      capture: { backend: 'file', device: caller, realtime: true },
      playback: { backend: 'file', device: path.join(home.tmp, 'out.wav'), realtime: true },
      vad: { minSilenceMs: 600, minSpeechMs: 250 },
      bargeIn: { minSpeechMs: 400, stopPlayback: true },
      halfDuplex: false,
      levelIntervalMs: 0,
    });
    await c.request('tts.say', { text: long, utteranceId: 'B' });
    const barge = await until(() => evs(events, 'barge_in')[0], 4000);
    assert.ok(barge, JSON.stringify(events.map((e) => e.event)));
    assert.equal(barge.utteranceId, 'B');
    assert.ok(barge.t > 1.0 && barge.t < 1.6, `barge-in at ${barge.t}`);
    const end = await until(() => evs(events, 'playback.end').find((e) => e.utteranceId === 'B'), 1000);
    assert.equal(end.interrupted, true);
    // The caller spoke at 0.8 s and barge-in fired after 400 ms of speech: about 1.1-1.5 s of the 3.1 s first clause heard.
    assert.ok(end.playedChars >= 15 && end.playedChars <= 30, `${end.playedChars} of ${long.length}`);
    assert.ok(end.at - barge.at < 200, 'stopped right away');
    assert.ok(await until(() => evs(events, 'asr.final').length === 1, 3000), "the caller's words are still recognized");
    await c.request('audio.stop');

    // Speaker mode: our own voice is in the capture, so the capture is ignored while we speak (+ tail).
    events.length = 0;
    const room = path.join(home.tmp, 'room.wav');
    fs.writeFileSync(room, wavOf(16000, [[0.3, false], [1.0, true], [2.2, false], [0.8, true], [1.2, false]]));
    await c.request('audio.start', {
      capture: { backend: 'file', device: room, realtime: true },
      playback: { backend: 'file', device: path.join(home.tmp, 'out2.wav'), realtime: true },
      vad: { minSilenceMs: 500, minSpeechMs: 250 },
      bargeIn: { minSpeechMs: 400 },
      halfDuplex: true,
      tailMs: 300,
      levelIntervalMs: 0,
    });
    await c.request('tts.say', { text: 'Hi, this is the assistant.', utteranceId: 'H' }); // 0.06 s/char: about 1.6 s
    assert.ok(await until(() => evs(events, 'vad.end').length >= 1, 6000));
    await sleep(300);
    assert.equal(evs(events, 'barge_in').length, 0, 'no barge-in in half duplex');
    const starts = evs(events, 'vad.start');
    assert.equal(starts.length, 1, JSON.stringify(starts));
    assert.ok(starts[0].t > 3.4, `only the speech after our turn counts (${starts[0].t})`);
    const status = await c.request('audio.status');
    assert.ok(status.session.stats.dropped > 50);
  } finally {
    await c.stop();
  }
});

// ------------------------------------------------------------------------------------------------ the page

const UI = path.join(__dirname, '..', 'src', 'ui');
const UI_TMP = path.join(TMP, 'ui');
fs.mkdirSync(UI_TMP, { recursive: true });
fs.writeFileSync(path.join(UI_TMP, 'package.json'), '{"type":"module"}\n');
for (const f of fs.readdirSync(UI)) if (f.endsWith('.js')) fs.copyFileSync(path.join(UI, f), path.join(UI_TMP, f));
const loadPage = () => import(pathToFileURL(path.join(UI_TMP, 'calls-audio-test.js')).href);

test('page: runAudioTest drives begin → speak → upload → capture → result → finish', async () => {
  const { runAudioTest, describeVerdict, base64ToBytes } = await loadPage();
  assert.deepEqual(Array.from(base64ToBytes(Buffer.from([1, 2, 255]).toString('base64'))), [1, 2, 255]);
  assert.equal(describeVerdict({ pass: true, verified: 'transcript', transcript: 'testing one two three' }), 'heard "testing one two three"');
  assert.match(describeVerdict({ pass: true, verified: 'level', transcript: null, level: { rmsDbfs: -20 } }), /transcription unavailable/);
  const calls = [];
  const steps = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url, 'http://127.0.0.1');
    const step = u.pathname.split('/').pop();
    calls.push([step, Object.fromEntries(u.searchParams), init.body ? init.body.size || init.body.length : 0, init.headers && init.headers['Content-Type']]);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (step === 'begin') return json(200, { ok: true, test: 'a'.repeat(32), mode: 'virtual', issues: [], clip: { mime: 'audio/wav', base64: wavOf(16000, [[0.2, true]]).toString('base64') } });
    if (step === 'speak') return json(200, { ok: true });
    if (step === 'upload') return json(200, { ok: true, pass: true, verified: 'transcript', transcript: 'testing one two three claude anywhere' });
    if (step === 'capture') return json(200, { ok: true, recording: true });
    if (step === 'result') return json(200, { ok: true, pass: false, verified: 'transcript', transcript: '' });
    if (step === 'finish') return json(200, { ok: true, released: true });
    return json(404, { error: 'no' });
  };
  let played = 0;
  const ctx = {
    state: 'running',
    destination: {},
    createConstantSource: () => ({ offset: { value: 1 }, connect() {}, start() {}, stop() {} }),
    decodeAudioData: async (buf) => ({ duration: 0.05, bytes: buf.byteLength }),
    createBufferSource: () => {
      const src = { connect() {}, start() {
        played += 1;
        setTimeout(() => src.onended && src.onended(), 5);
      } };
      return src;
    },
    close: async () => {},
  };
  const r = await runAudioTest({
    code: 'b'.repeat(32),
    fetch: fetchFn,
    wait: () => Promise.resolve(),
    createAudioContext: () => ctx,
    createRecorder: () => ({ start: async () => {}, stop: async () => ({ size: 3244 }) }),
    onStep: (s, state, detail) => steps.push([s, state, detail]),
  });
  assert.deepEqual(calls.map((c) => c[0]), ['begin', 'speak', 'upload', 'capture', 'result', 'finish']);
  assert.deepEqual(calls[0][1], { code: 'b'.repeat(32) });
  assert.deepEqual(calls[2].slice(1), [{ test: 'a'.repeat(32) }, 3244, 'audio/wav']);
  assert.equal(played, 1);
  assert.equal(r.pass, false);
  assert.equal(r.mic.pass, true);
  const final = (s) => steps.filter((x) => x[0] === s).pop();
  assert.equal(final('route')[1], 'pass');
  assert.equal(final('mic')[1], 'pass');
  assert.equal(final('capture')[1], 'fail');
  assert.match(final('capture')[2], /did not hear this tab/);
  assert.equal(final('restore')[1], 'pass');

  // A bad link never reaches the daemon.
  calls.length = 0;
  const bad = await runAudioTest({ code: 'nope', fetch: fetchFn, createAudioContext: () => ctx });
  assert.equal(bad.pass, false);
  assert.equal(bad.error.status, 403);
  assert.equal(calls.length, 0);
});

function findChrome() {
  if (process.env.ANYWHERE_TEST_CHROME) return fs.existsSync(process.env.ANYWHERE_TEST_CHROME) ? process.env.ANYWHERE_TEST_CHROME : null;
  const c = [];
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) c.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'));
  } catch {
    /* not here */
  }
  if (process.platform === 'linux') {
    for (const n of ['chromium', 'chromium-browser', 'google-chrome']) {
      try {
        const p = execFileSync('which', [n], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (p) c.push(p);
      } catch {
        /* none */
      }
    }
  }
  return c.find((x) => fs.existsSync(x)) || null;
}

test('page in headless Chromium: fake media devices, a real DaemonServer, the whole protocol', async (t) => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chromium found (set ANYWHERE_TEST_CHROME)');
  if (typeof globalThis.WebSocket !== 'function') return t.skip('needs a global WebSocket (Node >= 22)');
  const { launchChrome } = require('./fixtures/chrome-launch');
  const bridge = fakeBridge();
  const uploads = [];
  const srv = await startServerWithSelfTest(bridge, {
    transcribe: async (f) => {
      if (/mic-recording/.test(f)) {
        uploads.push(ab.wavLevel(fs.readFileSync(f)));
        return 'testing one two three can you hear the microphone';
      }
      return 'four five six the sound from this tab is working';
    },
  });
  const browser = await launchChrome(chrome, {
    prefix: 'anywhere-chrome-callsaudio-',
    extraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const { code } = srv.st.mint();
    const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
    const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    const problems = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.text);
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const i = (id += 1);
        pending.set(i, resolve);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result.value;
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `${srv.base}/calls-audio-test.html?code=${code}&auto=1` });
    const done = await until(() => evaluate('document.documentElement.dataset.result || ""'), 40000, 200);
    const result = await evaluate('JSON.stringify(window.__anywhereAudioTest || null)');
    ws.close();
    assert.equal(done, 'pass', `${result} ${problems.join(' | ')}`);
    const r = JSON.parse(result);
    assert.equal(r.mic.transcript, 'testing one two three can you hear the microphone');
    assert.equal(r.capture.pass, true);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].rate, 16000, 'the page uploads 16 kHz WAV');
    assert.ok(uploads[0].seconds > 0.3, `recorded ${uploads[0].seconds} s (after trimming silence)`);
    const steps = bridge.log.map((x) => (Array.isArray(x) ? x[0] : x));
    assert.deepEqual(steps, ['check', 'engage', 'play', 'sync', 'record', 'release']);
    assert.deepEqual(problems, []);
    assert.equal(srv.st.lastResult().pass, true);
  } finally {
    await browser.cleanup();
    await srv.close();
  }
});
