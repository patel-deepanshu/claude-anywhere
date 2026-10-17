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
const DRIVER_TIMEOUT_MS = 5000;
const UI_LOG_MAX_BYTES = 2 * 1024 * 1024;
const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const WSL_SYSTEM32 = '/mnt/c/Windows/System32';
const WSL_PROFILE_KEY = 'wsl:%LOCALAPPDATA%\\claude-anywhere\\ui-profile';
const WSL_PROFILE_EXPR = "(Join-Path $env:LOCALAPPDATA 'claude-anywhere\\ui-profile')";

const MAC_BROWSERS = [
  ['Google Chrome', 'Google Chrome'],
  ['Google Chrome Canary', 'Google Chrome Canary'],
  ['Microsoft Edge', 'Microsoft Edge'],
  ['Brave', 'Brave Browser'],
  ['Chromium', 'Chromium'],
  ['Vivaldi', 'Vivaldi'],
];

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
  if (noSandbox) args.push('--no-sandbox');
  return args;
}

/**
 * Arguments for `electron <args>`.
 * @param {{mainPath?:string,url:string,ui?:object,noSandbox?:boolean}} o
 * @returns {string[]}
 */
function electronArgs({ mainPath = ELECTRON_MAIN, url, ui = {}, noSandbox = false }) {
  const args = [];
  // Chromium refuses to start as root without this switch; it must precede the app path.
  if (noSandbox) args.push('--no-sandbox');
  args.push(
    mainPath,
    '--url', url,
    '--always-on-top', String(ui.alwaysOnTop !== false),
    '--hotkey', String(ui.hotkey || ''),
    '--hide-from-screenshots', String(ui.hideFromScreenshots !== false),
    '--width', String(Number(ui.width) > 0 ? Math.round(Number(ui.width)) : 440),
    '--height', String(Number(ui.height) > 0 ? Math.round(Number(ui.height)) : 720),
    '--position', String(ui.position || 'right')
  );
  return args;
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
  $list = @('--app=' + $url, '--user-data-dir=' + $profileDir, ${switches.map((s) => `'${s}'`).join(', ')})
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
 * @returns {Array<{name:string,cmd:string,prefixArgs:string[],kind:'path'|'mac-app'|'snap'|'flatpak',profileDir:string,bundle?:string}>}
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
    for (const [name, app] of MAC_BROWSERS) {
      for (const base of bases) {
        const bundle = path.posix.join(base, `${app}.app`);
        const exe = path.posix.join(bundle, 'Contents', 'MacOS', app);
        if (exists(exe)) add({ name, cmd: exe, prefixArgs: [], kind: 'mac-app', bundle });
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
 * package or under <stateDir>/electron, then `electron` on PATH.
 * @returns {{path:string, source:'env'|'module'|'path'}|null}
 */
function resolveElectron({
  env = process.env,
  exists = fs.existsSync,
  which = proc.which,
  resolveModule = (id, opts) => require.resolve(id, opts),
  loadModule = (p) => require(p),
  packageRoot = paths.PACKAGE_ROOT,
  stateDir = () => paths.stateDir(),
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
  if (onPath) return { path: onPath, source: 'path' };
  return null;
}

/**
 * Pick our dialog window from a driver window list: windows owned by our processes, then
 * exact, prefix and substring title matches for "Claude Anywhere".
 * @param {Array<{id:any,title?:string,pid?:number,minimized?:boolean}>} windows
 * @param {{pids?:number[]}} [opts]
 */
function pickWindow(windows, { pids = [] } = {}) {
  const pidSet = new Set((pids || []).filter((p) => Number(p) > 0).map(Number));
  let best = null;
  let bestRank = Infinity;
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || w.id == null) continue;
    const t = String(w.title || '');
    const pidMatch = Boolean(w.pid) && pidSet.has(Number(w.pid));
    let rank;
    if (pidMatch && t.includes(WINDOW_TITLE)) rank = 0;
    else if (t === WINDOW_TITLE) rank = 1;
    else if (pidMatch && t.trim()) rank = 2;
    else if (t.startsWith(WINDOW_TITLE)) rank = 3;
    else if (t.includes(WINDOW_TITLE)) rank = 4;
    else continue;
    if (w.minimized) rank += 0.5;
    if (rank < bestRank) {
      best = w;
      bestRank = rank;
    }
  }
  return best;
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
      timer = setTimeout(() => reject(new Error(`${what || 'operation'} timed out after ${ms} ms`)), ms);
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
   * @param {object} [opts.driver] OS driver (displays, listWindows, focusWindow, setTopmost)
   * Test seams: which, exists, spawn, run, env, getuid, kill, homedir, realpath, readHead,
   * resolveModule, loadModule, profileDir, stateDir, logFile, earlyExitMs, topmostWaitMs, browserWaitMs.
   */
  constructor({ config, platformInfo, driver, ...deps } = {}) {
    this.config = config || {};
    this.platformInfo = platformInfo || platform.info();
    this.driver = driver || null;
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

    this._host = null;
    this._external = false; // a window exists that we did not spawn directly (hand-off, `open -n`, WSL, browser tab)
    this._url = null;
    this._owned = []; // [{child, host, group}]
    this._appProfiles = new Set(); // profile dirs (or WSL_PROFILE_KEY) our app windows were started with
    this._wslPid = null;
    this._topmost = null;
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
    return pids.filter(Boolean);
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
  async _launch(cmd, args, { detached = false, shell = false, cwd, env, waitMs = this.earlyExitMs, windowsHide = false, logOutput = true } = {}) {
    const fd = logOutput ? this._stdioFd() : null;
    let child;
    try {
      child = this._spawn(cmd, args, {
        cwd,
        env: env || this.env,
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
        displays = await withTimeout(this.driver.displays(), DRIVER_TIMEOUT_MS, 'listing displays');
      } catch (err) {
        log.debug(`displays() failed; assuming ${DEFAULT_DISPLAY.width}x${DEFAULT_DISPLAY.height}: ${err.message}`);
      }
    }
    const pi = this.platformInfo;
    return computeBounds({
      displays,
      width: ui.width,
      height: ui.height,
      position: ui.position,
      useDpiScale: pi.platform === 'win32' || Boolean(pi.isWSL),
    });
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
      ...(this._resolveModule ? { resolveModule: this._resolveModule } : {}),
      ...(this._loadModule ? { loadModule: this._loadModule } : {}),
      stateDir: this._stateDir,
    });
    if (!found) return { ok: false, reason: 'Electron is not installed (optional: anywhere install --electron)' };
    const args = electronArgs({ url, ui: this._ui(), noSandbox: this._noSandbox() });
    const env = { ...this.env };
    // Inherited from VS Code extension hosts and similar; it would make Electron run as plain Node.
    delete env.ELECTRON_RUN_AS_NODE;
    const isShim = pi.platform === 'win32' && /\.(cmd|bat)$/i.test(found.path);
    const r = isShim
      ? await this._launch(proc.quoteWinArg(found.path), args.map(proc.quoteWinArg), { shell: true, env })
      : await this._launch(found.path, args, { env });
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
    return this._which('powershell.exe') || (this._exists(WSL_POWERSHELL) ? WSL_POWERSHELL : null) || this._which('pwsh.exe');
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
    const script = buildWslLaunchScript({ url, ...bounds, preferredExe });
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
    const why = errLine || (r.error && r.error.message) || String(r.stderr || '').trim().split(/\r?\n/)[0] || (r.timedOut ? 'timed out' : `exit code ${r.code}`);
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
    const candidates = findChromiumCandidates({
      platformInfo: pi,
      env: this.env,
      which: this._which,
      exists: this._exists,
      realpath: this._realpath,
      readHead: this._readHead,
      homedir: this._homedir,
      profileDir: defaultProfile,
    });
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
      const args = chromiumArgs({ url, profileDir: c.profileDir, ...bounds, noSandbox: noSandbox && c.kind !== 'flatpak' });
      let r;
      if (c.kind === 'mac-app' && this._which('open')) {
        // Launching through LaunchServices makes the browser its own "responsible process", so the
        // microphone prompt names the browser instead of the terminal that started the daemon.
        r = await this._launch(this._which('open'), ['-n', '-a', c.bundle, '--args', ...args], { detached: true });
      } else {
        // Own process group on POSIX so wrapper scripts (snap, flatpak) can be stopped as a unit.
        r = await this._launch(c.cmd, [...c.prefixArgs, ...args], { detached: posix });
      }
      if (r.ok) {
        if (r.child) this._own(r.child, 'app', posix);
        this._appProfiles.add(c.profileDir);
        this._scheduleTopmost();
        return { ok: true, detail: `${c.name} app window`, handedOff: r.handedOff };
      }
      reasons.push(`${c.name}: ${r.reason}`);
    }
    return { ok: false, reason: reasons.join('; ') || noBrowserHint(pi) };
  }

  async _tryBrowser(url) {
    const pi = this.platformInfo;
    if (pi.platform === 'linux' && !pi.isWSL && !this._linuxDisplay()) {
      return { ok: false, reason: 'no graphical display (DISPLAY/WAYLAND_DISPLAY is not set)' };
    }
    const cmds = browserOpenCommands({ platformInfo: pi, url, which: this._which, exists: this._exists, env: this.env });
    if (!cmds.length) {
      return { ok: false, reason: pi.platform === 'linux' ? 'no URL opener found (install xdg-utils: sudo apt install xdg-utils)' : 'no URL opener found' };
    }
    const reasons = [];
    for (const c of cmds) {
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

  _scheduleTopmost() {
    this._cancelTopmost();
    const ui = this._ui();
    const d = this.driver;
    if (!ui.alwaysOnTop || !d || typeof d.listWindows !== 'function' || typeof d.setTopmost !== 'function') return null;
    const token = { cancelled: false, promise: null };
    this._topmost = token;
    token.promise = (async () => {
      const deadline = Date.now() + this.topmostWaitMs;
      while (!token.cancelled && Date.now() < deadline) {
        try {
          const wins = await withTimeout(d.listWindows(), 3000, 'listing windows');
          const w = pickWindow(wins, { pids: this._ownedPids() });
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

  async _findWindow() {
    const d = this.driver;
    if (!d || typeof d.listWindows !== 'function') return null;
    try {
      const wins = await withTimeout(d.listWindows(), DRIVER_TIMEOUT_MS, 'listing windows');
      return pickWindow(wins, { pids: this._ownedPids() });
    } catch (err) {
      log.debug(`cannot list windows: ${err.message}`);
      return null;
    }
  }

  async _focus(id) {
    const d = this.driver;
    if (!d || typeof d.focusWindow !== 'function') return false;
    try {
      return Boolean(await withTimeout(d.focusWindow(id), DRIVER_TIMEOUT_MS, 'focusing the window'));
    } catch (err) {
      log.debug(`cannot focus the dialog window: ${err.message}`);
      return false;
    }
  }

  // ----- public API

  /**
   * Open the dialog with the configured host, falling back as needed.
   * @param {string} url the daemon URL (with ?token=)
   * @returns {Promise<{host:'electron'|'app'|'browser'|'none', detail:string}>}
   */
  open(url) {
    return this._serialize(() => this._open(url));
  }

  async _open(url) {
    if (!url) throw new Error('UiHost.open(url): url is required');
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
   * driver, otherwise reopen it.
   * @param {string} [url]
   * @returns {Promise<{host:string}>}
   */
  show(url) {
    return this._serialize(async () => {
      const target = url || this._url;
      const win = await this._findWindow();
      if (win && (await this._focus(win.id))) {
        if (this._host === 'app' && this._ui().alwaysOnTop && this.driver && typeof this.driver.setTopmost === 'function') {
          Promise.resolve()
            .then(() => this.driver.setTopmost(win.id, true))
            .catch(() => {});
        }
        return { host: this._host || 'browser' };
      }
      if (!target) return { host: this._host || 'none' };
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

  /** Close only what we started: the Electron child and app-mode browsers using our profile. */
  close() {
    return this._serialize(async () => {
      this._cancelTopmost();
      const tasks = this._ownedLive().map((o) => this._killChild(o));
      if (this._appProfiles.size) tasks.push(this._killProfileProcesses());
      const results = await Promise.allSettled(tasks);
      for (const r of results) if (r.status === 'rejected') log.debug(`close: ${r.reason && r.reason.message}`);
      this._owned = [];
      this._appProfiles.clear();
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

  async _killProfileProcesses() {
    const pi = this.platformInfo;
    const dirs = [...this._appProfiles];
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
  findProfilePids,
  waitForExit,
  cmdEscape,
};
