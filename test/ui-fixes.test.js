'use strict';

/**
 * Regression tests for the dialog's voice module (src/ui/voice.js): stricter
 * approval and question intents, wake-word matching that ignores everyday
 * words and Claude's own speech, push-to-talk released during a recognizer
 * restart, server TTS/STT timeouts and retries, and the auto STT choice.
 *
 * src/ui holds browser ES modules; they are copied into a temp directory with
 * {"type":"module"} so dynamic import() works. Browser APIs are faked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const UI = path.join(__dirname, '..', 'src', 'ui');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-ui-fixes-'));
fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"module"}\n');
for (const f of fs.readdirSync(UI)) if (f.endsWith('.js')) fs.copyFileSync(path.join(UI, f), path.join(TMP, f));

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const load = () => import(pathToFileURL(path.join(TMP, 'voice.js')).href);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fakes

/** A stand-in for the browser's SpeechRecognition. */
class FakeSR {
  constructor() {
    FakeSR.all.push(this);
    this.started = false;
    this.ended = false;
  }

  start() {
    this.started = true;
  }

  stop() {
    // Like Chrome: stop() on a recognizer that already ended does nothing.
    if (this.ended || !this.started) return;
    this.end();
  }

  abort() {
    this.ended = true;
  }

  end() {
    this.ended = true;
    if (this.onend) this.onend();
  }

  /** Deliver one result (final or interim). */
  say(transcript, isFinal = true) {
    const result = { 0: { transcript }, length: 1, isFinal };
    this.onresult({ resultIndex: 0, results: [result] });
  }
}
FakeSR.all = [];

/** A stand-in for WavRecorder. */
class FakeRecorder {
  static isSupported() {
    return FakeRecorder.supported;
  }

  constructor({ vad }) {
    this.vad = vad;
    this.state = 'idle';
    this.hasSpeech = false;
    this.size = 44;
    FakeRecorder.all.push(this);
  }

  get recording() {
    return this.state === 'recording';
  }

  async start() {
    this.state = 'recording';
  }

  async stop() {
    this.state = 'done';
    return { size: this.size, type: 'audio/wav' };
  }

  cancel() {
    this.state = 'done';
  }
}
FakeRecorder.all = [];
FakeRecorder.supported = true;

/**
 * Build a voice controller with fake browser APIs.
 * @param {object} voiceCfg config.voice
 * @param {{sr?:boolean, api?:Function, serverVoice?:object}} [opts]
 */
async function makeVoice(voiceCfg, { sr = true, api, serverVoice = { serverStt: true, serverTts: true } } = {}) {
  const { createVoice } = await load();
  FakeSR.all = [];
  FakeRecorder.all = [];
  const prev = globalThis.SpeechRecognition;
  globalThis.SpeechRecognition = sr ? FakeSR : undefined;
  const log = { finals: [], errors: [], calls: [], states: [] };
  const voice = createVoice({
    getConfig: () => ({ voice: voiceCfg }),
    getServerVoice: () => serverVoice,
    api: api
      ? (...args) => {
          log.calls.push(args);
          return api(...args);
        }
      : async (...args) => {
          log.calls.push(args);
          return {};
        },
    onFinal: (text) => log.finals.push(text),
    onError: (message, o) => log.errors.push({ message, ...o }),
    onState: (s) => log.states.push(s.phase),
    Recorder: FakeRecorder,
  });
  globalThis.SpeechRecognition = prev;
  return { voice, log };
}

/** Shift Date.now() forward without waiting. */
function clock() {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  return {
    advance(ms) {
      offset += ms;
    },
    restore() {
      Date.now = real;
    },
  };
}

// ------------------------------------------------------------------ intents (UI-VOICE-1)

test('approval intents: only a plain yes or "always" allows; hedged speech is left for the card', async () => {
  const { parseVoiceIntent } = await load();
  const ap = { approval: true };
  for (const s of [
    'Always deny that',
    'Always ask me before deleting files',
    'Okay wait, what does that do?',
    'Yes, but do not run it as root',
    "Yeah no, don't do that",
    'go ahead and deny it',
    'No problem, go ahead',
    'yes and also delete the logs',
    'sure, after you back it up',
    'ok what is this',
    'yes '.repeat(40),
  ]) {
    assert.equal(parseVoiceIntent(s, ap).kind, 'unmatched_approval', s);
  }
  for (const s of ['yes', 'Yeah, go ahead.', 'OK, do it', 'yes please', 'sure thing', 'go ahead, thanks', 'Proceed.']) {
    assert.deepEqual(parseVoiceIntent(s, ap), { kind: 'approve', decision: 'allow' }, s);
  }
  for (const s of ['Always.', 'always allow', 'yes always', 'allow it for this session', 'Always allow this, please']) {
    assert.deepEqual(parseVoiceIntent(s, ap), { kind: 'approve', decision: 'allow_session' }, s);
  }
  // Denying stays prefix-based (the safe direction) and keeps the reason.
  assert.deepEqual(parseVoiceIntent('No, use the staging project instead', ap), { kind: 'approve', decision: 'deny', message: 'use the staging project instead' });
  assert.deepEqual(parseVoiceIntent('nope', ap), { kind: 'approve', decision: 'deny' });
});

// ------------------------------------------------------------------ question options (UI-VOICE-9)

test('question answers match whole option words, and hedged or ambiguous speech is sent as typed', async () => {
  const { parseVoiceIntent } = await load();
  const yn = { question: { options: ['Yes', 'No'] } };
  for (const s of ["I don't know, what do you recommend?", 'not sure', 'yesterday maybe', "yesterday's branch you mean?", 'no, not that one', 'yes no', 'nothing yet']) {
    assert.deepEqual(parseVoiceIntent(s, yn), { kind: 'answer', text: s }, s);
  }
  assert.deepEqual(parseVoiceIntent('Yes!', yn), { kind: 'answer', text: 'Yes' });
  assert.deepEqual(parseVoiceIntent('yes please', yn), { kind: 'answer', text: 'Yes' });
  assert.deepEqual(parseVoiceIntent('no thanks', yn), { kind: 'answer', text: 'No' });
  const q = { question: { options: ['my-proj-123', 'shop-staging', 'Create a new project'] } };
  assert.deepEqual(parseVoiceIntent('use my proj 123 please', q), { kind: 'answer', text: 'my-proj-123' });
  assert.deepEqual(parseVoiceIntent('new project', q), { kind: 'answer', text: 'Create a new project' });
  assert.deepEqual(parseVoiceIntent('not shop staging', q), { kind: 'answer', text: 'not shop staging' });
  assert.deepEqual(parseVoiceIntent('shop staging or my proj 123', q), { kind: 'answer', text: 'shop staging or my proj 123' });
  const nested = { question: { options: ['Deploy', 'Deploy to staging'] } };
  assert.deepEqual(parseVoiceIntent('deploy to staging please', nested), { kind: 'answer', text: 'Deploy to staging' });
});

// ------------------------------------------------------------------ wake word (UI-VOICE-3)

test('wake word: everyday words and mid-sentence mentions do not wake it; strict mode needs the exact phrase', async () => {
  const { matchWakeWord } = await load();
  const ww = 'hey claude';
  for (const s of [
    'Glad that worked. The file is saved.',
    'Cloud Run deployment finished',
    'I created a cloud storage bucket for you',
    'Claws are sharp',
    'OK, cloud storage is set up',
    'Clause 4 of the contract',
    'we need a cloud bucket',
    'a cloud function',
  ]) {
    assert.equal(matchWakeWord(s, ww).matched, false, s);
  }
  assert.equal(matchWakeWord('I restarted the computer for you', 'computer').matched, false);
  assert.deepEqual(matchWakeWord('okay computer, lock the screen', 'computer'), { matched: true, rest: 'lock the screen' });
  // Still tolerant at the start of an utterance.
  assert.deepEqual(matchWakeWord('okay claude open mail', ww), { matched: true, rest: 'open mail' });
  assert.deepEqual(matchWakeWord('hey cloud deploy this', ww), { matched: true, rest: 'deploy this' });
  assert.deepEqual(matchWakeWord('so I said hey claude open mail', ww), { matched: true, rest: 'open mail' });
  // Strict (while Claude speaks): exact phrase at the start only.
  assert.equal(matchWakeWord('hey cloud deploy this', ww, { strict: true }).matched, false);
  assert.equal(matchWakeWord('Claude Code is installed', ww, { strict: true }).matched, false);
  assert.equal(matchWakeWord('so I said hey claude open mail', ww, { strict: true }).matched, false);
  assert.deepEqual(matchWakeWord('Hey Claude, stop', ww, { strict: true }), { matched: true, rest: 'stop' });
  assert.deepEqual(matchWakeWord('okay, hey claude, stop', ww, { strict: true }), { matched: true, rest: 'stop' });
});

test("hands-free ignores Claude's own speech unless it starts with the exact wake phrase", async () => {
  let finishTts;
  const api = (method, p) => (p === '/api/tts' ? new Promise((resolve) => (finishTts = resolve)) : Promise.resolve({}));
  const { voice, log } = await makeVoice({ stt: 'browser', tts: 'server', wakeWord: 'hey claude', handsFree: true }, { api });
  const c = clock();
  try {
    voice.start('handsfree');
    const rec = FakeSR.all[0];
    rec.onstart();
    rec.say('hey cloud open the terminal');
    assert.deepEqual(log.finals, ['open the terminal'], 'loose match works while Claude is quiet');
    voice.speak('Cloud Run deployment finished. Hey cloud, the bucket is ready.');
    await tick();
    assert.equal(voice.isSpeaking(), true);
    rec.say('Cloud Run deployment finished');
    rec.say('hey cloud the bucket is ready');
    assert.deepEqual(log.finals, ['open the terminal'], 'echo of Claude is ignored');
    // The daemon is slower than the estimate: still speaking while the request is pending.
    c.advance(60000);
    assert.equal(voice.isSpeaking(), true);
    finishTts({ ok: true });
    await tick();
    assert.equal(voice.isSpeaking(), false);
    rec.say('hey cloud the bucket is ready');
    assert.deepEqual(log.finals, ['open the terminal'], 'and for a moment after');
    c.advance(800);
    rec.say('hey cloud list my buckets');
    assert.deepEqual(log.finals, ['open the terminal', 'list my buckets']);
    // The exact phrase barges in, stopping the speech.
    voice.speak('Here is a long answer.');
    await tick();
    rec.say('hey claude stop talking');
    assert.deepEqual(log.finals.at(-1), 'stop talking');
    assert.ok(log.calls.some(([, p]) => p === '/api/tts/stop'), 'speech was stopped');
    assert.equal(voice.isSpeaking(), false);
  } finally {
    c.restore();
    voice.cancel();
  }
});

test('hands-free without a wake word only lets "stop" through while Claude speaks', async () => {
  const api = (method, p) => (p === '/api/tts' ? new Promise(() => {}) : Promise.resolve({}));
  const { voice, log } = await makeVoice({ stt: 'browser', tts: 'server', wakeWord: '', handsFree: true }, { api });
  try {
    voice.start('handsfree');
    const rec = FakeSR.all[0];
    rec.onstart();
    voice.speak('Deploying now. Open the dashboard when it finishes.');
    await tick();
    rec.say('Open the dashboard when it finishes');
    assert.deepEqual(log.finals, []);
    rec.say('stop');
    assert.deepEqual(log.finals, ['stop']);
  } finally {
    voice.cancelSpeech();
    voice.cancel();
  }
});

// ------------------------------------------------------------------ push-to-talk restart gap (UI-VOICE-4)

test('push-to-talk released while the recognizer restarts still sends what was heard', async () => {
  const { voice, log } = await makeVoice({ stt: 'browser' });
  voice.start('ptt');
  const rec = FakeSR.all[0];
  rec.onstart();
  rec.say('open the browser');
  rec.end(); // Chrome's non-continuous recognizer ends while the key is still held
  voice.stop(); // released inside the restart gap
  assert.deepEqual(log.finals, ['open the browser']);
  assert.equal(voice.isActive(), false);
  assert.equal(voice.phase(), 'idle');
  await tick(80);
  assert.equal(FakeSR.all.length, 1, 'no restart after the release');
  // Voice works again right away.
  voice.start('toggle');
  assert.equal(voice.isActive(), true);
  voice.cancel();
});

test('hands-free stopped during the restart gap ends cleanly', async () => {
  const { voice, log } = await makeVoice({ stt: 'browser', wakeWord: 'hey claude', handsFree: true });
  voice.start('handsfree');
  const rec = FakeSR.all[0];
  rec.onstart();
  rec.end();
  voice.stop();
  assert.equal(voice.isActive(), false);
  await tick(300);
  assert.equal(FakeSR.all.length, 1);
  assert.deepEqual(log.finals, []);
});

// ------------------------------------------------------------------ server TTS timeout (UI-VOICE-5)

test('server TTS waits longer than the speech takes, and a client timeout is not an error', async () => {
  const api = (method, p) => (p === '/api/tts' ? Promise.reject(Object.assign(new Error('The request timed out.'), { status: 0, network: true, timeout: true })) : Promise.resolve({}));
  const { voice, log } = await makeVoice({ tts: 'server', ttsRate: 1 }, { api });
  const text = 'This sentence is part of a long answer that keeps going. '.repeat(12);
  await voice.speak(text);
  const call = log.calls.find(([, p]) => p === '/api/tts');
  const spoken = call[2].text.length;
  const estimate = ((spoken / 14) * 1000) / 1 + 2000;
  assert.ok(call[3].timeoutMs > estimate + 10000, `timeout ${call[3].timeoutMs} vs estimated ${Math.round(estimate)} ms`);
  assert.deepEqual(log.errors, [], 'no "Could not speak" warning');
});

test('server TTS failures other than timeouts are still reported', async () => {
  const api = (method, p) => (p === '/api/tts' ? Promise.reject(Object.assign(new Error('Speech failed: espeak-ng missing'), { status: 502 })) : Promise.resolve({}));
  const { voice, log } = await makeVoice({ tts: 'server' }, { api });
  await voice.speak('Done.');
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0].message, /Could not speak the answer/);
  assert.equal(voice.isSpeaking(), false);
});

// ------------------------------------------------------------------ server STT (UI-VOICE-13, UI-VOICE-14)

test('server push-to-talk sends quiet audio the VAD missed, and drops silence hallucinations', async () => {
  let reply = { text: 'open the browser' };
  const api = async (method, p) => (p.startsWith('/api/stt') ? reply : {});
  const { voice, log } = await makeVoice({ stt: 'server' }, { sr: false, api });
  voice.start('ptt');
  await tick();
  let rec = FakeRecorder.all[0];
  rec.hasSpeech = false;
  rec.size = 44 + 32000 * 0.5; // half a second
  voice.stop();
  await tick(10);
  assert.ok(log.calls.some(([, p]) => p.startsWith('/api/stt')), 'audio was sent');
  assert.deepEqual(log.finals, ['open the browser']);

  // Too short to be speech: not sent, and the user is told.
  voice.start('ptt');
  await tick();
  rec = FakeRecorder.all[1];
  rec.size = 44 + 32000 * 0.2;
  const sent = log.calls.length;
  voice.stop();
  await tick(10);
  assert.equal(log.calls.length, sent);
  assert.match(log.errors.at(-1).message, /didn't catch that/);

  // Whisper's "Thank you." for silence is not sent as a command.
  reply = { text: 'Thank you.' };
  voice.start('ptt');
  await tick();
  rec = FakeRecorder.all[2];
  rec.size = 44 + 32000;
  voice.stop();
  await tick(10);
  assert.deepEqual(log.finals, ['open the browser']);
  assert.match(log.errors.at(-1).message, /couldn't make out any words/);
});

test('hands-free server transcription retries after a transient error instead of stopping', async () => {
  let fails = 1;
  const api = async (method, p) => {
    if (!p.startsWith('/api/stt')) return {};
    if (fails > 0) {
      fails -= 1;
      throw Object.assign(new Error('Rate limited by the transcription provider'), { status: 429 });
    }
    return { text: 'open mail' };
  };
  const { voice, log } = await makeVoice({ stt: 'server', wakeWord: '', handsFree: true }, { sr: false, api });
  try {
    voice.start('handsfree');
    await tick();
    const first = FakeRecorder.all[0];
    first.hasSpeech = true;
    first.size = 44 + 32000;
    first.vad.onStop('silence');
    await tick(10);
    assert.equal(log.errors.length, 1);
    assert.equal(log.errors[0].level, 'warning');
    assert.match(log.errors[0].message, /Listening again in 1 s/);
    assert.equal(voice.isActive(), true, 'hands-free is still on');
    await tick(1100);
    assert.equal(FakeRecorder.all.length, 2, 'listening resumed');
    const second = FakeRecorder.all[1];
    second.hasSpeech = true;
    second.size = 44 + 32000;
    second.vad.onStop('silence');
    await tick(10);
    assert.deepEqual(log.finals, ['open mail']);
    assert.equal(voice.isActive(), true);
  } finally {
    voice.cancel();
  }
});

test('hands-free server transcription stops when transcription is not set up', async () => {
  const api = async (method, p) => {
    if (p.startsWith('/api/stt')) throw Object.assign(new Error('Server speech-to-text is not available'), { status: 503 });
    return {};
  };
  const { voice, log } = await makeVoice({ stt: 'server', wakeWord: '', handsFree: true }, { sr: false, api });
  voice.start('handsfree');
  await tick();
  const rec = FakeRecorder.all[0];
  rec.hasSpeech = true;
  rec.size = 44 + 32000;
  rec.vad.onStop('silence');
  await tick(10);
  assert.equal(voice.isActive(), false);
  assert.equal(log.errors[0].level, 'error');
});

// ------------------------------------------------------------------ auto STT choice (UI-VOICE-16)

test('auto speech input does not pick server transcription the daemon says it lacks', async () => {
  const missing = await makeVoice({ stt: 'auto' }, { sr: false, serverVoice: { serverStt: false, sttHint: 'Set GROQ_API_KEY or OPENAI_API_KEY.' } });
  assert.equal(missing.voice.provider().stt, 'none');
  missing.voice.start('toggle');
  assert.equal(missing.voice.isActive(), false, 'the microphone never opens');
  assert.match(missing.log.errors[0].message, /isn't available in this window/);
  // Before the daemon has checked (no hint yet), server transcription is still tried.
  const unknown = await makeVoice({ stt: 'auto' }, { sr: false, serverVoice: { serverStt: false } });
  assert.equal(unknown.voice.provider().stt, 'server');
  const ready = await makeVoice({ stt: 'auto' }, { sr: false, serverVoice: { serverStt: true, sttProvider: 'groq' } });
  assert.equal(ready.voice.provider().stt, 'server');
});
