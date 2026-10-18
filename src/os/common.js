'use strict';

/**
 * OS-agnostic helpers that shell out: open URLs/paths/apps, desktop
 * notifications and text-to-speech on macOS, Windows, WSL and Linux.
 *
 * User text is never interpolated into scripts: AppleScript receives it as
 * argv, PowerShell scripts embed it as base64 literals (and are passed with
 * -EncodedCommand), and speech text travels on stdin where the engine allows.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const proc = require('../shared/proc');
const platform = require('../shared/platform');
const paths = require('../shared/paths');
const { createLogger } = require('../shared/log');

const log = createLogger('os-common');

const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'vbscript']);
// An absolute Windows path: a drive path (C:\x, C:/x) or a UNC path (\\server\share, \\wsl.localhost\...).
const WIN_ABS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/;

/**
 * Spawn a detached process and wait briefly for an early failure.
 * Resolves `{ok, pid, code, signal, running, error}`; never rejects.
 */
function launchDetached(cmd, args = [], { waitMs = 800, cwd, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = proc.spawnDetached(cmd, args, { cwd, env });
    } catch (error) {
      resolve({ ok: false, error });
      return;
    }
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: true, pid: child.pid, running: true }), waitMs);
    child.once('error', (error) => finish({ ok: false, error }));
    child.once('exit', (code, signal) => finish({ ok: code === 0, pid: child.pid, code, signal, running: false }));
  });
}

function defaultRunner() {
  return {
    run: proc.run,
    which: proc.which,
    spawn: (cmd, args, opts) => childProcess.spawn(cmd, args, opts),
    launch: launchDetached,
    info: () => platform.info(),
    env: process.env,
    exists: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
    cwd: () => process.cwd(),
    homedir: () => os.homedir(),
  };
}

let R = defaultRunner();

/**
 * Test hook: override how commands are run. Pass a partial object with any of
 * run, which, spawn, launch, info, env, exists, cwd, homedir; pass null to reset.
 * @param {object|null} overrides
 */
function _setRunner(overrides) {
  R = overrides ? { ...defaultRunner(), ...overrides } : defaultRunner();
}

function makeError(message, code, hint) {
  const err = new Error(message);
  if (code) err.code = code;
  if (hint) err.hint = hint;
  return err;
}

function osFlavor(info) {
  if (info.platform === 'darwin') return 'darwin';
  if (info.platform === 'win32') return 'win32';
  return info.isWSL ? 'wsl' : 'linux';
}

function cleanText(s, max) {
  if (s == null) return '';
  let t = String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  if (max && t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t;
}

// ---------------------------------------------------------------- PowerShell

/** A PowerShell expression evaluating to exactly `str` (immune to quoting). */
function psString(str) {
  const b64 = Buffer.from(String(str), 'utf8').toString('base64');
  return `([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')))`;
}

/** Arguments that run `script` with -EncodedCommand (UTF-16LE base64). */
function psArgs(script) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

const PS_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
].join('\n');

function powershellPath(info) {
  if (info.platform === 'win32') {
    const root = R.env.SystemRoot || R.env.windir || 'C:\\Windows';
    const builtin = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return R.which('powershell.exe') || R.which('powershell') || (R.exists(builtin) ? builtin : null) || R.which('pwsh.exe');
  }
  return R.which('powershell.exe') || (R.exists(WSL_POWERSHELL) ? WSL_POWERSHELL : null) || R.which('pwsh.exe');
}

function psCwd(info) {
  // From WSL, a Linux cwd becomes a UNC path that cmd-based shims warn about.
  return info.isWSL && R.exists('/mnt/c') ? '/mnt/c' : undefined;
}

function requirePowershell(info) {
  const ps = powershellPath(info);
  if (!ps) {
    throw makeError(
      'PowerShell (powershell.exe) was not found',
      'UNSUPPORTED',
      info.isWSL
        ? 'Enable WSL interop so Windows executables run from Linux (check /etc/wsl.conf [interop] enabled=true and appendWindowsPath=true), then restart WSL with `wsl --shutdown`.'
        : 'Windows PowerShell ships with Windows; make sure %SystemRoot%\\System32\\WindowsPowerShell\\v1.0 is on PATH.'
    );
  }
  return ps;
}

function lastJsonLine(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

async function runPs(info, script, { timeoutMs = 20000, input } = {}) {
  const ps = requirePowershell(info);
  const res = await R.run(ps, psArgs(`${PS_PRELUDE}\n${script}`), { timeoutMs, input, cwd: psCwd(info) });
  // Windows PowerShell writes the errors of an -EncodedCommand as CLIXML: keep their plain text.
  return res && typeof res.stderr === 'string' ? { ...res, stderr: proc.psErrorText(res.stderr) } : res;
}

/** Quote one argument for CommandLineToArgvW (the C runtime convention). */
function quoteWinArgv(arg) {
  const s = String(arg);
  if (s && !/[\s"]/.test(s)) return s;
  let out = '"';
  let bs = 0;
  for (const ch of s) {
    if (ch === '\\') {
      bs++;
      continue;
    }
    if (ch === '"') {
      out += `${'\\'.repeat(bs * 2 + 1)}"`;
    } else {
      out += '\\'.repeat(bs) + ch;
    }
    bs = 0;
  }
  return `${out}${'\\'.repeat(bs * 2)}"`;
}

// ---------------------------------------------------------------- classification

function normalizeUrl(t) {
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#].*)?$/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+:\d+([/?#].*)?$/.test(t)) return `http://${t}`;
  if (/^www\.[\w-]+(\.[\w-]+)+([/?#:].*)?$/i.test(t)) return `https://${t}`;
  return null;
}

function urlScheme(t) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(t);
  if (!m || m[1].length === 1) return null; // "C:\..." is a drive letter, not a scheme
  return m[1].toLowerCase();
}

function checkUrl(url) {
  const scheme = urlScheme(url);
  if (!scheme) throw makeError(`"${url}" is not a URL`, 'INVALID_INPUT');
  if (BLOCKED_SCHEMES.has(scheme)) {
    throw makeError(`Refusing to open a ${scheme}: URL`, 'BLOCKED', 'Only http(s), file, mailto and app-specific schemes can be opened.');
  }
  if (/[\u0000-\u001F\u007F]/.test(url)) throw makeError('URL contains control characters', 'INVALID_INPUT');
  return url.replace(/ /g, '%20');
}

function expandPath(p, cwd, P = path) {
  let s = p;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = P.join(R.homedir(), s.slice(1));
  return P.resolve(cwd || R.cwd(), s);
}

/**
 * Decode a file: URL into a path for `flavor`. On Windows and WSL a drive
 * letter (file:///C:/x, file://localhost/C:/x) or a host (file://server/share)
 * gives a Windows path; elsewhere only local URLs are accepted.
 */
function fileUrlToPath(t, flavor) {
  const m = /^file:(?:\/\/([^/?#]*))?([^?#]*)/i.exec(t);
  let host;
  let p;
  try {
    host = decodeURIComponent(m[1] || '');
    p = decodeURIComponent(m[2] || '');
  } catch {
    throw makeError(`Malformed file URL: ${t}`, 'INVALID_INPUT', 'Percent-encode special characters (a space is %20), or pass a plain path.');
  }
  if (/^[A-Za-z][:|]$/.test(host)) {
    // file://C:/x: the drive letter was parsed as the host.
    p = `/${host}${p}`;
    host = '';
  }
  if (host.toLowerCase() === 'localhost') host = '';
  const windows = flavor === 'win32' || flavor === 'wsl';
  if (host) {
    if (windows) return `\\\\${host}${p.replace(/\//g, '\\')}`;
    throw makeError(`Cannot open a file URL on another host (${host})`, 'INVALID_INPUT', 'Use a local file:///... URL or a plain path.');
  }
  if (!p) throw makeError(`File URL has no path: ${t}`, 'INVALID_INPUT');
  const drive = /^\/?([A-Za-z])[:|]([\\/].*)?$/.exec(p);
  if (drive && windows) return `${drive[1].toUpperCase()}:${(drive[2] || '/').replace(/\//g, '\\')}`;
  return flavor === 'win32' ? p.replace(/\//g, '\\') : p;
}

async function wslToLinuxPath(p) {
  const res = await R.run('wslpath', ['-u', p], { timeoutMs: 5000 });
  const out = String(res.stdout || '').trim();
  return res.code === 0 && out ? out : null;
}

/**
 * Whether a Windows path exists, checked from WSL through its Linux form. Paths
 * that have no Linux form (\\server\share, a drive not mounted in WSL) count
 * as existing: Windows reports the error if they do not.
 */
async function wslWindowsPathExists(winPath) {
  const linux = await wslToLinuxPath(winPath);
  if (!linux || R.exists(linux)) return true;
  const drive = /^[A-Za-z]:\\/.exec(winPath);
  if (!drive) return false;
  const root = await wslToLinuxPath(drive[0]);
  return !root || !R.exists(root);
}

/**
 * Resolve a path against `cwd` for `flavor`: {value, exists}. On WSL a Windows
 * path is kept in Windows form (it is opened as given) and checked through
 * `wslpath -u`.
 */
async function locatePath(p, cwd, flavor) {
  if (flavor === 'wsl' && WIN_ABS_PATH.test(p)) {
    const value = path.win32.normalize(p);
    return { value, exists: await wslWindowsPathExists(value) };
  }
  const abs = expandPath(p, cwd, flavor === 'win32' ? path.win32 : path.posix);
  return { value: abs, exists: R.exists(abs) };
}

/** Decide what `target` is: {kind:'url'|'path'|'app', value}. */
async function classify(target, kind, cwd, flavor) {
  const t = String(target == null ? '' : target).trim();
  if (!t) throw makeError('Nothing to open: target is empty', 'INVALID_INPUT');
  // host:port and www. forms first: "localhost:3000" would otherwise parse as scheme "localhost".
  const norm = normalizeUrl(t);
  if (kind === 'url') {
    const url = norm || (urlScheme(t) ? t : `https://${t}`);
    return { kind: 'url', value: checkUrl(url) };
  }
  if (kind === 'path') {
    const p = /^file:\//i.test(t) ? fileUrlToPath(t, flavor) : t;
    const loc = await locatePath(p, cwd, flavor);
    if (!loc.exists) throw makeError(`Path does not exist: ${loc.value}`, 'NOT_FOUND');
    return { kind: 'path', value: loc.value };
  }
  if (kind === 'app') return { kind: 'app', value: t };
  // auto
  if (norm) return { kind: 'url', value: checkUrl(norm) };
  if (flavor === 'wsl' && /^file:\//i.test(t)) {
    // Windows would read file:///home/me/x as C:\home\me\x: open the Linux file as a path instead.
    const p = fileUrlToPath(t, flavor);
    if (p.startsWith('/')) return classify(p, 'path', cwd, flavor);
  }
  if (urlScheme(t)) return { kind: 'url', value: checkUrl(t) };
  const loc = await locatePath(t, cwd, flavor);
  if (loc.exists) return { kind: 'path', value: loc.value };
  if (/[\\/]/.test(t) || t.startsWith('.') || t.startsWith('~')) {
    throw makeError(`Path does not exist: ${loc.value}`, 'NOT_FOUND');
  }
  return { kind: 'app', value: t };
}

// ---------------------------------------------------------------- per-OS openers

// Chromium browsers (app bundle names, lower case). A second instance started with `open -n`
// hands its whole command line to the instance that owns the default profile (or becomes it),
// so URLs and flags reach the user's browser, never the dialog's own --user-data-dir instance.
const MAC_CHROMIUM_APPS = new Set([
  'google chrome',
  'google chrome beta',
  'google chrome dev',
  'google chrome canary',
  'chromium',
  'microsoft edge',
  'microsoft edge beta',
  'microsoft edge dev',
  'microsoft edge canary',
  'brave browser',
  'brave browser beta',
  'brave browser nightly',
  'vivaldi',
]);

// Prints whether an app (name, bundle path or id) is running, without launching it.
const MAC_APP_RUNNING_JXA = "function run(argv) { return Application(argv[0]).running() ? 'running' : 'stopped'; }";

/**
 * macOS: one argument for an app. A URL or an existing file or folder is a document: `open`
 * hands it over as an open-URL / open-documents event, which also reaches a running app, and
 * relative paths are resolved against `cwd` (apps started by LaunchServices run in /). Anything
 * else (flags, their values) is a command-line argument, which macOS gives only to an app that
 * `open` starts.
 * @returns {{doc?:string, arg?:string}}
 */
function darwinAppArg(a, cwd) {
  if (!a || a.startsWith('-')) return { arg: a };
  const norm = normalizeUrl(a);
  if (norm) return { doc: checkUrl(norm) };
  if (urlScheme(a) && (/^[a-z][a-z0-9+.-]*:\/\//i.test(a) || /^mailto:/i.test(a))) return { doc: checkUrl(a) };
  const abs = expandPath(a, cwd, path.posix);
  if (R.exists(abs)) return { doc: abs };
  return { arg: a };
}

/** Whether a macOS app is running: true, false, or null when that cannot be told. */
async function darwinAppRunning(app) {
  const res = await R.run('osascript', ['-l', 'JavaScript', '-e', MAC_APP_RUNNING_JXA, app], { timeoutMs: 5000 });
  const out = String(res.stdout || '').trim();
  if (res.code === 0 && (out === 'running' || out === 'stopped')) return out === 'running';
  return null;
}

/** @returns {Promise<{how:string, note?:string}>} */
async function openDarwin(kind, value, args, cwd) {
  const asApp = kind === 'app' || (kind === 'path' && /\.app\/?$/i.test(value) && args.length > 0);
  if (!asApp) {
    const res = await R.run('open', [value], { timeoutMs: 20000 });
    if (res.code === 0) return { how: 'open' };
    throw darwinOpenError(res);
  }
  const parsed = args.map((a) => darwinAppArg(a, cwd));
  let argv;
  let how = 'open -a';
  let note;
  if (args.length && MAC_CHROMIUM_APPS.has(path.posix.basename(value).replace(/\.app$/i, '').toLowerCase())) {
    argv = ['-n', '-a', value, '--args', ...parsed.map((p) => p.doc || p.arg)];
    how = 'open -n -a';
  } else {
    const docs = parsed.filter((p) => p.doc).map((p) => p.doc);
    const rest = parsed.filter((p) => !p.doc).map((p) => p.arg);
    argv = ['-a', value, ...docs];
    if (rest.length) {
      if ((await darwinAppRunning(value)) === true) {
        how = `open -a; it was already running, so these arguments were not passed: ${rest.join(' ')}`;
        note =
          `${value} was already running, and macOS passes command-line arguments only to an app that open starts. ` +
          'URLs and existing files were handed over; quit the app and open it again to apply the other arguments.';
      } else {
        argv.push('--args', ...rest);
      }
    }
  }
  const res = await R.run('open', argv, { timeoutMs: 20000 });
  if (res.code === 0) return note ? { how, note } : { how };
  const msg = darwinOpenMessage(res);
  if (/unable to find application/i.test(msg)) {
    // Not an app bundle name: a command on PATH such as `code` or `subl`, started in cwd.
    const exe = !value.includes('/') ? R.which(value) : null;
    if (exe) {
      const r = await R.launch(exe, args, { waitMs: 700, cwd: cwd || R.cwd() });
      if (r.ok) return { how: 'exec' };
      throw makeError(`Could not start ${exe}: ${launchFailure(value, r)}`, 'OPEN_FAILED');
    }
    throw makeError(
      `No application named "${value}" was found (in /Applications or on PATH)`,
      'NOT_FOUND',
      `Use the name shown in /Applications, e.g. "Google Chrome" or "Visual Studio Code". List apps with: mdfind "kMDItemKind == Application" | grep -i "${value.replace(/"/g, '')}"`
    );
  }
  throw darwinOpenError(res);
}

function darwinOpenMessage(res) {
  return (res.stderr || (res.error && res.error.message) || '').trim();
}

function darwinOpenError(res) {
  const msg = darwinOpenMessage(res);
  return makeError(`open failed${msg ? `: ${msg}` : res.timedOut ? ': timed out' : ''}`, 'OPEN_FAILED');
}

const PS_APP_SCRIPT = `
function Out-Result($how, $target) { [Console]::Out.WriteLine((@{ how = $how; target = [string]$target } | ConvertTo-Json -Compress)) }
function Start-Target($file) {
  if ($argLine) { Start-Process -FilePath $file -ArgumentList $argLine } else { Start-Process -FilePath $file }
}
function Find-Partial($items, $prop) {
  $items | Where-Object { ([string]$_.$prop).IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    Sort-Object { ([string]$_.$prop).Length } | Select-Object -First 1
}
try {
  $literal = [System.Management.Automation.WildcardPattern]::Escape($name)
  $cmd = Get-Command -Name $literal -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { Start-Target $cmd.Source; Out-Result 'path' $cmd.Source; exit 0 }
  $exe = if ($name -match '\\.exe$') { $name } else { "$name.exe" }
  foreach ($root in @('HKCU:', 'HKLM:')) {
    $key = $root + '\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + $exe
    if (Test-Path -LiteralPath $key) {
      $p = (Get-Item -LiteralPath $key).GetValue('')
      if ($p) { $p = [Environment]::ExpandEnvironmentVariables($p.Trim('"')); Start-Target $p; Out-Result 'app-paths' $p; exit 0 }
    }
  }
  $dirs = @([Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('StartMenu'),
            [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('Desktop')) |
          Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $links = @()
  if ($dirs) {
    $links = @(Get-ChildItem -LiteralPath $dirs -Recurse -File -ErrorAction SilentlyContinue |
               Where-Object { @('.lnk', '.url', '.appref-ms') -contains $_.Extension.ToLowerInvariant() })
  }
  $match = $links | Where-Object { $_.BaseName -ieq $name } | Select-Object -First 1
  if (-not $match) { $match = Find-Partial $links 'BaseName' }
  if ($match) { Start-Target $match.FullName; Out-Result 'start-menu' $match.FullName; exit 0 }
  if (Get-Command Get-StartApps -ErrorAction SilentlyContinue) {
    $apps = @(Get-StartApps)
    $app = $apps | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
    if (-not $app) { $app = Find-Partial $apps 'Name' }
    if ($app) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\\' + $app.AppID); Out-Result 'store-app' $app.Name; exit 0 }
  }
  [Console]::Out.WriteLine('{"error":"not_found"}')
  exit 3
} catch {
  [Console]::Out.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
  exit 1
}
`;

const PS_START_SCRIPT = `
try {
  if ($argLine) { Start-Process -FilePath $target -ArgumentList $argLine } else { Start-Process -FilePath $target }
  [Console]::Out.WriteLine('{"ok":true}')
  exit 0
} catch {
  [Console]::Out.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
  exit 1
}
`;

async function wslToWindowsPath(p) {
  const res = await R.run('wslpath', ['-w', p], { timeoutMs: 5000 });
  const out = String(res.stdout || '').trim();
  if (res.code !== 0 || !out) {
    throw makeError(`Could not convert ${p} to a Windows path${res.stderr ? `: ${res.stderr.trim()}` : ''}`, 'OPEN_FAILED');
  }
  return out;
}

/**
 * Arguments for a Windows program started from WSL: existing absolute Linux
 * paths become Windows paths (\\wsl.localhost\<distro>\..., C:\... for /mnt/c),
 * so `code /home/me/repo` opens that folder rather than C:\home\me\repo.
 */
async function wslArgsToWindows(args) {
  const out = [];
  for (const a of args) out.push(a.startsWith('/') && R.exists(a) ? await wslToWindowsPath(a) : a);
  return out;
}

async function openWindows(info, kind, value, args) {
  // URLs are started without arguments, so only apps and paths need them translated.
  const winArgs = info.isWSL && kind !== 'url' ? await wslArgsToWindows(args) : args;
  const argLine = winArgs.map(quoteWinArgv).join(' ');
  if (kind === 'app') {
    const script = `$name = ${psString(value)}\n$argLine = ${psString(argLine)}\n${PS_APP_SCRIPT}`;
    const res = await runPs(info, script, { timeoutMs: 30000 });
    const out = lastJsonLine(res.stdout) || {};
    if (res.code === 0 && out.how) return `Start-Process (${out.how})`;
    if (res.code === 3 || out.error === 'not_found') {
      const err = makeError(
        `No application named "${value}" was found`,
        'NOT_FOUND',
        'Use the name shown in the Start menu (e.g. "Google Chrome", "Visual Studio Code") or an executable such as chrome, code or notepad.'
      );
      throw err;
    }
    throw makeError(`Could not start "${value}": ${out.error || res.stderr.trim() || (res.timedOut ? 'timed out' : `exit ${res.code}`)}`, 'OPEN_FAILED');
  }
  let target = value;
  // A Windows path given on WSL (C:\..., \\server\share) is already in Windows form.
  if (kind === 'path' && info.isWSL && !WIN_ABS_PATH.test(value)) target = await wslToWindowsPath(value);
  const script = `$target = ${psString(target)}\n$argLine = ${psString(kind === 'path' ? argLine : '')}\n${PS_START_SCRIPT}`;
  const res = await runPs(info, script);
  const out = lastJsonLine(res.stdout) || {};
  if (res.code === 0 && out.ok) return 'Start-Process';
  throw makeError(`Could not open ${target}: ${out.error || res.stderr.trim() || (res.timedOut ? 'timed out' : `exit ${res.code}`)}`, 'OPEN_FAILED');
}

// --- Linux desktop entries

function desktopDirs() {
  const env = R.env;
  const home = env.HOME || R.homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const bases = [dataHome, ...dataDirs];
  if (!env.XDG_DATA_DIRS) {
    bases.push(path.join(home, '.local', 'share', 'flatpak', 'exports', 'share'), '/var/lib/flatpak/exports/share');
  }
  const dirs = bases.map((b) => path.join(b, 'applications'));
  if (!env.XDG_DATA_DIRS) dirs.push('/var/lib/snapd/desktop/applications');
  return [...new Set(dirs)];
}

function unescapeDesktopValue(v) {
  return v.replace(/\\([sntr\\])/g, (m, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c]);
}

/** Parse the [Desktop Entry] group of a .desktop file. */
function parseDesktopEntry(text) {
  const e = { name: '', localizedNames: [], genericName: '', exec: '', type: '', noDisplay: false, hidden: false, tryExec: '' };
  let inMain = false;
  for (const line of String(text).split(/\r?\n/)) {
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
    if (key === 'Name') e.name = unescapeDesktopValue(val);
    else if (key.startsWith('Name[')) e.localizedNames.push(unescapeDesktopValue(val));
    else if (key === 'GenericName') e.genericName = unescapeDesktopValue(val);
    else if (key === 'Exec') e.exec = val;
    else if (key === 'Type') e.type = val;
    else if (key === 'NoDisplay') e.noDisplay = val === 'true';
    else if (key === 'Hidden') e.hidden = val === 'true';
    else if (key === 'TryExec') e.tryExec = unescapeDesktopValue(val);
  }
  return e;
}

/**
 * Split a desktop-entry Exec value into argv, dropping field codes and
 * appending `args`.
 * @param {string} exec
 * @param {string[]} [args]
 * @returns {string[]}
 */
function parseExec(exec, args = []) {
  const s = unescapeDesktopValue(String(exec || ''));
  const tokens = [];
  let cur = '';
  let started = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\' && i + 1 < s.length && '"`$\\'.includes(s[i + 1])) {
        cur += s[++i];
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
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
  const out = [];
  for (const t of tokens) {
    if (/^%[fFuUdDnNickvm]$/.test(t)) continue;
    const v = t.replace(/%([fFuUdDnNickvm%])/g, (m, c) => (c === '%' ? '%' : ''));
    if (!v && t) continue;
    out.push(v);
  }
  return [...out, ...args.map(String)];
}

function listDesktopFiles(dir, prefix = '', depth = 0, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory() && depth < 2) {
      listDesktopFiles(full, `${prefix}${ent.name}-`, depth + 1, out);
    } else if (ent.name.endsWith('.desktop') && (ent.isFile() || ent.isSymbolicLink())) {
      out.push({ id: `${prefix}${ent.name}`, file: full });
    }
  }
  return out;
}

/**
 * Find the best .desktop entry for an app name (case-insensitive). User
 * directories shadow system ones with the same desktop-file id.
 * @param {string} name
 * @returns {{id:string,file:string,name:string,exec:string}|null}
 */
function findDesktopEntry(name) {
  const q = String(name).trim().toLowerCase();
  if (!q) return null;
  const seen = new Set();
  let best = null;
  for (const dir of desktopDirs()) {
    for (const { id, file } of listDesktopFiles(dir)) {
      if (seen.has(id)) continue;
      seen.add(id);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const e = parseDesktopEntry(text);
      if (e.hidden || (e.type && e.type !== 'Application') || !e.exec) continue;
      if (e.tryExec && !R.which(e.tryExec)) continue;
      const base = id.replace(/\.desktop$/, '').toLowerCase();
      const shortId = base.split('.').pop();
      const nm = e.name.toLowerCase();
      let score = 0;
      if (nm === q) score = 100;
      else if (base === q || shortId === q) score = 90;
      else if (e.localizedNames.some((n) => n.toLowerCase() === q)) score = 80;
      else if (e.genericName && e.genericName.toLowerCase() === q) score = 60;
      else if (nm && nm.includes(q)) score = 40 - Math.min(20, nm.length - q.length) / 2;
      else if (base.includes(q)) score = 30 - Math.min(20, base.length - q.length) / 2;
      if (!score) continue;
      if (e.noDisplay) score -= 5;
      if (!best || score > best.score) best = { score, id, file, name: e.name, exec: e.exec };
    }
  }
  if (!best) return null;
  const { score, ...entry } = best;
  return entry;
}

function launchFailure(cmd, r) {
  if (r.error) return r.error.code === 'ENOENT' ? `${cmd} not found` : r.error.message;
  return `${cmd} exited with code ${r.code}${r.signal ? ` (${r.signal})` : ''}`;
}

async function openLinuxUrlOrPath(kind, value) {
  const candidates = [
    ['xdg-open', [value]],
    ['gio', ['open', value]],
  ];
  if (kind === 'url' && /^https?:/i.test(value)) {
    candidates.push(['sensible-browser', [value]], ['x-www-browser', [value]], ['firefox', [value]], ['google-chrome', [value]], ['chromium', [value]]);
  }
  const errors = [];
  for (const [cmd, argv] of candidates) {
    const exe = R.which(cmd);
    if (!exe) continue;
    const r = await R.launch(exe, argv, { waitMs: 3000 });
    if (r.ok) return cmd;
    errors.push(launchFailure(cmd, r));
  }
  if (!errors.length) {
    throw makeError(`No program to open ${kind === 'url' ? 'URLs' : 'files'} was found`, 'UNSUPPORTED', 'Install xdg-utils: sudo apt install xdg-utils (Debian/Ubuntu) or sudo dnf install xdg-utils (Fedora).');
  }
  throw makeError(`Could not open ${value}: ${errors.join('; ')}`, 'OPEN_FAILED', 'Check that a default application is set: xdg-settings get default-web-browser');
}

async function openLinuxApp(name, args) {
  const lower = name.toLowerCase();
  const variants = [...new Set([name, lower, lower.replace(/\s+/g, '-'), lower.replace(/\s+/g, '')])].filter((v) => v && !/\s/.test(v));
  for (const v of variants) {
    const exe = R.which(v);
    if (!exe) continue;
    const r = await R.launch(exe, args, { waitMs: 700 });
    if (r.ok) return { how: 'exec', target: exe };
    throw makeError(`Could not start ${exe}: ${launchFailure(v, r)}`, 'OPEN_FAILED');
  }
  const entry = findDesktopEntry(name);
  if (entry) {
    const id = path.basename(entry.file);
    if (!args.length && R.which('gtk-launch')) {
      const r = await R.launch(R.which('gtk-launch'), [id], { waitMs: 3000 });
      if (r.ok) return { how: 'gtk-launch', target: id };
      log.debug('gtk-launch failed, falling back to Exec', launchFailure('gtk-launch', r));
    }
    const argv = parseExec(entry.exec, args);
    if (argv.length) {
      const exe = argv[0].includes('/') ? argv[0] : R.which(argv[0]) || argv[0];
      const r = await R.launch(exe, argv.slice(1), { waitMs: 700 });
      if (r.ok) return { how: 'desktop-exec', target: entry.file };
      throw makeError(`Could not start ${entry.name || id}: ${launchFailure(argv[0], r)}`, 'OPEN_FAILED');
    }
  }
  throw makeError(
    `No application named "${name}" was found on PATH or in .desktop files`,
    'NOT_FOUND',
    'Use the executable name (e.g. google-chrome, code, firefox, nautilus) or the name shown in the app menu.'
  );
}

/**
 * Open a URL, a file/folder, or an application.
 * @param {string} target URL, path (absolute, relative or ~), or app name
 * @param {{kind?:'auto'|'url'|'path'|'app',args?:string[],cwd?:string}} [opts]
 * @returns {Promise<{opened:boolean,kind:string,how:string,target:string}>}
 */
async function openTarget(target, opts = {}) {
  const { kind = 'auto', cwd } = opts || {};
  const args = opts && opts.args != null ? opts.args : [];
  if (!['auto', 'url', 'path', 'app'].includes(kind)) {
    throw makeError(`kind must be one of auto, url, path, app (got "${kind}")`, 'INVALID_INPUT');
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' && typeof a !== 'number')) {
    throw makeError('args must be an array of strings', 'INVALID_INPUT');
  }
  const strArgs = args.map(String);
  const info = R.info();
  const flavor = osFlavor(info);
  const { kind: k, value } = await classify(target, kind, cwd, flavor);
  let how;
  let note;
  if (flavor === 'darwin') {
    ({ how, note } = await openDarwin(k, value, strArgs, cwd));
  } else if (flavor === 'win32') {
    how = await openWindows(info, k, value, strArgs);
  } else if (flavor === 'wsl') {
    try {
      how = await openWindows(info, k, value, strArgs);
    } catch (err) {
      // A Linux GUI app (WSLg) is the fallback when no Windows app matches.
      const linuxExe = k === 'app' && err.code === 'NOT_FOUND' && (R.env.DISPLAY || R.env.WAYLAND_DISPLAY) ? R.which(value) : null;
      if (!linuxExe) throw err;
      const r = await R.launch(linuxExe, strArgs, { waitMs: 700 });
      if (!r.ok) throw makeError(`Could not start ${linuxExe}: ${launchFailure(value, r)}`, 'OPEN_FAILED');
      how = 'exec (WSLg)';
    }
  } else if (k === 'app') {
    how = (await openLinuxApp(value, strArgs)).how;
  } else {
    how = await openLinuxUrlOrPath(k, value);
  }
  log.debug('opened', k, value, how);
  const result = { opened: true, kind: k, how, target: value };
  if (note) result.note = note;
  return result;
}

// ---------------------------------------------------------------- notifications

const NOTIFY_APPLESCRIPT = `on run argv
  set theTitle to item 1 of argv
  set theBody to item 2 of argv
  display notification theBody with title theTitle
end run
`;

function ensureScriptFile(name, content) {
  const candidates = [];
  try {
    candidates.push(paths.runDir());
  } catch {
    /* fall through to tmpdir */
  }
  candidates.push(os.tmpdir());
  for (const dir of candidates) {
    const file = path.join(dir, name);
    try {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
        fs.writeFileSync(file, content, { mode: 0o600 });
      }
      return file;
    } catch {
      /* try the next directory */
    }
  }
  throw makeError(`Could not write helper script ${name}`, 'IO');
}

function balloonScript(title, body) {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$title = ${psString(title)}
$body = ${psString(body)}
$n = New-Object System.Windows.Forms.NotifyIcon
try {
  $n.Icon = [System.Drawing.SystemIcons]::Information
  $n.Text = 'Claude Anywhere'
  $n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $n.BalloonTipTitle = $title
  $n.BalloonTipText = $body
  $n.Visible = $true
  $n.ShowBalloonTip(6000)
  Start-Sleep -Seconds 7
} finally {
  $n.Visible = $false
  $n.Dispose()
}
`;
}

/**
 * Show a desktop notification. Throws (code UNSUPPORTED, with .hint) when no
 * notification mechanism is available.
 * @param {string} title
 * @param {string} [body]
 * @returns {Promise<{ok:true,how:string}>}
 */
async function notify(title, body = '') {
  const info = R.info();
  const flavor = osFlavor(info);
  let t = cleanText(title, 200).trim() || 'Claude Anywhere';
  let b = cleanText(body, 1000);
  if (flavor === 'darwin') {
    const script = ensureScriptFile('notify.applescript', NOTIFY_APPLESCRIPT);
    const res = await R.run('osascript', [script, t, b], { timeoutMs: 10000 });
    if (res.code === 0) return { ok: true, how: 'osascript' };
    throw makeError(`Notification failed: ${(res.stderr || (res.error && res.error.message) || `exit ${res.code}`).trim()}`, 'NOTIFY_FAILED', 'Allow notifications for Script Editor in System Settings > Notifications.');
  }
  if (flavor === 'win32' || flavor === 'wsl') {
    // Balloon tips allow ~63 title / ~255 body characters, and text must not be empty.
    t = cleanText(t, 63);
    b = cleanText(b, 255).trim() || t;
    const ps = requirePowershell(info);
    const r = await R.launch(ps, psArgs(`${PS_PRELUDE}\n${balloonScript(t, b)}`), { waitMs: 1500, cwd: psCwd(info) });
    if (r.ok) return { ok: true, how: 'NotifyIcon' };
    throw makeError(`Notification failed: ${launchFailure('powershell', r)}`, 'NOTIFY_FAILED');
  }
  const errors = [];
  const ns = R.which('notify-send');
  if (ns) {
    const res = await R.run(ns, ['--app-name=Claude Anywhere', '--icon=dialog-information', '--', t, b], { timeoutMs: 5000 });
    if (res.code === 0) return { ok: true, how: 'notify-send' };
    errors.push(`notify-send: ${(res.stderr || (res.timedOut ? 'timed out' : `exit ${res.code}`)).trim()}`);
  }
  const kd = R.which('kdialog');
  if (kd) {
    const r = await R.launch(kd, ['--title', t, '--passivepopup', b || t, '6'], { waitMs: 500 });
    if (r.ok) return { ok: true, how: 'kdialog' };
    errors.push(`kdialog: ${launchFailure('kdialog', r)}`);
  }
  if (errors.length) {
    throw makeError(`Notification failed: ${errors.join('; ')}`, 'NOTIFY_FAILED', 'Make sure a notification daemon is running in your desktop session.');
  }
  throw makeError('No desktop notification tool found', 'UNSUPPORTED', 'Install libnotify: sudo apt install libnotify-bin (Debian/Ubuntu) or sudo dnf install libnotify (Fedora).');
}

// ---------------------------------------------------------------- speech

let current = null; // { child, engine, winPid }
const WSL_TASKKILL = '/mnt/c/Windows/System32/taskkill.exe';

function speechRate(rate) {
  const r = Number(rate);
  return Number.isFinite(r) && r > 0 ? Math.min(4, Math.max(0.25, r)) : 1;
}

function sapiScript(rate, voice) {
  const sapiRate = Math.max(-10, Math.min(10, Math.round((Math.log(rate) / Math.log(3)) * 10)));
  // The PID line lets stopSpeaking() end the Windows process from WSL, where killing the
  // Linux-side relay does not stop powershell.exe (and so not the speech).
  return `
[Console]::Out.WriteLine('ANYWHERE_PID ' + $PID); [Console]::Out.Flush()
Add-Type -AssemblyName System.Speech
$stdin = [Console]::OpenStandardInput()
$ms = New-Object System.IO.MemoryStream
$stdin.CopyTo($ms)
$text = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
$voice = ${psString(voice || '')}
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $s.SetOutputToDefaultAudioDevice()
  $s.Rate = ${sapiRate}
  if ($voice) {
    $v = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } |
      Where-Object { $_.Name.IndexOf($voice, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
    if ($v) { $s.SelectVoice($v.Name) }
  }
  $s.Speak($text)
} finally { $s.Dispose() }
`;
}

function speechPlan(info, text, rate, voice) {
  const flavor = osFlavor(info);
  if (flavor === 'darwin') {
    const say = R.which('say') || (R.exists('/usr/bin/say') ? '/usr/bin/say' : null);
    if (!say) return null;
    const args = [];
    if (voice) args.push('-v', String(voice));
    args.push('-r', String(Math.round(175 * rate)), '-f', '-');
    return { engine: 'say', cmd: say, args, input: text };
  }
  if (flavor === 'win32' || flavor === 'wsl') {
    const ps = powershellPath(info);
    // System.Speech only exists in Windows PowerShell (not pwsh 7).
    if (!ps || /pwsh(\.exe)?$/i.test(ps)) return null;
    return { engine: 'sapi', cmd: ps, args: psArgs(`${PS_PRELUDE}\n${sapiScript(rate, voice)}`), input: text, cwd: psCwd(info) };
  }
  const spd = R.which('spd-say');
  if (spd) {
    const args = ['-w', '-r', String(Math.max(-100, Math.min(100, Math.round((rate - 1) * 100))))];
    if (voice) args.push('-y', String(voice));
    args.push('--', text);
    return { engine: 'spd-say', cmd: spd, args, input: null };
  }
  for (const name of ['espeak-ng', 'espeak']) {
    const exe = R.which(name);
    if (!exe) continue;
    const args = ['-s', String(Math.max(80, Math.min(500, Math.round(175 * rate))))];
    if (voice) args.push('-v', String(voice));
    args.push('--stdin');
    return { engine: name, cmd: exe, args, input: text };
  }
  return null;
}

function speechHint(info) {
  const flavor = osFlavor(info);
  if (flavor === 'darwin') return 'The macOS `say` command was not found at /usr/bin/say.';
  if (flavor === 'win32' || flavor === 'wsl') return 'Text-to-speech needs Windows PowerShell (powershell.exe) with System.Speech.';
  return 'Install a speech engine: sudo apt install espeak-ng (or speech-dispatcher), or sudo dnf install espeak-ng.';
}

/**
 * Speak text aloud with the OS speech engine. Any utterance in progress is
 * stopped first. Resolves once the engine has started; the non-enumerable
 * `done` promise settles when speech ends.
 * @param {string} text
 * @param {{rate?:number,voice?:string}} [opts] rate is a multiplier (1 = normal)
 * @returns {Promise<{pid:number|null,engine:string|null}>}
 */
async function speak(text, { rate, voice } = {}) {
  stopSpeaking();
  const t = cleanText(text, 20000).trim();
  const result = { pid: null, engine: null };
  if (!t) {
    Object.defineProperty(result, 'done', { value: Promise.resolve({ code: 0 }), enumerable: false });
    return result;
  }
  const info = R.info();
  const plan = speechPlan(info, t, speechRate(rate), voice);
  if (!plan) throw makeError('No text-to-speech engine is available', 'UNSUPPORTED', speechHint(info));
  // From WSL, read the Windows PID that the SAPI script prints so Stop can taskkill it.
  const wantWinPid = plan.engine === 'sapi' && Boolean(info.isWSL);
  let child;
  try {
    child = R.spawn(plan.cmd, plan.args, {
      stdio: [plan.input != null ? 'pipe' : 'ignore', wantWinPid ? 'pipe' : 'ignore', 'pipe'],
      windowsHide: true,
      cwd: plan.cwd,
    });
  } catch (err) {
    throw makeError(`Could not start ${plan.engine}: ${err.message}`, 'SPEAK_FAILED', speechHint(info));
  }
  let stderr = '';
  if (child.stderr) {
    child.stderr.on('data', (d) => {
      if (stderr.length < 4096) stderr += d;
    });
  }
  const done = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    // SAPI runs as a Windows PowerShell -EncodedCommand, whose errors arrive as CLIXML.
    child.once('exit', (code, signal) => resolve({ code, signal, stderr: plan.engine === 'sapi' ? proc.psErrorText(stderr) : stderr }));
  });
  const entry = { child, engine: plan.engine, winPid: null };
  if (wantWinPid && child.stdout) {
    let head = '';
    child.stdout.on('data', (d) => {
      if (entry.winPid != null || head.length > 4096) return;
      head += d;
      const m = /ANYWHERE_PID (\d+)/.exec(head);
      if (m) entry.winPid = Number(m[1]);
    });
    child.stdout.on('error', () => {});
  }
  current = entry;
  done.then(() => {
    if (current === entry) current = null;
  });
  if (plan.input != null && child.stdin) {
    child.stdin.on('error', () => {
      /* EPIPE if the engine exits early */
    });
    child.stdin.end(plan.input);
  }
  const startError = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2000);
    child.once('spawn', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
  if (startError) {
    if (current === entry) current = null;
    throw makeError(`Could not start ${plan.engine}: ${startError.message}`, 'SPEAK_FAILED', speechHint(info));
  }
  result.pid = child.pid == null ? null : child.pid;
  result.engine = plan.engine;
  Object.defineProperty(result, 'done', { value: done, enumerable: false });
  return result;
}

/**
 * Stop the utterance started by speak(), if any.
 * @returns {boolean} whether something was stopped
 */
function stopSpeaking() {
  const cur = current;
  current = null;
  if (!cur) return false;
  try {
    cur.child.kill();
  } catch {
    /* already gone */
  }
  if (cur.engine === 'spd-say') {
    // Killing the client does not silence speech-dispatcher; cancel explicitly.
    try {
      const c = R.spawn(R.which('spd-say') || 'spd-say', ['-C'], { stdio: 'ignore', windowsHide: true });
      if (c && typeof c.on === 'function') c.on('error', () => {});
    } catch {
      /* ignore */
    }
  }
  if (cur.engine === 'sapi' && cur.winPid != null && R.info().isWSL) {
    // From WSL the Linux-side process is only a relay; end the Windows process too.
    try {
      const c = R.spawn(R.which('taskkill.exe') || WSL_TASKKILL, ['/PID', String(cur.winPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      if (c && typeof c.on === 'function') c.on('error', () => {});
    } catch {
      /* ignore */
    }
  }
  return true;
}

/** @returns {boolean} whether an utterance is in progress */
function isSpeaking() {
  return current !== null;
}

module.exports = {
  openTarget,
  notify,
  speak,
  stopSpeaking,
  isSpeaking,
  findDesktopEntry,
  parseExec,
  parseDesktopEntry,
  quoteWinArgv,
  psArgs,
  psString,
  launchDetached,
  _setRunner,
};
