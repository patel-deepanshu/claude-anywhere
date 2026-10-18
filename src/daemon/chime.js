'use strict';

/**
 * Short, pleasant notification chimes, generated in pure JS as 16-bit mono WAV (22050 Hz).
 *
 * Each chime is two soft bell-like notes (a sine with a little second and third harmonic,
 * a fast attack and an exponential decay), about 350 ms long:
 *   done / info   bright rising fifth (E5 → B5)
 *   permission    "ding-dong" (A5 → F5) that asks for attention
 *   question      softer and lower (D5 → G5)
 *   error         lower and minor (G4 → E♭4)
 * The files are written once to runDir()/chimes/ and reused.
 */

const fs = require('fs');
const path = require('path');
const paths = require('../shared/paths');

const SAMPLE_RATE = 22050;

/** @type {Object<string, {notes:Array<[number, number, number]>, gain:number, attack:number, decay:number}>} */
const CHIMES = Object.freeze({
  // [frequency Hz, start s, length s]
  done: { notes: [[659.25, 0, 0.24], [987.77, 0.11, 0.24]], gain: 0.42, attack: 0.006, decay: 0.075 },
  info: { notes: [[659.25, 0, 0.24], [987.77, 0.11, 0.24]], gain: 0.3, attack: 0.008, decay: 0.07 },
  permission: { notes: [[880.0, 0, 0.22], [698.46, 0.13, 0.22]], gain: 0.4, attack: 0.005, decay: 0.07 },
  question: { notes: [[587.33, 0, 0.23], [783.99, 0.12, 0.23]], gain: 0.27, attack: 0.02, decay: 0.08 },
  error: { notes: [[392.0, 0, 0.27], [311.13, 0.15, 0.27]], gain: 0.4, attack: 0.008, decay: 0.1 },
});

const CHIME_KINDS = Object.freeze(Object.keys(CHIMES));

/** Map an announcement kind to its chime ('done' for anything unknown). */
function chimeKind(kind) {
  return Object.prototype.hasOwnProperty.call(CHIMES, kind) ? kind : 'done';
}

/**
 * Render a chime as signed 16-bit samples.
 * @param {string} kind
 * @param {{sampleRate?:number}} [opts]
 * @returns {Int16Array}
 */
function renderChime(kind = 'done', { sampleRate = SAMPLE_RATE } = {}) {
  const spec = CHIMES[chimeKind(kind)];
  const total = Math.max(...spec.notes.map(([, start, len]) => start + len));
  const n = Math.ceil(total * sampleRate);
  const mix = new Float64Array(n);
  for (const [freq, start, len] of spec.notes) {
    const s0 = Math.round(start * sampleRate);
    const count = Math.min(n - s0, Math.round(len * sampleRate));
    for (let i = 0; i < count; i += 1) {
      const t = i / sampleRate;
      const env = (t < spec.attack ? t / spec.attack : Math.exp(-(t - spec.attack) / spec.decay));
      // A bell: the fundamental, a quickly fading octave for the "strike", and a soft twelfth.
      const strike = Math.exp(-t / 0.035);
      const v =
        Math.sin(2 * Math.PI * freq * t) +
        0.3 * strike * Math.sin(2 * Math.PI * 2 * freq * t) +
        0.12 * Math.sin(2 * Math.PI * 3 * freq * t);
      mix[s0 + i] += env * v;
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i += 1) peak = Math.max(peak, Math.abs(mix[i]));
  const scale = peak > 0 ? spec.gain / peak : 0;
  // 12 ms fade-out so the end never clicks.
  const fade = Math.round(0.012 * sampleRate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    let v = mix[i] * scale;
    if (i >= n - fade) v *= (n - 1 - i) / fade;
    out[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

/**
 * A PCM WAV file (RIFF, format 1) for 16-bit mono samples.
 * @param {Int16Array} samples
 * @param {number} [sampleRate]
 * @returns {Buffer}
 */
function wavFromSamples(samples, sampleRate = SAMPLE_RATE) {
  const dataLen = samples.length * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i += 1) b.writeInt16LE(samples[i], 44 + i * 2);
  return b;
}

/**
 * The chime as WAV bytes.
 * @param {string} [kind] done | info | permission | question | error
 * @returns {Buffer}
 */
function chimeWav(kind = 'done') {
  return wavFromSamples(renderChime(kind), SAMPLE_RATE);
}

/**
 * The chime's WAV file, written to `dir` (default runDir()/chimes) the first time.
 * @param {string} [kind]
 * @param {{dir?:string}} [opts]
 * @returns {string} absolute path
 */
function chimeFile(kind = 'done', { dir } = {}) {
  const k = chimeKind(kind);
  const folder = dir || path.join(paths.runDir(), 'chimes');
  const file = path.join(folder, `chime-${k}.wav`);
  const wav = chimeWav(k);
  try {
    if (fs.statSync(file).size === wav.length) return file;
  } catch {
    /* not written yet */
  }
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, wav, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { SAMPLE_RATE, CHIMES, CHIME_KINDS, chimeKind, renderChime, wavFromSamples, chimeWav, chimeFile };
