'use strict';

/**
 * The daemon's HTTP + SSE API (loopback only).
 *
 * Every request: Host must be 127.0.0.1:<port> or localhost:<port> (DNS
 * rebinding), /api/* needs the token (except GET /api/health), non-GET
 * requests with an Origin must come from the daemon's own origin, bodies are
 * size-limited, and every response carries no-store/nosniff/no-referrer and
 * a strict CSP. Static UI files come from src/ui with traversal protection.
 *
 * Principals (F3-SAFE-D1): 'dialog' (the token plus X-Anywhere-UI, the dialog window's own
 * credential from POST /api/launch, sent from the daemon's origin), 'user' (the token), 'engine'
 * (the engines' MCP token: no approvals, answers, settings, modes or shutdown). Only 'dialog' can
 * answer a card with via:'click', so only a real click allows a critical card.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const configMod = require('../shared/config');
const paths = require('../shared/paths');
const { stripMarkdownForSpeech, isPlainObject, nowIso } = require('../shared/util');
const { createLogger } = require('../shared/log');

const log = createLogger('server');

const JSON_LIMIT = 25 * 1024 * 1024;
const AUDIO_LIMIT = 25 * 1024 * 1024;
const LISTEN_MAX_SEC = 590;
const LISTEN_DEFAULT_SEC = 540;
const LAUNCH_CODE_TTL_MS = 60000;
// POST /api/approval `via`: how the user answered (same list as permissions.js APPROVAL_VIA).
const APPROVAL_VIA = ['click', 'key', 'typed', 'voice'];
const MAX_LAUNCH_CODES = 64;
const DEFAULT_UI_DIR = path.join(paths.PACKAGE_ROOT, 'src', 'ui');

const CSP =
  "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

const AUDIO_TYPES = /^(audio\/(wav|wave|x-wav|vnd\.wave|webm|ogg|mp4|mpeg|mp3|x-m4a|m4a|flac|aac)|video\/(webm|mp4)|application\/octet-stream)$/i;

const ENUMS = {
  mode: ['companion', 'bridge'],
  'ui.host': ['auto', 'electron', 'app', 'browser', 'tui', 'none'],
  'ui.theme': ['system', 'light', 'dark'],
  'permissions.mode': ['ask', 'smart', 'auto'],
  'voice.stt': ['auto', 'browser', 'server', 'off'],
  'voice.tts': ['auto', 'browser', 'server', 'off'],
  'voice.sttProvider': ['auto', 'openai', 'groq', 'custom', 'whisper.cpp'],
  'voice.ttsEngine': ['auto', 'piper', 'browser', 'os'],
  'voice.clone.engine': ['pocket', 'zipvoice'],
  'voice.clone.provider': ['cpu', 'cuda', 'coreml'],
  'calls.ownerPronoun': ['his', 'her', 'their'],
  'calls.stt.model': ['moonshine', 'whisper-tiny', 'whisper', 'parakeet'],
  'calls.audio.mode': ['auto', 'virtual', 'speakers'],
  'calls.cliq.mode': ['gui', 'api'],
  'calls.cliq.dc': ['com', 'eu', 'in', 'com.au', 'jp', 'ca'],
};

const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Claude Anywhere</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px/1.5 system-ui,sans-serif;margin:2rem;color:#222;background:#fafafa}
@media (prefers-color-scheme: dark){body{color:#eee;background:#1b1b1b}}code{background:rgba(127,127,127,.2);padding:0 .3em;border-radius:3px}</style>
</head><body><h1>Claude Anywhere</h1>
<p>The daemon is running, but the dialog files (<code>src/ui</code>) are missing from this installation.</p>
<p>Reinstall Claude Anywhere, or use the terminal dialog: <code>anywhere tui</code>.</p></body></html>
`;

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * Constant-time token comparison on equal-length buffers.
 * @param {string} given
 * @param {string} expected
 * @returns {boolean}
 */
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const CALLS_CHECKED_KEYS = ['calls.quietHours.start', 'calls.quietHours.end', 'calls.greeting'];

/** src/calls/policy.js settingProblem (null when that module is missing from this install). */
function callsSettingProblem(key, value, ctx) {
  let policy = null;
  try {
    policy = require('../calls/policy');
  } catch {
    return null;
  }
  return typeof policy.settingProblem === 'function' ? policy.settingProblem(key, value, ctx) : null;
}

/**
 * Check a partial config update against DEFAULTS (types and enums).
 * @param {object} partial already passed through sanitizeUpdate()
 * @returns {string|null} an error message, or null when valid
 */
function validateConfigUpdate(partial, defaults = configMod.DEFAULTS, prefix = '') {
  for (const [k, v] of Object.entries(partial)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (!(k in defaults)) return `Unknown setting "${key}"`;
    const def = defaults[k];
    if (isPlainObject(def)) {
      if (!isPlainObject(v)) return `"${key}" must be an object`;
      const nested = validateConfigUpdate(v, def, key);
      if (nested) return nested;
      continue;
    }
    if (Array.isArray(def)) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `"${key}" must be a list of strings`;
      continue;
    }
    if (typeof def === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `"${key}" must be a non-negative number`;
      if (key === 'port' && (!Number.isInteger(v) || v > 65535)) return '"port" must be an integer from 0 to 65535';
      continue;
    }
    if (typeof def === 'boolean' && typeof v !== 'boolean') return `"${key}" must be true or false`;
    if (typeof def === 'string') {
      if (typeof v !== 'string') return `"${key}" must be a string`;
      if (v.length > 4096) return `"${key}" is too long`;
      if (ENUMS[key] && !ENUMS[key].includes(v)) return `"${key}" must be one of: ${ENUMS[key].join(', ')}`;
      // Quiet-hour times must parse (F3-SAFE-D3); calls.greeting is only a closing question (F3-SAFE-B2).
      if (CALLS_CHECKED_KEYS.includes(key)) {
        const problem = callsSettingProblem(key, v);
        if (problem) return problem;
      }
    }
  }
  return null;
}

/**
 * A non-secret id of a state directory (and so of one user's install) for /api/health, so a
 * starting daemon can tell its own daemon on a port from another user's or ANYWHERE_HOME's.
 * @param {string} [dir]
 * @returns {string}
 */
function homeId(dir = paths.stateDir()) {
  let p = path.resolve(dir);
  if (process.platform === 'win32') p = p.toLowerCase();
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
}

/** @returns {number|null} this process's uid (null on Windows) */
function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function contentTypeOf(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

function sendJson(res, status, obj) {
  if (res.headersSent || res.destroyed || res.writableEnded) return false;
  const body = JSON.stringify(obj === undefined ? {} : obj);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(httpError(413, `Request body is larger than ${Math.round(limit / 1024 / 1024)} MB`));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(httpError(413, `Request body is larger than ${Math.round(limit / 1024 / 1024)} MB`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(httpError(400, `Could not read the request body: ${err.message}`));
    });
    req.on('aborted', () => {
      if (done) return;
      done = true;
      reject(httpError(400, 'The request was aborted'));
    });
  });
}

const HANDLED = Symbol('handled');

/** Optional feature modules that add HTTP routes (missing ones are skipped). */
const ROUTE_MODULES = ['routes-voice', 'routes-jira', 'routes-project', 'routes-clone', 'routes-calls'];

class DaemonServer {
  /**
   * @param {object} deps
   * @param {import('./hub').Hub} deps.hub
   * @param {import('./session').SessionManager} deps.session
   * @param {object} deps.permissions PermissionBroker
   * @param {import('./questions').QuestionBroker} deps.questions
   * @param {import('./bridge').Bridge} deps.bridge
   * @param {object} deps.config live config object
   * @param {string} deps.token
   * @param {string} deps.instanceId
   * @param {string} deps.version
   * @param {object} [deps.voice] VoiceService
   * @param {object} [deps.uihost] UiHost
   * @param {{gatherContext?:Function, detectProjects?:Function}} [deps.context]
   * @param {()=>Promise<object>} [deps.getDriver]
   * @param {(next:object, prev:object)=>void} [deps.applyConfig] called after a config save
   * @param {(reason:string)=>void} [deps.onShutdown]
   * @param {(title:string, body:string)=>Promise<any>} [deps.notifyOS]
   * @param {string} [deps.uiDir]
   */
  constructor(deps) {
    this.deps = deps;
    this.hub = deps.hub;
    this.session = deps.session;
    this.token = deps.token;
    this.uiDir = path.resolve(deps.uiDir || DEFAULT_UI_DIR);
    this.port = 0;
    this.server = http.createServer((req, res) => this.handle(req, res));
    // Long polls (approvals, questions, bridge listen) can legitimately take many minutes.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60000;
    this.server.keepAliveTimeout = 5000;
    this.server.timeout = 0;
    this.sockets = new Set();
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    this.claimedApprovals = new Set();
    this.launchCodes = new Map(); // single-use launch code -> {exp (ms), grant}
    // F3-SAFE-D1. The engines' MCP servers get their own token (engineToken), which cannot answer
    // cards or questions, change settings or modes, or shut the daemon down. The dialog window gets
    // its own credential (uiKey), only through POST /api/launch with a code minted for a dialog
    // window: it is never written to a file, so a "click" (POST /api/approval via:'click') is
    // believed only from a request that carries it.
    this.engineToken = typeof deps.engineToken === 'string' && deps.engineToken && deps.engineToken !== deps.token ? deps.engineToken : null;
    this.uiKey = crypto.randomBytes(24).toString('base64url');
    this.home = deps.home || homeId();
    this.stopping = false; // set by the daemon's shutdown: health answers 503, routes that start work refuse
    this.routes = this.buildRoutes();
  }

  /** The daemon's URL with the token (opens the dialog). */
  get url() {
    return `http://127.0.0.1:${this.port}/?token=${encodeURIComponent(this.token)}`;
  }

  /**
   * A dialog URL that is safe on a child-process command line (readable by every local user):
   * it carries a single-use code, valid for 60 s, that the page trades for the token through
   * POST /api/launch.
   * @returns {string}
   */
  launchUrl(_url, { grant = 'dialog' } = {}) {
    const now = Date.now();
    for (const [c, e] of this.launchCodes) if (e.exp <= now) this.launchCodes.delete(c);
    // Bound the map: a runaway caller cannot grow it without limit.
    while (this.launchCodes.size >= MAX_LAUNCH_CODES) this.launchCodes.delete(this.launchCodes.keys().next().value);
    const code = crypto.randomBytes(18).toString('base64url');
    // 'dialog': the window host's own launch (token + the dialog credential); 'user': a page an API
    // caller opens (the token only); 'engine': a page an engine opens (the engine's token only).
    this.launchCodes.set(code, { exp: now + LAUNCH_CODE_TTL_MS, grant: ['dialog', 'user', 'engine'].includes(grant) ? grant : 'user' });
    return `http://127.0.0.1:${this.port}/?launch=${code}`;
  }

  /**
   * Who sent a request: 'dialog' (the token plus the dialog's credential, from the daemon's own
   * origin), 'user' (the token: CLI, terminal dialog, plugin), 'engine' (an engine's MCP server), or
   * null (no valid credential).
   * @private
   */
  principalOf(req, url, allowQuery) {
    const given = this.tokenFrom(req, url, allowQuery);
    if (tokenMatches(given, this.token)) {
      const ui = req.headers['x-anywhere-ui'];
      const origin = req.headers.origin;
      if (typeof ui === 'string' && tokenMatches(ui.trim(), this.uiKey) && origin !== undefined && this.originAllowed(origin)) return 'dialog';
      return 'user';
    }
    if (this.engineToken && tokenMatches(given, this.engineToken)) return 'engine';
    return null;
  }

  /**
   * Listen on 127.0.0.1.
   * @param {number} port 0 = random
   * @returns {Promise<number>} the bound port
   */
  listen(port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.removeListener('error', onError);
        this.port = this.server.address().port;
        resolve(this.port);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen({ port, host: '127.0.0.1', exclusive: true });
    });
  }

  /** Stop listening and drop every open connection. */
  close() {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
      for (const s of this.sockets) s.destroy();
      setTimeout(resolve, 2000).unref();
    });
  }

  // ---------------------------------------------------------------- routing

  /** @private */
  buildRoutes() {
    const r = new Map();
    const add = (method, p, fn, opts = {}) => r.set(`${method} ${p}`, { fn: fn.bind(this), ...opts });
    add('GET', '/api/health', this.health, { noAuth: true, noBody: true });
    add('POST', '/api/launch', this.launch, { noAuth: true });
    add('GET', '/api/events', this.events, { queryToken: true, noBody: true });
    add('GET', '/api/state', () => this.session.snapshot(), { noBody: true });
    // notWhileStopping: work that would outlive a daemon that is shutting down (a new turn, a new window)
    add('POST', '/api/command', this.command, { notWhileStopping: true });
    add('POST', '/api/interrupt', this.interrupt);
    add('POST', '/api/approval', this.approval, { noEngine: true });
    add('POST', '/api/answer', this.answer, { noEngine: true });
    add('POST', '/api/session/new', this.newSession, { notWhileStopping: true });
    add('POST', '/api/project', this.project, { notWhileStopping: true });
    add('GET', '/api/projects', this.projects, { noBody: true });
    add('GET', '/api/config', () => configMod.publicConfig(this.deps.config), { noBody: true });
    add('POST', '/api/config', this.saveConfig, { noEngine: true });
    add('POST', '/api/mode', this.mode, { notWhileStopping: true, noEngine: true });
    add('POST', '/api/stt', this.stt, { raw: true });
    add('POST', '/api/tts', this.tts);
    add('POST', '/api/tts/stop', this.ttsStop);
    add('GET', '/api/context', this.context, { noBody: true });
    add('GET', '/api/permissions', this.osPermissions, { noBody: true });
    add('POST', '/api/show', this.show, { notWhileStopping: true });
    add('POST', '/api/ui/visibility', this.uiVisibility);
    add('POST', '/api/shutdown', this.shutdown, { noEngine: true });
    add('POST', '/api/mcp/permission', this.mcpPermission);
    add('POST', '/api/mcp/ask', this.mcpAsk);
    add('POST', '/api/mcp/notify', this.mcpNotify);
    add('POST', '/api/mcp/activity', this.mcpActivity);
    add('GET', '/api/mcp/guard', () => this.session.guard(), { noBody: true });
    add('POST', '/api/bridge/listen', this.bridgeListen);
    add('POST', '/api/bridge/reply', this.bridgeReply);
    // Feature route modules (src/daemon/routes-*.js) export register(add, server); handlers are
    // bound to this server and get the same ({ req, res, url, body, raw }) argument as the built-in ones.
    for (const name of ROUTE_MODULES) {
      let mod = null;
      try {
        mod = require(`./${name}`);
      } catch (err) {
        if (!(err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(name))) throw err;
      }
      if (mod && typeof mod.register === 'function') mod.register(add, this);
    }
    return r;
  }

  /** @private */
  hostAllowed(host) {
    if (!host || !this.port) return false;
    const h = String(host).toLowerCase();
    return h === `127.0.0.1:${this.port}` || h === `localhost:${this.port}`;
  }

  /** @private */
  originAllowed(origin) {
    const o = String(origin).toLowerCase();
    return o === `http://127.0.0.1:${this.port}` || o === `http://localhost:${this.port}`;
  }

  /** @private */
  tokenFrom(req, url, allowQuery) {
    const auth = req.headers.authorization;
    if (typeof auth === 'string') {
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (m) return m[1].trim();
    }
    const x = req.headers['x-anywhere-token'];
    if (typeof x === 'string' && x) return x.trim();
    if (allowQuery) return url.searchParams.get('token') || '';
    return '';
  }

  /** @private */
  async handle(req, res) {
    try {
      if (!this.hostAllowed(req.headers.host)) {
        sendJson(res, 403, { error: 'Forbidden host' });
        return;
      }
      let url;
      try {
        url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
      } catch {
        sendJson(res, 400, { error: 'Bad request URL' });
        return;
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await this.handleApi(req, res, url);
      } else {
        await this.serveStatic(req, res, url);
      }
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500 && status !== 503) log.error(`${req.method} ${req.url && req.url.split('?')[0]} failed:`, err);
      const body = { error: err.message || 'Internal error' };
      if (err.hint) body.hint = err.hint;
      if (err.code && typeof err.code === 'string') body.code = err.code;
      // Don't keep reading an oversized upload on this connection.
      if (status === 413 && !res.headersSent) res.setHeader('Connection', 'close');
      sendJson(res, status, body);
    }
  }

  /** @private */
  async handleApi(req, res, url) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (method !== 'GET' && req.headers.origin !== undefined && !this.originAllowed(req.headers.origin)) {
      throw httpError(403, 'Forbidden origin');
    }
    const route = this.routes.get(`${method} ${url.pathname}`);
    if (!route) {
      // Unknown paths and methods still require auth so they reveal nothing.
      if (!this.principalOf(req, url, false)) throw httpError(401, 'Unauthorized');
      const allowed = ['GET', 'POST'].filter((m) => this.routes.has(`${m} ${url.pathname}`));
      if (allowed.length) {
        res.setHeader('Allow', allowed.join(', '));
        throw httpError(405, 'Method not allowed');
      }
      throw httpError(404, 'Not found');
    }
    const principal = route.noAuth ? null : this.principalOf(req, url, Boolean(route.queryToken));
    if (!route.noAuth && !principal) {
      throw httpError(401, 'Unauthorized');
    }
    if (principal === 'engine' && route.noEngine) {
      req.resume();
      throw httpError(403, 'Claude Code sessions run by Claude Anywhere cannot use this route', { code: 'ENGINE_FORBIDDEN' });
    }
    if (route.notWhileStopping && this.stopping) {
      req.resume();
      throw httpError(503, 'Claude Anywhere is shutting down', { hint: 'Run /anywhere (or: anywhere start) again in a moment.' });
    }
    let body = {};
    let raw = null;
    if (route.raw) {
      // A route may lower the limit (routes-clone: 5 MB per enrollment take), so an oversized upload
      // is refused before 25 MB of it is buffered.
      const limit = Number.isFinite(route.rawLimit) && route.rawLimit > 0 ? Math.min(route.rawLimit, AUDIO_LIMIT) : AUDIO_LIMIT;
      raw = await readBody(req, limit);
    } else if (!route.noBody) {
      const ct = contentTypeOf(req);
      if (ct && ct !== 'application/json' && !ct.endsWith('+json')) {
        req.resume();
        throw httpError(415, 'Content-Type must be application/json');
      }
      const buf = await readBody(req, JSON_LIMIT);
      if (buf.length) {
        try {
          body = JSON.parse(buf.toString('utf8'));
        } catch {
          throw httpError(400, 'Invalid JSON body');
        }
        if (!isPlainObject(body)) throw httpError(400, 'JSON body must be an object');
      }
    } else {
      req.resume();
    }
    const out = await route.fn({ req, res, url, body, raw, principal });
    if (out === HANDLED) return;
    sendJson(res, 200, out === undefined ? { ok: true } : out);
  }

  /** @private */
  async serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      throw httpError(405, 'Method not allowed');
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw httpError(400, 'Bad path encoding');
    }
    if (rel.includes('\0')) throw httpError(400, 'Bad path');
    if (rel === '/' || rel === '') rel = '/index.html';
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    if (segments.some((s) => s === '..' || s.includes(':'))) throw httpError(403, 'Forbidden path');
    if (segments.some((s) => s.startsWith('.'))) throw httpError(404, 'Not found');
    const file = path.resolve(this.uiDir, ...segments);
    if (file !== this.uiDir && !file.startsWith(this.uiDir + path.sep)) throw httpError(403, 'Forbidden path');
    let real;
    let st;
    try {
      real = fs.realpathSync(file);
      st = fs.statSync(real);
    } catch {
      if (rel === '/index.html') return this.sendStatic(req, res, Buffer.from(FALLBACK_HTML), MIME['.html']);
      throw httpError(404, 'Not found');
    }
    let realRoot = this.uiDir;
    try {
      realRoot = fs.realpathSync(this.uiDir);
    } catch {
      /* keep */
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw httpError(403, 'Forbidden path');
    if (!st.isFile()) throw httpError(404, 'Not found');
    const type = MIME[path.extname(real).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': st.size });
    if (req.method === 'HEAD') {
      res.end();
      return undefined;
    }
    await new Promise((resolve) => {
      const stream = fs.createReadStream(real);
      stream.on('error', (err) => {
        log.warn(`static read failed for ${real}: ${err.message}`);
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

  /** @private */
  sendStatic(req, res, buf, type) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  // ---------------------------------------------------------------- handlers

  /** @private home and uid tell a starting daemon whether this one is its own (see main.js isOwnDaemon) */
  health({ res }) {
    const body = { ok: true, app: 'claude-anywhere', version: this.deps.version, instanceId: this.deps.instanceId, pid: process.pid, home: this.home, uid: currentUid() };
    if (!this.stopping) return body;
    // Not "running" for findRunningDaemon (any non-2xx is not), so /anywhere does not reuse a daemon
    // that is going away; the body still lets a new daemon wait for this one to free the port.
    sendJson(res, 503, { ...body, ok: false, shuttingDown: true });
    return HANDLED;
  }

  /**
   * @private trade a single-use launch code (from launchUrl()) for the token; a dialog window's code
   * also carries the dialog's credential (`ui`), and an engine's page gets only the engine's token.
   */
  launch({ body }) {
    const code = body && body.code;
    const e = typeof code === 'string' && code ? this.launchCodes.get(code) : undefined;
    if (e === undefined) throw httpError(401, 'Unauthorized');
    this.launchCodes.delete(code);
    if (e.exp <= Date.now()) throw httpError(401, 'Unauthorized');
    if (e.grant === 'engine') return { token: this.engineToken || this.token };
    if (e.grant === 'dialog') return { token: this.token, ui: this.uiKey };
    return { token: this.token };
  }

  /** @private */
  events({ req, res }) {
    this.hub.addClient(req, res);
    return HANDLED;
  }

  /** @private */
  async command({ body }) {
    const { id } = await this.session.submit({
      text: body.text,
      images: body.images,
      attachScreenshot: body.attachScreenshot,
      source: body.source,
    });
    const bridge = this.deps.bridge;
    // `anywhere send` warns from these when the command waits for a terminal that is not there.
    return { ok: true, id, mode: this.session.mode, bridge: { listening: Boolean(bridge && bridge.listening) } };
  }

  /** @private */
  async interrupt() {
    await this.session.interrupt();
    return { ok: true };
  }

  /** @private */
  approval({ body, principal }) {
    const { id, decision, message } = body;
    if (typeof id !== 'string' || !id) throw httpError(400, 'id is required');
    if (!['allow', 'allow_session', 'deny'].includes(decision)) throw httpError(400, 'decision must be allow, allow_session or deny');
    const perms = this.deps.permissions;
    if (!perms) throw httpError(503, 'Approvals are not available');
    // How the user answered (optional for ordinary cards). The broker records it and refuses a
    // critical allow that is not a click in the dialog window (or, where allowed, the typed word in
    // the terminal dialog): 409 CRITICAL_NEEDS_CLICK. A "click" is believed only from the dialog
    // window, whose requests carry its own credential (F3-SAFE-D1).
    const via = APPROVAL_VIA.includes(body.via) ? body.via : undefined;
    const dialog = principal === 'dialog';
    if (via === 'click' && !dialog) {
      throw httpError(403, 'Only the Claude Anywhere dialog window can answer a card with a click', {
        code: 'CLICK_NEEDS_DIALOG',
        hint: 'Click the card in the dialog window (anywhere show opens it).',
      });
    }
    const ok = perms.resolve(id, decision, typeof message === 'string' ? message : undefined, via ? { via, dialog } : { dialog });
    if (!ok) throw httpError(404, 'No pending approval with that id (it may have timed out or been cancelled)');
    return { ok: true };
  }

  /** @private */
  answer({ body }) {
    const { id, text } = body;
    if (typeof id !== 'string' || !id) throw httpError(400, 'id is required');
    if (text != null && typeof text !== 'string') throw httpError(400, 'text must be a string');
    const ok = this.deps.questions.answer(id, text == null ? '' : text);
    if (!ok) throw httpError(404, 'No pending question with that id (it may have timed out or been cancelled)');
    return { ok: true };
  }

  /** @private */
  async newSession() {
    const { sessionId } = await this.session.newSession();
    return { ok: true, sessionId };
  }

  /** @private */
  async project({ body }) {
    const project = await this.session.setProject(body.dir, { force: body.force === true });
    return { ok: true, project };
  }

  /** @private */
  async driver() {
    if (typeof this.deps.getDriver !== 'function') return null;
    try {
      return await this.deps.getDriver();
    } catch (err) {
      log.warn(`desktop driver unavailable: ${err.message}`);
      return null;
    }
  }

  /**
   * The running daemon's OS permission state (macOS TCC: accessibility, screenRecording,
   * automation), as its driver reports it; `anywhere doctor` shows it. Never prompts.
   * @private
   */
  async osPermissions() {
    const d = await this.driver();
    if (!d || typeof d.capabilities !== 'function') return { platform: process.platform, permissions: null };
    let caps = null;
    try {
      caps = await d.capabilities();
    } catch (err) {
      log.warn(`could not read driver capabilities: ${err.message}`);
    }
    return { platform: process.platform, permissions: (caps && caps.permissions) || null };
  }

  /** @private */
  async projects() {
    const ctx = this.deps.context || {};
    const current = this.session.projectDir;
    let list = [];
    if (typeof ctx.detectProjects === 'function') {
      try {
        list = await ctx.detectProjects({ driver: await this.driver() });
      } catch (err) {
        log.warn(`detectProjects failed: ${err.message}`);
      }
    }
    const out = [];
    const seen = new Set();
    for (const p of [{ dir: current, name: path.basename(current) || current, source: 'cwd' }, ...(Array.isArray(list) ? list : [])]) {
      if (!p || !p.dir) continue;
      const dir = path.resolve(p.dir);
      if (seen.has(dir)) continue;
      seen.add(dir);
      out.push({ ...p, dir, name: p.name || path.basename(dir) || dir, current: dir === current });
    }
    return { projects: out };
  }

  /** @private */
  saveConfig({ body }) {
    const partial = configMod.sanitizeUpdate(body);
    const problem = validateConfigUpdate(partial);
    if (problem) throw httpError(400, problem);
    // The greeting's closing question may not name the owner (the name is in the saved settings).
    if (isPlainObject(partial.calls) && typeof partial.calls.greeting === 'string') {
      const owner = typeof partial.calls.ownerName === 'string' && partial.calls.ownerName.trim() ? partial.calls.ownerName : ((this.deps.config || {}).calls || {}).ownerName;
      const greetingProblem = callsSettingProblem('calls.greeting', partial.calls.greeting, { ownerName: owner });
      if (greetingProblem) throw httpError(400, greetingProblem);
    }
    const prev = JSON.parse(JSON.stringify(this.deps.config));
    const next = configMod.save(partial);
    // Update the shared config object in place so every module sees the change.
    for (const k of Object.keys(next)) this.deps.config[k] = next[k];
    if (typeof this.deps.applyConfig === 'function') this.deps.applyConfig(this.deps.config, prev);
    const pub = configMod.publicConfig(this.deps.config);
    this.hub.broadcast('config', pub);
    return pub;
  }

  /** @private */
  async mode({ body }) {
    const r = await this.session.setMode(body.mode, { force: body.force === true });
    // moved: bridge commands that waited for a terminal and now run in the companion session.
    return Number.isFinite(r && r.moved) ? { ok: true, mode: r.mode, moved: r.moved } : { ok: true, mode: r.mode };
  }

  /** @private */
  async stt({ req, url, raw }) {
    const voice = this.deps.voice;
    if (!voice || typeof voice.transcribe !== 'function') {
      throw httpError(503, 'Server speech-to-text is not available', { hint: 'Use the browser microphone, or set a Groq/OpenAI key in Settings > Voice.' });
    }
    const ct = contentTypeOf(req) || 'audio/wav';
    if (!AUDIO_TYPES.test(ct)) throw httpError(415, 'Send audio as audio/wav (webm, ogg and mp4 are also accepted)');
    if (!raw || !raw.length) throw httpError(400, 'The audio body is empty');
    const language = url.searchParams.get('language') || (this.deps.config.voice || {}).language || undefined;
    try {
      const out = await voice.transcribe(raw, { contentType: ct, language });
      return { text: (out && out.text) || '', provider: (out && out.provider) || null };
    } catch (err) {
      throw httpError(err.status && err.status < 600 ? err.status : 502, `Transcription failed: ${err.message}`, err.hint ? { hint: err.hint } : undefined);
    }
  }

  /** @private */
  async tts({ body }) {
    const voice = this.deps.voice;
    if (typeof body.text !== 'string' || !body.text.trim()) throw httpError(400, 'text must be a non-empty string');
    if (!voice || typeof voice.speak !== 'function') throw httpError(503, 'Server text-to-speech is not available');
    const v = this.deps.config.voice || {};
    const text = stripMarkdownForSpeech(body.text).slice(0, 5000);
    try {
      const out = await voice.speak(text, { rate: v.ttsRate, voice: v.ttsVoice || undefined });
      return { ok: Boolean(out && out.ok !== false), provider: (out && out.provider) || null };
    } catch (err) {
      throw httpError(502, `Speech failed: ${err.message}`, err.hint ? { hint: err.hint } : undefined);
    }
  }

  /** @private */
  ttsStop() {
    const voice = this.deps.voice;
    try {
      if (voice && typeof voice.stop === 'function') voice.stop();
    } catch (err) {
      log.warn(`tts stop failed: ${err.message}`);
    }
    return { ok: true };
  }

  /** @private */
  async context() {
    const ctx = this.deps.context || {};
    if (typeof ctx.gatherContext !== 'function') {
      return {
        time: nowIso(),
        project: { dir: this.session.projectDir, name: path.basename(this.session.projectDir) },
        errors: ['The desktop context module is not available in this installation.'],
      };
    }
    return ctx.gatherContext({ driver: await this.driver(), projectDir: this.session.projectDir, config: this.deps.config });
  }

  /** @private */
  async show() {
    this.hub.broadcast('show', {});
    const ui = this.deps.uihost;
    if (!ui || typeof ui.show !== 'function') return { ok: true, host: 'none', url: this.url };
    try {
      const out = await Promise.race([
        ui.show(this.url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the window host did not respond')), 15000).unref()),
      ]);
      return { ok: true, host: (out && out.host) || 'none' };
    } catch (err) {
      log.warn(`showing the dialog failed: ${err.message}`);
      return { ok: false, host: 'none', error: err.message };
    }
  }

  /**
   * @private POST /api/ui/visibility {page, visible, focused}: a dialog page reports whether it
   * can be seen (after a 'show' event, and when that changes), so show() can tell a minimized or
   * hidden dialog from one in front where windows cannot be listed.
   */
  uiVisibility({ body }) {
    const page = typeof body.page === 'string' ? body.page.slice(0, 100) : '';
    if (!page) throw httpError(400, 'page is required');
    if (typeof body.visible !== 'boolean') throw httpError(400, 'visible must be true or false');
    const ui = this.deps.uihost;
    if (ui && typeof ui.noteVisibility === 'function') ui.noteVisibility({ page, visible: body.visible, focused: body.focused === true });
    return { ok: true };
  }

  /** @private */
  shutdown({ res }) {
    sendJson(res, 200, { ok: true });
    let called = false;
    const go = () => {
      if (called) return;
      called = true;
      if (typeof this.deps.onShutdown === 'function') this.deps.onShutdown('api');
    };
    res.once('finish', () => setImmediate(go));
    res.once('close', () => setImmediate(go));
    return HANDLED;
  }

  /** @private cancel an approval card whose requester disconnected */
  cancelApproval(id) {
    const perms = this.deps.permissions;
    let resolvedEvent = false;
    const watch = (type, data) => {
      if (type === 'approval_resolved' && data && data.id === id) resolvedEvent = true;
    };
    this.hub.on('event', watch);
    const reason = 'Cancelled: Claude Code stopped waiting for this approval';
    try {
      if (typeof perms.cancel === 'function') perms.cancel(id, reason);
      else perms.resolve(id, 'deny', reason);
    } catch (err) {
      log.warn(`cancelling approval ${id} failed: ${err.message}`);
    } finally {
      this.hub.removeListener('event', watch);
    }
    if (!resolvedEvent) this.hub.broadcast('approval_resolved', { id, decision: 'cancelled' });
    log.info(`approval ${id} cancelled: the MCP request disconnected`);
  }

  /** @private POST /api/mcp/permission (long poll) */
  async mcpPermission({ res, body }) {
    const perms = this.deps.permissions;
    if (!perms || typeof perms.request !== 'function') throw httpError(503, 'Approvals are not available');
    if (typeof body.tool_name !== 'string' || !body.tool_name) throw httpError(400, 'tool_name is required');
    const input = isPlainObject(body.input) ? body.input : {};
    const before = new Set();
    try {
      for (const p of perms.pending() || []) if (p && p.id) before.add(p.id);
    } catch {
      /* ignore */
    }
    let cardId = null;
    let disconnected = false;
    let settled = false;
    const claim = (type, data) => {
      if (cardId || type !== 'approval_request' || !data || !data.id) return;
      if (before.has(data.id) || this.claimedApprovals.has(data.id)) return;
      if (data.toolName && data.toolName !== body.tool_name) return;
      cardId = data.id;
      this.claimedApprovals.add(cardId);
      if (disconnected) setImmediate(() => this.cancelApproval(cardId));
    };
    const onClose = () => {
      if (settled || res.writableFinished) return;
      disconnected = true;
      if (cardId) this.cancelApproval(cardId);
    };
    this.hub.on('event', claim);
    res.on('close', onClose);
    let decision;
    try {
      decision = await perms.request({ tool_name: body.tool_name, input, tool_use_id: body.tool_use_id || null });
    } catch (err) {
      log.error('permission broker failed:', err);
      decision = { behavior: 'deny', message: `Permission check failed: ${err.message}` };
    } finally {
      settled = true;
      this.hub.removeListener('event', claim);
      res.removeListener('close', onClose);
      if (cardId) this.claimedApprovals.delete(cardId);
    }
    if (disconnected) return HANDLED;
    if (!decision || (decision.behavior !== 'allow' && decision.behavior !== 'deny')) {
      decision = { behavior: 'deny', message: 'The permission broker returned no decision' };
    }
    if (decision.behavior === 'allow' && !isPlainObject(decision.updatedInput)) decision = { ...decision, updatedInput: input };
    return decision;
  }

  /**
   * @private 409 COMMAND_STOPPED: the bridge terminal is still on a command the user stopped, so
   * what it sends now belongs to cancelled work (`anywhere reply`/`ask` print STOPPED for it)
   */
  stoppedCommandError(what) {
    return httpError(409, `The user pressed Stop in the dialog, so this command was cancelled and ${what}`, {
      code: 'COMMAND_STOPPED',
      hint: 'Abandon this command: do not continue its steps or send more replies. Run "anywhere listen" for the next command.',
    });
  }

  /** @private POST /api/mcp/ask (long poll) */
  async mcpAsk({ res, body }) {
    const bridge = this.deps.bridge;
    if (this.session && this.session.mode === 'bridge' && bridge && bridge.commandStopped) throw this.stoppedCommandError('this question was not shown');
    const ac = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) ac.abort();
    };
    res.on('close', onClose);
    // A bridge terminal asking a question is alive, however long the user takes to answer.
    const touch = () => {
      if (this.session && typeof this.session.touchBridge === 'function') this.session.touchBridge();
    };
    touch();
    try {
      const out = await this.deps.questions.ask({
        question: body.question,
        options: body.options,
        timeoutSec: body.timeoutSec,
        signal: ac.signal,
      });
      if (ac.signal.aborted) return HANDLED;
      return out;
    } finally {
      res.removeListener('close', onClose);
      touch();
    }
  }

  /** @private */
  async mcpNotify({ body }) {
    const out = this.session.notify({ message: body.message, level: body.level, speak: body.speak });
    if (out.delivered) return out;
    // Nobody is looking at the dialog: fall back to the OS.
    let delivered = false;
    if (typeof this.deps.notifyOS === 'function') {
      try {
        await Promise.race([this.deps.notifyOS('Claude Anywhere', String(body.message)), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 8000).unref())]);
        delivered = true;
      } catch (err) {
        log.warn(`OS notification failed: ${err.message}`);
      }
    }
    const voice = this.deps.voice;
    const v = this.deps.config.voice || {};
    // The announcer already says notify {speak:true} (through the dialog or the speakers).
    if (body.speak && this.deps.announcer && v.tts !== 'off') return { ok: true, delivered: true };
    if (body.speak && voice && typeof voice.speak === 'function' && v.tts !== 'off') {
      voice.speak(stripMarkdownForSpeech(String(body.message)).slice(0, 600), { rate: v.ttsRate, voice: v.ttsVoice || undefined }).then(
        () => {},
        (err) => log.warn(`speaking the notification failed: ${err.message}`)
      );
      delivered = true;
    }
    return { ok: true, delivered };
  }

  /** @private */
  mcpActivity({ body }) {
    return this.session.activity(body);
  }

  /** @private POST /api/bridge/listen (long poll) */
  async bridgeListen({ res, body }) {
    const bridge = this.deps.bridge;
    if (!bridge) throw httpError(503, 'Bridge mode is not available');
    let sec = Number(body.timeoutSec);
    if (!Number.isFinite(sec) || sec <= 0) sec = LISTEN_DEFAULT_SEC;
    sec = Math.min(LISTEN_MAX_SEC, Math.max(1, sec));
    const ac = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) ac.abort();
    };
    res.on('close', onClose);
    let cmd;
    try {
      cmd = await bridge.next(sec * 1000, { signal: ac.signal });
    } finally {
      res.removeListener('close', onClose);
    }
    if (cmd && cmd.stop) return { stop: true };
    if (!cmd) {
      if (ac.signal.aborted || res.destroyed) return HANDLED;
      return { timeout: true };
    }
    if (ac.signal.aborted || res.destroyed || (res.socket && res.socket.destroyed)) {
      bridge.requeue(cmd);
      return HANDLED;
    }
    res.on('close', () => {
      if (!res.writableFinished) bridge.requeue(cmd);
    });
    sendJson(res, 200, { command: cmd });
    return HANDLED;
  }

  /** @private */
  bridgeReply({ body }) {
    const bridge = this.deps.bridge;
    if (!bridge) throw httpError(503, 'Bridge mode is not available');
    if (typeof body.text !== 'string') throw httpError(400, 'text must be a string');
    if (bridge.stopped) {
      throw httpError(409, 'Bridge mode is off: the dialog switched to companion mode, so this reply was not shown', {
        hint: 'Stop the listen loop. Run "/anywhere here" again after switching the dialog back to bridge mode.',
      });
    }
    const out = bridge.reply({ text: body.text, final: Boolean(body.final), speak: body.speak !== false });
    if (out && out.stopped) throw this.stoppedCommandError('this reply was not shown');
    return out;
  }
}

/**
 * Build the daemon HTTP server (call .listen(port) next).
 * @param {object} deps see DaemonServer
 * @returns {DaemonServer}
 */
function createServer(deps) {
  return new DaemonServer(deps);
}

module.exports = { createServer, DaemonServer, tokenMatches, validateConfigUpdate, homeId, currentUid, SECURITY_HEADERS, CSP, MIME };
