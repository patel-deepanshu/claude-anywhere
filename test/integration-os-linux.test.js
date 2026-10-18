'use strict';

// Integration checks between src/os/linux.js and the modules other engineers own
// (png.js, keys.js, index.js). Each test skips itself when its module is absent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const L = require('../src/os/linux');

const OS_DIR = path.join(__dirname, '..', 'src', 'os');
const has = (name) => fs.existsSync(path.join(OS_DIR, `${name}.js`));

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

test('png.js: full-root scrot capture is cropped to the requested monitor', { skip: !has('png') && 'src/os/png.js not present yet' }, async () => {
  const png = require('../src/os/png');
  const W = 96;
  const H = 48;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = x;
      data[i + 1] = y;
      data[i + 2] = x >= 64 ? 200 : 10;
      data[i + 3] = 255;
    }
  }
  const root = png.encode({ width: W, height: H, data });
  const f = fake({
    tools: ['xrandr', 'scrot'],
    responses: {
      'xrandr --query': { stdout: 'A connected primary 64x48+0+0 (normal) 0mm x 0mm\nB connected 32x24+64+12 (normal) 0mm x 0mm\n' },
      scrot: async (args) => {
        fs.writeFileSync(args[0], root);
        return {};
      },
    },
  });
  const d = L.createDriver({ displayServer: 'x11', run: f.run, which: f.which, env: f.env });
  const shot = await d.captureDisplay(1);
  assert.equal(shot.width, 32);
  assert.equal(shot.height, 24);
  const img = png.decode(shot.png);
  assert.deepEqual(Array.from(img.data.slice(0, 4)), [64, 12, 200, 255]);
  const last = (img.width * img.height - 1) * 4;
  assert.deepEqual(Array.from(img.data.slice(last, last + 4)), [95, 35, 200, 255]);
  const primary = await d.captureDisplay(0);
  assert.equal(primary.width, 64);
  assert.equal(png.decode(primary.png).data[2], 10);
});

test('keys.js: combos route through normalizeCombo/toXdotool/toEvdev', { skip: !has('keys') && 'src/os/keys.js not present yet' }, async () => {
  const f = fake({ tools: ['xdotool'], responses: { xdotool: {} } });
  const d = L.createDriver({ displayServer: 'x11', run: f.run, which: f.which, env: f.env });
  await d.keyCombo('Primary+Shift+PgUp');
  assert.equal(f.calls.at(-1).line, 'xdotool key --clearmodifiers ctrl+shift+Prior');
  await assert.rejects(d.keyCombo('ctrl+nosuchkey'), /nosuchkey/);
  const w = fake({ env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' }, tools: ['ydotool'], responses: { ydotool: {} } });
  const wd = L.createDriver({ displayServer: 'wayland', run: w.run, which: w.which, env: w.env });
  await wd.keyCombo(['ctrl', 'shift', 't']);
  assert.equal(w.calls.at(-1).line, 'ydotool key 29:1 42:1 20:1 20:0 42:0 29:0');
});

test('index.js: ANYWHERE_DRIVER=x11/wayland loads this driver with every DRIVER_METHOD', { skip: !has('index') && 'src/os/index.js not present yet' }, async () => {
  const index = require('../src/os/index');
  for (const forced of ['x11', 'wayland']) {
    const sel = index.selectBackend({ platform: 'linux', isWSL: false, displayServer: 'none' }, { ANYWHERE_DRIVER: forced });
    assert.equal(sel.backend, 'linux');
    const mod = require(path.join(OS_DIR, sel.module));
    const driver = await mod.createDriver(sel.opts);
    assert.equal(driver.name, `linux-${forced}`);
    for (const m of [...(index.DRIVER_METHODS || []), 'capabilities', 'close']) {
      assert.equal(typeof driver[m], 'function', `${forced}: ${m}`);
    }
  }
});
