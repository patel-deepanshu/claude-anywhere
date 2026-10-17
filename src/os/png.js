'use strict';

/**
 * Minimal, fast PNG codec and image helpers in pure JavaScript (zlib only).
 *
 * Images are plain objects `{ width, height, data }` where `data` is a
 * Uint8Array of RGBA bytes (row-major, 4 bytes per pixel, no padding).
 */

const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 1 GiB of RGBA output is far beyond any real screen; refuse instead of OOMing.
const MAX_PIXELS = 0x10000000;

// Valid bit depths per color type (PNG spec, table 11.1).
const VALID_DEPTHS = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Adam7: [xStart, yStart, xStep, yStep] per pass.
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

/**
 * CRC-32 (IEEE) of a byte array, optionally continuing from a previous value.
 * @param {Uint8Array} buf
 * @param {number} [prev]
 * @returns {number} unsigned 32-bit CRC
 */
function crc32(buf, prev = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, prev) >>> 0;
  const table = crcTable();
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new TypeError('PNG: expected a Buffer or Uint8Array');
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof Uint8ClampedArray) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data);
  throw new TypeError('image.data must be a Uint8Array of RGBA bytes');
}

function checkDims(width, height, what) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`${what}: width and height must be positive integers (got ${width}x${height})`);
  }
  if (width * height > MAX_PIXELS) {
    throw new RangeError(`${what}: ${width}x${height} is too large`);
  }
}

/**
 * Read the IHDR of a PNG without decoding pixels.
 * @param {Buffer|Uint8Array} buffer
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,interlace:number}}
 */
function readHeader(buffer) {
  const buf = toBuffer(buffer);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('PNG: invalid signature (not a PNG image)');
  }
  if (buf.toString('latin1', 12, 16) !== 'IHDR' || buf.readUInt32BE(8) !== 13) {
    throw new Error('PNG: first chunk is not a valid IHDR');
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

/** Reverse the per-row filters of one (sub)image in place. */
function unfilter(raw, offset, rows, rowBytes, bpp) {
  const stride = rowBytes + 1;
  for (let y = 0; y < rows; y++) {
    const fpos = offset + y * stride;
    const ft = raw[fpos];
    const p = fpos + 1;
    const q = p - stride;
    const hasPrev = y > 0;
    switch (ft) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < rowBytes; i++) raw[p + i] += raw[p + i - bpp];
        break;
      case 2:
        if (hasPrev) for (let i = 0; i < rowBytes; i++) raw[p + i] += raw[q + i];
        break;
      case 3:
        if (hasPrev) {
          for (let i = 0; i < bpp; i++) raw[p + i] += raw[q + i] >> 1;
          for (let i = bpp; i < rowBytes; i++) raw[p + i] += (raw[p + i - bpp] + raw[q + i]) >> 1;
        } else {
          for (let i = bpp; i < rowBytes; i++) raw[p + i] += raw[p + i - bpp] >> 1;
        }
        break;
      case 4:
        if (hasPrev) {
          for (let i = 0; i < bpp; i++) raw[p + i] += raw[q + i];
          for (let i = bpp; i < rowBytes; i++) {
            const a = raw[p + i - bpp];
            const b = raw[q + i];
            const c = raw[q + i - bpp];
            const pa = b > c ? b - c : c - b;
            const pb = a > c ? a - c : c - a;
            const s = a + b - c - c;
            const pc = s < 0 ? -s : s;
            raw[p + i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          }
        } else {
          for (let i = bpp; i < rowBytes; i++) raw[p + i] += raw[p + i - bpp];
        }
        break;
      default:
        throw new Error(`PNG: invalid filter type ${ft} on row ${y}`);
    }
  }
}

/**
 * Convert `n` pixels of one unfiltered row starting at raw[src] into RGBA,
 * writing to out[dst], out[dst + dstStep], ...
 */
function writeRow(fmt, raw, src, n, out, dst, dstStep) {
  const { colorType, depth } = fmt;
  if (colorType === 6) {
    if (depth === 8) {
      if (dstStep === 4) {
        out.set(raw.subarray(src, src + n * 4), dst);
        return;
      }
      for (let i = 0; i < n; i++, src += 4, dst += dstStep) {
        out[dst] = raw[src];
        out[dst + 1] = raw[src + 1];
        out[dst + 2] = raw[src + 2];
        out[dst + 3] = raw[src + 3];
      }
    } else {
      for (let i = 0; i < n; i++, src += 8, dst += dstStep) {
        out[dst] = raw[src];
        out[dst + 1] = raw[src + 2];
        out[dst + 2] = raw[src + 4];
        out[dst + 3] = raw[src + 6];
      }
    }
    return;
  }
  if (colorType === 2) {
    const t = fmt.trnsRGB;
    if (depth === 8) {
      for (let i = 0; i < n; i++, src += 3, dst += dstStep) {
        const r = raw[src];
        const g = raw[src + 1];
        const b = raw[src + 2];
        out[dst] = r;
        out[dst + 1] = g;
        out[dst + 2] = b;
        out[dst + 3] = t && r === t[0] && g === t[1] && b === t[2] ? 0 : 255;
      }
    } else {
      for (let i = 0; i < n; i++, src += 6, dst += dstStep) {
        out[dst] = raw[src];
        out[dst + 1] = raw[src + 2];
        out[dst + 2] = raw[src + 4];
        let a = 255;
        if (t) {
          const r = (raw[src] << 8) | raw[src + 1];
          const g = (raw[src + 2] << 8) | raw[src + 3];
          const b = (raw[src + 4] << 8) | raw[src + 5];
          if (r === t[0] && g === t[1] && b === t[2]) a = 0;
        }
        out[dst + 3] = a;
      }
    }
    return;
  }
  if (colorType === 4) {
    const step = depth === 8 ? 2 : 4;
    const aOff = depth === 8 ? 1 : 2;
    for (let i = 0; i < n; i++, src += step, dst += dstStep) {
      const v = raw[src];
      out[dst] = v;
      out[dst + 1] = v;
      out[dst + 2] = v;
      out[dst + 3] = raw[src + aOff];
    }
    return;
  }
  if (colorType === 0 && depth === 16) {
    const t = fmt.trnsGray;
    for (let i = 0; i < n; i++, src += 2, dst += dstStep) {
      const v = raw[src];
      out[dst] = v;
      out[dst + 1] = v;
      out[dst + 2] = v;
      out[dst + 3] = t >= 0 && ((v << 8) | raw[src + 1]) === t ? 0 : 255;
    }
    return;
  }
  // Gray (<= 8 bit) and palette: look samples up in a prebuilt RGBA table.
  const lut = fmt.lut;
  if (depth === 8) {
    for (let i = 0; i < n; i++, dst += dstStep) {
      const k = raw[src + i] << 2;
      out[dst] = lut[k];
      out[dst + 1] = lut[k + 1];
      out[dst + 2] = lut[k + 2];
      out[dst + 3] = lut[k + 3];
    }
    return;
  }
  const mask = (1 << depth) - 1;
  for (let i = 0, bit = 0; i < n; i++, bit += depth, dst += dstStep) {
    const byte = raw[src + (bit >> 3)];
    const k = ((byte >> (8 - depth - (bit & 7))) & mask) << 2;
    out[dst] = lut[k];
    out[dst + 1] = lut[k + 1];
    out[dst + 2] = lut[k + 2];
    out[dst + 3] = lut[k + 3];
  }
}

function buildLut(colorType, depth, palette, trns) {
  const lut = new Uint8Array(256 * 4);
  if (colorType === 3) {
    for (let i = 0; i < 256; i++) lut[i * 4 + 3] = 255;
    if (palette) {
      const entries = Math.min(256, Math.floor(palette.length / 3));
      for (let i = 0; i < entries; i++) {
        lut[i * 4] = palette[i * 3];
        lut[i * 4 + 1] = palette[i * 3 + 1];
        lut[i * 4 + 2] = palette[i * 3 + 2];
      }
    }
    if (trns) for (let i = 0; i < Math.min(256, trns.length); i++) lut[i * 4 + 3] = trns[i];
    return lut;
  }
  // grayscale, depth 1/2/4/8
  const max = (1 << depth) - 1;
  const tval = trns && trns.length >= 2 ? ((trns[0] << 8) | trns[1]) & max : -1;
  for (let v = 0; v <= max; v++) {
    const g = Math.round((v * 255) / max);
    lut[v * 4] = g;
    lut[v * 4 + 1] = g;
    lut[v * 4 + 2] = g;
    lut[v * 4 + 3] = v === tval ? 0 : 255;
  }
  return lut;
}

/**
 * Decode a PNG into 8-bit RGBA. Supports color types 0, 2, 3, 4, 6, bit depths
 * 1/2/4/8/16 (16 is reduced to 8), all filters and Adam7 interlacing.
 * @param {Buffer|Uint8Array} buffer
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
function decode(buffer) {
  const buf = toBuffer(buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('PNG: invalid signature (not a PNG image)');
  }
  let pos = 8;
  let hdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + len;
    if (len > 0x7fffffff) throw new Error(`PNG: invalid length for ${type} chunk`);
    if (end > buf.length) {
      // Truncated file: keep whatever image data is there and let inflate decide.
      if (type === 'IDAT') idat.push(buf.subarray(start));
      break;
    }
    if (type === 'IHDR') {
      if (len !== 13) throw new Error('PNG: bad IHDR length');
      if (end + 4 <= buf.length) {
        const want = buf.readUInt32BE(end);
        if (crc32(buf.subarray(pos + 4, end)) !== want) throw new Error('PNG: IHDR checksum mismatch (corrupt file)');
      }
      hdr = {
        width: buf.readUInt32BE(start),
        height: buf.readUInt32BE(start + 4),
        depth: buf[start + 8],
        colorType: buf[start + 9],
        compression: buf[start + 10],
        filter: buf[start + 11],
        interlace: buf[start + 12],
      };
    } else if (!hdr) {
      throw new Error('PNG: first chunk must be IHDR');
    } else if (type === 'PLTE') {
      palette = buf.subarray(start, end);
    } else if (type === 'tRNS') {
      trns = buf.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    pos = end + 4;
  }
  if (!hdr) throw new Error('PNG: missing IHDR chunk');
  const { width, height, depth, colorType, interlace } = hdr;
  checkDims(width, height, 'PNG');
  if (!VALID_DEPTHS[colorType]) throw new Error(`PNG: unsupported color type ${colorType}`);
  if (!VALID_DEPTHS[colorType].includes(depth)) {
    throw new Error(`PNG: invalid bit depth ${depth} for color type ${colorType}`);
  }
  if (hdr.compression !== 0 || hdr.filter !== 0) throw new Error('PNG: unknown compression or filter method');
  if (interlace > 1) throw new Error(`PNG: unknown interlace method ${interlace}`);
  if (colorType === 3 && !palette) throw new Error('PNG: palette image without PLTE chunk');
  if (!idat.length) throw new Error('PNG: no image data (IDAT)');

  let raw;
  try {
    raw = zlib.inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
  } catch (err) {
    throw new Error(`PNG: corrupt image data (${err.message})`);
  }

  const bitsPP = CHANNELS[colorType] * depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const rowBytesOf = (w) => Math.ceil((w * bitsPP) / 8);
  const fmt = { colorType, depth, lut: null, trnsGray: -1, trnsRGB: null };
  if (colorType === 3 || (colorType === 0 && depth <= 8)) fmt.lut = buildLut(colorType, depth, palette, trns);
  if (colorType === 0 && depth === 16 && trns && trns.length >= 2) fmt.trnsGray = (trns[0] << 8) | trns[1];
  if (colorType === 2 && trns && trns.length >= 6) {
    fmt.trnsRGB =
      depth === 8
        ? [trns[1], trns[3], trns[5]]
        : [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]];
  }

  const out = new Uint8Array(width * height * 4);
  if (interlace === 0) {
    const rb = rowBytesOf(width);
    if (raw.length < height * (rb + 1)) throw new Error('PNG: image data is truncated');
    unfilter(raw, 0, height, rb, bpp);
    for (let y = 0; y < height; y++) {
      writeRow(fmt, raw, y * (rb + 1) + 1, width, out, y * width * 4, 4);
    }
  } else {
    let offset = 0;
    for (const [x0, y0, dx, dy] of ADAM7) {
      const pw = width > x0 ? Math.ceil((width - x0) / dx) : 0;
      const ph = height > y0 ? Math.ceil((height - y0) / dy) : 0;
      if (!pw || !ph) continue;
      const rb = rowBytesOf(pw);
      if (raw.length < offset + ph * (rb + 1)) throw new Error('PNG: interlaced image data is truncated');
      unfilter(raw, offset, ph, rb, bpp);
      for (let y = 0; y < ph; y++) {
        writeRow(fmt, raw, offset + y * (rb + 1) + 1, pw, out, ((y0 + y * dy) * width + x0) * 4, dx * 4);
      }
      offset += ph * (rb + 1);
    }
  }
  return { width, height, data: out };
}

function makeChunk(type, data) {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  if (data.length) out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode an RGBA image as an 8-bit RGBA PNG. The filter for each row is the
 * one with the smallest sum of absolute (signed) residuals.
 * @param {{width:number,height:number,data:Uint8Array}} img
 * @param {{level?:number}} [opts] zlib level (default 6)
 * @returns {Buffer}
 */
function encode(img, opts = {}) {
  if (!img || typeof img !== 'object') throw new TypeError('encode: expected {width, height, data}');
  const { width, height } = img;
  checkDims(width, height, 'encode');
  const data = toBytes(img.data);
  const rowBytes = width * 4;
  if (data.length < rowBytes * height) {
    throw new RangeError(`encode: data has ${data.length} bytes, expected ${rowBytes * height} for ${width}x${height} RGBA`);
  }
  const stride = rowBytes + 1;
  const filtered = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    const p = y * rowBytes;
    const q = p - rowBytes;
    const o = y * stride;
    let best = 0;
    if (y === 0) {
      // Only None and Sub make sense without a previous row (Up = None, Avg/Paeth ~ Sub).
      let s0 = 0;
      let s1 = 0;
      for (let i = 0; i < rowBytes; i++) {
        const x = data[p + i];
        s0 += x < 128 ? x : 256 - x;
        const d = (x - (i >= 4 ? data[p + i - 4] : 0)) & 255;
        s1 += d < 128 ? d : 256 - d;
      }
      best = s1 < s0 ? 1 : 0;
    } else {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      let s4 = 0;
      // First pixel: no left neighbour, so Sub = None and Paeth predicts "up".
      for (let i = 0; i < 4; i++) {
        const x = data[p + i];
        const b = data[q + i];
        const n = x < 128 ? x : 256 - x;
        s0 += n;
        s1 += n;
        let d = (x - b) & 255;
        const up = d < 128 ? d : 256 - d;
        s2 += up;
        s4 += up;
        d = (x - (b >> 1)) & 255;
        s3 += d < 128 ? d : 256 - d;
      }
      for (let i = 4; i < rowBytes; i++) {
        const x = data[p + i];
        const a = data[p + i - 4];
        const b = data[q + i];
        const c = data[q + i - 4];
        let d = x;
        s0 += d < 128 ? d : 256 - d;
        d = (x - a) & 255;
        s1 += d < 128 ? d : 256 - d;
        d = (x - b) & 255;
        s2 += d < 128 ? d : 256 - d;
        d = (x - ((a + b) >> 1)) & 255;
        s3 += d < 128 ? d : 256 - d;
        const pa = b > c ? b - c : c - b;
        const pb = a > c ? a - c : c - a;
        const sp = a + b - c - c;
        const pc = sp < 0 ? -sp : sp;
        d = (x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
        s4 += d < 128 ? d : 256 - d;
      }
      let min = s0;
      if (s1 < min) {
        min = s1;
        best = 1;
      }
      if (s2 < min) {
        min = s2;
        best = 2;
      }
      if (s3 < min) {
        min = s3;
        best = 3;
      }
      if (s4 < min) best = 4;
    }
    filtered[o] = best;
    const t = o + 1;
    switch (best) {
      case 0:
        filtered.set(data.subarray(p, p + rowBytes), t);
        break;
      case 1:
        for (let i = 0; i < 4; i++) filtered[t + i] = data[p + i];
        for (let i = 4; i < rowBytes; i++) filtered[t + i] = data[p + i] - data[p + i - 4];
        break;
      case 2:
        for (let i = 0; i < rowBytes; i++) filtered[t + i] = data[p + i] - data[q + i];
        break;
      case 3:
        for (let i = 0; i < 4; i++) filtered[t + i] = data[p + i] - (data[q + i] >> 1);
        for (let i = 4; i < rowBytes; i++) filtered[t + i] = data[p + i] - ((data[p + i - 4] + data[q + i]) >> 1);
        break;
      default:
        for (let i = 0; i < 4; i++) filtered[t + i] = data[p + i] - data[q + i];
        for (let i = 4; i < rowBytes; i++) {
          const a = data[p + i - 4];
          const b = data[q + i];
          const c = data[q + i - 4];
          const pa = b > c ? b - c : c - b;
          const pb = a > c ? a - c : c - a;
          const sp = a + b - c - c;
          const pc = sp < 0 ? -sp : sp;
          filtered[t + i] = data[p + i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
    }
  }
  const level = Number.isInteger(opts.level) ? Math.max(0, Math.min(9, opts.level)) : 6;
  const compressed = zlib.deflateSync(filtered, { level });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([SIGNATURE, makeChunk('IHDR', ihdr), makeChunk('IDAT', compressed), makeChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Per-axis resampling weights: area-average when shrinking, bilinear when
 * enlarging, identity when equal.
 */
function contributions(src, dst) {
  const start = new Int32Array(dst);
  const count = new Int32Array(dst);
  const idx = [];
  const wts = [];
  if (dst === src) {
    for (let i = 0; i < dst; i++) {
      start[i] = i;
      count[i] = 1;
      idx.push(i);
      wts.push(1);
    }
  } else if (dst < src) {
    const scale = src / dst;
    for (let i = 0; i < dst; i++) {
      const s0 = i * scale;
      const s1 = Math.min(src, s0 + scale);
      const j0 = Math.floor(s0);
      const j1 = Math.min(src, Math.ceil(s1 - 1e-9));
      start[i] = idx.length;
      let total = 0;
      for (let j = j0; j < j1; j++) {
        const w = Math.min(s1, j + 1) - Math.max(s0, j);
        if (w <= 1e-9) continue;
        idx.push(j);
        wts.push(w);
        total += w;
      }
      count[i] = idx.length - start[i];
      for (let k = start[i]; k < idx.length; k++) wts[k] /= total;
    }
  } else {
    const ratio = src / dst;
    for (let i = 0; i < dst; i++) {
      let s = (i + 0.5) * ratio - 0.5;
      if (s < 0) s = 0;
      let j = Math.floor(s);
      let t = s - j;
      if (j >= src - 1) {
        j = src - 1;
        t = 0;
      }
      start[i] = idx.length;
      idx.push(j);
      wts.push(1 - t);
      if (t > 0) {
        idx.push(j + 1);
        wts.push(t);
      }
      count[i] = idx.length - start[i];
    }
  }
  return { start, count, index: Int32Array.from(idx), weight: Float32Array.from(wts) };
}

/**
 * Resize an RGBA image. Downscaling uses an exact area-average (box) filter,
 * correct for non-integer ratios; upscaling uses bilinear interpolation. Alpha
 * is premultiplied during filtering so transparent pixels never bleed color.
 * @param {{width:number,height:number,data:Uint8Array}} img
 * @param {number} newW
 * @param {number} newH
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
function resize(img, newW, newH) {
  const { width: sw, height: sh } = img;
  checkDims(sw, sh, 'resize');
  checkDims(newW, newH, 'resize');
  const data = toBytes(img.data);
  if (data.length < sw * sh * 4) throw new RangeError('resize: image data is shorter than width*height*4');
  if (newW === sw && newH === sh) return { width: sw, height: sh, data: new Uint8Array(data.subarray(0, sw * sh * 4)) };

  const cx = contributions(sw, newW);
  const cy = contributions(sh, newH);

  // Horizontal pass into premultiplied float rows (only the source rows the
  // vertical pass will read are computed).
  const rowLen = newW * 4;
  const tmp = new Float32Array(rowLen * sh);
  const needed = new Uint8Array(sh);
  for (let k = 0; k < cy.index.length; k++) needed[cy.index[k]] = 1;
  const { start: hs, count: hc, index: hi, weight: hw } = cx;
  for (let y = 0; y < sh; y++) {
    if (!needed[y]) continue;
    const rowIn = y * sw * 4;
    let o = y * rowLen;
    for (let x = 0; x < newW; x++, o += 4) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const e = hs[x] + hc[x];
      for (let k = hs[x]; k < e; k++) {
        const p = rowIn + hi[k] * 4;
        const wa = hw[k] * data[p + 3];
        r += data[p] * wa;
        g += data[p + 1] * wa;
        b += data[p + 2] * wa;
        a += wa;
      }
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }

  // Vertical pass, row-at-a-time for cache friendliness.
  const out = new Uint8Array(newW * newH * 4);
  const acc = new Float32Array(rowLen);
  const { start: vs, count: vc, index: vi, weight: vw } = cy;
  for (let y = 0; y < newH; y++) {
    acc.fill(0);
    const e = vs[y] + vc[y];
    for (let k = vs[y]; k < e; k++) {
      const w = vw[k];
      const base = vi[k] * rowLen;
      for (let i = 0; i < rowLen; i++) acc[i] += tmp[base + i] * w;
    }
    let o = y * rowLen;
    for (let i = 0; i < rowLen; i += 4, o += 4) {
      const a = acc[i + 3];
      if (a <= 1e-6) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
        continue;
      }
      const inv = 1 / a;
      const r = acc[i] * inv + 0.5;
      const g = acc[i + 1] * inv + 0.5;
      const b = acc[i + 2] * inv + 0.5;
      const al = a + 0.5;
      out[o] = r >= 255 ? 255 : r;
      out[o + 1] = g >= 255 ? 255 : g;
      out[o + 2] = b >= 255 ? 255 : b;
      out[o + 3] = al >= 255 ? 255 : al;
    }
  }
  return { width: newW, height: newH, data: out };
}

/**
 * Copy a rectangle out of an image. The rectangle is rounded to whole pixels
 * and clipped to the image; an empty result throws a RangeError.
 * @returns {{width:number,height:number,data:Uint8Array}}
 */
function crop(img, x, y, w, h) {
  const { width, height } = img;
  checkDims(width, height, 'crop');
  const data = toBytes(img.data);
  const vals = [x, y, w, h].map(Number);
  if (!vals.every(Number.isFinite)) throw new TypeError('crop: x, y, width and height must be numbers');
  let x0 = Math.round(vals[0]);
  let y0 = Math.round(vals[1]);
  let x1 = x0 + Math.round(vals[2]);
  let y1 = y0 + Math.round(vals[3]);
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(width, x1);
  y1 = Math.min(height, y1);
  if (x1 <= x0 || y1 <= y0) {
    throw new RangeError(`crop: rectangle ${x},${y} ${w}x${h} is outside the ${width}x${height} image`);
  }
  const cw = x1 - x0;
  const ch = y1 - y0;
  const out = new Uint8Array(cw * ch * 4);
  for (let r = 0; r < ch; r++) {
    const s = ((y0 + r) * width + x0) * 4;
    out.set(data.subarray(s, s + cw * 4), r * cw * 4);
  }
  return { width: cw, height: ch, data: out };
}

/**
 * Largest size with the same aspect ratio that fits in maxW x maxH. Never
 * upscales. Missing or non-positive limits mean "no limit".
 * @returns {{width:number,height:number,scale:number}} scale = new/original (<= 1)
 */
function fitWithin(w, h, maxW, maxH) {
  if (!(w > 0) || !(h > 0)) throw new RangeError(`fitWithin: invalid size ${w}x${h}`);
  const mw = Number(maxW) > 0 ? Number(maxW) : Infinity;
  const mh = Number(maxH) > 0 ? Number(maxH) : Infinity;
  const scale = Math.min(1, mw / w, mh / h);
  if (scale >= 1) return { width: w, height: h, scale: 1 };
  const width = Math.max(1, Math.min(Math.floor(mw), Math.round(w * scale)));
  const height = Math.max(1, Math.min(Math.floor(mh), Math.round(h * scale)));
  return { width, height, scale };
}

module.exports = { decode, encode, resize, crop, fitWithin, readHeader, crc32, SIGNATURE };
