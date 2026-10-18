'use strict';

/**
 * Virtual assistant on Windows (and WSL): UI Automation (uiTree, uiFind, uiAction) and
 * setWindowBounds in src/os/win32.js and src/os/win32-host.ps1.
 *
 * - pure helpers of the driver;
 * - the driver over the fake PowerShell host (test/fixtures/fake-ps-host.js);
 * - timeouts derived from the walk budget (stub host);
 * - the real host's PowerShell and C# under pwsh, against stand-ins for System.Windows.Automation
 *   (UI Automation itself needs Windows): the compact tree, search ranking and popups, every action
 *   and its fallbacks, pending actions, id resolution by path with the role/name tag, JSON output.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const win32 = require('../src/os/win32');

const FAKE = path.join(__dirname, 'fixtures', 'fake-ps-host.js');
const PWSH = '/usr/local/bin/pwsh';
const HAS_PWSH = fs.existsSync(PWSH);
const ID_RE = /^-?\d+(\.\d+)*~[0-9a-z]{2}$/;

const tmpRoots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-desktop-win-'));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function fakeDriver(extra = {}, opts = {}) {
  const env = { ...process.env, ANYWHERE_PS_EXE: process.execPath, ANYWHERE_PS_ARGS: JSON.stringify([FAKE]), ...extra };
  return win32.createDriver({ wsl: false, env, ...opts });
}

async function requestsSeen(driver, cmd) {
  const r = await driver.host.request('__requests');
  return r.requests.filter((q) => !cmd || q.cmd === cmd);
}

/** AnywhereNative.UiTag in JavaScript (FNV-1a over UTF-16 units, two base-36 digits). */
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

// ---------------------------------------------------------------- pure helpers

test('normalizeUiRole accepts the shared vocabulary and common aliases', () => {
  assert.deepEqual(win32.UI_ROLES, [
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listitem', 'menuitem', 'menu', 'tab', 'tablist',
    'treeitem', 'image', 'text', 'heading', 'window', 'toolbar', 'group', 'table', 'row', 'cell', 'slider', 'other',
  ]);
  for (const r of win32.UI_ROLES) assert.equal(win32.normalizeUiRole(r), r);
  assert.equal(win32.normalizeUiRole('Button'), 'button');
  assert.equal(win32.normalizeUiRole('Edit'), 'textbox');
  assert.equal(win32.normalizeUiRole('text field'), 'textbox');
  assert.equal(win32.normalizeUiRole('Hyperlink'), 'link');
  assert.equal(win32.normalizeUiRole('list item'), 'listitem');
  assert.equal(win32.normalizeUiRole('menu_item'), 'menuitem');
  assert.equal(win32.normalizeUiRole('Radio Button'), 'radio');
  assert.equal(win32.normalizeUiRole('drop-down'), 'combobox');
  assert.equal(win32.normalizeUiRole('tab item'), 'tab');
  assert.throws(() => win32.normalizeUiRole('spaceship'), (e) => e.code === 'BAD_ARGS' && /button, link/.test(e.hint));
});

test('normalizeUiElementId accepts host ids only', () => {
  assert.equal(win32.normalizeUiElementId(' 1002.1.0~ab '), '1002.1.0~ab');
  assert.equal(win32.normalizeUiElementId('1002~zz'), '1002~zz');
  assert.equal(win32.normalizeUiElementId('1002.3'), '1002.3');
  for (const bad of ['', null, undefined, 'abc', '1002.~ab', '1002.1~ABC', '0x3ea.1~ab', '1002.1~a', '1002 .1~ab']) {
    assert.equal(win32.normalizeUiElementId(bad), null, String(bad));
  }
});

// ---------------------------------------------------------------- driver over the fake host

test('capabilities: ui is true with a UI Automation note, false when it does not load', async () => {
  let driver = await fakeDriver();
  try {
    const caps = await driver.capabilities();
    assert.equal(caps.ui, true);
    assert.ok(caps.notes.some((n) => /UI Automation/.test(n) && /--force-renderer-accessibility/.test(n)));
    assert.equal(caps.screenshot, true, 'the other capabilities are unchanged');
  } finally {
    await driver.close();
  }
  driver = await fakeDriver({ FAKE_PS_NO_UIA: '1' });
  try {
    const caps = await driver.capabilities();
    assert.equal(caps.ui, false);
    assert.equal(caps.mouse, true);
    assert.ok(caps.notes.some((n) => /UI Automation is not available/.test(n) && /UIAutomationClient/.test(n)));
  } finally {
    await driver.close();
  }
  driver = await fakeDriver({ FAKE_PS_EXIT_ON_START: '1' }, { lazy: true, maxRestarts: 0 });
  try {
    const caps = await driver.capabilities();
    assert.equal(caps.ui, false, 'a broken host reports ui: false too');
  } finally {
    await driver.close();
  }
});

test('uiTree: the active window by default, the shared node shape, pre-order with consistent links', async () => {
  const driver = await fakeDriver();
  try {
    const t = await driver.uiTree();
    assert.deepEqual(t.window, { id: '1001', app: 'Visual Studio Code', title: 'claude-anywhere - Visual Studio Code' });
    assert.deepEqual((await requestsSeen(driver, 'uitree'))[0].args, { depth: 6, maxNodes: 400, budgetMs: 3000, compact: true });

    const chrome = await driver.uiTree({ windowId: '0x3EA', depth: 3, maxNodes: 50 });
    assert.equal(chrome.window.id, '1002', 'hex window ids are normalized');
    assert.deepEqual((await requestsSeen(driver, 'uitree'))[1].args, { depth: 3, maxNodes: 50, budgetMs: 3000, compact: true, hwnd: '1002' });
    const nodes = chrome.nodes;
    assert.equal(nodes[0].role, 'window');
    assert.equal(nodes[0].parent, null);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    nodes.forEach((n, i) => {
      assert.match(n.id, ID_RE);
      assert.ok(win32.UI_ROLES.includes(n.role), n.role);
      assert.deepEqual(Object.keys(n.bounds), ['x', 'y', 'width', 'height']);
      assert.equal(typeof n.enabled, 'boolean');
      assert.equal(typeof n.focused, 'boolean');
      assert.ok(Array.isArray(n.children));
      if (i > 0) {
        const p = byId.get(n.parent);
        assert.ok(p, `parent of ${n.name}`);
        assert.ok(p.children.includes(n.id));
        assert.ok(nodes.indexOf(p) < i, 'parents come first');
      }
      for (const c of n.children) assert.equal(byId.get(c).parent, n.id);
    });
    const tab = nodes.find((n) => n.name === 'For you');
    assert.equal(tab.role, 'tab');
    assert.equal(tab.selected, false);
    assert.ok(tab.id.endsWith(`~${uiTag('tab', 'For you')}`), 'the id carries the role/name tag');
    const pw = nodes.find((n) => n.name === 'Password');
    assert.equal('value' in pw, false, 'password values are never reported');
    const deploy = nodes.find((n) => n.name === 'Deploy');
    assert.equal(deploy.enabled, false);
    assert.equal(deploy.description, 'Deploy a new revision');
    const box = nodes.find((n) => n.name === 'Remember me');
    assert.equal(box.checked, false);
    const off = nodes.find((n) => n.name === 'ABC-124 Login page copy');
    assert.equal(off.offscreen, true);
    assert.equal(chrome.truncated, false);

    const small = await driver.uiTree({ windowId: 1002, maxNodes: 4, depth: 1 });
    assert.equal(small.nodes.length, 3, 'depth 1: the window and its two children');
    const capped = await driver.uiTree({ windowId: 1002, maxNodes: 4 });
    assert.equal(capped.nodes.length, 4);
    assert.equal(capped.truncated, true);

    await assert.rejects(driver.uiTree({ windowId: 'chrome' }), (e) => e.code === 'BAD_ARGS' && /list_windows/.test(e.hint));
    await assert.rejects(driver.uiTree({ windowId: '4242' }), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(driver.uiTree({ depth: 'deep' }), (e) => e.code === 'BAD_ARGS');
    const limits = await driver.uiTree({ depth: 999, maxNodes: 0, budgetMs: 1 });
    assert.ok(limits.nodes.length >= 1);
    assert.deepEqual((await requestsSeen(driver, 'uitree')).pop().args, { depth: 60, maxNodes: 1, budgetMs: 100, compact: true });
  } finally {
    await driver.close();
  }
});

test('uiTree: an elevated window comes back with a warning', async () => {
  const driver = await fakeDriver();
  try {
    const t = await driver.uiTree({ windowId: '1003' });
    assert.equal(t.nodes[1].name, 'End task');
    assert.ok(t.warnings && /administrator/.test(t.warnings[0]));
  } finally {
    await driver.close();
  }
});

test('uiFind: name, exact, role, text, limit; best matches first; ids, paths and window ids', async () => {
  const driver = await fakeDriver();
  try {
    const forYou = await driver.uiFind({ windowId: '1002', name: '  FOR you ' });
    assert.ok(forYou.length >= 1);
    assert.deepEqual(Object.keys(forYou[0]).slice(0, 4), ['id', 'role', 'name', 'value']);
    assert.equal(forYou[0].name, 'For you');
    assert.equal(forYou[0].role, 'tab');
    assert.equal(forYou[0].value, null);
    assert.equal(forYou[0].windowId, '1002');
    assert.equal(forYou[0].path, 'window "Cloud Run - Google Cloud console - Goog..." > group "Cloud Run - Google Cloud console" > tablist "Work tabs"', 'long names are shortened');
    assert.match(forYou[0].id, ID_RE);
    assert.equal(forYou.truncated, false, 'metadata rides along');
    assert.deepEqual(forYou.window, { id: '1002', app: 'Google Chrome', title: 'Cloud Run - Google Cloud console - Google Chrome' });
    assert.equal(JSON.stringify(forYou).includes('truncated'), false, 'metadata is not enumerable');
    assert.deepEqual((await requestsSeen(driver, 'uifind'))[0].args, { exact: false, limit: 20, budgetMs: 3000, name: 'FOR you', hwnd: '1002' });

    const links = await driver.uiFind({ windowId: '1002', name: 'abc-12', role: 'Hyperlink' });
    assert.deepEqual(links.map((m) => m.name), ['ABC-123 Fix login timeout', 'ABC-124 Login page copy'], 'on-screen first');
    assert.equal(links[1].offscreen, true);
    assert.deepEqual((await requestsSeen(driver, 'uifind'))[1].args.role, ['link']);

    assert.deepEqual((await driver.uiFind({ windowId: '1002', name: 'for', exact: true })).length, 0);
    const text = await driver.uiFind({ windowId: '1002', text: 'cloud.google.com/run' });
    assert.deepEqual(text.map((m) => m.name).sort(), ['Address and search bar', 'Cloud Run - Google Cloud console']);
    assert.equal(text.find((m) => m.role === 'textbox').value, 'console.cloud.google.com/run');
    assert.equal((await driver.uiFind({ windowId: '1002', text: 'revision' }))[0].name, 'Deploy', 'text looks at descriptions');
    const two = await driver.uiFind({ windowId: '1002', role: ['button', 'link'], limit: 2 });
    assert.equal(two.length, 2);
    const both = await driver.uiFind({ windowId: '1002', role: 'tab|checkbox' });
    assert.deepEqual(both.map((m) => m.role).sort(), ['checkbox', 'tab', 'tab']);

    const active = await driver.uiFind({ name: 'editor' });
    assert.equal(active[0].windowId, '1001', 'the active window by default');
    assert.equal(active[0].value, 'const x = 1;');

    await assert.rejects(driver.uiFind({}), (e) => e.code === 'BAD_ARGS' && /name, text or role/.test(e.message));
    await assert.rejects(driver.uiFind({ name: '   ' }), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(driver.uiFind({ role: 'spaceship' }), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(driver.uiFind({ name: 'x', windowId: {} }), (e) => e.code === 'BAD_ARGS');
    assert.equal((await requestsSeen(driver, 'uifind')).length, 8, 'invalid searches never reach the host');
  } finally {
    await driver.close();
  }
});

test('uiAction: press, setValue, select, expand/collapse, focus, scrollIntoView, showMenu', async () => {
  const driver = await fakeDriver();
  try {
    const find = async (name) => (await driver.uiFind({ windowId: '1002', name, exact: true }))[0];

    const tab = await find('For you');
    const pressed = await driver.uiAction({ id: tab.id, action: 'press' });
    assert.deepEqual(pressed, { ok: true, method: 'select', role: 'tab', name: 'For you', bounds: tab.bounds });
    assert.equal((await find('For you')).selected, true);
    assert.equal((await find('Recent')).selected, false);

    assert.equal((await driver.uiAction({ id: (await find('ABC-123 Fix login timeout')).id })).method, 'invoke', 'press is the default');
    const box = await find('Remember me');
    assert.equal((await driver.uiAction({ id: box.id, action: 'PRESS' })).method, 'toggle');
    assert.equal((await find('Remember me')).checked, true);

    const addr = await find('Address and search bar');
    const set = await driver.uiAction({ id: addr.id, action: 'setvalue', value: 'example.com/a' });
    assert.equal(set.ok, true);
    assert.equal(set.method, 'value');
    assert.equal(set.value, 'example.com/a');
    const ro = await driver.uiAction({ id: (await find('Build log')).id, action: 'setValue', value: 'x' });
    assert.deepEqual([ro.ok, ro.method, ro.reason], [false, 'none', 'The element is read-only.']);
    const range = await driver.uiAction({ id: (await find('Instances')).id, action: 'setValue', value: 5 });
    assert.deepEqual([range.ok, range.method, range.value], [true, 'range', '5']);
    const pw = await driver.uiAction({ id: (await find('Password')).id, action: 'setValue', value: 'hunter2' });
    assert.equal(pw.ok, true);
    assert.equal('value' in pw, false, 'a password is not echoed back');

    const region = await find('Region');
    const sel = await driver.uiAction({ id: region.id, action: 'select', value: 'europe' });
    assert.equal(sel.ok, true);
    assert.equal(sel.item.name, 'europe-west1');
    assert.equal(sel.item.role, 'listitem');
    assert.match(sel.item.id, ID_RE);
    assert.equal(sel.value, 'europe-west1');
    const miss = await driver.uiAction({ id: region.id, action: 'select', value: 'mars-1' });
    assert.deepEqual([miss.ok, miss.method], [false, 'none']);
    assert.match(miss.reason, /mars-1/);

    const more = await find('More actions');
    assert.equal((await driver.uiAction({ id: more.id, action: 'expand' })).method, 'expand');
    assert.equal((await find('More actions')).expanded, true);
    assert.equal((await driver.uiAction({ id: more.id, action: 'collapse' })).method, 'collapse');
    assert.equal((await driver.uiAction({ id: more.id, action: 'showMenu' })).method, 'expand', 'a menu button opens its menu');
    assert.equal((await driver.uiAction({ id: addr.id, action: 'showmenu' })).method, 'keyboard', 'else focus + Shift+F10');
    assert.equal((await driver.uiAction({ id: addr.id, action: 'focus' })).method, 'focus');
    assert.equal((await find('Address and search bar')).focused, true);
    const scrolled = await driver.uiAction({ id: (await find('ABC-124 Login page copy')).id, action: 'scrollIntoView' });
    assert.equal(scrolled.method, 'scrollIntoView');
    assert.equal((await find('ABC-124 Login page copy')).offscreen, undefined);

    const disabled = await driver.uiAction({ id: (await find('Deploy')).id });
    assert.deepEqual([disabled.ok, disabled.method, disabled.disabled], [false, 'none', true]);
    const none = await driver.uiAction({ id: (await find('Your work')).id });
    assert.deepEqual([none.ok, none.method], [false, 'none'], 'ok:false tells the caller to click instead');
    assert.ok(none.bounds, 'with the bounds to click');

    const { log } = await driver.host.request('__uilog');
    assert.deepEqual(log.slice(0, 6), ['select:For you', 'invoke:ABC-123 Fix login timeout', 'toggle:Remember me', 'value:Address and search bar=example.com/a', 'range:Instances=5', 'value:Password=***']);
    const actions = (await requestsSeen(driver, 'uiaction')).map((r) => r.args);
    assert.deepEqual(actions[1], { id: (await find('ABC-123 Fix login timeout')).id, action: 'press' });
    assert.deepEqual(actions[3], { id: addr.id, action: 'setValue', value: 'example.com/a' });
    assert.deepEqual(actions[5].value, '5', 'values are sent as strings');
  } finally {
    await driver.close();
  }
});

test('uiAction: bad ids and actions fail before the host; stale ids, UIPI and other accounts', async () => {
  const driver = await fakeDriver();
  try {
    await assert.rejects(driver.uiAction({ id: 'Save button' }), (e) => e.code === 'BAD_ARGS' && /uiFind/.test(e.hint));
    await assert.rejects(driver.uiAction({ id: '1002.0~ab', action: 'click' }), (e) => e.code === 'BAD_ARGS' && /press, focus/.test(e.hint));
    await assert.rejects(driver.uiAction({ id: '1002.0~ab', action: 'setValue' }), (e) => e.code === 'BAD_ARGS' && /value/.test(e.message));
    assert.equal((await requestsSeen(driver, 'uiaction')).length, 0);

    const [reload] = await driver.uiFind({ windowId: '1002', name: 'Reload' });
    const renamed = await driver.host.request('__uimutate', { id: reload.id, name: 'Stop loading' });
    await assert.rejects(driver.uiAction({ id: reload.id }), (e) => e.code === 'STALE_ELEMENT' && /again/.test(e.hint));
    assert.equal((await driver.uiAction({ id: renamed.id })).ok, true, 'the new id works');
    await assert.rejects(driver.uiAction({ id: '1002.9.9~ab' }), (e) => e.code === 'STALE_ELEMENT');
    await assert.rejects(driver.uiAction({ id: '4242.0~ab' }), (e) => e.code === 'NOT_FOUND');

    const [endTask] = await driver.uiFind({ windowId: '1003', name: 'End task' });
    await assert.rejects(driver.uiAction({ id: endTask.id }), (e) => e.code === 'UIPI_BLOCKED' && /administrator/.test(e.message));
    const [next] = await driver.uiFind({ windowId: '1004', name: 'Next' });
    const r = await driver.uiAction({ id: next.id });
    assert.equal(r.ok, true);
    assert.ok(r.warnings && /another user account/.test(r.warnings[0]), "another account's window: done, with a warning");
  } finally {
    await driver.close();
  }
});

test('setWindowBounds: bounds, partial bounds, states, and refusals', async () => {
  const driver = await fakeDriver();
  try {
    const win = async (id) => (await driver.listWindows()).find((w) => w.id === id);
    assert.equal(await driver.setWindowBounds('1001', { x: 2, y: 3, width: 40, height: 30 }), true);
    assert.deepEqual(await win('1001').then((w) => [w.x, w.y, w.width, w.height]), [2, 3, 40, 30]);
    assert.equal(await driver.setWindowBounds(1001, { x: 5.4 }), true);
    assert.deepEqual(await win('1001').then((w) => [w.x, w.y, w.width, w.height]), [5, 3, 40, 30]);

    assert.equal(await driver.setWindowBounds('0x3E9', { state: 'maximize' }), true);
    assert.deepEqual(await win('1001').then((w) => [w.x, w.y, w.width, w.height]), [0, 0, 64, 40]);
    assert.equal(await driver.setWindowBounds('1001', { state: 'Restore' }), true);
    assert.deepEqual(await win('1001').then((w) => [w.x, w.y, w.width, w.height]), [5, 3, 40, 30]);
    assert.equal(await driver.setWindowBounds('1001', { state: 'fullscreen' }), true);
    assert.equal(await driver.setWindowBounds('1001', { state: 'restore', x: 1, y: 1 }), true, 'restore combines with bounds');
    assert.deepEqual(await win('1001').then((w) => [w.x, w.y, w.width, w.height]), [1, 1, 40, 30]);
    assert.equal(await driver.setWindowBounds('1002', { state: 'minimize' }), true);
    assert.equal((await win('1002')).minimized, true);

    const sent = (await requestsSeen(driver, 'winbounds')).map((r) => r.args);
    assert.deepEqual(sent[0], { x: 2, y: 3, width: 40, height: 30, hwnd: '1001' });
    assert.deepEqual(sent[1], { x: 5, hwnd: '1001' });
    assert.deepEqual(sent[4], { state: 'maximize', hwnd: '1001' }, 'fullscreen maximizes');

    assert.equal(await driver.setWindowBounds('1003', { width: 10, height: 10 }), false, 'an elevated window refuses');
    assert.equal(await driver.setWindowBounds('4242', { state: 'maximize' }), false);
    assert.equal(await driver.setWindowBounds('not-an-id', { state: 'maximize' }), false);
    await assert.rejects(driver.setWindowBounds('1001', { state: 'sideways' }), (e) => e.code === 'BAD_ARGS' && /maximize/.test(e.hint));
    await assert.rejects(driver.setWindowBounds('1001', { state: 'maximize', width: 5 }), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(driver.setWindowBounds('1001', { width: 0 }), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(driver.setWindowBounds('1001', {}), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(driver.setWindowBounds('1001', null), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(driver.setWindowBounds('1001', { x: 'left' }), (e) => e.code === 'BAD_ARGS');
    assert.equal((await requestsSeen(driver, 'winbounds')).length, 9, 'invalid requests never reach the host');
  } finally {
    await driver.close();
  }
});

test('transport: UI reads are retried once after a crash; actions are not', async () => {
  const dir = tmpDir();
  const state = path.join(dir, 'state.json');
  let driver = await fakeDriver({ FAKE_PS_CRASH_ON: 'uitree,uifind', FAKE_PS_CRASH_ONCE: '1', FAKE_PS_STATE: state });
  try {
    const t = await driver.uiTree({ windowId: '1002' });
    assert.equal(t.window.id, '1002');
    assert.ok((await driver.uiFind({ windowId: '1002', name: 'Back' })).length);
  } finally {
    await driver.close();
  }
  driver = await fakeDriver({ FAKE_PS_CRASH_ON: 'uiaction' });
  try {
    await assert.rejects(driver.uiAction({ id: '1002.0.0~pa' }), (e) => e.code === 'HOST_EXITED');
  } finally {
    await driver.close();
  }
});

test('timeouts: a walk may take its budget plus a margin; actions and bounds have their own limits', async () => {
  const calls = [];
  const stub = {
    timeoutMs: 8000,
    async request(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      if (cmd === 'uitree') return { window: { id: '7', app: 'A', title: 'T' }, nodes: [{ id: '7~aa', role: 'spaceship', name: 'x', parent: null, children: [] }] };
      if (cmd === 'uifind') return { matches: [{ id: '7.0~bb', role: 'button', name: 'Go', bounds: { x: 1.4, y: 2, width: -3, height: 'x' }, windowId: 7, path: '' }] };
      if (cmd === 'uiaction') return { ok: 1, method: '', item: { id: '7.0.1~cc', role: 'listitem', name: 'A' }, bounds: { x: 1, y: 2, width: 3, height: 4 } };
      return { ok: true };
    },
  };
  const d = new win32.Win32Driver(stub);
  const t = await d.uiTree({ budgetMs: 5000 });
  assert.equal(calls[0].opts.timeoutMs, 15000);
  assert.equal(t.nodes[0].role, 'other', 'unknown roles become other');
  await d.uiTree({ budgetMs: 1e9 });
  assert.equal(calls[1].args.budgetMs, 15000);
  assert.equal(calls[1].opts.timeoutMs, 25000);
  const [m] = await d.uiFind({ name: 'go' });
  assert.equal(calls[2].opts.timeoutMs, 13000);
  assert.deepEqual(m.bounds, { x: 1, y: 2, width: 0, height: 0 });
  assert.equal(m.windowId, '7');
  const a = await d.uiAction({ id: '7.0~bb', action: 'select', value: 'A' });
  assert.equal(calls[3].opts.timeoutMs, 20000);
  assert.deepEqual(a, { ok: true, method: 'none', item: { id: '7.0.1~cc', role: 'listitem', name: 'A' }, bounds: { x: 1, y: 2, width: 3, height: 4 } });
  await d.setWindowBounds('7', { state: 'max' });
  assert.equal(calls[4].opts.timeoutMs, 10000);
  assert.deepEqual(calls[4].args, { state: 'maximize', hwnd: '7' });
});

// ---------------------------------------------------------------- the real host under pwsh

// Stand-ins for System.Windows.Automation (UIAutomationClient/Types, WindowsBase's Rect) with the
// members the host uses, so its walk, search and actions run on any OS.
const FAKE_UIA_CS = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Threading;

namespace System.Windows {
  public struct Rect {
    double x, y, w, h; bool empty;
    public Rect(double x, double y, double width, double height) { this.x = x; this.y = y; w = width; h = height; empty = false; }
    public static Rect Empty { get { Rect r = new Rect(double.PositiveInfinity, double.PositiveInfinity, double.NegativeInfinity, double.NegativeInfinity); r.empty = true; return r; } }
    public double X { get { return x; } }
    public double Y { get { return y; } }
    public double Width { get { return w; } }
    public double Height { get { return h; } }
    public bool IsEmpty { get { return empty; } }
  }
}

namespace System.Windows.Automation {
  public class AutomationIdentifier {
    public int Id { get; private set; }
    public string ProgrammaticName { get; private set; }
    protected AutomationIdentifier(int id, string name) { Id = id; ProgrammaticName = name; }
  }
  public sealed class AutomationProperty : AutomationIdentifier { internal AutomationProperty(int id, string name) : base(id, name) { } }
  public sealed class AutomationPattern : AutomationIdentifier { internal AutomationPattern(int id, string name) : base(id, name) { } }
  public sealed class ControlType : AutomationIdentifier { internal ControlType(int id) : base(id, "ControlType." + id) { } }
  public class Condition { }
  public static class Automation { public static readonly Condition ControlViewCondition = new Condition(); }
  [Flags] public enum TreeScope { Element = 1, Children = 2, Descendants = 4, Subtree = 7, Parent = 8, Ancestors = 16 }
  public enum AutomationElementMode { None = 0, Full = 1 }
  public enum ToggleState { Off = 0, On = 1, Indeterminate = 2 }
  public enum ExpandCollapseState { Collapsed = 0, Expanded = 1, PartiallyExpanded = 2, LeafNode = 3 }
  public class ElementNotAvailableException : SystemException { public ElementNotAvailableException() : base("The target element corresponds to UI that is no longer available.") { } }
  public class ElementNotEnabledException : InvalidOperationException { public ElementNotEnabledException() : base("The target element is not enabled.") { } }

  public sealed class CacheRequest {
    public readonly List<object> Items = new List<object>();
    public CacheRequest() { TreeScope = TreeScope.Element; TreeFilter = Automation.ControlViewCondition; AutomationElementMode = AutomationElementMode.Full; }
    public void Add(AutomationProperty p) { Items.Add(p); }
    public void Add(AutomationPattern p) { Items.Add(p); }
    public TreeScope TreeScope { get; set; }
    public Condition TreeFilter { get; set; }
    public AutomationElementMode AutomationElementMode { get; set; }
  }

  public sealed class AutomationElementCollection : IEnumerable {
    readonly List<AutomationElement> items;
    internal AutomationElementCollection(List<AutomationElement> items) { this.items = items; }
    public int Count { get { return items.Count; } }
    public AutomationElement this[int index] { get { return items[index]; } }
    public IEnumerator GetEnumerator() { return items.GetEnumerator(); }
  }

  public sealed class InvokePattern {
    public static readonly AutomationPattern Pattern = new AutomationPattern(10000, "InvokePatternIdentifiers.Pattern");
    internal AutomationElement El;
    public void Invoke() { El.Act("invoke", null); }
  }
  public sealed class ValuePattern {
    public static readonly AutomationPattern Pattern = new AutomationPattern(10002, "ValuePatternIdentifiers.Pattern");
    public static readonly AutomationProperty ValueProperty = new AutomationProperty(30045, "ValuePatternIdentifiers.ValueProperty");
    public static readonly AutomationProperty IsReadOnlyProperty = new AutomationProperty(30046, "ValuePatternIdentifiers.IsReadOnlyProperty");
    internal AutomationElement El;
    public void SetValue(string value) { El.Act("value", value); El.Value = value; }
  }
  public sealed class RangeValuePattern {
    public static readonly AutomationPattern Pattern = new AutomationPattern(10003, "RangeValuePatternIdentifiers.Pattern");
    public static readonly AutomationProperty ValueProperty = new AutomationProperty(30047, "RangeValuePatternIdentifiers.ValueProperty");
    internal AutomationElement El;
    public void SetValue(double value) { El.Act("range", value.ToString(System.Globalization.CultureInfo.InvariantCulture)); El.Range = value; }
  }
  public sealed class TogglePattern {
    public static readonly AutomationPattern Pattern = new AutomationPattern(10015, "TogglePatternIdentifiers.Pattern");
    public static readonly AutomationProperty ToggleStateProperty = new AutomationProperty(30086, "TogglePatternIdentifiers.ToggleStateProperty");
    internal AutomationElement El;
    public void Toggle() { El.Act("toggle", null); El.Toggle = El.Toggle == 1 ? 0 : 1; }
  }
  public sealed class SelectionItemPattern {
    public static readonly AutomationPattern Pattern = new AutomationPattern(10010, "SelectionItemPatternIdentifiers.Pattern");
    public static readonly AutomationProperty IsSelectedProperty = new AutomationProperty(30079, "SelectionItemPatternIdentifiers.IsSelectedProperty");
    internal AutomationElement El;
    public void Select() {
      El.Act("select", null);
      if (El.Parent != null) foreach (AutomationElement s in El.Parent.Kids) if (s.Selected >= 0) s.Selected = 0;
      El.Selected = 1;
      for (AutomationElement p = El.Parent; p != null; p = p.Parent) if (p.TypeId == 50003) { p.Value = El.Name; break; }
    }
  }
  public sealed class ExpandCollapsePattern {
    public static readonly AutomationPattern Pattern = new AutomationPattern(10005, "ExpandCollapsePatternIdentifiers.Pattern");
    public static readonly AutomationProperty ExpandCollapseStateProperty = new AutomationProperty(30070, "ExpandCollapsePatternIdentifiers.ExpandCollapseStateProperty");
    internal AutomationElement El;
    public void Expand() { El.Act("expand", null); El.Expand = 1; }
    public void Collapse() { El.Act("collapse", null); El.Expand = 0; }
  }
  public sealed class ScrollItemPattern {
    public static readonly AutomationPattern Pattern = new AutomationPattern(10017, "ScrollItemPatternIdentifiers.Pattern");
    internal AutomationElement El;
    public void ScrollIntoView() { El.Act("scroll", null); El.Offscreen = false; }
  }

  public sealed class AutomationElement {
    public static readonly object NotSupported = new object();
    public static readonly AutomationProperty NameProperty = new AutomationProperty(30005, "AutomationElementIdentifiers.NameProperty");
    public static readonly AutomationProperty ControlTypeProperty = new AutomationProperty(30003, "AutomationElementIdentifiers.ControlTypeProperty");
    public static readonly AutomationProperty LocalizedControlTypeProperty = new AutomationProperty(30004, "AutomationElementIdentifiers.LocalizedControlTypeProperty");
    public static readonly AutomationProperty BoundingRectangleProperty = new AutomationProperty(30001, "AutomationElementIdentifiers.BoundingRectangleProperty");
    public static readonly AutomationProperty IsEnabledProperty = new AutomationProperty(30010, "AutomationElementIdentifiers.IsEnabledProperty");
    public static readonly AutomationProperty HasKeyboardFocusProperty = new AutomationProperty(30008, "AutomationElementIdentifiers.HasKeyboardFocusProperty");
    public static readonly AutomationProperty IsOffscreenProperty = new AutomationProperty(30022, "AutomationElementIdentifiers.IsOffscreenProperty");
    public static readonly AutomationProperty HelpTextProperty = new AutomationProperty(30013, "AutomationElementIdentifiers.HelpTextProperty");
    public static readonly AutomationProperty IsPasswordProperty = new AutomationProperty(30019, "AutomationElementIdentifiers.IsPasswordProperty");
    public static readonly AutomationProperty IsInvokePatternAvailableProperty = new AutomationProperty(30031, "AutomationElementIdentifiers.IsInvokePatternAvailableProperty");
    public static readonly AutomationProperty IsTogglePatternAvailableProperty = new AutomationProperty(30041, "AutomationElementIdentifiers.IsTogglePatternAvailableProperty");
    public static readonly AutomationProperty IsSelectionItemPatternAvailableProperty = new AutomationProperty(30036, "AutomationElementIdentifiers.IsSelectionItemPatternAvailableProperty");
    public static readonly AutomationProperty IsExpandCollapsePatternAvailableProperty = new AutomationProperty(30028, "AutomationElementIdentifiers.IsExpandCollapsePatternAvailableProperty");
    public static readonly AutomationProperty IsValuePatternAvailableProperty = new AutomationProperty(30043, "AutomationElementIdentifiers.IsValuePatternAvailableProperty");
    public static readonly AutomationProperty IsRangeValuePatternAvailableProperty = new AutomationProperty(30033, "AutomationElementIdentifiers.IsRangeValuePatternAvailableProperty");

    public static Dictionary<long, AutomationElement> Roots = new Dictionary<long, AutomationElement>();
    public static List<string> Log = new List<string>();
    public static int Visits;
    public static int DelayMs;

    // Live element data.
    public int TypeId = 50033;
    public string Name = "";
    public string LocalType = "";
    public double X, Y, W = 10, H = 10;
    public bool HasRect = true, Enabled = true, Focused, Offscreen, Password, ReadOnly, Gone, Focusable = true;
    public string Help = "";
    public string Value;
    public double? Range;
    public int Toggle = -1, Selected = -1, Expand = -1;
    public int ActionDelayMs;
    public string FailWith;
    public List<string> Patterns = new List<string>();
    public List<AutomationElement> Kids = new List<AutomationElement>();
    public AutomationElement Parent;

    // A snapshot from GetUpdatedCache.
    AutomationElement live;
    Dictionary<AutomationProperty, object> cache;
    List<AutomationElement> cachedKids;

    public static AutomationElement NewRoot(long hwnd, string name) {
      AutomationElement e = new AutomationElement(); e.TypeId = 50032; e.Name = name; e.W = 800; e.H = 600; Roots[hwnd] = e; return e;
    }
    public static void Reset() { Roots.Clear(); Log.Clear(); Visits = 0; DelayMs = 0; }

    public AutomationElement Add(int typeId, string name) {
      AutomationElement c = new AutomationElement(); c.TypeId = typeId; c.Name = name; c.Parent = this;
      c.X = X + 1 + Kids.Count * 12; c.Y = Y + 20; c.W = 10; c.H = 8;
      Kids.Add(c); return c;
    }
    public AutomationElement With(string patterns) { foreach (string p in patterns.Split(',')) if (p.Length > 0) Patterns.Add(p); return this; }

    AutomationElement Live { get { return live ?? this; } }

    public static AutomationElement FromHandle(IntPtr hwnd) {
      AutomationElement e;
      if (Roots.TryGetValue(hwnd.ToInt64(), out e) && !e.Gone) return e;
      throw new ElementNotAvailableException();
    }

    public AutomationElement GetUpdatedCache(CacheRequest request) {
      AutomationElement L = Live;
      if (L.Gone) throw new ElementNotAvailableException();
      Visits++;
      if (DelayMs > 0) Thread.Sleep(DelayMs);
      AutomationElement s = Snapshot(L, request);
      if ((request.TreeScope & TreeScope.Children) != 0) {
        s.cachedKids = new List<AutomationElement>();
        foreach (AutomationElement k in L.Kids) s.cachedKids.Add(Snapshot(k, request));
      }
      return s;
    }

    static AutomationElement Snapshot(AutomationElement L, CacheRequest request) {
      AutomationElement s = new AutomationElement();
      s.live = L;
      s.cache = new Dictionary<AutomationProperty, object>();
      foreach (object p in request.Items) { AutomationProperty ap = p as AutomationProperty; if (ap != null) s.cache[ap] = L.Read(ap); }
      return s;
    }

    bool Has(string p) { return Patterns.Contains(p); }

    object Read(AutomationProperty p) {
      if (p == NameProperty) return Name;
      if (p == ControlTypeProperty) return new ControlType(TypeId);
      if (p == LocalizedControlTypeProperty) return LocalType;
      if (p == BoundingRectangleProperty) return HasRect ? new System.Windows.Rect(X, Y, W, H) : System.Windows.Rect.Empty;
      if (p == IsEnabledProperty) return Enabled;
      if (p == HasKeyboardFocusProperty) return Focused;
      if (p == IsOffscreenProperty) return Offscreen;
      if (p == HelpTextProperty) return Help;
      if (p == IsPasswordProperty) return Password;
      if (p == IsInvokePatternAvailableProperty) return Has("invoke");
      if (p == IsTogglePatternAvailableProperty) return Has("toggle");
      if (p == IsSelectionItemPatternAvailableProperty) return Has("select");
      if (p == IsExpandCollapsePatternAvailableProperty) return Has("expand");
      if (p == IsValuePatternAvailableProperty) return Has("value");
      if (p == IsRangeValuePatternAvailableProperty) return Has("range");
      if (p == ValuePattern.ValueProperty) return Has("value") ? (object)(Value ?? "") : NotSupported;
      if (p == ValuePattern.IsReadOnlyProperty) return Has("value") ? (object)ReadOnly : NotSupported;
      if (p == TogglePattern.ToggleStateProperty) return Has("toggle") ? (object)(ToggleState)Math.Max(0, Toggle) : NotSupported;
      if (p == SelectionItemPattern.IsSelectedProperty) return Has("select") ? (object)(Selected == 1) : NotSupported;
      if (p == ExpandCollapsePattern.ExpandCollapseStateProperty) return Has("expand") ? (object)(ExpandCollapseState)Math.Max(0, Expand) : NotSupported;
      if (p == RangeValuePattern.ValueProperty) return Has("range") ? (object)(Range ?? 0.0) : NotSupported;
      return NotSupported;
    }

    public AutomationElementCollection CachedChildren {
      get { if (cachedKids == null) throw new InvalidOperationException("Children were not cached."); return new AutomationElementCollection(cachedKids); }
    }

    public object GetCachedPropertyValue(AutomationProperty property) { return GetCachedPropertyValue(property, false); }

    public object GetCachedPropertyValue(AutomationProperty property, bool ignoreDefaultValue) {
      if (cache == null || !cache.ContainsKey(property)) throw new InvalidOperationException("The property was not cached: " + property.ProgrammaticName);
      object v = cache[property];
      if (v == NotSupported && !ignoreDefaultValue) return null;
      return v;
    }

    public bool TryGetCurrentPattern(AutomationPattern pattern, out object patternObject) {
      AutomationElement L = Live;
      if (L.Gone) throw new ElementNotAvailableException();
      patternObject = null;
      if (pattern == InvokePattern.Pattern && L.Has("invoke")) { InvokePattern x = new InvokePattern(); x.El = L; patternObject = x; }
      else if (pattern == ValuePattern.Pattern && L.Has("value")) { ValuePattern x = new ValuePattern(); x.El = L; patternObject = x; }
      else if (pattern == RangeValuePattern.Pattern && L.Has("range")) { RangeValuePattern x = new RangeValuePattern(); x.El = L; patternObject = x; }
      else if (pattern == TogglePattern.Pattern && L.Has("toggle")) { TogglePattern x = new TogglePattern(); x.El = L; patternObject = x; }
      else if (pattern == SelectionItemPattern.Pattern && L.Has("select")) { SelectionItemPattern x = new SelectionItemPattern(); x.El = L; patternObject = x; }
      else if (pattern == ExpandCollapsePattern.Pattern && L.Has("expand")) { ExpandCollapsePattern x = new ExpandCollapsePattern(); x.El = L; patternObject = x; }
      else if (pattern == ScrollItemPattern.Pattern && L.Has("scroll")) { ScrollItemPattern x = new ScrollItemPattern(); x.El = L; patternObject = x; }
      return patternObject != null;
    }

    public void SetFocus() {
      AutomationElement L = Live;
      if (!L.Focusable) throw new InvalidOperationException("The element cannot take the keyboard focus.");
      L.Act("focus", null);
      L.Focused = true;
    }

    internal void Act(string kind, string arg) {
      if (Gone) throw new ElementNotAvailableException();
      if (!Enabled) throw new ElementNotEnabledException();
      if (FailWith == kind) throw new InvalidOperationException(kind + " is not supported by this provider");
      if (ActionDelayMs > 0) Thread.Sleep(ActionDelayMs);
      lock (Log) Log.Add(kind + ":" + Name + (arg != null ? "=" + arg : ""));
    }
  }
}
`;

// Loads win32-host.ps1's functions and UI state, stubs what needs a real desktop (window lookup,
// popups, UIPI check, window activation, Shift+F10, MSAA), builds a Jira-in-Brave-like window and
// prints one JSON object with every result.
const HARNESS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition $env:FAKE_UIA_CS
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:HOST_PS1, [ref]$t, [ref]$e)
$assigns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)
$native = $assigns | Where-Object { $_.Left.Extent.Text -eq '$NativeSource' } | Select-Object -First 1
Add-Type -TypeDefinition $native.Right.Expression.Value
foreach ($a in $assigns) {
  if ($a.Parent -is [System.Management.Automation.Language.NamedBlockAst] -and $a.Parent.Parent -eq $ast -and $a.Left.Extent.Text -match '^\$script:(Ui|Warnings$|AppCache$)') {
    . ([scriptblock]::Create($a.Extent.Text))
  }
}
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  . ([scriptblock]::Create($f.Extent.Text))
}
$script:IsWin = $true
$script:HostElevated = $false
$script:UiActionWaitMs = 400
$global:Calls = New-Object System.Collections.ArrayList
$global:Popups = @{}
$global:LegacyResult = 'done'
function Assert-Native { }
function Use-Uia { }
function Resolve-UiWindow($A) {
  $s = [string](Get-Arg $A 'hwnd' '77')
  $root = [System.Windows.Automation.AutomationElement]::Roots[[long]$s]
  if ($null -eq $root) { throw (New-HostError ('Window ' + $s + ' does not exist.') 'NOT_FOUND' $null) }
  return @{ Handle = (New-Object System.IntPtr -ArgumentList ([long]$s)); Id = $s; Record = [ordered]@{ app = 'Brave'; title = $root.Name; className = 'Chrome_WidgetWin_1' } }
}
function Get-UiPopups($Handle) { $v = $global:Popups[[string]$Handle.ToInt64()]; if ($null -ne $v) { return $v } }
function Confirm-UiWindowInput($Handle) { [void]$global:Calls.Add('confirm:' + $Handle.ToInt64()) }
function Enter-UiWindow($Handle) { [void]$global:Calls.Add('activate:' + $Handle.ToInt64()); return $true }
function Send-UiMenuKey { [void]$global:Calls.Add('shift+f10') }
function Invoke-UiLegacyAction($Info) { [void]$global:Calls.Add('legacy:' + $Info.Name); return $global:LegacyResult }

$AE = [System.Windows.Automation.AutomationElement]
$w = $AE::NewRoot(77, 'Your work - Jira - Brave')
$pane = $w.Add(50033, '')
$tb = $pane.Add(50021, 'App toolbar')
$back = $tb.Add(50000, 'Back').With('invoke')
$addr = $tb.Add(50004, 'Address and search bar').With('value'); $addr.Value = 'acme.atlassian.net/jira/your-work'
$sb = $pane.Add(50014, 'Vertical')
[void]$sb.Add(50000, 'Line down').With('invoke')
$doc = $pane.Add(50030, 'Your work - Jira').With('value'); $doc.Value = 'https://acme.atlassian.net/jira/your-work'; $doc.ReadOnly = $true
$g1 = $doc.Add(50026, '')
$h1 = $g1.Add(50020, 'Your work'); $h1.LocalType = 'heading'
$tabs = $g1.Add(50018, 'Work tabs')
$t1 = $tabs.Add(50019, 'Worked on').With('select'); $t1.Selected = 1
$t2 = $tabs.Add(50019, 'For you').With('select'); $t2.Selected = 0
$t3 = $tabs.Add(50019, 'Viewed').With('select'); $t3.Selected = 0
$list = $g1.Add(50008, '')
$l1 = $list.Add(50005, 'ABC-123 Fix login timeout').With('invoke')
[void]$l1.Add(50020, 'ABC-123   Fix login timeout')
$l2 = $list.Add(50005, 'ABC-124 For you page copy').With('invoke'); $l2.Offscreen = $true
[void]$g1.Add(50006, '')
[void]$g1.Add(50038, '')
$cb = $g1.Add(50002, 'Remember me').With('toggle'); $cb.Toggle = 0
$combo = $g1.Add(50003, 'Status').With('expand,value'); $combo.Value = 'To Do'; $combo.Expand = 0
$lst = $combo.Add(50008, '')
$o1 = $lst.Add(50007, 'To Do').With('select'); $o1.Selected = 1
$o2 = $lst.Add(50007, 'In Progress').With('select'); $o2.Selected = 0
$deploy = $g1.Add(50000, 'Deploy').With('invoke'); $deploy.Enabled = $false; $deploy.Help = 'Deploy a new revision'
$pw = $g1.Add(50004, 'Password').With('value'); $pw.Password = $true; $pw.Value = 'hunter2'
$buildLog = $g1.Add(50004, 'Build log').With('value'); $buildLog.ReadOnly = $true; $buildLog.Value = ('x' * 500)
$slider = $g1.Add(50015, 'Volume').With('range'); $slider.Range = 30
$menuBtn = $g1.Add(50000, 'More').With('expand'); $menuBtn.Expand = 0
$plain = $g1.Add(50000, 'Legacy only')
$comment = $g1.Add(50030, 'Comment').With('value'); $comment.Value = ''
$slow = $g1.Add(50000, 'Open dialog').With('invoke'); $slow.ActionDelayMs = 1500
$flaky = $g1.Add(50000, 'Flaky').With('invoke,toggle'); $flaky.FailWith = 'invoke'; $flaky.Toggle = 0
$hidden = $g1.Add(50000, 'Hidden'); $hidden.HasRect = $false
$focusPane = $g1.Add(50033, ''); $focusPane.Focused = $true

function Get-Node($Nodes, [string]$Name) { foreach ($n in $Nodes) { if ($n.name -eq $Name) { return $n } }; return $null }
function Act([string]$Id, [string]$Action, $Value) {
  $a = @{ id = $Id; action = $Action }
  if ($null -ne $Value) { $a.value = $Value }
  try { return (Invoke-UiAction ([pscustomobject]$a)) } catch { return [ordered]@{ error = (Get-ErrorRecordInfo $_) } }
}

$out = [ordered]@{}
$tree = Get-UiTree ([pscustomobject]@{ hwnd = '77' })
$out.tree = $tree
$out.treeDepth2 = Get-UiTree ([pscustomobject]@{ hwnd = '77'; depth = 2 })
$out.treeMax5 = Get-UiTree ([pscustomobject]@{ hwnd = '77'; maxNodes = 5 })
$out.treeRaw = (Get-UiTree ([pscustomobject]@{ hwnd = '77'; compact = $false; depth = 2 })).nodes.Count
$AE::DelayMs = 40
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$out.treeBudget = Get-UiTree ([pscustomobject]@{ hwnd = '77'; budgetMs = 150 })
$out.treeBudgetMs = $sw.ElapsedMilliseconds
$AE::DelayMs = 0

$out.findForYou = Find-UiElements ([pscustomobject]@{ hwnd = '77'; name = 'for  YOU' })
$out.findLinks = Find-UiElements ([pscustomobject]@{ name = $null; role = @('link') })
$out.findText = Find-UiElements ([pscustomobject]@{ text = 'atlassian' })
$out.findExact = Find-UiElements ([pscustomobject]@{ name = 'for'; exact = $true })
$out.findScroll = Find-UiElements ([pscustomobject]@{ name = 'Line down' })
$out.findLimit = Find-UiElements ([pscustomobject]@{ role = 'tab'; limit = 2 })
try { [void](Find-UiElements ([pscustomobject]@{ limit = 3 })); $out.findNone = $null } catch { $out.findNone = Get-ErrorRecordInfo $_ }
$popup = $AE::NewRoot(88, 'Context menu')
$copy = $popup.Add(50011, 'Copy link').With('invoke')
$global:Popups['77'] = [long[]]@(88)
$out.findPopup = Find-UiElements ([pscustomobject]@{ name = 'copy' })
$global:Popups.Clear()

$ids = @{}
foreach ($n in $tree.nodes) { $ids[$n.name] = $n.id }
$out.ids = $ids
$out.tags = [ordered]@{ a = [AnywhereNative]::UiTag('tab', 'For you'); b = [AnywhereNative]::UiTag('button', 'Save'); c = [AnywhereNative]::UiTag('window', 'Ünïcode 日本') }

$r = [ordered]@{}
$r.tab = Act $ids['For you'] 'press' $null
$r.link = Act $ids['ABC-123 Fix login timeout'] 'press' $null
$r.checkbox = Act $ids['Remember me'] 'press' $null
$r.menuPress = Act $ids['More'] 'press' $null
$r.legacy = Act $ids['Legacy only'] 'press' $null
$global:LegacyResult = 'another element is at its centre'
$r.legacyMiss = Act $ids['Legacy only'] 'press' $null
$r.disabled = Act $ids['Deploy'] 'press' $null
$r.pending = Act $ids['Open dialog'] 'press' $null
$r.flaky = Act $ids['Flaky'] 'press' $null
$r.setAddr = Act $ids['Address and search bar'] 'setValue' 'example.com/a'
$r.setReadOnly = Act $ids['Build log'] 'setValue' 'nope'
$r.setRange = Act $ids['Volume'] 'setValue' '55.5'
$r.setRangeBad = Act $ids['Volume'] 'setValue' 'loud'
$r.setPassword = Act $ids['Password'] 'setValue' 'secret'
$r.setNoValue = Act $ids['Back'] 'setValue' 'x'
$r.setMissing = Act $ids['Back'] 'setValue' $null
$r.selectItem = Act $ids['Status'] 'select' 'progress'
$r.selectMissing = Act $ids['Status'] 'select' 'Nope'
$r.collapse = Act $ids['More'] 'collapse' $null
$r.expand = Act $ids['More'] 'expand' $null
$r.expandNone = Act $ids['Back'] 'expand' $null
$r.scrollNone = Act $ids['Back'] 'scrollIntoView' $null
$r.focus = Act $ids['Address and search bar'] 'focus' $null
$r.menuKeys = Act $ids['Address and search bar'] 'showMenu' $null
$menuBtn.Expand = 0
$r.menuExpand = Act $ids['More'] 'showMenu' $null
$r.badAction = Act $ids['Back'] 'click' $null
$r.badId = Act 'abc' 'press' $null
$r.selectPlain = Act $ids['Viewed'] 'select' $null
$r.popupItem = Act $out.findPopup.matches[0].id 'press' $null
$out.actions = $r

$c = [ordered]@{}
Clear-UiCache $true
$AE::Visits = 0
$c.byPath = Act $ids['Viewed'] 'press' $null
$c.byPathVisits = $AE::Visits
$t3.Name = 'Viewed recently'
Clear-UiCache $true
$c.renamed = Act $ids['Viewed'] 'press' $null
$fresh = Find-UiElements ([pscustomobject]@{ name = 'Worked on' })
$t1.Name = 'Worked on (3)'
$c.cachedAfterRename = Act $fresh.matches[0].id 'press' $null
$back.Gone = $true
$c.gone = Act $ids['Back'] 'press' $null
$c.windowGone = Act '99.0~aa' 'press' $null
$c.noTag = Act (($ids['Remember me']) -replace '~..$', '') 'press' $null
$out.cache = $c
$out.calls = $global:Calls
$out.log = $AE::Log

# The response line the real loop writes: single-element arrays must stay arrays.
$one = $AE::NewRoot(55, 'One')
[void]$one.Add(50000, 'Only').With('invoke')
$out.line = ConvertTo-ResponseLine 9 $true (Invoke-HostCommand 'uitree' ([pscustomobject]@{ hwnd = '55' }))
$out.findLine = ConvertTo-ResponseLine 10 $true (Invoke-HostCommand 'uifind' ([pscustomobject]@{ hwnd = '55'; name = 'only' }))
$out.info = Invoke-HostCommand 'uiinfo' $null
$v = [ordered]@{}
try { [void][AnywhereNative]::SetWindowState([System.IntPtr]::Zero, 'sideways'); $v.state = $null } catch { $v.state = Get-ErrorRecordInfo $_ }
try { [void][AnywhereNative]::SetWindowBounds([System.IntPtr]::Zero, 0, 0, 0, 10, 15); $v.size = $null } catch { $v.size = Get-ErrorRecordInfo $_ }
$v.squash = [AnywhereNative]::Squash('  Save' + [char]9 + ' as...' + [char]13 + [char]10 + '  draft ', 0)
$v.clip = [AnywhereNative]::Squash(('a' * 9) + [char]0xD83D + [char]0xDE00, 10)
$v.match = @([AnywhereNative]::UiMatch('For you', 'for you', $false), [AnywhereNative]::UiMatch('For you page', 'for you', $false), [AnywhereNative]::UiMatch('Not for you', 'for you', $false), [AnywhereNative]::UiMatch('Not for you', 'for you', $true), [AnywhereNative]::UiMatch('', 'x', $false))
$out.native = $v
ConvertTo-Json -InputObject $out -Compress -Depth 12
`;

test('pwsh: the host walks, searches and acts through UI Automation patterns', { skip: !HAS_PWSH && 'pwsh not installed', timeout: 180000 }, () => {
  const r = spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', HARNESS], {
    encoding: 'utf8',
    env: { ...process.env, HOST_PS1: win32.HOST_SCRIPT, FAKE_UIA_CS },
    timeout: 170000,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const o = JSON.parse(r.stdout.trim().split('\n').pop());

  // ---- the compact tree
  const nodes = o.tree.nodes;
  const names = nodes.map((n) => `${n.depth}:${n.role}:${n.name}`);
  assert.deepEqual(names, [
    '0:window:Your work - Jira - Brave',
    '1:toolbar:App toolbar', '2:button:Back', '2:textbox:Address and search bar',
    '1:group:Your work - Jira',
    '2:heading:Your work',
    '2:tablist:Work tabs', '3:tab:Worked on', '3:tab:For you', '3:tab:Viewed',
    '2:link:ABC-123 Fix login timeout', '2:link:ABC-124 For you page copy',
    '2:checkbox:Remember me', '2:combobox:Status', '3:listitem:To Do', '3:listitem:In Progress',
    '2:button:Deploy', '2:textbox:Password', '2:textbox:Build log', '2:slider:Volume', '2:button:More',
    '2:button:Legacy only', '2:textbox:Comment', '2:button:Open dialog', '2:button:Flaky', '2:button:Hidden',
    '2:group:',
  ], 'unnamed panes, groups and lists, decorative images, separators, scroll bars and repeated text are left out; order is kept');
  const by = (name) => nodes.find((n) => n.name === name);
  assert.equal(by('For you').id, `77.0.2.0.1.1~${uiTag('tab', 'For you')}`, 'raw child indices, so wrappers still count');
  assert.equal(by('App toolbar').parent, nodes[0].id, 'children of a wrapper belong to the nearest kept element');
  assert.deepEqual(by('ABC-123 Fix login timeout').children, [], 'text repeating the link name is dropped');
  assert.equal(by('Your work - Jira').value, 'https://acme.atlassian.net/jira/your-work');
  assert.equal('value' in by('Password'), false, 'password values are never read out');
  assert.equal(by('Build log').value.length, 400);
  assert.equal(by('Build log').valueTruncated, true);
  assert.equal(by('Volume').value, '30');
  assert.deepEqual([by('Remember me').checked, by('Remember me').selected], [false, false]);
  assert.deepEqual([by('Status').expanded, by('Status').value], [false, 'To Do']);
  assert.equal(by('Worked on').selected, true);
  assert.equal(by('Deploy').enabled, false);
  assert.equal(by('Deploy').description, 'Deploy a new revision');
  assert.deepEqual([by('Hidden').offscreen, by('Hidden').bounds], [true, { x: 0, y: 0, width: 0, height: 0 }]);
  assert.equal(nodes[nodes.length - 1].focused, true, 'an unnamed element is kept while it has the focus');
  assert.equal(by('Comment').role, 'textbox', 'an editable document takes text');
  assert.deepEqual(by('Back').bounds, { x: 3, y: 60, width: 10, height: 8 });
  assert.equal(o.tree.truncated, false);
  assert.equal(o.tree.window.id, '77');
  assert.equal(o.tree.window.app, 'Brave');
  for (const n of nodes) for (const c of n.children) assert.equal(nodes.find((x) => x.id === c).parent, n.id);

  assert.ok(o.treeDepth2.nodes.every((n) => n.depth <= 2) && !o.treeDepth2.nodes.some((n) => n.name === 'For you'), 'depth counts kept levels');
  assert.ok(o.treeDepth2.nodes.some((n) => n.name === 'ABC-123 Fix login timeout'), 'wrappers do not use up depth');
  assert.deepEqual([o.treeMax5.nodes.length, o.treeMax5.truncated], [5, true]);
  assert.equal(o.treeRaw, 4, 'compact: false keeps wrappers (window, pane, toolbar, document; scroll bars are never entered)');
  assert.equal(o.treeBudget.truncated, true, 'the time budget stops the walk');
  assert.ok(o.treeBudgetMs < 1500, `stopped near the budget (${o.treeBudgetMs} ms)`);

  // ---- search
  const brief = (res) => res.matches.map((m) => `${m.role}:${m.name}`);
  assert.deepEqual(brief(o.findForYou), ['tab:For you', 'link:ABC-124 For you page copy'], 'exact first; whitespace and case do not matter');
  assert.equal(o.findForYou.matches[0].path, 'window "Your work - Jira - Brave" > group "Your work - Jira" > tablist "Work tabs"');
  assert.equal(o.findForYou.matches[0].windowId, '77');
  assert.equal(o.findForYou.matches[0].value, null);
  assert.equal(o.findForYou.matches[1].offscreen, true);
  assert.deepEqual(brief(o.findLinks), ['link:ABC-123 Fix login timeout', 'link:ABC-124 For you page copy']);
  assert.deepEqual(brief(o.findText), ['group:Your work - Jira', 'textbox:Address and search bar'], 'text matches values');
  assert.deepEqual(o.findExact.matches, []);
  assert.deepEqual(o.findScroll.matches, [], 'scroll bars are not searched');
  assert.deepEqual(brief(o.findLimit), ['tab:Worked on', 'tab:For you']);
  assert.ok(o.findLimit.scanned < o.findForYou.scanned, 'enough exact matches stop the walk');
  assert.equal(o.findNone.code, 'BAD_ARGS');
  assert.deepEqual(brief(o.findPopup), ['menuitem:Copy link', 'link:ABC-124 For you page copy'], 'open popups are searched first');
  assert.equal(o.findPopup.matches[0].windowId, '88');
  assert.match(o.findPopup.matches[0].id, /^88\.0~/);

  assert.deepEqual(o.tags, { a: uiTag('tab', 'For you'), b: uiTag('button', 'Save'), c: uiTag('window', 'Ünïcode 日本') }, 'C# and JavaScript tags agree');

  // ---- actions
  const A = o.actions;
  const ok = (r, method) => {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.method, method, JSON.stringify(r));
  };
  ok(A.tab, 'select');
  assert.deepEqual([A.tab.role, A.tab.name, A.tab.id], ['tab', 'For you', by('For you').id]);
  assert.deepEqual(A.tab.bounds, by('For you').bounds);
  ok(A.link, 'invoke');
  ok(A.checkbox, 'toggle');
  ok(A.menuPress, 'expand');
  ok(A.legacy, 'legacy');
  assert.deepEqual([A.legacyMiss.ok, A.legacyMiss.method], [false, 'none']);
  assert.match(A.legacyMiss.reason, /MSAA default action: another element/);
  assert.deepEqual([A.disabled.ok, A.disabled.disabled, A.disabled.reason], [false, true, 'The element is disabled.']);
  ok(A.pending, 'invoke');
  assert.equal(A.pending.pending, true, 'a provider that does not return is reported as pending');
  ok(A.flaky, 'toggle');
  ok(A.setAddr, 'value');
  assert.equal(A.setAddr.value, 'example.com/a');
  assert.deepEqual([A.setReadOnly.ok, A.setReadOnly.reason], [false, 'The element is read-only.']);
  ok(A.setRange, 'range');
  assert.match(A.setRangeBad.reason, /give a number/);
  ok(A.setPassword, 'value');
  assert.equal('value' in A.setPassword, false);
  assert.deepEqual([A.setNoValue.ok, A.setNoValue.method], [false, 'none']);
  assert.equal(A.setMissing.error.code, 'BAD_ARGS');
  ok(A.selectItem, 'select');
  assert.deepEqual(A.selectItem.item, { id: `77.0.2.0.6.0.1~${uiTag('listitem', 'In Progress')}`, role: 'listitem', name: 'In Progress' });
  assert.equal(A.selectItem.value, 'In Progress');
  assert.equal(A.selectMissing.ok, false);
  ok(A.collapse, 'collapse');
  ok(A.expand, 'expand');
  assert.equal(A.expandNone.ok, false);
  assert.equal(A.scrollNone.ok, false);
  ok(A.focus, 'focus');
  ok(A.menuKeys, 'keyboard');
  ok(A.menuExpand, 'expand');
  assert.equal(A.badAction.error.code, 'BAD_ARGS');
  assert.equal(A.badId.error.code, 'BAD_ARGS');
  ok(A.selectPlain, 'select');
  ok(A.popupItem, 'invoke');

  // ---- id resolution
  const C = o.cache;
  ok(C.byPath, 'select');
  assert.ok(C.byPathVisits >= 6, 'resolved by walking the path');
  assert.equal(C.renamed.error.code, 'STALE_ELEMENT', 'a different element at the path is refused');
  ok(C.cachedAfterRename, 'select');
  assert.equal(C.cachedAfterRename.name, 'Worked on (3)', 'a cached element is used even after its name changed');
  assert.equal(C.gone.error.code, 'STALE_ELEMENT');
  assert.equal(C.windowGone.error.code, 'NOT_FOUND');
  ok(C.noTag, 'toggle');

  const calls = o.calls;
  assert.ok(calls.includes('confirm:77') && calls.includes('confirm:88'), 'every action checks UIPI for its window');
  assert.deepEqual(calls.slice(calls.indexOf('activate:77'), calls.indexOf('activate:77') + 4), ['activate:77', 'confirm:77', 'activate:77', 'shift+f10']);
  assert.ok(o.log.includes('expand:Status') && o.log.indexOf('select:In Progress') < o.log.lastIndexOf('collapse:Status'), 'select expands, picks, collapses');
  assert.ok(o.log.includes('invoke:Open dialog'), 'the pending action finished in the background');
  assert.ok(!o.log.some((l) => l.startsWith('invoke:Flaky')), 'the failing Invoke fell back to Toggle');

  // ---- the response lines the host writes
  const line = JSON.parse(o.line);
  assert.equal(line.ok, true);
  assert.ok(Array.isArray(line.result.nodes) && line.result.nodes.length === 2);
  assert.deepEqual(line.result.nodes[0].children, [line.result.nodes[1].id], 'one child is still an array');
  assert.deepEqual(line.result.nodes[1].children, []);
  const findLine = JSON.parse(o.findLine);
  assert.ok(Array.isArray(findLine.result.matches) && findLine.result.matches.length === 1, 'one match is still an array');
  assert.deepEqual(o.info, { available: true, error: null });

  // ---- native helpers
  assert.equal(o.native.state.code, 'BAD_ARGS');
  assert.equal(o.native.size.code, 'BAD_ARGS');
  assert.equal(o.native.squash, 'Save as... draft');
  assert.equal(o.native.clip, 'aaaaaaaaa', 'a surrogate pair is never cut in half');
  assert.deepEqual(o.native.match, [3, 2, 1, 0, 0]);
});
