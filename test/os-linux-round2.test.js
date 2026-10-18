'use strict';

// Round-2 regression tests for the os-linux group (JOURNEYS-DOCS-3).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const zlib = require('zlib');

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

/** Smallest valid PNG of the given size (only its header matters to the driver). */
function tinyPng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FAILSAFE_NOTE = /pointer position cannot be read on (\w+) Wayland.*top-left-corner failsafe is unavailable.*Esc.*Stop.*"stop"/;

// ---------------------------------------------------------------------------
// JOURNEYS-DOCS-3: a Wayland pointer position that was not read is marked estimated
// ---------------------------------------------------------------------------

test('Wayland/GNOME: cursorPosition is marked estimated (display centre, then the last move), never a real reading', async () => {
  const f = fake({
    env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', WAYLAND_DISPLAY: 'wayland-0' },
    tools: ['gnome-screenshot', 'ydotool'],
    responses: {
      'gnome-screenshot': async (args) => {
        fs.writeFileSync(args[1], tinyPng(1920, 1080));
        return {};
      },
      ydotool: {},
    },
  });
  const d = wl(f);
  assert.equal(d.compositor, 'gnome');
  // Before any move: the made-up display centre must say it is made up.
  assert.deepEqual(await d.cursorPosition(), { x: 960, y: 540, estimated: true });
  // After Claude's own move into the corner the position is still only an estimate: the user may have moved
  // the pointer since, and a caller must not treat it as where the user put the pointer.
  await d.moveMouse(0, 0);
  assert.ok(f.calls.some((c) => c.line === 'ydotool mousemove --absolute -x 0 -y 0'));
  const pos = await d.cursorPosition();
  assert.deepEqual(pos, { x: 0, y: 0, estimated: true });
  pos.x = 99;
  assert.deepEqual(await d.cursorPosition(), { x: 0, y: 0, estimated: true }, 'callers get a copy');
  // A relative ydotool drag updates the estimate too.
  await d.drag(10, 10, 110, 60);
  assert.deepEqual(await d.cursorPosition(), { x: 110, y: 60, estimated: true });
  assert.ok(!f.calls.some((c) => c.cmd === 'hyprctl'), 'no compositor pointer query exists on GNOME');
});

test('Wayland/hyprland: a real hyprctl reading is not estimated; a failed reading falls back to an estimate', async () => {
  let cursorOk = true;
  const f = fake({
    env: { HYPRLAND_INSTANCE_SIGNATURE: 'abc', WAYLAND_DISPLAY: 'wayland-1' },
    tools: ['hyprctl', 'ydotool'],
    responses: {
      'hyprctl monitors -j': { stdout: JSON.stringify([{ name: 'DP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1, transform: 0 }]) },
      'hyprctl cursorpos': () => (cursorOk ? { stdout: '3, 4\n' } : { code: 1, stderr: 'HYPRLAND_INSTANCE_SIGNATURE invalid' }),
      'hyprctl dispatch movecursor 50 60': { stdout: 'ok\n' },
      ydotool: {},
    },
  });
  const d = wl(f);
  assert.equal(d.compositor, 'hyprland');
  const real = await d.cursorPosition();
  assert.deepEqual(real, { x: 3, y: 4 });
  assert.equal('estimated' in real, false, 'a real reading carries no estimated flag, so the failsafe applies');
  await d.moveMouse(50, 60);
  cursorOk = false;
  assert.deepEqual(await d.cursorPosition(), { x: 50, y: 60, estimated: true });
  const caps = await d.capabilities();
  assert.ok(!caps.notes.some((n) => FAILSAFE_NOTE.test(n)), caps.notes.join(' | '));
});

test('Wayland capabilities: GNOME, KDE and sway say the corner failsafe is unavailable and how to stop instead', async () => {
  const cases = [
    { env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', WAYLAND_DISPLAY: 'wayland-0' }, tools: ['ydotool'], compositor: 'gnome' },
    { env: { XDG_CURRENT_DESKTOP: 'KDE', WAYLAND_DISPLAY: 'wayland-0' }, tools: ['ydotool', 'wtype'], compositor: 'kde' },
    // sway can move the pointer (`seat - cursor set`) but has no IPC to read it back.
    { env: { SWAYSOCK: '/run/user/1000/sway-ipc.sock', WAYLAND_DISPLAY: 'wayland-1' }, tools: ['swaymsg', 'grim', 'wtype'], compositor: 'sway' },
  ];
  for (const c of cases) {
    const d = wl(fake({ env: c.env, tools: c.tools, responses: { ydotool: {}, swaymsg: { stdout: '[]' } } }));
    assert.equal(d.compositor, c.compositor);
    const caps = await d.capabilities();
    const note = caps.notes.find((n) => FAILSAFE_NOTE.test(n));
    assert.ok(note, `${c.compositor}: ${caps.notes.join(' | ')}`);
    assert.equal(FAILSAFE_NOTE.exec(note)[1], c.compositor);
  }
});
