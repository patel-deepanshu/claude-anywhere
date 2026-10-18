'use strict';

// Round-2 regressions for the dialog host (src/daemon/uihost.js) and the TUI (src/tui/tui.js):
// MACOS-2-8, JOURNEYS-DOCS-5, JOURNEYS-DOCS-6, LIFECYCLE-2 and LIFECYCLE-10.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-uihost-r2-'));
process.env.ANYWHERE_HOME = TMP_HOME;

const U = require('../src/daemon/uihost');
const T = require('../src/tui/tui');

const URL_ = 'http://127.0.0.1:47120/?token=abc_DEF-123';
const PROFILE = path.join(TMP_HOME, 'ui-profile');
fs.mkdirSync(PROFILE, { recursive: true });

// ---------------------------------------------------------------- fakes

let nextPid = 3000;

function fakeChild({ exitAfter = null, code = 0 } = {}) {
  const c = new EventEmitter();
  c.pid = nextPid++;
  c.exitCode = null;
  c.signalCode = null;
  c.killed = [];
  c.unref = () => {};
  c.exit = (exitCode, sig) => {
    if (c.exitCode != null || c.signalCode != null) return;
    c.exitCode = exitCode;
    c.signalCode = sig || null;
    c.emit('exit', exitCode, sig || null);
  };
  c.kill = (sig = 'SIGTERM') => {
    c.killed.push(sig);
    setImmediate(() => c.exit(null, sig));
    return true;
  };
  if (exitAfter != null) setTimeout(() => c.exit(code, null), exitAfter);
  return c;
}

/** spawn() recorder; `plan(cmd, args)` returns fakeChild options. `log` gets ['spawn', cmd]. */
function fakeSpawn(plan, log = []) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = fakeChild(plan(cmd, args, opts) || {});
    calls.push({ cmd, args, opts, child });
    log.push(['spawn', cmd]);
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** process.kill stand-in: `alive` pids answer signal 0 until they get a signal. */
function fakeKill(alive = [], log = []) {
  const set = new Set(alive);
  const killed = [];
  const fn = (pid, sig) => {
    if (sig === 0) {
      if (set.has(Math.abs(pid))) return true;
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }
    killed.push([pid, sig]);
    log.push(['kill', pid, sig]);
    set.delete(Math.abs(pid));
    return true;
  };
  fn.killed = killed;
  return fn;
}

const fakeWhich = (map) => (name) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null);
const fakeExists = (list) => {
  const set = new Set(list);
  return (p) => set.has(p);
};
const unsupported = () => Object.assign(new Error('Window management is not available on gnome (Wayland)'), { code: 'UNSUPPORTED' });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const LINUX = { platform: 'linux', isWSL: false, displayServer: 'x11', isHeadless: false };
const WAYLAND = { platform: 'linux', isWSL: false, displayServer: 'wayland', isHeadless: false };
const MAC = { platform: 'darwin', isWSL: false, displayServer: 'quartz' };
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAC_EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const MAC_BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

function makeHost(o = {}) {
  const config = { ui: { host: 'auto', alwaysOnTop: false, width: 440, height: 720, position: 'right', ...(o.ui || {}) } };
  return new U.UiHost({
    config,
    platformInfo: o.platformInfo || LINUX,
    driver: o.driver || null,
    env: o.env || { DISPLAY: ':0' },
    which: o.which || fakeWhich({}),
    exists: o.exists || fakeExists([]),
    spawn: o.spawn || fakeSpawn(() => ({})),
    run: o.run || (async () => ({ code: 1, stdout: '', stderr: '', error: null })),
    kill: o.kill || fakeKill(),
    getuid: () => 1000,
    homedir: '/home/me',
    realpath: (p) => p,
    readHead: () => '',
    resolveModule: () => {
      throw new Error('not installed');
    },
    profileDir: PROFILE,
    stateDir: TMP_HOME,
    logFile: false,
    earlyExitMs: o.earlyExitMs != null ? o.earlyExitMs : 60,
    topmostWaitMs: 200,
    browserWaitMs: 30,
    pidWaitMs: 50,
    driverTimeoutMs: o.driverTimeoutMs != null ? o.driverTimeoutMs : 1000,
    cleanupLeftovers: o.cleanupLeftovers === true,
    ...(o.clientCount ? { clientCount: o.clientCount } : {}),
  });
}

// ---------------------------------------------------------------- MACOS-2-8

test('MACOS-2-8: a focus request that outlives the wait is still pending; show opens no second window', async () => {
  const focused = [];
  let settled = false;
  const driver = {
    listWindows: async () => [{ id: '700:5', title: 'Claude Anywhere', pid: 700 }],
    // System Events holds the request behind the Automation consent prompt.
    focusWindow: (id) =>
      new Promise((resolve) => {
        focused.push(id);
        setTimeout(() => {
          settled = true;
          resolve(true);
        }, 400);
      }),
  };
  const spawn = fakeSpawn(() => ({ exitAfter: 5, code: 0 }));
  const host = makeHost({ platformInfo: MAC, env: {}, which: fakeWhich({ open: '/usr/bin/open' }), exists: fakeExists([MAC_CHROME]), spawn, driver, driverTimeoutMs: 50 });
  assert.equal((await host.open(URL_)).host, 'app');
  assert.equal(spawn.calls.length, 1);
  const res = await host.show(URL_);
  assert.deepEqual(res, { host: 'app' });
  assert.equal(settled, false, 'show answered before the focus request completed');
  assert.deepEqual(focused, ['700:5']);
  assert.equal(spawn.calls.length, 1, 'no `open -n -a` hand-off: it would add a second dialog window');
  await tick(450);
  assert.equal(settled, true);
});

test('MACOS-2-8: a focus request that fails outright still reopens the dialog', async () => {
  const driver = {
    listWindows: async () => [{ id: 9, title: 'Claude Anywhere', pid: 1 }],
    focusWindow: async () => false,
  };
  const spawn = fakeSpawn(() => ({}));
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn, driver, driverTimeoutMs: 50 });
  await host.open(URL_);
  await host.show(URL_);
  assert.equal(spawn.calls.length, 2);
  await host.close();
});

// ---------------------------------------------------------------- JOURNEYS-DOCS-5

test('JOURNEYS-DOCS-5: macOS browsers are ordered by Web Speech support before the default-browser demotion', () => {
  const C = (name, bundleId) => ({ name, bundleId });
  const chrome = C('Google Chrome', 'com.google.Chrome');
  const canary = C('Google Chrome Canary', 'com.google.Chrome.canary');
  const edge = C('Microsoft Edge', 'com.microsoft.edgemac');
  const brave = C('Brave', 'com.brave.Browser');
  const chromium = C('Chromium', 'org.chromium.Chromium');
  const vivaldi = C('Vivaldi', 'com.vivaldi.Vivaldi');
  const names = (list) => list.map((c) => c.name);

  // The reported journey: Chrome is the default and Brave is installed.
  assert.deepEqual(names(U.orderMacCandidates([chrome, brave], 'com.google.Chrome')), ['Google Chrome', 'Brave']);
  assert.deepEqual(names(U.orderMacCandidates([chrome, brave, chromium, vivaldi], 'com.google.chrome')), ['Google Chrome', 'Brave', 'Chromium', 'Vivaldi']);
  // Another speech-capable browser takes the default's place.
  assert.deepEqual(names(U.orderMacCandidates([chrome, edge, brave], 'com.google.Chrome')), ['Microsoft Edge', 'Google Chrome', 'Brave']);
  assert.deepEqual(names(U.orderMacCandidates([chrome, canary, brave], 'com.google.Chrome')), ['Google Chrome Canary', 'Google Chrome', 'Brave']);
  // A default in the second tier is demoted within it only.
  assert.deepEqual(names(U.orderMacCandidates([brave, chromium, chrome], 'com.brave.Browser')), ['Google Chrome', 'Chromium', 'Brave']);
  assert.deepEqual(names(U.orderMacCandidates([brave, chrome], null)), ['Google Chrome', 'Brave']);
  // ANYWHERE_BROWSER / CHROME_PATH (no bundle id) stay first.
  const env = { name: 'Thorium', bundle: '/Applications/Thorium.app' };
  assert.deepEqual(names(U.orderMacCandidates([env, chrome, brave], 'com.google.Chrome')), ['Thorium', 'Google Chrome', 'Brave']);

  assert.equal(U.hasBrowserSpeech(chrome), true);
  assert.equal(U.hasBrowserSpeech(canary), true);
  assert.equal(U.hasBrowserSpeech(edge), true);
  for (const c of [brave, chromium, vivaldi]) assert.equal(U.hasBrowserSpeech(c), false, c.name);
  assert.equal(U.hasBrowserSpeech({ name: 'Chromium' }), false);
  assert.equal(U.hasBrowserSpeech({ name: 'msedge' }), true);
  assert.equal(U.hasBrowserSpeech(null), false);
  // MAC_BROWSERS itself lists the speech-capable tier first.
  const firstNoSpeech = U.MAC_BROWSERS.findIndex(([name, , id]) => !U.hasBrowserSpeech({ name, bundleId: id }));
  assert.ok(U.MAC_BROWSERS.slice(firstNoSpeech).every(([name, , id]) => !U.hasBrowserSpeech({ name, bundleId: id })));
});

test('JOURNEYS-DOCS-5: with Chrome as the default browser and Brave installed, the dialog opens in Chrome', async () => {
  const run = async (cmd) => (/osascript$/.test(cmd) ? { code: 0, stdout: 'com.google.Chrome\n', stderr: '' } : { code: 1, stdout: '', stderr: '' });
  const spawn = fakeSpawn(() => ({ exitAfter: 5, code: 0 }));
  const host = makeHost({ platformInfo: MAC, env: {}, which: fakeWhich({ open: '/usr/bin/open', osascript: '/usr/bin/osascript' }), exists: fakeExists([MAC_CHROME, MAC_BRAVE]), spawn, run });
  assert.equal((await host.open(URL_)).host, 'app');
  assert.deepEqual(spawn.calls[0].args.slice(0, 3), ['-n', '-a', '/Applications/Google Chrome.app']);

  // Edge as well: the demotion still keeps links out of the default browser's profile.
  const spawn2 = fakeSpawn(() => ({ exitAfter: 5, code: 0 }));
  const host2 = makeHost({ platformInfo: MAC, env: {}, which: fakeWhich({ open: '/usr/bin/open', osascript: '/usr/bin/osascript' }), exists: fakeExists([MAC_CHROME, MAC_EDGE, MAC_BRAVE]), spawn: spawn2, run });
  await host2.open(URL_);
  assert.deepEqual(spawn2.calls[0].args.slice(0, 3), ['-n', '-a', '/Applications/Microsoft Edge.app']);
});

test('JOURNEYS-DOCS-5: readMacDefaultBrowserId is shared with the doctor', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    return { code: 0, stdout: 'com.brave.Browser\n', stderr: '' };
  };
  assert.equal(await U.readMacDefaultBrowserId({ run, which: fakeWhich({ osascript: '/usr/bin/osascript' }) }), 'com.brave.Browser');
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.match(calls[0][1][3], /URLForApplicationToOpenURL/);
  assert.equal(await U.readMacDefaultBrowserId({ run: async () => ({ code: 1, stdout: '' }), which: fakeWhich({}) }), null);
  assert.equal(await U.readMacDefaultBrowserId({ run: async () => ({ code: 0, stdout: 'not an id; rm -rf' }), which: fakeWhich({}) }), null);
  assert.equal(await U.readMacDefaultBrowserId({ run: async () => { throw new Error('ENOENT'); }, which: fakeWhich({}) }), null);
});

// ---------------------------------------------------------------- JOURNEYS-DOCS-6

test('JOURNEYS-DOCS-6: where windows cannot be listed, a running app window is not opened again', async () => {
  const driver = { listWindows: async () => { throw unsupported(); }, focusWindow: async () => { throw unsupported(); } };
  const spawn = fakeSpawn(() => ({}));
  const host = makeHost({ platformInfo: WAYLAND, env: { WAYLAND_DISPLAY: 'wayland-0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn, driver });
  assert.equal((await host.open(URL_)).host, 'app');
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await host.show(URL_), { host: 'app' });
  assert.equal(spawn.calls.length, 1, '`/anywhere` three times: still one window');
  // The user closed it: Chromium exits with its last window, and show opens a new one.
  spawn.calls[0].child.exit(0, null);
  assert.deepEqual(await host.show(URL_), { host: 'app' });
  assert.equal(spawn.calls.length, 2);
  await host.close();
});

test('JOURNEYS-DOCS-6: a connected dialog page counts when the browser was handed off or the host is a tab', async () => {
  const driver = { listWindows: async () => { throw unsupported(); } };
  let clients = 1;
  // exit 0: handed off to a running browser of our profile, so no owned process to watch.
  const spawn = fakeSpawn(() => ({ exitAfter: 5, code: 0 }));
  const host = makeHost({ platformInfo: WAYLAND, env: { WAYLAND_DISPLAY: 'wayland-0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn, driver, clientCount: () => clients });
  await host.open(URL_);
  assert.deepEqual(await host.show(URL_), { host: 'app' });
  assert.equal(spawn.calls.length, 1);
  clients = 0;
  await host.show(URL_);
  assert.equal(spawn.calls.length, 2, 'no page connected: open the window again');

  const tabSpawn = fakeSpawn(() => ({ exitAfter: 5, code: 0 }));
  const tab = makeHost({ ui: { host: 'browser' }, platformInfo: WAYLAND, env: { WAYLAND_DISPLAY: 'wayland-0' }, which: fakeWhich({ 'xdg-open': '/usr/bin/xdg-open' }), spawn: tabSpawn, driver, clientCount: () => 2 });
  assert.equal((await tab.open(URL_)).host, 'browser');
  assert.deepEqual(await tab.show(URL_), { host: 'browser' });
  assert.equal(tabSpawn.calls.length, 1, 'no second tab');

  // A throwing counter is ignored.
  const odd = makeHost({ ui: { host: 'browser' }, platformInfo: WAYLAND, env: { WAYLAND_DISPLAY: 'wayland-0' }, which: fakeWhich({ 'xdg-open': '/usr/bin/xdg-open' }), spawn: fakeSpawn(() => ({ exitAfter: 5, code: 0 })), driver, clientCount: () => { throw new Error('x'); } });
  await odd.open(URL_);
  assert.equal(odd._clientCount(), 0);
});

test('JOURNEYS-DOCS-6: on macOS a live browser process says nothing about its window; a listed miss still reopens', async () => {
  // macOS apps outlive their last window.
  const driver = { listWindows: async () => { throw new Error('helper timed out'); } };
  const spawn = fakeSpawn(() => ({}));
  const host = makeHost({ platformInfo: MAC, env: {}, which: fakeWhich({}), exists: fakeExists([MAC_CHROME]), spawn, driver });
  await host.open(URL_);
  await host.show(URL_);
  assert.equal(spawn.calls.length, 2);
  await host.close();

  // Listing works and finds nothing: the window is gone even if a page claims otherwise.
  const listed = { listWindows: async () => [{ id: 1, title: 'Terminal' }] };
  const sp = fakeSpawn(() => ({}));
  const h = makeHost({ env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn: sp, driver: listed, clientCount: () => 1 });
  await h.open(URL_);
  await h.show(URL_);
  assert.equal(sp.calls.length, 2);
  await h.close();
});

// ---------------------------------------------------------------- LIFECYCLE-2

test('LIFECYCLE-2: pickWindow prefers the window opened now over an equal one that predates it', () => {
  const wins = [
    { id: 11, title: 'Claude Anywhere', pid: 50 },
    { id: 22, title: 'Claude Anywhere', pid: 50 },
  ];
  assert.equal(U.pickWindow(wins).id, 11, 'without history the first match wins');
  assert.equal(U.pickWindow(wins, { stale: ['11'] }).id, 22);
  assert.equal(U.pickWindow(wins, { stale: new Set(['11']) }).id, 22);
  assert.equal(U.pickWindow([{ ...wins[0] }, { ...wins[1], minimized: true }], { stale: ['11'] }).id, 22, 'a minimized new window beats a stale one');
  assert.equal(U.pickWindow([wins[0]], { stale: ['11'] }).id, 11, 'a stale window is still a last resort');
  assert.equal(U.pickWindow([{ id: 1, title: 'Claude Anywhere' }, { id: 2, title: 'Claude Anywhere - Google Chrome' }], { stale: ['1'] }).id, 1, 'staleness only breaks ties within a match class');
  // Owned blank windows (macOS without Screen Recording).
  assert.equal(U.pickWindow([{ id: '700:6', title: '', pid: 700 }, { id: '700:9', title: '', pid: 700 }], { pids: [700], stale: ['700:6'] }).id, '700:9');
});

test('LIFECYCLE-2: the first open stops dialog browsers a crashed daemon left behind, then launches', async () => {
  const log = [];
  const snapProfile = '/home/me/snap/chromium/common/claude-anywhere-ui-profile';
  const psOut = [
    `  900 /opt/chrome --app=http://127.0.0.1:47120/?launch=dead --user-data-dir=${PROFILE} --window-size=440,720`,
    `  901 /opt/chrome --type=renderer --user-data-dir=${PROFILE}`,
    `  902 /opt/chrome --user-data-dir=${PROFILE}2`,
    '  903 /opt/google/chrome/chrome --user-data-dir=/home/me/.config/google-chrome',
    `  904 /snap/chromium/current/usr/lib/chromium-browser/chrome --user-data-dir=${snapProfile}`,
  ].join('\n');
  let psCalls = 0;
  const run = async (cmd) => {
    if (cmd === 'ps') {
      psCalls += 1;
      log.push(['ps']);
      return { code: 0, stdout: psOut, stderr: '', error: null };
    }
    return { code: 1, stdout: '', stderr: '', error: null };
  };
  const kill = fakeKill([900, 901, 902, 903, 904], log);
  const spawn = fakeSpawn(() => ({}), log);
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, which: fakeWhich({ chromium: '/snap/bin/chromium' }), exists: fakeExists(['/opt/chrome']), spawn, run, kill, cleanupLeftovers: true });
  assert.equal((await host.open(URL_)).host, 'app');
  const terms = kill.killed.filter(([, s]) => s === 'SIGTERM').map(([p]) => p).sort();
  assert.deepEqual(terms, [900, 901, 904], 'our profile (and the snap profile) only');
  const firstSpawn = log.findIndex((e) => e[0] === 'spawn');
  const lastKill = log.map((e) => e[0]).lastIndexOf('kill');
  assert.ok(lastKill >= 0 && lastKill < firstSpawn, `leftovers are stopped before the launch: ${JSON.stringify(log)}`);
  assert.equal(spawn.calls.length, 1);

  // Only once per daemon: later opens and shows never sweep (they would kill our own window).
  const before = psCalls;
  await host.show(URL_);
  await host.open(URL_);
  assert.equal(psCalls, before);
  assert.ok(!kill.killed.some(([p]) => p === spawn.calls[0].child.pid || p === -spawn.calls[0].child.pid));
});

test('LIFECYCLE-2: show as the first call also sweeps; an explicit Electron or browser host does not', async () => {
  const psOut = `  910 /opt/chrome --user-data-dir=${PROFILE}`;
  const run = async (cmd) => (cmd === 'ps' ? { code: 0, stdout: psOut, stderr: '', error: null } : { code: 1, stdout: '', stderr: '', error: null });
  const kill = fakeKill([910]);
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn: fakeSpawn(() => ({})), run, kill, cleanupLeftovers: true });
  await host.show(URL_);
  assert.deepEqual(kill.killed[0], [910, 'SIGTERM']);
  await host.close();

  for (const ui of [{ host: 'electron' }, { host: 'browser' }]) {
    const k = fakeKill([910]);
    const h = makeHost({ ui, env: { DISPLAY: ':0', ANYWHERE_ELECTRON: '/opt/electron' }, which: fakeWhich({ 'xdg-open': '/usr/bin/xdg-open' }), exists: fakeExists(['/opt/electron']), spawn: fakeSpawn(() => ({ exitAfter: 5, code: 0 })), run, kill: k, cleanupLeftovers: true });
    await h.open(URL_);
    assert.deepEqual(k.killed, [], `ui.host ${ui.host}`);
  }
});

test('LIFECYCLE-2: show focuses the new window, not an older "Claude Anywhere" window that predates the daemon', async () => {
  let phase = 'before';
  const focused = [];
  const driver = {
    listWindows: async () =>
      phase === 'before'
        ? [{ id: 'old', title: 'Claude Anywhere', pid: 5 }]
        : [{ id: 'old', title: 'Claude Anywhere', pid: 5 }, { id: 'new', title: 'Claude Anywhere', pid: 5 }],
    focusWindow: async (id) => {
      focused.push(id);
      return true;
    },
  };
  // The sweep could not stop the old browser (ps unavailable), and the launch was handed off to it.
  const spawn = fakeSpawn(() => {
    phase = 'after';
    return { exitAfter: 5, code: 0 };
  });
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn, driver, cleanupLeftovers: true });
  await host.open(URL_);
  assert.deepEqual([...host._staleIds], ['old']);
  assert.deepEqual(await host.show(URL_), { host: 'app' });
  assert.deepEqual(focused, ['new']);
  // Once the old window is gone its id is forgotten: X11 hands ids out again.
  phase = 'gone';
  driver.listWindows = async () => [{ id: 'new', title: 'Claude Anywhere', pid: 5 }];
  await host.show(URL_);
  assert.equal(host._staleIds.size, 0);
});

const macPs = [
  `  700 ${MAC_CHROME} --app=http://127.0.0.1:47120/?launch=dead --user-data-dir=${PROFILE} --window-size=440,720`,
  `  701 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper --type=renderer --user-data-dir=${PROFILE}`,
  `  800 ${MAC_CHROME}`,
].join('\n');

test('LIFECYCLE-2: macOS stops a leftover dialog instance that holds only the dialog', async () => {
  const log = [];
  const run = async (cmd) => (cmd === 'ps' ? { code: 0, stdout: macPs, stderr: '' } : { code: 1, stdout: '', stderr: '' });
  const driver = { listWindows: async () => [{ id: '700:5', title: 'Claude Anywhere', pid: 700 }, { id: '800:1', title: 'Docs', pid: 800 }], closeWindow: async () => true };
  const kill = fakeKill([700, 701, 800], log);
  const spawn = fakeSpawn(() => ({ exitAfter: 5, code: 0 }), log);
  const host = makeHost({ platformInfo: MAC, env: {}, which: fakeWhich({ open: '/usr/bin/open' }), exists: fakeExists([MAC_CHROME]), spawn, run, driver, kill, cleanupLeftovers: true });
  await host.open(URL_);
  assert.deepEqual(kill.killed.filter(([, s]) => s === 'SIGTERM').map(([p]) => p).sort(), [700, 701], 'never the user browser (800)');
  assert.ok(log.findIndex((e) => e[0] === 'kill') < log.findIndex((e) => e[0] === 'spawn'));
});

test('LIFECYCLE-2: macOS keeps a leftover instance that holds the user windows, closes its dialog and prefers the new one', async () => {
  const run = async (cmd) => (cmd === 'ps' ? { code: 0, stdout: macPs, stderr: '' } : { code: 1, stdout: '', stderr: '' });
  const closed = [];
  const focused = [];
  let wins = [
    { id: '700:5', title: 'Claude Anywhere', pid: 700 },
    { id: '700:6', title: 'Inbox - Gmail', pid: 700 },
    { id: '800:1', title: 'Docs', pid: 800 },
  ];
  const driver = {
    listWindows: async () => wins,
    closeWindow: async (id) => {
      closed.push(id);
      wins = wins.filter((w) => w.id !== id);
      return true;
    },
    focusWindow: async (id) => {
      focused.push(id);
      return true;
    },
  };
  const kill = fakeKill([700, 701, 800]);
  const spawn = fakeSpawn(() => {
    // `open -n` hands the new dialog to the running instance. No Screen Recording: blank titles.
    wins = [{ id: '700:6', title: '', pid: 700 }, { id: '700:9', title: '', pid: 700 }, { id: '800:1', title: '', pid: 800 }];
    return { exitAfter: 5, code: 0 };
  });
  const host = makeHost({ platformInfo: MAC, env: {}, which: fakeWhich({ open: '/usr/bin/open' }), exists: fakeExists([MAC_CHROME]), spawn, run, driver, kill, cleanupLeftovers: true });
  await host.open(URL_);
  assert.deepEqual(kill.killed, [], 'the instance holding a user window keeps running');
  assert.deepEqual(closed, ['700:5'], 'only the dead dialog window is closed');
  assert.ok(host._staleIds.has('700:6'));
  assert.deepEqual(await host.show(URL_), { host: 'app' });
  assert.deepEqual(focused, ['700:9']);
});

test('LIFECYCLE-2: Windows and WSL sweep the profile through PowerShell before launching', async () => {
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const log = [];
  const run = async (cmd, args) => {
    const script = cmd === ps || /powershell/.test(cmd) ? Buffer.from(args[args.length - 1], 'base64').toString('utf16le') : '';
    log.push(['run', cmd, script]);
    if (script.includes('Start-Process')) return { code: 0, stdout: 'ANYWHERE_PID 4242 C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe\r\n', stderr: '' };
    if (script.includes('Win32_Process')) return { code: 0, stdout: 'ANYWHERE_KILLED 1\r\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const spawn = fakeSpawn(() => ({}), log);
  const host = makeHost({
    platformInfo: { platform: 'win32', isWSL: false, displayServer: 'windows' },
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
    exists: fakeExists([chrome, ps]),
    spawn,
    run,
    cleanupLeftovers: true,
  });
  assert.equal((await host.open(URL_)).host, 'app');
  assert.equal(log[0][0], 'run');
  assert.match(log[0][2], /Win32_Process/);
  const b64 = /FromBase64String\('([^']+)'\)/.exec(log[0][2])[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), PROFILE);
  assert.equal(log[1][0], 'spawn');
  await host.close();

  log.length = 0;
  const wsl = makeHost({
    platformInfo: { platform: 'linux', isWSL: true, displayServer: 'windows' },
    env: {},
    which: fakeWhich({ 'powershell.exe': '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' }),
    exists: fakeExists(['/mnt/c']),
    run,
    cleanupLeftovers: true,
  });
  assert.equal((await wsl.open(URL_)).host, 'app');
  const scripts = log.filter((e) => e[2]).map((e) => e[2]);
  assert.match(scripts[0], /Win32_Process/);
  assert.match(scripts[0], /Join-Path \$env:LOCALAPPDATA 'claude-anywhere\\ui-profile'/);
  assert.match(scripts[1], /Start-Process/, 'the launch comes after the sweep');
});

// ---------------------------------------------------------------- LIFECYCLE-10 (TUI)

function fakeClient(responses = {}) {
  const calls = [];
  let onEvent = null;
  return {
    calls,
    emit: (type, data) => onEvent(type, data),
    closed: false,
    subscribe(fn) {
      onEvent = fn;
      const self = this;
      return {
        close() {
          self.closed = true;
        },
      };
    },
    async request(method, p, body) {
      calls.push({ method, path: p, body });
      const r = responses[`${method} ${p}`];
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(body);
      return r || { ok: true };
    },
    async postBinary() {
      return { text: '' };
    },
  };
}

const SNAPSHOT = {
  version: '0.1.0',
  mode: 'companion',
  status: 'idle',
  project: { dir: '/w/api', name: 'api' },
  session: { id: 's1', model: 'm' },
  config: {},
  messages: [],
  pending: { approvals: [], questions: [] },
};

async function startTui({ idleQuitMs = 40, responses } = {}) {
  const client = fakeClient(responses);
  const input = new PassThrough();
  const out = new PassThrough();
  let text = '';
  out.on('data', (d) => {
    text += d.toString();
  });
  const tui = new T.Tui({ client, input, output: out, env: { NO_COLOR: '1', LANG: 'en_US.UTF-8' }, platform: 'linux', cwd: '/w', homedir: '/home/me', idleQuitMs });
  const done = tui.run();
  let finished = false;
  done.then(() => {
    finished = true;
  });
  await tick();
  return { tui, client, input, done, finished: () => finished, text: () => text };
}

test('LIFECYCLE-10: piped commands folded into one turn still end the TUI once the daemon is idle', async () => {
  const t = await startTui();
  t.client.emit('snapshot', SNAPSHOT);
  t.input.end('SLOW_TEST\ntwo\nthree\n');
  await tick(20);
  assert.equal(t.client.calls.filter((c) => c.path === '/api/command').length, 3);
  t.client.emit('status', { status: 'thinking' });
  t.client.emit('result', { costUsd: 0.01, numTurns: 1 });
  // 'two' and 'three' were queued during the first turn and answered as one.
  t.client.emit('result', { costUsd: 0.01, numTurns: 1 });
  await tick(100);
  assert.equal(t.finished(), false, 'the daemon is still busy');
  t.client.emit('status', { status: 'idle' });
  await t.done;
  assert.equal(t.tui.closed, true);
  assert.equal(t.client.closed, true);
});

test('LIFECYCLE-10: a command that never gets a result (dropped, engine failure) does not keep the TUI open', async () => {
  const t = await startTui();
  t.client.emit('snapshot', SNAPSHOT);
  t.input.end('one\n');
  await tick(20);
  t.client.emit('status', { status: 'starting' });
  t.client.emit('status', { status: 'error', detail: 'Claude Code failed to start' });
  await t.done;
  assert.match(t.text(), /error — Claude Code failed to start/);
});

test('LIFECYCLE-10: a stale idle status racing the POST reply does not end the TUI early', async () => {
  const t = await startTui({ idleQuitMs: 120 });
  t.client.emit('snapshot', SNAPSHOT);
  t.input.end('one\n');
  await tick(30);
  // The reply came back before the daemon's 'starting' status.
  t.client.emit('status', { status: 'starting' });
  await tick(200);
  assert.equal(t.finished(), false);
  t.client.emit('status', { status: 'thinking' });
  t.client.emit('status', { status: 'idle' });
  // A brief idle between turns cancels the countdown.
  await tick(40);
  t.client.emit('status', { status: 'thinking' });
  await tick(200);
  assert.equal(t.finished(), false);
  t.client.emit('result', {});
  t.client.emit('status', { status: 'idle' });
  await t.done;
});

test('LIFECYCLE-10: an open approval keeps it waiting; a POST still out keeps it waiting', async () => {
  let release;
  const slow = new Promise((r) => {
    release = r;
  });
  const t = await startTui({ responses: { 'POST /api/command': () => slow.then(() => ({ ok: true, id: 'c1' })) } });
  t.client.emit('snapshot', SNAPSHOT);
  t.input.end('one\n');
  await tick(100);
  assert.equal(t.finished(), false, 'the command has not been accepted yet');
  release();
  await tick(5);
  t.client.emit('status', { status: 'thinking' });
  t.client.emit('approval_request', { id: 'ap1', toolName: 'Bash', summary: 'ls', risk: 'low' });
  t.client.emit('status', { status: 'idle' });
  await tick(100);
  assert.equal(t.finished(), false, 'an approval is still open');
  t.client.emit('approval_resolved', { id: 'ap1', decision: 'deny' });
  await t.done;
});

test('LIFECYCLE-10: a reconnect snapshot of an idle daemon resets the in-flight count', async () => {
  const t = await startTui();
  t.client.emit('snapshot', SNAPSHOT);
  await t.tui.handleInput('do something');
  assert.equal(t.tui.inFlight, 1);
  t.client.emit('status', { status: 'thinking' });
  t.client.emit('_disconnected', {});
  // The result was broadcast while the stream was down.
  t.client.emit('snapshot', { ...SNAPSHOT, status: 'idle' });
  assert.equal(t.tui.inFlight, 0);
  t.client.emit('snapshot', { ...SNAPSHOT, status: 'thinking' });
  assert.equal(t.tui.inFlight, 0);
  t.tui.quit();
  await t.done;
});
