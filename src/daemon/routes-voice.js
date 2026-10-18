'use strict';

/**
 * HTTP routes for the neural voice and spoken announcements (registered by server.js):
 *
 *   GET  /api/tts/audio?id=<id>     the WAV of a synthesize() id (32 hex) or a chime (chime-<kind>)
 *   POST /api/tts/synthesize {text} → {id, mime, engine, durationMs}
 *   GET  /api/voice/status          → {engine, ttsEngine, piper:{installed, binary, voice, installedVoices, catalog}, os:{provider}}
 *   POST /api/voice/install {voice?, force?} → {ok, started:true}; progress as SSE 'voice_install'
 *        {stage:'binary'|'voice'|'verify'|'done'|'error', percent (overall 0-100), stagePercent, message, voice}
 *   POST /api/voice/use {voice}     → {ok, voice}: makes an installed voice the Piper voice
 *   POST /api/voice/test {text?}    → {ok, delivered, engine}: plays a sample through the announce path
 *   POST /api/voice/remove {voice}  → {ok, removed}
 *
 * Handlers run with `this` bound to the DaemonServer (server.deps has voice, announcer, config, hub).
 */

const fs = require('fs');
const { SECURITY_HEADERS } = require('./server');
const piperMod = require('./piper');
const { CHIME_KINDS, chimeFile } = require('./chime');
const { createLogger } = require('../shared/log');

const log = createLogger('routes-voice');

const AUDIO_ID_RE = /^[a-f0-9]{32}$/;
const CHIME_ID_RE = new RegExp(`^chime-(${CHIME_KINDS.join('|')})$`);
const MAX_SYNTH_CHARS = 5000;

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

/**
 * Whether an audio id is one this route serves: a synthesize() id or a chime name. Nothing else
 * (no dots, slashes or other characters) can reach the file system.
 * @param {*} id
 * @returns {boolean}
 */
function validAudioId(id) {
  return typeof id === 'string' && (AUDIO_ID_RE.test(id) || CHIME_ID_RE.test(id));
}

/**
 * The file behind an audio id, or null.
 * @param {object|null} voice VoiceService
 * @param {string} id
 * @param {{chimeDir?:string}} [opts]
 * @returns {string|null}
 */
function audioPathFor(voice, id, { chimeDir } = {}) {
  if (!validAudioId(id)) return null;
  const chime = CHIME_ID_RE.exec(id);
  if (chime) return chimeFile(chime[1], chimeDir ? { dir: chimeDir } : {});
  if (!voice || typeof voice.audioFile !== 'function') return null;
  return voice.audioFile(id);
}

function voiceOf(server) {
  const v = server.deps && server.deps.voice;
  if (!v) throw httpError(503, 'Voice is not available in this daemon');
  return v;
}

function refresh(server) {
  const v = server.deps.voice;
  if (v && typeof v.invalidate === 'function') v.invalidate();
  if (typeof server.deps.refreshVoice === 'function') {
    try {
      server.deps.refreshVoice();
    } catch (err) {
      log.warn(`refreshing voice capabilities failed: ${err.message}`);
    }
  }
}

/** Save voice.piperVoice like POST /api/config does (validated, broadcast, applied). */
function savePiperVoice(server, id) {
  if (typeof server.saveConfig === 'function') return server.saveConfig({ body: { voice: { piperVoice: id } } });
  const configMod = require('../shared/config');
  const next = configMod.save({ voice: { piperVoice: id } });
  for (const k of Object.keys(next)) server.deps.config[k] = next[k];
  return configMod.publicConfig(server.deps.config);
}

/** @this {object} DaemonServer */
async function audio({ req, res, url }) {
  const id = url.searchParams.get('id') || '';
  if (!validAudioId(id)) throw httpError(400, 'id must be an audio id from /api/tts/synthesize');
  const file = audioPathFor(this.deps.voice, id);
  let st = null;
  try {
    st = file ? fs.statSync(file) : null;
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) throw httpError(404, 'No such audio (it may have been replaced by newer speech); synthesize it again');
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'audio/wav', 'Content-Length': st.size });
  if (req.method === 'HEAD') {
    res.end();
    return undefined;
  }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      log.warn(`reading ${file} failed: ${err.message}`);
      res.destroy(err);
      resolve();
    });
    stream.on('end', resolve);
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
  return undefined;
}

/** @this {object} DaemonServer */
async function synthesize({ body }) {
  if (typeof body.text !== 'string' || !body.text.trim()) throw httpError(400, 'text must be a non-empty string');
  if (body.voice != null && (typeof body.voice !== 'string' || !piperMod.validVoiceName(body.voice))) throw httpError(400, 'voice must be a voice id such as en_US-lessac-medium');
  const voice = voiceOf(this);
  if (typeof voice.synthesize !== 'function') throw httpError(503, 'This daemon cannot synthesize speech');
  try {
    const out = await voice.synthesize(body.text.slice(0, MAX_SYNTH_CHARS), { voice: body.voice || undefined, rate: typeof body.rate === 'number' ? body.rate : undefined });
    return { id: out.id, mime: out.mime, engine: out.engine, durationMs: out.durationMs, cached: Boolean(out.cached) };
  } catch (err) {
    throw httpError(err.status && err.status >= 400 && err.status < 600 ? err.status : 502, err.message, { hint: err.hint, code: err.code });
  }
}

/** @this {object} DaemonServer */
async function status() {
  const voice = voiceOf(this);
  if (typeof voice.voiceStatus !== 'function') throw httpError(503, 'This daemon has no neural voice support');
  const out = await voice.voiceStatus();
  if (this._voiceInstall) out.piper.installing = { ...this._voiceInstall.progress };
  out.announcer = Boolean(this.deps.announcer);
  return out;
}

/** @this {object} DaemonServer */
function install({ body }) {
  const voice = voiceOf(this);
  if (typeof voice.installPiper !== 'function') throw httpError(503, 'This daemon has no neural voice support');
  const id = body.voice == null || body.voice === '' ? null : body.voice;
  if (id !== null && (typeof id !== 'string' || !piperMod.parseVoiceId(id))) {
    throw httpError(400, 'voice must be a Piper voice id such as en_US-lessac-medium', { hint: 'See GET /api/voice/status (catalog) or: anywhere voice list' });
  }
  if (this._voiceInstall) return { ok: true, started: false, running: true, voice: this._voiceInstall.voice };
  const target = id || (typeof voice.piperVoiceId === 'function' ? voice.piperVoiceId() : piperMod.DEFAULT_VOICE);
  const job = { voice: target, progress: { stage: 'binary', percent: 0, message: 'Starting…', voice: target } };
  this._voiceInstall = job;
  const emit = (p) => {
    job.progress = { stage: p.stage, percent: p.percent, stagePercent: p.stagePercent == null ? null : p.stagePercent, message: p.message, voice: target };
    this.hub.broadcast('voice_install', job.progress);
  };
  Promise.resolve()
    .then(() => voice.installPiper({ voice: target, force: body.force === true, onProgress: emit }))
    .then(
      (r) => {
        const current = this.deps.config && this.deps.config.voice && this.deps.config.voice.piperVoice;
        if (id || current !== target) {
          try {
            savePiperVoice(this, target);
          } catch (err) {
            log.warn(`could not save voice.piperVoice: ${err.message}`);
          }
        }
        log.info(`Piper voice ${target} installed (${r.binaryKind}; test took ${r.testMs} ms)`);
      },
      (err) => {
        log.warn(`installing the Piper voice ${target} failed: ${err.message}`);
        // install() reports 'error' itself; this covers failures before it could (a busy lock).
        if (job.progress.stage !== 'error') emit({ stage: 'error', percent: job.progress.percent || 0, message: err.hint ? `${err.message}. ${err.hint}` : err.message });
      },
    )
    .finally(() => {
      if (this._voiceInstall === job) this._voiceInstall = null;
      refresh(this);
    });
  return { ok: true, started: true, voice: target };
}

/** @this {object} DaemonServer */
function use({ body }) {
  const voice = voiceOf(this);
  const id = body.voice;
  if (typeof id !== 'string' || !piperMod.validVoiceName(id)) throw httpError(400, 'voice must be a voice id such as en_US-lessac-medium');
  if (voice.piper && typeof voice.piper.voiceInstalled === 'function' && !voice.piper.voiceInstalled(id)) {
    throw httpError(409, `The voice ${id} is not installed`, { hint: `Install it first: anywhere voice install --voice ${id} (or POST /api/voice/install).` });
  }
  savePiperVoice(this, id);
  refresh(this);
  return { ok: true, voice: id };
}

/** @this {object} DaemonServer */
async function test({ body }) {
  if (body.text != null && typeof body.text !== 'string') throw httpError(400, 'text must be a string');
  const text = typeof body.text === 'string' ? body.text.slice(0, 600) : '';
  const announcer = this.deps.announcer;
  if (announcer && typeof announcer.test === 'function') return announcer.test(text);
  const voice = voiceOf(this);
  const out = await voice.speak(text || "Hi! This is how I'll sound.", {});
  return { ok: Boolean(out && out.ok), delivered: 'local', engine: (out && out.provider) || null };
}

/** @this {object} DaemonServer */
function remove({ body }) {
  const voice = voiceOf(this);
  const id = body.voice;
  if (typeof id !== 'string' || !piperMod.validVoiceName(id)) throw httpError(400, 'voice must be a voice id such as en_US-lessac-medium');
  if (!voice.piper || typeof voice.piper.removeVoice !== 'function') throw httpError(503, 'This daemon has no neural voice support');
  if (this._voiceInstall && this._voiceInstall.voice === id) throw httpError(409, `The voice ${id} is being installed`);
  const removed = voice.piper.removeVoice(id);
  refresh(this);
  return { ok: true, removed };
}

/**
 * Register the routes (server.js calls this with its route adder).
 * @param {(method:string, path:string, fn:Function, opts?:object)=>void} add
 */
function register(add) {
  add('GET', '/api/tts/audio', audio, { noBody: true });
  add('POST', '/api/tts/synthesize', synthesize);
  add('GET', '/api/voice/status', status, { noBody: true });
  add('POST', '/api/voice/install', install);
  add('POST', '/api/voice/use', use);
  add('POST', '/api/voice/test', test);
  add('POST', '/api/voice/remove', remove);
}

module.exports = { register, validAudioId, audioPathFor };
