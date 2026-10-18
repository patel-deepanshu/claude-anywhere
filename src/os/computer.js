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
   *   geometryStore?:'memory'|'file', platform?:string}} opts
   */
  constructor({ driver, config, guard, geometryStore = 'memory', platform: plat } = {}) {
    if (!driver || typeof driver !== 'object') throw new TypeError('Computer needs a driver (see src/os/index.js getDriver())');
    if (geometryStore !== 'memory' && geometryStore !== 'file') {
      throw new TypeError(`geometryStore must be 'memory' or 'file' (got ${JSON.stringify(geometryStore)})`);
    }
    this.driver = driver;
    this.config = normalizeConfig(config);
    this.guard = typeof guard === 'function' ? guard : null;
    this.geometryStore = geometryStore;
    this.platform = plat || platform.info().platform;
    this._mem = emptyStore();
    this._displays = null;
    this._displaysAt = 0;
    this._queue = Promise.resolve();
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
    return this._act(async () => async () => {
      const results = [];
      for (let i = 0; i < n; i++) {
        if (i) await sleep(REPEAT_GAP_MS);
        results.push(await this.driver.keyCombo(list));
      }
      return { ok: true, action: 'key', keys: list, repeat: n, ...warningsOf(...results) };
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
