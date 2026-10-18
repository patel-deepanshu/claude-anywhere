'use strict';

// Round-2 regressions for src/os/{index,common}.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-oscore2-'));
process.env.ANYWHERE_HOME = HOME;
test.after(() => fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const osIndex = require('../src/os/index');
const common = require('../src/os/common');

const FAKE_PS = path.join(__dirname, 'fixtures', 'fake-ps-host.js');
const WIN32_FILE = require.resolve('../src/os/win32');

/** Set env vars for one test; restored (and the driver reset) afterwards. */
function withEnv(t, vars) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  t.after(async () => {
    await osIndex.resetDriver();
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

/** Move Date.now forward by `ms` for the rest of the test. */
function skipAhead(t, ms) {
  const real = Date.now;
  Date.now = () => real() + ms;
  t.after(() => {
    Date.now = real;
  });
}

/** Replace the win32 backend module with `exports` for one test. */
function fakeWin32Module(t, exports) {
  const prev = require.cache[WIN32_FILE];
  const m = new Module(WIN32_FILE, module);
  m.filename = WIN32_FILE;
  m.loaded = true;
  m.exports = exports;
  require.cache[WIN32_FILE] = m;
  t.after(() => {
    if (prev) require.cache[WIN32_FILE] = prev;
    else delete require.cache[WIN32_FILE];
  });
}

function codeError(message, code, hint) {
  return Object.assign(new Error(message), { code, hint });
}

// ------------------------------------------------------------ WINDOWS-2-4: transient driver start failures

test('getDriver: a transient start failure rejects, is reused briefly, then retried', async (t) => {
  withEnv(t, { ANYWHERE_DRIVER: 'win32' });
  const outcomes = [
    codeError('The Windows PowerShell host did not start within 30 s', 'TIMEOUT', 'PowerShell may be slow to start.'),
    { name: 'win32', close: async () => {} },
  ];
  let calls = 0;
  fakeWin32Module(t, {
    createDriver: async () => {
      const o = outcomes[calls++];
      if (o instanceof Error) throw o;
      return o;
    },
  });
  await osIndex.resetDriver();
  await assert.rejects(
    osIndex.getDriver(),
    (e) => e.code === 'TIMEOUT' && e.transient === true && /win32 desktop driver did not start/.test(e.message) && /slow to start/.test(e.hint),
  );
  // Within the retry pause the same failure is returned without starting another host.
  await assert.rejects(osIndex.getDriver(), (e) => e.code === 'TIMEOUT');
  assert.equal(calls, 1);
  skipAhead(t, osIndex.LOAD_RETRY_MS + 1);
  const d = await osIndex.getDriver();
  assert.equal(d.name, 'win32');
  assert.equal(calls, 2);
  assert.equal(await osIndex.getDriver(), d, 'a working driver stays cached');
  assert.equal(calls, 2);
});

test('getDriver: HOST_EXITED and HOST_CRASH_LOOP are transient; other failures stay an unsupported driver', async (t) => {
  withEnv(t, { ANYWHERE_DRIVER: 'win32' });
  let err = null;
  let calls = 0;
  fakeWin32Module(t, {
    createDriver: async () => {
      calls++;
      throw err;
    },
  });
  for (const code of ['HOST_EXITED', 'HOST_CRASH_LOOP']) {
    err = codeError(`host failed (${code})`, code);
    await osIndex.resetDriver();
    await assert.rejects(osIndex.getDriver(), (e) => e.code === code && e.transient === true && /anywhere doctor/.test(e.hint), code);
  }
  err = codeError('A Group Policy execution policy prevents scripts', 'EXECUTION_POLICY', 'Ask your administrator.');
  await osIndex.resetDriver();
  const d = await osIndex.getDriver();
  assert.equal(d.name, 'unsupported');
  assert.match(d.reason, /win32 driver failed to load/);
  const before = calls;
  assert.equal(await osIndex.getDriver(), d, 'a permanent failure is cached');
  assert.equal(calls, before);
});

test('getDriver with the fake PowerShell host: a host that exits at start works on a later call', async (t) => {
  withEnv(t, {
    ANYWHERE_DRIVER: 'win32',
    ANYWHERE_PS_EXE: process.execPath,
    ANYWHERE_PS_ARGS: JSON.stringify([FAKE_PS]),
    FAKE_PS_EXIT_ON_START: '1',
    FAKE_PS_STDERR: 'Add-Type : error CS0016: Could not write to output file (the file is in use)',
  });
  await osIndex.resetDriver();
  await assert.rejects(osIndex.getDriver(), (e) => e.code === 'HOST_EXITED' && e.transient === true);
  delete process.env.FAKE_PS_EXIT_ON_START;
  delete process.env.FAKE_PS_STDERR;
  skipAhead(t, osIndex.LOAD_RETRY_MS + 1);
  const d = await osIndex.getDriver();
  assert.equal(d.name, 'win32');
  assert.deepEqual(await d.cursorPosition(), { x: 10, y: 10 });
});

test('the MCP server computer source recovers once the driver starts', async (t) => {
  withEnv(t, { ANYWHERE_DRIVER: 'win32' });
  const outcomes = [codeError('The Windows PowerShell host did not start within 30 s', 'TIMEOUT'), null];
  let calls = 0;
  fakeWin32Module(t, {
    createDriver: async () => {
      const o = outcomes[calls++];
      if (o) throw o;
      return osIndex.createMockDriver();
    },
  });
  await osIndex.resetDriver();
  const { createComputerSource } = require('../src/mcp/server');
  const source = { config: { computer: {} }, refresh: () => false, version: () => 0 };
  const cs = createComputerSource({ source });
  await assert.rejects(cs.getComputer(), (e) => e.code === 'TIMEOUT');
  skipAhead(t, osIndex.LOAD_RETRY_MS + 1);
  const comp = await cs.getComputer();
  assert.equal(comp.driver.name, 'mock');
  assert.deepEqual(await comp.driver.cursorPosition(), { x: 960, y: 540 });
});

// ------------------------------------------------------------ MACOS-2-4: open -a with arguments

/** Fake macOS runner; `running` maps app name -> true/false for the osascript check. */
function fakeMac(t, opts = {}) {
  const calls = { run: [], launch: [] };
  const existing = new Set(opts.exists || []);
  common._setRunner({
    info: () => ({ platform: 'darwin', isWSL: false }),
    which: (n) => (opts.which || {})[n] || null,
    exists: (p) => existing.has(p),
    env: {},
    homedir: () => '/Users/tester',
    cwd: () => '/work',
    run: async (cmd, args, o) => {
      calls.run.push({ cmd, args, opts: o });
      let r = {};
      if (cmd === 'osascript') {
        const app = args[args.length - 1];
        const state = (opts.running || {})[app];
        r = state === undefined ? { code: 1, stderr: "Error: Application can't be found. (-2700)" } : { stdout: state ? 'running\n' : 'stopped\n' };
      } else if (opts.run) {
        r = opts.run(cmd, args, o) || {};
      }
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...r };
    },
    launch: async (cmd, args, o) => {
      calls.launch.push({ cmd, args, opts: o });
      return opts.launch ? opts.launch(cmd, args, o) : { ok: true, pid: 99, code: 0, running: false };
    },
  });
  t.after(() => common._setRunner(null));
  return calls;
}

const openCalls = (calls) => calls.run.filter((c) => c.cmd === 'open').map((c) => c.args);

test('macOS open: a URL for a running browser goes to the user\'s browser, not only --args', async (t) => {
  const calls = fakeMac(t, { running: { 'Google Chrome': true, Safari: true } });
  const url = 'https://console.cloud.google.com';
  // Chromium: a new instance forwards its command line to the instance owning the default profile.
  const r = await common.openTarget('Google Chrome', { kind: 'app', args: [url] });
  assert.deepEqual(r, { opened: true, kind: 'app', how: 'open -n -a', target: 'Google Chrome' });
  // Any other app: URLs are handed over as documents, which a running app receives too.
  await common.openTarget('Safari', { kind: 'app', args: [url, 'localhost:3000'] });
  await common.openTarget('/Applications/Brave Browser.app/', { kind: 'app', args: ['www.example.com'] });
  assert.deepEqual(openCalls(calls), [
    ['-n', '-a', 'Google Chrome', '--args', url],
    ['-a', 'Safari', url, 'http://localhost:3000'],
    ['-n', '-a', '/Applications/Brave Browser.app/', '--args', 'https://www.example.com'],
  ]);
  assert.equal(calls.run.filter((c) => c.cmd === 'osascript').length, 0, 'documents alone need no running check');
  await assert.rejects(common.openTarget('Safari', { kind: 'app', args: ['javascript://x%0Aalert(1)'] }), (e) => e.code === 'BLOCKED');
});

test('macOS open: relative paths in args resolve against cwd', async (t) => {
  const calls = fakeMac(t, { exists: ['/proj/src', '/proj/index.html', '/Users/tester/notes.md'] });
  await common.openTarget('Visual Studio Code', { kind: 'app', args: ['src', '~/notes.md'], cwd: '/proj' });
  await common.openTarget('Google Chrome', { kind: 'app', args: ['./index.html', '--incognito'], cwd: '/proj' });
  assert.deepEqual(openCalls(calls), [
    ['-a', 'Visual Studio Code', '/proj/src', '/Users/tester/notes.md'],
    ['-n', '-a', 'Google Chrome', '--args', '/proj/index.html', '--incognito'],
  ]);
});

test('macOS open: flags reach an app that open starts, and are reported when it was already running', async (t) => {
  const calls = fakeMac(t, { exists: ['/repo'], running: { 'Visual Studio Code': false, TextEdit: true } });
  const started = await common.openTarget('Visual Studio Code', { kind: 'app', args: ['--new-window', '/repo'] });
  assert.equal(started.how, 'open -a');
  assert.equal(started.note, undefined);
  const running = await common.openTarget('TextEdit', { kind: 'app', args: ['/repo', '--fresh'] });
  assert.match(running.how, /already running.*not passed: --fresh/);
  assert.match(running.note, /TextEdit was already running/);
  // An app the running check cannot find keeps the old behaviour.
  await common.openTarget('Some App', { kind: 'app', args: ['--flag'] });
  assert.deepEqual(openCalls(calls), [
    ['-a', 'Visual Studio Code', '/repo', '--args', '--new-window'],
    ['-a', 'TextEdit', '/repo'],
    ['-a', 'Some App', '--args', '--flag'],
  ]);
  const check = calls.run.find((c) => c.cmd === 'osascript');
  assert.deepEqual(check.args.slice(0, 2), ['-l', 'JavaScript']);
  assert.equal(check.args[check.args.length - 1], 'Visual Studio Code', 'the app name is an argument, not script text');
});

test('macOS open: a command on PATH (code) is the fallback when no app has that name', async (t) => {
  const notFound = (cmd, args) => (args[0] === '-a' && /^(code|nope)$/.test(args[1]) ? { code: 1, stderr: `Unable to find application named '${args[1]}'` } : {});
  let calls = fakeMac(t, { exists: ['/proj'], which: { code: '/usr/local/bin/code' }, run: notFound });
  const r = await common.openTarget('code', { kind: 'app', args: ['.', '--reuse-window'], cwd: '/proj' });
  assert.deepEqual(r, { opened: true, kind: 'app', how: 'exec', target: 'code' });
  assert.deepEqual(calls.launch, [{ cmd: '/usr/local/bin/code', args: ['.', '--reuse-window'], opts: { waitMs: 700, cwd: '/proj' } }]);
  await assert.rejects(common.openTarget('nope', { kind: 'app' }), (e) => e.code === 'NOT_FOUND' && /on PATH/.test(e.message) && /mdfind/.test(e.hint));
  calls = fakeMac(t, { which: { code: '/usr/local/bin/code' }, run: notFound, launch: () => ({ ok: false, code: 2, running: false }) });
  await assert.rejects(common.openTarget('code', { kind: 'app' }), (e) => e.code === 'OPEN_FAILED' && /exited with code 2/.test(e.message));
  assert.equal(calls.launch[0].opts.cwd, '/work', 'without a cwd the process cwd is used');
});
