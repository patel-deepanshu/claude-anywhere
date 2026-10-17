'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const D = require('../src/os/darwin');

const HELPER = path.join(__dirname, '..', 'src', 'os', 'darwin-helper.js');
const HELPER_SRC = fs.readFileSync(HELPER, 'utf8');

let realKeys = null;
try {
  realKeys = require('../src/os/keys');
  if (typeof realKeys.toMacKeyCodes !== 'function') realKeys = null;
} catch {
  realKeys = null;
}

/** Normalize values from another vm realm so deepStrictEqual compares structure only. */
function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ===========================================================================
// Syntax
// ===========================================================================

test('darwin-helper.js and darwin.js pass node --check', () => {
  for (const f of [HELPER, path.join(__dirname, '..', 'src', 'os', 'darwin.js')]) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('the helper is inert when loaded outside osascript', () => {
  // No ObjC global: top-level code must not throw and run() must do nothing.
  const ctx = vm.createContext({});
  vm.runInContext(HELPER_SRC, ctx, { filename: 'darwin-helper.js' });
  assert.equal(typeof ctx.run, 'function');
  assert.equal(ctx.run(['serve']), undefined);
});

// ===========================================================================
// Pure helpers
// ===========================================================================

test('parseDisplays flips NSScreen frames into top-left global points', () => {
  // Primary 1440x900 @2x; a 1920x1080 secondary above and to the left of it.
  const payload = {
    screens: [
      { id: 1, frame: { x: 0, y: 0, width: 1440, height: 900 }, scale: 2, name: 'Built-in Retina Display' },
      { id: 2, frame: { x: -1920, y: 900, width: 1920, height: 1080 }, scale: 1, name: 'DELL U2720Q' },
      // Below and to the right of the primary.
      { id: 3, frame: { x: 1440, y: -768, width: 1366, height: 768 }, scale: 1 },
    ],
  };
  const list = D.parseDisplays(payload);
  assert.deepEqual(list, [
    { index: 0, id: 1, x: 0, y: 0, width: 1440, height: 900, scale: 2, primary: true, name: 'Built-in Retina Display' },
    { index: 1, id: 2, x: -1920, y: -1080, width: 1920, height: 1080, scale: 1, primary: false, name: 'DELL U2720Q' },
    { index: 2, id: 3, x: 1440, y: 900, width: 1366, height: 768, scale: 1, primary: false, name: '' },
  ]);
  assert.ok(!Object.is(list[0].y, -0));
});

test('parseDisplays prefers CGDisplayBounds and tolerates junk', () => {
  const list = D.parseDisplays({
    screens: [
      { id: 7, frame: { x: 0, y: 0, width: 1512, height: 982 }, cg: { x: 0, y: 0, width: 1512, height: 982 }, scale: 2 },
      { id: 9, frame: { x: 1512, y: 0, width: 2560, height: 1440 }, cg: { x: 1512, y: -458, width: 2560, height: 1440 }, scale: 0 },
      null,
      { id: 11, frame: { x: 0, y: 0, width: 0, height: 0 } },
    ],
  });
  assert.equal(list.length, 2);
  assert.deepEqual(list[1], { index: 1, id: 9, x: 1512, y: -458, width: 2560, height: 1440, scale: 1, primary: false, name: '' });
  assert.deepEqual(D.parseDisplays(null), []);
  assert.deepEqual(D.parseDisplays({ screens: [] }), []);
});

test('parseWindows keeps visible layer-0 windows and marks the focused one', () => {
  const payload = {
    frontPid: 501,
    windows: [
      { number: 90, pid: 77, owner: 'Window Server', title: 'Menubar', layer: 0, alpha: 1, x: 0, y: 0, width: 1440, height: 25 },
      { number: 12, pid: 300, owner: 'SystemUIServer', title: '', layer: 25, alpha: 1, x: 1200, y: 0, width: 30, height: 22 },
      { number: 41, pid: 501, owner: 'Code', title: 'server.js — my-repo', layer: 0, alpha: 1, x: 0, y: 25, width: 1440, height: 875 },
      { number: 42, pid: 501, owner: 'Code', title: 'Settings', layer: 0, alpha: 1, x: 100, y: 100, width: 800, height: 600 },
      { number: 55, pid: 777, owner: 'Google Chrome', title: 'Cloud Run – Google Cloud console', layer: 0, alpha: 1, x: -1920, y: -1080, width: 1920, height: 1050 },
      { number: 56, pid: 777, owner: 'Google Chrome', title: '', layer: 0, alpha: 0, x: 0, y: 0, width: 500, height: 500 },
      { number: 57, pid: 778, owner: 'Tiny', title: '', layer: 0, alpha: 1, x: 0, y: 0, width: 1, height: 1 },
      { number: 'x', pid: 779, owner: 'Bad', layer: 0, width: 100, height: 100 },
    ],
  };
  assert.deepEqual(D.parseWindows(payload), [
    { id: '501:41', app: 'Code', title: 'server.js — my-repo', pid: 501, x: 0, y: 25, width: 1440, height: 875, focused: true, minimized: false },
    { id: '501:42', app: 'Code', title: 'Settings', pid: 501, x: 100, y: 100, width: 800, height: 600, focused: false, minimized: false },
    {
      id: '777:55', app: 'Google Chrome', title: 'Cloud Run – Google Cloud console', pid: 777,
      x: -1920, y: -1080, width: 1920, height: 1050, focused: false, minimized: false,
    },
  ]);
  assert.deepEqual(D.parseWindows({ windows: [] }), []);
  assert.deepEqual(D.parseWindows(null), []);
});

test('parseActive and parseWindowId', () => {
  assert.deepEqual(D.parseActive({ pid: 501, app: 'Code', bundleId: 'com.microsoft.VSCode', window: { number: 41, title: 'a.js' } }), {
    id: '501:41', app: 'Code', title: 'a.js', pid: 501, bundleId: 'com.microsoft.VSCode',
  });
  assert.deepEqual(D.parseActive({ pid: 88, app: 'Finder', window: null }), { id: '88', app: 'Finder', title: '', pid: 88, bundleId: '' });
  assert.equal(D.parseActive(null), null);
  assert.equal(D.parseActive({ app: 'x' }), null);

  assert.deepEqual(D.parseWindowId('501:41'), { pid: 501, number: 41 });
  assert.deepEqual(D.parseWindowId(' 501 '), { pid: 501, number: null });
  assert.deepEqual(D.parseWindowId(501), { pid: 501, number: null });
  assert.deepEqual(D.parseWindowId({ pid: 5, number: 6 }), { pid: 5, number: 6 });
  assert.equal(D.parseWindowId('0x1234'), null);
  assert.equal(D.parseWindowId(''), null);
  assert.equal(D.parseWindowId('0'), null);
  assert.equal(D.parseWindowId(null), null);
});

test('planTyping splits text into keystroke, key and paste steps', () => {
  assert.deepEqual(D.planTyping('git status\n'), [{ kind: 'keys', text: 'git status' }, { kind: 'key', keyCode: 36 }]);
  assert.deepEqual(D.planTyping('a\tb\r\nc\rd'), [
    { kind: 'keys', text: 'a' },
    { kind: 'key', keyCode: 48 },
    { kind: 'keys', text: 'b' },
    { kind: 'key', keyCode: 36 },
    { kind: 'keys', text: 'c' },
    { kind: 'key', keyCode: 36 },
    { kind: 'keys', text: 'd' },
  ]);
  // Non-ASCII runs (accents, CJK, emoji) are pasted whole, newline-separated.
  assert.deepEqual(D.planTyping('café ☕ 😀\nnaïve'), [
    { kind: 'paste', text: 'café ☕ 😀' },
    { kind: 'key', keyCode: 36 },
    { kind: 'paste', text: 'naïve' },
  ]);
  // Other control characters cannot be typed.
  assert.deepEqual(D.planTyping('a\u0007b\u001b'), [{ kind: 'keys', text: 'ab' }]);
  assert.deepEqual(D.planTyping(''), []);
  const long = 'x'.repeat(120);
  const steps = D.planTyping(long);
  assert.deepEqual(steps.map((s) => s.text.length), [50, 50, 20]);
  assert.ok(D.typingTimeoutMs(steps) > 10000);
  assert.deepEqual(D.planTyping('ab\ncd', { pasteAll: true }), [
    { kind: 'paste', text: 'ab' },
    { kind: 'key', keyCode: 36 },
    { kind: 'paste', text: 'cd' },
  ]);
});

test('macModifiers maps names and aliases to CGEventFlags and key codes', () => {
  assert.deepEqual(D.macModifiers(['cmd', 'Shift']), { flags: 0x120000, keyCodes: [0x38, 0x37], names: ['shift', 'meta'] });
  assert.deepEqual(D.macModifiers('ctrl+option'), { flags: 0xc0000, keyCodes: [0x3b, 0x3a], names: ['ctrl', 'alt'] });
  assert.deepEqual(D.macModifiers([]), { flags: 0, keyCodes: [], names: [] });
  assert.deepEqual(D.macModifiers(null), { flags: 0, keyCodes: [], names: [] });
  assert.throws(() => D.macModifiers(['hyper']), { code: 'INVALID_ARGUMENT' });
});

test('asciiJson, parseLine and lastResponse', () => {
  const s = D.asciiJson({ t: 'Ω — 😀', n: 1 });
  assert.ok(/^[\x20-\x7e]*$/.test(s), s);
  assert.deepEqual(JSON.parse(s), { t: 'Ω — 😀', n: 1 });
  assert.equal(D.parseLine('hello'), null);
  assert.equal(D.parseLine('{"bad json'), null);
  assert.equal(D.parseLine('{"id":1}'), null);
  assert.deepEqual(D.parseLine(' {"id":1,"ok":true,"result":2} '), { id: 1, ok: true, result: 2 });
  assert.deepEqual(D.lastResponse('noise\n{"id":null,"ok":true,"result":{"x":1}}\n\n'), { id: null, ok: true, result: { x: 1 } });
  assert.equal(D.lastResponse(''), null);
});

test('pngSize reads the IHDR size', () => {
  assert.deepEqual(D.pngSize(makePng(7, 3)), { width: 7, height: 3 });
  assert.equal(D.pngSize(Buffer.from('not a png at all, not a png at all')), null);
  assert.equal(D.pngSize(null), null);
});

test('appFromProcessTree finds the outermost .app of the nearest app ancestor', () => {
  const ps = [
    '  1     0 /sbin/launchd',
    ' 400     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    ' 410   400 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
    ' 420   410 /bin/zsh',
    ' 430   420 node',
    ' 500     1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
    ' 510   500 -zsh',
    ' 520   510 node',
  ].join('\n');
  assert.equal(D.appFromProcessTree(ps, 430), 'Visual Studio Code');
  assert.equal(D.appFromProcessTree(ps, 520), 'iTerm');
  assert.equal(D.appFromProcessTree(ps, 1), null);
  assert.equal(D.appFromProcessTree('', 5), null);
});

test('detectHostApp falls back to environment hints', async () => {
  const failing = async () => ({ code: null, error: Object.assign(new Error('nope'), { code: 'ENOENT' }) });
  assert.equal(await D.detectHostApp({ env: { TERM_PROGRAM: 'Apple_Terminal' }, run: failing }), 'Terminal');
  assert.equal(await D.detectHostApp({ env: { __CFBundleIdentifier: 'com.microsoft.VSCode' }, run: failing }), 'Visual Studio Code');
  assert.equal(await D.detectHostApp({ env: {}, run: failing }), null);
  const ps = async () => ({ code: 0, stdout: ' 9 1 /Applications/Ghostty.app/Contents/MacOS/ghostty\n 10 9 node\n', stderr: '' });
  assert.equal(await D.detectHostApp({ env: {}, run: ps, pid: 10 }), 'Ghostty');
});

test('permissionHint names the app, the Settings pane and its URL', () => {
  const ax = D.permissionHint('accessibility', 'iTerm');
  assert.match(ax, /Accessibility/);
  assert.match(ax, /"iTerm"/);
  assert.match(ax, /Privacy_Accessibility/);
  assert.match(ax, /not to node or osascript/);
  const sr = D.permissionHint('screenRecording', null);
  assert.match(sr, /Screen Recording/);
  assert.match(sr, /Privacy_ScreenCapture/);
  assert.match(sr, /Terminal, iTerm, VS Code/);
  assert.match(D.permissionHint('automation', 'Terminal'), /System Events.*Privacy_Automation/s);
  const err = D.permissionError('screenRecording');
  assert.equal(err.code, 'PERMISSION');
  assert.equal(err.permission, 'screenRecording');
  assert.equal(err.settingsUrl, D.SETTINGS_URLS.screenRecording);
});

// ===========================================================================
// The JXA helper, run in a vm against a fake ObjC bridge
// ===========================================================================

function nsArray(items) {
  return { count: items.length, objectAtIndex: (i) => items[i], isNil: () => false };
}

function wrap(v) {
  return { __v: v, isNil: () => false };
}

function makeJxa(opts = {}) {
  const posted = [];
  const log = [];
  const stdout = [];
  const imports = [];
  const front = { pid: opts.front ? opts.front.pid : null };
  const fronts = opts.fronts || {};
  if (opts.front) fronts[opts.front.pid] = opts.front;
  const stdinChunks = (opts.stdin || []).slice();
  const axWindows = opts.axWindows || {};

  const pb = {
    text: opts.clipboard === undefined ? 'previous clipboard' : opts.clipboard,
    changeCount: 10,
    writes: [],
    get clearContents() {
      this.text = null;
      this.changeCount++;
      return this.changeCount;
    },
    setStringForType(s, type) {
      this.text = $u(s);
      this.writes.push(this.text);
      this.changeCount++;
      return true;
    },
    stringForType() {
      return this.text == null ? null : wrap(this.text);
    },
    get pasteboardItems() {
      if (this.text == null) return nsArray([]);
      const text = this.text;
      return nsArray([{ types: nsArray(['public.utf8-plain-text']), dataForType: () => ({ __data: text, isNil: () => false }) }]);
    },
    writeObjects(arr) {
      const item = arr.items[0];
      this.text = item ? item.data['public.utf8-plain-text'].__data : null;
      this.writes.push(`restore:${this.text}`);
      this.changeCount++;
      return true;
    },
  };

  function $u(v) {
    return v && typeof v === 'object' && '__v' in v ? v.__v : v;
  }

  const $ = function (v) {
    return { __v: v, isNil: () => false, dataUsingEncoding: () => ({ __text: v }) };
  };
  const mouse = (src, type, pt, button) => ({ kind: 'mouse', type, x: pt.x, y: pt.y, button, fields: {}, flags: 0 });
  Object.assign($, {
    CGPointMake: (x, y) => ({ x, y }),
    CGEventCreateMouseEvent: mouse,
    CGEventCreateKeyboardEvent: (src, code, down) => ({ kind: 'key', code, down, flags: 0, fields: {} }),
    CGEventSetIntegerValueField: (e, field, v) => {
      e.fields[field] = v;
    },
    CGEventSetFlags: (e, f) => {
      e.flags = f;
    },
    CGEventSetLocation: (e, p) => {
      e.x = p.x;
      e.y = p.y;
    },
    CGEventPost: (tap, e) => posted.push({ tap, ...e, fields: { ...e.fields } }),
    CGEventCreate: () => ({}),
    CGEventGetLocation: () => opts.cursor || { x: 12.5, y: 34 },
    NSThread: { sleepForTimeInterval: () => {} },
    NSRunLoop: { currentRunLoop: { runUntilDate: () => {} } },
    NSDate: { dateWithTimeIntervalSinceNow: () => ({}) },
    NSProcessInfo: { processInfo: { processIdentifier: 4242, operatingSystemVersionString: wrap('Version 14.5 (Build 23F79)') } },
    NSPasteboard: { generalPasteboard: pb },
    NSPasteboardTypeString: wrap('public.utf8-plain-text'),
    NSPasteboardItem: {
      alloc: {
        get init() {
          return {
            data: {},
            setDataForType(d, t) {
              this.data[$u(t)] = d;
            },
          };
        },
      },
    },
    NSMutableArray: {
      alloc: {
        get init() {
          return {
            items: [],
            addObject(o) {
              this.items.push(o);
            },
          };
        },
      },
    },
    NSMutableDictionary: {
      alloc: {
        get init() {
          return {
            d: {},
            setObjectForKey(v, k) {
              this.d[k] = v;
            },
          };
        },
      },
    },
    NSNumber: { numberWithBool: (b) => wrap(b) },
    NSScreen: {
      get screens() {
        return nsArray(
          (opts.screens || []).map((s) => ({
            frame: { origin: { x: s.x, y: s.y }, size: { width: s.width, height: s.height } },
            visibleFrame: { origin: { x: s.x, y: s.y }, size: { width: s.width, height: s.height - 25 } },
            backingScaleFactor: s.scale,
            deviceDescription: { objectForKey: (k) => (k === 'NSScreenNumber' ? wrap(s.id) : null) },
            localizedName: wrap(s.name),
          })),
        );
      },
    },
    NSWorkspace: {
      sharedWorkspace: {
        get frontmostApplication() {
          const f = fronts[front.pid];
          if (!f) return null;
          return { isNil: () => false, processIdentifier: f.pid, localizedName: wrap(f.name), bundleIdentifier: wrap(f.bundleId) };
        },
      },
    },
    NSRunningApplication: {
      runningApplicationWithProcessIdentifier: (pid) => {
        if (!fronts[pid]) return { isNil: () => true };
        return {
          isNil: () => false,
          bundleIdentifier: wrap(fronts[pid].bundleId),
          bundleURL: { isNil: () => false, path: wrap(`/Applications/${fronts[pid].name}.app`) },
          get unhide() {
            log.push(['unhide', pid]);
            return true;
          },
          activateWithOptions: (o) => {
            log.push(['activate', pid, o]);
            if (opts.activationWorks !== false) front.pid = pid;
            return opts.activationWorks !== false;
          },
        };
      },
    },
    CGWindowListCopyWindowInfo: (option, rel) => {
      log.push(['windowList', option, rel]);
      let list = opts.windowList || [];
      if (option === 8) list = list.filter((w) => w.kCGWindowNumber === rel);
      return { __deep: list };
    },
    NSFileHandle: {
      fileHandleWithStandardInput: {
        get availableData() {
          return { __text: stdinChunks.length ? stdinChunks.shift() : '' };
        },
      },
      fileHandleWithStandardOutput: {
        writeData: (d) => stdout.push(d.__text),
      },
    },
    NSString: { alloc: { initWithDataEncoding: (d) => wrap(d.__text) } },
  });
  if (opts.perms !== null) {
    $.AXIsProcessTrusted = () => (opts.perms ? opts.perms.accessibility : true);
    if (!opts.perms || opts.perms.screenRecording !== undefined) {
      $.CGPreflightScreenCaptureAccess = () => (opts.perms ? opts.perms.screenRecording : true);
    }
  }
  if (opts.cgBounds) $.CGDisplayBounds = (id) => opts.cgBounds[id];
  if (opts.noScroll) delete $.CGEventCreateScrollWheelEvent2;
  else $.CGEventCreateScrollWheelEvent2 = (src, units, count, w1, w2, w3) => ({ kind: 'scroll', units, count, w1, w2, w3, flags: 0, fields: {} });

  const ObjC = {
    import: (n) => imports.push(n),
    unwrap: $u,
    deepUnwrap: (o) => o.__deep,
    castRefToObject: (r) => r,
  };

  function axWindow(pid, w) {
    const attr = (name) => ({
      get value() {
        return () => Boolean(w[name]);
      },
      set value(v) {
        w[name] = v;
        log.push(['set', pid, w.name, name, v]);
      },
    });
    return {
      name: () => w.name,
      position: () => [w.x, w.y],
      size: () => [w.w, w.h],
      attributes: { byName: attr },
      actions: { byName: (n) => ({ perform: () => log.push(['perform', pid, w.name, n]) }) },
    };
  }

  function processFor(pid) {
    const wins = axWindows[pid];
    const fail = () => {
      if (opts.axError) throw opts.axError;
      if (!wins) throw Object.assign(new Error("Can't get process."), { errorNumber: -1728 });
    };
    const windows = () => {
      fail();
      return wins.map((w) => axWindow(pid, w));
    };
    // A function's own `name` is read-only; JXA element specifiers have no such clash.
    Object.defineProperty(windows, 'name', { value: () => (fail(), wins.map((w) => w.name)), configurable: true });
    windows.position = () => (fail(), wins.map((w) => [w.x, w.y]));
    windows.size = () => (fail(), wins.map((w) => [w.w, w.h]));
    return {
      windows,
      set frontmost(v) {
        log.push(['frontmost', pid, v]);
      },
    };
  }

  const systemEvents = {
    keystroke: (t) => {
      if (opts.keystrokeError) throw opts.keystrokeError;
      log.push(['keystroke', t]);
    },
    processes: { whose: (q) => [processFor(q.unixId)] },
  };
  const Application = (name) => {
    log.push(['Application', name]);
    return systemEvents;
  };

  const ctx = vm.createContext({ ObjC, $, Application });
  vm.runInContext(HELPER_SRC, ctx, { filename: 'darwin-helper.js' });
  const call = (cmd, args) => plain(ctx.dispatch({ id: 1, cmd, args }));
  return { ctx, call, posted, log, stdout, imports, pb, front };
}

const keysOnly = (posted) => posted.filter((e) => e.kind === 'key').map((e) => [e.code, e.down, e.flags]);

test('helper: imports the frameworks once at load', () => {
  const j = makeJxa();
  assert.deepEqual(j.imports, ['Cocoa', 'CoreGraphics', 'ApplicationServices']);
});

test('helper: double click with modifiers uses native click states', () => {
  const j = makeJxa();
  const r = j.call('click', { x: 100, y: 200.5, button: 'left', clicks: 2, flags: 0x120000, modifierKeyCodes: [0x38, 0x37] });
  assert.deepEqual(r, { id: 1, ok: true, result: { x: 100, y: 200.5, clicks: 2 } });
  const seq = j.posted.map((e) =>
    e.kind === 'mouse' ? ['mouse', e.type, e.button, e.fields[1] || 0, e.flags, e.x, e.y] : ['key', e.code, e.down, e.flags],
  );
  assert.deepEqual(seq, [
    ['mouse', 5, 0, 0, 0, 100, 200.5],
    ['key', 0x38, true, 0x20000],
    ['key', 0x37, true, 0x120000],
    ['mouse', 1, 0, 1, 0x120000, 100, 200.5],
    ['mouse', 2, 0, 1, 0x120000, 100, 200.5],
    ['mouse', 1, 0, 2, 0x120000, 100, 200.5],
    ['mouse', 2, 0, 2, 0x120000, 100, 200.5],
    ['key', 0x37, false, 0x20000],
    ['key', 0x38, false, 0],
  ]);
  assert.ok(j.posted.every((e) => e.tap === 0), 'posted to kCGHIDEventTap');
});

test('helper: right, middle and triple clicks', () => {
  let j = makeJxa();
  j.call('click', { x: 1, y: 2, button: 'right' });
  assert.deepEqual(j.posted.slice(1).map((e) => [e.type, e.button, e.fields[1]]), [[3, 1, 1], [4, 1, 1]]);
  j = makeJxa();
  j.call('click', { x: 1, y: 2, button: 'middle', clicks: 3 });
  assert.deepEqual(j.posted.slice(1).map((e) => [e.type, e.button, e.fields[1]]), [
    [25, 2, 1], [26, 2, 1], [25, 2, 2], [26, 2, 2], [25, 2, 3], [26, 2, 3],
  ]);
  j = makeJxa();
  const bad = j.call('click', { x: 'nope', y: 2 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'BAD_ARGS');
  assert.equal(j.call('click', { x: 1, y: 2, button: 'fourth' }).code, 'BAD_ARGS');
});

test('helper: move, held-button move, down and up at the cursor', () => {
  const j = makeJxa({ cursor: { x: 40, y: 50 } });
  j.call('move', { x: 5, y: 6 });
  j.call('move', { x: 7, y: 8, button: 'left' });
  j.call('move', { x: 9, y: 10, button: 'right' });
  assert.deepEqual(j.call('down', { button: 'left' }).result, { x: 40, y: 50 });
  j.call('up', { button: 'left' });
  assert.deepEqual(j.posted.map((e) => [e.type, e.button, e.x, e.y]), [
    [5, 0, 5, 6],
    [6, 0, 7, 8],
    [7, 1, 9, 10],
    [1, 0, 40, 50],
    [2, 0, 40, 50],
  ]);
  assert.deepEqual(j.call('cursor', {}).result, { x: 40, y: 50 });
});

test('helper: drag sends down, interpolated dragged events, then up', () => {
  const j = makeJxa();
  const r = j.call('drag', { x1: 0, y1: 0, x2: 100, y2: 50, button: 'left', steps: 4 });
  assert.deepEqual(r.result, { x: 100, y: 50, steps: 4 });
  assert.deepEqual(j.posted.map((e) => [e.type, e.x, e.y]), [
    [5, 0, 0],
    [1, 0, 0],
    [6, 25, 12.5],
    [6, 50, 25],
    [6, 75, 37.5],
    [6, 100, 50],
    [2, 100, 50],
  ]);
});

test('helper: scroll negates directions and uses line units', () => {
  const j = makeJxa();
  const r = j.call('scroll', { x: 10, y: 20, dx: -1, dy: 2, linesPerNotch: 3 });
  assert.deepEqual(r.result, { x: 10, y: 20, notches: 2 });
  const scrolls = j.posted.filter((e) => e.kind === 'scroll');
  assert.deepEqual(scrolls.map((e) => [e.units, e.count, e.w1, e.w2, e.w3, e.x, e.y]), [
    [1, 2, -3, 3, 0, 10, 20],
    [1, 2, -3, 0, 0, 10, 20],
  ]);
  assert.equal(j.posted[0].type, 5, 'moves the pointer over the target first');
  const up = makeJxa();
  up.call('scroll', { x: 0, y: 0, dy: -1, dx: 2, linesPerNotch: 1 });
  assert.deepEqual(up.posted.filter((e) => e.kind === 'scroll').map((e) => [e.w1, e.w2]), [[1, -1], [0, -1]]);
  const none = makeJxa({ noScroll: true });
  assert.equal(none.call('scroll', { x: 0, y: 0, dy: 1 }).code, 'UNSUPPORTED');
});

test('helper: key combos press modifiers, the key, then release in reverse', () => {
  let j = makeJxa();
  assert.equal(j.call('key', { keyCode: 0x11, keyCodes: [0x11], flags: 0x120000, modifierKeyCodes: [0x38, 0x37] }).ok, true);
  assert.deepEqual(keysOnly(j.posted), [
    [0x38, true, 0x20000],
    [0x37, true, 0x120000],
    [0x11, true, 0x120000],
    [0x11, false, 0x120000],
    [0x37, false, 0x20000],
    [0x38, false, 0],
  ]);
  // Arrow keys carry NumericPad|SecondaryFn like native events.
  j = makeJxa();
  j.call('key', { keyCode: 0x7b, flags: 0x100000, modifierKeyCodes: [0x37] });
  assert.deepEqual(keysOnly(j.posted)[1], [0x7b, true, 0x100000 | 0x200000 | 0x800000]);
  // A bare modifier press: its own flag on key-down, cleared on key-up.
  j = makeJxa();
  j.call('key', { keyCode: 0x37, keyCodes: [0x37], flags: 0x100000, modifierKeyCodes: [] });
  assert.deepEqual(keysOnly(j.posted), [[0x37, true, 0x100000], [0x37, false, 0]]);
  assert.equal(makeJxa().call('key', {}).code, 'BAD_ARGS');
});

test('helper: type uses keystroke for ASCII, key codes for Return/Tab, and paste for unicode', () => {
  const j = makeJxa({ clipboard: 'old text' });
  const r = j.call('type', {
    steps: [{ kind: 'keys', text: 'echo hi' }, { kind: 'key', keyCode: 36 }, { kind: 'paste', text: 'héllo ☕' }],
    fallbackPaste: true,
  });
  assert.deepEqual(r.result, { steps: 3, pasted: 1, fallback: null, automationError: null });
  assert.deepEqual(j.log.filter((l) => l[0] === 'keystroke'), [['keystroke', 'echo hi']]);
  assert.deepEqual(keysOnly(j.posted), [
    [36, true, 0],
    [36, false, 0],
    [0x37, true, 0x100000],
    [9, true, 0x100000],
    [9, false, 0x100000],
    [0x37, false, 0],
  ]);
  assert.deepEqual(j.pb.writes, ['héllo ☕', 'restore:old text']);
  assert.equal(j.pb.text, 'old text');
});

test('helper: type does not clobber a clipboard changed by someone else', () => {
  const j = makeJxa({ clipboard: 'old' });
  // Simulate another app copying during the paste: bump changeCount after cmd+v.
  const post = j.ctx.$.CGEventPost;
  j.ctx.$.CGEventPost = (tap, e) => {
    post(tap, e);
    if (e.kind === 'key' && e.code === 9 && e.down === false) j.pb.changeCount += 5;
  };
  j.call('type', { steps: [{ kind: 'paste', text: 'ü' }] });
  assert.deepEqual(j.pb.writes, ['ü']);
});

test('helper: keystroke refused by Automation falls back to paste', () => {
  const err = Object.assign(new Error('Not authorized to send Apple events to System Events.'), { errorNumber: -1743 });
  const j = makeJxa({ keystrokeError: err, clipboard: null });
  const r = j.call('type', { steps: [{ kind: 'keys', text: 'abc' }, { kind: 'keys', text: 'def' }], fallbackPaste: true });
  assert.equal(r.ok, true);
  assert.equal(r.result.fallback, 'paste');
  assert.equal(r.result.pasted, 2);
  assert.deepEqual(j.pb.writes, ['abc', 'def']);
  assert.equal(j.pb.text, null, 'an empty clipboard is left empty');
  const strict = makeJxa({ keystrokeError: err });
  const r2 = strict.call('type', { steps: [{ kind: 'keys', text: 'abc' }] });
  assert.deepEqual([r2.ok, r2.code, r2.perm, r2.errorNumber], [false, 'PERMISSION', 'automation', -1743]);
});

test('helper: keystroke without assistive access is an Accessibility error', () => {
  const err = Object.assign(new Error('osascript is not allowed assistive access.'), { errorNumber: -1719 });
  const r = makeJxa({ keystrokeError: err }).call('type', { steps: [{ kind: 'keys', text: 'x' }], fallbackPaste: true });
  assert.deepEqual([r.ok, r.code, r.perm], [false, 'PERMISSION', 'accessibility']);
});

test('helper: displays returns raw frames, ids, scale and CG bounds', () => {
  const j = makeJxa({
    screens: [
      { id: 1, x: 0, y: 0, width: 1440, height: 900, scale: 2, name: 'Built-in' },
      { id: 5, x: -1920, y: 900, width: 1920, height: 1080, scale: 1, name: 'DELL' },
    ],
    cgBounds: { 1: { origin: { x: 0, y: 0 }, size: { width: 1440, height: 900 } }, 5: { origin: { x: -1920, y: -1080 }, size: { width: 1920, height: 1080 } } },
  });
  const r = j.call('displays', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.screens[1], {
    id: 5,
    frame: { x: -1920, y: 900, width: 1920, height: 1080 },
    visible: { x: -1920, y: 900, width: 1920, height: 1055 },
    cg: { x: -1920, y: -1080, width: 1920, height: 1080 },
    scale: 1,
    name: 'DELL',
  });
  const parsed = D.parseDisplays(r.result);
  assert.deepEqual(parsed.map((d) => [d.x, d.y, d.width, d.height, d.scale]), [[0, 0, 1440, 900, 2], [-1920, -1080, 1920, 1080, 1]]);
  // Without CGDisplayBounds the Node side flips the frames itself.
  const noCg = makeJxa({ screens: [{ id: 1, x: 0, y: 0, width: 1440, height: 900, scale: 2 }, { id: 5, x: -1920, y: 900, width: 1920, height: 1080, scale: 1 }] });
  const r2 = noCg.call('displays', {});
  assert.equal(r2.result.screens[1].cg, null);
  assert.deepEqual(D.parseDisplays(r2.result)[1].y, -1080);
});

const CG_WINDOWS = [
  { kCGWindowNumber: 41, kCGWindowOwnerPID: 501, kCGWindowOwnerName: 'Code', kCGWindowName: '', kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowBounds: { X: 0, Y: 25, Width: 1440, Height: 875 } },
  { kCGWindowNumber: 55, kCGWindowOwnerPID: 777, kCGWindowOwnerName: 'Google Chrome', kCGWindowName: 'GCP – Chrome', kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowBounds: { X: 10, Y: 10, Width: 800, Height: 600 } },
  { kCGWindowNumber: 3, kCGWindowOwnerPID: 300, kCGWindowOwnerName: 'Control Center', kCGWindowLayer: 25, kCGWindowBounds: { X: 1, Y: 0, Width: 30, Height: 22 } },
];
const FRONTS = {
  501: { pid: 501, name: 'Code', bundleId: 'com.microsoft.VSCode' },
  777: { pid: 777, name: 'Google Chrome', bundleId: 'com.google.Chrome' },
};

test('helper: windows lists CG windows and fills missing titles from accessibility', () => {
  const j = makeJxa({
    windowList: CG_WINDOWS,
    fronts: { ...FRONTS },
    front: FRONTS[501],
    axWindows: { 501: [{ name: 'Other', x: 300, y: 300, w: 400, h: 300 }, { name: 'server.js — my-repo', x: 0, y: 25, w: 1440, h: 875 }] },
  });
  const r = j.call('windows', { axTitles: true });
  assert.equal(r.ok, true);
  assert.equal(r.result.frontPid, 501);
  assert.equal(r.result.windows.length, 3);
  assert.deepEqual(r.result.ax, { filled: 1 });
  const wins = D.parseWindows(r.result);
  assert.deepEqual(wins.map((w) => [w.id, w.title, w.focused]), [
    ['501:41', 'server.js — my-repo', true],
    ['777:55', 'GCP – Chrome', false],
  ]);
  assert.deepEqual(j.log.find((l) => l[0] === 'windowList'), ['windowList', 1 | 16, 0]);
  // Accessibility refused: titles stay blank, no throw.
  const denied = makeJxa({
    windowList: CG_WINDOWS,
    front: FRONTS[501],
    axError: Object.assign(new Error('osascript is not allowed assistive access.'), { errorNumber: -25211 }),
  });
  const r2 = denied.call('windows', {});
  assert.equal(r2.ok, true);
  assert.equal(r2.result.ax.perm, 'accessibility');
});

test('helper: active reports the frontmost app and its front window', () => {
  const j = makeJxa({ windowList: CG_WINDOWS, fronts: { ...FRONTS }, front: FRONTS[777] });
  const r = j.call('active', {});
  assert.equal(r.ok, true);
  assert.deepEqual(D.parseActive(r.result), { id: '777:55', app: 'Google Chrome', title: 'GCP – Chrome', pid: 777, bundleId: 'com.google.Chrome' });
  assert.equal(makeJxa({ windowList: CG_WINDOWS }).call('active', {}).result, null);
});

test('helper: focus activates the app and raises the matching window', () => {
  const j = makeJxa({
    windowList: CG_WINDOWS,
    fronts: { ...FRONTS },
    front: FRONTS[501],
    axWindows: { 777: [{ name: 'Other', x: 0, y: 0, w: 10, h: 10 }, { name: 'GCP – Chrome', x: 10, y: 10, w: 800, h: 600, AXMinimized: true }] },
  });
  const r = j.call('focus', { pid: 777, number: 55 });
  assert.equal(r.ok, true);
  assert.equal(r.result.ok, true);
  assert.equal(r.result.raised, true);
  assert.equal(r.result.bundlePath, '/Applications/Google Chrome.app');
  assert.deepEqual(j.log.find((l) => l[0] === 'activate'), ['activate', 777, 2]);
  assert.ok(j.log.some((l) => l[0] === 'perform' && l[2] === 'GCP – Chrome' && l[3] === 'AXRaise'));
  assert.ok(j.log.some((l) => l[0] === 'set' && l[3] === 'AXMinimized' && l[4] === false), 'unminimizes first');
  assert.deepEqual(j.log.find((l) => l[0] === 'windowList'), ['windowList', 8, 55]);

  const gone = makeJxa({ windowList: CG_WINDOWS, fronts: { ...FRONTS } });
  assert.equal(gone.call('focus', { pid: 999, number: 1 }).result.ok, false);
  const refused = makeJxa({ windowList: CG_WINDOWS, fronts: { ...FRONTS }, front: FRONTS[501], activationWorks: false, axWindows: { 777: [] } });
  const r2 = refused.call('focus', { pid: 777, number: 55 });
  assert.equal(r2.result.ok, false);
  assert.equal(r2.result.bundleId, 'com.google.Chrome');
});

test('helper: minimize sets AXMinimized on the matching window', () => {
  const j = makeJxa({ windowList: CG_WINDOWS, axWindows: { 777: [{ name: 'GCP – Chrome', x: 10, y: 10, w: 800, h: 600 }] } });
  assert.deepEqual(j.call('minimize', { pid: 777, number: 55 }).result, { ok: true });
  assert.ok(j.log.some((l) => l[0] === 'set' && l[3] === 'AXMinimized' && l[4] === true));
  assert.equal(j.call('minimize', { pid: 777, number: 4040 }).result.ok, false);
  assert.equal(j.call('minimize', { pid: 501, number: 55 }).result.ok, false);
});

test('helper: perms, ping, clipboard and errors', () => {
  assert.deepEqual(
    pick(makeJxa({ perms: { accessibility: false, screenRecording: true } }).call('perms', {}).result, ['accessibility', 'screenRecording']),
    { accessibility: false, screenRecording: true },
  );
  // CGPreflightScreenCaptureAccess missing (old bridge) -> unknown.
  const old = makeJxa({ perms: { accessibility: true } });
  assert.equal(old.call('perms', {}).result.screenRecording, null);
  assert.equal(makeJxa({ perms: null }).call('perms', {}).result.accessibility, null);
  const ping = makeJxa().call('ping', {}).result;
  assert.equal(ping.pong, true);
  assert.equal(ping.pid, 4242);
  const j = makeJxa({ clipboard: 'clip ✓' });
  assert.deepEqual(j.call('clipGet', {}).result, { text: 'clip ✓' });
  j.call('clipSet', { text: 'new 文字' });
  assert.equal(j.pb.text, 'new 文字');
  const unknown = makeJxa().call('rm -rf', {});
  assert.deepEqual([unknown.ok, unknown.code], [false, 'UNKNOWN_COMMAND']);
  const proto = makeJxa().call('constructor', {});
  assert.equal(proto.code, 'UNKNOWN_COMMAND');
});

function pick(o, keys) {
  const out = {};
  for (const k of keys) out[k] = o[k];
  return out;
}

test('helper: classifyError maps Apple event errors', () => {
  const { ctx } = makeJxa();
  const c = (msg, n) => plain(ctx.classifyError(Object.assign(new Error(msg), n == null ? {} : { errorNumber: n })));
  assert.equal(c('x', -1743).perm, 'automation');
  assert.equal(c('System Events got an error: osascript is not allowed assistive access.', -1719).perm, 'accessibility');
  assert.equal(c('Invalid index.', -1719).code, 'NOT_FOUND');
  assert.equal(c("Can't get window 1.", -1728).code, 'NOT_FOUND');
  assert.equal(c('boom').code, 'HELPER_ERROR');
  assert.equal(c('x', -25211).perm, 'accessibility');
});

test('helper: serve mode reads chunked JSON lines and answers in order', () => {
  const j = makeJxa({
    stdin: ['{"id":1,"cmd":"pi', 'ng","args":{}}\n{"id":2,"cmd":"cursor"}\n', 'garbage\n\n', '{"id":3,"cmd":"exit"}\n{"id":4,"cmd":"ping"}\n'],
  });
  j.ctx.run(['serve']);
  const lines = j.stdout.join('').split('\n').filter(Boolean);
  for (const l of lines) assert.ok(/^[\x20-\x7e]+$/.test(l), `ASCII only: ${l}`);
  const msgs = lines.map((l) => JSON.parse(l));
  assert.deepEqual(msgs.map((m) => [m.id, m.ok]), [[0, true], [1, true], [2, true], [null, false], [3, true]]);
  assert.equal(msgs[0].result.ready, true);
  assert.deepEqual(msgs[2].result, { x: 12.5, y: 34 });
  assert.equal(msgs[3].code, 'BAD_REQUEST');
});

test('helper: serve mode exits at end of input', () => {
  const j = makeJxa({ stdin: ['{"id":7,"cmd":"cursor"}\n'] });
  j.ctx.run(['serve']);
  const msgs = j.stdout.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(msgs.map((m) => m.id), [0, 7]);
});

test('helper: one-shot mode prints exactly one JSON line', () => {
  let j = makeJxa();
  j.ctx.run(['move', '{"x":3,"y":4}']);
  assert.deepEqual(j.stdout.map((s) => JSON.parse(s)), [{ id: null, ok: true, result: { x: 3, y: 4 } }]);
  j = makeJxa();
  j.ctx.run(['cursor', '{not json']);
  assert.equal(JSON.parse(j.stdout[0]).code, 'BAD_REQUEST');
  j = makeJxa();
  j.ctx.run([]);
  assert.equal(JSON.parse(j.stdout[0]).result.pong, true);
});

// ===========================================================================
// Driver with a fake transport
// ===========================================================================

function fakeTransport(handlers = {}) {
  return {
    calls: [],
    restarted: 0,
    closed: false,
    mode: 'serve',
    async request(cmd, args = {}, opts = {}) {
      this.calls.push({ cmd, args: plain(args), opts: { ...opts } });
      const h = handlers[cmd];
      if (typeof h === 'function') return h(args, opts);
      if (h !== undefined) return h;
      if (cmd === 'perms') return { accessibility: true, screenRecording: true };
      return { ok: true };
    },
    async restart() {
      this.restarted++;
    },
    async close() {
      this.closed = true;
    },
  };
}

const FAKE_KEYS = {
  toMacKeyCodes: (keys) => {
    FAKE_KEYS.last = keys;
    return { keyCode: 0x11, keyCodes: [0x11], flags: 0x120000, modifierKeyCodes: [0x38, 0x37] };
  },
};

function fakeRun(handler) {
  const calls = [];
  const fn = async (cmd, args = [], opts = {}) => {
    calls.push({ cmd: path.basename(cmd), args, opts });
    const name = path.basename(cmd);
    if (handler) {
      const r = await handler(name, args, opts);
      if (r) return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...r };
    }
    if (name === 'ps') return { code: 1, stdout: '', stderr: 'no ps', timedOut: false, error: null };
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null };
  };
  fn.calls = calls;
  return fn;
}

function mkDriver({ handlers, run, opts } = {}) {
  const t = fakeTransport(handlers);
  const r = run || fakeRun();
  const d = D.createDriver({
    transport: t,
    run: r,
    which: (n) => `/usr/bin/${n}`,
    env: { HOME: '/Users/me', TERM_PROGRAM: 'iTerm.app' },
    keys: FAKE_KEYS,
    pid: 4321,
    ...opts,
  });
  const actions = () => t.calls.filter((c) => c.cmd !== 'perms');
  return { d, t, run: r, actions };
}

const DISPLAYS_PAYLOAD = {
  screens: [
    { id: 1, frame: { x: 0, y: 0, width: 1440, height: 900 }, scale: 2, name: 'Built-in' },
    { id: 2, frame: { x: -1920, y: 900, width: 1920, height: 1080 }, scale: 1, name: 'DELL' },
  ],
};

test('driver: createDriver returns a darwin Driver with every contract method', () => {
  const { d } = mkDriver();
  assert.equal(d.name, 'darwin');
  for (const m of [
    'capabilities', 'displays', 'captureDisplay', 'cursorPosition', 'moveMouse', 'click', 'mouseDown', 'mouseUp', 'drag', 'scroll',
    'typeText', 'keyCombo', 'listWindows', 'activeWindow', 'focusWindow', 'minimizeWindow', 'setTopmost', 'clipboardGet', 'clipboardSet', 'close',
  ]) {
    assert.equal(typeof d[m], 'function', m);
  }
});

test('driver: mouse methods send the right helper requests', async () => {
  const { d, actions } = mkDriver();
  await d.moveMouse(10, 20.5);
  await d.click(30, 40, { button: 'right', clicks: 2, modifiers: ['cmd', 'shift'] });
  await d.click(1, 2);
  await d.mouseDown('left');
  await d.moveMouse(50, 60);
  await d.mouseUp('left');
  await d.moveMouse(70, 80);
  await d.drag(0, 0, 300, 400, { button: 'left' });
  await d.scroll(5, 6, 0.4, 2.6);
  await d.scroll(5, 6, -9999, 0);
  const calls = actions();
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [
    ['move', { x: 10, y: 20.5 }],
    ['click', { x: 30, y: 40, button: 'right', clicks: 2, flags: 0x120000, modifierKeyCodes: [0x38, 0x37] }],
    ['click', { x: 1, y: 2, button: 'left', clicks: 1, flags: 0, modifierKeyCodes: [] }],
    ['down', { button: 'left' }],
    ['move', { x: 50, y: 60, button: 'left' }],
    ['up', { button: 'left' }],
    ['move', { x: 70, y: 80 }],
    ['drag', { x1: 0, y1: 0, x2: 300, y2: 400, button: 'left', steps: 20 }],
    ['scroll', { x: 5, y: 6, dx: 0, dy: 3, linesPerNotch: 3 }],
    ['scroll', { x: 5, y: 6, dx: -200, dy: 0, linesPerNotch: 3 }],
  ]);
  assert.ok(calls[7].opts.timeoutMs > 10000);
  await assert.rejects(d.click(Number.NaN, 1), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(d.click(1, 1, { clicks: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(d.click(1, 1, { button: 'back' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(d.moveMouse('x', 1), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(d.click(1, 1, { modifiers: ['hyper'] }), { code: 'INVALID_ARGUMENT' });
});

test('driver: typeText sends a typing plan; keyCombo uses toMacKeyCodes', async () => {
  const { d, actions } = mkDriver();
  await d.typeText('ls -la\nnaïve');
  await d.typeText('');
  await d.keyCombo(['meta', 'shift', 't']);
  const calls = actions();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, {
    steps: [{ kind: 'keys', text: 'ls -la' }, { kind: 'key', keyCode: 36 }, { kind: 'paste', text: 'naïve' }],
    fallbackPaste: true,
  });
  assert.ok(calls[0].opts.timeoutMs >= 10000);
  assert.deepEqual(FAKE_KEYS.last, ['meta', 'shift', 't']);
  assert.deepEqual(calls[1], { cmd: 'key', args: { keyCode: 0x11, keyCodes: [0x11], flags: 0x120000, modifierKeyCodes: [0x38, 0x37] }, opts: {} });

  const pasting = mkDriver({ opts: { env: { ANYWHERE_DARWIN_TYPING: 'paste' } } });
  await pasting.d.typeText('hello');
  assert.deepEqual(pasting.actions()[0].args.steps, [{ kind: 'paste', text: 'hello' }]);
});

test('driver: keyCombo with the real keys.js table', { skip: realKeys ? false : 'src/os/keys.js is not present yet' }, async () => {
  const { d, actions } = mkDriver({ opts: { keys: undefined } });
  await d.keyCombo(['meta', 'shift', 't']);
  await d.keyCombo(['enter']);
  await d.keyCombo('cmd+space');
  assert.deepEqual(actions().map((c) => c.args), [
    { keyCode: 0x11, keyCodes: [0x11], flags: 0x120000, modifierKeyCodes: [0x38, 0x37] },
    { keyCode: 0x24, keyCodes: [0x24], flags: 0, modifierKeyCodes: [] },
    { keyCode: 0x31, keyCodes: [0x31], flags: 0x100000, modifierKeyCodes: [0x37] },
  ]);
  await assert.rejects(d.keyCombo(['printscreen']), { code: 'UNSUPPORTED' });
});

test('driver: displays, cursor, windows and active window parse helper payloads', async () => {
  const { d } = mkDriver({
    handlers: {
      displays: DISPLAYS_PAYLOAD,
      cursor: { x: -100, y: -50.5 },
      windows: {
        frontPid: 501,
        windows: [{ number: 41, pid: 501, owner: 'Code', title: 'repo', layer: 0, alpha: 1, x: 0, y: 25, width: 1440, height: 875 }],
      },
      active: { pid: 501, app: 'Code', bundleId: 'com.microsoft.VSCode', window: { number: 41, title: 'repo' } },
    },
  });
  const displays = await d.displays();
  assert.deepEqual(displays.map((x) => [x.index, x.x, x.y, x.width, x.height, x.scale, x.primary]), [
    [0, 0, 0, 1440, 900, 2, true],
    [1, -1920, -1080, 1920, 1080, 1, false],
  ]);
  assert.deepEqual(await d.cursorPosition(), { x: -100, y: -50.5 });
  assert.deepEqual(await d.listWindows(), [
    { id: '501:41', app: 'Code', title: 'repo', pid: 501, x: 0, y: 25, width: 1440, height: 875, focused: true, minimized: false },
  ]);
  assert.deepEqual(await d.activeWindow(), { id: '501:41', app: 'Code', title: 'repo', pid: 501, bundleId: 'com.microsoft.VSCode' });
  const empty = mkDriver({ handlers: { displays: { screens: [] } } });
  await assert.rejects(empty.d.displays(), { code: 'NO_DISPLAY' });
});

test('driver: focusWindow, minimizeWindow and setTopmost', async () => {
  const { d, actions } = mkDriver({ handlers: { focus: { ok: true }, minimize: { ok: true } } });
  assert.equal(await d.focusWindow('777:55'), true);
  assert.equal(await d.minimizeWindow('777:55'), true);
  assert.equal(await d.focusWindow('not-an-id'), false);
  assert.equal(await d.minimizeWindow('777'), false, 'an app id has no window to minimize');
  assert.equal(await d.setTopmost('777:55', true), false);
  assert.deepEqual(actions().map((c) => [c.cmd, c.args]), [
    ['focus', { pid: 777, number: 55 }],
    ['minimize', { pid: 777, number: 55 }],
  ]);
});

test('driver: focusWindow falls back to `open -a` when activation is refused', async () => {
  let attempts = 0;
  const run = fakeRun();
  const { d } = mkDriver({
    run,
    handlers: {
      focus: () => {
        attempts++;
        return attempts === 1 ? { ok: false, bundlePath: '/Applications/Google Chrome.app', bundleId: 'com.google.Chrome' } : { ok: true };
      },
    },
  });
  assert.equal(await d.focusWindow('777:55'), true);
  assert.equal(attempts, 2);
  assert.deepEqual(run.calls.find((c) => c.cmd === 'open').args, ['-a', '/Applications/Google Chrome.app']);
  const gone = mkDriver({ handlers: { focus: { ok: false, reason: 'process 9 is not running' } } });
  assert.equal(await gone.d.focusWindow('9:1'), false);
  assert.equal(gone.run.calls.filter((c) => c.cmd === 'open').length, 0);
});

test('driver: minimizeWindow falls back to focus + cmd+M', async () => {
  const { d, actions } = mkDriver({
    handlers: { minimize: { ok: false, reason: 'no matching accessibility window' }, focus: { ok: true } },
  });
  assert.equal(await d.minimizeWindow('777:55'), true);
  assert.deepEqual(actions().map((c) => c.cmd), ['minimize', 'focus', 'key']);
  assert.deepEqual(FAKE_KEYS.last, ['meta', 'm']);
});

test('driver: clipboard uses pbpaste/pbcopy with a UTF-8 locale and falls back to the helper', async () => {
  const run = fakeRun((name) => (name === 'pbpaste' ? { stdout: 'héllo\n' } : null));
  const { d } = mkDriver({ run });
  assert.equal(await d.clipboardGet(), 'héllo\n');
  await d.clipboardSet('ünïcode ✓');
  const paste = run.calls.find((c) => c.cmd === 'pbpaste');
  assert.deepEqual(paste.args, ['-Prefer', 'txt']);
  assert.equal(paste.opts.env.LANG, 'en_US.UTF-8');
  const copy = run.calls.find((c) => c.cmd === 'pbcopy');
  assert.equal(copy.opts.input.toString('utf8'), 'ünïcode ✓');
  assert.equal(copy.opts.env.LC_ALL, 'en_US.UTF-8');

  const broken = fakeRun((name) => (name === 'pbcopy' || name === 'pbpaste' ? { code: 1, stderr: 'no pasteboard' } : null));
  const fb = mkDriver({ run: broken, handlers: { clipGet: { text: 'from helper' } } });
  assert.equal(await fb.d.clipboardGet(), 'from helper');
  await fb.d.clipboardSet('x');
  assert.deepEqual(fb.actions().map((c) => [c.cmd, c.args]), [['clipGet', {}], ['clipSet', { text: 'x' }]]);
});

function shotRun(pngFor) {
  return fakeRun(async (name, args) => {
    if (name !== 'screencapture') return null;
    const file = args[args.length - 1];
    const png = pngFor(args);
    if (png) await fs.promises.writeFile(file, png);
    return { code: png === null ? 1 : 0, stderr: png === null ? 'could not create image from display' : '' };
  });
}

test('driver: captureDisplay runs screencapture -D and reads the PNG size', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-darwin-'));
  try {
    const run = shotRun(() => makePng(1920, 1080));
    const { d } = mkDriver({ run, handlers: { displays: DISPLAYS_PAYLOAD }, opts: { tmpdir: tmp } });
    const shot = await d.captureDisplay(1);
    assert.equal(shot.width, 1920);
    assert.equal(shot.height, 1080);
    assert.ok(Buffer.isBuffer(shot.png));
    const call = run.calls.find((c) => c.cmd === 'screencapture');
    assert.deepEqual(call.args.slice(0, 6), ['-x', '-C', '-D', '2', '-t', 'png']);
    assert.equal(path.dirname(call.args[6]), tmp);
    assert.ok(call.args[6].endsWith('.png'));
    assert.deepEqual(fs.readdirSync(tmp), [], 'the temp file is removed');
    await assert.rejects(d.captureDisplay(2), { code: 'INVALID_DISPLAY' });
    await assert.rejects(d.captureDisplay(-1), { code: 'INVALID_ARGUMENT' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('driver: captureDisplay falls back to the display rectangle when -D picks another screen', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-darwin-'));
  try {
    const run = shotRun((args) => (args.includes('-D') ? makePng(2880, 1800) : makePng(1920, 1080)));
    const { d } = mkDriver({ run, handlers: { displays: DISPLAYS_PAYLOAD }, opts: { tmpdir: tmp } });
    const shot = await d.captureDisplay(1);
    assert.deepEqual([shot.width, shot.height], [1920, 1080]);
    const calls = run.calls.filter((c) => c.cmd === 'screencapture');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].args.includes('-R-1920,-1080,1920,1080'), calls[1].args.join(' '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('driver: a failed or empty capture is a PERMISSION error with a Screen Recording hint', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-darwin-'));
  try {
    for (const png of [null, Buffer.alloc(0)]) {
      const { d } = mkDriver({ run: shotRun(() => png), handlers: { displays: DISPLAYS_PAYLOAD }, opts: { tmpdir: tmp } });
      const err = await d.captureDisplay(0).then(
        () => null,
        (e) => e,
      );
      assert.ok(err, 'rejects');
      assert.equal(err.code, 'PERMISSION');
      assert.equal(err.permission, 'screenRecording');
      assert.match(err.hint, /Screen Recording/);
      assert.match(err.hint, /"iTerm"/);
      assert.match(err.hint, /Privacy_ScreenCapture/);
      assert.equal(err.settingsUrl, D.SETTINGS_URLS.screenRecording);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('driver: missing Screen Recording blocks the capture before running screencapture', async () => {
  const run = shotRun(() => makePng(10, 10));
  const { d, t } = mkDriver({ run, handlers: { displays: DISPLAYS_PAYLOAD, perms: { accessibility: true, screenRecording: false } } });
  await assert.rejects(d.captureDisplay(0), (err) => err.code === 'PERMISSION' && err.permission === 'screenRecording');
  assert.equal(run.calls.filter((c) => c.cmd === 'screencapture').length, 0);
  assert.ok(t.calls.some((c) => c.cmd === 'perms' && c.opts.oneShot === true), 're-checks with a fresh helper');
});

test('driver: input is refused with a PERMISSION error when Accessibility is not granted', async () => {
  const { d, t, actions } = mkDriver({ handlers: { perms: { accessibility: false, screenRecording: true } } });
  const err = await d.click(1, 2).then(
    () => null,
    (e) => e,
  );
  assert.equal(err.code, 'PERMISSION');
  assert.equal(err.permission, 'accessibility');
  assert.match(err.hint, /Accessibility/);
  assert.match(err.hint, /Privacy_Accessibility/);
  assert.match(err.hint, /Terminal, iTerm, VS Code or Electron/);
  assert.deepEqual(actions(), [], 'no input event was sent');
  assert.equal(t.calls.filter((c) => c.opts.oneShot).length, 1);
  for (const fn of [() => d.typeText('x'), () => d.keyCombo(['enter']), () => d.scroll(0, 0, 0, 1), () => d.drag(0, 0, 1, 1)]) {
    await assert.rejects(fn(), { code: 'PERMISSION' });
  }
});

test('driver: a stale "not trusted" answer is re-checked with a fresh helper', async () => {
  const { d, t, actions } = mkDriver({
    handlers: { perms: (args, opts) => ({ accessibility: Boolean(opts.oneShot), screenRecording: true }) },
  });
  await d.click(1, 2);
  assert.equal(t.restarted, 1, 'the long-lived helper is replaced');
  assert.deepEqual(actions().map((c) => c.cmd), ['click']);
  await d.click(3, 4);
  assert.equal(t.calls.filter((c) => c.cmd === 'perms').length, 2, 'a positive answer is cached');
});

test('driver: permission checks can be disabled and are cached', async () => {
  const off = mkDriver({ opts: { checkPermissions: false } });
  await off.d.click(1, 1);
  assert.equal(off.t.calls.filter((c) => c.cmd === 'perms').length, 0);
  const env = mkDriver({ opts: { env: { ANYWHERE_DARWIN_SKIP_PERMCHECK: '1' } } });
  await env.d.moveMouse(1, 1);
  assert.equal(env.t.calls.filter((c) => c.cmd === 'perms').length, 0);
  const on = mkDriver();
  await on.d.click(1, 1);
  await on.d.moveMouse(1, 1);
  await on.d.typeText('a');
  assert.equal(on.t.calls.filter((c) => c.cmd === 'perms').length, 1);
});

test('driver: helper permission errors get hints for the right pane', async () => {
  const { d } = mkDriver({
    handlers: {
      type: () => {
        throw Object.assign(new Error('type: Not authorized to send Apple events to System Events.'), { code: 'PERMISSION', permission: 'automation' });
      },
    },
  });
  const err = await d.typeText('hello').then(
    () => null,
    (e) => e,
  );
  assert.equal(err.code, 'PERMISSION');
  assert.match(err.hint, /System Events/);
  assert.equal(err.settingsUrl, D.SETTINGS_URLS.automation);
});

test('driver: capabilities reports permissions with actionable notes and never throws', async () => {
  const { d } = mkDriver({ handlers: { perms: { accessibility: false, screenRecording: true } } });
  const caps = await d.capabilities();
  assert.equal(caps.mouse, false);
  assert.equal(caps.keyboard, false);
  assert.equal(caps.screenshot, true);
  assert.equal(caps.windows, true);
  assert.equal(caps.clipboard, true);
  assert.equal(caps.notify, true);
  assert.equal(caps.speak, true);
  assert.deepEqual(caps.permissions.accessibility, false);
  assert.equal(caps.permissions.hostApp, 'iTerm');
  assert.ok(caps.notes.some((n) => n.includes('Privacy_Accessibility')));
  assert.ok(Array.isArray(caps.notes));

  const sr = await mkDriver({ handlers: { perms: { accessibility: true, screenRecording: false } } }).d.capabilities();
  assert.equal(sr.screenshot, false);
  assert.equal(sr.mouse, true);
  assert.ok(sr.notes.some((n) => n.includes('Privacy_ScreenCapture')));

  const broken = mkDriver({
    handlers: {
      perms: () => {
        throw Object.assign(new Error('osascript crashed'), { code: 'HELPER_FAILED' });
      },
    },
  });
  const caps2 = await broken.d.capabilities();
  assert.equal(caps2.mouse, false);
  assert.equal(caps2.windows, false);
  assert.ok(caps2.notes.some((n) => n.includes('osascript crashed')));

  const nomac = D.createDriver({ which: () => null, exists: () => false, run: fakeRun() });
  const caps3 = await nomac.capabilities();
  assert.equal(caps3.screenshot, false);
  assert.match(caps3.notes[0], /osascript was not found/);
});

test('driver: close stops the transport and forgets held buttons', async () => {
  const { d, t, actions } = mkDriver();
  await d.mouseDown('right');
  await d.close();
  assert.equal(t.closed, true);
  await d.moveMouse(1, 1);
  assert.deepEqual(actions().pop().args, { x: 1, y: 1 });
});

// ===========================================================================
// HelperTransport with injected spawn / run
// ===========================================================================

function fakeChild(behavior, spawned) {
  const child = new EventEmitter();
  child.pid = 9000 + spawned.length;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.lines = [];
  child.killedWith = null;
  child.exited = false;
  const exit = (code, signal) => {
    if (child.exited) return;
    child.exited = true;
    setImmediate(() => child.emit('exit', code, signal));
  };
  child.exit = exit;
  child.kill = (sig) => {
    child.killedWith = sig;
    exit(null, sig);
    return true;
  };
  let buf = '';
  child.stdin = new Writable({
    write(chunk, enc, cb) {
      buf += chunk.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        child.lines.push(line);
        if (behavior.onRequest) behavior.onRequest(child, JSON.parse(line), line);
        nl = buf.indexOf('\n');
      }
      cb();
    },
    final(cb) {
      child.stdinEnded = true;
      exit(0, null);
      cb();
    },
  });
  return child;
}

function fakeSpawn(behavior) {
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    if (behavior.throwOnSpawn) throw behavior.throwOnSpawn;
    const child = fakeChild(behavior, spawned);
    spawned.push({ cmd, args, opts, child });
    setImmediate(() => (behavior.onStart ? behavior.onStart(child) : ready(child)));
    return child;
  };
  spawn.spawned = spawned;
  return spawn;
}

function ready(child) {
  child.stdout.write('Last login: some noise\n');
  child.stdout.write('{"id":0,"ok":true,"result":{"ready":true,"version":1}}\n');
}

function reply(child, msg) {
  child.stdout.write(`${JSON.stringify(msg)}\n`);
}

function oneShotRun(result) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return typeof result === 'function' ? result(cmd, args, opts) : result;
  };
  run.calls = calls;
  return run;
}

const echo = {
  onRequest(child, req) {
    child.stdout.write('stray osascript text\n');
    reply(child, { id: req.id, ok: true, result: { cmd: req.cmd, args: req.args } });
  },
};

test('transport: serve mode matches responses by id and ignores stray output', async () => {
  const spawn = fakeSpawn(echo);
  const t = new D.HelperTransport({ spawn, run: oneShotRun({ code: 1, stdout: '' }), osascript: '/usr/bin/osascript' });
  const r = await t.request('click', { x: 1, title: 'Ω 😀' });
  assert.deepEqual(r, { cmd: 'click', args: { x: 1, title: 'Ω 😀' } });
  assert.deepEqual(await t.request('cursor'), { cmd: 'cursor', args: {} });
  assert.equal(spawn.spawned.length, 1);
  const s = spawn.spawned[0];
  assert.equal(s.cmd, '/usr/bin/osascript');
  assert.deepEqual(s.args, ['-l', 'JavaScript', D.HELPER_PATH, 'serve']);
  for (const line of s.child.lines) assert.ok(/^[\x20-\x7e]+$/.test(line), `requests are ASCII: ${line}`);
  assert.equal(t.mode, 'serve');
  assert.equal(t.pid, s.child.pid);
  await t.close();
  assert.equal(s.child.stdinEnded, true);
});

test('transport: responses split across chunks and concurrent requests stay ordered', async () => {
  const order = [];
  const spawn = fakeSpawn({
    onRequest(child, req) {
      order.push(`got:${req.id}`);
      const text = JSON.stringify({ id: req.id, ok: true, result: req.args.n });
      setTimeout(() => {
        child.stdout.write(text.slice(0, 5));
        setTimeout(() => {
          order.push(`answered:${req.id}`);
          child.stdout.write(`${text.slice(5)}\n`);
        }, 5);
      }, 5);
    },
  });
  const t = new D.HelperTransport({ spawn, run: oneShotRun({}) });
  const results = await Promise.all([t.request('a', { n: 1 }), t.request('b', { n: 2 }), t.request('c', { n: 3 })]);
  assert.deepEqual(results, [1, 2, 3]);
  const ids = order.map((o) => o.split(':')[1]);
  assert.deepEqual(order.map((o) => o.split(':')[0]), ['got', 'answered', 'got', 'answered', 'got', 'answered']);
  assert.deepEqual(ids, [ids[0], ids[0], ids[2], ids[2], ids[4], ids[4]]);
  await t.close();
});

test('transport: helper errors keep their code and permission', async () => {
  const spawn = fakeSpawn({
    onRequest(child, req) {
      reply(child, { id: req.id, ok: false, error: 'not allowed assistive access', code: 'PERMISSION', perm: 'accessibility', errorNumber: -1719 });
    },
  });
  const t = new D.HelperTransport({ spawn, run: oneShotRun({}) });
  await assert.rejects(t.request('type', {}), (err) => {
    assert.equal(err.code, 'PERMISSION');
    assert.equal(err.permission, 'accessibility');
    assert.equal(err.errorNumber, -1719);
    assert.match(err.message, /^type: /);
    return true;
  });
  await t.close();
});

test('transport: a stuck helper times out, is killed, and is replaced', async () => {
  const spawn = fakeSpawn({
    onRequest(child, req) {
      if (req.cmd !== 'hang') reply(child, { id: req.id, ok: true, result: 'ok' });
    },
  });
  const t = new D.HelperTransport({ spawn, run: oneShotRun({}) });
  await assert.rejects(t.request('hang', {}, { timeoutMs: 30 }), { code: 'TIMEOUT' });
  assert.equal(spawn.spawned[0].child.killedWith, 'SIGKILL');
  assert.equal(await t.request('ping'), 'ok');
  assert.equal(spawn.spawned.length, 2);
  assert.equal(t.mode, 'serve', 'a deliberate kill is not counted as a crash');
  await t.close();
});

test('transport: a crash retries idempotent commands one-shot and fails input commands', async () => {
  const spawn = fakeSpawn({
    onRequest(child) {
      child.stderr.write('execution error: boom (-2700)\n');
      child.exit(1, null);
    },
  });
  const run = oneShotRun({ code: 0, stdout: 'noise\n{"id":null,"ok":true,"result":{"screens":[]}}\n', stderr: '', timedOut: false, error: null });
  const t = new D.HelperTransport({ spawn, run, maxServeFailures: 10 });
  assert.deepEqual(await t.request('displays'), { screens: [] });
  assert.deepEqual(run.calls[0].args, ['-l', 'JavaScript', D.HELPER_PATH, 'displays', '{}']);
  await assert.rejects(t.request('click', { x: 1, y: 1 }), (err) => {
    assert.equal(err.code, 'HELPER_EXITED');
    assert.match(err.message, /boom/);
    return true;
  });
  assert.equal(run.calls.length, 1, 'input commands are never replayed');
  assert.equal(spawn.spawned.length, 2, 'restarts after a crash');
});

test('transport: repeated crashes switch to one-shot mode', async () => {
  const spawn = fakeSpawn({ onRequest: (child) => child.exit(1, null) });
  const run = oneShotRun({ code: 0, stdout: '{"id":null,"ok":true,"result":1}\n', stderr: '' });
  const t = new D.HelperTransport({ spawn, run, maxServeFailures: 2 });
  await t.request('ping');
  await t.request('ping');
  assert.equal(t.mode, 'oneshot');
  await t.request('ping');
  assert.equal(spawn.spawned.length, 2);
});

test('transport: falls back to one-shot osascript when serve mode cannot start', async () => {
  const spawn = fakeSpawn({
    onStart(child) {
      child.stderr.write('osascript: darwin-helper.js: execution error: Error: ReferenceError\n');
      child.exit(1, null);
    },
  });
  const run = oneShotRun((cmd, args) => ({
    code: 0,
    stdout: `${JSON.stringify({ id: null, ok: true, result: { cmd: args[3], args: JSON.parse(args[4]) } })}\n`,
    stderr: '',
    timedOut: false,
    error: null,
  }));
  const t = new D.HelperTransport({ spawn, run, osascript: 'osascript', maxServeFailures: 2 });
  assert.deepEqual(await t.request('move', { x: 1, y: 2, s: 'é' }), { cmd: 'move', args: { x: 1, y: 2, s: 'é' } });
  assert.equal(run.calls.length, 1);
  assert.deepEqual(run.calls[0].args.slice(0, 4), ['-l', 'JavaScript', D.HELPER_PATH, 'move']);
  assert.ok(/^[\x20-\x7e]+$/.test(run.calls[0].args[4]), 'one-shot JSON argument is ASCII');
  assert.ok(run.calls[0].opts.timeoutMs > 10000, 'one-shot budget includes osascript start-up');
  assert.equal(t.mode, 'serve');
  await t.request('cursor');
  assert.equal(t.mode, 'oneshot', 'gives up on serve after repeated failures');
  await t.request('cursor');
  assert.equal(spawn.spawned.length, 2);
  assert.equal(run.calls.length, 3);
});

test('transport: falls back when spawn throws or the helper never becomes ready', async () => {
  const run = oneShotRun({ code: 0, stdout: '{"id":null,"ok":true,"result":"ok"}\n', stderr: '' });
  const throwing = new D.HelperTransport({
    spawn: fakeSpawn({ throwOnSpawn: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) }),
    run,
  });
  assert.equal(await throwing.request('ping'), 'ok');

  const silentSpawn = fakeSpawn({ onStart() {} });
  const silent = new D.HelperTransport({ spawn: silentSpawn, run, startTimeoutMs: 30 });
  assert.equal(await silent.request('ping'), 'ok');
  assert.equal(silentSpawn.spawned[0].child.killedWith, 'SIGKILL');
});

test('transport: a missing osascript is UNSUPPORTED with a hint', async () => {
  const enoent = Object.assign(new Error('spawn osascript ENOENT'), { code: 'ENOENT' });
  const spawn = fakeSpawn({ onStart: (child) => child.emit('error', enoent) });
  const run = oneShotRun({ code: null, stdout: '', stderr: '', error: enoent });
  const t = new D.HelperTransport({ spawn, run });
  await assert.rejects(t.request('ping'), (err) => err.code === 'UNSUPPORTED' && /macOS/.test(err.hint));
  assert.equal(run.calls.length, 0);
  const one = new D.HelperTransport({ spawn, run, oneShotOnly: true });
  await assert.rejects(one.request('ping'), { code: 'UNSUPPORTED' });
});

test('transport: one-shot failures carry stderr; timeouts are TIMEOUT', async () => {
  const bad = new D.HelperTransport({
    oneShotOnly: true,
    run: oneShotRun({ code: 1, stdout: '', stderr: 'darwin-helper.js: execution error: Error: Can\'t convert types. (-1700)\n' }),
  });
  await assert.rejects(bad.request('ping'), (err) => err.code === 'HELPER_FAILED' && /-1700/.test(err.message));
  const slow = new D.HelperTransport({ oneShotOnly: true, run: oneShotRun({ code: null, stdout: '', stderr: '', timedOut: true }) });
  await assert.rejects(slow.request('ping'), { code: 'TIMEOUT' });
  const perm = new D.HelperTransport({
    oneShotOnly: true,
    run: oneShotRun({ code: 0, stdout: '{"id":null,"ok":false,"error":"nope","code":"PERMISSION","perm":"automation"}\n', stderr: '' }),
  });
  await assert.rejects(perm.request('type'), (err) => err.code === 'PERMISSION' && err.permission === 'automation');
});

test('transport: oneShot forces a fresh process; helpers are recycled after maxRequests', async () => {
  const spawn = fakeSpawn(echo);
  const run = oneShotRun({ code: 0, stdout: '{"id":null,"ok":true,"result":"fresh"}\n', stderr: '' });
  const t = new D.HelperTransport({ spawn, run, maxRequests: 2 });
  assert.equal(await t.request('perms', {}, { oneShot: true }), 'fresh');
  assert.equal(spawn.spawned.length, 0);
  await t.request('a');
  await t.request('b');
  await new Promise((r) => setImmediate(r));
  assert.equal(spawn.spawned[0].child.stdinEnded, true, 'recycled gracefully');
  await t.request('c');
  assert.equal(spawn.spawned.length, 2);
  await t.restart();
  await new Promise((r) => setImmediate(r));
  assert.equal(spawn.spawned[1].child.stdinEnded, true);
  await t.request('d');
  assert.equal(spawn.spawned.length, 3);
  await t.close();
});

// ===========================================================================
// End to end through real processes: a stand-in `osascript` executable runs the
// real darwin-helper.js under Node with a tiny fake ObjC bridge.
// ===========================================================================

function writeFakeOsascript(dir) {
  const file = path.join(dir, 'osascript');
  const src = `#!${process.execPath}
'use strict';
const fs = require('fs');
const vm = require('vm');
const argv = process.argv.slice(2);
const helper = argv[2];
const rest = argv.slice(3);
if (process.env.FAKE_OSASCRIPT_FAIL_SERVE === '1' && rest[0] === 'serve') {
  process.stderr.write('darwin-helper.js: execution error: Error: serve disabled (-2700)\\n');
  process.exit(1);
}
const state = { x: 5, y: 6 };
const wrap = (v) => ({ __v: v, isNil: () => false, dataUsingEncoding: () => ({ __text: String(v) }) });
const $ = (v) => wrap(v);
function readStdin() {
  const b = Buffer.alloc(65536);
  for (;;) {
    try {
      return b.subarray(0, fs.readSync(0, b, 0, b.length, null)).toString('utf8');
    } catch (e) {
      if (e.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; }
      if (e.code === 'EOF') return '';
      throw e;
    }
  }
}
Object.assign($, {
  NSFileHandle: {
    fileHandleWithStandardInput: { get availableData() { return { __text: readStdin() }; } },
    fileHandleWithStandardOutput: { writeData: (d) => fs.writeSync(1, d.__text) },
  },
  NSString: { alloc: { initWithDataEncoding: (d) => wrap(d.__text) } },
  NSProcessInfo: { processInfo: { processIdentifier: process.pid, operatingSystemVersionString: wrap('Fake macOS') } },
  NSThread: { sleepForTimeInterval: () => {} },
  NSRunLoop: { currentRunLoop: { runUntilDate: () => {} } },
  NSDate: { dateWithTimeIntervalSinceNow: () => ({}) },
  CGPointMake: (x, y) => ({ x, y }),
  CGEventCreate: () => ({}),
  CGEventGetLocation: () => ({ x: state.x, y: state.y }),
  CGEventCreateMouseEvent: (s, type, p) => ({ type, p }),
  CGEventSetIntegerValueField: () => {},
  CGEventSetFlags: () => {},
  CGEventPost: (tap, e) => { if (e.type === 5) { state.x = e.p.x; state.y = e.p.y; } },
  AXIsProcessTrusted: () => true,
  CGPreflightScreenCaptureAccess: () => false,
});
const ObjC = { import: () => {}, unwrap: (v) => (v && typeof v === 'object' && '__v' in v ? v.__v : v), deepUnwrap: (v) => v, castRefToObject: (v) => v };
const ctx = vm.createContext({ ObjC, $, Application: () => { throw new Error('System Events is not available'); } });
vm.runInContext(fs.readFileSync(helper, 'utf8'), ctx, { filename: helper });
ctx.run(rest);
`;
  fs.writeFileSync(file, src, { mode: 0o755 });
  return file;
}

const posixOnly = process.platform === 'win32' ? 'needs an executable script (POSIX shebang)' : false;

test('e2e: the real helper serves JSON lines over real pipes', { skip: posixOnly }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-fake-osascript-'));
  const t = new D.HelperTransport({ osascript: writeFakeOsascript(dir), timeoutMs: 8000 });
  try {
    const ping = await t.request('ping');
    assert.equal(ping.pong, true);
    assert.equal(ping.os, 'Fake macOS');
    assert.equal(t.pid, ping.pid, 'answered by the persistent helper process');
    await t.request('move', { x: 100.5, y: -20, note: 'ünïcødé ☕' });
    assert.deepEqual(await t.request('cursor'), { x: 100.5, y: -20 }, 'state persists inside one helper');
    assert.deepEqual(plain(await t.request('perms')), { accessibility: true, screenRecording: false, os: 'Fake macOS', pid: ping.pid });
    await assert.rejects(t.request('bogus'), { code: 'UNKNOWN_COMMAND' });
    await assert.rejects(t.request('type', { steps: [{ kind: 'keys', text: 'x' }] }), { code: 'HELPER_ERROR' });
    assert.equal(t.mode, 'serve');
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e: falls back to one-shot processes when serve mode fails', { skip: posixOnly }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-fake-osascript-'));
  const env = { ...process.env, FAKE_OSASCRIPT_FAIL_SERVE: '1' };
  const t = new D.HelperTransport({ osascript: writeFakeOsascript(dir), env, maxServeFailures: 1 });
  try {
    assert.deepEqual(await t.request('cursor'), { x: 5, y: 6 });
    assert.equal(t.mode, 'oneshot');
    await t.request('move', { x: 1, y: 2 });
    assert.deepEqual(await t.request('cursor'), { x: 5, y: 6 }, 'every one-shot call is a fresh process');
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e: the driver drives the helper through the fake osascript', { skip: posixOnly }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-fake-osascript-'));
  const fake = writeFakeOsascript(dir);
  const d = D.createDriver({ which: (n) => (n === 'osascript' ? fake : null), exists: () => false, run: fakeRun(), env: { ...process.env, TERM_PROGRAM: 'Apple_Terminal' } });
  try {
    await d.moveMouse(320, 240);
    assert.deepEqual(await d.cursorPosition(), { x: 320, y: 240 });
    const caps = await d.capabilities();
    assert.equal(caps.mouse, true);
    assert.equal(caps.permissions.screenRecording, false);
    assert.equal(caps.permissions.hostApp, 'Terminal');
  } finally {
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transport: close rejects in-flight requests', async () => {
  const spawn = fakeSpawn({ onRequest() {} });
  const t = new D.HelperTransport({ spawn, run: oneShotRun({}) });
  const p = t.request('hang', {}, { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 20));
  await t.close();
  await assert.rejects(p, { code: 'CLOSED' });
});
