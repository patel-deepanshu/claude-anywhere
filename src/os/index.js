'use strict';

/**
 * Picks and caches the desktop driver for this OS:
 * darwin | win32 (also WSL) | linux (x11/wayland) | unsupported | mock.
 *
 * Backends are loaded lazily so a broken or missing backend degrades to an
 * "unsupported" driver (with the load error in its hint) instead of crashing.
 */

const platform = require('../shared/platform');
const { createLogger } = require('../shared/log');
const png = require('./png');

const log = createLogger('os');

const DRIVER_METHODS = [
  'displays', 'captureDisplay', 'cursorPosition', 'moveMouse', 'click', 'mouseDown', 'mouseUp', 'drag', 'scroll',
  'typeText', 'keyCombo', 'listWindows', 'activeWindow', 'focusWindow', 'minimizeWindow', 'setTopmost',
  'clipboardGet', 'clipboardSet',
];

/**
 * Build an Error with .code = 'UNSUPPORTED' and an actionable .hint.
 * @param {string} message
 * @param {string} [hint]
 */
function unsupportedError(message, hint) {
  const err = new Error(message);
  err.code = 'UNSUPPORTED';
  if (hint) err.hint = hint;
  return err;
}

function headlessHint() {
  return (
    'No graphical display was detected (DISPLAY and WAYLAND_DISPLAY are unset). Run Claude Anywhere inside your ' +
    'desktop session, or start a virtual display: Xvfb :99 -screen 0 1920x1080x24 & export DISPLAY=:99'
  );
}

/**
 * Decide which backend to use. Pure function of platform info and env, so it
 * is easy to test. ANYWHERE_DRIVER may force a backend: mock, darwin, win32,
 * wsl, linux, x11, wayland or none.
 * @param {object} [info] platform.info()
 * @param {object} [env] process.env
 * @returns {{backend:'mock'|'darwin'|'win32'|'linux'|'unsupported', module?:string, opts?:object, reason?:string, hint?:string}}
 */
function selectBackend(info = platform.info(), env = process.env) {
  const forced = String(env.ANYWHERE_DRIVER || '').trim().toLowerCase();
  if (forced && forced !== 'auto') {
    switch (forced) {
      case 'mock':
        return { backend: 'mock' };
      case 'darwin':
      case 'mac':
      case 'macos':
        return { backend: 'darwin', module: './darwin', opts: {} };
      case 'win32':
      case 'windows':
        return { backend: 'win32', module: './win32', opts: { wsl: Boolean(info.isWSL) } };
      case 'wsl':
        return { backend: 'win32', module: './win32', opts: { wsl: true } };
      case 'x11':
      case 'wayland':
        return { backend: 'linux', module: './linux', opts: { displayServer: forced } };
      case 'linux':
        return {
          backend: 'linux',
          module: './linux',
          opts: { displayServer: info.displayServer === 'wayland' ? 'wayland' : 'x11' },
        };
      case 'none':
      case 'unsupported':
        return { backend: 'unsupported', reason: 'desktop control is disabled (ANYWHERE_DRIVER=none)', hint: 'Unset ANYWHERE_DRIVER to enable it.' };
      default:
        return {
          backend: 'unsupported',
          reason: `unknown ANYWHERE_DRIVER "${forced}"`,
          hint: 'Set ANYWHERE_DRIVER to one of auto, mock, darwin, win32, wsl, linux, x11, wayland, none (or unset it).',
        };
    }
  }
  if (info.platform === 'darwin') return { backend: 'darwin', module: './darwin', opts: {} };
  if (info.platform === 'win32' || info.isWSL) return { backend: 'win32', module: './win32', opts: { wsl: Boolean(info.isWSL) } };
  if (info.platform === 'linux' && (info.displayServer === 'x11' || info.displayServer === 'wayland')) {
    return { backend: 'linux', module: './linux', opts: { displayServer: info.displayServer } };
  }
  if (info.platform === 'linux') return { backend: 'unsupported', reason: 'no graphical display', hint: headlessHint() };
  return { backend: 'unsupported', reason: `platform ${info.platform} is not supported`, hint: 'Claude Anywhere supports macOS, Windows, WSL and Linux (X11 or Wayland).' };
}

/**
 * A driver whose input/screen methods all throw UNSUPPORTED with a hint.
 * capabilities() and close() never throw.
 * @param {{reason?:string,hint?:string}} [opts]
 */
function createUnsupportedDriver({ reason = 'desktop control is unavailable', hint = '' } = {}) {
  const driver = {
    name: 'unsupported',
    reason,
    hint,
    async capabilities() {
      return {
        screenshot: false,
        mouse: false,
        keyboard: false,
        windows: false,
        clipboard: false,
        notify: false,
        speak: false,
        notes: [`Desktop control unavailable: ${reason}`, hint].filter(Boolean),
      };
    },
    async close() {},
  };
  for (const m of DRIVER_METHODS) {
    driver[m] = async () => {
      throw unsupportedError(`${m} is not available: ${reason}`, hint);
    };
  }
  return driver;
}

// ---------------------------------------------------------------- mock driver

const MOCK_DISPLAYS = [
  { id: 1, x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
  { id: 2, x: 1920, y: 0, width: 1280, height: 1024, scale: 1 },
];

const MOCK_WINDOWS = [
  { id: '0x1001', app: 'Code', title: 'claude-anywhere - Visual Studio Code', pid: 4101, x: 0, y: 0, width: 1920, height: 1050, focused: true, minimized: false },
  { id: '0x1002', app: 'Google Chrome', title: 'Cloud Run - My Project - Google Cloud console - Google Chrome', pid: 4102, x: 1920, y: 0, width: 1280, height: 1000, focused: false, minimized: false },
  { id: '0x1003', app: 'Terminal', title: 'bash - ~/claude-anywhere', pid: 4103, x: 200, y: 200, width: 900, height: 600, focused: false, minimized: false },
];

function finite(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`mock driver: ${name} must be a finite number (got ${v})`);
  return n;
}

/** Gradient test pattern with a marker square at (mx, my) (native px, or null). */
function testPattern(w, h, index, mx, my, markSize) {
  const data = new Uint8Array(w * h * 4);
  const blue = (64 + index * 128) & 255;
  const rx = w > 1 ? 255 / (w - 1) : 0;
  const ry = h > 1 ? 255 / (h - 1) : 0;
  for (let y = 0; y < h; y++) {
    const g = Math.round(y * ry);
    let o = y * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
      data[o] = Math.round(x * rx);
      data[o + 1] = g;
      data[o + 2] = blue;
      data[o + 3] = 255;
    }
  }
  if (mx != null) {
    const half = Math.floor(markSize / 2);
    for (let y = Math.max(0, my - half); y <= Math.min(h - 1, my + half); y++) {
      for (let x = Math.max(0, mx - half); x <= Math.min(w - 1, mx + half); x++) {
        const o = (y * w + x) * 4;
        data[o] = 255;
        data[o + 1] = 0;
        data[o + 2] = 255;
        data[o + 3] = 255;
      }
    }
  }
  return { width: w, height: h, data };
}

/**
 * In-memory driver for tests and demos (ANYWHERE_DRIVER=mock). Records every
 * call in `driver.actions` and tracks cursor, windows, focus and clipboard in
 * `driver.state`. Pressing primary+v "pastes" the clipboard into state.typed.
 * @param {{displays?:object[],windows?:object[],cursor?:{x:number,y:number},clipboard?:string}} [opts]
 */
function createMockDriver(opts = {}) {
  const displays = (opts.displays || MOCK_DISPLAYS).map((d, i) => ({
    index: i,
    id: d.id != null ? d.id : i + 1,
    x: d.x || 0,
    y: d.y || 0,
    width: d.width,
    height: d.height,
    scale: d.scale || 1,
    primary: i === 0,
  }));
  const state = {
    cursor: opts.cursor ? { x: opts.cursor.x, y: opts.cursor.y } : { x: 960, y: 540 },
    clipboard: opts.clipboard != null ? String(opts.clipboard) : '',
    windows: (opts.windows || MOCK_WINDOWS).map((w) => ({ ...w })),
    pressed: new Set(),
    typed: '',
    topmost: {},
    closed: false,
  };
  const actions = [];
  const record = (type, data = {}) => actions.push({ type, ...data, ts: Date.now() });
  const findWindow = (id) => state.windows.find((w) => String(w.id) === String(id));
  const checkButton = (b) => {
    if (!['left', 'right', 'middle'].includes(b)) throw new TypeError(`mock driver: bad button ${b}`);
    return b;
  };

  const driver = {
    name: 'mock',
    actions,
    state,
    /** Simulate the user moving the mouse (not recorded as an action). */
    setCursor(x, y) {
      state.cursor = { x: finite(x, 'x'), y: finite(y, 'y') };
    },
    async capabilities() {
      return { screenshot: true, mouse: true, keyboard: true, windows: true, clipboard: true, notify: true, speak: true, notes: ['mock driver: nothing touches the real desktop'] };
    },
    async displays() {
      return displays.map((d) => ({ ...d }));
    },
    async captureDisplay(index) {
      const d = displays[index];
      if (!d) throw new RangeError(`mock driver: display ${index} does not exist`);
      const w = Math.round(d.width * d.scale);
      const h = Math.round(d.height * d.scale);
      const c = state.cursor;
      const onDisplay = c.x >= d.x && c.x < d.x + d.width && c.y >= d.y && c.y < d.y + d.height;
      const mx = onDisplay ? Math.floor((c.x - d.x) * d.scale) : null;
      const my = onDisplay ? Math.floor((c.y - d.y) * d.scale) : null;
      record('captureDisplay', { index });
      const img = testPattern(w, h, index, mx, my, Math.max(5, Math.round(11 * d.scale)));
      return { png: png.encode(img, { level: 1 }), width: w, height: h };
    },
    async cursorPosition() {
      return { ...state.cursor };
    },
    async moveMouse(x, y) {
      state.cursor = { x: finite(x, 'x'), y: finite(y, 'y') };
      record('moveMouse', { x, y });
    },
    async click(x, y, { button = 'left', clicks = 1, modifiers = [] } = {}) {
      state.cursor = { x: finite(x, 'x'), y: finite(y, 'y') };
      record('click', { x, y, button: checkButton(button), clicks, modifiers: [...modifiers] });
    },
    async mouseDown(button = 'left') {
      state.pressed.add(checkButton(button));
      record('mouseDown', { button });
    },
    async mouseUp(button = 'left') {
      state.pressed.delete(checkButton(button));
      record('mouseUp', { button });
    },
    async drag(x1, y1, x2, y2, { button = 'left' } = {}) {
      finite(x1, 'x1');
      finite(y1, 'y1');
      state.cursor = { x: finite(x2, 'x2'), y: finite(y2, 'y2') };
      record('drag', { x1, y1, x2, y2, button: checkButton(button) });
    },
    async scroll(x, y, dx, dy) {
      state.cursor = { x: finite(x, 'x'), y: finite(y, 'y') };
      record('scroll', { x, y, dx, dy });
    },
    async typeText(text) {
      state.typed += String(text);
      record('typeText', { text: String(text) });
    },
    async keyCombo(keys) {
      const list = [...keys];
      const paste = list.includes('v') && (list.includes('ctrl') || list.includes('meta'));
      if (paste) state.typed += state.clipboard;
      record('keyCombo', paste ? { keys: list, pasted: state.clipboard } : { keys: list });
    },
    async listWindows() {
      return state.windows.map((w) => ({ ...w }));
    },
    async activeWindow() {
      const w = state.windows.find((x) => x.focused);
      return w ? { id: w.id, app: w.app, title: w.title, pid: w.pid } : null;
    },
    async focusWindow(id) {
      const w = findWindow(id);
      record('focusWindow', { id, ok: Boolean(w) });
      if (!w) return false;
      for (const x of state.windows) x.focused = false;
      w.focused = true;
      w.minimized = false;
      return true;
    },
    async minimizeWindow(id) {
      const w = findWindow(id);
      record('minimizeWindow', { id, ok: Boolean(w) });
      if (!w) return false;
      w.minimized = true;
      w.focused = false;
      return true;
    },
    async setTopmost(id, on) {
      const w = findWindow(id);
      record('setTopmost', { id, on: Boolean(on), ok: Boolean(w) });
      if (!w) return false;
      state.topmost[w.id] = Boolean(on);
      return true;
    },
    async clipboardGet() {
      record('clipboardGet');
      return state.clipboard;
    },
    async clipboardSet(text) {
      state.clipboard = String(text);
      record('clipboardSet', { text: String(text) });
    },
    async close() {
      state.closed = true;
      record('close');
    },
  };
  return driver;
}

// ---------------------------------------------------------------- selection

let driverPromise = null;

async function loadDriver() {
  const sel = selectBackend();
  if (sel.backend === 'mock') return createMockDriver();
  if (sel.backend === 'unsupported') return createUnsupportedDriver(sel);
  try {
    const mod = require(sel.module);
    if (!mod || typeof mod.createDriver !== 'function') {
      throw new Error(`src/os/${sel.module.slice(2)}.js does not export createDriver()`);
    }
    const driver = await mod.createDriver(sel.opts);
    if (!driver || typeof driver !== 'object') throw new Error('createDriver() returned no driver');
    return driver;
  } catch (err) {
    log.warn(`the ${sel.backend} desktop driver failed to load:`, err && err.message);
    const extra = err && err.hint ? ` ${err.hint}` : '';
    return createUnsupportedDriver({
      reason: `the ${sel.backend} driver failed to load (${err && err.message})`,
      hint: `Run "anywhere doctor" to check the required system tools.${extra}`,
    });
  }
}

/**
 * The desktop driver for this machine (cached singleton).
 * @returns {Promise<object>} Driver
 */
function getDriver() {
  if (!driverPromise) driverPromise = loadDriver();
  return driverPromise;
}

/**
 * Forget the cached driver (closing it). For tests and after config changes.
 * @returns {Promise<void>}
 */
function resetDriver() {
  const prev = driverPromise;
  driverPromise = null;
  if (!prev) return Promise.resolve();
  return prev
    .then((d) => (d && typeof d.close === 'function' ? d.close() : undefined))
    .then(() => undefined)
    .catch(() => undefined);
}

module.exports = {
  getDriver,
  resetDriver,
  selectBackend,
  createMockDriver,
  createUnsupportedDriver,
  unsupportedError,
  DRIVER_METHODS,
};
