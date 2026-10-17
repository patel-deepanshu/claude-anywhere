'use strict';

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
const HOST_SCRIPT = win32.HOST_SCRIPT;

const tmpRoots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-win32-'));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeEnv(extra = {}) {
  return { ...process.env, ANYWHERE_PS_EXE: process.execPath, ANYWHERE_PS_ARGS: JSON.stringify([FAKE]), ...extra };
}

function fakeDriver(extra = {}, opts = {}) {
  return win32.createDriver({ wsl: false, env: fakeEnv(extra), ...opts });
}

function readLog(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function requestsSeen(driver, cmd) {
  const r = await driver.host.request('__requests');
  return r.requests.filter((q) => !cmd || q.cmd === cmd);
}

// ---------------------------------------------------------------- pure helpers

test('winToWslPath maps drive paths', () => {
  assert.equal(win32.winToWslPath('C:\\Users\\me\\AppData\\Local\\Temp'), '/mnt/c/Users/me/AppData/Local/Temp');
  assert.equal(win32.winToWslPath('D:\\'), '/mnt/d');
  assert.equal(win32.winToWslPath('e:/a/b/'), '/mnt/e/a/b');
  assert.equal(win32.winToWslPath('\\\\server\\share'), null);
  assert.equal(win32.winToWslPath(''), null);
});

test('splitText never separates a surrogate pair', () => {
  const text = `${'a'.repeat(999)}😀${'b'.repeat(998)}🎉🎉${'c'.repeat(10)}`;
  const parts = win32.splitText(text, 1000);
  assert.equal(parts.join(''), text);
  for (const p of parts) {
    assert.ok(p.length <= 1000);
    const last = p.charCodeAt(p.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'chunk ends with a high surrogate');
  }
  assert.equal(parts[0].length, 999);
  assert.deepEqual(win32.splitText(''), []);
  assert.deepEqual(win32.splitText('xy', 1), ['x', 'y']);
});

test('normalizeWindowId accepts decimal, numbers and hex', () => {
  assert.equal(win32.normalizeWindowId('132456'), '132456');
  assert.equal(win32.normalizeWindowId(42), '42');
  assert.equal(win32.normalizeWindowId('0x1A'), '26');
  assert.equal(win32.normalizeWindowId(' 77 '), '77');
  assert.equal(win32.normalizeWindowId(1.5), null);
  assert.equal(win32.normalizeWindowId('abc'), null);
  assert.equal(win32.normalizeWindowId(null), null);
});

test('modifierVks maps modifier names and aliases to virtual keys', () => {
  assert.deepEqual(win32.modifierVks(['ctrl', 'shift']), [0x11, 0x10]);
  assert.deepEqual(win32.modifierVks('Ctrl+Alt'), [0x11, 0x12]);
  assert.deepEqual(win32.modifierVks(['win']), [0x5b]);
  assert.deepEqual(win32.modifierVks(['primary']), [0x11]);
  assert.deepEqual(win32.modifierVks([]), []);
  assert.deepEqual(win32.modifierVks(undefined), []);
  assert.throws(() => win32.modifierVks(['a']), (e) => e.code === 'BAD_ARGS');
});

test('locatePowerShell picks the right executable per platform', () => {
  const none = () => null;
  assert.equal(
    win32.locatePowerShell({ platform: 'win32', env: {}, whichFn: (n) => (n === 'powershell' ? 'C:\\PS\\powershell.exe' : null), exists: () => false }),
    'C:\\PS\\powershell.exe',
  );
  assert.equal(
    win32.locatePowerShell({ platform: 'win32', env: { SystemRoot: 'D:\\Win' }, whichFn: none, exists: (p) => p === 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }),
    'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(
    win32.locatePowerShell({ platform: 'linux', wsl: true, env: {}, whichFn: none, exists: (p) => p.startsWith('/mnt/c/Windows/System32/WindowsPowerShell') }),
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  assert.equal(win32.locatePowerShell({ platform: 'linux', wsl: true, env: {}, whichFn: none, exists: () => false }), null);
});

test('resolveHostCommand builds Windows PowerShell arguments', async () => {
  const cmd = await win32.resolveHostCommand({
    platform: 'win32',
    env: {},
    whichFn: (n) => (n === 'powershell' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : null),
    exists: () => false,
  });
  assert.equal(cmd.windowsExe, true);
  assert.deepEqual(cmd.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', HOST_SCRIPT]);
  assert.equal(cmd.cwd, undefined);

  const linux = await win32.resolveHostCommand({ platform: 'linux', env: { ANYWHERE_PS_EXE: '/usr/bin/pwsh' }, exists: () => false });
  assert.ok(!linux.args.includes('-STA'), 'pwsh on Linux rejects -STA');
  assert.equal(linux.args[linux.args.length - 1], HOST_SCRIPT);

  const override = await win32.resolveHostCommand({ platform: 'linux', env: { ANYWHERE_PS_EXE: 'node', ANYWHERE_PS_ARGS: '["--x","{script}"]' } });
  assert.deepEqual(override.args, ['--x', HOST_SCRIPT]);

  await assert.rejects(
    win32.resolveHostCommand({ platform: 'linux', env: { ANYWHERE_PS_EXE: 'node', ANYWHERE_PS_ARGS: 'not json' } }),
    (e) => e.code === 'BAD_CONFIG',
  );
  await assert.rejects(
    win32.resolveHostCommand({ platform: 'linux', wsl: true, env: {}, whichFn: () => null, exists: () => false }),
    (e) => e.code === 'UNSUPPORTED' && /interop/i.test(e.hint),
  );
});

test('WSL: the host script is staged into the Windows %TEMP% folder', async () => {
  const dir = tmpDir();
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === '/fake/cmd.exe') return { code: 0, stdout: 'C:\\Users\\me\\AppData\\Local\\Temp\r\n', stderr: '' };
    if (cmd === '/fake/wslpath') return { code: 0, stdout: `${dir}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const whichFn = (n) => ({ 'powershell.exe': '/mnt/c/fake/powershell.exe', 'cmd.exe': '/fake/cmd.exe', wslpath: '/fake/wslpath' })[n] || null;
  const opts = { platform: 'linux', wsl: true, env: {}, runner, whichFn, exists: () => false };
  const cmd = await win32.resolveHostCommand(opts);
  assert.equal(cmd.exe, '/mnt/c/fake/powershell.exe');
  assert.ok(cmd.args.includes('-STA'));
  const winPath = cmd.args[cmd.args.length - 1];
  assert.match(winPath, /^C:\\Users\\me\\AppData\\Local\\Temp\\claude-anywhere-host-[\w.-]+\.ps1$/);
  assert.deepEqual(calls[0], ['/fake/cmd.exe', '/d', '/c', 'echo', '%TEMP%']);
  const staged = path.join(dir, winPath.split('\\').pop());
  assert.ok(fs.readFileSync(staged).equals(fs.readFileSync(HOST_SCRIPT)));

  // A stale copy is replaced; an identical copy is reused.
  fs.writeFileSync(staged, 'old');
  const again = await win32.resolveHostCommand(opts);
  assert.equal(again.args[again.args.length - 1], winPath);
  assert.ok(fs.readFileSync(staged).equals(fs.readFileSync(HOST_SCRIPT)));
  assert.equal(fs.readdirSync(dir).length, 1, 'no temp files left behind');
});

test('WSL: falls back to C:\\Windows\\Temp with an exclusive file', async () => {
  const dir = tmpDir();
  const runner = async (cmd, args) => {
    if (cmd === '/fake/wslpath' && args[1] === 'C:\\Windows\\Temp') return { code: 0, stdout: `${dir}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: 'nope' };
  };
  const whichFn = (n) => (n === 'wslpath' ? '/fake/wslpath' : null);
  const r = await win32.stageWslScript({ runner, whichFn, exists: () => false, version: '9.9.9' });
  assert.match(r.windowsPath, /^C:\\Windows\\Temp\\claude-anywhere-host-9\.9\.9-[0-9a-f]{12}\.ps1$/);
  assert.ok(fs.readFileSync(r.linuxPath).equals(fs.readFileSync(HOST_SCRIPT)));

  await assert.rejects(
    win32.stageWslScript({ runner: async () => ({ code: 1, stdout: '', stderr: '' }), whichFn: () => null, exists: () => false, version: '1' }),
    (e) => e.code === 'UNSUPPORTED' && /C:\\Windows\\Temp/.test(e.message),
  );
});

// ---------------------------------------------------------------- driver over the fake host

test('driver: capabilities, displays and host info', async () => {
  const driver = await fakeDriver();
  try {
    assert.equal(driver.name, 'win32');
    const caps = await driver.capabilities();
    for (const k of ['screenshot', 'mouse', 'keyboard', 'windows', 'clipboard', 'notify', 'speak']) assert.equal(caps[k], true, k);
    assert.ok(caps.notes.some((n) => /PowerShell 5\.1/.test(n)));
    assert.ok(caps.notes.some((n) => /UIPI/.test(n)));
    const info = await driver.hostInfo();
    assert.equal(info.pong, true);
    assert.equal(typeof info.pid, 'number');

    const displays = await driver.displays();
    assert.equal(displays.length, 2);
    assert.deepEqual(displays[0], { index: 0, id: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 64, height: 40, scale: 1, dpiScale: 1.5, primary: true });
    assert.equal(displays[1].primary, false);
    assert.equal(displays[1].x, 64);
  } finally {
    await driver.close();
  }
});

test('driver: captureDisplay decodes base64 PNGs', async () => {
  const driver = await fakeDriver();
  try {
    const a = await driver.captureDisplay(0);
    assert.ok(Buffer.isBuffer(a.png));
    assert.deepEqual([...a.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(a.width, 64);
    assert.equal(a.height, 40);
    const b = await driver.captureDisplay(1);
    assert.equal(b.width, 32);
    assert.equal(b.height, 24);
    assert.ok(!a.png.equals(b.png));
    await assert.rejects(driver.captureDisplay(5), (e) => e.code === 'BAD_DISPLAY' && /displays/.test(e.hint));
    await assert.rejects(driver.captureDisplay(-1), (e) => e.code === 'BAD_ARGS');
  } finally {
    await driver.close();
  }
});

test('driver: mouse and keyboard commands send the right arguments', async () => {
  const driver = await fakeDriver();
  try {
    await driver.moveMouse(10.6, 20.2);
    assert.deepEqual(await driver.cursorPosition(), { x: 11, y: 20 });
    await driver.click(30, 15, { button: 'right', clicks: 2, modifiers: ['ctrl', 'shift'] });
    await driver.click(5, 6);
    await driver.mouseDown('middle');
    await driver.mouseUp('middle');
    await driver.drag(1, 2, 50, 30, { button: 'left' });
    await driver.scroll(40, 20, 0, 3);
    await driver.scroll(null, null, -2, 0);
    await driver.keyCombo(['ctrl', 'shift', 't']);
    await driver.keyCombo(['enter']);
    await assert.rejects(driver.click(1, 1, { button: 'sideways' }), (e) => e.code === 'BAD_ARGS');
    await assert.rejects(driver.moveMouse('x', 1), (e) => e.code === 'BAD_ARGS');

    const clicks = await requestsSeen(driver, 'click');
    assert.equal(clicks.length, 2, 'invalid clicks are rejected before reaching the host');
    assert.deepEqual(clicks[0].args, { button: 'right', clicks: 2, modifiers: [0x11, 0x10], x: 30, y: 15 });
    assert.deepEqual(clicks[1].args, { button: 'left', clicks: 1, modifiers: [], x: 5, y: 6 });
    assert.deepEqual((await requestsSeen(driver, 'down'))[0].args, { button: 'middle' });
    assert.deepEqual((await requestsSeen(driver, 'drag'))[0].args, { x1: 1, y1: 2, x2: 50, y2: 30, button: 'left' });
    const scrolls = await requestsSeen(driver, 'scroll');
    assert.deepEqual(scrolls[0].args, { dx: 0, dy: 3, x: 40, y: 20 });
    assert.deepEqual(scrolls[1].args, { dx: -2, dy: 0 });
    const keys = await requestsSeen(driver, 'keys');
    assert.deepEqual(keys[0].args, { vks: [0x11, 0x10, 0x54] });
    assert.deepEqual(keys[1].args, { vks: [0x0d] });
  } finally {
    await driver.close();
  }
});

test('driver: typeText chunks long unicode text without splitting characters', async () => {
  const driver = await fakeDriver();
  try {
    const text = `${'x'.repeat(999)}😀 héllo 日本\n${'y'.repeat(1200)}🎉`;
    await driver.typeText(text);
    await driver.typeText('');
    const types = await requestsSeen(driver, 'type');
    assert.equal(types.length, 3);
    assert.equal(types.map((t) => t.args.text).join(''), text);
    for (const t of types) {
      const last = t.args.text.charCodeAt(t.args.text.length - 1);
      assert.ok(!(last >= 0xd800 && last <= 0xdbff));
    }
  } finally {
    await driver.close();
  }
});

test('driver: windows, focus, minimize, topmost', async () => {
  const driver = await fakeDriver();
  try {
    const wins = await driver.listWindows();
    assert.equal(wins.length, 3);
    assert.deepEqual(Object.keys(wins[0]).slice(0, 10), ['id', 'app', 'title', 'pid', 'x', 'y', 'width', 'height', 'focused', 'minimized']);
    assert.equal(wins[0].id, '1001');
    assert.equal(wins[0].app, 'Visual Studio Code');
    assert.equal(wins[0].focused, true);
    assert.equal(wins[2].elevated, true);
    assert.deepEqual(await driver.activeWindow(), { id: '1001', app: 'Visual Studio Code', title: 'claude-anywhere - Visual Studio Code', pid: 4101 });

    assert.equal(await driver.focusWindow('1002'), true);
    assert.equal((await driver.activeWindow()).id, '1002');
    assert.equal(await driver.focusWindow(1001), true);
    assert.equal(await driver.focusWindow('999'), false);
    assert.equal(await driver.focusWindow('not-an-id'), false);
    assert.equal(await driver.minimizeWindow('1001'), true);
    assert.equal(await driver.activeWindow(), null);
    assert.equal((await driver.listWindows())[0].minimized, true);
    assert.equal(await driver.setTopmost('1002', true), true);
    assert.equal(await driver.setTopmost('nope', true), false);
    const focusReqs = await requestsSeen(driver, 'focus');
    assert.equal(focusReqs.length, 3, 'invalid ids never reach the host');
    assert.deepEqual((await requestsSeen(driver, 'topmost'))[0].args, { hwnd: '1002', on: true });
  } finally {
    await driver.close();
  }
});

test('driver: clipboard round-trips unicode and uses CRLF', async () => {
  const driver = await fakeDriver();
  try {
    await driver.clipboardSet('héllo\n日本 🎉\r\nend');
    assert.equal(await driver.clipboardGet(), 'héllo\r\n日本 🎉\r\nend');
    await driver.clipboardSet('');
    assert.equal(await driver.clipboardGet(), '');
    await driver.notify('Deploy', 'Cloud Run service is live');
    assert.deepEqual((await requestsSeen(driver, 'notify'))[0].args, { title: 'Deploy', body: 'Cloud Run service is live' });
  } finally {
    await driver.close();
  }
});

test('driver: host errors keep their code and hint', async () => {
  const driver = await fakeDriver();
  try {
    assert.equal(await driver.focusWindow('1003'), true);
    await assert.rejects(driver.typeText('hi'), (e) => e.code === 'UIPI_BLOCKED' && /administrator/.test(e.message) && Boolean(e.hint));
    await assert.rejects(driver.host.request('no_such_command'), (e) => e.code === 'UNKNOWN_COMMAND');
    // The host is still usable afterwards.
    assert.deepEqual(await driver.cursorPosition(), { x: 10, y: 10 });
  } finally {
    await driver.close();
  }
});

// ---------------------------------------------------------------- transport

test('transport: concurrent requests are matched to their responses despite noise', async () => {
  const driver = await fakeDriver({ FAKE_PS_NOISE: '1' });
  try {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => driver.host.request('echo', { n: i, s: `é${i}🎉` })));
    results.forEach((r, i) => assert.deepEqual(r.args, { n: i, s: `é${i}🎉` }));
    const [cursor, displays, shot] = await Promise.all([driver.cursorPosition(), driver.displays(), driver.captureDisplay(1)]);
    assert.deepEqual(cursor, { x: 10, y: 10 });
    assert.equal(displays.length, 2);
    assert.equal(shot.width, 32);
    assert.match(driver.host.stderrTail(), /not a protocol line/);
  } finally {
    await driver.close();
  }
});

test('transport: a hung command times out and the host is restarted', async () => {
  const log = path.join(tmpDir(), 'requests.jsonl');
  const driver = await fakeDriver({ FAKE_PS_HANG: 'cursor', FAKE_PS_LOG: log }, { timeoutMs: 400 });
  try {
    const firstPid = driver.host.pid;
    const t0 = Date.now();
    const queued = driver.displays();
    await assert.rejects(driver.cursorPosition(), (e) => e.code === 'TIMEOUT' && /cursor/.test(e.message) && Boolean(e.hint));
    assert.ok(Date.now() - t0 < 4000);
    const displays = await queued;
    assert.equal(displays.length, 2, 'requests queued before the restart still complete');
    assert.equal((await driver.displays()).length, 2);
    assert.notEqual(driver.host.pid, firstPid);
    const pids = new Set(readLog(log).map((r) => r.pid));
    assert.equal(pids.size, 2);
  } finally {
    await driver.close();
  }
});

test('transport: restarts after a crash and reports the crash', async () => {
  const driver = await fakeDriver();
  try {
    const firstPid = driver.host.pid;
    await assert.rejects(driver.host.request('__crash'), (e) => e.code === 'HOST_EXITED' && /crashing on __crash/.test(e.message) && Boolean(e.hint));
    assert.deepEqual(await driver.cursorPosition(), { x: 10, y: 10 });
    assert.notEqual(driver.host.pid, firstPid);
  } finally {
    await driver.close();
  }
});

test('transport: read-only commands are retried once after a crash; input commands are not', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'requests.jsonl');
  const env = { FAKE_PS_CRASH_ON: 'displays,click', FAKE_PS_CRASH_ONCE: '1', FAKE_PS_STATE: path.join(dir, 'state.json'), FAKE_PS_LOG: log };
  const driver = await fakeDriver(env);
  try {
    const displays = await driver.displays();
    assert.equal(displays.length, 2);
    const seen = readLog(log).filter((r) => r.cmd === 'displays');
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0].pid, seen[1].pid);
  } finally {
    await driver.close();
  }

  const log2 = path.join(dir, 'requests2.jsonl');
  const driver2 = await fakeDriver({ ...env, FAKE_PS_STATE: path.join(dir, 'state2.json'), FAKE_PS_LOG: log2 });
  try {
    await assert.rejects(driver2.click(1, 2), (e) => e.code === 'HOST_EXITED');
    assert.equal(readLog(log2).filter((r) => r.cmd === 'click').length, 1, 'a click is never resent');
    await driver2.click(1, 2);
  } finally {
    await driver2.close();
  }
});

test('transport: restarts are rate limited, then allowed again', async () => {
  const driver = await fakeDriver({ FAKE_PS_CRASH_ON: 'cursor' }, { maxRestarts: 1, restartWindowMs: 1500 });
  try {
    // Launch 1 happened in createDriver; the crash triggers launch 2 for the retry, which also crashes.
    await assert.rejects(driver.cursorPosition(), (e) => e.code === 'HOST_EXITED');
    await assert.rejects(driver.cursorPosition(), (e) => e.code === 'HOST_CRASH_LOOP' && /crashing on cursor/.test(e.hint));
    await assert.rejects(driver.displays(), (e) => e.code === 'HOST_CRASH_LOOP');
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal((await driver.displays()).length, 2);
  } finally {
    await driver.close();
  }
});

test('startup: execution policy and language mode failures get specific hints', async () => {
  await assert.rejects(
    fakeDriver({ FAKE_PS_EXIT_ON_START: '1', FAKE_PS_STDERR: 'File C:\\x.ps1 cannot be loaded because running scripts is disabled on this system.' }),
    (e) => e.code === 'EXECUTION_POLICY' && /administrator/.test(e.hint) && /running scripts is disabled/.test(e.message),
  );
  await assert.rejects(
    fakeDriver({ FAKE_PS_EXIT_ON_START: '3', FAKE_PS_STDERR: 'ANYWHERE_HOST_ERROR: PowerShell runs in ConstrainedLanguage mode' }),
    (e) => e.code === 'POWERSHELL_RESTRICTED' && /FullLanguage/.test(e.hint),
  );
  // PowerShell 7 colours Write-Error output and may exit 1; the text alone identifies the cause.
  await assert.rejects(
    fakeDriver({ FAKE_PS_EXIT_ON_START: '1', FAKE_PS_STDERR: '\x1b[31;1mWrite-Error: ANYWHERE_HOST_ERROR: PowerShell runs in ConstrainedLanguage mode.\x1b[0m' }),
    (e) => e.code === 'POWERSHELL_RESTRICTED' && !e.message.includes('\x1b') && /ConstrainedLanguage/.test(e.message),
  );
});

test('startup: slow hosts time out and missing executables are UNSUPPORTED', async () => {
  const t0 = Date.now();
  await assert.rejects(fakeDriver({ FAKE_PS_START_DELAY_MS: '10000' }, { startTimeoutMs: 400 }), (e) => e.code === 'TIMEOUT' && /did not start/.test(e.message));
  assert.ok(Date.now() - t0 < 4000);
  await assert.rejects(
    win32.createDriver({ env: { ...process.env, ANYWHERE_PS_EXE: '/nonexistent/powershell.exe', ANYWHERE_PS_ARGS: '[]' } }),
    (e) => e.code === 'UNSUPPORTED' && /not found/.test(e.message),
  );
});

test('lifecycle: lazy start, close, and requests after close', async () => {
  const log = path.join(tmpDir(), 'requests.jsonl');
  const driver = await fakeDriver({ FAKE_PS_LOG: log }, { lazy: true });
  assert.equal(driver.host.pid, null);
  assert.deepEqual(readLog(log), []);
  assert.deepEqual(await driver.cursorPosition(), { x: 10, y: 10 });
  assert.deepEqual(readLog(log).map((r) => r.cmd), ['ping', 'cursor']);
  await driver.close();
  await driver.close();
  await assert.rejects(driver.cursorPosition(), (e) => e.code === 'CLOSED');
  const never = await fakeDriver({}, { lazy: true });
  await never.close();
});

test('lifecycle: an idle host does not keep Node running', () => {
  const script = `
    const win32 = require(${JSON.stringify(require.resolve('../src/os/win32'))});
    win32.createDriver({ env: { ...process.env, ANYWHERE_PS_EXE: process.execPath, ANYWHERE_PS_ARGS: ${JSON.stringify(JSON.stringify([FAKE]))} } })
      .then((d) => d.cursorPosition())
      .then((p) => process.stderr.write('cursor ' + p.x + '\\n'));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 15000, encoding: 'utf8' });
  assert.equal(r.error, undefined, 'process should exit on its own');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /cursor 10/);
});

// ---------------------------------------------------------------- the real PowerShell host script

test('win32-host.ps1 is pure ASCII (Windows PowerShell 5.1 reads BOM-less scripts as ANSI)', () => {
  const buf = fs.readFileSync(HOST_SCRIPT);
  const bad = buf.findIndex((b) => b > 0x7f);
  assert.equal(bad, -1, `non-ASCII byte at offset ${bad}`);
});

function pwsh(args, opts = {}) {
  return spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8', timeout: 60000, ...opts });
}

test('pwsh: win32-host.ps1 parses without errors', { skip: !HAS_PWSH && 'pwsh not installed' }, () => {
  const r = pwsh(
    ['-Command', '$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:HOST_PS1,[ref]$t,[ref]$e);' +
      '$e | ForEach-Object { "{0}: {1}" -f $_.Extent.StartLineNumber, $_.Message }; "errors=" + $e.Count'],
    { env: { ...process.env, HOST_PS1: HOST_SCRIPT } },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /errors=0\s*$/, r.stdout);
});

test('pwsh: the C# bridge compiles as C# 5 (the Windows PowerShell 5.1 compiler)', { skip: !HAS_PWSH && 'pwsh not installed' }, () => {
  const r = pwsh(
    ['-Command', '$ErrorActionPreference="Stop";$t=$null;$e=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:HOST_PS1,[ref]$t,[ref]$e);' +
      '$a=$ast.Find({param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq "`$NativeSource"},$true);' +
      'Add-Type -TypeDefinition $a.Right.Expression.Value -CompilerOptions "-langversion:5"; "size=" + [AnywhereNative]::InputStructSize()'],
    { env: { ...process.env, HOST_PS1: HOST_SCRIPT } },
  );
  assert.equal(r.status, 0, r.stderr);
  const size = Number(/size=(\d+)/.exec(r.stdout)[1]);
  assert.equal(size, process.arch === 'ia32' ? 28 : 40, 'sizeof(INPUT)');
});

test('pwsh: compile self-test exits 0', { skip: !HAS_PWSH && 'pwsh not installed' }, () => {
  const r = pwsh(['-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT], { env: { ...process.env, ANYWHERE_HOST_SELFTEST: 'compile' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /selftest ok/);
});

test('pwsh: the real host answers ping, echoes unicode and survives errors', { skip: !HAS_PWSH && 'pwsh not installed' }, async () => {
  const env = { ...process.env, ANYWHERE_PS_EXE: PWSH };
  delete env.ANYWHERE_PS_ARGS;
  const driver = await win32.createDriver({ env, startTimeoutMs: 60000, timeoutMs: 20000 });
  try {
    const info = await driver.hostInfo();
    assert.equal(info.pong, true);
    assert.equal(info.protocol, 1);
    assert.equal(info.native, true, info.nativeError || '');
    assert.equal(typeof info.pid, 'number');
    const pid = info.pid;

    const text = 'héllo 日本 🎉 "quotes" \\ <&> \t tab';
    const echo = await driver.host.request('echo', { text, list: [1], nested: { ok: true } });
    assert.deepEqual(echo.args, { text, list: [1], nested: { ok: true } });

    if (!info.windows) {
      await assert.rejects(driver.cursorPosition(), (e) => e.code === 'UNSUPPORTED' && Boolean(e.hint));
      await assert.rejects(driver.host.request('bogus'), (e) => e.code === 'UNKNOWN_COMMAND');
      const caps = await driver.capabilities();
      assert.equal(caps.screenshot, false);
      assert.ok(caps.notes.some((n) => /not running on Windows/.test(n)));
    }
    assert.equal((await driver.hostInfo()).pid, pid, 'the host survived the failed commands');
  } finally {
    await driver.close();
  }
});
