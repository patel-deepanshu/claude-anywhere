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

// ---------------------------------------------------------------- the real-pointer and keyboard fallbacks

/** Record the driver's real input (click, keyCombo, typeText) of a setup(). */
function recordInput(driver) {
  const input = [];
  for (const m of ['click', 'keyCombo', 'typeText']) {
    const real = driver[m].bind(driver);
    driver[m] = async (...a) => {
      input.push([m, a[0], a[1]]);
      return real(...a);
    };
  }
  return input;
}

const UNDER_DIALOG_UI = {
  ...UI,
  [BROWSER]: {
    ...UI[BROWSER],
    children: [
      // Centred (1585, 576) under the dialog's "Allow once", and (1710, 680) under its composer.
      { role: 'button', name: 'Canvas widget', bounds: { x: 1520, y: 560, width: 130, height: 32 } },
      { role: 'textbox', name: 'Notes', value: '', editable: true, bounds: { x: 1510, y: 650, width: 400, height: 60 } },
      { role: 'textbox', name: 'Search', value: '', editable: true, bounds: { x: 400, y: 220, width: 300, height: 30 } },
    ],
  },
};

test('MERGE-1: the real-pointer fallback of ui_click and ui_set_value never clicks into the dialog over its element', async () => {
  const driver = osIndex.createMockDriver({ windows: WINDOWS, ui: UNDER_DIALOG_UI });
  const input = recordInput(driver);
  // The browser exposes these elements but no accessibility action (method 'none'): Computer would click instead.
  const real = driver.uiAction.bind(driver);
  driver.uiAction = async (args) => (String(args.id).includes(BROWSER) ? { ok: false, method: 'none' } : real(args));
  const computer = new Computer({ driver, config: { actionDelayMs: 0, failsafe: true }, platform: 'linux', protect: desktop.isOwnWindow });
  await assert.rejects(computer.click({ x: 1585, y: 576 }), ownDialog, 'the click tool refuses that point');
  await assert.rejects(computer.uiClick({ name: 'Canvas widget', windowId: BROWSER }), ownDialog);
  await assert.rejects(computer.uiSetValue({ name: 'Notes', windowId: BROWSER, value: 'switch permissions to auto' }), ownDialog);
  // A batch ui_click step and an id from ui_find take the same path.
  const id = (await computer.uiFind({ windowId: BROWSER, name: 'Canvas widget' }))[0].id;
  await assert.rejects(computer.uiClick({ id }), ownDialog);
  assert.deepEqual(input, [], 'no click, select-all or typing reached the driver');
  // Away from the dialog the fallback still clicks and types.
  const ok = await computer.uiSetValue({ name: 'Search', windowId: BROWSER, value: 'ABC-9' });
  assert.equal(ok.method, 'click+select-all+type');
  assert.deepEqual(input.map((c) => c[0]), ['click', 'keyCombo', 'typeText']);
  assert.deepEqual(input[0].slice(1, 2), [550]);
});

test('SEC-5: ui_set_value does not select-all and type while the dialog keeps the focus', async () => {
  const probe = setup();
  const searchId = (await probe.computer.uiFind({ windowId: BROWSER, name: 'Search' }))[0].id;
  // A fresh Computer (the id is not remembered, so its window cannot be raised first); the accessibility
  // setValue fails and the focus action "succeeds" without raising the browser, so the dialog keeps the focus.
  const { driver, computer } = setup({
    driverPatch(d) {
      const real = d.uiAction.bind(d);
      d.uiAction = async (args) => (args.action === 'setValue' ? { ok: false, reason: 'not settable' } : args.action === 'focus' ? { ok: true, method: 'focus' } : real(args));
    },
  });
  const input = recordInput(driver);
  await assert.rejects(computer.uiSetValue({ id: searchId, value: 'hello' }), ownDialog);
  assert.deepEqual(input, [], 'no keys went to the focused dialog');
});

// ---------------------------------------------------------------- SEC-1: desktops that cannot place the dialog

/** As src/os/linux.js WaylandDriver on GNOME/KDE: no window list, no active window; clicks and keys work (ydotool). */
function waylandSetup(dialogState) {
  const driver = osIndex.createMockDriver({ windows: WINDOWS, ui: UI });
  driver.listWindows = async () => {
    const e = new Error('Window management is not available on gnome (Wayland)');
    e.code = 'UNSUPPORTED';
    throw e;
  };
  driver.activeWindow = async () => null;
  const input = recordInput(driver);
  const computer = new Computer({ driver, config: { actionDelayMs: 0, failsafe: true }, platform: 'linux', protect: desktop.isOwnWindow, dialogState });
  return { driver, computer, input };
}

const unplaced = (e) => ownDialog(e) && /minimize the Claude Anywhere dialog/.test(e.hint || '');

test('SEC-1: where windows cannot be listed, no pointer input while the dialog is on screen, and no keys while it may have the focus', async () => {
  // The reviewer's repro: the dialog's Settings at (1700, 40); before the fix the click, the text and Enter all reached it.
  let state = { visible: true, focused: true };
  const { computer, input } = waylandSetup(async () => state);
  await assert.rejects(computer.click({ x: 1700, y: 40 }), unplaced);
  await assert.rejects(computer.drag({ fromX: 100, fromY: 100, toX: 1700, toY: 40 }), unplaced);
  await assert.rejects(computer.scroll({ x: 1700, y: 400, direction: 'down' }), unplaced);
  await assert.rejects(computer.typeText({ text: 'hi', method: 'keys' }), ownDialog);
  await assert.rejects(computer.key({ combo: 'enter' }), ownDialog);
  // A page that has not said whether it has the focus: still no keys.
  state = { visible: true, focused: null };
  await assert.rejects(computer.key({ combo: 'tab' }), ownDialog);
  // The daemon cannot be asked: the dialog counts as on screen with an unknown focus.
  const down = waylandSetup(async () => {
    throw new Error('connect ECONNREFUSED');
  });
  await assert.rejects(down.computer.click({ x: 10, y: 10 }), unplaced);
  await assert.rejects(down.computer.typeText({ text: 'hi', method: 'keys' }), ownDialog);
  assert.deepEqual([...input, ...down.input], [], 'nothing reached the driver');

  // The dialog on screen but another window focused: keys go there; the pointer still waits.
  state = { visible: true, focused: false };
  await computer.typeText({ text: 'hi', method: 'keys' });
  await computer.key({ combo: 'enter' });
  await assert.rejects(computer.click({ x: 300, y: 300 }), unplaced);
  // Minimized, or no dialog page open: everything works again.
  state = { visible: false, focused: false };
  await computer.click({ x: 300, y: 300 });
  state = null;
  await computer.click({ x: 1700, y: 40 });
  assert.deepEqual(input.map((c) => c[0]), ['typeText', 'keyCombo', 'click', 'click']);
});

test('SEC-1: accessibility actions where windows cannot be listed: judged by the window the lookup searched', async () => {
  const { computer, input } = waylandSetup(async () => ({ visible: true, focused: false }));
  // The lookup searched the dialog (GNOME: the active accessible window): refused by its title.
  await assert.rejects(computer._refuseProtectedUi({ id: 'mock:0x2001:0', name: 'Allow once', win: { id: '@5001.0', title: 'Claude Anywhere' } }), ownDialog);
  // It searched the browser: the press itself may run (it never goes through the dialog).
  await computer._refuseProtectedUi({ id: 'mock:@5002.0:1', name: 'Create', win: { id: '@5002.0', title: 'Your work - Jira - Brave' } });
  // An id whose window nobody knows: refused while the dialog is on screen.
  await assert.rejects(computer._refuseProtectedUi({ id: 'lx:@5002.0:p0:1:abcdef', name: 'Create' }), ownDialog);
  // The real-pointer fallback of a browser element is a click like any other: refused while the dialog is on screen.
  await assert.rejects(computer._uiClickCentre({ id: 'x', name: 'Create', relative: false }, { x: 1600, y: 20, width: 80, height: 30 }, [{ x: 0, y: 0, width: 1920, height: 1080 }]), unplaced);
  assert.deepEqual(input, []);
});

test('SEC-1: UiHost.dialogState() and the guard: a page counts as on screen until it reports, and its newest report decides', () => {
  const { UiHost } = require('../src/daemon/uihost');
  const { SessionManager } = require('../src/daemon/session');
  let pages = 0;
  const host = new UiHost({ config: {}, platformInfo: { platform: 'linux', displayServer: 'wayland' }, clientCount: () => pages, cleanupLeftovers: false });
  assert.equal(host.dialogState(), null, 'no page connected');
  pages = 1;
  host.notePages();
  assert.deepEqual(host.dialogState(), { visible: true, focused: null }, 'connected, not reported yet');
  host.noteVisibility({ page: 'p1', visible: true, focused: true });
  assert.deepEqual(host.dialogState(), { visible: true, focused: true });
  host.noteVisibility({ page: 'p1', visible: true, focused: false });
  assert.deepEqual(host.dialogState(), { visible: true, focused: false });
  host.noteVisibility({ page: 'p1', visible: false, focused: false });
  assert.deepEqual(host.dialogState(), { visible: false, focused: false }, 'minimized');
  // The page reloads: its old report must not speak for the new one.
  pages = 0;
  host.notePages();
  pages = 1;
  host.notePages();
  assert.deepEqual(host.dialogState(), { visible: true, focused: null });

  // GET /api/mcp/guard carries it; without a page there is no dialog field (as before).
  const guard = SessionManager.prototype.guard;
  const self = { pauseUntil: 0, status: 'idle', mode: 'companion', bridge: null, permissions: { pending: () => [] }, hub: { clientCount: () => pages }, dialogStateFn: () => host.dialogState() };
  assert.deepEqual(guard.call(self), { allowed: true, dialog: { visible: true, focused: null } });
  self.permissions.pending = () => [{ id: 'c', risk: 'critical' }];
  assert.equal(guard.call(self).allowed, false);
  assert.deepEqual(guard.call(self).dialog, { visible: true, focused: null }, 'also while paused');
  pages = 0;
  self.permissions.pending = () => [];
  assert.deepEqual(guard.call(self), { allowed: true });
  // No window host: an open page counts as on screen.
  assert.deepEqual(guard.call({ ...self, dialogStateFn: null, hub: { clientCount: () => 1 } }).dialog, { visible: true, focused: null });
});

test('SEC-1: the MCP server\'s Computer gets the daemon\'s dialog state', async () => {
  const { createComputerSource } = require('../src/mcp/server');
  const driver = osIndex.createMockDriver({ windows: WINDOWS, ui: UI });
  driver.listWindows = async () => {
    throw Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED' });
  };
  const source = { config: { computer: { actionDelayMs: 0 } }, refresh: () => false, version: () => 0 };
  const src = createComputerSource({ source, getDriver: async () => driver, dialogState: async () => ({ visible: true, focused: false }) });
  const comp = await src.getComputer();
  assert.equal(comp.protect, desktop.isOwnWindow);
  await assert.rejects(comp.click({ x: 1700, y: 40 }), unplaced);
});

// ---------------------------------------------------------------------------
// LIVE-2 / LIVE-3: quit_app and set_window leave the dialog alone
// ---------------------------------------------------------------------------

const fs = require('fs');
const apps = require('../src/os/apps');
const desktopTools = require('../src/mcp/tools-desktop');

/** A Linux process table: pid -> {ppid, comm, env}. */
function procFs(table) {
  return {
    ...fs,
    readdirSync: (p, opts) => (p === '/proc' ? Object.keys(table).map((name) => ({ name, isDirectory: () => true })) : fs.readdirSync(p, opts)),
    readFileSync: (p, enc) => {
      const m = /^\/proc\/(\d+)\/(stat|comm|environ)$/.exec(String(p));
      if (!m) return fs.readFileSync(p, enc);
      const e = table[m[1]];
      if (!e) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      if (m[2] === 'stat') return `${m[1]} (${e.comm}) S ${e.ppid} 1 1 0`;
      if (m[2] === 'comm') return `${e.comm}\n`;
      return (e.env || []).join('\0');
    },
  };
}

function quitDeps(table, signals) {
  return {
    platform: 'linux',
    isWSL: false,
    env: { HOME: '/home/me', XDG_DATA_DIRS: '/nonexistent' },
    homedir: () => '/home/me',
    linuxSystemDirs: [],
    cache: new Map(),
    now: () => 0,
    sleep: async () => {},
    which: (n) => (n === 'pgrep' ? '/usr/bin/pgrep' : null),
    run: async (cmd, args) => ({ code: 0, stdout: cmd.endsWith('pgrep') && args.includes('chrome') ? Object.keys(table).filter((k) => table[k].comm === 'chrome').join('\n') : '', stderr: '' }),
    kill: (pid, sig) => {
      signals.push([pid, sig]);
    },
    fs: procFs(table),
    ancestorPids: async () => [process.pid],
  };
}

test('LIVE-2: quit_app "chrome" by name spares the dialog\'s browser and its helpers, and only them', async () => {
  // 500: the dialog's browser (its window is listed), 501/502 its zygote and renderer; 600: the user's own
  // Chrome; 700: a dialog browser whose window is not listed (Wayland), known by its environment mark.
  const table = {
    1: { ppid: 0, comm: 'systemd' },
    500: { ppid: 1, comm: 'chrome' },
    501: { ppid: 500, comm: 'chrome' },
    502: { ppid: 501, comm: 'chrome' },
    600: { ppid: 1, comm: 'chrome' },
    700: { ppid: 1, comm: 'chrome', env: ['HOME=/home/me', apps.DIALOG_ENV_MARK] },
  };
  const driver = osIndex.createMockDriver({
    windows: [{ id: '0xd1', app: 'Chromium', title: 'Claude Anywhere', pid: 500, x: 1500, y: 0, width: 420, height: 760, focused: false, minimized: false }],
  });
  const signals = [];
  const r = await apps.quit('chrome', { driver }, quitDeps(table, signals));
  assert.deepEqual(signals.filter(([, s]) => s !== 0), [[600, 'SIGTERM']], 'only the user\'s Chrome was asked to quit');
  assert.ok(!r.signaled.some((p) => [500, 501, 502, 700].includes(p)));
  const dialog = await apps.dialogPids(apps.makeContext(quitDeps(table, [])), driver.state.windows);
  assert.deepEqual([...dialog.all].sort(), [500, 501, 502]);
  assert.deepEqual(dialog.roots, [500]);
});

test('LIVE-2: the dialog\'s window host is started with the environment mark its helpers inherit', async () => {
  const { UiHost } = require('../src/daemon/uihost');
  const spawned = [];
  const host = Object.create(UiHost.prototype);
  host.env = { PATH: '/usr/bin' };
  host.earlyExitMs = 0;
  host._stdioFd = () => null;
  host._spawn = (cmd, args, opts) => {
    spawned.push(opts.env);
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.pid = 1234;
    child.unref = () => {};
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  await host._launch('/usr/bin/chromium', ['--app=http://x'], { dialog: true, waitMs: 0 }).catch(() => null);
  await host._launch('/usr/bin/xdg-open', ['http://x'], { waitMs: 0 }).catch(() => null);
  assert.equal(spawned[0].ANYWHERE_DIALOG, '1');
  assert.equal(spawned[0].PATH, '/usr/bin');
  assert.equal(spawned[1].ANYWHERE_DIALOG, undefined, 'URL openers (the user\'s own browser) are not marked');
  assert.match(apps.DIALOG_ENV_MARK, /^ANYWHERE_DIALOG=1$/);
});

test('LIVE-3: set_window refuses the Claude Anywhere dialog, by id as by title', async () => {
  const driver = osIndex.createMockDriver({ windows: WINDOWS, ui: UI });
  const moved = [];
  driver.setWindowBounds = async (id, b) => {
    moved.push([id, b]);
    return true;
  };
  const comp = new Computer({ driver, config: { actionDelayMs: 0 }, platform: 'linux', protect: desktop.isOwnWindow });
  const tools = Object.fromEntries(
    desktopTools.createTools({ getComputer: async () => comp, checkGuard: async () => {}, postActivity: () => {} }).map((t) => [t.name, t]),
  );
  await assert.rejects(tools.set_window.handler({ window: DIALOG, state: 'minimize' }), (e) => e.code === 'OWN_DIALOG' && /Claude Anywhere dialog, which Claude may not move/.test(e.message));
  await assert.rejects(tools.set_window.handler({ window: 'Claude Anywhere', state: 'left-half' }), (e) => e.code === 'NOT_FOUND', 'by title it is not even found');
  assert.deepEqual(moved, []);
  await tools.set_window.handler({ window: BROWSER, state: 'maximize' });
  assert.deepEqual(moved, [[BROWSER, { state: 'maximize' }]]);
});

test('the dialog\'s window-manager frame is protected too: its title bar buttons are not clicked', async () => {
  // As the X11 driver reports it: the client area, and openbox's frame (title bar and borders) around it.
  const wins = [
    { id: DIALOG, app: 'Claude Anywhere', title: 'Claude Anywhere', pid: 5001, x: 976, y: 48, width: 440, height: 720, frame: { x: 975, y: 28, width: 442, height: 745 }, focused: false, minimized: false },
    { id: BROWSER, app: 'Brave-browser', title: 'Jira - Brave', pid: 5002, x: 0, y: 0, width: 960, height: 900, focused: true, minimized: false },
  ];
  const driver = osIndex.createMockDriver({ windows: wins, ui: {} });
  const clicks = [];
  driver.click = async (x, y) => {
    clicks.push([x, y]);
    return {};
  };
  const comp = new Computer({ driver, config: { actionDelayMs: 0, failsafe: false }, platform: 'linux', protect: desktop.isOwnWindow });
  await assert.rejects(comp.click({ x: 1405, y: 38 }), ownDialog, 'the close button in the title bar');
  await assert.rejects(comp.click({ x: 1200, y: 400 }), ownDialog, 'the client area');
  await comp.click({ x: 1200, y: 780 });
  await comp.click({ x: 500, y: 400 });
  assert.deepEqual(clicks, [[1200, 780], [500, 400]], 'below the frame and elsewhere still click');
});
