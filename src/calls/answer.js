'use strict';

/**
 * Accept, hang up and keep the camera off with the existing Computer tools (docs/CALLS-DESIGN.md
 * §4.3). Every click goes through gatePoint() and then Computer.click(), which itself checks the
 * user's pause guard and the top-left failsafe; nothing here closes a tab or a window.
 *
 * Order for answering: (1) the app's keyboard shortcut when it has one and its window can be
 * focused (Teams), (2) a learned Accept position (`anywhere calls learn`), (3) a vision click on the
 * Accept (or audio-only) button; a ring seen only as a notification first clicks the banner.
 * After each try the answer is verified within 5 s (the ring is gone and a call is in progress);
 * the vision click is retried once, then answerCall() gives up with a reason the manager reports
 * to the user ("I couldn't answer Ankit's call").
 *
 * Safeguard (d) is re-checked here before any input: the caller must pass armedUntil in the future,
 * quiet hours must not be active and the app must be one of calls.apps.
 */

const png = require('../os/png');
const sig = require('./signatures');
const sd = require('./screen-diff');
const { sameWindowId, identifyBrowser } = require('../os/linux');
const util = require('../shared/util');
const { createLogger } = require('../shared/log');

const log = createLogger('calls-answer');

const DIFF_MARGIN = 40; // shot px around the screen-diff region (§4.3)
const RECENT_WINDOW_MS = 60000;
const VERIFY_TIMEOUT_MS = 5000;
const VERIFY_POLL_MS = 500;
const BANNER_SETTLE_MS = 1500;
const BROWSER_CHROME_PX = 80; // a browser's tab strip and toolbar: never a call button
const PATCH_RADIUS = 20;
const PATCH_MAX_DIFF = 18; // mean gray-level change of the patch around a point
const ENDED_RE = /\b(?:missed|declined|rejected|ended|cancell?ed)\b/i;
const LEARNED_COLOR_TOLERANCE = 60; // per channel, against the learned Accept button color

function callsConfig(config) {
  return config && typeof config.calls === 'object' && config.calls ? config.calls : config || {};
}

function boundsOf(w) {
  if (!w) return null;
  const b = { x: Number(w.x), y: Number(w.y), width: Number(w.width), height: Number(w.height) };
  return [b.x, b.y].every(Number.isFinite) && b.width > 0 && b.height > 0 ? b : null;
}

function within(r, p, margin = 0) {
  return Boolean(r && p && p.x >= r.x - margin && p.y >= r.y - margin && p.x < r.x + r.width + margin && p.y < r.y + r.height + margin);
}

function parseHm(s) {
  const m = String(s == null ? '' : s).match(/^\s*(\d{1,2}):(\d{2})\s*$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * Quiet hours in local time, across midnight when start > end (22:00–08:00). A defensive copy of
 * the manager's policy check: answering is refused here too.
 * @param {Date} date
 * @param {{enabled?:boolean, start?:string, end?:string}} qh
 */
function inQuietHours(date, qh) {
  if (!qh || qh.enabled === false) return false;
  const start = parseHm(qh.start);
  const end = parseHm(qh.end);
  if (start == null || end == null || start === end) return false;
  const m = date.getHours() * 60 + date.getMinutes();
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** Whether calls.apps allows an app id (no list configured = the default set of known apps). */
function appAllowed(appId, config) {
  if (!appId) return false;
  const c = callsConfig(config);
  const list = Array.isArray(c.apps) ? c.apps.map((a) => sig.appFromText(a) || a) : sig.APP_IDS;
  return list.includes(appId);
}

/**
 * The window on top at a logical point: lowest stackIndex when the driver reports it, else the
 * focused window, else the call window, else the first in the list (drivers list front to back).
 */
function topWindowAt(windows, p, { callWindowId } = {}) {
  const hits = (windows || []).filter((w) => w && !w.minimized && within(boundsOf(w), p));
  if (!hits.length) return null;
  if (hits.some((w) => Number.isInteger(w.stackIndex))) {
    return hits.slice().sort((a, b) => (Number.isInteger(a.stackIndex) ? a.stackIndex : 1e9) - (Number.isInteger(b.stackIndex) ? b.stackIndex : 1e9))[0];
  }
  const focused = hits.find((w) => w.focused);
  if (focused) return focused;
  if (callWindowId != null) {
    const c = hits.find((w) => sameWindowId(w.id, callWindowId));
    if (c) return c;
  }
  return hits[0];
}

/**
 * Code gates before any click (§4.3).
 * @param {{x:number,y:number}|null} point in screenshot space
 * @param {{incoming?:boolean, requireIncoming?:boolean, shot:{width:number,height:number,display?:number},
 *   toLogical?:(display:number,x:number,y:number)=>{x:number,y:number}, windows?:object[],
 *   callWindow?:object, callWindowId?:string, diffRegion?:{x:number,y:number,width:number,height:number},
 *   recentWindows?:object[], zones?:object[], allowBrowserChrome?:boolean, now?:number}} ctx
 *   diffRegion is in fractions of the display (screen-diff.js); zones are screenshot-space rects
 * @returns {{ok:boolean, reason:string|null, logical?:{x:number,y:number}}}
 */
function gatePoint(point, ctx = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (ctx.requireIncoming !== false && ctx.incoming !== true) return no('not_incoming');
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return no('no_point');
  const shot = ctx.shot || {};
  if (!(shot.width > 0) || !(shot.height > 0)) return no('no_screenshot');
  if (point.x < 0 || point.y < 0 || point.x >= shot.width || point.y >= shot.height) return no('outside_screenshot');
  let logical;
  try {
    logical = typeof ctx.toLogical === 'function' ? ctx.toLogical(shot.display || 0, point.x, point.y) : { x: point.x, y: point.y };
  } catch {
    return no('unmapped');
  }
  if (!logical || !Number.isFinite(logical.x) || !Number.isFinite(logical.y)) return no('unmapped');
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const callBounds = boundsOf(ctx.callWindow);
  const diffRect = ctx.diffRegion ? sd.regionToRect(ctx.diffRegion, shot.width, shot.height, DIFF_MARGIN) : null;
  const inArea =
    within(callBounds, logical) ||
    within(diffRect, point) ||
    (ctx.recentWindows || []).some((w) => Number.isFinite(w.appearedAt) && now - w.appearedAt <= RECENT_WINDOW_MS && within(boundsOf(w), logical)) ||
    (ctx.zones || []).some((z) => within(z, point));
  if (!inArea) return no('outside_call_area');
  const windows = (ctx.windows || []).filter((w) => w && !w.minimized);
  // Our own dialog: refused wherever it is in the stacking order.
  if (windows.some((w) => sig.excludedKind(w) === 'own' && within(boundsOf(w), logical))) return no('own_dialog');
  if (windows.some((w) => w.focused && within(boundsOf(w), logical) && ['terminal', 'editor'].includes(sig.excludedKind(w)))) {
    return no(sig.excludedKind(windows.find((w) => w.focused && within(boundsOf(w), logical))));
  }
  const top = topWindowAt(windows, logical, { callWindowId: ctx.callWindowId });
  const kind = top ? sig.excludedKind(top) : null;
  if (kind) return no(kind === 'own' ? 'own_dialog' : kind);
  if (top && !ctx.allowBrowserChrome && identifyBrowser(top.app, top.title)) {
    const b = boundsOf(top);
    if (b && logical.y - b.y < BROWSER_CHROME_PX) return no('browser_chrome');
  }
  return { ok: true, reason: null, logical };
}

/**
 * Whether the screen around a point is unchanged between two screenshots of the same display
 * (the popup did not move or vanish during the vision check). Different sizes count as changed.
 */
function patchStill(pngA, pngB, point, radius = PATCH_RADIUS) {
  try {
    const a = png.decode(pngA);
    const b = png.decode(pngB);
    if (a.width !== b.width || a.height !== b.height) return false;
    const x0 = Math.max(0, Math.round(point.x) - radius);
    const y0 = Math.max(0, Math.round(point.y) - radius);
    const x1 = Math.min(a.width, Math.round(point.x) + radius + 1);
    const y1 = Math.min(a.height, Math.round(point.y) + radius + 1);
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * a.width + x) * 4;
        const ga = a.data[o] * 0.299 + a.data[o + 1] * 0.587 + a.data[o + 2] * 0.114;
        const gb = b.data[o] * 0.299 + b.data[o + 1] * 0.587 + b.data[o + 2] * 0.114;
        sum += Math.abs(ga - gb);
        n++;
      }
    }
    return n > 0 && sum / n <= PATCH_MAX_DIFF;
  } catch {
    return false;
  }
}

/** Where notification banners appear (screenshot space): top center (GNOME), top right (macOS), bottom right (Windows, KDE). */
function bannerZones(width, height) {
  const r = (x, y, w, h) => ({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
  return [r(width * 0.25, 0, width * 0.5, height * 0.2), r(width * 0.6, 0, width * 0.4, height * 0.35), r(width * 0.6, height * 0.65, width * 0.4, height * 0.35)];
}

function comboFor(shortcut, platform) {
  if (!shortcut) return null;
  if (typeof shortcut === 'string') return shortcut;
  if (typeof shortcut === 'object') return shortcut[platform] || shortcut.other || null;
  return null;
}

async function listWindowsSafe(driver) {
  try {
    const list = await driver.listWindows();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function findWindow(windows, id) {
  if (id == null) return null;
  return (windows || []).find((w) => w && sameWindowId(w.id, id)) || null;
}

async function displayOf(driver, w, fallback = 0) {
  const b = boundsOf(w);
  if (!b) return fallback;
  try {
    const ds = await driver.displays();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const i = (ds || []).findIndex((d) => cx >= Number(d.x) && cx < Number(d.x) + Number(d.width) && cy >= Number(d.y) && cy < Number(d.y) + Number(d.height));
    return i >= 0 ? i : fallback;
  } catch {
    return fallback;
  }
}

function displayBounds(ds, i) {
  const d = (ds || [])[i];
  return d ? { x: Number(d.x) || 0, y: Number(d.y) || 0, width: Number(d.width), height: Number(d.height) } : null;
}

/** Focus a window and confirm it is now the active one (and not a terminal/editor/our dialog). */
async function focusCallWindow(driver, win, sleep) {
  if (!win || typeof driver.focusWindow !== 'function') return { ok: false, reason: 'no_window' };
  let ok = false;
  try {
    ok = await driver.focusWindow(win.id);
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, reason: 'focus_failed' };
  await sleep(150);
  let active = null;
  try {
    active = await driver.activeWindow();
  } catch {
    active = null;
  }
  if (!active || !sameWindowId(active.id, win.id)) return { ok: false, reason: 'focus_not_confirmed' };
  if (sig.excludedKind(active)) return { ok: false, reason: 'excluded_window' };
  return { ok: true };
}

/** Ring and in-call state of a candidate's call in a window list (titles only). */
function ringState(windows, candidate, learned) {
  const out = { ringing: false, inCall: false, window: null };
  const lr = Array.isArray(learned) ? learned : candidate.learned ? [candidate.learned] : [];
  for (const w of windows || []) {
    if (!w || w.id == null) continue;
    const same = candidate.windowId != null && sameWindowId(w.id, candidate.windowId);
    if (same) out.window = w;
    const m = sig.matchTitle(w, { learned: lr });
    if (!m) continue;
    const mine = same || (candidate.app && m.app === candidate.app);
    if (!mine) continue;
    if (m.kind === 'ringing') out.ringing = true;
    else if (m.kind === 'in_call') out.inCall = true;
  }
  return out;
}

function errorReason(err) {
  if (err && err.code === 'PAUSED') return 'paused';
  if (err && err.code === 'FAILSAFE') return 'failsafe';
  if (err && err.code === 'VISION_RATE_LIMIT') return 'vision_rate_limit';
  if (err && err.code && /^VISION_|^CLAUDE_/.test(err.code)) return 'vision_failed';
  return 'error';
}

/**
 * Verify within timeoutMs that the call was answered: an in-call title of the app (or the ringing
 * window), else one vision look (no ring, a call in progress).
 * @returns {Promise<{ok:boolean, how:string}>}
 */
async function verifyAnswered({ candidate, driver, computer, vision, display = 0, timeoutMs = VERIFY_TIMEOUT_MS, sleep = util.sleep, now = Date.now, learned }) {
  const deadline = now() + timeoutMs;
  const ringTab = candidate.window ? sig.splitBrowserTitle(candidate.window.title, candidate.window.app).tab : null;
  let ringGoneAt = null;
  while (now() < deadline) {
    await sleep(VERIFY_POLL_MS);
    const st = ringState(await listWindowsSafe(driver), candidate, learned);
    if (st.inCall && !st.ringing) return { ok: true, how: 'title' };
    // The ringing window's title moved on (not to a "missed" or "ended" title): look once.
    const tab = st.window ? sig.splitBrowserTitle(st.window.title, st.window.app).tab : null;
    const moved = ringTab && st.window && tab !== ringTab && !ENDED_RE.test(tab || '');
    if (!st.ringing && (moved || candidate.source === 'title') && ringGoneAt == null) ringGoneAt = now();
    if (ringGoneAt != null && now() - ringGoneAt >= VERIFY_POLL_MS) break;
  }
  if (!vision || !computer) return { ok: false, how: 'unverified' };
  try {
    const shot = await computer.screenshot({ display });
    const det = await vision.detect(shot.png, { purpose: 'verify' });
    if (!det.incoming && det.inCall) return { ok: true, how: 'vision' };
    return { ok: false, how: det.incoming ? 'still_ringing' : 'no_call' };
  } catch (err) {
    log.info('could not verify the answered call:', err && err.message);
    return { ok: false, how: 'verify_failed' };
  }
}

/**
 * Answer a ringing call.
 * @param {{candidate:object, computer:object, driver:object, vision?:object, config?:object,
 *   armedUntil:number, detector?:object, learned?:object[], now?:()=>number, sleep?:(ms:number)=>Promise<void>,
 *   verifyTimeoutMs?:number}} opts
 *   candidate: from CallDetector ('ringing'); detector (optional) supplies recently appeared windows
 * @returns {Promise<{ok:boolean, method:string|null, reason?:string, point?:{x:number,y:number},
 *   verified?:string, video?:boolean, camera?:object, caller?:string|null, app?:string|null, attempts:object[]}>}
 */
async function answerCall(opts = {}) {
  const { candidate, computer, driver, vision, config } = opts;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : util.sleep;
  const attempts = [];
  const fail = (reason, extra = {}) => ({ ok: false, method: null, reason, attempts, ...extra });
  if (!candidate || typeof candidate !== 'object') return fail('no_candidate');
  // Safeguard (d): armed by a click, not expired, not in quiet hours, an allowed app.
  if (!(Number(opts.armedUntil) > now())) return fail('not_armed');
  const c = callsConfig(config);
  if (inQuietHours(new Date(now()), c.quietHours)) return fail('quiet_hours');
  if (candidate.app && !appAllowed(candidate.app, config)) return fail('app_not_allowed');
  if (!computer || !driver) return fail('no_computer');
  const verifyTimeoutMs = Number(opts.verifyTimeoutMs) > 0 ? Number(opts.verifyTimeoutMs) : VERIFY_TIMEOUT_MS;
  const recent = () => (opts.detector && typeof opts.detector.recentWindows === 'function' ? opts.detector.recentWindows() : []);
  const app = sig.appById(candidate.app);
  try {
    let windows = await listWindowsSafe(driver);
    let callWin = findWindow(windows, candidate.windowId);
    const display = callWin ? await displayOf(driver, callWin, Number.isInteger(candidate.display) ? candidate.display : 0) : Number.isInteger(candidate.display) ? candidate.display : 0;
    const verify = (d = display) => verifyAnswered({ candidate, driver, computer, vision, display: d, timeoutMs: verifyTimeoutMs, sleep, now, learned: opts.learned });
    const done = (method, extra = {}) => ({ ok: true, method, attempts, caller: candidate.caller || null, app: candidate.app || null, ...extra });

    // 1. The app's accept shortcut (Teams: accept with audio only).
    const accept = app && app.shortcuts ? comboFor(app.shortcuts.accept, computer.platform) : null;
    if (accept && callWin && candidate.confidence >= sig.CONFIDENCE.known) {
      const f = await focusCallWindow(driver, callWin, sleep);
      if (f.ok) {
        await computer.key({ combo: accept });
        const v = await verify();
        attempts.push({ method: 'shortcut', combo: accept, verified: v.how, ok: v.ok });
        if (v.ok) return done('shortcut', { verified: v.how });
      } else {
        attempts.push({ method: 'shortcut', ok: false, reason: f.reason });
      }
    }

    // 2. A learned Accept position (calibrated with `anywhere calls learn`): no vision needed to
    // locate it, but the same gates and the verification apply, and the position must still show
    // the learned button color (else the layout changed: vision locates it instead).
    const learnedSig = candidate.learned && candidate.learned.acceptRel ? candidate.learned : null;
    if (learnedSig) {
      const r = await clickLearned({ sig: learnedSig, candidate, callWin, windows, computer, driver, display, now, recent });
      attempts.push({ method: 'learned', ...r });
      if (r.clicked) {
        const v = await verify(r.display);
        attempts[attempts.length - 1].verified = v.how;
        if (v.ok) return done('learned', { point: r.point, verified: v.how });
      }
    }

    // 3. Vision: locate Accept (prefer audio only), gate, click, verify; retry once.
    if (!vision) return fail(attempts.length ? 'not_verified' : 'no_vision');
    let bannerTried = false;
    let tries = 0;
    let clickedAt = null; // the last point clicked, for a late verification
    let lastReason = 'not_verified';
    while (tries < 2) {
      const shot = await computer.screenshot({ display });
      const det = await vision.detect(shot.png, { purpose: 'answer' });
      if (!det.incoming) {
        // The click worked after all (the call connected after the 5 s verification).
        if (clickedAt && det.inCall) return done('click', { point: clickedAt, verified: 'vision' });
        if (!bannerTried && candidate.source === 'notification') {
          bannerTried = true;
          const b = await clickBanner({ shot, vision, computer, windows, now, recent, banner: candidate.banner });
          attempts.push({ method: 'banner', ...b });
          if (!b.ok) return fail(`banner:${b.reason}`);
          await sleep(BANNER_SETTLE_MS);
          windows = await listWindowsSafe(driver);
          const active = await driver.activeWindow().catch(() => null);
          if (active) callWin = findWindow(windows, active.id) || callWin;
          continue;
        }
        return fail(tries > 0 ? lastReason : 'not_ringing', { vision: { app: det.app, inCall: det.inCall } });
      }
      const appId = candidate.app || det.appId;
      if (!appId) return fail('unknown_app', { vision: { app: det.app } });
      if (!appAllowed(appId, config)) return fail('app_not_allowed', { vision: { app: det.app } });
      const point = det.audioOnly || det.accept;
      if (!point) return fail('no_accept_button');
      const gate = gatePoint(point, {
        incoming: det.incoming,
        shot: { width: shot.width, height: shot.height, display: shot.display == null ? display : shot.display },
        toLogical: (d, x, y) => computer.toLogical(d, x, y),
        windows,
        callWindow: callWin,
        callWindowId: callWin ? callWin.id : candidate.windowId,
        diffRegion: candidate.region && candidate.display === display ? candidate.region : null,
        recentWindows: recent(),
        now: now(),
      });
      if (!gate.ok) {
        attempts.push({ method: 'click', ok: false, point, reason: `gate:${gate.reason}` });
        return fail(`gate:${gate.reason}`, { point });
      }
      tries++;
      const fresh = await computer.screenshot({ display });
      if (!patchStill(shot.png, fresh.png, point)) {
        attempts.push({ method: 'click', ok: false, point, reason: 'moved' });
        lastReason = 'popup_moved';
        continue;
      }
      await computer.click({ x: point.x, y: point.y, display: shot.display == null ? display : shot.display });
      clickedAt = point;
      const v = await verify();
      attempts.push({ method: 'click', ok: v.ok, point, audioOnly: Boolean(det.audioOnly), verified: v.how });
      if (v.ok) {
        const video = Boolean(det.video && !det.audioOnly);
        let camera;
        if (video) {
          camera = await cameraOff({ app: appId, windowId: callWin ? callWin.id : candidate.windowId, display, computer, driver, vision, sleep, now }).catch((err) => ({ ok: false, reason: errorReason(err) }));
        }
        return done('click', { point, verified: v.how, video, ...(camera ? { camera } : {}), caller: det.caller || candidate.caller || null, app: appId });
      }
      lastReason = v.how === 'still_ringing' ? 'still_ringing' : 'not_verified';
    }
    return fail(lastReason);
  } catch (err) {
    log.info('answering the call failed:', err && err.message);
    return fail(errorReason(err), { message: err && err.message });
  }
}

async function clickLearned({ sig: s, candidate, callWin, windows, computer, driver, display, now, recent }) {
  let bounds = null;
  let d = display;
  if (s.relativeTo === 'display') {
    let ds = [];
    try {
      ds = await driver.displays();
    } catch {
      ds = [];
    }
    d = Number.isInteger(s.display) ? s.display : display;
    bounds = displayBounds(ds, d);
  } else {
    bounds = boundsOf(callWin);
  }
  if (!bounds) return { ok: false, clicked: false, reason: 'no_window' };
  const lp = sig.learnedAcceptPoint(s, bounds);
  if (!lp) return { ok: false, clicked: false, reason: 'no_point' };
  const shot = await computer.screenshot({ display: d });
  const point = computer.toShot(d, lp.x, lp.y);
  if (s.acceptColor) {
    const color = sd.patchColor(shot.png, point);
    if (sd.colorDistance(color, s.acceptColor) > LEARNED_COLOR_TOLERANCE) return { ok: false, clicked: false, point, reason: 'learned_mismatch', color };
  }
  const gate = gatePoint(point, {
    incoming: true, // the learned ring signature matched; verification still follows
    shot: { width: shot.width, height: shot.height, display: d },
    toLogical: (dd, x, y) => computer.toLogical(dd, x, y),
    windows,
    callWindow: s.relativeTo === 'display' ? null : callWin,
    callWindowId: callWin ? callWin.id : candidate.windowId,
    diffRegion: candidate.region && candidate.display === d ? candidate.region : null,
    recentWindows: recent(),
    zones: s.relativeTo === 'display' && s.popupRegion ? [sd.regionToRect(s.popupRegion, shot.width, shot.height, DIFF_MARGIN)] : [],
    now: now(),
  });
  if (!gate.ok) return { ok: false, clicked: false, point, reason: `gate:${gate.reason}` };
  await computer.click({ x: point.x, y: point.y, display: d });
  return { ok: true, clicked: true, point, display: d };
}

/**
 * Click the incoming-call notification banner (it focuses the call's tab). The point must lie in a
 * notification area of the screen, or inside the toast's own bounds when the OS reported them.
 */
async function clickBanner({ shot, vision, computer, windows, now, recent, banner }) {
  const point = await vision.locate(shot.png, 'the notification banner or popup about the incoming call (its text, not its close button)', { purpose: 'answer' });
  if (!point) return { ok: false, reason: 'no_banner' };
  const gate = gatePoint(point, {
    requireIncoming: false,
    shot: { width: shot.width, height: shot.height, display: shot.display || 0 },
    toLogical: (d, x, y) => computer.toLogical(d, x, y),
    windows,
    zones: bannerZones(shot.width, shot.height),
    recentWindows: [...recent(), ...(banner ? [{ ...banner, appearedAt: now() }] : [])],
    allowBrowserChrome: true,
    now: now(),
  });
  if (!gate.ok) return { ok: false, point, reason: `gate:${gate.reason}` };
  const fresh = await computer.screenshot({ display: shot.display || 0 });
  if (!patchStill(shot.png, fresh.png, point)) return { ok: false, point, reason: 'banner_gone' };
  await computer.click({ x: point.x, y: point.y, display: shot.display || 0 });
  return { ok: true, point };
}

/**
 * Click a control of the call window found by vision, inside the call window only.
 * @returns {Promise<{ok:boolean, method:string, point?:object, reason?:string}>}
 */
async function clickInCallWindow({ what, windowId, display, computer, driver, vision, now }) {
  if (!vision) return { ok: false, method: 'click', reason: 'no_vision' };
  const windows = await listWindowsSafe(driver);
  const win = findWindow(windows, windowId);
  if (!win) return { ok: false, method: 'click', reason: 'no_call_window' };
  const d = await displayOf(driver, win, display || 0);
  const shot = await computer.screenshot({ display: d });
  const point = await vision.locate(shot.png, what, { purpose: 'answer' });
  if (!point) return { ok: false, method: 'click', reason: 'not_found' };
  const gate = gatePoint(point, {
    requireIncoming: false,
    shot: { width: shot.width, height: shot.height, display: d },
    toLogical: (dd, x, y) => computer.toLogical(dd, x, y),
    windows,
    callWindow: win,
    callWindowId: win.id,
    now: now(),
  });
  if (!gate.ok) return { ok: false, method: 'click', point, reason: `gate:${gate.reason}` };
  const fresh = await computer.screenshot({ display: d });
  if (!patchStill(shot.png, fresh.png, point)) return { ok: false, method: 'click', point, reason: 'moved' };
  await computer.click({ x: point.x, y: point.y, display: d });
  return { ok: true, method: 'click', point };
}

/**
 * Hang up: Teams' shortcut, elsewhere the red End/Leave button found by vision inside the call
 * window. Never closes the tab (that could close the user's main chat tab).
 * @param {{app?:string, windowId?:string, display?:number, computer:object, driver:object, vision?:object,
 *   sleep?:Function, now?:Function}} opts
 */
async function hangUp(opts = {}) {
  const { app, windowId, computer, driver, vision } = opts;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : util.sleep;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  if (!computer || !driver) return { ok: false, method: null, reason: 'no_computer' };
  try {
    const a = sig.appById(app);
    const combo = a && a.shortcuts ? comboFor(a.shortcuts.hangUp, computer.platform) : null;
    if (combo) {
      const win = findWindow(await listWindowsSafe(driver), windowId);
      const f = await focusCallWindow(driver, win, sleep);
      if (f.ok) {
        await computer.key({ combo });
        return { ok: true, method: 'shortcut', combo };
      }
    }
    return await clickInCallWindow({
      what: 'the red button that ends or leaves the current call (End call, Leave, Hang up). Not a browser tab close button and not a window close button',
      windowId,
      display: opts.display,
      computer,
      driver,
      vision,
      now,
    });
  } catch (err) {
    return { ok: false, method: null, reason: errorReason(err), message: err && err.message };
  }
}

/**
 * Keep the camera off after answering a video call: only when vision sees the camera on (the
 * shortcuts toggle), with the app's camera shortcut, else a click on the camera button.
 * @param {{app?:string, windowId?:string, display?:number, computer:object, driver:object, vision?:object,
 *   force?:boolean, sleep?:Function, now?:Function}} opts force: skip the "is it on?" check
 */
async function cameraOff(opts = {}) {
  const { app, windowId, computer, driver, vision } = opts;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : util.sleep;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  if (!computer || !driver) return { ok: false, method: null, reason: 'no_computer' };
  try {
    const windows = await listWindowsSafe(driver);
    const win = findWindow(windows, windowId);
    const display = win ? await displayOf(driver, win, opts.display || 0) : opts.display || 0;
    if (!opts.force) {
      if (!vision) return { ok: false, method: null, reason: 'no_vision' };
      const shot = await computer.screenshot({ display });
      const on = await vision.verify(shot.png, "Is the user's own camera switched on in this call (a live self-view video of the user, or a camera button showing that video is on)?");
      if (!on) return { ok: true, method: 'already_off' };
    }
    const a = sig.appById(app);
    const combo = a && a.shortcuts ? comboFor(a.shortcuts.camera, computer.platform) : null;
    if (combo && win) {
      const f = await focusCallWindow(driver, win, sleep);
      if (f.ok) {
        await computer.key({ combo });
        return { ok: true, method: 'shortcut', combo };
      }
    }
    return await clickInCallWindow({ what: 'the camera (video) on/off button of the call controls', windowId, display, computer, driver, vision, now });
  } catch (err) {
    return { ok: false, method: null, reason: errorReason(err), message: err && err.message };
  }
}

module.exports = {
  answerCall,
  hangUp,
  cameraOff,
  gatePoint,
  verifyAnswered,
  patchStill,
  topWindowAt,
  bannerZones,
  inQuietHours,
  appAllowed,
  ringState,
  DIFF_MARGIN,
  RECENT_WINDOW_MS,
  VERIFY_TIMEOUT_MS,
};
