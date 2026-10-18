'use strict';

/**
 * Free, local OCR for the desktop tools (docs/ARCHITECTURE.md section 4, "OCR"): find visible text
 * and where it is, with what the OS already has.
 *
 *   macOS    Vision (VNRecognizeTextRequest, macOS 10.15+) through the JXA script darwin-ocr.js
 *   Windows  Windows.Media.Ocr (WinRT) through the one-shot Windows PowerShell 5.1 script win32-ocr.ps1;
 *            from WSL through powershell.exe, with the files staged where Windows can read them (wslpath -w)
 *   Linux    the tesseract CLI (TSV output: --psm 11 for sparse UI text, plus --psm 6 and --psm 3 passes),
 *            on a grayscale copy whose light-on-dark areas (dark panels, buttons) are flipped to dark-on-light
 *   any      tesseract as the fallback wherever it is installed
 * No engine: recognize() returns {engine: null, hint} and the model reads the screenshot itself.
 *
 *   async available({refresh?}) -> {engine: 'vision'|'windows'|'tesseract'|null, hint: string|null, engines: [...]}
 *   async recognize({png, region?, engine?, lang?, upscale?, pixelScale?, timeoutMs?})
 *     -> {engine, width, height, region, lines: [{text, bounds, confidence, words: [{text, bounds, confidence}]}], hint?, notes?}
 *     bounds {x, y, width, height} are pixels of the given PNG (top-left origin); confidence 0..1 or null
 *   async scanScreen(computer, {display?, region?}) -> lines in screenshot space ({shot: {x, y, width, height, cx, cy}})
 *   async findText(computer, {text, display?, region?, exact?, limit?}) -> [{text, shot, confidence, score, match, display, line}]
 *   async readScreenText(computer, {display?, region?}) -> {engine, display, lines: [{text, shot, confidence}], hint?}
 *
 * Screenshot space is the one click() uses: pixels of the latest full screenshot of the display
 * (display-local logical pixels before the first one). The capture for OCR is a native-resolution
 * region shot through Computer.screenshot, which never changes that mapping.
 *
 * Environment: ANYWHERE_OCR_ENGINE (vision|windows|tesseract|none), ANYWHERE_OCR_LANG (tesseract
 * codes such as "eng+deu", or a BCP-47 tag such as "de-DE" for Vision/Windows), ANYWHERE_OCR_PSM
 * (tesseract passes, e.g. "11,6"), ANYWHERE_TESSERACT (path to the tesseract executable).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../shared/proc');
const platformInfo = require('../shared/platform');
const png = require('./png');
const { createLogger } = require('../shared/log');

const log = createLogger('ocr');

const VISION_SCRIPT = path.join(__dirname, 'darwin-ocr.js');
const WINDOWS_SCRIPT = path.join(__dirname, 'win32-ocr.ps1');
const ENGINES = ['vision', 'windows', 'tesseract'];
const ENGINE_ALIASES = {
  vision: 'vision', apple: 'vision', macos: 'vision', mac: 'vision',
  windows: 'windows', win32: 'windows', winrt: 'windows', wsl: 'windows',
  tesseract: 'tesseract', tess: 'tesseract',
};
const OFF_VALUES = new Set(['none', 'off', 'no', '0', 'false', 'disabled', 'disable']);

const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const WSL_CMD = '/mnt/c/Windows/System32/cmd.exe';
const TESSERACT_EXTRA_PATHS = {
  darwin: ['/opt/homebrew/bin/tesseract', '/usr/local/bin/tesseract', '/opt/local/bin/tesseract'],
  win32: ['C:\\Program Files\\Tesseract-OCR\\tesseract.exe', 'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe'],
  linux: ['/usr/bin/tesseract', '/usr/local/bin/tesseract', '/snap/bin/tesseract'],
};

const PROBE_TTL_MS = 5 * 60 * 1000; // a working engine is trusted this long (a failed run re-probes at once)
const PROBE_MISS_TTL_MS = 10000; // a missing one is re-checked sooner, so an install is picked up without a restart
const PROBE_TIMEOUT_MS = 30000; // the first WinRT load on a cold Windows can take several seconds
const OCR_TIMEOUT_MS = 60000;
const DEFAULT_PASSES = [11, 6, 3];
const MAX_SIDE = 8192; // longest image side handed to an engine (Windows OCR reads at most 10000)
const UPSCALE_MAX_PIXELS = 1600000; // auto 2x upscale only up to this many source pixels (regions, small screens)
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_QUERY_CHARS = 500;
const MIN_WORD_CONF = 30; // tesseract word confidence (0..100) kept without further checks

const HINT_FALLBACK = 'Until then, take a screenshot and read the text from the image.';
const HINT_WINDOWS_LANGUAGE =
  'Windows has no OCR language installed: add a language with the "Optical character recognition" feature in Settings > ' +
  'Time & language > Language & region, or run in an administrator PowerShell: Add-WindowsCapability -Online -Name "Language.OCR~~~en-US~0.0.1.0".';
const HINT_WSL_INTEROP =
  'Enable WSL interop so Windows programs run from Linux (in /etc/wsl.conf: [interop] enabled=true and appendWindowsPath=true), ' +
  'then run `wsl --shutdown` from Windows and reopen your WSL terminal.';

// ---------------------------------------------------------------- small helpers

function ocrError(message, code, hint, extra) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  if (extra) Object.assign(err, extra);
  return err;
}

function oneLine(s, max = 300) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** The last stdout line that parses as a JSON object (osascript and PowerShell may print other text first). */
function lastJson(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s.startsWith('{')) continue;
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object') return j;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function runFailure(r) {
  if (!r) return 'no result';
  if (r.error) return r.error.code === 'ENOENT' ? 'not found' : r.error.message;
  if (r.timedOut) return 'timed out';
  const err = oneLine(r.stderr, 300);
  return err || `exit code ${r.code}`;
}

function rectUnion(rects) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function meanConfidence(items) {
  const vals = items.map((i) => i.confidence).filter((c) => typeof c === 'number' && Number.isFinite(c));
  return vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

function roundRect(r) {
  return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
}

// ---------------------------------------------------------------- context, engine plan and probes

/** Everything that touches the system, overridable by tests. */
function makeContext(overrides = {}) {
  const info = platformInfo.info();
  return {
    platform: info.platform,
    isWSL: info.isWSL,
    env: process.env,
    run: proc.run,
    which: proc.which,
    exists: fs.existsSync,
    tmpdir: os.tmpdir(),
    cache: probeCache,
    ...overrides,
  };
}

/**
 * Engines to try, best first, for a platform. ANYWHERE_OCR_ENGINE forces one (or none).
 * @returns {string[]}
 */
function enginePlan({ platform, isWSL = false, env = {} } = {}) {
  const forced = String(env.ANYWHERE_OCR_ENGINE || '').trim().toLowerCase();
  if (forced) {
    if (OFF_VALUES.has(forced)) return [];
    if (ENGINE_ALIASES[forced]) return [ENGINE_ALIASES[forced]];
    log.warn(`ANYWHERE_OCR_ENGINE=${forced} is not an OCR engine (vision, windows, tesseract or none); ignoring it`);
  }
  if (platform === 'darwin') return ['vision', 'tesseract'];
  if (platform === 'win32' || isWSL) return ['windows', 'tesseract'];
  return ['tesseract'];
}

function packageManagerHint(ctx) {
  if (ctx.platform === 'darwin') return 'brew install tesseract';
  if (ctx.platform === 'win32') return 'winget install UB-Mannheim.TesseractOCR';
  if (ctx.which('apt-get') || ctx.which('apt')) return 'sudo apt install tesseract-ocr';
  if (ctx.which('dnf')) return 'sudo dnf install tesseract';
  if (ctx.which('pacman')) return 'sudo pacman -S tesseract tesseract-data-eng';
  if (ctx.which('zypper')) return 'sudo zypper install tesseract-ocr tesseract-ocr-traineddata-english';
  if (ctx.which('apk')) return 'sudo apk add tesseract-ocr tesseract-ocr-data-eng';
  return 'sudo apt install tesseract-ocr';
}

function tesseractHint(ctx) {
  return `Install Tesseract for on-screen text search: ${packageManagerHint(ctx)}`;
}

function locateTesseract(ctx) {
  const explicit = String(ctx.env.ANYWHERE_TESSERACT || '').trim();
  if (explicit) return ctx.exists(explicit) ? explicit : null;
  const found = ctx.which('tesseract');
  if (found) return found;
  const extra = TESSERACT_EXTRA_PATHS[ctx.platform] || TESSERACT_EXTRA_PATHS.linux;
  return extra.find((p) => ctx.exists(p)) || null;
}

/** `tesseract --list-langs` output -> language codes (newer versions print to stdout, older to stderr). */
function parseTesseractLangs(text) {
  const out = [];
  let started = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const s = raw.trim();
    if (/^List of available languages/i.test(s)) {
      started = true;
      continue;
    }
    if (started && /^[A-Za-z0-9_-]{2,40}$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

function locateWindowsPowerShell(ctx) {
  // Windows PowerShell 5.1 only: PowerShell 7 (pwsh) has no WinRT projection.
  if (ctx.platform === 'win32') {
    const root = ctx.env.SystemRoot || ctx.env.SYSTEMROOT || ctx.env.windir || 'C:\\Windows';
    const builtin = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (ctx.exists(builtin)) return builtin;
    return ctx.which('powershell');
  }
  if (ctx.isWSL) return ctx.which('powershell.exe') || (ctx.exists(WSL_POWERSHELL) ? WSL_POWERSHELL : null);
  return null;
}

const probeCache = new Map(); // engine -> {at, result}

async function probeVision(ctx) {
  const osa = ctx.which('osascript') || (ctx.exists('/usr/bin/osascript') ? '/usr/bin/osascript' : null);
  if (!osa) return { ok: false, note: 'osascript was not found', hint: 'Vision text recognition needs macOS 10.15 or newer.' };
  const r = await ctx.run(osa, ['-l', 'JavaScript', VISION_SCRIPT, '--probe'], { timeoutMs: PROBE_TIMEOUT_MS });
  const j = lastJson(r.stdout);
  if (j && j.ok === true && j.available !== false) return { ok: true, exe: osa, languages: Array.isArray(j.languages) ? j.languages : [] };
  return {
    ok: false,
    note: (j && j.error) || `the Vision probe failed (${runFailure(r)})`,
    hint: `Vision text recognition needs macOS 10.15 or newer; or ${tesseractHint(ctx).replace(/^Install/, 'install')}.`,
  };
}

async function probeTesseract(ctx) {
  const exe = locateTesseract(ctx);
  if (!exe) return { ok: false, note: 'tesseract is not installed', hint: tesseractHint(ctx) };
  const r = await ctx.run(exe, ['--list-langs'], { timeoutMs: 15000, env: { ...ctx.env, OMP_THREAD_LIMIT: '1' } });
  if (r.error || r.timedOut) return { ok: false, exe, note: `tesseract did not run (${runFailure(r)})`, hint: tesseractHint(ctx) };
  const langs = parseTesseractLangs(`${r.stdout || ''}\n${r.stderr || ''}`).filter((l) => l !== 'osd' && l !== 'equ');
  if (!langs.length) {
    const pkg = ctx.which('apt-get') ? 'sudo apt install tesseract-ocr-eng' : packageManagerHint(ctx);
    return { ok: false, exe, note: 'tesseract has no language data', hint: `Install Tesseract's English data: ${pkg}` };
  }
  return { ok: true, exe, languages: langs };
}

/**
 * Windows files for one run: a private folder Windows can read, the script inside it (from WSL),
 * and a converter to the Windows path of a file in it.
 */
async function windowsWorkspace(ctx) {
  if (ctx.platform === 'win32') {
    const dir = fs.mkdtempSync(path.join(ctx.tmpdir, 'anywhere-ocr-'));
    return { dir, script: WINDOWS_SCRIPT, winPath: async (p) => p, cwd: undefined };
  }
  // WSL: prefer the Windows %TEMP% (plain C:\ paths); the Linux /tmp needs a \\wsl.localhost UNC path,
  // which Windows PowerShell may refuse to run scripts from.
  const winTemp = await wslWindowsTemp(ctx);
  let dir = null;
  if (winTemp) {
    try {
      dir = fs.mkdtempSync(path.join(winTemp, 'claude-anywhere-ocr-'));
    } catch (err) {
      log.debug(`cannot use the Windows temp folder ${winTemp}: ${err.message}`);
    }
  }
  if (!dir) dir = fs.mkdtempSync(path.join(ctx.tmpdir, 'anywhere-ocr-'));
  const script = path.join(dir, 'win32-ocr.ps1');
  fs.copyFileSync(WINDOWS_SCRIPT, script);
  return { dir, script, winPath: (p) => wslToWindowsPath(p, ctx), cwd: ctx.exists('/mnt/c') ? '/mnt/c' : undefined };
}

let wslTempCache; // undefined = not looked up; null = none

/** The Windows %TEMP% folder as a Linux path (/mnt/c/Users/me/AppData/Local/Temp), or null. */
async function wslWindowsTemp(ctx) {
  if (ctx.wslTemp !== undefined) return ctx.wslTemp;
  if (wslTempCache !== undefined && ctx.cache === probeCache) return wslTempCache;
  let found = null;
  const cmd = ctx.which('cmd.exe') || (ctx.exists(WSL_CMD) ? WSL_CMD : null);
  if (cmd) {
    const r = await ctx.run(cmd, ['/d', '/c', 'echo', '%TEMP%'], { timeoutMs: 10000, cwd: ctx.exists('/mnt/c') ? '/mnt/c' : undefined });
    const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const win = lines[lines.length - 1];
    if (r.code === 0 && win && /^[A-Za-z]:\\/.test(win)) {
      const linux = await windowsToWslPath(win, ctx);
      if (linux && ctx.exists(linux)) found = linux;
    }
  }
  if (ctx.cache === probeCache) wslTempCache = found;
  return found;
}

/** C:\Users\me -> /mnt/c/Users/me (wslpath -u when it exists). */
async function windowsToWslPath(winPath, ctx) {
  const wslpath = ctx.which('wslpath');
  if (wslpath) {
    const r = await ctx.run(wslpath, ['-u', winPath], { timeoutMs: 5000 });
    const out = String(r.stdout || '').trim();
    if (r.code === 0 && out.startsWith('/')) return out;
  }
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(String(winPath).trim());
  if (!m) return null;
  const rest = m[2].replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** /mnt/c/x -> C:\x, /tmp/x -> \\wsl.localhost\<distro>\tmp\x (wslpath -w when it exists). */
async function wslToWindowsPath(linuxPath, ctx) {
  const wslpath = ctx.which('wslpath');
  if (wslpath) {
    const r = await ctx.run(wslpath, ['-w', linuxPath], { timeoutMs: 5000 });
    const out = String(r.stdout || '').trim();
    if (r.code === 0 && out) return out;
  }
  const m = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(linuxPath);
  if (m) return `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}`;
  const distro = ctx.env.WSL_DISTRO_NAME;
  if (!distro) throw ocrError(`Cannot give Windows a path to ${linuxPath} (wslpath is missing)`, 'UNSUPPORTED', HINT_WSL_INTEROP);
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`;
}

function windowsArgs(script, extra) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra];
}

async function probeWindows(ctx) {
  const exe = locateWindowsPowerShell(ctx);
  if (!exe) {
    return {
      ok: false,
      note: 'Windows PowerShell (powershell.exe) was not found',
      hint: ctx.isWSL ? HINT_WSL_INTEROP : 'Windows PowerShell 5.1 ships with Windows 10 and 11; check %SystemRoot%\\System32\\WindowsPowerShell\\v1.0.',
    };
  }
  let ws;
  try {
    ws = await windowsWorkspace(ctx);
    const script = await ws.winPath(ws.script);
    const r = await ctx.run(exe, windowsArgs(script, ['-Probe']), { timeoutMs: PROBE_TIMEOUT_MS, cwd: ws.cwd });
    const j = lastJson(r.stdout);
    if (j && j.ok === true && j.available === true) {
      return { ok: true, exe, languages: Array.isArray(j.languages) ? j.languages : [], language: j.language || null, maxDimension: Number(j.maxDimension) || 10000 };
    }
    if (j && j.ok === true) return { ok: false, exe, note: 'no OCR language is installed', hint: j.hint || HINT_WINDOWS_LANGUAGE };
    if (j) return { ok: false, exe, note: j.error || 'the Windows OCR probe failed', hint: j.hint || null };
    // No answer at all: PowerShell did not start (from WSL, usually interop is off).
    return { ok: false, exe, note: `the Windows OCR probe failed (${runFailure(r)})`, hint: ctx.isWSL ? HINT_WSL_INTEROP : null };
  } catch (err) {
    return { ok: false, exe, note: err.message, hint: err.hint || null };
  } finally {
    if (ws) removeDir(ws.dir);
  }
}

const PROBES = { vision: probeVision, windows: probeWindows, tesseract: probeTesseract };

const inflight = new WeakMap(); // cache Map -> Map(engine -> Promise): concurrent callers share one probe

async function probeEngine(engine, ctx, refresh) {
  const hit = ctx.cache.get(engine);
  const ttl = hit && hit.result.ok ? PROBE_TTL_MS : PROBE_MISS_TTL_MS;
  if (!refresh && hit && Date.now() - hit.at < ttl) return hit.result;
  let running = inflight.get(ctx.cache);
  if (!running) {
    running = new Map();
    inflight.set(ctx.cache, running);
  }
  if (running.has(engine)) return running.get(engine);
  const p = (async () => {
    let result;
    try {
      result = await PROBES[engine](ctx);
    } catch (err) {
      result = { ok: false, note: err.message, hint: err.hint || null };
    }
    ctx.cache.set(engine, { at: Date.now(), result });
    return result;
  })();
  running.set(engine, p);
  try {
    return await p;
  } finally {
    running.delete(engine);
  }
}

function withPeriod(s) {
  const t = String(s || '').trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

/** One hint from the probes that failed, ending with what the model should do meanwhile. */
function unavailableHint(entries) {
  const hints = [...new Set(entries.map((e) => withPeriod(e.hint)).filter(Boolean))];
  return `${hints.length ? hints.join(' ') : 'No OCR engine is available on this computer.'} ${HINT_FALLBACK}`;
}

function entryOf(engine, r) {
  const entry = { engine, ok: Boolean(r.ok) };
  if (r.note) entry.note = r.note;
  if (r.languages && r.languages.length) entry.languages = r.languages.slice(0, 50);
  if (!r.ok && r.hint) entry.hint = r.hint;
  return entry;
}

const OFF_HINT = 'OCR is turned off (ANYWHERE_OCR_ENGINE=none). Read the text from a screenshot instead.';

/**
 * Which OCR engine works here (the first that does, in the platform's order of preference).
 * @param {{refresh?:boolean}} [opts] refresh: probe again instead of using the cached answer
 * @param {object} [ctxOverrides] test hooks (platform, isWSL, env, run, which, exists, tmpdir, cache)
 * @returns {Promise<{engine:string|null, hint:string|null, engines:{engine:string,ok:boolean,note?:string,languages?:string[],hint?:string}[]}>}
 */
async function available(opts = {}, ctxOverrides) {
  const ctx = makeContext(ctxOverrides);
  const plan = enginePlan(ctx);
  if (!plan.length) return { engine: null, hint: OFF_HINT, engines: [] };
  const engines = [];
  for (const engine of plan) {
    const r = await probeEngine(engine, ctx, Boolean(opts && opts.refresh));
    engines.push(entryOf(engine, r));
    if (r.ok) return { engine, hint: null, engines };
  }
  return { engine: null, hint: unavailableHint(engines), engines };
}

// ---------------------------------------------------------------- image preparation

/** RGBA -> 8-bit luma (BT.601 weights). */
function toGray(img) {
  const n = img.width * img.height;
  const g = new Uint8Array(n);
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return g;
}

/**
 * Which blocks of a gray image hold light-on-dark content (dark panels, filled buttons, dark mode).
 * Per block of `block` px: the background is the most common gray level and the ink the pixels far
 * from it; a block whose ink is lighter than its background is light-on-dark. Blocks without ink vote
 * by background brightness (firmly when clearly light or dark). A 3x3 vote over neighbouring blocks
 * smooths the decision, so whole boxes flip together without bleeding into the page around them.
 * @returns {{B:number, bw:number, bh:number, inv:Uint8Array, ink:Uint8Array}} inv[by * bw + bx] = 1 for
 *   light-on-dark; ink = 1 where a block holds light ink on a dark background (text in a dark box)
 */
function polarityMap(gray, width, height, block = 8) {
  const B = clamp(Math.round(block), 4, 64);
  const bw = Math.ceil(width / B);
  const bh = Math.ceil(height / B);
  const vote = new Float32Array(bw * bh);
  const hist = new Uint32Array(32);
  for (let by = 0; by < bh; by++) {
    const y0 = by * B;
    const y1 = Math.min(height, y0 + B);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * B;
      const x1 = Math.min(width, x0 + B);
      hist.fill(0);
      for (let y = y0; y < y1; y++) for (let x = x0, i = y * width + x0; x < x1; x++, i++) hist[gray[i] >> 3]++;
      let mode = 0;
      for (let k = 1; k < 32; k++) if (hist[k] > hist[mode]) mode = k;
      let bgSum = 0;
      let bgN = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = y * width + x0; x < x1; x++, i++) {
          if (Math.abs((gray[i] >> 3) - mode) <= 1) {
            bgSum += gray[i];
            bgN++;
          }
        }
      }
      const bg = bgSum / bgN;
      let inkSum = 0;
      let inkN = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = y * width + x0; x < x1; x++, i++) {
          if (Math.abs(gray[i] - bg) > 48) {
            inkSum += gray[i];
            inkN++;
          }
        }
      }
      let v;
      if (inkN >= 2) v = inkSum / inkN > bg ? 2 : -2;
      else if (bg >= 170) v = -1.5;
      else if (bg <= 90) v = 1.5;
      else v = bg < 128 ? 0.5 : -0.5;
      vote[by * bw + bx] = v;
    }
  }
  const inv = new Uint8Array(bw * bh);
  const ink = new Uint8Array(bw * bh);
  for (let i = 0; i < vote.length; i++) if (vote[i] === 2) ink[i] = 1;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let s = vote[by * bw + bx]; // the block itself counts twice
      for (let dy = -1; dy <= 1; dy++) {
        const yy = by + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = bx + dx;
          if (xx < 0 || xx >= bw) continue;
          s += vote[yy * bw + xx];
        }
      }
      if (s > 0) inv[by * bw + bx] = 1;
    }
  }
  return { B, bw, bh, inv, ink };
}

/**
 * Flip light-on-dark areas to dark-on-light in place (see polarityMap), because tesseract reads dark
 * text on a light page and drops text inside dark boxes.
 * @param {Uint8Array} gray
 * @param {object} [map] a polarityMap() result for this image
 * @returns {Uint8Array} the same array
 */
function normalizePolarity(gray, width, height, block = 8, map = polarityMap(gray, width, height, block)) {
  const { B, bw, bh, inv } = map;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (!inv[by * bw + bx]) continue;
      const y0 = by * B;
      const y1 = Math.min(height, y0 + B);
      const x0 = bx * B;
      const x1 = Math.min(width, x0 + B);
      for (let y = y0; y < y1; y++) for (let i = y * width + x0, e = y * width + x1; i < e; i++) gray[i] = 255 - gray[i];
    }
  }
  return gray;
}

const MAX_DARK_REGIONS = 32;

/**
 * Where light text sits on a dark background (buttons, dark panels, header bars), as pixel rectangles,
 * biggest first: the light-on-dark blocks that hold ink, with a margin of one block, joined when they
 * touch. Empty dark areas (a desktop, a video) are left out, and so are regions covering a large part
 * of the image (a dark-mode screen), which the main passes read inverted already.
 * @returns {{x:number,y:number,width:number,height:number}[]}
 */
function darkRegions(map, width, height) {
  const { B, bw, bh, inv, ink } = map;
  const mask = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (!ink[by * bw + bx] || !inv[by * bw + bx]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = by + dy;
          const xx = bx + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw && inv[yy * bw + xx]) mask[yy * bw + xx] = 1;
        }
      }
    }
  }
  const seen = new Uint8Array(bw * bh);
  const out = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let n = 0;
    let bx0 = bw;
    let by0 = bh;
    let bx1 = -1;
    let by1 = -1;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop();
      const bx = k % bw;
      const by = (k - bx) / bw;
      n++;
      bx0 = Math.min(bx0, bx);
      bx1 = Math.max(bx1, bx);
      by0 = Math.min(by0, by);
      by1 = Math.max(by1, by);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = by + dy;
          const xx = bx + dx;
          if (yy < 0 || yy >= bh || xx < 0 || xx >= bw) continue;
          const m = yy * bw + xx;
          if (mask[m] && !seen[m]) {
            seen[m] = 1;
            stack.push(m);
          }
        }
      }
    }
    const area = (bx1 - bx0 + 1) * (by1 - by0 + 1);
    // At least a 2x2-block box (one line of small text), never a large part of the screen.
    if (n < 4 || by1 - by0 < 1 || bx1 - bx0 < 1 || area > 0.4 * bw * bh) continue;
    out.push({ x: bx0 * B, y: by0 * B, width: Math.min(width, (bx1 + 1) * B) - bx0 * B, height: Math.min(height, (by1 + 1) * B) - by0 * B, n });
  }
  return out
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_DARK_REGIONS)
    .map(({ n, ...r }) => r);
}

const DARK_PAD = 12;
const DARK_GAP = 16;

/**
 * Stack the dark regions, inverted (dark text on white) and padded, into one image for a single extra
 * tesseract pass. bands[i] maps composite rows back: composite (x, y) in band i is source
 * (srcX + x - pad, srcY + y - top).
 * @param {Uint8Array} raw the gray image before polarity normalization
 * @returns {{gray:Uint8Array, width:number, height:number, pad:number, bands:{top:number,height:number,srcX:number,srcY:number}[]}|null}
 */
function darkComposite(raw, width, height, regions) {
  if (!regions.length) return null;
  const W = Math.max(...regions.map((r) => r.width)) + 2 * DARK_PAD;
  const H = regions.reduce((h, r) => h + r.height + DARK_GAP, DARK_GAP);
  const out = new Uint8Array(W * H).fill(255);
  const bands = [];
  let top = DARK_GAP;
  const hist = new Uint32Array(256);
  for (const r of regions) {
    // Inverted, a coloured box (a blue header, a green button) is mid-gray rather than white, and
    // tesseract reads little on it: stretch the levels so the box's own background (its most common
    // level) becomes white.
    hist.fill(0);
    for (let y = 0; y < r.height; y++) for (let x = 0, s = (r.y + y) * width + r.x; x < r.width; x++) hist[255 - raw[s + x]]++;
    let bg = 255;
    for (let v = 0; v < 256; v++) if (hist[v] > hist[bg]) bg = v;
    const gain = bg >= 96 && bg < 250 ? 255 / bg : 1;
    for (let y = 0; y < r.height; y++) {
      const src = (r.y + y) * width + r.x;
      const dst = (top + y) * W + DARK_PAD;
      for (let x = 0; x < r.width; x++) out[dst + x] = Math.min(255, Math.round((255 - raw[src + x]) * gain));
    }
    bands.push({ top, height: r.height, srcX: r.x, srcY: r.y });
    top += r.height + DARK_GAP;
  }
  return { gray: out, width: W, height: H, pad: DARK_PAD, bands };
}

/** Words read from the dark-region composite, moved back to where they are in the main image. */
function mapDarkWords(words, comp, scale) {
  const out = [];
  for (const w of words) {
    const cy = (w.y + w.h / 2) / scale;
    const band = comp.bands.find((b) => cy >= b.top && cy < b.top + b.height);
    if (!band) continue;
    const x = w.x / scale - comp.pad;
    const y = w.y / scale - band.top;
    out.push({ ...w, x: (band.srcX + x) * scale, y: (band.srcY + y) * scale });
  }
  return out;
}

/** Bilinear resize of a gray image (used for the 2x upscale of small UI text). */
function resizeGray(gray, width, height, newW, newH) {
  if (newW === width && newH === height) return gray;
  const out = new Uint8Array(newW * newH);
  const sx = width / newW;
  const sy = height / newH;
  for (let y = 0; y < newH; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(height - 1, Math.floor(fy));
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < newW; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(width - 1, Math.floor(fx));
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = fx - x0;
      const top = gray[y0 * width + x0] * (1 - wx) + gray[y0 * width + x1] * wx;
      const bot = gray[y1 * width + x0] * (1 - wx) + gray[y1 * width + x1] * wx;
      out[y * newW + x] = Math.round(top * (1 - wy) + bot * wy);
    }
  }
  return out;
}

/** Binary PGM (P5): tesseract (leptonica) reads it without any PNG encoding cost. */
function encodePgm(gray, width, height) {
  return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii'), Buffer.from(gray.buffer, gray.byteOffset, width * height)]);
}

function normalizeRegion(region, width, height) {
  if (region == null) return null;
  if (typeof region !== 'object') throw ocrError('region must be {x, y, width, height} in image pixels', 'INVALID_INPUT');
  const x = Math.max(0, Math.floor(Number(region.x) || 0));
  const y = Math.max(0, Math.floor(Number(region.y) || 0));
  const x1 = Math.min(width, Math.ceil((Number(region.x) || 0) + Number(region.width)));
  const y1 = Math.min(height, Math.ceil((Number(region.y) || 0) + Number(region.height)));
  if (!(x1 - x >= 1 && y1 - y >= 1)) throw ocrError(`region ${JSON.stringify(region)} lies outside the ${width}x${height} image`, 'OUT_OF_BOUNDS');
  if (x === 0 && y === 0 && x1 === width && y1 === height) return null;
  return { x, y, width: x1 - x, height: y1 - y };
}

function autoUpscale(engine, w, h, pixelScale, maxSide) {
  if (engine === 'vision') return 1; // Vision reads small text well at native size
  if (pixelScale >= 1.5) return 1; // HiDPI capture: text is already big enough
  if (w * h > UPSCALE_MAX_PIXELS || Math.max(w, h) * 2 > maxSide) return 1;
  return 2;
}

/**
 * The image an engine reads: cropped to the region, scaled, and for tesseract grayscale with normalized
 * polarity. `scale` is prepared px per source px; `offset` is the region origin in source px.
 */
function prepareImage(buf, hdr, region, { engine, upscale, pixelScale = 1, maxSide = MAX_SIDE }) {
  const srcW = region ? region.width : hdr.width;
  const srcH = region ? region.height : hdr.height;
  let scale = upscale === 'auto' || upscale == null ? autoUpscale(engine, srcW, srcH, pixelScale, maxSide) : clamp(Number(upscale) || 1, 0.25, 4);
  if (Math.max(srcW, srcH) * scale > maxSide) scale = maxSide / Math.max(srcW, srcH);
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));
  const offset = { x: region ? region.x : 0, y: region ? region.y : 0 };
  const sx = outW / srcW;
  const sy = outH / srcH;

  if (engine !== 'tesseract' && !region && outW === hdr.width && outH === hdr.height) {
    return { kind: 'png', data: buf, width: outW, height: outH, sx, sy, offset };
  }
  let img = png.decode(buf);
  if (region) img = png.crop(img, region.x, region.y, region.width, region.height);
  if (engine !== 'tesseract') {
    if (outW !== img.width || outH !== img.height) img = png.resize(img, outW, outH);
    return { kind: 'png', data: png.encode(img), width: outW, height: outH, sx, sy, offset };
  }
  // Tesseract: normalize polarity at source scale (blocks sized for the text), then scale the gray image.
  // The dark boxes also go into a composite of their own (inverted crops, read by one extra pass):
  // a filled button or a dark bar is read far more reliably on its own than inside the page.
  if (outW < img.width) img = png.resize(img, outW, outH); // downscale in color (area average) first
  let gray = toGray(img);
  const raw = gray.slice();
  const map = polarityMap(gray, img.width, img.height, 8 * clamp(pixelScale * (img.width / srcW), 0.75, 4));
  normalizePolarity(gray, img.width, img.height, undefined, map);
  const k = outW / img.width; // composite scale: the same as the main image
  let dark = darkComposite(raw, img.width, img.height, darkRegions(map, img.width, img.height));
  if (dark && k !== 1) {
    const w = Math.max(1, Math.round(dark.width * k));
    const h = Math.max(1, Math.round(dark.height * k));
    dark = { ...dark, gray: resizeGray(dark.gray, dark.width, dark.height, w, h), width: w, height: h };
  }
  if (outW !== img.width || outH !== img.height) gray = resizeGray(gray, img.width, img.height, outW, outH);
  const out = { kind: 'pgm', data: encodePgm(gray, outW, outH), width: outW, height: outH, sx, sy, offset };
  if (dark) out.dark = { data: encodePgm(dark.gray, dark.width, dark.height), width: dark.width, height: dark.height, composite: dark, scale: k };
  return out;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.debug(`could not remove ${dir}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- tesseract

/**
 * Words from `tesseract ... tsv` output (level 5 rows).
 * @returns {{text:string,x:number,y:number,w:number,h:number,conf:number,pass:number,block:number,par:number,line:number}[]}
 */
function parseTesseractTsv(tsv, { pass = 0 } = {}) {
  const words = [];
  for (const row of String(tsv || '').split(/\r?\n/)) {
    if (!row || row.startsWith('level')) continue;
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    // A box edge glued to a word ("|Settings") is not part of it.
    const text = c.slice(11).join(' ').trim().replace(/^[|¦]+(?=\S)|(?<=\S)[|¦]+$/g, '');
    const conf = Number(c[10]);
    const [x, y, w, h] = [c[6], c[7], c[8], c[9]].map(Number);
    if (!text || !Number.isFinite(conf) || conf < 0 || ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    words.push({ text, x, y, w, h, conf, pass, block: Number(c[2]), par: Number(c[3]), line: Number(c[4]) });
  }
  return words;
}

function alnumCount(s) {
  const m = String(s).match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

/** Rules, borders and box edges read as text: never worth keeping, and they would stretch a line's box. */
const SEPARATOR_ONLY = /^[|¦!:;.,'"`´~_=\-‐-―/\\()[\]{}<>]+$/;

/** Whether a tesseract word is worth keeping (drops the noise sparse/block modes read into icons and lines). */
function plausibleWord(w) {
  const an = alnumCount(w.text);
  if (!an) return w.conf >= 85 && Array.from(w.text).length <= 2 && !SEPARATOR_ONLY.test(w.text); // "+", "?", "@" icons
  if (w.conf >= MIN_WORD_CONF) return true;
  // Block modes give real words a confidence of 0 at times: keep word-like text, drop symbol soup.
  return an >= 3 && an / Array.from(w.text).length >= 0.6;
}

function overlapRatio(a, b) {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= 0 || iy <= 0) return 0;
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
}

/** Merge the words of several passes: the most confident reading of each spot wins. */
function mergeWords(words) {
  const sorted = words.filter(plausibleWord).sort((a, b) => b.conf - a.conf || a.pass - b.pass);
  const kept = [];
  for (const w of sorted) {
    if (kept.some((k) => overlapRatio(k, w) >= 0.5)) continue;
    kept.push(w);
  }
  return kept;
}

/**
 * Group words into lines by geometry: same row (vertical overlap) and a gap of at most about one line
 * height, so separate UI labels on one row stay separate lines.
 * @param {{text,x,y,w,h,conf}[]} words
 * @returns {{words:object[], x:number, y:number, w:number, h:number}[]} top to bottom
 */
function groupLines(words, { gapFactor = 1.0 } = {}) {
  const sorted = [...words].sort((a, b) => a.x - b.x || a.y - b.y);
  const lines = [];
  for (const w of sorted) {
    let best = null;
    let bestDy = Infinity;
    for (const L of lines) {
      const last = L.words[L.words.length - 1];
      const ref = Math.max(L.hMax, w.h);
      const gap = w.x - (last.x + last.w);
      if (gap < -0.3 * ref || gap > gapFactor * ref) continue;
      const ov = Math.min(L.y1, w.y + w.h) - Math.max(L.y0, w.y);
      if (ov < 0.5 * Math.min(w.h, L.y1 - L.y0)) continue;
      const dy = Math.abs(w.y + w.h / 2 - (L.y0 + L.y1) / 2);
      if (dy < bestDy) {
        best = L;
        bestDy = dy;
      }
    }
    if (best) {
      best.words.push(w);
      best.y0 = Math.min(best.y0, w.y);
      best.y1 = Math.max(best.y1, w.y + w.h);
      best.hMax = Math.max(best.hMax, w.h);
    } else {
      lines.push({ words: [w], y0: w.y, y1: w.y + w.h, hMax: w.h });
    }
  }
  return lines
    .map((L) => {
      const x0 = Math.min(...L.words.map((w) => w.x));
      const x1 = Math.max(...L.words.map((w) => w.x + w.w));
      return { words: L.words, x: x0, y: L.y0, w: x1 - x0, h: L.y1 - L.y0 };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** BCP-47 tags ("en-US", "de", "zh-Hans") from a comma-separated list; tesseract codes ("eng+deu") are not tags. */
function bcp47List(lang) {
  const out = [];
  for (const raw of String(lang || '').split(',')) {
    const t = raw.trim();
    if (/^[a-z]{2}$/i.test(t) || /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})+$/i.test(t)) out.push(t);
  }
  return out;
}

function tesseractPasses(env) {
  const raw = String(env.ANYWHERE_OCR_PSM || '').trim();
  if (!raw) return DEFAULT_PASSES;
  const list = raw.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 13);
  return list.length ? [...new Set(list)].slice(0, 4) : DEFAULT_PASSES;
}

function tesseractLanguage(requested, installed) {
  const want = String(requested || '').trim();
  if (want) {
    const parts = want.split('+').map((s) => s.trim()).filter((s) => installed.includes(s));
    if (parts.length) return parts.join('+');
  }
  if (installed.includes('eng')) return 'eng';
  return installed[0];
}

async function runTesseract(prep, info, opts, ctx, dir) {
  const file = path.join(dir, 'image.pgm');
  fs.writeFileSync(file, prep.data, { mode: 0o600 });
  const lang = tesseractLanguage(opts.lang || ctx.env.ANYWHERE_OCR_LANG, info.languages || []);
  const dpi = Math.round(clamp(96 * (opts.pixelScale || 1) * prep.sx, 70, 1200));
  // One thread per process: the passes run side by side, and OpenMP threads of several tesseract
  // processes competing for the cores can make a sub-second job take minutes.
  const env = { ...ctx.env, OMP_THREAD_LIMIT: '1' };
  const passes = tesseractPasses(ctx.env);
  const jobs = passes.map((psm) => ({ psm, file, label: `psm ${psm}` }));
  if (prep.dark) {
    // The dark boxes, stacked and inverted: a uniform block of text lines (--psm 6).
    const darkFile = path.join(dir, 'dark.pgm');
    fs.writeFileSync(darkFile, prep.dark.data, { mode: 0o600 });
    jobs.push({ psm: 6, file: darkFile, label: 'dark regions', dark: true });
  }
  const runs = await Promise.all(
    jobs.map((j) =>
      ctx.run(info.exe, [j.file, 'stdout', '-l', lang, '--psm', String(j.psm), '--dpi', String(dpi), 'tsv'], { timeoutMs: opts.timeoutMs, env, cwd: dir }),
    ),
  );
  const words = [];
  const errors = [];
  runs.forEach((r, i) => {
    const j = jobs[i];
    if (r.code !== 0 || r.timedOut) {
      errors.push(`${j.label}: ${runFailure(r)}`);
      return;
    }
    const parsed = parseTesseractTsv(r.stdout, { pass: j.dark ? 100 : j.psm });
    words.push(...(j.dark ? mapDarkWords(parsed, prep.dark.composite, prep.dark.scale) : parsed));
  });
  if (errors.length === runs.length) throw ocrError(`tesseract failed (${errors.join('; ')})`, 'OCR_FAILED');
  if (errors.length) log.warn(`some tesseract passes failed: ${errors.join('; ')}`);
  const lines = groupLines(mergeWords(words)).map((L) => {
    const ws = L.words.map((w) => ({ text: w.text, bounds: { x: w.x, y: w.y, width: w.w, height: w.h }, confidence: round2(clamp(w.conf, 0, 100) / 100) }));
    return { text: ws.map((w) => w.text).join(' '), bounds: { x: L.x, y: L.y, width: L.w, height: L.h }, confidence: meanConfidence(ws), words: ws };
  });
  return { lines, language: lang };
}

// ---------------------------------------------------------------- Vision (macOS)

/** Split a line box into word boxes by character offsets (when the engine gave none). */
function proportionalBox(lineBox, start, end, length) {
  const n = Math.max(1, length);
  return { x: lineBox.x + (lineBox.width * start) / n, y: lineBox.y, width: Math.max(1, (lineBox.width * (end - start)) / n), height: lineBox.height };
}

/**
 * darwin-ocr.js output -> lines in pixels of the image it read (Vision boxes are normalized with the
 * origin at the bottom-left).
 */
function parseVisionOutput(stdout, width, height) {
  const j = typeof stdout === 'string' ? lastJson(stdout) : stdout;
  if (!j) throw ocrError('The Vision helper printed no result', 'OCR_FAILED');
  if (j.ok !== true) throw ocrError(j.error || 'Vision text recognition failed', j.code || 'OCR_FAILED', j.hint);
  const toPx = (b) => {
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) return null;
    const [x, y, w, h] = b;
    return { x: x * width, y: (1 - y - h) * height, width: w * width, height: h * height };
  };
  const lines = [];
  for (const l of Array.isArray(j.lines) ? j.lines : []) {
    const text = String(l.text || '').trim();
    const bounds = toPx(l.box);
    if (!text || !bounds) continue;
    const conf = Number.isFinite(l.confidence) ? round2(clamp(l.confidence, 0, 1)) : null;
    const len = String(l.text).length;
    const list = (Array.isArray(l.words) && l.words.length ? l.words : [{ text: l.text, start: 0, end: len, box: l.box }]).filter((w) => String(w.text || '').trim());
    const words = list.map((w) => {
      let b = toPx(w.box);
      // Vision quirks: a word box much taller than or off its line, or (several words) the whole line's
      // box for each word. Fall back to the word's share of the line by characters.
      const wholeLine = b && list.length > 1 && b.width >= 0.95 * bounds.width;
      if (!b || wholeLine || b.height > bounds.height * 2 || b.y + b.height < bounds.y || b.y > bounds.y + bounds.height) {
        b = proportionalBox(bounds, Number(w.start) || 0, Number.isFinite(w.end) ? w.end : len, len);
      }
      return { text: String(w.text).trim(), bounds: b, confidence: conf };
    });
    lines.push({ text, bounds, confidence: conf, words });
  }
  return { lines };
}

async function runVision(prep, info, opts, ctx, dir) {
  const file = path.join(dir, 'image.png');
  fs.writeFileSync(file, prep.data, { mode: 0o600 });
  const visionOpts = { minTextHeight: clamp(6 / prep.height, 0, 0.03), correction: true };
  const langs = bcp47List(opts.lang || ctx.env.ANYWHERE_OCR_LANG);
  if (langs.length) visionOpts.languages = langs;
  const r = await ctx.run(info.exe, ['-l', 'JavaScript', VISION_SCRIPT, file, JSON.stringify(visionOpts)], { timeoutMs: opts.timeoutMs });
  if (!lastJson(r.stdout)) throw ocrError(`The Vision helper failed (${runFailure(r)})`, 'OCR_FAILED');
  return parseVisionOutput(r.stdout, prep.width, prep.height);
}

// ---------------------------------------------------------------- Windows.Media.Ocr

/** win32-ocr.ps1 output -> lines in pixels of the image it read. Windows OCR gives no confidence. */
function parseWindowsOutput(stdout) {
  const j = typeof stdout === 'string' ? lastJson(stdout) : stdout;
  if (!j) throw ocrError('The Windows OCR script printed no result', 'OCR_FAILED');
  if (j.ok !== true) {
    const hint = j.hint || (j.code === 'NO_LANGUAGE' ? HINT_WINDOWS_LANGUAGE : undefined);
    throw ocrError(j.error || 'Windows OCR failed', j.code || 'OCR_FAILED', hint);
  }
  const lines = [];
  for (const l of Array.isArray(j.lines) ? j.lines : []) {
    const words = (Array.isArray(l.words) ? l.words : [])
      .filter((w) => String(w.text || '').trim() && [w.x, w.y, w.w, w.h].every(Number.isFinite) && w.w > 0 && w.h > 0)
      .map((w) => ({ text: String(w.text).trim(), bounds: { x: w.x, y: w.y, width: w.w, height: w.h }, confidence: null }));
    if (!words.length) continue;
    // Windows joins CJK words without spaces in line.Text; keep its text, fall back to the words.
    const text = String(l.text || '').trim() || words.map((w) => w.text).join(' ');
    lines.push({ text, bounds: rectUnion(words.map((w) => w.bounds)), confidence: null, words });
  }
  return { lines, language: j.language || null };
}

async function runWindows(prep, info, opts, ctx) {
  const ws = await windowsWorkspace(ctx);
  try {
    const file = path.join(ws.dir, 'image.png');
    fs.writeFileSync(file, prep.data, { mode: 0o600 });
    const extra = ['-ImagePath', await ws.winPath(file), '-TimeoutMs', String(Math.max(5000, opts.timeoutMs - 5000))];
    const lang = bcp47List(opts.lang || ctx.env.ANYWHERE_OCR_LANG)[0];
    if (lang) extra.push('-Language', lang);
    const r = await ctx.run(info.exe, windowsArgs(await ws.winPath(ws.script), extra), { timeoutMs: opts.timeoutMs, cwd: ws.cwd });
    if (!lastJson(r.stdout)) {
      throw ocrError(`Windows OCR failed (${runFailure(r)})`, 'OCR_FAILED', ctx.isWSL ? HINT_WSL_INTEROP : undefined);
    }
    return parseWindowsOutput(r.stdout);
  } finally {
    removeDir(ws.dir);
  }
}

// ---------------------------------------------------------------- recognize

/**
 * Recognize the text in a PNG.
 * @param {{png:Buffer, region?:{x,y,width,height}, engine?:string, lang?:string, upscale?:number|'auto',
 *   pixelScale?:number, timeoutMs?:number}} opts region in pixels of the PNG; pixelScale = image px per
 *   logical px (HiDPI captures need no upscaling)
 * @param {object} [ctxOverrides] test hooks (see makeContext)
 * @returns {Promise<{engine:string|null, width:number, height:number, region:object|null, lines:object[], hint?:string, notes?:string[], language?:string}>}
 */
async function recognize(opts = {}, ctxOverrides) {
  const o = opts || {};
  if (!Buffer.isBuffer(o.png)) throw ocrError('recognize needs {png: Buffer}', 'INVALID_INPUT');
  const hdr = png.readHeader(o.png);
  const region = normalizeRegion(o.region, hdr.width, hdr.height);
  const ctx = makeContext(ctxOverrides);
  let plan = enginePlan(ctx);
  if (o.engine) {
    const want = ENGINE_ALIASES[String(o.engine).toLowerCase()];
    if (!want) throw ocrError(`engine must be one of ${ENGINES.join(', ')} (got ${JSON.stringify(o.engine)})`, 'INVALID_INPUT');
    plan = [want];
  }
  const base = { width: hdr.width, height: hdr.height, region };
  if (!plan.length) return { engine: null, ...base, lines: [], hint: OFF_HINT };

  const timeoutMs = clamp(Number(o.timeoutMs) || OCR_TIMEOUT_MS, 5000, 300000);
  const pixelScale = Number(o.pixelScale) > 0 ? Number(o.pixelScale) : 1;
  const missing = [];
  const notes = [];
  // Engines in order of preference; one that fails at run time hands over to the next.
  for (const engine of plan) {
    const info = await probeEngine(engine, ctx, false);
    if (!info.ok) {
      missing.push(entryOf(engine, info));
      continue;
    }
    const maxSide = engine === 'windows' ? Math.min(MAX_SIDE, info.maxDimension || 10000) : MAX_SIDE;
    let dir = null;
    try {
      const prep = prepareImage(o.png, hdr, region, { engine, upscale: o.upscale, pixelScale, maxSide });
      const ropts = { lang: o.lang, timeoutMs, pixelScale };
      let res;
      if (engine === 'windows') {
        res = await runWindows(prep, info, ropts, ctx);
      } else {
        dir = fs.mkdtempSync(path.join(ctx.tmpdir, 'anywhere-ocr-'));
        res = engine === 'vision' ? await runVision(prep, info, ropts, ctx, dir) : await runTesseract(prep, info, ropts, ctx, dir);
      }
      const back = (b) => roundRect({ x: prep.offset.x + b.x / prep.sx, y: prep.offset.y + b.y / prep.sy, width: b.width / prep.sx, height: b.height / prep.sy });
      const lines = res.lines.map((l) => ({
        text: l.text,
        bounds: back(l.bounds),
        confidence: l.confidence,
        words: l.words.map((w) => ({ text: w.text, bounds: back(w.bounds), confidence: w.confidence })),
      }));
      const out = { engine, ...base, lines };
      if (res.language) out.language = res.language;
      if (notes.length) out.notes = notes;
      return out;
    } catch (err) {
      notes.push(`${engine}: ${err.message}`);
      log.warn(`OCR with ${engine} failed: ${err.message}`);
      ctx.cache.delete(engine); // probe again next time: the engine may be gone or broken
      if (o.engine) throw ocrError(`Text recognition with ${engine} failed: ${err.message}`, err.code || 'OCR_FAILED', err.hint || HINT_FALLBACK);
      if (err.code === 'INVALID_INPUT' || err.code === 'OUT_OF_BOUNDS') throw err;
    } finally {
      if (dir) removeDir(dir);
    }
  }
  if (!notes.length) return { engine: null, ...base, lines: [], hint: unavailableHint(missing) };
  throw ocrError(`Text recognition failed (${notes.join('; ')})`, 'OCR_FAILED', 'Take a screenshot and read the text from the image instead.');
}

// ---------------------------------------------------------------- matching

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/g;

/** Case-, width- and whitespace-insensitive form of a text for matching. */
function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const DIGIT_RE = /\p{Nd}/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
/** Letters OCR misreads for a digit (and back). A digit never turns into another digit: ABC-123 is not ABC-124. */
const DIGIT_LOOKALIKES = { 0: 'oqd', 1: 'lij|!', 2: 'z', 5: 's', 6: 'gb', 8: 'b', 9: 'gq', 7: 't', 4: 'a' };
const BLOCKED = 100;

function isDigit(c) {
  return DIGIT_RE.test(c);
}

function substitutionCost(a, b) {
  if (a === b) return 0;
  const da = isDigit(a);
  const db = isDigit(b);
  if (da && db) return BLOCKED;
  if (da || db) {
    const digit = da ? a : b;
    const other = da ? b : a;
    return (DIGIT_LOOKALIKES[digit] || '').includes(other) ? 1 : BLOCKED;
  }
  return 1;
}

/**
 * Edit distance with OCR-aware costs (digits may only be misread as look-alike letters, never
 * inserted, dropped or swapped for another digit). Returns max + 1 as soon as it exceeds `max`.
 */
function levenshtein(a, b, max = Infinity) {
  const s = Array.from(String(a));
  const t = Array.from(String(b));
  const indel = (c) => (isDigit(c) ? BLOCKED : 1);
  let prev = new Array(t.length + 1);
  prev[0] = 0;
  for (let j = 1; j <= t.length; j++) prev[j] = prev[j - 1] + indel(t[j - 1]);
  for (let i = 1; i <= s.length; i++) {
    const cur = new Array(t.length + 1);
    cur[0] = prev[0] + indel(s[i - 1]);
    let rowMin = cur[0];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + indel(s[i - 1]), cur[j - 1] + indel(t[j - 1]), prev[j - 1] + substitutionCost(s[i - 1], t[j - 1]));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return Math.min(prev[t.length], max + 1);
}

/** Typos tolerated in a word of `len` characters: none up to 2, one for short words, two from 8. */
function allowedDistance(len) {
  if (len <= 2) return 0;
  if (len <= 7) return 1;
  return 2;
}

const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

/** A normalized text without punctuation and symbols at the start and end of each word. */
function stripEdges(s) {
  return s
    .split(' ')
    .map((t) => t.replace(EDGE_PUNCT, ''))
    .filter(Boolean)
    .join(' ');
}

function scoreSpan(joined, words, q, qTokens, qCompact, exact) {
  if (joined === q) return { score: 1, kind: 'exact' };
  const compact = joined.replace(/ /g, '');
  if (compact === qCompact) return { score: 0.95, kind: 'exact' }; // OCR split or merged a word
  // Punctuation glued to the words ("Settings:", "(Draft)", "Save…") is not part of what was asked for.
  if (stripEdges(joined) === stripEdges(q) && stripEdges(q)) return { score: 0.97, kind: 'exact' };
  if (exact) return null;
  const idx = joined.indexOf(q);
  if (idx >= 0) {
    const end = idx + q.length;
    // Only the smallest span: the match must start in the first word and end in the last one.
    if (idx > words[0].length || end < joined.length - words[words.length - 1].length) return null;
    const before = idx > 0 ? joined[idx - 1] : '';
    const after = end < joined.length ? joined[end] : '';
    // "ABC-12" is not part of "ABC-123", nor "23" of "123".
    if ((before && isDigit(before) && isDigit(q[0])) || (after && isDigit(after) && isDigit(q[q.length - 1]))) return null;
    const whole = (!before || !ALNUM_RE.test(before)) && (!after || !ALNUM_RE.test(after));
    const extra = 1 - q.length / joined.length;
    return { score: round2((whole ? 0.9 : 0.72) - 0.1 * extra), kind: 'contains', idx };
  }
  if (words.length === qTokens.length) {
    // Word by word: each word within its own allowance (one slip in a short word), at most 3 in all.
    let total = 0;
    for (let k = 0; k < words.length; k++) {
      const allowed = allowedDistance(Array.from(qTokens[k]).length);
      const d = levenshtein(words[k], qTokens[k], allowed);
      if (d > allowed) return null;
      total += d;
    }
    if (total < 1 || total > 3) return null;
    return { score: round2(Math.max(0.5, 0.8 - 0.1 * total)), kind: 'fuzzy', distance: total };
  }
  // OCR split or merged a word and also slipped once ("Fo ryou" for "For you"): one edit, no lost word.
  if (Math.abs(words.length - qTokens.length) === 1 && Array.from(qCompact).length >= 4 && levenshtein(compact, qCompact, 1) === 1) {
    return { score: 0.7, kind: 'fuzzy', distance: 1 };
  }
  return null;
}

/**
 * Find a text in OCR lines.
 * @param {{text:string, words?:{text:string}[]}[]} lines each line and word carries a box under `boxKey`
 * @param {string} query
 * @param {{exact?:boolean, limit?:number, boxKey?:'shot'|'bounds'}} [opts]
 * @returns {{text:string, box:object, score:number, match:'exact'|'contains'|'fuzzy', confidence:number|null, ocrConfidence:number|null, line:string, lineIndex:number}[]}
 */
function matchText(lines, query, { exact = false, limit = DEFAULT_LIMIT, boxKey = 'bounds' } = {}) {
  const q = normalizeText(query);
  if (!q) return [];
  const qTokens = q.split(' ');
  const qCompact = q.replace(/ /g, '');
  const maxSpan = qTokens.length + 2;
  const out = [];
  (lines || []).forEach((line, lineIndex) => {
    const words = line.words && line.words.length ? line.words : [{ text: line.text, [boxKey]: line[boxKey], confidence: line.confidence }];
    const norm = words.map((w) => normalizeText(w.text));
    const cands = [];
    for (let i = 0; i < words.length; i++) {
      if (!norm[i]) continue;
      let joined = '';
      for (let j = i; j < words.length && j - i < maxSpan; j++) {
        if (!norm[j]) break;
        joined = j === i ? norm[i] : `${joined} ${norm[j]}`;
        const s = scoreSpan(joined, norm.slice(i, j + 1), q, qTokens, qCompact, exact);
        if (s) cands.push({ i, j, joined, ...s });
      }
    }
    cands.sort((a, b) => b.score - a.score || a.j - a.i - (b.j - b.i));
    const used = [];
    for (const c of cands) {
      if (used.some((u) => c.i <= u.j && u.i <= c.j)) continue;
      used.push(c);
      const span = words.slice(c.i, c.j + 1);
      let box = rectUnion(span.map((w) => w[boxKey]));
      if (!box) continue;
      if (c.kind === 'contains' && c.i === c.j && c.joined.length > q.length) {
        // Part of a single word ("Settings" in "panel:Settings"): narrow the box to that share of it.
        const n = c.joined.length;
        box = { x: box.x + (box.width * c.idx) / n, y: box.y, width: Math.max(1, (box.width * q.length) / n), height: box.height };
      }
      const ocrConfidence = meanConfidence(span);
      out.push({
        text: span.map((w) => String(w.text)).join(' '),
        box,
        score: c.score,
        match: c.kind,
        confidence: round2(c.score * (ocrConfidence == null ? 1 : ocrConfidence)),
        ocrConfidence,
        line: line.text,
        lineIndex,
      });
    }
  });
  out.sort((a, b) => b.score - a.score || (b.confidence || 0) - (a.confidence || 0) || a.box.y - b.box.y || a.box.x - b.box.x);
  const n = clamp(Math.floor(Number(limit) || DEFAULT_LIMIT), 1, MAX_LIMIT);
  return out.slice(0, n);
}

/** Lines in reading order: rows top to bottom (centres within half a line height), each left to right. */
function readingOrder(lines, boxKey = 'bounds') {
  const sorted = [...lines].sort((a, b) => a[boxKey].y + a[boxKey].height / 2 - (b[boxKey].y + b[boxKey].height / 2));
  const rows = [];
  for (const l of sorted) {
    const b = l[boxKey];
    const cy = b.y + b.height / 2;
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy - row.cy) <= 0.5 * Math.min(b.height, row.h)) {
      row.items.push(l);
    } else {
      rows.push({ cy, h: b.height, items: [l] });
    }
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a[boxKey].x - b[boxKey].x));
}

// ---------------------------------------------------------------- screen: Computer integration

function displayIndex(display, info) {
  const count = info && Array.isArray(info.displays) ? info.displays.length : 1;
  let idx;
  if (display == null || display === '') idx = info && info.lastShot && Number.isInteger(info.lastShot.display) ? info.lastShot.display : 0;
  else idx = typeof display === 'string' && display.trim() !== '' ? Number(display) : display;
  if (!Number.isInteger(idx) || idx < 0) throw ocrError(`display must be a display index such as 0 or 1 (got ${JSON.stringify(display)})`, 'INVALID_INPUT');
  if (idx >= count) {
    throw ocrError(
      `Display ${idx} does not exist; there ${count === 1 ? 'is 1 display (index 0)' : `are ${count} displays (indexes 0-${count - 1})`}.`,
      'INVALID_INPUT',
      'Call screen_info to list displays.',
    );
  }
  return idx;
}

/** A region in screenshot space, clamped to the screenshot (the same rules as Computer.screenshot). */
function shotRegion(region, full, idx, mapped) {
  if (typeof region !== 'object' || Array.isArray(region)) throw ocrError('region must be an object {x, y, width, height} in screenshot pixels', 'INVALID_INPUT');
  const v = ['x', 'y', 'width', 'height'].map((k) => Number(region[k]));
  if (!v.every(Number.isFinite)) throw ocrError('region needs numeric x, y, width and height (screenshot pixels)', 'INVALID_INPUT');
  const [x, y, w, h] = v;
  if (w <= 0 || h <= 0) throw ocrError(`region width and height must be positive (got ${w}x${h})`, 'INVALID_INPUT');
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(full.width, Math.round(x + w));
  const y1 = Math.min(full.height, Math.round(y + h));
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    const where = mapped ? `the last screenshot (${full.width}x${full.height})` : `display ${idx} (${full.width}x${full.height} logical px)`;
    throw ocrError(`region ${x},${y} ${w}x${h} lies outside ${where} of display ${idx}. Take a new screenshot.`, 'OUT_OF_BOUNDS');
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * OCR a display (or a region of it, in screenshot space) and return its lines in screenshot space:
 * the coordinates click() takes for that display.
 * @param {object} computer a Computer (src/os/computer.js)
 * @param {{display?:number, region?:{x,y,width,height}, lang?:string, engine?:string}} [opts]
 * @param {{recognize?:Function}} [deps] test hooks
 * @returns {Promise<{engine:string|null, hint?:string, display:number, region:object, mapped:boolean,
 *   lines:{text:string, confidence:number|null, shot:object, words:{text:string, confidence:number|null, shot:object}[]}[], notes?:string[]}>}
 *   mapped: false when no screenshot of the display exists yet (shot space = display-local logical pixels);
 *   lastDisplay: the display of the latest full screenshot (the one click() uses without `display`), or null
 */
async function scanScreen(computer, opts = {}, deps = {}) {
  if (!computer || typeof computer.screenshot !== 'function') throw ocrError('Text search needs a Computer (src/os/computer.js)', 'INVALID_INPUT');
  const o = opts || {};
  const info = typeof computer.screenInfo === 'function' ? await computer.screenInfo() : null;
  const idx = displayIndex(o.display, info);
  const d = info && info.displays ? info.displays[idx] : null;
  const last = d && d.lastShot ? d.lastShot : null;
  const full = last ? { x: 0, y: 0, width: last.width, height: last.height } : d ? { x: 0, y: 0, width: d.width, height: d.height } : null;
  if (!full) throw ocrError('Take a screenshot first, so the screen size is known.', 'INVALID_INPUT');
  const region = o.region != null ? shotRegion(o.region, full, idx, Boolean(last)) : null;
  // Always the whole display, as a region shot: a region capture leaves the screenshot coordinate
  // mapping alone and comes back at native resolution (Computer.screenshot only downscales beyond
  // maxWidth/maxHeight), and the whole display maps exactly, while a partial capture carries the
  // rounding of its native crop. recognize() crops the requested region itself.
  const shot = await computer.screenshot({ display: idx, region: full, maxWidth: MAX_SIDE, maxHeight: MAX_SIDE });
  const cap = shot.region || full;
  const kx = cap.width / shot.width; // screenshot px per image px
  const ky = cap.height / shot.height;
  const imageRegion = region ? { x: (region.x - cap.x) / kx, y: (region.y - cap.y) / ky, width: region.width / kx, height: region.height / ky } : undefined;
  const pixelScale = Number(shot.scale) > 0 ? 1 / Number(shot.scale) : 1;
  const recognizeFn = deps.recognize || recognize;
  const res = await recognizeFn({ png: shot.png, region: imageRegion, pixelScale, lang: o.lang, engine: o.engine });
  const reg = region || cap;
  const lastDisplay = info && info.lastShot && Number.isInteger(info.lastShot.display) ? info.lastShot.display : null;
  const base = { display: idx, region: reg, mapped: Boolean(last), lastDisplay };
  if (!res || !res.engine) return { engine: null, hint: (res && res.hint) || `No OCR engine is available. ${HINT_FALLBACK}`, ...base, lines: [] };
  const toShot = (b) => {
    const x = cap.x + b.x * kx;
    const y = cap.y + b.y * ky;
    const w = Math.max(1, b.width * kx);
    const h = Math.max(1, b.height * ky);
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(w)),
      height: Math.max(1, Math.round(h)),
      cx: clamp(Math.round(x + w / 2), reg.x, reg.x + reg.width - 1),
      cy: clamp(Math.round(y + h / 2), reg.y, reg.y + reg.height - 1),
    };
  };
  const lines = (res.lines || []).map((l) => ({
    text: l.text,
    confidence: l.confidence == null ? null : l.confidence,
    shot: toShot(l.bounds),
    words: (l.words || []).map((w) => ({ text: w.text, confidence: w.confidence == null ? null : w.confidence, shot: toShot(w.bounds) })),
  }));
  const out = { engine: res.engine, ...base, lines: readingOrder(lines, 'shot') };
  if (res.notes && res.notes.length) out.notes = res.notes;
  return out;
}

function checkQuery(text) {
  if (typeof text !== 'string' || !normalizeText(text)) throw ocrError('text must be a non-empty string', 'INVALID_INPUT');
  if (text.length > MAX_QUERY_CHARS) throw ocrError(`text must be at most ${MAX_QUERY_CHARS} characters`, 'INVALID_INPUT');
}

/**
 * Find visible text on a display. Matching ignores case and extra whitespace, tolerates one OCR slip
 * in a short word (two from 8 letters, never a different digit) unless `exact`.
 * @param {object} computer a Computer
 * @param {{text:string, display?:number, region?:object, exact?:boolean, limit?:number, lang?:string}} opts
 * @param {{recognize?:Function}} [deps] test hooks
 * @returns {Promise<{text:string, shot:{x,y,width,height,cx,cy}, confidence:number, score:number,
 *   match:string, display:number, line:string}[]>} best first; the array's non-enumerable `scan`
 *   property holds the whole scanScreen() result. Throws OCR_UNAVAILABLE (with .hint) without an engine.
 */
async function findText(computer, opts = {}, deps = {}) {
  const o = opts || {};
  checkQuery(o.text);
  const scan = await scanScreen(computer, o, deps);
  if (!scan.engine) {
    throw ocrError('No OCR engine is available to search the screen for text.', 'OCR_UNAVAILABLE', scan.hint);
  }
  const matches = matchText(scan.lines, o.text, { exact: Boolean(o.exact), limit: o.limit, boxKey: 'shot' }).map((m) => ({
    text: m.text,
    shot: withCenter(m.box, scan.region),
    confidence: m.confidence,
    score: m.score,
    match: m.match,
    display: scan.display,
    line: m.line,
  }));
  Object.defineProperty(matches, 'scan', { value: scan, enumerable: false });
  return matches;
}

function withCenter(b, reg) {
  const x = Math.round(b.x);
  const y = Math.round(b.y);
  const width = Math.max(1, Math.round(b.width));
  const height = Math.max(1, Math.round(b.height));
  return {
    x,
    y,
    width,
    height,
    cx: clamp(Math.round(b.x + b.width / 2), reg.x, reg.x + reg.width - 1),
    cy: clamp(Math.round(b.y + b.height / 2), reg.y, reg.y + reg.height - 1),
  };
}

/**
 * All text lines on a display (or region), in reading order, in screenshot space.
 * @returns {Promise<{engine:string|null, hint?:string, display:number, region:object, mapped:boolean,
 *   lines:{text:string, shot:object, confidence:number|null}[]}>}
 */
async function readScreenText(computer, opts = {}, deps = {}) {
  const scan = await scanScreen(computer, opts, deps);
  const out = { ...scan, lines: scan.lines.map((l) => ({ text: l.text, shot: l.shot, confidence: l.confidence })) };
  return out;
}

/** Forget probe results (tests, or after installing an engine). */
function _resetCache() {
  probeCache.clear();
  wslTempCache = undefined;
}

module.exports = {
  available,
  recognize,
  findText,
  scanScreen,
  readScreenText,
  // helpers (exported for tests and reuse)
  matchText,
  normalizeText,
  levenshtein,
  allowedDistance,
  readingOrder,
  enginePlan,
  parseTesseractTsv,
  parseTesseractLangs,
  mergeWords,
  groupLines,
  plausibleWord,
  parseVisionOutput,
  parseWindowsOutput,
  toGray,
  polarityMap,
  normalizePolarity,
  darkRegions,
  darkComposite,
  mapDarkWords,
  resizeGray,
  encodePgm,
  shotRegion,
  prepareImage,
  lastJson,
  wslToWindowsPath,
  windowsToWslPath,
  locateWindowsPowerShell,
  locateTesseract,
  tesseractLanguage,
  tesseractPasses,
  bcp47List,
  _resetCache,
  ENGINES,
  VISION_SCRIPT,
  WINDOWS_SCRIPT,
  MAX_SIDE,
  DEFAULT_PASSES,
};
