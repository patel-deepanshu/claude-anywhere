'use strict';

/*
 * Claude Anywhere macOS helper: a JXA (JavaScript for Automation) script.
 *
 *   osascript -l JavaScript darwin-helper.js serve
 *     Persistent JSON-lines server. Reads {"id","cmd","args"} lines on stdin and
 *     writes {"id","ok":true,"result"} or {"id","ok":false,"error","code"} lines
 *     on stdout. The first line is {"id":0,"ok":true,"result":{"ready":true,...}}.
 *     Exits at end of input or on the "exit" command.
 *   osascript -l JavaScript darwin-helper.js <cmd> '<json args>'
 *     One-shot: runs one command and prints one JSON line.
 *
 * Output is ASCII-only JSON (everything else escaped as \uXXXX) so chunked pipe
 * reads never split a UTF-8 sequence; src/os/darwin.js escapes requests the same
 * way. Coordinates are global points with the origin at the top-left of the
 * primary display (CGEvent space). The one exception is "displays", which
 * returns raw NSScreen frames (bottom-left origin) that darwin.js flips.
 *
 * UI automation (uiTree, uiFind, uiAction, setBounds) reads and drives the
 * accessibility tree of apps; see the "UI automation" section below.
 *
 * Written in conservative ES5 style. It only touches ObjC, $, Ref and
 * Application when they exist, so Node can syntax-check it and unit-test it
 * with fakes.
 */

/* global ObjC, $, Application, Ref */

var HELPER_VERSION = 2;
var HAS_OBJC = typeof ObjC !== 'undefined' && ObjC !== null && typeof ObjC.import === 'function';
var IMPORT_ERRORS = [];

// CoreGraphics / AppKit constants (numeric, so nothing depends on BridgeSupport enums).
var EVENT_MOUSE_MOVED = 5;
var BUTTONS = {
  left: { code: 0, down: 1, up: 2, drag: 6 },
  right: { code: 1, down: 3, up: 4, drag: 7 },
  middle: { code: 2, down: 25, up: 26, drag: 27 },
};
var HID_EVENT_TAP = 0; // kCGHIDEventTap
var CLICK_STATE_FIELD = 1; // kCGMouseEventClickState
var SCROLL_UNIT_LINE = 1; // kCGScrollEventUnitLine
var WINDOW_LIST_ON_SCREEN_ONLY = 1; // kCGWindowListOptionOnScreenOnly
var WINDOW_LIST_INCLUDING_WINDOW = 8; // kCGWindowListOptionIncludingWindow
var WINDOW_LIST_EXCLUDE_DESKTOP = 16; // kCGWindowListExcludeDesktopElements
var NULL_WINDOW_ID = 0; // kCGNullWindowID
var ACTIVATE_IGNORING_OTHER_APPS = 2; // NSApplicationActivateIgnoringOtherApps
var UTF8_ENCODING = 4; // NSUTF8StringEncoding
var LATIN1_ENCODING = 5; // NSISOLatin1StringEncoding

var FLAG_SHIFT = 0x20000;
var FLAG_CTRL = 0x40000;
var FLAG_ALT = 0x80000;
var FLAG_CMD = 0x100000;
var FLAG_NUMPAD = 0x200000;
var FLAG_FN = 0x800000;

// kVK_* modifier key codes -> the CGEventFlags bit they set.
var MODIFIER_FLAGS = {
  55: FLAG_CMD, 54: FLAG_CMD, 56: FLAG_SHIFT, 60: FLAG_SHIFT,
  58: FLAG_ALT, 61: FLAG_ALT, 59: FLAG_CTRL, 62: FLAG_CTRL, 63: FLAG_FN,
};
// Native arrow-key events carry NumericPad|SecondaryFn; F-keys and the
// navigation block carry SecondaryFn. Some apps only match shortcuts with them.
var ARROW_KEYS = { 123: 1, 124: 1, 125: 1, 126: 1 };
var FN_KEYS = {
  114: 1, 115: 1, 116: 1, 117: 1, 119: 1, 121: 1,
  122: 1, 120: 1, 99: 1, 118: 1, 96: 1, 97: 1, 98: 1, 100: 1, 101: 1, 109: 1,
  103: 1, 111: 1, 105: 1, 107: 1, 113: 1, 106: 1, 64: 1, 79: 1, 80: 1, 90: 1,
};
var KEY_V = 9;
var KEY_CMD = 55;
var KEY_SHIFT = 56;
var KEY_ALT = 58;
// Modifier key codes in the order keys.js presses them: ctrl, alt (option), shift, cmd, fn.
var MODIFIER_RANK = { 59: 0, 62: 0, 58: 1, 61: 1, 56: 2, 60: 2, 55: 3, 54: 3, 63: 4 };

// Keyboard layout lookups. keys.js sends a shifted US character as its base plus Shift
// ('?' as '/' with Shift); this is what Shift types on each of those US keys.
var US_SHIFTED = {
  1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~',
};
var US_SHIFTED_CHARS = {};
for (var usBase in US_SHIFTED) {
  if (Object.prototype.hasOwnProperty.call(US_SHIFTED, usBase)) US_SHIFTED_CHARS[US_SHIFTED[usBase]] = usBase;
}
// Key codes probed for layout maps: the character block (ANSI and ISO, 0x00-0x32) and the two
// JIS character keys. Keypad codes are left out: kVK_ANSI_Keypad1 also types '1', but is not the '1' key.
var LAYOUT_CODES = [0x5d, 0x5e];
for (var layoutCode = 0x32; layoutCode >= 0; layoutCode--) LAYOUT_CODES.unshift(layoutCode);
// Layouts that switch to a QWERTY keymap while Command is held ("Dvorak - QWERTY ⌘").
var QWERTY_CMD_RE = /QWERTY[\s_-]*(CMD|COMMAND)|⌘/i;
// ASCII-capable layouts without dead keys in their plain and Shift layers. On any other layout
// (U.S. International - PC, German, French, Spanish...) these ASCII characters may be dead keys,
// which System Events keystrokes would compose into the next letter ('"a' -> 'ä').
var DEAD_KEY_FREE_RE = new RegExp(
  '^com\\.apple\\.keylayout\\.(US|ABC|USExtended|ABC-India|British|British-PC|Australian|' +
    'Dvorak|Dvorak-Left|Dvorak-Right|DVORAK-QWERTYCMD|Colemak|UnicodeHexInput)$',
  'i',
);
var DEAD_KEY_CHARS = '\'"`^~';

// Timings in seconds.
var KEY_GAP = 0.008;
var PRESS_GAP = 0.012;
var MULTI_CLICK_GAP = 0.04;
var MOVE_SETTLE = 0.02;
var DRAG_HOLD = 0.06;
var DRAG_STEP_GAP = 0.012;
var SCROLL_GAP = 0.015;
// The target app reads the pasteboard only when it handles Cmd+V, which a busy app (an
// Electron terminal under load) can do long after the event was posted. The pasteboard must
// not change before then, or the app pastes the next text or the restored clipboard.
var PASTE_SETTLE = 0.4;
var PASTE_RESTORE = 1.0;
var AX_TITLE_BUDGET_MS = 2500;
var AX_TITLE_MAX_APPS = 12;

// Text Input Sources (HIToolbox). The literal values of the kTIS* CFString
// constants, used when the bridge does not expose the constants themselves.
var TIS_PROP_ID = 'TISPropertyInputSourceID';
var TIS_PROP_TYPE = 'TISPropertyInputSourceType';
var TIS_PROP_ASCII = 'TISPropertyInputSourceIsASCIICapable';
var TIS_TYPE_LAYOUT = 'TISTypeKeyboardLayout';
var TIS_METHOD_TYPES = {
  TISTypeKeyboardInputMode: 1,
  TISTypeKeyboardInputMethodModeEnabled: 1,
  TISTypeKeyboardInputMethodWithoutModes: 1,
};
// Keyboard layouts that type no ASCII letters. Only used when TIS cannot say
// whether the current layout is ASCII-capable.
var NON_ASCII_LAYOUT_RE = new RegExp(
  '^com\\.apple\\.keylayout\\.(Russian|Ukrainian|Byelorussian|Belarusian|Bulgarian|Serbian(?!-Latin)|Macedonian|Kazakh|' +
    'Kyrgyz|Mongolian|Tatar|Bashkir|Chuvash|Ossetian|Yakut|Tajik|Uzbek-Cyrillic|Greek|Hebrew|Arabic|Persian|Pashto|Urdu|' +
    'Uyghur|Sindhi|Kurdish-Sorani|Dhivehi|Syriac|Thai|Lao|Khmer|Myanmar|Armenian|Georgian|Devanagari|Hindi|Marathi|Nepali|' +
    'Sanskrit|Bangla|Bengali|Assamese|Gujarati|Gurmukhi|Punjabi|Kannada|Malayalam|Oriya|Odia|Tamil|Telugu|Sinhala|Tibetan|' +
    'Dzongkha|Inuktitut|Cherokee|Tifinagh|NKo|Adlam|Hanifi|Amharic|Tigrinya)',
  'i',
);
var CARBON_TRIED = false;

importFrameworks();

function importFrameworks() {
  if (!HAS_OBJC) return;
  var names = ['Cocoa', 'CoreGraphics', 'ApplicationServices'];
  for (var i = 0; i < names.length; i++) {
    try {
      ObjC.import(names[i]);
    } catch (e) {
      IMPORT_ERRORS.push(names[i] + ': ' + errMessage(e));
    }
  }
  try {
    if (typeof $.CGEventPost === 'undefined') ObjC.import('Quartz');
  } catch (e) {
    IMPORT_ERRORS.push('Quartz: ' + errMessage(e));
  }
}

/** Text Input Source functions live in Carbon (HIToolbox); load it on first use only. */
function importCarbon() {
  if (CARBON_TRIED || !HAS_OBJC) return;
  CARBON_TRIED = true;
  try {
    if (typeof $.TISCopyCurrentKeyboardInputSource === 'undefined') ObjC.import('Carbon');
  } catch (e) {
    IMPORT_ERRORS.push('Carbon: ' + errMessage(e));
  }
}

// ---------------------------------------------------------------- small helpers

function errMessage(e) {
  if (e === null || e === undefined) return 'unknown error';
  if (typeof e === 'string') return e;
  return String(e.message || e);
}

function fail(code, message, extra) {
  var e = new Error(message);
  e.code = code;
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    }
  }
  return e;
}

function isNil(v) {
  if (v === null || v === undefined) return true;
  try {
    return typeof v.isNil === 'function' && v.isNil() === true;
  } catch (e) {
    return true;
  }
}

/** NSString (or JS string) -> JS string; '' for nil. */
function str(v) {
  if (isNil(v)) return '';
  try {
    var s = ObjC.unwrap(v);
    if (s === null || s === undefined) return '';
    return typeof s === 'string' ? s : String(s);
  } catch (e) {
    return '';
  }
}

function num(v, name) {
  var n = Number(v);
  if (v === null || v === undefined || v === '' || !isFinite(n)) {
    throw fail('BAD_ARGS', name + ' must be a finite number (got ' + v + ')');
  }
  return n;
}

function int(v, name) {
  return Math.round(num(v, name));
}

function clampInt(v, min, max, dflt) {
  var n = Math.round(Number(v));
  if (v === null || v === undefined || !isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function intList(v) {
  var out = [];
  if (!v || typeof v.length !== 'number') return out;
  for (var i = 0; i < v.length; i++) {
    var n = Math.round(Number(v[i]));
    if (isFinite(n)) out.push(n);
  }
  return out;
}

function sign(n) {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

function sleep(sec) {
  if (sec > 0) $.NSThread.sleepForTimeInterval(sec);
}

/**
 * Spin the main run loop briefly. NSWorkspace / NSRunningApplication / NSScreen
 * state only refreshes while the run loop runs, and serve mode otherwise blocks
 * in a read, so long-lived helpers would report a stale frontmost app.
 */
function pump(sec) {
  try {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(sec));
  } catch (e) {
    /* best effort */
  }
}

/** JSON with every non-ASCII UTF-16 unit escaped as \uXXXX. */
function asciiJson(value) {
  var s = JSON.stringify(value === undefined ? null : value);
  return s.replace(/[\u007f-\uffff]/g, function (c) {
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

function rectOf(r) {
  return {
    x: Number(r.origin.x),
    y: Number(r.origin.y),
    width: Number(r.size.width),
    height: Number(r.size.height),
  };
}

function near(a, b, tol) {
  var t = tol === undefined ? 4 : tol;
  return (
    Math.abs(a.x - b.x) <= t &&
    Math.abs(a.y - b.y) <= t &&
    Math.abs(a.width - b.width) <= t &&
    Math.abs(a.height - b.height) <= t
  );
}

// ---------------------------------------------------------------- CoreGraphics events

function point(x, y) {
  if (typeof $.CGPointMake === 'function') return $.CGPointMake(x, y);
  return { x: x, y: y };
}

function button(name) {
  var key = String(name || 'left').toLowerCase();
  if (key === 'center' || key === 'wheel') key = 'middle';
  var b = BUTTONS[key];
  if (!b) throw fail('BAD_ARGS', 'unknown mouse button "' + name + '" (use left, right or middle)');
  return b;
}

function post(e) {
  if (e === null || e === undefined) throw fail('EVENT_FAILED', 'CoreGraphics could not create the input event');
  $.CGEventPost(HID_EVENT_TAP, e);
}

function mouseEvent(type, p, buttonCode, clickState, flags) {
  var e = $.CGEventCreateMouseEvent(null, type, p, buttonCode);
  if (e === null || e === undefined) return e;
  if (clickState) $.CGEventSetIntegerValueField(e, CLICK_STATE_FIELD, clickState);
  $.CGEventSetFlags(e, flags || 0);
  return e;
}

function keyEvent(code, down, flags) {
  var e = $.CGEventCreateKeyboardEvent(null, code, down);
  if (e === null || e === undefined) return e;
  // Always set flags: a null-source event would otherwise inherit stray modifier state.
  $.CGEventSetFlags(e, flags || 0);
  return e;
}

function modifierFlag(code) {
  return MODIFIER_FLAGS[code] || 0;
}

function isModifierCode(code) {
  return Object.prototype.hasOwnProperty.call(MODIFIER_FLAGS, code);
}

function extraKeyFlags(code) {
  if (ARROW_KEYS[code]) return FLAG_NUMPAD | FLAG_FN;
  if (FN_KEYS[code]) return FLAG_FN;
  return 0;
}

/** Press modifier keys down in order; returns the accumulated flags. */
function pressModifiers(codes) {
  var held = 0;
  for (var i = 0; i < codes.length; i++) {
    held |= modifierFlag(codes[i]);
    post(keyEvent(codes[i], true, held));
    sleep(KEY_GAP);
  }
  return held;
}

/** Release modifier keys in reverse order. Never throws. */
function releaseModifiers(codes, held) {
  var flags = held;
  for (var i = codes.length - 1; i >= 0; i--) {
    flags &= ~modifierFlag(codes[i]);
    try {
      post(keyEvent(codes[i], false, flags));
    } catch (e) {
      /* keep releasing the rest */
    }
    sleep(KEY_GAP);
  }
}

/**
 * Chord: modifiers down, keys down in order, keys up in reverse, modifiers up.
 * Key-up events are always sent, even if a key-down failed half way.
 */
function pressCombo(keyCodes, flags, modifierCodes) {
  var held = 0;
  var downs = [];
  try {
    held = pressModifiers(modifierCodes);
    for (var i = 0; i < keyCodes.length; i++) {
      var c = keyCodes[i];
      var f = isModifierCode(c) ? held | modifierFlag(c) : flags | held | extraKeyFlags(c);
      downs.push({ code: c, flags: f });
      post(keyEvent(c, true, f));
      sleep(KEY_GAP);
    }
  } finally {
    for (var j = downs.length - 1; j >= 0; j--) {
      var d = downs[j];
      try {
        post(keyEvent(d.code, false, isModifierCode(d.code) ? held : d.flags));
      } catch (e) {
        /* keep releasing */
      }
      sleep(KEY_GAP);
    }
    releaseModifiers(modifierCodes, held);
  }
}

function cursorLocation() {
  var loc = $.CGEventGetLocation($.CGEventCreate(null));
  return { x: Number(loc.x), y: Number(loc.y) };
}

// ---------------------------------------------------------------- windows & apps

function readWindowList(option, relativeTo) {
  var ref = $.CGWindowListCopyWindowInfo(option, relativeTo);
  if (ref === null || ref === undefined) return [];
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(ref));
  if (!list || typeof list.length !== 'number') return [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (!w) continue;
    var b = w.kCGWindowBounds || {};
    out.push({
      number: Number(w.kCGWindowNumber),
      pid: Number(w.kCGWindowOwnerPID),
      owner: w.kCGWindowOwnerName ? String(w.kCGWindowOwnerName) : '',
      title: w.kCGWindowName ? String(w.kCGWindowName) : '',
      layer: Number(w.kCGWindowLayer || 0),
      alpha: w.kCGWindowAlpha === undefined || w.kCGWindowAlpha === null ? 1 : Number(w.kCGWindowAlpha),
      onscreen: w.kCGWindowIsOnscreen !== false && w.kCGWindowIsOnscreen !== 0,
      x: Number(b.X || 0),
      y: Number(b.Y || 0),
      width: Number(b.Width || 0),
      height: Number(b.Height || 0),
    });
  }
  return out;
}

function onScreenWindows() {
  return readWindowList(WINDOW_LIST_ON_SCREEN_ONLY | WINDOW_LIST_EXCLUDE_DESKTOP, NULL_WINDOW_ID);
}

function windowInfo(number) {
  var list = readWindowList(WINDOW_LIST_INCLUDING_WINDOW, number);
  for (var i = 0; i < list.length; i++) {
    if (list[i].number === number) return list[i];
  }
  return null;
}

function frontApp() {
  pump(0.01);
  try {
    var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (isNil(app)) return null;
    return {
      pid: Number(app.processIdentifier),
      name: str(app.localizedName),
      bundleId: str(app.bundleIdentifier),
    };
  } catch (e) {
    return null;
  }
}

function systemEvents() {
  return Application('System Events');
}

function axProcess(se, pid) {
  return se.processes.whose({ unixId: pid })[0];
}

/**
 * Name and frame of every accessibility window of a process (3 Apple events). Bulk getters on
 * the unix-id specifier, so another process with the same name is never consulted. A frame
 * that cannot be read is NaN.
 */
function axWindowFrames(se, pid) {
  var p = axProcess(se, pid);
  var names = p.windows.name();
  var pos = null;
  var size = null;
  try {
    pos = p.windows.position();
    size = p.windows.size();
  } catch (e) {
    pos = null;
    size = null;
  }
  var out = [];
  for (var i = 0; i < names.length; i++) {
    var xy = pos && pos[i] ? pos[i] : null;
    var wh = size && size[i] ? size[i] : null;
    out.push({
      name: names[i] === null || names[i] === undefined ? '' : String(names[i]),
      x: xy ? Number(xy[0]) : NaN,
      y: xy ? Number(xy[1]) : NaN,
      width: wh ? Number(wh[0]) : NaN,
      height: wh ? Number(wh[1]) : NaN,
    });
  }
  return out;
}

/**
 * Window titles are blank in the CG list without Screen Recording permission.
 * Fill them from the accessibility tree, matching windows by frame. Bounded by
 * a time budget; stops at the first permission error.
 */
function fillTitlesFromAX(wins, budgetMs) {
  var need = {};
  var pids = [];
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i];
    if (w.layer !== 0 || w.title || w.width < 40 || w.height < 40 || !(w.pid > 0)) continue;
    if (!need[w.pid]) {
      need[w.pid] = [];
      pids.push(w.pid);
    }
    need[w.pid].push(w);
  }
  if (!pids.length) return { filled: 0 };
  var started = Date.now();
  var budget = budgetMs > 0 ? budgetMs : AX_TITLE_BUDGET_MS;
  var se;
  try {
    se = systemEvents();
  } catch (e) {
    return { filled: 0, error: errMessage(e) };
  }
  var filled = 0;
  for (var p = 0; p < pids.length && p < AX_TITLE_MAX_APPS; p++) {
    if (Date.now() - started > budget) break;
    var ax;
    try {
      ax = axWindowFrames(se, pids[p]);
    } catch (e) {
      var c = classifyError(e);
      if (c.code === 'PERMISSION') return { filled: filled, error: c.message, perm: c.perm };
      continue;
    }
    var used = {};
    var list = need[pids[p]];
    for (var j = 0; j < list.length; j++) {
      for (var k = 0; k < ax.length; k++) {
        if (used[k] || !near(ax[k], list[j])) continue;
        used[k] = true;
        if (ax[k].name) {
          list[j].title = ax[k].name;
          list[j].titleSource = 'ax';
          filled++;
        }
        break;
      }
    }
  }
  return { filled: filled };
}

/**
 * The System Events window of a process that matches a CG window (frame first, then title),
 * as an index into the process's windows; -1 if none. Act on it through
 * axProcess(se, pid).windows[index]: the references `proc.windows()` returns name the
 * process by name, so with two instances of an app (the dialog's browser next to the
 * user's) every later Apple event would go to whichever instance comes first.
 */
function findAxWindowIndex(se, pid, info) {
  return pickWindowIndex(axWindowFrames(se, pid), info);
}

/**
 * The index of the accessibility window frame ({name, x, y, width, height}) that matches a CG
 * window: same frame and title first, then the same frame, then the same title; -1 if none.
 * Without a CG window, the first (frontmost) one.
 */
function pickWindowIndex(frames, info) {
  if (!frames.length) return -1;
  if (!info) return 0;
  var byFrame = -1;
  var byTitle = -1;
  for (var i = 0; i < frames.length; i++) {
    var f = frames[i];
    var frameMatch = near(f, info);
    if (frameMatch && (!info.title || f.name === info.title)) return i;
    if (frameMatch && byFrame < 0) byFrame = i;
    if (info.title && f.name === info.title && byTitle < 0) byTitle = i;
  }
  return byFrame >= 0 ? byFrame : byTitle;
}

/** Whether no other process has the same name as `pid` (System Events references name processes by name). */
function processNameIsUnique(se, pid) {
  try {
    var name = axProcess(se, pid).name();
    return se.processes.whose({ name: name }).length === 1;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- pasteboard

function pasteboard() {
  return $.NSPasteboard.generalPasteboard;
}

function pbStringType() {
  try {
    var t = $.NSPasteboardTypeString;
    if (!isNil(t)) return t;
  } catch (e) {
    /* fall through */
  }
  return 'public.utf8-plain-text';
}

function clipboardText() {
  var s = pasteboard().stringForType(pbStringType());
  return isNil(s) ? '' : str(s);
}

function setClipboardText(text) {
  var pb = pasteboard();
  pb.clearContents;
  var ok = pb.setStringForType($(String(text)), pbStringType());
  if (ok === false || ok === 0) throw fail('CLIPBOARD', 'could not put text on the clipboard');
  return Number(pb.changeCount);
}

/** Snapshot every pasteboard item (all types) plus its plain text. */
function saveClipboard() {
  var pb = pasteboard();
  var saved = { text: null, items: null };
  try {
    var s = pb.stringForType(pbStringType());
    if (!isNil(s)) saved.text = str(s);
  } catch (e) {
    saved.text = null;
  }
  try {
    var items = pb.pasteboardItems;
    var n = isNil(items) ? 0 : Number(items.count);
    var copies = [];
    for (var i = 0; i < n && i < 16; i++) {
      var item = items.objectAtIndex(i);
      var types = item.types;
      var tn = isNil(types) ? 0 : Number(types.count);
      var copy = $.NSPasteboardItem.alloc.init;
      var any = false;
      for (var j = 0; j < tn && j < 32; j++) {
        var t = types.objectAtIndex(j);
        var data = item.dataForType(t);
        if (!isNil(data)) {
          copy.setDataForType(data, t);
          any = true;
        }
      }
      if (any) copies.push(copy);
    }
    if (copies.length) saved.items = copies;
  } catch (e) {
    saved.items = null;
  }
  return saved;
}

/** Put the snapshot back, unless someone else changed the pasteboard since our last write. */
function restoreClipboard(saved, expectedChangeCount) {
  var pb = pasteboard();
  if (expectedChangeCount !== null && expectedChangeCount !== undefined && Number(pb.changeCount) !== expectedChangeCount) {
    return false;
  }
  pb.clearContents;
  if (saved.items) {
    try {
      var arr = $.NSMutableArray.alloc.init;
      for (var i = 0; i < saved.items.length; i++) arr.addObject(saved.items[i]);
      var wrote = pb.writeObjects(arr);
      if (wrote !== false && wrote !== 0) return true;
    } catch (e) {
      /* fall back to plain text */
    }
  }
  if (saved.text !== null) {
    pb.setStringForType($(saved.text), pbStringType());
    return true;
  }
  return true;
}

// ---------------------------------------------------------------- input sources

function toBool(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  return null;
}

/** A CF/ObjC value returned as a pointer -> JS value; null for NULL or nil. */
function refValue(ref) {
  if (ref === null || ref === undefined) return null;
  var obj = ref;
  try {
    obj = ObjC.castRefToObject(ref);
  } catch (e) {
    obj = ref;
  }
  if (isNil(obj)) return null;
  try {
    var v = ObjC.unwrap(obj);
    return v === undefined || v === null ? null : v;
  } catch (e) {
    return null;
  }
}

/** One TIS property, keyed by the bridged kTIS* constant or, failing that, its literal value. */
function tisProperty(src, constName, literal) {
  var keys = [];
  try {
    var k = $[constName];
    if (k !== undefined && k !== null) keys.push(k);
  } catch (e) {
    /* not bridged */
  }
  keys.push($(literal));
  for (var i = 0; i < keys.length; i++) {
    try {
      var v = refValue($.TISGetInputSourceProperty(src, keys[i]));
      if (v !== null) return v;
    } catch (e) {
      /* try the next form of the key */
    }
  }
  return null;
}

function inputSourceFromTIS() {
  importCarbon();
  if (typeof $.TISCopyCurrentKeyboardInputSource === 'undefined' || typeof $.TISGetInputSourceProperty === 'undefined') return null;
  // TIS hears about input source switches through notifications delivered on the run loop.
  pump(0.01);
  var src = $.TISCopyCurrentKeyboardInputSource();
  if (isNil(src)) return null;
  var id = tisProperty(src, 'kTISPropertyInputSourceID', TIS_PROP_ID);
  var type = tisProperty(src, 'kTISPropertyInputSourceType', TIS_PROP_TYPE);
  var ascii = toBool(tisProperty(src, 'kTISPropertyInputSourceIsASCIICapable', TIS_PROP_ASCII));
  if (id === null && type === null && ascii === null) return null;
  return { id: id === null ? '' : String(id), type: type === null ? '' : String(type), ascii: ascii, source: 'tis' };
}

/** Fallback: the HIToolbox preferences hold the selected keyboard layout and input method. */
function inputSourceFromDefaults() {
  if (typeof $.NSUserDefaults === 'undefined') return null;
  var d = $.NSUserDefaults.alloc.initWithSuiteName('com.apple.HIToolbox');
  if (isNil(d)) return null;
  try {
    d.synchronize;
  } catch (e) {
    /* best effort refresh */
  }
  var layout = str(d.stringForKey('AppleCurrentKeyboardLayoutInputSourceID'));
  var selected = [];
  try {
    var arr = d.arrayForKey('AppleSelectedInputSources');
    if (!isNil(arr)) selected = ObjC.deepUnwrap(arr) || [];
  } catch (e) {
    selected = [];
  }
  var method = '';
  for (var i = 0; i < selected.length; i++) {
    var s = selected[i] || {};
    var kind = String(s.InputSourceKind || '');
    if (kind === 'Input Mode' || kind === 'Keyboard Input Method') {
      method = String(s['Input Mode'] || s['Bundle ID'] || 'input method');
      break;
    }
  }
  if (!layout && !method) return null;
  return { id: method || layout, inputMethod: Boolean(method), ascii: null, source: 'defaults' };
}

/**
 * Whether System Events keystrokes are safe for an input source. keystroke
 * turns characters into key presses that go through the active layout and
 * input method, so anything but an ASCII-capable keyboard layout garbles ASCII
 * text: input methods (Japanese, Chinese, Korean...) compose it, non-Latin
 * layouts (Russian, Greek...) type other letters. safe is null when unknown.
 * deadChars lists the ASCII characters that may be dead keys on a layout that is not
 * known to be free of them ('' otherwise): keystrokes would compose them into the next
 * letter ('"' then 'a' types 'ä' on U.S. International), so steps containing them are pasted.
 * @param {{id?:string, type?:string, ascii?:(boolean|null), inputMethod?:boolean, source?:string}} raw
 * @returns {{id:string, kind:string, ascii:(boolean|null), safe:(boolean|null), deadChars:string, source:string}}
 */
function describeInputSource(raw) {
  var r = raw || {};
  var id = r.id ? String(r.id) : '';
  var kind = 'unknown';
  if (r.inputMethod === true || TIS_METHOD_TYPES[r.type] === 1) kind = 'inputMethod';
  else if (r.type === TIS_TYPE_LAYOUT) kind = 'layout';
  else if (/\.inputmethod\./i.test(id)) kind = 'inputMethod';
  else if (/^com\.apple\.keylayout\./i.test(id)) kind = 'layout';
  var ascii = toBool(r.ascii);
  if (ascii === null && kind === 'layout' && NON_ASCII_LAYOUT_RE.test(id)) ascii = false;
  var safe = null;
  if (kind === 'inputMethod' || ascii === false) safe = false;
  else if (kind === 'layout' && ascii === true) safe = true;
  var deadChars = kind === 'layout' && safe !== false && !DEAD_KEY_FREE_RE.test(id) ? DEAD_KEY_CHARS : '';
  return { id: id, kind: kind, ascii: ascii, safe: safe, deadChars: deadChars, source: r.source || '' };
}

/** The active keyboard input source, or null if it cannot be read. Never throws. */
function currentInputSource() {
  if (!HAS_OBJC) return null;
  var raw = null;
  try {
    raw = inputSourceFromTIS();
  } catch (e) {
    raw = null;
  }
  if (!raw) {
    try {
      raw = inputSourceFromDefaults();
    } catch (e) {
      raw = null;
    }
  }
  return raw ? describeInputSource(raw) : null;
}

/** Typing steps with every text step pasted; adjacent text is merged into one paste. */
function pastePlan(steps) {
  var out = [];
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i] || {};
    if (s.kind !== 'keys' && s.kind !== 'paste') {
      out.push(s);
      continue;
    }
    var text = s.text === undefined || s.text === null ? '' : String(s.text);
    if (!text) continue;
    var last = out.length ? out[out.length - 1] : null;
    if (last && last.kind === 'paste') last.text += text;
    else out.push({ kind: 'paste', text: text });
  }
  return out;
}

/**
 * Typing steps with every keystroke step that contains one of `deadChars` pasted instead
 * (adjacent pastes merged), or null when no step does.
 * @param {Array<object>} steps
 * @param {string} deadChars
 * @returns {Array<object>|null}
 */
function pasteDeadKeySteps(steps, deadChars) {
  if (!deadChars) return null;
  var out = [];
  var changed = false;
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i] || {};
    var text = s.text === undefined || s.text === null ? '' : String(s.text);
    var kind = s.kind;
    if (kind === 'keys') {
      for (var j = 0; j < text.length && kind === 'keys'; j++) {
        if (deadChars.indexOf(text.charAt(j)) >= 0) kind = 'paste';
      }
      if (kind === 'paste') changed = true;
    }
    if (kind !== 'paste') {
      out.push(s);
      continue;
    }
    if (!text) continue;
    var last = out.length ? out[out.length - 1] : null;
    if (last && last.kind === 'paste') last.text += text;
    else out.push({ kind: 'paste', text: text });
  }
  return changed ? out : null;
}

// ---------------------------------------------------------------- errors

/**
 * Map a thrown error (JXA Apple event errors carry .errorNumber) to a code.
 * @returns {{code:string, message:string, number:(number|null), perm:(string|null)}}
 */
function classifyError(e) {
  var message = errMessage(e);
  var number = e && typeof e.errorNumber === 'number' ? e.errorNumber : null;
  if (e && typeof e.code === 'string' && e.code) {
    return { code: e.code, message: message, number: number, perm: e.perm || null };
  }
  if (number === -1743 || number === -10004 || /not (authori[sz]ed|allowed) to send apple ?events|privilege violation/i.test(message)) {
    return { code: 'PERMISSION', message: message, number: number, perm: 'automation' };
  }
  if (number === -25211 || /assistive access|not allowed to send keystrokes|accessibility/i.test(message)) {
    return { code: 'PERMISSION', message: message, number: number, perm: 'accessibility' };
  }
  if (number === -1728 || number === -1719 || number === -600 || /can.t get|invalid index|isn.t running/i.test(message)) {
    return { code: 'NOT_FOUND', message: message, number: number, perm: null };
  }
  return { code: 'HELPER_ERROR', message: message, number: number, perm: null };
}

function errorResponse(id, e) {
  var c = classifyError(e);
  var out = { id: id, ok: false, error: c.message, code: c.code };
  if (c.perm) out.perm = c.perm;
  if (c.number !== null) out.errorNumber = c.number;
  return out;
}

// ---------------------------------------------------------------- commands

function cmdPing() {
  var pid = null;
  var osVersion = '';
  try {
    pid = Number($.NSProcessInfo.processInfo.processIdentifier);
    osVersion = str($.NSProcessInfo.processInfo.operatingSystemVersionString);
  } catch (e) {
    /* informational */
  }
  return { pong: true, version: HELPER_VERSION, pid: pid, os: osVersion, importErrors: IMPORT_ERRORS };
}

/**
 * Call CGPreflightScreenCaptureAccess or CGRequestScreenCaptureAccess (CoreGraphics, macOS
 * 10.15+). The bridge metadata (BridgeSupport) that JXA reads lacks both, even on macOS 26, so
 * `$.CGPreflightScreenCaptureAccess` is undefined there: bind the C function by name instead.
 * @returns {boolean|null} null when the function cannot be called
 */
function screenCaptureAccess(name) {
  if (typeof $[name] === 'undefined' && typeof ObjC.bindFunction === 'function') {
    try {
      ObjC.bindFunction(name, ['bool', []]);
    } catch (e) {
      return null;
    }
  }
  if (typeof $[name] === 'undefined') return null;
  return Boolean($[name]());
}

function cmdPerms() {
  var accessibility = null;
  var screenRecording = null;
  try {
    if (typeof $.AXIsProcessTrusted !== 'undefined') accessibility = Boolean($.AXIsProcessTrusted());
  } catch (e) {
    accessibility = null;
  }
  try {
    screenRecording = screenCaptureAccess('CGPreflightScreenCaptureAccess');
  } catch (e) {
    screenRecording = null;
  }
  var info = cmdPing();
  return { accessibility: accessibility, screenRecording: screenRecording, os: info.os, pid: info.pid };
}

/** Show the system prompts (Accessibility and Screen Recording) for the responsible app. */
function cmdRequestPerms(a) {
  var out = { accessibility: null, screenRecording: null };
  if (a.accessibility !== false) {
    try {
      var opts = $.NSMutableDictionary.alloc.init;
      opts.setObjectForKey($.NSNumber.numberWithBool(true), 'AXTrustedCheckOptionPrompt');
      out.accessibility = Boolean($.AXIsProcessTrustedWithOptions(opts));
    } catch (e) {
      out.accessibilityError = errMessage(e);
    }
  }
  if (a.screenRecording !== false) {
    try {
      out.screenRecording = screenCaptureAccess('CGRequestScreenCaptureAccess');
    } catch (e) {
      out.screenRecordingError = errMessage(e);
    }
  }
  return out;
}

function cmdDisplays() {
  pump(0.01);
  var screens = $.NSScreen.screens;
  var n = isNil(screens) ? 0 : Number(screens.count);
  var out = [];
  for (var i = 0; i < n; i++) {
    var s = screens.objectAtIndex(i);
    var id = null;
    try {
      var v = s.deviceDescription.objectForKey('NSScreenNumber');
      if (!isNil(v)) id = Number(ObjC.unwrap(v));
    } catch (e) {
      id = null;
    }
    var visible = null;
    try {
      visible = rectOf(s.visibleFrame);
    } catch (e) {
      visible = null;
    }
    // CGDisplayBounds is already in top-left global space and never stale.
    var cg = null;
    if (id !== null && isFinite(id) && typeof $.CGDisplayBounds !== 'undefined') {
      try {
        cg = rectOf($.CGDisplayBounds(id));
      } catch (e) {
        cg = null;
      }
    }
    var name = '';
    try {
      name = str(s.localizedName);
    } catch (e) {
      name = '';
    }
    out.push({
      id: id,
      frame: rectOf(s.frame),
      visible: visible,
      cg: cg,
      scale: Number(s.backingScaleFactor) || 1,
      name: name,
    });
  }
  return { screens: out };
}

function cmdCursor() {
  return cursorLocation();
}

function cmdMove(a) {
  var x = num(a.x, 'x');
  var y = num(a.y, 'y');
  var p = point(x, y);
  if (a.button) {
    // A button is held (mouseDown): apps only see a drag if we send dragged events.
    var b = button(a.button);
    post(mouseEvent(b.drag, p, b.code, 1, a.flags | 0));
  } else {
    post(mouseEvent(EVENT_MOUSE_MOVED, p, 0, 0, 0));
  }
  return { x: x, y: y };
}

function cmdClick(a) {
  var x = num(a.x, 'x');
  var y = num(a.y, 'y');
  var b = button(a.button);
  var clicks = clampInt(a.clicks, 1, 10, 1);
  var mods = intList(a.modifierKeyCodes);
  var flags = a.flags | 0;
  var p = point(x, y);
  post(mouseEvent(EVENT_MOUSE_MOVED, p, 0, 0, 0));
  sleep(MOVE_SETTLE);
  var held = 0;
  try {
    held = pressModifiers(mods);
    // Native double/triple clicks: down/up pairs with click state 1, 2, 3.
    for (var i = 1; i <= clicks; i++) {
      post(mouseEvent(b.down, p, b.code, i, flags | held));
      try {
        sleep(PRESS_GAP);
      } finally {
        post(mouseEvent(b.up, p, b.code, i, flags | held));
      }
      if (i < clicks) sleep(MULTI_CLICK_GAP);
    }
  } finally {
    releaseModifiers(mods, held);
  }
  return { x: x, y: y, clicks: clicks };
}

function cmdButton(a, down) {
  var b = button(a.button);
  var loc = cursorLocation();
  post(mouseEvent(down ? b.down : b.up, point(loc.x, loc.y), b.code, 1, a.flags | 0));
  return loc;
}

function cmdDrag(a) {
  var x1 = num(a.x1, 'x1');
  var y1 = num(a.y1, 'y1');
  var x2 = num(a.x2, 'x2');
  var y2 = num(a.y2, 'y2');
  var b = button(a.button);
  var steps = clampInt(a.steps, 2, 120, 12);
  var flags = a.flags | 0;
  var from = point(x1, y1);
  post(mouseEvent(EVENT_MOUSE_MOVED, from, 0, 0, 0));
  sleep(MOVE_SETTLE);
  post(mouseEvent(b.down, from, b.code, 1, flags));
  try {
    sleep(DRAG_HOLD);
    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      post(mouseEvent(b.drag, point(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t), b.code, 1, flags));
      sleep(DRAG_STEP_GAP);
    }
    sleep(DRAG_HOLD);
  } finally {
    post(mouseEvent(b.up, point(x2, y2), b.code, 1, flags));
  }
  return { x: x2, y: y2, steps: steps };
}

function cmdScroll(a) {
  if (typeof $.CGEventCreateScrollWheelEvent2 === 'undefined') {
    throw fail('UNSUPPORTED', 'CGEventCreateScrollWheelEvent2 is not available (macOS 10.13 or newer is required)');
  }
  var x = num(a.x, 'x');
  var y = num(a.y, 'y');
  var dx = clampInt(a.dx, -500, 500, 0);
  var dy = clampInt(a.dy, -500, 500, 0);
  var lines = clampInt(a.linesPerNotch, 1, 20, 3);
  var p = point(x, y);
  post(mouseEvent(EVENT_MOUSE_MOVED, p, 0, 0, 0));
  sleep(MOVE_SETTLE);
  var n = Math.max(Math.abs(dx), Math.abs(dy));
  for (var i = 0; i < n; i++) {
    // CG wheel deltas are positive for up/left; the driver contract uses dy > 0 = down, dx > 0 = right.
    var wheel1 = i < Math.abs(dy) ? -sign(dy) * lines : 0;
    var wheel2 = i < Math.abs(dx) ? -sign(dx) * lines : 0;
    var e = $.CGEventCreateScrollWheelEvent2(null, SCROLL_UNIT_LINE, 2, wheel1, wheel2, 0);
    if (e !== null && e !== undefined) {
      try {
        $.CGEventSetLocation(e, p);
      } catch (err) {
        /* the cursor is already there */
      }
    }
    post(e);
    sleep(SCROLL_GAP);
  }
  return { x: x, y: y, notches: n };
}

// ---------------------------------------------------------------- keyboard layout

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * The character key `code` types on the active layout with modifier `flags` ('' if none, or
 * a dead key). The plain layer is read from charactersIgnoringModifiers and lower-cased, so
 * Caps Lock does not matter. Other layers are read from `characters`, which follows the
 * layout's Command keymap: Apple's non-Latin layouts and "Dvorak - QWERTY ⌘" switch to a
 * QWERTY keymap while Command is held, which is what apps match Cmd shortcuts against.
 * When `characters` gives nothing for Command alone, the plain layer answers instead, so
 * Command lookups never fall back to US positions (Cmd+A would be Cmd+Q on AZERTY).
 */
function layoutChar(code, flags) {
  var f = flags | 0;
  try {
    var e = $.CGEventCreateKeyboardEvent(null, code, true);
    $.CGEventSetFlags(e, f);
    var ns = $.NSEvent.eventWithCGEvent(e);
    if (isNil(ns)) return '';
    var s = ObjC.unwrap(f ? ns.characters : ns.charactersIgnoringModifiers);
    if ((typeof s !== 'string' || s.length !== 1) && f === FLAG_CMD) s = ObjC.unwrap(ns.charactersIgnoringModifiers);
    if (typeof s !== 'string' || s.length !== 1) return '';
    return (f & FLAG_SHIFT) !== 0 ? s : s.toLowerCase();
  } catch (err) {
    return '';
  }
}

/** Character -> the lowest key code that types it with modifier `flags` on the active layout. */
function buildLayoutMap(flags) {
  var map = {};
  for (var i = 0; i < LAYOUT_CODES.length; i++) {
    var s = layoutChar(LAYOUT_CODES[i], flags);
    if (s && !hasOwn(map, s)) map[s] = LAYOUT_CODES[i];
  }
  return map;
}

function layoutMap(cache, flags) {
  if (!cache.maps) cache.maps = {};
  var k = String(flags | 0);
  if (!hasOwn(cache.maps, k)) cache.maps[k] = buildLayoutMap(flags);
  return cache.maps[k];
}

/** The selected keyboard layout's id from the HIToolbox preferences ('' if unknown). */
function keyboardLayoutFromDefaults() {
  if (typeof $.NSUserDefaults === 'undefined') return '';
  var d = $.NSUserDefaults.alloc.initWithSuiteName('com.apple.HIToolbox');
  if (isNil(d)) return '';
  return str(d.stringForKey('AppleCurrentKeyboardLayoutInputSourceID'));
}

/**
 * The active keyboard layout (under an input method, the layout it types with): its TIS id
 * and whether it is ASCII-capable (null if unknown). Cached in `cache` for one request.
 * Callers pump the run loop first: that is how TIS hears about input source switches.
 */
function keyboardLayout(cache) {
  if (cache && cache.layout) return cache.layout;
  var out = { id: '', ascii: null };
  try {
    importCarbon();
    if (typeof $.TISCopyCurrentKeyboardLayoutInputSource !== 'undefined' && typeof $.TISGetInputSourceProperty !== 'undefined') {
      var src = $.TISCopyCurrentKeyboardLayoutInputSource();
      if (!isNil(src)) {
        var id = tisProperty(src, 'kTISPropertyInputSourceID', TIS_PROP_ID);
        out.id = id === null ? '' : String(id);
        out.ascii = toBool(tisProperty(src, 'kTISPropertyInputSourceIsASCIICapable', TIS_PROP_ASCII));
      }
    }
  } catch (e) {
    /* unknown layout */
  }
  if (!out.id) {
    try {
      out.id = keyboardLayoutFromDefaults();
    } catch (e) {
      out.id = '';
    }
  }
  if (out.ascii === null && NON_ASCII_LAYOUT_RE.test(out.id)) out.ascii = false;
  if (cache) cache.layout = out;
  return out;
}

/**
 * Where the key that types character `ch` is on the active keyboard layout. keys.js sends US
 * ANSI positions, so Cmd+A on AZERTY would otherwise press the key labelled Q.
 *
 * - The lookup uses the layer the key is pressed in: with Command held, the Command keymap.
 *   When the layout is not ASCII-capable or is a "QWERTY ⌘" layout, a Command chord keeps the
 *   US position, which is what those layouts' Command keymaps type.
 * - With `mods` (a chord with a single key), the character may also be found with Shift (German
 *   '/' is Shift+7, AZERTY '1' is Shift+&) or, when no Cmd, Ctrl or Option is held, with Option
 *   (German '@' is Option+L).
 * - A character that is shifted on US ('?', '+') is looked up as itself, and so is a US base
 *   character held with Shift alone ('/' plus Shift for '?'): Shift is then set or cleared for
 *   the key found. Otherwise the chord's own Shift is kept.
 * - In Command and Control chords digits keep their number-row key: system hotkeys
 *   (Cmd+Shift+3) and browsers (Cmd+1) match those by key code.
 * Falls back to `ansiCode` and the chord's modifiers when the layout has no such key.
 * @param {string} ch one character from keys.js ('/' for '?', with Shift in the flags)
 * @param {number} ansiCode the US ANSI key code
 * @param {number} flags the chord's CGEventFlags
 * @param {object} cache shared within one request, so each map is built at most once
 * @param {boolean} [mods] whether Shift and Option may change for this key
 * @returns {{code:number, shift:(boolean|null), alt:boolean}} shift: press with (true) or
 *   without (false) Shift, null keeps the chord's; alt: add Option
 */
function layoutKey(ch, ansiCode, flags, cache, mods) {
  var keep = { code: ansiCode, shift: null, alt: false };
  if (typeof ch !== 'string' || ch.length !== 1 || !HAS_OBJC || typeof $.NSEvent === 'undefined') return keep;
  var c = cache || {};
  var f = flags | 0;
  var cmd = (f & FLAG_CMD) !== 0;
  var held = f & (FLAG_CMD | FLAG_CTRL | FLAG_ALT);
  var want = ch;
  var exact = hasOwn(US_SHIFTED_CHARS, ch);
  if (!exact && mods && !held && (f & FLAG_SHIFT) !== 0 && hasOwn(US_SHIFTED, ch)) {
    want = US_SHIFTED[ch];
    exact = true;
  }
  if (exact && !mods) return keep;
  if (!exact) {
    want = ch.toLowerCase();
    if ((f & (FLAG_CMD | FLAG_CTRL)) !== 0 && want >= '0' && want <= '9') return keep;
  }
  if (cmd) {
    var layout = keyboardLayout(c);
    if (layout.ascii === false || QWERTY_CMD_RE.test(layout.id)) return keep;
  }
  var found = function (code, shift, alt) {
    return { code: code, shift: exact || shift ? shift : null, alt: alt };
  };
  var plain = cmd ? FLAG_CMD : 0;
  if (layoutChar(ansiCode, plain) === want) return found(ansiCode, false, false);
  if (mods && layoutChar(ansiCode, plain | FLAG_SHIFT) === want) return found(ansiCode, true, false);
  var layers = [[plain, false, false]];
  if (mods) layers.push([plain | FLAG_SHIFT, true, false]);
  if (mods && !held) layers.push([FLAG_ALT, false, true], [FLAG_ALT | FLAG_SHIFT, true, true]);
  for (var i = 0; i < layers.length; i++) {
    var map = layoutMap(c, layers[i][0]);
    if (hasOwn(map, want)) return found(map[want], layers[i][1], layers[i][2]);
  }
  return keep;
}

/** Modifier key codes with the modifier `flag` added (as `code`, in keys.js order) or removed. */
function setModifier(codes, code, flag, on) {
  var out = [];
  var present = false;
  for (var i = 0; i < codes.length; i++) {
    if (modifierFlag(codes[i]) === flag) present = true;
    else out.push(codes[i]);
  }
  if (!on) return out;
  if (present) return codes.slice();
  var at = out.length;
  for (var j = 0; j < out.length; j++) {
    if (MODIFIER_RANK[out[j]] > MODIFIER_RANK[code]) {
      at = j;
      break;
    }
  }
  out.splice(at, 0, code);
  return out;
}

function isLayoutChar(ch) {
  return typeof ch === 'string' && ch.length === 1;
}

function cmdKey(a) {
  var codes = intList(a.keyCodes);
  if (!codes.length && a.keyCode !== undefined && a.keyCode !== null) codes = [int(a.keyCode, 'keyCode')];
  if (!codes.length) throw fail('BAD_ARGS', 'keyCode is required');
  var chars = a.chars && typeof a.chars.length === 'number' ? a.chars : [];
  var flags = a.flags | 0;
  var mods = intList(a.modifierKeyCodes);
  var cache = {};
  var byLayout = false;
  for (var j = 0; j < codes.length; j++) byLayout = byLayout || isLayoutChar(chars[j]);
  // The in-process keyboard layout only follows input source switches while the run loop runs.
  if (byLayout && HAS_OBJC && typeof $.NSEvent !== 'undefined') pump(0.01);
  // Shift and Option can only change for the key of a single-key chord.
  var single = codes.length === 1;
  for (var i = 0; i < codes.length; i++) {
    if (!isLayoutChar(chars[i])) continue;
    var k = layoutKey(chars[i], codes[i], flags, cache, single);
    codes[i] = k.code;
    if (k.shift !== null) {
      flags = k.shift ? flags | FLAG_SHIFT : flags & ~FLAG_SHIFT;
      mods = setModifier(mods, KEY_SHIFT, FLAG_SHIFT, k.shift);
    }
    if (k.alt) {
      flags |= FLAG_ALT;
      mods = setModifier(mods, KEY_ALT, FLAG_ALT, true);
    }
  }
  pressCombo(codes, flags, mods);
  return { keys: codes.length };
}

/**
 * Type a plan of steps: {kind:'keys',text} (printable ASCII via System Events
 * keystroke), {kind:'key',keyCode} (a bare key press such as Return or Tab) and
 * {kind:'paste',text} (via the pasteboard and cmd+v). Each paste is given
 * PASTE_SETTLE before the next step, and the pasteboard is restored PASTE_RESTORE
 * (1 s) after the last paste. If System Events is not authorized (Automation),
 * keystroke steps fall back to pasting when args.fallbackPaste is true.
 * Unless args.checkInputSource is false, keystroke steps are pasted when the
 * active input source would garble them (an input method or a non-Latin
 * layout); the result then says fallback 'paste', reason 'input-source'. On a
 * layout that may have dead keys, just the steps containing one of
 * inputSource.deadChars are pasted (reason 'dead-keys').
 */
function cmdType(a) {
  var steps = a.steps && typeof a.steps.length === 'number' ? a.steps : [];
  var total = steps.length;
  var se = null;
  var automationError = null;
  var reason = null;
  var source = null;
  var saved = null;
  var lastChange = null;
  var lastPasteAt = 0;
  var pasted = 0;
  var keystrokes = 0;
  var pasteKey = null;
  if (a.checkInputSource !== false) {
    var hasKeys = false;
    for (var k = 0; k < steps.length && !hasKeys; k++) hasKeys = Boolean(steps[k] && steps[k].kind === 'keys');
    if (hasKeys) {
      source = currentInputSource();
      if (source && source.safe === false) {
        steps = pastePlan(steps);
        reason = 'input-source';
      } else if (source && source.deadChars) {
        var withoutDeadKeys = pasteDeadKeySteps(steps, source.deadChars);
        if (withoutDeadKeys) {
          steps = withoutDeadKeys;
          reason = 'dead-keys';
        }
      }
    }
  }
  try {
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i] || {};
      if (s.kind === 'key') {
        pressCombo([int(s.keyCode, 'keyCode')], 0, []);
        continue;
      }
      var text = s.text === undefined || s.text === null ? '' : String(s.text);
      if (!text) continue;
      if (s.kind === 'keys' && automationError === null) {
        try {
          if (!se) se = systemEvents();
          se.keystroke(text);
          keystrokes++;
          continue;
        } catch (e) {
          var c = classifyError(e);
          if (c.number === -1719 || c.number === -25211) {
            throw fail('PERMISSION', c.message, { perm: 'accessibility' });
          }
          if (!(c.code === 'PERMISSION' && c.perm === 'automation' && a.fallbackPaste)) throw e;
          automationError = c.message;
        }
      } else if (s.kind !== 'keys' && s.kind !== 'paste') {
        throw fail('BAD_ARGS', 'unknown typing step "' + s.kind + '"');
      }
      if (saved === null) saved = saveClipboard();
      lastChange = setClipboardText(text);
      sleep(0.03);
      // Cmd+V by layout, not position: on Dvorak the US-position V key is K. The Command
      // keymap decides, so "Dvorak - QWERTY ⌘" keeps the US position. Pump first: the
      // in-process layout follows input source switches only while the run loop runs.
      if (pasteKey === null) {
        pump(0.01);
        pasteKey = layoutKey('v', KEY_V, FLAG_CMD, {}, false).code;
      }
      pressCombo([pasteKey], FLAG_CMD, [KEY_CMD]);
      lastPasteAt = Date.now();
      pasted++;
      // Let the target app read the pasteboard before anything else happens, including a
      // following Return: the next paste or the restore would change what it reads.
      if (i < steps.length - 1) sleep(PASTE_SETTLE);
    }
  } finally {
    if (saved !== null) {
      var waited = (Date.now() - lastPasteAt) / 1000;
      if (waited < PASTE_RESTORE) sleep(PASTE_RESTORE - waited);
      try {
        restoreClipboard(saved, lastChange);
      } catch (e) {
        /* the paste itself succeeded */
      }
    }
  }
  if (reason === null && automationError !== null) reason = 'automation';
  return {
    steps: total,
    pasted: pasted,
    keystrokes: keystrokes,
    fallback: reason === null ? null : 'paste',
    reason: reason,
    automationError: automationError,
    inputSource: source,
  };
}

/** The active keyboard input source and whether keystrokes are safe with it (null if unreadable). */
function cmdInputSource() {
  return currentInputSource();
}

/**
 * Confirm, or ask for, Automation consent to control System Events with a
 * harmless Apple event. The first time, macOS shows a consent prompt and this
 * blocks until the user answers it, so callers give it a long timeout.
 * granted is true, false (refused) or null (another error).
 */
function cmdAutomation() {
  try {
    var n = systemEvents().processes.length;
    return { granted: true, processes: Number(n) || 0 };
  } catch (e) {
    var c = classifyError(e);
    var out = { granted: c.code === 'PERMISSION' && c.perm === 'automation' ? false : null, error: c.message };
    if (c.number !== null) out.errorNumber = c.number;
    return out;
  }
}

function cmdWindows(a) {
  var front = frontApp();
  var wins = onScreenWindows();
  var ax = null;
  if (a.axTitles !== false) ax = fillTitlesFromAX(wins, a.axBudgetMs);
  return {
    frontPid: front ? front.pid : null,
    frontApp: front ? front.name : '',
    frontBundleId: front ? front.bundleId : '',
    windows: wins,
    ax: ax,
  };
}

function cmdActive(a) {
  var front = frontApp();
  if (!front) return null;
  var win = cgFrontWindow(front.pid);
  var ax = null;
  if (win && !win.title && a.axTitles !== false) ax = fillTitlesFromAX([win], 1000);
  return { pid: front.pid, app: front.name, bundleId: front.bundleId, window: win, ax: ax };
}

function cmdFocus(a) {
  var pid = int(a.pid, 'pid');
  var number = a.number === undefined || a.number === null ? null : int(a.number, 'number');
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (isNil(app)) return { ok: false, reason: 'process ' + pid + ' is not running' };
  var info = number === null ? null : windowInfo(number);
  if (number !== null && info && info.pid !== pid) {
    return { ok: false, reason: 'window ' + number + ' does not belong to process ' + pid };
  }
  var bundlePath = '';
  var bundleId = '';
  var instances = 1;
  try {
    bundleId = str(app.bundleIdentifier);
    var url = app.bundleURL;
    if (!isNil(url)) bundlePath = str(url.path);
  } catch (e) {
    /* informational */
  }
  // Several instances (the dialog's own browser next to the user's): the caller must not
  // fall back to LaunchServices, which activates whichever instance it picks.
  try {
    if (bundleId && $.NSRunningApplication.runningApplicationsWithBundleIdentifier) {
      var running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
      var n = isNil(running) ? 0 : Number(running.count);
      if (n > 0) instances = n;
    }
  } catch (e) {
    /* informational */
  }
  try {
    app.unhide;
  } catch (e) {
    /* not hidden */
  }
  var activated = false;
  try {
    activated = Boolean(app.activateWithOptions(ACTIVATE_IGNORING_OTHER_APPS));
  } catch (e) {
    activated = false;
  }
  var raised = false;
  var axError = null;
  var axPerm = null;
  try {
    var se = systemEvents();
    var proc = axProcess(se, pid);
    try {
      proc.frontmost = true;
    } catch (e) {
      /* activation above may already have worked */
    }
    if (number !== null) {
      var index = findAxWindowIndex(se, pid, info);
      if (index >= 0) {
        var w = proc.windows[index];
        try {
          var minimized = w.attributes.byName('AXMinimized');
          if (minimized.value()) minimized.value = false;
        } catch (e) {
          /* not minimizable */
        }
        w.actions.byName('AXRaise').perform();
        raised = true;
        try {
          w.attributes.byName('AXMain').value = true;
        } catch (e) {
          /* optional */
        }
      }
    }
  } catch (e) {
    var c = classifyError(e);
    axError = c.message;
    axPerm = c.perm;
  }
  var front = null;
  for (var i = 0; i < 6; i++) {
    front = frontApp();
    if (front && front.pid === pid) break;
    pump(0.05);
  }
  return {
    ok: Boolean(front && front.pid === pid),
    activated: activated,
    raised: raised,
    frontPid: front ? front.pid : null,
    bundlePath: bundlePath,
    bundleId: bundleId,
    instances: instances,
    axError: axError,
    axPerm: axPerm,
  };
}

function cmdMinimize(a) {
  var pid = int(a.pid, 'pid');
  var number = int(a.number, 'number');
  var info = windowInfo(number);
  if (!info) return { ok: false, reason: 'window ' + number + ' not found' };
  if (info.pid !== pid) return { ok: false, reason: 'window ' + number + ' does not belong to process ' + pid };
  var se = systemEvents();
  var index = findAxWindowIndex(se, pid, info);
  if (index < 0) return { ok: false, reason: 'no matching accessibility window' };
  axProcess(se, pid).windows[index].attributes.byName('AXMinimized').value = true;
  return { ok: true };
}

/** Press the close button (AXCloseButton) of one window; the app keeps running. */
function cmdClose(a) {
  var pid = int(a.pid, 'pid');
  var number = int(a.number, 'number');
  var info = windowInfo(number);
  if (!info) return { ok: false, reason: 'window ' + number + ' not found' };
  if (info.pid !== pid) return { ok: false, reason: 'window ' + number + ' does not belong to process ' + pid };
  var se = systemEvents();
  var index = findAxWindowIndex(se, pid, info);
  if (index < 0) return { ok: false, reason: 'no matching accessibility window' };
  // JXA element references are callable, so typeof is 'function' (or 'object' in tests).
  var isRef = function (v) {
    return v !== null && v !== undefined && (typeof v === 'object' || typeof v === 'function');
  };
  // Through the unix-id specifier, so the button of this instance of the app is pressed.
  var button = null;
  try {
    var list = axProcess(se, pid).windows[index].buttons.whose({ subrole: 'AXCloseButton' });
    if (list.length) button = list[0];
  } catch (e) {
    button = null;
  }
  // The AXCloseButton attribute returns a reference that names the process by name, so it
  // is only followed when no other process has that name.
  if (!isRef(button) && processNameIsUnique(se, pid)) {
    try {
      button = axProcess(se, pid).windows[index].attributes.byName('AXCloseButton').value();
    } catch (e) {
      button = null;
    }
  }
  if (!isRef(button)) return { ok: false, reason: 'the window has no close button' };
  button.actions.byName('AXPress').perform();
  return { ok: true };
}

// ---------------------------------------------------------------- browser tabs

/** Page text through the browser's own JavaScript bridge (works only where the user allowed it). */
var PAGE_TEXT_JS = "(function(){var b=document.body;return b?String(b.innerText||b.textContent||''):'';})()";
var BROWSER_WINDOW_LIMIT = 30;

/**
 * The scriptable application object of a running browser, found by process id (so the right
 * one of several instances or channels answers) or else by name. Never launches the app.
 */
function browserApplication(a) {
  var target = '';
  var name = str(a.app);
  if (a.pid !== undefined && a.pid !== null && isFinite(Number(a.pid))) {
    var ra = $.NSRunningApplication.runningApplicationWithProcessIdentifier(int(a.pid, 'pid'));
    if (isNil(ra)) throw fail('NOT_FOUND', 'process ' + a.pid + ' is not running');
    target = str(ra.bundleIdentifier);
    if (!name) name = str(ra.localizedName);
  }
  if (!target) target = name;
  if (!target) throw fail('BAD_ARGS', 'browserTab needs the app name or its pid');
  var app = Application(target);
  if (typeof app.running === 'function' && !app.running()) throw fail('NOT_FOUND', name + ' is not running');
  return { app: app, name: name || target };
}

/** The browser window whose title matches the CG window title, else its front window. */
function pickBrowserWindow(app, title, nameOf) {
  var wins = app.windows;
  var count = Number(wins.length) || 0;
  if (count === 0) throw fail('NOT_FOUND', 'the browser has no open window');
  var want = str(title);
  if (want) {
    var n = Math.min(count, BROWSER_WINDOW_LIMIT);
    for (var i = 0; i < n; i++) {
      var name = '';
      try {
        name = String(nameOf(wins[i]) || '');
      } catch (e) {
        name = '';
      }
      if (name && (name === want || want.indexOf(name) === 0)) return { window: wins[i], matched: true };
    }
  }
  return { window: wins[0], matched: false };
}

/**
 * Read the active tab of a browser through its AppleScript dictionary: Chromium browsers
 * (kind "chromium": Chrome, Brave, Edge, Chromium, Vivaldi, Opera, Arc) expose
 * window.activeTab.url()/title(), Safari (kind "safari") window.currentTab / documents.
 * The first call per browser shows macOS's Automation consent prompt and blocks until it is
 * answered; a refusal is error -1743, reported as PERMISSION (perm "automation").
 * With wantText it also tries the page text through the browser's JavaScript bridge, which
 * only works where the user enabled "Allow JavaScript from Apple Events" (textError otherwise).
 */
function cmdBrowserTab(a) {
  var kind = a.kind === 'safari' ? 'safari' : 'chromium';
  var found = browserApplication(a);
  var app = found.app;
  var out = { url: null, title: '', matched: false, text: null, textError: null, app: found.name };
  try {
    var tab;
    var pick;
    if (kind === 'safari') {
      pick = pickBrowserWindow(app, a.title, function (w) {
        return w.name();
      });
      try {
        tab = pick.window.currentTab();
      } catch (e) {
        tab = null;
      }
      if (tab) {
        out.url = str(tab.url());
        out.title = str(tab.name());
      } else {
        var doc = app.documents[0];
        out.url = str(doc.url());
        out.title = str(doc.name());
      }
      if (a.wantText && tab) {
        try {
          out.text = String(app.doJavaScript(PAGE_TEXT_JS, { in: tab }) || '');
        } catch (e) {
          out.textError = errMessage(e);
        }
      }
    } else {
      pick = pickBrowserWindow(app, a.title, function (w) {
        return w.name();
      });
      tab = pick.window.activeTab();
      out.url = str(tab.url());
      out.title = str(tab.title());
      if (a.wantText) {
        try {
          out.text = String(tab.execute({ javascript: PAGE_TEXT_JS }) || '');
        } catch (e) {
          out.textError = errMessage(e);
        }
      }
    }
    out.matched = pick.matched;
  } catch (e) {
    var c = classifyError(e);
    if (c.code === 'PERMISSION') {
      throw fail('PERMISSION', 'not allowed to control ' + found.name + ' (' + c.message + ')', { perm: 'automation', errorNumber: c.number });
    }
    throw e;
  }
  return out;
}

function cmdClipGet() {
  return { text: clipboardText() };
}

function cmdClipSet(a) {
  setClipboardText(a.text === undefined || a.text === null ? '' : String(a.text));
  return { ok: true };
}

// ---------------------------------------------------------------- UI automation (accessibility tree)

/*
 * uiTree, uiFind and uiAction read and drive the accessibility (AX) tree of an app; setBounds
 * moves, resizes, maximizes, minimizes or full-screens a window.
 *
 * Two engines produce the same output:
 * - "ax": the AX C API (HIServices) called through the JXA bridge, in this process. One request
 *   per element (AXUIElementCopyMultipleAttributeValues), so hundreds of nodes take well under
 *   a second, and only the Accessibility permission is needed. How the bridge hands CF values
 *   over (a Ref or an object, attribute names as NSString or JS string, NSArray items) is not
 *   documented, so the first request calibrates each of those against the application element
 *   and its first child, and keeps what works.
 * - "systemEvents": System Events UI element scripting, used when the AX bridge cannot be
 *   calibrated. An Apple event per property list, and it also needs Automation consent.
 *
 * Element ids: mac:<pid>:<window>:<root><path>:<hash>. <window> is the CG window number (i<k>
 * for the k-th AX window when it has none, - for none), <root> is w (the window) or a (the
 * application: its menu bar and open menus), <path> lists child indices from the root, dot
 * separated (v<k>: the k-th visible row or child of a table, outline, list or grid), and <hash>
 * is a short hash of the element's AX role and name. uiAction follows the path; when the
 * element there has another role or name (the window changed), it searches the root for the
 * element with that hash, nearest to where it was (args.frame) and to the old path.
 */

var AX_OK = 0;
var AX_ERR_FAILURE = -25200;
var AX_ERR_INVALID_ELEMENT = -25202;
var AX_ERR_CANNOT_COMPLETE = -25204;
var AX_ERR_ATTRIBUTE_UNSUPPORTED = -25205;
var AX_ERR_ACTION_UNSUPPORTED = -25206;
var AX_ERR_API_DISABLED = -25211;

// Seconds one AX request may wait for the target app (the system default is 6).
var AX_MESSAGING_TIMEOUT = 3;
// Opening a pop-up menu through AXPress can block until the menu closes again.
var AX_POPUP_TIMEOUT = 0.6;
var UI_BUDGET_MS = 8000;
var UI_MAX_BUDGET_MS = 30000;
var UI_RESOLVE_BUDGET_MS = 5000;
var UI_TREE_MAX_VISIT = 8000;
var UI_FIND_MAX_VISIT = 6000;
var UI_MENU_MAX_VISIT = 2500;
var UI_RESOLVE_MAX_VISIT = 5000;
var UI_FIND_MAX_MATCHES = 400;
var UI_RAW_DEPTH = 64;
var UI_FLATTEN_MAX = 40;
var UI_NAME_MAX = 200;
var UI_VALUE_MAX = 500;
var UI_LABEL_MAX = 40;
var UI_PATH_PARTS = 6;
var UI_SPARSE_NODES = 12;
var UI_ENABLE_WAIT = 0.8;
var UI_MENU_WAIT = 0.3;
var UI_SETTLE = 0.05;
var UI_FULLSCREEN_WAIT = 1.0;
var UI_UNMINIMIZE_WAIT = 0.4;
var WINDOW_LIST_ALL = 0; // kCGWindowListOptionAll

var UI_NODE_ATTRS = [
  'AXRole', 'AXSubrole', 'AXTitle', 'AXDescription', 'AXValue', 'AXHelp', 'AXPlaceholderValue',
  'AXPosition', 'AXSize', 'AXEnabled', 'AXFocused', 'AXSelected', 'AXExpanded', 'AXDisclosing', 'AXURL',
  'AXChildren', 'AXVisibleRows', 'AXVisibleChildren', 'AXTitleUIElement'
];
var UI_WINDOW_ATTRS = ['AXTitle', 'AXPosition', 'AXSize'];

// AX role -> the shared role vocabulary (docs/ARCHITECTURE.md §4).
var UI_ROLES = {
  AXButton: 'button', AXMenuButton: 'button', AXDisclosureTriangle: 'button', AXColorWell: 'button', AXDockItem: 'button',
  AXLink: 'link',
  AXTextField: 'textbox', AXTextArea: 'textbox', AXSearchField: 'textbox', AXSecureTextField: 'textbox',
  AXDateField: 'textbox', AXTimeField: 'textbox',
  AXCheckBox: 'checkbox', AXSwitch: 'checkbox',
  AXRadioButton: 'radio',
  AXComboBox: 'combobox', AXPopUpButton: 'combobox',
  AXMenuItem: 'menuitem', AXMenuBarItem: 'menuitem',
  AXMenu: 'menu', AXMenuBar: 'menu',
  AXTab: 'tab', AXTabGroup: 'tablist',
  AXImage: 'image',
  AXStaticText: 'text',
  AXHeading: 'heading',
  AXWindow: 'window', AXSheet: 'window', AXDrawer: 'window',
  AXToolbar: 'toolbar',
  AXGroup: 'group', AXSplitGroup: 'group', AXScrollArea: 'group', AXLayoutArea: 'group', AXLayoutItem: 'group',
  AXRadioGroup: 'group', AXWebArea: 'group', AXList: 'group', AXBrowser: 'group', AXPopover: 'group',
  AXOpaqueProviderGroup: 'group',
  AXTable: 'table', AXOutline: 'table', AXGrid: 'table',
  AXRow: 'row', AXCell: 'cell',
  AXSlider: 'slider', AXIncrementor: 'slider', AXLevelIndicator: 'slider'
};
// Names the model may use for a role filter -> the shared vocabulary.
var UI_ROLE_ALIASES = {
  textfield: 'textbox', 'text field': 'textbox', input: 'textbox', edit: 'textbox', textarea: 'textbox',
  searchfield: 'textbox', 'search field': 'textbox', 'text box': 'textbox',
  statictext: 'text', 'static text': 'text', label: 'text',
  'menu item': 'menuitem', 'check box': 'checkbox', toggle: 'checkbox', 'switch': 'checkbox',
  'radio button': 'radio', radiobutton: 'radio',
  'combo box': 'combobox', popup: 'combobox', 'pop up button': 'combobox', popupbutton: 'combobox',
  dropdown: 'combobox', select: 'combobox',
  'list item': 'listitem', 'tree item': 'treeitem', img: 'image', picture: 'image',
  'tab list': 'tablist', tabs: 'tablist', hyperlink: 'link', anchor: 'link',
  'menu bar': 'menu', menubar: 'menu', grid: 'table', outline: 'table', dialog: 'window', sheet: 'window'
};
// Unnamed containers that uiTree leaves out (their children take their place).
var UI_TRANSPARENT = { AXGroup: 1, AXUnknown: 1, AXLayoutItem: 1, AXSplitGroup: 1, AXScrollArea: 1, AXOpaqueProviderGroup: 1 };
// Roles whose name is their text.
var UI_TEXT_ROLES = { AXStaticText: 1, AXHeading: 1 };
// Roles named by a separate label element (AXTitleUIElement) when they have no title.
var UI_LABELED_ROLES = {
  AXTextField: 1, AXTextArea: 1, AXSearchField: 1, AXComboBox: 1, AXPopUpButton: 1, AXSlider: 1,
  AXIncrementor: 1, AXDateField: 1, AXTimeField: 1, AXCheckBox: 1, AXRadioButton: 1, AXLevelIndicator: 1
};
// Roles whose AXValue is an on/off state, not text.
var UI_STATE_VALUES = { AXRadioButton: 1, AXDisclosureTriangle: 1, AXMenuItem: 1, AXMenuBarItem: 1 };
// Roles whose AXValue matters when System Events could not read the values of a whole list.
var UI_VALUE_ROLES = {
  AXStaticText: 1, AXTextField: 1, AXTextArea: 1, AXComboBox: 1, AXCheckBox: 1, AXRadioButton: 1, AXSlider: 1,
  AXHeading: 1, AXPopUpButton: 1, AXDisclosureTriangle: 1
};
// Containers whose visible part is listed (v<k> path segments).
var UI_VISIBLE_ROWS = { AXTable: 1, AXOutline: 1 };
var UI_VISIBLE_CHILDREN = { AXList: 1, AXGrid: 1 };
// Selected by setting AXSelected when they have no press action.
var UI_SELECTABLE = { AXRow: 1, AXCell: 1, AXStaticText: 1, AXGroup: 1, AXImage: 1 };
var UI_POPUP_ROLES = { AXPopUpButton: 1, AXComboBox: 1, AXMenuButton: 1 };
var UI_PRESS_ACTIONS = ['AXPress', 'AXPick', 'AXConfirm', 'AXOpen'];
var UI_ACTIONS = {
  press: 1, focus: 1, setValue: 1, select: 1, expand: 1, collapse: 1, scrollIntoView: 1, showMenu: 1
};
// Chromium browsers: their web content tree needs AXEnhancedUserInterface (or AXManualAccessibility).
var CHROMIUM_BUNDLE_RE = new RegExp(
  '^(com\\.google\\.Chrome(\\.beta|\\.dev|\\.canary)?|com\\.brave\\.Browser(\\.beta|\\.nightly)?|' +
    'com\\.microsoft\\.edgemac(\\.Beta|\\.Dev|\\.Canary)?|org\\.chromium\\.Chromium|com\\.vivaldi\\.Vivaldi|' +
    'com\\.operasoftware\\.Opera(GX|Next)?|company\\.thebrowser\\.(Browser|dia)|com\\.naver\\.Whale|' +
    'ru\\.yandex\\.desktop\\.yandex-browser|com\\.sidekick\\.Sidekick|net\\.imput\\.helium)$',
  'i'
);
var UI_ID_RE = /^mac:(\d+):(\d+|i\d+|-):([wa])((?:v?\d+)(?:\.v?\d+)*)?:([0-9a-z]+)$/;
var AXV_NUMBER = '(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?)';
var AXV_POINT_RE = new RegExp('\\bx:\\s*' + AXV_NUMBER + '\\s+y:\\s*' + AXV_NUMBER, 'i');
var AXV_SIZE_RE = new RegExp('\\bw:\\s*' + AXV_NUMBER + '\\s+h:\\s*' + AXV_NUMBER, 'i');

var AXS = null;
// Processes whose web content tree this helper switched on (AXManualAccessibility...).
var UI_ENABLED = {};

// ------------------------------------------------ pure helpers (unit-tested in Node)

function uiClean(s, max) {
  if (s === null || s === undefined) return '';
  var t = String(s)
    .replace(/[\s\u00a0\u200b\ufeff]+/g, ' ')
    .replace(/^ +| +$/g, '');
  return max && t.length > max ? t.slice(0, max - 1) + '\u2026' : t;
}

function uiClip(s, max) {
  var t = String(s === null || s === undefined ? '' : s);
  return t.length > max ? t.slice(0, max - 1) + '\u2026' : t;
}

function uiNorm(s) {
  return uiClean(s, 0).toLowerCase();
}

function uiValueText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** The accessible name: title, description, the text of a text role, a label element, a placeholder. */
function uiName(rec) {
  var n = uiClean(rec.title, UI_NAME_MAX) || uiClean(rec.desc, UI_NAME_MAX);
  if (!n && UI_TEXT_ROLES[rec.role] === 1) n = uiClean(uiValueText(rec.value), UI_NAME_MAX);
  if (!n && rec.label) n = uiClean(rec.label, UI_NAME_MAX);
  if (!n && rec.placeholder) n = uiClean(rec.placeholder, UI_NAME_MAX);
  return n;
}

function uiDescription(rec, name) {
  var d = uiClean(rec.desc, UI_NAME_MAX);
  if (d && d !== name) return d;
  var h = uiClean(rec.help, UI_NAME_MAX);
  return h && h !== name ? h : '';
}

/** The shared role of an element; parentRole is the AX role of its parent. */
function uiRole(rec, parentRole) {
  var role = rec.role || '';
  var sub = rec.subrole || '';
  if (sub === 'AXTabButton') return 'tab';
  if (sub === 'AXOutlineRow') return 'treeitem';
  if (sub === 'AXSwitch') return 'checkbox';
  if (role === 'AXRadioButton' && parentRole === 'AXTabGroup') return 'tab';
  if (role === 'AXRow') {
    if (parentRole === 'AXOutline') return 'treeitem';
    if (parentRole === 'AXList') return 'listitem';
    return 'row';
  }
  return hasOwn(UI_ROLES, role) ? UI_ROLES[role] : 'other';
}

function uiValue(rec, name) {
  var role = rec.role;
  if (role === 'AXCheckBox' || role === 'AXSwitch') {
    if (rec.value === null || rec.value === undefined || rec.value === '') return '';
    var c = Number(rec.value);
    return c === 1 ? 'checked' : c === 0 ? 'unchecked' : c === 2 ? 'mixed' : '';
  }
  if (UI_STATE_VALUES[role] === 1) return '';
  if (role === 'AXLink' && rec.url) return uiClip(rec.url, UI_VALUE_MAX);
  var v = uiValueText(rec.value);
  if (!v) return '';
  if (UI_TEXT_ROLES[role] === 1 && uiClean(v, UI_NAME_MAX) === name) return '';
  return uiClip(v, UI_VALUE_MAX);
}

function uiSelected(rec) {
  if (rec.selected === true || rec.selected === false) return rec.selected;
  if (rec.role === 'AXRadioButton' && rec.value !== null && rec.value !== undefined && rec.value !== '') {
    var n = Number(rec.value);
    if (n === 1 || n === 0) return n === 1;
  }
  return undefined;
}

function uiExpanded(rec) {
  if (rec.expanded === true || rec.expanded === false) return rec.expanded;
  if (rec.disclosing === true || rec.disclosing === false) return rec.disclosing;
  if (rec.role === 'AXDisclosureTriangle' && rec.value !== null && rec.value !== undefined && rec.value !== '') {
    var n = Number(rec.value);
    if (n === 1 || n === 0) return n === 1;
  }
  return undefined;
}

function uiRound(n) {
  var v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
}

/** Logical global bounds (points, top-left origin); all zero when the element has no frame. */
function uiBounds(rec) {
  var p = rec.pos;
  var s = rec.size;
  if (!p || !s || !isFinite(p.x) || !isFinite(p.y) || !isFinite(s.w) || !isFinite(s.h)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: uiRound(p.x), y: uiRound(p.y), width: uiRound(Math.max(0, s.w)), height: uiRound(Math.max(0, s.h)) };
}

function uiValidFrame(f) {
  return Boolean(f) && isFinite(f.x) && isFinite(f.y) && f.width > 0 && f.height > 0;
}

function uiNoFrame() {
  return { name: '', x: NaN, y: NaN, width: NaN, height: NaN };
}

/** FNV-1a (32 bit) of a string, base 36. */
function uiHashText(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return (h >>> 0).toString(36);
}

function uiHash(rec, name) {
  return uiHashText((rec.role || '') + '\u0001' + (name === undefined ? uiName(rec) : name));
}

function uiMakeId(pid, winKey, root, path, hash) {
  return 'mac:' + pid + ':' + winKey + ':' + root + path.join('.') + ':' + hash;
}

/** Parse an element id; null if it is not one. */
function uiParseId(id) {
  var m = UI_ID_RE.exec(String(id === null || id === undefined ? '' : id));
  if (!m) return null;
  var pid = Number(m[1]);
  if (!(pid > 0)) return null;
  var win = m[2];
  return {
    id: m[0],
    pid: pid,
    winKey: win,
    number: /^\d+$/.test(win) ? Number(win) : null,
    axIndex: win.charAt(0) === 'i' ? Number(win.slice(1)) : null,
    root: m[3],
    path: m[4] ? m[4].split('.') : [],
    hash: m[5]
  };
}

/** A point from an AXValue description: "<AXValue 0x..> {value = x:10.000000 y:20.000000 type = kAXValueCGPointType}". */
function parseAxPoint(d) {
  var s = String(d || '');
  if (s.indexOf('kAXValueAXErrorType') >= 0) return null;
  var m = AXV_POINT_RE.exec(s);
  if (!m) return null;
  var x = Number(m[1]);
  var y = Number(m[2]);
  return isFinite(x) && isFinite(y) ? { x: x, y: y } : null;
}

/** A size from an AXValue description: "{value = w:300.000000 h:22.000000 type = kAXValueCGSizeType}". */
function parseAxSize(d) {
  var s = String(d || '');
  if (s.indexOf('kAXValueAXErrorType') >= 0) return null;
  var m = AXV_SIZE_RE.exec(s);
  if (!m) return null;
  var w = Number(m[1]);
  var h = Number(m[2]);
  return isFinite(w) && isFinite(h) ? { w: w, h: h } : null;
}

/** 3 = equal, 2 = starts with, 1 = contains, -1 = no match; needle is normalized (uiNorm). */
function uiTextScore(hay, needle, exact) {
  var h = uiNorm(hay);
  if (!h || !needle) return -1;
  if (h === needle) return 3;
  if (exact) return -1;
  if (h.indexOf(needle) === 0) return 2;
  return h.indexOf(needle) >= 0 ? 1 : -1;
}

/** A role filter: {role} in the shared vocabulary (aliases allowed) or {ax} for an AX role or subrole. */
function uiRoleQuery(role) {
  var r = uiNorm(role);
  if (!r) return null;
  if (/^ax[a-z]/.test(r)) return { ax: r };
  return { role: hasOwn(UI_ROLE_ALIASES, r) ? UI_ROLE_ALIASES[r] : r };
}

function uiRoleMatches(q, rec, role) {
  if (!q) return true;
  if (q.ax) return String(rec.role || '').toLowerCase() === q.ax || String(rec.subrole || '').toLowerCase() === q.ax;
  return role === q.role;
}

function uiQuery(a) {
  var q = {
    name: uiNorm(a.name),
    text: uiNorm(a.text),
    role: uiRoleQuery(a.role),
    exact: a.exact === true,
    limit: clampInt(a.limit, 1, 200, 20)
  };
  if (!q.name && !q.text && !q.role) throw fail('BAD_ARGS', 'uiFind needs a name, text or role');
  return q;
}

/** How well an element matches a query (higher is better), or -1. */
function uiMatchScore(rec, name, role, q) {
  if (q.role && !uiRoleMatches(q.role, rec, role)) return -1;
  var score = 0;
  if (q.name) {
    var s = uiTextScore(name, q.name, q.exact);
    if (s < 0) return -1;
    score += s * 10;
  }
  if (q.text) {
    var fields = [name, uiValueText(rec.value), rec.title, rec.desc, rec.help, rec.placeholder, rec.label, rec.url];
    var best = -1;
    for (var i = 0; i < fields.length; i++) {
      var t = uiTextScore(fields[i], q.text, q.exact);
      if (t > best) best = t;
    }
    if (best < 0) return -1;
    score += best * 10;
  }
  if (rec.enabled !== false) score += 2;
  if (rec.size && rec.size.w > 0 && rec.size.h > 0) score += 1;
  return score;
}

function uiTransparent(rec, name) {
  return UI_TRANSPARENT[rec.role] === 1 && !name && !uiValueText(rec.value) && rec.focused !== true;
}

function uiOutside(rec, clip) {
  if (!clip || !rec.pos || !rec.size) return false;
  var x = rec.pos.x;
  var y = rec.pos.y;
  var w = rec.size.w;
  var h = rec.size.h;
  if (!isFinite(x) || !isFinite(y) || !(w > 0) || !(h > 0)) return false;
  return x + w <= clip.x || y + h <= clip.y || x >= clip.x + clip.width || y >= clip.y + clip.height;
}

function uiZeroSize(rec) {
  return Boolean(rec.size) && isFinite(rec.size.w) && isFinite(rec.size.h) && (rec.size.w <= 0 || rec.size.h <= 0);
}

function uiLabel(role, name) {
  return name ? role + ' "' + uiClean(name, UI_LABEL_MAX) + '"' : role;
}

function uiPathText(labels) {
  if (labels.length <= UI_PATH_PARTS) return labels.join(' > ');
  return labels[0] + ' > \u2026 > ' + labels.slice(labels.length - (UI_PATH_PARTS - 1)).join(' > ');
}

function uiTruthy(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'number') return v !== 0;
  var s = String(v === null || v === undefined ? '' : v)
    .replace(/^\s+|\s+$/g, '')
    .toLowerCase();
  if (/^(1|true|on|yes|checked|selected)$/.test(s)) return true;
  if (/^(0|false|off|no|unchecked|unselected)$/.test(s)) return false;
  return null;
}

/**
 * Choose the AX window for a target: an explicit AX index, else the one matching the CG window,
 * else (when the CG window was only a default) the focused one, else the first. -1 if none.
 * @param {{axIndex:(number|null), info:(object|null), explicit:boolean}} t
 * @param {Array<{name:string,x:number,y:number,width:number,height:number}>} frames
 * @param {(Function|object|null)} focused the focused window's frame, or a function returning it
 */
function uiChooseWindow(t, frames, focused) {
  if (t.axIndex !== null && t.axIndex !== undefined) return t.axIndex >= 0 && t.axIndex < frames.length ? t.axIndex : -1;
  if (!frames.length) return -1;
  if (t.info) {
    var i = pickWindowIndex(frames, t.info);
    if (i >= 0 || t.explicit) return i;
  }
  var f = typeof focused === 'function' ? focused() : focused;
  if (f && isFinite(f.x)) {
    var byFrame = -1;
    for (var k = 0; k < frames.length; k++) {
      if (!near(frames[k], f)) continue;
      if (!f.name || frames[k].name === f.name) return k;
      if (byFrame < 0) byFrame = k;
    }
    if (byFrame >= 0) return byFrame;
  }
  return 0;
}

function uiNode(el, path, root, parentRole) {
  return { el: el, path: path, root: root, parentRole: parentRole || '', rec: null };
}

function uiEmptyRec(role) {
  return {
    role: role, subrole: '', title: '', desc: '', value: null, help: '', placeholder: '', url: '', label: '',
    pos: null, size: null, enabled: null, focused: null, selected: null, expanded: null, disclosing: null
  };
}

// ------------------------------------------------ the AX bridge

/** The AX bridge state: what is available, and how the bridge passes values (calibrated once). */
function axState() {
  if (AXS !== null) return AXS;
  AXS = {
    ok: false,
    error: '',
    broken: '',
    attr: null,
    cast: null,
    multi: null,
    listForm: null,
    castMulti: null,
    extract: null,
    form: null,
    names: {},
    lists: {}
  };
  if (!HAS_OBJC) {
    AXS.error = 'the Objective-C bridge is not available';
    return AXS;
  }
  if (typeof Ref === 'undefined') {
    AXS.error = 'JXA references (Ref) are not available';
    return AXS;
  }
  // Normally in the ApplicationServices bridge metadata; bound by name if a macOS release lacks them.
  var needed = [
    ['AXUIElementCreateApplication', ['id', ['int']]],
    ['AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'void *']]],
    ['AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]],
    ['AXUIElementPerformAction', ['int', ['id', 'id']]]
  ];
  for (var i = 0; i < needed.length; i++) {
    var name = needed[i][0];
    if (typeof $[name] === 'undefined' && typeof ObjC.bindFunction === 'function') {
      try {
        ObjC.bindFunction(name, needed[i][1]);
      } catch (e) {
        /* reported below */
      }
    }
    if (typeof $[name] === 'undefined') {
      AXS.error = name + ' is not available through the JXA bridge';
      return AXS;
    }
  }
  AXS.ok = true;
  try {
    // Set on the system-wide element, the limit applies to every element of this process.
    if (typeof $.AXUIElementCreateSystemWide !== 'undefined' && typeof $.AXUIElementSetMessagingTimeout !== 'undefined') {
      $.AXUIElementSetMessagingTimeout($.AXUIElementCreateSystemWide(), AX_MESSAGING_TIMEOUT);
    }
  } catch (e) {
    /* the default timeout applies */
  }
  return AXS;
}

function axBridgeError(message) {
  if (AXS) AXS.broken = message;
  return fail('AX_BRIDGE', 'the accessibility API cannot be used through JXA here: ' + message);
}

/** Throw for AX errors that end the request: no permission, a hung app, a vanished element. */
function axFatal(err, what) {
  if (err === AX_ERR_API_DISABLED) {
    throw fail('PERMISSION', 'macOS Accessibility permission is not granted (the accessibility API refused the request)', {
      perm: 'accessibility',
      errorNumber: err
    });
  }
  if (err === AX_ERR_CANNOT_COMPLETE) {
    throw fail('NOT_RESPONDING', (what || 'the app') + ' is not responding to accessibility requests', { errorNumber: err });
  }
  if (err === AX_ERR_INVALID_ELEMENT) throw fail('GONE', (what || 'the element') + ' no longer exists', { errorNumber: err });
}

/** An attribute or action name in the form the bridge accepts (NSString or JS string). */
function axName(attr) {
  if (AXS.attr === 'js') return attr;
  if (!hasOwn(AXS.names, attr)) AXS.names[attr] = $(attr);
  return AXS.names[attr];
}

/** An element as an argument: as returned by the bridge, or an NSArray item as object or Ref. */
function axArg(el) {
  if (el.native || AXS.form !== 'ref') return el.h;
  return ObjC.castObjectToRef(el.h);
}

/** An out-parameter value as an object ('ref': it came back as a Ref). null for NULL or nil. */
function axCast(raw, mode) {
  if (raw === null || raw === undefined) return null;
  var o = raw;
  if (mode === 'ref') {
    try {
      var c = ObjC.castRefToObject(raw);
      if (c !== null && c !== undefined) o = c;
    } catch (e) {
      o = raw; // already an object
    }
  }
  return isNil(o) ? null : o;
}

function axCopy(el, attr) {
  var out = Ref();
  var err = Number($.AXUIElementCopyAttributeValue(axArg(el), axName(attr), out));
  if (err !== AX_OK) return { err: isFinite(err) ? err : AX_ERR_FAILURE, o: null };
  return { err: AX_OK, o: axCast(out[0], AXS.cast) };
}

/** A JS value for an object: string, number, boolean, array (of objects) or the object itself. */
function axUnwrap(o) {
  if (o === null || o === undefined) return null;
  var t = typeof o;
  if (t === 'string' || t === 'number' || t === 'boolean') return o;
  if (isNil(o)) return null;
  try {
    var v = ObjC.unwrap(o);
    return v === undefined ? o : v;
  } catch (e) {
    return o;
  }
}

function axDescOf(o) {
  if (o === null || o === undefined || typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') return '';
  try {
    return str(o.description);
  } catch (e) {
    return '';
  }
}

/** Whether an attribute value is a "no value" placeholder (an AXValue error or NSNull). */
function axIsMissing(o) {
  if (o === null || o === undefined) return true;
  var d = axDescOf(o);
  return d === '<null>' || d.indexOf('kAXValueAXErrorType') >= 0;
}

/** Call a no-argument method that returns a string-ish object; its JS value or null. */
function axSend(o, method) {
  try {
    var r = o[method];
    if (r === undefined || r === null || isNil(r)) return null;
    return ObjC.unwrap(r);
  } catch (e) {
    return null;
  }
}

function axStr(o) {
  var v = axUnwrap(o);
  return typeof v === 'string' ? v : '';
}

/** A string, a number, a boolean or null; attributed strings, URLs and dates become text. */
function axAny(o) {
  var v = axUnwrap(o);
  if (v === null || v === undefined) return null;
  var t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  if (Object.prototype.toString.call(v) === '[object Array]') return null;
  var d = axDescOf(o);
  if (!d || d === '<null>' || /^<AX(Value|UIElement)\b/.test(d) || d.indexOf('kAXValueAXErrorType') >= 0) return null;
  var s = axSend(o, 'string');
  if (typeof s === 'string') return s;
  s = axSend(o, 'absoluteString');
  if (typeof s === 'string') return s;
  return d;
}

function axText(o) {
  var v = axAny(o);
  return typeof v === 'string' ? v : '';
}

function axBool(o) {
  var v = axUnwrap(o);
  if (v === true || v === false) return v;
  if (typeof v === 'number') return v !== 0;
  return null;
}

function axPoint(o) {
  if (o === null || o === undefined) return null;
  var v = axUnwrap(o);
  if (v && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number') return { x: v.x, y: v.y };
  return parseAxPoint(axDescOf(o));
}

function axSize(o) {
  if (o === null || o === undefined) return null;
  var v = axUnwrap(o);
  if (v && typeof v === 'object' && typeof v.width === 'number' && typeof v.height === 'number') return { w: v.width, h: v.height };
  return parseAxSize(axDescOf(o));
}

function axUrl(o) {
  var v = axUnwrap(o);
  if (typeof v === 'string') return v;
  if (v === null || axIsMissing(o)) return '';
  var s = axSend(o, 'absoluteString');
  return typeof s === 'string' ? s : '';
}

/** NSArray items through count/objectAtIndex (a missing item stays null, so indices hold). */
function axIndexItems(o) {
  var n = 0;
  try {
    n = Number(o.count) || 0;
  } catch (e) {
    n = 0;
  }
  var out = [];
  for (var i = 0; i < n; i++) {
    var item = null;
    try {
      item = o.objectAtIndex(i);
    } catch (e) {
      item = null;
    }
    out.push(item);
  }
  return out;
}

/** The items of an array object as a JS array (or null when it is not an array). */
function axItems(o) {
  if (o === null || o === undefined) return null;
  var v = axUnwrap(o);
  if (Object.prototype.toString.call(v) === '[object Array]') return v;
  if (axIsMissing(o)) return null;
  return axIndexItems(o);
}

/** The elements of an array attribute value, in order; unusable items are null. */
function axElements(o) {
  var out = [];
  if (o === null || o === undefined) return out;
  var items;
  if (AXS.extract === 'index') {
    items = axIndexItems(o);
  } else {
    var v = axUnwrap(o);
    if (Object.prototype.toString.call(v) === '[object Array]') items = v;
    else items = AXS.extract === 'unwrap' || axIsMissing(o) ? [] : axIndexItems(o);
  }
  for (var i = 0; i < items.length; i++) {
    var h = items[i];
    out.push(h === null || h === undefined || isNil(h) ? null : { h: h, native: false });
  }
  return out;
}

function axValueOf(value) {
  if (typeof value === 'boolean') return $.NSNumber.numberWithBool(value);
  if (typeof value === 'number') return $.NSNumber.numberWithDouble(value);
  return $(String(value === null || value === undefined ? '' : value));
}

/** Several attributes in one request: {err, items} (items in order), or null when unavailable. */
function axMulti(el, attrs) {
  if (!AXS.multi) return null;
  var key = attrs.join(',');
  if (!hasOwn(AXS.lists, key)) AXS.lists[key] = AXS.listForm === 'js' ? attrs.slice() : $(attrs);
  var out = Ref();
  var err;
  try {
    err = Number($.AXUIElementCopyMultipleAttributeValues(axArg(el), AXS.lists[key], 0, out));
  } catch (e) {
    return null;
  }
  if (err !== AX_OK) return { err: isFinite(err) ? err : AX_ERR_FAILURE, items: null };
  var items = axItems(axCast(out[0], AXS.castMulti));
  if (!items || items.length !== attrs.length) return null;
  return { err: AX_OK, items: items };
}

/** Attribute values by name (objects; a missing attribute is absent or a placeholder). */
function axRead(el, attrs, what) {
  var vals = {};
  var i;
  var m = axMulti(el, attrs);
  if (m && m.err === AX_OK) {
    for (i = 0; i < attrs.length; i++) vals[attrs[i]] = m.items[i];
    return vals;
  }
  if (m) axFatal(m.err, what);
  for (i = 0; i < attrs.length; i++) {
    var r;
    try {
      r = axCopy(el, attrs[i]);
    } catch (e) {
      r = { err: AX_ERR_FAILURE, o: null };
    }
    if (r.err === AX_OK) vals[attrs[i]] = r.o;
    else if (i === 0) axFatal(r.err, what);
  }
  return vals;
}

/** The text of a label element (AXTitleUIElement). */
function axLabel(o) {
  if (o === null || o === undefined || (typeof o !== 'object' && typeof o !== 'function') || axIsMissing(o)) return '';
  var el = { h: o, native: false };
  try {
    var r = axCopy(el, 'AXValue');
    var t = r.err === AX_OK ? axAny(r.o) : null;
    if (typeof t !== 'string' || !t) {
      r = axCopy(el, 'AXTitle');
      t = r.err === AX_OK ? axAny(r.o) : null;
    }
    return typeof t === 'string' ? t : '';
  } catch (e) {
    return '';
  }
}

/** One element's record (role, names, value, frame, states and its child lists). */
function axRec(el) {
  var v = axRead(el, UI_NODE_ATTRS, null);
  var rec = {
    role: axStr(v.AXRole),
    subrole: axStr(v.AXSubrole),
    title: axText(v.AXTitle),
    desc: axText(v.AXDescription),
    value: hasOwn(v, 'AXValue') ? axAny(v.AXValue) : null,
    help: axText(v.AXHelp),
    placeholder: axText(v.AXPlaceholderValue),
    url: axUrl(v.AXURL),
    label: '',
    pos: axPoint(v.AXPosition),
    size: axSize(v.AXSize),
    enabled: axBool(v.AXEnabled),
    focused: axBool(v.AXFocused),
    selected: axBool(v.AXSelected),
    expanded: axBool(v.AXExpanded),
    disclosing: axBool(v.AXDisclosing),
    kids: hasOwn(v, 'AXChildren') ? v.AXChildren : null,
    visRows: hasOwn(v, 'AXVisibleRows') ? v.AXVisibleRows : null,
    visChildren: hasOwn(v, 'AXVisibleChildren') ? v.AXVisibleChildren : null,
    kidList: null
  };
  if (!rec.title && !rec.desc && UI_LABELED_ROLES[rec.role] === 1 && hasOwn(v, 'AXTitleUIElement')) {
    rec.label = axLabel(v.AXTitleUIElement);
  }
  return rec;
}

function axVisibleList(rec) {
  if (UI_VISIBLE_ROWS[rec.role] === 1) return rec.visRows;
  if (UI_VISIBLE_CHILDREN[rec.role] === 1) return rec.visChildren;
  return null;
}

/** The children uiTree and uiFind walk: the visible rows or children of lists, else AXChildren. */
function axChildList(rec) {
  if (rec.kidList) return rec.kidList;
  var list = null;
  var vis = axVisibleList(rec);
  if (vis) {
    var items = axElements(vis);
    if (items.length) list = { items: items, prefix: 'v' };
  }
  if (!list) list = { items: axElements(rec.kids), prefix: '' };
  rec.kidList = list;
  return list;
}

/**
 * Find out how this bridge passes values, once: attribute names (NSString or JS string) and
 * values (object or Ref) against the application's role, multi-attribute reads, and how array
 * items are taken out (unwrap or objectAtIndex) and passed back (object or Ref) against the
 * application's first child. Throws PERMISSION / NOT_RESPONDING / NOT_FOUND for the app, and
 * AX_BRIDGE when no form works.
 */
function axCalibrate(app, appName) {
  var st = AXS;
  var i;
  var r;
  if (st.attr === null) {
    var combos = [['ns', 'none'], ['ns', 'ref'], ['js', 'none'], ['js', 'ref']];
    var seen = [];
    var found = false;
    for (i = 0; i < combos.length && !found; i++) {
      st.attr = combos[i][0];
      st.cast = combos[i][1];
      try {
        r = axCopy(app, 'AXRole');
      } catch (e) {
        seen.push(st.attr + '/' + st.cast + ': ' + errMessage(e));
        continue;
      }
      if (r.err === AX_ERR_API_DISABLED || r.err === AX_ERR_CANNOT_COMPLETE || r.err === AX_ERR_INVALID_ELEMENT) {
        st.attr = null;
        st.cast = null;
        axFatal(r.err, appName || 'the app');
      }
      if (r.err === AX_OK && axStr(r.o) === 'AXApplication') found = true;
      else seen.push(st.attr + '/' + st.cast + ': ' + (r.err === AX_OK ? 'read ' + JSON.stringify(axStr(r.o)) : 'error ' + r.err));
    }
    if (!found) {
      st.attr = null;
      st.cast = null;
      throw axBridgeError('cannot read attributes (' + seen.join('; ') + ')');
    }
  }
  if (st.multi === null) {
    st.multi = false;
    if (typeof $.AXUIElementCopyMultipleAttributeValues !== 'undefined') {
      var modes = [['ns', 'none'], ['ns', 'ref'], ['js', 'none'], ['js', 'ref']];
      for (i = 0; i < modes.length && !st.multi; i++) {
        st.listForm = modes[i][0];
        st.castMulti = modes[i][1];
        st.lists = {};
        st.multi = true;
        var m = null;
        try {
          m = axMulti(app, ['AXRole', 'AXTitle']);
        } catch (e) {
          m = null;
        }
        if (m && (m.err === AX_ERR_CANNOT_COMPLETE || m.err === AX_ERR_INVALID_ELEMENT)) {
          // The app, not the bridge: read attributes one by one now and calibrate again next time.
          st.multi = null;
          break;
        }
        if (!(m && m.err === AX_OK && axStr(m.items[0]) === 'AXApplication')) st.multi = false;
      }
    }
  }
  if (st.form !== null) return;
  var kids = axCopy(app, 'AXChildren');
  if (kids.err !== AX_OK) {
    axFatal(kids.err, appName || 'the app');
    throw fail('NOT_FOUND', (appName || 'the app') + ' has no accessible windows or menus');
  }
  var cands = [];
  var v = axUnwrap(kids.o);
  if (Object.prototype.toString.call(v) === '[object Array]' && v.length) cands.push(['unwrap', v[0]]);
  try {
    if (kids.o && Number(kids.o.count) > 0) cands.push(['index', kids.o.objectAtIndex(0)]);
  } catch (e) {
    /* not an NSArray object */
  }
  if (!cands.length) throw fail('NOT_FOUND', (appName || 'the app') + ' has no accessible windows or menus');
  var forms = ['obj', 'ref'];
  var busy = false;
  for (i = 0; i < cands.length; i++) {
    for (var f = 0; f < forms.length; f++) {
      st.extract = cands[i][0];
      st.form = forms[f];
      try {
        var rr = axCopy({ h: cands[i][1], native: false }, 'AXRole');
        if (rr.err === AX_OK && /^AX/.test(axStr(rr.o))) return;
        if (rr.err === AX_ERR_CANNOT_COMPLETE) busy = true;
      } catch (e) {
        /* try the next form */
      }
    }
  }
  st.extract = null;
  st.form = null;
  // A hung app proves nothing about the bridge: try again on the next request.
  if (busy) axFatal(AX_ERR_CANNOT_COMPLETE, appName || 'the app');
  throw axBridgeError('cannot use the elements of an array');
}

function axWindowFrame(el) {
  try {
    var v = axRead(el, UI_WINDOW_ATTRS, 'the window');
    var p = axPoint(v.AXPosition);
    var s = axSize(v.AXSize);
    return { name: axText(v.AXTitle), x: p ? p.x : NaN, y: p ? p.y : NaN, width: s ? s.w : NaN, height: s ? s.h : NaN };
  } catch (e) {
    if (e.code === 'PERMISSION' || e.code === 'NOT_RESPONDING') throw e;
    return uiNoFrame();
  }
}

var AX_ENGINE = {
  name: 'ax',
  root: function (ctx, key) {
    if (key === 'w') return ctx.win ? uiNode(ctx.win, [], 'w', '') : null;
    return uiNode(ctx.app, [], 'a', '');
  },
  load: function (ctx, node) {
    if (!node.rec) node.rec = axRec(node.el);
    return node.rec;
  },
  kids: function (ctx, node) {
    var rec = AX_ENGINE.load(ctx, node);
    var list = axChildList(rec);
    var out = [];
    for (var i = 0; i < list.items.length; i++) {
      if (list.items[i]) out.push(uiNode(list.items[i], node.path.concat([list.prefix + i]), node.root, rec.role));
    }
    return out;
  },
  child: function (ctx, node, seg) {
    var rec = AX_ENGINE.load(ctx, node);
    var visible = seg.charAt(0) === 'v';
    var index = Number(visible ? seg.slice(1) : seg);
    var items = axElements(visible ? axVisibleList(rec) : rec.kids);
    if (!(index >= 0 && index < items.length) || !items[index]) return null;
    return uiNode(items[index], node.path.concat([seg]), node.root, rec.role);
  },
  count: function (ctx, node) {
    return axChildList(AX_ENGINE.load(ctx, node)).items.length;
  },
  roleOf: function (ctx, node) {
    return AX_ENGINE.load(ctx, node).role;
  },
  perform: function (ctx, node, action) {
    var err;
    try {
      err = Number($.AXUIElementPerformAction(axArg(node.el), axName(action)));
    } catch (e) {
      return { ok: false, err: AX_ERR_FAILURE, message: errMessage(e) };
    }
    return { ok: err === AX_OK, err: isFinite(err) ? err : AX_ERR_FAILURE };
  },
  set: function (ctx, node, attr, value) {
    var err;
    try {
      err = Number($.AXUIElementSetAttributeValue(axArg(node.el), axName(attr), axValueOf(value)));
    } catch (e) {
      return { ok: false, err: AX_ERR_FAILURE, message: errMessage(e) };
    }
    return { ok: err === AX_OK, err: isFinite(err) ? err : AX_ERR_FAILURE };
  },
  settable: function (ctx, node, attr) {
    if (typeof $.AXUIElementIsAttributeSettable === 'undefined') return null;
    try {
      var out = Ref();
      var err = Number($.AXUIElementIsAttributeSettable(axArg(node.el), axName(attr), out));
      if (err === AX_ERR_ATTRIBUTE_UNSUPPORTED) return false;
      if (err !== AX_OK) return null;
      return axBool(out[0]);
    } catch (e) {
      return null;
    }
  },
  actions: function (ctx, node) {
    if (typeof $.AXUIElementCopyActionNames === 'undefined') return null;
    try {
      var out = Ref();
      var err = Number($.AXUIElementCopyActionNames(axArg(node.el), out));
      if (err === AX_ERR_ACTION_UNSUPPORTED) return [];
      if (err !== AX_OK) return null;
      // A CFArrayRef out-parameter, like the multi-attribute read's.
      var items = axItems(axCast(out[0], AXS.multi ? AXS.castMulti : 'ref'));
      if (!items) return null;
      var names = [];
      for (var i = 0; i < items.length; i++) {
        var s = axStr(items[i]);
        if (s) names.push(s);
      }
      return names;
    } catch (e) {
      return null;
    }
  },
  get: function (ctx, node, attr) {
    try {
      var r = axCopy(node.el, attr);
      return r.err === AX_OK ? axAny(r.o) : null;
    } catch (e) {
      return null;
    }
  },
  appSet: function (ctx, attr, value) {
    return AX_ENGINE.set(ctx, { el: ctx.app }, attr, value).ok;
  },
  activate: function (ctx) {
    uiActivateApp(ctx.pid);
    AX_ENGINE.appSet(ctx, 'AXFrontmost', true);
    if (ctx.win) {
      var w = { el: ctx.win };
      AX_ENGINE.perform(ctx, w, 'AXRaise');
      AX_ENGINE.set(ctx, w, 'AXMain', true);
    }
    return uiWaitFront(ctx.pid);
  },
  timeout: function (ctx, node, seconds) {
    if (typeof $.AXUIElementSetMessagingTimeout === 'undefined') return;
    try {
      $.AXUIElementSetMessagingTimeout(axArg(node.el), seconds);
    } catch (e) {
      /* the global limit applies */
    }
  }
};

// ------------------------------------------------ the System Events engine

var SE_PROPS = ['role', 'subrole', 'name', 'description', 'help', 'value', 'position', 'size', 'enabled', 'focused', 'selected'];

/** Run a System Events getter; undefined on errors other than a missing permission. */
function seGet(fn) {
  try {
    return fn();
  } catch (e) {
    var c = classifyError(e);
    if (c.code === 'PERMISSION') throw fail('PERMISSION', c.message, { perm: c.perm, errorNumber: c.number });
    return undefined;
  }
}

function seBulk(coll, prop) {
  var v = seGet(function () {
    return coll[prop]();
  });
  return Object.prototype.toString.call(v) === '[object Array]' ? v : null;
}

function seS(v) {
  if (typeof v === 'string') return v;
  return typeof v === 'number' ? String(v) : '';
}

function seV(v) {
  var t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean' ? v : null;
}

function seB(v) {
  return v === true || v === false ? v : null;
}

function sePair(v, a, b) {
  if (!v || typeof v.length !== 'number' || v.length < 2) return null;
  var x = Number(v[0]);
  var y = Number(v[1]);
  if (!isFinite(x) || !isFinite(y)) return null;
  var o = {};
  o[a] = x;
  o[b] = y;
  return o;
}

/** A record from System Events properties (get(prop) returns one element's value). */
function seRec(get) {
  var rec = uiEmptyRec(seS(get('role')));
  rec.subrole = seS(get('subrole'));
  rec.title = seS(get('name'));
  rec.desc = seS(get('description'));
  rec.help = seS(get('help'));
  rec.value = seV(get('value'));
  rec.pos = sePair(get('position'), 'x', 'y');
  rec.size = sePair(get('size'), 'w', 'h');
  rec.enabled = seB(get('enabled'));
  rec.focused = seB(get('focused'));
  rec.selected = seB(get('selected'));
  return rec;
}

/** Label and placeholder of an unnamed text field, the same way the AX engine names it. */
function seExtras(rec, spec) {
  if (rec.title || rec.desc || UI_LABELED_ROLES[rec.role] !== 1) return rec;
  var lab = seGet(function () {
    return spec.attributes.byName('AXTitleUIElement').value();
  });
  if (lab && (typeof lab === 'object' || typeof lab === 'function')) {
    var t = seGet(function () {
      return lab.value();
    });
    if (typeof t !== 'string' || !t) {
      t = seGet(function () {
        return lab.name();
      });
    }
    if (typeof t === 'string') rec.label = t;
  }
  if (!rec.label) {
    var ph = seGet(function () {
      return spec.attributes.byName('AXPlaceholderValue').value();
    });
    if (typeof ph === 'string') rec.placeholder = ph;
  }
  return rec;
}

function seError(e) {
  var c = classifyError(e);
  if (c.code === 'PERMISSION') throw fail('PERMISSION', c.message, { perm: c.perm, errorNumber: c.number });
  return { ok: false, err: c.number, message: c.message };
}

var SE_ENGINE = {
  name: 'systemEvents',
  root: function (ctx, key) {
    if (key === 'w') return ctx.win ? uiNode(ctx.win, [], 'w', '') : null;
    var node = uiNode(ctx.proc, [], 'a', '');
    node.rec = uiEmptyRec('AXApplication');
    return node;
  },
  load: function (ctx, node) {
    if (node.rec) return node.rec;
    var spec = node.el;
    var role = seGet(function () {
      return spec.role();
    });
    if (typeof role !== 'string' || !role) throw fail('GONE', 'the element no longer exists');
    var rec = seRec(function (prop) {
      return prop === 'role'
        ? role
        : seGet(function () {
            return spec[prop]();
          });
    });
    node.rec = seExtras(rec, spec);
    return node.rec;
  },
  kids: function (ctx, node) {
    var parent = SE_ENGINE.load(ctx, node);
    var coll = node.el.uiElements;
    var roles = seBulk(coll, 'role');
    if (!roles || !roles.length) return [];
    var cols = { role: roles };
    for (var p = 1; p < SE_PROPS.length; p++) {
      var col = seBulk(coll, SE_PROPS[p]);
      cols[SE_PROPS[p]] = col && col.length === roles.length ? col : null;
    }
    if (!cols.description) {
      var alt = seBulk(coll, 'accessibilityDescription');
      cols.description = alt && alt.length === roles.length ? alt : null;
    }
    var out = [];
    for (var i = 0; i < roles.length; i++) {
      var spec = coll[i];
      var rec = seRec(function (prop) {
        return cols[prop] ? cols[prop][i] : undefined;
      });
      if (!cols.value && UI_VALUE_ROLES[rec.role] === 1) {
        rec.value = seV(
          seGet(function () {
            return spec.value();
          })
        );
      }
      var kid = uiNode(spec, node.path.concat([String(i)]), node.root, parent.role);
      kid.rec = seExtras(rec, spec);
      out.push(kid);
    }
    return out;
  },
  child: function (ctx, node, seg) {
    if (!/^\d+$/.test(seg)) return null;
    return uiNode(node.el.uiElements[Number(seg)], node.path.concat([seg]), node.root, '');
  },
  count: function (ctx, node) {
    var n = seGet(function () {
      return node.el.uiElements.length;
    });
    return typeof n === 'number' ? n : -1;
  },
  roleOf: function (ctx, node) {
    if (node.rec) return node.rec.role;
    var r = seGet(function () {
      return node.el.role();
    });
    return typeof r === 'string' ? r : '';
  },
  perform: function (ctx, node, action) {
    try {
      node.el.actions.byName(action).perform();
      return { ok: true, err: null };
    } catch (e) {
      return seError(e);
    }
  },
  set: function (ctx, node, attr, value) {
    try {
      node.el.attributes.byName(attr).value = value;
      return { ok: true, err: null };
    } catch (e) {
      return seError(e);
    }
  },
  settable: function (ctx, node, attr) {
    var v = seGet(function () {
      return node.el.attributes.byName(attr).settable();
    });
    return v === true || v === false ? v : null;
  },
  actions: function (ctx, node) {
    var v = seGet(function () {
      return node.el.actions.name();
    });
    if (Object.prototype.toString.call(v) !== '[object Array]') return null;
    var names = [];
    for (var i = 0; i < v.length; i++) if (typeof v[i] === 'string' && v[i]) names.push(v[i]);
    return names;
  },
  get: function (ctx, node, attr) {
    return seV(
      seGet(function () {
        return node.el.attributes.byName(attr).value();
      })
    );
  },
  appSet: function (ctx, attr, value) {
    try {
      ctx.proc.attributes.byName(attr).value = value;
      return true;
    } catch (e) {
      return false;
    }
  },
  activate: function (ctx) {
    uiActivateApp(ctx.pid);
    try {
      ctx.proc.frontmost = true;
    } catch (e) {
      /* activation above may already have worked */
    }
    if (ctx.win) {
      try {
        ctx.win.actions.byName('AXRaise').perform();
      } catch (e) {
        /* not raisable */
      }
    }
    return uiWaitFront(ctx.pid);
  },
  timeout: function () {
    /* System Events keeps its own limits */
  }
};

// ------------------------------------------------ targets and contexts

function uiActivateApp(pid) {
  try {
    var ra = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if (isNil(ra)) return false;
    try {
      ra.unhide;
    } catch (e) {
      /* not hidden */
    }
    return Boolean(ra.activateWithOptions(ACTIVATE_IGNORING_OTHER_APPS));
  } catch (e) {
    return false;
  }
}

function uiWaitFront(pid) {
  for (var i = 0; i < 6; i++) {
    var f = frontApp();
    if (f && f.pid === pid) return true;
    pump(0.05);
  }
  return false;
}

/** The frontmost normal (layer 0, visible) CG window of a process, or null. */
function cgFrontWindow(pid) {
  var wins = onScreenWindows();
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i];
    if (w.pid === pid && w.layer === 0 && w.alpha > 0 && w.width > 1 && w.height > 1) return w;
  }
  return null;
}

/** The CG window number of a process's window with this frame (on any Space), or null. */
function cgNumberFor(pid, frame) {
  if (!uiValidFrame(frame)) return null;
  var all = readWindowList(WINDOW_LIST_ALL, NULL_WINDOW_ID);
  for (var i = 0; i < all.length; i++) {
    var w = all[i];
    if (w.pid === pid && w.layer === 0 && near(w, frame)) return w.number;
  }
  return null;
}

function fileExists(p) {
  try {
    return Boolean($.NSFileManager.defaultManager.fileExistsAtPath($(p)));
  } catch (e) {
    return false;
  }
}

/**
 * The app and window a UI request is about: args pid (default: the frontmost app) and number (a
 * CG window) or axIndex (an AX window); with neither, the app's frontmost window.
 */
function uiTarget(a) {
  var t = { pid: null, number: null, axIndex: null, info: null, explicit: false, app: '', bundleId: '', bundlePath: '' };
  if (a.pid !== undefined && a.pid !== null && a.pid !== '') {
    t.pid = int(a.pid, 'pid');
  } else {
    var front = frontApp();
    if (!front) throw fail('NOT_FOUND', 'no app is active');
    t.pid = front.pid;
  }
  var ra = $.NSRunningApplication.runningApplicationWithProcessIdentifier(t.pid);
  if (isNil(ra)) throw fail('NOT_FOUND', 'process ' + t.pid + ' is not running');
  try {
    t.app = str(ra.localizedName);
    t.bundleId = str(ra.bundleIdentifier);
    var url = ra.bundleURL;
    if (!isNil(url)) t.bundlePath = str(url.path);
  } catch (e) {
    /* informational */
  }
  if (a.number !== undefined && a.number !== null && a.number !== '') {
    t.number = int(a.number, 'number');
    t.explicit = true;
    t.info = windowInfo(t.number);
    if (!t.info) throw fail('NOT_FOUND', 'window ' + t.number + ' was not found (it may have been closed)');
    if (t.info.pid !== t.pid) throw fail('NOT_FOUND', 'window ' + t.number + ' does not belong to process ' + t.pid);
  } else if (a.axIndex !== undefined && a.axIndex !== null && a.axIndex !== '') {
    t.axIndex = int(a.axIndex, 'axIndex');
    t.explicit = true;
  } else {
    t.info = cgFrontWindow(t.pid);
    if (t.info) t.number = t.info.number;
  }
  return t;
}

/** Fill ctx.win, winKey, frame and window ({id, app, title}) from the chosen AX window. */
function uiSetWindow(ctx, t, idx, winEl, frames) {
  if (idx < 0 || !winEl) {
    if (t.explicit) {
      throw fail(
        'NOT_FOUND',
        'no accessibility window of ' + (t.app || 'process ' + t.pid) + ' matches window ' + (t.number !== null ? t.number : 'i' + t.axIndex)
      );
    }
    ctx.win = null;
    ctx.winKey = '-';
    ctx.frame = null;
    ctx.window = { id: String(t.pid), app: t.app, title: '' };
    return;
  }
  var frame = frames[idx];
  var number = t.info && (t.explicit || near(frame, t.info)) ? t.info.number : cgNumberFor(t.pid, frame);
  ctx.win = winEl;
  ctx.winKey = number !== null && number !== undefined ? String(number) : 'i' + idx;
  ctx.frame = uiValidFrame(frame) ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : null;
  var title = frame.name || (t.info && number === t.info.number ? t.info.title : '') || '';
  ctx.window = { id: number !== null && number !== undefined ? t.pid + ':' + number : String(t.pid), app: t.app, title: title };
}

function axOpen(t) {
  var st = axState();
  if (!st.ok) throw axBridgeError(st.error);
  if (st.broken) throw fail('AX_BRIDGE', 'the accessibility API cannot be used through JXA here: ' + st.broken);
  var h = null;
  try {
    h = $.AXUIElementCreateApplication(t.pid);
  } catch (e) {
    throw axBridgeError('AXUIElementCreateApplication failed: ' + errMessage(e));
  }
  if (h === null || h === undefined || isNil(h)) throw fail('NOT_FOUND', 'process ' + t.pid + ' has no accessibility element');
  var app = { h: h, native: true };
  axCalibrate(app, t.app);
  var ctx = { eng: AX_ENGINE, pid: t.pid, app: app, win: null, target: t };
  var w = axCopy(app, 'AXWindows');
  if (w.err !== AX_OK) axFatal(w.err, t.app || 'the app');
  var wins = w.err === AX_OK ? axElements(w.o) : [];
  var frames = [];
  for (var i = 0; i < wins.length; i++) frames.push(wins[i] ? axWindowFrame(wins[i]) : uiNoFrame());
  var idx = uiChooseWindow(t, frames, function () {
    var f = axCopy(app, 'AXFocusedWindow');
    if (f.err !== AX_OK || axIsMissing(f.o)) return null;
    return axWindowFrame({ h: f.o, native: false });
  });
  uiSetWindow(ctx, t, idx, idx >= 0 ? wins[idx] : null, frames);
  return ctx;
}

function seOpen(t) {
  var se;
  try {
    se = systemEvents();
  } catch (e) {
    throw fail('UNSUPPORTED', 'System Events is not available: ' + errMessage(e));
  }
  var frames;
  try {
    frames = axWindowFrames(se, t.pid);
  } catch (e) {
    var c = classifyError(e);
    if (c.code === 'PERMISSION') throw fail('PERMISSION', c.message, { perm: c.perm, errorNumber: c.number });
    if (c.code === 'NOT_FOUND') throw fail('NOT_FOUND', (t.app || 'process ' + t.pid) + ' is not known to System Events (' + c.message + ')');
    throw e;
  }
  var proc = axProcess(se, t.pid);
  var ctx = { eng: SE_ENGINE, pid: t.pid, se: se, proc: proc, win: null, target: t };
  var idx = uiChooseWindow(t, frames, frames.length ? frames[0] : null);
  uiSetWindow(ctx, t, idx, idx >= 0 ? proc.windows[idx] : null, frames);
  return ctx;
}

/**
 * Open the target with the AX engine (or System Events when the AX bridge is unusable, or when
 * args.engine says so) and run fn(ctx).
 */
function uiWithContext(a, fn) {
  if (typeof $.AXIsProcessTrusted !== 'undefined') {
    var trusted = null;
    try {
      trusted = Boolean($.AXIsProcessTrusted());
    } catch (e) {
      trusted = null;
    }
    if (trusted === false) throw fail('PERMISSION', 'macOS Accessibility permission is not granted', { perm: 'accessibility' });
  }
  var t = uiTarget(a);
  var want = a.engine === 'systemEvents' || a.engine === 'se' ? 'se' : a.engine === 'ax' ? 'ax' : 'auto';
  var ctx = null;
  var bridgeError = '';
  if (want !== 'se') {
    try {
      ctx = axOpen(t);
    } catch (e) {
      if (e.code !== 'AX_BRIDGE' || want === 'ax') throw e;
      bridgeError = errMessage(e);
    }
  }
  if (!ctx) ctx = seOpen(t);
  ctx.bridgeError = bridgeError;
  try {
    return fn(ctx);
  } catch (e) {
    if (e && e.code === 'GONE') throw fail('NOT_FOUND', errMessage(e) + '; find it again (ui_find or ui_tree)');
    throw e;
  }
}

function uiLoad(ctx, node, st) {
  try {
    return ctx.eng.load(ctx, node);
  } catch (e) {
    if (e.code === 'PERMISSION') throw e;
    if (e.code === 'NOT_RESPONDING') {
      if (!st) throw e;
      st.notResponding = true;
      st.stop = true;
    }
    return null;
  }
}

function uiKids(ctx, node, st) {
  try {
    return ctx.eng.kids(ctx, node);
  } catch (e) {
    if (e.code === 'PERMISSION') throw e;
    if (e.code === 'NOT_RESPONDING') {
      if (!st) throw e;
      st.notResponding = true;
      st.stop = true;
    }
    return [];
  }
}

function uiCount(ctx, node) {
  try {
    return ctx.eng.count(ctx, node);
  } catch (e) {
    return -1;
  }
}

function uiNodeId(ctx, node, rec, name) {
  return uiMakeId(ctx.pid, ctx.winKey, node.root, node.path, uiHash(rec, name));
}

/** Where uiTree and uiFind look: the window and open menus (main), and the menu bar. */
function uiRoots(ctx) {
  var eng = ctx.eng;
  var out = { main: [], menuBars: [] };
  if (ctx.win) out.main.push({ node: eng.root(ctx, 'w'), clip: ctx.frame });
  var kids = uiKids(ctx, eng.root(ctx, 'a'), null);
  for (var i = 0; i < kids.length; i++) {
    var rec = uiLoad(ctx, kids[i], null);
    if (!rec) continue;
    if (rec.role === 'AXMenu') out.main.push({ node: kids[i], clip: null });
    else if (rec.role === 'AXMenuBar') out.menuBars.push({ node: kids[i], clip: null });
  }
  return out;
}

// ------------------------------------------------ uiTree

/**
 * The children of a node as uiTree shows them: unnamed groups are replaced by their children,
 * zero-size leaves and elements outside the window (scrolled away) are left out.
 */
function uiVisibleKids(ctx, node, st, clip) {
  var out = [];
  var stack = [{ list: uiKids(ctx, node, st), i: 0 }];
  while (stack.length) {
    if (st.visited >= st.maxVisit || Date.now() > st.deadline) {
      st.truncated = true;
      st.stop = true;
      break;
    }
    var top = stack[stack.length - 1];
    if (top.i >= top.list.length) {
      stack.pop();
      continue;
    }
    var kid = top.list[top.i++];
    var rec = uiLoad(ctx, kid, st);
    st.visited++;
    if (st.stop) break;
    if (!rec || !rec.role) continue;
    var count = null;
    if (rec.role === 'AXWebArea') {
      st.webAreas++;
      count = uiCount(ctx, kid);
      if (count === 0) st.webAreaEmpty = true;
    }
    if (clip && uiOutside(rec, clip)) continue;
    var name = uiName(rec);
    if (uiTransparent(rec, name)) {
      if (stack.length < UI_FLATTEN_MAX) stack.push({ list: uiKids(ctx, kid, st), i: 0 });
      continue;
    }
    if (uiZeroSize(rec) && (count === null ? uiCount(ctx, kid) : count) === 0) continue;
    out.push(kid);
  }
  return out;
}

function uiEmit(ctx, node, parent, st) {
  var rec = node.rec;
  var name = uiName(rec);
  var out = { id: uiNodeId(ctx, node, rec, name), role: uiRole(rec, node.parentRole), name: name };
  var value = uiValue(rec, name);
  if (value) out.value = value;
  var d = uiDescription(rec, name);
  if (d) out.description = d;
  out.bounds = uiBounds(rec);
  out.enabled = rec.enabled !== false;
  out.focused = rec.focused === true;
  var sel = uiSelected(rec);
  if (sel !== undefined) out.selected = sel;
  var ex = uiExpanded(rec);
  if (ex !== undefined) out.expanded = ex;
  out.parent = parent ? parent.id : null;
  out.children = [];
  st.nodes.push(out);
  if (parent) parent.children.push(out.id);
  return out;
}

/** Breadth first from the window (and open menus): up to depth output levels and maxNodes nodes. */
function uiBuildTree(ctx, a) {
  var depthMax = clampInt(a.depth, 0, 50, 6);
  var maxNodes = clampInt(a.maxNodes, 1, 5000, 400);
  var st = {
    nodes: [],
    truncated: false,
    stop: false,
    visited: 0,
    webAreas: 0,
    webAreaEmpty: false,
    notResponding: false,
    maxVisit: UI_TREE_MAX_VISIT,
    deadline: Date.now() + clampInt(a.budgetMs, 300, UI_MAX_BUDGET_MS, UI_BUDGET_MS)
  };
  var roots = uiRoots(ctx);
  var list = roots.main.slice();
  if (!ctx.win) list = list.concat(roots.menuBars);
  var queue = [];
  for (var r = 0; r < list.length && st.nodes.length < maxNodes; r++) {
    var rec = uiLoad(ctx, list[r].node, null);
    if (!rec) {
      if (list[r].node.root === 'w') throw fail('NOT_FOUND', 'the window was closed');
      continue;
    }
    st.visited++;
    queue.push({ node: list[r].node, out: uiEmit(ctx, list[r].node, null, st), depth: 0, clip: list[r].clip });
  }
  var qi = 0;
  while (qi < queue.length && !st.stop) {
    var item = queue[qi++];
    if (item.depth >= depthMax) {
      if (!st.truncated && uiCount(ctx, item.node) > 0) st.truncated = true;
      continue;
    }
    var kids = uiVisibleKids(ctx, item.node, st, item.clip);
    for (var k = 0; k < kids.length; k++) {
      if (st.nodes.length >= maxNodes) {
        st.truncated = true;
        st.stop = true;
        break;
      }
      queue.push({ node: kids[k], out: uiEmit(ctx, kids[k], item.out, st), depth: item.depth + 1, clip: item.clip });
    }
  }
  return st;
}

// ------------------------------------------------ uiFind

/**
 * Depth first, in document order, from each root ({node, clip?, labels?, depth?});
 * visit(node, rec, name, role, labels) returns false to stop. labels is the readable path of
 * non-transparent ancestors and the node. With st.deferred (an array), elements outside their
 * root's clip (scrolled out of the window) are not entered but added to it, for a later walk.
 */
function uiWalk(ctx, roots, st, visit) {
  for (var r = 0; r < roots.length && !st.stop; r++) {
    var stack = [{ node: roots[r].node, labels: roots[r].labels || [], depth: roots[r].depth || 0, clip: roots[r].clip || null }];
    while (stack.length) {
      if (st.visited >= st.maxVisit || Date.now() > st.deadline) {
        st.truncated = true;
        st.stop = true;
        break;
      }
      var item = stack.pop();
      var rec = uiLoad(ctx, item.node, st);
      st.visited++;
      if (st.stop) break;
      if (!rec || !rec.role) continue;
      if (st.skipAppWindows && item.depth === 1 && rec.role === 'AXWindow') continue;
      if (st.deferred && item.clip && item.depth > 0 && uiOutside(rec, item.clip)) {
        st.deferred.push({ node: item.node, labels: item.labels, depth: item.depth, clip: null });
        continue;
      }
      var name = uiName(rec);
      var role = uiRole(rec, item.node.parentRole);
      if (rec.role === 'AXWebArea') {
        st.webAreas = (st.webAreas || 0) + 1;
        if (uiCount(ctx, item.node) === 0) st.webAreaEmpty = true;
      }
      var labels = uiTransparent(rec, name) ? item.labels : item.labels.concat([uiLabel(role, name)]);
      if (visit(item.node, rec, name, role, labels) === false) {
        st.stop = true;
        break;
      }
      if (item.depth >= UI_RAW_DEPTH) continue;
      var kids = uiKids(ctx, item.node, st);
      for (var k = kids.length - 1; k >= 0; k--) stack.push({ node: kids[k], labels: labels, depth: item.depth + 1, clip: item.clip });
    }
  }
}

function uiFindResult(ctx, m) {
  var rec = m.rec;
  var out = {
    id: uiNodeId(ctx, m.node, rec, m.name),
    role: m.role,
    name: m.name,
    value: uiValue(rec, m.name),
    bounds: uiBounds(rec),
    enabled: rec.enabled !== false,
    path: uiPathText(m.labels)
  };
  var d = uiDescription(rec, m.name);
  if (d) out.description = d;
  return out;
}

/**
 * Matches in what the window shows and the app's open menus, then in the parts of the window
 * scrolled out of view, then (for menu queries, or when nothing matched) in the menu bar.
 */
function uiFindIn(ctx, q, a) {
  var budget = clampInt(a.budgetMs, 300, UI_MAX_BUDGET_MS, UI_BUDGET_MS);
  var st = {
    visited: 0,
    deadline: Date.now() + budget,
    maxVisit: UI_FIND_MAX_VISIT,
    stop: false,
    truncated: false,
    webAreas: 0,
    webAreaEmpty: false,
    notResponding: false,
    deferred: []
  };
  var roots = uiRoots(ctx);
  var found = [];
  var order = 0;
  var collect = function (penalty) {
    return function (node, rec, name, role, labels) {
      var s = uiMatchScore(rec, name, role, q);
      if (s >= 0) found.push({ node: node, rec: rec, name: name, role: role, labels: labels, score: s - penalty, order: order++ });
      return found.length < UI_FIND_MAX_MATCHES;
    };
  };
  uiWalk(ctx, roots.main, st, collect(0));
  var hidden = st.deferred;
  st.deferred = null;
  // Scrolled out of view: after what is visible, and a little lower (it needs scrolling first).
  if (hidden.length && found.length < q.limit && !st.stop) uiWalk(ctx, hidden, st, collect(1));
  var menus = Boolean(q.role && (q.role.role === 'menuitem' || q.role.role === 'menu' || /^axmenu/.test(q.role.ax || '')));
  if (roots.menuBars.length && !st.notResponding && (menus || !found.length || !ctx.win)) {
    var st2 = {
      visited: 0,
      deadline: Math.max(st.deadline, Date.now() + 1500),
      maxVisit: UI_MENU_MAX_VISIT,
      stop: false,
      truncated: false
    };
    uiWalk(ctx, roots.menuBars, st2, collect(menus || !ctx.win ? 0 : 5));
  }
  found.sort(function (x, y) {
    return y.score - x.score || x.order - y.order;
  });
  var matches = [];
  for (var i = 0; i < found.length && matches.length < q.limit; i++) matches.push(uiFindResult(ctx, found[i]));
  return { matches: matches, stats: st };
}

// ------------------------------------------------ web content trees (Chromium, Electron)

/** 'chromium' (a Chromium browser), 'electron' (an Electron app) or ''. */
function uiAppKind(t) {
  if (t.kind !== undefined) return t.kind;
  var kind = '';
  if (CHROMIUM_BUNDLE_RE.test(t.bundleId || '')) kind = 'chromium';
  else if (t.bundlePath && fileExists(t.bundlePath + '/Contents/Frameworks/Electron Framework.framework')) kind = 'electron';
  t.kind = kind;
  return kind;
}

/**
 * Whether the tree looks like web content whose accessibility is switched off: an empty web
 * area, or a Chromium or Electron window with no web area and next to nothing in it.
 */
function uiSparse(ctx, st) {
  if (st.webAreaEmpty) return true;
  return uiAppKind(ctx.target) !== '' && !st.webAreas && st.visited < UI_SPARSE_NODES;
}

/**
 * Ask a Chromium browser or an Electron app to build its web content tree: AXManualAccessibility
 * (Electron, recent Chromium) and, for Chromium browsers, AXEnhancedUserInterface (what VoiceOver
 * sets). Once per process per helper. Returns what was enabled ('chromium', 'electron', 'app') or ''.
 */
function uiEnableApp(ctx) {
  var key = String(ctx.pid);
  if (UI_ENABLED[key]) return '';
  UI_ENABLED[key] = true;
  var kind = uiAppKind(ctx.target);
  var any = ctx.eng.appSet(ctx, 'AXManualAccessibility', true);
  if (kind === 'chromium') any = ctx.eng.appSet(ctx, 'AXEnhancedUserInterface', true) || any;
  if (!any) return '';
  sleep(UI_ENABLE_WAIT);
  return kind || 'app';
}

// ------------------------------------------------ uiAction

function uiErrText(r) {
  if (r && r.message) return ' (' + r.message + ')';
  return r && r.err !== null && r.err !== undefined ? ' (error ' + r.err + ')' : '';
}

/** Throw for action results that must not fall back to clicking: no permission, element gone. */
function uiCheck(r) {
  if (!r || r.ok) return;
  if (r.err === AX_ERR_API_DISABLED) axFatal(r.err);
  if (r.err === AX_ERR_INVALID_ELEMENT) {
    throw fail('NOT_FOUND', 'the element no longer exists; find it again (ui_find or ui_tree)', { errorNumber: r.err });
  }
}

function uiRoleText(node) {
  return uiRole(node.rec, node.parentRole);
}

/**
 * Whether an action opens a menu: AppKit tracks the menu inside the action handler, so the app
 * answers only once the menu closes, and the request is given a short time limit instead.
 */
function uiOpensMenu(node, action) {
  if (action === 'AXShowMenu') return true;
  var role = node.rec ? node.rec.role : '';
  return action === 'AXPress' && (UI_POPUP_ROLES[role] === 1 || role === 'AXMenuBarItem');
}

function uiPerform(ctx, node, action) {
  var r;
  if (uiOpensMenu(node, action)) {
    ctx.eng.timeout(ctx, node, AX_POPUP_TIMEOUT);
    try {
      r = ctx.eng.perform(ctx, node, action);
    } finally {
      ctx.eng.timeout(ctx, node, AX_MESSAGING_TIMEOUT);
    }
  } else {
    r = ctx.eng.perform(ctx, node, action);
  }
  if (r.ok) return { ok: true, method: action };
  uiCheck(r);
  if (r.err === AX_ERR_CANNOT_COMPLETE) {
    // Typically the action opened a modal dialog or a menu, which keeps the app from answering.
    return { ok: true, method: action, confirmed: false, reason: 'the app did not confirm in time; it may be showing a dialog or menu' };
  }
  return { ok: false, method: 'none', reason: action + ' failed on this ' + uiRoleText(node) + uiErrText(r) };
}

function uiSetSelected(ctx, node) {
  var r = ctx.eng.set(ctx, node, 'AXSelected', true);
  uiCheck(r);
  return r.ok ? { ok: true, method: 'AXSelected' } : { ok: false, method: 'none', reason: 'AXSelected cannot be set' + uiErrText(r) };
}

function uiPress(ctx, node) {
  var names = ctx.eng.actions(ctx, node);
  if (names === null) return uiPerform(ctx, node, 'AXPress');
  for (var i = 0; i < UI_PRESS_ACTIONS.length; i++) {
    if (names.indexOf(UI_PRESS_ACTIONS[i]) >= 0) return uiPerform(ctx, node, UI_PRESS_ACTIONS[i]);
  }
  if (UI_SELECTABLE[node.rec.role] === 1 && ctx.eng.settable(ctx, node, 'AXSelected') === true) {
    var s = uiSetSelected(ctx, node);
    if (s.ok) return s;
  }
  return {
    ok: false,
    method: 'none',
    reason: 'this ' + uiRoleText(node) + ' has no press action' + (names.length ? ' (it supports ' + names.join(', ') + ')' : '')
  };
}

function uiFocus(ctx, node) {
  var rec = node.rec;
  var front = ctx.eng.activate(ctx);
  if (rec.role === 'AXWindow' || rec.role === 'AXSheet' || rec.role === 'AXDrawer') {
    return front ? { ok: true, method: 'AXRaise' } : { ok: false, method: 'AXRaise', reason: 'the app did not come to the front' };
  }
  var r = ctx.eng.set(ctx, node, 'AXFocused', true);
  uiCheck(r);
  if (!r.ok) return { ok: false, method: 'none', reason: 'the element cannot take keyboard focus' + uiErrText(r) };
  // Keyboard input only reaches it once its app is frontmost.
  if (!front) return { ok: false, method: 'AXFocused', reason: 'the app did not come to the front' };
  return { ok: true, method: 'AXFocused' };
}

function uiSetValue(ctx, node, value) {
  var eng = ctx.eng;
  var rec = node.rec;
  if (value === undefined || value === null) throw fail('BAD_ARGS', 'setValue needs a value');
  if (rec.role === 'AXCheckBox' || rec.role === 'AXRadioButton' || rec.role === 'AXSwitch') {
    var want = uiTruthy(value);
    if (want === null) throw fail('BAD_ARGS', 'a ' + uiRoleText(node) + ' takes true or false (got "' + value + '")');
    if ((Number(rec.value) === 1) === want) return { ok: true, method: 'unchanged' };
    if (rec.role === 'AXRadioButton' && !want) {
      return { ok: false, method: 'none', reason: 'a radio button is turned off by choosing another one' };
    }
    return uiPress(ctx, node);
  }
  if (rec.subrole === 'AXSecureTextField') return { ok: false, method: 'none', reason: 'password fields must be typed into' };
  if (eng.settable(ctx, node, 'AXValue') === false) {
    return { ok: false, method: 'none', reason: 'the value of this ' + uiRoleText(node) + ' cannot be set directly' };
  }
  var numeric = typeof rec.value === 'number' && String(value) !== '' && isFinite(Number(value));
  var v = numeric ? Number(value) : String(value);
  var r = eng.set(ctx, node, 'AXValue', v);
  uiCheck(r);
  if (!r.ok) return { ok: false, method: 'none', reason: 'setting the value failed' + uiErrText(r) };
  sleep(UI_SETTLE);
  var now = eng.get(ctx, node, 'AXValue');
  if (numeric) {
    if (typeof now === 'number' && isFinite(now)) {
      // Sliders and steppers snap to their steps: report what they took.
      return Math.abs(now - v) < 1e-9 ? { ok: true, method: 'AXValue' } : { ok: true, method: 'AXValue', value: now };
    }
    return { ok: true, method: 'AXValue', confirmed: false };
  }
  var got = uiValueText(now).replace(/\r\n?/g, '\n');
  if (got !== v.replace(/\r\n?/g, '\n')) {
    return { ok: false, method: 'AXValue', reason: 'the app did not keep the value (it reads back as ' + JSON.stringify(uiClip(got, 80)) + ')' };
  }
  return { ok: true, method: 'AXValue' };
}

/** Open a pop-up button, combo box or menu button; ok when it opened or probably did. */
function uiOpenPopup(ctx, node) {
  var r = uiPerform(ctx, node, 'AXShowMenu');
  if (!r.ok) r = uiPerform(ctx, node, 'AXPress');
  if (!r.ok) r.reason = 'the pop-up did not open' + (r.reason ? ': ' + r.reason : '');
  return r;
}

/** The menu item named `want` (normalized) under node, or in the app's open menus. */
function uiFindMenuItem(ctx, node, want) {
  var best = null;
  var visit = function (n, rec, name) {
    if (rec.role !== 'AXMenuItem') return true;
    var s = uiTextScore(name, want, false);
    if (s > 0 && (!best || s > best.s)) best = { node: n, s: s };
    return !(best && best.s === 3);
  };
  // A fresh node: its children are read again, now that the menu is open.
  var fresh = uiNode(node.el, node.path, node.root, node.parentRole);
  uiWalk(ctx, [{ node: fresh }], { visited: 0, deadline: Date.now() + 3000, maxVisit: 800, stop: false }, visit);
  if (!best || best.s < 3) {
    var roots = uiRoots(ctx);
    var menus = [];
    for (var i = 0; i < roots.main.length; i++) if (roots.main[i].node.root === 'a') menus.push(roots.main[i]);
    uiWalk(ctx, menus, { visited: 0, deadline: Date.now() + 3000, maxVisit: 800, stop: false }, visit);
  }
  return best ? best.node : null;
}

function uiSelectOption(ctx, node, label) {
  var rec = node.rec;
  if (rec.role === 'AXComboBox' && ctx.eng.settable(ctx, node, 'AXValue') !== false) {
    var sv = uiSetValue(ctx, node, label);
    if (sv.ok) return sv;
  }
  if (ctx.eng.name !== 'ax') {
    return { ok: false, method: 'none', reason: 'choosing an option needs the accessibility API; press the pop-up, then the option' };
  }
  var opened = uiOpenPopup(ctx, node);
  if (!opened.ok) return opened;
  sleep(UI_MENU_WAIT);
  var item = uiFindMenuItem(ctx, node, uiNorm(label));
  if (!item) {
    ctx.eng.perform(ctx, node, 'AXCancel');
    return { ok: false, method: 'none', reason: 'the pop-up has no option named "' + label + '"' };
  }
  var p = uiPerform(ctx, item, 'AXPress');
  if (p.ok) p.method = 'menu';
  return p;
}

function uiSelect(ctx, node, value) {
  var rec = node.rec;
  if (value !== undefined && value !== null && String(value) !== '' && UI_POPUP_ROLES[rec.role] === 1) {
    return uiSelectOption(ctx, node, String(value));
  }
  if (rec.role === 'AXRadioButton' || rec.role === 'AXMenuItem' || rec.role === 'AXMenuBarItem' || rec.subrole === 'AXTabButton') {
    return uiPress(ctx, node);
  }
  if (ctx.eng.settable(ctx, node, 'AXSelected') !== false) {
    var s = uiSetSelected(ctx, node);
    if (s.ok) return s;
  }
  var names = ctx.eng.actions(ctx, node);
  if (names && names.indexOf('AXPick') >= 0) return uiPerform(ctx, node, 'AXPick');
  if (names && names.indexOf('AXPress') >= 0) return uiPerform(ctx, node, 'AXPress');
  return { ok: false, method: 'none', reason: 'this ' + uiRoleText(node) + ' cannot be selected' };
}

function uiExpand(ctx, node, open) {
  var eng = ctx.eng;
  var rec = node.rec;
  if (uiExpanded(rec) === open) return { ok: true, method: 'unchanged' };
  var attrs = [['AXExpanded', rec.expanded], ['AXDisclosing', rec.disclosing]];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i][1] !== true && attrs[i][1] !== false) continue;
    var r = eng.set(ctx, node, attrs[i][0], open);
    uiCheck(r);
    if (r.ok) return { ok: true, method: attrs[i][0] };
  }
  if (rec.role === 'AXDisclosureTriangle') return uiPerform(ctx, node, 'AXPress');
  if (UI_POPUP_ROLES[rec.role] === 1) return open ? uiOpenPopup(ctx, node) : uiPerform(ctx, node, 'AXCancel');
  // A disclosure triangle among the children (outline rows, disclosure groups).
  var kids = uiKids(ctx, node, null);
  for (var k = 0; k < kids.length; k++) {
    var kr = uiLoad(ctx, kids[k], null);
    if (!kr || kr.role !== 'AXDisclosureTriangle') continue;
    if (uiExpanded(kr) === open) return { ok: true, method: 'unchanged' };
    var p = uiPerform(ctx, kids[k], 'AXPress');
    if (p.ok) p.method = 'AXDisclosureTriangle';
    return p;
  }
  return { ok: false, method: 'none', reason: 'this ' + uiRoleText(node) + ' cannot be ' + (open ? 'expanded' : 'collapsed') };
}

function uiDo(ctx, node, action, value) {
  if (/^AX[A-Za-z]+$/.test(action)) return uiPerform(ctx, node, action);
  switch (action) {
    case 'press':
      return uiPress(ctx, node);
    case 'focus':
      return uiFocus(ctx, node);
    case 'setValue':
      return uiSetValue(ctx, node, value);
    case 'select':
      return uiSelect(ctx, node, value);
    case 'expand':
      return uiExpand(ctx, node, true);
    case 'collapse':
      return uiExpand(ctx, node, false);
    case 'scrollIntoView':
      return uiPerform(ctx, node, 'AXScrollToVisible');
    case 'showMenu':
      return uiPerform(ctx, node, 'AXShowMenu');
    default:
      throw fail('BAD_ARGS', 'unknown UI action "' + action + '"');
  }
}

/** How close a search candidate is to the element an id named: frame first, then path. */
function uiResolveScore(node, rec, p, frame) {
  var prefix = 0;
  while (prefix < node.path.length && prefix < p.path.length && node.path[prefix] === p.path[prefix]) prefix++;
  var score = prefix * 10 - Math.abs(node.path.length - p.path.length);
  if (uiValidFrame(frame)) {
    var b = uiBounds(rec);
    var dist = 1e6;
    if (b.width > 0 && b.height > 0) {
      var dx = b.x + b.width / 2 - (frame.x + frame.width / 2);
      var dy = b.y + b.height / 2 - (frame.y + frame.height / 2);
      dist = Math.sqrt(dx * dx + dy * dy);
    }
    score -= dist * 1000;
  }
  return score;
}

/**
 * The element an id names: by its path when the element there still has the id's role and
 * name, else by searching its root for that role and name (nearest to `frame`, the bounds
 * uiFind reported, and to the old path). Throws NOT_FOUND when it is gone or ambiguous.
 */
function uiResolve(ctx, p, frame) {
  var eng = ctx.eng;
  var root = eng.root(ctx, p.root);
  if (!root) throw fail('NOT_FOUND', 'the window of this element was closed; find it again (ui_find or ui_tree)');
  var node = root;
  var prev = null;
  for (var i = 0; i < p.path.length && node; i++) {
    var next = null;
    try {
      next = eng.child(ctx, node, p.path[i]);
    } catch (e) {
      if (e.code === 'PERMISSION' || e.code === 'NOT_RESPONDING') throw e;
      next = null;
    }
    prev = node;
    node = next;
  }
  if (node) {
    var rec = uiLoad(ctx, node, null);
    if (rec && rec.role && uiHash(rec) === p.hash) {
      if (prev) node.parentRole = eng.roleOf(ctx, prev);
      return { node: node, how: 'path' };
    }
  }
  var best = null;
  var second = null;
  var st = { visited: 0, deadline: Date.now() + UI_RESOLVE_BUDGET_MS, maxVisit: UI_RESOLVE_MAX_VISIT, stop: false, skipAppWindows: p.root === 'a' };
  uiWalk(ctx, [{ node: eng.root(ctx, p.root) }], st, function (n, r2, name) {
    if (uiHash(r2, name) !== p.hash) return true;
    var c = { node: n, score: uiResolveScore(n, r2, p, frame) };
    if (!best || c.score > best.score) {
      second = best;
      best = c;
    } else if (!second || c.score > second.score) {
      second = c;
    }
    return true;
  });
  if (!best) throw fail('NOT_FOUND', 'the element is no longer there (the window changed or closed); find it again (ui_find or ui_tree)');
  if (second && second.score === best.score && !uiValidFrame(frame)) {
    throw fail('NOT_FOUND', 'the window changed and several elements now match this id; find it again (ui_find or ui_tree)');
  }
  return { node: best.node, how: 'search' };
}

// ------------------------------------------------ commands

/**
 * Args for another walk after switching a web content tree on, with what is left of a total time
 * of twice the budget (so the request stays within the driver's timeout); null when none is left.
 */
function uiRetryArgs(a, end) {
  var left = end - Date.now();
  if (left < 500) return null;
  var b = {};
  for (var k in a) {
    if (hasOwn(a, k)) b[k] = a[k];
  }
  b.budgetMs = left;
  return b;
}

function uiTotalEnd(a) {
  return Date.now() + 2 * clampInt(a.budgetMs, 300, UI_MAX_BUDGET_MS, UI_BUDGET_MS);
}

function cmdUiTree(a) {
  return uiWithContext(a, function (ctx) {
    var end = uiTotalEnd(a);
    var st = uiBuildTree(ctx, a);
    var enabled = '';
    if (uiSparse(ctx, st)) {
      enabled = uiEnableApp(ctx);
      for (var i = 0; enabled && i < 2; i++) {
        var again = uiRetryArgs(a, end);
        if (!again) break;
        st = uiBuildTree(ctx, again);
        if (!uiSparse(ctx, st)) break;
        if (i === 0) sleep(UI_ENABLE_WAIT);
      }
    }
    var out = { window: ctx.window, nodes: st.nodes, truncated: st.truncated, engine: ctx.eng.name, visited: st.visited };
    if (enabled) out.enabledAccessibility = enabled;
    if (uiSparse(ctx, st)) out.sparse = true;
    if (st.notResponding) out.notResponding = true;
    if (ctx.bridgeError) out.bridgeError = ctx.bridgeError;
    return out;
  });
}

function cmdUiFind(a) {
  var q = uiQuery(a);
  return uiWithContext(a, function (ctx) {
    var end = uiTotalEnd(a);
    var r = uiFindIn(ctx, q, a);
    var enabled = '';
    if (!r.matches.length && uiSparse(ctx, r.stats)) {
      enabled = uiEnableApp(ctx);
      for (var i = 0; enabled && i < 2; i++) {
        var again = uiRetryArgs(a, end);
        if (!again) break;
        r = uiFindIn(ctx, q, again);
        if (r.matches.length || !uiSparse(ctx, r.stats)) break;
        if (i === 0) sleep(UI_ENABLE_WAIT);
      }
    }
    var out = { window: ctx.window, matches: r.matches, truncated: r.stats.truncated, engine: ctx.eng.name, visited: r.stats.visited };
    if (enabled) out.enabledAccessibility = enabled;
    if (uiSparse(ctx, r.stats)) out.sparse = true;
    if (r.stats.notResponding) out.notResponding = true;
    if (ctx.bridgeError) out.bridgeError = ctx.bridgeError;
    return out;
  });
}

/**
 * Act on an element: {id, action, value?, frame?} -> {ok, method, reason?, confirmed?, id,
 * resolved: 'path'|'search', role, name, bounds, windowId}. ok false (with a reason) means the
 * action is not available on that element, so the caller may click it instead.
 */
function cmdUiAction(a) {
  var p = uiParseId(a.id);
  if (!p) throw fail('BAD_ARGS', 'not a macOS UI element id: ' + a.id);
  var action = String(a.action || '');
  if (UI_ACTIONS[action] !== 1 && !/^AX[A-Za-z]+$/.test(action)) {
    throw fail('BAD_ARGS', 'unknown UI action "' + action + '" (use press, focus, setValue, select, expand, collapse, scrollIntoView or showMenu)');
  }
  // Menu bar ids do not depend on a window.
  var t = { pid: p.pid, engine: a.engine };
  if (p.root === 'w') {
    if (p.number !== null) t.number = p.number;
    else if (p.axIndex !== null) t.axIndex = p.axIndex;
    else throw fail('BAD_ARGS', 'not a macOS UI element id: ' + a.id);
  }
  return uiWithContext(t, function (ctx) {
    var found = uiResolve(ctx, p, a.frame);
    var node = found.node;
    var res = uiDo(ctx, node, action, a.value);
    var name = uiName(node.rec);
    res.id = uiNodeId(ctx, node, node.rec, name);
    res.resolved = found.how;
    res.role = uiRole(node.rec, node.parentRole);
    res.name = name;
    res.bounds = uiBounds(node.rec);
    res.windowId = ctx.window.id;
    return res;
  });
}

// ------------------------------------------------ window bounds

function flipRect(r, primaryHeight) {
  return { x: r.x, y: primaryHeight - (r.y + r.height), width: r.width, height: r.height };
}

/** Every screen's full and visible (without menu bar and Dock) frame, top-left origin. */
function screenFrames() {
  pump(0.01);
  var screens = $.NSScreen.screens;
  var n = isNil(screens) ? 0 : Number(screens.count);
  var out = [];
  var primaryHeight = 0;
  for (var i = 0; i < n; i++) {
    var s = screens.objectAtIndex(i);
    var f = rectOf(s.frame);
    var v = f;
    try {
      v = rectOf(s.visibleFrame);
    } catch (e) {
      v = f;
    }
    if (i === 0) primaryHeight = f.height;
    out.push({ full: flipRect(f, primaryHeight), visible: flipRect(v, primaryHeight) });
  }
  return out;
}

/** The visible frame of the screen that holds most of `rect` (its centre first). */
function visibleFrameFor(rect, screens) {
  if (!screens.length) return null;
  if (!uiValidFrame(rect)) return screens[0].visible;
  var cx = rect.x + rect.width / 2;
  var cy = rect.y + rect.height / 2;
  var i;
  for (i = 0; i < screens.length; i++) {
    var f = screens[i].full;
    if (cx >= f.x && cx < f.x + f.width && cy >= f.y && cy < f.y + f.height) return screens[i].visible;
  }
  var best = 0;
  var bestArea = -1;
  for (i = 0; i < screens.length; i++) {
    var g = screens[i].full;
    var w = Math.min(rect.x + rect.width, g.x + g.width) - Math.max(rect.x, g.x);
    var h = Math.min(rect.y + rect.height, g.y + g.height) - Math.max(rect.y, g.y);
    var area = w > 0 && h > 0 ? w * h : 0;
    if (area > bestArea) {
      bestArea = area;
      best = i;
    }
  }
  return screens[best].visible;
}

function seWindowFrame(w) {
  var pos = seGet(function () {
    return w.position();
  });
  var size = seGet(function () {
    return w.size();
  });
  var p = sePair(pos, 'x', 'y');
  var s = sePair(size, 'width', 'height');
  return p && s ? { x: p.x, y: p.y, width: s.width, height: s.height } : null;
}

function seWindowFlag(w, attr) {
  var v = seGet(function () {
    return w.attributes.byName(attr).value();
  });
  return v === true || v === 1;
}

/**
 * Move and resize a window to `target` ({x, y, width, height}, integers). The size is set again
 * after the move when the old position constrained it, and the position again when resizing
 * moved it. AXEnhancedUserInterface (Chromium with accessibility on) animates and misplaces
 * moves, so it is off meanwhile.
 */
function seSetFrame(proc, w, target) {
  var eui = null;
  try {
    eui = proc.attributes.byName('AXEnhancedUserInterface').value();
  } catch (e) {
    eui = null;
  }
  if (eui === true) {
    try {
      proc.attributes.byName('AXEnhancedUserInterface').value = false;
    } catch (e) {
      eui = null;
    }
  }
  try {
    var x = Math.round(target.x);
    var y = Math.round(target.y);
    var width = Math.round(target.width);
    var height = Math.round(target.height);
    w.position = [x, y];
    w.size = [width, height];
    var now = seWindowFrame(w);
    if (now && (Math.abs(now.width - width) > 2 || Math.abs(now.height - height) > 2)) {
      w.size = [width, height];
      now = seWindowFrame(w);
    }
    if (now && (Math.abs(now.x - x) > 2 || Math.abs(now.y - y) > 2)) {
      w.position = [x, y];
      now = seWindowFrame(w);
    }
    return now;
  } finally {
    if (eui === true) {
      try {
        proc.attributes.byName('AXEnhancedUserInterface').value = true;
      } catch (e) {
        /* best effort */
      }
    }
  }
}

function optNum(v) {
  return v === undefined || v === null || v === '' ? null : num(v, 'bounds');
}

/**
 * {pid, number?, state?: 'maximize'|'minimize'|'restore'|'fullscreen', x?, y?, width?, height?,
 * frame? (restore to it)} -> {ok, state, before, frame, reason?}. Through System Events, like
 * focus and minimize. Maximize fills the visible frame of the window's screen.
 */
function cmdSetBounds(a) {
  var pid = int(a.pid, 'pid');
  var number = a.number === undefined || a.number === null ? null : int(a.number, 'number');
  var info = number === null ? cgFrontWindow(pid) : windowInfo(number);
  if (number !== null && !info) return { ok: false, reason: 'window ' + number + ' not found' };
  if (info && info.pid !== pid) return { ok: false, reason: 'window ' + number + ' does not belong to process ' + pid };
  var state = a.state ? String(a.state) : '';
  if (state && state !== 'maximize' && state !== 'minimize' && state !== 'restore' && state !== 'fullscreen') {
    throw fail('BAD_ARGS', 'unknown window state "' + state + '" (use maximize, minimize, restore or fullscreen)');
  }
  var want = { x: optNum(a.x), y: optNum(a.y), width: optNum(a.width), height: optNum(a.height) };
  if (!state && want.x === null && want.y === null && want.width === null && want.height === null) {
    throw fail('BAD_ARGS', 'setBounds needs x, y, width, height or a state');
  }
  var se = systemEvents();
  var index = findAxWindowIndex(se, pid, info);
  if (index < 0) return { ok: false, reason: 'no matching accessibility window' };
  var proc = axProcess(se, pid);
  var w = proc.windows[index];
  var before = seWindowFrame(w);
  var out = { ok: true, state: state || 'bounds', before: before, frame: null };
  if (state === 'minimize') {
    w.attributes.byName('AXMinimized').value = true;
    out.frame = before;
    return out;
  }
  if (seWindowFlag(w, 'AXMinimized')) {
    w.attributes.byName('AXMinimized').value = false;
    sleep(UI_UNMINIMIZE_WAIT);
  }
  var full = seWindowFlag(w, 'AXFullScreen');
  if (state === 'fullscreen') {
    if (!full) {
      try {
        w.attributes.byName('AXFullScreen').value = true;
      } catch (e) {
        var c = classifyError(e);
        if (c.code === 'PERMISSION') throw fail('PERMISSION', c.message, { perm: c.perm, errorNumber: c.number });
        // Older apps: the green title bar button.
        var button = null;
        try {
          var list = w.buttons.whose({ subrole: 'AXFullScreenButton' });
          if (list.length) button = list[0];
        } catch (e2) {
          button = null;
        }
        if (!button) return { ok: false, state: state, before: before, frame: before, reason: 'the window cannot go full screen' };
        button.actions.byName('AXPress').perform();
      }
    }
    out.frame = seWindowFrame(w);
    return out;
  }
  if (full) {
    w.attributes.byName('AXFullScreen').value = false;
    sleep(UI_FULLSCREEN_WAIT);
    before = seWindowFrame(w) || before;
  }
  var target = null;
  if (state === 'maximize') {
    target = visibleFrameFor(before || info, screenFrames());
  } else if (state === 'restore') {
    target = a.frame && uiValidFrame(a.frame) ? a.frame : null;
  } else {
    var base = before || { x: NaN, y: NaN, width: NaN, height: NaN };
    target = {
      x: want.x !== null ? want.x : base.x,
      y: want.y !== null ? want.y : base.y,
      width: want.width !== null ? want.width : base.width,
      height: want.height !== null ? want.height : base.height
    };
    if (!uiValidFrame(target)) {
      return { ok: false, state: out.state, before: before, frame: before, reason: 'the window frame could not be read; give x, y, width and height' };
    }
  }
  out.frame = target ? seSetFrame(proc, w, target) : seWindowFrame(w);
  return out;
}

var COMMANDS = {
  ping: cmdPing,
  perms: cmdPerms,
  requestPerms: cmdRequestPerms,
  displays: cmdDisplays,
  cursor: cmdCursor,
  move: cmdMove,
  click: cmdClick,
  down: function (a) {
    return cmdButton(a, true);
  },
  up: function (a) {
    return cmdButton(a, false);
  },
  drag: cmdDrag,
  scroll: cmdScroll,
  key: cmdKey,
  type: cmdType,
  inputSource: cmdInputSource,
  automation: cmdAutomation,
  windows: cmdWindows,
  active: cmdActive,
  focus: cmdFocus,
  minimize: cmdMinimize,
  close: cmdClose,
  browserTab: cmdBrowserTab,
  uiTree: cmdUiTree,
  uiFind: cmdUiFind,
  uiAction: cmdUiAction,
  setBounds: cmdSetBounds,
  clipGet: cmdClipGet,
  clipSet: cmdClipSet,
  exit: function () {
    return { bye: true };
  },
};

/** Run one request object; never throws. */
function dispatch(req) {
  var id = req && req.id !== undefined ? req.id : null;
  var cmd = req && req.cmd;
  if (typeof cmd !== 'string' || !Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) {
    return { id: id, ok: false, error: 'unknown command "' + cmd + '"', code: 'UNKNOWN_COMMAND' };
  }
  var args = req.args && typeof req.args === 'object' ? req.args : {};
  try {
    var result = COMMANDS[cmd](args);
    return { id: id, ok: true, result: result === undefined ? null : result };
  } catch (e) {
    return errorResponse(id, e);
  }
}

function handleLine(line) {
  var req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    return { id: null, ok: false, error: 'bad request JSON: ' + errMessage(e), code: 'BAD_REQUEST' };
  }
  return dispatch(req);
}

// ---------------------------------------------------------------- stdio

var STDOUT = null;

function writeLine(obj) {
  if (STDOUT === null) STDOUT = $.NSFileHandle.fileHandleWithStandardOutput;
  STDOUT.writeData($(asciiJson(obj) + '\n').dataUsingEncoding(UTF8_ENCODING));
}

function decodeChunk(data) {
  var s = $.NSString.alloc.initWithDataEncoding(data, UTF8_ENCODING);
  if (isNil(s)) s = $.NSString.alloc.initWithDataEncoding(data, LATIN1_ENCODING);
  return isNil(s) ? '' : str(s);
}

function serve() {
  var input = $.NSFileHandle.fileHandleWithStandardInput;
  var info = cmdPing();
  writeLine({ id: 0, ok: true, result: { ready: true, version: HELPER_VERSION, pid: info.pid, os: info.os, importErrors: IMPORT_ERRORS } });
  var pending = '';
  for (;;) {
    var chunk;
    try {
      // Blocks until bytes arrive; empty data means end of file.
      chunk = decodeChunk(input.availableData);
    } catch (e) {
      return;
    }
    if (!chunk) return;
    pending += chunk;
    var nl = pending.indexOf('\n');
    while (nl >= 0) {
      var line = pending.slice(0, nl).replace(/^\s+|\s+$/g, '');
      pending = pending.slice(nl + 1);
      if (line) {
        var resp = handleLine(line);
        try {
          writeLine(resp);
        } catch (e) {
          return; // the reader is gone
        }
        if (resp.ok && resp.result && resp.result.bye) return;
      }
      nl = pending.indexOf('\n');
    }
  }
}

/** osascript entry point. */
// eslint-disable-next-line no-unused-vars
function run(argv) {
  if (!HAS_OBJC) return;
  var args = argv && typeof argv.length === 'number' ? argv : [];
  if (args[0] === 'serve') {
    serve();
    return;
  }
  var parsed = {};
  if (args.length > 1 && args[1]) {
    try {
      parsed = JSON.parse(String(args[1]));
    } catch (e) {
      writeLine({ id: null, ok: false, error: 'bad JSON arguments: ' + errMessage(e), code: 'BAD_REQUEST' });
      return;
    }
  }
  writeLine(dispatch({ id: null, cmd: args[0] === undefined ? 'ping' : String(args[0]), args: parsed }));
}
