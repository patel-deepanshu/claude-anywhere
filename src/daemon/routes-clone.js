'use strict';

/**
 * HTTP routes for the consent-gated cloned voice (docs/CALLS-DESIGN.md §2, §10.4), registered by
 * server.js. Every route needs the daemon token.
 *
 *   GET  /api/clone/status[?light=1]  → {enabled, engine, installed, engines, profile:{exists, ok, engine, createdAt,
 *                                        testSimilarity}, bench, installing, session, owner, openSeq, openAck}
 *   POST /api/clone/install {engine?, stt?} → {ok, started}; progress as SSE 'clone_install' {stage, percent, message}
 *   POST /api/clone/session {ownerName?}    → {sessionId, consent:{text, expiresAt}, lines, ownerName, takes, …}
 *   GET  /api/clone/session?session=<id>    → the same for an existing session (renews an expired code)
 *   POST /api/clone/session/renew?session=  → {text, expiresAt}: a fresh consent code
 *   POST /api/clone/session/cancel?session= → {ok}
 *   POST /api/clone/take?session=&kind=consent|line&index=<0-13>
 *        raw audio/wav body (24 kHz mono 16-bit, 2–30 s, ≤ 5 MB) + header X-Anywhere-Device-Label (URI-encoded)
 *        → {ok, quality, problems, transcript?, consent?}
 *   POST /api/clone/build?session=          → {ok, similarity, label, testAudioId, testText, consistency}; 422 with
 *                                             {ok:false, code:'TAKES_INCONSISTENT', retake} or 'CONSENT_SPEAKER_MISMATCH'
 *   POST /api/clone/test {text?, engine?, score?, play?:'local'} → {audioId, text, engine, similarity, label, played?}
 *   GET  /api/clone/audio?id=<32 hex>       → audio/wav (test and phrase playback in the dialog)
 *   POST /api/clone/engine {engine}         → {ok, engine}: use the installed pocket or zipvoice engine
 *   POST /api/clone/bench                   → the installer's speed benchmark
 *   POST /api/clone/delete {confirm:'delete'} → {ok, removed}; also disarms calls
 *   POST /api/clone/open                    → {ok, seq, host}: show the dialog on the enrollment view
 *        (SSE 'clone_session' {step:'open', seq}); POST /api/clone/opened {seq} is the page's acknowledgement
 *   POST /api/clone/standalone              → {url}: /clone.html with a single-use launch code (60 s)
 *
 * SSE 'clone_session' {sessionId, step, …} never carries the consent code.
 * The one CloneService of the daemon lives in server.deps.clone (getCloneService); the calls
 * routes use the same instance.
 */

const fs = require('fs');
const { SECURITY_HEADERS } = require('./server');
const { createLogger, audit } = require('../shared/log');

const log = createLogger('routes-clone');

const TAKE_LIMIT = 5 * 1024 * 1024;
const WAV_TYPES = /^(audio\/(wav|wave|x-wav|vnd\.wave)|application\/octet-stream)$/i;
const ENGINES = ['pocket', 'zipvoice'];
const STT_MODELS = ['moonshine', 'whisper-tiny', 'parakeet'];

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function sendJson(res, status, obj) {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** A service error as a JSON response that keeps its details (problems, missing lines, retakes). */
function sendError(res, err) {
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500 && status !== 503) log.warn(`clone request failed: ${err && err.message}`);
  const body = { ok: false, error: (err && err.message) || 'Internal error' };
  for (const k of ['code', 'hint', 'problems', 'missing', 'retake']) if (err && err[k] != null && !(k === 'code' && typeof err[k] !== 'string')) body[k] = err[k];
  sendJson(res, status, body);
}

function contentTypeOf(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

/** The X-Anywhere-Device-Label header (URI-encoded UTF-8, since header values are Latin-1). */
function deviceLabelOf(req) {
  const raw = req.headers['x-anywhere-device-label'];
  if (typeof raw !== 'string') return '';
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

/** Save config like POST /api/config does (validated, broadcast, applied). */
function saveConfig(server, partial) {
  if (typeof server.saveConfig === 'function') return server.saveConfig({ body: partial });
  const configMod = require('../shared/config');
  const next = configMod.save(partial);
  if (server.deps && server.deps.config) for (const k of Object.keys(next)) server.deps.config[k] = next[k];
  return next;
}

function disarmCalls(server, why) {
  const calls = server.deps && server.deps.calls;
  if (!calls || typeof calls.disarm !== 'function') return;
  try {
    const r = calls.disarm(why);
    if (r && typeof r.catch === 'function') r.catch((err) => log.warn(`disarming calls failed: ${err.message}`));
  } catch (err) {
    log.warn(`disarming calls failed: ${err.message}`);
  }
}

/**
 * The daemon's CloneService (created on first use, kept in server.deps.clone, its events
 * broadcast as SSE 'clone_install' and 'clone_session').
 * @param {object} server DaemonServer
 * @returns {import('../voice/clone').CloneService}
 */
function getCloneService(server) {
  const deps = server.deps || (server.deps = {});
  let svc = deps.clone;
  if (!svc) {
    if (typeof deps.cloneFactory === 'function') svc = deps.cloneFactory({ config: deps.config, server });
    else {
      const { CloneService } = require('../voice/clone');
      svc = new CloneService({ config: deps.config, saveConfig: (partial) => saveConfig(server, partial) });
    }
    deps.clone = svc;
  }
  if (!svc._routesWired && typeof svc.on === 'function') {
    svc._routesWired = true;
    svc.on('install', (p) => server.hub && server.hub.broadcast('clone_install', p));
    svc.on('session', (e) => server.hub && server.hub.broadcast('clone_session', e));
    svc.on('deleted', () => disarmCalls(server, 'the cloned voice was deleted'));
  }
  return svc;
}

function sessionParam(url) {
  const id = url.searchParams.get('session') || '';
  if (!/^[a-f0-9]{32}$/.test(id)) throw httpError(400, 'session must be a session id from POST /api/clone/session');
  return id;
}

async function streamFile(req, res, file) {
  const st = fs.statSync(file);
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'audio/wav', 'Content-Length': st.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
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
}

/**
 * Register the routes (server.js calls this with its route adder; handlers run bound to the server).
 * @param {(method:string, path:string, fn:Function, opts?:object)=>void} add
 * @param {object} server DaemonServer
 */
function register(add, server) {
  const svc = () => getCloneService(server);
  const HANDLED = undefined;

  add(
    'GET',
    '/api/clone/status',
    async ({ url }) => svc().status({ light: url.searchParams.get('light') === '1' }),
    { noBody: true },
  );

  add('POST', '/api/clone/install', ({ body }) => {
    if (body.engine != null && !ENGINES.includes(body.engine)) throw httpError(400, `engine must be ${ENGINES.join(' or ')}`);
    if (body.stt != null && !STT_MODELS.includes(body.stt)) throw httpError(400, `stt must be one of ${STT_MODELS.join(', ')}`);
    if (server.stopping) throw httpError(503, 'Claude Anywhere is shutting down');
    const s = svc();
    const running = s.installProgress();
    if (running) return { ok: true, started: false, running: true, progress: running };
    s.install({ engine: body.engine || undefined, stt: body.stt || undefined }).then(
      () => {
        log.info('the voice runtime was installed');
        audit({ type: 'clone_voice', action: 'install', engine: body.engine || 'default' });
      },
      (err) => log.warn(`installing the voice runtime failed: ${err.message}`),
    );
    return { ok: true, started: true };
  });

  add('POST', '/api/clone/session', async ({ body, res }) => {
    if (body.ownerName != null && typeof body.ownerName !== 'string') throw httpError(400, 'ownerName must be a string');
    try {
      const out = await svc().startSession({ ownerName: body.ownerName || undefined });
      audit({ type: 'clone_voice', action: 'session', sessionId: out.sessionId });
      return out;
    } catch (err) {
      sendError(res, err);
      return HANDLED;
    }
  });

  add(
    'GET',
    '/api/clone/session',
    ({ url, res }) => {
      try {
        return svc().getSession(sessionParam(url));
      } catch (err) {
        if (!err.status) throw err;
        sendError(res, err);
        return HANDLED;
      }
    },
    { noBody: true },
  );

  add('POST', '/api/clone/session/renew', ({ url, res }) => {
    try {
      return svc().renewConsent(sessionParam(url));
    } catch (err) {
      if (!err.status) throw err;
      sendError(res, err);
      return HANDLED;
    }
  });

  add('POST', '/api/clone/session/cancel', ({ url }) => ({ ok: true, cancelled: svc().cancelSession(sessionParam(url)) }));

  add(
    'POST',
    '/api/clone/take',
    async ({ req, url, raw, res }) => {
      const session = sessionParam(url);
      const kind = url.searchParams.get('kind') || '';
      if (kind !== 'consent' && kind !== 'line') throw httpError(400, 'kind must be consent or line');
      const ct = contentTypeOf(req) || 'audio/wav';
      if (!WAV_TYPES.test(ct)) throw httpError(415, 'Send the take as audio/wav');
      if (raw && raw.length > TAKE_LIMIT) throw httpError(413, 'A take may be at most 5 MB');
      try {
        const out = await svc().addTake(session, kind, url.searchParams.get('index'), raw, { deviceLabel: deviceLabelOf(req) });
        if (kind === 'consent') {
          audit({ type: 'clone_voice', action: 'consent_take', sessionId: session, ok: out.ok, similarity: out.consent && out.consent.similarity, reasons: out.consent && out.consent.reasons });
        }
        return out;
      } catch (err) {
        if (err && err.code === 'VIRTUAL_DEVICE') audit({ type: 'clone_voice', action: 'refused_device', sessionId: session, device: deviceLabelOf(req).slice(0, 120) });
        sendError(res, err);
        return HANDLED;
      }
    },
    { raw: true, rawLimit: TAKE_LIMIT },
  );

  add('POST', '/api/clone/build', async ({ url, res }) => {
    const session = sessionParam(url);
    try {
      const out = await svc().build(session);
      audit({ type: 'clone_voice', action: 'build', sessionId: session, ok: out.ok, code: out.code || null, similarity: out.similarity == null ? null : out.similarity });
      if (out.ok === false) {
        sendJson(res, 422, out);
        return HANDLED;
      }
      return out;
    } catch (err) {
      sendError(res, err);
      return HANDLED;
    }
  });

  add('POST', '/api/clone/test', async ({ body, res }) => {
    if (body.text != null && typeof body.text !== 'string') throw httpError(400, 'text must be a string');
    if (body.engine != null && !ENGINES.includes(body.engine)) throw httpError(400, `engine must be ${ENGINES.join(' or ')}`);
    let out;
    try {
      out = await svc().test(body.text, { engine: body.engine || undefined, score: body.score === true });
    } catch (err) {
      sendError(res, err);
      return HANDLED;
    }
    const result = { ok: true, audioId: out.audioId, text: out.text, engine: out.engine, similarity: out.similarity, label: out.label };
    if (body.play === 'local') {
      const voice = server.deps && server.deps.voice;
      result.played = false;
      if (voice && typeof voice.playFile === 'function') {
        try {
          await voice.playFile(out.file);
          result.played = true;
        } catch (err) {
          result.playError = err.message;
        }
      } else result.playError = 'This daemon cannot play audio through the speakers';
    }
    return result;
  });

  add(
    'GET',
    '/api/clone/audio',
    async ({ req, res, url }) => {
      const id = url.searchParams.get('id') || '';
      if (!/^[a-f0-9]{32}$/.test(id)) throw httpError(400, 'id must be an audio id from /api/clone/build or /api/clone/test');
      const file = svc().audioFile(id);
      if (!file) throw httpError(404, 'No such audio (it may have been replaced); render it again');
      await streamFile(req, res, file);
      return HANDLED;
    },
    { noBody: true },
  );

  add('POST', '/api/clone/engine', async ({ body, res }) => {
    if (!ENGINES.includes(body.engine)) throw httpError(400, `engine must be ${ENGINES.join(' or ')}`);
    try {
      return await svc().setEngine(body.engine);
    } catch (err) {
      sendError(res, err);
      return HANDLED;
    }
  });

  add('POST', '/api/clone/bench', async ({ res }) => {
    try {
      return await svc().bench();
    } catch (err) {
      sendError(res, err);
      return HANDLED;
    }
  });

  add('POST', '/api/clone/delete', async ({ body, res }) => {
    if (body.confirm !== 'delete') throw httpError(400, 'Send {"confirm":"delete"} to delete the cloned voice', { hint: 'In a terminal: anywhere clone-voice delete' });
    try {
      const out = await svc().delete();
      audit({ type: 'clone_voice', action: 'delete', removed: out.removed });
      disarmCalls(server, 'the cloned voice was deleted');
      return out;
    } catch (err) {
      sendError(res, err);
      return HANDLED;
    }
  });

  add(
    'POST',
    '/api/clone/open',
    async function open() {
      const seq = svc().requestOpen();
      let host = 'none';
      if (typeof this.show === 'function') {
        try {
          const r = await this.show();
          host = (r && r.host) || 'none';
        } catch (err) {
          log.warn(`showing the dialog failed: ${err.message}`);
        }
      }
      const dialogs = this.hub && typeof this.hub.dialogCount === 'function' ? this.hub.dialogCount() : null;
      return { ok: true, seq, host, dialogs };
    },
    { notWhileStopping: true },
  );

  add('POST', '/api/clone/opened', ({ body }) => ({ ok: true, ack: svc().ackOpen(body.seq) }));

  add(
    'POST',
    '/api/clone/standalone',
    function standalone() {
      if (typeof this.launchUrl !== 'function') throw httpError(503, 'This daemon cannot mint launch codes');
      const u = new URL(this.launchUrl());
      u.pathname = '/clone.html';
      return { ok: true, url: u.href };
    },
    { notWhileStopping: true },
  );
}

module.exports = { register, getCloneService, deviceLabelOf, TAKE_LIMIT };
