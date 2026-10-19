'use strict';

// Regression tests for the os-linux review findings (LINUX-CONTEXT-1/2/3/6/7/8).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const L = require('../src/os/linux');

function fake({ tools = [], responses = {}, env = { DISPLAY: ':42', LANG: 'C.UTF-8' } } = {}) {
  const calls = [];
  const which = (n) => (tools.includes(n) ? `/usr/bin/${n}` : null);
  const run = async (cmd, args, opts = {}) => {
    const key = `${cmd} ${args.join(' ')}`.trim();
    calls.push({ cmd, args, opts, line: key });
    let r = Object.prototype.hasOwnProperty.call(responses, key) ? responses[key] : responses[cmd];
    if (typeof r === 'function') r = await r(args, opts);
    if (r === undefined) r = { code: 1, stderr: `no fake response for: ${key}` };
    return { code: 0, signal: null, stdout: opts.encoding === 'buffer' ? Buffer.alloc(0) : '', stderr: '', timedOut: false, error: null, ...r };
  };
  return { calls, which, run, env };
}

const wl = (f, extra = {}) => L.createDriver({ displayServer: 'wayland', run: f.run, which: f.which, env: f.env, ...extra });
const x11 = (f, extra = {}) => L.createDriver({ displayServer: 'x11', run: f.run, which: f.which, env: f.env, hostnames: ['vm'], ...extra });

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-linux-fixes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

// `ydotool help` exactly as the Ubuntu 0.1.8-3build1 package prints it (stderr, exit 1).
const YDOTOOL_018_HELP = { code: 1, stderr: 'Usage: ydotool <cmd> <args>\nAvailable commands:\n  type\n  recorder\n  mousemove\n  key\n  click\n' };
// ydotool 1.0.4 (stdout, exit 0); 1.0.0-1.0.3 print the same without the last line.
const YDOTOOL_104_HELP = {
  stdout:
    'Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  mousemove\n  type\n  key\n  debug\n  bakers\n' +
    'Use environment variable YDOTOOL_SOCKET to specify daemon socket.\n',
};

// ---------------------------------------------------------------------------
// LINUX-CONTEXT-1: ydotool 0.1.x is detected instead of being fed 1.x syntax
// ---------------------------------------------------------------------------

test('parseYdotoolHelp tells 0.1.x from 1.x', () => {
  assert.equal(L.parseYdotoolHelp(YDOTOOL_018_HELP.stderr), '0.1');
  assert.equal(L.parseYdotoolHelp(YDOTOOL_104_HELP.stdout), '1');
  assert.equal(L.parseYdotoolHelp('Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  mousemove\n  type\n  key\n  debug\n  bakers\n'), '1');
  assert.equal(L.parseYdotoolHelp(''), null);
  assert.equal(L.parseYdotoolHelp('bash: ydotool: command not found'), null);
});

test('Wayland: ydotool 0.1.8 → UNSUPPORTED with a build-from-source hint, never fed 1.x syntax', async () => {
  const f = fake({
    env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' },
    tools: ['ydotool', 'wl-copy', 'wl-paste', 'apt-get'],
    responses: { 'ydotool help': YDOTOOL_018_HELP, ydotool: {}, 'wl-paste -n': { stdout: 'saved' } },
  });
  let spawned = 0;
  const d = wl(f, { spawn: () => { spawned++; throw new Error('clipboard must not be touched'); } });
  const legacy = (e) => e.code === 'UNSUPPORTED' && /0\.1\.x/.test(e.message) && /github\.com\/ReimuNotMoe\/ydotool/.test(e.hint);
  await assert.rejects(d.moveMouse(500, 300), legacy);
  await assert.rejects(d.click(null, null), legacy);
  await assert.rejects(d.mouseDown(), legacy);
  await assert.rejects(d.scroll(null, null, 0, 2), legacy);
  await assert.rejects(d.keyCombo('ctrl+v'), legacy);
  await assert.rejects(d.typeText('hello'), legacy);
  await assert.rejects(d.typeText('Café'), legacy);
  assert.equal(spawned, 0, 'no clipboard paste is attempted');
  const ydo = f.calls.filter((c) => c.cmd === 'ydotool');
  assert.deepEqual(ydo.map((c) => c.line), ['ydotool help'], 'probed once, nothing else sent to ydotool');

  const caps = await d.capabilities();
  assert.equal(caps.mouse, false);
  assert.equal(caps.keyboard, false);
  assert.ok(caps.notes.some((n) => /0\.1\.x/.test(n) && /ReimuNotMoe/.test(n)), caps.notes.join(' | '));
});

test('Wayland: a legacy probe result is re-checked later, so upgrading ydotool needs no restart', async (t) => {
  const dir = tmpDir(t);
  const sock = path.join(dir, 'ydo.sock');
  fs.writeFileSync(sock, '');
  let help = YDOTOOL_018_HELP;
  const f = fake({
    env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME', YDOTOOL_SOCKET: sock },
    tools: ['ydotool'],
    responses: { 'ydotool help': () => help, ydotool: {} },
  });
  const d = wl(f);
  await assert.rejects(d.keyCombo('ctrl+c'), (e) => e.code === 'UNSUPPORTED');
  help = YDOTOOL_104_HELP;
  await assert.rejects(d.keyCombo('ctrl+c'), (e) => e.code === 'UNSUPPORTED', 'cached within the TTL');
  d._ydoGen.at -= 60000;
  await d.keyCombo('ctrl+c');
  assert.equal(f.calls.at(-1).line, 'ydotool key 29:1 46:1 46:0 29:0');
  assert.equal((await d.capabilities()).keyboard, true);
  // 1.x is final: no further probes.
  await d.keyCombo('ctrl+v');
  assert.equal(f.calls.filter((c) => c.line === 'ydotool help').length, 2);
});

test('Wayland: unrecognised `ydotool help` output keeps the 1.x syntax', async () => {
  const f = fake({ env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' }, tools: ['ydotool'], responses: { 'ydotool help': { code: 1, stderr: '' }, ydotool: {} } });
  const d = wl(f);
  await d.moveMouse(5, 6);
  assert.equal(f.calls.at(-1).line, 'ydotool mousemove --absolute -x 5 -y 6');
});

test('Wayland: on apt systems the ydotool install hint says 1.x must be built from source', async () => {
  const f = fake({ env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' }, tools: ['apt-get'] });
  const d = wl(f);
  await assert.rejects(d.click(1, 1), (e) => e.code === 'UNSUPPORTED' && /sudo apt install ydotool/.test(e.hint) && /ydotool >= 1\.0/.test(e.hint));
  await assert.rejects(d.typeText('x'), (e) => e.code === 'UNSUPPORTED' && /ReimuNotMoe/.test(e.hint));
  const caps = await d.capabilities();
  assert.ok(caps.notes.some((n) => /ydotool >= 1\.0 is required/.test(n)));
  // Other package managers ship 1.x: no source-build note.
  const p = fake({ env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'river' }, tools: ['pacman'] });
  await assert.rejects(wl(p).click(1, 1), (e) => e.code === 'UNSUPPORTED' && /pacman -S ydotool/.test(e.hint) && !/ReimuNotMoe/.test(e.hint));
});

// ---------------------------------------------------------------------------
// LINUX-CONTEXT-2: the socket found is the socket ydotool uses
// ---------------------------------------------------------------------------

test('Wayland: the ydotoold socket that was found is passed to ydotool as YDOTOOL_SOCKET', async (t) => {
  const dir = tmpDir(t);
  const runDir = path.join(dir, 'run');
  fs.mkdirSync(runDir);
  const sock = path.join(runDir, '.ydotool_socket');
  fs.writeFileSync(sock, '');
  const f = fake({
    env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME', XDG_RUNTIME_DIR: runDir, YDOTOOL_SOCKET: path.join(dir, 'missing') },
    tools: ['ydotool'],
    responses: { 'ydotool help': YDOTOOL_104_HELP, ydotool: {} },
  });
  const d = wl(f);
  await d.moveMouse(10, 20);
  await d.click(null, null, { modifiers: ['shift'] });
  await d.keyCombo('ctrl+a');
  await d.typeText('hi');
  const sent = f.calls.filter((c) => c.cmd === 'ydotool' && c.args[0] !== 'help');
  assert.ok(sent.length >= 5);
  for (const c of sent) {
    assert.equal(c.opts.env.YDOTOOL_SOCKET, sock, c.line);
    assert.equal(c.opts.env.XDG_RUNTIME_DIR, runDir, 'rest of the environment kept');
  }
  const caps = await d.capabilities();
  assert.equal(caps.mouse, true);
  assert.equal(caps.keyboard, true);
});

test('Wayland: a socket this user cannot write is not reported as ready', async (t) => {
  const dir = tmpDir(t);
  const sock = path.join(dir, 'root-owned.sock');
  fs.writeFileSync(sock, '');
  const realAccess = fs.accessSync;
  fs.accessSync = (p, mode) => {
    if (p === sock && mode & fs.constants.W_OK) {
      const e = new Error(`EACCES: permission denied, access '${p}'`);
      e.code = 'EACCES';
      throw e;
    }
    return realAccess(p, mode);
  };
  t.after(() => {
    fs.accessSync = realAccess;
  });
  const f = fake({
    env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME', YDOTOOL_SOCKET: sock },
    tools: ['ydotool'],
    responses: {
      'ydotool help': YDOTOOL_104_HELP,
      // ydotool 1.x prints connection errors on stdout.
      ydotool: { code: 2, stdout: `failed to connect socket \`/run/user/1000/.ydotool_socket': Permission denied\nPlease check if the current user has sufficient permissions to access the socket file.\n` },
    },
  });
  const d = wl(f);
  const caps = await d.capabilities();
  assert.equal(caps.mouse, false);
  assert.equal(caps.keyboard, false);
  assert.ok(caps.notes.some((n) => n.includes(`ydotoold socket ${sock} is not writable by this user`)), caps.notes.join(' | '));
  await assert.rejects(d.moveMouse(1, 2), (e) => e.code === 'UNSUPPORTED' && /not writable/.test(e.message) && /ydotoold/.test(e.hint));
  assert.equal(f.calls.at(-1).opts.env.YDOTOOL_SOCKET, sock, 'unwritable socket is not forced on ydotool');
});

test('Wayland: ydotool 1.x connection errors on stdout are explained', async () => {
  const f = fake({
    env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME', XDG_RUNTIME_DIR: '/nonexistent-anywhere-run' },
    tools: ['ydotool'],
    responses: {
      'ydotool help': YDOTOOL_104_HELP,
      ydotool: { code: 2, stdout: "failed to connect socket `/nonexistent-anywhere-run/.ydotool_socket': No such file or directory\nPlease check if ydotoold is running.\n" },
    },
  });
  await assert.rejects(wl(f).keyCombo('ctrl+c'), (e) => e.code === 'UNSUPPORTED' && /cannot reach ydotoold: failed to connect socket/.test(e.message) && /--socket-own/.test(e.hint));
});

test('YDOTOOLD hint no longer recommends a bare `sudo ydotoold &`', async () => {
  const f = fake({ env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME', XDG_RUNTIME_DIR: '/nonexistent-anywhere-run' }, tools: ['ydotool'], responses: { 'ydotool help': YDOTOOL_104_HELP } });
  const caps = await wl(f).capabilities();
  const note = caps.notes.find((n) => /ydotoold/.test(n)) || '';
  assert.ok(!/sudo ydotoold &/.test(note), note);
  assert.match(note, /systemctl --user enable --now ydotool/);
  assert.match(note, /--socket-own=\$\(id -u\):\$\(id -g\)/);
});

// ---------------------------------------------------------------------------
// LINUX-CONTEXT-3: xdotool type runs in a UTF-8 locale
// ---------------------------------------------------------------------------

test('X11: typeText and keyCombo force a UTF-8 locale when the daemon has none', async () => {
  const f = fake({ env: { DISPLAY: ':42' }, tools: ['xdotool'], responses: { xdotool: {} } });
  const d = x11(f);
  await d.typeText('naïve ☕\n-x');
  const type = f.calls.find((c) => c.args[0] === 'type');
  assert.deepEqual(type.args, ['type', '--clearmodifiers', '--delay', '8', '--', 'naïve ☕\n-x']);
  assert.equal(type.opts.env.LC_ALL, 'C.UTF-8');
  assert.equal(type.opts.env.DISPLAY, ':42');
  await d.keyCombo('ctrl+a');
  assert.equal(f.calls.at(-1).opts.env.LC_ALL, 'C.UTF-8');

  const c = fake({ env: { DISPLAY: ':42', LANG: 'C' }, tools: ['xdotool'], responses: { xdotool: {} } });
  await x11(c).typeText('é');
  assert.equal(c.calls.at(-1).opts.env.LC_ALL, 'C.UTF-8', 'LANG=C is not UTF-8');

  const u = fake({ env: { DISPLAY: ':42', LANG: 'de_DE.UTF-8' }, tools: ['xdotool'], responses: { xdotool: {} } });
  await x11(u).typeText('é');
  assert.equal(u.calls.at(-1).opts.env.LC_ALL, undefined, 'a UTF-8 locale is left alone');
  assert.equal(u.calls.at(-1).opts.env.LANG, 'de_DE.UTF-8');
});

// ---------------------------------------------------------------------------
// LINUX-CONTEXT-6: missing tools are looked up again
// ---------------------------------------------------------------------------

test('a tool installed after a miss is found without restarting', { skip: process.platform === 'win32' && 'POSIX PATH lookup' }, async (t) => {
  const dir = tmpDir(t);
  const name = `anywhere-fake-tool-${process.pid}-${Date.now()}`;
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath || ''}`;
  t.after(() => {
    process.env.PATH = savedPath;
  });
  const d = L.createDriver({ displayServer: 'x11', env: { DISPLAY: ':42' }, run: fake().run });
  assert.equal(d._has(name), false);
  assert.throws(() => d._requireTool(name), (e) => e.code === 'UNSUPPORTED');
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  d._whichRetryAt -= 60000;
  assert.equal(d._has(name), true, 're-probed after the retry interval');
  assert.doesNotThrow(() => d._requireTool(name));
});

test('proc.which re-checks a miss after 10 s and keeps hits (LINUX-CONTEXT-6 root cause)', { skip: process.platform === 'win32' && 'POSIX PATH lookup' }, async (t) => {
  const proc = require('../src/shared/proc');
  const dir = tmpDir(t);
  const name = `anywhere-which-tool-${process.pid}-${Date.now()}`;
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath || ''}`;
  t.after(() => {
    process.env.PATH = savedPath;
    proc.clearWhichCache();
  });
  proc.clearWhichCache();
  assert.equal(proc.which(name), null);
  const exe = path.join(dir, name);
  fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(proc.which(name), null, 'a fresh miss is cached briefly');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 11000);
  assert.equal(proc.which(name), exe, 'found once the miss expired');
  fs.rmSync(exe);
  assert.equal(proc.which(name), exe, 'hits stay cached');
});

// ---------------------------------------------------------------------------
// LINUX-CONTEXT-7: X11 window origins without the frame offset
// ---------------------------------------------------------------------------

// Real `xwininfo -root -tree` output (Xvfb + openbox) trimmed; the xterm's frame is 1/1/20/5.
const XWININFO_TREE = `
xwininfo: Window id: 0x21f (the root window) (has no name)

  Root window id: 0x21f (the root window) (has no name)
  Parent window id: 0x0 (none)
     4 children:
     0x20011f "Openbox": ("" (none))  1x1+-100+-100  +-100+-100
     0x200173 (has no name): ()  1x1+0+0  +0+0
        1 child:
        0x200174 (has no name): ()  1x1+0+0  +1+1
     0x400001 (has no name): ()  246x159+300+200  +300+200
        1 child:
        0x40000c "root@vm: /tmp  1x1+2+3  +4+5": ("xterm" "XTerm")  244x134+1+20  +301+220
     0x600001 (has no name): ()  1x1+0+0  +0+0
        1 child:
        0x60000c "Second — ü": ("gedit" "Gedit")  640x480+4+24  +-60+44
`;

test('parseXwininfoTree maps client ids to absolute origins', () => {
  const m = L.parseXwininfoTree(XWININFO_TREE);
  // The xterm sits in openbox's frame (title bar and borders): that is its frame.
  assert.deepEqual(m.get('0x0040000c'), { x: 301, y: 220, width: 244, height: 134, frame: { x: 300, y: 200, width: 246, height: 159 } });
  assert.deepEqual(m.get('0x0060000c'), { x: -60, y: 44, width: 640, height: 480 });
  assert.deepEqual(m.get('0x0020011f'), { x: -100, y: -100, width: 1, height: 1 });
  assert.equal(m.has('0x0000021f'), false, 'header lines are not windows');
  assert.equal(L.parseXwininfoTree('').size, 0);
});

test('X11: listWindows corrects wmctrl origins with xwininfo', async () => {
  const wmctrl =
    '0x0040000c  0 2211   302  240  244  134  xterm.XTerm           vm root@vm: /tmp\n' +
    '0x0060000c  0 0      -56  68   640  480  gedit.Gedit           vm Second — ü\n' +
    '0x0070000c  0 0      10   20   300  200  foo.Foo               vm Not in the tree\n';
  const responses = {
    'wmctrl -lpGx': { stdout: wmctrl },
    'xdotool getactivewindow': { stdout: '4194316\n' },
    'xwininfo -root -tree': { stdout: XWININFO_TREE },
  };
  const f = fake({ env: { DISPLAY: ':42' }, tools: ['wmctrl', 'xdotool', 'xwininfo'], responses });
  const wins = await x11(f).listWindows();
  assert.deepEqual(wins.map((w) => [w.id, w.x, w.y, w.width, w.height]), [
    ['0x0040000c', 301, 220, 244, 134],
    ['0x0060000c', -60, 44, 640, 480],
    ['0x0070000c', 10, 20, 300, 200],
  ]);
  assert.equal(f.calls.find((c) => c.cmd === 'xwininfo').opts.env.LC_ALL, 'C');

  // Without xwininfo (or when it fails) the wmctrl geometry is kept.
  const n = fake({ env: { DISPLAY: ':42' }, tools: ['wmctrl', 'xdotool'], responses });
  assert.equal((await x11(n).listWindows())[0].y, 240);
  const b = fake({ env: { DISPLAY: ':42' }, tools: ['wmctrl', 'xdotool', 'xwininfo'], responses: { ...responses, 'xwininfo -root -tree': { code: 1, stderr: 'boom' } } });
  assert.equal((await x11(b).listWindows())[0].y, 240);
});

test('X11: the xdotool listing fallback gets the same correction', async () => {
  const f = fake({
    tools: ['xdotool', 'xwininfo'],
    responses: {
      'xdotool search --onlyvisible --name .': { stdout: '4194316\n' },
      'xdotool getwindowname 4194316': { stdout: 'root@vm: /tmp\n' },
      'xdotool getwindowpid 4194316': { code: 1 },
      'xdotool getwindowgeometry --shell 4194316': { stdout: 'WINDOW=4194316\nX=302\nY=240\nWIDTH=244\nHEIGHT=134\nSCREEN=0\n' },
      'xdotool getactivewindow': { stdout: '4194316\n' },
      'xwininfo -root -tree': { stdout: XWININFO_TREE },
    },
  });
  const [w] = await x11(f).listWindows();
  assert.deepEqual([w.x, w.y, w.width, w.height], [301, 220, 244, 134]);
});

test('X11: capabilities mention a missing xwininfo', async () => {
  const f = fake({ tools: ['xdotool', 'wmctrl', 'apt-get'], responses: { 'xdotool getdisplaygeometry': { stdout: '800 600\n' } } });
  const caps = await x11(f).capabilities();
  assert.ok(caps.notes.some((n) => /xwininfo not found/.test(n) && /x11-utils/.test(n)), caps.notes.join(' | '));
});

// ---------------------------------------------------------------------------
// LINUX-CONTEXT-8: compositor detection by markers and whole tokens
// ---------------------------------------------------------------------------

test('detectCompositor: runtime markers first, whole tokens, wlroots family before GNOME', () => {
  const d = L.detectCompositor;
  // Budgie 10.10 runs on labwc but keeps "Budgie:GNOME".
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'Budgie:GNOME', LABWC_PID: '1234' }), 'wlroots');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'Budgie:GNOME', DESKTOP_SESSION: 'budgie-desktop' }), 'wlroots');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'LXQt', LABWC_PID: '99' }), 'wlroots');
  assert.equal(d({ WAYFIRE_SOCKET: '/run/user/1000/wayfire.sock', XDG_CURRENT_DESKTOP: 'GNOME' }), 'wlroots');
  assert.equal(d({ NIRI_SOCKET: '/run/user/1000/niri.sock' }), 'wlroots');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'labwc:wlroots' }), 'wlroots');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'COSMIC', XDG_SESSION_DESKTOP: 'pop' }), 'wlroots');
  // Substrings no longer match.
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'LXQt', DESKTOP_SESSION: 'Lubuntu' }), 'unknown');
  assert.equal(d({ DESKTOP_SESSION: 'popcorn' }), 'unknown');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'swayish' }), 'unknown');
  // GNOME, KDE, sway and Hyprland as before.
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), 'gnome');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'pop:GNOME' }), 'gnome');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'GNOME-Classic:GNOME' }), 'gnome');
  assert.equal(d({ DESKTOP_SESSION: 'ubuntu-wayland' }), 'gnome');
  assert.equal(d({ XDG_SESSION_DESKTOP: 'gnome' }), 'gnome');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'Unity:Unity7:ubuntu' }), 'gnome');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'KDE' }), 'kde');
  assert.equal(d({ DESKTOP_SESSION: 'plasmawayland' }), 'kde');
  assert.equal(d({ DESKTOP_SESSION: '/usr/share/xsessions/plasma' }), 'kde');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'sway' }), 'sway');
  assert.equal(d({ XDG_CURRENT_DESKTOP: 'Hyprland' }), 'hyprland');
  assert.equal(d({ SWAYSOCK: '/run/sway', XDG_CURRENT_DESKTOP: 'GNOME' }), 'sway');
});

test('Wayland/Budgie on labwc: wtype is used and grim is tried first', async () => {
  const f = fake({
    env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'Budgie:GNOME', LABWC_PID: '4242' },
    tools: ['wtype', 'grim', 'gnome-screenshot'],
    responses: { wtype: {} },
  });
  const d = wl(f);
  assert.equal(d.compositor, 'wlroots');
  await d.keyCombo('ctrl+c');
  assert.equal(f.calls.at(-1).line, 'wtype -M ctrl -k c -m ctrl');
  await d.typeText('hi');
  assert.equal(f.calls.at(-1).cmd, 'wtype');
  assert.equal(d._captureOrder()[0], 'grim');
});
