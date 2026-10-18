'use strict';

/**
 * Installed applications: the catalog of this machine's apps (cached 5 minutes), fuzzy lookup with
 * everyday aliases ("vs code", "premiere", "terminal"), launch (then wait for the app's window and
 * focus it) and quit. Used by the desktop MCP tools (src/mcp/tools-desktop.js) and the CLI
 * (`anywhere desktop apps|launch|quit`). Only built-in OS facilities are used:
 *
 *   macOS    *.app bundles in /Applications, ~/Applications, /System/Applications (and their
 *            sub-folders), names plus bundle ids from Contents/Info.plist (XML parsed here, binary
 *            plists converted with `plutil -convert xml1`); launch with `open -a`; quit with
 *            NSRunningApplication terminate / forceTerminate (JXA, no Apple Events consent needed).
 *   Windows  Start Menu shortcuts (.lnk, parsed here: MS-SHLLINK) in ProgramData and AppData, plus
 *   (+WSL)   Get-StartApps for Store apps (WhatsApp, Spotify) through one-shot powershell.exe;
 *            launch a shortcut or `explorer shell:AppsFolder\<AUMID>`; quit with UI Automation
 *            WindowPattern.Close / CloseMainWindow, then taskkill (/F only with force).
 *   Linux    .desktop files (XDG_DATA_HOME, XDG_DATA_DIRS, flatpak and snap exports) honouring
 *            Hidden, NoDisplay, TryExec and OnlyShowIn/NotShowIn; launch with gtk-launch or the
 *            Exec line; quit with `wmctrl -c`, then SIGTERM (SIGKILL only with force).
 *
 *   async listApps({query?, limit?, refresh?}, deps?) -> {platform, total, apps: [App & {score?}], notes}
 *   async findApp(name, {refresh?}, deps?) -> {app, score, alternatives: App[]} | null
 *   matchApps(apps, query, {flavor?, limit?}) -> [{app, score}]       best first
 *   async launch(name, {args?, waitForWindow? = true, timeoutMs? = 20000, newInstance?, accessibility?,
 *                       driver?, focus? = true, signal?}, deps?) -> LaunchResult
 *   async quit(name, {force?, driver?, timeoutMs? = 8000}, deps?) -> QuitResult
 *   windowMatchesApp(window, app) -> boolean
 *
 * App: {name, id, kind: 'bundle'|'shortcut'|'store'|'startapp'|'desktop'|'exec', source, path?,
 *       bundleId?, execName?, wmClass?, desktopId?, exec?, target?, targetArgs?, workingDir?, winPath?,
 *       aumid?, folder?, terminal?, keywords: string[], altNames: string[]}
 *
 * deps (tests): {platform, isWSL, env, homedir, run, which, launch, openTarget, fs, kill, sleep, now, pid, uid,
 *   cache, isOwnWindow, ancestorPids, macAppDirs, linuxSystemDirs, plutil}
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../shared/proc');
const platformInfo = require('../shared/platform');
const { createLogger } = require('../shared/log');

const log = createLogger('apps');

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE = new Map();
const MATCH_MIN_SCORE = 40;
const POLL_MS = 300;
const EXISTING_GRACE_MS = 4000;
const PLUTIL_CONCURRENCY = 8;
const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const OWN_WINDOW_RE = /^Claude Anywhere\b/;

const common = () => require('./common');

// ---------------------------------------------------------------- small helpers

function appError(message, code, hint, extra) {
  const err = new Error(message);
  if (code) err.code = code;
  if (hint) err.hint = hint;
  if (extra) Object.assign(err, extra);
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortable(ms, signal, sleeper) {
  if (signal && signal.aborted) return Promise.reject(appError('The request was cancelled', 'ABORTED'));
  if (!signal) return sleeper(ms);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(appError('The request was cancelled', 'ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(sleeper(ms)).then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function defaultIsOwnWindow(w) {
  if (!w) return false;
  return OWN_WINDOW_RE.test(String(w.title || '')) || String(w.app || '') === 'Claude Anywhere';
}

function sameId(a, b) {
  if (a == null || b == null) return false;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  if (x === y) return true;
  const num = (s) => (/^0x[0-9a-f]+$/.test(s) ? parseInt(s, 16) : /^\d+$/.test(s) ? Number(s) : NaN);
  return !Number.isNaN(num(x)) && num(x) === num(y);
}

/** Run `fn` over `items` with at most `limit` at a time; results keep their order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- context

function defaultDeps() {
  return {
    env: process.env,
    homedir: () => os.homedir(),
    run: proc.run,
    which: proc.which,
    launch: (cmd, args, opts) => common().launchDetached(cmd, args, opts),
    fs,
    kill: (pid, sig) => process.kill(pid, sig),
    sleep,
    now: () => Date.now(),
    tmpdir: () => os.tmpdir(),
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    cache: CACHE,
    isOwnWindow: defaultIsOwnWindow,
  };
}

/**
 * The environment the functions run in; tests override any part.
 * @param {object} [overrides]
 */
function makeContext(overrides) {
  const ctx = { ...defaultDeps(), ...(overrides || {}) };
  if (!ctx.platform || ctx.isWSL == null) {
    const info = platformInfo.info();
    if (!ctx.platform) ctx.platform = info.platform;
    if (ctx.isWSL == null) ctx.isWSL = ctx.platform === 'linux' ? info.isWSL : false;
  }
  ctx.isWSL = Boolean(ctx.isWSL);
  ctx.flavor = ctx.platform === 'darwin' ? 'darwin' : ctx.platform === 'win32' ? 'win32' : ctx.isWSL ? 'wsl' : 'linux';
  const env = ctx.env || {};
  ctx.home = (ctx.platform === 'win32' ? env.USERPROFILE : env.HOME) || ctx.homedir();
  return ctx;
}

function exists(ctx, p) {
  try {
    return ctx.fs.existsSync(p);
  } catch {
    return false;
  }
}

function readText(ctx, p) {
  try {
    return ctx.fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function listDir(ctx, dir) {
  try {
    return ctx.fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isDirEntry(ctx, dir, ent) {
  if (ent.isDirectory()) return true;
  if (!ent.isSymbolicLink()) return false;
  try {
    return ctx.fs.statSync(path.join(dir, ent.name)).isDirectory();
  } catch {
    return false;
  }
}

function isFileEntry(ctx, dir, ent) {
  if (ent.isFile()) return true;
  if (!ent.isSymbolicLink()) return false;
  try {
    return ctx.fs.statSync(path.join(dir, ent.name)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- PowerShell (Windows and WSL)

const PS_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
].join('\n');

function powershellPath(ctx) {
  const env = ctx.env || {};
  if (env.ANYWHERE_PS_EXE) return env.ANYWHERE_PS_EXE;
  if (ctx.platform === 'win32') {
    const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
    const builtin = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return ctx.which('powershell.exe') || ctx.which('powershell') || (exists(ctx, builtin) ? builtin : null) || ctx.which('pwsh.exe');
  }
  return ctx.which('powershell.exe') || (exists(ctx, WSL_POWERSHELL) ? WSL_POWERSHELL : null) || ctx.which('pwsh.exe');
}

/** The last JSON object or array printed on its own line. */
function lastJson(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{') || lines[i].startsWith('[')) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * Run a one-shot Windows PowerShell 5.1 script (-EncodedCommand) and parse its last JSON line.
 * Values reach the script as base64 literals (psString), never interpolated as code.
 * @returns {Promise<{data:any, res:object}>}
 */
async function runPowerShell(ctx, script, { timeoutMs = 30000 } = {}) {
  const ps = powershellPath(ctx);
  if (!ps) {
    throw appError(
      'PowerShell (powershell.exe) was not found',
      'UNSUPPORTED',
      ctx.isWSL
        ? 'Enable WSL interop ([interop] enabled=true and appendWindowsPath=true in /etc/wsl.conf), then run wsl --shutdown.'
        : 'Windows PowerShell ships with Windows; make sure %SystemRoot%\\System32\\WindowsPowerShell\\v1.0 is on PATH.'
    );
  }
  const cwd = ctx.isWSL && exists(ctx, '/mnt/c') ? '/mnt/c' : undefined;
  const res = await ctx.run(ps, common().psArgs(`${PS_PRELUDE}\n${script}`), { timeoutMs, cwd });
  const stderr = typeof res.stderr === 'string' ? proc.psErrorText(res.stderr) : '';
  return { data: lastJson(res.stdout), res: { ...res, stderr } };
}

function psValue(v) {
  return common().psString(v == null ? '' : String(v));
}

// Start Menu folders, Windows environment and Get-StartApps (Store apps: WhatsApp, Spotify, ...).
const START_APPS_PS = `
$folders = [ordered]@{
  commonPrograms = [Environment]::GetFolderPath('CommonPrograms')
  programs = [Environment]::GetFolderPath('Programs')
  local = [Environment]::GetFolderPath('LocalApplicationData')
  roaming = [Environment]::GetFolderPath('ApplicationData')
}
$envVars = [ordered]@{}
foreach ($n in @('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'SystemRoot', 'windir', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'PUBLIC', 'SystemDrive')) {
  $v = [Environment]::GetEnvironmentVariable($n)
  if ($v) { $envVars[$n] = $v }
}
$apps = New-Object System.Collections.Generic.List[object]
$note = ''
if ($withApps -eq '1') {
  $cmd = Get-Command -Name Get-StartApps -ErrorAction SilentlyContinue
  if ($null -ne $cmd) {
    try {
      foreach ($a in @(Get-StartApps)) { $apps.Add([ordered]@{ n = [string]$a.Name; u = [string]$a.AppID }) }
    } catch { $note = 'Get-StartApps failed: ' + $_.Exception.Message }
  } else { $note = 'Get-StartApps is not available in this PowerShell' }
}
$out = [ordered]@{ folders = $folders; env = $envVars; apps = $apps.ToArray(); note = $note }
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 4))
`;

const WIN_FOLDERS_TTL_MS = 30 * 60 * 1000;
const winFoldersCache = new Map();

/**
 * Windows known folders (and environment) as this process can read them: on WSL converted to
 * Linux paths (/mnt/c/...). Cached for 30 minutes.
 * @returns {Promise<{local:string|null, roaming:string|null, commonPrograms:string|null, programs:string|null,
 *   winLocal?:string, winRoaming?:string, winCommonPrograms?:string, winPrograms?:string, env:object}>}
 */
async function windowsFolders(ctx, { withApps = false } = {}) {
  const env = ctx.env || {};
  if (ctx.platform === 'win32' && !withApps) {
    const local = env.LOCALAPPDATA || path.win32.join(ctx.home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.win32.join(ctx.home, 'AppData', 'Roaming');
    const programData = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
    const commonPrograms = path.win32.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const programs = path.win32.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    return { local, roaming, commonPrograms, programs, winLocal: local, winRoaming: roaming, winCommonPrograms: commonPrograms, winPrograms: programs, env: { ...env } };
  }
  const key = `${ctx.flavor}|${withApps ? 'apps' : 'folders'}`;
  const cached = winFoldersCache.get(key);
  if (!withApps && cached && ctx.now() - cached.at < WIN_FOLDERS_TTL_MS && ctx.cache === CACHE) return cached.value;
  const { data, res } = await runPowerShell(ctx, `$withApps = ${psValue(withApps ? '1' : '0')}\n${START_APPS_PS}`, { timeoutMs: withApps ? 45000 : 20000 });
  if (!data || typeof data !== 'object' || !data.folders) {
    throw appError(`Could not read the Windows folders: ${res.stderr.trim() || (res.timedOut ? 'PowerShell timed out' : `exit ${res.code}`)}`, 'PS_FAILED');
  }
  const f = data.folders || {};
  const conv = async (p) => (p ? (ctx.isWSL ? await toWslPath(ctx, p) : p) : null);
  const value = {
    local: await conv(f.local),
    roaming: await conv(f.roaming),
    commonPrograms: await conv(f.commonPrograms),
    programs: await conv(f.programs),
    winLocal: f.local || null,
    winRoaming: f.roaming || null,
    winCommonPrograms: f.commonPrograms || null,
    winPrograms: f.programs || null,
    env: data.env && typeof data.env === 'object' ? data.env : {},
    apps: Array.isArray(data.apps) ? data.apps : data.apps && typeof data.apps === 'object' ? [data.apps] : [],
    note: data.note || '',
  };
  if (!withApps && ctx.cache === CACHE) winFoldersCache.set(key, { at: ctx.now(), value });
  return value;
}

/** C:\Users\me -> /mnt/c/Users/me (wslpath -u when present, else the default mount). */
async function toWslPath(ctx, winPath) {
  const s = String(winPath || '').trim();
  if (!s) return null;
  const wslpath = ctx.which('wslpath');
  if (wslpath) {
    const r = await ctx.run(wslpath, ['-u', s], { timeoutMs: 5000 });
    const out = String(r.stdout || '').trim();
    if (r.code === 0 && out.startsWith('/')) return out;
  }
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(s);
  if (!m) return null;
  const rest = m[2].replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

// ---------------------------------------------------------------- names, aliases and matching

/** Lower case, no accents or punctuation, single spaces; "Notepad++" -> "notepad plus plus". */
function normalizeName(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.(?:app|exe|desktop|lnk)$/, '')
    .replace(/\+\+/g, ' plus plus ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function compact(s) {
  return normalizeName(s).replace(/ /g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const VS_CODE = ['visual studio code', 'code'];
const TEAMS = ['microsoft teams', 'teams', 'microsoft teams work or school', 'microsoft teams classic'];
const PREMIERE = ['adobe premiere pro', 'premiere pro'];
const RESOLVE = ['davinci resolve', 'resolve'];

/** Everyday names -> app names to look for, best first (normalized). */
const COMMON_ALIASES = {
  'vs code': VS_CODE,
  vscode: VS_CODE,
  code: VS_CODE,
  'visual studio code': VS_CODE,
  'vs code insiders': ['visual studio code insiders', 'code insiders'],
  brave: ['brave browser', 'brave', 'brave web browser'],
  'brave browser': ['brave browser', 'brave', 'brave web browser'],
  chrome: ['google chrome', 'chrome'],
  'google chrome': ['google chrome', 'chrome'],
  edge: ['microsoft edge'],
  'ms edge': ['microsoft edge'],
  firefox: ['firefox', 'mozilla firefox', 'firefox web browser'],
  figma: ['figma', 'figma desktop', 'figma linux'],
  whatsapp: ['whatsapp', 'whatsapp desktop'],
  'whats app': ['whatsapp', 'whatsapp desktop'],
  'davinci resolve': RESOLVE,
  davinci: RESOLVE,
  resolve: RESOLVE,
  premiere: PREMIERE,
  'premiere pro': PREMIERE,
  'adobe premiere': PREMIERE,
  'adobe premiere pro': PREMIERE,
  capcut: ['capcut'],
  shotcut: ['shotcut'],
  kdenlive: ['kdenlive'],
  obs: ['obs studio', 'obs'],
  'obs studio': ['obs studio', 'obs'],
  slack: ['slack'],
  zoom: ['zoom', 'zoom workplace', 'zoom us'],
  teams: TEAMS,
  'ms teams': TEAMS,
  'microsoft teams': TEAMS,
  spotify: ['spotify'],
  word: ['microsoft word', 'word'],
  excel: ['microsoft excel', 'excel'],
  powerpoint: ['microsoft powerpoint', 'powerpoint'],
  outlook: ['microsoft outlook', 'outlook', 'new outlook'],
  onenote: ['microsoft onenote', 'onenote'],
  photoshop: ['adobe photoshop'],
  illustrator: ['adobe illustrator'],
  'after effects': ['adobe after effects'],
  lightroom: ['adobe lightroom', 'adobe lightroom classic'],
  acrobat: ['adobe acrobat', 'adobe acrobat reader', 'adobe acrobat dc'],
  'final cut': ['final cut pro'],
  'final cut pro': ['final cut pro'],
  imovie: ['imovie'],
  vlc: ['vlc media player', 'vlc'],
  gimp: ['gnu image manipulation program', 'gimp'],
  blender: ['blender'],
  audacity: ['audacity'],
  handbrake: ['handbrake'],
  telegram: ['telegram desktop', 'telegram'],
  discord: ['discord'],
  signal: ['signal'],
  notion: ['notion'],
  postman: ['postman'],
  docker: ['docker desktop', 'docker'],
  intellij: ['intellij idea', 'intellij idea ultimate', 'intellij idea community edition', 'intellij idea ce'],
  pycharm: ['pycharm', 'pycharm professional', 'pycharm community edition', 'pycharm ce'],
  webstorm: ['webstorm'],
  'android studio': ['android studio'],
  sublime: ['sublime text'],
  'sublime text': ['sublime text'],
  calculator: ['calculator', 'gnome calculator', 'kcalc', 'galculator'],
  cursor: ['cursor'],
  windsurf: ['windsurf'],
  zed: ['zed'],
  obsidian: ['obsidian'],
};

const FILE_MANAGERS_LINUX = ['files', 'nautilus', 'dolphin', 'thunar', 'nemo', 'pcmanfm', 'caja'];
const PLATFORM_ALIASES = {
  darwin: {
    terminal: ['terminal', 'iterm', 'iterm2', 'warp', 'ghostty'],
    'file explorer': ['finder'],
    explorer: ['finder'],
    files: ['finder'],
    'file manager': ['finder'],
    settings: ['system settings', 'system preferences'],
    'system settings': ['system settings', 'system preferences'],
    'text editor': ['textedit'],
  },
  win32: {
    terminal: ['windows terminal', 'terminal', 'windows powershell', 'command prompt'],
    cmd: ['command prompt'],
    powershell: ['windows powershell', 'powershell 7', 'powershell'],
    'file explorer': ['file explorer'],
    explorer: ['file explorer'],
    files: ['file explorer'],
    'file manager': ['file explorer'],
    settings: ['settings'],
    'text editor': ['notepad'],
  },
  linux: {
    terminal: ['terminal', 'gnome terminal', 'console', 'ptyxis', 'konsole', 'xfce terminal', 'xfce4 terminal', 'mate terminal', 'lxterminal', 'tilix', 'terminator', 'alacritty', 'kitty', 'wezterm', 'xterm', 'uxterm'],
    'file explorer': FILE_MANAGERS_LINUX,
    explorer: FILE_MANAGERS_LINUX,
    files: FILE_MANAGERS_LINUX,
    'file manager': FILE_MANAGERS_LINUX,
    settings: ['settings', 'system settings', 'gnome control center'],
    'text editor': ['text editor', 'gedit', 'gnome text editor', 'kate', 'kwrite', 'mousepad', 'xed', 'pluma'],
  },
};

/** Apps built on Chromium/Electron: launch_app {accessibility: true} adds --force-renderer-accessibility. */
const CHROMIUM_APP_RE = /\b(?:google chrome|chrome|chromium|brave|microsoft edge|msedge|vivaldi|opera|arc|visual studio code|code|cursor|windsurf|slack|discord|whatsapp|figma|microsoft teams|teams|spotify|obsidian|notion|postman|signal|element|1password|bitwarden|github desktop|insomnia|zoom)\b/;

const HELPER_NAME_RE = /\b(?:uninstall|uninstaller|readme|release notes|documentation|manual|help|website|license|licence|changelog)\b/;

/**
 * The names a query stands for, best first: the query itself, then its aliases.
 * @param {string} query
 * @param {'darwin'|'win32'|'wsl'|'linux'} [flavor]
 * @returns {string[]} normalized
 */
function queryVariants(query, flavor = 'linux') {
  const q = normalizeName(query);
  if (!q) return [];
  const fl = flavor === 'wsl' ? 'win32' : flavor;
  const out = [q];
  const add = (list) => {
    for (const v of list || []) if (!out.includes(v)) out.push(v);
  };
  add((PLATFORM_ALIASES[fl] || {})[q]);
  add(COMMON_ALIASES[q]);
  const stripped = q.replace(/^(?:the|my)\s+/, '').replace(/\s+(?:app|application|desktop|desktop app)$/, '').trim();
  if (stripped && stripped !== q) {
    if (!out.includes(stripped)) out.push(stripped);
    add((PLATFORM_ALIASES[fl] || {})[stripped]);
    add(COMMON_ALIASES[stripped]);
  }
  return out;
}

/** How well one candidate string fits one query variant (0..100). */
function stringScore(q, s) {
  const n = normalizeName(s);
  if (!n || !q) return 0;
  if (n === q) return 100;
  const qc = q.replace(/ /g, '');
  const c = n.replace(/ /g, '');
  if (qc.length >= 3 && c === qc) return 99;
  if (n.startsWith(`${q} `)) return 85 - Math.min(10, (n.length - q.length) / 3);
  const words = n.split(' ');
  const qw = q.split(' ');
  if (qw.every((w) => words.some((x) => x.startsWith(w))) && qw.some((w) => words.includes(w))) return 72 - Math.min(10, words.length - qw.length);
  if (n.includes(q) || (qc.length >= 4 && c.includes(qc))) return 60 - Math.min(10, (n.length - q.length) / 4);
  if (qc.length >= 4 && c.length >= 4) {
    const d = levenshtein(qc, c);
    if (d === 1) return 55;
    if (d === 2 && qc.length >= 7) return 45;
  }
  return 0;
}

function idTail(s) {
  const t = String(s || '').replace(/\.desktop$/i, '');
  return t.includes('.') ? t.split('.').pop() : t;
}

/** Candidate strings of an app: primary name, secondary identifiers, weak keywords. */
function appStrings(app) {
  const secondary = [
    ...(app.altNames || []),
    app.execName,
    app.wmClass,
    app.desktopId ? app.desktopId.replace(/\.desktop$/i, '') : '',
    app.desktopId ? idTail(app.desktopId) : '',
    app.bundleId ? idTail(app.bundleId) : '',
    app.flatpak ? idTail(app.flatpak) : '',
  ].filter(Boolean);
  return { primary: app.name, secondary, keywords: (app.keywords || []).filter(Boolean) };
}

/**
 * Score one app against query variants (the query first, then its aliases).
 * @returns {number}
 */
function scoreApp(app, variants) {
  const { primary, secondary, keywords } = appStrings(app);
  let best = 0;
  variants.forEach((v, vi) => {
    const malus = vi === 0 ? 0 : 2 + vi;
    best = Math.max(best, stringScore(v, primary) - malus);
    for (const s of secondary) best = Math.max(best, Math.min(95, stringScore(v, s)) - malus);
    if (vi === 0) {
      for (const k of keywords) {
        const ks = stringScore(v, k);
        if (ks >= 99) best = Math.max(best, 50);
        else if (ks >= 72) best = Math.max(best, 42);
      }
    }
  });
  if (best > 0 && HELPER_NAME_RE.test(normalizeName(app.name)) && !variants.some((v) => HELPER_NAME_RE.test(v))) best -= 25;
  return best;
}

const KIND_RANK = { bundle: 0, desktop: 0, shortcut: 0, store: 1, startapp: 1, exec: 2 };

/**
 * Apps matching a query, best first.
 * @param {object[]} apps
 * @param {string} query
 * @param {{flavor?:string, limit?:number, minScore?:number}} [opts]
 * @returns {Array<{app:object, score:number}>}
 */
function matchApps(apps, query, { flavor = 'linux', limit = 20, minScore = 1 } = {}) {
  const variants = queryVariants(query, flavor);
  if (!variants.length) return [];
  const scored = [];
  for (const app of apps || []) {
    const score = Math.round(scoreApp(app, variants) * 10) / 10;
    if (score >= minScore) scored.push({ app, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (KIND_RANK[a.app.kind] || 0) - (KIND_RANK[b.app.kind] || 0) ||
      a.app.name.length - b.app.name.length ||
      a.app.name.localeCompare(b.app.name)
  );
  return limit > 0 ? scored.slice(0, limit) : scored;
}

// ---------------------------------------------------------------- property lists (XML)

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

/**
 * Parse an XML property list (what `plutil -convert xml1` prints, and most Info.plist files).
 * dict -> object, array -> array, string/date -> string, integer/real -> number, true/false ->
 * boolean, data -> Buffer.
 * @param {string} xml
 * @returns {any}
 */
function parsePlistXml(xml) {
  const s = String(xml == null ? '' : xml);
  const start = s.indexOf('<plist');
  if (start < 0) throw appError('Not an XML property list', 'PARSE');
  let i = s.indexOf('>', start) + 1;
  const tagRe = /<(\/?)([A-Za-z0-9_]+)\s*(\/?)>/y;

  function skip() {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i);
        i = end < 0 ? s.length : end + 3;
        continue;
      }
      return;
    }
  }
  function tag() {
    skip();
    tagRe.lastIndex = i;
    const m = tagRe.exec(s);
    if (!m) throw appError(`Unexpected plist content at ${i}`, 'PARSE');
    i = tagRe.lastIndex;
    return { close: m[1] === '/', name: m[2], empty: m[3] === '/' };
  }
  function text(name) {
    const end = s.indexOf(`</${name}>`, i);
    if (end < 0) throw appError(`Unclosed <${name}>`, 'PARSE');
    const raw = s.slice(i, end);
    i = end + name.length + 3;
    return raw;
  }
  function value(t) {
    switch (t.name) {
      case 'dict': {
        const obj = {};
        if (t.empty) return obj;
        for (;;) {
          const k = tag();
          if (k.close && k.name === 'dict') return obj;
          if (k.name !== 'key') throw appError(`Expected <key> in <dict>, got <${k.name}>`, 'PARSE');
          const key = k.empty ? '' : decodeEntities(text('key'));
          obj[key] = value(tag());
        }
      }
      case 'array': {
        const arr = [];
        if (t.empty) return arr;
        for (;;) {
          const v = tag();
          if (v.close && v.name === 'array') return arr;
          arr.push(value(v));
        }
      }
      case 'string':
      case 'date':
        return t.empty ? '' : decodeEntities(text(t.name));
      case 'integer':
      case 'real': {
        const n = Number(t.empty ? '0' : text(t.name).trim());
        return Number.isFinite(n) ? n : 0;
      }
      case 'true':
        if (!t.empty) text('true');
        return true;
      case 'false':
        if (!t.empty) text('false');
        return false;
      case 'data':
        return Buffer.from(t.empty ? '' : text('data').replace(/\s+/g, ''), 'base64');
      default:
        throw appError(`Unknown plist element <${t.name}>`, 'PARSE');
    }
  }
  const first = tag();
  if (first.close && first.name === 'plist') return null;
  return value(first);
}

/** Read any plist file: XML is parsed here, binary ones converted with plutil first. */
async function readPlist(ctx, file) {
  let buf;
  try {
    buf = ctx.fs.readFileSync(file);
  } catch {
    return null;
  }
  try {
    if (buf.length >= 6 && buf.slice(0, 6).toString('latin1') === 'bplist') {
      const plutil = ctx.plutil || 'plutil';
      const r = await ctx.run(plutil, ['-convert', 'xml1', '-o', '-', file], { timeoutMs: 8000 });
      if (r.code !== 0) return null;
      return parsePlistXml(r.stdout);
    }
    const textOf = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
    return parsePlistXml(textOf);
  } catch (err) {
    log.debug('plist parse failed', file, err && err.message);
    return null;
  }
}

// ---------------------------------------------------------------- Windows shell links (.lnk)

const LNK_CLSID = '0114020000000000c000000000000046';

function readAnsiZ(buf, at, end = buf.length) {
  if (at <= 0 || at >= end) return '';
  let j = at;
  while (j < end && buf[j] !== 0) j++;
  return buf.toString('latin1', at, j);
}

function readUtf16Z(buf, at, end = buf.length) {
  if (at <= 0 || at >= end) return '';
  let j = at;
  while (j + 1 < end && (buf[j] !== 0 || buf[j + 1] !== 0)) j += 2;
  return buf.toString('utf16le', at, j);
}

/**
 * Parse a Windows shell link (MS-SHLLINK): the target path (LinkInfo local or network path, else
 * the environment-variable block), arguments, working directory, description and icon.
 * @param {Buffer} buf
 * @returns {{target:string, args:string, workingDir:string, relativePath:string, description:string,
 *   iconLocation:string, envTarget:string, advertised:boolean, flags:number}}
 */
function parseLnk(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 76 || buf.readUInt32LE(0) !== 0x4c || buf.toString('hex', 4, 20) !== LNK_CLSID) {
    throw appError('Not a Windows shortcut (.lnk) file', 'PARSE');
  }
  try {
    const flags = buf.readUInt32LE(20);
    const unicode = (flags & 0x80) !== 0;
    const out = { target: '', args: '', workingDir: '', relativePath: '', description: '', iconLocation: '', envTarget: '', advertised: false, flags };
    let off = 76;
    if (flags & 0x1) off += 2 + buf.readUInt16LE(off); // LinkTargetIDList
    if (flags & 0x2) {
      // LinkInfo
      const start = off;
      const size = buf.readUInt32LE(start);
      const end = Math.min(buf.length, start + size);
      const headerSize = buf.readUInt32LE(start + 4);
      const liFlags = buf.readUInt32LE(start + 8);
      const localOff = buf.readUInt32LE(start + 16);
      const netOff = buf.readUInt32LE(start + 20);
      const suffixOff = buf.readUInt32LE(start + 24);
      const localUOff = headerSize >= 0x24 ? buf.readUInt32LE(start + 28) : 0;
      const suffixUOff = headerSize >= 0x24 ? buf.readUInt32LE(start + 32) : 0;
      let base = '';
      if (liFlags & 0x1) base = localUOff ? readUtf16Z(buf, start + localUOff, end) : readAnsiZ(buf, start + localOff, end);
      else if ((liFlags & 0x2) && netOff) {
        const n = start + netOff;
        const netNameOff = buf.readUInt32LE(n + 8);
        const netNameUOff = netNameOff > 0x14 ? buf.readUInt32LE(n + 20) : 0;
        base = netNameUOff ? readUtf16Z(buf, n + netNameUOff, end) : readAnsiZ(buf, n + netNameOff, end);
      }
      const suffix = suffixUOff ? readUtf16Z(buf, start + suffixUOff, end) : readAnsiZ(buf, start + suffixOff, end);
      if (base || suffix) out.target = base && suffix ? (/[\\/]$/.test(base) ? base + suffix : `${base}\\${suffix}`) : base + suffix;
      off = start + size;
    }
    const readString = () => {
      const count = buf.readUInt16LE(off);
      off += 2;
      const bytes = unicode ? count * 2 : count;
      if (off + bytes > buf.length) throw new RangeError('string past the end');
      const str = unicode ? buf.toString('utf16le', off, off + bytes) : buf.toString('latin1', off, off + bytes);
      off += bytes;
      return str;
    };
    if (flags & 0x4) out.description = readString();
    if (flags & 0x8) out.relativePath = readString();
    if (flags & 0x10) out.workingDir = readString();
    if (flags & 0x20) out.args = readString();
    if (flags & 0x40) out.iconLocation = readString();
    // ExtraData blocks
    while (off + 8 <= buf.length) {
      const size = buf.readUInt32LE(off);
      if (size < 8 || off + size > buf.length) break;
      const sig = buf.readUInt32LE(off + 4);
      if (sig === 0xa0000001 && size >= 0x314) {
        const ansi = readAnsiZ(buf, off + 8, off + 8 + 260);
        const wide = readUtf16Z(buf, off + 8 + 260, off + 8 + 260 + 520);
        out.envTarget = wide || ansi;
      } else if (sig === 0xa0000006) {
        out.advertised = true;
      }
      off += size;
    }
    if (!out.target && out.envTarget) out.target = out.envTarget;
    return out;
  } catch (err) {
    if (err && err.code === 'PARSE') throw err;
    throw appError(`Damaged shortcut: ${err && err.message}`, 'PARSE');
  }
}

/** Expand %VAR% with a Windows environment map (case-insensitive); unknown variables stay. */
function expandWinEnv(s, env = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(env || {})) lower[k.toLowerCase()] = v;
  return String(s || '').replace(/%([^%\\/]+)%/g, (m, name) => (lower[name.toLowerCase()] != null ? lower[name.toLowerCase()] : m));
}

function winBase(p) {
  return path.win32.basename(String(p || '')).replace(/\.exe$/i, '');
}

const SKIP_TARGET_EXT_RE = /\.(?:url|htm|html|chm|txt|pdf|rtf|md|hlp|ini|log|xml|website)$/i;
const UNINSTALL_RE = /\buninstall(?:er)?\b|^unins\d*$|^uninst/i;

// ---------------------------------------------------------------- catalogs

function macAppDirs(ctx) {
  if (Array.isArray(ctx.macAppDirs)) return ctx.macAppDirs;
  return [
    { dir: '/Applications', source: 'applications', depth: 2 },
    { dir: path.join(ctx.home, 'Applications'), source: 'user', depth: 2 },
    { dir: '/System/Applications', source: 'system', depth: 2 },
    { dir: '/System/Library/CoreServices/Applications', source: 'system', depth: 1 },
    { bundle: '/System/Library/CoreServices/Finder.app', source: 'system' },
  ];
}

function findBundles(ctx, dir, depth, out) {
  for (const ent of listDir(ctx, dir)) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (/\.app$/i.test(ent.name)) {
      if (isDirEntry(ctx, dir, ent)) out.push(full);
    } else if (depth > 1 && isDirEntry(ctx, dir, ent)) {
      findBundles(ctx, full, depth - 1, out);
    }
  }
  return out;
}

async function macCatalog(ctx) {
  const bundles = [];
  for (const d of macAppDirs(ctx)) {
    if (d.bundle) {
      if (exists(ctx, d.bundle)) bundles.push({ path: d.bundle, source: d.source });
      continue;
    }
    for (const p of findBundles(ctx, d.dir, d.depth || 1, [])) bundles.push({ path: p, source: d.source });
  }
  const infos = await pool(bundles, PLUTIL_CONCURRENCY, (b) => readPlist(ctx, path.join(b.path, 'Contents', 'Info.plist')));
  const seen = new Set();
  const apps = [];
  bundles.forEach((b, i) => {
    const info = infos[i] && typeof infos[i] === 'object' ? infos[i] : {};
    if (info.LSBackgroundOnly === true || info.LSBackgroundOnly === '1') return;
    const name = path.basename(b.path).replace(/\.app$/i, '');
    const bundleId = typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : '';
    const key = (bundleId || b.path).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const altNames = [info.CFBundleDisplayName, info.CFBundleName].filter((x) => typeof x === 'string' && x && x !== name);
    apps.push({
      name,
      id: `bundle:${bundleId || b.path}`,
      kind: 'bundle',
      source: b.source,
      path: b.path,
      bundleId: bundleId || undefined,
      execName: typeof info.CFBundleExecutable === 'string' ? info.CFBundleExecutable : undefined,
      altNames: [...new Set(altNames)],
      keywords: [],
    });
  });
  return { apps, notes: [] };
}

// --- Linux desktop entries

function unescapeDesktop(v) {
  return String(v).replace(/\\([sntr\\;])/g, (m, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\', ';': ';' })[c]);
}

function desktopList(v) {
  const out = [];
  let cur = '';
  const s = String(v || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      cur += s[i] + s[i + 1];
      i++;
    } else if (s[i] === ';') {
      if (cur.trim()) out.push(unescapeDesktop(cur.trim()));
      cur = '';
    } else cur += s[i];
  }
  if (cur.trim()) out.push(unescapeDesktop(cur.trim()));
  return out;
}

/**
 * Parse the [Desktop Entry] group of a .desktop file.
 * @param {string} text
 * @returns {{name:string, localizedNames:string[], genericName:string, comment:string, exec:string, tryExec:string,
 *   type:string, noDisplay:boolean, hidden:boolean, terminal:boolean, keywords:string[], categories:string[],
 *   wmClass:string, onlyShowIn:string[], notShowIn:string[], icon:string, flatpak:string}}
 */
function parseDesktopFile(text) {
  const e = {
    name: '', localizedNames: [], genericName: '', comment: '', exec: '', tryExec: '', type: '', noDisplay: false, hidden: false,
    terminal: false, keywords: [], categories: [], wmClass: '', onlyShowIn: [], notShowIn: [], icon: '', flatpak: '',
  };
  let inMain = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    if (l.startsWith('[')) {
      inMain = l === '[Desktop Entry]';
      continue;
    }
    if (!inMain) continue;
    const eq = l.indexOf('=');
    if (eq < 0) continue;
    const key = l.slice(0, eq).trim();
    const val = l.slice(eq + 1).trim();
    if (key === 'Name') e.name = unescapeDesktop(val);
    else if (/^Name\[[^\]]+\]$/.test(key)) e.localizedNames.push(unescapeDesktop(val));
    else if (key === 'GenericName') e.genericName = unescapeDesktop(val);
    else if (key === 'Comment') e.comment = unescapeDesktop(val);
    else if (key === 'Exec') e.exec = val;
    else if (key === 'TryExec') e.tryExec = unescapeDesktop(val);
    else if (key === 'Type') e.type = val;
    else if (key === 'NoDisplay') e.noDisplay = val.toLowerCase() === 'true';
    else if (key === 'Hidden') e.hidden = val.toLowerCase() === 'true';
    else if (key === 'Terminal') e.terminal = val.toLowerCase() === 'true';
    else if (key === 'Keywords') e.keywords = desktopList(val);
    else if (key === 'Categories') e.categories = desktopList(val);
    else if (key === 'StartupWMClass') e.wmClass = unescapeDesktop(val);
    else if (key === 'OnlyShowIn') e.onlyShowIn = desktopList(val);
    else if (key === 'NotShowIn') e.notShowIn = desktopList(val);
    else if (key === 'Icon') e.icon = unescapeDesktop(val);
    else if (key === 'X-Flatpak') e.flatpak = unescapeDesktop(val);
  }
  return e;
}

/** Split an Exec value into words (desktop entry quoting rules). */
function splitExec(exec) {
  const s = unescapeDesktop(String(exec || ''));
  const tokens = [];
  let cur = '';
  let started = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\' && i + 1 < s.length && '"`$\\'.includes(s[i + 1])) cur += s[++i];
      else if (ch === '"') quoted = false;
      else cur += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      started = true;
    } else if (ch === ' ' || ch === '\t') {
      if (started) tokens.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

/**
 * The argv of a desktop entry's Exec line with `args` in place of its field codes: %f/%u take the
 * first argument, %F/%U all of them, %c the name, %k the file, %i "--icon <Icon>"; deprecated codes
 * and flatpak's @@ markers are dropped. Without a file/URL field code the arguments are appended.
 * @param {string} exec
 * @param {string[]} [args]
 * @param {{name?:string, icon?:string, file?:string}} [entry]
 * @returns {string[]}
 */
function parseExecLine(exec, args = [], entry = {}) {
  const list = (args || []).map(String);
  const out = [];
  let used = false;
  for (const t of splitExec(exec)) {
    if (/^@@[uf]?$/.test(t)) continue;
    if (t === '%f' || t === '%u') {
      if (list.length) out.push(list[0]);
      used = true;
      continue;
    }
    if (t === '%F' || t === '%U') {
      out.push(...list);
      used = true;
      continue;
    }
    if (t === '%i') {
      if (entry.icon) out.push('--icon', entry.icon);
      continue;
    }
    if (/^%[dDnNvm]$/.test(t)) continue;
    const v = t.replace(/%([fFuUdDnNickvm%])/g, (m, c) => {
      if (c === '%') return '%';
      if (c === 'c') return entry.name || '';
      if (c === 'k') return entry.file || '';
      if ('fu'.includes(c)) {
        used = true;
        return list[0] || '';
      }
      if ('FU'.includes(c)) {
        used = true;
        return list.join(' ');
      }
      return '';
    });
    if (!v && t) continue;
    out.push(v);
  }
  if (!used && list.length) out.push(...list);
  return out;
}

/** The program an Exec line runs (skipping `env VAR=...`), and the flatpak or snap it runs. */
function execIdentity(exec) {
  const argv = splitExec(exec);
  let i = 0;
  if (argv[i] && path.posix.basename(argv[i]) === 'env') {
    i++;
    while (argv[i] && (argv[i].includes('=') || argv[i].startsWith('-'))) i++;
  }
  const prog = argv[i] ? path.posix.basename(argv[i]) : '';
  if (prog === 'flatpak' && argv[i + 1] === 'run') {
    const id = argv.slice(i + 2).find((a) => !a.startsWith('-') && !a.startsWith('@@') && !a.startsWith('%'));
    return { execName: id ? idTail(id).toLowerCase() : 'flatpak', flatpak: id || '' };
  }
  if (prog === 'snap' && argv[i + 1] === 'run') {
    const id = argv.slice(i + 2).find((a) => !a.startsWith('-'));
    return { execName: id ? id.split('.')[0] : 'snap', snap: id || '' };
  }
  return { execName: prog };
}

function linuxAppDirs(ctx) {
  const env = ctx.env || {};
  const dataHome = env.XDG_DATA_HOME || path.join(ctx.home, '.local', 'share');
  const dataDirs = String(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const sourceOf = (d) => (/flatpak/.test(d) ? 'flatpak' : /snapd/.test(d) ? 'snap' : 'system');
  const extra = Array.isArray(ctx.linuxSystemDirs) ? ctx.linuxSystemDirs : ['/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications'];
  const list = [
    { dir: path.join(dataHome, 'applications'), source: 'user' },
    ...dataDirs.map((d) => ({ dir: path.join(d, 'applications'), source: sourceOf(d) })),
    { dir: path.join(ctx.home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'), source: 'flatpak' },
    ...extra.map((d) => ({ dir: d, source: sourceOf(d) })),
  ];
  const seen = new Set();
  return list.filter((d) => {
    const k = path.resolve(d.dir);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function listDesktopFiles(ctx, dir, prefix, depth, out) {
  for (const ent of listDir(ctx, dir)) {
    const full = path.join(dir, ent.name);
    if (depth < 3 && isDirEntry(ctx, dir, ent)) listDesktopFiles(ctx, full, `${prefix}${ent.name}-`, depth + 1, out);
    else if (ent.name.endsWith('.desktop') && isFileEntry(ctx, dir, ent)) out.push({ id: `${prefix}${ent.name}`, file: full });
  }
  return out;
}

function tryExecFound(ctx, tryExec) {
  if (!tryExec) return true;
  if (tryExec.includes('/')) return exists(ctx, tryExec);
  return Boolean(ctx.which(tryExec));
}

function linuxCatalog(ctx) {
  const desktops = String((ctx.env || {}).XDG_CURRENT_DESKTOP || '')
    .split(':')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set();
  const apps = [];
  for (const { dir, source } of linuxAppDirs(ctx)) {
    for (const { id, file } of listDesktopFiles(ctx, dir, '', 0, [])) {
      if (seen.has(id)) continue; // a user entry shadows the system one, Hidden or not
      seen.add(id);
      const text = readText(ctx, file);
      if (text == null) continue;
      const e = parseDesktopFile(text);
      if (e.hidden || e.noDisplay || e.type !== 'Application' || !e.exec || !e.name) continue;
      if (desktops.length) {
        if (e.onlyShowIn.length && !e.onlyShowIn.some((d) => desktops.includes(d.toLowerCase()))) continue;
        if (e.notShowIn.some((d) => desktops.includes(d.toLowerCase()))) continue;
      }
      if (!tryExecFound(ctx, e.tryExec)) continue;
      const ident = execIdentity(e.exec);
      apps.push({
        name: e.name,
        id: `desktop:${id}`,
        kind: 'desktop',
        source,
        desktopId: id,
        path: file,
        exec: e.exec,
        execName: ident.execName || undefined,
        flatpak: e.flatpak || ident.flatpak || undefined,
        wmClass: e.wmClass || undefined,
        terminal: e.terminal,
        icon: e.icon || undefined,
        altNames: [...new Set(e.localizedNames.filter((n) => n && n !== e.name))],
        keywords: [e.genericName, ...e.keywords].filter(Boolean),
        categories: e.categories,
      });
    }
  }
  return { apps, notes: [] };
}

// --- Windows Start menu and Store apps

function walkLnk(ctx, dir, depth, out, rel = '') {
  for (const ent of listDir(ctx, dir)) {
    const full = path.join(dir, ent.name);
    if (depth < 5 && isDirEntry(ctx, dir, ent)) walkLnk(ctx, full, depth + 1, out, rel ? `${rel}\\${ent.name}` : ent.name);
    else if (/\.lnk$/i.test(ent.name) && isFileEntry(ctx, dir, ent)) out.push({ file: full, name: ent.name.replace(/\.lnk$/i, ''), rel });
  }
  return out;
}

async function windowsCatalog(ctx) {
  const notes = [];
  let info = null;
  try {
    info = await windowsFolders(ctx, { withApps: true });
  } catch (err) {
    notes.push(`Store apps could not be listed (${err.message}).`);
    if (ctx.isWSL) return { apps: [], notes };
    info = await windowsFolders(ctx, { withApps: false });
  }
  if (info.note) notes.push(info.note);
  const winEnv = { ...(ctx.platform === 'win32' ? ctx.env : {}), ...(info.env || {}) };
  const roots = [
    { dir: info.programs, win: info.winPrograms, source: 'user' },
    { dir: info.commonPrograms, win: info.winCommonPrograms, source: 'common' },
  ].filter((r) => r.dir);
  const apps = [];
  const byName = new Map();
  const seen = new Set();
  for (const r of roots) {
    for (const f of walkLnk(ctx, r.dir, 0, [])) {
      let link;
      try {
        link = parseLnk(ctx.fs.readFileSync(f.file));
      } catch (err) {
        log.debug('skipping shortcut', f.file, err && err.message);
        continue;
      }
      const target = expandWinEnv(link.target, winEnv);
      const base = winBase(target);
      if (UNINSTALL_RE.test(f.name) || (base && UNINSTALL_RE.test(base)) || SKIP_TARGET_EXT_RE.test(target)) continue;
      const key = `${normalizeName(f.name)}|${target.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const winPath = r.win ? `${r.win}\\${f.rel ? `${f.rel}\\` : ''}${f.name}.lnk` : f.file;
      const app = {
        name: f.name,
        id: `lnk:${winPath}`,
        kind: 'shortcut',
        source: r.source,
        path: f.file,
        winPath,
        target: target || undefined,
        targetArgs: link.args || undefined,
        workingDir: expandWinEnv(link.workingDir, winEnv) || undefined,
        execName: base ? base.toLowerCase() : undefined,
        folder: f.rel || undefined,
        altNames: link.description && link.description !== f.name && link.description.length <= 60 ? [link.description] : [],
        keywords: [],
      };
      apps.push(app);
      const nk = normalizeName(f.name);
      if (!byName.has(nk)) byName.set(nk, app);
    }
  }
  for (const a of info.apps || []) {
    const name = String((a && a.n) || '').trim();
    const appId = String((a && a.u) || '').trim();
    if (!name || !appId || UNINSTALL_RE.test(name)) continue;
    const same = byName.get(normalizeName(name));
    if (same) {
      if (!same.aumid) same.aumid = appId;
      continue;
    }
    const exe = /\.exe$/i.test(appId) ? winBase(appId).toLowerCase() : undefined;
    const app = {
      name,
      id: `aumid:${appId}`,
      kind: appId.includes('!') ? 'store' : 'startapp',
      source: 'start',
      aumid: appId,
      execName: exe,
      altNames: [],
      keywords: [],
    };
    apps.push(app);
    byName.set(normalizeName(name), app);
  }
  return { apps, notes, winEnv };
}

/**
 * The installed-app catalog, cached for 5 minutes (refresh: true re-reads it).
 * @returns {Promise<{apps:object[], notes:string[], at:number}>}
 */
async function catalog(ctx, { refresh = false } = {}) {
  const env = ctx.env || {};
  const key = [ctx.flavor, ctx.home, env.XDG_DATA_HOME || '', env.XDG_DATA_DIRS || '', env.APPDATA || '', env.ProgramData || ''].join('|');
  const hit = ctx.cache && ctx.cache.get(key);
  if (hit && !refresh && ctx.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = (async () => {
    const built = ctx.flavor === 'darwin' ? await macCatalog(ctx) : ctx.flavor === 'linux' ? linuxCatalog(ctx) : await windowsCatalog(ctx);
    built.apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { ...built, at: ctx.now() };
  })();
  if (ctx.cache) {
    ctx.cache.set(key, { at: ctx.now(), promise });
    promise.catch(() => {
      if (ctx.cache.get(key) && ctx.cache.get(key).promise === promise) ctx.cache.delete(key);
    });
  }
  return promise;
}

function clearCache() {
  CACHE.clear();
  winFoldersCache.clear();
}

// ---------------------------------------------------------------- lookup

/**
 * List installed apps, or the best matches for `query`.
 * @param {{query?:string, limit?:number, refresh?:boolean}} [opts]
 * @param {object} [deps]
 */
async function listApps({ query, limit, refresh = false } = {}, deps) {
  const ctx = makeContext(deps);
  const cat = await catalog(ctx, { refresh });
  const q = String(query == null ? '' : query).trim();
  let apps;
  if (q) {
    apps = matchApps(cat.apps, q, { flavor: ctx.flavor, limit: limit || 20, minScore: MATCH_MIN_SCORE / 2 }).map(({ app, score }) => ({ ...app, score }));
  } else {
    apps = limit > 0 ? cat.apps.slice(0, limit) : cat.apps.slice();
  }
  return { platform: ctx.flavor, total: cat.apps.length, apps, notes: cat.notes || [], at: cat.at };
}

function execFallback(ctx, name) {
  if (ctx.flavor === 'win32' || ctx.flavor === 'wsl') return null;
  const raw = String(name).trim();
  if (!raw || /\s{2,}/.test(raw)) return null;
  const lower = raw.toLowerCase();
  const variants = [...new Set([raw, lower, lower.replace(/\s+/g, '-'), lower.replace(/\s+/g, '')])].filter((v) => v && !/\s/.test(v));
  for (const v of variants) {
    const p = v.includes('/') ? (exists(ctx, v) ? v : null) : ctx.which(v);
    if (p) return { name: raw, id: `exec:${p}`, kind: 'exec', source: 'path', path: p, execName: path.basename(p), altNames: [], keywords: [] };
  }
  return null;
}

/**
 * The installed app a name means: the best catalog match, else (macOS/Linux) a program on PATH.
 * @returns {Promise<{app:object, score:number, alternatives:object[]}|null>}
 */
async function findApp(name, { refresh = false } = {}, deps) {
  const ctx = makeContext(deps);
  return findAppIn(ctx, name, { refresh });
}

async function findAppIn(ctx, name, { refresh = false } = {}) {
  const q = String(name == null ? '' : name).trim();
  if (!q) throw appError('Which app? The name is empty', 'INVALID_INPUT');
  const cat = await catalog(ctx, { refresh });
  const ranked = matchApps(cat.apps, q, { flavor: ctx.flavor, limit: 6, minScore: 1 });
  const top = ranked[0];
  if (top && top.score >= MATCH_MIN_SCORE) {
    const alternatives = ranked.slice(1).filter((r) => r.score >= MATCH_MIN_SCORE && r.score >= top.score - 10).map((r) => r.app);
    return { app: top.app, score: top.score, alternatives, suggestions: [] };
  }
  const exec = execFallback(ctx, q);
  if (exec) return { app: exec, score: MATCH_MIN_SCORE, alternatives: [], suggestions: [] };
  return { app: null, score: 0, alternatives: [], suggestions: ranked.map((r) => r.app.name) };
}

// ---------------------------------------------------------------- windows of an app

function appIdentity(app) {
  const names = new Set();
  const exes = new Set();
  const addName = (s) => {
    const c = compact(s);
    if (c) names.add(c);
  };
  const addExe = (s) => {
    const c = compact(String(s || '').replace(/\.exe$/i, ''));
    if (c) exes.add(c);
  };
  addName(app.name);
  for (const n of app.altNames || []) addName(n);
  if (app.bundleId) addName(idTail(app.bundleId));
  if (app.desktopId) addName(idTail(app.desktopId));
  if (app.flatpak) addName(idTail(app.flatpak));
  addExe(app.execName);
  addExe(app.wmClass);
  if (app.target) addExe(winBase(app.target));
  return { names, exes, words: [app.name, ...(app.altNames || [])].map(normalizeName).filter((n) => n.length >= 4) };
}

/**
 * Whether a window (driver.listWindows entry) belongs to an app: its app name or process matches
 * the app's names, executable or window class.
 */
function windowMatchesApp(w, app) {
  if (!w || !app) return false;
  const id = app._identity || appIdentity(app);
  const wa = compact(w.app);
  const wp = compact(String(w.process || '').replace(/\.exe$/i, ''));
  if (wa && (id.names.has(wa) || id.exes.has(wa))) return true;
  if (wp && (id.exes.has(wp) || id.names.has(wp))) return true;
  const wn = normalizeName(w.app);
  if (wn.length >= 4) {
    for (const n of id.words) if (n === wn || wn.startsWith(`${n} `) || n.startsWith(`${wn} `)) return true;
  }
  return false;
}

/** A new window whose title names the app (UWP apps live in ApplicationFrameHost windows). */
function titleMentionsApp(w, app) {
  const t = compact(w && w.title);
  const n = compact(app && app.name);
  return Boolean(t && n && n.length >= 4 && t.includes(n));
}

function rankWindows(list) {
  return list
    .map((w, i) => ({ w, i }))
    .sort((a, b) => {
      const f = Number(Boolean(b.w.focused)) - Number(Boolean(a.w.focused));
      if (f) return f;
      const m = Number(Boolean(a.w.minimized)) - Number(Boolean(b.w.minimized));
      if (m) return m;
      const sa = Number.isInteger(a.w.stackIndex) ? a.w.stackIndex : Infinity;
      const sb = Number.isInteger(b.w.stackIndex) ? b.w.stackIndex : Infinity;
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.w);
}

async function listWindowsSafe(driver) {
  if (!driver || typeof driver.listWindows !== 'function') return [];
  try {
    return (await driver.listWindows()) || [];
  } catch (err) {
    if (err && err.code === 'UNSUPPORTED') return [];
    throw err;
  }
}

/** Open windows of an app, best first (focused, visible, frontmost). */
async function appWindows(driver, app, { isOwnWindow = defaultIsOwnWindow } = {}) {
  const wins = await listWindowsSafe(driver);
  return rankWindows(wins.filter((w) => !isOwnWindow(w) && windowMatchesApp(w, app)));
}

async function focusAndCheck(ctx, driver, w) {
  if (!driver || typeof driver.focusWindow !== 'function' || !w) return false;
  let ok = false;
  try {
    ok = Boolean(await driver.focusWindow(w.id));
  } catch (err) {
    log.debug('focus failed', err && err.message);
    return false;
  }
  return ok;
}

/**
 * Wait for a window of `app`: a new one (by pid, app name, or a title naming the app), or, after a
 * short grace period, one that was already open (single-instance apps just raise theirs).
 */
async function waitForAppWindow(ctx, driver, app, { before = [], pid, timeoutMs = 20000, signal } = {}) {
  const beforeIds = new Set(before.map((w) => String(w.id)));
  const start = ctx.now();
  const deadline = start + Math.max(0, timeoutMs);
  const graceAt = start + Math.min(timeoutMs, EXISTING_GRACE_MS);
  const own = ctx.isOwnWindow || defaultIsOwnWindow;
  for (;;) {
    const wins = (await listWindowsSafe(driver)).filter((w) => !own(w));
    const fresh = wins.filter((w) => !beforeIds.has(String(w.id)));
    const byPid = pid ? fresh.filter((w) => Number(w.pid) === Number(pid)) : [];
    const byApp = fresh.filter((w) => windowMatchesApp(w, app));
    const byTitle = fresh.filter((w) => titleMentionsApp(w, app));
    const hit = rankWindows(byPid)[0] || rankWindows(byApp)[0] || rankWindows(byTitle)[0];
    if (hit) return { window: hit, how: byPid.includes(hit) ? 'pid' : byApp.includes(hit) ? 'app' : 'title', waitedMs: ctx.now() - start };
    if (ctx.now() >= graceAt) {
      const old = rankWindows(wins.filter((w) => beforeIds.has(String(w.id)) && windowMatchesApp(w, app)));
      if (old.length) return { window: old[0], how: 'existing', waitedMs: ctx.now() - start };
    }
    if (ctx.now() >= deadline) return null;
    await abortable(POLL_MS, signal, ctx.sleep);
  }
}

// ---------------------------------------------------------------- launch

const MAC_CHROMIUM_BUNDLES = new Set([
  'com.google.chrome', 'com.google.chrome.beta', 'com.google.chrome.dev', 'com.google.chrome.canary', 'org.chromium.chromium',
  'com.microsoft.edgemac', 'com.microsoft.edgemac.beta', 'com.microsoft.edgemac.dev', 'com.brave.browser', 'com.brave.browser.beta',
  'com.brave.browser.nightly', 'com.vivaldi.vivaldi', 'com.operasoftware.opera',
]);

function isChromiumApp(app) {
  if (app.bundleId && MAC_CHROMIUM_BUNDLES.has(app.bundleId.toLowerCase())) return true;
  return CHROMIUM_APP_RE.test(normalizeName(app.name)) || CHROMIUM_APP_RE.test(normalizeName(app.execName || ''));
}

/**
 * macOS Chromium browsers: a second instance started with `open -n` hands its whole command line to
 * the running one, so flags and URLs reach the user's browser (other apps get documents as events).
 */
function isMacChromiumBrowser(app) {
  if (app.bundleId) return MAC_CHROMIUM_BUNDLES.has(app.bundleId.toLowerCase());
  return /^(?:google chrome(?: beta| dev| canary)?|chromium|brave browser(?: beta| nightly)?|microsoft edge(?: beta| dev| canary)?|vivaldi|opera)$/.test(normalizeName(app.name));
}

/** macOS: a URL or existing file is a document `open` hands to the app; anything else is an argument. */
function macArg(ctx, a) {
  if (!a || a.startsWith('-')) return { arg: a };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a) || /^mailto:/i.test(a)) return { doc: a };
  if (a.startsWith('/') && exists(ctx, a)) return { doc: a };
  return { arg: a };
}

/**
 * The command that starts an app (pure: no process is started).
 * @returns {{mode:'open'|'spawn'|'gtk-launch'|'ps'|'openTarget', cmd?:string, argv?:string[], env?:object,
 *   ps?:{mode:string, path?:string, aumid?:string, argLine?:string, wd?:string}, note?:string}}
 */
function launchPlan(ctx, app, args = [], { newInstance = false, accessibility = false } = {}) {
  const extra = accessibility && isChromiumApp(app) ? ['--force-renderer-accessibility'] : [];
  const all = [...extra, ...args.map(String)];
  const notes = [];
  if (ctx.flavor === 'darwin') {
    if (app.kind === 'exec') return { mode: 'spawn', cmd: app.path, argv: all };
    const parsed = all.map((a) => macArg(ctx, a));
    const docs = parsed.filter((p) => p.doc).map((p) => p.doc);
    const rest = parsed.filter((p) => !p.doc).map((p) => p.arg);
    let argv;
    if (all.length && isMacChromiumBrowser(app)) {
      argv = ['-n', '-a', app.path, '--args', ...all];
    } else {
      argv = [...(newInstance ? ['-n'] : []), '-a', app.path, ...docs, ...(rest.length ? ['--args', ...rest] : [])];
    }
    return { mode: 'open', cmd: 'open', argv };
  }
  if (ctx.flavor === 'win32' || ctx.flavor === 'wsl') {
    const quote = (a) => common().quoteWinArgv(a);
    if (app.kind === 'exec') return { mode: 'openTarget' };
    if (!app.winPath && app.aumid) {
      if (all.length) notes.push('Store apps cannot be given command-line arguments; it was started without them.');
      return { mode: 'ps', ps: { mode: 'apps-folder', aumid: app.aumid }, note: notes.join(' ') || undefined };
    }
    if (all.length && app.target && /\.exe$/i.test(app.target)) {
      const argLine = [app.targetArgs || '', all.map(quote).join(' ')].filter(Boolean).join(' ');
      return { mode: 'ps', ps: { mode: 'exe', path: app.target, argLine, wd: app.workingDir || '' } };
    }
    if (all.length) notes.push('The shortcut does not point to a program, so the arguments were passed to the shortcut.');
    return { mode: 'ps', ps: { mode: 'shortcut', path: app.winPath || app.path, argLine: all.map(quote).join(' ') }, note: notes.join(' ') || undefined };
  }
  // Linux
  const env = accessibility ? { ...(ctx.env || process.env), ACCESSIBILITY_ENABLED: '1', QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1' } : undefined;
  if (app.kind === 'exec') return { mode: 'spawn', cmd: app.path, argv: all, env };
  if (!all.length && !accessibility && ctx.which('gtk-launch')) {
    return { mode: 'gtk-launch', cmd: ctx.which('gtk-launch'), argv: [app.desktopId.replace(/\.desktop$/, '')] };
  }
  let argv = parseExecLine(app.exec, all, { name: app.name, icon: app.icon, file: app.path });
  if (!argv.length) throw appError(`${app.name} has no command to run (Exec is empty)`, 'LAUNCH_FAILED');
  if (app.terminal) {
    const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'xterm'].find((t) => ctx.which(t));
    if (term) argv = term === 'gnome-terminal' ? [term, '--', ...argv] : [term, '-e', ...argv];
    else notes.push('It runs in a terminal, but no terminal emulator was found, so it was started without one.');
  }
  const cmd = argv[0].includes('/') ? argv[0] : ctx.which(argv[0]) || argv[0];
  return { mode: 'spawn', cmd, argv: argv.slice(1), env, note: notes.join(' ') || undefined };
}

const LAUNCH_PS = `
$result = $null
try {
  $p = $null
  if ($mode -eq 'apps-folder') {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\\' + $aumid)
  } else {
    $params = @{ FilePath = $target; PassThru = $true }
    if ($argLine) { $params['ArgumentList'] = $argLine }
    if ($wd -and (Test-Path -LiteralPath $wd)) { $params['WorkingDirectory'] = $wd }
    $p = Start-Process @params
  }
  $procId = 0
  if ($null -ne $p) { try { $procId = [int]$p.Id } catch { $procId = 0 } }
  $result = [ordered]@{ ok = $true; how = $mode; pid = $procId }
} catch {
  $result = [ordered]@{ ok = $false; error = $_.Exception.Message }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
`;

async function startApp(ctx, app, args, opts = {}) {
  // After a failed gtk-launch the plan is made again without it: the Exec line.
  const planCtx = opts.noGtk ? { ...ctx, which: (n) => (n === 'gtk-launch' ? null : ctx.which(n)) } : ctx;
  const plan = launchPlan(planCtx, app, args, opts);
  if (plan.mode === 'open') {
    const res = await ctx.run(plan.cmd, plan.argv, { timeoutMs: 20000 });
    if (res.code !== 0) {
      const msg = String(res.stderr || (res.error && res.error.message) || '').trim();
      throw appError(`Could not open ${app.name}${msg ? `: ${msg}` : res.timedOut ? ': timed out' : ''}`, 'LAUNCH_FAILED');
    }
    return { how: `open ${plan.argv.filter((a) => a === '-n' || a === '-a').join(' ')}`.trim(), note: plan.note };
  }
  if (plan.mode === 'gtk-launch') {
    const r = await ctx.launch(plan.cmd, plan.argv, { waitMs: 3000 });
    if (r.ok) return { how: 'gtk-launch', note: plan.note };
    log.debug('gtk-launch failed; using the Exec line', r.code, r.error && r.error.message);
    return startApp(ctx, app, args, { ...opts, noGtk: true });
  }
  if (plan.mode === 'spawn') {
    const r = await ctx.launch(plan.cmd, plan.argv, { waitMs: 700, env: plan.env });
    if (!r.ok) {
      const why = r.error ? (r.error.code === 'ENOENT' ? `${plan.cmd} was not found` : r.error.message) : `it exited with code ${r.code}${r.signal ? ` (${r.signal})` : ''}`;
      throw appError(`Could not start ${app.name}: ${why}`, 'LAUNCH_FAILED');
    }
    return { how: app.kind === 'exec' ? 'exec' : 'desktop-exec', pid: r.running ? r.pid : undefined, note: plan.note };
  }
  if (plan.mode === 'openTarget') {
    const openTarget = ctx.openTarget || ((t, o) => common().openTarget(t, o));
    const r = await openTarget(app.name, { kind: 'app', args });
    return { how: r.how };
  }
  // Windows / WSL
  const s = plan.ps;
  const script = [
    `$mode = ${psValue(s.mode)}`,
    `$target = ${psValue(s.path)}`,
    `$aumid = ${psValue(s.aumid)}`,
    `$argLine = ${psValue(s.argLine)}`,
    `$wd = ${psValue(s.wd)}`,
    LAUNCH_PS,
  ].join('\n');
  const { data, res } = await runPowerShell(ctx, script, { timeoutMs: 30000 });
  if (!data || data.ok !== true) {
    throw appError(`Could not start ${app.name}: ${(data && data.error) || res.stderr.trim() || (res.timedOut ? 'timed out' : `exit ${res.code}`)}`, 'LAUNCH_FAILED');
  }
  return { how: s.mode === 'apps-folder' ? 'shell:AppsFolder' : s.mode === 'exe' ? 'Start-Process (program)' : 'Start-Process (shortcut)', pid: data.pid || undefined, note: plan.note };
}

/**
 * Launch an app by name (fuzzy), then wait for its window and focus it. An app that already has a
 * window is only focused, unless args or newInstance ask for a new start.
 * @param {string} name
 * @param {{args?:string[], waitForWindow?:boolean, timeoutMs?:number, newInstance?:boolean, accessibility?:boolean,
 *   driver?:object, focus?:boolean, signal?:AbortSignal}} [opts]
 * @param {object} [deps]
 * @returns {Promise<{app:object, launched:boolean, alreadyRunning:boolean, how:string, pid?:number,
 *   window:object|null, focused:boolean, timedOut?:boolean, waitedMs?:number, alternatives:object[], notes:string[]}>}
 */
async function launch(name, opts = {}, deps) {
  const ctx = makeContext(deps);
  const { waitForWindow = true, timeoutMs = 20000, newInstance = false, accessibility = false, driver = null, focus = true, signal } = opts || {};
  const args = Array.isArray(opts.args) ? opts.args.map(String) : [];
  const found = await findAppIn(ctx, name);
  if (!found.app && (ctx.flavor === 'win32' || ctx.flavor === 'wsl') && !found.suggestions.length) {
    // Not in the Start menu: a program on PATH or registered under App Paths (Start-Process finds those).
    const q = String(name).trim();
    found.app = { name: q, id: `exec:${q}`, kind: 'exec', source: 'path', execName: winBase(q).toLowerCase(), altNames: [], keywords: [] };
  }
  if (!found.app) {
    throw appError(
      `No installed app matches "${String(name).trim()}"`,
      'NOT_FOUND',
      found.suggestions.length ? `Closest: ${found.suggestions.slice(0, 5).join(', ')}. Call list_apps to see what is installed.` : 'Call list_apps to see what is installed, or open a URL/file with open.'
    );
  }
  const app = found.app;
  const own = ctx.isOwnWindow || defaultIsOwnWindow;
  const notes = [];
  const before = driver ? (await listWindowsSafe(driver)).filter((w) => !own(w)) : [];
  const existing = rankWindows(before.filter((w) => windowMatchesApp(w, app)));
  if (existing.length && !newInstance && !args.length && !accessibility) {
    const w = existing[0];
    const focused = focus ? await focusAndCheck(ctx, driver, w) : false;
    return { app, launched: false, alreadyRunning: true, how: 'already running', window: w, focused, alternatives: found.alternatives, notes };
  }
  if (accessibility && existing.length) notes.push(`${app.name} was already running, so the accessibility switches only apply after it is quit and launched again.`);
  const started = await startApp(ctx, app, args, { newInstance, accessibility });
  if (started.note) notes.push(started.note);
  const result = { app, launched: true, alreadyRunning: existing.length > 0, how: started.how, pid: started.pid, window: null, focused: false, alternatives: found.alternatives, notes };
  if (!waitForWindow || !driver) return result;
  const hit = await waitForAppWindow(ctx, driver, app, { before, pid: started.pid, timeoutMs, signal });
  if (!hit) {
    result.timedOut = true;
    result.waitedMs = timeoutMs;
    return result;
  }
  result.window = hit.window;
  result.waitedMs = hit.waitedMs;
  result.matchedBy = hit.how;
  if (focus) result.focused = await focusAndCheck(ctx, driver, hit.window);
  return result;
}

// ---------------------------------------------------------------- quit

const LINUX_HOSTS = new Set([
  'systemd', 'init', 'dbus-daemon', 'dbus-broker', 'gnome-shell', 'plasmashell', 'kwin_x11', 'kwin_wayland', 'xorg', 'xwayland', 'xvfb',
  'mutter', 'openbox', 'xfwm4', 'marco', 'muffin', 'cinnamon', 'sway', 'hyprland', 'weston', 'gnome-session-b', 'gnome-session-binary',
  'ksmserver', 'lxsession', 'xfce4-session', 'sshd', 'login', 'bash', 'sh', 'zsh', 'fish', 'dash', 'node', 'python3', 'python', 'java',
]);

const WIN_HOSTS = [
  'explorer', 'applicationframehost', 'svchost', 'dllhost', 'runtimebroker', 'sihost', 'shellexperiencehost', 'startmenuexperiencehost',
  'searchhost', 'searchapp', 'textinputhost', 'msedgewebview2', 'conhost', 'rundll32', 'wscript', 'cscript', 'mshta', 'java', 'javaw',
  'python', 'pythonw', 'node', 'csrss', 'winlogon', 'lsass', 'services', 'wininit', 'dwm', 'wsl', 'wslhost', 'wslservice', 'vmmem', 'vmmemwsl',
];

const QUIT_PS = `
function Invoke-Taskkill([int]$Id, [bool]$Hard) {
  # Windows PowerShell turns a native command's stderr into errors; under 'Stop' they would end the script.
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Hard) { $null = & taskkill.exe /PID $Id /T /F 2>&1 } else { $null = & taskkill.exe /PID $Id /T 2>&1 }
  } catch { } finally { $ErrorActionPreference = $old }
}
$hwnds = @($hwndCsv.Split(',') | Where-Object { $_ })
$pids = @($pidCsv.Split(',') | Where-Object { $_ } | ForEach-Object { [int]$_ })
$names = @($nameCsv.Split(',') | Where-Object { $_ })
$hosts = @($hostCsv.Split(',') | Where-Object { $_ })
$protect = @{}
try {
  $parents = @{}
  foreach ($row in @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId)) { $parents[[int]$row.ProcessId] = [int]$row.ParentProcessId }
  $cur = [int]$PID
  for ($i = 0; $i -lt 64 -and $cur -gt 0 -and -not $protect.ContainsKey($cur); $i++) { $protect[$cur] = $true; $cur = [int]$parents[$cur] }
} catch { $protect[[int]$PID] = $true }
$closedWindows = 0
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  foreach ($h in $hwnds) {
    try {
      $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$h)
      $wp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) { $wp.Close(); $closedWindows++ }
    } catch { }
  }
} catch { }
$procs = @{}
foreach ($id in $pids) { try { $p = Get-Process -Id $id -ErrorAction Stop; $procs[[int]$p.Id] = $p } catch { } }
foreach ($n in $names) { foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) { $procs[[int]$p.Id] = $p } }
$targets = @()
$skipped = @()
foreach ($p in $procs.Values) {
  $pn = ([string]$p.ProcessName).ToLowerInvariant()
  if ($protect.ContainsKey([int]$p.Id)) { $skipped += [int]$p.Id; continue }
  if ($hosts -contains $pn) { continue }
  $targets += $p
}
$closed = @()
foreach ($p in $targets) {
  try { if ($p.MainWindowHandle -ne [IntPtr]::Zero -and $p.CloseMainWindow()) { $closed += [int]$p.Id } } catch { }
}
$deadline = [DateTime]::UtcNow.AddMilliseconds([int]$waitMs)
do {
  $alive = @($targets | Where-Object { $x = $true; try { $x = -not $_.HasExited } catch { $x = $false }; $x })
  if ($alive.Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
$killed = @()
$remaining = @()
foreach ($p in $alive) {
  $hasWindow = $false
  try { $p.Refresh(); $hasWindow = ($p.MainWindowHandle -ne [IntPtr]::Zero) } catch { }
  if ($force -eq '1') {
    Invoke-Taskkill ([int]$p.Id) $true
    $killed += [int]$p.Id
  } elseif (-not $hasWindow) {
    Invoke-Taskkill ([int]$p.Id) $false
    $killed += [int]$p.Id
  } else {
    $title = ''
    try { $title = [string]$p.MainWindowTitle } catch { }
    $remaining += [ordered]@{ pid = [int]$p.Id; name = [string]$p.ProcessName; title = $title }
  }
}
$out = [ordered]@{ ok = $true; found = $targets.Count; closedWindows = $closedWindows; closed = $closed; killed = $killed; remaining = $remaining; skipped = $skipped }
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 4))
`;

const QUIT_JXA = `function run(argv) {
  ObjC.import('AppKit');
  var bundleId = argv[0] || '', name = (argv[1] || '').toLowerCase(), force = argv[2] === '1';
  var protect = (argv[3] || '').split(',').filter(function (x) { return x; }).map(Number);
  var list = [];
  if (bundleId) {
    var byId = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
    for (var i = 0; i < byId.count; i++) list.push(byId.objectAtIndex(i));
  }
  if (!list.length && name) {
    var all = $.NSWorkspace.sharedWorkspace.runningApplications;
    for (var j = 0; j < all.count; j++) {
      var a = all.objectAtIndex(j);
      var n = ObjC.unwrap(a.localizedName);
      if (n && n.toLowerCase() === name) list.push(a);
    }
  }
  var out = [], skipped = [];
  for (var k = 0; k < list.length; k++) {
    var r = list[k], pid = r.processIdentifier;
    if (protect.indexOf(pid) >= 0) { skipped.push(pid); continue; }
    var ok = force ? r.forceTerminate : r.terminate;
    out.push({ pid: pid, name: ObjC.unwrap(r.localizedName) || '', ok: !!ok });
  }
  return JSON.stringify({ apps: out, skipped: skipped });
}`;

/** Our own process and its ancestors: quitting one of them would end Claude itself. */
async function ancestorPids(ctx) {
  if (typeof ctx.ancestorPids === 'function') return new Set(await ctx.ancestorPids());
  const set = new Set([Number(ctx.pid)]);
  try {
    if (ctx.flavor === 'linux' || ctx.flavor === 'wsl') {
      let cur = Number(ctx.pid);
      for (let i = 0; i < 64 && cur > 1; i++) {
        const stat = readText(ctx, `/proc/${cur}/stat`);
        if (!stat) break;
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        cur = Number(rest[1]);
        if (!(cur > 1) || set.has(cur)) break;
        set.add(cur);
      }
    } else if (ctx.flavor === 'darwin') {
      const r = await ctx.run('ps', ['-A', '-o', 'pid=,ppid='], { timeoutMs: 5000 });
      const parent = new Map();
      for (const line of String(r.stdout || '').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)/.exec(line);
        if (m) parent.set(Number(m[1]), Number(m[2]));
      }
      let cur = Number(ctx.pid);
      for (let i = 0; i < 64 && parent.has(cur); i++) {
        cur = parent.get(cur);
        if (!(cur > 1) || set.has(cur)) break;
        set.add(cur);
      }
    }
  } catch (err) {
    log.debug('ancestor lookup failed', err && err.message);
  }
  return set;
}

function pidAlive(ctx, pid) {
  try {
    ctx.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

async function waitWindowsGone(ctx, driver, app, ids, timeoutMs) {
  const deadline = ctx.now() + timeoutMs;
  for (;;) {
    const left = (await listWindowsSafe(driver)).filter((w) => ids.some((id) => sameId(id, w.id)) || windowMatchesApp(w, app));
    const own = ctx.isOwnWindow || defaultIsOwnWindow;
    const still = left.filter((w) => !own(w));
    if (!still.length || ctx.now() >= deadline) return still;
    await ctx.sleep(POLL_MS);
  }
}

async function linuxQuit(ctx, app, windows, force, timeoutMs, driver, protectedPids) {
  // A polite close request per window (_NET_CLOSE_WINDOW through wmctrl, or the driver's own),
  // so an app can ask to save its work; without one, SIGTERM is the polite way to ask.
  const wmctrl = ctx.which('wmctrl');
  const ownClose = Boolean(driver && typeof driver.closeWindow === 'function');
  const close = ownClose
    ? async (w) => Boolean(await driver.closeWindow(w.id))
    : wmctrl
      ? async (w) => (await ctx.run(wmctrl, ['-i', '-c', String(w.id)], { timeoutMs: 3000 })).code === 0
      : null;
  let closedWindows = 0;
  if (close) {
    for (const w of windows) {
      try {
        if (await close(w)) closedWindows++;
      } catch (err) {
        log.debug('close request failed', w.id, err && err.message);
      }
    }
  }
  const comm = (pid) => String(readText(ctx, `/proc/${pid}/comm`) || '').trim().toLowerCase();
  let pids = [...new Set(windows.map((w) => Number(w.pid)).filter((p) => p > 1))];
  if (!pids.length && app.execName && ctx.which('pgrep')) {
    const r = await ctx.run(ctx.which('pgrep'), ['-x', ...(ctx.uid != null ? ['-u', String(ctx.uid)] : []), app.execName.slice(0, 15)], { timeoutMs: 3000 });
    pids = String(r.stdout || '').split(/\s+/).map(Number).filter((p) => p > 1);
  }
  pids = pids.filter((p) => !protectedPids.has(p) && !LINUX_HOSTS.has(comm(p)));
  const still = close && driver && windows.length ? await waitWindowsGone(ctx, driver, app, windows.map((w) => w.id), Math.min(timeoutMs, force ? 2000 : 4000)) : [];
  const stillPids = new Set(still.map((w) => Number(w.pid)));
  const signaled = [];
  const remaining = [];
  for (const pid of pids) {
    if (!pidAlive(ctx, pid)) continue;
    if (!force && stillPids.has(pid)) {
      remaining.push({ pid, title: (still.find((w) => Number(w.pid) === pid) || {}).title || '' });
      continue;
    }
    try {
      ctx.kill(pid, 'SIGTERM');
      signaled.push(pid);
    } catch (err) {
      log.debug('SIGTERM failed', pid, err && err.message);
    }
  }
  if (force && signaled.length) {
    const deadline = ctx.now() + 2000;
    while (ctx.now() < deadline && signaled.some((p) => pidAlive(ctx, p))) await ctx.sleep(200);
    for (const pid of signaled) {
      if (!pidAlive(ctx, pid)) continue;
      try {
        ctx.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  const how = ownClose ? 'close request' : wmctrl ? 'wmctrl -c' : 'SIGTERM';
  const note = close || !windows.length ? undefined : 'wmctrl is not installed, so the app was asked to quit with SIGTERM (sudo apt install wmctrl lets its windows close the gentle way, with a chance to save).';
  return { how, closedWindows, signaled, remaining, found: Math.max(windows.length, pids.length), note };
}

async function windowsQuit(ctx, app, windows, force, timeoutMs) {
  const names = [...new Set([app.execName, app.target ? winBase(app.target) : '', ...windows.map((w) => String(w.process || '').replace(/\.exe$/i, ''))]
    .map((n) => String(n || '').toLowerCase())
    .filter((n) => n && /^[\w .+-]+$/.test(n) && !WIN_HOSTS.includes(n)))];
  const script = [
    `$hwndCsv = ${psValue(windows.map((w) => String(w.id)).filter((id) => /^\d+$/.test(id)).join(','))}`,
    `$pidCsv = ${psValue([...new Set(windows.map((w) => Number(w.pid)).filter((p) => p > 0))].join(','))}`,
    `$nameCsv = ${psValue(names.join(','))}`,
    `$hostCsv = ${psValue(WIN_HOSTS.join(','))}`,
    `$force = ${psValue(force ? '1' : '0')}`,
    `$waitMs = ${psValue(String(Math.max(500, Math.min(timeoutMs, 15000))))}`,
    QUIT_PS,
  ].join('\n');
  const { data, res } = await runPowerShell(ctx, script, { timeoutMs: timeoutMs + 20000 });
  if (!data || data.ok !== true) throw appError(`Could not quit ${app.name}: ${res.stderr.trim() || (res.timedOut ? 'timed out' : `exit ${res.code}`)}`, 'QUIT_FAILED');
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  return {
    how: force ? 'CloseMainWindow, then taskkill /F' : 'CloseMainWindow, then taskkill',
    closedWindows: Number(data.closedWindows) || 0,
    signaled: arr(data.killed),
    remaining: arr(data.remaining),
    skipped: arr(data.skipped),
    found: Number(data.found) || windows.length,
  };
}

async function macQuit(ctx, app, force, protectedPids) {
  const res = await ctx.run('osascript', ['-l', 'JavaScript', '-e', QUIT_JXA, app.bundleId || '', app.name || '', force ? '1' : '0', [...protectedPids].join(',')], { timeoutMs: 15000 });
  let data = null;
  try {
    data = JSON.parse(String(res.stdout || '').trim());
  } catch {
    data = null;
  }
  if (!data) throw appError(`Could not quit ${app.name}: ${String(res.stderr || '').trim() || `osascript exit ${res.code}`}`, 'QUIT_FAILED');
  return {
    how: force ? 'forceTerminate' : 'terminate',
    closedWindows: 0,
    signaled: (data.apps || []).filter((a) => a.ok).map((a) => a.pid),
    remaining: [],
    skipped: data.skipped || [],
    found: (data.apps || []).length + (data.skipped || []).length,
  };
}

/**
 * Quit an app: politely (its windows close; an app asking to save its work stays open and is
 * reported), or with force (terminated). Claude's own process chain is never touched.
 * @param {string} name
 * @param {{force?:boolean, driver?:object, timeoutMs?:number}} [opts]
 * @param {object} [deps]
 * @returns {Promise<{app:object, how:string, found:number, closedWindows:number, signaled:number[],
 *   remaining:object[], windowsLeft:object[], running:boolean, notes:string[]}>}
 */
async function quit(name, opts = {}, deps) {
  const ctx = makeContext(deps);
  const { force = false, driver = null, timeoutMs = 8000 } = opts || {};
  const found = await findAppIn(ctx, name);
  const app = found.app || { name: String(name).trim(), id: `name:${String(name).trim()}`, kind: 'exec', execName: String(name).trim().toLowerCase(), altNames: [], keywords: [] };
  const own = ctx.isOwnWindow || defaultIsOwnWindow;
  const windows = driver ? rankWindows((await listWindowsSafe(driver)).filter((w) => !own(w) && windowMatchesApp(w, app))) : [];
  const protectedPids = await ancestorPids(ctx);
  const mine = windows.find((w) => protectedPids.has(Number(w.pid)));
  if (mine) {
    throw appError(
      `Not quitting ${app.name}: Claude itself runs inside it (process ${mine.pid}).`,
      'PROTECTED',
      'Close the other windows one by one instead, or ask the user to quit it.'
    );
  }
  let r;
  if (ctx.flavor === 'darwin') r = await macQuit(ctx, app, force, protectedPids);
  else if (ctx.flavor === 'linux') r = await linuxQuit(ctx, app, windows, force, timeoutMs, driver, protectedPids);
  else r = await windowsQuit(ctx, app, windows, force, timeoutMs);
  const notes = [];
  if (!r.found && !windows.length) {
    return { app, how: r.how, found: 0, closedWindows: 0, signaled: [], remaining: [], windowsLeft: [], running: false, notes: [`${app.name} was not running.`] };
  }
  const windowsLeft = driver && windows.length ? await waitWindowsGone(ctx, driver, app, windows.map((w) => w.id), ctx.flavor === 'darwin' ? Math.min(timeoutMs, 5000) : 1500) : [];
  if (r.note) notes.push(r.note);
  if (r.skipped && r.skipped.length) notes.push(`Left process ${r.skipped.join(', ')} alone: Claude runs inside it.`);
  const running = windowsLeft.length > 0 || (r.remaining && r.remaining.length > 0);
  if (running && !force) notes.push(`${app.name} is still open: it may be asking to save changes. Take a screenshot to check, answer it, or call quit_app again with force (unsaved work is lost).`);
  return { app, how: r.how, found: r.found, closedWindows: r.closedWindows, signaled: r.signaled, remaining: r.remaining || [], windowsLeft, running, notes };
}

module.exports = {
  listApps,
  findApp,
  launch,
  quit,
  matchApps,
  windowMatchesApp,
  appWindows,
  // shared with browsers.js and tests
  makeContext,
  runPowerShell,
  windowsFolders,
  toWslPath,
  parsePlistXml,
  readPlist,
  parseLnk,
  parseDesktopFile,
  parseExecLine,
  execIdentity,
  expandWinEnv,
  normalizeName,
  queryVariants,
  launchPlan,
  waitForAppWindow,
  rankWindows,
  ancestorPids,
  catalog,
  clearCache,
  lastJson,
  psValue,
  CACHE_TTL_MS,
  MATCH_MIN_SCORE,
  START_APPS_PS,
  LAUNCH_PS,
  QUIT_PS,
  QUIT_JXA,
  WIN_HOSTS,
};
