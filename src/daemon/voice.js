'use strict';

/**
 * Server-side voice for the dialog: speech-to-text (for browsers or shells
 * without the Web Speech API) and text-to-speech through the OS.
 *
 * STT providers: any OpenAI-compatible /audio/transcriptions endpoint (Groq,
 * OpenAI, or a custom base URL such as a local faster-whisper server) or a
 * local whisper.cpp binary with a ggml model.
 * TTS: `say` on macOS, System.Speech (SAPI) through Windows PowerShell on
 * Windows and WSL, and spd-say / espeak-ng / espeak / festival on Linux.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const proc = require('../shared/proc');
const paths = require('../shared/paths');
const platformMod = require('../shared/platform');
const { stripMarkdownForSpeech, truncate, safeJsonParse } = require('../shared/util');
const { createLogger, redact } = require('../shared/log');

const log = createLogger('voice');

const CAPS_TTL_MS = 30000;
// taskkill.exe path used from WSL when interop does not put it on PATH (mirrors src/os/win32.js).
const WSL_TASKKILL = '/mnt/c/Windows/System32/taskkill.exe';
const STT_TIMEOUT_MS = 60000;
const FFMPEG_TIMEOUT_MS = 60000;
const WHISPER_TIMEOUT_MS = 180000;
const SPEAK_TIMEOUT_MS = 300000;
const MAX_SPEAK_CHARS = 1500;

const HTTP_PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', envKey: 'OPENAI_API_KEY', label: 'OpenAI' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', envKey: 'GROQ_API_KEY', label: 'Groq' },
};
const WHISPER_BINARIES = ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];
const LINUX_TTS = ['spd-say', 'espeak-ng', 'espeak', 'festival'];

const STT_SETUP_HINT =
  'Set GROQ_API_KEY (free tier) or OPENAI_API_KEY in the environment, add an API key in Settings > Voice, ' +
  'or install whisper.cpp (macOS: brew install whisper-cpp) and put a ggml model (e.g. ggml-base.en.bin) in the models folder.';

function voiceError(status, message, hint) {
  const e = new Error(message);
  e.status = status;
  if (hint) e.hint = hint;
  return e;
}

/**
 * Spawn a command and collect its output. Never throws. Supports an
 * AbortSignal (the child is killed and `aborted` is set) and a timeout.
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean, error:Error|null}>}
 */
function defaultRunner(cmd, args = [], { timeoutMs = 15000, input, signal, env, cwd, onStdout } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        code: res.code ?? null,
        signal: res.signal ?? null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        aborted,
        error: res.error || null,
      });
    };
    const kill = () => {
      if (!child) return;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const t = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 1500);
      if (t.unref) t.unref();
    };
    if (signal && signal.aborted) {
      aborted = true;
      finish({});
      return;
    }
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ error: e });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen <= 16 * 1024 * 1024) out.push(d);
      if (typeof onStdout === 'function') {
        try {
          onStdout(d);
        } catch {
          /* a stdout observer must never break the run */
        }
      }
    });
    child.stderr.on('data', (d) => {
      errLen += d.length;
      if (errLen <= 1024 * 1024) err.push(d);
    });
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code, sig) => finish({ code, signal: sig }));
    child.stdin.on('error', () => {
      /* EPIPE when the child exits early */
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** 'en-US' → 'en'; '' / 'auto' → '' (let the provider detect). */
function languageCode(lang) {
  const m = /^([a-z]{2})(?:$|[-_])/i.exec(String(lang || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function baseContentType(contentType) {
  return (
    String(contentType || 'audio/wav')
      .split(';')[0]
      .trim()
      .toLowerCase() || 'audio/wav'
  );
}

/** File name the transcription API uses to detect the format. */
function audioFileName(contentType) {
  const t = baseContentType(contentType);
  if (/webm/.test(t)) return 'audio.webm';
  if (/ogg|opus/.test(t)) return 'audio.ogg';
  if (/mp4|m4a|aac/.test(t)) return 'audio.m4a';
  if (/mpeg|mp3/.test(t)) return 'audio.mp3';
  if (/flac/.test(t)) return 'audio.flac';
  return 'audio.wav';
}

/**
 * Read the format chunk of a RIFF/WAVE buffer.
 * @returns {{format:number, channels:number, sampleRate:number, bitsPerSample:number}|null}
 */
function parseWavHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= buf.length) {
      return {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Strip whisper.cpp markers like [BLANK_AUDIO] and join segment lines. */
function cleanTranscript(text) {
  return String(text || '')
    .replace(/\[[^\]\n]*\]/g, ' ')
    .replace(/\((?:music|silence|inaudible|applause|laughter|blank[_ ]audio|background noise)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cap speech at n characters, preferring a sentence or word boundary. */
function capSpeech(text, n = MAX_SPEAK_CHARS) {
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  if (sentence > n * 0.6) return cut.slice(0, sentence + 1).trim();
  const space = cut.lastIndexOf(' ');
  return (space > n * 0.6 ? cut.slice(0, space) : cut).trim();
}

function tail(s, n = 300) {
  const t = String(s || '')
    .trim()
    .replace(/\s+/g, ' ');
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(1));
  return s;
}

/**
 * Build the OS speech command for one utterance.
 * @param {{name:string, bin:string}} tts
 * @param {string} text already sanitized
 * @param {{rate?:number, voice?:string, language?:string}} opts
 * @returns {{cmd:string, args:string[], input?:string}}
 */
function buildTtsCommand(tts, text, { rate = 1, voice = '', language = '' } = {}) {
  const r = clamp(Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 1, 0.25, 4);
  const lang = languageCode(language);
  switch (tts.name) {
    case 'say': {
      const args = ['-r', String(Math.round(180 * r))];
      if (voice) args.push('-v', voice);
      return { cmd: tts.bin, args, input: text };
    }
    case 'sapi': {
      // SAPI rate is -10..10 where each step is roughly 3^(1/10) times faster.
      const sapiRate = clamp(Math.round((10 * Math.log(r)) / Math.log(3)), -10, 10);
      const lines = [
        "$ErrorActionPreference = 'Stop'",
        // Announce the Windows PID first so a stop from WSL can taskkill the real speaker (the
        // Linux-side process is only an interop relay there). Harmless on native Windows.
        "[Console]::Out.WriteLine('ANYWHERE_PID ' + $PID); [Console]::Out.Flush()",
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        `$s.Rate = ${sapiRate}`,
      ];
      if (voice) lines.push(`try { $s.SelectVoice('${String(voice).replace(/'/g, "''")}') } catch { }`);
      // Read stdin as raw UTF-8 bytes so any language survives the console code page.
      lines.push(
        '$in = [Console]::OpenStandardInput()',
        '$ms = New-Object System.IO.MemoryStream',
        '$in.CopyTo($ms)',
        '$t = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())',
        'if ($t.Trim()) { $s.Speak($t) }',
        '$s.Dispose()',
      );
      const script = lines.join('; ');
      return {
        cmd: tts.bin,
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        input: text,
        script,
      };
    }
    case 'spd-say': {
      const args = ['-w', '-r', String(clamp(Math.round((r - 1) * 100), -100, 100))];
      if (lang) args.push('-l', lang);
      if (voice) args.push('-y', voice);
      args.push('--', text);
      return { cmd: tts.bin, args };
    }
    case 'espeak-ng':
    case 'espeak': {
      const args = ['-s', String(clamp(Math.round(175 * r), 80, 500))];
      if (voice) args.push('-v', voice);
      else if (lang && lang !== 'en') args.push('-v', lang);
      args.push('--stdin');
      return { cmd: tts.bin, args, input: text };
    }
    case 'festival':
      return { cmd: tts.bin, args: ['--tts'], input: text };
    default:
      throw voiceError(500, `Unknown speech engine ${tts.name}`);
  }
}

// Engines that fail on a voice they do not have (SAPI ignores it, spd-say falls back itself).
const VOICE_CHECKED_ENGINES = new Set(['say', 'espeak-ng', 'espeak']);
// Voices that exist only in a browser (Chrome's "Google …", Edge's "… Online (Natural)").
const BROWSER_ONLY_VOICE = /^Google\b|\bOnline\b|\(online\)|\(Natural\)/i;

/**
 * `say -v ?` lines: "Alex                en_US    # Most people recognize me by my voice.".
 * @returns {{name:string, locale:string}[]}
 */
function parseSayVoices(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(line);
    if (m) out.push({ name: m[1].trim(), locale: m[2] });
  }
  return out;
}

/**
 * Server speech-to-text and text-to-speech for the dialog (POST /api/stt, /api/tts).
 * The runner, fetch, env, which and platformInfo can be injected for tests.
 */
class VoiceService {
  /**
   * @param {{config?:object, runner?:Function, fetch?:Function, env?:object, which?:(name:string)=>string|null,
   *   platformInfo?:object, now?:()=>number, tmpDir?:string, modelsDir?:string}} [opts]
   */
  constructor({ config, runner, fetch: fetchImpl, env, which, platformInfo, now, tmpDir, modelsDir } = {}) {
    this.config = config || {};
    this.runner = typeof runner === 'function' ? runner : defaultRunner;
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.env = env || process.env;
    this.which = typeof which === 'function' ? which : proc.which;
    this.platformInfo = platformInfo || platformMod.info();
    this.now = typeof now === 'function' ? now : Date.now;
    this.tmpDir = tmpDir || os.tmpdir();
    this.modelsDirOverride = modelsDir || null;
    this.cache = null;
    this.whisperProbe = new Map();
    this.localVoices = null; // `say -v ?`, read once when a voice must be replaced
    this.current = null;
    this.sttTimeoutMs = STT_TIMEOUT_MS;
  }

  /** @private */
  get voice() {
    const v = this.config && this.config.voice;
    return v && typeof v === 'object' ? v : {};
  }

  /** Apply a new config (settings changed in the dialog). */
  updateConfig(config) {
    this.config = config || {};
    this.cache = null;
  }

  /** @private */
  modelsDir() {
    if (this.modelsDirOverride) return this.modelsDirOverride;
    try {
      return paths.modelsDir();
    } catch (err) {
      log.debug(`models dir unavailable: ${err.message}`);
      return path.join(os.homedir(), '.claude-anywhere', 'models');
    }
  }

  /**
   * What the server can do, cached for 30 s.
   * @returns {Promise<{serverStt:boolean, sttProvider:string|null, serverTts:boolean, ttsProvider:string|null, sttHint?:string, ttsHint?:string}>}
   */
  async capabilities() {
    const { stt, tts } = await this.resolveAll();
    const out = {
      serverStt: Boolean(stt.name),
      sttProvider: stt.name || null,
      serverTts: Boolean(tts.name),
      ttsProvider: tts.name || null,
    };
    if (!stt.name && stt.hint) out.sttHint = stt.hint;
    if (!tts.name && tts.hint) out.ttsHint = tts.hint;
    return out;
  }

  /** @private resolve both providers (cached 30 s) */
  async resolveAll() {
    const t = this.now();
    if (this.cache && t - this.cache.at < CAPS_TTL_MS) return this.cache;
    let stt;
    let tts;
    try {
      stt = await this.resolveStt();
    } catch (err) {
      log.warn(`speech-to-text detection failed: ${err.message}`);
      stt = { name: null, hint: err.message };
    }
    try {
      tts = this.resolveTts();
    } catch (err) {
      log.warn(`text-to-speech detection failed: ${err.message}`);
      tts = { name: null, hint: err.message };
    }
    this.cache = { at: t, stt, tts };
    return this.cache;
  }

  /**
   * Pick the speech-to-text provider from config and environment.
   * @returns {Promise<{name:string|null, kind?:'http'|'whisper', baseUrl?:string, apiKey?:string, model?:string, bin?:string, hint?:string}>}
   */
  async resolveStt() {
    const v = this.voice;
    const env = this.env;
    const pref = String(v.sttProvider || 'auto')
      .toLowerCase()
      .trim();
    const known = (name, key) => ({
      name,
      kind: 'http',
      baseUrl: v.sttBaseUrl || HTTP_PROVIDERS[name].baseUrl,
      apiKey: key,
      model: v.sttModel || HTTP_PROVIDERS[name].model,
    });
    const custom = (key, baseUrl) => ({
      name: 'custom',
      kind: 'http',
      baseUrl,
      apiKey: key || '',
      model: v.sttModel || env.ANYWHERE_STT_MODEL || 'whisper-1',
    });
    const infer = (key) => (/^gsk_/.test(key) ? 'groq' : 'openai');

    if (pref === 'openai' || pref === 'groq') {
      const key = v.sttApiKey || env.ANYWHERE_STT_API_KEY || env[HTTP_PROVIDERS[pref].envKey];
      if (!key) return { name: null, hint: `Set ${HTTP_PROVIDERS[pref].envKey} or add an API key in Settings > Voice.` };
      return known(pref, key);
    }
    if (pref === 'custom') {
      const base = v.sttBaseUrl || env.ANYWHERE_STT_BASE_URL;
      if (!base)
        return { name: null, hint: 'Set voice.sttBaseUrl to your OpenAI-compatible transcription server (e.g. http://localhost:8000/v1).' };
      return custom(v.sttApiKey || env.ANYWHERE_STT_API_KEY, base);
    }
    if (pref === 'whisper.cpp' || pref === 'whisper' || pref === 'whispercpp' || pref === 'local') {
      const w = await this.findWhisper();
      return w.bin && w.model ? { name: 'whisper.cpp', kind: 'whisper', bin: w.bin, model: w.model } : { name: null, hint: w.hint };
    }

    // auto
    if (v.sttBaseUrl) return custom(v.sttApiKey || env.ANYWHERE_STT_API_KEY, v.sttBaseUrl);
    // A local OpenAI-compatible server (faster-whisper, whisper.cpp server) may need no key.
    if (env.ANYWHERE_STT_BASE_URL) return custom(v.sttApiKey || env.ANYWHERE_STT_API_KEY, env.ANYWHERE_STT_BASE_URL);
    if (v.sttApiKey) return known(infer(v.sttApiKey), v.sttApiKey);
    if (env.ANYWHERE_STT_API_KEY) {
      const name = infer(env.ANYWHERE_STT_API_KEY);
      // ANYWHERE_STT_MODEL goes with ANYWHERE_STT_API_KEY (not with GROQ_/OPENAI_API_KEY).
      return { ...known(name, env.ANYWHERE_STT_API_KEY), model: v.sttModel || env.ANYWHERE_STT_MODEL || HTTP_PROVIDERS[name].model };
    }
    if (env.GROQ_API_KEY) return known('groq', env.GROQ_API_KEY);
    if (env.OPENAI_API_KEY) return known('openai', env.OPENAI_API_KEY);
    const w = await this.findWhisper();
    if (w.bin && w.model) return { name: 'whisper.cpp', kind: 'whisper', bin: w.bin, model: w.model };
    return { name: null, hint: STT_SETUP_HINT };
  }

  /**
   * Locate a whisper.cpp binary and ggml model.
   * @returns {Promise<{bin:string|null, model:string|null, hint?:string}>}
   */
  async findWhisper() {
    const v = this.voice;
    const exe = process.platform === 'win32' ? '.exe' : '';
    let bin = null;
    if (v.whisperCppPath) {
      const p = path.resolve(expandHome(v.whisperCppPath));
      if (isFile(p)) bin = p;
      else if (isDir(p)) {
        for (const dir of [p, path.join(p, 'build', 'bin'), path.join(p, 'bin')]) {
          for (const name of WHISPER_BINARIES) {
            if (isFile(path.join(dir, name + exe))) {
              bin = path.join(dir, name + exe);
              break;
            }
          }
          if (bin) break;
        }
      }
      if (!bin) return { bin: null, model: null, hint: `voice.whisperCppPath (${p}) is not a whisper.cpp binary or build folder.` };
    } else {
      for (const name of WHISPER_BINARIES) {
        const found = this.which(name);
        if (!found) continue;
        // "whisper" may be OpenAI's Python CLI and "main" is a generic name: check the help text.
        if ((name === 'whisper' || name === 'main') && !(await this.looksLikeWhisperCpp(found))) continue;
        bin = found;
        break;
      }
    }
    let model = null;
    const dir = this.modelsDir();
    if (v.whisperModel) {
      const m = expandHome(v.whisperModel);
      const p = path.isAbsolute(m) ? m : path.join(dir, m);
      if (isFile(p)) model = p;
      else return { bin, model: null, hint: `The whisper model ${p} was not found.` };
    } else {
      try {
        const files = fs
          .readdirSync(dir)
          .filter((f) => /^ggml-.*\.bin$/i.test(f))
          .sort();
        if (files.length) model = path.join(dir, files[0]);
      } catch {
        /* no models folder */
      }
    }
    if (!bin) {
      return {
        bin: null,
        model,
        hint: 'whisper.cpp was not found. Install it (macOS: brew install whisper-cpp; others: build github.com/ggml-org/whisper.cpp) or set voice.whisperCppPath.',
      };
    }
    if (!model)
      return {
        bin,
        model: null,
        hint: `Download a whisper.cpp model (e.g. ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp) into ${dir}, or set voice.whisperModel.`,
      };
    return { bin, model };
  }

  /** @private */
  async looksLikeWhisperCpp(bin) {
    if (this.whisperProbe.has(bin)) return this.whisperProbe.get(bin);
    let ok = false;
    try {
      const r = await this.runner(bin, ['--help'], { timeoutMs: 5000 });
      ok = /no-timestamps|\s-nt[\s,]/.test(`${r.stdout}\n${r.stderr}`);
    } catch {
      ok = false;
    }
    this.whisperProbe.set(bin, ok);
    return ok;
  }

  /**
   * Pick the OS speech engine.
   * @returns {{name:string|null, bin?:string, hint?:string}}
   */
  resolveTts() {
    const pi = this.platformInfo || {};
    if (pi.platform === 'darwin') {
      const say = this.which('say') || (isFile('/usr/bin/say') ? '/usr/bin/say' : null);
      return say ? { name: 'say', bin: say } : { name: null, hint: 'The macOS say command was not found.' };
    }
    if (pi.platform === 'win32' || pi.isWSL) {
      let ps = null;
      if (pi.platform === 'win32') {
        ps = this.which('powershell') || this.which('powershell.exe');
        const sys = path.win32.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        if (!ps && isFile(sys)) ps = sys;
      } else {
        ps = this.which('powershell.exe');
        const mnt = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
        if (!ps && isFile(mnt)) ps = mnt;
      }
      return ps
        ? { name: 'sapi', bin: ps }
        : {
            name: null,
            hint: pi.isWSL
              ? 'powershell.exe is not reachable from WSL; enable Windows interop (/etc/wsl.conf [interop] enabled=true).'
              : 'Windows PowerShell (powershell.exe) was not found.',
          };
    }
    for (const name of LINUX_TTS) {
      const bin = this.which(name);
      if (bin) return { name, bin };
    }
    return {
      name: null,
      hint: 'Install a speech engine: sudo apt install espeak-ng (or speech-dispatcher; dnf install espeak-ng; pacman -S espeak-ng).',
    };
  }

  /**
   * Transcribe recorded audio.
   * @param {Buffer|Uint8Array} buffer
   * @param {{contentType?:string, language?:string}} [opts]
   * @returns {Promise<{text:string, provider:string}>}
   */
  async transcribe(buffer, { contentType = 'audio/wav', language } = {}) {
    const buf = Buffer.isBuffer(buffer) ? buffer : buffer instanceof Uint8Array ? Buffer.from(buffer) : null;
    if (!buf || !buf.length) throw voiceError(400, 'The audio is empty');
    const { stt } = await this.resolveAll();
    if (!stt.name) throw voiceError(503, 'Server speech-to-text is not configured', stt.hint || STT_SETUP_HINT);
    const lang = languageCode(language == null || language === '' ? this.voice.language : language);
    const started = this.now();
    const text =
      stt.kind === 'whisper'
        ? await this.transcribeWhisper(stt, buf, contentType, lang)
        : await this.transcribeHttp(stt, buf, contentType, lang);
    log.debug(`transcribed ${buf.length} bytes with ${stt.name} in ${this.now() - started} ms`);
    return { text, provider: stt.name };
  }

  /** @private OpenAI-compatible multipart upload */
  async transcribeHttp(stt, buf, contentType, lang) {
    const fetchFn = this.fetchImpl || globalThis.fetch;
    if (typeof fetchFn !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
      throw voiceError(500, 'This Node.js has no fetch/FormData; Node 18 or newer is required for server speech-to-text');
    }
    const type = baseContentType(contentType);
    const form = new FormData();
    form.append('file', new Blob([buf], { type }), audioFileName(type));
    form.append('model', stt.model);
    if (lang) form.append('language', lang);
    form.append('response_format', 'json');
    const url = `${String(stt.baseUrl).replace(/\/+$/, '')}/audio/transcriptions`;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      throw voiceError(400, `Invalid speech-to-text base URL: ${stt.baseUrl}`);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.sttTimeoutMs);
    if (timer.unref) timer.unref();
    const seconds = Math.round(this.sttTimeoutMs / 1000);
    let res;
    let body;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: stt.apiKey ? { Authorization: `Bearer ${stt.apiKey}` } : {},
        body: form,
        signal: ac.signal,
      });
      body = await res.text();
    } catch (err) {
      if (ac.signal.aborted) throw voiceError(504, `Speech-to-text (${host}) did not answer within ${seconds} s`);
      const cause = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || String(err);
      throw voiceError(
        502,
        `Could not reach the speech-to-text service at ${host}: ${cause}`,
        'Check your network connection and proxy settings.',
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const snippet = truncate(
        redact(
          String(body || '')
            .replace(/\s+/g, ' ')
            .trim(),
        ),
        300,
      );
      let hint;
      if (res.status === 401 || res.status === 403)
        hint = 'The speech-to-text API key was rejected: check it in Settings > Voice or your environment.';
      else if (res.status === 413) hint = 'The recording is too large; keep voice commands under a minute.';
      else if (res.status === 429) hint = 'The speech-to-text service is rate limiting; wait a moment and try again.';
      else if (res.status === 404) hint = 'Check the base URL and model name for the speech-to-text provider.';
      const e = voiceError(
        502,
        `${stt.name} transcription failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}: ${snippet || '(empty response)'}`,
        hint,
      );
      e.upstreamStatus = res.status;
      throw e;
    }
    const json = safeJsonParse(body, null);
    let text = '';
    if (json && typeof json === 'object') text = typeof json.text === 'string' ? json.text : '';
    else text = String(body || '');
    return text.trim();
  }

  /** @private local whisper.cpp (16 kHz mono WAV, converted with ffmpeg when needed) */
  async transcribeWhisper(stt, buf, contentType, lang) {
    const type = baseContentType(contentType);
    let tmp;
    try {
      tmp = fs.mkdtempSync(path.join(this.tmpDir, 'anywhere-stt-'));
    } catch (err) {
      throw voiceError(500, `Could not create a temporary folder: ${err.message}`);
    }
    try {
      const inPath = path.join(tmp, audioFileName(type).replace(/^audio/, 'input'));
      fs.writeFileSync(inPath, buf);
      const info = parseWavHeader(buf);
      const ready =
        info &&
        info.sampleRate === 16000 &&
        info.channels === 1 &&
        info.bitsPerSample === 16 &&
        (info.format === 1 || info.format === 0xfffe);
      let wavPath = inPath;
      if (!ready) {
        const ffmpeg = this.which('ffmpeg');
        if (!ffmpeg) {
          const got = info ? `${info.sampleRate} Hz, ${info.channels} channel(s), ${info.bitsPerSample}-bit` : type;
          throw voiceError(
            415,
            `whisper.cpp needs 16 kHz mono 16-bit WAV audio (got ${got})`,
            'Install ffmpeg so audio is converted automatically (macOS: brew install ffmpeg; Debian/Ubuntu: sudo apt install ffmpeg; Windows: winget install ffmpeg), or record 16 kHz mono WAV.',
          );
        }
        wavPath = path.join(tmp, 'audio-16k.wav');
        const conv = await this.runner(
          ffmpeg,
          ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
          { timeoutMs: FFMPEG_TIMEOUT_MS },
        );
        if (conv.error || conv.timedOut || conv.code !== 0) {
          throw voiceError(
            502,
            `ffmpeg could not convert the audio: ${tail(conv.stderr || (conv.error && conv.error.message) || (conv.timedOut ? 'timed out' : `exit ${conv.code}`))}`,
          );
        }
      }
      const r = await this.runner(stt.bin, ['-m', stt.model, '-f', wavPath, '-nt', '-np', '-l', lang || 'auto'], {
        timeoutMs: WHISPER_TIMEOUT_MS,
      });
      if (r.error)
        throw voiceError(
          502,
          `Could not run whisper.cpp (${stt.bin}): ${r.error.message}`,
          'Check voice.whisperCppPath or reinstall whisper.cpp.',
        );
      if (r.timedOut)
        throw voiceError(
          504,
          `whisper.cpp took longer than ${WHISPER_TIMEOUT_MS / 1000} s`,
          'Use a smaller model (ggml-base.en.bin or ggml-tiny.en.bin).',
        );
      if (r.code !== 0) throw voiceError(502, `whisper.cpp failed (exit ${r.code}): ${tail(r.stderr)}`);
      return cleanTranscript(r.stdout);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Speak text through the OS (one utterance at a time; a new one stops the old).
   * Resolves when speaking finishes or is stopped.
   * @param {string} text
   * @param {{rate?:number, voice?:string}} [opts]
   * @returns {Promise<{ok:boolean, provider:string|null, stopped?:boolean, error?:string}>}
   */
  async speak(text, { rate, voice } = {}) {
    const v = this.voice;
    if (v.tts === 'off') return { ok: false, provider: null, error: 'Text-to-speech is turned off' };
    const clean = capSpeech(
      stripMarkdownForSpeech(String(text == null ? '' : text))
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (!clean) return { ok: false, provider: null, error: 'Nothing to speak' };
    const { tts } = await this.resolveAll();
    if (!tts.name) throw voiceError(503, 'No text-to-speech engine was found', tts.hint);
    const ttsRate = rate != null ? rate : v.ttsRate;
    let ttsVoice = voice || v.ttsVoice || '';
    // The dialog's voice list is the browser's: "Google US English" or an "Online" voice exists
    // only there, and say/espeak-ng fail on it (MACOS-2-9). Use a local voice for the language.
    if (ttsVoice && VOICE_CHECKED_ENGINES.has(tts.name) && BROWSER_ONLY_VOICE.test(ttsVoice)) {
      ttsVoice = await this.localVoiceFor(tts, v.language);
    }
    let cmd = buildTtsCommand(tts, clean, { rate: ttsRate, voice: ttsVoice, language: v.language });
    this.stop();
    const ac = new AbortController();
    const current = { ac, tts, winPid: null };
    this.current = current;
    // On WSL the spawned powershell.exe is reached through an interop relay; killing the relay does
    // not stop SAPI, so record the real Windows PID (printed by the script) to taskkill it on stop.
    const wslSapi = tts.name === 'sapi' && Boolean(this.platformInfo && this.platformInfo.isWSL);
    const onStdout = wslSapi
      ? (chunk) => {
          if (current.winPid != null) return;
          const m = /ANYWHERE_PID (\d+)/.exec(String(chunk));
          if (m) current.winPid = Number(m[1]);
        }
      : undefined;
    let r;
    try {
      r = await this.runner(cmd.cmd, cmd.args, { input: cmd.input, timeoutMs: SPEAK_TIMEOUT_MS, signal: ac.signal, onStdout });
      // An unknown voice (say: "Voice `X' not found", espeak-ng: "does not exist"): speak with the
      // language's local voice, or the default, rather than lose the announcement.
      if (
        r &&
        !r.error &&
        !r.aborted &&
        !ac.signal.aborted &&
        r.code !== 0 &&
        ttsVoice &&
        VOICE_CHECKED_ENGINES.has(tts.name) &&
        /not found|does not exist|invalid voice|unknown voice/i.test(String(r.stderr || ''))
      ) {
        log.info(`${tts.name} has no voice "${ttsVoice}"; using ${tts.name === 'say' ? 'a local voice for the language' : 'the language default'}`);
        const fallback = await this.localVoiceFor(tts, v.language);
        ttsVoice = fallback && fallback !== ttsVoice ? fallback : '';
        cmd = buildTtsCommand(tts, clean, { rate: ttsRate, voice: ttsVoice, language: v.language });
        if (!ac.signal.aborted) r = await this.runner(cmd.cmd, cmd.args, { input: cmd.input, timeoutMs: SPEAK_TIMEOUT_MS, signal: ac.signal, onStdout });
      }
    } finally {
      if (this.current === current) this.current = null;
    }
    // Windows PowerShell reports -EncodedCommand errors as CLIXML; keep the message (e.g. "Audio device error").
    if (r && tts.name === 'sapi' && typeof r.stderr === 'string') r = { ...r, stderr: proc.psErrorText(r.stderr) };
    if (ac.signal.aborted || (r && r.aborted)) return { ok: true, provider: tts.name, stopped: true };
    if (r.error) {
      const hint = r.error.code === 'ENOENT' ? this.resolveTtsHintFor(tts.name) : undefined;
      throw voiceError(502, `Could not run ${tts.name}: ${r.error.message}`, hint);
    }
    if (r.timedOut) return { ok: false, provider: tts.name, error: 'Speaking took too long and was stopped' };
    if (r.code !== 0) {
      let detail = tail(r.stderr);
      let hint;
      if (tts.name === 'sapi') {
        // A PowerShell error is its message followed by "At line:..." position lines: keep the message.
        detail = tail(String(r.stderr || '').split(/\r?\n\s*At line:\d+/)[0]);
        hint = /Audio device error|AudioException/i.test(String(r.stderr || ''))
          ? 'Windows found no working audio output device. Connect or enable speakers or headphones (Settings > System > Sound).'
          : 'System.Speech needs Windows PowerShell 5.1 (powershell.exe) with a speech voice installed.';
      }
      throw voiceError(502, `${tts.name} failed (exit ${r.code}): ${detail || 'no output'}`, hint);
    }
    return { ok: true, provider: tts.name };
  }

  /**
   * A voice of this engine for the dialog's language: for say, the first installed voice whose
   * locale matches (`say -v ?`, read once); '' for the engine's default (espeak-ng then picks the
   * language with -v <lang>).
   * @private
   */
  async localVoiceFor(tts, language) {
    if (tts.name !== 'say') return '';
    if (!this.localVoices) {
      this.localVoices = Promise.resolve()
        .then(() => this.runner(tts.bin, ['-v', '?'], { timeoutMs: 5000 }))
        .then((r) => (r && r.code === 0 ? parseSayVoices(r.stdout) : []))
        .catch(() => []);
    }
    const voices = await this.localVoices;
    const want = String(language || '').trim().replace('-', '_').toLowerCase();
    const lang = languageCode(language);
    const exact = voices.find((x) => x.locale.toLowerCase() === want);
    const sameLang = voices.find((x) => languageCode(x.locale) === lang);
    return (exact || sameLang || { name: '' }).name;
  }

  /** @private */
  resolveTtsHintFor(name) {
    if (name === 'say') return 'The macOS say command is missing.';
    if (name === 'sapi') return 'powershell.exe could not be started.';
    return 'Install a speech engine: sudo apt install espeak-ng (or speech-dispatcher).';
  }

  /**
   * Stop the utterance being spoken, if any.
   * @returns {boolean} whether something was stopped
   */
  stop() {
    const cur = this.current;
    this.current = null;
    if (!cur) return false;
    try {
      cur.ac.abort();
    } catch {
      /* ignore */
    }
    if (cur.tts && cur.tts.name === 'spd-say') {
      // Killing spd-say doesn't stop speech-dispatcher's queue.
      Promise.resolve(this.runner(cur.tts.bin, ['-C'], { timeoutMs: 3000 })).catch(() => {});
    }
    if (cur.tts && cur.tts.name === 'sapi' && this.platformInfo && this.platformInfo.isWSL && cur.winPid != null) {
      // Aborting the runner kills only the Linux interop relay; end the real Windows process too.
      const taskkill = this.which('taskkill.exe') || (isFile(WSL_TASKKILL) ? WSL_TASKKILL : null);
      if (taskkill) {
        Promise.resolve(this.runner(taskkill, ['/PID', String(cur.winPid), '/T', '/F'], { timeoutMs: 5000 })).catch(() => {});
      }
    }
    return true;
  }
}

module.exports = {
  VoiceService,
  buildTtsCommand,
  parseSayVoices,
  parseWavHeader,
  languageCode,
  audioFileName,
  cleanTranscript,
  capSpeech,
  defaultRunner,
  HTTP_PROVIDERS,
  MAX_SPEAK_CHARS,
};
