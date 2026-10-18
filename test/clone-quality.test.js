'use strict';

/**
 * Voice enrollment audio checks (src/voice/clone/quality.js, docs/CALLS-DESIGN.md §2.3–2.6):
 * WAV parsing, the §2.4 thresholds on synthetic speech-like PCM (known SNR, clipping, level,
 * length, 8 kHz band), the virtual-device guard and the reference clip builder. Pure Node.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const q = require('../src/voice/clone/quality');

const RATE = 24000;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gauss(r) {
  let u = 0;
  while (!u) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/**
 * Speech-like test signal: bursts (350 ms on / 150 ms off, 0.5 s silence at both ends) of a
 * 140 Hz harmonic series up to `maxHarm`, with RMS `level` while on, plus white noise `snrDb`
 * below it, then times `gain` and clipped to [-1, 1].
 */
function speechLike({ rate = RATE, seconds = 8, level = 0.1, snrDb = 60, maxHarm = 10000, seed = 1, gain = 1, lead = 0.5 } = {}) {
  const r = rng(seed);
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  const f0 = 140;
  const harms = [];
  for (let k = 1; k * f0 < maxHarm && k * f0 < rate / 2; k += 1) harms.push(k);
  const amp = level * Math.sqrt(2 / harms.reduce((s, k) => s + 1 / k, 0));
  const noise = level / 10 ** (snrDb / 20);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const on = t > lead && t < seconds - lead && (t * 1000) % 500 < 350;
    let v = 0;
    if (on) for (const k of harms) v += (amp * Math.sin(2 * Math.PI * k * f0 * t)) / Math.sqrt(k);
    v += noise * gauss(r);
    out[i] = Math.max(-1, Math.min(1, v * gain));
  }
  return out;
}

function check(samples, kind = 'line', rate = RATE) {
  const a = q.analyse({ rate, samples });
  return { a, v: q.verdict(a, kind), codes: q.verdict(a, kind).problems.map((p) => `${p.code}:${p.level}`) };
}

// ------------------------------------------------------------------ WAV

test('writeWav/readWav round trip (24 kHz mono 16-bit)', () => {
  const s = speechLike({ seconds: 1 });
  const buf = q.writeWav(s, RATE);
  assert.equal(buf.length, 44 + s.length * 2);
  const w = q.readWav(buf);
  assert.deepEqual([w.rate, w.channels, w.bits, w.format], [RATE, 1, 16, 'pcm']);
  assert.equal(w.samples.length, s.length);
  assert.ok(Math.abs(w.durationS - 1) < 1e-9);
  for (let i = 0; i < s.length; i += 997) assert.ok(Math.abs(w.samples[i] - s[i]) < 1 / 16000);
});

function wavWith({ tag = 1, channels = 1, rate = 16000, bits = 16, frames = 10, extensible = false, extraChunk = false, write }) {
  const bytes = bits / 8;
  const data = Buffer.alloc(frames * channels * bytes);
  for (let i = 0; i < frames; i += 1) for (let c = 0; c < channels; c += 1) write(data, (i * channels + c) * bytes, i, c);
  const fmtSize = extensible ? 40 : 16;
  const chunks = [];
  const fmt = Buffer.alloc(8 + fmtSize);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(fmtSize, 4);
  fmt.writeUInt16LE(extensible ? 0xfffe : tag, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * bytes, 16);
  fmt.writeUInt16LE(channels * bytes, 20);
  fmt.writeUInt16LE(bits, 22);
  if (extensible) {
    fmt.writeUInt16LE(22, 24);
    fmt.writeUInt16LE(bits, 26);
    fmt.writeUInt32LE(0, 28);
    fmt.writeUInt16LE(tag, 32); // sub-format GUID starts with the format tag
  }
  chunks.push(fmt);
  if (extraChunk) {
    const list = Buffer.alloc(8 + 5 + 1); // odd size + pad byte
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(5, 4);
    chunks.push(list);
  }
  const head = Buffer.alloc(8);
  head.write('data', 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  chunks.push(head, data);
  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, body]);
}

test('readWav: 24-bit stereo is mixed to mono; float32; WAVE_FORMAT_EXTENSIBLE; extra chunks', () => {
  const st = q.readWav(
    wavWith({ channels: 2, bits: 24, rate: 48000, frames: 4, extraChunk: true, write: (b, off, i, c) => b.writeIntLE(c === 0 ? 4194304 : 0, off, 3) }),
  );
  assert.equal(st.rate, 48000);
  assert.equal(st.channels, 2);
  assert.equal(st.samples.length, 4);
  assert.ok(Math.abs(st.samples[0] - 0.25) < 1e-6, 'left 0.5 and right 0 average to 0.25');
  const f = q.readWav(wavWith({ tag: 3, bits: 32, frames: 3, write: (b, off, i) => b.writeFloatLE([0.5, -0.25, 1][i], off) }));
  assert.equal(f.format, 'float');
  assert.deepEqual(Array.from(f.samples), [0.5, -0.25, 1]);
  const x = q.readWav(wavWith({ extensible: true, frames: 2, write: (b, off) => b.writeInt16LE(16384, off) }));
  assert.equal(x.format, 'pcm');
  assert.equal(x.samples[1], 0.5);
});

test('readWav refuses what is not a PCM WAV', () => {
  assert.throws(() => q.readWav(Buffer.from('not a wav at all')), (e) => e.code === 'BAD_WAV');
  assert.throws(() => q.readWav(wavWith({ tag: 2, frames: 2, write: () => {} })), /Unsupported WAV encoding/);
  const noData = q.writeWav(new Float32Array(4), RATE).subarray(0, 36);
  assert.throws(() => q.readWav(noData), /no audio data/);
});

// ------------------------------------------------------------------ §2.4 thresholds

test('a clean take passes with no problems', () => {
  const { a, v, codes } = check(speechLike({ snrDb: 60 }));
  assert.equal(v.ok, true);
  assert.deepEqual(codes, []);
  assert.ok(a.snrDb > 45, `snr ${a.snrDb}`);
  assert.ok(a.voicedS > 4 && a.voicedS < 6, `voiced ${a.voicedS}`);
  assert.ok(a.bandPct > 0.3);
  assert.equal(a.clipPct, 0);
});

test('noise: 20 dB warns, 10 dB and 0 dB fail', () => {
  const at20 = check(speechLike({ snrDb: 20, seed: 2 }));
  assert.equal(at20.v.ok, true);
  assert.deepEqual(at20.codes, ['noisy:warn']);
  assert.ok(at20.a.snrDb > 18 && at20.a.snrDb < 25, `estimated ${at20.a.snrDb}`);
  const at10 = check(speechLike({ snrDb: 10, seed: 3 }));
  assert.equal(at10.v.ok, false);
  assert.ok(at10.codes.includes('noisy:fail'));
  assert.ok(at10.a.snrDb < 15);
  const at0 = check(speechLike({ snrDb: 0, seed: 4 }));
  assert.equal(at0.v.ok, false);
  assert.ok(at0.codes.includes('noisy:fail'));
});

test('clipping: ×6 gain fails, a few clipped samples warn', () => {
  const hard = check(speechLike({ gain: 6, level: 0.3 }));
  assert.ok(hard.codes.includes('clipping:fail'));
  assert.ok(hard.a.clipPct > 1);
  const s = speechLike({ snrDb: 60 });
  // 0.05% of the samples at full scale: between the 0.02% warning and the 0.1% failure.
  const n = Math.round(s.length * 0.0005);
  for (let i = 0; i < n; i += 1) s[24000 + i * 50] = 1;
  const soft = check(s);
  assert.equal(soft.v.ok, true);
  assert.ok(soft.codes.includes('clipping:warn'), soft.codes.join());
});

test('level: −58 dBFS fails as too quiet, −35 dBFS warns', () => {
  const quiet = check(speechLike({ level: 10 ** (-58 / 20) }));
  assert.equal(quiet.v.ok, false);
  assert.ok(quiet.codes.includes('too_quiet:fail'));
  const low = check(speechLike({ level: 10 ** (-35 / 20) }));
  assert.equal(low.v.ok, true);
  assert.ok(low.codes.includes('too_quiet:warn'), low.codes.join());
  assert.equal(low.v.problems.find((p) => p.code === 'too_quiet').hint, 'Move closer or raise the input volume.');
});

test('length: 1.2 s is too short for a line; other kinds have no length rule', () => {
  const short = check(speechLike({ seconds: 1.2, lead: 0.2 }));
  assert.equal(short.v.ok, false);
  assert.ok(short.codes.includes('too_short:fail'));
  assert.equal(short.v.problems.find((p) => p.code === 'too_short').hint, 'Read the whole line.');
  assert.equal(check(speechLike({ seconds: 1.2, lead: 0.2 }), 'roomtone').codes.includes('too_short:fail'), false);
});

test('bandwidth: 24 kHz and 16 kHz speech pass, telephone band (8 kHz) fails', () => {
  assert.ok(check(speechLike()).a.bandPct > 0.3);
  const wide16 = check(speechLike({ rate: 16000 }), 'line', 16000);
  assert.ok(wide16.a.bandPct > 0.3, `16 kHz band ${wide16.a.bandPct}`);
  const narrow = check(speechLike({ maxHarm: 3400, snrDb: 50 }));
  assert.equal(narrow.v.ok, false);
  assert.ok(narrow.codes.includes('narrowband:fail'));
  assert.ok(narrow.a.bandPct < 0.3);
  assert.match(narrow.v.problems.find((p) => p.code === 'narrowband').hint, /Bluetooth/);
  const tel = q.analyse({ rate: 8000, samples: speechLike({ rate: 8000 }) });
  assert.ok(tel.bandPct < 0.1, `8 kHz band ${tel.bandPct}`);
});

test('the whole session needs 45 s of voiced speech', () => {
  const takes = (s) => Array.from({ length: 14 }, () => ({ analysis: { voicedS: s } }));
  assert.deepEqual(q.sessionVerdict(takes(3.5)), { ok: true, voicedS: 49, needS: 45 });
  assert.equal(q.sessionVerdict(takes(3)).ok, false);
  assert.equal(q.sessionVerdict([]).ok, false);
});

// ------------------------------------------------------------------ device guard

test('virtual and loopback input devices are recognized', () => {
  for (const label of [
    'BlackHole 2ch',
    'Default - BlackHole 16ch (Virtual)',
    'CABLE Output (VB-Audio Virtual Cable)',
    'VB-Audio Point',
    'Claude-Anywhere-Mic',
    'Monitor of Built-in Audio Analog Stereo',
    'Loopback Audio',
    'Soundflower (2ch)',
    'Stereo Mix (Realtek(R) Audio)',
    'Aggregate Device',
    'Multi-Output Device',
    'cable input (vb-audio)',
  ]) {
    assert.equal(q.isVirtualDeviceLabel(label), true, label);
  }
  for (const label of ['MacBook Pro Microphone', 'Microphone (Realtek(R) Audio)', 'Headset Microphone (Jabra Evolve2 65)', 'Default - Built-in Audio Analog Stereo', 'USB PnP Sound Device', '']) {
    assert.equal(q.isVirtualDeviceLabel(label), false, label);
  }
  assert.equal(q.isVirtualDeviceLabel(null), false);
});

// ------------------------------------------------------------------ reference clip

test('trimSilence keeps 150 ms around the speech', () => {
  const s = speechLike({ seconds: 4, lead: 1 });
  const t = q.trimSilence(s, RATE);
  // Speech from 1.0 s to 3.0 s (last burst ends by 2.85 s): about 1.85 s + 2 × 0.15 s.
  assert.ok(t.length / RATE > 1.9 && t.length / RATE < 2.4, `${t.length / RATE} s`);
  assert.equal(q.trimSilence(new Float32Array(RATE), RATE).length, 0);
});

test('selectReferenceTakes: best SNR first, 10–15 s, 3–4 takes when they fit, warnings last', () => {
  const take = (index, len, snrDb, warn) => ({ index, trimmedS: len, analysis: { snrDb, durationS: len }, problems: warn ? [{ code: 'noisy', level: 'warn' }] : [] });
  const four = Array.from({ length: 14 }, (_, i) => take(i, 4, 30 + i));
  assert.deepEqual(q.selectReferenceTakes(four).map((t) => t.index), [11, 12, 13]);
  const long = Array.from({ length: 6 }, (_, i) => take(i, 5.5, 30 + i));
  assert.deepEqual(q.selectReferenceTakes(long).map((t) => t.index), [4, 5], 'a third 5.5 s take would pass 15 s');
  const short = Array.from({ length: 6 }, (_, i) => take(i, 3, 30 + i));
  assert.deepEqual(q.selectReferenceTakes(short).map((t) => t.index), [2, 3, 4, 5]);
  const warned = [take(0, 4, 60, true), take(1, 4, 40), take(2, 4, 35), take(3, 4, 30)];
  assert.deepEqual(q.selectReferenceTakes(warned).map((t) => t.index), [1, 2, 3]);
});

test('buildReference: trimmed, joined with gaps, normalized to −20 dBFS with peaks ≤ −1 dBFS', () => {
  const takes = Array.from({ length: 6 }, (_, i) => {
    const samples = speechLike({ seconds: 5, seed: 10 + i, level: 0.02 + i * 0.01 });
    return { index: i, text: `Line ${i + 1}.`, samples, rate: RATE, analysis: { ...q.analyse({ rate: RATE, samples }), snrDb: 40 + i }, problems: [] };
  });
  const ref = q.buildReference(takes);
  assert.equal(ref.rate, RATE);
  assert.ok(ref.seconds >= 10 && ref.seconds <= 15, `${ref.seconds} s`);
  assert.deepEqual(ref.takes, [3, 4, 5]);
  assert.equal(ref.text, 'Line 4. Line 5. Line 6.');
  let sum = 0;
  let peak = 0;
  for (const x of ref.samples) {
    sum += x * x;
    peak = Math.max(peak, Math.abs(x));
  }
  const rmsDb = 20 * Math.log10(Math.sqrt(sum / ref.samples.length));
  assert.ok(peak <= 10 ** (-1 / 20) + 1e-6, `peak ${20 * Math.log10(peak)} dBFS`);
  assert.ok(rmsDb <= -20 + 0.01, `rms ${rmsDb}`);
  assert.ok(rmsDb > -26, `rms ${rmsDb}`);
  assert.throws(() => q.buildReference([]), /No takes/);
});
