'use strict';

/**
 * Installs the cloned-voice runtime (docs/CALLS-DESIGN.md §3.3): a private Python venv with
 * sherpa-onnx (requirements.txt, binary wheels only) and the sherpa-onnx models from GitHub
 * releases, each verified by sha256. Nothing is installed into the user's own Python, nothing
 * costs money, and everything runs locally afterwards.
 *
 *   <root> = <state>/voice
 *     clone-venv/                  the venv (anywhere-runtime.json records what was installed)
 *     clone-models/<asset id>/…    models (.installed.json = verified sha256), bench.json
 *     clone-models/downloads/      partial downloads (resumed), or files placed there by hand
 *     bin/uv[.exe], python/, uv-cache/   only when no usable Python exists (uv fallback)
 *
 * Python: voice.clone.python > ANYWHERE_PYTHON > (py -3) > python3 > python, 3.9–3.14 with venv
 * (the probe is piper.js findPython). When none works, or `-m venv` fails (Debian without
 * python3-venv), or pip finds no wheel for that Python, uv is used: from <root>/bin, PATH, or
 * downloaded from its GitHub release (pinned sha256), with a python-build-standalone 3.12 in
 * <root>/python.
 *
 * WSL (§5.4): the call runs in the Windows browser, so the venv and models live on the Windows
 * side (%USERPROFILE%\.claude-anywhere\voice) and the sidecar is the Windows python.exe through
 * interop; paths are converted with wslToWindowsPath(). ANYWHERE_CLONE_WSL=linux keeps it in WSL.
 *
 * Progress stages: python | venv | pip | models | verify | bench | done | error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const paths = require('../../shared/paths');
const proc = require('../../shared/proc');
const platformMod = require('../../shared/platform');
const piper = require('../../daemon/piper');
const models = require('./models');
const { SidecarClient } = require('./client');
const { createLogger } = require('../../shared/log');

const log = createLogger('clone-installer');

const PY_MIN = [3, 9];
const PY_MAX = [3, 14];
const UV_PYTHON = '3.12';
const VENV_TIMEOUT_MS = 5 * 60 * 1000;
const PIP_TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;
const BENCH_TIMEOUT_MS = 20 * 60 * 1000;
const LOCK_STALE_MS = 90 * 60 * 1000;
const VENV_BYTES = 200 * 1024 * 1024;
const RUNTIME_FILE = 'anywhere-runtime.json';
const HELD_LOCKS = new Set(); // lock files this process holds (another installer instance may ask)
const MARKER = '.installed.json';

// Percent ranges of the stages (models are weighted by download size inside theirs).
const RANGES = { python: [0, 3], venv: [3, 8], pip: [8, 20], models: [20, 85], verify: [85, 90], bench: [90, 99] };

function installError(message, { status = 500, code, hint } = {}) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  if (hint) e.hint = hint;
  return e;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* in use; left for the next run */
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  mkdirp(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function tail(s, n = 400) {
  const t = String(s || '')
    .trim()
    .replace(/\s+/g, ' ');
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function mb(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** sha256 of a file, streamed. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * A WSL path as Windows sees it: /mnt/c/x → C:\x; anything else → \\wsl.localhost\<distro>\….
 * @param {string} p
 * @param {string} distro WSL_DISTRO_NAME
 */
function wslToWindowsPath(p, distro) {
  const abs = path.posix.resolve(String(p));
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(abs);
  if (m) return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
  return `\\\\wsl.localhost\\${distro || 'Ubuntu'}${abs.replace(/\//g, '\\')}`;
}

/** C:\Users\me → /mnt/c/Users/me (null for anything else). */
function windowsToWslPath(p) {
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(String(p || '').trim());
  if (!m) return null;
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** Add names to WSLENV so a Windows child sees them (/p converts a path). */
function withWslEnv(env, names) {
  const cur = String(env.WSLENV || '')
    .split(':')
    .filter(Boolean);
  const have = new Set(cur.map((x) => x.split('/')[0]));
  for (const n of names) if (!have.has(n.split('/')[0])) cur.push(n);
  return { ...env, WSLENV: cur.join(':') };
}

/** The asset's folder and files under a models root (like models.assetPaths, for any asset object). */
function pathsOf(asset, root) {
  const dir = path.join(root, asset.id);
  const files = {};
  for (const [role, rel] of Object.entries(asset.files)) files[role] = path.join(dir, ...rel.split('/'));
  return { dir, files, marker: path.join(dir, MARKER) };
}

class CloneInstaller {
  /**
   * @param {object} [opts]
   * @param {string} [opts.root]          <state>/voice (default paths.voiceDir())
   * @param {string} [opts.stateDir]      the sidecar's --state (default: the parent of root)
   * @param {object} [opts.env]
   * @param {object} [opts.platformInfo]  shared/platform info()
   * @param {Function} [opts.runner]      piper.defaultRunner-compatible
   * @param {(n:string)=>string|null} [opts.which]
   * @param {Function} [opts.httpGet]     piper.httpGet-compatible (unused unless downloadFile needs it)
   * @param {Function} [opts.downloadFile] piper.downloadFile-compatible
   * @param {string} [opts.assetBase]     a mirror of the sherpa-onnx release paths (else ANYWHERE_CLONE_ASSET_BASE)
   * @param {string} [opts.defaultBase]   the last source (the GitHub release; tests point it elsewhere)
   * @param {string} [opts.uvBase]        a mirror of the uv release (else ANYWHERE_CLONE_UV_BASE)
   * @param {object} [opts.assets]        asset catalog override (tests)
   * @param {object} [opts.uvAssets]      uv asset table override (tests)
   * @param {string} [opts.python]        voice.clone.python
   * @param {string} [opts.packageDir]    the folder with sidecar.py and requirements.txt
   * @param {string|Buffer} [opts.ca]
   * @param {(spec:object)=>object} [opts.clientFactory] builds a SidecarClient from a spec (tests)
   * @param {Function} [opts.spawnSync] child_process.spawnSync (the WSL user-folder probe)
   * @param {string} [opts.arch]
   */
  constructor({ root, stateDir, env, platformInfo, runner, which, httpGet, downloadFile, assetBase, defaultBase, uvBase, assets, uvAssets, python, packageDir, ca, clientFactory, spawnSync, arch } = {}) {
    this.rootOption = root || null;
    this.stateDirOption = stateDir || null;
    this.env = env || process.env;
    this.platformInfoOverride = platformInfo || null;
    this.runner = typeof runner === 'function' ? runner : piper.defaultRunner;
    this.which = typeof which === 'function' ? which : proc.which;
    this.httpGet = typeof httpGet === 'function' ? httpGet : piper.httpGet;
    this.downloadFile = typeof downloadFile === 'function' ? downloadFile : piper.downloadFile;
    this.assetBase = assetBase || null;
    this.defaultBase = defaultBase || models.DEFAULT_ASSET_BASE;
    this.uvBase = uvBase || null;
    this.assets = assets || models.ASSETS;
    this.uvAssets = uvAssets || models.UV_ASSETS;
    this.pythonOption = python || '';
    this.packageDir = packageDir || __dirname;
    this.ca = ca || null;
    this.clientFactory = typeof clientFactory === 'function' ? clientFactory : (spec) => new SidecarClient(spec);
    this.spawnSync = typeof spawnSync === 'function' ? spawnSync : childProcess.spawnSync;
    this.arch = arch || process.arch;
    this.installing = null;
    this.layoutCache = null;
  }

  /** @private */
  platformInfo() {
    if (!this.platformInfoOverride) this.platformInfoOverride = platformMod.info();
    return this.platformInfoOverride;
  }

  /** @private the asset object of an id (from this installer's catalog) */
  asset(id) {
    const a = Object.prototype.hasOwnProperty.call(this.assets, id) ? this.assets[id] : null;
    if (!a) throw installError(`Unknown clone model asset "${id}"`, { status: 400, code: 'BAD_ASSET' });
    return a;
  }

  // ---------------------------------------------------------------- layout

  /**
   * Where things live and how the sidecar is run (resolves the Windows side under WSL once).
   * @returns {Promise<{kind:'native'|'wsl', platform:string, root:string, venvDir:string, modelsDir:string,
   *   binDir:string, venvPython:string, toChildPath:((p:string)=>string)|null, windowsChild:boolean, taskkill:string|null, note?:string}>}
   */
  async layout() {
    return this.layoutSync();
  }

  /** layout(), synchronously (the WSL probe runs once, about 0.2 s). */
  layoutSync() {
    if (this.layoutCache) return this.layoutCache;
    const pi = this.platformInfo();
    const nativeRoot = this.rootOption || paths.voiceDir();
    let lay = null;
    if (pi.isWSL && this.env.ANYWHERE_CLONE_WSL !== 'linux') {
      let win = null;
      try {
        win = this.windowsProfile();
      } catch (err) {
        log.warn(`WSL: ${err.message}; the voice runtime stays inside WSL`);
      }
      if (win) {
        const root = path.posix.join(win, '.claude-anywhere', 'voice');
        const distro = this.env.WSL_DISTRO_NAME || 'Ubuntu';
        const sys32 = '/mnt/c/Windows/System32';
        lay = {
          kind: 'wsl',
          platform: 'win32',
          root,
          toChildPath: (p) => wslToWindowsPath(p, distro),
          windowsChild: true,
          taskkill: this.which('taskkill.exe') || path.posix.join(sys32, 'taskkill.exe'),
        };
      } else {
        lay = { kind: 'native', platform: 'linux', root: nativeRoot, toChildPath: null, windowsChild: false, taskkill: null, note: 'Windows interop is unavailable: the voice runs inside WSL (no Windows call audio).' };
      }
    } else {
      lay = { kind: 'native', platform: pi.platform, root: nativeRoot, toChildPath: null, windowsChild: pi.platform === 'win32', taskkill: null };
    }
    const j = lay.kind === 'wsl' ? path.posix.join : path.join;
    lay.venvDir = j(lay.root, 'clone-venv');
    lay.modelsDir = j(lay.root, 'clone-models');
    lay.binDir = j(lay.root, 'bin');
    lay.venvPython = lay.platform === 'win32' ? j(lay.venvDir, 'Scripts', 'python.exe') : j(lay.venvDir, 'bin', 'python');
    this.layoutCache = lay;
    return lay;
  }

  /** @private WSL: %USERPROFILE% as a /mnt path */
  windowsProfile() {
    const cmd = this.which('cmd.exe') || '/mnt/c/Windows/System32/cmd.exe';
    const r = this.spawnSync(cmd, ['/d', '/c', 'echo %USERPROFILE%'], { timeout: 15000, encoding: 'utf8', windowsHide: true, cwd: isDir('/mnt/c') ? '/mnt/c' : undefined });
    const line = String((r && r.stdout) || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => /^[a-zA-Z]:\\/.test(s));
    const p = line ? windowsToWslPath(line) : null;
    if (!r || r.error || r.status !== 0 || !p) throw installError('Could not find the Windows user folder from WSL', { code: 'WSL_INTEROP' });
    return p;
  }

  /** @returns {string} the models root (<root>/clone-models) */
  modelsDir() {
    return this.layoutSync().modelsDir;
  }

  /** @returns {string} the models root */
  get modelsRoot() {
    return this.layoutSync().modelsDir;
  }

  /** @returns {string} the venv's python */
  venvPython() {
    return this.layoutSync().venvPython;
  }

  /** @returns {string} the sidecar's --state */
  stateDir() {
    return this.stateDirOption || (this.rootOption ? path.dirname(this.rootOption) : paths.stateDir());
  }

  /** @returns {string} */
  requirementsFile() {
    return path.join(this.packageDir, 'requirements.txt');
  }

  /** @returns {string} */
  sidecarScript() {
    return path.join(this.packageDir, 'sidecar.py');
  }

  /** @private */
  requirementsSha() {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(this.requirementsFile())).digest('hex');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- status

  /** @private whether an asset is installed (marker with the catalog's sha256, and its files) */
  assetState(id, modelsDir) {
    const a = this.asset(id);
    const p = pathsOf(a, modelsDir);
    const marker = readJson(p.marker);
    const filesOk = Object.values(p.files).every((f) => exists(f));
    const verified = Boolean(marker && marker.sha256 === a.sha256);
    return { id, installed: verified && filesOk, verified, dir: p.dir, bytes: a.bytes, installedAt: marker ? marker.installedAt || null : null, stale: Boolean(marker && marker.sha256 !== a.sha256) };
  }

  /**
   * @param {{config?:object, engine?:string, stt?:string}} [opts]
   * @returns {Promise<object>} {installed, ready, runtime, python, engines, stt, assets, required, missing, downloadBytes, bench, installing, layout}
   */
  async status({ config, engine, stt } = {}) {
    const lay = await this.layout();
    const rt = readJson(path.join(lay.venvDir, RUNTIME_FILE));
    const venvOk = isFile(lay.venvPython);
    const reqSha = this.requirementsSha();
    const runtimeOk = Boolean(venvOk && rt && rt.requirementsSha === reqSha && rt.ok === true);
    const cfg = { ...(config || {}), ...(engine ? { engine } : {}), ...(stt ? { stt } : {}) };
    const required = models.requiredAssets(cfg).filter((id) => Object.prototype.hasOwnProperty.call(this.assets, id));
    const assets = {};
    for (const id of Object.keys(this.assets)) assets[id] = this.assetState(id, lay.modelsDir);
    const missing = required.filter((id) => !assets[id].installed);
    const engines = {
      pocket: assets['pocket-int8'] ? assets['pocket-int8'].installed : false,
      zipvoice: Boolean(assets['zipvoice-int8'] && assets['zipvoice-int8'].installed && assets['vocos-24k'] && assets['vocos-24k'].installed),
    };
    const sttState = {};
    for (const [name, s] of Object.entries(models.STT)) sttState[name] = Boolean(assets[s.asset] && assets[s.asset].installed);
    const installed = runtimeOk && missing.length === 0;
    return {
      installed,
      ready: installed,
      runtime: { venv: venvOk, ok: runtimeOk, outdated: Boolean(venvOk && rt && rt.requirementsSha !== reqSha), python: rt ? rt.python || null : null, sherpa: rt ? rt.sherpa || null : null, via: rt ? rt.via || null : null, installedAt: rt ? rt.installedAt || null : null },
      python: rt ? rt.python || null : null,
      engines,
      stt: sttState,
      assets,
      required,
      missing,
      downloadBytes: missing.reduce((n, id) => n + this.asset(id).bytes, 0),
      bench: readJson(path.join(lay.modelsDir, 'bench.json')),
      installing: this.installing ? { ...this.installing } : null,
      layout: { kind: lay.kind, root: lay.root, venvDir: lay.venvDir, modelsDir: lay.modelsDir, ...(lay.note ? { note: lay.note } : {}) },
    };
  }

  // ---------------------------------------------------------------- python

  /**
   * A Python 3.9–3.14 with a working venv module (voice.clone.python, ANYWHERE_PYTHON, py -3,
   * python3, python), or null.
   * @returns {Promise<{cmd:string, args:string[], version:string, via:string}|null>}
   */
  async ensurePython() {
    const lay = await this.layout();
    const preferred = [];
    if (this.pythonOption) preferred.push([this.pythonOption, []]);
    let found;
    if (lay.kind === 'wsl') {
      // Windows Pythons only (through interop): never the WSL one.
      const py = this.which('py.exe') || (isFile('/mnt/c/Windows/py.exe') ? '/mnt/c/Windows/py.exe' : null);
      const pyw = this.which('python.exe');
      found = await piper.findPython({
        env: {},
        which: (n) => (n === 'py' ? py : n === 'python' ? pyw : null),
        runner: this.runner,
        platform: 'win32',
        preferred,
        min: PY_MIN,
        max: PY_MAX,
      });
    } else {
      found = await piper.findPython({ env: this.env, which: this.which, runner: this.runner, platform: lay.platform, preferred, min: PY_MIN, max: PY_MAX });
    }
    return found ? { ...found, via: 'system' } : null;
  }

  // ---------------------------------------------------------------- install

  /** @private exclusive install lock (the daemon and the CLI share the folder) */
  lock(root) {
    mkdirp(root);
    const file = path.join(root, 'clone-install.lock');
    for (let i = 0; i < 2; i += 1) {
      try {
        const fd = fs.openSync(file, 'wx', 0o600);
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        fs.closeSync(fd);
        HELD_LOCKS.add(file);
        return () => {
          HELD_LOCKS.delete(file);
          const cur = readJson(file);
          if (cur && cur.pid !== process.pid) return;
          rmrf(file);
        };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      const holder = readJson(file);
      let alive = false;
      if (holder && holder.pid === process.pid) {
        alive = HELD_LOCKS.has(file);
      } else if (holder && holder.pid) {
        try {
          process.kill(holder.pid, 0);
          alive = true;
        } catch (e) {
          alive = e.code === 'EPERM';
        }
      }
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (alive && age < LOCK_STALE_MS) {
        throw installError(`Another voice runtime install is running (pid ${holder.pid})`, { status: 409, code: 'INSTALL_BUSY', hint: 'Wait for it to finish (anywhere clone-voice status).' });
      }
      rmrf(file);
    }
    throw installError('Could not take the voice runtime install lock', { status: 409, code: 'INSTALL_BUSY' });
  }

  /**
   * Install (or repair) the runtime and the models a configuration needs, verify, and benchmark.
   * @param {{engine?:string, stt?:string, config?:object, extras?:string[], force?:boolean, bench?:boolean,
   *   verify?:boolean, onProgress?:(p:{stage:string, percent:number, message:string, stagePercent?:number|null, asset?:string})=>void,
   *   signal?:AbortSignal}} [opts]
   * @returns {Promise<{ok:true, python:string|null, assets:string[], downloaded:string[], bench:object|null, ms:number}>}
   */
  async install({ engine, stt, config, extras, force = false, bench = true, verify = true, onProgress, signal } = {}) {
    const started = Date.now();
    const lay = await this.layout();
    const cfg = { ...(config || {}), ...(engine ? { engine } : {}), ...(stt ? { stt } : {}), ...(extras ? { extras } : {}) };
    const eng = models.engineId(cfg.engine || (cfg.voice && cfg.voice.clone && cfg.voice.clone.engine));
    const sttName = cfg.stt || (cfg.calls && cfg.calls.stt && cfg.calls.stt.model) || models.DEFAULT_STT;
    if (this.installing) throw installError('A voice runtime install is already running', { status: 409, code: 'INSTALL_BUSY', hint: 'Wait for it to finish (anywhere clone-voice status).' });
    const unlock = this.lock(lay.root);
    const state = { stage: 'python', percent: 0, message: 'Starting…', engine: eng, startedAt: new Date().toISOString() };
    this.installing = state;
    let last = -1;
    const report = (stage, frac, message, extra = {}) => {
      const [lo, hi] = RANGES[stage] || [last < 0 ? 0 : last, last < 0 ? 0 : last];
      const pct = stage === 'done' ? 100 : Math.max(last, Math.min(99, Math.round(lo + (hi - lo) * Math.max(0, Math.min(1, frac)))));
      last = pct;
      Object.assign(state, { stage, percent: pct, message });
      if (typeof onProgress === 'function') {
        try {
          onProgress({ stage, percent: pct, message, ...extra });
        } catch {
          /* observers never break the install */
        }
      }
    };
    const aborted = () => {
      if (signal && signal.aborted) throw installError('The install was cancelled', { status: 499, code: 'ABORTED' });
    };
    try {
      const required = models.requiredAssets(cfg).filter((id) => Object.prototype.hasOwnProperty.call(this.assets, id));
      const before = await this.status({ config: cfg });
      const toFetch = required.filter((id) => force || !before.assets[id].installed);
      this.checkDisk(lay, toFetch, !before.runtime.ok || force);

      // 1–3. Python, venv, packages.
      let python = before.runtime.python;
      if (force || !before.runtime.ok) {
        python = await this.installRuntime({ lay, force, report, signal });
      } else {
        report('pip', 1, `The voice runtime is installed (Python ${python}).`);
      }
      aborted();

      // 4. Models.
      const totalBytes = toFetch.reduce((n, id) => n + this.asset(id).bytes, 0) || 1;
      let doneBytes = 0;
      const downloaded = [];
      if (!toFetch.length) report('models', 1, 'The voice models are installed.');
      for (const id of toFetch) {
        aborted();
        const a = this.asset(id);
        const base = doneBytes;
        await this.installAsset(id, {
          lay,
          force,
          signal,
          report: (frac, message, extra) => report('models', (base + a.bytes * frac) / totalBytes, message, { asset: id, ...extra }),
        });
        doneBytes += a.bytes;
        downloaded.push(id);
      }

      // 5. Verify: the sidecar starts, sees every model and loads the engine and the recognizer.
      if (verify) await this.verify({ lay, engine: eng, stt: sttName, required, report });

      // 6. Speed benchmark.
      let benchResult = null;
      if (bench) {
        try {
          benchResult = await this.bench({ engine: eng, signal, onProgress: (p) => report('bench', p.fraction, p.message) });
        } catch (err) {
          if (err.code === 'ABORTED') throw err;
          log.warn(`the voice benchmark failed: ${err.message}`);
          report('bench', 1, `The speed test did not finish (${err.message}); run it later: anywhere clone-voice bench`);
        }
      }
      report('done', 1, 'The cloned-voice runtime is ready. It runs on this computer and costs nothing.');
      return { ok: true, python, assets: required, downloaded, bench: benchResult, ms: Date.now() - started };
    } catch (err) {
      report('error', 0, err.hint ? `${err.message}. ${err.hint}` : err.message);
      throw err;
    } finally {
      this.installing = null;
      unlock();
    }
  }

  /** @private refuse early when the disk cannot hold the download and the unpacked models */
  checkDisk(lay, ids, needVenv) {
    if (typeof fs.statfsSync !== 'function') return;
    const need = ids.reduce((n, id) => n + this.asset(id).bytes + (this.asset(id).diskBytes || 0), 0) + (needVenv ? VENV_BYTES : 0);
    if (!need) return;
    let dir = lay.root;
    while (dir && !exists(dir)) dir = path.dirname(dir) === dir ? null : path.dirname(dir);
    if (!dir) return;
    try {
      const s = fs.statfsSync(dir);
      const free = Number(s.bavail) * Number(s.bsize);
      if (Number.isFinite(free) && free > 0 && free < need * 1.1) {
        throw installError(`Not enough disk space: the voice runtime needs about ${mb(need)} and ${mb(free)} is free`, { status: 507, code: 'DISK_FULL', hint: `Free some space on the drive of ${lay.root}, then run: anywhere clone-voice install` });
      }
    } catch (err) {
      if (err.code === 'DISK_FULL') throw err;
    }
  }

  /**
   * Python → venv → pip install -r requirements.txt → import check. Falls back to uv.
   * @private
   * @returns {Promise<string>} the venv's Python version
   */
  async installRuntime({ lay, force, report, signal }) {
    report('python', 0.2, 'Looking for Python…');
    const py = await this.ensurePython();
    let via = 'venv';
    let ok = false;
    let lastErr = null;
    if (py) {
      report('python', 1, `Using Python ${py.version} (${py.cmd}).`);
      try {
        await this.createVenv(py, { lay, force, report, signal });
        await this.pipInstall({ lay, report, signal });
        ok = true;
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        lastErr = err;
        log.warn(`venv/pip with ${py.cmd} failed (${err.message}); trying uv`);
        report('venv', 0, `${err.message}; using uv with its own Python instead…`);
      }
    } else {
      report('python', 1, 'No usable Python 3.9–3.14 found; using uv with its own Python…');
    }
    if (!ok) {
      try {
        await this.installWithUv({ lay, report, signal });
        via = 'uv';
        ok = true;
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        const pi = lay.platform;
        throw installError(lastErr ? `${lastErr.message}; the uv fallback failed too: ${err.message}` : err.message, {
          status: err.status || 503,
          code: lastErr ? lastErr.code || err.code : err.code || 'NO_PYTHON',
          hint:
            lastErr && lastErr.hint
              ? lastErr.hint
              : pi === 'darwin'
                ? 'Install Python 3.12 (brew install python@3.12, or python.org), then run: anywhere clone-voice install'
                : pi === 'win32'
                  ? 'Install Python 3.12 from python.org (or: winget install Python.Python.3.12), then run: anywhere clone-voice install'
                  : 'Install Python 3 with venv (sudo apt install python3 python3-venv), then run: anywhere clone-voice install',
        });
      }
    }
    report('pip', 0.95, 'Checking the voice runtime…');
    const check = await this.importCheck(lay);
    writeJson(path.join(lay.venvDir, RUNTIME_FILE), {
      ok: true,
      python: check.python,
      sherpa: check.sherpa,
      numpy: check.numpy,
      via,
      requirementsSha: this.requirementsSha(),
      installedAt: new Date().toISOString(),
    });
    report('pip', 1, `sherpa-onnx ${check.sherpa} is installed (Python ${check.python}).`);
    return check.python;
  }

  /** @private */
  async createVenv(py, { lay, force, report, signal }) {
    const exists0 = isFile(lay.venvPython);
    const rt = readJson(path.join(lay.venvDir, RUNTIME_FILE));
    // An existing venv is reused for an outdated requirements file (pip upgrades it in place).
    if (exists0 && !force && rt && rt.python) {
      report('venv', 1, 'Reusing the private Python environment.');
      return;
    }
    report('venv', 0.1, 'Creating a private Python environment (your own Python packages are not touched)…');
    rmrf(lay.venvDir);
    mkdirp(path.dirname(lay.venvDir));
    const target = lay.toChildPath ? lay.toChildPath(lay.venvDir) : lay.venvDir;
    const r = await this.runner(py.cmd, [...py.args, '-m', 'venv', target], { timeoutMs: VENV_TIMEOUT_MS, signal, env: this.childEnv(lay), cwd: lay.root });
    if (r.aborted) throw installError('The install was cancelled', { status: 499, code: 'ABORTED' });
    if (r.error || r.timedOut || r.code !== 0 || !isFile(lay.venvPython)) {
      rmrf(lay.venvDir);
      const why = r.error ? r.error.message : r.timedOut ? 'timed out' : tail(r.stderr || r.stdout, 300);
      throw installError(`Could not create a Python venv: ${why}`, {
        status: 500,
        code: 'VENV_FAILED',
        hint: /ensurepip|venv/i.test(why) && lay.platform === 'linux' ? 'Install the venv module (sudo apt install python3-venv), or let uv provide Python.' : 'Check that Python works (python3 -m venv --help).',
      });
    }
    report('venv', 1, 'The private Python environment is ready.');
  }

  /** @private env for Python/pip/uv children: no user site, no PIP_TARGET-style redirects */
  childEnv(lay, extra = {}) {
    const env = { ...this.env, PYTHONNOUSERSITE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PIP_USER: '0', ...extra };
    for (const k of ['PIP_TARGET', 'PIP_PREFIX', 'PIP_ROOT', 'PIP_REQUIRE_VIRTUALENV', 'PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX']) delete env[k];
    if (lay.kind === 'wsl') return withWslEnv(env, ['PYTHONNOUSERSITE', 'PIP_DISABLE_PIP_VERSION_CHECK', 'PIP_NO_INPUT', 'PIP_USER', ...Object.keys(extra).map((k) => (/_DIR$/.test(k) ? `${k}/p` : k))]);
    return env;
  }

  /** @private pip output → progress */
  pipProgress(report, lo, hi) {
    let n = 0;
    let buf = '';
    return (chunk) => {
      buf += String(chunk);
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      for (const line of lines) {
        const m = /^\s*(Collecting|Downloading|Installing collected packages|Successfully installed|Resolved|Prepared|Installed|Downloaded)\s*(.*)$/.exec(line);
        if (!m) continue;
        n += 1;
        report('pip', Math.min(hi, lo + n * 0.04), `pip: ${m[1]} ${tail(m[2], 80)}`.trim());
      }
    };
  }

  /** @private */
  async pipInstall({ lay, report, signal }) {
    const req = lay.toChildPath ? lay.toChildPath(this.requirementsFile()) : this.requirementsFile();
    const env = this.childEnv(lay);
    report('pip', 0.05, 'Updating pip…');
    const up = await this.runner(lay.venvPython, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--upgrade', 'pip'], { timeoutMs: PIP_TIMEOUT_MS, signal, env, cwd: lay.root });
    if (up.aborted) throw installError('The install was cancelled', { status: 499, code: 'ABORTED' });
    if (up.code !== 0) log.debug(`pip self-upgrade failed (continuing): ${tail(up.stderr, 200)}`);
    report('pip', 0.15, 'Installing sherpa-onnx and numpy from PyPI (about 35 MB)…');
    const r = await this.runner(lay.venvPython, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--only-binary=:all:', '-r', req], {
      timeoutMs: PIP_TIMEOUT_MS,
      signal,
      env,
      cwd: lay.root,
      onStdout: this.pipProgress(report, 0.15, 0.9),
    });
    if (r.aborted) throw installError('The install was cancelled', { status: 499, code: 'ABORTED' });
    if (r.error || r.timedOut || r.code !== 0) throw this.pipError(r);
  }

  /** @private */
  pipError(r) {
    const text = `${r.stderr || ''}\n${r.stdout || ''}`;
    const why = r.error ? r.error.message : r.timedOut ? `took longer than ${PIP_TIMEOUT_MS / 60000} minutes` : tail(r.stderr || r.stdout, 400);
    const noWheel = /No matching distribution|Could not find a version that satisfies|no wheels? (?:with|for)|Unable to find a (?:compatible|matching)|not supported on this platform/i.test(text);
    return installError(`Could not install the voice runtime packages: ${why}`, {
      status: 502,
      code: noWheel ? 'NO_WHEEL' : 'PIP_FAILED',
      hint: noWheel
        ? 'There is no ready-made sherpa-onnx for this Python or CPU; Claude Anywhere retries with uv and Python 3.12.'
        : 'Check your internet connection (and HTTPS_PROXY / pip.conf index settings), then run: anywhere clone-voice install',
    });
  }

  /** @private the venv imports sherpa_onnx and numpy */
  async importCheck(lay) {
    const r = await this.runner(
      lay.venvPython,
      ['-I', '-c', 'import sys, numpy, sherpa_onnx; print("ANYWHERE-OK %d.%d.%d %s %s" % (sys.version_info[0], sys.version_info[1], sys.version_info[2], sherpa_onnx.__version__, numpy.__version__))'],
      { timeoutMs: PROBE_TIMEOUT_MS, env: this.childEnv(lay), cwd: lay.root },
    );
    const m = /ANYWHERE-OK (\S+) (\S+) (\S+)/.exec(String(r.stdout || ''));
    if (r.error || r.code !== 0 || !m) {
      throw installError(`The voice runtime does not load: ${r.error ? r.error.message : tail(r.stderr || r.stdout, 300) || `exit ${r.code}`}`, {
        status: 500,
        code: 'VERIFY_FAILED',
        hint: lay.platform === 'win32' ? 'Install the Microsoft Visual C++ Redistributable (x64), then run: anywhere clone-voice install --force' : 'Reinstall: anywhere clone-voice install --force',
      });
    }
    return { python: m[1], sherpa: m[2], numpy: m[3] };
  }

  // ---------------------------------------------------------------- uv fallback

  /** @private a working uv: <root>/bin, PATH, or downloaded from its GitHub release */
  async ensureUv({ lay, report, signal }) {
    const exe = lay.platform === 'win32' ? 'uv.exe' : 'uv';
    const local = (lay.kind === 'wsl' ? path.posix.join : path.join)(lay.binDir, exe);
    const runs = async (bin) => {
      const r = await this.runner(bin, ['--version'], { timeoutMs: 20000, env: this.env });
      return !r.error && r.code === 0 && /^uv \d/.test(String(r.stdout || '').trim());
    };
    if (isFile(local) && (await runs(local))) return local;
    if (lay.kind !== 'wsl') {
      const onPath = this.which('uv');
      if (onPath && (await runs(onPath))) return onPath;
    }
    const plat = lay.kind === 'wsl' ? 'win32' : lay.platform;
    const arch = lay.kind === 'wsl' ? 'x64' : this.arch;
    const a = this.uvAssets[`${plat}:${arch}`];
    if (!a) throw installError(`uv has no build for ${plat} ${arch}`, { status: 503, code: 'NO_PYTHON' });
    const base = String(this.uvBase || this.env.ANYWHERE_CLONE_UV_BASE || models.DEFAULT_UV_BASE);
    const url = `${base.endsWith('/') ? base : `${base}/`}${a.name}`;
    const dl = path.join(lay.root, 'downloads', a.name);
    report('venv', 0.1, `Downloading uv ${models.UV_VERSION} (a Python installer, about 20 MB)…`);
    await this.fetchVerified(url, dl, { sha256: a.sha256, bytes: null, signal, onProgress: () => {} });
    const staging = path.join(lay.root, `uv.new-${process.pid}`);
    rmrf(staging);
    mkdirp(staging);
    try {
      await this.extract(dl, staging, a.name.endsWith('.zip') ? 'zip' : 'tar.gz', lay);
      const found = listFiles(staging).find((f) => path.basename(f) === exe);
      if (!found) throw installError(`The uv archive has no ${exe}`, { status: 502, code: 'BAD_ARCHIVE' });
      mkdirp(lay.binDir);
      rmrf(local);
      fs.renameSync(found, local);
      if (plat !== 'win32') fs.chmodSync(local, 0o755);
    } finally {
      rmrf(staging);
      rmrf(dl);
    }
    if (!(await runs(local))) throw installError('The downloaded uv does not run on this machine', { status: 502, code: 'UV_FAILED' });
    return local;
  }

  /** @private uv venv (python-build-standalone 3.12) + uv pip install */
  async installWithUv({ lay, report, signal }) {
    const uv = await this.ensureUv({ lay, report, signal });
    const j = lay.kind === 'wsl' ? path.posix.join : path.join;
    const cp = (p) => (lay.toChildPath ? lay.toChildPath(p) : p);
    const env = this.childEnv(lay, {
      UV_PYTHON_INSTALL_DIR: cp(j(lay.root, 'python')),
      UV_CACHE_DIR: cp(j(lay.root, 'uv-cache')),
      UV_NO_CONFIG: '1',
      UV_PYTHON_PREFERENCE: 'only-managed',
      UV_NO_PROGRESS: '1',
    });
    report('venv', 0.4, `Creating a private Python ${UV_PYTHON} environment with uv (downloads Python, about 30 MB)…`);
    rmrf(lay.venvDir);
    const v = await this.runner(uv, ['venv', '--python', UV_PYTHON, cp(lay.venvDir)], { timeoutMs: VENV_TIMEOUT_MS, signal, env, cwd: lay.root });
    if (v.aborted) throw installError('The install was cancelled', { status: 499, code: 'ABORTED' });
    if (v.error || v.timedOut || v.code !== 0 || !isFile(lay.venvPython)) {
      rmrf(lay.venvDir);
      throw installError(`uv could not create the Python environment: ${v.error ? v.error.message : v.timedOut ? 'timed out' : tail(v.stderr || v.stdout, 300)}`, {
        status: 502,
        code: 'UV_FAILED',
        hint: 'Check your internet connection (GitHub must be reachable for the Python download), then run: anywhere clone-voice install',
      });
    }
    report('pip', 0.15, 'Installing sherpa-onnx and numpy with uv…');
    const r = await this.runner(uv, ['pip', 'install', '--python', cp(lay.venvPython), '--only-binary', ':all:', '-r', cp(this.requirementsFile())], {
      timeoutMs: PIP_TIMEOUT_MS,
      signal,
      env,
      cwd: lay.root,
      onStdout: this.pipProgress(report, 0.15, 0.9),
      onStderr: this.pipProgress(report, 0.15, 0.9),
    });
    if (r.aborted) throw installError('The install was cancelled', { status: 499, code: 'ABORTED' });
    if (r.error || r.timedOut || r.code !== 0) throw this.pipError(r);
  }

  // ---------------------------------------------------------------- models

  /**
   * Download (resumable), verify the sha256, then fall back to the next URL. A file placed in
   * `dest` by hand is used when its sha256 matches.
   * @private
   */
  async fetchVerified(urls, dest, { sha256, bytes, signal, onProgress }) {
    const list = Array.isArray(urls) ? urls : [urls];
    if (isFile(dest)) {
      if ((bytes == null || fileSize(dest) === bytes) && (await sha256File(dest)) === sha256) return { path: dest, url: null, reused: true };
      rmrf(dest);
    }
    let lastErr = null;
    let mismatch = null;
    for (const url of list) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.downloadFile(url, dest, {
            minBytes: bytes ? Math.min(bytes, 1024) : 1,
            maxBytes: bytes ? bytes + 1024 * 1024 : 100 * 1024 * 1024,
            signal,
            ca: this.ca,
            env: this.env,
            resume: attempt === 0,
            onProgress,
          });
        } catch (err) {
          if (err.code === 'ABORTED') throw installError('The install was cancelled', { status: 499, code: 'ABORTED' });
          lastErr = err;
          log.debug(`download ${url} failed: ${err.message}`);
          break; // next URL
        }
        const got = await sha256File(dest);
        if (got === sha256 && (bytes == null || fileSize(dest) === bytes)) return { path: dest, url, reused: false };
        rmrf(dest);
        rmrf(`${dest}.part`);
        lastErr = mismatch = installError(`The downloaded ${path.basename(dest)} does not match its checksum (sha256 ${got.slice(0, 12)}…, expected ${sha256.slice(0, 12)}…): the upstream file changed`, {
          status: 502,
          code: 'CHECKSUM_MISMATCH',
          hint: 'Update Claude Anywhere (the model list pins each file), or report it if this version is current.',
        });
        // A corrupted resume gets one fresh download from the same URL.
      }
    }
    // A source with the wrong bytes says more than a later source that was unreachable.
    if (mismatch) throw mismatch;
    const first = list[list.length - 1];
    throw installError(`Could not download ${path.basename(dest)}: ${lastErr ? lastErr.message : 'no source'}`, {
      status: lastErr && lastErr.status ? lastErr.status : 502,
      code: (lastErr && lastErr.code) || 'DOWNLOAD_FAILED',
      hint: `Check your internet connection (and HTTPS_PROXY). Or download ${first} on another network and put it at ${dest}, then run: anywhere clone-voice install`,
    });
  }

  /**
   * Install one model asset (download, verify, unpack through staging, keep only what is used).
   * @param {string} id
   * @param {{lay?:object, force?:boolean, signal?:AbortSignal, report?:(frac:number, message:string, extra?:object)=>void}} [opts]
   */
  async installAsset(id, { lay, force = false, signal, report = () => {} } = {}) {
    lay = lay || (await this.layout());
    const a = this.asset(id);
    const p = pathsOf(a, lay.modelsDir);
    if (!force && this.assetState(id, lay.modelsDir).installed) {
      report(1, `${id} is installed.`);
      return { id, skipped: true };
    }
    mkdirp(lay.modelsDir);
    const name = path.posix.basename(a.path);
    const dl = path.join(lay.modelsDir, 'downloads', name);
    const urls = models.assetBases({ base: this.assetBase, env: this.env, defaultBase: this.defaultBase }).map((b) => `${b}${a.path}`);
    report(0, `Downloading ${a.use || id} (${mb(a.bytes)})…`);
    const got = await this.fetchVerified(urls, dl, {
      sha256: a.sha256,
      bytes: a.bytes,
      signal,
      onProgress: (pr) => report(Math.min(0.97, (pr.received || 0) / a.bytes), `Downloading ${a.use || id}… ${mb(pr.received || 0)} of ${mb(a.bytes)}`, { received: pr.received, total: a.bytes }),
    });
    report(0.97, a.archive ? `Unpacking ${id}…` : `Installing ${id}…`);
    const fresh = path.join(lay.modelsDir, `.new-${id}-${process.pid}`);
    const staging = path.join(lay.modelsDir, `.staging-${id}-${process.pid}`);
    rmrf(fresh);
    rmrf(staging);
    mkdirp(fresh);
    try {
      if (a.archive) {
        mkdirp(staging);
        await this.extract(dl, staging, a.archive, lay);
        const src = a.topDir ? path.join(staging, a.topDir) : staging;
        for (const rel of [...Object.values(a.files), ...(a.keep || [])]) {
          const from = path.join(src, ...rel.split('/'));
          const to = path.join(fresh, ...rel.split('/'));
          if (!exists(from)) {
            if (Object.values(a.files).includes(rel)) throw installError(`The ${id} archive has no ${rel}`, { status: 502, code: 'BAD_ARCHIVE', hint: 'Update Claude Anywhere: the upstream archive changed.' });
            continue;
          }
          mkdirp(path.dirname(to));
          fs.renameSync(from, to);
        }
      } else {
        const rel = Object.values(a.files)[0];
        fs.renameSync(dl, path.join(fresh, ...rel.split('/')));
      }
      writeJson(path.join(fresh, MARKER), { id, sha256: a.sha256, bytes: a.bytes, url: got.url, installedAt: new Date().toISOString(), files: Object.values(a.files) });
      rmrf(p.dir);
      fs.renameSync(fresh, p.dir);
    } catch (err) {
      rmrf(fresh);
      throw err;
    } finally {
      rmrf(staging);
      rmrf(dl);
      rmrf(`${dl}.part`);
    }
    report(1, `${id} is installed.`);
    return { id, skipped: false, url: got.url };
  }

  /** Remove an installed asset (e.g. the opt-in ZipVoice). @returns {boolean} whether it was there */
  async removeAsset(id) {
    const lay = await this.layout();
    const p = pathsOf(this.asset(id), lay.modelsDir);
    const had = exists(p.dir);
    rmrf(p.dir);
    return had;
  }

  /**
   * Unpack an archive into an existing empty folder: tar (bsdtar on Windows/macOS), then the
   * venv's Python tarfile module (no bzip2 binary needed).
   * @private
   */
  async extract(archive, dest, kind, lay) {
    lay = lay || (await this.layout());
    const plat = lay.kind === 'wsl' ? 'linux' : lay.platform; // WSL unpacks with the Linux tar into /mnt/c
    const attempts = [];
    const sysTar = plat === 'win32' ? path.win32.join(this.env.SystemRoot || this.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe') : null;
    const tar = plat === 'win32' ? (sysTar && isFile(sysTar) ? sysTar : null) : this.which('tar');
    const own = plat === 'win32' ? [] : ['--no-same-owner'];
    if (tar) {
      if (kind === 'zip') {
        if (plat !== 'linux') attempts.push([tar, ['-xf', archive, ...own, '-C', dest]]);
      } else {
        const flag = kind === 'tar.bz2' ? (plat === 'linux' ? '-xjf' : '-xf') : plat === 'linux' ? '-xzf' : '-xf';
        attempts.push([tar, [flag, archive, ...own, '-C', dest]]);
      }
    }
    if (kind === 'zip') {
      const unzip = plat === 'win32' ? null : this.which('unzip');
      if (unzip) attempts.push([unzip, ['-q', '-o', archive, '-d', dest]]);
      if (plat === 'win32') {
        const ps = this.which('powershell') || this.which('powershell.exe') || 'powershell.exe';
        const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
        const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(dest)} -Force`;
        attempts.push([ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]]);
      }
    } else if (isFile(lay.venvPython) && lay.kind !== 'wsl') {
      const code =
        'import sys, tarfile\n' +
        'src, dst = sys.argv[1], sys.argv[2]\n' +
        "with tarfile.open(src, 'r:*') as t:\n" +
        "    if hasattr(tarfile, 'data_filter'):\n" +
        "        t.extractall(dst, filter='data')\n" +
        '    else:\n' +
        '        for m in t.getmembers():\n' +
        "            if m.name.startswith(('/', '\\\\')) or '..' in m.name.replace('\\\\', '/').split('/') or m.issym() or m.islnk() or m.isdev():\n" +
        "                raise SystemExit('unsafe archive member: ' + m.name)\n" +
        '        t.extractall(dst)\n';
      attempts.push([lay.venvPython, ['-I', '-c', code, archive, dest]]);
    }
    const errors = [];
    for (const [cmd, args] of attempts) {
      const r = await this.runner(cmd, args, { timeoutMs: EXTRACT_TIMEOUT_MS, env: this.env });
      if (!r.error && !r.timedOut && r.code === 0) return;
      errors.push(`${path.basename(cmd)}: ${r.error ? r.error.message : r.timedOut ? 'timed out' : tail(r.stderr, 200) || `exit ${r.code}`}`);
      // A failed attempt may leave half a tree: start the next one clean.
      for (const e of fs.readdirSync(dest)) rmrf(path.join(dest, e));
    }
    throw installError(`Could not unpack ${path.basename(archive)}${errors.length ? `: ${errors.join('; ')}` : ': no tar found'}`, {
      status: 500,
      code: 'EXTRACT_FAILED',
      hint: plat === 'linux' ? 'Install tar and bzip2 (sudo apt install tar bzip2).' : undefined,
    });
  }

  // ---------------------------------------------------------------- verify, bench, sidecar

  /** @private start the sidecar, check every model, load the engine and the recognizer */
  async verify({ lay, engine, stt, required, report }) {
    report('verify', 0.1, 'Starting the voice runtime…');
    const client = this.clientFactory(await this.sidecarSpec({ threads: 2 }));
    try {
      const hello = await client.start();
      if (hello.runtimeError) throw installError(`The voice runtime does not load: ${hello.runtimeError}`, { code: 'VERIFY_FAILED', hint: 'Reinstall: anywhere clone-voice install --force' });
      const cp = (p) => client.childPath(p);
      const spec = required.map((id) => {
        const p = pathsOf(this.asset(id), lay.modelsDir);
        return { id, dir: cp(p.dir), files: Object.values(p.files).map(cp) };
      });
      const check = await client.request('models.check', { assets: spec }, { timeoutMs: 30000 });
      if (check.missing && check.missing.length) {
        throw installError(`Model files are missing: ${check.missing.map((m) => `${m.id}/${path.basename(String(m.file || ''))}`).join(', ')}`, { code: 'VERIFY_FAILED', hint: 'Reinstall: anywhere clone-voice install --force' });
      }
      report('verify', 0.4, `Loading the ${engine} voice engine…`);
      const tts = await client.request('tts.load', this.childParams(client, models.ttsLoadParams(engine, lay.modelsDir, { threads: 2 })), { timeoutMs: 180000 });
      report('verify', 0.7, 'Loading speech recognition…');
      const asr = await client.request('asr.load', this.childParams(client, models.asrLoadParams(stt, lay.modelsDir, { threads: 2 })), { timeoutMs: 180000 });
      report('verify', 1, `The voice runtime works (engine loaded in ${tts.loadMs} ms, recognizer in ${asr.loadMs} ms).`);
      return { hello, tts, asr };
    } finally {
      await client.stop().catch(() => {});
    }
  }

  /** @private convert the path-valued fields of load params for the child (WSL) */
  childParams(client, params) {
    const out = { ...params };
    for (const k of ['dir', 'vocoder', 'model']) if (typeof out[k] === 'string' && (out[k].includes('/') || out[k].includes('\\'))) out[k] = client.childPath(out[k]);
    if (out.files) out.files = Object.fromEntries(Object.entries(out.files).map(([k, v]) => [k, client.childPath(v)]));
    return out;
  }

  /**
   * Time synthesis on this machine (the models' own sample voices; no audio is kept) and save
   * <models>/bench.json. Pocket: 1/2/4 threads; ZipVoice (when installed): 2/4 threads × 2/3 steps.
   * @param {{engine?:string, threads?:number[], steps?:number[], signal?:AbortSignal, onProgress?:(p:{fraction:number, message:string})=>void}} [opts]
   * @returns {Promise<object>} the saved record {at, cpus, cpuModel, engines:{pocket?, zipvoice?}, recommended}
   */
  async bench({ engine, threads, steps, signal, onProgress } = {}) {
    const lay = await this.layout();
    const st = await this.status({ engine });
    if (!st.runtime.ok) throw installError('The voice runtime is not installed', { status: 503, code: 'NOT_INSTALLED', hint: 'Install it: anywhere clone-voice install' });
    const cpus = Math.max(1, (os.cpus() || []).length || 1);
    const plan = [];
    if (st.engines.pocket) plan.push({ engine: 'pocket', threads: threads || [1, 2, 4].filter((t) => t <= Math.max(2, cpus)), steps: steps || [0] });
    if (st.engines.zipvoice && (!engine || engine === 'zipvoice')) plan.push({ engine: 'zipvoice', threads: threads || [2, 4].filter((t) => t <= Math.max(2, cpus)), steps: steps || [2, 3] });
    if (engine && !plan.some((p) => p.engine === engine)) throw installError(`The ${engine} engine is not installed`, { status: 409, code: 'MODEL_MISSING', hint: `Install it: anywhere clone-voice install --engine ${engine}` });
    if (!plan.length) throw installError('No voice engine is installed', { status: 409, code: 'MODEL_MISSING', hint: 'Install it: anywhere clone-voice install' });
    const total = plan.reduce((n, p) => n + p.threads.length * p.steps.length, 0);
    let done = 0;
    const progress = (message) => {
      if (typeof onProgress === 'function') {
        try {
          onProgress({ fraction: total ? done / total : 1, message });
        } catch {
          /* ignore */
        }
      }
    };
    const record = { at: new Date().toISOString(), cpus, cpuModel: ((os.cpus() || [])[0] || {}).model || null, engines: {}, recommended: {} };
    const client = this.clientFactory(await this.sidecarSpec({ threads: 2 }));
    try {
      await client.start();
      for (const p of plan) {
        progress(`Timing the ${p.engine} voice…`);
        const params = this.childParams(client, { ...models.ttsLoadParams(p.engine, lay.modelsDir), threads: p.threads, steps: p.steps });
        const r = await client.request('bench', params, {
          timeoutMs: BENCH_TIMEOUT_MS,
          signal,
          onEvent: (e) => {
            if (e.event !== 'bench.progress') return;
            done += 1;
            progress(`${p.engine}: ${e.threads} thread${e.threads === 1 ? '' : 's'}${p.engine === 'zipvoice' ? `, ${e.steps} steps` : ''}: ${e.rtf == null ? '?' : `${e.rtf}× real time`}`);
          },
        });
        record.engines[p.engine] = { runs: r.runs, best: r.best };
      }
    } catch (err) {
      if (err.code === 'ABORTED') throw installError('The speed test was cancelled', { status: 499, code: 'ABORTED' });
      throw err;
    } finally {
      await client.stop().catch(() => {});
    }
    const pocket = record.engines.pocket;
    if (pocket && pocket.best) record.recommended.pocket = { threads: pocket.best.threads, rtf: pocket.best.rtf, realtime: pocket.best.rtf != null && pocket.best.rtf <= 0.9 };
    const zip = record.engines.zipvoice;
    if (zip) {
      // §3.2: ZipVoice speaks live only at RTF ≤ 0.75 with ≤ 4 threads and 2–3 steps.
      const live = (zip.runs || []).filter((r) => r.rtf != null && r.rtf <= 0.75 && r.threads <= 4 && r.steps >= 2 && r.steps <= 3).sort((a, b) => b.steps - a.steps || a.rtf - b.rtf)[0];
      record.recommended.zipvoice = live ? { threads: live.threads, steps: live.steps, rtf: live.rtf, live: true } : { live: false, rtf: zip.best ? zip.best.rtf : null };
    }
    writeJson(path.join(lay.modelsDir, 'bench.json'), record);
    progress('The speed test finished.');
    return record;
  }

  /**
   * SidecarClient options for this runtime.
   * @param {{config?:object, threads?:number, fake?:boolean}} [opts] fake: run sidecar.py in fake mode
   *   with any python3 (tests and the UI without models).
   * @returns {Promise<object>}
   */
  async sidecarSpec({ config, threads, fake = false } = {}) {
    const lay = await this.layout();
    const clone = (config && config.voice && config.voice.clone) || {};
    const n = Math.max(1, Math.min(16, Number(threads || clone.threads) || 2));
    let python = lay.venvPython;
    if (fake) {
      python = this.pythonOption || this.env.ANYWHERE_PYTHON || this.which('python3') || this.which('python') || 'python3';
    } else if (!isFile(lay.venvPython)) {
      throw installError('The cloned-voice runtime is not installed', { status: 503, code: 'NOT_INSTALLED', hint: 'Install it (free, about 425 MB): anywhere clone-voice install' });
    }
    const cp = (p) => (lay.toChildPath ? lay.toChildPath(p) : p);
    const state = this.stateDir();
    fs.mkdirSync(path.join(state, 'run', 'voice-tmp'), { recursive: true, mode: 0o700 });
    let env = { ...this.env, OMP_NUM_THREADS: String(n), PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1' };
    for (const k of ['PYTHONHOME', 'PYTHONPATH']) delete env[k];
    if (fake) env.ANYWHERE_CLONE_FAKE = '1';
    else delete env.ANYWHERE_CLONE_FAKE;
    if (lay.kind === 'wsl') env = withWslEnv(env, ['OMP_NUM_THREADS', 'PYTHONNOUSERSITE', 'PYTHONUNBUFFERED', 'PYTHONIOENCODING', ...(fake ? ['ANYWHERE_CLONE_FAKE'] : [])]);
    return {
      python,
      script: this.sidecarScript(),
      args: ['--state', cp(state), '--models', cp(lay.modelsDir)],
      env,
      cwd: lay.kind === 'wsl' ? undefined : state,
      toChildPath: lay.toChildPath || undefined,
      windowsChild: lay.windowsChild,
      ...(lay.taskkill ? { taskkill: lay.taskkill } : {}),
      startTimeoutMs: 15000,
    };
  }

  /** A SidecarClient for this runtime (not started). */
  async createSidecar(opts = {}) {
    return this.clientFactory(await this.sidecarSpec(opts));
  }

  /** A started SidecarClient for this runtime. */
  async startSidecar(opts = {}) {
    const c = await this.createSidecar(opts);
    await c.start();
    return c;
  }

  /**
   * Remove the runtime and models (the voice profile is separate: profile.js deleteProfile()).
   * @param {{models?:boolean, venv?:boolean}} [opts]
   */
  async uninstall({ models: removeModels = true, venv = true } = {}) {
    const lay = await this.layout();
    if (venv) rmrf(lay.venvDir);
    if (removeModels) rmrf(lay.modelsDir);
    for (const d of ['bin', 'python', 'uv-cache']) rmrf(path.join(lay.root, d));
    return { ok: true };
  }
}

/** Every file under a folder (recursive, a few levels). */
function listFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 5) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

module.exports = { CloneInstaller, wslToWindowsPath, windowsToWslPath, withWslEnv, sha256File, RANGES, PY_MIN, PY_MAX };
