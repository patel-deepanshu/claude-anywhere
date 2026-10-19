'use strict';

/**
 * UiHost opens, focuses and closes the dialog window.
 *
 * Hosts, in `auto` order:
 *   electron  optional Electron shell (src/electron/main.js): always on top, global hotkey, tray,
 *             hidden from screenshots
 *   app       a chromeless Chromium-family `--app` window (Chrome, Edge, Brave, Chromium, Vivaldi)
 *             with a dedicated profile; from WSL the Windows browser is launched through powershell.exe
 *   browser   a tab in the user's default browser
 *   none      nothing could be opened; the caller prints the URL and suggests `anywhere tui`
 *
 * Only processes we started are ever killed: the Electron child, and app-mode browser
 * processes whose command line carries our dedicated --user-data-dir. The user's own
 * browser is never touched.
 *
 * The dialog URL carries the daemon's access token, and process command lines are readable by
 * every local user (ps, /proc/<pid>/cmdline). Electron therefore gets the URL through its
 * environment (ANYWHERE_UI_URL), and browsers get a single-use launch URL from the `launchUrl`
 * option when the daemon provides one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const paths = require('../shared/paths');
const proc = require('../shared/proc');
const platform = require('../shared/platform');
const { createLogger } = require('../shared/log');
const { sleep } = require('../shared/util');

const log = createLogger('uihost');

const WINDOW_TITLE = 'Claude Anywhere';
const KNOWN_HOSTS = ['auto', 'electron', 'app', 'browser', 'tui', 'none'];
const ELECTRON_MAIN = path.join(__dirname, '..', 'electron', 'main.js');
const DEFAULT_DISPLAY = Object.freeze({ x: 0, y: 0, width: 1440, height: 900 });
const EDGE_MARGIN = 24;
const TOP_MARGIN = 48;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 400;
const EARLY_EXIT_MS = 3000;
const TOPMOST_WAIT_MS = 6000;
const BROWSER_WAIT_MS = 1500;
const PID_WAIT_MS = 3000;
const DRIVER_TIMEOUT_MS = 5000;
// Where windows cannot be listed: how long show() waits for a dialog page to answer the 'show'
// event with "visible" before it opens a window (a minimized window answers hidden, or not at all).
const VISIBLE_WAIT_MS = 1500;
const MAX_VISIBILITY_PAGES = 20;
/** err.code of a withTimeout rejection: the operation may still be running. */
const TIMEOUT_CODE = 'ETIMEDOUT';
// Background window searches: on macOS, skip reading blank titles through System Events, which
// can raise the Automation consent prompt and hold the helper queue. Other drivers ignore it.
const BACKGROUND_LIST = Object.freeze({ axTitles: false });
const SCALE_CACHE_MS = 60000;
const HANDLER_CACHE_MS = 5 * 60000;
/** Environment variable that carries the dialog URL to src/electron/main.js (never argv). */
const ELECTRON_URL_ENV = 'ANYWHERE_UI_URL';
const UI_LOG_MAX_BYTES = 2 * 1024 * 1024;
const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const WSL_SYSTEM32 = '/mnt/c/Windows/System32';
const WSL_PROFILE_KEY = 'wsl:%LOCALAPPDATA%\\claude-anywhere\\ui-profile';
const WSL_PROFILE_EXPR = "(Join-Path $env:LOCALAPPDATA 'claude-anywhere\\ui-profile')";

// [name, app bundle name, CFBundleIdentifier]. Chrome, Canary and Edge first: their
// webkitSpeechRecognition reaches a speech service. Brave, Chromium and Vivaldi expose the API,
// but recognition fails there with 'network' (see MAC_WEB_SPEECH_IDS).
const MAC_BROWSERS = [
  ['Google Chrome', 'Google Chrome', 'com.google.Chrome'],
  ['Google Chrome Canary', 'Google Chrome Canary', 'com.google.Chrome.canary'],
  ['Microsoft Edge', 'Microsoft Edge', 'com.microsoft.edgemac'],
  ['Brave', 'Brave Browser', 'com.brave.Browser'],
  ['Chromium', 'Chromium', 'org.chromium.Chromium'],
  ['Vivaldi', 'Vivaldi', 'com.vivaldi.Vivaldi'],
];

/** Bundle ids (lower case) whose Web Speech recognition works: Chrome, Canary and Edge. */
const MAC_WEB_SPEECH_IDS = new Set(['com.google.chrome', 'com.google.chrome.canary', 'com.microsoft.edgemac']);

/** JXA that prints the bundle id of the app LaunchServices opens https links with. */
const MAC_DEFAULT_BROWSER_JXA = [
  "ObjC.import('AppKit');",
  "var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('https://example.com/'));",
  'var b = (u && !u.isNil()) ? $.NSBundle.bundleWithURL(u) : null;',
  "(b && !b.isNil()) ? ObjC.unwrap(b.bundleIdentifier) : '';",
].join('\n');

const WIN_BROWSERS = [
  ['Google Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
  ['Microsoft Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ['Chromium', 'Chromium\\Application\\chrome.exe'],
  ['Vivaldi', 'Vivaldi\\Application\\vivaldi.exe'],
];

const LINUX_BROWSERS = [
  ['Google Chrome', 'google-chrome'],
  ['Google Chrome', 'google-chrome-stable'],
  ['Chromium', 'chromium'],
  ['Chromium', 'chromium-browser'],
  ['Microsoft Edge', 'microsoft-edge'],
  ['Microsoft Edge', 'microsoft-edge-stable'],
  ['Brave', 'brave-browser'],
  ['Brave', 'brave'],
  ['Vivaldi', 'vivaldi'],
  ['Vivaldi', 'vivaldi-stable'],
];

const LINUX_ABSOLUTE = [
  ['Google Chrome', '/opt/google/chrome/chrome'],
  ['Chromium', '/snap/bin/chromium'],
  ['Chromium', '/var/lib/snapd/snap/bin/chromium'],
  ['Microsoft Edge', '/opt/microsoft/msedge/msedge'],
  ['Brave', '/opt/brave.com/brave/brave'],
  ['Brave', '/snap/bin/brave'],
  ['Vivaldi', '/opt/vivaldi/vivaldi'],
];

const FLATPAK_BROWSERS = [
  ['Google Chrome', 'com.google.Chrome'],
  ['Chromium', 'org.chromium.Chromium'],
  ['Microsoft Edge', 'com.microsoft.Edge'],
  ['Brave', 'com.brave.Browser'],
  ['Vivaldi', 'com.vivaldi.Vivaldi'],
];

// ---------------------------------------------------------------- pure helpers

/**
 * The hosts to try, in order, for a `ui.host` setting.
 * @param {string} host
 * @returns {string[]}
 */
function hostOrder(host) {
  const h = String(host || 'auto').trim().toLowerCase();
  if (h === 'electron' || h === 'app') return [h, 'browser', 'none'];
  if (h === 'browser') return ['browser', 'none'];
  // 'tui' means the user prefers the terminal dialog; there is no window to open.
  if (h === 'none' || h === 'tui') return ['none'];
  return ['electron', 'app', 'browser', 'none'];
}

/**
 * Window bounds for the dialog: right (default), left or centre of the primary display.
 * On Windows the driver reports physical pixels while Chromium expects DIPs, so
 * `useDpiScale` divides by the display's DPI scale.
 * @param {{displays?:Array<object>|null,width?:number,height?:number,position?:string,useDpiScale?:boolean}} opts
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function computeBounds({ displays, width = 440, height = 720, position = 'right', useDpiScale = false } = {}) {
  const valid = (Array.isArray(displays) ? displays : []).filter(
    (d) => d && Number(d.width) > 0 && Number(d.height) > 0
  );
  const d = valid.find((p) => p.primary) || valid[0] || DEFAULT_DISPLAY;
  let s = useDpiScale ? Number(d.dpiScale) || Number(d.scale) || 1 : 1;
  if (!(s > 0)) s = 1;
  const dx = Math.round((Number(d.x) || 0) / s);
  const dy = Math.round((Number(d.y) || 0) / s);
  const dw = Math.max(1, Math.round(Number(d.width) / s));
  const dh = Math.max(1, Math.round(Number(d.height) / s));
  const wantW = Number(width) > 0 ? Math.round(Number(width)) : 440;
  const wantH = Number(height) > 0 ? Math.round(Number(height)) : 720;
  const maxW = Math.max(Math.min(MIN_WIDTH, dw), dw - 2 * EDGE_MARGIN);
  const maxH = Math.max(Math.min(MIN_HEIGHT, dh), dh - TOP_MARGIN - 2 * EDGE_MARGIN);
  const w = Math.max(1, Math.min(wantW, maxW, dw));
  const h = Math.max(1, Math.min(wantH, maxH, dh));
  let x;
  const pos = String(position || 'right').toLowerCase();
  if (pos === 'left') x = dx + EDGE_MARGIN;
  else if (pos === 'center' || pos === 'centre') x = dx + Math.round((dw - w) / 2);
  else x = dx + dw - w - EDGE_MARGIN;
  let y = pos === 'center' || pos === 'centre' ? dy + Math.round((dh - h) / 2) : dy + TOP_MARGIN;
  x = Math.min(Math.max(x, dx), dx + dw - w);
  y = Math.min(Math.max(y, dy), dy + dh - h);
  return { x, y, width: w, height: h };
}

/**
 * Command-line switches for a Chromium-family `--app` window.
 * @param {{url:string,profileDir:string,width:number,height:number,x?:number,y?:number,noSandbox?:boolean}} o
 * @returns {string[]}
 */
function chromiumArgs({ url, profileDir, width, height, x, y, noSandbox = false }) {
  const args = [`--app=${url}`, `--user-data-dir=${profileDir}`, `--window-size=${width},${height}`];
  if (Number.isFinite(x) && Number.isFinite(y)) args.push(`--window-position=${x},${y}`);
  args.push(
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
    '--class=claude-anywhere',
    '--disable-session-crashed-bubble'
  );
  // --test-type stops Chromium from stacking its "unsupported command-line flag: --no-sandbox"
  // (and "Google API keys are missing") infobars on top of the small dialog.
  if (noSandbox) args.push('--no-sandbox', '--test-type');
  return args;
}

/**
 * Arguments for `electron <args>`. The dialog URL is not among them: it carries the access
 * token, so it travels in the ANYWHERE_UI_URL environment variable (see electronEnv).
 * @param {{mainPath?:string,ui?:object,noSandbox?:boolean}} o
 * @returns {string[]}
 */
function electronArgs({ mainPath = ELECTRON_MAIN, ui = {}, noSandbox = false }) {
  const args = [];
  // Chromium refuses to start as root without this switch; it must precede the app path.
  if (noSandbox) args.push('--no-sandbox');
  args.push(
    mainPath,
    '--always-on-top', String(ui.alwaysOnTop !== false),
    '--hotkey', String(ui.hotkey || ''),
    '--hide-from-screenshots', String(ui.hideFromScreenshots !== false),
    '--width', String(Number(ui.width) > 0 ? Math.round(Number(ui.width)) : 440),
    '--height', String(Number(ui.height) > 0 ? Math.round(Number(ui.height)) : 720),
    '--position', String(ui.position || 'right')
  );
  return args;
}

/**
 * Environment for the Electron child: the dialog URL in ANYWHERE_UI_URL (a process environment
 * is readable only by its owner, unlike its command line), without ELECTRON_RUN_AS_NODE.
 * @param {object} env the daemon environment
 * @param {string} url the dialog URL (with ?token=)
 * @returns {object}
 */
function electronEnv(env, url) {
  const out = { ...env, [ELECTRON_URL_ENV]: url };
  // Inherited from VS Code extension hosts and similar; it would make Electron run as plain Node.
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}

/** Arguments that run `script` with -EncodedCommand (UTF-16LE base64), immune to quoting. */
function encodePowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/** powershell.exe arguments for a script. */
function psArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)];
}

/** A PowerShell expression that evaluates to exactly `str` (base64 UTF-8, so no quoting issues). */
function psString(str) {
  const b64 = Buffer.from(String(str), 'utf8').toString('base64');
  return `([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')))`;
}

const PS_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
].join('\n');

/**
 * PowerShell script (run from WSL) that finds a Windows Chromium-family browser and opens the
 * dialog as an app window with a Windows-side profile under %LOCALAPPDATA%\claude-anywhere\ui-profile.
 * Prints `ANYWHERE_PID <pid> <exe>`, `ANYWHERE_NOTFOUND` or `ANYWHERE_ERROR <message>`.
 * @param {{url:string,width:number,height:number,x?:number,y?:number,preferredExe?:string|null}} o
 * @returns {string}
 */
function buildWslLaunchScript({ url, width, height, x, y, preferredExe = null }) {
  const switches = [
    `--window-size=${width},${height}`,
    ...(Number.isFinite(x) && Number.isFinite(y) ? [`--window-position=${x},${y}`] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
    '--class=claude-anywhere',
    '--disable-session-crashed-bubble',
  ];
  const rels = WIN_BROWSERS.map(([, rel]) => `'${rel}'`).join(', ');
  return `${PS_PRELUDE}
try {
  $url = ${psString(url)}
  $profileDir = ${WSL_PROFILE_EXPR}
  [void](New-Item -ItemType Directory -Force -Path $profileDir)
  $roots = @($env:ProgramFiles, \${env:ProgramFiles(x86)}, $env:LOCALAPPDATA, $env:ProgramW6432) | Where-Object { $_ } | Select-Object -Unique
  $rels = @(${rels})
  $exe = $null
  $preferred = ${preferredExe ? psString(preferredExe) : '$null'}
  if ($preferred -and (Test-Path -LiteralPath $preferred)) { $exe = $preferred }
  if (-not $exe) {
    foreach ($rel in $rels) {
      foreach ($root in $roots) {
        $cand = Join-Path $root $rel
        if (Test-Path -LiteralPath $cand) { $exe = $cand; break }
      }
      if ($exe) { break }
    }
  }
  if (-not $exe) { [Console]::Out.WriteLine('ANYWHERE_NOTFOUND'); exit 3 }
  function Format-WinArg([string]$a) {
    if ($a -notmatch '[\\s"]') { return $a }
    return '"' + ($a -replace '(\\\\*)"', '$1$1\\"' -replace '(\\\\+)$', '$1$1') + '"'
  }
  # Each concatenation is parenthesized: PowerShell's comma binds tighter than '+', so
  # @('--app=' + $url, ...) would fold every switch into one argument.
  $list = @(('--app=' + $url), ('--user-data-dir=' + $profileDir), ${switches.map((s) => `'${s}'`).join(', ')})
  $line = ($list | ForEach-Object { Format-WinArg $_ }) -join ' '
  $p = Start-Process -FilePath $exe -ArgumentList $line -PassThru
  [Console]::Out.WriteLine('ANYWHERE_PID ' + $p.Id + ' ' + $exe)
  exit 0
} catch {
  [Console]::Out.WriteLine('ANYWHERE_ERROR ' + $_.Exception.Message)
  exit 2
}
`;
}

/**
 * PowerShell script that stops only browser processes started with our dedicated profile.
 * @param {{profileDirExpr:string}} o a PowerShell expression evaluating to the profile directory
 * @returns {string}
 */
function buildWinKillScript({ profileDirExpr }) {
  return `${PS_PRELUDE}
$killed = 0
try {
  $dir = ${profileDirExpr}
  $needle = '--user-data-dir=' + $dir
  $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe' OR Name='vivaldi.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}
  }
} catch {
  [Console]::Out.WriteLine('ANYWHERE_ERROR ' + $_.Exception.Message)
}
[Console]::Out.WriteLine('ANYWHERE_KILLED ' + $killed)
`;
}

function defaultRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function defaultReadHead(p) {
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('latin1');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** The snap name behind a Linux browser path, or null when it is not a snap. */
function snapNameOf(p, { realpath = defaultRealpath, readHead = defaultReadHead } = {}) {
  const direct = /^(?:\/var\/lib\/snapd)?\/snap\/bin\/([\w.-]+)$/.exec(p);
  if (direct) return direct[1];
  const real = realpath(p) || p;
  if (/\/usr\/bin\/snap$/.test(real)) return path.basename(p);
  const viaReal = /\/snap\/bin\/([\w.-]+)$/.exec(real);
  if (viaReal) return viaReal[1];
  // Ubuntu's transitional chromium-browser is a tiny shell script that execs /snap/bin/chromium.
  const head = readHead(p) || '';
  if (head.startsWith('#!')) {
    const m = /\/snap\/bin\/([\w.-]+)/.exec(head);
    if (m) return m[1];
  }
  return null;
}

/**
 * Find Chromium-family browsers that can open an `--app` window, best first.
 * Windows browsers seen from WSL are handled separately (see buildWslLaunchScript).
 * @param {object} o
 * @param {{platform:string,isWSL?:boolean}} o.platformInfo
 * @param {object} [o.env]
 * @param {(name:string)=>string|null} [o.which]
 * @param {(p:string)=>boolean} [o.exists]
 * @param {(p:string)=>string} [o.realpath]
 * @param {(p:string)=>string} [o.readHead]
 * @param {string} [o.homedir]
 * @param {string} o.profileDir the default dedicated profile directory
 * @returns {Array<{name:string,cmd:string,prefixArgs:string[],kind:'path'|'mac-app'|'snap'|'flatpak',profileDir:string,bundle?:string,bundleId?:string}>}
 */
function findChromiumCandidates({
  platformInfo,
  env = process.env,
  which = proc.which,
  exists = fs.existsSync,
  realpath = defaultRealpath,
  readHead = defaultReadHead,
  homedir = os.homedir(),
  profileDir,
}) {
  const out = [];
  const seen = new Set();
  const add = (c) => {
    const key = `${c.kind}|${c.bundle || realpath(c.cmd)}|${c.prefixArgs.join(' ')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ profileDir, ...c });
  };
  const plat = platformInfo.platform;

  for (const key of ['ANYWHERE_BROWSER', 'CHROME_PATH']) {
    const p = env[key];
    if (!p || (platformInfo.isWSL && /\.exe$/i.test(p))) continue;
    if (plat === 'darwin' && /\.app\/?$/i.test(p) && exists(p)) {
      const bundle = p.replace(/\/$/, '');
      const exe = path.posix.join(bundle, 'Contents', 'MacOS', path.posix.basename(bundle, '.app'));
      add({ name: path.posix.basename(bundle, '.app'), cmd: exe, prefixArgs: [], kind: 'mac-app', bundle });
    } else if (exists(p)) {
      add({ name: path.basename(p), cmd: p, prefixArgs: [], kind: 'path' });
    }
  }

  if (plat === 'darwin') {
    const bases = ['/Applications', path.posix.join(homedir, 'Applications')];
    for (const [name, app, bundleId] of MAC_BROWSERS) {
      for (const base of bases) {
        const bundle = path.posix.join(base, `${app}.app`);
        const exe = path.posix.join(bundle, 'Contents', 'MacOS', app);
        if (exists(exe)) add({ name, cmd: exe, prefixArgs: [], kind: 'mac-app', bundle, bundleId });
      }
    }
    return out;
  }

  if (plat === 'win32') {
    const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA, env.ProgramW6432, 'C:\\Program Files', 'C:\\Program Files (x86)']
      .filter(Boolean)
      .filter((b, i, arr) => arr.findIndex((o) => o.toLowerCase() === b.toLowerCase()) === i);
    for (const [name, rel] of WIN_BROWSERS) {
      for (const base of bases) {
        const exe = path.win32.join(base, rel);
        if (exists(exe)) add({ name, cmd: exe, prefixArgs: [], kind: 'path' });
      }
    }
    for (const exe of ['msedge.exe', 'chrome.exe', 'brave.exe']) {
      const p = which(exe);
      if (p) add({ name: exe.replace(/\.exe$/, ''), cmd: p, prefixArgs: [], kind: 'path' });
    }
    return out;
  }

  // Linux (including WSLg).
  const addLinux = (name, p) => {
    const snap = snapNameOf(p, { realpath, readHead });
    if (snap) {
      // Strict snaps cannot write to hidden directories in $HOME; use the snap's own area.
      const dir = path.posix.join(homedir, 'snap', snap, 'common', 'claude-anywhere-ui-profile');
      add({ name, cmd: p, prefixArgs: [], kind: 'snap', profileDir: dir });
    } else {
      add({ name, cmd: p, prefixArgs: [], kind: 'path' });
    }
  };
  for (const [name, bin] of LINUX_BROWSERS) {
    const p = which(bin);
    if (p) addLinux(name, p);
  }
  for (const [name, p] of LINUX_ABSOLUTE) {
    if (exists(p)) addLinux(name, p);
  }
  const flatpak = which('flatpak');
  if (flatpak) {
    for (const [name, id] of FLATPAK_BROWSERS) {
      const installed = [path.posix.join('/var/lib/flatpak/app', id), path.posix.join(homedir, '.local/share/flatpak/app', id)].some((p) => exists(p));
      if (installed) {
        add({ name: `${name} (flatpak)`, cmd: flatpak, prefixArgs: ['run', `--filesystem=${profileDir}`, id], kind: 'flatpak' });
      }
    }
  }
  return out;
}

/**
 * macOS: move the browsers LaunchServices opens links with to the end. The dialog's browser
 * runs as a regular app instance with its own profile, so while the user's copy of that browser
 * is closed, links clicked elsewhere would open in the dialog's empty profile (and close with it).
 * Candidates without a known bundle id (ANYWHERE_BROWSER, CHROME_PATH) keep their place.
 * @param {Array<{bundleId?:string}>} candidates
 * @param {string|null} defaultBundleId
 */
function preferNonDefaultBrowser(candidates, defaultBundleId) {
  const def = String(defaultBundleId || '').trim().toLowerCase();
  if (!def) return candidates.slice();
  const isDefault = (c) => Boolean(c.bundleId) && c.bundleId.toLowerCase() === def;
  return [...candidates.filter((c) => !isDefault(c)), ...candidates.filter(isDefault)];
}

/**
 * Whether a browser candidate's Web Speech recognition works (the dialog's free voice input):
 * Google Chrome, Chrome Canary and Microsoft Edge. Brave, Chromium and Vivaldi expose
 * webkitSpeechRecognition without a speech service behind it, so recognition fails with 'network'.
 * @param {{name?:string,bundleId?:string}} c
 * @returns {boolean}
 */
function hasBrowserSpeech(c) {
  if (!c) return false;
  if (c.bundleId) return MAC_WEB_SPEECH_IDS.has(String(c.bundleId).toLowerCase());
  const name = String(c.name || '');
  return /chrome|edge|msedge/i.test(name) && !/chromium/i.test(name);
}

/**
 * macOS: the order the dialog tries browsers in. Explicit choices (ANYWHERE_BROWSER, CHROME_PATH:
 * no bundle id) stay first. Then browsers whose Web Speech works (Chrome, Canary, Edge) before
 * those where it fails (Brave, Chromium, Vivaldi), and only within each of those tiers is the
 * default link handler moved last (see preferNonDefaultBrowser): voice input matters more than
 * keeping links out of the dialog's profile, which close() already guards.
 * The doctor uses this too, so it reports the browser the dialog actually opens in.
 * @param {Array<{name?:string,bundleId?:string}>} candidates
 * @param {string|null} defaultBundleId
 */
function orderMacCandidates(candidates, defaultBundleId) {
  const def = String(defaultBundleId || '').trim().toLowerCase();
  const rank = (c) => {
    if (!c.bundleId) return 0;
    const id = String(c.bundleId).toLowerCase();
    return (hasBrowserSpeech(c) ? 2 : 4) + (def && id === def ? 1 : 0);
  };
  return (candidates || [])
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/**
 * macOS: the bundle id of the app LaunchServices opens https links with, or null.
 * @param {{run?:Function, which?:Function}} [o]
 * @returns {Promise<string|null>}
 */
async function readMacDefaultBrowserId({ run = proc.run, which = proc.which } = {}) {
  try {
    const r = await run(which('osascript') || '/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_DEFAULT_BROWSER_JXA], { timeoutMs: 5000 });
    const id = String((r && r.stdout) || '').trim();
    if (r && !r.error && r.code === 0 && /^[\w.-]+$/.test(id)) return id;
  } catch (err) {
    log.debug(`cannot read the default browser: ${err.message}`);
  }
  return null;
}

/** Escape a URL for `cmd.exe /c start "" <url>`. */
function cmdEscape(s) {
  return String(s).replace(/([&|<>^()%!"])/g, '^$1');
}

/**
 * Commands that open a URL in the default browser, best first.
 * @returns {Array<{name:string,cmd:string,args:string[],cwd?:string,anyExit?:boolean}>}
 */
function browserOpenCommands({ platformInfo, url, which = proc.which, exists = fs.existsSync, env = process.env }) {
  const plat = platformInfo.platform;
  if (plat === 'darwin') return [{ name: 'open', cmd: which('open') || '/usr/bin/open', args: [url] }];
  if (plat === 'win32') {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    return [
      // No shell involved, so '&' in the URL is safe.
      { name: 'rundll32', cmd: path.win32.join(root, 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] },
      // explorer.exe reports exit code 1 even on success.
      { name: 'explorer', cmd: path.win32.join(root, 'explorer.exe'), args: [url], anyExit: true },
    ];
  }
  if (platformInfo.isWSL) {
    const list = [];
    const cwd = exists('/mnt/c') ? '/mnt/c' : undefined;
    const winExe = (name, abs) => which(name) || (exists(abs) ? abs : null);
    const wslview = which('wslview');
    if (wslview) list.push({ name: 'wslview', cmd: wslview, args: [url] });
    const rundll = winExe('rundll32.exe', `${WSL_SYSTEM32}/rundll32.exe`);
    if (rundll) list.push({ name: 'rundll32.exe', cmd: rundll, args: ['url.dll,FileProtocolHandler', url], cwd });
    const explorer = winExe('explorer.exe', '/mnt/c/Windows/explorer.exe');
    if (explorer) list.push({ name: 'explorer.exe', cmd: explorer, args: [url], cwd, anyExit: true });
    const cmd = winExe('cmd.exe', `${WSL_SYSTEM32}/cmd.exe`);
    if (cmd) list.push({ name: 'cmd.exe', cmd, args: ['/d', '/c', 'start', '""', cmdEscape(url)], cwd });
    return list;
  }
  const list = [];
  const xdg = which('xdg-open');
  if (xdg) list.push({ name: 'xdg-open', cmd: xdg, args: [url] });
  const gio = which('gio');
  if (gio) list.push({ name: 'gio open', cmd: gio, args: ['open', url] });
  for (const bin of ['sensible-browser', 'x-www-browser']) {
    const p = which(bin);
    if (p) list.push({ name: bin, cmd: p, args: [url] });
  }
  if (env.BROWSER) {
    const first = String(env.BROWSER).split(':')[0].trim();
    const parts = first.split(/\s+/).filter(Boolean);
    if (parts.length) {
      const exe = parts[0].includes('/') ? parts[0] : which(parts[0]);
      const rest = parts.slice(1);
      const args = rest.some((a) => a.includes('%s')) ? rest.map((a) => a.replace('%s', url)) : [...rest, url];
      if (exe) list.push({ name: `$BROWSER (${path.basename(exe)})`, cmd: exe, args });
    }
  }
  return list;
}

/**
 * Locate the Electron binary: env ANYWHERE_ELECTRON, the `electron` npm package next to this
 * package or under <stateDir>/electron, then `electron` on PATH. On Windows a global npm
 * install puts an electron.cmd shim on PATH whose cmd.exe and `node cli.js` would keep a console
 * window open beside the dialog, so the real electron.exe of that global package is used instead.
 * @returns {{path:string, source:'env'|'module'|'global-module'|'path'}|null}
 */
function resolveElectron({
  env = process.env,
  exists = fs.existsSync,
  which = proc.which,
  resolveModule = (id, opts) => require.resolve(id, opts),
  loadModule = (p) => require(p),
  packageRoot = paths.PACKAGE_ROOT,
  stateDir = () => paths.stateDir(),
  platform = process.platform,
} = {}) {
  const fromEnv = env.ANYWHERE_ELECTRON;
  if (fromEnv) {
    if (exists(fromEnv)) return { path: fromEnv, source: 'env' };
    log.warn(`ANYWHERE_ELECTRON points to ${fromEnv}, which does not exist; ignoring it`);
  }
  try {
    let sd = null;
    try {
      sd = typeof stateDir === 'function' ? stateDir() : stateDir;
    } catch {
      sd = null;
    }
    const searchPaths = [packageRoot, sd ? path.join(sd, 'electron') : null].filter(Boolean);
    const modPath = resolveModule('electron', { paths: searchPaths });
    // The electron npm package exports the path of the downloaded binary.
    const bin = loadModule(modPath);
    if (typeof bin === 'string' && bin && exists(bin)) return { path: bin, source: 'module' };
  } catch (err) {
    log.debug(`electron npm package not usable: ${err.message}`);
  }
  const onPath = which('electron');
  if (!onPath) return null;
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(onPath)) {
    try {
      // %APPDATA%\npm\electron.cmd -> %APPDATA%\npm\node_modules\electron
      const modPath = resolveModule('electron', { paths: [path.win32.join(path.win32.dirname(onPath), 'node_modules')] });
      const bin = loadModule(modPath);
      if (typeof bin === 'string' && bin && exists(bin)) return { path: bin, source: 'global-module' };
    } catch (err) {
      log.debug(`the global electron package behind ${onPath} is not usable: ${err.message}`);
    }
  }
  return { path: onPath, source: 'path' };
}

/**
 * Pick our dialog window from a driver window list: windows owned by our processes, then
 * exact, prefix and substring title matches for "Claude Anywhere". A blank title on a window of
 * ours still counts (macOS hides window titles without Screen Recording permission).
 * Within one of those classes a window that is not `stale` wins, then one that is not minimized.
 * `stale` lists ids that existed before this daemon opened anything: a window a crashed daemon
 * left behind, whose page holds a dead access key, must not shadow the new dialog.
 * @param {Array<{id:any,title?:string,pid?:number,minimized?:boolean,layer?:number}>} windows
 * @param {{pids?:number[], stale?:Iterable<any>}} [opts]
 */
function pickWindow(windows, { pids = [], stale = [] } = {}) {
  const pidSet = new Set((pids || []).filter((p) => Number(p) > 0).map(Number));
  const staleSet = new Set([...(stale || [])].map(String));
  let best = null;
  let bestRank = Infinity;
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || w.id == null) continue;
    const t = String(w.title || '');
    const pidMatch = Boolean(w.pid) && pidSet.has(Number(w.pid));
    let cls;
    if (pidMatch && t.includes(WINDOW_TITLE)) cls = 0;
    else if (t === WINDOW_TITLE) cls = 1;
    else if (pidMatch && t.trim()) cls = 2;
    else if (pidMatch && (w.layer == null || Number(w.layer) === 0)) cls = 3;
    else if (t.startsWith(WINDOW_TITLE)) cls = 4;
    else if (t.includes(WINDOW_TITLE)) cls = 5;
    else continue;
    const rank = cls * 4 + (staleSet.has(String(w.id)) ? 2 : 0) + (w.minimized ? 1 : 0);
    if (rank < bestRank) {
      best = w;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Sort the windows of the dialog's browser instance into dialog windows and others (macOS, where
 * that instance can also receive the user's links). Titles are blank without Screen Recording
 * permission, so blank windows only count as the dialog when the instance has one window.
 * @param {Array<{id:any,title?:string,pid?:number,layer?:number}>} windows
 * @param {number[]} pids the instance's processes
 * @returns {{dialog:object[], others:object[], unknown:object[], onlyDialog:boolean}}
 */
function classifyInstanceWindows(windows, pids) {
  const pidSet = new Set((pids || []).filter((p) => Number(p) > 0).map(Number));
  const dialog = [];
  const others = [];
  const unknown = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || w.id == null || !w.pid || !pidSet.has(Number(w.pid))) continue;
    if (w.layer != null && Number(w.layer) !== 0) continue;
    const t = String(w.title || '').trim();
    if (!t) unknown.push(w);
    else if (t.includes(WINDOW_TITLE)) dialog.push(w);
    else others.push(w);
  }
  const onlyDialog = others.length === 0 && (unknown.length === 0 || dialog.length + unknown.length <= 1);
  return { dialog, others, unknown, onlyDialog };
}

/**
 * Chromium's device scale factor on an X11 session, which it applies to --window-position and
 * --window-size (DIPs) while the X11 driver reports physical pixels. GDK_SCALE first, then
 * Xft.dpi / 96 from `xrdb -query`, then GNOME's scaling-factor; null when nothing says.
 * @param {{env?:object, xrdb?:string|null, gsettings?:string|null}} o raw command outputs
 * @returns {number|null}
 */
function x11ScaleFrom({ env = {}, xrdb = null, gsettings = null } = {}) {
  const clean = (n) => (Number.isFinite(n) && n > 0 && n <= 8 ? Math.round(n * 100) / 100 : null);
  const gdk = clean(Number(String(env.GDK_SCALE || '').trim()));
  if (gdk) return gdk;
  const m = /^Xft\.dpi:\s*([\d.]+)\s*$/m.exec(String(xrdb || ''));
  const dpi = m ? clean(Number(m[1]) / 96) : null;
  if (dpi) return dpi;
  const g = /(\d+(?:\.\d+)?)\s*$/.exec(String(gsettings || '').trim());
  // 0 means "automatic" (GNOME picks by monitor DPI), which says nothing here.
  const gs = g ? clean(Number(g[1])) : null;
  return gs || null;
}

/**
 * PIDs from `ps -A -ww -o pid=,args=` output whose command line uses one of our profile directories.
 * @param {string} psOutput
 * @param {string[]} profileDirs
 * @param {number[]} [exclude]
 * @returns {number[]}
 */
function findProfilePids(psOutput, profileDirs, exclude = []) {
  const needles = (profileDirs || []).filter(Boolean).map((d) => `--user-data-dir=${d}`);
  if (!needles.length) return [];
  const skip = new Set(exclude.map(Number));
  const pids = [];
  for (const line of String(psOutput || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (skip.has(pid)) continue;
    const args = m[2];
    // The needle must end at an argument boundary so ".../ui-profile" never matches ".../ui-profile2".
    if (needles.some((n) => args.includes(`${n} `) || args.endsWith(n) || args.includes(`${n}"`) || args.includes(`${n}'`))) {
      pids.push(pid);
    }
  }
  return pids;
}

/**
 * powershell.exe as WSL (or another Linux with Windows interop) reaches it, or null: PATH first,
 * then the fixed System32 path under /mnt/c, then pwsh.exe. The same lookup UiHost uses to open
 * the dialog in a Windows browser; `anywhere doctor` reports from it.
 * @param {{which?:Function, exists?:Function}} [deps]
 * @returns {string|null}
 */
function wslPowershellPath({ which = proc.which, exists = fs.existsSync } = {}) {
  return which('powershell.exe') || (exists(WSL_POWERSHELL) ? WSL_POWERSHELL : null) || which('pwsh.exe') || null;
}

/**
 * Wait until a child exits or `ms` passes.
 * @returns {Promise<{exited:boolean,code?:number|null,signal?:string|null,error?:Error}>}
 */
function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (!child) {
      resolve({ exited: true, code: null, signal: null });
      return;
    }
    if (child.exitCode != null || child.signalCode != null) {
      resolve({ exited: true, code: child.exitCode, signal: child.signalCode });
      return;
    }
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve(r);
    };
    const onExit = (code, signal) => finish({ exited: true, code, signal });
    const onError = (error) => finish({ exited: true, code: null, signal: null, error });
    child.on('exit', onExit);
    child.on('error', onError);
    const timer = setTimeout(() => finish({ exited: false }), ms);
  });
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${what || 'operation'} timed out after ${ms} ms`), { code: TIMEOUT_CODE })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function noBrowserHint(pi) {
  if (pi.platform === 'darwin') return 'no Chromium-family browser found in /Applications (install Google Chrome, Edge or Brave)';
  if (pi.platform === 'win32') return 'no Chrome, Edge or Brave found (Microsoft Edge ships with Windows; reinstall it with: winget install Microsoft.Edge)';
  return 'no Chromium-family browser found (install one, e.g. sudo apt install chromium-browser, or set ANYWHERE_BROWSER=/path/to/chrome)';
}

// ---------------------------------------------------------------- UiHost

class UiHost {
  /**
   * @param {object} opts
   * @param {object} opts.config full config (reads `config.ui` on every call)
   * @param {object} [opts.platformInfo] platform.info()
   * @param {object} [opts.driver] OS driver (displays, listWindows, focusWindow, setTopmost, closeWindow)
   * @param {(url:string)=>string|Promise<string>} [opts.launchUrl] turns the dialog URL (with
   *   ?token=) into one that is safe on a child-process command line, such as a URL with a
   *   single-use launch code that the page exchanges for the token. Every browser launch asks
   *   for a fresh one. Without it browsers get the token URL itself.
   * @param {()=>number} [opts.clientCount] how many dialog pages are connected to the daemon (its
   *   SSE clients, ideally without TUI or CLI watchers). Where windows cannot be listed (GNOME and
   *   KDE on Wayland), show() relies on it instead of opening another window.
   * @param {boolean} [opts.cleanupLeftovers] default true: before the first window search or
   *   launch, stop dialog browsers a previous daemon left running with our profile.
   * Dialog pages report whether they can be seen through noteVisibility() (POST /api/ui/visibility).
   * Test seams: which, exists, spawn, run, env, getuid, kill, homedir, realpath, readHead,
   * resolveModule, loadModule, profileDir, stateDir, logFile, earlyExitMs, topmostWaitMs,
   * browserWaitMs, pidWaitMs, driverTimeoutMs, visibleWaitMs.
   */
  constructor({ config, platformInfo, driver, ...deps } = {}) {
    this.config = config || {};
    this.platformInfo = platformInfo || platform.info();
    this.driver = driver || null;
    this._closed = false;
    this.env = deps.env || process.env;
    this._which = deps.which || proc.which;
    this._exists = deps.exists || fs.existsSync;
    this._spawn = deps.spawn || childProcess.spawn;
    this._run = deps.run || proc.run;
    this._getuid = deps.getuid || (typeof process.getuid === 'function' ? () => process.getuid() : () => -1);
    this._killFn = deps.kill || ((pid, sig) => process.kill(pid, sig));
    this._homedir = deps.homedir || os.homedir();
    this._realpath = deps.realpath || defaultRealpath;
    this._readHead = deps.readHead || defaultReadHead;
    this._resolveModule = deps.resolveModule;
    this._loadModule = deps.loadModule;
    this._profileDirOpt = deps.profileDir;
    this._stateDir = deps.stateDir || (() => paths.stateDir());
    this._logFile = deps.logFile;
    this.earlyExitMs = deps.earlyExitMs != null ? deps.earlyExitMs : EARLY_EXIT_MS;
    this.topmostWaitMs = deps.topmostWaitMs != null ? deps.topmostWaitMs : TOPMOST_WAIT_MS;
    this.browserWaitMs = deps.browserWaitMs != null ? deps.browserWaitMs : BROWSER_WAIT_MS;
    this.pidWaitMs = deps.pidWaitMs != null ? deps.pidWaitMs : PID_WAIT_MS;
    this.driverTimeoutMs = deps.driverTimeoutMs != null ? deps.driverTimeoutMs : DRIVER_TIMEOUT_MS;
    this.visibleWaitMs = deps.visibleWaitMs != null ? deps.visibleWaitMs : VISIBLE_WAIT_MS;
    this._visibility = new Map(); // dialog page id → {visible, focused, seq}, from noteVisibility()
    this._visibilitySeq = 0; // numbers the reports, so show() can tell the ones that answer it
    this._visibilityWaiters = new Set();
    // Report numbers of dialog pages that connected (notePages()): dialogState() counts each as on screen,
    // with an unknown focus, until a newer report stands for it.
    this._pageConnects = [];
    this._pagesSeen = 0;
    this._launchUrlFn = typeof deps.launchUrl === 'function' ? deps.launchUrl : null;
    this._clientCountFn = typeof deps.clientCount === 'function' ? deps.clientCount : null;
    this._cleanupLeftovers = deps.cleanupLeftovers !== false;

    this._host = null;
    this._external = false; // a window exists that we did not spawn directly (hand-off, `open -n`, WSL, browser tab)
    this._url = null;
    this._owned = []; // [{child, host, group}]
    this._appProfiles = new Set(); // profile dirs (or WSL_PROFILE_KEY) our app windows were started with
    this._wslPid = null;
    this._profilePids = new Set(); // macOS: the dialog browser started through `open -n` (not our child)
    this._staleIds = new Set(); // ids (as strings) of dialog-like windows that predate this daemon
    this._cleanedUp = false;
    this._topmost = null;
    this._x11ScaleCache = null;
    this._macHandlerCache = null;
    this._electronTipShown = false;
    this._chain = Promise.resolve();
  }

  /** @returns {object} the live ui config section */
  _ui() {
    return (this.config && this.config.ui) || {};
  }

  _serialize(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.catch(() => {});
    return run;
  }

  _profileDir() {
    if (typeof this._profileDirOpt === 'function') return this._profileDirOpt();
    if (this._profileDirOpt) return this._profileDirOpt;
    return paths.uiProfileDir();
  }

  _linuxDisplay() {
    return Boolean(this.env.DISPLAY || this.env.WAYLAND_DISPLAY);
  }

  _noSandbox() {
    const pi = this.platformInfo;
    if (pi.platform !== 'linux') return false;
    if (this.env.ANYWHERE_NO_SANDBOX === '1') return true;
    try {
      return this._getuid() === 0;
    } catch {
      return false;
    }
  }

  _ownedLive() {
    return this._owned.filter((o) => o.child && o.child.exitCode == null && o.child.signalCode == null && !o.exited);
  }

  _ownedPids() {
    const pids = this._ownedLive().map((o) => o.child.pid);
    if (this._wslPid) pids.push(this._wslPid);
    for (const pid of this._profilePids) {
      if (this._alive(pid)) pids.push(pid);
      else this._profilePids.delete(pid);
    }
    return pids.filter(Boolean);
  }

  /**
   * The URL to put on a browser's command line. Command lines are readable by every local user,
   * so the token URL is swapped for a single-use launch URL when the daemon provides one.
   * @param {string} url the dialog URL (with ?token=)
   * @returns {Promise<string>}
   */
  async _argvUrl(url) {
    if (!this._launchUrlFn) return url;
    try {
      const out = await this._launchUrlFn(url);
      if (typeof out === 'string' && out) return out;
      log.warn('no launch URL was minted; the browser command line carries the access token');
    } catch (err) {
      log.warn(`could not mint a launch URL (${err.message}); the browser command line carries the access token`);
    }
    return url;
  }

  _own(child, host, group) {
    const rec = { child, host, group: Boolean(group), exited: false };
    child.on('exit', (code, signal) => {
      rec.exited = true;
      log.info(`${host} window process ${child.pid} exited (${signal || `code ${code}`})`);
    });
    this._owned.push(rec);
    return rec;
  }

  /** Open a log file for host stderr (Electron and Chromium are chatty); falls back to 'ignore'. */
  _stdioFd() {
    let file = this._logFile;
    if (file === false) return null;
    try {
      if (!file) file = path.join(paths.logsDir(), 'ui-host.log');
      try {
        if (fs.statSync(file).size > UI_LOG_MAX_BYTES) fs.truncateSync(file, 0);
      } catch {
        /* missing is fine */
      }
      return fs.openSync(file, 'a');
    } catch {
      return null;
    }
  }

  /**
   * Spawn a process and watch it for `waitMs`. Exit 0 within the window means the request was
   * handed to an already-running instance (Electron single-instance lock, Chromium profile lock).
   * @returns {Promise<{ok:boolean,child?:object|null,handedOff?:boolean,exited?:boolean,reason?:string,spawnError?:boolean}>}
   */
  async _launch(cmd, args, { detached = false, shell = false, cwd, env, waitMs = this.earlyExitMs, windowsHide = false, logOutput = true, dialog = false } = {}) {
    const fd = logOutput ? this._stdioFd() : null;
    let child;
    try {
      child = this._spawn(cmd, args, {
        cwd,
        // dialog: the dialog's own window host. The mark is inherited by its helper processes, so quit_app
        // can leave them alone where windows cannot be listed (src/os/apps.js DIALOG_ENV_MARK).
        env: dialog ? { ...(env || this.env), ANYWHERE_DIALOG: '1' } : env || this.env,
        detached,
        shell,
        windowsHide,
        stdio: ['ignore', fd == null ? 'ignore' : fd, fd == null ? 'ignore' : fd],
      });
    } catch (err) {
      return { ok: false, reason: `could not start ${cmd}: ${err.message}`, spawnError: true, exited: true };
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    // A ChildProcess without an 'error' listener crashes the daemon on spawn failures.
    child.on('error', (err) => log.debug(`${cmd}: ${err.message}`));
    if (typeof child.unref === 'function') child.unref();
    const w = await waitForExit(child, waitMs);
    if (!w.exited) return { ok: true, child, handedOff: false, exited: false };
    if (w.error) {
      const reason = w.error.code === 'ENOENT' ? `${cmd} was not found` : `${cmd}: ${w.error.message}`;
      return { ok: false, reason, spawnError: true, exited: true };
    }
    if (w.code === 0 && !w.signal) return { ok: true, child: null, handedOff: true, exited: true };
    return { ok: false, reason: w.signal ? `exited with signal ${w.signal}` : `exited with code ${w.code}`, exited: true };
  }

  async _bounds() {
    const ui = this._ui();
    let displays = null;
    if (this.driver && typeof this.driver.displays === 'function') {
      try {
        displays = await withTimeout(this.driver.displays(), this.driverTimeoutMs, 'listing displays');
      } catch (err) {
        log.debug(`displays() failed; assuming ${DEFAULT_DISPLAY.width}x${DEFAULT_DISPLAY.height}: ${err.message}`);
      }
    }
    const pi = this.platformInfo;
    let useDpiScale = pi.platform === 'win32' || Boolean(pi.isWSL);
    if (pi.platform === 'linux' && !pi.isWSL && this._isX11() && Array.isArray(displays) && displays.length) {
      // The X11 driver reports physical pixels; Chromium reads the bounds as DIPs.
      const scale = await this._x11Scale();
      if (scale && scale !== 1) {
        displays = displays.map((d) => (d && typeof d === 'object' ? { ...d, dpiScale: scale } : d));
        useDpiScale = true;
      }
    }
    return computeBounds({
      displays,
      width: ui.width,
      height: ui.height,
      position: ui.position,
      useDpiScale,
    });
  }

  _isX11() {
    return Boolean(this.env.DISPLAY) && !this.env.WAYLAND_DISPLAY;
  }

  /** Chromium's device scale factor on this X11 session (cached for a minute), or null. */
  async _x11Scale() {
    const now = Date.now();
    if (this._x11ScaleCache && now - this._x11ScaleCache.at < SCALE_CACHE_MS) return this._x11ScaleCache.value;
    const probe = async (cmd, args) => {
      const exe = this._which(cmd);
      if (!exe) return null;
      try {
        const r = await this._run(exe, args, { timeoutMs: 2000 });
        return !r.error && r.code === 0 ? String(r.stdout || '') : null;
      } catch {
        return null;
      }
    };
    let value = x11ScaleFrom({ env: this.env });
    if (!value) value = x11ScaleFrom({ xrdb: await probe('xrdb', ['-query']) });
    if (!value) value = x11ScaleFrom({ gsettings: await probe('gsettings', ['get', 'org.gnome.desktop.interface', 'scaling-factor']) });
    if (value && value !== 1) log.debug(`X11 scale factor ${value}: app window bounds are converted to DIPs`);
    this._x11ScaleCache = { at: now, value };
    return value;
  }

  // ----- hosts

  async _tryElectron(url) {
    const pi = this.platformInfo;
    if ((pi.platform === 'linux' || pi.isWSL) && !this._linuxDisplay()) {
      return { ok: false, reason: 'no graphical display for Electron (DISPLAY/WAYLAND_DISPLAY is not set)' };
    }
    const found = resolveElectron({
      env: this.env,
      exists: this._exists,
      which: this._which,
      platform: pi.platform,
      ...(this._resolveModule ? { resolveModule: this._resolveModule } : {}),
      ...(this._loadModule ? { loadModule: this._loadModule } : {}),
      stateDir: this._stateDir,
    });
    if (!found) return { ok: false, reason: 'Electron is not installed (optional: anywhere install --electron)' };
    const args = electronArgs({ ui: this._ui(), noSandbox: this._noSandbox() });
    // The URL goes through the environment, never the command line. It is a single-use launch URL
    // too, so the page gets the dialog window's own credential (F3-SAFE-D1); a running Electron that
    // is only asked to show its window gets the same URL again, so it does not reload the page.
    const live = this._ownedLive().some((o) => o.host === 'electron');
    const launch = live && this._electronUrl ? this._electronUrl : await this._argvUrl(url);
    this._electronUrl = launch;
    const env = electronEnv(this.env, launch);
    const isShim = pi.platform === 'win32' && /\.(cmd|bat)$/i.test(found.path);
    // Last resort for a bare electron.cmd: without windowsHide its cmd.exe (and `node cli.js`)
    // would keep a console window open beside the dialog.
    const r = isShim
      ? await this._launch(proc.quoteWinArg(found.path), args.map(proc.quoteWinArg), { shell: true, env, windowsHide: true, dialog: true })
      : await this._launch(found.path, args, { env, dialog: true });
    if (!r.ok) return { ok: false, reason: `Electron ${r.reason}` };
    if (r.child) this._own(r.child, 'electron', false);
    return { ok: true, detail: `Electron (${found.path})`, handedOff: r.handedOff };
  }

  async _powershellPath() {
    if (this.platformInfo.platform === 'win32') {
      const root = this.env.SystemRoot || this.env.windir || 'C:\\Windows';
      const builtin = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return this._which('powershell.exe') || (this._exists(builtin) ? builtin : null) || this._which('pwsh.exe');
    }
    return wslPowershellPath({ which: this._which, exists: this._exists });
  }

  /** powershell.exe as WSL reaches it (see the module-level wslPowershellPath). */
  static wslPowershellPath(deps) {
    return wslPowershellPath(deps);
  }

  async _wslPreferredExe() {
    for (const key of ['ANYWHERE_BROWSER', 'CHROME_PATH']) {
      const p = this.env[key];
      if (!p || !/\.exe$/i.test(p)) continue;
      if (/^[A-Za-z]:\\/.test(p)) return p;
      if (p.startsWith('/mnt/')) {
        const r = await this._run('wslpath', ['-w', p], { timeoutMs: 5000 });
        const win = String(r.stdout || '').trim();
        if (r.code === 0 && win) return win;
      }
    }
    return null;
  }

  async _launchWslApp(url, bounds) {
    const ps = await this._powershellPath();
    if (!ps) {
      return {
        ok: false,
        reason: 'powershell.exe is not reachable from WSL (enable interop: [interop] enabled=true and appendWindowsPath=true in /etc/wsl.conf, then wsl --shutdown)',
      };
    }
    const preferredExe = await this._wslPreferredExe();
    const script = buildWslLaunchScript({ url: await this._argvUrl(url), ...bounds, preferredExe });
    const r = await this._run(ps, psArgs(script), { timeoutMs: 15000, cwd: this._exists('/mnt/c') ? '/mnt/c' : undefined });
    const out = String(r.stdout || '');
    const m = /ANYWHERE_PID (\d+) ([^\r\n]+)/.exec(out);
    if (m) {
      this._wslPid = Number(m[1]);
      this._appProfiles.add(WSL_PROFILE_KEY);
      return { ok: true, detail: `${path.win32.basename(m[2].trim())} app window (Windows, via WSL)` };
    }
    if (/ANYWHERE_NOTFOUND/.test(out)) {
      return { ok: false, reason: 'no Chrome, Edge or Brave found on the Windows side (Microsoft Edge ships with Windows)' };
    }
    const errLine = (/ANYWHERE_ERROR ([^\r\n]+)/.exec(out) || [])[1];
    const why = errLine || (r.error && r.error.message) || proc.psErrorText(r.stderr).trim().split(/\r?\n/)[0] || (r.timedOut ? 'timed out' : `exit code ${r.code}`);
    return { ok: false, reason: `powershell.exe could not open a Windows browser: ${why}` };
  }

  async _tryApp(url) {
    const pi = this.platformInfo;
    const reasons = [];
    if (pi.platform === 'linux' && !pi.isWSL && !this._linuxDisplay()) {
      return { ok: false, reason: 'no graphical display (DISPLAY/WAYLAND_DISPLAY is not set)' };
    }
    const bounds = await this._bounds();
    if (pi.isWSL) {
      const r = await this._launchWslApp(url, bounds);
      if (r.ok) {
        this._scheduleTopmost();
        return r;
      }
      reasons.push(r.reason);
      if (!this._linuxDisplay()) return { ok: false, reason: reasons.join('; ') };
    }
    let defaultProfile;
    try {
      defaultProfile = this._profileDir();
    } catch (err) {
      return { ok: false, reason: `cannot create the browser profile directory: ${err.message}` };
    }
    let candidates = findChromiumCandidates({
      platformInfo: pi,
      env: this.env,
      which: this._which,
      exists: this._exists,
      realpath: this._realpath,
      readHead: this._readHead,
      homedir: this._homedir,
      profileDir: defaultProfile,
    });
    if (pi.platform === 'darwin' && candidates.length > 1) {
      candidates = orderMacCandidates(candidates, await this._macDefaultBrowserId());
    }
    if (!candidates.length) reasons.push(noBrowserHint(pi));
    const noSandbox = this._noSandbox();
    const posix = pi.platform !== 'win32';
    for (const c of candidates) {
      if (c.profileDir !== defaultProfile) {
        try {
          fs.mkdirSync(c.profileDir, { recursive: true, mode: 0o700 });
        } catch (err) {
          reasons.push(`${c.name}: cannot create ${c.profileDir}: ${err.message}`);
          continue;
        }
      }
      // A fresh single-use launch URL per attempt: a failed attempt may have used its code.
      const args = chromiumArgs({ url: await this._argvUrl(url), profileDir: c.profileDir, ...bounds, noSandbox: noSandbox && c.kind !== 'flatpak' });
      let r;
      const viaOpen = c.kind === 'mac-app' && Boolean(this._which('open'));
      if (viaOpen) {
        // Launching through LaunchServices makes the browser its own "responsible process", so the
        // microphone prompt names the browser instead of the terminal that started the daemon.
        r = await this._launch(this._which('open'), ['-n', '-a', c.bundle, '--args', ...args], { detached: true, dialog: true });
      } else {
        // Own process group on POSIX so wrapper scripts (snap, flatpak) can be stopped as a unit.
        r = await this._launch(c.cmd, [...c.prefixArgs, ...args], { detached: posix, dialog: true });
      }
      if (r.ok) {
        if (r.child) this._own(r.child, 'app', posix);
        this._appProfiles.add(c.profileDir);
        if (viaOpen) {
          await this._collectProfilePids(c.profileDir);
          if (!this._electronTipShown) {
            this._electronTipShown = true;
            log.info(`the dialog runs in ${c.name} with its own profile; for a dedicated window that never shares the browser's link handling, run: anywhere install --electron`);
          }
        }
        this._scheduleTopmost();
        return { ok: true, detail: `${c.name} app window`, handedOff: r.handedOff };
      }
      reasons.push(`${c.name}: ${r.reason}`);
    }
    return { ok: false, reason: reasons.join('; ') || noBrowserHint(pi) };
  }

  /**
   * macOS: `open -n` exits at once, so the dialog's browser is not our child. Find its processes
   * by their --user-data-dir, so its window can be matched by pid (window titles are blank
   * without Screen Recording permission) and `show` focuses it instead of opening another one.
   */
  async _collectProfilePids(profileDir) {
    const deadline = Date.now() + this.pidWaitMs;
    for (;;) {
      let r;
      try {
        r = await this._run('ps', ['-A', '-ww', '-o', 'pid=,args='], { timeoutMs: 3000 });
      } catch (err) {
        r = { error: err };
      }
      if (!r || r.error || r.code !== 0) return;
      const pids = findProfilePids(r.stdout, [profileDir], [process.pid]);
      if (pids.length) {
        for (const pid of pids) this._profilePids.add(pid);
        return;
      }
      if (Date.now() >= deadline) return;
      await sleep(250);
    }
  }

  /** macOS: the bundle id of the default https handler (cached for a few minutes), or null. */
  async _macDefaultBrowserId() {
    const now = Date.now();
    if (this._macHandlerCache && now - this._macHandlerCache.at < HANDLER_CACHE_MS) return this._macHandlerCache.value;
    const value = await readMacDefaultBrowserId({ run: this._run, which: this._which });
    this._macHandlerCache = { at: now, value };
    return value;
  }

  async _tryBrowser(url) {
    const pi = this.platformInfo;
    if (pi.platform === 'linux' && !pi.isWSL && !this._linuxDisplay()) {
      return { ok: false, reason: 'no graphical display (DISPLAY/WAYLAND_DISPLAY is not set)' };
    }
    const listFor = (u) => browserOpenCommands({ platformInfo: pi, url: u, which: this._which, exists: this._exists, env: this.env });
    const cmds = listFor(url);
    if (!cmds.length) {
      return { ok: false, reason: pi.platform === 'linux' ? 'no URL opener found (install xdg-utils: sudo apt install xdg-utils)' : 'no URL opener found' };
    }
    const reasons = [];
    for (let i = 0; i < cmds.length; i += 1) {
      // The browser's command line gets a single-use launch URL, fresh for every attempt.
      const argvUrl = await this._argvUrl(url);
      const c = argvUrl === url ? cmds[i] : listFor(argvUrl)[i];
      if (!c) continue;
      const r = await this._launch(c.cmd, c.args, {
        detached: pi.platform !== 'win32',
        cwd: c.cwd,
        waitMs: this.browserWaitMs,
        windowsHide: true,
        logOutput: false,
      });
      // Openers are never tracked: closing them could close the user's browser.
      if (r.ok || (c.anyExit && r.exited && !r.spawnError)) return { ok: true, detail: `default browser (${c.name})` };
      reasons.push(`${c.name}: ${r.reason}`);
    }
    return { ok: false, reason: reasons.join('; ') };
  }

  _noneResult(url) {
    const requested = String(this._ui().host || 'auto').toLowerCase();
    if (requested === 'tui') return { host: 'none', detail: `Run "anywhere tui" in a terminal, or open ${url} in a browser` };
    return { host: 'none', detail: `Open ${url} in a browser or run: anywhere tui` };
  }

  // ----- always on top for app windows

  _cancelTopmost() {
    if (this._topmost) this._topmost.cancelled = true;
    this._topmost = null;
  }

  /**
   * Whether the driver can pin windows on top. macOS cannot (DarwinDriver.setTopmost always
   * returns false); the daemon hands UiHost a lazy driver that cannot report supportsTopmost
   * synchronously, so the platform is checked too.
   */
  _topmostSupported() {
    const d = this.driver;
    if (!d || typeof d.setTopmost !== 'function' || d.supportsTopmost === false) return false;
    return !(this.platformInfo && this.platformInfo.platform === 'darwin');
  }

  _scheduleTopmost() {
    this._cancelTopmost();
    const ui = this._ui();
    const d = this.driver;
    if (!ui.alwaysOnTop || !d || typeof d.listWindows !== 'function' || !this._topmostSupported()) return null;
    const token = { cancelled: false, promise: null };
    this._topmost = token;
    token.promise = (async () => {
      const deadline = Date.now() + this.topmostWaitMs;
      while (!token.cancelled && Date.now() < deadline) {
        try {
          const wins = await withTimeout(d.listWindows(BACKGROUND_LIST), 3000, 'listing windows');
          const w = this._pick(wins);
          if (w) {
            const ok = await withTimeout(d.setTopmost(w.id, true), 3000, 'setTopmost').catch(() => false);
            if (!ok) log.debug('the window manager did not accept always-on-top for the app window');
            return Boolean(ok);
          }
        } catch (err) {
          if (err && err.code === 'UNSUPPORTED') return false;
          log.debug(`waiting for the dialog window: ${err.message}`);
        }
        await sleep(400);
      }
      return false;
    })().catch(() => false);
    return token.promise;
  }

  // ----- window search

  /** pickWindow over a fresh listing; ids that predate the daemon and are gone are forgotten (ids get reused). */
  _pick(wins) {
    if (this._staleIds.size && Array.isArray(wins)) {
      const present = new Set(wins.filter((w) => w && w.id != null).map((w) => String(w.id)));
      for (const id of this._staleIds) if (!present.has(id)) this._staleIds.delete(id);
    }
    return pickWindow(wins, { pids: this._ownedPids(), stale: this._staleIds });
  }

  /**
   * Look for the dialog window.
   * @returns {Promise<{win:object|null, listed:boolean}>} listed is false when the windows could
   *   not be listed at all (no driver, GNOME/KDE on Wayland, a failing or slow driver): then a
   *   missing window says nothing about whether the dialog is open.
   */
  async _findWindow() {
    const d = this.driver;
    if (!d || typeof d.listWindows !== 'function') return { win: null, listed: false };
    try {
      const wins = await withTimeout(d.listWindows(BACKGROUND_LIST), this.driverTimeoutMs, 'listing windows');
      return { win: this._pick(wins), listed: true };
    } catch (err) {
      if (err && err.code === 'UNSUPPORTED') log.debug(`this desktop cannot list windows: ${err.message}`);
      else log.debug(`cannot list windows: ${err.message}`);
      return { win: null, listed: false };
    }
  }

  /**
   * Ask the driver to focus a window.
   * @returns {Promise<'focused'|'failed'|'pending'>} 'pending' when the request outlived our wait
   *   and is still running: on macOS it waits behind the Automation consent prompt (System Events)
   *   or a context probe in the helper queue, and raises the window once it gets through.
   */
  async _focus(id) {
    const d = this.driver;
    if (!d || typeof d.focusWindow !== 'function') return 'failed';
    try {
      return (await withTimeout(d.focusWindow(id), this.driverTimeoutMs, 'focusing the window')) ? 'focused' : 'failed';
    } catch (err) {
      if (err && err.code === TIMEOUT_CODE) {
        log.info(`focusing the dialog window is taking a while (${err.message}); it comes forward when the request completes`);
        return 'pending';
      }
      log.debug(`cannot focus the dialog window: ${err.message}`);
      return 'failed';
    }
  }

  /**
   * A dialog page reports whether it can be seen: after a 'show' event and whenever that changes
   * (document.hidden is true for a minimized window or a background tab).
   * @param {{page:string, visible:boolean, focused?:boolean}} report
   */
  noteVisibility({ page, visible, focused } = {}) {
    if (typeof page !== 'string' || !page) return;
    this._visibilitySeq += 1;
    const entry = { visible: Boolean(visible), focused: Boolean(focused), seq: this._visibilitySeq };
    this._visibility.delete(page);
    this._visibility.set(page, entry);
    while (this._visibility.size > MAX_VISIBILITY_PAGES) this._visibility.delete(this._visibility.keys().next().value);
    for (const w of [...this._visibilityWaiters]) w(entry);
  }

  /**
   * The daemon's dialog pages connected or left (the hub's 'clients' event): a page that connected counts
   * as on screen, with an unknown focus, until it reports (dialogState()).
   */
  notePages() {
    const n = this._clientCount();
    for (let i = this._pagesSeen; i < n; i += 1) {
      this._visibilitySeq += 1;
      this._pageConnects.push(this._visibilitySeq);
    }
    while (this._pageConnects.length > MAX_VISIBILITY_PAGES) this._pageConnects.shift();
    this._pagesSeen = n;
  }

  /**
   * Whether a dialog page is on screen and has the focus, from the pages' reports: the newest report (or
   * connection, see notePages()) for each connected page decides. focused null: unknown (a page that has
   * not reported yet). F3-SAFE-D1: where windows cannot be listed (GNOME/KDE Wayland), an engine's pointer
   * input waits while a page is on screen, and its keys while one may have the focus.
   * @returns {{visible:boolean, focused:boolean|null}|null} null: no dialog page is connected
   */
  dialogState() {
    const n = this._clientCount();
    if (n <= 0) return null;
    const entries = [...this._visibility.values(), ...this._pageConnects.map((seq) => ({ visible: true, focused: null, seq }))];
    const recent = entries.sort((a, b) => b.seq - a.seq).slice(0, n);
    const unreported = recent.length < n;
    const visible = unreported || recent.some((e) => e.visible);
    let focused = false;
    if (recent.some((e) => e.focused === true)) focused = true;
    else if (unreported || recent.some((e) => e.focused == null)) focused = null;
    return { visible, focused };
  }

  /**
   * Whether a dialog page reports itself visible after report number `since`, waiting up to `ms`
   * for one (less once every connected page has answered hidden).
   * @returns {Promise<boolean>}
   */
  _waitForVisiblePage(since, ms) {
    const fresh = () => [...this._visibility.values()].filter((e) => e.seq > since);
    if (fresh().some((e) => e.visible)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const done = (v) => {
        clearTimeout(timer);
        this._visibilityWaiters.delete(onReport);
        resolve(v);
      };
      const onReport = (e) => {
        if (e.seq <= since) return;
        if (e.visible) done(true);
        else if (fresh().length >= Math.max(1, this._clientCount())) done(false);
      };
      // Not unref'd: show() is waiting on it (1.5 s at most).
      timer = setTimeout(() => done(false), Math.max(0, ms));
      this._visibilityWaiters.add(onReport);
    });
  }

  /** Connected dialog pages, from the daemon (0 when it did not say). */
  _clientCount() {
    if (!this._clientCountFn) return 0;
    try {
      return Number(this._clientCountFn()) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Where windows cannot be listed: whether the dialog is evidently open anyway. Our own app
   * browser still running means its window is (Chromium leaves when its last window closes,
   * except on macOS), and a connected dialog page means a window or tab shows it. Electron is
   * not covered: a second instance only forwards to the running one, which shows its window.
   */
  _dialogLikelyOpen() {
    if (this._host !== 'app' && this._host !== 'browser') return false;
    if (this._host === 'app' && this.platformInfo.platform !== 'darwin' && this._ownedLive().some((o) => o.host === 'app')) return true;
    return this._clientCount() > 0;
  }

  // ----- leftovers of a previous daemon

  /**
   * Once per UiHost, before its first window search or launch: deal with what a previous daemon
   * left behind. A daemon that crashed or was killed leaves its app window running. That page
   * holds a dead access key, and launching again with the same --user-data-dir only adds a
   * window to that browser, beneath which the dead one would keep matching "Claude Anywhere".
   * The daemon's start lock guarantees that no live daemon of this state directory owns them.
   */
  async _cleanupOnce() {
    if (this._cleanedUp) return;
    this._cleanedUp = true;
    if (!this._cleanupLeftovers) return;
    let kept = [];
    try {
      kept = await this._stopLeftoverBrowsers();
    } catch (err) {
      log.debug(`could not look for dialog browsers left by a previous run: ${err.message}`);
    }
    await this._notePreexistingWindows(kept);
  }

  /**
   * Stop browsers still running with our dialog profile (only when the app host may be used).
   * @returns {Promise<number[]>} pids of a macOS instance left running because it also holds
   *   the user's own windows (links opened while their copy of the browser was closed)
   */
  async _stopLeftoverBrowsers() {
    if (!hostOrder(this._ui().host).includes('app')) return [];
    const pi = this.platformInfo;
    let dirs;
    try {
      dirs = [this._profileDir()];
    } catch {
      return [];
    }
    if (pi.platform === 'darwin') {
      const v = await this._macAppInstanceInUse({ dirs, pids: [] });
      if (!v.pids.length) return [];
      if (v.inUse) return v.pids;
      log.info('stopping the dialog browser a previous run left behind');
      await this._killProfileProcesses(dirs);
      return [];
    }
    if (pi.platform === 'linux') {
      // Snap browsers keep their profile under ~/snap/<name>/common.
      const cands = findChromiumCandidates({
        platformInfo: pi,
        env: this.env,
        which: this._which,
        exists: this._exists,
        realpath: this._realpath,
        readHead: this._readHead,
        homedir: this._homedir,
        profileDir: dirs[0],
      });
      for (const c of cands) if (c.profileDir && !dirs.includes(c.profileDir)) dirs.push(c.profileDir);
      if (pi.isWSL && (await this._powershellPath())) dirs.push(WSL_PROFILE_KEY);
    }
    await this._killProfileProcesses(dirs);
    return [];
  }

  /**
   * Remember the dialog-like windows that exist before this daemon opens anything (a dead page
   * a sweep could not stop, an old browser tab), so pickWindow prefers the window opened now.
   * @param {number[]} instancePids processes of a macOS dialog browser that was left running
   */
  async _notePreexistingWindows(instancePids = []) {
    const d = this.driver;
    if (!d || typeof d.listWindows !== 'function') return;
    const pidSet = new Set(instancePids.map(Number));
    try {
      const wins = await withTimeout(d.listWindows(BACKGROUND_LIST), this.driverTimeoutMs, 'listing windows');
      for (const w of Array.isArray(wins) ? wins : []) {
        if (!w || w.id == null) continue;
        if (String(w.title || '').includes(WINDOW_TITLE) || (w.pid && pidSet.has(Number(w.pid)))) this._staleIds.add(String(w.id));
      }
    } catch (err) {
      log.debug(`cannot list windows before opening the dialog: ${err.message}`);
    }
  }

  // ----- public API

  /**
   * Open the dialog with the configured host, falling back as needed.
   * @param {string} url the daemon URL (with ?token=)
   * @returns {Promise<{host:'electron'|'app'|'browser'|'none', detail:string}>}
   */
  open(url) {
    if (this._closed) return Promise.resolve({ host: 'none', detail: 'the daemon is shutting down' });
    return this._serialize(() => (this._closed ? { host: 'none', detail: 'the daemon is shutting down' } : this._open(url)));
  }

  async _open(url) {
    if (!url) throw new Error('UiHost.open(url): url is required');
    await this._cleanupOnce();
    this._url = url;
    const requested = String(this._ui().host || 'auto').trim().toLowerCase();
    if (!KNOWN_HOSTS.includes(requested)) log.warn(`unknown ui.host "${requested}"; using auto`);
    const order = hostOrder(requested);
    const explicit = requested !== 'auto' && KNOWN_HOSTS.includes(requested);
    const failures = [];
    for (const host of order) {
      if (host === 'none') {
        if (failures.length) log.warn(`no dialog window could be opened (${failures.join(' | ')})`);
        this._host = 'none';
        this._external = false;
        return this._noneResult(url);
      }
      let r;
      try {
        if (host === 'electron') r = await this._tryElectron(url);
        else if (host === 'app') r = await this._tryApp(url);
        else r = await this._tryBrowser(url);
      } catch (err) {
        r = { ok: false, reason: err.message };
      }
      if (r.ok) {
        if (explicit && host !== requested) {
          log.warn(`ui.host "${requested}" is unavailable (${failures.join(' | ')}); using ${host} instead`);
        } else if (failures.length) {
          log.info(`dialog host fallbacks: ${failures.join(' | ')}`);
        }
        this._host = host;
        this._external = host === 'browser' || Boolean(r.handedOff) || !this._ownedLive().some((o) => o.host === host);
        log.info(`dialog opened with ${host}: ${r.detail}`);
        return { host, detail: r.detail };
      }
      failures.push(`${host}: ${r.reason}`);
      log.debug(`dialog host ${host} failed: ${r.reason}`);
    }
    return this._noneResult(url);
  }

  /**
   * Bring the dialog to the front: focus the existing "Claude Anywhere" window through the
   * driver, otherwise reopen it. The daemon has already broadcast a 'show' event, which an open
   * page answers with window.focus() and a visibility report (noteVisibility()).
   * @param {string} [url]
   * @returns {Promise<{host:string}>}
   */
  show(url) {
    if (this._closed) return Promise.resolve({ host: 'none' });
    // Pages answer the 'show' event broadcast just before this call: reports from now on.
    const since = this._visibilitySeq;
    return this._serialize(async () => {
      // A show queued behind close() (daemon shutdown) must not launch a new window.
      if (this._closed) return { host: 'none' };
      await this._cleanupOnce();
      const target = url || this._url;
      const { win, listed } = await this._findWindow();
      if (win) {
        const focus = await this._focus(win.id);
        if (focus === 'focused') {
          if (this._host === 'app' && this._ui().alwaysOnTop && this._topmostSupported()) {
            Promise.resolve()
              .then(() => this.driver.setTopmost(win.id, true))
              .catch(() => {});
          }
          return { host: this._host || 'browser' };
        }
        // The window exists and the request will still raise it: another launch would only
        // add a second dialog window.
        if (focus === 'pending') return { host: this._host || 'browser' };
      }
      if (!target) return { host: this._host || 'none' };
      if (!listed && this._dialogLikelyOpen()) {
        // window.focus() cannot bring back a minimized window (Chromium, Wayland compositors). Pages
        // that report their visibility say whether it worked; a hidden or silent one gets a new
        // window: a duplicate beats a dialog the user cannot reach.
        if (!this._visibility.size || (await this._waitForVisiblePage(since, this.visibleWaitMs))) {
          log.info('windows cannot be listed here, but the dialog is open; asking it to come forward instead of opening another window');
          return { host: this._host };
        }
        log.info('the dialog page is connected but not visible (minimized or hidden); opening a window');
      }
      const live = this._ownedLive();
      if (this._host === 'electron' && live.some((o) => o.host === 'electron')) {
        // A second instance forwards to the running one (single-instance lock), which shows its window.
        const r = await this._tryElectron(target);
        if (r.ok) return { host: 'electron' };
      }
      if (this._host === 'app') {
        // Hands off to the running browser of our profile (new window) or starts a new one.
        const r = await this._tryApp(target).catch((err) => ({ ok: false, reason: err.message }));
        if (r.ok) {
          this._url = target;
          if (r.handedOff || !this._ownedLive().some((o) => o.host === 'app')) this._external = true;
          return { host: 'app' };
        }
      }
      const res = await this._open(target);
      return { host: res.host };
    });
  }

  /**
   * Close only what we started: the Electron child and app-mode browsers using our profile.
   * Final: open() and show() launch nothing afterwards (LIFECYCLE-9).
   */
  close() {
    this._closed = true;
    return this._serialize(async () => {
      this._cancelTopmost();
      let keepApp = false;
      if (this.platformInfo.platform === 'darwin' && this._appProfiles.size) {
        keepApp = await this._macAppInstanceInUse()
          .then((v) => v.inUse)
          .catch((err) => {
            log.debug(`cannot check the dialog browser's windows: ${err.message}`);
            return false;
          });
      }
      const tasks = this._ownedLive()
        .filter((o) => !(keepApp && o.host === 'app'))
        .map((o) => this._killChild(o));
      if (this._appProfiles.size && !keepApp) tasks.push(this._killProfileProcesses());
      const results = await Promise.allSettled(tasks);
      for (const r of results) if (r.status === 'rejected') log.debug(`close: ${r.reason && r.reason.message}`);
      this._owned = [];
      this._appProfiles.clear();
      this._profilePids.clear();
      this._wslPid = null;
      this._host = null;
      this._external = false;
    });
  }

  /** @returns {{host:string, open:boolean}} */
  status() {
    const host = this._host || 'none';
    if (host === 'none') return { host, open: false };
    const ownedAlive = this._ownedLive().some((o) => o.host === host);
    return { host, open: ownedAlive || this._external };
  }

  /**
   * macOS: the dialog's browser instance is a regular LaunchServices app, so links opened while
   * the user's own copy of that browser is closed land in it, as normal windows. Before stopping
   * it, make sure it holds nothing but the dialog. If it holds more, close only the dialog window
   * (when the driver can) and leave the instance running.
   * @param {{dirs?:string[], pids?:Iterable<number>}} [o] the profile directories to look for
   *   (default: those our app windows were started with) and processes already known
   * @returns {Promise<{inUse:boolean, pids:number[]}>} inUse is true when the instance must be
   *   left running; pids are the instance's processes
   */
  async _macAppInstanceInUse({ dirs = [...this._appProfiles], pids: known } = {}) {
    const d = this.driver;
    const pids = new Set(known || this._profilePids);
    if (!known) for (const o of this._ownedLive()) if (o.host === 'app' && o.child.pid) pids.add(o.child.pid);
    const r = await this._run('ps', ['-A', '-ww', '-o', 'pid=,args='], { timeoutMs: 5000 });
    if (r && !r.error && r.code === 0) {
      for (const pid of findProfilePids(r.stdout, dirs, [process.pid])) pids.add(pid);
    }
    const found = [...pids];
    if (!found.length || !d || typeof d.listWindows !== 'function') return { inUse: false, pids: found };
    let wins;
    try {
      wins = await withTimeout(d.listWindows(BACKGROUND_LIST), this.driverTimeoutMs, 'listing windows');
    } catch (err) {
      log.debug(`cannot list windows; stopping the dialog browser: ${err.message}`);
      return { inUse: false, pids: found };
    }
    const v = classifyInstanceWindows(wins, found);
    if (v.onlyDialog) return { inUse: false, pids: found };
    let closed = 0;
    if (typeof d.closeWindow === 'function') {
      for (const w of v.dialog) {
        const ok = await withTimeout(d.closeWindow(w.id), this.driverTimeoutMs, 'closing the dialog window').catch(() => false);
        if (ok) closed += 1;
      }
    }
    const otherCount = v.others.length + (v.dialog.length ? v.unknown.length : Math.max(0, v.unknown.length - 1));
    log.info(
      `the dialog's browser also holds ${otherCount} other window(s); leaving it running` +
        (closed ? ' and closing only the dialog window' : ' (close the "Claude Anywhere" window yourself)')
    );
    return { inUse: true, pids: found };
  }

  _signal(rec, sig) {
    const pid = rec.child.pid;
    try {
      if (rec.group && pid) this._killFn(-pid, sig);
      else rec.child.kill(sig);
    } catch {
      try {
        rec.child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  }

  async _killChild(rec) {
    const { child } = rec;
    if (!child || child.exitCode != null || child.signalCode != null || rec.exited) return;
    if (this.platformInfo.platform === 'win32') {
      const r = await this._run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 5000 });
      if (r.code !== 0) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    this._signal(rec, 'SIGTERM');
    const w = await waitForExit(child, 2500);
    if (!w.exited) this._signal(rec, 'SIGKILL');
  }

  _alive(pid) {
    try {
      this._killFn(pid, 0);
      return true;
    } catch (err) {
      return Boolean(err && err.code === 'EPERM');
    }
  }

  /**
   * Stop the browser processes started with one of our profile directories.
   * @param {string[]} [dirs] profile directories (or WSL_PROFILE_KEY); default: those our app
   *   windows were started with
   */
  async _killProfileProcesses(dirs = [...this._appProfiles]) {
    const pi = this.platformInfo;
    const windowsSide = [];
    if (pi.platform === 'win32') windowsSide.push(...dirs.map((d) => psString(d)));
    else if (dirs.includes(WSL_PROFILE_KEY)) windowsSide.push(WSL_PROFILE_EXPR);
    const posixDirs = pi.platform === 'win32' ? [] : dirs.filter((d) => d !== WSL_PROFILE_KEY);

    if (windowsSide.length) {
      const ps = await this._powershellPath();
      if (ps) {
        for (const expr of windowsSide) {
          const r = await this._run(ps, psArgs(buildWinKillScript({ profileDirExpr: expr })), {
            timeoutMs: 8000,
            cwd: pi.isWSL && this._exists('/mnt/c') ? '/mnt/c' : undefined,
          });
          const m = /ANYWHERE_KILLED (\d+)/.exec(String(r.stdout || ''));
          log.debug(`closed ${m ? m[1] : 0} Windows browser process(es) of the dialog profile`);
        }
      }
    }
    if (!posixDirs.length) return;
    const r = await this._run('ps', ['-A', '-ww', '-o', 'pid=,args='], { timeoutMs: 5000 });
    if (r.error || r.code !== 0) {
      log.debug(`ps failed; cannot look for dialog browser processes: ${(r.error && r.error.message) || r.stderr}`);
      return;
    }
    const pids = findProfilePids(r.stdout, posixDirs, [process.pid]);
    if (!pids.length) return;
    for (const pid of pids) {
      try {
        this._killFn(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const deadline = Date.now() + 2000;
    let alive = pids;
    while (alive.length && Date.now() < deadline) {
      await sleep(100);
      alive = alive.filter((p) => this._alive(p));
    }
    for (const pid of alive) {
      try {
        this._killFn(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = {
  UiHost,
  WINDOW_TITLE,
  ELECTRON_MAIN,
  hostOrder,
  computeBounds,
  chromiumArgs,
  electronArgs,
  encodePowerShell,
  psArgs,
  psString,
  buildWslLaunchScript,
  buildWinKillScript,
  findChromiumCandidates,
  snapNameOf,
  browserOpenCommands,
  resolveElectron,
  pickWindow,
  classifyInstanceWindows,
  x11ScaleFrom,
  preferNonDefaultBrowser,
  orderMacCandidates,
  hasBrowserSpeech,
  readMacDefaultBrowserId,
  wslPowershellPath,
  MAC_BROWSERS,
  electronEnv,
  ELECTRON_URL_ENV,
  findProfilePids,
  waitForExit,
  cmdEscape,
};
