'use strict';

/**
 * Node side of the voice sidecar (docs/CALLS-DESIGN.md §3.4): spawns `sidecar.py` with the clone
 * venv's Python in isolated mode, speaks protocol v1 (JSON lines over stdio), and matches
 * responses to requests by id.
 *
 *   const c = new SidecarClient(installer.sidecarOptions());
 *   const hello = await c.start();                       // resolves on the 'ready' event
 *   await c.request('tts.load', models.ttsLoadParams('pocket', modelsDir));
 *   const r = await c.request('tts.synthesize', { text, out }, { onEvent: (e) => … });
 *   await c.stop();                                      // shutdown op, then SIGTERM, then SIGKILL
 *
 * Errors are Error objects with `code` (the sidecar's code, or SIDECAR_START_TIMEOUT,
 * SIDECAR_TIMEOUT, SIDECAR_EXITED, SIDECAR_PROTOCOL, SIDECAR_NOT_RUNNING, ABORTED, BAD_REQUEST),
 * `hint` when there is one, and `op`.
 *
 * Events: 'ready' (hello), 'event' (every sidecar event object), 'stderr' (line), 'stdout' (a
 * non-JSON stdout line), 'exit' ({code, signal, stderrTail, expected}), 'restarted' (hello) and
 * 'restart_failed' (Error) with autoRestart.
 */

const { EventEmitter } = require('events');
const childProcess = require('child_process');

const PROTOCOL = 1;
const MAX_LINE = 1024 * 1024;
const MAX_GARBAGE = 20;
const STDERR_TAIL_LINES = 40;
const DEFAULT_FLAGS = Object.freeze(['-I', '-u', '-X', 'utf8']);

function sidecarError(message, { code, hint, op, exit } = {}) {
  const e = new Error(message);
  if (code) e.code = code;
  if (hint) e.hint = hint;
  if (op) e.op = op;
  if (exit) e.exit = exit;
  return e;
}

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

class SidecarClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.python        the interpreter (the clone venv's python)
   * @param {string} opts.script        sidecar.py
   * @param {string[]} [opts.args]      e.g. ['--state', dir, '--models', dir] (already child paths)
   * @param {string[]} [opts.pythonArgs] before the flags (['-3'] for the py launcher)
   * @param {string[]} [opts.flags]     interpreter flags, default ['-I','-u','-X','utf8']
   * @param {object} [opts.env]         base environment (process.env)
   * @param {string} [opts.cwd]
   * @param {(p:string)=>string} [opts.toChildPath] converts a local path for the child (WSL: wslpath -w)
   * @param {number} [opts.startTimeoutMs=15000]
   * @param {number} [opts.requestTimeoutMs=120000]
   * @param {Function} [opts.spawn]     injectable child_process.spawn
   * @param {string} [opts.platform]    process.platform
   * @param {boolean} [opts.windowsChild] the child is a Windows process (win32, or WSL interop)
   * @param {string} [opts.taskkill]    taskkill path (WSL: /mnt/c/Windows/System32/taskkill.exe)
   * @param {number} [opts.autoRestart=0] restarts allowed within restartWindowMs after a crash
   * @param {number} [opts.restartWindowMs=600000]
   * @param {(client:SidecarClient, hello:object)=>Promise<void>} [opts.init] runs after every (re)start
   */
  constructor({
    python,
    script,
    args = [],
    pythonArgs = [],
    flags = DEFAULT_FLAGS,
    env,
    cwd,
    toChildPath,
    startTimeoutMs = 15000,
    requestTimeoutMs = 120000,
    spawn,
    platform,
    windowsChild,
    taskkill,
    autoRestart = 0,
    restartWindowMs = 10 * 60 * 1000,
    init,
  } = {}) {
    super();
    if (!python || !script) throw sidecarError('SidecarClient needs python and script', { code: 'BAD_REQUEST' });
    this.python = python;
    this.script = script;
    this.args = args.slice();
    this.pythonArgs = pythonArgs.slice();
    this.flags = flags.slice();
    this.env = env || process.env;
    this.cwd = cwd;
    this.toChildPath = typeof toChildPath === 'function' ? toChildPath : null;
    this.startTimeoutMs = startTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnFn = typeof spawn === 'function' ? spawn : childProcess.spawn;
    this.platform = platform || process.platform;
    this.windowsChild = windowsChild != null ? Boolean(windowsChild) : this.platform === 'win32';
    this.taskkill = taskkill || 'taskkill';
    this.autoRestart = Math.max(0, Number(autoRestart) || 0);
    this.restartWindowMs = restartWindowMs;
    this.init = typeof init === 'function' ? init : null;

    this.child = null;
    this.hello = null;
    this.ready = false;
    this.seq = 0;
    this.pending = new Map();
    this.ignored = new Set();
    this.garbage = 0;
    this.stderrTail = [];
    this.starting = null;
    this.stopping = false;
    this.exitPromise = null;
    this.lastExit = null;
    this.restarts = [];
  }

  /** @returns {boolean} the sidecar is up and answered 'ready' */
  get running() {
    return Boolean(this.child && this.ready && !this.lastExitOf(this.child));
  }

  /** @returns {number|null} the local child's pid */
  get pid() {
    return this.child ? this.child.pid : null;
  }

  /** @returns {object|null} the ready payload (protocol, python, sherpa, ops, audioIo, …) */
  get info() {
    return this.hello;
  }

  /** @returns {string} a local path as the child sees it */
  childPath(p) {
    return this.toChildPath ? this.toChildPath(p) : p;
  }

  /** @private */
  lastExitOf(child) {
    return child && child.__exit ? child.__exit : null;
  }

  /**
   * Start the sidecar (no-op when it runs). Resolves with the ready payload.
   * @returns {Promise<object>}
   */
  start() {
    if (this.running) return Promise.resolve(this.hello);
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.spawnOnce()
      .then(async (hello) => {
        if (this.init) {
          try {
            await this.init(this, hello);
          } catch (err) {
            this.stopping = true; // expected: no automatic restart
            await this.stopChild(500).catch(() => {});
            throw err;
          }
        }
        return hello;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /** @private */
  spawnOnce() {
    return new Promise((resolve, reject) => {
      const argv = [...this.pythonArgs, ...this.flags, this.childPath(this.script), ...this.args];
      const env = { ...this.env, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
      let child;
      try {
        child = this.spawnFn(this.python, argv, {
          cwd: this.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // POSIX: its own process group, so stop() can also end what the sidecar started.
          detached: this.platform !== 'win32',
        });
      } catch (err) {
        reject(sidecarError(`Could not start the voice sidecar (${this.python}): ${err.message}`, { code: 'SIDECAR_EXITED', hint: 'Reinstall the voice runtime: anywhere clone-voice install' }));
        return;
      }
      this.child = child;
      this.ready = false;
      this.hello = null;
      this.garbage = 0;
      this.stderrTail = [];
      let settled = false;
      const settle = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        settle(
          sidecarError(`The voice sidecar did not start within ${Math.round(this.startTimeoutMs / 1000)} s`, {
            code: 'SIDECAR_START_TIMEOUT',
            hint: 'Check the voice runtime: anywhere clone-voice status (reinstall with anywhere clone-voice install --force).',
          }),
        );
        this.killChild(child, 'SIGKILL');
      }, this.startTimeoutMs);
      child.__onReady = (hello) => {
        if (Number(hello.protocol) !== PROTOCOL) {
          settle(sidecarError(`The voice sidecar speaks protocol ${hello.protocol}, not ${PROTOCOL}`, { code: 'SIDECAR_PROTOCOL', hint: 'Reinstall Claude Anywhere so the sidecar and the daemon match.' }));
          this.killChild(child, 'SIGKILL');
          return;
        }
        this.ready = true;
        this.hello = hello;
        settle(null, hello);
        this.emit('ready', hello);
      };
      this.exitPromise = new Promise((resolveExit) => {
        let exited = false;
        const onExit = (code, signal, error) => {
          if (exited) return;
          exited = true;
          const info = { code: code == null ? null : code, signal: signal || null, stderrTail: this.stderrTail.join('\n'), expected: this.stopping, error: error ? error.message : undefined };
          child.__exit = info;
          this.handleExit(child, info);
          if (!settled) {
            const why = error ? error.message : `exit ${code == null ? signal : code}`;
            settle(
              sidecarError(`The voice sidecar stopped before it was ready (${why})${info.stderrTail ? `: ${info.stderrTail.split('\n').slice(-3).join(' | ')}` : ''}`, {
                code: 'SIDECAR_EXITED',
                hint: 'Reinstall the voice runtime: anywhere clone-voice install --force',
                exit: info,
              }),
            );
          }
          resolveExit(info);
        };
        child.once('error', (err) => onExit(null, null, err));
        child.once('close', (code, signal) => onExit(code, signal));
      });
      if (child.stdin) child.stdin.on('error', () => {}); // EPIPE after a crash: 'close' reports it
      let buf = '';
      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            this.onLine(child, line);
          }
          if (buf.length > MAX_LINE + 1024) {
            buf = '';
            this.onGarbage(child, '[a stdout line longer than 1 MB]');
          }
        });
      }
      let ebuf = '';
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          ebuf += chunk;
          let nl;
          while ((nl = ebuf.indexOf('\n')) >= 0) {
            this.onStderr(ebuf.slice(0, nl).replace(/\r$/, ''));
            ebuf = ebuf.slice(nl + 1);
          }
          if (ebuf.length > 64 * 1024) {
            this.onStderr(ebuf.slice(0, 2000));
            ebuf = '';
          }
        });
        child.stderr.on('end', () => {
          if (ebuf) this.onStderr(ebuf);
          ebuf = '';
        });
      }
    });
  }

  /** @private */
  onStderr(line) {
    if (!line) return;
    this.stderrTail.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
    this.emit('stderr', line);
  }

  /** @private */
  onGarbage(child, line) {
    if (child !== this.child) return;
    this.garbage += 1;
    this.emit('stdout', line);
    if (this.garbage > MAX_GARBAGE) {
      const err = sidecarError(`The voice sidecar wrote ${this.garbage} lines that are not protocol messages`, { code: 'SIDECAR_PROTOCOL', hint: 'Reinstall the voice runtime: anywhere clone-voice install --force' });
      this.rejectAll(err);
      this.killChild(child, 'SIGKILL');
    }
  }

  /** @private */
  onLine(child, raw) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = null;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.onGarbage(child, line);
      return;
    }
    if (child !== this.child) return;
    if (typeof msg.event === 'string') {
      if (msg.event === 'ready' && !this.ready && child.__onReady) {
        const { event, ...hello } = msg; // eslint-disable-line no-unused-vars
        child.__onReady(hello);
        return;
      }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p && p.onEvent) {
          try {
            p.onEvent(msg);
          } catch {
            /* a listener never breaks the protocol */
          }
        }
      }
      this.emit('event', msg);
      return;
    }
    if (msg.id == null || typeof msg.ok !== 'boolean') {
      this.onGarbage(child, line);
      return;
    }
    if (this.ignored.delete(msg.id)) return;
    const p = this.pending.get(msg.id);
    if (!p) return; // answered after a timeout or abort
    this.finishRequest(msg.id);
    const { id, ok, ...rest } = msg; // eslint-disable-line no-unused-vars
    if (ok) p.resolve(rest);
    else p.reject(sidecarError(String(rest.error || 'The voice sidecar reported an error'), { code: rest.code || 'INTERNAL', hint: rest.hint, op: p.op }));
  }

  /** @private */
  finishRequest(id) {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
    return p;
  }

  /** @private */
  rejectAll(err) {
    for (const id of [...this.pending.keys()]) {
      const p = this.finishRequest(id);
      if (p) p.reject(sidecarError(err.message, { code: err.code, hint: err.hint, op: p.op, exit: err.exit }));
    }
    this.ignored.clear();
  }

  /** @private */
  handleExit(child, info) {
    if (child !== this.child) return;
    const wasReady = this.ready;
    this.ready = false;
    this.lastExit = info;
    const why = info.code != null ? `exit code ${info.code}` : info.signal ? `signal ${info.signal}` : info.error || 'unknown';
    this.rejectAll(
      sidecarError(`The voice sidecar stopped (${why})`, {
        code: 'SIDECAR_EXITED',
        hint: info.expected ? undefined : 'It is restarted on the next use; if this repeats, run anywhere clone-voice status.',
        exit: info,
      }),
    );
    this.emit('exit', info);
    if (!info.expected && wasReady && this.autoRestart > 0) {
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < this.restartWindowMs);
      if (this.restarts.length < this.autoRestart) {
        this.restarts.push(now);
        this.start().then(
          (hello) => this.emit('restarted', hello),
          (err) => this.emit('restart_failed', err),
        );
      }
    }
  }

  /** @private write one protocol line; false when the pipe is gone */
  writeLine(obj) {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** @private ask the sidecar to cancel request `target` (its answer is ignored) */
  sendCancel(target) {
    if (!this.running) return;
    this.seq += 1;
    const id = this.seq;
    this.ignored.add(id);
    if (!this.writeLine({ id, op: 'cancel', target })) this.ignored.delete(id);
  }

  /**
   * Send a request.
   * @param {string} op
   * @param {object} [params]
   * @param {{timeoutMs?:number, signal?:AbortSignal, onEvent?:(e:object)=>void}} [opts]
   *   onEvent receives the sidecar events that carry this request's id (e.g. tts.chunk).
   * @returns {Promise<object>} the response without id/ok
   */
  request(op, params = {}, { timeoutMs, signal, onEvent } = {}) {
    return new Promise((resolve, reject) => {
      if (typeof op !== 'string' || !op) {
        reject(sidecarError('A request needs an op', { code: 'BAD_REQUEST' }));
        return;
      }
      if (!this.running) {
        reject(sidecarError('The voice sidecar is not running', { code: 'SIDECAR_NOT_RUNNING', op, hint: 'Start it first (it starts with the voice service).' }));
        return;
      }
      if (signal && signal.aborted) {
        reject(sidecarError(`${op} was cancelled`, { code: 'ABORTED', op }));
        return;
      }
      this.seq += 1;
      const id = this.seq;
      const msg = { ...(params && typeof params === 'object' ? params : {}), id, op };
      let line;
      try {
        line = JSON.stringify(msg);
      } catch (err) {
        reject(sidecarError(`${op}: the parameters cannot be sent (${err.message})`, { code: 'BAD_REQUEST', op }));
        return;
      }
      if (Buffer.byteLength(line) > MAX_LINE) {
        reject(sidecarError(`${op}: the request is larger than 1 MB (audio goes in files, not inline)`, { code: 'BAD_REQUEST', op }));
        return;
      }
      const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.requestTimeoutMs;
      const entry = { resolve, reject, op, onEvent: typeof onEvent === 'function' ? onEvent : null, signal: signal || null, onAbort: null, timer: null };
      entry.timer = setTimeout(() => {
        if (!this.finishRequest(id)) return;
        this.sendCancel(id);
        reject(sidecarError(`The voice sidecar did not answer ${op} within ${Math.round(ms / 1000)} s`, { code: 'SIDECAR_TIMEOUT', op }));
      }, ms);
      if (signal) {
        entry.onAbort = () => {
          if (!this.finishRequest(id)) return;
          this.sendCancel(id);
          reject(sidecarError(`${op} was cancelled`, { code: 'ABORTED', op }));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      if (!this.writeLine(msg)) {
        this.finishRequest(id);
        reject(sidecarError('The voice sidecar is not accepting requests', { code: 'SIDECAR_NOT_RUNNING', op }));
      }
    });
  }

  /** @private send a signal to the child (and its process group on POSIX) */
  killChild(child, sig) {
    if (!child || this.lastExitOf(child)) return;
    if (this.windowsChild) {
      // Windows (or a Windows python under WSL interop): end the whole tree. Under WSL the local
      // pid is the interop proxy; the sidecar reported its Windows pid in 'ready'.
      const winPid = this.platform === 'win32' ? child.pid : this.hello && this.hello.pid;
      if (winPid) {
        try {
          const k = this.spawnFn(this.taskkill, ['/PID', String(winPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          if (k && k.on) k.on('error', () => {});
        } catch {
          /* taskkill missing */
        }
      }
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
      return;
    }
    if (child.pid && this.platform !== 'win32') {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch {
        /* not a group leader (injected spawn) or gone: signal the child itself */
      }
    }
    try {
      child.kill(sig);
    } catch {
      /* gone */
    }
  }

  /**
   * Stop the sidecar: the shutdown op, then SIGTERM, then SIGKILL (taskkill /T /F on Windows).
   * @param {{graceMs?:number}} [opts]
   * @returns {Promise<{code:number|null, signal:string|null}|null>} the exit, or null when not running
   */
  async stop({ graceMs = 2000 } = {}) {
    this.stopping = true;
    if (this.starting) await this.starting.catch(() => {});
    return this.stopChild(graceMs);
  }

  /** @private stop() without waiting for a start in progress (used by start itself) */
  async stopChild(graceMs) {
    const child = this.child;
    if (!child || this.lastExitOf(child)) return this.lastExit;
    const exited = this.exitPromise;
    if (this.ready) {
      this.request('shutdown', {}, { timeoutMs: graceMs }).catch(() => {});
    } else if (child.stdin) {
      try {
        child.stdin.end();
      } catch {
        /* gone */
      }
    }
    let info = await Promise.race([exited, delay(graceMs).then(() => null)]);
    if (!info) {
      this.killChild(child, 'SIGTERM');
      info = await Promise.race([exited, delay(1000).then(() => null)]);
    }
    if (!info) {
      this.killChild(child, 'SIGKILL');
      info = await Promise.race([exited, delay(2000).then(() => null)]);
    }
    return info || this.lastExit;
  }

  /** Stop, then start again. @returns {Promise<object>} the new ready payload */
  async restart() {
    await this.stop({ graceMs: 1000 });
    return this.start();
  }
}

module.exports = { SidecarClient, PROTOCOL, MAX_LINE, MAX_GARBAGE, DEFAULT_FLAGS };
