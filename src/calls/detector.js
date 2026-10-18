'use strict';

/**
 * Call detection state machine (docs/CALLS-DESIGN.md §4.2) and calibration (§4.4).
 *
 *   stopped ─start()─► watching ─candidate ≥ 0.7, or 2 vision incoming:true from weak signals─► ringing
 *   ringing: re-checked every poll; when the ring is gone →
 *     ├─ an in-call signature of that app appeared → ring_ended {reason:'answered_elsewhere', userAnswered:true}
 *     ├─ otherwise → ring_ended {reason:'missed'}
 *     ├─ the manager answered (beginAnswer + callStarted) → ring_ended {reason:'answered'} → in_call
 *     └─ it vanished while a stronger ring shows in another window → ring_ended {reason:'replaced'},
 *        then 'ringing' for the new one (a waiting manager starts over with it)
 *   in_call: the call window closes or its in-call signature disappears → call_ended (once);
 *     the manager calls callEnded() after wrap-up → watching
 *
 * Signals: window titles (1 Hz), OS notifications, low-rate screen diffs (every 2 s) and, for weak
 * signals only, a rate-limited Claude vision check. The detector never clicks anything: answering is
 * answer.js, and arming, quiet hours, app choice and timing (answerAfterSec) are the manager's.
 *
 * Events: 'candidate' (Candidate), 'ringing' ({candidate, since}), 'ring_ended' ({candidate, reason,
 * userAnswered, since, ms}), 'call_ended' ({reason, call}), 'signal' (weak signals, for logs).
 * Candidate: {app, kind:'ringing', caller?, windowId?, window?, display?, region?, source, confidence,
 * ts, origin?, browser?, learned?, vision?}.
 */

const { EventEmitter } = require('events');
const sig = require('./signatures');
const sd = require('./screen-diff');
const { sameWindowId } = require('../os/linux');
const util = require('../shared/util');
const { createLogger } = require('../shared/log');

const log = createLogger('calls-detect');

const DEFAULTS = Object.freeze({
  pollMs: 1000, // window titles and notifications
  diffMs: 2000, // screen diffs
  notificationTtlMs: 30000, // a notification counts as "still ringing" this long
  visionRingTtlMs: 40000, // a vision-confirmed ring without other signals lasts at most this long
  ringGraceMs: 2500, // a ring must be gone this long before it ends (title flicker)
  weakWindowMs: 10000, // weak signals are considered this long
  recentWindowMs: 60000, // "a window that appeared within the last 60 s" (answer gates)
  callGoneMs: 3000, // the call window or in-call title must be gone this long
  smallWindowFrac: 0.25, // a new window this small (share of the screen) is a weak signal
  learnPollMs: 1000,
});
const VISION_CONFIDENCE = 0.8;
const MAX_LEARN_LOOKS = 5;
// Titles after a ring that are not a call in progress.
const ENDED_RE = /\b(?:missed|declined|rejected|ended|cancell?ed|no answer|unanswered)\b/i;

function realClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t),
  };
}

/** The given clock's functions, called on the clock object itself (so a test clock's own state is used). */
function bindClock(clock) {
  const real = realClock();
  const c = clock || {};
  const out = {};
  for (const k of Object.keys(real)) out[k] = typeof c[k] === 'function' ? (...a) => c[k](...a) : real[k];
  return out;
}

function callsConfig(config) {
  return config && typeof config.calls === 'object' && config.calls ? config.calls : config || {};
}

/** Logical bounds of a window record, or null. */
function boundsOf(w) {
  if (!w) return null;
  const b = { x: Number(w.x), y: Number(w.y), width: Number(w.width), height: Number(w.height) };
  return [b.x, b.y].every(Number.isFinite) && b.width > 0 && b.height > 0 ? b : null;
}

function windowInfo(w) {
  const b = boundsOf(w);
  return { id: String(w.id), app: String(w.app || ''), title: String(w.title || ''), ...(b || {}) };
}

/**
 * Merge two caller names from different sources (§7.3): equal or one containing the other → the
 * longer; disagreeing → null (the caller stays unbound).
 */
function mergeCaller(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y || x.includes(y)) return a;
  if (y.includes(x)) return b;
  return null;
}

function sameCall(a, b) {
  if (!a || !b) return false;
  if (a.windowId && b.windowId) return sameWindowId(a.windowId, b.windowId);
  if (a.app && b.app) return a.app === b.app;
  if (a.caller && b.caller) return mergeCaller(a.caller, b.caller) != null;
  return !a.app || !b.app;
}

function pickBest(list) {
  let best = null;
  for (const c of list) if (!best || c.confidence > best.confidence) best = c;
  return best;
}

class CallDetector extends EventEmitter {
  /**
   * @param {{driver:object, getComputer?:()=>object|Promise<object>, config?:object, vision?:object,
   *   notifications?:object, clock?:object, learned?:object[], learnedFile?:string,
   *   tracker?:sd.ScreenDiffTracker, options?:object}} opts
   *   vision: a VisionClient (detect/locate/verify, canCheck); notifications: a NotificationWatcher
   *   (EventEmitter of 'notification', optional start/stop/status); clock: {now, setTimeout,
   *   clearTimeout, setInterval, clearInterval}; options: DEFAULTS overrides (+ sleep for learn())
   */
  constructor({ driver, getComputer, config, vision, notifications, clock, learned, learnedFile, tracker, options } = {}) {
    super();
    if (!driver) throw new TypeError('CallDetector needs a desktop driver');
    this.driver = driver;
    this.getComputer = typeof getComputer === 'function' ? getComputer : null;
    this.config = config || {};
    this.vision = vision || null;
    this.notifications = notifications || null;
    this.clock = bindClock(clock);
    this.opts = { ...DEFAULTS, ...(options || {}) };
    this.learnedFile = learnedFile;
    this.learned = Array.isArray(learned) ? learned : null;
    this.tracker = tracker || new sd.ScreenDiffTracker();
    this.state = 'stopped';
    this.signals = { titles: null, notifications: null, screenDiff: null, vision: null };
    this._reset();
    this._timer = null;
    this._ticking = false;
    this._startedNotifications = false;
    this._onNotification = (n) => {
      this._notifQueue.push(n);
      if (this._notifQueue.length > 50) this._notifQueue.shift();
    };
  }

  _reset() {
    this._windows = new Map(); // id -> {w, tab, appearedAt, titleChangedAt, prevTab}
    this._firstPoll = true;
    this._lastWindows = [];
    this._notifQueue = [];
    this._notifCands = [];
    this._weak = [];
    this._ring = null;
    this._call = null;
    this._answering = false;
    this._visionHits = 0;
    this._lastDiffAt = -Infinity;
    this._lastDiff = null;
    this._displays = null;
    this._displaysAt = -Infinity;
    this._busyKeys = new Map();
    this.tracker.reset();
  }

  _detectCfg() {
    const c = callsConfig(this.config);
    return c.detect && typeof c.detect === 'object' ? c.detect : {};
  }

  _visionEnabled() {
    return Boolean(this.vision && typeof this.vision.detect === 'function' && this.getComputer && this._detectCfg().vision !== false);
  }

  /** Reload <state>/calls/signatures.json (after `calls learn`). */
  reloadLearned() {
    this.learned = sig.loadLearned({ file: this.learnedFile });
    return this.learned;
  }

  // ------------------------------------------------------------ lifecycle

  /** Start watching (the manager calls this when calls are armed). */
  start() {
    if (this.state !== 'stopped') return this.status();
    this._reset();
    if (!this.learned) {
      try {
        this.reloadLearned();
      } catch (err) {
        log.warn('could not load learned call signatures:', err.message);
        this.learned = [];
      }
    }
    this.state = 'watching';
    const det = this._detectCfg();
    if (this.notifications && det.notifications !== false) {
      this.notifications.on('notification', this._onNotification);
      if (typeof this.notifications.start === 'function' && !(this.notifications.running === true)) {
        const r = this.notifications.start();
        this._startedNotifications = Boolean(r && r.ok);
        this.signals.notifications = Boolean(r && r.ok);
        if (r && !r.ok) log.info(`call notifications unavailable: ${r.reason || 'unknown reason'}`);
      } else {
        this.signals.notifications = true;
      }
    } else {
      this.signals.notifications = false;
    }
    this.signals.vision = this._visionEnabled();
    this._timer = this.clock.setInterval(() => {
      this.tick().catch((err) => log.warn('call detection failed:', err && err.message));
    }, this.opts.pollMs);
    if (this._timer && this._timer.unref) this._timer.unref();
    return this.status();
  }

  /** Stop watching (disarm, shutdown). An active ring ends with reason 'stopped'. */
  stop() {
    if (this._timer) this.clock.clearInterval(this._timer);
    this._timer = null;
    if (this.notifications) {
      this.notifications.removeListener('notification', this._onNotification);
      if (this._startedNotifications && typeof this.notifications.stop === 'function') this.notifications.stop();
    }
    this._startedNotifications = false;
    const ring = this._ring;
    const was = this.state;
    this.state = 'stopped';
    if (ring && was === 'ringing') this._emitSafe('ring_ended', { candidate: ring.candidate, reason: 'stopped', userAnswered: false, since: ring.since, ms: this.clock.now() - ring.since });
    this._reset();
  }

  status() {
    return {
      state: this.state,
      signals: { ...this.signals },
      ring: this.currentRing(),
      call: this._call ? { ...this._call } : null,
      learned: (this.learned || []).length,
    };
  }

  _emitSafe(name, payload) {
    try {
      this.emit(name, payload);
    } catch (err) {
      log.warn(`a '${name}' listener failed:`, err && err.message);
    }
  }

  // ------------------------------------------------------------ manager hooks

  /** The ring being watched: {…candidate, since, sources} or null. */
  currentRing() {
    if (!this._ring) return null;
    return { ...this._ring.candidate, since: this._ring.since, sources: [...this._ring.sources] };
  }

  /** The manager is about to answer: the ring vanishing is then expected, not "missed". */
  beginAnswer() {
    this._answering = true;
    return this.currentRing();
  }

  /** Answering failed or was abandoned: watch the ring normally again. */
  answerFailed() {
    this._answering = false;
  }

  /**
   * The call was answered by us: end the ring ('answered') and watch the call for its end.
   * @param {{app?:string, windowId?:string}} [info]
   */
  callStarted(info = {}) {
    const now = this.clock.now();
    const ring = this._ring;
    this._answering = false;
    this._call = {
      app: info.app || (ring && ring.candidate.app) || null,
      windowId: info.windowId || (ring && ring.candidate.windowId) || null,
      since: now,
      inCallSeen: false,
      goneSince: null,
      ended: false,
    };
    this._ring = null;
    if (this.state !== 'stopped') this.state = 'in_call';
    if (ring) this._emitSafe('ring_ended', { candidate: ring.candidate, reason: 'answered', userAnswered: false, since: ring.since, ms: now - ring.since });
  }

  /** The call is over (hang-up and wrap-up done): back to watching. */
  callEnded() {
    this._call = null;
    this._ring = null;
    this._answering = false;
    this._notifCands = [];
    this._weak = [];
    this.tracker.reset();
    if (this.state !== 'stopped') this.state = 'watching';
  }

  /**
   * Resolve after `seconds` if the ring is still there ({ok:true, ring}), or as soon as it ends
   * ({ok:false, reason, userAnswered}). The manager waits calls.answerAfterSec with this.
   * @param {{seconds?:number, signal?:AbortSignal}} [opts]
   */
  waitToAnswer({ seconds = 8, signal } = {}) {
    return new Promise((resolve) => {
      const ring = this._ring;
      if (!ring) {
        resolve({ ok: false, reason: 'no_ring' });
        return;
      }
      let timer = null;
      const done = (r) => {
        if (timer) this.clock.clearTimeout(timer);
        timer = null;
        this.removeListener('ring_ended', onEnd);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onEnd = (e) => {
        if (e && e.candidate === ring.candidate) done({ ok: false, reason: e.reason, userAnswered: Boolean(e.userAnswered) });
      };
      const onAbort = () => done({ ok: false, reason: 'aborted' });
      this.on('ring_ended', onEnd);
      if (signal) {
        if (signal.aborted) return done({ ok: false, reason: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      }
      timer = this.clock.setTimeout(() => done(this._ring === ring ? { ok: true, ring: this.currentRing() } : { ok: false, reason: 'ring_ended' }), Math.max(0, Number(seconds) || 0) * 1000);
    });
  }

  /** Windows that appeared within `ms` (default 60 s), with their bounds and appearedAt. */
  recentWindows(ms = this.opts.recentWindowMs) {
    const now = this.clock.now();
    const out = [];
    for (const [id, e] of this._windows) {
      if (e.appearedAt == null || now - e.appearedAt > ms) continue;
      const b = boundsOf(e.w);
      if (b) out.push({ id, ...b, app: e.w.app || '', title: e.w.title || '', appearedAt: e.appearedAt });
    }
    return out;
  }

  /** The window list of the last poll. */
  windows() {
    return this._lastWindows.slice();
  }

  /** The last compact screen change {display, region, ts} (region in display fractions), or null. */
  lastScreenChange() {
    return this._lastDiff ? { ...this._lastDiff } : null;
  }

  // ------------------------------------------------------------ polling

  /** One detection step (also driven by the interval). Never throws. */
  async tick() {
    if (this._ticking || this.state === 'stopped') return;
    this._ticking = true;
    try {
      await this._tick();
    } catch (err) {
      log.warn('call detection step failed:', err && err.message);
    } finally {
      this._ticking = false;
    }
  }

  async _tick() {
    const now = this.clock.now();
    const det = this._detectCfg();
    const strong = [];
    const inCall = [];
    let windows = null;
    if (det.titles !== false) windows = await this._pollWindows(now, strong, inCall);
    if (det.notifications !== false) this._drainNotifications(now, strong, windows);
    if (det.screenDiff !== false && this.state !== 'in_call' && now - this._lastDiffAt >= this.opts.diffMs) await this._diffScreens(now);
    this._weak = this._weak.filter((w) => now - w.ts <= this.opts.weakWindowMs);
    if (this.state === 'watching') await this._watching(now, strong, inCall);
    else if (this.state === 'ringing') this._ringing(now, strong, inCall);
    else if (this.state === 'in_call') this._inCall(now, strong, inCall, windows);
  }

  async _getDisplays() {
    const now = this.clock.now();
    if (this._displays && now - this._displaysAt < 10000) return this._displays;
    const list = await this.driver.displays();
    this._displays = Array.isArray(list) ? list.map((d, i) => ({ index: i, x: Number(d.x) || 0, y: Number(d.y) || 0, width: Number(d.width) || 0, height: Number(d.height) || 0 })) : [];
    this._displaysAt = now;
    return this._displays;
  }

  /** Display index of a window (its center), from the cached display list. */
  _displayOf(w) {
    const b = boundsOf(w);
    if (!b || !this._displays) return 0;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const i = this._displays.findIndex((d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height);
    return i >= 0 ? i : 0;
  }

  _candidate(m, w, now, extra = {}) {
    return {
      app: m.app || null,
      kind: 'ringing',
      ...(m.caller ? { caller: m.caller } : {}),
      windowId: String(w.id),
      window: windowInfo(w),
      display: this._displayOf(w),
      source: m.source,
      confidence: m.confidence,
      ts: now,
      ...(m.browser ? { browser: m.browser } : {}),
      ...(m.learned ? { learned: m.learned } : {}),
      ...extra,
    };
  }

  _addWeak(s) {
    this._weak.push(s);
    if (this._weak.length > 40) this._weak.shift();
    this._emitSafe('signal', { kind: s.kind, confidence: s.confidence, ts: s.ts, windowId: s.windowId, display: s.display, region: s.region });
  }

  async _pollWindows(now, strong, inCall) {
    let list;
    try {
      list = await this.driver.listWindows();
      this.signals.titles = true;
    } catch (err) {
      if (this.signals.titles !== false) log.info('window titles unavailable for call detection:', err && err.message);
      this.signals.titles = false;
      return null;
    }
    list = Array.isArray(list) ? list : [];
    let screenArea = 0;
    try {
      screenArea = (await this._getDisplays()).reduce((a, d) => a + d.width * d.height, 0);
    } catch {
      /* unknown screen size: new-window size checks are skipped */
    }
    const seen = new Set();
    const matches = new Map();
    for (const w of list) {
      if (w && w.id != null && !sig.excludedKind(w)) matches.set(w, sig.matchTitle(w, { learned: this.learned || [] }));
    }
    const zoomInCall = [...matches.values()].some((m) => m && m.kind === 'in_call' && m.app === 'zoom');
    for (const w of list) {
      if (!w || w.id == null) continue;
      const id = String(w.id);
      seen.add(id);
      const split = sig.splitBrowserTitle(w.title, w.app);
      const prev = this._windows.get(id);
      const isNew = !prev && !this._firstPoll;
      const entry = prev || { appearedAt: isNew ? now : null, tab: split.tab };
      entry.w = w;
      const changed = Boolean(prev) && prev.tab !== split.tab;
      if (changed) {
        entry.prevTab = prev.tab;
        entry.tab = split.tab;
        entry.titleChangedAt = now;
      }
      this._windows.set(id, entry);
      if (!matches.has(w)) continue; // our dialog, terminals and editors
      const m = matches.get(w);
      if (m && m.kind === 'ringing') {
        const cand = this._candidate(m, w, now);
        if (m.confidence >= sig.RING_THRESHOLD) strong.push(cand);
        else if (changed || isNew) this._addWeak({ kind: 'title', confidence: m.confidence, ts: now, windowId: id, app: m.app, candidate: cand });
      } else if (m && m.kind === 'in_call') {
        inCall.push({ app: m.app, windowId: id, ts: now });
      }
      if (isNew && !w.minimized) {
        const nw = sig.matchNewWindow(w, { screenArea, inMeeting: zoomInCall || Boolean(this._call && this._call.app === 'zoom') });
        if (nw) strong.push(this._candidate(nw, w, now));
        else if (!m && !split.browser && screenArea > 0) {
          const b = boundsOf(w);
          if (b && (b.width * b.height) / screenArea <= this.opts.smallWindowFrac) {
            this._addWeak({ kind: 'appeared', confidence: sig.CONFIDENCE.appeared, ts: now, windowId: id, bounds: b, display: this._displayOf(w) });
          }
        }
      } else if (changed && !m) {
        // A call app's own window changed its title to something unknown (not a tab switch: the
        // previous title was the same app's too). Below threshold: worth a vision look.
        const app = sig.appOfWindow(w, split);
        const prevApp = app && sig.appOfWindow({ ...w, title: entry.prevTab });
        if (app && prevApp && prevApp.id === app.id) {
          this._addWeak({ kind: 'title_change', confidence: sig.CONFIDENCE.titleChange, ts: now, windowId: id, app: app.id, bounds: boundsOf(w), display: this._displayOf(w) });
        }
      }
    }
    for (const id of [...this._windows.keys()]) if (!seen.has(id)) this._windows.delete(id);
    this._firstPoll = false;
    this._lastWindows = list;
    return list;
  }

  /** A browser or app window showing the given call app (for notification-only rings). */
  _windowForApp(app, windows) {
    if (!app || !Array.isArray(windows)) return null;
    const hits = windows.filter((w) => w && w.id != null && !sig.excludedKind(w) && (sig.appOfWindow(w) || {}).id === app);
    return hits.find((w) => w.focused) || hits[0] || null;
  }

  _drainNotifications(now, strong, windows) {
    const queue = this._notifQueue.splice(0);
    for (const n of queue) {
      const m = sig.matchNotification(n, { learned: this.learned || [] });
      if (!m) continue;
      const w = this._windowForApp(m.app, windows);
      const cand = {
        ...m,
        ts: now,
        notification: { app: String(n.app || ''), summary: String(n.summary || ''), body: String(n.body || ''), origin: n.origin || null },
        ...(n.bounds ? { banner: { ...n.bounds } } : {}),
        ...(w ? { windowId: String(w.id), window: windowInfo(w), display: this._displayOf(w) } : {}),
      };
      if (m.confidence >= sig.RING_THRESHOLD) this._notifCands.push(cand);
      else this._addWeak({ kind: 'notification', confidence: m.confidence, ts: now, app: m.app, candidate: cand, windowId: cand.windowId, display: cand.display });
    }
    this._notifCands = this._notifCands.filter((c) => now - c.ts <= this.opts.notificationTtlMs);
    strong.push(...this._notifCands);
  }

  async _diffScreens(now) {
    this._lastDiffAt = now;
    if (typeof this.driver.captureDisplay !== 'function') {
      this.signals.screenDiff = false;
      return;
    }
    let displays;
    try {
      displays = await this._getDisplays();
    } catch {
      this.signals.screenDiff = false;
      return;
    }
    for (let i = 0; i < displays.length; i++) {
      let t;
      try {
        const cap = await this.driver.captureDisplay(i);
        t = sd.thumb(cap.png);
      } catch (err) {
        if (this.signals.screenDiff !== false) log.info('screen capture unavailable for call detection:', err && err.message);
        this.signals.screenDiff = false;
        return;
      }
      this.signals.screenDiff = true;
      const r = this.tracker.push(i, t);
      if (r.changed) {
        this._lastDiff = { display: i, region: r.region, ts: now };
        this._addWeak({ kind: 'screen_diff', confidence: sig.CONFIDENCE.screenDiff, ts: now, display: i, region: r.region });
      }
    }
  }

  // ------------------------------------------------------------ states

  _startRing(cand, now, inCall = []) {
    // In-call signatures already showing when it started ring are not "the user picked up".
    const inCallAtStart = new Set(inCall.map((x) => `${x.app}|${x.windowId}`));
    this._ring = { candidate: { ...cand }, since: now, lastSeen: now, sources: new Set([cand.source]), inCallAtStart };
    this._visionHits = 0;
    this.state = 'ringing';
    this._emitSafe('candidate', cand);
    this._emitSafe('ringing', { candidate: this._ring.candidate, since: now });
  }

  async _watching(now, strong, inCall) {
    const best = pickBest(strong);
    if (best) {
      this._startRing(best, now, inCall);
      return;
    }
    if (!this._visionEnabled() || !this._weak.length) {
      if (!this._weak.length) this._visionHits = 0;
      return;
    }
    // Screen diffs alone trigger a look only where titles and notifications are unavailable
    // (macOS); any other weak signal (a call app's title changed, a new small window, an
    // unconvincing notification or title) does everywhere.
    const blind = this.signals.titles !== true && this.signals.notifications !== true;
    const trigger = [...this._weak].reverse().find((w) => w.kind !== 'screen_diff') || (blind ? this._weak[this._weak.length - 1] : null);
    if (!trigger) return;
    const purpose = this._visionHits > 0 ? 'confirm' : 'probe';
    if (typeof this.vision.canCheck === 'function' && !this.vision.canCheck(purpose).ok) return;
    const display = Number.isInteger(trigger.display) ? trigger.display : 0;
    let shot;
    let res;
    try {
      const computer = await this.getComputer();
      shot = await computer.screenshot({ display });
      res = await this.vision.detect(shot.png, { purpose });
    } catch (err) {
      if (!err || err.code !== 'VISION_RATE_LIMIT') log.info('vision check for a possible call failed:', err && err.message);
      return;
    }
    if (this.state !== 'watching') return;
    if (!res || !res.incoming) {
      this._visionHits = 0;
      this._weak = [];
      return;
    }
    this._visionHits++;
    trigger.ts = this.clock.now(); // keep the trigger alive for the confirming look
    if (this._visionHits < 2) return;
    const tc = trigger.candidate || {};
    const cand = {
      app: res.appId || trigger.app || tc.app || null,
      kind: 'ringing',
      ...(mergeCaller(res.caller, tc.caller) ? { caller: mergeCaller(res.caller, tc.caller) } : {}),
      ...(trigger.windowId ? { windowId: trigger.windowId } : {}),
      ...(tc.window ? { window: tc.window } : trigger.windowId && this._windows.get(trigger.windowId) ? { window: windowInfo(this._windows.get(trigger.windowId).w) } : {}),
      display,
      ...(trigger.region ? { region: trigger.region } : {}),
      source: 'vision',
      confidence: VISION_CONFIDENCE,
      ts: this.clock.now(),
      signals: [trigger.kind],
      vision: { ...res, shot: { width: shot.width, height: shot.height, display: shot.display } },
    };
    this._weak = [];
    this._startRing(cand, this.clock.now(), inCall);
  }

  _ringing(now, strong, inCall) {
    const ring = this._ring;
    if (!ring) {
      this.state = 'watching';
      return;
    }
    const c = ring.candidate;
    // The ring we follow is gone from this poll while a stronger ring shows elsewhere (a transient
    // window carried the ring text first, a generic match is followed by the learned one): switch.
    const seenNow = strong.some((s) => sameCall(c, s)) || (c.source === 'vision' && now - ring.since <= this.opts.visionRingTtlMs);
    const better = seenNow || this._answering ? null : pickBest(strong.filter((s) => !sameCall(c, s) && s.confidence > c.confidence));
    if (better) {
      this._endRing('replaced', now, false);
      this._startRing(better, now, inCall);
      return;
    }
    for (const s of strong) {
      if (sameCall(c, s)) {
        ring.lastSeen = now;
        ring.sources.add(s.source);
        const caller = mergeCaller(c.caller, s.caller);
        if (caller) c.caller = caller;
        else if (c.caller && s.caller) c.callerConflict = true;
        if (!c.app && s.app) c.app = s.app;
        if (!c.windowId && s.windowId) Object.assign(c, { windowId: s.windowId, window: s.window, display: s.display });
        if (!c.learned && s.learned) c.learned = s.learned;
        if (!c.origin && s.origin) c.origin = s.origin;
        if (s.confidence > c.confidence) c.confidence = s.confidence;
      } else {
        this._emitBusy(s, now);
      }
    }
    if (c.source === 'vision' && now - ring.since <= this.opts.visionRingTtlMs && !this._popupGone(ring, now)) ring.lastSeen = now;
    // The user picked up elsewhere (the in-call signature of this app appeared): the ring is over
    // even while a notification is still fresh.
    const fresh = inCall.filter((x) => !ring.inCallAtStart.has(`${x.app}|${x.windowId}`));
    const pickedUp = fresh.some((x) => (c.app && x.app === c.app) || (c.windowId && sameWindowId(x.windowId, c.windowId)));
    if (pickedUp && !this._answering) {
      this._endRing('answered_elsewhere', now, true);
      return;
    }
    if (now - ring.lastSeen < this.opts.ringGraceMs) return;
    if (this._answering) return; // the manager's answer routine decides (callStarted / answerFailed)
    this._endRing(pickedUp ? 'answered_elsewhere' : 'missed', now, pickedUp);
  }

  /** A screen change over the vision ring's region after it started: the popup went away. */
  _popupGone(ring, now) {
    const c = ring.candidate;
    const d = this._lastDiff;
    if (!c.region || !d || d.ts <= ring.since + this.opts.diffMs || d.display !== c.display || now - d.ts > this.opts.diffMs * 2) return false;
    const a = c.region;
    const b = d.region;
    const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return ix * iy >= 0.5 * Math.min(a.width * a.height, b.width * b.height);
  }

  _endRing(reason, now, userAnswered) {
    const ring = this._ring;
    this._ring = null;
    this._answering = false;
    this._notifCands = [];
    this.state = 'watching';
    if (ring) this._emitSafe('ring_ended', { candidate: ring.candidate, reason, userAnswered: Boolean(userAnswered), since: ring.since, ms: now - ring.since });
  }

  /** Another call rang while one is active or ringing: tell the manager once per call. */
  _emitBusy(s, now) {
    const key = `${s.source}|${s.app}|${s.windowId || ''}|${s.caller || ''}`;
    const last = this._busyKeys.get(key);
    this._busyKeys.set(key, now);
    if (last != null && now - last < 60000) return;
    this._emitSafe('candidate', { ...s, busy: true });
  }

  _inCall(now, strong, inCall, windows) {
    const call = this._call;
    if (!call) {
      this.state = 'watching';
      return;
    }
    for (const s of strong) this._emitBusy(s, now);
    const mine = inCall.some((x) => (call.windowId && sameWindowId(x.windowId, call.windowId)) || (call.app && x.app === call.app));
    if (mine) call.inCallSeen = true;
    let gone = null;
    if (call.windowId && Array.isArray(windows) && !windows.some((w) => w && sameWindowId(w.id, call.windowId))) gone = 'window_closed';
    else if (call.inCallSeen && !mine && Array.isArray(windows)) gone = 'in_call_signal_gone';
    if (!gone) {
      call.goneSince = null;
      return;
    }
    if (call.goneSince == null) call.goneSince = now;
    if (!call.ended && now - call.goneSince >= this.opts.callGoneMs) {
      call.ended = true;
      this._emitSafe('call_ended', { reason: gone, call: { ...call } });
    }
  }

  // ------------------------------------------------------------ calibration (§4.4)

  /**
   * `anywhere calls learn`: while a test call rings, record title changes, new windows,
   * notifications, the screen-diff region and one vision description, and save a signature to
   * <state>/calls/signatures.json. Run it while calls are not armed.
   * @param {{seconds?:number, app?:string, save?:boolean, signal?:AbortSignal,
   *   onProgress?:(p:{stage:string, message:string})=>void}} [opts]
   * @returns {Promise<{ok:boolean, signature?:object, reason?:string, observed:object}>}
   */
  async learn({ seconds = 60, app: wantApp, save = true, signal, onProgress } = {}) {
    const sleep = this.opts.sleep || util.sleep;
    const now = () => this.clock.now();
    const progress = (stage, message) => {
      if (typeof onProgress === 'function') {
        try {
          onProgress({ stage, message });
        } catch {
          /* ignore */
        }
      }
    };
    if (!this.vision || !this.getComputer) return { ok: false, reason: 'Learning needs the vision check and screenshots.', observed: {} };
    if (this.state !== 'stopped') return { ok: false, reason: 'Turn off call answering (anywhere calls off) before learning a call signature.', observed: {} };
    const computer = await this.getComputer();
    const notes = [];
    const onN = (n) => notes.push({ n, ts: now() });
    let startedWatcher = false;
    if (this.notifications) {
      this.notifications.on('notification', onN);
      if (typeof this.notifications.start === 'function' && this.notifications.running !== true) {
        const r = this.notifications.start();
        startedWatcher = Boolean(r && r.ok);
      }
    }
    const tracker = new sd.ScreenDiffTracker();
    const baseline = new Map(); // id -> tab
    const titles = new Map(); // id -> [{tab, ts}] title changes of windows that existed before
    const appeared = []; // [{w, ts}] windows that appeared
    const diffs = [];
    const seenWins = new Map(); // id -> latest window record (kept after the window closes)
    const pollWindows = async () => {
      let list = [];
      try {
        list = (await this.driver.listWindows()) || [];
      } catch {
        return;
      }
      for (const w of list) {
        if (!w || w.id == null || sig.excludedKind(w)) continue;
        const id = String(w.id);
        seenWins.set(id, w);
        const tab = sig.splitBrowserTitle(w.title, w.app).tab;
        if (!baseline.has(id)) {
          if (!appeared.some((a) => String(a.w.id) === id)) appeared.push({ w, ts: now() });
          continue;
        }
        const seq = titles.get(id) || [];
        const last = seq.length ? seq[seq.length - 1].tab : baseline.get(id);
        if (tab !== last) {
          seq.push({ tab, ts: now() });
          titles.set(id, seq);
        }
      }
    };
    const diffAll = async () => {
      let displays = [];
      try {
        displays = await this._getDisplays();
      } catch {
        return;
      }
      for (let i = 0; i < displays.length; i++) {
        try {
          const cap = await this.driver.captureDisplay(i);
          const r = tracker.push(i, sd.thumb(cap.png));
          if (r.changed) diffs.push({ display: i, region: r.region, ts: now() });
        } catch {
          return;
        }
      }
    };
    try {
      progress('baseline', 'Recording the screen before the test call…');
      await this._getDisplays().catch(() => null);
      for (const w of (await this.driver.listWindows()) || []) {
        if (!w || w.id == null || sig.excludedKind(w)) continue;
        baseline.set(String(w.id), sig.splitBrowserTitle(w.title, w.app).tab);
        seenWins.set(String(w.id), w);
      }
      if (typeof this.driver.captureDisplay === 'function') await diffAll();
      progress('waiting', 'Place the test call now. Let it ring; do not answer yet.');
      const t0 = now();
      let visionTries = 0;
      let checked = 0; // evidence count at the last look
      let settleFrom = -1; // evidence count first seen one poll ago (the ring UI settles for a poll)
      let ring = null; // {res, shot, at}
      while (now() - t0 < seconds * 1000) {
        if (signal && signal.aborted) break;
        await sleep(this.opts.learnPollMs);
        await pollWindows();
        if (typeof this.driver.captureDisplay === 'function') await diffAll();
        // Look again only when something new changed (a page load before the ring must not use up
        // the looks), at most MAX_LEARN_LOOKS times.
        let evidence = appeared.length + notes.length + diffs.length;
        for (const seq of titles.values()) evidence += seq.length;
        if (!ring && evidence > checked) {
          if (settleFrom !== evidence) {
            if (settleFrom < 0) progress('ringing', 'Something changed on the screen; checking it…');
            settleFrom = evidence;
            continue;
          }
          if (visionTries >= MAX_LEARN_LOOKS) continue;
          checked = evidence;
          visionTries++;
          const display = this._learnDisplay(titles, appeared, diffs, seenWins);
          try {
            const shot = await computer.screenshot({ display });
            const res = await this.vision.detect(shot.png, { purpose: 'learn' });
            if (res.incoming) {
              ring = { res, png: shot.png, shot: { width: shot.width, height: shot.height, display: shot.display == null ? display : shot.display }, at: now() };
              progress('seen', `Seen the ringing call${res.caller ? ` from ${res.caller}` : ''}. Now answer it, then hang up after a few seconds, so I also learn how a call in progress looks.`);
            }
          } catch (err) {
            progress('vision_failed', `The screen check failed: ${err.message}`);
          }
        }
        // After the ring was seen, watch 15 s more for the in-call title.
        if (ring && now() - ring.at > 15000) break;
      }
      const observed = {
        titleChanges: [...titles.entries()].map(([id, seq]) => ({ id, before: baseline.get(id) || null, after: seq.map((x) => x.tab) })),
        newWindows: appeared.map((a) => ({ id: String(a.w.id), app: a.w.app || '', title: a.w.title || '' })),
        notifications: notes.map((x) => ({ app: x.n.app, summary: x.n.summary, body: x.n.body, origin: x.n.origin || null })),
        screenChanges: diffs.length,
        vision: ring ? { app: ring.res.app, caller: ring.res.caller, accept: ring.res.accept } : null,
      };
      if (!ring) {
        return { ok: false, reason: 'No ringing call was seen. Place the test call while this runs, and keep the call app visible.', observed };
      }
      const built = this._buildSignature({ ring, titles, baseline, appeared, notes, diffs, wantApp, computer, windows: [...seenWins.values()] });
      if (!built.ok) return { ...built, observed };
      let signature = built.signature;
      if (save) {
        signature = sig.saveLearned(signature, { file: this.learnedFile });
        this.reloadLearned();
      }
      progress('saved', 'Saved the call signature.');
      return { ok: true, signature, observed };
    } finally {
      if (this.notifications) {
        this.notifications.removeListener('notification', onN);
        if (startedWatcher && typeof this.notifications.stop === 'function') this.notifications.stop();
      }
    }
  }

  _learnDisplay(titles, appeared, diffs, seenWins) {
    for (const id of titles.keys()) {
      const w = seenWins.get(id);
      if (w) return this._displayOf(w);
    }
    if (appeared.length) return this._displayOf(appeared[0].w);
    if (diffs.length) return diffs[0].display;
    return 0;
  }

  _buildSignature({ ring, titles, baseline, appeared, notes, diffs, wantApp, computer, windows }) {
    const res = ring.res;
    const caller = res.caller || null;
    const winById = (id) => (windows || []).find((w) => w && sameWindowId(w.id, id)) || null;
    // The ringing window: a window whose title changed while it rang, else a new window.
    let ringWin = null;
    let ringTab = null;
    let afterTab = null;
    for (const [id, seq] of titles) {
      const during = seq.filter((x) => x.ts <= ring.at + 2000);
      if (!during.length) continue;
      const w = winById(id);
      if (!w) continue;
      const tab = during[during.length - 1].tab;
      if (!tab || tab === baseline.get(id)) continue;
      ringWin = w;
      ringTab = tab;
      const later = seq.filter((x) => x.ts > ring.at + 2000 && x.tab !== tab && x.tab !== baseline.get(id) && !ENDED_RE.test(x.tab));
      if (later.length) afterTab = later[later.length - 1].tab;
      break;
    }
    if (!ringWin && appeared.length) ringWin = winById(appeared[0].w.id) || appeared[0].w;
    const note = notes.length ? notes[0].n : null;
    const app =
      sig.appFromText(wantApp) ||
      res.appId ||
      (note && (sig.appFromOrigin(note.origin) || sig.appFromText(note.app))) ||
      (ringWin && (sig.appOfWindow(ringWin) || {}).id) ||
      null;
    if (!app) return { ok: false, reason: 'Could not tell which app rang. Run it again with --app (for example --app cliq).' };
    const out = { app };
    if (ringTab) {
      const re = sig.textPattern(ringTab, caller);
      // Not distinctive if it also matches how the window looked before the call.
      const compiled = re ? new RegExp(re, 'iu') : null;
      if (compiled && ![...baseline.values()].some((t) => compiled.test(t))) out.titleRe = re;
    }
    if (afterTab) {
      const re = sig.textPattern(afterTab, caller);
      if (re) out.inCallTitleRe = re;
    }
    if (note) {
      const summary = sig.normalizeTitle(note.summary);
      const body = sig.normalizeTitle(note.body);
      const pick = body && (!summary || (caller && summary.toLowerCase() === caller.toLowerCase()) || sig.GENERIC_RINGING_RE.test(body)) ? body : summary;
      const re = sig.textPattern(pick.split('\n')[0], caller);
      if (re) out.notifRe = re;
      if (note.origin) out.origin = note.origin;
    }
    if (!out.titleRe && !out.notifRe) {
      return {
        ok: false,
        reason:
          'The call was seen, but neither a window title nor a notification changed while it rang. Open the call app in its own window and turn on its call notifications, then run this again.',
      };
    }
    if (ringWin) {
      const split = sig.splitBrowserTitle(ringWin.title, ringWin.app);
      if (split.browser) out.browser = split.browser.id;
      else if (ringWin.app) out.process = String(ringWin.app).slice(0, 80);
    }
    // Where the popup and its Accept button are, relative to the ringing window (else the display).
    let bounds = boundsOf(ringWin);
    if (!bounds) {
      const d = this._displays && this._displays[ring.shot.display];
      if (d) {
        bounds = { x: d.x, y: d.y, width: d.width, height: d.height };
        out.relativeTo = 'display';
        out.display = ring.shot.display;
      }
    }
    let acceptLogical = null;
    if (bounds && res.accept && computer && typeof computer.toLogical === 'function') {
      try {
        const lp = computer.toLogical(ring.shot.display, res.accept.x, res.accept.y);
        acceptLogical = lp;
        const rel = sig.relativePoint(lp, bounds);
        if (rel) {
          out.acceptRel = rel;
          out.windowSize = { width: bounds.width, height: bounds.height };
          const color = ring.png ? sd.patchColor(ring.png, res.accept) : null;
          if (color) out.acceptColor = color;
        }
      } catch (err) {
        log.debug('could not map the learned Accept point:', err.message);
      }
    }
    // The popup: the screen change around the Accept button (not, say, the page loading).
    const disp = this._displays && this._displays[ring.shot.display];
    const rectOf = (d) => {
      const r = sd.regionToRect(d.region, disp.width, disp.height);
      return { x: disp.x + r.x, y: disp.y + r.y, width: r.width, height: r.height };
    };
    const diff =
      disp && acceptLogical
        ? diffs
            .filter((d) => d.display === ring.shot.display && d.ts <= ring.at)
            .reverse()
            .find((d) => {
              const a = rectOf(d);
              return acceptLogical.x >= a.x && acceptLogical.y >= a.y && acceptLogical.x < a.x + a.width && acceptLogical.y < a.y + a.height;
            })
        : null;
    if (bounds && diff && disp) {
      const abs = rectOf(diff);
      out.popupRegion = {
        x: Math.round(((abs.x - bounds.x) / bounds.width) * 10000) / 10000,
        y: Math.round(((abs.y - bounds.y) / bounds.height) * 10000) / 10000,
        width: Math.round((abs.width / bounds.width) * 10000) / 10000,
        height: Math.round((abs.height / bounds.height) * 10000) / 10000,
      };
    }
    out.learnedAt = new Date(this.clock.now()).toISOString();
    return { ok: true, signature: out };
  }
}

module.exports = { CallDetector, DEFAULTS, mergeCaller, sameCall, boundsOf, VISION_CONFIDENCE };
