'use strict';

/**
 * HTTP routes of AI-answered calls (docs/CALLS-DESIGN.md §10.4), registered by server.js. Every route needs
 * the daemon token, except the browser audio self-test steps, which carry a single-use code instead.
 *
 *   GET  /api/calls/status                 → {state, armed, until, apps, quietHours, inQuietHours, audio, current, recent}
 *   POST /api/calls/arm {minutes?, apps?, instructions?, via}
 *        blocks until the click-only card is decided → {ok, armed, until, …} or {ok:false, denied}
 *   POST /api/calls/disarm                 → {ok}            (no confirmation)
 *   POST /api/calls/takeover · /hangup     → {ok}
 *   POST /api/calls/tool {callId, name, args} + header X-Anywhere-Role: call
 *        → {ok, text, isError?}; 403 when that call is not active
 *   POST /api/calls/audio/setup · /audio/teardown · GET /api/calls/audio/check → {ok, …}
 *   POST /api/calls/audio-test/start       → {url, expiresAt} (single-use code, 2 minutes)
 *   POST /api/calls/audio-test/{begin,speak,upload,capture,result,finish}   the self-test page (no token; the code)
 *   GET  /api/calls/notes?callId=|path=    → {path, markdown} of a call's notes (only notes this daemon wrote)
 *   POST /api/calls/notes/open {callId|path} → {ok, path}: opens them in the default app
 *   POST /api/calls/learn {seconds?, app?} → {ok, signature}
 *   POST /api/calls/simulate {app, caller, engage?}   only with env ANYWHERE_CALLS_SIMULATE=1 (still needs arming)
 *
 * SSE (broadcast by the CallManager): calls {state, armed, armedUntil, apps, call}, call_transcript, call_action,
 * call_notes, notify (the announcement after a call).
 *
 * The /api/clone/* routes live in routes-clone.js; both use the daemon's one CloneService (server.deps.clone).
 * The CallManager is created on first use and kept in server.deps.calls (main.js stops it on shutdown, and
 * routes-clone disarms it when the voice is deleted). At register time a call-audio routing left behind by a
 * crashed daemon is restored, and a process 'exit' hook restores the routing synchronously.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger } = require('../shared/log');

const log = createLogger('routes-calls');

const MANAGERS = new Set();
let exitHooked = false;

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

/** process.on('exit'): put the user's microphone back, whatever happened (synchronous). */
function hookExit(manager) {
  MANAGERS.add(manager);
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const m of MANAGERS) {
      try {
        if (m._bridge && typeof m._bridge.restoreSync === 'function') m._bridge.restoreSync();
      } catch {
        /* exiting */
      }
    }
  });
}

/** Whether a routing state file exists, without creating the state folder. */
function leftoverAudioState(env = process.env) {
  const home = env.ANYWHERE_HOME ? path.resolve(env.ANYWHERE_HOME) : path.join(os.homedir(), '.claude-anywhere');
  try {
    return fs.statSync(path.join(home, 'run', 'calls-audio.json')).isFile();
  } catch {
    return false;
  }
}

function cloneServiceOf(server) {
  const deps = server.deps || {};
  if (deps.clone) return deps.clone;
  try {
    const rc = require('./routes-clone');
    if (typeof rc.getCloneService === 'function') return rc.getCloneService(server);
  } catch (err) {
    if (!(err && err.code === 'MODULE_NOT_FOUND')) throw err;
  }
  return null;
}

/** server.deps.getComputer, else a Computer of our own over the daemon's driver (shared geometry file). */
function computerGetter(server) {
  const deps = server.deps || {};
  if (typeof deps.getComputer === 'function') return deps.getComputer;
  let pending = null;
  return () => {
    if (!pending) {
      pending = (async () => {
        const driver = typeof deps.getDriver === 'function' ? await deps.getDriver() : null;
        if (!driver) throw httpError(503, 'The desktop driver is not available', { code: 'NO_DRIVER' });
        const { Computer } = require('../os/computer');
        return new Computer({ driver, config: (deps.config || {}).computer, geometryStore: 'file' });
      })();
      pending.catch(() => {
        pending = null;
      });
    }
    return pending;
  };
}

/**
 * The daemon's CallManager (created on first use).
 * @param {object} server DaemonServer
 */
function getCallManager(server) {
  const deps = server.deps || (server.deps = {});
  if (deps.calls) return deps.calls;
  let mgr;
  if (typeof deps.callsFactory === 'function') {
    mgr = deps.callsFactory({ server, config: deps.config });
  } else {
    const { CallManager } = require('../calls/manager');
    mgr = new CallManager({
      config: () => server.deps.config || {},
      hub: server.hub,
      permissions: deps.permissions,
      clone: cloneServiceOf(server),
      getDriver: typeof deps.getDriver === 'function' ? deps.getDriver : async () => null,
      getComputer: computerGetter(server),
      piper: () => (server.deps.voice && server.deps.voice.piper) || null,
      // The call engine's MCP server gets the engines' token (F3-SAFE-D1), never the daemon's own.
      daemonInfo: () => ({ url: `http://127.0.0.1:${server.port}`, token: server.engineToken || server.token }),
      platformInfo: deps.platformInfo || undefined,
      // The dialog's pause also stops the after-call chat message (cliq.js types into the call app).
      checkGuard: async () => {
        const s = server.session;
        if (!s || typeof s.guard !== 'function') return;
        const v = await s.guard();
        if (v && v.allowed === false) throw httpError(423, `Actions are paused: ${v.reason || 'the user paused Claude in the dialog'}`, { code: 'PAUSED' });
      },
    });
  }
  deps.calls = mgr;
  hookExit(mgr);
  return mgr;
}

function bool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * @param {Function} add (method, path, handler, opts)
 * @param {object} server DaemonServer
 */
function register(add, server) {
  const mgr = () => getCallManager(server);

  add('GET', '/api/calls/status', () => {
    const m = mgr();
    return typeof m.statusFull === 'function' ? m.statusFull() : m.status();
  }, { noBody: true });

  add(
    'POST',
    '/api/calls/arm',
    async ({ req, res, body }) => {
      if (String(req.headers['x-anywhere-role'] || '').toLowerCase() === 'call') throw httpError(403, 'Not allowed during calls');
      const ac = new AbortController();
      const onClose = () => {
        if (!res.writableFinished) ac.abort();
      };
      res.on('close', onClose);
      try {
        const out = await mgr().requestArm({
          minutes: body.minutes,
          apps: Array.isArray(body.apps) ? body.apps.slice(0, 10) : undefined,
          instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
          via: typeof body.via === 'string' ? body.via : 'api',
          signal: ac.signal,
        });
        return out;
      } finally {
        res.removeListener('close', onClose);
      }
    },
    { notWhileStopping: true }
  );

  add('POST', '/api/calls/disarm', () => {
    const deps = server.deps || {};
    if (!deps.calls) return { ok: true, armed: false };
    return mgr().disarm('user');
  });

  add('POST', '/api/calls/takeover', () => mgr().takeover());
  add('POST', '/api/calls/hangup', () => mgr().hangup());

  add('POST', '/api/calls/tool', async ({ req, body }) => {
    if (String(req.headers['x-anywhere-role'] || '').toLowerCase() !== 'call') throw httpError(403, 'Call tools are for the call engine only', { code: 'NOT_CALL_ROLE' });
    if (typeof body.callId !== 'string' || !body.callId || typeof body.name !== 'string' || !body.name) throw httpError(400, 'callId and name are required');
    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
    return mgr().tool(body.callId, body.name, args);
  });

  // The notes of a call this daemon answered (the panel's "recent calls"); never any other file.
  add('GET', '/api/calls/notes', ({ url }) => mgr().readNotes({ callId: url.searchParams.get('callId') || undefined, path: url.searchParams.get('path') || undefined }), { noBody: true });
  add('POST', '/api/calls/notes/open', ({ body }) => mgr().openNotes({ callId: typeof body.callId === 'string' ? body.callId : undefined, path: typeof body.path === 'string' ? body.path : undefined }));

  add('GET', '/api/calls/audio/check', ({ url }) => mgr().audioCheck({ deep: bool(url.searchParams.get('deep')) }), { noBody: true });
  add('POST', '/api/calls/audio/setup', () => mgr().audioSetup());
  add('POST', '/api/calls/audio/teardown', () => mgr().audioTeardown());

  add('POST', '/api/calls/audio-test/start', async ({ body }) => {
    const m = mgr();
    if (m.call) throw httpError(409, 'A call is in progress; run the audio test after it');
    const code = m.selfTest().mint();
    const url = `http://127.0.0.1:${server.port}${code.path}`;
    const out = { ok: true, url, expiresAt: code.expiresAt };
    // {open:true}: open it in the default browser (the panel's button); the CLI opens it itself.
    if (body && body.open === true) {
      const open = typeof (server.deps || {}).openTarget === 'function' ? server.deps.openTarget : (t, o) => require('../os/common').openTarget(t, o);
      try {
        await open(url, { kind: 'url' });
        out.opened = true;
      } catch (err) {
        out.opened = false;
        out.openError = err.message;
      }
    }
    return out;
  });
  let selfTestRoutes = [];
  try {
    selfTestRoutes = require('../calls/audio-bridge').SELF_TEST_ROUTES || [];
  } catch (err) {
    if (!(err && err.code === 'MODULE_NOT_FOUND')) throw err;
  }
  for (const r of selfTestRoutes) {
    add(
      r.method,
      r.path,
      (ctx) => {
        const m = mgr();
        // F3-SAFE-F1: no step of the self-test (it speaks into, and records from, the call's audio route)
        // while a call is being answered or is in progress.
        if (m.call || m._answering || m.state === 'answering') throw httpError(409, 'A call is in progress; run the audio test after it');
        return m.selfTest().route(r.step, ctx);
      },
      { noAuth: true, raw: Boolean(r.raw), noBody: Boolean(r.noBody) }
    );
  }

  add('POST', '/api/calls/learn', async ({ body }) => {
    const seconds = Math.max(10, Math.min(180, Number(body.seconds) || 60));
    const out = await mgr().learn({ seconds, app: typeof body.app === 'string' ? body.app : undefined });
    return { ok: Boolean(out && out.ok), ...(out || {}) };
  });

  add('POST', '/api/calls/simulate', async ({ body }) => {
    if (process.env.ANYWHERE_CALLS_SIMULATE !== '1') throw httpError(404, 'Not found');
    return mgr().simulate({
      app: typeof body.app === 'string' ? body.app : undefined,
      caller: typeof body.caller === 'string' ? body.caller : undefined,
      engage: bool(body.engage),
    });
  });

  // A routing left behind by a crashed daemon: restore it now (needs no CallManager otherwise).
  const deps = server.deps || {};
  if (deps.callsRestoreOnStart !== false && leftoverAudioState()) {
    setImmediate(() => {
      try {
        const bridge = mgr().bridge();
        bridge
          .restoreFromCrash()
          .then((r) => {
            if (r && r.restored) log.info(`restored call audio routing left by process ${r.from}`);
          })
          .catch((err) => log.warn(`restoring the call audio routing failed: ${err.message}`));
      } catch (err) {
        log.warn(`restoring the call audio routing failed: ${err.message}`);
      }
    });
  }
}

module.exports = { register, getCallManager, leftoverAudioState };
