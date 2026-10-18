'use strict';

/**
 * Spoken announcements in the dialog (src/ui/voice.js, src/ui/app.js):
 *  - the most natural free browser voice is chosen when none is set (rankVoices, pickNaturalVoice);
 *  - SSE 'announce' events are queued and never overlap; the newest permission or question goes
 *    first; each plays an optional WebAudio chime, then the daemon's WAV (GET /api/tts/audio with
 *    the Bearer header, from a blob: URL that is revoked afterwards) or, without audio, the text
 *    through speechSynthesis;
 *  - barge-in (the mic, typing, Esc) stops the audio and empties the queue;
 *  - with the daemon's announcer on, 'result' events are not spoken by the page;
 *  - "Read aloud" uses the daemon's natural voice (POST /api/tts/synthesize) when it is in use.
 *
 * The Node cases import the browser module with fake browser APIs (as ui-fixes.test.js does).
 * The browser cases drive headless Chromium against test/fixtures/ui-stub-server.js and are
 * skipped without a Chromium binary (set ANYWHERE_TEST_CHROME) or a global WebSocket (Node < 22).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { launchChrome } = require('./fixtures/chrome-launch');
const { createStubServer, makeWav } = require('./fixtures/ui-stub-server');

const UI = path.join(__dirname, '..', 'src', 'ui');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-ui-announce-'));
fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"module"}\n');
for (const f of fs.readdirSync(UI)) if (f.endsWith('.js')) fs.copyFileSync(path.join(UI, f), path.join(TMP, f));

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const load = () => import(pathToFileURL(path.join(TMP, 'voice.js')).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

const ARIA = 'Microsoft Aria Online (Natural) - English (United States)';
const VOICES = [
  { name: 'Microsoft David - English (United States)', lang: 'en-US', default: true, localService: true },
  { name: 'Google US English', lang: 'en-US', default: false, localService: false },
  { name: 'Microsoft Ana Online (Natural) - English (United States)', lang: 'en-US', default: false, localService: false },
  { name: ARIA, lang: 'en-US', default: false, localService: false },
  { name: 'Microsoft Sonia Online (Natural) - English (United Kingdom)', lang: 'en-GB', default: false, localService: false },
  { name: 'Microsoft Katja Online (Natural) - German (Germany)', lang: 'de-DE', default: false, localService: false },
  { name: 'Samantha (Enhanced)', lang: 'en-US', default: false, localService: true },
  { name: 'Zarvox', lang: 'en-US', default: false, localService: true },
];

// ------------------------------------------------------------------ natural voice ranking

test('rankVoices: Natural, Neural, Premium, Enhanced, Siri, Google, then the rest; same language only', async () => {
  const { rankVoices, pickNaturalVoice } = await load();
  const ranked = rankVoices(VOICES, 'en-US').map((v) => v.name);
  assert.equal(ranked[0], ARIA, 'an adult Natural voice of the exact region first');
  assert.deepEqual(ranked, [
    ARIA,
    'Microsoft Ana Online (Natural) - English (United States)',
    'Microsoft Sonia Online (Natural) - English (United Kingdom)',
    'Samantha (Enhanced)',
    'Google US English',
    'Microsoft David - English (United States)',
    'Zarvox',
  ]);
  assert.equal(pickNaturalVoice(VOICES, 'de-DE').name, 'Microsoft Katja Online (Natural) - German (Germany)');
  assert.equal(pickNaturalVoice(VOICES, 'fr-FR'), null, 'no voice of another language');
  assert.equal(pickNaturalVoice([], 'en-US'), null);

  const tiers = [
    { name: 'Google UK English Female', lang: 'en-GB' },
    { name: 'Daniel (Siri)', lang: 'en-GB' },
    { name: 'Kate (Enhanced)', lang: 'en-GB' },
    { name: 'Serena (Premium)', lang: 'en-GB' },
    { name: 'Libby Neural', lang: 'en-GB' },
    { name: 'Daniel', lang: 'en-GB', default: true },
  ];
  assert.deepEqual(rankVoices(tiers, 'en-GB').map((v) => v.name), ['Libby Neural', 'Serena (Premium)', 'Kate (Enhanced)', 'Daniel (Siri)', 'Google UK English Female', 'Daniel']);
  // Android lists languages with an underscore.
  assert.equal(pickNaturalVoice([{ name: 'English United States', lang: 'en_US' }], 'en-US').name, 'English United States');
  // Without a natural voice, the browser default of the language wins over other local voices.
  assert.equal(pickNaturalVoice([{ name: 'Alex', lang: 'en-US' }, { name: 'Fred', lang: 'en-US', default: false }, { name: 'Tom', lang: 'en-US', default: true }], 'en-US').name, 'Tom');
});

// ------------------------------------------------------------------ announcer with fake browser APIs

/** Fake speechSynthesis, <audio>, blob URLs and WebAudio; returns a log and a restore(). */
function installFakes({ voices = VOICES, synthEndMs = 20 } = {}) {
  const log = { spoken: [], played: [], paused: [], created: [], revoked: [], osc: [], overlaps: 0 };
  const audios = [];
  const g = globalThis;
  const saved = {};
  for (const k of ['speechSynthesis', 'SpeechSynthesisUtterance', 'Audio', 'AudioContext', 'SpeechRecognition']) saved[k] = Object.getOwnPropertyDescriptor(g, k);
  const savedUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

  const playing = () => audios.some((a) => !a.paused);
  const synth = {
    speaking: false,
    live: [],
    getVoices: () => voices,
    speak(u) {
      if (this.speaking || playing()) log.overlaps += 1;
      log.spoken.push({ text: u.text, voice: u.voice ? u.voice.name : null, at: Date.now() });
      this.speaking = true;
      const entry = { u };
      entry.t = setTimeout(() => {
        this.live = this.live.filter((x) => x !== entry);
        this.speaking = this.live.length > 0;
        if (u.onend) u.onend({});
      }, synthEndMs);
      this.live.push(entry);
    },
    cancel() {
      const live = this.live;
      this.live = [];
      this.speaking = false;
      for (const e of live) {
        clearTimeout(e.t);
        if (e.u.onerror) e.u.onerror({ error: 'interrupted' });
      }
    },
    resume() {},
    addEventListener() {},
    removeEventListener() {},
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  class FakeAudio {
    constructor() {
      this.paused = true;
      this.src = '';
      audios.push(this);
    }

    play() {
      if (synth.speaking || playing()) log.overlaps += 1;
      log.played.push(this.src);
      this.paused = false;
      if (FakeAudio.autoEndMs != null) {
        this.t = setTimeout(() => this.end(), FakeAudio.autoEndMs);
      }
      return FakeAudio.playError ? Promise.reject(FakeAudio.playError) : Promise.resolve();
    }

    pause() {
      if (!this.paused) log.paused.push(this.src);
      this.paused = true;
      clearTimeout(this.t);
    }

    removeAttribute(name) {
      if (name === 'src') this.src = '';
    }

    end() {
      clearTimeout(this.t);
      this.paused = true;
      if (this.onended) this.onended();
    }
  }
  FakeAudio.autoEndMs = 30;
  FakeAudio.playError = null;
  class FakeCtx {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
    }

    resume() {
      this.state = 'running';
      return Promise.resolve();
    }

    suspend() {
      this.state = 'suspended';
      return Promise.resolve();
    }

    createGain() {
      return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }

    createOscillator() {
      const o = { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {}, at: Date.now() };
      log.osc.push(o);
      return o;
    }
  }
  let n = 0;
  const set = (k, v) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  set('speechSynthesis', synth);
  set('SpeechSynthesisUtterance', Utterance);
  set('Audio', FakeAudio);
  set('AudioContext', FakeCtx);
  set('SpeechRecognition', undefined);
  URL.createObjectURL = () => {
    n += 1;
    const u = `blob:fake/${n}`;
    log.created.push(u);
    return u;
  };
  URL.revokeObjectURL = (u) => log.revoked.push(u);
  const restore = () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
    URL.createObjectURL = savedUrl.create;
    URL.revokeObjectURL = savedUrl.revoke;
  };
  return { log, audios, synth, FakeAudio, restore };
}

class NoRecorder {
  static isSupported() {
    return false;
  }
}

async function setup(t, opts = {}) {
  const fakes = installFakes(opts);
  t.after(fakes.restore);
  const { createVoice } = await load();
  const cfg = { voice: { tts: 'auto', language: 'en-US', chime: true, ...(opts.voice || {}) } };
  const calls = { api: [], fetches: [], errors: [] };
  const voice = createVoice({
    getConfig: () => cfg,
    getServerVoice: () => ({ serverTts: true }),
    api: async (method, p, body) => {
      calls.api.push([method, p, body]);
      return opts.api ? opts.api(method, p, body) : {};
    },
    fetchBlob: async (p) => {
      calls.fetches.push(p);
      if (opts.fetchBlob) return opts.fetchBlob(p);
      return new Blob([makeWav(50)], { type: 'audio/wav' });
    },
    onError: (message, o = {}) => calls.errors.push({ message, ...o }),
    Recorder: NoRecorder,
  });
  t.after(() => voice.cancelSpeech());
  return { voice, cfg, calls, ...fakes };
}

const ann = (id, kind, text, audio = null, chime = false) => ({ id, kind, text, audio, chime, ts: new Date().toISOString() });

test('announce: audio is fetched by id, played from a blob: URL, and the URL is revoked after', async (t) => {
  const { voice, log, calls } = await setup(t);
  assert.equal(voice.announce(ann('a1', 'done', 'The deploy finished.', { id: 'aud_1', mime: 'audio/wav', durationMs: 50 })), true);
  assert.ok(await until(() => log.played.length === 1), 'played');
  assert.deepEqual(calls.fetches, ['/api/tts/audio?id=aud_1']);
  assert.equal(log.played[0], log.created[0]);
  assert.match(log.played[0], /^blob:/);
  assert.equal(voice.isSpeaking(), true, 'speaking while the clip plays');
  assert.ok(await until(() => log.revoked.includes(log.created[0])), 'the blob URL is revoked once it ended');
  assert.ok(await until(() => !voice.isSpeaking()));
  assert.deepEqual(log.spoken, [], 'the text is not spoken as well');
  assert.equal(voice.announce(ann('a1', 'done', 'The deploy finished.', { id: 'aud_1' })), false, 'the same announcement is not played twice');
});

test('announce: queued, never overlapping, and the newest permission or question goes first', async (t) => {
  const { voice, log, FakeAudio, audios } = await setup(t);
  FakeAudio.autoEndMs = null; // ends when the test says so
  voice.announce(ann('d1', 'done', 'First result.', { id: 'aud_d1', durationMs: 900 }));
  assert.ok(await until(() => log.played.length === 1));
  voice.announce(ann('d2', 'done', 'Second result.'));
  voice.announce(ann('p1', 'permission', 'Claude needs your OK to deploy.'));
  voice.announce(ann('q1', 'question', 'Which project should I use?'));
  assert.deepEqual(voice.announcements(), { current: 'done', queued: ['question', 'permission', 'done'] });
  await sleep(150);
  assert.deepEqual(log.spoken, [], 'nothing talks over the clip');
  audios[0].end();
  assert.ok(await until(() => log.spoken.length === 3, 5000), `all spoken (${JSON.stringify(log.spoken.map((s) => s.text))})`);
  assert.deepEqual(log.spoken.map((s) => s.text), ['Which project should I use?', 'Claude needs your OK to deploy.', 'Second result.']);
  assert.equal(log.overlaps, 0, 'no two announcements at once');
  assert.ok(log.spoken.every((s) => s.voice === ARIA), 'spoken with the most natural voice');
  assert.ok(await until(() => !voice.isSpeaking()));
});

test('announce: barge-in stops the clip, revokes its URL, drops the queue and stops the daemon', async (t) => {
  const { voice, log, calls, FakeAudio } = await setup(t);
  FakeAudio.autoEndMs = null;
  voice.announce(ann('b1', 'done', 'A long summary.', { id: 'aud_b1', durationMs: 20000 }));
  voice.announce(ann('b2', 'error', 'The tests failed.'));
  assert.ok(await until(() => log.played.length === 1));
  voice.cancelSpeech();
  assert.deepEqual(log.paused, [log.created[0]], 'the clip stopped');
  assert.ok(log.revoked.includes(log.created[0]), 'its URL was revoked');
  assert.deepEqual(voice.announcements(), { current: null, queued: [] });
  assert.equal(voice.isSpeaking(), false);
  await sleep(400);
  assert.deepEqual(log.spoken, [], 'the queued announcement was dropped');
  assert.ok(calls.api.some(([m, p]) => m === 'POST' && p === '/api/tts/stop'), 'the daemon is told to stop too');
  // Starting the microphone is a barge-in as well (start() cancels speech first).
  voice.announce(ann('b3', 'done', 'Another one.', { id: 'aud_b3', durationMs: 20000 }));
  assert.ok(await until(() => log.played.length === 2));
  voice.start('toggle'); // no recognizer or recorder here: it reports that, after stopping speech
  assert.equal(log.paused.length, 2);
  assert.equal(voice.isSpeaking(), false);
});

test('announce: audio that cannot be fetched or played is spoken from its text', async (t) => {
  const { voice, log } = await setup(t, {
    fetchBlob: async () => {
      throw Object.assign(new Error('That audio is gone'), { status: 404 });
    },
  });
  t.mock.method(console, 'warn', () => {});
  voice.announce(ann('f1', 'done', 'Deploy finished.', { id: 'gone' }));
  assert.ok(await until(() => log.spoken.length === 1));
  assert.deepEqual(log.spoken[0].text, 'Deploy finished.');
  assert.equal(log.spoken[0].voice, ARIA);

  // Refused by the browser (autoplay): the same.
  const second = await setup(t);
  second.FakeAudio.playError = Object.assign(new Error('play() failed because the user did not interact'), { name: 'NotAllowedError' });
  second.voice.announce(ann('f2', 'permission', 'Approve the deploy?', { id: 'aud_f2', durationMs: 100 }));
  assert.ok(await until(() => second.log.spoken.length === 1));
  assert.equal(second.log.spoken[0].text, 'Approve the deploy?');
  assert.ok(second.log.revoked.includes(second.log.created[0]), 'the URL is revoked after a failed play');
});

test('announce: a chime (two notes per kind) plays first when the event and the setting ask for it', async (t) => {
  const { CHIME_NOTES } = await load();
  const { voice, log } = await setup(t);
  voice.announce(ann('c1', 'question', 'Which region?', null, true));
  assert.ok(await until(() => log.spoken.length === 1, 3000));
  const freqs = log.osc.map((o) => o.frequency.value);
  assert.ok(freqs.includes(CHIME_NOTES.question[0]) && freqs.includes(CHIME_NOTES.question[1]), `question chime notes (${freqs.join(', ')})`);
  assert.ok(log.osc.every((o) => o.at <= log.spoken[0].at), 'the chime starts before the words');
  for (const kind of ['done', 'permission', 'question', 'error', 'info']) assert.equal(CHIME_NOTES[kind].length, 2, kind);
  assert.notDeepEqual(CHIME_NOTES.done, CHIME_NOTES.error);

  const off = await setup(t, { voice: { chime: false } });
  off.voice.announce(ann('c2', 'done', 'Done.', null, true));
  assert.ok(await until(() => off.log.spoken.length === 1));
  assert.equal(off.log.osc.length, 0, 'voice.chime false: no chime');
  const noChime = await setup(t);
  noChime.voice.announce(ann('c3', 'done', 'Done.', null, false));
  assert.ok(await until(() => noChime.log.spoken.length === 1));
  assert.equal(noChime.log.osc.length, 0, 'chime:false in the event: no chime');
});

test('announce: nothing plays with speech output off; empty events are ignored', async (t) => {
  const { voice, log, calls } = await setup(t, { voice: { tts: 'off' } });
  assert.equal(voice.announce(ann('o1', 'done', 'Done.', { id: 'aud_o1' })), false);
  const other = await setup(t);
  assert.equal(other.voice.announce({ id: 'e1', kind: 'done', text: '  ', audio: null }), false);
  assert.equal(other.voice.announce(null), false);
  await sleep(150);
  assert.deepEqual([log.played, log.spoken, calls.fetches, other.log.spoken], [[], [], [], []]);
});

test('announce: an answered card drops its waiting or playing announcement', async (t) => {
  const { voice, log, FakeAudio } = await setup(t);
  FakeAudio.autoEndMs = null;
  voice.announce(ann('x1', 'done', 'Result.', { id: 'aud_x1', durationMs: 20000 }));
  assert.ok(await until(() => log.played.length === 1));
  voice.announce(ann('x2', 'permission', 'Allow the deploy?'));
  voice.announce(ann('x3', 'question', 'Which project?'));
  voice.dropAnnouncements('permission');
  assert.deepEqual(voice.announcements(), { current: 'done', queued: ['question'] });
  voice.cancelSpeech();
  voice.announce(ann('x4', 'permission', 'Allow npm publish?', { id: 'aud_x4', durationMs: 20000 }));
  assert.ok(await until(() => log.played.length === 2));
  voice.dropAnnouncements('permission');
  assert.equal(log.paused.length, 2, 'the playing permission announcement stopped');
  assert.deepEqual(voice.announcements(), { current: null, queued: [] });
});

test('announce: waits for a read-aloud the user started, then plays', async (t) => {
  const { voice, log } = await setup(t, { synthEndMs: 300 });
  voice.speak('This is the answer you asked to hear.');
  await sleep(120);
  voice.announce(ann('w1', 'done', 'Background task finished.', { id: 'aud_w1', durationMs: 50 }));
  await sleep(150);
  assert.deepEqual(log.played, [], 'not over the read-aloud');
  assert.ok(await until(() => log.played.length === 1, 3000), 'played after it');
  assert.equal(log.overlaps, 0);
});

test('read aloud with the natural voice: synthesize, then play the WAV; falls back to the browser voice', async (t) => {
  const { voice, log, calls } = await setup(t, {
    api: async (method, p) => (p === '/api/tts/synthesize' ? { id: 'aud_n1', mime: 'audio/wav', engine: 'piper', durationMs: 50 } : {}),
  });
  voice.speakNatural('**Deployed** to `prod`. See https://example.com');
  assert.ok(await until(() => log.played.length === 1));
  const synth = calls.api.find(([, p]) => p === '/api/tts/synthesize');
  assert.deepEqual(synth.slice(0, 2), ['POST', '/api/tts/synthesize']);
  assert.equal(synth[2].text, 'Deployed to prod. See the link', 'markdown is stripped for speech');
  assert.deepEqual(calls.fetches, ['/api/tts/audio?id=aud_n1']);
  assert.ok(await until(() => log.revoked.length === 1));

  const failing = await setup(t, {
    api: async (method, p) => {
      if (p === '/api/tts/synthesize') throw Object.assign(new Error('The natural voice is not installed.'), { status: 409 });
      return {};
    },
  });
  failing.voice.speakNatural('Hello there.');
  assert.ok(await until(() => failing.log.spoken.length === 1));
  assert.equal(failing.log.spoken[0].text, 'Hello there.');
  assert.match(failing.calls.errors[0].message, /natural voice couldn't read this/);
  assert.equal(failing.calls.errors[0].level, 'info');
});

// ------------------------------------------------------------------ headless Chromium

function findChrome() {
  if (process.env.ANYWHERE_TEST_CHROME) return fs.existsSync(process.env.ANYWHERE_TEST_CHROME) ? process.env.ANYWHERE_TEST_CHROME : null;
  const candidates = [];
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) candidates.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'));
  } catch {
    /* not a Playwright image */
  }
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge']) {
      try {
        const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (p) candidates.push(p);
      } catch {
        /* not installed */
      }
    }
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function browserSkip(t) {
  const chrome = findChrome();
  if (!chrome) {
    t.skip('no Chromium found (set ANYWHERE_TEST_CHROME)');
    return null;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('needs a global WebSocket (Node >= 22)');
    return null;
  }
  return chrome;
}

/** Tiny CDP client over the page WebSocket (as in ui-round2.test.js). */
async function openPage(chrome, { width = 440, height = 720 } = {}) {
  // Like the app window UiHost opens: audio may start without a click.
  const { port, cleanup } = await launchChrome(chrome, { prefix: 'anywhere-chrome-ann-', extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = (id += 1);
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.bringToFront');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.result.value;
  };
  const close = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return cleanup();
  };
  return { send, evaluate, problems, close };
}

async function waitFor(page, expr, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(expr)) return true;
    await sleep(80);
  }
  return false;
}

// Records what the page says and plays: a speechSynthesis stand-in with Edge-like voices, and
// probes on <audio> playback, blob: URL revocation and chime oscillators.
const PAGE_PROBES = `(() => {
  const voices = [
    { name: 'English (America)+espeak', lang: 'en-US', default: true, localService: true, voiceURI: 'espeak' },
    { name: 'Google US English', lang: 'en-US', default: false, localService: false, voiceURI: 'Google US English' },
    { name: ${JSON.stringify(ARIA)}, lang: 'en-US', default: false, localService: false, voiceURI: 'aria' },
  ];
  window.__spoken = [];
  const synth = {
    speaking: false,
    getVoices: () => voices,
    speak(u) {
      window.__spoken.push({ text: u.text, voice: u.voice ? u.voice.name : null });
      this.speaking = true;
      setTimeout(() => { this.speaking = false; if (u.onend) u.onend({}); }, 60);
    },
    cancel() { this.speaking = false; },
    resume() {}, pause() {}, addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  window.__played = []; window.__paused = []; window.__revoked = []; window.__osc = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__played.push(this.src); return play.call(this); };
  const pause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function () { if (!this.paused) window.__paused.push(this.src); return pause.call(this); };
  const revoke = URL.revokeObjectURL;
  URL.revokeObjectURL = function (u) { window.__revoked.push(u); return revoke.call(URL, u); };
  const d = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
  Object.defineProperty(AudioParam.prototype, 'value', { configurable: true, get: d.get, set(v) { if (this.__osc) window.__osc.push(v); d.set.call(this, v); } });
  const create = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function () { const o = create.call(this); o.frequency.__osc = true; return o; };
})()`;

async function loadDialog(page, stub) {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_PROBES });
  await page.send('Page.navigate', { url: stub.url });
  assert.ok(await waitFor(page, `document.getElementById('status') && document.getElementById('status').dataset.state === 'idle'`), 'dialog connects');
}

test('headless Chromium: an announce with audio is fetched with the Bearer header and played from a blob: URL; one without is spoken naturally', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty', piperInstalled: true });
  t.after(() => stub.close());
  const page = await openPage(chrome);
  t.after(() => page.close());
  await loadDialog(page, stub);

  const a = stub.announce({ kind: 'done', text: 'The deploy to Cloud Run finished.', audio: true, chime: true });
  assert.ok(await waitFor(page, `window.__played.length === 1`), 'the clip played');
  assert.deepEqual(stub.state.audioRequests, [{ id: a.audio.id, auth: 'Bearer tok' }], 'fetched with the Bearer header');
  const played = await page.evaluate(`window.__played[0]`);
  assert.match(played, /^blob:http:\/\/127\.0\.0\.1:\d+\//);
  assert.ok(await waitFor(page, `window.__revoked.includes(${JSON.stringify(played)})`, 8000), 'the blob URL was revoked after playing');
  const osc = await page.evaluate(`window.__osc`);
  assert.ok(osc.includes(659.25) && osc.includes(987.77), `the "done" chime played first (${osc.join(', ')})`);
  assert.deepEqual(await page.evaluate(`window.__spoken`), [], 'the text was not spoken as well');

  stub.announce({ kind: 'permission', text: 'Claude needs your OK to run gcloud run deploy.', audio: false, chime: false });
  assert.ok(await waitFor(page, `window.__spoken.length === 1`), 'spoken');
  assert.deepEqual(await page.evaluate(`window.__spoken`), [{ text: 'Claude needs your OK to run gcloud run deploy.', voice: ARIA }], 'with the most natural voice');
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: with the announcer on, results are not spoken by the page; typing stops announcement audio', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty', piperInstalled: true });
  t.after(() => stub.close());
  stub.state.config.voice.speakResponses = true;
  const page = await openPage(chrome);
  t.after(() => page.close());
  await loadDialog(page, stub);

  stub.broadcast('result', { text: 'All three services are deployed.', costUsd: 0.01, totalCostUsd: 0.05, durationMs: 900, isError: false, sessionId: 's', numTurns: 1 });
  await sleep(700);
  assert.deepEqual(await page.evaluate(`window.__spoken`), [], 'the daemon announces results, so the page stays quiet');

  // An older daemon (no announcer): the page speaks the result itself, as before.
  stub.state.voiceInfo.announcer = false;
  stub.broadcast('snapshot', stub.snapshot());
  await sleep(200);
  stub.broadcast('result', { text: 'Done with the migration.', costUsd: 0.01, totalCostUsd: 0.06, durationMs: 900, isError: false, sessionId: 's', numTurns: 1 });
  assert.ok(await waitFor(page, `window.__spoken.some((s) => s.text === 'Done with the migration.')`), 'spoken without the announcer');
  stub.state.voiceInfo.announcer = true;
  stub.broadcast('snapshot', stub.snapshot());
  await sleep(200);

  // Barge-in: typing stops a long clip at once and frees its URL.
  stub.announce({ kind: 'done', text: 'A long summary of everything that happened.', audio: true, chime: false, ms: 6000 });
  assert.ok(await waitFor(page, `window.__played.length === 1`));
  await sleep(250);
  await page.evaluate(`(() => { const i = document.getElementById('input'); i.focus(); i.value = 'w'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.ok(await waitFor(page, `window.__paused.length === 1 && window.__revoked.includes(window.__played[0])`, 1500), 'typing stopped the clip');

  // Esc stops one too.
  stub.announce({ kind: 'error', text: 'The build failed.', audio: true, chime: false, ms: 6000 });
  assert.ok(await waitFor(page, `window.__played.length === 2`));
  await sleep(250);
  await page.evaluate(`document.getElementById('input').value = ''; document.body.focus()`);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.ok(await waitFor(page, `window.__paused.length === 2`, 1500), 'Esc stopped the clip');
  assert.equal(stub.state.interrupts, 0, 'Esc stopped the speech, not Claude');
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: only the window that last had focus plays announcements; Read aloud uses the natural voice', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty', piperInstalled: true });
  t.after(() => stub.close());
  const page = await openPage(chrome);
  t.after(() => page.close());
  await loadDialog(page, stub);

  // Another dialog window takes over (the BroadcastChannel message it sends when focused).
  await page.evaluate(`new BroadcastChannel('claude-anywhere').postMessage({ type: 'speaker', id: 'other-window' })`);
  await sleep(150);
  stub.announce({ kind: 'done', text: 'Finished in the other window.', audio: true, chime: false });
  await sleep(600);
  assert.equal(await page.evaluate(`window.__played.length + window.__spoken.length`), 0, 'a window in the background stays quiet');
  assert.equal(stub.state.audioRequests.length, 0);
  // Focused again: it plays.
  await page.evaluate(`window.dispatchEvent(new Event('focus'))`);
  stub.announce({ kind: 'done', text: 'Finished here.', audio: true, chime: false });
  assert.ok(await waitFor(page, `window.__played.length === 1`), 'the focused window plays');
  // (While something plays, the Read aloud button stops it instead.)
  assert.ok(await waitFor(page, `window.__revoked.includes(window.__played[0])`, 8000), 'the clip finished');

  // Read aloud: the daemon's natural voice reads the answer.
  stub.broadcast('message', { id: 'as1', role: 'assistant', text: 'The **API** is live at `https://api.example.com`.', ts: new Date().toISOString(), streaming: false });
  assert.ok(await waitFor(page, `Boolean(document.querySelector('.msg.assistant[data-id="as1"]'))`));
  await page.evaluate(`document.querySelector('.msg.assistant[data-id="as1"] [aria-label="Read aloud"]').click()`);
  assert.ok(await waitFor(page, `window.__played.length === 2`), 'the natural voice read it');
  assert.deepEqual(stub.state.synthesized, ['The API is live at the link.']);
  assert.equal(stub.state.audioRequests.length, 2);
  assert.ok(stub.state.audioRequests.every((r) => r.auth === 'Bearer tok'));
  assert.deepEqual(await page.evaluate(`window.__spoken`), [], 'not the browser voice');
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});
