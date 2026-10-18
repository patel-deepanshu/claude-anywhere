'use strict';

/**
 * CloneService: consent-gated enrollment of the user's own voice, and synthesis in it
 * (docs/CALLS-DESIGN.md §2, §10.1).
 *
 *   status()                                   runtime, profile, active session
 *   install({engine, stt})                     the private venv and models (progress: 'install' events)
 *   startSession({ownerName})                  → {sessionId, consent:{text, expiresAt}, lines, ownerName}
 *   addTake(sessionId, kind, index, wav, {deviceLabel}) → {ok, quality, problems, transcript?, consent?}
 *   build(sessionId)                           → {ok, similarity, label, testAudioId, …}
 *   test(text, {engine, score})                → {audioId, similarity?, label?}
 *   synthesize(text, {engine}) / speak(text)   for calls (the phrase cache first)
 *   delete()                                   the profile, sessions, phrase cache; voice.clone.enabled=false
 *   getSidecar() / releaseSidecar()            the shared Python sidecar (calls use it too)
 *
 * Safeguards kept here (§1.3 a): a take is accepted only from a real microphone (virtual and
 * loopback device labels are refused), as 24 kHz mono 16-bit WAV, 2–30 s, at most 5 MB, recorded
 * in an enrollment session; the consent take must be read first and pass local STT with the
 * session's single-use code; at build time every take and the consent take must match the
 * speaker centroid (3D-Speaker cosine ≥ 0.45). The profile is written 0700/0600 and nothing is
 * ever uploaded. The sidecar only ever gets a profile directory, never a free audio path to clone.
 *
 * Events: 'install' {stage, percent, message} and 'session' {sessionId, step, …} (never the code).
 */

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const paths = require('../../shared/paths');
const { createLogger } = require('../../shared/log');
const script = require('./script');
const consentMod = require('./consent');
const quality = require('./quality');
const profile = require('./profile');

const log = createLogger('clone');

const KINDS = Object.freeze(['consent', 'line']);
const ENGINE_NAMES = Object.freeze(['pocket', 'zipvoice']);
const MIN_SPEAKER_COSINE = 0.45;
const AUDIO_ID_RE = /^[a-f0-9]{32}$/;
const MAX_AUDIO = 40;
const SIDECAR_IDLE_MS = 10 * 60 * 1000;
const OWNER_CACHE_MS = 10 * 60 * 1000;
const DEVICE_LABEL_MAX = 200;
const TEST_TEXT_MAX = 300;

/** The user-facing label of a clone similarity (3D-Speaker cosine of the test vs. the speaker, §2.6). */
function similarityLabel(s) {
  if (s == null || !Number.isFinite(s)) return null;
  if (s >= 0.55) return 'Very close';
  if (s >= 0.4) return 'Close';
  return 'Recognizable, not exact';
}

function cloneError(status, message, code, hint, extra) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  if (hint) e.hint = hint;
  if (extra) Object.assign(e, extra);
  return e;
}

/** require('./<name>') or null when that file does not exist (other load errors propagate). */
function optionalModule(rel) {
  try {
    return require(rel);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(path.basename(rel))) return null;
    throw err;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* gone or busy */
  }
}

/** The analysis fields the API returns (rounded, no internals). */
function publicAnalysis(a) {
  if (!a) return null;
  return {
    durationS: a.durationS,
    voicedS: a.voicedS,
    speechDbfs: a.speechDbfs,
    noiseDbfs: a.noiseDbfs,
    snrDb: a.snrDb,
    clipPct: a.clipPct,
    peakDbfs: a.peakDbfs,
    bandPct: a.bandPct,
  };
}

const NOT_READY_CODES = ['MODEL_MISSING', 'NOT_INSTALLED', 'RUNTIME_MISSING', 'ENOENT', 'SIDECAR_START_TIMEOUT', 'PYTHON_MISSING', 'NO_PYTHON', 'VENV_MISSING'];
const NOT_INSTALLED_HINT = 'Install the free voice runtime first: anywhere clone-voice install (or the Install step in the enrollment view).';

/** Map sidecar/installer errors to HTTP-ish errors with hints. */
function sidecarError(err) {
  if (!err || err.status) return err;
  const code = err.code || 'INTERNAL';
  if (NOT_READY_CODES.includes(code)) {
    return cloneError(503, `The voice runtime is not ready: ${err.message}`, code === 'MODEL_MISSING' ? 'MODEL_MISSING' : 'NOT_INSTALLED', err.hint || NOT_INSTALLED_HINT);
  }
  if (code === 'SIDECAR_EXITED' || code === 'SIDECAR_NOT_RUNNING' || code === 'SIDECAR_PROTOCOL' || code === 'SIDECAR_TIMEOUT') {
    return cloneError(503, `The voice runtime stopped: ${err.message}`, code, err.hint || 'Try again; if it keeps failing: anywhere clone-voice status');
  }
  if (code === 'PROFILE_INVALID') return cloneError(409, err.message, code, 'Record your voice again: anywhere clone-voice');
  return cloneError(502, `The voice runtime failed: ${err.message}`, code, err.hint);
}

/**
 * Request parameters with local absolute paths converted for the sidecar process (WSL runs a
 * Windows Python: SidecarClient.childPath does `wslpath -w`). Names such as 'moonshine' stay.
 */
function childParams(sc, params) {
  if (!sc || typeof sc.childPath !== 'function' || !params || typeof params !== 'object') return params;
  const conv = (v) => {
    if (typeof v === 'string') return path.isAbsolute(v) ? sc.childPath(v) : v;
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = conv(x);
      return o;
    }
    return v;
  };
  const out = {};
  for (const [k, v] of Object.entries(params)) out[k] = k === 'text' ? v : conv(v);
  return out;
}

/** The OS user's full name, best effort ('' when unknown). */
function osFullName({ platform = process.platform, exec = require('child_process').execFileSync } = {}) {
  let user = '';
  try {
    user = os.userInfo().username || '';
  } catch {
    user = process.env.USER || process.env.USERNAME || '';
  }
  const run = (cmd, args) => {
    try {
      return String(exec(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }) || '').trim();
    } catch {
      return '';
    }
  };
  let full = '';
  if (platform === 'darwin') full = run('id', ['-F']);
  else if (platform !== 'win32' && user) {
    const line = run('getent', ['passwd', user]);
    const gecos = line.split(':')[4] || '';
    full = gecos.split(',')[0];
  }
  return script.cleanName(full);
}

class CloneService extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.config] the live config (read on every use)
   * @param {(partial:object)=>any} [opts.saveConfig] persist a config change (default: config.save)
   * @param {string} [opts.root] the clone root (default <state>/voice/clone)
   * @param {string} [opts.modelsRoot] default <state>/voice/clone-models
   * @param {string} [opts.tmpDir] where test renders go (default <state>/run/voice-tmp)
   * @param {object} [opts.installer] a CloneInstaller (default: ./installer, created lazily)
   * @param {(svc:CloneService)=>Promise<object>} [opts.sidecarFactory] returns a started SidecarClient
   * @param {(ctx:{config:object})=>Promise<string>|string} [opts.ownerNameLookup] extra name source (tests)
   * @param {()=>number} [opts.clock]
   * @param {(min:number,max:number)=>number} [opts.randomInt] for the consent code (tests)
   * @param {{platform:string}} [opts.platformInfo]
   * @param {Function} [opts.runner] process runner for icacls (Windows)
   * @param {boolean} [opts.lookupJira] look the owner up in Jira (default true)
   * @param {number} [opts.idleMs] stop an idle sidecar after this long (0 = never)
   * @param {{debug:Function, info:Function, warn:Function, error:Function}} [opts.log]
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.log = opts.log || log;
    this.config = opts.config || require('../../shared/config').load();
    this.root = opts.root ? path.resolve(opts.root) : null;
    this.modelsRoot = opts.modelsRoot || null;
    this.tmpDirPath = opts.tmpDir || null;
    this.clock = typeof opts.clock === 'function' ? opts.clock : Date.now;
    this.randomInt = opts.randomInt;
    this.platformInfo = opts.platformInfo || { platform: process.platform };
    this.idleMs = opts.idleMs == null ? SIDECAR_IDLE_MS : opts.idleMs;
    this.sessions = new Map();
    this.audio = new Map();
    this.openSeq = 0;
    this.openAck = 0;
    this.openAt = 0;
    this._installer = opts.installer || null;
    this._install = null;
    this.lastInstall = null;
    this._sidecar = null;
    this._sidecarStarting = null;
    this._holds = 0;
    this._idleTimer = null;
    this._chain = Promise.resolve();
    this._owner = null;
    this._closed = false;
    this._resetLoaded();
  }

  // ---------------------------------------------------------------- config and paths

  cloneConfig() {
    const v = (this.config && this.config.voice) || {};
    const c = v.clone || {};
    return {
      enabled: c.enabled === true,
      engine: ENGINE_NAMES.includes(c.engine) ? c.engine : 'pocket',
      threads: Number.isInteger(c.threads) && c.threads > 0 ? c.threads : 2,
      steps: Number.isInteger(c.steps) && c.steps > 0 ? c.steps : 0,
      provider: ['cpu', 'cuda', 'coreml'].includes(c.provider) ? c.provider : 'cpu',
    };
  }

  sttModel() {
    const calls = (this.config && this.config.calls) || {};
    return (calls.stt && calls.stt.model) || 'moonshine';
  }

  saveConfig(partial) {
    try {
      if (typeof this.opts.saveConfig === 'function') return this.opts.saveConfig(partial);
      const configMod = require('../../shared/config');
      const next = configMod.save(partial);
      if (this.config && typeof this.config === 'object') for (const k of Object.keys(next)) this.config[k] = next[k];
      return next;
    } catch (err) {
      this.log.warn(`saving the clone settings failed: ${err.message}`);
      return null;
    }
  }

  cloneRoot() {
    return profile.cloneRoot(this.root);
  }

  models() {
    return require('./models');
  }

  modelsDir() {
    if (this.modelsRoot) return this.modelsRoot;
    const inst = this.installer();
    for (const k of ['modelsRoot', 'modelsDir']) {
      const v = inst && inst[k];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'function') return v.call(inst);
    }
    return path.join(this.root ? path.dirname(this.root) : paths.voiceDir(), 'clone-models');
  }

  tmpDir() {
    const dir = this.tmpDirPath || path.join(paths.runDir(), 'voice-tmp');
    return profile.ensurePrivateDir(dir);
  }

  tmpFile(prefix = 'clone') {
    return path.join(this.tmpDir(), `${prefix}-${crypto.randomBytes(12).toString('hex')}.wav`);
  }

  // ---------------------------------------------------------------- installer

  /** The CloneInstaller (null when the runtime module is missing from this install). */
  installer() {
    if (this._installer) return this._installer;
    const mod = optionalModule('./installer');
    if (!mod || typeof mod.CloneInstaller !== 'function') return null;
    const root = this.root ? path.dirname(this.root) : paths.voiceDir();
    this._installer = new mod.CloneInstaller({ root, env: process.env, ...(this.opts.platformInfo ? { platformInfo: this.opts.platformInfo } : {}) });
    return this._installer;
  }

  /**
   * The runtime's state, normalized: {installed, available, engines:{pocket, zipvoice}, stt, bench, missing, python, reason?}.
   */
  async runtimeStatus() {
    const inst = this.installer();
    if (!inst || typeof inst.status !== 'function') {
      return { available: false, installed: false, engines: { pocket: false, zipvoice: false }, bench: null, missing: [], reason: 'The voice runtime is missing from this installation (src/voice/clone/installer.js).' };
    }
    let s;
    try {
      s = await inst.status({ config: this.config });
    } catch (err) {
      return { available: true, installed: false, engines: { pocket: false, zipvoice: false }, bench: null, missing: [], reason: err.message };
    }
    s = s || {};
    const engines = { pocket: false, zipvoice: false };
    const e = s.engines;
    if (Array.isArray(e)) for (const name of e) engines[typeof name === 'string' ? name : name && name.id] = true;
    else if (e && typeof e === 'object') {
      for (const [k, v] of Object.entries(e)) engines[k] = Boolean(v && typeof v === 'object' ? v.installed !== false && v.ready !== false : v);
    }
    const installed = Boolean(s.installed != null ? s.installed : s.ready);
    if (installed && !Object.values(engines).some(Boolean)) engines[this.cloneConfig().engine] = true;
    return { ...s, available: true, installed, engines, bench: s.bench || null, missing: Array.isArray(s.missing) ? s.missing : [] };
  }

  /** @returns {{stage:string, percent:number, message:string, engine:string}|null} */
  installProgress() {
    return this._install ? { ...this._install.progress } : null;
  }

  /**
   * Install the runtime and models (one install at a time; a second call joins the first).
   * @param {{engine?:string, stt?:string, signal?:AbortSignal}} [opts]
   */
  install({ engine, stt, signal } = {}) {
    const inst = this.installer();
    if (!inst || typeof inst.install !== 'function') {
      return Promise.reject(cloneError(503, 'The voice runtime is missing from this installation', 'NOT_AVAILABLE', 'Update Claude Anywhere, then run: anywhere clone-voice install'));
    }
    if (this._install) return this._install.promise;
    const eng = ENGINE_NAMES.includes(engine) ? engine : this.cloneConfig().engine;
    const job = { engine: eng, progress: { stage: 'python', percent: 0, message: 'Starting…', engine: eng } };
    const emit = (p) => {
      const pct = Number(p && p.percent);
      job.progress = {
        stage: String((p && p.stage) || job.progress.stage),
        percent: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : job.progress.percent,
        message: String((p && p.message) || ''),
        engine: eng,
      };
      this.emit('install', { ...job.progress });
    };
    this._install = job;
    job.promise = Promise.resolve()
      .then(() => inst.install({ engine: eng, stt: stt || this.sttModel(), config: this.config, onProgress: emit, signal }))
      .then(
        (r) => {
          if (job.progress.stage !== 'done') emit({ stage: 'done', percent: 100, message: 'The voice runtime is ready' });
          return r || { ok: true };
        },
        (err) => {
          // The installer reports its own 'error' stage; this covers failures before it could.
          if (job.progress.stage !== 'error') emit({ stage: 'error', percent: job.progress.percent, message: err && err.hint ? `${err.message}. ${err.hint}` : (err && err.message) || String(err) });
          throw err;
        },
      )
      .finally(() => {
        this.lastInstall = { ...job.progress, at: new Date(this.clock()).toISOString() };
        if (this._install === job) this._install = null;
        // A new runtime or new models: the next request starts a fresh sidecar.
        this.stopSidecar().catch(() => {});
      });
    emit(job.progress);
    return job.promise;
  }

  /** The install-time speed benchmark (the installer runs it through the sidecar). */
  async bench(opts = {}) {
    const inst = this.installer();
    if (!inst || typeof inst.bench !== 'function') throw cloneError(503, 'The voice runtime is missing from this installation', 'NOT_AVAILABLE');
    try {
      return await inst.bench({ config: this.config, ...opts });
    } catch (err) {
      throw sidecarError(err);
    }
  }

  // ---------------------------------------------------------------- sidecar

  _resetLoaded() {
    this._loaded = { tts: null, voice: null, asr: null, spk: false };
  }

  /** A started sidecar (shared). Calls that need it for a while hold it: holdSidecar()/releaseSidecar(). */
  async getSidecar() {
    if (this._closed) throw cloneError(503, 'The voice service is shutting down', 'SHUTTING_DOWN');
    if (this._sidecar && this._sidecar.running !== false) return this._sidecar;
    if (this._sidecarStarting) return this._sidecarStarting;
    this._sidecarStarting = (async () => {
      let client;
      try {
        client = await (typeof this.opts.sidecarFactory === 'function' ? this.opts.sidecarFactory(this) : this._defaultSidecar());
      } catch (err) {
        throw sidecarError(err);
      }
      this._resetLoaded();
      if (client && typeof client.on === 'function') {
        client.on('exit', (info) => {
          if (this._sidecar !== client) return;
          this._sidecar = null;
          this._resetLoaded();
          this.log.warn(`the voice sidecar exited${info && info.code != null ? ` (code ${info.code})` : ''}`);
        });
      }
      this._sidecar = client;
      return client;
    })().finally(() => {
      this._sidecarStarting = null;
    });
    return this._sidecarStarting;
  }

  /** Keep the sidecar running (no idle stop) until releaseSidecar(); returns the sidecar. */
  async holdSidecar() {
    this._holds += 1;
    try {
      return await this.getSidecar();
    } catch (err) {
      this._holds = Math.max(0, this._holds - 1);
      throw err;
    }
  }

  releaseSidecar() {
    this._holds = Math.max(0, this._holds - 1);
    this._touch();
  }

  /** @private start the runtime's sidecar through the installer and B1's SidecarClient */
  async _defaultSidecar() {
    const inst = this.installer();
    if (!inst) throw cloneError(503, 'The voice runtime is missing from this installation', 'NOT_AVAILABLE', NOT_INSTALLED_HINT);
    if (typeof inst.startSidecar === 'function') return inst.startSidecar({ config: this.config });
    if (typeof inst.createSidecar === 'function') {
      const c = await inst.createSidecar({ config: this.config });
      if (c && typeof c.start === 'function' && !c.running) await c.start();
      return c;
    }
    const clientMod = optionalModule('./client');
    if (!clientMod || typeof clientMod.SidecarClient !== 'function') throw cloneError(503, 'The voice runtime client is missing from this installation', 'NOT_AVAILABLE');
    const getOpts = typeof inst.sidecarOptions === 'function' ? inst.sidecarOptions : inst.sidecarSpec;
    const spec = typeof getOpts === 'function' ? await getOpts.call(inst, { config: this.config }) : null;
    if (!spec || !spec.python) throw cloneError(503, 'The voice runtime is not installed', 'NOT_INSTALLED', NOT_INSTALLED_HINT);
    const client = new clientMod.SidecarClient(spec);
    await client.start();
    return client;
  }

  _touch() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
    if (!this.idleMs || this._closed) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this._holds > 0 || this._building) return;
      this.stopSidecar().catch(() => {});
    }, this.idleMs);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  async stopSidecar() {
    const sc = this._sidecar;
    this._sidecar = null;
    this._resetLoaded();
    if (sc && typeof sc.stop === 'function') {
      try {
        await sc.stop();
      } catch (err) {
        this.log.warn(`stopping the voice sidecar failed: ${err.message}`);
      }
    }
  }

  /** One sidecar request (errors mapped to HTTP-ish errors). */
  async request(op, params = {}, opts = {}) {
    const sc = await this.getSidecar();
    this._touch();
    try {
      return await sc.request(op, childParams(sc, params), opts);
    } catch (err) {
      throw sidecarError(err);
    } finally {
      this._touch();
    }
  }

  /** Run model loads one after another (two requests must not both load a model). */
  _serial(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  async _ensureTts(engine) {
    const c = this.cloneConfig();
    const eng = ENGINE_NAMES.includes(engine) ? engine : c.engine;
    await this.getSidecar();
    if (this._loaded.tts === eng) return eng;
    const params = this.models().ttsLoadParams(eng, this.modelsDir(), { threads: c.threads, provider: c.provider, steps: c.steps });
    await this.request('tts.load', params, { timeoutMs: 180000 });
    this._loaded.tts = eng;
    this._loaded.voice = null;
    return eng;
  }

  /** Load the engine and the verified profile into the sidecar (tts.setVoice takes only the profile folder). */
  async _ensureVoice(engine) {
    return this._serial(async () => {
      const v = profile.verifyProfile(profile.DEFAULT_PROFILE, { root: this.root });
      if (!v.ok) {
        if (!v.exists) throw cloneError(409, 'No cloned voice yet', 'NO_PROFILE', 'Record your voice first: /anywhere:clone-voice (or: anywhere clone-voice)');
        throw cloneError(409, `The voice profile cannot be used: ${v.reason}`, 'PROFILE_INVALID', 'Record your voice again: anywhere clone-voice');
      }
      const eng = await this._ensureTts(engine);
      const key = `${eng}:${v.dir}:${v.manifest.reference.sha256}`;
      if (this._loaded.voice !== key) {
        await this.request('tts.setVoice', { profileDir: v.dir }, { timeoutMs: 120000 });
        this._loaded.voice = key;
      }
      return { engine: eng, dir: v.dir, manifest: v.manifest };
    });
  }

  async _ensureAsr() {
    return this._serial(async () => {
      const stt = this.sttModel();
      await this.getSidecar();
      if (this._loaded.asr === stt) return;
      const c = this.cloneConfig();
      await this.request('asr.load', this.models().asrLoadParams(stt, this.modelsDir(), { threads: c.threads, provider: c.provider }), { timeoutMs: 180000 });
      this._loaded.asr = stt;
    });
  }

  async _ensureSpk() {
    return this._serial(async () => {
      await this.getSidecar();
      if (this._loaded.spk) return;
      const c = this.cloneConfig();
      await this.request('spk.load', this.models().spkLoadParams(this.modelsDir(), { threads: c.threads, provider: c.provider }), { timeoutMs: 120000 });
      this._loaded.spk = true;
    });
  }

  /** Local STT of a WAV file. */
  async transcribe(file) {
    await this._ensureAsr();
    const r = await this.request('asr.transcribe', { wav: file }, { timeoutMs: 120000 });
    return String((r && r.text) || '').trim();
  }

  /**
   * Speaker consistency: cosine of each WAV (and the probe) to the centroid of `wavs`.
   * @returns {Promise<{scores:number[], probe:number|null}>}
   */
  async consistency(wavs, probe) {
    await this._ensureSpk();
    const r = await this.request('spk.consistency', probe ? { wavs, probe } : { wavs }, { timeoutMs: 300000 });
    const num = (x) => {
      if (x && typeof x === 'object') x = x.score != null ? x.score : x.cosine;
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };
    const scores = Array.isArray(r && r.scores) ? r.scores.map(num) : [];
    return { scores, probe: probe ? num(r && r.probe) : null };
  }

  // ---------------------------------------------------------------- owner name

  /**
   * The owner's full name for the consent sentence: the name typed in the enrollment view, else
   * calls.ownerName, else the Jira account's display name, else the OS user's full name.
   * @param {{explicit?:string, refresh?:boolean}} [opts]
   * @returns {Promise<{name:string, source:'typed'|'settings'|'jira'|'os'|'lookup'|'none'}>}
   */
  async resolveOwnerName({ explicit, refresh = false } = {}) {
    const typed = script.cleanName(explicit);
    if (typed) return { name: typed, source: 'typed' };
    const set = script.cleanName(((this.config && this.config.calls) || {}).ownerName);
    if (set) return { name: set, source: 'settings' };
    if (!refresh && this._owner && this.clock() - this._owner.at < OWNER_CACHE_MS) return { name: this._owner.name, source: this._owner.source };
    let found = { name: '', source: 'none' };
    if (typeof this.opts.ownerNameLookup === 'function') {
      try {
        const n = script.cleanName(await this.opts.ownerNameLookup({ config: this.config }));
        if (n) found = { name: n, source: 'lookup' };
      } catch {
        /* next source */
      }
    }
    if (!found.name && this.opts.lookupJira !== false) {
      const n = await this._jiraName();
      if (n) found = { name: n, source: 'jira' };
    }
    if (!found.name && this.opts.lookupOs !== false) {
      const n = osFullName({ platform: this.platformInfo.platform });
      if (n) found = { name: n, source: 'os' };
    }
    this._owner = { ...found, at: this.clock() };
    return found;
  }

  async _jiraName() {
    try {
      const jira = require('../../integrations/jira');
      const s = jira.currentSettings(this.config);
      if (!s || !s.configured) return '';
      const client = new jira.JiraClient({ baseUrl: s.baseUrl, email: s.email, apiToken: s.apiToken });
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 6000);
      if (t.unref) t.unref();
      try {
        const me = await client.myself({ signal: ac.signal });
        return script.cleanName(me && me.displayName);
      } finally {
        clearTimeout(t);
      }
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------- status

  /** The profile as the API shows it. */
  profileStatus() {
    const v = profile.verifyProfile(profile.DEFAULT_PROFILE, { root: this.root });
    const m = v.manifest || null;
    return {
      exists: v.exists,
      ok: v.ok,
      reason: v.ok || !v.exists ? null : v.reason,
      engine: (m && m.engine) || null,
      createdAt: (m && m.createdAt) || null,
      ownerName: (m && m.ownerName) || null,
      referenceSeconds: (m && m.reference && m.reference.seconds) || null,
      testSimilarity: m && m.test && Number.isFinite(m.test.similarity) ? m.test.similarity : null,
      testLabel: m && m.test ? similarityLabel(m.test.similarity) : null,
    };
  }

  /** The active session's summary (no code), or null. */
  activeSession() {
    const s = [...this.sessions.values()].pop();
    return s ? { sessionId: s.id, state: s.state, consentPassed: Boolean(s.consentTake), takes: s.takes.size, total: script.LINES.length } : null;
  }

  /**
   * @param {{light?:boolean}} [opts] light: no runtime probe and no owner lookup (cheap polling)
   */
  async status({ light = false } = {}) {
    const c = this.cloneConfig();
    const out = {
      enabled: c.enabled,
      engine: c.engine,
      profile: this.profileStatus(),
      session: this.activeSession(),
      openSeq: this.openSeq,
      openAck: this.openAck,
      openAgeMs: this.openAt ? Math.max(0, this.clock() - this.openAt) : null,
      installing: this.installProgress(),
      lastInstall: this.lastInstall || null,
    };
    if (light) return out;
    const rt = await this.runtimeStatus();
    const owner = await this.resolveOwnerName();
    return {
      ...out,
      installed: rt.installed,
      available: rt.available,
      engines: rt.engines,
      bench: rt.bench,
      runtime: rt,
      owner,
      pronoun: script.pronounOf(((this.config && this.config.calls) || {}).ownerPronoun),
      lines: script.LINES.length,
      sidecar: Boolean(this._sidecar),
    };
  }

  /** The dialog was asked to show the enrollment view (anywhere clone-voice start). */
  requestOpen() {
    this.openSeq += 1;
    this.openAt = this.clock();
    this.emit('session', { sessionId: null, step: 'open', seq: this.openSeq });
    return this.openSeq;
  }

  /** A dialog page opened the enrollment view for request `seq`. */
  ackOpen(seq) {
    const n = Number(seq);
    if (Number.isInteger(n) && n > this.openAck && n <= this.openSeq) this.openAck = n;
    return this.openAck;
  }

  // ---------------------------------------------------------------- sessions

  _emitSession(id, step, extra = {}) {
    this.emit('session', { sessionId: id, step, ...extra });
  }

  _session(id) {
    const s = typeof id === 'string' ? this.sessions.get(id) : null;
    if (!s) throw cloneError(404, 'No such enrollment session (it may have expired or been replaced)', 'NO_SESSION', 'Start the enrollment again: anywhere clone-voice');
    if (this.clock() - s.touchedAt > profile.SESSION_MAX_AGE_MS) {
      this._closeSession(s, 'expired');
      throw cloneError(404, 'The enrollment session expired', 'NO_SESSION', 'Start the enrollment again: anywhere clone-voice');
    }
    return s;
  }

  _closeSession(s, why = 'closed') {
    if (!s) return;
    this.sessions.delete(s.id);
    rmrf(s.dir);
    rmrf(path.join(profile.profilesRoot(this.root), `.staging-${s.id}`));
    this._emitSession(s.id, why === 'built' ? 'built' : 'closed', { reason: why });
  }

  /** Every accepted take of a session (the consent take too: §2.4 counts the whole session's speech). */
  _sessionTakes(s) {
    return [...(s.consentTake ? [s.consentTake] : []), ...s.takes.values()];
  }

  /** The session as the enrollment view needs it (includes the current consent sentence). */
  sessionPublic(s) {
    const takes = [];
    for (let i = 0; i < script.LINES.length; i += 1) {
      const t = s.takes.get(i);
      takes.push(t ? { index: i, ok: true, problems: t.problems, quality: publicAnalysis(t.analysis) } : { index: i, ok: false });
    }
    const voiced = quality.sessionVerdict(this._sessionTakes(s));
    return {
      sessionId: s.id,
      state: s.state,
      ownerName: s.ownerName,
      consent: s.consent.public(),
      consentTake: s.consentTake ? { ok: true, transcript: s.consentTake.transcript, similarity: s.consentTake.check.similarity } : null,
      lines: script.LINES.slice(),
      takes,
      voicedS: voiced.voicedS,
      needS: voiced.needS,
      ready: Boolean(s.consentTake) && s.takes.size === script.LINES.length && voiced.ok,
      limits: { maxBytes: quality.LIMITS.maxBytes, minSeconds: quality.LIMITS.minSeconds, maxSeconds: quality.LIMITS.maxSeconds, rate: quality.LIMITS.rate },
    };
  }

  /**
   * Start an enrollment session (replaces any other one).
   * @param {{ownerName?:string}} [opts]
   */
  async startSession({ ownerName } = {}) {
    const owner = await this.resolveOwnerName({ explicit: ownerName });
    if (!owner.name) {
      throw cloneError(400, 'Your name is needed for the consent sentence', 'OWNER_NAME', 'Type your name in the enrollment view, or: anywhere config set calls.ownerName "Your Name"');
    }
    if (owner.source === 'typed' && !script.cleanName(((this.config && this.config.calls) || {}).ownerName)) {
      this.saveConfig({ calls: { ownerName: owner.name } });
    }
    if ([...this.sessions.values()].some((x) => x.state === 'building')) throw cloneError(409, 'A voice is being built right now; wait a moment', 'BUSY');
    for (const old of [...this.sessions.values()]) this._closeSession(old, 'replaced');
    try {
      profile.cleanupSessions({ root: this.root, now: this.clock() });
    } catch {
      /* best effort */
    }
    const id = crypto.randomBytes(16).toString('hex');
    const dir = profile.ensurePrivateDir(profile.sessionDir(id, { root: this.root }));
    const now = this.clock();
    const s = {
      id,
      dir,
      ownerName: owner.name,
      createdAt: now,
      touchedAt: now,
      consent: new consentMod.ConsentTracker({ ownerName: owner.name, clock: this.clock, randomInt: this.randomInt }),
      consentTake: null,
      takes: new Map(),
      state: 'recording',
    };
    this.sessions.set(id, s);
    this._emitSession(id, 'started');
    return this.sessionPublic(s);
  }

  /** @returns {object} sessionPublic() of an existing session */
  getSession(id) {
    const s = this._session(id);
    if (!s.consentTake && s.consent.expired) s.consent.renew();
    return this.sessionPublic(s);
  }

  /** A fresh consent code (only before the consent take passed). */
  renewConsent(id) {
    const s = this._session(id);
    if (s.consentTake) throw cloneError(409, 'The consent was already recorded for this session', 'CONSENT_USED');
    s.touchedAt = this.clock();
    return s.consent.renew();
  }

  /** Discard a session and its takes. */
  cancelSession(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.state === 'building') throw cloneError(409, 'The voice is being built; wait a moment', 'BUSY');
    this._closeSession(s, 'cancelled');
    return true;
  }

  /**
   * Check and store one take.
   * @param {string} sessionId
   * @param {'consent'|'line'} kind
   * @param {number|string} index 0-based line index (ignored for consent)
   * @param {Buffer} wav raw audio/wav body
   * @param {{deviceLabel?:string}} [opts]
   */
  async addTake(sessionId, kind, index, wav, { deviceLabel } = {}) {
    const s = this._session(sessionId);
    if (s.state !== 'recording') throw cloneError(409, s.state === 'building' ? 'The voice is being built; wait a moment' : 'This session is finished', 'BUSY');
    if (!KINDS.includes(kind)) throw cloneError(400, 'kind must be consent or line', 'BAD_REQUEST');
    const label = typeof deviceLabel === 'string' ? deviceLabel.trim().slice(0, DEVICE_LABEL_MAX) : '';
    if (!label) throw cloneError(400, 'The microphone name is missing (X-Anywhere-Device-Label)', 'DEVICE_LABEL', 'Record in the enrollment view of the Claude Anywhere dialog.');
    if (quality.isVirtualDeviceLabel(label)) {
      throw cloneError(403, `"${label}" is a virtual or loopback device. Only your own voice from a real microphone can be recorded.`, 'VIRTUAL_DEVICE', 'Pick your built-in, USB or headset microphone in the device list.');
    }
    if (!Buffer.isBuffer(wav) || !wav.length) throw cloneError(400, 'The audio body is empty', 'BAD_WAV');
    if (wav.length > quality.LIMITS.maxBytes) throw cloneError(413, 'A take may be at most 5 MB', 'TOO_LARGE');
    let audio;
    try {
      audio = quality.readWav(wav);
    } catch (err) {
      throw cloneError(400, err.message, 'BAD_WAV');
    }
    if (audio.rate !== quality.LIMITS.rate || audio.channels !== 1 || audio.bits !== 16 || audio.format !== 'pcm') {
      throw cloneError(415, 'Takes must be 24 kHz mono 16-bit WAV, as the enrollment view records them', 'WAV_FORMAT');
    }
    if (audio.durationS < quality.LIMITS.minSeconds || audio.durationS > quality.LIMITS.maxSeconds) {
      const code = audio.durationS < quality.LIMITS.minSeconds ? 'too_short' : 'too_long';
      throw cloneError(422, audio.durationS < quality.LIMITS.minSeconds ? 'The take is shorter than 2 seconds: read the whole line.' : 'The take is longer than 30 seconds: record one line at a time.', 'TAKE_LENGTH', undefined, {
        problems: [{ code, level: 'fail', hint: code === 'too_short' ? quality.HINTS.too_short : 'Record one line at a time.' }],
      });
    }
    let idx = null;
    if (kind === 'line') {
      idx = Number(index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= script.LINES.length) throw cloneError(400, `index must be 0–${script.LINES.length - 1}`, 'BAD_REQUEST');
      if (!s.consentTake) throw cloneError(409, 'Record the consent sentence first', 'CONSENT_FIRST');
    } else if (s.consentTake) {
      throw cloneError(409, 'The consent was already recorded for this session', 'CONSENT_USED');
    }
    s.touchedAt = this.clock();
    const analysis = quality.analyse(audio);
    const v = quality.verdict(analysis, kind);
    const base = { kind, index: idx, quality: publicAnalysis(analysis), problems: v.problems };
    if (!v.ok) {
      this._emitSession(s.id, 'take', { kind, index: idx, ok: false });
      return { ok: false, ...base };
    }
    if (kind === 'line') {
      const file = path.join(s.dir, `line-${pad2(idx + 1)}.wav`);
      profile.writeFileSecure(file, wav);
      s.takes.set(idx, { index: idx, text: script.LINES[idx], file, analysis, problems: v.problems, deviceLabel: label, at: this.clock() });
      this._emitSession(s.id, 'take', { kind, index: idx, ok: true, done: s.takes.size, total: script.LINES.length });
      return { ok: true, ...base, progress: { done: s.takes.size, total: script.LINES.length } };
    }
    // The consent take: local STT, then the single-use code and the wording. One reading at a time;
    // each attempt has its own file, and only an accepted one becomes consent.wav.
    if (s.consentBusy) throw cloneError(409, 'The previous consent take is still being checked', 'BUSY');
    s.consentBusy = true;
    s.consentAttempts = (s.consentAttempts || 0) + 1;
    const attempt = path.join(s.dir, `consent-${s.consentAttempts}.wav`);
    try {
      profile.writeFileSecure(attempt, wav);
      let transcript;
      try {
        transcript = await this.transcribe(attempt);
      } catch (err) {
        rmrf(attempt);
        throw err;
      }
      if (!this.sessions.has(s.id)) {
        rmrf(attempt);
        throw cloneError(404, 'The enrollment session ended', 'NO_SESSION');
      }
      const r = s.consent.check(transcript);
      const consent = { ok: r.ok, similarity: r.similarity, nameHeard: r.nameHeard, reasons: r.reasons, hints: consentMod.reasonText(r.reasons) };
      if (r.renewed) consent.renewed = r.renewed;
      if (r.ok) {
        const file = path.join(s.dir, 'consent.wav');
        fs.renameSync(attempt, file);
        s.consentTake = { file, analysis, problems: v.problems, transcript, check: r, deviceLabel: label, at: this.clock(), text: s.consent.passed.text, code: s.consent.passed.code };
      } else {
        rmrf(attempt);
      }
      this._emitSession(s.id, 'consent', { ok: r.ok });
      return { ok: r.ok, ...base, transcript, consent };
    } finally {
      s.consentBusy = false;
    }
  }

  // ---------------------------------------------------------------- build

  /**
   * Speaker consistency, the reference clip, the profile, the test synthesis (§2.6).
   * @param {string} sessionId
   */
  async build(sessionId) {
    const s = this._session(sessionId);
    if (s.state === 'building') throw cloneError(409, 'The voice is already being built', 'BUSY');
    if (!s.consentTake) throw cloneError(409, 'Record the consent sentence first', 'CONSENT_FIRST');
    const missing = script.LINES.map((_, i) => i).filter((i) => !s.takes.has(i));
    if (missing.length) {
      throw cloneError(409, `${missing.length} line${missing.length === 1 ? ' is' : 's are'} still missing`, 'TAKES_MISSING', 'Record every line, then build.', { missing });
    }
    const takes = [...s.takes.values()].sort((a, b) => a.index - b.index);
    const sv = quality.sessionVerdict(this._sessionTakes(s));
    if (!sv.ok) {
      throw cloneError(409, `Only ${sv.voicedS} s of speech were recorded; ${sv.needS} s are needed`, 'NOT_ENOUGH_SPEECH', 'Re-record the shortest lines at a normal pace.');
    }
    s.state = 'building';
    s.touchedAt = this.clock();
    this._building = true;
    this._emitSession(s.id, 'building');
    try {
      return await this._build(s, takes);
    } catch (err) {
      if (this.sessions.has(s.id) && s.state === 'building') s.state = 'recording';
      this._emitSession(s.id, 'error', { message: err.message });
      throw err;
    } finally {
      this._building = false;
      this._touch();
    }
  }

  async _build(s, takes) {
    // 1. Speaker consistency: every take and the consent take against the centroid of the takes.
    const cons = await this.consistency(
      takes.map((t) => t.file),
      s.consentTake.file,
    );
    if (cons.scores.length !== takes.length || cons.scores.some((x) => x == null)) {
      throw cloneError(502, 'The speaker check returned no usable scores', 'INTERNAL');
    }
    if (cons.probe == null || cons.probe < MIN_SPEAKER_COSINE) {
      s.state = 'failed';
      this._closeSession(s, 'consent_mismatch');
      return {
        ok: false,
        code: 'CONSENT_SPEAKER_MISMATCH',
        message: 'The consent sentence and the script must be read by the same person, in the same room. Start again.',
        consentScore: cons.probe,
      };
    }
    const bad = takes.filter((t, i) => cons.scores[i] < MIN_SPEAKER_COSINE);
    if (bad.length) {
      for (const t of bad) {
        s.takes.delete(t.index);
        rmrf(t.file);
      }
      s.state = 'recording';
      this._emitSession(s.id, 'retake', { retake: bad.map((t) => t.index) });
      return {
        ok: false,
        code: 'TAKES_INCONSISTENT',
        retake: bad.map((t) => t.index),
        message: `${bad.length === 1 ? 'One line does' : `${bad.length} lines do`} not sound like the others. Record ${bad.length === 1 ? 'it' : 'them'} again in the same room and voice.`,
      };
    }
    const scores = cons.scores;
    const consistency = {
      min: Math.round(Math.min(...scores) * 1000) / 1000,
      mean: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000,
      consent: Math.round(cons.probe * 1000) / 1000,
    };

    // 2. The reference clip (pure Node): the 3–4 best takes, 10–15 s, trimmed, joined, normalized.
    const ref = quality.buildReference(
      takes.map((t) => {
        const a = quality.readWav(fs.readFileSync(t.file));
        return { index: t.index, text: t.text, samples: a.samples, rate: a.rate, analysis: t.analysis, problems: t.problems };
      }),
    );

    // 3. The profile, written to a staging folder and swapped in (an older profile is replaced
    //    only once the new one is complete).
    const c = this.cloneConfig();
    const engine = c.engine;
    const profilesDir = profile.profilesRoot(this.root);
    const staging = path.join(profilesDir, `.staging-${s.id}`);
    rmrf(staging);
    profile.ensurePrivateDir(staging);
    const refFile = path.join(staging, 'reference.wav');
    profile.writeFileSecure(refFile, quality.writeWav(ref.samples, ref.rate));
    profile.writeFileSecure(path.join(staging, 'reference.txt'), `${ref.text}\n`);
    profile.writeFileSecure(path.join(staging, 'consent.wav'), fs.readFileSync(s.consentTake.file));
    const ct = s.consentTake;
    const manifest = {
      version: profile.MANIFEST_VERSION,
      createdAt: new Date(this.clock()).toISOString(),
      ownerName: s.ownerName,
      engine,
      consent: {
        text: ct.text,
        codeHash: consentMod.codeHash(s.id, ct.code),
        transcript: ct.transcript,
        similarity: ct.check.similarity,
        nameHeard: ct.check.nameHeard,
        verified: true,
        verifiedAt: new Date(ct.at).toISOString(),
        deviceLabel: ct.deviceLabel,
        file: 'consent.wav',
      },
      reference: { file: 'reference.wav', seconds: ref.seconds, sha256: profile.sha256File(refFile), text: ref.text, takes: ref.takes.map((i) => i + 1) },
      quality: {
        takes: takes.map((t) => ({
          line: t.index + 1,
          durationS: t.analysis.durationS,
          voicedS: t.analysis.voicedS,
          snrDb: t.analysis.snrDb,
          speechDbfs: t.analysis.speechDbfs,
          clipPct: t.analysis.clipPct,
          bandPct: t.analysis.bandPct,
          warnings: t.problems.filter((p) => p.level === 'warn').map((p) => p.code),
        })),
        consent: publicAnalysis(ct.analysis),
      },
      consistency,
      test: { similarity: null, engine: null, at: null },
    };
    profile.writeFileSecure(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const dir = profile.profileDir(profile.DEFAULT_PROFILE, { root: this.root });
    rmrf(dir);
    fs.renameSync(staging, dir);
    await profile.lockDown(dir, { platform: this.platformInfo.platform, runner: this.opts.runner });
    this._loaded.voice = null;
    this.log.info(`voice profile built: ${ref.seconds} s reference from lines ${manifest.reference.takes.join(', ')}; consistency min ${consistency.min}, consent ${consistency.consent}`);
    this.saveConfig({ voice: { clone: { enabled: true, engine } } });

    // 4. The test sentence in the cloned voice, scored against the speaker centroid.
    let test = null;
    let testError = null;
    try {
      test = await this._renderTest({ engine, scoreAgainst: takes.map((t) => t.file) });
      this._updateManifest((m) => ({ ...m, test: { similarity: test.similarity, engine, at: new Date(this.clock()).toISOString() } }));
    } catch (err) {
      testError = err.message;
      this.log.warn(`the test synthesis failed: ${err.message}`);
    }

    // 5. The takes are no longer needed.
    s.state = 'built';
    this._closeSession(s, 'built');
    this.prerenderPhrases({ engine }).catch((err) => this.log.warn(`pre-rendering phrases failed: ${err.message}`));
    return {
      ok: true,
      engine,
      referenceSeconds: ref.seconds,
      consistency,
      similarity: test ? test.similarity : null,
      label: test ? test.label : null,
      testAudioId: test ? test.audioId : null,
      testText: test ? test.text : script.testSentence({ ownerName: s.ownerName, pronoun: this._pronoun() }),
      testError,
    };
  }

  _pronoun() {
    return script.pronounOf(((this.config && this.config.calls) || {}).ownerPronoun);
  }

  _ownerFromProfile() {
    const m = profile.readManifest(profile.DEFAULT_PROFILE, { root: this.root });
    return (m && m.ownerName) || script.cleanName(((this.config && this.config.calls) || {}).ownerName) || '';
  }

  _updateManifest(fn) {
    const m = profile.readManifest(profile.DEFAULT_PROFILE, { root: this.root });
    if (!m) return null;
    const next = fn(m);
    const file = path.join(profile.profileDir(profile.DEFAULT_PROFILE, { root: this.root }), 'manifest.json');
    profile.writeFileSecure(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  _registerAudio(file) {
    const id = crypto.randomBytes(16).toString('hex');
    this.audio.set(id, { file, at: this.clock() });
    while (this.audio.size > MAX_AUDIO) {
      const [oldId, old] = this.audio.entries().next().value;
      this.audio.delete(oldId);
      if (old.tmp !== false && old.file.startsWith(this.tmpDir() + path.sep)) rmrf(old.file);
    }
    return id;
  }

  /** The WAV behind an audio id from build()/test(), or null. */
  audioFile(id) {
    if (typeof id !== 'string' || !AUDIO_ID_RE.test(id)) return null;
    const e = this.audio.get(id);
    if (!e) return null;
    try {
      return fs.statSync(e.file).isFile() ? e.file : null;
    } catch {
      return null;
    }
  }

  async _renderTest({ engine, text, scoreAgainst }) {
    const say = text || script.testSentence({ ownerName: this._ownerFromProfile(), pronoun: this._pronoun() });
    const v = await this._ensureVoice(engine);
    const out = this.tmpFile('clone-test');
    const r = await this.request('tts.synthesize', { text: say, out }, { timeoutMs: 180000 });
    const file = out;
    const audioId = this._registerAudio(file);
    let similarity = null;
    if (scoreAgainst && scoreAgainst.length) {
      try {
        const c = await this.consistency(scoreAgainst, file);
        similarity = c.probe == null ? null : Math.round(c.probe * 1000) / 1000;
      } catch (err) {
        this.log.warn(`scoring the test voice failed: ${err.message}`);
      }
    }
    return { audioId, file, text: say, engine: v.engine, similarity, label: similarityLabel(similarity), ms: r && r.totalMs, audioMs: r && r.audioMs };
  }

  /**
   * Render a sentence in the cloned voice for the dialog (or the CLI).
   * @param {string} [text] default: the test sentence
   * @param {{engine?:string, score?:boolean}} [opts] score: similarity against the reference clip
   * @returns {Promise<{audioId:string, file:string, text:string, engine:string, similarity:number|null, label:string|null}>}
   */
  async test(text, { engine, score = false } = {}) {
    if (text != null && typeof text !== 'string') throw cloneError(400, 'text must be a string', 'BAD_REQUEST');
    const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, TEST_TEXT_MAX) : '';
    if (engine != null && !ENGINE_NAMES.includes(engine)) throw cloneError(400, `engine must be ${ENGINE_NAMES.join(' or ')}`, 'BAD_REQUEST');
    const dir = profile.profileDir(profile.DEFAULT_PROFILE, { root: this.root });
    const r = await this._renderTest({ engine, text: t || undefined, scoreAgainst: score ? [path.join(dir, 'reference.wav')] : null });
    if (score && r.similarity != null && !t) {
      this._updateManifest((m) => ({ ...m, test: { ...(m.test || {}), [`${r.engine}Similarity`]: r.similarity } }));
    }
    return r;
  }

  /**
   * Use another installed engine for the cloned voice (the enrollment's "quality voice" choice).
   * @param {'pocket'|'zipvoice'} engine
   */
  async setEngine(engine) {
    if (!ENGINE_NAMES.includes(engine)) throw cloneError(400, `engine must be ${ENGINE_NAMES.join(' or ')}`, 'BAD_REQUEST');
    const rt = await this.runtimeStatus();
    if (!rt.engines[engine]) throw cloneError(409, `The ${engine} engine is not installed`, 'NOT_INSTALLED', `Install it: anywhere clone-voice install --engine ${engine}`);
    this.saveConfig({ voice: { clone: { engine } } });
    this._updateManifest((m) => ({ ...m, engine }));
    this.prerenderPhrases({ engine }).catch((err) => this.log.warn(`pre-rendering phrases failed: ${err.message}`));
    return { ok: true, engine };
  }

  // ---------------------------------------------------------------- calls

  /** The sentences kept pre-rendered: the fillers, the test sentence and (when the calls module exists) the greeting. */
  phraseTexts() {
    const owner = this._ownerFromProfile();
    const texts = [...script.FILLERS, script.testSentence({ ownerName: owner, pronoun: this._pronoun() })];
    const greeting = optionalModule('../../calls/greeting');
    if (greeting && typeof greeting.composeGreeting === 'function' && owner) {
      try {
        const calls = (this.config && this.config.calls) || {};
        const g = greeting.composeGreeting({ callerName: '', ownerName: owner, ownerFirst: script.firstName(owner), pronoun: this._pronoun(), cloned: true, template: calls.greeting || '' });
        if (g && typeof g.text === 'string' && g.text) texts.push(g.text);
      } catch (err) {
        this.log.warn(`composing the greeting for the phrase cache failed: ${err.message}`);
      }
    }
    return [...new Set(texts)];
  }

  /** Render the phrase cache for an engine (skips phrases already there). */
  async prerenderPhrases({ engine } = {}) {
    const eng = ENGINE_NAMES.includes(engine) ? engine : this.cloneConfig().engine;
    const texts = this.phraseTexts();
    let rendered = 0;
    for (const text of texts) {
      const dest = profile.phrasePath(eng, text, { root: this.root });
      if (fs.existsSync(dest)) continue;
      await this._ensureVoice(eng);
      const out = this.tmpFile('clone-phrase');
      await this.request('tts.synthesize', { text, out }, { timeoutMs: 180000 });
      profile.ensurePrivateDir(path.dirname(dest));
      const src = out;
      try {
        fs.renameSync(src, dest);
      } catch {
        fs.copyFileSync(src, dest);
        rmrf(src);
      }
      try {
        fs.chmodSync(dest, 0o600);
      } catch {
        /* windows */
      }
      rendered += 1;
    }
    this.emit('session', { sessionId: null, step: 'phrases', engine: eng, rendered, total: texts.length });
    return { engine: eng, rendered, total: texts.length };
  }

  /**
   * A WAV of `text` in the cloned voice: the phrase cache first, then the chosen engine, then the
   * other installed clone engine. (The Piper fallback belongs to the caller.)
   * @returns {Promise<{file:string, cached:boolean, engine:string, audioMs?:number, sampleRate?:number}>}
   */
  async synthesize(text, { engine, useCache = true } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw cloneError(400, 'text must be a non-empty string', 'BAD_REQUEST');
    const first = ENGINE_NAMES.includes(engine) ? engine : this.cloneConfig().engine;
    const order = [first, ...ENGINE_NAMES.filter((e) => e !== first)];
    let lastErr = null;
    for (const eng of order) {
      if (useCache) {
        const cached = profile.phrasePath(eng, text, { root: this.root });
        if (fs.existsSync(cached)) return { file: cached, cached: true, engine: eng };
      }
      if (eng !== first) {
        const rt = await this.runtimeStatus();
        if (!rt.engines[eng]) break;
      }
      try {
        await this._ensureVoice(eng);
        const out = this.tmpFile('clone-say');
        const r = await this.request('tts.synthesize', { text, out }, { timeoutMs: 180000 });
        return { file: out, cached: false, engine: eng, audioMs: r && r.audioMs, sampleRate: r && r.sampleRate };
      } catch (err) {
        lastErr = err;
        if (err && (err.code === 'NO_PROFILE' || err.code === 'PROFILE_INVALID')) throw err;
      }
    }
    throw lastErr || cloneError(503, 'No clone engine is available', 'NOT_INSTALLED', NOT_INSTALLED_HINT);
  }

  /** Live speech through the sidecar's playback (calls). */
  async speak(text, { utteranceId, engine } = {}) {
    await this._ensureVoice(engine);
    return this.request('tts.say', { text, utteranceId: utteranceId || crypto.randomBytes(8).toString('hex') }, { timeoutMs: 120000 });
  }

  // ---------------------------------------------------------------- delete and shutdown

  /**
   * Delete the cloned voice: the profile (with the consent record), every session, the phrase cache
   * and the test audio; voice.clone.enabled becomes false. The sidecar is stopped so it forgets the voice.
   */
  async delete() {
    for (const s of [...this.sessions.values()]) {
      if (s.state === 'building') throw cloneError(409, 'The voice is being built; wait a moment, then delete it', 'BUSY');
    }
    for (const s of [...this.sessions.values()]) this._closeSession(s, 'deleted');
    await this.stopSidecar();
    const { removed } = profile.deleteProfile(profile.DEFAULT_PROFILE, { root: this.root });
    rmrf(path.join(profile.profilesRoot(this.root)));
    for (const [id, e] of this.audio) {
      this.audio.delete(id);
      rmrf(e.file);
    }
    this.saveConfig({ voice: { clone: { enabled: false } } });
    this.emit('session', { sessionId: null, step: 'deleted' });
    this.emit('deleted', { removed });
    this.log.info('the cloned voice was deleted');
    return { ok: true, removed: removed.length > 0 };
  }

  /** Stop the sidecar and timers (daemon shutdown). */
  async shutdown() {
    this._closed = true;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
    await this.stopSidecar();
  }
}

module.exports = {
  CloneService,
  KINDS,
  ENGINE_NAMES,
  MIN_SPEAKER_COSINE,
  AUDIO_ID_RE,
  similarityLabel,
  publicAnalysis,
  osFullName,
  cloneError,
};
