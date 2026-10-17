/**
 * Microphone capture to 16 kHz mono 16-bit WAV, with a simple energy VAD.
 *
 * Audio is pulled with an AudioWorklet (wav-worklet.js, served as its own
 * file because the CSP blocks Blob-URL modules) or, where worklets are
 * missing, a ScriptProcessorNode. Samples are downsampled as they arrive, so
 * a 60 s recording only keeps ~1.9 MB of 16 kHz floats in memory.
 */

export const TARGET_RATE = 16000;
const CHUNK = 2048;

/**
 * Streaming resampler to a fixed output rate. Downsampling averages every
 * input sample that falls in an output sample's window; upsampling (rare:
 * 8 kHz devices) interpolates linearly.
 */
export class StreamResampler {
  /**
   * @param {number} inRate
   * @param {number} [outRate]
   */
  constructor(inRate, outRate = TARGET_RATE) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error('Sample rates must be positive');
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate;
    this.pos = 0;
    this.edge = this.ratio;
    this.sum = 0;
    this.count = 0;
    this.prev = 0;
    this.next = 0;
  }

  /**
   * @param {Float32Array} input
   * @returns {Float32Array} output samples produced by this chunk
   */
  push(input) {
    if (this.ratio === 1) return Float32Array.from(input);
    const out = [];
    if (this.ratio > 1) {
      for (let i = 0; i < input.length; i += 1) {
        this.sum += input[i];
        this.count += 1;
        this.pos += 1;
        if (this.pos >= this.edge) {
          out.push(this.sum / this.count);
          this.sum = 0;
          this.count = 0;
          this.edge += this.ratio;
        }
      }
    } else {
      for (let i = 0; i < input.length; i += 1) {
        const x = input[i];
        const p = this.pos;
        while (this.next <= p) {
          const frac = this.next - (p - 1);
          out.push(p === 0 ? x : this.prev + (x - this.prev) * frac);
          this.next += this.ratio;
        }
        this.prev = x;
        this.pos += 1;
      }
    }
    return Float32Array.from(out);
  }

  /** @returns {Float32Array} the final partial window, if any */
  flush() {
    if (this.ratio > 1 && this.count > 0) {
      const v = this.sum / this.count;
      this.sum = 0;
      this.count = 0;
      return Float32Array.of(v);
    }
    return new Float32Array(0);
  }
}

/**
 * Downsample a whole buffer (convenience wrapper over StreamResampler).
 * @param {Float32Array} input
 * @param {number} inRate
 * @param {number} [outRate]
 * @returns {Float32Array}
 */
export function resample(input, inRate, outRate = TARGET_RATE) {
  const r = new StreamResampler(inRate, outRate);
  const a = r.push(input);
  const b = r.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Convert float samples in [-1, 1] to signed 16-bit PCM.
 * @param {Float32Array} input
 * @returns {Int16Array}
 */
export function floatTo16BitPCM(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    let s = input[i];
    if (!(s === s)) s = 0; // NaN
    s = Math.max(-1, Math.min(1, s));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/**
 * Build a canonical 44-byte-header PCM WAV file.
 * @param {Int16Array|Float32Array} samples mono samples
 * @param {number} [sampleRate]
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate = TARGET_RATE) {
  const pcm = samples instanceof Int16Array ? samples : floatTo16BitPCM(samples);
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off, s) => {
    for (let i = 0; i < s.length; i += 1) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44, pcm.length).set(pcm);
  if (!littleEndian()) {
    for (let i = 0; i < pcm.length; i += 1) v.setInt16(44 + i * 2, pcm[i], true);
  }
  return buf;
}

let endianCache = null;
function littleEndian() {
  if (endianCache === null) endianCache = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  return endianCache;
}

/**
 * Root-mean-square level of a block of samples.
 * @param {Float32Array} block
 * @returns {number}
 */
export function rms(block) {
  if (!block || !block.length) return 0;
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i];
  return Math.sqrt(sum / block.length);
}

/**
 * Energy-based voice activity detector with an adaptive noise floor.
 * Feed it per-chunk RMS levels and durations; it reports when speech has
 * started and when the speaker has been silent long enough to stop.
 */
export class Vad {
  /**
   * @param {{silenceMs?:number, maxMs?:number, noSpeechMs?:number, threshold?:number}} [opts]
   */
  constructor({ silenceMs = 1200, maxMs = 60000, noSpeechMs = 10000, threshold = 0.012 } = {}) {
    this.silenceMs = silenceMs;
    this.maxMs = maxMs;
    this.noSpeechMs = noSpeechMs;
    this.minThreshold = threshold;
    this.noise = threshold / 3;
    this.elapsedMs = 0;
    this.speech = false;
    this.loudMs = 0;
    this.quietMs = 0;
  }

  get threshold() {
    return Math.max(this.minThreshold, this.noise * 3);
  }

  /**
   * @param {number} level RMS of the chunk
   * @param {number} ms chunk duration
   * @returns {null|'silence'|'max'|'nospeech'} a stop reason, or null to keep going
   */
  update(level, ms) {
    this.elapsedMs += ms;
    const th = this.threshold;
    if (level > th) {
      this.loudMs += ms;
      this.quietMs = 0;
      if (this.loudMs >= 80) this.speech = true;
    } else {
      this.loudMs = 0;
      if (level < th * 0.7) this.quietMs += ms;
      // Track the room's noise floor only while nobody is talking.
      if (!this.speech || level < th * 0.7) this.noise = this.noise * 0.95 + level * 0.05;
    }
    if (this.elapsedMs >= this.maxMs) return 'max';
    if (this.speech && this.quietMs >= this.silenceMs) return 'silence';
    if (!this.speech && this.noSpeechMs > 0 && this.elapsedMs >= this.noSpeechMs) return 'nospeech';
    return null;
  }
}

function micError(err) {
  const name = (err && err.name) || '';
  let e;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    e = new Error('Microphone access is blocked. Allow the microphone for this page (the icon in the address bar), and on macOS also in System Settings › Privacy & Security › Microphone.');
    e.code = 'not-allowed';
  } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    e = new Error('No microphone was found. Connect one or choose a default input device in your system sound settings.');
    e.code = 'audio-capture';
  } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    e = new Error('The microphone is busy or unavailable. Close other apps that are using it and try again.');
    e.code = 'audio-capture';
  } else {
    e = new Error(`Could not start the microphone: ${(err && err.message) || name || 'unknown error'}`);
    e.code = 'audio-capture';
  }
  e.cause = err;
  return e;
}

/**
 * Records the microphone to a 16 kHz mono WAV Blob.
 */
export class WavRecorder {
  /**
   * @param {{onLevel?:(level:number)=>void, vad?:boolean|{silenceMs?:number, maxMs?:number, noSpeechMs?:number,
   *   threshold?:number, onStop?:(reason:string)=>void}, onAutoStop?:(reason:string)=>void}} [opts]
   *   `vad.onStop` (or `onAutoStop`) is called once with 'silence', 'max' or 'nospeech' when the
   *   recording should end; call stop() from it. With vad false only the 60 s cap applies.
   */
  constructor({ onLevel, vad = true, onAutoStop } = {}) {
    this.onLevel = typeof onLevel === 'function' ? onLevel : null;
    const v = vad && typeof vad === 'object' ? vad : {};
    this.vad = new Vad(vad === false ? { silenceMs: Infinity, noSpeechMs: 0, maxMs: v.maxMs || 60000 } : v);
    this.onAutoStop = typeof v.onStop === 'function' ? v.onStop : typeof onAutoStop === 'function' ? onAutoStop : null;
    this.state = 'idle';
    this.chunks = [];
    this.samples = 0;
    this.autoStopped = false;
    this.startPromise = null;
  }

  /** @returns {boolean} true when this browser can record audio */
  static isSupported() {
    const g = globalThis;
    return Boolean(
      g.navigator && g.navigator.mediaDevices && typeof g.navigator.mediaDevices.getUserMedia === 'function' && (g.AudioContext || g.webkitAudioContext)
    );
  }

  /** @returns {boolean} */
  get recording() {
    return this.state === 'recording' || this.state === 'starting';
  }

  /** @returns {boolean} true once the VAD heard speech */
  get hasSpeech() {
    return this.vad.speech;
  }

  /** @returns {number} recorded duration in ms */
  get durationMs() {
    return this.vad.elapsedMs;
  }

  /** Ask for the microphone and start recording. */
  async start() {
    if (this.state !== 'idle') throw new Error('This recorder was already started');
    this.state = 'starting';
    this.startPromise = this.open();
    try {
      await this.startPromise;
      if (this.state === 'starting') this.state = 'recording';
    } catch (err) {
      this.teardown();
      this.state = 'done';
      throw err;
    }
  }

  /** @private */
  async open() {
    if (!WavRecorder.isSupported()) {
      const e = new Error('This browser cannot record audio (no getUserMedia or Web Audio).');
      e.code = 'unsupported';
      throw e;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      throw micError(err);
    }
    if (this.state !== 'starting') {
      this.teardown();
      return;
    }
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') {
      await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
    }
    this.resampler = new StreamResampler(this.ctx.sampleRate, TARGET_RATE);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    let usedWorklet = false;
    if (this.ctx.audioWorklet && typeof globalThis.AudioWorkletNode === 'function') {
      try {
        await this.ctx.audioWorklet.addModule(new URL('./wav-worklet.js', import.meta.url).href);
        this.node = new AudioWorkletNode(this.ctx, 'anywhere-wav-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { chunkSize: CHUNK },
        });
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
      if (typeof this.ctx.createScriptProcessor !== 'function') {
        const e = new Error('This browser cannot process microphone audio.');
        e.code = 'unsupported';
        throw e;
      }
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
    const out = this.resampler.push(samples);
    if (out.length) {
      this.chunks.push(out);
      this.samples += out.length;
    }
    const level = rms(samples);
    if (this.onLevel) {
      try {
        this.onLevel(Math.min(1, level * 6));
      } catch {
        /* UI callback errors must not break recording */
      }
    }
    if (this.state === 'stopping' || this.autoStopped) return;
    const reason = this.vad.update(level, (samples.length / this.ctx.sampleRate) * 1000);
    if (reason) {
      this.autoStopped = true;
      this.stopReason = reason;
      if (this.onAutoStop) {
        setTimeout(() => {
          try {
            this.onAutoStop(reason);
          } catch {
            /* ignore */
          }
        }, 0);
      }
    }
  }

  /**
   * Stop recording and return the WAV.
   * @returns {Promise<Blob>} 'audio/wav' blob (possibly with no samples)
   */
  async stop() {
    if (this.state === 'idle') {
      this.state = 'done';
      return new Blob([encodeWav(new Int16Array(0))], { type: 'audio/wav' });
    }
    if (this.state === 'starting') {
      this.state = 'stopping';
      try {
        await this.startPromise;
      } catch {
        /* reported by start() */
      }
    }
    if (this.state === 'done') return this.result || new Blob([encodeWav(new Int16Array(0))], { type: 'audio/wav' });
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
    const all = new Float32Array(this.samples + tail.length);
    let off = 0;
    for (const c of this.chunks) {
      all.set(c, off);
      off += c.length;
    }
    all.set(tail, off);
    this.chunks = [];
    this.state = 'done';
    this.result = new Blob([encodeWav(all, TARGET_RATE)], { type: 'audio/wav' });
    return this.result;
  }

  /** Stop and discard everything. */
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
      /* already disconnected */
    }
    try {
      if (this.source) this.source.disconnect();
    } catch {
      /* already disconnected */
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
    }
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.node = null;
    this.source = null;
    this.stream = null;
    if (this.onLevel) {
      try {
        this.onLevel(0);
      } catch {
        /* ignore */
      }
    }
  }
}
