'use strict';

/**
 * Live macOS desktop checks: the real darwin driver (JXA helper, screencapture, pbcopy),
 * Computer, the `anywhere computer` CLI and the MCP server, driving the runner's real desktop
 * and TextEdit. CI runs them in the "Live desktop (macos-latest)" job with
 * `node scripts/test.js --test-name-pattern=live-desktop`.
 *
 * Skipped unless process.platform is darwin and ANYWHERE_LIVE_DESKTOP=1: they move the mouse,
 * type into TextEdit and overwrite the clipboard. Screenshots are saved to ANYWHERE_LIVE_OUT.
 *
 * Checks that need a privacy permission (Accessibility, Screen Recording) assert the real
 * behaviour when macOS reports it granted, and otherwise assert that the driver detects the
 * missing permission and fails with a PERMISSION error and an actionable hint.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const LIVE = process.platform === 'darwin' && process.env.ANYWHERE_LIVE_DESKTOP === '1';
const SKIP = LIVE ? false : 'live desktop checks run only on macOS with ANYWHERE_LIVE_DESKTOP=1';
const ROOT = path.join(__dirname, '..');
const OUT = process.env.ANYWHERE_LIVE_OUT || path.join(os.tmpdir(), 'anywhere-live');
const HOME = LIVE ? fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-live-home-')) : null;

if (LIVE) {
  // Our own state folder, and the real driver even if the caller's shell forces another one.
  process.env.ANYWHERE_HOME = HOME;
  delete process.env.ANYWHERE_DRIVER;
  fs.mkdirSync(OUT, { recursive: true });
}

const PNG_SIG = '89504e470d0a1a0a';
const TYPED = 'anywhere-live-ok';
const UNICODE = 'ü€';
const CLICKED = 'clicked-ok';

/** Shared across the (sequential) tests of this file. */
const state = {
  driver: null,
  perms: { accessibility: null, screenRecording: null },
  display: null,
  desktop: null,
  textEdit: null,
  computer: null,
};

// ---------------------------------------------------------------- helpers

function note(...args) {
  const parts = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
  console.log(`[live-darwin] ${parts.join(' ')}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childEnv(extra = {}) {
  const env = { ...process.env, ANYWHERE_HOME: HOME, ...extra };
  delete env.ANYWHERE_DRIVER;
  delete env.ANYWHERE_DAEMON_URL;
  delete env.ANYWHERE_TOKEN;
  return env;
}

/** Run a command synchronously; never throws. */
function sh(cmd, args, { timeoutMs = 20000, input } = {}) {
  const r = childProcess.spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, input, env: childEnv() });
  return {
    code: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? r.error.message : null,
  };
}

async function drv() {
  if (!state.driver) state.driver = await require('../src/os/index').getDriver();
  return state.driver;
}

async function waitFor(fn, timeoutMs, stepMs = 400) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(stepMs);
  }
}

/** The driver's PERMISSION error for a missing macOS permission, with its hint and Settings link. */
async function expectPermission(promise, kind) {
  await assert.rejects(promise, (err) => {
    note(`expected PERMISSION error (${kind}):`, { code: err.code, permission: err.permission, message: err.message, hint: err.hint });
    assert.equal(err.code, 'PERMISSION');
    assert.equal(err.permission, kind);
    assert.match(err.hint || '', kind === 'screenRecording' ? /Screen Recording/ : /Accessibility/);
    assert.match(err.hint, /x-apple\.systempreferences:/);
    assert.match(String(err.settingsUrl || ''), /^x-apple\.systempreferences:/);
    return true;
  });
}

function assertPng(buf, what) {
  assert.ok(Buffer.isBuffer(buf) && buf.length > 100, `${what}: no image data`);
  assert.equal(buf.subarray(0, 8).toString('hex'), PNG_SIG, `${what}: not a PNG`);
}

function pixel(img, x, y) {
  const px = Math.min(img.width - 1, Math.max(0, Math.round(x)));
  const py = Math.min(img.height - 1, Math.max(0, Math.round(y)));
  const i = (py * img.width + px) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** Coarse content statistics from a grid of samples. */
function imageStats(img) {
  const colors = new Set();
  let sum = 0;
  let black = 0;
  let n = 0;
  for (let gy = 0; gy < 27; gy++) {
    for (let gx = 0; gx < 48; gx++) {
      const [r, g, b] = pixel(img, ((gx + 0.5) * img.width) / 48, ((gy + 0.5) * img.height) / 27);
      colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
      const lum = (r + g + b) / 3;
      sum += lum;
      if (lum < 8) black++;
      n++;
    }
  }
  return { width: img.width, height: img.height, distinctColors: colors.size, meanLuma: Math.round(sum / n), blackShare: +(black / n).toFixed(3) };
}

/** On-screen TextEdit document windows (not panels), largest first. */
async function textEditWindows(d, opts) {
  const wins = await d.listWindows(opts);
  return wins.filter((w) => w.app === 'TextEdit' && w.width >= 200 && w.height >= 150).sort((a, b) => b.width * b.height - a.width * a.height);
}

/** Clipboard text once it is no longer `before` (copy is asynchronous for the target app). */
async function clipboardAfterCopy(d, before) {
  let last = before;
  await waitFor(
    async () => {
      last = await d.clipboardGet();
      return last !== before;
    },
    4000,
    150,
  );
  return last;
}

async function selectAllAndCopy(d, sentinel) {
  await d.clipboardSet(sentinel);
  await d.keyCombo(['meta', 'a']);
  await sleep(250);
  await d.keyCombo(['meta', 'c']);
  return clipboardAfterCopy(d, sentinel);
}

function textEditRunning() {
  return sh('pgrep', ['-x', 'TextEdit']).code === 0;
}

after(async () => {
  if (!LIVE) return;
  try {
    if (textEditRunning()) sh('killall', ['TextEdit']);
  } catch {
    /* best effort */
  }
  await require('../src/os/index').resetDriver();
});

// ---------------------------------------------------------------- a. capabilities

test('live-desktop darwin a: capabilities() report the macOS permission state', { skip: SKIP, timeout: 90000 }, async () => {
  note('sw_vers:', sh('sw_vers', []).stdout.trim().replace(/\s*\n\s*/g, '; '), '| arch:', sh('uname', ['-m']).stdout.trim());
  const d = await drv();
  assert.equal(d.name, 'darwin', `getDriver() picked the ${d.name} driver`);
  const caps = await d.capabilities();
  note('capabilities():', caps);
  assert.ok(caps.permissions && typeof caps.permissions === 'object', 'capabilities() has a permissions block');
  for (const k of ['accessibility', 'screenRecording']) {
    assert.ok([true, false, null].includes(caps.permissions[k]), `permissions.${k} is true, false or null (got ${caps.permissions[k]})`);
  }
  state.perms = { accessibility: caps.permissions.accessibility, screenRecording: caps.permissions.screenRecording };
  note(
    `PERMISSIONS: accessibility=${caps.permissions.accessibility} screenRecording=${caps.permissions.screenRecording} ` +
      `automation=${caps.permissions.automation} hostApp=${caps.permissions.hostApp}`,
  );
  assert.equal(caps.helper, 'serve', 'the persistent JXA helper is in use');
  assert.equal(caps.windows, true, 'the JXA helper answered');
  assert.equal(caps.clipboard, true);
  assert.equal(caps.screenshot, state.perms.screenRecording !== false);
  assert.equal(caps.mouse, state.perms.accessibility !== false);
  assert.equal(caps.keyboard, state.perms.accessibility !== false);
  assert.ok(Array.isArray(caps.notes) && caps.notes.length > 0);

  // Diagnostics: what the runner image grants (TCC), and who macOS holds responsible for us.
  const query =
    "select service, client, auth_value from access where service in " +
    "('kTCCServiceAccessibility','kTCCServiceScreenCapture','kTCCServicePostEvent','kTCCServiceAppleEvents','kTCCServiceListenEvent')";
  for (const db of ['/Library/Application Support/com.apple.TCC/TCC.db', path.join(os.homedir(), 'Library/Application Support/com.apple.TCC/TCC.db')]) {
    const r = sh('sqlite3', [db, query]);
    note(`TCC ${db}:`, r.code === 0 ? r.stdout.trim().split('\n').join(' | ') : `unreadable (${(r.stderr || r.error || '').trim()})`);
  }
  const chain = [];
  let pid = process.pid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const r = sh('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.trim());
    if (!m) break;
    chain.push(`${pid}:${m[2]}`);
    pid = Number(m[1]);
  }
  note('process ancestry:', chain.join(' <- '));
});

// ---------------------------------------------------------------- b. displays

test('live-desktop darwin b: displays() lists the real display with a sane scale', { skip: SKIP, timeout: 60000 }, async () => {
  const d = await drv();
  const list = await d.displays();
  note('displays():', list);
  assert.ok(list.length >= 1, 'at least one display');
  const p = list[0];
  assert.equal(p.primary, true);
  assert.equal(p.index, 0);
  assert.equal(p.x, 0);
  assert.equal(p.y, 0);
  assert.ok(p.width >= 640 && p.height >= 480, `primary display is ${p.width}x${p.height} points`);
  assert.ok(Number.isFinite(p.scale) && p.scale >= 1 && p.scale <= 3, `backing scale ${p.scale}`);
  for (const other of list.slice(1)) assert.equal(other.primary, false);
  note(`primary display: ${p.width}x${p.height} pt, scale ${p.scale} (${p.scale >= 2 ? 'Retina' : 'not Retina'}), ${list.length} display(s)`);
  state.display = p;
});

// ---------------------------------------------------------------- c. captureDisplay

test('live-desktop darwin c: captureDisplay(0) returns a PNG of the display', { skip: SKIP, timeout: 90000 }, async () => {
  const d = await drv();
  const disp = state.display || (await d.displays())[0];
  if (state.perms.screenRecording === false) {
    await expectPermission(d.captureDisplay(0), 'screenRecording');
    return;
  }
  const t0 = Date.now();
  const shot = await d.captureDisplay(0);
  note(`captureDisplay(0): ${shot.width}x${shot.height}, ${shot.png.length} bytes in ${Date.now() - t0} ms`);
  assertPng(shot.png, 'captureDisplay(0)');
  assert.ok(Math.abs(shot.width - Math.round(disp.width * disp.scale)) <= 2, `width ${shot.width} = ${disp.width} pt x ${disp.scale}`);
  assert.ok(Math.abs(shot.height - Math.round(disp.height * disp.scale)) <= 2, `height ${shot.height} = ${disp.height} pt x ${disp.scale}`);
  fs.writeFileSync(path.join(OUT, 'darwin-1-display0.png'), shot.png);
  const img = require('../src/os/png').decode(shot.png);
  assert.equal(img.width, shot.width);
  const stats = imageStats(img);
  note('display 0 content:', stats);
  const wins = await d.listWindows({ axTitles: false });
  note(
    'on-screen windows:',
    wins.map((w) => `${w.app} "${w.title}" ${w.width}x${w.height}@${w.x},${w.y}${w.focused ? ' (focused)' : ''}`),
  );
  state.desktop = { img, display: disp };
  assert.ok(stats.distinctColors > 1, 'the capture is not a single flat color (a locked or sleeping display)');
});

// ---------------------------------------------------------------- d. JXA helper serve mode

test('live-desktop darwin d: the persistent JXA helper (serve mode) answers many requests and survives', { skip: SKIP, timeout: 120000 }, async () => {
  const d = await drv();
  const tr = d._transport;
  const first = await d._call('ping');
  note('helper ping:', first, 'mode:', tr.mode, 'pid:', tr.pid);
  assert.equal(tr.mode, 'serve');
  assert.equal(tr._serveFailures, 0, 'the persistent helper started without falling back to one-shot osascript');
  const pid = tr.pid;
  assert.ok(Number.isInteger(pid) && pid > 0, 'a persistent osascript process is running');
  assert.equal(first.pid, pid, 'the answer comes from that process (NSProcessInfo pid)');
  assert.deepEqual(first.importErrors, [], 'every framework imported');

  const t0 = Date.now();
  for (let i = 0; i < 10; i++) assert.equal((await d._call('ping')).pid, pid);
  const perPing = (Date.now() - t0) / 10;
  // Requests issued together are queued and answered in order by the same process.
  const burst = await Promise.all(Array.from({ length: 24 }, (_, i) => d._call(['ping', 'cursor', 'displays'][i % 3])));
  assert.equal(burst.length, 24);
  for (let i = 0; i < burst.length; i += 3) {
    assert.equal(burst[i].pid, pid);
    assert.ok(Number.isFinite(burst[i + 1].x) && Number.isFinite(burst[i + 1].y));
    assert.ok(Array.isArray(burst[i + 2].screens) && burst[i + 2].screens.length >= 1);
  }
  // A request larger than a pipe buffer reaches the helper in several stdin reads.
  const big = `${'0123456789abcdef'.repeat(8192)}|${UNICODE}😀`;
  await d._call('clipSet', { text: big });
  const back = await d._call('clipGet');
  assert.equal(back.text.length, big.length, 'a 128 KB request and response round-trip intact');
  assert.equal(back.text, big);
  // Errors are answered, not fatal.
  await assert.rejects(d._call('no-such-command'), (err) => err.code === 'UNKNOWN_COMMAND');
  await assert.rejects(d._call('move', { x: 'left', y: 1 }), (err) => err.code === 'BAD_ARGS');
  assert.equal(tr.pid, pid, 'the same helper process is still serving');
  assert.equal((await d._call('ping')).pid, pid);

  const t1 = Date.now();
  const one = await tr.request('ping', {}, { oneShot: true });
  const oneShotMs = Date.now() - t1;
  assert.equal(one.pong, true);
  assert.notEqual(one.pid, pid, 'the one-shot fallback runs in its own osascript process');
  note(`serve mode: ${perPing.toFixed(1)} ms per ping; one-shot osascript: ${oneShotMs} ms`);
  assert.equal(tr.pid, pid);
});

// ---------------------------------------------------------------- e. mouse

test('live-desktop darwin e: moveMouse then cursorPosition round-trip within 2 points', { skip: SKIP, timeout: 60000 }, async () => {
  const d = await drv();
  const disp = state.display || (await d.displays())[0];
  if (state.perms.accessibility === false) {
    await expectPermission(d.moveMouse(100, 100), 'accessibility');
    return;
  }
  const points = [
    [Math.round(disp.width / 2), Math.round(disp.height / 2)],
    [200, 300],
    [disp.width - 150, disp.height - 120],
    [333.5, 222.25],
    [Math.round(disp.width / 2) + 7, Math.round(disp.height / 2) - 9],
  ];
  for (const [x, y] of points) {
    await d.moveMouse(x, y);
    await sleep(120);
    const pos = await d.cursorPosition();
    note(`moveMouse(${x}, ${y}) -> cursorPosition ${JSON.stringify(pos)}`);
    assert.ok(Math.abs(pos.x - x) <= 2 && Math.abs(pos.y - y) <= 2, `cursor at ${pos.x},${pos.y}, expected ${x},${y}`);
  }
});

// ---------------------------------------------------------------- i. clipboard

test('live-desktop darwin i: clipboardSet / clipboardGet round-trip unicode', { skip: SKIP, timeout: 60000 }, async () => {
  const d = await drv();
  const text = `Grüße ✓ 日本語 😀 € — "quotes" ${UNICODE}\nsecond line\ttab`;
  await d.clipboardSet(text);
  assert.equal(await d.clipboardGet(), text);
  // The JXA helper's pasteboard commands agree with pbcopy / pbpaste.
  assert.equal((await d._call('clipGet')).text, text);
  const viaHelper = `${text} (helper)`;
  await d._call('clipSet', { text: viaHelper });
  assert.equal(await d.clipboardGet(), viaHelper);
  await d.clipboardSet('');
  assert.equal(await d.clipboardGet(), '');
});

// ---------------------------------------------------------------- f. TextEdit window

test('live-desktop darwin f: open TextEdit, find its window with listWindows and focus it', { skip: SKIP, timeout: 180000 }, async () => {
  const d = await drv();
  if (textEditRunning()) {
    sh('killall', ['TextEdit']);
    await waitFor(() => !textEditRunning(), 10000);
  }
  const doc = path.join(HOME, 'anywhere-live.txt');
  fs.writeFileSync(doc, '');
  const opened = sh('open', ['-a', 'TextEdit', doc], { timeoutMs: 30000 });
  note('open -a TextEdit:', { code: opened.code, stderr: opened.stderr.trim(), error: opened.error });
  assert.equal(opened.code, 0, `open -a TextEdit failed: ${opened.stderr}`);
  let wins = await waitFor(async () => {
    const w = await textEditWindows(d);
    return w.length ? w : null;
  }, 30000);
  if (!wins) {
    const made = sh('osascript', ['-e', 'tell application "TextEdit" to make new document'], { timeoutMs: 30000 });
    note('osascript make new document:', { code: made.code, stdout: made.stdout.trim(), stderr: made.stderr.trim(), error: made.error });
    wins = await waitFor(async () => {
      const w = await textEditWindows(d);
      return w.length ? w : null;
    }, 20000);
  }
  if (!wins) note('all windows:', await d.listWindows());
  assert.ok(wins && wins.length, 'a TextEdit document window appeared in listWindows()');
  const win = wins.find((w) => /anywhere-live/.test(w.title)) || wins[0];
  note('TextEdit window:', win, `(${wins.length} TextEdit window(s))`);
  assert.match(win.id, /^\d+:\d+$/);
  assert.ok(win.pid > 0);
  state.textEdit = win;
  const focused = await d.focusWindow(win.id);
  note('focusWindow:', focused);
  assert.equal(focused, true, 'focusWindow() brought TextEdit to the front');
});

// ---------------------------------------------------------------- g. activeWindow

test('live-desktop darwin g: activeWindow() reports TextEdit', { skip: SKIP, timeout: 60000 }, async () => {
  const d = await drv();
  assert.ok(state.textEdit, 'TextEdit is open (test f)');
  const active = await waitFor(async () => {
    const a = await d.activeWindow();
    return a && a.app === 'TextEdit' ? a : null;
  }, 5000);
  const last = active || (await d.activeWindow());
  note('activeWindow():', last);
  assert.ok(active, `the active window is TextEdit (got ${last && last.app})`);
  assert.equal(active.pid, state.textEdit.pid);
  assert.equal(active.bundleId, 'com.apple.TextEdit');
  assert.match(active.id, new RegExp(`^${state.textEdit.pid}:\\d+$`));
});

// ---------------------------------------------------------------- h. typing and shortcuts

test('live-desktop darwin h: typeText, then Cmd+A / Cmd+C put the typed text on the clipboard', { skip: SKIP, timeout: 300000 }, async () => {
  const d = await drv();
  assert.ok(state.textEdit, 'TextEdit is open (test f)');
  if (state.perms.accessibility === false) {
    await expectPermission(d.typeText('x'), 'accessibility');
    await expectPermission(d.keyCombo(['meta', 'a']), 'accessibility');
    return;
  }
  assert.equal(await d.focusWindow(state.textEdit.id), true);
  await sleep(300);
  const t0 = Date.now();
  await d.typeText(TYPED);
  note(`typeText(${JSON.stringify(TYPED)}) took ${Date.now() - t0} ms; automation consent: ${JSON.stringify(d._automation)}`);
  await sleep(300);
  const copied = await selectAllAndCopy(d, 'sentinel-1');
  note('clipboard after Cmd+A, Cmd+C:', JSON.stringify(copied));
  assert.equal(copied, TYPED);

  // Non-ASCII text goes through the paste path; it replaces the selection.
  const t1 = Date.now();
  await d.typeText(UNICODE);
  note(`typeText(${JSON.stringify(UNICODE)}) took ${Date.now() - t1} ms`);
  assert.equal(await d.clipboardGet(), TYPED, 'the clipboard was restored after the paste');
  await sleep(300);
  const copied2 = await selectAllAndCopy(d, 'sentinel-2');
  note('clipboard after typing non-ASCII:', JSON.stringify(copied2));
  assert.equal(copied2, UNICODE);
});

// ---------------------------------------------------------------- j. Computer: screenshot mapping and click

test('live-desktop darwin j: Computer screenshot coordinates click into TextEdit (scale mapping) and type', { skip: SKIP, timeout: 180000 }, async () => {
  const d = await drv();
  assert.ok(state.textEdit, 'TextEdit is open (test f)');
  const { Computer } = require('../src/os/computer');
  const comp = new Computer({ driver: d, config: { actionDelayMs: 80 } });
  state.computer = comp;
  const disp = state.display || (await d.displays())[0];
  if (state.perms.screenRecording === false) {
    await expectPermission(comp.screenshot(), 'screenRecording');
  }
  if (state.perms.accessibility === false) {
    await expectPermission(comp.click({ x: 10, y: 10 }), 'accessibility');
    return;
  }
  assert.equal(await d.focusWindow(state.textEdit.id), true);
  await sleep(300);
  const win = (await d.listWindows()).find((w) => w.id === state.textEdit.id) || state.textEdit;
  const lx = Math.round(win.x + win.width / 2);
  const ly = Math.round(win.y + win.height * 0.65);
  let shotW = disp.width;
  let shotH = disp.height;
  if (state.perms.screenRecording !== false) {
    const shot = await comp.screenshot();
    note('Computer.screenshot():', { width: shot.width, height: shot.height, scale: shot.scale, native: shot.native, cursor: shot.cursor });
    assertPng(shot.png, 'Computer.screenshot()');
    fs.writeFileSync(path.join(OUT, 'darwin-2-computer-textedit.png'), shot.png);
    assert.ok(shot.width <= 1366 && shot.height <= 768, 'downscaled to fit 1366x768');
    assert.ok(Math.abs(shot.native.width - Math.round(disp.width * disp.scale)) <= 2, 'native size is points x backing scale');
    assert.ok(Math.abs(shot.scale - disp.width / shot.width) < 1e-9);
    shotW = shot.width;
    shotH = shot.height;
    // Real window pixels or wallpaper only? Compare TextEdit's interior with the capture taken before it opened.
    if (state.desktop) {
      const now = require('../src/os/png').decode(shot.png);
      const before = state.desktop.img;
      let changed = 0;
      let n = 0;
      for (let gy = 0; gy < 8; gy++) {
        for (let gx = 0; gx < 8; gx++) {
          const px = win.x + win.width * (0.15 + (0.7 * gx) / 7);
          const py = win.y + win.height * (0.4 + (0.45 * gy) / 7);
          const a = pixel(now, ((px - disp.x) * shot.width) / disp.width, ((py - disp.y) * shot.height) / disp.height);
          const b = pixel(before, (px - disp.x) * disp.scale, (py - disp.y) * disp.scale);
          if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > 24) changed++;
          n++;
        }
      }
      const share = changed / n;
      note(`TextEdit interior differs from the earlier desktop capture at ${changed}/${n} samples: ${share >= 0.5 ? 'REAL window pixels' : 'desktop only (no window content)'}`);
      assert.ok(share >= 0.5, 'the screenshot shows the TextEdit window, not just the desktop behind it');
    }
  }
  // Screenshot pixels for the logical point; Computer maps them back through the scale.
  const sx = Math.round(((lx - disp.x) * shotW) / disp.width);
  const sy = Math.round(((ly - disp.y) * shotH) / disp.height);
  const res = await comp.click({ x: sx, y: sy });
  note(`click at screenshot (${sx}, ${sy}) for logical (${lx}, ${ly}):`, res);
  const tol = disp.width / shotW + 1;
  assert.ok(Math.abs(res.logical.x - lx) <= tol && Math.abs(res.logical.y - ly) <= tol, `mapped to ${res.logical.x},${res.logical.y}`);
  const pos = await d.cursorPosition();
  assert.ok(Math.abs(pos.x - res.logical.x) <= 2 && Math.abs(pos.y - res.logical.y) <= 2, `cursor at ${pos.x},${pos.y}`);
  const cur = await comp.cursorPosition();
  assert.ok(Math.abs(cur.x - sx) <= 1 && Math.abs(cur.y - sy) <= 1, `Computer.cursorPosition() ${cur.x},${cur.y} in screenshot pixels`);

  // The click put the caret at the end (below the last line), so typing appends.
  await sleep(200);
  const typed = await comp.typeText({ text: CLICKED });
  note('Computer.typeText():', typed);
  await sleep(300);
  await d.clipboardSet('sentinel-3');
  await comp.key({ combo: 'primary+a' });
  await sleep(200);
  await comp.key({ combo: 'primary+c' });
  const copied = await clipboardAfterCopy(d, 'sentinel-3');
  note('clipboard after the click and typing:', JSON.stringify(copied));
  assert.equal(copied, `${UNICODE}${CLICKED}`, 'the click deselected the text and typing appended to it');
});

// ---------------------------------------------------------------- k. scroll and drag

test('live-desktop darwin k: scroll and drag do not throw', { skip: SKIP, timeout: 120000 }, async () => {
  const d = await drv();
  assert.ok(state.textEdit, 'TextEdit is open (test f)');
  const w = state.textEdit;
  const cx = Math.round(w.x + w.width / 2);
  const cy = Math.round(w.y + w.height / 2);
  if (state.perms.accessibility === false) {
    await expectPermission(d.scroll(cx, cy, 0, 3), 'accessibility');
    await expectPermission(d.drag(cx, cy, cx + 50, cy), 'accessibility');
    return;
  }
  await d.focusWindow(w.id);
  await d.scroll(cx, cy, 0, 3);
  await d.scroll(cx, cy, 0, -3);
  await d.scroll(cx, cy, 2, 0);
  await d.scroll(cx, cy, -2, 0);
  const x1 = Math.round(w.x + w.width * 0.3);
  const x2 = Math.round(w.x + w.width * 0.7);
  const y = Math.round(w.y + w.height * 0.6);
  await d.drag(x1, y, x2, y + 20);
  let pos = await d.cursorPosition();
  assert.ok(Math.abs(pos.x - x2) <= 2 && Math.abs(pos.y - (y + 20)) <= 2, `drag ended at ${pos.x},${pos.y}`);
  await d.mouseDown('left');
  await d.moveMouse(x1, y);
  await d.mouseUp('left');
  pos = await d.cursorPosition();
  assert.ok(Math.abs(pos.x - x1) <= 2 && Math.abs(pos.y - y) <= 2, `mouseDown/move/mouseUp ended at ${pos.x},${pos.y}`);
  const comp = state.computer;
  if (comp) {
    const s = await comp.cursorPosition();
    await comp.scroll({ x: s.x, y: s.y, direction: 'down', amount: 2 });
    await comp.scroll({ direction: 'up', amount: 2 });
    await comp.drag({ fromX: s.x, fromY: s.y, toX: s.x + 20, toY: s.y + 5 });
  }
  note('scroll, drag and mouseDown/mouseUp completed');
});

// ---------------------------------------------------------------- l. quit TextEdit

test('live-desktop darwin l: quit TextEdit without saving', { skip: SKIP, timeout: 90000 }, async () => {
  const d = await drv();
  const r = sh('osascript', ['-e', 'tell application "TextEdit" to quit saving no'], { timeoutMs: 30000 });
  note('osascript quit saving no:', { code: r.code, signal: r.signal, stderr: r.stderr.trim(), error: r.error });
  let gone = await waitFor(() => !textEditRunning(), 15000);
  if (!gone) {
    note('TextEdit is still running after "quit saving no"; killing it');
    sh('killall', ['TextEdit']);
    gone = await waitFor(() => !textEditRunning(), 10000);
  }
  assert.ok(gone, 'TextEdit has quit');
  const left = await textEditWindows(d, { axTitles: false });
  assert.equal(left.length, 0, 'no TextEdit windows are listed');
});

// ---------------------------------------------------------------- m. CLI

test('live-desktop darwin m: `anywhere computer screenshot --out FILE` writes a PNG and prints JSON', { skip: SKIP, timeout: 120000 }, async () => {
  const out = path.join(OUT, 'darwin-3-cli-screenshot.png');
  fs.rmSync(out, { force: true });
  const t0 = Date.now();
  const r = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'bin', 'anywhere.js'), 'computer', 'screenshot', '--out', out], {
    encoding: 'utf8',
    timeout: 90000,
    env: childEnv(),
  });
  note(`anywhere computer screenshot: exit ${r.status} in ${Date.now() - t0} ms; stdout: ${(r.stdout || '').trim()}; stderr: ${(r.stderr || '').trim().slice(-800)}`);
  if (state.perms.screenRecording === false) {
    assert.notEqual(r.status, 0);
    const err = JSON.parse(r.stdout);
    assert.equal(err.ok, false);
    assert.equal(err.code, 'PERMISSION');
    assert.match(err.hint, /Screen Recording/);
    return;
  }
  assert.equal(r.status, 0, `exit status ${r.status}: ${r.stdout} ${r.stderr}`);
  const res = JSON.parse(r.stdout);
  assert.equal(res.path, out);
  assert.equal(res.display, 0);
  assert.ok(res.displays >= 1);
  assert.ok(res.width > 0 && res.height > 0 && res.width <= 1366 && res.height <= 768);
  assert.ok(res.scale > 0);
  const buf = fs.readFileSync(out);
  assertPng(buf, 'CLI screenshot');
  assert.equal(buf.readUInt32BE(16), res.width);
  assert.equal(buf.readUInt32BE(20), res.height);
});

// ---------------------------------------------------------------- n. MCP server

class RpcPeer {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          note('MCP: non-JSON stdout line:', line.slice(0, 200));
          continue;
        }
        const waiter = msg && msg.id !== undefined ? this.pending.get(msg.id) : null;
        if (waiter) {
          this.pending.delete(msg.id);
          waiter(msg);
        }
      }
    });
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no MCP response to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
}

test('live-desktop darwin n: the MCP server returns a real screenshot image', { skip: SKIP, timeout: 120000 }, async (t) => {
  const child = childProcess.spawn(process.execPath, [path.join(ROOT, 'src', 'mcp', 'server.js')], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => {
    try {
      child.stdin.end();
    } catch {
      /* gone */
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
    if (stderr.trim()) note('MCP server stderr (tail):', stderr.trim().slice(-1500));
  });
  const peer = new RpcPeer(child);
  const init = await peer.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-desktop-test', version: '1' } });
  assert.ok(init.result && init.result.serverInfo, `initialize: ${JSON.stringify(init).slice(0, 300)}`);
  peer.notify('notifications/initialized');
  const t0 = Date.now();
  const shot = await peer.request('tools/call', { name: 'screenshot', arguments: {} }, 90000);
  const content = (shot.result && shot.result.content) || [];
  note(
    `MCP screenshot in ${Date.now() - t0} ms:`,
    content.map((c) => (c.type === 'image' ? `image ${c.mimeType} ${c.data.length} b64 chars` : `${c.type}: ${c.text}`)),
  );
  assert.ok(shot.result, `tools/call failed: ${JSON.stringify(shot.error || shot).slice(0, 500)}`);
  if (state.perms.screenRecording === false) {
    assert.equal(shot.result.isError, true);
    assert.match(content[0].text, /Screen Recording/);
    return;
  }
  assert.ok(!shot.result.isError, `screenshot tool error: ${JSON.stringify(content).slice(0, 500)}`);
  const img = content.find((c) => c.type === 'image');
  assert.ok(img, 'an image block');
  assert.equal(img.mimeType, 'image/png');
  const buf = Buffer.from(img.data, 'base64');
  assertPng(buf, 'MCP screenshot');
  fs.writeFileSync(path.join(OUT, 'darwin-4-mcp-screenshot.png'), buf);
  const txt = content.find((c) => c.type === 'text');
  assert.ok(txt && /Screenshot of display 0/.test(txt.text), 'a text block describing the screenshot');
});
