'use strict';

/**
 * ClaudeCliEngine: runs the user's own `claude` CLI headless in stream-json
 * mode and turns its stdout into parsed messages.
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *          --include-partial-messages (--session-id <uuid> | --resume <id>)
 *          --mcp-config <file> --permission-prompt-tool mcp__anywhere__permission_prompt
 *          --permission-mode default [--settings <file>]
 *          --append-system-prompt-file <file> --allowedTools <list> [--disallowedTools <list>]
 *          [...] [--add-dir <dir>...]
 *
 * One process serves many turns: each send() writes a JSONL user message,
 * interrupt() sends a control_request and the process stays alive. The engine
 * tracks whether a turn is running (send/init → active, result → idle) so an
 * interrupt of an idle CLI ends on its control_response instead of a kill.
 *
 * Events: 'spawn' ({pid}), 'message' (parsed stdout JSON), 'stderr' (line),
 *         'exit' ({code, signal, stderrTail, error, expected, sawInit, uptimeMs}).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const proc = require('../shared/proc');
const { uuid } = require('../shared/util');
const { createLogger } = require('../shared/log');

const log = createLogger('engine');

const STDERR_TAIL_LINES = 50;
const INTERRUPT_TIMEOUT_MS = 4000;
const INTERRUPT_KILL_AFTER_MS = 1500; // SIGTERM first (the CLI cleans up its commands), then SIGKILL
const STOP_KILL_AFTER_MS = 3000;
const MAX_LINE_BYTES = 128 * 1024 * 1024;
const PERMISSION_TOOL = 'mcp__anywhere__permission_prompt';
// The CLI's ask-first mode ("default"; 2.1.x also calls it "manual"), so the user's own
// permissions.defaultMode (acceptEdits, bypassPermissions, …) cannot bypass the dialog's approvals.
const DEFAULT_PERMISSION_MODE = 'default';

const DEFAULT_STRIP_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'CLAUDE_CODE_TEE_SDK_STDOUT',
];

const SCRIPT_EXT = /\.(c|m)?js$/i;
const WIN_SHELL_EXT = /\.(cmd|bat)$/i;
// npm cmd-shims name their target relative to the shim: "%dp0%\node_modules\…\cli.js" (or %~dp0).
const SHIM_TARGET_RE = /"%~?dp0%?[\\/]*([^"%]+?\.(?:c|m)?js|[^"%]+?\.exe)"/gi;
const NPM_CLI_REL = ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'];

/**
 * Known install locations of the claude CLI, most specific first.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {string[]}
 */
function knownInstallPaths(env = process.env, platform = process.platform) {
  const home = os.homedir();
  const list = [
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
  ];
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const userProfile = env.USERPROFILE || home;
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.win32.join(appData, 'npm', 'claude.cmd'),
      path.win32.join(userProfile, '.local', 'bin', 'claude.exe'),
      path.win32.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.win32.join(home, '.claude', 'local', 'claude.cmd'),
      path.win32.join(home, '.claude', 'local', 'claude.exe'),
      path.win32.join(home, '.bun', 'bin', 'claude.exe'),
    ];
  }
  return list;
}

function isUsableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32' && !SCRIPT_EXT.test(p)) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(p) {
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The script or executable an npm .cmd shim runs (claude.cmd → …\@anthropic-ai\claude-code\cli.js),
 * so it can be started without cmd.exe. Returns null when the shim names no existing target.
 * @param {string} shimPath
 * @returns {string|null}
 */
function resolveCmdShim(shimPath) {
  if (!isFile(shimPath)) return null;
  const dir = path.dirname(shimPath);
  const local = (rel) => path.join(dir, ...String(rel).split(/[\\/]+/).filter(Boolean));
  let text = '';
  try {
    text = fs.readFileSync(shimPath, 'utf8');
  } catch {
    /* unreadable: try the npm layout below */
  }
  const targets = [];
  for (const m of text.matchAll(SHIM_TARGET_RE)) {
    // The shim also mentions "%dp0%\node.exe" (a node next to the shim); that is the runtime, not the target.
    if (!/^node(\.exe)?$/i.test(path.basename(m[1].replace(/\\/g, '/')))) targets.push(local(m[1]));
  }
  for (const t of targets.reverse()) if (isFile(t)) return t;
  const npmCli = path.join(dir, ...NPM_CLI_REL);
  return isFile(npmCli) ? npmCli : null;
}

/**
 * Decide how to launch a CLI path: directly, through node (scripts and npm
 * .cmd shims whose cli.js is found), or as a last resort via cmd.exe for other
 * Windows .cmd/.bat files (every argument quoted). cmd.exe cannot use a UNC
 * working directory, so shims are resolved whenever possible.
 * @param {string} cliPath
 * @param {string[]} args
 * @returns {{command:string, args:string[], shell:boolean}}
 */
function launchSpec(cliPath, args, platform = process.platform) {
  if (SCRIPT_EXT.test(cliPath) && (platform === 'win32' || !isExecutable(cliPath))) {
    return { command: process.execPath, args: [cliPath, ...args], shell: false };
  }
  if (platform === 'win32' && WIN_SHELL_EXT.test(cliPath)) {
    const target = resolveCmdShim(cliPath);
    if (target && SCRIPT_EXT.test(target)) return { command: process.execPath, args: [target, ...args], shell: false };
    if (target && /\.exe$/i.test(target)) return { command: target, args: args.slice(), shell: false };
    return { command: proc.quoteWinArg(cliPath), args: args.map((a) => proc.quoteWinArg(a)), shell: true };
  }
  return { command: cliPath, args: args.slice(), shell: false };
}

/** @returns {boolean} a UNC path (\\server\share, \\wsl.localhost\Distro\…), which cmd.exe cannot use as its cwd */
function isUncPath(p) {
  return /^(\\\\|\/\/)[^\\/]/.test(String(p || ''));
}

/**
 * Parse `claude --version` output ("2.1.302 (Claude Code)").
 * @param {string} out
 * @returns {string|null}
 */
function parseVersion(out) {
  const s = String(out || '').trim();
  if (!s) return null;
  const m = s.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return m ? m[0] : s.split(/\r?\n/)[0].slice(0, 80);
}

/**
 * Build the CLI argument list in the contract's order.
 * @param {object} o constructor options
 * @returns {string[]}
 */
function buildArgs(o = {}) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (o.sessionId) {
    if (o.resume) args.push('--resume', String(o.sessionId));
    else args.push('--session-id', String(o.sessionId));
  }
  if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath);
  args.push('--permission-prompt-tool', o.permissionPromptTool || PERMISSION_TOOL);
  const extra = Array.isArray(o.extraArgs) ? o.extraArgs.map((a) => String(a == null ? '' : a)) : [];
  const hasFlag = (name) => extra.some((a) => a === name || a.startsWith(`${name}=`));
  // engine.extraArgs may override these on purpose.
  if (!hasFlag('--permission-mode')) args.push('--permission-mode', String(o.permissionMode || DEFAULT_PERMISSION_MODE));
  if (o.settingsPath && !hasFlag('--settings')) args.push('--settings', String(o.settingsPath));
  if (o.systemPromptPath) args.push('--append-system-prompt-file', o.systemPromptPath);
  const allowed = Array.isArray(o.allowedTools) ? o.allowedTools.filter(Boolean) : [];
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  const disallowed = Array.isArray(o.disallowedTools) ? o.disallowedTools.filter(Boolean) : [];
  if (disallowed.length) args.push('--disallowedTools', disallowed.join(','));
  if (o.model) args.push('--model', String(o.model));
  if (o.fallbackModel) args.push('--fallback-model', String(o.fallbackModel));
  if (o.effort) args.push('--effort', String(o.effort));
  if (o.chrome) args.push('--chrome');
  if (Number(o.maxBudgetUsd) > 0) args.push('--max-budget-usd', String(Number(o.maxBudgetUsd)));
  if (Array.isArray(o.extraArgs)) {
    for (const a of o.extraArgs) {
      if (a == null || a === '') continue;
      // Arguments go through argv, never a shell; a newline would break Windows .cmd quoting.
      args.push(String(a).replace(/[\r\n]+/g, ' '));
    }
  }
  const dirs = Array.isArray(o.addDirs) ? [...new Set(o.addDirs.filter(Boolean).map(String))] : [];
  if (dirs.length) {
    args.push('--add-dir');
    for (const d of dirs) args.push(d);
  }
  return args;
}

/**
 * Child environment: base minus stripEnv, plus the MCP timeouts (unless set) and extras.
 * @param {NodeJS.ProcessEnv} base
 * @param {{stripEnv?:string[], extra?:object}} [opts]
 * @returns {NodeJS.ProcessEnv}
 */
function buildEnv(base = process.env, { stripEnv = DEFAULT_STRIP_ENV, extra, nodeDir = path.dirname(process.execPath), platform = process.platform } = {}) {
  const env = { ...base };
  const strip = new Set((stripEnv || []).map((k) => String(k).toUpperCase()));
  for (const k of Object.keys(env)) {
    if (strip.has(k.toUpperCase())) delete env[k];
  }
  // npm installs claude as a `#!/usr/bin/env node` script: make sure the node running us is
  // on PATH (a daemon started by a launcher or hotkey may have a minimal PATH).
  if (platform !== 'win32' && nodeDir && path.posix.isAbsolute(nodeDir)) {
    const norm = (p) => p.replace(/\/+$/, '') || '/';
    const parts = String(env.PATH || '').split(':').filter(Boolean);
    if (!parts.some((p) => norm(p) === norm(nodeDir))) env.PATH = [nodeDir, ...parts].join(':');
  }
  // Approvals and ask_user block inside MCP calls, so an inherited short
  // timeout (some shells set 60 s) or auto-backgrounding would break them.
  const inherited = Number(env.MCP_TOOL_TIMEOUT);
  if (!Number.isFinite(inherited) || inherited < 3600000) env.MCP_TOOL_TIMEOUT = '3600000';
  env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '0';
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v == null) delete env[k];
      else env[k] = String(v);
    }
  }
  return env;
}

/**
 * Splits a byte stream into lines, decoding UTF-8 across chunk boundaries.
 */
class LineSplitter {
  constructor(onLine, { maxBytes = MAX_LINE_BYTES, onOverflow } = {}) {
    this.onLine = onLine;
    this.decoder = new StringDecoder('utf8');
    this.buf = '';
    this.maxBytes = maxBytes;
    this.onOverflow = onOverflow;
  }

  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      this.onLine(line);
    }
    if (this.buf.length > this.maxBytes) {
      if (this.onOverflow) this.onOverflow(this.buf.length);
      this.buf = '';
    }
  }

  end() {
    this.buf += this.decoder.end();
    if (this.buf) {
      const line = this.buf.replace(/\r$/, '');
      this.buf = '';
      this.onLine(line);
    }
  }
}

/**
 * pid → {ppid, pgid} for every process (POSIX): /proc on Linux, else `ps`.
 * @returns {Map<number,{ppid:number,pgid:number}>|null} null when the table cannot be read
 */
function processTable(platform = process.platform) {
  const table = new Map();
  if (platform === 'linux') {
    try {
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
          // "pid (comm) state ppid pgrp …": comm may contain spaces and parentheses.
          const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
          const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          table.set(Number(name), { ppid: Number(rest[1]), pgid: Number(rest[2]) });
        } catch {
          /* exited meanwhile */
        }
      }
      if (table.size) return table;
    } catch {
      /* no /proc: ps below */
    }
  }
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      if (pid > 0) table.set(pid, { ppid, pgid });
    }
  } catch {
    return null;
  }
  return table.size ? table : null;
}

/**
 * The processes of the commands a CLI runs (POSIX). Claude Code starts each Bash tool command
 * and background task in a session of its own, so signalling the CLI (or its process group)
 * never reaches them, and once the CLI is dead they are reparented and cannot be found. Its
 * other children share its process group (MCP servers): they exit on stdin EOF, and what they
 * launched on purpose (an app opened with the open tool) must outlive the engine, so their
 * trees are left alone.
 * @param {number} rootPid
 * @param {Map<number,{ppid:number,pgid:number}>} table see processTable()
 * @returns {{pids:number[], groups:number[]}} the command processes, and the process groups they lead
 */
function commandTree(rootPid, table) {
  const children = new Map();
  for (const [pid, p] of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(pid);
  }
  const root = table.get(rootPid);
  const own = table.get(process.pid);
  const seen = new Set();
  const groups = new Set();
  const stack = (children.get(rootPid) || []).filter((pid) => !root || table.get(pid).pgid !== root.pgid);
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid) || pid === process.pid) continue;
    seen.add(pid);
    const p = table.get(pid);
    if (p && p.pgid === pid && (!own || own.pgid !== pid)) groups.add(pid);
    stack.push(...(children.get(pid) || []));
  }
  return { pids: [...seen], groups: [...groups] };
}

function killTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // cmd.exe shims: killing the shell would orphan node; taskkill /T takes the tree.
    try {
      const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  // Collected before the CLI dies: afterwards its commands are orphans nobody stops.
  const table = child.pid ? processTable() : null;
  const tree = table ? commandTree(child.pid, table) : { pids: [], groups: [] };
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
  for (const target of [...tree.groups.map((g) => -g), ...tree.pids]) {
    try {
      process.kill(target, signal);
    } catch {
      /* already gone */
    }
  }
}

class ClaudeCliEngine extends EventEmitter {
  /**
   * Find the claude CLI and read its version.
   * Order: config.engine.claudePath, env ANYWHERE_CLAUDE_PATH, PATH, known install paths.
   * @param {object} [config]
   * @returns {Promise<{path:string, version:string|null}|null>}
   */
  static async locate(config, { nodeDir = path.dirname(process.execPath) } = {}) {
    const candidates = [];
    const configured = config && config.engine && config.engine.claudePath;
    if (configured) candidates.push({ p: configured, why: 'engine.claudePath' });
    if (process.env.ANYWHERE_CLAUDE_PATH) candidates.push({ p: process.env.ANYWHERE_CLAUDE_PATH, why: 'ANYWHERE_CLAUDE_PATH' });
    const explicit = candidates.length;
    const onPath = proc.which('claude');
    // On WSL a Windows npm shim under /mnt/<drive> can shadow the Linux install; try native paths first.
    const windowsShim = Boolean(onPath) && process.platform === 'linux' && /^\/mnt\/[a-z]\//i.test(onPath);
    if (onPath && !windowsShim) candidates.push({ p: onPath, why: 'PATH' });
    // npm's global bin next to the node running us (a daemon started by a launcher may lack it on PATH).
    if (nodeDir) candidates.push({ p: path.join(nodeDir, process.platform === 'win32' ? 'claude.cmd' : 'claude'), why: 'node dir' });
    for (const p of knownInstallPaths()) candidates.push({ p, why: 'known path' });
    if (windowsShim) candidates.push({ p: onPath, why: 'PATH' });
    const seen = new Set();
    let fallback = null;
    for (let i = 0; i < candidates.length; i += 1) {
      const { p, why } = candidates[i];
      const abs = path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
      if (seen.has(abs)) continue;
      seen.add(abs);
      if (!isUsableFile(abs)) {
        if (why !== 'known path' && why !== 'node dir') log.warn(`claude CLI from ${why} is not usable: ${abs}`);
        continue;
      }
      const version = await ClaudeCliEngine.readVersion(abs);
      // A configured path is the user's choice; discovered ones must answer --version (a broken
      // shim earlier on PATH must not hide a working install), else the first usable file wins.
      if (i < explicit || version) return { path: abs, version };
      if (!fallback) fallback = { path: abs, version };
    }
    return fallback;
  }

  /**
   * `claude --version` with a 5 s timeout.
   * @param {string} cliPath
   * @returns {Promise<string|null>}
   */
  static async readVersion(cliPath) {
    const spec = launchSpec(cliPath, ['--version']);
    const env = buildEnv(process.env);
    const res = await proc.run(spec.command, spec.args, { timeoutMs: 5000, shell: spec.shell, env });
    if (res.error || res.timedOut || res.code !== 0) {
      log.warn(`could not read the claude CLI version from ${cliPath}: ${res.error ? res.error.message : res.timedOut ? 'timed out' : (res.stderr || `exit ${res.code}`).trim()}`);
      return null;
    }
    return parseVersion(res.stdout);
  }

  /**
   * @param {{claudePath:string, cwd?:string, sessionId?:string, resume?:boolean, mcpConfigPath?:string,
   *   systemPromptPath?:string, allowedTools?:string[], disallowedTools?:string[], model?:string,
   *   fallbackModel?:string, effort?:string, chrome?:boolean, addDirs?:string[], maxBudgetUsd?:number, extraArgs?:string[], env?:object,
   *   stripEnv?:string[], baseEnv?:object, permissionMode?:string, settingsPath?:string, platform?:string}} opts
   */
  constructor(opts = {}) {
    super();
    if (!opts.claudePath) throw new TypeError('ClaudeCliEngine needs claudePath');
    this.opts = { ...opts };
    this.claudePath = opts.claudePath;
    this.cwd = opts.cwd || process.cwd();
    this.sessionId = opts.sessionId || uuid();
    this.resume = Boolean(opts.resume);
    this.args = buildArgs({ ...opts, sessionId: this.sessionId, resume: this.resume });
    this.env = buildEnv(opts.baseEnv || process.env, { stripEnv: opts.stripEnv || DEFAULT_STRIP_ENV, extra: opts.env });
    this.child = null;
    this.exited = false;
    this.exitInfo = null;
    this.expectedExit = false;
    this.sawInit = false;
    this.startedAt = 0;
    this.stderrLines = [];
    this.resultWaiters = new Set();
    this.platform = opts.platform || process.platform;
    this.sendCount = 0;
    this.turnActive = false; // a user message is being worked on (send/init → true, result → false)
  }

  /** @returns {boolean} the process is alive */
  get running() {
    return Boolean(this.child) && !this.exited;
  }

  /** @returns {number|null} */
  get pid() {
    return this.child ? this.child.pid : null;
  }

  /** @returns {string} last stderr lines */
  stderrTail() {
    return this.stderrLines.join('\n');
  }

  /** Spawn the CLI. Emits 'spawn', or 'exit' with .error when spawning fails. */
  start() {
    if (this.child) throw new Error('engine already started');
    const spec = launchSpec(this.claudePath, this.args, this.platform);
    this.startedAt = Date.now();
    if (spec.shell && isUncPath(this.cwd)) {
      // cmd.exe would say "UNC paths are not supported" and run Claude Code in C:\Windows instead.
      const e = new Error(`${path.basename(this.claudePath)} has to run through cmd.exe, which cannot use the network or WSL folder ${this.cwd} as its working directory. Set engine.claudePath in Settings to Claude Code's cli.js or claude.exe, or pick a project on a local drive.`);
      e.code = 'UNC_CWD';
      log.error(e.message);
      this.child = { pid: null };
      process.nextTick(() => this.finish({ code: null, signal: null, error: e }));
      return;
    }
    log.info(`starting claude: ${this.claudePath} ${this.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')} (cwd ${this.cwd})`);
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: this.cwd,
        env: this.env,
        shell: spec.shell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.child = { pid: null };
      process.nextTick(() => this.finish({ code: null, signal: null, error: err }));
      return;
    }
    this.child = child;
    const out = new LineSplitter((line) => this.onStdoutLine(line), {
      onOverflow: (n) => log.warn(`dropping an unterminated stdout line of ${n} chars`),
    });
    const err = new LineSplitter((line) => this.onStderrLine(line), { maxBytes: 1024 * 1024 });
    child.stdout.on('data', (d) => out.push(d));
    child.stdout.on('end', () => out.end());
    child.stderr.on('data', (d) => err.push(d));
    child.stderr.on('end', () => err.end());
    child.stdin.on('error', (e) => log.debug(`stdin error: ${e.message}`));
    child.on('error', (e) => {
      log.error(`claude process error: ${e.message}`);
      // A spawn failure (ENOENT/EACCES) emits no 'close' on some platforms.
      if (!child.pid) this.finish({ code: null, signal: null, error: e });
      else this.spawnError = e;
    });
    child.on('close', (code, signal) => this.finish({ code, signal, error: this.spawnError || null }));
    if (child.pid) {
      this.emit('spawn', { pid: child.pid });
    }
  }

  /** @private */
  onStdoutLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed[0] !== '{') {
      log.debug(`ignoring non-JSON stdout line: ${trimmed.slice(0, 200)}`);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      log.warn(`ignoring unparseable stdout line (${e.message}): ${trimmed.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.sawInit = true;
      // The CLI emits init as a turn starts (a queued message starting its own turn included).
      if (this.sendCount > 0) this.turnActive = true;
    }
    if (msg.type === 'result') this.turnActive = false;
    try {
      this.emit('message', msg);
    } catch (e) {
      log.error('message listener threw:', e);
    }
    if (msg.type === 'result') {
      for (const w of [...this.resultWaiters]) w(msg);
    }
  }

  /** @private */
  onStderrLine(line) {
    if (!line) return;
    this.stderrLines.push(line);
    if (this.stderrLines.length > STDERR_TAIL_LINES) this.stderrLines.shift();
    log.debug(`claude stderr: ${line}`);
    try {
      this.emit('stderr', line);
    } catch (e) {
      log.error('stderr listener threw:', e);
    }
  }

  /** @private */
  finish({ code, signal, error }) {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.killTimer);
    clearTimeout(this.termTimer);
    this.exitInfo = {
      code: code == null ? null : code,
      signal: signal || null,
      stderrTail: this.stderrTail(),
      error: error ? error.message : null,
      errorCode: error ? error.code || null : null,
      expected: this.expectedExit,
      sawInit: this.sawInit,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
    for (const w of [...this.resultWaiters]) w(null);
    log.info(`claude exited (code ${this.exitInfo.code}, signal ${this.exitInfo.signal}${error ? `, ${error.message}` : ''})`);
    this.emit('exit', this.exitInfo);
  }

  /** @private */
  writeLine(obj) {
    if (!this.running || !this.child.stdin || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      const e = new Error('Claude Code is not running');
      e.code = 'ENGINE_NOT_RUNNING';
      throw e;
    }
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /**
   * Send a user turn.
   * @param {object[]|string} contentBlocks Anthropic content blocks (or plain text)
   */
  send(contentBlocks) {
    const content = typeof contentBlocks === 'string' ? [{ type: 'text', text: contentBlocks }] : contentBlocks;
    if (!Array.isArray(content) || !content.length) throw new TypeError('send() needs content blocks');
    this.writeLine({ type: 'user', message: { role: 'user', content } });
    this.sendCount += 1;
    this.turnActive = true;
  }

  /**
   * Interrupt the current turn. Resolves when its result arrives; when no turn
   * is running, when the CLI acknowledges the request (an idle CLI answers only
   * with a control_response). A running turn that produces no result within 4 s
   * gets the process killed.
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{ok:boolean, killed:boolean}>}
   */
  interrupt({ timeoutMs = INTERRUPT_TIMEOUT_MS } = {}) {
    if (!this.running) return Promise.resolve({ ok: true, killed: false });
    return new Promise((resolve) => {
      const requestId = uuid();
      let done = false;
      let killing = false;
      let hardKill = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(hardKill);
        this.resultWaiters.delete(onResult);
        this.removeListener('exit', onExit);
        this.removeListener('message', onMessage);
        resolve({ ok: true, killed: killing });
      };
      // A result (or the process exiting, which also wakes result waiters) ends the wait.
      const onResult = () => finish();
      const onExit = () => finish();
      const onMessage = (msg) => {
        if (!msg || msg.type !== 'control_response') return;
        const r = msg.response || {};
        if (r.request_id === requestId && !this.turnActive) finish();
      };
      const timer = setTimeout(() => {
        if (!this.turnActive) {
          log.warn(`no answer ${timeoutMs} ms after interrupt, but no turn is running; leaving claude alone`);
          finish();
          return;
        }
        log.warn(`no result ${timeoutMs} ms after interrupt; killing claude`);
        killing = true;
        this.expectedExit = true;
        // SIGTERM lets the CLI end the commands it runs; whatever is left then gets SIGKILL.
        killTree(this.child, 'SIGTERM');
        hardKill = setTimeout(() => killTree(this.child, 'SIGKILL'), INTERRUPT_KILL_AFTER_MS);
        // Safety net when the OS never reports the exit.
        setTimeout(finish, INTERRUPT_KILL_AFTER_MS + 2000).unref();
      }, timeoutMs);
      this.resultWaiters.add(onResult);
      this.once('exit', onExit);
      this.on('message', onMessage);
      try {
        this.writeLine({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
      } catch (e) {
        log.warn(`interrupt could not be sent: ${e.message}`);
        finish();
      }
    });
  }

  /**
   * Stop the process: close stdin, SIGTERM, then SIGKILL after 3 s.
   * @returns {Promise<void>}
   */
  stop() {
    if (!this.child || this.exited) return Promise.resolve();
    this.expectedExit = true;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(hard);
        resolve();
      };
      this.once('exit', done);
      try {
        if (this.child.stdin && !this.child.stdin.destroyed) this.child.stdin.end();
      } catch {
        /* ignore */
      }
      if (process.platform === 'win32') {
        // taskkill is forceful, so give the CLI a moment to exit on stdin EOF first.
        this.termTimer = setTimeout(() => killTree(this.child, 'SIGTERM'), 1500);
      } else {
        killTree(this.child, 'SIGTERM');
      }
      this.killTimer = setTimeout(() => killTree(this.child, 'SIGKILL'), STOP_KILL_AFTER_MS);
      const hard = setTimeout(() => {
        this.removeListener('exit', done);
        this.finish({ code: null, signal: 'SIGKILL', error: null });
        resolve();
      }, STOP_KILL_AFTER_MS + 2000);
    });
  }
}

module.exports = {
  ClaudeCliEngine,
  buildArgs,
  buildEnv,
  launchSpec,
  resolveCmdShim,
  isUncPath,
  parseVersion,
  knownInstallPaths,
  LineSplitter,
  processTable,
  commandTree,
  PERMISSION_TOOL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_STRIP_ENV,
};
