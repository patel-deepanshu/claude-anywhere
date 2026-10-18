/**
 * AudioWorklet processor for WavRecorder: mixes the input to mono and posts
 * fixed-size Float32 chunks to the main thread. Loaded by URL (not a Blob)
 * so it works under the dialog's script-src 'self' CSP.
 */
/* global AudioWorkletProcessor, registerProcessor */

class AnywhereWavCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = (options && options.processorOptions && options.processorOptions.chunkSize) || 2048;
    this.size = Math.max(128, Math.min(16384, size | 0));
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'flush') {
        const rest = this.buf.slice(0, this.n);
        this.n = 0;
        this.port.postMessage({ type: 'flushed', samples: rest }, [rest.buffer]);
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length && input[0]) {
      const channels = input.length;
      const len = input[0].length;
      for (let i = 0; i < len; i += 1) {
        let v = 0;
        for (let c = 0; c < channels; c += 1) v += input[c][i];
        this.buf[this.n] = v / channels;
        this.n += 1;
        if (this.n === this.size) {
          const full = this.buf;
          this.port.postMessage({ type: 'chunk', samples: full }, [full.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('anywhere-wav-capture', AnywhereWavCapture);
