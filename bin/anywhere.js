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
const EXIT = Object.freeze({ OK: 0, ERROR: 1, TIMEOUT: 2, STOP: 3, NOT_RUNNING: 4, INTERRUPTED: 130 });

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
  const err = new CliError(message, EXIT.ERROR, `Run "anywhere help${command ? ` ${command}` : ''}" for usage.`);
  err.usage = true;
  return err;
}

function notRunningError(extra, hint) {
  return new CliError(
    `Claude Anywhere is not running.${extra ? ` ${extra}` : ''}`,
    EXIT.NOT_RUNNING,
    hint === undefined ? 'Start it with /anywhere in Claude Code, or run: anywhere start' : hint
  );
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
      `Update or reinstall Claude Anywhere (${REPO_URL}), then run: anywhere doctor`
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

function useUnicode() {
  if (process.env.ANYWHERE_ASCII === '1') return false;
  return process.env.TERM !== 'dumb';
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

function samePath(a, b) {
  if (!a || !b) return false;
  const x = path.resolve(String(a));
  const y = path.resolve(String(b));
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
  return { client: new DaemonClient({ baseUrl: `http://127.0.0.1:${st.port}`, token: st.token }), state: st };
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
      throw new CliError('The daemon rejected the access token.', EXIT.ERROR, 'Restart it: anywhere stop && anywhere start');
    }
    if (err && err.status) {
      const hint = err.data && err.data.hint;
      throw new CliError(`Claude Anywhere: ${err.message} (HTTP ${err.status})`, EXIT.ERROR, hint);
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

/** Guard for CLI input actions: honours the dialog's pause (Stop button) when a daemon runs. */
function makeGuard() {
  let pending = null;
  return async () => {
    if (!pending) pending = getDaemon().catch(() => null);
    const d = await pending;
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
 * Reuse the running daemon (switching project and mode as asked) or spawn a
 * detached one and wait until it answers /api/health.
 * @param {{project:string, mode?:string, ui?:string, open?:boolean, timeoutMs?:number, waitHost?:boolean}} opts
 * @returns {Promise<{state:object, reused:boolean, host:string|null, notes:string[], pid:number}>}
 */
async function ensureDaemon(opts) {
  const project = opts.project;
  const mode = opts.mode;
  const open = opts.open !== false;
  const stateMod = shared('state');
  const paths = shared('paths');
  const { DaemonClient } = shared('client');
  const notes = [];

  const running = await stateMod.findRunningDaemon();
  if (running) {
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${running.port}`, token: running.token });
    if (project && !samePath(running.project, project)) {
      try {
        await call(client, 'POST', '/api/project', { dir: project }, { timeoutMs: 30000 });
        notes.push(`switched the project to ${project}`);
      } catch (err) {
        notes.push(`could not switch the project to ${project}: ${err.message}`);
      }
    }
    if (mode && running.mode !== mode) {
      try {
        await call(client, 'POST', '/api/mode', { mode }, { timeoutMs: 15000 });
        notes.push(`switched to ${mode} mode`);
      } catch (err) {
        notes.push(`could not switch to ${mode} mode: ${err.message}`);
      }
    }
    if (opts.ui) notes.push('--ui only applies when the daemon starts (run "anywhere restart --ui ..." to change it)');
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
    return { state: Object.assign({}, running, fresh), reused: true, host, notes, pid: running.pid };
  }

  const logFile = paths.daemonLogPath();
  const offset = fileSize(logFile);
  const args = [BIN_PATH, 'daemon', '--project', project];
  if (mode) args.push('--mode', mode);
  if (opts.ui) args.push('--ui', opts.ui);
  if (!open) args.push('--no-open');
  if (opts.port != null) args.push('--port', String(opts.port));
  const env = Object.assign({}, process.env, { ANYWHERE_LOG_FILE: '1' });
  delete env.ANYWHERE_DAEMON_URL;
  delete env.ANYWHERE_TOKEN;
  delete env.ANYWHERE_ROLE;
  const { spawnDetached } = shared('proc');
  let child;
  try {
    child = spawnDetached(process.execPath, args, { cwd: isDir(project) ? project : os.homedir(), env, logFile });
  } catch (err) {
    throw new CliError(`Could not start the Claude Anywhere daemon: ${err.message}`, EXIT.ERROR, 'Run: anywhere doctor');
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
    const tail = lastLines(readFrom(logFile, offset), 25) || tailFile(logFile, 25).join('\n');
    const err = new CliError(
      `Claude Anywhere did not start: ${why}.${tail ? `\n--- daemon log (${logFile}) ---\n${tail}\n---` : `\nLog: ${logFile}`}`,
      EXIT.ERROR,
      'Run "anywhere doctor" to check this machine, or "anywhere start --foreground" to see the daemon output directly.'
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
      const how = exited.error ? exited.error.message : `the daemon exited with code ${exited.code}${exited.signal ? ` (${exited.signal})` : ''}`;
      throw failure(how);
    }
    await sleep(200);
  }
  throw failure(`no answer within ${Math.round(timeoutMs / 1000)} s`);
}

function startSummary(res, config, { mode: requestedMode } = {}) {
  const s = sym();
  const st = res.state || {};
  const mode = st.mode || requestedMode || config.mode || 'companion';
  const host = res.host;
  const lines = [];
  const dialog = host === undefined ? 'not opened' : hostLabel(host);
  lines.push(`${color.bold(`${s.star} Claude Anywhere is running`)} ${s.dot} dialog: ${dialog} ${s.dot} project: ${st.project || '?'} ${s.dot} mode: ${mode}`);
  if (res.reused) lines.push(color.dim(`  (reused the daemon that was already running, pid ${st.pid})`));
  for (const n of res.notes || []) lines.push(color.dim(`  ${s.dot} ${n}`));
  lines.push(`  URL      ${st.url || `http://127.0.0.1:${st.port}/`}`);
  const install = readInstallInfo();
  const osHotkey = install && install.hotkey && install.hotkey.installed ? install.hotkey.label || null : null;
  if (host === 'electron') {
    lines.push(`  Hotkey   ${hotkeyLabel(config.ui && config.ui.hotkey)} shows or hides the dialog`);
  } else if (osHotkey) {
    lines.push(`  Hotkey   ${osHotkey} (OS shortcut) brings the dialog back`);
  }
  if (host === 'none') {
    lines.push('  Note     No window could be opened here. Open the URL above in a browser, or run "anywhere tui" in a terminal.');
  } else if (host === null) {
    lines.push('  Note     The dialog window is still opening; if it does not appear, run "anywhere show".');
  }
  if (mode === 'bridge') {
    lines.push('  Next     Commands from the dialog go to the Claude Code session that runs "anywhere listen".');
    lines.push('           Loop: anywhere listen  →  do the work  →  anywhere reply --final "summary".');
  } else {
    lines.push('  Next     Type or talk (mic button; hold Space to talk) in the dialog. Claude works in the project above.');
  }
  lines.push(`           "anywhere show" brings the dialog back ${s.dot} "anywhere stop" (or /anywhere stop) quits.`);
  return lines.join('\n');
}

function startJson(res, config, requestedMode) {
  const st = res.state || {};
  const install = readInstallInfo();
  return {
    ok: true,
    running: true,
    reused: Boolean(res.reused),
    pid: st.pid || null,
    port: st.port || null,
    url: st.url || null,
    project: st.project || null,
    mode: st.mode || requestedMode || config.mode,
    host: res.host === undefined ? null : res.host,
    hotkey: res.host === 'electron' ? hotkeyLabel(config.ui && config.ui.hotkey) : install && install.hotkey && install.hotkey.installed ? install.hotkey.label || null : null,
    version: st.version || packageVersion(),
    logFile: shared('paths').daemonLogPath(),
    notes: res.notes || [],
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
  if (f.foreground) return runDaemonForeground({ project, mode, ui, open, port: f.port, announce: true });
  const timeoutMs = f.timeout ? toInt(f.timeout, '--timeout', 1, 600) * 1000 : START_TIMEOUT_MS;
  const res = await ensureDaemon({ project, mode, ui, open, timeoutMs, port: f.port });
  if (!open) res.host = undefined;
  if (f.json) printJson(startJson(res, config, mode));
  else writeOut(startSummary(res, config, { mode }));
  return EXIT.OK;
}

async function runDaemonForeground({ project, mode, ui, open, port, announce }) {
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
      if (announce) throw new CliError(err.message, EXIT.ERROR, 'Stop it first: anywhere stop');
      writeErr(err.message);
      return EXIT.OK;
    }
    throw err;
  }
  if (announce && d) writeErr(`${sym().star} Claude Anywhere is running in the foreground at ${d.url} (Ctrl+C stops it).`);
  return KEEP_ALIVE;
}

async function cmdDaemon(p) {
  const f = p.flags;
  const project = f.project ? path.resolve(expandHome(f.project)) : process.cwd();
  return runDaemonForeground({ project, mode: validateMode(f.mode), ui: validateUi(f.ui), open: f.open !== false, port: f.port, announce: false });
}

/** Best effort: does this pid look like a Claude Anywhere daemon? true/false, or null when unknown. */
async function looksLikeDaemon(pid) {
  const { run } = shared('proc');
  try {
    if (process.platform === 'linux') {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      return /anywhere|claude-anywhere-daemon|daemon[\\/]main\.js/.test(cmd);
    }
    if (process.platform === 'darwin') {
      const r = await run('ps', ['-p', String(pid), '-o', 'command='], { timeoutMs: 3000 });
      if (r.code !== 0) return null;
      return /anywhere|claude-anywhere-daemon|node/.test(r.stdout);
    }
    if (process.platform === 'win32') {
      const r = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 5000 });
      if (r.code !== 0) return null;
      return /node/i.test(r.stdout);
    }
  } catch (_) {
    return null;
  }
  return null;
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
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {
    /* already gone */
  }
  if (await waitDead(3000)) return 'SIGTERM';
  if (process.platform === 'win32') {
    await shared('proc').run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (_) {
      /* already gone */
    }
  }
  return (await waitDead(3000)) ? 'SIGKILL' : null;
}

/** Stop the daemon. @returns {Promise<{stopped:boolean, pid:number|null, how:string}>} */
async function stopDaemon() {
  const stateMod = shared('state');
  const { DaemonClient } = shared('client');
  const st = await stateMod.findRunningDaemon();
  if (!st) {
    const raw = stateMod.readDaemonState();
    if (raw && raw.pid && stateMod.isPidAlive(raw.pid) && raw.pid !== process.pid && (await looksLikeDaemon(raw.pid)) !== false) {
      const how = await killPid(raw.pid);
      stateMod.clearDaemonState();
      return { stopped: Boolean(how), pid: raw.pid, how: how ? `unresponsive daemon killed (${how})` : 'could not kill the unresponsive daemon' };
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
  if (p.flags.json) printJson(Object.assign({ ok: r.how !== 'still running' }, r));
  else if (r.how === 'not running') writeOut('Claude Anywhere is not running.');
  else if (r.stopped) writeOut(`${color.green(sym().ok)} Claude Anywhere stopped (pid ${r.pid}${r.how !== 'shutdown' ? `, ${r.how}` : ''}).`);
  else throw new CliError(`Could not stop Claude Anywhere (pid ${r.pid}).`, EXIT.ERROR, `Kill the process manually (pid ${r.pid}).`);
  return EXIT.OK;
}

async function cmdRestart(p) {
  const prev = shared('state').readDaemonState();
  await stopDaemon();
  if (!p.flags.project && prev && prev.project && isDir(prev.project)) p.flags.project = prev.project;
  if (!p.flags.mode && prev && prev.mode) p.flags.mode = prev.mode;
  return cmdStart(p);
}

async function cmdStatus(p) {
  const d = await getDaemon();
  if (!d) {
    if (p.flags.json) printJson({ running: false });
    else writeOut('Claude Anywhere is not running. Start it with /anywhere in Claude Code, or: anywhere start');
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
    printJson({ running: true, pid: st.pid || null, port: st.port || null, url: st.url || null, startedAt: st.startedAt || null, state: slim });
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
  if (st.url) lines.push(`  Dialog    ${st.url}`);
  const v = snap.voice || {};
  lines.push(`  Voice     speech-to-text: ${v.serverStt ? v.sttProvider : 'browser only'} ${s.dot} text-to-speech: ${v.serverTts ? v.ttsProvider : 'browser only'}`);
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

async function cmdShow(p) {
  const d = await getDaemon();
  if (!d) {
    const project = p.flags.project ? resolveProject(p.flags.project) : lastProject();
    const config = shared('config').load();
    const res = await ensureDaemon({ project, open: true });
    if (p.flags.json) printJson(startJson(res, config));
    else writeOut(startSummary(res, config));
    return EXIT.OK;
  }
  const r = await call(d.client, 'POST', '/api/show', {}, { timeoutMs: 25000 });
  if (p.flags.json) {
    printJson(Object.assign({ url: d.state.url || null }, r));
    return EXIT.OK;
  }
  if (r && r.host && r.host !== 'none') writeOut(`${color.green(sym().ok)} Dialog shown (${hostLabel(r.host)}).`);
  else writeOut(`No dialog window could be opened${r && r.error ? ` (${r.error})` : ''}. Open ${d.state.url || 'the dialog URL'} in a browser, or run: anywhere tui`);
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

function waitForResult(client, commandId, timeoutMs) {
  return new Promise((resolve) => {
    const seenUser = new Set();
    let ours = false;
    let assistantText = '';
    let timer = null;
    const sub = client.subscribe((type, data) => {
      if (type === 'message' && data && data.role === 'user') {
        seenUser.add(data.id);
        if (data.id === commandId.value) ours = true;
      }
      if (!ours && commandId.value && seenUser.has(commandId.value)) ours = true;
      if (!ours) return;
      if (type === 'message' && data && data.role === 'assistant' && data.text && !data.streaming) assistantText = data.text;
      if (type === 'result') {
        clearTimeout(timer);
        sub.close();
        resolve({ result: data, text: (data && data.text) || assistantText });
      }
    });
    timer = setTimeout(() => {
      sub.close();
      resolve({ timeout: true, text: assistantText });
    }, timeoutMs);
  });
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
  }
  const body = { text, source: f.source || (opts && opts.source) || 'cli' };
  if (f.screenshot) body.attachScreenshot = true;
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
  if (!waiting) {
    if (f.json) printJson({ ok: true, id: r.id, started: Boolean(started) });
    else {
      if (started) writeOut(`${sym().star} Started Claude Anywhere for ${started.state.project} (${started.state.url}).`);
      writeOut(`${color.green(sym().ok)} Sent to Claude Anywhere (command ${r.id}). Follow along in the dialog.`);
    }
    return EXIT.OK;
  }
  const res = await waiting;
  if (f.json) printJson(Object.assign({ ok: !res.timeout, id: r.id }, res));
  else if (res.timeout) writeOut('TIMEOUT');
  else writeOut(res.text || '(no text in the result)');
  if (res.timeout) return EXIT.TIMEOUT;
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
  if (!d) throw notRunningError('', 'Start the dialog in bridge mode with /anywhere here (or: anywhere start --mode bridge).');
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
  await call(d.client, 'POST', '/api/bridge/reply', { text, final: Boolean(f.final), speak: f.speak !== false }, { timeoutMs: 15000 });
  if (f.json) printJson({ ok: true, final: Boolean(f.final) });
  else if (f.final) writeOut(`${color.green(sym().ok)} Final reply shown in the dialog. Run "listen" again for the next command.`);
  else writeOut(`${color.green(sym().ok)} Progress shown in the dialog.`);
  return EXIT.OK;
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

const COMPUTER_OPS = ['screenshot', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'windows', 'focus', 'open', 'clipboard', 'cursor', 'screens', 'context', 'capabilities'];

function pruneScreenshots(dir, keep) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((n) => /^screenshot-.*\.png$/.test(n))
      .map((n) => ({ n, t: fileMtime(path.join(dir, n)) }))
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(keep)) {
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
  const computer = new computerMod.Computer({ driver, config: config.computer, geometryStore: 'file', guard: makeGuard() });
  const close = async () => {
    try {
      if (typeof osIndex.resetDriver === 'function') await withTimeout(osIndex.resetDriver(), 5000, 'closing the driver');
      else if (driver && typeof driver.close === 'function') await withTimeout(driver.close(), 5000, 'closing the driver');
    } catch (_) {
      /* ignore */
    }
  };
  return { driver, computer, config, close };
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
      const shot = await computer.screenshot({
        display: display == null ? 0 : display,
        region,
        maxWidth: f['max-width'] != null ? toInt(f['max-width'], '--max-width', 16, 10000) : undefined,
        maxHeight: f['max-height'] != null ? toInt(f['max-height'], '--max-height', 16, 10000) : undefined,
      });
      const runDir = shared('paths').runDir();
      const out = f.out ? path.resolve(expandHome(f.out)) : path.join(runDir, `screenshot-${stamp()}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, shot.png);
      if (!f.out) pruneScreenshots(runDir, 30);
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
      return computer.click(opts);
    }
    case 'move': {
      const c = xy(0, 'X', 'Y');
      return computer.moveMouse({ x: c[0], y: c[1], display });
    }
    case 'drag': {
      const a = xy(0, 'X1', 'Y1');
      const b = xy(2, 'X2', 'Y2');
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
      return computer.scroll(opts);
    }
    case 'type': {
      const sub = { _: args, rest: p.rest, flags: f };
      const text = await gatherText(sub);
      if (!text) throw usageError('computer type needs the text to type (quote it), or --stdin', 'computer');
      return computer.typeText({ text, method: f.method ? String(f.method).toLowerCase() : 'auto' });
    }
    case 'key': {
      if (!args.length) throw usageError('computer key needs a key or combo, e.g. enter, ctrl+s, primary+shift+p', 'computer');
      const repeat = f.repeat != null ? toInt(f.repeat, '--repeat', 1, 100) : 1;
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
      const g = await makeGuard()();
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
      const common = requirePkg('src/os/common.js', 'Desktop control');
      const kind = f.kind ? String(f.kind).toLowerCase() : 'auto';
      return common.openTarget(target, { kind, args: p.rest || [], cwd: process.cwd() });
    }
    case 'clipboard': {
      const sub = String(args[0] || 'get').toLowerCase();
      if (sub === 'get') return { text: await driver.clipboardGet() };
      if (sub === 'set') {
        const text = await gatherText({ _: args.slice(1), rest: p.rest, flags: f });
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
    return EXIT.OK;
  } catch (err) {
    if (err && err.usage) throw err;
    const outErr = { ok: false, error: (err && err.message) || String(err) };
    if (err && err.code) outErr.code = err.code;
    if (err && err.hint) outErr.hint = err.hint;
    if (err && err.data) Object.assign(outErr, err.data);
    printJson(outErr);
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

/** Look for an installed copy of the anywhere plugin under ~/.claude/plugins. */
function findPluginInstall(claudeHomeDir) {
  const root = path.join(claudeHomeDir, 'plugins');
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

function portFree(port) {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.once('error', (err) => resolve(err && err.code === 'EADDRINUSE' ? false : null));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
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
        fix: 'Install Claude Code (npm install -g @anthropic-ai/claude-code, or see https://docs.claude.com/en/docs/claude-code). If it is installed somewhere unusual: anywhere config set engine.claudePath /full/path/to/claude',
      };
    }
    return { detail: `${claude.version || 'unknown version'} ${sym().dot} ${claude.path}` };
  });

  await check('platform', 'Platform', false, () => {
    const parts = [pinfo.osName, pinfo.arch, `display: ${pinfo.displayServer}${pinfo.isWSL ? ' (Windows desktop via WSL)' : ''}`];
    if (pinfo.desktop) parts.push(pinfo.desktop);
    if (pinfo.platform === 'linux' && !pinfo.isWSL && pinfo.displayServer === 'none') {
      return {
        status: 'warn',
        detail: `${parts.join(` ${sym().dot} `)} (no graphical display)`,
        fix: 'Run Claude Anywhere inside your desktop session (DISPLAY or WAYLAND_DISPLAY must be set), or start a virtual display: Xvfb :99 -screen 0 1920x1080x24 & export DISPLAY=:99. Over SSH use: anywhere tui',
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
          cursor = `(${Math.round(pos.x)}, ${Math.round(pos.y)})`;
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
        `mouse ${mark(caps.mouse)}${cursor ? ` at ${cursor}` : ''}`,
        `keyboard ${mark(caps.keyboard)}`,
        `windows ${mark(caps.windows)}`,
        `clipboard ${mark(caps.clipboard)}`,
      ]
        .filter(Boolean)
        .join(` ${s.dot} `);
      const notes = (caps.notes || []).filter(Boolean);
      if (shotErr) notes.unshift(`Test screenshot failed: ${shotErr.message}${shotErr.hint ? ` (${shotErr.hint})` : ''}`);
      const installNote = notes.filter((n) => /^install|grant |not granted|sudo |brew |winget /i.test(n));
      const fix = driver.hint || installNote[0] || '';
      const rest = notes.filter((n) => n !== fix);
      if (shot && caps.mouse && caps.keyboard) return { detail, notes: rest, fix, status: installNote.length ? 'warn' : 'ok' };
      if (shot || caps.mouse || caps.keyboard) return { status: 'warn', detail, notes: rest, fix: fix || 'See the notes above.' };
      return { status: 'fail', detail: `${detail}${driver.reason ? ` (${driver.reason})` : ''}`, notes: rest, fix: fix || 'Run "anywhere doctor" inside your desktop session.' };
    },
    45000
  );

  if (pinfo.platform === 'darwin') {
    await check('permissions', 'macOS permissions', false, () => {
      const perms = caps && caps.permissions;
      if (!perms) return { status: 'warn', detail: 'could not read Accessibility / Screen Recording state' };
      const host = perms.hostApp || 'your terminal app';
      const urls = perms.settings || {};
      const missing = [];
      if (perms.accessibility === false) missing.push('Accessibility');
      if (perms.screenRecording === false) missing.push('Screen Recording');
      if (!missing.length) return { detail: `Accessibility ${perms.accessibility === true ? 'granted' : 'unknown'} ${sym().dot} Screen Recording ${perms.screenRecording === true ? 'granted' : 'unknown'} (for ${host})` };
      return {
        status: 'fail',
        detail: `${missing.join(' and ')} not granted to ${host}`,
        fix: `System Settings → Privacy & Security → ${missing.join(' / ')} → enable "${host}", then quit and reopen it. Open the panes: ${missing
          .map((m) => `open "${m === 'Accessibility' ? urls.accessibility || 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' : urls.screenRecording || 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'}"`)
          .join(' ; ')}`,
      };
    });
  }

  let chromeLike = [];
  await check('ui', 'Dialog window', false, () => {
    const uihost = optionalPkg('src/daemon/uihost.js');
    if (!uihost) return { status: 'warn', detail: 'src/daemon/uihost.js is missing; the URL is printed instead', fix: 'Reinstall Claude Anywhere, or use: anywhere tui' };
    let electron = null;
    try {
      electron = uihost.resolveElectron();
    } catch (_) {
      electron = null;
    }
    try {
      chromeLike = uihost.findChromiumCandidates({ platformInfo: pinfo, profileDir: paths.uiProfileDir() }) || [];
    } catch (_) {
      chromeLike = [];
    }
    let opener = null;
    try {
      opener = (uihost.browserOpenCommands({ platformInfo: pinfo, url: 'http://127.0.0.1/' }) || []).filter((c) => c && c.cmd)[0] || null;
    } catch (_) {
      opener = null;
    }
    const s = sym();
    const detail = [
      `Electron ${electron ? s.ok : s.fail}`,
      `app window: ${chromeLike.length ? chromeLike.slice(0, 3).map((c) => c.name).join(', ') : 'none'}`,
      `default browser: ${opener ? opener.name : 'none'}`,
      `ui.host = ${config.ui.host}`,
    ].join(` ${s.dot} `);
    if (electron || chromeLike.length) {
      const r = { detail };
      if (!electron) r.notes = ['Optional: "anywhere install --electron" adds an always-on-top window with a global hotkey that hides itself from screenshots.'];
      return r;
    }
    if (opener) return { status: 'warn', detail, fix: 'Install Google Chrome, Microsoft Edge, Brave or Chromium for a compact app window, or run: anywhere install --electron' };
    return { status: 'warn', detail, fix: 'No browser was found: install Chrome or Edge, run "anywhere install --electron", or use the terminal dialog: anywhere tui' };
  });

  await check('voice', 'Voice', false, async () => {
    const voiceMod = optionalPkg('src/daemon/voice.js');
    const browserStt = chromeLike.filter((c) => /chrome|edge/i.test(c.name) && !/chromium/i.test(c.name)).length > 0;
    if (!voiceMod) return { status: 'warn', detail: `browser speech: ${browserStt ? 'Chrome/Edge' : 'unavailable'} ${sym().dot} server voice module missing` };
    const vs = new voiceMod.VoiceService({ config });
    const vc = await withTimeout(vs.capabilities(), 15000, 'voice detection');
    const s = sym();
    const detail = [
      `speech-to-text: ${browserStt ? 'browser (Chrome/Edge)' : 'no Chrome/Edge for browser speech'}`,
      `server ${vc.serverStt ? vc.sttProvider : 'none'}`,
      `text-to-speech: ${vc.serverTts ? vc.ttsProvider : 'browser only'}`,
    ].join(` ${s.dot} `);
    if (vc.serverStt || browserStt) {
      const r = { detail };
      if (!vc.serverStt) r.notes = ['Optional: set GROQ_API_KEY or OPENAI_API_KEY (or install whisper.cpp) so voice also works in Electron, Firefox and the terminal dialog.'];
      if (!vc.serverTts && vc.ttsHint) r.notes = (r.notes || []).concat([vc.ttsHint]);
      return r;
    }
    return {
      status: 'warn',
      detail,
      fix: vc.sttHint || 'For voice input set GROQ_API_KEY (free tier) or OPENAI_API_KEY, or install whisper.cpp; or install Chrome/Edge for browser speech recognition.',
    };
  });

  let daemon = null;
  await check('daemon', 'Daemon', false, async () => {
    daemon = await shared('state').findRunningDaemon();
    if (daemon) return { detail: `running ${sym().dot} pid ${daemon.pid} ${sym().dot} ${daemon.mode} mode ${sym().dot} ${daemon.project} ${sym().dot} ${daemon.url}` };
    return { detail: 'not running (it starts with /anywhere or "anywhere start")' };
  });

  if (!daemon) {
    await check('port', 'Port', false, async () => {
      const port = Number(config.port) || 47120;
      const free = await portFree(port);
      if (free === false) return { status: 'warn', detail: `${port} is in use by another program`, notes: ['The daemon will pick a random free port instead; change it with: anywhere config set port <n>'] };
      return { detail: `127.0.0.1:${port} is free` };
    });
  }

  let plugin = null;
  await check('skill', 'Skill /anywhere', false, () => {
    const home = paths.claudeHome();
    const personal = path.join(home, 'skills', 'anywhere', 'SKILL.md');
    plugin = findPluginInstall(home);
    if (fs.existsSync(personal)) {
      let same = true;
      try {
        same = fs.readFileSync(personal, 'utf8') === fs.readFileSync(pkgPath(path.join('skills', 'anywhere', 'SKILL.md')), 'utf8');
      } catch (_) {
        same = true;
      }
      if (!same) return { status: 'warn', detail: `personal skill at ${path.dirname(personal)} is out of date`, fix: 'Update it: anywhere install' };
      return { detail: `personal skill ${sym().dot} ${path.dirname(personal)}${plugin ? ` ${sym().dot} plugin also installed` : ''}` };
    }
    if (plugin) return { detail: `plugin ${sym().dot} ${plugin} (use /anywhere:anywhere, or /anywhere when unambiguous)` };
    return {
      status: 'warn',
      detail: 'not installed for Claude Code',
      fix: 'Run "anywhere install" (personal skill /anywhere + MCP tools), or in Claude Code: /plugin marketplace add patel-deepanshu/claude-anywhere then /plugin install anywhere@anywhere-marketplace',
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
        return { detail: `"anywhere" registered${scope ? ` ${sym().dot} ${scope.trim()}` : ''}${status ? ` ${sym().dot} ${status.trim()}` : ''}` };
      }
      if (plugin) return { detail: 'provided by the anywhere plugin (mcp__plugin_anywhere_anywhere__*)' };
      if (r.timedOut) return { status: 'warn', detail: '"claude mcp get anywhere" timed out', fix: 'Retry, or register it: anywhere install' };
      return {
        status: 'warn',
        detail: 'the "anywhere" MCP server is not registered (screen tools are unavailable in your own Claude Code sessions; the dialog still works)',
        fix: 'Run: anywhere install   (or anywhere install --no-mcp to skip it)',
      };
    },
    12000
  );

  await check('config', 'Config', false, () => {
    const file = paths.configPath();
    if (!fs.existsSync(file)) return { detail: `${file} (defaults)` };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const n = Object.keys(parsed || {}).length;
      return { detail: `${file} (${n} section${n === 1 ? '' : 's'} overridden)` };
    } catch (err) {
      return { status: 'warn', detail: `${file} is not valid JSON (${err.message}); defaults are used`, fix: 'Fix the file or run: anywhere config reset' };
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

function renderDoctor(report) {
  const s = sym();
  const lines = [];
  const p = report.platform;
  lines.push(color.bold(`Claude Anywhere doctor ${s.dot} v${report.version} ${s.dot} ${p.osName} (${p.displayServer})`));
  lines.push('');
  for (const c of report.checks) {
    const mark = c.status === 'ok' ? color.green(s.ok) : c.status === 'warn' ? color.yellow(s.warn) : color.red(s.fail);
    lines.push(`  ${mark} ${(c.label + '                    ').slice(0, 20)} ${c.detail}`);
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
  const res = await installer.install({
    electron: Boolean(f.electron),
    mcp: f.mcp !== false,
    hotkey: Boolean(f.hotkey),
    skillDir: f['skill-dir'] ? path.resolve(expandHome(f['skill-dir'])) : undefined,
    quiet,
    print: quiet ? () => {} : (line) => writeOut(line),
  });
  if (f.json) printJson(res);
  return res && res.ok === false ? EXIT.ERROR : EXIT.OK;
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
  'engine.effort': ['', 'low', 'medium', 'high', 'xhigh', 'max'],
};
const SECRET_PATHS = ['voice.sttApiKey'];

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
    const d = await getDaemon().catch(() => null);
    if (d) {
      try {
        await d.client.request('POST', '/api/config', partial, { timeoutMs: 5000 });
        live = true;
      } catch (_) {
        live = false;
      }
    }
    const shown = SECRET_PATHS.indexOf(key) >= 0 && value ? '(hidden)' : JSON.stringify(value);
    if (f.json) printJson({ ok: true, key, value: SECRET_PATHS.indexOf(key) >= 0 ? undefined : value, appliedToRunningDaemon: live });
    else writeOut(`${color.green(sym().ok)} ${key} = ${shown}${d ? (live ? ' (applied to the running dialog)' : ' (restart to apply: anywhere restart)') : ''}`);
    return EXIT.OK;
  }
  if (sub === 'reset') {
    configMod.reset();
    if (f.json) printJson({ ok: true });
    else writeOut(`${color.green(sym().ok)} Settings reset to defaults (${paths.configPath()}). Restart a running dialog to apply: anywhere restart`);
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
  if (lines.length) writeOut(lines.join('\n'));
  if (!f.follow) return EXIT.OK;
  let offset = fileSize(file);
  const timer = setInterval(() => {
    const size = fileSize(file);
    if (size < offset) offset = 0;
    if (size > offset) {
      const chunk = readFrom(file, offset);
      offset = size;
      if (chunk) process.stdout.write(chunk);
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
    usage: 'anywhere start [--project DIR] [--mode companion|bridge] [--ui auto|electron|app|browser|tui|none] [--no-open] [--foreground] [--json]',
    details: [
      'Reuses a running daemon: switches its project and mode if they differ, then brings the dialog to the front.',
      'Otherwise starts the daemon in the background (log: ~/.claude-anywhere/logs/daemon.log) and waits up to 15 s for it.',
      '--foreground runs the daemon in this terminal instead (Ctrl+C stops it).',
    ],
    spec: spec({ string: ['project', 'mode', 'ui', 'timeout', 'port'], boolean: ['open', 'foreground'], alias: { p: 'project' } }),
  },
  stop: { run: cmdStop, group: 'Dialog', summary: 'Stop the daemon and close the dialog', usage: 'anywhere stop [--json]', spec: spec() },
  restart: {
    run: cmdRestart,
    group: 'Dialog',
    summary: 'Stop and start again (keeps the project and mode)',
    usage: 'anywhere restart [start options]',
    spec: spec({ string: ['project', 'mode', 'ui', 'timeout', 'port'], boolean: ['open', 'foreground'], alias: { p: 'project' } }),
  },
  status: { run: cmdStatus, group: 'Dialog', summary: 'Show whether the dialog runs, and what it is doing', usage: 'anywhere status [--json]', spec: spec() },
  show: { run: cmdShow, group: 'Dialog', summary: 'Bring the dialog to the front (starts it if needed)', usage: 'anywhere show [--project DIR]', spec: spec({ string: ['project'] }) },
  url: { run: cmdUrl, group: 'Dialog', summary: 'Print the dialog URL (with its access token)', usage: 'anywhere url [--json]', spec: spec() },
  tui: { run: cmdTui, group: 'Dialog', summary: 'Terminal version of the dialog (SSH, headless)', usage: 'anywhere tui [--project DIR]', spec: spec({ string: ['project', 'mode'] }) },
  send: {
    run: cmdSend,
    group: 'Talk to Claude',
    summary: 'Send a task to the dialog (starts it if needed)',
    usage: 'anywhere send <text…> [--screenshot] [--image FILE]… [--wait [--timeout SEC]] [--stdin] [--no-start]',
    details: ['--screenshot attaches the current screen; --wait prints the final answer (companion mode).', 'Text that starts with "-" goes after "--": anywhere send -- "-v flag fails"'],
    spec: spec({ string: ['timeout', 'source', 'project'], boolean: ['screenshot', 'wait', 'stdin', 'start', 'open'], multi: ['image'] }),
  },
  interrupt: { run: cmdInterrupt, group: 'Talk to Claude', summary: 'Stop the task Claude is working on', usage: 'anywhere interrupt', spec: spec() },
  ask: {
    run: cmdAsk,
    group: 'Talk to Claude',
    summary: 'Ask the user a question in the dialog and print the answer',
    usage: 'anywhere ask <question…> [--options "Yes,No"] [--timeout SEC] [--json]',
    details: ['Prints the answer and exits 0; prints TIMEOUT and exits 2 if nobody answers (default 540 s).'],
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
    ],
    spec: spec({ string: ['timeout'] }),
  },
  reply: {
    run: cmdReply,
    group: 'Bridge mode',
    summary: 'Show progress or the final answer in the dialog',
    usage: 'anywhere reply <text…> [--final] [--no-speak] [--stdin]',
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
      'Coordinates are pixels of the most recent screenshot of that display.',
    ],
    spec: spec({
      string: ['display', 'out', 'region', 'button', 'clicks', 'method', 'repeat', 'filter', 'id', 'app', 'title', 'kind', 'max-width', 'max-height', 'project'],
      multi: ['modifiers', 'mod'],
      boolean: ['double', 'triple', 'stdin', 'text'],
      pair: ['at'],
    }),
  },
  doctor: { run: cmdDoctor, group: 'Setup', summary: 'Check this machine and print fixes', usage: 'anywhere doctor [--json]', spec: spec() },
  install: {
    run: cmdInstall,
    group: 'Setup',
    summary: 'Install the /anywhere skill, MCP tools and optional extras',
    usage: 'anywhere install [--electron] [--no-mcp] [--hotkey] [--skill-dir DIR] [--quiet] [--json]',
    details: ['--electron downloads Electron (~100 MB) for an always-on-top window with a global hotkey.', '--hotkey adds an OS shortcut (Ctrl+Alt+A) that shows the dialog.'],
    spec: spec({ string: ['skill-dir'], boolean: ['electron', 'mcp', 'hotkey', 'quiet'] }),
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

Setup
  doctor [--json]                    check this machine and print exact fixes
  install [--electron] [--no-mcp] [--hotkey] | uninstall [--purge]
  config [path | get KEY | set KEY VALUE | reset]
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
  4  Claude Anywhere is not running               130  interrupted

Environment
  ANYWHERE_HOME (state dir, default ~/.claude-anywhere) · ANYWHERE_DAEMON_URL + ANYWHERE_TOKEN (target daemon)
  ANYWHERE_DRIVER (auto|mock|x11|wayland|win32|wsl|darwin|none) · ANYWHERE_DEBUG=1 · NO_COLOR · ANYWHERE_ASCII=1

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
  else writeErr('  Run "anywhere doctor" to check this machine (set ANYWHERE_DEBUG=1 for a stack trace).');
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
  ensureDaemon,
  stopDaemon,
  main,
};
