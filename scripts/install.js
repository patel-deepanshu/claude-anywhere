#!/usr/bin/env node
'use strict';

/**
 * Installs Claude Anywhere for the current user:
 *   1. copies skills/anywhere to ~/.claude/skills/anywhere (gives /anywhere),
 *   2. writes install.json so the skill's run.js finds this package,
 *   3. registers the `anywhere` MCP server at user scope (`claude mcp add-json`),
 *   4. optionally downloads Electron into the state directory,
 *   5. optionally adds an OS launcher with a keyboard shortcut,
 * and reverses all of it on uninstall.
 *
 * Usage: node scripts/install.js [--electron] [--no-mcp] [--hotkey] [--quiet]
 *        node scripts/install.js uninstall [--purge]
 * (normally run through `anywhere install` / `anywhere uninstall`).
 *
 * Honors HOME/USERPROFILE, CLAUDE_CONFIG_DIR and ANYWHERE_HOME so it can run in
 * temporary directories. Library functions report through `print` (stderr by
 * default) and never write to stdout themselves.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../src/shared/paths');
const proc = require('../src/shared/proc');
const platformMod = require('../src/shared/platform');

const PACKAGE_ROOT = paths.PACKAGE_ROOT;
const SKILL_SRC = path.join(PACKAGE_ROOT, 'skills', 'anywhere');
const BIN_JS = path.join(PACKAGE_ROOT, 'bin', 'anywhere.js');
const MCP_SERVER = path.join(PACKAGE_ROOT, 'src', 'mcp', 'server.js');
const APP_NAME = 'Claude Anywhere';
const HOTKEY_LABEL = 'Ctrl+Alt+A';
const WIN_HOTKEY = 'CTRL+ALT+A';
const GNOME_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const GNOME_LIST_KEY = 'custom-keybindings';
const GNOME_PATH = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/claude-anywhere/';
const GNOME_BINDING = '<Primary><Alt>a';
const DEFAULT_STRIP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

// ------------------------------------------------------------------ small helpers

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function defaultPrint(line) {
  process.stderr.write(`${line}\n`);
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Is `child` strictly inside directory `parent`? */
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Recursive copy (files and directories; symlinks are copied as the files they point to). */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to);
    else {
      fs.copyFileSync(from, to);
      try {
        fs.chmodSync(to, st.mode & 0o777);
      } catch {
        /* windows */
      }
    }
  }
}

/** Does `dir` hold a skill named "anywhere"? */
function isOurSkill(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    return /^name:\s*anywhere\s*$/m.test(text);
  } catch {
    return false;
  }
}

function readInstallInfo() {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.installInfoPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** POSIX shell single-quoting. */
function shQuote(s) {
  const str = String(s);
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quoted string literal. */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** VBScript string literal. */
function vbsQuote(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

/** AppleScript string literal body escaping. */
function appleScriptEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** GVariant string literal (as gsettings expects). */
function gvString(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Parse gsettings' `as` output: "@as []" or "['/a/', '/b/']". */
function parseGvStringArray(text) {
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    out.push(raw.replace(/\\(.)/g, '$1'));
  }
  return out;
}

function formatGvStringArray(list) {
  return `[${list.map(gvString).join(', ')}]`;
}

/**
 * Quote one Exec= argument of a .desktop file (quoting rule, then the string
 * escape rule for backslashes; % becomes %%).
 */
function desktopExecArg(arg) {
  let s = String(arg).replace(/%/g, '%%');
  if (/[\s"'\\><~|&;$*?#()`]/.test(s)) s = `"${s.replace(/(["`$\\])/g, '\\$1')}"`;
  return s.replace(/\\/g, '\\\\');
}

/** Encode a script for powershell.exe -EncodedCommand (UTF-16LE, base64). */
function encodePs(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function claudeEnv() {
  const env = { ...process.env };
  let strip = DEFAULT_STRIP_ENV;
  try {
    strip = require('../src/shared/config').load().engine.stripEnv || DEFAULT_STRIP_ENV;
  } catch {
    strip = DEFAULT_STRIP_ENV;
  }
  for (const k of strip.concat(['CLAUDECODE'])) delete env[k];
  return env;
}

function optionalRequire(rel) {
  try {
    return require(rel);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(path.basename(rel))) return null;
    throw err;
  }
}

/** Find the claude CLI: engine-cli's locate when available, else config/env/PATH. */
async function locateClaude() {
  const engine = optionalRequire('../src/daemon/engine-cli');
  let config = null;
  try {
    config = require('../src/shared/config').load();
  } catch {
    config = null;
  }
  if (engine && engine.ClaudeCliEngine && typeof engine.ClaudeCliEngine.locate === 'function') {
    try {
      const r = await engine.ClaudeCliEngine.locate(config || {});
      if (r) return r;
    } catch {
      /* fall through */
    }
  }
  const p = (config && config.engine && config.engine.claudePath) || process.env.ANYWHERE_CLAUDE_PATH || proc.which('claude');
  return p && exists(p) ? { path: p, version: null } : null;
}

/** How to spawn the claude binary with an args array (shell only for .cmd/.bat shims). */
function claudeSpawnSpec(cliPath, args, platform = process.platform) {
  if (/\.(c|m)?js$/i.test(cliPath)) return { command: process.execPath, args: [cliPath, ...args], shell: false };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    return { command: proc.quoteWinArg(cliPath), args: args.map((a) => proc.quoteWinArg(a)), shell: true };
  }
  return { command: cliPath, args: args.slice(), shell: false };
}

function mcpServerJson(nodePath = process.execPath, serverPath = MCP_SERVER) {
  return JSON.stringify({ type: 'stdio', command: nodePath, args: [serverPath] });
}

/** The command a user can paste to register the MCP server by hand. */
function manualMcpCommand(json, platform = process.platform) {
  if (platform === 'win32') return `claude mcp add-json --scope user anywhere ${proc.quoteWinArg(json)}`;
  return `claude mcp add-json --scope user anywhere ${shQuote(json)}`;
}

function firstLine(s) {
  return String(s || '').trim().split(/\r?\n/)[0] || '';
}

// ------------------------------------------------------------------ steps

async function registerMcp() {
  const json = mcpServerJson();
  const manual = manualMcpCommand(json);
  const claude = await locateClaude();
  if (!claude) return { registered: false, reason: 'the claude CLI was not found', manual };
  const env = claudeEnv();
  const opts = { timeoutMs: 30000, env, cwd: os.homedir() };
  const rm = claudeSpawnSpec(claude.path, ['mcp', 'remove', '--scope', 'user', 'anywhere']);
  await proc.run(rm.command, rm.args, { ...opts, shell: rm.shell });
  const add = claudeSpawnSpec(claude.path, ['mcp', 'add-json', '--scope', 'user', 'anywhere', json]);
  const r = await proc.run(add.command, add.args, { ...opts, shell: add.shell });
  if (r.error || r.timedOut || r.code !== 0) {
    const why = r.error ? r.error.message : r.timedOut ? 'timed out' : firstLine(r.stderr) || firstLine(r.stdout) || `exit code ${r.code}`;
    return { registered: false, reason: `claude mcp add-json failed: ${why}`, manual, claude: claude.path };
  }
  return { registered: true, scope: 'user', claude: claude.path, config: JSON.parse(json) };
}

async function unregisterMcp() {
  const claude = await locateClaude();
  if (!claude) return { removed: false, reason: 'the claude CLI was not found', manual: 'claude mcp remove --scope user anywhere' };
  const spec = claudeSpawnSpec(claude.path, ['mcp', 'remove', '--scope', 'user', 'anywhere']);
  const r = await proc.run(spec.command, spec.args, { timeoutMs: 30000, env: claudeEnv(), cwd: os.homedir(), shell: spec.shell });
  if (r.code === 0) return { removed: true };
  return { removed: false, reason: firstLine(r.stderr) || firstLine(r.stdout) || 'not registered' };
}

function findNpm() {
  const dir = path.dirname(process.execPath);
  if (process.platform === 'win32') {
    const local = path.join(dir, 'npm.cmd');
    if (exists(local)) return local;
    return proc.which('npm.cmd') || proc.which('npm');
  }
  const local = path.join(dir, 'npm');
  if (exists(local)) return local;
  return proc.which('npm');
}

function electronBinary(prefix) {
  try {
    const mod = require.resolve('electron', { paths: [prefix] });
    const bin = require(mod);
    return typeof bin === 'string' && exists(bin) ? bin : null;
  } catch {
    return null;
  }
}

async function installElectron({ print }) {
  const prefix = path.join(paths.stateDir(), 'electron');
  fs.mkdirSync(prefix, { recursive: true });
  const args = ['install', '--prefix', prefix, 'electron@latest', '--no-audit', '--no-fund'];
  const manual = `npm ${args.map((a) => (process.platform === 'win32' ? proc.quoteWinArg(a) : shQuote(a))).join(' ')}`;
  const npm = findNpm();
  if (!npm) return { installed: false, reason: 'npm was not found next to node or on PATH', manual };
  print('  Downloading Electron (about 100 MB; this can take a few minutes)…');
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(npm);
  const r = await proc.run(shell ? proc.quoteWinArg(npm) : npm, shell ? args.map((a) => proc.quoteWinArg(a)) : args, {
    timeoutMs: 20 * 60 * 1000,
    shell,
    cwd: prefix,
  });
  if (r.error || r.timedOut || r.code !== 0) {
    const tail = `${r.stderr || ''}\n${r.stdout || ''}`.trim().split(/\r?\n/).slice(-8).join('\n');
    return { installed: false, reason: r.error ? r.error.message : r.timedOut ? 'npm timed out' : `npm exited with code ${r.code}`, output: tail, manual };
  }
  const bin = electronBinary(prefix);
  if (!bin) return { installed: false, reason: 'npm finished but the Electron binary is missing (its download may have been blocked)', manual };
  return { installed: true, prefix, binary: bin };
}

// ---------------------------------------------------------------- hotkey: Windows / WSL

function windowsLauncherVbs(commandLine) {
  return [
    "' Claude Anywhere launcher (generated by `anywhere install --hotkey`): shows the dialog without a console window.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${vbsQuote(commandLine)}, 0, False`,
    '',
  ].join('\r\n');
}

/**
 * PowerShell that writes the launcher (when `vbsContent` is given) and the Start Menu shortcut.
 * `vbsPath` null means "%LOCALAPPDATA%\ClaudeAnywhere\launch-anywhere.vbs" (used from WSL).
 */
function windowsShortcutScript({ vbsPath, vbsContent, iconPath }) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$programs = [Environment]::GetFolderPath('Programs')",
    vbsPath ? `$vbs = ${psQuote(vbsPath)}` : "$vbs = Join-Path $env:LOCALAPPDATA 'ClaudeAnywhere\\launch-anywhere.vbs'",
  ];
  if (vbsContent != null) {
    lines.push(
      'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $vbs) | Out-Null',
      `Set-Content -LiteralPath $vbs -Value ${psQuote(vbsContent)} -Encoding Unicode`
    );
  }
  lines.push(
    `$lnk = Join-Path $programs ${psQuote(`${APP_NAME}.lnk`)}`,
    '$ws = New-Object -ComObject WScript.Shell',
    '$s = $ws.CreateShortcut($lnk)',
    "$s.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'",
    "$s.Arguments = '\"' + $vbs + '\"'",
    '$s.WorkingDirectory = $env:USERPROFILE',
    `$s.Hotkey = ${psQuote(WIN_HOTKEY)}`,
    `$s.Description = ${psQuote('Show the Claude Anywhere dialog')}`,
    iconPath ? `$s.IconLocation = ${psQuote(`${iconPath},0`)}` : "$s.IconLocation = (Join-Path $env:WINDIR 'System32\\shell32.dll') + ',22'",
    '$s.Save()',
    'Write-Output $lnk',
    'Write-Output $vbs'
  );
  return lines.join('\n');
}

function windowsRemoveScript(files) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$files = @(${files.map(psQuote).join(', ')})`,
    "if ($files.Count -eq 0) { $files = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Claude Anywhere.lnk'), (Join-Path $env:LOCALAPPDATA 'ClaudeAnywhere\\launch-anywhere.vbs')) }",
    'foreach ($f in $files) { if ($f -and (Test-Path -LiteralPath $f)) { Remove-Item -LiteralPath $f -Force; Write-Output $f } }',
  ].join('\n');
}

function powershellExe(info) {
  if (info.platform === 'win32') {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const p = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return exists(p) ? p : proc.which('powershell.exe') || proc.which('pwsh.exe') || 'powershell.exe';
  }
  return proc.which('powershell.exe') || (exists('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe') ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : null);
}

async function runPs(info, script) {
  const ps = powershellExe(info);
  if (!ps) return { code: null, stdout: '', stderr: 'powershell.exe was not found', error: new Error('powershell.exe was not found') };
  const cwd = info.isWSL && exists('/mnt/c') ? '/mnt/c' : undefined;
  return proc.run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(script)], { timeoutMs: 30000, cwd });
}

async function installHotkeyWindows(info, nodePath, binPath) {
  let commandLine;
  let vbsPath = null;
  let vbsContent;
  let iconPath = null;
  if (info.isWSL) {
    const distro = process.env.WSL_DISTRO_NAME;
    commandLine = `wsl.exe ${distro ? `-d "${distro}" ` : ''}-e "${nodePath}" "${binPath}" show`;
    vbsContent = windowsLauncherVbs(commandLine);
  } else {
    commandLine = `"${nodePath}" "${binPath}" show`;
    vbsPath = path.join(paths.stateDir(), 'launch-anywhere.vbs');
    const body = windowsLauncherVbs(commandLine);
    fs.writeFileSync(vbsPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]));
    iconPath = nodePath;
  }
  const r = await runPs(info, windowsShortcutScript({ vbsPath, vbsContent, iconPath }));
  if (r.error || r.code !== 0) {
    return { installed: false, reason: `creating the Start Menu shortcut failed: ${firstLine(r.stderr) || (r.error && r.error.message) || `exit ${r.code}`}` };
  }
  const out = String(r.stdout || '').trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return {
    installed: true,
    platform: info.isWSL ? 'wsl' : 'win32',
    label: HOTKEY_LABEL,
    lnk: out[0] || null,
    vbs: out[1] || vbsPath,
    instructions: [`Press ${HOTKEY_LABEL} anywhere to show the dialog (Start Menu shortcut "${APP_NAME}").`],
  };
}

async function uninstallHotkeyWindows(info, rec) {
  const files = [rec && rec.lnk, rec && rec.vbs].filter(Boolean);
  if (!info.isWSL) {
    const defaults = [
      path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`),
      path.join(paths.stateDir(), 'launch-anywhere.vbs'),
    ];
    const removed = [];
    for (const f of [...new Set(files.concat(defaults))]) {
      if (exists(f)) {
        rmrf(f);
        removed.push(f);
      }
    }
    return { removed };
  }
  const r = await runPs(info, windowsRemoveScript(files));
  return { removed: String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean) };
}

// ---------------------------------------------------------------- hotkey: macOS

function macAppPath() {
  return path.join(os.homedir(), 'Applications', `${APP_NAME}.app`);
}

function macAppleScript(nodePath, binPath) {
  const shellCmd = `${shQuote(nodePath)} ${shQuote(binPath)} show > /dev/null 2>&1 &`;
  return `do shell script "${appleScriptEscape(shellCmd)}"`;
}

async function installHotkeyMac(nodePath, binPath) {
  const app = macAppPath();
  const osacompile = proc.which('osacompile') || '/usr/bin/osacompile';
  fs.mkdirSync(path.dirname(app), { recursive: true });
  if (exists(app)) rmrf(app);
  const r = await proc.run(osacompile, ['-o', app, '-e', macAppleScript(nodePath, binPath)], { timeoutMs: 30000 });
  if (r.error || r.code !== 0) return { installed: false, reason: `osacompile failed: ${firstLine(r.stderr) || (r.error && r.error.message)}` };
  return {
    installed: true,
    platform: 'darwin',
    label: null,
    app,
    instructions: [
      `Created "${app}" (also launchable from Spotlight: type "${APP_NAME}").`,
      'To give it a keyboard shortcut: open the Shortcuts app → New Shortcut → add the "Open App" action →',
      `choose "${APP_NAME}" → Shortcut Details (ⓘ) → Add Keyboard Shortcut → press e.g. ⌃⌥A.`,
    ],
  };
}

// ---------------------------------------------------------------- hotkey: Linux

function desktopFilePath() {
  const base = process.env.XDG_DATA_HOME ? path.resolve(process.env.XDG_DATA_HOME) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'applications', 'claude-anywhere.desktop');
}

function desktopEntry(nodePath, binPath) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    'GenericName=AI desktop assistant',
    'Comment=Show the Claude Anywhere dialog',
    `Exec=${desktopExecArg(nodePath)} ${desktopExecArg(binPath)} show`,
    'Icon=utilities-terminal',
    'Terminal=false',
    'Categories=Utility;',
    'Keywords=claude;ai;assistant;voice;anywhere;',
    'StartupNotify=false',
    '',
  ].join('\n');
}

function isGnomeLike(desktop) {
  return /gnome|unity|budgie|pantheon|ubuntu|cosmic/i.test(String(desktop || ''));
}

function otherDesktopInstructions(cmd) {
  return [
    `Bind ${HOTKEY_LABEL} to: ${cmd}`,
    '  KDE Plasma: System Settings → Keyboard → Shortcuts → Add New → Command or Script.',
    '  XFCE: Settings → Keyboard → Application Shortcuts → Add.  Cinnamon/MATE: Keyboard → Shortcuts → Custom Shortcuts.',
    `  i3/sway: bindsym Ctrl+Mod1+a exec ${cmd}   Hyprland: bind = CTRL ALT, A, exec, ${cmd}`,
  ];
}

async function gsettings(args) {
  return proc.run('gsettings', args, { timeoutMs: 10000 });
}

async function gnomeAddBinding(command) {
  const cur = await gsettings(['get', GNOME_SCHEMA, GNOME_LIST_KEY]);
  if (cur.error || cur.code !== 0) return { ok: false, reason: firstLine(cur.stderr) || 'gsettings is unavailable' };
  const list = parseGvStringArray(cur.stdout);
  if (!list.includes(GNOME_PATH)) {
    const set = await gsettings(['set', GNOME_SCHEMA, GNOME_LIST_KEY, formatGvStringArray(list.concat([GNOME_PATH]))]);
    if (set.code !== 0) return { ok: false, reason: firstLine(set.stderr) || 'could not update the keybinding list' };
  }
  const rel = `${GNOME_SCHEMA}.custom-keybinding:${GNOME_PATH}`;
  for (const [key, value] of [
    ['name', APP_NAME],
    ['command', command],
    ['binding', GNOME_BINDING],
  ]) {
    const r = await gsettings(['set', rel, key, gvString(value)]);
    if (r.code !== 0) return { ok: false, reason: firstLine(r.stderr) || `could not set ${key}` };
  }
  return { ok: true };
}

async function gnomeRemoveBinding() {
  const cur = await gsettings(['get', GNOME_SCHEMA, GNOME_LIST_KEY]);
  if (cur.error || cur.code !== 0) return { ok: false };
  const list = parseGvStringArray(cur.stdout);
  if (list.includes(GNOME_PATH)) {
    await gsettings(['set', GNOME_SCHEMA, GNOME_LIST_KEY, formatGvStringArray(list.filter((p) => p !== GNOME_PATH))]);
  }
  const rel = `${GNOME_SCHEMA}.custom-keybinding:${GNOME_PATH}`;
  for (const key of ['name', 'command', 'binding']) await gsettings(['reset', rel, key]);
  return { ok: true };
}

async function installHotkeyLinux(info, nodePath, binPath) {
  const file = desktopFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desktopEntry(nodePath, binPath), { mode: 0o755 });
  const update = proc.which('update-desktop-database');
  if (update) await proc.run(update, [path.dirname(file)], { timeoutMs: 10000 });
  const cmd = `${shQuote(nodePath)} ${shQuote(binPath)} show`;
  const res = { installed: true, platform: 'linux', desktopFile: file, gnome: false, label: null, instructions: [`Added "${APP_NAME}" to the applications menu (${file}).`] };
  if (proc.which('gsettings') && isGnomeLike(info.desktop)) {
    const g = await gnomeAddBinding(cmd);
    if (g.ok) {
      res.gnome = true;
      res.label = HOTKEY_LABEL;
      res.instructions.push(`Press ${HOTKEY_LABEL} to show the dialog (GNOME custom shortcut "${APP_NAME}").`);
      return res;
    }
    res.instructions.push(`Could not add the GNOME shortcut (${g.reason}).`);
  }
  res.instructions.push(...otherDesktopInstructions(cmd));
  return res;
}

async function uninstallHotkeyLinux(rec) {
  const removed = [];
  for (const f of [...new Set([rec && rec.desktopFile, desktopFilePath()].filter(Boolean))]) {
    if (exists(f)) {
      rmrf(f);
      removed.push(f);
    }
  }
  if (proc.which('gsettings')) {
    const g = await gnomeRemoveBinding();
    if (g.ok && rec && rec.gnome) removed.push(`GNOME shortcut ${GNOME_PATH}`);
  }
  return { removed };
}

async function installHotkey(info, nodePath, binPath) {
  if (info.platform === 'win32' || info.isWSL) {
    if (info.isWSL && !powershellExe(info)) {
      return { installed: false, reason: 'powershell.exe is not reachable from WSL', instructions: otherDesktopInstructions(`${shQuote(nodePath)} ${shQuote(binPath)} show`) };
    }
    return installHotkeyWindows(info, nodePath, binPath);
  }
  if (info.platform === 'darwin') return installHotkeyMac(nodePath, binPath);
  return installHotkeyLinux(info, nodePath, binPath);
}

// ------------------------------------------------------------------ install / uninstall

/**
 * Install Claude Anywhere for the current user.
 * @param {{electron?:boolean, mcp?:boolean, hotkey?:boolean, skillDir?:string, quiet?:boolean, print?:(line:string)=>void}} [opts]
 * @returns {Promise<{ok:boolean, version:string, packageRoot:string, skillDir:string, installInfoPath:string,
 *   skill:object, mcp:object, electron:object, hotkey:object, nextSteps:string[], warnings:string[]}>}
 */
async function install({ electron = false, mcp = true, hotkey = false, skillDir, quiet = false, print } = {}) {
  const out = quiet ? () => {} : typeof print === 'function' ? print : defaultPrint;
  const info = platformMod.info();
  const version = packageVersion();
  const warnings = [];
  const target = path.resolve(skillDir || path.join(paths.claudeHome(), 'skills', 'anywhere'));
  out(`Installing Claude Anywhere ${version} from ${PACKAGE_ROOT}`);

  // 1. Skill
  const skill = { dir: target, copied: false };
  if (!exists(path.join(SKILL_SRC, 'SKILL.md'))) throw new Error(`The skill is missing from this package (${SKILL_SRC}).`);
  if (realpathOr(target) === realpathOr(SKILL_SRC)) {
    skill.linked = true;
    out(`  ✓ Skill      /anywhere → ${target} (already linked to this checkout)`);
  } else {
    if (exists(target) && !isOurSkill(target)) {
      const backup = `${target}.bak-${Date.now()}`;
      fs.renameSync(target, backup);
      skill.backup = backup;
      warnings.push(`An unrelated skill named "anywhere" was moved to ${backup}`);
    }
    let st = null;
    try {
      st = fs.lstatSync(target);
    } catch {
      st = null;
    }
    if (st && st.isSymbolicLink()) fs.unlinkSync(target);
    else if (st) rmrf(target);
    copyDir(SKILL_SRC, target);
    skill.copied = true;
    out(`  ✓ Skill      /anywhere → ${target}`);
  }

  // 2. install.json (merged so earlier electron/hotkey records survive for uninstall)
  const prev = readInstallInfo() || {};
  const record = {
    ...prev,
    packageRoot: PACKAGE_ROOT,
    version,
    installedAt: new Date().toISOString(),
    nodePath: process.execPath,
    skillDir: target,
  };

  // 3. MCP server (a plugin install already provides it as plugin:anywhere:anywhere)
  let mcpRes = { registered: false, skipped: true };
  const pluginsDir = path.join(paths.claudeHome(), 'plugins');
  const fromPlugin = isInside(realpathOr(PACKAGE_ROOT), realpathOr(pluginsDir)) || isInside(PACKAGE_ROOT, pluginsDir);
  if (mcp && fromPlugin) {
    mcpRes = { registered: false, skipped: true, reason: 'provided by the anywhere plugin' };
    out('  - MCP tools  provided by the anywhere plugin (not registered again)');
  } else if (mcp) {
    mcpRes = await registerMcp();
    if (mcpRes.registered) out('  ✓ MCP tools  "anywhere" registered at user scope (screen tools in every Claude Code session)');
    else {
      out(`  ! MCP tools  not registered: ${mcpRes.reason}`);
      out(`               Register it later with: ${mcpRes.manual}`);
      warnings.push(`MCP server not registered: ${mcpRes.reason}`);
    }
    record.mcp = { registered: Boolean(mcpRes.registered), scope: 'user' };
  } else {
    out('  - MCP tools  skipped (--no-mcp)');
  }

  // 4. Electron
  let electronRes = { installed: false, skipped: true };
  if (electron) {
    electronRes = await installElectron({ print: out });
    if (electronRes.installed) {
      out(`  ✓ Electron   ${electronRes.binary}`);
      record.electron = { prefix: electronRes.prefix, binary: electronRes.binary };
    } else {
      out(`  ! Electron   not installed: ${electronRes.reason}${electronRes.output ? `\n${electronRes.output}` : ''}`);
      out(`               Retry with: ${electronRes.manual}`);
      warnings.push(`Electron not installed: ${electronRes.reason}`);
    }
  }

  // 5. OS launcher and hotkey
  let hotkeyRes = { installed: false, skipped: true };
  if (hotkey) {
    try {
      hotkeyRes = await installHotkey(info, process.execPath, BIN_JS);
    } catch (err) {
      hotkeyRes = { installed: false, reason: err.message };
    }
    if (hotkeyRes.installed) {
      record.hotkey = { ...hotkeyRes };
      out(`  ✓ Launcher   ${hotkeyRes.label ? `${hotkeyRes.label} shows the dialog` : 'added'}`);
    } else {
      out(`  ! Launcher   not added: ${hotkeyRes.reason}`);
      warnings.push(`Launcher not added: ${hotkeyRes.reason}`);
    }
    for (const line of hotkeyRes.instructions || []) out(`               ${line}`);
  }

  writeJson(paths.installInfoPath(), record);

  const binHint = process.platform === 'win32' ? `node "${BIN_JS}"` : `node ${shQuote(BIN_JS)}`;
  const nextSteps = [
    'Restart Claude Code (or open a new session) so it loads the skill and the MCP tools.',
    'In any project, type /anywhere to open the dialog, or /anywhere <task>, e.g. /anywhere deploy this repo to Cloud Run.',
    `Check this machine any time: ${binHint} doctor   (or /anywhere doctor)`,
  ];
  if (!electron) nextSteps.push(`Optional: ${binHint} install --electron for an always-on-top window with a global hotkey.`);
  out('');
  out(`✓ Claude Anywhere ${version} is installed. Next:`);
  nextSteps.forEach((s, i) => out(`  ${i + 1}. ${s}`));

  return {
    ok: true,
    version,
    packageRoot: PACKAGE_ROOT,
    skillDir: target,
    installInfoPath: paths.installInfoPath(),
    skill,
    mcp: mcpRes,
    electron: electronRes,
    hotkey: hotkeyRes,
    nextSteps,
    warnings,
  };
}

/**
 * Undo `install`. With `purge`, also delete the state directory (settings, logs, Electron).
 * @param {{purge?:boolean, quiet?:boolean, print?:(line:string)=>void, skillDir?:string, mcp?:boolean}} [opts]
 */
async function uninstall({ purge = false, quiet = false, print, skillDir, mcp = true } = {}) {
  const out = quiet ? () => {} : typeof print === 'function' ? print : defaultPrint;
  const info = platformMod.info();
  const rec = readInstallInfo() || {};
  const removed = [];
  const notes = [];

  // Skill
  const target = path.resolve(skillDir || rec.skillDir || path.join(paths.claudeHome(), 'skills', 'anywhere'));
  let st = null;
  try {
    st = fs.lstatSync(target);
  } catch {
    st = null;
  }
  if (st && st.isSymbolicLink()) {
    fs.unlinkSync(target);
    removed.push(target);
  } else if (st && isOurSkill(target) && realpathOr(target) !== realpathOr(SKILL_SRC)) {
    rmrf(target);
    removed.push(target);
  } else if (st) {
    notes.push(`Left ${target} in place (it is not the Claude Anywhere skill).`);
  }
  out(`  ✓ Skill      ${removed.includes(target) ? `removed ${target}` : 'not installed'}`);

  // MCP
  let mcpRes = { removed: false, skipped: true };
  if (mcp) {
    mcpRes = await unregisterMcp();
    out(`  ${mcpRes.removed ? '✓' : '-'} MCP tools  ${mcpRes.removed ? 'unregistered' : `nothing to remove (${mcpRes.reason})`}`);
  }

  // Launcher / hotkey
  let hk = { removed: [] };
  try {
    if (info.platform === 'win32' || info.isWSL) {
      if (!info.isWSL || powershellExe(info)) hk = await uninstallHotkeyWindows(info, rec.hotkey);
    } else if (info.platform === 'darwin') {
      const app = (rec.hotkey && rec.hotkey.app) || macAppPath();
      if (exists(app)) {
        rmrf(app);
        hk.removed.push(app);
      }
    } else {
      hk = await uninstallHotkeyLinux(rec.hotkey);
    }
  } catch (err) {
    notes.push(`Launcher cleanup failed: ${err.message}`);
  }
  removed.push(...hk.removed);
  out(`  ${hk.removed.length ? '✓' : '-'} Launcher   ${hk.removed.length ? `removed ${hk.removed.join(', ')}` : 'none installed'}`);

  // Electron and install.json
  const sd = paths.stateDir();
  const electronDir = path.join(sd, 'electron');
  if (exists(electronDir)) {
    rmrf(electronDir);
    removed.push(electronDir);
    out(`  ✓ Electron   removed ${electronDir}`);
  }
  if (exists(paths.installInfoPath())) {
    fs.unlinkSync(paths.installInfoPath());
    removed.push(paths.installInfoPath());
  }

  if (purge) {
    const resolved = path.resolve(sd);
    const forbidden = [path.parse(resolved).root, path.resolve(os.homedir()), path.resolve(paths.claudeHome())];
    if (forbidden.includes(resolved)) {
      notes.push(`Refused to delete ${resolved}: ANYWHERE_HOME points at a directory that is not Claude Anywhere's own.`);
    } else {
      rmrf(resolved);
      removed.push(resolved);
      out(`  ✓ State      removed ${resolved} (settings, logs, sessions)`);
    }
  } else {
    notes.push(`Settings and logs remain in ${sd} (use --purge to delete them).`);
  }
  for (const n of notes) out(`  ${n}`);
  out('✓ Claude Anywhere is uninstalled. Restart Claude Code to unload the skill and MCP tools.');
  return { ok: true, removed, mcp: mcpRes, notes };
}

// ------------------------------------------------------------------ script entry

function parseScriptArgs(argv) {
  const o = { command: 'install', electron: false, mcp: true, hotkey: false, purge: false, quiet: false, json: false };
  for (const a of argv) {
    if (a === 'install' || a === 'uninstall') o.command = a;
    else if (a === '--electron') o.electron = true;
    else if (a === '--no-mcp') o.mcp = false;
    else if (a === '--mcp') o.mcp = true;
    else if (a === '--hotkey') o.hotkey = true;
    else if (a === '--purge') o.purge = true;
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--skill-dir=')) o.skillDir = a.slice('--skill-dir='.length);
    else throw new Error(`Unknown option ${a}. Usage: node scripts/install.js [install|uninstall] [--electron] [--no-mcp] [--hotkey] [--purge] [--quiet] [--json]`);
  }
  return o;
}

if (require.main === module) {
  let o;
  try {
    o = parseScriptArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  const print = (line) => process.stdout.write(`${line}\n`);
  const quiet = o.quiet || o.json;
  const job = o.command === 'uninstall' ? uninstall({ purge: o.purge, quiet, print }) : install({ ...o, quiet, print });
  job.then(
    (res) => {
      if (o.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      process.exitCode = res && res.ok === false ? 1 : 0;
    },
    (err) => {
      process.stderr.write(`✗ ${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  install,
  uninstall,
  // helpers exported for tests
  shQuote,
  psQuote,
  vbsQuote,
  appleScriptEscape,
  gvString,
  parseGvStringArray,
  formatGvStringArray,
  desktopExecArg,
  desktopEntry,
  desktopFilePath,
  encodePs,
  windowsLauncherVbs,
  windowsShortcutScript,
  windowsRemoveScript,
  macAppleScript,
  mcpServerJson,
  manualMcpCommand,
  claudeSpawnSpec,
  isOurSkill,
  isInside,
  isGnomeLike,
  parseScriptArgs,
  GNOME_PATH,
  HOTKEY_LABEL,
};
