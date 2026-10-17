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
 * Written in conservative ES5 style. It only touches ObjC, $ and Application
 * when they exist, so Node can syntax-check it and unit-test it with fakes.
 */

/* global ObjC, $, Application */

var HELPER_VERSION = 1;
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

// Timings in seconds.
var KEY_GAP = 0.008;
var PRESS_GAP = 0.012;
var MULTI_CLICK_GAP = 0.04;
var MOVE_SETTLE = 0.02;
var DRAG_HOLD = 0.06;
var DRAG_STEP_GAP = 0.012;
var SCROLL_GAP = 0.015;
var PASTE_SETTLE = 0.15;
var PASTE_RESTORE = 0.3;
var AX_TITLE_BUDGET_MS = 2500;
var AX_TITLE_MAX_APPS = 12;

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

/** Name and frame of every accessibility window of a process (3 Apple events). */
function axWindowFrames(se, pid) {
  var p = axProcess(se, pid);
  var names = p.windows.name();
  var pos = p.windows.position();
  var size = p.windows.size();
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

/** The System Events window of a process that matches a CG window (frame first, then title). */
function findAxWindow(proc, info) {
  var wins = proc.windows();
  if (!wins || !wins.length) return null;
  if (!info) return wins[0];
  var byFrame = null;
  var byTitle = null;
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i];
    var name = '';
    var frame = null;
    try {
      var n = w.name();
      name = n === null || n === undefined ? '' : String(n);
    } catch (e) {
      /* unnamed */
    }
    try {
      var pos = w.position();
      var size = w.size();
      frame = { x: Number(pos[0]), y: Number(pos[1]), width: Number(size[0]), height: Number(size[1]) };
    } catch (e) {
      frame = null;
    }
    var frameMatch = frame !== null && near(frame, info);
    if (frameMatch && (!info.title || name === info.title)) return w;
    if (frameMatch && !byFrame) byFrame = w;
    if (info.title && name === info.title && !byTitle) byTitle = w;
  }
  return byFrame || byTitle;
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

function cmdPerms() {
  var accessibility = null;
  var screenRecording = null;
  try {
    if (typeof $.AXIsProcessTrusted !== 'undefined') accessibility = Boolean($.AXIsProcessTrusted());
  } catch (e) {
    accessibility = null;
  }
  try {
    if (typeof $.CGPreflightScreenCaptureAccess !== 'undefined') {
      screenRecording = Boolean($.CGPreflightScreenCaptureAccess());
    }
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
      if (typeof $.CGRequestScreenCaptureAccess !== 'undefined') {
        out.screenRecording = Boolean($.CGRequestScreenCaptureAccess());
      }
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

function cmdKey(a) {
  var codes = intList(a.keyCodes);
  if (!codes.length && a.keyCode !== undefined && a.keyCode !== null) codes = [int(a.keyCode, 'keyCode')];
  if (!codes.length) throw fail('BAD_ARGS', 'keyCode is required');
  pressCombo(codes, a.flags | 0, intList(a.modifierKeyCodes));
  return { keys: codes.length };
}

/**
 * Type a plan of steps: {kind:'keys',text} (printable ASCII via System Events
 * keystroke), {kind:'key',keyCode} (a bare key press such as Return or Tab) and
 * {kind:'paste',text} (via the pasteboard and cmd+v). The pasteboard is restored
 * 300 ms after the last paste. If System Events is not authorized (Automation),
 * keystroke steps fall back to pasting when args.fallbackPaste is true.
 */
function cmdType(a) {
  var steps = a.steps && typeof a.steps.length === 'number' ? a.steps : [];
  var se = null;
  var automationError = null;
  var saved = null;
  var lastChange = null;
  var lastPasteAt = 0;
  var pasted = 0;
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
      pressCombo([KEY_V], FLAG_CMD, [KEY_CMD]);
      lastPasteAt = Date.now();
      pasted++;
      // Let the target app read the pasteboard before it changes again.
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
  return { steps: steps.length, pasted: pasted, fallback: automationError === null ? null : 'paste', automationError: automationError };
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
  var wins = onScreenWindows();
  var win = null;
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i];
    if (w.pid === front.pid && w.layer === 0 && w.alpha > 0 && w.width > 1 && w.height > 1) {
      win = w;
      break;
    }
  }
  if (win && !win.title && a.axTitles !== false) fillTitlesFromAX([win], 1000);
  return { pid: front.pid, app: front.name, bundleId: front.bundleId, window: win };
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
  try {
    bundleId = str(app.bundleIdentifier);
    var url = app.bundleURL;
    if (!isNil(url)) bundlePath = str(url.path);
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
    var proc = axProcess(systemEvents(), pid);
    try {
      proc.frontmost = true;
    } catch (e) {
      /* activation above may already have worked */
    }
    if (number !== null) {
      var w = findAxWindow(proc, info);
      if (w) {
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
  var w = findAxWindow(axProcess(systemEvents(), pid), info);
  if (!w) return { ok: false, reason: 'no matching accessibility window' };
  w.attributes.byName('AXMinimized').value = true;
  return { ok: true };
}

function cmdClipGet() {
  return { text: clipboardText() };
}

function cmdClipSet(a) {
  setClipboardText(a.text === undefined || a.text === null ? '' : String(a.text));
  return { ok: true };
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
  windows: cmdWindows,
  active: cmdActive,
  focus: cmdFocus,
  minimize: cmdMinimize,
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
