'use strict';

/**
 * macOS desktop driver (docs/ARCHITECTURE.md §4), macOS 11+.
 *
 * Input, windows, displays and permission checks go through darwin-helper.js,
 * a JXA script kept running as `osascript -l JavaScript darwin-helper.js serve`
 * (JSON lines over stdio). If the persistent helper cannot start it falls back
 * to one `osascript` process per request. Screenshots use `screencapture`, the
 * clipboard uses pbcopy/pbpaste.
 *
 * Coordinates are logical points in CGEvent space: the origin is the top-left
 * corner of the primary display and y grows downwards.
 *
 * macOS grants Accessibility and Screen Recording to the app that launched the
 * process (Terminal, iTerm, VS Code, Electron...), never to node or osascript,
 * so permission errors name that app and link the right Settings pane.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { StringDecoder } = require('string_decoder');
const proc = require('../shared/proc');
const { createLogger } = require('../shared/log');
const { sleep, truncate } = require('../shared/util');

const log = createLogger('os-darwin');

const HELPER_PATH = path.join(__dirname, 'darwin-helper.js');
const REQUEST_TIMEOUT_MS = 10000;
const START_TIMEOUT_MS = 8000;
const ONESHOT_STARTUP_MS = 5000;
const MAX_REQUESTS_PER_HELPER = 2000;
const MAX_SERVE_FAILURES = 3;
const CRASH_WINDOW_MS = 60000;
const CAPTURE_TIMEOUT_MS = 15000;
const CLIPBOARD_TIMEOUT_MS = 5000;
const PERM_TTL_MS = 60000;
const FRESH_PERM_RECHECK_MS = 3000;
const DISPLAY_CACHE_MS = 1500;
const TYPE_CHUNK = 50;
// Typing time budgets per paste and once per request, above the helper's PASTE_SETTLE (0.4 s)
// and PASTE_RESTORE (1 s) in darwin-helper.js.
const PASTE_STEP_BUDGET_MS = 800;
const PASTE_RESTORE_BUDGET_MS = 1500;
const KEY_RETURN = 36;
const KEY_TAB = 48;
const MAX_NOTCHES = 200;
const MIN_WINDOW_SIZE = 2;
/** First Automation check: the consent prompt blocks the helper until the user answers it. */
const AUTOMATION_TIMEOUT_MS = 120000;
/** Later checks while an earlier prompt may still be unanswered. */
const AUTOMATION_RECHECK_TIMEOUT_MS = 5000;
/** After an unanswered prompt, paste without asking again for this long. */
const AUTOMATION_PENDING_MS = 30000;
/** Re-check a refused or unreadable Automation answer after this long. */
const AUTOMATION_RETRY_MS = 5 * 60000;
const INPUT_SOURCE_TTL_MS = 3000;
/** After a window title lookup through System Events stalled, list windows without it for this long. */
const AX_STALL_SKIP_MS = 30000;

/** Helper commands that are safe to re-run if the helper dies mid-request. */
const IDEMPOTENT = new Set(['ping', 'perms', 'displays', 'cursor', 'windows', 'active', 'clipGet', 'inputSource', 'automation', 'browserTab']);

/** Browsers whose AppleScript dictionary exposes the active tab (identifyBrowser ids -> helper kind). */
const SCRIPTABLE_BROWSERS = Object.freeze({
  chrome: 'chromium',
  brave: 'chromium',
  edge: 'chromium',
  chromium: 'chromium',
  vivaldi: 'chromium',
  opera: 'chromium',
  arc: 'chromium',
  safari: 'safari',
});
/** First AppleScript request to a browser: macOS may show the Automation consent prompt and wait for it. */
const BROWSER_CONSENT_TIMEOUT_MS = 60000;
const BROWSER_TAB_TIMEOUT_MS = 10000;

const SETTINGS_URLS = Object.freeze({
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
});

const MOD_FLAGS = { ctrl: 0x40000, alt: 0x80000, shift: 0x20000, meta: 0x100000 };
const MOD_KEYCODES = { ctrl: 0x3b, alt: 0x3a, shift: 0x38, meta: 0x37 };
const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'];
const MOD_ALIASES = {
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl', '⌃': 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt', '⌥': 'alt',
  shift: 'shift', '⇧': 'shift',
  meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta', windows: 'meta', os: 'meta', '⌘': 'meta',
  primary: 'meta', mod: 'meta', cmdorctrl: 'meta', commandorcontrol: 'meta',
};
const BUTTON_ALIASES = { left: 'left', right: 'right', middle: 'middle', center: 'middle', wheel: 'middle' };

/** Owners of layer-0 windows that are system chrome, not user windows. */
const SYSTEM_OWNERS = new Set(['Window Server', 'Dock', 'WindowManager', 'Control Center', 'Notification Center', 'SystemUIServer']);

/** Bundle id → the name System Settings shows for that app. */
const BUNDLE_APPS = {
  'com.apple.Terminal': 'Terminal',
  'com.googlecode.iterm2': 'iTerm',
  'com.microsoft.VSCode': 'Visual Studio Code',
  'com.microsoft.VSCodeInsiders': 'Visual Studio Code - Insiders',
  'com.vscodium': 'VSCodium',
  'com.todesktop.230313mzl4w4u92': 'Cursor',
  'com.exafunction.windsurf': 'Windsurf',
  'dev.zed.Zed': 'Zed',
  'dev.warp.Warp-Stable': 'Warp',
  'com.github.wez.wezterm': 'WezTerm',
  'net.kovidgoyal.kitty': 'kitty',
  'com.mitchellh.ghostty': 'Ghostty',
  'org.alacritty': 'Alacritty',
  'io.alacritty': 'Alacritty',
  'co.zeit.hyper': 'Hyper',
  'org.tabby': 'Tabby',
  'com.github.Electron': 'Electron',
  // The launcher applet `anywhere install` compiled before it started daemons through Terminal.
  'com.apple.ScriptEditor.id.Claude-Anywhere': 'Claude Anywhere',
};
const TERM_PROGRAMS = {
  Apple_Terminal: 'Terminal',
  'iTerm.app': 'iTerm',
  vscode: 'Visual Studio Code',
  WarpTerminal: 'Warp',
  WezTerm: 'WezTerm',
  ghostty: 'Ghostty',
  Hyper: 'Hyper',
  Tabby: 'Tabby',
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function unsupportedError(message, hint) {
  const err = new Error(message);
  err.code = 'UNSUPPORTED';
  err.hint = hint || '';
  return err;
}

function invalidArg(message) {
  const err = new TypeError(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

function osascriptMissing() {
  return unsupportedError(
    'osascript was not found: the macOS desktop driver only runs on macOS',
    'The macOS driver needs macOS 11 or newer, where /usr/bin/osascript is built in. On other systems unset ANYWHERE_DRIVER.',
  );
}

/**
 * Actionable instructions for granting a macOS privacy permission.
 * @param {'accessibility'|'screenRecording'|'automation'} kind
 * @param {string|null} [app] the app that launched Claude Code, e.g. "iTerm"
 * @returns {string}
 */
function permissionHint(kind, app) {
  const who = app ? `"${app}"` : 'the app that launched Claude Code (Terminal, iTerm, VS Code, ...)';
  const restart = app ? `quit and reopen ${app}` : 'quit and reopen that app';
  const owner =
    'macOS grants this to the app that launched the process (Terminal, iTerm, VS Code or Electron), not to node or osascript.';
  if (kind === 'screenRecording') {
    return (
      `Grant Screen Recording to ${who}: System Settings → Privacy & Security → Screen Recording ` +
      `(named "Screen & System Audio Recording" on macOS 15 and later), turn it on, then ${restart}. ` +
      `Open the pane with: open "${SETTINGS_URLS.screenRecording}". ${owner}`
    );
  }
  if (kind === 'automation') {
    return (
      `Allow ${who} to control "System Events": System Settings → Privacy & Security → Automation → ` +
      `${app || 'your terminal app'} → turn on System Events. Open the pane with: open "${SETTINGS_URLS.automation}".`
    );
  }
  return (
    `Grant Accessibility to ${who}: System Settings → Privacy & Security → Accessibility, turn it on ` +
    `(use + to add it if it is missing), then ${restart}. Open the pane with: open "${SETTINGS_URLS.accessibility}". ${owner}`
  );
}

/**
 * How to let the app that launched Claude Code control a browser through AppleScript.
 * @param {string} browser e.g. "Brave Browser"
 * @param {string|null} [app] the host app, e.g. "iTerm"
 */
function browserAutomationHint(browser, app) {
  const who = app ? `"${app}"` : 'the app that launched Claude Code (Terminal, iTerm, VS Code, ...)';
  return (
    `Allow ${who} to control "${browser}": System Settings → Privacy & Security → Automation → ` +
    `${app || 'your terminal app'} → turn on ${browser}. Open the pane with: open "${SETTINGS_URLS.automation}". ` +
    'Until then the address is read with the keyboard, which briefly brings the browser to the front.'
  );
}

/**
 * Error with .code = 'PERMISSION'; hint and settingsUrl are added by the driver.
 * @param {'accessibility'|'screenRecording'|'automation'} kind
 * @param {string} [message]
 */
function permissionError(kind, message) {
  const label = { accessibility: 'Accessibility', screenRecording: 'Screen Recording', automation: 'Automation (System Events)' }[kind];
  const err = new Error(message || `macOS ${label} permission is not granted`);
  err.code = 'PERMISSION';
  err.permission = kind;
  err.settingsUrl = SETTINGS_URLS[kind] || SETTINGS_URLS.accessibility;
  return err;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** JSON with every non-ASCII UTF-16 unit escaped, so it survives any byte chunking. */
function asciiJson(value) {
  return JSON.stringify(value === undefined ? null : value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Parse one helper output line; null for stray non-JSON output. */
function parseLine(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('{')) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && typeof v.ok === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

/** The last response line in one-shot output (osascript may print other text). */
function lastResponse(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const msg = parseLine(lines[i]);
    if (msg) return msg;
  }
  return null;
}

/** Turn an error response into an Error carrying the helper's code. */
function responseError(msg, cmd) {
  const err = new Error(`${cmd}: ${msg.error || 'the macOS helper reported an error'}`);
  err.code = msg.code || 'HELPER_ERROR';
  if (msg.perm) err.permission = msg.perm;
  if (msg.errorNumber != null) err.errorNumber = msg.errorNumber;
  err.command = cmd;
  return err;
}

function unwrapResponse(msg, cmd) {
  if (msg.ok) return msg.result === undefined ? null : msg.result;
  throw responseError(msg, cmd);
}

function validRect(r) {
  return (
    Boolean(r) &&
    typeof r === 'object' &&
    [r.x, r.y, r.width, r.height].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    r.width > 0 &&
    r.height > 0
  );
}

function clean(n) {
  return n === 0 ? 0 : n; // no -0
}

/**
 * Convert the helper's "displays" payload into driver displays (top-left
 * origin, points). NSScreen frames have a bottom-left origin on the primary
 * display: y = primaryHeight - (frame.y + frame.height). CGDisplayBounds, when
 * present, is already in the right space and wins.
 * @param {{screens:Array<{id:number,frame:object,cg?:object,scale:number,name?:string}>}} payload
 */
function parseDisplays(payload) {
  const screens = payload && Array.isArray(payload.screens) ? payload.screens : [];
  if (!screens.length) return [];
  const primary = screens[0] || {};
  const primaryH = primary.frame && Number.isFinite(primary.frame.height) ? primary.frame.height : 0;
  const out = [];
  screens.forEach((s, i) => {
    if (!s) return;
    let rect = null;
    if (validRect(s.cg)) {
      rect = { x: s.cg.x, y: s.cg.y, width: s.cg.width, height: s.cg.height };
    } else if (validRect(s.frame)) {
      const f = s.frame;
      rect = { x: f.x, y: primaryH - (f.y + f.height), width: f.width, height: f.height };
    }
    if (!rect) return;
    const id = Number(s.id);
    out.push({
      index: out.length,
      id: s.id != null && Number.isFinite(id) ? id : i + 1,
      x: clean(rect.x),
      y: clean(rect.y),
      width: rect.width,
      height: rect.height,
      scale: Number(s.scale) > 0 ? Number(s.scale) : 1,
      primary: i === 0,
      name: typeof s.name === 'string' ? s.name : '',
    });
  });
  return out;
}

/**
 * Convert the helper's "windows" payload (CGWindowList, front to back) into
 * driver windows. Keeps visible layer-0 windows; focused = the frontmost app's
 * frontmost window. Minimized windows are not on screen, so never listed.
 */
function parseWindows(payload) {
  const raw = payload && Array.isArray(payload.windows) ? payload.windows : [];
  const frontPid = payload && payload.frontPid != null && Number.isFinite(Number(payload.frontPid)) ? Number(payload.frontPid) : null;
  const out = [];
  let focusedTaken = false;
  for (const w of raw) {
    if (!w || Number(w.layer) !== 0) continue;
    if (w.alpha != null && !(Number(w.alpha) > 0)) continue;
    const width = Number(w.width);
    const height = Number(w.height);
    if (!(width >= MIN_WINDOW_SIZE && height >= MIN_WINDOW_SIZE)) continue;
    const pid = Number(w.pid);
    const number = Number(w.number);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(number)) continue;
    const app = typeof w.owner === 'string' ? w.owner : '';
    if (SYSTEM_OWNERS.has(app)) continue;
    const focused = !focusedTaken && frontPid !== null && pid === frontPid;
    if (focused) focusedTaken = true;
    out.push({
      id: `${pid}:${number}`,
      app,
      title: typeof w.title === 'string' ? w.title : '',
      pid,
      x: clean(Number(w.x) || 0),
      y: clean(Number(w.y) || 0),
      width,
      height,
      focused,
      minimized: false,
    });
  }
  return out;
}

/** Convert the helper's "active" payload into { id, app, title, pid, bundleId } | null. */
function parseActive(payload) {
  if (!payload || payload.pid == null || !Number.isInteger(Number(payload.pid))) return null;
  const pid = Number(payload.pid);
  const w = payload.window;
  const hasWindow = w && Number.isInteger(Number(w.number));
  return {
    id: hasWindow ? `${pid}:${Number(w.number)}` : String(pid),
    app: typeof payload.app === 'string' ? payload.app : '',
    title: hasWindow && typeof w.title === 'string' ? w.title : '',
    pid,
    bundleId: typeof payload.bundleId === 'string' ? payload.bundleId : '',
  };
}

/**
 * Window ids are "pid:windowNumber" (or just "pid" for an app).
 * @returns {{pid:number, number:number|null}|null}
 */
function parseWindowId(id) {
  if (id && typeof id === 'object') {
    const pid = Number(id.pid);
    const number = id.number != null ? Number(id.number) : null;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, number: Number.isInteger(number) ? number : null };
  }
  const m = /^\s*(\d+)(?::(\d+))?\s*$/.exec(String(id == null ? '' : id));
  if (!m) return null;
  const pid = Number(m[1]);
  if (!pid) return null;
  return { pid, number: m[2] != null ? Number(m[2]) : null };
}

/**
 * Split text into typing steps for the helper: printable ASCII runs are typed
 * with System Events keystroke (≤ 50 chars per step), \n and \t become Return
 * (36) and Tab (48) presses, and any run containing other characters is pasted.
 * Other control characters cannot be typed and are dropped. With pasteAll,
 * every run is pasted (keystroke follows the keyboard layout and input method,
 * which garbles ASCII on non-Latin layouts such as Russian or Greek and under
 * input methods such as Japanese or Korean; the helper detects those and
 * pastes such steps itself). On layouts with dead keys (U.S. International,
 * German, French...) the helper also pastes the keystroke steps that contain
 * a quote, backtick, caret or tilde, which a dead key would compose into the
 * next letter.
 * @param {string} text
 * @param {{chunk?:number, pasteAll?:boolean}} [opts]
 * @returns {Array<{kind:'keys'|'paste',text:string}|{kind:'key',keyCode:number}>}
 */
function planTyping(text, { chunk = TYPE_CHUNK, pasteAll = false } = {}) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const steps = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    if (!pasteAll && /^[\x20-\x7e]+$/.test(buf)) {
      for (let i = 0; i < buf.length; i += chunk) steps.push({ kind: 'keys', text: buf.slice(i, i + chunk) });
    } else {
      steps.push({ kind: 'paste', text: buf });
    }
    buf = '';
  };
  for (const ch of s) {
    if (ch === '\n') {
      flush();
      steps.push({ kind: 'key', keyCode: KEY_RETURN });
    } else if (ch === '\t') {
      flush();
      steps.push({ kind: 'key', keyCode: KEY_TAB });
    } else if (/^[\u0000-\u001f\u007f]$/.test(ch)) {
      continue;
    } else {
      buf += ch;
    }
  }
  flush();
  return steps;
}

/**
 * Time budget for a typing plan. A paste takes about half a second (the helper lets the
 * target app read the pasteboard before the next step) and the clipboard is restored 1 s
 * after the last one. The helper may paste keystroke steps itself (input methods, dead keys),
 * so those are budgeted as pastes at least.
 */
function typingTimeoutMs(steps) {
  let ms = REQUEST_TIMEOUT_MS;
  let text = false;
  for (const s of steps) {
    if (s.kind === 'keys') ms += Math.max(40 * s.text.length + 100, PASTE_STEP_BUDGET_MS);
    else if (s.kind === 'paste') ms += PASTE_STEP_BUDGET_MS;
    else ms += 60;
    if (s.kind === 'keys' || s.kind === 'paste') text = true;
  }
  if (text) ms += PASTE_RESTORE_BUDGET_MS;
  return Math.min(ms, 10 * 60 * 1000);
}

/**
 * CGEventFlags and modifier key codes for click modifiers.
 * @param {string[]|string} modifiers e.g. ['cmd','shift'] or 'ctrl+alt'
 * @returns {{flags:number, keyCodes:number[], names:string[]}}
 */
function macModifiers(modifiers) {
  const list = modifiers == null || modifiers === '' ? [] : Array.isArray(modifiers) ? modifiers : String(modifiers).split(/[+,\s]+/);
  const set = new Set();
  for (const m of list) {
    if (m == null || m === '') continue;
    const key = MOD_ALIASES[String(m).trim().toLowerCase()];
    if (!key) throw invalidArg(`Unknown modifier "${m}" (use ctrl, alt/option, shift or cmd/meta)`);
    set.add(key);
  }
  const names = MOD_ORDER.filter((m) => set.has(m));
  return {
    flags: names.reduce((f, m) => f | MOD_FLAGS[m], 0),
    keyCodes: names.map((m) => MOD_KEYCODES[m]),
    names,
  };
}

function normButton(button) {
  const b = BUTTON_ALIASES[String(button == null ? 'left' : button).toLowerCase()];
  if (!b) throw invalidArg(`Unknown mouse button "${button}" (use left, right or middle)`);
  return b;
}

function finite(v, name) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) throw invalidArg(`${name} must be a finite number (got ${v})`);
  return n;
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (v == null || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk, or null if it is not a PNG. */
function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function firstLine(s) {
  return (
    String(s || '')
      .trim()
      .split('\n')[0] || ''
  );
}

function tempPngPath(dir) {
  return path.join(dir || os.tmpdir(), `anywhere-shot-${process.pid}-${crypto.randomBytes(6).toString('hex')}.png`);
}

/** Environment that makes pbcopy/pbpaste use UTF-8. */
function utf8Env(env) {
  return { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' };
}

/**
 * Name of the nearest .app ancestor in `ps -axo pid=,ppid=,comm=` output.
 * For nested bundles (VS Code's "Code Helper.app") the outermost app wins.
 * @param {string} psText
 * @param {number} startPid
 * @returns {string|null}
 */
function appFromProcessTree(psText, startPid) {
  const table = new Map();
  for (const line of String(psText || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
  }
  const seen = new Set();
  let pid = Number(startPid);
  while (pid > 1 && table.has(pid) && !seen.has(pid)) {
    seen.add(pid);
    const { ppid, comm } = table.get(pid);
    const m = /([^/]+)\.app\//.exec(comm);
    if (m) return m[1];
    pid = ppid;
  }
  return null;
}

/**
 * Best guess at the app macOS holds responsible for this process (the one that
 * needs Accessibility / Screen Recording). Never throws.
 * @param {{env?:object, run?:Function, pid?:number}} [opts]
 * @returns {Promise<string|null>}
 */
async function detectHostApp({ env = process.env, run = proc.run, pid = process.pid } = {}) {
  try {
    const r = await run('ps', ['-axo', 'pid=,ppid=,comm='], { timeoutMs: 2500, env });
    if (r && !r.error && !r.timedOut && r.code === 0) {
      const name = appFromProcessTree(r.stdout, pid);
      if (name) return name;
    }
  } catch {
    /* fall through to environment hints */
  }
  const bundle = env.__CFBundleIdentifier;
  if (bundle && BUNDLE_APPS[bundle]) return BUNDLE_APPS[bundle];
  if (env.TERM_PROGRAM && TERM_PROGRAMS[env.TERM_PROGRAM]) return TERM_PROGRAMS[env.TERM_PROGRAM];
  if (/kitty/.test(env.TERM || '')) return 'kitty';
  return bundle || null;
}

function spawnFailure(err) {
  if (err && err.code === 'ENOENT') return osascriptMissing();
  const e = new Error(`could not start osascript: ${err && err.message}`);
  e.code = 'HELPER_START_FAILED';
  return e;
}

// ---------------------------------------------------------------------------
// Transport: persistent JXA helper with one-shot fallback
// ---------------------------------------------------------------------------

/**
 * Talks to darwin-helper.js. Requests are serialized (input events must stay
 * ordered, and each timeout then covers only its own work). A crashed or stuck
 * helper is replaced on the next request; after repeated start failures every
 * request runs as a one-shot `osascript` process instead.
 */
class HelperTransport {
  /**
   * @param {{helperPath?:string, osascript?:string, spawn?:Function, run?:Function, env?:object,
   *   timeoutMs?:number, startTimeoutMs?:number, maxRequests?:number, maxServeFailures?:number, oneShotOnly?:boolean}} [opts]
   */
  constructor(opts = {}) {
    this.helperPath = opts.helperPath || HELPER_PATH;
    this.osascript = opts.osascript || 'osascript';
    this._spawn = opts.spawn || childProcess.spawn;
    this._run = opts.run || proc.run;
    this._env = opts.env || process.env;
    this.timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
    this.startTimeoutMs = opts.startTimeoutMs || START_TIMEOUT_MS;
    this.maxRequests = opts.maxRequests || MAX_REQUESTS_PER_HELPER;
    this.maxServeFailures = opts.maxServeFailures != null ? opts.maxServeFailures : MAX_SERVE_FAILURES;
    this._serveDisabled = Boolean(opts.oneShotOnly);
    this._serveFailures = 0;
    this._crashes = [];
    this._child = null;
    this._starting = null;
    this._nextId = 1;
    this._served = 0;
    this._queue = Promise.resolve();
    this._stderrTail = '';
  }

  /** 'serve' while the persistent helper is in use, 'oneshot' after falling back. */
  get mode() {
    return this._serveDisabled ? 'oneshot' : 'serve';
  }

  /** PID of the running persistent helper, if any. */
  get pid() {
    return this._child && this._child.proc ? this._child.proc.pid : null;
  }

  /**
   * Run one helper command.
   * @param {string} cmd
   * @param {object} [args]
   * @param {{timeoutMs?:number, oneShot?:boolean}} [opts] oneShot forces a fresh osascript process
   * @returns {Promise<any>} the command's result
   */
  request(cmd, args = {}, opts = {}) {
    const go = () => this._dispatch(cmd, args, opts);
    const p = this._queue.then(go, go);
    this._queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  async _dispatch(cmd, args, { timeoutMs = this.timeoutMs, oneShot = false } = {}) {
    if (oneShot || this._serveDisabled) return this._oneShot(cmd, args, timeoutMs);
    let state;
    try {
      state = await this._ensureServe();
    } catch (err) {
      if (err.code === 'UNSUPPORTED') throw err;
      this._noteServeFailure(err);
      return this._oneShot(cmd, args, timeoutMs);
    }
    try {
      return await this._serveRequest(state, cmd, args, timeoutMs);
    } catch (err) {
      if (err.code === 'HELPER_EXITED' && IDEMPOTENT.has(cmd)) {
        log.warn(`the macOS helper exited during "${cmd}"; retrying with a one-shot osascript`);
        return this._oneShot(cmd, args, timeoutMs);
      }
      throw err;
    }
  }

  _noteServeFailure(err) {
    this._serveFailures++;
    log.warn(`the persistent macOS helper failed to start (${err.message}); using one-shot osascript calls`);
    if (this._serveFailures >= this.maxServeFailures && !this._serveDisabled) {
      this._serveDisabled = true;
      log.warn(`giving up on the persistent macOS helper after ${this._serveFailures} failures`);
    }
  }

  _ensureServe() {
    if (this._child && this._child.ready && !this._child.exited) return Promise.resolve(this._child);
    if (!this._starting) {
      this._starting = this._startServe().finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  _startServe() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn(this.osascript, ['-l', 'JavaScript', this.helperPath, 'serve'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this._env,
          windowsHide: true,
        });
      } catch (err) {
        reject(spawnFailure(err));
        return;
      }
      const state = {
        proc: child,
        ready: false,
        exited: false,
        killed: false,
        buf: '',
        decoder: new StringDecoder('utf8'),
        pending: new Map(),
      };
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(state);
      };
      const timer = setTimeout(() => {
        this._kill(state, false);
        const err = new Error(`the macOS helper did not start within ${this.startTimeoutMs} ms`);
        err.code = 'TIMEOUT';
        settle(err);
      }, this.startTimeoutMs);
      child.on('error', (err) => {
        this._onExit(state, `error: ${err.message}`);
        settle(spawnFailure(err));
      });
      child.on('exit', (code, signal) => {
        this._onExit(state, code != null ? `exit code ${code}` : `signal ${signal}`);
        const tail = this._stderrTail.trim();
        const err = new Error(
          `the macOS helper exited during start-up (${code != null ? `code ${code}` : `signal ${signal}`})${tail ? `: ${truncate(tail, 300)}` : ''}`,
        );
        err.code = 'HELPER_START_FAILED';
        settle(err);
      });
      if (child.stdout) {
        child.stdout.on('data', (d) =>
          this._onData(state, d, () => {
            state.ready = true;
            this._child = state;
            this._served = 0;
            settle(null);
          }),
        );
      }
      if (child.stderr) child.stderr.on('data', (d) => this._onStderr(d));
      if (child.stdin) child.stdin.on('error', () => {});
      // Do not keep the Node process alive just for the helper; request timers do that.
      for (const h of [child, child.stdin, child.stdout, child.stderr]) {
        if (h && typeof h.unref === 'function') h.unref();
      }
    });
  }

  _onData(state, chunk, onReady) {
    state.buf += typeof chunk === 'string' ? chunk : state.decoder.write(chunk);
    let nl = state.buf.indexOf('\n');
    while (nl >= 0) {
      const line = state.buf.slice(0, nl).trim();
      state.buf = state.buf.slice(nl + 1);
      nl = state.buf.indexOf('\n');
      if (!line) continue;
      const msg = parseLine(line);
      if (!msg) {
        log.debug('ignoring non-JSON helper output:', truncate(line, 200));
        continue;
      }
      if (msg.id === 0 && msg.ok && msg.result && msg.result.ready) {
        if (!state.ready) onReady();
        continue;
      }
      const waiter = state.pending.get(msg.id);
      if (!waiter) {
        log.debug('ignoring unmatched helper response', msg.id);
        continue;
      }
      state.pending.delete(msg.id);
      waiter.resolve(msg);
    }
    if (state.buf.length > 32 * 1024 * 1024) state.buf = '';
  }

  _onStderr(d) {
    const s = String(d);
    this._stderrTail = (this._stderrTail + s).slice(-2048);
    for (const line of s.split('\n')) if (line.trim()) log.debug('helper stderr:', truncate(line.trim(), 300));
  }

  _onExit(state, why) {
    if (state.exited) return;
    state.exited = true;
    if (this._child === state) this._child = null;
    const tail = this._stderrTail.trim();
    for (const [, waiter] of state.pending) {
      const err = new Error(`the macOS helper exited (${why})${tail ? `: ${truncate(tail, 300)}` : ''}`);
      err.code = 'HELPER_EXITED';
      waiter.reject(err);
    }
    state.pending.clear();
    if (state.ready && !state.killed) {
      const now = Date.now();
      this._crashes = this._crashes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
      log.warn(`the macOS helper exited unexpectedly (${why}); it will restart on the next request`);
      if (this._crashes.length >= this.maxServeFailures && !this._serveDisabled) {
        this._serveDisabled = true;
        log.warn('the macOS helper keeps crashing; switching to one-shot osascript calls');
      }
    }
  }

  _kill(state, graceful) {
    if (!state || state.exited) return;
    state.killed = true;
    if (this._child === state) this._child = null;
    const p = state.proc;
    if (graceful) {
      try {
        if (p.stdin) p.stdin.end();
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => {
        if (!state.exited) {
          try {
            p.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      }, 1000);
      if (typeof t.unref === 'function') t.unref();
      return;
    }
    try {
      p.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  _serveRequest(state, cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        state.pending.delete(id);
        // The helper is stuck (e.g. a hung Apple event): replace it.
        this._kill(state, false);
        const err = new Error(`the macOS helper timed out after ${timeoutMs} ms running "${cmd}"`);
        err.code = 'TIMEOUT';
        reject(err);
      }, timeoutMs);
      state.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          this._served++;
          try {
            resolve(unwrapResponse(msg, cmd));
          } catch (err) {
            reject(err);
          }
          if (this._served >= this.maxRequests && this._child === state) this._kill(state, true);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        state.proc.stdin.write(`${asciiJson({ id, cmd, args: args || {} })}\n`);
      } catch (err) {
        state.pending.delete(id);
        clearTimeout(timer);
        const e = new Error(`could not write to the macOS helper: ${err.message}`);
        e.code = 'HELPER_EXITED';
        reject(e);
      }
    });
  }

  async _oneShot(cmd, args, timeoutMs) {
    const r = await this._run(this.osascript, ['-l', 'JavaScript', this.helperPath, cmd, asciiJson(args || {})], {
      timeoutMs: timeoutMs + ONESHOT_STARTUP_MS,
      env: this._env,
    });
    if (r.error && r.error.code === 'ENOENT') throw osascriptMissing();
    if (r.timedOut) {
      const err = new Error(`osascript timed out running "${cmd}"`);
      err.code = 'TIMEOUT';
      throw err;
    }
    const msg = lastResponse(r.stdout);
    if (!msg) {
      const detail = firstLine(r.stderr) || (r.error && r.error.message) || `exit code ${r.code}`;
      const err = new Error(`the macOS helper failed running "${cmd}": ${truncate(detail, 300)}`);
      err.code = 'HELPER_FAILED';
      throw err;
    }
    return unwrapResponse(msg, cmd);
  }

  /** Replace the persistent helper on the next request (e.g. after permissions changed). */
  async restart() {
    if (this._child) this._kill(this._child, true);
    this._child = null;
  }

  /** Stop the persistent helper. The transport can still be used afterwards. */
  async close() {
    const state = this._child;
    this._child = null;
    if (!state) return;
    for (const [, waiter] of state.pending) {
      const err = new Error('the macOS driver was closed');
      err.code = 'CLOSED';
      waiter.reject(err);
    }
    state.pending.clear();
    this._kill(state, true);
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

class DarwinDriver {
  /**
   * @param {{transport?:object, run?:Function, which?:Function, spawn?:Function, env?:object, keys?:object,
   *   tmpdir?:string, checkPermissions?:boolean, scrollLinesPerNotch?:number, typing?:'auto'|'paste'|'keystroke', exists?:Function,
   *   pid?:number}} [opts]
   *   typing 'paste' (or env ANYWHERE_DARWIN_TYPING=paste) pastes all text instead of System Events keystrokes;
   *   'keystroke' uses keystrokes even when the active input source would garble them (no input source check);
   *   env ANYWHERE_DARWIN_SKIP_PERMCHECK=1 disables the permission pre-checks.
   *   transport/run/which/spawn/env/keys/exists are injection points for tests.
   */
  constructor(opts = {}) {
    this.name = 'darwin';
    this._opts = opts;
    this._env = opts.env || process.env;
    this._runImpl = opts.run || proc.run;
    this._whichImpl = opts.which || proc.which;
    this._existsImpl = opts.exists || ((p) => fs.existsSync(p));
    this._tmpdir = opts.tmpdir || os.tmpdir();
    this._transport =
      opts.transport ||
      new HelperTransport({
        osascript: this._tool('osascript', '/usr/bin/osascript') || 'osascript',
        spawn: opts.spawn,
        run: this._runImpl,
        env: this._env,
      });
    this._checkPerms =
      opts.checkPermissions !== undefined ? Boolean(opts.checkPermissions) : this._env.ANYWHERE_DARWIN_SKIP_PERMCHECK !== '1';
    this._linesPerNotch = clampInt(opts.scrollLinesPerNotch, 1, 20, 3);
    const typing = String(opts.typing || this._env.ANYWHERE_DARWIN_TYPING || 'auto').toLowerCase();
    this._typing = typing === 'paste' ? 'paste' : typing === 'keystroke' || typing === 'keys' ? 'keystroke' : 'auto';
    /** macOS has no public API to keep another app's window on top (see setTopmost). */
    this.supportsTopmost = false;
    /** Automation (System Events) consent: null (not asked yet), granted, denied, pending (prompt unanswered) or unknown. */
    this._automation = { state: null, at: 0 };
    this._automationCheck = null;
    this._inputSourceCache = null;
    this._axSkipUntil = 0;
    this._permCache = null;
    this._lastFreshPermCheck = 0;
    this._displayCache = null;
    this._held = new Set();
    this._hostAppPromise = null;
    this._warned = new Set();
    /** Browsers (lowercase app names) that already answered an AppleScript request: no consent prompt pending. */
    this._browserConsent = new Set();
  }

  // ----- plumbing -----

  _tool(name, absolute) {
    const found = this._whichImpl(name);
    if (found) return found;
    try {
      return absolute && this._existsImpl(absolute) ? absolute : null;
    } catch {
      return null;
    }
  }

  _hostAppName() {
    if (!this._hostAppPromise) {
      this._hostAppPromise = detectHostApp({ env: this._env, run: this._runImpl, pid: this._opts.pid || process.pid }).catch(() => null);
    }
    return this._hostAppPromise;
  }

  /** Add the hint and settings link to permission errors. */
  async _decorate(err) {
    if (err && err.code === 'PERMISSION') {
      const kind = err.permission || 'accessibility';
      err.permission = kind;
      err.settingsUrl = SETTINGS_URLS[kind] || SETTINGS_URLS.accessibility;
      if (!err.hint) err.hint = permissionHint(kind, await this._hostAppName());
      this._permCache = null;
    }
    return err;
  }

  async _call(cmd, args = {}, opts = {}) {
    try {
      return await this._transport.request(cmd, args, opts);
    } catch (err) {
      throw await this._decorate(err);
    }
  }

  async _permissions() {
    const value = await this._call('perms');
    this._permCache = { value: value || {}, at: Date.now() };
    return this._permCache.value;
  }

  /**
   * Throw PERMISSION if macOS says the permission is missing. CGEventPost drops
   * events silently without Accessibility, and screencapture returns only the
   * wallpaper without Screen Recording, so we must ask first.
   * @param {'accessibility'|'screenRecording'} kind
   */
  async _ensurePermission(kind) {
    if (!this._checkPerms) return;
    const c = this._permCache;
    if (c && c.value[kind] === true && Date.now() - c.at < PERM_TTL_MS) return;
    let perms;
    try {
      perms = await this._permissions();
    } catch (err) {
      if (err.code === 'UNSUPPORTED') throw err;
      log.debug(`permission check failed (${err.message}); trying the action anyway`);
      return;
    }
    if (perms[kind] !== false) return;
    // A long-lived helper can keep a stale "no" after the user grants access: ask a fresh process.
    if (Date.now() - this._lastFreshPermCheck > FRESH_PERM_RECHECK_MS) {
      this._lastFreshPermCheck = Date.now();
      try {
        const fresh = await this._transport.request('perms', {}, { oneShot: true });
        if (fresh && fresh[kind] !== false) {
          this._permCache = { value: fresh, at: Date.now() };
          await this._transport.restart();
          return;
        }
      } catch (err) {
        log.debug('fresh permission check failed:', err.message);
      }
    }
    throw await this._decorate(permissionError(kind));
  }

  _noteAutomation(state) {
    this._automation = { state, at: Date.now() };
  }

  /**
   * Make sure macOS has answered the Automation (System Events) consent prompt
   * before keystrokes depend on it. The first Apple event to System Events
   * shows that prompt and blocks the helper until the user answers, so this
   * asks with a harmless event and a long timeout instead of letting a typing
   * request time out (which kills the helper and types nothing).
   * @param {{force?:boolean, timeoutMs?:number}} [opts]
   * @returns {Promise<'granted'|'denied'|'pending'|'unknown'>}
   */
  _ensureAutomation({ force = false, timeoutMs } = {}) {
    const a = this._automation;
    const age = Date.now() - a.at;
    if (!force && !this._automationCheck) {
      if (a.state === 'granted') return Promise.resolve('granted');
      if (a.state === 'pending' && age < AUTOMATION_PENDING_MS) return Promise.resolve('pending');
      if ((a.state === 'denied' || a.state === 'unknown') && age < AUTOMATION_RETRY_MS) return Promise.resolve(a.state);
    }
    if (!this._automationCheck) {
      // While an earlier prompt may still be open, do not hold the helper for long again.
      const wait = timeoutMs || (a.state === 'pending' ? AUTOMATION_RECHECK_TIMEOUT_MS : AUTOMATION_TIMEOUT_MS);
      this._automationCheck = this._checkAutomation(wait).finally(() => {
        this._automationCheck = null;
      });
    }
    return this._automationCheck;
  }

  async _checkAutomation(timeoutMs) {
    let state = 'unknown';
    try {
      const r = await this._call('automation', {}, { timeoutMs });
      if (r && r.granted === true) state = 'granted';
      else if (r && r.granted === false) state = 'denied';
      else log.debug(`could not check the Automation permission: ${(r && r.error) || 'no answer'}`);
    } catch (err) {
      if (err.code === 'TIMEOUT') state = 'pending';
      else if (err.code === 'PERMISSION' && err.permission === 'automation') state = 'denied';
      else log.debug(`could not check the Automation permission: ${err.message}`);
    }
    this._noteAutomation(state);
    return state;
  }

  /** The active input source as the helper describes it ({id, kind, ascii, safe}), or null. Cached briefly. */
  async _inputSource() {
    const c = this._inputSourceCache;
    if (c && Date.now() - c.at < INPUT_SOURCE_TTL_MS) return c.value;
    let value = null;
    try {
      value = await this._call('inputSource');
    } catch (err) {
      log.debug(`could not read the input source: ${err.message}`);
    }
    this._inputSourceCache = { value: value || null, at: Date.now() };
    return this._inputSourceCache.value;
  }

  /**
   * Why keystrokes must not be used for this typing request ('automation'), or
   * null. Asks for Automation consent unless it is already known, but not when
   * the input source means the helper will paste anyway: no prompt for a
   * permission this request does not use.
   */
  async _keystrokeBlocker() {
    const known = this._automation.state;
    if (known === 'granted') return null;
    if (this._typing !== 'keystroke' && known !== 'denied' && known !== 'pending') {
      const src = await this._inputSource();
      if (src && src.safe === false) return null;
    }
    const consent = await this._ensureAutomation();
    return consent === 'denied' || consent === 'pending' ? 'automation' : null;
  }

  /** Automation was refused recently enough that System Events need not be tried again yet. */
  _automationDenied() {
    return this._automation.state === 'denied' && Date.now() - this._automation.at < AUTOMATION_RETRY_MS;
  }

  _logOnce(key, level, ...msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    log[level](...msg);
  }

  /** Remember what window title lookups through System Events revealed about Automation consent. */
  _noteAx(ax) {
    if (!ax || typeof ax !== 'object') return;
    if (ax.perm === 'automation') this._noteAutomation('denied');
    else if (Number(ax.filled) > 0 && this._automation.state !== 'granted') this._noteAutomation('granted');
  }

  /**
   * Run a window query, with titles from System Events unless that is known to
   * fail or recently stalled. A title lookup can block on the Automation
   * consent prompt until the helper is killed; the query is then repeated
   * without it, so callers still get the window list.
   */
  async _windowQuery(cmd, opts, timeoutMs) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const ax = o.axTitles !== false && !this._automationDenied() && Date.now() >= this._axSkipUntil;
    let payload;
    try {
      payload = await this._call(cmd, { axTitles: ax }, timeoutMs ? { timeoutMs } : {});
    } catch (err) {
      if (err.code !== 'TIMEOUT' || !ax) throw err;
      this._axSkipUntil = Date.now() + AX_STALL_SKIP_MS;
      log.warn(
        `reading windows ("${cmd}") timed out while reading titles through System Events (is the Automation prompt ` +
          'waiting for an answer?); reading them without those titles for now',
      );
      payload = await this._call(cmd, { axTitles: false });
    }
    if (payload && ax) this._noteAx(payload.ax);
    return payload;
  }

  _keysModule() {
    if (this._opts.keys) return this._opts.keys;
    try {
      return require('./keys');
    } catch (err) {
      throw unsupportedError(`the key table (src/os/keys.js) failed to load: ${err.message}`, 'Reinstall Claude Anywhere.');
    }
  }

  // ----- capabilities -----

  async capabilities() {
    const none = { screenshot: false, mouse: false, keyboard: false, windows: false, clipboard: false, notify: false, speak: false };
    try {
      const notes = [];
      const osascript = Boolean(this._opts.transport) || Boolean(this._tool('osascript', '/usr/bin/osascript'));
      if (!osascript) {
        return { ...none, notes: ['osascript was not found: the macOS driver only works on macOS 11 or newer.'] };
      }
      let perms = null;
      try {
        perms = await this._permissions();
      } catch (err) {
        notes.push(`The macOS helper (osascript -l JavaScript) failed: ${err.message}`);
        if (err.hint) notes.push(err.hint);
      }
      const helperOk = perms !== null;
      const host = await this._hostAppName();
      const ax = perms ? perms.accessibility : null;
      const sr = perms ? perms.screenRecording : null;
      if (ax === false) {
        notes.push(`Accessibility is not granted, so mouse and keyboard control will not work. ${permissionHint('accessibility', host)}`);
      } else if (ax == null && helperOk) {
        notes.push('Could not read the Accessibility permission state; input may be ignored until it is granted.');
      }
      if (sr === false) {
        notes.push(
          `Screen Recording is not granted, so screenshots and window titles are unavailable. ${permissionHint('screenRecording', host)}`,
        );
      }
      notes.push(
        `macOS privacy permissions belong to ${host ? `"${host}"` : 'the app that launched Claude Code'} (the app that started this process), ` +
          'not to node or osascript; restart that app after granting them.',
      );
      const automation = this._automation.state;
      if (automation === 'denied') {
        notes.push(`Automation (System Events) is refused, so typed text is pasted instead. ${permissionHint('automation', host)}`);
      } else {
        notes.push(
          'Typing uses System Events keystrokes: macOS asks once to let that app control "System Events" (Automation) and ' +
            'typing waits for that answer. Text is pasted instead while it is refused or unanswered, and when the active input ' +
            'source is an input method (Japanese, Chinese, Korean...) or a non-Latin layout (Russian, Greek...).',
        );
      }
      const shot = Boolean(this._tool('screencapture', '/usr/sbin/screencapture'));
      if (!shot) notes.push('screencapture was not found (it ships with macOS in /usr/sbin).');
      const clip = (Boolean(this._tool('pbcopy', '/usr/bin/pbcopy')) && Boolean(this._tool('pbpaste', '/usr/bin/pbpaste'))) || helperOk;
      notes.push('Keeping a window always on top is not supported on macOS.');
      return {
        screenshot: shot && sr !== false,
        mouse: helperOk && ax !== false,
        keyboard: helperOk && ax !== false,
        windows: helperOk,
        clipboard: clip,
        notify: true,
        speak: Boolean(this._tool('say', '/usr/bin/say')),
        topmost: false,
        notes,
        permissions: {
          accessibility: ax,
          screenRecording: sr,
          // Only what is already known: reading it could show the consent prompt.
          automation: automation === 'granted' ? true : automation === 'denied' ? false : null,
          hostApp: host || null,
          settings: { ...SETTINGS_URLS },
        },
        helper: this._transport.mode || 'serve',
      };
    } catch (err) {
      return { ...none, notes: [`macOS capability check failed: ${err.message}`] };
    }
  }

  /**
   * Show the macOS permission prompts (Accessibility, Screen Recording and
   * Automation for System Events) for the app that launched this process, so
   * they are answered up front instead of during the first action. The
   * Automation prompt is modal: this waits up to two minutes for the answer.
   * Not part of the Driver contract; used by `anywhere doctor` / install.
   * @returns {Promise<{accessibility:boolean|null, screenRecording:boolean|null, automation?:boolean|null}>}
   */
  async requestPermissions({ accessibility = true, screenRecording = true, automation = true } = {}) {
    const res = (await this._call('requestPerms', { accessibility, screenRecording }, { oneShot: true })) || {};
    this._permCache = null;
    if (automation) {
      const state = await this._ensureAutomation({ force: true, timeoutMs: AUTOMATION_TIMEOUT_MS });
      res.automation = state === 'granted' ? true : state === 'denied' ? false : null;
    }
    return res;
  }

  /**
   * Open the System Settings pane for a permission.
   * @param {'accessibility'|'screenRecording'|'automation'} kind
   * @returns {Promise<boolean>}
   */
  async openPermissionSettings(kind = 'accessibility') {
    const url = SETTINGS_URLS[kind] || SETTINGS_URLS.accessibility;
    const r = await this._runImpl(this._tool('open', '/usr/bin/open') || 'open', [url], { timeoutMs: 5000, env: this._env });
    return !r.error && !r.timedOut && r.code === 0;
  }

  // ----- displays & screenshots -----

  async displays() {
    const payload = await this._call('displays');
    const list = parseDisplays(payload);
    if (!list.length) {
      const err = new Error('macOS reported no displays');
      err.code = 'NO_DISPLAY';
      err.hint = 'Make sure a display is connected and the user session is unlocked (screen control does not work over plain SSH).';
      throw err;
    }
    this._displayCache = { list, at: Date.now() };
    return list.map((d) => ({ ...d }));
  }

  async _displaysCached() {
    const c = this._displayCache;
    if (c && Date.now() - c.at < DISPLAY_CACHE_MS) return c.list;
    await this.displays();
    return this._displayCache.list;
  }

  async _screencapture(flags) {
    const cmd = this._tool('screencapture', '/usr/sbin/screencapture');
    if (!cmd) throw unsupportedError('screencapture was not found', 'The macOS driver needs /usr/sbin/screencapture, which ships with macOS.');
    const file = tempPngPath(this._tmpdir);
    const r = await this._runImpl(cmd, [...flags, '-t', 'png', file], { timeoutMs: CAPTURE_TIMEOUT_MS, env: this._env });
    let buf = null;
    try {
      buf = await fs.promises.readFile(file);
    } catch {
      buf = null;
    } finally {
      await fs.promises.rm(file, { force: true }).catch(() => {});
    }
    if (r.error && r.error.code === 'ENOENT') {
      throw unsupportedError('screencapture was not found', 'The macOS driver needs /usr/sbin/screencapture, which ships with macOS.');
    }
    if (r.timedOut) {
      const err = new Error('screencapture timed out');
      err.code = 'TIMEOUT';
      throw err;
    }
    const size = buf && buf.length ? pngSize(buf) : null;
    if (r.code !== 0 || !size) {
      const detail = firstLine(r.stderr) || (r.code !== 0 ? `exit code ${r.code}` : 'it wrote no image');
      throw await this._decorate(
        permissionError(
          'screenRecording',
          `screencapture could not capture the screen (${truncate(detail, 200)}). This usually means Screen Recording ` +
            'permission is missing, or the session is locked or not a GUI login.',
        ),
      );
    }
    return { png: buf, width: size.width, height: size.height };
  }

  /**
   * Capture one display at native resolution.
   * @param {number} index 0 = primary
   * @returns {Promise<{png:Buffer,width:number,height:number}>}
   */
  async captureDisplay(index = 0) {
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0) throw invalidArg(`display index must be a non-negative integer (got ${index})`);
    const displays = await this._displaysCached();
    if (idx >= displays.length) {
      const err = new RangeError(`display ${idx} does not exist; ${displays.length} display(s) are connected (0-${displays.length - 1})`);
      err.code = 'INVALID_DISPLAY';
      throw err;
    }
    await this._ensurePermission('screenRecording');
    const d = displays[idx];
    let shot = await this._screencapture(['-x', '-C', '-D', String(idx + 1)]);
    // screencapture numbers displays like CGGetActiveDisplayList, which normally matches NSScreen order.
    // If the image is not the size of this display, capture its rectangle instead.
    const want = { width: Math.round(d.width * d.scale), height: Math.round(d.height * d.scale) };
    const matches = (s) => Math.abs(s.width - want.width) <= 2 && Math.abs(s.height - want.height) <= 2;
    if (displays.length > 1 && !matches(shot)) {
      log.warn(`screencapture -D ${idx + 1} returned ${shot.width}x${shot.height}, expected ${want.width}x${want.height}; capturing the display rectangle`);
      try {
        const rect = [d.x, d.y, d.width, d.height].map((v) => Math.round(v)).join(',');
        const alt = await this._screencapture(['-x', '-C', `-R${rect}`]);
        if (matches(alt)) shot = alt;
      } catch (err) {
        log.debug('rectangle capture failed:', err.message);
      }
    }
    return shot;
  }

  // ----- mouse -----

  async cursorPosition() {
    const r = await this._call('cursor');
    return { x: finite(r && r.x, 'cursor x'), y: finite(r && r.y, 'cursor y') };
  }

  async moveMouse(x, y) {
    const args = { x: finite(x, 'x'), y: finite(y, 'y') };
    await this._ensurePermission('accessibility');
    const held = [...this._held][0];
    if (held) args.button = held;
    await this._call('move', args);
  }

  async click(x, y, { button = 'left', clicks = 1, modifiers = [] } = {}) {
    const args = { x: finite(x, 'x'), y: finite(y, 'y') };
    const b = normButton(button);
    const n = Number(clicks == null ? 1 : clicks);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw invalidArg(`clicks must be an integer from 1 to 10 (got ${clicks})`);
    const mods = macModifiers(modifiers);
    await this._ensurePermission('accessibility');
    await this._call('click', { ...args, button: b, clicks: n, flags: mods.flags, modifierKeyCodes: mods.keyCodes });
  }

  async mouseDown(button = 'left') {
    const b = normButton(button);
    await this._ensurePermission('accessibility');
    await this._call('down', { button: b });
    this._held.add(b);
  }

  async mouseUp(button = 'left') {
    const b = normButton(button);
    await this._ensurePermission('accessibility');
    try {
      await this._call('up', { button: b });
    } finally {
      this._held.delete(b);
    }
  }

  async drag(x1, y1, x2, y2, { button = 'left' } = {}) {
    const a = { x1: finite(x1, 'x1'), y1: finite(y1, 'y1'), x2: finite(x2, 'x2'), y2: finite(y2, 'y2') };
    const b = normButton(button);
    const steps = clampInt(Math.hypot(a.x2 - a.x1, a.y2 - a.y1) / 25, 8, 60, 12);
    await this._ensurePermission('accessibility');
    await this._call('drag', { ...a, button: b, steps }, { timeoutMs: REQUEST_TIMEOUT_MS + steps * 30 });
  }

  /** dx/dy in wheel notches; dy > 0 scrolls down, dx > 0 scrolls right. */
  async scroll(x, y, dx = 0, dy = 0) {
    const args = {
      x: finite(x, 'x'),
      y: finite(y, 'y'),
      dx: clampInt(dx, -MAX_NOTCHES, MAX_NOTCHES, 0),
      dy: clampInt(dy, -MAX_NOTCHES, MAX_NOTCHES, 0),
      linesPerNotch: this._linesPerNotch,
    };
    await this._ensurePermission('accessibility');
    const notches = Math.max(Math.abs(args.dx), Math.abs(args.dy));
    await this._call('scroll', args, { timeoutMs: REQUEST_TIMEOUT_MS + notches * 40 });
  }

  // ----- keyboard -----

  /**
   * Type literal text (any unicode) into the focused window. Keystrokes need
   * Automation consent for System Events, which is settled first; text is
   * pasted while consent is refused or unanswered, and the helper pastes when
   * the active input source would garble keystrokes.
   */
  async typeText(text) {
    const s = typeof text === 'string' ? text : String(text == null ? '' : text);
    let steps = planTyping(s, { pasteAll: this._typing === 'paste' });
    if (!steps.length) return;
    await this._ensurePermission('accessibility');
    let reason = steps.some((st) => st.kind === 'keys') ? await this._keystrokeBlocker() : null;
    if (reason) steps = planTyping(s, { pasteAll: true });
    const args = { steps, fallbackPaste: true, checkInputSource: this._typing !== 'keystroke' };
    let res;
    try {
      res = await this._call('type', args, { timeoutMs: typingTimeoutMs(steps) });
    } catch (err) {
      // While consent could not be checked, a timeout most likely means the very first keystroke is
      // blocked on the consent prompt, before anything was typed, so the whole text can be pasted
      // instead. Never once consent is known: the text may then be half typed.
      if (err.code !== 'TIMEOUT' || this._automation.state !== 'unknown' || steps[0].kind !== 'keys') throw err;
      this._noteAutomation('pending');
      reason = 'automation';
      steps = planTyping(s, { pasteAll: true });
      res = await this._call('type', { ...args, steps }, { timeoutMs: typingTimeoutMs(steps) });
    }
    if (res && res.automationError) this._noteAutomation('denied');
    else if (res && Number(res.keystrokes) > 0) this._noteAutomation('granted');
    const why = (res && res.reason) || reason;
    if (why === 'automation') {
      const pending = this._automation.state === 'pending';
      this._logOnce(
        pending ? 'automation-pending' : 'automation',
        'warn',
        pending
          ? 'The Automation prompt (control "System Events") has not been answered, so text was pasted instead of typed.'
          : 'System Events refused keystrokes (Automation permission), so text was pasted instead.',
        permissionHint('automation', await this._hostAppName()),
      );
    } else if (why === 'input-source') {
      const src = (res && res.inputSource) || {};
      this._logOnce(
        `input-source:${src.id || ''}`,
        'info',
        `The active input source${src.id ? ` (${src.id})` : ''} would garble System Events keystrokes, so text was pasted instead.`,
      );
    } else if (why === 'dead-keys') {
      const src = (res && res.inputSource) || {};
      this._logOnce(
        `dead-keys:${src.id || ''}`,
        'info',
        `The keyboard layout${src.id ? ` (${src.id})` : ''} may have dead keys, so text with quotes, backticks, carets or tildes was pasted instead of typed.`,
      );
    }
  }

  /** Press a combo of normalized key names, e.g. ['meta','shift','t']. */
  async keyCombo(keys) {
    const k = this._keysModule().toMacKeyCodes(keys);
    const keyCodes = Array.isArray(k.keyCodes) && k.keyCodes.length ? k.keyCodes : [k.keyCode];
    await this._ensurePermission('accessibility');
    await this._call('key', {
      keyCode: k.keyCode,
      keyCodes,
      // Characters per key: the helper presses the key that types them on the active layout
      // (Cmd+Z on AZERTY is not the US-position Z key), looked up in the Command keymap for Cmd
      // chords, and may set Shift or Option for that key. null = position-independent key.
      chars: Array.isArray(k.chars) ? k.chars : [],
      flags: Number(k.flags) || 0,
      modifierKeyCodes: Array.isArray(k.modifierKeyCodes) ? k.modifierKeyCodes : [],
    });
  }

  // ----- windows -----

  /**
   * @param {{axTitles?:boolean}} [opts] axTitles false skips reading blank titles (no Screen Recording)
   *   through System Events, which can show the Automation consent prompt; use it for background polling.
   */
  async listWindows(opts) {
    return parseWindows(await this._windowQuery('windows', opts, 15000));
  }

  /** @param {{axTitles?:boolean}} [opts] see listWindows */
  async activeWindow(opts) {
    return parseActive(await this._windowQuery('active', opts));
  }

  async focusWindow(id) {
    return (await this._focus(id)).ok;
  }

  /**
   * Activate a window's app and raise the window itself.
   * @returns {Promise<{ok:boolean, raised:boolean}>} ok: the app is frontmost; raised: the
   *   window was found through accessibility and raised (otherwise another window of the app,
   *   or of another instance of it, may be in front)
   */
  async _focus(id) {
    const no = { ok: false, raised: false };
    const ref = parseWindowId(id);
    if (!ref) return no;
    let res = null;
    try {
      res = await this._call('focus', ref, { timeoutMs: 15000 });
    } catch (err) {
      if (err.code === 'PERMISSION' || err.code === 'UNSUPPORTED') throw err;
      log.warn(`focusing window ${id} failed: ${err.message}`);
    }
    if (res && res.ok) return { ok: true, raised: res.raised === true };
    if (!res || /not running|does not belong/.test(res.reason || '')) return no;
    // With several instances of the app running (the dialog's own browser next to the user's),
    // LaunchServices would activate whichever it picks, likely the wrong one.
    if (Number(res.instances) > 1) return no;
    // Activation can be refused (cooperative activation on macOS 14+): ask LaunchServices instead.
    const target = res.bundlePath ? ['-a', res.bundlePath] : res.bundleId ? ['-b', res.bundleId] : null;
    if (!target) return no;
    const r = await this._runImpl(this._tool('open', '/usr/bin/open') || 'open', target, { timeoutMs: 8000, env: this._env });
    if (r.error || r.timedOut || r.code !== 0) return no;
    await sleep(250);
    try {
      const again = await this._call('focus', ref, { timeoutMs: 15000 });
      return { ok: Boolean(again && again.ok), raised: Boolean(again && again.ok && again.raised === true) };
    } catch (err) {
      if (err.code === 'PERMISSION') throw err;
      return no;
    }
  }

  async minimizeWindow(id) {
    const ref = parseWindowId(id);
    if (!ref || ref.number == null) return false;
    try {
      const res = await this._call('minimize', ref);
      if (res && res.ok) return true;
      if (res && /not found|does not belong/.test(res.reason || '')) return false;
    } catch (err) {
      if (err.code === 'PERMISSION' || err.code === 'UNSUPPORTED') throw err;
      log.debug(`AXMinimized failed for ${id}: ${err.message}`);
    }
    // Fall back to the standard Minimize shortcut, but only once the window itself is raised:
    // Cmd+M acts on the front window of the app, which may be another window or instance.
    const focused = await this._focus(id);
    if (!focused.ok || !focused.raised) return false;
    await this.keyCombo(['meta', 'm']);
    return true;
  }

  /**
   * Close one window by pressing its accessibility close button (AXCloseButton), leaving the
   * app and its other windows running.
   * @param {string} id "pid:number"
   * @returns {Promise<boolean>} whether the button was pressed
   */
  async closeWindow(id) {
    const ref = parseWindowId(id);
    if (!ref || ref.number == null) return false;
    try {
      const res = await this._call('close', ref);
      return Boolean(res && res.ok);
    } catch (err) {
      if (err.code === 'PERMISSION' || err.code === 'UNSUPPORTED') throw err;
      log.debug(`closing window ${id} failed: ${err.message}`);
      return false;
    }
  }

  /** macOS has no public API to pin another app's window on top. */
  async setTopmost() {
    return false;
  }

  // ----- browser tabs -----

  /**
   * Read the active tab of a browser window (Driver.browserTab). Chromium browsers (Chrome, Brave,
   * Edge, Chromium, Vivaldi, Opera, Arc) and Safari answer through AppleScript, without keystrokes,
   * once the user allowed the Automation prompt for that browser; Firefox, a refused prompt and the
   * page text use the keyboard reader (src/os/linux.js), with Cmd as the primary modifier.
   * @param {{app?:string, windowId?:string, includeText?:boolean, maxChars?:number, keyboard?:boolean,
   *   beforeInput?:Function}} [opts]
   */
  async browserTab(opts = {}) {
    const tabs = require('./linux');
    return tabs.readBrowserTab(this, opts, {
      platform: 'darwin',
      native: (win, browser, want) => this._browserTabScript(win, browser, want),
    });
  }

  /** AppleScript half of browserTab: {url, title, tabTitle, text?, method:'applescript'} or null (not scriptable). */
  async _browserTabScript(win, browser, want = {}) {
    const kind = SCRIPTABLE_BROWSERS[browser.id];
    if (!kind) return null;
    const app = win.app || browser.name;
    const ref = parseWindowId(win.id);
    const args = { app: win.app || '', kind, title: win.title || '', wantText: Boolean(want.text) };
    if (ref) args.pid = ref.pid;
    const key = app.toLowerCase();
    const firstAsk = !this._browserConsent.has(key);
    let r;
    try {
      r = await this._call('browserTab', args, { timeoutMs: firstAsk ? BROWSER_CONSENT_TIMEOUT_MS : BROWSER_TAB_TIMEOUT_MS });
    } catch (err) {
      if (err.code === 'PERMISSION' || err.code === 'TIMEOUT') {
        this._browserConsent.delete(key);
        const host = await this._hostAppName();
        const e =
          err.code === 'TIMEOUT'
            ? new Error(`macOS is still asking whether ${host || 'your terminal app'} may control ${app} (the Automation prompt was not answered)`)
            : err;
        e.code = 'PERMISSION';
        e.permission = 'automation';
        e.settingsUrl = SETTINGS_URLS.automation;
        e.hint = browserAutomationHint(app, host);
        throw e;
      }
      throw err;
    }
    this._browserConsent.add(key);
    if (want.text && r && r.textError) log.debug(`${app} did not return the page text through AppleScript (${r.textError}); using the keyboard`);
    if (!r) return null;
    const title = typeof r.title === 'string' ? r.title : '';
    return {
      url: typeof r.url === 'string' && r.url ? r.url : null,
      title,
      tabTitle: title,
      text: typeof r.text === 'string' ? r.text : undefined,
      method: 'applescript',
    };
  }

  // ----- clipboard -----

  async clipboardGet() {
    const cmd = this._tool('pbpaste', '/usr/bin/pbpaste');
    if (cmd) {
      const r = await this._runImpl(cmd, ['-Prefer', 'txt'], { timeoutMs: CLIPBOARD_TIMEOUT_MS, env: utf8Env(this._env) });
      if (!r.error && !r.timedOut && r.code === 0) return typeof r.stdout === 'string' ? r.stdout : String(r.stdout || '');
      log.debug('pbpaste failed, reading the pasteboard through the helper:', firstLine(r.stderr) || r.code);
    }
    const res = await this._call('clipGet');
    return res && typeof res.text === 'string' ? res.text : '';
  }

  async clipboardSet(text) {
    const s = String(text == null ? '' : text);
    const cmd = this._tool('pbcopy', '/usr/bin/pbcopy');
    if (cmd) {
      const r = await this._runImpl(cmd, [], { input: Buffer.from(s, 'utf8'), timeoutMs: CLIPBOARD_TIMEOUT_MS, env: utf8Env(this._env) });
      if (!r.error && !r.timedOut && r.code === 0) return;
      log.debug('pbcopy failed, writing the pasteboard through the helper:', firstLine(r.stderr) || r.code);
    }
    await this._call('clipSet', { text: s });
  }

  // ----- lifecycle -----

  async close() {
    this._held.clear();
    await this._transport.close();
  }
}

/**
 * Create the macOS driver.
 * @param {object} [opts] see DarwinDriver
 * @returns {DarwinDriver}
 */
function createDriver(opts = {}) {
  return new DarwinDriver(opts || {});
}

module.exports = {
  createDriver,
  DarwinDriver,
  HelperTransport,
  HELPER_PATH,
  SETTINGS_URLS,
  // pure helpers (exported for tests and reuse)
  asciiJson,
  parseLine,
  lastResponse,
  parseDisplays,
  parseWindows,
  parseActive,
  parseWindowId,
  planTyping,
  typingTimeoutMs,
  macModifiers,
  pngSize,
  appFromProcessTree,
  detectHostApp,
  permissionHint,
  permissionError,
  browserAutomationHint,
  SCRIPTABLE_BROWSERS,
};
