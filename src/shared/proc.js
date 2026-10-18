'use strict';

/** Child-process helpers that never throw and always time out. */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Run a command and collect its output.
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {{timeoutMs?:number,input?:string|Buffer,cwd?:string,env?:object,encoding?:'utf8'|'buffer',maxBuffer?:number,windowsHide?:boolean,shell?:boolean}} [opts]
 * @returns {Promise<{code:number|null,signal:string|null,stdout:any,stderr:string,timedOut:boolean,error:Error|null}>}
 */
function run(cmd, args = [], opts = {}) {
  const {
    timeoutMs = 15000,
    input,
    cwd,
    env,
    encoding = 'utf8',
    maxBuffer = 64 * 1024 * 1024,
    windowsHide = true,
    shell = false,
  } = opts;
  return new Promise((resolve) => {
    let child;
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(out);
      resolve({
        code: res.code ?? null,
        signal: res.signal ?? null,
        stdout: encoding === 'buffer' ? stdoutBuf : stdoutBuf.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        error: res.error || null,
      });
    };
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env || process.env,
        windowsHide,
        shell,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: encoding === 'buffer' ? Buffer.alloc(0) : '', stderr: '', timedOut: false, error: e });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen <= maxBuffer) out.push(d);
    });
    child.stderr.on('data', (d) => {
      errLen += d.length;
      if (errLen <= 1024 * 1024) err.push(d);
    });
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code, signal) => finish({ code, signal }));
    child.stdin.on('error', () => {
      /* EPIPE when the child exits early */
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

const whichCache = new Map(); // name -> { found, at }
// A miss is re-checked after this long, so a tool installed while the daemon runs (xdotool,
// gcloud, ...) is found without a restart. Hits are kept.
const WHICH_MISS_TTL_MS = 10000;

/**
 * Find an executable on PATH (honours PATHEXT on Windows).
 * @param {string} name
 * @returns {string|null}
 */
function which(name) {
  if (!name) return null;
  const cached = whichCache.get(name);
  if (cached && (cached.found || Date.now() - cached.at < WHICH_MISS_TTL_MS)) return cached.found;
  let found = null;
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const candidates = [];
  if (name.includes('/') || (isWin && name.includes('\\'))) {
    candidates.push(name);
  } else {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      candidates.push(path.join(dir.replace(/^"(.*)"$/, '$1'), name));
    }
  }
  outer: for (const base of candidates) {
    const variants = isWin && !path.extname(base) ? exts.map((e) => base + e.toLowerCase()).concat([base]) : [base];
    for (const p of variants) {
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        if (!isWin) fs.accessSync(p, fs.constants.X_OK);
        found = p;
        break outer;
      } catch {
        /* keep looking */
      }
    }
  }
  whichCache.set(name, { found, at: Date.now() });
  return found;
}

function clearWhichCache() {
  whichCache.clear();
}

/**
 * Spawn a long-lived background process detached from this one.
 * @returns {import('child_process').ChildProcess}
 */
function spawnDetached(cmd, args, { cwd, env, logFile } = {}) {
  let outFd = 'ignore';
  if (logFile) {
    try {
      outFd = fs.openSync(logFile, 'a');
    } catch {
      outFd = 'ignore';
    }
  }
  const child = spawn(cmd, args, {
    cwd,
    env: env || process.env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, outFd],
  });
  child.unref();
  if (typeof outFd === 'number') {
    try {
      fs.closeSync(outFd);
    } catch {
      /* ignore */
    }
  }
  return child;
}

/** Quote one argument for cmd.exe when shell:true is unavoidable (.cmd shims). */
function quoteWinArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^%!()]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/%/g, '"%"')}"`;
}

module.exports = { run, which, clearWhichCache, spawnDetached, quoteWinArg };
