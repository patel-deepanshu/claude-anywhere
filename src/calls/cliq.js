'use strict';

/**
 * Messaging the caller on Zoho Cliq after the call (docs/CALLS-DESIGN.md §7.4). The call engine
 * queues the text with call_send_chat_to_caller; the manager sends it after hang-up with sendChat().
 *
 * GUI path (default, no setup), sendViaGui():
 *   1. the Cliq window: the call's own window, else any window whose tab or process is Cliq, else
 *      https://cliq.zoho.<dc>/ is opened in the default browser;
 *   2. it is focused and confirmed as the active window (never a terminal, an editor or our dialog);
 *   3. vision checks that the conversation with the caller is open; if not, it locates the caller
 *      in the chat list, the routine clicks it and checks again (at most 3 locating steps in all);
 *   4. the message box must be empty (a draft the user typed is never sent or overwritten);
 *   5. vision locates the box → click → paste the text → Enter, re-checking before each key that
 *      the Cliq window is still the active one;
 *   6. a screenshot must show the sent text (vision yes/no).
 *   Every click passes answer.gatePoint() (inside the Cliq window, not our dialog, a terminal, an
 *   editor or the browser's tab strip) and a stillness check; every input action passes the
 *   caller's checkGuard() and Computer's own guard and failsafe. The model never gets raw click or
 *   type tools: the text is one line of at most 500 characters chosen by the call policy.
 *
 * REST path (optional, calls.cliq.mode = 'api'), CliqApi:
 *   POST https://cliq.zoho.<dc>/api/v2/buddies/<email>/message {"text"} with
 *   Authorization: Zoho-oauthtoken <access>, where the access token comes from the saved refresh
 *   token (POST https://accounts.zoho.<dc>/oauth/v2/token, grant_type=refresh_token) and lives in
 *   memory only. `anywhere calls cliq setup` exchanges a Self Client grant code for the refresh
 *   token (scope ZohoCliq.Webhooks.CREATE; a 401/403 says which scope to add). Secrets never
 *   appear in errors or logs.
 */

const util = require('../shared/util');
const { createLogger } = require('../shared/log');

const log = createLogger('calls-cliq');

/** Zoho data centers (the part after "zoho." in cliq.zoho.<dc>). */
const DCS = Object.freeze(['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa', 'uk', 'com.cn']);
const SCOPE = 'ZohoCliq.Webhooks.CREATE';
const MAX_TEXT = 500;
const HTTP_TIMEOUT_MS = 20000;
const TOKEN_SLACK_MS = 60000;
const OPEN_WAIT_MS = 12000;
const CHAT_SETTLE_MS = 1200;
const VERIFY_DELAY_MS = 1500;
const FOCUS_SETTLE_MS = 250;
const EMAIL_RE = /^[^\s@/?#\\]{1,64}@[^\s@/?#\\]{1,190}\.[^\s@/?#\\]{2,63}$/;
/** API failures after which the message was certainly not sent: the GUI path may try instead. */
const FALLBACK_CODES = new Set(['CLIQ_CONFIG', 'CLIQ_NO_EMAIL', 'CLIQ_AUTH', 'CLIQ_SCOPE', 'CLIQ_NOT_FOUND', 'CLIQ_BAD_EMAIL']);

class CliqError extends Error {
  constructor(message, { code = 'CLIQ_ERROR', hint, status } = {}) {
    super(message);
    this.name = 'CliqError';
    this.code = code;
    if (hint) this.hint = hint;
    if (status != null) this.status = status;
  }
}

// ---------------------------------------------------------------- small helpers

/** 'com' for '', 'zoho.eu' → 'eu'; throws for an unknown data center. */
function normalizeDc(dc) {
  const s = String(dc == null ? '' : dc)
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*?zoho\./, '')
    .replace(/[/:?#].*$/, '')
    .replace(/^\.+|\.+$/g, '');
  const v = s || 'com';
  if (!DCS.includes(v)) throw new CliqError(`Unknown Zoho data center "${dc}" (use one of ${DCS.join(', ')})`, { code: 'CLIQ_CONFIG', hint: 'It is the end of your Cliq address: cliq.zoho.com → com, cliq.zoho.eu → eu.' });
  return v;
}

/** The data center of a Cliq or Zoho URL ("https://cliq.zoho.eu/company/123/chats" → 'eu'), or null. */
function dcFromUrl(url) {
  const m = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*zoho\.([a-z.]+?)(?:[/:?#]|$)/i.exec(String(url || '').trim());
  if (!m) return null;
  const dc = m[1].toLowerCase();
  return DCS.includes(dc) ? dc : null;
}

const accountsUrl = (dc) => `https://accounts.zoho.${normalizeDc(dc)}`;
const apiConsoleUrl = (dc) => `https://api-console.zoho.${normalizeDc(dc)}`;
const cliqUrl = (dc) => `https://cliq.zoho.${normalizeDc(dc)}/`;

/** One line of at most 500 characters, no control or bidi characters; '' when nothing is left. */
function cleanChatText(text, max = MAX_TEXT) {
  let s = String(text == null ? '' : text);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    s = `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
  }
  return s;
}

function cleanCaller(name) {
  try {
    return require('./signatures').cleanCallerName(name);
  } catch {
    const s = String(name || '').replace(/["`\\{}<>]/g, '').trim().slice(0, 60);
    return /\p{L}/u.test(s) ? s : null;
  }
}

function parseJson(body) {
  if (body == null) return null;
  const s = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  if (!s.trim()) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** A short, secret-free description of a Zoho error body. */
function zohoErrorText(json) {
  if (!json || typeof json !== 'object') return '';
  const parts = [json.error, json.code, json.message, json.error_description].filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, 160));
  return [...new Set(parts)].join(': ');
}

/** The default HTTP client: the proxy-aware one Jira uses, with Zoho wording for network errors. */
async function defaultHttp(url, opts = {}) {
  const { httpRequest } = require('../integrations/jira');
  try {
    return await httpRequest(url, { timeoutMs: HTTP_TIMEOUT_MS, ...opts, maxRedirects: 0 });
  } catch (err) {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      host = 'Zoho';
    }
    const code = (err && err.code) || 'ENETWORK';
    const timedOut = /TIMEOUT|ETIMEDOUT/i.test(code) || /timed out/i.test(String(err && err.message));
    throw new CliqError(`Could not reach ${host} (${timedOut ? 'timed out' : code})`, {
      code: timedOut ? 'CLIQ_TIMEOUT' : 'CLIQ_NETWORK',
      hint: 'Check your network or proxy (HTTPS_PROXY), and the data center: anywhere config get calls.cliq.dc',
    });
  }
}

// ---------------------------------------------------------------- REST API

class CliqApi {
  /**
   * @param {{dc?:string, clientId:string, clientSecret:string, refreshToken:string,
   *   http?:(url:string, opts:{method:string, headers:object, body?:string, timeoutMs?:number})=>Promise<{status:number, headers?:object, body:Buffer|string}>,
   *   now?:()=>number}} opts
   */
  constructor({ dc = 'com', clientId, clientSecret, refreshToken, http, now } = {}) {
    this.dc = normalizeDc(dc);
    this.clientId = String(clientId || '').trim();
    this.clientSecret = String(clientSecret || '').trim();
    this.refreshToken = String(refreshToken || '').trim();
    this.http = typeof http === 'function' ? http : defaultHttp;
    this.now = typeof now === 'function' ? now : Date.now;
    this._access = null;
    this._expiresAt = 0;
    this._refreshing = null;
  }

  /** A CliqApi from config.calls.cliq, or null when the API mode is not fully set up. */
  static fromConfig(config, deps = {}) {
    const c = (config && config.calls && config.calls.cliq) || {};
    if (!c.clientId || !c.clientSecret || !c.refreshToken) return null;
    return new CliqApi({ dc: c.dc, clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refreshToken, ...deps });
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken);
  }

  /**
   * Exchange a Self Client grant code for a refresh token (`anywhere calls cliq setup`).
   * @returns {Promise<{refreshToken:string, accessToken:string, expiresIn:number, apiDomain:string|null}>}
   */
  static async exchangeGrant({ dc = 'com', clientId, clientSecret, code, http } = {}) {
    const d = normalizeDc(dc);
    const id = String(clientId || '').trim();
    const secret = String(clientSecret || '').trim();
    const grant = String(code || '').trim();
    if (!id || !secret || !grant) throw new CliqError('The client ID, client secret and grant code are all needed', { code: 'CLIQ_CONFIG' });
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: id, client_secret: secret, code: grant }).toString();
    const res = await (typeof http === 'function' ? http : defaultHttp)(`${accountsUrl(d)}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    const json = parseJson(res.body);
    if (res.status !== 200 || !json || json.error || !json.refresh_token) {
      const why = zohoErrorText(json) || `HTTP ${res.status}`;
      const used = /invalid_code/i.test(why);
      throw new CliqError(`Zoho did not issue a refresh token (${why})`, {
        code: 'CLIQ_AUTH',
        status: res.status,
        hint: used
          ? `Grant codes work once and expire within minutes: generate a new one at ${apiConsoleUrl(d)} (Self Client, scope ${SCOPE}) and paste it at once.`
          : `Check the client ID and secret of your Self Client at ${apiConsoleUrl(d)}, and that the data center (${d}) matches your Cliq address.`,
      });
    }
    return { refreshToken: String(json.refresh_token), accessToken: String(json.access_token || ''), expiresIn: Number(json.expires_in) || 3600, apiDomain: json.api_domain || null };
  }

  /** A valid access token (refreshed when missing or about to expire; one refresh at a time). */
  async accessToken({ force = false } = {}) {
    if (!this.configured) throw new CliqError('The Zoho Cliq API is not set up', { code: 'CLIQ_CONFIG', hint: 'Run: anywhere calls cliq setup' });
    if (!force && this._access && this.now() < this._expiresAt) return this._access;
    if (!this._refreshing) {
      this._refreshing = this._refresh().finally(() => {
        this._refreshing = null;
      });
    }
    return this._refreshing;
  }

  async _refresh() {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: this.clientId, client_secret: this.clientSecret, refresh_token: this.refreshToken }).toString();
    const res = await this.http(`${accountsUrl(this.dc)}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    const json = parseJson(res.body);
    if (res.status !== 200 || !json || json.error || !json.access_token) {
      const why = zohoErrorText(json) || `HTTP ${res.status}`;
      this._access = null;
      throw new CliqError(`Zoho refused to refresh the Cliq access token (${why})`, {
        code: res.status >= 500 ? 'CLIQ_HTTP' : 'CLIQ_AUTH',
        status: res.status,
        hint: 'The saved refresh token may have been revoked. Run: anywhere calls cliq setup',
      });
    }
    const ttl = Math.max(60, Number(json.expires_in) || 3600) * 1000;
    this._access = String(json.access_token);
    this._expiresAt = this.now() + Math.max(30000, ttl - TOKEN_SLACK_MS);
    return this._access;
  }

  /** Check the saved credentials (one token refresh; sends nothing). */
  async test() {
    await this.accessToken({ force: true });
    return { ok: true, dc: this.dc };
  }

  /**
   * Send one chat message to a Cliq user by email.
   * @returns {Promise<{ok:true, status:number}>} rejects with a CliqError (code CLIQ_AUTH, CLIQ_SCOPE,
   *   CLIQ_NOT_FOUND, CLIQ_RATE_LIMIT, CLIQ_HTTP, CLIQ_NETWORK, CLIQ_TIMEOUT, CLIQ_BAD_EMAIL)
   */
  async sendToBuddy(email, text) {
    const to = String(email || '').trim();
    if (!EMAIL_RE.test(to)) throw new CliqError('A valid email address of the Cliq user is needed', { code: 'CLIQ_BAD_EMAIL' });
    const msg = cleanChatText(text);
    if (!msg) throw new CliqError('The message is empty', { code: 'CLIQ_EMPTY' });
    const url = `https://cliq.zoho.${this.dc}/api/v2/buddies/${encodeURIComponent(to)}/message`;
    const payload = JSON.stringify({ text: msg });
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken({ force: attempt > 0 });
      const res = await this.http(url, {
        method: 'POST',
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: payload,
        timeoutMs: HTTP_TIMEOUT_MS,
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      const why = zohoErrorText(parseJson(res.body)) || `HTTP ${res.status}`;
      if (res.status === 401 && attempt === 0) {
        this._access = null; // expired or revoked early: refresh once and retry
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const scope = res.status === 403 || /scope/i.test(why);
        throw new CliqError(`Zoho Cliq refused the message (${why})`, {
          code: scope ? 'CLIQ_SCOPE' : 'CLIQ_AUTH',
          status: res.status,
          hint: `The token needs the scope ${SCOPE}: generate a new grant code with it at ${apiConsoleUrl(this.dc)} and run: anywhere calls cliq setup`,
        });
      }
      if (res.status === 404) throw new CliqError(`No Cliq user was found for that email (${why})`, { code: 'CLIQ_NOT_FOUND', status: 404, hint: `Check that the caller uses Cliq at cliq.zoho.${this.dc} with the email Jira has for them.` });
      if (res.status === 429) throw new CliqError('Zoho Cliq is rate limiting messages; try again later', { code: 'CLIQ_RATE_LIMIT', status: 429 });
      throw new CliqError(`Zoho Cliq answered ${why}`, { code: 'CLIQ_HTTP', status: res.status });
    }
    throw new CliqError('Zoho Cliq kept rejecting the access token', { code: 'CLIQ_AUTH', hint: 'Run: anywhere calls cliq setup' });
  }
}

// ---------------------------------------------------------------- GUI path

function errorReason(err) {
  if (err && err.code === 'PAUSED') return 'paused';
  if (err && err.code === 'FAILSAFE') return 'failsafe';
  if (err && err.code === 'VISION_RATE_LIMIT') return 'vision_rate_limit';
  if (err && err.code && /^VISION_|^CLAUDE_/.test(err.code)) return 'vision_failed';
  return 'error';
}

function sameId(a, b) {
  try {
    return require('../os/linux').sameWindowId(a, b);
  } catch {
    return String(a) === String(b);
  }
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
  return (windows || []).find((w) => w && sameId(w.id, id)) || null;
}

/** The window to send from: the call's window when it is still there, else a Cliq window. */
function findCliqWindow(windows, callWindowId) {
  const sig = require('./signatures');
  const usable = (w) => w && w.id != null && !sig.excludedKind(w);
  const isCliq = (w) => {
    const a = sig.appOfWindow(w);
    return Boolean(a && a.id === 'zoho-cliq');
  };
  const call = findWindow(windows, callWindowId);
  if (usable(call) && isCliq(call)) return call;
  const list = (windows || []).filter((w) => usable(w) && isCliq(w));
  list.sort((a, b) => Number(Boolean(a.minimized)) - Number(Boolean(b.minimized)) || Number(Boolean(b.focused)) - Number(Boolean(a.focused)));
  if (list.length) return list[0];
  // The call window itself (a browser whose active tab is no longer titled Cliq): vision decides.
  if (usable(call) && !call.minimized) {
    try {
      if (require('../os/linux').identifyBrowser(call.app, call.title)) return call;
    } catch {
      /* no browser check: not used */
    }
  }
  return null;
}

async function displayOf(driver, w) {
  const b = w && [w.x, w.y, w.width, w.height].every((n) => Number.isFinite(Number(n))) ? w : null;
  if (!b) return 0;
  try {
    const ds = await driver.displays();
    const cx = Number(b.x) + Number(b.width) / 2;
    const cy = Number(b.y) + Number(b.height) / 2;
    const i = (ds || []).findIndex((d) => cx >= Number(d.x) && cx < Number(d.x) + Number(d.width) && cy >= Number(d.y) && cy < Number(d.y) + Number(d.height));
    return i >= 0 ? i : 0;
  } catch {
    return 0;
  }
}

async function isActive(driver, win) {
  let active = null;
  try {
    active = await driver.activeWindow();
  } catch {
    active = null;
  }
  if (!active || !sameId(active.id, win.id)) return false;
  return !require('./signatures').excludedKind(active);
}

async function focusWindow(driver, win, sleep) {
  if (typeof driver.focusWindow !== 'function') return { ok: false, reason: 'focus_failed' };
  let ok = false;
  try {
    ok = await driver.focusWindow(win.id);
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, reason: 'focus_failed' };
  await sleep(FOCUS_SETTLE_MS);
  return (await isActive(driver, win)) ? { ok: true } : { ok: false, reason: 'focus_not_confirmed' };
}

const q = {
  open: (caller) => `Is a one-to-one chat conversation with ${caller} open in Zoho Cliq on this screen, with that name in the header of the open conversation?`,
  empty: () => 'Is the message input box at the bottom of the open conversation empty, showing only its placeholder text and no typed draft?',
  listEntry: (caller) => `the entry named ${caller} in the Zoho Cliq chat list or contacts list (the name itself), not a channel and not a message`,
  box: (caller) => `the message input box at the bottom of the open Zoho Cliq conversation with ${caller}, not the search box`,
  sent: (caller, snippet) => `In the open conversation with ${caller}, is the newest message one the user just sent that begins with: ${snippet}`,
};

/**
 * Click a point found by vision, after the code gates: inside the Cliq window, not our dialog, a
 * terminal, an editor or the browser's tab strip, and the screen there has not changed since.
 */
async function clickGated(point, shot, { computer, driver, win, display, now, guard }) {
  const { gatePoint, patchStill } = require('./answer');
  const windows = await listWindowsSafe(driver);
  const current = findWindow(windows, win.id) || win;
  const gate = gatePoint(point, {
    requireIncoming: false,
    shot: { width: shot.width, height: shot.height, display: shot.display == null ? display : shot.display },
    toLogical: (d, x, y) => computer.toLogical(d, x, y),
    windows,
    callWindow: current,
    callWindowId: current.id,
    now: now(),
  });
  if (!gate.ok) return { ok: false, reason: `gate:${gate.reason}` };
  const fresh = await computer.screenshot({ display });
  if (!patchStill(shot.png, fresh.png, point)) return { ok: false, reason: 'moved' };
  await guard();
  await computer.click({ x: point.x, y: point.y, display });
  return { ok: true };
}

/**
 * Send a chat message to the caller in the Zoho Cliq window with the Computer tools (§7.4).
 * @param {{callerName:string, text:string, computer:object, driver:object, vision:object,
 *   callWindowId?:string, windowId?:string (alias), app?:string (only 'zoho-cliq' is supported), dc?:string,
 *   config?:object (calls.cliq.dc), checkGuard?:()=>Promise<void>, open?:(url:string)=>Promise<any>,
 *   openIfMissing?:boolean, sleep?:(ms:number)=>Promise<void>, now?:()=>number}} opts
 * @returns {Promise<{ok:boolean, method:'gui', sent:boolean, verified?:boolean, typed?:boolean, reason:string|null,
 *   steps:object[], message?:string}>} sent: Enter was pressed (do not retry blindly when sent is true)
 */
async function sendViaGui(opts = {}) {
  const { computer, driver, vision } = opts;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : util.sleep;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const guard = typeof opts.checkGuard === 'function' ? async () => opts.checkGuard() : async () => {};
  const steps = [];
  let typed = false;
  const fail = (reason, extra = {}) => ({ ok: false, method: 'gui', sent: false, typed, reason, steps, ...extra });
  if (opts.app) {
    let id = null;
    try {
      id = require('./signatures').appFromText(opts.app) || opts.app;
    } catch {
      id = opts.app;
    }
    if (id !== 'zoho-cliq') return fail('unsupported_app');
  }
  const msg = cleanChatText(opts.text);
  if (!msg) return fail('empty_text');
  const caller = cleanCaller(opts.callerName);
  if (!caller) return fail('no_caller');
  if (!computer || !driver) return fail('no_computer');
  if (!vision) return fail('no_vision');
  try {
    // 1. The Cliq window (open Cliq when there is none).
    let windows = await listWindowsSafe(driver);
    const callWindowId = opts.callWindowId != null ? opts.callWindowId : opts.windowId;
    let win = findCliqWindow(windows, callWindowId);
    if (!win && opts.openIfMissing !== false) {
      const cfgDc = opts.config && opts.config.calls && opts.config.calls.cliq ? opts.config.calls.cliq.dc : null;
      let url;
      try {
        url = cliqUrl(opts.dc || cfgDc || 'com');
      } catch {
        url = cliqUrl('com');
      }
      await guard();
      const open = typeof opts.open === 'function' ? opts.open : (u) => require('../os/common').openTarget(u, { kind: 'url' });
      await open(url);
      steps.push({ step: 'open', url });
      const until = now() + (Number(opts.openWaitMs) > 0 ? Number(opts.openWaitMs) : OPEN_WAIT_MS);
      while (!win && now() < until) {
        await sleep(500);
        windows = await listWindowsSafe(driver);
        win = findCliqWindow(windows, null);
      }
      if (win) await sleep(CHAT_SETTLE_MS * 2); // let the web app load its chat list
    }
    if (!win) return fail('no_cliq_window');
    steps.push({ step: 'window', id: win.id, title: String(win.title || '').slice(0, 80) });

    // 2. Focus it and confirm.
    const f = await focusWindow(driver, win, sleep);
    if (!f.ok) return fail(f.reason);
    const display = await displayOf(driver, win);
    const ctx = { computer, driver, win, display, now, guard };

    // 3. The conversation with the caller.
    let shot = await computer.screenshot({ display });
    let open = await vision.verify(shot.png, q.open(caller), { purpose: 'verify' });
    steps.push({ step: 'check_open', open });
    if (!open) {
      const entry = await vision.locate(shot.png, q.listEntry(caller), { purpose: 'answer' });
      steps.push({ step: 'locate_entry', point: entry });
      if (!entry) return fail('caller_not_found');
      const c = await clickGated(entry, shot, ctx);
      if (!c.ok) return fail(c.reason);
      await sleep(CHAT_SETTLE_MS);
      shot = await computer.screenshot({ display });
      open = await vision.verify(shot.png, q.open(caller), { purpose: 'verify' });
      steps.push({ step: 'check_open', open });
      if (!open) return fail('chat_not_open');
    }

    // 4. Never send or overwrite a draft the user typed.
    const empty = await vision.verify(shot.png, q.empty(), { purpose: 'verify' });
    steps.push({ step: 'check_empty', empty });
    if (!empty) return fail('draft_in_box');

    // 5. Box → click → paste → Enter, checking the Cliq window is still the active one.
    const box = await vision.locate(shot.png, q.box(caller), { purpose: 'answer' });
    steps.push({ step: 'locate_box', point: box });
    if (!box) return fail('no_message_box');
    const c = await clickGated(box, shot, ctx);
    if (!c.ok) return fail(c.reason);
    await sleep(200);
    if (!(await isActive(driver, win))) return fail('focus_lost');
    await guard();
    await computer.typeText({ text: msg, method: 'paste' });
    typed = true;
    await sleep(200);
    if (!(await isActive(driver, win))) return fail('focus_lost');
    await guard();
    await computer.key({ combo: 'enter' });
    steps.push({ step: 'sent' });

    // 6. Verify on screen.
    await sleep(Number(opts.verifyDelayMs) >= 0 ? Number(opts.verifyDelayMs) : VERIFY_DELAY_MS);
    const after = await computer.screenshot({ display });
    const snippet = msg.length > 60 ? `${msg.slice(0, 60)}…` : msg;
    const verified = await vision.verify(after.png, q.sent(caller, snippet), { purpose: 'verify' });
    steps.push({ step: 'verify', verified });
    return { ok: verified, method: 'gui', sent: true, verified, typed, reason: verified ? null : 'not_verified', steps };
  } catch (err) {
    log.info('sending the Cliq message failed:', err && err.message);
    return fail(errorReason(err), { message: err && err.message });
  }
}

/**
 * Send the queued chat message after the call (the manager's entry point): the API when
 * calls.cliq.mode is 'api' and the caller's email is known, else (or when the API certainly did not
 * send it) the GUI path.
 * @param {object} opts sendViaGui() options plus {config, email?, app?, api?: CliqApi}
 * @returns {Promise<{ok:boolean, via:'api'|'gui'|null, sent:boolean|null, verified?:boolean, reason:string|null,
 *   error?:string, apiError?:{code:string, message:string}, steps?:object[]}>} sent null: unknown (a timeout)
 */
async function sendChat(opts = {}) {
  const config = opts.config || {};
  const c = (config.calls && config.calls.cliq) || {};
  if (opts.app) {
    let id = null;
    try {
      id = require('./signatures').appFromText(opts.app) || opts.app;
    } catch {
      id = opts.app;
    }
    if (id !== 'zoho-cliq') return { ok: false, via: null, sent: false, reason: 'unsupported_app' };
  }
  const text = cleanChatText(opts.text);
  if (!text) return { ok: false, via: null, sent: false, reason: 'empty_text' };
  let apiError = null;
  if (c.mode === 'api') {
    const api = opts.api || CliqApi.fromConfig(config, opts.http ? { http: opts.http } : {});
    try {
      if (!api) throw new CliqError('The Zoho Cliq API is not set up', { code: 'CLIQ_CONFIG' });
      if (!opts.email) throw new CliqError('The caller has no known email address', { code: 'CLIQ_NO_EMAIL' });
      const r = await api.sendToBuddy(opts.email, text);
      return { ok: true, via: 'api', sent: true, verified: true, reason: null, status: r.status };
    } catch (err) {
      apiError = { code: err.code || 'CLIQ_ERROR', message: err.message };
      if (!FALLBACK_CODES.has(err.code)) {
        // A timeout, a dropped connection or a server error: the message may have arrived. Never
        // send it twice (sent null = unknown); rate limits and empty texts certainly sent nothing.
        const certainlyNot = err.code === 'CLIQ_RATE_LIMIT' || err.code === 'CLIQ_EMPTY';
        return { ok: false, via: 'api', sent: certainlyNot ? false : null, reason: err.code || 'error', error: err.message, apiError };
      }
      log.info(`Cliq API did not send the message (${err.code}); trying the Cliq window instead`);
    }
  }
  const r = await sendViaGui({ ...opts, text, dc: opts.dc || c.dc });
  return { ...r, via: 'gui', ...(apiError ? { apiError } : {}) };
}

module.exports = {
  CliqApi,
  CliqError,
  sendViaGui,
  sendChat,
  cleanChatText,
  normalizeDc,
  dcFromUrl,
  accountsUrl,
  apiConsoleUrl,
  cliqUrl,
  findCliqWindow,
  DCS,
  SCOPE,
  MAX_TEXT,
  FALLBACK_CODES,
};
