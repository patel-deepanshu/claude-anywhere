#!/usr/bin/env node
'use strict';

/**
 * Claude Anywhere command-line interface (`anywhere`).
 *
 * Starts and stops the background daemon, talks to it over its local HTTP API
 * (send, listen/reply for bridge mode, ask, notify), drives the desktop
 * directly (`anywhere computer ...`), diagnoses the machine (`doctor`) and
 * installs the skill, MCP server and OS shortcut.
 *
 * This file avoids syntax newer than Node 10 (no `??`, `?.`, class fields) so
 * that an outdated Node reaches the version check and prints upgrade
 * instructions instead of a SyntaxError. Package modules load lazily after it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const BIN_PATH = __filename;
const MIN_NODE = [18, 17, 0];

/** Exit codes (also documented in `anywhere help`). */
const EXIT = Object.freeze({ OK: 0, ERROR: 1, TIMEOUT: 2, STOP: 3, NOT_RUNNING: 4, STOPPED: 5, INTERRUPTED: 130 });

const LISTEN_DEFAULT_SEC = 540;
const LISTEN_MAX_SEC = 590;
const ASK_DEFAULT_SEC = 540;
const START_TIMEOUT_MS = 15000;
const HOST_WAIT_MS = 20000;
const KEEP_ALIVE = Symbol('keep-alive');
const REPO_URL = 'https://github.com/patel-deepanshu/claude-anywhere';

// ------------------------------------------------------------------ errors

class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   * @param {string} [hint]
   */
  constructor(message, exitCode, hint) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode == null ? EXIT.ERROR : exitCode;
    if (hint) this.hint = hint;
  }
}

function usageError(message, command) {
  const err = new CliError(message, EXIT.ERROR, `Run ${cliQ(`help${command ? ` ${command}` : ''}`)} for usage.`);
  err.usage = true;
  return err;
}

function notRunningError(extra, hint) {
  return new CliError(
    `Claude Anywhere is not running.${extra ? ` ${extra}` : ''}`,
    EXIT.NOT_RUNNING,
    hint === undefined ? `Start it with /anywhere in Claude Code, or run: ${cliCmd('start')}` : hint
  );
}

let cliCommandCache = null;

/**
 * How the user runs this CLI in a terminal of their own: "anywhere" when that command on PATH is
 * this package, else `node "<package>/bin/anywhere.js"`. Plugin and clone installs usually have no
 * `anywhere` on the user's PATH: Claude Code adds a plugin's bin/ to its own Bash tool only.
 * @returns {string}
 */
function cliCommand() {
  if (cliCommandCache) return cliCommandCache;
  let cmd = null;
  try {
    const found = shared('proc').which('anywhere');
    if (found) {
      const binDir = path.dirname(BIN_PATH);
      // Found through a link in another folder (~/.local/bin), or the package's bin/ is on PATH
      // itself (install.ps1 adds it) while not a plugin, whose bin/ only Claude Code's Bash sees.
      const viaLink = !samePath(path.dirname(found), binDir);
      const plugins = realPathOr(path.join(shared('paths').claudeHome(), 'plugins'));
      const isPlugin = realPathOr(PACKAGE_ROOT).indexOf(plugins + path.sep) === 0;
      if (samePath(path.dirname(realPathOr(found)), binDir) && (viaLink || !isPlugin)) cmd = 'anywhere';
      // A plugin install links the stable launcher (<state>/launcher), which runs the installed version.
      if (isPlugin && samePath(realPathOr(found), realPathOr(path.join(shared('paths').stateDir(), 'launcher', 'anywhere')))) cmd = 'anywhere';
    }
  } catch (_) {
    cmd = null;
  }
  cliCommandCache = cmd || `node "${BIN_PATH}"`;
  return cliCommandCache;
}

/** `anywhere <sub>` as the user can type it (see cliCommand). */
function cliCmd(sub) {
  return sub ? `${cliCommand()} ${sub}` : cliCommand();
}

/** cliCmd() set off for prose: "anywhere sub" in quotes, the node form (already quoted) as is. */
function cliQ(sub) {
  const c = cliCmd(sub);
  return c.indexOf('"') >= 0 ? c : `"${c}"`;
}

// ------------------------------------------------------------------ node version

function versionTuple(v) {
  return String(v || '0.0.0')
    .replace(/^v/, '')
    .split('.')
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);
}

/**
 * @param {number[]} min
 * @param {string} [current] defaults to process.versions.node
 */
function nodeAtLeast(min, current) {
  const cur = versionTuple(current || process.versions.node);
  for (let i = 0; i < 3; i += 1) {
    const want = min[i] || 0;
    if (cur[i] > want) return true;
    if (cur[i] < want) return false;
  }
  return true;
}

function nodeUpgradeHint(platform) {
  if (platform === 'darwin') return 'brew install node   (or the LTS installer from https://nodejs.org)';
  if (platform === 'win32') return 'winget install OpenJS.NodeJS.LTS   (or the LTS installer from https://nodejs.org)';
  return 'Install the current LTS with your package manager, or with nvm: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install --lts';
}

// ------------------------------------------------------------------ lazy package modules

function pkgPath(rel) {
  return path.join(PACKAGE_ROOT, rel);
}

function shared(name) {
  return require(pkgPath(path.join('src', 'shared', name)));
}

/** Require a package module, or null when the file does not exist. Load errors propagate. */
function optionalPkg(rel) {
  let resolved;
  try {
    resolved = require.resolve(pkgPath(rel));
  } catch (_) {
    return null;
  }
  return require(resolved);
}

function requirePkg(rel, what) {
  const mod = optionalPkg(rel);
  if (!mod) {
    throw new CliError(
      `${what} is missing from this installation (${rel}).`,
      EXIT.ERROR,
      `Update or reinstall Claude Anywhere (${REPO_URL}), then run: ${cliCmd('doctor')}`
    );
  }
  return mod;
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(pkgPath('package.json'), 'utf8')).version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

// ------------------------------------------------------------------ output

/**
 * Symbols (✓ · …) or ASCII: the same locale-aware rule as the terminal dialog (src/shared/util.js
 * unicodeSupported): ASCII under TERM=dumb or linux, a non-UTF-8 or unset locale (Linux and other
 * Unixes; macOS terminals are UTF-8) and Windows consoles not known to draw them.
 * ANYWHERE_UNICODE=1 / ANYWHERE_ASCII=1 force either.
 */
function useUnicode() {
  return shared('util').unicodeSupported(process.env, process.platform);
}

function useColor(stream) {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stream && stream.isTTY) && process.env.TERM !== 'dumb';
}

function sym() {
  return useUnicode()
    ? { ok: '✓', warn: '!', fail: '✗', star: '✳', dot: '·', ell: '…', arrow: '→' }
    : { ok: 'OK', warn: '!', fail: 'X', star: '*', dot: '-', ell: '...', arrow: '->' };
}

function paint(code, s, stream) {
  return useColor(stream || process.stdout) ? `\u001b[${code}m${s}\u001b[0m` : s;
}
const color = {
  green: (s, st) => paint('32', s, st),
  yellow: (s, st) => paint('33', s, st),
  red: (s, st) => paint('31', s, st),
  dim: (s, st) => paint('2', s, st),
  bold: (s, st) => paint('1', s, st),
  cyan: (s, st) => paint('36', s, st),
};

function writeOut(text) {
  const s = String(text);
  process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
}

function writeErr(text) {
  const s = String(text);
  process.stderr.write(s.endsWith('\n') ? s : `${s}\n`);
}

function printJson(obj) {
  writeOut(JSON.stringify(obj, null, 2));
}

/** Resolve once stdout and stderr have handed everything to the OS (pipes can be async). */
function flushStreams() {
  const one = (stream) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      try {
        stream.write('', () => {
          clearTimeout(t);
          resolve();
        });
      } catch (_) {
        clearTimeout(t);
        resolve();
      }
    });
  return Promise.all([one(process.stdout), one(process.stderr)]);
}

// ------------------------------------------------------------------ argument parsing

function parseBool(v) {
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].indexOf(s) >= 0) return true;
  if (['0', 'false', 'no', 'off', 'n'].indexOf(s) >= 0) return false;
  return null;
}

/**
 * Hand-written argument parser.
 *
 * - `--name value` and `--name=value` for string flags (`multi` flags collect an array)
 * - `--flag`, `--flag=false` and `--no-flag` for booleans
 * - `pair` flags take two values (`--at X Y` or `--at X,Y`)
 * - short aliases: `-n 5`, `-n5`, `-h`
 * - `--` ends option parsing; the remaining words go to `rest`
 * - negative numbers (`-10`) and a lone `-` are positionals
 *
 * @param {string[]} argv
 * @param {{string?:string[], boolean?:string[], multi?:string[], pair?:string[], alias?:Object<string,string>}} [spec]
 * @returns {{_:string[], flags:Object<string,any>, unknown:string[], rest:string[]}}
 */
function parseArgs(argv, spec) {
  const sp = spec || {};
  const strings = new Set(sp.string || []);
  const booleans = new Set(sp.boolean || []);
  const multi = new Set(sp.multi || []);
  const pairs = new Set(sp.pair || []);
  const alias = sp.alias || {};
  const known = (n) => strings.has(n) || booleans.has(n) || multi.has(n) || pairs.has(n);
  const out = { _: [], flags: {}, unknown: [], rest: [] };
  const list = Array.isArray(argv) ? argv.map(String) : [];

  const takeValue = (i, name) => {
    const next = list[i + 1];
    if (next === undefined) throw usageError(`--${name} needs a value`);
    if (/^--[^-]/.test(next)) {
      const bare = next.slice(2).split('=')[0];
      const base = bare.indexOf('no-') === 0 ? bare.slice(3) : bare;
      if (known(alias[bare] || bare) || known(alias[base] || base)) throw usageError(`--${name} needs a value`);
    }
    return next;
  };
  const setValue = (name, value) => {
    if (multi.has(name)) {
      if (!Array.isArray(out.flags[name])) out.flags[name] = [];
      out.flags[name].push(value);
    } else {
      out.flags[name] = value;
    }
  };

  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--') {
      out.rest = list.slice(i + 1);
      break;
    }
    if (a.length > 2 && a.indexOf('--') === 0) {
      let name = a.slice(2);
      let inline = null;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        inline = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      name = alias[name] || name;
      if (booleans.has(name)) {
        if (inline == null) out.flags[name] = true;
        else {
          const b = parseBool(inline);
          if (b == null) throw usageError(`--${name} expects true or false (got "${inline}")`);
          out.flags[name] = b;
        }
        continue;
      }
      if (name.indexOf('no-') === 0 && inline == null) {
        const base = alias[name.slice(3)] || name.slice(3);
        if (booleans.has(base)) {
          out.flags[base] = false;
          continue;
        }
      }
      if (strings.has(name) || multi.has(name)) {
        if (inline != null) setValue(name, inline);
        else {
          setValue(name, takeValue(i, name));
          i += 1;
        }
        continue;
      }
      if (pairs.has(name)) {
        let pair;
        if (inline != null) pair = inline.split(',');
        else if (list[i + 1] !== undefined && list[i + 1].indexOf(',') > 0) {
          pair = list[i + 1].split(',');
          i += 1;
        } else {
          if (list[i + 1] === undefined || list[i + 2] === undefined) throw usageError(`--${name} needs two values, e.g. --${name} 100 200`);
          pair = [list[i + 1], list[i + 2]];
          i += 2;
        }
        if (pair.length !== 2) throw usageError(`--${name} needs two values, e.g. --${name} 100 200`);
        out.flags[name] = pair.map((s) => s.trim());
        continue;
      }
      out.unknown.push(a);
      continue;
    }
    if (a.length >= 2 && a[0] === '-' && /[A-Za-z]/.test(a[1])) {
      const name = alias[a[1]];
      if (!name) {
        out.unknown.push(a);
        continue;
      }
      const attached = a.slice(2);
      if (booleans.has(name)) {
        if (attached) {
          out.unknown.push(a);
          continue;
        }
        out.flags[name] = true;
      } else if (attached) {
        setValue(name, attached.replace(/^=/, ''));
      } else {
        setValue(name, takeValue(i, name));
        i += 1;
      }
      continue;
    }
    out._.push(a);
  }
  return out;
}

/** Edit distance with adjacent transpositions (optimal string alignment). */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const d = [];
  for (let i = 0; i <= m; i += 1) d.push([i]);
  for (let j = 1; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/**
 * The known command closest to `word`, or null. Counts as close: edit distance 1,
 * distance 2 with the same first letter (4+ letters), or a 3+ letter prefix.
 * @param {string} word
 */
function closestCommand(word) {
  const w = String(word || '').toLowerCase();
  if (w.length < 3) return null;
  let best = null;
  let bestD = Infinity;
  for (const name of Object.keys(COMMANDS)) {
    if (name === 'daemon') continue;
    let dist = levenshtein(w, name);
    if (name.indexOf(w) === 0) dist = Math.min(dist, 1);
    const close = dist <= 1 || (dist === 2 && w.length >= 4 && w[0] === name[0]);
    if (close && dist < bestD) {
      best = name;
      bestD = dist;
    }
  }
  return best;
}

/**
 * Is a non-command first word probably a mistyped command (→ help + exit 1)
 * rather than the start of a task for `send`?
 * @param {string[]} argv
 */
function looksLikeTypo(argv) {
  if (argv.length !== 1) return null;
  const w = argv[0];
  if (!/^[a-z][a-z-]*$/.test(w)) return null;
  return closestCommand(w);
}

// ------------------------------------------------------------------ small helpers

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        return v;
      },
      (err) => {
        clearTimeout(timer);
        throw err;
      }
    ),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`${label || 'operation'} timed out after ${Math.round(ms / 100) / 10} s`);
        e.code = 'ETIMEDOUT';
        reject(e);
      }, ms);
      if (timer.unref) timer.unref();
    }),
  ]);
}

function expandHome(p) {
  return String(p).replace(/^~(?=$|[\\/])/, os.homedir());
}

/** The real path (symlinks resolved), or the resolved path when it does not exist. */
function realPathOr(p) {
  const abs = path.resolve(String(p));
  try {
    return fs.realpathSync.native(abs);
  } catch (_) {
    return abs;
  }
}

/** Same folder? Symlinked paths to one folder count as the same. */
function samePath(a, b) {
  if (!a || !b) return false;
  const x = realPathOr(a);
  const y = realPathOr(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (_) {
    return 0;
  }
}

/** Read a file from byte `offset` to its end (at most 4 MB). */
function readFrom(file, offset) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return '';
    const start = Math.max(offset, size - 4 * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/** Last `n` lines of a file (reads at most the final 1 MB). */
function tailFile(file, n) {
  const size = fileSize(file);
  const text = readFrom(file, Math.max(0, size - 1024 * 1024));
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-Math.max(1, n));
}

/**
 * Mask the access token in dialog URLs. A daemon that cannot open a window prints its token URL
 * to stderr, which is the daemon log; `logs` output often lands in Claude's transcript.
 */
function hideTokens(text) {
  return String(text == null ? '' : text).replace(/([?&]token=)[^&#\s"'<>]+/g, '$1***');
}

function lastLines(text, n) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n');
}

function isConnectionError(err) {
  if (!err) return false;
  const code = (err.cause && err.cause.code) || err.code;
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'].indexOf(code) >= 0) return true;
  return /fetch failed|socket hang up|other side closed/i.test(String(err.message || ''));
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Electron accelerator → what to press on this OS. */
function hotkeyLabel(accel, platform) {
  const plat = platform || process.platform;
  return String(accel || '')
    .split('+')
    .map((k) => {
      const t = k.trim();
      if (/^(CommandOrControl|CmdOrCtrl)$/i.test(t)) return plat === 'darwin' ? 'Cmd' : 'Ctrl';
      if (/^(Command|Cmd)$/i.test(t)) return 'Cmd';
      if (/^(Control|Ctrl)$/i.test(t)) return 'Ctrl';
      if (/^(Alt|Option)$/i.test(t)) return plat === 'darwin' ? 'Option' : 'Alt';
      if (/^(Super|Meta)$/i.test(t)) return plat === 'darwin' ? 'Cmd' : plat === 'win32' ? 'Win' : 'Super';
      return t;
    })
    .join('+');
}

function hostLabel(host) {
  switch (host) {
    case 'electron':
      return 'Electron window';
    case 'app':
      return 'app window';
    case 'browser':
      return 'browser tab';
    case 'none':
      return 'no window';
    default:
      return 'opening';
  }
}

function readInstallInfo() {
  try {
    const parsed = JSON.parse(fs.readFileSync(shared('paths').installInfoPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Most recently used project from sessions.json that still exists, else the cwd. */
function lastProject() {
  try {
    const data = JSON.parse(fs.readFileSync(shared('paths').sessionsPath(), 'utf8'));
    const entries = Object.keys(data || {})
      .map((dir) => ({ dir, at: String((data[dir] && data[dir].updatedAt) || '') }))
      .filter((e) => isDir(e.dir))
      .sort((a, b) => b.at.localeCompare(a.at));
    if (entries.length) return entries[0].dir;
  } catch (_) {
    /* no history */
  }
  return process.cwd();
}

function resolveProject(dir) {
  const p = path.resolve(expandHome(dir || process.cwd()));
  if (!isDir(p)) throw new CliError(`Project directory not found: ${p}`, EXIT.ERROR, 'Pass an existing folder with --project DIR.');
  return p;
}

function validateMode(mode) {
  if (mode == null) return undefined;
  const m = String(mode).trim().toLowerCase();
  if (m !== 'companion' && m !== 'bridge') throw usageError(`--mode must be companion or bridge (got "${mode}")`, 'start');
  return m;
}

const UI_HOSTS = ['auto', 'electron', 'app', 'browser', 'tui', 'none'];
function validateUi(ui) {
  if (ui == null) return undefined;
  const h = String(ui).trim().toLowerCase();
  if (UI_HOSTS.indexOf(h) < 0) throw usageError(`--ui must be one of ${UI_HOSTS.join(', ')} (got "${ui}")`, 'start');
  return h;
}

function toInt(v, name, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw usageError(`${name} must be a whole number from ${min} to ${max} (got "${v}")`);
  return n;
}

function toNum(v, name) {
  const n = Number(v);
  if (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(n)) throw usageError(`${name} must be a number (got "${v === undefined ? '' : v}")`);
  return n;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** Text from positionals (joined by spaces) plus `--` rest, or stdin with --stdin / a lone "-". */
async function gatherText(p, { from = 0 } = {}) {
  const words = p._.slice(from).concat(p.rest || []);
  if (p.flags.stdin || (words.length === 1 && words[0] === '-')) {
    return (await readStdin()).replace(/\r?\n$/, '');
  }
  return words.join(' ');
}

// ------------------------------------------------------------------ daemon access

/**
 * The running daemon: env ANYWHERE_DAEMON_URL + ANYWHERE_TOKEN first, else daemon.json + /api/health.
 * @returns {Promise<{client:object, state:object}|null>}
 */
async function getDaemon() {
  const { DaemonClient } = shared('client');
  if (process.env.ANYWHERE_DAEMON_URL && process.env.ANYWHERE_TOKEN) {
    const baseUrl = process.env.ANYWHERE_DAEMON_URL.replace(/\/+$/, '');
    let port = null;
    try {
      port = Number(new URL(baseUrl).port) || null;
    } catch (_) {
      port = null;
    }
    const token = process.env.ANYWHERE_TOKEN;
    return {
      client: new DaemonClient({ baseUrl, token }),
      state: { url: `${baseUrl}/?token=${encodeURIComponent(token)}`, port, pid: null, fromEnv: true },
    };
  }
  const st = await shared('state').findRunningDaemon();
  if (!st) return null;
  // fromState: watchers and long polls follow daemon.json to a restarted daemon.
  return { client: new DaemonClient({ baseUrl: `http://127.0.0.1:${st.port}`, token: st.token, fromState: true }), state: st };
}

async function requireDaemon(extra) {
  const d = await getDaemon();
  if (!d) throw notRunningError(extra);
  return d;
}

/** client.request with daemon-down and HTTP errors turned into CliErrors. */
async function call(client, method, urlPath, body, opts) {
  try {
    return await client.request(method, urlPath, body, opts || {});
  } catch (err) {
    if (isConnectionError(err)) throw notRunningError('(the daemon stopped responding)');
    if (err && err.status === 401) {
      throw new CliError('The daemon rejected the access token.', EXIT.ERROR, `Restart it: ${cliCmd('restart')}`);
    }
    if (err && err.status) {
      const hint = err.data && err.data.hint;
      const e = new CliError(`Claude Anywhere: ${err.message} (HTTP ${err.status})`, EXIT.ERROR, hint);
      e.status = err.status;
      e.serverMessage = err.message;
      // The server's error code (e.g. COMMAND_STOPPED) tells refusals with the same status apart.
      if (err.data && typeof err.data.code === 'string' && err.data.code) e.code = err.data.code;
      throw e;
    }
    throw err;
  }
}

/**
 * JSON request over node:http for long polls (listen, ask). Global fetch (undici)
 * aborts any response whose headers take longer than 300 s, which is shorter than
 * the 540 s listen window, so blocking calls must not use it.
 * @returns {Promise<object>} parsed JSON; throws Error with .status/.data on HTTP errors
 */
function longRequest(client, method, urlPath, body, timeoutMs) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(client.baseUrl + urlPath);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Authorization: `Bearer ${client.token}`, Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = http.request(
      { protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('error', (err) => finish(reject, err));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch (_) {
            data = { raw: text };
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error((data && data.error) || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.data = data;
            finish(reject, err);
            return;
          }
          finish(resolve, data);
        });
      }
    );
    const timer = setTimeout(() => {
      const err = new Error(`Request to ${urlPath} timed out after ${Math.round(timeoutMs / 1000)} s`);
      err.code = 'ETIMEDOUT';
      req.destroy();
      finish(reject, err);
    }, timeoutMs);
    req.on('error', (err) => finish(reject, err));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Like call(), for requests that may block for minutes. */
async function callLong(client, method, urlPath, body, timeoutMs) {
  if (!client || typeof client.baseUrl !== 'string' || client.baseUrl.indexOf('http:') !== 0) {
    return call(client, method, urlPath, body, { timeoutMs });
  }
  const proxy = {
    request: (m, p, b) => longRequest(client, m, p, b, timeoutMs),
  };
  return call(proxy, method, urlPath, body, { timeoutMs });
}

/** getDaemon(), looked up at most once (null when it fails). */
function daemonOnce() {
  let pending = null;
  return () => {
    if (!pending) pending = getDaemon().catch(() => null);
    return pending;
  };
}

/** Guard for CLI input actions: honours the dialog's pause (Stop button) when a daemon runs. */
function makeGuard(lookup) {
  const find = lookup || daemonOnce();
  return async () => {
    const d = await find();
    if (!d) return { allowed: true };
    try {
      const r = await d.client.request('GET', '/api/mcp/guard', undefined, { timeoutMs: 300 });
      return r && typeof r.allowed === 'boolean' ? r : { allowed: true };
    } catch (_) {
      return { allowed: true };
    }
  };
}

async function waitForDialogHost(logFile, offset, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = readFrom(logFile, offset);
    const m = text.match(/dialog opened with (electron|app|browser|none)\b/);
    if (m) return m[1];
    if (/Open this URL to use the dialog|opening the dialog failed|no dialog window could be opened/.test(text)) return 'none';
    await sleep(250);
  }
  return null;
}

/**
 * PATH for a daemon this CLI starts. OS launchers (the WSL hotkey's `wsl.exe -e`, the macOS applet,
 * .desktop entries) run without the login shell's PATH, so the daemon would miss an nvm/npm-installed
 * claude and `#!/usr/bin/env node` shims would fail. Puts node's own directory first when it is
 * missing (nvm, fnm and volta keep global npm binaries next to node), then appends the PATH recorded
 * by `anywhere install` and the usual per-user and Homebrew directories that exist.
 * @param {string} current
 * @param {{nodeDir?:string, recorded?:string, home?:string, platform?:string, isDir?:(p:string)=>boolean}} [opts]
 * @returns {string}
 */
function daemonPath(current, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return current;
  const P = path.posix;
  const dirOk = opts.isDir || isDir;
  const norm = (p) => p.replace(/\/+$/, '') || '/';
  const parts = String(current || '').split(':').filter(Boolean);
  const out = parts.length ? parts : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const have = new Set(out.map(norm));
  if (opts.nodeDir && P.isAbsolute(opts.nodeDir) && !have.has(norm(opts.nodeDir))) {
    out.unshift(opts.nodeDir);
    have.add(norm(opts.nodeDir));
  }
  const home = opts.home || os.homedir();
  const extra = String(opts.recorded || '')
    .split(':')
    .concat([P.join(home, '.local', 'bin')])
    .concat(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []);
  for (const dir of extra) {
    if (!dir || !P.isAbsolute(dir) || have.has(norm(dir)) || !dirOk(dir)) continue;
    out.push(dir);
    have.add(norm(dir));
  }
  return out.join(':');
}

/** Environment for a daemon spawned by this CLI. */
function daemonEnv(base) {
  const env = Object.assign({}, base || process.env, { ANYWHERE_LOG_FILE: '1' });
  delete env.ANYWHERE_DAEMON_URL;
  delete env.ANYWHERE_TOKEN;
  delete env.ANYWHERE_ROLE;
  // Set by round-1 daemons for their engine; never pass one on to a new daemon.
  delete env.ANYWHERE_ENGINE_CHILD;
  if (process.platform !== 'win32') {
    const install = readInstallInfo();
    env.PATH = daemonPath(env.PATH, { nodeDir: path.dirname(process.execPath), recorded: install && typeof install.envPath === 'string' ? install.envPath : '' });
  }
  return env;
}

// Statuses in which a project or mode switch would stop work in progress.
const BUSY_STATUSES = ['starting', 'thinking', 'acting', 'waiting_approval', 'waiting_answer', 'queued'];

/**
 * Bridge commands that only wait for a Claude Code terminal, from a GET /api/state snapshot:
 * status 'queued', no terminal listening, no approval or question open. Nothing runs for them
 * (no terminal will ever finish them), so they are not "a task is running". 0 otherwise.
 * @param {object|null} snap
 * @returns {number}
 */
function waitingForTerminal(snap) {
  if (!snap || typeof snap !== 'object' || snap.mode !== 'bridge' || snap.status !== 'queued') return 0;
  const bridge = snap.bridge || {};
  if (bridge.listening) return 0;
  const pend = snap.pending || {};
  if ((Array.isArray(pend.approvals) && pend.approvals.length) || (Array.isArray(pend.questions) && pend.questions.length)) return 0;
  return Math.max(1, Number(bridge.queued) || 0);
}

/** "a command" / "3 commands" */
function commandsWord(n) {
  return n === 1 ? 'a command' : `${n} commands`;
}

/**
 * What keeps the dialog busy, from a GET /api/state snapshot: '' when it is free (or unknown).
 * @param {object|null} snap
 * @returns {string}
 */
function busyReason(snap) {
  if (!snap || typeof snap !== 'object') return '';
  const pend = snap.pending || {};
  const na = Array.isArray(pend.approvals) ? pend.approvals.length : 0;
  const nq = Array.isArray(pend.questions) ? pend.questions.length : 0;
  if (na) return na === 1 ? 'an approval is waiting' : `${na} approvals are waiting`;
  if (nq) return nq === 1 ? 'a question is waiting for an answer' : `${nq} questions are waiting for answers`;
  const waiting = waitingForTerminal(snap);
  if (waiting) return `${commandsWord(waiting)} ${waiting === 1 ? 'waits' : 'wait'} for a Claude Code terminal, and none is listening`;
  if (BUSY_STATUSES.indexOf(snap.status) >= 0) return 'a task is running';
  return '';
}

/**
 * Reuse the running daemon (switching project and mode as asked) or spawn a
 * detached one and wait until it answers /api/health.
 *
 * A busy dialog (a task running, an approval or question waiting) keeps its project and mode
 * unless `force` (--switch) is set, because switching stops the running task. Without a requested
 * mode, a bridge-mode dialog that no Claude Code terminal listens to goes back to companion mode,
 * so the task runs in the dialog's own session instead of waiting for a terminal; when it stays in
 * bridge mode, a note starting "still in bridge mode" says why. Bridge commands that only wait for
 * a terminal do not block that switch on the CLI's side (see waitingForTerminal).
 * @param {{project:string, mode?:string, ui?:string, open?:boolean, timeoutMs?:number, waitHost?:boolean,
 *   force?:boolean, keepMode?:boolean}} opts
 * @returns {Promise<{state:object, reused:boolean, host:string|null, notes:string[], pid:number, held?:boolean, busy?:string,
 *   waiting?:number}>} `waiting`: bridge commands that only wait for a terminal (see waitingForTerminal)
 */
async function ensureDaemon(opts) {
  const project = opts.project;
  const mode = opts.mode;
  const open = opts.open !== false;
  const force = Boolean(opts.force);
  const stateMod = shared('state');
  const paths = shared('paths');
  const { DaemonClient } = shared('client');
  const notes = [];

  const running = await stateMod.findRunningDaemon();
  if (running) {
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token });
    const wantProject = Boolean(project && !samePath(running.project, project));
    const wantMode = Boolean(mode && running.mode !== mode);
    const maybeCompanion = !mode && !opts.keepMode && running.mode === 'bridge';
    let snap = null;
    if (wantProject || wantMode || maybeCompanion) {
      try {
        snap = await call(client, 'GET', '/api/state', undefined, { timeoutMs: 10000 });
      } catch (_) {
        snap = null; // unknown: the daemon refuses (HTTP 409) a switch that would stop a task
      }
    }
    const busy = busyReason(snap);
    // Bridge commands that only wait for a terminal: nothing runs, so a mode switch is tried
    // without --switch. A daemon that moves them into the companion session answers {moved: n};
    // one that would drop them refuses (HTTP 409).
    const waiting = waitingForTerminal(snap);
    const where = (snap && snap.project && snap.project.dir) || running.project;
    const dropIt = waiting === 1 ? 'that command' : 'those commands';
    const rerun = (what) => `rerun with --switch to ${waiting ? `drop ${dropIt}` : 'stop it'} and ${what}`;
    const companionOutcome = (r) => {
      if (!waiting) return '';
      const moved = r && Number(r.moved) > 0 ? Number(r.moved) : 0;
      if (moved) return `; the ${moved === 1 ? 'command' : `${moved} commands`} that waited for a terminal now ${moved === 1 ? 'runs' : 'run'} in the dialog's own session`;
      return `; the ${waiting === 1 ? 'command' : `${waiting} commands`} that waited for a terminal ${waiting === 1 ? 'was' : 'were'} dropped (send ${waiting === 1 ? 'it' : 'them'} again)`;
    };
    let held = false;
    if (wantProject) {
      if (busy && !force) {
        held = true;
        const again = waiting ? `rerun with --switch to switch to ${project} anyway` : rerun(`switch to ${project}`);
        notes.push(`the dialog is busy in ${where} (${busy}), so it stays on that project; ${again}`);
      } else {
        try {
          await call(client, 'POST', '/api/project', force ? { dir: project, force: true } : { dir: project }, { timeoutMs: 30000 });
          notes.push(`switched the project to ${project}${busy && !waiting ? ' (the running task was stopped)' : ''}`);
        } catch (err) {
          if (err && err.status === 409) {
            held = true;
            notes.push(`the dialog is busy in ${where} (${err.serverMessage || 'a task is running'}), so it stays on that project; ${rerun(`switch to ${project}`)}`);
          } else notes.push(`could not switch the project to ${project}: ${err.message}`);
        }
      }
    }
    if (wantMode) {
      if (busy && !force && !waiting) {
        held = true;
        notes.push(`the dialog is busy (${busy}), so it stays in ${running.mode} mode; ${rerun(`switch to ${mode} mode`)}`);
      } else {
        try {
          const r = await call(client, 'POST', '/api/mode', force ? { mode, force: true } : { mode }, { timeoutMs: 15000 });
          notes.push(`switched to ${mode} mode${waiting ? companionOutcome(r) : busy ? ' (the running task was stopped)' : ''}`);
        } catch (err) {
          if (err && err.status === 409) {
            held = true;
            notes.push(`the dialog is busy (${waiting ? busy : err.serverMessage || 'a task is running'}), so it stays in ${running.mode} mode; ${rerun(`switch to ${mode} mode`)}`);
          } else notes.push(`could not switch to ${mode} mode: ${err.message}`);
        }
      }
    } else if (maybeCompanion && !(snap && snap.mode && snap.mode !== 'bridge')) {
      // Plain `start` (/anywhere) hands a bridge dialog back to its own session when no terminal
      // takes its commands. Every case that keeps bridge mode says so: the caller would otherwise
      // tell the user that the dialog's own session works on the task.
      const listening = Boolean(snap && snap.bridge && snap.bridge.listening);
      const handBack = (how) => `rerun with ${how} to hand the dialog back to its own session`;
      if (!snap) {
        notes.push(`still in bridge mode (its state could not be read): commands from the dialog go to a Claude Code terminal that runs /anywhere here; ${handBack('--mode companion')}`);
      } else if (listening && !busy) {
        notes.push(`still in bridge mode: a Claude Code terminal is listening (/anywhere here) and takes the dialog's commands; ${handBack('--mode companion')}`);
      } else if (listening) {
        notes.push(`still in bridge mode: a Claude Code terminal took a command from the dialog and has not finished it (${busy}); if that terminal was closed, ${handBack('--mode companion --switch')} (this drops that command)`);
      } else if (busy && !waiting) {
        notes.push(`still in bridge mode (${busy}); ${handBack('--mode companion --switch')} (this stops it)`);
      } else {
        // `/anywhere here` ended (Esc) without leaving bridge mode: nothing picks up commands.
        try {
          const r = await call(client, 'POST', '/api/mode', { mode: 'companion' }, { timeoutMs: 15000 });
          notes.push(`switched back to companion mode (no Claude Code terminal was listening)${companionOutcome(r)}`);
        } catch (err) {
          if (err && err.status === 409 && waiting) {
            notes.push(`still in bridge mode: ${busy}. Run /anywhere here in Claude Code to pick ${waiting === 1 ? 'it' : 'them'} up, or ${handBack('--mode companion --switch')} (this drops ${dropIt})`);
          } else {
            notes.push(`still in bridge mode (${(err && err.serverMessage) || err.message}): commands wait for a Claude Code terminal that runs /anywhere here; ${handBack('--mode companion')}`);
          }
        }
      }
    }
    if (opts.ui) notes.push(`--ui only applies when the daemon starts (run ${cliQ('restart --ui ...')} to change it)`);
    let host = null;
    if (open) {
      try {
        const r = await call(client, 'POST', '/api/show', {}, { timeoutMs: 25000 });
        host = (r && r.host) || 'none';
      } catch (err) {
        notes.push(`could not show the dialog: ${err.message}`);
      }
    }
    const fresh = stateMod.readDaemonState() || running;
    return { state: Object.assign({}, running, fresh), reused: true, host, notes, pid: running.pid, held, busy: busy || null, waiting };
  }

  const logFile = paths.daemonLogPath();
  const offset = fileSize(logFile);
  const args = [BIN_PATH, 'daemon', '--project', project];
  if (mode) args.push('--mode', mode);
  if (opts.ui) args.push('--ui', opts.ui);
  if (!open) args.push('--no-open');
  if (opts.port != null) args.push('--port', String(opts.port));
  const env = daemonEnv(process.env);
  const { spawnDetached } = shared('proc');
  let child;
  try {
    child = spawnDetached(process.execPath, args, { cwd: isDir(project) ? project : os.homedir(), env, logFile });
  } catch (err) {
    throw new CliError(`Could not start the Claude Anywhere daemon: ${err.message}`, EXIT.ERROR, `Run: ${cliCmd('doctor')}`);
  }
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.on('error', (error) => {
    exited = { error };
  });

  const timeoutMs = opts.timeoutMs || START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const failure = (why) => {
    const tail = hideTokens(lastLines(readFrom(logFile, offset), 25) || tailFile(logFile, 25).join('\n'));
    const err = new CliError(
      `Claude Anywhere did not start: ${why}.${tail ? `\n--- daemon log (${logFile}) ---\n${tail}\n---` : `\nLog: ${logFile}`}`,
      EXIT.ERROR,
      `Run ${cliQ('doctor')} to check this machine, or ${cliQ('start --foreground')} to see the daemon output directly.`
    );
    return err;
  };
  while (Date.now() < deadline) {
    const st = await stateMod.findRunningDaemon({ timeoutMs: 1000 });
    if (st) {
      const reused = Boolean(child.pid && st.pid && st.pid !== child.pid);
      let host = null;
      if (open && opts.waitHost !== false) {
        host = reused ? null : await waitForDialogHost(logFile, offset, HOST_WAIT_MS);
      }
      return { state: st, reused, host, notes, pid: st.pid };
    }
    if (exited) {
      const again = await stateMod.findRunningDaemon({ timeoutMs: 1500 });
      if (again) return { state: again, reused: true, host: null, notes, pid: again.pid };
      // Exit code 0 is ALREADY_RUNNING: another daemon won the start lock and is still coming
      // up, so keep waiting for it until the deadline instead of failing now.
      if (!(exited.code === 0 && !exited.error && !exited.signal)) {
        const how = exited.error ? exited.error.message : `the daemon exited with code ${exited.code}${exited.signal ? ` (${exited.signal})` : ''}`;
        throw failure(how);
      }
    }
    await sleep(200);
  }
  if (exited && exited.code === 0) throw failure(`another daemon was starting but did not answer within ${Math.round(timeoutMs / 1000)} s`);
  throw failure(`no answer within ${Math.round(timeoutMs / 1000)} s`);
}

/**
 * The dialog address to print. The token URL controls this computer, so it is printed only when
 * the user has to open the page themselves (no window could open, or --no-open: `host` 'none' or
 * undefined) or asks for it (--show-token). Everyone else gets the bare address: the output of
 * start, status, send and doctor often lands in Claude's transcript.
 * @param {{url?:string, port?:number}} st daemon.json
 * @param {{host?:string|null, showToken?:boolean}} [opts]
 * @returns {{url:string|null, withToken:boolean}}
 */
function dialogUrl(st, opts = {}) {
  // An explicit `host: undefined` means the window was not opened (--no-open); no host means unknown.
  const host = Object.prototype.hasOwnProperty.call(opts, 'host') ? opts.host : null;
  const showToken = Boolean(opts.showToken);
  const full = (st && st.url) || null;
  const bare = st && st.port ? `http://127.0.0.1:${st.port}/` : full ? full.replace(/[?&]token=[^&#]*/, '') : null;
  if (full && (showToken || host === 'none' || host === undefined)) return { url: full, withToken: true };
  return { url: bare, withToken: false };
}

function startSummary(res, config, { mode: requestedMode, showToken = false } = {}) {
  const s = sym();
  const st = res.state || {};
  const mode = st.mode || requestedMode || config.mode || 'companion';
  const host = res.host;
  const lines = [];
  const dialog = host === undefined ? 'not opened' : hostLabel(host);
  lines.push(`${color.bold(`${s.star} Claude Anywhere is running`)} ${s.dot} dialog: ${dialog} ${s.dot} project: ${st.project || '?'} ${s.dot} mode: ${mode}`);
  if (res.reused) lines.push(color.dim(`  (reused the daemon that was already running, pid ${st.pid})`));
  for (const n of res.notes || []) lines.push(color.dim(`  ${s.dot} ${n}`));
  const link = dialogUrl(st, { host, showToken });
  if (link.withToken) lines.push(`  URL      ${link.url}`);
  else lines.push(`  URL      ${link.url || '?'}   (${cliQ('url')} prints the full link)`);
  const install = readInstallInfo();
  const osHotkey = install && install.hotkey && install.hotkey.installed ? install.hotkey.label || null : null;
  if (host === 'electron') {
    lines.push(`  Hotkey   ${hotkeyLabel(config.ui && config.ui.hotkey)} shows or hides the dialog`);
  } else if (osHotkey) {
    lines.push(`  Hotkey   ${osHotkey} (OS shortcut) brings the dialog back`);
  }
  if (host === 'none') {
    if (process.env.SSH_CONNECTION) {
      lines.push(`  Tunnel   ssh -L ${st.port}:127.0.0.1:${st.port} <user>@<this host>   (same port on both ends), then open the URL on your computer`);
      lines.push(`  Note     No window could be opened here. Use the tunnel above, or in a terminal run: ${cliCmd('tui')}`);
    } else {
      lines.push(`  Note     No window could be opened here. Open the URL above in a browser, or in a terminal run: ${cliCmd('tui')}`);
    }
  } else if (host === null) {
    lines.push(`  Note     The dialog window is still opening; if it does not appear, run: ${cliCmd('show')}`);
  }
  if (mode === 'bridge') {
    lines.push(`  Next     Commands from the dialog go to the Claude Code session that runs ${cliQ('listen')}.`);
    lines.push(`           Loop: ${cliCmd('listen')}  →  do the work  →  ${cliCmd('reply --final "summary"')}.`);
  } else {
    lines.push('  Next     Type or talk (mic button; hold Space to talk) in the dialog. Claude works in the project above.');
  }
  lines.push(`           ${cliQ('show')} (or /anywhere) brings the dialog back ${s.dot} ${cliQ('stop')} (or /anywhere stop) quits.`);
  return lines.join('\n');
}

function startJson(res, config, requestedMode, { showToken = false } = {}) {
  const st = res.state || {};
  const install = readInstallInfo();
  return {
    ok: true,
    running: true,
    reused: Boolean(res.reused),
    pid: st.pid || null,
    port: st.port || null,
    url: dialogUrl(st, { host: res.host, showToken }).url,
    project: st.project || null,
    mode: st.mode || requestedMode || config.mode,
    host: res.host === undefined ? null : res.host,
    hotkey: res.host === 'electron' ? hotkeyLabel(config.ui && config.ui.hotkey) : install && install.hotkey && install.hotkey.installed ? install.hotkey.label || null : null,
    version: st.version || packageVersion(),
    logFile: shared('paths').daemonLogPath(),
    notes: res.notes || [],
    busy: res.held ? res.busy || 'busy' : null,
  };
}

// ------------------------------------------------------------------ commands: lifecycle

async function cmdStart(p) {
  const f = p.flags;
  if (p._.length) throw usageError(`Unexpected argument "${p._[0]}"`, 'start');
  const project = resolveProject(f.project);
  const mode = validateMode(f.mode);
  const ui = validateUi(f.ui);
  const open = f.open !== false;
  if (f.port != null) toInt(f.port, '--port', 0, 65535);
  const config = shared('config').load();
  if (f.foreground) return runDaemonForeground({ project, mode, ui, open, port: f.port, announce: true, showToken: Boolean(f['show-token']) });
  const timeoutMs = f.timeout ? toInt(f.timeout, '--timeout', 1, 600) * 1000 : START_TIMEOUT_MS;
  const res = await ensureDaemon({ project, mode, ui, open, timeoutMs, port: f.port, force: Boolean(f.switch) });
  if (!open) res.host = undefined;
  if (f.json) printJson(startJson(res, config, mode, { showToken: Boolean(f['show-token']) }));
  else writeOut(startSummary(res, config, { mode, showToken: Boolean(f['show-token']) }));
  return EXIT.OK;
}

async function runDaemonForeground({ project, mode, ui, open, port, announce, showToken = false }) {
  const main = requirePkg('src/daemon/main.js', 'The daemon');
  try {
    process.title = 'claude-anywhere-daemon';
  } catch (_) {
    /* ignore */
  }
  const opts = { project, mode, ui, open };
  if (port != null && port !== '') opts.port = toInt(port, '--port', 0, 65535);
  let d;
  try {
    d = await main.runDaemon(opts);
  } catch (err) {
    if (err && err.code === 'ALREADY_RUNNING') {
      if (announce) throw new CliError(err.message, EXIT.ERROR, `Stop it first: ${cliCmd('stop')}`);
      writeErr(err.message);
      return EXIT.OK;
    }
    throw err;
  }
  if (announce && d) {
    // A window opens (the daemon prints the token URL itself when none can); --no-open needs the link.
    const link = dialogUrl({ url: d.url, port: d.port }, { host: open ? null : undefined, showToken });
    writeErr(`${sym().star} Claude Anywhere is running in the foreground at ${link.url}${link.withToken ? '' : ` (${cliQ('url')} prints the full link)`} (Ctrl+C stops it).`);
  }
  return KEEP_ALIVE;
}

async function cmdDaemon(p) {
  const f = p.flags;
  const project = f.project ? path.resolve(expandHome(f.project)) : process.cwd();
  return runDaemonForeground({ project, mode: validateMode(f.mode), ui: validateUi(f.ui), open: f.open !== false, port: f.port, announce: false });
}

// The daemon's command line: the process title runDaemonForeground sets, `anywhere.js daemon …`,
// or `anywhere.js start|restart … --foreground`. Windows reports the real command line (CIM
// Win32_Process.CommandLine); process.title only sets the console title there.
const DAEMON_CMD_RE = /claude-anywhere-daemon|anywhere(\.js)?["']?\s+daemon(\s|$)|daemon[\\/]main\.js|anywhere(\.js|\.cmd)?["']?\s+(re)?start\s(?:[^\r\n]*\s)?--foreground(\s|$)/;
// ps etime and /proc tick counts are coarse; daemon.json's startedAt is written just after start.
const START_TOLERANCE_MS = 2000;

/** Is this command line a Claude Anywhere daemon? true/false, or null when unknown. */
function looksLikeDaemon(cmdline) {
  if (cmdline == null) return null;
  return DAEMON_CMD_RE.test(String(cmdline));
}

/**
 * Does this command line run what daemon.json recorded (its argv, in order)? null when unknown.
 * Covers daemons started some way the pattern above does not know (Windows reports the real
 * command line, without the process title).
 * @param {string|null} cmdline
 * @param {object} raw daemon.json
 * @returns {boolean|null}
 */
function cmdlineMatchesRecorded(cmdline, raw) {
  if (cmdline == null || !raw || !Array.isArray(raw.argv)) return null;
  const norm = (t) => String(t).replace(/["']/g, '').replace(/\\/g, '/').toLowerCase();
  const want = raw.argv.map(norm).filter(Boolean);
  if (!want.length) return null;
  const line = norm(cmdline);
  let at = 0;
  for (const a of want) {
    const i = line.indexOf(a, at);
    if (i < 0) return false;
    at = i + a.length;
  }
  return true;
}

/** ps etime ("[[dd-]hh:]mm:ss") in seconds, or null. */
function parseEtime(text) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(String(text || ''));
  if (!m) return null;
  return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/**
 * When a live process started and what it runs, as far as the OS tells: {startMs, startTicks,
 * cmdline}, each null when unknown. Linux reads /proc, macOS and other Unixes ps, Windows CIM.
 * @param {number} pid
 */
async function processIdentity(pid) {
  const out = { startMs: null, startTicks: null, cmdline: null };
  const { run, which } = shared('proc');
  try {
    if (process.platform === 'linux' && fs.existsSync(`/proc/${pid}/stat`)) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 22, starttime (clock ticks after boot); the name in field 2 may hold spaces and ")".
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8'));
      if (Number.isFinite(ticks) && Number.isFinite(uptime)) {
        out.startTicks = ticks;
        out.startMs = Date.now() - (uptime - ticks / 100) * 1000; // USER_HZ is 100
      }
      out.cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim();
      return out;
    }
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const builtin = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const ps = fs.existsSync(builtin) ? builtin : which('powershell.exe') || which('pwsh.exe');
      if (!ps) return out;
      const script =
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; ` +
        "if ($p) { [pscustomobject]@{ start = $p.CreationDate.ToUniversalTime().ToString('o'); cmd = $p.CommandLine } | ConvertTo-Json -Compress }";
      const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15000 });
      const text = String(r.stdout || '').trim();
      if (r.code !== 0 || !text) return out;
      const data = JSON.parse(text);
      const t = Date.parse(data.start);
      if (Number.isFinite(t)) out.startMs = t;
      if (typeof data.cmd === 'string') out.cmdline = data.cmd;
      return out;
    }
    const r = await run('ps', ['-o', 'etime=', '-o', 'command=', '-p', String(pid)], { timeoutMs: 3000, env: Object.assign({}, process.env, { LC_ALL: 'C' }) });
    const m = /^\s*(\S+)\s+([\s\S]*?)\s*$/.exec(String(r.stdout || ''));
    if (r.code !== 0 || !m) return out;
    const secs = parseEtime(m[1]);
    if (secs != null) out.startMs = Date.now() - secs * 1000;
    out.cmdline = m[2];
  } catch (_) {
    /* unknown */
  }
  return out;
}

/**
 * Is the live process `raw.pid` still the daemon that wrote daemon.json? PIDs are reused (on
 * Windows quickly, and after every reboot), so a pid alone proves nothing: the process must have
 * started no later than the daemon recorded its start, and run the daemon's command line.
 * @param {object} raw daemon.json
 * @returns {Promise<'match'|'mismatch'|'unknown'>}
 */
async function daemonIdentity(raw, identity) {
  const id = identity || (await processIdentity(raw.pid));
  let recorded = typeof raw.startTime === 'number' ? raw.startTime : Date.parse(raw.startTime || raw.startedAt || '');
  if (!Number.isFinite(recorded)) recorded = null;
  let timeOk = null;
  if (typeof raw.startTicks === 'number' && id.startTicks != null) timeOk = raw.startTicks === id.startTicks;
  else if (id.startMs != null && recorded != null) timeOk = id.startMs <= recorded + START_TOLERANCE_MS;
  // A process that started after the daemon wrote daemon.json got the pid after the daemon ended.
  if (timeOk === false) return 'mismatch';
  let looks = looksLikeDaemon(id.cmdline);
  if (looks === false && cmdlineMatchesRecorded(id.cmdline, raw)) looks = true;
  if (looks === false) return 'mismatch';
  return timeOk && looks ? 'match' : 'unknown';
}

async function killPid(pid) {
  const stateMod = shared('state');
  const waitDead = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!stateMod.isPidAlive(pid)) return true;
      await sleep(150);
    }
    return !stateMod.isPidAlive(pid);
  };
  if (process.platform === 'win32') {
    // process.kill is TerminateProcess: it ends only this process, and Windows leaves its children
    // (claude, the MCP server, the app window) running. taskkill /T walks the tree while the
    // parent is still alive, so it runs first.
    await shared('proc').run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 });
    if (await waitDead(3000)) return 'taskkill';
    try {
      process.kill(pid, 'SIGKILL');
    } catch (_) {
      /* already gone */
    }
    return (await waitDead(3000)) ? 'SIGKILL' : null;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {
    /* already gone */
  }
  if (await waitDead(3000)) return 'SIGTERM';
  try {
    process.kill(pid, 'SIGKILL');
  } catch (_) {
    /* already gone */
  }
  return (await waitDead(3000)) ? 'SIGKILL' : null;
}

/**
 * Stop the daemon.
 * @returns {Promise<{stopped:boolean, pid:number|null, how:string, stale?:boolean, unconfirmed?:boolean}>}
 */
async function stopDaemon() {
  const stateMod = shared('state');
  const { DaemonClient } = shared('client');
  const st = await stateMod.findRunningDaemon();
  if (!st) {
    const raw = stateMod.readDaemonState();
    if (raw && raw.pid && stateMod.isPidAlive(raw.pid) && raw.pid !== process.pid) {
      // The daemon does not answer: only kill the pid when it is provably still that daemon.
      const identity = await daemonIdentity(raw);
      stateMod.clearDaemonState();
      if (identity === 'match') {
        const how = await killPid(raw.pid);
        return { stopped: Boolean(how), pid: raw.pid, how: how ? `unresponsive daemon killed (${how})` : 'could not kill the unresponsive daemon' };
      }
      if (identity === 'mismatch') return { stopped: false, pid: null, stale: true, how: `not running (daemon.json was stale: pid ${raw.pid} now belongs to another program, which was left alone)` };
      return { stopped: false, pid: raw.pid, unconfirmed: true, how: `the daemon did not answer, and pid ${raw.pid} could not be confirmed as the daemon, so it was not killed` };
    }
    stateMod.clearDaemonState();
    return { stopped: false, pid: null, how: 'not running' };
  }
  const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${st.port}`, token: st.token });
  try {
    await client.request('POST', '/api/shutdown', {}, { timeoutMs: 5000 });
  } catch (_) {
    /* the socket may close as the daemon exits */
  }
  const end = Date.now() + 10000;
  while (Date.now() < end && st.pid && stateMod.isPidAlive(st.pid)) await sleep(150);
  let how = 'shutdown';
  if (st.pid && stateMod.isPidAlive(st.pid)) {
    const killed = await killPid(st.pid);
    how = killed ? `killed (${killed}) after a graceful shutdown timed out` : 'still running';
  }
  stateMod.clearDaemonState(st.instanceId);
  return { stopped: how !== 'still running', pid: st.pid || null, how };
}

async function cmdStop(p) {
  const r = await stopDaemon();
  const killHint = r.pid ? (process.platform === 'win32' ? `taskkill /PID ${r.pid} /T /F` : `kill ${r.pid}`) : '';
  if (p.flags.json) printJson(Object.assign({ ok: r.how !== 'still running' && !r.unconfirmed }, r));
  else if (r.how === 'not running') writeOut('Claude Anywhere is not running.');
  else if (r.stale) writeOut(`Claude Anywhere is ${r.how}.`);
  else if (r.stopped) writeOut(`${color.green(sym().ok)} Claude Anywhere stopped (pid ${r.pid}${r.how !== 'shutdown' ? `, ${r.how}` : ''}).`);
  else if (r.unconfirmed) throw new CliError(`Claude Anywhere is not answering: ${r.how}.`, EXIT.ERROR, `If pid ${r.pid} is the Claude Anywhere daemon, end it yourself: ${killHint}`);
  else throw new CliError(`Could not stop Claude Anywhere (pid ${r.pid}).`, EXIT.ERROR, `Kill the process manually: ${killHint}`);
  return EXIT.OK;
}

async function cmdRestart(p) {
  const prev = shared('state').readDaemonState();
  const stopped = await stopDaemon();
  if (stopped.unconfirmed && !p.flags.json) writeErr(color.yellow(`${sym().warn} The old daemon did not answer: ${stopped.how}.`, process.stderr));
  if (!p.flags.project && prev && prev.project && isDir(prev.project)) p.flags.project = prev.project;
  if (!p.flags.mode && prev && prev.mode) p.flags.mode = prev.mode;
  return cmdStart(p);
}

async function cmdStatus(p) {
  const d = await getDaemon();
  if (!d) {
    if (p.flags.json) printJson({ running: false });
    else writeOut(`Claude Anywhere is not running. Start it with /anywhere in Claude Code, or: ${cliCmd('start')}`);
    return EXIT.NOT_RUNNING;
  }
  const snap = await call(d.client, 'GET', '/api/state', undefined, { timeoutMs: 10000 });
  const st = d.state;
  if (p.flags.json) {
    const slim = Object.assign({}, snap, {
      messages: undefined,
      messageCount: Array.isArray(snap.messages) ? snap.messages.length : 0,
      screenshot: snap.screenshot ? { width: snap.screenshot.width, height: snap.screenshot.height, ts: snap.screenshot.ts } : null,
    });
    const url = dialogUrl(st, { showToken: Boolean(p.flags['show-token']) }).url;
    printJson({ running: true, pid: st.pid || null, port: st.port || null, url, startedAt: st.startedAt || null, state: slim });
    return EXIT.OK;
  }
  const s = sym();
  const lines = [];
  const up = st.startedAt ? `, up ${fmtDuration(Date.now() - Date.parse(st.startedAt))}` : '';
  lines.push(color.bold(`${s.star} Claude Anywhere ${snap.version || st.version || ''} is running`) + color.dim(` (pid ${st.pid || '?'}, port ${st.port || '?'}${up})`));
  const proj = snap.project || {};
  const git = proj.git && proj.git.branch ? ` ${s.dot} git ${proj.git.branch}${proj.git.dirty ? ' (uncommitted changes)' : ''}` : '';
  lines.push(`  Project   ${proj.name || ''} (${proj.dir || st.project || '?'})${git}`);
  lines.push(`  Mode      ${snap.mode} ${s.dot} status ${snap.status}${snap.statusDetail ? `: ${snap.statusDetail}` : ''}`);
  const sess = snap.session || {};
  if (sess.id) {
    const cost = typeof sess.costUsd === 'number' && sess.costUsd > 0 ? ` ${s.dot} $${sess.costUsd.toFixed(sess.costUsd < 1 ? 4 : 2)}` : '';
    lines.push(`  Session   ${sess.id}${sess.model ? ` ${s.dot} ${sess.model}` : ''}${cost} ${s.dot} ${sess.turns || 0} turn${sess.turns === 1 ? '' : 's'}`);
  }
  // The token URL controls this computer and this output often lands in Claude's transcript.
  if (st.url) {
    const link = dialogUrl(st, { showToken: Boolean(p.flags['show-token']) });
    lines.push(`  Dialog    ${link.url}${link.withToken ? '' : `   (${cliQ('url')} prints the full link)`}`);
  }
  const v = snap.voice || {};
  const tts = v.engine === 'piper' ? `Piper natural voice${v.piper && v.piper.voice ? ` (${v.piper.voice})` : ''}` : v.serverTts ? v.ttsProvider : 'browser only';
  lines.push(`  Voice     speech-to-text: ${v.serverStt ? v.sttProvider : 'browser only'} ${s.dot} text-to-speech: ${tts}`);
  if (snap.mode === 'bridge') lines.push(`  Bridge    ${snap.bridge && snap.bridge.listening ? 'a Claude Code session is listening' : 'no Claude Code session is listening (run /anywhere here)'}`);
  const pend = snap.pending || {};
  const na = (pend.approvals || []).length;
  const nq = (pend.questions || []).length;
  if (na || nq) lines.push(color.yellow(`  Waiting   ${na} approval${na === 1 ? '' : 's'}, ${nq} question${nq === 1 ? '' : 's'} in the dialog`));
  const pl = snap.platform || {};
  lines.push(`  Platform  ${pl.platform || process.platform} ${s.dot} ${pl.displayServer || '?'} ${s.dot} driver ${pl.driver || 'not loaded yet'}`);
  writeOut(lines.join('\n'));
  return EXIT.OK;
}

/**
 * macOS launcher applet with no daemon running: start it from Terminal instead of inside the
 * applet. A daemon spawned by the applet belongs to the applet for macOS privacy (Accessibility and
 * Screen Recording granted to Terminal would not apply) and gets the bare `do shell script` PATH.
 * @returns {Promise<{opened:boolean, file:string, error?:string}>}
 */
async function startViaTerminal(project) {
  const dir = shared('paths').stateDir();
  const file = path.join(dir, 'start-anywhere.command');
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    `#!/bin/sh\n# Written by the Claude Anywhere launcher: starts the dialog from Terminal.\nexec ${q(process.execPath)} ${q(BIN_PATH)} start --project ${q(project)}\n`,
    { mode: 0o700 }
  );
  fs.chmodSync(file, 0o700);
  const { run } = shared('proc');
  const r = await run('open', ['-a', 'Terminal', file], { timeoutMs: 15000 });
  if (!r.error && r.code === 0) return { opened: true, file };
  await run('osascript', ['-e', 'display notification "Type /anywhere in Claude Code to start it." with title "Claude Anywhere is not running"'], { timeoutMs: 10000 });
  return { opened: false, file, error: String(r.stderr || (r.error && r.error.message) || `exit ${r.code}`).trim().split(/\r?\n/)[0] };
}

async function cmdShow(p) {
  const d = await getDaemon();
  if (!d) {
    const project = p.flags.project ? resolveProject(p.flags.project) : lastProject();
    if (p.flags.launcher && process.platform === 'darwin') {
      const r = await startViaTerminal(project);
      if (p.flags.json) printJson(Object.assign({ ok: r.opened, running: false }, r));
      else if (r.opened) writeOut('Claude Anywhere was not running; opened Terminal to start it.');
      else writeOut(`Claude Anywhere is not running, and Terminal could not be opened (${r.error}). Type /anywhere in Claude Code, or run: ${cliCmd('start')}`);
      return r.opened ? EXIT.OK : EXIT.NOT_RUNNING;
    }
    const config = shared('config').load();
    const res = await ensureDaemon({ project, open: true });
    if (p.flags.json) printJson(startJson(res, config));
    else writeOut(startSummary(res, config));
    return EXIT.OK;
  }
  const r = await call(d.client, 'POST', '/api/show', {}, { timeoutMs: 25000 });
  if (p.flags.json) {
    // The token URL only when no window opened and the page must be opened by hand.
    printJson(Object.assign({ url: dialogUrl(d.state, { host: (r && r.host) || 'none' }).url }, r));
    return EXIT.OK;
  }
  if (r && r.host && r.host !== 'none') writeOut(`${color.green(sym().ok)} Dialog shown (${hostLabel(r.host)}).`);
  else writeOut(`No dialog window could be opened${r && r.error ? ` (${r.error})` : ''}. Open ${d.state.url || 'the dialog URL'} in a browser, or in a terminal run: ${cliCmd('tui')}`);
  return EXIT.OK;
}

async function cmdUrl(p) {
  const d = await requireDaemon();
  if (p.flags.json) printJson({ url: d.state.url, port: d.state.port });
  else writeOut(d.state.url);
  return EXIT.OK;
}

// ------------------------------------------------------------------ commands: talking to Claude

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function readImageFile(file) {
  const abs = path.resolve(expandHome(file));
  const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
  if (!type) throw usageError(`--image supports .png, .jpg, .gif and .webp files (got ${file})`, 'send');
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (err) {
    throw new CliError(`Cannot read image ${abs}: ${err.message}`);
  }
  if (buf.length > 20 * 1024 * 1024) throw new CliError(`Image ${abs} is larger than 20 MB.`);
  return { mediaType: type, data: buf.toString('base64') };
}

/**
 * Wait for the result of one command sent with POST /api/command.
 * commandId.value is filled in once the POST answers; events that arrive before that are kept
 * and matched when it is (see the returned promise's idKnown()).
 * A daemon that tags results with `commandIds` (the commands a result answers) is matched
 * exactly, so a result for another command never ends the wait; an older daemon without the
 * field falls back to the first result after our user message. `commands_cancelled`
 * {commandIds, reason} ends the wait with `cancelled` (Stop, a reset or a mode switch dropped it).
 */
function waitForResult(client, commandId, timeoutMs) {
  let check = () => {};
  const promise = new Promise((resolve) => {
    const seenUser = new Set();
    const early = [];
    let ours = false;
    let assistantText = '';
    let timer = null;
    let done = false;
    let sub = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sub) sub.close();
      resolve(value);
    };
    const handle = (type, data) => {
      if (done) return;
      const id = commandId.value;
      // The client followed daemon.json to a new daemon: ours (and the command) is gone.
      if (type === '_daemon_replaced') return void finish({ cancelled: 'daemon_restarted', text: assistantText });
      if (type === 'message' && data && data.role === 'user') {
        seenUser.add(data.id);
        if (id && data.id === id) ours = true;
      }
      if (!ours && id && seenUser.has(id)) ours = true;
      if (type === 'commands_cancelled' && data && Array.isArray(data.commandIds)) {
        if (!id) return void early.push([type, data]);
        if (data.commandIds.includes(id)) finish({ cancelled: String(data.reason || 'cancelled'), text: assistantText });
        return;
      }
      if (type === 'result' && data && Array.isArray(data.commandIds)) {
        if (!id) return void early.push([type, data]);
        if (data.commandIds.includes(id)) finish({ result: data, text: data.text || assistantText });
        return; // it answers another command: keep waiting
      }
      if (!ours) return;
      if (type === 'message' && data && data.role === 'assistant' && data.text && !data.streaming) assistantText = data.text;
      if (type === 'result') finish({ result: data, text: (data && data.text) || assistantText }); // older daemon
    };
    check = () => {
      for (const [type, data] of early.splice(0)) handle(type, data);
    };
    // A watcher, not a dialog: it does not count as someone who sees notifications or cards.
    sub = client.subscribe(handle, { kind: 'cli' });
    timer = setTimeout(() => finish({ timeout: true, text: assistantText }), timeoutMs);
  });
  promise.idKnown = () => check();
  return promise;
}

const CANCEL_REASONS = {
  stopped: 'it was stopped before it ran',
  reset: 'the conversation was reset before it ran',
  cancelled: 'it was cancelled before it ran',
  interrupted: 'it was stopped before it finished (it may have partly run)',
  engine_exit: 'Claude Code exited before it answered',
  daemon_restarted: 'Claude Anywhere restarted before it answered',
  failed: 'it could not be run',
};

/**
 * Whether a command just queued can be picked up: the dialog's mode and, in bridge mode, whether
 * a Claude Code terminal listens. Uses the /api/command answer when it carries them, else
 * daemon.json and GET /api/state. null when unknown.
 * @returns {Promise<{mode:string, listening:boolean}|null>}
 */
async function bridgeInfo(d, answer) {
  if (answer && typeof answer.mode === 'string') {
    const b = answer.bridge && typeof answer.bridge === 'object' ? answer.bridge.listening : answer.listening;
    if (answer.mode !== 'bridge' || typeof b === 'boolean') return { mode: answer.mode, listening: Boolean(b) };
  }
  const st = d.state && d.state.fromEnv ? null : shared('state').readDaemonState();
  if (st && st.mode && st.mode !== 'bridge') return { mode: st.mode, listening: false };
  try {
    const snap = await call(d.client, 'GET', '/api/state', undefined, { timeoutMs: 8000 });
    return snap && snap.mode ? { mode: snap.mode, listening: Boolean(snap.bridge && snap.bridge.listening) } : null;
  } catch (_) {
    return null;
  }
}

async function cmdSend(p, opts) {
  const f = p.flags;
  const text = (await gatherText(p)).trim();
  const images = (f.image || []).map(readImageFile);
  if (!text && !images.length) throw usageError('Nothing to send. Usage: anywhere send "what to do"', 'send');
  let d = await getDaemon();
  let started = null;
  if (!d) {
    if (f.start === false) throw notRunningError();
    const project = f.project ? resolveProject(f.project) : process.cwd();
    started = await ensureDaemon({ project, open: f.open !== false, waitHost: false });
    d = await requireDaemon();
  } else if (f.project && !d.state.fromEnv) {
    // A task for another folder: switch the dialog there, but never stop a task in progress silently.
    const project = resolveProject(f.project);
    if (!samePath(d.state.project, project)) {
      const res = await ensureDaemon({ project, open: false, keepMode: true, force: Boolean(f.switch) });
      if (res.held) {
        const there = res.state.project || 'another project';
        if (res.waiting) {
          // Nothing runs there and nothing will finish on its own: no "wait for it to finish".
          const them = res.waiting === 1 ? 'it' : 'them';
          throw new CliError(
            `Not sent: the dialog in ${there} has ${commandsWord(res.waiting)} waiting for a Claude Code terminal (none is listening), so it was not switched to ${project}.`,
            EXIT.ERROR,
            `Run /anywhere here in Claude Code to pick ${them} up, rerun with --switch to switch anyway, or send without --project to queue this task in ${there} too.`
          );
        }
        throw new CliError(
          `Not sent: the dialog is busy in ${there} (${res.busy || 'a task is running'}), so it was not switched to ${project}.`,
          EXIT.ERROR,
          `Wait for it to finish, rerun with --switch to stop that task and switch, or send without --project to queue it in ${there}.`
        );
      }
      for (const n of res.notes) if (!f.json) writeErr(color.dim(`${sym().dot} ${n}`, process.stderr));
      d = (await getDaemon()) || d;
    }
  }
  const body = { text, source: f.source || (opts && opts.source) || 'cli' };
  // --screenshot / --no-screenshot override context.attachScreenshotByDefault; neither = the default.
  if (f.screenshot === true) body.attachScreenshot = true;
  else if (f.screenshot === false) body.attachScreenshot = false;
  if (images.length) body.images = images;
  const commandId = { value: null };
  let waiting = null;
  if (f.wait) {
    const secs = f.timeout ? toInt(f.timeout, '--timeout', 1, 86400) : 1800;
    waiting = waitForResult(d.client, commandId, secs * 1000);
    await sleep(150);
  }
  const r = await call(d.client, 'POST', '/api/command', body, { timeoutMs: 60000 });
  commandId.value = r && r.id;
  if (waiting) waiting.idKnown();
  const bi = await bridgeInfo(d, r);
  // The task just queued makes the dialog busy, so a plain `start --mode companion` is refused:
  // name the command that does switch (it drops the queued task unless the daemon moves it).
  const here = d.state && !d.state.fromEnv && d.state.project ? ` --project "${d.state.project}"` : '';
  const warning =
    bi && bi.mode === 'bridge' && !bi.listening
      ? `The dialog is in bridge mode and no Claude Code terminal is listening, so this task waits until one runs /anywhere here. To have the dialog's own session do it instead, run: ${cliCmd(`start --mode companion --switch${here}`)}, then send the task again unless that output says it now runs in the dialog's own session.`
      : null;
  if (!waiting) {
    if (f.json) printJson({ ok: true, id: r.id, started: Boolean(started), mode: bi ? bi.mode : null, warning });
    else {
      // The bare address: the token URL stays out of output that lands in transcripts.
      if (started) writeOut(`${sym().star} Started Claude Anywhere for ${started.state.project} (http://127.0.0.1:${started.state.port}/; ${cliQ('url')} prints the full link).`);
      writeOut(`${color.green(sym().ok)} Sent to Claude Anywhere (command ${r.id}). ${warning ? 'It is queued in the dialog.' : 'Follow along in the dialog.'}`);
      if (warning) writeOut(color.yellow(`${sym().warn} ${warning}`));
    }
    return EXIT.OK;
  }
  if (warning && !f.json) writeErr(color.yellow(`${sym().warn} ${warning}`, process.stderr));
  const res = await waiting;
  if (f.json) printJson(Object.assign({ ok: !res.timeout && !res.cancelled, id: r.id }, res));
  else if (res.timeout) writeOut('TIMEOUT');
  else if (res.cancelled) writeErr(color.yellow(`${sym().warn} Not answered: ${CANCEL_REASONS[res.cancelled] || `it was cancelled (${res.cancelled})`}.`, process.stderr));
  else writeOut(res.text || (res.result && res.result.interrupted ? 'Stopped.' : '(no text in the result)'));
  if (res.timeout) return EXIT.TIMEOUT;
  if (res.cancelled) return res.cancelled === 'stopped' || res.cancelled === 'interrupted' ? EXIT.INTERRUPTED : EXIT.ERROR;
  if (res.result && res.result.interrupted) return EXIT.INTERRUPTED;
  return res.result && res.result.isError ? EXIT.ERROR : EXIT.OK;
}

async function cmdInterrupt(p) {
  const d = await requireDaemon();
  await call(d.client, 'POST', '/api/interrupt', {}, { timeoutMs: 15000 });
  if (p.flags.json) printJson({ ok: true });
  else writeOut(`${color.green(sym().ok)} Interrupted the current task.`);
  return EXIT.OK;
}

/**
 * Human-readable bridge command for the interactive Claude Code session.
 * @param {{id:string,text:string,context?:string,images?:string[],source?:string}} cmd
 */
function formatCommand(cmd) {
  const lines = [`===ANYWHERE COMMAND ${cmd.id}===`, String(cmd.text || '')];
  if (cmd.source === 'voice') lines.push('[spoken by the user: the transcript may contain speech-recognition errors]');
  if (cmd.context && String(cmd.context).trim()) lines.push(String(cmd.context).trim());
  if (Array.isArray(cmd.images) && cmd.images.length) lines.push(`[images: ${cmd.images.join(', ')}]`);
  return lines.join('\n');
}

async function cmdListen(p) {
  const f = p.flags;
  const secs = f.timeout != null ? toInt(f.timeout, '--timeout', 1, LISTEN_MAX_SEC) : LISTEN_DEFAULT_SEC;
  const d = await getDaemon();
  if (!d) throw notRunningError('', `Start the dialog in bridge mode with /anywhere here (or: ${cliCmd('start --mode bridge')}).`);
  let r;
  try {
    r = await callLong(d.client, 'POST', '/api/bridge/listen', { timeoutSec: secs }, (secs + 30) * 1000);
  } catch (err) {
    if (err && err.code === 'ETIMEDOUT') r = { timeout: true };
    else throw err;
  }
  if (r && r.command) {
    if (f.json) printJson({ command: r.command });
    else writeOut(formatCommand(r.command));
    return EXIT.OK;
  }
  if (r && r.stop) {
    writeOut(f.json ? JSON.stringify({ stop: true }) : 'STOP');
    return EXIT.STOP;
  }
  if (r && r.timeout) {
    writeOut(f.json ? JSON.stringify({ timeout: true }) : 'TIMEOUT');
    return EXIT.TIMEOUT;
  }
  throw new CliError(`Unexpected answer from the daemon: ${JSON.stringify(r)}`);
}

async function cmdReply(p) {
  const f = p.flags;
  const text = await gatherText(p);
  if (!text.trim()) throw usageError('Nothing to reply. Usage: anywhere reply [--final] "text"', 'reply');
  const d = await requireDaemon();
  try {
    await call(d.client, 'POST', '/api/bridge/reply', { text, final: Boolean(f.final), speak: f.speak !== false }, { timeoutMs: 15000 });
  } catch (err) {
    // 409 COMMAND_STOPPED: the user pressed Stop on this command: abandon it, listen again.
    if (err && err.status === 409 && err.code === 'COMMAND_STOPPED') return printStopped(f, err);
    // 409: the dialog switched to companion mode, so the /anywhere here loop must end.
    if (err && err.status === 409) {
      if (f.json) printJson({ ok: false, stop: true, error: err.serverMessage || err.message });
      else writeOut('STOP (bridge mode is off: the dialog switched to companion mode, so this reply was not shown)');
      return EXIT.STOP;
    }
    throw err;
  }
  if (f.json) printJson({ ok: true, final: Boolean(f.final) });
  else if (f.final) writeOut(`${color.green(sym().ok)} Final reply shown in the dialog. Run "listen" again for the next command.`);
  else writeOut(`${color.green(sym().ok)} Progress shown in the dialog.`);
  return EXIT.OK;
}

/**
 * The user pressed Stop in the dialog on the command this terminal works on (HTTP 409
 * COMMAND_STOPPED from reply or ask): print STOPPED, exit 5. Not the loop's STOP (exit 3): the
 * terminal abandons this command and runs listen again.
 */
function printStopped(f, err) {
  if (f.json) printJson({ ok: false, stopped: 'command', error: (err && (err.serverMessage || err.message)) || 'stopped' });
  else writeOut('STOPPED (the user pressed Stop in the dialog: abandon this command, do not continue its steps or send more replies, and run "listen" for the next one)');
  return EXIT.STOPPED;
}

function parseOptions(f) {
  const out = [];
  for (const v of [].concat(f.options || [])) {
    for (const part of String(v).split(',')) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  for (const v of [].concat(f.option || [])) {
    const t = String(v).trim();
    if (t) out.push(t);
  }
  return out;
}

async function cmdAsk(p) {
  const f = p.flags;
  const question = (await gatherText(p)).trim();
  if (!question) throw usageError('Usage: anywhere ask "question" [--options "Yes,No"]', 'ask');
  const secs = f.timeout != null ? toInt(f.timeout, '--timeout', 1, 86400) : ASK_DEFAULT_SEC;
  const options = parseOptions(f);
  const d = await requireDaemon();
  const body = { question, timeoutSec: secs };
  if (options.length) body.options = options;
  let r;
  try {
    r = await callLong(d.client, 'POST', '/api/mcp/ask', body, (secs + 30) * 1000);
  } catch (err) {
    if (err && err.code === 'ETIMEDOUT') r = { timeout: true };
    else if (err && err.status === 409 && err.code === 'COMMAND_STOPPED') return printStopped(f, err);
    else throw err;
  }
  if (f.json) printJson(r);
  if (r && r.answer != null) {
    if (!f.json) writeOut(String(r.answer));
    return EXIT.OK;
  }
  if (r && r.timeout) {
    if (!f.json) writeOut('TIMEOUT');
    return EXIT.TIMEOUT;
  }
  if (!f.json) writeOut(`No answer (${(r && (r.error || r.reason)) || 'the question was cancelled'}).`);
  return EXIT.ERROR;
}

const LEVELS = ['info', 'success', 'warning', 'error'];

async function cmdNotify(p) {
  const f = p.flags;
  const message = (await gatherText(p)).trim();
  if (!message) throw usageError('Usage: anywhere notify "message" [--speak]', 'notify');
  const level = f.level ? String(f.level).toLowerCase() : 'info';
  if (LEVELS.indexOf(level) < 0) throw usageError(`--level must be one of ${LEVELS.join(', ')}`, 'notify');
  const d = await getDaemon();
  let r;
  if (d) {
    r = await call(d.client, 'POST', '/api/mcp/notify', { message, level, speak: Boolean(f.speak) }, { timeoutMs: 15000 });
  } else {
    const common = optionalPkg('src/os/common.js');
    if (!common || typeof common.notify !== 'function') throw notRunningError();
    try {
      await common.notify('Claude Anywhere', message);
      r = { ok: true, delivered: true, via: 'os' };
    } catch (err) {
      throw new CliError(/^notification/i.test(err.message) ? err.message : `Notification failed: ${err.message}`, EXIT.ERROR, err.hint);
    }
  }
  if (f.json) printJson(r);
  else if (r && r.delivered) writeOut(`${color.green(sym().ok)} Notified${r.via === 'os' ? ' (OS notification)' : ''}.`);
  else writeOut('Notification queued in the dialog (nobody is looking at it right now).');
  return EXIT.OK;
}

// ------------------------------------------------------------------ commands: computer

const COMPUTER_OPS = ['screenshot', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'windows', 'focus', 'open', 'clipboard', 'cursor', 'screens', 'context', 'capabilities', 'ui-find', 'ocr', 'apps'];

/**
 * Keep the newest `keep` CLI screenshots in run/, and none older than maxAgeMs: bridge mode
 * takes one after every step, and each can show whatever was on screen.
 */
function pruneScreenshots(dir, keep, maxAgeMs = 60 * 60 * 1000) {
  try {
    const now = Date.now();
    const files = fs
      .readdirSync(dir)
      .filter((n) => /^screenshot-.*\.png$/.test(n))
      .map((n) => ({ n, t: fileMtime(path.join(dir, n)) }))
      .sort((a, b) => b.t - a.t);
    for (const f of files.filter((x, i) => i >= keep || now - x.t > maxAgeMs)) {
      try {
        fs.unlinkSync(path.join(dir, f.n));
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) {
    /* ignore */
  }
}

function fileMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (_) {
    return 0;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function parseRegion(v) {
  const parts = String(v).split(/[ ,x]+/).filter(Boolean).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw usageError('--region must be X,Y,WIDTH,HEIGHT in screenshot pixels, e.g. --region 0,0,800,600', 'computer');
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

function parseModifiers(f) {
  const out = [];
  for (const v of [].concat(f.modifiers || []).concat(f.mod || [])) {
    for (const part of String(v).split(/[,+]/)) {
      const t = part.trim().toLowerCase();
      if (t) out.push(t);
    }
  }
  return out;
}

function ownWindow(w, desktop) {
  if (desktop && typeof desktop.isOwnWindow === 'function') return desktop.isOwnWindow(w);
  return String((w && w.title) || '').indexOf('Claude Anywhere') >= 0;
}

function matchWindowsLocal(windows, q, desktop) {
  const lower = (s) => String(s || '').toLowerCase();
  if (q.id != null && String(q.id).trim() !== '') return windows.filter((w) => String(w.id) === String(q.id).trim());
  const t = lower(q.title).trim();
  const a = lower(q.app).trim();
  const pool = windows.filter((w) => !ownWindow(w, desktop));
  let m = pool.filter((w) => (!t || lower(w.title).indexOf(t) >= 0) && (!a || lower(w.app).indexOf(a) >= 0));
  if (!m.length && t && !a) m = pool.filter((w) => lower(w.app).indexOf(t) >= 0);
  if (m.length > 1) {
    const exact = m.filter((w) => (t && lower(w.title) === t) || (!t && a && lower(w.app) === a));
    if (exact.length === 1) return exact;
    const visible = m.filter((w) => !w.minimized);
    if (visible.length === 1) return visible;
  }
  return m;
}

async function openComputer() {
  const osIndex = requirePkg('src/os/index.js', 'Desktop control');
  const computerMod = requirePkg('src/os/computer.js', 'Desktop control');
  const driver = await osIndex.getDriver();
  const config = shared('config').load();
  const daemon = daemonOnce();
  const computer = new computerMod.Computer({ driver, config: config.computer, geometryStore: 'file', guard: makeGuard(daemon) });
  const close = async () => {
    try {
      if (typeof osIndex.resetDriver === 'function') await withTimeout(osIndex.resetDriver(), 5000, 'closing the driver');
      else if (driver && typeof driver.close === 'function') await withTimeout(driver.close(), 5000, 'closing the driver');
    } catch (_) {
      /* ignore */
    }
  };
  // `activity` is what runComputerOp is doing, reported to the dialog afterwards (like the MCP tools).
  return { driver, computer, config, close, daemon, activity: null };
}

function brief(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Show a finished `computer` action in the dialog (tool row, "Claude's view"), as the MCP tools do,
 * so bridge-mode screen work through the CLI is visible. Best effort: never changes output or exit code.
 */
async function reportComputerActivity(env, err) {
  const a = env && env.activity;
  if (!a || (err && (err.usage || err.code === 'PAUSED'))) return;
  try {
    const d = await withTimeout(env.daemon(), 1500, 'finding the daemon');
    if (!d) return;
    const body = Object.assign({}, a, { ok: !err });
    if (err) body.error = brief((err && err.message) || err, 300);
    await d.client.request('POST', '/api/mcp/activity', body, { timeoutMs: 1000 });
  } catch (_) {
    /* the dialog is optional here */
  }
}

async function runComputerOp(op, p, env) {
  const f = p.flags;
  const args = p._.slice(1);
  const { driver, computer, config } = env;
  const display = f.display != null ? toInt(f.display, '--display', 0, 64) : undefined;
  const xy = (i, nx, ny) => {
    if (args[i] === undefined || args[i + 1] === undefined) throw usageError(`computer ${op} needs ${nx} and ${ny}`, 'computer');
    return [toNum(args[i], nx), toNum(args[i + 1], ny)];
  };
  switch (op) {
    case 'screenshot': {
      const region = f.region ? parseRegion(f.region) : undefined;
      env.activity = { tool: 'screenshot', summary: 'Screenshot' };
      const shot = await computer.screenshot({
        display: display == null ? 0 : display,
        region,
        maxWidth: f['max-width'] != null ? toInt(f['max-width'], '--max-width', 16, 10000) : undefined,
        maxHeight: f['max-height'] != null ? toInt(f['max-height'], '--max-height', 16, 10000) : undefined,
      });
      const runDir = shared('paths').runDir();
      const out = f.out ? path.resolve(expandHome(f.out)) : path.join(runDir, `screenshot-${stamp()}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // Owner-only, like the rest of run/: a screenshot can show anything that was on screen.
      fs.writeFileSync(out, shot.png, { mode: 0o600 });
      if (!f.out) {
        try {
          fs.chmodSync(out, 0o600);
        } catch (_) {
          /* Windows */
        }
        pruneScreenshots(runDir, 30);
      }
      env.activity = {
        tool: 'screenshot',
        summary: shot.region
          ? `Zoomed screenshot of display ${shot.display} (${shot.region.width}x${shot.region.height} at ${shot.region.x},${shot.region.y})`
          : `Screenshot of display ${shot.display} (${shot.width}x${shot.height})`,
        image: Buffer.from(shot.png).toString('base64'),
        width: shot.width,
        height: shot.height,
      };
      const res = { path: out, width: shot.width, height: shot.height, display: shot.display, displays: shot.displays, scale: shot.scale, cursor: shot.cursor };
      if (shot.region) res.region = shot.region;
      return res;
    }
    case 'click': {
      const opts = { button: f.button ? String(f.button).toLowerCase() : 'left', clicks: 1, modifiers: parseModifiers(f), display };
      if (f.triple) opts.clicks = 3;
      else if (f.double) opts.clicks = 2;
      if (f.clicks != null) opts.clicks = toInt(f.clicks, '--clicks', 1, 3);
      if (args.length) {
        const c = xy(0, 'X', 'Y');
        opts.x = c[0];
        opts.y = c[1];
      }
      const verb = opts.clicks === 2 ? 'Double-click' : opts.clicks === 3 ? 'Triple-click' : 'Click';
      env.activity = { tool: 'click', summary: `${verb} ${opts.button} ${opts.x != null ? `at (${Math.round(opts.x)}, ${Math.round(opts.y)})` : 'at the mouse position'}` };
      return computer.click(opts);
    }
    case 'move': {
      const c = xy(0, 'X', 'Y');
      env.activity = { tool: 'mouse_move', summary: `Move mouse to (${Math.round(c[0])}, ${Math.round(c[1])})` };
      return computer.moveMouse({ x: c[0], y: c[1], display });
    }
    case 'drag': {
      const a = xy(0, 'X1', 'Y1');
      const b = xy(2, 'X2', 'Y2');
      env.activity = { tool: 'drag', summary: `Drag from (${Math.round(a[0])}, ${Math.round(a[1])}) to (${Math.round(b[0])}, ${Math.round(b[1])})` };
      return computer.drag({ fromX: a[0], fromY: a[1], toX: b[0], toY: b[1], button: f.button ? String(f.button).toLowerCase() : 'left', display });
    }
    case 'scroll': {
      const dir = String(args[0] || '').toLowerCase();
      if (['up', 'down', 'left', 'right'].indexOf(dir) < 0) throw usageError('computer scroll needs a direction: up, down, left or right', 'computer');
      const opts = { direction: dir, amount: args[1] != null ? toInt(args[1], 'AMOUNT', 1, 100) : 3, display };
      if (f.at) {
        opts.x = toNum(f.at[0], '--at X');
        opts.y = toNum(f.at[1], '--at Y');
      }
      env.activity = { tool: 'scroll', summary: `Scroll ${dir} ${opts.amount}${opts.x != null ? ` at (${Math.round(opts.x)}, ${Math.round(opts.y)})` : ''}` };
      return computer.scroll(opts);
    }
    case 'type': {
      const sub = { _: args, rest: p.rest, flags: f };
      const text = await gatherText(sub);
      if (!text) throw usageError('computer type needs the text to type (quote it), or --stdin', 'computer');
      env.activity = { tool: 'type_text', summary: `Type ${Array.from(text).length} chars: "${brief(text, 60)}"` };
      return computer.typeText({ text, method: f.method ? String(f.method).toLowerCase() : 'auto' });
    }
    case 'key': {
      if (!args.length) throw usageError('computer key needs a key or combo, e.g. enter, ctrl+s, primary+shift+p', 'computer');
      const repeat = f.repeat != null ? toInt(f.repeat, '--repeat', 1, 100) : 1;
      env.activity = { tool: 'key', summary: `Press ${args.join(', ')}${repeat > 1 ? ` x${repeat}` : ''}` };
      const results = [];
      for (const combo of args) results.push(await computer.key({ combo, repeat }));
      return results.length === 1 ? results[0] : { ok: true, action: 'keys', presses: results };
    }
    case 'windows': {
      const desktop = optionalPkg('src/context/desktop.js');
      let list = ((await driver.listWindows()) || []).filter((w) => !ownWindow(w, desktop));
      const q = String(f.filter || args.join(' ')).toLowerCase().trim();
      if (q) list = list.filter((w) => String(w.app || '').toLowerCase().indexOf(q) >= 0 || String(w.title || '').toLowerCase().indexOf(q) >= 0);
      return { count: list.length, windows: list };
    }
    case 'focus': {
      const desktop = optionalPkg('src/context/desktop.js');
      const tools = optionalPkg('src/mcp/tools.js');
      const q = { id: f.id, app: f.app, title: f.title };
      if (args.length && q.id == null && q.title == null && q.app == null) q.title = args.join(' ');
      if (q.id == null && !q.title && !q.app) throw usageError('computer focus needs a window: QUERY (title or app), --id, --app or --title', 'computer');
      env.activity = { tool: 'focus_window', summary: `Focus window ${q.id != null ? `id ${q.id}` : [q.app && `app "${q.app}"`, q.title && `title "${q.title}"`].filter(Boolean).join(' ')}` };
      const wins = (await driver.listWindows()) || [];
      const matches = tools && typeof tools.matchWindows === 'function' ? tools.matchWindows(wins, q) : matchWindowsLocal(wins, q, desktop);
      if (!matches.length) {
        const err = new CliError(`No window matches ${JSON.stringify(q)}.`);
        err.data = { open: wins.filter((w) => !ownWindow(w, desktop)).map((w) => ({ id: w.id, app: w.app, title: w.title })) };
        throw err;
      }
      if (matches.length > 1) {
        const err = new CliError(`${matches.length} windows match; pass --id with one of them.`);
        err.data = { candidates: matches.map((w) => ({ id: w.id, app: w.app, title: w.title })) };
        throw err;
      }
      const g = await makeGuard(env.daemon)();
      if (g && g.allowed === false) {
        const err = new CliError(`Paused by the user${g.reason ? `: ${g.reason}` : ''}.`);
        err.code = 'PAUSED';
        throw err;
      }
      const ok = await driver.focusWindow(matches[0].id);
      return { ok: Boolean(ok), window: { id: matches[0].id, app: matches[0].app, title: matches[0].title } };
    }
    case 'open': {
      const target = args.join(' ');
      if (!target) throw usageError('computer open needs a URL, file path or app name', 'computer');
      env.activity = { tool: 'open', summary: `Open ${brief(target, 100)}` };
      const common = requirePkg('src/os/common.js', 'Desktop control');
      const kind = f.kind ? String(f.kind).toLowerCase() : 'auto';
      return common.openTarget(target, { kind, args: p.rest || [], cwd: process.cwd() });
    }
    case 'clipboard': {
      const sub = String(args[0] || 'get').toLowerCase();
      if (sub === 'get') return { text: await driver.clipboardGet() };
      if (sub === 'set') {
        const text = await gatherText({ _: args.slice(1), rest: p.rest, flags: f });
        env.activity = { tool: 'clipboard_set', summary: `Copy ${Array.from(text).length} chars to the clipboard` };
        await driver.clipboardSet(text);
        return { ok: true, chars: Array.from(text).length };
      }
      throw usageError('Usage: anywhere computer clipboard get | clipboard set TEXT', 'computer');
    }
    case 'cursor':
      return computer.cursorPosition();
    case 'screens':
      return computer.screenInfo();
    case 'capabilities':
      return Object.assign({ driver: driver.name }, await driver.capabilities());
    case 'ui-find': {
      if (typeof computer.uiFind !== 'function') throw new CliError('This version cannot read the controls of apps (no accessibility support in the desktop driver).');
      const name = args.join(' ').trim();
      const contains = f.contains != null ? String(f.contains) : '';
      const role = f.role != null ? String(f.role) : '';
      if (!name && !contains && !role) throw usageError('computer ui-find needs a NAME, --contains TEXT or --role ROLE, e.g. computer ui-find "For you" --role tab', 'computer');
      const limit = f.limit != null ? toInt(f.limit, '--limit', 1, 100) : 20;
      let windowId;
      if (f.window != null && String(f.window).trim()) {
        // A window id, or part of its title or app name (as computer focus takes it).
        const desktop = optionalPkg('src/context/desktop.js');
        const tools = optionalPkg('src/mcp/tools.js');
        const wins = (await driver.listWindows()) || [];
        const w = String(f.window).trim();
        let matches = tools && typeof tools.matchWindows === 'function' ? tools.matchWindows(wins, { id: w }) : matchWindowsLocal(wins, { id: w }, desktop);
        if (!matches.length) matches = tools && typeof tools.matchWindows === 'function' ? tools.matchWindows(wins, { title: w }) : matchWindowsLocal(wins, { title: w }, desktop);
        if (!matches.length) {
          const err = new CliError(`No window matches "${w}".`);
          err.data = { open: wins.filter((x) => !ownWindow(x, desktop)).map((x) => ({ id: x.id, app: x.app, title: x.title })) };
          throw err;
        }
        if (matches.length > 1) {
          const err = new CliError(`${matches.length} windows match "${w}"; pass --window with one of their ids.`);
          err.data = { candidates: matches.map((x) => ({ id: x.id, app: x.app, title: x.title })) };
          throw err;
        }
        windowId = String(matches[0].id);
      }
      const list = await computer.uiFind({ windowId, name: name || undefined, text: contains || undefined, role: role || undefined, exact: Boolean(f.exact), limit });
      const out = { count: list.length, window: list.window || null, matches: Array.from(list) };
      if (Array.isArray(list.notes) && list.notes.length) out.notes = list.notes;
      return out;
    }
    case 'ocr': {
      const ocr = requirePkg('src/os/ocr.js', 'Text recognition');
      const region = f.region ? parseRegion(f.region) : undefined;
      const query = args.join(' ').trim();
      if (query) {
        const matches = await ocr.findText(computer, { text: query, display, region, exact: Boolean(f.exact) });
        return { count: matches.length, matches: Array.from(matches) };
      }
      return ocr.readScreenText(computer, { display, region });
    }
    case 'apps': {
      const desktop = requirePkg('src/context/desktop.js', 'Desktop context');
      const q = args.join(' ').toLowerCase().trim();
      let apps = desktop.runningApps((await driver.listWindows()) || [], 200);
      if (q) apps = apps.filter((a) => a.app.toLowerCase().indexOf(q) >= 0);
      const defaultBrowser = await withTimeout(desktop.readDefaultBrowser(), 3000, 'reading the default browser').catch(() => null);
      return { count: apps.length, apps, defaultBrowser };
    }
    case 'context': {
      const desktop = requirePkg('src/context/desktop.js', 'Desktop context');
      const projectDir = f.project ? resolveProject(f.project) : process.cwd();
      const ctx = await desktop.gatherContext({ driver, projectDir, config });
      if (f.text && typeof desktop.formatContext === 'function') return { text: desktop.formatContext(ctx) };
      return ctx;
    }
    default:
      throw usageError(`Unknown computer operation "${op}". Use one of: ${COMPUTER_OPS.join(', ')}`, 'computer');
  }
}

async function cmdComputer(p) {
  const op = String(p._[0] || '').toLowerCase();
  if (!op) throw usageError(`computer needs an operation: ${COMPUTER_OPS.join(', ')}`, 'computer');
  if (COMPUTER_OPS.indexOf(op) < 0) throw usageError(`Unknown computer operation "${op}". Use one of: ${COMPUTER_OPS.join(', ')}`, 'computer');
  let env = null;
  try {
    env = await openComputer();
    const res = await runComputerOp(op, p, env);
    if (op === 'context' && res && typeof res.text === 'string') writeOut(res.text);
    else printJson(res === undefined ? { ok: true } : res);
    await reportComputerActivity(env, res && res.ok === false ? new Error(res.error || 'failed') : null);
    return EXIT.OK;
  } catch (err) {
    if (err && err.usage) throw err;
    const outErr = { ok: false, error: (err && err.message) || String(err) };
    if (err && err.code) outErr.code = err.code;
    if (err && err.hint) outErr.hint = err.hint;
    if (err && err.data) Object.assign(outErr, err.data);
    printJson(outErr);
    await reportComputerActivity(env, err);
    return EXIT.ERROR;
  } finally {
    if (env) await env.close();
  }
}

// ------------------------------------------------------------------ doctor

function claudeEnv() {
  const env = Object.assign({}, process.env);
  let strip = [];
  try {
    strip = shared('config').load().engine.stripEnv || [];
  } catch (_) {
    strip = [];
  }
  for (const k of strip.concat(['CLAUDECODE'])) delete env[k];
  return env;
}

function claudeSpawnSpec(cliPath, args) {
  const engine = optionalPkg('src/daemon/engine-cli.js');
  if (engine && typeof engine.launchSpec === 'function') return engine.launchSpec(cliPath, args);
  const { quoteWinArg } = shared('proc');
  if (/\.(c|m)?js$/i.test(cliPath)) return { command: process.execPath, args: [cliPath].concat(args), shell: false };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) return { command: quoteWinArg(cliPath), args: args.map(quoteWinArg), shell: true };
  return { command: cliPath, args: args.slice(), shell: false };
}

async function locateClaude(config) {
  const engine = optionalPkg('src/daemon/engine-cli.js');
  if (engine && engine.ClaudeCliEngine && typeof engine.ClaudeCliEngine.locate === 'function') {
    return engine.ClaudeCliEngine.locate(config);
  }
  const { which, run } = shared('proc');
  const p = (config.engine && config.engine.claudePath) || process.env.ANYWHERE_CLAUDE_PATH || which('claude');
  if (!p || !fs.existsSync(p)) return null;
  const spec = claudeSpawnSpec(p, ['--version']);
  const r = await run(spec.command, spec.args, { timeoutMs: 5000, shell: spec.shell, env: claudeEnv() });
  const m = String(r.stdout || '').match(/\d+\.\d+\.\d+/);
  return { path: p, version: m ? m[0] : null };
}

const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const WSL_INTEROP_HINT = 'powershell.exe is not reachable from WSL: enable interop ([interop] enabled=true and appendWindowsPath=true in /etc/wsl.conf), then run wsl --shutdown';

/**
 * powershell.exe as WSL reaches it, or null. The daemon opens the dialog in Windows Edge or Chrome
 * through it (UiHost._launchWslApp), so with it a WSL machine needs no Linux browser.
 * @param {object} [uihost] src/daemon/uihost.js, whose own lookup wins when it exports one
 */
function wslPowershell(uihost) {
  if (uihost && typeof uihost.wslPowershellPath === 'function') {
    try {
      return uihost.wslPowershellPath() || null;
    } catch (_) {
      /* fall back to the same lookup here */
    }
  }
  const { which } = shared('proc');
  return which('powershell.exe') || (fs.existsSync(WSL_POWERSHELL) ? WSL_POWERSHELL : null) || which('pwsh.exe');
}

/**
 * The installed copy of the anywhere plugin under ~/.claude/plugins, or null.
 * Claude Code lists installed plugins in plugins/installed_plugins.json ("anywhere@<marketplace>"
 * with an installPath); a marketplace clone or a cache copy left after /plugin uninstall is not an
 * install. Only when that file cannot be read is the folder searched, skipping marketplaces/.
 * @param {string} claudeHomeDir
 * @returns {string|null}
 */
function findPluginInstall(claudeHomeDir) {
  const root = path.join(claudeHomeDir, 'plugins');
  const hasSkill = (dir) => fs.existsSync(path.join(dir, 'skills', 'anywhere', 'SKILL.md'));
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'installed_plugins.json'), 'utf8'));
  } catch (_) {
    manifest = null;
  }
  if (manifest && typeof manifest === 'object') {
    const plugins = manifest.plugins && typeof manifest.plugins === 'object' ? manifest.plugins : manifest;
    for (const key of Object.keys(plugins)) {
      if (key.split('@')[0] !== 'anywhere') continue;
      // Version 2 keeps a list of installs (one per scope), version 1 a single entry.
      const entries = Array.isArray(plugins[key]) ? plugins[key] : [plugins[key]];
      for (const e of entries) {
        const dir = e && typeof e.installPath === 'string' ? e.installPath : null;
        if (dir && hasSkill(dir)) return dir;
      }
    }
    return null;
  }
  return findPluginCopy(root);
}

/** Is the plugin disabled in Claude Code's settings (enabledPlugins "anywhere@…": false)? */
function pluginDisabled(claudeHomeDir) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeHomeDir, 'settings.json'), 'utf8'));
    const enabled = settings && settings.enabledPlugins;
    if (!enabled || typeof enabled !== 'object') return false;
    const keys = Object.keys(enabled).filter((k) => k.split('@')[0] === 'anywhere');
    return keys.length > 0 && keys.every((k) => enabled[k] === false);
  } catch (_) {
    return false;
  }
}

/** Search ~/.claude/plugins for a copy of the anywhere plugin (marketplace clones excluded). */
function findPluginCopy(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || found.length) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
      // A marketplace clone (its source is ".") holds the plugin files without installing them.
      if (depth === 0 && e.name === 'marketplaces') continue;
      const full = path.join(dir, e.name);
      if (e.name === '.claude-plugin') {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(full, 'plugin.json'), 'utf8'));
          if (manifest && manifest.name === 'anywhere' && fs.existsSync(path.join(dir, 'skills', 'anywhere', 'SKILL.md'))) found.push(dir);
        } catch (_) {
          /* not ours */
        }
        continue;
      }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found[0] || null;
}

/**
 * Absolute paths in `claude mcp get anywhere` output ("Command: …", "Args: …/server.js") that are gone.
 * @param {string} out
 * @returns {string[]}
 */
function staleMcpPaths(out) {
  const text = String(out || '');
  const gone = [];
  const command = ((text.match(/^\s*Command:\s*(.+)$/im) || [])[1] || '').trim();
  const args = ((text.match(/^\s*Args:\s*(.+)$/im) || [])[1] || '').trim();
  if (command && path.isAbsolute(command) && !fs.existsSync(command)) gone.push(command);
  if (args && path.isAbsolute(args) && /server\.js$/i.test(args) && !fs.existsSync(args)) gone.push(args);
  return gone;
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.once('error', (err) => resolve(err && err.code === 'EADDRINUSE' ? false : null));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** A driver capabilities() note about app controls (UI automation / the accessibility tree). */
function isUiNote(n) {
  return /\bUI automation\b|force-renderer-accessibility|AXManualAccessibility|accessibility bus/i.test(String(n));
}

/**
 * The 'appcontrols' doctor check: capabilities().ui with its notes, or uiHint as the fix.
 * @returns {{status?:string, detail:string, notes?:string[], fix?:string}}
 */
function appControlsCheck(caps, pinfo) {
  const engine = pinfo.platform === 'darwin' ? 'macOS accessibility API' : pinfo.platform === 'win32' || pinfo.isWSL ? 'UI Automation' : 'AT-SPI';
  const notes = (caps.notes || []).filter((n) => n && isUiNote(n));
  if (caps.ui) return { detail: `${engine}: ui_find, ui_tree, ui_click and ui_set_value work`, notes };
  const fix =
    caps.uiHint ||
    (pinfo.platform === 'linux' && !pinfo.isWSL
      ? 'sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core (Fedora: sudo dnf install python3-gobject at-spi2-core), then log out and in.'
      : pinfo.platform === 'darwin'
        ? 'Grant Accessibility to the app that runs Claude Code (System Settings → Privacy & Security → Accessibility).'
        : '');
  return {
    status: 'warn',
    detail: `${engine} unavailable: Claude clicks by screenshot position and OCR instead`,
    notes,
    fix: fix || 'See the notes above.',
  };
}

/**
 * Run every diagnostic check.
 * @returns {Promise<{ok:boolean, version:string, platform:object, checks:Array<{id,label,status,detail,fix,notes,critical}>}>}
 */
async function runDoctor() {
  const platformMod = shared('platform');
  const paths = shared('paths');
  const configMod = shared('config');
  const pinfo = platformMod.info();
  let config;
  try {
    config = configMod.load();
  } catch (_) {
    config = JSON.parse(JSON.stringify(configMod.DEFAULTS));
  }
  const checks = [];
  const check = async (id, label, critical, fn, ms) => {
    const c = { id, label, status: 'ok', detail: '', fix: '', notes: [], critical: Boolean(critical) };
    try {
      const r = await withTimeout(Promise.resolve().then(fn), ms || 20000, label);
      Object.assign(c, r || {});
    } catch (err) {
      c.status = 'fail';
      c.detail = (err && err.message) || String(err);
      if (err && err.hint) c.fix = err.hint;
    }
    checks.push(c);
    return c;
  };

  await check('node', 'Node.js', true, () => {
    const v = process.versions.node;
    if (nodeAtLeast(MIN_NODE, v)) return { detail: `v${v}` };
    if (nodeAtLeast([18, 0, 0], v)) return { status: 'warn', detail: `v${v} (18.17 or newer is recommended)`, fix: nodeUpgradeHint(pinfo.platform) };
    return { status: 'fail', detail: `v${v} is too old (needs 18.17 or newer)`, fix: nodeUpgradeHint(pinfo.platform) };
  });

  let claude = null;
  await check('claude', 'Claude Code CLI', true, async () => {
    claude = await locateClaude(config);
    if (!claude) {
      return {
        status: 'fail',
        detail: 'not found (needed for the dialog\'s own Claude Code session)',
        fix: `Install Claude Code (npm install -g @anthropic-ai/claude-code, or see https://docs.claude.com/en/docs/claude-code). If it is installed somewhere unusual: ${cliCmd('config set engine.claudePath /full/path/to/claude')}`,
      };
    }
    return { detail: `${claude.version || 'unknown version'} ${sym().dot} ${claude.path}` };
  });

  // Headless Linux (SSH, servers): the terminal dialog plus Claude Code's own tools is a supported setup.
  const headless = pinfo.platform === 'linux' && !pinfo.isWSL && pinfo.displayServer === 'none';
  const headlessFix = `Over SSH use the terminal dialog: ${cliCmd('tui')}. For screen control run inside your desktop session (DISPLAY or WAYLAND_DISPLAY must be set), or start a virtual display: Xvfb :99 -screen 0 1920x1080x24 & export DISPLAY=:99`;
  await check('platform', 'Platform', false, () => {
    const parts = [pinfo.osName, pinfo.arch, `display: ${pinfo.displayServer}${pinfo.isWSL ? ' (Windows desktop via WSL)' : ''}`];
    if (pinfo.desktop) parts.push(pinfo.desktop);
    if (headless) {
      return {
        status: 'warn',
        detail: `${parts.join(` ${sym().dot} `)} (no graphical display)`,
        fix: headlessFix,
      };
    }
    const r = { detail: parts.join(` ${sym().dot} `) };
    if (pinfo.displayServer === 'wayland') r.notes = ['Wayland limits screen control; sway and Hyprland work best, GNOME/KDE need ydotool (see the desktop control notes).'];
    return r;
  });

  const osIndex = optionalPkg('src/os/index.js');
  let caps = null;
  await check(
    'driver',
    'Desktop control',
    true,
    async () => {
      if (!osIndex) return { status: 'fail', detail: 'src/os is missing from this installation', fix: 'Reinstall Claude Anywhere.' };
      if (!headless) return probeDriver();
      // Without a display this is expected, not a blocker: the terminal dialog still works.
      let r;
      try {
        r = await probeDriver();
      } catch (_) {
        r = { status: 'fail' };
      }
      if (r.status !== 'fail') return r;
      return { status: 'warn', detail: 'no graphical display: screen control unavailable', notes: [], fix: headlessFix };
    },
    45000
  );

  /** Load the desktop driver and try each capability (the 'driver' check). */
  async function probeDriver() {
    const driver = await withTimeout(osIndex.getDriver(), 15000, 'loading the desktop driver');
    caps = await withTimeout(driver.capabilities(), 15000, 'reading driver capabilities');
    const s = sym();
    const mark = (b) => (b ? s.ok : s.fail);
    let shot = null;
    let shotErr = null;
    if (caps.screenshot) {
      try {
        const c = await withTimeout(driver.captureDisplay(0), 15000, 'test screenshot');
        shot = `${c.width}x${c.height}`;
      } catch (err) {
        shotErr = err;
      }
    }
    let cursor = null;
    if (caps.mouse) {
      try {
        const pos = await withTimeout(driver.cursorPosition(), 5000, 'reading the cursor');
        cursor = pos && pos.estimated ? 'position unknown (Wayland hides the pointer; the corner failsafe is unavailable)' : `at (${Math.round(pos.x)}, ${Math.round(pos.y)})`;
      } catch (_) {
        cursor = null;
      }
    }
    let displays = null;
    try {
      displays = (await withTimeout(driver.displays(), 8000, 'listing displays')).length;
    } catch (_) {
      displays = null;
    }
    const detail = [
      `${driver.name}`,
      `screenshot ${shot || mark(false)}`,
      displays ? `${displays} display${displays === 1 ? '' : 's'}` : null,
      `mouse ${mark(caps.mouse)}${cursor ? ` ${cursor}` : ''}`,
      `keyboard ${mark(caps.keyboard)}`,
      `windows ${mark(caps.windows)}`,
      `clipboard ${mark(caps.clipboard)}`,
    ]
      .filter(Boolean)
      .join(` ${s.dot} `);
    // Notes about app controls (accessibility) belong to their own check below, not to this one.
    const notes = (caps.notes || []).filter((n) => n && !isUiNote(n));
    if (shotErr) notes.unshift(`Test screenshot failed: ${shotErr.message}${shotErr.hint ? ` (${shotErr.hint})` : ''}`);
    const installNote = notes.filter((n) => /^install|grant |not granted|sudo |brew |winget /i.test(n));
    const fix = driver.hint || installNote[0] || '';
    const rest = notes.filter((n) => n !== fix);
    if (shot && caps.mouse && caps.keyboard) return { detail, notes: rest, fix, status: installNote.length ? 'warn' : 'ok' };
    if (shot || caps.mouse || caps.keyboard) return { status: 'warn', detail, notes: rest, fix: fix || 'See the notes above.' };
    return { status: 'fail', detail: `${detail}${driver.reason ? ` (${driver.reason})` : ''}`, notes: rest, fix: fix || `Run ${cliQ('doctor')} inside your desktop session.` };
  }

  if (pinfo.platform === 'darwin') {
    await check('permissions', 'macOS permissions', false, async () => {
      const perms = caps && caps.permissions;
      if (!perms) return { status: 'warn', detail: 'could not read Accessibility / Screen Recording state' };
      const host = perms.hostApp || 'your terminal app';
      const urls = perms.settings || {};
      const word = (v) => (v === true ? 'granted' : v === false ? 'not granted' : 'unknown');
      const notes = [];
      if (perms.automation !== undefined) notes.push(`Automation (System Events, for typing): ${word(perms.automation)}`);
      // Permissions belong to the app that started a process: a daemon started by the launcher
      // applet, a hotkey or another terminal can differ from this one.
      const running = await daemonPermissions();
      if (running && running.permissions) {
        const dp = running.permissions;
        const dHost = dp.hostApp || 'the app that started it';
        notes.push(`The running daemon (started by ${dHost}): Accessibility ${word(dp.accessibility)} ${sym().dot} Screen Recording ${word(dp.screenRecording)}${dp.automation !== undefined ? ` ${sym().dot} Automation ${word(dp.automation)}` : ''}`);
      }
      const missing = [];
      if (perms.accessibility === false) missing.push('Accessibility');
      if (perms.screenRecording === false) missing.push('Screen Recording');
      const daemonMissing = running && running.permissions ? ['accessibility', 'screenRecording'].filter((k) => running.permissions[k] === false) : [];
      if (!missing.length) {
        const r = { detail: `Accessibility ${word(perms.accessibility)} ${sym().dot} Screen Recording ${word(perms.screenRecording)} (for ${host})`, notes };
        if (daemonMissing.length) {
          r.status = 'warn';
          r.fix = `The running daemon lacks ${daemonMissing.map((k) => (k === 'accessibility' ? 'Accessibility' : 'Screen Recording')).join(' and ')}: grant it to "${(running.permissions.hostApp) || 'the app that started it'}", or restart it from here: ${cliCmd('restart')}`;
        }
        return r;
      }
      return {
        status: 'fail',
        detail: `${missing.join(' and ')} not granted to ${host}`,
        notes,
        fix: `System Settings → Privacy & Security → ${missing.join(' / ')} → enable "${host}", then quit and reopen it. Open the panes: ${missing
          .map((m) => `open "${m === 'Accessibility' ? urls.accessibility || 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' : urls.screenRecording || 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'}"`)
          .join(' ; ')}`,
      };
    });
  }

  // The desktop assistant: app controls through the accessibility API, and on-screen text (OCR).
  // Both are optional: without them Claude works from screenshots and coordinates.
  if (caps && (caps.screenshot || caps.mouse || caps.keyboard)) {
    await check('appcontrols', 'App controls (accessibility)', false, () => appControlsCheck(caps, pinfo));
  }
  await check(
    'ocr',
    'Screen text (OCR)',
    false,
    async () => {
      const ocr = optionalPkg('src/os/ocr.js');
      if (!ocr) return { status: 'warn', detail: 'src/os/ocr.js is missing from this installation', fix: 'Reinstall Claude Anywhere.' };
      const av = await ocr.available();
      const names = { vision: 'Apple Vision', windows: 'Windows OCR', tesseract: 'tesseract' };
      if (av && av.engine) {
        const e = (av.engines || []).find((x) => x && x.engine === av.engine) || {};
        const langs = Array.isArray(e.languages) && e.languages.length ? ` (${e.languages.slice(0, 6).join(', ')}${e.languages.length > 6 ? ', ...' : ''})` : '';
        return { detail: `${names[av.engine] || av.engine}${langs}: find_text, read_screen_text and wait_for {text} work` };
      }
      return {
        status: 'warn',
        detail: 'no OCR engine: find_text and read_screen_text are unavailable (Claude reads screenshots instead)',
        fix: (av && av.hint) || 'Install tesseract (Linux: sudo apt install tesseract-ocr).',
      };
    },
    40000
  );
  if (pinfo.platform === 'linux' && !pinfo.isWSL) {
    await check('desktoptools', 'Desktop assistant tools', false, () => {
      const { which } = shared('proc');
      const s = sym();
      const tools = [
        ['wmctrl', 'closes app windows gently on quit_app (sudo apt install wmctrl)'],
        ['sqlite3', 'reads the current Firefox bookmarks; without it the daily backup is read (sudo apt install sqlite3)'],
        ['gtk-launch', 'launches apps exactly as their menu entry does (sudo apt install libgtk-3-bin)'],
      ];
      const missing = tools.filter(([n]) => !which(n));
      const detail = tools.map(([n]) => `${n} ${which(n) ? s.ok : s.fail}`).join(' ');
      if (!missing.length) return { detail };
      return { detail, notes: missing.map(([n, why]) => `${n}: ${why}`) };
    });
  }

  // Server voice capabilities: the dialog-window advice and the voice check both need them.
  let voicePending = null;
  const voiceCaps = () => {
    if (!voicePending) {
      voicePending = Promise.resolve().then(() => {
        const voiceMod = optionalPkg('src/daemon/voice.js');
        if (!voiceMod) return null;
        return withTimeout(new voiceMod.VoiceService({ config }).capabilities(), 15000, 'voice detection');
      });
    }
    return voicePending;
  };
  const voiceCapsOrNull = () => voiceCaps().catch(() => null);
  const ELECTRON_VOICE = 'Voice input in Electron needs GROQ_API_KEY or OPENAI_API_KEY, or whisper.cpp: browser speech recognition does not work there.';

  let chromeLike = [];
  let electronFound = false;
  let wslPs = null;
  // Chrome and Edge ship a Web Speech service; Chromium, Brave and Vivaldi do not.
  let speechOk = (c) => /chrome|edge/i.test(c.name) && !/chromium/i.test(c.name);
  await check('ui', 'Dialog window', false, async () => {
    const uihost = optionalPkg('src/daemon/uihost.js');
    if (!uihost) return { status: 'warn', detail: 'src/daemon/uihost.js is missing; the URL is printed instead', fix: `Reinstall Claude Anywhere, or use: ${cliCmd('tui')}` };
    let electron = null;
    try {
      electron = uihost.resolveElectron();
    } catch (_) {
      electron = null;
    }
    electronFound = Boolean(electron);
    if (typeof uihost.hasBrowserSpeech === 'function') speechOk = (c) => uihost.hasBrowserSpeech(c);
    try {
      chromeLike = uihost.findChromiumCandidates({ platformInfo: pinfo, profileDir: paths.uiProfileDir() }) || [];
    } catch (_) {
      chromeLike = [];
    }
    // macOS: list (and judge voice by) the browsers in the order the dialog launches them, which
    // prefers one that is not the default link handler.
    if (pinfo.platform === 'darwin' && chromeLike.length && typeof uihost.orderMacCandidates === 'function' && typeof uihost.readMacDefaultBrowserId === 'function') {
      try {
        chromeLike = uihost.orderMacCandidates(chromeLike, await uihost.readMacDefaultBrowserId());
      } catch (_) {
        /* keep the found order */
      }
    }
    // WSL opens the dialog in Windows Edge or Chrome through powershell.exe before any Linux browser.
    if (pinfo.isWSL) wslPs = wslPowershell(uihost);
    let opener = null;
    try {
      opener = (uihost.browserOpenCommands({ platformInfo: pinfo, url: 'http://127.0.0.1/' }) || []).filter((c) => c && c.cmd)[0] || null;
    } catch (_) {
      opener = null;
    }
    const s = sym();
    const apps = (wslPs ? ['Windows Edge/Chrome (via powershell.exe)'] : []).concat(chromeLike.slice(0, 3).map((c) => c.name));
    const detail = [
      `Electron ${electron ? s.ok : s.fail}`,
      `app window: ${apps.length ? apps.join(', ') : 'none'}`,
      `default browser: ${opener ? opener.name : 'none'}`,
      `ui.host = ${config.ui.host}`,
    ].join(` ${s.dot} `);
    const notes = [];
    if (pinfo.isWSL && !wslPs) notes.push(`${WSL_INTEROP_HINT}; until then the dialog cannot open in Windows Edge or Chrome.`);
    if (electron || apps.length) {
      const r = { detail, notes };
      const vc = await voiceCapsOrNull();
      const noServerStt = Boolean(vc && !vc.serverStt);
      if (electron && (config.ui.host === 'auto' || config.ui.host === 'electron')) {
        if (noServerStt) notes.push(`The dialog opens in Electron. ${ELECTRON_VOICE} (Or keep Chrome/Edge speech: ${cliCmd('config set ui.host app')})`);
      } else if (!electron && pinfo.platform === 'darwin' && config.ui.host !== 'browser' && config.ui.host !== 'none') {
        // On macOS the app window is a second instance of the user's browser app (same Dock
        // icon and bundle id), so links and focus can end up in the wrong instance. Electron
        // avoids that but loses browser speech, so this stays optional advice.
        notes.push(`Optional: ${cliQ('install --electron')} gives the dialog its own app, so it stays out of your browser's windows and link handling.${noServerStt ? ` ${ELECTRON_VOICE}` : ''}`);
      } else if (!electron) {
        notes.push(`Optional: ${cliQ('install --electron')} adds an always-on-top window with a global hotkey that hides itself from screenshots.${noServerStt ? ` ${ELECTRON_VOICE}` : ''}`);
      }
      return r;
    }
    if (pinfo.isWSL) return { status: 'warn', detail, notes: [], fix: `${WSL_INTEROP_HINT}, so the dialog opens in Windows Edge or Chrome.` };
    if (opener) return { status: 'warn', detail, notes, fix: `Install Google Chrome, Microsoft Edge, Brave or Chromium for a compact app window, or run: ${cliCmd('install --electron')}` };
    return { status: 'warn', detail, notes, fix: `No browser was found: install Chrome or Edge, run ${cliQ('install --electron')}, or use the terminal dialog: ${cliCmd('tui')}` };
  });

  await check('voice', 'Voice', false, async () => {
    // The auto host tries Electron first, and Electron has no browser speech recognition.
    const inElectron = electronFound && (config.ui.host === 'auto' || config.ui.host === 'electron');
    // The app window uses the first candidate, so that browser decides whether browser speech works.
    const browserStt = !inElectron && (Boolean(wslPs) || (chromeLike.length > 0 && Boolean(chromeLike[0]) && speechOk(chromeLike[0])));
    const sttWhere = inElectron ? 'no browser speech in the Electron window' : browserStt ? 'browser (Chrome/Edge)' : 'no Chrome/Edge for browser speech';
    if (!optionalPkg('src/daemon/voice.js')) return { status: 'warn', detail: `speech-to-text: ${sttWhere} ${sym().dot} server voice module missing` };
    const vc = await voiceCaps();
    const s = sym();
    const piper = vc.piper || null;
    const natural = piper ? `natural voice: ${piper.installed ? `Piper ${s.ok} ${piper.voice}` : `not installed (${cliQ('voice install')})`}` : null;
    const detail = [`speech-to-text: ${sttWhere}`, `server ${vc.serverStt ? vc.sttProvider : 'none'}`, `text-to-speech: ${vc.serverTts ? vc.ttsProvider : 'browser only'}`, natural]
      .filter(Boolean)
      .join(` ${s.dot} `);
    if (vc.serverStt || browserStt) {
      const r = { detail };
      if (!vc.serverStt) r.notes = ['Optional: set GROQ_API_KEY or OPENAI_API_KEY (or install whisper.cpp) so voice also works in Electron, Firefox and the terminal dialog.'];
      if (!vc.serverTts && vc.ttsHint) r.notes = (r.notes || []).concat([vc.ttsHint]);
      return r;
    }
    return {
      status: 'warn',
      detail,
      fix: inElectron
        ? `${ELECTRON_VOICE} Set GROQ_API_KEY (free tier) or OPENAI_API_KEY, install whisper.cpp, or use Chrome/Edge speech: ${cliCmd('config set ui.host app')}`
        : vc.sttHint || 'For voice input set GROQ_API_KEY (free tier) or OPENAI_API_KEY, or install whisper.cpp; or install Chrome/Edge for browser speech recognition.',
    };
  });

  let daemon = null;
  await check('daemon', 'Daemon', false, async () => {
    daemon = await shared('state').findRunningDaemon();
    // The bare address: doctor runs through Claude's Bash tool (/anywhere doctor), so its output
    // lands in the transcript; the token URL would hand anyone who reads it the desktop.
    if (daemon) return { detail: `running ${sym().dot} pid ${daemon.pid} ${sym().dot} ${daemon.mode} mode ${sym().dot} ${daemon.project} ${sym().dot} ${dialogUrl(daemon).url} (${cliQ('url')} prints the full link)` };
    return { detail: `not running (it starts with /anywhere or ${cliQ('start')})` };
  });

  if (!daemon) {
    await check('port', 'Port', false, async () => {
      const port = Number(config.port) || 47120;
      const free = await portFree(port);
      if (free === false) return { status: 'warn', detail: `${port} is in use by another program`, notes: [`The daemon will pick a random free port instead; change it with: ${cliCmd('config set port <n>')}`] };
      return { detail: `127.0.0.1:${port} is free` };
    });
  }

  let plugin = null;
  await check('skill', 'Skill /anywhere', false, () => {
    const home = paths.claudeHome();
    const personal = path.join(home, 'skills', 'anywhere', 'SKILL.md');
    plugin = findPluginInstall(home);
    if (plugin && pluginDisabled(home)) plugin = null;
    if (fs.existsSync(personal)) {
      let same = true;
      try {
        same = fs.readFileSync(personal, 'utf8') === fs.readFileSync(pkgPath(path.join('skills', 'anywhere', 'SKILL.md')), 'utf8');
      } catch (_) {
        same = true;
      }
      if (!same) return { status: 'warn', detail: `personal skill at ${path.dirname(personal)} is out of date`, fix: `Update it: ${cliCmd('install')}` };
      return { detail: `personal skill ${sym().dot} ${path.dirname(personal)}${plugin ? ` ${sym().dot} plugin also installed` : ''}` };
    }
    if (plugin) return { detail: `plugin ${sym().dot} ${plugin} (use /anywhere:anywhere, or /anywhere when unambiguous)` };
    if (findPluginInstall(home)) {
      return { status: 'warn', detail: 'the anywhere plugin is installed but disabled in Claude Code', fix: 'In Claude Code: /plugin enable anywhere@anywhere-marketplace' };
    }
    return {
      status: 'warn',
      detail: 'not installed for Claude Code',
      fix: `Run ${cliQ('install')} (personal skill /anywhere + MCP tools), or in Claude Code: /plugin marketplace add patel-deepanshu/claude-anywhere then /plugin install anywhere@anywhere-marketplace`,
    };
  });

  await check(
    'mcp',
    'MCP tools',
    false,
    async () => {
      if (!claude) return { status: 'warn', detail: 'cannot check without the claude CLI' };
      const spec = claudeSpawnSpec(claude.path, ['mcp', 'get', 'anywhere']);
      const r = await shared('proc').run(spec.command, spec.args, { timeoutMs: 5000, shell: spec.shell, env: claudeEnv(), cwd: os.homedir() });
      if (r.code === 0) {
        const out = String(r.stdout || '');
        const scope = (out.match(/Scope:\s*([^\n]+)/i) || [])[1];
        const status = (out.match(/Status:\s*([^\n]+)/i) || [])[1];
        const detail = `"anywhere" registered${scope ? ` ${sym().dot} ${scope.trim()}` : ''}${status ? ` ${sym().dot} ${status.trim()}` : ''}`;
        const gone = staleMcpPaths(out);
        if (gone.length) {
          return {
            status: 'warn',
            detail: `${detail} ${sym().dot} ${gone.join(' and ')} no longer exist${gone.length === 1 ? 's' : ''} (moved, or removed by an upgrade such as "brew upgrade node")`,
            fix: `Register it again: ${cliCmd('install')}`,
          };
        }
        return { detail };
      }
      if (plugin) return { detail: 'provided by the anywhere plugin (mcp__plugin_anywhere_anywhere__*)' };
      if (r.timedOut) return { status: 'warn', detail: '"claude mcp get anywhere" timed out', fix: `Retry, or register it: ${cliCmd('install')}` };
      return {
        status: 'warn',
        detail: 'the "anywhere" MCP server is not registered (screen tools are unavailable in your own Claude Code sessions; the dialog still works)',
        fix: `Run: ${cliCmd('install')}   (or ${cliCmd('install --no-mcp')} to skip it)`,
      };
    },
    12000
  );

  await check('claudeperms', 'Claude Code allow rules', false, () => {
    const home = paths.claudeHome();
    const project = process.cwd();
    const files = [path.join(home, 'settings.json'), path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')];
    const broad = broadAllowRules(files);
    const notes = ['The dialog\'s engine runs with --permission-mode default, so permissions.defaultMode does not bypass its approvals.'];
    if (!broad.length) return { detail: 'no broad allow rules', notes };
    return {
      status: 'warn',
      detail: broad.map((b) => `${b.rule} (${b.file})`).join(', '),
      notes: ['Allow rules apply before the dialog\'s approval broker, so these commands and tools run without asking.'].concat(notes),
      fix: 'Narrow them in those settings files, e.g. "Bash(npm test:*)" instead of "Bash".',
    };
  });

  await check('config', 'Config', false, () => {
    const file = paths.configPath();
    if (!fs.existsSync(file)) return { detail: `${file} (defaults)` };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const n = Object.keys(parsed || {}).length;
      return { detail: `${file} (${n} section${n === 1 ? '' : 's'} overridden)` };
    } catch (err) {
      return { status: 'warn', detail: `${file} is not valid JSON (${err.message}); defaults are used`, fix: `Fix the file or run: ${cliCmd('config reset')}` };
    }
  });

  await check('tools', 'Command-line tools', false, () => {
    const { which } = shared('proc');
    const names = ['git', 'gcloud', 'aws', 'az', 'kubectl', 'docker', 'gh'];
    const s = sym();
    const have = names.map((n) => `${n} ${which(n) ? s.ok : s.fail}`);
    if (!which('git')) return { status: 'warn', detail: have.join(' '), fix: 'Install git so Claude can read repository state.' };
    return { detail: have.join(' '), notes: ['Cloud CLIs are optional; Claude uses whichever is installed (gcloud for GCP deploys) and falls back to the browser.'] };
  });

  if (osIndex && typeof osIndex.resetDriver === 'function') {
    try {
      await withTimeout(osIndex.resetDriver(), 5000, 'closing the driver');
    } catch (_) {
      /* ignore */
    }
  }
  const ok = !checks.some((c) => c.critical && c.status === 'fail');
  return { ok, version: packageVersion(), platform: pinfo, checks };
}

function tildify(file) {
  const home = os.homedir();
  return home && (file === home || file.startsWith(home + path.sep)) ? `~${file.slice(home.length)}` : file;
}

const BROAD_ALLOW_RE = /^(Bash|Bash\(\s*\*?\s*\)|Bash\(\s*\*\s*:\s*\*\s*\)|PowerShell|PowerShell\(\s*\*?\s*\)|Write|Write\(\s*\*{0,2}\s*\)|Edit|Edit\(\s*\*{0,2}\s*\)|MultiEdit|NotebookEdit|mcp__anywhere(__\*)?|mcp__plugin_anywhere_anywhere(__\*)?|mcp__\*|\*)$/;

/**
 * permissions.allow entries in Claude Code settings files that allow whole tools (Bash,
 * Write, Edit, every anywhere tool...).
 * @param {string[]} files
 * @returns {Array<{rule:string, file:string}>}
 */
function broadAllowRules(files) {
  const out = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue;
    }
    const allow = parsed && parsed.permissions && Array.isArray(parsed.permissions.allow) ? parsed.permissions.allow : [];
    for (const rule of allow) {
      if (typeof rule === 'string' && BROAD_ALLOW_RE.test(rule.trim())) out.push({ rule: rule.trim(), file: tildify(file) });
    }
  }
  return out;
}

/** The running daemon's OS permission state (GET /api/permissions), or null. */
async function daemonPermissions() {
  try {
    const st = await shared('state').findRunningDaemon();
    if (!st) return null;
    const { DaemonClient } = shared('client');
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${st.port}`, token: st.token });
    return await client.request('GET', '/api/permissions', undefined, { timeoutMs: 8000 });
  } catch (_) {
    return null;
  }
}

function renderDoctor(report) {
  const s = sym();
  const lines = [];
  const p = report.platform;
  lines.push(color.bold(`Claude Anywhere doctor ${s.dot} v${report.version} ${s.dot} ${p.osName} (${p.displayServer})`));
  lines.push('');
  const width = Math.max(20, ...report.checks.map((c) => String(c.label).length));
  for (const c of report.checks) {
    const mark = c.status === 'ok' ? color.green(s.ok) : c.status === 'warn' ? color.yellow(s.warn) : color.red(s.fail);
    lines.push(`  ${mark} ${String(c.label).padEnd(width)} ${c.detail}`);
    for (const n of c.notes || []) lines.push(color.dim(`      ${s.dot} ${n}`));
    if (c.fix && c.status !== 'ok') lines.push(`      ${color.cyan('fix:')} ${c.fix}`);
  }
  const fails = report.checks.filter((c) => c.status === 'fail');
  const warns = report.checks.filter((c) => c.status === 'warn');
  lines.push('');
  if (!fails.length && !warns.length) lines.push(color.green(`${s.ok} Everything looks good. Type /anywhere in Claude Code to open the dialog.`));
  else {
    const crit = fails.filter((c) => c.critical).map((c) => c.label);
    lines.push(
      `${fails.length} problem${fails.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'}.` +
        (crit.length ? ` Fix first: ${crit.join(', ')}.` : ' Claude Anywhere can run; the warnings limit some features.')
    );
  }
  return lines.join('\n');
}

async function cmdDoctor(p) {
  const report = await runDoctor();
  if (p.flags.json) printJson(report);
  else writeOut(renderDoctor(report));
  return report.ok ? EXIT.OK : EXIT.ERROR;
}

// ------------------------------------------------------------------ install / config / logs

async function cmdInstall(p) {
  const f = p.flags;
  const installer = requirePkg('scripts/install.js', 'The installer');
  const quiet = Boolean(f.quiet || f.json);
  const hotkeyKey = f['hotkey-key'] != null ? String(f['hotkey-key']) : undefined;
  if (hotkeyKey !== undefined) {
    try {
      installer.parseHotkeyCombo(hotkeyKey);
    } catch (err) {
      throw usageError(err.message, 'install');
    }
  }
  const res = await installer.install({
    electron: Boolean(f.electron),
    mcp: f.mcp !== false,
    hotkey: Boolean(f.hotkey || hotkeyKey),
    hotkeyKey,
    skillDir: f['skill-dir'] ? path.resolve(expandHome(f['skill-dir'])) : undefined,
    quiet,
    print: quiet ? () => {} : (line) => writeOut(line),
  });
  if (process.platform === 'darwin' && !quiet && f.permissions !== false && !(res && res.ok === false)) {
    if (process.stdin.isTTY && process.stdout.isTTY) await askMacPermissions();
    else {
      // No terminal to answer the prompts in (a pipe, the plugin, or `curl | bash` without /dev/tty).
      writeOut('macOS permissions were not requested (no terminal). Grant Accessibility and Screen Recording to the app that runs Claude Code:');
      writeOut('  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
      writeOut('  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"');
      writeOut(`then run ${cliQ('doctor')}.`);
    }
  }
  if (f.json) printJson(res);
  return res && res.ok === false ? EXIT.ERROR : EXIT.OK;
}

/**
 * Show the macOS permission prompts (Accessibility, Screen Recording, Automation for System
 * Events) for the app running this terminal, so they are answered now instead of during the
 * first action. The Automation prompt is modal; this waits up to about two minutes.
 */
async function askMacPermissions() {
  const osIndex = optionalPkg('src/os/index.js');
  if (!osIndex) return;
  writeOut('Asking macOS for Accessibility, Screen Recording and Automation (System Events) access for this app…');
  try {
    const driver = await withTimeout(osIndex.getDriver(), 15000, 'loading the desktop driver');
    if (typeof driver.requestPermissions !== 'function') return;
    const r = (await withTimeout(driver.requestPermissions(), 130000, 'the macOS permission prompts')) || {};
    const word = (v) => (v === true ? 'granted' : v === false ? 'not granted' : 'not answered');
    writeOut(`  Accessibility ${word(r.accessibility)} ${sym().dot} Screen Recording ${word(r.screenRecording)} ${sym().dot} Automation ${word(r.automation)}`);
    if (r.accessibility === false || r.screenRecording === false) {
      writeOut(`  Grant them in System Settings → Privacy & Security, then quit and reopen this app. ${cliQ('doctor')} shows the exact panes.`);
    }
  } catch (err) {
    writeOut(`  Could not ask for permissions (${err.message}). Run ${cliQ('doctor')} later.`);
  } finally {
    if (typeof osIndex.resetDriver === 'function') {
      try {
        await withTimeout(osIndex.resetDriver(), 5000, 'closing the driver');
      } catch (_) {
        /* ignore */
      }
    }
  }
}

async function cmdUninstall(p) {
  const f = p.flags;
  const installer = requirePkg('scripts/install.js', 'The installer');
  const quiet = Boolean(f.quiet || f.json);
  let stopped = null;
  try {
    stopped = await stopDaemon();
  } catch (_) {
    stopped = null;
  }
  const res = await installer.uninstall({ purge: Boolean(f.purge), quiet, print: quiet ? () => {} : (line) => writeOut(line) });
  if (stopped && stopped.stopped && !quiet) writeOut(`Stopped the running daemon (pid ${stopped.pid}).`);
  if (f.json) printJson(Object.assign({ daemonStopped: Boolean(stopped && stopped.stopped) }, res));
  return res && res.ok === false ? EXIT.ERROR : EXIT.OK;
}

const CONFIG_ENUMS = {
  mode: ['companion', 'bridge'],
  'ui.host': UI_HOSTS,
  'ui.theme': ['system', 'light', 'dark'],
  'ui.position': ['right', 'left', 'center'],
  'permissions.mode': ['ask', 'smart', 'auto'],
  'voice.stt': ['auto', 'browser', 'server', 'off'],
  'voice.tts': ['auto', 'browser', 'server', 'off'],
  'voice.sttProvider': ['auto', 'openai', 'groq', 'custom', 'whisper.cpp'],
  'voice.ttsEngine': ['auto', 'piper', 'browser', 'os'],
  'engine.effort': ['', 'low', 'medium', 'high', 'xhigh', 'max'],
};
const SECRET_PATHS = ['voice.sttApiKey', 'jira.apiToken'];
// Read only when the daemon starts or launches the dialog window: saving them changes nothing now.
const STARTUP_ONLY = ['port', 'ui', 'ui.host', 'ui.width', 'ui.height', 'ui.position', 'ui.hotkey', 'ui.hideFromScreenshots', 'ui.openOnStart'];

function configKeys(obj, prefix) {
  const out = [];
  for (const k of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push.apply(out, configKeys(v, full));
    else out.push(full);
  }
  return out;
}

/**
 * Turn a CLI string into a value of the type the setting expects.
 * @param {string} key dotted path
 * @param {string} raw
 */
function coerceForKey(key, raw) {
  const configMod = shared('config');
  const def = configMod.get(configMod.DEFAULTS, key);
  if (def === undefined) {
    const keys = configKeys(configMod.DEFAULTS, '');
    const near = keys.filter((k) => levenshtein(k.toLowerCase(), String(key).toLowerCase()) <= 3 || k.split('.').pop().toLowerCase() === String(key).split('.').pop().toLowerCase());
    throw usageError(`Unknown setting "${key}".${near.length ? ` Did you mean ${near.slice(0, 3).join(', ')}?` : ''} See all settings with: anywhere config`, 'config');
  }
  let value;
  if (def !== null && typeof def === 'object' && !Array.isArray(def)) {
    value = configMod.coerce(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw usageError(`"${key}" is a section; set one of its keys (${Object.keys(def).map((k) => `${key}.${k}`).join(', ')}) or pass a JSON object`, 'config');
    }
  } else if (typeof def === 'string') {
    value = String(raw);
  } else if (typeof def === 'number') {
    value = Number(raw);
    if (String(raw).trim() === '' || !Number.isFinite(value)) throw usageError(`"${key}" must be a number (got "${raw}")`, 'config');
  } else if (typeof def === 'boolean') {
    value = parseBool(raw);
    if (value == null) throw usageError(`"${key}" must be true or false (got "${raw}")`, 'config');
  } else if (Array.isArray(def)) {
    const c = configMod.coerce(raw);
    value = Array.isArray(c) ? c : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    value = configMod.coerce(raw);
  }
  // The dialog labels "auto" as Autopilot; accept that name too.
  if (key === 'permissions.mode' && typeof value === 'string' && value.trim().toLowerCase() === 'autopilot') value = 'auto';
  const allowed = CONFIG_ENUMS[key];
  if (allowed && allowed.indexOf(value) < 0) throw usageError(`"${key}" must be one of ${allowed.filter(Boolean).join(', ')} (got "${raw}")`, 'config');
  if (key === 'port' && (!Number.isInteger(value) || value < 0 || value > 65535)) throw usageError('"port" must be 0..65535', 'config');
  return value;
}

function maskSecrets(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  const configMod = shared('config');
  for (const k of SECRET_PATHS) {
    const v = configMod.get(out, k);
    if (typeof v === 'string' && v) configMod.setPath(out, k, `${v.slice(0, 4)}…(set)`);
  }
  return out;
}

async function cmdConfig(p) {
  const configMod = shared('config');
  const paths = shared('paths');
  const sub = String(p._[0] || 'show').toLowerCase();
  const f = p.flags;
  const show = (v) => (typeof v === 'string' ? writeOut(v) : printJson(v === undefined ? null : v));
  if (sub === 'path') {
    writeOut(paths.configPath());
    return EXIT.OK;
  }
  if (sub === 'show' || sub === 'list') {
    const cfg = configMod.load();
    if (f.json) printJson(f.reveal ? cfg : maskSecrets(cfg));
    else {
      writeOut(color.dim(`# ${paths.configPath()}${fs.existsSync(paths.configPath()) ? '' : ' (not created yet; showing defaults)'}`));
      printJson(f.reveal ? cfg : maskSecrets(cfg));
    }
    return EXIT.OK;
  }
  if (sub === 'get') {
    const key = p._[1];
    const cfg = f.reveal ? configMod.load() : maskSecrets(configMod.load());
    if (!key) {
      printJson(cfg);
      return EXIT.OK;
    }
    const v = configMod.get(cfg, key);
    if (v === undefined) throw usageError(`Unknown setting "${key}"`, 'config');
    show(v);
    return EXIT.OK;
  }
  if (sub === 'set') {
    const key = p._[1];
    if (!key || p._.length < 3) throw usageError('Usage: anywhere config set KEY VALUE (e.g. anywhere config set voice.speakResponses false)', 'config');
    const raw = p._.slice(2).join(' ');
    const value = coerceForKey(key, raw);
    const partial = configMod.setPath({}, key, value);
    configMod.save(partial);
    let live = false;
    let busy = false;
    const d = await getDaemon().catch(() => null);
    if (d) {
      try {
        await d.client.request('POST', '/api/config', partial, { timeoutMs: 5000 });
        // The saved mode is only the start-up default; switch the running dialog too.
        if (key === 'mode') {
          try {
            await d.client.request('POST', '/api/mode', { mode: value }, { timeoutMs: 15000 });
          } catch (err) {
            // 409: a task is running; the switch would stop it, so the dialog keeps its mode for now.
            busy = Boolean(err && err.status === 409);
            throw err;
          }
        }
        live = STARTUP_ONLY.indexOf(key) < 0;
      } catch (_) {
        live = false;
      }
    }
    const shown = SECRET_PATHS.indexOf(key) >= 0 && value ? '(hidden)' : JSON.stringify(value);
    const where = busy
      ? ' (saved; the running dialog keeps its mode while a task runs: switch with its mode button when the task is done)'
      : live
        ? ' (applied to the running dialog)'
        : ` (restart to apply: ${cliCmd('restart')})`;
    if (f.json) printJson({ ok: true, key, value: SECRET_PATHS.indexOf(key) >= 0 ? undefined : value, appliedToRunningDaemon: live, busy: busy || undefined });
    else writeOut(`${color.green(sym().ok)} ${key} = ${shown}${d ? where : ''}`);
    return EXIT.OK;
  }
  if (sub === 'reset') {
    configMod.reset();
    if (f.json) printJson({ ok: true });
    else writeOut(`${color.green(sym().ok)} Settings reset to defaults (${paths.configPath()}). Restart a running dialog to apply: ${cliCmd('restart')}`);
    return EXIT.OK;
  }
  throw usageError(`Unknown config action "${sub}". Use: path, get KEY, set KEY VALUE, reset`, 'config');
}

async function cmdLogs(p) {
  const paths = shared('paths');
  const f = p.flags;
  const file = f.audit ? paths.auditLogPath() : paths.daemonLogPath();
  const n = f.lines != null ? toInt(f.lines, '-n', 1, 100000) : 50;
  if (!fs.existsSync(file) && !f.follow) {
    writeOut(`No ${f.audit ? 'audit log for today' : 'daemon log'} yet (${file}).`);
    return EXIT.OK;
  }
  const lines = fs.existsSync(file) ? tailFile(file, n) : [];
  if (lines.length) writeOut(hideTokens(lines.join('\n')));
  if (!f.follow) return EXIT.OK;
  let offset = fileSize(file);
  const timer = setInterval(() => {
    const size = fileSize(file);
    if (size < offset) offset = 0;
    if (size > offset) {
      const chunk = readFrom(file, offset);
      offset = size;
      if (chunk) process.stdout.write(hideTokens(chunk));
    }
  }, 500);
  const stop = () => {
    clearInterval(timer);
    process.exit(EXIT.OK);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return KEEP_ALIVE;
}

async function cmdTui(p) {
  const tuiMod = requirePkg('src/tui/tui.js', 'The terminal dialog');
  let d = await getDaemon();
  if (!d) {
    const project = p.flags.project ? resolveProject(p.flags.project) : process.cwd();
    writeErr(`${sym().star} Starting Claude Anywhere for ${project}${sym().ell}`);
    await ensureDaemon({ project, mode: validateMode(p.flags.mode), open: false });
    d = await requireDaemon();
  }
  await tuiMod.runTui({ client: d.client });
  return EXIT.OK;
}

async function cmdMcp() {
  const server = requirePkg('src/mcp/server.js', 'The MCP server');
  await server.main();
  return KEEP_ALIVE;
}

function cmdVersion(p) {
  const v = packageVersion();
  if (p && p.flags && p.flags.json) printJson({ name: 'claude-anywhere', version: v, node: process.versions.node, platform: process.platform, arch: process.arch, packageRoot: PACKAGE_ROOT });
  else writeOut(`Claude Anywhere ${v} (node ${process.versions.node}, ${process.platform}-${process.arch})`);
  return EXIT.OK;
}

// ------------------------------------------------------------------ command table and help

const COMMON = { boolean: ['help', 'json'], alias: { h: 'help' } };

function spec(extra) {
  const e = extra || {};
  return {
    string: (e.string || []).slice(),
    boolean: COMMON.boolean.concat(e.boolean || []),
    multi: (e.multi || []).slice(),
    pair: (e.pair || []).slice(),
    alias: Object.assign({}, COMMON.alias, e.alias || {}),
  };
}

const COMMANDS = {
  start: {
    run: cmdStart,
    group: 'Dialog',
    summary: 'Start (or reuse) the daemon and open the dialog',
    usage: 'anywhere start [--project DIR] [--mode companion|bridge] [--switch] [--ui auto|electron|app|browser|tui|none] [--no-open] [--show-token] [--foreground] [--json]',
    details: [
      'Reuses a running daemon: switches its project and mode if they differ, then brings the dialog to the front.',
      'Otherwise starts the daemon in the background (log: ~/.claude-anywhere/logs/daemon.log) and waits up to 15 s for it.',
      '--foreground runs the daemon in this terminal instead (Ctrl+C stops it).',
      'A busy dialog (a task running, an approval or question waiting) keeps its project and mode; --switch stops that task and switches.',
      'Without --mode, a dialog left in bridge mode with no Claude Code terminal listening goes back to companion mode.',
      'The URL with the access token is printed (and in --json) only when no window could open, with --no-open, or with --show-token; `anywhere url` prints it any time.',
    ],
    spec: spec({ string: ['project', 'mode', 'ui', 'timeout', 'port'], boolean: ['open', 'foreground', 'switch', 'show-token'], alias: { p: 'project' } }),
  },
  stop: { run: cmdStop, group: 'Dialog', summary: 'Stop the daemon and close the dialog', usage: 'anywhere stop [--json]', spec: spec() },
  restart: {
    run: cmdRestart,
    group: 'Dialog',
    summary: 'Stop and start again (keeps the project and mode)',
    usage: 'anywhere restart [start options]',
    spec: spec({ string: ['project', 'mode', 'ui', 'timeout', 'port'], boolean: ['open', 'foreground', 'show-token'], alias: { p: 'project' } }),
  },
  status: {
    run: cmdStatus,
    group: 'Dialog',
    summary: 'Show whether the dialog runs, and what it is doing',
    usage: 'anywhere status [--json] [--show-token]',
    details: ['The dialog URL is printed without its access token (with --show-token it is included); `anywhere url` prints the full link.'],
    spec: spec({ boolean: ['show-token'] }),
  },
  show: {
    run: cmdShow,
    group: 'Dialog',
    summary: 'Bring the dialog to the front (starts it if needed)',
    usage: 'anywhere show [--project DIR]',
    details: ['--launcher (used by the macOS "Claude Anywhere" app) starts a stopped dialog from Terminal, so it keeps the permissions granted to Terminal.'],
    spec: spec({ string: ['project'], boolean: ['launcher'] }),
  },
  url: { run: cmdUrl, group: 'Dialog', summary: 'Print the dialog URL (with its access token)', usage: 'anywhere url [--json]', spec: spec() },
  tui: { run: cmdTui, group: 'Dialog', summary: 'Terminal version of the dialog (SSH, headless)', usage: 'anywhere tui [--project DIR]', spec: spec({ string: ['project', 'mode'] }) },
  send: {
    run: cmdSend,
    group: 'Talk to Claude',
    summary: 'Send a task to the dialog (starts it if needed)',
    usage: 'anywhere send <text…> [--screenshot | --no-screenshot] [--image FILE]… [--wait [--timeout SEC]] [--stdin] [--project DIR [--switch]] [--no-start]',
    details: [
      '--project DIR sends the task to the dialog for that folder; a dialog busy in another folder refuses unless --switch stops its task.',
      '--screenshot attaches the current screen and --no-screenshot never does (default: context.attachScreenshotByDefault); --wait prints the final answer (companion mode).',
      'Text that starts with "-" goes after "--": anywhere send -- "-v flag fails"',
    ],
    spec: spec({ string: ['timeout', 'source', 'project'], boolean: ['screenshot', 'wait', 'stdin', 'start', 'open', 'switch'], multi: ['image'] }),
  },
  interrupt: { run: cmdInterrupt, group: 'Talk to Claude', summary: 'Stop the task Claude is working on', usage: 'anywhere interrupt', spec: spec() },
  ask: {
    run: cmdAsk,
    group: 'Talk to Claude',
    summary: 'Ask the user a question in the dialog and print the answer',
    usage: 'anywhere ask <question…> [--options "Yes,No"] [--timeout SEC] [--json]',
    details: [
      'Prints the answer and exits 0; prints TIMEOUT and exits 2 if nobody answers (default 540 s).',
      'Bridge mode: prints STOPPED and exits 5 when the user pressed Stop on the command being worked on.',
    ],
    spec: spec({ string: ['timeout'], multi: ['options', 'option'], boolean: ['stdin'] }),
  },
  notify: {
    run: cmdNotify,
    group: 'Talk to Claude',
    summary: 'Show a notification in the dialog (or the OS)',
    usage: 'anywhere notify <text…> [--speak] [--level info|success|warning|error]',
    spec: spec({ string: ['level'], boolean: ['speak', 'stdin'] }),
  },
  listen: {
    run: cmdListen,
    group: 'Bridge mode',
    summary: 'Wait for the next command from the dialog',
    usage: 'anywhere listen [--timeout SEC] [--json]',
    details: [
      'Prints "===ANYWHERE COMMAND <id>===", the text, a <desktop_context> block and [images: …] and exits 0.',
      'Prints TIMEOUT and exits 2 after --timeout seconds (default 540, max 590); prints STOP and exits 3 when the loop should end.',
      'A command the user stopped in the dialog: reply and ask print STOPPED and exit 5; abandon it and run listen again.',
    ],
    spec: spec({ string: ['timeout'] }),
  },
  reply: {
    run: cmdReply,
    group: 'Bridge mode',
    summary: 'Show progress or the final answer in the dialog',
    usage: 'anywhere reply <text…> [--final] [--no-speak] [--stdin]',
    details: [
      'Prints STOP and exits 3 when the dialog has left bridge mode (the /anywhere here loop should end).',
      'Prints STOPPED and exits 5 when the user pressed Stop on this command: abandon it, send nothing more, run listen again.',
    ],
    spec: spec({ boolean: ['final', 'speak', 'stdin'] }),
  },
  computer: {
    run: cmdComputer,
    group: 'Desktop control',
    summary: 'Screenshots, mouse, keyboard, windows (prints JSON)',
    usage: 'anywhere computer <op> …',
    details: [
      'screenshot [--display N] [--out FILE] [--region X,Y,W,H]   writes a PNG and prints {path,width,height,…}',
      'click X Y [--button left|right|middle] [--double] [--modifiers ctrl,shift]',
      'move X Y | drag X1 Y1 X2 Y2 | scroll up|down|left|right [AMOUNT] [--at X Y]',
      'type TEXT [--method auto|keys|paste] [--stdin] | key COMBO… [--repeat N]',
      'windows [--filter S] | focus QUERY | focus --id ID | open TARGET [--kind url|path|app] [-- ARGS]',
      'clipboard get | clipboard set TEXT | cursor | screens | capabilities | context [--text]',
      'ui-find NAME [--role R] [--contains TEXT] [--window W] [--exact] [--limit N]   app controls (accessibility) with their screenshot position',
      'ocr [TEXT] [--display N] [--region X,Y,W,H] [--exact]   find TEXT on screen, or read all text | apps [QUERY]   running apps, default browser',
      'Coordinates are pixels of the most recent screenshot of that display.',
    ],
    spec: spec({
      string: ['display', 'out', 'region', 'button', 'clicks', 'method', 'repeat', 'filter', 'id', 'app', 'title', 'kind', 'max-width', 'max-height', 'project', 'role', 'contains', 'window', 'limit'],
      multi: ['modifiers', 'mod'],
      boolean: ['double', 'triple', 'stdin', 'text', 'exact'],
      pair: ['at'],
    }),
  },
  doctor: { run: cmdDoctor, group: 'Setup', summary: 'Check this machine and print fixes', usage: 'anywhere doctor [--json]', spec: spec() },
  install: {
    run: cmdInstall,
    group: 'Setup',
    summary: 'Install the /anywhere skill, MCP tools and optional extras',
    usage: 'anywhere install [--electron] [--no-mcp] [--hotkey [--hotkey-key COMBO]] [--skill-dir DIR] [--no-permissions] [--quiet] [--json]',
    details: [
      '--electron downloads Electron (~100 MB) for an always-on-top window with a global hotkey.',
      '--hotkey adds an OS shortcut that shows the dialog: Ctrl+Alt+F12 on Windows and WSL, Ctrl+Alt+A on GNOME; macOS gets an app to bind in Shortcuts.',
      '--hotkey-key picks another shortcut (two of Ctrl, Alt, Shift plus A-Z, 0-9 or F1-F24), e.g. --hotkey-key Ctrl+Shift+F9.',
      'On macOS, an interactive install shows the Accessibility, Screen Recording and Automation prompts up front; --no-permissions skips them.',
    ],
    spec: spec({ string: ['skill-dir', 'hotkey-key'], boolean: ['electron', 'mcp', 'hotkey', 'quiet', 'permissions'] }),
  },
  uninstall: { run: cmdUninstall, group: 'Setup', summary: 'Remove the skill, MCP registration and shortcuts', usage: 'anywhere uninstall [--purge] [--json]', details: ['--purge also deletes ~/.claude-anywhere (settings, logs, Electron).'], spec: spec({ boolean: ['purge', 'quiet'] }) },
  config: {
    run: cmdConfig,
    group: 'Setup',
    summary: 'Show or change settings',
    usage: 'anywhere config [path | get KEY | set KEY VALUE | reset] [--json] [--reveal]',
    details: ['Examples: anywhere config set permissions.mode ask · anywhere config set engine.claudePath /usr/local/bin/claude · anywhere config set voice.sttProvider groq'],
    spec: spec({ boolean: ['reveal'] }),
  },
  logs: { run: cmdLogs, group: 'Setup', summary: 'Show the daemon log (or today\'s audit log)', usage: 'anywhere logs [--audit] [-n N] [-f]', spec: spec({ string: ['lines'], boolean: ['audit', 'follow'], alias: { n: 'lines', f: 'follow' } }) },
  mcp: { run: cmdMcp, group: 'Setup', summary: 'Run the MCP stdio server (used by Claude Code)', usage: 'anywhere mcp', spec: spec() },
  daemon: {
    run: cmdDaemon,
    group: 'internal',
    summary: 'Run the daemon in the foreground (internal)',
    usage: 'anywhere daemon [--project DIR] [--mode M] [--ui HOST] [--no-open] [--port N]',
    spec: spec({ string: ['project', 'mode', 'ui', 'port'], boolean: ['open'], alias: { p: 'project' } }),
  },
  version: { run: cmdVersion, group: 'Setup', summary: 'Print the version', usage: 'anywhere version [--json]', spec: spec() },
  help: { run: null, group: 'Setup', summary: 'Show help for a command', usage: 'anywhere help [command]', spec: spec() },
};

// Feature command modules (src/cli/<name>.js) export commands(helpers) -> { name: {run, group, summary, usage, spec} }.
for (const name of ['voice', 'jira', 'clone', 'calls', 'desktop']) {
  let mod = null;
  try {
    mod = require(path.join(__dirname, '..', 'src', 'cli', `${name}.js`));
  } catch (err) {
    if (!(err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`${name}.js`))) throw err;
  }
  if (mod && typeof mod.commands === 'function') {
    Object.assign(COMMANDS, mod.commands({ spec, shared, call, requireDaemon, ensureDaemon, writeOut, writeErr, printJson, sym, color, EXIT }));
  }
}

const ALIASES = { open: 'show', ui: 'show', cancel: 'interrupt', log: 'logs', '-v': 'version', '--version': 'version', '-V': 'version' };

function helpText() {
  const v = packageVersion();
  return `Claude Anywhere ${v}: a floating, voice-enabled dialog that lets Claude Code see and operate your desktop.

Usage
  anywhere <command> [options]
  anywhere "<task>"                  start the dialog if needed, then hand it the task

Dialog
  start [--project DIR] [--mode companion|bridge] [--ui HOST] [--no-open] [--foreground] [--json]
  stop | restart | status [--json] | show | url
  tui                                terminal version of the dialog (SSH or headless machines)

Talk to Claude
  send <text…> [--screenshot] [--image FILE] [--wait]
  interrupt                          stop the task Claude is working on
  ask <question…> [--options a,b,c] [--timeout SEC]
  notify <text…> [--speak] [--level info|success|warning|error]

Bridge mode (your interactive Claude Code session does the work: /anywhere here)
  listen [--timeout SEC] [--json]    wait for the next dialog command
  reply <text…> [--final] [--no-speak]

Desktop control (prints JSON; X Y are pixels of the latest screenshot)
  computer screenshot [--display N] [--out FILE] [--region X,Y,W,H]
  computer click X Y [--button B] [--double] | move X Y | drag X1 Y1 X2 Y2
  computer scroll up|down|left|right [AMOUNT] [--at X Y]
  computer type TEXT | key COMBO [--repeat N]       e.g. key primary+s, key enter
  computer windows [--filter S] | focus QUERY | open TARGET
  computer clipboard get|set [TEXT] | cursor | screens | capabilities | context
  computer ui-find NAME [--role R] | ocr [TEXT] | apps [QUERY]   app controls, screen text, running apps
  desktop apps [Q] | launch NAME | quit NAME | bookmarks [Q] [--browser B] [--folder bar]
  desktop open-url URL | tabs [--cycle] | switch-tab TEXT|--index N | window Q --state S | wait --window W|--text T

Setup
  doctor [--json]                    check this machine and print exact fixes
  install [--electron] [--no-mcp] [--hotkey] | uninstall [--purge]
  config [path | get KEY | set KEY VALUE | reset]
  voice install [ID] | list | use ID | test | status | remove ID   free natural voice (Piper, offline)
  jira setup | test | status | issue KEY | mine | search JQL | remove   connect Jira (free API token) for ticket work
  logs [--audit] [-n N] [-f]
  mcp                                MCP stdio server (Claude Code starts this)
  version | help [command]

Examples
  anywhere start --project ~/code/shop-api
  anywhere "VS Code has my repo open and GCP is open in Chrome. Deploy this repo to Cloud Run."
  anywhere computer screenshot --out ./screen.png
  anywhere computer click 640 360 --double
  anywhere ask "Deploy to production?" --options "Yes,No"
  anywhere config set permissions.mode ask
  anywhere install --hotkey --electron

Exit codes
  0  success (listen: a command was printed)      1  error or bad usage
  2  listen/ask timed out                         3  listen: stop requested
  4  Claude Anywhere is not running               5  reply/ask: the user stopped this command
  130  interrupted

Environment
  ANYWHERE_HOME (state dir, default ~/.claude-anywhere) · ANYWHERE_DAEMON_URL + ANYWHERE_TOKEN (target daemon)
  ANYWHERE_DRIVER (auto|mock|x11|wayland|win32|wsl|darwin|none) · ANYWHERE_DEBUG=1 · NO_COLOR · ANYWHERE_ASCII=1 · ANYWHERE_UNICODE=1

Docs and issues: ${REPO_URL}`;
}

function commandHelp(name) {
  const c = COMMANDS[name];
  if (!c) return helpText();
  const lines = [`${c.summary}.`, '', `Usage: ${c.usage}`];
  if (c.details && c.details.length) {
    lines.push('');
    for (const d of c.details) lines.push(`  ${d}`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ main

/**
 * Run the CLI.
 * @param {string[]} argv arguments after `node anywhere.js`
 * @returns {Promise<number|symbol>} exit code, or KEEP_ALIVE for long-running commands
 */
async function main(argv) {
  const args = (argv || []).slice();
  if (!args.length) {
    writeOut(helpText());
    return EXIT.OK;
  }
  const first = args[0];
  if (first === 'help' || first === '--help' || first === '-h') {
    const topic = args[1] && (ALIASES[args[1]] || args[1]);
    writeOut(topic && COMMANDS[topic] ? commandHelp(topic) : helpText());
    return EXIT.OK;
  }
  const name = ALIASES[first] || first;
  const cmd = COMMANDS[name];
  if (!cmd) {
    if (first.indexOf('-') === 0 && first !== '-') {
      writeErr(helpText());
      writeErr(`\nUnknown option "${first}".`);
      return EXIT.ERROR;
    }
    const typo = looksLikeTypo(args);
    if (typo) {
      writeErr(helpText());
      writeErr(`\nUnknown command "${first}". Did you mean "${typo}"?`);
      return EXIT.ERROR;
    }
    // Convenience: `anywhere "deploy this"` starts the dialog if needed and sends the text.
    const sendSpec = COMMANDS.send.spec;
    const parsed = parseArgs(args, sendSpec);
    if (parsed.unknown.length) throw usageError(`Unknown option ${parsed.unknown[0]} (put the task in quotes, or after "--")`, 'send');
    return cmdSend(parsed, { source: 'cli' });
  }
  const parsed = parseArgs(args.slice(1), cmd.spec);
  if (parsed.flags.help) {
    writeOut(commandHelp(name));
    return EXIT.OK;
  }
  if (parsed.unknown.length) throw usageError(`Unknown option ${parsed.unknown.join(', ')} for "${name}"`, name);
  return cmd.run(parsed);
}

function reportError(err) {
  const s = sym();
  if (err && err.name === 'CliError') {
    writeErr(`${color.red(s.fail, process.stderr)} ${err.message}`);
    if (err.hint) writeErr(`  ${err.hint}`);
    return err.exitCode;
  }
  writeErr(`${color.red(s.fail, process.stderr)} ${(err && err.message) || err}`);
  if (err && err.hint) writeErr(`  ${err.hint}`);
  if (process.env.ANYWHERE_DEBUG === '1' && err && err.stack) writeErr(err.stack);
  else writeErr(`  Run ${cliQ('doctor')} to check this machine (set ANYWHERE_DEBUG=1 for a stack trace).`);
  return EXIT.ERROR;
}

async function cli(argv) {
  let code;
  try {
    code = await main(argv);
  } catch (err) {
    code = reportError(err);
  }
  if (code === KEEP_ALIVE) return;
  await flushStreams();
  process.exit(typeof code === 'number' ? code : EXIT.OK);
}

if (require.main === module) {
  if (!nodeAtLeast([18, 0, 0])) {
    process.stderr.write(
      `Claude Anywhere needs Node.js 18.17 or newer (this is ${process.version}).\n` +
        `Upgrade: ${nodeUpgradeHint(process.platform)}\n`
    );
    process.exit(EXIT.ERROR);
  }
  cli(process.argv.slice(2));
}

module.exports = {
  EXIT,
  KEEP_ALIVE,
  COMMANDS,
  CliError,
  parseArgs,
  parseBool,
  closestCommand,
  looksLikeTypo,
  levenshtein,
  formatCommand,
  hotkeyLabel,
  hostLabel,
  coerceForKey,
  nodeAtLeast,
  versionTuple,
  matchWindowsLocal,
  findPluginInstall,
  helpText,
  commandHelp,
  runDoctor,
  renderDoctor,
  isUiNote,
  appControlsCheck,
  ensureDaemon,
  stopDaemon,
  daemonIdentity,
  cmdlineMatchesRecorded,
  looksLikeDaemon,
  parseEtime,
  busyReason,
  waitForResult,
  startSummary,
  pruneScreenshots,
  CANCEL_REASONS,
  samePath,
  pluginDisabled,
  cliCommand,
  daemonPath,
  staleMcpPaths,
  broadAllowRules,
  STARTUP_ONLY,
  main,
};
