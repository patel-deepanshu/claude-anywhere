'use strict';

/**
 * Picks and caches the desktop driver for this OS:
 * darwin | win32 (also WSL) | linux (x11/wayland) | unsupported | mock.
 *
 * Backends are loaded lazily so a broken or missing backend degrades to an
 * "unsupported" driver (with the load error in its hint) instead of crashing.
 * A start-up failure a retry may fix (a timed-out PowerShell host) is not cached.
 */

const platform = require('../shared/platform');
const { createLogger } = require('../shared/log');
const png = require('./png');

const log = createLogger('os');

const DRIVER_METHODS = [
  'displays', 'captureDisplay', 'cursorPosition', 'moveMouse', 'click', 'mouseDown', 'mouseUp', 'drag', 'scroll',
  'typeText', 'keyCombo', 'listWindows', 'activeWindow', 'focusWindow', 'minimizeWindow', 'setTopmost',
  'clipboardGet', 'clipboardSet',
  // UI automation (accessibility) and window geometry: docs/ARCHITECTURE.md §4
  'uiTree', 'uiFind', 'uiAction', 'setWindowBounds',
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
        ui: false,
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

/**
 * The accessibility tree of each mock window, by window id (createMockDriver opts.ui overrides it).
 * Nodes: {role, name, value?, description?, bounds:{x,y,width,height} (logical global), enabled?, focused?,
 * selected?, checked?, expanded?, editable?, actions?:string[] (default by role; [] = no accessibility
 * action), children?}. The mock Chrome window shows a Jira-like "Your work" page.
 */
const MOCK_UI = {
  '0x1001': {
    role: 'window', name: 'claude-anywhere - Visual Studio Code', bounds: { x: 0, y: 0, width: 1920, height: 1050 },
    children: [
      { role: 'menu', name: 'Application menu', bounds: { x: 0, y: 0, width: 400, height: 30 }, children: [
        { role: 'menuitem', name: 'File', bounds: { x: 10, y: 4, width: 40, height: 22 }, expanded: false },
        { role: 'menuitem', name: 'Edit', bounds: { x: 56, y: 4, width: 40, height: 22 }, expanded: false },
      ] },
      { role: 'group', name: '', bounds: { x: 0, y: 30, width: 1920, height: 1020 }, children: [
        { role: 'button', name: 'Run and Debug', bounds: { x: 8, y: 200, width: 32, height: 32 } },
        { role: 'textbox', name: 'Editor', value: '', editable: true, bounds: { x: 300, y: 80, width: 1500, height: 900 } },
      ] },
    ],
  },
  '0x1002': {
    role: 'window', name: 'Cloud Run - My Project - Google Cloud console - Google Chrome', bounds: { x: 1920, y: 0, width: 1280, height: 1000 },
    children: [
      { role: 'toolbar', name: '', bounds: { x: 1920, y: 40, width: 1280, height: 40 }, children: [
        { role: 'button', name: 'Back', bounds: { x: 1926, y: 44, width: 32, height: 32 } },
        { role: 'textbox', name: 'Address and search bar', value: 'https://acme.atlassian.net/jira/your-work', editable: true, bounds: { x: 2050, y: 46, width: 900, height: 28 } },
        { role: 'button', name: 'Bookmark this tab', bounds: { x: 2960, y: 46, width: 28, height: 28 } },
      ] },
      { role: 'group', name: '', bounds: { x: 1920, y: 80, width: 1280, height: 920 }, children: [
        { role: 'heading', name: 'Your work', bounds: { x: 1950, y: 100, width: 400, height: 40 } },
        { role: 'tablist', name: 'Work views', bounds: { x: 1950, y: 160, width: 600, height: 36 }, children: [
          { role: 'tab', name: 'Worked on', selected: true, bounds: { x: 1950, y: 160, width: 110, height: 36 } },
          { role: 'tab', name: 'For you', selected: false, bounds: { x: 2070, y: 160, width: 90, height: 36 } },
          { role: 'tab', name: 'Starred', selected: false, bounds: { x: 2170, y: 160, width: 90, height: 36 } },
        ] },
        { role: 'textbox', name: 'Search', value: '', editable: true, bounds: { x: 1950, y: 220, width: 300, height: 30 } },
        { role: 'combobox', name: 'Sort by', value: 'Updated', expanded: false, bounds: { x: 2270, y: 220, width: 160, height: 30 }, children: [
          { role: 'listitem', name: 'Updated', selected: true, bounds: { x: 2270, y: 250, width: 160, height: 26 } },
          { role: 'listitem', name: 'Priority', selected: false, bounds: { x: 2270, y: 276, width: 160, height: 26 } },
        ] },
        { role: 'checkbox', name: 'Show done', checked: false, bounds: { x: 2450, y: 224, width: 110, height: 22 } },
        { role: 'heading', name: 'Recently worked on', bounds: { x: 1950, y: 280, width: 500, height: 30 } },
        { role: 'link', name: 'ABC-42 Fix login timeout', bounds: { x: 1950, y: 320, width: 260, height: 22 } },
        { role: 'link', name: 'ABC-7 Update onboarding docs', bounds: { x: 1950, y: 350, width: 280, height: 22 } },
        { role: 'other', name: 'Board canvas', actions: [], bounds: { x: 1950, y: 400, width: 600, height: 300 } },
        { role: 'button', name: 'Delete', enabled: false, bounds: { x: 2600, y: 220, width: 80, height: 30 } },
        { role: 'slider', name: 'Zoom', value: '100', bounds: { x: 2700, y: 220, width: 150, height: 20 } },
        { role: 'image', name: '', bounds: { x: 3100, y: 90, width: 40, height: 40 } },
      ] },
    ],
  },
};

/** Default accessibility actions per role in the mock tree. */
const MOCK_UI_ACTIONS = {
  button: ['press'], link: ['press'], tab: ['press', 'select'], checkbox: ['press'], radio: ['press'],
  menuitem: ['press', 'expand', 'collapse'], listitem: ['press', 'select'], treeitem: ['press', 'expand', 'collapse'],
  combobox: ['press', 'expand', 'collapse', 'setValue', 'select'], textbox: ['focus', 'setValue'], slider: ['setValue'],
};

/** The active tab of each mock browser window, by window id: {url, text, method?}. */
const MOCK_TABS = {
  '0x1002': {
    url: 'https://console.cloud.google.com/run?project=my-project',
    text: 'Cloud Run\nServices\nshop-api    us-central1    Ready\nshop-web    us-central1    Ready',
  },
};

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

function uiErr(message, code, hint) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  return err;
}

/** Deep copy of an accessibility tree map (window id -> root node). */
function cloneUi(trees) {
  const copy = (n) => ({ ...n, bounds: n.bounds ? { ...n.bounds } : undefined, children: (n.children || []).map(copy) });
  return Object.fromEntries(Object.entries(trees || {}).map(([id, root]) => [id, copy(root)]));
}

/** Whether a mock node is listed by uiTree (unnamed containers and decorative images are walked through). */
function mockListed(n) {
  const role = n.role || 'other';
  if (role === 'group' || role === 'other') return Boolean(n.name || n.value);
  if (role === 'image' || role === 'text') return Boolean(n.name);
  return true;
}

function mockUiRecord(n, windowId, path) {
  const out = { id: `mock:${windowId}:${path.join('.')}`, role: n.role || 'other', name: n.name || '' };
  if (n.value != null && n.value !== '') out.value = String(n.value);
  if (n.description) out.description = String(n.description);
  const b = n.bounds || {};
  out.bounds = { x: b.x || 0, y: b.y || 0, width: b.width || 0, height: b.height || 0 };
  out.enabled = n.enabled !== false;
  out.focused = Boolean(n.focused);
  for (const k of ['selected', 'checked', 'expanded']) if (typeof n[k] === 'boolean') out[k] = n[k];
  if (n.editable) out.editable = true;
  return out;
}

const MOCK_INTERACTIVE = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listitem', 'menuitem', 'tab', 'treeitem', 'slider', 'cell']);

/**
 * In-memory driver for tests and demos (ANYWHERE_DRIVER=mock). Records every
 * call in `driver.actions` and tracks cursor, windows, focus and clipboard in
 * `driver.state`. Pressing primary+v "pastes" the clipboard into state.typed.
 * browserTab() reads state.tabs (window id -> {url, text, method?}); method 'keyboard' (the default)
 * behaves like the Linux reader: it calls beforeInput and needs keyboard !== false.
 * uiTree/uiFind/uiAction work on state.ui (window id -> accessibility tree, see MOCK_UI; ids are
 * "mock:<window id>:<child path>"); uiAction changes it (selects tabs, toggles check boxes, sets
 * values) and appends {id, action, value?, ok} to state.uiLog. setWindowBounds moves the windows.
 * @param {{displays?:object[],windows?:object[],cursor?:{x:number,y:number},clipboard?:string,tabs?:object,ui?:object}} [opts]
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
    tabs: Object.fromEntries(Object.entries(opts.tabs || (opts.windows ? {} : MOCK_TABS)).map(([id, t]) => [id, { ...t }])),
    ui: cloneUi(opts.ui || (opts.windows ? {} : MOCK_UI)),
    uiLog: [],
    pressed: new Set(),
    typed: '',
    topmost: {},
    closed: false,
  };
  const actions = [];
  const record = (type, data = {}) => actions.push({ type, ...data, ts: Date.now() });
  const findWindow = (id) => state.windows.find((w) => String(w.id) === String(id));
  /** Window id -> bounds before maximize / fullscreen (for restore). */
  const savedBounds = new Map();

  /** The window a UI call is about (default: the focused one) and its accessibility tree. */
  const uiWindow = (windowId) => {
    const hasId = windowId != null && String(windowId).trim() !== '';
    const w = hasId ? findWindow(String(windowId).trim()) : state.windows.find((x) => x.focused);
    if (!w) {
      throw uiErr(hasId ? `Window ${windowId} is not open` : 'No window is active', 'NOT_FOUND', 'Call list_windows for the current window ids.');
    }
    const root = state.ui[w.id];
    if (!root) throw uiErr('This window is not in the accessibility tree', 'NOT_FOUND', 'Use a screenshot (or find_text) instead.');
    return { w, root };
  };
  const nodeAt = (root, path) => path.reduce((n, i) => (n && Array.isArray(n.children) ? n.children[i] || null : null), root);
  const uiSelect = (parent, node) => {
    for (const c of (parent && parent.children) || []) if (typeof c.selected === 'boolean' || c === node) c.selected = c === node;
    if (parent && parent.role === 'combobox') parent.value = node.name;
  };
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
      return { screenshot: true, mouse: true, keyboard: true, windows: true, clipboard: true, notify: true, speak: true, ui: true, notes: ['mock driver: nothing touches the real desktop'] };
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
    /**
     * Driver.browserTab: the most recently active browser window (or windowId / app), read from
     * state.tabs. Same result shape as the real backends (src/os/linux.js readBrowserTab).
     */
    async browserTab({ app, windowId, window, includeText = false, maxChars, keyboard = true, beforeInput } = {}) {
      const tabs = require('./linux');
      const { window: w, browser } = await tabs.resolveBrowserWindow(driver, { app, windowId, window });
      const tab = state.tabs[w.id] || {};
      const method = tab.method || 'keyboard';
      const usesKeys = method === 'keyboard' || includeText;
      const result = { browser: browser.name, app: w.app || browser.name, title: w.title || '', url: null, method: 'title', windowId: String(w.id), tookFocus: false };
      if (usesKeys && keyboard && typeof beforeInput === 'function') await beforeInput();
      if (tab.url && (method !== 'keyboard' || keyboard)) {
        result.url = tab.url;
        result.method = method;
      }
      if (usesKeys && keyboard) {
        result.tookFocus = !w.focused;
        result.clipboard = 'restored';
      }
      if (includeText) {
        if (keyboard && typeof tab.text === 'string') {
          const n = maxChars == null ? tabs.DEFAULT_TAB_CHARS : Math.max(1, Math.round(Number(maxChars)) || tabs.DEFAULT_TAB_CHARS);
          const clipped = tabs.clipTabText(tabs.cleanPageText(tab.text), n);
          result.text = clipped.text;
          result.truncated = clipped.truncated;
          if (clipped.truncated) result.textChars = clipped.total;
          result.textMethod = 'keyboard';
        } else {
          result.text = null;
        }
      }
      record('browserTab', { windowId: String(w.id), includeText: Boolean(includeText), keyboard: keyboard !== false });
      return result;
    },
    /** Driver.uiTree over state.ui: pre-order, unnamed containers walked through, depth = listed levels. */
    async uiTree({ windowId, depth = 6, maxNodes = 400 } = {}) {
      const { w, root } = uiWindow(windowId);
      const maxDepth = Math.max(0, Math.min(50, Math.round(Number(depth == null ? 6 : depth)) || 0));
      const maxN = Math.max(1, Math.min(5000, Math.round(Number(maxNodes == null ? 400 : maxNodes)) || 400));
      const nodes = [];
      const byId = new Map();
      let truncated = false;
      const visit = (n, path, parentId, level) => {
        if (nodes.length >= maxN) {
          truncated = true;
          return;
        }
        let pid = parentId;
        let next = level;
        if (!path.length || mockListed(n)) {
          const rec = { ...mockUiRecord(n, w.id, path), parent: parentId, children: [], depth: level };
          nodes.push(rec);
          byId.set(rec.id, rec);
          if (parentId && byId.has(parentId)) byId.get(parentId).children.push(rec.id);
          if (level >= maxDepth) {
            if (n.children && n.children.length) rec.more = true;
            return;
          }
          pid = rec.id;
          next = level + 1;
        }
        (n.children || []).forEach((c, i) => visit(c, [...path, i], pid, next));
      };
      visit(root, [], null, 0);
      record('uiTree', { windowId: String(w.id), nodes: nodes.length });
      return { window: { id: String(w.id), app: w.app, title: w.title }, nodes, truncated };
    },
    /** Driver.uiFind over state.ui (same matching and ranking as the Linux helper). */
    async uiFind({ windowId, name, role, text, exact = false, limit = 20 } = {}) {
      const L = require('./linux');
      const n = name == null ? '' : String(name).trim();
      const t = text == null ? '' : String(text).trim();
      const roles = L.uiRoleFilter(role);
      if (!n && !t && !roles) throw uiErr('uiFind needs a name, text or role to look for', 'BAD_ARGS', 'Example: { name: "Save", role: "button" }');
      const { w, root } = uiWindow(windowId);
      const max = Math.max(1, Math.min(200, Math.round(Number(limit == null ? 20 : limit)) || 20));
      const found = [];
      let order = 0;
      const visit = (node, path) => {
        const r = node.role || 'other';
        if (path.length && (!roles || roles.includes(r))) {
          const ns = n ? L.uiMatchScore(node.name, n, exact) : 0;
          const ts = t ? Math.max(L.uiMatchScore(node.name, t, exact), L.uiMatchScore(node.value, t, exact), L.uiMatchScore(node.description, t, exact)) : 0;
          if ((!n || ns) && (!t || ts)) {
            const rec = mockUiRecord(node, w.id, path);
            rec.value = rec.value || '';
            rec.windowId = String(w.id);
            rec.path = path.join('.');
            found.push({ rec, key: [-(n || t ? ns + ts : 1), MOCK_INTERACTIVE.has(r) ? 0 : 1, rec.enabled ? 0 : 1, order++] });
          }
        }
        (node.children || []).forEach((c, i) => visit(c, [...path, i]));
      };
      visit(root, []);
      found.sort((a, b) => {
        for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
        return 0;
      });
      const list = found.slice(0, max).map((f) => f.rec);
      record('uiFind', { windowId: String(w.id), name: n, role: roles ? roles.join('|') : '', text: t, found: list.length });
      return L.withMeta(list, { window: { id: String(w.id), app: w.app, title: w.title }, truncated: false, total: found.length });
    },
    /** Driver.uiAction on state.ui: tabs and list items get selected, check boxes toggle, values change. */
    async uiAction({ id, action = 'press', value } = {}) {
      const L = require('./linux');
      const m = /^mock:([^:]+):((?:\d+(?:\.\d+)*)?)$/.exec(String(id == null ? '' : id).trim());
      if (!m) throw uiErr(`Invalid UI element id ${JSON.stringify(id)}`, 'BAD_ARGS', 'Use an id returned by uiFind or uiTree.');
      const act = L.UI_ACTIONS.find((a) => a.toLowerCase() === String(action == null ? 'press' : action).trim().toLowerCase());
      if (!act) throw uiErr(`Unknown UI action "${action}"`, 'BAD_ARGS', `Use one of: ${L.UI_ACTIONS.join(', ')}.`);
      if (act === 'setValue' && value == null) throw uiErr('setValue needs a value', 'BAD_ARGS');
      const w = findWindow(m[1]);
      if (!w || !state.ui[w.id]) throw uiErr(`The window of element ${id} is closed`, 'STALE', 'Call ui_find again.');
      const root = state.ui[w.id];
      const path = m[2] ? m[2].split('.').map(Number) : [];
      const node = nodeAt(root, path);
      if (!node) throw uiErr('The element is no longer in the window (it changed or closed).', 'STALE', 'Call ui_find (or ui_tree) again for a fresh id.');
      const parent = path.length ? nodeAt(root, path.slice(0, -1)) : null;
      const role = node.role || 'other';
      const can = node.actions || MOCK_UI_ACTIONS[role] || [];
      const no = (reason) => ({ ok: false, method: 'none', reason });
      let res;
      if (node.enabled === false) {
        res = { ...no('the element is disabled'), disabled: true };
      } else if (act === 'focus') {
        const walk = (x) => {
          x.focused = x === node;
          (x.children || []).forEach(walk);
        };
        if (can.includes('focus') || can.includes('press')) {
          walk(root);
          res = { ok: true, method: 'mock:focus' };
        } else {
          res = no('the element cannot take keyboard focus');
        }
      } else if (act === 'press' || act === 'select') {
        const item = act === 'select' && value != null && String(value).trim() ? (node.children || []).find((c) => L.uiMatchScore(c.name, value) >= 2) : null;
        const target = item || node;
        const tcan = target.actions || MOCK_UI_ACTIONS[target.role || 'other'] || [];
        if (act === 'select' && value != null && String(value).trim() && !item) {
          res = no(`no option named "${value}"`);
        } else if (!tcan.includes(act) && !tcan.includes('press')) {
          res = no(`the element has no ${act === 'press' ? 'default' : 'select'} action (click it instead)`);
        } else {
          const tparent = item ? node : parent;
          if (target.role === 'tab' || target.role === 'listitem' || target.role === 'radio' || act === 'select') uiSelect(tparent, target);
          else if (target.role === 'checkbox') target.checked = !target.checked;
          else if (typeof target.expanded === 'boolean') target.expanded = !target.expanded;
          state.pressed.add(target.name);
          res = { ok: true, method: `mock:${act}` };
          if (item) res.item = item.name;
        }
      } else if (act === 'setValue') {
        const v = String(value);
        if (!can.includes('setValue')) {
          res = no('the element does not take a value through accessibility (focus it and type instead)');
        } else if (role === 'slider' && !Number.isFinite(Number(v))) {
          res = no(`"${v}" is not a number`);
        } else if (role === 'combobox' && (node.children || []).length) {
          const opt = node.children.find((c) => L.uiMatchScore(c.name, v) >= 2);
          if (opt) {
            uiSelect(node, opt);
            res = { ok: true, method: 'mock:select', item: opt.name };
          } else {
            res = no(`no option named "${v}"`);
          }
        } else {
          node.value = v;
          res = { ok: true, method: 'mock:setValue' };
        }
      } else if (act === 'expand' || act === 'collapse') {
        if (typeof node.expanded !== 'boolean') {
          res = no('the element cannot be expanded');
        } else {
          node.expanded = act === 'expand';
          res = { ok: true, method: `mock:${act}` };
        }
      } else if (act === 'scrollIntoView') {
        res = { ok: true, method: 'mock:scrollIntoView' };
      } else {
        res = no('the element has no menu action');
      }
      res.role = role;
      res.name = node.name || '';
      res.bounds = mockUiRecord(node, w.id, path).bounds;
      state.uiLog.push({ id: String(id), action: act, ...(value != null ? { value } : {}), ok: res.ok });
      record('uiAction', { id: String(id), action: act, ok: res.ok });
      return res;
    },
    /** Driver.setWindowBounds: move/resize, or maximize/fullscreen (to the window's display), minimize, restore. */
    async setWindowBounds(windowId, spec) {
      const s = require('./linux').parseBoundsSpec(spec);
      const raw = windowId && typeof windowId === 'object' && windowId.id != null ? windowId.id : windowId;
      const w = findWindow(raw);
      record('setWindowBounds', { id: raw, ...s, ok: Boolean(w) });
      if (!w) return false;
      const rect = (x) => ({ x: x.x, y: x.y, width: x.width, height: x.height });
      if (s.state === 'minimize') {
        w.minimized = true;
        w.focused = false;
      } else if (s.state === 'maximize' || s.state === 'fullscreen') {
        if (!savedBounds.has(w.id)) savedBounds.set(w.id, rect(w));
        const cx = w.x + w.width / 2;
        const cy = w.y + w.height / 2;
        const d = displays.find((x) => cx >= x.x && cx < x.x + x.width && cy >= x.y && cy < x.y + x.height) || displays[0];
        Object.assign(w, rect(d), { minimized: false });
      } else if (s.state === 'restore') {
        if (savedBounds.has(w.id)) Object.assign(w, savedBounds.get(w.id));
        savedBounds.delete(w.id);
        w.minimized = false;
      } else {
        savedBounds.delete(w.id);
        Object.assign(w, s, { minimized: false });
      }
      return true;
    },
    async close() {
      state.closed = true;
      record('close');
    },
  };
  return driver;
}

// ---------------------------------------------------------------- selection

// Start-up failures that a later attempt may not repeat: a first PowerShell start slowed by
// antivirus (TIMEOUT), a host that exited while its files were locked (HOST_EXITED), or a host
// that kept exiting for a while (HOST_CRASH_LOOP). They reject instead of becoming a cached
// unsupported driver, so callers can try again.
const TRANSIENT_LOAD_CODES = new Set(['TIMEOUT', 'HOST_EXITED', 'HOST_CRASH_LOOP']);
// How long a transient failure is reused before getDriver() tries to load the driver again,
// so a burst of actions does not start a new host each.
const LOAD_RETRY_MS = 5000;

let driverPromise = null;
let driverRetryAt = 0;

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
    if (err && TRANSIENT_LOAD_CODES.has(err.code)) {
      const e = new Error(`the ${sel.backend} desktop driver did not start (${err.message}); it is started again on a later action`);
      e.code = err.code;
      e.hint = err.hint || 'Run "anywhere doctor" to check the required system tools.';
      e.transient = true;
      e.cause = err;
      throw e;
    }
    const extra = err && err.hint ? ` ${err.hint}` : '';
    return createUnsupportedDriver({
      reason: `the ${sel.backend} driver failed to load (${err && err.message})`,
      hint: `Run "anywhere doctor" to check the required system tools.${extra}`,
    });
  }
}

/**
 * The desktop driver for this machine (cached singleton). Rejects (err.transient)
 * when the backend failed to start in a way a retry may fix; the next call after
 * LOAD_RETRY_MS loads it again. Permanent failures resolve to an unsupported driver.
 * @returns {Promise<object>} Driver
 */
function getDriver() {
  if (driverPromise && driverRetryAt && Date.now() >= driverRetryAt) {
    driverPromise = null;
    driverRetryAt = 0;
  }
  if (!driverPromise) {
    const p = loadDriver();
    driverPromise = p;
    driverRetryAt = 0;
    p.catch(() => {
      if (driverPromise === p) driverRetryAt = Date.now() + LOAD_RETRY_MS;
    });
  }
  return driverPromise;
}

/**
 * Forget the cached driver (closing it). For tests and after config changes.
 * @returns {Promise<void>}
 */
function resetDriver() {
  const prev = driverPromise;
  driverPromise = null;
  driverRetryAt = 0;
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
  LOAD_RETRY_MS,
};
