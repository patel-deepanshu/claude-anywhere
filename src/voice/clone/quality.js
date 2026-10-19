'use strict';

/**
 * Audio checks for voice enrollment (docs/CALLS-DESIGN.md §2.3, §2.4, §2.6). Pure Node, no
 * dependencies: WAV parsing and writing, level/noise/clipping/bandwidth analysis, the pass/warn/fail
 * verdict with the hint the dialog shows, the virtual-device guard, and the reference clip builder.
 *
 * Analysis: 20 ms frames and their RMS. Noise is the 10th-percentile frame and speech the
 * 90th-percentile frame; the voiced threshold is max(noise × 3.16, 0.003); SNR is
 * 20·log10(speech/noise); clipping is the share of samples with |x| ≥ 0.985; bandwidth is the share
 * of spectral energy between 4 and 8 kHz over the voiced frames (Hann-windowed FFT). 8 kHz
 * (telephone, Bluetooth hands-free) audio has none, which is what the narrowband check catches.
 */

const FRAME_S = 0.02;
const CLIP_LEVEL = 0.985;
const MIN_VOICED_THRESHOLD = 0.003;
const NOISE_FLOOR = 1e-5; // -100 dBFS: digital silence would otherwise give an infinite SNR
const MAX_FFT_FRAMES = 400;

/** Take limits for uploads (§2.3). */
const LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, minSeconds: 2, maxSeconds: 30, rate: 24000, sessionVoicedSeconds: 45 });

/** §2.4 thresholds. */
const THRESHOLDS = Object.freeze({
  minVoicedS: 2.0,
  speechFailDbfs: -40,
  speechWarnDbfs: -30,
  clipFailPct: 0.1,
  clipWarnPct: 0.02,
  snrFailDb: 15,
  snrWarnDb: 25,
  bandFailPct: 0.3,
});

const HINTS = Object.freeze({
  too_short: 'Read the whole line.',
  too_quiet: 'Move closer or raise the input volume.',
  clipping: 'Too loud: lower the input volume.',
  noisy: 'Background noise: try a quieter room.',
  narrowband: 'This mic sounds narrowband (Bluetooth headset?). Use the laptop or a USB mic.',
});

const VIRTUAL_DEVICE_RE = /blackhole|vb-?audio|cable (in|out)put|claude-anywhere|monitor of|loopback|soundflower|virtual|stereo mix|aggregate|multi-output/i;

/**
 * Whether an input device label belongs to a virtual or loopback device (refused for enrollment:
 * only the user's own live voice from a real microphone may be cloned).
 * @param {*} label
 * @returns {boolean}
 */
function isVirtualDeviceLabel(label) {
  return typeof label === 'string' && VIRTUAL_DEVICE_RE.test(label);
}

function wavError(message) {
  const e = new Error(message);
  e.code = 'BAD_WAV';
  return e;
}

/**
 * Parse a RIFF/WAVE file (PCM 8/16/24/32-bit integer or 32/64-bit float, WAVE_FORMAT_EXTENSIBLE
 * included). Channels are mixed down to mono.
 * @param {Buffer} buf
 * @returns {{rate:number, channels:number, bits:number, format:'pcm'|'float', samples:Float32Array, durationS:number}}
 */
function readWav(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw wavError('Not a WAV file (RIFF/WAVE header missing)');
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'data' && (size === 0xffffffff || body + size > buf.length)) size = buf.length - body; // streamed or truncated
    if (body + size > buf.length) break;
    if (id === 'fmt ' && size >= 16) {
      let tag = buf.readUInt16LE(body);
      if (tag === 0xfffe && size >= 40) tag = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = { tag, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = { off: body, size };
      if (fmt) break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt) throw wavError('The WAV file has no format chunk');
  if (!data) throw wavError('The WAV file has no audio data');
  const { tag, channels, rate, bits } = fmt;
  if (!(channels >= 1 && channels <= 8)) throw wavError(`Unsupported channel count ${channels}`);
  if (!(rate >= 4000 && rate <= 192000)) throw wavError(`Unsupported sample rate ${rate}`);
  const isFloat = tag === 3;
  if (!(tag === 1 || isFloat)) throw wavError(`Unsupported WAV encoding (format ${tag}); send PCM`);
  if (isFloat ? !(bits === 32 || bits === 64) : ![8, 16, 24, 32].includes(bits)) throw wavError(`Unsupported bit depth ${bits}`);
  const bytes = bits / 8;
  const frameBytes = bytes * channels;
  const frames = Math.floor(data.size / frameBytes);
  const out = new Float32Array(frames);
  const read = (p) => {
    if (isFloat) return bits === 32 ? buf.readFloatLE(p) : buf.readDoubleLE(p);
    if (bits === 8) return (buf[p] - 128) / 128;
    if (bits === 16) return buf.readInt16LE(p) / 32768;
    if (bits === 24) return buf.readIntLE(p, 3) / 8388608;
    return buf.readInt32LE(p) / 2147483648;
  };
  for (let i = 0; i < frames; i += 1) {
    const base = data.off + i * frameBytes;
    let v = 0;
    for (let c = 0; c < channels; c += 1) v += read(base + c * bytes);
    out[i] = v / channels;
  }
  return { rate, channels, bits, format: isFloat ? 'float' : 'pcm', samples: out, durationS: frames / rate };
}

/**
 * Encode mono float samples as a 16-bit PCM WAV.
 * @param {Float32Array|number[]} samples in [-1, 1]
 * @param {number} rate
 * @returns {Buffer}
 */
function writeWav(samples, rate) {
  const n = samples.length;
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
  for (let i = 0; i < n; i += 1) {
    let s = samples[i];
    if (!(s === s)) s = 0;
    s = Math.max(-1, Math.min(1, s));
    b.writeInt16LE(s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), 44 + i * 2);
  }
  return b;
}

function dbfs(x) {
  return 20 * Math.log10(Math.max(x, 1e-9));
}

function round(x, d = 2) {
  if (x == null || !Number.isFinite(x)) return x;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** RMS of each 20 ms frame. */
function frameLevels(samples, rate) {
  const size = Math.max(1, Math.round(rate * FRAME_S));
  const n = Math.floor(samples.length / size);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f += 1) {
    let sum = 0;
    const base = f * size;
    for (let i = 0; i < size; i += 1) {
      const x = samples[base + i];
      sum += x * x;
    }
    out[f] = Math.sqrt(sum / size);
  }
  return { size, levels: out };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/** In-place iterative radix-2 FFT (re, im of length 2^k). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Share (percent) of spectral energy between lo and hi Hz, over the given frames.
 * @param {Float32Array} samples
 * @param {number} rate
 * @param {number[]} starts sample offsets of the frames to analyse
 * @param {{lo?:number, hi?:number}} [band]
 * @returns {number|null} null when there is nothing to analyse
 */
function bandShare(samples, rate, starts, { lo = 4000, hi = 8000 } = {}) {
  let n = 256;
  while (n < rate * FRAME_S) n <<= 1;
  const win = new Float64Array(n);
  for (let i = 0; i < n; i += 1) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let total = 0;
  let inBand = 0;
  let used = 0;
  const step = Math.max(1, Math.ceil(starts.length / MAX_FFT_FRAMES));
  for (let s = 0; s < starts.length; s += step) {
    const start = Math.min(starts[s], samples.length - n);
    if (start < 0) break;
    for (let i = 0; i < n; i += 1) {
      re[i] = samples[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k <= n / 2; k += 1) {
      const f = (k * rate) / n;
      if (f < 50) continue;
      const p = re[k] * re[k] + im[k] * im[k];
      total += p;
      if (f >= lo && f < hi) inBand += p;
    }
    used += 1;
  }
  if (!used || total <= 0) return null;
  return (inBand / total) * 100;
}

/**
 * Measure a recording.
 * @param {{rate:number, samples:Float32Array}} audio mono
 * @returns {{durationS:number, voicedS:number, speechDbfs:number, noiseDbfs:number, snrDb:number,
 *   clipPct:number, peakDbfs:number, bandPct:number|null, threshold:number}}
 */
function analyse({ rate, samples }) {
  if (!(rate > 0) || !samples) throw new Error('analyse: rate and samples are required');
  const durationS = samples.length / rate;
  const { size, levels } = frameLevels(samples, rate);
  const sorted = Array.from(levels).sort((a, b) => a - b);
  const noise = Math.max(percentile(sorted, 0.1), NOISE_FLOOR);
  const speech = Math.max(percentile(sorted, 0.9), NOISE_FLOOR);
  const threshold = Math.max(noise * 3.16, MIN_VOICED_THRESHOLD);
  const voicedStarts = [];
  for (let f = 0; f < levels.length; f += 1) if (levels[f] >= threshold) voicedStarts.push(f * size);
  let clipped = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a >= CLIP_LEVEL) clipped += 1;
  }
  const band = voicedStarts.length ? bandShare(samples, rate, voicedStarts) : null;
  return {
    durationS: round(durationS, 3),
    voicedS: round(voicedStarts.length * FRAME_S, 2),
    speechDbfs: round(dbfs(speech), 1),
    noiseDbfs: round(dbfs(noise), 1),
    snrDb: round(Math.min(99, dbfs(speech) - dbfs(noise)), 1),
    clipPct: round(samples.length ? (clipped / samples.length) * 100 : 0, 4),
    peakDbfs: round(dbfs(peak), 1),
    bandPct: band == null ? null : round(band, 3),
    threshold,
  };
}

/**
 * The verdict for one take (§2.4 table).
 * @param {object} a analyse() result
 * @param {'line'|'consent'|string} [kind]
 * @returns {{ok:boolean, problems:Array<{code:string, level:'fail'|'warn', hint:string}>}}
 */
function verdict(a, kind = 'line') {
  const t = THRESHOLDS;
  const problems = [];
  const add = (code, level) => problems.push({ code, level, hint: HINTS[code] });
  if ((kind === 'line' || kind === 'consent') && !(a.voicedS >= t.minVoicedS)) add('too_short', 'fail');
  if (a.speechDbfs < t.speechFailDbfs) add('too_quiet', 'fail');
  else if (a.speechDbfs < t.speechWarnDbfs) add('too_quiet', 'warn');
  if (a.clipPct > t.clipFailPct) add('clipping', 'fail');
  else if (a.clipPct > t.clipWarnPct) add('clipping', 'warn');
  if (a.snrDb < t.snrFailDb) add('noisy', 'fail');
  else if (a.snrDb < t.snrWarnDb) add('noisy', 'warn');
  if (a.bandPct != null && a.bandPct < t.bandFailPct) add('narrowband', 'fail');
  return { ok: !problems.some((p) => p.level === 'fail'), problems };
}

/**
 * The whole-session check: at least 45 s of voiced speech over the accepted takes.
 * @param {Array<{analysis:{voicedS:number}}>} takes
 * @returns {{ok:boolean, voicedS:number, needS:number}}
 */
function sessionVerdict(takes, needS = LIMITS.sessionVoicedSeconds) {
  const voicedS = round((takes || []).reduce((s, t) => s + ((t && t.analysis && t.analysis.voicedS) || 0), 0), 2);
  return { ok: voicedS >= needS, voicedS, needS };
}

/**
 * Cut leading and trailing silence, keeping `keepMs` before the first and after the last voiced frame.
 * @param {Float32Array} samples
 * @param {number} rate
 * @param {{keepMs?:number, threshold?:number}} [opts] threshold defaults to the clip's voiced threshold
 * @returns {Float32Array}
 */
function trimSilence(samples, rate, { keepMs = 150, threshold } = {}) {
  const { size, levels } = frameLevels(samples, rate);
  const th = threshold || analyse({ rate, samples }).threshold;
  let first = -1;
  let last = -1;
  for (let f = 0; f < levels.length; f += 1) {
    if (levels[f] >= th) {
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return new Float32Array(0);
  const keep = Math.round((keepMs / 1000) * rate);
  const start = Math.max(0, first * size - keep);
  const end = Math.min(samples.length, (last + 1) * size + keep);
  return samples.slice(start, end);
}

/**
 * Pick the takes for the reference clip: the best (highest SNR, warnings last) passing takes adding
 * up to 10–15 s, 3–4 of them when they fit, in reading order.
 * @param {Array<{index:number, analysis:object, problems?:Array, trimmedS?:number}>} takes
 * @param {{minS?:number, maxS?:number, maxTakes?:number}} [opts]
 * @returns {Array} the chosen takes
 */
function selectReferenceTakes(takes, { minS = 10, maxS = 15, maxTakes = 4 } = {}) {
  const lenOf = (t) => (t.trimmedS != null ? t.trimmedS : t.analysis.durationS);
  const warned = (t) => (t.problems || []).some((p) => p.level === 'warn');
  const ranked = (takes || [])
    .filter((t) => t && t.analysis)
    .slice()
    .sort((a, b) => Number(warned(a)) - Number(warned(b)) || b.analysis.snrDb - a.analysis.snrDb || a.index - b.index);
  const chosen = [];
  let total = 0;
  for (const t of ranked) {
    // Enough once 10 s are reached with 3 takes (fewer when a third would not fit in 15 s).
    if (chosen.length >= maxTakes || (total >= minS && chosen.length >= 3)) break;
    const len = lenOf(t);
    if (total + len > maxS && chosen.length) continue;
    chosen.push(t);
    total += len;
  }
  return chosen.sort((a, b) => a.index - b.index);
}

/**
 * Join clips with gaps and normalize to a target RMS with a peak limit.
 * @param {Float32Array[]} clips same rate
 * @param {number} rate
 * @param {{gapMs?:number, targetDbfs?:number, peakDbfs?:number}} [opts]
 * @returns {Float32Array}
 */
function joinAndNormalize(clips, rate, { gapMs = 250, targetDbfs = -20, peakDbfs = -1 } = {}) {
  const gap = Math.round((gapMs / 1000) * rate);
  const total = clips.reduce((s, c) => s + c.length, 0) + gap * Math.max(0, clips.length - 1);
  const out = new Float32Array(total);
  let off = 0;
  clips.forEach((c, i) => {
    if (i) off += gap;
    out.set(c, off);
    off += c.length;
  });
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < out.length; i += 1) {
    sum += out[i] * out[i];
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  const rmsNow = Math.sqrt(sum / Math.max(1, out.length));
  if (rmsNow > 0) {
    let gain = 10 ** (targetDbfs / 20) / rmsNow;
    const peakMax = 10 ** (peakDbfs / 20);
    if (peak * gain > peakMax) gain = peakMax / peak;
    for (let i = 0; i < out.length; i += 1) out[i] *= gain;
  }
  return out;
}

/**
 * Build the reference clip (§2.6) from take audio.
 * @param {Array<{index:number, text:string, samples:Float32Array, rate:number, analysis:object, problems?:Array}>} takes
 * @returns {{samples:Float32Array, rate:number, seconds:number, text:string, takes:number[]}}
 */
function buildReference(takes) {
  if (!takes || !takes.length) throw new Error('No takes to build the reference from');
  const rate = takes[0].rate;
  if (takes.some((t) => t.rate !== rate)) throw new Error('Takes have different sample rates');
  const trimmed = takes.map((t) => {
    const samples = trimSilence(t.samples, t.rate, { threshold: t.analysis.threshold });
    return { ...t, trimmed: samples, trimmedS: samples.length / t.rate };
  });
  const chosen = selectReferenceTakes(trimmed.filter((t) => t.trimmedS > 0));
  if (!chosen.length) throw new Error('No usable speech in the takes');
  const samples = joinAndNormalize(
    chosen.map((t) => t.trimmed),
    rate,
  );
  return {
    samples,
    rate,
    seconds: round(samples.length / rate, 2),
    text: chosen.map((t) => String(t.text || '').trim()).filter(Boolean).join(' '),
    takes: chosen.map((t) => t.index),
  };
}

module.exports = {
  LIMITS,
  THRESHOLDS,
  HINTS,
  VIRTUAL_DEVICE_RE,
  isVirtualDeviceLabel,
  readWav,
  writeWav,
  analyse,
  verdict,
  sessionVerdict,
  bandShare,
  trimSilence,
  selectReferenceTakes,
  joinAndNormalize,
  buildReference,
};
