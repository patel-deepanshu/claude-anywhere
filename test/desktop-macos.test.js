'use strict';

/**
 * macOS UI automation: darwin-helper.js uiTree / uiFind / uiAction / setBounds against a fake
 * macOS (the AX C API behind a fake JXA bridge, System Events, CG window lists, NSScreen), and the
 * darwin.js driver methods (uiTree, uiFind, uiAction, setWindowBounds, capabilities().ui) through
 * a fake transport and, end to end, through a fake osascript over real pipes.
 *
 * The fake bridge can behave in each way the real JXA bridge might (CF values as objects or as
 * Refs, attribute names only as NSString or only as JS strings, NSArrays that do not unwrap, no
 * AXUIElementCopyMultipleAttributeValues), so every calibration path of the helper is exercised.
 *
 * The live check (macOS with ANYWHERE_LIVE_DESKTOP=1, as in CI's "Live desktop (macos-latest)"
 * job) is read-only: Finder's menu bar and the front window's tree, through the real AX bridge.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const D = require('../src/os/darwin');

const HELPER = path.join(__dirname, '..', 'src', 'os', 'darwin-helper.js');
const DRIVER = path.join(__dirname, '..', 'src', 'os', 'darwin.js');
const HELPER_SRC = fs.readFileSync(HELPER, 'utf8');

/** Values from the vm realm, compared by structure. */
function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// ===========================================================================
// A fake macOS. Self-contained (it is also stringified into a fake osascript).
// ===========================================================================

/**
 * @param {object} spec {apps:[{pid, name, bundleId?, bundlePath?, windows:[el], menuBar?:el, menus?:[el],
 *   focusedWindow?, accessibilityAttrs?, refuseActivation?}], front, order?:[window numbers], screens?,
 *   trusted?, apiDisabled?, automationDenied?, files?:[paths]}. Elements: {role, subrole?, title?, desc?,
 *   value?, help?, placeholder?, url?, pos:[x,y], size:[w,h], enabled?, focused?, selected?, expanded?,
 *   disclosing?, children?, visibleRows?/visibleChildren?: [child indices], titleUI?: el, actions?: [names],
 *   settable?: {attr: bool}, number? (windows: CG number), onAction?, onSet?, onMove?, onResize?, hang?, dead?}
 * @param {{personality?:'object'|'ref', attrForm?:'any'|'ns'|'js', unwrapArrays?:boolean, noMulti?:boolean,
 *   noAx?:boolean, noActionNames?:boolean}} [opts]
 */
function fakeMac(spec, opts) {
  opts = opts || {};
  const personality = opts.personality || 'object';
  const attrForm = opts.attrForm || 'any';
  const unwrapArrays = opts.unwrapArrays !== false;
  const log = [];
  const stats = { copy: 0, multi: 0, sleep: 0, create: 0 };
  const state = {
    front: spec.front == null ? null : spec.front,
    trusted: spec.trusted !== false,
    apiDisabled: Boolean(spec.apiDisabled),
    automationDenied: Boolean(spec.automationDenied),
    files: new Set(spec.files || []),
  };
  const MAP = {
    AXRole: 'role', AXSubrole: 'subrole', AXTitle: 'title', AXDescription: 'desc', AXValue: 'value', AXHelp: 'help',
    AXPlaceholderValue: 'placeholder', AXEnabled: 'enabled', AXFocused: 'focused', AXSelected: 'selected',
    AXExpanded: 'expanded', AXDisclosing: 'disclosing', AXMinimized: 'minimized', AXFullScreen: 'fullScreen',
    AXMain: 'main', AXManualAccessibility: 'manualAccessibility', AXEnhancedUserInterface: 'enhancedUserInterface',
  };
  const DEFAULT_SETTABLE = { AXFocused: 1, AXMain: 1, AXFrontmost: 1, AXMinimized: 1, AXFullScreen: 1 };
  const VALUE_ROLES = { AXTextField: 1, AXTextArea: 1, AXComboBox: 1, AXSlider: 1, AXSearchField: 1 };
  const SE_PROPS = ['role', 'subrole', 'name', 'description', 'help', 'value', 'position', 'size', 'enabled', 'focused', 'selected'];

  let seq = 0;
  const apps = {};
  function prep(el, pid) {
    if (!el || typeof el !== 'object' || el.__id) return;
    el.__id = ++seq;
    el.__pid = pid;
    for (const c of el.children || []) prep(c, pid);
    if (el.titleUI) prep(el.titleUI, pid);
  }
  for (const app of spec.apps || []) {
    app.windows = app.windows || [];
    app.menus = app.menus || [];
    app.root = app.root || { role: 'AXApplication', title: app.name };
    app.root.__app = app;
    prep(app.root, app.pid);
    for (const w of app.windows) prep(w, app.pid);
    if (app.menuBar) prep(app.menuBar, app.pid);
    for (const m of app.menus) prep(m, app.pid);
    apps[app.pid] = app;
  }
  function prepLater(el, pid) {
    prep(el, pid);
    return el;
  }
  function childrenOf(e) {
    if (e.__app) {
      const a = e.__app;
      return a.windows.filter((w) => !w.closed).concat(a.menuBar ? [a.menuBar] : [], a.menus);
    }
    const kids = e.children || [];
    for (const k of kids) prep(k, e.__pid);
    return kids;
  }
  function label(e) {
    return (e && (e.label || e.title || e.desc || e.role)) || '?';
  }

  // ----- ObjC values -----
  function W(v) {
    return { __v: v, isNil: () => false, dataUsingEncoding: () => ({ __text: v }) };
  }
  function obj(description) {
    return { isNil: () => false, description: W(description) };
  }
  function wrapEl(el) {
    return { __el: el, isNil: () => false, description: W(`<AXUIElement 0x${(el.__id || 0).toString(16)}> {pid=${el.__pid}}`) };
  }
  function wrapArr(items) {
    return { __v: items, __noUnwrap: !unwrapArrays, count: items.length, objectAtIndex: (i) => items[i], isNil: () => false, description: W('(array)') };
  }
  function errorValue() {
    return obj('<AXValue 0x60000c> {value = error=-25205 type = kAXValueAXErrorType}');
  }
  const out = (v) => (personality === 'ref' ? { __ref: v } : v);

  function getAttr(e, n) {
    if (!e || e.dead) return { err: -25202 };
    if (e.hang) return { err: -25204 };
    if (!n) return { err: -25201 };
    if (n === 'AXChildren') return { kind: 'els', value: childrenOf(e) };
    if (n === 'AXWindows') return e.__app ? { kind: 'els', value: e.__app.windows.filter((w) => !w.closed) } : { err: -25205 };
    if (n === 'AXFocusedWindow') {
      if (!e.__app) return { err: -25205 };
      const w = e.__app.windows[e.__app.focusedWindow || 0];
      return w ? { kind: 'el', value: w } : { err: -25212 };
    }
    if (n === 'AXVisibleRows' || n === 'AXVisibleChildren') {
      const key = n === 'AXVisibleRows' ? 'visibleRows' : 'visibleChildren';
      if (!Array.isArray(e[key])) return { err: -25205 };
      return { kind: 'els', value: e[key].map((i) => childrenOf(e)[i]) };
    }
    if (n === 'AXTitleUIElement') return e.titleUI ? { kind: 'el', value: e.titleUI } : { err: -25205 };
    if (n === 'AXPosition') return e.pos ? { kind: 'point', value: e.pos } : { err: -25205 };
    if (n === 'AXSize') return e.size ? { kind: 'size', value: e.size } : { err: -25205 };
    if (n === 'AXURL') return e.url ? { kind: 'url', value: e.url } : { err: -25205 };
    if (n === 'AXFrontmost') return e.__app ? { kind: 'prim', value: state.front === e.__pid } : { err: -25205 };
    if (MAP[n]) {
      const v = e[MAP[n]];
      return v === undefined || v === null ? { err: -25205 } : { kind: 'prim', value: v };
    }
    return { err: -25205 };
  }
  function wrapAttr(r) {
    switch (r.kind) {
      case 'prim':
        return W(r.value);
      case 'el':
        return wrapEl(r.value);
      case 'els':
        return wrapArr(r.value.map(wrapEl));
      case 'point':
        return obj(`<AXValue 0x60000a> {value = x:${r.value[0].toFixed(6)} y:${r.value[1].toFixed(6)} type = kAXValueCGPointType}`);
      case 'size':
        return obj(`<AXValue 0x60000b> {value = w:${r.value[0].toFixed(6)} h:${r.value[1].toFixed(6)} type = kAXValueCGSizeType}`);
      case 'url': {
        const o = obj(r.value);
        o.absoluteString = W(r.value);
        return o;
      }
      default:
        return errorValue();
    }
  }
  function settable(e, n) {
    if (!e) return false;
    if (e.settable && n in e.settable) return Boolean(e.settable[n]);
    if (DEFAULT_SETTABLE[n]) return true;
    if (n === 'AXValue') return Boolean(VALUE_ROLES[e.role]);
    if (n === 'AXExpanded') return e.expanded !== undefined;
    if (n === 'AXSelected') return e.selected !== undefined;
    if (n === 'AXDisclosing') return e.disclosing !== undefined;
    if (n === 'AXManualAccessibility' || n === 'AXEnhancedUserInterface') return Boolean(e.__app && (e.__app.accessibilityAttrs || []).includes(n));
    return false;
  }
  function setAttr(e, n, v) {
    if (!e || e.dead) return -25202;
    if (e.hang) return -25204;
    if (typeof e.onSet === 'function') {
      const r = e.onSet(n, v);
      if (typeof r === 'number') return r;
    }
    if (!settable(e, n)) return -25205;
    if (n === 'AXFrontmost') {
      if (v && e.__app && !e.__app.refuseActivation) state.front = e.__pid;
      return 0;
    }
    if (MAP[n]) e[MAP[n]] = v;
    if ((n === 'AXManualAccessibility' || n === 'AXEnhancedUserInterface') && e.__app && typeof e.__app.onEnable === 'function') {
      e.__app.onEnable(n, v);
    }
    return 0;
  }

  const ObjC = {
    import: () => {},
    unwrap: (o) => {
      if (o === null || o === undefined || (typeof o !== 'object' && typeof o !== 'function')) return o;
      if (o.__noUnwrap) return o;
      return '__v' in o ? o.__v : o;
    },
    deepUnwrap: (o) => (o && o.__deep !== undefined ? o.__deep : ObjC.unwrap(o)),
    castRefToObject: (r) => {
      if (r && typeof r === 'object' && '__ref' in r) return r.__ref;
      throw new TypeError('castRefToObject: not a reference');
    },
    castObjectToRef: (o) => ({ __ref: o }),
  };
  const Ref = function () {
    return [];
  };
  function inEl(x) {
    if (x && x.__sys) return null;
    if (personality === 'ref') {
      if (!x || typeof x !== 'object' || !('__ref' in x)) throw new TypeError('expected a pointer to an AXUIElement');
      x = x.__ref;
    } else if (x && typeof x === 'object' && '__ref' in x) {
      throw new TypeError('expected an AXUIElement object');
    }
    if (!x || !x.__el) throw new TypeError('not an AXUIElement');
    return x.__el;
  }
  function inName(x) {
    if (typeof x === 'string') {
      if (attrForm === 'ns') throw new TypeError('expected an NSString');
      return x;
    }
    if (x && typeof x.__v === 'string') return attrForm === 'js' ? '' : x.__v;
    throw new TypeError('bad attribute name');
  }

  const cmp = (x) => (x == null ? Number.MAX_SAFE_INTEGER : x);
  function cgList(option, rel) {
    const order = spec.order || [];
    const wins = [];
    for (const app of Object.values(apps)) {
      for (const w of app.windows) if (w.number != null && !w.closed) wins.push({ app, w, i: wins.length });
    }
    const rank = (x) => {
      const k = order.indexOf(x.w.number);
      if (k >= 0) return k;
      return (x.app.pid === state.front ? 1000 : 2000) + x.i;
    };
    wins.sort((a, b) => cmp(rank(a)) - cmp(rank(b)));
    let list = wins.map(({ app, w }) => ({
      kCGWindowNumber: w.number,
      kCGWindowOwnerPID: app.pid,
      kCGWindowOwnerName: app.name,
      kCGWindowName: w.cgTitle !== undefined ? w.cgTitle : w.title,
      kCGWindowLayer: w.layer || 0,
      kCGWindowAlpha: 1,
      kCGWindowIsOnscreen: !w.minimized && !w.offscreen,
      kCGWindowBounds: { X: (w.cgPos || w.pos)[0], Y: (w.cgPos || w.pos)[1], Width: w.size[0], Height: w.size[1] },
    }));
    if (option === 8) list = list.filter((x) => x.kCGWindowNumber === rel);
    else if (option & 1) list = list.filter((x) => x.kCGWindowIsOnscreen);
    log.push(['cgList', option]);
    return { __ref: { __deep: list } };
  }

  const screens = (spec.screens || [{ frame: [0, 0, 1440, 900], visible: [0, 70, 1440, 805] }]).map((s) => ({
    frame: { origin: { x: s.frame[0], y: s.frame[1] }, size: { width: s.frame[2], height: s.frame[3] } },
    visibleFrame: {
      origin: { x: (s.visible || s.frame)[0], y: (s.visible || s.frame)[1] },
      size: { width: (s.visible || s.frame)[2], height: (s.visible || s.frame)[3] },
    },
  }));

  const $ = function (v) {
    if (Array.isArray(v)) return wrapArr(v.map((x) => $(x)));
    return W(v);
  };
  Object.assign($, {
    NSThread: { sleepForTimeInterval: (t) => { stats.sleep += t; } },
    NSRunLoop: { currentRunLoop: { runUntilDate: () => {} } },
    NSDate: { dateWithTimeIntervalSinceNow: () => ({}) },
    NSProcessInfo: { processInfo: { processIdentifier: 4242, operatingSystemVersionString: W('Fake macOS 15') } },
    NSNumber: { numberWithBool: (b) => W(Boolean(b)), numberWithDouble: (n) => W(Number(n)) },
    NSFileManager: { defaultManager: { fileExistsAtPath: (p) => state.files.has(ObjC.unwrap(p)) } },
    NSScreen: {
      get screens() {
        return { isNil: () => false, count: screens.length, objectAtIndex: (i) => screens[i] };
      },
    },
    NSWorkspace: {
      sharedWorkspace: {
        get frontmostApplication() {
          const app = apps[state.front];
          if (!app) return null;
          return { isNil: () => false, processIdentifier: app.pid, localizedName: W(app.name), bundleIdentifier: W(app.bundleId || '') };
        },
      },
    },
    NSRunningApplication: {
      runningApplicationWithProcessIdentifier: (pid) => {
        const app = apps[pid];
        if (!app) return { isNil: () => true };
        return {
          isNil: () => false,
          processIdentifier: pid,
          localizedName: W(app.name),
          bundleIdentifier: W(app.bundleId || ''),
          bundleURL: { isNil: () => false, path: W(app.bundlePath || `/Applications/${app.name}.app`) },
          get unhide() {
            log.push(['unhide', pid]);
            return true;
          },
          activateWithOptions: (o) => {
            log.push(['activate', pid, o]);
            if (app.refuseActivation) return false;
            state.front = pid;
            return true;
          },
        };
      },
      runningApplicationsWithBundleIdentifier: () => ({ isNil: () => false, count: 1 }),
    },
    CGWindowListCopyWindowInfo: cgList,
    CGPreflightScreenCaptureAccess: () => true,
    AXIsProcessTrusted: () => state.trusted,
  });
  if (!opts.noAx) {
    Object.assign($, {
      AXUIElementCreateSystemWide: () => ({ __sys: true }),
      AXUIElementSetMessagingTimeout: (el, t) => {
        const e = inEl(el);
        log.push(['timeout', e ? label(e) : 'global', t]);
        return 0;
      },
      AXUIElementCreateApplication: (pid) => {
        stats.create++;
        const app = apps[pid];
        return out(wrapEl(app ? app.root : { __id: 0, __pid: pid, dead: true }));
      },
      AXUIElementCopyAttributeValue: (el, name, ref) => {
        const e = inEl(el);
        const n = inName(name);
        stats.copy++;
        if (state.apiDisabled) return -25211;
        const r = getAttr(e, n);
        if (r.err) return r.err;
        ref[0] = out(wrapAttr(r));
        return 0;
      },
      AXUIElementPerformAction: (el, name) => {
        const e = inEl(el);
        const n = inName(name);
        log.push(['perform', label(e), n]);
        if (state.apiDisabled) return -25211;
        if (!e || e.dead) return -25202;
        if (!(e.actions || []).includes(n)) return -25206;
        if (typeof e.onAction === 'function') {
          const r = e.onAction(n);
          if (typeof r === 'number') return r;
        }
        return 0;
      },
      AXUIElementSetAttributeValue: (el, name, value) => {
        const e = inEl(el);
        const n = inName(name);
        const v = ObjC.unwrap(value);
        log.push(['set', label(e), n, v]);
        if (state.apiDisabled) return -25211;
        return setAttr(e, n, v);
      },
      AXUIElementIsAttributeSettable: (el, name, ref) => {
        const e = inEl(el);
        const n = inName(name);
        if (!MAP[n] && n !== 'AXFrontmost') return -25205;
        ref[0] = settable(e, n);
        return 0;
      },
    });
    if (!opts.noActionNames) {
      $.AXUIElementCopyActionNames = (el, ref) => {
        const e = inEl(el);
        if (!e || e.dead) return -25202;
        ref[0] = out(wrapArr((e.actions || []).map((a) => W(a))));
        return 0;
      };
    }
    if (!opts.noMulti) {
      $.AXUIElementCopyMultipleAttributeValues = (el, names, options, ref) => {
        const e = inEl(el);
        let list;
        if (Array.isArray(names)) {
          if (attrForm === 'ns') throw new TypeError('expected an NSArray');
          list = names;
        } else if (names && Array.isArray(names.__v)) {
          list = names.__v.map((x) => (attrForm === 'js' ? '' : ObjC.unwrap(x)));
        } else {
          throw new TypeError('bad attribute list');
        }
        stats.multi++;
        if (state.apiDisabled) return -25211;
        if (!e || e.dead) return -25202;
        if (e.hang) return -25204;
        const items = list.map((n) => {
          const r = getAttr(e, n);
          return r.err ? errorValue() : wrapAttr(r);
        });
        ref[0] = out(wrapArr(items));
        return 0;
      };
    }
  }

  // ----- System Events -----
  function seErr(n, msg) {
    const e = new Error(msg);
    e.errorNumber = n;
    return e;
  }
  function check() {
    if (state.automationDenied) throw seErr(-1743, 'Not authorized to send Apple events to System Events.');
    if (!state.trusted) throw seErr(-1719, 'System Events got an error: osascript is not allowed assistive access.');
  }
  function seProp(e, p) {
    const v = (x) => (x === undefined || x === null ? null : x);
    switch (p) {
      case 'role':
        return e.role;
      case 'subrole':
        return v(e.subrole);
      case 'name':
        return v(e.title);
      case 'description':
        return v(e.desc);
      case 'help':
        return v(e.help);
      case 'value':
        if (e.seValueError) throw seErr(-10000, 'System Events got an error: AppleEvent handler failed.');
        return v(e.value);
      case 'position':
        return e.pos ? e.pos.slice() : null;
      case 'size':
        return e.size ? e.size.slice() : null;
      default:
        return v(e[p]);
    }
  }
  function attrSpec(resolveEl, n) {
    const a = {};
    Object.defineProperty(a, 'value', {
      get: () => () => {
        const e = resolveEl();
        const r = getAttr(e, n);
        if (r.err) throw seErr(-1728, `Can't get attribute "${n}".`);
        if (r.kind === 'el') return elSpec(() => r.value);
        if (r.kind === 'els') return r.value.map((x) => elSpec(() => x));
        if (r.kind === 'point' || r.kind === 'size') return r.value.slice();
        return r.value;
      },
      set: (val) => {
        const e = resolveEl();
        log.push(['se.set', label(e), n, val]);
        const code = setAttr(e, n, val);
        if (code) throw seErr(-10006, `Can't set attribute "${n}".`);
      },
    });
    a.settable = () => settable(resolveEl(), n);
    return a;
  }
  function elSpec(resolve) {
    const el = () => {
      check();
      const e = resolve();
      if (!e || e.dead) throw seErr(-1719, "Can't get UI element. Invalid index.");
      return e;
    };
    const s = {};
    for (const p of SE_PROPS) s[p] = () => seProp(el(), p);
    s.accessibilityDescription = s.description;
    Object.defineProperty(s, 'uiElements', { get: () => coll(() => childrenOf(el())) });
    s.attributes = { byName: (n) => attrSpec(el, n) };
    s.actions = {
      byName: (n) => ({
        perform: () => {
          const e = el();
          log.push(['se.perform', label(e), n]);
          if (!(e.actions || []).includes(n)) throw seErr(-1728, `Can't get action "${n}".`);
          if (typeof e.onAction === 'function') e.onAction(n);
        },
      }),
      name: () => (el().actions || []).slice(),
    };
    s.buttons = {
      whose: (q) =>
        childrenOf(el())
          .filter((k) => k.role === 'AXButton' && (!q.subrole || k.subrole === q.subrole))
          .map((k) => elSpec(() => k)),
    };
    Object.defineProperty(s, 'position', {
      get: () => () => seProp(el(), 'position'),
      set: (v) => {
        const e = el();
        log.push(['se.position', label(e), v.slice()]);
        if (typeof e.onMove === 'function') e.onMove(v);
        else e.pos = [Number(v[0]), Number(v[1])];
      },
    });
    Object.defineProperty(s, 'size', {
      get: () => () => seProp(el(), 'size'),
      set: (v) => {
        const e = el();
        log.push(['se.size', label(e), v.slice()]);
        if (typeof e.onResize === 'function') e.onResize(v);
        else e.size = [Number(v[0]), Number(v[1])];
      },
    });
    return s;
  }
  function coll(resolveList) {
    const base = {};
    for (const p of SE_PROPS) {
      base[p] = () => {
        check();
        return resolveList().map((e) => seProp(e, p));
      };
    }
    base.accessibilityDescription = base.description;
    return new Proxy(base, {
      get(t, k) {
        if (k === 'length') {
          check();
          return resolveList().length;
        }
        if (typeof k === 'string' && /^\d+$/.test(k)) {
          const i = Number(k);
          return elSpec(() => resolveList()[i]);
        }
        return t[k];
      },
    });
  }
  function procSpec(pid) {
    const app = () => {
      check();
      const a = apps[pid];
      if (!a) throw seErr(-1728, "Can't get process.");
      return a;
    };
    const p = {
      name: () => app().name,
      windows: coll(() => app().windows.filter((w) => !w.closed)),
      uiElements: coll(() => childrenOf(app().root)),
      attributes: { byName: (n) => attrSpec(() => app().root, n) },
    };
    Object.defineProperty(p, 'frontmost', {
      set: (v) => {
        log.push(['se.frontmost', pid, v]);
        const a = apps[pid];
        if (v && a && !a.refuseActivation) state.front = pid;
      },
    });
    return p;
  }
  const systemEvents = {
    processes: {
      whose: (q) => {
        if (q.unixId !== undefined) return [procSpec(q.unixId)];
        return Object.values(apps)
          .filter((a) => a.name === q.name)
          .map((a) => procSpec(a.pid));
      },
    },
  };
  const Application = (name) => {
    log.push(['Application', name]);
    if (name !== 'System Events') throw new Error(`no application ${name}`);
    return systemEvents;
  };

  return { ObjC, $, Ref, Application, log, stats, state, apps, prep: prepLater };
}

function loadHelper(f) {
  const ctx = vm.createContext({ ObjC: f.ObjC, $: f.$, Ref: f.Ref, Application: f.Application });
  vm.runInContext(HELPER_SRC, ctx, { filename: 'darwin-helper.js' });
  const call = (cmd, args) => plain(ctx.dispatch({ id: 1, cmd, args: args || {} }));
  const ok = (cmd, args) => {
    const r = call(cmd, args);
    assert.equal(r.ok, true, `${cmd} failed: ${r.error} (${r.code})`);
    return r.result;
  };
  return { ctx, call, ok };
}

/** A helper vm without ObjC: the pure functions only. */
function pureHelper() {
  const ctx = vm.createContext({});
  vm.runInContext(HELPER_SRC, ctx, { filename: 'darwin-helper.js' });
  return ctx;
}

// ----- worlds -----

function btn(desc, extra) {
  return { role: 'AXButton', desc, actions: ['AXPress'], enabled: true, ...extra };
}

/** TextEdit (pid 501) with one document window #41 and Finder (pid 300) without windows. */
function textEditWorld() {
  const fontMenu = {
    role: 'AXMenu',
    pos: [600, 110],
    size: [180, 80],
    children: [
      { role: 'AXMenuItem', title: 'Helvetica', actions: ['AXPress', 'AXCancel'], pos: [600, 110], size: [180, 20] },
      { role: 'AXMenuItem', title: 'Times New Roman', actions: ['AXPress', 'AXCancel'], pos: [600, 130], size: [180, 20] },
      { role: 'AXMenuItem', title: 'Courier', actions: ['AXPress', 'AXCancel'], pos: [600, 150], size: [180, 20] },
    ],
  };
  const font = {
    role: 'AXPopUpButton',
    desc: 'Font',
    value: 'Helvetica',
    pos: [600, 80],
    size: [120, 24],
    enabled: true,
    actions: ['AXPress', 'AXShowMenu'],
    children: [],
  };
  font.onAction = (n) => {
    if (n === 'AXShowMenu' || n === 'AXPress') font.children = [fontMenu];
  };
  for (const item of fontMenu.children) {
    item.onAction = (n) => {
      if (n === 'AXPress') font.value = item.title;
      font.children = [];
    };
  }
  const text = {
    role: 'AXTextArea',
    value: 'Hello world',
    placeholder: 'Type here',
    pos: [110, 130],
    size: [780, 400],
    focused: true,
    enabled: true,
    actions: [],
  };
  const search = {
    role: 'AXTextField',
    subrole: 'AXSearchField',
    value: '',
    placeholder: 'Find…',
    titleUI: { role: 'AXStaticText', value: 'Search' },
    pos: [700, 560],
    size: [180, 22],
    enabled: true,
    actions: ['AXConfirm'],
  };
  const wrap = { role: 'AXCheckBox', title: 'Wrap lines', value: 1, pos: [110, 560], size: [100, 20], enabled: true, actions: ['AXPress'] };
  wrap.onAction = () => {
    wrap.value = wrap.value ? 0 : 1;
  };
  const window = {
    role: 'AXWindow',
    subrole: 'AXStandardWindow',
    title: 'Notes.txt',
    number: 41,
    pos: [100, 50],
    size: [800, 600],
    main: true,
    actions: ['AXRaise'],
    children: [
      {
        role: 'AXToolbar',
        pos: [100, 72],
        size: [800, 40],
        children: [btn('Bold', { pos: [110, 80], size: [24, 24] }), btn('Italic', { pos: [140, 80], size: [24, 24], enabled: false }), font],
      },
      { role: 'AXGroup', pos: [100, 120], size: [800, 420], children: [{ role: 'AXScrollArea', pos: [100, 120], size: [800, 420], children: [text] }] },
      wrap,
      { role: 'AXStaticText', value: 'Words: 2', pos: [300, 560], size: [80, 20] },
      btn('Save', { title: 'Save', desc: 'Save the document', pos: [800, 600], size: [80, 30] }),
      { role: 'AXStaticText', value: 'scrolled away', pos: [110, 2000], size: [100, 20] },
      { role: 'AXImage', desc: 'spacer', pos: [0, 0], size: [0, 0] },
      search,
      { role: 'AXButton', subrole: 'AXCloseButton', desc: 'close button', pos: [108, 56], size: [14, 16], actions: ['AXPress'] },
    ],
  };
  const menuBar = {
    role: 'AXMenuBar',
    pos: [0, 0],
    size: [1440, 25],
    children: [
      { role: 'AXMenuBarItem', title: 'Apple', pos: [10, 0], size: [30, 25], actions: ['AXPress', 'AXCancel'], children: [] },
      {
        role: 'AXMenuBarItem',
        title: 'File',
        pos: [80, 0],
        size: [40, 25],
        actions: ['AXPress', 'AXCancel'],
        children: [
          {
            role: 'AXMenu',
            children: [
              { role: 'AXMenuItem', title: 'Save…', actions: ['AXPress'], pos: [0, 0], size: [0, 0] },
              { role: 'AXMenuItem', title: 'Close', actions: ['AXPress'], pos: [0, 0], size: [0, 0] },
            ],
          },
        ],
      },
    ],
  };
  const textEdit = { pid: 501, name: 'TextEdit', bundleId: 'com.apple.TextEdit', windows: [window], menuBar };
  const finderBar = {
    role: 'AXMenuBar',
    pos: [0, 0],
    size: [1440, 25],
    children: [{ role: 'AXMenuBarItem', title: 'File', pos: [80, 0], size: [40, 25], actions: ['AXPress'], children: [] }],
  };
  const finder = { pid: 300, name: 'Finder', bundleId: 'com.apple.finder', windows: [], menuBar: finderBar };
  return { spec: { apps: [textEdit, finder], front: 501 }, window, text, font, fontMenu, wrap, search, menuBar, textEdit, finder };
}

/** Brave (pid 777) whose web area is empty until accessibility is switched on. */
function braveWorld() {
  const webArea = { role: 'AXWebArea', title: 'Jira', pos: [0, 120], size: [1200, 700], children: [] };
  const window = {
    role: 'AXWindow',
    title: 'For you - Jira',
    number: 55,
    pos: [0, 25],
    size: [1200, 800],
    children: [
      { role: 'AXToolbar', pos: [0, 25], size: [1200, 90], children: [btn('Reload', { pos: [10, 40], size: [24, 24] })] },
      { role: 'AXGroup', pos: [0, 120], size: [1200, 700], children: [webArea] },
    ],
  };
  const brave = {
    pid: 777,
    name: 'Brave Browser',
    bundleId: 'com.brave.Browser',
    windows: [window],
    accessibilityAttrs: ['AXManualAccessibility', 'AXEnhancedUserInterface'],
  };
  brave.onEnable = (n, v) => {
    if (n === 'AXEnhancedUserInterface' && v) {
      webArea.children = [
        { role: 'AXLink', title: 'For you', url: 'https://acme.atlassian.net/jira/for-you', pos: [20, 150], size: [60, 20], actions: ['AXPress'] },
        { role: 'AXHeading', title: 'Assigned to me', pos: [20, 200], size: [300, 30] },
        { role: 'AXLink', title: 'ABC-123 Fix the login page', pos: [20, 240], size: [400, 20], actions: ['AXPress'] },
      ];
    }
  };
  return { spec: { apps: [brave], front: 777 }, window, webArea, brave };
}

// ===========================================================================
// Syntax
// ===========================================================================

test('darwin-helper.js and darwin.js pass node --check', () => {
  for (const f of [HELPER, DRIVER]) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('helper: the UI section is conservative ES5 (no arrow functions, let/const or template strings)', () => {
  const start = HELPER_SRC.indexOf('// ---------------------------------------------------------------- UI automation');
  const end = HELPER_SRC.indexOf('var COMMANDS = {');
  assert.ok(start > 0 && end > start);
  const code = HELPER_SRC.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /=>/);
  assert.doesNotMatch(code, /\b(let|const)\s/);
  assert.doesNotMatch(code, /`/);
});

// ===========================================================================
// Pure helpers
// ===========================================================================

test('helper: AX roles map to the shared role vocabulary', () => {
  const h = pureHelper();
  const role = (r, sub, parent) => h.uiRole({ role: r, subrole: sub || '' }, parent || '');
  assert.equal(role('AXButton'), 'button');
  assert.equal(role('AXMenuButton'), 'button');
  assert.equal(role('AXLink'), 'link');
  assert.equal(role('AXTextField'), 'textbox');
  assert.equal(role('AXTextField', 'AXSecureTextField'), 'textbox');
  assert.equal(role('AXTextArea'), 'textbox');
  assert.equal(role('AXCheckBox'), 'checkbox');
  assert.equal(role('AXCheckBox', 'AXSwitch'), 'checkbox');
  assert.equal(role('AXRadioButton'), 'radio');
  assert.equal(role('AXRadioButton', '', 'AXTabGroup'), 'tab');
  assert.equal(role('AXRadioButton', 'AXTabButton'), 'tab');
  assert.equal(role('AXTabGroup'), 'tablist');
  assert.equal(role('AXPopUpButton'), 'combobox');
  assert.equal(role('AXComboBox'), 'combobox');
  assert.equal(role('AXMenuItem'), 'menuitem');
  assert.equal(role('AXMenuBarItem'), 'menuitem');
  assert.equal(role('AXMenu'), 'menu');
  assert.equal(role('AXMenuBar'), 'menu');
  assert.equal(role('AXRow'), 'row');
  assert.equal(role('AXRow', '', 'AXOutline'), 'treeitem');
  assert.equal(role('AXRow', 'AXOutlineRow'), 'treeitem');
  assert.equal(role('AXRow', '', 'AXList'), 'listitem');
  assert.equal(role('AXCell'), 'cell');
  assert.equal(role('AXTable'), 'table');
  assert.equal(role('AXOutline'), 'table');
  assert.equal(role('AXImage'), 'image');
  assert.equal(role('AXStaticText'), 'text');
  assert.equal(role('AXHeading'), 'heading');
  assert.equal(role('AXWindow'), 'window');
  assert.equal(role('AXSheet'), 'window');
  assert.equal(role('AXToolbar'), 'toolbar');
  assert.equal(role('AXWebArea'), 'group');
  assert.equal(role('AXScrollArea'), 'group');
  assert.equal(role('AXSlider'), 'slider');
  assert.equal(role('AXIncrementor'), 'slider');
  assert.equal(role('AXSplitter'), 'other');
  assert.equal(role('AXScrollBar'), 'other');
  assert.equal(role(''), 'other');
  const vocab = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listitem', 'menuitem', 'menu', 'tab', 'tablist', 'treeitem', 'image',
    'text', 'heading', 'window', 'toolbar', 'group', 'table', 'row', 'cell', 'slider', 'other',
  ]);
  for (const r of Object.values(plain(h.UI_ROLES))) assert.ok(vocab.has(r), r);
});

test('helper: names, descriptions, values and states', () => {
  const h = pureHelper();
  const rec = (o) => ({ role: 'AXButton', subrole: '', title: '', desc: '', value: null, help: '', placeholder: '', label: '', url: '', ...o });
  assert.equal(h.uiName(rec({ title: '  Save\n file ', desc: 'Saves' })), 'Save file');
  assert.equal(h.uiName(rec({ desc: 'Bold' })), 'Bold');
  assert.equal(h.uiName(rec({ role: 'AXStaticText', value: 'Words: 2' })), 'Words: 2');
  assert.equal(h.uiName(rec({ role: 'AXTextField', value: 'typed', label: 'Search', placeholder: 'Find' })), 'Search');
  assert.equal(h.uiName(rec({ role: 'AXTextField', value: 'typed', placeholder: 'Find' })), 'Find');
  assert.equal(h.uiName(rec({ role: 'AXTextField', value: 'typed' })), '');
  assert.equal(h.uiName(rec({ title: 'x'.repeat(500) })).length, 200);
  assert.equal(h.uiDescription(rec({ title: 'Save', desc: 'Save the document' }), 'Save'), 'Save the document');
  assert.equal(h.uiDescription(rec({ desc: 'Bold' }), 'Bold'), '');
  assert.equal(h.uiDescription(rec({ desc: 'Bold', help: 'Make the text bold' }), 'Bold'), 'Make the text bold');
  assert.equal(h.uiValue(rec({ role: 'AXCheckBox', value: 1 }), 'Wrap'), 'checked');
  assert.equal(h.uiValue(rec({ role: 'AXCheckBox', value: 0 }), 'Wrap'), 'unchecked');
  assert.equal(h.uiValue(rec({ role: 'AXCheckBox', value: 2 }), 'Wrap'), 'mixed');
  assert.equal(h.uiValue(rec({ role: 'AXCheckBox' }), 'Wrap'), '');
  assert.equal(h.uiValue(rec({ role: 'AXRadioButton', value: 1 }), 'A'), '');
  assert.equal(h.uiValue(rec({ role: 'AXStaticText', value: 'Words: 2' }), 'Words: 2'), '', 'the text is already the name');
  assert.equal(h.uiValue(rec({ role: 'AXLink', url: 'https://x.test/a' }), 'A'), 'https://x.test/a');
  assert.equal(h.uiValue(rec({ role: 'AXTextArea', value: 'line 1\nline 2' }), ''), 'line 1\nline 2');
  assert.equal(h.uiValue(rec({ role: 'AXSlider', value: 0.5 }), ''), '0.5');
  assert.equal(h.uiValue(rec({ role: 'AXTextArea', value: 'y'.repeat(900) }), '').length, 500);
  assert.equal(h.uiSelected(rec({ role: 'AXRow', selected: true })), true);
  assert.equal(h.uiSelected(rec({ role: 'AXRadioButton', value: 1 })), true);
  assert.equal(h.uiSelected(rec({ role: 'AXRadioButton', value: 0 })), false);
  assert.equal(h.uiSelected(rec({})), undefined);
  assert.equal(h.uiExpanded(rec({ expanded: false })), false);
  assert.equal(h.uiExpanded(rec({ role: 'AXRow', disclosing: true })), true);
  assert.equal(h.uiExpanded(rec({ role: 'AXDisclosureTriangle', value: 1 })), true);
  assert.equal(h.uiExpanded(rec({})), undefined);
  assert.deepEqual(plain(h.uiBounds(rec({ pos: { x: 10.123, y: -0.001 }, size: { w: 30, h: 20 } }))), { x: 10.12, y: 0, width: 30, height: 20 });
  assert.deepEqual(plain(h.uiBounds(rec({ pos: null, size: { w: 1, h: 1 } }))), { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(h.uiTransparent(rec({ role: 'AXGroup' }), ''), true);
  assert.equal(h.uiTransparent(rec({ role: 'AXGroup' }), 'Sidebar'), false);
  assert.equal(h.uiTransparent(rec({ role: 'AXGroup', focused: true }), ''), false);
  assert.equal(h.uiTransparent(rec({ role: 'AXButton' }), ''), false);
});

test('helper: AXValue descriptions parse into points and sizes', () => {
  const h = pureHelper();
  assert.deepEqual(plain(h.parseAxPoint('<AXValue 0x6000035c4060> {value = x:12.000000 y:34.500000 type = kAXValueCGPointType}')), { x: 12, y: 34.5 });
  assert.deepEqual(plain(h.parseAxPoint('<AXValue 0x1> {value = x:-1920.000000 y:-0.000000 type = kAXValueCGPointType}')), { x: -1920, y: 0 });
  assert.deepEqual(plain(h.parseAxSize('<AXValue 0x1> {value = w:1440.000000 h:875.000000 type = kAXValueCGSizeType}')), { w: 1440, h: 875 });
  const rect = '<AXValue 0x1> {value = x:0.000000 y:25.000000 w:1440.000000 h:875.000000 type = kAXValueCGRectType}';
  assert.deepEqual(plain(h.parseAxPoint(rect)), { x: 0, y: 25 });
  assert.deepEqual(plain(h.parseAxSize(rect)), { w: 1440, h: 875 });
  assert.equal(h.parseAxPoint('<AXValue 0x1> {value = error=-25212 type = kAXValueAXErrorType}'), null);
  assert.equal(h.parseAxPoint('<null>'), null);
  assert.equal(h.parseAxSize(''), null);
  assert.equal(h.parseAxSize(undefined), null);
});

test('helper: element ids round-trip, and the driver parses them the same way', () => {
  const h = pureHelper();
  const id = h.uiMakeId(501, '41', 'w', ['0', 'v3', '12'], 'k3j9a');
  assert.equal(id, 'mac:501:41:w0.v3.12:k3j9a');
  assert.deepEqual(plain(h.uiParseId(id)), {
    id, pid: 501, winKey: '41', number: 41, axIndex: null, root: 'w', path: ['0', 'v3', '12'], hash: 'k3j9a',
  });
  assert.deepEqual(plain(h.uiParseId('mac:501:i2:w:abc')), {
    id: 'mac:501:i2:w:abc', pid: 501, winKey: 'i2', number: null, axIndex: 2, root: 'w', path: [], hash: 'abc',
  });
  assert.equal(plain(h.uiParseId('mac:501:-:a1.0:x')).root, 'a');
  for (const bad of ['', null, 'mac:0:41:w:abc', 'mac:501:41:x0:abc', 'mac:501:41:w0..1:abc', 'win:1:2', 'mac:501:41:w0:ABC', 'mac:501:41:w0']) {
    assert.equal(h.uiParseId(bad), null, String(bad));
    assert.equal(D.parseUiId(bad), null, String(bad));
  }
  assert.deepEqual(D.parseUiId(id), { pid: 501, windowId: '501:41', root: 'w', path: ['0', 'v3', '12'], hash: 'k3j9a' });
  assert.equal(D.parseUiId('mac:501:i2:w:abc').windowId, null);
});

test('helper: the element hash is FNV-1a over role and name', () => {
  const h = pureHelper();
  assert.equal(h.uiHashText(''), (0x811c9dc5).toString(36));
  assert.equal(h.uiHashText('a'), (0xe40c292c).toString(36));
  assert.equal(h.uiHashText('foobar'), (0xbf9cf968).toString(36));
  const r = { role: 'AXButton', title: 'Save', desc: '', value: null };
  assert.equal(h.uiHash(r), h.uiHashText('AXButton\u0001Save'));
  assert.notEqual(h.uiHash(r), h.uiHash({ ...r, title: 'Saved' }));
});

test('helper: text matching, role filters and match scores', () => {
  const h = pureHelper();
  assert.equal(h.uiTextScore('Save', 'save', false), 3);
  assert.equal(h.uiTextScore('Save as…', 'save', false), 2);
  assert.equal(h.uiTextScore('Autosave', 'save', false), 1);
  assert.equal(h.uiTextScore('Open', 'save', false), -1);
  assert.equal(h.uiTextScore('Save as', 'save', true), -1);
  assert.equal(h.uiTextScore('  SAVE ', 'save', true), 3);
  assert.equal(h.uiTextScore('', 'save', false), -1);
  assert.deepEqual(plain(h.uiRoleQuery('Button')), { role: 'button' });
  assert.deepEqual(plain(h.uiRoleQuery('text field')), { role: 'textbox' });
  assert.deepEqual(plain(h.uiRoleQuery('dropdown')), { role: 'combobox' });
  assert.deepEqual(plain(h.uiRoleQuery('AXPopUpButton')), { ax: 'axpopupbutton' });
  assert.equal(h.uiRoleQuery(''), null);
  const rec = { role: 'AXTextField', subrole: 'AXSearchField', value: 'abc', placeholder: 'Find', enabled: true, size: { w: 10, h: 10 } };
  assert.equal(h.uiRoleMatches({ ax: 'axsearchfield' }, rec, 'textbox'), true);
  assert.equal(h.uiRoleMatches({ ax: 'axtextfield' }, rec, 'textbox'), true);
  assert.equal(h.uiRoleMatches({ role: 'button' }, rec, 'textbox'), false);
  const q = (o) => h.uiQuery(o);
  assert.equal(h.uiMatchScore(rec, 'Search', 'textbox', q({ text: 'find' })), 33);
  assert.equal(h.uiMatchScore(rec, 'Search', 'textbox', q({ text: 'abc' })), 33);
  assert.equal(h.uiMatchScore(rec, 'Search', 'textbox', q({ name: 'sea', role: 'textbox' })), 23);
  assert.equal(h.uiMatchScore({ ...rec, enabled: false }, 'Search', 'textbox', q({ name: 'search' })), 31);
  assert.equal(h.uiMatchScore(rec, 'Search', 'textbox', q({ name: 'nope' })), -1);
  assert.equal(h.uiMatchScore(rec, 'Search', 'textbox', q({ role: 'button' })), -1);
  assert.throws(() => h.uiQuery({}), /needs a name, text or role/);
  assert.equal(q({ name: 'x', limit: 5000 }).limit, 200);
});

test('helper: AX windows are matched to CG windows by frame and title', () => {
  const h = pureHelper();
  const f = (name, x, y, width, height) => ({ name, x, y, width, height });
  const frames = [f('Inbox', 0, 25, 800, 600), f('Draft', 100, 100, 500, 400), f('Draft', 300, 300, 500, 400)];
  assert.equal(h.pickWindowIndex(frames, { title: 'Draft', x: 301, y: 299, width: 500, height: 400 }), 2);
  assert.equal(h.pickWindowIndex(frames, { title: '', x: 100, y: 100, width: 500, height: 400 }), 1);
  assert.equal(h.pickWindowIndex(frames, { title: 'Inbox', x: 9, y: 9, width: 9, height: 9 }), 0);
  assert.equal(h.pickWindowIndex(frames, { title: 'Other', x: 9, y: 9, width: 9, height: 9 }), -1);
  assert.equal(h.pickWindowIndex(frames, null), 0);
  assert.equal(h.pickWindowIndex([], null), -1);
  const t = (o) => ({ axIndex: null, info: null, explicit: false, ...o });
  assert.equal(h.uiChooseWindow(t({ axIndex: 1 }), frames, null), 1);
  assert.equal(h.uiChooseWindow(t({ axIndex: 7 }), frames, null), -1);
  assert.equal(h.uiChooseWindow(t({ info: { title: 'x', x: 0, y: 0, width: 1, height: 1 }, explicit: true }), frames, null), -1);
  assert.equal(h.uiChooseWindow(t({ info: { title: 'x', x: 0, y: 0, width: 1, height: 1 } }), frames, f('Draft', 300, 300, 500, 400)), 2);
  assert.equal(h.uiChooseWindow(t({}), frames, () => f('Draft', 100, 100, 500, 400)), 1);
  assert.equal(h.uiChooseWindow(t({}), frames, null), 0);
  assert.equal(h.uiChooseWindow(t({}), [], null), -1);
});

test('helper: maximize uses the visible frame of the screen holding the window', () => {
  const h = pureHelper();
  // Primary 1440x900 (menu bar 25, Dock 70 at the bottom); a second display above it.
  const screens = [
    { full: { x: 0, y: 0, width: 1440, height: 900 }, visible: { x: 0, y: 25, width: 1440, height: 805 } },
    { full: { x: 0, y: -1080, width: 1920, height: 1080 }, visible: { x: 0, y: -1080, width: 1920, height: 1080 } },
  ];
  assert.deepEqual(plain(h.visibleFrameFor({ x: 100, y: 100, width: 400, height: 300 }, screens)), screens[0].visible);
  assert.deepEqual(plain(h.visibleFrameFor({ x: 100, y: -900, width: 400, height: 300 }, screens)), screens[1].visible);
  // Centre off every screen: the one it overlaps most.
  assert.deepEqual(plain(h.visibleFrameFor({ x: 1300, y: -300, width: 400, height: 280 }, screens)), screens[1].visible);
  assert.deepEqual(plain(h.visibleFrameFor(null, screens)), screens[0].visible);
  assert.equal(h.visibleFrameFor({ x: 0, y: 0, width: 1, height: 1 }, []), null);
  assert.deepEqual(plain(h.flipRect({ x: 0, y: 70, width: 1440, height: 805 }, 900)), { x: 0, y: 25, width: 1440, height: 805 });
});

// ===========================================================================
// uiTree through the AX bridge
// ===========================================================================

function nodeBy(nodes, pred) {
  const n = nodes.find(pred);
  assert.ok(n, 'node not found');
  return n;
}

test('ax uiTree: the window, its flattened children, ids, bounds, states and links', () => {
  const w = textEditWorld();
  const f = fakeMac(w.spec);
  const { ok } = loadHelper(f);
  const r = ok('uiTree', { pid: 501, number: 41 });
  assert.equal(r.engine, 'ax');
  assert.deepEqual(r.window, { id: '501:41', app: 'TextEdit', title: 'Notes.txt' });
  assert.equal(r.truncated, false);
  const [root] = r.nodes;
  assert.equal(root.role, 'window');
  assert.equal(root.name, 'Notes.txt');
  assert.equal(root.parent, null);
  assert.deepEqual(root.bounds, { x: 100, y: 50, width: 800, height: 600 });
  assert.match(root.id, /^mac:501:41:w:[0-9a-z]+$/);
  // Unnamed AXGroup > AXScrollArea are left out: the text area hangs off the window.
  const text = nodeBy(r.nodes, (n) => n.role === 'textbox' && n.name === 'Type here');
  assert.match(text.id, /^mac:501:41:w1\.0\.0:/);
  assert.equal(text.parent, root.id);
  assert.equal(text.value, 'Hello world');
  assert.equal(text.focused, true);
  assert.deepEqual(text.bounds, { x: 110, y: 130, width: 780, height: 400 });
  // Toolbar children, in order, with enabled flags.
  const toolbar = nodeBy(r.nodes, (n) => n.role === 'toolbar');
  const kids = toolbar.children.map((id) => r.nodes.find((n) => n.id === id));
  assert.deepEqual(kids.map((n) => [n.role, n.name, n.enabled]), [['button', 'Bold', true], ['button', 'Italic', false], ['combobox', 'Font', true]]);
  assert.equal(kids[2].value, 'Helvetica');
  assert.equal(nodeBy(r.nodes, (n) => n.name === 'Wrap lines').value, 'checked');
  assert.equal(nodeBy(r.nodes, (n) => n.name === 'Words: 2').role, 'text');
  const save = nodeBy(r.nodes, (n) => n.name === 'Save');
  assert.equal(save.description, 'Save the document');
  // The search field is named by its label element; its placeholder is not the name.
  assert.equal(nodeBy(r.nodes, (n) => n.role === 'textbox' && n.name === 'Search').bounds.x, 700);
  // Scrolled out of the window, and zero-size leaves, are left out.
  assert.ok(!r.nodes.some((n) => n.name === 'scrolled away'));
  assert.ok(!r.nodes.some((n) => n.name === 'spacer'));
  // Every child id points back to its parent.
  for (const n of r.nodes) for (const c of n.children) assert.equal(r.nodes.find((x) => x.id === c).parent, n.id);
  assert.equal(new Set(r.nodes.map((n) => n.id)).size, r.nodes.length, 'ids are unique');
  // One multi-attribute request per element read, no per-attribute requests once calibrated.
  assert.ok(f.stats.multi >= r.nodes.length, `${f.stats.multi} multi reads`);
  assert.ok(f.stats.copy < 30, `${f.stats.copy} single reads`);
});

test('ax uiTree: depth and maxNodes limits report truncated', () => {
  const w = textEditWorld();
  const { ok } = loadHelper(fakeMac(w.spec));
  const shallow = ok('uiTree', { pid: 501, number: 41, depth: 1 });
  assert.equal(shallow.truncated, true);
  assert.ok(!shallow.nodes.some((n) => n.name === 'Bold'), 'toolbar children are below depth 1');
  assert.ok(shallow.nodes.some((n) => n.role === 'toolbar'));
  const few = ok('uiTree', { pid: 501, number: 41, maxNodes: 3 });
  assert.equal(few.nodes.length, 3);
  assert.equal(few.truncated, true);
  const rootOnly = ok('uiTree', { pid: 501, number: 41, depth: 0 });
  assert.equal(rootOnly.nodes.length, 1);
  assert.equal(rootOnly.truncated, true);
});

test('ax uiTree: defaults to the frontmost app and its front window; pid alone picks the front window', () => {
  const w = textEditWorld();
  const { ok } = loadHelper(fakeMac(w.spec));
  assert.equal(ok('uiTree', {}).window.id, '501:41');
  assert.equal(ok('uiTree', { pid: 501 }).window.id, '501:41');
});

test('ax uiTree: an app without windows shows its menu bar', () => {
  const w = textEditWorld();
  const { ok } = loadHelper(fakeMac(w.spec));
  const r = ok('uiTree', { pid: 300 });
  assert.deepEqual(r.window, { id: '300', app: 'Finder', title: '' });
  assert.equal(r.nodes[0].role, 'menu');
  assert.ok(r.nodes.some((n) => n.role === 'menuitem' && n.name === 'File'));
  assert.match(r.nodes[0].id, /^mac:300:-:a\d+:/);
});

test('ax uiTree: open context menus of the app are extra roots', () => {
  const w = textEditWorld();
  w.textEdit.menus = [
    {
      role: 'AXMenu',
      pos: [300, 300],
      size: [150, 60],
      children: [{ role: 'AXMenuItem', title: 'Copy', pos: [300, 300], size: [150, 20], actions: ['AXPress'] }],
    },
  ];
  const { ok } = loadHelper(fakeMac(w.spec));
  const r = ok('uiTree', { pid: 501, number: 41 });
  const menu = nodeBy(r.nodes, (n) => n.role === 'menu');
  assert.equal(menu.parent, null);
  assert.match(menu.id, /^mac:501:41:a2:/, 'app child 2: after the window and the menu bar');
  assert.equal(r.nodes.find((n) => n.id === menu.children[0]).name, 'Copy');
});

test('ax uiTree: explicit windows that are gone or have no accessibility window are NOT_FOUND', () => {
  const w = textEditWorld();
  // A second CG window whose AX frame and title differ from what CG reports.
  w.textEdit.windows.push({ role: 'AXWindow', title: 'Palette', number: 77, pos: [5, 5], size: [200, 300], cgPos: [900, 700], cgTitle: 'Tools', children: [] });
  const { call } = loadHelper(fakeMac(w.spec));
  assert.equal(call('uiTree', { pid: 501, number: 99 }).code, 'NOT_FOUND');
  assert.match(call('uiTree', { pid: 501, number: 99 }).error, /window 99 was not found/);
  assert.equal(call('uiTree', { pid: 300, number: 41 }).code, 'NOT_FOUND', "window 41 is not Finder's");
  assert.equal(call('uiTree', { pid: 9999 }).code, 'NOT_FOUND');
  const r = call('uiTree', { pid: 501, number: 77 });
  assert.equal(r.code, 'NOT_FOUND');
  assert.match(r.error, /no accessibility window of TextEdit matches window 77/);
});

test('ax uiTree: every bridge calibration path gives the same tree', () => {
  const reference = loadHelper(fakeMac(textEditWorld().spec)).ok('uiTree', { pid: 501, number: 41 });
  const variants = [
    { personality: 'ref' },
    { attrForm: 'ns' },
    { attrForm: 'js' },
    { unwrapArrays: false },
    { noMulti: true },
    { personality: 'ref', attrForm: 'js', unwrapArrays: false, noMulti: true },
  ];
  for (const v of variants) {
    const f = fakeMac(textEditWorld().spec, v);
    const r = loadHelper(f).ok('uiTree', { pid: 501, number: 41 });
    assert.equal(r.engine, 'ax', JSON.stringify(v));
    assert.deepEqual(r.nodes, reference.nodes, JSON.stringify(v));
    if (v.noMulti) assert.equal(f.stats.multi, 0);
  }
});

test('ax uiTree: an unusable AX bridge falls back to System Events, once', () => {
  const f = fakeMac(textEditWorld().spec, { noAx: true });
  const { ok } = loadHelper(f);
  const r = ok('uiTree', { pid: 501, number: 41 });
  assert.equal(r.engine, 'systemEvents');
  assert.match(r.bridgeError, /AXUIElementCreateApplication is not available/);
  const reference = loadHelper(fakeMac(textEditWorld().spec)).ok('uiTree', { pid: 501, number: 41 });
  assert.deepEqual(
    r.nodes.map((n) => [n.id, n.role, n.name, n.value, n.bounds, n.parent]),
    reference.nodes.map((n) => [n.id, n.role, n.name, n.value, n.bounds, n.parent]),
    'System Events gives the same ids, roles, names and bounds',
  );
  // A bridge that cannot be calibrated is not tried again by this helper.
  const g = fakeMac(textEditWorld().spec, { attrForm: 'ns' });
  g.$.AXUIElementCopyAttributeValue = () => -25201; // every read is an illegal argument
  const h = loadHelper(g);
  assert.equal(h.ok('uiTree', { pid: 501, number: 41 }).engine, 'systemEvents');
  const created = g.stats.create;
  assert.equal(h.ok('uiTree', { pid: 501, number: 41 }).engine, 'systemEvents');
  assert.equal(g.stats.create, created, 'the AX bridge is marked broken');
});

test('ax uiTree: engine "ax" reports the bridge failure instead of falling back', () => {
  const { call } = loadHelper(fakeMac(textEditWorld().spec, { noAx: true }));
  const r = call('uiTree', { pid: 501, engine: 'ax' });
  assert.equal(r.code, 'AX_BRIDGE');
});

test('ax uiTree: no Accessibility is PERMISSION; a hung app is NOT_RESPONDING', () => {
  const untrusted = textEditWorld();
  untrusted.spec.trusted = false;
  let r = loadHelper(fakeMac(untrusted.spec)).call('uiTree', { pid: 501 });
  assert.equal(r.code, 'PERMISSION');
  assert.equal(r.perm, 'accessibility');
  const disabled = textEditWorld();
  disabled.spec.apiDisabled = true;
  r = loadHelper(fakeMac(disabled.spec)).call('uiTree', { pid: 501 });
  assert.equal(r.code, 'PERMISSION');
  assert.equal(r.perm, 'accessibility');
  assert.equal(r.errorNumber, -25211);
  const hung = textEditWorld();
  hung.textEdit.root = { role: 'AXApplication', title: 'TextEdit', hang: true };
  r = loadHelper(fakeMac(hung.spec)).call('uiTree', { pid: 501 });
  assert.equal(r.code, 'NOT_RESPONDING');
  assert.match(r.error, /TextEdit is not responding/);
});

test('ax uiTree: a hung element part way gives a partial tree marked notResponding', () => {
  const w = textEditWorld();
  w.window.children[0].children[2].hang = true; // the Font pop-up
  const r = loadHelper(fakeMac(w.spec)).ok('uiTree', { pid: 501, number: 41 });
  assert.equal(r.notResponding, true);
  assert.equal(r.nodes[0].role, 'window');
});

test('ax uiTree: lists show their visible rows (v<k> path segments)', () => {
  const w = textEditWorld();
  const rows = [];
  for (let i = 0; i < 50; i++) {
    rows.push({
      role: 'AXRow',
      pos: [110, 130 + (i - 10) * 20],
      size: [700, 20],
      selected: i === 11,
      children: [{ role: 'AXCell', children: [{ role: 'AXStaticText', value: `Message ${i}`, pos: [110, 130 + (i - 10) * 20], size: [300, 20] }] }],
    });
  }
  const table = { role: 'AXTable', pos: [100, 120], size: [800, 420], children: rows, visibleRows: [10, 11, 12] };
  w.window.children[1].children[0].children = [table];
  const r = loadHelper(fakeMac(w.spec)).ok('uiTree', { pid: 501, number: 41 });
  const t = nodeBy(r.nodes, (n) => n.role === 'table');
  assert.equal(t.children.length, 3);
  const rowNodes = t.children.map((id) => r.nodes.find((n) => n.id === id));
  assert.deepEqual(rowNodes.map((n) => n.id.split(':')[3]), ['w1.0.0.v0', 'w1.0.0.v1', 'w1.0.0.v2']);
  assert.deepEqual(rowNodes.map((n) => n.selected), [false, true, false]);
  assert.ok(r.nodes.some((n) => n.name === 'Message 11'));
  assert.ok(!r.nodes.some((n) => n.name === 'Message 30'), 'rows outside the visible part are not read');
});

// ===========================================================================
// Chromium and Electron web content
// ===========================================================================

test('ax uiTree: an empty Chromium web area gets accessibility switched on and is read again', () => {
  const b = braveWorld();
  const f = fakeMac(b.spec);
  const { ok } = loadHelper(f);
  const r = ok('uiTree', { pid: 777, number: 55 });
  assert.equal(r.enabledAccessibility, 'chromium');
  assert.equal(r.sparse, undefined);
  const sets = f.log.filter((e) => e[0] === 'set' && /Accessibility|EnhancedUserInterface/.test(e[2]));
  assert.deepEqual(sets, [['set', 'Brave Browser', 'AXManualAccessibility', true], ['set', 'Brave Browser', 'AXEnhancedUserInterface', true]]);
  const link = nodeBy(r.nodes, (n) => n.role === 'link' && n.name === 'For you');
  assert.equal(link.value, 'https://acme.atlassian.net/jira/for-you');
  assert.equal(nodeBy(r.nodes, (n) => n.role === 'heading').name, 'Assigned to me');
  // Once per process: the next tree does not switch it on again.
  b.webArea.children = [];
  const again = ok('uiTree', { pid: 777, number: 55 });
  assert.equal(again.enabledAccessibility, undefined);
  assert.equal(again.sparse, true);
  assert.equal(f.log.filter((e) => e[0] === 'set' && /Accessibility|EnhancedUserInterface/.test(e[2])).length, 2);
});

test('ax uiFind: an Electron app is detected by its framework and gets AXManualAccessibility only', () => {
  const content = { role: 'AXGroup', pos: [0, 30], size: [1000, 700], children: [] };
  const slack = {
    pid: 888,
    name: 'Slack',
    bundleId: 'com.tinyspeck.slackmacgap',
    bundlePath: '/Applications/Slack.app',
    accessibilityAttrs: ['AXManualAccessibility'],
    windows: [{ role: 'AXWindow', title: 'Slack', number: 90, pos: [0, 25], size: [1000, 740], children: [content] }],
  };
  slack.onEnable = (n, v) => {
    if (n === 'AXManualAccessibility' && v) {
      content.children = [
        {
          role: 'AXWebArea',
          title: 'Slack',
          pos: [0, 30],
          size: [1000, 700],
          children: [{ role: 'AXTextArea', desc: 'Message #general', value: '', pos: [20, 700], size: [900, 30], actions: [] }],
        },
      ];
    }
  };
  const f = fakeMac({ apps: [slack], front: 888, files: ['/Applications/Slack.app/Contents/Frameworks/Electron Framework.framework'] });
  const r = loadHelper(f).ok('uiFind', { pid: 888, role: 'textbox', name: 'message' });
  assert.equal(r.enabledAccessibility, 'electron');
  assert.equal(r.sparse, undefined);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].name, 'Message #general');
  assert.deepEqual(
    f.log.filter((e) => e[0] === 'set').map((e) => e[2]),
    ['AXManualAccessibility'],
    'AXEnhancedUserInterface is for Chromium browsers only',
  );
});

test('ax uiTree: native apps are never switched', () => {
  const w = textEditWorld();
  w.window.children = [];
  const f = fakeMac(w.spec);
  const r = loadHelper(f).ok('uiTree', { pid: 501, number: 41 });
  assert.equal(r.enabledAccessibility, undefined);
  assert.equal(r.sparse, undefined);
  assert.ok(!f.log.some((e) => e[0] === 'set'));
});

// ===========================================================================
// uiFind
// ===========================================================================

test('ax uiFind: by name, role, text; ranked; with readable paths', () => {
  const w = textEditWorld();
  const { ok, call } = loadHelper(fakeMac(w.spec));
  let r = ok('uiFind', { pid: 501, number: 41, name: 'save' });
  assert.deepEqual(r.window, { id: '501:41', app: 'TextEdit', title: 'Notes.txt' });
  assert.equal(r.matches.length, 1, 'the menu bar is not searched when the window has a match');
  const save = r.matches[0];
  assert.equal(save.role, 'button');
  assert.equal(save.name, 'Save');
  assert.equal(save.description, 'Save the document');
  assert.deepEqual(save.bounds, { x: 800, y: 600, width: 80, height: 30 });
  assert.equal(save.enabled, true);
  assert.equal(save.path, 'window "Notes.txt" > button "Save"');
  assert.match(save.id, /^mac:501:41:w4:/);
  // Role vocabulary, aliases and AX roles.
  assert.deepEqual(ok('uiFind', { pid: 501, number: 41, role: 'button' }).matches.map((m) => m.name), ['Bold', 'Save', 'close button', 'Italic']);
  assert.deepEqual(ok('uiFind', { pid: 501, number: 41, role: 'dropdown' }).matches.map((m) => m.name), ['Font']);
  assert.deepEqual(ok('uiFind', { pid: 501, number: 41, role: 'AXSearchField' }).matches.map((m) => m.name), ['Search']);
  // text matches values and placeholders too.
  r = ok('uiFind', { pid: 501, number: 41, text: 'hello' });
  assert.equal(r.matches[0].role, 'textbox');
  assert.equal(r.matches[0].value, 'Hello world');
  assert.equal(r.matches[0].path, 'window "Notes.txt" > textbox "Type here"', 'unnamed groups are left out of paths');
  assert.equal(ok('uiFind', { pid: 501, number: 41, text: 'find…' }).matches[0].name, 'Search');
  // exact, limit.
  assert.equal(ok('uiFind', { pid: 501, number: 41, name: 'sav', exact: true }).matches.length, 0);
  assert.equal(ok('uiFind', { pid: 501, number: 41, role: 'button', limit: 2 }).matches.length, 2);
  // Exact names before prefixes before substrings.
  r = ok('uiFind', { pid: 501, number: 41, name: 'wor' });
  assert.deepEqual(r.matches.map((m) => m.name), ['Words: 2']);
  assert.equal(call('uiFind', { pid: 501 }).code, 'BAD_ARGS');
});

test('ax uiFind: what the window shows comes before what is scrolled away', () => {
  const w = textEditWorld();
  // Earlier in document order, but scrolled below the window: a list of 200 more "Save" buttons.
  const below = { role: 'AXList', pos: [100, 3000], size: [800, 4000], children: [] };
  for (let i = 0; i < 200; i++) below.children.push(btn(`Save ${i}`, { title: 'Save', pos: [110, 3000 + i * 20], size: [80, 20] }));
  w.window.children.unshift(below);
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  let r = h.ok('uiFind', { pid: 501, number: 41, name: 'Save', limit: 1 });
  assert.equal(r.matches.length, 1);
  assert.deepEqual(r.matches[0].bounds, { x: 800, y: 600, width: 80, height: 30 }, 'the visible one');
  assert.ok(r.visited < 40, `the scrolled-away list was not entered (${r.visited} elements read)`);
  r = h.ok('uiFind', { pid: 501, number: 41, name: 'Save', limit: 3 });
  assert.deepEqual(r.matches.map((m) => m.bounds.y), [600, 3000, 3020]);
  assert.match(r.matches[1].path, /^window "Notes.txt" > group > button "Save"$/);
});

test('ax uiFind: menu items are found in the menu bar', () => {
  const w = textEditWorld();
  const { ok } = loadHelper(fakeMac(w.spec));
  let r = ok('uiFind', { pid: 501, number: 41, role: 'menuitem', name: 'save' });
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].name, 'Save…');
  assert.equal(r.matches[0].path, 'menu > menuitem "File" > menu > menuitem "Save…"');
  assert.match(r.matches[0].id, /^mac:501:41:a1\.1\.0\.0:/);
  // No match in the window: the menu bar is searched too, after window matches.
  r = ok('uiFind', { pid: 501, number: 41, name: 'close' });
  assert.deepEqual(r.matches.map((m) => [m.role, m.name]), [['button', 'close button']]);
  r = ok('uiFind', { pid: 501, number: 41, name: 'Close', exact: true });
  assert.deepEqual(r.matches.map((m) => [m.role, m.name]), [['menuitem', 'Close']]);
  // An app without windows: its menu bar.
  r = ok('uiFind', { pid: 300, name: 'File', exact: true });
  assert.deepEqual(r.matches.map((m) => m.role), ['menuitem']);
  assert.equal(r.window.id, '300');
});

// ===========================================================================
// uiAction
// ===========================================================================

function findId(h, args) {
  const r = h.ok('uiFind', { pid: 501, number: 41, ...args });
  assert.ok(r.matches.length, `no match for ${JSON.stringify(args)}`);
  return r.matches[0];
}

test('ax uiAction press: AXPress on the element its id names', () => {
  const w = textEditWorld();
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  const save = findId(h, { name: 'Save' });
  const r = h.ok('uiAction', { id: save.id, action: 'press' });
  assert.deepEqual(
    { ok: r.ok, method: r.method, id: r.id, resolved: r.resolved, role: r.role, name: r.name, windowId: r.windowId },
    { ok: true, method: 'AXPress', id: save.id, resolved: 'path', role: 'button', name: 'Save', windowId: '501:41' },
  );
  assert.deepEqual(r.bounds, save.bounds);
  assert.deepEqual(f.log.filter((e) => e[0] === 'perform'), [['perform', 'Save', 'AXPress']]);
  // A checkbox toggles; AXConfirm counts as pressing a search field.
  h.ok('uiAction', { id: findId(h, { name: 'Wrap lines' }).id, action: 'press' });
  assert.equal(w.wrap.value, 0);
  assert.equal(h.ok('uiAction', { id: findId(h, { name: 'Search' }).id, action: 'press' }).method, 'AXConfirm');
});

test('ax uiAction press: no press action is ok false with the supported actions', () => {
  const w = textEditWorld();
  w.window.children[3].actions = ['AXShowMenu'];
  const h = loadHelper(fakeMac(w.spec));
  const r = h.ok('uiAction', { id: findId(h, { name: 'Words: 2' }).id, action: 'press' });
  assert.equal(r.ok, false);
  assert.equal(r.method, 'none');
  assert.match(r.reason, /has no press action \(it supports AXShowMenu\)/);
});

test('ax uiAction press: rows without a press action are selected', () => {
  const w = textEditWorld();
  const row = { role: 'AXRow', selected: false, pos: [110, 200], size: [500, 20], children: [{ role: 'AXStaticText', value: 'Inbox', pos: [110, 200], size: [100, 20] }] };
  w.window.children.push({ role: 'AXOutline', pos: [100, 120], size: [600, 400], children: [row] });
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  const { ok, call } = h;
  const tree = ok('uiTree', { pid: 501, number: 41 });
  const rowNode = nodeBy(tree.nodes, (n) => n.role === 'treeitem');
  const r = ok('uiAction', { id: rowNode.id, action: 'press' });
  assert.deepEqual([r.ok, r.method], [true, 'AXSelected']);
  assert.equal(row.selected, true);
  assert.equal(call('uiAction', { id: rowNode.id, action: 'bogus' }).code, 'BAD_ARGS');
  assert.equal(call('uiAction', { id: 'not-an-id', action: 'press' }).code, 'BAD_ARGS');
});

test('ax uiAction: an AXPress the app does not confirm in time is ok, unconfirmed', () => {
  const w = textEditWorld();
  const save = w.window.children[4];
  save.onAction = () => -25204; // e.g. it opened a modal sheet
  const h = loadHelper(fakeMac(w.spec));
  const r = h.ok('uiAction', { id: findId(h, { name: 'Save' }).id, action: 'press' });
  assert.deepEqual([r.ok, r.method, r.confirmed], [true, 'AXPress', false]);
  assert.match(r.reason, /dialog or menu/);
});

test('ax uiAction: ids are re-resolved after the window changed, nearest to the old frame', () => {
  const w = textEditWorld();
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  const save = findId(h, { name: 'Save' });
  // A banner is inserted at the top: every later index shifts by one.
  w.window.children.unshift({ role: 'AXStaticText', value: 'Banner', pos: [100, 50], size: [800, 20] });
  f.prep(w.window.children[0], 501);
  let r = h.ok('uiAction', { id: save.id, action: 'press', frame: save.bounds });
  assert.deepEqual([r.ok, r.resolved, r.name], [true, 'search', 'Save']);
  assert.notEqual(r.id, save.id, 'the fresh id has the new path');
  assert.match(r.id, /^mac:501:41:w5:/);
  // Two identical buttons: the one nearest to where it was.
  const twin = { role: 'AXButton', title: 'Save', desc: 'Save the document', pos: [10, 10], size: [80, 30], actions: ['AXPress'] };
  w.window.children.push(twin);
  f.prep(twin, 501);
  r = h.ok('uiAction', { id: save.id, action: 'press', frame: save.bounds });
  assert.equal(r.resolved, 'search');
  assert.deepEqual(r.bounds, save.bounds);
  // Without a frame two candidates at the same distance from the old path are ambiguous.
  const id2 = save.id.replace(':w4:', ':w9:');
  assert.equal(h.call('uiAction', { id: id2, action: 'press' }).code, 'NOT_FOUND');
  // Gone entirely.
  w.window.children = w.window.children.filter((c) => c.title !== 'Save');
  r = h.call('uiAction', { id: save.id, action: 'press' });
  assert.equal(r.code, 'NOT_FOUND');
  assert.match(r.error, /no longer there/);
  // The window closed.
  w.window.closed = true;
  assert.equal(h.call('uiAction', { id: save.id, action: 'press' }).code, 'NOT_FOUND');
});

test('ax uiAction setValue: text is set and read back; checkboxes press only when needed', () => {
  const w = textEditWorld();
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  const text = findId(h, { role: 'textbox', name: 'Type here' });
  let r = h.ok('uiAction', { id: text.id, action: 'setValue', value: 'Dear team,\nhello' });
  assert.deepEqual([r.ok, r.method], [true, 'AXValue']);
  assert.equal(w.text.value, 'Dear team,\nhello');
  // An app that does not keep the value (e.g. a web field that reverts): ok false so the caller types.
  w.text.onSet = (n) => (n === 'AXValue' ? 0 : undefined);
  r = h.ok('uiAction', { id: findId(h, { role: 'textbox', name: 'Type here' }).id, action: 'setValue', value: 'other' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not keep the value/);
  // Not settable at all.
  w.text.onSet = null;
  w.text.settable = { AXValue: false };
  r = h.ok('uiAction', { id: findId(h, { role: 'textbox', name: 'Type here' }).id, action: 'setValue', value: 'x' });
  assert.deepEqual([r.ok, r.method], [false, 'none']);
  // Checkbox: already checked -> unchanged, no press; false -> press.
  const wrap = findId(h, { name: 'Wrap lines' });
  assert.equal(h.ok('uiAction', { id: wrap.id, action: 'setValue', value: 'on' }).method, 'unchanged');
  assert.equal(f.log.filter((e) => e[0] === 'perform').length, 0);
  assert.equal(h.ok('uiAction', { id: wrap.id, action: 'setValue', value: false }).method, 'AXPress');
  assert.equal(w.wrap.value, 0);
  assert.equal(h.call('uiAction', { id: wrap.id, action: 'setValue', value: 'maybe' }).code, 'BAD_ARGS');
  assert.equal(h.call('uiAction', { id: wrap.id, action: 'setValue' }).code, 'BAD_ARGS');
});

test('ax uiAction setValue: sliders take numbers and report where they snapped; password fields refuse', () => {
  const w = textEditWorld();
  const slider = { role: 'AXSlider', desc: 'Zoom', value: 50, pos: [300, 600], size: [100, 20], actions: ['AXIncrement', 'AXDecrement'] };
  slider.onSet = (n, v) => {
    if (n === 'AXValue') {
      slider.value = Math.round(v / 10) * 10;
      return 0;
    }
    return undefined;
  };
  const secret = { role: 'AXTextField', subrole: 'AXSecureTextField', desc: 'Password', value: '', pos: [300, 630], size: [100, 20] };
  w.window.children.push(slider, secret);
  const h = loadHelper(fakeMac(w.spec));
  let r = h.ok('uiAction', { id: findId(h, { name: 'Zoom' }).id, action: 'setValue', value: '73' });
  assert.deepEqual([r.ok, r.method, r.value], [true, 'AXValue', 70]);
  r = h.ok('uiAction', { id: findId(h, { name: 'Zoom' }).id, action: 'AXIncrement' });
  assert.deepEqual([r.ok, r.method], [true, 'AXIncrement']);
  r = h.ok('uiAction', { id: findId(h, { name: 'Password' }).id, action: 'setValue', value: 'hunter2' });
  assert.equal(r.ok, false);
  assert.equal(secret.value, '');
});

test('ax uiAction focus: brings the app forward, raises the window, focuses the element', () => {
  const w = textEditWorld();
  w.spec.front = 300;
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  const search = findId(h, { name: 'Search' });
  const r = h.ok('uiAction', { id: search.id, action: 'focus' });
  assert.deepEqual([r.ok, r.method], [true, 'AXFocused']);
  assert.equal(f.state.front, 501);
  assert.equal(w.search.focused, true);
  assert.ok(f.log.some((e) => e[0] === 'activate' && e[1] === 501));
  assert.ok(f.log.some((e) => e[0] === 'perform' && e[1] === 'Notes.txt' && e[2] === 'AXRaise'));
  // An app that will not come forward: not ok, so the caller clicks instead.
  w.textEdit.refuseActivation = true;
  f.state.front = 300;
  const again = h.ok('uiAction', { id: search.id, action: 'focus' });
  assert.equal(again.ok, false);
  assert.match(again.reason, /did not come to the front/);
});

test('ax uiAction select: a pop-up option is chosen from its menu', () => {
  const w = textEditWorld();
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  const font = findId(h, { name: 'Font' });
  let r = h.ok('uiAction', { id: font.id, action: 'select', value: 'times' });
  assert.deepEqual([r.ok, r.method], [true, 'menu']);
  assert.equal(w.font.value, 'Times New Roman');
  // The pop-up is opened with a short messaging timeout (opening can block until the menu closes).
  const timeouts = f.log.filter((e) => e[0] === 'timeout' && e[1] === 'Font').map((e) => e[2]);
  assert.deepEqual(timeouts, [0.6, 3]);
  // So is a plain press of a pop-up or a menu bar item; a menu still being tracked is fine.
  w.font.onAction = () => -25204;
  const press = h.ok('uiAction', { id: findId(h, { name: 'Font' }).id, action: 'press' });
  assert.deepEqual([press.ok, press.method, press.confirmed], [true, 'AXPress', false]);
  assert.deepEqual(f.log.filter((e) => e[0] === 'timeout' && e[1] === 'Font').map((e) => e[2]), [0.6, 3, 0.6, 3]);
  const save = h.ok('uiAction', { id: findId(h, { name: 'Save' }).id, action: 'press' });
  assert.equal(save.ok, true);
  assert.ok(!f.log.some((e) => e[0] === 'timeout' && e[1] === 'Save'), 'ordinary buttons keep the normal limit');
  // No such option: the menu is cancelled, ok false.
  r = h.ok('uiAction', { id: findId(h, { name: 'Font' }).id, action: 'select', value: 'Comic Sans' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no option named "Comic Sans"/);
  assert.ok(f.log.some((e) => e[0] === 'perform' && e[1] === 'Font' && e[2] === 'AXCancel') || f.log.some((e) => e[2] === 'AXCancel'));
});

test('ax uiAction select, expand, collapse, scrollIntoView, showMenu', () => {
  const w = textEditWorld();
  const tri = { role: 'AXDisclosureTriangle', value: 0, pos: [100, 300], size: [12, 12], actions: ['AXPress'] };
  tri.onAction = () => {
    tri.value = tri.value ? 0 : 1;
  };
  const row = { role: 'AXRow', pos: [100, 300], size: [500, 20], selected: false, children: [tri, { role: 'AXStaticText', value: 'Projects', pos: [120, 300], size: [100, 20] }] };
  const group = { role: 'AXGroup', title: 'Details', expanded: false, pos: [100, 400], size: [500, 100], actions: ['AXScrollToVisible', 'AXShowMenu'], children: [] };
  w.window.children.push({ role: 'AXOutline', pos: [100, 280], size: [600, 300], children: [row] }, group);
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  const tree = h.ok('uiTree', { pid: 501, number: 41 });
  const rowId = nodeBy(tree.nodes, (n) => n.role === 'treeitem').id;
  assert.equal(h.ok('uiAction', { id: rowId, action: 'select' }).method, 'AXSelected');
  assert.equal(row.selected, true);
  let r = h.ok('uiAction', { id: rowId, action: 'expand' });
  assert.deepEqual([r.ok, r.method], [true, 'AXDisclosureTriangle']);
  assert.equal(tri.value, 1);
  assert.equal(h.ok('uiAction', { id: rowId, action: 'expand' }).method, 'unchanged');
  const details = findId(h, { name: 'Details' });
  assert.equal(h.ok('uiAction', { id: details.id, action: 'expand' }).method, 'AXExpanded');
  assert.equal(group.expanded, true);
  assert.equal(h.ok('uiAction', { id: findId(h, { name: 'Details' }).id, action: 'collapse' }).method, 'AXExpanded');
  assert.equal(group.expanded, false);
  assert.equal(h.ok('uiAction', { id: details.id, action: 'scrollIntoView' }).method, 'AXScrollToVisible');
  assert.equal(h.ok('uiAction', { id: details.id, action: 'showMenu' }).method, 'AXShowMenu');
  r = h.ok('uiAction', { id: findId(h, { name: 'Save' }).id, action: 'scrollIntoView' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /AXScrollToVisible failed on this button \(error -25206\)/);
  // A menu bar item id does not depend on the window.
  const fileMenu = h.ok('uiFind', { pid: 501, number: 41, role: 'menuitem', name: 'Close', exact: true }).matches[0];
  w.window.closed = true;
  r = h.ok('uiAction', { id: fileMenu.id, action: 'press' });
  assert.deepEqual([r.ok, r.method, r.name], [true, 'AXPress', 'Close']);
});

// ===========================================================================
// System Events engine
// ===========================================================================

test('se: uiFind and uiAction through System Events', () => {
  const w = textEditWorld();
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  const save = h.ok('uiFind', { pid: 501, number: 41, name: 'Save', engine: 'systemEvents' });
  assert.equal(save.engine, 'systemEvents');
  assert.equal(save.matches[0].name, 'Save');
  const ax = h.ok('uiFind', { pid: 501, number: 41, name: 'Save' });
  assert.equal(save.matches[0].id, ax.matches[0].id, 'both engines make the same ids');
  let r = h.ok('uiAction', { id: save.matches[0].id, action: 'press', engine: 'systemEvents' });
  assert.deepEqual([r.ok, r.method, r.resolved], [true, 'AXPress', 'path']);
  assert.ok(f.log.some((e) => e[0] === 'se.perform' && e[1] === 'Save' && e[2] === 'AXPress'));
  const text = h.ok('uiFind', { pid: 501, number: 41, text: 'hello', engine: 'systemEvents' }).matches[0];
  r = h.ok('uiAction', { id: text.id, action: 'setValue', value: 'typed', engine: 'systemEvents' });
  assert.deepEqual([r.ok, r.method], [true, 'AXValue']);
  assert.equal(w.text.value, 'typed');
  r = h.ok('uiAction', { id: findId(h, { name: 'Font' }).id, action: 'select', value: 'Courier', engine: 'systemEvents' });
  assert.equal(r.ok, false, 'choosing pop-up options needs the AX engine');
});

test('se: a list whose values cannot be read in bulk is read element by element', () => {
  const w = textEditWorld();
  w.window.children[2].seValueError = true; // the checkbox breaks the bulk value read
  const r = loadHelper(fakeMac(w.spec)).ok('uiTree', { pid: 501, number: 41, engine: 'systemEvents' });
  assert.equal(nodeBy(r.nodes, (n) => n.name === 'Words: 2').role, 'text', 'static text is still named by its value');
});

test('se: refused Automation is PERMISSION automation', () => {
  const w = textEditWorld();
  w.spec.automationDenied = true;
  const r = loadHelper(fakeMac(w.spec, { noAx: true })).call('uiTree', { pid: 501 });
  assert.equal(r.code, 'PERMISSION');
  assert.equal(r.perm, 'automation');
});

// ===========================================================================
// setBounds
// ===========================================================================

test('setBounds: moves and resizes through System Events, keeping unspecified parts', () => {
  const w = textEditWorld();
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  let r = h.ok('setBounds', { pid: 501, number: 41, x: 10, y: 40, width: 640.4, height: 480 });
  assert.deepEqual(r, { ok: true, state: 'bounds', before: { x: 100, y: 50, width: 800, height: 600 }, frame: { x: 10, y: 40, width: 640, height: 480 } });
  assert.deepEqual(plain(f.log.filter((e) => e[0] === 'se.position' || e[0] === 'se.size')), [['se.position', 'Notes.txt', [10, 40]], ['se.size', 'Notes.txt', [640, 480]]]);
  r = h.ok('setBounds', { pid: 501, number: 41, x: 200 });
  assert.deepEqual(r.frame, { x: 200, y: 40, width: 640, height: 480 });
  // A size the old position constrained is set again after the move.
  let first = true;
  w.window.onResize = (v) => {
    w.window.size = first ? [v[0] - 100, v[1]] : [v[0], v[1]];
    first = false;
  };
  r = h.ok('setBounds', { pid: 501, number: 41, width: 900, height: 500 });
  assert.deepEqual(r.frame, { x: 200, y: 40, width: 900, height: 500 });
  assert.equal(f.log.filter((e) => e[0] === 'se.size').length, 4);
  assert.equal(h.call('setBounds', { pid: 501, number: 41 }).code, 'BAD_ARGS');
  assert.equal(h.call('setBounds', { pid: 501, number: 41, state: 'huge' }).code, 'BAD_ARGS');
  assert.deepEqual(h.ok('setBounds', { pid: 501, number: 4242, x: 1 }), { ok: false, reason: 'window 4242 not found' });
});

test('setBounds: maximize fills the visible frame of the window\'s screen', () => {
  const w = textEditWorld();
  // Primary 1440x900 (menu bar 25, Dock 70); a 1920x1080 display to its right, 180 pt lower.
  w.spec.screens = [
    { frame: [0, 0, 1440, 900], visible: [0, 70, 1440, 805] },
    { frame: [1440, -180, 1920, 1080], visible: [1440, -180, 1920, 1055] },
  ];
  w.window.pos = [1600, 300];
  w.window.size = [500, 400];
  const h = loadHelper(fakeMac(w.spec));
  const r = h.ok('setBounds', { pid: 501, number: 41, state: 'maximize' });
  assert.deepEqual(r.frame, { x: 1440, y: 25, width: 1920, height: 1055 });
  assert.deepEqual(r.before, { x: 1600, y: 300, width: 500, height: 400 });
});

test('setBounds: minimize, restore to a frame, and full screen', () => {
  const w = textEditWorld();
  const f = fakeMac(w.spec);
  const h = loadHelper(f);
  let r = h.ok('setBounds', { pid: 501, number: 41, state: 'minimize' });
  assert.equal(r.ok, true);
  assert.equal(w.window.minimized, true);
  r = h.ok('setBounds', { pid: 501, number: 41, state: 'restore', frame: { x: 20, y: 30, width: 700, height: 500 } });
  assert.equal(w.window.minimized, false);
  assert.deepEqual(r.frame, { x: 20, y: 30, width: 700, height: 500 });
  r = h.ok('setBounds', { pid: 501, number: 41, state: 'fullscreen' });
  assert.equal(r.ok, true);
  assert.equal(w.window.fullScreen, true);
  // Leaving full screen waits for the animation before moving.
  const slept = f.stats.sleep;
  r = h.ok('setBounds', { pid: 501, number: 41, state: 'restore' });
  assert.equal(w.window.fullScreen, false);
  assert.ok(f.stats.sleep - slept >= 0.99, `waited ${f.stats.sleep - slept} s`);
  // Old apps: the full screen button.
  w.window.settable = { AXFullScreen: false };
  const green = { role: 'AXButton', subrole: 'AXFullScreenButton', pos: [150, 56], size: [14, 16], actions: ['AXPress'] };
  green.onAction = () => {
    w.window.fullScreen = true;
  };
  w.window.children.push(green);
  f.prep(green, 501);
  w.window.fullScreen = false;
  assert.equal(h.ok('setBounds', { pid: 501, number: 41, state: 'fullscreen' }).ok, true);
  assert.equal(w.window.fullScreen, true);
});

test('setBounds: AXEnhancedUserInterface is off while a Chromium window moves', () => {
  const b = braveWorld();
  b.brave.root = { role: 'AXApplication', title: 'Brave Browser', enhancedUserInterface: true };
  const f = fakeMac(b.spec);
  const h = loadHelper(f);
  h.ok('setBounds', { pid: 777, number: 55, x: 0, y: 25, width: 1000, height: 700 });
  const seq = f.log.filter((e) => (e[0] === 'se.set' && e[2] === 'AXEnhancedUserInterface') || e[0] === 'se.position').map((e) => e[3] === undefined ? e[0] : `${e[0]}=${e[3]}`);
  assert.deepEqual(seq, ['se.set=false', 'se.position', 'se.set=true']);
  assert.equal(b.brave.root.enhancedUserInterface, true);
});

// ===========================================================================
// Driver (fake transport)
// ===========================================================================

function fakeTransport(handlers = {}) {
  return {
    calls: [],
    mode: 'serve',
    async request(cmd, args = {}, opts = {}) {
      this.calls.push({ cmd, args: plain(args), opts: { ...opts } });
      const h = handlers[cmd];
      if (typeof h === 'function') return h(args, opts);
      if (h !== undefined) return h;
      if (cmd === 'perms') return { accessibility: true, screenRecording: true };
      return { ok: true };
    },
    async restart() {},
    async close() {},
  };
}

function fakeRun() {
  return async (cmd) => (path.basename(cmd) === 'ps' ? { code: 1, stdout: '', stderr: '', timedOut: false, error: null } : { code: 0, stdout: '', stderr: '', timedOut: false, error: null });
}

function mkDriver(handlers, env = {}) {
  const t = fakeTransport(handlers);
  const d = D.createDriver({ transport: t, run: fakeRun(), which: (n) => `/usr/bin/${n}`, env: { HOME: '/Users/me', TERM_PROGRAM: 'iTerm.app', ...env }, pid: 4321 });
  const ui = () => t.calls.filter((c) => c.cmd !== 'perms');
  return { d, t, ui };
}

const TREE = {
  window: { id: '501:41', app: 'TextEdit', title: 'Notes.txt' },
  nodes: [
    { id: 'mac:501:41:w:a1', role: 'window', name: 'Notes.txt', bounds: { x: 100, y: 50, width: 800, height: 600 }, enabled: true, focused: false, parent: null, children: ['mac:501:41:w4:b2'] },
    {
      id: 'mac:501:41:w4:b2', role: 'button', name: 'Save', description: 'Save the document', bounds: { x: 800, y: 600, width: 80, height: 30 },
      enabled: true, focused: false, parent: 'mac:501:41:w:a1', children: [], extra: 'dropped',
    },
    { role: 'button' },
  ],
  truncated: true,
  engine: 'ax',
  visited: 12,
};

test('driver: has the UI automation methods of the Driver contract', () => {
  const { d } = mkDriver();
  for (const m of ['uiTree', 'uiFind', 'uiAction', 'setWindowBounds']) assert.equal(typeof d[m], 'function', m);
});

test('driver: uiTree sends the window, limits and budget, and normalizes the answer', async () => {
  const { d, ui } = mkDriver({ uiTree: TREE });
  const r = await d.uiTree({ windowId: '501:41', depth: 3, maxNodes: 99 });
  assert.deepEqual(ui(), [
    { cmd: 'uiTree', args: { pid: 501, number: 41, depth: 3, maxNodes: 99, budgetMs: 8000 }, opts: { timeoutMs: 26000 } },
  ]);
  assert.deepEqual(r.window, TREE.window);
  assert.equal(r.nodes.length, 2);
  assert.deepEqual(r.nodes[1], {
    id: 'mac:501:41:w4:b2', role: 'button', name: 'Save', description: 'Save the document', bounds: { x: 800, y: 600, width: 80, height: 30 },
    enabled: true, focused: false, parent: 'mac:501:41:w:a1', children: [],
  });
  assert.equal(r.truncated, true);
  assert.equal(r.engine, 'ax');
  assert.ok(r.notes.some((n) => /stopped at its node, depth or time limit/.test(n)));
  // Defaults: the active window, depth 6, 400 nodes; a listWindows entry and a bare pid work too.
  await d.uiTree();
  await d.uiTree({ windowId: { id: '777:55', app: 'Brave Browser' }, depth: 999, maxNodes: -5 });
  await d.uiTree({ windowId: '300' });
  assert.deepEqual(ui().slice(1).map((c) => c.args), [
    { depth: 6, maxNodes: 400, budgetMs: 8000 },
    { pid: 777, number: 55, depth: 50, maxNodes: 1, budgetMs: 8000 },
    { pid: 300, depth: 6, maxNodes: 400, budgetMs: 8000 },
  ]);
  await assert.rejects(d.uiTree({ windowId: 'Notes' }), { code: 'INVALID_ARGUMENT' });
});

test('driver: uiTree notes explain switched-on, sparse, hung and System Events trees', async () => {
  const { d } = mkDriver({
    uiTree: { ...TREE, truncated: false, enabledAccessibility: 'chromium', sparse: true, notResponding: true, engine: 'systemEvents', bridgeError: 'cannot read attributes' },
  });
  const r = await d.uiTree();
  assert.equal(r.enabledAccessibility, 'chromium');
  assert.equal(r.engine, 'systemEvents');
  const text = r.notes.join('\n');
  assert.match(text, /this Chromium browser was empty, so it was switched on \(AXManualAccessibility and AXEnhancedUserInterface\)/);
  assert.match(text, /exposes little to accessibility/);
  assert.match(text, /stopped answering/);
  assert.match(text, /System Events \(slower\).*cannot read attributes/);
  assert.doesNotMatch(text, /time limit/);
});

test('driver: uiFind validates the query and returns contract matches with the window id', async () => {
  const { d, ui } = mkDriver({
    uiFind: {
      window: { id: '501:41', app: 'TextEdit', title: 'Notes.txt' },
      matches: [
        { id: 'mac:501:41:w4:b2', role: 'button', name: 'Save', value: '', bounds: { x: 800, y: 600, width: 80, height: 30 }, enabled: true, path: 'window "Notes.txt" > button "Save"', description: 'Save the document' },
        { id: 'mac:501:41:a1.1.0.0:c3', role: 'menuitem', name: 'Save…', bounds: { x: 0, y: 0, width: 0, height: 0 }, enabled: true, path: 'menu > menuitem "File"' },
        null,
      ],
      truncated: false,
      engine: 'ax',
      sparse: true,
    },
  });
  await assert.rejects(d.uiFind({}), { code: 'INVALID_ARGUMENT', message: /needs a name, role or text/ });
  await assert.rejects(d.uiFind({ name: '  ' }), { code: 'INVALID_ARGUMENT' });
  const list = await d.uiFind({ windowId: '501:41', name: 'Save', role: 'button', exact: true, limit: 500 });
  assert.deepEqual(ui()[0], {
    cmd: 'uiFind',
    args: { pid: 501, number: 41, name: 'Save', role: 'button', exact: true, limit: 200, budgetMs: 8000 },
    opts: { timeoutMs: 26000 },
  });
  assert.deepEqual(list, [
    {
      id: 'mac:501:41:w4:b2', role: 'button', name: 'Save', value: '', bounds: { x: 800, y: 600, width: 80, height: 30 }, windowId: '501:41',
      path: 'window "Notes.txt" > button "Save"', enabled: true, description: 'Save the document',
    },
    { id: 'mac:501:41:a1.1.0.0:c3', role: 'menuitem', name: 'Save…', value: '', bounds: { x: 0, y: 0, width: 0, height: 0 }, windowId: '501:41', path: 'menu > menuitem "File"', enabled: true },
  ]);
  assert.deepEqual(list.window, { id: '501:41', app: 'TextEdit', title: 'Notes.txt' });
  assert.equal(list.engine, 'ax');
  assert.ok(list.notes.some((n) => /exposes little/.test(n)));
  assert.equal(JSON.stringify(list).includes('notes'), false, 'the extra properties are not enumerable');
  await d.uiFind({ text: 'hello' });
  assert.deepEqual(ui()[1].args, { text: 'hello', exact: false, limit: 20, budgetMs: 8000 });
});

test('driver: uiAction validates, passes the remembered frame, and normalizes the answer', async () => {
  const results = [];
  const { d, ui, t } = mkDriver({
    uiFind: { window: { id: '501:41' }, matches: [{ id: 'mac:501:41:w4:b2', role: 'button', name: 'Save', bounds: { x: 800, y: 600, width: 80, height: 30 } }] },
    uiAction: (args) => {
      results.push(args);
      return { ok: true, method: 'AXPress', id: 'mac:501:41:w5:b2', resolved: 'search', role: 'button', name: 'Save', bounds: { x: 800, y: 620, width: 80, height: 30 }, windowId: '501:41', confirmed: false, reason: 'slow' };
    },
  });
  await assert.rejects(d.uiAction({ id: 'abc', action: 'press' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(d.uiAction({ id: 'mac:501:41:w4:b2', action: 'smash' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(d.uiAction({ id: 'mac:501:41:w4:b2', action: 'setValue' }), { code: 'INVALID_ARGUMENT', message: /needs a value/ });
  assert.equal(t.calls.length, 0, 'nothing is sent for invalid arguments');
  await d.uiFind({ name: 'Save' });
  const r = await d.uiAction({ id: 'mac:501:41:w4:b2', action: 'press' });
  assert.deepEqual(results[0], { id: 'mac:501:41:w4:b2', action: 'press', frame: { x: 800, y: 600, width: 80, height: 30 } });
  assert.equal(ui()[1].opts.timeoutMs, 20000);
  assert.deepEqual(r, {
    ok: true, method: 'AXPress', reason: 'slow', confirmed: false, id: 'mac:501:41:w5:b2', role: 'button', name: 'Save',
    bounds: { x: 800, y: 620, width: 80, height: 30 }, windowId: '501:41', resolved: 'search',
  });
  // The fresh id is remembered with its new bounds; values keep their type; raw AX actions pass.
  await d.uiAction({ id: 'mac:501:41:w5:b2', action: 'setValue', value: 42 });
  assert.deepEqual(results[1], { id: 'mac:501:41:w5:b2', action: 'setValue', value: 42, frame: { x: 800, y: 620, width: 80, height: 30 } });
  await d.uiAction({ id: 'mac:501:41:w5:b2', action: 'select', value: { label: 'x' } });
  assert.equal(results[2].value, '[object Object]');
  await d.uiAction({ id: 'mac:501:41:w5:b2', action: 'AXIncrement' });
  assert.equal(results[3].action, 'AXIncrement');
  // After the cache lifetime no frame is sent.
  d._uiCache.get('mac:501:41:w5:b2').at -= D.UI_CACHE_TTL_MS + 1;
  await d.uiAction({ id: 'mac:501:41:w5:b2', action: 'press' });
  assert.equal(results[4].frame, undefined);
});

test('driver: uiAction NOT_FOUND carries a hint to find the element again', async () => {
  const { d } = mkDriver({
    uiAction: () => {
      const e = new Error('uiAction: the element is no longer there');
      e.code = 'NOT_FOUND';
      throw e;
    },
  });
  await assert.rejects(d.uiAction({ id: 'mac:501:41:w4:b2', action: 'press' }), (err) => err.code === 'NOT_FOUND' && /ui_find or ui_tree again/.test(err.hint));
});

test('driver: UI requests need Accessibility and say how to grant it', async () => {
  const { d, ui } = mkDriver({ perms: { accessibility: false, screenRecording: true } });
  for (const p of [d.uiTree(), d.uiFind({ name: 'x' }), d.uiAction({ id: 'mac:1:2:w:a', action: 'press' }), d.setWindowBounds('1:2', { x: 1 })]) {
    await assert.rejects(p, (err) => err.code === 'PERMISSION' && err.permission === 'accessibility' && /"iTerm"/.test(err.hint));
  }
  assert.equal(ui().length, 0);
});

test('driver: ANYWHERE_DARWIN_UI picks the engine', async () => {
  const { d, ui } = mkDriver({ uiTree: TREE }, { ANYWHERE_DARWIN_UI: 'systemEvents' });
  await d.uiTree();
  assert.equal(ui()[0].args.engine, 'systemEvents');
  const ax = mkDriver({ uiFind: { matches: [] } }, { ANYWHERE_DARWIN_UI: 'AX' });
  await ax.d.uiFind({ name: 'x' });
  assert.equal(ax.ui()[0].args.engine, 'ax');
});

test('driver: setWindowBounds validates, maps states and restores the frame from before maximize', async () => {
  const sent = [];
  let answer = { ok: true, state: 'maximize', before: { x: 100, y: 50, width: 800, height: 600 }, frame: { x: 0, y: 25, width: 1440, height: 805 } };
  const { d } = mkDriver({
    setBounds: (args) => {
      sent.push(plain(args));
      return answer;
    },
  });
  await assert.rejects(d.setWindowBounds('Notes', { x: 1 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(d.setWindowBounds('501:41', {}), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(d.setWindowBounds('501:41', { state: 'giant' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(d.setWindowBounds('501:41', { width: 1 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(d.setWindowBounds('501:41', { x: 'left' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(sent.length, 0);
  assert.equal(await d.setWindowBounds('501:41', { state: 'Maximized' }), true);
  assert.deepEqual(sent[0], { pid: 501, number: 41, state: 'maximize' });
  // A second maximize keeps the first saved frame.
  answer = { ok: true, before: { x: 0, y: 25, width: 1440, height: 805 } };
  await d.setWindowBounds({ id: '501:41' }, { state: 'maximize' });
  answer = { ok: true };
  assert.equal(await d.setWindowBounds('501:41', { state: 'normal' }), true);
  assert.deepEqual(sent[2], { pid: 501, number: 41, state: 'restore', frame: { x: 100, y: 50, width: 800, height: 600 } });
  await d.setWindowBounds('501:41', { state: 'restore' });
  assert.deepEqual(sent[3], { pid: 501, number: 41, state: 'restore' }, 'the saved frame was used up');
  await d.setWindowBounds('501:41', { x: 10, y: '20', width: 300 });
  assert.deepEqual(sent[4], { pid: 501, number: 41, x: 10, y: 20, width: 300 });
  await d.setWindowBounds('777', { state: 'full screen' });
  assert.deepEqual(sent[5], { pid: 777, state: 'fullscreen' });
  answer = { ok: false, reason: 'no matching accessibility window' };
  assert.equal(await d.setWindowBounds('501:41', { state: 'minimize' }), false);
});

test('driver: setWindowBounds returns false on helper failures but throws PERMISSION', async () => {
  let fail = 'TIMEOUT';
  const { d } = mkDriver({
    setBounds: () => {
      const e = new Error('boom');
      e.code = fail;
      if (fail === 'PERMISSION') e.permission = 'automation';
      throw e;
    },
  });
  assert.equal(await d.setWindowBounds('501:41', { x: 1 }), false);
  fail = 'PERMISSION';
  await assert.rejects(d.setWindowBounds('501:41', { x: 1 }), (err) => err.code === 'PERMISSION' && /System Events/.test(err.hint));
});

test('driver: capabilities report ui with notes, or a hint when Accessibility is missing', async () => {
  let caps = await mkDriver().d.capabilities();
  assert.equal(caps.ui, true);
  assert.equal(caps.uiHint, undefined);
  assert.ok(caps.notes.some((n) => /AXEnhancedUserInterface, AXManualAccessibility/.test(n) && /System Events \(Automation\)/.test(n)));
  caps = await mkDriver({ perms: { accessibility: false, screenRecording: true } }).d.capabilities();
  assert.equal(caps.ui, false);
  assert.match(caps.uiHint, /Privacy & Security → Accessibility/);
  assert.ok(caps.notes.some((n) => /UI automation .* also needs Accessibility/.test(n)));
});

test('driver: normalizeBounds and normalizeUiTree tolerate junk', () => {
  assert.deepEqual(D.normalizeBounds({ x: -0, y: NaN, width: -5, height: 'x' }), { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(D.normalizeBounds(null), { x: 0, y: 0, width: 0, height: 0 });
  const t = D.normalizeUiTree(null);
  assert.deepEqual(t, { window: { id: '', app: '', title: '' }, nodes: [], truncated: false, engine: 'ax' });
  assert.deepEqual(D.normalizeUiMatches({ matches: 'x' }), []);
});

// ===========================================================================
// End to end: the driver, the real transport and the helper in a fake osascript
// ===========================================================================

function writeFakeOsascript(dir, spec) {
  const file = path.join(dir, 'osascript');
  const src = `#!${process.execPath}
'use strict';
const fs = require('fs');
const vm = require('vm');
const helper = process.argv[4];
const rest = process.argv.slice(5);
const fakeMac = ${fakeMac.toString()};
const f = fakeMac(${JSON.stringify(spec)});
function readStdin() {
  const buf = Buffer.alloc(65536);
  for (;;) {
    try {
      const n = fs.readSync(0, buf, 0, buf.length, null);
      return n > 0 ? buf.toString('utf8', 0, n) : '';
    } catch (e) {
      if (e.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; }
      if (e.code === 'EOF') return '';
      throw e;
    }
  }
}
Object.assign(f.$, {
  NSFileHandle: {
    fileHandleWithStandardInput: { get availableData() { return { __text: readStdin() }; } },
    fileHandleWithStandardOutput: { writeData: (d) => fs.writeSync(1, d.__text) },
  },
  NSString: { alloc: { initWithDataEncoding: (d) => ({ __v: d.__text, isNil: () => false }) } },
});
const ctx = vm.createContext({ ObjC: f.ObjC, $: f.$, Ref: f.Ref, Application: f.Application });
vm.runInContext(fs.readFileSync(helper, 'utf8'), ctx, { filename: helper });
ctx.run(rest);
`;
  fs.writeFileSync(file, src, { mode: 0o755 });
  return file;
}

const posixOnly = process.platform === 'win32' ? 'needs an executable script (POSIX shebang)' : false;

test('e2e: uiFind, uiTree and uiAction through the real transport and a fake osascript', { skip: posixOnly, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-fake-macos-ui-'));
  const spec = {
    front: 501,
    apps: [
      {
        pid: 501,
        name: 'Café ☕',
        bundleId: 'com.example.cafe',
        windows: [
          {
            role: 'AXWindow',
            title: 'Menü — Bestellung',
            number: 41,
            pos: [100, 50],
            size: [800, 600],
            children: [
              { role: 'AXButton', title: 'Bestellen →', pos: [700, 600], size: [100, 30], actions: ['AXPress'] },
              { role: 'AXTextField', desc: 'Notiz', value: 'grüße', pos: [110, 100], size: [300, 22] },
            ],
          },
        ],
      },
    ],
  };
  const fake = writeFakeOsascript(dir, spec);
  const d = D.createDriver({ which: (n) => (n === 'osascript' ? fake : null), exists: () => false, run: fakeRun(), env: { ...process.env, TERM_PROGRAM: 'Apple_Terminal' } });
  try {
    const found = await d.uiFind({ windowId: '501:41', name: 'bestellen' });
    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'Bestellen →');
    assert.equal(found[0].windowId, '501:41');
    assert.equal(found.window.app, 'Café ☕');
    const tree = await d.uiTree({ windowId: '501:41' });
    assert.equal(tree.window.title, 'Menü — Bestellung');
    assert.equal(tree.nodes.find((n) => n.role === 'textbox').value, 'grüße');
    const r = await d.uiAction({ id: found[0].id, action: 'press' });
    assert.deepEqual([r.ok, r.method, r.resolved], [true, 'AXPress', 'path']);
    const set = await d.uiAction({ id: tree.nodes.find((n) => n.role === 'textbox').id, action: 'setValue', value: 'mit Milch ☕' });
    assert.deepEqual([set.ok, set.method], [true, 'AXValue']);
    assert.equal((await d.uiFind({ windowId: '501:41', text: 'milch' }))[0].value, 'mit Milch ☕');
    assert.equal(await d.setWindowBounds('501:41', { state: 'maximize' }), true);
    assert.deepEqual((await d.uiTree({ windowId: '501:41', depth: 0 })).nodes[0].bounds, { x: 0, y: 25, width: 1440, height: 805 });
  } finally {
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// ===========================================================================
// Live (macOS only; read-only)
// ===========================================================================

const LIVE = process.platform === 'darwin' && process.env.ANYWHERE_LIVE_DESKTOP === '1';

test(
  'live-desktop darwin ui: Finder menu bar and the front window through the accessibility API',
  { skip: LIVE ? false : 'live desktop checks run only on macOS with ANYWHERE_LIVE_DESKTOP=1', timeout: 180000 },
  async () => {
    // The AX engine only: a bridge failure should fail this check, not hide behind System Events.
    const d = D.createDriver({ env: { ...process.env, ANYWHERE_DARWIN_UI: 'ax' } });
    try {
      const caps = await d.capabilities();
      console.log(`[live-darwin-ui] ui=${caps.ui} accessibility=${caps.permissions && caps.permissions.accessibility}`);
      if (caps.permissions && caps.permissions.accessibility === false) {
        assert.equal(caps.ui, false);
        await assert.rejects(d.uiTree(), (err) => err.code === 'PERMISSION' && err.permission === 'accessibility' && /Accessibility/.test(err.hint));
        return;
      }
      const pgrep = spawnSync('pgrep', ['-x', 'Finder'], { encoding: 'utf8' });
      const finder = String(pgrep.stdout || '').trim().split('\n')[0];
      assert.ok(/^\d+$/.test(finder), 'Finder is running');
      const items = await d.uiFind({ windowId: finder, role: 'menuitem', name: 'File', exact: true });
      console.log('[live-darwin-ui] Finder "File":', JSON.stringify(items.slice(0, 2)), JSON.stringify(items.notes || []));
      assert.ok(items.length >= 1, 'Finder has a File menu');
      assert.equal(items[0].role, 'menuitem');
      assert.match(items[0].id, /^mac:\d+:/);
      assert.equal(items.engine, 'ax');
      let tree;
      try {
        tree = await d.uiTree({ maxNodes: 80 });
      } catch (err) {
        console.log(`[live-darwin-ui] uiTree of the front window: ${err.code} ${err.message}`);
        assert.ok(['NOT_FOUND', 'NOT_RESPONDING'].includes(err.code), err.message);
        return;
      }
      console.log(
        `[live-darwin-ui] front window ${JSON.stringify(tree.window)}: ${tree.nodes.length} nodes, roles ` +
          `${[...new Set(tree.nodes.map((n) => n.role))].join(',')}`,
      );
      assert.ok(tree.nodes.length >= 1);
      assert.ok(tree.nodes.every((n) => typeof n.id === 'string' && n.bounds && typeof n.bounds.x === 'number'));
    } finally {
      await d.close();
    }
  },
);
