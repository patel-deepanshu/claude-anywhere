'use strict';

// Live Windows desktop: drives the REAL desktop through the real win32 driver (the persistent
// PowerShell host), Computer, the `anywhere computer` CLI, the MCP server and src/os/common.js.
// Opt-in: it runs only on Windows with ANYWHERE_LIVE_DESKTOP=1 (CI job "Live desktop
// (windows-latest)"), because it moves the mouse, types into Notepad, overwrites the clipboard and
// ends every notepad.exe at the end. Screenshots of key steps go to ANYWHERE_LIVE_OUT.
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
  let notepad = null; // window record of the Notepad these tests type into
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

  /** Focus Notepad and delete everything in it. */
  async function clearNotepad(t) {
    await ensureNotepadFocused(t);
    await driver.keyCombo(['ctrl', 'a']);
    await driver.keyCombo(['delete']);
    await sleep(150);
  }

  /** Select all in the focused Notepad, copy, and return the clipboard text (CRLF as LF). */
  async function copyNotepadText(t) {
    const sentinel = `sentinel-${Date.now()}`;
    await driver.clipboardSet(sentinel);
    await driver.keyCombo(['ctrl', 'a']);
    await sleep(150);
    await driver.keyCombo(['ctrl', 'c']);
    // Notepad's edit control is slow with long lines (each typed character re-lays out the line),
    // so the copy can come several seconds after the keystrokes were queued.
    const got = await waitFor(async () => {
      const s = await driver.clipboardGet();
      return s !== sentinel ? { s } : null;
    }, 15000, 150);
    const text = got ? got.s : null;
    note(t, 'Notepad text via ctrl+a, ctrl+c:', text == null ? '(clipboard unchanged: nothing was copied)' : text.length > 300 ? `${text.slice(0, 300)}... (${text.length} chars)` : text);
    return text == null ? null : text.replace(/\r\n/g, '\n');
  }

  /** Where two strings first differ, with code points around it (for typing diagnostics). */
  function firstDiff(actual, expected) {
    const a = String(actual == null ? '' : actual);
    let i = 0;
    while (i < a.length && i < expected.length && a[i] === expected[i]) i++;
    if (i === a.length && i === expected.length) return 'identical';
    const codes = (s) => Array.from(s.slice(Math.max(0, i - 3), i + 6)).map((c) => c.codePointAt(0).toString(16)).join(' ');
    return `lengths ${a.length}/${expected.length}, first difference at ${i}: actual [${codes(a)}] expected [${codes(expected)}]`;
  }

  /**
   * Ground truth for a failed typing check, read without the clipboard: each child control of the
   * window with its class, WM_GETTEXTLENGTH, EM_GETSEL and the ends of its text, plus the formats
   * on the clipboard. Diagnostics only (a separate Windows PowerShell, not the product's host).
   */
  function windowDiagnostics(hwnd) {
    const script = `
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class LiveDiag {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", EntryPoint = "SendMessageW")] static extern IntPtr Send(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode)] static extern IntPtr SendSb(IntPtr h, int m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint f);
  public static string Run(long hwnd) {
    StringBuilder o = new StringBuilder();
    EnumProc cb = delegate(IntPtr h, IntPtr l) {
      StringBuilder c = new StringBuilder(256); GetClassName(h, c, 256);
      int len = (int)Send(h, 0x000E, IntPtr.Zero, IntPtr.Zero);
      StringBuilder t = new StringBuilder(len + 2); SendSb(h, 0x000D, new IntPtr(len + 1), t);
      long sel = Send(h, 0x00B0, IntPtr.Zero, IntPtr.Zero).ToInt64();
      string s = t.ToString();
      string ends = s.Length > 60 ? s.Substring(0, 25) + " ... " + s.Substring(s.Length - 25) : s;
      o.Append("child " + c + " len=" + len + " sel=" + (sel & 0xFFFF) + ".." + ((sel >> 16) & 0xFFFF) + " text=[" + ends + "]\\n");
      return true;
    };
    EnumChildWindows(new IntPtr(hwnd), cb, IntPtr.Zero);
    GC.KeepAlive(cb);
    if (OpenClipboard(IntPtr.Zero)) {
      List<string> f = new List<string>(); uint x = 0;
      while ((x = EnumClipboardFormats(x)) != 0) f.Add(x.ToString());
      CloseClipboard();
      o.Append("clipboard formats: " + string.Join(",", f.ToArray()));
    } else o.Append("clipboard: could not open");
    return o.ToString();
  }
}
'@
[Console]::Out.WriteLine([LiveDiag]::Run(${Number(hwnd)}))
`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    return `${String(r.stdout || '').trim()}${r.stderr ? ` stderr: ${require('../src/shared/proc').psErrorText(r.stderr).slice(0, 800)}` : ''}`;
  }

  /**
   * Read the clipboard from another process (not the product's host), waiting at most 1 s to open
   * it: {text} or {busy, holder} when some program keeps it open.
   */
  function externalClipboard() {
    const script = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Threading;
public static class LiveClip {
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint f);
  [DllImport("user32.dll")] static extern IntPtr GetOpenClipboardWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr m);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr m);
  public static string Read() {
    for (int i = 0; i < 50; i++) {
      if (OpenClipboard(IntPtr.Zero)) {
        try {
          IntPtr h = GetClipboardData(13);
          if (h == IntPtr.Zero) return "TEXT:";
          IntPtr p = GlobalLock(h);
          try { return "TEXT:" + Marshal.PtrToStringUni(p); } finally { GlobalUnlock(h); }
        } finally { CloseClipboard(); }
      }
      Thread.Sleep(20);
    }
    uint pid = 0; IntPtr w = GetOpenClipboardWindow();
    if (w != IntPtr.Zero) GetWindowThreadProcessId(w, out pid);
    return "BUSY:" + pid;
  }
}
'@
$r = [LiveClip]::Read()
[Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($r)))
`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    const out = Buffer.from(String(r.stdout || '').trim(), 'base64').toString('utf8');
    if (out.startsWith('TEXT:')) return { text: out.slice(5) };
    if (out.startsWith('BUSY:')) return { busy: true, holderPid: Number(out.slice(5)) };
    return { error: `${r.stdout || ''} ${require('../src/shared/proc').psErrorText(r.stderr || '')}`.trim() };
  }

  /** Type into a cleared Notepad, copy it back and compare. */
  async function typeAndCompare(t, text, label) {
    await clearNotepad(t);
    const started = Date.now();
    const r = await driver.typeText(text);
    note(t, `${label}: typed ${text.length} UTF-16 units in ${Date.now() - started} ms; result ${show(r === undefined ? null : r)}`);
    await sleep(500);
    note(t, `${label}: active window after typing:`, await driver.activeWindow());
    note(t, `${label}: before copying: ${windowDiagnostics(notepad.id)}`);
    await snap(t, `${label}.png`);
    const got = await copyNotepadText(t);
    if (got !== text) {
      note(t, `${label}: ${firstDiff(got, text)}`);
      note(t, `${label}: after copying: ${windowDiagnostics(notepad.id)}`);
    }
    return got;
  }

  async function newNotepadWindows() {
    return (await windowsNow()).filter((w) => isNotepad(w) && !preexisting.has(w.id));
  }

  function killNotepads() {
    if (notepadChild && notepadChild.exitCode === null) {
      try {
        notepadChild.kill();
      } catch {
        /* already gone */
      }
    }
    // Windows 11 Notepad (and anything openTarget started) is not our child: end it by name.
    spawnSync('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  }

  function cli(t, args, timeout = 110000) {
    const env = { ...process.env, ANYWHERE_HOME: HOME };
    for (const k of ['ANYWHERE_DRIVER', 'ANYWHERE_DAEMON_URL', 'ANYWHERE_TOKEN']) delete env[k];
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout, windowsHide: true });
    note(t, `anywhere ${args.join(' ')} -> exit ${r.status}${r.error ? ` (${r.error.message})` : ''}; stdout: ${String(r.stdout || '').slice(0, 1500)}${r.stderr ? `; stderr: ${r.stderr.slice(0, 1500)}` : ''}`);
    assert.equal(r.status, 0, `anywhere ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout);
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
      killNotepads();
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
    assert.match(String(info.dpi), /^permonitor/, 'the host is per-monitor DPI aware');
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
    await assert.rejects(driver.captureDisplay(displays.length), (e) => e.code === 'BAD_DISPLAY', 'a missing display is refused');
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

  it('live-desktop: the failsafe stops Computer while the pointer is parked top-left', { timeout: 60000 }, async (t) => {
    const computer = new Computer({ driver, config: { actionDelayMs: 0 }, platform: 'win32' });
    await driver.moveMouse(0, 0); // as if the user slammed the pointer into the corner
    const p = await driver.cursorPosition();
    note(t, 'pointer parked at', p);
    await assert.rejects(computer.moveMouse({ x: 300, y: 300 }), (e) => e.code === 'FAILSAFE', 'FAILSAFE while the pointer is top-left');
    await driver.moveMouse(400, 300);
    const r = await computer.moveMouse({ x: 300, y: 300 });
    assert.equal(r.ok, true);
    const q = await driver.cursorPosition();
    assert.ok(near(q.x, 300, 1) && near(q.y, 300, 1), `moved after the pointer left the corner: ${show(q)}`);
  });

  it('live-desktop: start Notepad, find it with listWindows and focus it', { timeout: 90000 }, async (t) => {
    const before0 = await windowsNow();
    note(t, `windows before Notepad (${before0.length}):`, before0.map((w) => ({ id: w.id, app: w.app, process: w.process, title: w.title, focused: w.focused })));
    preexisting = new Set(before0.filter(isNotepad).map((w) => w.id));
    notepadChild = spawn('notepad.exe', [], { stdio: 'ignore' });
    notepadChild.on('error', (err) => note(null, `notepad spawn error: ${err.message}`));
    note(t, `spawned notepad.exe pid ${notepadChild.pid}`);
    notepad = await waitFor(async () => {
      const mine = await newNotepadWindows();
      return mine.find((w) => w.pid === notepadChild.pid) || mine[0] || null;
    }, 30000, 300);
    if (!notepad) {
      note(t, 'no Notepad window; windows now:', await windowsNow());
      await snap(t, '02-notepad-missing.png');
    }
    assert.ok(notepad, 'a Notepad window appeared');
    note(t, 'Notepad window:', notepad, `spawned pid ${notepadChild.pid}`);
    assert.ok(notepad.width > 100 && notepad.height > 100, `Notepad has a real size: ${notepad.width}x${notepad.height}`);
    assert.ok(/^\d+$/.test(notepad.id), `window ids are decimal strings: ${notepad.id}`);
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
    await clearNotepad(t);
    const r = await driver.typeText(TYPED);
    note(t, 'typeText result:', r === undefined ? 'undefined' : r);
    await sleep(400);
    await snap(t, '03-typed.png');
    const text = await copyNotepadText(t);
    assert.equal(text, TYPED, 'the clipboard holds exactly the typed text');
  });

  it('live-desktop: clipboardSet/clipboardGet round-trip with unicode', { timeout: 30000 }, async (t) => {
    const samples = ['plain ascii', 'ü€ 日本語 Ελληνικά', 'emoji 🎉 astral 𝄞', 'quotes "double" \'single\' back\\slash <&> \t tab', 'line1\nline2\nline3', ' leading and trailing spaces  '];
    for (const s of samples) {
      await driver.clipboardSet(s);
      const got = await driver.clipboardGet();
      note(t, 'clipboard round-trip:', { set: s, got });
      assert.equal(got.replace(/\r\n/g, '\n'), s);
    }
    await driver.clipboardSet('');
    assert.equal(await driver.clipboardGet(), '', 'an empty clipboard reads as ""');
  });

  it('live-desktop: after the host sets the clipboard, a copy in another app does not wait for the host', { timeout: 60000 }, async (t) => {
    await clearNotepad(t);
    await driver.typeText('copied-by-notepad-42');
    await sleep(300);
    await driver.clipboardSet('set by the host ü'); // the host is the last program that wrote the clipboard
    await driver.keyCombo(['ctrl', 'a']);
    await driver.keyCombo(['ctrl', 'c']);
    // The host is now idle (blocked on stdin). Notepad's copy must finish without its help.
    await sleep(1500);
    const ext = externalClipboard();
    note(t, 'clipboard read by another process:', ext);
    assert.ok(!ext.busy, `the clipboard is still held open (by pid ${ext.holderPid}): Notepad's copy is waiting for the host`);
    assert.equal(ext.text, 'copied-by-notepad-42', "Notepad's copy completed while the host was idle");
    assert.equal(await driver.clipboardGet(), 'copied-by-notepad-42');
  });

  it('live-desktop: click into Notepad at a screenshot-space point and type more', { timeout: 60000 }, async (t) => {
    await clearNotepad(t);
    await driver.typeText(TYPED);
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
    // Clicking below the last line puts the caret at the end of the text.
    assert.equal(text, `${TYPED}${CLICKED}`, 'the text typed after the click arrived after the first text');
  });

  it('live-desktop: Computer paste path types multi-line text and restores the clipboard', { timeout: 60000 }, async (t) => {
    await clearNotepad(t);
    const computer = new Computer({ driver, config: { actionDelayMs: 100 }, platform: 'win32' });
    await driver.clipboardSet('saved-user-clipboard ü');
    const res = await computer.typeText({ text: 'pasted line A\npasted line B ü€ 🎉', method: 'auto' });
    note(t, 'paste typeText result:', res);
    assert.equal(res.method, 'paste', 'multi-line text is pasted');
    const restored = await driver.clipboardGet();
    note(t, 'clipboard after paste:', restored);
    assert.equal(restored, 'saved-user-clipboard ü', "the user's clipboard is restored after pasting");
    await sleep(200);
    const text = await copyNotepadText(t);
    assert.equal(text, 'pasted line A\npasted line B ü€ 🎉', 'the pasted text arrived');
    await snap(t, '06-pasted.png');
  });

  it('live-desktop: key combos with named, extended and shifted keys; tab and newline typing', { timeout: 60000 }, async (t) => {
    await clearNotepad(t);
    const computer = new Computer({ driver, config: { actionDelayMs: 40 }, platform: 'win32' });
    await driver.typeText('abc');
    await computer.key({ combo: 'shift+a' }); // A
    await computer.key({ combo: '?' }); // shift+/ on a US layout
    await computer.key({ combo: 'left' }); // extended arrow key: caret before '?'
    await computer.key({ combo: 'backspace' }); // deletes 'A'
    await computer.key({ combo: 'home' });
    await driver.typeText('X');
    await computer.key({ combo: 'end' });
    await computer.key({ combo: 'b' }); // lower case: no modifier was left pressed
    await computer.key({ combo: 'enter' });
    await driver.typeText('t1\tt2\nline3');
    await computer.key({ combo: 'left', repeat: 3 });
    await computer.key({ combo: 'primary+shift+end' }); // select "ne3"
    await computer.key({ combo: 'delete' });
    const text = await copyNotepadText(t);
    assert.equal(text, 'Xabc?b\nt1\tt2\nli');
  });

  it('live-desktop: typeText of astral characters (surrogate pairs) through SendInput', { timeout: 60000 }, async (t) => {
    const text = 'astral 🎉 ok 𝄞 end';
    const got = await typeAndCompare(t, text, '06b-astral');
    assert.equal(got, text);
  });

  it('live-desktop: a 1000-character typed line arrives whole', { timeout: 120000 }, async (t) => {
    // Within one driver chunk (1000 UTF-16 units), but many 64-character SendInput batches.
    const text = 'klmnopqrst'.repeat(100);
    const got = await typeAndCompare(t, text, '06c0-line-1000');
    assert.equal(got, text);
  });

  it('live-desktop: long typed ASCII text is chunked without losing characters', { timeout: 120000 }, async (t) => {
    // Longer than the driver's 1000-unit chunk and the host's 64-character SendInput batches.
    const text = `${'abcdefghij'.repeat(130)} end`;
    const got = await typeAndCompare(t, text, '06c-long-ascii');
    assert.ok(got != null, 'copied something');
    assert.equal(got.length, text.length, 'same length');
    assert.equal(got, text);
  });

  it('live-desktop: a surrogate pair on the chunk boundary of long typed text stays whole', { timeout: 120000 }, async (t) => {
    // 'x' * 999 puts the emoji's surrogate pair across the driver's 1000-unit chunk boundary.
    const text = `${'x'.repeat(999)}🎉${'y'.repeat(300)} ü€ 日本 end`;
    const got = await typeAndCompare(t, text, '06d-long-astral');
    assert.ok(got != null, 'copied something');
    assert.equal(got, text);
  });

  it('live-desktop: scroll, drag, mouseDown/mouseUp and a region zoom', { timeout: 60000 }, async (t) => {
    await clearNotepad(t);
    await driver.typeText('drag over this text to select some of it\n'.repeat(40));
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
    // The drag selected text: copying it gives a non-empty part of what was typed.
    await driver.clipboardSet('before-drag-copy');
    await driver.keyCombo(['ctrl', 'c']);
    const sel = await waitFor(async () => {
      const s = await driver.clipboardGet();
      return s !== 'before-drag-copy' ? s : null;
    }, 3000, 150);
    note(t, 'drag selection:', sel);
    assert.ok(sel && sel.length > 0 && 'drag over this text to select some of it\r\n'.repeat(40).includes(sel), `the drag selected text: ${show(sel)}`);
    await snap(t, '07-after-drag.png');
    await driver.mouseDown('left');
    await sleep(50);
    await driver.mouseUp('left');

    const zoom = await computer.screenshot({ region: { x: 10, y: 10, width: 200, height: 100 } });
    fs.writeFileSync(path.join(OUT, '07-zoom.png'), zoom.png);
    note(t, 'zoom:', { width: zoom.width, height: zoom.height, region: zoom.region, scale: zoom.scale });
    assert.deepEqual(zoom.region, { x: 10, y: 10, width: 200, height: 100 });
    assert.ok(zoom.width >= 200 && zoom.height >= 100, 'the zoom is at least as sharp as the region');
  });

  it('live-desktop: minimizeWindow, focusWindow restores it, setTopmost', { timeout: 60000 }, async (t) => {
    assert.equal(await driver.minimizeWindow(notepad.id), true, 'minimizeWindow');
    const w1 = (await windowsNow()).find((w) => w.id === notepad.id);
    note(t, 'minimized:', w1);
    assert.ok(w1 && w1.minimized === true, 'listed as minimized');
    assert.ok(w1.width > 100 && w1.height > 100, 'a minimized window keeps its normal size');
    await snap(t, '08-minimized.png');
    assert.equal(await driver.focusWindow(notepad.id), true, 'focusWindow restores and focuses it');
    await sleep(300);
    const w2 = (await windowsNow()).find((w) => w.id === notepad.id);
    note(t, 'restored:', w2);
    assert.ok(w2 && !w2.minimized && w2.focused, 'restored and focused');
    assert.equal(await driver.setTopmost(notepad.id, true), true, 'setTopmost on');
    assert.equal(await driver.setTopmost(notepad.id, false), true, 'setTopmost off');
    assert.equal(await driver.focusWindow('0'), false, 'focusWindow(0) is false');
    assert.equal(await driver.focusWindow('not-a-window'), false, 'a bad id is false');
  });

  it('live-desktop: CLI computer screenshot, capabilities, clipboard, windows, focus, type and key', { timeout: 300000 }, async (t) => {
    const file = path.join(HOME, 'cli-shot.png');
    const out = cli(t, ['computer', 'screenshot', '--out', file]);
    assert.equal(path.resolve(out.path), path.resolve(file));
    assert.ok(out.width > 0 && out.height > 0 && out.display === 0, show(out));
    const buf = fs.readFileSync(file);
    assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), 'the CLI wrote a PNG');
    const hdr = png.readHeader(buf);
    assert.deepEqual([hdr.width, hdr.height], [out.width, out.height]);
    fs.copyFileSync(file, path.join(OUT, '09-cli-screenshot.png'));

    const caps = cli(t, ['computer', 'capabilities']);
    assert.equal(caps.driver, 'win32');
    assert.equal(caps.screenshot, true);

    const clip = 'cli ü€ 日本 🎉 "quoted"';
    const set = cli(t, ['computer', 'clipboard', 'set', clip]);
    assert.equal(set.ok, true);
    assert.equal(cli(t, ['computer', 'clipboard', 'get']).text, clip, 'unicode survives argv and stdout');

    const wins = cli(t, ['computer', 'windows', '--filter', 'notepad']);
    assert.ok(wins.count >= 1 && wins.windows.some((w) => w.id === notepad.id), `the CLI lists our Notepad: ${show(wins)}`);
    const focused = cli(t, ['computer', 'focus', '--id', notepad.id]);
    assert.equal(focused.ok, true);
    cli(t, ['computer', 'key', 'ctrl+a', 'delete']);
    cli(t, ['computer', 'type', 'cli-typed ü€']);
    cli(t, ['computer', 'key', 'ctrl+a', 'ctrl+c']);
    const got = await waitFor(async () => {
      const s = await driver.clipboardGet();
      return s === 'cli-typed ü€' ? s : null;
    }, 3000, 200);
    assert.equal(got || (await driver.clipboardGet()), 'cli-typed ü€', 'text typed through the CLI reached Notepad');
    const screens = cli(t, ['computer', 'screens']);
    assert.ok(Array.isArray(screens.displays) && screens.displays.length === displays.length, show(screens));
  });

  it('live-desktop: MCP server: screenshot, list_windows, focus_window, click, type_text, key, clipboard_get', { timeout: 300000 }, async (t) => {
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
    const call = async (name, args = {}) => {
      const res = await request('tools/call', { name, arguments: args }, 90000);
      const result = res.result || {};
      const content = Array.isArray(result.content) ? result.content : [];
      const texts = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      note(t, `MCP ${name} ${JSON.stringify(args)} ->`, { isError: Boolean(result.isError), error: res.error, text: texts.slice(0, 600), images: content.filter((c) => c.type === 'image').length });
      assert.ok(!res.error && !result.isError, `MCP ${name} failed: ${show(res.error || texts)}; stderr: ${stderr.slice(-1500)}`);
      return { content, text: texts };
    };
    try {
      const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-desktop-test', version: '1' } });
      assert.ok(init.result && init.result.serverInfo, show(init));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const listed = await request('tools/list', {});
      const names = (listed.result && listed.result.tools ? listed.result.tools : []).map((x) => x.name);
      for (const n of ['screenshot', 'click', 'type_text', 'key', 'list_windows', 'focus_window', 'clipboard_get', 'screen_info', 'cursor_position', 'mouse_move']) {
        assert.ok(names.includes(n), `tools/list has ${n}`);
      }

      const shot = await call('screenshot');
      const image = shot.content.find((c) => c.type === 'image');
      assert.ok(image, 'an image content block');
      assert.equal(image.mimeType, 'image/png');
      const data = Buffer.from(image.data, 'base64');
      assert.ok(data.subarray(0, 8).equals(PNG_SIGNATURE), 'MCP image is a PNG');
      const hdr = png.readHeader(data);
      assert.ok(hdr.width > 0 && hdr.height > 0);
      fs.writeFileSync(path.join(OUT, '10-mcp-screenshot.png'), data);
      assert.match(shot.text, /\d+x\d+/, 'a text block describing the shot');

      const info = await call('screen_info');
      assert.match(info.text, /Display 0/);
      const listedWins = await call('list_windows', { filter: 'notepad' });
      assert.ok(listedWins.text.includes(notepad.id), 'list_windows shows our Notepad');
      const focus = await call('focus_window', { id: notepad.id });
      assert.match(focus.text, /Focused/);
      await call('key', { combo: 'primary+a' });
      await call('key', { combo: 'delete' });
      await call('type_text', { text: 'mcp-typed ü€' });
      // Click inside Notepad (screenshot pixels = physical px here: no downscale at this size).
      const w = (await windowsNow()).find((x) => x.id === notepad.id) || notepad;
      const scale = displays[0].width / hdr.width;
      const cx = Math.round((w.x + w.width / 2) / scale);
      const cy = Math.round((w.y + w.height * 0.6) / scale);
      await call('click', { x: cx, y: cy });
      await call('type_text', { text: ' +clicked' });
      const moved = await call('mouse_move', { x: cx + 10, y: cy + 5 });
      assert.match(moved.text, /./);
      const cur = await call('cursor_position');
      assert.match(cur.text, new RegExp(`\\(${cx + 10}, ${cy + 5}\\)`), 'cursor_position reports the mouse_move target');
      await call('key', { combo: 'primary+a' });
      await call('key', { combo: 'primary+c' });
      await sleep(300);
      const clip = await call('clipboard_get');
      assert.equal(clip.text.replace(/\r\n/g, '\n'), 'mcp-typed ü€ +clicked', 'type_text, click and key went through MCP to Notepad');
      await snap(t, '10-mcp-typed.png');
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

  it('live-desktop: openTarget (file and app) and notify', { timeout: 180000 }, async (t) => {
    const common = require('../src/os/common');
    const beforeIds = new Set((await newNotepadWindows()).map((w) => w.id));
    const file = path.join(HOME, 'live ü test.txt');
    fs.writeFileSync(file, 'opened-by-openTarget ü€\r\n', 'utf8');
    const opened = await common.openTarget(file);
    note(t, 'openTarget(file):', opened);
    assert.equal(opened.opened, true);
    assert.equal(opened.kind, 'path');
    const fileWin = await waitFor(async () => (await windowsNow()).find((w) => !beforeIds.has(w.id) && /live ü test/.test(w.title)), 20000, 300);
    note(t, 'file window:', fileWin || (await windowsNow()));
    assert.ok(fileWin, 'a window shows the opened file (unicode and spaces in the path)');
    assert.equal(await driver.focusWindow(fileWin.id), true);
    await sleep(300);
    const text = await copyNotepadText(t);
    assert.equal(text, 'opened-by-openTarget ü€\n', 'the file opened with its content');
    beforeIds.add(fileWin.id);

    const app = await common.openTarget('notepad', { kind: 'app' });
    note(t, 'openTarget(notepad app):', app);
    assert.equal(app.opened, true);
    assert.equal(app.kind, 'app');
    const appWin = await waitFor(async () => (await newNotepadWindows()).find((w) => !beforeIds.has(w.id) && w.id !== notepad.id), 20000, 300);
    note(t, 'app window:', appWin);
    assert.ok(appWin, 'openTarget started another Notepad');
    await snap(t, '11-opened.png');

    const n = await common.notify('Claude Anywhere live test', 'notify ü€ from the live desktop test');
    note(t, 'notify:', n);
    assert.equal(n.ok, true);
    await driver.notify('Claude Anywhere host notify', 'ü€');
  });

  it('live-desktop: speak (SAPI through Windows PowerShell)', { timeout: 120000 }, async (t) => {
    // The daemon's voice service (dialog read-aloud) has its own SAPI command.
    const { VoiceService } = require('../src/daemon/voice');
    const svc = new VoiceService({ config: { voice: { language: 'en-US' } } });
    let voiceError = null;
    try {
      const r = await svc.speak('Claude Anywhere voice service test');
      note(t, 'VoiceService.speak:', r);
      assert.equal(r.provider, 'sapi');
    } catch (err) {
      voiceError = err;
      note(t, `VoiceService.speak failed: ${err.message}${err.hint ? ` (${err.hint})` : ''}`);
      assert.doesNotMatch(err.message, /CLIXML|<\/S>|_x000D_/, 'the voice error is plain text');
      if (!/Audio device error|AudioException/i.test(err.message)) throw err;
      assert.match(err.message, /^sapi failed \(exit \d+\): Exception calling "Speak"/, 'the message starts with the PowerShell error');
      assert.match(String(err.hint), /audio output device/, 'the hint names the missing audio device');
    }

    const common = require('../src/os/common');
    const s = await common.speak('Claude Anywhere live desktop test');
    note(t, 'speak:', s);
    assert.equal(s.engine, 'sapi');
    const done = await Promise.race([s.done, sleep(60000).then(() => ({ timedOut: true }))]);
    note(t, 'speak done:', { code: done.code, signal: done.signal, timedOut: done.timedOut, stderr: done.stderr, error: done.error && done.error.message });
    assert.ok(!done.timedOut, 'speech finished');
    // Errors must read as text, not as Windows PowerShell's CLIXML serialization.
    assert.doesNotMatch(String(done.stderr || ''), /CLIXML|<Objs|_x000D_/, 'SAPI errors are plain text');
    if (done.code !== 0 && /Audio device error|AudioException/i.test(String(done.stderr))) {
      assert.ok(voiceError, 'both SAPI paths agree that there is no audio device');
      // The hosted runner has no sound device, so SAPI cannot open an audio output there.
      t.skip(`no audio output device on this machine: ${String(done.stderr).split('\n')[0]}`);
      return;
    }
    assert.equal(done.code, 0, `SAPI speech failed: ${done.stderr || (done.error && done.error.message) || ''}`);
  });

  it('live-desktop: close Notepad without saving', { timeout: 60000 }, async (t) => {
    assert.ok(notepad, 'Notepad was started');
    killNotepads();
    const gone = await waitFor(async () => (await newNotepadWindows()).length === 0, 15000, 300);
    if (!gone) {
      note(t, 'Notepad windows still open:', await newNotepadWindows());
      await snap(t, '12-notepad-still-open.png');
    }
    assert.ok(gone, 'every Notepad window of ours closed (no save prompt)');
    notepad = null;
  });
});
