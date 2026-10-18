'use strict';

/**
 * Call notes on the user's Desktop (docs/CALLS-DESIGN.md §8).
 *
 *   <Desktop>/Claude Call Notes/2026-10-18 14-05 Ankit (Zoho Cliq).md
 *
 * Where the Desktop is (§8.1):
 *   Windows  the PS host's [Environment]::GetFolderPath('Desktop') through driver.desktopPath()
 *            (follows OneDrive Known Folder Move and GPO redirection); without a driver a one-shot
 *            powershell.exe, then `reg query` of User Shell Folders (expanding %VARS%), then
 *            %OneDrive%\Desktop, then %USERPROFILE%\Desktop.
 *   WSL      the same on the Windows side (driver.desktopPath().wslPath, or powershell.exe and
 *            `wslpath -u`).
 *   Linux    XDG_DESKTOP_DIR in ${XDG_CONFIG_HOME:-~/.config}/user-dirs.dirs (or `xdg-user-dir
 *            DESKTOP`); when it is missing, does not exist or is $HOME itself: ~/Desktop when it
 *            exists, else the notes go to ~/Claude Call Notes.
 *   macOS    ~/Desktop. Writing there can raise the TCC "Desktop folder" prompt; on EPERM the
 *            notes go to <state>/calls/notes/ and the result says so (fallback 'tcc').
 * calls.notesDir overrides the folder.
 *
 * Content (§8.3): "Actions taken" comes from the daemon's action log, never from the model's own
 * claims; the summary and follow-ups come from the call engine's final JSON turn and, when that
 * failed, from the transcript only (no model involved).
 *
 * Privacy: notes are plain text only (never audio, never the voice profile), 0600 in a 0700
 * folder on POSIX, likely secrets in the text are masked, caller speech is rendered as inert text
 * (no HTML, no line breaks that could forge headings), and when the caller objected to the
 * transcription (or calls.saveTranscript is off) no transcript is written. Desktops synced by
 * OneDrive or iCloud upload the notes: resolveDesktop() reports `synced` so setup screens can say so.
 */

const fsMod = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../shared/proc');
const paths = require('../shared/paths');
const platformMod = require('../shared/platform');
const { redact } = require('../shared/log');

const FOLDER_NAME = 'Claude Call Notes';
const MISSED_FILE = 'Missed calls.md';
const MAX_NAME = 120;
const MAX_CALLER_IN_NAME = 40;
const MAX_APP_IN_NAME = 30;
const MAX_COLLISIONS = 999;
const MAX_TRANSCRIPT_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_SUMMARY_CHARS = 4000;
const MAX_LIST_ITEMS = 30;
const MAX_ITEM_CHARS = 600;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 8000;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Windows reserved device names (with or without an extension). */
const RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// eslint-disable-next-line no-control-regex
const BAD_NAME_CHARS_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Tools that only read: never listed under "Actions taken". */
const READ_ONLY = new Set(['call_context', 'call_find_unassigned_tickets', 'call_ticket_brief']);
/** Records shown elsewhere (follow-ups, notes, the Ended row) or not at all. */
const SKIP_ACTIONS = new Set(['call_defer', 'defer', 'call_note', 'note', 'call_end', 'end', 'call_permission']);

const APP_NAMES = {
  'zoho-cliq': 'Zoho Cliq',
  'google-meet': 'Google Meet',
  teams: 'Microsoft Teams',
  slack: 'Slack',
  zoom: 'Zoom',
};

// ---------------------------------------------------------------- small helpers

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDate(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v);
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/** 'HH:mm' or 'HH:mm:ss' in local time. */
function clock(d, seconds = false) {
  if (!d) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${seconds ? `:${pad2(d.getSeconds())}` : ''}`;
}

/** "3 min 52 s", "45 s", "1 h 2 min". */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  if (m) return `${m} min${s ? ` ${s} s` : ''}`;
  return `${s} s`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayLabel(d) {
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Sat 18 Oct 2026, 14:05–14:09 (3 min 52 s)" in local time. */
function formatWhen(start, end) {
  const a = toDate(start);
  const b = toDate(end);
  if (!a) return 'unknown';
  if (!b || b < a) return `${dayLabel(a)}, ${clock(a)}`;
  const span = sameDay(a, b) ? `${clock(a)}–${clock(b)}` : `${clock(a)} – ${dayLabel(b)}, ${clock(b)}`;
  return `${dayLabel(a)}, ${span} (${formatDuration(b - a)})`;
}

/**
 * Untrusted text (caller speech, model output, Jira summaries) as inert Markdown inline text: likely
 * secrets masked, control and bidi characters removed, line breaks folded (no forged headings or
 * list items), HTML tags neutralized (< and > as entities), length capped.
 */
function inlineText(value, max = MAX_LINE_CHARS) {
  let s = value == null ? '' : String(value);
  s = redact(s);
  s = s.replace(/\r\n?|\n|\t/g, ' ').replace(CONTROL_RE, '');
  s = s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/\s{2,}/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return s;
}

/** inlineText for a table cell (pipes escaped). */
function cellText(value, max = 300) {
  return inlineText(value, max).replace(/\|/g, '\\|');
}

/** Quoted text inside an action line ("…"): inline text without straight double quotes. */
function quoted(value, max = 500) {
  return `"${inlineText(value, max).replace(/"/g, '”')}"`;
}

function firstNameOf(name) {
  const s = inlineText(name, 200).replace(/[,;]+/g, ' ').trim();
  if (!s) return '';
  const tok = s.split(/\s+/).find((t) => /\p{L}/u.test(t));
  return tok || '';
}

/** Display name of an app id ('zoho-cliq' → 'Zoho Cliq'); free text is kept (sanitized). */
function appName(app) {
  if (app && typeof app === 'object') return appName(app.name || app.id);
  const s = String(app == null ? '' : app).trim();
  if (!s) return '';
  if (APP_NAMES[s]) return APP_NAMES[s];
  let id = null;
  try {
    id = require('./signatures').appFromText(s);
  } catch {
    id = null; // signatures unavailable: keep the text
  }
  return id && APP_NAMES[id] ? APP_NAMES[id] : inlineText(s, 60);
}

/**
 * The caller of a call record: call.caller may be a display name or {displayName, name, jira:{email,
 * displayName, accountId}}; call.callerAccount (CallManager), call.callerJira and call.jira are accepted too.
 * @returns {{display:string, first:string, jiraEmail:string, jiraName:string, bound:boolean}}
 */
function callerInfo(call = {}) {
  const c = call.caller;
  const display = typeof c === 'string' ? c : c && typeof c === 'object' ? c.displayName || c.name || '' : call.callerName || '';
  const jira = (c && typeof c === 'object' && (c.jira || c.jiraAccount || c.account)) || call.callerAccount || call.callerJira || call.jira || null;
  const jiraEmail = jira && typeof jira === 'object' ? String(jira.email || jira.emailAddress || '') : '';
  const jiraName = jira && typeof jira === 'object' ? String(jira.displayName || '') : typeof jira === 'string' ? jira : '';
  const clean = inlineText(display, 80);
  return { display: clean, first: firstNameOf(clean), jiraEmail, jiraName, bound: Boolean(jira && (jira.accountId || jiraEmail || jiraName)) };
}

function ownerInfo(call = {}) {
  const o = call.owner;
  const name = typeof o === 'string' ? o : o && typeof o === 'object' ? o.name || o.displayName || '' : call.ownerName || '';
  const first = (o && typeof o === 'object' && o.first) || call.ownerFirst || firstNameOf(name);
  return { name: inlineText(name, 80), first: inlineText(first, 40) };
}

// ---------------------------------------------------------------- file names (§8.2)

/**
 * One file-name component made safe on every OS: `<>:"/\|?*` and control characters become '-',
 * whitespace collapses, trailing dots and spaces go, Windows reserved names get a '_'.
 * @param {string} name
 * @param {number} [max=MAX_NAME]
 * @param {{reserved?:boolean}} [opts] reserved:false for a part of a longer name (no '_' added)
 */
function sanitizeFileName(name, max = MAX_NAME, { reserved = true } = {}) {
  let s = String(name == null ? '' : name).normalize('NFC');
  s = s.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  s = s.replace(BAD_NAME_CHARS_RE, '-');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/, '');
  if (s.length > max) s = s.slice(0, max).replace(/[. ]+$/, '');
  const dot = s.indexOf('.');
  const base = dot >= 0 ? s.slice(0, dot) : s;
  if (reserved && RESERVED_RE.test(base.trim())) s = `${base.trim()}_${dot >= 0 ? s.slice(dot) : ''}`;
  return s;
}

/**
 * `YYYY-MM-DD HH-mm <Caller> (<App>).md` in local time, e.g. "2026-10-18 14-05 Ankit (Zoho Cliq).md".
 * <Caller> is the first name, or "Unknown caller".
 * @param {{date?:Date|number|string, caller?:string|object, app?:string}} o
 */
function noteFileName({ date, caller, app } = {}) {
  const d = toDate(date) || new Date();
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
  const who = callerInfo({ caller }).first || 'Unknown caller';
  const whoSafe = sanitizeFileName(who, MAX_CALLER_IN_NAME, { reserved: false }) || 'Unknown caller';
  const appSafe = sanitizeFileName(appName(app), MAX_APP_IN_NAME, { reserved: false });
  const stem = sanitizeFileName(`${stamp} ${whoSafe}${appSafe ? ` (${appSafe})` : ''}`, MAX_NAME - 3);
  return `${stem}.md`;
}

/** The n-th collision variant: "x.md" → "x (2).md", kept within MAX_NAME characters. */
function collisionName(name, n) {
  if (n <= 1) return name;
  const ext = path.extname(name);
  const suffix = ` (${n})`;
  let stem = name.slice(0, name.length - ext.length);
  const room = MAX_NAME - ext.length - suffix.length;
  if (stem.length > room) stem = stem.slice(0, room).replace(/[. ]+$/, '');
  return `${stem}${suffix}${ext}`;
}

// ---------------------------------------------------------------- Desktop (§8.1)

/** Parse user-dirs.dirs text: XDG_DESKTOP_DIR="$HOME/Desktop" → '/home/u/Desktop' (null when absent). */
function parseUserDirs(text, home, key = 'XDG_DESKTOP_DIR') {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  let value = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    const m = re.exec(raw);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    v = v.replace(/\\(.)/g, '$1');
    value = v; // the last assignment wins, as in a shell
  }
  if (value == null) return null;
  const h = String(home || '').replace(/\/+$/, '');
  const expanded = value.replace(/^\$\{HOME\}|^\$HOME(?![A-Za-z0-9_])/, h);
  if (!expanded || /\$/.test(expanded) || !path.posix.isAbsolute(expanded)) return null;
  return path.posix.normalize(expanded).replace(/\/+$/, '') || '/';
}

/** Expand %VAR% from env (case-insensitive names); unknown variables stay as they are. */
function expandWinVars(s, env = process.env) {
  const lower = {};
  for (const [k, v] of Object.entries(env || {})) lower[k.toLowerCase()] = v;
  return String(s || '').replace(/%([^%\\/]+)%/g, (m, name) => (lower[name.toLowerCase()] != null ? lower[name.toLowerCase()] : m));
}

/**
 * The Desktop value from `reg query "HKCU\...\User Shell Folders" /v Desktop` output, %VARS% expanded.
 * @returns {string|null}
 */
function parseRegQuery(text, env = process.env) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
    if (m) return expandWinVars(m[1], env);
  }
  return null;
}

function isDir(fs, p) {
  try {
    return Boolean(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function samePath(a, b, win) {
  const n = (p) => {
    const s = String(p || '').replace(/[\\/]+$/, '');
    return win ? s.replace(/\//g, '\\').toLowerCase() : s;
  };
  return n(a) === n(b);
}

/** 'onedrive' | 'icloud' | null: whether a Desktop folder is synced to the cloud. */
function syncedBy(dir, { env = process.env, platform = process.platform, fs = fsMod, home = os.homedir() } = {}) {
  if (!dir) return null;
  const s = String(dir).replace(/\\/g, '/').toLowerCase();
  const roots = [env.OneDrive, env.OneDriveCommercial, env.OneDriveConsumer].filter(Boolean).map((r) => String(r).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, ''));
  if (/\/onedrive(?:[ -][^/]*)?\//.test(`${s}/`) || roots.some((r) => s === r || s.startsWith(`${r}/`))) return 'onedrive';
  if (platform === 'darwin') {
    if (s.includes('/library/mobile documents/com~apple~clouddocs/')) return 'icloud';
    // "Desktop & Documents Folders" in iCloud Drive: ~/Desktop is backed by iCloud.
    if (isDir(fs, path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Desktop'))) return 'icloud';
  }
  return null;
}

async function runQuiet(runner, cmd, args, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const r = await runner(cmd, args, { timeoutMs });
    return r && r.code === 0 ? String(r.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

/** driver.desktopPath() / psHost (the Win32 driver, or its PS host) 'desktopPath': {path, exists, registry, oneDrive, userProfile, wslPath?}. */
async function hostDesktopRecord({ driver, psHost }) {
  try {
    if (driver && typeof driver.desktopPath === 'function') return (await driver.desktopPath()) || null;
    if (psHost && typeof psHost.desktopPath === 'function') return (await psHost.desktopPath()) || null; // the Win32 driver
    if (psHost && typeof psHost.request === 'function') return (await psHost.request('desktopPath')) || null;
    if (typeof psHost === 'function') return (await psHost()) || null;
  } catch {
    /* the host is not available: fall back */
  }
  return null;
}

/** "C:\Users\x\Desktop" → "/mnt/c/Users/x/Desktop" (when wslpath is not available). */
function winToWslPath(winPath) {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(String(winPath || '').trim());
  if (!m) return null;
  const rest = m[2].replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

const PS_DESKTOP = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')";
const REG_ARGS = ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'];

/**
 * Find the user's Desktop folder (§8.1).
 * @param {{platformInfo?:{platform:string,isWSL?:boolean}, driver?:object, psHost?:object|Function,
 *   env?:object, fs?:object, homedir?:string, runner?:Function, which?:Function}} [opts]
 * @returns {Promise<{dir:string|null, source:string, exists:boolean, synced:'onedrive'|'icloud'|null}>}
 *   dir null: Linux without a Desktop folder (the notes then go to ~/Claude Call Notes)
 */
async function resolveDesktop(opts = {}) {
  const pinfo = opts.platformInfo || platformMod.info();
  const env = opts.env || process.env;
  const fs = opts.fs || fsMod;
  const runner = opts.runner || proc.run;
  const which = opts.which || proc.which;
  const plat = pinfo.platform;
  const home = opts.homedir || (plat === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  const out = (dir, source) => ({ dir, source, exists: isDir(fs, dir), synced: syncedBy(dir, { env, platform: plat, fs, home }) });

  if (plat === 'win32') {
    const rec = await hostDesktopRecord(opts);
    if (rec && rec.path && isDir(fs, rec.path)) return out(rec.path, 'known-folder');
    if (!rec) {
      const ps = which('powershell.exe') || which('powershell') || which('pwsh');
      if (ps) {
        const p = await runQuiet(runner, ps, ['-NoProfile', '-NonInteractive', '-Command', PS_DESKTOP]);
        if (p && isDir(fs, p)) return out(p, 'known-folder');
      }
    }
    const reg = rec && rec.registry ? rec.registry : parseRegQuery(await runQuiet(runner, which('reg.exe') || which('reg') || 'reg', REG_ARGS), env);
    if (reg && isDir(fs, reg)) return out(reg, 'registry');
    const oneDrive = (rec && rec.oneDrive) || env.OneDrive || env.OneDriveConsumer || env.OneDriveCommercial;
    if (oneDrive && isDir(fs, path.win32.join(oneDrive, 'Desktop'))) return out(path.win32.join(oneDrive, 'Desktop'), 'onedrive');
    const profile = (rec && rec.userProfile) || env.USERPROFILE || home;
    return out(path.win32.join(profile, 'Desktop'), 'userprofile');
  }

  if (pinfo.isWSL) {
    const rec = await hostDesktopRecord(opts);
    let winPath = rec && rec.path ? rec.path : '';
    let linuxPath = rec && rec.wslPath ? rec.wslPath : '';
    if (!winPath && !linuxPath) {
      const ps = which('powershell.exe') || '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
      winPath = await runQuiet(runner, ps, ['-NoProfile', '-NonInteractive', '-Command', PS_DESKTOP]);
    }
    if (winPath && !linuxPath) {
      const wslpath = which('wslpath');
      linuxPath = (wslpath && (await runQuiet(runner, wslpath, ['-u', winPath]))) || winToWslPath(winPath) || '';
    }
    if (linuxPath && isDir(fs, linuxPath)) return out(linuxPath, 'windows-desktop');
    // No Windows side (interop off): the Linux home of the distro.
  }

  if (plat === 'darwin') return out(path.join(home, 'Desktop'), 'home-desktop');

  // Linux (and WSL without interop)
  const cfgHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  let xdg = null;
  let source = 'user-dirs';
  try {
    xdg = parseUserDirs(fs.readFileSync(path.join(cfgHome, 'user-dirs.dirs'), 'utf8'), home);
  } catch {
    xdg = null;
  }
  if (!xdg) {
    const tool = which('xdg-user-dir');
    if (tool) {
      const p = await runQuiet(runner, tool, ['DESKTOP']);
      if (p && path.isAbsolute(p)) {
        xdg = p.replace(/\/+$/, '');
        source = 'xdg-user-dir';
      }
    }
  }
  if (xdg && !samePath(xdg, home, false) && isDir(fs, xdg)) return out(xdg, source);
  const fallback = path.join(home, 'Desktop');
  if (isDir(fs, fallback)) return out(fallback, 'home-desktop');
  return { dir: null, source: 'none', exists: false, synced: null };
}

/** @returns {Promise<string|null>} the Desktop path (resolveDesktop().dir) */
async function desktopDir(opts = {}) {
  return (await resolveDesktop(opts)).dir;
}

function expandHome(p, home) {
  const s = String(p || '').trim();
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return s;
}

/**
 * The notes folder: calls.notesDir, else <Desktop>/Claude Call Notes, else ~/Claude Call Notes.
 * @param {object} [opts] resolveDesktop options plus {config}
 * @returns {Promise<{dir:string, source:string, synced:'onedrive'|'icloud'|null, custom:boolean, desktop:string|null}>}
 */
async function notesFolder(opts = {}) {
  const pinfo = opts.platformInfo || platformMod.info();
  const env = opts.env || process.env;
  const home = opts.homedir || (pinfo.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  const calls = (opts.config && opts.config.calls) || {};
  if (typeof calls.notesDir === 'string' && calls.notesDir.trim()) {
    const dir = path.resolve(expandHome(calls.notesDir, home));
    return { dir, source: 'config', synced: syncedBy(dir, { env, platform: pinfo.platform, fs: opts.fs || fsMod, home }), custom: true, desktop: null };
  }
  const d = await resolveDesktop({ ...opts, platformInfo: pinfo, env, homedir: home });
  const pathMod = pinfo.platform === 'win32' ? path.win32 : path;
  if (d.dir) return { dir: pathMod.join(d.dir, FOLDER_NAME), source: d.source, synced: d.synced, custom: false, desktop: d.dir };
  return { dir: pathMod.join(home, FOLDER_NAME), source: 'home', synced: null, custom: false, desktop: null };
}

/** <state>/calls/notes: where notes go when the Desktop cannot be written (macOS TCC). */
function fallbackNotesDir() {
  return path.join(paths.callsDir(), 'notes');
}

// ---------------------------------------------------------------- rendering (§8.3)

function actionTime(a) {
  return clock(toDate(a && (a.ts || a.at || a.time)));
}

function argsOf(a) {
  return (a && typeof a.args === 'object' && a.args) || (a && typeof a.sanitizedArgs === 'object' && a.sanitizedArgs) || {};
}

function resultOf(a) {
  return (a && typeof a.result === 'object' && a.result) || {};
}

/** Text of one action line, from the daemon's own record (summary written by code, else derived). */
function describeAction(a, ctx) {
  const args = argsOf(a);
  const res = resultOf(a);
  if (typeof a.summary === 'string' && a.summary.trim()) {
    // Written by the daemon's code; may carry **KEY** emphasis, and quoted Jira text.
    return inlineText(a.summary, 700);
  }
  const key = inlineText(args.key || res.key || '', 40);
  const title = res.summary || res.title || args.title;
  switch (a.name) {
    case 'call_assign_ticket_to_caller':
      return `Assigned **${key || 'a ticket'}**${title ? ` ${quoted(title, 200)}` : ''} to ${ctx.caller.display || 'the caller'}`;
    case 'call_comment_on_ticket':
      return `Commented on **${key || 'a ticket'}**${args.text ? `: ${quoted(args.text, 500)}` : ''}`;
    case 'call_send_chat_to_caller':
    case 'chat_queued':
    case 'chat_sent':
    case 'cliq_message': {
      const who = ctx.caller.first || 'the caller';
      const via = ctx.app ? `${ctx.app} ` : '';
      return `Sent ${who} a ${via}message${args.text ? `: ${quoted(args.text, 500)}` : ''}`;
    }
    default:
      return inlineText(String(a.name || 'action').replace(/^call_/, '').replace(/_/g, ' '), 120);
  }
}

/** Marker after an action line: ✓ done, (queued), ✗ failed (why), refused (why). */
function actionMark(a) {
  const status = String(a.status || '').toLowerCase();
  const why = inlineText(a.error || a.reason || '', 200);
  if (a.allowed === false || status === 'refused' || status === 'denied') return { prefix: 'Refused: ', suffix: why ? ` (${why})` : '' };
  if (status === 'queued' || status === 'pending') return { prefix: '', suffix: ` (queued, not sent yet${why ? `: ${why}` : ''})` };
  if (a.ok === false || status === 'failed' || status === 'error') return { prefix: '', suffix: ` ✗${why ? ` (${why})` : ''}` };
  if (a.ok === true || status === 'done' || status === 'sent' || status === 'ok') return { prefix: '', suffix: ' ✓' };
  return { prefix: '', suffix: '' };
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = item.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * A summary written from the transcript alone (no model), for when the final engine turn failed.
 * Without a saved transcript (an objection, or calls.saveTranscript off) nothing the caller said is quoted.
 */
function fallbackSummary({ transcript = [], caller = {}, app, stopped = null }) {
  const who = caller.first || 'The caller';
  const where = app ? ` on ${app}` : '';
  if (stopped) return `${who} called${where}. No summary was written: the assistant could not summarize the call, and its transcript was not saved.`;
  const said = transcript.filter((t) => t && t.role === 'caller' && String(t.text || '').trim()).map((t) => inlineText(t.text, 240));
  if (!said.length) return `${who} called${where}; nothing the caller said was transcribed. (Written from the transcript only: the assistant could not summarize this call.)`;
  const picks = said.slice(0, 3).map((s) => `“${s.replace(/[“”]/g, '"')}”`);
  return `${who} called${where} and said: ${picks.join(' … ')}${said.length > 3 ? ' …' : ''} (Written from the transcript only: the assistant could not summarize this call.)`;
}

function endReasonText(reason, owner) {
  const r = String(reason || '').toLowerCase();
  if (!r) return '';
  if (/takeover|taken_over|took_over/.test(r)) return `${owner.first || 'You'} took over the call`;
  if (/caller|remote|hung_up_by_caller|ring_ended/.test(r)) return 'The caller hung up';
  if (/max|limit|timeout|duration/.test(r)) return 'The time limit for AI-answered calls was reached';
  if (/silence/.test(r)) return 'The line was silent, so the assistant said goodbye';
  if (/hangup|panel|user/.test(r)) return `${owner.first || 'You'} hung up from the panel`;
  if (/call_end|assistant|goodbye/.test(r)) return 'The assistant ended the call';
  if (/error|fail|crash/.test(r)) return 'The call ended because of an error';
  return inlineText(reason, 120);
}

/**
 * Why no transcript is written: 'objection' (the caller objected), 'config' (calls.saveTranscript is
 * off), 'off' (stopped, reason unknown), or null. CallSession.status() reports saveTranscript:false
 * for both; the config tells them apart.
 */
function transcriptStopped(call = {}, config = null) {
  if (call.transcriptStopped) return String(call.transcriptStopped);
  if (call.saveTranscript !== false && call.transcriptSaved !== false) return null;
  const calls = config && config.calls;
  if (!calls) return 'off';
  return calls.saveTranscript === false ? 'config' : 'objection';
}

/**
 * The Markdown of a call's notes (§8.3).
 * @param {{call?:object, transcript?:object[], actions?:object[], summary?:{summary?:string, followUps?:string[], topics?:string[]}|null,
 *   config?:object}} o
 *   call: {id, app, caller, owner|ownerName, startedAt, answeredAt?, endedAt, cloned, disclosureSpoken?, endReason?,
 *     takeoverAt?, saveTranscript?, transcriptStopped?: 'objection'|'config'}
 *   transcript: [{role:'caller'|'assistant'|'system', text, ts, interrupted?}]
 *   actions: the daemon's action log [{ts, name, ok?, allowed?, status?, summary?, args?, result?, error?, reason?}]
 * @returns {string}
 */
function renderNotes({ call = {}, transcript = [], actions = [], summary = null, config = null } = {}) {
  const caller = callerInfo(call);
  const owner = ownerInfo(call);
  const app = appName(call.app || call.appName);
  const start = toDate(call.answeredAt || call.startedAt || call.ts);
  const end = toDate(call.endedAt);
  const lines = [];
  const title = caller.display ? `Call with ${caller.display}` : 'Call with an unknown caller';
  lines.push(`# ${title}${app ? ` — ${app}` : ''}`, '');

  lines.push('| | |', '|---|---|');
  lines.push(`| When | ${cellText(formatWhen(start, end))} |`);
  let who = caller.display || 'Unknown caller';
  if (caller.jiraEmail) who += ` (Jira: ${caller.jiraEmail})`;
  else if (caller.jiraName && caller.jiraName !== caller.display) who += ` (Jira: ${caller.jiraName})`;
  else if (!caller.bound) who += ' (not matched to a Jira account)';
  lines.push(`| Caller | ${cellText(who)} |`);
  const voice = call.cloned ? 'cloned voice' : 'standard voice';
  const disclosure = call.disclosureSpoken === false ? 'the call ended before the AI disclosure finished' : 'disclosure given';
  const as = owner.first ? `as ${owner.first}'s AI assistant` : 'as your AI assistant';
  lines.push(`| Answered by | ${cellText(`Claude Anywhere, ${as} (${voice}; ${disclosure})`)} |`);
  const takeover = toDate(call.takeoverAt) || (call.tookOver && call.tookOver !== true ? toDate(call.tookOver) : null);
  const tookOver = Boolean(takeover || call.tookOver === true);
  if (tookOver) lines.push(`| Taken over | ${cellText(`${owner.first || 'You'} took over${takeover ? ` at ${clock(takeover)}` : ' the call'}; these notes cover the call up to then`)} |`);
  const ended = endReasonText(call.endReason || call.reason, owner);
  if (ended && !tookOver) lines.push(`| Ended | ${cellText(ended)} |`);
  if (call.simulated) lines.push('| Note | A simulated test call: nobody called |');
  lines.push('');

  // Summary: the call engine's final JSON turn, else the transcript alone (never quoted when the
  // transcript is not saved).
  const stopped = transcriptStopped(call, config);
  const sumText = summary && typeof summary.summary === 'string' && summary.summary.trim() ? inlineText(summary.summary, MAX_SUMMARY_CHARS) : fallbackSummary({ transcript, caller, app, stopped });
  lines.push('## Summary', sumText, '');

  // Actions taken: the daemon's action log only.
  const ctx = { caller, owner, app };
  const list = (Array.isArray(actions) ? actions : []).filter((a) => a && typeof a === 'object');
  const sentChat = list.some((a) => a.name === 'chat_sent' || a.name === 'cliq_message');
  const acts = list.filter((a) => !a.deferred && !READ_ONLY.has(a.name) && !SKIP_ACTIONS.has(a.name) && !(a.name === 'chat_queued' && sentChat));
  // In time order (the message sent after hang-up is logged last but may be listed between others).
  const at = (a) => {
    const d = toDate(a.ts || a.at || a.time);
    return d ? d.getTime() : null;
  };
  if (acts.every((a) => at(a) != null)) acts.sort((a, b) => at(a) - at(b));
  lines.push('## Actions taken');
  if (!acts.length) lines.push('- None.');
  for (const a of acts.slice(0, MAX_LIST_ITEMS * 2)) {
    const t = actionTime(a);
    const m = actionMark(a);
    lines.push(`- ${t ? `${t} ` : ''}${m.prefix}${describeAction(a, ctx)}${m.suffix}`);
  }
  lines.push('');

  // Follow-ups: deferred requests (action log) plus the summary's follow-ups.
  const deferred = (Array.isArray(actions) ? actions : [])
    .filter((a) => a && (a.name === 'call_defer' || a.name === 'defer' || a.deferred === true))
    .map((a) => {
      const args = argsOf(a);
      if (!args.request && a.summary) return inlineText(a.summary, 300); // written by the daemon
      const req = inlineText(args.request || '', 300);
      const det = inlineText(args.details || '', 300);
      return req ? `${caller.first || 'The caller'} asked: ${req}${det ? ` (${det})` : ''}` : '';
    });
  const fromSummary = summary && Array.isArray(summary.followUps) ? summary.followUps.map((f) => inlineText(f, MAX_ITEM_CHARS)) : [];
  const follow = dedupe([...deferred, ...fromSummary]).slice(0, MAX_LIST_ITEMS);
  lines.push('## Follow-ups for you');
  if (!follow.length) lines.push('- None.');
  for (const f of follow) lines.push(`- ${f}`);
  lines.push('');

  const notes = dedupe(
    [
      ...list.filter((a) => a.name === 'call_note' || a.name === 'note').map((a) => inlineText(argsOf(a).text || String(a.summary || '').replace(/^Note:\s*/i, ''), MAX_ITEM_CHARS)),
      ...(summary && Array.isArray(summary.notes) ? summary.notes.map((n) => inlineText(n, MAX_ITEM_CHARS)) : []),
    ].filter(Boolean),
  );
  if (notes.length) {
    lines.push('## Notes from the call');
    for (const n of notes.slice(0, MAX_LIST_ITEMS)) lines.push(`- ${n}`);
    lines.push('');
  }
  const topics = summary && Array.isArray(summary.topics) ? dedupe(summary.topics.map((t) => inlineText(t, 80))).slice(0, 12) : [];
  if (topics.length) lines.push(`Topics: ${topics.join(', ')}`, '');

  lines.push('## Transcript');
  if (stopped) {
    const why = { objection: 'the caller asked not to be transcribed', config: 'transcript saving is off (calls.saveTranscript)' }[stopped] || 'the transcript was turned off for this call';
    lines.push(`_Not saved: ${why}._`);
  } else {
    const rows = (Array.isArray(transcript) ? transcript : []).filter((t) => t && String(t.text || '').trim());
    if (!rows.length) lines.push('_Nothing was transcribed._');
    for (const t of rows.slice(0, MAX_TRANSCRIPT_LINES)) {
      const at = clock(toDate(t.ts), true);
      const text = inlineText(t.text);
      if (t.role === 'system') {
        lines.push(`*${at ? `${at} ` : ''}${text}*`, '');
        continue;
      }
      const speaker = t.role === 'assistant' ? 'Assistant' : caller.first || 'Caller';
      lines.push(`**${at ? `${at} ` : ''}${speaker}:** ${text}${t.interrupted ? ' [interrupted]' : ''}`, '');
    }
    if (rows.length > MAX_TRANSCRIPT_LINES) lines.push(`_(${rows.length - MAX_TRANSCRIPT_LINES} more lines were left out.)_`, '');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push('', '---', '_Written by Claude Anywhere on this computer. No audio is kept with these notes. Delete this file to remove them._', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- writing

function ensureFolder(fs, dir, posix) {
  let created;
  try {
    created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  if (posix && created) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
  }
  if (!isDir(fs, dir)) {
    const e = new Error(`${dir} is not a folder`);
    e.code = 'ENOTDIR';
    throw e;
  }
}

/** Create `name` (or "name (2)", ...) exclusively in dir and write the text (0600). @returns {string} the path */
function writeUnique(fs, dir, name, text, posix) {
  for (let n = 1; n <= MAX_COLLISIONS; n++) {
    const file = path.join(dir, collisionName(name, n));
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      fs.writeSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    if (posix) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best effort */
      }
    }
    return file;
  }
  const e = new Error(`Too many notes named like ${name}`);
  e.code = 'EEXIST';
  throw e;
}

/** Replace an existing note in place (re-render after the summary arrived): temp file + rename. */
function rewriteFile(fs, file, text, posix) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  if (posix) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
  return file;
}

function insideDir(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const PERMISSION_CODES = new Set(['EPERM', 'EACCES', 'EROFS']);

/**
 * Render and write a call's notes. Never throws for a Desktop that cannot be written: the notes
 * then go to <state>/calls/notes and `fallback` says why ('tcc' on macOS, 'permission', 'error').
 * @param {object} o renderNotes() input plus resolveDesktop()/notesFolder() options and
 *   {config, date?, file? (rewrite this earlier note in place), fallbackDir?, markdown? (pre-rendered)}
 * @returns {Promise<{path:string, dir:string, name:string, source:string, synced:string|null,
 *   fallback:null|'tcc'|'permission'|'error', reason:string|null, markdown:string}>}
 */
async function writeNoteFile(o = {}) {
  const fs = o.fs || fsMod;
  const pinfo = o.platformInfo || platformMod.info();
  const posix = pinfo.platform !== 'win32';
  const markdown = typeof o.markdown === 'string' ? o.markdown : renderNotes(o);
  const call = o.call || {};
  const name = noteFileName({ date: o.date || call.answeredAt || call.startedAt || Date.now(), caller: call.caller || call.callerName, app: call.app });
  const folder = await notesFolder({ ...o, platformInfo: pinfo });
  const result = { path: '', dir: folder.dir, name, source: folder.source, synced: folder.synced, fallback: null, reason: null, markdown };

  const tryWrite = (dir) => {
    ensureFolder(fs, dir, posix);
    if (o.file && insideDir(dir, o.file)) {
      try {
        if (fs.statSync(o.file).isFile()) return rewriteFile(fs, o.file, markdown, posix);
      } catch {
        /* gone: write a new one */
      }
    }
    return writeUnique(fs, dir, name, markdown, posix);
  };

  try {
    result.path = tryWrite(folder.dir);
    return result;
  } catch (err) {
    result.reason = `${err.code || 'ERROR'}: ${err.message}`;
    result.fallback = PERMISSION_CODES.has(err.code) ? (pinfo.platform === 'darwin' ? 'tcc' : 'permission') : 'error';
  }
  const fb = o.fallbackDir || fallbackNotesDir();
  result.dir = fb;
  result.source = 'fallback';
  result.synced = null;
  result.path = tryWrite(fb); // the state folder must be writable; a failure here is a real error
  return result;
}

/**
 * Render and write a call's notes (§10.2 contract).
 * @returns {Promise<string>} the file's path
 */
async function writeNotes(o = {}) {
  const r = await writeNoteFile(o);
  if (typeof o.onWritten === 'function') {
    try {
      o.onWritten(r);
    } catch {
      /* caller's problem */
    }
  }
  return r.path;
}

/**
 * Add a "missed call" line to <notes folder>/Missed calls.md (quiet hours, apps not allowed, a call
 * that could not be answered). Same fallback as writeNoteFile.
 * @param {object} o notesFolder() options plus {date, caller, app, reason}
 * @returns {Promise<{path:string, fallback:string|null}>}
 */
async function appendMissedCall(o = {}) {
  const fs = o.fs || fsMod;
  const pinfo = o.platformInfo || platformMod.info();
  const posix = pinfo.platform !== 'win32';
  const d = toDate(o.date) || new Date();
  const who = callerInfo({ caller: o.caller }).display || 'Unknown caller';
  const app = appName(o.app);
  const line = `- ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock(d)} ${who}${app ? ` (${app})` : ''}${o.reason ? ` — ${inlineText(o.reason, 200)}` : ''}\n`;
  const append = (dir) => {
    ensureFolder(fs, dir, posix);
    const file = path.join(dir, MISSED_FILE);
    let fresh = false;
    try {
      fs.statSync(file);
    } catch {
      fresh = true;
    }
    fs.appendFileSync(file, `${fresh ? '# Missed calls\n\nCalls Claude Anywhere did not answer for you.\n\n' : ''}${line}`, { mode: 0o600 });
    return file;
  };
  const folder = await notesFolder({ ...o, platformInfo: pinfo });
  try {
    return { path: append(folder.dir), fallback: null };
  } catch (err) {
    const fb = o.fallbackDir || fallbackNotesDir();
    return { path: append(fb), fallback: PERMISSION_CODES.has(err.code) ? (pinfo.platform === 'darwin' ? 'tcc' : 'permission') : 'error' };
  }
}

/**
 * The notes in a folder, newest first.
 * @returns {Array<{name:string, path:string, mtimeMs:number, size:number}>}
 */
function listNotes(dir, { limit = 20, fs = fsMod } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/\.md$/i.test(n)) continue;
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) out.push({ name: n, path: p, mtimeMs: st.mtimeMs, size: st.size, missed: n === MISSED_FILE });
    } catch {
      /* vanished */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return out.slice(0, Math.max(0, limit));
}

/**
 * Read one note for the dialog, only from inside the given folders (no path tricks, no symlinks out).
 * @param {string} file
 * @param {{dirs:string[], fs?:object, maxBytes?:number}} o
 * @returns {string}
 */
function readNote(file, { dirs = [], fs = fsMod, maxBytes = MAX_NOTE_BYTES } = {}) {
  const fail = (m, code) => Object.assign(new Error(m), { code });
  if (typeof file !== 'string' || !/\.md$/i.test(file)) throw fail('Not a notes file', 'BAD_PATH');
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    throw fail('The notes file was not found', 'ENOENT');
  }
  const ok = dirs.filter(Boolean).some((d) => {
    try {
      return insideDir(fs.realpathSync(d), real);
    } catch {
      return false;
    }
  });
  if (!ok) throw fail('That file is not in the call notes folder', 'BAD_PATH');
  const st = fs.statSync(real);
  if (!st.isFile()) throw fail('Not a file', 'BAD_PATH');
  if (st.size > maxBytes) throw fail('The notes file is too large to show', 'TOO_LARGE');
  return fs.readFileSync(real, 'utf8');
}

/**
 * The doctor row for notes (§5.6): where they go, whether that folder can be written (a temporary
 * file is created and removed; the notes folder itself is not created), cloud sync.
 * @returns {Promise<{id:string,label:string,status:'ok'|'warn'|'fail',detail:string,fix:string,notes:string[],critical:boolean}>}
 */
async function doctorRow(opts = {}) {
  const fs = opts.fs || fsMod;
  const pinfo = opts.platformInfo || platformMod.info();
  const row = { id: 'calls-notes', label: 'Call notes', status: 'ok', detail: '', fix: '', notes: [], critical: false };
  let folder;
  try {
    folder = await notesFolder({ ...opts, platformInfo: pinfo });
  } catch (err) {
    return { ...row, status: 'warn', detail: `cannot find the Desktop: ${err.message}`, fix: 'Set a folder: anywhere config set calls.notesDir /path/to/folder' };
  }
  // Probe the nearest existing folder: the notes folder, else its parent (the Desktop).
  let probeDir = folder.dir;
  if (!isDir(fs, probeDir)) probeDir = path.dirname(folder.dir);
  row.detail = folder.dir;
  if (!isDir(fs, probeDir)) {
    row.status = 'warn';
    row.notes.push(`${probeDir} does not exist yet; it is created with the first notes.`);
    return row;
  }
  const probe = path.join(probeDir, `.claude-anywhere-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok', { mode: 0o600, flag: 'wx' });
    fs.unlinkSync(probe);
  } catch (err) {
    try {
      fs.unlinkSync(probe);
    } catch {
      /* not created */
    }
    row.status = 'warn';
    row.detail = `${folder.dir}: cannot write (${err.code || err.message}); notes would go to ${fallbackNotesDirSafe()}`;
    row.fix =
      pinfo.platform === 'darwin'
        ? 'Allow the app that runs Claude Code to use the Desktop folder: System Settings › Privacy & Security › Files and Folders, or set calls.notesDir.'
        : 'Make the folder writable, or set another one: anywhere config set calls.notesDir /path/to/folder';
    return row;
  }
  if (folder.synced) row.notes.push(`Your Desktop is synced by ${folder.synced === 'onedrive' ? 'OneDrive' : 'iCloud'}: the notes are uploaded there too (set calls.notesDir to keep them local).`);
  if (folder.source === 'home') row.notes.push('No Desktop folder was found, so notes go to your home folder.');
  return row;
}

function fallbackNotesDirSafe() {
  try {
    return fallbackNotesDir();
  } catch {
    return '~/.claude-anywhere/calls/notes';
  }
}

module.exports = {
  FOLDER_NAME,
  MISSED_FILE,
  MAX_NAME,
  APP_NAMES,
  READ_ONLY,
  desktopDir,
  resolveDesktop,
  notesFolder,
  fallbackNotesDir,
  noteFileName,
  sanitizeFileName,
  collisionName,
  renderNotes,
  writeNotes,
  writeNoteFile,
  appendMissedCall,
  listNotes,
  readNote,
  doctorRow,
  parseUserDirs,
  parseRegQuery,
  expandWinVars,
  winToWslPath,
  syncedBy,
  formatWhen,
  formatDuration,
  inlineText,
  callerInfo,
  appName,
  fallbackSummary,
  transcriptStopped,
};
