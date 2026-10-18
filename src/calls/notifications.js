'use strict';

/**
 * OS notifications as a ring signal (docs/CALLS-DESIGN.md §4.1 B).
 *
 * - Linux: watch org.freedesktop.Notifications.Notify method calls on the session bus with an
 *   unprivileged monitor. `busctl --user --json=short monitor` is preferred because its JSON
 *   escapes every string; `dbus-monitor` (the verified fallback) prints strings unescaped, so a
 *   notification text could imitate the parser's own syntax. `gdbus monitor` is not usable: it
 *   only shows signals, never method calls (checked on glib 2.80).
 * - Windows and WSL: poll driver.toastTexts() (the PowerShell host's UI Automation probe of the
 *   toast host) once a second.
 * - macOS: not available (Sequoia's notification banners do not expose their text); ring
 *   detection there relies on window titles, screen diffs and vision.
 *
 * Every notification is untrusted text (any page with notification permission can post one):
 * it only ever makes a candidate that vision and the answer gates must confirm.
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const proc = require('../shared/proc');
const { createLogger } = require('../shared/log');

const log = createLogger('calls-notify');

const NOTIFY_MATCH = "type='method_call',interface='org.freedesktop.Notifications',member='Notify'";
const MAX_BUFFER = 1024 * 1024; // pending dbus-monitor text kept between chunks
const MAX_FIELD = 2000;
const TOAST_FORGET_MS = 3000;
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const MAX_QUICK_FAILURES = 5;

// ---------------------------------------------------------------- text helpers

const HOST_RE = /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}|localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

/** Drop body markup (<b>, <a href>, <img>) and decode the common entities. */
function stripMarkup(s) {
  return String(s == null ? '' : s)
    .replace(/<[^<>]{0,300}>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (m, k) => ENTITIES[k]);
}

function clip(s, n = MAX_FIELD) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) : t;
}

/**
 * Chromium puts the page's origin on the first line of the body ("cliq.zoho.com\n\nIncoming audio
 * call"); Firefox-style "via host" lines are accepted too.
 * @returns {{origin:string|null, body:string}}
 */
function splitOrigin(rawBody) {
  const text = stripMarkup(rawBody).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const first = (lines[0] || '').trim();
  if (HOST_RE.test(first)) return { origin: first.toLowerCase(), body: lines.slice(1).join('\n').trim() };
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].trim().match(/^(?:via|from)\s+(\S+)$/i);
    if (m && HOST_RE.test(m[1])) return { origin: m[1].toLowerCase(), body: lines.filter((_, j) => j !== i).join('\n').trim() };
  }
  return { origin: null, body: text.trim() };
}

/**
 * The notification event for Notify's arguments (app_name, replaces_id, app_icon, summary, body,
 * actions, hints, expire_timeout).
 */
function notifyArgsToNotification(args, { ts = Date.now(), source } = {}) {
  if (!Array.isArray(args) || args.length < 5) return null;
  const [app, , , summary, body, actions, hints] = args;
  const h = hints && typeof hints === 'object' && !Array.isArray(hints) ? hints : {};
  const split = splitOrigin(body);
  const n = {
    app: clip(app, 200),
    summary: clip(stripMarkup(summary).trim()),
    body: clip(split.body),
    origin: split.origin,
    ts,
    source,
  };
  if (typeof h['desktop-entry'] === 'string') n.desktopEntry = clip(h['desktop-entry'], 200);
  if (Number.isFinite(Number(h.urgency))) n.urgency = Number(h.urgency);
  if (Array.isArray(actions)) n.actions = actions.filter((a) => typeof a === 'string').slice(0, 20).map((a) => clip(a, 100));
  return n;
}

// ---------------------------------------------------------------- busctl --json=short

/** Unwrap busctl's {type, data} variants. */
function unwrapVariant(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'type' in v && 'data' in v && Object.keys(v).length === 2) return unwrapVariant(v.data);
  return v;
}

/**
 * Parse one `busctl --json=short monitor` line.
 * @returns {object|null} a notification, or null for other messages and non-JSON lines
 */
function parseBusctlJson(line) {
  let msg;
  try {
    msg = JSON.parse(String(line));
  } catch {
    return null;
  }
  if (!msg || msg.type !== 'method_call' || msg.member !== 'Notify' || msg.interface !== 'org.freedesktop.Notifications') return null;
  const data = msg.payload && Array.isArray(msg.payload.data) ? msg.payload.data : null;
  if (!data || data.length !== 8) return null;
  const hints = {};
  if (data[6] && typeof data[6] === 'object') for (const [k, v] of Object.entries(data[6])) hints[k] = unwrapVariant(v);
  const ts = Number(msg['timestamp-realtime']) > 0 ? Math.round(Number(msg['timestamp-realtime']) / 1000) : Date.now();
  return notifyArgsToNotification([data[0], data[1], data[2], data[3], data[4], data[5], hints, data[7]], { ts, source: 'busctl' });
}

// ---------------------------------------------------------------- dbus-monitor (text)

const HEADER_RE = /^(method call|method return|signal|error) time=(\d+(?:\.\d+)?)[^\n]*/;
const TOKEN_KEYWORDS = '(?:string|object path|signature|uint32|int32|uint16|int16|uint64|int64|byte|boolean|double|unix fd|file descriptor|variant|array \\[|dict entry\\(|struct \\{|\\]|\\)|\\})';
// What may follow a string's closing quote: a newline, then an indented token or a closer, or a
// new message header, or the end of the text. dbus-monitor does not escape quotes or newlines.
const AFTER_STRING_RE = new RegExp(`^"\\n(?: {3,}${TOKEN_KEYWORDS}|(?:method call|method return|signal|error) time=)`);
const AT_END_RE = /^"\n?[ ]*$/;
const INCOMPLETE = Symbol('incomplete');

class DbusTextParser {
  constructor(text, complete) {
    this.s = text;
    this.i = 0;
    this.complete = complete; // the text ends at a message boundary (no more data will follow)
  }

  skipSpace() {
    while (this.i < this.s.length && /[ \t\n]/.test(this.s[this.i])) this.i++;
  }

  restOfLine() {
    const nl = this.s.indexOf('\n', this.i);
    if (nl < 0 && !this.complete) return INCOMPLETE;
    const end = nl < 0 ? this.s.length : nl;
    const v = this.s.slice(this.i, end).trim();
    this.i = end;
    return v;
  }

  quoted() {
    // this.i is at the opening quote
    let j = this.i + 1;
    for (;;) {
      j = this.s.indexOf('"', j);
      if (j < 0) return INCOMPLETE;
      let close = AFTER_STRING_RE.test(this.s.slice(j, j + 80));
      if (!close && AT_END_RE.test(this.s.slice(j))) {
        // Only a newline (or nothing) after the quote so far: the string may still go on.
        if (!this.complete) return INCOMPLETE;
        close = true;
      }
      if (close) {
        const v = this.s.slice(this.i + 1, j);
        this.i = j + 1;
        return v;
      }
      j++;
    }
  }

  value(depth = 0) {
    if (depth > 8) throw new Error('nesting too deep');
    this.skipSpace();
    if (this.i >= this.s.length) return INCOMPLETE;
    const rest = this.s.slice(this.i, this.i + 32);
    let m;
    if ((m = rest.match(/^(string|object path|signature) "/))) {
      this.i += m[0].length - 1;
      return this.quoted();
    }
    if ((m = rest.match(/^(uint32|int32|uint16|int16|uint64|int64|byte|double|unix fd|file descriptor) /))) {
      this.i += m[0].length;
      const v = this.restOfLine();
      if (v === INCOMPLETE) return v;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    if ((m = rest.match(/^boolean /))) {
      this.i += m[0].length;
      const v = this.restOfLine();
      return v === INCOMPLETE ? v : v === 'true';
    }
    if (rest.startsWith('variant ')) {
      this.i += 'variant '.length;
      return this.value(depth + 1);
    }
    if (rest.startsWith('array [')) {
      this.i += 'array ['.length;
      const items = [];
      for (;;) {
        this.skipSpace();
        if (this.i >= this.s.length) return INCOMPLETE;
        if (this.s[this.i] === ']') {
          this.i++;
          break;
        }
        const v = this.value(depth + 1);
        if (v === INCOMPLETE) return v;
        items.push(v);
      }
      // An array of dict entries becomes an object.
      if (items.length && items.every((x) => x && x.__entry)) return Object.fromEntries(items.map((x) => [String(x.key), x.value]));
      return items;
    }
    if (rest.startsWith('dict entry(')) {
      this.i += 'dict entry('.length;
      const key = this.value(depth + 1);
      if (key === INCOMPLETE) return key;
      const value = this.value(depth + 1);
      if (value === INCOMPLETE) return value;
      this.skipSpace();
      if (this.i >= this.s.length) return INCOMPLETE;
      if (this.s[this.i] !== ')') throw new Error('bad dict entry');
      this.i++;
      return { __entry: true, key, value };
    }
    if (rest.startsWith('struct {')) {
      this.i += 'struct {'.length;
      const items = [];
      for (;;) {
        this.skipSpace();
        if (this.i >= this.s.length) return INCOMPLETE;
        if (this.s[this.i] === '}') {
          this.i++;
          break;
        }
        const v = this.value(depth + 1);
        if (v === INCOMPLETE) return v;
        items.push(v);
      }
      return items;
    }
    // A token cut off at the end of a chunk ("str", "array"): wait for the rest of the line.
    if (!this.complete && this.s.indexOf('\n', this.i) < 0) return INCOMPLETE;
    throw new Error(`unexpected token near ${JSON.stringify(rest.slice(0, 20))}`);
  }
}

/** Offset of the next message header at or after `from` (a line start), or -1. */
function nextHeader(text, from) {
  const re = /(?:^|\n)(?:method call|method return|signal|error) time=/g;
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) return -1;
  return m[0].startsWith('\n') ? m.index + 1 : m.index;
}

/**
 * Parse `dbus-monitor` text output. Pure: feed it the unparsed rest from the previous call plus
 * the new chunk.
 * @param {string} text
 * @param {{final?:boolean}} [opts] final: no more data follows (the stream ended)
 * @returns {{notifications:object[], rest:string}} rest: text to prepend to the next chunk
 */
function parseDbusMonitor(text, { final = false } = {}) {
  const s = String(text == null ? '' : text);
  const notifications = [];
  let pos = nextHeader(s, 0);
  if (pos < 0) return { notifications, rest: final ? '' : s.slice(Math.max(0, s.lastIndexOf('\n') + 1)) };
  while (pos >= 0 && pos < s.length) {
    const lineEnd = s.indexOf('\n', pos);
    if (lineEnd < 0) return { notifications, rest: final ? '' : s.slice(pos) };
    const header = s.slice(pos, lineEnd);
    const hm = header.match(HEADER_RE);
    const isNotify = hm && hm[1] === 'method call' && /\binterface=org\.freedesktop\.Notifications;/.test(header) && /\bmember=Notify$/.test(header.trim());
    if (!isNotify) {
      const next = nextHeader(s, lineEnd + 1);
      if (next < 0) return { notifications, rest: final ? '' : s.slice(pos) };
      pos = next;
      continue;
    }
    const p = new DbusTextParser(s.slice(lineEnd + 1), final);
    const args = [];
    let incomplete = false;
    let bad = false;
    try {
      while (args.length < 8) {
        const v = p.value();
        if (v === INCOMPLETE) {
          incomplete = true;
          break;
        }
        args.push(v);
      }
    } catch (err) {
      bad = true;
      log.debug('unparsable Notify call skipped:', err.message);
    }
    if (incomplete && !final) return { notifications, rest: s.slice(pos) };
    const after = lineEnd + 1 + p.i;
    const next = nextHeader(s, after);
    // Exactly 8 arguments, and nothing but whitespace before the next header: anything else is a
    // malformed (or crafted) message and is dropped.
    const between = s.slice(after, next < 0 ? s.length : next);
    if (!bad && !incomplete && args.length === 8 && !between.trim()) {
      const ts = Math.round(Number(hm[2]) * 1000) || Date.now();
      const n = notifyArgsToNotification(args, { ts, source: 'dbus-monitor' });
      if (n) notifications.push(n);
    } else if (!bad && !incomplete && between.trim() && next < 0 && !final) {
      // Trailing text that is not a header yet: wait for more data.
      return { notifications, rest: s.slice(pos) };
    }
    if (next < 0) return { notifications, rest: '' };
    pos = next;
  }
  return { notifications, rest: '' };
}

// ---------------------------------------------------------------- Windows toasts

const TOAST_CHROME_RE = /^(?:dismiss|close|settings|notification settings|new notification|notifications?|expand|collapse|see more|more options|go to notification settings|turn off.*|\d+ new notifications?)$/i;
const TOAST_APP_RE = /^(?:google chrome|chrome|microsoft edge|microsoft\s*edge|edge|brave|chromium|firefox|mozilla firefox|opera|vivaldi|microsoft teams|teams|slack|zoom|zoom workplace|zoho cliq|cliq)$/i;

/**
 * Normalize driver.toastTexts() output: the Windows driver returns [{process, pid, className, name,
 * texts:string[], bounds}] where process is the toast host (ShellExperienceHost), not the app that
 * notified, and name is the localized "New notification". Also accepted: {toasts:[…]}, an array of
 * string arrays, or a flat array of strings (one toast).
 * @returns {Array<{app:string, texts:string[], bounds?:{x:number,y:number,width:number,height:number}}>}
 */
function normalizeToasts(r) {
  let list = Array.isArray(r) ? r : r && Array.isArray(r.toasts) ? r.toasts : r && Array.isArray(r.texts) ? [r] : [];
  if (list.length && list.every((x) => typeof x === 'string')) list = [{ texts: list }];
  const out = [];
  for (const t of list.slice(0, 20)) {
    let app = '';
    let texts = [];
    let bounds = null;
    if (Array.isArray(t)) texts = t;
    else if (typeof t === 'string') texts = [t];
    else if (t && typeof t === 'object') {
      app = String(t.app || '');
      texts = Array.isArray(t.texts) ? t.texts : [t.title, t.text, t.body].filter((x) => x != null);
      const b = t.bounds;
      if (b && [b.x, b.y, b.width, b.height].every((v) => Number.isFinite(Number(v))) && Number(b.width) > 0 && Number(b.height) > 0) {
        bounds = { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) };
      }
    }
    texts = texts
      .filter((x) => typeof x === 'string')
      .map((x) => clip(x.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim(), 500))
      .filter(Boolean);
    if (texts.length) out.push({ app: clip(app, 200), texts: texts.slice(0, 30), ...(bounds ? { bounds } : {}) });
  }
  return out;
}

/**
 * A notification from one toast's texts: the app (browser or call app name), the origin line,
 * then summary and body. Buttons ("Accept", "Decline") stay in the body: they are ring signals.
 */
function toastToNotification(toast, { ts = Date.now() } = {}) {
  if (!toast || !Array.isArray(toast.texts)) return null;
  let app = toast.app || '';
  let origin = null;
  const rest = [];
  for (const t of toast.texts) {
    if (TOAST_CHROME_RE.test(t)) continue;
    if (!app && TOAST_APP_RE.test(t)) {
      app = t;
      continue;
    }
    if (!origin && HOST_RE.test(t)) {
      origin = t.toLowerCase();
      continue;
    }
    if (!rest.includes(t)) rest.push(t);
  }
  if (!rest.length) return null;
  const n = { app: clip(app, 200), summary: clip(rest[0]), body: clip(rest.slice(1).join('\n')), origin, ts, source: 'toast' };
  if (toast.bounds) n.bounds = { ...toast.bounds }; // where the toast is on screen (logical px)
  return n;
}

// ---------------------------------------------------------------- watcher

function busAvailable(env) {
  if (env.DBUS_SESSION_BUS_ADDRESS) return true;
  const rt = env.XDG_RUNTIME_DIR;
  if (!rt) return false;
  try {
    return fs.statSync(path.join(rt, 'bus')).isSocket();
  } catch {
    return false;
  }
}

/**
 * Pick the notification source for this machine.
 * @returns {{backend:'toast'|'busctl'|'dbus-monitor'|null, reason?:string, hint?:string, fallback?:string}}
 */
function chooseBackend({ platform = process.platform, isWSL = false, driver, env = process.env, which = proc.which } = {}) {
  if (driver && typeof driver.toastTexts === 'function') return { backend: 'toast' };
  if (platform === 'win32' || isWSL) {
    return { backend: null, reason: 'this Windows driver cannot read notification toasts', hint: 'Update Claude Anywhere: the PowerShell host needs the toastTexts operation.' };
  }
  if (platform === 'darwin') {
    return { backend: null, reason: 'macOS does not expose notification banner text', hint: 'Calls are detected from window titles, screen changes and a vision check.' };
  }
  if (platform !== 'linux') return { backend: null, reason: `notifications are not supported on ${platform}` };
  if (!busAvailable(env)) {
    return { backend: null, reason: 'no D-Bus session bus (DBUS_SESSION_BUS_ADDRESS is not set)', hint: 'Run Claude Anywhere inside your desktop session.' };
  }
  const busctl = which('busctl');
  const monitor = which('dbus-monitor');
  if (busctl) return { backend: 'busctl', command: busctl, fallback: monitor ? 'dbus-monitor' : undefined, monitorCommand: monitor || undefined };
  if (monitor) return { backend: 'dbus-monitor', command: monitor };
  return { backend: null, reason: 'neither busctl nor dbus-monitor is installed', hint: 'Install dbus-monitor (Debian/Ubuntu: sudo apt install dbus-bin; Fedora: dbus-tools).' };
}

/**
 * Emits 'notification' {app, summary, body, origin, ts, source, desktopEntry?, urgency?, actions?}
 * and 'status' ({backend, running, reason?}). Never emits 'error'.
 */
class NotificationWatcher extends EventEmitter {
  /**
   * @param {{platform?:string|{platform:string,isWSL?:boolean}, isWSL?:boolean, driver?:object,
   *   spawn?:Function, env?:object, which?:Function, pollMs?:number, now?:()=>number}} [opts]
   */
  constructor(opts = {}) {
    super();
    const plat = opts.platform && typeof opts.platform === 'object' ? opts.platform : null;
    this.platform = plat ? plat.platform : opts.platform || process.platform;
    this.isWSL = plat ? Boolean(plat.isWSL) : Boolean(opts.isWSL);
    this.driver = opts.driver || null;
    this.spawn = opts.spawn || childProcess.spawn;
    this.env = opts.env || process.env;
    this.which = opts.which || proc.which;
    this.pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 1000;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.backend = null;
    this.reason = null;
    this.running = false;
    this._child = null;
    this._timer = null;
    this._restartTimer = null;
    this._failures = 0;
    this._seen = new Map();
    this._polling = false;
    this._choice = null;
  }

  /** @returns {{ok:boolean, backend:string|null, reason?:string, hint?:string}} */
  start() {
    if (this.running) return { ok: true, backend: this.backend };
    const choice = chooseBackend({ platform: this.platform, isWSL: this.isWSL, driver: this.driver, env: this.env, which: this.which });
    this._choice = choice;
    if (!choice.backend) {
      this.backend = null;
      this.reason = choice.reason;
      this.emit('status', this.status());
      return { ok: false, backend: null, reason: choice.reason, hint: choice.hint };
    }
    this.running = true;
    this.backend = choice.backend;
    this.reason = null;
    this._failures = 0;
    if (choice.backend === 'toast') this._startToasts();
    else this._spawnMonitor();
    this.emit('status', this.status());
    return { ok: true, backend: this.backend };
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
    clearTimeout(this._restartTimer);
    this._timer = null;
    this._restartTimer = null;
    const child = this._child;
    this._child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    this._seen.clear();
  }

  status() {
    return { backend: this.backend, running: this.running, available: Boolean(this.backend) || this.running, reason: this.reason || undefined };
  }

  _emitNotification(n) {
    if (!n) return;
    try {
      this.emit('notification', n);
    } catch (err) {
      log.warn('notification listener failed:', err && err.message);
    }
  }

  // ---- Windows toasts

  _startToasts() {
    const tick = async () => {
      if (this._polling || !this.running) return;
      this._polling = true;
      try {
        const res = await this.driver.toastTexts();
        this._onToasts(res);
        this._failures = 0;
      } catch (err) {
        this._failures++;
        if (this._failures === 3) log.warn('reading notification toasts failed:', err && err.message);
        if (err && err.code === 'UNSUPPORTED') {
          this.reason = err.message;
          this.stop();
          this.emit('status', this.status());
        }
      } finally {
        this._polling = false;
      }
    };
    this._timer = setInterval(tick, this.pollMs);
    if (this._timer.unref) this._timer.unref();
    tick();
  }

  /** Emit toasts not seen in the previous polls (exported through the class for tests). */
  _onToasts(res) {
    const now = this.now();
    for (const t of normalizeToasts(res)) {
      const key = `${t.app}\u0001${t.texts.join('\u0001')}`; // not the bounds: a toast slides in
      const was = this._seen.get(key);
      this._seen.set(key, now);
      if (was != null && now - was <= TOAST_FORGET_MS) continue;
      this._emitNotification(toastToNotification(t, { ts: now }));
    }
    for (const [k, at] of this._seen) if (now - at > TOAST_FORGET_MS) this._seen.delete(k);
  }

  // ---- Linux session bus

  _spawnMonitor() {
    if (!this.running) return;
    const busctl = this.backend === 'busctl';
    const c = this._choice || {};
    const cmd = busctl ? c.command || 'busctl' : (c.backend === 'dbus-monitor' ? c.command : c.monitorCommand) || 'dbus-monitor';
    const args = busctl ? ['--user', '--json=short', 'monitor', 'org.freedesktop.Notifications'] : ['--session', NOTIFY_MATCH];
    let child;
    try {
      child = this.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env, windowsHide: true });
    } catch (err) {
      this._onMonitorExit(null, err, '', false);
      return;
    }
    this._child = child;
    const started = this.now();
    const dec = new StringDecoder('utf8');
    let buf = '';
    let gotOutput = false;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      gotOutput = true;
      buf += dec.write(chunk);
      if (busctl) {
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.includes('"Notify"')) this._emitNotification(parseBusctlJson(line));
        }
        if (buf.length > MAX_BUFFER) buf = '';
      } else {
        const r = parseDbusMonitor(buf);
        for (const n of r.notifications) this._emitNotification(n);
        buf = r.rest.length > MAX_BUFFER ? '' : r.rest;
      }
    });
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        if (stderr.length < 4000) stderr += String(d);
      });
    }
    child.on('error', (err) => {
      if (this._child === child) this._child = null;
      this._onMonitorExit(child, err, stderr, gotOutput, started);
    });
    child.on('exit', (code, signal) => {
      if (this._child === child) this._child = null;
      this._onMonitorExit(child, code === 0 && !signal ? null : new Error(`exited with ${signal || code}`), stderr, gotOutput, started);
    });
  }

  _onMonitorExit(child, err, stderr, gotOutput, started = this.now()) {
    if (!this.running) return;
    if (child && child._anywhereHandled) return;
    if (child) child._anywhereHandled = true;
    const quick = this.now() - started < 3000;
    // busctl too old for --json (systemd < 240) or refused: switch to dbus-monitor once.
    if (this.backend === 'busctl' && quick && !gotOutput && this._choice && this._choice.fallback) {
      log.info(`busctl monitor failed (${(stderr || (err && err.message) || '').trim().split('\n')[0]}); using dbus-monitor`);
      this.backend = 'dbus-monitor';
      this.emit('status', this.status());
      this._spawnMonitor();
      return;
    }
    if (err && err.code === 'ENOENT') {
      this.reason = `${this.backend} is not installed`;
      this.running = false;
      this.emit('status', this.status());
      return;
    }
    this._failures = quick && !gotOutput ? this._failures + 1 : 1;
    if (this._failures > MAX_QUICK_FAILURES) {
      this.reason = `${this.backend} keeps exiting: ${(stderr || (err && err.message) || 'no output').trim().split('\n')[0]}`;
      this.running = false;
      log.warn(`notification watcher stopped: ${this.reason}`);
      this.emit('status', this.status());
      return;
    }
    const delay = RESTART_DELAYS_MS[Math.min(RESTART_DELAYS_MS.length - 1, this._failures - 1)];
    this._restartTimer = setTimeout(() => this._spawnMonitor(), delay);
    if (this._restartTimer.unref) this._restartTimer.unref();
  }
}

/**
 * @param {object} [opts] see NotificationWatcher
 * @returns {NotificationWatcher}
 */
function createNotificationWatcher(opts = {}) {
  return new NotificationWatcher(opts);
}

module.exports = {
  createNotificationWatcher,
  NotificationWatcher,
  chooseBackend,
  parseDbusMonitor,
  parseBusctlJson,
  notifyArgsToNotification,
  normalizeToasts,
  toastToNotification,
  splitOrigin,
  stripMarkup,
  NOTIFY_MATCH,
};
