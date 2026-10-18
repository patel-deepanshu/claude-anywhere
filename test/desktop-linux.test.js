'use strict';

// Linux UI automation (AT-SPI through src/os/atspi-helper.py) and window bounds (wmctrl/xdotool,
// swaymsg, hyprctl): the helper's display-free commands through a real Python, the driver's
// requests and result mapping through a fake `run`, and, opt-in, a live check against Chromium
// (Linux with ANYWHERE_LIVE_DESKTOP=1, a display, a session bus, AT-SPI bindings and Chromium).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const L = require('../src/os/linux');
const osIndex = require('../src/os/index');
const { Computer } = require('../src/os/computer');

const HELPER = path.join(__dirname, '..', 'src', 'os', 'atspi-helper.py');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The Python helper (no display or bus needed)
// ---------------------------------------------------------------------------

function findPython() {
  for (const p of ['python3', 'python']) {
    const r = spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return p;
  }
  return null;
}
const PY = process.platform === 'win32' ? null : findPython();
const noPython = PY ? false : 'python3 is not installed';

function helper(req, env = process.env) {
  const input = typeof req === 'string' ? req : JSON.stringify(req);
  const r = spawnSync(PY, ['-I', HELPER], { input, encoding: 'utf8', env, timeout: 20000 });
  assert.equal(r.status, 0, `helper exit ${r.status}: ${r.stderr}`);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `one JSON line: ${r.stdout}`);
  return JSON.parse(lines[0]);
}

test('atspi-helper: version and shared roles for AT-SPI role names', { skip: noPython }, () => {
  assert.deepEqual(helper({ cmd: 'version' }).protocol, 1);
  const res = helper({
    cmd: 'roles',
    items: [
      'push button', 'toggle button', 'page tab', 'page tab list', 'entry', 'password text', 'link', 'check box',
      'radio button', 'combo box', 'list item', 'menu item', 'check menu item', 'menu bar', 'tree item', 'heading',
      'label', 'static', 'frame', 'dialog', 'tool bar', 'table', 'table row', 'table cell', 'column header', 'slider',
      'spin button', 'panel', 'section', 'document web', 'scroll bar', 'icon', 'something new',
      { role: 'section', states: ['editable', 'focusable'], editable: true },
      { role: 'text', states: ['editable'], editable: true },
      { role: 'text' },
    ],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.roles, [
    'button', 'button', 'tab', 'tablist', 'textbox', 'textbox', 'link', 'checkbox',
    'radio', 'combobox', 'listitem', 'menuitem', 'menuitem', 'menu', 'treeitem', 'heading',
    'text', 'text', 'window', 'window', 'toolbar', 'table', 'row', 'cell', 'cell', 'slider',
    'slider', 'group', 'group', 'group', 'other', 'image', 'other',
    'textbox', 'textbox', 'text',
  ]);
  for (const r of res.roles) assert.ok(L.UI_ROLES.includes(r), r);
});

test('atspi-helper: match scores agree with the driver (whole, prefix, substring, exact)', { skip: noPython }, () => {
  const items = ['For you', '  for   YOU  ', 'For you now', 'Before you', 'Assigned: for you', '', 'x'];
  for (const exact of [false, true]) {
    const res = helper({ cmd: 'match', items, query: 'for you', exact });
    assert.deepEqual(res.scores, items.map((s) => L.uiMatchScore(s, 'for you', exact)), `exact=${exact}`);
  }
  assert.deepEqual(helper({ cmd: 'match', items, query: 'for you' }).scores, [3, 3, 2, 0, 1, 0, 0]);
});

test('atspi-helper: bad requests answer BAD_REQUEST with exit code 0', { skip: noPython }, () => {
  assert.equal(helper('not json').code, 'BAD_REQUEST');
  assert.equal(helper('[1, 2]').code, 'BAD_REQUEST');
  assert.equal(helper({ cmd: 'launch-missiles' }).code, 'BAD_REQUEST');
});

test('atspi-helper: no session bus -> NO_BUS (or NO_BINDINGS), never a crash', { skip: noPython }, () => {
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), LANG: 'C.UTF-8' };
  for (const cmd of ['probe', 'tree', 'find', 'action']) {
    const res = helper({ cmd, window: { active: true }, name: 'x', root: 'w', path: '', hash: 'abcdef', action: 'press' }, env);
    assert.equal(res.ok, false, cmd);
    assert.ok(['NO_BUS', 'NO_BINDINGS'].includes(res.code), `${cmd}: ${JSON.stringify(res)}`);
  }
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('UI ids: format and parse round trip; malformed ids are rejected', () => {
  const id = L.formatUiId('0x01a00003', 'w:0.3.12:a1b2c3');
  assert.equal(id, 'lx:0x01a00003:w:0.3.12:a1b2c3');
  assert.deepEqual(L.parseUiId(id), { windowKey: '0x01a00003', root: 'w', path: [0, 3, 12], pathText: '0.3.12', hash: 'a1b2c3' });
  assert.deepEqual(L.parseUiId('lx:@4242.1:p3::00ff00'), { windowKey: '@4242.1', root: 'p3', path: [], pathText: '', hash: '00ff00' });
  for (const bad of ['', 'lx:0x1:w:0.1', 'lx:0x1:q:0:abcdef', 'lx:0x1:w:0.-1:abcdef', 'mock:0x1:0', 'lx::w:0:abcdef', null, 42]) {
    assert.equal(L.parseUiId(bad), null, String(bad));
  }
});

test('normalizeUiRole / uiRoleFilter: vocabulary, aliases, lists, unknown roles', () => {
  assert.equal(L.normalizeUiRole('Button'), 'button');
  assert.equal(L.normalizeUiRole('push button'), 'button');
  assert.equal(L.normalizeUiRole('page_tab'), 'tab');
  assert.equal(L.normalizeUiRole('entry'), 'textbox');
  assert.equal(L.normalizeUiRole('hyperlink'), 'link');
  assert.equal(L.normalizeUiRole('spin-button'), 'slider');
  assert.deepEqual(L.uiRoleFilter('tab|link'), ['tab', 'link']);
  assert.deepEqual(L.uiRoleFilter(['textbox', 'edit', 'entry']), ['textbox']);
  assert.equal(L.uiRoleFilter(''), undefined);
  assert.throws(() => L.normalizeUiRole('spaceship'), (e) => e.code === 'BAD_ARGS' && /button/.test(e.hint));
});

test('parseBoundsSpec: states with aliases, partial bounds, invalid input', () => {
  assert.deepEqual(L.parseBoundsSpec({ state: 'Maximized' }), { state: 'maximize' });
  assert.deepEqual(L.parseBoundsSpec({ state: 'full screen' }), { state: 'fullscreen' });
  assert.deepEqual(L.parseBoundsSpec({ state: 'normal' }), { state: 'restore' });
  assert.deepEqual(L.parseBoundsSpec({ x: '10', width: 300.4 }), { x: 10, width: 300 });
  for (const bad of [null, {}, { state: 'spin' }, { state: 'maximize', x: 1 }, { width: 5 }, { x: 'left' }]) {
    assert.throws(() => L.parseBoundsSpec(bad), (e) => e.code === 'BAD_ARGS', JSON.stringify(bad));
  }
});

test('parseXwininfoWindow and parseHelperOutput', () => {
  const xw = `xwininfo: Window id: 0x400003 "x"\n  Absolute upper-left X:  200\n  Absolute upper-left Y:  150\n  Relative upper-left X:  0\n  Width: 900\n  Height: 600\n`;
  assert.deepEqual(L.parseXwininfoWindow(xw), { x: 200, y: 150, width: 900, height: 600 });
  assert.equal(L.parseXwininfoWindow('garbage'), null);
  assert.deepEqual(L.parseHelperOutput('SpiRegistry daemon is running\n{"ok":true,"a":1}\n'), { ok: true, a: 1 });
  assert.deepEqual(L.parseHelperOutput('{"ok":false,"code":"X"}\n{"broken"\n'), { ok: false, code: 'X' });
  assert.equal(L.parseHelperOutput(''), null);
  assert.equal(L.parseHelperOutput('{"no":"ok field"}'), null);
});

test('DRIVER_METHODS has the UI methods, and both Linux drivers implement them', () => {
  for (const m of ['uiTree', 'uiFind', 'uiAction', 'setWindowBounds']) assert.ok(osIndex.DRIVER_METHODS.includes(m), m);
  for (const ds of ['x11', 'wayland']) {
    const d = L.createDriver({ displayServer: ds, env: { DISPLAY: ':0' } });
    for (const m of osIndex.DRIVER_METHODS) assert.equal(typeof d[m], 'function', `${ds}: ${m}`);
  }
});

// ---------------------------------------------------------------------------
// Driver <-> helper (fake run)
// ---------------------------------------------------------------------------

const CHROME = { id: '0x00400003', app: 'Chromium', title: 'Your work - Tracker - Chromium', pid: 4242, x: 50, y: 40, width: 1200, height: 800, focused: true, minimized: false };
const TERM = { id: '0x00600001', app: 'XTerm', title: 'bash', pid: 77, x: 0, y: 0, width: 600, height: 400, focused: false, minimized: false };

/**
 * A driver whose helper calls go to `answer(req, py)` (a JSON-able object, or a run result with
 * `raw: true`) and whose other commands go to `responses` (exact command line or command name).
 */
function uiDriver({ answer, pythons = ['/usr/bin/python3'], windows = [CHROME, TERM], ds = 'x11', env, responses = {}, tools = ['xdotool', 'wmctrl', 'xprop', 'xwininfo'] } = {}) {
  const calls = [];
  const helperCalls = [];
  const which = (n) => {
    if (pythons.includes(n)) return n;
    if (n === 'python3' && pythons.includes('/usr/bin/python3')) return null;
    return tools.includes(n) ? `/usr/bin/${n}` : null;
  };
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, line: `${cmd} ${args.join(' ')}`.trim(), opts });
    if (args[1] === L.ATSPI_HELPER) {
      const req = JSON.parse(opts.input);
      helperCalls.push({ py: cmd, req, timeoutMs: opts.timeoutMs });
      const out = await answer(req, cmd);
      if (out && out.raw) return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...out };
      return { code: 0, signal: null, stdout: `${JSON.stringify(out)}\n`, stderr: '', timedOut: false, error: null };
    }
    const key = `${cmd} ${args.join(' ')}`.trim();
    let r = Object.prototype.hasOwnProperty.call(responses, key) ? responses[key] : responses[cmd];
    if (typeof r === 'function') r = await r(args, opts);
    if (r === undefined) r = { code: 1, stderr: `no fake response for: ${key}` };
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...r };
  };
  const d = L.createDriver({ displayServer: ds, run, which, env: env || { DISPLAY: ':42', LANG: 'C.UTF-8' } });
  if (windows) {
    d.listWindows = async () => windows.map((w) => ({ ...w }));
  } else {
    d.listWindows = async () => {
      const e = new Error('no window list');
      e.code = 'UNSUPPORTED';
      throw e;
    };
  }
  d.activeWindow = async () => {
    const w = (windows || []).find((x) => x.focused);
    return w ? { id: w.id, app: w.app, title: w.title, pid: w.pid } : null;
  };
  return { d, calls, helperCalls };
}

const HELPER_WINDOW = { pid: 4242, app: 'Chromium', title: 'Your work - Tracker - Chromium', index: 0, toolkit: 'Chromium', bounds: { x: 50, y: 40, width: 1200, height: 800 } };
const TAB_MATCH = {
  ref: 'w:0.0.5.1.0.0.2.1.1:dc5d84', role: 'tab', name: 'For you', atspiRole: 'page tab', bounds: { x: 184, y: 311, width: 82, height: 36 },
  enabled: true, focused: false, selected: false, path: 'w:0.0.5.1.0.0.2.1.1',
};

test('uiFind: the window reference, the query and the result in the contract shape', async () => {
  const { d, helperCalls } = uiDriver({
    answer: (req) => ({ ok: true, window: HELPER_WINDOW, matches: [TAB_MATCH], truncated: false, scanned: 168, total: 1 }),
  });
  const list = await d.uiFind({ name: ' For you ', role: 'page tab' });
  assert.equal(helperCalls.length, 1);
  const { req, timeoutMs } = helperCalls[0];
  assert.equal(req.cmd, 'find');
  assert.deepEqual(req.window, { pid: 4242, title: CHROME.title, app: 'Chromium', bounds: { x: 50, y: 40, width: 1200, height: 800 } });
  assert.equal(req.name, 'For you');
  assert.deepEqual(req.roles, ['tab']);
  assert.equal(req.exact, false);
  assert.equal(req.origin, undefined, 'X11 uses screen coordinates');
  assert.ok(timeoutMs > req.budgetMs);
  assert.deepEqual(list[0], {
    id: 'lx:0x00400003:w:0.0.5.1.0.0.2.1.1:dc5d84', role: 'tab', name: 'For you', bounds: TAB_MATCH.bounds, enabled: true,
    focused: false, selected: false, value: '', windowId: '0x00400003', path: 'w:0.0.5.1.0.0.2.1.1',
  });
  assert.deepEqual(list.window, { id: '0x00400003', app: 'Chromium', title: CHROME.title });
  assert.equal(list.total, 1);
  assert.equal(list.truncated, false);
  assert.ok(!Object.keys(list).includes('window'), 'metadata is not enumerable');
  await assert.rejects(d.uiFind({}), (e) => e.code === 'BAD_ARGS');
  await assert.rejects(d.uiFind({ name: 'x', windowId: '0x0dead' }), (e) => e.code === 'NOT_FOUND');
});

test('uiFind: a window by id; Wayland without a window list uses the active window and window-keyed ids', async () => {
  const one = uiDriver({ answer: () => ({ ok: true, window: { ...HELPER_WINDOW, pid: 77, title: 'bash' }, matches: [] }) });
  await one.d.uiFind({ name: 'x', windowId: 6291457 });
  assert.equal(one.helperCalls[0].req.window.pid, 77, 'decimal X11 id matches 0x00600001');

  const wl = uiDriver({
    ds: 'wayland',
    env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' },
    windows: null,
    answer: () => ({ ok: true, window: { ...HELPER_WINDOW, index: 2 }, matches: [TAB_MATCH] }),
  });
  const list = await wl.d.uiFind({ name: 'For you' });
  assert.deepEqual(wl.helperCalls[0].req.window, { active: true });
  assert.equal(list[0].id, 'lx:@4242.2:w:0.0.5.1.0.0.2.1.1:dc5d84');
  assert.equal(list.relativeBounds, true);
  assert.ok(list.notes.some((n) => /relative to their window/.test(n)));
});

test('uiFind on sway: window-relative extents plus the window origin', async () => {
  const { d, helperCalls } = uiDriver({
    ds: 'wayland',
    env: { WAYLAND_DISPLAY: 'wayland-1', SWAYSOCK: '/run/sway.sock' },
    tools: ['swaymsg'],
    windows: [{ ...CHROME, id: '12', x: 300, y: 20 }],
    answer: () => ({ ok: true, window: HELPER_WINDOW, matches: [] }),
  });
  const list = await d.uiFind({ name: 'x' });
  assert.deepEqual(helperCalls[0].req.origin, { x: 300, y: 20 });
  assert.equal(list.relativeBounds, undefined);
});

test('uiTree: ids, parents, children, depth and notes', async () => {
  const nodes = [
    { ref: 'w::0f0f0f', role: 'window', name: 'Your work', bounds: { x: 50, y: 40, width: 1200, height: 800 }, enabled: true, focused: false, parent: null, children: ['w:0:aaaaaa'], depth: 0 },
    { ref: 'w:0:aaaaaa', role: 'tablist', name: 'Work views', bounds: { x: 74, y: 311, width: 600, height: 36 }, enabled: true, focused: false, parent: 'w::0f0f0f', children: ['w:0.1:dc5d84'], depth: 1 },
    { ref: 'w:0.1:dc5d84', role: 'tab', name: 'For you', bounds: TAB_MATCH.bounds, enabled: true, focused: false, selected: true, parent: 'w:0:aaaaaa', children: [], depth: 2, more: true },
    { ref: 'w:0.2:bbbbbb', role: 'weird', name: 'x', bounds: null, enabled: false, focused: false, parent: 'w:0:aaaaaa', children: [], depth: 2 },
  ];
  const { d, helperCalls } = uiDriver({ answer: () => ({ ok: true, window: HELPER_WINDOW, nodes, truncated: true, scanned: 900, notes: ['from helper'] }) });
  const tree = await d.uiTree({ depth: 3, maxNodes: 50 });
  assert.equal(helperCalls[0].req.depth, 3);
  assert.equal(helperCalls[0].req.maxNodes, 50);
  assert.deepEqual(tree.window, { id: '0x00400003', app: 'Chromium', title: HELPER_WINDOW.title });
  assert.equal(tree.nodes.length, 4);
  assert.equal(tree.nodes[0].id, 'lx:0x00400003:w::0f0f0f');
  assert.equal(tree.nodes[0].parent, null);
  assert.deepEqual(tree.nodes[0].children, ['lx:0x00400003:w:0:aaaaaa']);
  assert.equal(tree.nodes[2].parent, 'lx:0x00400003:w:0:aaaaaa');
  assert.equal(tree.nodes[2].selected, true);
  assert.equal(tree.nodes[2].more, true);
  assert.equal(tree.nodes[3].role, 'other', 'unknown roles become other');
  assert.deepEqual(tree.nodes[3].bounds, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(tree.truncated, true);
  assert.ok(tree.notes.includes('from helper'));
  assert.ok(tree.notes.some((n) => /limit/.test(n)));
});

test('uiAction: path, hash and window go to the helper; results, moved ids and the cache', async () => {
  let reply = { ok: true, method: 'action:click', role: 'tab', name: 'For you', ref: TAB_MATCH.ref, bounds: TAB_MATCH.bounds };
  const { d, helperCalls } = uiDriver({
    answer: (req) => (req.cmd === 'find' ? { ok: true, window: HELPER_WINDOW, matches: [TAB_MATCH] } : reply),
  });
  const [m] = await d.uiFind({ name: 'For you' });
  const r = await d.uiAction({ id: m.id, action: 'PRESS' });
  const req = helperCalls[1].req;
  assert.deepEqual(
    { cmd: req.cmd, root: req.root, path: req.path, hash: req.hash, action: req.action },
    { cmd: 'action', root: 'w', path: '0.0.5.1.0.0.2.1.1', hash: 'dc5d84', action: 'press' },
  );
  assert.equal(req.window.pid, 4242);
  assert.equal(req.window.index, 0, 'the helper\'s window index from the find is reused');
  assert.deepEqual(r, { ok: true, method: 'action:click', role: 'tab', name: 'For you', bounds: TAB_MATCH.bounds });

  reply = { ok: true, method: 'grabFocus', role: 'tab', name: 'For you', ref: 'w:0.0.5.1.0.0.2.2.1:dc5d84', resolved: 'moved', bounds: TAB_MATCH.bounds };
  const moved = await d.uiAction({ id: m.id, action: 'focus' });
  assert.equal(moved.id, 'lx:0x00400003:w:0.0.5.1.0.0.2.2.1:dc5d84');
  assert.equal(moved.resolved, 'moved');

  reply = { ok: false, method: 'none', reason: 'the element is disabled', disabled: true, role: 'button', name: 'Delete' };
  const off = await d.uiAction({ id: m.id, action: 'press' });
  assert.equal(off.ok, false);
  assert.equal(off.disabled, true);

  reply = { ok: false, code: 'STALE', error: 'The element is no longer in the window (it changed or closed).' };
  await assert.rejects(d.uiAction({ id: m.id }), (e) => e.code === 'STALE' && /ui_find/.test(e.hint));
  await assert.rejects(d.uiAction({ id: 'lx:0x0dead:w:0:abcdef' }), (e) => e.code === 'STALE' && /closed/.test(e.message));
  await assert.rejects(d.uiAction({ id: 'nope' }), (e) => e.code === 'BAD_ARGS');
  await assert.rejects(d.uiAction({ id: m.id, action: 'explode' }), (e) => e.code === 'BAD_ARGS');
  await assert.rejects(d.uiAction({ id: m.id, action: 'setValue' }), (e) => e.code === 'BAD_ARGS');
  reply = { ok: true, method: 'editableText', role: 'textbox', name: 'Search' };
  await d.uiAction({ id: m.id, action: 'setvalue', value: 42 });
  assert.equal(helperCalls[helperCalls.length - 1].req.value, 42);
  assert.equal(helperCalls[helperCalls.length - 1].req.action, 'setValue');
});

test('uiAction showMenu: without a menu action, focus + Shift+F10', async () => {
  const { d, calls } = uiDriver({
    answer: (req) => (req.action === 'showMenu' ? { ok: false, method: 'none', reason: 'the element has no menu action' } : { ok: true, method: 'grabFocus' }),
    responses: { xdotool: { code: 0 } },
  });
  const r = await d.uiAction({ id: 'lx:0x00400003:w:0.1:abcdef', action: 'showMenu' });
  assert.deepEqual([r.ok, r.method], [true, 'focus+shift+F10']);
  assert.ok(calls.some((c) => c.cmd === 'xdotool' && c.args.includes('shift+F10')), calls.map((c) => c.line).join('\n'));
});

test('helper interpreter: one without the bindings is skipped and the working one remembered', async () => {
  const { d, helperCalls } = uiDriver({
    pythons: ['python3', '/usr/bin/python3.12'],
    answer: (req, py) => (py === 'python3' ? { ok: false, code: 'NO_BINDINGS', error: 'no gi', python: '3.13.1' } : { ok: true, window: HELPER_WINDOW, matches: [] }),
  });
  await d.uiFind({ name: 'a' });
  await d.uiFind({ name: 'b' });
  assert.deepEqual(helperCalls.map((c) => c.py), ['python3', '/usr/bin/python3.12', '/usr/bin/python3.12']);

  const none = uiDriver({ pythons: ['python3'], answer: () => ({ ok: false, code: 'NO_BINDINGS', error: 'no gi', python: '3.13.1' }) });
  await assert.rejects(none.d.uiFind({ name: 'a' }), (e) => e.code === 'UNSUPPORTED' && /3\.13\.1/.test(e.message) && /python3-gi gir1\.2-atspi-2\.0 at-spi2-core/.test(e.hint));
  const before = none.helperCalls.length;
  await assert.rejects(none.d.uiFind({ name: 'a' }), (e) => e.code === 'UNSUPPORTED');
  assert.equal(none.helperCalls.length, before, 'an interpreter without bindings is not retried at once');

  const nopy = uiDriver({ pythons: [], answer: () => ({ ok: true }) });
  await assert.rejects(nopy.d.uiTree({}), (e) => e.code === 'UNSUPPORTED' && /python3/.test(e.message));
});

test('helper errors: NO_BUS, NO_WINDOW, timeouts and garbage become coded errors with hints', async () => {
  const cases = [
    [{ ok: false, code: 'NO_BUS', error: 'No D-Bus session bus' }, 'UNSUPPORTED', /at-spi2-core/],
    [{ ok: false, code: 'NO_WINDOW', error: 'not there', apps: 0 }, 'NOT_FOUND', /--force-renderer-accessibility/],
    [{ ok: false, code: 'NO_WINDOW', error: 'not there', apps: 3 }, 'NOT_FOUND', /ACCESSIBILITY_ENABLED=1/],
    [{ ok: false, code: 'BAD_REQUEST', error: 'bad' }, 'BAD_ARGS', null],
    [{ ok: false, code: 'ERROR', error: 'boom' }, 'UI_ERROR', /screenshot/],
    [{ raw: true, timedOut: true, code: null, signal: 'SIGKILL' }, 'TIMEOUT', /screenshot/],
    [{ raw: true, code: 1, stderr: 'Traceback: kaboom\n' }, 'UI_ERROR', /screenshot/],
  ];
  for (const [answer, code, hint] of cases) {
    const { d } = uiDriver({ answer: () => answer });
    await assert.rejects(d.uiFind({ name: 'x' }), (e) => e.code === code && (!hint || hint.test(e.hint)), JSON.stringify(answer));
  }
});

test('capabilities: ui with notes when the helper answers, ui false with a hint when not', async () => {
  const good = uiDriver({ answer: () => ({ ok: true, python: '3.12.3', appCount: 2, apps: [] }), responses: { xdotool: { code: 0, stdout: '1920 1080' } } });
  const caps = await good.d.capabilities();
  assert.equal(caps.ui, true);
  assert.ok(caps.notes.some((n) => /2 applications on the accessibility bus/.test(n)));
  assert.ok(caps.notes.some((n) => /--force-renderer-accessibility/.test(n)));
  await good.d.capabilities();
  assert.equal(good.helperCalls.length, 1, 'the probe is cached');

  const bad = uiDriver({ pythons: [], answer: () => ({ ok: true }), responses: { xdotool: { code: 0 } } });
  const c2 = await bad.d.capabilities();
  assert.equal(c2.ui, false);
  assert.ok(c2.uiHint && /python3/.test(c2.uiHint));
  assert.ok(c2.notes.some((n) => /UI automation .* is unavailable/.test(n)));
});

// ---------------------------------------------------------------------------
// setWindowBounds
// ---------------------------------------------------------------------------

/** X11 fake with a window manager that keeps geometry and _NET_WM_STATE, placing frames 24 px low. */
function x11Wm({ frameOffset = 24, exists = true } = {}) {
  const geo = { x: 50, y: 40, width: 1200, height: 800 };
  let states = [];
  const hex = '0x00400003';
  const responses = {
    [`xprop -id ${hex} WM_CLASS`]: exists ? { stdout: 'WM_CLASS(STRING) = "chromium", "Chromium"\n' } : { code: 1, stderr: 'BadWindow' },
    [`xprop -id ${hex} _NET_WM_STATE`]: () => ({ stdout: `_NET_WM_STATE(ATOM) = ${states.map((s) => `_NET_WM_STATE_${s}`).join(', ')}\n` }),
    [`xprop -id ${hex} _NET_WM_STATE WM_STATE`]: () => ({ stdout: `_NET_WM_STATE(ATOM) = ${states.map((s) => `_NET_WM_STATE_${s}`).join(', ')}\nWM_STATE(WM_STATE):\n\t\twindow state: ${states.includes('HIDDEN') ? 'Iconic' : 'Normal'}\n` }),
    [`xwininfo -id ${hex}`]: () => ({ stdout: `  Absolute upper-left X:  ${geo.x}\n  Absolute upper-left Y:  ${geo.y}\n  Width: ${geo.width}\n  Height: ${geo.height}\n` }),
    wmctrl: (args) => {
      const i = args.indexOf('-e');
      if (i >= 0) {
        const [, x, y, w, h] = args[i + 1].split(',').map(Number);
        Object.assign(geo, { x, y: y + frameOffset, width: w, height: h });
        return { code: 0 };
      }
      const b = args.indexOf('-b');
      if (b >= 0) {
        const [op, ...props] = args[b + 1].split(',');
        for (const p of props.map((s) => s.toUpperCase())) {
          if (op === 'add' && !states.includes(p)) states.push(p);
          if (op === 'remove') states = states.filter((s) => s !== p);
        }
        return { code: 0 };
      }
      if (args.includes('-a')) {
        states = states.filter((s) => s !== 'HIDDEN');
        return { code: 0 };
      }
      return { code: 1 };
    },
    xdotool: (args) => {
      if (args[0] === 'windowminimize') states.push('HIDDEN');
      return { code: 0, stdout: args[0] === 'getactivewindow' ? `${0x400003}\n` : '' };
    },
  };
  const calls = [];
  const which = (n) => (['wmctrl', 'xdotool', 'xprop', 'xwininfo'].includes(n) ? `/usr/bin/${n}` : null);
  const run = async (cmd, args, opts = {}) => {
    const key = `${cmd} ${args.join(' ')}`.trim();
    calls.push(key);
    let r = Object.prototype.hasOwnProperty.call(responses, key) ? responses[key] : responses[cmd];
    if (typeof r === 'function') r = await r(args, opts);
    if (r === undefined) r = { code: 1, stderr: `no fake response for: ${key}` };
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...r };
  };
  const d = L.createDriver({ displayServer: 'x11', run, which, env: { DISPLAY: ':42', LANG: 'C.UTF-8' } });
  return { d, calls, geo, states: () => states, hex };
}

test('X11 setWindowBounds: move/resize lands the client area where asked (frame offset corrected)', async () => {
  const f = x11Wm();
  assert.equal(await f.d.setWindowBounds(f.hex, { x: 200, y: 150, width: 900, height: 600 }), true);
  assert.deepEqual(f.geo, { x: 200, y: 150, width: 900, height: 600 });
  const moves = f.calls.filter((c) => c.includes(' -e '));
  assert.deepEqual(moves, [`wmctrl -i -r ${f.hex} -e 0,200,150,900,600`, `wmctrl -i -r ${f.hex} -e 0,200,126,900,600`]);
  // Partial bounds keep the rest.
  assert.equal(await f.d.setWindowBounds('4194307', { width: 1000 }), true);
  assert.deepEqual(f.geo, { x: 200, y: 150, width: 1000, height: 600 });
});

test('X11 setWindowBounds: maximize, fullscreen, restore, minimize', async () => {
  const f = x11Wm();
  assert.equal(await f.d.setWindowBounds(f.hex, { state: 'maximize' }), true);
  assert.deepEqual(f.states().sort(), ['MAXIMIZED_HORZ', 'MAXIMIZED_VERT']);
  assert.ok(f.calls.includes(`wmctrl -i -r ${f.hex} -b add,maximized_vert,maximized_horz`));
  assert.equal(await f.d.setWindowBounds(f.hex, { state: 'fullscreen' }), true);
  assert.ok(f.states().includes('FULLSCREEN'));
  assert.equal(await f.d.setWindowBounds(f.hex, { state: 'restore' }), true);
  assert.deepEqual(f.states(), []);
  assert.equal(await f.d.setWindowBounds(f.hex, { state: 'minimize' }), true);
  assert.ok(f.states().includes('HIDDEN'));
  assert.equal(await f.d.setWindowBounds(f.hex, { state: 'restore' }), true);
  assert.ok(!f.states().includes('HIDDEN'));
  assert.ok(f.calls.includes(`wmctrl -i -a ${f.hex}`), 'restore activates a minimized window');
});

test('X11 setWindowBounds: a closed window is false; bad input and missing tools throw', async () => {
  const gone = x11Wm({ exists: false });
  assert.equal(await gone.d.setWindowBounds(gone.hex, { state: 'maximize' }), false);
  const f = x11Wm();
  await assert.rejects(f.d.setWindowBounds(f.hex, { state: 'wobble' }), (e) => e.code === 'BAD_ARGS');
  await assert.rejects(f.d.setWindowBounds('not-an-id', { x: 1 }), (e) => e.code === 'BAD_WINDOW_ID');
  const bare = L.createDriver({ displayServer: 'x11', which: () => null, run: async () => ({ code: 1 }), env: { DISPLAY: ':1' } });
  await assert.rejects(bare.setWindowBounds('0x1', { x: 1 }), (e) => e.code === 'UNSUPPORTED' && /wmctrl/.test(e.hint));
});

function wayland({ env, tools, responses }) {
  const calls = [];
  const which = (n) => (tools.includes(n) ? `/usr/bin/${n}` : null);
  const run = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`.trim();
    calls.push(key);
    let r = Object.prototype.hasOwnProperty.call(responses, key) ? responses[key] : responses[cmd];
    if (typeof r === 'function') r = await r(args);
    if (r === undefined) r = { code: 1, stderr: `no fake response for: ${key}` };
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...r };
  };
  return { d: L.createDriver({ displayServer: 'wayland', run, which, env }), calls };
}

const SWAY_TREE = JSON.stringify({
  type: 'root',
  nodes: [{ type: 'output', nodes: [{ type: 'workspace', name: '1', nodes: [{ type: 'con', id: 12, name: 'Firefox', app_id: 'firefox', pid: 9, rect: { x: 0, y: 0, width: 800, height: 600 }, focused: true, nodes: [], floating_nodes: [] }], floating_nodes: [] }] }],
  floating_nodes: [],
});

test('sway setWindowBounds: floating move/resize, fullscreen for maximize, restore', async () => {
  const { d, calls } = wayland({
    env: { WAYLAND_DISPLAY: 'wayland-1', SWAYSOCK: '/run/sway.sock' },
    tools: ['swaymsg'],
    responses: { 'swaymsg -t get_tree -r': { stdout: SWAY_TREE }, swaymsg: { stdout: '[{"success":true}]' } },
  });
  assert.equal(await d.setWindowBounds('12', { x: 10, width: 640 }), true);
  assert.ok(calls.includes('swaymsg [con_id=12] fullscreen disable, floating enable, resize set width 640 px height 600 px, move absolute position 10 px 0 px'), calls.join('\n'));
  assert.equal(await d.setWindowBounds('12', { state: 'maximize' }), true);
  assert.ok(calls.includes('swaymsg [con_id=12] fullscreen enable'));
  assert.equal(await d.setWindowBounds('12', { state: 'restore' }), true);
  assert.ok(calls.includes('swaymsg [con_id=12] fullscreen disable'));
  assert.equal(await d.setWindowBounds('99', { state: 'restore' }), false, 'unknown container');
  await assert.rejects(d.setWindowBounds('abc', { x: 1 }), (e) => e.code === 'BAD_WINDOW_ID');
});

test('Hyprland setWindowBounds: setfloating, exact resize and move; maximize toggles fullscreen 1', async () => {
  const client = { address: '0xabc', at: [0, 0], size: [800, 600], floating: false, fullscreen: 0, workspace: { id: 1, name: '1' } };
  const { d, calls } = wayland({
    env: { WAYLAND_DISPLAY: 'wayland-1', HYPRLAND_INSTANCE_SIGNATURE: 'sig' },
    tools: ['hyprctl'],
    responses: { 'hyprctl clients -j': () => ({ stdout: JSON.stringify([client]) }), hyprctl: { stdout: 'ok' } },
  });
  assert.equal(await d.setWindowBounds('0xabc', { x: 100, y: 50, width: 700, height: 500 }), true);
  assert.deepEqual(calls.filter((c) => c.startsWith('hyprctl dispatch')), [
    'hyprctl dispatch setfloating address:0xabc',
    'hyprctl dispatch resizewindowpixel exact 700 500,address:0xabc',
    'hyprctl dispatch movewindowpixel exact 100 50,address:0xabc',
  ]);
  calls.length = 0;
  assert.equal(await d.setWindowBounds('0xabc', { state: 'maximize' }), true);
  assert.deepEqual(calls.filter((c) => c.startsWith('hyprctl dispatch')), ['hyprctl dispatch focuswindow address:0xabc', 'hyprctl dispatch fullscreen 1']);
  client.fullscreen = 1;
  calls.length = 0;
  assert.equal(await d.setWindowBounds('0xabc', { state: 'maximize' }), true);
  assert.deepEqual(calls.filter((c) => c.startsWith('hyprctl dispatch')), [], 'already maximized');
});

test('GNOME/KDE Wayland setWindowBounds: UNSUPPORTED with the compositor hint', async () => {
  const { d } = wayland({ env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' }, tools: [], responses: {} });
  await assert.rejects(d.setWindowBounds('1', { state: 'maximize' }), (e) => e.code === 'UNSUPPORTED' && /GNOME/.test(e.hint));
});

// ---------------------------------------------------------------------------
// Live: Chromium on a real X display through AT-SPI (opt-in)
// ---------------------------------------------------------------------------

function chromiumPath() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  for (const n of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'brave-browser']) {
    const r = spawnSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  try {
    for (const dir of fs.readdirSync('/opt/pw-browsers')) {
      const p = path.join('/opt/pw-browsers', dir, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* none */
  }
  return null;
}

const LIVE_WANTED = process.platform === 'linux' && process.env.ANYWHERE_LIVE_DESKTOP === '1';
const CHROMIUM = LIVE_WANTED ? chromiumPath() : null;
const liveSkip = !LIVE_WANTED
  ? 'live Linux desktop only (ANYWHERE_LIVE_DESKTOP=1)'
  : !process.env.DISPLAY
    ? 'no DISPLAY'
    : !process.env.DBUS_SESSION_BUS_ADDRESS
      ? 'no D-Bus session bus (run inside dbus-run-session)'
      : !CHROMIUM
        ? 'Chromium not found (set CHROMIUM_PATH)'
        : false;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Your work - Tracker</title></head><body>
<h1>Your work</h1>
<div role="tablist" aria-label="Work views">
<button role="tab" id="t1" aria-selected="true">Worked on</button>
<button role="tab" id="t2" aria-selected="false">For you</button>
</div>
<a href="#help">Help</a>
<label>Search <input id="q" type="text"></label>
<h2 id="h">Recently worked on</h2><div id="s">Nothing yet</div>
<script>
document.getElementById('t2').addEventListener('click', () => {
  document.getElementById('t1').setAttribute('aria-selected', 'false');
  document.getElementById('t2').setAttribute('aria-selected', 'true');
  document.getElementById('h').textContent = 'Assigned to you';
  document.getElementById('s').textContent = 'ABC-42 Fix login timeout';
  document.title = 'For you - Tracker';
});
</script></body></html>`;

test('LIVE: Chromium through AT-SPI: find the For you tab, press it, read the new page text', { skip: liveSkip, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-ui-'));
  fs.writeFileSync(path.join(dir, 'page.html'), PAGE);
  const args = [
    '--no-sandbox', '--no-first-run', '--disable-gpu', ...L.CHROMIUM_A11Y_ARGS, `--user-data-dir=${path.join(dir, 'profile')}`,
    '--window-position=60,50', '--window-size=1100,760', `file://${path.join(dir, 'page.html')}`,
  ];
  const child = spawn(CHROMIUM, args, { env: { ...process.env, ...L.CHROMIUM_A11Y_ENV }, stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const d = L.createDriver({ displayServer: 'x11' });
  const comp = new Computer({ driver: d, config: { failsafe: false, actionDelayMs: 0 } });
  let win = null;
  for (let i = 0; i < 60 && !win; i++) {
    await sleep(500);
    win = (await d.listWindows()).find((w) => /Tracker/.test(w.title) && w.pid === child.pid);
  }
  assert.ok(win, 'the Chromium window appears');
  let found = [];
  for (let i = 0; i < 20 && !found.length; i++) {
    found = await comp.uiFind({ windowId: win.id, name: 'For you', role: 'tab' }).catch(() => []);
    if (!found.length) await sleep(500);
  }
  assert.equal(found.length, 1);
  assert.equal(found[0].role, 'tab');
  assert.ok(found[0].shot && found[0].shot.cx > 0, JSON.stringify(found[0]));
  const r = await comp.uiClick({ id: found[0].id });
  assert.equal(r.ok, true);
  assert.match(r.method, /^action:|^selection$/);
  let title = '';
  for (let i = 0; i < 20 && !/For you/.test(title); i++) {
    await sleep(200);
    title = ((await d.listWindows()).find((w) => w.id === win.id) || {}).title || '';
  }
  assert.match(title, /^For you - Tracker/);
  const tree = await comp.uiTree({ windowId: win.id, depth: 12 });
  const texts = tree.nodes.map((n) => `${n.role}:${n.name}`);
  assert.ok(texts.includes('heading:Assigned to you'), texts.join(' | '));
  assert.ok(texts.some((s) => /ABC-42 Fix login timeout/.test(s)), texts.join(' | '));
  assert.ok(tree.nodes.find((n) => n.role === 'tab' && n.name === 'For you').selected);
  const set = await comp.uiSetValue({ windowId: win.id, name: 'Search', value: 'login timeout' });
  assert.equal(set.ok, true);
  const field = await comp.uiFind({ windowId: win.id, name: 'Search', role: 'textbox' });
  assert.equal(field[0].value, 'login timeout');
  assert.equal(await d.setWindowBounds(win.id, { x: 120, y: 90, width: 900, height: 640 }), true);
  const moved = (await d.listWindows()).find((w) => w.id === win.id);
  assert.deepEqual([moved.x, moved.y, moved.width, moved.height], [120, 90, 900, 640]);
});
