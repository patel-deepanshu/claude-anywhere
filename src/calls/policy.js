'use strict';

/**
 * What the call assistant may do (docs/CALLS-DESIGN.md §1.3 (c) and (d), §7.2, §7.3).
 *
 *   class CallPolicy { constructor({config}); newCall({id, caller, app, projects, jiraBase}); check(call, name, args)
 *                      -> {allowed, reason, sanitizedArgs, kind}; reserve(call, kind); refund(call, kind); budgetLeft(call) }
 *   bindCaller({jira, displayName, issueKey?, email?})   caller binding (§7.3), async
 *   inQuietHours(date, qh), armWindow({minutes, config, now}), armApps(list, config)
 *   buildUnassignedJql({projects, text, project, sprint}), escapeJqlText(text), issueKeyOf(text)
 *   sanitizeSpeechText(text), sanitizeWriteText(text, opts), stripSecrets(text)
 *
 * Only the call_* tools exist for the call engine. Everything the caller says is untrusted: the JQL is
 * built here (the model only gives ≤ 100 characters of search text and a project key), writes act on
 * the bound caller only, every write has a per-call budget, text sent anywhere loses secrets and links
 * that are not this call's Jira issues, and everything else goes to call_defer.
 */

const { redact } = require('../shared/log');

const CALL_TOOL_NAMES = Object.freeze([
  'call_context',
  'call_find_unassigned_tickets',
  'call_ticket_brief',
  'call_assign_ticket_to_caller',
  'call_comment_on_ticket',
  'call_send_chat_to_caller',
  'call_defer',
  'call_note',
  'call_end',
  'call_permission',
]);
/** Tools the daemon executes (call_permission is the always-deny permission prompt, answered by the MCP server). */
const DAEMON_TOOLS = Object.freeze(CALL_TOOL_NAMES.filter((n) => n !== 'call_permission'));
const WRITE_KIND = Object.freeze({ call_assign_ticket_to_caller: 'assign', call_comment_on_ticket: 'comment', call_send_chat_to_caller: 'chat' });
const DEFAULT_LIMITS = Object.freeze({ assign: 1, comment: 2, chat: 2, writes: 3 });
/** Config can lower the budgets, never raise them above these. */
const MAX_LIMITS = Object.freeze({ assign: 3, comment: 5, chat: 5, writes: 8 });
const TEXT_MAX = Object.freeze({ search: 100, request: 300, details: 500, note: 300, comment: 500, chat: 500, reason: 200, email: 254 });
const DENY_TEXT = 'Not allowed during calls. Use call_defer.';
const ARM_MINUTES_CAP = 720;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8}$/;
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,19}$/;
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,185}\.[A-Za-z]{2,24}$/;
const KNOWN_APPS = Object.freeze(['zoho-cliq', 'google-meet', 'teams', 'slack', 'zoom']);

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function callsCfg(config) {
  return config && isObj(config.calls) ? config.calls : {};
}

function oneLine(s) {
  return str(s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u200b-\u200f\u2060\ufeff]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cap(s, n) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

// ------------------------------------------------------------------------------ time and arming (d)

function parseHm(s) {
  const m = str(s).match(/^\s*(\d{1,2}):(\d{2})\s*$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * Quiet hours in local time; start > end spans midnight (22:00–08:00).
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

/**
 * How long a click arms auto-answer: the request (default calls.defaultArmMinutes, 120), at least 1
 * minute, at most calls.maxArmMinutes and never more than 12 hours.
 * @returns {{minutes:number, until:number}}
 */
function armWindow({ minutes, config, now = Date.now() } = {}) {
  const c = callsCfg(config);
  const maxCfg = Number(c.maxArmMinutes);
  const max = Math.min(ARM_MINUTES_CAP, Number.isFinite(maxCfg) && maxCfg >= 1 ? maxCfg : ARM_MINUTES_CAP);
  const defCfg = Number(c.defaultArmMinutes);
  const def = Number.isFinite(defCfg) && defCfg >= 1 ? defCfg : 120;
  let m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) m = def;
  m = Math.round(Math.max(1, Math.min(max, m)));
  return { minutes: m, until: now + m * 60000 };
}

/** The app id of a name ("cliq", "Google Meet", "zoho-cliq"), or null for an app calls cannot answer. */
function appIdOf(a) {
  const s = str(a).toLowerCase().trim();
  if (KNOWN_APPS.includes(s)) return s;
  if (/\bcliq\b|zoho/.test(s)) return 'zoho-cliq';
  if (/\bmeet\b/.test(s)) return 'google-meet';
  if (/\bteams\b/.test(s)) return 'teams';
  if (/\bslack\b|huddle/.test(s)) return 'slack';
  if (/\bzoom\b/.test(s)) return 'zoom';
  return null;
}

/** Map app names ("cliq", "Google Meet") to app ids; unknown ones are dropped. [] → calls.apps. */
function armApps(list, config) {
  const from = Array.isArray(list) && list.length ? list : callsCfg(config).apps;
  const ids = (Array.isArray(from) ? from : KNOWN_APPS).map(appIdOf).filter(Boolean);
  return [...new Set(ids.length ? ids : KNOWN_APPS)];
}

// ------------------------------------------------------------------------------ Jira input

/** "PAY-412", "pay 412", "Pay–412" → "PAY-412"; anything else → null. */
function issueKeyOf(text) {
  const s = oneLine(text).normalize('NFKC').replace(/[‐‑‒–—]/g, '-').toUpperCase();
  const m = s.match(/^([A-Z][A-Z0-9_]{0,19})\s*[- ]\s*([1-9][0-9]{0,8})$/);
  if (!m) return null;
  const key = `${m[1]}-${m[2]}`;
  return ISSUE_KEY_RE.test(key) ? key : null;
}

function projectOfKey(key) {
  const k = str(key);
  const i = k.lastIndexOf('-');
  return i > 0 ? k.slice(0, i) : null;
}

function projectKeyOf(text) {
  const s = oneLine(text).toUpperCase();
  return PROJECT_KEY_RE.test(s) ? s : null;
}

/**
 * Free search text for `text ~ "…"`: letters, digits, spaces and apostrophes only (no Lucene or JQL
 * syntax survives), at most 100 characters, then escaped for a JQL string.
 */
function escapeJqlText(text) {
  const t = oneLine(text)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s']+/gu, ' ')
    .replace(/'+/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_MAX.search)
    .trim()
    // lower case: Lucene's AND/OR/NOT operators are upper case only
    .toLowerCase();
  return t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The server-built JQL of call_find_unassigned_tickets (§7.2).
 *   sprint: assignee is EMPTY AND statusCategory != Done AND sprint in openSprints() [AND project …] [AND text ~ "…"]
 *           ORDER BY priority DESC, Rank ASC
 *   backlog (no sprints): project in (…) AND assignee is EMPTY AND statusCategory = "To Do" [AND text ~ "…"]
 *           ORDER BY priority DESC, created ASC
 * @param {{projects?:string[], text?:string, project?:string, sprint?:boolean}} o
 * @returns {string}
 */
function buildUnassignedJql({ projects = [], text = '', project = '', sprint = true } = {}) {
  const valid = (Array.isArray(projects) ? projects : []).map(projectKeyOf).filter(Boolean);
  const one = project ? projectKeyOf(project) : null;
  if (project && !one) throw Object.assign(new Error('Invalid project key'), { code: 'BAD_INPUT' });
  const list = one ? [one] : [...new Set(valid)];
  const projectClause = list.length === 1 ? `project = "${list[0]}"` : list.length ? `project in (${list.map((p) => `"${p}"`).join(', ')})` : '';
  const t = escapeJqlText(text);
  const textClause = t ? `text ~ "${t}"` : '';
  if (sprint) {
    const where = ['assignee is EMPTY', 'statusCategory != Done', 'sprint in openSprints()', projectClause, textClause].filter(Boolean);
    return `${where.join(' AND ')} ORDER BY priority DESC, Rank ASC`;
  }
  if (!projectClause) throw Object.assign(new Error('A backlog search needs at least one project'), { code: 'NO_PROJECTS' });
  const where = [projectClause, 'assignee is EMPTY', 'statusCategory = "To Do"', textClause].filter(Boolean);
  return `${where.join(' AND ')} ORDER BY priority DESC, created ASC`;
}

// ------------------------------------------------------------------------------ text hygiene

const EXTRA_SECRETS = [
  // "password is hunter2", "my pin 1234"
  [/\b(password|passcode|passwd|pin|otp|one[- ]time code|security code|cvv)\b(\s*(?:is|was|:|=)?\s*)(\S+)/gi, '$1$2***'],
  // payment-card-like digit runs
  [/\b(?:\d[ -]?){13,19}\b/g, '***'],
  // long opaque tokens (keys, session ids)
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g, '***'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***'],
];

/** Mask likely secrets (the logger's patterns plus passwords, card numbers and long tokens). */
function stripSecrets(text) {
  let s = redact(str(text));
  for (const [re, rep] of EXTRA_SECRETS) s = s.replace(re, rep);
  return s;
}

const URL_RE = /(?<![\w@.-])(?:(?:https?|ftp|file|javascript|data|mailto):[^\s<>"'`)\]]+|www\.[^\s<>"'`)\]]+|(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|co|in|eu|uk|de|me|info|biz|xyz|link|site|online|ly|gl|to|cc)(?![a-z0-9-])(?:\/[^\s<>"'`)\]]*)?)/gi;

/** The Jira issue a URL points at when it is `<jiraBase>/browse/KEY`, else null. */
function jiraIssueOfUrl(url, jiraBase) {
  if (!jiraBase) return null;
  let u;
  let b;
  try {
    u = new URL(url);
    b = new URL(jiraBase);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.origin.toLowerCase() !== b.origin.toLowerCase() || u.username || u.password) return null;
  const basePath = b.pathname.replace(/\/+$/, '');
  const m = u.pathname.match(/^(.*)\/browse\/([A-Za-z][A-Za-z0-9_]{0,19}-[1-9][0-9]{0,8})\/?$/);
  if (!m || m[1] !== basePath || u.search || u.hash) return null;
  return m[2].toUpperCase();
}

/**
 * Text written to Jira or sent to the caller: one line (optional), secrets masked, links removed unless
 * `allowUrl(url)` accepts them, at most `max` characters.
 * @param {string} text
 * @param {{max?:number, singleLine?:boolean, allowUrl?:(url:string)=>boolean}} [opts]
 * @returns {{text:string, linksRemoved:number, secretsMasked:boolean}}
 */
function sanitizeWriteText(text, { max = 500, singleLine = true, allowUrl = () => false } = {}) {
  let s = str(text).normalize('NFC');
  s = singleLine ? oneLine(s) : s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  let linksRemoved = 0;
  s = s.replace(URL_RE, (u) => {
    const trimmed = u.replace(/[.,;:!?]+$/, '');
    const tail = u.slice(trimmed.length);
    if (allowUrl(trimmed)) return u;
    linksRemoved += 1;
    return `[link removed]${tail}`;
  });
  const masked = stripSecrets(s);
  return { text: cap(masked.trim(), max), linksRemoved, secretsMasked: masked !== s };
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu;

function countWords(text) {
  return (str(text).match(WORD_RE) || []).length;
}

/**
 * Text the assistant speaks: no markdown, no URLs read aloud ("the link"), secrets masked, emoji and
 * symbols dropped, at most `maxWords` words (a cut reply ends with a full stop).
 * @returns {string}
 */
function sanitizeSpeechText(text, { maxWords = 40 } = {}) {
  let s = str(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([^\n]*?\S)\1/g, '$2');
  s = s.replace(URL_RE, 'the link');
  s = stripSecrets(s);
  s = s
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[<>{}[\]|^~=#*_\\]/g, ' ');
  s = oneLine(s);
  if (maxWords > 0 && countWords(s) > maxWords) {
    let n = 0;
    let cut = s.length;
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(s))) {
      n += 1;
      if (n === maxWords) {
        cut = m.index + m[0].length;
        break;
      }
    }
    s = `${s.slice(0, cut).replace(/[,;:\s-]+$/, '')}.`;
  }
  return s;
}

// ------------------------------------------------------------------------------ caller binding (§7.3)

/** Case- and accent-insensitive form of a display name. */
function normalizeName(s) {
  return str(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function sameName(a, b) {
  const x = normalizeName(a);
  return Boolean(x) && x === normalizeName(b);
}

/**
 * Bind the caller (a name from the call app, never from speech) to exactly one Jira account.
 * One active findUser match with the same display name → bound. Several → the issue's assignable users
 * with that name. Still several → only an email that belongs to one of those candidates binds.
 * @param {{jira:object, displayName:string, issueKey?:string, email?:string, signal?:AbortSignal}} o
 * @returns {Promise<{bound:boolean, account?:object, via?:string, reason?:string, candidates?:number, needEmail?:boolean}>}
 */
async function bindCaller({ jira, displayName, issueKey, email, signal } = {}) {
  const name = oneLine(displayName);
  if (!name || !normalizeName(name)) return { bound: false, reason: 'no_name' };
  if (!jira || typeof jira.findUser !== 'function') return { bound: false, reason: 'no_jira' };
  let found;
  try {
    found = await jira.findUser(name, { signal });
  } catch (err) {
    if (err && err.code === 'ABORTED') throw err;
    return { bound: false, reason: 'lookup_failed', error: err && err.message };
  }
  const usable = (u) => u && u.active !== false && (u.accountId || u.name || u.key);
  let matches = (Array.isArray(found) ? found : []).filter((u) => usable(u) && sameName(u.displayName, name));
  if (matches.length === 1) return { bound: true, account: matches[0], via: 'findUser' };
  if (matches.length > 1 && issueKey && typeof jira.assignable === 'function') {
    try {
      const a = await jira.assignable(issueKey, name, { signal });
      const am = (Array.isArray(a) ? a : []).filter((u) => usable(u) && sameName(u.displayName, name));
      if (am.length === 1) return { bound: true, account: am[0], via: 'assignable' };
      if (am.length > 1) matches = am;
    } catch (err) {
      if (err && err.code === 'ABORTED') throw err;
    }
  }
  if (!matches.length) return { bound: false, reason: 'no_match' };
  const e = oneLine(email).toLowerCase();
  if (e) {
    if (!EMAIL_RE.test(e)) return { bound: false, reason: 'bad_email', candidates: matches.length, needEmail: true };
    const hit = matches.filter((u) => u.email && String(u.email).toLowerCase() === e);
    if (hit.length === 1) return { bound: true, account: hit[0], via: 'email' };
    return { bound: false, reason: 'email_mismatch', candidates: matches.length };
  }
  return { bound: false, reason: 'ambiguous', candidates: matches.length, needEmail: true };
}

// ------------------------------------------------------------------------------ CallPolicy

class CallPolicy {
  /**
   * @param {{config?:object|(()=>object)}} [opts] the live config (read on every check)
   */
  constructor({ config } = {}) {
    this.configRef = config || {};
  }

  config() {
    return typeof this.configRef === 'function' ? this.configRef() || {} : this.configRef;
  }

  /** The per-call budgets: calls.limits, clamped to MAX_LIMITS. */
  limits() {
    const l = isObj(callsCfg(this.config()).limits) ? callsCfg(this.config()).limits : {};
    const out = {};
    for (const k of Object.keys(DEFAULT_LIMITS)) {
      const n = Number(l[k]);
      out[k] = Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_LIMITS[k]) : DEFAULT_LIMITS[k];
    }
    return out;
  }

  /**
   * The per-call state the policy works on.
   * @param {{id:string, caller?:{displayName?:string|null}|string|null, app?:string|null, projects?:string[]|null,
   *   jiraBase?:string|null, now?:number}} o
   */
  newCall({ id, caller, app, projects = null, jiraBase = null, now = Date.now() } = {}) {
    const displayName = typeof caller === 'string' ? caller : caller && caller.displayName;
    return {
      id: str(id),
      active: true,
      startedAt: now,
      app: app || null,
      caller: { displayName: oneLine(displayName) || null, account: null, binding: null },
      projects: Array.isArray(projects) ? projects.map(projectKeyOf).filter(Boolean) : null,
      jiraBase: jiraBase || null,
      used: { assign: 0, comment: 0, chat: 0, writes: 0 },
      touched: new Set(),
      assigned: new Set(),
      chatQueue: [],
      deferred: [],
      notes: [],
    };
  }

  /** {assign, comment, chat, writes} still allowed in this call. */
  budgetLeft(call) {
    const lim = this.limits();
    const used = (call && call.used) || {};
    const out = {};
    for (const k of Object.keys(lim)) out[k] = Math.max(0, lim[k] - (Number(used[k]) || 0));
    return out;
  }

  /** Take one unit of a write budget (call before the write; refund() when it did not happen). */
  reserve(call, kind) {
    const left = this.budgetLeft(call);
    if (!left[kind] || !left.writes) return false;
    call.used[kind] += 1;
    call.used.writes += 1;
    return true;
  }

  refund(call, kind) {
    if (!call || !call.used || !(kind in call.used)) return;
    call.used[kind] = Math.max(0, call.used[kind] - 1);
    call.used.writes = Math.max(0, call.used.writes - 1);
  }

  /** Whether a project key is one the call may touch (projects unknown → no). */
  projectAllowed(call, project) {
    return Boolean(call && Array.isArray(call.projects) && project && call.projects.includes(project));
  }

  /**
   * Decide one tool call (synchronous checks; the manager adds the Jira-side checks and the binding).
   * @param {object} call newCall() state
   * @param {string} name
   * @param {object} args
   * @returns {{allowed:boolean, reason:string, sanitizedArgs?:object, kind?:string}}
   */
  check(call, name, args) {
    const deny = (reason) => ({ allowed: false, reason });
    if (!call || !call.active) return deny('No call is active.');
    if (!DAEMON_TOOLS.includes(name)) return deny(DENY_TEXT);
    const a = isObj(args) ? args : {};
    const kind = WRITE_KIND[name] || null;
    if (kind) {
      const left = this.budgetLeft(call);
      if (!left[kind]) return deny(`The limit for ${kind === 'assign' ? 'assignments' : kind === 'comment' ? 'comments' : 'chat messages'} in this call is used up. Use call_defer for anything else.`);
      if (!left.writes) return deny(`This call's limit of ${this.limits().writes} changes (assignments, comments and chat messages together) is used up. Use call_defer for anything else.`);
    }
    const needKey = () => {
      const key = issueKeyOf(a.key);
      if (!key) return { error: deny('Give the ticket key, like ABC-123.') };
      const project = projectOfKey(key);
      if (!this.projectAllowed(call, project)) return { error: deny(`${key} is not in a project the assistant may use during calls. Use call_defer.`) };
      return { key };
    };
    switch (name) {
      case 'call_context':
        return { allowed: true, reason: 'read', sanitizedArgs: {} };
      case 'call_find_unassigned_tickets': {
        const out = {};
        if (a.text != null) out.text = escapeJqlText(a.text) ? oneLine(a.text).slice(0, TEXT_MAX.search) : '';
        if (a.project != null && a.project !== '') {
          const p = projectKeyOf(a.project);
          if (!p) return deny('Give the project key, like ABC.');
          if (!this.projectAllowed(call, p)) return deny(`${p} is not a project the assistant may use during calls.`);
          out.project = p;
        }
        return { allowed: true, reason: 'read', sanitizedArgs: out };
      }
      case 'call_ticket_brief': {
        const k = needKey();
        return k.error || { allowed: true, reason: 'read', sanitizedArgs: { key: k.key } };
      }
      case 'call_assign_ticket_to_caller': {
        const k = needKey();
        if (k.error) return k.error;
        if (!call.caller || !call.caller.displayName) return deny('The call app did not show who is calling, so nothing can be assigned to them. Use call_defer.');
        if (call.caller.account && call.assigned.has(k.key)) return deny(`${k.key} is already assigned to the caller.`);
        const out = { key: k.key };
        if (a.email != null && a.email !== '') {
          const e = oneLine(a.email).toLowerCase();
          if (!EMAIL_RE.test(e)) return deny('That does not look like an email address.');
          out.email = e;
        }
        if (a.assignee != null && a.assignee !== '') return deny('Tickets can only be assigned to the caller of this call. Use call_defer for anyone else.');
        return { allowed: true, reason: 'write', sanitizedArgs: out, kind };
      }
      case 'call_comment_on_ticket': {
        const key = issueKeyOf(a.key);
        if (!key) return deny('Give the ticket key, like ABC-123.');
        if (!call.assigned.has(key)) return deny(`Only a ticket assigned to the caller in this call can get a comment (not ${key}). Use call_defer.`);
        const t = sanitizeWriteText(a.text, { max: TEXT_MAX.comment, singleLine: false, allowUrl: (u) => Boolean(jiraIssueOfUrl(u, call.jiraBase)) });
        if (!t.text) return deny('The comment is empty.');
        return { allowed: true, reason: 'write', sanitizedArgs: { key, text: t.text }, kind, linksRemoved: t.linksRemoved };
      }
      case 'call_send_chat_to_caller': {
        const t = sanitizeWriteText(a.text, {
          max: TEXT_MAX.chat,
          singleLine: true,
          allowUrl: (u) => {
            const key = jiraIssueOfUrl(u, call.jiraBase);
            return Boolean(key && call.touched.has(key));
          },
        });
        if (!t.text) return deny('The message is empty.');
        return { allowed: true, reason: 'write', sanitizedArgs: { text: t.text }, kind, linksRemoved: t.linksRemoved };
      }
      case 'call_defer': {
        const request = cap(stripSecrets(oneLine(a.request)), TEXT_MAX.request);
        if (!request) return deny('Say what the caller asked for.');
        const details = cap(stripSecrets(oneLine(a.details)), TEXT_MAX.details);
        return { allowed: true, reason: 'defer', sanitizedArgs: details ? { request, details } : { request } };
      }
      case 'call_note': {
        const text = cap(stripSecrets(oneLine(a.text)), TEXT_MAX.note);
        if (!text) return deny('The note is empty.');
        return { allowed: true, reason: 'note', sanitizedArgs: { text } };
      }
      case 'call_end':
        return { allowed: true, reason: 'end', sanitizedArgs: { reason: cap(oneLine(a.reason), TEXT_MAX.reason) || 'done' } };
      default:
        return deny(DENY_TEXT);
    }
  }
}

module.exports = {
  CallPolicy,
  CALL_TOOL_NAMES,
  DAEMON_TOOLS,
  WRITE_KIND,
  DEFAULT_LIMITS,
  MAX_LIMITS,
  TEXT_MAX,
  DENY_TEXT,
  KNOWN_APPS,
  ARM_MINUTES_CAP,
  inQuietHours,
  parseHm,
  armWindow,
  armApps,
  appIdOf,
  issueKeyOf,
  projectOfKey,
  projectKeyOf,
  escapeJqlText,
  buildUnassignedJql,
  stripSecrets,
  sanitizeWriteText,
  sanitizeSpeechText,
  jiraIssueOfUrl,
  countWords,
  normalizeName,
  sameName,
  bindCaller,
};
