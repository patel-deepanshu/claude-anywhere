'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const keys = require('../src/os/keys');

const n = (combo, platform = 'linux') => keys.normalizeCombo(combo, { platform });

test('normalizeCombo: separators, case, ordering and dedupe', () => {
  assert.deepEqual(n('Ctrl+Shift+T'), ['ctrl', 'shift', 't']);
  assert.deepEqual(n('shift+ctrl+t'), ['ctrl', 'shift', 't']);
  assert.deepEqual(n('ctrl-shift-t'), ['ctrl', 'shift', 't']);
  assert.deepEqual(n('CTRL + ALT + DELETE'), ['ctrl', 'alt', 'delete']);
  assert.deepEqual(n('ctrl shift t'), ['ctrl', 'shift', 't']);
  assert.deepEqual(n(['Ctrl', 'C']), ['ctrl', 'c']);
  assert.deepEqual(n('ctrl+ctrl+a'), ['ctrl', 'a']);
  assert.deepEqual(n('Enter'), ['enter']);
  assert.deepEqual(n('A'), ['a']);
});

test('normalizeCombo: separator characters as keys', () => {
  assert.deepEqual(n('ctrl++'), ['ctrl', '+']);
  assert.deepEqual(n('ctrl--'), ['ctrl', '-']);
  assert.deepEqual(n('ctrl+-'), ['ctrl', '-']);
  assert.deepEqual(n('-'), ['-']);
  assert.deepEqual(n('+'), ['+']);
  assert.deepEqual(n('ctrl+plus'), ['ctrl', '+']);
  assert.deepEqual(n('ctrl+minus'), ['ctrl', '-']);
  assert.deepEqual(n(' '), ['space']);
});

test('normalizeCombo: aliases', () => {
  assert.deepEqual(n('control+option+command+a'), ['ctrl', 'alt', 'meta', 'a']);
  assert.deepEqual(n('Cmd+Space'), ['meta', 'space']);
  for (const m of ['cmd', 'command', 'super', 'win', 'windows', 'os', 'meta', '⌘']) assert.deepEqual(n(`${m}+x`), ['meta', 'x'], m);
  assert.deepEqual(n('opt+⇧+→'), ['alt', 'shift', 'right']);
  assert.deepEqual(n('return'), ['enter']);
  assert.deepEqual(n('Esc'), ['escape']);
  assert.deepEqual(n('PgUp'), ['pageup']);
  assert.deepEqual(n('Page Up'), ['pageup']);
  assert.deepEqual(n('page-down'), ['pagedown']);
  assert.deepEqual(n('Page_Down'), ['pagedown']);
  assert.deepEqual(n('ArrowLeft'), ['left']);
  assert.deepEqual(n('del'), ['delete']);
  assert.deepEqual(n('ins'), ['insert']);
  assert.deepEqual(n('bksp'), ['backspace']);
  assert.deepEqual(n('print screen'), ['printscreen']);
  assert.deepEqual(n('PrtSc'), ['printscreen']);
  assert.deepEqual(n('apps'), ['menu']);
  assert.deepEqual(n('caps'), ['capslock']);
  assert.deepEqual(n('F12'), ['f12']);
  assert.deepEqual(n('f24'), ['f24']);
  assert.deepEqual(n('shift+slash'), ['shift', '/']);
  assert.deepEqual(n('backtick'), ['`']);
  assert.deepEqual(n('bracketleft'), ['[']);
  assert.deepEqual(n('question'), ['?']);
});

test("normalizeCombo: 'primary'/'mod' depend on the platform", () => {
  assert.deepEqual(n('primary+s', 'darwin'), ['meta', 's']);
  assert.deepEqual(n('primary+s', 'win32'), ['ctrl', 's']);
  assert.deepEqual(n('mod+shift+p', 'linux'), ['ctrl', 'shift', 'p']);
  assert.deepEqual(n('CommandOrControl+Q', 'darwin'), ['meta', 'q']);
});

test('normalizeCombo: clear errors that list valid names', () => {
  for (const bad of ['ctrl+foo', 'hyperdrive', 'ctrl+', '+a', '', 'ctrl+é']) {
    assert.throws(
      () => n(bad),
      (err) => err.code === 'INVALID_KEY' && /Valid keys|empty|Empty/.test(err.message + err.hint),
      bad
    );
  }
  try {
    n('ctrl+foo');
  } catch (err) {
    assert.match(err.message, /Unknown key "foo"/);
    assert.match(err.message, /pageup/);
    assert.match(err.message, /f1-f24/);
  }
  assert.throws(() => keys.normalizeCombo(42), /string or an array/);
});

test('toXdotool keysyms', () => {
  assert.equal(keys.toXdotool(['ctrl', 'shift', 't']), 'ctrl+shift+t');
  assert.equal(keys.toXdotool(['meta']), 'super');
  assert.equal(keys.toXdotool('alt+f4'), 'alt+F4');
  const expect = {
    enter: 'Return', escape: 'Escape', pageup: 'Prior', pagedown: 'Next', backspace: 'BackSpace', delete: 'Delete',
    insert: 'Insert', home: 'Home', end: 'End', up: 'Up', down: 'Down', left: 'Left', right: 'Right', space: 'space',
    tab: 'Tab', capslock: 'Caps_Lock', printscreen: 'Print', menu: 'Menu', f1: 'F1', f24: 'F24',
    '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash', ';': 'semicolon',
    "'": 'apostrophe', ',': 'comma', '.': 'period', '/': 'slash', '`': 'grave', '?': 'question', '+': 'plus',
    volumeup: 'XF86AudioRaiseVolume',
  };
  for (const [k, v] of Object.entries(expect)) assert.equal(keys.toXdotool([k]), v, k);
  // Every canonical key has an X keysym.
  for (const k of keys.KEY_NAMES) assert.ok(keys.toXdotool([k]), k);
});

test('toMacKeyCodes: kVK codes and CGEventFlags', () => {
  assert.deepEqual(keys.toMacKeyCodes(['meta', 'c']), { keyCode: 0x08, keyCodes: [0x08], chars: ['c'], flags: 0x100000, modifierKeyCodes: [0x37] });
  const r = keys.toMacKeyCodes(['ctrl', 'alt', 'shift', 'meta', 'a']);
  assert.equal(r.flags, 0x40000 | 0x80000 | 0x20000 | 0x100000);
  assert.deepEqual(r.modifierKeyCodes, [0x3b, 0x3a, 0x38, 0x37]);
  const codes = { a: 0x00, z: 0x06, q: 0x0c, 1: 0x12, 0: 0x1d, enter: 0x24, tab: 0x30, space: 0x31, backspace: 0x33, escape: 0x35, delete: 0x75, home: 0x73, end: 0x77, pageup: 0x74, pagedown: 0x79, left: 0x7b, right: 0x7c, down: 0x7d, up: 0x7e, f1: 0x7a, f12: 0x6f, '-': 0x1b, '=': 0x18, '[': 0x21, ']': 0x1e, '\\': 0x2a, ';': 0x29, "'": 0x27, ',': 0x2b, '.': 0x2f, '/': 0x2c, '`': 0x32 };
  for (const [k, v] of Object.entries(codes)) assert.equal(keys.toMacKeyCodes([k]).keyCode, v, k);
  // Shifted punctuation adds Shift.
  const q = keys.toMacKeyCodes(['?']);
  assert.equal(q.keyCode, 0x2c);
  assert.equal(q.flags, 0x20000);
  assert.deepEqual(q.modifierKeyCodes, [0x38]);
  // Modifier-only combo.
  assert.deepEqual(keys.toMacKeyCodes(['meta']), { keyCode: 0x37, keyCodes: [0x37], chars: [null], flags: 0x100000, modifierKeyCodes: [] });
  assert.throws(() => keys.toMacKeyCodes(['printscreen']), (e) => e.code === 'UNSUPPORTED' && /cmd\+shift\+3/.test(e.hint));
  assert.throws(() => keys.toMacKeyCodes(['f21']), (e) => e.code === 'UNSUPPORTED');
  assert.equal(keys.toMacKeyCodes('primary+s').flags, 0x100000);
});

test('toMacKeyCodes: layout-dependent keys carry the character to resolve against the current layout', () => {
  // kVK_ANSI_* codes are US-QWERTY positions: on AZERTY kVK_ANSI_A is the "q" key, so cmd+a must be
  // resolved by character, never sent as a raw position.
  assert.deepEqual(keys.toMacKeyCodes(['meta', 'a']).chars, ['a']);
  assert.deepEqual(keys.toMacKeyCodes(['meta', 'z']).chars, ['z']);
  assert.deepEqual(keys.toMacKeyCodes(['meta', ',']).chars, [',']);
  assert.deepEqual(keys.toMacKeyCodes(['meta', '1']).chars, ['1']);
  // Shifted punctuation carries the real target character ('?' is not on the "/" key on every
  // layout; Cmd++ on German is the unshifted "+" key). The US key code and Shift stay as the fallback.
  const q = keys.toMacKeyCodes(['meta', '?']);
  assert.deepEqual([q.chars, q.keyCodes, q.flags], [['?'], [0x2c], 0x100000 | 0x20000]);
  const plus = keys.toMacKeyCodes(['meta', '+']);
  assert.deepEqual([plus.chars, plus.keyCodes, plus.flags], [['+'], [0x18], 0x100000 | 0x20000]);
  // Position-independent keys keep their fixed codes.
  for (const k of ['enter', 'tab', 'space', 'escape', 'backspace', 'delete', 'left', 'up', 'home', 'pageup', 'f5']) {
    assert.deepEqual(keys.toMacKeyCodes([k]).chars, [null], k);
  }
  // chars is aligned with keyCodes.
  const multi = keys.toMacKeyCodes(['meta', 'k', 'enter', 'v']);
  assert.deepEqual(multi.keyCodes, [0x28, 0x24, 0x09]);
  assert.deepEqual(multi.chars, ['k', null, 'v']);
  for (const k of keys.KEY_NAMES) {
    let r;
    try {
      r = keys.toMacKeyCodes([k]);
    } catch (e) {
      assert.equal(e.code, 'UNSUPPORTED', k);
      continue;
    }
    assert.equal(r.chars.length, r.keyCodes.length, k);
  }
});

test('toMacKeyCodes: volume keys are refused with an osascript hint (macOS ignores them as key events)', () => {
  for (const k of ['volumeup', 'volumedown', 'volumemute']) {
    assert.throws(() => keys.toMacKeyCodes([k]), (e) => e.code === 'UNSUPPORTED' && /osascript -e 'set volume/.test(e.hint), k);
  }
  assert.throws(() => keys.toMacKeyCodes(['volumeup']), (e) => /\+ 10/.test(e.hint));
  assert.throws(() => keys.toMacKeyCodes(['volumedown']), (e) => /- 10/.test(e.hint));
  assert.throws(() => keys.toMacKeyCodes(['volumemute']), (e) => /output muted/.test(e.hint));
  // Other backends still send them.
  assert.equal(keys.toXdotool(['volumeup']), 'XF86AudioRaiseVolume');
  assert.deepEqual(keys.toWindowsVk(['volumeup']), [0xaf]);
});

test('toWindowsVk: VK codes, modifiers first', () => {
  assert.deepEqual(keys.toWindowsVk(['ctrl', 'shift', 't']), [0x11, 0x10, 0x54]);
  assert.deepEqual(keys.toWindowsVk(['meta', 'd']), [0x5b, 0x44]);
  assert.deepEqual(keys.toWindowsVk(['alt', 'f4']), [0x12, 0x73]);
  const codes = { a: 0x41, z: 0x5a, 0: 0x30, 9: 0x39, enter: 0x0d, escape: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08, delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28, f1: 0x70, f12: 0x7b, f24: 0x87, capslock: 0x14, printscreen: 0x2c, menu: 0x5d, ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde };
  for (const [k, v] of Object.entries(codes)) assert.deepEqual(keys.toWindowsVk([k]), [v], k);
  assert.deepEqual(keys.toWindowsVk(['ctrl', '!']), [0x11, 0x10, 0x31]);
  for (const vk of [0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x2d, 0x2e, 0x21, 0x22, 0x6f, 0x90, 0x5c, 0x5b]) assert.equal(keys.isExtendedVk(vk), true, vk.toString(16));
  for (const vk of [0x41, 0x0d, 0x11, 0x10, 0x70]) assert.equal(keys.isExtendedVk(vk), false, vk.toString(16));
});

test('toEvdev: Linux input codes for ydotool', () => {
  assert.deepEqual(keys.toEvdev(['ctrl', 'alt', 'shift', 'meta']), [29, 56, 42, 125]);
  assert.deepEqual(keys.toEvdev(['ctrl', 'c']), [29, 46]);
  const codes = { escape: 1, 1: 2, 0: 11, enter: 28, a: 30, z: 44, space: 57, f1: 59, f10: 68, f11: 87, f12: 88, f13: 183, f24: 194, home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109, insert: 110, delete: 111, backspace: 14, tab: 15, '-': 12, '=': 13, '[': 26, ']': 27, ';': 39, "'": 40, '`': 41, '\\': 43, ',': 51, '.': 52, '/': 53 };
  for (const [k, v] of Object.entries(codes)) assert.deepEqual(keys.toEvdev([k]), [v], k);
  assert.deepEqual(keys.toEvdev(['@']), [42, 3]);
  for (const k of keys.KEY_NAMES) {
    for (const code of keys.toEvdev([k])) assert.ok(Number.isInteger(code) && code > 0, k);
    for (const vk of keys.toWindowsVk([k])) assert.ok(Number.isInteger(vk) && vk > 0, k);
  }
});
