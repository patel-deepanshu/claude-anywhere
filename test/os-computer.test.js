'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep all state (geometry files) away from the real ~/.claude-anywhere.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-computer-'));
process.env.ANYWHERE_HOME = HOME;
test.after(() => fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const png = require('../src/os/png');
const paths = require('../src/shared/paths');
const osIndex = require('../src/os/index');
const { Computer } = require('../src/os/computer');

const { createMockDriver } = osIndex;

function make(opts = {}) {
  const driver = opts.driver || createMockDriver(opts.mock);
  const computer = new Computer({
    driver,
    config: { actionDelayMs: 0, ...(opts.config || {}) },
    guard: opts.guard,
    geometryStore: opts.geometryStore || 'memory',
    platform: opts.platform || 'linux',
  });
  return { driver, computer };
}

const last = (driver, type) => driver.actions.filter((a) => a.type === type).pop();

function pixelAt(pngBuf, x, y) {
  const img = png.decode(pngBuf);
  const o = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(o, o + 4));
}

// ------------------------------------------------------------ mapping

test('full screenshot of display 0: size, scale, cursor and click mapping', async () => {
  const { driver, computer } = make({ mock: { cursor: { x: 960, y: 540 } } });
  const shot = await computer.screenshot();
  assert.equal(shot.display, 0);
  assert.equal(shot.displays, 2);
  assert.equal(shot.width, 1365);
  assert.equal(shot.height, 768);
  assert.deepEqual(shot.native, { width: 1920, height: 1080 });
  assert.equal(shot.region, null);
  assert.ok(Math.abs(shot.scale - 1920 / 1365) < 1e-9);
  assert.deepEqual(shot.cursor, { x: 683, y: 384 });
  assert.deepEqual(png.readHeader(shot.png).width, 1365);

  assert.deepEqual(computer.toLogical(0, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(computer.toLogical(0, 1364, 767), { x: 1919, y: 1079 });
  assert.deepEqual(computer.toShot(0, 960, 540), { x: 683, y: 384 });

  const res = await computer.click({ x: 683, y: 384 });
  assert.deepEqual(res.logical, { x: 961, y: 540 });
  const c = last(driver, 'click');
  assert.deepEqual([c.x, c.y, c.button, c.clicks], [961, 540, 'left', 1]);
});

test('display 1 mapping includes its origin; actions default to the last shot display', async () => {
  const { driver, computer } = make();
  const shot = await computer.screenshot({ display: 1 });
  assert.equal(shot.width, 960);
  assert.equal(shot.height, 768);
  assert.ok(Math.abs(shot.scale - 1280 / 960) < 1e-9);
  await computer.click({ x: 480, y: 384 });
  assert.deepEqual([last(driver, 'click').x, last(driver, 'click').y], [1920 + 640, 512]);
  await computer.click({ x: 0, y: 0, display: 1 });
  assert.deepEqual([last(driver, 'click').x, last(driver, 'click').y], [1920, 0]);
  // display 0 has no screenshot yet: shot space = logical display-local space
  await computer.moveMouse({ x: 100, y: 50, display: 0 });
  assert.deepEqual(driver.state.cursor, { x: 100, y: 50 });
  // A display-0 shot does not disturb display 1's mapping.
  await computer.screenshot({ display: 0 });
  assert.deepEqual(computer.toLogical(1, 480, 384), { x: 2560, y: 512 });
});

test('without any screenshot, coordinates are logical and display-local', async () => {
  const { driver, computer } = make();
  await computer.click({ x: 100, y: 50, display: 1 });
  assert.deepEqual([last(driver, 'click').x, last(driver, 'click').y], [2020, 50]);
  await assert.rejects(computer.click({ x: 1300, y: 10, display: 1 }), (e) => e.code === 'OUT_OF_BOUNDS' && /No screenshot of this display/.test(e.message));
});

test('out-of-bounds input is rejected with a helpful message; 2 px of slack is clamped', async () => {
  const { driver, computer } = make();
  await computer.screenshot({ display: 1, maxWidth: 1366, maxHeight: 768 });
  await assert.rejects(computer.click({ x: 5000, y: 10, display: 1 }), {
    code: 'OUT_OF_BOUNDS',
    message: 'x=5000 is outside the last screenshot (960x768) of display 1. Take a new screenshot.',
  });
  await assert.rejects(computer.click({ x: 10, y: 771, display: 1 }), /y=771 is outside the last screenshot \(960x768\)/);
  await assert.rejects(computer.click({ x: -3, y: 10, display: 1 }), /x=-3/);
  await computer.click({ x: 961, y: -2, display: 1 });
  const c = last(driver, 'click');
  assert.deepEqual([c.x, c.y], [1920 + 1279, 0]);
  await computer.click({ x: -1, y: 769, display: 1 });
  assert.deepEqual([last(driver, 'click').x, last(driver, 'click').y], [1920, 1023]);
  assert.equal(driver.actions.filter((a) => a.type === 'click').length, 2);
});

test('input validation messages', async () => {
  const { computer } = make();
  await assert.rejects(computer.click({ x: 1, y: 1, button: 'side' }), /button must be one of left, right, middle/);
  await assert.rejects(computer.click({ x: 1, y: 1, clicks: 5 }), /clicks must be a whole number from 1 to 3/);
  await assert.rejects(computer.click({ x: 'abc', y: 1 }), /x must be a number \(got "abc"\)/);
  await assert.rejects(computer.click({ x: 1 }), /needs both x and y/);
  await assert.rejects(computer.click({ x: 1, y: 1, display: 5 }), /Display 5 does not exist; there are 2 displays \(indexes 0-1\)/);
  await assert.rejects(computer.click({ x: 1, y: 1, modifiers: 'ctrl+a' }), /modifiers may only contain/);
  await assert.rejects(computer.scroll({ direction: 'diagonal' }), /direction must be one of up, down, left, right/);
  await assert.rejects(computer.scroll({ direction: 'down', amount: 0 }), /amount must be from 1 to 100/);
  await assert.rejects(computer.typeText({ text: 42 }), /text must be a string/);
  await assert.rejects(computer.typeText({ text: 'x', method: 'telepathy' }), /method must be auto, keys or paste/);
  await assert.rejects(computer.key({ combo: 'ctrl+warp' }), (e) => e.code === 'INVALID_KEY' && /Unknown key "warp"/.test(e.message));
  await assert.rejects(computer.key({ combo: '' }), /combo is required/);
  await assert.rejects(computer.key({ combo: 'a', repeat: 0 }), /repeat must be a whole number/);
  await assert.rejects(computer.drag({ fromX: 1, fromY: 2 }), /drag needs fromX, fromY, toX and toY/);
  await assert.rejects(computer.screenshot({ display: 9 }), /Display 9 does not exist/);
  assert.throws(() => new Computer({}), /needs a driver/);
  assert.throws(() => new Computer({ driver: createMockDriver(), geometryStore: 'disk' }), /geometryStore/);
});

test('string inputs from the CLI are accepted', async () => {
  const { driver, computer } = make();
  await computer.click({ x: '10', y: '20', display: '1', clicks: '2' });
  const c = last(driver, 'click');
  assert.deepEqual([c.x, c.y, c.clicks], [1930, 20, 2]);
});

// ------------------------------------------------------------ region zoom

test('region zoom crops native pixels in full-shot space without changing the mapping', async () => {
  const { driver, computer } = make({ mock: { cursor: { x: 960, y: 500 } } });
  await computer.screenshot();
  const before = computer.toLogical(0, 683, 384);
  const zoom = await computer.screenshot({ region: { x: 600, y: 300, width: 200, height: 100 } });
  assert.deepEqual(zoom.region, { x: 600, y: 300, width: 200, height: 100 });
  // native px per shot px = 1920/1365 and 1080/768
  const nx0 = Math.floor(600 * (1920 / 1365));
  const ny0 = Math.floor(300 * (1080 / 768));
  assert.equal(zoom.width, Math.ceil(800 * (1920 / 1365)) - nx0);
  assert.equal(zoom.height, Math.ceil(400 * (1080 / 768)) - ny0);
  assert.deepEqual(zoom.native, { width: zoom.width, height: zoom.height });
  assert.ok(Math.abs(zoom.scale - (200 * (1920 / 1365)) / zoom.width) < 1e-9);
  // Top-left pixel equals the mock gradient at the native crop origin.
  const [r, g, b] = pixelAt(zoom.png, 0, 0);
  assert.equal(r, Math.round((nx0 * 255) / 1919));
  assert.equal(g, Math.round((ny0 * 255) / 1079));
  assert.equal(b, 64);
  // The cursor marker lands at (logical - crop origin) in the zoomed image.
  assert.deepEqual(pixelAt(zoom.png, 960 - nx0, 500 - ny0), [255, 0, 255, 255]);
  assert.deepEqual(zoom.cursor, computer.toShot(0, 960, 500));
  // Mapping is still that of the full screenshot.
  assert.deepEqual(computer.toLogical(0, 683, 384), before);
  await computer.click({ x: 683, y: 384 });
  assert.deepEqual([last(driver, 'click').x, last(driver, 'click').y], [before.x, before.y]);
});

test('region zoom is downscaled to the size limit and clipped to the shot', async () => {
  const { computer } = make();
  await computer.screenshot();
  const z = await computer.screenshot({ region: { x: 0, y: 0, width: 1365, height: 768 }, maxWidth: 400, maxHeight: 400 });
  assert.equal(z.width, 400);
  assert.ok(z.height <= 400);
  const clipped = await computer.screenshot({ region: { x: 1300, y: 700, width: 500, height: 500 } });
  assert.deepEqual(clipped.region, { x: 1300, y: 700, width: 65, height: 68 });
  await assert.rejects(computer.screenshot({ region: { x: 2000, y: 10, width: 10, height: 10 } }), (e) => e.code === 'OUT_OF_BOUNDS');
  await assert.rejects(computer.screenshot({ region: { x: 1, y: 1, width: 0, height: 10 } }), /must be positive/);
});

test('HiDPI display: shot space maps to logical points, region uses native pixels', async () => {
  const driver = createMockDriver({ displays: [{ x: 0, y: 0, width: 1440, height: 900, scale: 2 }], cursor: { x: 720, y: 450 } });
  const { computer } = make({ driver });
  const shot = await computer.screenshot();
  assert.deepEqual(shot.native, { width: 2880, height: 1800 });
  assert.deepEqual([shot.width, shot.height], [1229, 768]);
  assert.ok(Math.abs(shot.scale - 1440 / 1229) < 1e-9);
  await computer.click({ x: 614, y: 384 });
  assert.deepEqual([last(driver, 'click').x, last(driver, 'click').y], [Math.round(614 * (1440 / 1229)), 450]);
  const z = await computer.screenshot({ region: { x: 600, y: 370, width: 30, height: 30 } });
  // 2 native px per logical point → zoom carries more detail than the full shot
  assert.ok(z.width > 60 && z.scale < 1);
});

test('small displays are returned without re-encoding', async () => {
  const driver = createMockDriver({ displays: [{ x: 0, y: 0, width: 640, height: 480 }] });
  let captured = null;
  const orig = driver.captureDisplay;
  driver.captureDisplay = async (i) => {
    captured = await orig(i);
    return captured;
  };
  const { computer } = make({ driver });
  const shot = await computer.screenshot();
  assert.equal(shot.png, captured.png);
  assert.equal(shot.scale, 1);
});

// ------------------------------------------------------------ safety

test('failsafe: pointer in the top-left corner pauses input actions', async () => {
  const { driver, computer } = make();
  driver.setCursor(0, 0);
  await assert.rejects(computer.click({ x: 500, y: 500 }), {
    code: 'FAILSAFE',
    message: 'FAILSAFE: mouse is in the top-left corner; actions are paused',
  });
  driver.setCursor(3, 2);
  await assert.rejects(computer.key({ combo: 'enter' }), { code: 'FAILSAFE' });
  await assert.rejects(computer.typeText({ text: 'hi' }), { code: 'FAILSAFE' });
  assert.equal(driver.actions.filter((a) => ['click', 'keyCombo', 'typeText'].includes(a.type)).length, 0);
  // Screenshots are not input actions.
  await computer.screenshot();
  driver.setCursor(4, 0);
  await computer.key({ combo: 'enter' });
  assert.equal(last(driver, 'keyCombo').keys[0], 'enter');
});

test('failsafe ignores a corner position the computer itself moved to, and can be disabled', async () => {
  const { driver, computer } = make();
  await computer.moveMouse({ x: 0, y: 0 });
  await computer.key({ combo: 'enter' });
  assert.ok(last(driver, 'keyCombo'));
  const off = make({ config: { failsafe: false } });
  off.driver.setCursor(0, 0);
  await off.computer.click({ x: 10, y: 10 });
  assert.ok(last(off.driver, 'click'));
});

test('guard: paused, failing and allowing guards', async () => {
  let calls = 0;
  let verdict = { allowed: false, reason: 'the user pressed Stop' };
  const { driver, computer } = make({
    guard: async () => {
      calls++;
      if (verdict === 'throw') throw new Error('dialog unreachable');
      return verdict;
    },
  });
  await assert.rejects(computer.click({ x: 1, y: 1 }), (e) => e.code === 'PAUSED' && /the user pressed Stop/.test(e.message));
  verdict = 'throw';
  await assert.rejects(computer.key({ combo: 'a' }), (e) => e.code === 'PAUSED' && /dialog unreachable/.test(e.message));
  verdict = { allowed: true };
  await computer.click({ x: 1, y: 1 });
  await computer.key({ combo: 'a' });
  assert.equal(calls, 4);
  assert.equal(driver.actions.filter((a) => a.type === 'click' || a.type === 'keyCombo').length, 2);
  // Validation errors happen before the guard is consulted.
  await assert.rejects(computer.click({ x: 1, y: 1, button: 'nope' }));
  assert.equal(calls, 4);
});

test('actions are serialized and followed by the action delay', async () => {
  const { driver, computer } = make({ config: { actionDelayMs: 30 } });
  const t0 = Date.now();
  await Promise.all([computer.key({ combo: 'a' }), computer.click({ x: 5, y: 5 }), computer.key({ combo: 'b' })]);
  assert.ok(Date.now() - t0 >= 85, 'three delays of 30 ms');
  const order = driver.actions.filter((a) => a.type === 'keyCombo' || a.type === 'click').map((a) => (a.keys ? a.keys[0] : 'click'));
  assert.deepEqual(order, ['a', 'click', 'b']);
});

// ------------------------------------------------------------ typing, keys, pointer

test('paste saves and restores the clipboard', async () => {
  const { driver, computer } = make({ mock: { clipboard: 'user data' } });
  const res = await computer.typeText({ text: 'line one\nline two' });
  assert.equal(res.method, 'paste');
  assert.equal(driver.state.typed, 'line one\nline two');
  assert.deepEqual(last(driver, 'keyCombo').keys, ['ctrl', 'v']);
  assert.equal(driver.state.clipboard, 'user data');
  // Empty clipboards are restored too (the typed text must not linger).
  driver.state.clipboard = '';
  await computer.typeText({ text: 'secret', method: 'paste' });
  assert.equal(driver.state.clipboard, '');
});

test('paste restores the clipboard when the OS stores the pasted text with CRLF (Windows)', async () => {
  // The Windows clipboard keeps CRLF: after writing "a\nb" the driver reads back "a\r\nb". That is
  // still the pasted text, so the user's clipboard must be restored (found on a real Windows desktop).
  const { driver, computer } = make({ mock: { clipboard: 'user data' }, platform: 'win32' });
  const set = driver.clipboardSet;
  driver.clipboardSet = (text) => set(String(text).replace(/\r?\n/g, '\r\n'));
  const res = await computer.typeText({ text: 'line one\nline two' });
  assert.equal(res.method, 'paste');
  assert.equal(driver.state.typed, 'line one\r\nline two');
  assert.equal(driver.state.clipboard, 'user data');
  // A saved clipboard that equals the pasted text up to line endings needs no restore.
  driver.state.clipboard = 'x\r\ny';
  await computer.typeText({ text: 'x\ny', method: 'paste' });
  assert.equal(driver.state.clipboard, 'x\r\ny');
});

test('paste does not clobber a clipboard the user changed meanwhile', async () => {
  const { driver, computer } = make({ mock: { clipboard: 'old' } });
  const orig = driver.keyCombo;
  driver.keyCombo = async (k) => {
    await orig(k);
    driver.state.clipboard = 'copied by the user';
  };
  await computer.typeText({ text: 'x', method: 'paste' });
  assert.equal(driver.state.clipboard, 'copied by the user');
});

test('auto method: keys for short text, paste for long / multi-line / astral text', async () => {
  const { driver, computer } = make({ config: { pasteThreshold: 10 } });
  assert.equal((await computer.typeText({ text: 'hello' })).method, 'keys');
  assert.equal(last(driver, 'typeText').text, 'hello');
  assert.equal((await computer.typeText({ text: 'a'.repeat(11) })).method, 'paste');
  assert.equal((await computer.typeText({ text: 'ok 👍' })).method, 'paste');
  assert.equal((await computer.typeText({ text: 'a\nb', method: 'keys' })).method, 'keys');
  assert.equal(last(driver, 'typeText').text, 'a\nb');
  assert.deepEqual(await computer.typeText({ text: '' }), { ok: true, action: 'type', method: 'none', chars: 0 });
  assert.equal((await computer.typeText({ text: 'naïve 日本' })).chars, 8);
});

test('paste uses cmd+v on macOS and ctrl+shift+v in Linux terminals', async () => {
  const mac = make({ platform: 'darwin' });
  await mac.computer.typeText({ text: 'x\ny' });
  assert.deepEqual(last(mac.driver, 'keyCombo').keys, ['meta', 'v']);
  const lin = make();
  await lin.driver.focusWindow('0x1003'); // Terminal
  assert.equal((await lin.computer.typeText({ text: 'echo 1\necho 2' })).method, 'keys');
  await lin.computer.typeText({ text: 'ls', method: 'paste' });
  assert.deepEqual(last(lin.driver, 'keyCombo').keys, ['ctrl', 'shift', 'v']);
});

test('key: normalized combos, primary per platform, repeat', async () => {
  const { driver, computer } = make({ platform: 'darwin' });
  const r = await computer.key({ combo: 'primary+shift+t' });
  assert.deepEqual(r.keys, ['shift', 'meta', 't']);
  assert.deepEqual(last(driver, 'keyCombo').keys, ['shift', 'meta', 't']);
  await computer.key({ combo: 'down', repeat: 3 });
  assert.equal(driver.actions.filter((a) => a.type === 'keyCombo' && a.keys[0] === 'down').length, 3);
});

test('scroll, drag, modifiers and cursor position', async () => {
  const { driver, computer } = make({ mock: { cursor: { x: 300, y: 200 } } });
  await computer.scroll({ direction: 'down' });
  assert.deepEqual(last(driver, 'scroll'), { ...last(driver, 'scroll'), x: 300, y: 200, dx: 0, dy: 3 });
  await computer.scroll({ x: 10, y: 20, direction: 'left', amount: 5 });
  assert.deepEqual(last(driver, 'scroll'), { ...last(driver, 'scroll'), x: 10, y: 20, dx: -5, dy: 0 });
  await computer.screenshot({ display: 1 });
  await computer.drag({ fromX: 0, fromY: 0, toX: 960, toY: 768, display: 1 });
  const d = last(driver, 'drag');
  assert.deepEqual([d.x1, d.y1, d.x2, d.y2], [1920, 0, 1920 + 1279, 1023]);
  await computer.click({ x: 5, y: 5, modifiers: ['Shift', 'cmd'], button: 'right', clicks: 2, display: 1 });
  const c = last(driver, 'click');
  assert.deepEqual([c.button, c.clicks, c.modifiers], ['right', 2, ['shift', 'meta']]);
  // Clicking without coordinates uses the mouse position.
  driver.setCursor(2000, 100);
  await computer.click({});
  assert.deepEqual([last(driver, 'click').x, last(driver, 'click').y], [2000, 100]);
  const pos = await computer.cursorPosition();
  assert.deepEqual(pos, { x: 60, y: 75, display: 1, logical: { x: 2000, y: 100 } });
  driver.setCursor(-50, -50);
  assert.deepEqual(await computer.cursorPosition(), { x: null, y: null, display: null, logical: { x: -50, y: -50 } });
});

test('screenInfo reports displays and the last shot', async () => {
  const { computer } = make();
  let info = await computer.screenInfo();
  assert.equal(info.displays.length, 2);
  assert.equal(info.lastShot, null);
  assert.equal(info.displays[1].x, 1920);
  await computer.screenshot({ display: 1 });
  info = await computer.screenInfo();
  assert.equal(info.lastShot.display, 1);
  assert.deepEqual([info.lastShot.width, info.lastShot.height], [960, 768]);
  assert.equal(info.displays[0].lastShot, null);
  assert.equal(info.displays[1].lastShot.width, 960);
});

// ------------------------------------------------------------ geometry store

test("geometryStore 'file' shares the mapping across Computer instances", async () => {
  const driver = createMockDriver();
  const a = new Computer({ driver, config: { actionDelayMs: 0 }, geometryStore: 'file', platform: 'linux' });
  await a.screenshot({ display: 1 });
  const file = paths.lastShotPath();
  assert.ok(file.startsWith(HOME));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.lastDisplay, 1);
  assert.deepEqual(saved.displays['1'].shot, { width: 960, height: 768 });

  // A separate instance (e.g. the next CLI invocation) maps the same way.
  const b = new Computer({ driver, config: { actionDelayMs: 0 }, geometryStore: 'file', platform: 'linux' });
  assert.deepEqual(b.toLogical(1, 480, 384), { x: 2560, y: 512 });
  await b.click({ x: 480, y: 384 }); // defaults to display 1, the last shot
  assert.deepEqual([last(driver, 'click').x, last(driver, 'click').y], [2560, 512]);
  // The memory store is per instance.
  const m = new Computer({ driver, config: { actionDelayMs: 0 }, geometryStore: 'memory', platform: 'linux' });
  await m.click({ x: 480, y: 384, display: 1 });
  assert.deepEqual([last(driver, 'click').x, last(driver, 'click').y], [2400, 384]);
  // A corrupt file is tolerated.
  fs.writeFileSync(file, '{not json');
  const c = new Computer({ driver, config: { actionDelayMs: 0 }, geometryStore: 'file', platform: 'linux' });
  await c.click({ x: 10, y: 10, display: 0 });
  assert.deepEqual([last(driver, 'click').x, last(driver, 'click').y], [10, 10]);
});

// ------------------------------------------------------------ driver selection (index.js)

test('selectBackend picks the backend from platform info and ANYWHERE_DRIVER', () => {
  const sel = (info, env = {}) => osIndex.selectBackend({ platform: 'linux', isWSL: false, displayServer: 'none', ...info }, env);
  assert.deepEqual(sel({ platform: 'darwin', displayServer: 'quartz' }), { backend: 'darwin', module: './darwin', opts: {} });
  assert.deepEqual(sel({ platform: 'win32', displayServer: 'windows' }), { backend: 'win32', module: './win32', opts: { wsl: false } });
  assert.deepEqual(sel({ isWSL: true, displayServer: 'windows' }), { backend: 'win32', module: './win32', opts: { wsl: true } });
  assert.deepEqual(sel({ displayServer: 'x11' }), { backend: 'linux', module: './linux', opts: { displayServer: 'x11' } });
  assert.deepEqual(sel({ displayServer: 'wayland' }), { backend: 'linux', module: './linux', opts: { displayServer: 'wayland' } });
  const headless = sel({});
  assert.equal(headless.backend, 'unsupported');
  assert.match(headless.hint, /DISPLAY/);
  assert.equal(sel({}, { ANYWHERE_DRIVER: 'mock' }).backend, 'mock');
  assert.deepEqual(sel({}, { ANYWHERE_DRIVER: 'wsl' }).opts, { wsl: true });
  assert.deepEqual(sel({}, { ANYWHERE_DRIVER: 'x11' }).opts, { displayServer: 'x11' });
  assert.equal(sel({ displayServer: 'x11' }, { ANYWHERE_DRIVER: 'none' }).backend, 'unsupported');
  assert.match(sel({}, { ANYWHERE_DRIVER: 'bogus' }).hint, /one of auto, mock/);
});

test('unsupported driver throws UNSUPPORTED with a hint, capabilities never throw', async () => {
  const d = osIndex.createUnsupportedDriver({ reason: 'no display', hint: 'Install X' });
  const caps = await d.capabilities();
  assert.equal(caps.screenshot, false);
  assert.ok(caps.notes.some((n) => /no display/.test(n)));
  for (const m of osIndex.DRIVER_METHODS) {
    await assert.rejects(d[m](), (e) => e.code === 'UNSUPPORTED' && e.hint === 'Install X', m);
  }
  await d.close();
});

test('getDriver honours ANYWHERE_DRIVER=mock, caches, and resetDriver clears it', async (t) => {
  const prev = process.env.ANYWHERE_DRIVER;
  t.after(async () => {
    if (prev === undefined) delete process.env.ANYWHERE_DRIVER;
    else process.env.ANYWHERE_DRIVER = prev;
    await osIndex.resetDriver();
  });
  process.env.ANYWHERE_DRIVER = 'mock';
  await osIndex.resetDriver();
  const a = await osIndex.getDriver();
  assert.equal(a.name, 'mock');
  assert.equal(await osIndex.getDriver(), a);
  await osIndex.resetDriver();
  assert.equal(a.state.closed, true);
  const b = await osIndex.getDriver();
  assert.notEqual(b, a);
  process.env.ANYWHERE_DRIVER = 'none';
  await osIndex.resetDriver();
  assert.equal((await osIndex.getDriver()).name, 'unsupported');
});

test('a backend that cannot load degrades to an unsupported driver', { skip: fs.existsSync(path.join(__dirname, '..', 'src', 'os', 'darwin.js')) ? 'darwin backend present' : false }, async (t) => {
  const prev = process.env.ANYWHERE_DRIVER;
  t.after(async () => {
    if (prev === undefined) delete process.env.ANYWHERE_DRIVER;
    else process.env.ANYWHERE_DRIVER = prev;
    await osIndex.resetDriver();
  });
  process.env.ANYWHERE_DRIVER = 'darwin';
  await osIndex.resetDriver();
  const d = await osIndex.getDriver();
  assert.equal(d.name, 'unsupported');
  assert.match(d.reason, /darwin driver failed to load/);
  await assert.rejects(d.displays(), (e) => e.code === 'UNSUPPORTED' && /anywhere doctor/.test(e.hint));
});

test('mock driver: test pattern PNG with a cursor marker, windows, focus, clipboard', async () => {
  const d = createMockDriver({ cursor: { x: 1930, y: 20 } });
  const caps = await d.capabilities();
  assert.ok(['screenshot', 'mouse', 'keyboard', 'windows', 'clipboard', 'notify', 'speak'].every((k) => caps[k] === true));
  const displays = await d.displays();
  assert.deepEqual(displays.map((x) => [x.index, x.x, x.width, x.height, x.primary]), [[0, 0, 1920, 1080, true], [1, 1920, 1280, 1024, false]]);
  const cap = await d.captureDisplay(1);
  assert.deepEqual([cap.width, cap.height], [1280, 1024]);
  const img = png.decode(cap.png);
  assert.deepEqual([img.width, img.height], [1280, 1024]);
  const at = (x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
  assert.deepEqual(at(10, 20), [255, 0, 255, 255]);
  assert.deepEqual(at(1279, 1023), [255, 255, 192, 255]);
  await assert.rejects(d.captureDisplay(2), /does not exist/);
  assert.equal((await d.activeWindow()).app, 'Code');
  assert.equal(await d.focusWindow('0x1002'), true);
  assert.equal((await d.activeWindow()).app, 'Google Chrome');
  assert.equal(await d.focusWindow('nope'), false);
  assert.equal(await d.minimizeWindow('0x1002'), true);
  assert.equal((await d.listWindows()).find((w) => w.id === '0x1002').minimized, true);
  assert.equal(await d.setTopmost('0x1001', true), true);
  await d.clipboardSet('héllo');
  assert.equal(await d.clipboardGet(), 'héllo');
  await d.mouseDown('left');
  assert.ok(d.state.pressed.has('left'));
  await d.mouseUp('left');
  assert.ok(d.actions.some((a) => a.type === 'captureDisplay'));
});

test('input actions pass driver warnings through, without duplicates (win32 UIPI)', async () => {
  const driver = createMockDriver();
  const W = 'Your input may not reach Setup: it belongs to another user account (UIPI).';
  for (const m of ['click', 'drag', 'scroll', 'typeText', 'keyCombo']) {
    const orig = driver[m].bind(driver);
    driver[m] = async (...a) => {
      await orig(...a);
      return { warnings: [W] };
    };
  }
  const { computer } = make({ driver });
  await computer.screenshot();
  assert.deepEqual((await computer.click({ x: 10, y: 10 })).warnings, [W]);
  assert.deepEqual((await computer.drag({ fromX: 1, fromY: 1, toX: 5, toY: 5 })).warnings, [W]);
  assert.deepEqual((await computer.scroll({ direction: 'down', x: 3, y: 3 })).warnings, [W]);
  assert.deepEqual((await computer.typeText({ text: 'hi', method: 'keys' })).warnings, [W]);
  assert.deepEqual((await computer.typeText({ text: 'pasted text', method: 'paste' })).warnings, [W], 'the paste keyCombo result');
  assert.deepEqual((await computer.key({ combo: 'down', repeat: 3 })).warnings, [W], 'one copy for every repeat');
  const plain = make();
  await plain.computer.screenshot();
  assert.equal('warnings' in (await plain.computer.click({ x: 10, y: 10 })), false);
});
