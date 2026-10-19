'use strict';

/**
 * Desktop tools for the "virtual assistant" (docs/ARCHITECTURE.md §6): apps, windows and browsers.
 *
 *   list_apps {query?, limit?}                                  installed apps (fuzzy, with aliases)
 *   launch_app {name, args?, waitForWindow?, timeoutSec?, newInstance?, accessibility?, screenshotAfter?}
 *   quit_app {name, force?}
 *   set_window {window, bounds? | state?, screenshotAfter?}    move/resize, maximize, minimize, restore, fullscreen, halves
 *   wait_for {window?, text?, gone?, timeoutSec?, display?, exact?}
 *   browser_bookmarks {browser?, query?, folder?, profile?, limit?}
 *   browser_open {browser?, url, newTab?, newWindow?, screenshotAfter?}
 *   browser_tabs {browser?, cycle?}
 *   browser_switch_tab {browser?, match? | index?, screenshotAfter?}
 *
 * Loaded by src/mcp/tools.js (TOOL_MODULES) with the shared tool context `ext`. Anything that changes
 * the desktop (launching, quitting, moving windows, opening pages, switching tabs, the keyboard tab
 * cycle) is an input action: the user's pause guard (ext.checkGuard) and the failsafe corner first,
 * the dialog's activity feed afterwards. The operations themselves live in src/os/apps.js and
 * src/os/browsers.js; createDesktopOps() is shared with the CLI (`anywhere desktop ...`).
 */

const desktop = require('../context/desktop');
const appsLib = require('../os/apps');
const browsersLib = require('../os/browsers');
const { sameWindowId } = require('../os/linux');
const { truncate } = require('../shared/util');
const { createLogger } = require('../shared/log');

const log = createLogger('mcp-desktop');

const SETTLE_MS = 400;
const LIST_TIMEOUT_MS = 10000;
const DEFAULT_LAUNCH_TIMEOUT_SEC = 20;
const MAX_LAUNCH_TIMEOUT_SEC = 120;
const DEFAULT_WAIT_SEC = 15;
const MAX_WAIT_SEC = 120;
const WINDOW_POLL_MS = 400;
const TEXT_POLL_MS = 700;
const MAX_APPS_LISTED = 150;
const MAX_WINDOWS_LISTED = 15;
const MIN_WINDOW_SIDE = 50;
const WINDOW_STATES = ['maximize', 'minimize', 'restore', 'fullscreen', 'left-half', 'right-half'];

// ---------------------------------------------------------------- helpers

function toolError(message, code, hint) {
  const err = new Error(message);
  if (code) err.code = code;
  if (hint) err.hint = hint;
  return err;
}

function oneLine(s, max = 200) {
  return truncate(String(s == null ? '' : s).replace(/\s+/g, ' ').trim(), max);
}

function lower(s) {
  return String(s == null ? '' : s).toLowerCase();
}

function hasText(v) {
  return v != null && String(v).trim() !== '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(toolError(`${what} took longer than ${Math.round(ms / 1000)} s`, 'TIMEOUT')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function abortError() {
  const err = new Error('The request was cancelled');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

function sleepAbortable(ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (v == null || v === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function windowLabel(w) {
  if (!w) return 'unknown window';
  const app = oneLine(w.app, 60);
  const title = oneLine(w.title, 100);
  if (!title || title === app) return app || 'an untitled window';
  return app ? `${app} — "${title}"` : `"${title}"`;
}

function geometry(w) {
  return [w.width, w.height, w.x, w.y].every(Number.isFinite) ? `${w.width}x${w.height} at (${w.x}, ${w.y})` : '';
}

function windowLine(w) {
  const g = geometry(w);
  return `- id ${w.id}: ${windowLabel(w)}${g ? ` · ${g}` : ''}${w.focused ? ' [focused]' : ''}${w.minimized ? ' [minimized]' : ''}`;
}

function rankWindows(list) {
  return appsLib.rankWindows(list);
}

/**
 * The window a spec means: an id from list_windows, else part of a title, else part of an app name.
 * @returns {{window:object|null, matches:object[]}}
 */
function findWindow(windows, spec) {
  const s = hasText(spec) ? String(spec).trim() : '';
  const list = (windows || []).filter((w) => !desktop.isOwnWindow(w));
  if (!s) return { window: null, matches: [] };
  const byId = (windows || []).filter((w) => sameWindowId(w.id, s));
  if (byId.length) return { window: byId[0], matches: byId };
  const q = lower(s);
  let matches = list.filter((w) => lower(w.title).includes(q));
  if (!matches.length) matches = list.filter((w) => lower(w.app).includes(q));
  if (!matches.length) return { window: null, matches: [] };
  const exact = matches.filter((w) => lower(w.title) === q || lower(w.app) === q);
  const ranked = rankWindows(exact.length ? exact : matches);
  return { window: ranked[0], matches: ranked };
}

function noWindowError(windows, spec) {
  const listing = rankWindows((windows || []).filter((w) => !desktop.isOwnWindow(w)))
    .slice(0, MAX_WINDOWS_LISTED)
    .map(windowLine)
    .join('\n');
  return toolError(`No window matches "${spec}". Open windows:\n${listing || '(none)'}`, 'NOT_FOUND', 'Pass a window id from list_windows, or part of its title or app name.');
}

function loadOcr() {
  try {
    return require('../os/ocr');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /os[\\/]ocr/.test(String(err.message))) return null;
    throw err;
  }
}

// ---------------------------------------------------------------- operations (shared with the CLI)

/**
 * The desktop operations behind the tools, returning plain results.
 * @param {{getComputer:Function, checkGuard?:Function, deps?:{apps?:object, browsers?:object, ocr?:object|null,
 *   appDeps?:object, sleep?:Function, now?:Function}}} ctx
 */
function createDesktopOps(ctx = {}) {
  const deps = ctx.deps || {};
  const A = deps.apps || appsLib;
  const B = deps.browsers || browsersLib;
  const osDeps = { isOwnWindow: desktop.isOwnWindow, ...(deps.appDeps || {}) };
  const now = deps.now || (() => Date.now());
  const pause = deps.sleep || sleepAbortable;
  const guard = typeof ctx.checkGuard === 'function' ? ctx.checkGuard : async () => {};
  const ocrMod = () => (deps.ocr !== undefined ? deps.ocr : loadOcr());

  async function computer() {
    if (typeof ctx.getComputer !== 'function') throw toolError('Desktop control is not available in this process.', 'UNSUPPORTED');
    const c = await ctx.getComputer();
    if (!c) throw toolError('Desktop control is not available in this process.', 'UNSUPPORTED', 'Run "anywhere doctor" to see what is missing on this machine.');
    return c;
  }

  async function driverOrNull() {
    try {
      const c = await computer();
      return c.driver || null;
    } catch {
      return null;
    }
  }

  async function windowsOf(driver) {
    if (!driver || typeof driver.listWindows !== 'function') return [];
    try {
      return (await withTimeout(driver.listWindows(), LIST_TIMEOUT_MS, 'Listing windows')) || [];
    } catch (err) {
      if (err && err.code === 'UNSUPPORTED') return [];
      throw err;
    }
  }

  /** The pause guard and the failsafe corner, before anything that changes the desktop. */
  async function preflight(comp) {
    await guard();
    if (!comp) return;
    try {
      await require('./tools-browser').computerPreflight(comp);
    } catch (err) {
      if (err && (err.code === 'FAILSAFE' || err.code === 'PAUSED')) throw err;
      log.debug('preflight skipped:', err && err.message);
    }
  }

  // ------------------------------------------------------------ apps

  async function listApps({ query, limit } = {}) {
    const q = hasText(query) ? String(query).trim() : '';
    const max = clampInt(limit, 1, 500, q ? 15 : MAX_APPS_LISTED);
    const res = await A.listApps({ query: q || undefined, limit: q ? max : 0 }, osDeps);
    const driver = await driverOrNull();
    const wins = (await windowsOf(driver)).filter((w) => !desktop.isOwnWindow(w));
    const apps = (q ? res.apps : res.apps.slice(0, max)).map((a) => ({ ...a, running: wins.some((w) => A.windowMatchesApp(w, a)) }));
    return { platform: res.platform, total: res.total, query: q, apps, shown: apps.length, notes: res.notes || [] };
  }

  async function launchApp(args = {}, { signal } = {}) {
    const name = String(args.name || '').trim();
    if (!name) throw toolError('Which app? Pass its name, e.g. "Figma" or "VS Code".', 'INVALID_INPUT');
    const comp = await computer();
    await preflight(comp);
    const timeoutSec = clampInt(args.timeoutSec, 1, MAX_LAUNCH_TIMEOUT_SEC, DEFAULT_LAUNCH_TIMEOUT_SEC);
    return A.launch(
      name,
      {
        args: Array.isArray(args.args) ? args.args.map(String) : [],
        waitForWindow: args.waitForWindow !== false,
        timeoutMs: timeoutSec * 1000,
        newInstance: Boolean(args.newInstance),
        accessibility: Boolean(args.accessibility),
        driver: comp.driver,
        signal,
      },
      osDeps
    );
  }

  async function quitApp(args = {}) {
    const name = String(args.name || '').trim();
    if (!name) throw toolError('Which app? Pass its name.', 'INVALID_INPUT');
    const comp = await computer();
    await preflight(comp);
    return A.quit(name, { force: Boolean(args.force), driver: comp.driver }, osDeps);
  }

  // ------------------------------------------------------------ windows

  async function setWindow(args = {}) {
    const spec = hasText(args.window) ? String(args.window).trim() : '';
    if (!spec) throw toolError('Which window? Pass an id from list_windows, or part of its title or app name.', 'INVALID_INPUT');
    const hasBounds = args.bounds && typeof args.bounds === 'object';
    const state = hasText(args.state) ? String(args.state).trim().toLowerCase() : '';
    if (!hasBounds && !state) throw toolError('Pass bounds {x, y, width, height} or a state (maximize, minimize, restore, fullscreen, left-half, right-half).', 'INVALID_INPUT');
    if (hasBounds && state) throw toolError('Pass either bounds or state, not both.', 'INVALID_INPUT');
    if (state && !WINDOW_STATES.includes(state)) throw toolError(`state must be one of ${WINDOW_STATES.join(', ')}`, 'INVALID_INPUT');
    const comp = await computer();
    const driver = comp.driver;
    if (!driver || typeof driver.setWindowBounds !== 'function') throw toolError('This desktop driver cannot move or resize windows.', 'UNSUPPORTED');
    const windows = await windowsOf(driver);
    const { window: w, matches } = findWindow(windows, spec);
    if (!w) throw noWindowError(windows, spec);
    // F3-SAFE-D1: the dialog stays where the user put it, where its cards can be seen (LIVE-3).
    if (desktop.isOwnWindow(w)) {
      throw toolError('That is the Claude Anywhere dialog, which Claude may not move, resize or minimize.', 'OWN_DIALOG', 'If it covers something you need, ask the user to move it.');
    }
    let target;
    if (hasBounds) {
      const b = args.bounds;
      const nums = ['x', 'y', 'width', 'height'].map((k) => Number(b[k]));
      if (nums.some((n) => !Number.isFinite(n))) throw toolError('bounds needs numbers x, y, width and height', 'INVALID_INPUT');
      if (nums[2] < MIN_WINDOW_SIDE || nums[3] < MIN_WINDOW_SIDE) throw toolError(`width and height must be at least ${MIN_WINDOW_SIDE}`, 'INVALID_INPUT');
      target = { x: Math.round(nums[0]), y: Math.round(nums[1]), width: Math.round(nums[2]), height: Math.round(nums[3]) };
    } else if (state === 'left-half' || state === 'right-half') {
      const displays = typeof driver.displays === 'function' ? await driver.displays() : [];
      const cx = (Number(w.x) || 0) + (Number(w.width) || 0) / 2;
      const cy = (Number(w.y) || 0) + (Number(w.height) || 0) / 2;
      const d = displays.find((x) => cx >= x.x && cx < x.x + x.width && cy >= x.y && cy < x.y + x.height) || displays.find((x) => x.primary) || displays[0];
      if (!d) throw toolError('The display of this window is unknown', 'UNSUPPORTED');
      const half = Math.floor(d.width / 2);
      target = { x: state === 'left-half' ? d.x : d.x + half, y: d.y, width: half, height: d.height };
      // A maximized window ignores a new size on some desktops: restore it first.
      await preflight(comp);
      await driver.setWindowBounds(w.id, { state: 'restore' }).catch(() => false);
    } else {
      target = { state };
    }
    await preflight(comp);
    const ok = await driver.setWindowBounds(w.id, target);
    if (!ok) throw toolError(`The window ${windowLabel(w)} could not be ${target.state ? `set to ${target.state}` : 'moved'}`, 'FAILED', 'It may have closed or refuse to resize (fixed-size dialogs); list the windows again.');
    await sleep(150);
    const after = (await windowsOf(driver)).find((x) => sameWindowId(x.id, w.id)) || null;
    return { window: w, after, target, state: state || null, ambiguous: matches.length > 1 ? matches.length : 0 };
  }

  /** The window's rectangle in screenshot pixels of its display (for OCR), or null. */
  async function windowRegion(comp, w) {
    if (!w || typeof comp.screenInfo !== 'function' || typeof comp.toShot !== 'function') return null;
    try {
      const info = await comp.screenInfo();
      const ds = info.displays || [];
      const cx = w.x + w.width / 2;
      const cy = w.y + w.height / 2;
      const idx = ds.findIndex((d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height);
      if (idx < 0) return null;
      const d = ds[idx];
      const W = d.lastShot ? d.lastShot.width : d.width;
      const H = d.lastShot ? d.lastShot.height : d.height;
      const a = comp.toShot(idx, w.x, w.y);
      const b = comp.toShot(idx, w.x + w.width, w.y + w.height);
      const x = Math.max(0, Math.min(W - 1, a.x));
      const y = Math.max(0, Math.min(H - 1, a.y));
      const width = Math.min(W, b.x) - x;
      const height = Math.min(H, b.y) - y;
      if (width < 8 || height < 8) return null;
      return { display: idx, region: { x, y, width, height } };
    } catch (err) {
      log.debug('window region unknown:', err && err.message);
      return null;
    }
  }

  /**
   * Find text once: OCR when an engine is available, else the accessibility tree.
   * @returns {Promise<{method:string, matches:object[]}>}
   */
  async function findTextOnce(comp, { text, display, region, exact, windowId }, state) {
    const ocr = ocrMod();
    if (ocr && state.ocr !== false) {
      if (state.ocr == null) {
        try {
          const av = await ocr.available();
          state.ocr = Boolean(av && av.engine);
          state.ocrHint = av && av.hint;
        } catch {
          state.ocr = false;
        }
      }
      if (state.ocr) {
        try {
          const matches = await ocr.findText(comp, { text, display, region, exact, limit: 5 });
          return { method: 'ocr', matches: matches || [] };
        } catch (err) {
          if (err && err.code === 'OCR_UNAVAILABLE') {
            state.ocr = false;
            state.ocrHint = err.hint;
          } else throw err;
        }
      }
    }
    const driver = comp.driver;
    if (driver && typeof driver.uiFind === 'function' && state.ui !== false) {
      try {
        // Through the Computer when it can, so each match also has its centre in screenshot pixels.
        const query = { windowId, text, exact: Boolean(exact), limit: 5 };
        const list = typeof comp.uiFind === 'function' ? await comp.uiFind(query) : await driver.uiFind(query);
        return {
          method: 'accessibility',
          matches: (list || []).map((m) => ({
            text: m.name || m.value || text,
            bounds: m.bounds,
            windowId: m.windowId,
            ...(m.shot ? { shot: m.shot, display: m.shot.display } : {}),
          })),
        };
      } catch (err) {
        if (err && (err.code === 'UNSUPPORTED' || err.code === 'NOT_FOUND')) state.ui = false;
        else throw err;
      }
    }
    throw toolError(
      'Cannot look for text on this screen: no OCR engine is available and the window is not readable through accessibility.',
      'OCR_UNAVAILABLE',
      state.ocrHint || 'Install tesseract (Linux: sudo apt install tesseract-ocr), or take screenshots and look yourself.'
    );
  }

  /**
   * Wait until a window appears (or is gone), and/or text shows up (or disappears) on screen.
   * @returns {Promise<{ok:boolean, waitedMs:number, window?:object, match?:object, method?:string, timedOut?:boolean, what:string}>}
   */
  async function waitFor(args = {}, { signal, onProgress } = {}) {
    const winSpec = hasText(args.window) ? String(args.window).trim() : '';
    const text = hasText(args.text) ? String(args.text).trim() : '';
    if (!winSpec && !text) throw toolError('Pass window (a title, app or id) and/or text to wait for.', 'INVALID_INPUT');
    const gone = Boolean(args.gone);
    const timeoutMs = clampInt(args.timeoutSec, 1, MAX_WAIT_SEC, DEFAULT_WAIT_SEC) * 1000;
    const comp = await computer();
    const driver = comp.driver;
    const start = now();
    const state = {};
    const what = [winSpec ? `window "${winSpec}"` : '', text ? `text "${oneLine(text, 60)}"` : ''].filter(Boolean).join(' with ');
    let lastWindow = null;
    let method = null;
    for (let pass = 0; ; pass++) {
      if (signal && signal.aborted) throw abortError();
      let win = null;
      if (winSpec) {
        win = findWindow(await windowsOf(driver), winSpec).window;
        if (win) lastWindow = win;
      }
      const done = (kind, extra) => ({ ok: true, kind, waitedMs: now() - start, what, gone, method, window: win || lastWindow, ...extra });
      if (!text) {
        if (!gone && win) return done('window');
        if (gone && !win) return done('window-gone');
      } else if (winSpec && !win) {
        if (gone) return done('window-gone');
      } else {
        const where = win ? await windowRegion(comp, win) : null;
        const display = where ? where.display : args.display != null ? Number(args.display) : undefined;
        const found = await findTextOnce(comp, { text, display, region: where ? where.region : undefined, exact: Boolean(args.exact), windowId: win ? win.id : undefined }, state);
        method = found.method;
        if (!gone && found.matches.length) return done('text', { match: found.matches[0], matches: found.matches });
        if (gone && !found.matches.length) return done('text-gone');
      }
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) return { ok: false, kind: 'timeout', timedOut: true, waitedMs: elapsed, method, window: lastWindow, what, gone };
      if (typeof onProgress === 'function') onProgress(Math.round(elapsed / 1000));
      await pause(Math.min(text ? TEXT_POLL_MS : WINDOW_POLL_MS, Math.max(50, timeoutMs - elapsed)), signal);
    }
  }

  // ------------------------------------------------------------ browsers

  async function bookmarks(args = {}) {
    const driver = await driverOrNull();
    const wins = await windowsOf(driver);
    const linux = require('../os/linux');
    const prefer = [...new Set(linux.browserWindows(wins, '', { exclude: desktop.isOwnWindow }).map((c) => c.browser.id))];
    return B.bookmarks(
      {
        browser: hasText(args.browser) ? args.browser : undefined,
        query: hasText(args.query) ? args.query : undefined,
        folder: hasText(args.folder) ? args.folder : undefined,
        profile: hasText(args.profile) ? args.profile : undefined,
        limit: clampInt(args.limit, 1, 500, 50),
        prefer,
      },
      osDeps
    );
  }

  async function browserOpen(args = {}, { signal } = {}) {
    if (!hasText(args.url)) throw toolError('Pass the url to open.', 'INVALID_INPUT');
    const comp = await computer();
    await preflight(comp);
    return B.open(
      {
        browser: hasText(args.browser) ? args.browser : undefined,
        url: String(args.url),
        newTab: args.newTab !== false,
        newWindow: Boolean(args.newWindow),
        driver: comp.driver,
        computer: comp,
        beforeInput: guard,
        signal,
      },
      osDeps
    );
  }

  async function browserTabs(args = {}) {
    const comp = await computer();
    if (args.cycle) await preflight(comp);
    return B.listTabs({ browser: hasText(args.browser) ? args.browser : undefined, cycle: Boolean(args.cycle), driver: comp.driver, computer: comp, beforeInput: guard }, osDeps);
  }

  async function browserSwitchTab(args = {}) {
    const comp = await computer();
    await preflight(comp);
    return B.switchTab(
      {
        browser: hasText(args.browser) ? args.browser : undefined,
        match: hasText(args.match) ? String(args.match) : undefined,
        index: args.index != null && args.index !== '' ? Number(args.index) : undefined,
        driver: comp.driver,
        computer: comp,
        beforeInput: guard,
      },
      osDeps
    );
  }

  return { listApps, launchApp, quitApp, setWindow, waitFor, bookmarks, browserOpen, browserTabs, browserSwitchTab, findWindow };
}

// ---------------------------------------------------------------- text for the model

const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', wsl: 'Windows (from WSL)', linux: 'Linux' };

function appLine(a) {
  const where = a.kind === 'bundle' ? a.path : a.kind === 'desktop' ? a.desktopId : a.kind === 'shortcut' ? a.folder || 'Start menu' : a.kind === 'store' ? 'Store app' : a.kind === 'exec' ? a.path : a.kind;
  const id = a.bundleId ? ` (${a.bundleId})` : '';
  return `- ${a.name}${a.running ? ' [running]' : ''}${where ? ` — ${oneLine(where, 120)}` : ''}${id}`;
}

function formatApps(r) {
  const os = PLATFORM_NAMES[r.platform] || r.platform;
  const lines = [];
  if (r.query) {
    lines.push(r.apps.length ? `Installed apps matching "${r.query}" (${os}, ${r.total} apps in total), best first:` : `No installed app matches "${r.query}" (${os}, ${r.total} apps in total).`);
  } else {
    lines.push(`${r.total} installed apps (${os})${r.shown < r.total ? `; the first ${r.shown} by name (pass query to search)` : ''}:`);
  }
  for (const a of r.apps) lines.push(appLine(a));
  if (r.notes && r.notes.length) lines.push('', `Note: ${r.notes.join(' ')}`);
  lines.push('', 'Start one with launch_app {name}; [running] apps have a window open (launch_app focuses it).');
  return lines.join('\n');
}

function formatLaunch(r, timeoutSec) {
  const name = r.app.name;
  const parts = [];
  if (r.alreadyRunning && !r.launched) {
    parts.push(`${name} was already running; ${r.focused ? 'focused' : 'found'} its window ${windowLabel(r.window)} (id ${r.window.id}${geometry(r.window) ? `, ${geometry(r.window)}` : ''}).`);
  } else if (r.window) {
    const fresh = r.matchedBy === 'existing' ? 'its window' : 'its new window';
    parts.push(`Launched ${name} (${r.how}) and ${r.focused ? 'focused' : 'found'} ${fresh} ${windowLabel(r.window)} (id ${r.window.id}${geometry(r.window) ? `, ${geometry(r.window)}` : ''}) after ${(r.waitedMs / 1000).toFixed(1)} s.`);
  } else if (r.timedOut) {
    parts.push(`Started ${name} (${r.how}), but no window of it appeared within ${timeoutSec} s. It may still be loading (wait_for {window: "${oneLine(name, 40)}"}), or it runs in the background or the tray.`);
  } else {
    parts.push(`Started ${name} (${r.how}).`);
  }
  if (r.alternatives && r.alternatives.length) parts.push(`Other matches: ${r.alternatives.map((a) => a.name).slice(0, 5).join(', ')} (pass the exact name for another).`);
  for (const n of r.notes || []) parts.push(n);
  if (r.window && !r.focused && !r.timedOut) parts.push('It could not be brought to the front; call focus_window with its id.');
  parts.push('Take a screenshot before acting in it.');
  return parts.join(' ');
}

function formatQuit(r, force) {
  if (!r.found) return (r.notes && r.notes[0]) || `${r.app.name} was not running.`;
  const parts = [];
  if (r.running) parts.push(`Asked ${r.app.name} to quit (${r.how}).`);
  else parts.push(`Quit ${r.app.name}${force ? ' (forced)' : ''} (${r.how}).`);
  if (r.windowsLeft && r.windowsLeft.length) parts.push(`Still open: ${r.windowsLeft.slice(0, 5).map((w) => `${windowLabel(w)} (id ${w.id})`).join(', ')}.`);
  for (const n of r.notes || []) parts.push(n);
  return parts.join(' ');
}

function formatSetWindow(r) {
  const w = r.after || r.window;
  const what = r.state ? (r.state.includes('half') ? `moved to the ${r.state.replace('-', ' ')} of its display` : `${r.state === 'minimize' ? 'minimized' : r.state === 'maximize' ? 'maximized' : r.state === 'restore' ? 'restored' : 'made full screen'}`) : `moved to ${r.target.width}x${r.target.height} at (${r.target.x}, ${r.target.y})`;
  const now = r.after && geometry(r.after) ? ` It is now ${geometry(r.after)}${r.after.minimized ? ' (minimized)' : ''}.` : '';
  const amb = r.ambiguous ? ` ${r.ambiguous} windows matched; the frontmost one was used.` : '';
  return `Window ${windowLabel(w)} (id ${r.window.id}) ${what}.${now}${amb} Coordinates are screen units as list_windows reports them (not screenshot pixels); take a new screenshot before clicking.`;
}

function formatWaitFor(r, timeoutSec) {
  const secs = (r.waitedMs / 1000).toFixed(1);
  if (!r.ok) {
    const how = r.method === 'accessibility' ? ' (searched the accessibility tree; no OCR engine is installed)' : '';
    return `Timed out after ${timeoutSec} s: the ${r.what} ${r.gone ? 'is still there' : 'did not appear'}${how}. Take a screenshot to see what is on screen.`;
  }
  if (r.kind === 'text') {
    const m = r.match;
    const display = m.display != null ? m.display : 0;
    const at = m.shot ? ` at (${m.shot.cx}, ${m.shot.cy}) on display ${display}` : m.bounds ? ` (screen bounds ${m.bounds.width}x${m.bounds.height} at ${m.bounds.x},${m.bounds.y})` : '';
    const win = r.window ? ` in ${windowLabel(r.window)}` : '';
    const more = r.matches && r.matches.length > 1 ? ` ${r.matches.length - 1} more match${r.matches.length === 2 ? '' : 'es'} on screen.` : '';
    return `Found "${oneLine(m.text, 80)}"${win}${at} after ${secs} s (${r.method === 'ocr' ? 'OCR' : 'accessibility tree'}).${m.shot ? ` Those are pixels of your latest screenshot of display ${display}: click {x: ${m.shot.cx}, y: ${m.shot.cy}, display: ${display}} hits it.` : ''}${more}`;
  }
  if (r.kind === 'window') return `Window ${windowLabel(r.window)} (id ${r.window.id}${geometry(r.window) ? `, ${geometry(r.window)}` : ''}) is open (after ${secs} s).`;
  if (r.kind === 'window-gone') return `The ${r.what} is gone (after ${secs} s).`;
  return `The ${r.what} is no longer on screen (after ${secs} s).`;
}

function formatBookmarks(r, args) {
  const lines = [];
  const filters = [args.browser ? `browser ${args.browser}` : '', args.query ? `"${args.query}"` : '', args.folder ? `folder "${args.folder}"` : '', args.profile ? `profile "${args.profile}"` : ''].filter(Boolean).join(', ');
  if (!r.items.length) {
    lines.push(`No bookmarks found${filters ? ` for ${filters}` : ''}.`);
  } else {
    lines.push(`${r.total} bookmark${r.total === 1 ? '' : 's'}${filters ? ` for ${filters}` : ''}${r.items.length < r.total ? ` (showing ${r.items.length}; narrow with query or folder, or raise limit)` : ''}:`);
    // Grouped by browser and profile, groups in the order of their best match.
    const groups = new Map();
    for (const b of r.items) {
      const g = `${b.browser}\u0000${b.profile}`;
      if (!groups.has(g)) groups.set(g, { browser: b.browser, profile: b.profile, items: [] });
      groups.get(g).items.push(b);
    }
    for (const g of groups.values()) {
      lines.push(`${g.browser} (profile ${g.profile}):`);
      for (const b of g.items) {
        const pos = b.bar && b.position ? ` #${b.position}` : '';
        lines.push(`- [${b.folder}${pos}] ${oneLine(b.title, 100) || '(untitled)'} — ${oneLine(b.url, 300)}`);
      }
    }
  }
  const searched = r.sources.map((s) => `${s.browser}/${s.profile} (${s.count})`).join(', ');
  if (searched) lines.push('', `Read: ${searched}.`);
  else lines.push('', 'No browser profiles with bookmarks were found on this computer.');
  if (r.notes.length) lines.push(`Note: ${r.notes.join(' ')}`);
  if (r.hints.length) lines.push(`Hint: ${r.hints.join(' ')}`);
  if (r.items.length) lines.push('Open one with browser_open {browser, url}.');
  return lines.join('\n');
}

function formatOpen(r) {
  const parts = [`Opened ${oneLine(r.url, 200)} in ${r.browser} (${r.how}).`];
  if (r.window) {
    parts.push(`${r.focused ? 'Focused' : 'Its window is'} ${windowLabel(r.window)} (id ${r.window.id})${r.settled ? '' : '; the page may still be loading'}.`);
  }
  for (const n of r.notes || []) parts.push(n);
  parts.push('Take a screenshot to see the page (it may ask the user to sign in).');
  return parts.join(' ');
}

function formatTabs(r) {
  const lines = [`${r.browser} tabs (${r.method === 'applescript' ? 'AppleScript' : r.method === 'uia' ? 'UI Automation' : r.method === 'accessibility' ? 'accessibility tree' : r.method === 'keyboard' ? 'keyboard' : 'window titles only'}):`];
  r.windows.forEach((w, i) => {
    lines.push(`Window ${i + 1}${w.windowId ? ` (id ${w.windowId})` : ''}${w.minimized ? ' [minimized]' : ''}:`);
    for (const t of w.tabs) lines.push(`  ${t.index != null ? `${t.index}.` : '-'} ${t.active ? '[active] ' : ''}${oneLine(t.title, 120) || '(untitled)'}${t.url ? ` — ${oneLine(t.url, 200)}` : ''}`);
  });
  if (r.note) lines.push('', r.note);
  if (r.hint) lines.push(`Hint: ${r.hint}`);
  lines.push('Switch with browser_switch_tab {match: "<text in the title>"} or {index}.');
  return lines.join('\n');
}

function formatSwitch(r) {
  const t = r.tab;
  const where = r.window ? ` in ${windowLabel(r.window)} (id ${r.window.id})` : '';
  return `Switched to ${r.browser} tab${t.index != null ? ` ${t.index}` : ''} "${oneLine(t.title, 120)}"${t.url ? ` (${oneLine(t.url, 200)})` : ''}${where} via ${r.method === 'uia' ? 'UI Automation' : r.method === 'applescript' ? 'AppleScript' : r.method === 'accessibility' ? 'the accessibility tree' : r.method === 'title' ? 'its window (it was already the active tab)' : 'the keyboard'}. Take a screenshot to see it.`;
}

// ---------------------------------------------------------------- tools

/**
 * @param {object} ext the shared tool context from src/mcp/tools.js
 * @returns {object[]} the desktop tools
 */
function createTools(ext = {}) {
  const { getComputer, checkGuard, postActivity, keepAlive, ok, fail, objectSchema, annotations } = ext;
  const activity = typeof postActivity === 'function' ? postActivity : () => {};
  const alive = typeof keepAlive === 'function' ? keepAlive : () => () => {};
  const okText = typeof ok === 'function' ? ok : (text) => ({ content: [{ type: 'text', text }] });
  const failText = typeof fail === 'function' ? fail : (text) => ({ content: [{ type: 'text', text }], isError: true });
  const schema =
    typeof objectSchema === 'function'
      ? objectSchema
      : (properties, required = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
  const ann =
    typeof annotations === 'function'
      ? annotations
      : (title, { readOnly = false, destructive = false, idempotent = false, openWorld = true } = {}) => ({ title, readOnlyHint: readOnly, destructiveHint: readOnly ? false : destructive, idempotentHint: idempotent, openWorldHint: openWorld });
  const ops = createDesktopOps({ getComputer, checkGuard, deps: ext.desktopDeps });

  /** A fresh screenshot after an action: ext.screenshotAfter when the core tools provide it, else one taken here. */
  async function screenshotBlocks(display, window, signal) {
    if (typeof ext.screenshotAfter === 'function') {
      const blocks = await ext.screenshotAfter({ display, window: window || undefined, signal });
      if (Array.isArray(blocks)) return blocks;
    }
    await sleep(SETTLE_MS);
    try {
      const comp = await getComputer();
      const shot = await comp.screenshot({ display: Number.isInteger(display) ? display : 0 });
      let active = null;
      try {
        active = comp.driver && typeof comp.driver.activeWindow === 'function' ? await withTimeout(comp.driver.activeWindow(), 1500, 'Reading the active window') : null;
      } catch {
        active = null;
      }
      const data = shot.png.toString('base64');
      activity({ tool: 'screenshot', summary: `Screenshot of display ${shot.display} (${shot.width}x${shot.height})`, ok: true, image: data, width: shot.width, height: shot.height });
      let text;
      try {
        text = require('./tools').describeShot(shot, active);
      } catch {
        text = `Screenshot of display ${shot.display}: ${shot.width}x${shot.height} px.`;
      }
      return [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text }];
    } catch (err) {
      return [{ type: 'text', text: `(The screenshot after the action failed: ${oneLine(err && err.message, 200)})` }];
    }
  }

  /** The display a window is on (for screenshotAfter), or 0. */
  async function displayOf(w) {
    if (!w) return 0;
    try {
      const comp = await getComputer();
      const ds = typeof comp.driver.displays === 'function' ? await comp.driver.displays() : [];
      const cx = w.x + w.width / 2;
      const cy = w.y + w.height / 2;
      const i = ds.findIndex((d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height);
      return i < 0 ? 0 : i;
    } catch {
      return 0;
    }
  }

  /** An action tool: guard (inside the op) -> run -> activity, with an optional screenshot after. */
  function actionTool({ name, title, description, inputSchema, annotations: a, summarize, run }) {
    return {
      name,
      title,
      description,
      inputSchema,
      annotations: a,
      handler: async (args = {}, extra = {}) => {
        let out;
        try {
          out = await run(args || {}, extra || {});
        } catch (err) {
          if (!(err && err.code === 'PAUSED')) activity({ tool: name, summary: summarize(args || {}), ok: false, error: oneLine(err && err.message, 300) });
          throw err;
        }
        activity({ tool: name, summary: out.summary || summarize(args || {}), ok: !out.isError, ...(out.isError ? { error: oneLine(out.text, 300) } : {}) });
        if (out.isError) return failText(out.text);
        if (!args || !args.screenshotAfter) return okText(out.text);
        const blocks = await screenshotBlocks(await displayOf(out.window), out.window, extra && extra.signal);
        return { content: [{ type: 'text', text: out.text }, ...blocks] };
      },
    };
  }

  const SHOT_AFTER = { type: 'boolean', description: 'Return a fresh screenshot after the action (after a short settle delay). Default false.' };
  const BROWSER = { type: 'string', maxLength: 300, description: 'Which browser: brave, chrome, edge, firefox, safari, arc, opera, vivaldi, chromium (or the path to its executable). Default: the browser the user used last.' };

  const tools = [];

  // ------------------------------------------------------------ list_apps
  tools.push({
    name: 'list_apps',
    title: 'List installed apps',
    description: [
      'List the applications installed on this computer (macOS app bundles, the Windows Start menu and Store apps, Linux .desktop entries), or search them: query matches names fuzzily and knows everyday names ("vs code", "premiere", "davinci", "teams", "terminal", "file explorer").',
      'Apps with an open window are marked [running]. Use it to find the exact name before launch_app, or to check whether an app the user mentions is installed. Read-only.',
    ].join('\n\n'),
    inputSchema: schema({
      query: { type: 'string', maxLength: 200, description: 'Part of an app name, e.g. "figma", "whatsapp", "resolve". Without it all apps are listed by name.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum apps to list (default 15 with a query, 150 without).' },
    }),
    annotations: ann('List installed apps', { readOnly: true, idempotent: true }),
    handler: async (args = {}) => okText(formatApps(await ops.listApps(args))),
  });

  // ------------------------------------------------------------ launch_app
  tools.push(
    actionTool({
      name: 'launch_app',
      title: 'Launch app',
      description: [
        'Open an installed application by name and bring its window to the front: "Figma", "WhatsApp", "VS Code", "Brave", "Slack", "DaVinci Resolve", "OBS". The name is matched fuzzily against the installed apps (list_apps shows them); everyday names work.',
        'If the app already has a window, that window is focused instead of starting a second copy (pass newInstance to start another, e.g. a second terminal). It waits up to timeoutSec (default 20) for the window, then returns its id, title and position. args are passed on the command line (files or URLs to open, flags).',
        'accessibility: true starts Chromium-based browsers and Electron apps (VS Code, Slack, Discord, WhatsApp, Figma) with their accessibility tree switched on (--force-renderer-accessibility), so ui_find can see their controls; it applies only when the app is not already running.',
        'Prefer this over clicking through the Dock, Start menu or app launcher. To open a web page use browser_open instead.',
      ].join('\n\n'),
      inputSchema: schema(
        {
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'The app, e.g. "Figma", "vs code", "WhatsApp".' },
          args: { type: 'array', items: { type: 'string', maxLength: 2000 }, maxItems: 20, description: 'Command-line arguments (files, URLs, flags).' },
          waitForWindow: { type: 'boolean', description: 'Wait for its window and focus it (default true).' },
          timeoutSec: { type: 'integer', minimum: 1, maximum: MAX_LAUNCH_TIMEOUT_SEC, description: `How long to wait for the window (default ${DEFAULT_LAUNCH_TIMEOUT_SEC} s). Big apps (video editors, IDEs) may need 60.` },
          newInstance: { type: 'boolean', description: 'Start another copy even when it already has a window (default false).' },
          accessibility: { type: 'boolean', description: 'Start a Chromium/Electron app with its accessibility tree on (default false).' },
          screenshotAfter: SHOT_AFTER,
        },
        ['name']
      ),
      annotations: ann('Launch app'),
      summarize: (a) => `Launch ${oneLine(a.name, 60)}`,
      run: async (a, extra) => {
        const timeoutSec = clampInt(a.timeoutSec, 1, MAX_LAUNCH_TIMEOUT_SEC, DEFAULT_LAUNCH_TIMEOUT_SEC);
        const stop = alive(extra, (s) => `Waiting for ${oneLine(a.name, 40)} to open (${s} s)`);
        try {
          const r = await ops.launchApp(a, { signal: extra.signal });
          const summary = r.alreadyRunning && !r.launched ? `Focused ${r.app.name}` : r.window ? `Launched ${r.app.name}` : `Started ${r.app.name}`;
          return { text: formatLaunch(r, timeoutSec), summary, window: r.window };
        } finally {
          stop();
        }
      },
    })
  );

  // ------------------------------------------------------------ quit_app
  tools.push(
    actionTool({
      name: 'quit_app',
      title: 'Quit app',
      description: [
        'Quit an application by name, the way the user would (Cmd+Q / closing its windows): an app with unsaved work may ask to save and stay open; the result says so, then take a screenshot and handle the question.',
        'force terminates it without asking (unsaved work is lost): use it only when the user asked for it or the app hangs. Claude Code\'s own terminal or editor is never quit. Ask the user first unless they asked you to close it.',
      ].join('\n\n'),
      inputSchema: schema(
        {
          name: { type: 'string', minLength: 1, maxLength: 200, description: 'The app, e.g. "Spotify".' },
          force: { type: 'boolean', description: 'Terminate without asking to save (default false).' },
        },
        ['name']
      ),
      annotations: ann('Quit app', { destructive: true }),
      summarize: (a) => `Quit ${oneLine(a.name, 60)}${a.force ? ' (force)' : ''}`,
      run: async (a) => {
        const r = await ops.quitApp(a);
        return { text: formatQuit(r, Boolean(a.force)), summary: r.found ? `${r.running ? 'Asked to quit' : 'Quit'} ${r.app.name}` : `${r.app.name} was not running` };
      },
    })
  );

  // ------------------------------------------------------------ set_window
  tools.push(
    actionTool({
      name: 'set_window',
      title: 'Move or resize window',
      description: [
        'Arrange a window: state "maximize", "minimize", "restore", "fullscreen", "left-half" or "right-half" (of its display), or bounds {x, y, width, height} to move and resize it.',
        'window is an id from list_windows, or part of its title or app name. bounds are screen coordinates as list_windows reports them (not screenshot pixels). Useful to put two apps side by side or to give an app the whole screen before working in it.',
      ].join('\n\n'),
      inputSchema: schema(
        {
          window: { type: 'string', minLength: 1, maxLength: 300, description: 'Window id from list_windows, or part of its title or app name.' },
          state: { type: 'string', enum: WINDOW_STATES, description: 'Window state to apply.' },
          bounds: {
            type: 'object',
            description: 'New position and size in screen coordinates (as list_windows reports them).',
            properties: {
              x: { type: 'number', description: 'Left edge.' },
              y: { type: 'number', description: 'Top edge.' },
              width: { type: 'number', minimum: MIN_WINDOW_SIDE, description: 'Width.' },
              height: { type: 'number', minimum: MIN_WINDOW_SIDE, description: 'Height.' },
            },
            required: ['x', 'y', 'width', 'height'],
            additionalProperties: false,
          },
          screenshotAfter: SHOT_AFTER,
        },
        ['window']
      ),
      annotations: ann('Move or resize window', { idempotent: true }),
      summarize: (a) => `${a.state ? `Set ${oneLine(a.state, 20)}:` : 'Move'} window ${oneLine(a.window, 60)}`,
      run: async (a) => {
        const r = await ops.setWindow(a);
        const verb = { maximize: 'Maximized', minimize: 'Minimized', restore: 'Restored', fullscreen: 'Made full screen', 'left-half': 'Moved to the left half:', 'right-half': 'Moved to the right half:' }[r.state] || 'Moved';
        return { text: formatSetWindow(r), summary: `${verb} ${windowLabel(r.window)}`, window: r.after || r.window };
      },
    })
  );

  // ------------------------------------------------------------ wait_for
  tools.push({
    name: 'wait_for',
    title: 'Wait for window or text',
    description: [
      'Wait until something shows up (or, with gone: true, disappears) instead of sleeping a fixed time: a window (part of its title or app name, or an id), and/or text on screen ("Sign in", "Export complete", a contact\'s name).',
      'Text is found with the OS\'s own OCR (macOS Vision, Windows OCR, tesseract on Linux) within the window when one is given, else on the display; without OCR the window\'s accessibility tree is searched. A text match returns its centre in screenshot pixels, ready for click.',
      `timeoutSec defaults to ${DEFAULT_WAIT_SEC} (max ${MAX_WAIT_SEC}). Read-only: it never clicks or types.`,
    ].join('\n\n'),
    inputSchema: schema({
      window: { type: 'string', maxLength: 300, description: 'Window to wait for: part of its title or app name, or an id.' },
      text: { type: 'string', maxLength: 200, description: 'Text to wait for on screen (case-insensitive; close OCR misreads still match).' },
      gone: { type: 'boolean', description: 'Wait until the window or text is gone instead (default false).' },
      timeoutSec: { type: 'integer', minimum: 1, maximum: MAX_WAIT_SEC, description: `Give up after this many seconds (default ${DEFAULT_WAIT_SEC}).` },
      display: { type: 'integer', minimum: 0, maximum: 15, description: 'Display to search for text when no window is given (default 0, the primary).' },
      exact: { type: 'boolean', description: 'Match the whole text exactly (default false).' },
    }),
    annotations: ann('Wait for window or text', { readOnly: true }),
    handler: async (args = {}, extra = {}) => {
      const timeoutSec = clampInt(args.timeoutSec, 1, MAX_WAIT_SEC, DEFAULT_WAIT_SEC);
      const stop = alive(extra, (s) => `Waiting for ${hasText(args.text) ? `"${oneLine(args.text, 40)}"` : `window "${oneLine(args.window, 40)}"`} (${s} s)`);
      try {
        const r = await ops.waitFor(args, { signal: extra && extra.signal });
        const text = formatWaitFor(r, timeoutSec);
        return r.ok ? okText(text) : failText(text);
      } finally {
        stop();
      }
    },
  });

  // ------------------------------------------------------------ browser_bookmarks
  tools.push({
    name: 'browser_bookmarks',
    title: 'Read browser bookmarks',
    description: [
      'Read the bookmarks the user saved in their browsers (Brave, Chrome, Edge, Chromium, Vivaldi, Opera, Arc, Firefox, Safari), every profile, the bookmarks bar first, straight from the browser\'s files (no clicking).',
      'Use it for "the Jira site saved in my Brave bookmarks bar": browser_bookmarks {browser: "brave", folder: "bar", query: "jira"}, then browser_open with its url. folder "bar" means the bookmarks bar / toolbar / favourites; any other value matches folder names. query matches every word in the title or URL.',
      'Read-only.',
    ].join('\n\n'),
    inputSchema: schema({
      browser: BROWSER,
      query: { type: 'string', maxLength: 200, description: 'Words to find in the title or URL, e.g. "jira".' },
      folder: { type: 'string', maxLength: 200, description: '"bar" for the bookmarks bar, or part of a folder name.' },
      profile: { type: 'string', maxLength: 200, description: 'Part of a profile name or email (browsers with several profiles).' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum bookmarks to return (default 50).' },
    }),
    annotations: ann('Read browser bookmarks', { readOnly: true, idempotent: true, openWorld: false }),
    handler: async (args = {}) => okText(formatBookmarks(await ops.bookmarks(args), args)),
  });

  // ------------------------------------------------------------ browser_open
  tools.push(
    actionTool({
      name: 'browser_open',
      title: 'Open URL in browser',
      description: [
        'Open a web address in the user\'s browser (where they are signed in), as a new tab of the running browser by default, then focus its window. browser picks one (brave, chrome, edge, firefox, safari, ...); without it the browser the user used last is used, else the default browser.',
        'newWindow opens a new window; newTab: false loads the page in the current tab instead (AppleScript on macOS, else the keyboard: address bar, URL, Enter).',
        'Bare addresses work ("acme.atlassian.net/jira/for-you"); javascript: and data: URLs are refused.',
      ].join('\n\n'),
      inputSchema: schema(
        {
          url: { type: 'string', minLength: 1, maxLength: 8000, description: 'The address to open.' },
          browser: BROWSER,
          newTab: { type: 'boolean', description: 'Open in a new tab (default true); false replaces the current tab.' },
          newWindow: { type: 'boolean', description: 'Open in a new window (default false).' },
          screenshotAfter: SHOT_AFTER,
        },
        ['url']
      ),
      annotations: ann('Open URL in browser'),
      summarize: (a) => `Open ${oneLine(a.url, 80)}${a.browser ? ` in ${oneLine(a.browser, 30)}` : ''}`,
      run: async (a, extra) => {
        const stop = alive(extra, (s) => `Opening ${oneLine(a.url, 60)} (${s} s)`);
        try {
          const r = await ops.browserOpen(a, { signal: extra.signal });
          return { text: formatOpen(r), summary: `Opened ${oneLine(r.url, 80)} in ${r.browser}`, window: r.window };
        } finally {
          stop();
        }
      },
    })
  );

  // ------------------------------------------------------------ browser_tabs
  tools.push({
    name: 'browser_tabs',
    title: 'List browser tabs',
    description: [
      'List the open tabs of the user\'s browser (the one used last, or browser): titles, which one is active, and on macOS their URLs. macOS reads Chromium browsers and Safari through AppleScript; Windows reads the tab strip through UI Automation; Linux reads it through the accessibility tree (AT-SPI) when the browser exposes one. None of them touches the keyboard.',
      'Otherwise (Firefox on macOS, Linux without accessibility) only each window\'s active tab is visible; cycle: true reads every tab title of the front window with the keyboard (it brings the browser to the front, steps through the tabs with Ctrl+PageDown and returns to the tab that was active; tabs with the same title as the first one can end the cycle early).',
      'Use browser_switch_tab to go to one.',
    ].join('\n\n'),
    inputSchema: schema({
      browser: BROWSER,
      cycle: { type: 'boolean', description: 'Where tabs cannot be read directly, step through them with the keyboard (default false).' },
    }),
    annotations: ann('List browser tabs', { idempotent: true }),
    handler: async (args = {}, extra = {}) => {
      const stop = args.cycle ? alive(extra, (s) => `Reading the browser tabs (${s} s)`) : () => {};
      try {
        const r = await ops.browserTabs(args);
        if (r.method === 'keyboard') activity({ tool: 'browser_tabs', summary: `Read ${r.browser} tabs with the keyboard`, ok: true });
        return okText(formatTabs(r));
      } catch (err) {
        if (args.cycle && !(err && err.code === 'PAUSED')) activity({ tool: 'browser_tabs', summary: 'Read browser tabs with the keyboard', ok: false, error: oneLine(err && err.message, 300) });
        throw err;
      } finally {
        stop();
      }
    },
  });

  // ------------------------------------------------------------ browser_switch_tab
  tools.push(
    actionTool({
      name: 'browser_switch_tab',
      title: 'Switch browser tab',
      description: [
        'Bring a browser tab to the front: match finds the first tab whose title (or URL on macOS) contains the text; index picks by position in the front window (1 = first, -1 = last). The browser window is focused.',
        'macOS uses AppleScript, Windows UI Automation and Linux the accessibility tree when the browser exposes one; otherwise the keyboard (Ctrl+1..8 / Ctrl+9, or Ctrl+PageDown until the title matches).',
      ].join('\n\n'),
      inputSchema: schema({
        browser: BROWSER,
        match: { type: 'string', maxLength: 300, description: 'Text in the tab title, e.g. "Jira".' },
        index: { type: 'integer', minimum: -1, maximum: 500, description: 'Tab position in the front window: 1 = first, -1 = last.' },
        screenshotAfter: SHOT_AFTER,
      }),
      annotations: ann('Switch browser tab', { idempotent: true }),
      summarize: (a) => `Switch to ${a.match ? `tab "${oneLine(a.match, 40)}"` : `tab ${a.index}`}`,
      run: async (a) => {
        if (!hasText(a.match) && (a.index == null || Number(a.index) === 0)) {
          return { isError: true, text: 'Say which tab: match (text in its title) or index (1 = first, -1 = last).' };
        }
        const r = await ops.browserSwitchTab(a);
        return { text: formatSwitch(r), summary: `Switched to ${r.browser} tab "${oneLine(r.tab.title, 60)}"`, window: r.window };
      },
    })
  );

  return tools;
}

const TOOL_NAMES = ['list_apps', 'launch_app', 'quit_app', 'set_window', 'wait_for', 'browser_bookmarks', 'browser_open', 'browser_tabs', 'browser_switch_tab'];

module.exports = {
  createTools,
  createDesktopOps,
  TOOL_NAMES,
  // text formatters (shared with the CLI and tests)
  formatApps,
  formatLaunch,
  formatQuit,
  formatSetWindow,
  formatWaitFor,
  formatBookmarks,
  formatOpen,
  formatTabs,
  formatSwitch,
  findWindow,
};
