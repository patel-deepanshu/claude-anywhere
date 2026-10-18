#!/usr/bin/env node
'use strict';

/**
 * Emulates src/os/win32-host.ps1's JSON-lines protocol for tests, so the
 * Windows driver's transport can be exercised on any OS.
 *
 * Behaviour switches (environment variables):
 *   FAKE_PS_LOG=<file>          append every request as a JSON line (survives restarts)
 *   FAKE_PS_STATE=<file>        JSON state shared across restarts ({launches})
 *   FAKE_PS_HANG=a,b            never answer these commands
 *   FAKE_PS_CRASH_ON=a,b        exit(9) when one of these commands arrives
 *   FAKE_PS_CRASH_ONCE=1        with FAKE_PS_STATE: crash only during the first launch
 *   FAKE_PS_EXIT_ON_START=<n>   write FAKE_PS_STDERR (or a default) to stderr and exit(n) at once
 *   FAKE_PS_STDERR=<text>       text written to stderr at startup
 *   FAKE_PS_NOISE=1             emit non-protocol lines and stale ids before each response
 *   FAKE_PS_DELAY_MS=<n>        delay every response
 *   FAKE_PS_START_DELAY_MS=<n>  delay before reading stdin
 * Extra commands: __requests (requests seen by this process), __crash, __stderr {text}.
 *
 * Like the real host, input aimed at an elevated window (the focused window for type/keys, else
 * the window under the point; the focused window is on top) fails with UIPI_BLOCKED, and input
 * aimed at another account's window (elevated: null) succeeds with a warning.
 */

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');

const env = process.env;
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const HANG = new Set(list(env.FAKE_PS_HANG));
const CRASH_ON = new Set(list(env.FAKE_PS_CRASH_ON));
const DELAY = Number(env.FAKE_PS_DELAY_MS) || 0;

function readState() {
  if (!env.FAKE_PS_STATE) return { launches: 0 };
  try {
    return JSON.parse(fs.readFileSync(env.FAKE_PS_STATE, 'utf8'));
  } catch {
    return { launches: 0 };
  }
}

const state = readState();
state.launches = (state.launches || 0) + 1;
if (env.FAKE_PS_STATE) fs.writeFileSync(env.FAKE_PS_STATE, JSON.stringify(state));
const crashEnabled = !(env.FAKE_PS_CRASH_ONCE === '1' && state.launches > 1);

if (env.FAKE_PS_STDERR) process.stderr.write(`${env.FAKE_PS_STDERR}\n`);
if (env.FAKE_PS_EXIT_ON_START) {
  if (!env.FAKE_PS_STDERR) process.stderr.write('fake host: failing at startup\n');
  process.exit(Number(env.FAKE_PS_EXIT_ON_START) || 1);
}

// ---------------------------------------------------------------- tiny PNG encoder

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 24-bit RGB PNG with a horizontal gradient tinted per display. */
function makePng(width, height, tint) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 3;
      raw[o] = Math.round((x / Math.max(1, width - 1)) * 255);
      raw[o + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      raw[o + 2] = tint;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- fake desktop

const displays = [
  { index: 0, id: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 64, height: 40, scale: 1, dpiScale: 1.5, primary: true },
  { index: 1, id: '\\\\.\\DISPLAY2', x: 64, y: 0, width: 32, height: 24, scale: 1, dpiScale: 1, primary: false },
];
const desk = {
  cursor: { x: 10, y: 10 },
  clipboard: '',
  focused: '1001',
  windows: [
    { hwnd: '1001', app: 'Visual Studio Code', process: 'Code.exe', title: 'claude-anywhere - Visual Studio Code', pid: 4101, x: 0, y: 0, width: 60, height: 38, minimized: false, elevated: false, className: 'Chrome_WidgetWin_1' },
    { hwnd: '1002', app: 'Google Chrome', process: 'chrome.exe', title: 'Cloud Run - Google Cloud console - Google Chrome', pid: 4102, x: 64, y: 0, width: 32, height: 24, minimized: false, elevated: false, className: 'Chrome_WidgetWin_1' },
    { hwnd: '1003', app: 'Task Manager', process: 'Taskmgr.exe', title: 'Task Manager', pid: 4103, x: 5, y: 5, width: 20, height: 20, minimized: false, elevated: true, className: 'TaskManagerWindow' },
    // Started with an administrator's credentials: another account, so its elevation is unknown.
    { hwnd: '1004', app: '', process: '', title: 'Contoso Setup', pid: 4104, x: 30, y: 20, width: 20, height: 15, minimized: false, elevated: null, className: '#32770' },
  ],
  topmost: {},
};
const requests = [];

function fail(message, code, hint) {
  const err = new Error(message);
  err.code = code;
  err.hint = hint;
  return err;
}

function findWindow(hwnd) {
  return desk.windows.find((w) => w.hwnd === String(hwnd));
}

function windowOut(w) {
  return { ...w, focused: w.hwnd === desk.focused };
}

function windowAt(x, y) {
  const order = [findWindow(desk.focused), ...desk.windows.filter((w) => w.hwnd !== desk.focused)];
  return order.find((w) => w && !w.minimized && x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height) || null;
}

/** Mirror of Confirm-InputTarget in win32-host.ps1: throws or returns a warnings list. */
function checkInput(w) {
  if (!w || w.elevated === false) return [];
  const name = `${w.title} (${w.process || `pid ${w.pid}`})`;
  if (w.elevated) {
    throw fail(`Windows blocks input to '${name}' because it runs as administrator and Claude Anywhere does not.`, 'UIPI_BLOCKED', 'Interact with that window yourself.');
  }
  return [`'${name}' belongs to another user account, so Claude Anywhere cannot tell whether it runs as administrator. If nothing happened, it probably does and Windows (UIPI) silently dropped the input: ask the user to do this step in that window themselves.`];
}

function withWarnings(result, warnings) {
  return warnings.length ? { ...result, warnings } : result;
}

function num(args, name, dflt) {
  const v = args && args[name] != null ? args[name] : dflt;
  if (v == null || !Number.isFinite(Number(v))) throw fail(`Missing numeric argument '${name}'.`, 'BAD_ARGS');
  return Math.round(Number(v));
}

const handlers = {
  ping: () => ({
    pong: true, protocol: 1, ps: '5.1.22621.4111', edition: 'Desktop', windows: true, native: true, nativeError: null,
    dpi: 'permonitorv2', elevated: false, sta: true, is64: true, pid: process.pid, os: 'Microsoft Windows NT 10.0.22631.0',
  }),
  echo: (a) => ({ args: a }),
  displays: () => ({ displays }),
  capture: (a) => {
    const i = num(a, 'index', 0);
    const d = displays[i];
    if (!d) throw fail(`Display ${i} does not exist (${displays.length} connected).`, 'BAD_DISPLAY', 'Call displays to list the connected screens.');
    return { width: d.width, height: d.height, png: makePng(d.width, d.height, i * 100).toString('base64') };
  },
  cursor: () => ({ ...desk.cursor }),
  move: (a) => {
    desk.cursor = { x: num(a, 'x'), y: num(a, 'y') };
    return { ...desk.cursor };
  },
  click: (a) => {
    if (a.x != null) desk.cursor = { x: num(a, 'x'), y: num(a, 'y') };
    const warnings = checkInput(windowAt(desk.cursor.x, desk.cursor.y));
    return withWarnings({ ...desk.cursor }, warnings);
  },
  down: () => withWarnings({ ok: true }, checkInput(windowAt(desk.cursor.x, desk.cursor.y))),
  up: () => ({ ok: true }),
  drag: (a) => {
    const warnings = checkInput(windowAt(num(a, 'x1'), num(a, 'y1')));
    desk.cursor = { x: num(a, 'x2'), y: num(a, 'y2') };
    return withWarnings({ ok: true }, warnings);
  },
  scroll: (a) => {
    if (a.x != null) desk.cursor = { x: num(a, 'x'), y: num(a, 'y') };
    return withWarnings({ ok: true }, checkInput(windowAt(desk.cursor.x, desk.cursor.y)));
  },
  type: (a) => {
    const warnings = checkInput(findWindow(desk.focused));
    return withWarnings({ typed: String(a.text || '').length }, warnings);
  },
  keys: (a) => {
    if (!Array.isArray(a.vks) || !a.vks.length) throw fail('No keys given.', 'BAD_ARGS');
    return withWarnings({ ok: true }, checkInput(findWindow(desk.focused)));
  },
  windows: () => ({ windows: desk.windows.map(windowOut) }),
  active: () => {
    const w = findWindow(desk.focused);
    return { window: w ? windowOut(w) : null };
  },
  focus: (a) => {
    const w = findWindow(a.hwnd);
    if (!w) return { ok: false };
    desk.focused = w.hwnd;
    w.minimized = false;
    return { ok: true };
  },
  minimize: (a) => {
    const w = findWindow(a.hwnd);
    if (!w) return { ok: false };
    w.minimized = true;
    if (desk.focused === w.hwnd) desk.focused = null;
    return { ok: true };
  },
  topmost: (a) => {
    const w = findWindow(a.hwnd);
    if (!w) return { ok: false };
    desk.topmost[w.hwnd] = Boolean(a.on);
    return { ok: true };
  },
  clipget: () => ({ text: desk.clipboard }),
  clipset: (a) => {
    desk.clipboard = String(a.text == null ? '' : a.text);
    return { ok: true };
  },
  notify: () => ({ shown: true }),
  __requests: () => ({ requests }),
  __stderr: (a) => {
    process.stderr.write(`${a.text}\n`);
    return { ok: true };
  },
};

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    write({ id: null, ok: false, error: { message: `Conversion from JSON failed: ${err.message}`, code: 'HOST_ERROR' } });
    return;
  }
  const { id, cmd } = req;
  const args = req.args || {};
  requests.push({ cmd, args });
  if (env.FAKE_PS_LOG) fs.appendFileSync(env.FAKE_PS_LOG, `${JSON.stringify({ pid: process.pid, cmd, args })}\n`);
  if ((cmd === '__crash' || CRASH_ON.has(cmd)) && crashEnabled) {
    process.stderr.write(`fake host: crashing on ${cmd}\n`);
    process.exit(9);
  }
  if (HANG.has(cmd)) return;
  const respond = () => {
    if (env.FAKE_PS_NOISE === '1') {
      process.stdout.write('WARNING: this is not a protocol line\n');
      write({ id: -1, ok: true, result: { stale: true } });
      write({ note: 'object without an id' });
    }
    const fn = handlers[cmd];
    if (!fn) {
      write({ id, ok: false, error: { message: `Unknown command '${cmd}'.`, code: 'UNKNOWN_COMMAND', hint: null } });
      return;
    }
    try {
      write({ id, ok: true, result: fn(args) });
    } catch (err) {
      write({ id, ok: false, error: { message: err.message, code: err.code || 'HOST_ERROR', hint: err.hint || null, type: 'System.InvalidOperationException' } });
    }
  };
  if (DELAY) setTimeout(respond, DELAY);
  else respond();
}

function startReading() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim()) handle(line);
  });
  rl.on('close', () => process.exit(0));
}

const startDelay = Number(env.FAKE_PS_START_DELAY_MS) || 0;
if (startDelay) setTimeout(startReading, startDelay);
else startReading();
