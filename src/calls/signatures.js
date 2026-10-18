'use strict';

/**
 * Call signatures as data (docs/CALLS-DESIGN.md §4.1 A/B, §4.4): how a ringing call and a call in
 * progress show up in window titles and OS notifications, per app, plus the signatures learned
 * with `anywhere calls learn` (<state>/calls/signatures.json).
 *
 * Window titles and notification texts are set by web pages and other apps, so a match is only a
 * *candidate*: the detector and answer.js confirm with vision and code gates before any click.
 * Caller names taken from them are untrusted display text: they are cleaned (no control or
 * bidi characters, at most 60 characters) and must never be treated as instructions.
 */

const fs = require('fs');
const path = require('path');
const { identifyBrowser } = require('../os/linux');
const desktop = require('../context/desktop');
const { escapeRegExp } = require('../shared/util');

// ---------------------------------------------------------------- confidence levels (§4.2)

const CONFIDENCE = Object.freeze({
  learned: 0.95, // a calibrated signature (anywhere calls learn)
  known: 0.9, // title or notification of a known call app
  generic: 0.7, // the generic ringing pattern, app unknown
  newWindow: 0.7, // a new small window of a call app process (Teams, Zoom)
  titleChange: 0.5, // a call app's window changed its title to something unknown (below threshold)
  appeared: 0.4, // some new small window appeared (below threshold)
  screenDiff: 0.3, // a compact screen change (weak)
});
/** At or above this a candidate rings without a vision check (§4.2). */
const RING_THRESHOLD = 0.7;

// ---------------------------------------------------------------- title normalization

const INVISIBLE_RE = /[​-‏⁠-⁤﻿‪-‮⁦-⁩­]/g;
const DASH_RE = /[‐-―−﹘﹣－]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_TITLE = 512;

/**
 * NFKC, drop zero-width/bidi characters (Edge puts U+200B in "Microsoft​ Edge"), map dashes
 * (en/em dash, minus) to "-", collapse whitespace.
 * @param {string} t
 * @returns {string}
 */
function normalizeTitle(t) {
  let s = String(t == null ? '' : t);
  if (s.length > MAX_TITLE * 2) s = s.slice(0, MAX_TITLE * 2);
  try {
    s = s.normalize('NFKC');
  } catch {
    /* lone surrogates: keep as is */
  }
  return s.replace(INVISIBLE_RE, '').replace(CONTROL_RE, ' ').replace(DASH_RE, '-').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/** Browser window title suffixes, matched on a normalized title (§4.1 A). */
const BROWSER_SUFFIXES = Object.freeze([
  { id: 'chromium', name: 'Chromium', re: / - Chromium$/ },
  { id: 'chrome', name: 'Google Chrome', re: / - Google Chrome(?: (?:Beta|Dev|Canary|for Testing))?$/ },
  { id: 'brave', name: 'Brave', re: / - Brave(?: (?:Browser|Beta|Nightly|Dev))*$/ },
  { id: 'edge', name: 'Microsoft Edge', re: / - Microsoft ?Edge(?: (?:Beta|Dev|Canary))?$/ },
  { id: 'firefox', name: 'Firefox', re: / - (?:Mozilla Firefox(?: Private Browsing)?|Firefox(?: Developer Edition| Nightly)?)$/ },
  { id: 'vivaldi', name: 'Vivaldi', re: / - Vivaldi$/ },
  { id: 'opera', name: 'Opera', re: / - Opera(?: GX)?$/ },
  { id: 'librewolf', name: 'LibreWolf', re: / - LibreWolf$/ },
  { id: 'zen', name: 'Zen Browser', re: / - Zen Browser$/ },
]);

/**
 * Split a normalized window title into the active tab's title and the browser.
 * Also drops Edge's " and N more pages" and a leading unread count "(3) ".
 * @param {string} title raw or normalized title
 * @param {string} [app] the window's app (process) name
 * @returns {{tab:string, browser:{id:string,name:string}|null, variants:string[]}}
 *   variants: the tab title plus, for Edge, the title without a trailing " - <Profile>" segment
 */
function splitBrowserTitle(title, app) {
  const t = normalizeTitle(title);
  let tab = t;
  let browser = null;
  for (const b of BROWSER_SUFFIXES) {
    if (b.re.test(tab)) {
      tab = tab.replace(b.re, '');
      browser = { id: b.id, name: b.name };
      break;
    }
  }
  if (!browser) {
    const ib = identifyBrowser(app, t);
    if (ib) browser = { id: ib.id, name: ib.name };
  }
  const clean = (s) =>
    s
      .replace(/ and \d+ more (?:pages?|tabs?)$/i, '')
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/^[\p{So}\p{Sk}•●○◉▶►*\s]+/u, '')
      .trim();
  tab = clean(tab);
  const variants = [tab];
  if (browser && browser.id === 'edge') {
    const noProfile = clean(tab.replace(/ - [^-]{1,40}$/, ''));
    if (noProfile && noProfile !== tab) variants.push(noProfile);
  }
  return { tab, browser, variants };
}

// ---------------------------------------------------------------- apps (§4.1 table)

/** Ringing text any app may use (weight 0.7 alone, 0.9 with a known app). */
const GENERIC_RINGING_RE = /\b(?:incoming (?:audio |video |voice )?call|is calling(?: you)?|calling you|wants to (?:call|talk)|ringing)\b/i;
/** The generic pattern without its bare "ringing" alternative. */
const STRONG_RINGING_RE = /\b(?:incoming (?:audio |video |voice )?call|is calling(?: you)?|calling you|wants to (?:call|talk))\b/i;
/** In-call wording some apps use; only counts together with a known app. */
const GENERIC_IN_CALL_RE = /\b(?:ongoing call|call in progress|in call with|on call with|in a call)\b/i;

/**
 * Known call apps. ringing/inCall are matched against the tab title (browser) or window title
 * (desktop app) after normalization. shortcuts are key combos for Computer.key ('primary' = cmd on
 * macOS, ctrl elsewhere). status says how well the pattern is known (docs/CALLS-DESIGN.md §4.1).
 */
const APPS = Object.freeze([
  {
    id: 'zoho-cliq',
    name: 'Zoho Cliq',
    titleRe: /\b(?:zoho[ -]?cliq|cliq)\b/i,
    processRe: /\b(?:zoho[ -]?cliq|cliq)\b/i,
    originRe: /(?:^|\.)cliq\.zoho\.(?:com|eu|in|com\.au|jp|ca|sa|com\.cn|uk)$|(?:^|\.)zohocliq\.com$/i,
    notifAppRe: /\b(?:zoho[ -]?)?cliq\b/i,
    ringing: [GENERIC_RINGING_RE],
    inCall: [GENERIC_IN_CALL_RE],
    shortcuts: {},
    status: 'unverified: calibrate with `anywhere calls learn`',
  },
  {
    id: 'google-meet',
    name: 'Google Meet',
    titleRe: /^Meet(?: - |$)|\bGoogle Meet\b/i,
    processRe: /\bgoogle meet\b/i,
    originRe: /(?:^|\.)meet\.google\.com$/i,
    notifAppRe: /\bgoogle meet\b/i,
    ringing: [GENERIC_RINGING_RE],
    inCall: [/^Meet - [a-z]{3}-[a-z]{4}-[a-z]{3}\b/i],
    shortcuts: { camera: 'primary+e', mute: 'primary+d' },
    status: 'meet code pattern known; ring text unverified',
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    titleRe: /\bMicrosoft Teams\b/i,
    processRe: /\b(?:ms-?teams|microsoft teams|teams)(?:\.exe)?\b/i,
    originRe: /(?:^|\.)teams\.(?:microsoft\.com|live\.com|cloud\.microsoft)$/i,
    notifAppRe: /\b(?:microsoft )?teams\b/i,
    ringing: [/^Microsoft Teams Notification$/i, GENERIC_RINGING_RE],
    inCall: [/\b(?:meeting|call)\b.*\|\s*Microsoft Teams$/i, /^(?:meeting|call) with\b/i],
    // Accept with audio only, hang up, camera toggle (Teams docs: keyboard shortcuts).
    shortcuts: { accept: 'primary+shift+s', decline: 'primary+shift+d', hangUp: 'primary+shift+h', camera: 'primary+shift+o', mute: 'primary+shift+m' },
    newWindow: { maxAreaFrac: 0.2, confidence: CONFIDENCE.newWindow },
    status: 'partly documented',
  },
  {
    id: 'slack',
    name: 'Slack',
    titleRe: /\bSlack\b/,
    processRe: /\bslack\b/i,
    originRe: /(?:^|\.)app\.slack\.com$/i,
    notifAppRe: /\bslack\b/i,
    ringing: [/\b(?:huddle invite|invit\w* you to (?:a |their |the )?huddle|wants to huddle|asked you to join (?:a |their |the )?huddle)\b/i, GENERIC_RINGING_RE],
    inCall: [/\bhuddle\b/i],
    shortcuts: {},
    status: 'unverified',
  },
  {
    id: 'zoom',
    name: 'Zoom',
    titleRe: /^Zoom(?: (?:Meeting|Webinar|Workplace|Phone))?\b|\bZoom (?:Meeting|Phone|Workplace)\b/,
    processRe: /^(?:zoom(?:\.us)?|zoom\.exe|zoom workplace|zoom meetings)$/i,
    originRe: /(?:^|\.)zoom\.us$/i,
    notifAppRe: /\bzoom\b/i,
    ringing: [GENERIC_RINGING_RE],
    inCall: [/^Zoom (?:Meeting|Webinar)\b/i],
    // acceptPhone: Zoom Phone only; camera: Win/Linux alt+v (macOS cmd+shift+v).
    shortcuts: { acceptPhone: 'ctrl+shift+a', camera: { darwin: 'cmd+shift+v', other: 'alt+v' } },
    newWindow: { maxAreaFrac: 0.2, confidence: CONFIDENCE.newWindow },
    status: 'partly documented',
  },
]);

const APP_IDS = APPS.map((a) => a.id);
const APP_WORDS_RE = /^(?:zoho|cliq|zoho cliq|google|meet|google meet|microsoft teams|teams|slack|zoom|chromium|google chrome|chrome|brave|microsoft edge|edge|firefox|mozilla firefox|safari|incoming|call|calls|audio|video|voice|audio call|video call|voice call|meeting|huddle|new notification|notification|unknown|caller|someone)$/i;

/** @returns {object|null} the APPS entry for an id */
function appById(id) {
  return APPS.find((a) => a.id === id) || null;
}

/**
 * Map free text (a vision "app" answer, a notification app name, a config entry such as "cliq"
 * or "meet") to an app id.
 * @returns {string|null}
 */
function appFromText(text) {
  const s = normalizeTitle(text).toLowerCase();
  if (!s) return null;
  if (APP_IDS.includes(s)) return s;
  if (/\bcliq\b/.test(s)) return 'zoho-cliq';
  if (/\bmeet\b/.test(s)) return 'google-meet';
  if (/\bteams\b/.test(s)) return 'teams';
  if (/\bslack\b|\bhuddle\b/.test(s)) return 'slack';
  if (/\bzoom\b/.test(s)) return 'zoom';
  return null;
}

/** Host part of an origin-like text ("cliq.zoho.com", "https://meet.google.com/abc", "localhost:8765"). */
function hostOf(origin) {
  const s = String(origin == null ? '' : origin).trim().toLowerCase();
  if (!s) return '';
  const m = s.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/\s:?#]+)/);
  return m ? m[1].replace(/\.$/, '') : '';
}

/** @returns {string|null} the app id for a web origin */
function appFromOrigin(origin) {
  const host = hostOf(origin);
  if (!host) return null;
  const app = APPS.find((a) => a.originRe && a.originRe.test(host));
  return app ? app.id : null;
}

// ---------------------------------------------------------------- caller names

const SEP_SPLIT_RE = /\s+(?:-|\||·|•|:)\s+/;

/**
 * Clean a caller display name taken from a title, notification or vision answer: untrusted text.
 * @returns {string|null} at most 60 characters with a letter in it, else null
 */
function cleanCallerName(raw) {
  let s = normalizeTitle(raw);
  if (!s) return null;
  s = s
    .replace(/^["'“”‘’(<[]+|["'“”‘’)>\].,!?:;]+$/g, '')
    .replace(/\s+(?:on|via|in|from) (?:zoho cliq|cliq|google meet|meet|microsoft teams|teams|slack|zoom)\b.*$/i, '')
    .replace(/[<>{}`\\]/g, '')
    .trim();
  if (s.length > 60) s = s.slice(0, 60).replace(/\s+\S*$/, '').trim();
  if (!s || !/\p{L}/u.test(s) || APP_WORDS_RE.test(s)) return null;
  if (GENERIC_RINGING_RE.test(s) || /^https?:|^www\.|\.(?:com|net|org|io)\b/i.test(s)) return null;
  return s;
}

/**
 * Pull the caller's display name out of ringing text such as "Incoming call - Ankit Sharma",
 * "Ankit Sharma is calling you", "Incoming video call from Ankit Sharma" or "Call from Ankit".
 * @param {string} text normalized tab title or notification text
 * @returns {string|null}
 */
function extractCaller(text) {
  const s = normalizeTitle(text);
  if (!s) return null;
  let m = s.match(/\b(?:incoming (?:audio |video |voice )?call|call|calling) from\s+(.+)$/i);
  if (m) return cleanCallerName(m[1].split(SEP_SPLIT_RE)[0]);
  m = s.match(/^(.+?)\s+(?:is calling(?: you)?|is ringing you|wants to (?:call|talk|huddle)|calling you|invit\w* you to (?:a |their |the )?huddle)\b/i);
  if (m) {
    const parts = m[1].split(SEP_SPLIT_RE);
    return cleanCallerName(parts[parts.length - 1]);
  }
  m = s.match(/\bincoming (?:audio |video |voice )?call\b\s*(?:-|:|\||·|•)\s*(.+)$/i);
  if (m) return cleanCallerName(m[1].split(SEP_SPLIT_RE)[0]);
  m = s.match(/^(.+?)\s*(?:-|:|\||·|•)\s*incoming (?:audio |video |voice )?call\b/i);
  if (m) {
    const parts = m[1].split(SEP_SPLIT_RE);
    return cleanCallerName(parts[parts.length - 1]);
  }
  return null;
}

// ---------------------------------------------------------------- excluded windows

const TERMINAL_APP_RE =
  /terminal|iterm|\bwarp\b|ghostty|konsole|xterm|alacritty|kitty|wezterm|tilix|terminator|terminology|tilda|rxvt|\bfoot\b|guake|yakuake|termite|sakura|qterminal|ptyxis|blackbox|st-256color|conhost|openconsole|command processor|console window host|^console$|\bkgx\b|conemu|cmder|^cmd(?:\.exe)?$|powershell|pwsh|windowsterminal|mintty|putty|mobaxterm|termius|tabby/i;
const EDITOR_APP_RE =
  /^(?:code|code - insiders|cursor|windsurf|vscodium|codium|sublime[_ ]text|subl|zed|emacs|gvim|n?vim|neovide|notepad\+\+|kate|gedit|xed|mousepad|pluma|textedit|bbedit|nova|fleet|idea|pycharm|webstorm|goland|clion|rider|phpstorm|rubymine|datagrip|android studio)(?:\.exe|64\.exe)?$|visual studio|intellij|jetbrains/i;

/**
 * The window is our own dialog, a terminal or an editor: never a call, never a click target.
 * @param {{app?:string,title?:string,process?:string}} w
 * @returns {'own'|'terminal'|'editor'|null}
 */
function excludedKind(w) {
  if (!w) return null;
  if (desktop.isOwnWindow(w) || /^Claude Anywhere\b/.test(String(w.title || ''))) return 'own';
  const app = String(w.app || '');
  const procName = String(w.process || '').split(/[\\/]/).pop();
  if (TERMINAL_APP_RE.test(app) || (procName && TERMINAL_APP_RE.test(procName))) return 'terminal';
  // A browser is never an editor, whatever its tab says ("Pricing - Cursor").
  if (identifyBrowser(app, w.title)) return null;
  if (EDITOR_APP_RE.test(app) || (procName && EDITOR_APP_RE.test(procName))) return 'editor';
  try {
    if (desktop.parseEditorTitle(w.title || '', app)) return 'editor';
  } catch {
    /* not an editor title */
  }
  return null;
}

// ---------------------------------------------------------------- learned signatures (§4.4)

const LEARNED_VERSION = 1;
const MAX_RE_LEN = 400;
const MAX_LEARNED = 50;

function learnedFile(file) {
  if (file) return file;
  const paths = require('../shared/paths');
  return path.join(paths.callsDir(), 'signatures.json');
}

function compileRe(src) {
  if (typeof src !== 'string' || !src || src.length > MAX_RE_LEN) return null;
  try {
    return new RegExp(src, 'iu');
  } catch {
    return null;
  }
}

function finiteRel(p, keys) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const k of keys) {
    const v = Number(p[k]);
    if (!Number.isFinite(v)) return null;
    out[k] = v;
  }
  if (typeof p.anchor === 'string' && /^(?:tl|tr|bl|br|c)$/.test(p.anchor)) out.anchor = p.anchor;
  return out;
}

/**
 * Validate one stored signature; returns the clean record with compiled regexes under
 * non-enumerable-ish keys (_titleRe, _notifRe, _inCallRe), or null.
 */
function compileSignature(sig) {
  if (!sig || typeof sig !== 'object') return null;
  const app = appFromText(sig.app) || (typeof sig.app === 'string' && /^[a-z0-9-]{1,40}$/.test(sig.app) ? sig.app : null);
  if (!app) return null;
  const out = { app };
  for (const k of ['titleRe', 'notifRe', 'inCallTitleRe']) {
    if (sig[k] == null || sig[k] === '') continue;
    if (!compileRe(sig[k])) return null;
    out[k] = sig[k];
  }
  if (!out.titleRe && !out.notifRe) return null;
  if (typeof sig.origin === 'string' && sig.origin) out.origin = hostOf(sig.origin) || undefined;
  if (typeof sig.browser === 'string' && /^[a-z]{2,20}$/.test(sig.browser)) out.browser = sig.browser;
  if (typeof sig.process === 'string' && sig.process.length <= 80) out.process = sig.process;
  const region = finiteRel(sig.popupRegion, ['x', 'y', 'width', 'height']);
  if (region) out.popupRegion = region;
  const accept = finiteRel(sig.acceptRel, ['x', 'y']);
  if (accept) {
    if (sig.acceptRel.dx != null && Number.isFinite(Number(sig.acceptRel.dx))) accept.dx = Number(sig.acceptRel.dx);
    if (sig.acceptRel.dy != null && Number.isFinite(Number(sig.acceptRel.dy))) accept.dy = Number(sig.acceptRel.dy);
    out.acceptRel = accept;
  }
  // The Accept button's mean color when learned: a learned position is only clicked while it shows it.
  if (Array.isArray(sig.acceptColor) && sig.acceptColor.length === 3 && sig.acceptColor.every((v) => Number.isFinite(Number(v)) && v >= 0 && v <= 255)) {
    out.acceptColor = sig.acceptColor.map((v) => Math.round(Number(v)));
  }
  if (sig.windowSize && Number(sig.windowSize.width) > 0 && Number(sig.windowSize.height) > 0) {
    out.windowSize = { width: Number(sig.windowSize.width), height: Number(sig.windowSize.height) };
  }
  // acceptRel/popupRegion are relative to the ringing window, or (no window changed) to a display.
  if (sig.relativeTo === 'display') {
    out.relativeTo = 'display';
    out.display = Number.isInteger(sig.display) && sig.display >= 0 ? sig.display : 0;
  }
  out.learnedAt = typeof sig.learnedAt === 'string' ? sig.learnedAt : new Date(0).toISOString();
  Object.defineProperty(out, '_titleRe', { value: compileRe(out.titleRe), enumerable: false });
  Object.defineProperty(out, '_notifRe', { value: compileRe(out.notifRe), enumerable: false });
  Object.defineProperty(out, '_inCallRe', { value: compileRe(out.inCallTitleRe), enumerable: false });
  return out;
}

/**
 * Learned signatures from <state>/calls/signatures.json (invalid entries are skipped).
 * @param {{file?:string}} [opts]
 * @returns {object[]}
 */
function loadLearned({ file } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(learnedFile(file), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.signatures) ? raw.signatures : [];
  return list.slice(0, MAX_LEARNED).map(compileSignature).filter(Boolean);
}

/**
 * Save a learned signature, replacing an earlier one for the same app, browser/process and origin.
 * Written atomically with mode 0600.
 * @param {object} sig {app, titleRe?, notifRe?, origin?, browser?, process?, popupRegion?, acceptRel?, inCallTitleRe?, learnedAt?}
 * @param {{file?:string}} [opts]
 * @returns {object} the stored (validated) signature
 */
function saveLearned(sig, { file } = {}) {
  const clean = compileSignature({ ...sig, learnedAt: sig && sig.learnedAt ? sig.learnedAt : new Date().toISOString() });
  if (!clean) {
    const err = new Error('Not a valid call signature: it needs an app and a title or notification pattern');
    err.code = 'BAD_SIGNATURE';
    throw err;
  }
  const target = learnedFile(file);
  const keep = loadLearned({ file: target }).filter(
    (s) => !(s.app === clean.app && (s.browser || '') === (clean.browser || '') && (s.process || '') === (clean.process || '') && (s.origin || '') === (clean.origin || ''))
  );
  const list = [clean, ...keep].slice(0, MAX_LEARNED);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: LEARNED_VERSION, signatures: list }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* Windows: no mode bits */
  }
  return clean;
}

/**
 * A title or notification text turned into a learned pattern: literal text (regex-escaped), the
 * caller's name as a named group, digit runs as \\d+, anchored at both ends.
 * @returns {string|null}
 */
function textPattern(text, caller) {
  const t = normalizeTitle(text);
  if (!t) return null;
  let src = escapeRegExp(t);
  const name = caller ? normalizeTitle(caller) : '';
  let hasCaller = false;
  if (name && name.length >= 2) {
    const en = escapeRegExp(name);
    const i = src.toLowerCase().indexOf(en.toLowerCase());
    if (i >= 0) {
      src = `${src.slice(0, i)}\u0000${src.slice(i + en.length)}`;
      hasCaller = true;
    }
  }
  src = src.replace(/\d+/g, '\\d+');
  if (hasCaller) src = src.replace('\u0000', '(?<caller>.+?)');
  const literal = src.replace(/\(\?<caller>\.\+\?\)|\\d\+|\\./g, '');
  if ((literal.match(/\p{L}/gu) || []).length < 4) return null;
  src = `^${src}$`;
  return src.length <= MAX_RE_LEN ? src : null;
}

/**
 * The logical (global) point of a learned Accept button for the ringing window's current bounds
 * (or the display's, for display-relative signatures): the learned fraction when the size is
 * unchanged, else the offset from the nearest corner it was learned at.
 * @param {{acceptRel:{x:number,y:number,anchor?:string,dx?:number,dy?:number}, windowSize?:object}} sig
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @returns {{x:number,y:number}|null}
 */
function learnedAcceptPoint(sig, bounds) {
  const r = sig && sig.acceptRel;
  if (!r || !bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const sameSize = sig.windowSize && Math.abs(sig.windowSize.width - bounds.width) <= 2 && Math.abs(sig.windowSize.height - bounds.height) <= 2;
  let x;
  let y;
  if (sameSize || !r.anchor || r.dx == null || r.dy == null) {
    x = bounds.x + r.x * bounds.width;
    y = bounds.y + r.y * bounds.height;
  } else {
    const a = r.anchor;
    x = a === 'c' ? bounds.x + bounds.width / 2 + r.dx : a.endsWith('r') ? bounds.x + bounds.width + r.dx : bounds.x + r.dx;
    y = a === 'c' ? bounds.y + bounds.height / 2 + r.dy : a.startsWith('b') ? bounds.y + bounds.height + r.dy : bounds.y + r.dy;
  }
  x = Math.round(x);
  y = Math.round(y);
  if (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) return null;
  return { x, y };
}

/**
 * A point relative to bounds, for storing: fractions plus the offset from the nearest corner.
 * @returns {{x:number,y:number,anchor:string,dx:number,dy:number}|null}
 */
function relativePoint(p, bounds) {
  if (!p || !bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const fx = (p.x - bounds.x) / bounds.width;
  const fy = (p.y - bounds.y) / bounds.height;
  if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
  const h = fx < 0.5 ? 'l' : 'r';
  const v = fy < 0.5 ? 't' : 'b';
  return {
    x: Math.round(fx * 10000) / 10000,
    y: Math.round(fy * 10000) / 10000,
    anchor: v + h,
    dx: Math.round(h === 'l' ? p.x - bounds.x : p.x - (bounds.x + bounds.width)),
    dy: Math.round(v === 't' ? p.y - bounds.y : p.y - (bounds.y + bounds.height)),
  };
}

function learnedApplies(sig, w, browser) {
  if (sig.browser && (!browser || browser.id !== sig.browser)) return false;
  if (sig.process) {
    const app = String((w && (w.process || w.app)) || '').toLowerCase();
    if (!app.includes(String(sig.process).toLowerCase())) return false;
  }
  return true;
}

function namedCaller(m) {
  if (!m) return null;
  const g = m.groups && (m.groups.caller || m.groups.name);
  return cleanCallerName(g || (m.length > 1 ? m[1] : ''));
}

// ---------------------------------------------------------------- matching

/**
 * The call app a window belongs to: by process (desktop apps), else by its tab title.
 * @returns {object|null} APPS entry
 */
function appOfWindow(w, split = splitBrowserTitle(w && w.title, w && w.app)) {
  if (!w) return null;
  const app = String(w.app || '');
  const procName = String(w.process || '');
  if (!split.browser) {
    const byProc = APPS.find((a) => a.processRe && (a.processRe.test(app) || (procName && a.processRe.test(procName))));
    if (byProc) return byProc;
  }
  return APPS.find((a) => split.variants.some((v) => a.titleRe.test(v))) || null;
}

/**
 * Match one window's title against the learned and built-in signatures.
 * @param {{id?:string, app?:string, title?:string, process?:string}} window driver.listWindows() entry
 * @param {{learned?:object[]}} [opts]
 * @returns {{app:string|null, kind:'ringing'|'in_call', caller?:string, confidence:number, source:'title',
 *   browser:string|null, tab:string, learned?:object}|null}
 */
function matchTitle(window, { learned = [] } = {}) {
  if (!window || typeof window !== 'object') return null;
  if (excludedKind(window)) return null;
  const split = splitBrowserTitle(window.title, window.app);
  if (!split.tab) return null;
  const base = { source: 'title', browser: split.browser ? split.browser.id : null, tab: split.tab };
  for (const sig of learned || []) {
    if (!learnedApplies(sig, window, split.browser)) continue;
    for (const v of split.variants) {
      const m = sig._titleRe && sig._titleRe.exec(v);
      if (m) {
        const caller = namedCaller(m) || extractCaller(v);
        return { app: sig.app, kind: 'ringing', confidence: CONFIDENCE.learned, ...base, ...(caller ? { caller } : {}), learned: sig };
      }
      if (sig._inCallRe && sig._inCallRe.test(v)) return { app: sig.app, kind: 'in_call', confidence: CONFIDENCE.learned, ...base, learned: sig };
    }
  }
  const app = appOfWindow(window, split);
  if (app) {
    for (const v of split.variants) {
      if (app.ringing.some((re) => re.test(v))) {
        const caller = extractCaller(v);
        return { app: app.id, kind: 'ringing', confidence: CONFIDENCE.known, ...base, ...(caller ? { caller } : {}) };
      }
    }
    for (const v of split.variants) {
      if (app.inCall.some((re) => re.test(v))) return { app: app.id, kind: 'in_call', confidence: CONFIDENCE.known, ...base };
    }
    return null;
  }
  for (const v of split.variants) {
    if (GENERIC_RINGING_RE.test(v)) {
      const caller = extractCaller(v);
      // The bare word "ringing" ("Ringing in the ears - Wikipedia") is too common to ring on its
      // own: below the threshold, so it only leads to a (rate-limited) vision check.
      const conf = STRONG_RINGING_RE.test(v) ? CONFIDENCE.generic : CONFIDENCE.titleChange;
      return { app: null, kind: 'ringing', confidence: conf, ...base, ...(caller ? { caller } : {}) };
    }
  }
  return null;
}

/**
 * A new small window of a call app's process (classic or new Teams toast window, Zoom's
 * incoming-call window): ringing at 0.7, so vision confirms before answering.
 * @param {object} window a window that appeared since the last poll
 * @param {{screenArea?:number, inMeeting?:boolean}} [opts]
 */
function matchNewWindow(window, { screenArea = 0, inMeeting = false } = {}) {
  if (!window || excludedKind(window)) return null;
  const split = splitBrowserTitle(window.title, window.app);
  if (split.browser) return null;
  const app = APPS.find((a) => a.newWindow && a.processRe && (a.processRe.test(String(window.app || '')) || a.processRe.test(String(window.process || ''))));
  if (!app || (app.id === 'zoom' && inMeeting)) return null;
  const area = Math.max(0, Number(window.width) || 0) * Math.max(0, Number(window.height) || 0);
  if (!area || (screenArea > 0 && area / screenArea > app.newWindow.maxAreaFrac)) return null;
  const caller = extractCaller(split.tab);
  return { app: app.id, kind: 'ringing', confidence: app.newWindow.confidence, source: 'new_window', browser: null, tab: split.tab, ...(caller ? { caller } : {}) };
}

/**
 * Match an OS notification {app, summary, body, origin, hints}.
 * Chromium puts the page origin first in the body ("cliq.zoho.com\n\nIncoming audio call") and the
 * page's notification title in summary (often the caller's name).
 * @param {{app?:string, summary?:string, body?:string, origin?:string, desktopEntry?:string}} n
 * @param {{learned?:object[]}} [opts]
 * @returns {{app:string|null, kind:'ringing', caller?:string, confidence:number, source:'notification', origin:string|null}|null}
 */
function matchNotification(n, { learned = [] } = {}) {
  if (!n || typeof n !== 'object') return null;
  const summary = normalizeTitle(n.summary);
  const body = normalizeTitle(n.body);
  const origin = hostOf(n.origin) || null;
  const text = `${summary}\n${body}`;
  const base = { source: 'notification', origin };
  if (/^Claude Anywhere\b/i.test(normalizeTitle(n.app)) || /^Claude Anywhere\b/i.test(summary)) return null;
  for (const sig of learned || []) {
    if (!sig._notifRe) continue;
    if (sig.origin && origin && sig.origin !== origin) continue;
    const m = sig._notifRe.exec(summary) || sig._notifRe.exec(body) || sig._notifRe.exec(text);
    if (m) {
      const caller = namedCaller(m) || callerFromNotification(summary, body);
      return { app: sig.app, kind: 'ringing', confidence: CONFIDENCE.learned, ...base, ...(caller ? { caller } : {}), learned: sig };
    }
  }
  // The app: by the page's origin, else the notifying app's name or desktop entry, else the text.
  const appName = normalizeTitle(n.app);
  const entry = String(n.desktopEntry || '');
  const byName = APPS.find((a) => a.notifAppRe.test(appName) || (entry && a.notifAppRe.test(entry)));
  const byText = APPS.find((a) => a.titleRe.test(summary) || a.titleRe.test(body));
  const appId = appFromOrigin(origin) || (byName && byName.id) || (byText && byText.id) || null;
  const app = appId ? appById(appId) : null;
  const ringing = app ? app.ringing.some((re) => re.test(summary) || re.test(body)) : GENERIC_RINGING_RE.test(summary) || GENERIC_RINGING_RE.test(body);
  if (!ringing) return null;
  const caller = callerFromNotification(summary, body);
  const strong = STRONG_RINGING_RE.test(summary) || STRONG_RINGING_RE.test(body);
  const confidence = app ? CONFIDENCE.known : strong ? CONFIDENCE.generic : CONFIDENCE.titleChange;
  return { app: appId, kind: 'ringing', confidence, ...base, ...(caller ? { caller } : {}) };
}

function callerFromNotification(summary, body) {
  // "Ankit Sharma" / "Incoming audio call": the page's title is the caller.
  if (summary && !GENERIC_RINGING_RE.test(summary)) {
    const own = extractCaller(body);
    return own || cleanCallerName(summary.split(SEP_SPLIT_RE)[0]);
  }
  return extractCaller(summary) || extractCaller(body);
}

module.exports = {
  CONFIDENCE,
  RING_THRESHOLD,
  BROWSER_SUFFIXES,
  APPS,
  APP_IDS,
  GENERIC_RINGING_RE,
  GENERIC_IN_CALL_RE,
  normalizeTitle,
  splitBrowserTitle,
  appById,
  appFromText,
  appFromOrigin,
  appOfWindow,
  hostOf,
  cleanCallerName,
  extractCaller,
  excludedKind,
  matchTitle,
  matchNewWindow,
  matchNotification,
  compileSignature,
  textPattern,
  learnedAcceptPoint,
  relativePoint,
  loadLearned,
  saveLearned,
  learnedFile,
};
