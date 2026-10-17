'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const png = require('../src/os/png');

function makeImage(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = fn(x, y);
      data.set(px, (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

function pixel(img, x, y) {
  const o = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(o, o + 4));
}

// Hand-rolled PNG writer for arbitrary color types/depths/filters (reference for the decoder).
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(png.crc32(td));
  return Buffer.concat([len, td, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** rows: array of Uint8Array raw (unfiltered) scanlines; filters: filter type per row. */
function rawPng({ width, height, colorType, depth, rows, filters, palette, trns }) {
  const bpp = Math.max(1, ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] * depth) >> 3);
  const out = [];
  let prev = null;
  rows.forEach((row, y) => {
    const ft = filters[y % filters.length];
    const f = Buffer.alloc(row.length + 1);
    f[0] = ft;
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][ft];
      f[i + 1] = (row[i] - pred) & 255;
    }
    out.push(f);
    prev = row;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  const parts = [png.SIGNATURE, chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', Buffer.from(palette)));
  if (trns) parts.push(chunk('tRNS', Buffer.from(trns)));
  const z = zlib.deflateSync(Buffer.concat(out));
  // Split image data across two IDAT chunks to exercise concatenation.
  const mid = Math.floor(z.length / 2);
  parts.push(chunk('IDAT', z.subarray(0, mid)), chunk('IDAT', z.subarray(mid)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

test('encode/decode round trip preserves every RGBA byte', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
  const img = makeImage(53, 31, (x, y) => [(x * 5) & 255, (y * 9) & 255, rnd(), (x + y) % 3 === 0 ? 255 : rnd()]);
  const buf = png.encode(img);
  assert.ok(buf.subarray(0, 8).equals(png.SIGNATURE));
  const back = png.decode(buf);
  assert.equal(back.width, 53);
  assert.equal(back.height, 31);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
  assert.deepEqual(png.readHeader(buf), { width: 53, height: 31, bitDepth: 8, colorType: 6, interlace: 0 });
});

test('crc32: table fallback (Node < 20.15) matches zlib.crc32', (t) => {
  const zl = require('zlib');
  const buf = Buffer.from('IHDR\u0000\u0001 the quick brown fox ✓', 'utf8');
  const want = 0x414fa339; // CRC-32 of "The quick brown fox jumps over the lazy dog"
  const fox = Buffer.from('The quick brown fox jumps over the lazy dog');
  const native = typeof zl.crc32 === 'function' ? zl.crc32 : null;
  const viaNative = png.crc32(buf);
  if (native) {
    zl.crc32 = undefined;
    t.after(() => {
      zl.crc32 = native;
    });
  }
  assert.equal(png.crc32(fox), want);
  assert.equal(png.crc32(buf), viaNative);
  assert.equal(png.crc32(buf.subarray(10), png.crc32(buf.subarray(0, 10))), viaNative);
  // Encoding/decoding still works through the fallback path.
  const img = makeImage(5, 4, (x, y) => [x * 40, y * 50, 7, 255]);
  assert.deepEqual(Array.from(png.decode(png.encode(img)).data), Array.from(img.data));
});

test('encode accepts 1x1 images, Uint8ClampedArray data and validates input', () => {
  const one = png.decode(png.encode({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 4]) }));
  assert.deepEqual(Array.from(one.data), [1, 2, 3, 4]);
  assert.throws(() => png.encode({ width: 2, height: 2, data: new Uint8Array(4) }), /expected 16/);
  assert.throws(() => png.encode({ width: 0, height: 2, data: new Uint8Array(0) }), /positive integers/);
});

test('decode handles every filter type (reference writer)', () => {
  const w = 9;
  const h = 10;
  const rows = [];
  const expected = [];
  for (let y = 0; y < h; y++) {
    const row = new Uint8Array(w * 3);
    for (let x = 0; x < w; x++) {
      row.set([(x * 31 + y * 7) & 255, (x * y * 13) & 255, (255 - x * 20) & 255], x * 3);
      expected.push((x * 31 + y * 7) & 255, (x * y * 13) & 255, (255 - x * 20) & 255, 255);
    }
    rows.push(row);
  }
  const buf = rawPng({ width: w, height: h, colorType: 2, depth: 8, rows, filters: [0, 1, 2, 3, 4, 4, 3, 2, 1, 0] });
  assert.deepEqual(Array.from(png.decode(buf).data), expected);
  // Filters on the first row (no previous scanline) too.
  for (const f of [2, 3, 4]) {
    const one = rawPng({ width: w, height: 1, colorType: 2, depth: 8, rows: [rows[3]], filters: [f] });
    assert.deepEqual(Array.from(png.decode(one).data), expected.slice(3 * w * 4, 4 * w * 4));
  }
});

test('decode: gray 1/2/4/8/16-bit, gray+alpha, palette+tRNS, RGB tRNS, RGBA16', () => {
  // 1-bit gray, 10 px wide (row not byte aligned)
  let buf = rawPng({ width: 10, height: 1, colorType: 0, depth: 1, rows: [Uint8Array.from([0b10110000, 0b01000000])], filters: [0] });
  assert.deepEqual(Array.from(png.decode(buf).data.filter((_, i) => i % 4 === 0)), [255, 0, 255, 255, 0, 0, 0, 0, 0, 255]);
  // 2-bit gray with tRNS on value 1
  buf = rawPng({ width: 4, height: 1, colorType: 0, depth: 2, rows: [Uint8Array.from([0b00011011])], filters: [1], trns: [0, 1] });
  let d = png.decode(buf).data;
  assert.deepEqual(Array.from(d), [0, 0, 0, 255, 85, 85, 85, 0, 170, 170, 170, 255, 255, 255, 255, 255]);
  // 4-bit gray
  buf = rawPng({ width: 3, height: 1, colorType: 0, depth: 4, rows: [Uint8Array.from([0x0f, 0x80])], filters: [0] });
  assert.deepEqual(Array.from(png.decode(buf).data.filter((_, i) => i % 4 === 0)), [0, 255, 136]);
  // 16-bit gray with tRNS 0x1234
  buf = rawPng({ width: 2, height: 1, colorType: 0, depth: 16, rows: [Uint8Array.from([0x12, 0x34, 0xab, 0xcd])], filters: [4], trns: [0x12, 0x34] });
  assert.deepEqual(Array.from(png.decode(buf).data), [0x12, 0x12, 0x12, 0, 0xab, 0xab, 0xab, 255]);
  // gray + alpha 8 and 16
  buf = rawPng({ width: 2, height: 1, colorType: 4, depth: 8, rows: [Uint8Array.from([10, 20, 30, 40])], filters: [3] });
  assert.deepEqual(Array.from(png.decode(buf).data), [10, 10, 10, 20, 30, 30, 30, 40]);
  buf = rawPng({ width: 1, height: 1, colorType: 4, depth: 16, rows: [Uint8Array.from([200, 1, 100, 2])], filters: [0] });
  assert.deepEqual(Array.from(png.decode(buf).data), [200, 200, 200, 100]);
  // palette 2-bit with tRNS shorter than the palette
  buf = rawPng({
    width: 4,
    height: 1,
    colorType: 3,
    depth: 2,
    rows: [Uint8Array.from([0b00011011])],
    filters: [0],
    palette: [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9],
    trns: [0, 128],
  });
  assert.deepEqual(Array.from(png.decode(buf).data), [255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 255]);
  // RGB 8 with tRNS color key
  buf = rawPng({ width: 2, height: 1, colorType: 2, depth: 8, rows: [Uint8Array.from([1, 2, 3, 4, 5, 6])], filters: [0], trns: [0, 4, 0, 5, 0, 6] });
  assert.deepEqual(Array.from(png.decode(buf).data), [1, 2, 3, 255, 4, 5, 6, 0]);
  // RGB 16 with tRNS and RGBA 16
  buf = rawPng({ width: 2, height: 1, colorType: 2, depth: 16, rows: [Uint8Array.from([1, 0, 2, 0, 3, 0, 9, 9, 8, 8, 7, 7])], filters: [2], trns: [9, 9, 8, 8, 7, 7] });
  assert.deepEqual(Array.from(png.decode(buf).data), [1, 2, 3, 255, 9, 8, 7, 0]);
  buf = rawPng({ width: 1, height: 1, colorType: 6, depth: 16, rows: [Uint8Array.from([10, 0, 20, 0, 30, 0, 40, 0])], filters: [0] });
  assert.deepEqual(Array.from(png.decode(buf).data), [10, 20, 30, 40]);
});

test('decode rejects bad input with clear errors', () => {
  assert.throws(() => png.decode(Buffer.from('not a png at all')), /invalid signature/);
  const good = png.encode(makeImage(8, 8, () => [1, 2, 3, 255]));
  const badCrc = Buffer.from(good);
  badCrc[20] ^= 0xff; // inside IHDR
  assert.throws(() => png.decode(badCrc), /checksum|bad|invalid|large/i);
  const truncated = good.subarray(0, 45);
  assert.throws(() => png.decode(truncated), /truncated|corrupt|no image data/);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 3;
  ihdr[9] = 2; // RGB with depth 3 is invalid
  assert.throws(() => png.decode(Buffer.concat([png.SIGNATURE, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))])), /bit depth/);
  const badFilter = rawPng({ width: 1, height: 1, colorType: 0, depth: 8, rows: [Uint8Array.from([5])], filters: [0] });
  // Patch the filter byte by re-deflating with type 9.
  const parts = [png.SIGNATURE, badFilter.subarray(8, 33)];
  const ih = Buffer.concat(parts);
  const z = zlib.deflateSync(Buffer.from([9, 5]));
  assert.throws(() => png.decode(Buffer.concat([ih, chunk('IDAT', z), chunk('IEND', Buffer.alloc(0))])), /invalid filter type 9/);
});

// ------------------------------------------------------------ ImageMagick fixtures

const CONVERT = (() => {
  const r = spawnSync('convert', ['-version'], { encoding: 'utf8' });
  return r.status === 0 && /ImageMagick/.test(r.stdout) ? 'convert' : null;
})();

function im(args) {
  const r = spawnSync(CONVERT, args, { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`convert ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const FIXTURES = [
  { name: 'gray8', args: ['-size', '37x23', 'gradient:black-white', '-define', 'png:color-type=0', '-define', 'png:bit-depth=8'], ct: 0, depth: 8 },
  { name: 'gray1', args: ['-size', '29x13', 'pattern:checkerboard', '-colorspace', 'Gray', '-define', 'png:color-type=0', '-define', 'png:bit-depth=1'], ct: 0, depth: 1 },
  { name: 'gray4-interlaced', args: ['-size', '19x11', 'gradient:black-white', '-depth', '4', '-define', 'png:color-type=0', '-define', 'png:bit-depth=4', '-interlace', 'PNG'], ct: 0, depth: 4, interlace: 1 },
  { name: 'gray-alpha8', args: ['-size', '21x9', 'gradient:black-white', '-alpha', 'set', '-channel', 'A', '-evaluate', 'set', '40%', '+channel', '-depth', '8', '-define', 'png:color-type=4', '-define', 'png:bit-depth=8'], ct: 4, depth: 8 },
  { name: 'gray-alpha16', args: ['-size', '21x9', 'gradient:black-white', '-alpha', 'set', '-channel', 'A', '-evaluate', 'set', '40%', '+channel', '-define', 'png:color-type=4'], ct: 4, depth: 16, tol: 1 },
  {
    name: 'palette-trns',
    args: ['-size', '24x16', 'xc:none', '-fill', 'red', '-draw', 'rectangle 0,0 11,7', '-fill', 'blue', '-draw', 'rectangle 12,8 23,15', '-fill', 'lime', '-draw', 'rectangle 0,8 5,15'],
    out: 'PNG8',
    ct: 3,
  },
  { name: 'rgb16', args: ['-size', '33x17', 'gradient:red-blue', '-depth', '16'], out: 'PNG48', ct: 2, depth: 16, tol: 1 },
  { name: 'rgba16', args: ['-size', '33x17', 'gradient:yellow-navy', '-alpha', 'set', '-channel', 'A', '-evaluate', 'set', '70%', '+channel', '-depth', '16'], out: 'PNG64', ct: 6, depth: 16, tol: 1 },
  { name: 'rgb-interlaced', args: ['-seed', '3', '-size', '45x27', 'plasma:fractal', '-depth', '8', '-interlace', 'PNG', '-define', 'png:color-type=2', '-define', 'png:bit-depth=8'], ct: 2, depth: 8, interlace: 1 },
  { name: 'rgb16-interlaced', args: ['-seed', '3', '-size', '17x13', 'plasma:fractal', '-interlace', 'PNG', '-define', 'png:color-type=2'], ct: 2, depth: 16, interlace: 1, tol: 1 },
  { name: 'rgba-interlaced-tiny', args: ['-size', '3x2', 'gradient:red-blue', '-alpha', 'set', '-interlace', 'PNG', '-define', 'png:color-type=6'], ct: 6, depth: 8, interlace: 1 },
  { name: 'palette-interlaced', args: ['-size', '30x20', 'gradient:red-blue', '-colors', '7', '-interlace', 'PNG'], out: 'PNG8', ct: 3, interlace: 1 },
];

test('decode matches ImageMagick for gray, palette+tRNS, 16-bit and interlaced fixtures', { skip: CONVERT ? false : 'ImageMagick convert not installed' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-png-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const fx of FIXTURES) {
    const file = path.join(dir, `${fx.name}.png`);
    im([...fx.args, `${fx.out ? `${fx.out}:` : ''}${file}`]);
    const buf = fs.readFileSync(file);
    const hdr = png.readHeader(buf);
    assert.equal(hdr.colorType, fx.ct, `${fx.name}: color type`);
    if (fx.depth) assert.equal(hdr.bitDepth, fx.depth, `${fx.name}: bit depth`);
    if (fx.interlace) assert.equal(hdr.interlace, 1, `${fx.name}: interlace`);
    const img = png.decode(buf);
    const ref = im([file, '-depth', '8', 'rgba:-']);
    assert.equal(img.data.length, ref.length, `${fx.name}: size`);
    const tol = fx.tol || 0;
    for (let i = 0; i < ref.length; i += 4) {
      const alpha = ref[i + 3];
      assert.ok(Math.abs(img.data[i + 3] - alpha) <= tol, `${fx.name}: alpha at ${i / 4}: ${img.data[i + 3]} vs ${alpha}`);
      if (alpha === 0) continue; // color of fully transparent pixels is irrelevant
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(img.data[i + c] - ref[i + c]) <= tol, `${fx.name}: channel ${c} at pixel ${i / 4}: ${img.data[i + c]} vs ${ref[i + c]}`);
      }
    }
  }
});

test('ImageMagick can read what encode writes', { skip: CONVERT ? false : 'ImageMagick convert not installed' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-png-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const img = makeImage(40, 25, (x, y) => [x * 6, y * 10, (x * y) & 255, 200]);
  const file = path.join(dir, 'ours.png');
  fs.writeFileSync(file, png.encode(img));
  assert.deepEqual(Buffer.from(im([file, '-depth', '8', 'rgba:-'])), Buffer.from(img.data));
});

// ------------------------------------------------------------ resize / crop / fit

test('resize: area average is exact for non-integer ratios', () => {
  const img = makeImage(3, 1, (x) => [x * 90, x * 90, x * 90, 255]);
  const out = png.resize(img, 2, 1);
  assert.deepEqual(pixel(out, 0, 0), [30, 30, 30, 255]);
  assert.deepEqual(pixel(out, 1, 0), [150, 150, 150, 255]);
  // 4x4 → 2x2 averages 2x2 blocks
  const blocks = makeImage(4, 4, (x, y) => [x < 2 ? (y < 2 ? 0 : 100) : y < 2 ? 200 : 40 + (x & 1) * 20, 0, 0, 255]);
  const small = png.resize(blocks, 2, 2);
  assert.deepEqual([pixel(small, 0, 0)[0], pixel(small, 1, 0)[0], pixel(small, 0, 1)[0], pixel(small, 1, 1)[0]], [0, 200, 100, 50]);
});

test('resize: uniform images stay uniform for odd ratios, both directions', () => {
  const img = makeImage(101, 37, () => [12, 200, 77, 255]);
  for (const [w, h] of [[13, 7], [100, 36], [7, 50], [202, 74], [1, 1]]) {
    const out = png.resize(img, w, h);
    assert.equal(out.width, w);
    assert.equal(out.height, h);
    for (let i = 0; i < out.data.length; i += 4) {
      assert.deepEqual(Array.from(out.data.subarray(i, i + 4)), [12, 200, 77, 255], `${w}x${h} at ${i / 4}`);
    }
  }
});

test('resize: bilinear upscale and premultiplied alpha', () => {
  const img = makeImage(2, 1, (x) => [x * 255, 0, 0, 255]);
  const up = png.resize(img, 4, 1);
  assert.deepEqual([0, 1, 2, 3].map((x) => pixel(up, x, 0)[0]), [0, 64, 191, 255]);
  // A transparent green pixel must not tint the average of an opaque red one.
  const ab = makeImage(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
  assert.deepEqual(pixel(png.resize(ab, 1, 1), 0, 0), [255, 0, 0, 128]);
  // Same-size resize returns a copy.
  const same = png.resize(img, 2, 1);
  assert.notEqual(same.data, img.data);
  assert.deepEqual(Array.from(same.data), Array.from(img.data));
});

test('crop copies and clips, rejects empty rectangles', () => {
  const img = makeImage(10, 8, (x, y) => [x, y, 0, 255]);
  const c = png.crop(img, 2, 3, 4, 2);
  assert.equal(c.width, 4);
  assert.equal(c.height, 2);
  assert.deepEqual(pixel(c, 0, 0), [2, 3, 0, 255]);
  assert.deepEqual(pixel(c, 3, 1), [5, 4, 0, 255]);
  const clipped = png.crop(img, 8, 6, 10, 10);
  assert.deepEqual([clipped.width, clipped.height], [2, 2]);
  assert.throws(() => png.crop(img, 20, 20, 5, 5), /outside/);
});

test('fitWithin never upscales and keeps the aspect ratio', () => {
  assert.deepEqual(png.fitWithin(2880, 1800, 1366, 768), { width: 1229, height: 768, scale: 768 / 1800 });
  assert.deepEqual(png.fitWithin(1920, 1080, 1366, 768).width, 1365);
  assert.deepEqual(png.fitWithin(800, 600, 1366, 768), { width: 800, height: 600, scale: 1 });
  assert.deepEqual(png.fitWithin(4000, 1000, 0, 0), { width: 4000, height: 1000, scale: 1 });
  const tall = png.fitWithin(1000, 5000, 1366, 768);
  assert.equal(tall.height, 768);
  assert.ok(tall.width <= 1366 && tall.width >= 1);
});

test('performance: 2880x1800 decode + resize to 1366x854 + encode stays fast', (t) => {
  const W = 2880;
  const H = 1800;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const band = ((x >> 6) + (y >> 5)) & 3;
      data[i] = band * 60 + (x & 7);
      data[i + 1] = (y * 255) / H;
      data[i + 2] = (x * 255) / W;
      data[i + 3] = 255;
      if ((y >> 4) & 1 && (x * 7 + y * 13) % 23 === 0) data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  const big = png.encode({ width: W, height: H, data });
  const t0 = process.hrtime.bigint();
  const dec = png.decode(big);
  const small = png.resize(dec, 1366, 854);
  const out = png.encode(small);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(png.readHeader(out).width, 1366);
  // Budget is ~1.5 s on a desktop; allow headroom for slow CI machines.
  assert.ok(ms < 4000, `took ${ms.toFixed(0)} ms`);
  t.diagnostic(`decode+resize+encode: ${ms.toFixed(0)} ms`);
});
