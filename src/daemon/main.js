'use strict';

/**
 * Daemon entry point: wires the hub, brokers, bridge, session, HTTP server,
 * voice and UI host together, writes daemon.json and handles shutdown.
 *
 * Optional modules (permissions, prompt, voice, uihost, os, context) are
 * loaded defensively: a missing or broken one degrades the daemon instead of
 * stopping it (no voice → voice capabilities false, no UI host → the URL is
 * printed, no policy module → every non-read-only tool asks the user).
 *
 * Run directly: node src/daemon/main.js [--project DIR] [--mode companion|bridge]
 *                                       [--ui HOST] [--no-open] [--port N]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const configMod = require('../shared/config');
const paths = require('../shared/paths');
const state = require('../shared/state');
const platformMod = require('../shared/platform');
const { spawnDetached } = require('../shared/proc');
const { uuid, randomToken, sleep, nowIso, truncate } = require('../shared/util');
const { createLogger, audit, applyPrivacyConfig, redact } = require('../shared/log');
const { Hub } = require('./hub');
const { QuestionBroker } = require('./questions');
const { Bridge } = require('./bridge');
const { SessionManager, displayName, summary, READ_ONLY_TOOLS } = require('./session');
const { createServer, homeId, currentUid } = require('./server');

const log = createLogger('daemon');

const ATTENTION_THROTTLE_MS = 3000;
const MAX_QUEUED_SPEECH = 4; // cards announced aloud one after another; more than this are only shown
const SHUTDOWN_HARD_MS = 8000;
const FALLBACK_PORTS = 19; // a busy configured port N falls back to N+1..N+19 before a random port
const DYING_DAEMON_WAIT_MS = SHUTDOWN_HARD_MS + 2000; // how long a start waits for our previous daemon to free its port
const UI_OPEN_TIMEOUT_MS = 20000;
const START_LOCK_WAIT_MS = 10000; // how long a second start waits for the first to come up
const START_LOCK_STALE_MS = 30000; // a start never holds the lock this long (it is released once daemon.json is written)
const START_LOCK_FRESH_MS = 2000; // an empty lock file this young is still being written
const FALLBACK_DRIVER_METHODS = [
  'capabilities', 'displays', 'captureDisplay', 'cursorPosition', 'moveMouse', 'click', 'mouseDown', 'mouseUp', 'drag',
  'scroll', 'typeText', 'keyCombo', 'listWindows', 'activeWindow', 'focusWindow', 'minimizeWindow', 'setTopmost',
  'clipboardGet', 'clipboardSet', 'close',
  // optional: UiHost closes just the dialog window with it (macOS) when the driver has it
  'closeWindow',
];

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.PACKAGE_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * require() that never throws: logs and returns null when the module is
 * missing or fails to load.
 * @param {string} rel path relative to this file
 * @param {string[]} [exportsNeeded]
 * @returns {object|null}
 */
function optionalRequire(rel, exportsNeeded = []) {
  try {
    const mod = require(rel);
    const missing = exportsNeeded.filter((n) => !mod || mod[n] == null);
    if (missing.length) {
      log.warn(`${rel} does not export ${missing.join(', ')}; that feature is disabled`);
      return null;
    }
    return mod;
  } catch (err) {
    const target = path.basename(rel);
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(target)) {
      log.warn(`${rel} is not available; continuing without it`);
    } else {
      log.error(`${rel} failed to load; continuing without it:`, err);
    }
    return null;
  }
}

/**
 * A driver stand-in that creates the real driver on the first method call.
 * @param {()=>Promise<object>} getDriver
 * @param {string[]} [methods]
 * @returns {object}
 */
function createLazyDriver(getDriver, methods = FALLBACK_DRIVER_METHODS) {
  const lazy = { name: 'lazy', lazy: true };
  for (const m of methods) {
    lazy[m] = async (...args) => {
      const d = await getDriver();
      if (!d || typeof d[m] !== 'function') {
        const e = new Error(`The desktop driver does not support ${m}()`);
        e.code = 'UNSUPPORTED';
        throw e;
      }
      return d[m](...args);
    };
  }
  return lazy;
}

/**
 * Minimal approval broker used only when src/daemon/permissions.js is
 * unavailable: read-only anywhere tools pass, everything else asks the user.
 */
class BasicPermissionBroker {
  constructor({ config, hub, onNeedAttention } = {}) {
    this.config = config;
    this.hub = hub;
    this.onNeedAttention = onNeedAttention;
    this.entries = new Map();
    this.sessionAllow = new Set();
  }

  async request({ tool_name: toolName, input, tool_use_id: toolUseId } = {}) {
    const name = String(toolName || '');
    const inp = input && typeof input === 'object' ? input : {};
    if (READ_ONLY_TOOLS.includes(name) || this.sessionAllow.has(name)) {
      audit({ type: 'permission', tool: name, decision: 'allow', by: 'rule' });
      return { behavior: 'allow', updatedInput: inp };
    }
    const id = `ap_${uuid()}`;
    const card = {
      id,
      toolName: name,
      displayName: displayName(name),
      summary: summary(name, inp),
      input: inp,
      risk: 'medium',
      reason: 'Approval required (the permission policy module is not installed)',
      ts: nowIso(),
      toolUseId: toolUseId || null,
    };
    const timeoutSec = Math.min(86400, Number((this.config.permissions || {}).approvalTimeoutSec) || 600);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish(id, 'deny', `No response from the user within ${timeoutSec} s`, 'timeout');
      }, timeoutSec * 1000);
      this.entries.set(id, { card, resolve, timer });
      this.hub.broadcast('approval_request', card);
      if (typeof this.onNeedAttention === 'function') {
        try {
          this.onNeedAttention({ kind: 'approval', id, summary: `${card.displayName}: ${card.summary}` });
        } catch {
          /* ignore */
        }
      }
    });
  }

  finish(id, decision, message, why, via) {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    clearTimeout(e.timer);
    const allow = decision === 'allow' || decision === 'allow_session';
    if (decision === 'allow_session') this.sessionAllow.add(e.card.toolName);
    audit({ type: 'permission', tool: e.card.toolName, summary: e.card.summary, decision, by: why || 'user', ...(via ? { via } : {}) });
    this.hub.broadcast('approval_resolved', { id, decision, ...(via ? { via } : {}) });
    e.resolve(allow ? { behavior: 'allow', updatedInput: e.card.input } : { behavior: 'deny', message: message || 'The user denied this action' });
    return true;
  }

  resolve(id, decision, message, { via } = {}) {
    if (!['allow', 'allow_session', 'deny'].includes(decision)) return false;
    return this.finish(id, decision, message, 'user', typeof via === 'string' ? via : undefined);
  }

  cancelAll(reason = 'Cancelled') {
    for (const id of [...this.entries.keys()]) this.finish(id, 'deny', reason, 'cancel');
  }

  pending() {
    return [...this.entries.values()].map((e) => e.card);
  }

  setMode() {
    /* the basic broker always asks */
  }

  clearSessionRules() {
    this.sessionAllow.clear();
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Text that is safe and pleasant to read aloud: secrets masked (never spoken), whitespace
 * collapsed, cut to `max` characters.
 * @param {*} text
 * @param {number} max
 * @param {(word:string)=>any} [secretLike] flags a word that looks like a password or token
 * @returns {string}
 */
function speakable(text, max, secretLike) {
  let s = redact(String(text == null ? '' : text));
  if (typeof secretLike === 'function') {
    s = s
      .split(/(\s+)/)
      .map((w) => {
        try {
          return w.trim() && secretLike(w) ? 'hidden' : w;
        } catch {
          return w;
        }
      })
      .join('');
  }
  s = s
    .replace(/\*{3}/g, 'hidden')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(s, max);
}

/** The risk notes of an approval card: card.notes, else the clauses after the first ";" of its reason. */
function riskNotes(card) {
  if (Array.isArray(card.notes)) return card.notes.filter((n) => typeof n === 'string' && n.trim());
  if (typeof card.notes === 'string' && card.notes.trim()) return [card.notes];
  if (typeof card.reason !== 'string' || !['high', 'critical'].includes(card.risk)) return [];
  return card.reason
    .split(';')
    .slice(1)
    .map((n) => n.replace(/\s*\([^)]*\)/g, '').trim())
    .filter(Boolean);
}

/**
 * What the daemon says aloud for a new card (HEADLINE-SCENARIO-12): a hands-free user must hear
 * which action they approve, or the question and its options, not only that something waits.
 * @param {{kind?:string, summary?:string, displayName?:string, toolName?:string, reason?:string,
 *   risk?:string, notes?:string[]|string, question?:string, options?:string[]}} info
 * @param {{secretLike?:(word:string)=>any}} [opts]
 * @returns {string}
 */
function attentionSpeech(info = {}, { secretLike } = {}) {
  const i = info && typeof info === 'object' ? info : {};
  const sentence = (t) => (t ? `${t[0].toUpperCase()}${t.slice(1)}` : t);
  if (i.kind === 'question') {
    const q = speakable(i.question || i.summary, 220, secretLike);
    if (!q) return 'Claude has a question for you';
    const options = (Array.isArray(i.options) ? i.options : []).map((o) => speakable(o, 50, secretLike)).filter(Boolean);
    const some = options.slice(0, 3);
    let tail = '';
    if (some.length === 1) tail = ` Option: ${some[0]}.`;
    else if (some.length > 1) tail = ` Options: ${some.slice(0, -1).join(', ')}${options.length > 3 ? ', ' : ' or '}${some[some.length - 1]}${options.length > 3 ? ', or another' : ''}.`;
    return `Claude asks: ${/[?.!…]$/.test(q) ? q : `${q}?`}${tail}`;
  }
  // "Run: gcloud run deploy shop-api --region us-central1" → "gcloud run deploy shop-api region us-central1".
  const action = String(i.summary || i.displayName || i.toolName || '')
    .replace(/^Run:\s*/, '')
    .replace(/(^|\s)--?(?=[A-Za-z])/g, '$1');
  const what = speakable(action, 120, secretLike).replace(/[?.!:;,]+$/, '');
  if (!what) return 'Claude needs your approval';
  const notes = riskNotes(i)
    .map((n) => speakable(n, 90, secretLike).replace(/[.;,]+$/, ''))
    .filter(Boolean)
    .slice(0, 2);
  return `Approve: ${what}?${notes.length ? ` ${notes.map(sentence).join('. ')}.` : ''}`;
}

/**
 * React to a new approval or question card (the brokers' onNeedAttention): reopen the dialog when
 * nothing that shows cards is connected (a dialog page or TUI; `anywhere send --wait` watchers do
 * not count), post an OS notification, and say the card aloud for voice users. Reopening and
 * notifications are throttled; announcements queue, and one whose card was answered meanwhile
 * is skipped.
 * @param {object} deps
 * @param {object} deps.config the live config (voice section)
 * @param {()=>number} deps.clientCount connected clients that show cards: dialog pages and TUIs
 * @param {()=>object|null} [deps.getUihost]
 * @param {()=>string|null} [deps.getUrl] the dialog URL
 * @param {(title:string, body:string)=>Promise<any>} [deps.notifyOS]
 * @param {()=>object|null} [deps.getVoice]
 * @param {(kind:string, id:string)=>object|null|undefined} [deps.findCard] the pending card (null once
 *   it is resolved, undefined when unknown)
 * @param {(word:string)=>any} [deps.secretLike]
 * @param {()=>boolean} [deps.isShuttingDown]
 * @returns {(info:object)=>void}
 */
function createAttentionHandler({
  config,
  clientCount,
  getUihost = () => null,
  getUrl = () => null,
  notifyOS = null,
  getVoice = () => null,
  findCard = null,
  secretLike = null,
  isShuttingDown = () => false,
  throttleMs = ATTENTION_THROTTLE_MS,
  now = Date.now,
} = {}) {
  let lastAttention = -Infinity;
  let speech = Promise.resolve();
  let queued = 0;
  const lookup = (kind, id) => {
    if (typeof findCard !== 'function' || !id) return undefined;
    try {
      return findCard(kind, id);
    } catch {
      return undefined;
    }
  };
  return (info = {}) => {
    if (isShuttingDown()) return; // a window opened now would outlive the daemon
    const kind = info && info.kind === 'question' ? 'question' : 'approval';
    const card = lookup(kind, info && info.id);
    // The broker's info, completed from its card (an approval's reason and risk notes).
    const full = { ...(card || {}), ...(info || {}), kind };
    const t = now();
    if (t - lastAttention >= throttleMs) {
      lastAttention = t;
      const detail = truncate(String(full.summary || full.question || full.displayName || full.toolName || ''), 200);
      const uihost = getUihost();
      const url = getUrl();
      if (clientCount() === 0 && uihost && url) {
        Promise.resolve()
          .then(() => uihost.show(url))
          .catch((err) => log.warn(`could not show the dialog: ${err.message}`));
      }
      if (notifyOS) {
        Promise.resolve()
          .then(() => notifyOS('Claude needs your input', detail || (kind === 'question' ? 'Claude has a question for you.' : 'Claude is waiting for your approval.')))
          .catch((err) => log.debug(`OS notification failed: ${err.message}`));
      }
    }
    const v = config.voice || {};
    const voice = getVoice();
    if (!voice || !v.speakResponses || v.tts === 'off' || queued >= MAX_QUEUED_SPEECH) return;
    const text = attentionSpeech(full, { secretLike });
    queued += 1;
    speech = speech
      .then(() => {
        queued -= 1;
        // Answered while earlier cards were announced: nothing to say any more.
        if (lookup(kind, info && info.id) === null) return null;
        return voice.speak(text, { rate: v.ttsRate, voice: v.ttsVoice || undefined });
      })
      .catch((err) => log.debug(`speaking the attention prompt failed: ${err.message}`));
  };
}

function alreadyRunningError(existing, detail) {
  const where = existing ? existing.url || `port ${existing.port}` : detail;
  const e = new Error(`Claude Anywhere is already running (pid ${existing ? existing.pid : '?'}${where ? `, ${where}` : ''})`);
  e.code = 'ALREADY_RUNNING';
  e.state = existing || null;
  return e;
}

/** @returns {string} run/daemon.lock: held by a daemon from its single-instance check until daemon.json is written */
function startLockPath() {
  return path.join(paths.runDir(), 'daemon.lock');
}

function readStartLock(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  let pid = null;
  try {
    pid = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid) || null;
  } catch {
    /* empty: the holder is still writing it */
  }
  return { pid, ageMs: Date.now() - st.mtimeMs };
}

/**
 * Take the exclusive start lock, so two daemons started at the same moment (the hotkey
 * pressed twice, two /anywhere runs) cannot both pass the single-instance check. While
 * another live process holds it, wait for that daemon to answer and report it as running.
 * @param {{waitMs?:number}} [opts]
 * @returns {Promise<()=>void>} releases the lock (idempotent)
 */
async function acquireStartLock({ waitMs = START_LOCK_WAIT_MS } = {}) {
  const file = startLockPath();
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') {
        log.warn(`could not take the start lock ${file}: ${err.message}; continuing without it`);
        return () => {};
      }
    }
    if (fd !== null) {
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: nowIso() }));
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const cur = readStartLock(file);
        if (cur && cur.pid && cur.pid !== process.pid) return;
        try {
          fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    }
    const holder = readStartLock(file);
    if (!holder) continue; // released just now
    const stale = holder.pid ? holder.pid === process.pid || !state.isPidAlive(holder.pid) || holder.ageMs > START_LOCK_STALE_MS : holder.ageMs > START_LOCK_FRESH_MS;
    if (stale) {
      log.warn(`removing a stale start lock${holder.pid ? ` (pid ${holder.pid})` : ''}`);
      try {
        fs.unlinkSync(file);
      } catch {
        /* someone else removed it */
      }
      continue;
    }
    const existing = await state.findRunningDaemon({ timeoutMs: 1000 });
    if (existing && existing.pid !== process.pid) throw alreadyRunningError(existing);
    if (Date.now() >= deadline) throw alreadyRunningError(null, `another daemon (pid ${holder.pid || '?'}) is still starting`);
    await sleep(100);
  }
}

/**
 * GET /api/health on a local port.
 * @returns {Promise<object|null>} the health body when a Claude Anywhere daemon answers there (any daemon:
 *   another user's or another state directory's too, see isOwnDaemon; a daemon that is shutting down
 *   answers 503 with shuttingDown:true)
 */
async function probeDaemon(port, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    return body && body.app === 'claude-anywhere' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a /api/health body comes from a daemon of this state directory and OS user. Every
 * user's daemon defaults to the same port, so "a Claude Anywhere daemon answers" is not enough.
 * @param {object|null} body
 * @param {{home?:string, uid?:number|null}} [self]
 * @returns {boolean}
 */
function isOwnDaemon(body, { home = homeId(), uid = currentUid() } = {}) {
  if (!body || typeof body.home !== 'string' || body.home !== home) return false;
  return body.uid == null || uid == null || body.uid === uid;
}

/**
 * Delete run/screenshot-*.png: `anywhere computer screenshot` (bridge mode takes one after every
 * step) saves them there, and each can show anything that was on screen.
 */
function removeCliScreenshots(dir = paths.runDir()) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!/^screenshot-.*\.png$/.test(n)) continue;
    try {
      fs.unlinkSync(path.join(dir, n));
    } catch {
      /* in use or already gone */
    }
  }
}

/** @returns {string} run/last-port.json: the port this state dir's daemon bound last, for a stable dialog origin */
function lastPortPath() {
  return path.join(paths.runDir(), 'last-port.json');
}

/** @returns {number|null} the port bound last time for this configured port */
function readLastPort(wanted) {
  try {
    const j = JSON.parse(fs.readFileSync(lastPortPath(), 'utf8'));
    const p = Number(j && j.port);
    return j && j.wanted === wanted && Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
  } catch {
    return null;
  }
}

function writeLastPort(wanted, port) {
  try {
    fs.writeFileSync(lastPortPath(), `${JSON.stringify({ wanted, port })}\n`, { mode: 0o600 });
  } catch (err) {
    log.debug(`could not record the port: ${err.message}`);
  }
}

/**
 * Ports to try for a configured port, in order: the one this state dir bound last time for it,
 * the configured port, then its 19 neighbours in an order rotated by the state dir (two users who
 * both lose the configured port do not race for the same fallback). A stable port keeps the
 * dialog's origin, and with it the browser's microphone permission and the dialog's saved state.
 * @param {number} wanted
 * @param {{last?:number|null, home?:string}} [opts]
 * @returns {number[]}
 */
function candidatePorts(wanted, { last = null, home = homeId() } = {}) {
  const out = [];
  const add = (p) => {
    if (Number.isInteger(p) && p > 0 && p <= 65535 && !out.includes(p)) out.push(p);
  };
  add(last);
  add(wanted);
  const start = parseInt(String(home).slice(0, 8), 16) % FALLBACK_PORTS || 0;
  for (let i = 0; i < FALLBACK_PORTS; i += 1) add(wanted + 1 + ((start + i) % FALLBACK_PORTS));
  return out;
}

/** @returns {Promise<number|null>} the port, once listening on it succeeds within ms (null: still taken) */
async function listenWhenFree(server, port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(150);
    try {
      return await server.listen(port);
    } catch (err) {
      if (!err || err.code !== 'EADDRINUSE') throw err;
    }
  }
  return null;
}

/**
 * Listen on the configured port or a stable fallback (see candidatePorts), else a random one.
 * A busy port held by this state dir's own daemon means it is running (ALREADY_RUNNING): a
 * second daemon elsewhere would be an orphan. When that daemon is shutting down, wait for it
 * to free the port and take it over. Any other holder (an unrelated app, another user's or another
 * ANYWHERE_HOME's daemon) only moves this daemon to the next port.
 * @returns {Promise<number>} the bound port
 */
async function bindPort(server, wanted, { allowMultiple = false } = {}) {
  if (!wanted) return server.listen(0);
  const self = { home: homeId(), uid: currentUid() };
  const last = allowMultiple ? null : readLastPort(wanted);
  const moved = (bound) => {
    if (last && bound !== last) log.warn(`port ${last} is unavailable; the dialog moves to port ${bound} (the browser may ask for microphone access again)`);
    return bound;
  };
  for (const p of candidatePorts(wanted, { last, home: self.home })) {
    try {
      return moved(await server.listen(p));
    } catch (err) {
      if (!err || (err.code !== 'EADDRINUSE' && err.code !== 'EACCES')) throw err;
      if (allowMultiple || err.code !== 'EADDRINUSE') {
        log.info(`port ${p} is unavailable (${err.code})`);
        continue;
      }
      const other = await probeDaemon(p, p === wanted || p === last ? 1500 : 500);
      if (!isOwnDaemon(other, self)) {
        log.info(`port ${p} is in use${other ? " by another user's or state directory's Claude Anywhere" : ''}`);
        continue;
      }
      if (!other.shuttingDown) throw alreadyRunningError({ pid: other.pid, port: p, url: null, instanceId: other.instanceId });
      log.info(`the previous daemon (pid ${other.pid}) is shutting down; waiting for port ${p}`);
      const bound = await listenWhenFree(server, p, DYING_DAEMON_WAIT_MS);
      if (bound) return moved(bound);
      log.warn(`the previous daemon (pid ${other.pid}) still holds port ${p}`);
    }
  }
  log.warn(`port ${wanted} and its fallbacks are unavailable; using a random free port (the browser may ask for microphone access again)`);
  return server.listen(0);
}

/**
 * Run the daemon in this process. Unless allowMultiple is set, the single-instance check,
 * listen and the daemon.json write happen under an exclusive start lock.
 * @param {{project?:string, mode?:'companion'|'bridge', ui?:string, open?:boolean, port?:number,
 *   handleSignals?:boolean, exitProcess?:boolean, installCrashHandlers?:boolean, allowMultiple?:boolean}} [opts]
 * @returns {Promise<{url:string, port:number, token:string, instanceId:string, hub:Hub, session:SessionManager,
 *   server:object, shutdown:(reason?:string)=>Promise<void>, done:Promise<void>}>}
 */
async function runDaemon(opts = {}) {
  if (opts.allowMultiple) return startDaemon(opts);
  const release = await acquireStartLock();
  try {
    return await startDaemon(opts, release);
  } finally {
    release();
  }
}

/**
 * runDaemon's body (see there); calls releaseStartLock once daemon.json is written.
 * @private
 */
async function startDaemon(opts = {}, releaseStartLock = () => {}) {
  const {
    project,
    mode,
    ui,
    open = true,
    port,
    handleSignals = true,
    exitProcess = handleSignals,
    installCrashHandlers = handleSignals,
    allowMultiple = false,
  } = opts;
  const config = configMod.load();
  applyPrivacyConfig(config);
  if (ui) config.ui.host = ui;
  const platformInfo = platformMod.info();
  const version = packageVersion();

  if (!allowMultiple) {
    const existing = await state.findRunningDaemon({ timeoutMs: 1500 });
    if (existing && existing.pid !== process.pid) throw alreadyRunningError(existing);
  }

  let projectDir = path.resolve(project || process.cwd());
  if (!isDir(projectDir)) {
    log.warn(`project directory ${projectDir} does not exist; using ${process.cwd()}`);
    projectDir = process.cwd();
  }
  let daemonMode = mode || config.mode || 'companion';
  if (daemonMode !== 'companion' && daemonMode !== 'bridge') {
    log.warn(`unknown mode "${daemonMode}"; using companion`);
    daemonMode = 'companion';
  }
  const instanceId = uuid();
  const token = randomToken();
  const startedAt = nowIso();

  // ---- optional modules
  const osMod = optionalRequire('../os/index', ['getDriver']);
  const computerMod = optionalRequire('../os/computer', ['Computer']);
  const commonMod = optionalRequire('../os/common', ['notify']);
  const contextMod = optionalRequire('../context/desktop');
  const promptMod = optionalRequire('./prompt', ['buildSystemPrompt']);
  const permMod = optionalRequire('./permissions', ['PermissionBroker']);
  const voiceMod = optionalRequire('./voice', ['VoiceService']);
  const uihostMod = optionalRequire('./uihost', ['UiHost']);

  // ---- lazy driver / computer (created by the first request that needs them)
  let session = null;
  let driverPromise = null;
  let driverInstance = null;
  const getDriver = () => {
    if (!driverPromise) {
      driverPromise = (async () => {
        if (!osMod) {
          const e = new Error('Desktop control is not available in this installation (src/os is missing)');
          e.code = 'UNSUPPORTED';
          throw e;
        }
        const d = await osMod.getDriver();
        driverInstance = d;
        if (session && d && d.name) session.setDriverName(d.name);
        return d;
      })();
      driverPromise.catch(() => {
        driverPromise = null;
      });
    }
    return driverPromise;
  };
  let computerPromise = null;
  const getComputer = () => {
    if (!computerPromise) {
      computerPromise = (async () => {
        if (!computerMod) {
          const e = new Error('Screen capture is not available in this installation (src/os/computer.js is missing)');
          e.code = 'UNSUPPORTED';
          throw e;
        }
        const driver = await getDriver();
        // 'file': share the last-shot geometry (runDir()/last-shot.json) with the CLI and MCP server, so a dialog/attach screenshot updates the coordinate mapping they use.
        return new computerMod.Computer({ driver, config: config.computer, geometryStore: 'file' });
      })();
      computerPromise.catch(() => {
        computerPromise = null;
      });
    }
    return computerPromise;
  };
  const driverMethods = [...new Set([...FALLBACK_DRIVER_METHODS, ...(osMod && Array.isArray(osMod.DRIVER_METHODS) ? osMod.DRIVER_METHODS : [])])];
  const lazyDriver = createLazyDriver(getDriver, driverMethods);

  const context = contextMod
    ? {
        gatherContext: typeof contextMod.gatherContext === 'function' ? contextMod.gatherContext : undefined,
        formatContext: typeof contextMod.formatContext === 'function' ? contextMod.formatContext : undefined,
        detectProjects: typeof contextMod.detectProjects === 'function' ? contextMod.detectProjects : undefined,
        projectInfo: typeof contextMod.projectInfo === 'function' ? contextMod.projectInfo : undefined,
      }
    : {};

  // ---- core
  const hub = new Hub();
  let voice = null;
  if (voiceMod) {
    try {
      voice = new voiceMod.VoiceService({ config });
    } catch (err) {
      log.error('VoiceService failed to start; voice is disabled:', err);
    }
  }
  let server = null;
  let uihost = null;
  if (uihostMod) {
    try {
      uihost = new uihostMod.UiHost({
        config,
        platformInfo,
        driver: lazyDriver,
        // Browsers get a single-use launch URL, not the token URL (command lines are readable
        // by every local user). `server` is assigned below, before any dialog opens.
        launchUrl: (u) => (server && typeof server.launchUrl === 'function' ? server.launchUrl(u) : u),
        // Dialog pages only: a connected TUI must not stop show() from reopening a closed dialog.
        clientCount: () => hub.clientCount('ui'),
      });
    } catch (err) {
      log.error('UiHost failed to start; the dialog URL will be printed instead:', err);
    }
  }
  const notifyOS = commonMod ? (title, body) => commonMod.notify(title, body) : null;

  // `permissions` and `questions` are created below with this handler; it looks their cards up later.
  const onNeedAttention = createAttentionHandler({
    config,
    // Dialog pages and TUIs show cards; a CLI watcher (`anywhere send --wait`) does not.
    clientCount: () => hub.dialogCount(),
    getUihost: () => uihost,
    getUrl: () => (server ? server.url : null),
    notifyOS,
    getVoice: () => voice,
    findCard: (kind, id) => {
      const broker = kind === 'question' ? questions : permissions;
      if (!broker || typeof broker.pending !== 'function') return undefined;
      return broker.pending().find((c) => c && c.id === id) || null;
    },
    secretLike: permMod && typeof permMod.secretLike === 'function' ? permMod.secretLike : null,
    isShuttingDown: () => Boolean(shuttingDown),
  });

  let permissions = null;
  if (permMod) {
    try {
      // The live project: the broker's own copy only follows 'project' broadcasts, which come
      // after the git probe (up to 4 s), while the engine may already run in the new folder.
      permissions = new permMod.PermissionBroker({
        config,
        hub,
        onNeedAttention,
        projectDir,
        getProjectDir: () => (session ? session.projectDir : projectDir),
        // Edits in the folders the engine was given with --add-dir (VS Code workspaces) count as
        // in-project (HEADLINE-SCENARIO-10).
        getExtraDirs: () => (session ? session.engineAddDirs || [] : []),
        // type_text is judged by where it lands: a terminal runs it, an email does not (REGRESSIONS-7).
        activeWindow: () => lazyDriver.activeWindow(),
      });
    } catch (err) {
      log.error('PermissionBroker failed to start; using the basic always-ask broker:', err);
    }
  }
  if (!permissions) permissions = new BasicPermissionBroker({ config, hub, onNeedAttention });
  const questions = new QuestionBroker({ hub, onNeedAttention });
  const bridge = new Bridge({ hub });
  if (daemonMode !== 'bridge') bridge.stop();

  // ---- shutdown plumbing (declared before the server so /api/shutdown can call it)
  let shuttingDown = null;
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });
  const signalHandlers = [];

  const applyConfig = (next, prev) => {
    for (const k of Object.keys(next)) config[k] = next[k];
    applyPrivacyConfig(config);
    const pm = config.permissions && config.permissions.mode;
    if (prev && prev.permissions && pm !== prev.permissions.mode && typeof permissions.setMode === 'function') {
      try {
        permissions.setMode(pm);
      } catch (err) {
        log.warn(`permission mode change failed: ${err.message}`);
      }
    }
    if (prev && JSON.stringify(prev.computer) !== JSON.stringify(config.computer)) computerPromise = null;
    if (session) session.applyConfig(config);
    // The dialog's Settings (and `anywhere config set mode`) switch companion/bridge live.
    if (session && prev && config.mode !== prev.mode && (config.mode === 'companion' || config.mode === 'bridge')) {
      session.setMode(config.mode).catch((err) => log.warn(`mode change failed: ${err.message}`));
    }
    if (voice) {
      try {
        if (typeof voice.updateConfig === 'function') voice.updateConfig(config);
        else if ('config' in voice) voice.config = config;
      } catch {
        /* ignore */
      }
      refreshVoice(true);
    }
  };

  const refreshVoice = (broadcastSnapshot) => {
    if (!voice || typeof voice.capabilities !== 'function') return;
    // An unref'd timer: a slow probe must not keep a stopped daemon's process alive.
    const giveUp = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      if (t.unref) t.unref();
    });
    Promise.race([voice.capabilities(), giveUp])
      .then((caps) => {
        if (!caps || !session) return;
        const before = JSON.stringify(session.voiceInfo);
        session.setVoiceInfo(caps);
        if (broadcastSnapshot && JSON.stringify(session.voiceInfo) !== before) hub.broadcast('snapshot', session.snapshot());
      })
      .catch((err) => log.warn(`voice capabilities failed: ${err.message}`));
  };

  const shutdown = (reason = 'shutdown') => {
    if (shuttingDown) return shuttingDown;
    // From now on /api/health answers 503 (shuttingDown) and daemon.json is gone, so /anywhere
    // starts a fresh daemon (which waits for this one to free the port) instead of reusing this one.
    if (server) server.stopping = true;
    state.clearDaemonState(instanceId);
    shuttingDown = (async () => {
      log.info(`shutting down (${reason})`);
      audit({ type: 'daemon_stop', reason, instanceId });
      const hard = setTimeout(() => {
        log.warn('shutdown is taking too long; exiting now');
        state.clearDaemonState(instanceId);
        if (exitProcess) process.exit(0);
      }, SHUTDOWN_HARD_MS);
      if (hard.unref) hard.unref();
      const step = async (what, fn) => {
        try {
          await fn();
        } catch (err) {
          log.warn(`shutdown: ${what} failed: ${err && err.message}`);
        }
      };
      hub.broadcast('status', { status: 'offline', detail: 'Claude Anywhere stopped' });
      await step('cancel approvals', () => permissions.cancelAll('Claude Anywhere is shutting down'));
      await step('cancel questions', () => questions.cancelAll('Claude Anywhere is shutting down'));
      await step('close bridge', () => bridge.close());
      if (session) await step('stop session', () => session.shutdown());
      if (uihost) await step('close dialog', () => uihost.close());
      if (voice) await step('stop voice', () => voice.stop());
      await step('remove CLI screenshots', () => removeCliScreenshots());
      if (driverInstance) {
        await step('close driver', () => (osMod && typeof osMod.resetDriver === 'function' ? osMod.resetDriver() : driverInstance.close && driverInstance.close()));
      }
      hub.close();
      if (server) await step('close server', () => server.close());
      state.clearDaemonState(instanceId);
      for (const [sig, fn] of signalHandlers) process.removeListener(sig, fn);
      clearTimeout(hard);
      resolveDone();
      if (exitProcess) setImmediate(() => process.exit(0));
    })();
    return shuttingDown;
  };

  // ---- HTTP server
  server = createServer({
    hub,
    session: null,
    permissions,
    questions,
    bridge,
    voice,
    uihost,
    context,
    getDriver,
    config,
    token,
    instanceId,
    version,
    applyConfig,
    notifyOS,
    onShutdown: (why) => shutdown(why),
  });
  const wanted = Number.isInteger(port) ? port : Number.isInteger(config.port) ? config.port : 47120;
  let boundPort;
  try {
    boundPort = await bindPort(server, wanted, { allowMultiple });
  } catch (err) {
    hub.close();
    throw err;
  }
  if (wanted && !allowMultiple) writeLastPort(wanted, boundPort);
  const url = server.url;

  session = new SessionManager({
    config,
    hub,
    permissions,
    questions,
    bridge,
    port: boundPort,
    token,
    projectDir,
    mode: daemonMode,
    instanceId,
    version,
    getComputer,
    getDriver,
    context,
    buildSystemPrompt: promptMod ? promptMod.buildSystemPrompt : null,
    // Its settings section reaches a running engine by message, without a restart (LIVE-E2E-R3-4).
    settingsNotes: promptMod && typeof promptMod.settingsNotes === 'function' ? promptMod.settingsNotes : null,
    platformInfo,
  });
  server.session = session;
  server.deps.session = session;
  hub.setSnapshotProvider(() => session.snapshot());
  if (osMod && typeof osMod.selectBackend === 'function') {
    try {
      session.setDriverName(osMod.selectBackend().backend);
    } catch {
      /* ignore */
    }
  }

  // Linux: this process's start time in clock ticks (/proc/self/stat field 22), so `anywhere stop`
  // can tell this daemon from a later process that reused its pid (bin/anywhere.js daemonIdentity).
  let selfStartTicks = null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      if (Number.isFinite(ticks)) selfStartTicks = ticks;
    } catch {
      /* no /proc */
    }
  }
  const writeState = () => {
    if (shuttingDown) return; // shutdown removed daemon.json for good
    try {
      state.writeDaemonState({
        pid: process.pid,
        port: boundPort,
        token,
        instanceId,
        version,
        startedAt,
        ...(selfStartTicks != null ? { startTicks: selfStartTicks } : {}),
        project: session.projectDir,
        mode: session.mode,
        url,
        // What this process runs, so `anywhere stop` can match the OS's command line for this pid
        // (Windows CIM CommandLine) against it, whatever launched the daemon.
        execPath: process.execPath,
        argv: process.argv.slice(1),
      });
    } catch (err) {
      log.error(`could not write ${paths.daemonStatePath()}: ${err.message}`);
    }
  };
  writeState();
  releaseStartLock(); // daemon.json now answers for this daemon
  session.on('project', writeState);
  session.on('mode', writeState);

  audit({ type: 'daemon_start', instanceId, port: boundPort, project: projectDir, mode: daemonMode, version, pid: process.pid });
  log.info(`Claude Anywhere ${version} listening on 127.0.0.1:${boundPort} (project ${projectDir}, ${daemonMode} mode)`);

  session.init().catch((err) => log.warn(`project info failed: ${err.message}`));
  // Broadcast once the voice probe answers: a dialog that connected during startup would
  // otherwise keep the placeholder voiceInfo (serverStt:false without a hint).
  refreshVoice(true);

  // ---- process hooks
  if (handleSignals) {
    const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    if (process.platform === 'win32') sigs.push('SIGBREAK');
    for (const sig of sigs) {
      const fn = () => shutdown(sig);
      try {
        process.on(sig, fn);
        signalHandlers.push([sig, fn]);
      } catch {
        /* signal not supported here */
      }
    }
  }
  if (installCrashHandlers) {
    const onUncaught = (err) => log.error('uncaught exception (the daemon keeps running):', err);
    const onRejection = (reason) => log.error('unhandled promise rejection (the daemon keeps running):', reason instanceof Error ? reason : String(reason));
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    signalHandlers.push(['uncaughtException', onUncaught], ['unhandledRejection', onRejection]);
  }

  // ---- open the dialog
  const printUrl = (why) => {
    // A detached daemon's stderr is daemon.log: the access token stays out of it (`anywhere url`
    // prints the full link). A terminal running the daemon in the foreground gets the link itself.
    const link = process.stderr.isTTY ? url : `http://127.0.0.1:${boundPort}/  (run "anywhere url" for the link with its access token)`;
    process.stderr.write(`Claude Anywhere is running. Open this URL to use the dialog${why ? ` (${why})` : ''}:\n  ${link}\nOr run: anywhere tui\n`);
  };
  const wantOpen = open && (config.ui || {}).openOnStart !== false && (config.ui || {}).host !== 'none';
  if (wantOpen) {
    if (uihost) {
      try {
        const r = await Promise.race([
          uihost.open(url),
          sleep(UI_OPEN_TIMEOUT_MS).then(() => {
            throw new Error(`no window after ${UI_OPEN_TIMEOUT_MS / 1000} s`);
          }),
        ]);
        log.info(`dialog opened with ${(r && r.host) || 'none'}${r && r.detail ? ` (${r.detail})` : ''}`);
        if (!r || r.host === 'none') printUrl('no window host is available');
      } catch (err) {
        log.warn(`opening the dialog failed: ${err.message}`);
        printUrl('the window could not be opened');
      }
    } else {
      printUrl('no window host is installed');
    }
  } else if (handleSignals) {
    printUrl();
  }

  return {
    url,
    port: boundPort,
    token,
    instanceId,
    version,
    hub,
    session,
    server,
    permissions,
    questions,
    bridge,
    voice,
    uihost,
    shutdown,
    done,
  };
}

/**
 * Parse `main.js` argv.
 * @param {string[]} argv
 * @returns {{project?:string, mode?:string, ui?:string, open:boolean, port?:number}}
 */
function parseDaemonArgs(argv) {
  const out = { open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (a === '--project' || a === '-p') out.project = val();
    else if (a.startsWith('--project=')) out.project = a.slice(10);
    else if (a === '--mode') out.mode = val();
    else if (a.startsWith('--mode=')) out.mode = a.slice(7);
    else if (a === '--ui') out.ui = val();
    else if (a.startsWith('--ui=')) out.ui = a.slice(5);
    else if (a === '--no-open') out.open = false;
    else if (a === '--port') out.port = Number(val());
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535)) throw new Error('--port must be 0..65535');
  return out;
}

function logTail(file, lines = 20) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Start the daemon as a detached background process (or reuse a running one)
 * and wait until it answers /api/health.
 * @param {{project?:string, mode?:string, ui?:string, open?:boolean, timeoutMs?:number, env?:object}} [opts]
 * @returns {Promise<object>} daemon state plus {reused:boolean}
 */
async function startDaemonProcess({ project, mode, ui, open = true, timeoutMs = 15000, env } = {}) {
  const existing = await state.findRunningDaemon();
  if (existing) return { ...existing, reused: true };
  const projectDir = path.resolve(project || process.cwd());
  const args = [__filename, '--project', projectDir];
  if (mode) args.push('--mode', mode);
  if (ui) args.push('--ui', ui);
  if (!open) args.push('--no-open');
  const logFile = paths.daemonLogPath();
  const child = spawnDetached(process.execPath, args, {
    cwd: isDir(projectDir) ? projectDir : os.homedir(),
    env: env || process.env,
    logFile,
  });
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.on('error', (error) => {
    exited = { error };
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await state.findRunningDaemon({ timeoutMs: 1000 });
    if (st && (!child.pid || st.pid === child.pid)) return { ...st, reused: false };
    if (st && exited) return { ...st, reused: true }; // another start won the race
    // Exit code 0 is "already running": the winner may not have written daemon.json yet.
    if (exited && !exited.error && exited.code === 0 && !exited.signal) {
      await sleep(150);
      continue;
    }
    if (exited) {
      const how = exited.error ? exited.error.message : `exit code ${exited.code}${exited.signal ? `, ${exited.signal}` : ''}`;
      throw new Error(`The Claude Anywhere daemon stopped during startup (${how}). Log (${logFile}):\n${logTail(logFile)}`);
    }
    await sleep(150);
  }
  throw new Error(`The Claude Anywhere daemon did not answer within ${Math.round(timeoutMs / 1000)} s. Log (${logFile}):\n${logTail(logFile)}`);
}

if (require.main === module) {
  let parsed;
  try {
    parsed = parseDaemonArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`anywhere daemon: ${err.message}\n`);
    process.exit(2);
  }
  try {
    process.title = 'claude-anywhere-daemon';
  } catch {
    /* ignore */
  }
  runDaemon(parsed).catch((err) => {
    if (err && err.code === 'ALREADY_RUNNING') {
      process.stderr.write(`${err.message}\n`);
      process.exit(0);
    }
    process.stderr.write(`anywhere daemon failed to start: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

module.exports = {
  runDaemon,
  startDaemonProcess,
  parseDaemonArgs,
  createLazyDriver,
  BasicPermissionBroker,
  optionalRequire,
  acquireStartLock,
  startLockPath,
  probeDaemon,
  isOwnDaemon,
  candidatePorts,
  lastPortPath,
  createAttentionHandler,
  attentionSpeech,
};
