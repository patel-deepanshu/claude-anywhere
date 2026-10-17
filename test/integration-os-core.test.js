'use strict';

// End-to-end: getDriver() → real Linux X11 backend → Computer. Runs only when a
// display, xdotool and src/os/linux.js are all present.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hasLinuxBackend = fs.existsSync(path.join(__dirname, '..', 'src', 'os', 'linux.js'));
const hasXdotool = spawnSync('xdotool', ['version'], { encoding: 'utf8' }).status === 0;
const skip =
  process.platform !== 'linux'
    ? 'Linux only'
    : !process.env.DISPLAY
      ? 'DISPLAY is not set'
      : !hasXdotool
        ? 'xdotool is not installed'
        : !hasLinuxBackend
          ? 'src/os/linux.js not written yet'
          : false;

test('real X11 driver: screenshot mapping, mouse move and region zoom', { skip }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-int-'));
  const prevHome = process.env.ANYWHERE_HOME;
  const prevDriver = process.env.ANYWHERE_DRIVER;
  process.env.ANYWHERE_HOME = home;
  delete process.env.ANYWHERE_DRIVER;
  const osIndex = require('../src/os/index');
  const png = require('../src/os/png');
  const { Computer } = require('../src/os/computer');
  await osIndex.resetDriver();
  const driver = await osIndex.getDriver();
  t.after(async () => {
    await osIndex.resetDriver();
    if (prevHome === undefined) delete process.env.ANYWHERE_HOME;
    else process.env.ANYWHERE_HOME = prevHome;
    if (prevDriver !== undefined) process.env.ANYWHERE_DRIVER = prevDriver;
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.notEqual(driver.name, 'unsupported', driver.reason);
  const original = await driver.cursorPosition();
  t.after(() => driver.moveMouse(original.x, original.y).catch(() => {}));

  const computer = new Computer({ driver, config: { actionDelayMs: 50, failsafe: false }, platform: 'linux' });
  const shot = await computer.screenshot();
  const hdr = png.readHeader(shot.png);
  assert.deepEqual([hdr.width, hdr.height], [shot.width, shot.height]);
  assert.ok(shot.width <= 1366 && shot.height <= 768);

  const cx = Math.floor(shot.width / 2);
  const cy = Math.floor(shot.height / 2);
  const moved = await computer.moveMouse({ x: cx, y: cy });
  const real = await driver.cursorPosition();
  assert.ok(Math.abs(real.x - moved.logical.x) <= 1 && Math.abs(real.y - moved.logical.y) <= 1, JSON.stringify({ real, moved }));
  const pos = await computer.cursorPosition();
  assert.ok(Math.abs(pos.x - cx) <= 1 && Math.abs(pos.y - cy) <= 1);

  const zoom = await computer.screenshot({ region: { x: 10, y: 10, width: 100, height: 60 } });
  assert.deepEqual(zoom.region, { x: 10, y: 10, width: 100, height: 60 });
  assert.ok(zoom.width >= 100 && zoom.scale <= shot.scale + 1e-9);
});
