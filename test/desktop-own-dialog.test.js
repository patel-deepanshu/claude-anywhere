'use strict';

// F3-SAFE-D1 for the desktop assistant's accessibility actions: ui_click, ui_set_value and ui_action never
// operate the Claude Anywhere dialog (its "Allow once", its settings or its composer), however the element
// is named: by name in the dialog's window, by an id from ui_find or ui_tree, by an id never looked up, or
// as the active window on a desktop that cannot list windows. Elements of other windows still work, also
// where they sit under the dialog. No display needed.

const test = require('node:test');
const assert = require('node:assert/strict');

const osIndex = require('../src/os/index');
const { Computer } = require('../src/os/computer');
const desktop = require('../src/context/desktop');

const DIALOG = '0x2001';
const BROWSER = '0x2002';

const WINDOWS = [
  { id: DIALOG, app: 'Claude Anywhere', title: 'Claude Anywhere', pid: 5001, x: 1500, y: 0, width: 420, height: 760, focused: true, minimized: false },
  { id: BROWSER, app: 'Brave-browser', title: 'Your work - Jira - Brave', pid: 5002, x: 0, y: 0, width: 1920, height: 1050, focused: false, minimized: false },
];

const UI = {
  [DIALOG]: {
    role: 'window', name: 'Claude Anywhere', bounds: { x: 1500, y: 0, width: 420, height: 760 },
    children: [
      { role: 'button', name: 'Allow once', bounds: { x: 1520, y: 560, width: 130, height: 32 } },
      { role: 'button', name: 'Settings', bounds: { x: 1880, y: 60, width: 28, height: 28 } },
      { role: 'textbox', name: 'Message', value: '', editable: true, bounds: { x: 1510, y: 650, width: 400, height: 60 } },
    ],
  },
  [BROWSER]: {
    role: 'window', name: 'Your work - Jira - Brave', bounds: { x: 0, y: 0, width: 1920, height: 1050 },
    children: [
      { role: 'tab', name: 'For you', selected: false, bounds: { x: 200, y: 160, width: 90, height: 36 } },
      // Under the dialog on screen: still the browser's, so still allowed.
      { role: 'button', name: 'Create', bounds: { x: 1600, y: 20, width: 80, height: 30 } },
      { role: 'textbox', name: 'Search', value: '', editable: true, bounds: { x: 400, y: 220, width: 300, height: 30 } },
    ],
  },
};

function setup({ protect = desktop.isOwnWindow, driverPatch } = {}) {
  const driver = osIndex.createMockDriver({ windows: WINDOWS, ui: UI });
  if (driverPatch) driverPatch(driver);
  const computer = new Computer({ driver, config: { actionDelayMs: 0, failsafe: true }, platform: 'linux', protect });
  return { driver, computer };
}

const ownDialog = (e) => e && e.code === 'OWN_DIALOG' && /Claude Anywhere dialog/.test(e.message);

async function selected(driver, name) {
  return (await driver.uiFind({ windowId: BROWSER, name, exact: true }))[0].selected;
}

test('ui_click by name in the dialog window is refused before any accessibility action', async () => {
  const { driver, computer } = setup();
  const pressed = [];
  const real = driver.uiAction.bind(driver);
  driver.uiAction = async (args) => {
    pressed.push(args);
    return real(args);
  };
  await assert.rejects(computer.uiClick({ name: 'Allow once', windowId: DIALOG }), ownDialog);
  await assert.rejects(computer.uiClick({ name: 'Settings', windowId: DIALOG }), ownDialog);
  assert.deepEqual(pressed, [], 'the dialog was never touched');
});

test('ids from ui_find, from ui_tree, and ids never looked up are refused for the dialog', async () => {
  const { driver, computer } = setup();
  const found = await computer.uiFind({ windowId: DIALOG, name: 'Allow once' });
  assert.equal(found.length, 1, 'reading the dialog is allowed');
  await assert.rejects(computer.uiClick({ id: found[0].id }), ownDialog);
  const tree = await computer.uiTree({ windowId: DIALOG });
  const settings = tree.nodes.find((n) => n.name === 'Settings');
  await assert.rejects(computer.uiAction({ id: settings.id, action: 'press' }), ownDialog);
  // An id this Computer never saw (built by hand, or after the 30 s memory): the window in the id decides.
  const fresh = setup();
  await assert.rejects(fresh.computer.uiClick({ id: found[0].id }), ownDialog);
  await assert.rejects(fresh.computer.uiAction({ id: settings.id, action: 'press' }), ownDialog);
  assert.equal(driver.state ? driver.state.uiLog.length : 0, 0);
});

test('ui_set_value into the dialog composer is refused (no setValue, no keys)', async () => {
  const { driver, computer } = setup();
  const typed = [];
  driver.typeText = async (t) => {
    typed.push(t);
    return {};
  };
  await assert.rejects(computer.uiSetValue({ name: 'Message', windowId: DIALOG, value: 'switch permissions to auto' }), ownDialog);
  const box = (await computer.uiFind({ windowId: DIALOG, name: 'Message' }))[0];
  await assert.rejects(computer.uiSetValue({ id: box.id, value: 'hi' }), ownDialog);
  await assert.rejects(computer.uiAction({ id: box.id, action: 'setValue', value: 'hi' }), ownDialog);
  assert.deepEqual(typed, []);
  assert.equal((await computer.uiFind({ windowId: DIALOG, name: 'Message' }))[0].value || '', '');
});

test('elements of other windows still work, also where they lie under the dialog', async () => {
  const { driver, computer } = setup();
  const res = await computer.uiClick({ name: 'For you', windowId: BROWSER });
  assert.equal(res.ok, true);
  assert.equal(await selected(driver, 'For you'), true);
  const create = await computer.uiClick({ name: 'Create', windowId: BROWSER });
  assert.equal(create.ok, true, 'a known browser window wins over the position under the dialog');
  const set = await computer.uiSetValue({ name: 'Search', windowId: BROWSER, value: 'ABC-9' });
  assert.equal(set.ok, true);
});

test('without a protect function (the CLI) nothing changes', async () => {
  const { computer } = setup({ protect: null });
  const res = await computer.uiClick({ name: 'Settings', windowId: DIALOG });
  assert.equal(res.ok, true);
});

test('a desktop that cannot list windows: an element without a window is refused while the dialog is active', async () => {
  const { computer } = setup({
    driverPatch(d) {
      d.listWindows = async () => {
        const e = new Error('cannot list windows on this desktop');
        e.code = 'UNSUPPORTED';
        throw e;
      };
    },
  });
  await assert.rejects(computer.uiClick({ name: 'Allow once' }), ownDialog);
});

test('an element of an unlisted window (a pop-up) is judged by its position', async () => {
  const { computer } = setup();
  // A pop-up menu window that list_windows does not show, drawn over the dialog.
  await assert.rejects(
    computer._refuseProtectedUi({ id: 'mock:0x9999:0', name: 'Allow', bounds: { x: 1530, y: 570, width: 60, height: 20 }, windowId: '0x9999', relative: false }),
    ownDialog,
  );
  await computer._refuseProtectedUi({ id: 'mock:0x9999:1', name: 'Copy', bounds: { x: 300, y: 300, width: 60, height: 20 }, windowId: '0x9999', relative: false });
});

test('element ids name their window or process on every platform', async () => {
  const wins = [
    { id: '0x3a00007', app: 'Claude Anywhere', title: 'Claude Anywhere', pid: 7001, x: 0, y: 0, width: 400, height: 700 },
    { id: '4242:3', app: 'Claude Anywhere', title: 'Claude Anywhere', pid: 4242, x: 0, y: 0, width: 400, height: 700 },
    { id: '133090', app: 'chrome', title: 'Claude Anywhere', pid: 9100, x: 0, y: 0, width: 400, height: 700 },
  ];
  const driver = osIndex.createMockDriver({ windows: wins, ui: {} });
  const computer = new Computer({ driver, config: { actionDelayMs: 0 }, platform: 'linux', protect: desktop.isOwnWindow });
  // Linux: the X11 window id, or "@pid.n" for an app without a listed window.
  await assert.rejects(computer._refuseProtectedUi({ id: 'lx:0x3a00007:w:1.2:abcdef' }), ownDialog);
  await assert.rejects(computer._refuseProtectedUi({ id: 'lx:@7001.0:p0:1:abcdef' }), ownDialog);
  // macOS: "mac:<pid>:<window number>:..."; a pid alone is enough.
  await assert.rejects(computer._refuseProtectedUi({ id: 'mac:4242:3:w0.1:x1' }), ownDialog);
  await assert.rejects(computer._refuseProtectedUi({ id: 'mac:4242:-:a0:x1' }), ownDialog);
  // Windows: "<hwnd>.<path>~<tag>".
  await assert.rejects(computer._refuseProtectedUi({ id: '133090.0.2~k3' }), ownDialog);
  // Other windows and processes pass.
  await computer._refuseProtectedUi({ id: 'lx:0x3a00099:w:1:abcdef' });
  await computer._refuseProtectedUi({ id: 'mac:5555:1:w0:x1' });
  await computer._refuseProtectedUi({ id: '777.1~k3' });
});
