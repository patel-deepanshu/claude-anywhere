'use strict';

/**
 * Key-name normalization and per-backend key tables.
 *
 * A normalized combo is an array of canonical names: modifiers first in the
 * order ctrl, alt, shift, meta, then the other keys in the order given.
 * Canonical key names are lowercase: modifiers, named keys (enter, pageup,
 * f5, ...) and single printable ASCII characters ('a', '7', '-', '?').
 * Tables assume a US layout for punctuation.
 */

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'];

const FKEYS = Array.from({ length: 24 }, (_, i) => `f${i + 1}`);

const NAMED = [
  'enter', 'escape', 'tab', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'capslock', 'printscreen', 'menu', 'numlock', 'scrolllock', 'pause',
  'volumeup', 'volumedown', 'volumemute', 'playpause', 'nexttrack', 'prevtrack',
  ...FKEYS,
];

const LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const UNSHIFTED_PUNCT = ['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`'];
// Shifted character → the US-layout key that produces it with Shift.
const SHIFTED = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
};
const CHARS = [...LOWER, ...DIGITS, ...UNSHIFTED_PUNCT, ...Object.keys(SHIFTED)];

const KEY_NAMES = Object.freeze([...MODIFIERS, ...NAMED, ...CHARS]);
const KEY_SET = new Set(KEY_NAMES);

// Aliases are matched after lower-casing and removing spaces/underscores.
const ALIASES = {
  control: 'ctrl', ctl: 'ctrl', '⌃': 'ctrl', lctrl: 'ctrl', rctrl: 'ctrl', leftctrl: 'ctrl', rightctrl: 'ctrl',
  option: 'alt', opt: 'alt', '⌥': 'alt', altgr: 'alt', lalt: 'alt', ralt: 'alt', leftalt: 'alt', rightalt: 'alt',
  '⇧': 'shift', lshift: 'shift', rshift: 'shift', leftshift: 'shift', rightshift: 'shift',
  cmd: 'meta', command: 'meta', '⌘': 'meta', super: 'meta', win: 'meta', windows: 'meta', os: 'meta',
  logo: 'meta', lwin: 'meta', rwin: 'meta', lcmd: 'meta', rcmd: 'meta',
  return: 'enter', ret: 'enter', '⏎': 'enter', '↵': 'enter', kpenter: 'enter',
  esc: 'escape', '⎋': 'escape',
  '⇥': 'tab',
  spacebar: 'space', ' ': 'space', '␣': 'space',
  bksp: 'backspace', bspace: 'backspace', '⌫': 'backspace',
  del: 'delete', forwarddelete: 'delete', fwddelete: 'delete', '⌦': 'delete',
  ins: 'insert', help: 'insert',
  pgup: 'pageup', prior: 'pageup', pageu: 'pageup',
  pgdn: 'pagedown', pgdown: 'pagedown', next: 'pagedown',
  arrowup: 'up', uparrow: 'up', '↑': 'up',
  arrowdown: 'down', downarrow: 'down', '↓': 'down',
  arrowleft: 'left', leftarrow: 'left', '←': 'left',
  arrowright: 'right', rightarrow: 'right', '→': 'right',
  caps: 'capslock', '⇪': 'capslock',
  prtsc: 'printscreen', prtscr: 'printscreen', prntscrn: 'printscreen', print: 'printscreen',
  printscr: 'printscreen', snapshot: 'printscreen', sysrq: 'printscreen',
  apps: 'menu', contextmenu: 'menu', application: 'menu',
  numlk: 'numlock', scrlk: 'scrolllock', break: 'pause',
  volup: 'volumeup', audioraisevolume: 'volumeup', volumedn: 'volumedown', voldown: 'volumedown',
  audiolowervolume: 'volumedown', mute: 'volumemute', audiomute: 'volumemute',
  play: 'playpause', mediaplaypause: 'playpause', audioplay: 'playpause',
  medianext: 'nexttrack', medianexttrack: 'nexttrack', audionext: 'nexttrack',
  mediaprev: 'prevtrack', mediaprevioustrack: 'prevtrack', previoustrack: 'prevtrack', audioprev: 'prevtrack',
  minus: '-', hyphen: '-', dash: '-', equal: '=', equals: '=', plus: '+',
  comma: ',', period: '.', dot: '.', fullstop: '.', slash: '/', forwardslash: '/', backslash: '\\',
  semicolon: ';', colon: ':', quote: "'", apostrophe: "'", singlequote: "'",
  doublequote: '"', quotedbl: '"', dquote: '"',
  backquote: '`', backtick: '`', grave: '`', graveaccent: '`', tilde: '~', asciitilde: '~',
  bracketleft: '[', leftbracket: '[', openbracket: '[', lbracket: '[',
  bracketright: ']', rightbracket: ']', closebracket: ']', rbracket: ']',
  braceleft: '{', leftbrace: '{', lbrace: '{', braceright: '}', rightbrace: '}', rbrace: '}',
  parenleft: '(', leftparen: '(', lparen: '(', parenright: ')', rightparen: ')', rparen: ')',
  less: '<', lessthan: '<', greater: '>', greaterthan: '>', question: '?', questionmark: '?',
  exclam: '!', exclamation: '!', bang: '!', at: '@', hash: '#', numbersign: '#', pound: '#',
  dollar: '$', percent: '%', caret: '^', asciicircum: '^', ampersand: '&', asterisk: '*', star: '*',
  underscore: '_', bar: '|', pipe: '|',
};
const PRIMARY_ALIASES = new Set(['primary', 'mod', 'cmdorctrl', 'commandorcontrol', 'cmdctrl', 'ctrlorcmd']);

function validNamesHint() {
  return (
    'Valid keys: modifiers ctrl, alt, shift, meta (aliases cmd, command, win, super, option, control, ' +
    "and 'primary'/'mod' = cmd on macOS, ctrl elsewhere); named keys " +
    NAMED.filter((n) => !/^f\d+$/.test(n)).join(', ') +
    ', f1-f24; single characters a-z, 0-9 and punctuation such as - = [ ] \\ ; \' , . / `. ' +
    'Use type_text for literal text.'
  );
}

function keyError(message, code = 'INVALID_KEY') {
  const err = new Error(message);
  err.code = code;
  err.hint = validNamesHint();
  return err;
}

/** Map one token (any case/alias) to its canonical name, or null. */
function canonical(token, platform) {
  if (token == null) return null;
  const raw = String(token);
  if (raw.length === 1) {
    if (raw === ' ') return 'space';
    const lower = raw.toLowerCase();
    if (KEY_SET.has(lower)) return lower;
    return ALIASES[raw] || null;
  }
  const t = raw.trim().toLowerCase().replace(/[\s_]+/g, '');
  if (!t) return null;
  if (t.length === 1) return canonical(t, platform);
  if (PRIMARY_ALIASES.has(t)) return platform === 'darwin' ? 'meta' : 'ctrl';
  if (KEY_SET.has(t)) return t;
  if (ALIASES[t]) return ALIASES[t];
  // Hyphenated names such as "page-up" or "print-screen".
  if (/^[a-z]+(?:-[a-z0-9]+)+$/.test(t)) {
    const joined = t.replace(/-/g, '');
    if (KEY_SET.has(joined)) return joined;
    if (ALIASES[joined]) return ALIASES[joined];
  }
  return null;
}

/** Split a combo string into raw tokens. */
function splitCombo(str) {
  if (str === ' ') return [' '];
  const s = String(str).trim();
  if (!s) return [];
  if (s.length === 1) return [s];
  // A whole-string key name such as "Page Up", "page-down" or "print screen".
  if (!s.includes('+') && canonical(s, 'linux')) return [s];
  let sep = null;
  if (s.includes('+')) sep = '+';
  else if (s.includes('-')) sep = '-';
  if (!sep) return s.split(/\s+/).filter(Boolean);
  const parts = s.split(sep);
  const tokens = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p !== '') {
      tokens.push(p);
      continue;
    }
    // Two consecutive empty parts mean the separator character itself is a key: "ctrl++", "ctrl--".
    if (i + 1 < parts.length && parts[i + 1].trim() === '' && i > 0) {
      tokens.push(sep);
      i++;
      continue;
    }
    throw keyError(`Empty key name in combo "${str}"`);
  }
  return tokens;
}

/**
 * Normalize a key combo.
 * @param {string|string[]} input e.g. 'Ctrl+Shift+T', 'cmd-space', ['ctrl', 'c'], 'primary+s'
 * @param {{platform?:string}} [opts] platform used for 'primary'/'mod' (default process.platform)
 * @returns {string[]} e.g. ['ctrl', 'shift', 't']
 */
function normalizeCombo(input, { platform = process.platform } = {}) {
  let tokens;
  if (Array.isArray(input)) {
    tokens = input.map((t) => (typeof t === 'string' && t.length > 1 ? t.trim() : t));
  } else if (typeof input === 'string') {
    tokens = splitCombo(input);
  } else {
    throw keyError(`Key combo must be a string or an array of key names (got ${typeof input})`);
  }
  if (!tokens.length) throw keyError('Key combo is empty');
  const mods = new Set();
  const keys = [];
  for (const tok of tokens) {
    const name = canonical(tok, platform);
    if (!name) {
      const shown = Array.isArray(input) ? input.join('+') : input;
      throw keyError(`Unknown key "${tok}" in "${shown}". ${validNamesHint()}`);
    }
    if (MODIFIERS.includes(name)) mods.add(name);
    else if (!keys.includes(name)) keys.push(name);
  }
  return [...MODIFIERS.filter((m) => mods.has(m)), ...keys];
}

function ensureKeys(keys, platform) {
  return Array.isArray(keys) && keys.every((k) => KEY_SET.has(k)) ? keys : normalizeCombo(keys, { platform });
}

function isModifier(name) {
  return MODIFIERS.includes(name);
}

// ---------------------------------------------------------------- X11 (xdotool)

const XDOTOOL = {
  ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super',
  enter: 'Return', escape: 'Escape', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete',
  insert: 'Insert', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', capslock: 'Caps_Lock', printscreen: 'Print',
  menu: 'Menu', numlock: 'Num_Lock', scrolllock: 'Scroll_Lock', pause: 'Pause',
  volumeup: 'XF86AudioRaiseVolume', volumedown: 'XF86AudioLowerVolume', volumemute: 'XF86AudioMute',
  playpause: 'XF86AudioPlay', nexttrack: 'XF86AudioNext', prevtrack: 'XF86AudioPrev',
  '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash', ';': 'semicolon',
  "'": 'apostrophe', ',': 'comma', '.': 'period', '/': 'slash', '`': 'grave',
  '!': 'exclam', '@': 'at', '#': 'numbersign', $: 'dollar', '%': 'percent', '^': 'asciicircum',
  '&': 'ampersand', '*': 'asterisk', '(': 'parenleft', ')': 'parenright', _: 'underscore', '+': 'plus',
  '{': 'braceleft', '}': 'braceright', '|': 'bar', ':': 'colon', '"': 'quotedbl', '<': 'less',
  '>': 'greater', '?': 'question', '~': 'asciitilde',
};
for (const f of FKEYS) XDOTOOL[f] = f.toUpperCase();
for (const c of [...LOWER, ...DIGITS]) XDOTOOL[c] = c;

/**
 * X keysym combo for `xdotool key`.
 * @param {string[]|string} keys normalized names (or a combo string)
 * @returns {string} e.g. 'ctrl+shift+t', 'super', 'ctrl+Prior'
 */
function toXdotool(keys) {
  return ensureKeys(keys, 'linux')
    .map((k) => {
      const v = XDOTOOL[k];
      if (!v) throw keyError(`Key "${k}" has no X keysym`);
      return v;
    })
    .join('+');
}

// ---------------------------------------------------------------- macOS (CGEvent)

const MAC_KEYCODES = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09,
  b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10, t: 0x11,
  1: 0x12, 2: 0x13, 3: 0x14, 4: 0x15, 6: 0x16, 5: 0x17, '=': 0x18, 9: 0x19, 7: 0x1a, '-': 0x1b,
  8: 0x1c, 0: 0x1d, ']': 0x1e, o: 0x1f, u: 0x20, '[': 0x21, i: 0x22, p: 0x23, l: 0x25, j: 0x26,
  "'": 0x27, k: 0x28, ';': 0x29, '\\': 0x2a, ',': 0x2b, '/': 0x2c, n: 0x2d, m: 0x2e, '.': 0x2f, '`': 0x32,
  enter: 0x24, tab: 0x30, space: 0x31, backspace: 0x33, escape: 0x35, capslock: 0x39,
  volumeup: 0x48, volumedown: 0x49, volumemute: 0x4a,
  insert: 0x72, home: 0x73, pageup: 0x74, delete: 0x75, end: 0x77, pagedown: 0x79,
  left: 0x7b, right: 0x7c, down: 0x7d, up: 0x7e,
  f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61, f7: 0x62, f8: 0x64, f9: 0x65, f10: 0x6d,
  f11: 0x67, f12: 0x6f, f13: 0x69, f14: 0x6b, f15: 0x71, f16: 0x6a, f17: 0x40, f18: 0x4f, f19: 0x50, f20: 0x5a,
};
const MAC_MOD_KEYCODES = { meta: 0x37, shift: 0x38, alt: 0x3a, ctrl: 0x3b };
const MAC_FLAGS = { meta: 0x100000, shift: 0x20000, alt: 0x80000, ctrl: 0x40000 };
const MAC_UNSUPPORTED_HINTS = {
  printscreen: 'macOS has no Print Screen key; use cmd+shift+3 (full screen) or cmd+shift+4 (selection).',
  menu: 'macOS has no Menu key; use a right click (or ctrl+click) instead.',
  numlock: 'macOS keyboards have no Num Lock key.',
  scrolllock: 'macOS keyboards have no Scroll Lock key.',
  pause: 'macOS keyboards have no Pause key.',
  playpause: 'Media keys cannot be sent as key codes on macOS; control the player app directly.',
  nexttrack: 'Media keys cannot be sent as key codes on macOS; control the player app directly.',
  prevtrack: 'Media keys cannot be sent as key codes on macOS; control the player app directly.',
};

/**
 * macOS virtual key codes (kVK_*) and CGEventFlags for a combo.
 * Shifted punctuation ('?', '!') adds Shift. A modifier-only combo uses the
 * last modifier as the key.
 * @param {string[]|string} keys
 * @returns {{keyCode:number,keyCodes:number[],flags:number,modifierKeyCodes:number[]}}
 */
function toMacKeyCodes(keys) {
  const list = ensureKeys(keys, 'darwin');
  const mods = new Set(list.filter(isModifier));
  const keyCodes = [];
  for (const k of list) {
    if (isModifier(k)) continue;
    const base = SHIFTED[k] || k;
    if (SHIFTED[k]) mods.add('shift');
    const code = MAC_KEYCODES[base];
    if (code === undefined) {
      const err = new Error(`Key "${k}" cannot be sent on macOS`);
      err.code = 'UNSUPPORTED';
      err.hint = MAC_UNSUPPORTED_HINTS[k] || 'macOS keyboards only have F1-F20.';
      throw err;
    }
    keyCodes.push(code);
  }
  const ordered = MODIFIERS.filter((m) => mods.has(m));
  let flags = 0;
  for (const m of ordered) flags |= MAC_FLAGS[m];
  if (!keyCodes.length) {
    const last = ordered[ordered.length - 1];
    return {
      keyCode: MAC_MOD_KEYCODES[last],
      keyCodes: [MAC_MOD_KEYCODES[last]],
      flags,
      modifierKeyCodes: ordered.slice(0, -1).map((m) => MAC_MOD_KEYCODES[m]),
    };
  }
  return {
    keyCode: keyCodes[keyCodes.length - 1],
    keyCodes,
    flags,
    modifierKeyCodes: ordered.map((m) => MAC_MOD_KEYCODES[m]),
  };
}

// ---------------------------------------------------------------- Windows (SendInput)

const VK = {
  ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b,
  enter: 0x0d, escape: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08, delete: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  capslock: 0x14, printscreen: 0x2c, menu: 0x5d, numlock: 0x90, scrolllock: 0x91, pause: 0x13,
  volumemute: 0xad, volumedown: 0xae, volumeup: 0xaf, nexttrack: 0xb0, prevtrack: 0xb1, playpause: 0xb3,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};
FKEYS.forEach((f, i) => {
  VK[f] = 0x70 + i;
});
for (const c of LOWER) VK[c] = c.toUpperCase().charCodeAt(0);
for (const d of DIGITS) VK[d] = d.charCodeAt(0);

const EXTENDED_VK = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, // pgup pgdn end home arrows
  0x2c, 0x2d, 0x2e, // printscreen insert delete
  0x5b, 0x5c, 0x5d, // lwin rwin apps
  0x6f, 0x90, // divide numlock
  0xa3, 0xa5, // rctrl ralt
  0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, // volume and media
]);

/**
 * Windows virtual-key codes, modifiers first.
 * @param {string[]|string} keys
 * @returns {number[]}
 */
function toWindowsVk(keys) {
  const list = ensureKeys(keys, 'win32');
  const mods = new Set(list.filter(isModifier));
  const main = [];
  for (const k of list) {
    if (isModifier(k)) continue;
    if (SHIFTED[k]) mods.add('shift');
    main.push(VK[SHIFTED[k] || k]);
  }
  return [...MODIFIERS.filter((m) => mods.has(m)).map((m) => VK[m]), ...main];
}

/**
 * Whether SendInput needs KEYEVENTF_EXTENDEDKEY for this virtual key.
 * @param {number} vk
 */
function isExtendedVk(vk) {
  return EXTENDED_VK.has(vk);
}

// ---------------------------------------------------------------- Linux evdev (ydotool)

const EVDEV = {
  ctrl: 29, alt: 56, shift: 42, meta: 125,
  escape: 1, '-': 12, '=': 13, backspace: 14, tab: 15, '[': 26, ']': 27, enter: 28, ';': 39, "'": 40,
  '`': 41, '\\': 43, ',': 51, '.': 52, '/': 53, space: 57, capslock: 58, numlock: 69, scrolllock: 70,
  printscreen: 99, home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108,
  pagedown: 109, insert: 110, delete: 111, volumemute: 113, volumedown: 114, volumeup: 115, pause: 119,
  menu: 127, nexttrack: 163, playpause: 164, prevtrack: 165,
  1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
};
for (let i = 13; i <= 24; i++) EVDEV[`f${i}`] = 183 + (i - 13);

/**
 * Linux input-event key codes (KEY_*), modifiers first, for ydotool.
 * @param {string[]|string} keys
 * @returns {number[]}
 */
function toEvdev(keys) {
  const list = ensureKeys(keys, 'linux');
  const mods = new Set(list.filter(isModifier));
  const main = [];
  for (const k of list) {
    if (isModifier(k)) continue;
    if (SHIFTED[k]) mods.add('shift');
    main.push(EVDEV[SHIFTED[k] || k]);
  }
  return [...MODIFIERS.filter((m) => mods.has(m)).map((m) => EVDEV[m]), ...main];
}

module.exports = {
  normalizeCombo,
  toXdotool,
  toMacKeyCodes,
  toWindowsVk,
  isExtendedVk,
  toEvdev,
  isModifier,
  MODIFIERS,
  KEY_NAMES,
  SHIFTED,
  validNamesHint,
};
