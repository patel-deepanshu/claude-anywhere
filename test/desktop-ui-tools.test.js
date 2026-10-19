'use strict';

// UI automation above the OS backends: the mock driver's uiTree/uiFind/uiAction/setWindowBounds
// (src/os/index.js), the Computer's screenshot-space mapping, uiClick and uiSetValue
// (src/os/computer.js), and the MCP tools ui_find, ui_tree, ui_click, ui_set_value
// (src/mcp/tools-ui.js). No display needed.

const test = require('node:test');
const assert = require('node:assert/strict');

const osIndex = require('../src/os/index');
const { Computer } = require('../src/os/computer');
const uiTools = require('../src/mcp/tools-ui');

function mock(opts) {
  return osIndex.createMockDriver(opts);
}

function computer(driver, extra = {}) {
  return new Computer({ driver, config: { actionDelayMs: 0, failsafe: true }, platform: 'linux', ...extra });
}

const CHROME = '0x1002';

// ---------------------------------------------------------------------------
// Mock driver
// ---------------------------------------------------------------------------

test('mock uiTree: listed nodes in document order, unnamed containers walked through, depth limit', async () => {
  const d = mock();
  const t = await d.uiTree({ windowId: CHROME });
  assert.deepEqual(t.window, { id: CHROME, app: 'Google Chrome', title: 'Cloud Run - My Project - Google Cloud console - Google Chrome' });
  assert.equal(t.truncated, false);
  const names = t.nodes.map((n) => `${n.depth}:${n.role}:${n.name}`);
  assert.equal(names[0], '0:window:Cloud Run - My Project - Google Cloud console - Google Chrome');
  assert.ok(names.includes('1:heading:Your work'), 'the unnamed page group is walked through');
  assert.ok(names.includes('2:tab:For you'));
  assert.ok(!t.nodes.some((n) => n.role === 'image'), 'unnamed images are left out');
  const tablist = t.nodes.find((n) => n.role === 'tablist');
  assert.deepEqual(tablist.children.map((id) => t.nodes.find((n) => n.id === id).name), ['Worked on', 'For you', 'Starred']);
  assert.equal(t.nodes.find((n) => n.name === 'For you').parent, tablist.id);
  const shallow = await d.uiTree({ windowId: CHROME, depth: 1 });
  assert.ok(shallow.nodes.every((n) => n.depth <= 1));
  assert.equal(shallow.nodes.find((n) => n.role === 'tablist').more, true);
  const few = await d.uiTree({ windowId: CHROME, maxNodes: 3 });
  assert.equal(few.nodes.length, 3);
  assert.equal(few.truncated, true);
  const active = await d.uiTree();
  assert.equal(active.window.id, '0x1001', 'defaults to the focused window');
  await assert.rejects(d.uiTree({ windowId: '0x1003' }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(d.uiTree({ windowId: '0xdead' }), (e) => e.code === 'NOT_FOUND');
});

test('mock uiFind: ranking, roles and aliases, text in values, contract fields', async () => {
  const d = mock();
  const tabs = await d.uiFind({ windowId: CHROME, name: 'for you', role: 'page tab' });
  assert.equal(tabs.length, 1);
  assert.deepEqual(Object.keys(tabs[0]).sort(), ['bounds', 'enabled', 'focused', 'id', 'name', 'path', 'role', 'selected', 'value', 'windowId'].sort());
  assert.equal(tabs[0].windowId, CHROME);
  assert.equal(tabs.window.id, CHROME);
  const search = await d.uiFind({ windowId: CHROME, name: 'search' });
  assert.deepEqual(search.map((m) => m.name), ['Search', 'Address and search bar'], 'whole name before substring');
  const byText = await d.uiFind({ windowId: CHROME, text: 'atlassian.net' });
  assert.equal(byText[0].name, 'Address and search bar');
  const links = await d.uiFind({ windowId: CHROME, role: 'link' });
  assert.equal(links.length, 2);
  assert.equal(links.total, 2);
  const exact = await d.uiFind({ windowId: CHROME, name: 'For', exact: true });
  assert.equal(exact.length, 0);
  const limited = await d.uiFind({ windowId: CHROME, role: 'tab|link', limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited.total, 5);
  await assert.rejects(d.uiFind({ windowId: CHROME }), (e) => e.code === 'BAD_ARGS');
  await assert.rejects(d.uiFind({ windowId: CHROME, role: 'spaceship' }), (e) => e.code === 'BAD_ARGS');
});

test('mock uiAction: press, focus, setValue, select, expand, disabled, unsupported, stale', async () => {
  const d = mock();
  const id = async (name, role) => (await d.uiFind({ windowId: CHROME, name, role, exact: true }))[0].id;
  const forYou = await id('For you', 'tab');
  const r = await d.uiAction({ id: forYou, action: 'press' });
  assert.equal(r.ok, true);
  assert.equal(r.role, 'tab');
  const tabs = await d.uiFind({ windowId: CHROME, role: 'tab' });
  assert.deepEqual(tabs.map((t) => [t.name, t.selected]), [['Worked on', false], ['For you', true], ['Starred', false]]);

  const box = await id('Show done', 'checkbox');
  await d.uiAction({ id: box });
  assert.equal((await d.uiFind({ windowId: CHROME, name: 'Show done' }))[0].checked, true);

  const search = await id('Search', 'textbox');
  assert.equal((await d.uiAction({ id: search, action: 'setValue', value: 'login' })).ok, true);
  assert.equal((await d.uiFind({ windowId: CHROME, name: 'Search', role: 'textbox' }))[0].value, 'login');
  assert.equal((await d.uiAction({ id: search, action: 'focus' })).ok, true);
  assert.equal((await d.uiFind({ windowId: CHROME, name: 'Search', role: 'textbox' }))[0].focused, true);

  const sort = await id('Sort by', 'combobox');
  assert.deepEqual(await d.uiAction({ id: sort, action: 'select', value: 'priority' }).then((x) => [x.ok, x.item]), [true, 'Priority']);
  assert.equal((await d.uiFind({ windowId: CHROME, name: 'Sort by' }))[0].value, 'Priority');
  assert.equal((await d.uiAction({ id: sort, action: 'expand' })).ok, true);
  assert.equal((await d.uiFind({ windowId: CHROME, name: 'Sort by' }))[0].expanded, true);
  assert.equal((await d.uiAction({ id: sort, action: 'setValue', value: 'Nope' })).ok, false);

  const del = await d.uiAction({ id: await id('Delete', 'button') });
  assert.deepEqual([del.ok, del.disabled], [false, true]);
  const canvas = await d.uiAction({ id: await id('Board canvas'), action: 'press' });
  assert.deepEqual([canvas.ok, canvas.method], [false, 'none']);
  assert.ok(canvas.bounds.width > 0, 'bounds come back for a fallback click');
  const zoom = await id('Zoom', 'slider');
  assert.equal((await d.uiAction({ id: zoom, action: 'setValue', value: 'big' })).ok, false);
  assert.equal((await d.uiAction({ id: zoom, action: 'setValue', value: 150 })).ok, true);

  await assert.rejects(d.uiAction({ id: `mock:${CHROME}:9.9.9` }), (e) => e.code === 'STALE');
  await assert.rejects(d.uiAction({ id: 'mock:0xdead:0' }), (e) => e.code === 'STALE');
  await assert.rejects(d.uiAction({ id: 'lx:0x1:w:0:abcdef' }), (e) => e.code === 'BAD_ARGS');
  await assert.rejects(d.uiAction({ id: forYou, action: 'dance' }), (e) => e.code === 'BAD_ARGS');
  assert.ok(d.state.uiLog.length >= 10);
  assert.deepEqual(d.state.uiLog[0], { id: forYou, action: 'press', ok: true });
});

test('mock setWindowBounds: bounds, maximize to its display, restore, minimize', async () => {
  const d = mock();
  const get = async (id) => (await d.listWindows()).find((w) => w.id === id);
  assert.equal(await d.setWindowBounds(CHROME, { state: 'maximize' }), true);
  assert.deepEqual(await get(CHROME).then((w) => [w.x, w.y, w.width, w.height]), [1920, 0, 1280, 1024]);
  assert.equal(await d.setWindowBounds(CHROME, { state: 'restore' }), true);
  assert.deepEqual(await get(CHROME).then((w) => [w.x, w.y, w.width, w.height]), [1920, 0, 1280, 1000]);
  assert.equal(await d.setWindowBounds('0x1003', { x: 10, width: 500 }), true);
  assert.deepEqual(await get('0x1003').then((w) => [w.x, w.y, w.width, w.height]), [10, 200, 500, 600]);
  assert.equal(await d.setWindowBounds('0x1003', { state: 'minimize' }), true);
  assert.equal((await get('0x1003')).minimized, true);
  assert.equal(await d.setWindowBounds('0xdead', { state: 'maximize' }), false);
  await assert.rejects(d.setWindowBounds(CHROME, { state: 'sideways' }), (e) => e.code === 'BAD_ARGS');
  assert.equal((await d.capabilities()).ui, true);
});

test('unsupported driver: UI methods throw UNSUPPORTED, capabilities report ui false', async () => {
  const d = osIndex.createUnsupportedDriver({ reason: 'no display', hint: 'Start X' });
  assert.equal((await d.capabilities()).ui, false);
  for (const m of ['uiTree', 'uiFind', 'uiAction', 'setWindowBounds']) {
    await assert.rejects(d[m]({}), (e) => e.code === 'UNSUPPORTED' && e.hint === 'Start X', m);
  }
});

// ---------------------------------------------------------------------------
// Computer
// ---------------------------------------------------------------------------

test('Computer.uiFind: shot rect and centre in the latest screenshot of the element\'s display', async () => {
  const d = mock();
  const c = computer(d);
  const before = await c.uiFind({ windowId: CHROME, name: 'For you' });
  // No screenshot of display 1 yet: display-local logical pixels.
  assert.deepEqual(before[0].shot, { x: 150, y: 160, width: 90, height: 36, cx: 195, cy: 178, display: 1 });
  assert.equal(before.window.id, CHROME, 'metadata is kept');
  assert.ok(!Object.keys(before).includes('window'));
  const shot = await c.screenshot({ display: 1 });
  assert.deepEqual([shot.width, shot.height], [960, 768]);
  const after = await c.uiFind({ windowId: CHROME, name: 'For you' });
  assert.deepEqual(after[0].shot, { x: 113, y: 120, width: 68, height: 27, cx: 146, cy: 134, display: 1 });
  assert.deepEqual(after[0].bounds, { x: 2070, y: 160, width: 90, height: 36 }, 'bounds stay logical');
  const tree = await c.uiTree({ windowId: CHROME });
  assert.deepEqual(tree.nodes.find((n) => n.name === 'For you').shot, after[0].shot);
  assert.equal(tree.nodes.find((n) => n.role === 'window').shot.display, 1);
});

test('Computer.uiFind: no shot for elements without size, off every display, or with relative bounds', async () => {
  const ui = {
    '0x1001': {
      role: 'window', name: 'W', bounds: { x: 0, y: 0, width: 500, height: 400 },
      children: [
        { role: 'button', name: 'Zero', bounds: { x: 10, y: 10, width: 0, height: 0 } },
        { role: 'button', name: 'Far away', bounds: { x: 9000, y: 9000, width: 20, height: 20 } },
        { role: 'button', name: 'Fine', bounds: { x: 10, y: 10, width: 20, height: 20 } },
      ],
    },
  };
  const d = mock({ ui, windows: [{ id: '0x1001', app: 'App', title: 'W', pid: 1, x: 0, y: 0, width: 500, height: 400, focused: true }] });
  const c = computer(d);
  const list = await c.uiFind({ role: 'button' });
  assert.deepEqual(list.map((m) => [m.name, m.shot ? m.shot.cx : null]), [['Zero', null], ['Far away', null], ['Fine', 20]]);
  const orig = d.uiFind;
  d.uiFind = async (o) => Object.defineProperty(await orig(o), 'relativeBounds', { value: true });
  const rel = await c.uiFind({ name: 'Fine' });
  assert.equal(rel[0].shot, null);
});

test('Computer.uiClick: accessibility press by name, guarded, result in screenshot space', async () => {
  const d = mock();
  const c = computer(d);
  await c.screenshot({ display: 1 });
  const r = await c.uiClick({ windowId: CHROME, name: 'For you', role: 'tab' });
  assert.deepEqual(
    { ok: r.ok, action: r.action, method: r.method, role: r.role, name: r.name, windowId: r.windowId, shot: r.shot },
    { ok: true, action: 'ui_click', method: 'mock:press', role: 'tab', name: 'For you', windowId: CHROME, shot: { x: 113, y: 120, width: 68, height: 27, cx: 146, cy: 134, display: 1 } },
  );
  assert.ok(!d.actions.some((a) => a.type === 'click'), 'no mouse click');
  // A text box gets focus instead of its default action.
  const t = await c.uiClick({ windowId: CHROME, name: 'Search', role: 'textbox' });
  assert.equal(t.method, 'mock:focus');
});

test('Computer.uiClick: the guard and the failsafe stop it before any action', async () => {
  const paused = mock();
  const c = computer(paused, { guard: async () => ({ allowed: false, reason: 'user pressed Stop' }) });
  await assert.rejects(c.uiClick({ windowId: CHROME, name: 'For you' }), (e) => e.code === 'PAUSED' && /Stop/.test(e.message));
  assert.equal(paused.state.uiLog.length, 0);
  const corner = mock({ cursor: { x: 0, y: 0 } });
  await assert.rejects(computer(corner).uiClick({ windowId: CHROME, name: 'For you' }), (e) => e.code === 'FAILSAFE');
  assert.equal(corner.state.uiLog.length, 0);
});

test('Computer.uiClick: no accessibility action -> real click at the element centre', async () => {
  const d = mock();
  const c = computer(d);
  const r = await c.uiClick({ windowId: CHROME, name: 'Board canvas' });
  assert.equal(r.method, 'click');
  assert.deepEqual(r.logical, { x: 2250, y: 550 });
  assert.equal(r.display, 1);
  assert.match(r.reason, /no default action/);
  const click = d.actions.find((a) => a.type === 'click');
  assert.deepEqual([click.x, click.y, click.button, click.clicks], [2250, 550, 'left', 1]);
});

test('Computer.uiClick: disabled, not found, ambiguous, stale and unknown positions', async () => {
  const d = mock();
  const c = computer(d);
  await assert.rejects(c.uiClick({ windowId: CHROME, name: 'Delete' }), (e) => e.code === 'DISABLED');
  await assert.rejects(c.uiClick({ windowId: CHROME, name: 'Launch rockets' }), (e) => e.code === 'NOT_FOUND' && /ui_tree/.test(e.hint));
  await assert.rejects(c.uiClick({}), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(c.uiClick({ id: `mock:${CHROME}:7.7` }), (e) => e.code === 'STALE');
  assert.ok(!d.actions.some((a) => a.type === 'click'));

  const ui = {
    '0x1001': {
      role: 'window', name: 'W', bounds: { x: 0, y: 0, width: 800, height: 600 },
      children: [
        { role: 'button', name: 'Close', bounds: { x: 10, y: 10, width: 20, height: 20 } },
        { role: 'button', name: 'Close', bounds: { x: 100, y: 10, width: 20, height: 20 } },
        { role: 'button', name: 'Close all', bounds: { x: 200, y: 10, width: 60, height: 20 } },
        { role: 'other', name: 'Paint', actions: [], bounds: { x: 300, y: 300, width: 50, height: 50 } },
      ],
    },
  };
  const two = mock({ ui, windows: [{ id: '0x1001', app: 'App', title: 'W', pid: 1, x: 0, y: 0, width: 800, height: 600, focused: true }] });
  const c2 = computer(two);
  await assert.rejects(c2.uiClick({ name: 'Close' }), (e) => e.code === 'AMBIGUOUS' && /mock:0x1001:0/.test(e.message) && /mock:0x1001:1/.test(e.message) && !/Close all/.test(e.message));
  assert.equal(two.state.uiLog.length, 0, 'nothing was pressed');
  assert.equal((await c2.uiClick({ name: 'Close all' })).ok, true, 'a unique whole-name match is fine');
  // Relative bounds (Wayland without window positions): no click by position.
  const orig = two.uiFind;
  two.uiFind = async (o) => Object.defineProperty(await orig(o), 'relativeBounds', { value: true });
  await assert.rejects(c2.uiClick({ name: 'Paint' }), (e) => e.code === 'UI_ACTION_FAILED' && /screenshot/.test(e.hint));
  assert.ok(!two.actions.some((a) => a.type === 'click'));
});

test('Computer.uiClick by id: works without a prior find, and the click fallback needs bounds', async () => {
  const d = mock();
  const c = computer(d);
  assert.equal((await c.uiClick({ id: `mock:${CHROME}:1.1.2` })).name, 'Starred');
  const orig = d.uiAction;
  d.uiAction = async (o) => {
    const r = await orig(o);
    delete r.bounds;
    return r;
  };
  await assert.rejects(c.uiClick({ id: `mock:${CHROME}:1.8` }), (e) => e.code === 'UI_ACTION_FAILED');
  await c.uiFind({ windowId: CHROME, name: 'Board canvas' });
  assert.equal((await c.uiClick({ id: `mock:${CHROME}:1.8` })).method, 'click', 'bounds remembered from uiFind');
});

test('Computer.uiSetValue: accessibility setValue, preferring fields over same-named controls', async () => {
  const ui = {
    '0x1001': {
      role: 'window', name: 'W', bounds: { x: 0, y: 0, width: 800, height: 600 },
      children: [
        { role: 'button', name: 'Search', bounds: { x: 10, y: 10, width: 60, height: 20 } },
        { role: 'textbox', name: 'Search', editable: true, value: '', bounds: { x: 100, y: 10, width: 200, height: 20 } },
      ],
    },
  };
  const d = mock({ ui, windows: [{ id: '0x1001', app: 'App', title: 'W', pid: 1, x: 0, y: 0, width: 800, height: 600, focused: true }] });
  const c = computer(d);
  const r = await c.uiSetValue({ name: 'Search', value: 'login timeout' });
  assert.deepEqual([r.ok, r.action, r.method, r.role, r.chars], [true, 'ui_set_value', 'mock:setValue', 'textbox', 13]);
  assert.equal(d.state.ui['0x1001'].children[1].value, 'login timeout');
  assert.equal(d.state.pressed.size, 0, 'the Search button was not pressed');
  await assert.rejects(c.uiSetValue({ name: 'Search' }), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(c.uiSetValue({ value: 'x' }), (e) => e.code === 'INVALID_INPUT');
});

test('Computer.uiSetValue: keyboard fallback (focus or click, select all, type / paste / delete)', async () => {
  const ui = {
    '0x1001': {
      role: 'window', name: 'W', bounds: { x: 0, y: 0, width: 800, height: 600 },
      children: [
        { role: 'textbox', name: 'Notes', editable: true, actions: ['focus'], bounds: { x: 10, y: 10, width: 300, height: 100 } },
        { role: 'other', name: 'Canvas field', actions: [], bounds: { x: 400, y: 300, width: 100, height: 40 } },
      ],
    },
  };
  const d = mock({ ui, windows: [{ id: '0x1001', app: 'App', title: 'W', pid: 1, x: 0, y: 0, width: 800, height: 600, focused: true }] });
  const c = computer(d);
  const typed = await c.uiSetValue({ name: 'Notes', value: 'hello' });
  assert.equal(typed.method, 'focus+select-all+type');
  const keys = d.actions.filter((a) => a.type === 'keyCombo' || a.type === 'typeText').map((a) => (a.type === 'typeText' ? `type:${a.text}` : a.keys.join('+')));
  assert.deepEqual(keys, ['ctrl+a', 'type:hello']);

  d.actions.length = 0;
  const cleared = await c.uiSetValue({ name: 'Notes', value: '' });
  assert.equal(cleared.method, 'focus+select-all+delete');
  assert.deepEqual(d.actions.filter((a) => a.type === 'keyCombo').map((a) => a.keys.join('+')), ['ctrl+a', 'delete']);

  d.actions.length = 0;
  const pasted = await c.uiSetValue({ name: 'Notes', value: 'line one\nline two' });
  assert.equal(pasted.method, 'focus+select-all+paste');
  assert.ok(d.state.typed.endsWith('line one\nline two'));

  d.actions.length = 0;
  const clicked = await c.uiSetValue({ name: 'Canvas field', value: '42' });
  assert.equal(clicked.method, 'click+select-all+type');
  assert.deepEqual(clicked.logical, { x: 450, y: 320 });
  assert.deepEqual(d.actions.filter((a) => a.type === 'click').map((a) => [a.x, a.y]), [[450, 320]]);
});

test('Computer.uiSetValue: no click by position when the driver says positions are window-relative', async () => {
  const d = mock();
  const orig = d.uiAction;
  d.uiAction = async (o) => ({ ...(await orig(o)), relativeBounds: true });
  const c = computer(d);
  await assert.rejects(c.uiSetValue({ id: `mock:${CHROME}:1.8`, value: 'x' }), (e) => e.code === 'UI_ACTION_FAILED');
  assert.ok(!d.actions.some((a) => a.type === 'click' || a.type === 'typeText'));
});

test('Computer.uiAction: guarded passthrough; a driver without UI support is UNSUPPORTED', async () => {
  const d = mock();
  const c = computer(d);
  const r = await c.uiAction({ id: `mock:${CHROME}:1.3`, action: 'expand' });
  assert.deepEqual([r.ok, r.action], [true, 'ui_expand']);
  const blocked = computer(mock(), { guard: async () => ({ allowed: false }) });
  await assert.rejects(blocked.uiAction({ id: `mock:${CHROME}:1.3`, action: 'expand' }), (e) => e.code === 'PAUSED');
  const plain = { name: 'plain', displays: async () => [{ x: 0, y: 0, width: 100, height: 100 }] };
  const pc = new Computer({ driver: plain, config: { actionDelayMs: 0 } });
  for (const m of ['uiFind', 'uiTree', 'uiClick', 'uiSetValue', 'uiAction']) {
    await assert.rejects(pc[m]({ id: 'x', name: 'x', value: 'v' }), (e) => e.code === 'UNSUPPORTED', m);
  }
});

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

function toolSet(driver, { guard, ext = {} } = {}) {
  const comp = computer(driver);
  const activity = [];
  let guardCalls = 0;
  const tools = uiTools.createTools({
    getComputer: async () => comp,
    checkGuard: async () => {
      guardCalls++;
      if (guard) await guard();
    },
    postActivity: (p) => activity.push(p),
    ...ext,
  });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { tools, by, comp, activity, guardCalls: () => guardCalls };
}

const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

test('tools-ui: four tools with schemas and annotations', () => {
  const { tools } = toolSet(mock());
  assert.deepEqual(tools.map((t) => t.name), ['ui_find', 'ui_tree', 'ui_click', 'ui_set_value']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.equal(typeof t.handler, 'function');
    assert.ok(t.description.length > 80, t.name);
  }
  const ro = Object.fromEntries(tools.map((t) => [t.name, t.annotations.readOnlyHint]));
  assert.deepEqual(ro, { ui_find: true, ui_tree: true, ui_click: false, ui_set_value: false });
  assert.deepEqual(tools.find((t) => t.name === 'ui_set_value').inputSchema.required, ['value']);
  for (const n of ['ui_click', 'ui_set_value']) assert.equal(tools.find((t) => t.name === n).inputSchema.properties.screenshotAfter.type, 'boolean');
});

test('ui_find: window by app or title, match lines with ids and screenshot points', async () => {
  const { by } = toolSet(mock());
  const res = await by.ui_find.handler({ name: 'For you', role: 'tab', window: 'chrome' });
  const text = textOf(res);
  assert.match(text, /^1 match for tab named "For you" in Google Chrome — "Cloud Run/);
  assert.match(text, /- tab "For you" at \(195, 178\) on display 1 · id mock:0x1002:1\.1\.1/);
  assert.match(textOf(await by.ui_find.handler({ name: 'Your work', window: 'Cloud Run' })), /heading "Your work"/);
  assert.match(textOf(await by.ui_find.handler({ name: 'For you', window: CHROME })), /window 0x1002/);
  const none = await by.ui_find.handler({ name: 'Rocket', window: 'chrome' });
  assert.ok(!none.isError);
  assert.match(textOf(none), /No element named "Rocket"/);
  const bad = await by.ui_find.handler({});
  assert.equal(bad.isError, true);
  await assert.rejects(by.ui_find.handler({ name: 'x', window: 'Photoshop' }), (e) => e.code === 'NOT_FOUND' && /Open windows:/.test(e.message) && /0x1002/.test(e.message));
});

test('ui_find: while the Claude Anywhere dialog has focus, the frontmost other window is used', async () => {
  const windows = [
    { id: '0x2001', app: 'Electron', title: 'Claude Anywhere', pid: 9, x: 0, y: 0, width: 400, height: 300, focused: true, stackIndex: 0 },
    { id: '0x2002', app: 'Firefox', title: 'Board - Jira', pid: 10, x: 0, y: 0, width: 800, height: 600, focused: false, stackIndex: 1 },
    { id: '0x2003', app: 'XTerm', title: 'bash', pid: 11, x: 0, y: 0, width: 800, height: 600, focused: false, stackIndex: 2 },
  ];
  const ui = {
    '0x2002': { role: 'window', name: 'Board - Jira', bounds: { x: 0, y: 0, width: 800, height: 600 }, children: [{ role: 'button', name: 'Create', bounds: { x: 10, y: 10, width: 60, height: 20 } }] },
  };
  const { by } = toolSet(mock({ windows, ui }));
  const text = textOf(await by.ui_find.handler({ name: 'Create' }));
  assert.match(text, /button "Create"/);
  assert.match(text, /Claude Anywhere dialog has focus/);
});

test('ui_tree: indented outline with ids, capped node count, header', async () => {
  const { by } = toolSet(mock());
  const text = textOf(await by.ui_tree.handler({ window: 'chrome' }));
  const lines = text.split('\n');
  assert.match(lines[0], /^UI tree of Google Chrome .* \(window 0x1002\): \d+ elements\. Each line: role "name"/);
  assert.match(text, /\n {2}tablist "Work views" \(330, 178\) · mock:0x1002:1\.1\n {4}tab "Worked on" \(85, 178\) \[selected\] · mock:0x1002:1\.1\.0/);
  assert.match(text, /combobox "Sort by" = "Updated" \(430, 235\) \[collapsed\]/);
  assert.match(text, /button "Delete" \(720, 235\) \[disabled\]/);
  const small = textOf(await by.ui_tree.handler({ window: 'chrome', maxNodes: 10 }));
  assert.equal(small.split('\n').length, 11);
  assert.match(small.split('\n')[0], /cut at the size/);
  const shallow = textOf(await by.ui_tree.handler({ window: 'chrome', depth: 1 }));
  assert.match(shallow, /tablist "Work views" \(330, 178\) … ·/);
  const big = uiTools.formatOutline(
    Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, role: 'text', name: `t${i}`, parent: i ? 'n0' : null, children: i ? [] : Array.from({ length: 499 }, (__, k) => `n${k + 1}`) })),
  );
  assert.equal(big.shown, uiTools.MAX_TREE_NODES);
});

test('ui_click: guard first, accessibility press, activity, screenshotAfter on the element display', async () => {
  const d = mock();
  const { by, activity, guardCalls } = toolSet(d);
  const res = await by.ui_click.handler({ name: 'For you', role: 'tab', window: 'chrome', screenshotAfter: true });
  assert.equal(guardCalls(), 1);
  assert.match(textOf(res), /^Pressed tab "For you" at \(195, 178\) on display 1 through accessibility \(mock:press\)\./);
  const img = res.content.find((b) => b.type === 'image');
  assert.ok(img && img.mimeType === 'image/png' && img.data.length > 100);
  assert.match(textOf(res), /Screenshot of display 1/);
  assert.ok(activity.some((a) => a.tool === 'ui_click' && a.ok && /Pressed tab "For you"/.test(a.summary)));
  assert.ok(activity.some((a) => a.tool === 'screenshot' && a.image));
  const plain = await by.ui_click.handler({ id: 'mock:0x1002:1.8' });
  assert.match(textOf(plain), /Clicked the centre of other "Board canvas" .* with the mouse \(no accessibility action/);
  assert.match(textOf(plain), /Take a screenshot/);
  assert.equal(plain.content.length, 1);
});

test('ui_click: a paused guard stops it; errors are posted as failed activity', async () => {
  const d = mock();
  const stop = new Error('Actions are paused');
  stop.code = 'PAUSED';
  const paused = toolSet(d, { guard: async () => { throw stop; } });
  await assert.rejects(paused.by.ui_click.handler({ name: 'For you', window: 'chrome' }), (e) => e.code === 'PAUSED');
  assert.equal(d.state.uiLog.length, 0);
  const { by, activity } = toolSet(mock());
  await assert.rejects(by.ui_click.handler({ name: 'Delete', window: 'chrome' }), (e) => e.code === 'DISABLED');
  assert.ok(activity.some((a) => a.tool === 'ui_click' && a.ok === false && /disabled/.test(a.error)));
  await assert.rejects(by.ui_click.handler({ window: 'chrome' }), (e) => e.code === 'INVALID_INPUT');
});

test('ui_click: ext.screenshotAfter is used when the core tools provide it', async () => {
  const calls = [];
  const { by } = toolSet(mock(), {
    ext: { screenshotAfter: async (o) => (calls.push(o), [{ type: 'text', text: 'core screenshot' }]) },
  });
  const res = await by.ui_click.handler({ name: 'For you', window: 'chrome', screenshotAfter: true });
  assert.deepEqual(calls, [{ display: 1 }]);
  assert.match(textOf(res), /core screenshot/);
});

test('ui_set_value: sets the field, reports how, posts activity', async () => {
  const d = mock();
  const { by, activity } = toolSet(d);
  const res = await by.ui_set_value.handler({ name: 'Search', value: 'login timeout', window: 'chrome' });
  assert.match(textOf(res), /^Set textbox "Search" to "login timeout": through accessibility \(mock:setValue\)\./);
  assert.equal((await d.uiFind({ windowId: CHROME, name: 'Search', role: 'textbox' }))[0].value, 'login timeout');
  assert.ok(activity.some((a) => a.tool === 'ui_set_value' && a.ok));
  const num = await by.ui_set_value.handler({ id: `mock:${CHROME}:1.10`, value: 125 });
  assert.match(textOf(num), /Set slider "Zoom" to "125"/);
  await assert.rejects(by.ui_set_value.handler({ value: 'x' }), (e) => e.code === 'INVALID_INPUT');
});

test('tools.js loads tools-ui once it is listed in TOOL_MODULES', (t) => {
  const core = require('../src/mcp/tools');
  if (!core.TOOL_MODULES.includes('tools-ui')) {
    t.skip('tools-ui is not in TOOL_MODULES yet (core tools change)');
    return;
  }
  const names = core.createTools({ computer: computer(mock()), getClient: async () => null }).map((x) => x.name);
  for (const n of ['ui_find', 'ui_tree', 'ui_click', 'ui_set_value']) assert.ok(names.includes(n), n);
});
