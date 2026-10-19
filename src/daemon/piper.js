'use strict';

/**
 * Piper (github.com/rhasspy/piper, MIT): a free, offline, neural text-to-speech engine whose
 * voices sound like a person, not a robot. Nothing is sent anywhere and nothing costs money.
 *
 * This module installs it into stateDir()/voice/ on request (`anywhere voice install`,
 * POST /api/voice/install) and synthesizes WAV files:
 *
 * - Engine: the official release binary for this OS and CPU (tag 2023.11.14-2). Where that
 *   does not run (the macOS builds are fragile; very old glibc), piper-tts from PyPI in a private
 *   Python venv (stateDir()/voice/venv; the user's own Python packages are never touched).
 *   ANYWHERE_PIPER_PATH, or a `piper` on PATH that really is Piper TTS, are used first.
 * - Voices: rhasspy/piper-voices on Hugging Face (<id>.onnx + <id>.onnx.json); a few also come
 *   from the original GitHub release (v0.0.2) when Hugging Face is unreachable.
 * - Downloads: node https with redirects, HTTPS_PROXY/NO_PROXY, progress, resumable .part files
 *   and size/JSON checks. Archives are unpacked with tar (bsdtar reads zip on macOS and
 *   Windows 10+), unzip, or PowerShell Expand-Archive.
 * - Synthesis: text on stdin, `--model <onnx> --config <json> --output_file <wav>`, 30 s timeout.
 *   TtsCache keeps the last 60 WAVs (keyed by voice, speed and text) so fixed phrases replay at once.
 *
 * Test hooks: ANYWHERE_PIPER_RELEASE_BASE, ANYWHERE_PIPER_VOICES_BASE and
 * ANYWHERE_PIPER_LEGACY_BASE (or the matching constructor options) replace the download URLs;
 * plain http is accepted only for loopback hosts.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const proc = require('../shared/proc');
const paths = require('../shared/paths');
const platformMod = require('../shared/platform');
const { createLogger } = require('../shared/log');

const log = createLogger('piper');

const RELEASE_TAG = '2023.11.14-2';
const DEFAULT_RELEASE_BASE = `https://github.com/rhasspy/piper/releases/download/${RELEASE_TAG}`;
const DEFAULT_VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const DEFAULT_LEGACY_BASE = 'https://github.com/rhasspy/piper/releases/download/v0.0.2';
const PIP_SPEC = 'piper-tts>=1.3,<2';
const DEFAULT_VOICE = 'en_US-lessac-medium';

const SYNTH_TIMEOUT_MS = 30000;
const PROBE_TIMEOUT_MS = 15000;
const DOWNLOAD_IDLE_MS = 60000;
const VENV_TIMEOUT_MS = 180000;
const PIP_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_REDIRECTS = 8;
const MAX_TEXT = 4000;
const CACHE_MAX = 60;
const LOCK_STALE_MS = 45 * 60 * 1000;
const MIN_MODEL_BYTES = 1024 * 1024;
const MIN_BINARY_ARCHIVE_BYTES = 1024 * 1024;

const VOICE_ID_RE = /^([a-z]{2,3})_([A-Z]{2})-([a-z0-9_]+)-(x_low|low|medium|high)$/;
// Voices a user dropped into the voices folder themselves (any <name>.onnx + <name>.onnx.json).
const LOCAL_VOICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

const SAMPLES = {
  en: "Hi! I've finished that task. Your changes are saved and all the tests pass.",
  de: 'Hallo! Ich bin mit der Aufgabe fertig. Deine Änderungen sind gespeichert.',
  fr: "Bonjour ! J'ai terminé cette tâche. Tes modifications sont enregistrées.",
  es: '¡Hola! Ya terminé esa tarea. Tus cambios están guardados.',
  it: 'Ciao! Ho finito il lavoro. Le tue modifiche sono salvate.',
  pt: 'Olá! Terminei essa tarefa. Suas alterações foram salvas.',
  ru: 'Привет! Я закончил эту задачу. Изменения сохранены.',
  zh: '你好！我已经完成了这个任务，你的更改已经保存。',
};

/**
 * Curated free voices that sound most natural, with an approximate download size.
 * `legacy`: the same speaker in the original GitHub release (v0.0.2), used when Hugging Face
 * cannot be reached.
 */
const CATALOG = Object.freeze(
  [
    ['en_US-lessac-medium', 'Lessac', 'English (US)', 'female', 'medium', 63, 'Clear, warm and natural; the default.', 'voice-en-us-lessac-medium'],
    ['en_US-lessac-high', 'Lessac (high quality)', 'English (US)', 'female', 'high', 109, 'The default voice at higher fidelity.'],
    ['en_US-amy-medium', 'Amy', 'English (US)', 'female', 'medium', 63, 'Bright and friendly.'],
    ['en_US-hfc_female-medium', 'HFC female', 'English (US)', 'female', 'medium', 63, 'Calm and conversational.'],
    ['en_US-kristin-medium', 'Kristin', 'English (US)', 'female', 'medium', 63, 'Soft narrator.'],
    ['en_US-ryan-high', 'Ryan (high quality)', 'English (US)', 'male', 'high', 116, 'Expressive, very natural male voice.', 'voice-en-us-ryan-high'],
    ['en_US-ryan-medium', 'Ryan', 'English (US)', 'male', 'medium', 63, 'Natural male voice, smaller download.', 'voice-en-us-ryan-medium'],
    ['en_US-hfc_male-medium', 'HFC male', 'English (US)', 'male', 'medium', 63, 'Calm and conversational.'],
    ['en_US-joe-medium', 'Joe', 'English (US)', 'male', 'medium', 63, 'Relaxed and casual.'],
    ['en_US-libritts_r-medium', 'LibriTTS-R', 'English (US)', 'various', 'medium', 78, 'Audiobook-style voice (multi-speaker model).'],
    ['en_GB-alba-medium', 'Alba', 'English (UK)', 'female', 'medium', 63, 'Scottish English, gentle.'],
    ['en_GB-jenny_dioco-medium', 'Jenny', 'English (UK)', 'female', 'medium', 63, 'Southern British English, crisp.'],
    ['en_GB-cori-high', 'Cori (high quality)', 'English (UK)', 'female', 'high', 109, 'Polished British narrator.'],
    ['en_GB-cori-medium', 'Cori', 'English (UK)', 'female', 'medium', 63, 'Polished British narrator, smaller download.'],
    ['en_GB-northern_english_male-medium', 'Northern English male', 'English (UK)', 'male', 'medium', 63, 'Friendly northern English accent.'],
    ['en_GB-alan-medium', 'Alan', 'English (UK)', 'male', 'medium', 63, 'Steady British male voice.'],
    ['de_DE-thorsten-medium', 'Thorsten', 'German', 'male', 'medium', 63, 'Natural German voice.'],
    ['fr_FR-siwis-medium', 'Siwis', 'French', 'female', 'medium', 63, 'Natural French voice.', 'voice-fr-siwis-medium'],
    ['es_ES-davefx-medium', 'Davefx', 'Spanish (Spain)', 'male', 'medium', 63, 'Natural Castilian Spanish.'],
    ['es_MX-claude-high', 'Claude (Mexico)', 'Spanish (Mexico)', 'male', 'high', 109, 'Natural Mexican Spanish.'],
    ['it_IT-paola-medium', 'Paola', 'Italian', 'female', 'medium', 63, 'Natural Italian voice.'],
    ['pt_BR-faber-medium', 'Faber', 'Portuguese (Brazil)', 'male', 'medium', 63, 'Natural Brazilian Portuguese.'],
    ['ru_RU-irina-medium', 'Irina', 'Russian', 'female', 'medium', 63, 'Natural Russian voice.'],
    ['zh_CN-huayan-medium', 'Huayan', 'Chinese (Mandarin)', 'female', 'medium', 63, 'Natural Mandarin voice.'],
  ].map(([id, name, language, gender, quality, sizeMb, description, legacy]) =>
    Object.freeze({
      id,
      name,
      language,
      locale: id.split('-')[0],
      gender,
      quality,
      sizeMb,
      description,
      sampleText: SAMPLES[id.slice(0, 2)] || SAMPLES.en,
      ...(legacy ? { legacy } : {}),
    }),
  ),
);

function piperError(message, { status = 500, code, hint } = {}) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  if (hint) e.hint = hint;
  return e;
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

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* in use; left for the next run */
  }
}

function tail(s, n = 400) {
  const t = String(s || '')
    .trim()
    .replace(/\s+/g, ' ');
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

/**
 * Split a Piper voice id: en_US-lessac-medium → {lang:'en', locale:'en_US', name:'lessac', quality:'medium'}.
 * @param {string} id
 * @returns {{id:string, lang:string, locale:string, region:string, name:string, quality:string}|null}
 */
function parseVoiceId(id) {
  const m = VOICE_ID_RE.exec(String(id || ''));
  if (!m) return null;
  return { id: m[0], lang: m[1], region: m[2], locale: `${m[1]}_${m[2]}`, name: m[3], quality: m[4] };
}

/** @returns {boolean} whether `id` is a safe voice file name (catalog id or a local voice) */
function validVoiceName(id) {
  return typeof id === 'string' && (VOICE_ID_RE.test(id) || LOCAL_VOICE_RE.test(id)) && !id.includes('..');
}

/** @returns {object|null} the catalog entry for an id */
function catalogEntry(id) {
  return CATALOG.find((v) => v.id === id) || null;
}

/**
 * Hugging Face URLs of a voice's model and config.
 * @param {string} id
 * @param {{base?:string}} [opts]
 * @returns {{onnx:string, json:string}|null}
 */
function voiceUrls(id, { base = DEFAULT_VOICES_BASE } = {}) {
  const v = parseVoiceId(id);
  if (!v) return null;
  const dir = `${String(base).replace(/\/+$/, '')}/${v.lang}/${v.locale}/${v.name}/${v.quality}/${v.id}`;
  return { onnx: `${dir}.onnx`, json: `${dir}.onnx.json` };
}

/**
 * The release archive for an OS and CPU.
 * @param {string} platform process.platform
 * @param {string} arch process.arch
 * @param {{base?:string}} [opts]
 * @returns {{name:string, url:string, kind:'tar.gz'|'zip'}|null}
 */
function releaseAsset(platform, arch, { base = DEFAULT_RELEASE_BASE } = {}) {
  const names = {
    'linux:x64': 'piper_linux_x86_64.tar.gz',
    'linux:arm64': 'piper_linux_aarch64.tar.gz',
    'linux:arm': 'piper_linux_armv7l.tar.gz',
    'darwin:x64': 'piper_macos_x64.tar.gz',
    'darwin:arm64': 'piper_macos_aarch64.tar.gz',
    'win32:x64': 'piper_windows_amd64.zip',
    // Windows on ARM runs x64 programs through emulation.
    'win32:arm64': 'piper_windows_amd64.zip',
  };
  const name = names[`${platform}:${arch}`];
  if (!name) return null;
  return {
    name,
    url: `${String(base).replace(/\/+$/, '')}/${name}`,
    kind: name.endsWith('.zip') ? 'zip' : 'tar.gz',
    // The macOS archives of this release lack libonnxruntime, libespeak-ng and libpiper_phonemize
    // (and the "aarch64" one is an x86_64 build), so macOS goes straight to piper-tts from PyPI.
    usable: platform !== 'darwin',
  };
}

/**
 * Duration of a PCM WAV from its header.
 * @param {Buffer} buf at least the header (the whole file is not needed)
 * @param {number} [fileBytes] the file's size when buf is only its start
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number, durationMs:number}|null}
 */
function wavInfo(buf, fileBytes) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= buf.length) {
      fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), byteRate: buf.readUInt32LE(off + 16), bitsPerSample: buf.readUInt16LE(off + 22) };
    } else if (id === 'data' && fmt) {
      const total = Number.isFinite(fileBytes) ? fileBytes : buf.length;
      // Streams written to a pipe leave the size at 0 or 0xFFFFFFFF: count what follows.
      const dataBytes = size === 0 || size === 0xffffffff || off + 8 + size > total ? Math.max(0, total - off - 8) : size;
      const byteRate = fmt.byteRate || fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bitsPerSample,
        durationMs: byteRate > 0 ? Math.round((dataBytes / byteRate) * 1000) : 0,
      };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** wavInfo() of a file on disk (reads its first 4 KB). */
function wavFileInfo(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return wavInfo(buf.subarray(0, n), fs.fstatSync(fd).size);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// ------------------------------------------------------------------ HTTP(S) downloads

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function envGet(env, name) {
  return env[name] || env[name.toLowerCase()] || '';
}

/**
 * Whether NO_PROXY exempts a host. Entries: "*", "host", ".domain", "*.domain", "host:port", IPs.
 * @param {string} host
 * @param {number|string} port
 * @param {string} noProxy
 * @returns {boolean}
 */
function noProxyMatch(host, port, noProxy) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK.has(h)) return true;
  for (const raw of String(noProxy || '').split(/[,\s]+/)) {
    let e = raw.trim().toLowerCase();
    if (!e) continue;
    if (e === '*') return true;
    let ePort = null;
    const m = /^(.*?):(\d+)$/.exec(e);
    if (m && !e.includes('::')) {
      e = m[1];
      ePort = m[2];
    }
    if (ePort && String(port) !== ePort) continue;
    e = e.replace(/^\*\./, '.');
    if (e.includes('/')) {
      // CIDR: exact match on its network address only (enough for 127.0.0.0/8-style entries with loopback handled above).
      if (h === e.split('/')[0]) return true;
      continue;
    }
    if (e.startsWith('.') ? h === e.slice(1) || h.endsWith(e) : h === e || h.endsWith(`.${e}`)) return true;
  }
  return false;
}

/** The proxy URL to use for an https URL, or null. */
function proxyFor(u, env = process.env) {
  if (u.protocol !== 'https:') return null;
  const proxy = envGet(env, 'HTTPS_PROXY') || envGet(env, 'ALL_PROXY');
  if (!proxy) return null;
  if (noProxyMatch(u.hostname, u.port || 443, envGet(env, 'NO_PROXY'))) return null;
  try {
    const p = new URL(/^[a-z]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p : null;
  } catch {
    return null;
  }
}

/**
 * Open a TLS socket to host:port through an HTTP CONNECT proxy.
 * @returns {Promise<tls.TLSSocket>}
 */
function connectViaProxy(proxy, host, port, { ca, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.username || proxy.password) {
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    }
    const lib = proxy.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
    });
    let settled = false;
    const done = (err, sock) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(sock);
    };
    const refused = (status) =>
      piperError(`The proxy ${proxy.host} refused the connection to ${host} (HTTP ${status})`, {
        status: 502,
        code: 'PROXY_REFUSED',
        hint: `Allow ${host} in your proxy, or download the files on another network.`,
      });
    const onAbort = () => req.destroy(piperError('The download was cancelled', { code: 'ABORTED' }));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.setTimeout(timeoutMs, () => req.destroy(piperError(`The proxy ${proxy.host} did not answer within ${Math.round(timeoutMs / 1000)} s`, { code: 'ETIMEDOUT' })));
    // A 2xx answer to CONNECT arrives as 'connect'; any other status is an ordinary 'response'.
    let tunnelled = false;
    req.once('connect', (res, socket) => {
      tunnelled = true; // the request "closes" now; the socket lives on as the tunnel
      if (res.statusCode < 200 || res.statusCode >= 300) {
        socket.destroy();
        done(refused(res.statusCode));
        return;
      }
      const t = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ...(ca ? { ca } : {}) });
      t.once('secureConnect', () => done(null, t));
      t.once('error', (err) => done(err));
    });
    req.once('response', (res) => {
      res.resume();
      done(refused(res.statusCode));
    });
    req.once('error', (err) => done(err));
    req.once('close', () => tunnelled || done(piperError(`The proxy ${proxy.host} closed the connection to ${host}`, { status: 502, code: 'PROXY_REFUSED' })));
    req.end();
  });
}

/**
 * GET a URL and follow redirects. Resolves with the final response (status < 300 or an error
 * status, which the caller handles); the body is not consumed.
 * @param {string} url
 * @param {{headers?:object, timeoutMs?:number, signal?:AbortSignal, ca?:string|Buffer, env?:object, maxRedirects?:number}} [opts]
 * @returns {Promise<{res:import('http').IncomingMessage, url:string}>}
 */
async function httpGet(url, { headers = {}, timeoutMs = DOWNLOAD_IDLE_MS, signal, ca, env = process.env, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = url;
  let hdrs = { 'User-Agent': 'claude-anywhere (piper voice installer)', ...headers };
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let u;
    try {
      u = new URL(current);
    } catch {
      throw piperError(`Invalid download URL: ${current}`, { status: 400 });
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
      throw piperError(`Refusing to download over ${u.protocol.replace(':', '')}: ${u.origin}`, { status: 400, code: 'INSECURE_URL' });
    }
    if (signal && signal.aborted) throw piperError('The download was cancelled', { code: 'ABORTED' });
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const proxy = proxyFor(u, env);
    let socket = null;
    if (proxy) socket = await connectViaProxy(proxy, u.hostname, port, { ca, timeoutMs, signal });
    const lib = u.protocol === 'https:' ? https : http;
    const res = await new Promise((resolve, reject) => {
      const opts = {
        method: 'GET',
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port,
        path: `${u.pathname}${u.search}`,
        headers: hdrs,
        // A tunnelled socket goes in through createConnection, which Node only honours without an
        // agent option; a direct request gets a fresh agent (no pooled sockets left behind).
        ...(socket ? {} : { agent: false }),
        ...(u.protocol === 'https:' ? { servername: net.isIP(u.hostname) ? undefined : u.hostname, ...(ca ? { ca } : {}) } : {}),
        ...(socket ? { createConnection: () => socket } : {}),
      };
      const req = lib.request(opts, resolve);
      const onAbort = () => req.destroy(piperError('The download was cancelled', { code: 'ABORTED' }));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      req.setTimeout(timeoutMs, () => req.destroy(piperError(`${u.host} did not answer within ${Math.round(timeoutMs / 1000)} s`, { code: 'ETIMEDOUT' })));
      req.once('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
      });
      req.once('response', () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      });
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, current);
      // Credentials and ranges stay with the original host's request only where they belong.
      if (next.host !== u.host) {
        const { Authorization, authorization, Cookie, cookie, ...rest } = hdrs; // eslint-disable-line no-unused-vars
        hdrs = rest;
      }
      current = next.toString();
      continue;
    }
    return { res, url: current };
  }
  throw piperError(`Too many redirects downloading ${url}`, { status: 502 });
}

/**
 * Download a URL to `dest`, through `dest.part` (resumed with a Range request when a previous
 * attempt left one). The file only appears under `dest` once complete and checked.
 * @param {string} url
 * @param {string} dest
 * @param {{onProgress?:(p:{received:number,total:number|null,percent:number|null})=>void, minBytes?:number,
 *   maxBytes?:number, signal?:AbortSignal, timeoutMs?:number, ca?:string|Buffer, env?:object, resume?:boolean}} [opts]
 * @returns {Promise<{path:string, bytes:number, url:string}>}
 */
async function downloadFile(url, dest, { onProgress, minBytes = 1, maxBytes = 2 * 1024 * 1024 * 1024, signal, timeoutMs = DOWNLOAD_IDLE_MS, ca, env, resume = true } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const part = `${dest}.part`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const have = resume ? Math.max(0, fileSize(part)) : 0;
    if (!resume) rmrf(part);
    const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
    let got;
    try {
      got = await httpGet(url, { headers, timeoutMs, signal, ca, env });
    } catch (err) {
      if (err.status) throw err;
      throw piperError(`Could not download ${new URL(url).host}${new URL(url).pathname}: ${err.message || err.code}`, {
        status: 502,
        code: err.code === 'ABORTED' ? 'ABORTED' : 'DOWNLOAD_FAILED',
        hint: 'Check your internet connection (and HTTPS_PROXY if you use a proxy), then try again; the download resumes where it stopped.',
      });
    }
    const { res } = got;
    if (res.statusCode === 416 && have > 0) {
      res.resume();
      rmrf(part); // the partial file is bigger than the remote one: start over
      continue;
    }
    if (res.statusCode >= 400) {
      res.resume();
      const host = new URL(got.url).host;
      throw piperError(`Download failed: HTTP ${res.statusCode} from ${host} for ${path.basename(new URL(url).pathname)}`, {
        status: res.statusCode === 404 ? 404 : 502,
        code: res.statusCode === 404 ? 'NOT_FOUND' : 'HTTP_ERROR',
        hint:
          res.statusCode === 404
            ? 'That file does not exist: check the voice id (anywhere voice list).'
            : res.statusCode === 403 || res.statusCode === 407
              ? `${host} refused the download; a firewall or proxy may block it.`
              : 'The server had a problem; try again in a minute.',
      });
    }
    const append = res.statusCode === 206 && have > 0;
    let total = null;
    if (append) {
      const m = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] || ''));
      total = m ? Number(m[1]) : null;
    } else {
      const len = Number(res.headers['content-length']);
      total = Number.isFinite(len) && len > 0 ? len : null;
    }
    if (total != null && total > maxBytes) {
      res.resume();
      throw piperError(`Download is too large (${mb(total)})`, { status: 502, code: 'TOO_LARGE' });
    }
    let received = append ? have : 0;
    const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w', mode: 0o600 });
    let lastReport = 0;
    const report = (force) => {
      if (typeof onProgress !== 'function') return;
      const now = Date.now();
      if (!force && now - lastReport < 150) return;
      lastReport = now;
      try {
        onProgress({ received, total, percent: total ? Math.min(100, Math.floor((received / total) * 100)) : null });
      } catch {
        /* progress observers never break a download */
      }
    };
    report(true);
    await new Promise((resolve, reject) => {
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        res.destroy();
        out.destroy();
        reject(err);
      };
      const onAbort = () => fail(piperError('The download was cancelled', { code: 'ABORTED' }));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      res.setTimeout?.(timeoutMs, () => fail(piperError(`The download stalled for ${Math.round(timeoutMs / 1000)} s`, { status: 504, code: 'ETIMEDOUT', hint: 'Run the install again; it resumes where it stopped.' })));
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          fail(piperError(`Download is too large (over ${mb(maxBytes)})`, { status: 502, code: 'TOO_LARGE' }));
          return;
        }
        if (!out.write(chunk)) {
          res.pause();
          out.once('drain', () => res.resume());
        }
        report(false);
      });
      res.once('aborted', () => fail(piperError('The connection was closed during the download', { status: 502, code: 'DOWNLOAD_FAILED', hint: 'Run the install again; it resumes where it stopped.' })));
      res.once('error', (err) => fail(piperError(`The download failed: ${err.message}`, { status: 502, code: 'DOWNLOAD_FAILED', hint: 'Run the install again; it resumes where it stopped.' })));
      res.once('end', () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        out.end((err) => (err ? fail(err) : failed ? null : resolve()));
      });
      out.once('error', (err) => fail(piperError(`Could not write ${part}: ${err.message}`, { code: err.code })));
    });
    report(true);
    const size = fileSize(part);
    if (total != null && size !== total) {
      throw piperError(`The download is incomplete (${mb(size)} of ${mb(total)})`, { status: 502, code: 'INCOMPLETE', hint: 'Run the install again; it resumes where it stopped.' });
    }
    if (size < minBytes) {
      rmrf(part);
      throw piperError(`The downloaded file is too small (${size} bytes): the server sent something else`, { status: 502, code: 'BAD_DOWNLOAD' });
    }
    fs.renameSync(part, dest);
    return { path: dest, bytes: size, url: got.url };
  }
  throw piperError(`Could not download ${url}`, { status: 502, code: 'DOWNLOAD_FAILED' });
}

// ------------------------------------------------------------------ process runner

/**
 * Spawn and collect output; never throws. Supports stdin input, a timeout and an AbortSignal.
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean, error:Error|null}>}
 */
function defaultRunner(cmd, args = [], { timeoutMs = 15000, input, signal, env, cwd, onStdout, onStderr } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    const kill = () => {
      if (!child) return;
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
      const t = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }, 1500);
      if (t.unref) t.unref();
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        code: r.code ?? null,
        signal: r.signal ?? null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        aborted,
        error: r.error || null,
      });
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
      if (outLen <= 4 * 1024 * 1024) out.push(d);
      if (typeof onStdout === 'function') {
        try {
          onStdout(d);
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr.on('data', (d) => {
      errLen += d.length;
      if (errLen <= 1024 * 1024) err.push(d);
      if (typeof onStderr === 'function') {
        try {
          onStderr(d);
        } catch {
          /* ignore */
        }
      }
    });
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code, sig) => finish({ code, signal: sig }));
    child.stdin.on('error', () => {
      /* EPIPE: the child exited early */
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// ------------------------------------------------------------------ TTS cache

/**
 * Synthesized WAVs keyed by hash(voice, speed, text), at most `max` files (least recently used
 * go first). Ids are 32 lowercase hex characters, so they can never name another file.
 */
class TtsCache {
  /** @param {{dir?:string, max?:number}} [opts] */
  constructor({ dir, max = CACHE_MAX } = {}) {
    this.dirOverride = dir || null;
    this.max = max;
  }

  /** @returns {string} the cache folder (created) */
  dir() {
    const d = this.dirOverride || path.join(paths.runDir(), 'tts-cache');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  /** @returns {boolean} */
  static validId(id) {
    return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
  }

  /** @param {Array<string|number>} parts @returns {string} the id */
  keyFor(parts) {
    return crypto.createHash('sha256').update(parts.map((p) => String(p)).join('\u0000')).digest('hex').slice(0, 32);
  }

  /** @returns {string|null} the file of a valid id (whether or not it exists) */
  pathFor(id) {
    return TtsCache.validId(id) ? path.join(this.dir(), `${id}.wav`) : null;
  }

  /** @returns {string|null} the file when it exists, marked as recently used */
  get(id) {
    const p = this.pathFor(id);
    if (!p || !isFile(p) || fileSize(p) <= 44) return null;
    try {
      const now = new Date();
      fs.utimesSync(p, now, now);
    } catch {
      /* read-only: still usable */
    }
    return p;
  }

  /** Delete the least recently used files beyond `max`, and stray temp files. */
  prune() {
    let names = [];
    const d = this.dir();
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    const entries = [];
    for (const n of names) {
      const p = path.join(d, n);
      if (/\.tmp/.test(n)) {
        try {
          if (Date.now() - fs.statSync(p).mtimeMs > 120000) fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
        continue;
      }
      if (!/^[a-f0-9]{32}\.wav$/.test(n)) continue;
      try {
        entries.push({ p, t: fs.statSync(p).mtimeMs });
      } catch {
        /* gone */
      }
    }
    entries.sort((a, b) => b.t - a.t);
    for (const e of entries.slice(this.max)) {
      try {
        fs.unlinkSync(e.p);
      } catch {
        /* in use */
      }
    }
  }
}

// ------------------------------------------------------------------ Python probe

/**
 * Find a Python interpreter with a working `venv` module, for a private venv (the user's own
 * packages are never touched). Order: `preferred`, ANYWHERE_PYTHON, `py -3` (Windows), python3,
 * python. Skips the macOS /usr/bin/python3 stub when the Command Line Tools are missing (it would
 * open an install dialog) and the Windows Store alias in WindowsApps. Shared by Piper and the
 * cloned-voice installer (src/voice/clone/installer.js).
 * @param {{env?:object, which?:(n:string)=>string|null, runner?:Function, platform?:string,
 *   preferred?:Array<[string, string[]]>, min?:[number, number], max?:[number, number]|null}} [opts]
 *   min/max: the accepted version range (inclusive), default 3.9 and no maximum.
 * @returns {Promise<{cmd:string, args:string[], version:string}|null>}
 */
async function findPython({ env = process.env, which = proc.which, runner = defaultRunner, platform = process.platform, preferred = [], min = [3, 9], max = null } = {}) {
  const candidates = [];
  const seen = new Set();
  const add = (cmd, args = []) => {
    const key = `${cmd}\u0000${args.join(' ')}`;
    if (!cmd || seen.has(key)) return;
    seen.add(key);
    candidates.push([cmd, args]);
  };
  for (const [cmd, args] of preferred) add(String(cmd || '').trim(), args || []);
  const fromEnv = String(env.ANYWHERE_PYTHON || '').trim();
  if (fromEnv) add(fromEnv, []);
  if (platform === 'win32') {
    const py = which('py');
    if (py) add(py, ['-3']);
  }
  for (const name of ['python3', 'python']) {
    const p = which(name);
    if (!p) continue;
    // macOS: /usr/bin/python3 without the Command Line Tools opens an install dialog.
    if (platform === 'darwin' && p === '/usr/bin/python3') {
      const clt = await runner('/usr/bin/xcode-select', ['-p'], { timeoutMs: 5000 });
      if (clt.code !== 0) continue;
    }
    // Windows: the Microsoft Store alias in WindowsApps is a stub.
    if (platform === 'win32' && /\\WindowsApps\\/i.test(p)) continue;
    add(p, []);
  }
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
  for (const [cmd, pre] of candidates) {
    const r = await runner(cmd, [...pre, '-c', 'import sys, venv; print("%d.%d" % sys.version_info[:2])'], { timeoutMs: 15000 });
    const m = /^(\d+)\.(\d+)/.exec(String(r.stdout || '').trim());
    if (r.error || r.code !== 0 || !m) continue;
    const v = [Number(m[1]), Number(m[2])];
    if (cmp(v, min) < 0 || (max && cmp(v, max) > 0)) continue;
    return { cmd, args: pre, version: `${v[0]}.${v[1]}` };
  }
  return null;
}

// ------------------------------------------------------------------ Piper manager

/**
 * Finds, installs and runs Piper. Everything that touches the OS can be injected for tests.
 */
class PiperManager {
  /**
   * @param {{root?:string, venvDir?:string, env?:object, platformInfo?:object, which?:(n:string)=>string|null,
   *   runner?:Function, releaseBase?:string, voicesBase?:string, legacyBase?:string, ca?:string|Buffer,
   *   arch?:string, pipSpec?:string}} [opts]
   */
  constructor({ root, venvDir, env, platformInfo, which, runner, releaseBase, voicesBase, legacyBase, ca, arch, pipSpec } = {}) {
    this.env = env || process.env;
    this.rootOverride = root || null;
    this.venvOverride = venvDir || null;
    this.platformInfoOverride = platformInfo || null;
    this.which = typeof which === 'function' ? which : proc.which;
    this.runner = typeof runner === 'function' ? runner : defaultRunner;
    this.releaseBase = releaseBase || this.env.ANYWHERE_PIPER_RELEASE_BASE || DEFAULT_RELEASE_BASE;
    this.voicesBase = voicesBase || this.env.ANYWHERE_PIPER_VOICES_BASE || DEFAULT_VOICES_BASE;
    this.legacyBase = legacyBase || this.env.ANYWHERE_PIPER_LEGACY_BASE || DEFAULT_LEGACY_BASE;
    this.ca = ca || null;
    this.arch = arch || process.arch;
    this.pipSpec = pipSpec || this.env.ANYWHERE_PIPER_PIP_SPEC || PIP_SPEC;
    this.binaryCache = null; // {at, value}
    this.pathProbe = new Map(); // bin → is it Piper TTS?
    this.installing = null; // {voice, stage, percent, message, startedAt}
  }

  /** @private */
  platformInfo() {
    if (!this.platformInfoOverride) this.platformInfoOverride = platformMod.info();
    return this.platformInfoOverride;
  }

  /** @returns {string} stateDir()/voice/piper */
  root() {
    return this.rootOverride || path.join(paths.stateDir(), 'voice', 'piper');
  }

  /** @returns {string} stateDir()/voice/venv */
  venvDir() {
    return this.venvOverride || path.join(path.dirname(this.root()), 'venv');
  }

  /** @returns {string} where voices are kept */
  voicesDir() {
    return path.join(this.root(), 'voices');
  }

  /** @private where the release archive is unpacked (…/bin/piper/piper[.exe]) */
  binDir() {
    return path.join(this.root(), 'bin');
  }

  /** @private */
  exe(name) {
    return this.platformInfo().platform === 'win32' ? `${name}.exe` : name;
  }

  /** @returns {string} the bundled binary's path (it may not exist) */
  bundledPath() {
    return path.join(this.binDir(), 'piper', this.exe('piper'));
  }

  /** @returns {string} the venv entry point's path (it may not exist) */
  venvPiperPath() {
    const v = this.venvDir();
    return this.platformInfo().platform === 'win32' ? path.join(v, 'Scripts', 'piper.exe') : path.join(v, 'bin', 'piper');
  }

  /** @private marker written when the bundled binary failed its self-test */
  brokenMarker() {
    return path.join(this.binDir(), 'BROKEN');
  }

  /**
   * The voice's files.
   * @param {string} id
   * @returns {{onnx:string, json:string}}
   */
  voicePaths(id) {
    if (!validVoiceName(id)) throw piperError(`Invalid voice id "${id}"`, { status: 400, code: 'BAD_VOICE', hint: 'Voice ids look like en_US-lessac-medium (anywhere voice list).' });
    return { onnx: path.join(this.voicesDir(), `${id}.onnx`), json: path.join(this.voicesDir(), `${id}.onnx.json`) };
  }

  /** @returns {boolean} whether the voice's model and config are present */
  voiceInstalled(id) {
    if (!validVoiceName(id)) return false;
    const p = this.voicePaths(id);
    return fileSize(p.onnx) >= 1024 && fileSize(p.json) > 2;
  }

  /** @returns {string[]} installed voice ids */
  installedVoices() {
    let names = [];
    try {
      names = fs.readdirSync(this.voicesDir());
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.onnx'))
      .map((n) => n.slice(0, -5))
      .filter((id) => this.voiceInstalled(id))
      .sort();
  }

  /** @private env for running a binary (its folder on the library path for the bundled one) */
  runEnv(bin) {
    const env = { ...this.env };
    if (bin.kind === 'bundled') {
      const dir = path.dirname(bin.bin);
      const pi = this.platformInfo();
      if (pi.platform === 'linux') env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${dir}${path.delimiter}${env.LD_LIBRARY_PATH}` : dir;
      if (pi.platform === 'darwin') env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH ? `${dir}${path.delimiter}${env.DYLD_LIBRARY_PATH}` : dir;
    }
    if (bin.kind === 'venv') env.PYTHONNOUSERSITE = '1';
    return env;
  }

  /**
   * Does `bin --help` look like Piper TTS? (Linux has an unrelated `piper`: the gaming-mouse GUI.)
   * @private
   */
  async looksLikePiper(bin, kind = 'path') {
    if (this.pathProbe.has(bin)) return this.pathProbe.get(bin);
    const r = await this.runner(bin, ['--help'], { timeoutMs: PROBE_TIMEOUT_MS, env: this.runEnv({ bin, kind }), cwd: path.dirname(bin) });
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    const ok = !r.error && !r.timedOut && /output[_-]file/.test(text) && /--model|-m\b/.test(text);
    this.pathProbe.set(bin, ok);
    return ok;
  }

  /**
   * The Piper binary to use: ANYWHERE_PIPER_PATH, the bundled release binary, the private venv,
   * then `piper` on PATH. Cached for 30 s (refresh:true re-checks).
   * @param {{refresh?:boolean}} [opts]
   * @returns {Promise<{bin:string, kind:'env'|'bundled'|'venv'|'path'}|null>}
   */
  async findBinary({ refresh = false } = {}) {
    if (!refresh && this.binaryCache && Date.now() - this.binaryCache.at < 30000) return this.binaryCache.value;
    const value = await this.locateBinary();
    this.binaryCache = { at: Date.now(), value };
    return value;
  }

  /** @private */
  async locateBinary() {
    const fromEnv = String(this.env.ANYWHERE_PIPER_PATH || '').trim();
    if (fromEnv) {
      const p = path.resolve(fromEnv.replace(/^~(?=$|[\\/])/, os.homedir()));
      if (isFile(p)) return { bin: p, kind: 'env' };
      for (const c of [path.join(p, this.exe('piper')), path.join(p, 'piper', this.exe('piper'))]) if (isFile(c)) return { bin: c, kind: 'env' };
      log.warn(`ANYWHERE_PIPER_PATH (${p}) is not a Piper binary; ignoring it`);
    }
    const bundled = this.bundledPath();
    if (isFile(bundled) && !isFile(this.brokenMarker())) return { bin: bundled, kind: 'bundled' };
    const venv = this.venvPiperPath();
    if (isFile(venv)) return { bin: venv, kind: 'venv' };
    const onPath = this.which('piper');
    if (onPath && (await this.looksLikePiper(onPath))) return { bin: onPath, kind: 'path' };
    return null;
  }

  /**
   * @param {string} [voice] the configured voice
   * @returns {Promise<{installed:boolean, binary:string|null, binaryKind:string|null, voice:string,
   *   voiceInstalled:boolean, installedVoices:string[], installing:object|null}>}
   */
  async status(voice = DEFAULT_VOICE) {
    const id = validVoiceName(voice) ? voice : DEFAULT_VOICE;
    let bin = null;
    try {
      bin = await this.findBinary();
    } catch (err) {
      log.warn(`looking for Piper failed: ${err.message}`);
    }
    const voiceOk = this.voiceInstalled(id);
    return {
      installed: Boolean(bin && voiceOk),
      binary: bin ? bin.bin : null,
      binaryKind: bin ? bin.kind : null,
      voice: id,
      voiceInstalled: voiceOk,
      installedVoices: this.installedVoices(),
      installing: this.installing ? { ...this.installing } : null,
    };
  }

  /**
   * Synthesize text to a WAV file.
   * @param {string} text plain text (one line is best; newlines are joined)
   * @param {{voice?:string, outFile:string, lengthScale?:number, speaker?:number, timeoutMs?:number, signal?:AbortSignal}} opts
   * @returns {Promise<{path:string, durationMs:number, sampleRate:number, voice:string, binaryKind:string, ms:number}>}
   */
  async synthesize(text, { voice = DEFAULT_VOICE, outFile, lengthScale = 1, speaker, timeoutMs = SYNTH_TIMEOUT_MS, signal } = {}) {
    const clean = String(text == null ? '' : text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TEXT);
    if (!clean) throw piperError('Nothing to speak', { status: 400 });
    if (!outFile) throw piperError('synthesize() needs outFile', { status: 500 });
    const bin = await this.findBinary();
    if (!bin) {
      throw piperError('The neural voice (Piper) is not installed', {
        status: 503,
        code: 'PIPER_NOT_INSTALLED',
        hint: 'Install it for free (offline, about 80 MB): anywhere voice install, or Settings > Voice > Install.',
      });
    }
    if (!this.voiceInstalled(voice)) {
      throw piperError(`The voice ${voice} is not installed`, { status: 503, code: 'PIPER_VOICE_MISSING', hint: `Install it: anywhere voice install --voice ${voice}` });
    }
    const vp = this.voicePaths(voice);
    fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
    const tmp = `${outFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.wav`;
    const args = ['--model', vp.onnx, '--config', vp.json, '--output_file', tmp];
    const ls = Number(lengthScale);
    if (Number.isFinite(ls) && ls > 0 && Math.abs(ls - 1) > 0.01) args.push('--length_scale', String(Math.round(ls * 100) / 100));
    if (Number.isInteger(speaker) && speaker >= 0) args.push('--speaker', String(speaker));
    if (bin.kind === 'bundled') args.push('--quiet');
    const started = Date.now();
    const r = await this.runner(bin.bin, args, { input: `${clean}\n`, timeoutMs, signal, env: this.runEnv(bin), cwd: path.dirname(bin.bin) });
    try {
      if (r.aborted || (signal && signal.aborted)) throw piperError('Speech synthesis was cancelled', { status: 499, code: 'ABORTED' });
      if (r.error) throw piperError(`Could not run Piper (${bin.bin}): ${r.error.message}`, { status: 502, code: 'PIPER_FAILED', hint: 'Reinstall it: anywhere voice install --force' });
      if (r.timedOut) throw piperError(`Piper took longer than ${Math.round(timeoutMs / 1000)} s`, { status: 504, code: 'PIPER_TIMEOUT', hint: 'Try a smaller voice (a "medium" one) or shorter text.' });
      if (r.code !== 0) throw piperError(`Piper failed (exit ${r.code}): ${tail(r.stderr) || 'no output'}`, { status: 502, code: 'PIPER_FAILED', hint: 'Reinstall it: anywhere voice install --force' });
      const info = wavFileInfo(tmp);
      if (!info || info.durationMs <= 0) throw piperError('Piper produced no audio', { status: 502, code: 'PIPER_FAILED', hint: tail(r.stderr) || undefined });
      fs.renameSync(tmp, outFile);
      return { path: outFile, durationMs: info.durationMs, sampleRate: info.sampleRate, voice, binaryKind: bin.kind, ms: Date.now() - started };
    } finally {
      rmrf(tmp);
    }
  }

  // ---------------------------------------------------------------- install

  /** @private exclusive install lock (the daemon and `anywhere voice install` share the folder) */
  lock() {
    fs.mkdirSync(this.root(), { recursive: true, mode: 0o700 });
    const file = path.join(this.root(), 'install.lock');
    for (let i = 0; i < 2; i += 1) {
      try {
        const fd = fs.openSync(file, 'wx', 0o600);
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        fs.closeSync(fd);
        return () => {
          try {
            const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (cur && cur.pid !== process.pid) return;
          } catch {
            /* unreadable: ours */
          }
          rmrf(file);
        };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        holder = null;
      }
      let alive = false;
      if (holder && holder.pid && holder.pid !== process.pid) {
        try {
          process.kill(holder.pid, 0);
          alive = true;
        } catch (e) {
          alive = e.code === 'EPERM';
        }
      }
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // released meanwhile
      }
      if (alive && age < LOCK_STALE_MS) {
        throw piperError(`Another voice install is running (pid ${holder.pid})`, { status: 409, code: 'INSTALL_BUSY', hint: 'Wait for it to finish (anywhere voice status).' });
      }
      rmrf(file);
    }
    throw piperError('Could not take the voice install lock', { status: 409, code: 'INSTALL_BUSY' });
  }

  /**
   * Install Piper (if needed) and a voice, then check that it speaks.
   * @param {{voice?:string, force?:boolean, onProgress?:(p:{stage:string, percent:number, stagePercent?:number|null, message:string, voice:string})=>void,
   *   signal?:AbortSignal}} [opts]
   * @returns {Promise<{ok:true, voice:string, binary:string, binaryKind:string, testMs:number, durationMs:number}>}
   */
  async install({ voice = DEFAULT_VOICE, force = false, onProgress, signal } = {}) {
    if (!validVoiceName(voice) || (!parseVoiceId(voice) && !this.voiceInstalled(voice))) {
      throw piperError(`Unknown voice id "${voice}"`, { status: 400, code: 'BAD_VOICE', hint: 'Pick one from: anywhere voice list (ids look like en_US-lessac-medium).' });
    }
    const unlock = this.lock();
    const state = { voice, stage: 'binary', percent: 0, message: 'Starting…', startedAt: new Date().toISOString() };
    this.installing = state;
    let lastPct = -1;
    const report = (stage, percent, message, stagePercent = null) => {
      const pct = Math.max(lastPct, Math.min(100, Math.round(percent)));
      lastPct = pct;
      Object.assign(state, { stage, percent: pct, message });
      if (typeof onProgress === 'function') {
        try {
          onProgress({ stage, percent: pct, stagePercent, message, voice });
        } catch {
          /* ignore */
        }
      }
    };
    try {
      // 1. The engine.
      report('binary', 1, 'Looking for Piper…');
      let bin = force ? null : await this.findBinary({ refresh: true });
      if (bin && bin.kind === 'bundled' && !(await this.binaryRuns(bin))) {
        this.markBroken('the binary does not start');
        bin = await this.findBinary({ refresh: true });
      }
      if (!bin) bin = await this.installBinary({ report, signal });
      report('binary', 40, `Piper is ready (${bin.kind === 'venv' ? 'Python package' : bin.kind === 'bundled' ? 'release binary' : bin.bin}).`);

      // 2. The voice.
      if (force || !this.voiceInstalled(voice)) await this.installVoice(voice, { report, signal });
      else report('voice', 90, `The voice ${voice} is already installed.`);

      // 3. Check that it speaks.
      report('verify', 92, 'Testing the voice…');
      let test;
      try {
        test = await this.selfTest(voice, { signal });
      } catch (err) {
        if (!bin || bin.kind !== 'bundled') throw err;
        report('verify', 92, `The Piper release binary failed its test (${err.message}); using the Python package instead…`);
        this.markBroken(err.message);
        bin = await this.setupVenv({ report, signal });
        test = await this.selfTest(voice, { signal });
      }
      bin = (await this.findBinary({ refresh: true })) || bin;
      const entry = catalogEntry(voice);
      report('done', 100, `${entry ? entry.name : voice} is ready. It runs offline and costs nothing.`);
      return { ok: true, voice, binary: bin.bin, binaryKind: bin.kind, testMs: test.ms, durationMs: test.durationMs };
    } catch (err) {
      report('error', lastPct < 0 ? 0 : lastPct, err.hint ? `${err.message}. ${err.hint}` : err.message);
      throw err;
    } finally {
      this.installing = null;
      this.binaryCache = null;
      unlock();
    }
  }

  /** @private synthesize a short phrase and check the WAV */
  async selfTest(voice, { signal } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-piper-'));
    try {
      this.binaryCache = null;
      return await this.synthesize('Hello! Your new voice is ready.', { voice, outFile: path.join(dir, 'test.wav'), signal });
    } finally {
      rmrf(dir);
    }
  }

  /** @private */
  async binaryRuns(bin) {
    const r = await this.runner(bin.bin, ['--help'], { timeoutMs: PROBE_TIMEOUT_MS, env: this.runEnv(bin), cwd: path.dirname(bin.bin) });
    const ok = !r.error && !r.timedOut && r.code === 0 && /output[_-]file/.test(`${r.stdout}\n${r.stderr}`);
    if (!ok) log.warn(`${bin.bin} --help failed: ${r.error ? r.error.message : r.timedOut ? 'timed out' : `exit ${r.code} ${tail(r.stderr, 200)}`}`);
    return ok;
  }

  /** @private */
  markBroken(why) {
    try {
      fs.mkdirSync(this.binDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.brokenMarker(), `${new Date().toISOString()} ${why}\n`, { mode: 0o600 });
    } catch {
      /* ignore */
    }
    this.binaryCache = null;
  }

  /** @private download and unpack the release binary; fall back to the venv when it does not run */
  async installBinary({ report, signal }) {
    const pi = this.platformInfo();
    const asset = releaseAsset(pi.platform, this.arch, { base: this.releaseBase });
    if (asset && asset.usable) {
      try {
        const bin = await this.downloadRelease(asset, { report, signal });
        if (await this.binaryRuns(bin)) return bin;
        this.markBroken('the binary does not start');
        report('binary', 34, 'The Piper release binary does not run on this machine; using the Python package instead…');
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        log.debug(`installing the Piper release binary failed: ${err.message}; trying the Python package`);
        report('binary', 30, `The Piper binary did not work here (${err.message}); using the Python package instead…`);
      }
    }
    return this.setupVenv({ report, signal });
  }

  /** @private */
  async downloadRelease(asset, { report, signal }) {
    const dl = path.join(this.root(), 'downloads');
    const archive = path.join(dl, asset.name);
    report('binary', 2, `Downloading Piper (${asset.name})…`);
    if (!isFile(archive) || fileSize(archive) < MIN_BINARY_ARCHIVE_BYTES) {
      await downloadFile(asset.url, archive, {
        minBytes: MIN_BINARY_ARCHIVE_BYTES,
        maxBytes: 300 * 1024 * 1024,
        signal,
        ca: this.ca,
        env: this.env,
        onProgress: (p) => report('binary', 2 + (p.percent || 0) * 0.3, `Downloading Piper… ${p.total ? `${mb(p.received)} of ${mb(p.total)}` : mb(p.received)}`, p.percent),
      });
    }
    report('binary', 33, 'Unpacking Piper…');
    const staging = path.join(this.root(), `bin.new-${process.pid}`);
    rmrf(staging);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      await this.extract(archive, staging, asset.kind);
      const exe = path.join(staging, 'piper', this.exe('piper'));
      if (!isFile(exe)) throw piperError(`The archive ${asset.name} has no piper/${this.exe('piper')}`, { status: 502, code: 'BAD_ARCHIVE' });
      if (this.platformInfo().platform !== 'win32') {
        for (const f of ['piper', 'piper_phonemize', 'espeak-ng']) {
          try {
            fs.chmodSync(path.join(staging, 'piper', f), 0o755);
          } catch {
            /* not in this build */
          }
        }
      }
      rmrf(this.binDir());
      fs.renameSync(staging, this.binDir());
    } finally {
      rmrf(staging);
    }
    rmrf(archive);
    this.binaryCache = null;
    return { bin: this.bundledPath(), kind: 'bundled' };
  }

  /**
   * Unpack a .tar.gz or .zip archive.
   * @param {string} archive
   * @param {string} dest an existing empty folder
   * @param {'tar.gz'|'zip'} kind
   */
  async extract(archive, dest, kind) {
    const pi = this.platformInfo();
    const attempts = [];
    const sysTar =
      pi.platform === 'win32' ? path.win32.join(this.env.SystemRoot || this.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe') : null;
    // Windows: System32\tar.exe is bsdtar (reads zip); a Git-for-Windows GNU tar on PATH is not.
    const tar = pi.platform === 'win32' ? (sysTar && isFile(sysTar) ? sysTar : null) : this.which('tar');
    // --no-same-owner: running as root must not hand the files to the archive's build user.
    const own = pi.platform === 'win32' ? [] : ['--no-same-owner'];
    if (kind === 'tar.gz') {
      if (tar) attempts.push([tar, ['-xzf', archive, ...own, '-C', dest]]);
    } else {
      if (tar && pi.platform !== 'linux') attempts.push([tar, ['-xf', archive, ...own, '-C', dest]]);
      const bsdtar = this.which('bsdtar');
      if (bsdtar) attempts.push([bsdtar, ['-xf', archive, ...own, '-C', dest]]);
      const unzip = this.which('unzip');
      if (unzip) attempts.push([unzip, ['-q', '-o', archive, '-d', dest]]);
      if (pi.platform === 'win32') {
        const ps = this.which('powershell') || this.which('powershell.exe') || 'powershell.exe';
        const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
        const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(dest)} -Force`;
        attempts.push([ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]]);
      }
    }
    const errors = [];
    for (const [cmd, args] of attempts) {
      const r = await this.runner(cmd, args, { timeoutMs: 180000 });
      if (!r.error && !r.timedOut && r.code === 0) return;
      errors.push(`${path.basename(cmd)}: ${r.error ? r.error.message : r.timedOut ? 'timed out' : tail(r.stderr, 200) || `exit ${r.code}`}`);
    }
    throw piperError(`Could not unpack ${path.basename(archive)}${errors.length ? `: ${errors.join('; ')}` : ': no tar or unzip found'}`, {
      status: 500,
      code: 'EXTRACT_FAILED',
      hint: pi.platform === 'linux' ? 'Install tar and unzip (sudo apt install tar unzip).' : undefined,
    });
  }

  /**
   * A Python 3.9+ interpreter for the venv (never the user's packages: only its venv module).
   * @private
   * @returns {Promise<{cmd:string, args:string[], version:string}|null>}
   */
  async findPython() {
    return findPython({ env: this.env, which: this.which, runner: this.runner, platform: this.platformInfo().platform });
  }

  /**
   * Install piper-tts into a private venv (stateDir()/voice/venv).
   * @private
   * @returns {Promise<{bin:string, kind:'venv'}>}
   */
  async setupVenv({ report, signal }) {
    const pi = this.platformInfo();
    report('binary', 34, 'Setting up Piper in a private Python environment…');
    const python = await this.findPython();
    if (!python) {
      throw piperError('Piper needs Python 3.9 or newer on this machine (the ready-made binary does not run here)', {
        status: 503,
        code: 'NO_PYTHON',
        hint:
          pi.platform === 'darwin'
            ? 'Install Python (brew install python, or python.org), then run: anywhere voice install. Or set ANYWHERE_PIPER_PATH to a piper binary.'
            : pi.platform === 'win32'
              ? 'Install Python from python.org (or: winget install Python.Python.3.12), then run: anywhere voice install.'
              : 'Install Python 3 with venv (sudo apt install python3 python3-venv), then run: anywhere voice install.',
      });
    }
    const venv = this.venvDir();
    const vpy = pi.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
    if (!isFile(vpy)) {
      rmrf(venv);
      const r = await this.runner(python.cmd, [...python.args, '-m', 'venv', venv], { timeoutMs: VENV_TIMEOUT_MS, signal });
      if (r.error || r.timedOut || r.code !== 0 || !isFile(vpy)) {
        rmrf(venv);
        const why = r.error ? r.error.message : r.timedOut ? 'timed out' : tail(r.stderr || r.stdout, 300);
        throw piperError(`Could not create a Python venv: ${why}`, {
          status: 500,
          code: 'VENV_FAILED',
          hint: /ensurepip|venv/i.test(why) && pi.platform === 'linux' ? 'Install the venv module: sudo apt install python3-venv' : 'Check that Python works (python3 -m venv --help).',
        });
      }
    }
    report('binary', 36, `Installing ${this.pipSpec} from PyPI (about 35 MB)…`);
    let lines = 0;
    const onOut = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const m = /^(Collecting|Downloading|Installing collected packages|Successfully installed)\s*(.*)$/.exec(line.trim());
        if (!m) continue;
        lines += 1;
        report('binary', Math.min(39, 36 + lines * 0.2), `pip: ${m[1]} ${tail(m[2], 80)}`.trim());
      }
    };
    const env = { ...this.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONNOUSERSITE: '1' };
    const r = await this.runner(vpy, ['-m', 'pip', 'install', '--upgrade', this.pipSpec], { timeoutMs: PIP_TIMEOUT_MS, signal, env, onStdout: onOut });
    if (r.aborted) throw piperError('The install was cancelled', { code: 'ABORTED' });
    if (r.error || r.timedOut || r.code !== 0 || !isFile(this.venvPiperPath())) {
      const why = r.error ? r.error.message : r.timedOut ? `took longer than ${PIP_TIMEOUT_MS / 60000} minutes` : tail(r.stderr || r.stdout, 400);
      throw piperError(`pip could not install piper-tts: ${why}`, {
        status: 502,
        code: 'PIP_FAILED',
        hint: 'Check your internet connection (and HTTPS_PROXY), then run: anywhere voice install. Or set ANYWHERE_PIPER_PATH to a piper binary.',
      });
    }
    this.binaryCache = null;
    return { bin: this.venvPiperPath(), kind: 'venv' };
  }

  /** @private download a voice's model and config (Hugging Face, else the GitHub release) */
  async installVoice(id, { report, signal }) {
    const entry = catalogEntry(id);
    const size = entry ? `about ${entry.sizeMb} MB` : 'about 60–120 MB';
    const vp = this.voicePaths(id);
    const urls = voiceUrls(id, { base: this.voicesBase });
    if (!urls) throw piperError(`Unknown voice id "${id}"`, { status: 400, code: 'BAD_VOICE' });
    report('voice', 41, `Downloading the voice ${entry ? entry.name : id} (${size})…`);
    const tmpJson = `${vp.json}.download`;
    try {
      await downloadFile(urls.json, tmpJson, { minBytes: 64, maxBytes: 2 * 1024 * 1024, signal, ca: this.ca, env: this.env, resume: false });
      checkVoiceConfig(tmpJson);
      await downloadFile(urls.onnx, vp.onnx, {
        minBytes: MIN_MODEL_BYTES,
        maxBytes: 600 * 1024 * 1024,
        signal,
        ca: this.ca,
        env: this.env,
        onProgress: (p) => report('voice', 41 + (p.percent || 0) * 0.49, `Downloading the voice… ${p.total ? `${mb(p.received)} of ${mb(p.total)}` : mb(p.received)}`, p.percent),
      });
      fs.renameSync(tmpJson, vp.json);
      return;
    } catch (err) {
      rmrf(tmpJson);
      if (err.code === 'ABORTED' || !entry || !entry.legacy || err.code === 'NOT_FOUND') throw err;
      // The progress message tells the user; the log keeps the detail.
      log.debug(`downloading ${id} from ${new URL(this.voicesBase).host} failed (${err.message}); trying the GitHub release`);
      report('voice', 42, `Hugging Face is not reachable (${err.message}); downloading the voice from GitHub instead…`);
    }
    await this.installLegacyVoice(id, entry.legacy, { report, signal });
  }

  /** @private the original GitHub release ships voices as voice-<name>.tar.gz */
  async installLegacyVoice(id, asset, { report, signal }) {
    const vp = this.voicePaths(id);
    const dl = path.join(this.root(), 'downloads');
    const archive = path.join(dl, `${asset}.tar.gz`);
    await downloadFile(`${String(this.legacyBase).replace(/\/+$/, '')}/${asset}.tar.gz`, archive, {
      minBytes: MIN_MODEL_BYTES,
      maxBytes: 600 * 1024 * 1024,
      signal,
      ca: this.ca,
      env: this.env,
      onProgress: (p) => report('voice', 42 + (p.percent || 0) * 0.46, `Downloading the voice… ${p.total ? `${mb(p.received)} of ${mb(p.total)}` : mb(p.received)}`, p.percent),
    });
    report('voice', 89, 'Unpacking the voice…');
    const staging = path.join(dl, `${asset}-${process.pid}`);
    rmrf(staging);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      await this.extract(archive, staging, 'tar.gz');
      const files = listFiles(staging);
      const onnx = files.find((f) => f.endsWith('.onnx'));
      const json = files.find((f) => f.endsWith('.onnx.json'));
      if (!onnx || !json || fileSize(onnx) < MIN_MODEL_BYTES) throw piperError(`The voice archive ${asset}.tar.gz has no model`, { status: 502, code: 'BAD_ARCHIVE' });
      checkVoiceConfig(json);
      fs.mkdirSync(this.voicesDir(), { recursive: true, mode: 0o700 });
      fs.copyFileSync(json, vp.json);
      fs.renameSync(onnx, vp.onnx);
    } catch (err) {
      rmrf(vp.json);
      throw err;
    } finally {
      rmrf(staging);
      rmrf(archive);
    }
  }

  /**
   * Delete an installed voice.
   * @param {string} id
   * @returns {boolean} whether it was installed
   */
  removeVoice(id) {
    const vp = this.voicePaths(id);
    const had = this.voiceInstalled(id);
    for (const p of [vp.onnx, vp.json, `${vp.onnx}.part`, `${vp.json}.download`]) rmrf(p);
    return had;
  }
}

/** Every file under a folder (recursive). */
function listFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/** Throw unless the file is a Piper voice config (JSON with audio.sample_rate). */
function checkVoiceConfig(file) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw piperError(`The voice config is not valid JSON (${err.message}): the server sent something else`, { status: 502, code: 'BAD_DOWNLOAD' });
  }
  const rate = j && j.audio && Number(j.audio.sample_rate);
  if (!rate || rate < 8000 || rate > 96000 || !(j.phoneme_id_map || j.espeak || j.phoneme_type)) {
    throw piperError('The voice config is not a Piper voice (no audio.sample_rate / phoneme map)', { status: 502, code: 'BAD_DOWNLOAD' });
  }
  return j;
}

module.exports = {
  PiperManager,
  TtsCache,
  CATALOG,
  DEFAULT_VOICE,
  RELEASE_TAG,
  DEFAULT_RELEASE_BASE,
  DEFAULT_VOICES_BASE,
  DEFAULT_LEGACY_BASE,
  PIP_SPEC,
  parseVoiceId,
  validVoiceName,
  catalogEntry,
  voiceUrls,
  releaseAsset,
  wavInfo,
  wavFileInfo,
  noProxyMatch,
  proxyFor,
  httpGet,
  downloadFile,
  checkVoiceConfig,
  defaultRunner,
  findPython,
};
