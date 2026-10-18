'use strict';

/**
 * Linux desktop driver (docs/ARCHITECTURE.md §4).
 *
 * X11 (primary): xrandr / xdotool / wmctrl / xprop / xclip|xsel and the first
 * screenshot tool that works (maim, ImageMagick import, ffmpeg x11grab, scrot,
 * xwd+convert, gnome-screenshot).
 *
 * Wayland (best effort): grim / gnome-screenshot / spectacle for pixels,
 * swaymsg / hyprctl / ydotool (>= 1.0) / wtype for input, swaymsg / hyprctl for windows,
 * wl-clipboard (or XWayland xclip) for the clipboard.
 *
 * Every external call is bounded by a timeout; missing tools raise
 * Error{code:'UNSUPPORTED', hint:'sudo apt install …'}.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const proc = require('../shared/proc');
const { createLogger } = require('../shared/log');
const { sleep, truncate } = require('../shared/util');

const log = createLogger('os-linux');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const X11_CAPTURE_TOOLS = ['maim', 'import', 'ffmpeg', 'scrot', 'xwd', 'gnome-screenshot'];
const TYPE_CHUNK = 200;
const DRAG_STEPS = 12;
const DRAG_STEP_MS = 15;
const DISPLAY_CACHE_MS = 2000;
const CAPTURE_TIMEOUT_MS = 10000;
const MAX_NOTCHES = 200;
/** How often a missing tool is looked up again (proc.which caches misses for the life of the process). */
const WHICH_MISS_TTL_MS = 10000;

// ---------------------------------------------------------------------------
// Package hints
// ---------------------------------------------------------------------------

const PM_INSTALL = {
  apt: 'sudo apt install',
  dnf: 'sudo dnf install',
  yum: 'sudo yum install',
  pacman: 'sudo pacman -S',
  zypper: 'sudo zypper install',
  apk: 'sudo apk add',
};

/** tool → package name per package manager (a plain string means "same everywhere"). */
const PACKAGES = {
  xdotool: 'xdotool',
  wmctrl: 'wmctrl',
  xclip: 'xclip',
  xsel: 'xsel',
  xprop: { apt: 'x11-utils', dnf: 'xprop', pacman: 'xorg-xprop', zypper: 'xprop', apk: 'xprop' },
  xwininfo: { apt: 'x11-utils', dnf: 'xwininfo', pacman: 'xorg-xwininfo', zypper: 'xwininfo', apk: 'xwininfo' },
  xrandr: { apt: 'x11-xserver-utils', dnf: 'xrandr', pacman: 'xorg-xrandr', zypper: 'xrandr', apk: 'xrandr' },
  imagemagick: { apt: 'imagemagick', dnf: 'ImageMagick', pacman: 'imagemagick', zypper: 'ImageMagick', apk: 'imagemagick' },
  maim: 'maim',
  scrot: 'scrot',
  ffmpeg: 'ffmpeg',
  'notify-send': { apt: 'libnotify-bin', dnf: 'libnotify', pacman: 'libnotify', zypper: 'libnotify-tools', apk: 'libnotify' },
  'espeak-ng': 'espeak-ng',
  grim: 'grim',
  'wl-clipboard': 'wl-clipboard',
  wtype: 'wtype',
  ydotool: 'ydotool',
  'gnome-screenshot': 'gnome-screenshot',
  spectacle: { apt: 'kde-spectacle', dnf: 'spectacle', pacman: 'spectacle', zypper: 'spectacle', apk: 'spectacle' },
  'wlr-randr': 'wlr-randr',
};

/**
 * Detect the system package manager.
 * @param {(name:string)=>string|null} [whichFn]
 * @returns {'apt'|'dnf'|'yum'|'pacman'|'zypper'|'apk'|null}
 */
function detectPackageManager(whichFn = proc.which) {
  if (whichFn('apt-get') || whichFn('apt')) return 'apt';
  if (whichFn('dnf')) return 'dnf';
  if (whichFn('yum')) return 'yum';
  if (whichFn('pacman')) return 'pacman';
  if (whichFn('zypper')) return 'zypper';
  if (whichFn('apk')) return 'apk';
  return null;
}

/**
 * Build an install command for the given tools, e.g. "sudo apt install xdotool wmctrl".
 * @param {string[]} tools keys of PACKAGES (unknown names are used verbatim)
 * @param {string|null} pm package manager from detectPackageManager()
 * @returns {string}
 */
function installHint(tools, pm) {
  const names = [];
  for (const t of tools) {
    const spec = PACKAGES[t];
    const key = pm === 'yum' ? 'dnf' : pm;
    const pkg = spec == null ? t : typeof spec === 'string' ? spec : spec[key] || spec.apt;
    if (!names.includes(pkg)) names.push(pkg);
  }
  if (!names.length) return '';
  if (pm && PM_INSTALL[pm]) return `${PM_INSTALL[pm]} ${names.join(' ')}`;
  return `Install with your package manager: ${names.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Errors and small helpers
// ---------------------------------------------------------------------------

function unsupportedError(message, hint) {
  const err = new Error(message);
  err.code = 'UNSUPPORTED';
  err.hint = hint || '';
  return err;
}

function ok(r) {
  return Boolean(r) && !r.error && !r.timedOut && r.code === 0;
}

function firstLine(s) {
  return String(s || '').trim().split('\n')[0] || '';
}

function commandError(cmd, args, r, hint) {
  if (r.error && r.error.code === 'ENOENT') return unsupportedError(`${cmd} is not installed`, hint || '');
  let err;
  if (r.timedOut) {
    err = new Error(`${cmd} ${args[0] || ''} timed out`.trim());
    err.code = 'TIMEOUT';
  } else {
    const detail = firstLine(r.stderr) || firstLine(typeof r.stdout === 'string' ? r.stdout : '') || (r.error && r.error.message) || '';
    err = new Error(`${cmd} ${args[0] || ''} failed (exit ${r.code})${detail ? `: ${truncate(detail, 300)}` : ''}`);
    err.code = 'COMMAND_FAILED';
  }
  if (hint) err.hint = hint;
  return err;
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** Split text into chunks of at most n code points (never splits surrogate pairs). */
function chunkText(text, n = TYPE_CHUNK) {
  const cps = Array.from(String(text));
  const out = [];
  for (let i = 0; i < cps.length; i += n) out.push(cps.slice(i, i + n).join(''));
  return out;
}

/** Validate a PNG buffer (signature, IHDR, trailing IEND) and read its size. */
function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 45) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height || width > 100000 || height > 100000) return null;
  if (buf.toString('latin1', buf.length - 8, buf.length - 4) !== 'IEND') return null;
  return { width, height };
}

function tempPngPath(tag) {
  return path.join(os.tmpdir(), `anywhere-${tag}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.png`);
}

async function readAndRemove(file) {
  try {
    return await fs.promises.readFile(file);
  } finally {
    fs.promises.rm(file, { force: true }).catch(() => {});
  }
}

/** Run fn over items with at most `limit` in flight; preserves order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

let pngModule;
function loadPng() {
  if (pngModule) return pngModule;
  try {
    const m = require('./png');
    if (m && typeof m.decode === 'function' && typeof m.encode === 'function' && typeof m.crop === 'function') {
      pngModule = m;
      return m;
    }
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') log.warn('png module failed to load:', e.message);
  }
  return null;
}

let keysModule;
function loadKeys() {
  if (keysModule) return keysModule;
  try {
    keysModule = require('./keys');
    return keysModule;
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') log.warn('keys module failed to load:', e.message);
  }
  return null;
}

/** Read /proc/<pid>/comm (process short name). */
function commOfPid(pid) {
  if (!pid) return '';
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// App names
// ---------------------------------------------------------------------------

const KNOWN_APPS = {
  code: 'Visual Studio Code',
  'code-url-handler': 'Visual Studio Code',
  'code-insiders': 'Visual Studio Code - Insiders',
  'code-oss': 'Code - OSS',
  vscodium: 'VSCodium',
  codium: 'VSCodium',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  zed: 'Zed',
  'dev.zed.zed': 'Zed',
  'google-chrome': 'Google Chrome',
  'google-chrome-beta': 'Google Chrome Beta',
  'google-chrome-unstable': 'Google Chrome Dev',
  chromium: 'Chromium',
  'chromium-browser': 'Chromium',
  'microsoft-edge': 'Microsoft Edge',
  'brave-browser': 'Brave',
  vivaldi: 'Vivaldi',
  'vivaldi-stable': 'Vivaldi',
  firefox: 'Firefox',
  'firefox-esr': 'Firefox',
  'org.mozilla.firefox': 'Firefox',
  navigator: 'Firefox',
  'gnome-terminal': 'GNOME Terminal',
  'gnome-terminal-server': 'GNOME Terminal',
  'org.gnome.terminal': 'GNOME Terminal',
  'org.gnome.ptyxis': 'Ptyxis',
  'org.gnome.nautilus': 'Files',
  'org.kde.konsole': 'Konsole',
  konsole: 'Konsole',
  xterm: 'XTerm',
  urxvt: 'URxvt',
  alacritty: 'Alacritty',
  kitty: 'kitty',
  'org.wezfurlong.wezterm': 'WezTerm',
  'jetbrains-idea': 'IntelliJ IDEA',
  'jetbrains-idea-ce': 'IntelliJ IDEA CE',
  'jetbrains-pycharm': 'PyCharm',
  'jetbrains-pycharm-ce': 'PyCharm CE',
  'jetbrains-webstorm': 'WebStorm',
  'jetbrains-goland': 'GoLand',
  'jetbrains-clion': 'CLion',
  'jetbrains-rider': 'Rider',
  'jetbrains-phpstorm': 'PhpStorm',
  'jetbrains-rubymine': 'RubyMine',
  'jetbrains-studio': 'Android Studio',
  slack: 'Slack',
  discord: 'Discord',
  'claude-anywhere': 'Claude Anywhere',
};

/**
 * Turn a WM_CLASS / app_id / comm into a human app name.
 * @param {string} cls
 * @returns {string}
 */
function prettifyApp(cls) {
  if (!cls || cls === 'N/A') return '';
  const raw = String(cls).trim();
  const known = KNOWN_APPS[raw.toLowerCase()];
  if (known) return known;
  let base = raw;
  // Reverse-DNS ids (org.gnome.Nautilus, com.github.foo.Bar): keep the last segment.
  if (/^[a-z0-9-]+(\.[A-Za-z0-9_-]+){2,}$/i.test(base)) base = base.split('.').pop();
  const knownBase = KNOWN_APPS[base.toLowerCase()];
  if (knownBase) return knownBase;
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * wmctrl -x prints "instance.Class" (both halves may contain dots). Return the class half.
 * @param {string} s
 */
function classFromWmctrl(s) {
  if (!s || s === 'N/A') return '';
  const parts = s.split('.');
  if (parts.length === 1) return s;
  if (parts.length % 2 === 0) {
    const half = parts.length / 2;
    const a = parts.slice(0, half).join('.');
    const b = parts.slice(half).join('.');
    if (a.toLowerCase() === b.toLowerCase()) return b;
  }
  if (parts.length === 2) return parts[1];
  return parts[parts.length - 1];
}

// ---------------------------------------------------------------------------
// Parsers (pure; exported for tests)
// ---------------------------------------------------------------------------

/** Put the primary first, then order by position; assign indexes. */
function finalizeDisplays(list) {
  const seen = new Set();
  const uniq = [];
  for (const d of list) {
    const key = `${d.x},${d.y},${d.width},${d.height}`;
    if (seen.has(key)) {
      // Mirrored outputs: keep one entry, but remember a primary flag.
      if (d.primary) {
        const prev = uniq.find((u) => `${u.x},${u.y},${u.width},${u.height}` === key);
        if (prev) prev.primary = true;
      }
      continue;
    }
    seen.add(key);
    uniq.push({ ...d });
  }
  let primaryIdx = uniq.findIndex((d) => d.primary);
  if (primaryIdx < 0) primaryIdx = uniq.findIndex((d) => d.x === 0 && d.y === 0);
  const sorted = uniq
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      if (a.i === primaryIdx) return -1;
      if (b.i === primaryIdx) return 1;
      return a.d.x - b.d.x || a.d.y - b.d.y;
    })
    .map(({ d }) => d);
  return sorted.map((d, index) => ({
    index,
    id: String(d.id),
    x: d.x,
    y: d.y,
    width: d.width,
    height: d.height,
    scale: d.scale || 1,
    primary: index === 0,
  }));
}

/**
 * Parse `xrandr --query` into displays (connected outputs with an active mode).
 * @param {string} text
 */
function parseXrandr(text) {
  const out = [];
  const re = /^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/;
  for (const line of String(text || '').split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    out.push({
      id: m[1],
      primary: Boolean(m[2]),
      width: +m[3],
      height: +m[4],
      x: +m[5],
      y: +m[6],
      scale: 1,
    });
  }
  return finalizeDisplays(out.filter((d) => d.width > 0 && d.height > 0));
}

/** Parse `xdotool getdisplaygeometry` ("1920 1080"). */
function parseDisplayGeometry(text) {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(text || ''));
  if (!m) return [];
  return finalizeDisplays([{ id: 'screen', x: 0, y: 0, width: +m[1], height: +m[2], primary: true }]);
}

/** Parse `xwininfo -root`. */
function parseXwininfoRoot(text) {
  const s = String(text || '');
  const w = /^\s*Width:\s*(\d+)/m.exec(s);
  const h = /^\s*Height:\s*(\d+)/m.exec(s);
  if (!w || !h) return [];
  return finalizeDisplays([{ id: 'screen', x: 0, y: 0, width: +w[1], height: +h[1], primary: true }]);
}

/**
 * Parse `xwininfo -root -tree` into a Map of normalized window id → absolute geometry. Each window line
 * ends in "WxH+relX+relY  +absX+absY" (offsets may be negative: "+-100+-100").
 * @param {string} text
 * @returns {Map<string,{x:number,y:number,width:number,height:number}>}
 */
function parseXwininfoTree(text) {
  const out = new Map();
  const re = /^\s*(0x[0-9a-f]+)\s.*\s(\d+)x(\d+)\+-?\d+\+-?\d+\s+\+(-?\d+)\+(-?\d+)\s*$/i;
  for (const line of String(text || '').split('\n')) {
    const m = re.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    let id;
    try {
      id = normalizeX11Id(m[1]);
    } catch {
      continue;
    }
    out.set(id, { x: +m[4], y: +m[5], width: +m[2], height: +m[3] });
  }
  return out;
}

/** Parse `xdpyinfo` ("dimensions:    1920x1080 pixels"). */
function parseXdpyinfo(text) {
  const m = /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(String(text || ''));
  if (!m) return [];
  return finalizeDisplays([{ id: 'screen', x: 0, y: 0, width: +m[1], height: +m[2], primary: true }]);
}

/** Parse `xdotool getmouselocation --shell` (or the plain "x:1 y:2 …" form). */
function parseMouseLocation(text) {
  const s = String(text || '');
  let x = /^X=(-?\d+)/m.exec(s);
  let y = /^Y=(-?\d+)/m.exec(s);
  if (!x || !y) {
    x = /\bx:(-?\d+)/.exec(s);
    y = /\by:(-?\d+)/.exec(s);
  }
  if (!x || !y) return null;
  const screen = /^SCREEN=(\d+)/m.exec(s);
  const win = /^WINDOW=(\d+)/m.exec(s);
  return { x: +x[1], y: +y[1], screen: screen ? +screen[1] : 0, window: win ? +win[1] : 0 };
}

/**
 * Normalize an X11 window id (number, decimal string, or hex string) to "0x%08x".
 * @param {number|string} id
 * @returns {string}
 */
function normalizeX11Id(id) {
  let n = NaN;
  if (typeof id === 'number' && Number.isInteger(id)) n = id;
  else if (typeof id === 'string') {
    const s = id.trim();
    if (/^0x[0-9a-f]+$/i.test(s)) n = parseInt(s, 16);
    else if (/^\d+$/.test(s)) n = parseInt(s, 10);
  }
  if (!Number.isFinite(n) || n <= 0 || n > 0xffffffff) {
    const err = new Error(`Invalid X11 window id: ${JSON.stringify(id)}`);
    err.code = 'BAD_WINDOW_ID';
    throw err;
  }
  return `0x${n.toString(16).padStart(8, '0')}`;
}

function x11IdToDecimal(id) {
  return String(parseInt(normalizeX11Id(id), 16));
}

/**
 * Parse `wmctrl -lpGx`: id desktop pid x y w h WM_CLASS machine title…
 * @param {string} text
 * @param {{hostnames?: string[]}} [opts] client-machine names used to split class and title
 */
function parseWmctrl(text, { hostnames } = {}) {
  const hosts = [];
  for (const h of hostnames || defaultHostnames()) if (h && !hosts.includes(h)) hosts.push(h);
  if (!hosts.includes('N/A')) hosts.push('N/A');
  const re = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(.*)$/;
  const wins = [];
  for (const line of String(text || '').split('\n')) {
    const m = re.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const rest = m[8];
    let wmClass = '';
    let title = '';
    let matched = false;
    let bestIdx = -1;
    let bestHost = '';
    for (const h of hosts) {
      const needle = ` ${h} `;
      let idx = rest.indexOf(needle);
      if (idx < 0 && rest.endsWith(` ${h}`)) idx = rest.length - h.length - 1;
      if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
        bestIdx = idx;
        bestHost = h;
      }
    }
    if (bestIdx > 0) {
      wmClass = rest.slice(0, bestIdx).trim();
      title = rest.slice(bestIdx + bestHost.length + 2);
      matched = true;
    }
    if (!matched) {
      const t = /^(\S+)\s+(\S+)(?:\s(.*))?$/.exec(rest);
      if (t) {
        wmClass = t[1];
        title = t[3] || '';
      } else {
        wmClass = rest.trim();
      }
    }
    const pid = +m[3];
    const cls = classFromWmctrl(wmClass);
    wins.push({
      id: normalizeX11Id(m[1]),
      desktop: +m[2],
      pid,
      x: +m[4],
      y: +m[5],
      width: +m[6],
      height: +m[7],
      wmClass,
      app: prettifyApp(cls) || prettifyApp(commOfPid(pid)),
      title: title.trim(),
    });
  }
  return wins;
}

function defaultHostnames() {
  const h = os.hostname();
  return [h, h.split('.')[0], 'localhost'];
}

/** Decode one xprop quoted string body (octal escapes are raw bytes). */
function decodeXpropString(body) {
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
      if (oct) {
        bytes.push(parseInt(oct[0], 8) & 0xff);
        i += oct[0].length;
        continue;
      }
      const nxt = body[i + 1];
      const map = { n: 0x0a, t: 0x09, r: 0x0d };
      if (map[nxt] !== undefined) bytes.push(map[nxt]);
      else for (const b of Buffer.from(nxt, 'utf8')) bytes.push(b);
      i += 1;
      continue;
    }
    const cp = body.codePointAt(i);
    const s = String.fromCodePoint(cp);
    for (const b of Buffer.from(s, 'utf8')) bytes.push(b);
    if (cp > 0xffff) i += 1;
  }
  const buf = Buffer.from(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

/**
 * Parse xprop output into { PROP: { type, values: string[] } } (missing props are omitted).
 * @param {string} text
 */
function parseXprop(text) {
  const props = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([A-Za-z0-9_]+)\(([^)]*)\)(?:\s*=\s?|:\s*)(.*)$/.exec(line);
    if (!m) continue;
    const [, name, type, rest] = m;
    let values = [];
    if (rest.includes('"')) {
      const re = /"((?:[^"\\]|\\.)*)"/g;
      let q;
      while ((q = re.exec(rest))) values.push(decodeXpropString(q[1]));
    } else if (/window id #/.test(rest)) {
      values = (rest.match(/0x[0-9a-fA-F]+/g) || []).slice();
    } else {
      values = rest
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
    props[name] = { type, values };
  }
  return props;
}

/** Parse `xdotool getwindowgeometry [--shell]` (also kdotool's "Position:/Geometry:" form). */
function parseWindowGeometry(text) {
  const s = String(text || '');
  const shell = {
    x: /^X=(-?\d+)/m.exec(s),
    y: /^Y=(-?\d+)/m.exec(s),
    w: /^WIDTH=(\d+)/m.exec(s),
    h: /^HEIGHT=(\d+)/m.exec(s),
  };
  if (shell.x && shell.y && shell.w && shell.h) {
    return { x: +shell.x[1], y: +shell.y[1], width: +shell.w[1], height: +shell.h[1] };
  }
  const pos = /Position:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(s);
  const geo = /Geometry:\s*(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/.exec(s);
  if (!pos || !geo) return null;
  return { x: Math.round(+pos[1]), y: Math.round(+pos[2]), width: Math.round(+geo[1]), height: Math.round(+geo[2]) };
}

/** Parse `swaymsg -t get_outputs -r`. */
function parseSwayOutputs(json) {
  let arr;
  try {
    arr = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const list = arr
    .filter((o) => o && o.active !== false && o.rect && o.rect.width > 0)
    .map((o) => ({
      id: o.name,
      x: o.rect.x,
      y: o.rect.y,
      width: o.rect.width,
      height: o.rect.height,
      scale: o.scale > 0 ? o.scale : 1,
      primary: false,
    }));
  return finalizeDisplays(list);
}

/** Parse `hyprctl monitors -j` (width/height are mode pixels; x/y are logical). */
function parseHyprMonitors(json) {
  let arr;
  try {
    arr = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const list = arr
    .filter((m) => m && !m.disabled && m.width > 0 && m.height > 0)
    .map((m) => {
      const scale = m.scale > 0 ? m.scale : 1;
      let w = Math.round(m.width / scale);
      let h = Math.round(m.height / scale);
      if (Number(m.transform) % 2 === 1) [w, h] = [h, w];
      return { id: m.name, x: m.x || 0, y: m.y || 0, width: w, height: h, scale, primary: false };
    });
  return finalizeDisplays(list);
}

function transformSwaps(t) {
  return /(^|-)(90|270)$/.test(String(t || ''));
}

/** Parse `wlr-randr --json`. */
function parseWlrRandrJson(json) {
  let arr;
  try {
    arr = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const list = [];
  for (const o of arr) {
    if (!o || o.enabled === false) continue;
    const mode = (o.modes || []).find((md) => md.current) || null;
    if (!mode) continue;
    const scale = o.scale > 0 ? o.scale : 1;
    let w = Math.round(mode.width / scale);
    let h = Math.round(mode.height / scale);
    if (transformSwaps(o.transform)) [w, h] = [h, w];
    const pos = o.position || {};
    list.push({ id: o.name, x: pos.x || 0, y: pos.y || 0, width: w, height: h, scale, primary: false });
  }
  return finalizeDisplays(list);
}

/** Parse plain `wlr-randr` text output. */
function parseWlrRandr(text) {
  const outputs = [];
  let cur = null;
  let inModes = false;
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    if (!/^\s/.test(raw)) {
      cur = { id: raw.trim().split(/\s+/)[0], enabled: true, x: 0, y: 0, scale: 1, transform: 'normal', mode: null };
      outputs.push(cur);
      inModes = false;
      continue;
    }
    if (!cur) continue;
    const line = raw.trim();
    let m;
    if ((m = /^Enabled:\s*(\w+)/.exec(line))) {
      cur.enabled = m[1] === 'yes';
      inModes = false;
    } else if (/^Modes:/.test(line)) {
      inModes = true;
    } else if ((m = /^Position:\s*(-?\d+),\s*(-?\d+)/.exec(line))) {
      cur.x = +m[1];
      cur.y = +m[2];
      inModes = false;
    } else if ((m = /^Transform:\s*(\S+)/.exec(line))) {
      cur.transform = m[1];
      inModes = false;
    } else if ((m = /^Scale:\s*([\d.]+)/.exec(line))) {
      cur.scale = +m[1] || 1;
      inModes = false;
    } else if (inModes && (m = /^(\d+)x(\d+)\s+px.*\bcurrent\b/.exec(line))) {
      cur.mode = { width: +m[1], height: +m[2] };
    }
  }
  const list = [];
  for (const o of outputs) {
    if (!o.enabled || !o.mode) continue;
    let w = Math.round(o.mode.width / o.scale);
    let h = Math.round(o.mode.height / o.scale);
    if (transformSwaps(o.transform)) [w, h] = [h, w];
    list.push({ id: o.id, x: o.x, y: o.y, width: w, height: h, scale: o.scale, primary: false });
  }
  return finalizeDisplays(list);
}

/**
 * Walk a sway tree (`swaymsg -t get_tree`) and return its windows.
 * @param {object|string} tree
 */
function walkSwayTree(tree) {
  let root = tree;
  if (typeof tree === 'string') {
    try {
      root = JSON.parse(tree);
    } catch {
      return [];
    }
  }
  const wins = [];
  const visit = (node, workspace) => {
    if (!node || typeof node !== 'object') return;
    const ws = node.type === 'workspace' ? node.name : workspace;
    const children = [...(node.nodes || []), ...(node.floating_nodes || [])];
    const isWindow =
      (node.type === 'con' || node.type === 'floating_con') &&
      children.length === 0 &&
      (node.pid || node.app_id || node.window_properties || node.window);
    if (isWindow) {
      const props = node.window_properties || {};
      const rect = node.rect || {};
      const appId = node.app_id || props.class || props.instance || '';
      wins.push({
        id: String(node.id),
        app: prettifyApp(appId) || prettifyApp(commOfPid(node.pid)),
        title: node.name || props.title || '',
        pid: node.pid || 0,
        x: rect.x || 0,
        y: rect.y || 0,
        width: rect.width || 0,
        height: rect.height || 0,
        focused: Boolean(node.focused),
        minimized: ws === '__i3_scratch',
      });
    }
    for (const c of children) visit(c, ws);
  };
  visit(root, '');
  return wins;
}

/**
 * Parse `xprop -root _NET_CLIENT_LIST_STACKING`
 * ("_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1a00003, 0x1c00007"), bottom to top.
 * @returns {string[]} normalized ids, bottom first
 */
function parseClientListStacking(text) {
  const m = /#\s*(.*)$/m.exec(String(text || ''));
  if (!m) return [];
  const out = [];
  for (const tok of m[1].split(/[\s,]+/)) {
    if (!/^0x[0-9a-f]+$/i.test(tok)) continue;
    try {
      out.push(normalizeX11Id(tok));
    } catch {
      /* 0x0 or out of range */
    }
  }
  return out;
}

/** Parse `hyprctl clients -j` (+ optional active window address). */
function parseHyprClients(json, activeAddress) {
  let arr;
  try {
    arr = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((c) => c && c.mapped !== false && c.address)
    .map((c) => {
      const at = Array.isArray(c.at) ? c.at : [0, 0];
      const size = Array.isArray(c.size) ? c.size : [0, 0];
      const wsName = (c.workspace && c.workspace.name) || '';
      return {
        id: c.address,
        app: prettifyApp(c.class || c.initialClass) || prettifyApp(commOfPid(c.pid)),
        title: c.title || c.initialTitle || '',
        pid: c.pid > 0 ? c.pid : 0,
        x: at[0] || 0,
        y: at[1] || 0,
        width: size[0] || 0,
        height: size[1] || 0,
        focused: activeAddress ? c.address === activeAddress : c.focusHistoryID === 0,
        minimized: Boolean(c.hidden) || wsName.startsWith('special'),
        // Focus history (0 = most recently focused) is Hyprland's closest thing to a z-order.
        ...(Number.isInteger(c.focusHistoryID) && c.focusHistoryID >= 0 ? { stackIndex: c.focusHistoryID } : {}),
      };
    });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'meta']);
const NAMED_KEYS = new Set([
  'enter', 'escape', 'tab', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'capslock', 'printscreen', 'menu', 'numlock', 'scrolllock', 'pause',
]);
const KEY_ALIASES = {
  control: 'ctrl', ctl: 'ctrl', lctrl: 'ctrl', rctrl: 'ctrl', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta',
  windows: 'meta', os: 'meta', logo: 'meta', option: 'alt', opt: 'alt', return: 'enter', esc: 'escape', del: 'delete',
  ins: 'insert', pgup: 'pageup', pgdn: 'pagedown', page_up: 'pageup', page_down: 'pagedown', arrowup: 'up',
  arrowdown: 'down', arrowleft: 'left', arrowright: 'right', bksp: 'backspace', spacebar: 'space', caps: 'capslock',
  prtsc: 'printscreen', print: 'printscreen', primary: 'ctrl', mod: 'ctrl', plus: '+', minus: '-', apps: 'menu',
  contextmenu: 'menu',
};

/** Normalize one key name (known names lowercased; unknown multi-char names keep their case, e.g. XF86AudioPlay). */
function normalizeKeyName(k) {
  const s = String(k == null ? '' : k);
  if (s === ' ') return 'space';
  if (s.length === 1) return s.toLowerCase();
  const t = s.trim();
  const l = t.toLowerCase().replace(/\s+/g, '');
  if (KEY_ALIASES[l]) return KEY_ALIASES[l];
  if (MODIFIERS.has(l) || NAMED_KEYS.has(l) || /^f([1-9]|1\d|2[0-4])$/.test(l)) return l;
  return t;
}

/** Split "ctrl+shift+t" / "ctrl++" into parts. */
function splitCombo(str) {
  const s = String(str).trim();
  if (s === '+') return ['+'];
  const parts = [];
  let cur = '';
  for (const ch of s) {
    if (ch === '+' && cur !== '') {
      parts.push(cur);
      cur = '';
    } else if (ch === '+') {
      cur = '+';
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts.map((p) => (p === ' ' ? p : p.trim())).filter((p) => p !== '');
}

/**
 * Normalize a combo given as an array of names or a "Ctrl+Shift+T" string.
 * Uses keys.js when present (it rejects unknown names with a helpful message, which
 * matters because xdotool silently ignores unknown keysyms); otherwise a local parser.
 * @param {string[]|string} keys
 * @returns {string[]}
 */
function normalizeKeys(keys) {
  if (typeof keys !== 'string' && !Array.isArray(keys)) {
    throw new TypeError('keyCombo expects an array of key names or a combo string');
  }
  const k = loadKeys();
  if (k && typeof k.normalizeCombo === 'function') return k.normalizeCombo(keys, { platform: 'linux' });
  const parts = typeof keys === 'string' ? splitCombo(keys) : keys;
  return parts.map(normalizeKeyName).filter(Boolean);
}

const X_KEYSYMS = {
  ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super',
  enter: 'Return', escape: 'Escape', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete',
  insert: 'Insert', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', up: 'Up', down: 'Down',
  left: 'Left', right: 'Right', capslock: 'Caps_Lock', printscreen: 'Print', menu: 'Menu', numlock: 'Num_Lock',
  scrolllock: 'Scroll_Lock', pause: 'Pause',
  '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', $: 'dollar', '%': 'percent', '&': 'ampersand',
  "'": 'apostrophe', '(': 'parenleft', ')': 'parenright', '*': 'asterisk', '+': 'plus', ',': 'comma',
  '-': 'minus', '.': 'period', '/': 'slash', ':': 'colon', ';': 'semicolon', '<': 'less', '=': 'equal',
  '>': 'greater', '?': 'question', '@': 'at', '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright',
  '^': 'asciicircum', _: 'underscore', '`': 'grave', '{': 'braceleft', '|': 'bar', '}': 'braceright', '~': 'asciitilde',
};

/** Map one normalized key to an X keysym name (also used for wtype -k). */
function xKeysym(name) {
  if (X_KEYSYMS[name]) return X_KEYSYMS[name];
  const f = /^f(\d{1,2})$/.exec(name);
  if (f) return `F${f[1]}`;
  if (Array.from(name).length === 1) {
    if (/^[a-z0-9]$/i.test(name)) return name;
    return `U${name.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return name;
}

/** X keysym for one normalized key, via keys.js when it knows the key. */
function keysymFor(name) {
  const k = loadKeys();
  if (k && typeof k.toXdotool === 'function') {
    try {
      const s = k.toXdotool([name]);
      if (typeof s === 'string' && s) return s;
    } catch {
      /* fall back to the local table */
    }
  }
  return xKeysym(name);
}

/**
 * Build an xdotool key combo ("ctrl+shift+t"), preferring keys.js toXdotool.
 * @param {string[]|string} keys
 */
function xdotoolCombo(keys) {
  const norm = normalizeKeys(keys);
  if (!norm.length) throw new Error('Empty key combo');
  const k = loadKeys();
  if (k && typeof k.toXdotool === 'function') {
    try {
      const s = k.toXdotool(norm);
      if (typeof s === 'string' && s) return s;
    } catch (e) {
      log.debug('keys.toXdotool failed, using local mapping:', e.message);
    }
  }
  return norm.map(xKeysym).join('+');
}

/** Modifier list → xdotool modifier names. */
function x11Modifiers(modifiers) {
  if (!modifiers) return [];
  const list = Array.isArray(modifiers) ? modifiers : splitCombo(String(modifiers));
  const out = [];
  for (const raw of list) {
    const n = normalizeKeyName(raw);
    if (!MODIFIERS.has(n)) throw new TypeError(`Unknown modifier "${raw}" (use ctrl, alt, shift or meta)`);
    const x = X_KEYSYMS[n];
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

// Linux evdev key codes (linux/input-event-codes.h), US layout.
const EVDEV = {
  escape: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11, '-': 12, '=': 13, backspace: 14,
  tab: 15, q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, '[': 26, ']': 27, enter: 28,
  ctrl: 29, a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, ';': 39, "'": 40, '`': 41, shift: 42,
  '\\': 43, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50, ',': 51, '.': 52, '/': 53, alt: 56, space: 57,
  capslock: 58, f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, numlock: 69,
  scrolllock: 70, f11: 87, f12: 88, printscreen: 99, home: 102, up: 103, pageup: 104, left: 105, right: 106,
  end: 107, down: 108, pagedown: 109, insert: 110, delete: 111, pause: 119, meta: 125, menu: 127,
  f13: 183, f14: 184, f15: 185, f16: 186, f17: 187, f18: 188, f19: 189, f20: 190, f21: 191, f22: 192, f23: 193, f24: 194,
};
const EVDEV_SHIFTED = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', _: '-',
  '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '~': '`', '<': ',', '>': '.', '?': '/',
};

/**
 * Build `ydotool key` arguments (evdev code:state pairs) for a combo.
 * @param {string[]|string} keys
 * @returns {string[]}
 */
function ydotoolKeyArgs(keys) {
  const norm = normalizeKeys(keys);
  if (!norm.length) throw new Error('Empty key combo');
  let codes = null;
  const k = loadKeys();
  if (k && typeof k.toEvdev === 'function') {
    try {
      const c = k.toEvdev(norm);
      if (Array.isArray(c) && c.length && c.every((n) => Number.isInteger(n) && n > 0)) codes = c;
    } catch (e) {
      log.debug('keys.toEvdev failed, using local table:', e.message);
    }
  }
  if (!codes) {
    codes = [];
    const push = (c) => {
      if (!codes.includes(c)) codes.push(c);
    };
    for (const m of norm.filter((x) => MODIFIERS.has(x))) push(EVDEV[m]);
    for (const name of norm.filter((x) => !MODIFIERS.has(x))) {
      let key = name;
      if (EVDEV_SHIFTED[key]) {
        push(EVDEV.shift);
        key = EVDEV_SHIFTED[key];
      }
      const code = EVDEV[key];
      if (code == null) {
        throw unsupportedError(`Key "${name}" has no evdev code for ydotool`, 'Install wtype for full keyboard support on Wayland.');
      }
      push(code);
    }
  }
  return ['key', ...codes.map((c) => `${c}:1`), ...codes.slice().reverse().map((c) => `${c}:0`)];
}

const WTYPE_MODS = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'logo' };

/** Build `wtype` arguments for a key combo: -M ctrl -k c -m ctrl. */
function wtypeKeyArgs(keys) {
  const norm = normalizeKeys(keys);
  if (!norm.length) throw new Error('Empty key combo');
  const mods = norm.filter((k) => MODIFIERS.has(k)).map((k) => WTYPE_MODS[k]);
  const args = [];
  for (const m of mods) args.push('-M', m);
  for (const k of norm.filter((x) => !MODIFIERS.has(x))) args.push('-k', keysymFor(k));
  for (const m of mods.slice().reverse()) args.push('-m', m);
  return args;
}

/** Build `wtype` arguments that type literal text (never lets text look like an option). */
function wtypeTextArgs(text, delayMs = 5) {
  const args = ['-d', String(delayMs)];
  String(text)
    .split('\n')
    .forEach((line, i) => {
      if (i > 0) args.push('-k', 'Return');
      let rest = line;
      while (rest.startsWith('-')) {
        args.push('-k', 'minus');
        rest = rest.slice(1);
      }
      if (rest) args.push(rest);
    });
  return args;
}

// ---------------------------------------------------------------------------
// Mouse command builders
// ---------------------------------------------------------------------------

const X_BUTTONS = { left: 1, middle: 2, right: 3, back: 8, forward: 9 };

/** Button name/number → X11 button number. */
function x11Button(button = 'left') {
  if (typeof button === 'number' && Number.isInteger(button) && button >= 1 && button <= 9) return button;
  const b = X_BUTTONS[String(button).toLowerCase()];
  if (!b) throw new TypeError(`Unknown mouse button "${button}" (use left, middle or right)`);
  return b;
}

/** xdotool args for a click with held modifiers. */
function buildClickArgs(button, clicks, mods = []) {
  const b = x11Button(button);
  const n = clampInt(clicks, 1, 10, 1);
  const args = [];
  for (const m of mods) args.push('keydown', m);
  args.push('click', '--repeat', String(n), '--delay', '80', String(b));
  for (const m of mods.slice().reverse()) args.push('keyup', m);
  return args;
}

/** xdotool args for a drag: mousedown, interpolated moves, mouseup (one process, `sleep` between steps). */
function buildDragArgs(from, to, button, steps = DRAG_STEPS, stepMs = DRAG_STEP_MS) {
  const b = String(x11Button(button));
  const args = ['mousedown', b, 'sleep', '0.05'];
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    args.push('mousemove', String(x), String(y), 'sleep', String(stepMs / 1000));
  }
  args.push('mouseup', b);
  return args;
}

/** xdotool args for wheel notches (4/5 vertical, 6/7 horizontal). */
function buildScrollArgs(dx, dy) {
  const vy = clampInt(dy, -MAX_NOTCHES, MAX_NOTCHES, 0);
  const vx = clampInt(dx, -MAX_NOTCHES, MAX_NOTCHES, 0);
  const args = [];
  if (vy) args.push('click', '--repeat', String(Math.abs(vy)), '--delay', '30', vy > 0 ? '5' : '4');
  if (vx) args.push('click', '--repeat', String(Math.abs(vx)), '--delay', '30', vx > 0 ? '7' : '6');
  return args;
}

/**
 * Build the command for a direct (stdout) X11 capture of a rect.
 * @param {'maim'|'import'|'ffmpeg'} tool
 * @param {{x:number,y:number,width:number,height:number}} r
 * @param {string} display value of $DISPLAY (ffmpeg only)
 * @returns {{cmd:string,args:string[]}}
 */
function buildX11CaptureCommand(tool, r, display) {
  const geom = `${r.width}x${r.height}+${r.x}+${r.y}`;
  switch (tool) {
    case 'maim':
      return { cmd: 'maim', args: ['-g', geom] };
    case 'import':
      return { cmd: 'import', args: ['-window', 'root', '-crop', geom, '+repage', 'png:-'] };
    case 'ffmpeg':
      return {
        cmd: 'ffmpeg',
        args: [
          '-loglevel', 'error', '-f', 'x11grab', '-video_size', `${r.width}x${r.height}`,
          '-i', `${display}+${r.x},${r.y}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-',
        ],
      };
    default:
      throw new Error(`No direct capture command for ${tool}`);
  }
}

/** Snap a point into the nearest display (prevents xdotool --sync hangs on clamped moves). */
function clampToDisplays(x, y, displays) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new TypeError(`Invalid coordinates (${x}, ${y})`);
  const px = Math.round(nx);
  const py = Math.round(ny);
  if (!displays || !displays.length) return { x: Math.max(0, px), y: Math.max(0, py) };
  for (const d of displays) {
    if (px >= d.x && px < d.x + d.width && py >= d.y && py < d.y + d.height) return { x: px, y: py };
  }
  let best = null;
  let bestDist = Infinity;
  for (const d of displays) {
    const cx = Math.min(Math.max(px, d.x), d.x + d.width - 1);
    const cy = Math.min(Math.max(py, d.y), d.y + d.height - 1);
    const dist = (cx - px) ** 2 + (cy - py) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = { x: cx, y: cy };
    }
  }
  return best;
}

function unionRect(displays) {
  const minX = Math.min(...displays.map((d) => d.x));
  const minY = Math.min(...displays.map((d) => d.y));
  const maxX = Math.max(...displays.map((d) => d.x + d.width));
  const maxY = Math.max(...displays.map((d) => d.y + d.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Pick a UTF-8 locale override when the current one is not UTF-8 (wmctrl prints N/A for non-ASCII otherwise). */
function utf8LocaleOverride(env) {
  for (const k of ['LC_ALL', 'LC_CTYPE', 'LANG']) {
    const v = env[k];
    if (v) return /utf-?8/i.test(v) ? null : { LC_ALL: 'C.UTF-8' };
  }
  return { LC_ALL: 'C.UTF-8' };
}

// ---------------------------------------------------------------------------
// Base driver
// ---------------------------------------------------------------------------

class LinuxDriverBase {
  /**
   * @param {{displayServer?:string, env?:object, run?:Function, which?:Function, spawn?:Function, hostnames?:string[], png?:object|null}} opts
   *   run/which/spawn/env/hostnames/png are injection points for tests (png: null forces the ImageMagick crop path).
   */
  constructor(opts = {}) {
    this._opts = opts;
    this._runImpl = opts.run || proc.run;
    this._whichImpl = opts.which || proc.which;
    this._spawnImpl = opts.spawn || childProcess.spawn;
    this._pm = undefined;
    this._displayCache = null;
    this._captureTool = null;
    this._whichRetryAt = 0;
  }

  _env(extra) {
    const base = this._opts.env || process.env;
    return extra ? { ...base, ...extra } : base;
  }

  /** The environment with a UTF-8 locale forced in, or undefined when the current locale is already UTF-8. */
  _utf8Env() {
    const loc = utf8LocaleOverride(this._env());
    return loc ? this._env(loc) : undefined;
  }

  _has(name) {
    if (this._whichImpl(name)) return true;
    // proc.which remembers misses forever. Look again now and then, so a tool the user installs after
    // reading an "is not installed" hint is found without restarting the daemon.
    if (this._whichImpl === proc.which && typeof proc.clearWhichCache === 'function') {
      const now = Date.now();
      if (now - this._whichRetryAt >= WHICH_MISS_TTL_MS) {
        this._whichRetryAt = now;
        proc.clearWhichCache();
        return Boolean(this._whichImpl(name));
      }
    }
    return false;
  }

  _run(cmd, args, opts = {}) {
    return this._runImpl(cmd, args.map(String), { timeoutMs: 5000, ...opts, env: opts.env || this._env() });
  }

  _packageManager() {
    if (this._pm === undefined) this._pm = detectPackageManager(this._whichImpl);
    return this._pm;
  }

  _hint(tools) {
    return installHint(tools, this._packageManager());
  }

  _requireTool(name, pkg) {
    if (!this._has(name)) throw unsupportedError(`${name} is not installed`, this._hint([pkg || name]));
  }

  /** ImageMagick 6 (`convert`/`import`) or 7 (`magick [import]`). */
  _imCommand(name) {
    if (this._has(name)) return { cmd: name, pre: [] };
    if (this._has('magick')) return { cmd: 'magick', pre: name === 'convert' ? [] : [name] };
    return null;
  }

  async _displaysSafe() {
    try {
      return await this.displays();
    } catch {
      return null;
    }
  }

  /** Crop a PNG to rect, via png.js when available, else ImageMagick. */
  async _cropPng(buf, r) {
    const png = 'png' in this._opts ? this._opts.png : loadPng();
    if (png) {
      try {
        const img = png.decode(buf);
        return png.encode(png.crop(img, r.x, r.y, r.width, r.height));
      } catch (e) {
        log.debug('png.js crop failed, trying ImageMagick:', e.message);
      }
    }
    const im = this._imCommand('convert');
    if (im) {
      const args = [...im.pre, 'png:-', '-crop', `${r.width}x${r.height}+${r.x}+${r.y}`, '+repage', 'png:-'];
      const res = await this._run(im.cmd, args, { input: buf, encoding: 'buffer', timeoutMs: CAPTURE_TIMEOUT_MS });
      if (ok(res) && pngInfo(res.stdout)) return res.stdout;
      throw commandError(im.cmd, args, res);
    }
    throw unsupportedError('Cannot crop the screenshot to one monitor', this._hint(['imagemagick']));
  }

  /**
   * Hand text to a clipboard owner that forks and keeps running (xclip, xsel, wl-copy).
   * These never close their inherited stdout/stderr, so we ignore them and resolve on
   * 'exit' (or after a grace period), never on 'close'.
   */
  _spawnClipboardSetter(cmd, args, text, { graceMs = 1000, settleMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawnImpl(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], env: this._env(), detached: true });
      } catch (e) {
        reject(e);
        return;
      }
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          child.unref();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else if (settleMs) setTimeout(resolve, settleMs);
        else resolve();
      };
      const timer = setTimeout(() => finish(), graceMs);
      child.on('error', (e) => {
        finish(e.code === 'ENOENT' ? unsupportedError(`${cmd} is not installed`, '') : e);
      });
      child.on('exit', (code, signal) => {
        if (code === 0) finish();
        else finish(new Error(`${cmd} exited with ${code != null ? `code ${code}` : `signal ${signal}`}`));
      });
      if (child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(Buffer.from(String(text), 'utf8'));
      }
    });
  }

  _speakAvailable() {
    return this._has('spd-say') || this._has('espeak-ng') || this._has('espeak');
  }

  /** Stop persistent helpers (none on Linux). */
  async close() {}
}

// ---------------------------------------------------------------------------
// X11
// ---------------------------------------------------------------------------

class X11Driver extends LinuxDriverBase {
  constructor(opts = {}) {
    super(opts);
    this.name = 'linux-x11';
    this.displayServer = 'x11';
  }

  _requireDisplay() {
    if (!this._env().DISPLAY) {
      throw unsupportedError(
        'No X11 display: DISPLAY is not set',
        'Start Claude Anywhere from inside your desktop session, or export DISPLAY=:0 (and XAUTHORITY) first.',
      );
    }
  }

  _requireXdotool() {
    this._requireDisplay();
    this._requireTool('xdotool');
  }

  async _xdo(args, opts = {}) {
    this._requireXdotool();
    const r = await this._run('xdotool', args, opts);
    if (!ok(r)) throw commandError('xdotool', args, r, this._hint(['xdotool']));
    return r;
  }

  /** @returns {Promise<Array<{index,id,x,y,width,height,scale,primary}>>} */
  async displays() {
    this._requireDisplay();
    const now = Date.now();
    if (this._displayCache && now - this._displayCache.at < DISPLAY_CACHE_MS) {
      return this._displayCache.list.map((d) => ({ ...d }));
    }
    let list = [];
    // `--current` prints the same format as `--query` without re-probing outputs
    // (a re-probe is slow and makes some GPUs flicker); `--query` covers ancient xrandr.
    const attempts = [
      ['xrandr', ['--current'], parseXrandr],
      ['xrandr', ['--query'], parseXrandr],
      ['xdotool', ['getdisplaygeometry'], parseDisplayGeometry],
      ['xwininfo', ['-root'], parseXwininfoRoot],
      ['xdpyinfo', [], parseXdpyinfo],
    ];
    const errors = [];
    for (const [cmd, args, parse] of attempts) {
      if (!this._has(cmd)) continue;
      const r = await this._run(cmd, args, { timeoutMs: 5000 });
      if (ok(r)) list = parse(r.stdout);
      else errors.push(`${cmd}: ${firstLine(r.stderr) || (r.timedOut ? 'timed out' : `exit ${r.code}`)}`);
      if (list.length) break;
    }
    if (!list.length) {
      const msg = errors.length ? `Cannot read the X11 screen layout (${errors.join('; ')})` : 'Cannot read the X11 screen layout';
      throw unsupportedError(msg, this._hint(['xrandr', 'xdotool']));
    }
    this._displayCache = { at: now, list };
    return list.map((d) => ({ ...d }));
  }

  _captureAvailable(tool) {
    switch (tool) {
      case 'import':
        return Boolean(this._imCommand('import'));
      case 'xwd':
        return this._has('xwd') && Boolean(this._imCommand('convert'));
      default:
        return this._has(tool);
    }
  }

  async _captureWith(tool, d) {
    const opts = { encoding: 'buffer', timeoutMs: CAPTURE_TIMEOUT_MS };
    if (tool === 'maim' || tool === 'import' || tool === 'ffmpeg') {
      let { cmd, args } = buildX11CaptureCommand(tool, d, this._env().DISPLAY);
      if (tool === 'import') {
        const im = this._imCommand('import');
        cmd = im.cmd;
        args = [...im.pre, ...args];
      }
      const r = await this._run(cmd, args, opts);
      if (!ok(r)) throw commandError(cmd, args, r);
      return r.stdout;
    }
    if (tool === 'xwd') {
      const r = await this._run('xwd', ['-root', '-silent'], opts);
      if (!ok(r)) throw commandError('xwd', ['-root'], r);
      const im = this._imCommand('convert');
      const args = [...im.pre, 'xwd:-', '-crop', `${d.width}x${d.height}+${d.x}+${d.y}`, '+repage', 'png:-'];
      const c = await this._run(im.cmd, args, { ...opts, input: r.stdout });
      if (!ok(c)) throw commandError(im.cmd, args, c);
      return c.stdout;
    }
    if (tool === 'scrot' || tool === 'gnome-screenshot') {
      const file = tempPngPath('shot');
      const args = tool === 'scrot' ? [file] : ['-f', file];
      const r = await this._run(tool, args, { timeoutMs: CAPTURE_TIMEOUT_MS + 5000 });
      if (!ok(r)) {
        fs.promises.rm(file, { force: true }).catch(() => {});
        throw commandError(tool, args, r);
      }
      return readAndRemove(file);
    }
    throw new Error(`Unknown capture tool ${tool}`);
  }

  /**
   * Capture one display as PNG (native pixels). Tries each tool once, remembering the first that works.
   * @param {number} index
   */
  async captureDisplay(index = 0) {
    this._requireDisplay();
    const displays = await this.displays();
    const d = displays[index];
    if (!d) {
      const err = new Error(`Display ${index} does not exist (found ${displays.length})`);
      err.code = 'BAD_DISPLAY';
      throw err;
    }
    const root = unionRect(displays);
    const rootW = root.x + root.width;
    const rootH = root.y + root.height;
    const order = this._captureTool
      ? [this._captureTool, ...X11_CAPTURE_TOOLS.filter((t) => t !== this._captureTool)]
      : X11_CAPTURE_TOOLS.slice();
    const errors = [];
    let fallback = null;
    let tried = 0;
    for (const tool of order) {
      if (!this._captureAvailable(tool)) continue;
      tried++;
      try {
        let buf = await this._captureWith(tool, d);
        let info = pngInfo(buf);
        if (!info) {
          errors.push(`${tool}: output is not a complete PNG`);
          continue;
        }
        if ((info.width !== d.width || info.height !== d.height) && info.width === rootW && info.height === rootH) {
          buf = await this._cropPng(buf, { x: d.x, y: d.y, width: d.width, height: d.height });
          info = pngInfo(buf);
        }
        if (info && info.width === d.width && info.height === d.height) {
          if (this._captureTool !== tool) log.debug(`screenshots via ${tool}`);
          this._captureTool = tool;
          return { png: buf, width: info.width, height: info.height };
        }
        if (info) {
          errors.push(`${tool}: got ${info.width}x${info.height}, expected ${d.width}x${d.height}`);
          if (!fallback) fallback = { tool, png: buf, width: info.width, height: info.height };
        }
      } catch (e) {
        errors.push(`${tool}: ${e.message}`);
      }
    }
    if (fallback) {
      log.warn(`screenshot size mismatch, using ${fallback.tool}: ${errors.join('; ')}`);
      this._captureTool = fallback.tool;
      return { png: fallback.png, width: fallback.width, height: fallback.height };
    }
    if (!tried) {
      throw unsupportedError('No X11 screenshot tool found (maim, import, ffmpeg, scrot, xwd or gnome-screenshot)', this._hint(['imagemagick']));
    }
    const err = new Error(`Screenshot failed: ${errors.join('; ')}`);
    err.code = 'CAPTURE_FAILED';
    err.hint = this._hint(['imagemagick', 'maim']);
    throw err;
  }

  async cursorPosition() {
    const r = await this._xdo(['getmouselocation', '--shell'], { timeoutMs: 3000 });
    const p = parseMouseLocation(r.stdout);
    if (!p) throw new Error(`Unexpected xdotool getmouselocation output: ${truncate(r.stdout, 120)}`);
    return { x: p.x, y: p.y };
  }

  async moveMouse(x, y) {
    this._requireXdotool();
    const p = clampToDisplays(x, y, await this._displaysSafe());
    // `mousemove --sync` never returns when the pointer is already there.
    const cur = await this.cursorPosition().catch(() => null);
    if (cur && cur.x === p.x && cur.y === p.y) return;
    const args = ['mousemove', '--sync', p.x, p.y];
    const r = await this._run('xdotool', args, { timeoutMs: 2500 });
    if (r.timedOut) {
      log.debug(`mousemove --sync to ${p.x},${p.y} did not confirm; continuing`);
      return;
    }
    if (!ok(r)) throw commandError('xdotool', args, r, this._hint(['xdotool']));
  }

  async click(x, y, { button = 'left', clicks = 1, modifiers = [] } = {}) {
    this._requireXdotool();
    const mods = x11Modifiers(modifiers);
    const args = buildClickArgs(button, clicks, mods);
    if (x != null && y != null) await this.moveMouse(x, y);
    const r = await this._run('xdotool', args, { timeoutMs: 5000 + clampInt(clicks, 1, 10, 1) * 200 });
    if (!ok(r)) {
      if (mods.length) await this._run('xdotool', ['keyup', ...mods], { timeoutMs: 2000 });
      throw commandError('xdotool', args, r, this._hint(['xdotool']));
    }
  }

  async mouseDown(button = 'left') {
    await this._xdo(['mousedown', x11Button(button)], { timeoutMs: 3000 });
  }

  async mouseUp(button = 'left') {
    await this._xdo(['mouseup', x11Button(button)], { timeoutMs: 3000 });
  }

  async drag(x1, y1, x2, y2, { button = 'left' } = {}) {
    this._requireXdotool();
    const b = x11Button(button);
    const displays = await this._displaysSafe();
    const from = clampToDisplays(x1, y1, displays);
    const to = clampToDisplays(x2, y2, displays);
    await this.moveMouse(from.x, from.y);
    const args = buildDragArgs(from, to, b);
    const r = await this._run('xdotool', args, { timeoutMs: 8000 });
    if (!ok(r)) {
      await this._run('xdotool', ['mouseup', b], { timeoutMs: 2000 });
      throw commandError('xdotool', args, r, this._hint(['xdotool']));
    }
  }

  async scroll(x, y, dx = 0, dy = 0) {
    this._requireXdotool();
    const args = buildScrollArgs(dx, dy);
    if (x != null && y != null) await this.moveMouse(x, y);
    if (!args.length) return;
    const notches = Math.abs(clampInt(dx, -MAX_NOTCHES, MAX_NOTCHES, 0)) + Math.abs(clampInt(dy, -MAX_NOTCHES, MAX_NOTCHES, 0));
    await this._xdo(args, { timeoutMs: 5000 + notches * 50 });
  }

  async typeText(text) {
    if (text == null || text === '') return;
    this._requireXdotool();
    const s = String(text).replace(/\r\n?/g, '\n');
    // xdotool decodes the text with the locale's charset: in a C/POSIX locale it stops at the first
    // non-ASCII character ("Invalid multi-byte sequence") after typing what came before it.
    const env = this._utf8Env();
    for (const chunk of chunkText(s, TYPE_CHUNK)) {
      await this._xdo(['type', '--clearmodifiers', '--delay', '8', '--', chunk], {
        timeoutMs: 10000 + chunk.length * 60,
        env,
      });
    }
  }

  async keyCombo(keys) {
    const combo = xdotoolCombo(keys);
    const r = await this._xdo(['key', '--clearmodifiers', combo], { timeoutMs: 5000, env: this._utf8Env() });
    // xdotool exits 0 even when it skipped an unknown keysym.
    if (/No such key name/i.test(String(r.stderr))) {
      const err = new Error(`Unknown key in "${combo}": ${firstLine(r.stderr)}`);
      err.code = 'BAD_KEY';
      throw err;
    }
  }

  // ----- windows -----

  async _activeWindowId() {
    this._requireDisplay();
    if (this._has('xdotool')) {
      const r = await this._run('xdotool', ['getactivewindow'], { timeoutMs: 3000 });
      const n = ok(r) ? parseInt(String(r.stdout).trim(), 10) : NaN;
      if (n > 1) return normalizeX11Id(n);
    }
    if (this._has('xprop')) {
      const r = await this._run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { timeoutMs: 3000, env: this._env({ LC_ALL: 'C' }) });
      const m = ok(r) ? /window id # (0x[0-9a-f]+)/i.exec(r.stdout) : null;
      if (m && parseInt(m[1], 16) > 1) return normalizeX11Id(m[1]);
    }
    if (this._has('xdotool')) {
      const r = await this._run('xdotool', ['getwindowfocus'], { timeoutMs: 3000 });
      const n = ok(r) ? parseInt(String(r.stdout).trim(), 10) : NaN;
      if (n > 1) return normalizeX11Id(n);
    }
    return null;
  }

  async _xprop(id, props) {
    const r = await this._run('xprop', ['-id', id, ...props], { timeoutMs: 2000, env: this._env({ LC_ALL: 'C' }) });
    return ok(r) ? parseXprop(r.stdout) : null;
  }

  async _windowDetails(id) {
    if (this._has('xprop')) {
      const p = await this._xprop(id, ['_NET_WM_NAME', 'WM_NAME', '_NET_WM_PID', 'WM_CLASS']);
      if (p) {
        const title = (p._NET_WM_NAME && p._NET_WM_NAME.values[0]) || (p.WM_NAME && p.WM_NAME.values[0]) || '';
        const pid = p._NET_WM_PID ? parseInt(p._NET_WM_PID.values[0], 10) || 0 : 0;
        const cls = p.WM_CLASS ? p.WM_CLASS.values : [];
        const app = prettifyApp(cls[1] || cls[0] || '') || prettifyApp(commOfPid(pid));
        return { title, pid, app };
      }
    }
    if (this._has('xdotool')) {
      const dec = x11IdToDecimal(id);
      const [n, p] = await Promise.all([
        this._run('xdotool', ['getwindowname', dec], { timeoutMs: 2000 }),
        this._run('xdotool', ['getwindowpid', dec], { timeoutMs: 2000 }),
      ]);
      const pid = ok(p) ? parseInt(String(p.stdout).trim(), 10) || 0 : 0;
      return { title: ok(n) ? String(n.stdout).replace(/\n$/, '') : '', pid, app: prettifyApp(commOfPid(pid)) };
    }
    return { title: '', pid: 0, app: '' };
  }

  async _listWindowsXdotool() {
    const r = await this._run('xdotool', ['search', '--onlyvisible', '--name', '.'], { timeoutMs: 5000 });
    // xdotool search exits 1 when nothing matches.
    if (r.error || r.timedOut) throw commandError('xdotool', ['search'], r, this._hint(['xdotool']));
    const ids = [...new Set(String(r.stdout).split('\n').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)))].slice(0, 80);
    const wins = await mapLimit(ids, 8, async (dec) => {
      const [n, p, g] = await Promise.all([
        this._run('xdotool', ['getwindowname', dec], { timeoutMs: 2000 }),
        this._run('xdotool', ['getwindowpid', dec], { timeoutMs: 2000 }),
        this._run('xdotool', ['getwindowgeometry', '--shell', dec], { timeoutMs: 2000 }),
      ]);
      if (!ok(n) && !ok(g)) return null;
      const pid = ok(p) ? parseInt(String(p.stdout).trim(), 10) || 0 : 0;
      const geo = (ok(g) && parseWindowGeometry(g.stdout)) || { x: 0, y: 0, width: 0, height: 0 };
      return {
        id: normalizeX11Id(dec),
        pid,
        app: prettifyApp(commOfPid(pid)),
        title: ok(n) ? String(n.stdout).replace(/\n$/, '') : '',
        ...geo,
      };
    });
    return wins.filter(Boolean);
  }

  /** @returns {Promise<Array<{id,app,title,pid,x,y,width,height,focused,minimized}>>} */
  async listWindows() {
    this._requireDisplay();
    let wins = null;
    if (this._has('wmctrl')) {
      const r = await this._run('wmctrl', ['-lpGx'], { timeoutMs: 5000, env: this._utf8Env() });
      if (ok(r)) wins = parseWmctrl(r.stdout, { hostnames: this._opts.hostnames });
      else log.debug('wmctrl -lpGx failed:', firstLine(r.stderr));
    }
    if (!wins && this._has('xdotool')) wins = await this._listWindowsXdotool();
    if (!wins) throw unsupportedError('Cannot list windows: install wmctrl (or xdotool)', this._hint(['wmctrl', 'xdotool']));

    // wmctrl -G (and older xdotool getwindowgeometry) add the client's offset inside its frame to the
    // client's origin, so x/y land one title bar too low. xwininfo reports the true absolute origin.
    if (this._has('xwininfo') && wins.length) {
      const r = await this._run('xwininfo', ['-root', '-tree'], { timeoutMs: 3000, env: this._env({ LC_ALL: 'C' }) });
      const abs = ok(r) ? parseXwininfoTree(r.stdout) : null;
      if (abs) {
        for (const w of wins) {
          const a = abs.get(w.id);
          if (a) {
            w.x = a.x;
            w.y = a.y;
          }
        }
      } else {
        log.debug('xwininfo -root -tree failed:', firstLine(r.stderr));
      }
    }

    const activeId = await this._activeWindowId().catch(() => null);
    if (this._has('xprop') && wins.length) {
      const states = await mapLimit(wins, 8, (w) => this._xprop(w.id, ['_NET_WM_STATE', '_NET_WM_WINDOW_TYPE']));
      wins = wins.filter((w, i) => {
        const p = states[i];
        w.minimized = Boolean(p && p._NET_WM_STATE && p._NET_WM_STATE.values.includes('_NET_WM_STATE_HIDDEN'));
        const types = (p && p._NET_WM_WINDOW_TYPE && p._NET_WM_WINDOW_TYPE.values) || [];
        return !types.some((t) => /_NET_WM_WINDOW_TYPE_(DOCK|DESKTOP)$/.test(t));
      });
    }
    // Stacking order (EWMH lists it bottom to top): stackIndex 0 = topmost.
    if (this._has('xprop') && wins.length) {
      const r = await this._run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING'], { timeoutMs: 2000, env: this._env({ LC_ALL: 'C' }) });
      const ids = ok(r) ? parseClientListStacking(r.stdout) : [];
      if (ids.length) {
        const pos = new Map(ids.map((id, idx) => [id, ids.length - 1 - idx]));
        for (const w of wins) if (pos.has(w.id)) w.stackIndex = pos.get(w.id);
      }
    }
    return wins.map((w) => ({
      id: w.id,
      app: w.app || '',
      title: w.title || '',
      pid: w.pid || 0,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      focused: w.id === activeId,
      minimized: Boolean(w.minimized),
      ...(Number.isInteger(w.stackIndex) ? { stackIndex: w.stackIndex } : {}),
    }));
  }

  /** @returns {Promise<{id,app,title,pid}|null>} */
  async activeWindow() {
    const id = await this._activeWindowId();
    if (!id) return null;
    const d = await this._windowDetails(id);
    return { id, app: d.app, title: d.title, pid: d.pid };
  }

  async _windowExists(id) {
    if (this._has('xprop')) {
      const r = await this._run('xprop', ['-id', id, 'WM_CLASS'], { timeoutMs: 2000, env: this._env({ LC_ALL: 'C' }) });
      return ok(r);
    }
    if (this._has('xwininfo')) {
      const r = await this._run('xwininfo', ['-id', id], { timeoutMs: 2000 });
      return ok(r);
    }
    return true;
  }

  async _waitActive(id, ms) {
    const until = Date.now() + ms;
    do {
      const cur = await this._activeWindowId().catch(() => null);
      if (cur === id) return true;
      await sleep(60);
    } while (Date.now() < until);
    return false;
  }

  async focusWindow(id) {
    this._requireDisplay();
    const hex = normalizeX11Id(id);
    if (!this._has('wmctrl') && !this._has('xdotool')) {
      throw unsupportedError('Cannot focus windows: install wmctrl or xdotool', this._hint(['wmctrl', 'xdotool']));
    }
    if (!(await this._windowExists(hex))) return false;
    let done = false;
    if (this._has('wmctrl')) {
      const r = await this._run('wmctrl', ['-i', '-a', hex], { timeoutMs: 3000 });
      done = ok(r);
      if (done && (await this._waitActive(hex, 600))) return true;
    }
    if (this._has('xdotool')) {
      const dec = x11IdToDecimal(hex);
      const r = await this._run('xdotool', ['windowactivate', '--sync', dec], { timeoutMs: 2500 });
      if (ok(r)) return true;
      // Without an EWMH window manager windowactivate fails; raise + focus directly.
      const f = await this._run('xdotool', ['windowraise', dec, 'windowfocus', dec], { timeoutMs: 2500 });
      if (ok(f)) return true;
    }
    return done;
  }

  /** True when the window is iconified (EWMH hidden or ICCCM Iconic). */
  async _isMinimized(id) {
    const r = await this._run('xprop', ['-id', id, '_NET_WM_STATE', 'WM_STATE'], { timeoutMs: 2000, env: this._env({ LC_ALL: 'C' }) });
    return ok(r) && /_NET_WM_STATE_HIDDEN|window state:\s*Iconic/.test(String(r.stdout));
  }

  async minimizeWindow(id) {
    this._requireDisplay();
    const hex = normalizeX11Id(id);
    if (!this._has('xdotool') && !this._has('wmctrl')) {
      throw unsupportedError('Cannot minimize windows: install xdotool', this._hint(['xdotool']));
    }
    // Verify when possible: some window managers silently ignore iconify requests
    // (e.g. for windows on another desktop).
    const verify = this._has('xprop');
    const attempts = [];
    if (this._has('xdotool')) attempts.push(['xdotool', ['windowminimize', x11IdToDecimal(hex)]]);
    if (this._has('wmctrl')) attempts.push(['wmctrl', ['-i', '-r', hex, '-b', 'add,hidden']]);
    let sent = false;
    for (const [cmd, args] of attempts) {
      const r = await this._run(cmd, args, { timeoutMs: 3000 });
      if (!ok(r)) continue;
      sent = true;
      if (!verify) return true;
      const until = Date.now() + 600;
      do {
        if (await this._isMinimized(hex)) return true;
        await sleep(60);
      } while (Date.now() < until);
    }
    return verify ? false : sent;
  }

  async setTopmost(id, on) {
    this._requireDisplay();
    const hex = normalizeX11Id(id);
    if (this._has('wmctrl')) {
      const r = await this._run('wmctrl', ['-i', '-r', hex, '-b', `${on ? 'add' : 'remove'},above`], { timeoutMs: 3000 });
      if (ok(r)) return true;
    }
    if (this._has('xdotool')) {
      // `windowstate` exists in xdotool >= 3.20210804 only.
      const r = await this._run('xdotool', ['windowstate', on ? '--add' : '--remove', 'ABOVE', x11IdToDecimal(hex)], { timeoutMs: 3000 });
      if (ok(r)) return true;
    }
    return false;
  }

  // ----- clipboard -----

  async clipboardGet() {
    this._requireDisplay();
    if (this._has('xclip')) {
      for (const extra of [['-t', 'UTF8_STRING'], []]) {
        const r = await this._run('xclip', ['-selection', 'clipboard', '-o', ...extra], { timeoutMs: 3000 });
        if (ok(r)) return String(r.stdout);
      }
      if (!this._has('xsel')) return '';
    }
    if (this._has('xsel')) {
      const r = await this._run('xsel', ['-b', '-o'], { timeoutMs: 3000 });
      return ok(r) ? String(r.stdout) : '';
    }
    throw unsupportedError('No clipboard tool: install xclip (or xsel)', this._hint(['xclip']));
  }

  async clipboardSet(text) {
    this._requireDisplay();
    const s = text == null ? '' : String(text);
    if (this._has('xclip')) return this._spawnClipboardSetter('xclip', ['-selection', 'clipboard', '-i'], s);
    if (this._has('xsel')) return this._spawnClipboardSetter('xsel', ['-b', '-i'], s);
    throw unsupportedError('No clipboard tool: install xclip (or xsel)', this._hint(['xclip']));
  }

  // ----- capabilities -----

  async capabilities() {
    const notes = [];
    const missing = [];
    const display = this._env().DISPLAY;
    let reachable = Boolean(display);
    if (!display) {
      notes.push('DISPLAY is not set: no X11 screen is reachable from this process.');
    } else if (this._has('xdotool')) {
      const r = await this._run('xdotool', ['getdisplaygeometry'], { timeoutMs: 2500 });
      if (!ok(r)) {
        reachable = false;
        notes.push(`Cannot open X display ${display}: ${firstLine(r.stderr) || 'no response'}. Check DISPLAY/XAUTHORITY.`);
      }
    }
    const shotTools = X11_CAPTURE_TOOLS.filter((t) => this._captureAvailable(t));
    if (shotTools.length) notes.push(`Screenshots via ${this._captureTool || shotTools[0]}.`);
    else missing.push('imagemagick');
    const xdotool = this._has('xdotool');
    if (!xdotool) missing.push('xdotool');
    if (!this._has('wmctrl')) {
      missing.push('wmctrl');
      if (xdotool) notes.push('wmctrl not found: window listing falls back to xdotool (visible windows only).');
    }
    const clip = this._has('xclip') || this._has('xsel');
    if (!clip) missing.push('xclip');
    if (!this._has('xrandr')) {
      missing.push('xrandr');
      notes.push('xrandr not found: multiple monitors are reported as one screen.');
    }
    if (!this._has('xprop')) notes.push('xprop not found: minimized state and panel filtering are unavailable.');
    if (!this._has('xwininfo') && (this._has('wmctrl') || xdotool)) {
      notes.push(`xwininfo not found: listed window positions may be off by the title-bar height (${this._hint(['xwininfo'])}).`);
    }
    const notify = this._has('notify-send');
    if (!notify) missing.push('notify-send');
    const speak = this._speakAvailable();
    if (!speak) missing.push('espeak-ng');
    const install = missing.length ? this._hint(missing) : '';
    if (install) notes.push(`Install missing tools: ${install}`);
    return {
      screenshot: reachable && shotTools.length > 0,
      mouse: reachable && xdotool,
      keyboard: reachable && xdotool,
      windows: reachable && (this._has('wmctrl') || xdotool),
      clipboard: reachable && clip,
      notify,
      speak,
      notes,
      install,
    };
  }
}

// ---------------------------------------------------------------------------
// Wayland
// ---------------------------------------------------------------------------

/**
 * Identify the Wayland compositor from the environment.
 * @param {object} env
 * @returns {'sway'|'hyprland'|'gnome'|'kde'|'wlroots'|'unknown'}
 */
function detectCompositor(env) {
  // Sockets and variables the compositors export to their clients beat desktop names.
  if (env.SWAYSOCK) return 'sway';
  if (env.HYPRLAND_INSTANCE_SIGNATURE) return 'hyprland';
  if (env.LABWC_PID || env.WAYFIRE_SOCKET || env.NIRI_SOCKET) return 'wlroots';
  // Whole ':'-separated tokens ("ubuntu:GNOME", "Budgie:GNOME"), never substrings ("Lubuntu" is not Ubuntu).
  const tokens = [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION]
    .filter(Boolean)
    .join(':')
    .toLowerCase()
    .split(':')
    .map((t) => t.trim().split('/').pop())
    .filter(Boolean);
  const any = (re) => tokens.some((t) => re.test(t));
  if (any(/^sway$/)) return 'sway';
  if (any(/^hyprland$/)) return 'hyprland';
  // wlroots-family first: Budgie's Wayland session (10.10+) runs on labwc but still says "Budgie:GNOME".
  if (any(/^(wlroots|labwc|wayfire|river|niri|hikari|dwl|qtile|cosmic|budgie(-desktop)?)$/)) return 'wlroots';
  if (any(/^(gnome(-.+)?|unity|ubuntu(-wayland|-xorg)?|pop)$/)) return 'gnome';
  if (any(/^(kde|plasma(-?wayland|-?x11)?)$/)) return 'kde';
  return 'unknown';
}

const SWAY_BUTTONS = { 1: 'button1', 2: 'button2', 3: 'button3', 8: 'button8', 9: 'button9' };
const YDO_BUTTONS = { 1: 0, 3: 1, 2: 2, 8: 3, 9: 4 };
const YDOTOOLD_HINT =
  'ydotool needs its daemon ydotoold running with write access to /dev/uinput: enable the user service ' +
  '(`systemctl --user enable --now ydotool`, after giving your user access to /dev/uinput), or run ' +
  '`sudo ydotoold --socket-path=/tmp/.ydotool_socket --socket-own=$(id -u):$(id -g) &`. The socket is looked ' +
  'for at $YDOTOOL_SOCKET, $XDG_RUNTIME_DIR/.ydotool_socket and /tmp/.ydotool_socket.';
const YDOTOOL_LEGACY_MESSAGE =
  'ydotool 0.1.x (the version Debian 12 and Ubuntu up to 24.04 package) is too old: ydotool >= 1.0 with ydotoold is required';
const YDOTOOL_LEGACY_HINT =
  'Remove the distro package and build ydotool >= 1.0 from github.com/ReimuNotMoe/ydotool (then start ydotoold), ' +
  'or choose "Ubuntu on Xorg"/"GNOME on Xorg" at login.';
/** How long a "legacy" or unrecognised ydotool probe result is trusted before ydotool is probed again. */
const YDOTOOL_PROBE_TTL_MS = 30000;

/**
 * Tell ydotool generations apart from `ydotool help` (stdout + stderr; no daemon needed by either).
 * 1.x lists its `debug` and `bakers` commands (and names YDOTOOL_SOCKET since 1.0.4); 0.1.x lists
 * `recorder`. 0.1.x also has no mouse down/up or wheel, and exits 0 even when it rejects its arguments, so
 * it cannot be driven safely.
 * @param {string} text
 * @returns {'1'|'0.1'|null} null when the output is not recognised
 */
function parseYdotoolHelp(text) {
  const s = String(text || '');
  if (/^\s*(bakers|debug)\s*$/m.test(s) || /YDOTOOL_SOCKET/.test(s)) return '1';
  if (/^\s*recorder\s*$/m.test(s)) return '0.1';
  return null;
}

/** ydotool click code for a button and phase (0xC0 = down+up, 0x40 = down, 0x80 = up). */
function ydotoolButtonCode(button, phase = 'click') {
  const idx = YDO_BUTTONS[x11Button(button)];
  const flag = phase === 'down' ? 0x40 : phase === 'up' ? 0x80 : 0xc0;
  return `0x${(flag | idx).toString(16).toUpperCase()}`;
}

class WaylandDriver extends LinuxDriverBase {
  constructor(opts = {}) {
    super(opts);
    this.name = 'linux-wayland';
    this.displayServer = 'wayland';
    this.compositor = detectCompositor(this._env());
    this._lastPointer = null;
    this._outputNames = new Set();
    this._wtypeBroken = false;
    this._warnedXwayland = false;
    this._x11 = null;
    this._ydoGen = null;
  }

  /** XWayland helper for fallbacks (only when DISPLAY is set). */
  _xw() {
    if (!this._env().DISPLAY) return null;
    if (!this._x11) this._x11 = new X11Driver(this._opts);
    return this._x11;
  }

  /**
   * Find the ydotoold socket: the first candidate this user can write to, else the first one that exists.
   * @returns {{path:string, writable:boolean}|null}
   */
  _ydotoolSocketInfo() {
    const env = this._env();
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const candidates = [
      env.YDOTOOL_SOCKET,
      env.XDG_RUNTIME_DIR && path.join(env.XDG_RUNTIME_DIR, '.ydotool_socket'),
      uid != null && `/run/user/${uid}/.ydotool_socket`,
      '/tmp/.ydotool_socket',
    ].filter(Boolean);
    let existing = null;
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
      } catch {
        continue;
      }
      try {
        fs.accessSync(p, fs.constants.W_OK);
        return { path: p, writable: true };
      } catch {
        if (!existing) existing = { path: p, writable: false };
      }
    }
    return existing;
  }

  /** Path of a ydotoold socket this user can connect to, or null. */
  _ydotoolSocket() {
    const s = this._ydotoolSocketInfo();
    return s && s.writable ? s.path : null;
  }

  /** `ydotool` install hint; apt systems are told that their packaged version is too old. */
  _ydotoolInstallHint(tools = ['ydotool']) {
    const hint = this._hint(tools);
    if (this._packageManager() !== 'apt') return hint;
    return `${hint} (needs ydotool >= 1.0: Debian 12 and Ubuntu up to 24.04 package 0.1.8, so build it from github.com/ReimuNotMoe/ydotool there)`;
  }

  /**
   * Installed ydotool generation ('1' or '0.1'), probed once with `ydotool help`. A legacy or unrecognised
   * answer is probed again after a while, so upgrading ydotool needs no daemon restart.
   */
  async _ydotoolGen() {
    const c = this._ydoGen;
    if (c && (c.final || Date.now() - c.at < YDOTOOL_PROBE_TTL_MS)) return c.gen;
    const r = await this._run('ydotool', ['help'], { timeoutMs: 3000 });
    const parsed = parseYdotoolHelp(`${typeof r.stdout === 'string' ? r.stdout : ''}\n${r.stderr || ''}`);
    // Unrecognised output keeps the 1.x syntax (the only one this driver speaks).
    this._ydoGen = { gen: parsed || '1', final: parsed === '1', at: Date.now() };
    return this._ydoGen.gen;
  }

  /** Throw UNSUPPORTED unless ydotool >= 1.0 is installed. */
  async _requireYdotool() {
    if (!this._has('ydotool')) {
      throw unsupportedError('ydotool is not installed (needed for mouse input on Wayland)', `${this._ydotoolInstallHint()}. ${YDOTOOLD_HINT}`);
    }
    if ((await this._ydotoolGen()) === '0.1') throw unsupportedError(YDOTOOL_LEGACY_MESSAGE, YDOTOOL_LEGACY_HINT);
  }

  async _ydotool(args, opts = {}) {
    await this._requireYdotool();
    // ydotool 1.x only looks at $YDOTOOL_SOCKET, else $XDG_RUNTIME_DIR/.ydotool_socket, else /tmp: hand it
    // the socket that was actually found (e.g. /tmp/.ydotool_socket while XDG_RUNTIME_DIR is set).
    const sock = this._ydotoolSocket();
    const env = opts.env || (sock ? this._env({ YDOTOOL_SOCKET: sock }) : this._env());
    const r = await this._run('ydotool', args, { timeoutMs: 5000, ...opts, env });
    if (!ok(r)) {
      // ydotool 1.x prints its connection errors on stdout.
      const msg = `${r.stderr || ''}\n${typeof r.stdout === 'string' ? r.stdout : ''}`.trim();
      if (/socket|ydotoold|connect|uinput|permission/i.test(msg)) {
        const info = sock ? null : this._ydotoolSocketInfo();
        const why = info ? `ydotoold socket ${info.path} is not writable by this user` : firstLine(msg);
        throw unsupportedError(`ydotool cannot reach ydotoold: ${why}`, YDOTOOLD_HINT);
      }
      throw commandError('ydotool', args, r, YDOTOOLD_HINT);
    }
    return r;
  }

  _swayOk() {
    return this.compositor === 'sway' && this._has('swaymsg');
  }

  _hyprOk() {
    return this.compositor === 'hyprland' && this._has('hyprctl');
  }

  async _hyprDispatch(...args) {
    const r = await this._run('hyprctl', ['dispatch', ...args], { timeoutMs: 3000 });
    return ok(r) && /\bok\b/i.test(String(r.stdout));
  }

  // ----- displays and capture -----

  async displays() {
    const now = Date.now();
    if (this._displayCache && now - this._displayCache.at < this._displayCache.ttl) {
      return this._displayCache.list.map((d) => ({ ...d }));
    }
    let list = [];
    let named = false;
    let ttl = DISPLAY_CACHE_MS;
    if (this._swayOk()) {
      const r = await this._run('swaymsg', ['-t', 'get_outputs', '-r'], { timeoutMs: 3000 });
      if (ok(r)) list = parseSwayOutputs(r.stdout);
      named = list.length > 0;
    }
    if (!list.length && this._hyprOk()) {
      const r = await this._run('hyprctl', ['monitors', '-j'], { timeoutMs: 3000 });
      if (ok(r)) list = parseHyprMonitors(r.stdout);
      named = list.length > 0;
    }
    if (!list.length && this._has('wlr-randr')) {
      let r = await this._run('wlr-randr', ['--json'], { timeoutMs: 3000 });
      if (ok(r)) list = parseWlrRandrJson(r.stdout);
      if (!list.length) {
        r = await this._run('wlr-randr', [], { timeoutMs: 3000 });
        if (ok(r)) list = parseWlrRandr(r.stdout);
      }
      named = list.length > 0;
    }
    if (!list.length && this._xw()) {
      try {
        list = await this._xw().displays();
      } catch (e) {
        log.debug('XWayland display query failed:', e.message);
      }
    }
    if (!list.length) {
      // Last resort costs a full screenshot, so keep the result for longer.
      list = await this._displaysFromScreenshot();
      ttl = 60000;
    }
    if (!list.length) {
      throw unsupportedError(
        `Cannot read the Wayland screen layout (compositor: ${this.compositor})`,
        this._hint(['wlr-randr', 'grim']),
      );
    }
    this._outputNames = named ? new Set(list.map((d) => d.id)) : new Set();
    this._displayCache = { at: now, list, ttl };
    return list.map((d) => ({ ...d }));
  }

  async _displaysFromScreenshot() {
    try {
      const shot = await this._captureFull();
      if (!shot) return [];
      const info = pngInfo(shot);
      if (!info) return [];
      return finalizeDisplays([{ id: 'screen', x: 0, y: 0, width: info.width, height: info.height, primary: true }]);
    } catch (e) {
      log.debug('screenshot-derived display size failed:', e.message);
      return [];
    }
  }

  _captureOrder() {
    const base =
      this.compositor === 'gnome'
        ? ['gnome-screenshot', 'grim', 'spectacle', 'xwayland']
        : this.compositor === 'kde'
          ? ['spectacle', 'grim', 'gnome-screenshot', 'xwayland']
          : ['grim', 'gnome-screenshot', 'spectacle', 'xwayland'];
    return this._captureTool ? [this._captureTool, ...base.filter((t) => t !== this._captureTool)] : base;
  }

  _captureAvailable(tool) {
    if (tool === 'xwayland') return Boolean(this._xw());
    return this._has(tool);
  }

  async _fullShotWith(tool) {
    if (tool === 'grim') {
      const r = await this._run('grim', ['-'], { encoding: 'buffer', timeoutMs: CAPTURE_TIMEOUT_MS });
      if (!ok(r)) throw commandError('grim', ['-'], r);
      return r.stdout;
    }
    if (tool === 'gnome-screenshot' || tool === 'spectacle') {
      const file = tempPngPath('shot');
      const args = tool === 'gnome-screenshot' ? ['-f', file] : ['-b', '-n', '-f', '-o', file];
      const r = await this._run(tool, args, { timeoutMs: CAPTURE_TIMEOUT_MS + 5000 });
      if (!ok(r)) {
        fs.promises.rm(file, { force: true }).catch(() => {});
        throw commandError(tool, args, r);
      }
      // spectacle may exit before the file is fully written.
      for (let i = 0; i < 20 && !pngInfo(await fs.promises.readFile(file).catch(() => null)); i++) await sleep(100);
      return readAndRemove(file);
    }
    throw new Error(`Unknown capture tool ${tool}`);
  }

  async _captureFull() {
    for (const tool of ['grim', 'gnome-screenshot', 'spectacle']) {
      if (!this._has(tool)) continue;
      try {
        const buf = await this._fullShotWith(tool);
        if (pngInfo(buf)) return buf;
      } catch (e) {
        log.debug(`${tool} full capture failed:`, e.message);
      }
    }
    return null;
  }

  async captureDisplay(index = 0) {
    const displays = await this.displays();
    const d = displays[index];
    if (!d) {
      const err = new Error(`Display ${index} does not exist (found ${displays.length})`);
      err.code = 'BAD_DISPLAY';
      throw err;
    }
    const errors = [];
    let tried = 0;
    for (const tool of this._captureOrder()) {
      if (!this._captureAvailable(tool)) continue;
      tried++;
      try {
        let buf;
        if (tool === 'grim') {
          let args;
          if (displays.length === 1) args = ['-'];
          else if (this._outputNames.has(d.id)) args = ['-o', d.id, '-'];
          else args = ['-g', `${d.x},${d.y} ${d.width}x${d.height}`, '-'];
          const r = await this._run('grim', args, { encoding: 'buffer', timeoutMs: CAPTURE_TIMEOUT_MS });
          if (!ok(r)) throw commandError('grim', args, r);
          buf = r.stdout;
        } else if (tool === 'xwayland') {
          if (!this._warnedXwayland) {
            log.warn('Falling back to XWayland capture: native Wayland windows may appear black or missing.');
            this._warnedXwayland = true;
          }
          const shot = await this._xw().captureDisplay(Math.min(index, (await this._xw().displays()).length - 1));
          buf = shot.png;
        } else {
          buf = await this._fullShotWith(tool);
          const info = pngInfo(buf);
          if (info && displays.length > 1) {
            const u = unionRect(displays);
            const f = info.width / u.width;
            buf = await this._cropPng(buf, {
              x: Math.round((d.x - u.x) * f),
              y: Math.round((d.y - u.y) * f),
              width: Math.round(d.width * f),
              height: Math.round(d.height * f),
            });
          }
        }
        const info = pngInfo(buf);
        if (!info) {
          errors.push(`${tool}: output is not a complete PNG`);
          continue;
        }
        this._captureTool = tool;
        return { png: buf, width: info.width, height: info.height };
      } catch (e) {
        errors.push(`${tool}: ${e.message}`);
      }
    }
    if (!tried) {
      const pkgs = this.compositor === 'gnome' ? ['gnome-screenshot'] : this.compositor === 'kde' ? ['spectacle'] : ['grim'];
      throw unsupportedError(`No Wayland screenshot tool found for ${this.compositor}`, this._hint(pkgs));
    }
    const err = new Error(`Screenshot failed: ${errors.join('; ')}`);
    err.code = 'CAPTURE_FAILED';
    err.hint =
      this.compositor === 'gnome' || this.compositor === 'kde'
        ? 'GNOME/KDE restrict screen capture on Wayland; install gnome-screenshot/spectacle or log in to an X11 session.'
        : this._hint(['grim']);
    throw err;
  }

  // ----- pointer -----

  /**
   * Only Hyprland reports the real pointer. Elsewhere Wayland hides it, so the last position this driver set
   * (else the primary display's centre) is returned with `estimated: true`: callers that act on where the user
   * put the pointer (the top-left-corner failsafe) must treat it as unknown.
   * @returns {Promise<{x:number, y:number, estimated?:true}>}
   */
  async cursorPosition() {
    if (this._hyprOk()) {
      const r = await this._run('hyprctl', ['cursorpos'], { timeoutMs: 2000 });
      const m = ok(r) ? /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(r.stdout) : null;
      if (m) return { x: Math.round(+m[1]), y: Math.round(+m[2]) };
    }
    if (this._lastPointer) return { x: this._lastPointer.x, y: this._lastPointer.y, estimated: true };
    const ds = await this._displaysSafe();
    const d = ds && ds[0];
    const p = d ? { x: Math.round(d.x + d.width / 2), y: Math.round(d.y + d.height / 2) } : { x: 640, y: 360 };
    return { ...p, estimated: true };
  }

  async moveMouse(x, y) {
    const p = clampToDisplays(x, y, await this._displaysSafe());
    let moved = false;
    if (this._swayOk()) {
      moved = ok(await this._run('swaymsg', [`seat - cursor set ${p.x} ${p.y}`], { timeoutMs: 3000 }));
    }
    if (!moved && this._hyprOk()) moved = await this._hyprDispatch('movecursor', String(p.x), String(p.y));
    if (!moved) await this._ydotool(['mousemove', '--absolute', '-x', p.x, '-y', p.y]);
    this._lastPointer = p;
  }

  async _withModifiers(modifiers, fn) {
    const mods = x11Modifiers(modifiers).map((m) => (m === 'super' ? 'meta' : m));
    if (!mods.length) return fn();
    const codes = mods.map((m) => EVDEV[m]);
    await this._ydotool(['key', ...codes.map((c) => `${c}:1`)]);
    try {
      return await fn();
    } finally {
      await this._ydotool(['key', ...codes.slice().reverse().map((c) => `${c}:0`)]).catch(() => {});
    }
  }

  async click(x, y, { button = 'left', clicks = 1, modifiers = [] } = {}) {
    const b = x11Button(button);
    const n = clampInt(clicks, 1, 10, 1);
    if (x != null && y != null) await this.moveMouse(x, y);
    await this._withModifiers(modifiers, async () => {
      if (this._swayOk() && SWAY_BUTTONS[b]) {
        const cmd = Array.from({ length: n }, () => `seat - cursor press ${SWAY_BUTTONS[b]}; seat - cursor release ${SWAY_BUTTONS[b]}`).join('; ');
        if (ok(await this._run('swaymsg', [cmd], { timeoutMs: 3000 }))) return;
      }
      await this._ydotool(['click', '-D', '80', ...Array(n).fill(ydotoolButtonCode(b))]);
    });
  }

  async _press(button, down) {
    const b = x11Button(button);
    if (this._swayOk() && SWAY_BUTTONS[b]) {
      if (ok(await this._run('swaymsg', [`seat - cursor ${down ? 'press' : 'release'} ${SWAY_BUTTONS[b]}`], { timeoutMs: 3000 }))) return;
    }
    await this._ydotool(['click', ydotoolButtonCode(b, down ? 'down' : 'up')]);
  }

  async mouseDown(button = 'left') {
    await this._press(button, true);
  }

  async mouseUp(button = 'left') {
    await this._press(button, false);
  }

  async drag(x1, y1, x2, y2, { button = 'left' } = {}) {
    const displays = await this._displaysSafe();
    const from = clampToDisplays(x1, y1, displays);
    const to = clampToDisplays(x2, y2, displays);
    await this.moveMouse(from.x, from.y);
    await this._press(button, true);
    try {
      await sleep(50);
      let prev = from;
      for (let i = 1; i <= DRAG_STEPS; i++) {
        const p = {
          x: Math.round(from.x + ((to.x - from.x) * i) / DRAG_STEPS),
          y: Math.round(from.y + ((to.y - from.y) * i) / DRAG_STEPS),
        };
        if (this._swayOk() || this._hyprOk()) {
          await this.moveMouse(p.x, p.y);
        } else {
          // Absolute ydotool moves jump through (0,0) first, which would drag there; step relatively.
          await this._ydotool(['mousemove', '-x', p.x - prev.x, '-y', p.y - prev.y]);
          this._lastPointer = p;
        }
        prev = p;
        await sleep(DRAG_STEP_MS);
      }
    } finally {
      await this._press(button, false).catch((e) => log.warn('mouse release after drag failed:', e.message));
    }
  }

  async scroll(x, y, dx = 0, dy = 0) {
    if (x != null && y != null) await this.moveMouse(x, y);
    const vy = clampInt(dy, -MAX_NOTCHES, MAX_NOTCHES, 0);
    const vx = clampInt(dx, -MAX_NOTCHES, MAX_NOTCHES, 0);
    if (!vx && !vy) return;
    if (this._swayOk()) {
      const cmds = [];
      for (let i = 0; i < Math.abs(vy); i++) cmds.push(`seat - cursor press ${vy > 0 ? 'button5' : 'button4'}`);
      for (let i = 0; i < Math.abs(vx); i++) cmds.push(`seat - cursor press ${vx > 0 ? 'button7' : 'button6'}`);
      if (ok(await this._run('swaymsg', [cmds.join('; ')], { timeoutMs: 5000 }))) return;
    }
    // REL_WHEEL is positive for "up"; REL_HWHEEL positive for "right".
    await this._ydotool(['mousemove', '--wheel', '-x', vx, '-y', -vy]);
  }

  // ----- keyboard -----

  _canWtype() {
    return this._has('wtype') && this.compositor !== 'gnome' && !this._wtypeBroken;
  }

  async _wtype(args, timeoutMs) {
    const r = await this._run('wtype', args, { timeoutMs });
    if (ok(r)) return true;
    if (/virtual keyboard|not support|protocol/i.test(String(r.stderr))) {
      log.warn('wtype is not supported by this compositor; using ydotool instead');
      this._wtypeBroken = true;
      return false;
    }
    throw commandError('wtype', args, r, this._hint(['wtype']));
  }

  async typeText(text) {
    if (text == null || text === '') return;
    let chunks = chunkText(String(text).replace(/\r\n?/g, '\n'), TYPE_CHUNK);
    if (this._canWtype()) {
      while (chunks.length && (await this._wtype(wtypeTextArgs(chunks[0]), 10000 + chunks[0].length * 60))) {
        chunks = chunks.slice(1);
      }
      if (!chunks.length) return;
    }
    if (!this._has('ydotool')) {
      throw unsupportedError('No Wayland keyboard tool found', `${this._ydotoolInstallHint(['wtype', 'ydotool'])}. ${YDOTOOLD_HINT}`);
    }
    // Before the clipboard is touched for a paste.
    await this._requireYdotool();
    // Continue with whatever wtype did not type.
    const rest = chunks.join('');
    if (/[^\x00-\x7f]/.test(rest)) {
      // ydotool types US-layout ASCII only; paste anything else.
      await this._pasteText(rest);
      return;
    }
    for (const chunk of chunks) {
      await this._ydotool(['type', '-d', '8', '--', chunk], { timeoutMs: 10000 + chunk.length * 60 });
    }
  }

  async _pasteText(s) {
    log.warn('ydotool cannot type non-ASCII text; pasting it through the clipboard');
    const saved = await this.clipboardGet().catch(() => null);
    await this.clipboardSet(s);
    await sleep(80);
    await this.keyCombo(['ctrl', 'v']);
    await sleep(400);
    if (saved != null) await this.clipboardSet(saved).catch(() => {});
  }

  async keyCombo(keys) {
    const norm = normalizeKeys(keys);
    if (!norm.length) throw new Error('Empty key combo');
    if (this._canWtype() && (await this._wtype(wtypeKeyArgs(norm), 5000))) return;
    if (!this._has('ydotool')) {
      throw unsupportedError('No Wayland keyboard tool found', `${this._ydotoolInstallHint(['wtype', 'ydotool'])}. ${YDOTOOLD_HINT}`);
    }
    await this._ydotool(ydotoolKeyArgs(norm));
  }

  // ----- windows -----

  _windowsUnsupported() {
    const hints = {
      gnome:
        'GNOME on Wayland does not let other programs list or focus windows. Choose "GNOME on Xorg" at login for full ' +
        'window control, or rely on screenshots plus keyboard shortcuts (Super to search apps, Alt+Tab).',
      kde:
        'KDE Plasma on Wayland does not expose window control to command-line tools. Choose "Plasma (X11)" at login, ' +
        'or rely on screenshots plus keyboard shortcuts (Alt+Tab).',
    };
    return unsupportedError(
      `Window management is not available on ${this.compositor} (Wayland)`,
      hints[this.compositor] ||
        'Window control on Wayland works with sway (swaymsg) and Hyprland (hyprctl); elsewhere use screenshots plus ' +
          'keyboard shortcuts, or log in to an X11 session.',
    );
  }

  async _hyprActiveAddress() {
    const r = await this._run('hyprctl', ['activewindow', '-j'], { timeoutMs: 2000 });
    if (!ok(r)) return null;
    try {
      const j = JSON.parse(r.stdout);
      return (j && j.address) || null;
    } catch {
      return null;
    }
  }

  async listWindows() {
    if (this._swayOk()) {
      const r = await this._run('swaymsg', ['-t', 'get_tree', '-r'], { timeoutMs: 4000 });
      if (!ok(r)) throw commandError('swaymsg', ['-t', 'get_tree'], r);
      return walkSwayTree(r.stdout);
    }
    if (this._hyprOk()) {
      const [r, active] = await Promise.all([
        this._run('hyprctl', ['clients', '-j'], { timeoutMs: 4000 }),
        this._hyprActiveAddress(),
      ]);
      if (!ok(r)) throw commandError('hyprctl', ['clients'], r);
      return parseHyprClients(r.stdout, active);
    }
    throw this._windowsUnsupported();
  }

  async activeWindow() {
    if (this._swayOk()) {
      const wins = await this.listWindows();
      const w = wins.find((x) => x.focused);
      return w ? { id: w.id, app: w.app, title: w.title, pid: w.pid } : null;
    }
    if (this._hyprOk()) {
      const r = await this._run('hyprctl', ['activewindow', '-j'], { timeoutMs: 2000 });
      if (!ok(r)) return null;
      try {
        const c = JSON.parse(r.stdout);
        if (!c || !c.address) return null;
        return parseHyprClients([c], c.address).map((w) => ({ id: w.id, app: w.app, title: w.title, pid: w.pid }))[0] || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  _swayId(id) {
    const s = String(id).trim();
    if (!/^\d+$/.test(s)) {
      const err = new Error(`Invalid sway container id: ${JSON.stringify(id)}`);
      err.code = 'BAD_WINDOW_ID';
      throw err;
    }
    return s;
  }

  _hyprAddress(id) {
    const s = String(id).trim().replace(/^address:/, '');
    if (!/^0x[0-9a-f]+$/i.test(s)) {
      const err = new Error(`Invalid Hyprland window address: ${JSON.stringify(id)}`);
      err.code = 'BAD_WINDOW_ID';
      throw err;
    }
    return s;
  }

  async focusWindow(id) {
    if (this._swayOk()) return ok(await this._run('swaymsg', [`[con_id=${this._swayId(id)}] focus`], { timeoutMs: 3000 }));
    if (this._hyprOk()) return this._hyprDispatch('focuswindow', `address:${this._hyprAddress(id)}`);
    throw this._windowsUnsupported();
  }

  async minimizeWindow(id) {
    if (this._swayOk()) return ok(await this._run('swaymsg', [`[con_id=${this._swayId(id)}] move scratchpad`], { timeoutMs: 3000 }));
    if (this._hyprOk()) return this._hyprDispatch('movetoworkspacesilent', `special:minimized,address:${this._hyprAddress(id)}`);
    throw this._windowsUnsupported();
  }

  async setTopmost(id, on) {
    if (this._hyprOk()) {
      const addr = this._hyprAddress(id);
      const r = await this._run('hyprctl', ['clients', '-j'], { timeoutMs: 3000 });
      let c = null;
      try {
        c = ok(r) ? JSON.parse(r.stdout).find((w) => w.address === addr) : null;
      } catch {
        c = null;
      }
      if (!c) return false;
      if (Boolean(c.pinned) === Boolean(on)) return true;
      if (on && !c.floating && !(await this._hyprDispatch('setfloating', `address:${addr}`))) return false;
      return this._hyprDispatch('pin', `address:${addr}`);
    }
    // sway and others have no "always on top" for tiled windows.
    return false;
  }

  // ----- clipboard -----

  async clipboardGet() {
    if (this._has('wl-paste')) {
      const r = await this._run('wl-paste', ['-n'], { timeoutMs: 3000 });
      if (ok(r)) return String(r.stdout);
      if (/nothing is copied|no selection|no suitable type/i.test(String(r.stderr))) return '';
    }
    const xw = this._xw();
    if (xw && (this._has('xclip') || this._has('xsel'))) return xw.clipboardGet();
    if (this._has('wl-paste')) return '';
    throw unsupportedError('No Wayland clipboard tool found', this._hint(['wl-clipboard']));
  }

  async clipboardSet(text) {
    const s = text == null ? '' : String(text);
    if (this._has('wl-copy')) return this._spawnClipboardSetter('wl-copy', [], s, { settleMs: 50 });
    const xw = this._xw();
    if (xw && (this._has('xclip') || this._has('xsel'))) return xw.clipboardSet(s);
    throw unsupportedError('No Wayland clipboard tool found', this._hint(['wl-clipboard']));
  }

  // ----- capabilities -----

  async capabilities() {
    const notes = [`Wayland compositor: ${this.compositor}.`];
    const missing = [];
    const shotTools = this._captureOrder().filter((t) => this._captureAvailable(t));
    if (shotTools.length) {
      const t = this._captureTool || shotTools[0];
      notes.push(`Screenshots via ${t === 'xwayland' ? 'XWayland (X11 apps only)' : t}.`);
    } else {
      missing.push(this.compositor === 'gnome' ? 'gnome-screenshot' : this.compositor === 'kde' ? 'spectacle' : 'grim');
    }
    const ydotool = this._has('ydotool');
    const legacy = ydotool && (await this._ydotoolGen()) === '0.1';
    const sock = ydotool && !legacy ? this._ydotoolSocketInfo() : null;
    const ydotoolReady = Boolean(sock && sock.writable);
    if (!ydotool) {
      missing.push('ydotool');
      if (this._packageManager() === 'apt') {
        notes.push('ydotool >= 1.0 is required: Debian 12 and Ubuntu up to 24.04 package 0.1.8, so build it from github.com/ReimuNotMoe/ydotool.');
      }
    } else if (legacy) {
      notes.push(`${YDOTOOL_LEGACY_MESSAGE}. ${YDOTOOL_LEGACY_HINT}`);
    } else if (!sock) {
      notes.push(`ydotoold socket not found. ${YDOTOOLD_HINT}`);
    } else if (!sock.writable) {
      notes.push(`ydotoold socket ${sock.path} is not writable by this user. ${YDOTOOLD_HINT}`);
    }
    const mouse = this._swayOk() || ydotoolReady;
    if (ydotoolReady && !this._swayOk() && !this._hyprOk()) {
      notes.push('ydotool moves the pointer relatively; use a flat pointer-acceleration profile for accurate clicks.');
    }
    if (!this._hyprOk()) {
      notes.push(
        `The pointer position cannot be read on ${this.compositor} Wayland (only an estimate is reported), so the ` +
          'top-left-corner failsafe is unavailable: stop Claude with Esc, the Stop button or by saying "stop".',
      );
    }
    const wtype = this._has('wtype') && this.compositor !== 'gnome';
    if (!this._has('wtype') && this.compositor !== 'gnome') missing.push('wtype');
    const keyboard = wtype || ydotoolReady;
    const windows = this._swayOk() || this._hyprOk();
    if (!windows) notes.push(this._windowsUnsupported().hint);
    const wl = this._has('wl-copy') && this._has('wl-paste');
    if (!wl) missing.push('wl-clipboard');
    const clipboard = wl || Boolean(this._xw() && (this._has('xclip') || this._has('xsel')));
    const notify = this._has('notify-send');
    if (!notify) missing.push('notify-send');
    const speak = this._speakAvailable();
    if (!speak) missing.push('espeak-ng');
    const install = missing.length ? this._hint(missing) : '';
    if (install) notes.push(`Install missing tools: ${install}`);
    return { screenshot: shotTools.length > 0, mouse, keyboard, windows, clipboard, notify, speak, notes, install };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the Linux driver for the given display server.
 * @param {{displayServer?: 'x11'|'wayland'|'none', env?: object, run?: Function, which?: Function, spawn?: Function,
 *   hostnames?: string[], png?: object|null}} [opts]
 *   `env`, `run`, `which`, `spawn`, `hostnames` and `png` exist for tests; production code passes only displayServer.
 * @returns {X11Driver|WaylandDriver}
 */
function createDriver(opts = {}) {
  let ds = opts.displayServer;
  if (!ds) {
    const env = opts.env || process.env;
    if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland') ds = 'wayland';
    else ds = 'x11';
  }
  if (ds === 'wayland') return new WaylandDriver(opts);
  return new X11Driver(opts);
}

module.exports = {
  createDriver,
  X11Driver,
  WaylandDriver,
  // pure helpers (exported for tests and reuse)
  parseXrandr,
  parseDisplayGeometry,
  parseXwininfoRoot,
  parseXwininfoTree,
  parseXdpyinfo,
  parseMouseLocation,
  parseWmctrl,
  parseXprop,
  decodeXpropString,
  parseWindowGeometry,
  parseSwayOutputs,
  parseHyprMonitors,
  parseWlrRandr,
  parseWlrRandrJson,
  walkSwayTree,
  parseHyprClients,
  parseClientListStacking,
  normalizeX11Id,
  prettifyApp,
  classFromWmctrl,
  normalizeKeys,
  normalizeKeyName,
  splitCombo,
  xdotoolCombo,
  xKeysym,
  x11Modifiers,
  x11Button,
  ydotoolKeyArgs,
  ydotoolButtonCode,
  parseYdotoolHelp,
  wtypeKeyArgs,
  wtypeTextArgs,
  buildClickArgs,
  buildDragArgs,
  buildScrollArgs,
  buildX11CaptureCommand,
  chunkText,
  pngInfo,
  clampToDisplays,
  detectCompositor,
  detectPackageManager,
  installHint,
};
