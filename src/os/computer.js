'use strict';

/**
 * Computer: the model-facing layer over a Driver.
 *
 * Tools speak "screenshot space" (pixels of the most recent full-display
 * screenshot shown to the model); drivers speak logical global coordinates.
 * This class owns that mapping plus the safety rails around every input
 * action: input validation, the user's pause guard, the top-left failsafe,
 * serialization, and a short settle delay.
 */

const fs = require('fs');
const png = require('./png');
const keys = require('./keys');
const paths = require('../shared/paths');
const platform = require('../shared/platform');
const { sleep } = require('../shared/util');
const { createLogger } = require('../shared/log');

const log = createLogger('computer');

const DEFAULT_CONFIG = Object.freeze({
  maxWidth: 1366,
  maxHeight: 768,
  failsafe: true,
  actionDelayMs: 120,
  pasteThreshold: 200,
});
const EDGE_TOLERANCE = 2; // px of slack outside the shot that is clamped instead of rejected
const FAILSAFE_RADIUS = 3; // logical px around the primary display's top-left corner
const DISPLAY_TTL_MS = 2000;
const PASTE_SETTLE_MS = 40;
// Apps read the clipboard after the paste keystroke arrives, some of them well after it: restoring
// the old contents sooner can paste those instead (the macOS helper's own paste waits 1 s too).
const PASTE_RESTORE_MS = 1000;
const REPEAT_GAP_MS = 25;
const MAX_REPEAT = 100;
const MAX_SCROLL = 100;
// UI elements (accessibility): ids seen in uiFind/uiTree results, for uiClick's fallback click.
const UI_SEEN_TTL_MS = 30000;
const UI_SEEN_MAX = 3000;
const UI_FOCUS_SETTLE_MS = 80;
const UI_FRONT_SETTLE_MS = 150;
const UI_PICK_LIMIT = 20;
/** Roles that take a value, tried first by uiSetValue when no role is given. */
const UI_VALUE_ROLES = ['textbox', 'combobox', 'slider'];
/**
 * uiAction errors after which clicking the old position would be wrong: the element or window is
 * gone (STALE on Linux and the mock, STALE_ELEMENT on Windows, NOT_FOUND on macOS), the id is bad,
 * or the OS refuses input to that window (UIPI_BLOCKED: an elevated app on Windows).
 */
const UI_FATAL_CODES = new Set(['STALE', 'STALE_ELEMENT', 'NOT_FOUND', 'BAD_ARGS', 'INVALID_INPUT', 'PAUSED', 'FAILSAFE', 'PERMISSION', 'UIPI_BLOCKED', 'OWN_DIALOG']);
/** Errors meaning the element changed since it was found: a uiClick/uiSetValue by name looks it up once more. */
const UI_STALE_CODES = new Set(['STALE', 'STALE_ELEMENT']);
const BUTTONS = ['left', 'right', 'middle'];
const DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const TERMINAL_RE =
  /terminal|konsole|xterm|alacritty|kitty|wezterm|tilix|terminator|rxvt|\bfoot\b|guake|yakuake|termite|sakura|qterminal|ptyxis|blackbox|st-256color/i;

/**
 * Input methods may resolve to { warnings: string[] } when the OS may have dropped the input
 * silently (Windows UIPI: a window of another user account). Merged, without duplicates.
 * @returns {{warnings?:string[]}} spread into an action result
 */
function warningsOf(...results) {
  const out = [];
  for (const r of results) {
    if (!r || !Array.isArray(r.warnings)) continue;
    for (const w of r.warnings) if (typeof w === 'string' && w && !out.includes(w)) out.push(w);
  }
  return out.length ? { warnings: out } : {};
}

/**
 * Whether two clipboard texts are the same up to line endings: the OS may store text with its own
 * (Windows keeps CRLF, so the driver reads back "a\r\nb" after writing "a\nb").
 */
function sameClipText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');
}

function inputError(message, code = 'INVALID_INPUT', hint) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  return err;
}

function toNumber(v, name) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw inputError(`${name} must be a number (got ${v === undefined ? 'nothing' : JSON.stringify(v)})`);
  }
  return n;
}

function toInt(v, name, min, max) {
  const n = toNumber(v, name);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw inputError(`${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)})`);
  }
  return n;
}

function positiveOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function emptyStore() {
  return { version: 1, lastDisplay: null, pointer: null, displays: {} };
}

function validGeometry(g) {
  return Boolean(
    g &&
      g.display &&
      g.shot &&
      [g.display.x, g.display.y].every(Number.isFinite) &&
      [g.display.width, g.display.height, g.shot.width, g.shot.height].every((n) => Number.isFinite(n) && n > 0)
  );
}

function rectOf(d) {
  return { index: d.index, x: d.x, y: d.y, width: d.width, height: d.height, scale: d.scale };
}

function displayAt(displays, x, y) {
  return displays.findIndex((d) => x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height);
}

/** Copy a driver result array's non-index properties (window, truncated, notes...) onto `to`, non-enumerable. */
function copyMeta(from, to) {
  if (!from || typeof from !== 'object') return to;
  for (const k of Object.getOwnPropertyNames(from)) {
    if (k === 'length' || /^\d+$/.test(k)) continue;
    Object.defineProperty(to, k, { value: from[k], enumerable: false, configurable: true, writable: true });
  }
  return to;
}

/** Bounds with a positive size and finite numbers. */
/**
 * The window or process a UI element id names, by its format: Linux "lx:<window id | @pid.n>:...",
 * macOS "mac:<pid>:<window number>:...", Windows "<hwnd>.<path>~<tag>", the mock driver "mock:<window id>:...".
 * @returns {{windowId:string|null, pid:number|null}}
 */
function uiOwnerOfId(id) {
  const s = String(id == null ? '' : id).trim();
  let m = /^lx:([^:\s]+):/.exec(s);
  if (m) {
    const app = /^@(\d+)\./.exec(m[1]);
    return app ? { windowId: null, pid: Number(app[1]) } : { windowId: m[1], pid: null };
  }
  m = /^mock:([^:\s]+):/.exec(s);
  if (m) return { windowId: m[1], pid: null };
  m = /^mac:(\d+):([^:]*):/.exec(s);
  if (m) return { windowId: /^\d+$/.test(m[2]) ? `${m[1]}:${m[2]}` : null, pid: Number(m[1]) };
  m = /^(-?\d{1,20})(?:[.~]|$)/.exec(s);
  if (m) return { windowId: m[1], pid: null };
  return { windowId: null, pid: null };
}

function ownDialogUiError(target) {
  return inputError(
    `"${(target && (target.name || target.id)) || 'That element'}" is in the Claude Anywhere dialog, which Claude may not operate`,
    'OWN_DIALOG',
    'Only the user answers the dialog. Name the window of the app you mean (window: its title, app or id), or ask the user.',
  );
}

/** F3-SAFE-D1: pointer input where the dialog is on screen but this desktop cannot say where. */
function unplacedDialogError() {
  return inputError(
    'The Claude Anywhere dialog is on screen and this desktop cannot tell where, so Claude may not click, drag or scroll',
    'OWN_DIALOG',
    'Ask the user to minimize the Claude Anywhere dialog (or to use an X11 session), then try again.',
  );
}

/** The rectangles of a protected window: its client area and the window manager's frame around it, when known. */
function windowRects(w) {
  const rects = [];
  for (const r of [w, w && w.frame]) {
    if (!r || typeof r !== 'object') continue;
    const b = { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) };
    if (validRect(b)) rects.push(b);
  }
  return rects;
}

function inRect(p, b) {
  return p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
}

function validRect(b) {
  return Boolean(b) && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0;
}

function hasText(v) {
  return v != null && String(v).trim() !== '';
}

function uiNorm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** One line per candidate, for an ambiguous uiClick/uiSetValue query. */
function uiCandidateLines(list) {
  return list
    .slice(0, 8)
    .map((m) => {
      const at = m.shot ? ` at (${m.shot.cx}, ${m.shot.cy}) on display ${m.shot.display}` : '';
      return `- id ${m.id}: ${m.role} "${String(m.name || '').slice(0, 80)}"${at}${m.enabled === false ? ' [disabled]' : ''}`;
    })
    .join('\n');
}

function normalizeConfig(config) {
  const src = config && typeof config.computer === 'object' && config.computer ? config.computer : config || {};
  const out = { ...DEFAULT_CONFIG };
  for (const k of ['maxWidth', 'maxHeight', 'pasteThreshold']) {
    if (Number.isFinite(Number(src[k])) && Number(src[k]) > 0) out[k] = Math.floor(Number(src[k]));
  }
  if (Number.isFinite(Number(src.actionDelayMs)) && Number(src.actionDelayMs) >= 0) out.actionDelayMs = Number(src.actionDelayMs);
  if (typeof src.failsafe === 'boolean') out.failsafe = src.failsafe;
  return out;
}

class Computer {
  /**
   * @param {{driver:object, config?:object, guard?:()=>Promise<{allowed:boolean,reason?:string}>,
   *   geometryStore?:'memory'|'file', platform?:string, protect?:(w:object)=>boolean,
   *   dialogState?:()=>Promise<{visible:boolean, focused:boolean|null}|null>}} opts
   */
  constructor({ driver, config, guard, geometryStore = 'memory', platform: plat, protect, dialogState } = {}) {
    if (!driver || typeof driver !== 'object') throw new TypeError('Computer needs a driver (see src/os/index.js getDriver())');
    if (geometryStore !== 'memory' && geometryStore !== 'file') {
      throw new TypeError(`geometryStore must be 'memory' or 'file' (got ${JSON.stringify(geometryStore)})`);
    }
    this.driver = driver;
    this.config = normalizeConfig(config);
    this.guard = typeof guard === 'function' ? guard : null;
    // protect(window) → true for windows that this Computer's input must never touch (F3-SAFE-D1:
    // the Claude Anywhere dialog, for input an engine asks for): a click, drag or scroll on one, or a
    // key or text while one has the focus, is refused.
    this.protect = typeof protect === 'function' ? protect : null;
    // dialogState() → {visible, focused} of the dialog as its pages report it (null: none is open), for
    // desktops that cannot say where the dialog is or which window has the focus (GNOME/KDE Wayland):
    // there, protect() cannot judge, so pointer input waits while the dialog is on screen and keys while
    // it may have the focus.
    this.dialogState = typeof dialogState === 'function' ? dialogState : null;
    this.geometryStore = geometryStore;
    this.platform = plat || platform.info().platform;
    this._mem = emptyStore();
    this._displays = null;
    this._displaysAt = 0;
    this._queue = Promise.resolve();
    /** UI element id -> {bounds, role, name, windowId, relative, at} from uiFind/uiTree results. */
    this._uiSeen = new Map();
  }

  // ------------------------------------------------------------ geometry store

  _readStore() {
    if (this.geometryStore === 'memory') return this._mem;
    try {
      const j = JSON.parse(fs.readFileSync(paths.lastShotPath(), 'utf8'));
      if (j && j.version === 1 && j.displays && typeof j.displays === 'object') return j;
    } catch {
      /* missing or corrupt: start fresh */
    }
    return emptyStore();
  }

  _writeStore(store) {
    if (this.geometryStore === 'memory') {
      this._mem = store;
      return;
    }
    const file = paths.lastShotPath();
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn('could not save screenshot geometry:', err.message);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  _updateStore(fn) {
    const store = this._readStore();
    fn(store);
    this._writeStore(store);
  }

  _geometry(idx, store = this._readStore()) {
    const g = store.displays[String(idx)];
    return validGeometry(g) ? g : null;
  }

  _notePointer(p) {
    this._updateStore((s) => {
      s.pointer = { x: p.x, y: p.y };
    });
  }

  // ------------------------------------------------------------ displays & mapping

  async _getDisplays(force = false) {
    if (!force && this._displays && Date.now() - this._displaysAt < DISPLAY_TTL_MS) return this._displays;
    const list = await this.driver.displays();
    if (!Array.isArray(list) || !list.length) throw new Error('The driver reported no displays');
    this._displays = list.map((d, i) => ({
      index: i,
      id: d.id != null ? d.id : i,
      x: Number(d.x) || 0,
      y: Number(d.y) || 0,
      width: Number(d.width),
      height: Number(d.height),
      scale: Number(d.scale) || 1,
      primary: Boolean(d.primary),
    }));
    this._displaysAt = Date.now();
    return this._displays;
  }

  _defaultDisplay(store = this._readStore()) {
    const last = store.lastDisplay;
    if (Number.isInteger(last) && last >= 0 && (!this._displays || last < this._displays.length)) return last;
    return 0;
  }

  _displayIndex(display, displays, store) {
    if (display == null || display === '') return this._defaultDisplay(store);
    const n = typeof display === 'string' && display.trim() !== '' ? Number(display) : display;
    if (!Number.isInteger(n) || n < 0) throw inputError(`display must be a display index such as 0 or 1 (got ${JSON.stringify(display)})`);
    if (displays && n >= displays.length) {
      const c = displays.length;
      throw inputError(
        `Display ${n} does not exist; there ${c === 1 ? 'is 1 display (index 0)' : `are ${c} displays (indexes 0-${c - 1})`}.`,
        'INVALID_INPUT',
        'Call screen_info to list displays.'
      );
    }
    return n;
  }

  /** Mapping parameters for a display: last full screenshot, else logical display space. */
  _mapping(idx, store = this._readStore()) {
    const g = this._geometry(idx, store);
    if (g) return { rect: g.display, shotW: g.shot.width, shotH: g.shot.height, fromShot: true };
    const d = this._displays && this._displays[idx];
    if (d) return { rect: d, shotW: d.width, shotH: d.height, fromShot: false };
    if (idx === 0) return { identity: true };
    throw inputError(`Display ${idx} is unknown; take a screenshot or call screenInfo() first.`);
  }

  _mapToLogical(m, x, y) {
    if (m.identity) return { x: Math.round(x), y: Math.round(y) };
    const { rect } = m;
    const lx = Math.round(rect.x + x * (rect.width / m.shotW));
    const ly = Math.round(rect.y + y * (rect.height / m.shotH));
    return {
      x: Math.min(rect.x + rect.width - 1, Math.max(rect.x, lx)),
      y: Math.min(rect.y + rect.height - 1, Math.max(rect.y, ly)),
    };
  }

  _clampAxis(v, size, name, idx, m) {
    if (v >= 0 && v <= size - 1) return v;
    if (v >= -EDGE_TOLERANCE && v <= size - 1 + EDGE_TOLERANCE) return Math.min(size - 1, Math.max(0, v));
    if (m.fromShot) {
      throw inputError(`${name}=${v} is outside the last screenshot (${m.shotW}x${m.shotH}) of display ${idx}. Take a new screenshot.`, 'OUT_OF_BOUNDS');
    }
    throw inputError(
      `${name}=${v} is outside display ${idx} (${m.shotW}x${m.shotH}). No screenshot of this display has been taken yet, ` +
        'so coordinates are display-local logical pixels. Take a screenshot first.',
      'OUT_OF_BOUNDS'
    );
  }

  _validatePoint(m, idx, x, y, names = ['x', 'y']) {
    const nx = toNumber(x, names[0]);
    const ny = toNumber(y, names[1]);
    if (m.identity) return { x: nx, y: ny };
    return { x: this._clampAxis(nx, m.shotW, names[0], idx, m), y: this._clampAxis(ny, m.shotH, names[1], idx, m) };
  }

  /**
   * Screenshot-space point → logical global coordinates (clamped to the display).
   * @param {number} [display] defaults to the display of the last full screenshot
   * @returns {{x:number,y:number}}
   */
  toLogical(display, x, y) {
    const store = this._readStore();
    const idx = this._displayIndex(display, null, store);
    return this._mapToLogical(this._mapping(idx, store), toNumber(x, 'x'), toNumber(y, 'y'));
  }

  /**
   * Logical global coordinates → screenshot space of a display (not clamped).
   * @returns {{x:number,y:number}}
   */
  toShot(display, lx, ly) {
    const store = this._readStore();
    const idx = this._displayIndex(display, null, store);
    const m = this._mapping(idx, store);
    const x = toNumber(lx, 'x');
    const y = toNumber(ly, 'y');
    if (m.identity) return { x: Math.round(x), y: Math.round(y) };
    return {
      x: Math.round((x - m.rect.x) / (m.rect.width / m.shotW)),
      y: Math.round((y - m.rect.y) / (m.rect.height / m.shotH)),
    };
  }

  // ------------------------------------------------------------ safety & sequencing

  _serial(fn) {
    const run = this._queue.then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  /**
   * Run an input action: load displays, validate (prepare returns the
   * performer), check the guard and failsafe, act, then settle.
   */
  _act(prepare) {
    return this._serial(async () => {
      const displays = await this._getDisplays();
      const perform = await prepare(displays);
      await this._preflight(displays);
      const result = await perform();
      if (this.config.actionDelayMs > 0) await sleep(this.config.actionDelayMs);
      return result;
    });
  }

  async _preflight(displays) {
    if (this.guard) {
      let verdict;
      try {
        verdict = await this.guard();
      } catch (err) {
        throw inputError(`Actions are paused: could not check with the dialog (${err.message})`, 'PAUSED');
      }
      if (verdict && verdict.allowed === false) {
        throw inputError(`Actions are paused: ${verdict.reason || 'the user paused Claude'}`, 'PAUSED', 'Resume from the Claude Anywhere dialog.');
      }
    }
    if (this.config.failsafe) await this._checkFailsafe(displays);
  }

  async _checkFailsafe(displays) {
    let pos;
    try {
      pos = await this.driver.cursorPosition();
    } catch {
      return; // cursor position unknown (e.g. some Wayland setups): cannot apply the failsafe
    }
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    if (pos.estimated) return; // the driver could not read the real pointer (most Wayland compositors): the failsafe cannot apply
    const primary = displays.find((d) => d.primary) || displays[0];
    if (Math.abs(pos.x - primary.x) > FAILSAFE_RADIUS || Math.abs(pos.y - primary.y) > FAILSAFE_RADIUS) return;
    // Don't trip over our own move: only a pointer the user put there pauses us.
    const own = this._readStore().pointer;
    if (own && Math.abs(own.x - pos.x) <= 1 && Math.abs(own.y - pos.y) <= 1) return;
    const err = new Error('FAILSAFE: mouse is in the top-left corner; actions are paused');
    err.code = 'FAILSAFE';
    err.hint = 'Move the mouse away from the top-left corner of the primary display to resume.';
    throw err;
  }

  /**
   * @private F3-SAFE-D1 where the desktop cannot place the dialog (no window list, no active window: GNOME
   * and KDE on Wayland): whether a dialog page is on screen and has the focus, as the pages report it to
   * the daemon. null: no dialog page is open, or this Computer has no such source (the CLI's, the
   * daemon's own). A source that fails counts as a dialog on screen whose focus is unknown (fails closed).
   * @returns {Promise<{visible:boolean, focused:boolean|null}|null>}
   */
  async _dialogOnScreen() {
    if (!this.dialogState) return null;
    let s;
    try {
      s = await this.dialogState();
    } catch (err) {
      log.debug('dialog state unknown:', err && err.message);
      return { visible: true, focused: null };
    }
    if (!s || typeof s !== 'object') return null;
    return { visible: s.visible !== false, focused: typeof s.focused === 'boolean' ? s.focused : null };
  }

  /** @private refuse a pointer action on a protected window (wherever it is in the stacking order) */
  async _refuseProtectedAt(points) {
    if (!this.protect) return;
    let wins = null;
    if (typeof this.driver.listWindows === 'function') {
      try {
        wins = await this.driver.listWindows();
      } catch {
        wins = null;
      }
    }
    if (!Array.isArray(wins)) {
      // Windows cannot be listed here (GNOME/KDE Wayland), so where the dialog is is unknown: no pointer
      // input while it is on screen (a click could land on its settings).
      const d = await this._dialogOnScreen();
      if (d && d.visible) throw unplacedDialogError();
      return;
    }
    for (const w of wins) {
      if (!w || w.minimized || !this.protect(w)) continue;
      // Its frame too: the title bar's close and minimize buttons belong to the dialog.
      if (windowRects(w).some((b) => points.some((p) => inRect(p, b)))) {
        throw inputError('That point is inside the Claude Anywhere dialog, which Claude may not click', 'OWN_DIALOG', 'Only the user answers the dialog. Click somewhere else, or ask the user.');
      }
    }
  }

  /**
   * @private F3-SAFE-D1 for accessibility actions, which never pass through a pixel: refuse one on an element
   * of a protected window (the Claude Anywhere dialog: pressing its "Allow once" or its settings through the
   * accessibility API would approve Claude's own requests). The element's window is known from the lookup
   * that found it, from the window or process its id names, or else from where it is on screen.
   */
  async _refuseProtectedUi(target) {
    if (!this.protect || !target) return;
    if (target.win && this.protect(target.win)) throw ownDialogUiError(target);
    const owner = uiOwnerOfId(target.id);
    const windowId = target.windowId || owner.windowId;
    let wins = null;
    if (typeof this.driver.listWindows === 'function') {
      try {
        wins = await this.driver.listWindows();
      } catch {
        wins = null;
      }
    }
    if (Array.isArray(wins)) {
      const { sameWindowId } = require('./linux');
      const own = wins.filter((w) => w && this.protect(w));
      if (!own.length) return;
      if (windowId && own.some((w) => sameWindowId(w.id, windowId))) throw ownDialogUiError(target);
      if (owner.pid && own.some((w) => Number(w.pid) === owner.pid)) throw ownDialogUiError(target);
      if (windowId && wins.some((w) => w && sameWindowId(w.id, windowId))) return;
      // Its window is not listed (a pop-up menu) or unknown: judged by where the element is.
      const b = target.bounds;
      if (!target.relative && validRect(b)) {
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        for (const w of own) {
          if (!w.minimized && windowRects(w).some((r) => inRect({ x: cx, y: cy }, r))) throw ownDialogUiError(target);
        }
      }
      return;
    }
    // Windows cannot be listed here (GNOME/KDE Wayland): the drivers look in the active window by default.
    if (typeof this.driver.activeWindow === 'function') {
      let a = null;
      try {
        a = await this.driver.activeWindow();
      } catch {
        a = null;
      }
      const { sameWindowId } = require('./linux');
      if (a && this.protect(a) && (!windowId || a.id == null || sameWindowId(a.id, windowId))) throw ownDialogUiError(target);
    }
    // The lookup that found the element names its window, and that is not the dialog (checked above).
    if (target.win) return;
    // Its window is unknown: nothing while the dialog is on screen.
    const d = await this._dialogOnScreen();
    if (d && d.visible) {
      throw inputError(
        `"${target.name || target.id || 'That element'}" may be in the Claude Anywhere dialog (this desktop cannot tell which window it is in), which Claude may not operate`,
        'OWN_DIALOG',
        'Find it again with ui_find in the window you mean, or ask the user to minimize the Claude Anywhere dialog.',
      );
    }
  }

  /** @private refuse keys and text while a protected window has the focus */
  async _refuseProtectedFocus() {
    if (!this.protect) return;
    let w = null;
    if (typeof this.driver.activeWindow === 'function') {
      try {
        w = await this.driver.activeWindow();
      } catch {
        w = null;
      }
    }
    if (w && this.protect(w)) {
      throw inputError('The Claude Anywhere dialog has the focus, and Claude may not type into it', 'OWN_DIALOG', 'Focus the window you want to type in first (focus_window), or ask the user.');
    }
    if (w) return;
    // The active window is unknown here (GNOME/KDE Wayland): the dialog's own report decides.
    const d = await this._dialogOnScreen();
    if (d && (d.focused === true || (d.visible && d.focused == null))) {
      throw inputError(
        d.focused ? 'The Claude Anywhere dialog has the focus, and Claude may not type into it' : 'The Claude Anywhere dialog may have the focus (this desktop cannot tell which window has it), and Claude may not type into it',
        'OWN_DIALOG',
        'Ask the user to click into the window you want to type in, then try again.',
      );
    }
  }

  _modifiers(modifiers) {
    if (modifiers == null || modifiers === '' || (Array.isArray(modifiers) && !modifiers.length)) return [];
    const list = keys.normalizeCombo(modifiers, { platform: this.platform });
    const bad = list.filter((k) => !keys.isModifier(k));
    if (bad.length) throw inputError(`modifiers may only contain ctrl, alt, shift, meta (got ${bad.join(', ')})`);
    return list;
  }

  async _target(displays, display, x, y, names, what) {
    const store = this._readStore();
    const idx = this._displayIndex(display, displays, store);
    const m = this._mapping(idx, store);
    if (x == null && y == null) {
      const pos = await this.driver.cursorPosition();
      const logical = { x: Math.round(pos.x), y: Math.round(pos.y) };
      const shot = m.identity ? logical : this.toShot(idx, logical.x, logical.y);
      return { idx, shot, logical };
    }
    if (x == null || y == null) {
      throw inputError(`${what} needs both ${names[0]} and ${names[1]} (or neither, to use the current mouse position)`);
    }
    const shot = this._validatePoint(m, idx, x, y, names);
    return { idx, shot, logical: this._mapToLogical(m, shot.x, shot.y) };
  }

  // ------------------------------------------------------------ screenshots

  /**
   * Capture a display, downscaled to fit maxWidth x maxHeight. With `region`
   * (in full-screenshot space) returns a zoomed crop at up to native
   * resolution; only full-display shots change the coordinate mapping.
   * @returns {Promise<{png:Buffer,width:number,height:number,display:number,displays:number,scale:number,
   *   native:{width:number,height:number},region:object|null,cursor:{x:number,y:number}|null}>}
   */
  async screenshot({ display = 0, region, maxWidth, maxHeight } = {}) {
    return this._serial(async () => {
      const displays = await this._getDisplays(true);
      const store = this._readStore();
      const idx = this._displayIndex(display == null ? 0 : display, displays, store);
      const d = displays[idx];
      const maxW = positiveOr(maxWidth, this.config.maxWidth);
      const maxH = positiveOr(maxHeight, this.config.maxHeight);

      const cap = await this.driver.captureDisplay(idx);
      if (!cap || !Buffer.isBuffer(cap.png)) throw new Error('The driver returned no screenshot image');
      const hdr = png.readHeader(cap.png);
      const nativeW = hdr.width;
      const nativeH = hdr.height;
      let cursorLogical = null;
      try {
        cursorLogical = await this.driver.cursorPosition();
        // A made-up position (Wayland) is not the user's cursor: leave it out of the metadata.
        if (cursorLogical && cursorLogical.estimated) cursorLogical = null;
      } catch {
        cursorLogical = null;
      }
      const cursorFor = (m) => {
        if (!cursorLogical || displayAt([d], cursorLogical.x, cursorLogical.y) < 0) return null;
        const sx = m.rect.width / m.shotW;
        const sy = m.rect.height / m.shotH;
        return {
          x: Math.min(m.shotW - 1, Math.max(0, Math.round((cursorLogical.x - m.rect.x) / sx))),
          y: Math.min(m.shotH - 1, Math.max(0, Math.round((cursorLogical.y - m.rect.y) / sy))),
        };
      };

      if (region == null) {
        const fit = png.fitWithin(nativeW, nativeH, maxW, maxH);
        let out = cap.png;
        if (fit.width !== nativeW || fit.height !== nativeH) {
          out = png.encode(png.resize(png.decode(cap.png), fit.width, fit.height));
        }
        const geo = { display: rectOf(d), shot: { width: fit.width, height: fit.height }, native: { width: nativeW, height: nativeH }, ts: Date.now() };
        this._updateStore((s) => {
          s.displays[String(idx)] = geo;
          s.lastDisplay = idx;
        });
        const m = { rect: geo.display, shotW: fit.width, shotH: fit.height };
        return {
          png: out,
          width: fit.width,
          height: fit.height,
          display: idx,
          displays: displays.length,
          scale: d.width / fit.width,
          native: { width: nativeW, height: nativeH },
          region: null,
          cursor: cursorFor(m),
        };
      }

      // Region zoom: interpret the region in the current shot space of this display.
      const g = this._geometry(idx, store);
      const m = g ? { rect: g.display, shotW: g.shot.width, shotH: g.shot.height, fromShot: true } : { rect: d, shotW: d.width, shotH: d.height, fromShot: false };
      const reg = this._validateRegion(region, m, idx);
      const kx = (m.rect.width / m.shotW) * (nativeW / d.width); // native px per shot px
      const ky = (m.rect.height / m.shotH) * (nativeH / d.height);
      const nx0 = Math.max(0, Math.floor(reg.x * kx));
      const ny0 = Math.max(0, Math.floor(reg.y * ky));
      const nx1 = Math.min(nativeW, Math.ceil((reg.x + reg.width) * kx));
      const ny1 = Math.min(nativeH, Math.ceil((reg.y + reg.height) * ky));
      if (nx1 - nx0 < 1 || ny1 - ny0 < 1) throw inputError('region is too small to capture', 'OUT_OF_BOUNDS');
      const cropped = png.crop(png.decode(cap.png), nx0, ny0, nx1 - nx0, ny1 - ny0);
      const fit = png.fitWithin(cropped.width, cropped.height, maxW, maxH);
      const img = fit.width !== cropped.width || fit.height !== cropped.height ? png.resize(cropped, fit.width, fit.height) : cropped;
      return {
        png: png.encode(img),
        width: img.width,
        height: img.height,
        display: idx,
        displays: displays.length,
        scale: (reg.width * (m.rect.width / m.shotW)) / img.width,
        native: { width: cropped.width, height: cropped.height },
        region: reg,
        cursor: cursorFor(m),
      };
    });
  }

  _validateRegion(region, m, idx) {
    if (typeof region !== 'object' || Array.isArray(region)) {
      throw inputError('region must be an object {x, y, width, height} in screenshot pixels');
    }
    const x = toNumber(region.x, 'region.x');
    const y = toNumber(region.y, 'region.y');
    const w = toNumber(region.width, 'region.width');
    const h = toNumber(region.height, 'region.height');
    if (w <= 0 || h <= 0) throw inputError(`region width and height must be positive (got ${w}x${h})`);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(m.shotW, Math.round(x + w));
    const y1 = Math.min(m.shotH, Math.round(y + h));
    if (x1 - x0 < 1 || y1 - y0 < 1) {
      const where = m.fromShot ? `the last screenshot (${m.shotW}x${m.shotH})` : `display ${idx} (${m.shotW}x${m.shotH} logical px)`;
      throw inputError(`region ${x},${y} ${w}x${h} lies outside ${where} of display ${idx}. Take a new screenshot.`, 'OUT_OF_BOUNDS');
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  // ------------------------------------------------------------ input actions

  /** Click at (x, y) in screenshot space; without x/y clicks at the current mouse position. */
  async click({ x, y, button = 'left', clicks = 1, modifiers = [], display } = {}) {
    const btn = String(button || 'left').toLowerCase();
    if (!BUTTONS.includes(btn)) throw inputError(`button must be one of ${BUTTONS.join(', ')} (got ${JSON.stringify(button)})`);
    const n = toInt(clicks == null ? 1 : clicks, 'clicks', 1, 3);
    const mods = this._modifiers(modifiers);
    return this._act(async (displays) => {
      const t = await this._target(displays, display, x, y, ['x', 'y'], 'click');
      await this._refuseProtectedAt([t.logical]);
      return async () => {
        const res = await this.driver.click(t.logical.x, t.logical.y, { button: btn, clicks: n, modifiers: mods });
        this._notePointer(t.logical);
        return { ok: true, action: 'click', x: t.shot.x, y: t.shot.y, display: t.idx, logical: t.logical, button: btn, clicks: n, modifiers: mods, ...warningsOf(res) };
      };
    });
  }

  /** Move the mouse to (x, y) in screenshot space. */
  async moveMouse({ x, y, display } = {}) {
    return this._act(async (displays) => {
      if (x == null || y == null) throw inputError('moveMouse needs x and y');
      const t = await this._target(displays, display, x, y, ['x', 'y'], 'moveMouse');
      return async () => {
        await this.driver.moveMouse(t.logical.x, t.logical.y);
        this._notePointer(t.logical);
        return { ok: true, action: 'move', x: t.shot.x, y: t.shot.y, display: t.idx, logical: t.logical };
      };
    });
  }

  /** Press at (fromX, fromY), move to (toX, toY), release. */
  async drag({ fromX, fromY, toX, toY, button = 'left', display } = {}) {
    const btn = String(button || 'left').toLowerCase();
    if (!BUTTONS.includes(btn)) throw inputError(`button must be one of ${BUTTONS.join(', ')} (got ${JSON.stringify(button)})`);
    return this._act(async (displays) => {
      if ([fromX, fromY, toX, toY].some((v) => v == null)) throw inputError('drag needs fromX, fromY, toX and toY');
      const a = await this._target(displays, display, fromX, fromY, ['fromX', 'fromY'], 'drag');
      const b = await this._target(displays, display, toX, toY, ['toX', 'toY'], 'drag');
      await this._refuseProtectedAt([a.logical, b.logical]);
      return async () => {
        const res = await this.driver.drag(a.logical.x, a.logical.y, b.logical.x, b.logical.y, { button: btn });
        this._notePointer(b.logical);
        return { ok: true, action: 'drag', from: a.shot, to: b.shot, display: a.idx, logicalFrom: a.logical, logicalTo: b.logical, button: btn, ...warningsOf(res) };
      };
    });
  }

  /** Scroll `amount` wheel notches in `direction`, at (x, y) or at the mouse. */
  async scroll({ x, y, direction, amount = 3, display } = {}) {
    const dir = String(direction || '').toLowerCase();
    if (!DIRECTIONS[dir]) throw inputError(`direction must be one of up, down, left, right (got ${JSON.stringify(direction)})`);
    const n = Math.round(toNumber(amount == null ? 3 : amount, 'amount'));
    if (n < 1 || n > MAX_SCROLL) throw inputError(`amount must be from 1 to ${MAX_SCROLL} notches (got ${amount})`);
    return this._act(async (displays) => {
      const t = await this._target(displays, display, x, y, ['x', 'y'], 'scroll');
      await this._refuseProtectedAt([t.logical]);
      const [ux, uy] = DIRECTIONS[dir];
      return async () => {
        const res = await this.driver.scroll(t.logical.x, t.logical.y, ux * n, uy * n);
        this._notePointer(t.logical);
        return { ok: true, action: 'scroll', direction: dir, amount: n, x: t.shot.x, y: t.shot.y, display: t.idx, logical: t.logical, ...warningsOf(res) };
      };
    });
  }

  async _activeIsTerminal() {
    if (this.platform !== 'linux') return false;
    try {
      const w = await this.driver.activeWindow();
      return Boolean(w && TERMINAL_RE.test(String(w.app || '')));
    } catch {
      return false;
    }
  }

  /** @returns {Promise<*>} the driver's keyCombo result (may carry warnings) */
  async _paste(text, terminal) {
    let saved = null;
    try {
      saved = await this.driver.clipboardGet();
    } catch (err) {
      log.debug('clipboard read failed; it will not be restored:', err.message);
    }
    await this.driver.clipboardSet(text);
    await sleep(PASTE_SETTLE_MS);
    // Linux terminals paste with ctrl+shift+v; everything else uses primary+v.
    const combo = terminal ? ['ctrl', 'shift', 'v'] : keys.normalizeCombo('primary+v', { platform: this.platform });
    const pressed = await this.driver.keyCombo(combo);
    await sleep(PASTE_RESTORE_MS);
    if (typeof saved !== 'string' || sameClipText(saved, text)) return pressed;
    try {
      let now = text;
      try {
        now = await this.driver.clipboardGet();
      } catch {
        /* assume unchanged */
      }
      // Only restore if nobody copied something else in the meantime. Compared up to line endings:
      // Windows hands back the pasted "a\nb" as "a\r\nb", which is still our text.
      if (sameClipText(now, text)) await this.driver.clipboardSet(saved);
    } catch (err) {
      log.warn('could not restore the clipboard:', err.message);
    }
    return pressed;
  }

  /**
   * Type literal text into the focused window. 'auto' pastes long, multi-line
   * or astral-plane text (except into Linux terminals) and types the rest.
   */
  async typeText({ text, method = 'auto' } = {}) {
    if (typeof text !== 'string') throw inputError(`text must be a string (got ${text === undefined ? 'nothing' : typeof text})`);
    const how = String(method || 'auto').toLowerCase();
    if (!['auto', 'keys', 'paste'].includes(how)) throw inputError(`method must be auto, keys or paste (got ${JSON.stringify(method)})`);
    if (text === '') return { ok: true, action: 'type', method: 'none', chars: 0 };
    return this._act(async () => {
      await this._refuseProtectedFocus();
      const terminal = how === 'keys' ? false : await this._activeIsTerminal();
      let use = how;
      if (use === 'auto') {
        const wantsPaste = text.length > this.config.pasteThreshold || /[\r\n]/.test(text) || /[\uD800-\uDFFF]/.test(text);
        use = wantsPaste && !terminal ? 'paste' : 'keys';
      }
      return async () => {
        const res = use === 'paste' ? await this._paste(text, terminal) : await this.driver.typeText(text);
        return { ok: true, action: 'type', method: use, chars: Array.from(text).length, ...warningsOf(res) };
      };
    });
  }

  /** Press a key combo such as "enter", "primary+s" or "ctrl+shift+t", `repeat` times. */
  async key({ combo, repeat = 1 } = {}) {
    if (combo == null || combo === '' || (Array.isArray(combo) && !combo.length)) {
      throw inputError('combo is required, e.g. "enter", "escape", "primary+s" or "ctrl+shift+t"');
    }
    const list = keys.normalizeCombo(combo, { platform: this.platform });
    const n = toInt(repeat == null ? 1 : repeat, 'repeat', 1, MAX_REPEAT);
    return this._act(async () => {
      await this._refuseProtectedFocus();
      return async () => {
        const results = [];
        for (let i = 0; i < n; i++) {
          if (i) await sleep(REPEAT_GAP_MS);
          results.push(await this.driver.keyCombo(list));
        }
        return { ok: true, action: 'key', keys: list, repeat: n, ...warningsOf(...results) };
      };
    });
  }

  /**
   * Read a browser window's address (and, with includeText, its page text) through
   * driver.browserTab(), in the action queue so its keystrokes never interleave with another
   * action. Before the first keystroke (the keyboard path), opts.beforeInput (if any) and then
   * the Computer's own guard and failsafe run; a PAUSED/FAILSAFE error aborts with no input.
   * @param {object} [opts] driver.browserTab options ({app, window, windowId, includeText, maxChars, keyboard, beforeInput})
   * @returns {Promise<object>} driver.browserTab's result
   */
  async browserTab(opts = {}) {
    if (typeof this.driver.browserTab !== 'function') {
      throw inputError(`This desktop driver (${this.driver.name || 'unknown'}) cannot read browser tabs`, 'UNSUPPORTED', 'Use the window titles (list_windows) or a screenshot instead.');
    }
    const o = opts && typeof opts === 'object' ? opts : {};
    return this._serial(async () => {
      const displays = await this._getDisplays();
      return this.driver.browserTab({
        ...o,
        beforeInput: async () => {
          if (typeof o.beforeInput === 'function') await o.beforeInput();
          await this._preflight(displays);
        },
      });
    });
  }

  // ------------------------------------------------------------ UI elements (accessibility)

  _requireUi(method) {
    if (typeof this.driver[method] !== 'function') {
      throw inputError(
        `This desktop driver (${this.driver.name || 'unknown'}) cannot read the controls of apps`,
        'UNSUPPORTED',
        'Take a screenshot (or use find_text) and click by position instead.',
      );
    }
  }

  /**
   * An element's logical bounds in the latest-screenshot space of the display that holds its centre:
   * {x, y, width, height, cx, cy, display}, or null when it has no size or is on no display.
   */
  _shotRect(bounds, displays, store = this._readStore()) {
    if (!validRect(bounds)) return null;
    const lcx = bounds.x + bounds.width / 2;
    const lcy = bounds.y + bounds.height / 2;
    const idx = displayAt(displays, lcx, lcy);
    if (idx < 0) return null;
    const m = this._mapping(idx, store);
    if (m.identity) return null;
    const kx = m.shotW / m.rect.width;
    const ky = m.shotH / m.rect.height;
    return {
      x: Math.round((bounds.x - m.rect.x) * kx),
      y: Math.round((bounds.y - m.rect.y) * ky),
      width: Math.max(1, Math.round(bounds.width * kx)),
      height: Math.max(1, Math.round(bounds.height * ky)),
      cx: Math.min(m.shotW - 1, Math.max(0, Math.round((lcx - m.rect.x) * kx))),
      cy: Math.min(m.shotH - 1, Math.max(0, Math.round((lcy - m.rect.y) * ky))),
      display: idx,
    };
  }

  _uiNote(list, relative, windowId, win) {
    const now = Date.now();
    const w = win && typeof win === 'object' ? { id: win.id, title: win.title, app: win.app } : null;
    for (const n of list) {
      if (!n || typeof n.id !== 'string') continue;
      this._uiSeen.delete(n.id);
      // The window searched is the element's own unless the element names another (as in _uiPick).
      const own = !n.windowId || (windowId != null && String(n.windowId) === String(windowId));
      this._uiSeen.set(n.id, { bounds: n.bounds || null, role: n.role, name: n.name, windowId: n.windowId || windowId || null, win: own ? w : null, relative, at: now });
    }
    while (this._uiSeen.size > UI_SEEN_MAX) this._uiSeen.delete(this._uiSeen.keys().next().value);
  }

  _uiKnown(id) {
    const e = this._uiSeen.get(id);
    if (e && Date.now() - e.at <= UI_SEEN_TTL_MS) return { id, ...e };
    if (e) this._uiSeen.delete(id);
    return { id, bounds: null, role: '', name: '', windowId: null, win: null, relative: false };
  }

  /**
   * Find UI elements of a window through the driver's accessibility API (uiFind), each with `shot`:
   * {x, y, width, height, cx, cy, display} in the latest-screenshot space of its display (null when it
   * has no size, is off every display, or the platform cannot place it). Not an input action.
   * @param {{windowId?:string, name?:string, role?:string|string[], text?:string, exact?:boolean, limit?:number}} [opts]
   * @returns {Promise<object[]>} the driver's matches (plus shot), with its metadata (window, truncated, notes...)
   */
  async uiFind(opts = {}) {
    this._requireUi('uiFind');
    const list = await this.driver.uiFind(opts && typeof opts === 'object' ? opts : {});
    const displays = await this._getDisplays();
    const store = this._readStore();
    const relative = Boolean(list && list.relativeBounds);
    const out = (Array.isArray(list) ? list : []).map((m) => ({ ...m, shot: relative ? null : this._shotRect(m.bounds, displays, store) }));
    copyMeta(list, out);
    this._uiNote(out, relative, list && list.window ? list.window.id : null, list && list.window);
    return out;
  }

  /**
   * The accessibility tree of a window (driver.uiTree), each node with `shot` as in uiFind.
   * @param {{windowId?:string, depth?:number, maxNodes?:number}} [opts]
   * @returns {Promise<{window:object, nodes:object[], truncated:boolean, notes?:string[]}>}
   */
  async uiTree(opts = {}) {
    this._requireUi('uiTree');
    const tree = (await this.driver.uiTree(opts && typeof opts === 'object' ? opts : {})) || {};
    const displays = await this._getDisplays();
    const store = this._readStore();
    const relative = Boolean(tree.relativeBounds);
    const nodes = (Array.isArray(tree.nodes) ? tree.nodes : []).map((n) => ({ ...n, shot: relative ? null : this._shotRect(n.bounds, displays, store) }));
    this._uiNote(nodes, relative, tree.window ? tree.window.id : null, tree.window);
    return { ...tree, nodes };
  }

  /**
   * The element a uiClick/uiSetValue query means: the best uiFind match; several equally good
   * enabled, on-screen matches are AMBIGUOUS (the error lists their ids).
   */
  async _uiPick(q, displays, preferRoles) {
    const query = { windowId: q.windowId, name: q.name, text: q.text, exact: q.exact === true, limit: UI_PICK_LIMIT };
    if (hasText(q.role) || (Array.isArray(q.role) && q.role.length)) query.role = q.role;
    const list = await this.driver.uiFind(query);
    const relative = Boolean(list && list.relativeBounds);
    const store = this._readStore();
    let found = (Array.isArray(list) ? list : []).map((m) => ({ ...m, shot: relative ? null : this._shotRect(m.bounds, displays, store) }));
    if (preferRoles && !query.role) {
      // Without a role, a field that takes the value beats its label or a button of the same name.
      const pref = found.filter((m) => preferRoles.includes(m.role));
      if (pref.length) found = [...pref, ...found.filter((m) => !preferRoles.includes(m.role))];
    }
    const what = `${hasText(q.role) ? q.role : 'element'} ${hasText(q.name) ? `named "${q.name}"` : `with text "${q.text}"`}`;
    const where = list && list.window && list.window.title ? ` in "${list.window.title}"` : '';
    if (!found.length) {
      const notes = list && Array.isArray(list.notes) && list.notes.length ? ` ${list.notes.join(' ')}` : '';
      throw inputError(`No ${what}${where}.${notes}`, 'NOT_FOUND', 'Call ui_tree to see what the window offers, or take a screenshot.');
    }
    this._uiNote(found, relative, list && list.window ? list.window.id : null, list && list.window);
    const usable = found.filter((m) => m.enabled !== false && !m.offscreen);
    const best = usable[0] || found[0];
    const key = (m) => {
      const exactName = hasText(q.name) && uiNorm(m.name) === uiNorm(q.name);
      const exactText = hasText(q.text) && [m.name, m.value].some((v) => uiNorm(v) === uiNorm(q.text));
      return `${m.role}|${exactName || exactText ? 'exact' : 'partial'}`;
    };
    const ties = usable.filter((m) => key(m) === key(best));
    if (ties.length > 1) {
      throw inputError(
        `${ties.length} elements match ${what}${where}; nothing was done. Call again with one of these ids:\n${uiCandidateLines(ties)}`,
        'AMBIGUOUS',
        'Pass id (from this list or ui_find), or narrow the query with role, exact or window.',
      );
    }
    const out = { ...best, relative, candidates: found.length };
    // The window searched (for the dialog check), unless the match says it belongs to another one.
    if (list && list.window && typeof list.window === 'object' && (!best.windowId || String(best.windowId) === String(list.window.id))) {
      out.win = { id: list.window.id, title: list.window.title, app: list.window.app };
    }
    // Driver warnings about the search (Windows: a Chromium window that exposes almost nothing).
    if (list && Array.isArray(list.warnings) && list.warnings.length) out.findWarnings = list.warnings.slice();
    return out;
  }

  /**
   * The listed window `windowId` and whether it is the active one, or null when that is unknown: no window id,
   * a driver that cannot list windows (GNOME/KDE Wayland), or a window list does not show (Windows pop-up
   * menus and drop-downs, which focusing would close).
   */
  async _uiWindowState(windowId) {
    if (!hasText(windowId) || typeof this.driver.listWindows !== 'function' || typeof this.driver.activeWindow !== 'function') return null;
    const { sameWindowId } = require('./linux');
    let wins;
    let active;
    try {
      [wins, active] = await Promise.all([this.driver.listWindows(), this.driver.activeWindow()]);
    } catch (err) {
      log.debug('window state unknown:', err && err.message);
      return null;
    }
    const w = (Array.isArray(wins) ? wins : []).find((x) => x && sameWindowId(x.id, windowId));
    if (!w || !active || active.id == null) return null;
    return { window: w, active: sameWindowId(active.id, w.id) };
  }

  /**
   * Bring an element's window to the front before input that depends on it: a real click at its centre (on a
   * covered window that point belongs to the window on top) and keys typed after focusing it (the accessibility
   * focus action does not raise the window in every toolkit). Throws FOCUS_FAILED when the window is known to
   * stay behind, so nothing lands in another app.
   */
  async _uiFront(target, what) {
    const st = await this._uiWindowState(target.windowId);
    if (!st || st.active) return;
    try {
      await this.driver.focusWindow(st.window.id);
    } catch (err) {
      log.debug('focusing the element window failed:', err && err.message);
    }
    await sleep(UI_FRONT_SETTLE_MS);
    const again = await this._uiWindowState(target.windowId);
    if (again && !again.active) {
      throw inputError(
        `The window of "${target.name || target.id}" could not be brought to the front, so nothing was ${what}`,
        'FOCUS_FAILED',
        `Call focus_window with id ${st.window.id} (or click the window), then try again.`,
      );
    }
  }

  /** Click the centre of an element's bounds (logical) for the uiClick/uiSetValue fallbacks. */
  async _uiClickCentre(target, bounds, displays) {
    if (target.relative) {
      throw inputError(
        `"${target.name || target.id}" cannot be pressed through accessibility, and its position on screen is unknown on this desktop`,
        'UI_ACTION_FAILED',
        'Take a screenshot (or use find_text) and click it by position.',
      );
    }
    if (!validRect(bounds)) {
      throw inputError(
        `"${target.name || target.id}" cannot be pressed through accessibility and has no position to click`,
        'UI_ACTION_FAILED',
        'Take a screenshot (or use find_text) and click it by position.',
      );
    }
    const lx = Math.round(bounds.x + bounds.width / 2);
    const ly = Math.round(bounds.y + bounds.height / 2);
    const idx = displayAt(displays, lx, ly);
    if (idx < 0) {
      throw inputError(`"${target.name || target.id}" is off screen`, 'OFFSCREEN', 'Scroll it into view (or bring its window on screen) and try again.');
    }
    // F3-SAFE-D1 as for click: an element under the (always-on-top) dialog would be a click on the dialog.
    await this._refuseProtectedAt([{ x: lx, y: ly }]);
    const res = await this.driver.click(lx, ly, { button: 'left', clicks: 1, modifiers: [] });
    this._notePointer({ x: lx, y: ly });
    return { res, logical: { x: lx, y: ly }, display: idx };
  }

  async _uiTry(id, action, value) {
    try {
      const args = { id, action };
      if (value !== undefined) args.value = value;
      return { res: (await this.driver.uiAction(args)) || { ok: false, method: 'none' }, err: null };
    } catch (err) {
      if (err && UI_FATAL_CODES.has(err.code)) throw err;
      return { res: null, err };
    }
  }

  _uiResult(action, target, extra, displays) {
    const bounds = (extra && extra.bounds) || target.bounds;
    const shot = target.relative ? null : this._shotRect(bounds, displays);
    const out = { ok: true, action, id: (extra && extra.id) || target.id, role: target.role || (extra && extra.role) || '', name: target.name || (extra && extra.name) || '' };
    if (target.windowId) out.windowId = target.windowId;
    if (shot) out.shot = shot;
    if (target.candidates > 1) out.candidates = target.candidates;
    return out;
  }

  /**
   * Press a UI element: by id (from uiFind/uiTree), or the best match for name/text (+ role,
   * windowId, exact). Prefers the accessibility action (press; focus for a text box), else clicks
   * the centre of the element with the real mouse. An input action: guard, failsafe, settle delay.
   * @param {{id?:string, name?:string, text?:string, role?:string, windowId?:string, exact?:boolean}} opts
   * @returns {Promise<{ok:true, action:'ui_click', method:string, id:string, role:string, name:string,
   *   shot?:object, windowId?:string, pending?:boolean, logical?:object, display?:number, warnings?:string[]}>}
   */
  async uiClick({ id, name, text, role, windowId, exact } = {}) {
    this._requireUi('uiAction');
    const byId = hasText(id);
    if (!byId) this._requireUi('uiFind');
    if (!byId && !hasText(name) && !hasText(text)) {
      throw inputError('uiClick needs an element id, or a name or text to find it by (role and windowId narrow it down)');
    }
    const q = { name, text, role, windowId, exact };
    return this._act(async (displays) => {
      const target = byId ? this._uiKnown(String(id).trim()) : await this._uiPick(q, displays);
      return () => this._uiRefinding(target, byId ? null : () => this._uiPick(q, displays), (t) => this._uiClickPerform(t, displays));
    });
  }

  /**
   * Run `perform(target)`; when the element changed since a by-name lookup found it (STALE /
   * STALE_ELEMENT), look it up once more and retry. By id (`repick` null) the error stands.
   */
  async _uiRefinding(target, repick, perform) {
    try {
      return await perform(target);
    } catch (err) {
      if (!repick || !err || !UI_STALE_CODES.has(err.code)) throw err;
      return perform(await repick());
    }
  }

  /** uiClick's action on a resolved target: the accessibility press (focus for a text box), else a real click. */
  async _uiClickPerform(target, displays) {
    await this._refuseProtectedUi(target);
    // A text box is "clicked" to type into it: focus does that without side effects.
    const action = target.role === 'textbox' ? 'focus' : 'press';
    let { res, err } = await this._uiTry(target.id, action);
    if (action === 'focus' && !(res && res.ok)) ({ res, err } = await this._uiTry(target.id, 'press'));
    const found = target.findWarnings ? { warnings: target.findWarnings } : null;
    if (res && res.ok) {
      const out = { ...this._uiResult('ui_click', target, res, displays), method: res.method || action, ...warningsOf(found, res) };
      // pending (Windows) / confirmed:false (macOS): the app has not answered yet, most likely because
      // the press opened a modal dialog or a menu. The press happened: never click on top of it.
      if (res.pending || res.confirmed === false) out.pending = true;
      return out;
    }
    if (res && res.disabled) {
      throw inputError(`"${target.name || res.name || target.id}" is disabled`, 'DISABLED', 'Something must happen first (fill in a field, select an item) before it can be used.');
    }
    const bounds = (res && res.bounds) || target.bounds;
    await this._uiFront(target, 'clicked');
    const clicked = await this._uiClickCentre({ ...target, relative: target.relative || Boolean(res && res.relativeBounds) }, bounds, displays);
    const out = {
      ...this._uiResult('ui_click', target, { ...(res || {}), bounds }, displays),
      method: 'click',
      logical: clicked.logical,
      display: clicked.display,
      ...warningsOf(found, res, clicked.res),
    };
    const why = (res && res.reason) || (err && err.message);
    if (why) out.reason = why;
    return out;
  }

  /**
   * Set the value of a text box, combo box or slider: by id, or the best match for name/text (+ role,
   * windowId, exact; without a role, value-taking roles are tried first). Prefers the accessibility
   * setValue, else focuses the element (or clicks it), selects all and types (pastes long or
   * multi-line text). An input action: guard, failsafe, settle delay.
   * @param {{id?:string, value:string|number, name?:string, text?:string, role?:string, windowId?:string, exact?:boolean,
   *   query?:{name?:string, text?:string, role?:string, windowId?:string, exact?:boolean}}} opts
   * @returns {Promise<{ok:true, action:'ui_set_value', method:string, id:string, role:string, name:string, chars:number, shot?:object}>}
   */
  async uiSetValue({ id, value, name, text, role, windowId, exact, query } = {}) {
    this._requireUi('uiAction');
    if (value == null || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) {
      throw inputError(`value must be text or a number (got ${value === undefined ? 'nothing' : typeof value})`);
    }
    const str = String(value);
    const q = query && typeof query === 'object' ? { ...query } : { name, text, role, windowId, exact };
    const byId = hasText(id);
    if (!byId) this._requireUi('uiFind');
    if (!byId && !hasText(q.name) && !hasText(q.text)) {
      throw inputError('uiSetValue needs an element id, or a name or text to find it by (role and windowId narrow it down)');
    }
    return this._act(async (displays) => {
      const target = byId ? this._uiKnown(String(id).trim()) : await this._uiPick(q, displays, UI_VALUE_ROLES);
      return () => this._uiRefinding(target, byId ? null : () => this._uiPick(q, displays, UI_VALUE_ROLES), (t) => this._uiSetPerform(t, str, displays));
    });
  }

  /** uiSetValue's action on a resolved target: accessibility setValue, else focus/click + select all + type. */
  async _uiSetPerform(target, str, displays) {
    await this._refuseProtectedUi(target);
    const chars = Array.from(str).length;
    const found = target.findWarnings ? { warnings: target.findWarnings } : null;
    const set = await this._uiTry(target.id, 'setValue', str);
    if (set.res && set.res.ok) {
      return { ...this._uiResult('ui_set_value', target, set.res, displays), method: set.res.method || 'setValue', chars, ...warningsOf(found, set.res) };
    }
    if (set.res && set.res.disabled) {
      throw inputError(`"${target.name || set.res.name || target.id}" is disabled`, 'DISABLED', 'Something must happen first before it takes a value.');
    }
    // Keyboard: the window in front, focus (or click) the field, select all, then type or paste over it.
    await this._uiFront(target, 'typed');
    const focus = await this._uiTry(target.id, 'focus');
    let how = 'focus';
    let clicked = null;
    if (!(focus.res && focus.res.ok)) {
      const bounds = (focus.res && focus.res.bounds) || (set.res && set.res.bounds) || target.bounds;
      const relative = target.relative || Boolean((focus.res && focus.res.relativeBounds) || (set.res && set.res.relativeBounds));
      clicked = await this._uiClickCentre({ ...target, relative }, bounds, displays);
      how = 'click';
    }
    await sleep(UI_FOCUS_SETTLE_MS);
    // F3-SAFE-D1 as for type_text: the keys go to the focused window, which must not be the dialog (the
    // window could not be brought to the front, or the accessibility focus did not raise it).
    await this._refuseProtectedFocus();
    const results = [found, set.res, focus.res, clicked && clicked.res];
    results.push(await this.driver.keyCombo(keys.normalizeCombo('primary+a', { platform: this.platform })));
    let typed = 'type';
    if (str === '') {
      results.push(await this.driver.keyCombo(['delete']));
      typed = 'delete';
    } else if (str.length > this.config.pasteThreshold || /[\r\n]/.test(str) || /[\uD800-\uDFFF]/.test(str)) {
      results.push(await this._paste(str, false));
      typed = 'paste';
    } else {
      results.push(await this.driver.typeText(str));
    }
    const bounds = (focus.res && focus.res.bounds) || (set.res && set.res.bounds) || target.bounds;
    const out = { ...this._uiResult('ui_set_value', target, { bounds }, displays), method: `${how}+select-all+${typed}`, chars, ...warningsOf(...results) };
    if (clicked) {
      out.logical = clicked.logical;
      out.display = clicked.display;
    }
    return out;
  }

  /**
   * Any driver.uiAction (press, focus, setValue, select, expand, collapse, scrollIntoView, showMenu)
   * as a guarded input action. ok:false results are returned as they are (the caller may click).
   * @param {{id:string, action:string, value?:any}} opts
   */
  async uiAction({ id, action, value } = {}) {
    this._requireUi('uiAction');
    if (!hasText(id)) throw inputError('uiAction needs an element id from uiFind or uiTree');
    return this._act(async () => async () => {
      await this._refuseProtectedUi(this._uiKnown(String(id).trim()));
      const args = { id: String(id).trim(), action };
      if (value !== undefined) args.value = value;
      const res = (await this.driver.uiAction(args)) || { ok: false, method: 'none' };
      return { ...res, action: `ui_${action || 'press'}`, id: res.id || args.id };
    });
  }

  // ------------------------------------------------------------ queries

  /**
   * Mouse position in screenshot space of the display it is on.
   * @returns {Promise<{x:number|null,y:number|null,display:number|null,logical:{x:number,y:number}}>}
   */
  async cursorPosition() {
    const displays = await this._getDisplays();
    const pos = await this.driver.cursorPosition();
    const logical = { x: pos.x, y: pos.y };
    // estimated: the driver could not read the pointer (Wayland) and reports where Claude last put it.
    const est = pos.estimated === true ? { estimated: true } : {};
    const idx = displayAt(displays, pos.x, pos.y);
    if (idx < 0) return { x: null, y: null, display: null, logical, ...est };
    const m = this._mapping(idx);
    const s = this.toShot(idx, pos.x, pos.y);
    if (m.identity) return { ...s, display: idx, logical, ...est };
    return {
      x: Math.min(m.shotW - 1, Math.max(0, s.x)),
      y: Math.min(m.shotH - 1, Math.max(0, s.y)),
      display: idx,
      logical,
      ...est,
    };
  }

  /**
   * Displays (logical geometry) and the last screenshot size of each.
   * @returns {Promise<{displays:object[], lastShot:object|null}>}
   */
  async screenInfo() {
    const displays = await this._getDisplays(true);
    const store = this._readStore();
    const shotOf = (i) => {
      const g = this._geometry(i, store);
      if (!g) return null;
      return { width: g.shot.width, height: g.shot.height, scale: g.display.width / g.shot.width, ts: g.ts || null };
    };
    const list = displays.map((d, i) => ({ ...d, lastShot: shotOf(i) }));
    const last = Number.isInteger(store.lastDisplay) ? store.lastDisplay : null;
    const ls = last != null ? shotOf(last) : null;
    return { displays: list, lastShot: ls ? { display: last, ...ls } : null };
  }
}

module.exports = { Computer, DEFAULT_CONFIG };
