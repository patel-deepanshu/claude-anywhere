'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-common-'));
process.env.ANYWHERE_HOME = HOME;
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const common = require('../src/os/common');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function decodePs(args) {
  const i = args.indexOf('-EncodedCommand');
  assert.ok(i >= 0, 'uses -EncodedCommand');
  assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  return Buffer.from(args[i + 1], 'base64').toString('utf16le');
}

function fakeChild(pid = 4242, { fail = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.stdinData = '';
  child.stdin = new EventEmitter();
  child.stdin.end = (data) => {
    if (data != null) child.stdinData += data;
  };
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  };
  setImmediate(() => {
    if (fail) child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    else child.emit('spawn');
  });
  return child;
}

/** Install a fake runner; returns the recorded calls. */
function fake(t, opts = {}) {
  const calls = { run: [], launch: [], spawn: [] };
  const whichMap = opts.which || {};
  common._setRunner({
    info: () => ({ platform: opts.platform || 'linux', isWSL: Boolean(opts.isWSL), displayServer: 'x11' }),
    which: (n) => whichMap[n] || null,
    exists: opts.exists || (() => false),
    env: opts.env || {},
    homedir: () => '/home/tester',
    cwd: () => '/work',
    run: async (cmd, args, o) => {
      calls.run.push({ cmd, args, opts: o });
      const r = opts.run ? opts.run(cmd, args, o) : {};
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...r };
    },
    launch: async (cmd, args, o) => {
      calls.launch.push({ cmd, args, opts: o });
      return opts.launch ? opts.launch(cmd, args, o) : { ok: true, pid: 99, running: true };
    },
    spawn: (cmd, args, o) => {
      if (opts.spawnThrows) throw new Error('spawn EACCES');
      const child = fakeChild(1000 + calls.spawn.length, { fail: opts.spawnError });
      calls.spawn.push({ cmd, args, opts: o, child });
      return child;
    },
  });
  t.after(() => {
    common.stopSpeaking();
    common._setRunner(null);
  });
  return calls;
}

const LINUX_OPEN = { which: { 'xdg-open': '/usr/bin/xdg-open' } };

// ------------------------------------------------------------ openTarget: classification

test('openTarget: URLs open with xdg-open on Linux; dangerous schemes are refused', async (t) => {
  const calls = fake(t, LINUX_OPEN);
  const url = 'https://console.cloud.google.com/run?project=a&x=1';
  assert.deepEqual(await common.openTarget(url), { opened: true, kind: 'url', how: 'xdg-open', target: url });
  assert.deepEqual(calls.launch[0].args, [url]);
  assert.equal(calls.launch[0].cmd, '/usr/bin/xdg-open');
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox']) {
    await assert.rejects(common.openTarget(bad), (e) => e.code === 'BLOCKED', bad);
    await assert.rejects(common.openTarget(bad, { kind: 'url' }), (e) => e.code === 'BLOCKED', bad);
  }
  assert.equal(calls.launch.length, 1);
});

test('openTarget: URL normalization and custom schemes', async (t) => {
  const calls = fake(t, LINUX_OPEN);
  const cases = [
    ['localhost:3000/health', 'http://localhost:3000/health'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['www.example.com/a b', 'https://www.example.com/a%20b'],
    ['mailto:someone@example.com', 'mailto:someone@example.com'],
    ['vscode://file/home/u/repo', 'vscode://file/home/u/repo'],
    ['file:///etc/hosts', 'file:///etc/hosts'],
    ['zoommtg://zoom.us/join?confno=1', 'zoommtg://zoom.us/join?confno=1'],
  ];
  for (const [input, want] of cases) {
    const r = await common.openTarget(input);
    assert.equal(r.kind, 'url', input);
    assert.equal(r.target, want, input);
  }
  assert.equal((await common.openTarget('example.com', { kind: 'url' })).target, 'https://example.com');
  assert.equal(calls.launch.length, cases.length + 1);
  await assert.rejects(common.openTarget('   '), /target is empty/);
  await assert.rejects(common.openTarget('x', { kind: 'thing' }), /kind must be one of/);
  await assert.rejects(common.openTarget('x', { args: 'nope' }), /args must be an array/);
});

test('openTarget: paths must exist; ~ and relative paths are resolved', async (t) => {
  const existing = new Set(['/home/tester/Documents', '/work/README.md']);
  const calls = fake(t, { ...LINUX_OPEN, exists: (p) => existing.has(p) });
  assert.deepEqual(await common.openTarget('~/Documents'), { opened: true, kind: 'path', how: 'xdg-open', target: '/home/tester/Documents' });
  assert.equal((await common.openTarget('README.md')).target, '/work/README.md');
  await assert.rejects(common.openTarget('./missing.txt'), (e) => e.code === 'NOT_FOUND' && /\/work\/missing.txt/.test(e.message));
  await assert.rejects(common.openTarget('notes.txt', { kind: 'path' }), (e) => e.code === 'NOT_FOUND');
  assert.deepEqual(calls.launch.map((c) => c.args[0]), ['/home/tester/Documents', '/work/README.md']);
});

test('openTarget on Linux: gio fallback, missing tools and failures', async (t) => {
  let calls = fake(t, { which: { gio: '/usr/bin/gio' } });
  assert.equal((await common.openTarget('https://a.dev')).how, 'gio');
  assert.deepEqual(calls.launch[0].args, ['open', 'https://a.dev']);
  calls = fake(t, { which: {} });
  await assert.rejects(common.openTarget('https://a.dev'), (e) => e.code === 'UNSUPPORTED' && /xdg-utils/.test(e.hint));
  calls = fake(t, { ...LINUX_OPEN, launch: () => ({ ok: false, code: 3, running: false }) });
  await assert.rejects(common.openTarget('https://a.dev'), (e) => e.code === 'OPEN_FAILED' && /exited with code 3/.test(e.message));
});

// ------------------------------------------------------------ openTarget: macOS

test('openTarget on macOS uses open / open -a', async (t) => {
  const calls = fake(t, {
    platform: 'darwin',
    exists: (p) => p === '/Applications/Visual Studio Code.app',
    run: (cmd, args) => (args.includes('Nope') ? { code: 1, stderr: "Unable to find application named 'Nope'" } : {}),
  });
  assert.deepEqual(await common.openTarget('https://example.com'), { opened: true, kind: 'url', how: 'open', target: 'https://example.com' });
  assert.deepEqual(calls.run[0], { cmd: 'open', args: ['https://example.com'], opts: calls.run[0].opts });
  const r = await common.openTarget('Google Chrome', { args: ['--new-window', 'https://a.b'] });
  assert.deepEqual([r.kind, r.how], ['app', 'open -a']);
  assert.deepEqual(calls.run[1].args, ['-a', 'Google Chrome', '--args', '--new-window', 'https://a.b']);
  await common.openTarget('/Applications/Visual Studio Code.app', { args: ['/repo'] });
  assert.deepEqual(calls.run[2].args, ['-a', '/Applications/Visual Studio Code.app', '--args', '/repo']);
  await assert.rejects(common.openTarget('Nope', { kind: 'app' }), (e) => e.code === 'NOT_FOUND' && /mdfind/.test(e.hint));
});

// ------------------------------------------------------------ openTarget: Windows & WSL

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('openTarget on Windows: apps via an encoded PowerShell script, never raw user text', async (t) => {
  const calls = fake(t, {
    platform: 'win32',
    which: { 'powershell.exe': PS },
    run: (cmd, args) => {
      const script = decodePs(args);
      if (script.includes(b64('Nope'))) return { code: 3, stdout: '{"error":"not_found"}\r\n' };
      if (script.includes('App Paths')) return { stdout: 'noise\r\n{"how":"start-menu","target":"C:\\\\ProgramData\\\\Code.lnk"}\r\n' };
      return { stdout: '{"ok":true}\r\n' };
    },
  });
  const r = await common.openTarget("Visual Studio Code's", { args: ['C:\\My Repo\\', 'x"y'] });
  assert.deepEqual([r.kind, r.how], ['app', 'Start-Process (start-menu)']);
  const { cmd, args } = calls.run[0];
  assert.equal(cmd, PS);
  const script = decodePs(args);
  assert.ok(script.includes(`FromBase64String('${b64("Visual Studio Code's")}')`));
  assert.ok(!script.includes("Visual Studio Code's"), 'user text is not interpolated');
  assert.ok(script.includes(b64('"C:\\My Repo\\\\" "x\\"y"')), 'arguments quoted for CommandLineToArgvW');
  assert.match(script, /Get-StartApps/);
  await assert.rejects(common.openTarget('Nope'), (e) => e.code === 'NOT_FOUND' && /Start menu/.test(e.hint));

  const url = "https://example.com/?q=it's&x=\"1\"";
  assert.equal((await common.openTarget(url)).how, 'Start-Process');
  const s2 = decodePs(calls.run[2].args);
  assert.ok(s2.includes(b64(url)) && !s2.includes(url));
});

test('openTarget on Windows: drive paths are paths, not URL schemes', async (t) => {
  const calls = fake(t, { platform: 'win32', which: { 'powershell.exe': PS }, exists: () => true, run: () => ({ stdout: '{"ok":true}' }) });
  const r = await common.openTarget('C:\\Users\\me\\report.pdf');
  assert.equal(r.kind, 'path');
  assert.ok(decodePs(calls.run[0].args).includes('$target ='));
});

test('openTarget on Windows: PowerShell failures and missing PowerShell', async (t) => {
  fake(t, { platform: 'win32', which: { 'powershell.exe': PS }, run: () => ({ code: 1, stdout: '{"error":"The system cannot find the file specified"}' }) });
  await assert.rejects(common.openTarget('https://x.y'), (e) => e.code === 'OPEN_FAILED' && /cannot find the file/.test(e.message));
  fake(t, { platform: 'win32', which: {} });
  await assert.rejects(common.openTarget('https://x.y'), (e) => e.code === 'UNSUPPORTED' && /PATH/.test(e.hint));
});

test('openTarget on WSL: Linux paths go through wslpath; Linux apps are the fallback', async (t) => {
  const calls = fake(t, {
    isWSL: true,
    which: { 'powershell.exe': '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe', gedit: '/usr/bin/gedit' },
    env: { DISPLAY: ':0' },
    exists: (p) => p === '/mnt/c' || p === '/home/tester/repo',
    run: (cmd, args) => {
      if (cmd === 'wslpath') return { stdout: '\\\\wsl.localhost\\Ubuntu\\home\\tester\\repo\n' };
      const script = decodePs(args);
      if (script.includes(b64('gedit'))) return { code: 3, stdout: '{"error":"not_found"}' };
      return { stdout: '{"ok":true}' };
    },
  });
  const r = await common.openTarget('~/repo');
  assert.equal(r.kind, 'path');
  assert.deepEqual(calls.run[0].args, ['-w', '/home/tester/repo']);
  assert.ok(decodePs(calls.run[1].args).includes(b64('\\\\wsl.localhost\\Ubuntu\\home\\tester\\repo')));
  assert.equal(calls.run[1].opts.cwd, '/mnt/c');
  const g = await common.openTarget('gedit');
  assert.equal(g.how, 'exec (WSLg)');
  assert.equal(calls.launch[0].cmd, '/usr/bin/gedit');
});

// ------------------------------------------------------------ openTarget: Linux apps and .desktop files

function writeDesktop(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function desktopFixture() {
  const root = fs.mkdtempSync(path.join(HOME, 'xdg-'));
  const user = path.join(root, 'home', 'applications');
  const sys = path.join(root, 'sys', 'applications');
  writeDesktop(sys, 'code.desktop', [
    '[Desktop Entry]', 'Name=Visual Studio Code', 'Exec=/usr/share/code/code --unity-launch %F', 'Type=Application',
    '', '[Desktop Action new-empty-window]', 'Name=New Empty Window', 'Exec=/usr/share/code/code --new-window %F',
  ].join('\n'));
  writeDesktop(sys, 'org.gnome.Nautilus.desktop', '[Desktop Entry]\nName=Files\nExec=nautilus --new-window %U\nType=Application\n');
  writeDesktop(sys, 'firefox.desktop', '[Desktop Entry]\nName=Firefox Web Browser\nGenericName=Web Browser\nExec=firefox %u\nType=Application\n');
  writeDesktop(sys, 'gone.desktop', '[Desktop Entry]\nName=Gone App\nExec=gone\nTryExec=gone-binary\nType=Application\n');
  writeDesktop(sys, 'hidden.desktop', '[Desktop Entry]\nName=Secret Tool\nExec=secret\nHidden=true\n');
  writeDesktop(sys, 'shadowed.desktop', '[Desktop Entry]\nName=Shadow\nExec=/usr/bin/system-version\n');
  writeDesktop(user, 'shadowed.desktop', '[Desktop Entry]\nName=Shadow\nExec="/opt/my app/run" --flag "quoted arg" %%u\n');
  writeDesktop(path.join(sys, 'kde4'), 'kate.desktop', '[Desktop Entry]\nName=Kate\nName[de]=Kate Editor\nExec=kate -b %U\n');
  return { XDG_DATA_HOME: path.join(root, 'home'), XDG_DATA_DIRS: path.join(root, 'sys'), HOME: path.join(root, 'home') };
}

test('findDesktopEntry: names, ids, shadowing, hidden and TryExec', (t) => {
  const env = desktopFixture();
  fake(t, { env });
  const id = (q) => {
    const e = common.findDesktopEntry(q);
    return e && e.id;
  };
  assert.equal(id('visual studio code'), 'code.desktop');
  assert.equal(id('Files'), 'org.gnome.Nautilus.desktop');
  assert.equal(id('nautilus'), 'org.gnome.Nautilus.desktop');
  assert.equal(id('web browser'), 'firefox.desktop');
  assert.equal(id('firefox'), 'firefox.desktop');
  assert.equal(id('Kate Editor'), 'kde4-kate.desktop');
  assert.equal(id('Gone App'), null, 'TryExec binary missing');
  assert.equal(id('Secret Tool'), null, 'Hidden entries are skipped');
  assert.equal(id('New Empty Window'), null, 'Desktop Action names are ignored');
  assert.match(common.findDesktopEntry('shadow').exec, /my app/, 'user entry shadows the system one');
  assert.equal(id('studio'), 'code.desktop', 'substring match');
});

test('parseExec handles quoting, escapes and field codes', () => {
  assert.deepEqual(common.parseExec('/usr/share/code/code --unity-launch %F', ['/a b']), ['/usr/share/code/code', '--unity-launch', '/a b']);
  assert.deepEqual(common.parseExec('"/opt/my app/run" --flag "quoted \\"arg\\"" %%u'), ['/opt/my app/run', '--flag', 'quoted "arg"', '%u']);
  assert.deepEqual(common.parseExec('env FOO=1 app --name=%c %i -x'), ['env', 'FOO=1', 'app', '--name=', '-x']);
  assert.deepEqual(common.parseExec('flatpak run org.x.App @@u %U @@'), ['flatpak', 'run', 'org.x.App', '@@u', '@@']);
  assert.deepEqual(common.parseExec('a\\sb ""'), ['a', 'b', '']);
});

test('openTarget on Linux: apps via PATH, then .desktop entries', async (t) => {
  const env = desktopFixture();
  let calls = fake(t, { env, which: { firefox: '/usr/bin/firefox', 'google-chrome': '/usr/bin/google-chrome', 'gtk-launch': '/usr/bin/gtk-launch' } });
  assert.deepEqual(await common.openTarget('firefox', { args: ['--new-window'] }), { opened: true, kind: 'app', how: 'exec', target: 'firefox' });
  assert.deepEqual([calls.launch[0].cmd, calls.launch[0].args], ['/usr/bin/firefox', ['--new-window']]);
  await common.openTarget('Google Chrome');
  assert.equal(calls.launch[1].cmd, '/usr/bin/google-chrome');
  assert.equal((await common.openTarget('Visual Studio Code')).how, 'gtk-launch');
  assert.deepEqual([calls.launch[2].cmd, calls.launch[2].args], ['/usr/bin/gtk-launch', ['code.desktop']]);
  // With arguments (or without gtk-launch) the Exec line is used.
  assert.equal((await common.openTarget('Visual Studio Code', { args: ['/srv/repo'] })).how, 'desktop-exec');
  assert.deepEqual([calls.launch[3].cmd, calls.launch[3].args], ['/usr/share/code/code', ['--unity-launch', '/srv/repo']]);
  await assert.rejects(common.openTarget('Totally Unknown App'), (e) => e.code === 'NOT_FOUND' && /executable name/.test(e.hint));
  calls = fake(t, { env, which: { firefox: '/usr/bin/firefox' }, launch: () => ({ ok: false, code: 1, running: false }) });
  await assert.rejects(common.openTarget('firefox'), (e) => e.code === 'OPEN_FAILED' && /exited with code 1/.test(e.message));
});

// ------------------------------------------------------------ notify

test('notify on macOS passes text as argv to an AppleScript run handler', async (t) => {
  const calls = fake(t, { platform: 'darwin' });
  const title = '-e "do shell script \\"rm -rf ~\\""';
  const body = 'Deploy ✓ "done" \\ $(whoami)';
  assert.deepEqual(await common.notify(title, body), { ok: true, how: 'osascript' });
  const { cmd, args } = calls.run[0];
  assert.equal(cmd, 'osascript');
  assert.equal(args.length, 3);
  assert.deepEqual(args.slice(1), [title, body]);
  const script = fs.readFileSync(args[0], 'utf8');
  assert.match(script, /^on run argv/);
  assert.ok(!script.includes('whoami'));
  assert.ok(args[0].startsWith(HOME), 'helper script lives in the state dir');
});

test('notify on Linux: notify-send, kdialog fallback, install hint', async (t) => {
  let calls = fake(t, { which: { 'notify-send': '/usr/bin/notify-send' } });
  await common.notify('', 'Build finished');
  assert.deepEqual(calls.run[0].args, ['--app-name=Claude Anywhere', '--icon=dialog-information', '--', 'Claude Anywhere', 'Build finished']);
  calls = fake(t, { which: { 'notify-send': '/usr/bin/notify-send', kdialog: '/usr/bin/kdialog' }, run: () => ({ code: 1, stderr: 'No notification daemon' }) });
  assert.equal((await common.notify('T', 'B')).how, 'kdialog');
  assert.deepEqual(calls.launch[0].args, ['--title', 'T', '--passivepopup', 'B', '6']);
  fake(t, { which: { 'notify-send': '/usr/bin/notify-send' }, run: () => ({ code: 1, stderr: 'No notification daemon' }) });
  await assert.rejects(common.notify('T', 'B'), (e) => e.code === 'NOTIFY_FAILED' && /No notification daemon/.test(e.message));
  fake(t, { which: {} });
  await assert.rejects(common.notify('T', 'B'), (e) => e.code === 'UNSUPPORTED' && /libnotify/.test(e.hint));
});

test('notify on Windows and WSL: NotifyIcon balloon via -EncodedCommand', async (t) => {
  const calls = fake(t, { isWSL: true, which: { 'powershell.exe': '/mnt/c/ps/powershell.exe' }, exists: (p) => p === '/mnt/c' });
  assert.deepEqual(await common.notify("It's done", ''), { ok: true, how: 'NotifyIcon' });
  const { cmd, args, opts } = calls.launch[0];
  assert.equal(cmd, '/mnt/c/ps/powershell.exe');
  assert.equal(opts.cwd, '/mnt/c');
  const script = decodePs(args);
  assert.match(script, /System\.Windows\.Forms\.NotifyIcon/);
  assert.ok(script.includes(b64("It's done")));
  assert.ok(!script.includes("It's done"));
  // Empty bodies fall back to the title (balloon text must not be empty).
  assert.equal(script.split(b64("It's done")).length - 1, 2);
});

// ------------------------------------------------------------ speak

test('speak on Linux: espeak-ng reads text from stdin; one utterance at a time', async (t) => {
  const calls = fake(t, { which: { 'espeak-ng': '/usr/bin/espeak-ng' } });
  const r = await common.speak('Deployment finished — 3 services', { rate: 2, voice: 'en-us' });
  assert.deepEqual(r, { pid: 1000, engine: 'espeak-ng' });
  assert.equal(JSON.stringify(r), '{"pid":1000,"engine":"espeak-ng"}');
  assert.deepEqual(calls.spawn[0].args, ['-s', '350', '-v', 'en-us', '--stdin']);
  assert.equal(calls.spawn[0].child.stdinData, 'Deployment finished — 3 services');
  assert.equal(common.isSpeaking(), true);
  await common.speak('second');
  assert.equal(calls.spawn[0].child.killed, true, 'previous utterance stopped');
  assert.equal(common.stopSpeaking(), true);
  assert.equal(calls.spawn[1].child.killed, true);
  assert.equal(common.stopSpeaking(), false);
  const third = await common.speak('third');
  calls.spawn[2].child.emit('exit', 0, null);
  assert.deepEqual(await third.done, { code: 0, signal: null, stderr: '' });
  assert.equal(common.isSpeaking(), false);
});

test('speak on Linux prefers spd-say and cancels it explicitly', async (t) => {
  const calls = fake(t, { which: { 'spd-say': '/usr/bin/spd-say', 'espeak-ng': '/usr/bin/espeak-ng' } });
  await common.speak('-v hello', { rate: 0.5 });
  assert.deepEqual(calls.spawn[0].args, ['-w', '-r', '-50', '--', '-v hello']);
  assert.equal(calls.spawn[0].opts.stdio[0], 'ignore');
  common.stopSpeaking();
  assert.deepEqual([calls.spawn[1].cmd, calls.spawn[1].args], ['/usr/bin/spd-say', ['-C']]);
});

test('speak on macOS and Windows', async (t) => {
  let calls = fake(t, { platform: 'darwin', which: { say: '/usr/bin/say' } });
  await common.speak('hello', { voice: 'Samantha' });
  assert.deepEqual([calls.spawn[0].cmd, calls.spawn[0].args], ['/usr/bin/say', ['-v', 'Samantha', '-r', '175', '-f', '-']]);
  assert.equal(calls.spawn[0].child.stdinData, 'hello');
  calls = fake(t, { platform: 'win32', which: { 'powershell.exe': PS } });
  const r = await common.speak('héllo 👋', { rate: 3, voice: "Zira's" });
  assert.equal(r.engine, 'sapi');
  const script = decodePs(calls.spawn[0].args);
  assert.match(script, /System\.Speech/);
  assert.match(script, /\$s\.Rate = 10/);
  assert.ok(script.includes(b64("Zira's")));
  assert.ok(!script.includes('héllo'), 'text goes over stdin');
  assert.equal(calls.spawn[0].child.stdinData, 'héllo 👋');
  assert.equal(calls.spawn[0].opts.windowsHide, true);
});

test('speak errors: no engine, pwsh only, spawn failures; empty text is a no-op', async (t) => {
  fake(t, { which: {} });
  await assert.rejects(common.speak('hi'), (e) => e.code === 'UNSUPPORTED' && /espeak-ng/.test(e.hint));
  fake(t, { platform: 'win32', which: { 'pwsh.exe': 'C:\\pwsh\\pwsh.exe' } });
  await assert.rejects(common.speak('hi'), (e) => e.code === 'UNSUPPORTED' && /Windows PowerShell/.test(e.hint));
  fake(t, { which: { 'espeak-ng': '/usr/bin/espeak-ng' }, spawnError: true });
  await assert.rejects(common.speak('hi'), (e) => e.code === 'SPEAK_FAILED' && /ENOENT/.test(e.message));
  assert.equal(common.isSpeaking(), false);
  fake(t, { which: { 'espeak-ng': '/usr/bin/espeak-ng' }, spawnThrows: true });
  await assert.rejects(common.speak('hi'), (e) => e.code === 'SPEAK_FAILED');
  const calls = fake(t, { which: { 'espeak-ng': '/usr/bin/espeak-ng' } });
  assert.deepEqual(await common.speak('  \u0007 '), { pid: null, engine: null });
  assert.equal(calls.spawn.length, 0);
});

// ------------------------------------------------------------ helpers

test('quoteWinArgv follows CommandLineToArgvW rules', () => {
  assert.equal(common.quoteWinArgv('plain'), 'plain');
  assert.equal(common.quoteWinArgv(''), '""');
  assert.equal(common.quoteWinArgv('a b'), '"a b"');
  assert.equal(common.quoteWinArgv('say "hi"'), '"say \\"hi\\""');
  assert.equal(common.quoteWinArgv('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(common.quoteWinArgv('a\\\\"b'), '"a\\\\\\\\\\"b"');
  assert.equal(common.quoteWinArgv('C:\\no\\space'), 'C:\\no\\space');
});

test('launchDetached reports early exits and keeps long-running children (live)', async () => {
  const bad = await common.launchDetached(process.execPath, ['-e', 'process.exit(3)'], { waitMs: 3000 });
  assert.deepEqual([bad.ok, bad.code, bad.running], [false, 3, false]);
  const good = await common.launchDetached(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { waitMs: 150 });
  assert.equal(good.ok, true);
  assert.equal(good.running, true);
  process.kill(good.pid);
  const missing = await common.launchDetached('/definitely/not/a/program', [], { waitMs: 1000 });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'ENOENT');
});

const PWSH = ['pwsh', '/usr/local/bin/pwsh'].find((p) => spawnSync(p, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0);

test('PowerShell scripts parse cleanly and psString round-trips unicode (live pwsh)', { skip: PWSH ? false : 'pwsh not installed' }, async (t) => {
  const tricky = "it's ‘quoted’ \"double\" $(Get-Date) `tick` ñ 日本 👍\nline2";
  const r = spawnSync(PWSH, common.psArgs(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n[Console]::Out.Write(${common.psString(tricky)})`), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, tricky);

  // Collect every script the module generates and parse each with the real PowerShell parser.
  const scripts = [];
  fake(t, {
    platform: 'win32',
    which: { 'powershell.exe': PS },
    exists: () => true,
    run: (cmd, args) => {
      scripts.push(decodePs(args));
      return { stdout: '{"ok":true,"how":"path"}' };
    },
    launch: (cmd, args) => {
      scripts.push(decodePs(args));
      return { ok: true, running: true };
    },
  });
  await common.openTarget('Calculator', { kind: 'app', args: ['--x'] });
  await common.openTarget('https://example.com');
  await common.openTarget('C:\\file.txt', { kind: 'path' });
  await common.notify('Title', 'Body');
  common._setRunner({
    info: () => ({ platform: 'win32', isWSL: false }),
    which: (n) => (n === 'powershell.exe' ? PS : null),
    spawn: (cmd, args) => {
      scripts.push(decodePs(args));
      return fakeChild();
    },
  });
  await common.speak('hello', { voice: 'Zira' });
  common.stopSpeaking();
  assert.equal(scripts.length, 5);
  const dir = fs.mkdtempSync(path.join(HOME, 'ps-'));
  scripts.forEach((s, i) => fs.writeFileSync(path.join(dir, `s${i}.ps1`), s));
  const check = spawnSync(
    PWSH,
    ['-NoProfile', '-Command', `Get-ChildItem -LiteralPath '${dir}' -Filter *.ps1 | ForEach-Object { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$e); '{0}:{1}' -f $_.Name, $e.Count; $e | ForEach-Object { $_.Message } }`],
    { encoding: 'utf8' }
  );
  assert.equal(check.status, 0, check.stderr);
  const lines = check.stdout.trim().split(/\r?\n/);
  assert.deepEqual(lines.filter((l) => /^s\d\.ps1:/.test(l)).map((l) => l.split(':')[1]), ['0', '0', '0', '0', '0'], check.stdout);
});
