'use strict';

/**
 * Windows desktop driver (docs/ARCHITECTURE.md section 4), also used from WSL.
 *
 * All desktop work happens in one persistent PowerShell process running
 * src/os/win32-host.ps1, which speaks JSON lines over stdio. This module owns
 * that process: a serialized request queue, per-command timeouts, a stderr
 * ring buffer for diagnostics, automatic restarts (rate limited) and the
 * WSL staging of the script into a Windows folder.
 *
 * Coordinates are physical pixels: the host is per-monitor DPI aware.
 *
 * Controls of any app (uiTree, uiFind, uiAction) come from UI Automation in the same host: element
 * ids are "<hwnd>.<child index>...~<tag>", cached there for 30 s and resolved again by their path
 * (with a role and name check) after that or after a host restart. setWindowBounds uses
 * SetWindowPos / ShowWindow on the visible frame (the bounds listWindows reports).
 *
 * Test hooks: ANYWHERE_PS_EXE replaces the PowerShell executable and
 * ANYWHERE_PS_ARGS (a JSON array; "{script}" expands to the host script path)
 * replaces its arguments.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const proc = require('../shared/proc');
const { createLogger } = require('../shared/log');
const { PACKAGE_ROOT } = require('../shared/paths');
const keysLib = require('./keys');

const log = createLogger('os-win32');

const HOST_SCRIPT = path.join(__dirname, 'win32-host.ps1');
const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const WSL_CMD = '/mnt/c/Windows/System32/cmd.exe';
const WSL_TASKKILL = '/mnt/c/Windows/System32/taskkill.exe';

const DEFAULT_TIMEOUT_MS = 8000;
const CAPTURE_TIMEOUT_MS = 20000;
const START_TIMEOUT_MS = 30000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000;
const STDERR_KEEP_CHARS = 8192;
const MAX_LINE_BYTES = 256 * 1024 * 1024;
const TYPE_CHUNK = 1000;
const MAX_NOTCHES = 200;
const KILL_GRACE_MS = 3000;

/** Read-only commands that are safe to resend once after a host crash. */
const RETRYABLE = new Set(['ping', 'displays', 'capture', 'cursor', 'windows', 'active', 'clipget', 'browsertab', 'audioDefaultGet', 'toastTexts', 'desktopPath', 'uiinfo', 'uitree', 'uifind']);
/** UI Automation walk of a browser window: the host stops looking after BROWSER_TAB_BUDGET_MS. */
const BROWSER_TAB_BUDGET_MS = 4000;
const BROWSER_TAB_TIMEOUT_MS = 15000;

/** Call audio (docs/CALLS-DESIGN.md §5.2): the first call compiles the Core Audio bridge (Add-Type). */
const AUDIO_TIMEOUT_MS = 20000;
const AUDIO_FLOWS = new Set(['capture', 'render', 'all']);
const AUDIO_ROLES = ['console', 'multimedia', 'communications'];
const AUDIO_ID_RE = /^\{[0-9.]+\}\.\{[0-9A-Fa-f-]{36}\}$/;

/** Roles of the shared UI vocabulary (docs/ARCHITECTURE.md section 4); the host maps ControlTypes onto them. */
const UI_ROLES = [
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listitem', 'menuitem', 'menu', 'tab', 'tablist',
  'treeitem', 'image', 'text', 'heading', 'window', 'toolbar', 'group', 'table', 'row', 'cell', 'slider', 'other',
];
const UI_ROLE_SET = new Set(UI_ROLES);
/** Other names callers use for the same roles (UI Automation, ARIA and plain-English names). */
const UI_ROLE_ALIASES = {
  edit: 'textbox', input: 'textbox', field: 'textbox', textfield: 'textbox', searchbox: 'textbox', textarea: 'textbox',
  hyperlink: 'link', anchor: 'link', option: 'listitem', menubar: 'menu', tabitem: 'tab', dropdown: 'combobox',
  select: 'combobox', radiobutton: 'radio', togglebutton: 'button', splitbutton: 'button', switch: 'checkbox',
  statictext: 'text', label: 'text', img: 'image', picture: 'image', icon: 'image', dialog: 'window', pane: 'group',
  list: 'group', tree: 'group', grid: 'table', datagrid: 'table', dataitem: 'row', gridcell: 'cell',
  columnheader: 'cell', spinner: 'slider', spinbutton: 'slider',
};
const UI_ACTIONS = new Map(
  ['press', 'focus', 'setValue', 'select', 'expand', 'collapse', 'scrollIntoView', 'showMenu'].map((a) => [a.toLowerCase(), a]),
);
/** "<hwnd>.<child index>...~<tag>" (win32-host.ps1, UI Automation section). */
const UI_ID_RE = /^-?\d{1,20}(?:\.\d{1,6})*(?:~[0-9a-z]{2})?$/;
const UI_BUDGET_MS = 3000;
const UI_MAX_BUDGET_MS = 15000;
/** Host time on top of a walk's budget: first load of the UI Automation assemblies, JSON of a big tree. */
const UI_TIMEOUT_MARGIN_MS = 10000;
/** An action waits up to 2 s for a provider, resolves its id and may search a list for an item. */
const UI_ACTION_TIMEOUT_MS = 20000;
const UI_INFO_TIMEOUT_MS = 15000;
const WINDOW_BOUNDS_TIMEOUT_MS = 10000;
const WINDOW_STATES = { maximize: 'maximize', maximized: 'maximize', max: 'maximize', fullscreen: 'maximize', full: 'maximize',
  minimize: 'minimize', minimized: 'minimize', min: 'minimize', restore: 'restore', restored: 'restore', normal: 'restore' };
const HINT_UI_CHROMIUM =
  'Chromium and Electron apps (Chrome, Brave, Edge, VS Code, Slack, Figma, ...) build their accessibility tree on the first ' +
  'UI Automation request; if one shows almost no controls, ask again after a moment or start it with --force-renderer-accessibility.';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BUTTONS = new Set(['left', 'right', 'middle', 'x1', 'x2']);
const MODIFIER_VK = { ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b };

const HINT_DOCTOR = 'Run "anywhere doctor" for diagnostics, or set ANYWHERE_DEBUG=1 to log the PowerShell host.';
const HINT_WSL_INTEROP =
  'Enable WSL interop so Windows programs run from Linux (in /etc/wsl.conf: [interop] enabled=true and ' +
  'appendWindowsPath=true), then run `wsl --shutdown` from Windows and reopen your WSL terminal.';

function makeError(message, code, hint, extra) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  if (extra) Object.assign(err, extra);
  return err;
}

function packageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '0');
  } catch {
    return '0';
  }
}

// ---------------------------------------------------------------------------
// Locating PowerShell and building its command line
// ---------------------------------------------------------------------------

/**
 * Find a PowerShell executable able to drive the Windows desktop.
 * @param {{wsl?:boolean,platform?:string,env?:object,whichFn?:(n:string)=>string|null,exists?:(p:string)=>boolean}} [opts]
 * @returns {string|null}
 */
function locatePowerShell({ wsl = false, platform = process.platform, env = process.env, whichFn = proc.which, exists = fs.existsSync } = {}) {
  if (platform === 'win32') {
    const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
    const builtin = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return whichFn('powershell') || (exists(builtin) ? builtin : null) || whichFn('pwsh');
  }
  if (wsl) {
    return whichFn('powershell.exe') || (exists(WSL_POWERSHELL) ? WSL_POWERSHELL : null) || whichFn('pwsh.exe');
  }
  // Forced win32 driver on a non-Windows host (development): PowerShell 7 can at least answer ping.
  return whichFn('pwsh');
}

/**
 * Convert a Windows path to its WSL mount path without calling wslpath.
 * @param {string} winPath e.g. 'C:\\Users\\me\\AppData\\Local\\Temp'
 * @returns {string|null} e.g. '/mnt/c/Users/me/AppData/Local/Temp'
 */
function winToWslPath(winPath) {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(String(winPath || '').trim());
  if (!m) return null;
  const rest = m[2].replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

async function toWslPath(winPath, runner, whichFn) {
  const wslpath = whichFn('wslpath');
  if (wslpath) {
    const r = await runner(wslpath, ['-u', winPath], { timeoutMs: 5000 });
    const out = String(r.stdout || '').trim();
    // An absolute path of this machine (inside WSL, always /...).
    if (r.code === 0 && path.isAbsolute(out)) return out;
  }
  return winToWslPath(winPath);
}

function writeScriptCopy(dir, name, content, { exclusive = false } = {}) {
  if (exclusive) {
    // Shared folders (C:\Windows\Temp): a fresh, exclusively created file nobody else can have planted.
    const file = path.join(dir, name.replace(/\.ps1$/, `-${crypto.randomBytes(6).toString('hex')}.ps1`));
    fs.writeFileSync(file, content, { flag: 'wx' });
    return file;
  }
  const target = path.join(dir, name);
  try {
    if (fs.readFileSync(target).equals(content)) return target;
  } catch {
    /* missing or unreadable: write it */
  }
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, target);
    return target;
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    // The old copy is locked by a running host: use a content-addressed name instead.
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
    const alt = path.join(dir, name.replace(/\.ps1$/, `-${hash}.ps1`));
    try {
      if (fs.readFileSync(alt).equals(content)) return alt;
    } catch {
      /* write below */
    }
    fs.writeFileSync(alt, content);
    log.debug(`could not replace ${target} (${err.code || err.message}); using ${alt}`);
    return alt;
  }
}

/**
 * WSL: Windows PowerShell cannot reliably run a script from the Linux file
 * system, so copy the host script into the Windows %TEMP% folder.
 * @param {{scriptPath?:string,version?:string,runner?:Function,whichFn?:Function,exists?:Function}} [opts]
 * @returns {Promise<{windowsPath:string,linuxPath:string}>}
 */
async function stageWslScript({
  scriptPath = HOST_SCRIPT,
  version = packageVersion(),
  runner = proc.run,
  whichFn = proc.which,
  exists = fs.existsSync,
} = {}) {
  const content = fs.readFileSync(scriptPath);
  const name = `claude-anywhere-host-${String(version).replace(/[^\w.-]/g, '_')}.ps1`;
  const cwd = exists('/mnt/c') ? '/mnt/c' : undefined;
  const candidates = [];
  const cmd = whichFn('cmd.exe') || (exists(WSL_CMD) ? WSL_CMD : null);
  const errors = [];
  if (cmd) {
    const r = await runner(cmd, ['/d', '/c', 'echo', '%TEMP%'], { timeoutMs: 10000, cwd });
    const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const temp = lines[lines.length - 1];
    if (r.code === 0 && temp && /^[A-Za-z]:\\/.test(temp)) candidates.push({ win: temp, exclusive: false });
    else errors.push(`cmd.exe did not report %TEMP% (${r.error ? r.error.message : String(r.stderr || '').trim() || `exit ${r.code}`})`);
  } else {
    errors.push('cmd.exe not found');
  }
  candidates.push({ win: 'C:\\Windows\\Temp', exclusive: true });
  for (const c of candidates) {
    const dir = await toWslPath(c.win, runner, whichFn);
    if (!dir) {
      errors.push(`cannot map ${c.win} into WSL`);
      continue;
    }
    try {
      const linuxPath = writeScriptCopy(dir, name, content, { exclusive: c.exclusive });
      const windowsPath = `${c.win.replace(/[\\/]+$/, '')}\\${path.basename(linuxPath)}`;
      return { windowsPath, linuxPath };
    } catch (err) {
      errors.push(`${c.win}: ${err.code || err.message}`);
    }
  }
  throw makeError(
    `Could not copy the PowerShell host script to a Windows folder (${errors.join('; ')})`,
    'UNSUPPORTED',
    `${HINT_WSL_INTEROP} Also check that %TEMP% exists and is writable.`,
  );
}

function parseArgsOverride(raw, scriptPath) {
  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    args = null;
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    throw makeError('ANYWHERE_PS_ARGS must be a JSON array of strings', 'BAD_CONFIG', 'Example: ANYWHERE_PS_ARGS=\'["-NoProfile","-File","{script}"]\'');
  }
  return args.map((a) => a.split('{script}').join(scriptPath));
}

/**
 * Work out how to start the host: executable, arguments and working dir.
 * @param {{wsl?:boolean,env?:object,platform?:string,scriptPath?:string,runner?:Function,whichFn?:Function,exists?:Function}} [opts]
 * @returns {Promise<{exe:string,args:string[],cwd:string|undefined,windowsExe:boolean,script:string}>}
 */
async function resolveHostCommand({
  wsl = false,
  env = process.env,
  platform = process.platform,
  scriptPath = HOST_SCRIPT,
  runner = proc.run,
  whichFn = proc.which,
  exists = fs.existsSync,
} = {}) {
  const exe = env.ANYWHERE_PS_EXE || locatePowerShell({ wsl, platform, env, whichFn, exists });
  if (!exe) {
    throw makeError(
      'PowerShell (powershell.exe) was not found',
      'UNSUPPORTED',
      wsl
        ? HINT_WSL_INTEROP
        : 'Windows PowerShell ships with Windows 10/11; check that %SystemRoot%\\System32\\WindowsPowerShell\\v1.0 is on PATH, or install PowerShell 7 (winget install Microsoft.PowerShell).',
    );
  }
  const windowsExe = platform === 'win32' || /\.exe$/i.test(exe);
  const cwd = wsl && platform !== 'win32' && exists('/mnt/c') ? '/mnt/c' : undefined;
  if (env.ANYWHERE_PS_ARGS) {
    return { exe, args: parseArgsOverride(env.ANYWHERE_PS_ARGS, scriptPath), cwd, windowsExe, script: scriptPath };
  }
  let script = scriptPath;
  if (wsl && windowsExe && platform !== 'win32') {
    script = (await stageWslScript({ scriptPath, runner, whichFn, exists })).windowsPath;
  }
  // -STA keeps the clipboard and Forms APIs happy; PowerShell on Linux/macOS rejects the switch.
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (windowsExe) args.push('-STA');
  args.push('-File', script);
  return { exe, args, cwd, windowsExe, script };
}

// ---------------------------------------------------------------------------
// The host process
// ---------------------------------------------------------------------------

function exitHint(code, stderr, wsl) {
  const s = String(stderr || '');
  if (code === 3 || /ANYWHERE_HOST_ERROR: PowerShell runs in|supported only on core types in this language mode|ConstrainedLanguage/i.test(s)) {
    return {
      code: 'POWERSHELL_RESTRICTED',
      hint:
        'PowerShell is locked to ConstrainedLanguage mode on this computer (AppLocker/WDAC). Desktop control needs ' +
        'FullLanguage mode; ask your administrator to allow it for Claude Anywhere.',
    };
  }
  if (/running scripts is disabled|cannot be loaded because|is not digitally signed|PSSecurityException|UnauthorizedAccess/i.test(s)) {
    return {
      code: 'EXECUTION_POLICY',
      hint:
        'A Group Policy execution policy prevents PowerShell scripts from running, and Claude Anywhere does not ' +
        'work around it. Ask your administrator to allow the script, or check with Get-ExecutionPolicy -List.',
    };
  }
  if (/Exec format error|cannot execute binary file/i.test(s)) return { code: 'UNSUPPORTED', hint: HINT_WSL_INTEROP };
  return { code: 'HOST_EXITED', hint: wsl ? `${HINT_DOCTOR} ${HINT_WSL_INTEROP}` : HINT_DOCTOR };
}

function hostError(error, cmd) {
  if (error && typeof error === 'object') {
    return makeError(String(error.message || `PowerShell host failed: ${cmd}`), error.code || 'HOST_ERROR', error.hint || undefined, {
      hostType: error.type || undefined,
    });
  }
  return makeError(String(error || `PowerShell host failed: ${cmd}`), 'HOST_ERROR');
}

/**
 * One persistent PowerShell JSON-lines host with a serialized request queue.
 * Only one request is in flight, so per-command timeouts measure host time
 * rather than queueing time, and a hung host can be killed and restarted
 * without resending work it may already have done.
 */
class PsHost {
  /**
   * @param {{exe:string,args:string[],cwd?:string,env?:object,wsl?:boolean,windowsExe?:boolean,
   *   timeoutMs?:number,captureTimeoutMs?:number,startTimeoutMs?:number,maxRestarts?:number,restartWindowMs?:number}} opts
   */
  constructor(opts) {
    this.exe = opts.exe;
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.env = opts.env || process.env;
    this.wsl = Boolean(opts.wsl);
    this.windowsExe = Boolean(opts.windowsExe);
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.captureTimeoutMs = opts.captureTimeoutMs || CAPTURE_TIMEOUT_MS;
    this.startTimeoutMs = opts.startTimeoutMs || START_TIMEOUT_MS;
    this.maxRestarts = opts.maxRestarts != null ? opts.maxRestarts : MAX_RESTARTS;
    this.restartWindowMs = opts.restartWindowMs || RESTART_WINDOW_MS;
    this.info = null;
    this._child = null;
    this._starting = null;
    this._queue = [];
    this._inflight = null;
    this._nextId = 1;
    this._launches = [];
    this._stderr = '';
    this._closed = false;
    this._pumping = false;
  }

  /** PID of the running host process (the Windows PID when known), or null. */
  get pid() {
    if (!this._child) return null;
    return (this.info && this.info.pid) || this._child.pid || null;
  }

  /** The last lines the host wrote to stderr (or non-protocol stdout). */
  stderrTail() {
    return this._stderr.trim();
  }

  /**
   * Start the host now (if needed) and wait for its startup ping.
   * @returns {Promise<object>} the ping result
   */
  async start() {
    if (this._closed) throw makeError('The Windows host was closed', 'CLOSED');
    await this._ensureChild();
    if (!this._inflight && !this._queue.length) this._ref(false);
    return this.info;
  }

  /**
   * Send one command and wait for its result.
   * @param {string} cmd
   * @param {object} [args]
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<any>} the response's result
   */
  request(cmd, args = {}, { timeoutMs } = {}) {
    if (this._closed) return Promise.reject(makeError('The Windows host was closed', 'CLOSED'));
    const ms = timeoutMs || (cmd === 'capture' ? this.captureTimeoutMs : this.timeoutMs);
    return new Promise((resolve, reject) => {
      this._queue.push({ cmd, args: args || {}, timeoutMs: ms, resolve, reject, retried: false });
      this._pump();
    });
  }

  /** End stdin, give the host 2 s to exit, then kill it. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const job of this._queue.splice(0)) job.reject(makeError('The Windows host was closed', 'CLOSED'));
    const child = this._child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._kill('close');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.stdin.end();
      } catch {
        clearTimeout(timer);
        this._kill('close');
        resolve();
      }
    });
  }

  // ------------------------------------------------------------ internals

  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (!this._closed && !this._inflight && this._queue.length) {
        try {
          await this._ensureChild();
        } catch (err) {
          for (const job of this._queue.splice(0)) job.reject(err);
          break;
        }
        if (this._inflight || !this._child || !this._queue.length) continue;
        this._send(this._queue.shift());
      }
    } finally {
      this._pumping = false;
      if (!this._inflight && !this._queue.length) this._ref(false);
    }
  }

  _ensureChild() {
    if (this._child && this._ready && !this._starting) return Promise.resolve();
    if (!this._starting) {
      this._starting = this._launch().finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  async _launch() {
    const now = Date.now();
    this._launches = this._launches.filter((t) => now - t < this.restartWindowMs);
    if (this._launches.length >= 1 + this.maxRestarts) {
      const tail = this.stderrTail();
      throw makeError(
        `The Windows PowerShell host keeps exiting (${this._launches.length} starts in the last ${Math.round(this.restartWindowMs / 1000)} s); not restarting it again yet`,
        'HOST_CRASH_LOOP',
        `${HINT_DOCTOR}${tail ? ` Last host output: ${tail.slice(-600)}` : ''}`,
        { stderr: tail },
      );
    }
    this._launches.push(now);
    if (this._launches.length > 1) log.warn(`restarting the PowerShell host (start ${this._launches.length} this minute)`);
    this._spawn();
    const child = this._child;
    let ping;
    try {
      ping = await new Promise((resolve, reject) => {
        this._send({ cmd: 'ping', args: {}, timeoutMs: this.startTimeoutMs, resolve, reject, retried: true, startup: true });
      });
    } catch (err) {
      // Detach a host that failed its startup ping so nothing else is sent to it.
      if (this._child === child) {
        this._kill('startup failed');
        this._child = null;
        this._inflight = null;
      }
      throw err;
    }
    this.info = ping || {};
    if (child && Number.isInteger(this.info.pid) && this.info.pid > 0) child.anywhereHostPid = this.info.pid;
    this._ready = this._child === child;
    log.debug('PowerShell host ready', this.info);
    return this.info;
  }

  _spawn() {
    this._stderr = '';
    this._ready = false;
    this.info = null;
    let child;
    try {
      child = spawn(this.exe, this.args, {
        cwd: this.cwd,
        env: this.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw this._spawnError(err);
    }
    this._child = child;
    this._spawnErr = null;
    let pending = [];
    let pendingLen = 0;
    child.stdout.on('data', (chunk) => {
      let start = 0;
      let nl = chunk.indexOf(10);
      while (nl !== -1) {
        const part = chunk.subarray(start, nl);
        const line = pending.length ? Buffer.concat([...pending, part]) : part;
        pending = [];
        pendingLen = 0;
        this._onLine(line);
        start = nl + 1;
        nl = chunk.indexOf(10, start);
      }
      if (start < chunk.length) {
        pending.push(chunk.subarray(start));
        pendingLen += chunk.length - start;
        if (pendingLen > MAX_LINE_BYTES) {
          pending = [];
          pendingLen = 0;
          this._noise('[dropped an oversized stdout line]');
          this._kill('oversized output');
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this._appendStderr(text);
      if (process.env.ANYWHERE_DEBUG === '1') log.debug(`host stderr: ${text.trimEnd()}`);
    });
    child.stdin.on('error', () => {
      /* EPIPE: the exit handler reports it */
    });
    child.on('error', (err) => {
      this._spawnErr = err;
      this._handleExit(child, null, null);
    });
    child.on('exit', (code, signal) => this._handleExit(child, code, signal));
    this._ref(true);
  }

  _spawnError(err) {
    const code = err && err.code;
    if (code === 'ENOENT') {
      return makeError(`PowerShell was not found at ${this.exe}`, 'UNSUPPORTED', this.wsl ? HINT_WSL_INTEROP : 'Check ANYWHERE_PS_EXE or that powershell.exe is installed.');
    }
    if (code === 'ENOEXEC' || code === 'EACCES') {
      return makeError(`Cannot execute ${this.exe} (${code})`, 'UNSUPPORTED', this.wsl ? HINT_WSL_INTEROP : HINT_DOCTOR);
    }
    return makeError(`Could not start PowerShell: ${err && err.message}`, 'HOST_EXITED', HINT_DOCTOR);
  }

  _appendStderr(text) {
    // PowerShell 7 colours its error output; keep plain text for messages and hints.
    const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    this._stderr = (this._stderr + plain).slice(-STDERR_KEEP_CHARS);
  }

  _noise(text) {
    this._appendStderr(`${text}\n`);
    log.debug(`host stdout (not protocol): ${text.slice(0, 300)}`);
  }

  _send(job) {
    job.id = this._nextId++;
    this._inflight = job;
    this._ref(true);
    job.timer = setTimeout(() => this._onTimeout(job), job.timeoutMs);
    const line = `${JSON.stringify({ id: job.id, cmd: job.cmd, args: job.args })}\n`;
    try {
      this._child.stdin.write(line, 'utf8');
    } catch (err) {
      log.debug(`write to host failed: ${err.message}`);
    }
  }

  _onLine(buf) {
    const text = buf.toString('utf8').replace(/\r$/, '');
    if (!text.trim()) return;
    let msg = null;
    if (text[0] === '{') {
      try {
        msg = JSON.parse(text);
      } catch {
        msg = null;
      }
    }
    if (!msg || typeof msg !== 'object' || !Object.prototype.hasOwnProperty.call(msg, 'id')) {
      this._noise(text);
      return;
    }
    const job = this._inflight;
    if (!job || msg.id !== job.id) {
      log.debug(`ignoring host response for id ${JSON.stringify(msg.id)}`);
      return;
    }
    // A late answer to a timed-out job comes from a host that is being killed: keep the job in
    // flight until _handleExit, so the queue moves on to a fresh host, not the dying one.
    if (job.timedOut) {
      log.debug(`ignoring late host response for id ${msg.id} ("${job.cmd}" timed out)`);
      return;
    }
    clearTimeout(job.timer);
    this._inflight = null;
    if (msg.ok) job.resolve(msg.result == null ? {} : msg.result);
    else job.reject(hostError(msg.error, job.cmd));
    this._pump();
  }

  _onTimeout(job) {
    if (this._inflight !== job) return;
    job.timedOut = true;
    const secs = Math.round(job.timeoutMs / 100) / 10;
    const tail = this.stderrTail();
    job.reject(
      makeError(
        job.startup
          ? `The Windows PowerShell host did not start within ${secs} s`
          : `The Windows PowerShell host did not answer "${job.cmd}" within ${secs} s`,
        'TIMEOUT',
        job.startup
          ? `PowerShell may be slow to start (antivirus scanning, first run). ${HINT_DOCTOR}`
          : 'The host was restarted; retry the action. A UAC prompt, a hung window or a busy clipboard can block the host.',
        { stderr: tail },
      ),
    );
    this._kill('timeout');
  }

  _kill(reason, target) {
    const child = target || this._child;
    if (!child) return;
    log.debug(`stopping PowerShell host (${reason})`);
    // Nothing more may be written to a host being killed; the next command starts a fresh one.
    if (child === this._child) this._ready = false;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    // From WSL the Linux-side process is only a relay; end the Windows process too. The PID is
    // the one this very child reported, never a previous host's.
    const winPid = child.anywhereHostPid;
    if (this.wsl && this.windowsExe && winPid && child.exitCode === null && child.signalCode === null) {
      const taskkill = proc.which('taskkill.exe') || (fs.existsSync(WSL_TASKKILL) ? WSL_TASKKILL : null);
      if (taskkill) proc.run(taskkill, ['/PID', String(winPid), '/T', '/F'], { timeoutMs: 5000 }).catch(() => {});
    }
    const timer = setTimeout(() => this._handleExit(child, null, 'SIGKILL'), KILL_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  _handleExit(child, code, signal) {
    if (child !== this._child) return;
    this._child = null;
    const tail = this.stderrTail();
    const spawnErr = this._spawnErr;
    this._spawnErr = null;
    let err;
    if (spawnErr) {
      err = this._spawnError(spawnErr);
    } else {
      const { code: errCode, hint } = exitHint(code, tail, this.wsl);
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      const detail = tail ? `: ${tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 500)}` : '';
      err = makeError(`The Windows PowerShell host stopped (${how})${detail}`, errCode, hint, { stderr: tail, exitCode: code });
    }
    const job = this._inflight;
    this._inflight = null;
    if (job) {
      clearTimeout(job.timer);
      if (!job.timedOut) {
        if (!this._closed && !job.startup && !job.retried && RETRYABLE.has(job.cmd)) {
          job.retried = true;
          this._queue.unshift(job);
        } else if (this._closed && !job.startup) {
          job.reject(makeError('The Windows host was closed', 'CLOSED'));
        } else {
          job.reject(err);
        }
      }
    }
    if (this._closed) {
      for (const j of this._queue.splice(0)) j.reject(makeError('The Windows host was closed', 'CLOSED'));
      return;
    }
    if (this._queue.length) this._pump();
  }

  _ref(on) {
    const child = this._child;
    if (!child) return;
    const method = on ? 'ref' : 'unref';
    for (const target of [child, child.stdin, child.stdout, child.stderr]) {
      if (target && typeof target[method] === 'function') {
        try {
          target[method]();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function toInt(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw makeError(`${name} must be a finite number (got ${value})`, 'BAD_ARGS');
  return Math.round(n);
}

function checkButton(button) {
  const b = String(button == null ? 'left' : button).toLowerCase();
  if (!BUTTONS.has(b)) throw makeError(`Unknown mouse button "${button}"`, 'BAD_ARGS', 'Use left, right or middle.');
  return b;
}

/**
 * Map click modifiers (names or a "ctrl+shift" string) to virtual-key codes.
 * @param {string[]|string} modifiers
 * @returns {number[]}
 */
function modifierVks(modifiers) {
  if (modifiers == null) return [];
  const list = Array.isArray(modifiers) ? modifiers : String(modifiers).split(/[+,\s]+/);
  const tokens = list.map((m) => String(m).trim()).filter(Boolean);
  if (!tokens.length) return [];
  const names = keysLib.normalizeCombo(tokens, { platform: 'win32' });
  return names.map((n) => {
    if (!MODIFIER_VK[n]) throw makeError(`"${n}" is not a modifier key`, 'BAD_ARGS', 'Click modifiers must be ctrl, alt, shift or meta.');
    return MODIFIER_VK[n];
  });
}

/**
 * Normalize a window id (decimal string, number, or 0x hex) to the decimal
 * string the host expects. Returns null when it is not a valid id.
 * @param {string|number} id
 * @returns {string|null}
 */
function normalizeWindowId(id) {
  if (typeof id === 'number') return Number.isSafeInteger(id) ? String(id) : null;
  const s = String(id == null ? '' : id).trim();
  if (/^-?\d{1,20}$/.test(s)) return s;
  if (/^0x[0-9a-f]{1,16}$/i.test(s)) return BigInt(s).toString(10);
  return null;
}

/**
 * Split text into chunks of at most `size` UTF-16 code units without
 * separating a surrogate pair.
 * @param {string} text
 * @param {number} [size]
 * @returns {string[]}
 */
function splitText(text, size = TYPE_CHUNK) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length && end > i + 1) {
      const c = text.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Host warnings on a result (e.g. input that Windows' UIPI may have dropped), logged and returned as
 * `{ warnings }` so callers can show them; undefined when there are none.
 * @param {...object} results host results
 * @returns {{warnings:string[]}|undefined}
 */
function hostWarnings(...results) {
  const warnings = [];
  for (const r of results) {
    if (!r || !Array.isArray(r.warnings)) continue;
    for (const w of r.warnings) {
      const text = String(w == null ? '' : w).trim();
      if (text && !warnings.includes(text)) warnings.push(text);
    }
  }
  if (!warnings.length) return undefined;
  for (const w of warnings) log.info(`host warning: ${w}`);
  return { warnings };
}

function endpointRecord(e) {
  if (!e || typeof e !== 'object' || !e.id) return null;
  return { id: String(e.id), name: String(e.name || '') };
}

/** One flow of audioDefaultGet: {flow, console, multimedia, communications, devices:[{id, name}]}. */
function audioFlowRecord(r) {
  const o = r && typeof r === 'object' ? r : {};
  const list = Array.isArray(o.devices) ? o.devices : o.devices && typeof o.devices === 'object' ? [o.devices] : [];
  return {
    flow: o.flow || null,
    console: endpointRecord(o.console),
    multimedia: endpointRecord(o.multimedia),
    communications: endpointRecord(o.communications),
    devices: list.map(endpointRecord).filter(Boolean),
  };
}

/**
 * Clamp an optional integer argument.
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {string} name
 * @returns {number}
 */
function clampInt(value, min, max, name) {
  return Math.max(min, Math.min(max, toInt(value, name)));
}

/**
 * The hwnd for an optional windowId: null when none is given (the host then uses the active
 * window); BAD_ARGS when one is given but is not a window id.
 * @param {string|number|undefined|null} windowId
 * @returns {string|null}
 */
function uiWindowArg(windowId) {
  if (windowId == null || windowId === '') return null;
  const hwnd = normalizeWindowId(windowId);
  if (!hwnd) throw makeError(`Invalid window id "${windowId}"`, 'BAD_ARGS', 'Use a window id from list_windows, or leave it out for the active window.');
  return hwnd;
}

/**
 * Normalize a role name to the shared vocabulary (case, spaces and common aliases).
 * @param {string} role
 * @returns {string} a UI_ROLES entry
 */
function normalizeUiRole(role) {
  const key = String(role == null ? '' : role).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (UI_ROLE_SET.has(key)) return key;
  if (Object.prototype.hasOwnProperty.call(UI_ROLE_ALIASES, key)) return UI_ROLE_ALIASES[key];
  throw makeError(`Unknown UI role "${role}"`, 'BAD_ARGS', `Use one of: ${UI_ROLES.join(', ')}.`);
}

/** A role filter (string, "a|b", or list) as a de-duplicated list, or undefined for none. */
function uiRoleFilter(role) {
  if (role == null || role === '') return undefined;
  const list = (Array.isArray(role) ? role : String(role).split(/[|,]/)).map((r) => String(r).trim()).filter(Boolean);
  if (!list.length) return undefined;
  return [...new Set(list.map(normalizeUiRole))];
}

/**
 * Validate a UI element id ("<hwnd>.<path>~<tag>") and return it trimmed, or null.
 * @param {string} id
 * @returns {string|null}
 */
function normalizeUiElementId(id) {
  const s = String(id == null ? '' : id).trim();
  return UI_ID_RE.test(s) ? s : null;
}

function uiBounds(b) {
  const o = b && typeof b === 'object' ? b : {};
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
  return { x: n(o.x), y: n(o.y), width: Math.max(0, n(o.width)), height: Math.max(0, n(o.height)) };
}

/** Value, description, bounds and state shared by tree nodes and search results. */
function uiState(out, n) {
  if (typeof n.value === 'string') out.value = n.value;
  if (n.valueTruncated) out.valueTruncated = true;
  if (typeof n.description === 'string' && n.description) out.description = n.description;
  out.bounds = uiBounds(n.bounds);
  out.enabled = n.enabled !== false;
  out.focused = Boolean(n.focused);
  if (typeof n.selected === 'boolean') out.selected = n.selected;
  if (n.checked === true || n.checked === false || n.checked === 'mixed') out.checked = n.checked;
  if (typeof n.expanded === 'boolean') out.expanded = n.expanded;
  if (n.offscreen) out.offscreen = true;
  return out;
}

function uiRole(role) {
  return UI_ROLE_SET.has(role) ? role : 'other';
}

/** A uitree node from the host in the shared shape. */
function uiNodeRecord(n) {
  const out = uiState({ id: String(n.id), role: uiRole(n.role), name: n.name == null ? '' : String(n.name) }, n);
  out.parent = n.parent == null ? null : String(n.parent);
  out.children = Array.isArray(n.children) ? n.children.map(String) : [];
  if (Number.isInteger(n.depth)) out.depth = n.depth;
  return out;
}

/** A uifind match from the host in the shared shape. */
function uiMatchRecord(m) {
  const out = { id: String(m.id), role: uiRole(m.role), name: m.name == null ? '' : String(m.name), value: null };
  uiState(out, m);
  if (typeof m.value !== 'string') out.value = null;
  out.windowId = String(m.windowId == null ? '' : m.windowId);
  out.path = String(m.path == null ? '' : m.path);
  return out;
}

/** Attach non-enumerable metadata (truncated, warnings, ...) to a result list. */
function withMeta(list, meta) {
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) Object.defineProperty(list, key, { value, enumerable: false, configurable: true, writable: true });
  }
  return list;
}

function windowRecord(w) {
  return {
    id: String(w.hwnd),
    app: w.app || w.process || '',
    title: w.title || '',
    pid: Number(w.pid) || 0,
    x: Number(w.x) || 0,
    y: Number(w.y) || 0,
    width: Number(w.width) || 0,
    height: Number(w.height) || 0,
    focused: Boolean(w.focused),
    minimized: Boolean(w.minimized),
    process: w.process || '',
    // null: another account's process, so the host cannot tell whether it runs elevated.
    elevated: w.elevated === null ? null : Boolean(w.elevated),
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

class Win32Driver {
  /**
   * @param {PsHost} host
   * @param {{wsl?:boolean}} [opts]
   */
  constructor(host, { wsl = false } = {}) {
    this.name = wsl ? 'wsl' : 'win32';
    this.wsl = wsl;
    this.host = host;
  }

  /** The host's ping result: PowerShell version, DPI mode, elevation, PID. */
  async hostInfo() {
    return this.host.request('ping');
  }

  async capabilities() {
    const notes = [];
    try {
      const info = await this.host.request('ping');
      const ok = info.native !== false && info.windows !== false;
      if (info.ps) notes.push(`PowerShell ${info.ps}${info.edition ? ` (${info.edition})` : ''}${info.is64 === false ? ', 32-bit' : ''}; DPI awareness: ${info.dpi || 'unknown'}.`);
      if (this.wsl) notes.push('WSL: the Windows desktop is driven through powershell.exe.');
      if (info.windows === false) notes.push('The PowerShell host is not running on Windows, so desktop control is unavailable.');
      if (info.native === false) notes.push(`The Windows API bridge failed to compile: ${info.nativeError || 'unknown error'}.`);
      if (ok) {
        notes.push(
          info.elevated
            ? 'The host runs as administrator, so it can also control elevated windows.'
            : 'Windows (UIPI) blocks input to apps running as administrator; such actions fail with UIPI_BLOCKED unless Claude Anywhere runs elevated too. ' +
                'Input to a window of another user account (e.g. an installer started with an administrator\'s credentials) returns a warning, because Windows does not say whether it is elevated.',
        );
      }
      const ui = ok ? await this._uiAvailable(notes) : false;
      return { screenshot: ok, mouse: ok, keyboard: ok, windows: ok, clipboard: ok, notify: ok, speak: ok, ui, notes };
    } catch (err) {
      notes.push(`The Windows PowerShell host is not working: ${err.message}`);
      if (err.hint) notes.push(err.hint);
      return { screenshot: false, mouse: false, keyboard: false, windows: false, clipboard: false, notify: false, speak: false, ui: false, notes };
    }
  }

  /** capabilities().ui: whether UI Automation loads in the host; adds a note either way. */
  async _uiAvailable(notes) {
    try {
      const r = await this.host.request('uiinfo', {}, { timeoutMs: UI_INFO_TIMEOUT_MS });
      if (r && r.available) {
        notes.push(`UI Automation: controls can be found by name and role and pressed, set or selected without the mouse. ${HINT_UI_CHROMIUM}`);
        return true;
      }
      notes.push(`UI Automation is not available (${(r && r.error) || 'unknown reason'}); work from screenshots and coordinates.`);
    } catch (err) {
      notes.push(`UI Automation could not be checked: ${err.message}`);
    }
    return false;
  }

  async displays() {
    const r = await this.host.request('displays');
    const list = Array.isArray(r.displays) ? r.displays : [];
    return list.map((d, i) => ({
      index: i,
      id: d.id != null && d.id !== '' ? d.id : i,
      x: Number(d.x) || 0,
      y: Number(d.y) || 0,
      width: Number(d.width) || 0,
      height: Number(d.height) || 0,
      scale: 1,
      dpiScale: Number(d.dpiScale) || 1,
      primary: Boolean(d.primary),
    }));
  }

  async captureDisplay(index = 0) {
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0) throw makeError(`Invalid display index ${index}`, 'BAD_ARGS');
    const r = await this.host.request('capture', { index: idx });
    const png = Buffer.from(String(r.png || ''), 'base64');
    if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw makeError('The Windows host returned an invalid screenshot', 'CAPTURE_FAILED', HINT_DOCTOR);
    }
    // IHDR is authoritative for the pixel size.
    return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  }

  async cursorPosition() {
    const r = await this.host.request('cursor');
    return { x: Number(r.x), y: Number(r.y) };
  }

  async moveMouse(x, y) {
    await this.host.request('move', { x: toInt(x, 'x'), y: toInt(y, 'y') });
  }

  // Input commands resolve to undefined, or to { warnings } when the input may not have arrived.

  async click(x, y, { button = 'left', clicks = 1, modifiers = [] } = {}) {
    const args = { button: checkButton(button), clicks: Math.max(1, Math.min(10, toInt(clicks, 'clicks'))), modifiers: modifierVks(modifiers) };
    if (x != null && y != null) {
      args.x = toInt(x, 'x');
      args.y = toInt(y, 'y');
    }
    return hostWarnings(await this.host.request('click', args));
  }

  async mouseDown(button = 'left') {
    return hostWarnings(await this.host.request('down', { button: checkButton(button) }));
  }

  async mouseUp(button = 'left') {
    await this.host.request('up', { button: checkButton(button) });
  }

  async drag(x1, y1, x2, y2, { button = 'left' } = {}) {
    const r = await this.host.request('drag', {
      x1: toInt(x1, 'x1'),
      y1: toInt(y1, 'y1'),
      x2: toInt(x2, 'x2'),
      y2: toInt(y2, 'y2'),
      button: checkButton(button),
    });
    return hostWarnings(r);
  }

  async scroll(x, y, dx, dy) {
    const clamp = (v, n) => Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, v == null ? 0 : toInt(v, n)));
    const args = { dx: clamp(dx, 'dx'), dy: clamp(dy, 'dy') };
    if (x != null && y != null) {
      args.x = toInt(x, 'x');
      args.y = toInt(y, 'y');
    }
    return hostWarnings(await this.host.request('scroll', args));
  }

  async typeText(text) {
    const s = String(text == null ? '' : text);
    const results = [];
    for (const chunk of splitText(s)) {
      results.push(await this.host.request('type', { text: chunk }, { timeoutMs: this.host.timeoutMs + chunk.length * 5 }));
    }
    return hostWarnings(...results);
  }

  async keyCombo(keys) {
    const vks = keysLib.toWindowsVk(keys);
    if (!vks.length) throw makeError('No keys to press', 'BAD_ARGS');
    return hostWarnings(await this.host.request('keys', { vks }));
  }

  async listWindows() {
    const r = await this.host.request('windows');
    return (Array.isArray(r.windows) ? r.windows : []).map(windowRecord);
  }

  async activeWindow() {
    const r = await this.host.request('active');
    if (!r.window) return null;
    const w = windowRecord(r.window);
    // process (e.g. cmd.exe, OpenConsole.exe) lets the permission broker tell when type_text lands in a terminal.
    return { id: w.id, app: w.app, title: w.title, pid: w.pid, process: w.process };
  }

  async focusWindow(id) {
    const hwnd = normalizeWindowId(id);
    if (!hwnd) return false;
    const r = await this.host.request('focus', { hwnd });
    return Boolean(r.ok);
  }

  async minimizeWindow(id) {
    const hwnd = normalizeWindowId(id);
    if (!hwnd) return false;
    const r = await this.host.request('minimize', { hwnd });
    return Boolean(r.ok);
  }

  async setTopmost(id, on) {
    const hwnd = normalizeWindowId(id);
    if (!hwnd) return false;
    const r = await this.host.request('topmost', { hwnd, on: Boolean(on) });
    return Boolean(r.ok);
  }

  /**
   * Move/resize a window's visible frame, or change its state (Driver.setWindowBounds).
   * 'fullscreen' maximizes (Win32 has no generic full-screen mode); bounds may be partial and
   * can be combined with 'restore'. A minimized or maximized window is restored before it moves.
   * @param {string|number} windowId
   * @param {{x?:number,y?:number,width?:number,height?:number,state?:'maximize'|'minimize'|'restore'|'fullscreen'}} spec
   * @returns {Promise<boolean>} false when the window is gone or Windows refused (e.g. an elevated window)
   */
  async setWindowBounds(windowId, spec = {}) {
    if (!spec || typeof spec !== 'object') throw makeError('setWindowBounds needs {x, y, width, height} or {state}', 'BAD_ARGS');
    const args = {};
    if (spec.state != null && spec.state !== '') {
      const state = WINDOW_STATES[String(spec.state).trim().toLowerCase()];
      if (!state) throw makeError(`Unknown window state "${spec.state}"`, 'BAD_ARGS', 'Use maximize, minimize, restore or fullscreen.');
      args.state = state;
    }
    const keys = ['x', 'y', 'width', 'height'].filter((k) => spec[k] != null);
    if (!args.state && !keys.length) throw makeError('setWindowBounds needs {x, y, width, height} or {state}', 'BAD_ARGS');
    if (keys.length && args.state && args.state !== 'restore') {
      throw makeError(`Give either bounds or "${spec.state}", not both`, 'BAD_ARGS', 'Bounds can be combined with state "restore" only.');
    }
    for (const k of keys) {
      const v = clampInt(spec[k], -1000000, 1000000, k);
      if ((k === 'width' || k === 'height') && v < 1) throw makeError(`${k} must be at least 1 (got ${spec[k]})`, 'BAD_ARGS');
      args[k] = v;
    }
    const hwnd = normalizeWindowId(windowId);
    if (!hwnd) return false;
    args.hwnd = hwnd;
    const r = await this.host.request('winbounds', args, { timeoutMs: WINDOW_BOUNDS_TIMEOUT_MS });
    if (!r.ok) log.debug(`setWindowBounds ${hwnd}: ${r.error || 'refused'}`);
    return Boolean(r.ok);
  }

  /**
   * The UI Automation tree of a window (Driver.uiTree), compacted: unnamed containers, decorative
   * images and text that repeats its parent's name are walked through but not listed, so depth
   * counts listed levels. Nodes come in pre-order; bounds are physical pixels (logical on Windows).
   * @param {{windowId?:string|number, depth?:number, maxNodes?:number, budgetMs?:number, compact?:boolean}} [opts]
   * @returns {Promise<{window:{id:string,app:string,title:string}, nodes:object[], truncated:boolean,
   *   scanned?:number, popups?:string[], warnings?:string[]}>}
   */
  async uiTree({ windowId, depth = 6, maxNodes = 400, budgetMs = UI_BUDGET_MS, compact = true } = {}) {
    const args = {
      depth: clampInt(depth == null ? 6 : depth, 1, 60, 'depth'),
      maxNodes: clampInt(maxNodes == null ? 400 : maxNodes, 1, 5000, 'maxNodes'),
      budgetMs: clampInt(budgetMs == null ? UI_BUDGET_MS : budgetMs, 100, UI_MAX_BUDGET_MS, 'budgetMs'),
      compact: compact !== false,
    };
    const hwnd = uiWindowArg(windowId);
    if (hwnd) args.hwnd = hwnd;
    const r = await this.host.request('uitree', args, { timeoutMs: args.budgetMs + UI_TIMEOUT_MARGIN_MS });
    const w = (r && r.window) || {};
    const result = {
      window: { id: String(w.id == null ? hwnd || '' : w.id), app: String(w.app || ''), title: String(w.title || '') },
      nodes: (Array.isArray(r.nodes) ? r.nodes : []).map(uiNodeRecord),
      truncated: Boolean(r.truncated),
    };
    if (Number.isFinite(r.scanned)) result.scanned = r.scanned;
    if (Array.isArray(r.popups) && r.popups.length) result.popups = r.popups.map(String);
    const warn = hostWarnings(r);
    if (warn) result.warnings = warn.warnings;
    return result;
  }

  /**
   * Find UI elements of a window (Driver.uiFind) by name (the accessible name), text (name, value
   * or description), and/or role; case-insensitive substring, or whole text with exact. The app's
   * open menus and drop-downs are searched first. Best matches first: exact, then prefix, then
   * substring; on-screen and enabled before the rest.
   * The list also carries non-enumerable truncated, scanned, window and warnings.
   * @param {{windowId?:string|number, name?:string, role?:string|string[], text?:string, exact?:boolean,
   *   limit?:number, depth?:number, maxNodes?:number, budgetMs?:number}} [opts]
   * @returns {Promise<Array<{id,role,name,value,bounds,windowId,path,enabled,focused}>>}
   */
  async uiFind({ windowId, name, role, text, exact = false, limit = 20, depth, maxNodes, budgetMs = UI_BUDGET_MS } = {}) {
    const args = {
      exact: Boolean(exact),
      limit: clampInt(limit == null ? 20 : limit, 1, 200, 'limit'),
      budgetMs: clampInt(budgetMs == null ? UI_BUDGET_MS : budgetMs, 100, UI_MAX_BUDGET_MS, 'budgetMs'),
    };
    const n = name == null ? '' : String(name).trim();
    const t = text == null ? '' : String(text).trim();
    const roles = uiRoleFilter(role);
    if (!n && !t && !roles) throw makeError('uiFind needs a name, text or role to look for', 'BAD_ARGS', 'Example: { name: "Save", role: "button" }');
    if (n) args.name = n;
    if (t) args.text = t;
    if (roles) args.role = roles;
    if (depth != null) args.depth = clampInt(depth, 1, 100, 'depth');
    if (maxNodes != null) args.maxNodes = clampInt(maxNodes, 1, 20000, 'maxNodes');
    const hwnd = uiWindowArg(windowId);
    if (hwnd) args.hwnd = hwnd;
    const r = await this.host.request('uifind', args, { timeoutMs: args.budgetMs + UI_TIMEOUT_MARGIN_MS });
    const list = (Array.isArray(r.matches) ? r.matches : []).map(uiMatchRecord);
    const w = r.window && typeof r.window === 'object' ? { id: String(r.window.id), app: String(r.window.app || ''), title: String(r.window.title || '') } : undefined;
    const warn = hostWarnings(r);
    return withMeta(list, {
      truncated: Boolean(r.truncated),
      scanned: Number.isFinite(r.scanned) ? r.scanned : undefined,
      window: w,
      warnings: warn ? warn.warnings : undefined,
    });
  }

  /**
   * Act on a UI element without the mouse (Driver.uiAction), through its UI Automation patterns:
   * press = Invoke, else Toggle, SelectionItem, ExpandCollapse, then the MSAA default action;
   * focus = SetFocus; setValue = ValuePattern (or RangeValue for sliders); select = SelectionItem
   * (with a value: the item of that name in a list, combo box or menu, expanding it first);
   * expand / collapse = ExpandCollapse; scrollIntoView = ScrollItem; showMenu = expand a menu
   * button, else focus + Shift+F10.
   * ok:false with method 'none' means none of these worked (reason says why): click at bounds.
   * pending: the app had not returned after 2 s (a modal dialog the press opened, usually).
   * @param {{id:string, action?:string, value?:string|number}} opts
   * @returns {Promise<{ok:boolean, method:string, pending?:boolean, reason?:string, disabled?:boolean,
   *   item?:object, role?:string, name?:string, bounds?:object, value?:string, warnings?:string[]}>}
   */
  async uiAction({ id, action = 'press', value } = {}) {
    const elementId = normalizeUiElementId(id);
    if (!elementId) throw makeError(`Invalid UI element id "${id}"`, 'BAD_ARGS', 'Use an id returned by uiFind or uiTree.');
    const act = UI_ACTIONS.get(String(action == null ? 'press' : action).trim().toLowerCase());
    if (!act) throw makeError(`Unknown UI action "${action}"`, 'BAD_ARGS', `Use one of: ${[...UI_ACTIONS.values()].join(', ')}.`);
    const args = { id: elementId, action: act };
    if (value != null) args.value = String(value);
    if (act === 'setValue' && args.value == null) throw makeError('setValue needs a value', 'BAD_ARGS');
    const r = await this.host.request('uiaction', args, { timeoutMs: UI_ACTION_TIMEOUT_MS });
    const out = { ok: Boolean(r.ok), method: typeof r.method === 'string' && r.method ? r.method : 'none' };
    if (r.pending) out.pending = true;
    if (typeof r.reason === 'string' && r.reason) out.reason = r.reason;
    if (r.disabled) out.disabled = true;
    if (r.item && typeof r.item === 'object') out.item = { id: String(r.item.id), role: uiRole(r.item.role), name: String(r.item.name || '') };
    if (typeof r.role === 'string') out.role = uiRole(r.role);
    if (typeof r.name === 'string') out.name = r.name;
    if (r.bounds) out.bounds = uiBounds(r.bounds);
    if (typeof r.value === 'string') out.value = r.value;
    const warn = hostWarnings(r);
    if (warn) out.warnings = warn.warnings;
    return out;
  }

  async clipboardGet() {
    const r = await this.host.request('clipget');
    return r.text == null ? '' : String(r.text);
  }

  async clipboardSet(text) {
    // Windows clipboard text uses CRLF line endings.
    const s = String(text == null ? '' : text).replace(/\r?\n/g, '\r\n');
    await this.host.request('clipset', { text: s });
  }

  /**
   * Read the active tab of a browser window (Driver.browserTab). The address comes from the
   * address bar through UI Automation (no input; the value may lack the scheme, which is added
   * back); the page text, and the address when UI Automation finds no address bar, come from the
   * keyboard reader in linux.js (focus, Ctrl+L / Ctrl+A and copy, clipboard restored).
   * @param {{app?:string, windowId?:string, includeText?:boolean, maxChars?:number, keyboard?:boolean,
   *   beforeInput?:Function}} [opts]
   */
  async browserTab(opts = {}) {
    const tabs = require('./linux');
    return tabs.readBrowserTab(this, opts, {
      platform: 'win32',
      native: (win) => this._browserTabUia(win),
    });
  }

  /** UI Automation half of browserTab: {url, title, method:'uia'} or null when no address bar was found. */
  async _browserTabUia(win) {
    const hwnd = normalizeWindowId(win.id);
    if (!hwnd) return null;
    const r = await this.host.request('browsertab', { hwnd, budgetMs: BROWSER_TAB_BUDGET_MS }, { timeoutMs: BROWSER_TAB_TIMEOUT_MS });
    if (!r || !r.found) return null;
    const raw = typeof r.url === 'string' ? r.url.trim() : '';
    // With focus in the address bar the value may be text the user is typing, not the page's address.
    if (!raw || (r.editing && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/[./]/.test(raw))) return null;
    return { url: raw, title: typeof r.title === 'string' ? r.title : '', method: 'uia' };
  }

  /** Show a tray balloon / toast (not part of the Driver contract). */
  async notify(title, body = '') {
    await this.host.request('notify', { title: String(title == null ? '' : title), body: String(body == null ? '' : body) });
  }

  // ------------------------------------------------ call audio, notifications, Desktop (docs/CALLS-DESIGN.md §5.2, §4.1B, §8.1)
  // Not part of the Driver contract; used by src/calls (audio-bridge.js, notifications, notes).

  /**
   * Default audio endpoints and the active devices (Core Audio).
   * @param {'capture'|'render'|'all'|{flow?:string}} [flow='capture']
   * @returns {Promise<{flow:string, console:{id,name}|null, multimedia:{id,name}|null, communications:{id,name}|null,
   *   devices:Array<{id:string,name:string}>}|{capture:object, render:object}>}
   */
  async audioDefaultGet(flow = 'capture') {
    const f = flow && typeof flow === 'object' ? flow.flow || 'capture' : flow || 'capture';
    if (!AUDIO_FLOWS.has(f)) throw makeError(`Unknown audio flow ${f} (capture, render or all)`, 'BAD_ARGS');
    const r = await this.host.request('audioDefaultGet', { flow: f }, { timeoutMs: AUDIO_TIMEOUT_MS });
    if (f === 'all') return { capture: audioFlowRecord(r && r.capture), render: audioFlowRecord(r && r.render) };
    return audioFlowRecord(r);
  }

  /**
   * Make a device the default for some roles (IPolicyConfig). With `onlyIf`, a role changes only while its
   * current default is that device id (restoring must not undo a choice the user made meanwhile).
   * @param {{id?:string, name?:string, flow?:'capture'|'render', roles?:string[], onlyIf?:string}} opts
   * @returns {Promise<{ok:boolean, id:string, name:string, flow:string, roles:string[], skipped:string[]}>}
   */
  async audioDefaultSet({ id, name, flow = 'capture', roles = AUDIO_ROLES, onlyIf } = {}) {
    if (flow !== 'capture' && flow !== 'render') throw makeError(`Unknown audio flow ${flow} (capture or render)`, 'BAD_ARGS');
    const args = { flow, roles: [] };
    if (id != null && id !== '') {
      if (typeof id !== 'string' || !AUDIO_ID_RE.test(id)) throw makeError('Invalid audio device id', 'BAD_ARGS');
      args.id = id;
    } else if (typeof name === 'string' && name.trim() && name.length <= 256) {
      args.name = name.trim();
    } else {
      throw makeError('Pass the device id or name', 'BAD_ARGS');
    }
    for (const r of Array.isArray(roles) ? roles : [roles]) {
      if (!AUDIO_ROLES.includes(r)) throw makeError(`Unknown audio role ${r}`, 'BAD_ARGS');
      if (!args.roles.includes(r)) args.roles.push(r);
    }
    if (!args.roles.length) throw makeError('No audio role to change', 'BAD_ARGS');
    if (onlyIf != null && onlyIf !== '') {
      if (typeof onlyIf !== 'string' || !AUDIO_ID_RE.test(onlyIf)) throw makeError('Invalid onlyIf device id', 'BAD_ARGS');
      args.onlyIf = onlyIf;
    }
    const r = (await this.host.request('audioDefaultSet', args, { timeoutMs: AUDIO_TIMEOUT_MS })) || {};
    const arr = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
    return { ok: r.ok !== false, id: String(r.id || ''), name: String(r.name || ''), flow: r.flow || flow, roles: arr(r.roles), skipped: arr(r.skipped) };
  }

  /**
   * Texts of the toast notifications on screen (UI Automation of the toast host; Chromium browsers and
   * Electron apps show native toasts for web notifications).
   * @param {{budgetMs?:number, maxNodes?:number, processes?:string[], classes?:string[]}} [opts]
   * @returns {Promise<Array<{process:string, pid:number, className:string, name:string, texts:string[],
   *   bounds:{x,y,width,height}|null}>>}
   */
  async toastTexts({ budgetMs = 1500, maxNodes = 400, processes, classes } = {}) {
    const args = { budgetMs: Math.max(100, Math.min(10000, toInt(budgetMs, 'budgetMs'))), maxNodes: Math.max(10, Math.min(5000, toInt(maxNodes, 'maxNodes'))) };
    const names = (v, what) => {
      const list = (Array.isArray(v) ? v : [v]).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
      if (!list.length || list.length > 16 || list.some((x) => x.length > 128)) throw makeError(`Invalid ${what}`, 'BAD_ARGS');
      return list;
    };
    if (processes != null) args.processes = names(processes, 'processes');
    if (classes != null) args.classes = names(classes, 'classes');
    const r = await this.host.request('toastTexts', args, { timeoutMs: args.budgetMs + 10000 });
    const list = r && Array.isArray(r.toasts) ? r.toasts : r && r.toasts && typeof r.toasts === 'object' ? [r.toasts] : [];
    return list.map((t) => ({
      process: String(t.process || ''),
      pid: Number(t.pid) || 0,
      className: String(t.className || ''),
      name: String(t.name || ''),
      texts: (Array.isArray(t.texts) ? t.texts : t.texts ? [t.texts] : []).map(String),
      bounds: t.bounds && typeof t.bounds === 'object' ? { x: Number(t.bounds.x) || 0, y: Number(t.bounds.y) || 0, width: Number(t.bounds.width) || 0, height: Number(t.bounds.height) || 0 } : null,
    }));
  }

  /**
   * The Desktop folder as Explorer resolves it ([Environment]::GetFolderPath('Desktop'): OneDrive Known
   * Folder Move, GPO redirection), plus fallbacks. In WSL `wslPath` is its /mnt/<drive>/... path.
   * @returns {Promise<{path:string, exists:boolean, registry:string|null, oneDrive:string|null, userProfile:string|null, wslPath?:string|null}>}
   */
  async desktopPath() {
    const r = (await this.host.request('desktopPath')) || {};
    const out = {
      path: typeof r.path === 'string' ? r.path : '',
      exists: Boolean(r.exists),
      registry: typeof r.registry === 'string' && r.registry ? r.registry : null,
      oneDrive: typeof r.oneDrive === 'string' && r.oneDrive ? r.oneDrive : null,
      userProfile: typeof r.userProfile === 'string' && r.userProfile ? r.userProfile : null,
    };
    if (this.wsl) out.wslPath = out.path ? winToWslPath(out.path) : null;
    return out;
  }

  async close() {
    await this.host.close();
  }
}

/**
 * Create the Windows driver and start its PowerShell host (unless `lazy`).
 * @param {{wsl?:boolean,lazy?:boolean,env?:object,platform?:string,timeoutMs?:number,captureTimeoutMs?:number,
 *   startTimeoutMs?:number,maxRestarts?:number,restartWindowMs?:number}} [opts]
 * @returns {Promise<Win32Driver>}
 */
async function createDriver(opts = {}) {
  const { wsl = false, lazy = false, env = process.env, platform = process.platform } = opts;
  const cmd = await resolveHostCommand({ wsl, env, platform });
  log.debug(`PowerShell host: ${cmd.exe} ${cmd.args.join(' ')}`);
  const host = new PsHost({
    exe: cmd.exe,
    args: cmd.args,
    cwd: cmd.cwd,
    env,
    wsl,
    windowsExe: cmd.windowsExe,
    timeoutMs: opts.timeoutMs,
    captureTimeoutMs: opts.captureTimeoutMs,
    startTimeoutMs: opts.startTimeoutMs,
    maxRestarts: opts.maxRestarts,
    restartWindowMs: opts.restartWindowMs,
  });
  const driver = new Win32Driver(host, { wsl });
  if (!lazy) {
    try {
      await host.start();
    } catch (err) {
      await host.close().catch(() => {});
      throw err;
    }
  }
  return driver;
}

module.exports = {
  createDriver,
  PsHost,
  Win32Driver,
  resolveHostCommand,
  locatePowerShell,
  stageWslScript,
  winToWslPath,
  splitText,
  modifierVks,
  normalizeWindowId,
  normalizeUiRole,
  normalizeUiElementId,
  UI_ROLES,
  HOST_SCRIPT,
};
