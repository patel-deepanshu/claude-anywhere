'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync, execFileSync } = require('child_process');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-uihost-'));
process.env.ANYWHERE_HOME = TMP_HOME;

const U = require('../src/daemon/uihost');
const electronMain = require('../src/electron/main');

const URL_ = 'http://127.0.0.1:47120/?token=abc_DEF-123';
const PROFILE = path.join(TMP_HOME, 'ui-profile');
fs.mkdirSync(PROFILE, { recursive: true });

// ---------------------------------------------------------------- fakes

let nextPid = 1000;
const liveChildren = new Map();

/** process.kill look-alike over the fake children (signal 0 probes liveness). */
function fakeKill(pid, sig) {
  const c = liveChildren.get(Math.abs(pid));
  const alive = c && c.exitCode == null && c.signalCode == null;
  if (sig === 0) {
    if (alive) return true;
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  }
  if (alive) setImmediate(() => c.exit(null, sig));
  return true;
}

/** A ChildProcess look-alike. exitAfter (ms) + code, or error, or stays alive. */
function fakeChild({ exitAfter = null, code = 0, signal = null, error = null } = {}) {
  const c = new EventEmitter();
  c.pid = nextPid++;
  liveChildren.set(c.pid, c);
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
  if (error) setImmediate(() => c.emit('error', error));
  else if (exitAfter != null) setTimeout(() => c.exit(code, signal), exitAfter);
  return c;
}

/** spawn() recorder; `plan(cmd, args, opts)` returns fakeChild options. */
function fakeSpawn(plan) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = fakeChild(plan(cmd, args, opts) || {});
    calls.push({ cmd, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

function fakeWhich(map) {
  return (name) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null);
}

function fakeExists(list) {
  const set = new Set(list);
  return (p) => set.has(p);
}

const linuxInfo = { platform: 'linux', isWSL: false, displayServer: 'x11', isHeadless: false };

function makeHost(overrides = {}) {
  const config = { ui: { host: 'auto', alwaysOnTop: false, hotkey: 'CommandOrControl+Shift+Space', width: 440, height: 720, position: 'right', hideFromScreenshots: true, ...(overrides.ui || {}) } };
  return new U.UiHost({
    config,
    platformInfo: overrides.platformInfo || linuxInfo,
    driver: overrides.driver || null,
    env: overrides.env || { DISPLAY: ':0' },
    which: overrides.which || fakeWhich({}),
    exists: overrides.exists || fakeExists([]),
    spawn: overrides.spawn || fakeSpawn(() => ({})),
    run: overrides.run || (async () => ({ code: 1, stdout: '', stderr: '', error: null })),
    kill: overrides.kill || fakeKill,
    getuid: () => 1000,
    homedir: '/home/me',
    realpath: overrides.realpath || ((p) => p),
    readHead: overrides.readHead || (() => ''),
    resolveModule: overrides.resolveModule || (() => {
      throw new Error('not installed');
    }),
    loadModule: overrides.loadModule,
    profileDir: PROFILE,
    stateDir: TMP_HOME,
    logFile: false,
    earlyExitMs: overrides.earlyExitMs != null ? overrides.earlyExitMs : 80,
    topmostWaitMs: overrides.topmostWaitMs != null ? overrides.topmostWaitMs : 2000,
    browserWaitMs: 50,
  });
}

// ---------------------------------------------------------------- pure helpers

test('hostOrder: auto, explicit hosts fall back to browser then none', () => {
  assert.deepEqual(U.hostOrder('auto'), ['electron', 'app', 'browser', 'none']);
  assert.deepEqual(U.hostOrder(undefined), ['electron', 'app', 'browser', 'none']);
  assert.deepEqual(U.hostOrder('electron'), ['electron', 'browser', 'none']);
  assert.deepEqual(U.hostOrder('APP'), ['app', 'browser', 'none']);
  assert.deepEqual(U.hostOrder('browser'), ['browser', 'none']);
  assert.deepEqual(U.hostOrder('none'), ['none']);
  assert.deepEqual(U.hostOrder('tui'), ['none']);
  assert.deepEqual(U.hostOrder('bogus'), ['electron', 'app', 'browser', 'none']);
});

test('computeBounds: right edge of the primary display, defaults to 1440x900', () => {
  assert.deepEqual(U.computeBounds({}), { x: 976, y: 48, width: 440, height: 720 });
  const displays = [
    { index: 0, x: 1920, y: 0, width: 1920, height: 1080, primary: false },
    { index: 1, x: 0, y: 0, width: 2560, height: 1440, primary: true },
  ];
  assert.deepEqual(U.computeBounds({ displays, width: 440, height: 720 }), { x: 2096, y: 48, width: 440, height: 720 });
  // No primary flag: first display.
  assert.deepEqual(U.computeBounds({ displays: [{ x: 100, y: 50, width: 1280, height: 1024 }] }), { x: 100 + 1280 - 440 - 24, y: 98, width: 440, height: 720 });
});

test('computeBounds: clamps on small displays and honours position', () => {
  assert.deepEqual(U.computeBounds({ displays: [{ x: 0, y: 0, width: 800, height: 600, primary: true }] }), { x: 336, y: 48, width: 440, height: 504 });
  const tiny = U.computeBounds({ displays: [{ x: 0, y: 0, width: 300, height: 300, primary: true }] });
  assert.equal(tiny.width, 300);
  assert.equal(tiny.height, 300);
  assert.equal(tiny.x, 0);
  assert.equal(tiny.y, 0);
  assert.equal(U.computeBounds({ position: 'left' }).x, 24);
  assert.equal(U.computeBounds({ position: 'center' }).x, Math.round((1440 - 440) / 2));
  // Invalid entries are ignored.
  assert.deepEqual(U.computeBounds({ displays: [null, { width: 0, height: 0 }] }), { x: 976, y: 48, width: 440, height: 720 });
});

test('computeBounds: Windows DPI scaling converts physical pixels to DIPs', () => {
  const displays = [{ x: 0, y: 0, width: 2880, height: 1800, scale: 1, dpiScale: 1.5, primary: true }];
  assert.deepEqual(U.computeBounds({ displays, useDpiScale: true }), { x: 1920 - 440 - 24, y: 48, width: 440, height: 720 });
  assert.deepEqual(U.computeBounds({ displays, useDpiScale: false }), { x: 2880 - 440 - 24, y: 48, width: 440, height: 720 });
});

test('chromiumArgs: app window switches with our profile', () => {
  const args = U.chromiumArgs({ url: URL_, profileDir: '/p', width: 440, height: 720, x: 976, y: 48 });
  assert.deepEqual(args, [
    `--app=${URL_}`,
    '--user-data-dir=/p',
    '--window-size=440,720',
    '--window-position=976,48',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
    '--class=claude-anywhere',
    '--disable-session-crashed-bubble',
  ]);
  assert.ok(U.chromiumArgs({ url: URL_, profileDir: '/p', width: 1, height: 1, noSandbox: true }).includes('--no-sandbox'));
  assert.ok(!U.chromiumArgs({ url: URL_, profileDir: '/p', width: 1, height: 1 }).some((a) => a.startsWith('--window-position')));
});

test('electronArgs: main.js first, every switch present; --no-sandbox before the app path', () => {
  const ui = { alwaysOnTop: true, hotkey: 'Alt+Space', hideFromScreenshots: false, width: 500, height: 800, position: 'left' };
  const args = U.electronArgs({ url: URL_, ui });
  assert.equal(args[0], U.ELECTRON_MAIN);
  assert.ok(fs.existsSync(U.ELECTRON_MAIN), 'electron/main.js exists');
  assert.deepEqual(args.slice(1), [
    '--url', URL_,
    '--always-on-top', 'true',
    '--hotkey', 'Alt+Space',
    '--hide-from-screenshots', 'false',
    '--width', '500',
    '--height', '800',
    '--position', 'left',
  ]);
  assert.deepEqual(U.electronArgs({ url: URL_, ui, noSandbox: true }).slice(0, 2), ['--no-sandbox', U.ELECTRON_MAIN]);
});

test('electron main.js parses exactly what uihost passes', () => {
  const ui = { alwaysOnTop: false, hotkey: 'CommandOrControl+Shift+Space', hideFromScreenshots: true, width: 460, height: 700, position: 'right' };
  const argv = ['/usr/bin/electron', ...U.electronArgs({ url: URL_, ui, noSandbox: true })];
  const parsed = electronMain.parseArgs(argv);
  assert.deepEqual(parsed, {
    url: URL_,
    alwaysOnTop: false,
    hotkey: 'CommandOrControl+Shift+Space',
    hideFromScreenshots: true,
    width: 460,
    height: 700,
    position: 'right',
  });
  // Flag form and --name=value form.
  const p2 = electronMain.parseArgs(['e', 'main.js', `--url=${URL_}`, '--always-on-top', '--width=abc']);
  assert.equal(p2.url, URL_);
  assert.equal(p2.alwaysOnTop, true);
  assert.equal(p2.width, 440);
});

test('electron main.js helpers: origin checks, permissions, bounds', () => {
  const origin = 'http://127.0.0.1:47120';
  assert.equal(electronMain.originOf(URL_), origin);
  assert.equal(electronMain.originOf(`blob:${origin}/5f0c`), origin);
  assert.equal(electronMain.originOf('file:///etc/passwd'), null);
  assert.equal(electronMain.originOf('nonsense'), null);
  const allowed = (o) => electronMain.permissionAllowed({ trustedOrigin: origin, ...o });
  assert.equal(allowed({ permission: 'media', origin, mediaTypes: ['audio'] }), true);
  assert.equal(allowed({ permission: 'media', origin, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(allowed({ permission: 'media', origin: 'https://evil.example', mediaTypes: ['audio'] }), false);
  assert.equal(allowed({ permission: 'media', origin: 'http://localhost:47120', mediaTypes: ['audio'] }), false);
  assert.equal(allowed({ permission: 'media', origin, mediaType: 'video' }), false);
  assert.equal(allowed({ permission: 'media', origin, mediaType: 'audio' }), true);
  assert.equal(allowed({ permission: 'geolocation', origin }), false);
  assert.equal(allowed({ permission: 'notifications', origin }), false);
  assert.equal(allowed({ permission: 'clipboard-sanitized-write', origin }), true);
  assert.deepEqual(electronMain.windowBounds({ x: 0, y: 25, width: 1440, height: 875 }, 440, 720), { x: 984, y: 41, width: 440, height: 720 });
  const small = electronMain.windowBounds({ x: 0, y: 0, width: 800, height: 500 }, 440, 720);
  assert.equal(small.height, 468);
  assert.ok(electronMain.ICON_DATA_URL.startsWith('data:image/png;base64,'));
  const png = Buffer.from(electronMain.ICON_DATA_URL.split(',')[1], 'base64');
  assert.equal(png.readUInt32BE(16), 16);
  assert.equal(png.readUInt32BE(20), 16);
});

test('electron files pass node --check and main.js refuses to run under plain node', () => {
  for (const f of ['src/electron/main.js', 'src/electron/preload.js']) {
    const r = spawnSync(process.execPath, ['--check', path.join(__dirname, '..', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src/electron/main.js')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be run with Electron/);
  assert.equal(r.stdout, '');
});

test('findChromiumCandidates: macOS app bundles in /Applications and ~/Applications', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const edge = '/home/me/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  const list = U.findChromiumCandidates({
    platformInfo: { platform: 'darwin' },
    env: {},
    which: fakeWhich({}),
    exists: fakeExists([chrome, edge]),
    homedir: '/home/me',
    profileDir: '/p',
  });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { profileDir: '/p', name: 'Google Chrome', cmd: chrome, prefixArgs: [], kind: 'mac-app', bundle: '/Applications/Google Chrome.app' });
  assert.equal(list[1].name, 'Microsoft Edge');
  assert.equal(list[1].bundle, '/home/me/Applications/Microsoft Edge.app');
});

test('findChromiumCandidates: Windows Program Files and LocalAppData, Chrome before Edge', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  const brave = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  const list = U.findChromiumCandidates({ platformInfo: { platform: 'win32' }, env, which: fakeWhich({}), exists: fakeExists([edge, chrome, brave]), profileDir: 'C:\\p' });
  assert.deepEqual(list.map((c) => c.cmd), [chrome, edge, brave]);
  assert.ok(list.every((c) => c.kind === 'path' && c.profileDir === 'C:\\p'));
  // Only Edge (always present on Windows 10/11).
  const only = U.findChromiumCandidates({ platformInfo: { platform: 'win32' }, env: {}, which: fakeWhich({}), exists: fakeExists(['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']), profileDir: 'C:\\p' });
  assert.equal(only.length, 1);
  assert.equal(only[0].name, 'Microsoft Edge');
});

test('findChromiumCandidates: Linux PATH, snap wrapper, flatpak, env override, de-duplication', () => {
  const which = fakeWhich({
    'google-chrome': '/usr/bin/google-chrome',
    'google-chrome-stable': '/usr/bin/google-chrome-stable',
    'chromium-browser': '/usr/bin/chromium-browser',
    flatpak: '/usr/bin/flatpak',
  });
  const realpath = (p) => (p.startsWith('/usr/bin/google-chrome') ? '/opt/google/chrome/google-chrome' : p);
  const readHead = (p) => (p === '/usr/bin/chromium-browser' ? '#!/bin/sh\nexec /snap/bin/chromium "$@"\n' : '\x7fELF');
  const exists = fakeExists(['/var/lib/flatpak/app/org.chromium.Chromium', '/opt/pw/chrome']);
  const list = U.findChromiumCandidates({
    platformInfo: { platform: 'linux', isWSL: false },
    env: { ANYWHERE_BROWSER: '/opt/pw/chrome' },
    which,
    exists,
    realpath,
    readHead,
    homedir: '/home/me',
    profileDir: '/home/me/.claude-anywhere/ui-profile',
  });
  assert.deepEqual(list.map((c) => [c.kind, c.cmd]), [
    ['path', '/opt/pw/chrome'],
    ['path', '/usr/bin/google-chrome'],
    ['snap', '/usr/bin/chromium-browser'],
    ['flatpak', '/usr/bin/flatpak'],
  ]);
  assert.equal(list[2].profileDir, '/home/me/snap/chromium/common/claude-anywhere-ui-profile');
  assert.deepEqual(list[3].prefixArgs, ['run', '--filesystem=/home/me/.claude-anywhere/ui-profile', 'org.chromium.Chromium']);
});

test('snapNameOf: direct snap paths, /usr/bin/snap symlinks, wrapper scripts', () => {
  assert.equal(U.snapNameOf('/snap/bin/chromium'), 'chromium');
  assert.equal(U.snapNameOf('/usr/bin/brave', { realpath: () => '/usr/bin/snap', readHead: () => '' }), 'brave');
  assert.equal(U.snapNameOf('/usr/bin/chromium', { realpath: (p) => p, readHead: () => '#!/bin/sh\nexec /usr/lib/chromium/chromium "$@"' }), null);
});

test('browserOpenCommands per platform', () => {
  const url = 'http://127.0.0.1:1/?a=1&b=2';
  const mac = U.browserOpenCommands({ platformInfo: { platform: 'darwin' }, url, which: fakeWhich({ open: '/usr/bin/open' }) });
  assert.deepEqual(mac, [{ name: 'open', cmd: '/usr/bin/open', args: [url] }]);

  const win = U.browserOpenCommands({ platformInfo: { platform: 'win32' }, url, env: { SystemRoot: 'C:\\Windows' } });
  assert.equal(win[0].cmd, 'C:\\Windows\\System32\\rundll32.exe');
  assert.deepEqual(win[0].args, ['url.dll,FileProtocolHandler', url]);
  assert.equal(win[1].cmd, 'C:\\Windows\\explorer.exe');
  assert.equal(win[1].anyExit, true);

  const wsl = U.browserOpenCommands({
    platformInfo: { platform: 'linux', isWSL: true },
    url,
    which: fakeWhich({ wslview: '/usr/bin/wslview' }),
    exists: fakeExists(['/mnt/c', '/mnt/c/Windows/System32/rundll32.exe', '/mnt/c/Windows/explorer.exe', '/mnt/c/Windows/System32/cmd.exe']),
  });
  assert.deepEqual(wsl.map((c) => c.name), ['wslview', 'rundll32.exe', 'explorer.exe', 'cmd.exe']);
  assert.equal(wsl[1].cwd, '/mnt/c');
  assert.deepEqual(wsl[3].args, ['/d', '/c', 'start', '""', 'http://127.0.0.1:1/?a=1^&b=2']);

  const linux = U.browserOpenCommands({
    platformInfo: { platform: 'linux', isWSL: false },
    url,
    which: fakeWhich({ 'xdg-open': '/usr/bin/xdg-open', firefox: '/usr/bin/firefox' }),
    env: { BROWSER: 'firefox --new-window %s:lynx' },
  });
  assert.deepEqual(linux.map((c) => c.cmd), ['/usr/bin/xdg-open', '/usr/bin/firefox']);
  assert.deepEqual(linux[1].args, ['--new-window', url]);
});

test('WSL launch script: -EncodedCommand decodes back to the script and the URL survives quoting', () => {
  const url = 'http://127.0.0.1:47120/?token=a&b="q" ü';
  const script = U.buildWslLaunchScript({ url, width: 440, height: 720, x: 1456, y: 48 });
  const args = U.psArgs(script);
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  const decoded = Buffer.from(args[5], 'base64').toString('utf16le');
  assert.equal(decoded, script);
  assert.match(decoded, /Start-Process -FilePath \$exe -ArgumentList \$line -PassThru/);
  assert.match(decoded, /Join-Path \$env:LOCALAPPDATA 'claude-anywhere\\ui-profile'/);
  assert.match(decoded, /'--window-size=440,720', '--window-position=1456,48'/);
  assert.match(decoded, /Microsoft\\Edge\\Application\\msedge\.exe/);
  assert.match(decoded, /ANYWHERE_PID/);
  const b64 = /FromBase64String\('([^']+)'\)/.exec(decoded)[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), url);
  // No raw URL text inside the script: nothing for PowerShell to misparse.
  assert.ok(!decoded.includes('token=a&b'));
  const kill = U.buildWinKillScript({ profileDirExpr: U.psString('C:\\Users\\me\\.claude-anywhere\\ui-profile') });
  assert.match(kill, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(kill, /'--user-data-dir=' \+ \$dir/);
});

const PWSH = ['/usr/local/bin/pwsh', '/usr/bin/pwsh'].find((p) => fs.existsSync(p));

test('WSL launch script runs under PowerShell with a fake browser', { skip: !PWSH && 'pwsh is not installed' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-ps-'));
  try {
    const appDir = path.join(root, 'Program Files', 'Microsoft', 'Edge', 'Application');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'msedge.exe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...process.env, ProgramFiles: path.join(root, 'Program Files'), LOCALAPPDATA: path.join(root, 'Local') };
    const script = U.buildWslLaunchScript({ url: URL_, width: 440, height: 720, x: 1, y: 2 });
    const out = execFileSync(PWSH, U.psArgs(script), { env, encoding: 'utf8', timeout: 60000 });
    assert.match(out, /ANYWHERE_PID \d+ .*msedge\.exe/);
    assert.ok(fs.existsSync(path.join(root, 'Local', 'claude-anywhere', 'ui-profile')));

    const none = spawnSync(PWSH, U.psArgs(script), { env: { ...env, ProgramFiles: path.join(root, 'nothing') }, encoding: 'utf8', timeout: 60000 });
    assert.equal(none.status, 3);
    assert.match(none.stdout, /ANYWHERE_NOTFOUND/);

    const kill = spawnSync(PWSH, U.psArgs(U.buildWinKillScript({ profileDirExpr: U.psString('C:\\x') })), { env, encoding: 'utf8', timeout: 60000 });
    assert.match(kill.stdout, /ANYWHERE_KILLED 0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveElectron: env, then npm package, then PATH', () => {
  const base = { stateDir: TMP_HOME, packageRoot: '/pkg' };
  assert.deepEqual(
    U.resolveElectron({ ...base, env: { ANYWHERE_ELECTRON: '/opt/e/electron' }, exists: fakeExists(['/opt/e/electron']), which: fakeWhich({ electron: '/usr/bin/electron' }) }),
    { path: '/opt/e/electron', source: 'env' }
  );
  let resolvedWith = null;
  const viaModule = U.resolveElectron({
    ...base,
    env: { ANYWHERE_ELECTRON: '/missing' },
    exists: fakeExists(['/pkg/node_modules/electron/dist/electron']),
    which: fakeWhich({ electron: '/usr/bin/electron' }),
    resolveModule: (id, opts) => {
      resolvedWith = { id, opts };
      return '/pkg/node_modules/electron/index.js';
    },
    loadModule: () => '/pkg/node_modules/electron/dist/electron',
  });
  assert.deepEqual(viaModule, { path: '/pkg/node_modules/electron/dist/electron', source: 'module' });
  assert.deepEqual(resolvedWith, { id: 'electron', opts: { paths: ['/pkg', path.join(TMP_HOME, 'electron')] } });
  const viaPath = U.resolveElectron({
    ...base,
    env: {},
    exists: fakeExists([]),
    which: fakeWhich({ electron: '/usr/bin/electron' }),
    resolveModule: () => '/x/index.js',
    loadModule: () => {
      throw new Error('Electron failed to install correctly');
    },
  });
  assert.deepEqual(viaPath, { path: '/usr/bin/electron', source: 'path' });
  assert.equal(U.resolveElectron({ ...base, env: {}, exists: fakeExists([]), which: fakeWhich({}), resolveModule: () => { throw new Error('nope'); } }), null);
});

test('pickWindow: owned pid, exact title, prefix, substring; ignores others', () => {
  const wins = [
    { id: 1, title: 'claude-anywhere - Visual Studio Code', pid: 10 },
    { id: 2, title: 'Claude Anywhere - Google Chrome', pid: 11 },
    { id: 3, title: 'Claude Anywhere', pid: 12, minimized: true },
    { id: 4, title: 'Claude Anywhere', pid: 13 },
    { id: 5, title: 'Claude Anywhere', pid: 99 },
  ];
  assert.equal(U.pickWindow(wins).id, 4);
  assert.equal(U.pickWindow(wins, { pids: [99] }).id, 5);
  assert.equal(U.pickWindow([{ id: 7, title: '127.0.0.1:47120/?token=x', pid: 42 }], { pids: [42] }).id, 7);
  assert.equal(U.pickWindow([{ id: 8, title: 'My Claude Anywhere notes - Notepad' }]).id, 8);
  assert.equal(U.pickWindow([{ id: 9, title: 'Terminal' }]), null);
  assert.equal(U.pickWindow(null), null);
});

test('findProfilePids: only processes with our exact profile directory', () => {
  const ps = [
    '  101 /opt/google/chrome/chrome --user-data-dir=/home/me/.config/google-chrome',
    '  102 /opt/google/chrome/chrome --app=http://127.0.0.1:47120/?token=x --user-data-dir=/home/me/.claude-anywhere/ui-profile --window-size=440,720',
    '  103 /opt/google/chrome/chrome --type=renderer --user-data-dir=/home/me/.claude-anywhere/ui-profile',
    '  104 /opt/google/chrome/chrome --user-data-dir=/home/me/.claude-anywhere/ui-profile2 --app=x',
    '  105 /usr/bin/firefox',
    'garbage',
  ].join('\n');
  assert.deepEqual(U.findProfilePids(ps, ['/home/me/.claude-anywhere/ui-profile']), [102, 103]);
  assert.deepEqual(U.findProfilePids(ps, ['/home/me/.claude-anywhere/ui-profile'], [102]), [103]);
  assert.deepEqual(U.findProfilePids(ps, []), []);
});

// ---------------------------------------------------------------- UiHost behaviour

test('open: electron that exits early falls back to an app window', async () => {
  const spawn = fakeSpawn((cmd) => (cmd === '/opt/electron' ? { exitAfter: 10, code: 1 } : {}));
  const host = makeHost({
    env: { DISPLAY: ':0', ANYWHERE_ELECTRON: '/opt/electron', ANYWHERE_BROWSER: '/opt/chrome', ELECTRON_RUN_AS_NODE: '1' },
    exists: fakeExists(['/opt/electron', '/opt/chrome']),
    spawn,
  });
  const res = await host.open(URL_);
  assert.equal(res.host, 'app');
  assert.match(res.detail, /app window/);
  assert.deepEqual(spawn.calls.map((c) => c.cmd), ['/opt/electron', '/opt/chrome']);
  const electronCall = spawn.calls[0];
  assert.equal(electronCall.args[0], U.ELECTRON_MAIN);
  assert.equal(electronCall.opts.detached, false);
  assert.equal(electronCall.opts.env.ELECTRON_RUN_AS_NODE, undefined, 'ELECTRON_RUN_AS_NODE is stripped');
  const chromeCall = spawn.calls[1];
  assert.ok(chromeCall.args.includes(`--app=${URL_}`));
  assert.ok(chromeCall.args.includes(`--user-data-dir=${PROFILE}`));
  assert.ok(chromeCall.args.includes('--window-position=976,48'));
  assert.equal(chromeCall.opts.detached, true, 'own process group on POSIX');
  assert.deepEqual(host.status(), { host: 'app', open: true });
  await host.close();
});

test('open: electron spawn failure (ENOENT) also falls back', async () => {
  const enoent = Object.assign(new Error('spawn /opt/electron ENOENT'), { code: 'ENOENT' });
  const spawn = fakeSpawn((cmd) => (cmd === '/opt/electron' ? { error: enoent } : {}));
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_ELECTRON: '/opt/electron', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/electron', '/opt/chrome']), spawn });
  assert.equal((await host.open(URL_)).host, 'app');
  await host.close();
});

test('open: explicit electron that fails goes to the browser, not the app window', async () => {
  const spawn = fakeSpawn((cmd) => (cmd === '/opt/electron' ? { exitAfter: 5, code: 1 } : {}));
  const host = makeHost({
    ui: { host: 'electron' },
    env: { DISPLAY: ':0', ANYWHERE_ELECTRON: '/opt/electron', ANYWHERE_BROWSER: '/opt/chrome' },
    exists: fakeExists(['/opt/electron', '/opt/chrome']),
    which: fakeWhich({ 'xdg-open': '/usr/bin/xdg-open' }),
    spawn,
  });
  const res = await host.open(URL_);
  assert.equal(res.host, 'browser');
  assert.deepEqual(spawn.calls.map((c) => c.cmd), ['/opt/electron', '/usr/bin/xdg-open']);
  assert.deepEqual(spawn.calls[1].args, [URL_]);
  await host.close();
  assert.deepEqual(spawn.calls[1].child.killed, [], 'the opener (and the user browser) is never killed');
});

test('open: a hand-off to a running electron (exit 0) counts as success', async () => {
  const spawn = fakeSpawn(() => ({ exitAfter: 5, code: 0 }));
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_ELECTRON: '/opt/electron' }, exists: fakeExists(['/opt/electron']), spawn });
  const res = await host.open(URL_);
  assert.equal(res.host, 'electron');
  assert.deepEqual(host.status(), { host: 'electron', open: true });
});

test('open: none without a display, with the URL and the TUI hint', async () => {
  const spawn = fakeSpawn(() => ({}));
  const host = makeHost({ env: {}, which: fakeWhich({ 'xdg-open': '/usr/bin/xdg-open' }), spawn });
  const res = await host.open(URL_);
  assert.deepEqual(res, { host: 'none', detail: `Open ${URL_} in a browser or run: anywhere tui` });
  assert.equal(spawn.calls.length, 0);
  assert.deepEqual(host.status(), { host: 'none', open: false });
  const tuiHost = makeHost({ ui: { host: 'tui' } });
  const r2 = await tuiHost.open(URL_);
  assert.equal(r2.host, 'none');
  assert.match(r2.detail, /anywhere tui/);
});

test('open: running as root on Linux adds --no-sandbox', async () => {
  const spawn = fakeSpawn(() => ({}));
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn });
  host._getuid = () => 0;
  await host.open(URL_);
  assert.ok(spawn.calls[0].args.includes('--no-sandbox'));
  await host.close();
});

test('close: kills only our processes (owned child group + our profile), never the user browser', async () => {
  const spawn = fakeSpawn(() => ({}));
  const killed = [];
  const children = () => spawn.calls.map((c) => c.child);
  const kill = (pid, sig) => {
    if (sig === 0) {
      const err = new Error('ESRCH');
      err.code = 'ESRCH';
      throw err;
    }
    killed.push([pid, sig]);
    const owner = children().find((c) => c.pid === Math.abs(pid));
    if (owner) setImmediate(() => owner.exit(null, sig));
  };
  const psOut = [
    '  501 /opt/google/chrome/chrome --user-data-dir=/home/me/.config/google-chrome',
    `  502 /opt/chrome --app=${URL_} --user-data-dir=${PROFILE} --window-size=440,720`,
    `  503 /opt/chrome --user-data-dir=${PROFILE}-old`,
  ].join('\n');
  const runCalls = [];
  const run = async (cmd, args) => {
    runCalls.push([cmd, args]);
    if (cmd === 'ps') return { code: 0, stdout: psOut, stderr: '', error: null };
    return { code: 1, stdout: '', stderr: '', error: null };
  };
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn, kill, run });
  await host.open(URL_);
  const ours = spawn.calls[0].child;
  await host.close();
  assert.deepEqual(killed[0], [-ours.pid, 'SIGTERM'], 'the owned app child is stopped as a process group');
  assert.ok(killed.some(([pid, sig]) => pid === 502 && sig === 'SIGTERM'));
  assert.ok(!killed.some(([pid]) => pid === 501 || pid === 503), 'the user browser and look-alike profiles survive');
  assert.deepEqual(runCalls.find(([cmd]) => cmd === 'ps')[1], ['-A', '-ww', '-o', 'pid=,args=']);
  assert.deepEqual(host.status(), { host: 'none', open: false });
});

test('close: SIGKILL when an owned electron child ignores SIGTERM', async () => {
  const spawn = fakeSpawn(() => ({}));
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_ELECTRON: '/opt/electron' }, exists: fakeExists(['/opt/electron']), spawn });
  await host.open(URL_);
  const child = spawn.calls[0].child;
  child.kill = (sig) => {
    child.killed.push(sig);
    if (sig === 'SIGKILL') setImmediate(() => child.exit(null, 'SIGKILL'));
    return true;
  };
  await host.close();
  assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL']);
});

test('close: Windows uses taskkill for the owned tree and a profile-scoped PowerShell sweep', async () => {
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const spawn = fakeSpawn(() => ({}));
  const runCalls = [];
  const run = async (cmd, args) => {
    runCalls.push([cmd, args]);
    return { code: 0, stdout: 'ANYWHERE_KILLED 1\r\n', stderr: '', error: null };
  };
  const host = makeHost({
    platformInfo: { platform: 'win32', isWSL: false, displayServer: 'windows' },
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
    exists: fakeExists([chrome, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']),
    spawn,
    run,
  });
  const res = await host.open(URL_);
  assert.equal(res.host, 'app');
  assert.equal(spawn.calls[0].cmd, chrome);
  assert.equal(spawn.calls[0].opts.detached, false);
  assert.equal(spawn.calls[0].opts.windowsHide, false, 'GUI windows must not start hidden');
  await host.close();
  const pid = spawn.calls[0].child.pid;
  assert.deepEqual(runCalls[0], ['taskkill', ['/PID', String(pid), '/T', '/F']]);
  assert.equal(runCalls[1][0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const script = Buffer.from(runCalls[1][1][5], 'base64').toString('utf16le');
  assert.match(script, /Win32_Process/);
  const b64 = /FromBase64String\('([^']+)'\)/.exec(script)[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), PROFILE);
});

test('WSL: opens the Windows browser through powershell.exe, sets topmost, and closes by profile', async () => {
  const runCalls = [];
  const run = async (cmd, args, opts) => {
    runCalls.push({ cmd, args, opts });
    const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
    if (script.includes('Start-Process')) {
      return { code: 0, stdout: 'ANYWHERE_PID 4242 C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe\r\n', stderr: '', error: null };
    }
    return { code: 0, stdout: 'ANYWHERE_KILLED 2\r\n', stderr: '', error: null };
  };
  const topmost = [];
  const driver = {
    displays: async () => [{ x: 0, y: 0, width: 2880, height: 1800, scale: 1, dpiScale: 1.5, primary: true }],
    listWindows: async () => [{ id: 77, title: 'Claude Anywhere', pid: 4242 }],
    setTopmost: async (id, on) => {
      topmost.push([id, on]);
      return true;
    },
  };
  const host = makeHost({
    ui: { alwaysOnTop: true },
    platformInfo: { platform: 'linux', isWSL: true, displayServer: 'windows' },
    env: {},
    which: fakeWhich({ 'powershell.exe': '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' }),
    exists: fakeExists(['/mnt/c']),
    run,
    driver,
  });
  const res = await host.open(URL_);
  assert.deepEqual(res, { host: 'app', detail: 'msedge.exe app window (Windows, via WSL)' });
  const launch = runCalls[0];
  assert.equal(launch.opts.cwd, '/mnt/c');
  const script = Buffer.from(launch.args[5], 'base64').toString('utf16le');
  assert.match(script, /--window-position=1456,48/, 'DIP position from the 1.5x display');
  await host._topmost.promise;
  assert.deepEqual(topmost, [[77, true]]);
  await host.close();
  const killScript = Buffer.from(runCalls[1].args[5], 'base64').toString('utf16le');
  assert.match(killScript, /Join-Path \$env:LOCALAPPDATA 'claude-anywhere\\ui-profile'/);
});

test('WSL: no Windows browser and no WSLg display falls back to the default browser', async () => {
  const run = async () => ({ code: 3, stdout: 'ANYWHERE_NOTFOUND\r\n', stderr: '', error: null });
  const spawn = fakeSpawn(() => ({ exitAfter: 5, code: 0 }));
  const host = makeHost({
    platformInfo: { platform: 'linux', isWSL: true, displayServer: 'windows' },
    env: {},
    which: fakeWhich({ 'powershell.exe': '/mnt/c/ps.exe', wslview: '/usr/bin/wslview' }),
    exists: fakeExists(['/mnt/c']),
    run,
    spawn,
  });
  const res = await host.open(URL_);
  assert.equal(res.host, 'browser');
  assert.equal(spawn.calls[0].cmd, '/usr/bin/wslview');
});

test('macOS: app bundles launch through `open -n -a` so the browser owns the mic prompt', async () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const spawn = fakeSpawn(() => ({ exitAfter: 5, code: 0 }));
  const host = makeHost({
    platformInfo: { platform: 'darwin', isWSL: false, displayServer: 'quartz' },
    env: {},
    which: fakeWhich({ open: '/usr/bin/open' }),
    exists: fakeExists([chrome]),
    spawn,
  });
  const res = await host.open(URL_);
  assert.equal(res.host, 'app');
  assert.equal(spawn.calls[0].cmd, '/usr/bin/open');
  assert.deepEqual(spawn.calls[0].args.slice(0, 4), ['-n', '-a', '/Applications/Google Chrome.app', '--args']);
  assert.ok(spawn.calls[0].args.includes(`--app=${URL_}`));
  assert.deepEqual(host.status(), { host: 'app', open: true });
});

test('topmost: polls the driver until the app window appears; ignores unsupported drivers', async () => {
  let polls = 0;
  const topmost = [];
  const spawn = fakeSpawn(() => ({}));
  const driver = {
    displays: async () => {
      throw Object.assign(new Error('no'), { code: 'UNSUPPORTED' });
    },
    listWindows: async () => {
      polls += 1;
      return polls < 2 ? [] : [{ id: '0x3a00004', title: 'Claude Anywhere', pid: spawn.calls[0].child.pid }];
    },
    setTopmost: async (id, on) => {
      topmost.push([id, on]);
      return false;
    },
  };
  const host = makeHost({ ui: { alwaysOnTop: true }, env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn, driver });
  await host.open(URL_);
  assert.ok(spawn.calls[0].args.includes('--window-position=976,48'), 'falls back to 1440x900');
  assert.equal(await host._topmost.promise, false);
  assert.deepEqual(topmost, [['0x3a00004', true]]);
  assert.ok(polls >= 2);
  await host.close();

  const unsupported = {
    listWindows: async () => {
      throw Object.assign(new Error('Wayland'), { code: 'UNSUPPORTED' });
    },
    setTopmost: async () => true,
  };
  const h2 = makeHost({ ui: { alwaysOnTop: true }, env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn: fakeSpawn(() => ({})), driver: unsupported });
  await h2.open(URL_);
  assert.equal(await h2._topmost.promise, false);
  await h2.close();
});

test('show: focuses the existing window through the driver', async () => {
  const focused = [];
  const spawn = fakeSpawn(() => ({}));
  const driver = {
    listWindows: async () => [
      { id: 'a', title: 'Inbox - Mail', pid: 1 },
      { id: 'b', title: 'Claude Anywhere', pid: 2 },
    ],
    focusWindow: async (id) => {
      focused.push(id);
      return true;
    },
  };
  const host = makeHost({ ui: { host: 'browser' }, which: fakeWhich({ 'xdg-open': '/usr/bin/xdg-open' }), spawn, driver });
  await host.open(URL_);
  assert.equal(spawn.calls.length, 1);
  const res = await host.show();
  assert.deepEqual(res, { host: 'browser' });
  assert.deepEqual(focused, ['b']);
  assert.equal(spawn.calls.length, 1, 'nothing new was launched');
});

test('show: a live electron without a findable window gets a second instance (hand-off)', async () => {
  let n = 0;
  const spawn = fakeSpawn(() => {
    n += 1;
    return n === 1 ? {} : { exitAfter: 5, code: 0 };
  });
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_ELECTRON: '/opt/electron' }, exists: fakeExists(['/opt/electron']), spawn });
  assert.equal((await host.open(URL_)).host, 'electron');
  const res = await host.show(URL_);
  assert.deepEqual(res, { host: 'electron' });
  assert.equal(spawn.calls.length, 2);
  assert.equal(spawn.calls[1].args[0], U.ELECTRON_MAIN);
  assert.deepEqual(host.status(), { host: 'electron', open: true }, 'the first instance is still ours');
  await host.close();
  assert.deepEqual(spawn.calls[0].child.killed, ['SIGTERM']);
});

test('show: reopens when the owned window process has exited', async () => {
  const spawn = fakeSpawn(() => ({}));
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn });
  await host.open(URL_);
  spawn.calls[0].child.exit(0, null);
  assert.deepEqual(host.status(), { host: 'app', open: false });
  const res = await host.show(URL_);
  assert.equal(res.host, 'app');
  assert.equal(spawn.calls.length, 2);
  assert.deepEqual(host.status(), { host: 'app', open: true });
  await host.close();
});

test('open and show are serialized', async () => {
  const spawn = fakeSpawn(() => ({}));
  const host = makeHost({ env: { DISPLAY: ':0', ANYWHERE_BROWSER: '/opt/chrome' }, exists: fakeExists(['/opt/chrome']), spawn });
  const [a, b] = await Promise.all([host.open(URL_), host.show(URL_)]);
  assert.equal(a.host, 'app');
  assert.equal(b.host, 'app');
  await host.close();
});

test('waitForExit and cmdEscape helpers', async () => {
  const c = fakeChild({ exitAfter: 5, code: 7 });
  assert.deepEqual(await U.waitForExit(c, 1000), { exited: true, code: 7, signal: null });
  assert.deepEqual(await U.waitForExit(c, 10), { exited: true, code: 7, signal: null }, 'already exited');
  assert.deepEqual(await U.waitForExit(fakeChild(), 10), { exited: false });
  assert.equal(U.cmdEscape('a&b|c<d>e^f%g'), 'a^&b^|c^<d^>e^^f^%g');
});

test.after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------- electron/main.js against a fake Electron API

const FAKE_ELECTRON_HOOK = String.raw`
'use strict';
const Module = require('module');
const { EventEmitter } = require('events');
const log = [];
const rec = (...a) => log.push(a);
process.type = 'browser';
Object.defineProperty(process.versions, 'electron', { value: '28.0.0', enumerable: true });
const intervals = [];
global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return { unref() {}, ref() {} }; };
global.clearInterval = () => {};
let resolveReady;
let ready = false;
const readyPromise = new Promise((r) => { resolveReady = () => { ready = true; r(); }; });
const app = Object.assign(new EventEmitter(), {
  setName: (n) => rec('setName', n),
  setPath: (k, v) => rec('setPath', k, v),
  setAppUserModelId: () => {},
  disableHardwareAcceleration: () => rec('noGpu'),
  commandLine: { appendSwitch: (...a) => rec('switch', ...a) },
  requestSingleInstanceLock: (d) => { rec('lock', d); return process.env.FAKE_LOCK !== '0'; },
  quit: () => { rec('quit'); app.emit('before-quit'); },
  exit: (c) => rec('exit', c),
  isReady: () => ready,
  whenReady: () => readyPromise,
  focus: () => rec('appFocus'),
});
class WebContents extends EventEmitter {
  constructor() { super(); this.url = ''; }
  getURL() { return this.url; }
  executeJavaScript(code) { rec('exec', code); return Promise.resolve(); }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
}
const windows = [];
class BrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.webContents = new WebContents();
    this.visible = false; this.focused = false;
    windows.push(this);
    app.emit('web-contents-created', {}, this.webContents);
  }
  loadURL(u) { rec('loadURL', u); this.webContents.url = u; setImmediate(() => this.emit('ready-to-show')); return Promise.resolve(); }
  show() { this.visible = true; rec('show'); }
  hide() { this.visible = false; this.focused = false; rec('hide'); }
  focus() { this.focused = true; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  isMinimized() { return false; }
  restore() {}
  isDestroyed() { return false; }
  setAlwaysOnTop(on, level) { rec('setAlwaysOnTop', on, level); }
  setContentProtection(on) { rec('setContentProtection', on); }
}
const handlers = {};
let hotkey = null;
const fake = {
  app,
  BrowserWindow,
  globalShortcut: { register: (acc, fn) => { rec('register', acc); hotkey = fn; return true; }, unregisterAll: () => {} },
  Tray: class { constructor() { rec('tray'); } setToolTip() {} on() {} setContextMenu(m) { rec('menu', m.template.map((i) => i.label || i.type)); } },
  Menu: { buildFromTemplate: (t) => ({ template: t }) },
  nativeImage: { createFromDataURL: (u) => ({ u }) },
  ipcMain: new EventEmitter(),
  shell: { openExternal: (u) => { rec('openExternal', u); return Promise.resolve(); } },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }) },
  session: { defaultSession: { setPermissionRequestHandler: (fn) => { handlers.request = fn; }, setPermissionCheckHandler: (fn) => { handlers.check = fn; } } },
  systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true },
  nativeTheme: { shouldUseDarkColors: false },
  net: {},
};
const origLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return fake;
  return origLoad.call(this, request, ...rest);
};
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
setTimeout(async () => {
  const out = { log };
  if (process.env.FAKE_LOCK === '0') { process.stdout.write(JSON.stringify(out)); process.exit(0); }
  resolveReady();
  await tick(20);
  const win = windows[0];
  const wc = win.webContents;
  const origin = new URL(process.env.FAKE_URL).origin;
  out.windowOpts = { ...win.opts, icon: undefined };
  const ask = (permission, details) => new Promise((r) => handlers.request(wc, permission, r, details));
  out.perm = {
    micOk: await ask('media', { requestingUrl: process.env.FAKE_URL, mediaTypes: ['audio'] }),
    camera: await ask('media', { requestingUrl: process.env.FAKE_URL, mediaTypes: ['video'] }),
    evil: await ask('media', { requestingUrl: 'https://evil.example/', mediaTypes: ['audio'] }),
    geo: await ask('geolocation', { requestingUrl: process.env.FAKE_URL }),
    checkOk: handlers.check(wc, 'media', origin, { mediaType: 'audio' }),
    checkEvil: handlers.check(wc, 'media', 'https://evil.example', { mediaType: 'audio' }),
  };
  const nav = (url) => { let prevented = false; wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url); return prevented; };
  out.nav = { external: nav('https://example.com/docs'), same: nav(origin + '/settings'), file: nav('file:///etc/passwd') };
  out.open = { external: wc.openHandler({ url: 'https://example.com/x' }).action, same: wc.openHandler({ url: origin + '/x' }).action, js: wc.openHandler({ url: 'javascript:alert(1)' }).action };
  let closePrevented = false;
  win.emit('close', { preventDefault: () => { closePrevented = true; } });
  out.closePrevented = closePrevented;
  out.visibleAfterClose = win.visible;
  hotkey();
  out.visibleAfterHotkey = win.visible;
  hotkey();
  out.visibleAfterHotkey2 = win.visible;
  hotkey();
  fake.ipcMain.emit('anywhere:hide', { senderFrame: { url: 'https://evil.example/' } });
  out.visibleAfterEvilHide = win.visible;
  fake.ipcMain.emit('anywhere:hide', { senderFrame: { url: process.env.FAKE_URL } });
  out.visibleAfterHide = win.visible;
  fake.ipcMain.emit('anywhere:always-on-top', { senderFrame: { url: process.env.FAKE_URL } }, false);
  app.emit('second-instance', {}, ['electron', 'main.js'], '/', { url: 'http://127.0.0.1:50000/?token=new' });
  await tick();
  out.intervals = intervals.map((i) => i.ms);
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const health = intervals.find((i) => i.ms === 5000);
  for (let i = 0; i < 3; i += 1) { health.fn(); await tick(); }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}, 10);
`;

test('electron main.js runs against a fake Electron API', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-fake-electron-'));
  try {
    const hook = path.join(dir, 'hook.js');
    fs.writeFileSync(hook, FAKE_ELECTRON_HOOK);
    const main = path.join(__dirname, '..', 'src', 'electron', 'main.js');
    const args = ['-r', hook, main, '--url', URL_, '--always-on-top', 'true', '--hotkey', 'Alt+Space', '--hide-from-screenshots', 'true', '--width', '440', '--height', '720'];
    const env = { ...process.env, ANYWHERE_HOME: dir, FAKE_URL: URL_ };
    const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const log = out.log;
    const has = (name, ...vals) => log.some((e) => e[0] === name && vals.every((v, i) => JSON.stringify(e[i + 1]) === JSON.stringify(v)));
    assert.ok(has('setPath', 'userData', path.join(dir, 'electron-data')), 'private userData dir');
    assert.ok(has('lock', { url: URL_ }));
    assert.equal(out.windowOpts.title, 'Claude Anywhere');
    assert.deepEqual([out.windowOpts.x, out.windowOpts.y, out.windowOpts.width, out.windowOpts.height], [984, 41, 440, 720]);
    assert.equal(out.windowOpts.show, false);
    assert.equal(out.windowOpts.alwaysOnTop, true);
    assert.equal(out.windowOpts.autoHideMenuBar, true);
    assert.equal(out.windowOpts.webPreferences.contextIsolation, true);
    assert.equal(out.windowOpts.webPreferences.sandbox, true);
    assert.equal(out.windowOpts.webPreferences.nodeIntegration, false);
    assert.equal(out.windowOpts.webPreferences.spellcheck, true);
    assert.equal(out.windowOpts.webPreferences.preload, path.join(__dirname, '..', 'src', 'electron', 'preload.js'));
    assert.ok(has('setAlwaysOnTop', true, 'floating'));
    assert.ok(has('setContentProtection', true));
    assert.ok(has('loadURL', URL_));
    assert.ok(has('register', 'Alt+Space'));
    assert.ok(has('menu', ['Show Claude Anywhere', 'Always on top', 'separator', 'Quit']));
    assert.deepEqual(out.perm, { micOk: true, camera: false, evil: false, geo: false, checkOk: true, checkEvil: false });
    assert.deepEqual(out.nav, { external: true, same: false, file: true });
    assert.ok(has('openExternal', 'https://example.com/docs'));
    assert.deepEqual(out.open, { external: 'deny', same: 'allow', js: 'deny' });
    assert.equal(out.closePrevented, true, 'closing hides instead');
    assert.equal(out.visibleAfterClose, false);
    assert.equal(out.visibleAfterHotkey, true, 'hotkey shows the hidden window');
    assert.ok(has('exec', 'window.anywhereFocusInput && window.anywhereFocusInput()'));
    assert.equal(out.visibleAfterHotkey2, false, 'hotkey hides the focused window');
    assert.equal(out.visibleAfterEvilHide, true, 'IPC from another origin is ignored');
    assert.equal(out.visibleAfterHide, false);
    assert.ok(has('setAlwaysOnTop', false, 'floating'));
    assert.ok(has('loadURL', 'http://127.0.0.1:50000/?token=new'), 'second instance with a new daemon URL reloads');
    assert.ok(out.intervals.includes(5000), 'health polling every 5 s');
    assert.ok(has('quit'), 'three failed health checks quit the app');

    const second = spawnSync(process.execPath, args, { env: { ...env, FAKE_LOCK: '0' }, encoding: 'utf8', timeout: 20000 });
    assert.equal(second.status, 0, second.stderr);
    const secondLog = JSON.parse(second.stdout).log;
    assert.ok(secondLog.some((e) => e[0] === 'quit'), 'a second instance quits after handing over');
    assert.ok(!secondLog.some((e) => e[0] === 'loadURL'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
