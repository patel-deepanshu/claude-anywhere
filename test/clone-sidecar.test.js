'use strict';

/**
 * The real src/voice/clone/sidecar.py in fake mode (ANYWHERE_CLONE_FAKE=1: no numpy, no
 * sherpa-onnx) with any python3, driven through SidecarClient: the protocol, model checks,
 * PROFILE_INVALID for unverified, tampered, linked or misplaced profiles, no free-path cloning,
 * path confinement, speaker consistency, enroll.build, bench, cancellation, the audio_io plug-in
 * hooks and shutdown. Skipped when no Python 3.9+ is available.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { SidecarClient } = require('../src/voice/clone/client');
const models = require('../src/voice/clone/models');

const SIDECAR = path.join(__dirname, '..', 'src', 'voice', 'clone', 'sidecar.py');

function findPython() {
  for (const cmd of [process.env.ANYWHERE_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const r = spawnSync(cmd, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    const m = /^(\d+)\.(\d+)/.exec(String(r.stdout || '').trim());
    if (r.status === 0 && m && (Number(m[1]) > 3 || Number(m[2]) >= 9)) return cmd;
  }
  return null;
}
const PYTHON = findPython();
const SKIP = PYTHON ? false : 'no python3 on this machine';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-clone-sidecar-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

let homeN = 0;
/** A fresh state + models folder pair. */
function makeHome() {
  homeN += 1;
  const state = fs.realpathSync(fs.mkdtempSync(path.join(TMP, `state${homeN}-`)));
  const modelsDir = path.join(state, 'voice', 'clone-models');
  for (const d of ['run/voice-tmp', 'voice/clone/profiles', 'voice/clone/sessions', 'voice/clone-models']) fs.mkdirSync(path.join(state, d), { recursive: true, mode: 0o700 });
  return { state, models: modelsDir, tmp: path.join(state, 'run', 'voice-tmp') };
}

/** Empty files with the names the sidecar expects for the given assets. */
function fakeModels(root, ids) {
  for (const id of ids) {
    const p = models.assetPaths(id, root);
    for (const [role, f] of Object.entries(p.files)) {
      if (role === 'data_dir') fs.mkdirSync(f, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, 'x');
      }
    }
    if (p.benchReference) {
      fs.mkdirSync(path.dirname(p.benchReference), { recursive: true });
      fs.writeFileSync(p.benchReference, wav(24000, 1));
    }
  }
}

/** A 16-bit mono WAV: a sine of `seconds` at `rate`. */
function wav(rate, seconds, freq = 220, amp = 0.3) {
  const n = Math.round(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767), 44 + i * 2);
  return b;
}

function wavSeconds(file) {
  const b = fs.readFileSync(file);
  return b.readUInt32LE(40) / b.readUInt32LE(28);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A consent-verified profile (manifest v1, reference sha256); `mutate` edits the manifest. */
function makeProfile(home, { name = 'default', seconds = 12, mutate, mode = 0o700 } = {}) {
  const dir = path.join(home.state, 'voice', 'clone', 'profiles', name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, mode);
  const ref = wav(24000, seconds);
  fs.writeFileSync(path.join(dir, 'reference.wav'), ref, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'reference.txt'), 'Hi, thanks for calling.', { mode: 0o600 });
  let manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    ownerName: 'Test Owner',
    engine: 'pocket',
    consent: { text: 'I, Test Owner, agree…', codeHash: 'x', transcript: '…', similarity: 0.96, nameHeard: true, verified: true, verifiedAt: new Date().toISOString(), deviceLabel: 'Built-in Microphone' },
    reference: { file: 'reference.wav', seconds, sha256: sha256(ref), text: 'Hi, thanks for calling.' },
  };
  if (mutate) manifest = mutate(manifest) || manifest;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return dir;
}

async function startSidecar(home, { env = {}, script = SIDECAR } = {}) {
  const c = new SidecarClient({
    python: PYTHON,
    script,
    args: ['--state', home.state, '--models', home.models],
    env: { ...process.env, ANYWHERE_CLONE_FAKE: '1', ANYWHERE_CLONE_NO_AUDIO_IO: '1', ...env },
    startTimeoutMs: 15000,
    requestTimeoutMs: 20000,
  });
  const hello = await c.start();
  return { c, hello };
}

async function loadTts(c, home, engine = 'pocket') {
  fakeModels(home.models, models.ENGINES[engine].assets);
  return c.request('tts.load', models.ttsLoadParams(engine, home.models, { threads: 2 }));
}

test('ready/hello, unknown ops, garbage and live-audio ops without the plug-in', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c, hello } = await startSidecar(home);
  const events = [];
  c.on('event', (e) => events.push(e));
  try {
    assert.equal(hello.protocol, 1);
    assert.equal(hello.fake, true);
    assert.equal(hello.sherpa, 'fake');
    assert.equal(hello.numpy, null);
    assert.ok(hello.pid > 0);
    assert.deepEqual(hello.audioIo, { available: false });
    for (const op of ['hello', 'models.check', 'tts.load', 'tts.setVoice', 'tts.synthesize', 'tts.stop', 'warmup', 'asr.load', 'asr.transcribe', 'vad.load', 'vad.segments', 'spk.load', 'spk.consistency', 'spk.similarity', 'enroll.build', 'bench', 'cancel', 'shutdown']) {
      assert.ok(hello.ops.includes(op), `op ${op}`);
    }
    // Safeguard (a): nothing in the op list clones from a free audio path.
    assert.ok(!hello.ops.some((op) => /reference|clone|voice\.from|setReference/i.test(op)), hello.ops.join(','));

    const h = await c.request('hello');
    assert.equal(h.protocol, 1);
    assert.deepEqual(h.loaded, { tts: null, voice: null, asr: null, vad: false, spk: false });

    await assert.rejects(c.request('no.such.op'), { code: 'BAD_REQUEST' });
    for (const op of ['tts.say', 'audio.start', 'audio.devices', 'record.start']) {
      await assert.rejects(c.request(op, { text: 'x' }), (err) => err.code === 'AUDIO_BACKEND' && /audio_io/.test(err.message));
    }
    c.child.stdin.write('this is not json\n');
    c.child.stdin.write(`${JSON.stringify({ id: true, op: 'hello' })}\n`);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(events.filter((e) => e.event === 'protocol.error').length, 2);
    assert.ok(await c.request('hello'), 'still serving');
  } finally {
    await c.stop();
  }
});

test('models.check and MODEL_MISSING loads', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c } = await startSidecar(home);
  try {
    const spec = models.checkSpec(['pocket-int8', 'silero-vad'], home.models);
    let r = await c.request('models.check', { assets: spec });
    assert.equal(r.complete, false);
    assert.ok(r.missing.some((m) => m.id === 'pocket-int8'));
    await assert.rejects(c.request('tts.load', models.ttsLoadParams('pocket', home.models)), (err) => err.code === 'MODEL_MISSING' && /anywhere clone-voice install/.test(err.hint));
    await assert.rejects(c.request('asr.load', models.asrLoadParams('moonshine', home.models)), { code: 'MODEL_MISSING' });
    await assert.rejects(c.request('spk.load', models.spkLoadParams(home.models)), { code: 'MODEL_MISSING' });
    fakeModels(home.models, ['pocket-int8', 'silero-vad']);
    r = await c.request('models.check', { assets: spec });
    assert.deepEqual(r, { missing: [], complete: true });
    // Model files must be inside --models.
    const outside = { ...models.ttsLoadParams('pocket', home.models), files: { ...models.assetPaths('pocket-int8', home.models).files, encoder: path.join(home.state, 'evil.onnx') } };
    fs.writeFileSync(path.join(home.state, 'evil.onnx'), 'x');
    await assert.rejects(c.request('tts.load', outside), { code: 'BAD_REQUEST' });
    const t = await c.request('tts.load', models.ttsLoadParams('pocket', home.models, { threads: 2 }));
    assert.equal(t.engine, 'pocket');
    assert.equal(t.sampleRate, 24000);
    assert.equal(t.steps, 5);
    await assert.rejects(c.request('tts.load', { engine: 'xtts', dir: home.models }), { code: 'BAD_REQUEST' });
    // ZipVoice needs its vocoder.
    fakeModels(home.models, ['zipvoice-int8']);
    await assert.rejects(c.request('tts.load', models.ttsLoadParams('zipvoice', home.models)), { code: 'MODEL_MISSING' });
    fakeModels(home.models, ['vocos-24k']);
    assert.equal((await c.request('tts.load', models.ttsLoadParams('zipvoice', home.models))).steps, 3);
  } finally {
    await c.stop();
  }
});

test('tts.setVoice accepts only a consent-verified, untampered profile under profiles/', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c } = await startSidecar(home);
  const out = path.join(home.tmp, 'out.wav');
  try {
    await loadTts(c, home);
    await assert.rejects(c.request('tts.synthesize', { text: 'Hello there.', out }), { code: 'PROFILE_INVALID' });
    await assert.rejects(c.request('tts.setVoice', { profileDir: path.join(home.state, 'voice', 'clone', 'profiles', 'default') }), { code: 'PROFILE_INVALID' });

    const bad = async (name, opts, re) => {
      const dir = makeProfile(home, { name, ...opts });
      await assert.rejects(c.request('tts.setVoice', { profileDir: dir }), (err) => {
        assert.equal(err.code, 'PROFILE_INVALID', `${name}: ${err.message}`);
        if (re) assert.match(err.message, re, name);
        return true;
      });
      return dir;
    };
    await bad('unverified', { mutate: (m) => ({ ...m, consent: { ...m.consent, verified: false } }) }, /consent/);
    await bad('truthy', { mutate: (m) => ({ ...m, consent: { ...m.consent, verified: 'yes' } }) }, /consent/);
    await bad('noverifiedat', { mutate: (m) => ({ ...m, consent: { ...m.consent, verifiedAt: '' } }) }, /consent/);
    await bad('noconsent', { mutate: (m) => { delete m.consent; return m; } }, /consent/);
    await bad('v2', { mutate: (m) => ({ ...m, version: 2 }) });
    await bad('otherfile', { mutate: (m) => ({ ...m, reference: { ...m.reference, file: '../../sessions/x/take.wav' } }) }, /checksum/);
    await bad('badsha', { mutate: (m) => ({ ...m, reference: { ...m.reference, sha256: 'z'.repeat(64) } }) }, /checksum/);
    await bad('short', { seconds: 1 }, /2-60 s/);
    const tampered = makeProfile(home, { name: 'tampered' });
    fs.writeFileSync(path.join(tampered, 'reference.wav'), wav(24000, 12, 330)); // someone else's audio
    await assert.rejects(c.request('tts.setVoice', { profileDir: tampered }), (err) => err.code === 'PROFILE_INVALID' && /does not match/.test(err.message));
    if (process.platform !== 'win32') {
      await bad('shared', { mode: 0o777 }, /writable by other users/);
      const wide = makeProfile(home, { name: 'widefile' });
      fs.chmodSync(path.join(wide, 'reference.wav'), 0o666);
      await assert.rejects(c.request('tts.setVoice', { profileDir: wide }), (err) => err.code === 'PROFILE_INVALID' && /writable/.test(err.message));
    }

    // Folders outside profiles/: a session folder, a sibling, traversal, the state root, another tree.
    const good = makeProfile(home);
    const sess = path.join(home.state, 'voice', 'clone', 'sessions', 's1');
    fs.mkdirSync(sess, { recursive: true });
    for (const f of ['manifest.json', 'reference.wav', 'reference.txt']) fs.copyFileSync(path.join(good, f), path.join(sess, f));
    const elsewhere = path.join(TMP, `elsewhere-${homeN}`);
    fs.mkdirSync(elsewhere, { recursive: true });
    for (const f of ['manifest.json', 'reference.wav']) fs.copyFileSync(path.join(good, f), path.join(elsewhere, f));
    for (const p of [sess, elsewhere, `${good}/../../sessions/s1`, path.join(home.state, 'voice', 'clone', 'profiles'), home.state, path.join(good, 'reference.wav'), '', 42]) {
      await assert.rejects(c.request('tts.setVoice', { profileDir: p }), { code: 'PROFILE_INVALID' }, String(p));
    }
    if (process.platform !== 'win32') {
      const link = path.join(home.state, 'voice', 'clone', 'profiles', 'linked');
      fs.symlinkSync(elsewhere, link);
      await assert.rejects(c.request('tts.setVoice', { profileDir: link }), { code: 'PROFILE_INVALID' });
      const reflink = makeProfile(home, { name: 'reflink' });
      fs.rmSync(path.join(reflink, 'reference.wav'));
      fs.symlinkSync(path.join(good, 'reference.wav'), path.join(reflink, 'reference.wav'));
      await assert.rejects(c.request('tts.setVoice', { profileDir: reflink }), { code: 'PROFILE_INVALID' });
    }

    const ok = await c.request('tts.setVoice', { profileDir: good });
    assert.equal(ok.profile, 'default');
    assert.equal(ok.engine, 'pocket');
    assert.ok(Math.abs(ok.seconds - 12) < 0.01);
    assert.equal(ok.sha256, JSON.parse(fs.readFileSync(path.join(good, 'manifest.json'), 'utf8')).reference.sha256);
  } finally {
    await c.stop();
  }
});

test('no free-path cloning: extra reference parameters are ignored, the voice comes only from the profile', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c } = await startSidecar(home);
  try {
    await loadTts(c, home);
    const stranger = path.join(home.tmp, 'stranger.wav');
    fs.writeFileSync(stranger, wav(24000, 10, 400));
    for (const params of [{ reference: stranger }, { referenceWav: stranger }, { reference_audio: stranger }, { profileDir: home.tmp }, { wav: stranger }]) {
      await assert.rejects(c.request('tts.synthesize', { text: 'Hello.', out: path.join(home.tmp, 'x.wav'), ...params }), { code: 'PROFILE_INVALID' }, JSON.stringify(params));
    }
    await assert.rejects(c.request('tts.setVoice', { profileDir: home.tmp, reference: stranger }), { code: 'PROFILE_INVALID' });
    await assert.rejects(c.request('warmup', { reference: stranger }), { code: 'PROFILE_INVALID' });
    // A folder that merely contains a reference.wav is not a profile.
    const fake = path.join(home.state, 'voice', 'clone', 'profiles', 'stranger');
    fs.mkdirSync(fake, { mode: 0o700 });
    fs.copyFileSync(stranger, path.join(fake, 'reference.wav'));
    await assert.rejects(c.request('tts.setVoice', { profileDir: fake }), { code: 'PROFILE_INVALID' });
  } finally {
    await c.stop();
  }
});

test('tts.synthesize writes a WAV under --state with chunk events; output paths are confined', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c } = await startSidecar(home);
  try {
    await loadTts(c, home);
    await c.request('tts.setVoice', { profileDir: makeProfile(home) });
    const out = path.join(home.tmp, 'greeting.wav');
    const text = 'Hi Ankit, this is the assistant. I am taking notes. How can I help?';
    const chunks = [];
    const r = await c.request('tts.synthesize', { text, out }, { onEvent: (e) => chunks.push(e) });
    assert.equal(r.out, fs.realpathSync(out));
    assert.equal(r.sampleRate, 24000);
    assert.equal(r.engine, 'pocket');
    assert.ok(Number.isInteger(r.totalMs) && Number.isInteger(r.firstChunkMs));
    const secs = wavSeconds(out);
    assert.ok(Math.abs(secs - 0.06 * text.length) < 0.01, `duration ${secs}`);
    assert.equal(r.audioMs, Math.round(secs * 1000));
    assert.equal(chunks.length, 3, 'one chunk per sentence');
    assert.ok(chunks.every((e) => e.event === 'tts.chunk' && e.samples > 0));
    assert.equal(chunks.reduce((n, e) => n + e.samples, 0), Math.round(secs * 24000));
    if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600);

    // Deterministic.
    const out2 = path.join(home.tmp, 'again.wav');
    await c.request('tts.synthesize', { text, out: out2 });
    assert.ok(fs.readFileSync(out).equals(fs.readFileSync(out2)));

    for (const bad of [path.join(TMP, 'outside.wav'), path.join(home.tmp, 'x.mp3'), path.join(home.tmp, 'missing-dir', 'x.wav'), `${home.tmp}/../../../escape.wav`, home.tmp]) {
      await assert.rejects(c.request('tts.synthesize', { text: 'Hi.', out: bad }), { code: 'BAD_REQUEST' }, bad);
    }
    await assert.rejects(c.request('tts.synthesize', { text: '   ', out }), { code: 'BAD_REQUEST' });
    await assert.rejects(c.request('tts.synthesize', { text: 'x'.repeat(2001), out }), { code: 'BAD_REQUEST' });
    await assert.rejects(c.request('tts.synthesize', { text: 42, out }), { code: 'BAD_REQUEST' });
    const w = await c.request('warmup');
    assert.ok(Number.isInteger(w.ms));
  } finally {
    await c.stop();
  }
});

test('tts.stop and cancel stop a synthesis in progress', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c } = await startSidecar(home);
  try {
    await loadTts(c, home);
    await c.request('tts.setVoice', { profileDir: makeProfile(home) });
    const long = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i} of a long reply.`).join(' ');
    const p1 = c.request('tts.synthesize', { text: long.slice(0, 1990), out: path.join(home.tmp, 'long.wav') });
    // The cancelled request may be answered before tts.stop is: assert on it right away.
    const p1Cancelled = assert.rejects(p1, { code: 'CANCELLED' });
    const stop = await c.request('tts.stop');
    assert.ok(stop.stopped >= 1);
    await p1Cancelled;
    assert.equal(fs.existsSync(path.join(home.tmp, 'long.wav')), false);

    // The client's timeout sends `cancel` for its request id.
    const p2 = c.request('tts.synthesize', { text: long.slice(0, 1990), out: path.join(home.tmp, 'long2.wav') }, { timeoutMs: 1 });
    await assert.rejects(p2, { code: 'SIDECAR_TIMEOUT' });
    const cancelled = await c.request('cancel', { target: 999999 });
    assert.equal(cancelled.cancelled, false);
    // Still serving afterwards.
    assert.ok((await c.request('tts.synthesize', { text: 'Done.', out: path.join(home.tmp, 'done.wav') })).audioMs > 0);
  } finally {
    await c.stop();
  }
});

test('asr.transcribe and vad.segments read audio under --state only', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c } = await startSidecar(home);
  try {
    const take = path.join(home.tmp, 'caller.wav');
    fs.writeFileSync(take, wav(16000, 2.5));
    await assert.rejects(c.request('asr.transcribe', { wav: take }), { code: 'MODEL_MISSING' });
    fakeModels(home.models, ['moonshine-base-int8', 'silero-vad']);
    assert.equal((await c.request('asr.load', models.asrLoadParams('moonshine', home.models))).model, 'moonshine');
    fs.writeFileSync(`${take}.txt`, 'Can you please assign me a ticket?\n');
    const r = await c.request('asr.transcribe', { wav: take });
    assert.equal(r.text, 'Can you please assign me a ticket?');
    assert.equal(r.seconds, 2.5);
    fs.rmSync(`${take}.txt`);
    assert.equal((await c.request('asr.transcribe', { wav: take })).text, '');

    const outside = path.join(TMP, `outside-${homeN}.wav`);
    fs.writeFileSync(outside, wav(16000, 1));
    for (const p of [outside, path.join(home.tmp, 'missing.wav'), `${home.tmp}/../../..${outside}`]) {
      await assert.rejects(c.request('asr.transcribe', { wav: p }), { code: 'BAD_REQUEST' }, p);
    }
    const notWav = path.join(home.tmp, 'note.wav');
    fs.writeFileSync(notWav, 'hello');
    await assert.rejects(c.request('asr.transcribe', { wav: notWav }), (err) => err.code === 'BAD_REQUEST' && /WAV/.test(err.message));

    await assert.rejects(c.request('vad.segments', { wav: take }), { code: 'MODEL_MISSING' });
    await c.request('vad.load', models.vadLoadParams(home.models));
    const v = await c.request('vad.segments', { wav: take });
    assert.deepEqual(v.segments, [{ start: 0, end: 2.5 }]);
    assert.equal(v.voicedSeconds, 2.5);
  } finally {
    await c.stop();
  }
});

test('spk.consistency and spk.similarity (fake embeddings by speaker key)', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c } = await startSidecar(home);
  try {
    const sess = path.join(home.state, 'voice', 'clone', 'sessions', 'abc');
    fs.mkdirSync(sess, { recursive: true });
    const takes = [1, 2, 3, 4].map((i) => {
      const f = path.join(sess, `line-${i}.wav`);
      fs.writeFileSync(f, wav(24000, 3));
      return f;
    });
    const consent = path.join(sess, 'consent.wav');
    fs.writeFileSync(consent, wav(24000, 6));
    await assert.rejects(c.request('spk.consistency', { wavs: takes }), { code: 'MODEL_MISSING' });
    fakeModels(home.models, ['spk-3dspeaker']);
    assert.equal((await c.request('spk.load', models.spkLoadParams(home.models))).dim, 64);

    const r = await c.request('spk.consistency', { wavs: takes, probe: consent });
    assert.equal(r.scores.length, 4);
    assert.ok(r.min >= 0.9, `same speaker: ${r.scores}`);
    assert.ok(r.probe >= 0.9, `consent by the same speaker: ${r.probe}`);
    assert.ok(fs.existsSync(r.centroid));
    assert.ok(r.centroid.startsWith(home.state));
    assert.equal(JSON.parse(fs.readFileSync(r.centroid, 'utf8')).dim, 64);

    fs.writeFileSync(`${consent}.spk`, 'somebody-else');
    const other = await c.request('spk.consistency', { wavs: takes, probe: consent });
    assert.ok(other.probe < 0.45, `another speaker fails the 0.45 rule: ${other.probe}`);
    fs.writeFileSync(`${takes[3]}.spk`, JSON.stringify(Array.from({ length: 64 }, (_, i) => (i === 63 ? 1 : 0))));
    const mixed = await c.request('spk.consistency', { wavs: takes });
    assert.ok(mixed.scores[3] < 0.45 && mixed.scores[0] > 0.5, `${mixed.scores}`);

    const out = path.join(home.tmp, 'centroid.json');
    const cr = await c.request('spk.consistency', { wavs: takes.slice(0, 3), centroidOut: out });
    assert.equal(cr.centroid, fs.realpathSync(out));
    const sim = await c.request('spk.similarity', { wav: takes[0], centroid: out });
    assert.ok(sim.score > 0.9);
    await assert.rejects(c.request('spk.consistency', { wavs: takes, centroidOut: path.join(home.tmp, 'c.txt') }), { code: 'BAD_REQUEST' });
    await assert.rejects(c.request('spk.consistency', { wavs: [] }), { code: 'BAD_REQUEST' });
    await assert.rejects(c.request('spk.similarity', { wav: takes[0], centroid: takes[1] }), { code: 'BAD_REQUEST' });
  } finally {
    await c.stop();
  }
});

test('enroll.build: reference from session takes only, best SNR first, 10–15 s; Node writes the manifest', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c } = await startSidecar(home);
  try {
    const sess = path.join(home.state, 'voice', 'clone', 'sessions', 's42');
    fs.mkdirSync(sess, { recursive: true });
    const takes = [];
    for (let i = 0; i < 6; i += 1) {
      const f = path.join(sess, `line-${i + 1}.wav`);
      fs.writeFileSync(f, wav(24000, 4, 200 + i * 20));
      takes.push({ wav: f, text: `Line ${i + 1}.`, snr: [30, 45, 20, 40, 35, 10][i] });
    }
    const consent = path.join(sess, 'consent.wav');
    fs.writeFileSync(consent, wav(24000, 6));
    const profileDir = path.join(home.state, 'voice', 'clone', 'profiles', 'default');
    const r = await c.request('enroll.build', { sessionDir: sess, takes, profileDir, consentWav: consent, manifest: { consent: { verified: true } } });
    // Best SNR: lines 2 (45), 4 (40), 5 (35) → 12 s + 2 gaps of 0.25 s; in recorded order.
    assert.deepEqual(r.used, [1, 3, 4]);
    assert.equal(r.refText, 'Line 2. Line 4. Line 5.');
    assert.ok(Math.abs(r.referenceSeconds - 12.5) < 0.01, `${r.referenceSeconds}`);
    const ref = path.join(profileDir, 'reference.wav');
    assert.equal(r.sha256, sha256(fs.readFileSync(ref)));
    assert.equal(fs.readFileSync(path.join(profileDir, 'reference.txt'), 'utf8'), 'Line 2. Line 4. Line 5.');
    assert.ok(fs.readFileSync(path.join(profileDir, 'consent.wav')).equals(fs.readFileSync(consent)));
    assert.equal(fs.existsSync(path.join(profileDir, 'manifest.json')), false, 'the sidecar never writes the manifest');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(profileDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(ref).mode & 0o777, 0o600);
    }
    // Without a verified manifest (written by Node after the consent check) the voice cannot be used.
    await loadTts(c, home);
    await assert.rejects(c.request('tts.setVoice', { profileDir }), { code: 'PROFILE_INVALID' });

    // Takes must come from a session folder; profiles must be under profiles/.
    const stray = path.join(home.tmp, 'stray.wav');
    fs.writeFileSync(stray, wav(24000, 12));
    await assert.rejects(c.request('enroll.build', { sessionDir: sess, takes: [{ wav: stray, text: 'x', snr: 50 }], profileDir }), { code: 'BAD_REQUEST' });
    await assert.rejects(c.request('enroll.build', { sessionDir: home.tmp, takes: [{ wav: stray, text: 'x', snr: 50 }], profileDir }), { code: 'BAD_REQUEST' });
    await assert.rejects(c.request('enroll.build', { sessionDir: sess, takes, profileDir: path.join(home.tmp, 'profile') }), { code: 'PROFILE_INVALID' });
    const before = fs.readFileSync(ref);
    await assert.rejects(c.request('enroll.build', { sessionDir: sess, takes, profileDir, consentWav: stray }), { code: 'BAD_REQUEST' });
    assert.ok(fs.readFileSync(ref).equals(before), 'nothing is written when the consent take is refused');
    // One 4 s take: below the 10 s target but enough (≥ 3 s) for a reference.
    const one = await c.request('enroll.build', { sessionDir: sess, takes: [{ wav: takes[0].wav, text: 'x' }], profileDir });
    assert.deepEqual(one.used, [0]);
    assert.equal(one.referenceSeconds, 4);
    const tiny = path.join(sess, 'tiny.wav');
    fs.writeFileSync(tiny, wav(24000, 1));
    await assert.rejects(c.request('enroll.build', { sessionDir: sess, takes: [{ wav: tiny, text: 'x', snr: 30 }], profileDir }), (err) => err.code === 'BAD_REQUEST' && /Not enough speech/.test(err.message));
  } finally {
    await c.stop();
  }
});

test('bench returns timings only, with progress events', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c } = await startSidecar(home);
  try {
    await assert.rejects(c.request('bench', models.ttsLoadParams('pocket', home.models)), { code: 'MODEL_MISSING' });
    fakeModels(home.models, ['pocket-int8']);
    const progress = [];
    const r = await c.request('bench', { ...models.ttsLoadParams('pocket', home.models), threads: [1, 2, 4], reference: '/etc/passwd' }, { onEvent: (e) => progress.push(e) });
    assert.deepEqual(r.runs.map((x) => x.threads), [1, 2, 4]);
    assert.ok(r.runs.every((x) => x.engine === 'pocket' && x.rtf > 0 && x.steps === 5 && 'firstChunkMs' in x));
    assert.equal(progress.filter((e) => e.event === 'bench.progress').length, 3);
    assert.equal(r.best.threads, 1);
    assert.ok(!('out' in r) && !('samples' in r), 'no audio comes back');
    fs.rmSync(models.assetPaths('pocket-int8', home.models).benchReference);
    await assert.rejects(c.request('bench', models.ttsLoadParams('pocket', home.models)), { code: 'MODEL_MISSING' });
  } finally {
    await c.stop();
  }
});

test('the audio_io plug-in: allowed hooks only, host.synthesize uses the profile voice, shutdown hook', { skip: SKIP }, async () => {
  const home = makeHome();
  const pkg = fs.mkdtempSync(path.join(TMP, 'pkg-'));
  fs.copyFileSync(SIDECAR, path.join(pkg, 'sidecar.py'));
  const marker = path.join(home.state, 'shutdown-hook.txt');
  fs.writeFileSync(
    path.join(pkg, 'audio_io.py'),
    `
import os, threading
MARKER = ${JSON.stringify(marker)}

def register(host):
    def devices(params, ctx):
        return {"inputs": [], "outputs": [{"name": "Claude-Anywhere-Mic", "id": "anywhere_mic", "backend": "pulse", "virtual": True}], "loopbacks": []}

    def say(params, ctx):
        def run():
            ctx.emit("playback.start", utteranceId=params.get("utteranceId"))
            got = []
            r = host.synthesize(params["text"], on_chunk=lambda s, i: got.append(len(s)), cancel=ctx.cancel)
            ctx.emit("playback.end", utteranceId=params.get("utteranceId"), interrupted=r["cancelled"], samples=sum(got), clauses=len(host.split_clauses(params["text"])))
        threading.Thread(target=run, daemon=True).start()
        return {"queued": True, "ready": host.tts_ready()}

    def stop(params, ctx):
        host.emit("audio.stopped")
        return {}

    def shutdown(params, ctx):
        with open(MARKER, "w") as f:
            f.write("bye")

    def set_voice(params, ctx):
        return {"hijacked": True}

    return {"audio.devices": devices, "tts.say": say, "tts.stop": stop, "shutdown": shutdown, "tts.setVoice": set_voice, "hello": devices, "not callable": 3}
`,
  );
  const { c, hello } = await startSidecar(home, { script: path.join(pkg, 'sidecar.py'), env: { ANYWHERE_CLONE_NO_AUDIO_IO: '' } });
  const events = [];
  c.on('event', (e) => events.push(e));
  try {
    assert.equal(hello.audioIo.available, true);
    assert.deepEqual(hello.audioIo.ops, ['audio.devices', 'tts.say']);
    const d = await c.request('audio.devices');
    assert.equal(d.outputs[0].name, 'Claude-Anywhere-Mic');
    // Core ops cannot be replaced by the plug-in.
    await assert.rejects(c.request('tts.setVoice', { profileDir: home.tmp }), { code: 'PROFILE_INVALID' });
    assert.equal((await c.request('hello')).protocol, 1);
    // tts.say before a voice: the plug-in's synthesis fails, so no playback.end.
    await loadTts(c, home);
    await c.request('tts.setVoice', { profileDir: makeProfile(home) });
    const r = await c.request('tts.say', { text: 'Sure. Let me check that for you.', utteranceId: 'u1' });
    assert.deepEqual(r, { queued: true, ready: true });
    const deadline = Date.now() + 5000;
    while (!events.some((e) => e.event === 'playback.end') && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));
    const end = events.find((e) => e.event === 'playback.end');
    assert.ok(end, 'playback.end arrived');
    assert.equal(end.utteranceId, 'u1');
    assert.equal(end.interrupted, false);
    assert.equal(end.samples, Math.round(0.06 * 'Sure. Let me check that for you.'.length * 24000));
    assert.equal(end.clauses, 2);
    assert.ok(events.some((e) => e.event === 'playback.start' && e.id === r.id) || events.some((e) => e.event === 'playback.start'));
    await c.request('tts.stop');
    assert.ok(events.some((e) => e.event === 'audio.stopped'), 'the tts.stop hook ran');
  } finally {
    await c.stop();
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), 'bye', 'the shutdown hook ran');
});

test('a plug-in that fails to load is reported, not fatal', { skip: SKIP }, async () => {
  const home = makeHome();
  const pkg = fs.mkdtempSync(path.join(TMP, 'pkg-'));
  fs.copyFileSync(SIDECAR, path.join(pkg, 'sidecar.py'));
  fs.writeFileSync(path.join(pkg, 'audio_io.py'), 'import numpy_that_does_not_exist\n');
  const { c, hello } = await startSidecar(home, { script: path.join(pkg, 'sidecar.py'), env: { ANYWHERE_CLONE_NO_AUDIO_IO: '' } });
  try {
    assert.equal(hello.audioIo.available, false);
    assert.match(hello.audioIo.error, /ModuleNotFoundError|ImportError/);
    await assert.rejects(c.request('audio.start'), (err) => err.code === 'AUDIO_BACKEND' && /numpy_that_does_not_exist/.test(err.message));
  } finally {
    await c.stop();
  }
});

test('shutdown answers queued work and exits 0; stdin EOF exits too; oversized lines are refused', { skip: SKIP }, async () => {
  const home = makeHome();
  const { c } = await startSidecar(home);
  const events = [];
  c.on('event', (e) => events.push(e));
  c.child.stdin.write(`${JSON.stringify({ id: 'big', op: 'hello', pad: 'x'.repeat(1024 * 1024 + 100) })}\n`);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(events.some((e) => e.event === 'protocol.error' && /1 MB/.test(e.message)));
  assert.ok(await c.request('hello'));
  const info = await c.stop({ graceMs: 3000 });
  assert.equal(info.code, 0);

  const { c: c2 } = await startSidecar(home);
  const exited = new Promise((r) => c2.once('exit', r));
  c2.child.stdin.end();
  const e2 = await exited;
  assert.equal(e2.code, 0);
});

test('the sidecar refuses to start without its state folder', { skip: SKIP }, async () => {
  const c = new SidecarClient({ python: PYTHON, script: SIDECAR, args: ['--state', path.join(TMP, 'nope'), '--models', TMP], env: { ...process.env, ANYWHERE_CLONE_FAKE: '1' }, startTimeoutMs: 10000 });
  await assert.rejects(c.start(), (err) => err.code === 'SIDECAR_EXITED' && /state folder/.test(err.message));
});
