/**
 * The call-audio self-test page (docs/CALLS-DESIGN.md §5.5), opened by `anywhere calls test-audio` in
 * the browser the user takes calls in: /calls-audio-test.html?code=<single-use code>.
 *
 * It works without the dialog's token. The code is traded once for a test id (POST begin); the daemon
 * then routes the audio as for a real AI-answered call:
 *  1. Mic direction: the page records getUserMedia (the "Default" microphone, browser processing on, as
 *     a call app would) while the daemon speaks a test phrase into the virtual microphone (POST speak),
 *     then uploads the WAV (POST upload) for local transcription and a fuzzy match.
 *  2. Capture direction: the daemon records its caller-capture backend (POST capture) while the page
 *     plays a short clip through Web Audio; POST result transcribes and matches it.
 *  3. POST finish restores the routing (also sent as a beacon when the tab closes).
 *
 * runAudioTest() is the flow with injectable browser APIs (tested in Node); the page wires it to the DOM.
 * Add ?auto=1 to start without the button (automation with --use-fake-ui-for-media-stream).
 */

import { WavRecorder } from './wav-recorder.js';

const API = '/api/calls/audio-test/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST one step; JSON in, JSON out; errors carry {status, hint, code}. */
export async function postStep(fetchFn, step, query, body) {
  const qs = new URLSearchParams(query || {}).toString();
  const init = { method: 'POST', cache: 'no-store', credentials: 'same-origin' };
  if (body) {
    init.body = body;
    init.headers = { 'Content-Type': 'audio/wav' };
  }
  const res = await fetchFn(`${API}${step}${qs ? `?${qs}` : ''}`, init);
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const e = new Error(data.error || `The test step "${step}" failed (HTTP ${res.status})`);
    e.status = res.status;
    if (data.hint) e.hint = data.hint;
    if (data.code) e.code = data.code;
    throw e;
  }
  return data;
}

export function base64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Short text for a direction's verdict. */
export function describeVerdict(v) {
  if (!v) return 'not run';
  if (v.error) return v.error.message || 'failed';
  const heard = v.transcript != null ? `heard "${v.transcript || '(nothing)'}"` : v.level ? `level ${v.level.rmsDbfs} dBFS` : '';
  if (v.pass) return v.verified === 'level' ? `audio arrived (${heard}; transcription unavailable)` : heard;
  return heard || 'nothing arrived';
}

const MIC_HINT =
  'The page did not hear Claude Anywhere. Check that this site uses the "Default" microphone (the camera/microphone icon in the address bar), and that the call app also uses "Default".';
const CAPTURE_HINT =
  'Claude Anywhere did not hear this tab. Play something in this browser and run the test again; on Windows check that your speakers (not CABLE Input) are the default output.';

/**
 * Run the whole test.
 * @param {object} deps
 * @param {string} deps.code                 the single-use code from the URL
 * @param {Function} deps.fetch
 * @param {Function} [deps.createRecorder]   () => {start(), stop()->Promise<Blob>}
 * @param {Function} [deps.createAudioContext] () => AudioContext
 * @param {(step:string, state:'run'|'pass'|'warn'|'fail'|'idle', detail?:string)=>void} [deps.onStep]
 * @param {(level:number)=>void} [deps.onLevel]
 * @param {(fn:()=>void)=>void} [deps.onUnload] registers a finish() for page close
 * @param {Function} [deps.wait]             sleep(ms)
 * @returns {Promise<{pass:boolean, mic:object|null, capture:object|null, error?:Error}>}
 */
export async function runAudioTest(deps) {
  const fetchFn = deps.fetch;
  const wait = deps.wait || sleep;
  const step = deps.onStep || (() => {});
  const createRecorder = deps.createRecorder || (() => new WavRecorder({ vad: false, onLevel: deps.onLevel }));
  const createCtx = deps.createAudioContext || (() => new (globalThis.AudioContext || globalThis.webkitAudioContext)());
  const out = { pass: false, mic: null, capture: null };
  let test = null;
  let finished = false;
  let ctx = null;
  let keepAlive = null;
  const finish = async () => {
    if (finished || !test) return null;
    finished = true;
    try {
      return await postStep(fetchFn, 'finish', { test: test.test });
    } catch {
      return null;
    }
  };
  if (deps.onUnload) {
    deps.onUnload(() => {
      if (!finished && test) {
        finished = true;
        try {
          if (globalThis.navigator && navigator.sendBeacon) navigator.sendBeacon(`${API}finish?test=${encodeURIComponent(test.test)}`);
        } catch {
          /* best effort; the daemon also releases the routing when the test expires */
        }
      }
    });
  }

  try {
    // 1. Routing.
    step('route', 'run');
    if (!/^[a-f0-9]{32}$/.test(String(deps.code || ''))) throw Object.assign(new Error('This page needs the link from: anywhere calls test-audio'), { status: 403 });
    test = await postStep(fetchFn, 'begin', { code: deps.code });
    if (!test.ok) {
      const e = new Error((test.error && test.error.message) || 'The audio routing could not be set up');
      e.hint = test.error && test.error.hint;
      throw e;
    }
    const modeText = test.mode === 'speakers' ? 'speaker mode (no virtual devices; lower quality)' : 'virtual microphone';
    const warn = (test.issues || []).filter((i) => i.level === 'warn' || i.level === 'error');
    step('route', warn.length || test.mode === 'speakers' ? 'warn' : 'pass', `${modeText}${warn.length ? `: ${warn.map((i) => i.message).join(' ')}` : ''}`);

    // The playback context first, so this tab's audio stream exists before the daemon routes it.
    try {
      ctx = createCtx();
      if (ctx.state === 'suspended' && ctx.resume) await Promise.race([ctx.resume().catch(() => {}), wait(1000)]);
      if (ctx.createConstantSource) {
        keepAlive = ctx.createConstantSource();
        keepAlive.offset.value = 0;
        keepAlive.connect(ctx.destination);
        keepAlive.start();
      }
    } catch {
      ctx = null;
    }

    // 2. Claude Anywhere -> this browser (the virtual microphone).
    step('mic', 'run', 'Recording the microphone; Claude Anywhere is speaking…');
    try {
      const rec = createRecorder();
      await rec.start();
      await wait(600);
      await postStep(fetchFn, 'speak', { test: test.test });
      await wait(800);
      const blob = await rec.stop();
      const r = await postStep(fetchFn, 'upload', { test: test.test }, blob);
      out.mic = r;
      step('mic', r.pass ? (r.verified === 'level' ? 'warn' : 'pass') : 'fail', r.pass ? describeVerdict(r) : `${describeVerdict(r)}. ${MIC_HINT}`);
    } catch (err) {
      out.mic = { pass: false, error: { message: err.message, code: err.code } };
      step('mic', 'fail', `${err.message}${err.hint ? ` ${err.hint}` : ''}`);
    }

    // 3. This browser -> Claude Anywhere (the caller capture).
    step('capture', 'run', 'Playing a clip; Claude Anywhere is listening…');
    try {
      if (!ctx) throw new Error('This browser cannot play audio here (Web Audio is unavailable)');
      if (!test.clip || !test.clip.base64) throw new Error('The daemon did not send a test clip');
      const bytes = base64ToBytes(test.clip.base64);
      const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
      const started = await postStep(fetchFn, 'capture', { test: test.test });
      if (started.ok === false) throw Object.assign(new Error((started.error && started.error.message) || 'Recording did not start'), { hint: started.error && started.error.hint });
      await wait(300);
      await new Promise((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        const done = () => resolve();
        src.onended = done;
        src.start();
        setTimeout(done, Math.ceil((buffer.duration || 6) * 1000) + 1500);
      });
      const r = await postStep(fetchFn, 'result', { test: test.test });
      out.capture = r;
      step('capture', r.pass ? (r.verified === 'level' ? 'warn' : 'pass') : 'fail', r.pass ? describeVerdict(r) : `${describeVerdict(r)}. ${CAPTURE_HINT}`);
    } catch (err) {
      out.capture = { pass: false, error: { message: err.message, code: err.code } };
      step('capture', 'fail', `${err.message}${err.hint ? ` ${err.hint}` : ''}`);
    }
  } catch (err) {
    out.error = err;
    step('route', 'fail', `${err.message}${err.hint ? ` ${err.hint}` : ''}`);
  } finally {
    try {
      if (keepAlive) keepAlive.stop();
    } catch {
      /* ignore */
    }
    try {
      if (ctx && ctx.close) await ctx.close();
    } catch {
      /* ignore */
    }
    if (test) {
      step('restore', 'run');
      const f = await finish();
      step('restore', f && f.released !== false ? 'pass' : 'warn', f && f.released !== false ? 'Your microphone is the default again.' : 'Could not confirm the restore; run: anywhere calls audio teardown');
    }
  }
  out.pass = Boolean(out.mic && out.mic.pass && out.capture && out.capture.pass);
  return out;
}

// ---------------------------------------------------------------------------------- page wiring

function mount() {
  const doc = globalThis.document;
  const startBtn = doc && doc.getElementById('cat-start');
  if (!startBtn) return;
  const params = new URLSearchParams(globalThis.location.search);
  const code = params.get('code') || '';
  const level = doc.getElementById('cat-level');
  const summary = doc.getElementById('cat-summary');
  const setStep = (name, state, detail) => {
    const li = doc.querySelector(`.cat-step[data-step="${name}"]`);
    if (!li) return;
    li.dataset.state = state;
    if (detail != null) li.querySelector('[data-detail]').textContent = detail;
  };
  let running = false;
  const start = async () => {
    if (running) return;
    running = true;
    startBtn.disabled = true;
    summary.hidden = true;
    for (const s of ['route', 'mic', 'capture', 'restore']) setStep(s, 'idle');
    const r = await runAudioTest({
      code,
      fetch: (...a) => globalThis.fetch(...a),
      onStep: setStep,
      onLevel: (v) => {
        if (level) level.style.width = `${Math.round(Math.min(1, v) * 100)}%`;
      },
      onUnload: (fn) => globalThis.addEventListener('pagehide', fn, { once: true }),
    });
    if (level) level.style.width = '0%';
    summary.hidden = false;
    summary.textContent = '';
    const head = doc.createElement('div');
    const hint = doc.createElement('div');
    hint.className = 'cat-hint';
    if (r.pass) {
      summary.dataset.state = 'pass';
      head.textContent = 'Both directions work. Claude Anywhere can talk and listen in calls in this browser.';
    } else if (r.error && r.error.status === 403) {
      summary.dataset.state = 'fail';
      head.textContent = 'This test link expired or was already used.';
      hint.textContent = 'Run it again: anywhere calls test-audio';
    } else {
      summary.dataset.state = (r.mic && r.mic.pass) || (r.capture && r.capture.pass) ? 'warn' : 'fail';
      head.textContent = 'The audio test did not pass.';
      hint.textContent = (r.error && (r.error.hint || r.error.message)) || 'See the steps above, then run the test again: anywhere calls test-audio';
    }
    summary.append(head);
    if (hint.textContent) summary.append(hint);
    doc.documentElement.dataset.result = r.pass ? 'pass' : 'fail';
    startBtn.textContent = 'Done';
    globalThis.__anywhereAudioTest = r;
  };
  startBtn.addEventListener('click', start);
  if (params.get('auto') === '1') start();
}

if (globalThis.document && globalThis.location) {
  if (globalThis.document.readyState === 'loading') globalThis.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
