/**
 * Voice enrollment view (docs/CALLS-DESIGN.md §2.1, §10.7): an overlay inside the Claude Anywhere
 * dialog, or the whole page at /clone.html.
 *
 *   intro → install (when needed) → mic check → consent take → 14 script takes → build → test
 *
 * Safeguards kept here (§1.3 a): the user confirms they are the person being recorded; only live
 * microphone takes recorded in this view are uploaded (no file import); virtual and loopback input
 * devices are refused (the daemon checks the label again); browser processing (echo cancellation,
 * noise suppression, gain control) is off because it changes the timbre that gets cloned; the
 * consent code is shown only while the consent sentence is being recorded.
 *
 * Mounting (the dialog's loader): `import { mount } from './clone.js'; const view = mount();` then
 * `view.open()`. A mounted view also opens on its own when `anywhere clone-voice` asks for it (SSE
 * 'clone_session' {step:'open'} through the dialog's `anywhere:event` window events, or by polling
 * /api/clone/status when the dialog has no such hook) and on `window.dispatchEvent(new
 * CustomEvent('anywhere:clone-open'))`. The token comes from sessionStorage['anywhere.token'].
 */

import { StreamResampler, encodeWav, rms } from './wav-recorder.js';

export const TARGET_RATE = 24000;
export const MAX_TAKE_MS = 30000;
export const MIN_TAKE_MS = 2000;
const CHUNK = 2048;
const POLL_MS = 3000;
const OPEN_REQUEST_MAX_AGE_MS = 120000;
const ROOM_TONE_MS = 3000;
const STEPS = ['intro', 'install', 'mic', 'consent', 'lines', 'build', 'test'];
const STEP_LABEL = { intro: 'About', install: 'Install', mic: 'Microphone', consent: 'Consent', lines: 'Script', build: 'Build', test: 'Test' };

/** The same list as the daemon's check (src/voice/clone/quality.js). */
export const VIRTUAL_DEVICE_RE = /blackhole|vb-?audio|cable (in|out)put|claude-anywhere|monitor of|loopback|soundflower|virtual|stereo mix|aggregate|multi-output/i;

/** @param {*} label @returns {boolean} true for virtual or loopback input devices (refused) */
export function isVirtualDeviceLabel(label) {
  return typeof label === 'string' && VIRTUAL_DEVICE_RE.test(label);
}

/** Linear 0..1 meter position for an RMS level (−60 dBFS → 0, 0 dBFS → 1). */
export function meterLevel(level) {
  if (!(level > 0)) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(level) + 60) / 60));
}

/** dBFS of an RMS level. */
export function dbfs(level) {
  return Math.round(20 * Math.log10(Math.max(level, 1e-6)) * 10) / 10;
}

function micError(err) {
  const name = (err && err.name) || '';
  let e;
  if (err && err.code === 'virtual-device') return err;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    e = new Error('Microphone access is blocked. Allow the microphone for this page (the icon in the address bar); on macOS also in System Settings › Privacy & Security › Microphone.');
    e.code = 'not-allowed';
  } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    e = new Error('That microphone was not found. Pick another one, or connect it again.');
    e.code = 'not-found';
  } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    e = new Error('The microphone is busy. Close other apps that use it and try again.');
    e.code = 'busy';
  } else {
    e = new Error(`Could not start the microphone: ${(err && err.message) || name || 'unknown error'}`);
    e.code = 'audio-capture';
  }
  e.cause = err;
  return e;
}

/**
 * Records one take from a chosen microphone as 24 kHz mono 16-bit WAV, with the browser's
 * echo cancellation, noise suppression and gain control off.
 */
export class EnrollRecorder {
  /**
   * @param {{deviceId?:string, onLevel?:(level:number)=>void, maxMs?:number, onAutoStop?:()=>void}} [opts]
   */
  constructor({ deviceId = '', onLevel, maxMs = MAX_TAKE_MS, onAutoStop } = {}) {
    this.deviceId = deviceId;
    this.onLevel = typeof onLevel === 'function' ? onLevel : null;
    this.onAutoStop = typeof onAutoStop === 'function' ? onAutoStop : null;
    this.maxSamples = Math.round((maxMs / 1000) * TARGET_RATE);
    this.state = 'idle';
    this.chunks = [];
    this.samples = 0;
    this.label = '';
    this.peakLevel = 0;
    this.levels = [];
  }

  static isSupported() {
    const g = globalThis;
    return Boolean(g.navigator && g.navigator.mediaDevices && typeof g.navigator.mediaDevices.getUserMedia === 'function' && (g.AudioContext || g.webkitAudioContext));
  }

  /** The getUserMedia constraints (exported for tests). */
  static constraints(deviceId) {
    const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return { audio, video: false };
  }

  get durationMs() {
    return (this.samples / TARGET_RATE) * 1000;
  }

  async start() {
    if (this.state !== 'idle') throw new Error('This recorder was already started');
    this.state = 'starting';
    try {
      await this.open();
      if (this.state === 'starting') this.state = 'recording';
    } catch (err) {
      this.teardown();
      this.state = 'done';
      throw micError(err);
    }
  }

  /** @private */
  async open() {
    if (!EnrollRecorder.isSupported()) {
      const e = new Error('This browser cannot record audio.');
      e.code = 'unsupported';
      throw e;
    }
    this.stream = await navigator.mediaDevices.getUserMedia(EnrollRecorder.constraints(this.deviceId));
    const track = this.stream.getAudioTracks()[0];
    this.label = (track && track.label) || '';
    if (isVirtualDeviceLabel(this.label)) {
      const e = new Error(`"${this.label}" is a virtual or loopback device. Pick your real microphone: only your own live voice can be recorded.`);
      e.code = 'virtual-device';
      throw e;
    }
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
    this.resampler = new StreamResampler(this.ctx.sampleRate, TARGET_RATE);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    let usedWorklet = false;
    if (this.ctx.audioWorklet && typeof globalThis.AudioWorkletNode === 'function') {
      try {
        await this.ctx.audioWorklet.addModule(new URL('./wav-worklet.js', import.meta.url).href);
        this.node = new AudioWorkletNode(this.ctx, 'anywhere-wav-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { chunkSize: CHUNK } });
        this.node.port.onmessage = (e) => {
          const d = e.data || {};
          if (d.type === 'chunk' && d.samples) this.handleChunk(d.samples);
          else if (d.type === 'flushed') {
            if (d.samples && d.samples.length) this.handleChunk(d.samples);
            if (this.flushResolve) this.flushResolve();
          }
        };
        usedWorklet = true;
      } catch {
        this.node = null;
      }
    }
    if (!usedWorklet) {
      this.node = this.ctx.createScriptProcessor(CHUNK, 1, 1);
      this.node.onaudioprocess = (e) => {
        this.handleChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
        const out = e.outputBuffer.getChannelData(0);
        if (out && out.fill) out.fill(0);
      };
    }
    this.usedWorklet = usedWorklet;
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  /** @private */
  handleChunk(samples) {
    if (this.state !== 'recording' && this.state !== 'starting' && this.state !== 'stopping') return;
    const level = rms(samples);
    if (level > this.peakLevel) this.peakLevel = level;
    this.levels.push(level);
    if (this.onLevel) {
      try {
        this.onLevel(level);
      } catch {
        /* UI errors must not stop the recording */
      }
    }
    if (this.samples >= this.maxSamples) return;
    const out = this.resampler.push(samples);
    if (out.length) {
      this.chunks.push(out);
      this.samples += out.length;
    }
    if (this.samples >= this.maxSamples && this.state === 'recording' && this.onAutoStop && !this.autoStopped) {
      this.autoStopped = true;
      setTimeout(() => this.onAutoStop && this.onAutoStop(), 0);
    }
  }

  /** The RMS level below which 10% of the chunks fall (the room's noise floor during a room-tone take). */
  noiseFloor() {
    if (!this.levels.length) return 0;
    const sorted = this.levels.slice().sort((a, b) => a - b);
    return sorted[Math.floor(0.1 * (sorted.length - 1))];
  }

  /** @returns {Promise<Blob>} the take as audio/wav */
  async stop() {
    if (this.state === 'done') return this.result || new Blob([encodeWav(new Int16Array(0), TARGET_RATE)], { type: 'audio/wav' });
    this.state = 'stopping';
    if (this.usedWorklet && this.node && this.node.port) {
      await new Promise((resolve) => {
        this.flushResolve = resolve;
        try {
          this.node.port.postMessage({ type: 'flush' });
        } catch {
          resolve();
        }
        setTimeout(resolve, 200);
      });
    }
    this.teardown();
    const tail = this.resampler ? this.resampler.flush() : new Float32Array(0);
    const total = Math.min(this.maxSamples, this.samples + tail.length);
    const all = new Float32Array(total);
    let off = 0;
    for (const c of [...this.chunks, tail]) {
      if (off >= total) break;
      const n = Math.min(c.length, total - off);
      all.set(n === c.length ? c : c.subarray(0, n), off);
      off += n;
    }
    this.chunks = [];
    this.state = 'done';
    this.result = new Blob([encodeWav(all, TARGET_RATE)], { type: 'audio/wav' });
    return this.result;
  }

  cancel() {
    this.state = 'done';
    this.chunks = [];
    this.teardown();
  }

  /** @private */
  teardown() {
    try {
      if (this.node) {
        if (this.node.port) this.node.port.onmessage = null;
        if ('onaudioprocess' in this.node) this.node.onaudioprocess = null;
        this.node.disconnect();
      }
    } catch {
      /* already gone */
    }
    try {
      if (this.source) this.source.disconnect();
    } catch {
      /* already gone */
    }
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.node = null;
    this.source = null;
    this.stream = null;
  }
}

// ------------------------------------------------------------------ daemon access

function storedToken() {
  try {
    return window.sessionStorage.getItem('anywhere.token') || '';
  } catch {
    return '';
  }
}

function rememberToken(token) {
  try {
    window.sessionStorage.setItem('anywhere.token', token);
  } catch {
    /* storage blocked: memory only */
  }
}

let memoryToken = '';
function token() {
  return storedToken() || memoryToken;
}

/**
 * Call the daemon. Errors carry status, code, hint and the daemon's details (problems, retake…).
 * @param {string} method
 * @param {string} path
 * @param {*} [body] JSON object, or a Blob sent raw
 * @param {{headers?:object, timeoutMs?:number}} [opts]
 */
/** The dialog window's credential, when this page has one (F3-SAFE-D1; see app.js rememberUiKey). */
function uiKey() {
  try {
    return window.sessionStorage.getItem('anywhere.ui') || '';
  } catch {
    return '';
  }
}

export async function api(method, path, body, { headers = {}, timeoutMs = 60000 } = {}) {
  const h = { Authorization: `Bearer ${token()}`, ...headers };
  const ui = uiKey();
  if (ui) h['X-Anywhere-UI'] = ui;
  let payload;
  if (body instanceof Blob) {
    payload = body;
    if (!h['Content-Type']) h['Content-Type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, { method, headers: h, body: payload, signal: ctrl.signal, cache: 'no-store', credentials: 'same-origin' });
  } catch (err) {
    const e = new Error(err && err.name === 'AbortError' ? 'The request timed out.' : "Can't reach Claude Anywhere. Is it still running?");
    e.status = 0;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) };
    }
  }
  if (!res.ok) {
    const e = new Error((data && data.error) || `Request failed (HTTP ${res.status})`);
    e.status = res.status;
    e.data = data;
    if (data && data.code) e.code = data.code;
    if (data && data.hint) e.hint = data.hint;
    throw e;
  }
  return data;
}

async function fetchAudio(id) {
  const res = await fetch(`/api/clone/audio?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token()}` }, cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Could not load the audio (HTTP ${res.status})`);
  return res.blob();
}

// ------------------------------------------------------------------ DOM helpers

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function ensureStyles() {
  if (document.querySelector('link[data-anywhere-calls-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./calls.css', import.meta.url).href;
  link.dataset.anywhereCallsCss = '1';
  document.head.append(link);
}

function fmtSecs(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

// ------------------------------------------------------------------ the view

class CloneView {
  constructor({ standalone = false } = {}) {
    this.standalone = standalone;
    this.isOpen = false;
    this.minimized = false;
    this.step = 'intro';
    this.status = null;
    this.session = null;
    this.deviceId = '';
    this.deviceLabel = '';
    this.devices = [];
    this.room = null;
    this.recorder = null;
    this.monitor = null;
    this.busy = false;
    this.error = null;
    this.result = null;
    this.lineIndex = 0;
    this.lineResults = new Map();
    this.consentResult = null;
    this.installProgress = null;
    this.buildResult = null;
    this.quality = null;
    this.handledSeq = 0;
    this.es = null;
    this.audioEl = null;
    this.audioUrl = null;
    this.confirmDelete = false;
    this.name = '';
    this.pronoun = 'their';
    this.agreed = false;
    this.level = 0;
    this.rafPending = false;
    this.onKey = (e) => this.handleKey(e);
  }

  // -------------------------------------------------------------- lifecycle

  /** Open (or bring back) the view. @param {{seq?:number}} [opts] an open request to acknowledge */
  async open({ seq } = {}) {
    ensureStyles();
    if (seq) {
      this.handledSeq = Math.max(this.handledSeq, seq);
      api('POST', '/api/clone/opened', { seq }, { timeoutMs: 5000 }).catch(() => {});
    }
    if (this.isOpen) {
      this.minimized = false;
      this.render();
      this.focus();
      return;
    }
    this.isOpen = true;
    this.minimized = false;
    this.error = null;
    this.buildRoot();
    document.addEventListener('keydown', this.onKey, true);
    this.connectEvents();
    this.step = 'loading';
    this.render();
    await this.refresh({ resume: true });
  }

  close() {
    if (!this.isOpen) return;
    if (this.recorder) this.recorder.cancel();
    this.recorder = null;
    this.stopMonitor();
    this.stopAudio();
    this.isOpen = false;
    document.removeEventListener('keydown', this.onKey, true);
    if (this.es) {
      try {
        this.es.close();
      } catch {
        /* ignore */
      }
      this.es = null;
    }
    clearInterval(this.installPoll);
    if (this.root) this.root.remove();
    this.root = null;
    if (this.pill) this.pill.remove();
    this.pill = null;
    if (this.standalone) this.renderClosedPage();
  }

  minimize() {
    if (!this.isOpen || this.recorder) return;
    this.minimized = true;
    this.render();
  }

  buildRoot() {
    if (this.root) return;
    this.live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
    this.body = h('div', { class: 'ca-body' });
    this.title = h('h2', { class: 'ca-title', id: 'ca-clone-title', text: 'Clone my voice' });
    this.stepper = h('ol', { class: 'ca-stepper', 'aria-label': 'Steps' });
    const head = h(
      'header',
      { class: 'ca-head' },
      this.title,
      this.standalone ? null : h('button', { type: 'button', class: 'icon-btn ca-close', 'aria-label': 'Hide', title: 'Hide (your progress is kept)', onclick: () => this.minimize() }, '–'),
      h('button', { type: 'button', class: 'icon-btn ca-close', 'aria-label': 'Close', title: 'Close', onclick: () => this.close() }, '×'),
    );
    this.sheet = h('div', { class: 'ca-sheet' }, head, this.stepper, this.body, this.live);
    this.root = h('div', { class: `ca-overlay${this.standalone ? ' ca-page' : ''}`, role: 'dialog', 'aria-modal': this.standalone ? null : 'true', 'aria-labelledby': 'ca-clone-title' }, this.sheet);
    document.body.append(this.root);
  }

  connectEvents() {
    if (this.es || typeof EventSource !== 'function' || !token()) return;
    try {
      this.es = new EventSource(`/api/events?token=${encodeURIComponent(token())}&client=clone`);
    } catch {
      this.es = null;
      return;
    }
    this.es.addEventListener('clone_install', (ev) => {
      try {
        this.onInstall(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    });
    this.es.addEventListener('clone_session', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d && d.step === 'phrases' && this.step === 'test') this.announce('Your greeting and short replies are ready.');
      } catch {
        /* ignore */
      }
    });
  }

  announce(text) {
    if (this.live) this.live.textContent = text;
  }

  focus() {
    const el = this.body && (this.body.querySelector('[data-autofocus]') || this.body.querySelector('button:not([disabled]), input, select'));
    if (el) {
      try {
        el.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  }

  handleKey(e) {
    if (!this.isOpen || this.minimized) return;
    // Modal inside the dialog: its own shortcuts (Space push-to-talk, Ctrl+K, Escape) must not fire
    // underneath. Stopping propagation here (capture phase) keeps default actions such as typing,
    // toggling a checkbox or pressing a focused button.
    if (!this.standalone) e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.recorder) this.cancelRecording();
      else if (this.standalone) this.close();
      else this.minimize();
    } else if (e.key === 'Tab' && this.sheet && !this.standalone) {
      const items = [...this.sheet.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !this.sheet.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !this.sheet.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  setError(err) {
    if (!err) {
      this.error = null;
      return;
    }
    this.error = { message: err.message || String(err), hint: err.hint || (err.data && err.data.hint) || null };
    this.announce(this.error.message);
  }

  // -------------------------------------------------------------- data

  async refresh({ resume = false } = {}) {
    try {
      this.status = await api('GET', '/api/clone/status', undefined, { timeoutMs: 30000 });
      this.setError(null);
    } catch (err) {
      this.status = null;
      this.setError(err);
      this.step = 'error';
      this.render();
      return;
    }
    const st = this.status;
    if (!this.name) this.name = (st.owner && st.owner.name) || '';
    this.pronoun = st.pronoun || this.pronoun;
    if (resume && st.session && st.session.sessionId) {
      try {
        this.session = await api('GET', `/api/clone/session?session=${st.session.sessionId}`);
        this.agreed = true;
        this.step = 'mic';
        this.render();
        return;
      } catch {
        this.session = null;
      }
    }
    if (resume) this.step = st.profile && st.profile.exists && st.profile.ok ? 'manage' : 'intro';
    this.render();
    this.focus();
  }

  onInstall(p) {
    this.installProgress = p;
    if (this.step !== 'install') return;
    if (p.stage === 'done') {
      clearInterval(this.installPoll);
      this.refresh().then(() => {
        if (this.status && this.status.installed) this.go('mic');
      });
      return;
    }
    if (p.stage === 'error') {
      clearInterval(this.installPoll);
      this.busy = false;
      this.setError(new Error(`The install failed: ${p.message}`));
    }
    this.render();
  }

  go(step) {
    this.step = step;
    this.setError(null);
    if (step !== 'mic') this.stopMonitor();
    this.render();
    this.focus();
    if (step === 'mic') this.loadDevices();
  }

  // -------------------------------------------------------------- actions

  async continueIntro() {
    const name = this.name.trim();
    if (!name || !this.agreed) return;
    const st = this.status || {};
    const save = {};
    if (st.owner && st.owner.name !== name) save.ownerName = name;
    if (this.pronoun && this.pronoun !== st.pronoun) save.ownerPronoun = this.pronoun;
    if (Object.keys(save).length) await api('POST', '/api/config', { calls: save }).catch(() => {});
    this.go(st.installed ? 'mic' : 'install');
  }

  async install(engine) {
    this.busy = true;
    this.setError(null);
    this.installProgress = { stage: 'python', percent: 0, message: 'Starting…' };
    this.render();
    try {
      await api('POST', '/api/clone/install', engine ? { engine } : {});
    } catch (err) {
      this.busy = false;
      this.setError(err);
      this.render();
      return;
    }
    // Progress also arrives as SSE; polling covers a page without the event stream.
    clearInterval(this.installPoll);
    this.installPoll = setInterval(async () => {
      try {
        const st = await api('GET', '/api/clone/status?light=1', undefined, { timeoutMs: 10000 });
        if (st.installing) this.onInstall(st.installing);
        else if (st.lastInstall) this.onInstall(st.lastInstall);
      } catch {
        /* keep polling */
      }
    }, 1500);
  }

  async loadDevices({ ask = false } = {}) {
    const md = navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return;
    try {
      let list = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      if (ask || !list.some((d) => d.label)) {
        // Labels are hidden until the page may use the microphone.
        const probe = await md.getUserMedia(EnrollRecorder.constraints(''));
        probe.getTracks().forEach((t) => t.stop());
        list = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      }
      this.devices = list.map((d) => ({ id: d.deviceId, label: d.label || 'Microphone', virtual: isVirtualDeviceLabel(d.label) }));
      const current = this.devices.find((d) => d.id === this.deviceId && !d.virtual);
      if (!current) {
        const first = this.devices.find((d) => !d.virtual && d.id !== 'communications') || null;
        this.deviceId = first ? first.id : '';
      }
      this.render();
      this.startMonitor();
    } catch (err) {
      this.setError(micError(err));
      this.render();
    }
  }

  async startMonitor() {
    this.stopMonitor();
    if (this.step !== 'mic' || !this.deviceId) return;
    const rec = new EnrollRecorder({ deviceId: this.deviceId, maxMs: 600000, onLevel: (l) => this.setLevel(l) });
    this.monitor = rec;
    try {
      await rec.start();
      if (this.monitor !== rec) {
        rec.cancel();
        return;
      }
      this.deviceLabel = rec.label;
      this.render();
    } catch (err) {
      if (this.monitor === rec) this.monitor = null;
      this.setError(err);
      this.render();
    }
  }

  stopMonitor() {
    if (this.monitor) this.monitor.cancel();
    this.monitor = null;
    this.setLevel(0);
  }

  setLevel(l) {
    this.level = l;
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      const fill = this.root && this.root.querySelector('.ca-meter-fill');
      if (fill) fill.style.width = `${Math.round(meterLevel(this.level) * 100)}%`;
    });
  }

  async measureRoom() {
    if (!this.monitor) await this.startMonitor();
    const rec = this.monitor;
    if (!rec) return;
    this.busy = true;
    this.room = { measuring: true };
    this.render();
    rec.levels = [];
    await new Promise((r) => setTimeout(r, ROOM_TONE_MS));
    const floor = dbfs(rec.noiseFloor());
    this.busy = false;
    this.room = { floor, ok: floor <= -30, quiet: floor <= -45 };
    this.announce(this.room.quiet ? 'The room is quiet enough.' : this.room.ok ? 'The room is a little noisy.' : 'The room is too noisy.');
    this.render();
  }

  async continueMic() {
    if (!this.room || !this.room.ok) return;
    if (isVirtualDeviceLabel(this.deviceLabel)) return;
    this.stopMonitor();
    if (this.session && this.session.sessionId) {
      try {
        this.session = await api('GET', `/api/clone/session?session=${this.session.sessionId}`);
        if (this.session.consentTake) {
          this.lineIndex = this.nextMissingLine();
          this.go(this.session.ready ? 'build' : 'lines');
        } else this.go('consent');
        return;
      } catch {
        this.session = null;
      }
    }
    this.busy = true;
    this.render();
    try {
      this.session = await api('POST', '/api/clone/session', { ownerName: this.name.trim() || undefined });
      this.consentResult = null;
      this.lineResults = new Map();
      this.busy = false;
      this.go('consent');
    } catch (err) {
      this.busy = false;
      this.setError(err);
      this.render();
    }
  }

  nextMissingLine(from = 0) {
    const takes = (this.session && this.session.takes) || [];
    const n = (this.session && this.session.lines && this.session.lines.length) || 14;
    for (let k = 0; k < n; k += 1) {
      const i = (from + k) % n;
      if (!takes[i] || !takes[i].ok) return i;
    }
    return Math.min(from, n - 1);
  }

  async startRecording(kind) {
    if (this.recorder || this.busy) return;
    this.stopAudio();
    this.setError(null);
    this.result = null;
    this.flash = null;
    const rec = new EnrollRecorder({ deviceId: this.deviceId, onLevel: (l) => this.setLevel(l), onAutoStop: () => this.stopRecording(kind) });
    this.recorder = rec;
    this.recStart = Date.now();
    this.render();
    try {
      await rec.start();
    } catch (err) {
      this.recorder = null;
      this.setError(err);
      this.render();
      return;
    }
    this.deviceLabel = rec.label;
    this.render();
    clearInterval(this.recTimer);
    this.recTimer = setInterval(() => {
      const t = this.root && this.root.querySelector('.ca-rec-time');
      if (t && this.recorder) t.textContent = fmtSecs(this.recorder.durationMs);
    }, 200);
    this.focus();
  }

  cancelRecording() {
    clearInterval(this.recTimer);
    if (this.recorder) this.recorder.cancel();
    this.recorder = null;
    this.setLevel(0);
    this.render();
  }

  async stopRecording(kind) {
    const rec = this.recorder;
    if (!rec || rec.state === 'stopping' || rec.state === 'done') return;
    clearInterval(this.recTimer);
    const blob = await rec.stop();
    this.recorder = null;
    this.setLevel(0);
    if (rec.durationMs < MIN_TAKE_MS) {
      this.setError(new Error('That was too short: read the whole sentence, then press Stop.'));
      this.render();
      return;
    }
    await this.upload(kind, blob, rec.label);
  }

  async upload(kind, blob, label) {
    this.busy = true;
    this.render();
    const idx = kind === 'line' ? this.lineIndex : 0;
    try {
      const r = await api('POST', `/api/clone/take?session=${this.session.sessionId}&kind=${kind}&index=${idx}`, blob, {
        headers: { 'Content-Type': 'audio/wav', 'X-Anywhere-Device-Label': encodeURIComponent(label || this.deviceLabel || '') },
        timeoutMs: 120000,
      });
      this.busy = false;
      if (kind === 'consent') {
        this.consentResult = r;
        if (r.consent && r.consent.renewed) this.session.consent = r.consent.renewed;
        if (r.ok) {
          this.session = await api('GET', `/api/clone/session?session=${this.session.sessionId}`).catch(() => this.session);
          this.announce('Consent recorded.');
        } else this.announce('The consent was not accepted. See why below.');
      } else {
        this.lineResults.set(idx, r);
        this.session = await api('GET', `/api/clone/session?session=${this.session.sessionId}`).catch(() => this.session);
        if (r.ok) {
          const warn = (r.problems || []).filter((p) => p.level === 'warn');
          this.flash = { index: idx, warn: warn.length ? warn[0].hint : null };
          this.announce(warn.length ? `Line ${idx + 1} saved, with a note: ${warn[0].hint}` : `Line ${idx + 1} saved.`);
          if (!this.session.ready) this.lineIndex = this.nextMissingLine(idx + 1);
        } else {
          this.flash = null;
          this.announce(`Line ${idx + 1} needs another take.`);
        }
      }
    } catch (err) {
      this.busy = false;
      if (kind === 'line' && err.data && err.data.problems) this.lineResults.set(idx, { ok: false, problems: err.data.problems });
      if (kind === 'consent' && err.data && err.data.problems) this.consentResult = { ok: false, problems: err.data.problems };
      this.setError(err);
      if (err.code === 'NO_SESSION') this.session = null;
    }
    this.render();
    this.focus();
  }

  async build() {
    this.go('build');
    this.busy = true;
    this.buildResult = null;
    this.render();
    try {
      const r = await api('POST', `/api/clone/build?session=${this.session.sessionId}`, undefined, { timeoutMs: 600000 });
      this.busy = false;
      this.buildResult = r;
      this.session = null;
      this.go('test');
      if (r.testAudioId) this.play(r.testAudioId);
    } catch (err) {
      this.busy = false;
      const d = err.data || {};
      if (d.code === 'TAKES_INCONSISTENT') {
        this.session = await api('GET', `/api/clone/session?session=${this.session.sessionId}`).catch(() => this.session);
        for (const i of d.retake || []) this.lineResults.set(i, { ok: false, problems: [{ code: 'speaker', level: 'fail', hint: 'This take does not sound like the others: record it again.' }] });
        this.lineIndex = (d.retake && d.retake[0]) || 0;
        this.go('lines');
        this.setError(err);
        this.render();
        return;
      }
      if (d.code === 'CONSENT_SPEAKER_MISMATCH' || d.code === 'MIXED_SPEAKERS') {
        this.session = null;
        this.buildResult = { failed: true, message: d.error || err.message };
        this.render();
        return;
      }
      this.setError(err);
      this.render();
    }
  }

  stopAudio() {
    if (this.audioEl) {
      try {
        this.audioEl.pause();
      } catch {
        /* ignore */
      }
    }
    this.audioEl = null;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = null;
  }

  async play(id) {
    this.stopAudio();
    try {
      const blob = await fetchAudio(id);
      this.audioUrl = URL.createObjectURL(blob);
      this.audioEl = new Audio(this.audioUrl);
      await this.audioEl.play();
    } catch (err) {
      this.setError(new Error(`Could not play the test: ${err.message}`));
      this.render();
    }
  }

  async tryEngine(engine) {
    this.busy = true;
    this.setError(null);
    this.render();
    try {
      const st = await api('GET', '/api/clone/status');
      this.status = st;
      if (!st.engines || !st.engines[engine]) {
        this.installProgress = { stage: 'python', percent: 0, message: 'Starting…' };
        this.quality = { installing: true, engine };
        this.render();
        await api('POST', '/api/clone/install', { engine });
        await new Promise((resolve, reject) => {
          const t = setInterval(async () => {
            try {
              const s = await api('GET', '/api/clone/status?light=1', undefined, { timeoutMs: 10000 });
              if (s.installing) {
                this.installProgress = s.installing;
                this.render();
                return;
              }
              clearInterval(t);
              if (s.lastInstall && s.lastInstall.stage === 'error') reject(new Error(s.lastInstall.message));
              else resolve();
            } catch (err) {
              clearInterval(t);
              reject(err);
            }
          }, 1500);
        });
      }
      const r = await api('POST', '/api/clone/test', { engine, score: true }, { timeoutMs: 300000 });
      this.quality = { engine, result: r };
      this.busy = false;
      this.render();
      this.play(r.audioId);
    } catch (err) {
      this.busy = false;
      this.quality = null;
      this.setError(err);
      this.render();
    }
  }

  async useEngine(engine) {
    this.busy = true;
    this.render();
    try {
      await api('POST', '/api/clone/engine', { engine });
      this.busy = false;
      this.announce(engine === 'zipvoice' ? 'Using the quality voice.' : 'Using the standard voice.');
      this.go('done');
    } catch (err) {
      this.busy = false;
      this.setError(err);
      this.render();
    }
  }

  async testProfile() {
    this.busy = true;
    this.render();
    try {
      const r = await api('POST', '/api/clone/test', {}, { timeoutMs: 300000 });
      this.busy = false;
      this.render();
      this.play(r.audioId);
    } catch (err) {
      this.busy = false;
      this.setError(err);
      this.render();
    }
  }

  async deleteVoice() {
    this.busy = true;
    this.render();
    try {
      await api('POST', '/api/clone/delete', { confirm: 'delete' });
      this.busy = false;
      this.confirmDelete = false;
      this.session = null;
      this.buildResult = null;
      this.announce('Your cloned voice was deleted.');
      await this.refresh();
      this.go('deleted');
    } catch (err) {
      this.busy = false;
      this.setError(err);
      this.render();
    }
  }

  async startOver() {
    if (this.session && this.session.sessionId) await api('POST', `/api/clone/session/cancel?session=${this.session.sessionId}`).catch(() => {});
    this.session = null;
    this.consentResult = null;
    this.lineResults = new Map();
    this.buildResult = null;
    this.quality = null;
    this.room = null;
    this.go('intro');
  }

  // -------------------------------------------------------------- rendering

  render() {
    if (!this.isOpen || !this.root) return;
    this.root.hidden = this.minimized;
    this.renderPill();
    if (this.minimized) return;
    const idx = STEPS.indexOf(this.step);
    this.stepper.replaceChildren(
      ...STEPS.filter((s) => s !== 'install' || (this.status && !this.status.installed) || this.step === 'install').map((s) => {
        const i = STEPS.indexOf(s);
        return h('li', { class: 'ca-step', dataset: { state: i < idx ? 'done' : i === idx ? 'current' : 'todo' }, 'aria-current': i === idx ? 'step' : null }, STEP_LABEL[s]);
      }),
    );
    this.stepper.hidden = idx < 0;
    const view = {
      loading: () => this.viewLoading(),
      error: () => this.viewFatal(),
      intro: () => this.viewIntro(),
      install: () => this.viewInstall(),
      mic: () => this.viewMic(),
      consent: () => this.viewConsent(),
      lines: () => this.viewLines(),
      build: () => this.viewBuild(),
      test: () => this.viewTest(),
      done: () => this.viewDone(),
      manage: () => this.viewManage(),
      deleted: () => this.viewDeleted(),
    }[this.step];
    // append()/replaceChildren() would turn null into the text "null".
    this.body.replaceChildren(...[].concat(view ? view() : [], this.errorBox()).flat().filter((n) => n != null && n !== false));
  }

  renderPill() {
    if (this.standalone) return;
    if (!this.minimized) {
      if (this.pill) this.pill.remove();
      this.pill = null;
      return;
    }
    if (this.pill) return;
    this.pill = h('button', { type: 'button', class: 'ca-pill', onclick: () => this.open() }, h('span', { class: 'ca-pill-dot', 'aria-hidden': 'true' }), 'Voice enrollment · Resume');
    document.body.append(this.pill);
  }

  renderClosedPage() {
    document.body.replaceChildren(
      h(
        'main',
        { class: 'ca-page-closed' },
        h('h1', { text: 'Voice enrollment closed' }),
        h('p', { text: 'Your progress is kept for 24 hours. Run anywhere clone-voice (or /anywhere:clone-voice) to continue.' }),
        h('button', { type: 'button', class: 'btn', onclick: () => this.open() }, 'Open again'),
      ),
    );
  }

  errorBox() {
    if (!this.error) return null;
    return h('div', { class: 'ca-alert', role: 'alert', dataset: { level: 'error' } }, h('strong', { text: this.error.message }), this.error.hint ? h('div', { class: 'ca-help', text: this.error.hint }) : null);
  }

  problemsList(problems) {
    const list = (problems || []).filter((p) => p && p.hint);
    if (!list.length) return null;
    return h(
      'ul',
      { class: 'ca-problems' },
      list.map((p) => h('li', { dataset: { level: p.level } }, h('span', { class: 'tag', dataset: { state: p.level === 'fail' ? 'error' : 'busy' }, text: p.level === 'fail' ? 'Redo' : 'Note' }), ' ', p.hint)),
    );
  }

  meter() {
    return h('div', { class: 'ca-meter', role: 'presentation' }, h('span', { class: 'ca-meter-fill', style: `width:${Math.round(meterLevel(this.level) * 100)}%` }));
  }

  viewLoading() {
    return [h('p', { class: 'ca-muted', text: 'Loading…' })];
  }

  viewFatal() {
    return [h('p', { text: 'The voice enrollment could not load.' }), h('button', { type: 'button', class: 'btn', onclick: () => this.refresh({ resume: true }) }, 'Retry')];
  }

  viewIntro() {
    const nameInput = h('input', {
      class: 'input',
      id: 'ca-name',
      type: 'text',
      autocomplete: 'name',
      maxlength: '60',
      value: this.name,
      oninput: (e) => {
        this.name = e.target.value;
        cont.disabled = !(this.name.trim() && this.agreed);
      },
    });
    const pronoun = h(
      'select',
      { class: 'input', id: 'ca-pronoun', onchange: (e) => (this.pronoun = e.target.value) },
      ['his', 'her', 'their'].map((p) => h('option', { value: p, selected: p === this.pronoun }, p)),
    );
    const check = h('input', {
      type: 'checkbox',
      id: 'ca-agree',
      checked: this.agreed,
      onchange: (e) => {
        this.agreed = e.target.checked;
        cont.disabled = !(this.name.trim() && this.agreed);
      },
    });
    const cont = h('button', { type: 'button', class: 'btn btn-primary', disabled: !(this.name.trim() && this.agreed), 'data-autofocus': true, onclick: () => this.continueIntro() }, 'Continue');
    const st = this.status || {};
    return [
      h('p', { text: 'Claude Anywhere can answer calls for you in your own voice. To make that voice, you read a consent sentence and 14 short lines aloud (about 3 minutes).' }),
      h(
        'ul',
        { class: 'ca-facts' },
        h('li', { text: 'Recorded here, from your microphone, and kept on this computer only. Nothing is uploaded.' }),
        h('li', { text: 'The voice says it is an AI assistant on every call it answers.' }),
        h('li', { text: 'Delete it any time: the Delete button here, or /anywhere:clone-voice delete.' }),
      ),
      st.profile && st.profile.exists ? h('p', { class: 'ca-note', text: 'You already have a cloned voice. Recording again replaces it once the new one is built.' }) : null,
      h('label', { class: 'ca-field', for: 'ca-name' }, h('span', { text: 'Your full name (read in the consent sentence)' }), nameInput),
      h('label', { class: 'ca-field', for: 'ca-pronoun' }, h('span', { text: 'The assistant says it speaks in … voice' }), pronoun),
      h('label', { class: 'ca-check', for: 'ca-agree' }, check, h('span', { text: 'I am the person whose voice will be recorded.' })),
      h('div', { class: 'ca-actions' }, cont),
      h('p', { class: 'ca-fine', text: 'Free models, run locally: Kyutai Pocket TTS (CC-BY-4.0), Moonshine (MIT), 3D-Speaker (Apache-2.0).' }),
    ];
  }

  viewInstall() {
    const st = this.status || {};
    const p = this.installProgress;
    const running = Boolean(p && p.stage !== 'done' && p.stage !== 'error' && (this.busy || (st.installing && true)));
    const pct = p ? Math.max(0, Math.min(100, Number(p.percent) || 0)) : 0;
    return [
      h('p', { text: 'First, the free voice runtime: a private Python environment and the voice, speech and speaker models (about 425 MB, once). It runs offline.' }),
      st.available === false ? h('p', { class: 'ca-note', text: (st.runtime && st.runtime.reason) || 'The voice runtime is missing from this installation.' }) : null,
      p
        ? h(
            'div',
            { class: 'progress', dataset: { state: p.stage === 'error' ? 'error' : p.stage === 'done' ? 'done' : 'busy' } },
            h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Voice runtime download' }, h('span', { class: 'progress-fill', style: `width:${pct}%` })),
            h('span', { class: 'progress-text', text: `${pct}% · ${p.message || p.stage}` }),
          )
        : null,
      h('div', { class: 'ca-actions' }, h('button', { type: 'button', class: 'btn btn-primary', disabled: running, 'data-autofocus': true, onclick: () => this.install() }, running ? 'Installing…' : p && p.stage === 'error' ? 'Try again' : 'Install'), h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => this.go('intro') }, 'Back')),
      h('p', { class: 'ca-fine', text: 'Or in a terminal: anywhere clone-voice install' }),
    ];
  }

  viewMic() {
    const sel = h(
      'select',
      {
        class: 'input',
        id: 'ca-device',
        onchange: (e) => {
          this.deviceId = e.target.value;
          this.room = null;
          this.startMonitor();
          this.render();
        },
      },
      this.devices.length ? this.devices.map((d) => h('option', { value: d.id, selected: d.id === this.deviceId, disabled: d.virtual }, d.virtual ? `${d.label} (virtual: not allowed)` : d.label)) : h('option', { value: '' }, 'No microphone found yet'),
    );
    const room = this.room;
    const virtual = isVirtualDeviceLabel(this.deviceLabel);
    return [
      h('p', { text: 'Pick the microphone you will use for calls, in the room you will usually be in. Speak normally: the bar should move to about the middle.' }),
      h('label', { class: 'ca-field', for: 'ca-device' }, h('span', { text: 'Microphone' }), sel),
      this.devices.length ? null : h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this.loadDevices({ ask: true }) }, 'Allow the microphone'),
      this.meter(),
      virtual ? h('p', { class: 'ca-note', dataset: { level: 'error' }, text: 'This is a virtual or loopback device. Only your own voice from a real microphone can be recorded.' }) : null,
      h('p', { class: 'ca-help', text: 'Then stay quiet for 3 seconds while the room noise is measured.' }),
      room && room.measuring ? h('p', { class: 'ca-muted', text: 'Measuring… stay quiet.' }) : null,
      room && !room.measuring
        ? h('p', { class: 'ca-note', dataset: { level: room.quiet ? 'ok' : room.ok ? 'warn' : 'error' }, text: room.quiet ? `Quiet room (${room.floor} dBFS).` : room.ok ? `A little noisy (${room.floor} dBFS): a quieter room gives a better voice.` : `Too noisy (${room.floor} dBFS): find a quieter room, or move away from fans.` })
        : null,
      h(
        'div',
        { class: 'ca-actions' },
        h('button', { type: 'button', class: 'btn', disabled: this.busy || !this.deviceId || virtual, 'data-autofocus': !room, onclick: () => this.measureRoom() }, room && !room.measuring ? 'Measure again' : 'Measure room noise'),
        h('button', { type: 'button', class: 'btn btn-primary', disabled: this.busy || !room || !room.ok || virtual, 'data-autofocus': Boolean(room && room.ok), onclick: () => this.continueMic() }, this.session ? 'Continue where I left off' : 'Continue'),
      ),
    ];
  }

  recordButton(kind) {
    const rec = this.recorder;
    if (rec) {
      return h(
        'div',
        { class: 'ca-recording' },
        h('span', { class: 'ca-rec-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'ca-rec-time', text: fmtSecs(rec.durationMs) }),
        this.meter(),
        h('button', { type: 'button', class: 'btn btn-primary', 'data-autofocus': true, onclick: () => this.stopRecording(kind) }, 'Stop'),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => this.cancelRecording() }, 'Cancel'),
      );
    }
    return h('button', { type: 'button', class: 'btn btn-primary ca-rec-btn', disabled: this.busy, 'data-autofocus': true, onclick: () => this.startRecording(kind) }, h('span', { class: 'ca-rec-dot', 'aria-hidden': 'true' }), this.busy ? 'Checking…' : 'Record');
  }

  viewConsent() {
    const s = this.session;
    if (!s) return [h('p', { text: 'The session ended.' }), h('button', { type: 'button', class: 'btn', onclick: () => this.startOver() }, 'Start again')];
    const r = this.consentResult;
    if (s.consentTake) {
      return [
        h('p', { class: 'ca-note', dataset: { level: 'ok' }, text: 'Consent recorded and verified on this computer.' }),
        r && r.transcript ? h('p', { class: 'ca-help', text: `Heard: “${r.transcript}”` }) : null,
        h('div', { class: 'ca-actions' }, h('button', { type: 'button', class: 'btn btn-primary', 'data-autofocus': true, onclick: () => this.go('lines') }, 'Next: the script')),
      ];
    }
    const text = s.consent.text;
    // The code is shown only while recording.
    const shown = this.recorder ? text : text.replace(/(My code is )([\d ]+)\./, (_, a, d) => `${a}${d.replace(/\d/g, '•')}.`);
    const mins = Math.max(0, Math.round((s.consent.expiresAt - Date.now()) / 60000));
    return [
      h('p', { text: 'Press Record, then read this sentence aloud exactly as written. The four-digit code appears when you start recording.' }),
      h('blockquote', { class: 'ca-script ca-consent' }, shown),
      h('p', { class: 'ca-fine', text: `It is checked by speech recognition on this computer. The code works once and for about ${mins} more minute${mins === 1 ? '' : 's'}.` }),
      this.recordButton('consent'),
      r && !r.ok
        ? h(
            'div',
            { class: 'ca-alert', dataset: { level: 'warn' } },
            h('strong', { text: 'Not accepted yet.' }),
            r.transcript ? h('div', { class: 'ca-help', text: `Heard: “${r.transcript}”` }) : null,
            h('ul', { class: 'ca-problems' }, ((r.consent && r.consent.hints) || []).map((t) => h('li', { text: t }))),
            this.problemsList(r.problems),
            r.consent && r.consent.renewed ? h('div', { class: 'ca-help', text: 'A new code was issued: press Record to see it.' }) : null,
          )
        : null,
    ];
  }

  viewLines() {
    const s = this.session;
    if (!s) return [h('p', { text: 'The session ended.' }), h('button', { type: 'button', class: 'btn', onclick: () => this.startOver() }, 'Start again')];
    const lines = s.lines || [];
    const done = (s.takes || []).filter((t) => t.ok).length;
    const i = this.lineIndex;
    const r = this.lineResults.get(i);
    const take = (s.takes || [])[i];
    return [
      h(
        'div',
        { class: 'progress' },
        h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(lines.length), 'aria-valuenow': String(done), 'aria-label': 'Lines recorded' }, h('span', { class: 'progress-fill', style: `width:${Math.round((done / Math.max(1, lines.length)) * 100)}%` })),
        h('span', { class: 'progress-text', text: `${done} of ${lines.length} lines · ${Math.round(s.voicedS || 0)} s of speech` }),
      ),
      this.flash && this.flash.index !== i
        ? h('p', { class: 'ca-note', dataset: { level: this.flash.warn ? 'warn' : 'ok' }, text: this.flash.warn ? `Line ${this.flash.index + 1} saved. Note: ${this.flash.warn}` : `Line ${this.flash.index + 1} saved.` })
        : null,
      h('p', { class: 'ca-muted', text: `Line ${i + 1}: read it naturally, like on a call.` }),
      h('blockquote', { class: 'ca-script' }, lines[i] || ''),
      this.recordButton('line'),
      r ? (r.ok ? h('p', { class: 'ca-note', dataset: { level: 'ok' }, text: 'Saved.' }) : null) : take && take.ok ? h('p', { class: 'ca-note', dataset: { level: 'ok' }, text: 'Recorded. Record again to replace it.' }) : null,
      r ? this.problemsList(r.problems) : null,
      h(
        'ol',
        { class: 'ca-lines', 'aria-label': 'All lines' },
        lines.map((text, k) => {
          const t = (s.takes || [])[k];
          const rr = this.lineResults.get(k);
          const state = t && t.ok ? (rr && rr.problems && rr.problems.some((p) => p.level === 'warn') ? 'warn' : 'ok') : rr && !rr.ok ? 'error' : 'todo';
          return h(
            'li',
            { dataset: { state }, 'aria-current': k === i ? 'true' : null },
            h('button', { type: 'button', class: 'ca-line-btn', disabled: Boolean(this.recorder) || this.busy, title: text, onclick: () => ((this.lineIndex = k), this.setError(null), this.render()) }, h('span', { class: 'ca-line-no', text: String(k + 1) }), h('span', { class: 'ca-line-text', text })),
          );
        }),
      ),
      h('div', { class: 'ca-actions' }, h('button', { type: 'button', class: 'btn btn-primary', disabled: !s.ready || Boolean(this.recorder) || this.busy, onclick: () => this.build() }, 'Build my voice')),
      s.ready ? null : h('p', { class: 'ca-fine', text: `Record every line; at least ${s.needS || 45} s of speech in total.` }),
    ];
  }

  viewBuild() {
    const r = this.buildResult;
    if (r && r.failed) {
      return [
        h('div', { class: 'ca-alert', role: 'alert', dataset: { level: 'error' } }, h('strong', { text: 'Enrollment stopped.' }), h('div', { text: r.message })),
        h('div', { class: 'ca-actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.startOver() }, 'Start again')),
      ];
    }
    return [
      h('div', { class: 'ca-spinner', 'aria-hidden': 'true' }),
      h('p', { text: 'Checking that every take is the same speaker, building your voice and rendering a test sentence…' }),
      h('p', { class: 'ca-fine', text: 'This takes up to a minute.' }),
    ];
  }

  viewTest() {
    const r = this.buildResult || {};
    const q = this.quality;
    const sim = r.similarity;
    return [
      h('p', { class: 'ca-note', dataset: { level: 'ok' }, text: 'Your voice is built.' }),
      r.testText ? h('blockquote', { class: 'ca-script' }, r.testText) : null,
      r.testAudioId ? h('button', { type: 'button', class: 'btn', 'data-autofocus': true, onclick: () => this.play(r.testAudioId) }, '▶ Play the test') : h('p', { class: 'ca-note', dataset: { level: 'warn' }, text: `The test could not be rendered${r.testError ? `: ${r.testError}` : ''}.` }),
      sim != null ? h('p', { class: 'ca-score' }, h('strong', { text: r.label || '' }), ` · match ${sim}`) : null,
      h('p', { class: 'ca-fine', text: 'It sounds like you, not identical. A quieter room and a steady pace give a closer voice.' }),
      q && q.installing && this.busy
        ? h('p', { class: 'ca-muted', text: `Installing the quality voice… ${(this.installProgress && this.installProgress.percent) || 0}%` })
        : null,
      q && q.result
        ? h(
            'div',
            { class: 'ca-compare' },
            h('p', {}, h('strong', { text: 'Quality voice' }), q.result.label ? ` · ${q.result.label} (match ${q.result.similarity})` : ''),
            h('div', { class: 'ca-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => this.play(q.result.audioId) }, '▶ Play'), h('button', { type: 'button', class: 'btn btn-primary', disabled: this.busy, onclick: () => this.useEngine('zipvoice') }, 'Use the quality voice')),
          )
        : null,
      h(
        'div',
        { class: 'ca-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', disabled: this.busy, onclick: () => (q && q.result ? this.useEngine('pocket') : this.go('done')) }, 'Keep'),
        h('button', { type: 'button', class: 'btn', disabled: this.busy, onclick: () => this.startOver() }, 'Redo'),
        q && q.result ? null : h('button', { type: 'button', class: 'btn btn-ghost', disabled: this.busy, onclick: () => this.tryEngine('zipvoice') }, this.busy ? 'Working…' : 'Try the quality voice'),
      ),
      q && q.result
        ? null
        : h('p', { class: 'ca-fine', text: 'The quality voice (ZipVoice, 163 MB more) sounds closer but is slower. Its weights were trained on non-commercial data: personal use only.' }),
    ];
  }

  viewDone() {
    return [
      h('p', { class: 'ca-note', dataset: { level: 'ok' }, text: 'Your cloned voice is ready.' }),
      h('p', { text: 'When you ask Claude to answer your calls, the assistant uses it and always says that it is an AI assistant taking notes for you.' }),
      h('div', { class: 'ca-actions' }, h('button', { type: 'button', class: 'btn btn-primary', 'data-autofocus': true, onclick: () => this.close() }, 'Done')),
    ];
  }

  viewManage() {
    const p = (this.status && this.status.profile) || {};
    const when = p.createdAt ? new Date(p.createdAt).toLocaleString() : '';
    const items = [
      h('p', { class: 'ca-note', dataset: { level: 'ok' }, text: `You have a cloned voice${p.ownerName ? ` for ${p.ownerName}` : ''}${when ? `, recorded ${when}` : ''}.` }),
      p.testSimilarity != null ? h('p', { class: 'ca-score' }, h('strong', { text: p.testLabel || '' }), ` · match ${p.testSimilarity} · ${p.engine === 'zipvoice' ? 'quality voice' : 'standard voice'}`) : null,
      h(
        'div',
        { class: 'ca-actions' },
        h('button', { type: 'button', class: 'btn', disabled: this.busy, 'data-autofocus': true, onclick: () => this.testProfile() }, this.busy ? 'Working…' : '▶ Test my voice'),
        h('button', { type: 'button', class: 'btn', disabled: this.busy, onclick: () => this.startOver() }, 'Record again'),
        h('button', { type: 'button', class: 'btn btn-danger', disabled: this.busy, onclick: () => ((this.confirmDelete = true), this.render(), this.focus()) }, 'Delete my voice'),
      ),
    ];
    if (this.confirmDelete) {
      items.push(
        h(
          'div',
          { class: 'ca-alert ca-confirm', role: 'alertdialog', 'aria-labelledby': 'ca-del-title', 'aria-describedby': 'ca-del-text', dataset: { level: 'error' } },
          h('strong', { id: 'ca-del-title', text: 'Delete your cloned voice?' }),
          h('div', { id: 'ca-del-text', text: 'This removes the voice profile, the consent recording and the pre-rendered phrases from this computer. Calls will not use your voice until you record it again.' }),
          h('div', { class: 'ca-actions' }, h('button', { type: 'button', class: 'btn btn-danger', 'data-autofocus': true, disabled: this.busy, onclick: () => this.deleteVoice() }, 'Delete'), h('button', { type: 'button', class: 'btn', onclick: () => ((this.confirmDelete = false), this.render()) }, 'Cancel')),
        ),
      );
    }
    return items;
  }

  viewDeleted() {
    return [
      h('p', { class: 'ca-note', dataset: { level: 'ok' }, text: 'Your cloned voice was deleted from this computer.' }),
      h('div', { class: 'ca-actions' }, h('button', { type: 'button', class: 'btn btn-primary', 'data-autofocus': true, onclick: () => this.close() }, 'Close'), h('button', { type: 'button', class: 'btn', onclick: () => this.startOver() }, 'Record a new one')),
    ];
  }
}

// ------------------------------------------------------------------ mounting

let instance = null;
let pollTimer = 0;

async function checkOpenRequest(view) {
  if (view.isOpen && !view.minimized) return;
  if (!token() || document.hidden) return;
  let st;
  try {
    st = await api('GET', '/api/clone/status?light=1', undefined, { timeoutMs: 8000 });
  } catch {
    return;
  }
  const seq = Number(st.openSeq) || 0;
  if (seq > view.handledSeq && seq > (Number(st.openAck) || 0) && (st.openAgeMs == null || st.openAgeMs < OPEN_REQUEST_MAX_AGE_MS)) view.open({ seq });
}

/**
 * Mount the enrollment view in this page (once). It opens on request: view.open(), the
 * 'anywhere:clone-open' window event, or `anywhere clone-voice` (see the file comment).
 * @param {{standalone?:boolean, poll?:boolean}} [opts]
 * @returns {{open:(o?:{seq?:number})=>Promise<void>, close:()=>void, isOpen:()=>boolean}}
 */
export function mount({ standalone = false, poll } = {}) {
  if (instance) return instance.api;
  ensureStyles();
  const view = new CloneView({ standalone });
  window.addEventListener('anywhere:clone-open', () => view.open());
  window.addEventListener('anywhere:event', (e) => {
    const d = (e && e.detail) || {};
    if (d.type === 'clone_session' && d.data && d.data.step === 'open') view.open({ seq: Number(d.data.seq) || 0 });
    else if (d.type === 'clone_install' && d.data && view.isOpen) view.onInstall(d.data);
    else if ((d.type === 'approval_request' || d.type === 'question') && view.isOpen && !view.standalone) view.minimize();
  });
  if (!standalone) {
    // Pages loaded after `anywhere clone-voice` asked (a fresh dialog) still see the request.
    setTimeout(() => checkOpenRequest(view), 500);
    const usePoll = poll != null ? poll : typeof window.anywhereApi !== 'function';
    if (usePoll) pollTimer = setInterval(() => checkOpenRequest(view), POLL_MS);
  }
  instance = { view, api: { open: (o) => view.open(o), close: () => view.close(), isOpen: () => view.isOpen } };
  return instance.api;
}

/** /clone.html: trade ?launch= (or ?token=) for the token, then show the view as the page. */
async function bootStandalone() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    params = new URLSearchParams();
  }
  const fromUrl = params.get('token');
  const launch = params.get('launch');
  if (fromUrl || launch) {
    params.delete('token');
    params.delete('launch');
    const qs = params.toString();
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    } catch {
      /* ignore */
    }
  }
  if (fromUrl) rememberToken(fromUrl);
  else if (launch) {
    try {
      const res = await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: launch }), cache: 'no-store', credentials: 'same-origin' });
      const data = res.ok ? await res.json() : {};
      if (data && typeof data.token === 'string' && data.token) {
        rememberToken(data.token);
        memoryToken = data.token;
      }
    } catch {
      /* falls through to the no-token message */
    }
  }
  if (!token()) {
    document.body.replaceChildren(
      h('main', { class: 'ca-page-closed' }, h('h1', { text: 'This link has expired' }), h('p', { text: 'Run anywhere clone-voice (or /anywhere:clone-voice) again to open the voice enrollment.' })),
    );
    return;
  }
  const v = mount({ standalone: true });
  // Acknowledge the latest open request, so a dialog that loads later does not open it too.
  api('GET', '/api/clone/status?light=1')
    .then((st) => (st && st.openSeq ? v.open({ seq: st.openSeq }) : v.open()))
    .catch(() => v.open());
}

if (typeof document !== 'undefined' && document.documentElement && document.documentElement.dataset.page === 'clone') {
  bootStandalone();
}
