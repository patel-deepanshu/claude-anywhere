'use strict';

/**
 * Low-rate screen diffs (docs/CALLS-DESIGN.md §4.1 C). Every 2 s while armed the detector captures
 * each display, shrinks it to a 96×54 grayscale thumbnail and compares it with the previous one.
 * A new compact block of changed cells (1–25% of the screen, typical of a call popup or banner)
 * is a *weak* candidate (0.3) with its region; it only ever leads to a rate-limited vision check.
 *
 * Pure Node: PNG decoding and the area-average resize come from src/os/png.js.
 */

const png = require('../os/png');

const THUMB_W = 96;
const THUMB_H = 54;
const DEFAULTS = Object.freeze({
  threshold: 24, // gray-level change (0-255) for a cell to count as changed
  minFrac: 0.01, // smallest block, as a share of the screen
  maxFrac: 0.25, // largest block; bigger changes are window switches or scrolling
  minFill: 0.25, // share of changed cells inside the block's bounding box (after dilation)
  globalFrac: 0.5, // above this share of changed cells the whole screen changed: no candidate
});

/**
 * 96×54 grayscale thumbnail of a screenshot.
 * @param {Buffer|{width:number,height:number,data:Uint8Array}} input a PNG or a decoded RGBA image
 * @returns {Uint8Array} THUMB_W*THUMB_H luma values (row-major)
 */
function thumb(input) {
  const img = Buffer.isBuffer(input) || input instanceof Uint8Array ? png.decode(input) : input;
  if (!img || !(img.width > 0) || !(img.height > 0) || !img.data) throw new TypeError('thumb() needs a PNG or an RGBA image');
  const small = img.width === THUMB_W && img.height === THUMB_H ? img : png.resize(img, THUMB_W, THUMB_H);
  const out = new Uint8Array(THUMB_W * THUMB_H);
  const d = small.data;
  for (let i = 0, o = 0; i < out.length; i++, o += 4) {
    // Rec. 601 luma; alpha is ignored (screenshots are opaque).
    out[i] = (d[o] * 299 + d[o + 1] * 587 + d[o + 2] * 114 + 500) / 1000;
  }
  return out;
}

function changedMask(a, b, threshold) {
  const n = a.length;
  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(a[i] - b[i]) > threshold) {
      mask[i] = 1;
      count++;
    }
  }
  return { mask, count };
}

/** One-cell dilation (8-neighbourhood): joins the border, text and buttons of one popup. */
function dilate(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

/** Connected components (8-connectivity) of a mask: [{x0, y0, x1, y1, cells}]. */
function components(mask, w, h) {
  const label = new Int32Array(mask.length);
  const out = [];
  const stack = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = out.length + 1;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    const comp = { x0: w, y0: h, x1: -1, y1: -1, cells: 0 };
    while (sp) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      comp.cells++;
      if (x < comp.x0) comp.x0 = x;
      if (x > comp.x1) comp.x1 = x;
      if (y < comp.y0) comp.y0 = y;
      if (y > comp.y1) comp.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !label[j]) {
            label[j] = id;
            stack[sp++] = j;
          }
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Compare two thumbnails.
 * @param {Uint8Array} a previous thumb()
 * @param {Uint8Array} b current thumb()
 * @param {object} [opts] DEFAULTS overrides, plus ignore: Uint8Array mask of cells to leave out
 *   (busy cells, see ScreenDiffTracker)
 * @returns {{changed:boolean, fraction:number, global:boolean,
 *   region:{x:number,y:number,width:number,height:number}|null,
 *   cells:{x0:number,y0:number,x1:number,y1:number}|null}}
 *   changed: a compact new block exists; region: that block in fractions (0-1) of the screen
 */
function diff(a, b, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const none = { changed: false, fraction: 0, global: false, region: null, cells: null };
  if (!a || !b || a.length !== b.length || a.length !== THUMB_W * THUMB_H) return none;
  const { mask, count } = changedMask(a, b, o.threshold);
  const total = a.length;
  const fraction = count / total;
  if (!count) return none;
  if (fraction > o.globalFrac) return { ...none, fraction, global: true };
  if (o.ignore && o.ignore.length === total) {
    for (let i = 0; i < total; i++) if (o.ignore[i]) mask[i] = 0;
  }
  const grown = dilate(mask, THUMB_W, THUMB_H);
  let best = null;
  for (const c of components(grown, THUMB_W, THUMB_H)) {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const boxFrac = (bw * bh) / total;
    if (boxFrac < o.minFrac || boxFrac > o.maxFrac) continue;
    // Fill: changed (dilated) cells inside the box; a popup is a filled rectangle, scattered
    // changes (a clock, a cursor, text being typed) are not.
    const fill = c.cells / (bw * bh);
    if (fill < o.minFill) continue;
    if (!best || bw * bh > best.area) best = { c, area: bw * bh };
  }
  if (!best) return { ...none, fraction };
  const { c } = best;
  return {
    changed: true,
    fraction,
    global: false,
    cells: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
    region: { x: c.x0 / THUMB_W, y: c.y0 / THUMB_H, width: (c.x1 - c.x0 + 1) / THUMB_W, height: (c.y1 - c.y0 + 1) / THUMB_H },
  };
}

/**
 * A fractional region (diff().region) in pixels of an image or display of the given size, grown
 * by `margin` pixels on every side and clamped to it.
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function regionToRect(region, width, height, margin = 0) {
  if (!region || !(width > 0) || !(height > 0)) return null;
  const x0 = Math.max(0, Math.floor(region.x * width) - margin);
  const y0 = Math.max(0, Math.floor(region.y * height) - margin);
  const x1 = Math.min(width, Math.ceil((region.x + region.width) * width) + margin);
  const y1 = Math.min(height, Math.ceil((region.y + region.height) * height) + margin);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/**
 * Per-display diff state. Cells that changed in 2 or more of the last 4 frames are "busy" (a video,
 * an animation, a ticking clock) and are left out, so only a *new* block becomes a candidate.
 */
class ScreenDiffTracker {
  /** @param {object} [opts] diff() options plus busyFrames (4) and busyHits (2) */
  constructor(opts = {}) {
    this.opts = { busyFrames: 4, busyHits: 2, ...opts };
    this.prev = new Map(); // display -> thumb
    this.history = new Map(); // display -> Uint8Array[] masks of recent frames
  }

  /**
   * Add a frame of a display; returns diff() against its previous frame (changed:false for the first).
   * @param {number} display
   * @param {Uint8Array} t thumb()
   */
  push(display, t) {
    const prev = this.prev.get(display);
    this.prev.set(display, t);
    if (!prev || prev.length !== t.length) return { changed: false, fraction: 0, global: false, region: null, cells: null };
    const hist = this.history.get(display) || [];
    const busy = new Uint8Array(t.length);
    for (const m of hist) for (let i = 0; i < m.length; i++) busy[i] += m[i];
    for (let i = 0; i < busy.length; i++) busy[i] = busy[i] >= this.opts.busyHits ? 1 : 0;
    const res = diff(prev, t, { ...this.opts, ignore: busy });
    hist.push(changedMask(prev, t, this.opts.threshold == null ? DEFAULTS.threshold : this.opts.threshold).mask);
    while (hist.length > this.opts.busyFrames) hist.shift();
    this.history.set(display, hist);
    return res;
  }

  reset() {
    this.prev.clear();
    this.history.clear();
  }
}

/**
 * Mean color around a point of a screenshot (a square of side 2*radius+1), e.g. the learned Accept
 * button's green, to check later that a learned position still shows the same control.
 * @param {Buffer|{width:number,height:number,data:Uint8Array}} input PNG or RGBA image
 * @returns {[number, number, number]|null}
 */
function patchColor(input, point, radius = 8) {
  try {
    const img = Buffer.isBuffer(input) || input instanceof Uint8Array ? png.decode(input) : input;
    const x0 = Math.max(0, Math.round(point.x) - radius);
    const y0 = Math.max(0, Math.round(point.y) - radius);
    const x1 = Math.min(img.width, Math.round(point.x) + radius + 1);
    const y1 = Math.min(img.height, Math.round(point.y) + radius + 1);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * img.width + x) * 4;
        r += img.data[o];
        g += img.data[o + 1];
        b += img.data[o + 2];
        n++;
      }
    }
    return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
  } catch {
    return null;
  }
}

/** Largest per-channel difference of two colors (Infinity when either is missing). */
function colorDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 3 || b.length !== 3) return Infinity;
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

module.exports = { THUMB_W, THUMB_H, DEFAULTS, thumb, diff, regionToRect, ScreenDiffTracker, patchColor, colorDistance };
