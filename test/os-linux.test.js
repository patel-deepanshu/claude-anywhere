'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const L = require('../src/os/linux');
const proc = require('../src/shared/proc');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Minimal RGB PNG encoder for fixtures. */
function makePng(w, h, pixel = (x, y) => [x & 0xff, y & 0xff, 0]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Fake run/which. `responses` maps "cmd arg1 arg2" (or just "cmd") to a partial run result
 * or to a function (args, opts) => partial result.
 */
function fake({ tools = [], responses = {}, env = { DISPLAY: ':42', LANG: 'C.UTF-8' } } = {}) {
  const calls = [];
  const which = (n) => (tools.includes(n) ? `/usr/bin/${n}` : null);
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts, line: `${cmd} ${args.join(' ')}`.trim() });
    const key = `${cmd} ${args.join(' ')}`.trim();
    let r = Object.prototype.hasOwnProperty.call(responses, key) ? responses[key] : responses[cmd];
    if (typeof r === 'function') r = await r(args, opts);
    if (r === undefined) r = { code: 1, stderr: `no fake response for: ${key}` };
    return {
      code: 0,
      signal: null,
      stdout: opts.encoding === 'buffer' ? Buffer.alloc(0) : '',
      stderr: '',
      timedOut: false,
      error: null,
      ...r,
    };
  };
  return { calls, which, run, env };
}

/**
 * ImageMagick 6's `convert`, or null. On Windows, `convert` on PATH is normally
 * C:\Windows\System32\convert.exe (the FAT-to-NTFS volume converter), which must never be run.
 */
function imageMagickConvert() {
  const exe = proc.which('convert');
  if (!exe) return null;
  if (process.platform === 'win32' && /[\\/]system32[\\/]/i.test(exe)) return null;
  return exe;
}

function x11(f, extra = {}) {
  return L.createDriver({ displayServer: 'x11', run: f.run, which: f.which, env: f.env, hostnames: ['vm'], ...extra });
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

const XRANDR_MULTI = `Screen 0: minimum 320 x 200, current 5560 x 1920, maximum 16384 x 16384
eDP-1 connected 1920x1080+2560+360 (normal left inverted right x axis y axis) 309mm x 174mm
   1920x1080     60.01*+  59.97    59.96    59.93
HDMI-1 connected primary 2560x1440+0+0 (normal left inverted right x axis y axis) 597mm x 336mm
   2560x1440     59.95*+
DP-1 disconnected (normal left inverted right x axis y axis)
DP-2 connected (normal left inverted right x axis y axis)
   1920x1080     60.00 +
DP-3 connected 1080x1920+4480+0 left (normal left inverted right x axis y axis) 527mm x 296mm
   1920x1080     60.00*+
`;

test('parseXrandr: connected outputs, primary first, rotated, inactive skipped', () => {
  const d = L.parseXrandr(XRANDR_MULTI);
  assert.equal(d.length, 3);
  assert.deepEqual(d[0], { index: 0, id: 'HDMI-1', x: 0, y: 0, width: 2560, height: 1440, scale: 1, primary: true });
  assert.deepEqual(d[1], { index: 1, id: 'eDP-1', x: 2560, y: 360, width: 1920, height: 1080, scale: 1, primary: false });
  assert.deepEqual(d[2], { index: 2, id: 'DP-3', x: 4480, y: 0, width: 1080, height: 1920, scale: 1, primary: false });
});

test('parseXrandr: no primary flag → origin display first; mirrored outputs deduped', () => {
  const text = `Screen 0: minimum 8 x 8, current 3840 x 1080, maximum 32767 x 32767
HDMI-2 connected 1920x1080+1920+0 (normal) 0mm x 0mm
LVDS-1 connected 1920x1080+0+0 (normal) 0mm x 0mm
VGA-1 connected 1920x1080+0+0 (normal) 0mm x 0mm
`;
  const d = L.parseXrandr(text);
  assert.equal(d.length, 2);
  assert.equal(d[0].id, 'LVDS-1');
  assert.equal(d[0].primary, true);
  assert.equal(d[1].id, 'HDMI-2');
  assert.equal(d[1].primary, false);
  assert.deepEqual(L.parseXrandr('screen connected primary 1280x800+0+0 0mm x 0mm\n')[0].width, 1280);
  assert.deepEqual(L.parseXrandr(''), []);
});

test('display size fallbacks: xdotool, xwininfo, xdpyinfo', () => {
  const expected = [{ index: 0, id: 'screen', x: 0, y: 0, width: 1280, height: 800, scale: 1, primary: true }];
  assert.deepEqual(L.parseDisplayGeometry('1280 800\n'), expected);
  assert.deepEqual(L.parseXwininfoRoot('xwininfo: Window id: 0x21f (the root window)\n  Width: 1280\n  Height: 800\n  Depth: 24\n'), expected);
  assert.deepEqual(L.parseXdpyinfo('screen #0:\n  dimensions:    1280x800 pixels (338x211 millimeters)\n'), expected);
  assert.deepEqual(L.parseDisplayGeometry('garbage'), []);
});

test('parseMouseLocation: --shell and plain forms', () => {
  assert.deepEqual(L.parseMouseLocation('X=640\nY=400\nSCREEN=0\nWINDOW=2097525\n'), { x: 640, y: 400, screen: 0, window: 2097525 });
  assert.deepEqual(L.parseMouseLocation('x:120 y:-3 screen:0 window:543\n'), { x: 120, y: -3, screen: 0, window: 0 });
  assert.equal(L.parseMouseLocation(''), null);
});

const WMCTRL = [
  '0x0040000c  0 2211   399  269  484  316  xterm.XTerm           vm root@vm: /tmp',
  '0x0060000c  0 2273   2    499  484  316  xterm.XTerm           vm Ünï 漢字 test',
  '0x03a00003 -1 1500   0    0    1920 32   xfce4-panel.Xfce4-panel  vm xfce4-panel',
  '0x04200007  1 3400   -5   -10  1280 720  code.Code             vm main.js - my repo - Visual Studio Code',
  '0x05000001  0 0      10   10   300  200  N/A                   N/A ',
  '0x06000003  0 4100   0    0    800  600  VirtualBox Machine.VirtualBox Machine  vm Ubuntu [Running] - Oracle VM VirtualBox',
  '0x07000001  0 4200   0    0    800  600  google-chrome.Google-chrome  otherhost GCP Console - Google Chrome',
  'not a window line',
].join('\n');

test('parseWmctrl: ids, geometry, class → app, titles with spaces and unicode', () => {
  const w = L.parseWmctrl(WMCTRL, { hostnames: ['vm'] });
  assert.equal(w.length, 7);
  assert.deepEqual(
    { ...w[0], wmClass: undefined },
    { id: '0x0040000c', desktop: 0, pid: 2211, x: 399, y: 269, width: 484, height: 316, wmClass: undefined, app: 'XTerm', title: 'root@vm: /tmp' },
  );
  assert.equal(w[1].title, 'Ünï 漢字 test');
  assert.equal(w[2].desktop, -1);
  assert.equal(w[2].app, 'Xfce4 Panel');
  assert.equal(w[3].app, 'Visual Studio Code');
  assert.equal(w[3].title, 'main.js - my repo - Visual Studio Code');
  assert.equal(w[3].x, -5);
  assert.equal(w[3].y, -10);
  assert.equal(w[4].title, '');
  assert.equal(w[4].wmClass, 'N/A');
  assert.equal(w[5].app, 'VirtualBox Machine');
  assert.equal(w[5].title, 'Ubuntu [Running] - Oracle VM VirtualBox');
  assert.equal(w[6].app, 'Google Chrome');
  assert.equal(w[6].title, 'GCP Console - Google Chrome');
});

test('classFromWmctrl and prettifyApp', () => {
  assert.equal(L.classFromWmctrl('xterm.XTerm'), 'XTerm');
  assert.equal(L.classFromWmctrl('Navigator.firefox'), 'firefox');
  assert.equal(L.classFromWmctrl('org.gnome.Nautilus.Org.gnome.Nautilus'), 'Org.gnome.Nautilus');
  assert.equal(L.classFromWmctrl('N/A'), '');
  assert.equal(L.prettifyApp('Org.gnome.Nautilus'), 'Files');
  assert.equal(L.prettifyApp('firefox'), 'Firefox');
  assert.equal(L.prettifyApp('Gnome-terminal'), 'GNOME Terminal');
  assert.equal(L.prettifyApp('Code'), 'Visual Studio Code');
  assert.equal(L.prettifyApp('com.github.someone.CoolApp'), 'CoolApp');
  assert.equal(L.prettifyApp('foo_bar-baz'), 'Foo Bar Baz');
  assert.equal(L.prettifyApp(''), '');
});

test('normalizeX11Id accepts decimal and hex, rejects junk', () => {
  assert.equal(L.normalizeX11Id(4194316), '0x0040000c');
  assert.equal(L.normalizeX11Id('4194316'), '0x0040000c');
  assert.equal(L.normalizeX11Id('0x40000c'), '0x0040000c');
  assert.equal(L.normalizeX11Id(' 0x0040000C '), '0x0040000c');
  for (const bad of ['abc', 0, -1, '0x', '', null, 1.5, '0x1ffffffff']) {
    assert.throws(() => L.normalizeX11Id(bad), (e) => e.code === 'BAD_WINDOW_ID', String(bad));
  }
});

test('parseXprop decodes octal UTF-8, latin1 fallback, atoms and window ids', () => {
  const text = [
    '_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN, _NET_WM_STATE_ABOVE',
    '_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL',
    'WM_CLASS(STRING) = "xterm", "XTerm"',
    'WM_NAME(STRING) = "\\303\\234n\\303\\257 \\346\\274\\242 \\"q\\" \\\\ end"',
    '_NET_WM_NAME:  not found.',
    '_NET_WM_PID(CARDINAL) = 2211',
    '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x40000c',
    'EMPTY(ATOM) = ',
  ].join('\n');
  const p = L.parseXprop(text);
  assert.deepEqual(p._NET_WM_STATE.values, ['_NET_WM_STATE_HIDDEN', '_NET_WM_STATE_ABOVE']);
  assert.deepEqual(p.WM_CLASS.values, ['xterm', 'XTerm']);
  assert.equal(p.WM_NAME.values[0], 'Ünï 漢 "q" \\ end');
  assert.equal(p._NET_WM_NAME, undefined);
  assert.deepEqual(p._NET_WM_PID.values, ['2211']);
  assert.deepEqual(p._NET_ACTIVE_WINDOW.values, ['0x40000c']);
  assert.deepEqual(p.EMPTY.values, []);
  assert.equal(L.decodeXpropString('caf\\351'), 'café');
});

test('parseWindowGeometry: --shell, plain and fractional (kdotool) forms', () => {
  assert.deepEqual(L.parseWindowGeometry('WINDOW=1\nX=399\nY=269\nWIDTH=484\nHEIGHT=316\nSCREEN=0\n'), { x: 399, y: 269, width: 484, height: 316 });
  assert.deepEqual(L.parseWindowGeometry('Window 4194316\n  Position: 399,269 (screen: 0)\n  Geometry: 484x316\n'), { x: 399, y: 269, width: 484, height: 316 });
  assert.deepEqual(L.parseWindowGeometry('Window {abc}\n  Position: 10.5,20\n  Geometry: 800.2x600\n'), { x: 11, y: 20, width: 800, height: 600 });
  assert.equal(L.parseWindowGeometry('nope'), null);
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

test('buildClickArgs holds modifiers around the click and clamps clicks', () => {
  assert.deepEqual(L.buildClickArgs('left', 2, ['ctrl', 'shift']), [
    'keydown', 'ctrl', 'keydown', 'shift', 'click', '--repeat', '2', '--delay', '80', '1', 'keyup', 'shift', 'keyup', 'ctrl',
  ]);
  assert.deepEqual(L.buildClickArgs('right', 1), ['click', '--repeat', '1', '--delay', '80', '3']);
  assert.deepEqual(L.buildClickArgs('middle', 0).slice(-3), ['--delay', '80', '2'].slice(-3));
  assert.equal(L.buildClickArgs('left', 0)[2], '1');
  assert.equal(L.buildClickArgs('left', 50)[2], '10');
  assert.throws(() => L.buildClickArgs('sideways', 1), TypeError);
});

test('x11Modifiers normalizes aliases, dedupes and rejects unknown names', () => {
  assert.deepEqual(L.x11Modifiers(['Control', 'cmd', 'Shift', 'ctrl']), ['ctrl', 'super', 'shift']);
  assert.deepEqual(L.x11Modifiers('ctrl+alt'), ['ctrl', 'alt']);
  assert.deepEqual(L.x11Modifiers([]), []);
  assert.deepEqual(L.x11Modifiers(undefined), []);
  assert.throws(() => L.x11Modifiers(['hyperdrive']), TypeError);
});

test('buildDragArgs: mousedown, 12 interpolated moves 15 ms apart, mouseup', () => {
  const args = L.buildDragArgs({ x: 0, y: 0 }, { x: 120, y: 60 }, 'left');
  assert.deepEqual(args.slice(0, 4), ['mousedown', '1', 'sleep', '0.05']);
  assert.deepEqual(args.slice(-2), ['mouseup', '1']);
  const moves = [];
  for (let i = 0; i < args.length; i++) if (args[i] === 'mousemove') moves.push([+args[i + 1], +args[i + 2], args[i + 4]]);
  assert.equal(moves.length, 12);
  assert.deepEqual(moves[0], [10, 5, '0.015']);
  assert.deepEqual(moves[11], [120, 60, '0.015']);
  assert.equal(L.buildDragArgs({ x: 5, y: 5 }, { x: 6, y: 6 }, 'right')[1], '3');
});

test('buildScrollArgs: 4/5 vertical, 6/7 horizontal, repeat per notch, capped', () => {
  assert.deepEqual(L.buildScrollArgs(0, 3), ['click', '--repeat', '3', '--delay', '30', '5']);
  assert.deepEqual(L.buildScrollArgs(0, -2), ['click', '--repeat', '2', '--delay', '30', '4']);
  assert.deepEqual(L.buildScrollArgs(2, 0), ['click', '--repeat', '2', '--delay', '30', '7']);
  assert.deepEqual(L.buildScrollArgs(-1, 1), ['click', '--repeat', '1', '--delay', '30', '5', 'click', '--repeat', '1', '--delay', '30', '6']);
  assert.deepEqual(L.buildScrollArgs(0, 0), []);
  assert.equal(L.buildScrollArgs(0, 1e6)[2], '200');
});

test('buildX11CaptureCommand for maim, import and ffmpeg', () => {
  const r = { x: 1920, y: 0, width: 1280, height: 1024 };
  assert.deepEqual(L.buildX11CaptureCommand('maim', r), { cmd: 'maim', args: ['-g', '1280x1024+1920+0'] });
  assert.deepEqual(L.buildX11CaptureCommand('import', r), {
    cmd: 'import',
    args: ['-window', 'root', '-crop', '1280x1024+1920+0', '+repage', 'png:-'],
  });
  assert.deepEqual(L.buildX11CaptureCommand('ffmpeg', r, ':0.0'), {
    cmd: 'ffmpeg',
    args: ['-loglevel', 'error', '-f', 'x11grab', '-video_size', '1280x1024', '-i', ':0.0+1920,0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'],
  });
  assert.throws(() => L.buildX11CaptureCommand('scrot', r));
});

test('chunkText splits by code points and never breaks surrogate pairs', () => {
  assert.deepEqual(L.chunkText('a'.repeat(450), 200).map((c) => c.length), [200, 200, 50]);
  const chunks = L.chunkText(`${'a'.repeat(199)}😀b`, 200);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endsWith('😀'));
  assert.equal(chunks[1], 'b');
  assert.deepEqual(L.chunkText('', 200), []);
});

test('key helpers: local normalization, keysyms, xdotool combos', () => {
  assert.deepEqual(L.splitCombo('ctrl++'), ['ctrl', '+']);
  assert.deepEqual(L.splitCombo('Ctrl+Shift+T'), ['Ctrl', 'Shift', 'T']);
  assert.deepEqual(L.splitCombo('+'), ['+']);
  assert.equal(L.normalizeKeyName('Control'), 'ctrl');
  assert.equal(L.normalizeKeyName('Return'), 'enter');
  assert.equal(L.normalizeKeyName('T'), 't');
  assert.equal(L.normalizeKeyName('F12'), 'f12');
  assert.equal(L.normalizeKeyName('XF86AudioPlay'), 'XF86AudioPlay');
  assert.equal(L.xKeysym('enter'), 'Return');
  assert.equal(L.xKeysym('pageup'), 'Prior');
  assert.equal(L.xKeysym('meta'), 'super');
  assert.equal(L.xKeysym('f5'), 'F5');
  assert.equal(L.xKeysym('+'), 'plus');
  assert.equal(L.xKeysym('é'), 'U00E9');
  assert.equal(L.xdotoolCombo('Ctrl+Shift+T'), 'ctrl+shift+t');
  assert.equal(L.xdotoolCombo(['ctrl', 'enter']), 'ctrl+Return');
  assert.equal(L.xdotoolCombo('ctrl++'), 'ctrl+plus');
  assert.equal(L.xdotoolCombo('primary+s'), 'ctrl+s');
  assert.equal(L.xdotoolCombo(['meta']), 'super');
  assert.throws(() => L.xdotoolCombo(42));
});

test('ydotool and wtype key builders', () => {
  assert.deepEqual(L.ydotoolKeyArgs(['ctrl', 'c']), ['key', '29:1', '46:1', '46:0', '29:0']);
  assert.deepEqual(L.ydotoolKeyArgs('ctrl+shift+t'), ['key', '29:1', '42:1', '20:1', '20:0', '42:0', '29:0']);
  assert.deepEqual(L.ydotoolKeyArgs(['!']), ['key', '42:1', '2:1', '2:0', '42:0']);
  assert.deepEqual(L.ydotoolKeyArgs(['enter']), ['key', '28:1', '28:0']);
  assert.deepEqual(L.wtypeKeyArgs(['ctrl', 'c']), ['-M', 'ctrl', '-k', 'c', '-m', 'ctrl']);
  assert.deepEqual(L.wtypeKeyArgs(['meta', 'enter']), ['-M', 'logo', '-k', 'Return', '-m', 'logo']);
  assert.deepEqual(L.wtypeKeyArgs('ctrl+alt+delete'), ['-M', 'ctrl', '-M', 'alt', '-k', 'Delete', '-m', 'alt', '-m', 'ctrl']);
  assert.deepEqual(L.wtypeTextArgs('-a\n--b c'), ['-d', '5', '-k', 'minus', 'a', '-k', 'Return', '-k', 'minus', '-k', 'minus', 'b c']);
  assert.deepEqual(L.wtypeTextArgs('héllo'), ['-d', '5', 'héllo']);
  assert.equal(L.ydotoolButtonCode('left'), '0xC0');
  assert.equal(L.ydotoolButtonCode('right'), '0xC1');
  assert.equal(L.ydotoolButtonCode('middle'), '0xC2');
  assert.equal(L.ydotoolButtonCode('left', 'down'), '0x40');
  assert.equal(L.ydotoolButtonCode('right', 'up'), '0x81');
});

test('clampToDisplays snaps points into the nearest display', () => {
  const ds = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 300, width: 1280, height: 1024 },
  ];
  assert.deepEqual(L.clampToDisplays(100.4, 200.6, ds), { x: 100, y: 201 });
  assert.deepEqual(L.clampToDisplays(5000, 500, ds), { x: 3199, y: 500 });
  assert.deepEqual(L.clampToDisplays(-50, -50, ds), { x: 0, y: 0 });
  assert.deepEqual(L.clampToDisplays(2500, 100, ds), { x: 2500, y: 300 });
  assert.deepEqual(L.clampToDisplays(-5, 7, null), { x: 0, y: 7 });
  assert.throws(() => L.clampToDisplays('a', 1, ds), TypeError);
});

test('pngInfo validates signature, IHDR and IEND', () => {
  const png = makePng(7, 3);
  assert.deepEqual(L.pngInfo(png), { width: 7, height: 3 });
  assert.equal(L.pngInfo(png.subarray(0, png.length - 4)), null);
  assert.equal(L.pngInfo(Buffer.from('not a png at all, definitely not, no no no no')), null);
  assert.equal(L.pngInfo(null), null);
});

test('detectPackageManager and installHint', () => {
  const w = (have) => (n) => (have.includes(n) ? `/usr/bin/${n}` : null);
  assert.equal(L.detectPackageManager(w(['apt-get'])), 'apt');
  assert.equal(L.detectPackageManager(w(['dnf'])), 'dnf');
  assert.equal(L.detectPackageManager(w(['pacman'])), 'pacman');
  assert.equal(L.detectPackageManager(w(['zypper'])), 'zypper');
  assert.equal(L.detectPackageManager(w(['apk'])), 'apk');
  assert.equal(L.detectPackageManager(w([])), null);
  assert.equal(L.installHint(['xdotool', 'wmctrl', 'xclip', 'imagemagick'], 'apt'), 'sudo apt install xdotool wmctrl xclip imagemagick');
  assert.equal(L.installHint(['imagemagick', 'xrandr'], 'dnf'), 'sudo dnf install ImageMagick xrandr');
  assert.equal(L.installHint(['xrandr', 'xprop'], 'pacman'), 'sudo pacman -S xorg-xrandr xorg-xprop');
  assert.equal(L.installHint(['notify-send'], 'zypper'), 'sudo zypper install libnotify-tools');
  assert.equal(L.installHint(['wl-clipboard'], 'apk'), 'sudo apk add wl-clipboard');
  assert.equal(L.installHint(['xprop', 'xwininfo'], 'apt'), 'sudo apt install x11-utils');
  assert.match(L.installHint(['xdotool'], null), /package manager: xdotool/);
});

test('detectCompositor', () => {
  assert.equal(L.detectCompositor({ SWAYSOCK: '/run/sway' }), 'sway');
  assert.equal(L.detectCompositor({ HYPRLAND_INSTANCE_SIGNATURE: 'x' }), 'hyprland');
  assert.equal(L.detectCompositor({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), 'gnome');
  assert.equal(L.detectCompositor({ XDG_CURRENT_DESKTOP: 'KDE' }), 'kde');
  assert.equal(L.detectCompositor({ XDG_CURRENT_DESKTOP: 'river' }), 'wlroots');
  assert.equal(L.detectCompositor({}), 'unknown');
  // Whole tokens and runtime markers, wlroots family before GNOME.
  assert.equal(L.detectCompositor({ XDG_CURRENT_DESKTOP: 'Budgie:GNOME', LABWC_PID: '42' }), 'wlroots');
  assert.equal(L.detectCompositor({ XDG_CURRENT_DESKTOP: 'LXQt', DESKTOP_SESSION: 'Lubuntu' }), 'unknown');
  assert.equal(L.detectCompositor({ XDG_CURRENT_DESKTOP: 'pop:GNOME' }), 'gnome');
});

// ---------------------------------------------------------------------------
// Wayland parsers
// ---------------------------------------------------------------------------

const SWAY_OUTPUTS = JSON.stringify([
  { name: 'eDP-1', active: true, scale: 2, rect: { x: 0, y: 0, width: 1280, height: 800 }, focused: false },
  { name: 'HDMI-A-1', active: true, scale: 1, rect: { x: 1280, y: 0, width: 1920, height: 1080 }, focused: true },
  { name: 'DP-9', active: false, rect: { x: 0, y: 0, width: 0, height: 0 } },
]);

const SWAY_TREE = JSON.stringify({
  id: 1,
  type: 'root',
  nodes: [
    { id: 2, type: 'output', name: '__i3', nodes: [{ id: 3, type: 'workspace', name: '__i3_scratch', nodes: [], floating_nodes: [
      { id: 40, type: 'floating_con', name: 'Hidden notes', app_id: 'org.gnome.TextEditor', pid: 0, rect: { x: 1, y: 2, width: 3, height: 4 }, nodes: [], floating_nodes: [] },
    ] }] },
    { id: 5, type: 'output', name: 'eDP-1', nodes: [{ id: 6, type: 'workspace', name: '1', nodes: [
      { id: 12, type: 'con', name: 'main.js - repo - Visual Studio Code', app_id: null, pid: 0, focused: true,
        window_properties: { class: 'Code', instance: 'code', title: 'main.js' }, rect: { x: 0, y: 0, width: 640, height: 800 }, nodes: [], floating_nodes: [] },
      { id: 13, type: 'con', name: null, layout: 'splitv', nodes: [
        { id: 14, type: 'con', name: 'GCP — Chromium', app_id: 'chromium', pid: 0, focused: false, rect: { x: 640, y: 0, width: 640, height: 800 }, nodes: [], floating_nodes: [] },
      ], floating_nodes: [] },
    ], floating_nodes: [] }] },
  ],
});

test('parseSwayOutputs and walkSwayTree', () => {
  const d = L.parseSwayOutputs(SWAY_OUTPUTS);
  assert.deepEqual(d, [
    { index: 0, id: 'eDP-1', x: 0, y: 0, width: 1280, height: 800, scale: 2, primary: true },
    { index: 1, id: 'HDMI-A-1', x: 1280, y: 0, width: 1920, height: 1080, scale: 1, primary: false },
  ]);
  const w = L.walkSwayTree(SWAY_TREE);
  assert.equal(w.length, 3);
  const byId = Object.fromEntries(w.map((x) => [x.id, x]));
  assert.equal(byId['40'].minimized, true);
  assert.equal(byId['12'].app, 'Visual Studio Code');
  assert.equal(byId['12'].focused, true);
  assert.equal(byId['14'].app, 'Chromium');
  assert.equal(byId['14'].x, 640);
  assert.deepEqual(L.walkSwayTree('not json'), []);
});

test('parseHyprMonitors, parseHyprClients, wlr-randr (json and text)', () => {
  const mons = L.parseHyprMonitors(JSON.stringify([
    { id: 1, name: 'DP-1', width: 2560, height: 1440, x: 1920, y: 0, scale: 1, transform: 0 },
    { id: 0, name: 'eDP-1', width: 3840, height: 2160, x: 0, y: 0, scale: 2, transform: 1 },
  ]));
  assert.deepEqual(mons.map((m) => [m.id, m.x, m.width, m.height, m.scale, m.primary]), [
    ['eDP-1', 0, 1080, 1920, 2, true],
    ['DP-1', 1920, 2560, 1440, 1, false],
  ]);
  const clients = L.parseHyprClients(JSON.stringify([
    { address: '0xa1', mapped: true, hidden: false, at: [10, 20], size: [800, 600], workspace: { id: 1, name: '1' }, class: 'google-chrome', title: 'GCP', pid: 7, focusHistoryID: 1 },
    { address: '0xb2', mapped: true, hidden: false, at: [0, 0], size: [100, 100], workspace: { id: -99, name: 'special:minimized' }, class: 'kitty', title: 'shell', pid: 8, focusHistoryID: 0 },
    { address: '0xc3', mapped: false, at: [0, 0], size: [1, 1], workspace: { name: '1' }, class: 'x', title: '', pid: 9 },
  ]), '0xa1');
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[0], { id: '0xa1', app: 'Google Chrome', title: 'GCP', pid: 7, x: 10, y: 20, width: 800, height: 600, focused: true, minimized: false, stackIndex: 1 });
  assert.equal(clients[1].minimized, true);
  assert.equal(clients[1].focused, false);
  assert.equal(clients[1].stackIndex, 0, 'focus history is the z-order (LINUX-CONTEXT-4)');
  assert.ok(!('stackIndex' in L.parseHyprClients([{ address: '0xd4', at: [0, 0], size: [1, 1], class: 'x' }])[0]));

  const wj = L.parseWlrRandrJson(JSON.stringify([
    { name: 'DP-1', enabled: true, modes: [{ width: 3840, height: 2160, current: true }], position: { x: 0, y: 0 }, transform: 'normal', scale: 1.5 },
    { name: 'HDMI-A-1', enabled: false, modes: [{ width: 1920, height: 1080, current: true }], position: { x: 0, y: 0 }, scale: 1 },
  ]));
  assert.deepEqual(wj.map((m) => [m.id, m.width, m.height, m.scale]), [['DP-1', 2560, 1440, 1.5]]);

  const wt = L.parseWlrRandr(`DP-1 "Dell Inc. DELL U2720Q (DP-1)"
  Make: Dell Inc.
  Enabled: yes
  Modes:
    3840x2160 px, 59.997002 Hz (preferred, current)
    2560x1440 px, 59.951000 Hz
  Position: 1920,0
  Transform: 90
  Scale: 2.000000
eDP-1 "Built-in"
  Enabled: yes
  Modes:
    1920x1080 px, 60.000000 Hz (preferred, current)
  Position: 0,0
  Transform: normal
  Scale: 1.000000
HDMI-A-2 "Off"
  Enabled: no
  Modes:
    1920x1080 px, 60.000000 Hz (preferred)
`);
  assert.deepEqual(wt.map((m) => [m.id, m.x, m.y, m.width, m.height, m.scale]), [
    ['eDP-1', 0, 0, 1920, 1080, 1],
    ['DP-1', 1920, 0, 1080, 1920, 2],
  ]);
});

// ---------------------------------------------------------------------------
// X11 driver with injected run/which
// ---------------------------------------------------------------------------

test('createDriver picks the backend and exposes the Driver surface', async () => {
  const methods = ['capabilities', 'displays', 'captureDisplay', 'cursorPosition', 'moveMouse', 'click', 'mouseDown', 'mouseUp',
    'drag', 'scroll', 'typeText', 'keyCombo', 'listWindows', 'activeWindow', 'focusWindow', 'minimizeWindow', 'setTopmost',
    'clipboardGet', 'clipboardSet', 'close'];
  const a = L.createDriver({ displayServer: 'x11' });
  const b = L.createDriver({ displayServer: 'wayland', env: { WAYLAND_DISPLAY: 'wayland-0' } });
  assert.equal(a.name, 'linux-x11');
  assert.equal(b.name, 'linux-wayland');
  for (const m of methods) {
    assert.equal(typeof a[m], 'function', `x11 ${m}`);
    assert.equal(typeof b[m], 'function', `wayland ${m}`);
  }
  assert.equal(L.createDriver({ env: { WAYLAND_DISPLAY: 'wayland-0' } }).name, 'linux-wayland');
  assert.equal(L.createDriver({ env: { DISPLAY: ':0' } }).name, 'linux-x11');
  assert.equal(await a.close(), undefined);
});

test('X11: no DISPLAY → UNSUPPORTED with a hint', async () => {
  const f = fake({ tools: ['xdotool', 'import'], env: {} });
  const d = x11(f);
  await assert.rejects(d.captureDisplay(0), (e) => e.code === 'UNSUPPORTED' && /DISPLAY/.test(e.message) && /DISPLAY=/.test(e.hint));
  await assert.rejects(d.click(1, 1), (e) => e.code === 'UNSUPPORTED');
  assert.equal(f.calls.length, 0);
});

test('X11: missing xdotool → UNSUPPORTED with install hint', async () => {
  const f = fake({ tools: ['apt-get'] });
  const d = x11(f);
  await assert.rejects(d.click(10, 10), (e) => e.code === 'UNSUPPORTED' && e.hint === 'sudo apt install xdotool');
  await assert.rejects(d.keyCombo(['ctrl', 'c']), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(d.listWindows(), (e) => e.code === 'UNSUPPORTED' && /wmctrl/.test(e.hint));
  await assert.rejects(d.clipboardSet('x'), (e) => e.code === 'UNSUPPORTED' && /xclip/.test(e.hint));
});

test('X11: displays fall back from a failing xrandr to xdotool and are cached', async () => {
  const f = fake({
    tools: ['xrandr', 'xdotool'],
    responses: { xrandr: { code: 1, stderr: "Can't open display" }, 'xdotool getdisplaygeometry': { stdout: '1024 768\n' } },
  });
  const d = x11(f);
  const ds = await d.displays();
  assert.deepEqual(ds, [{ index: 0, id: 'screen', x: 0, y: 0, width: 1024, height: 768, scale: 1, primary: true }]);
  await d.displays();
  assert.deepEqual(f.calls.map((c) => c.line), ['xrandr --current', 'xrandr --query', 'xdotool getdisplaygeometry'], 'second call served from cache');
  const g = fake({ tools: ['xrandr'], responses: { 'xrandr --current': { stdout: XRANDR_MULTI } } });
  assert.equal((await x11(g).displays()).length, 3);
  assert.equal(g.calls.length, 1, 'xrandr --current is enough');
});

test('X11: moveMouse skips --sync when already there and clamps off-screen targets', async () => {
  const f = fake({
    tools: ['xdotool'],
    responses: {
      'xdotool getdisplaygeometry': { stdout: '1280 800\n' },
      'xdotool getmouselocation --shell': { stdout: 'X=10\nY=20\nSCREEN=0\nWINDOW=1\n' },
      xdotool: {},
    },
  });
  const d = x11(f);
  await d.moveMouse(10, 20);
  assert.ok(!f.calls.some((c) => c.args[0] === 'mousemove'));
  await d.moveMouse(5000, 20);
  assert.ok(f.calls.some((c) => c.line === 'xdotool mousemove --sync 1279 20'));
  await d.click(30, 40, { button: 'right', clicks: 2, modifiers: ['ctrl'] });
  assert.equal(f.calls.at(-1).line, 'xdotool keydown ctrl click --repeat 2 --delay 80 3 keyup ctrl');
  await d.scroll(null, null, 0, -3);
  assert.equal(f.calls.at(-1).line, 'xdotool click --repeat 3 --delay 30 4');
  await d.typeText('a'.repeat(250));
  const types = f.calls.filter((c) => c.args[0] === 'type');
  assert.equal(types.length, 2);
  assert.deepEqual(types[0].args.slice(0, 5), ['type', '--clearmodifiers', '--delay', '8', '--']);
  assert.equal(types[0].args[5].length, 200);
  await d.keyCombo('ctrl+shift+t');
  assert.equal(f.calls.at(-1).line, 'xdotool key --clearmodifiers ctrl+shift+t');
  const pos = await d.cursorPosition();
  assert.deepEqual(pos, { x: 10, y: 20 });
});

test('X11: keyCombo surfaces keysyms xdotool skipped', async () => {
  const f = fake({
    tools: ['xdotool'],
    responses: { 'xdotool key --clearmodifiers ctrl+s': { stderr: "(symbol) No such key name 'bogus'. Ignoring it.\n" } },
  });
  await assert.rejects(x11(f).keyCombo(['ctrl', 's']), (e) => e.code === 'BAD_KEY');
});

test('X11: modifier keys are released when the click fails', async () => {
  const f = fake({
    tools: ['xdotool'],
    responses: {
      'xdotool getdisplaygeometry': { stdout: '1280 800\n' },
      'xdotool click --repeat 1 --delay 80 1': { code: 1, stderr: 'boom' },
      'xdotool keydown shift click --repeat 1 --delay 80 1 keyup shift': { code: 1, stderr: 'boom' },
      xdotool: {},
    },
  });
  const d = x11(f);
  await assert.rejects(d.click(null, null, { modifiers: ['shift'] }), (e) => e.code === 'COMMAND_FAILED' && /boom/.test(e.message));
  assert.equal(f.calls.at(-1).line, 'xdotool keyup shift');
});

test('X11: capture tries tools in order, validates PNGs and remembers the winner', async () => {
  const png = makePng(64, 48);
  const f = fake({
    tools: ['xdotool', 'import', 'ffmpeg'],
    responses: {
      'xdotool getdisplaygeometry': { stdout: '64 48\n' },
      import: { stdout: Buffer.from('this is not a png') },
      ffmpeg: { stdout: png },
    },
  });
  const d = x11(f);
  const shot = await d.captureDisplay(0);
  assert.equal(shot.width, 64);
  assert.equal(shot.height, 48);
  assert.ok(shot.png.equals(png));
  const order = f.calls.map((c) => c.cmd).filter((c) => c !== 'xdotool');
  assert.deepEqual(order, ['import', 'ffmpeg']);
  const ff = f.calls.find((c) => c.cmd === 'ffmpeg');
  assert.ok(ff.args.includes(':42+0,0'));
  assert.equal(ff.opts.encoding, 'buffer');
  f.calls.length = 0;
  await d.captureDisplay(0);
  assert.equal(f.calls.find((c) => c.cmd !== 'xdotool').cmd, 'ffmpeg');
  await assert.rejects(d.captureDisplay(3), (e) => e.code === 'BAD_DISPLAY');
});

test('X11: capture with no tools → UNSUPPORTED; all tools failing → CAPTURE_FAILED', async () => {
  const none = fake({ tools: ['xdotool', 'apt-get'], responses: { 'xdotool getdisplaygeometry': { stdout: '64 48\n' } } });
  await assert.rejects(x11(none).captureDisplay(0), (e) => e.code === 'UNSUPPORTED' && /imagemagick/.test(e.hint));
  const bad = fake({
    tools: ['xdotool', 'maim'],
    responses: { 'xdotool getdisplaygeometry': { stdout: '64 48\n' }, maim: { code: 1, stderr: 'Failed to open X display' } },
  });
  await assert.rejects(x11(bad).captureDisplay(0), (e) => e.code === 'CAPTURE_FAILED' && /maim/.test(e.message));
});

test('X11: full-root capture (scrot) is cropped to the display with ImageMagick', { skip: !imageMagickConvert() && 'ImageMagick convert not installed' }, async () => {
  const convertExe = imageMagickConvert();
  const root = makePng(96, 48, (x, y) => [x, y, x >= 64 ? 255 : 0]);
  const f = fake({
    tools: ['xrandr', 'scrot', 'convert'],
    responses: {
      'xrandr --query': { stdout: 'A connected primary 64x48+0+0 (normal) 0mm x 0mm\nB connected 32x24+64+0 (normal) 0mm x 0mm\n' },
      scrot: async (args) => {
        fs.writeFileSync(args[0], root);
        return {};
      },
      convert: (args, opts) => proc.run(convertExe, args, opts),
    },
  });
  const d = x11(f, { png: null });
  const shot = await d.captureDisplay(1);
  assert.equal(shot.width, 32);
  assert.equal(shot.height, 24);
  assert.ok(L.pngInfo(shot.png));
  const conv = f.calls.find((c) => c.cmd === 'convert');
  assert.ok(conv.args.includes('32x24+64+0'));
  assert.ok(!fs.existsSync(f.calls.find((c) => c.cmd === 'scrot').args[0]), 'temp file removed');
});

test('X11: listWindows via wmctrl + xprop (minimized, focus, docks filtered, UTF-8 locale)', async () => {
  const f = fake({
    env: { DISPLAY: ':42' },
    tools: ['wmctrl', 'xprop', 'xdotool'],
    responses: {
      'wmctrl -lpGx': { stdout: `${WMCTRL}\n` },
      'xdotool getactivewindow': { stdout: '4194316\n' },
      xprop: (args) => {
        const id = args[1];
        if (id === '0x03a00003') return { stdout: '_NET_WM_STATE(ATOM) = \n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DOCK\n' };
        if (id === '0x0060000c') return { stdout: '_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL\n' };
        return { stdout: '_NET_WM_STATE(ATOM) = \n_NET_WM_WINDOW_TYPE:  not found.\n' };
      },
    },
  });
  const wins = await x11(f).listWindows();
  assert.equal(wins.length, 6, 'panel filtered out');
  assert.ok(!wins.some((w) => w.id === '0x03a00003'));
  const first = wins[0];
  assert.deepEqual(first, { id: '0x0040000c', app: 'XTerm', title: 'root@vm: /tmp', pid: 2211, x: 399, y: 269, width: 484, height: 316, focused: true, minimized: false });
  assert.equal(wins.find((w) => w.id === '0x0060000c').minimized, true);
  assert.equal(wins.filter((w) => w.focused).length, 1);
  const wm = f.calls.find((c) => c.cmd === 'wmctrl');
  assert.equal(wm.opts.env.LC_ALL, 'C.UTF-8');
  assert.equal(f.calls.find((c) => c.cmd === 'xprop').opts.env.LC_ALL, 'C');
});

test('X11: listWindows tags windows with stackIndex from _NET_CLIENT_LIST_STACKING (LINUX-CONTEXT-4)', async () => {
  assert.deepEqual(L.parseClientListStacking('_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1a00003, 0x40000c, 0x0\n'), ['0x01a00003', '0x0040000c']);
  assert.deepEqual(L.parseClientListStacking('_NET_CLIENT_LIST_STACKING:  not found.\n'), []);
  const f = fake({
    env: { DISPLAY: ':42' },
    tools: ['wmctrl', 'xprop', 'xdotool'],
    responses: {
      'wmctrl -lpGx': { stdout: `${WMCTRL}\n` },
      'xdotool getactivewindow': { stdout: '4194316\n' },
      // bottom to top: 0x0060000c is at the bottom, 0x0040000c on top
      'xprop -root _NET_CLIENT_LIST_STACKING': { stdout: '_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x60000c, 0x3a00003, 0x40000c\n' },
      xprop: () => ({ stdout: '_NET_WM_STATE(ATOM) = \n_NET_WM_WINDOW_TYPE:  not found.\n' }),
    },
  });
  const wins = await x11(f).listWindows();
  const byId = new Map(wins.map((w) => [w.id, w]));
  assert.equal(byId.get('0x0040000c').stackIndex, 0, 'topmost');
  assert.equal(byId.get('0x0060000c').stackIndex, 2);
  const unlisted = wins.filter((w) => !['0x0040000c', '0x0060000c', '0x03a00003'].includes(w.id));
  assert.ok(unlisted.length > 0);
  assert.ok(unlisted.every((w) => !('stackIndex' in w)), 'windows missing from the stacking list have no stackIndex');
  const call = f.calls.find((c) => c.line === 'xprop -root _NET_CLIENT_LIST_STACKING');
  assert.equal(call.opts.env.LC_ALL, 'C');
  assert.equal(f.calls.filter((c) => c.line === 'xprop -root _NET_CLIENT_LIST_STACKING').length, 1, 'queried once');
  // desktop.js sorts by it: the topmost window is listed first even when another is focused.
  const desktop = require('../src/context/desktop');
  const shuffled = [...wins].reverse().map((w) => ({ ...w, focused: false }));
  const c = desktop.classifyWindows(shuffled, null);
  assert.equal(c.windows[0].title, byId.get('0x0040000c').title.trim());
});

test('X11: listWindows falls back to xdotool search without wmctrl', async () => {
  const geo = (x) => ({ stdout: `WINDOW=1\nX=${x}\nY=2\nWIDTH=300\nHEIGHT=200\nSCREEN=0\n` });
  const f = fake({
    tools: ['xdotool'],
    responses: {
      'xdotool search --onlyvisible --name .': { stdout: '100\n200\n100\n' },
      'xdotool getwindowname 100': { stdout: 'First window\n' },
      'xdotool getwindowname 200': { stdout: 'Second — ü\n' },
      'xdotool getwindowpid 100': { code: 1, stderr: 'window has no pid' },
      'xdotool getwindowpid 200': { stdout: `${process.pid}\n` },
      'xdotool getwindowgeometry --shell 100': geo(1),
      'xdotool getwindowgeometry --shell 200': geo(5),
      'xdotool getactivewindow': { stdout: '200\n' },
    },
  });
  const wins = await x11(f).listWindows();
  assert.equal(wins.length, 2);
  assert.deepEqual(wins[0], { id: '0x00000064', app: '', title: 'First window', pid: 0, x: 1, y: 2, width: 300, height: 200, focused: false, minimized: false });
  assert.equal(wins[1].id, '0x000000c8');
  assert.equal(wins[1].title, 'Second — ü');
  assert.equal(wins[1].focused, true);
  assert.equal(wins[1].pid, process.pid);
  // The app name is read from the real /proc/<pid>/comm of this test process. /proc is Linux-only
  // (this suite also runs on the macOS CI leg), and without it the driver leaves the name blank.
  let comm = '';
  try {
    comm = fs.readFileSync(`/proc/${process.pid}/comm`, 'utf8').trim();
  } catch {
    // no /proc on this platform
  }
  if (process.platform === 'linux') assert.ok(comm.length > 0 && wins[1].app.length > 0, 'app from /proc/<pid>/comm');
  assert.equal(wins[1].app, L.prettifyApp(comm), 'app from /proc/<pid>/comm');
});

test('X11: activeWindow via xprop, null when nothing is focused', async () => {
  const f = fake({
    tools: ['xdotool', 'xprop'],
    responses: {
      'xdotool getactivewindow': { stdout: '4194316\n' },
      'xprop -id 0x0040000c _NET_WM_NAME WM_NAME _NET_WM_PID WM_CLASS': {
        stdout: '_NET_WM_NAME:  not found.\nWM_NAME(STRING) = "\\303\\234n\\303\\257 test"\n_NET_WM_PID(CARDINAL) = 2211\nWM_CLASS(STRING) = "xterm", "XTerm"\n',
      },
    },
  });
  assert.deepEqual(await x11(f).activeWindow(), { id: '0x0040000c', app: 'XTerm', title: 'Ünï test', pid: 2211 });
  const g = fake({
    tools: ['xdotool', 'xprop'],
    responses: {
      'xdotool getactivewindow': { code: 1, stderr: 'Your windowmanager claims not to support _NET_ACTIVE_WINDOW' },
      'xprop -root _NET_ACTIVE_WINDOW': { stdout: '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\n' },
      'xdotool getwindowfocus': { stdout: '1\n' },
    },
  });
  assert.equal(await x11(g).activeWindow(), null);
});

test('X11: focus/minimize/topmost command shapes and missing windows', async () => {
  let active = '1';
  const f = fake({
    tools: ['wmctrl', 'xdotool', 'xprop'],
    responses: {
      'xprop -id 0x0040000c WM_CLASS': { stdout: 'WM_CLASS(STRING) = "xterm", "XTerm"\n' },
      'xprop -id 0x00abcdef WM_CLASS': { code: 1, stderr: 'BadWindow' },
      'wmctrl -i -a 0x0040000c': () => {
        active = '4194316';
        return {};
      },
      'xdotool getactivewindow': () => ({ stdout: `${active}\n` }),
      'xdotool windowminimize 4194316': {},
      'xprop -id 0x0040000c _NET_WM_STATE WM_STATE': { stdout: '_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN\n' },
      'wmctrl -i -r 0x0040000c -b add,above': {},
      'wmctrl -i -r 0x0040000c -b remove,above': {},
    },
  });
  const d = x11(f);
  assert.equal(await d.focusWindow(4194316), true);
  assert.equal(await d.focusWindow('0xabcdef'), false);
  assert.ok(!f.calls.some((c) => c.line === 'wmctrl -i -a 0x00abcdef'));
  assert.equal(await d.minimizeWindow('0x40000c'), true);
  assert.equal(await d.setTopmost('4194316', true), true);
  assert.equal(await d.setTopmost('4194316', false), true);
  assert.ok(f.calls.some((c) => c.line === 'wmctrl -i -r 0x0040000c -b remove,above'));
  await assert.rejects(d.focusWindow('not-an-id'), (e) => e.code === 'BAD_WINDOW_ID');
});

test('X11: minimizeWindow verifies the result and falls back to wmctrl', async () => {
  const f = fake({
    tools: ['wmctrl', 'xdotool', 'xprop'],
    responses: {
      'xdotool windowminimize 4194316': {},
      'wmctrl -i -r 0x0040000c -b add,hidden': {},
      'xprop -id 0x0040000c _NET_WM_STATE WM_STATE': { stdout: '_NET_WM_STATE(ATOM) = \nWM_STATE(WM_STATE):\n\t\twindow state: Normal\n' },
    },
  });
  assert.equal(await x11(f).minimizeWindow('0x0040000c'), false);
  assert.ok(f.calls.some((c) => c.line === 'wmctrl -i -r 0x0040000c -b add,hidden'));
  const g = fake({
    tools: ['xdotool', 'xprop'],
    responses: {
      'xdotool windowminimize 4194316': {},
      'xprop -id 0x0040000c _NET_WM_STATE WM_STATE': { stdout: 'WM_STATE(WM_STATE):\n\t\twindow state: Iconic\n' },
    },
  });
  assert.equal(await x11(g).minimizeWindow(4194316), true);
  const h = fake({ tools: ['xdotool'], responses: { 'xdotool windowminimize 4194316': {} } });
  assert.equal(await x11(h).minimizeWindow(4194316), true, 'unverified success without xprop');
});

test('X11: clipboardGet tries UTF8_STRING, then plain, and treats an empty selection as ""', async () => {
  const f = fake({ tools: ['xclip'], responses: { 'xclip -selection clipboard -o -t UTF8_STRING': { stdout: 'héllo 🎉' } } });
  assert.equal(await x11(f).clipboardGet(), 'héllo 🎉');
  const g = fake({ tools: ['xclip'], responses: { xclip: { code: 1, stderr: 'Error: target STRING not available' } } });
  assert.equal(await x11(g).clipboardGet(), '');
  assert.equal(g.calls.length, 2);
  const h = fake({ tools: ['xsel'], responses: { 'xsel -b -o': { stdout: 'from xsel' } } });
  assert.equal(await x11(h).clipboardGet(), 'from xsel');
});

/** Fake child_process.spawn for clipboard setters. */
function fakeSpawn(onFinish) {
  const spawned = [];
  const spawnFn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    const rec = { cmd, args, opts, data: '', unrefed: false };
    child.unref = () => {
      rec.unrefed = true;
    };
    child.stdin.on('data', (d) => {
      rec.data += d.toString('utf8');
    });
    child.stdin.on('finish', () => onFinish(child));
    spawned.push(rec);
    return child;
  };
  return { spawnFn, spawned };
}

test('X11: clipboardSet ignores stdout/stderr, resolves on exit, never waits for close', async () => {
  const text = 'héllo 漢字 🎉\nline 2';
  const quick = fakeSpawn((child) => setImmediate(() => child.emit('exit', 0, null)));
  await x11(fake({ tools: ['xclip'] }), { spawn: quick.spawnFn }).clipboardSet(text);
  assert.equal(quick.spawned.length, 1);
  assert.equal(quick.spawned[0].cmd, 'xclip');
  assert.deepEqual(quick.spawned[0].args, ['-selection', 'clipboard', '-i']);
  assert.deepEqual(quick.spawned[0].opts.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(quick.spawned[0].opts.detached, true);
  assert.equal(quick.spawned[0].data, text);
  assert.equal(quick.spawned[0].unrefed, true);

  const never = fakeSpawn(() => {});
  const t0 = Date.now();
  await x11(fake({ tools: ['xsel'] }), { spawn: never.spawnFn }).clipboardSet('x');
  const dt = Date.now() - t0;
  assert.ok(dt >= 900 && dt < 3000, `grace period resolve took ${dt} ms`);
  assert.deepEqual(never.spawned[0].args, ['-b', '-i']);

  const failing = fakeSpawn((child) => child.emit('exit', 1, null));
  await assert.rejects(x11(fake({ tools: ['xclip'] }), { spawn: failing.spawnFn }).clipboardSet('x'), /exited with code 1/);

  const missing = fakeSpawn(() => {});
  const spawnEnoent = (...a) => {
    const c = missing.spawnFn(...a);
    setImmediate(() => c.emit('error', Object.assign(new Error('spawn xclip ENOENT'), { code: 'ENOENT' })));
    return c;
  };
  await assert.rejects(x11(fake({ tools: ['xclip'] }), { spawn: spawnEnoent }).clipboardSet('x'), (e) => e.code === 'UNSUPPORTED');
});

test('X11: clipboardSet with a real forking child resolves on exit', { skip: process.platform === 'win32' && 'POSIX shell needed' }, async () => {
  const out = path.join(os.tmpdir(), `anywhere-clip-${process.pid}-${Date.now()}.txt`);
  // Emulates xclip: reads stdin, leaves a background child running, parent exits.
  const spawnFn = (cmd, args, opts) => spawn('sh', ['-c', 'cat > "$0"; (sleep 3 &) ; exit 0', out], opts);
  try {
    const t0 = Date.now();
    await x11(fake({ tools: ['xclip'] }), { spawn: spawnFn }).clipboardSet('añb 🎉');
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(fs.readFileSync(out, 'utf8'), 'añb 🎉');
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test('X11: capabilities report missing tools with a package-manager install hint', async () => {
  const f = fake({ tools: ['apt-get'] });
  const caps = await x11(f).capabilities();
  for (const k of ['screenshot', 'mouse', 'keyboard', 'windows', 'clipboard', 'notify', 'speak']) assert.equal(caps[k], false, k);
  assert.equal(caps.install, 'sudo apt install imagemagick xdotool wmctrl xclip x11-xserver-utils libnotify-bin espeak-ng');
  assert.ok(caps.notes.some((n) => n.startsWith('Install missing tools: sudo apt install')));
  const g = fake({
    tools: ['xdotool', 'wmctrl', 'xclip', 'xrandr', 'xprop', 'import', 'notify-send', 'espeak-ng', 'apt-get'],
    responses: { 'xdotool getdisplaygeometry': { stdout: '800 600\n' } },
  });
  const ok = await x11(g).capabilities();
  for (const k of ['screenshot', 'mouse', 'keyboard', 'windows', 'clipboard', 'notify', 'speak']) assert.equal(ok[k], true, k);
  assert.equal(ok.install, '');
  const h = fake({ tools: ['xdotool'], responses: { 'xdotool getdisplaygeometry': { code: 1, stderr: "Can't open display" } } });
  const bad = await x11(h).capabilities();
  assert.equal(bad.mouse, false);
  assert.ok(bad.notes.some((n) => /Cannot open X display/.test(n)));
});

// ---------------------------------------------------------------------------
// Wayland driver with injected run/which
// ---------------------------------------------------------------------------

function wl(f) {
  return L.createDriver({ displayServer: 'wayland', run: f.run, which: f.which, env: f.env });
}

test('Wayland/sway: outputs, grim per output, windows, focus, pointer and keys', async () => {
  const png = makePng(32, 20);
  const f = fake({
    env: { SWAYSOCK: '/run/user/1000/sway.sock', WAYLAND_DISPLAY: 'wayland-1' },
    tools: ['swaymsg', 'grim', 'wtype', 'wl-copy', 'wl-paste'],
    responses: {
      'swaymsg -t get_outputs -r': { stdout: SWAY_OUTPUTS },
      'swaymsg -t get_tree -r': { stdout: SWAY_TREE },
      grim: { stdout: png },
      swaymsg: { stdout: '[ { "success": true } ]' },
      wtype: {},
      'wl-paste -n': { code: 1, stderr: 'Nothing is copied' },
    },
  });
  const d = wl(f);
  assert.equal(d.compositor, 'sway');
  const ds = await d.displays();
  assert.equal(ds.length, 2);
  const shot = await d.captureDisplay(1);
  assert.equal(shot.width, 32);
  assert.deepEqual(f.calls.find((c) => c.cmd === 'grim').args, ['-o', 'HDMI-A-1', '-']);
  const wins = await d.listWindows();
  assert.equal(wins.length, 3);
  assert.deepEqual(await d.activeWindow(), { id: '12', app: 'Visual Studio Code', title: 'main.js - repo - Visual Studio Code', pid: 0 });
  assert.equal(await d.focusWindow('14'), true);
  assert.ok(f.calls.some((c) => c.line === 'swaymsg [con_id=14] focus'));
  assert.equal(await d.minimizeWindow(14), true);
  assert.ok(f.calls.some((c) => c.line === 'swaymsg [con_id=14] move scratchpad'));
  await assert.rejects(d.focusWindow('0xabc'), (e) => e.code === 'BAD_WINDOW_ID');
  assert.equal(await d.setTopmost('14', true), false);

  await d.moveMouse(100, 200);
  assert.equal(f.calls.at(-1).line, 'swaymsg seat - cursor set 100 200');
  assert.deepEqual(await d.cursorPosition(), { x: 100, y: 200, estimated: true }, 'sway cannot report the pointer: the last move is an estimate');
  await d.click(null, null, { clicks: 2 });
  assert.equal(f.calls.at(-1).args[0], 'seat - cursor press button1; seat - cursor release button1; seat - cursor press button1; seat - cursor release button1');
  await d.scroll(null, null, 0, 2);
  assert.equal(f.calls.at(-1).args[0], 'seat - cursor press button5; seat - cursor press button5');
  await d.keyCombo(['ctrl', 'c']);
  assert.equal(f.calls.at(-1).line, 'wtype -M ctrl -k c -m ctrl');
  await d.typeText('-x\ny');
  assert.deepEqual(f.calls.at(-1).args, ['-d', '5', '-k', 'minus', 'x', '-k', 'Return', 'y']);
  assert.equal(await d.clipboardGet(), '');
  const before = f.calls.length;
  await d.drag(10, 10, 50, 50);
  const presses = f.calls.slice(before).filter((c) => c.cmd === 'swaymsg' && /cursor (press|release) button1$/.test(c.args[0]));
  assert.deepEqual(presses.map((c) => c.args[0].split(' ')[3]), ['press', 'release']);
});

test('Wayland/hyprland: monitors, clients, dispatch focus, pin, cursorpos', async () => {
  const clients = [
    { address: '0xa1', mapped: true, at: [0, 0], size: [800, 600], workspace: { name: '1' }, class: 'kitty', title: 'term', pid: 5, floating: false, pinned: false },
  ];
  const f = fake({
    env: { HYPRLAND_INSTANCE_SIGNATURE: 'abc', WAYLAND_DISPLAY: 'wayland-1' },
    tools: ['hyprctl', 'ydotool'],
    responses: {
      'hyprctl monitors -j': { stdout: JSON.stringify([{ name: 'DP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1, transform: 0 }]) },
      'hyprctl clients -j': { stdout: JSON.stringify(clients) },
      'hyprctl activewindow -j': { stdout: JSON.stringify(clients[0]) },
      'hyprctl cursorpos': { stdout: '321, 654\n' },
      'hyprctl dispatch focuswindow address:0xa1': { stdout: 'ok\n' },
      'hyprctl dispatch setfloating address:0xa1': { stdout: 'ok\n' },
      'hyprctl dispatch pin address:0xa1': { stdout: 'ok\n' },
      'hyprctl dispatch movecursor 10 20': { stdout: 'ok\n' },
      ydotool: {},
    },
  });
  const d = wl(f);
  assert.equal(d.compositor, 'hyprland');
  assert.equal((await d.displays())[0].id, 'DP-1');
  const wins = await d.listWindows();
  assert.equal(wins[0].focused, true);
  assert.deepEqual(await d.activeWindow(), { id: '0xa1', app: 'kitty', title: 'term', pid: 5 });
  assert.equal(await d.focusWindow('0xa1'), true);
  assert.equal(await d.setTopmost('0xa1', true), true);
  assert.ok(f.calls.some((c) => c.line === 'hyprctl dispatch pin address:0xa1'));
  assert.deepEqual(await d.cursorPosition(), { x: 321, y: 654 });
  await d.moveMouse(10, 20);
  assert.ok(!f.calls.some((c) => c.cmd === 'ydotool'), 'movecursor used instead of ydotool');
  await d.click(null, null, { button: 'right' });
  assert.equal(f.calls.at(-1).line, 'ydotool click -D 80 0xC1');
  await d.scroll(null, null, 1, 3);
  assert.equal(f.calls.at(-1).line, 'ydotool mousemove --wheel -x 1 -y -3');
  await d.keyCombo('ctrl+v');
  assert.equal(f.calls.at(-1).line, 'ydotool key 29:1 47:1 47:0 29:0');
  await d.click(null, null, { modifiers: ['shift'] });
  const last3 = f.calls.slice(-3).map((c) => c.line);
  assert.deepEqual(last3, ['ydotool key 42:1', 'ydotool click -D 80 0xC0', 'ydotool key 42:0']);
});

test('Wayland/GNOME: windows unsupported with hint, ydotool keyboard, daemon errors explained', async () => {
  const f = fake({
    env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', WAYLAND_DISPLAY: 'wayland-0' },
    tools: ['gnome-screenshot', 'ydotool', 'wtype', 'apt-get'],
    responses: {
      'ydotool key 29:1 46:1 46:0 29:0': {},
      'ydotool mousemove --absolute -x 5 -y 6': { code: 2, stderr: "failed to connect socket `/tmp/.ydotool_socket': No such file or directory" },
      'gnome-screenshot': async (args) => {
        fs.writeFileSync(args[1], makePng(40, 30));
        return {};
      },
    },
  });
  const d = wl(f);
  assert.equal(d.compositor, 'gnome');
  await assert.rejects(d.listWindows(), (e) => e.code === 'UNSUPPORTED' && /GNOME on Xorg/.test(e.hint));
  await assert.rejects(d.focusWindow('1'), (e) => e.code === 'UNSUPPORTED');
  assert.equal(await d.activeWindow(), null);
  assert.equal(await d.setTopmost('1', true), false);
  await d.keyCombo(['ctrl', 'c']);
  assert.ok(!f.calls.some((c) => c.cmd === 'wtype'), 'wtype is not used on GNOME');
  const ds = await d.displays();
  assert.deepEqual(ds, [{ index: 0, id: 'screen', x: 0, y: 0, width: 40, height: 30, scale: 1, primary: true }]);
  const shot = await d.captureDisplay(0);
  assert.equal(shot.width, 40);
  await assert.rejects(d.moveMouse(5, 6), (e) => e.code === 'UNSUPPORTED' && /ydotoold/.test(e.hint));
  const caps = await d.capabilities();
  assert.equal(caps.windows, false);
  assert.equal(caps.screenshot, true);
  assert.ok(caps.notes.some((n) => /GNOME on Xorg/.test(n)));
  assert.ok(caps.notes.some((n) => /ydotoold socket not found|ydotool/.test(n)));
});

test('Wayland: when wtype stops working mid-text, ydotool continues without retyping', async () => {
  let wtypeCalls = 0;
  const f = fake({
    env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' },
    tools: ['wtype', 'ydotool'],
    responses: {
      wtype: () => (++wtypeCalls === 1 ? {} : { code: 1, stderr: 'Compositor does not support the virtual keyboard protocol' }),
      ydotool: {},
    },
  });
  const d = wl(f);
  await d.typeText(`${'a'.repeat(200)}${'b'.repeat(50)}`);
  const ydo = f.calls.filter((c) => c.cmd === 'ydotool' && c.args[0] !== 'help');
  assert.equal(ydo.length, 1);
  assert.deepEqual(ydo[0].args, ['type', '-d', '8', '--', 'b'.repeat(50)]);
  await d.keyCombo(['ctrl', 'a']);
  assert.equal(f.calls.at(-1).line, 'ydotool key 29:1 30:1 30:0 29:0', 'wtype is not retried once broken');
  assert.equal(wtypeCalls, 2);
});

test('Wayland: no tools at all → UNSUPPORTED everywhere with hints', async () => {
  const f = fake({ env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'river' }, tools: ['pacman'] });
  const d = wl(f);
  await assert.rejects(d.captureDisplay(0), (e) => e.code === 'UNSUPPORTED');
  await assert.rejects(d.typeText('hi'), (e) => e.code === 'UNSUPPORTED' && /pacman -S wtype ydotool/.test(e.hint));
  await assert.rejects(d.clipboardGet(), (e) => e.code === 'UNSUPPORTED' && /wl-clipboard/.test(e.hint));
  await assert.rejects(d.click(1, 1), (e) => e.code === 'UNSUPPORTED');
  const caps = await d.capabilities();
  assert.equal(caps.screenshot, false);
  assert.equal(caps.mouse, false);
  assert.match(caps.install, /^sudo pacman -S /);
});

// ---------------------------------------------------------------------------
// Live X11 (Xvfb + openbox + xterm)
// ---------------------------------------------------------------------------

const LIVE_TOOLS = ['Xvfb', 'openbox', 'xdotool', 'wmctrl', 'xclip', 'xterm'];
const missingLive = process.platform === 'linux' ? LIVE_TOOLS.filter((t) => !proc.which(t)) : LIVE_TOOLS;

function findFreeDisplay() {
  for (let n = 97; n < 160; n++) {
    if (!fs.existsSync(`/tmp/.X${n}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${n}`)) return n;
  }
  throw new Error('no free X display number');
}

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  let lastErr = null;
  while (Date.now() < until) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ''}`);
}

function killAndWait(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

test('live X11: Xvfb + openbox + xterm end to end', { skip: missingLive.length ? `missing ${missingLive.join(', ')}` : false, timeout: 120000 }, async (t) => {
  const procs = [];
  const savedDisplay = process.env.DISPLAY;
  const marker = path.join(os.tmpdir(), `anywhere-linux-live-${process.pid}-${Date.now()}.txt`);
  const n = findFreeDisplay();
  const dpy = `:${n}`;
  try {
    const xvfb = spawn('Xvfb', [dpy, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    procs.push(xvfb);
    await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${n}`), 10000, 'Xvfb socket');
    process.env.DISPLAY = dpy;
    const env = { ...process.env, DISPLAY: dpy };
    procs.push(spawn('openbox', [], { stdio: 'ignore', env }));
    await waitFor(async () => (await proc.run('wmctrl', ['-m'], { env, timeoutMs: 2000 })).code === 0, 10000, 'openbox');
    procs.push(
      spawn('xterm', ['-xrm', 'XTerm*allowTitleOps: false', '-T', 'AnywhereLinuxTest', '-geometry', '80x24+40+40', '-e', 'sh'], {
        stdio: 'ignore',
        env: { ...env, PS1: '$ ', ENV: '' },
      }),
    );

    const driver = L.createDriver({ displayServer: 'x11' });
    let term = null;
    await waitFor(async () => {
      term = (await driver.listWindows()).find((w) => w.title === 'AnywhereLinuxTest') || null;
      return Boolean(term);
    }, 15000, 'xterm window');

    await t.test('capabilities', async () => {
      const caps = await driver.capabilities();
      for (const k of ['screenshot', 'mouse', 'keyboard', 'windows', 'clipboard']) assert.equal(caps[k], true, `${k}: ${caps.notes.join(' | ')}`);
    });

    await t.test('displays', async () => {
      const ds = await driver.displays();
      assert.ok(ds.length >= 1);
      assert.deepEqual({ ...ds[0], id: undefined }, { index: 0, id: undefined, x: 0, y: 0, width: 1280, height: 800, scale: 1, primary: true });
    });

    await t.test('captureDisplay returns a valid 1280x800 PNG (and each installed tool works)', async () => {
      const shot = await driver.captureDisplay(0);
      assert.equal(shot.width, 1280);
      assert.equal(shot.height, 800);
      assert.ok(shot.png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
      assert.deepEqual(L.pngInfo(shot.png), { width: 1280, height: 800 });
      const support = ['xdotool', 'xwininfo', 'convert'];
      for (const tool of ['import', 'ffmpeg', 'xwd', 'maim', 'scrot']) {
        if (!proc.which(tool) || (tool === 'xwd' && !proc.which('convert'))) continue;
        const only = L.createDriver({ displayServer: 'x11', which: (name) => (name === tool || support.includes(name) ? proc.which(name) : null) });
        const s = await only.captureDisplay(0);
        assert.deepEqual([s.width, s.height], [1280, 800], tool);
        assert.ok(L.pngInfo(s.png), tool);
      }
    });

    await t.test('moveMouse and cursorPosition (including a no-op move)', async () => {
      await driver.moveMouse(700, 500);
      assert.deepEqual(await driver.cursorPosition(), { x: 700, y: 500 });
      const t0 = Date.now();
      await driver.moveMouse(700, 500);
      assert.ok(Date.now() - t0 < 1500, 'same-position move must not hang');
      await driver.moveMouse(99999, -50);
      assert.deepEqual(await driver.cursorPosition(), { x: 1279, y: 0 });
    });

    await t.test('click, mouseDown/mouseUp on the empty desktop', async () => {
      await driver.click(1100, 700, { modifiers: ['shift'] });
      await driver.click(1100, 700, { clicks: 2 });
      await driver.mouseDown('left');
      await driver.mouseUp('left');
      assert.deepEqual(await driver.cursorPosition(), { x: 1100, y: 700 });
    });

    await t.test('listWindows finds the xterm', async () => {
      const wins = await driver.listWindows();
      const w = wins.find((x) => x.title === 'AnywhereLinuxTest');
      assert.ok(w);
      assert.match(w.id, /^0x[0-9a-f]{8}$/);
      assert.equal(w.app, 'XTerm');
      assert.ok(w.pid > 0);
      assert.ok(w.width > 100 && w.height > 100);
      assert.equal(w.minimized, false);
      if (proc.which('xwininfo')) {
        // The client's true origin, not wmctrl's (which adds the title-bar offset inside the frame).
        const info = await proc.run('xwininfo', ['-id', w.id], { env });
        const ax = /Absolute upper-left X:\s*(-?\d+)/.exec(info.stdout);
        const ay = /Absolute upper-left Y:\s*(-?\d+)/.exec(info.stdout);
        assert.deepEqual([w.x, w.y], [+ax[1], +ay[1]]);
      }
    });

    await t.test('focusWindow and activeWindow', async () => {
      assert.equal(await driver.focusWindow(term.id), true);
      const a = await driver.activeWindow();
      assert.equal(a.id, term.id);
      assert.equal(a.app, 'XTerm');
      assert.equal(a.title, 'AnywhereLinuxTest');
      assert.ok(a.pid > 0);
      const focused = (await driver.listWindows()).find((w) => w.id === term.id);
      assert.equal(focused.focused, true);
      assert.equal(await driver.focusWindow(parseInt(term.id, 16)), true, 'decimal id accepted');
    });

    await t.test('typeText + keyCombo(enter) runs a shell command in the xterm', async () => {
      await driver.focusWindow(term.id);
      await driver.typeText(`echo anywhere-ok > ${marker}`);
      await driver.keyCombo(['enter']);
      await waitFor(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === 'anywhere-ok', 8000, 'marker file');
    });

    await t.test('typeText with non-ASCII text works even without a UTF-8 locale', async () => {
      const noLocale = { ...process.env, DISPLAY: dpy };
      for (const k of ['LANG', 'LC_ALL', 'LC_CTYPE']) delete noLocale[k];
      const c = L.createDriver({ displayServer: 'x11', env: noLocale });
      await driver.focusWindow(term.id);
      await c.typeText('naïve ☕ -x');
      await c.keyCombo(['ctrl', 'u']);
    });

    await t.test('clipboard roundtrip with unicode', async () => {
      const text = 'héllo 漢字 🎉 — anywhere\nsecond line';
      await driver.clipboardSet(text);
      assert.equal(await driver.clipboardGet(), text);
      await driver.clipboardSet('');
      assert.equal(await driver.clipboardGet(), '');
    });

    await t.test('drag and scroll', async () => {
      await driver.drag(700, 450, 900, 650);
      assert.deepEqual(await driver.cursorPosition(), { x: 900, y: 650 });
      // Scroll over the xterm (openbox switches desktops when the wheel turns over the root window).
      const cx = term.x + Math.round(term.width / 2);
      const cy = term.y + Math.round(term.height / 2);
      await driver.scroll(cx, cy, 0, 3);
      await driver.scroll(cx, cy, 2, 0);
      await driver.scroll(null, null, -1, -2);
      assert.deepEqual(await driver.cursorPosition(), { x: cx, y: cy });
    });

    await t.test('setTopmost and minimizeWindow', async () => {
      assert.equal(await driver.focusWindow(term.id), true);
      assert.equal(await driver.setTopmost(term.id, true), true);
      const st = await proc.run('xprop', ['-id', term.id, '_NET_WM_STATE'], { env });
      if (proc.which('xprop')) assert.match(st.stdout, /_NET_WM_STATE_ABOVE/);
      assert.equal(await driver.setTopmost(term.id, false), true);
      assert.equal(await driver.minimizeWindow(term.id), true);
      if (proc.which('xprop')) {
        await waitFor(async () => (await driver.listWindows()).find((w) => w.id === term.id).minimized, 3000, 'minimized state');
      }
      assert.equal(await driver.focusWindow(term.id), true);
      assert.equal(await driver.focusWindow('0x0fffffff'), false);
    });
  } finally {
    for (const p of procs.reverse()) await killAndWait(p);
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    fs.rmSync(marker, { force: true });
  }
});
