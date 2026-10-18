'use strict';

/**
 * CallManager: arming, ring handling, answering, the call session, the call tools and wrap-up
 * (docs/CALLS-DESIGN.md §1.3 (d), §4.2, §6, §7, §8).
 *
 *   disarmed ─requestArm(): a CRITICAL card in the dialog that only a click on "Allow once" allows─► armed
 *   armed ─detector 'ringing'─► ringing: quiet hours / app not armed / owner active → let it ring (logged);
 *          else wait calls.answerAfterSec (the user may pick up) → answering: audio routed (AudioBridge.engage),
 *          answer.js clicks Accept (gated, verified) → in_call: CallSession (session.js)
 *   in_call ─hang-up (either side), call_end, max duration, Take over─► wrap_up: summary turn, chat messages
 *          sent after the call (cliq.js), notes on the Desktop (notes.js), call data under <state>/calls/<id>/,
 *          announcement ─► armed (or disarmed when the time ran out or the user disarmed)
 *
 * Arming lives only in this object's memory (a daemon restart disarms), expires (default 2 h, at most 12 h),
 * and needs a click: the card is raised through the permission broker as risk 'critical' (voice and keys
 * cannot allow it there), and an allow that did not come from a click ("typed", or a client that does not
 * say) is refused here as well. Disarming never needs a confirmation.
 *
 * The call engine's tools reach tool(callId, name, args) through POST /api/calls/tool. Every call is checked
 * by CallPolicy (allowlist, per-call budgets, caller binding, server-built JQL, text hygiene), audited, and
 * written to the call's action log, which — not the model's claims — becomes "Actions taken" in the notes.
 *
 *   new CallManager({config, hub, permissions, clone, getDriver, getComputer, …}); status(); requestArm({minutes,
 *   apps, instructions, via, signal}); disarm(why); currentCall(); tool(callId, name, args); takeover(); hangup();
 *   simulate({app, caller, engage}); learn(opts); audioSetup()/audioTeardown()/audioCheck(); selfTestStart(port);
 *   shutdown()
 * Events: 'state' (status()), 'transcript', 'action', 'notes', 'missed'.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const policyMod = require('./policy');
const promptMod = require('./prompt');
const sessionMod = require('./session');
const greetingMod = require('./greeting');
const logMod = require('../shared/log');

const log = logMod.createLogger('calls');

const ARM_TOOL = 'mcp__anywhere__calls_arm';
const ARM_REASON = 'Answer phone calls for you with your voice';
const DEFAULT_ARM_VIA = Object.freeze(['click']);
const RECENT_MAX = 25;
const PROJECTS_TTL_MS = 10 * 60 * 1000;
// Missed calls.md wording for the reasons a call was not answered.
const MISSED_REASONS = Object.freeze({
  quiet_hours: 'quiet hours: not answered',
  app_not_armed: 'not answered: this app was not chosen when calls were turned on',
  owner_active: 'not answered: you were using the computer',
  idle_unknown: 'not answered: your idle time could not be read',
  busy: 'not answered: another call was in progress',
  not_answered: 'rang out',
  ring_ended: 'the caller hung up before it was answered',
  missed: 'the caller hung up before it was answered',
  audio: 'could not answer: the call audio could not be routed',
});
const APP_NAMES = Object.freeze({ 'zoho-cliq': 'Zoho Cliq', 'google-meet': 'Google Meet', teams: 'Microsoft Teams', slack: 'Slack', zoom: 'Zoom' });

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function oneLine(s, max) {
  const t = str(s).replace(/\s+/g, ' ').trim();
  return max && t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function optionalModule(rel) {
  try {
    return require(rel);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(path.basename(rel))) return null;
    throw err;
  }
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function appName(id) {
  return APP_NAMES[id] || (id ? String(id) : 'the call app');
}

function firstNameOf(name) {
  return oneLine(name).split(' ')[0] || '';
}

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch {
    /* busy or gone */
  }
}

class CallManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {object|(()=>object)} o.config      the live config
   * @param {{broadcast:Function}} [o.hub]
   * @param {object} o.permissions               PermissionBroker (prompt/request, pending, cancel, 'decision' events)
   * @param {object} [o.clone]                    CloneService (sidecar, cloned voice, STT)
   * @param {()=>Promise<object>} [o.getDriver]
   * @param {()=>Promise<object>} [o.getComputer]
   * @param {object|Function} [o.bridge]         AudioBridge or a factory
   * @param {object|Function} [o.detector]       CallDetector or a factory ({driver, getComputer, config, vision, notifications})
   * @param {object|Function} [o.vision]         VisionClient or a factory
   * @param {object|Function} [o.notifications]  NotificationWatcher or a factory
   * @param {object|Function} [o.jira]           a JiraClient-like object or (config) => client|null
   * @param {object} [o.answer]                  {answerCall, hangUp, cameraOff} (default ./answer)
   * @param {object} [o.notes]                   {writeNotes} (default ./notes when present)
   * @param {object} [o.cliq]                    {sendViaGui, CliqApi} (default ./cliq when present)
   * @param {object|Function} [o.piper]          PiperManager (the Piper fallback voice) or a getter
   * @param {(text:string, out:string)=>Promise<any>} [o.osRender] the OS-voice fallback
   * @param {()=>({url:string, token:string})} [o.daemonInfo] where the call engine's MCP server reaches the daemon
   * @param {(config:object)=>Promise<{path:string}|null>} [o.locateClaude]
   * @param {(spec:object)=>Promise<object>} [o.engineFactory] a started call engine (tests)
   * @param {(event:object)=>void} [o.audit]
   * @param {object} [o.clock] {now, setTimeout, clearTimeout, setInterval, clearInterval}
   * @param {string} [o.callsDir]
   * @param {string[]} [o.armVia] how the card may be allowed (default ['click'])
   * @param {object} [o.sessionOptions]           CallSession option overrides (tests)
   * @param {()=>Promise<number|null>} [o.idleSeconds] the user's input idle time (answerOnlyWhenIdleSec)
   */
  constructor(o = {}) {
    super();
    this.o = o;
    this.configRef = o.config || {};
    this.hub = o.hub || null;
    this.permissions = o.permissions || null;
    this.clone = o.clone || null;
    this.getDriver = typeof o.getDriver === 'function' ? o.getDriver : async () => null;
    this.getComputer = typeof o.getComputer === 'function' ? o.getComputer : async () => null;
    this.answer = o.answer || require('./answer');
    this.auditFn = typeof o.audit === 'function' ? o.audit : logMod.audit;
    const c = o.clock || {};
    this.clock = {
      now: typeof c.now === 'function' ? () => c.now() : () => Date.now(),
      setTimeout: typeof c.setTimeout === 'function' ? (fn, ms) => c.setTimeout(fn, ms) : (fn, ms) => setTimeout(fn, ms),
      clearTimeout: typeof c.clearTimeout === 'function' ? (t) => c.clearTimeout(t) : (t) => clearTimeout(t),
    };
    this.armVia = Array.isArray(o.armVia) && o.armVia.length ? o.armVia.slice() : DEFAULT_ARM_VIA.slice();
    this.policy = new policyMod.CallPolicy({ config: () => this.config() });
    this.state = 'disarmed';
    this.armed = null; // {until, minutes, apps, instructions, at, via, owner, ownerFirst, cloned, voiceEngine}
    this.call = null; // the active call context
    this.recent = [];
    this.prewarmed = null; // {id, engine}
    this._arming = null;
    this._expiryTimer = null;
    this._ringAbort = null;
    this._sidecarHeld = false;
    this._bridge = null;
    this._detector = null;
    this._vision = null;
    this._notifications = null;
    this._selfTest = null;
    this._jiraCache = null;
    this._projects = null; // {list, at}
    this._lastAudioCheck = null;
    this._closed = false;
    this._onRinging = (e) => this._ringing(e).catch((err) => log.warn(`handling a ringing call failed: ${err && err.message}`));
    this._onRingEnded = (e) => this._ringEnded(e);
    this._onCallEnded = (e) => this._callEnded(e);
    this._onCandidate = (e) => this._candidate(e);
  }

  config() {
    const c = typeof this.configRef === 'function' ? this.configRef() : this.configRef;
    return c || {};
  }

  callsCfg() {
    const c = this.config().calls;
    return c && typeof c === 'object' ? c : {};
  }

  now() {
    return this.clock.now();
  }

  _broadcast(type, data) {
    if (!this.hub || typeof this.hub.broadcast !== 'function') return;
    try {
      this.hub.broadcast(type, data);
    } catch (err) {
      log.warn(`broadcast ${type} failed: ${err && err.message}`);
    }
  }

  _audit(event) {
    try {
      this.auditFn(event);
    } catch (err) {
      log.warn(`audit failed: ${err && err.message}`);
    }
  }

  _setState(state) {
    this.state = state;
    const s = this.status();
    this._broadcast('calls', { state: s.state, armed: s.armed, armedUntil: s.until, apps: s.apps, call: s.current });
    this.emit('state', s);
  }

  _notify(text, level = 'info', { speak = false } = {}) {
    this._broadcast('notify', { text, level, speak });
  }

  // ------------------------------------------------------------------------------ collaborators

  bridge() {
    if (this._bridge) return this._bridge;
    const b = this.o.bridge;
    if (b && typeof b === 'object') this._bridge = b;
    else if (typeof b === 'function') this._bridge = b();
    else {
      const { AudioBridge } = require('./audio-bridge');
      this._bridge = new AudioBridge({
        platformInfo: this.o.platformInfo,
        config: () => this.config(),
        sidecar: () => (this.clone ? this.clone.getSidecar() : null),
        psHost: () => this.getDriver(),
      });
    }
    return this._bridge;
  }

  vision() {
    if (this._vision) return this._vision;
    const v = this.o.vision;
    if (v && typeof v === 'object') this._vision = v;
    else if (typeof v === 'function') this._vision = v();
    else {
      const { VisionClient } = require('./vision');
      this._vision = new VisionClient({ config: this.config(), model: this.callsCfg().model || undefined });
    }
    return this._vision;
  }

  async detector() {
    if (this._detector) return this._detector;
    const d = this.o.detector;
    if (d && typeof d === 'object') this._detector = d;
    else {
      const driver = await this.getDriver();
      if (!driver) throw httpError(503, 'The desktop driver is not available, so calls cannot be detected', { code: 'NO_DRIVER', hint: 'Run: anywhere doctor' });
      let notifications = this.o.notifications;
      if (typeof notifications === 'function') notifications = notifications();
      if (notifications === undefined) {
        const n = require('./notifications');
        notifications = n.createNotificationWatcher({ platform: this.o.platformInfo || require('../shared/platform').info(), driver });
      }
      this._notifications = notifications || null;
      const spec = { driver, getComputer: this.getComputer, config: this.config(), vision: this.vision(), notifications: notifications || null };
      if (typeof d === 'function') this._detector = d(spec);
      else {
        const { CallDetector } = require('./detector');
        this._detector = new CallDetector(spec);
      }
    }
    const det = this._detector;
    if (!det._callsWired) {
      det._callsWired = true;
      det.on('ringing', this._onRinging);
      det.on('ring_ended', this._onRingEnded);
      det.on('call_ended', this._onCallEnded);
      det.on('candidate', this._onCandidate);
    }
    return det;
  }

  /** A Jira client for the configured account, or null. */
  jira() {
    const j = this.o.jira;
    if (j && typeof j === 'object') return j;
    if (typeof j === 'function') return j(this.config()) || null;
    const jiraMod = require('../integrations/jira');
    const s = jiraMod.currentSettings(this.config());
    if (!s || !s.configured) return null;
    const fp = `${s.baseUrl}\n${s.email}\n${s.apiToken}`;
    if (!this._jiraCache || this._jiraCache.fp !== fp) this._jiraCache = { fp, client: new jiraMod.JiraClient({ baseUrl: s.baseUrl, email: s.email, apiToken: s.apiToken }) };
    return this._jiraCache.client;
  }

  notesModule() {
    if (this.o.notes !== undefined) return this.o.notes;
    return optionalModule('./notes');
  }

  cliqModule() {
    if (this.o.cliq !== undefined) return this.o.cliq;
    return optionalModule('./cliq');
  }

  piper() {
    const p = this.o.piper;
    const v = typeof p === 'function' ? p() : p;
    return v && typeof v.synthesize === 'function' ? v : null;
  }

  osRender() {
    if (typeof this.o.osRender === 'function') return this.o.osRender;
    try {
      const { defaultRenderSpeech } = require('./audio-bridge');
      return defaultRenderSpeech({ platform: (this.o.platformInfo && this.o.platformInfo.platform) || process.platform });
    } catch {
      return null;
    }
  }

  callsDir() {
    return this.o.callsDir || require('../shared/paths').callsDir();
  }

  // ------------------------------------------------------------------------------ status

  status() {
    const cfg = this.callsCfg();
    const qh = cfg.quietHours && typeof cfg.quietHours === 'object' ? cfg.quietHours : { enabled: false };
    const a = this.armed;
    let detector = null;
    try {
      detector = this._detector && typeof this._detector.status === 'function' ? this._detector.status() : null;
    } catch {
      detector = null;
    }
    const audio = this._lastAudioCheck ? { mode: this._lastAudioCheck.mode, ready: Boolean(this._lastAudioCheck.ready), issues: (this._lastAudioCheck.issues || []).map((i) => ({ code: i.code, level: i.level, message: i.message, hint: i.hint })) } : null;
    return {
      state: this.state,
      armed: Boolean(a),
      until: a ? new Date(a.until).toISOString() : null,
      untilLocal: a ? hhmm(a.until) : null,
      apps: a ? a.apps.slice() : policyMod.armApps(null, this.config()),
      instructions: a ? Boolean(a.instructions) : false,
      cloned: a ? Boolean(a.cloned) : null,
      voice: a ? a.voiceEngine || null : null,
      quietHours: { enabled: qh.enabled !== false, start: qh.start || null, end: qh.end || null },
      inQuietHours: policyMod.inQuietHours(new Date(this.now()), qh),
      audio,
      current: this.currentCall(),
      recent: this.recent.slice(0, RECENT_MAX),
      notesDir: typeof cfg.notesDir === 'string' ? cfg.notesDir : '',
      detector,
      arming: Boolean(this._arming),
    };
  }

  /**
   * status() plus the notes folder as resolved now (calls.notesDir, else the Desktop folder) and whether a
   * voice is recorded: GET /api/calls/status, for the panel and `anywhere calls status`.
   */
  async statusFull() {
    const s = this.status();
    const folder = await this._notesFolderCached();
    if (folder) s.notesDir = folder;
    try {
      const ps = this.clone && typeof this.clone.profileStatus === 'function' ? this.clone.profileStatus() : null;
      s.clone = { exists: Boolean(ps && ps.exists), ok: Boolean(ps && ps.ok) };
    } catch {
      s.clone = { exists: false, ok: false };
    }
    return s;
  }

  /** The notes folder (cached for a minute: on Windows it asks the PowerShell host). */
  async _notesFolderCached() {
    const notes = this.notesModule();
    if (!notes || typeof notes.notesFolder !== 'function') return null;
    const key = String(this.callsCfg().notesDir || '');
    const c = this._notesFolder;
    if (c && c.key === key && this.now() - c.at < 60000) return c.dir;
    try {
      let psHost = null;
      try {
        psHost = await this.getDriver();
      } catch {
        psHost = null;
      }
      const r = await Promise.race([
        notes.notesFolder({ config: this.config(), platformInfo: this.o.platformInfo, psHost }),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 5000);
          if (t.unref) t.unref();
        }),
      ]);
      const dir = r && r.dir ? r.dir : null;
      if (dir) this._notesFolder = { key, dir, at: this.now() };
      return dir;
    } catch (err) {
      log.debug(`the notes folder could not be resolved: ${err && err.message}`);
      return null;
    }
  }

  /** The active call ({id, caller, app, state, transcript, actions, …}) or null. */
  currentCall() {
    const c = this.call;
    if (!c) return null;
    const s = c.session ? c.session.status() : {};
    return {
      id: c.id,
      caller: c.caller || null,
      app: c.app || null,
      appName: c.appName,
      state: c.wrapping ? 'wrap_up' : s.state || 'starting',
      startedAt: s.startedAt || new Date(c.startedAt).toISOString(),
      cloned: Boolean(s.cloned),
      simulated: Boolean(c.simulate),
      transcript: c.session ? c.session.transcript().slice(-50) : [],
      actions: c.session ? c.session.actions() : [],
      saveTranscript: s.saveTranscript !== false,
    };
  }

  /** The CallSession of the active call (tests, routes). */
  currentSession() {
    return this.call ? this.call.session : null;
  }

  _recordRecent(item) {
    const entry = { at: new Date(this.now()).toISOString(), ...item, outcome: item.type };
    if (item.type === 'answered') entry.startedAt = entry.at;
    this.recent.unshift(entry);
    if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
    if (['missed', 'not_answered', 'failed'].includes(item.type)) this._missedLine(entry);
    return entry;
  }

  /**
   * §1.3(d): a call that was not answered (quiet hours, an app not chosen, the owner at the computer, a
   * failed answer) leaves a line in <notes>/Missed calls.md, so the user sees it after the arming is gone.
   */
  _missedLine(entry) {
    if (!entry || entry.simulated) return;
    const notes = this.notesModule();
    if (!notes || typeof notes.appendMissedCall !== 'function') return;
    const reason = MISSED_REASONS[entry.reason] || (entry.type === 'failed' ? `could not answer (${oneLine(entry.reason, 80) || 'unknown'})` : oneLine(entry.reason, 80) || 'not answered');
    Promise.resolve()
      .then(async () => {
        let psHost = null;
        try {
          psHost = await this.getDriver();
        } catch {
          psHost = null;
        }
        return notes.appendMissedCall({ config: this.config(), platformInfo: this.o.platformInfo, psHost, date: new Date(this.now()), caller: entry.caller || null, app: entry.app || null, reason });
      })
      .catch((err) => log.warn(`recording the missed call failed: ${err && err.message}`));
  }

  // ------------------------------------------------------------------------------ arming (d)

  /**
   * Ask the user (click-only critical card) to answer calls for a while, then prepare and arm.
   * @param {{minutes?:number, apps?:string[], instructions?:string, via?:string, signal?:AbortSignal}} [req]
   * @returns {Promise<{ok:boolean, armed?:boolean, until?:string, denied?:boolean, error?:string, hint?:string, code?:string}>}
   */
  async requestArm(req = {}) {
    if (this._closed) return { ok: false, error: 'Claude Anywhere is shutting down', code: 'SHUTTING_DOWN' };
    if (this._arming) return { ok: false, error: 'A request to answer your calls is already waiting for your click in the Claude Anywhere dialog.', code: 'BUSY' };
    this._arming = { at: this.now() };
    try {
      return await this._requestArm(req);
    } finally {
      this._arming = null;
      this._setState(this.state);
    }
  }

  async _requestArm({ minutes, apps, instructions, via, signal } = {}) {
    const cfg = this.config();
    // Apps were named but none of them can be answered: say so rather than arming every app.
    if (Array.isArray(apps) && apps.length && !apps.some((a) => policyMod.appIdOf(a))) {
      return { ok: false, error: `Calls cannot be answered in ${apps.map((a) => oneLine(a, 30)).join(', ')}. Supported: Zoho Cliq, Google Meet, Microsoft Teams, Slack, Zoom.`, code: 'UNSUPPORTED_APP' };
    }
    const win = policyMod.armWindow({ minutes, config: cfg, now: this.now() });
    const appList = policyMod.armApps(apps, cfg);
    const instr = promptMod.sanitizeInstructions(instructions);
    const origin = oneLine(via, 40) || 'unknown';
    // Fail early (no card) when calls cannot work at all.
    if (!this.permissions || (typeof this.permissions.prompt !== 'function' && typeof this.permissions.requestCritical !== 'function')) {
      return { ok: false, error: 'Approvals are not available, so calls cannot be turned on.', code: 'NO_APPROVALS' };
    }
    // F3-SAFE-D3: quiet hours that do not parse never silently turn off: arming is refused until fixed.
    const qhProblem = policyMod.quietHoursProblem(this.callsCfg().quietHours);
    if (qhProblem) {
      return { ok: false, error: `Calls cannot be answered: ${qhProblem}.`, hint: 'Fix them, e.g.: anywhere config set calls.quietHours.start 22:00 (and calls.quietHours.end 08:00)', code: 'QUIET_HOURS_INVALID' };
    }
    const pre = await this._preflight();
    if (!pre.ok) return pre;
    const qh = policyMod.quietHoursOf(this.callsCfg().quietHours);
    const names = appList.map(appName).join(', ');
    const summary = [
      `Answer calls for you until ${hhmm(win.until)} (${names})? The assistant says it is an AI and takes notes.`,
      qh.enabled && qh.startMin !== qh.endMin ? `Not during quiet hours (${qh.start}–${qh.end}).` : '',
      instr ? `Your instructions: ${oneLine(instr, 160)}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const input = { until: new Date(win.until).toISOString(), minutes: win.minutes, apps: appList, instructions: instr || undefined, requestedBy: origin };
    this._audit({ type: 'calls_arm_request', minutes: win.minutes, apps: appList, via: origin });
    const decision = await this._askCritical({ input, summary, signal });
    if (decision.behavior !== 'allow') {
      this._audit({ type: 'calls_arm', allowed: false, reason: decision.message || 'denied', via: origin });
      return { ok: false, denied: true, armed: false, message: decision.message || 'You did not allow answering calls.' };
    }
    // F3-SAFE-D1: the click must come from the dialog window itself (DaemonServer checks the dialog's
    // own credential, which engines never see), not just say via:'click'.
    if (!this.armVia.includes(decision.via) || decision.dialog !== true) {
      this._audit({ type: 'calls_arm', allowed: false, reason: `allowed by ${decision.via || 'an unknown method'}${decision.dialog === true ? '' : ' outside the dialog window'}, not a click`, via: origin });
      return { ok: false, denied: true, armed: false, code: 'CLICK_REQUIRED', error: 'Answering calls can only be turned on with a click on “Allow once” in the Claude Anywhere dialog.' };
    }
    if (signal && signal.aborted) return { ok: false, denied: true, armed: false, error: 'The request was withdrawn.' };
    // The time counts from the click.
    const armedWin = policyMod.armWindow({ minutes: win.minutes, config: this.config(), now: this.now() });
    const prep = await this._prepare({ instructions: instr });
    if (!prep.ok) {
      this._audit({ type: 'calls_arm', allowed: true, armed: false, reason: prep.error, via: origin });
      return { ok: false, armed: false, error: prep.error, hint: prep.hint, code: prep.code || 'NOT_READY' };
    }
    let det;
    try {
      det = await this.detector();
    } catch (err) {
      this._releaseSidecar();
      return { ok: false, armed: false, error: err.message, hint: err.hint, code: err.code || 'NO_DETECTOR' };
    }
    this.armed = {
      until: armedWin.until,
      minutes: armedWin.minutes,
      apps: appList,
      instructions: instr,
      at: this.now(),
      via: origin,
      owner: prep.owner,
      ownerFirst: prep.ownerFirst,
      cloned: prep.cloned,
      voiceEngine: prep.voiceEngine,
    };
    this._scheduleExpiry();
    if (!this.call) {
      this._pruneCallData();
      try {
        det.start();
      } catch (err) {
        log.warn(`starting call detection failed: ${err && err.message}`);
      }
      this._setState('armed');
      this._prewarmEngine().catch((err) => log.warn(`prewarming the call engine failed: ${err && err.message}`));
    } else {
      this._setState(this.state);
    }
    this._audit({ type: 'calls_arm', allowed: true, armed: true, until: new Date(armedWin.until).toISOString(), apps: appList, via: origin });
    log.info(`answering calls until ${hhmm(armedWin.until)} (${names})`);
    return { ok: true, armed: true, until: new Date(armedWin.until).toISOString(), untilLocal: hhmm(armedWin.until), minutes: armedWin.minutes, apps: appList, cloned: prep.cloned, voice: prep.voiceEngine, warnings: prep.warnings };
  }

  /** What must exist before the card is worth showing. */
  async _preflight() {
    if (!this.clone) return { ok: false, error: 'The voice runtime is missing from this installation.', code: 'NOT_AVAILABLE' };
    try {
      const rt = typeof this.clone.runtimeStatus === 'function' ? await this.clone.runtimeStatus() : { installed: true };
      if (rt && rt.installed === false) {
        return { ok: false, error: 'The free voice runtime (speech recognition and voices) is not installed yet.', hint: 'Install it: anywhere clone-voice install', code: 'NOT_INSTALLED' };
      }
    } catch (err) {
      return { ok: false, error: `The voice runtime cannot be checked: ${err.message}`, hint: err.hint || 'Run: anywhere calls doctor', code: 'NOT_INSTALLED' };
    }
    if (!this.o.engineFactory) {
      const located = await this._locateClaude().catch(() => null);
      if (!located) return { ok: false, error: 'The claude CLI was not found, so the assistant cannot talk.', hint: 'Install Claude Code or set engine.claudePath in Settings.', code: 'CLAUDE_NOT_FOUND' };
    }
    return { ok: true };
  }

  async _locateClaude() {
    if (typeof this.o.locateClaude === 'function') return this.o.locateClaude(this.config());
    if (this._claude && this.now() - this._claude.at < 10 * 60000) return this._claude.found;
    const found = await require('../daemon/engine-cli').ClaudeCliEngine.locate(this.config());
    this._claude = { found, at: this.now() };
    return found;
  }

  /**
   * Raise the click-only card and wait for it.
   * @returns {Promise<{behavior:'allow'|'deny', message?:string, via?:string}>}
   */
  _askCritical({ input, summary, signal }) {
    const perms = this.permissions;
    const toolUseId = `calls_arm_${crypto.randomBytes(12).toString('hex')}`;
    let via;
    let dialog = false;
    const onDecision = (e) => {
      if (e && e.toolUseId === toolUseId) {
        via = e.via;
        dialog = e.dialog === true;
      }
    };
    if (typeof perms.on === 'function') perms.on('decision', onDecision);
    const cls = { risk: 'critical', reason: ARM_REASON, summary, sensitive: true };
    let pending;
    try {
      pending =
        typeof perms.requestCritical === 'function'
          ? perms.requestCritical({ toolName: ARM_TOOL, input, reason: ARM_REASON, summary, toolUseId, clickOnly: true })
          : perms.prompt(ARM_TOOL, input, cls, toolUseId, 'answering calls needs a click');
    } catch (err) {
      if (typeof perms.removeListener === 'function') perms.removeListener('decision', onDecision);
      return Promise.resolve({ behavior: 'deny', message: `The card could not be shown: ${err.message}` });
    }
    let onAbort = null;
    if (signal) {
      onAbort = () => {
        try {
          const card = (typeof perms.pending === 'function' ? perms.pending() : []).find((c) => c && c.toolUseId === toolUseId);
          if (card && typeof perms.cancel === 'function') perms.cancel(card.id, 'The request to answer calls was withdrawn');
        } catch (err) {
          log.warn(`withdrawing the calls card failed: ${err.message}`);
        }
      };
      if (signal.aborted) setImmediate(onAbort);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    return Promise.resolve(pending)
      .then((d) => ({ behavior: d && d.behavior === 'allow' ? 'allow' : 'deny', message: d && d.message, via, dialog }))
      .catch((err) => ({ behavior: 'deny', message: `The card failed: ${err && err.message}` }))
      .finally(() => {
        if (typeof perms.removeListener === 'function') perms.removeListener('decision', onDecision);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      });
  }

  /**
   * Prewarm at arm time (§6.4): sidecar, VAD, STT, the cloned voice when there is a consented profile, a
   * warm-up synthesis, the greeting rendered once (arming fails when it cannot be), the audio check.
   */
  async _prepare({ instructions } = {}) {
    const warnings = [];
    const clone = this.clone;
    if (!this._sidecarHeld) {
      try {
        await (typeof clone.holdSidecar === 'function' ? clone.holdSidecar() : clone.getSidecar());
        this._sidecarHeld = typeof clone.holdSidecar === 'function';
      } catch (err) {
        return { ok: false, error: `The voice runtime did not start: ${err.message}`, hint: err.hint || 'Run: anywhere calls doctor', code: err.code };
      }
    }
    const fail = (r) => {
      this._releaseSidecar();
      return { ok: false, ...r };
    };
    try {
      await this._warmListening();
    } catch (err) {
      return fail({ error: `Speech recognition could not be loaded: ${err.message}`, hint: err.hint || 'Run: anywhere clone-voice install', code: err.code });
    }
    const cloned = await this._warmClone(warnings);
    const owner = await this._ownerName();
    const ownerFirst = firstNameOf(owner);
    const voice = this._voiceChain({ cloned });
    const pronoun = this.callsCfg().ownerPronoun;
    const g = greetingMod.composeGreeting({ callerName: '', ownerName: owner, ownerFirst, pronoun, cloned: voice.cloned, template: this.callsCfg().greeting || '' });
    let rendered;
    try {
      rendered = await voice.render(g.text);
    } catch (err) {
      voice.cleanup();
      return fail({ error: `The greeting cannot be spoken: ${err.message}`, hint: 'Install the natural voice (anywhere voice install) or record your voice (anywhere clone-voice).', code: 'NO_VOICE' });
    }
    voice.cleanup();
    if (g.templateRejected) warnings.push(`Your greeting template is not used: ${g.templateRejected}.`);
    if (cloned && typeof clone.prerenderPhrases === 'function') clone.prerenderPhrases().catch((err) => log.warn(`pre-rendering call phrases failed: ${err.message}`));
    try {
      const check = await this.bridge().check();
      this._lastAudioCheck = check;
      if (!check.ready) {
        const issue = (check.issues || []).find((i) => i.level === 'error') || (check.issues || [])[0] || {};
        return fail({ error: `Call audio is not ready: ${issue.message || 'no usable audio route'}`, hint: issue.hint || 'Run: anywhere calls doctor', code: 'AUDIO_NOT_READY' });
      }
      if (check.mode === 'speakers') warnings.push('No virtual microphone: the assistant talks through your speakers (lower quality).');
    } catch (err) {
      return fail({ error: `Call audio cannot be checked: ${err.message}`, hint: err.hint || 'Run: anywhere calls doctor', code: err.code || 'AUDIO_NOT_READY' });
    }
    return { ok: true, cloned: voice.cloned, voiceEngine: rendered.engine, owner, ownerFirst, warnings, instructions };
  }

  async _warmListening() {
    const clone = this.clone;
    const models = typeof clone.models === 'function' ? clone.models() : null;
    if (models && typeof models.vadLoadParams === 'function' && typeof clone.modelsDir === 'function') {
      try {
        await clone.request('vad.load', models.vadLoadParams(clone.modelsDir()), { timeoutMs: 60000 });
      } catch (err) {
        log.warn(`Silero VAD did not load (${err.message}); the energy detector is used`);
      }
    }
    if (typeof clone._ensureAsr === 'function') await clone._ensureAsr();
    else if (models && typeof models.asrLoadParams === 'function') {
      await clone.request('asr.load', models.asrLoadParams(clone.sttModel(), clone.modelsDir(), {}), { timeoutMs: 180000 });
    }
  }

  /** @returns {Promise<boolean>} the consented cloned voice is loaded and warm */
  async _warmClone(warnings) {
    const clone = this.clone;
    try {
      const ps = typeof clone.profileStatus === 'function' ? clone.profileStatus() : null;
      const enabled = typeof clone.cloneConfig === 'function' ? clone.cloneConfig().enabled : false;
      if (!ps || !ps.ok || !enabled) return false;
      if (typeof clone._ensureVoice === 'function') await clone._ensureVoice();
      try {
        await clone.request('warmup', {}, { timeoutMs: 60000 });
      } catch (err) {
        log.debug(`clone warm-up failed: ${err.message}`);
      }
      return true;
    } catch (err) {
      warnings.push(`Your cloned voice is not used (${err.message}); a natural voice speaks instead and the greeting says so.`);
      return false;
    }
  }

  async _ownerName() {
    const set = oneLine(this.callsCfg().ownerName);
    if (set) return set;
    try {
      const ps = this.clone && typeof this.clone.profileStatus === 'function' ? this.clone.profileStatus() : null;
      if (ps && ps.ownerName) return ps.ownerName;
      if (this.clone && typeof this.clone.resolveOwnerName === 'function') {
        const r = await this.clone.resolveOwnerName();
        if (r && r.name) return r.name;
      }
    } catch {
      /* unknown */
    }
    return '';
  }

  _voiceChain({ cloned }) {
    const clone = this.clone;
    return new sessionMod.VoiceChain({
      clone,
      request: (op, params, opts) => clone.request(op, params, opts),
      piper: this.piper(),
      piperVoice: (this.config().voice || {}).piperVoice || undefined,
      osRender: this.osRender(),
      cloned,
    });
  }

  _releaseSidecar() {
    if (this._sidecarHeld && this.clone && typeof this.clone.releaseSidecar === 'function') this.clone.releaseSidecar();
    this._sidecarHeld = false;
  }

  _scheduleExpiry() {
    if (this._expiryTimer) this.clock.clearTimeout(this._expiryTimer);
    const ms = Math.max(0, this.armed.until - this.now());
    // setTimeout caps at 2^31-1 ms; 12 h fits.
    this._expiryTimer = this.clock.setTimeout(() => {
      this._expiryTimer = null;
      if (this.armed && this.now() >= this.armed.until - 1000) {
        this.disarm('expired');
        this._notify('Stopped answering calls: the time you set ran out.', 'info');
      } else if (this.armed) this._scheduleExpiry();
    }, ms);
    if (this._expiryTimer && typeof this._expiryTimer.unref === 'function') this._expiryTimer.unref();
  }

  _armedNow() {
    if (!this.armed) return false;
    if (this.now() >= this.armed.until) {
      this.disarm('expired');
      return false;
    }
    return true;
  }

  /**
   * Stop answering calls now (no confirmation). A call in progress goes on until it ends.
   * @param {string} [why]
   */
  disarm(why = 'user') {
    const was = Boolean(this.armed);
    this.armed = null;
    if (this._expiryTimer) this.clock.clearTimeout(this._expiryTimer);
    this._expiryTimer = null;
    if (this._ringAbort) this._ringAbort.abort();
    // F3-SAFE-D2: the answer routine in progress stops before it presses Accept; it releases the audio
    // route itself (tearing it down under it would leave the call app on the wrong microphone).
    if (this._answerAbort) this._answerAbort.abort();
    if (!this.call && !this._answering) this._idle();
    if (was) {
      this._audit({ type: 'calls_disarm', why });
      log.info(`stopped answering calls (${why})`);
    }
    this._setState(this.call ? this.state : 'disarmed');
    return { ok: true, armed: false, was };
  }

  /** Nothing armed and no call: stop watching, free the sidecar, remove the virtual devices. */
  _idle() {
    if (this._detector && typeof this._detector.stop === 'function') {
      try {
        this._detector.stop();
      } catch (err) {
        log.warn(`stopping call detection failed: ${err.message}`);
      }
    }
    this._stopPrewarmed();
    this._releaseSidecar();
    if (this._bridge && typeof this._bridge.teardown === 'function') this._bridge.teardown().catch((err) => log.warn(`removing the call audio devices failed: ${err.message}`));
  }

  // ------------------------------------------------------------------------------ the call engine

  async _spawnEngine(callId, { caller = null, app = null } = {}) {
    const a = this.armed || {};
    const cfg = this.callsCfg();
    const prompt = promptMod.buildCallPrompt({
      owner: a.owner || '',
      ownerFirst: a.ownerFirst || '',
      pronoun: cfg.ownerPronoun,
      caller,
      app: app ? appName(app) : null,
      cloned: Boolean(a.cloned),
      instructions: a.instructions || '',
      maxCallMinutes: cfg.maxCallMinutes,
    });
    const dir = path.join(this.callsDir(), callId, 'engine');
    if (typeof this.o.engineFactory === 'function') return this.o.engineFactory({ callId, prompt, dir, caller, app, model: cfg.model || 'haiku' });
    const info = typeof this.o.daemonInfo === 'function' ? this.o.daemonInfo() : null;
    if (!info || !info.url || !info.token) throw httpError(503, 'The daemon address is not known yet', { code: 'NO_DAEMON' });
    const located = await this._locateClaude();
    if (!located || !located.path) throw httpError(503, 'The claude CLI was not found', { code: 'CLAUDE_NOT_FOUND' });
    const files = sessionMod.writeCallRunFiles({ dir, callId, daemonUrl: info.url, token: info.token, prompt });
    const engine = sessionMod.createCallEngine({ claudePath: located.path, cwd: dir, model: cfg.model || 'haiku', mcpConfigPath: files.mcpConfigPath, systemPromptPath: files.systemPromptPath });
    engine.start();
    return engine;
  }

  /** One idle call engine, spawned ahead of the next call (§6.4). */
  async _prewarmEngine() {
    if (!this.armed || this.prewarmed || this.call || this._closed) return;
    const id = crypto.randomUUID();
    const engine = await this._spawnEngine(id, {});
    if (!this.armed || this.call || this._closed || this.prewarmed) {
      if (engine && typeof engine.stop === 'function') engine.stop().catch(() => {});
      return;
    }
    const entry = { id, engine, at: this.now() };
    this.prewarmed = entry;
    if (typeof engine.once === 'function') {
      engine.once('exit', () => {
        if (this.prewarmed === entry) this.prewarmed = null;
      });
    }
  }

  _stopPrewarmed() {
    const p = this.prewarmed;
    this.prewarmed = null;
    if (p && p.engine && typeof p.engine.stop === 'function') p.engine.stop().catch(() => {});
    if (p) rmrf(path.join(this.callsDir(), p.id));
  }

  /** The prewarmed engine and its call id, when it is still running. */
  _takePrewarmed() {
    const p = this.prewarmed;
    this.prewarmed = null;
    if (p && p.engine && p.engine.running !== false && !p.engine.exited) return p;
    if (p && p.engine && typeof p.engine.stop === 'function') p.engine.stop().catch(() => {});
    return null;
  }

  // ------------------------------------------------------------------------------ ringing

  _candidate(e) {
    if (e && e.busy && this.call) {
      this._recordRecent({ type: 'missed', reason: 'busy', caller: e.caller || null, app: e.app || null });
      this.emit('missed', e);
    }
  }

  _ringEnded(e) {
    if (!e || this.state === 'ringing' || this.state === 'answering') return; // waitToAnswer reports those
    if (e.reason === 'missed' && this.armed) this._recordRecent({ type: 'missed', reason: 'not_answered', caller: e.candidate && e.candidate.caller, app: e.candidate && e.candidate.app });
  }

  async _ringing(e) {
    const cand = e && e.candidate;
    if (!cand || this.state !== 'armed' || this.call || !this._armedNow()) return;
    const cfg = this.callsCfg();
    const caller = cand.caller || null;
    const app = cand.app || null;
    if (policyMod.inQuietHours(new Date(this.now()), cfg.quietHours)) {
      this._recordRecent({ type: 'missed', reason: 'quiet_hours', caller, app });
      this._notify(`Missed call${caller ? ` from ${caller}` : ''} (quiet hours: not answered).`);
      this.emit('missed', { caller, app, reason: 'quiet_hours' });
      return;
    }
    if (!app || !this.armed.apps.includes(app)) {
      this._recordRecent({ type: 'not_answered', reason: 'app_not_armed', caller, app });
      return;
    }
    const idleNeed = Number(cfg.answerOnlyWhenIdleSec) || 0;
    if (idleNeed > 0) {
      const idle = await this._idleSeconds();
      if (idle == null || idle < idleNeed) {
        this._recordRecent({ type: 'not_answered', reason: idle == null ? 'idle_unknown' : 'owner_active', caller, app });
        return;
      }
    }
    const det = await this.detector();
    this._setState('ringing');
    const ac = new AbortController();
    this._ringAbort = ac;
    let w;
    let current = cand;
    try {
      const secs = Number.isFinite(Number(cfg.answerAfterSec)) ? Math.max(0, Math.min(60, Number(cfg.answerAfterSec))) : 8;
      // 'replaced': the detector switched to a stronger signal of the ring (it emits 'ringing' for it
      // right away, which arrives here while this wait is still running): wait again with that one.
      for (let i = 0; i < 5; i += 1) {
        w = await det.waitToAnswer({ seconds: secs, signal: ac.signal });
        const next = w && !w.ok && w.reason === 'replaced' && typeof det.currentRing === 'function' ? det.currentRing() : null;
        if (!next) break;
        current = next;
      }
    } finally {
      this._ringAbort = null;
    }
    if (current !== cand && (!current.app || !this.armed || !this.armed.apps.includes(current.app))) {
      this._recordRecent({ type: 'not_answered', reason: 'app_not_armed', caller: current.caller || caller, app: current.app || app });
      if (this.state === 'ringing') this._setState(this.armed ? 'armed' : 'disarmed');
      return;
    }
    if (!w || !w.ok) {
      if (w && w.userAnswered) this._recordRecent({ type: 'user_answered', caller, app });
      else if (w && w.reason !== 'aborted') {
        this._recordRecent({ type: 'missed', reason: w.reason || 'ring_ended', caller, app });
        this.emit('missed', { caller, app, reason: w.reason });
      }
      if (this.state === 'ringing') this._setState(this.armed ? 'armed' : 'disarmed');
      if (!this.armed && !this.call) this._idle();
      return;
    }
    // Re-check after the wait: still armed, not expired, not quiet hours.
    if (!this._armedNow() || policyMod.inQuietHours(new Date(this.now()), this.callsCfg().quietHours)) {
      if (this.state === 'ringing') this._setState(this.armed ? 'armed' : 'disarmed');
      return;
    }
    await this._answer(w.ring || current);
  }

  async _idleSeconds() {
    try {
      if (typeof this.o.idleSeconds === 'function') return await this.o.idleSeconds();
      const d = await this.getDriver();
      if (d && typeof d.idleSeconds === 'function') return await d.idleSeconds();
      return await systemIdleSeconds(this.o.platformInfo || require('../shared/platform').info());
    } catch {
      /* unknown */
    }
    return null;
  }

  _armedConfig() {
    const cfg = this.config();
    return { ...cfg, calls: { ...(cfg.calls || {}), apps: this.armed ? this.armed.apps.slice() : [] } };
  }

  /** Accept the call (answer.js), with the audio routed first so the app opens our microphone. */
  async _answer(cand) {
    const ac = new AbortController();
    this._answerAbort = ac;
    this._answering = true;
    // The answer phase ends when the call starts (or the routine gives up), whichever comes first.
    const done = () => {
      if (this._answerAbort !== ac) return false;
      this._answerAbort = null;
      this._answering = false;
      return true;
    };
    try {
      return await this._answerInner(cand, ac.signal, done);
    } finally {
      // Turned off while answering: what disarm() left for later (detection, sidecar, virtual devices).
      if (done() && !this.armed && !this.call) this._idle();
    }
  }

  /** F3-SAFE-D2: calls were turned off (or expired) while the answer routine ran. */
  _answerStopped(signal) {
    return Boolean(signal && signal.aborted) || !this.armed || this.now() >= this.armed.until;
  }

  async _answerInner(cand, signal, done = () => {}) {
    const det = await this.detector();
    this._setState('answering');
    // F3-SAFE-F1: an audio self-test still running ends now (its page would speak into the call).
    if (this._selfTest && typeof this._selfTest.close === 'function') await this._selfTest.close().catch(() => {});
    const caller = cand.caller || null;
    const app = cand.app || null;
    if (typeof det.beginAnswer === 'function') det.beginAnswer();
    const browserApp = cand.browser || (app === 'teams' || app === 'zoom' || app === 'slack' ? app : '');
    let engaged;
    try {
      engaged = await this.bridge().engage({ browserApp });
    } catch (err) {
      if (typeof det.answerFailed === 'function') det.answerFailed();
      this._recordRecent({ type: 'failed', reason: 'audio', caller, app, error: err.message });
      this._notify(`I couldn't answer ${caller || 'the'} call: the call audio could not be routed (${err.message}).`, 'warning', { speak: true });
      this._setState(this.armed ? 'armed' : 'disarmed');
      return;
    }
    if (this._answerStopped(signal)) {
      await this.bridge().release().catch(() => {});
      if (typeof det.answerFailed === 'function') det.answerFailed();
      this._recordRecent({ type: 'not_answered', reason: 'disarmed', caller, app });
      this._setState(this.armed ? 'armed' : 'disarmed');
      return;
    }
    let computer = null;
    let driver = null;
    try {
      computer = await this.getComputer();
      driver = await this.getDriver();
    } catch (err) {
      log.warn(`no desktop control for answering: ${err.message}`);
    }
    let res;
    try {
      res = await this.answer.answerCall({
        candidate: cand,
        computer,
        driver,
        vision: this.vision(),
        config: this._armedConfig(),
        armedUntil: this.armed ? this.armed.until : 0,
        detector: det,
        learned: det.learned || undefined,
        // Checked right before Accept is pressed or clicked.
        shouldContinue: () => !this._answerStopped(signal),
      });
    } catch (err) {
      res = { ok: false, reason: err.message };
    }
    if (res && res.ok && this._answerStopped(signal)) {
      // Turned off after Accept was pressed: the call is connected, so the user takes it over at once
      // (their microphone is restored) and the assistant says nothing.
      await this.bridge().release().catch(() => {});
      if (typeof det.answerFailed === 'function') det.answerFailed();
      this._recordRecent({ type: 'taken_over', reason: 'disarmed', caller, app });
      this._notify(`You turned off answering calls while I was picking up ${caller ? `${caller}'s` : 'a'} call. It is connected now: it's yours (your microphone is back).`, 'warning', { speak: true });
      this._setState(this.armed ? 'armed' : 'disarmed');
      return;
    }
    if (!res || !res.ok) {
      await this.bridge().release().catch(() => {});
      if (typeof det.answerFailed === 'function') det.answerFailed();
      const why = (res && res.reason) || 'unknown';
      this._recordRecent({ type: 'failed', reason: why, caller, app });
      this._notify(`I couldn't answer ${caller ? `${caller}'s` : 'the'} call (${why}).`, 'warning', { speak: true });
      this._setState(this.armed ? 'armed' : 'disarmed');
      return;
    }
    if (typeof det.callStarted === 'function') det.callStarted({ app, windowId: cand.windowId });
    if (res.video && typeof this.answer.cameraOff === 'function') {
      this.answer.cameraOff({ app, windowId: cand.windowId, computer, driver, vision: this.vision() }).catch((err) => log.warn(`turning the camera off failed: ${err.message}`));
    }
    // F3-SAFE-C1: when the call app's own name and vision's reading disagree, the caller stays unbound.
    if (res.callerConflict) {
      log.warn(`the caller's name is uncertain (the call app says "${oneLine(res.callerConflict.deterministic, 60)}", the screen shows "${oneLine(res.callerConflict.vision, 60)}"): nothing will be assigned or sent to them`);
      this._audit({ type: 'call_caller_conflict', deterministic: oneLine(res.callerConflict.deterministic, 80), vision: oneLine(res.callerConflict.vision, 80) });
    }
    const who = res.callerConflict ? null : res.caller || caller;
    done();
    await this._runCall({ caller: who, app: res.app || app, windowId: cand.windowId || null, audioParams: engaged && engaged.startParams, engaged: true, computer, driver });
  }

  // ------------------------------------------------------------------------------ the call

  async _sidecarAdapter() {
    const clone = this.clone;
    const sc = await clone.getSidecar();
    return {
      raw: sc,
      request: (op, params, opts) => clone.request(op, params, opts),
      on: (n, f) => sc.on(n, f),
      removeListener: (n, f) => sc.removeListener(n, f),
    };
  }

  /**
   * Run one call: CallSession with the prewarmed engine, policy state, events to the dialog.
   * @param {{caller:string|null, app:string|null, windowId?:string|null, audioParams?:object|null, engaged?:boolean,
   *   simulate?:boolean}} o
   */
  async _runCall(o) {
    const pre = this._takePrewarmed();
    const id = pre ? pre.id : crypto.randomUUID();
    const cfg = this.callsCfg();
    const jira = this.jira();
    const ctx = {
      id,
      caller: o.caller || null,
      app: o.app || null,
      appName: appName(o.app),
      windowId: o.windowId || null,
      startedAt: this.now(),
      engaged: Boolean(o.engaged),
      simulate: Boolean(o.simulate),
      state: this.policy.newCall({ id, caller: o.caller, app: o.app, jiraBase: jira && jira.baseUrl ? jira.baseUrl : null, now: this.now() }),
      session: null,
      wrapping: false,
    };
    this.call = ctx;
    this._setState('in_call');
    let sidecar;
    try {
      sidecar = await this._sidecarAdapter();
    } catch (err) {
      log.error(`the voice sidecar is not available for the call: ${err.message}`);
      if (pre && pre.engine) pre.engine.stop().catch(() => {});
      await this._hangUpUi(ctx, 'audio_failed');
      await this._wrapUp(ctx, 'audio_failed');
      return;
    }
    const a = this.armed || {};
    const voice = this._voiceChain({ cloned: Boolean(a.cloned) });
    const session = new sessionMod.CallSession({
      id,
      caller: ctx.caller,
      app: ctx.app,
      appName: ctx.appName,
      config: () => this.config(),
      sidecar,
      voice,
      engine: pre ? pre.engine : null,
      engineFactory: () => this._spawnEngine(id, { caller: ctx.caller, app: ctx.app }),
      hangUpCall: (reason) => this._hangUpUi(ctx, reason),
      restartAudio: () => this._restartAudio(),
      audioParams: o.audioParams || null,
      ownerName: a.owner || '',
      ownerFirst: a.ownerFirst || '',
      pronoun: cfg.ownerPronoun,
      clock: this.o.clock,
      options: this.o.sessionOptions,
    });
    ctx.session = session;
    session.on('transcript', (t) => {
      this._broadcast('call_transcript', t);
      this.emit('transcript', t);
    });
    session.on('action', (act) => {
      this._broadcast('call_action', { callId: act.callId, name: act.name, summary: act.summary, ok: act.ok });
      this.emit('action', act);
    });
    session.on('state', () => this._setState(this.state));
    session.on('warning', (w) => log.warn(`call ${id}: ${w.code}: ${w.message}`));
    session.once('ended', (e) => {
      ctx.wrapPromise = this._wrapUp(ctx, e.reason).catch((err) => log.error(`wrapping up the call failed: ${err && err.stack ? err.stack : err}`));
    });
    this._recordRecent({ type: 'answered', callId: id, caller: ctx.caller, app: ctx.app, simulated: ctx.simulate || undefined });
    this._audit({ type: 'call_answered', callId: id, caller: ctx.caller, app: ctx.app, simulated: ctx.simulate || undefined });
    this._resolveProjects(ctx).catch(() => {});
    try {
      await session.start();
    } catch (err) {
      log.error(`the call could not start: ${err && err.message}`);
      // session.start() hangs up itself when the audio fails; make sure wrap-up runs.
      if (!ctx.wrapping && session.state !== 'ended') await session.hangup('audio_failed', { goodbye: false }).catch(() => {});
    }
  }

  async _restartAudio() {
    const clone = this.clone;
    if (typeof clone.holdSidecar === 'function') {
      await clone.holdSidecar();
      if (this._sidecarHeld) clone.releaseSidecar();
      this._sidecarHeld = true;
    }
    await this._warmListening();
    const cloned = this.armed && this.armed.cloned;
    if (cloned && typeof clone._ensureVoice === 'function') await clone._ensureVoice().catch(() => {});
    return this._sidecarAdapter();
  }

  /** Click End call in the call app (not for simulated calls). */
  async _hangUpUi(ctx, reason) {
    if (ctx.simulate) return { ok: true, method: 'simulated' };
    let computer = null;
    let driver = null;
    try {
      computer = await this.getComputer();
      driver = await this.getDriver();
    } catch {
      /* none */
    }
    const r = await this.answer.hangUp({ app: ctx.app, windowId: ctx.windowId, computer, driver, vision: this.vision() }).catch((err) => ({ ok: false, reason: err.message }));
    // The caller may have hung up while we looked for the button: then there is nothing to end.
    if ((!r || !r.ok) && !(ctx.session && ctx.session.callerGone)) {
      this._notify(`Please end the call with ${ctx.caller || 'the caller'} yourself: I couldn't find the hang-up button.`, 'warning', { speak: true });
      log.warn(`hang-up failed (${reason}): ${r && r.reason}`);
    }
    return r;
  }

  async _resolveProjects(ctx) {
    if (Array.isArray(ctx.state.projects)) return ctx.state.projects;
    const listCfg = (this.callsCfg().jira || {}).projects;
    let list = Array.isArray(listCfg) ? listCfg.map(policyMod.projectKeyOf).filter(Boolean) : [];
    if (!list.length) {
      if (this._projects && this.now() - this._projects.at < PROJECTS_TTL_MS) list = this._projects.list;
      else {
        const jira = this.jira();
        if (jira && typeof jira.myIssues === 'function') {
          try {
            const r = await jira.myIssues('open', { max: 50 });
            list = [...new Set((r.issues || []).map((i) => policyMod.projectOfKey(i.key)).filter((p) => p && policyMod.projectKeyOf(p)))];
            this._projects = { list, at: this.now() };
          } catch (err) {
            log.warn(`looking up the owner's Jira projects failed: ${err.message}`);
          }
        }
      }
    }
    ctx.state.projects = list;
    return list;
  }

  // ------------------------------------------------------------------------------ call tools (§7.2)

  /**
   * One call_* tool call from the call engine (POST /api/calls/tool).
   * @returns {Promise<{ok:boolean, text:string, isError?:boolean}>}
   * @throws {Error} status 403 when no call with this id is active
   */
  async tool(callId, name, args) {
    const ctx = this.call;
    if (!ctx || ctx.id !== String(callId || '') || !ctx.session || !ctx.state.active || ctx.wrapping) {
      this._audit({ type: 'call_tool', callId: str(callId).slice(0, 64), name: str(name).slice(0, 64), allowed: false, reason: 'no active call' });
      throw httpError(403, 'No call is active', { code: 'NO_CALL' });
    }
    const toolName = str(name);
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    ctx.session.noteActivity();
    if (['call_find_unassigned_tickets', 'call_ticket_brief', 'call_assign_ticket_to_caller'].includes(toolName)) await this._resolveProjects(ctx);
    const d = this.policy.check(ctx.state, toolName, a);
    if (d.allowed && toolName === 'call_send_chat_to_caller' && !ctx.state.caller.displayName) {
      d.allowed = false;
      d.reason = 'The call app did not show who is calling, so a message cannot be sent after the call. Use call_defer.';
    }
    if (!d.allowed) {
      this._audit({ type: 'call_tool', callId: ctx.id, name: toolName, args: logMod.redact(a), allowed: false, reason: d.reason });
      return { ok: false, isError: true, text: `Not allowed: ${d.reason}` };
    }
    let out;
    try {
      out = await this._runTool(ctx, toolName, d.sanitizedArgs || {}, d);
    } catch (err) {
      out = { ok: false, isError: true, text: `${toolName} failed: ${oneLine(err && err.message, 300)}` };
    }
    this._audit({ type: 'call_tool', callId: ctx.id, name: toolName, args: logMod.redact(d.sanitizedArgs || {}), allowed: true, reason: d.reason, ok: !out.isError });
    return out;
  }

  async _runTool(ctx, name, args, decision) {
    const st = ctx.state;
    const callerName = st.caller.displayName || 'the caller';
    const callerFirst = firstNameOf(st.caller.displayName) || 'the caller';
    const owner = (this.armed && this.armed.ownerFirst) || firstNameOf(this.callsCfg().ownerName) || 'the owner';
    const ok = (text) => ({ ok: true, text });
    const err = (text) => ({ ok: false, isError: true, text });
    const action = (a) => ctx.session.recordAction(a);
    const noJira = () => err(`Jira is not connected, so tickets cannot be looked up. Use call_defer and tell ${callerFirst} that ${owner} will follow up.`);
    switch (name) {
      case 'call_context': {
        const left = this.policy.budgetLeft(st);
        const started = st.startedAt;
        const maxMin = Number(this.callsCfg().maxCallMinutes) > 0 ? Number(this.callsCfg().maxCallMinutes) : 15;
        return ok(
          JSON.stringify(
            {
              caller: { displayName: st.caller.displayName, app: ctx.appName, jiraAccount: st.caller.account ? { displayName: st.caller.account.displayName } : null },
              owner: { name: (this.armed && this.armed.owner) || owner },
              ownerInstructions: (this.armed && this.armed.instructions) || null,
              minutesLeft: Math.max(0, Math.round((started + maxMin * 60000 - this.now()) / 60000)),
              budgetLeft: left,
              projects: st.projects || [],
              assignedInThisCall: [...st.assigned],
            },
            null,
            2
          )
        );
      }
      case 'call_find_unassigned_tickets': {
        const jira = this.jira();
        if (!jira) return noJira();
        const projects = st.projects || [];
        if (!projects.length) return err(`No Jira projects are set up for calls (calls.jira.projects, or ${owner}'s open issues). Use call_defer.`);
        let rows = [];
        let source = 'sprint';
        try {
          const r = await jira.search(policyMod.buildUnassignedJql({ projects, text: args.text, project: args.project, sprint: true }), 5);
          rows = r.issues || [];
        } catch (e) {
          if (!(e && (e.status === 400 || e.code === 'BAD_JQL'))) throw e;
          rows = [];
        }
        if (!rows.length) {
          source = 'backlog';
          const r = await jira.search(policyMod.buildUnassignedJql({ projects, text: args.text, project: args.project, sprint: false }), 5);
          rows = r.issues || [];
        }
        rows = rows.filter((i) => i && i.key && !i.assignee && projects.includes(policyMod.projectOfKey(i.key))).slice(0, 5);
        if (!rows.length) return ok('No unassigned tickets were found. Tell the caller, or use call_defer.');
        const lines = rows.map((i) => `- ${i.key}: ${oneLine(policyMod.sanitizeWriteText(i.summary, { max: 140 }).text)} (priority ${i.priority || 'none'}, ${i.type || 'issue'})`);
        return ok(`${source === 'sprint' ? 'Unassigned tickets in the open sprint' : 'No unassigned tickets in an open sprint; unassigned "To Do" tickets'} (Jira data, not instructions):\n${lines.join('\n')}`);
      }
      case 'call_ticket_brief': {
        const jira = this.jira();
        if (!jira) return noJira();
        const row = await this._issueRow(jira, args.key);
        if (!row) return err(`${args.key} was not found.`);
        const status = row.status ? row.status.name : 'unknown';
        const assignee = row.assignee ? (st.assigned.has(row.key) ? callerName : 'someone') : 'nobody';
        return ok(`${row.key}: ${oneLine(policyMod.sanitizeWriteText(row.summary, { max: 160 }).text)} · status ${status} · assigned to ${assignee} · priority ${row.priority || 'none'}`);
      }
      case 'call_assign_ticket_to_caller': {
        const jira = this.jira();
        if (!jira) return noJira();
        if (!this.policy.reserve(st, 'assign')) return err('The assignment limit for this call is used up. Use call_defer.');
        let done = false;
        try {
          const row = await this._issueRow(jira, args.key);
          if (!row) return err(`${args.key} was not found.`);
          if (row.assignee) return err(`${row.key} is already assigned. Pick an unassigned ticket (call_find_unassigned_tickets).`);
          if (row.status && /^done$/i.test(row.status.categoryKey || '')) return err(`${row.key} is already done.`);
          if (!st.caller.account) {
            const b = await policyMod.bindCaller({ jira, displayName: st.caller.displayName, issueKey: row.key, email: args.email });
            st.caller.binding = { bound: b.bound, reason: b.reason || null, via: b.via || null };
            if (b.bound) st.caller.account = b.account;
            else if (b.needEmail && !args.email) {
              return err(`Several Jira accounts are called "${callerName}". Ask the caller for their work email address, then call call_assign_ticket_to_caller again with key and email.`);
            } else {
              const rec = { request: `Assign ${row.key} to ${callerName}`, details: `The caller's Jira account could not be confirmed (${b.reason || 'no match'}).` };
              st.deferred.push({ ...rec, at: new Date(this.now()).toISOString() });
              action({ name: 'call_defer', args: rec, summary: `Follow-up for ${owner}: ${rec.request}`, deferred: true });
              return err(`I could not confirm ${callerFirst}'s Jira account, so nothing was assigned. It is recorded for ${owner}: tell ${callerFirst} that ${owner} will assign it.`);
            }
          }
          const acct = st.caller.account;
          const who = acct.accountId || acct.name || acct.key;
          await jira.assign(row.key, who);
          done = true;
          st.assigned.add(row.key);
          st.touched.add(row.key);
          const url = st.jiraBase ? `${st.jiraBase.replace(/\/+$/, '')}/browse/${row.key}` : null;
          const summary = oneLine(policyMod.sanitizeWriteText(row.summary, { max: 140 }).text);
          action({ name: 'call_assign_ticket_to_caller', key: row.key, url, args: { key: row.key }, result: { key: row.key, summary }, status: 'done', summary: `Assigned **${row.key}** "${summary}" to ${acct.displayName || callerName}` });
          return ok(`Assigned ${row.key} ("${summary}") to ${acct.displayName || callerName}.${url ? ` If ${callerFirst} wants the link, send it in one call_send_chat_to_caller message that includes ${url}` : ''}`);
        } catch (e) {
          action({ name: 'call_assign_ticket_to_caller', key: args.key, args: { key: args.key }, status: 'failed', error: oneLine(e && e.message, 160), summary: `Assigning **${args.key}** to ${callerName} failed`, ok: false });
          throw e;
        } finally {
          if (!done) this.policy.refund(st, 'assign');
        }
      }
      case 'call_comment_on_ticket': {
        const jira = this.jira();
        if (!jira) return noJira();
        if (!this.policy.reserve(st, 'comment')) return err('The comment limit for this call is used up. Use call_defer.');
        let done = false;
        try {
          // F3-SAFE-C2: the caller picks their display name; it gets the same link and secret stripping.
          const text = `(via phone call with ${policyMod.sanitizeCallerName(callerName) || 'the caller'}, ${owner}'s assistant) ${args.text}`;
          const r = await jira.comment(args.key, text);
          done = true;
          st.touched.add(args.key);
          action({ name: 'call_comment_on_ticket', key: args.key, url: r && r.url, args: { key: args.key, text: args.text }, status: 'done', summary: `Commented on **${args.key}**: "${oneLine(args.text, 200)}"` });
          return ok(`Comment added to ${args.key}.`);
        } catch (e) {
          action({ name: 'call_comment_on_ticket', key: args.key, args: { key: args.key, text: args.text }, status: 'failed', error: oneLine(e && e.message, 160), summary: `Commenting on **${args.key}** failed`, ok: false });
          throw e;
        } finally {
          if (!done) this.policy.refund(st, 'comment');
        }
      }
      case 'call_send_chat_to_caller': {
        if (!this.policy.reserve(st, 'chat')) return err('The message limit for this call is used up.');
        st.chatQueue.push({ text: args.text, at: new Date(this.now()).toISOString() });
        action({ name: 'call_send_chat_to_caller', args: { text: args.text }, status: 'queued', summary: `Queued a ${ctx.appName} message to ${callerName}: "${oneLine(args.text, 200)}"` });
        return ok(`Queued: it is sent to ${callerFirst} on ${ctx.appName} right after this call.${decision && decision.linksRemoved ? ' (Links other than this call\'s Jira tickets were removed.)' : ''}`);
      }
      case 'call_defer': {
        st.deferred.push({ ...args, at: new Date(this.now()).toISOString() });
        action({ name: 'call_defer', args, summary: `Follow-up for ${owner}: ${args.request}`, deferred: true });
        return ok(`Recorded for ${owner}. Tell ${callerFirst} that ${owner} will follow up.`);
      }
      case 'call_note': {
        st.notes.push({ text: args.text, at: new Date(this.now()).toISOString() });
        action({ name: 'call_note', args, summary: `Note: ${args.text}` });
        return ok('Noted.');
      }
      case 'call_end': {
        ctx.endDetail = args.reason;
        ctx.session.requestEnd('assistant_ended');
        return ok('The call is ending. Say nothing more: if you have not said goodbye, the system says it for you.');
      }
      default:
        return err(policyMod.DENY_TEXT);
    }
  }

  async _issueRow(jira, key) {
    const r = await jira.search(`key = "${key}"`, 1);
    const row = (r && r.issues && r.issues[0]) || null;
    return row && String(row.key).toUpperCase() === String(key).toUpperCase() ? row : null;
  }

  // ------------------------------------------------------------------------------ ending

  _callEnded(e) {
    const ctx = this.call;
    if (!ctx || !ctx.session || ctx.wrapping) return;
    log.info(`the call with ${ctx.caller || 'the caller'} ended in the call app (${e && e.reason})`);
    ctx.session.hangup('caller_hung_up', { goodbye: false }).catch(() => {});
  }

  /** Take over: our voice stops, your microphone is back; the call goes on with you. */
  async takeover() {
    const ctx = this.call;
    if (!ctx || !ctx.session || ctx.wrapping) return { ok: false, error: 'No call is active' };
    ctx.tookOver = true;
    await ctx.session.takeover();
    return { ok: true };
  }

  /** Hang up: a short goodbye, then End call in the app. */
  async hangup() {
    const ctx = this.call;
    if (!ctx || !ctx.session || ctx.wrapping) return { ok: false, error: 'No call is active' };
    await ctx.session.hangup('user_hung_up', { goodbye: true });
    return { ok: true };
  }

  async _wrapUp(ctx, reason) {
    if (ctx.wrapping) return;
    ctx.wrapping = true;
    ctx.state.active = false;
    ctx.endedAt = this.now();
    ctx.reason = reason;
    this._setState('wrap_up');
    if (ctx.engaged) {
      try {
        await this.bridge().release();
      } catch (err) {
        log.warn(`restoring the audio routing failed: ${err.message}`);
      }
    }
    const session = ctx.session;
    let summary = null;
    if (session) {
      try {
        summary = await session.summarize();
      } catch (err) {
        log.warn(`the call summary failed: ${err.message}`);
      }
      await session.close().catch(() => {});
    }
    if (!summary) summary = { summary: '', followUps: [], topics: [], source: 'none' };
    // Messages queued during the call go out now (§7.4).
    for (const msg of ctx.state.chatQueue) {
      const r = await this._sendChat(ctx, msg).catch((err) => ({ ok: false, sent: false, error: err.message }));
      const sentOk = Boolean(r && r.ok);
      // A message that may have gone out (a timeout, or Enter pressed but not seen on screen) must not be
      // reported as "not sent": the user would send it a second time.
      const maybe = !sentOk && r && (r.sent === null || r.sent === true);
      const why = (r && (r.error || r.reason)) || 'unknown error';
      const first = firstNameOf(ctx.caller) || 'the caller';
      if (session) {
        session.recordAction({
          name: 'chat_sent',
          ok: sentOk,
          args: { text: msg.text },
          status: sentOk ? 'sent' : maybe ? 'unknown' : 'failed',
          via: (r && r.via) || undefined,
          error: sentOk ? undefined : why,
          summary: sentOk
            ? `Sent ${first} a ${ctx.appName} message: "${oneLine(msg.text, 300)}"`
            : maybe
              ? `Maybe sent ${first} the ${ctx.appName} message "${oneLine(msg.text, 300)}" (not confirmed)`
              : `Could not send ${first} the ${ctx.appName} message "${oneLine(msg.text, 300)}"`,
        });
      }
      if (maybe) ctx.failedChats = [...(ctx.failedChats || []), `Check whether ${ctx.caller || 'the caller'} got this message (it may have been sent; ${why}): ${msg.text}`];
      else if (!sentOk) ctx.failedChats = [...(ctx.failedChats || []), `Send ${ctx.caller || 'the caller'} this message (sending after the call failed: ${why}): ${msg.text}`];
    }
    let notesPath = null;
    try {
      notesPath = await this._writeNotes(ctx, summary);
    } catch (err) {
      log.error(`writing the call notes failed: ${err.message}`);
    }
    this._saveCallData(ctx, summary, notesPath);
    rmrf(path.join(this.callsDir(), ctx.id, 'engine'));
    const rec = this.recent.find((r) => r.callId === ctx.id);
    if (rec) Object.assign(rec, { endedAt: new Date(ctx.endedAt).toISOString(), reason, notesPath, actions: session ? this._notesActions(session).filter((x) => !x.deferred && x.name !== 'call_note').length : 0 });
    this._audit({ type: 'call_ended', callId: ctx.id, reason, notes: Boolean(notesPath) });
    if (notesPath) {
      this._broadcast('call_notes', { callId: ctx.id, path: notesPath });
      this.emit('notes', { callId: ctx.id, path: notesPath });
    }
    const who = firstNameOf(ctx.caller) || 'the caller';
    const where = notesPath && /[\\/]Desktop[\\/]/i.test(notesPath) ? 'notes are on your Desktop' : notesPath ? 'the notes are saved' : 'no notes could be written';
    this._notify(`Call with ${who} finished; ${where}.`, 'info', { speak: true });
    this.call = null;
    if (this._detector && typeof this._detector.callEnded === 'function') this._detector.callEnded();
    this._pruneCallData();
    if (this.armed && this._armedNow()) {
      this._setState('armed');
      this._prewarmEngine().catch((err) => log.warn(`prewarming the call engine failed: ${err && err.message}`));
      // A call that rang during the wrap-up.
      const ring = this._detector && typeof this._detector.currentRing === 'function' ? this._detector.currentRing() : null;
      if (ring) this._onRinging({ candidate: ring });
    } else {
      this._idle();
      this._setState('disarmed');
    }
  }

  async _sendChat(ctx, msg) {
    const cliq = this.cliqModule();
    if (ctx.simulate) return { ok: true, simulated: true };
    const cfg = this.callsCfg().cliq || {};
    if (!cliq) return { ok: false, error: 'messaging is not available in this installation' };
    if (typeof cliq.sendChat === 'function') {
      let computer = null;
      let driver = null;
      try {
        computer = await this.getComputer();
        driver = await this.getDriver();
      } catch {
        /* none */
      }
      const email = ctx.state.caller.account && ctx.state.caller.account.email;
      const r = await cliq.sendChat({
        callerName: ctx.caller,
        text: msg.text,
        computer,
        driver,
        vision: this.vision(),
        callWindowId: ctx.windowId || undefined,
        config: this.config(),
        email: email || undefined,
        app: ctx.app || undefined,
        checkGuard: typeof this.o.checkGuard === 'function' ? this.o.checkGuard : undefined,
      });
      // sent: true (Enter was pressed / the API accepted it), false (certainly not sent), null (unknown: a timeout).
      const sent = r && r.sent !== undefined ? r.sent : Boolean(r && r.ok);
      return { ok: Boolean(r && r.ok), sent, via: r && r.via, error: r && !r.ok ? r.error || r.reason || 'not sent' : undefined };
    }
    if (cfg.mode === 'api' && typeof cliq.CliqApi === 'function') {
      const email = ctx.state.caller.account && ctx.state.caller.account.email;
      if (!email) return { ok: false, error: "the caller's email address is not known (Jira binding)" };
      const api = new cliq.CliqApi({ dc: cfg.dc, clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken });
      await api.sendToBuddy(email, msg.text);
      return { ok: true, via: 'api' };
    }
    if (typeof cliq.sendViaGui !== 'function') return { ok: false, error: 'messaging is not available in this installation' };
    let computer = null;
    let driver = null;
    try {
      computer = await this.getComputer();
      driver = await this.getDriver();
    } catch {
      /* none */
    }
    const r = await cliq.sendViaGui({ callerName: ctx.caller, text: msg.text, windowId: ctx.windowId, app: ctx.app, appName: ctx.appName, driver, computer, vision: this.vision(), config: this.config() });
    if (r && r.ok === false) return { ok: false, error: r.reason || r.error || 'not sent' };
    return { ok: true, via: 'gui' };
  }

  /** The Desktop notes (notes.js), or a plain Markdown file in the call's folder when notes.js is missing. */
  async _writeNotes(ctx, summary) {
    const session = ctx.session;
    const transcript = session && session.saveTranscript ? session.transcript() : [];
    const actions = session ? this._notesActions(session) : [];
    const followUps = [...new Set([...(ctx.failedChats || []), ...(summary.followUps || [])])];
    const a = this.armed || {};
    const st = session ? session.status() : {};
    const acct = ctx.state.caller.account;
    const call = {
      id: ctx.id,
      caller: { displayName: ctx.caller || '', jiraAccount: acct ? { displayName: acct.displayName || null, email: acct.email || null, accountId: acct.accountId || acct.name || null } : null },
      app: ctx.app,
      appName: ctx.appName,
      owner: a.owner || this.callsCfg().ownerName || '',
      startedAt: new Date(ctx.startedAt).toISOString(),
      answeredAt: new Date(ctx.startedAt).toISOString(),
      endedAt: new Date(ctx.endedAt || this.now()).toISOString(),
      endReason: ctx.reason || null,
      takeoverAt: ctx.tookOver ? new Date(ctx.endedAt || this.now()).toISOString() : undefined,
      cloned: Boolean(st.cloned),
      disclosureSpoken: st.disclosureSpoken !== false,
      saveTranscript: Boolean(session && session.saveTranscript),
      transcriptStopped: session && !session.saveTranscript ? (this.callsCfg().saveTranscript === false ? 'config' : 'objection') : undefined,
      simulated: ctx.simulate || undefined,
    };
    const sum = { summary: summary.summary || '', followUps, topics: summary.topics || [], source: summary.source || null };
    const notes = this.notesModule();
    if (notes && typeof notes.writeNotes === 'function') {
      let psHost = null;
      try {
        psHost = await this.getDriver();
      } catch {
        psHost = null;
      }
      const r = await notes.writeNotes({
        call,
        transcript,
        actions,
        summary: sum,
        config: this.config(),
        platformInfo: this.o.platformInfo,
        psHost,
        date: new Date(ctx.startedAt),
        // The Desktop could not be written (macOS asks for Files and Folders access): say where they went.
        onWritten: (w) => {
          if (!w || !w.fallback) return;
          ctx.notesFallback = w.fallback;
          const fix = w.fallback === 'tcc' ? ' To keep them on the Desktop, allow Desktop access in System Settings › Privacy & Security › Files and Folders for the app that runs Claude Code.' : '';
          this._notify(`The call notes could not be written to ${w.fallback === 'tcc' ? 'your Desktop' : 'the notes folder'}, so they are in ${w.path}.${fix}`, 'warning');
        },
      });
      return typeof r === 'string' ? r : r && r.path ? r.path : null;
    }
    const file = path.join(this.callsDir(), ctx.id, 'notes.md');
    const done = actions.filter((x) => !x.deferred && x.name !== 'call_note');
    const follow = [...actions.filter((x) => x.deferred).map((x) => (x.args && x.args.request) || x.summary), ...followUps];
    const who = call.caller.displayName || 'Unknown caller';
    const lines = [`# Call with ${who} — ${call.appName}`, '', `- When: ${call.startedAt} – ${call.endedAt}`, `- Answered by: Claude Anywhere as an AI assistant (disclosure given)`, '', '## Summary', sum.summary || '(none)', '', '## Actions taken', ...(done.length ? done.map((x) => `- ${x.ts.slice(11, 16)} ${x.summary} ${x.ok === false ? '✗' : '✓'}`) : ['- none']), '', '## Follow-ups for you', ...(follow.length ? follow.map((f) => `- ${f}`) : ['- none'])];
    if (transcript.length) lines.push('', '## Transcript', ...transcript.map((t) => `**${t.ts.slice(11, 19)} ${t.role === 'caller' ? who : 'Assistant'}:** ${t.text}`));
    writePrivate(file, `${lines.join('\n')}\n`);
    return file;
  }

  /** The action log for the notes: a queued chat message is replaced by what happened to it (chat_sent). */
  _notesActions(session) {
    const all = session.actions();
    const sent = all.some((x) => x.name === 'chat_sent');
    // Not transcribed (the caller objected): the assistant's free-text notes can quote the caller, so the
    // Desktop notes keep only the actions (F3-SAFE-E1).
    return all.filter((x) => !(x.name === 'call_send_chat_to_caller' && x.status === 'queued' && sent) && !(x.name === 'call_note' && !session.saveTranscript));
  }

  /** <state>/calls/<id>/meta.json, transcript.jsonl, actions.jsonl (0600; kept calls.keepCallDataDays). */
  _saveCallData(ctx, summary, notesPath) {
    try {
      const dir = path.join(this.callsDir(), ctx.id);
      const session = ctx.session;
      const meta = {
        id: ctx.id,
        caller: ctx.caller,
        app: ctx.app,
        startedAt: new Date(ctx.startedAt).toISOString(),
        endedAt: new Date(ctx.endedAt || this.now()).toISOString(),
        reason: ctx.reason || null,
        notesPath,
        summary: summary ? summary.summary : null,
        deferred: ctx.state.deferred,
        simulated: ctx.simulate || undefined,
      };
      writePrivate(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
      if (session && session.saveTranscript) writePrivate(path.join(dir, 'transcript.jsonl'), session.transcript().map((t) => JSON.stringify(t)).join('\n') + (session.transcript().length ? '\n' : ''));
      if (session) writePrivate(path.join(dir, 'actions.jsonl'), session.actions().map((x) => JSON.stringify(x)).join('\n') + (session.actions().length ? '\n' : ''));
    } catch (err) {
      log.warn(`saving the call data failed: ${err.message}`);
    }
  }

  _pruneCallData() {
    const days = Number(this.callsCfg().keepCallDataDays);
    const keep = Number.isFinite(days) && days > 0 ? days : 30;
    const limit = this.now() - keep * 86400000;
    let entries = [];
    try {
      entries = fs.readdirSync(this.callsDir(), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !/^[0-9a-f-]{36}$/.test(e.name)) continue;
      if (this.call && this.call.id === e.name) continue;
      if (this.prewarmed && this.prewarmed.id === e.name) continue;
      const dir = path.join(this.callsDir(), e.name);
      // An engine's run files (they hold the daemon token) left by a crashed daemon.
      rmrf(path.join(dir, 'engine'));
      try {
        const st = fs.statSync(dir);
        if (st.mtimeMs < limit || !fs.readdirSync(dir).length) rmrf(dir);
      } catch {
        /* gone */
      }
    }
  }

  // ------------------------------------------------------------------------------ tools for the routes

  /**
   * A call without ringing or clicking (env ANYWHERE_CALLS_SIMULATE=1 only; checked by the route). Still
   * needs calls to be armed by a click.
   * @param {{app?:string, caller?:string, engage?:boolean, audioParams?:object}} o
   */
  async simulate({ app = 'zoho-cliq', caller = 'Test Caller', engage = false, audioParams = null } = {}) {
    if (!this._armedNow()) return { ok: false, error: 'Turn on call answering first (it needs your click).', code: 'NOT_ARMED' };
    if (this.call) return { ok: false, error: 'A call is already in progress', code: 'BUSY' };
    const appId = policyMod.armApps([app], this.config())[0];
    let params = audioParams || null;
    if (engage) {
      const r = await this.bridge().engage({ browserApp: '' });
      params = r.startParams;
    }
    this._runCall({ caller: script().cleanName(caller) || null, app: appId, windowId: null, audioParams: params, engaged: Boolean(engage), simulate: true }).catch((err) => log.error(`the simulated call failed: ${err.message}`));
    await new Promise((r) => setImmediate(r));
    return { ok: true, callId: this.call ? this.call.id : null };
  }

  /** `anywhere calls learn`: record a test call's signature (only while not armed). */
  async learn(opts = {}) {
    if (this.armed || this.call) return { ok: false, reason: 'Turn off call answering (anywhere calls off) before learning a call signature.' };
    const det = await this.detector();
    // The CLI waits on the request, so the steps ("Seen the ringing call… now answer it") go to the dialog.
    const onProgress = (p) => {
      if (p && p.message) this._notify(`Learning how calls ring: ${p.message}`, 'info');
      if (typeof opts.onProgress === 'function') opts.onProgress(p);
    };
    return det.learn({ ...opts, onProgress });
  }

  async audioCheck({ deep = false } = {}) {
    const r = await this.bridge().check({ deep });
    this._lastAudioCheck = r;
    return { ok: true, ...r };
  }

  async audioSetup() {
    const r = await this.bridge().setup();
    return { ok: true, ...(r || {}) };
  }

  async audioTeardown() {
    if (this.call) return { ok: false, error: 'A call is in progress' };
    const r = await this.bridge().teardown();
    return { ok: true, ...(r || {}) };
  }

  /** The §5.5 browser self-test (its routes need no token, only the single-use code). */
  selfTest() {
    if (this._selfTest) return this._selfTest;
    const { AudioSelfTest } = require('./audio-bridge');
    const clone = this.clone;
    const piper = this.piper();
    const osRender = this.osRender();
    const renderSpeech = async (text, out) => {
      if (piper) {
        try {
          await piper.synthesize(text, { voice: (this.config().voice || {}).piperVoice || undefined, outFile: out });
          return out;
        } catch (err) {
          log.debug(`Piper could not render the test phrase: ${err.message}`);
        }
      }
      if (!osRender) throw httpError(503, 'No voice is available to speak the test phrase');
      await osRender(text, out);
      return out;
    };
    this._selfTest = new AudioSelfTest({ bridge: this.bridge(), transcribe: clone && typeof clone.transcribe === 'function' ? (wav) => clone.transcribe(wav) : undefined, renderSpeech });
    return this._selfTest;
  }

  /**
   * The notes file of a call this daemon wrote, by call id or by its exact path (never any other file).
   * @returns {string|null}
   */
  notesPathFor({ callId, path: wanted } = {}) {
    const known = new Map();
    for (const r of this.recent) if (r.callId && r.notesPath) known.set(r.callId, r.notesPath);
    const fromMeta = (id) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.callsDir(), id, 'meta.json'), 'utf8'));
        if (m && typeof m.notesPath === 'string' && m.notesPath) known.set(id, m.notesPath);
      } catch {
        /* none */
      }
    };
    const id = str(callId);
    if (id) {
      if (!/^[0-9a-f-]{36}$/.test(id)) return null;
      if (!known.has(id)) fromMeta(id);
      return known.get(id) || null;
    }
    if (!wanted) return null;
    const target = path.resolve(str(wanted));
    const match = () => [...known.values()].find((v) => path.resolve(v) === target) || null;
    if (match()) return match();
    try {
      for (const e of fs.readdirSync(this.callsDir()).slice(0, 1000)) if (/^[0-9a-f-]{36}$/.test(e)) fromMeta(e);
    } catch {
      /* none */
    }
    return match();
  }

  /** {path, markdown} of a call's notes (GET /api/calls/notes). */
  readNotes(q = {}) {
    const file = this.notesPathFor(q);
    if (!file) throw httpError(404, 'No notes for that call', { code: 'NO_NOTES' });
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw httpError(404, 'The notes file was moved or deleted', { code: 'NO_NOTES', path: file });
    }
    if (!st.isFile() || st.size > 1024 * 1024) throw httpError(422, 'The notes file cannot be shown here', { code: 'NOTES_UNREADABLE' });
    return { ok: true, path: file, markdown: fs.readFileSync(file, 'utf8') };
  }

  /** Open a call's notes in the default app (POST /api/calls/notes/open). */
  async openNotes(q = {}) {
    const file = this.notesPathFor(q);
    if (!file || !fs.existsSync(file)) throw httpError(404, 'No notes for that call', { code: 'NO_NOTES' });
    const open = typeof this.o.openTarget === 'function' ? this.o.openTarget : (t, opts) => require('../os/common').openTarget(t, opts);
    await open(file, { kind: 'path' });
    return { ok: true, path: file };
  }

  async shutdown() {
    this._closed = true;
    const ctx = this.call;
    if (ctx && ctx.session && !ctx.wrapping) {
      ctx.tookOver = true;
      await ctx.session.takeover().catch(() => {});
    }
    // The notes of a call cut by the shutdown are still written (bounded wait).
    if (ctx && ctx.wrapPromise) await Promise.race([ctx.wrapPromise, new Promise((r) => setTimeout(r, 15000).unref())]);
    this.disarm('shutdown');
    if (ctx && ctx.engaged) await this.bridge().release().catch(() => {});
    if (this._selfTest) await this._selfTest.close().catch(() => {});
    this._idle();
    if (this._bridge && typeof this._bridge.teardown === 'function') await this._bridge.teardown().catch(() => {});
  }
}

function script() {
  return require('../voice/clone/script');
}

/**
 * Seconds since the user last touched the keyboard or mouse (calls.answerOnlyWhenIdleSec, §14), or null when
 * it cannot be read: macOS `ioreg` HIDIdleTime, Linux X11 `xprintidle` (when installed), Windows
 * GetLastInputInfo through PowerShell.
 * @param {{platform:string, isWSL?:boolean}} pinfo
 * @param {{execFile?:Function, which?:Function}} [deps]
 * @returns {Promise<number|null>}
 */
async function systemIdleSeconds(pinfo = {}, deps = {}) {
  const execFile = deps.execFile || require('child_process').execFile;
  const which = deps.which || require('../shared/proc').which;
  const run = (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 6000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
    });
  if (pinfo.platform === 'darwin') {
    const out = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
    const m = out && /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
    return m ? Number(m[1]) / 1e9 : null;
  }
  if (pinfo.platform === 'win32' || pinfo.isWSL) {
    const ps = pinfo.isWSL ? which('powershell.exe') || '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : 'powershell.exe';
    const script =
      'Add-Type @"\nusing System;using System.Runtime.InteropServices;public static class AnywhereIdle{[StructLayout(LayoutKind.Sequential)]public struct L{public uint s;public uint t;}[DllImport("user32.dll")]static extern bool GetLastInputInfo(ref L l);public static uint Ms(){L l=new L();l.s=(uint)Marshal.SizeOf(l);GetLastInputInfo(ref l);return ((uint)Environment.TickCount-l.t);}}\n"@\n[AnywhereIdle]::Ms()';
    const out = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', script]);
    const n = out ? Number(out.trim().split(/\s+/).pop()) : NaN;
    return Number.isFinite(n) ? n / 1000 : null;
  }
  if (pinfo.platform === 'linux' && which('xprintidle')) {
    const out = await run('xprintidle', []);
    const n = out ? Number(out.trim()) : NaN;
    return Number.isFinite(n) ? n / 1000 : null;
  }
  return null;
}

module.exports = { CallManager, ARM_TOOL, ARM_REASON, APP_NAMES, appName, hhmm, systemIdleSeconds, MISSED_REASONS };
