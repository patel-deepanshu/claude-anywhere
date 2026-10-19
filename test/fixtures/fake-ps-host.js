#!/usr/bin/env node
'use strict';

/**
 * Emulates src/os/win32-host.ps1's JSON-lines protocol for tests, so the
 * Windows driver's transport can be exercised on any OS.
 *
 * Behaviour switches (environment variables):
 *   FAKE_PS_LOG=<file>          append every request as a JSON line (survives restarts)
 *   FAKE_PS_STATE=<file>        JSON state shared across restarts ({launches})
 *   FAKE_PS_HANG=a,b            never answer these commands
 *   FAKE_PS_CRASH_ON=a,b        exit(9) when one of these commands arrives
 *   FAKE_PS_CRASH_ONCE=1        with FAKE_PS_STATE: crash only during the first launch
 *   FAKE_PS_EXIT_ON_START=<n>   write FAKE_PS_STDERR (or a default) to stderr and exit(n) at once
 *   FAKE_PS_STDERR=<text>       text written to stderr at startup
 *   FAKE_PS_NOISE=1             emit non-protocol lines and stale ids before each response
 *   FAKE_PS_DELAY_MS=<n>        delay every response
 *   FAKE_PS_START_DELAY_MS=<n>  delay before reading stdin
 *   FAKE_PS_BROWSER_TABS=<json> browsertab results by hwnd ({"1002": {found, url, title, name, editing}});
 *                               the default reads Chrome's (1002) address bar without the scheme
 *   FAKE_PS_NO_UIA=1            uiinfo reports UI Automation as unavailable
 * Extra commands: __requests (requests seen by this process), __crash, __stderr {text},
 *   __uilog (UI actions performed), __uimutate {id, name} (rename an element: its id goes stale).
 *
 * UI Automation (uiinfo, uitree, uifind, uiaction) works on a small fixed tree per window with the
 * real host's id format ("<hwnd>.<path>~<tag>", tag = AnywhereNative.UiTag); winbounds moves,
 * resizes, maximizes, minimizes and restores the fake windows (elevated ones refuse).
 *
 * Like the real host, input aimed at an elevated window (the focused window for type/keys, else
 * the window under the point; the focused window is on top) fails with UIPI_BLOCKED, and input
 * aimed at another account's window (elevated: null) succeeds with a warning.
 */

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');

const env = process.env;
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const HANG = new Set(list(env.FAKE_PS_HANG));
const CRASH_ON = new Set(list(env.FAKE_PS_CRASH_ON));
const DELAY = Number(env.FAKE_PS_DELAY_MS) || 0;

function readState() {
  if (!env.FAKE_PS_STATE) return { launches: 0 };
  try {
    return JSON.parse(fs.readFileSync(env.FAKE_PS_STATE, 'utf8'));
  } catch {
    return { launches: 0 };
  }
}

const state = readState();
state.launches = (state.launches || 0) + 1;
if (env.FAKE_PS_STATE) fs.writeFileSync(env.FAKE_PS_STATE, JSON.stringify(state));
const crashEnabled = !(env.FAKE_PS_CRASH_ONCE === '1' && state.launches > 1);

if (env.FAKE_PS_STDERR) process.stderr.write(`${env.FAKE_PS_STDERR}\n`);
if (env.FAKE_PS_EXIT_ON_START) {
  if (!env.FAKE_PS_STDERR) process.stderr.write('fake host: failing at startup\n');
  process.exit(Number(env.FAKE_PS_EXIT_ON_START) || 1);
}

// ---------------------------------------------------------------- tiny PNG encoder

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 24-bit RGB PNG with a horizontal gradient tinted per display. */
function makePng(width, height, tint) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 3;
      raw[o] = Math.round((x / Math.max(1, width - 1)) * 255);
      raw[o + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      raw[o + 2] = tint;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- fake desktop

const displays = [
  { index: 0, id: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 64, height: 40, scale: 1, dpiScale: 1.5, primary: true },
  { index: 1, id: '\\\\.\\DISPLAY2', x: 64, y: 0, width: 32, height: 24, scale: 1, dpiScale: 1, primary: false },
];
const desk = {
  cursor: { x: 10, y: 10 },
  clipboard: '',
  focused: '1001',
  windows: [
    { hwnd: '1001', app: 'Visual Studio Code', process: 'Code.exe', title: 'claude-anywhere - Visual Studio Code', pid: 4101, x: 0, y: 0, width: 60, height: 38, minimized: false, elevated: false, className: 'Chrome_WidgetWin_1' },
    { hwnd: '1002', app: 'Google Chrome', process: 'chrome.exe', title: 'Cloud Run - Google Cloud console - Google Chrome', pid: 4102, x: 64, y: 0, width: 32, height: 24, minimized: false, elevated: false, className: 'Chrome_WidgetWin_1' },
    { hwnd: '1003', app: 'Task Manager', process: 'Taskmgr.exe', title: 'Task Manager', pid: 4103, x: 5, y: 5, width: 20, height: 20, minimized: false, elevated: true, className: 'TaskManagerWindow' },
    // Started with an administrator's credentials: another account, so its elevation is unknown.
    { hwnd: '1004', app: '', process: '', title: 'Contoso Setup', pid: 4104, x: 30, y: 20, width: 20, height: 15, minimized: false, elevated: null, className: '#32770' },
  ],
  topmost: {},
};
const requests = [];

function fail(message, code, hint) {
  const err = new Error(message);
  err.code = code;
  err.hint = hint;
  return err;
}

function findWindow(hwnd) {
  return desk.windows.find((w) => w.hwnd === String(hwnd));
}

function windowOut(w) {
  return { ...w, focused: w.hwnd === desk.focused };
}

function windowAt(x, y) {
  const order = [findWindow(desk.focused), ...desk.windows.filter((w) => w.hwnd !== desk.focused)];
  return order.find((w) => w && !w.minimized && x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height) || null;
}

/** Mirror of Confirm-InputTarget in win32-host.ps1: throws or returns a warnings list. */
function checkInput(w) {
  if (!w || w.elevated === false) return [];
  const name = `${w.title} (${w.process || `pid ${w.pid}`})`;
  if (w.elevated) {
    throw fail(`Windows blocks input to '${name}' because it runs as administrator and Claude Anywhere does not.`, 'UIPI_BLOCKED', 'Interact with that window yourself.');
  }
  return [`'${name}' belongs to another user account, so Claude Anywhere cannot tell whether it runs as administrator. If nothing happened, it probably does and Windows (UIPI) silently dropped the input: ask the user to do this step in that window themselves.`];
}

function withWarnings(result, warnings) {
  return warnings.length ? { ...result, warnings } : result;
}

function num(args, name, dflt) {
  const v = args && args[name] != null ? args[name] : dflt;
  if (v == null || !Number.isFinite(Number(v))) throw fail(`Missing numeric argument '${name}'.`, 'BAD_ARGS');
  return Math.round(Number(v));
}

// ---------------------------------------------------------------- fake UI Automation

/** AnywhereNative.UiTag: FNV-1a over role + "\n" + the lowercased name, as two base-36 digits. */
function uiTag(role, name) {
  const s = `${role}\n${String(name || '').toLowerCase()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const n = h % 1296;
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
  return digits[Math.floor(n / 36)] + digits[n % 36];
}

/** An element: actions lists what it supports (invoke, toggle, select, expand, value, range, scroll, focus). */
function el(role, name, opts = {}, children = []) {
  return { role, name, enabled: true, actions: [], ...opts, children };
}

const uiTrees = {
  '1001': el('window', 'claude-anywhere - Visual Studio Code', {}, [
    el('toolbar', 'Activity Bar', {}, [
      el('tab', 'Explorer', { actions: ['select', 'focus'], selected: true }),
      el('tab', 'Search', { actions: ['select', 'focus'], selected: false }),
    ]),
    el('textbox', 'Editor content', { value: 'const x = 1;', actions: ['value', 'focus'], focused: true }),
  ]),
  '1002': el('window', 'Cloud Run - Google Cloud console - Google Chrome', {}, [
    el('toolbar', 'Navigation', {}, [
      el('button', 'Back', { actions: ['invoke', 'focus'] }),
      el('button', 'Reload', { actions: ['invoke', 'focus'] }),
      el('textbox', 'Address and search bar', { value: 'console.cloud.google.com/run', actions: ['value', 'focus'] }),
    ]),
    el('group', 'Cloud Run - Google Cloud console', { value: 'https://console.cloud.google.com/run' }, [
      el('heading', 'Your work'),
      el('tablist', 'Work tabs', {}, [
        el('tab', 'For you', { actions: ['select', 'focus'], selected: false }),
        el('tab', 'Recent', { actions: ['select', 'focus'], selected: true }),
      ]),
      el('link', 'ABC-123 Fix login timeout', { actions: ['invoke', 'focus', 'scroll'] }),
      el('link', 'ABC-124 Login page copy', { actions: ['invoke', 'focus', 'scroll'], offscreen: true }),
      el('checkbox', 'Remember me', { actions: ['toggle', 'focus'], checked: false }),
      el('combobox', 'Region', { value: 'us-central1', actions: ['expand', 'value', 'focus'], expanded: false }, [
        el('listitem', 'us-central1', { actions: ['select'], selected: true }),
        el('listitem', 'europe-west1', { actions: ['select'], selected: false }),
      ]),
      el('button', 'Deploy', { actions: ['invoke', 'focus'], enabled: false, description: 'Deploy a new revision' }),
      el('textbox', 'Password', { password: true, actions: ['value', 'focus'] }),
      el('textbox', 'Build log', { value: 'Step 1/3 done', readOnly: true, actions: ['value', 'focus'] }),
      el('slider', 'Instances', { value: '3', actions: ['range', 'focus'] }),
      el('button', 'More actions', { actions: ['expand', 'focus'], expanded: false }),
      el('text', 'Status: Ready'),
    ]),
  ]),
  '1003': el('window', 'Task Manager', {}, [el('button', 'End task', { actions: ['invoke'] })]),
  '1004': el('window', 'Contoso Setup', {}, [
    el('button', 'Next', { actions: ['invoke', 'focus'] }),
    el('button', 'Cancel', { actions: ['invoke', 'focus'] }),
  ]),
};
const uiLog = [];
const savedBounds = {};

function uiId(hwnd, path, n) {
  return `${hwnd}${path ? `.${path}` : ''}~${uiTag(n.role, n.name)}`;
}

/** Every element of a window in breadth-first order: {n, path, depth, parent (entry)}. */
function uiEntries(hwnd) {
  const root = uiTrees[hwnd];
  if (!root) return [];
  const out = [{ n: root, path: '', depth: 0, parent: null }];
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    e.n.children.forEach((c, k) => out.push({ n: c, path: e.path ? `${e.path}.${k}` : String(k), depth: e.depth + 1, parent: e }));
  }
  return out;
}

function uiBounds(w, e, index) {
  if (e.n.offscreen) return { x: w.x, y: w.y + w.height + 50, width: 3, height: 2 };
  if (!e.parent) return { x: w.x, y: w.y, width: w.width, height: w.height };
  return { x: w.x + Math.min(w.width - 4, 1 + (index % 8) * 3), y: w.y + Math.min(w.height - 3, 1 + e.depth * 3), width: 3, height: 2 };
}

/** The real host's node fields (Add-UiState in win32-host.ps1). */
function uiNode(w, e, index) {
  const n = e.n;
  const out = { id: uiId(w.hwnd, e.path, n), role: n.role, name: n.name };
  if (n.value != null && !n.password) out.value = String(n.value);
  if (n.description) out.description = n.description;
  out.bounds = uiBounds(w, e, index);
  out.enabled = n.enabled !== false;
  out.focused = Boolean(n.focused);
  if (typeof n.selected === 'boolean') out.selected = n.selected;
  else if (typeof n.checked === 'boolean') out.selected = n.checked;
  if (typeof n.checked === 'boolean') out.checked = n.checked;
  if (typeof n.expanded === 'boolean') out.expanded = n.expanded;
  if (n.offscreen) out.offscreen = true;
  return out;
}

function uiWindow(a) {
  const hwnd = a && a.hwnd != null && a.hwnd !== '' ? String(a.hwnd) : desk.focused;
  const w = findWindow(hwnd);
  if (!w || !uiTrees[w.hwnd]) throw fail(`Window ${hwnd} does not exist.`, 'NOT_FOUND', 'The window may have closed; list the windows again.');
  return w;
}

function uiLabel(n) {
  return n.name ? `${n.role} "${n.name.length > 40 ? `${n.name.slice(0, 39)}...` : n.name}"` : n.role;
}

function uiMatch(hay, needle, exact) {
  const h = String(hay || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const q = String(needle || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!h || !q) return 0;
  if (h === q) return 3;
  if (exact) return 0;
  if (h.startsWith(q)) return 2;
  return h.includes(q) ? 1 : 0;
}

function uiResolve(id) {
  const m = /^(-?\d{1,20})((?:\.\d{1,6})*)(?:~([0-9a-z]{2}))?$/.exec(String(id || '').trim());
  if (!m) throw fail(`Invalid UI element id '${id}'.`, 'BAD_ARGS', 'Use an id returned by ui_find or ui_tree.');
  const w = findWindow(m[1]);
  if (!w || !uiTrees[w.hwnd]) throw fail(`UI Automation cannot read window ${m[1]}: element not available`, 'NOT_FOUND', 'The window may have closed; list the windows again.');
  const path = m[2].replace(/^\./, '');
  const e = uiEntries(w.hwnd).find((x) => x.path === path);
  const stale = () => fail(`UI element ${m[0]} is no longer there: the window changed since it was found.`, 'STALE_ELEMENT', 'Look the element up again (ui_find or ui_tree) and use the new id.');
  if (!e) throw stale();
  if (m[3] && uiTag(e.n.role, e.n.name) !== m[3]) throw stale();
  return { w, e, id: m[0] };
}

const UI_ACTION_NAMES = ['press', 'focus', 'setValue', 'select', 'expand', 'collapse', 'scrollIntoView', 'showMenu'];
const UI_ITEM_ROLES = ['listitem', 'menuitem', 'treeitem', 'tab', 'row', 'cell', 'radio', 'checkbox'];

function selectItem(e, done) {
  if (e.parent) for (const s of e.parent.n.children) if (typeof s.selected === 'boolean') s.selected = false;
  e.n.selected = true;
  return done('select');
}

/** The real host's action semantics (Invoke-UiAction in win32-host.ps1) on the fake tree. */
function uiDo(t, action, value) {
  const n = t.e.n;
  const can = (x) => n.actions.includes(x);
  const done = (method, logValue) => {
    uiLog.push(`${method}:${n.name}${logValue != null ? `=${logValue}` : ''}`);
    return { ok: true, method };
  };
  const none = (reason) => ({ ok: false, method: 'none', reason });
  if (n.enabled === false) return { ok: false, method: 'none', reason: 'The element is disabled.', disabled: true };
  switch (action) {
    case 'press':
      if (can('invoke')) return done('invoke');
      if (can('toggle')) {
        n.checked = !n.checked;
        return done('toggle');
      }
      if (can('select')) return selectItem(t.e, done);
      if (can('expand')) {
        n.expanded = !n.expanded;
        return done(n.expanded ? 'expand' : 'collapse');
      }
      return none('The element has none of the UI Automation patterns for this (invoke, toggle, select, expandToggle, legacy).');
    case 'focus':
      if (!can('focus')) return none('focus failed: The element cannot take the keyboard focus.');
      for (const x of uiEntries(t.w.hwnd)) x.n.focused = false;
      n.focused = true;
      return done('focus');
    case 'setValue':
      if (can('value') && !n.readOnly) {
        n.value = value;
        return done('value', n.password ? '***' : value);
      }
      if (can('range')) {
        if (!Number.isFinite(Number(value))) return none(`This is a range control; give a number, not '${value}'.`);
        n.value = String(Number(value));
        return done('range', n.value);
      }
      return none(n.readOnly ? 'The element is read-only.' : 'The element has no settable value (no ValuePattern).');
    case 'select': {
      if (!value) {
        if (can('select')) return selectItem(t.e, done);
        if (can('invoke')) return done('invoke');
        return none('The element has none of the UI Automation patterns for this (select, invoke).');
      }
      const prefix = t.e.path ? `${t.e.path}.` : '';
      const items = uiEntries(t.w.hwnd).filter((x) => x !== t.e && x.path.startsWith(prefix) && UI_ITEM_ROLES.includes(x.n.role));
      const best = items.map((x) => ({ x, s: uiMatch(x.n.name, value, false) })).filter((m) => m.s > 0).sort((a, b) => b.s - a.s)[0];
      if (!best) return none(`No item named '${value}' was found in this element.`);
      const r = selectItem(best.x, done);
      if (typeof n.value === 'string') n.value = best.x.n.name;
      return { ...r, item: { id: uiId(t.w.hwnd, best.x.path, best.x.n), role: best.x.n.role, name: best.x.n.name } };
    }
    case 'expand':
    case 'collapse':
      if (!can('expand')) return none(`The element has none of the UI Automation patterns for this (${action}).`);
      n.expanded = action === 'expand';
      return done(action);
    case 'scrollIntoView':
      if (!can('scroll')) return none('The element has none of the UI Automation patterns for this (scroll).');
      n.offscreen = false;
      return done('scrollIntoView');
    default: // showMenu
      if (can('expand') && n.expanded === false && ['menuitem', 'button', 'combobox'].includes(n.role)) {
        n.expanded = true;
        return done('expand');
      }
      if (!can('focus')) return none('Could not focus the element for its context menu: focus failed.');
      return done('keyboard');
  }
}

function uiTree(a) {
  const w = uiWindow(a);
  const depth = num(a, 'depth', 6);
  const maxNodes = num(a, 'maxNodes', 400);
  const all = uiEntries(w.hwnd).filter((e) => e.depth <= depth);
  const kept = new Set(all.slice(0, maxNodes));
  const nodes = [];
  const visit = (e, index) => {
    const kids = e.n.children.map((c) => all.find((x) => x.parent === e && x.n === c)).filter((c) => c && kept.has(c));
    nodes.push({
      ...uiNode(w, e, index),
      parent: e.parent ? uiId(w.hwnd, e.parent.path, e.parent.n) : null,
      children: kids.map((c) => uiId(w.hwnd, c.path, c.n)),
      depth: e.depth,
    });
    for (const c of kids) visit(c, e.n.children.indexOf(c.n));
  };
  visit(all[0], 0);
  const result = { window: { id: w.hwnd, app: w.app, title: w.title }, nodes, truncated: all.length > maxNodes, scanned: all.length, elapsedMs: 1 };
  const warn = w.elevated ? [`'${w.title} (${w.process})' runs as administrator, so Windows lets UI Automation read little or nothing of it and blocks actions on it.`] : [];
  return withWarnings(result, warn);
}

function uiFind(a) {
  const roles = a.role == null ? null : new Set([].concat(a.role).map((r) => String(r).toLowerCase()));
  if (!a.name && !a.text && !roles) throw fail('Give a name, text or role to look for.', 'BAD_ARGS');
  const w = uiWindow(a);
  const limit = num(a, 'limit', 20);
  const entries = uiEntries(w.hwnd);
  const found = [];
  entries.slice(1).forEach((e, order) => {
    const n = e.n;
    if (roles && !roles.has(n.role)) return;
    let score = 3;
    if (a.name) score = Math.min(score, uiMatch(n.name, a.name, a.exact));
    if (a.text) {
      const value = n.password ? 0 : uiMatch(n.value, a.text, a.exact);
      score = Math.min(score, Math.max(uiMatch(n.name, a.text, a.exact), value, uiMatch(n.description, a.text, a.exact)));
    }
    if (score > 0) found.push({ e, score, order });
  });
  found.sort((x, y) => y.score - x.score || Number(Boolean(x.e.n.offscreen)) - Number(Boolean(y.e.n.offscreen)) ||
    Number(x.e.n.enabled === false) - Number(y.e.n.enabled === false) || x.order - y.order);
  const matches = found.slice(0, limit).map(({ e }) => {
    const crumbs = [];
    for (let p = e.parent; p; p = p.parent) crumbs.unshift(uiLabel(p.n));
    const index = e.parent ? e.parent.n.children.indexOf(e.n) : 0;
    const value = e.n.value != null && !e.n.password ? String(e.n.value) : null;
    return { ...uiNode(w, e, index), value, windowId: w.hwnd, path: crumbs.join(' > ') };
  });
  return { matches, scanned: entries.length, truncated: false, elapsedMs: 1, window: { id: w.hwnd, app: w.app, title: w.title } };
}

function uiAction(a) {
  const action = UI_ACTION_NAMES.find((x) => x.toLowerCase() === String(a.action || '').toLowerCase());
  if (!action) throw fail(`Unknown UI action '${a.action}'.`, 'BAD_ARGS', `Use one of: ${UI_ACTION_NAMES.join(', ')}.`);
  if (action === 'setValue' && a.value == null) throw fail('setValue needs a value.', 'BAD_ARGS');
  const t = uiResolve(a.id);
  const warnings = checkInput(t.w);
  const r = uiDo(t, action, a.value == null ? '' : String(a.value));
  const node = uiNode(t.w, t.e, t.e.parent ? t.e.parent.n.children.indexOf(t.e.n) : 0);
  const out = { ...r, id: t.id, role: t.e.n.role, name: t.e.n.name, bounds: node.bounds };
  if (node.value != null) out.value = node.value;
  return withWarnings(out, warnings);
}

function restoreWindow(w) {
  w.minimized = false;
  if (w.maximized && savedBounds[w.hwnd]) Object.assign(w, savedBounds[w.hwnd]);
  w.maximized = false;
}

/** Set-WindowBounds in win32-host.ps1: a state, then partial bounds; elevated windows refuse. */
function winBounds(a) {
  const w = findWindow(a.hwnd);
  if (!w) return { ok: false, error: 'The window does not exist.' };
  const state = String(a.state || '').trim().toLowerCase();
  const keys = ['x', 'y', 'width', 'height'].filter((k) => a[k] != null);
  if (!state && !keys.length) throw fail('Give a state or bounds.', 'BAD_ARGS');
  if (state && !['maximize', 'minimize', 'restore', 'fullscreen'].includes(state)) {
    throw fail(`Unknown window state '${a.state}'.`, 'BAD_ARGS', 'Use maximize, minimize, restore or fullscreen.');
  }
  const report = (ok, error) => ({ ok, error, x: w.x, y: w.y, width: w.width, height: w.height, state: w.minimized ? 'minimized' : w.maximized ? 'maximized' : 'normal' });
  if (w.elevated) return report(false, 'SetWindowPos failed (Win32 error 5). The window runs as administrator.');
  if (state === 'maximize' || state === 'fullscreen') {
    if (!w.maximized) savedBounds[w.hwnd] = { x: w.x, y: w.y, width: w.width, height: w.height };
    const d = displays.find((s) => w.x >= s.x && w.x < s.x + s.width) || displays[0];
    Object.assign(w, { x: d.x, y: d.y, width: d.width, height: d.height, maximized: true, minimized: false });
  } else if (state === 'minimize') {
    w.minimized = true;
    if (desk.focused === w.hwnd) desk.focused = null;
  } else if (state === 'restore') {
    restoreWindow(w);
  }
  if (keys.length) {
    if ((a.width != null && num(a, 'width') < 1) || (a.height != null && num(a, 'height') < 1)) throw fail('Window width and height must be at least 1.', 'BAD_ARGS');
    if (w.minimized || w.maximized) restoreWindow(w);
    for (const k of keys) w[k] = num(a, k);
  }
  return report(true, null);
}

const handlers = {
  ping: () => ({
    pong: true, protocol: 1, ps: '5.1.22621.4111', edition: 'Desktop', windows: true, native: true, nativeError: null,
    dpi: 'permonitorv2', elevated: false, sta: true, is64: true, pid: process.pid, os: 'Microsoft Windows NT 10.0.22631.0',
  }),
  echo: (a) => ({ args: a }),
  displays: () => ({ displays }),
  capture: (a) => {
    const i = num(a, 'index', 0);
    const d = displays[i];
    if (!d) throw fail(`Display ${i} does not exist (${displays.length} connected).`, 'BAD_DISPLAY', 'Call displays to list the connected screens.');
    return { width: d.width, height: d.height, png: makePng(d.width, d.height, i * 100).toString('base64') };
  },
  cursor: () => ({ ...desk.cursor }),
  move: (a) => {
    desk.cursor = { x: num(a, 'x'), y: num(a, 'y') };
    return { ...desk.cursor };
  },
  click: (a) => {
    if (a.x != null) desk.cursor = { x: num(a, 'x'), y: num(a, 'y') };
    const warnings = checkInput(windowAt(desk.cursor.x, desk.cursor.y));
    return withWarnings({ ...desk.cursor }, warnings);
  },
  down: () => withWarnings({ ok: true }, checkInput(windowAt(desk.cursor.x, desk.cursor.y))),
  up: () => ({ ok: true }),
  drag: (a) => {
    const warnings = checkInput(windowAt(num(a, 'x1'), num(a, 'y1')));
    desk.cursor = { x: num(a, 'x2'), y: num(a, 'y2') };
    return withWarnings({ ok: true }, warnings);
  },
  scroll: (a) => {
    if (a.x != null) desk.cursor = { x: num(a, 'x'), y: num(a, 'y') };
    return withWarnings({ ok: true }, checkInput(windowAt(desk.cursor.x, desk.cursor.y)));
  },
  type: (a) => {
    const warnings = checkInput(findWindow(desk.focused));
    return withWarnings({ typed: String(a.text || '').length }, warnings);
  },
  keys: (a) => {
    if (!Array.isArray(a.vks) || !a.vks.length) throw fail('No keys given.', 'BAD_ARGS');
    return withWarnings({ ok: true }, checkInput(findWindow(desk.focused)));
  },
  windows: () => ({ windows: desk.windows.map(windowOut) }),
  active: () => {
    const w = findWindow(desk.focused);
    return { window: w ? windowOut(w) : null };
  },
  focus: (a) => {
    const w = findWindow(a.hwnd);
    if (!w) return { ok: false };
    desk.focused = w.hwnd;
    w.minimized = false;
    return { ok: true };
  },
  minimize: (a) => {
    const w = findWindow(a.hwnd);
    if (!w) return { ok: false };
    w.minimized = true;
    if (desk.focused === w.hwnd) desk.focused = null;
    return { ok: true };
  },
  topmost: (a) => {
    const w = findWindow(a.hwnd);
    if (!w) return { ok: false };
    desk.topmost[w.hwnd] = Boolean(a.on);
    return { ok: true };
  },
  // UI Automation read of a browser's address bar (Get-BrowserTab in win32-host.ps1).
  browsertab: (a) => {
    const w = findWindow(a.hwnd);
    if (!w) throw fail(`UI Automation cannot read window ${a.hwnd}: element not available`, 'NOT_FOUND', 'The window may have closed; list the windows again.');
    let custom = {};
    try {
      custom = env.FAKE_PS_BROWSER_TABS ? JSON.parse(env.FAKE_PS_BROWSER_TABS) : {};
    } catch {
      custom = {};
    }
    if (custom[w.hwnd]) return { title: w.title, name: null, editing: false, ...custom[w.hwnd] };
    if (w.hwnd === '1002') {
      return { found: true, url: 'console.cloud.google.com/run?project=my-project', title: w.title, name: 'Address and search bar', editing: false };
    }
    return { found: false, url: null, title: w.title, name: null, editing: false };
  },
  clipget: () => ({ text: desk.clipboard }),
  clipset: (a) => {
    desk.clipboard = String(a.text == null ? '' : a.text);
    return { ok: true };
  },
  notify: () => ({ shown: true }),
  uiinfo: () => (env.FAKE_PS_NO_UIA === '1'
    ? { available: false, error: "Could not load file or assembly 'UIAutomationClient'." }
    : { available: true, error: null }),
  uitree: uiTree,
  uifind: uiFind,
  uiaction: uiAction,
  winbounds: winBounds,
  __uilog: () => ({ log: [...uiLog] }),
  __uimutate: (a) => {
    const t = uiResolve(a.id);
    t.e.n.name = String(a.name);
    return { ok: true, id: uiId(t.w.hwnd, t.e.path, t.e.n) };
  },
  __requests: () => ({ requests }),
  __stderr: (a) => {
    process.stderr.write(`${a.text}\n`);
    return { ok: true };
  },
};

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    write({ id: null, ok: false, error: { message: `Conversion from JSON failed: ${err.message}`, code: 'HOST_ERROR' } });
    return;
  }
  const { id, cmd } = req;
  const args = req.args || {};
  requests.push({ cmd, args });
  if (env.FAKE_PS_LOG) fs.appendFileSync(env.FAKE_PS_LOG, `${JSON.stringify({ pid: process.pid, cmd, args })}\n`);
  if ((cmd === '__crash' || CRASH_ON.has(cmd)) && crashEnabled) {
    process.stderr.write(`fake host: crashing on ${cmd}\n`);
    process.exit(9);
  }
  if (HANG.has(cmd)) return;
  const respond = () => {
    if (env.FAKE_PS_NOISE === '1') {
      process.stdout.write('WARNING: this is not a protocol line\n');
      write({ id: -1, ok: true, result: { stale: true } });
      write({ note: 'object without an id' });
    }
    const fn = handlers[cmd];
    if (!fn) {
      write({ id, ok: false, error: { message: `Unknown command '${cmd}'.`, code: 'UNKNOWN_COMMAND', hint: null } });
      return;
    }
    try {
      write({ id, ok: true, result: fn(args) });
    } catch (err) {
      write({ id, ok: false, error: { message: err.message, code: err.code || 'HOST_ERROR', hint: err.hint || null, type: 'System.InvalidOperationException' } });
    }
  };
  if (DELAY) setTimeout(respond, DELAY);
  else respond();
}

function startReading() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim()) handle(line);
  });
  rl.on('close', () => process.exit(0));
}

const startDelay = Number(env.FAKE_PS_START_DELAY_MS) || 0;
if (startDelay) setTimeout(startReading, startDelay);
else startReading();
