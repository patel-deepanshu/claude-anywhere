'use strict';

/**
 * Voice enrollment end to end (docs/CALLS-DESIGN.md §2, §10.4–10.6): CloneService with a fake
 * sidecar (the B1 client contract), profile storage and deletion, the /api/clone/* routes on a
 * real DaemonServer, the `anywhere clone-voice` CLI without a daemon, the /anywhere:clone-voice
 * skill, and (when python3 exists) the real sidecar.py in its fake mode. No network, no audio
 * hardware.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-clone-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;
delete process.env.ANYWHERE_DAEMON_URL;
delete process.env.ANYWHERE_TOKEN;

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'anywhere.js');
const quality = require('../src/voice/clone/quality');
const profile = require('../src/voice/clone/profile');
const consentMod = require('../src/voice/clone/consent');
const script = require('../src/voice/clone/script');
const { CloneService, similarityLabel } = require('../src/voice/clone');
const { deepMerge } = require('../src/shared/util');

const POSIX = process.platform !== 'win32';
const RATE = 24000;
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ------------------------------------------------------------------ fixtures

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A speech-like 24 kHz take (about 60% voiced) as a WAV buffer. */
function take(seed, { seconds = 6, rate = RATE, noise = 0.0005, channels = 1 } = {}) {
  const r = rng(seed);
  const n = Math.round(rate * seconds);
  const s = new Float32Array(n);
  const f0 = 110 + (seed % 50);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const on = t > 0.4 && t < seconds - 0.4 && (t * 1000) % 500 < 380;
    let v = 0;
    if (on) for (let k = 1; k * f0 < 10000 && k * f0 < rate / 2; k += 1) v += (0.05 * Math.sin(2 * Math.PI * k * f0 * t)) / Math.sqrt(k);
    s[i] = v + noise * (r() - 0.5);
  }
  const wav = quality.writeWav(s, rate);
  if (channels === 1) return wav;
  wav.writeUInt16LE(channels, 22); // a lie about the layout is enough for the format check
  return wav;
}

const CONSENT_READ = (code = '4729') => `I, Dipancio Patel, agree that Claude anywhere may create a copy of my voice on this computer. My code is ${code}.`;

/** The B1 SidecarClient contract, faked: records every request. */
class FakeSidecar extends EventEmitter {
  constructor({ transcript = CONSENT_READ(), scores = {}, consentScore = 0.82, testScore = 0.61, fail = {} } = {}) {
    super();
    this.transcript = transcript;
    this.scores = scores;
    this.consentScore = consentScore;
    this.testScore = testScore;
    this.fail = fail;
    this.calls = [];
    this.running = true;
  }

  childPath(p) {
    return p;
  }

  async request(op, params = {}) {
    this.calls.push({ op, params });
    if (this.fail[op]) throw this.fail[op];
    switch (op) {
      case 'tts.load':
        return { loadMs: 1, sampleRate: RATE, engine: params.engine };
      case 'tts.setVoice':
        return { seconds: 11, engine: 'pocket' };
      case 'tts.synthesize': {
        const tone = new Float32Array(RATE);
        for (let i = 0; i < tone.length; i += 1) tone[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / RATE);
        fs.writeFileSync(params.out, quality.writeWav(tone, RATE));
        return { out: params.out, audioMs: 1000, firstChunkMs: 5, totalMs: 9, sampleRate: RATE };
      }
      case 'asr.load':
      case 'spk.load':
        return { loadMs: 1 };
      case 'asr.transcribe':
        return { text: typeof this.transcript === 'function' ? this.transcript(params.wav) : this.transcript };
      case 'spk.consistency': {
        const scores = params.wavs.map((w) => (this.scores[path.basename(w)] != null ? this.scores[path.basename(w)] : 0.9));
        const out = { centroid: 'c.json', scores };
        if (params.probe) out.probe = path.basename(params.probe) === 'consent.wav' ? this.consentScore : this.testScore;
        return out;
      }
      default:
        throw Object.assign(new Error(`unknown op ${op}`), { code: 'BAD_REQUEST' });
    }
  }

  async stop() {
    this.running = false;
    this.stopped = true;
    this.emit('exit', { code: 0 });
  }
}

class FakeInstaller {
  constructor({ installed = true, zipvoice = false } = {}) {
    this.installed = installed;
    this.zipvoice = zipvoice;
    this.installs = [];
  }

  async status() {
    return { installed: this.installed, engines: { pocket: this.installed, zipvoice: this.zipvoice }, missing: this.installed ? [] : ['pocket-int8'], bench: null };
  }

  async install({ engine, onProgress }) {
    this.installs.push(engine);
    onProgress({ stage: 'python', percent: 1, message: 'Finding Python' });
    onProgress({ stage: 'models', percent: 50, message: 'Downloading' });
    this.installed = true;
    if (engine === 'zipvoice') this.zipvoice = true;
    onProgress({ stage: 'done', percent: 100, message: 'Ready' });
    return { ok: true };
  }

  async bench() {
    return { engines: { pocket: { runs: [{ threads: 2, steps: 5, rtf: 0.5, firstChunkMs: 700 }] } } };
  }
}

let rootSeq = 0;
function makeService({ sidecar, installer, config: cfg, svc: extra } = {}) {
  rootSeq += 1;
  const voiceRoot = path.join(HOME, `voice-${rootSeq}`);
  const root = path.join(voiceRoot, 'clone');
  const config = deepMerge(
    { voice: { clone: { enabled: false, engine: 'pocket', threads: 2, steps: 0, provider: 'cpu' } }, calls: { ownerName: 'Deepanshu Patel', ownerPronoun: 'his', stt: { model: 'moonshine' } } },
    cfg || {},
  );
  const saved = [];
  const sc = new FakeSidecar(sidecar);
  let starts = 0;
  const svc = new CloneService({
    config,
    root,
    modelsRoot: path.join(voiceRoot, 'clone-models'),
    tmpDir: path.join(voiceRoot, 'tmp'),
    saveConfig: (p) => {
      saved.push(p);
      Object.assign(config, deepMerge(config, p));
    },
    sidecarFactory: async () => {
      starts += 1;
      sc.running = true;
      return sc;
    },
    installer: installer || new FakeInstaller(),
    randomInt: () => 4729,
    lookupJira: false,
    lookupOs: false,
    idleMs: 0,
    log: QUIET,
    ...(extra || {}),
  });
  return { svc, sc, root, config, saved, starts: () => starts };
}

async function enroll(svc, { label = 'MacBook Pro Microphone' } = {}) {
  const s = await svc.startSession({});
  const c = await svc.addTake(s.sessionId, 'consent', 0, take(1, { seconds: 8 }), { deviceLabel: label });
  assert.equal(c.ok, true, JSON.stringify(c));
  for (let i = 0; i < script.LINES.length; i += 1) {
    const r = await svc.addTake(s.sessionId, 'line', i, take(10 + i), { deviceLabel: label });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  return s;
}

function mode(p) {
  return (fs.statSync(p).mode & 0o777).toString(8);
}

async function rejects(promise, check) {
  try {
    await promise;
  } catch (err) {
    if (typeof check === 'function') check(err);
    else for (const [k, v] of Object.entries(check)) assert.equal(err[k], v, `${k}: ${err[k]} (${err.message})`);
    return err;
  }
  assert.fail('expected a rejection');
  return null;
}

// ------------------------------------------------------------------ CloneService

test('enrollment end to end: consent, 14 lines, build, private profile, test voice', async () => {
  const { svc, sc, root, config, saved } = makeService();
  const events = [];
  svc.on('session', (e) => events.push(e));
  const s = await enroll(svc);
  assert.equal(s.ownerName, 'Deepanshu Patel');
  assert.ok(s.consent.text.endsWith('My code is 4 7 2 9.'));
  assert.equal(s.lines.length, 14);
  const pub = svc.getSession(s.sessionId);
  assert.equal(pub.ready, true);
  assert.ok(pub.voicedS >= 45, `voiced ${pub.voicedS}`);

  const b = await svc.build(s.sessionId);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.engine, 'pocket');
  assert.equal(b.similarity, 0.61);
  assert.equal(b.label, 'Very close');
  assert.equal(b.testText, "Hi, this is Deepanshu's AI assistant, speaking in his voice.");
  assert.ok(b.referenceSeconds >= 10 && b.referenceSeconds <= 15, `${b.referenceSeconds} s`);
  assert.deepEqual(b.consistency, { min: 0.9, mean: 0.9, consent: 0.82 });

  // The profile: verified consent, the reference's sha256, 0700/0600, nothing else.
  const dir = path.join(root, 'profiles', 'default');
  const v = profile.verifyProfile('default', { root });
  assert.equal(v.ok, true, v.reason);
  const m = v.manifest;
  assert.equal(m.version, 1);
  assert.equal(m.ownerName, 'Deepanshu Patel');
  assert.equal(m.consent.verified, true);
  assert.equal(m.consent.deviceLabel, 'MacBook Pro Microphone');
  assert.equal(m.consent.codeHash, consentMod.codeHash(s.sessionId, '4729'));
  assert.equal(m.consent.transcript, CONSENT_READ());
  assert.match(m.consent.verifiedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(m.reference.sha256, profile.sha256File(path.join(dir, 'reference.wav')));
  assert.equal(m.reference.text, fs.readFileSync(path.join(dir, 'reference.txt'), 'utf8').trim());
  assert.equal(m.quality.takes.length, 14);
  assert.equal(m.test.similarity, 0.61);
  const ref = quality.readWav(fs.readFileSync(path.join(dir, 'reference.wav')));
  assert.deepEqual([ref.rate, ref.channels, ref.bits], [RATE, 1, 16]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['consent.wav', 'manifest.json', 'phrases', 'reference.txt', 'reference.wav'].filter((f) => f !== 'phrases' || fs.existsSync(path.join(dir, 'phrases'))));
  if (POSIX) {
    assert.equal(mode(dir), '700');
    for (const f of ['manifest.json', 'reference.wav', 'reference.txt', 'consent.wav']) assert.equal(mode(path.join(dir, f)), '600', f);
  }

  // The takes are gone; the voice is on; the test audio is served by id.
  assert.equal(fs.existsSync(path.join(root, 'sessions', s.sessionId)), false);
  assert.throws(() => svc.getSession(s.sessionId), (e) => e.code === 'NO_SESSION');
  assert.ok(saved.some((p) => p.voice && p.voice.clone && p.voice.clone.enabled === true));
  assert.equal(config.voice.clone.enabled, true);
  assert.ok(fs.existsSync(svc.audioFile(b.testAudioId)));
  assert.equal(svc.audioFile('0'.repeat(32)), null);
  assert.equal(svc.audioFile('../etc/passwd'), null);

  // Safeguard (a): the sidecar only ever got the profile folder to clone from.
  const setVoice = sc.calls.filter((c) => c.op === 'tts.setVoice');
  assert.ok(setVoice.length >= 1);
  for (const c of setVoice) assert.deepEqual(Object.keys(c.params), ['profileDir']), assert.equal(c.params.profileDir, dir);
  const firstSynth = sc.calls.findIndex((c) => c.op === 'tts.synthesize');
  assert.ok(firstSynth > sc.calls.findIndex((c) => c.op === 'tts.setVoice'));
  for (const c of sc.calls) for (const k of Object.keys(c.params)) assert.ok(!/^(reference|refAudio|referenceAudio|audio|promptWav)$/i.test(k), `${c.op} ${k}`);

  // The phrase cache is rendered in the background (fillers + test sentence).
  for (let i = 0; i < 100 && !events.some((e) => e.step === 'phrases'); i += 1) await new Promise((r) => setTimeout(r, 20));
  const phrases = fs.readdirSync(path.join(dir, 'phrases'));
  // The fillers, the test sentence and the caller-less greeting of src/calls/greeting.js (§2.6), each once.
  const texts = svc.phraseTexts();
  assert.equal(texts.length, script.FILLERS.length + 2);
  for (const f of script.FILLERS) assert.ok(texts.includes(f), f);
  assert.ok(texts.some((x) => /AI assistant/.test(x) && /transcribing this call/.test(x)), 'the greeting with its disclosure is pre-rendered');
  assert.equal(phrases.length, texts.length);
  for (const x of texts) assert.ok(fs.existsSync(profile.phrasePath('pocket', x, { root })), x);
  assert.ok(fs.existsSync(profile.phrasePath('pocket', 'Got it.', { root })));
  const cached = await svc.synthesize('Got it.');
  assert.equal(cached.cached, true);
  const live = await svc.synthesize('Something new to say.');
  assert.equal(live.cached, false);
  assert.ok(fs.existsSync(live.file));
  assert.deepEqual(
    events.filter((e) => e.sessionId === s.sessionId).map((e) => e.step).filter((x, i, a) => a.indexOf(x) === i),
    ['started', 'consent', 'take', 'building', 'built'],
  );
  for (const e of events) assert.ok(!JSON.stringify(e).includes('4729') && !JSON.stringify(e).includes('4 7 2 9'), 'events never carry the code');

  // test(): a sentence in the voice, scored against the reference clip.
  const t = await svc.test('Hello there.', { score: true });
  assert.equal(t.text, 'Hello there.');
  assert.equal(t.similarity, 0.61);
  const score = sc.calls.filter((c) => c.op === 'spk.consistency').pop();
  assert.deepEqual(score.params.wavs, [path.join(dir, 'reference.wav')]);
  await svc.shutdown();
});

test('takes: real microphones only, 24 kHz mono 16-bit, 2–30 s, at most 5 MB, consent first', async () => {
  const { svc } = makeService();
  const s = await svc.startSession({});
  const add = (kind, index, wav, label = 'Built-in Microphone') => svc.addTake(s.sessionId, kind, index, wav, { deviceLabel: label });
  await rejects(add('consent', 0, take(1), ''), { status: 400, code: 'DEVICE_LABEL' });
  await rejects(add('consent', 0, take(1), 'CABLE Output (VB-Audio Virtual Cable)'), { status: 403, code: 'VIRTUAL_DEVICE' });
  await rejects(add('consent', 0, take(1), 'Monitor of Built-in Audio'), { status: 403, code: 'VIRTUAL_DEVICE' });
  await rejects(add('consent', 0, take(1, { rate: 16000 })), { status: 415, code: 'WAV_FORMAT' });
  await rejects(add('consent', 0, take(1, { channels: 2 })), { status: 415, code: 'WAV_FORMAT' });
  await rejects(add('consent', 0, Buffer.from('RIFF....WAVEjunk')), { status: 400, code: 'BAD_WAV' });
  await rejects(add('consent', 0, Buffer.alloc(0)), { status: 400, code: 'BAD_WAV' });
  const short = await rejects(add('consent', 0, take(1, { seconds: 1.5 })), { status: 422, code: 'TAKE_LENGTH' });
  assert.equal(short.problems[0].code, 'too_short');
  await rejects(add('consent', 0, take(1, { seconds: 31 })), { status: 422, code: 'TAKE_LENGTH' });
  await rejects(add('consent', 0, Buffer.alloc(5 * 1024 * 1024 + 1)), { status: 413, code: 'TOO_LARGE' });
  await rejects(add('line', 0, take(2)), { status: 409, code: 'CONSENT_FIRST' });
  await rejects(add('bogus', 0, take(2)), { status: 400 });
  await rejects(svc.addTake('f'.repeat(32), 'consent', 0, take(1), { deviceLabel: 'Mic' }), { status: 404, code: 'NO_SESSION' });

  // A noisy take is checked at once and not kept.
  const noisy = await add('consent', 0, take(3, { noise: 0.2 }));
  assert.equal(noisy.ok, false);
  assert.ok(noisy.problems.some((p) => p.code === 'noisy' && p.level === 'fail'));
  assert.equal(noisy.transcript, undefined, 'a take that fails the audio checks is not transcribed');

  assert.equal((await add('consent', 0, take(4, { seconds: 8 }))).ok, true);
  await rejects(add('consent', 0, take(4, { seconds: 8 })), { status: 409, code: 'CONSENT_USED' });
  await rejects(add('line', 14, take(5)), { status: 400 });
  await rejects(add('line', -1, take(5)), { status: 400 });
  const ok = await add('line', 3, take(5));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.progress, { done: 1, total: 14 });
  await rejects(svc.build(s.sessionId), (e) => {
    assert.equal(e.code, 'TAKES_MISSING');
    assert.equal(e.missing.length, 13);
  });
  await svc.shutdown();
});

test('consent: a wrong code or paraphrase fails (file dropped); a fresh code after 3 tries or expiry', async () => {
  let now = 1000000;
  const codes = [4729, 1234, 5678];
  const reads = [];
  const { svc, root } = makeService({
    sidecar: { transcript: () => reads.shift() },
    svc: { clock: () => now, randomInt: () => codes.shift() },
  });
  const s = await svc.startSession({});
  const add = () => svc.addTake(s.sessionId, 'consent', 0, take(7, { seconds: 8 }), { deviceLabel: 'Mic' });
  reads.push(CONSENT_READ('4719'));
  const wrong = await add();
  assert.equal(wrong.ok, false);
  assert.deepEqual(wrong.consent.reasons, ['code']);
  assert.match(wrong.consent.hints[0], /code was not heard/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'sessions', s.sessionId)), [], 'a refused reading is not kept');
  reads.push('I am Dipanchu and I agree to Claude anywhere copying my voice on this computer code 4729');
  assert.deepEqual((await add()).consent.reasons, ['wording']);
  reads.push('');
  const third = await add();
  assert.deepEqual(third.consent.reasons, ['empty']);
  assert.ok(third.consent.renewed.text.endsWith('My code is 1 2 3 4.'));
  assert.ok(svc.getSession(s.sessionId).consent.text.endsWith('1 2 3 4.'));
  // Ten minutes later the code has expired: refused, and a new one is shown.
  now += 10 * 60 * 1000;
  reads.push(CONSENT_READ('1234'));
  const late = await add();
  assert.deepEqual(late.consent.reasons, ['expired']);
  assert.ok(late.consent.renewed.text.endsWith('5 6 7 8.'));
  reads.push(CONSENT_READ('5678'));
  assert.equal((await add()).ok, true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'sessions', s.sessionId)), ['consent.wav']);
  assert.throws(() => svc.renewConsent(s.sessionId), (e) => e.code === 'CONSENT_USED');
  await svc.shutdown();
});

test('build: inconsistent takes are re-recorded; a different consent speaker stops the enrollment', async () => {
  const { svc, root } = makeService({ sidecar: { scores: { 'line-03.wav': 0.3, 'line-09.wav': 0.2 } } });
  const s = await enroll(svc);
  const r = await svc.build(s.sessionId);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TAKES_INCONSISTENT');
  assert.deepEqual(r.retake, [2, 8]);
  const pub = svc.getSession(s.sessionId);
  assert.equal(pub.state, 'recording');
  assert.equal(pub.takes[2].ok, false);
  assert.equal(pub.ready, false);
  assert.equal(fs.existsSync(path.join(root, 'profiles', 'default')), false);

  const other = makeService({ sidecar: { consentScore: 0.2 } });
  const s2 = await enroll(other.svc);
  const r2 = await other.svc.build(s2.sessionId);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'CONSENT_SPEAKER_MISMATCH');
  assert.match(r2.message, /same person/);
  assert.throws(() => other.svc.getSession(s2.sessionId), (e) => e.code === 'NO_SESSION');
  assert.equal(fs.existsSync(path.join(other.root, 'sessions', s2.sessionId)), false);
  assert.equal(profile.verifyProfile('default', { root: other.root }).exists, false);
  await svc.shutdown();
  await other.svc.shutdown();
});

test('a profile that was tampered with, or lacks verified consent, is refused', async () => {
  const { svc, root } = makeService();
  const s = await enroll(svc);
  assert.equal((await svc.build(s.sessionId)).ok, true);
  const dir = path.join(root, 'profiles', 'default');
  const refFile = path.join(dir, 'reference.wav');
  const good = fs.readFileSync(refFile);
  const bad = Buffer.from(good);
  bad[bad.length - 1] ^= 0xff;
  fs.writeFileSync(refFile, bad);
  const v = profile.verifyProfile('default', { root });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'PROFILE_INVALID');
  assert.match(v.reason, /changed after enrollment/);
  await rejects(svc.test('Hi'), { status: 409, code: 'PROFILE_INVALID' });
  fs.writeFileSync(refFile, good);
  const m = profile.readManifest('default', { root });
  profile.writeManifest('default', { ...m, consent: { ...m.consent, verified: false } }, { root });
  assert.match(profile.verifyProfile('default', { root }).reason, /Consent was not verified/);
  assert.equal((await svc.status({ light: true })).profile.ok, false);
  assert.throws(() => profile.profileDir('../x', { root }), (e) => e.code === 'BAD_REQUEST');
  await svc.shutdown();
});

test('delete removes the profile, sessions, phrases and test audio, and turns the voice off', async () => {
  const { svc, sc, root, config } = makeService();
  const s = await enroll(svc);
  const b = await svc.build(s.sessionId);
  const testFile = svc.audioFile(b.testAudioId);
  const pending = await svc.startSession({});
  const deleted = [];
  svc.on('deleted', (e) => deleted.push(e));
  const r = await svc.delete();
  assert.deepEqual(r, { ok: true, removed: true });
  assert.equal(fs.existsSync(path.join(root, 'profiles')), false);
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false);
  assert.equal(fs.existsSync(testFile), false);
  assert.equal(svc.audioFile(b.testAudioId), null);
  assert.throws(() => svc.getSession(pending.sessionId), (e) => e.code === 'NO_SESSION');
  assert.equal(config.voice.clone.enabled, false);
  assert.equal(sc.stopped, true, 'the sidecar forgets the voice');
  assert.equal(deleted.length, 1);
  assert.equal((await svc.delete()).removed, false);
  assert.equal((await svc.status({ light: true })).profile.exists, false);
  await svc.shutdown();
});

test('owner name: typed, then settings, then lookups; none → OWNER_NAME; typed is saved when unset', async () => {
  const a = makeService({ config: { calls: { ownerName: '' } } });
  await rejects(a.svc.startSession({}), { status: 400, code: 'OWNER_NAME' });
  const s = await a.svc.startSession({ ownerName: '  Priya   Sharma ' });
  assert.equal(s.ownerName, 'Priya Sharma');
  assert.ok(a.saved.some((p) => p.calls && p.calls.ownerName === 'Priya Sharma'));
  const b = makeService({ config: { calls: { ownerName: '' } }, svc: { ownerNameLookup: async () => 'Jira Person' } });
  assert.deepEqual(await b.svc.resolveOwnerName(), { name: 'Jira Person', source: 'lookup' });
  const c = makeService();
  assert.deepEqual(await c.svc.resolveOwnerName({ explicit: 'Typed Name' }), { name: 'Typed Name', source: 'typed' });
  assert.deepEqual(await c.svc.resolveOwnerName(), { name: 'Deepanshu Patel', source: 'settings' });
});

test('runtime missing: status says so, the consent take answers 503 with the install hint', async () => {
  const notInstalled = Object.assign(new Error('The cloned-voice runtime is not installed'), { code: 'NOT_INSTALLED' });
  const { svc } = makeService({
    installer: new FakeInstaller({ installed: false }),
    svc: {
      sidecarFactory: async () => {
        throw notInstalled;
      },
    },
  });
  const st = await svc.status();
  assert.equal(st.installed, false);
  assert.equal(st.engines.pocket, false);
  const s = await svc.startSession({});
  const err = await rejects(svc.addTake(s.sessionId, 'consent', 0, take(1, { seconds: 8 }), { deviceLabel: 'Mic' }), { status: 503, code: 'NOT_INSTALLED' });
  assert.match(err.hint, /clone-voice install/);
  assert.deepEqual(fs.readdirSync(path.join(svc.cloneRoot(), 'sessions', s.sessionId)), []);
});

test('one consent reading at a time; a new session waits for a build in progress', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { svc } = makeService({ sidecar: { transcript: () => CONSENT_READ() } });
  const sc = await svc.getSidecar();
  const original = sc.request.bind(sc);
  sc.request = async (op, params) => {
    if (op === 'asr.transcribe') await gate;
    return original(op, params);
  };
  const s = await svc.startSession({});
  const first = svc.addTake(s.sessionId, 'consent', 0, take(1, { seconds: 8 }), { deviceLabel: 'Mic' });
  await new Promise((r) => setTimeout(r, 20));
  await rejects(svc.addTake(s.sessionId, 'consent', 0, take(2, { seconds: 8 }), { deviceLabel: 'Mic' }), { status: 409, code: 'BUSY' });
  release();
  assert.equal((await first).ok, true);
  for (let i = 0; i < 14; i += 1) await svc.addTake(s.sessionId, 'line', i, take(90 + i), { deviceLabel: 'Mic' });
  const building = svc.build(s.sessionId);
  await rejects(svc.startSession({}), { status: 409, code: 'BUSY' });
  await rejects(svc.addTake(s.sessionId, 'line', 0, take(5), { deviceLabel: 'Mic' }), { status: 409, code: 'BUSY' });
  assert.equal((await building).ok, true);
  await svc.shutdown();
});

test('install: progress events, one at a time; then the engine choice', async () => {
  const inst = new FakeInstaller({ installed: false });
  const { svc, config } = makeService({ installer: inst });
  const seen = [];
  svc.on('install', (p) => seen.push(p.stage));
  const [a, b] = [svc.install({}), svc.install({})];
  assert.equal(a, b, 'a second install joins the first');
  await a;
  assert.deepEqual(inst.installs, ['pocket']);
  assert.deepEqual(seen, ['python', 'python', 'models', 'done']);
  assert.equal(svc.installProgress(), null);
  assert.equal((await svc.status({ light: true })).lastInstall.stage, 'done');
  await rejects(svc.setEngine('zipvoice'), { status: 409, code: 'NOT_INSTALLED' });
  await svc.install({ engine: 'zipvoice' });
  assert.deepEqual(await svc.setEngine('zipvoice'), { ok: true, engine: 'zipvoice' });
  assert.equal(config.voice.clone.engine, 'zipvoice');
  await rejects(svc.setEngine('xtts'), { status: 400 });
  assert.equal(similarityLabel(0.55), 'Very close');
  assert.equal(similarityLabel(0.4), 'Close');
  assert.equal(similarityLabel(0.39), 'Recognizable, not exact');
  assert.equal(similarityLabel(null), null);
});

test('open requests: a sequence the dialog acknowledges', async () => {
  const { svc } = makeService();
  const seen = [];
  svc.on('session', (e) => seen.push(e));
  assert.equal(svc.requestOpen(), 1);
  assert.equal(svc.requestOpen(), 2);
  assert.equal(svc.ackOpen(5), 0, 'an unknown request is not acknowledged');
  assert.equal(svc.ackOpen(2), 2);
  assert.equal(svc.ackOpen(1), 2);
  const st = await svc.status({ light: true });
  assert.equal(st.openSeq, 2);
  assert.equal(st.openAck, 2);
  assert.ok(st.openAgeMs >= 0);
  assert.deepEqual(seen.map((e) => [e.step, e.seq]), [['open', 1], ['open', 2]]);
});

test('lockDown: chmod on POSIX, icacls (best effort) on Windows; sessions older than 24 h are removed', async () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'lock-'));
  fs.writeFileSync(path.join(dir, 'a.wav'), 'x', { mode: 0o644 });
  if (POSIX) {
    assert.equal(await profile.lockDown(dir), true);
    assert.equal(mode(dir), '700');
    assert.equal(mode(path.join(dir, 'a.wav')), '600');
  }
  const calls = [];
  const ok = await profile.lockDown(dir, { platform: 'win32', username: 'deep', runner: async (cmd, args) => (calls.push([cmd, ...args]), { code: 0 }) });
  assert.equal(ok, true);
  assert.deepEqual(calls[0].slice(0, 5), ['icacls', dir, '/inheritance:r', '/grant:r', 'deep:(OI)(CI)F']);
  assert.equal(await profile.lockDown(path.join(dir, 'missing')), false);

  const root = path.join(HOME, 'cleanup', 'clone');
  const old = path.join(profile.sessionsRoot(root), 'a'.repeat(32));
  const fresh = path.join(profile.sessionsRoot(root), 'b'.repeat(32));
  fs.mkdirSync(old);
  fs.mkdirSync(fresh);
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(old, past, past);
  assert.deepEqual(profile.cleanupSessions({ root }), ['a'.repeat(32)]);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(profile.phraseKey('pocket', 'Sure.'), require('crypto').createHash('sha1').update('pocket|Sure.').digest('hex'));
});

// ------------------------------------------------------------------ HTTP routes

const TOKEN = 'clone-test-token-1234567890';

async function startServer({ svcOpts, calls } = {}) {
  const { createServer } = require('../src/daemon/server');
  const { Hub } = require('../src/daemon/hub');
  const hub = new Hub();
  const made = makeService(svcOpts);
  const config = made.config;
  const server = createServer({ hub, session: null, config, token: TOKEN, instanceId: 'i', version: '0', env: {}, cloneFactory: () => made.svc, calls });
  const port = await server.listen(0);
  const events = [];
  hub.on('event', (type, data) => events.push({ type, data }));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body, headers = {}) => {
    const h = { Authorization: `Bearer ${TOKEN}`, ...headers };
    let payload;
    if (Buffer.isBuffer(body)) payload = body;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    const res = await fetch(base + p, { method, headers: h, body: payload });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      json = null;
    }
    return { status: res.status, json, buf, type: res.headers.get('content-type') };
  };
  return {
    ...made,
    server,
    hub,
    events,
    api,
    async close() {
      hub.close();
      await server.close();
      await made.svc.shutdown();
    },
  };
}

test('routes: the whole enrollment over HTTP, with SSE events and the audio route', async () => {
  const disarmed = [];
  const t = await startServer({ calls: { disarm: (why) => disarmed.push(why) } });
  const { api } = t;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${t.server.port}/api/clone/status`)).status, 401);
    const st = await api('GET', '/api/clone/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.installed, true);
    assert.equal(st.json.profile.exists, false);
    assert.deepEqual(st.json.owner, { name: 'Deepanshu Patel', source: 'settings' });

    const s = await api('POST', '/api/clone/session', { ownerName: 'Deepanshu Patel' });
    assert.equal(s.status, 200);
    const id = s.json.sessionId;
    assert.match(id, /^[a-f0-9]{32}$/);
    const wavHeaders = (label) => ({ 'Content-Type': 'audio/wav', 'X-Anywhere-Device-Label': encodeURIComponent(label) });
    // Non-ASCII labels arrive URI-encoded; virtual devices are refused again by the daemon.
    const v = await api('POST', `/api/clone/take?session=${id}&kind=consent`, take(1, { seconds: 8 }), wavHeaders('BlackHole 2ch'));
    assert.equal(v.status, 403);
    assert.equal(v.json.code, 'VIRTUAL_DEVICE');
    assert.equal((await api('POST', `/api/clone/take?session=${id}&kind=consent`, take(1, { seconds: 8 }), { 'Content-Type': 'text/plain', 'X-Anywhere-Device-Label': 'Mic' })).status, 415);
    assert.equal((await api('POST', `/api/clone/take?session=nope&kind=consent`, take(1), wavHeaders('Mic'))).status, 400);
    const big = await api('POST', `/api/clone/take?session=${id}&kind=consent`, Buffer.alloc(5 * 1024 * 1024 + 10), wavHeaders('Mic'));
    assert.equal(big.status, 413);
    const short = await api('POST', `/api/clone/take?session=${id}&kind=consent`, take(1, { seconds: 1 }), wavHeaders('Mic'));
    assert.equal(short.status, 422);
    assert.equal(short.json.problems[0].code, 'too_short');
    const c = await api('POST', `/api/clone/take?session=${id}&kind=consent`, take(1, { seconds: 8 }), wavHeaders('Mikrofon (Realtek® Audio)'));
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.ok, true);
    assert.equal(c.json.consent.ok, true);
    for (let i = 0; i < 14; i += 1) {
      const r = await api('POST', `/api/clone/take?session=${id}&kind=line&index=${i}`, take(20 + i), wavHeaders('Mikrofon (Realtek® Audio)'));
      assert.equal(r.json.ok, true, JSON.stringify(r.json));
    }
    const sess = await api('GET', `/api/clone/session?session=${id}`);
    assert.equal(sess.json.ready, true);
    const b = await api('POST', `/api/clone/build?session=${id}`);
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(b.json.ok, true);
    const m = profile.readManifest('default', { root: t.root });
    assert.equal(m.consent.deviceLabel, 'Mikrofon (Realtek® Audio)');

    const audio = await api('GET', `/api/clone/audio?id=${b.json.testAudioId}`);
    assert.equal(audio.status, 200);
    assert.equal(audio.type, 'audio/wav');
    assert.equal(audio.buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal((await api('GET', '/api/clone/audio?id=../../x')).status, 400);
    assert.equal((await api('GET', `/api/clone/audio?id=${'a'.repeat(32)}`)).status, 404);

    const test2 = await api('POST', '/api/clone/test', { text: 'Testing one two three', score: true });
    assert.equal(test2.json.ok, true);
    assert.equal(test2.json.text, 'Testing one two three');
    assert.equal((await api('POST', '/api/clone/test', { engine: 'xtts' })).status, 400);

    const sessionEvents = t.events.filter((e) => e.type === 'clone_session').map((e) => e.data.step);
    assert.ok(sessionEvents.includes('started') && sessionEvents.includes('built'), sessionEvents.join());
    assert.ok(!JSON.stringify(t.events).includes('4 7 2 9'), 'SSE never carries the consent code');

    assert.equal((await api('POST', '/api/clone/delete', {})).status, 400);
    const del = await api('POST', '/api/clone/delete', { confirm: 'delete' });
    assert.deepEqual(del.json, { ok: true, removed: true });
    assert.ok(disarmed.length >= 1, 'deleting the voice disarms calls');
    assert.equal(profile.verifyProfile('default', { root: t.root }).exists, false);
  } finally {
    await t.close();
  }
});

test('routes: install progress over SSE, open/opened, the standalone page link, failed builds as 422', async () => {
  const t = await startServer({ svcOpts: { installer: new FakeInstaller({ installed: false }), sidecar: { scores: { 'line-01.wav': 0.1 } } } });
  const { api } = t;
  try {
    const inst = await api('POST', '/api/clone/install', {});
    assert.deepEqual(inst.json, { ok: true, started: true });
    for (let i = 0; i < 50 && !t.events.some((e) => e.type === 'clone_install' && e.data.stage === 'done'); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      t.events.filter((e) => e.type === 'clone_install').map((e) => e.data.stage),
      ['python', 'python', 'models', 'done'],
    );
    assert.equal((await api('POST', '/api/clone/install', { engine: 'xtts' })).status, 400);

    const open = await api('POST', '/api/clone/open', {});
    assert.equal(open.json.ok, true);
    assert.equal(open.json.seq, 1);
    assert.ok(t.events.some((e) => e.type === 'clone_session' && e.data.step === 'open' && e.data.seq === 1));
    assert.ok(t.events.some((e) => e.type === 'show'), 'the dialog is brought forward');
    assert.equal((await api('GET', '/api/clone/status?light=1')).json.openAck, 0);
    await api('POST', '/api/clone/opened', { seq: 1 });
    assert.equal((await api('GET', '/api/clone/status?light=1')).json.openAck, 1);
    const sa = await api('POST', '/api/clone/standalone', {});
    const u = new URL(sa.json.url);
    assert.equal(u.pathname, '/clone.html');
    assert.equal(u.hostname, '127.0.0.1');
    const code = u.searchParams.get('launch');
    assert.ok(code && !sa.json.url.includes(TOKEN));
    const traded = await fetch(`http://127.0.0.1:${t.server.port}/api/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal((await traded.json()).token, TOKEN);
    const page = await fetch(`http://127.0.0.1:${t.server.port}/clone.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<script type="module" src="clone.js">/);

    const s = await api('POST', '/api/clone/session', {});
    const id = s.json.sessionId;
    const h = { 'Content-Type': 'audio/wav', 'X-Anywhere-Device-Label': 'Mic' };
    await api('POST', `/api/clone/take?session=${id}&kind=consent`, take(1, { seconds: 8 }), h);
    for (let i = 0; i < 14; i += 1) await api('POST', `/api/clone/take?session=${id}&kind=line&index=${i}`, take(40 + i), h);
    const b = await api('POST', `/api/clone/build?session=${id}`);
    assert.equal(b.status, 422);
    assert.equal(b.json.code, 'TAKES_INCONSISTENT');
    assert.deepEqual(b.json.retake, [0]);
    const renew = await api('POST', `/api/clone/session/renew?session=${id}`);
    assert.equal(renew.status, 409, 'the consent already passed');
    assert.deepEqual((await api('POST', `/api/clone/session/cancel?session=${id}`)).json, { ok: true, cancelled: true });
    assert.equal((await api('GET', `/api/clone/session?session=${id}`)).status, 404);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------------ CLI and skill

function childEnv(extra = {}) {
  const env = { ...process.env, ANYWHERE_HOME: fs.mkdtempSync(path.join(HOME, 'cli-')), NO_COLOR: '1' };
  delete env.ANYWHERE_DAEMON_URL;
  delete env.ANYWHERE_TOKEN;
  delete env.FORCE_COLOR;
  return { ...env, ...extra };
}

function run(cmd, args, { env, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out: ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('CLI: clone-voice status, delete and usage errors work without the daemon', async () => {
  const env = childEnv();
  const st = await run(process.execPath, [BIN, 'clone-voice', 'status', '--json'], { env });
  assert.equal(st.code, 0, st.stderr);
  const json = JSON.parse(st.stdout);
  assert.equal(json.source, 'local');
  assert.equal(json.profile.exists, false);
  assert.equal(json.enabled, false);
  const human = await run(process.execPath, [BIN, 'clone-voice', 'status'], { env });
  assert.match(human.stdout, /Voice profile\s+none yet/);
  const del = await run(process.execPath, [BIN, 'clone-voice', 'delete', '--json'], { env });
  assert.equal(del.code, 0, del.stderr);
  assert.deepEqual(JSON.parse(del.stdout), { ok: true, removed: false });
  const bad = await run(process.execPath, [BIN, 'clone-voice', 'frobnicate'], { env });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown clone-voice command "frobnicate"/);
  const eng = await run(process.execPath, [BIN, 'clone-voice', 'install', '--engine', 'xtts'], { env });
  assert.equal(eng.code, 1);
  assert.match(eng.stderr, /--engine must be pocket or zipvoice/);
  const help = await run(process.execPath, [BIN, 'help', 'clone-voice'], { env });
  assert.match(help.stdout, /anywhere clone-voice \[start \| install \| status \| test \[TEXT\] \| bench \| delete\]/);
});

test('skill: /anywhere:clone-voice follows §10.6 and its launcher forwards the exit code', async () => {
  const md = fs.readFileSync(path.join(ROOT, 'skills', 'clone-voice', 'SKILL.md'), 'utf8');
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'front matter');
  const fields = Object.fromEntries(
    fm[1].split('\n').map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i), l.slice(i + 1).trim()];
    }),
  );
  assert.equal(fields.name, 'clone-voice');
  assert.match(fields.description, /consent-gated, stays on this computer/);
  assert.equal(fields['argument-hint'], '"[status | test | delete]"');
  assert.equal(fields['allowed-tools'], 'Bash(node "${CLAUDE_SKILL_DIR}/run.js"*)');
  assert.equal(fields['disable-model-invocation'], 'true');
  assert.match(md, /node "\$\{CLAUDE_SKILL_DIR\}\/run\.js" clone-voice \$ARGUMENTS/);
  assert.match(md, /\/anywhere:clone-voice delete/);
  const env = childEnv();
  const ok = await run(process.execPath, [path.join(ROOT, 'skills', 'clone-voice', 'run.js'), 'clone-voice', 'status', '--json'], { env });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).profile.exists, false);
  const bad = await run(process.execPath, [path.join(ROOT, 'skills', 'clone-voice', 'run.js'), 'clone-voice', 'frobnicate'], { env });
  assert.equal(bad.code, 1);
});

// ------------------------------------------------------------------ the real sidecar (fake mode)

const PYTHON = (() => {
  for (const cmd of ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && String(r.stdout).trim() === '3') return cmd;
  }
  return null;
})();
const SIDECAR = path.join(ROOT, 'src', 'voice', 'clone', 'sidecar.py');

test('with the real sidecar.py (fake mode): consent STT, speaker check, profile accepted by tts.setVoice', { skip: !PYTHON || !fs.existsSync(SIDECAR) ? 'needs python3 and sidecar.py' : false }, async () => {
  const { SidecarClient } = require('../src/voice/clone/client');
  const models = require('../src/voice/clone/models');
  const paths = require('../src/shared/paths');
  const state = paths.stateDir();
  const root = paths.cloneDir();
  const modelsRoot = path.join(paths.voiceDir(), 'clone-models');
  for (const id of models.requiredAssets({})) {
    for (const [role, f] of Object.entries(models.assetPaths(id, modelsRoot).files)) {
      if (role === 'data_dir') fs.mkdirSync(f, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, 'placeholder');
      }
    }
  }
  const config = { voice: { clone: { engine: 'pocket', threads: 1 } }, calls: { ownerName: 'Deepanshu Patel', ownerPronoun: 'his', stt: { model: 'moonshine' } } };
  let client = null;
  const svc = new CloneService({
    config,
    saveConfig: (p) => Object.assign(config, deepMerge(config, p)),
    installer: new FakeInstaller(),
    modelsRoot,
    randomInt: () => 4729,
    lookupJira: false,
    lookupOs: false,
    idleMs: 0,
    log: QUIET,
    sidecarFactory: async () => {
      client = new SidecarClient({ python: PYTHON, script: SIDECAR, args: ['--state', state, '--models', modelsRoot], env: { ...process.env, ANYWHERE_CLONE_FAKE: '1' } });
      await client.start();
      return client;
    },
  });
  try {
    const s = await svc.startSession({});
    const sdir = path.join(root, 'sessions', s.sessionId);
    // Fake STT reads <wav>.txt; fake embeddings use the take's folder (one speaker per session).
    fs.writeFileSync(path.join(sdir, 'consent-1.wav.txt'), CONSENT_READ());
    const c = await svc.addTake(s.sessionId, 'consent', 0, take(1, { seconds: 8 }), { deviceLabel: 'Built-in Microphone' });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(c.transcript, CONSENT_READ());
    for (let i = 0; i < 14; i += 1) assert.equal((await svc.addTake(s.sessionId, 'line', i, take(60 + i), { deviceLabel: 'Built-in Microphone' })).ok, true);
    const b = await svc.build(s.sessionId);
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.ok(b.consistency.min > 0.9, JSON.stringify(b.consistency));
    assert.ok(b.testAudioId, b.testError || 'the sidecar accepted the profile and rendered the test');
    assert.equal(quality.readWav(fs.readFileSync(svc.audioFile(b.testAudioId))).rate, RATE);
    // A profile changed after enrollment is refused by the sidecar itself.
    const ref = path.join(root, 'profiles', 'default', 'reference.wav');
    const buf = fs.readFileSync(ref);
    buf[buf.length - 2] ^= 0x7f;
    fs.writeFileSync(ref, buf, { mode: 0o600 });
    await rejects(client.request('tts.setVoice', { profileDir: path.join(root, 'profiles', 'default') }), { code: 'PROFILE_INVALID' });
    // And a folder outside profiles/ is never accepted as a voice.
    await rejects(client.request('tts.setVoice', { profileDir: sdir }), (e) => assert.ok(['PROFILE_INVALID', 'BAD_REQUEST'].includes(e.code), e.code));
    await svc.delete();
  } finally {
    await svc.shutdown();
  }
});

// ------------------------------------------------------------------ the enrollment view in Chromium

function findChrome() {
  if (process.env.ANYWHERE_TEST_CHROME) return fs.existsSync(process.env.ANYWHERE_TEST_CHROME) ? process.env.ANYWHERE_TEST_CHROME : null;
  const candidates = [];
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) candidates.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'));
  } catch {
    /* not a Playwright image */
  }
  if (process.platform === 'linux') {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
      const r = spawnSync('which', [name], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) candidates.push(r.stdout.trim());
    }
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

const CHROME = findChrome();

test(
  'the enrollment view in Chromium with a fake microphone: consent code shown only while recording, takes uploaded, build, delete card',
  { skip: !CHROME ? 'no Chromium found (set ANYWHERE_TEST_CHROME)' : typeof globalThis.WebSocket !== 'function' ? 'needs a global WebSocket (Node >= 22)' : false, timeout: 180000 },
  async () => {
    const { launchChrome } = require('./fixtures/chrome-launch');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // The fake microphone loops a speech-like recording (48 kHz, like a real device).
    const micFile = path.join(HOME, 'fake-mic.wav');
    fs.writeFileSync(micFile, take(5, { seconds: 8, rate: 48000 }));
    const t = await startServer({ svcOpts: { sidecar: { transcript: CONSENT_READ() } } });
    const { port: dport, cleanup } = await launchChrome(CHROME, {
      prefix: 'anywhere-chrome-clone-',
      extraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}`, '--autoplay-policy=no-user-gesture-required'],
    });
    const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
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
      if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const i = (id += 1);
        pending.set(i, resolve);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
      return r.result.result.value;
    };
    const text = () => ev('document.body ? document.body.innerText : ""');
    const waitFor = async (expr, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await ev(`(() => { try { return Boolean(${expr}); } catch (e) { return false; } })()`)) return;
        await sleep(100);
      }
      assert.fail(`timed out waiting for ${expr}\n--- page ---\n${await text()}\n--- exceptions ---\n${problems.join('\n')}`);
    };
    const click = async (label) => {
      const ok = await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
      assert.ok(ok, `no enabled button "${label}"\n${await text()}`);
    };
    const record = async (ms) => {
      await click('Record');
      await waitFor(`document.querySelector('.ca-recording')`);
      await sleep(ms);
      await click('Stop');
    };
    try {
      await send('Runtime.enable');
      await send('Page.enable');
      await send('Emulation.setDeviceMetricsOverride', { width: 440, height: 720, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: `http://127.0.0.1:${t.server.port}/clone.html?token=${TOKEN}` });
      await waitFor(`document.body.innerText.includes('I am the person whose voice will be recorded')`);
      assert.equal(await ev('location.search'), '', 'the token is taken out of the address bar');
      // Continue needs the "I am the person" checkbox.
      assert.equal(await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Continue').disabled`), true);
      await ev(`document.getElementById('ca-agree').click()`);
      await click('Continue');
      await waitFor(`document.querySelector('#ca-device') && document.querySelector('#ca-device').value !== ''`);
      await click('Measure room noise');
      await waitFor(`/Quiet room|A little noisy/.test(document.body.innerText)`, 10000);
      await click('Continue');
      await waitFor(`document.querySelector('.ca-consent')`);
      assert.match(await ev(`document.querySelector('.ca-consent').textContent`), /My code is • • • •\.$/, 'the code is hidden before recording');
      await click('Record');
      await waitFor(`document.querySelector('.ca-recording')`);
      assert.match(await ev(`document.querySelector('.ca-consent').textContent`), /My code is 4 7 2 9\.$/, 'and shown while recording');
      await sleep(6500);
      await click('Stop');
      await waitFor(`document.body.innerText.includes('Consent recorded')`);
      await click('Next');
      await waitFor(`document.body.innerText.includes('Line 1:')`);
      await record(4500);
      await waitFor(`document.body.innerText.includes('Line 1 saved')`);
      // Lines 2–13 over HTTP; line 14 in the view.
      const sessionId = (await t.svc.status({ light: true })).session.sessionId;
      for (let i = 1; i < 13; i += 1) assert.equal((await t.svc.addTake(sessionId, 'line', i, take(70 + i), { deviceLabel: 'Fake Default Audio Input' })).ok, true);
      await ev(`document.querySelectorAll('.ca-line-btn')[13].click()`);
      await waitFor(`document.body.innerText.includes('Line 14:')`);
      await record(4500);
      await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Build my voice' && !b.disabled)`);
      await click('Build my voice');
      await waitFor(`document.body.innerText.includes('Your voice is built')`, 30000);
      assert.match(await text(), /Very close · match 0\.61/);
      const m = profile.readManifest('default', { root: t.root });
      assert.equal(m.consent.verified, true);
      assert.ok(m.consent.deviceLabel && !quality.isVirtualDeviceLabel(m.consent.deviceLabel), m.consent.deviceLabel);
      await click('Keep');
      await waitFor(`document.body.innerText.includes('Your cloned voice is ready')`);

      // Inside the dialog: mount(), then `anywhere clone-voice` asks for the view (poll + ack).
      await send('Page.navigate', { url: `http://127.0.0.1:${t.server.port}/index.html?token=${TOKEN}` });
      await waitFor(`document.readyState === 'complete'`);
      await ev(`import('/clone.js').then((m) => { window.__clone = m.mount(); return true; })`);
      const seq = t.svc.requestOpen();
      await waitFor(`document.querySelector('.ca-overlay') && document.body.innerText.includes('You have a cloned voice')`, 15000);
      assert.equal((await t.svc.status({ light: true })).openAck, seq);
      await click('Delete my voice');
      await waitFor(`document.querySelector('.ca-confirm')`);
      assert.equal(profile.verifyProfile('default', { root: t.root }).exists, true, 'nothing is deleted before the click on Delete');
      await ev(`document.querySelector('.ca-confirm .btn-danger').click()`);
      await waitFor(`document.body.innerText.includes('was deleted from this computer')`);
      assert.equal(profile.verifyProfile('default', { root: t.root }).exists, false);
      assert.deepEqual(problems, []);
    } finally {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      await cleanup();
      await t.close();
    }
  },
);
