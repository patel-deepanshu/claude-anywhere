'use strict';

// Round-2 regression tests for the macOS helper (src/os/darwin-helper.js): keyboard layout
// lookups by modifier layer, run-loop pumping, paste timing, dead keys, and System Events
// references with several processes of the same name. The helper runs in a vm with a fake
// JXA bridge; nothing here needs a Mac.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HELPER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'os', 'darwin-helper.js'), 'utf8');

const SHIFT = 0x20000;
const CTRL = 0x40000;
const ALT = 0x80000;
const CMD = 0x100000;

const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const wrap = (v) => ({ __v: v, isNil: () => false });
const unwrap = (v) => (v && typeof v === 'object' && '__v' in v ? v.__v : v);
const nsArray = (items) => ({ count: items.length, objectAtIndex: (i) => items[i], isNil: () => false });

// ----------------------------------------------------------------- keyboard layouts

// US ANSI: the character each key code types without modifiers (0x53 is keypad 1).
const US = {
  0x00: 'a', 0x01: 's', 0x02: 'd', 0x03: 'f', 0x04: 'h', 0x05: 'g', 0x06: 'z', 0x07: 'x', 0x08: 'c', 0x09: 'v',
  0x0b: 'b', 0x0c: 'q', 0x0d: 'w', 0x0e: 'e', 0x0f: 'r', 0x10: 'y', 0x11: 't', 0x12: '1', 0x13: '2', 0x14: '3',
  0x15: '4', 0x16: '6', 0x17: '5', 0x18: '=', 0x19: '9', 0x1a: '7', 0x1b: '-', 0x1c: '8', 0x1d: '0', 0x1e: ']',
  0x1f: 'o', 0x20: 'u', 0x21: '[', 0x22: 'i', 0x23: 'p', 0x24: '\r', 0x25: 'l', 0x26: 'j', 0x27: "'", 0x28: 'k',
  0x29: ';', 0x2a: '\\', 0x2b: ',', 0x2c: '/', 0x2d: 'n', 0x2e: 'm', 0x2f: '.', 0x30: '\t', 0x31: ' ', 0x32: '`',
  0x53: '1',
};
const US_SHIFTED = {
  1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~',
};
/** The Shift layer: letters upper-cased, US punctuation shifted, then `extra`. */
function shifted(base, extra = {}, usPunct = true) {
  const out = {};
  for (const [code, c] of Object.entries(base)) {
    if (/^[a-z]$/.test(c)) out[code] = c.toUpperCase();
    else if (usPunct && US_SHIFTED[c]) out[code] = US_SHIFTED[c];
  }
  return { ...out, ...extra };
}

const GERMAN = {
  ...US, 0x10: 'z', 0x06: 'y', 0x1b: 'ß', 0x18: '´', 0x21: 'ü', 0x1e: '+', 0x29: 'ö', 0x27: 'ä', 0x2a: '#', 0x2c: '-',
  0x32: '<', 0x0a: '^',
};
const GERMAN_LAYERS = {
  0: GERMAN,
  [SHIFT]: shifted(GERMAN, {
    0x12: '!', 0x13: '"', 0x14: '§', 0x15: '$', 0x17: '%', 0x16: '&', 0x1a: '/', 0x1c: '(', 0x19: ')', 0x1d: '=',
    0x1b: '?', 0x18: '', 0x1e: '*', 0x2a: "'", 0x2b: ';', 0x2f: ':', 0x2c: '_', 0x32: '>', 0x0a: '°',
  }, false),
  [ALT]: { 0x25: '@', 0x17: '[', 0x16: ']', 0x1c: '{', 0x19: '}', 0x1a: '|', 0x00: 'å' },
  [ALT | SHIFT]: { 0x1a: '\\' },
};

const AZERTY = {
  ...US, 0x0c: 'a', 0x00: 'q', 0x0d: 'z', 0x06: 'w', 0x29: 'm', 0x2e: ',', 0x2b: ';', 0x2f: ':', 0x2c: '=',
  0x12: '&', 0x13: 'é', 0x14: '"', 0x15: "'", 0x17: '(', 0x16: '§', 0x1a: 'è', 0x1c: '!', 0x19: 'ç', 0x1d: 'à',
  0x1b: ')', 0x18: '-', 0x1e: '$', 0x27: 'ù', 0x2a: '`', 0x32: '<',
};
const AZERTY_LAYERS = {
  0: AZERTY,
  [SHIFT]: shifted(AZERTY, {
    0x12: '1', 0x13: '2', 0x14: '3', 0x15: '4', 0x17: '5', 0x16: '6', 0x1a: '7', 0x1c: '8', 0x19: '9', 0x1d: '0',
    0x1b: '°', 0x18: '_', 0x2c: '+', 0x2b: '.', 0x2f: '/', 0x2e: '?', 0x1e: '*', 0x27: '%', 0x2a: '£', 0x32: '>',
  }, false),
};

// QWERTY key -> the Dvorak character on it.
const DVORAK = {
  ...US, 0x0c: "'", 0x0d: ',', 0x0e: '.', 0x0f: 'p', 0x11: 'y', 0x10: 'f', 0x20: 'g', 0x22: 'c', 0x1f: 'r', 0x23: 'l',
  0x21: '/', 0x1e: '=', 0x00: 'a', 0x01: 'o', 0x02: 'e', 0x03: 'u', 0x05: 'i', 0x04: 'd', 0x26: 'h', 0x28: 't',
  0x25: 'n', 0x29: 's', 0x27: '-', 0x06: ';', 0x07: 'q', 0x08: 'j', 0x09: 'k', 0x0b: 'x', 0x2d: 'b', 0x2e: 'm',
  0x2b: 'w', 0x2f: 'v', 0x2c: 'z', 0x1b: '[', 0x18: ']',
};

/** A non-Latin layout: every US letter replaced, plus `punct` overrides. */
function nonLatin(alphabet, punct) {
  const out = { ...US };
  let i = 0;
  for (const [code, c] of Object.entries(US)) {
    if (/^[a-z]$/.test(c)) out[code] = alphabet[i++ % alphabet.length];
  }
  return { ...out, ...punct };
}
// Hebrew: the Q key types '/', W types "'", and the '/' key types '.'.
const HEBREW = nonLatin('שנבגקכעיןחלךצמםפרדאוה', { 0x0c: '/', 0x0d: "'", 0x2c: '.', 0x2f: 'ץ', 0x2b: 'ת', 0x29: 'ף' });
// Greek: the Q key types ';'.
const GREEK = nonLatin('αβψδεφγηιξκλμνοπρστθωχυζ', { 0x0c: ';', 0x0d: 'ς', 0x29: '΄' });

const LAYOUT_TIS = (id, ascii) => ({ id, ascii, type: 'TISTypeKeyboardLayout' });

// ----------------------------------------------------------------- fake JXA world

/**
 * @param {object} opts
 *   layers      {flags: {code: char}}: layer 0 also answers charactersIgnoringModifiers; a missing
 *               Command layer falls back to the layer without Command (no separate keymap)
 *   tis         TIS input source (and keyboard layout, unless layoutTis is given)
 *   defaults    com.apple.HIToolbox preferences when TIS is unavailable
 *   processes   [{pid, name, bundleId, windows: [{name, x, y, w, h, closeButton?: 'attribute'}]}] in System Events order
 *   windowList  CG window list
 */
function world(opts = {}) {
  const events = [];
  const front = { pid: opts.front || null };
  const procs = opts.processes || [];
  const byPid = (pid) => procs.find((p) => p.pid === pid);
  // System Events resolves a reference that names a process by name to the first such process.
  const byName = (name) => procs.find((p) => p.name === name);

  const pb = {
    text: opts.clipboard === undefined ? 'previous' : opts.clipboard,
    changeCount: 1,
    get clearContents() {
      this.changeCount++;
      this.text = null;
      return true;
    },
    setStringForType(s) {
      this.text = unwrap(s);
      this.changeCount++;
      events.push(['clip', this.text]);
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
      this.changeCount++;
      events.push(['restore', this.text]);
      return true;
    },
  };

  const layer = (flags) => {
    const L = opts.layers || {};
    if (L[flags]) return L[flags];
    if (flags & CMD) return layer(flags & ~CMD);
    return {};
  };

  const $ = (v) => ({ __v: v, isNil: () => false, dataUsingEncoding: () => ({ __text: v }) });
  Object.assign($, {
    CGEventCreateKeyboardEvent: (src, code, down) => ({ kind: 'key', code, down, flags: 0 }),
    CGEventSetFlags: (e, f) => {
      e.flags = f;
    },
    CGEventPost: (tap, e) => events.push(['key', e.code, e.down, e.flags]),
    NSThread: { sleepForTimeInterval: (s) => events.push(['sleep', s]) },
    NSRunLoop: { currentRunLoop: { runUntilDate: () => events.push(['pump']) } },
    NSDate: { dateWithTimeIntervalSinceNow: () => ({}) },
    NSProcessInfo: { processInfo: { processIdentifier: 4242, operatingSystemVersionString: wrap('Version 14.5') } },
    NSPasteboard: { generalPasteboard: pb },
    NSPasteboardTypeString: wrap('public.utf8-plain-text'),
    NSPasteboardItem: {
      alloc: {
        get init() {
          return {
            data: {},
            setDataForType(d, t) {
              this.data[unwrap(t)] = d;
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
    NSWorkspace: {
      sharedWorkspace: {
        get frontmostApplication() {
          const p = byPid(front.pid);
          return p ? { isNil: () => false, processIdentifier: p.pid, localizedName: wrap(p.name), bundleIdentifier: wrap(p.bundleId || '') } : null;
        },
      },
    },
    NSRunningApplication: {
      runningApplicationWithProcessIdentifier: (pid) => {
        const p = byPid(pid);
        if (!p) return { isNil: () => true };
        return {
          isNil: () => false,
          bundleIdentifier: wrap(p.bundleId || ''),
          bundleURL: { isNil: () => false, path: wrap(`/Applications/${p.name}.app`) },
          get unhide() {
            return true;
          },
          activateWithOptions: () => {
            front.pid = pid;
            return true;
          },
        };
      },
      runningApplicationsWithBundleIdentifier: (id) => ({ isNil: () => false, count: procs.filter((p) => p.bundleId === unwrap(id)).length }),
    },
    CGWindowListCopyWindowInfo: (option, rel) => {
      let list = opts.windowList || [];
      if (option === 8) list = list.filter((w) => w.kCGWindowNumber === rel);
      return { __deep: list };
    },
  });
  if (opts.layers) {
    $.NSEvent = {
      eventWithCGEvent: (e) => {
        events.push(['probe', e.code, e.flags]);
        return {
          isNil: () => false,
          charactersIgnoringModifiers: wrap(layer(0)[e.code] || ''),
          characters: wrap(layer(e.flags)[e.code] || ''),
        };
      },
    };
  }
  if (opts.tis) {
    $.TISCopyCurrentKeyboardInputSource = () => ({ __tis: opts.tis, isNil: () => false });
    $.TISCopyCurrentKeyboardLayoutInputSource = () => ({ __tis: opts.layoutTis || opts.tis, isNil: () => false });
    $.TISGetInputSourceProperty = (src, key) => {
      const props = {
        TISPropertyInputSourceID: src.__tis.id,
        TISPropertyInputSourceType: src.__tis.type,
        TISPropertyInputSourceIsASCIICapable: src.__tis.ascii,
      };
      const v = props[unwrap(key)];
      return v === undefined ? null : wrap(v);
    };
  }
  if (opts.defaults) {
    $.NSUserDefaults = {
      alloc: {
        initWithSuiteName: () => ({
          isNil: () => false,
          get synchronize() {
            return true;
          },
          stringForKey: (k) => (opts.defaults[k] == null ? null : wrap(opts.defaults[k])),
          arrayForKey: (k) => (opts.defaults[k] == null ? null : { __deep: opts.defaults[k], isNil: () => false }),
        }),
      },
    };
  }

  // ---- System Events
  /** A window element acting on process `p` (the one an Apple event actually reaches). */
  function windowElement(p, i) {
    const target = () => {
      const w = p.windows[i];
      if (!w) throw Object.assign(new Error(`Can't get window ${i + 1}.`), { errorNumber: -1719 });
      return w;
    };
    const closeButton = (owner) => ({ actions: { byName: (n) => ({ perform: () => events.push(['perform', owner.pid, owner.windows[i].name, `close.${n}`]) }) } });
    return {
      name: () => target().name,
      position: () => [target().x, target().y],
      size: () => [target().w, target().h],
      attributes: {
        byName: (attr) => ({
          get value() {
            // The reference System Events returns names the process by name.
            if (attr === 'AXCloseButton') return () => closeButton(byName(p.name));
            return () => Boolean(target()[attr]);
          },
          set value(v) {
            target()[attr] = v;
            events.push(['set', p.pid, target().name, attr, v]);
          },
        }),
      },
      actions: { byName: (n) => ({ perform: () => events.push(['perform', p.pid, target().name, n]) }) },
      buttons: {
        whose: (q) => (q.subrole === 'AXCloseButton' && target().closeButton !== 'attribute' ? [closeButton(p)] : []),
      },
    };
  }

  /** `processes.whose({unixId})[0]`: a specifier that keeps the unix-id test in every event. */
  function processSpecifier(p) {
    const windows = () => p.windows.map((w, i) => windowElement(byName(p.name), i)); // resolved: by name
    Object.defineProperty(windows, 'name', { value: () => p.windows.map((w) => w.name), configurable: true });
    windows.position = () => p.windows.map((w) => [w.x, w.y]);
    windows.size = () => p.windows.map((w) => [w.w, w.h]);
    p.windows.forEach((w, i) => {
      windows[i] = windowElement(p, i);
    });
    return {
      windows,
      name: () => p.name,
      set frontmost(v) {
        events.push(['frontmost', p.pid, v]);
      },
    };
  }

  const systemEvents = {
    keystroke: (t) => events.push(['keystroke', t]),
    processes: {
      whose: (q) => {
        if (q.unixId !== undefined) {
          const p = byPid(q.unixId);
          if (!p) throw Object.assign(new Error("Can't get process."), { errorNumber: -1728 });
          return [processSpecifier(p)];
        }
        return procs.filter((p) => p.name === q.name).map(processSpecifier);
      },
    },
  };

  const ObjC = { import: () => {}, unwrap, deepUnwrap: (o) => o.__deep, castRefToObject: (r) => r };
  const ctx = vm.createContext({ ObjC, $, Application: () => systemEvents });
  vm.runInContext(HELPER_SRC, ctx, { filename: 'darwin-helper.js' });
  const call = (cmd, args) => plain(ctx.dispatch({ id: 1, cmd, args }));
  return { ctx, call, events, pb, front };
}

const keys = (events) => events.filter((e) => e[0] === 'key').map((e) => e.slice(1));
const probes = (events) => events.filter((e) => e[0] === 'probe');
/** Key code and flags of the non-modifier key-down events. */
const mainDowns = (events) => keys(events).filter(([code, down]) => down && !(code >= 0x36 && code <= 0x3f)).map(([code, , flags]) => [code, flags]);
/** Modifier key codes pressed, in order. */
const modDowns = (events) => keys(events).filter(([code, down]) => down && code >= 0x36 && code <= 0x3f).map(([code]) => code);

function press(w, chars, keyCodes, flags, modifierKeyCodes) {
  const r = w.call('key', { keyCode: keyCodes[keyCodes.length - 1], keyCodes, chars, flags, modifierKeyCodes });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { main: mainDowns(w.events), mods: modDowns(w.events) };
}

/** The Cmd+V key code of a paste. */
function pasteKey(w) {
  const r = w.call('type', { steps: [{ kind: 'paste', text: 'héllo' }], checkInputSource: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  const downs = mainDowns(w.events);
  assert.equal(downs.length, 1);
  assert.equal(downs[0][1], CMD);
  return downs[0][0];
}

// ----------------------------------------------------------------- REGRESSIONS-6, MACOS-2-1

test('round 2: Command chords use the Command keymap, so "Dvorak - QWERTY ⌘" keeps US positions (REGRESSIONS-6, MACOS-2-1)', () => {
  // The layout's Command keymap is QWERTY and the probe sees it.
  const qwertyCmd = { 0: DVORAK, [CMD]: US, [CMD | SHIFT]: shifted(US) };
  assert.equal(pasteKey(world({ layers: qwertyCmd })), 0x09, 'paste is Cmd+V, not Cmd+. (interrupt)');
  assert.deepEqual(press(world({ layers: qwertyCmd }), ['q'], [0x0c], CMD, [0x37]).main, [[0x0c, CMD]], 'Cmd+Q, not Cmd+X');
  assert.deepEqual(press(world({ layers: qwertyCmd }), ['c'], [0x08], CMD, [0x37]).main, [[0x08, CMD]], 'Cmd+C, not Cmd+I');
  assert.deepEqual(press(world({ layers: qwertyCmd }), ['s'], [0x01], CMD, [0x37]).main, [[0x01, CMD]]);
  // Without Command the Dvorak keymap applies: a bare 'q' is the Dvorak Q key.
  assert.deepEqual(press(world({ layers: qwertyCmd }), ['q'], [0x0c], 0, []).main, [[0x07, 0]]);

  // The probe ignores Command, but TIS names the layout: the US position is kept.
  const named = () => world({ layers: { 0: DVORAK }, tis: LAYOUT_TIS('com.apple.keylayout.DVORAK-QWERTYCMD', true) });
  assert.equal(pasteKey(named()), 0x09);
  assert.deepEqual(press(named(), ['q'], [0x0c], CMD, [0x37]).main, [[0x0c, CMD]]);

  // Plain Dvorak (no separate Command keymap) still remaps.
  assert.equal(pasteKey(world({ layers: { 0: DVORAK } })), 0x2f);
  assert.deepEqual(press(world({ layers: { 0: DVORAK } }), ['q'], [0x0c], CMD, [0x37]).main, [[0x07, CMD]]);
});

test('round 2: non-Latin layouts keep the QWERTY key for Cmd shortcuts (MACOS-2-1)', () => {
  const hebrewCmd = { 0: HEBREW, [CMD]: US, [CMD | SHIFT]: shifted(US) };
  // The Command keymap is QWERTY: Cmd+/ must not become Cmd+Q (Hebrew '/' is on the Q key).
  assert.deepEqual(press(world({ layers: hebrewCmd }), ['/'], [0x2c], CMD, [0x37]).main, [[0x2c, CMD]]);
  // TIS says the layout is not ASCII-capable: the US position is kept even if the probe ignores Command.
  const hebrew = () => world({ layers: { 0: HEBREW }, tis: LAYOUT_TIS('com.apple.keylayout.Hebrew', false) });
  assert.deepEqual(press(hebrew(), ['/'], [0x2c], CMD, [0x37]).main, [[0x2c, CMD]]);
  const help = press(hebrew(), ['/'], [0x2c], CMD | SHIFT, [0x38, 0x37]);
  assert.deepEqual(help.main, [[0x2c, CMD | SHIFT]], 'Cmd+? is not Cmd+Shift+Q (Log Out)');
  assert.deepEqual(help.mods, [0x38, 0x37]);
  assert.equal(pasteKey(hebrew()), 0x09);
  // Without TIS, the HIToolbox preferences name the layout.
  const prefs = world({ layers: { 0: HEBREW }, defaults: { AppleCurrentKeyboardLayoutInputSourceID: 'com.apple.keylayout.Hebrew' } });
  assert.deepEqual(press(prefs, ['/'], [0x2c], CMD, [0x37]).main, [[0x2c, CMD]]);
  // Greek: Cmd+; is not Cmd+Q.
  const greek = world({ layers: { 0: GREEK }, tis: LAYOUT_TIS('com.apple.keylayout.Greek', false) });
  assert.deepEqual(press(greek, [';'], [0x29], CMD, [0x37]).main, [[0x29, CMD]]);
  // Without Command, a bare '/' is typed by the Hebrew '/' key.
  assert.deepEqual(press(hebrew(), ['/'], [0x2c], 0, []).main, [[0x0c, 0]]);
  // ASCII layouts still remap Command chords (AZERTY Cmd+A is the A key)...
  const azerty = world({ layers: AZERTY_LAYERS, tis: LAYOUT_TIS('com.apple.keylayout.French', true) });
  assert.deepEqual(press(azerty, ['a'], [0x00], CMD, [0x37]).main, [[0x0c, CMD]]);
  // ...even if `characters` were empty for Command probes: the plain layer answers, never Cmd+Q.
  const silent = world({ layers: { ...AZERTY_LAYERS, [CMD]: {} } });
  assert.deepEqual(press(silent, ['a'], [0x00], CMD, [0x37]).main, [[0x0c, CMD]]);
});

// ----------------------------------------------------------------- MACOS-2-2

test('round 2: characters typed with Shift or Option on the layout get those modifiers (MACOS-2-2)', () => {
  const de = () => world({ layers: GERMAN_LAYERS });
  // '/' is Shift+7 on German.
  assert.deepEqual(press(de(), ['/'], [0x2c], 0, []), { main: [[0x1a, SHIFT]], mods: [0x38] });
  // '?' arrives as '/' plus Shift; it is Shift+ß.
  assert.deepEqual(press(de(), ['/'], [0x2c], SHIFT, [0x38]), { main: [[0x1b, SHIFT]], mods: [0x38] });
  // '+' is an unshifted key: Shift is dropped, whether keys.js sends '=' plus Shift or '+' itself.
  assert.deepEqual(press(de(), ['='], [0x18], SHIFT, [0x38]), { main: [[0x1e, 0]], mods: [] });
  assert.deepEqual(press(de(), ['+'], [0x18], SHIFT, [0x38]), { main: [[0x1e, 0]], mods: [] });
  // Cmd and the real '+' character: Cmd and the unshifted '+' key (zoom in).
  assert.deepEqual(press(de(), ['+'], [0x18], CMD | SHIFT, [0x38, 0x37]), { main: [[0x1e, CMD]], mods: [0x37] });
  // '@' is Option+L, '\' is Option+Shift+7.
  assert.deepEqual(press(de(), ['2'], [0x13], SHIFT, [0x38]), { main: [[0x25, ALT]], mods: [0x3a] });
  assert.deepEqual(press(de(), ['\\'], [0x2a], 0, []), { main: [[0x1a, ALT | SHIFT]], mods: [0x3a, 0x38] });
  // Cmd+/ is Cmd+Shift+7 (how German users toggle comments in VS Code).
  assert.deepEqual(press(de(), ['/'], [0x2c], CMD, [0x37]), { main: [[0x1a, CMD | SHIFT]], mods: [0x38, 0x37] });
  // Digits keep their number-row key in Cmd and Ctrl chords (system screenshot hotkey, browser tabs).
  assert.deepEqual(press(de(), ['3'], [0x14], CMD | SHIFT, [0x38, 0x37]), { main: [[0x14, CMD | SHIFT]], mods: [0x38, 0x37] });
  // A chord with several keys keeps its modifiers.
  const multi = press(de(), ['/', 'a'], [0x2c, 0x00], 0, []);
  assert.deepEqual(multi, { main: [[0x2c, 0], [0x00, 0]], mods: [] });

  const fr = () => world({ layers: AZERTY_LAYERS });
  // A bare '1' (choose option 1 in a CLI menu) is Shift+& on AZERTY; '/' is Shift+:.
  assert.deepEqual(press(fr(), ['1'], [0x12], 0, []), { main: [[0x12, SHIFT]], mods: [0x38] });
  assert.deepEqual(press(fr(), ['/'], [0x2c], 0, []), { main: [[0x2f, SHIFT]], mods: [0x38] });
  // Ctrl+1 and Cmd+1 stay on the number-row key without Shift.
  assert.deepEqual(press(fr(), ['1'], [0x12], CTRL, [0x3b]), { main: [[0x12, CTRL]], mods: [0x3b] });
  assert.deepEqual(press(fr(), ['1'], [0x12], CMD, [0x37]), { main: [[0x12, CMD]], mods: [0x37] });

  // US: '?' needs two probes and no map.
  const us = world({ layers: { 0: US, [SHIFT]: shifted(US) } });
  assert.deepEqual(press(us, ['/'], [0x2c], SHIFT, [0x38]), { main: [[0x2c, SHIFT]], mods: [0x38] });
  assert.equal(probes(us.events).length, 2);
  const plus = world({ layers: { 0: US, [SHIFT]: shifted(US) } });
  assert.deepEqual(press(plus, ['='], [0x18], SHIFT, [0x38]), { main: [[0x18, SHIFT]], mods: [0x38] });
});

// ----------------------------------------------------------------- MACOS-2-3

test('round 2: key lookups and the paste key pump the run loop before probing the layout (MACOS-2-3)', () => {
  const firstIndex = (events, kind) => events.findIndex((e) => e[0] === kind);
  const k = world({ layers: AZERTY_LAYERS });
  press(k, ['a'], [0x00], CMD, [0x37]);
  assert.ok(firstIndex(k.events, 'pump') >= 0 && firstIndex(k.events, 'pump') < firstIndex(k.events, 'probe'));
  const p = world({ layers: { 0: DVORAK } });
  pasteKey(p);
  assert.ok(firstIndex(p.events, 'pump') >= 0 && firstIndex(p.events, 'pump') < firstIndex(p.events, 'probe'));
  // Position-independent keys need neither.
  const ret = world({ layers: AZERTY_LAYERS });
  press(ret, [null], [0x24], 0, []);
  assert.equal(firstIndex(ret.events, 'probe'), -1);
});

// ----------------------------------------------------------------- MACOS-2-6

test('round 2: pastes give the app time to read the pasteboard before anything changes it (MACOS-2-6)', () => {
  const w = world({ clipboard: 'secret' });
  const r = w.call('type', { steps: [{ kind: 'paste', text: 'git status' }, { kind: 'key', keyCode: 36 }, { kind: 'paste', text: 'ls' }] });
  assert.equal(r.ok, true);
  const ev = w.events;
  const vDown = (from) => ev.findIndex((e, i) => i >= from && e[0] === 'key' && e[1] === 0x09 && e[2] === true);
  const slept = (from, to) => ev.slice(from, to).filter((e) => e[0] === 'sleep').reduce((a, e) => a + e[1], 0);
  const firstPaste = vDown(0);
  const ret = ev.findIndex((e) => e[0] === 'key' && e[1] === 36 && e[2] === true);
  const secondClip = ev.findIndex((e) => e[0] === 'clip' && e[1] === 'ls');
  const restore = ev.findIndex((e) => e[0] === 'restore');
  assert.ok(firstPaste >= 0 && firstPaste < ret && ret < secondClip && secondClip < restore);
  assert.ok(slept(firstPaste, ret) >= 0.35, `Return waits for the paste (${slept(firstPaste, ret)} s)`);
  assert.ok(slept(firstPaste, secondClip) >= 0.35, 'the next text goes on the pasteboard only after the settle');
  assert.ok(slept(vDown(firstPaste + 1), restore) >= 0.95, 'the clipboard is restored 1 s after the last paste');
  assert.equal(w.pb.text, 'secret');
});

// ----------------------------------------------------------------- MACOS-2-7

test('round 2: layouts that may have dead keys get quotes, backticks, carets and tildes pasted (MACOS-2-7)', () => {
  const { ctx } = world();
  const d = (raw) => plain(ctx.describeInputSource(raw));
  assert.equal(d(LAYOUT_TIS('com.apple.keylayout.USInternational-PC', true)).deadChars, '\'"`^~');
  assert.equal(d(LAYOUT_TIS('com.apple.keylayout.German', true)).deadChars, '\'"`^~');
  assert.equal(d({ id: 'com.apple.keylayout.French', source: 'defaults' }).deadChars, '\'"`^~');
  for (const id of ['US', 'ABC', 'British', 'Dvorak', 'DVORAK-QWERTYCMD', 'Colemak']) {
    assert.equal(d(LAYOUT_TIS(`com.apple.keylayout.${id}`, true)).deadChars, '', id);
  }
  assert.equal(d({ id: 'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese', type: 'TISTypeKeyboardInputMode', ascii: false }).deadChars, '');
  assert.equal(d({}).deadChars, '');

  const intl = () => world({ tis: LAYOUT_TIS('com.apple.keylayout.USInternational-PC', true), clipboard: 'old' });
  let w = intl();
  let r = w.call('type', { steps: [{ kind: 'keys', text: 'git commit -m "add tests"' }], fallbackPaste: true });
  assert.deepEqual([r.result.fallback, r.result.reason, r.result.keystrokes, r.result.pasted], ['paste', 'dead-keys', 0, 1]);
  assert.deepEqual(w.events.filter((e) => e[0] === 'clip').map((e) => e[1]), ['git commit -m "add tests"']);
  assert.deepEqual(w.events.filter((e) => e[0] === 'keystroke'), []);
  // Only the steps with such a character are pasted; Return stays a key press.
  w = intl();
  r = w.call('type', {
    steps: [{ kind: 'keys', text: 'echo ' }, { kind: 'keys', text: '"hi"' }, { kind: 'paste', text: ' ✓' }, { kind: 'key', keyCode: 36 }, { kind: 'keys', text: 'ls' }],
  });
  assert.deepEqual([r.result.reason, r.result.keystrokes, r.result.pasted], ['dead-keys', 2, 1]);
  assert.deepEqual(w.events.filter((e) => e[0] === 'keystroke').map((e) => e[1]), ['echo ', 'ls']);
  assert.deepEqual(w.events.filter((e) => e[0] === 'clip').map((e) => e[1]), ['"hi" ✓']);
  // German from the preferences: a backtick is pasted.
  w = world({ defaults: { AppleCurrentKeyboardLayoutInputSourceID: 'com.apple.keylayout.German' } });
  r = w.call('type', { steps: [{ kind: 'keys', text: '`a`' }] });
  assert.equal(r.result.reason, 'dead-keys');
  // US keeps keystrokes, and so does a step without those characters, or a disabled check.
  w = world({ tis: LAYOUT_TIS('com.apple.keylayout.US', true) });
  r = w.call('type', { steps: [{ kind: 'keys', text: 'say "hi"' }] });
  assert.deepEqual([r.result.reason, r.result.keystrokes], [null, 1]);
  w = intl();
  r = w.call('type', { steps: [{ kind: 'keys', text: 'ls -la' }] });
  assert.deepEqual([r.result.reason, r.result.keystrokes], [null, 1]);
  w = intl();
  r = w.call('type', { steps: [{ kind: 'keys', text: '"x"' }], checkInputSource: false });
  assert.deepEqual([r.result.reason, r.result.keystrokes], [null, 1]);
});

// ----------------------------------------------------------------- MACOS-2-5

const DIALOG = { pid: 900, name: 'Google Chrome', bundleId: 'com.google.Chrome', windows: [{ name: 'Claude Anywhere', x: 0, y: 0, w: 400, h: 600 }] };
const USER = {
  pid: 777,
  name: 'Google Chrome',
  bundleId: 'com.google.Chrome',
  windows: [
    { name: 'Other', x: 500, y: 500, w: 300, h: 200 },
    { name: 'GCP – Chrome', x: 10, y: 10, w: 800, h: 600 },
  ],
};
const CG = [
  { kCGWindowNumber: 70, kCGWindowOwnerPID: 900, kCGWindowOwnerName: 'Google Chrome', kCGWindowName: 'Claude Anywhere', kCGWindowLayer: 0, kCGWindowBounds: { X: 0, Y: 0, Width: 400, Height: 600 } },
  { kCGWindowNumber: 55, kCGWindowOwnerPID: 777, kCGWindowOwnerName: 'Google Chrome', kCGWindowName: 'GCP – Chrome', kCGWindowLayer: 0, kCGWindowBounds: { X: 10, Y: 10, Width: 800, Height: 600 } },
];
const twoChromes = (patch = {}) =>
  world({ processes: [{ ...DIALOG, ...patch.dialog }, { ...USER, windows: USER.windows.map((w) => ({ ...w })), ...patch.user }], windowList: CG });

test('round 2: window actions reach the right instance when two processes share a name (MACOS-2-5)', () => {
  // The fake resolves `proc.windows()` references by process name, like System Events, so the
  // old lookup read the dialog instance's windows when asked about the user's Chrome.
  let w = twoChromes();
  let r = w.call('focus', { pid: 777, number: 55 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.raised, true);
  const performs = w.events.filter((e) => e[0] === 'perform');
  assert.deepEqual(performs, [['perform', 777, 'GCP – Chrome', 'AXRaise']]);

  w = twoChromes();
  assert.deepEqual(w.call('minimize', { pid: 777, number: 55 }).result, { ok: true });
  assert.deepEqual(w.events.filter((e) => e[0] === 'set'), [['set', 777, 'GCP – Chrome', 'AXMinimized', true]]);

  w = twoChromes();
  assert.deepEqual(w.call('close', { pid: 777, number: 55 }).result, { ok: true });
  assert.deepEqual(w.events.filter((e) => e[0] === 'perform'), [['perform', 777, 'GCP – Chrome', 'close.AXPress']]);

  // The dialog instance (first by name) is closed through its own specifier too.
  w = twoChromes();
  assert.deepEqual(w.call('close', { pid: 900, number: 70 }).result, { ok: true });
  assert.deepEqual(w.events.filter((e) => e[0] === 'perform'), [['perform', 900, 'Claude Anywhere', 'close.AXPress']]);

  // A close button reachable only through the AXCloseButton attribute (whose reference names the
  // process by name) is not followed while another process has that name...
  w = twoChromes({ user: { windows: [{ ...USER.windows[0] }, { ...USER.windows[1], closeButton: 'attribute' }] } });
  r = w.call('close', { pid: 777, number: 55 }).result;
  assert.equal(r.ok, false);
  assert.match(r.reason, /no close button/);
  assert.deepEqual(w.events.filter((e) => e[0] === 'perform'), [], 'the dialog window was not closed instead');
  // ...but is when the name is unique.
  w = world({ processes: [{ ...USER, windows: [{ ...USER.windows[0] }, { ...USER.windows[1], closeButton: 'attribute' }] }], windowList: CG });
  assert.deepEqual(w.call('close', { pid: 777, number: 55 }).result, { ok: true });
  assert.deepEqual(w.events.filter((e) => e[0] === 'perform'), [['perform', 777, 'GCP – Chrome', 'close.AXPress']]);

  // No matching window: nothing is raised.
  w = twoChromes({ user: { windows: [{ ...USER.windows[0] }] } });
  r = w.call('focus', { pid: 777, number: 55 }).result;
  assert.equal(r.raised, false);
  assert.deepEqual(w.events.filter((e) => e[0] === 'perform'), []);
});

// ----------------------------------------------------------------- with the real keys.js

test('round 2: keys.js combos land on the right keys of each layout', () => {
  const { toMacKeyCodes } = require('../src/os/keys');
  const combo = (w, names) => {
    const k = toMacKeyCodes(names);
    const r = w.call('key', { keyCode: k.keyCode, keyCodes: k.keyCodes, chars: k.chars, flags: k.flags, modifierKeyCodes: k.modifierKeyCodes });
    assert.equal(r.ok, true, JSON.stringify(r));
    return mainDowns(w.events);
  };
  const hebrew = () => world({ layers: { 0: HEBREW }, tis: LAYOUT_TIS('com.apple.keylayout.Hebrew', false) });
  assert.deepEqual(combo(hebrew(), ['meta', '/']), [[0x2c, CMD]], 'toggle comment, not Cmd+Q');
  assert.deepEqual(combo(hebrew(), ['meta', '?']), [[0x2c, CMD | SHIFT]], 'Help, not Log Out');
  const greek = world({ layers: { 0: GREEK }, tis: LAYOUT_TIS('com.apple.keylayout.Greek', false) });
  assert.deepEqual(combo(greek, ['meta', ';']), [[0x29, CMD]]);
  const qwertyCmd = () => world({ layers: { 0: DVORAK }, tis: LAYOUT_TIS('com.apple.keylayout.DVORAK-QWERTYCMD', true) });
  assert.deepEqual(combo(qwertyCmd(), ['meta', 'v']), [[0x09, CMD]]);
  assert.deepEqual(combo(qwertyCmd(), ['meta', 'q']), [[0x0c, CMD]]);
  const de = () => world({ layers: GERMAN_LAYERS, tis: LAYOUT_TIS('com.apple.keylayout.German', true) });
  assert.deepEqual(combo(de(), ['/']), [[0x1a, SHIFT]]);
  assert.deepEqual(combo(de(), ['?']), [[0x1b, SHIFT]]);
  assert.deepEqual(combo(de(), ['+']), [[0x1e, 0]]);
  assert.deepEqual(combo(de(), ['@']), [[0x25, ALT]]);
  assert.deepEqual(combo(de(), ['meta', 'shift', '3']), [[0x14, CMD | SHIFT]]);
  assert.deepEqual(combo(de(), ['meta', 'z']), [[0x10, CMD]]);
  // Cmd++ (zoom in) is Cmd and the German "+" key, not Cmd+Shift+0 (Cmd+=).
  assert.deepEqual(combo(de(), ['meta', '+']), [[0x1e, CMD]]);
  const fr = () => world({ layers: AZERTY_LAYERS, tis: LAYOUT_TIS('com.apple.keylayout.French', true) });
  assert.deepEqual(combo(fr(), ['1']), [[0x12, SHIFT]]);
  assert.deepEqual(combo(fr(), ['meta', 'a']), [[0x0c, CMD]]);
  assert.deepEqual(combo(fr(), ['ctrl', '1']), [[0x12, CTRL]]);
  assert.deepEqual(combo(fr(), ['enter']), [[0x24, 0]]);
});
