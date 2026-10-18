'use strict';

// Live Windows desktop: drives the REAL desktop through the real win32 driver (the persistent
// PowerShell host), Computer, the `anywhere computer` CLI and the MCP server. Opt-in: it runs only
// on Windows with ANYWHERE_LIVE_DESKTOP=1 (CI job "Live desktop (windows-latest)"), because it moves
// the mouse, types into Notepad and overwrites the clipboard. Screenshots of key steps are saved to
// ANYWHERE_LIVE_OUT for debugging.
//
// The tests share one driver and one Notepad window and run in order.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'anywhere.js');
const MCP_SERVER = path.join(ROOT, 'src', 'mcp', 'server.js');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const LIVE = process.platform === 'win32' && process.env.ANYWHERE_LIVE_DESKTOP === '1';
const skip = LIVE ? false : 'live Windows desktop only (Windows with ANYWHERE_LIVE_DESKTOP=1)';

const TYPED = 'anywhere-live-ok ü€';
const CLICKED = ' clicked-ok';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Poll fn() until it returns a truthy value or timeoutMs passes; returns the last value. */
async function waitFor(fn, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last || Date.now() >= deadline) return last;
    await sleep(stepMs);
  }
}

function isNotepad(w) {
  return Boolean(w) && (/^notepad\.exe$/i.test(String(w.process || '')) || /notepad/i.test(String(w.app || '')) || /notepad/i.test(String(w.title || '')));
}

function pixelVariety(img) {
  // Distinct colours on a coarse grid: a black (no session) or blank capture has 1.
  const seen = new Set();
  const stepX = Math.max(1, Math.floor(img.width / 64));
  const stepY = Math.max(1, Math.floor(img.height / 48));
  for (let y = 0; y < img.height; y += stepY) {
    for (let x = 0; x < img.width; x += stepX) {
      const o = (y * img.width + x) * 4;
      seen.add((img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2]);
    }
  }
  return seen.size;
}

describe('live-desktop: Windows (real driver, Computer, CLI, MCP)', { skip }, () => {
  let OUT;
  let HOME;
  let osIndex;
  let png;
  let Computer;
  let driver;
  let displays;
  let notepad = null; // window record
  let notepadChild = null;
  let preexisting = new Set();
  const logLines = [];

  const note = (t, ...parts) => {
    const line = parts.map(show).join(' ');
    logLines.push(line);
    if (t && typeof t.diagnostic === 'function') t.diagnostic(line);
    else process.stderr.write(`# ${line}\n`);
  };

  async function snap(t, name) {
    try {
      const cap = await driver.captureDisplay(0);
      fs.writeFileSync(path.join(OUT, name), cap.png);
      note(t, `saved ${name} (${cap.width}x${cap.height})`);
    } catch (err) {
      note(t, `could not save ${name}: ${err.message}`);
    }
  }

  async function windowsNow() {
    return (await driver.listWindows()) || [];
  }

  async function ensureNotepadFocused(t) {
    assert.ok(notepad, 'Notepad was not started');
    for (let i = 0; i < 3; i++) {
      const ok = await driver.focusWindow(notepad.id);
      await sleep(250);
      const aw = await driver.activeWindow();
      if (ok && aw && (aw.id === notepad.id || isNotepad(aw))) return aw;
      note(t, `focus attempt ${i + 1}: focusWindow=${ok}, active=`, aw);
    }
    const aw = await driver.activeWindow();
    assert.fail(`could not focus Notepad ${show(notepad)}; active window is ${show(aw)}`);
  }

  /** Select all in Notepad, copy, and return the clipboard text (CRLF as LF). */
  async function copyNotepadText(t) {
    const sentinel = `sentinel-${Date.now()}`;
    await driver.clipboardSet(sentinel);
    await driver.keyCombo(['ctrl', 'a']);
    await sleep(150);
    await driver.keyCombo(['ctrl', 'c']);
    const text = await waitFor(async () => {
      const s = await driver.clipboardGet();
      return s !== sentinel ? s : null;
    }, 4000, 150);
    note(t, 'Notepad text via ctrl+a, ctrl+c:', text);
    return text == null ? null : text.replace(/\r\n/g, '\n');
  }

  function killNotepad() {
    if (notepadChild && notepadChild.exitCode === null) {
      try {
        notepadChild.kill();
      } catch {
        /* already gone */
      }
    }
    spawnSync('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  }

  before(async () => {
    OUT = process.env.ANYWHERE_LIVE_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-live-out-'));
    fs.mkdirSync(OUT, { recursive: true });
    HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-live-home-'));
    process.env.ANYWHERE_HOME = HOME;
    delete process.env.ANYWHERE_DRIVER;
    osIndex = require('../src/os/index');
    png = require('../src/os/png');
    ({ Computer } = require('../src/os/computer'));
    await osIndex.resetDriver();
    driver = await osIndex.getDriver();
  });

  after(async () => {
    try {
      killNotepad();
    } catch {
      /* ignore */
    }
    try {
      if (driver) await snap(null, '99-final.png');
    } catch {
      /* ignore */
    }
    if (osIndex) await osIndex.resetDriver();
    try {
      fs.writeFileSync(path.join(OUT, 'live-desktop-win32.log'), `${logLines.join('\n')}\n`);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(HOME, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('live-desktop: capabilities and displays', { timeout: 90000 }, async (t) => {
    note(t, 'driver:', driver.name, driver.reason || '', driver.hint || '');
    assert.equal(driver.name, 'win32', `expected the win32 driver, got ${driver.name}: ${driver.reason || ''}`);
    const info = await driver.hostInfo();
    note(t, 'host:', info);
    assert.equal(info.windows, true);
    assert.equal(info.native, true, info.nativeError || 'native bridge failed');
    assert.equal(info.sta, true, 'host runs in STA (clipboard)');
    const caps = await driver.capabilities();
    note(t, 'capabilities:', caps);
    for (const k of ['screenshot', 'mouse', 'keyboard', 'windows', 'clipboard']) assert.equal(caps[k], true, `capability ${k}`);

    displays = await driver.displays();
    note(t, 'displays:', displays);
    assert.ok(Array.isArray(displays) && displays.length >= 1, 'at least one display');
    const primary = displays.filter((d) => d.primary);
    assert.equal(primary.length, 1, 'exactly one primary display');
    assert.equal(displays[0].primary, true, 'the primary display comes first');
    assert.deepEqual([primary[0].x, primary[0].y], [0, 0], 'the primary display is at the origin');
    for (const d of displays) {
      for (const k of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(d[k]), `display ${d.index}.${k} is an integer: ${d[k]}`);
      assert.ok(d.width >= 320 && d.width <= 16384 && d.height >= 200 && d.height <= 16384, `sane size ${d.width}x${d.height}`);
      assert.ok(d.dpiScale >= 1 && d.dpiScale <= 5, `sane dpiScale ${d.dpiScale}`);
    }
  });

  it('live-desktop: captureDisplay(0) is a real PNG of the display', { timeout: 90000 }, async (t) => {
    const cap = await driver.captureDisplay(0);
    assert.ok(Buffer.isBuffer(cap.png));
    assert.ok(cap.png.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature');
    fs.writeFileSync(path.join(OUT, '01-capture-display0.png'), cap.png);
    const d = displays[0];
    assert.deepEqual([cap.width, cap.height], [d.width, d.height], 'capture size = display size (physical px)');
    const hdr = png.readHeader(cap.png);
    assert.deepEqual([hdr.width, hdr.height], [cap.width, cap.height]);
    const img = png.decode(cap.png);
    assert.equal(img.data.length, img.width * img.height * 4);
    const colours = pixelVariety(img);
    note(t, `capture ${cap.width}x${cap.height}, ${cap.png.length} bytes, ${colours} distinct sampled colours`);
    assert.ok(colours > 1, 'the capture is not a single colour (is there an interactive desktop?)');
  });

  it('live-desktop: moveMouse and cursorPosition round-trip', { timeout: 60000 }, async (t) => {
    const d = displays[0];
    const points = [
      [d.x + Math.floor(d.width / 2), d.y + Math.floor(d.height / 2)],
      [d.x + 100, d.y + 120],
      [d.x + d.width - 60, d.y + d.height - 90],
      [d.x + 333, d.y + 222],
    ];
    for (const [x, y] of points) {
      await driver.moveMouse(x, y);
      const p = await driver.cursorPosition();
      note(t, `moveMouse(${x}, ${y}) -> cursor (${p.x}, ${p.y})`);
      assert.ok(near(p.x, x, 2) && near(p.y, y, 2), `cursor ${show(p)} != (${x}, ${y})`);
    }
  });

  it('live-desktop: start Notepad, find it with listWindows and focus it', { timeout: 90000 }, async (t) => {
    const before0 = await windowsNow();
    note(t, `windows before Notepad (${before0.length}):`, before0.map((w) => ({ id: w.id, app: w.app, process: w.process, title: w.title, focused: w.focused })));
    preexisting = new Set(before0.filter(isNotepad).map((w) => w.id));
    notepadChild = spawn('notepad.exe', [], { stdio: 'ignore' });
    notepadChild.on('error', (err) => note(null, `notepad spawn error: ${err.message}`));
    note(t, `spawned notepad.exe pid ${notepadChild.pid}`);
    notepad = await waitFor(async () => {
      const list = await windowsNow();
      const mine = list.filter((w) => isNotepad(w) && !preexisting.has(w.id));
      return mine.find((w) => w.pid === notepadChild.pid) || mine[0] || null;
    }, 30000, 300);
    if (!notepad) {
      const list = await windowsNow();
      note(t, 'no Notepad window; windows now:', list);
      await snap(t, '02-notepad-missing.png');
    }
    assert.ok(notepad, 'a Notepad window appeared');
    note(t, 'Notepad window:', notepad, `spawned pid ${notepadChild.pid}`);
    assert.ok(notepad.width > 100 && notepad.height > 100, `Notepad has a real size: ${notepad.width}x${notepad.height}`);
    const aw = await ensureNotepadFocused(t);
    note(t, 'active after focus:', aw);
    // Give a just-started Notepad (new Notepad restores tabs) a moment to settle.
    await sleep(700);
    await snap(t, '02-notepad-focused.png');
  });

  it('live-desktop: activeWindow reports Notepad', { timeout: 30000 }, async (t) => {
    await ensureNotepadFocused(t);
    const aw = await driver.activeWindow();
    note(t, 'activeWindow:', aw);
    assert.ok(aw, 'there is an active window');
    assert.ok(typeof aw.id === 'string' && /^\d+$/.test(aw.id), `window id is a decimal string: ${aw.id}`);
    assert.ok(aw.pid > 0, 'active window has a pid');
    // Classic Notepad: our child's pid and notepad.exe. Windows 11 Notepad: the app alias starts the
    // packaged Notepad.exe, whose pid differs from the spawned one; its title still says Notepad.
    assert.ok(aw.id === notepad.id || isNotepad(aw), `active window is Notepad: ${show(aw)}`);
    assert.ok(/notepad/i.test(`${aw.app} ${aw.title}`), `app/title name Notepad: ${show(aw)}`);
  });

  it('live-desktop: typeText (unicode SendInput), ctrl+a, ctrl+c and clipboardGet', { timeout: 60000 }, async (t) => {
    await ensureNotepadFocused(t);
    const r = await driver.typeText(TYPED);
    note(t, 'typeText result:', r === undefined ? 'undefined' : r);
    await sleep(400);
    await snap(t, '03-typed.png');
    const text = await copyNotepadText(t);
    assert.equal(text, TYPED, 'the clipboard holds exactly the typed text');
  });

  it('live-desktop: clipboardSet/clipboardGet round-trip with unicode', { timeout: 30000 }, async (t) => {
    const samples = ['plain ascii', 'ü€ 日本語 Ελληνικά', 'emoji 🎉 astral 𝄞', 'quotes "double" \'single\' back\\slash <&> \t tab', 'line1\nline2\nline3'];
    for (const s of samples) {
      await driver.clipboardSet(s);
      const got = await driver.clipboardGet();
      note(t, 'clipboard round-trip:', { set: s, got });
      assert.equal(got.replace(/\r\n/g, '\n'), s);
    }
    await driver.clipboardSet('');
    assert.equal(await driver.clipboardGet(), '', 'an empty clipboard reads as ""');
  });

  it('live-desktop: click into Notepad at a screenshot-space point and type more', { timeout: 60000 }, async (t) => {
    await ensureNotepadFocused(t);
    // A small maxWidth forces a downscaled screenshot, so the mapping is not the identity.
    const computer = new Computer({ driver, config: { maxWidth: 800, maxHeight: 600, actionDelayMs: 100 }, platform: 'win32' });
    const shot = await computer.screenshot();
    fs.writeFileSync(path.join(OUT, '04-computer-shot.png'), shot.png);
    const hdr = png.readHeader(shot.png);
    note(t, 'Computer screenshot:', { width: shot.width, height: shot.height, scale: shot.scale, native: shot.native, cursor: shot.cursor });
    assert.deepEqual([hdr.width, hdr.height], [shot.width, shot.height]);
    assert.ok(shot.width <= 800 && shot.height <= 600, 'downscaled to fit 800x600');
    const fit = png.fitWithin(displays[0].width, displays[0].height, 800, 600);
    assert.deepEqual([shot.width, shot.height], [fit.width, fit.height]);

    const w = (await windowsNow()).find((x) => x.id === notepad.id) || notepad;
    note(t, 'Notepad rect now:', { x: w.x, y: w.y, width: w.width, height: w.height });
    // The text area: horizontally centred, 60% down (below the menu/tab bar, above the status bar).
    const lx = w.x + Math.round(w.width / 2);
    const ly = w.y + Math.round(w.height * 0.6);
    const s = computer.toShot(0, lx, ly);
    note(t, `target logical (${lx}, ${ly}) -> screenshot (${s.x}, ${s.y})`);
    const res = await computer.click({ x: s.x, y: s.y });
    note(t, 'click result:', res);
    assert.equal(res.ok, true);
    const tol = Math.ceil(shot.scale) + 1;
    assert.ok(near(res.logical.x, lx, tol) && near(res.logical.y, ly, tol), `click landed at ${show(res.logical)}, wanted (${lx}, ${ly}) within ${tol}px`);
    const p = await driver.cursorPosition();
    assert.ok(near(p.x, res.logical.x, 1) && near(p.y, res.logical.y, 1), `cursor ${show(p)} is where Computer clicked ${show(res.logical)}`);
    const pos = await computer.cursorPosition();
    assert.ok(near(pos.x, s.x, 1) && near(pos.y, s.y, 1), `Computer.cursorPosition ${show(pos)} maps back to (${s.x}, ${s.y})`);

    const aw = await driver.activeWindow();
    assert.ok(aw && (aw.id === notepad.id || isNotepad(aw)), `Notepad is still active after the click: ${show(aw)}`);
    const typed = await computer.typeText({ text: CLICKED, method: 'keys' });
    note(t, 'Computer.typeText:', typed);
    assert.equal(typed.ok, true);
    await sleep(300);
    await snap(t, '05-clicked-typed.png');
    const text = await copyNotepadText(t);
    assert.ok(text && text.includes(TYPED), `Notepad still holds the first text: ${show(text)}`);
    assert.ok(text.includes(CLICKED.trim()), `the text typed after the click arrived: ${show(text)}`);
  });

  it('live-desktop: Computer paste path types multi-line text and restores the clipboard', { timeout: 60000 }, async (t) => {
    await ensureNotepadFocused(t);
    const computer = new Computer({ driver, config: { actionDelayMs: 100 }, platform: 'win32' });
    await computer.key({ combo: 'ctrl+end' });
    await driver.clipboardSet('saved-user-clipboard ü');
    const res = await computer.typeText({ text: '\npasted line A\npasted line B ü€', method: 'auto' });
    note(t, 'paste typeText result:', res);
    assert.equal(res.method, 'paste', 'multi-line text is pasted');
    const restored = await driver.clipboardGet();
    note(t, 'clipboard after paste:', restored);
    assert.equal(restored, 'saved-user-clipboard ü', "the user's clipboard is restored after pasting");
    await sleep(200);
    const text = await copyNotepadText(t);
    assert.ok(text && text.includes('pasted line A\npasted line B ü€'), `the pasted text arrived: ${show(text)}`);
    await snap(t, '06-pasted.png');
  });

  it('live-desktop: scroll, drag, mouseDown/mouseUp do not throw', { timeout: 60000 }, async (t) => {
    await ensureNotepadFocused(t);
    const computer = new Computer({ driver, config: { actionDelayMs: 80 }, platform: 'win32' });
    await computer.screenshot();
    const w = (await windowsNow()).find((x) => x.id === notepad.id) || notepad;
    const a = computer.toShot(0, w.x + Math.round(w.width * 0.3), w.y + Math.round(w.height * 0.5));
    const b = computer.toShot(0, w.x + Math.round(w.width * 0.6), w.y + Math.round(w.height * 0.55));
    const down = await computer.scroll({ x: a.x, y: a.y, direction: 'down', amount: 3 });
    const up = await computer.scroll({ x: a.x, y: a.y, direction: 'up', amount: 2 });
    const side = await computer.scroll({ direction: 'right', amount: 1 });
    note(t, 'scrolls:', { down, up, side });
    for (const r of [down, up, side]) assert.equal(r.ok, true);
    const drag = await computer.drag({ fromX: a.x, fromY: a.y, toX: b.x, toY: b.y });
    note(t, 'drag:', drag);
    assert.equal(drag.ok, true);
    const p = await driver.cursorPosition();
    assert.ok(near(p.x, drag.logicalTo.x, 1) && near(p.y, drag.logicalTo.y, 1), `drag ended at ${show(drag.logicalTo)}, cursor ${show(p)}`);
    await driver.mouseDown('left');
    await sleep(50);
    await driver.mouseUp('left');
    await snap(t, '07-after-drag.png');
  });

  it('live-desktop: close Notepad without saving', { timeout: 60000 }, async (t) => {
    assert.ok(notepad, 'Notepad was started');
    killNotepad();
    const gone = await waitFor(async () => !(await windowsNow()).some((w) => w.id === notepad.id), 15000, 300);
    if (!gone) {
      note(t, 'Notepad is still open:', (await windowsNow()).filter(isNotepad));
      await snap(t, '08-notepad-still-open.png');
    }
    assert.ok(gone, 'the Notepad window closed');
    const left = (await windowsNow()).filter((w) => isNotepad(w) && !preexisting.has(w.id));
    assert.deepEqual(left, [], 'no Notepad window of ours is left (no save prompt)');
    notepad = null;
  });

  it('live-desktop: CLI `computer screenshot --out` writes a PNG and prints JSON', { timeout: 120000 }, async (t) => {
    const file = path.join(HOME, 'cli-shot.png');
    const env = { ...process.env, ANYWHERE_HOME: HOME };
    delete env.ANYWHERE_DRIVER;
    const r = spawnSync(process.execPath, [CLI, 'computer', 'screenshot', '--out', file], { env, encoding: 'utf8', timeout: 110000, windowsHide: true });
    note(t, `CLI exit ${r.status}${r.error ? ` (${r.error.message})` : ''}; stdout: ${r.stdout}; stderr: ${r.stderr}`);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(path.resolve(out.path), path.resolve(file));
    assert.ok(out.width > 0 && out.height > 0 && out.display === 0, show(out));
    const buf = fs.readFileSync(file);
    assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), 'the CLI wrote a PNG');
    const hdr = png.readHeader(buf);
    assert.deepEqual([hdr.width, hdr.height], [out.width, out.height]);
    fs.copyFileSync(file, path.join(OUT, '09-cli-screenshot.png'));

    const caps = spawnSync(process.execPath, [CLI, 'computer', 'capabilities'], { env, encoding: 'utf8', timeout: 110000, windowsHide: true });
    note(t, `CLI capabilities exit ${caps.status}; stdout: ${caps.stdout}; stderr: ${caps.stderr}`);
    assert.equal(caps.status, 0, caps.stderr || caps.stdout);
    const c = JSON.parse(caps.stdout);
    assert.equal(c.driver, 'win32');
    assert.equal(c.screenshot, true);
  });

  it('live-desktop: MCP server screenshot tool returns an image', { timeout: 120000 }, async (t) => {
    const env = { ...process.env, ANYWHERE_HOME: HOME };
    for (const k of ['ANYWHERE_DRIVER', 'ANYWHERE_DAEMON_URL', 'ANYWHERE_TOKEN', 'ANYWHERE_ROLE', 'ANYWHERE_ENGINE_CHILD']) delete env[k];
    const child = spawn(process.execPath, [MCP_SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const pending = new Map();
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
          note(t, `MCP non-JSON stdout: ${line.slice(0, 200)}`);
          continue;
        }
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    let nextId = 1;
    const request = (method, params, ms = 60000) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP: no response to ${method} within ${ms} ms; stderr: ${stderr.slice(-2000)}`));
        }, ms);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    try {
      const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-desktop-test', version: '1' } });
      assert.ok(init.result && init.result.serverInfo, show(init));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const res = await request('tools/call', { name: 'screenshot', arguments: {} }, 90000);
      const result = res.result || {};
      const content = Array.isArray(result.content) ? result.content : [];
      note(t, 'MCP screenshot:', { isError: result.isError, content: content.map((c) => (c.type === 'image' ? { type: c.type, mimeType: c.mimeType, bytes: c.data.length } : c)) });
      assert.ok(!result.isError, `screenshot tool failed: ${show(content)}; stderr: ${stderr.slice(-2000)}`);
      const image = content.find((c) => c.type === 'image');
      assert.ok(image, 'an image content block');
      assert.equal(image.mimeType, 'image/png');
      const data = Buffer.from(image.data, 'base64');
      assert.ok(data.subarray(0, 8).equals(PNG_SIGNATURE), 'MCP image is a PNG');
      const hdr = png.readHeader(data);
      assert.ok(hdr.width > 0 && hdr.height > 0);
      fs.writeFileSync(path.join(OUT, '10-mcp-screenshot.png'), data);
      const text = content.find((c) => c.type === 'text');
      assert.ok(text && /\d+x\d+/.test(text.text), 'a text block describing the shot');
    } finally {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      const done = await Promise.race([exited, sleep(10000).then(() => null)]);
      if (!done) child.kill();
      note(t, `MCP server exit: ${show(done)}`);
    }
  });
});
