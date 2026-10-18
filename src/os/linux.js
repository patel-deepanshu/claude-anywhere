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
  // UI automation (atspi-helper.py): PyGObject, the Atspi typelib and the accessibility bus.
  python3: { apt: 'python3', dnf: 'python3', pacman: 'python', zypper: 'python3', apk: 'python3' },
  'python3-gi': { apt: 'python3-gi', dnf: 'python3-gobject', pacman: 'python-gobject', zypper: 'python3-gobject', apk: 'py3-gobject3' },
  'gir1.2-atspi-2.0': { apt: 'gir1.2-atspi-2.0', dnf: 'at-spi2-core', pacman: 'at-spi2-core', zypper: 'typelib-1_0-Atspi-2_0', apk: 'at-spi2-core' },
  'at-spi2-core': 'at-spi2-core',
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
// Browser tabs (shared by every backend)
// ---------------------------------------------------------------------------
//
// driver.browserTab({app, windowId, includeText, maxChars, keyboard, beforeInput}) reads the address
// and, on request, the text of the active tab of a browser window. macOS (AppleScript) and Windows
// (UI Automation) read the address bar without input; Linux, browsers those cannot script (Firefox
// on macOS), and the page text everywhere use the keyboard: focus the window, primary+L and copy for
// the address, Escape twice, then select-all and copy in the page, with the clipboard saved before
// and restored after. That reader only needs the Driver primitives (focusWindow, keyCombo,
// clipboardGet/Set, activeWindow), so darwin.js and win32.js reuse it from here.

const SEP_RE = '\\s[-\\u2013\\u2014]\\s';
/** Known browsers. engine decides the keyboard details; app matches the window's app name, title its title suffix. */
const BROWSERS = [
  { id: 'brave', name: 'Brave', engine: 'chromium', app: /\bbrave\b/i, title: new RegExp(`${SEP_RE}Brave(?:\\s(?:Browser|Beta|Nightly|Dev))*$`) },
  { id: 'edge', name: 'Microsoft Edge', engine: 'chromium', app: /\b(?:microsoft[\s-]*edge|msedge)\b/i, title: new RegExp(`${SEP_RE}Microsoft[\\u200b-\\u200d\\ufeff]*\\s?Edge(?:\\s(?:Beta|Dev|Canary))?$`) },
  { id: 'vivaldi', name: 'Vivaldi', engine: 'chromium', app: /\bvivaldi\b/i, title: new RegExp(`${SEP_RE}Vivaldi$`) },
  { id: 'opera', name: 'Opera', engine: 'chromium', app: /\bopera\b/i, title: new RegExp(`${SEP_RE}Opera(?:\\sGX)?$`) },
  { id: 'arc', name: 'Arc', engine: 'chromium', app: /^arc(?:\.exe)?$/i, title: null },
  { id: 'chromium', name: 'Chromium', engine: 'chromium', app: /\bchromium\b/i, title: new RegExp(`${SEP_RE}Chromium$`) },
  { id: 'chrome', name: 'Google Chrome', engine: 'chromium', app: /\b(?:google[\s-]*chrome|chrome(?:\.exe)?)\b/i, title: new RegExp(`${SEP_RE}Google Chrome(?:\\s(?:Beta|Dev|Canary|for Testing))?$`) },
  { id: 'firefox', name: 'Firefox', engine: 'gecko', app: /\bfirefox\b|^navigator$/i, title: new RegExp(`${SEP_RE}(?:Mozilla Firefox(?: Private Browsing)?|Firefox(?: Developer Edition| Nightly)?)$`) },
  { id: 'librewolf', name: 'LibreWolf', engine: 'gecko', app: /\blibrewolf\b/i, title: new RegExp(`${SEP_RE}LibreWolf$`) },
  { id: 'waterfox', name: 'Waterfox', engine: 'gecko', app: /\bwaterfox\b/i, title: new RegExp(`${SEP_RE}Waterfox$`) },
  { id: 'zen', name: 'Zen Browser', engine: 'gecko', app: /^zen(?:\s?browser)?(?:\.exe)?$/i, title: new RegExp(`${SEP_RE}Zen Browser$`) },
  { id: 'floorp', name: 'Floorp', engine: 'gecko', app: /\bfloorp\b/i, title: new RegExp(`${SEP_RE}Floorp$`) },
  { id: 'safari', name: 'Safari', engine: 'webkit', app: /^safari(?:\stechnology\spreview)?$/i, title: null },
  { id: 'orion', name: 'Orion', engine: 'webkit', app: /^orion$/i, title: null },
];
const BROWSER_ALIASES = {
  ff: 'firefox', mozilla: 'firefox', 'mozilla firefox': 'firefox', msedge: 'edge', 'ms edge': 'edge', 'microsoft edge': 'edge', 'google chrome': 'chrome',
  google: 'chrome', 'chrome browser': 'chrome', 'brave browser': 'brave', zen: 'zen',
};
const OWN_WINDOW_RE = /^Claude Anywhere\b/;
const DEFAULT_TAB_CHARS = 20000;
const MAX_TAB_CHARS = 2000000;
const MAX_TEXT_ATTEMPTS = 4;
/** Keyboard reader timings (ms); browserTab({timing}) overrides them in tests. */
const TAB_TIMING = Object.freeze({ settleMs: 150, keyGapMs: 80, pageFocusMs: 200, pollMs: 50, clipboardMs: 1500 });

/**
 * Recognize a browser from a window's app name, else from its title suffix (" - Brave").
 * @param {string} [app]
 * @param {string} [title]
 * @returns {{id:string,name:string,engine:'chromium'|'gecko'|'webkit'}|null}
 */
function identifyBrowser(app, title) {
  const a = String(app == null ? '' : app).trim();
  const t = String(title == null ? '' : title).trim();
  const hit = (a && BROWSERS.find((b) => b.app.test(a))) || (t && BROWSERS.find((b) => b.title && b.title.test(t))) || null;
  return hit ? { id: hit.id, name: hit.name, engine: hit.engine } : null;
}

/** "Brave browser" -> "brave", "Google Chrome" -> "chrome", "ff" -> "firefox". */
function normalizeBrowserQuery(query) {
  let q = String(query == null ? '' : query).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || q === 'any' || q === 'browser' || q === 'default') return '';
  if (BROWSER_ALIASES[q]) return BROWSER_ALIASES[q];
  q = q.replace(/^(?:the|my)\s+/, '').replace(/\s+(?:browser|web browser|window|tab)$/, '').trim();
  return BROWSER_ALIASES[q] || q;
}

function browserMatches(browser, w, q) {
  if (!q) return true;
  const name = browser.name.toLowerCase();
  return browser.id === q || name === q || name.includes(q) || String(w.app || '').toLowerCase().includes(q);
}

/**
 * Normalized window id equality: decimal and 0x hex X11 ids, and macOS "pid:number" ids
 * (an id that is just "pid" matches any window of that process).
 */
function sameWindowId(a, b) {
  if (a == null || b == null) return false;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const num = (s) => (/^0x[0-9a-f]+$/.test(s) ? parseInt(s, 16) : /^\d+$/.test(s) ? Number(s) : NaN);
  if (!Number.isNaN(num(x)) && num(x) === num(y)) return true;
  const mx = /^(\d+):(\d+)$/.exec(x);
  const my = /^(\d+):(\d+)$/.exec(y);
  if (mx && !my && /^\d+$/.test(y)) return mx[1] === y;
  if (my && !mx && /^\d+$/.test(x)) return my[1] === x;
  return false;
}

/**
 * Browser windows, most recently active first: the focused one, then front to back (stackIndex,
 * or list order on drivers that list front to back), minimized windows last.
 * @param {object[]} windows driver.listWindows()
 * @param {string} [query] e.g. "brave"; empty for any browser
 * @param {{zOrdered?:boolean, exclude?:(w:object)=>boolean}} [opts]
 * @returns {Array<{window:object, browser:{id:string,name:string,engine:string}}>}
 */
function browserWindows(windows, query, { zOrdered = false, exclude } = {}) {
  const q = normalizeBrowserQuery(query);
  const skip = typeof exclude === 'function' ? exclude : (w) => OWN_WINDOW_RE.test(String(w.title || '')) || String(w.app || '') === 'Claude Anywhere';
  const list = [];
  (Array.isArray(windows) ? windows : []).forEach((w, i) => {
    if (!w || w.id == null || skip(w)) return;
    const browser = identifyBrowser(w.app, w.title);
    if (!browser || !browserMatches(browser, w, q)) return;
    list.push({ window: w, browser, i });
  });
  const ranked = list.some((c) => Number.isInteger(c.window.stackIndex));
  const order = (c) => (ranked ? (Number.isInteger(c.window.stackIndex) ? c.window.stackIndex : 1e6 + c.i) : zOrdered ? c.i : -c.i);
  list.sort((a, b) => Number(!a.window.focused) - Number(!b.window.focused) || Number(Boolean(a.window.minimized)) - Number(Boolean(b.window.minimized)) || order(a) - order(b));
  return list.map(({ window, browser }) => ({ window, browser }));
}

const LOCAL_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[[0-9a-f:]+\]|[a-z0-9-]+\.(?:local|localhost|internal|lan))(?::\d+)?$/i;

/**
 * Turn an address bar's text into a URL. Browsers often hide the scheme ("example.com/a"): add
 * https:// (http:// for localhost and private addresses). Text that is not an address (a search
 * the user is typing) gives null.
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeTabUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 8192 || /\s/.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d+(?:[/?#]|$)/i.test(s)) return s;
  const m = /^([^/?#]+)(.*)$/.exec(s);
  if (!m) return null;
  const host = m[1];
  if (LOCAL_HOST_RE.test(host)) return `http://${s}`;
  if (/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*\.?(?::\d+)?$/i.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(host)) return `https://${s}`;
  return null;
}

/** Whether copied text is the address bar's content rather than page text. */
function looksLikeAddress(text, knownUrl) {
  const s = String(text == null ? '' : text).trim();
  if (!s || /\s/.test(s)) return false;
  if (knownUrl && (s === knownUrl || normalizeTabUrl(s) === knownUrl)) return true;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || normalizeTabUrl(s) !== null;
}

/** Page text as copied: one line-ending style, no trailing spaces, at most one blank line in a row. */
function cleanPageText(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * At most maxChars UTF-16 units, never splitting a surrogate pair.
 * @returns {{text:string, truncated:boolean, total:number}}
 */
function clipTabText(text, maxChars) {
  const s = String(text == null ? '' : text);
  if (s.length <= maxChars) return { text: s, truncated: false, total: s.length };
  let end = maxChars;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return { text: s.slice(0, end), truncated: true, total: s.length };
}

function sameClip(a, b) {
  return typeof a === 'string' && typeof b === 'string' && (a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n'));
}

function tabError(message, code, hint) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  return err;
}

/** True for errors that must stop the keyboard reader at once (the user paused Claude). */
function isStopError(err) {
  return Boolean(err && (err.code === 'PAUSED' || err.code === 'FAILSAFE'));
}

/** Poll the clipboard until it differs from `sentinel`; the new text, or null (nothing copied). */
async function waitForClipboard(driver, sentinel, t) {
  const polls = Math.max(1, Math.ceil(t.clipboardMs / Math.max(1, t.pollMs)));
  for (let i = 0; i < polls; i++) {
    await sleep(t.pollMs);
    let v;
    try {
      v = await driver.clipboardGet();
    } catch {
      v = null;
    }
    if (typeof v === 'string' && !sameClip(v, sentinel)) return v.trim() ? v : null;
  }
  return null;
}

/**
 * Put the user's clipboard back unless someone else changed it meanwhile.
 * @returns {Promise<'restored'|'changed'|'unknown'|'lost'>}
 */
async function restoreClipboard(driver, saved, ours) {
  let current;
  try {
    current = await driver.clipboardGet();
  } catch {
    current = undefined;
  }
  const isOurs = current === undefined || [...ours].some((v) => sameClip(v, current));
  if (!isOurs) return 'changed';
  if (typeof saved !== 'string') {
    // The original could not be read: at least do not leave a sentinel behind.
    if (typeof current === 'string' && /^anywhere-clip-[0-9a-f]+$/.test(current)) await driver.clipboardSet('').catch(() => {});
    return 'unknown';
  }
  if (sameClip(current, saved)) return 'restored';
  try {
    await driver.clipboardSet(saved);
    return 'restored';
  } catch (err) {
    log.warn('could not restore the clipboard after reading a browser tab:', err.message);
    return 'lost';
  }
}

/**
 * Read a browser window's address and/or page text with the keyboard. Saves the clipboard, focuses
 * the window, copies, restores the clipboard and gives focus back to the window that had it.
 * beforeInput (the caller's pause guard and failsafe) runs before the first keystroke and again
 * before the page text is selected; a PAUSED or FAILSAFE error from it stops at once.
 * @param {object} driver any Driver
 * @param {{window:object, engine?:string, platform?:string, wantUrl?:boolean, wantText?:boolean,
 *   knownUrl?:string|null, beforeInput?:Function, timing?:object}} opts
 * @returns {Promise<{url:string|null, text:string|null, tookFocus:boolean, clipboard:string, notes:string[]}>}
 */
async function keyboardReadTab(driver, opts) {
  const win = opts.window;
  const engine = opts.engine || 'chromium';
  const platform = opts.platform || process.platform;
  const wantUrl = opts.wantUrl !== false;
  const wantText = Boolean(opts.wantText);
  const t = { ...TAB_TIMING, ...(opts.timing || {}) };
  const mod = platform === 'darwin' ? 'meta' : 'ctrl';
  const label = win.app || win.title || 'the browser';
  let knownUrl = opts.knownUrl || null;
  const out = { url: null, text: null, tookFocus: false, clipboard: 'unchanged', notes: [] };
  const press = (keys) => driver.keyCombo(keys);

  let prev = null;
  try {
    prev = await driver.activeWindow();
  } catch {
    prev = null;
  }
  let saved = null;
  try {
    const s = await driver.clipboardGet();
    saved = typeof s === 'string' ? s : null;
  } catch (err) {
    out.notes.push(`The clipboard could not be read beforehand (${err.message}), so it was not restored.`);
  }
  if (opts.beforeInput) await opts.beforeInput();

  const ours = new Set();
  const sentinel = async () => {
    const s = `anywhere-clip-${crypto.randomBytes(6).toString('hex')}`;
    ours.add(s);
    await driver.clipboardSet(s);
    return s;
  };
  let touched = false;
  let stopped = false;
  try {
    const focused = await driver.focusWindow(win.id);
    touched = true;
    out.tookFocus = !(prev && sameWindowId(prev.id, win.id));
    if (focused === false) {
      throw tabError(`Could not bring ${label} to the front to read it.`, 'FOCUS_FAILED', 'Bring the browser window to the front yourself and ask again.');
    }
    await sleep(t.settleMs);
    let now = null;
    try {
      now = await driver.activeWindow();
    } catch {
      now = null;
    }
    if (now && now.id != null && !sameWindowId(now.id, win.id)) {
      throw tabError(
        `${label} did not come to the front (the active window is ${now.app || now.title || now.id}), so no keys were sent.`,
        'FOCUS_FAILED',
        'Bring the browser window to the front yourself and ask again.',
      );
    }

    let inAddressBar = false;
    if (wantUrl || (wantText && engine !== 'webkit')) {
      const s = await sentinel();
      await press([mod, 'l']);
      await sleep(t.keyGapMs);
      await press([mod, 'c']);
      const got = await waitForClipboard(driver, s, t);
      const url = got != null ? normalizeTabUrl(got) : null;
      if (got != null) ours.add(got);
      if (url) {
        inAddressBar = true;
        if (!knownUrl) knownUrl = url;
        if (wantUrl) out.url = url;
      } else if (wantUrl) {
        out.notes.push('Copying the address bar gave no URL.');
      }
      // Only while the address bar surely has focus: in the page, Escape can close a dialog (a Jira issue).
      // The first Escape closes the suggestion list, the second returns focus to the page (Chromium).
      if (inAddressBar) {
        await press(['escape']);
        await sleep(t.keyGapMs);
        await press(['escape']);
        await sleep(t.pageFocusMs);
      }
    }

    if (wantText) {
      if (opts.beforeInput) await opts.beforeInput();
      // F6 moves focus from the address bar (or a toolbar) towards the page in Chromium and Firefox.
      const focusPage = engine === 'webkit' ? null : ['f6'];
      for (let attempt = 0; attempt < MAX_TEXT_ATTEMPTS && out.text == null; attempt++) {
        if (attempt > 0) {
          if (!focusPage) break;
          await press(focusPage);
          await sleep(t.pageFocusMs);
        }
        const s = await sentinel();
        await press([mod, 'a']);
        await sleep(t.keyGapMs);
        await press([mod, 'c']);
        const got = await waitForClipboard(driver, s, t);
        if (got == null) continue; // nothing selectable has focus (a toolbar)
        ours.add(got);
        if (looksLikeAddress(got, knownUrl)) continue; // still in the address bar
        out.text = got;
        // Collapse the select-all: extend the selection back to the start of the page (no click).
        await press(platform === 'darwin' ? ['meta', 'shift', 'up'] : ['ctrl', 'shift', 'home']);
      }
      if (out.text == null) {
        out.notes.push(`Select-all and copy in ${label} gave no page text (the page may block copying, or keyboard focus is in a field).`);
      }
    }
  } catch (err) {
    stopped = isStopError(err);
    throw err;
  } finally {
    out.clipboard = await restoreClipboard(driver, saved, ours);
    if (touched && !stopped) {
      if (out.tookFocus && prev && prev.id != null) {
        try {
          await driver.focusWindow(prev.id);
        } catch (err) {
          log.debug('could not give focus back after reading a browser tab:', err.message);
        }
      }
      if (win.minimized && typeof driver.minimizeWindow === 'function') {
        try {
          await driver.minimizeWindow(win.id);
        } catch (err) {
          log.debug('could not minimize the browser again:', err.message);
        }
      }
    }
  }
  return out;
}

/**
 * The browser window to read: opts.window (a listWindows() entry the caller picked), opts.windowId,
 * else the most recently active window of opts.app (any browser when unset).
 * @returns {Promise<{window:object, browser:object}>}
 */
async function resolveBrowserWindow(driver, opts = {}) {
  if (opts.window && typeof opts.window === 'object' && opts.window.id != null) {
    // The caller already listed the windows and picked this one.
    const w = opts.window;
    const browser = identifyBrowser(w.app, w.title) || identifyBrowser(opts.app, '') || { id: 'browser', name: w.app || 'Browser', engine: 'chromium' };
    return { window: w, browser };
  }
  const wins = (await driver.listWindows()) || [];
  if (opts.windowId != null && String(opts.windowId).trim() !== '') {
    const w = wins.find((x) => sameWindowId(x.id, opts.windowId));
    if (!w) throw tabError(`Window ${opts.windowId} is not open any more.`, 'NOT_FOUND', 'List the windows again and pick a browser window.');
    // An explicit window may be a browser this table does not know: treat it like Chromium.
    const browser = identifyBrowser(w.app, w.title) || identifyBrowser(opts.app, '') || { id: 'browser', name: w.app || 'Browser', engine: 'chromium' };
    return { window: w, browser };
  }
  const zOrdered = driver.windowsZOrdered === true || /^(?:darwin|win32|wsl)$/.test(String(driver.name || ''));
  const found = browserWindows(wins, opts.app, { zOrdered });
  if (found.length) return found[0];
  const open = [...new Set(browserWindows(wins, '', { zOrdered }).map((c) => c.browser.name))];
  if (opts.app && normalizeBrowserQuery(opts.app)) {
    throw tabError(
      `No ${opts.app} window is open.${open.length ? ` Open browsers: ${open.join(', ')}.` : ''}`,
      'NOT_FOUND',
      open.length ? 'Ask for one of the open browsers, or open the page in the browser you named.' : 'Open the page in a browser first.',
    );
  }
  throw tabError('No browser window is open.', 'NOT_FOUND', 'Open the page in a browser (Brave, Chrome, Edge, Firefox, Safari...) first.');
}

/**
 * driver.browserTab() for any backend: native(window, browser, {text}) reads without input
 * (AppleScript, UI Automation) and returns {url, title?, text?, method} or null; the keyboard
 * reader fills in what is still missing unless opts.keyboard is false.
 * @param {object} driver
 * @param {{app?:string, windowId?:string, window?:object, includeText?:boolean, maxChars?:number, keyboard?:boolean,
 *   beforeInput?:Function, timing?:object}} opts
 * @param {{platform:string, native?:Function}} how
 * @returns {Promise<{browser:string, app:string, title:string, url:string|null, text?:string|null, truncated?:boolean,
 *   method:'applescript'|'uia'|'keyboard'|'title', windowId:string, tookFocus:boolean, clipboard?:string,
 *   textMethod?:string, hint?:string, permission?:string, settingsUrl?:string, notes?:string[]}>}
 */
async function readBrowserTab(driver, opts = {}, how = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const includeText = Boolean(o.includeText);
  const maxChars = o.maxChars == null || o.maxChars === '' ? DEFAULT_TAB_CHARS : clampInt(o.maxChars, 1, MAX_TAB_CHARS, DEFAULT_TAB_CHARS);
  const keyboard = o.keyboard !== false;
  const { window: w, browser } = await resolveBrowserWindow(driver, o);
  const result = { browser: browser.name, app: w.app || browser.name, title: String(w.title || ''), url: null, method: 'title', windowId: String(w.id), tookFocus: false };
  const notes = [];
  let text = null;

  if (typeof how.native === 'function') {
    try {
      const r = await how.native(w, browser, { text: includeText });
      if (r) {
        const url = r.url ? normalizeTabUrl(r.url) : null;
        if (url) {
          result.url = url;
          result.method = r.method;
        }
        if (!result.title && r.title) result.title = String(r.title);
        if (r.tabTitle) result.tabTitle = String(r.tabTitle);
        if (includeText && typeof r.text === 'string' && r.text.trim()) {
          text = r.text;
          result.textMethod = r.method;
        }
        if (r.note) notes.push(r.note);
      }
    } catch (err) {
      if (isStopError(err) || !keyboard) throw err;
      if (err.code === 'PERMISSION') {
        result.permission = err.permission || 'automation';
        if (err.hint) result.hint = err.hint;
        if (err.settingsUrl) result.settingsUrl = err.settingsUrl;
      }
      notes.push(`Reading the address bar directly failed (${err.message}); used the keyboard instead.`);
      log.debug(`browserTab: native read failed (${err.code || 'error'}): ${err.message}`);
    }
  }

  const wantUrl = !result.url;
  const wantText = includeText && text == null;
  if (keyboard && (wantUrl || wantText)) {
    try {
      const kb = await keyboardReadTab(driver, {
        window: w,
        engine: browser.engine,
        platform: how.platform,
        wantUrl,
        wantText,
        knownUrl: result.url,
        beforeInput: o.beforeInput,
        timing: o.timing,
      });
      result.tookFocus = kb.tookFocus;
      result.clipboard = kb.clipboard;
      if (kb.url) {
        result.url = kb.url;
        result.method = 'keyboard';
      }
      if (kb.text != null) {
        text = kb.text;
        result.textMethod = 'keyboard';
      }
      notes.push(...kb.notes);
    } catch (err) {
      if (isStopError(err)) throw err;
      notes.push(`The keyboard fallback failed: ${err.message}`);
      // Both paths may need a permission (macOS: Automation for AppleScript, Accessibility for keys): keep both hints.
      if (err.hint && !(result.hint || '').includes(err.hint)) result.hint = result.hint ? `${result.hint} ${err.hint}` : err.hint;
      if (err.code === 'PERMISSION' && !result.permission) result.permission = err.permission || 'accessibility';
      log.debug(`browserTab: keyboard read failed (${err.code || 'error'}): ${err.message}`);
    }
  } else if (!keyboard && wantUrl) {
    notes.push('The address could not be read without the keyboard.');
  }

  if (includeText) {
    if (text != null) {
      const clipped = clipTabText(cleanPageText(text), maxChars);
      result.text = clipped.text;
      result.truncated = clipped.truncated;
      if (clipped.truncated) result.textChars = clipped.total;
    } else {
      result.text = null;
    }
  }
  if (notes.length) result.notes = notes;
  return result;
}

// ---------------------------------------------------------------------------
// UI automation (AT-SPI through src/os/atspi-helper.py) and window bounds
// ---------------------------------------------------------------------------

const ATSPI_HELPER = path.join(__dirname, 'atspi-helper.py');
/** The shared role vocabulary (docs/ARCHITECTURE.md §4); the helper maps AT-SPI roles onto it. */
const UI_ROLES = Object.freeze([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listitem', 'menuitem', 'menu', 'tab', 'tablist',
  'treeitem', 'image', 'text', 'heading', 'window', 'toolbar', 'group', 'table', 'row', 'cell', 'slider', 'other',
]);
const UI_ROLE_SET = new Set(UI_ROLES);
/** Other names callers use for the same roles (AT-SPI, UI Automation, ARIA and plain English). */
const UI_ROLE_ALIASES = Object.freeze({
  edit: 'textbox', entry: 'textbox', input: 'textbox', field: 'textbox', textfield: 'textbox', searchbox: 'textbox',
  textarea: 'textbox', passwordtext: 'textbox', hyperlink: 'link', anchor: 'link', option: 'listitem',
  menubar: 'menu', popupmenu: 'menu', tabitem: 'tab', pagetab: 'tab', pagetablist: 'tablist', dropdown: 'combobox',
  select: 'combobox', radiobutton: 'radio', pushbutton: 'button', togglebutton: 'button', splitbutton: 'button',
  switch: 'checkbox', checkbox: 'checkbox', statictext: 'text', label: 'text', static: 'text', paragraph: 'text',
  img: 'image', picture: 'image', icon: 'image', dialog: 'window', frame: 'window', pane: 'group', panel: 'group',
  section: 'group', list: 'group', listbox: 'group', tree: 'group', grid: 'table', datagrid: 'table',
  dataitem: 'row', tablerow: 'row', gridcell: 'cell', tablecell: 'cell', columnheader: 'cell', rowheader: 'cell',
  spinner: 'slider', spinbutton: 'slider', toolbar: 'toolbar', treeitem: 'treeitem', listitem: 'listitem',
  menuitem: 'menuitem', combobox: 'combobox',
});
const UI_ACTIONS = Object.freeze(['press', 'focus', 'setValue', 'select', 'expand', 'collapse', 'scrollIntoView', 'showMenu']);
const UI_ACTION_MAP = new Map(UI_ACTIONS.map((a) => [a.toLowerCase(), a]));
/** Time the helper may spend walking one window; it stops there and reports truncated. */
const UI_BUDGET_MS = 6000;
const UI_MAX_BUDGET_MS = 30000;
/** Python start-up, the PyGObject imports and one slow accessibility call on top of the walk budget. */
const UI_HELPER_MARGIN_MS = 6000;
const UI_ACTION_TIMEOUT_MS = 15000;
const UI_PROBE_TIMEOUT_MS = 8000;
/** Element ids remember their window and bounds this long (and are re-resolved by path after). */
const UI_CACHE_TTL_MS = 30000;
const UI_CACHE_MAX = 4000;
/** How long an interpreter without the bindings is skipped, and a capabilities probe is reused. */
const UI_PYTHON_RETRY_MS = 60000;
const UI_PROBE_TTL_MS = 30000;
/** "lx:<window key>:<root>:<child path>:<hash>"; the key is a listWindows() id or "@<pid>.<app child index>". */
const UI_ID_RE = /^lx:([^:\s]{1,100}):(w|p\d{1,4}):((?:\d{1,5}(?:\.\d{1,5}){0,99})?):([0-9a-f]{6})$/;
const UI_APP_KEY_RE = /^@(\d{1,10})\.(\d{1,5})$/;
/** What a Chromium-based browser or Electron app needs at start-up to show its pages to AT-SPI (for launch_app). */
const CHROMIUM_A11Y_ARGS = Object.freeze(['--force-renderer-accessibility']);
const CHROMIUM_A11Y_ENV = Object.freeze({ ACCESSIBILITY_ENABLED: '1' });
const CHROMIUM_A11Y_HINT =
  'Chromium-based browsers (Chrome, Brave, Edge, Chromium) and Electron apps (VS Code, Slack, Discord, WhatsApp ' +
  'desktop) join the accessibility bus only with ACCESSIBILITY_ENABLED=1 in their environment (or the desktop\'s ' +
  'accessibility setting on), and show their page content only when started with --force-renderer-accessibility: ' +
  'quit the app and start it as, e.g., ACCESSIBILITY_ENABLED=1 brave-browser --force-renderer-accessibility';
const APP_A11Y_HINT =
  `${CHROMIUM_A11Y_HINT}; Qt apps need QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 and Java apps the java-atk-wrapper ` +
  'package. Otherwise use find_text (OCR) or a screenshot and click by position.';
const RELATIVE_BOUNDS_NOTE =
  'Element positions are relative to their window on this Wayland desktop (the compositor does not tell apps where ' +
  'their windows are), so elements cannot be clicked by position: ui_click and ui_set_value use accessibility ' +
  'actions only.';
const WINDOW_STATES = Object.freeze(['maximize', 'minimize', 'restore', 'fullscreen']);
const WINDOW_STATE_ALIASES = Object.freeze({
  maximized: 'maximize', max: 'maximize', zoom: 'maximize', minimized: 'minimize', min: 'minimize', iconify: 'minimize',
  restored: 'restore', normal: 'restore', unmaximize: 'restore', 'full screen': 'fullscreen', 'full-screen': 'fullscreen',
  fullscreened: 'fullscreen',
});
const MIN_WINDOW_SIZE = 20;
const BOUNDS_SETTLE_MS = 150;
const STATE_WAIT_MS = 800;

function uiError(message, code, hint) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  return err;
}

/**
 * Normalize a role name to the shared vocabulary (case, spaces and common aliases).
 * @param {string} role
 * @returns {string} a UI_ROLES entry
 */
function normalizeUiRole(role) {
  const key = String(role == null ? '' : role).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (UI_ROLE_SET.has(key)) return key;
  if (Object.prototype.hasOwnProperty.call(UI_ROLE_ALIASES, key)) return UI_ROLE_ALIASES[key];
  throw uiError(`Unknown UI role "${role}"`, 'BAD_ARGS', `Use one of: ${UI_ROLES.join(', ')}.`);
}

/** A role filter (string, "a|b", "a,b" or a list) as a de-duplicated list, or undefined for none. */
function uiRoleFilter(role) {
  if (role == null || role === '') return undefined;
  const list = (Array.isArray(role) ? role : String(role).split(/[|,]/)).map((r) => String(r).trim()).filter(Boolean);
  if (!list.length) return undefined;
  return [...new Set(list.map(normalizeUiRole))];
}

function uiNorm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * How well a text matches a query, case-insensitively with whitespace collapsed (atspi-helper.py
 * match_score): 3 whole text, 2 prefix, 1 substring, 0 none; exact allows only 3.
 */
function uiMatchScore(haystack, query, exact = false) {
  const h = uiNorm(haystack);
  const q = uiNorm(query);
  if (!q || !h) return 0;
  if (h === q) return 3;
  if (exact) return 0;
  if (h.startsWith(q)) return 2;
  return h.includes(q) ? 1 : 0;
}

/**
 * Parse a Linux UI element id ("lx:<window key>:<root>:<path>:<hash>").
 * @returns {{windowKey:string, root:string, path:number[], pathText:string, hash:string}|null}
 */
function parseUiId(id) {
  const m = UI_ID_RE.exec(typeof id === 'string' ? id.trim() : '');
  if (!m) return null;
  return { windowKey: m[1], root: m[2], path: m[3] ? m[3].split('.').map(Number) : [], pathText: m[3], hash: m[4] };
}

function formatUiId(windowKey, ref) {
  return `lx:${windowKey}:${ref}`;
}

/** {x, y, width, height} with whole finite numbers (all zero when unknown). */
function uiBounds(b) {
  const o = b && typeof b === 'object' ? b : {};
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
  return { x: n(o.x), y: n(o.y), width: Math.max(0, n(o.width)), height: Math.max(0, n(o.height)) };
}

/** State fields shared by tree nodes and search results, from a helper record. */
function uiState(out, n) {
  if (typeof n.value === 'string' && n.value) out.value = n.value;
  if (typeof n.description === 'string' && n.description) out.description = n.description;
  out.bounds = uiBounds(n.bounds);
  out.enabled = n.enabled !== false;
  out.focused = n.focused === true;
  if (typeof n.selected === 'boolean') out.selected = n.selected;
  if (n.checked === true || n.checked === false || n.checked === 'mixed') out.checked = n.checked;
  if (typeof n.expanded === 'boolean') out.expanded = n.expanded;
  if (n.editable === true) out.editable = true;
  if (n.offscreen === true) out.offscreen = true;
  return out;
}

function uiRoleOf(role) {
  return UI_ROLE_SET.has(role) ? role : 'other';
}

/** Attach non-enumerable metadata (window, truncated, notes...) to a result array. */
function withMeta(list, meta) {
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined) Object.defineProperty(list, k, { value: v, enumerable: false, configurable: true, writable: true });
  }
  return list;
}

/** The helper's answer: the last line of stdout that is a JSON object (or null). */
function parseHelperOutput(stdout) {
  const lines = String(stdout == null ? '' : stdout).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s.startsWith('{')) continue;
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && typeof j.ok === 'boolean') return j;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Validate a setWindowBounds spec: {state} (maximize, minimize, restore, fullscreen, or an alias) or
 * any of {x, y, width, height}.
 * @returns {{state:string}|{x?:number,y?:number,width?:number,height?:number}}
 */
function parseBoundsSpec(spec) {
  const s = spec && typeof spec === 'object' ? spec : null;
  if (!s) throw uiError('setWindowBounds needs {x, y, width, height} or {state}', 'BAD_ARGS');
  const keys = ['x', 'y', 'width', 'height'].filter((k) => s[k] != null && s[k] !== '');
  if (s.state != null && s.state !== '') {
    const raw = String(s.state).trim().toLowerCase();
    const state = WINDOW_STATE_ALIASES[raw] || raw;
    if (!WINDOW_STATES.includes(state)) {
      throw uiError(`Unknown window state "${s.state}"`, 'BAD_ARGS', 'Use maximize, minimize, restore or fullscreen.');
    }
    if (keys.length) throw uiError(`Give either bounds or the state "${s.state}", not both`, 'BAD_ARGS');
    return { state };
  }
  if (!keys.length) throw uiError('setWindowBounds needs {x, y, width, height} (any of them) or {state}', 'BAD_ARGS');
  const out = {};
  for (const k of keys) {
    const n = Number(s[k]);
    if (!Number.isFinite(n) || Math.abs(n) > 1e6) throw uiError(`${k} must be a number (got ${JSON.stringify(s[k])})`, 'BAD_ARGS');
    if ((k === 'width' || k === 'height') && n < MIN_WINDOW_SIZE) {
      throw uiError(`${k} must be at least ${MIN_WINDOW_SIZE} (got ${s[k]})`, 'BAD_ARGS');
    }
    out[k] = Math.round(n);
  }
  return out;
}

/** Parse `xwininfo -id <id>`: the window's absolute position and size. */
function parseXwininfoWindow(text) {
  const s = String(text || '');
  const ax = /Absolute upper-left X:\s*(-?\d+)/.exec(s);
  const ay = /Absolute upper-left Y:\s*(-?\d+)/.exec(s);
  const w = /^\s*Width:\s*(\d+)/m.exec(s);
  const h = /^\s*Height:\s*(\d+)/m.exec(s);
  if (!ax || !ay || !w || !h) return null;
  return { x: +ax[1], y: +ay[1], width: +w[1], height: +h[1] };
}

function nearRect(a, b, posTol, sizeTol) {
  if (!a || !b) return false;
  return (
    (b.x == null || Math.abs(a.x - b.x) <= posTol) &&
    (b.y == null || Math.abs(a.y - b.y) <= posTol) &&
    (b.width == null || Math.abs(a.width - b.width) <= sizeTol) &&
    (b.height == null || Math.abs(a.height - b.height) <= sizeTol)
  );
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

  /**
   * Read the active tab of a browser window with the keyboard (see readBrowserTab): Linux has no
   * scripting interface that every browser offers, so the address comes from primary+L and copy.
   * @param {{app?:string, windowId?:string, includeText?:boolean, maxChars?:number, keyboard?:boolean,
   *   beforeInput?:Function}} [opts]
   */
  async browserTab(opts = {}) {
    return readBrowserTab(this, opts, { platform: 'linux' });
  }

  // ----- UI automation (AT-SPI) -----

  _uiState() {
    if (!this._uiData) this._uiData = { python: null, bad: new Map(), ids: new Map(), probe: null };
    return this._uiData;
  }

  _uiInstallHint() {
    return this._hint(['python3-gi', 'gir1.2-atspi-2.0', 'at-spi2-core']);
  }

  /**
   * Python interpreters to run the helper with, best first: $ANYWHERE_PYTHON, python3, then the
   * distribution's own versioned interpreters (python3-gi is built for those, which matters when
   * python3 on PATH is a newer or self-built one).
   * The list is kept for a minute, so an interpreter installed meanwhile is found without a restart.
   * @returns {string[]} resolved paths, without duplicates
   */
  _pythonCandidates() {
    const st = this._uiState();
    if (st.candidates && Date.now() - st.candidates.at < UI_PYTHON_RETRY_MS) return st.candidates.list;
    const list = this._findPythons();
    st.candidates = { at: Date.now(), list };
    return list;
  }

  _findPythons() {
    const env = this._env();
    const names = [];
    if (env.ANYWHERE_PYTHON) names.push(String(env.ANYWHERE_PYTHON));
    names.push('python3', '/usr/bin/python3');
    for (let v = 20; v >= 6; v--) names.push(`/usr/bin/python3.${v}`);
    for (let v = 20; v >= 6; v--) names.push(`python3.${v}`);
    const out = [];
    const seen = new Set();
    for (const n of names) {
      const p = this._whichImpl(n);
      if (!p) continue;
      let real = p;
      try {
        real = fs.realpathSync(p);
      } catch {
        /* keep the path as found */
      }
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(p);
    }
    return out;
  }

  /**
   * Run one atspi-helper.py request with the first interpreter that has the AT-SPI bindings (and
   * remember it). Helper errors become Errors with a code (UNSUPPORTED, NOT_FOUND, STALE, BAD_ARGS,
   * TIMEOUT, UI_ERROR) and a hint; an answer with ok:false and no code (an action the element does
   * not support) is returned as it is.
   * @param {object} req
   * @param {{timeoutMs?:number}} [opts]
   */
  async _atspi(req, { timeoutMs = UI_BUDGET_MS + UI_HELPER_MARGIN_MS } = {}) {
    const st = this._uiState();
    const all = this._pythonCandidates();
    if (!all.length) {
      throw uiError('UI automation needs python3, which is not installed', 'UNSUPPORTED', `Install it: ${this._hint(['python3', 'python3-gi', 'gir1.2-atspi-2.0', 'at-spi2-core'])}.`);
    }
    const now = Date.now();
    const order = st.python && all.includes(st.python) ? [st.python, ...all.filter((p) => p !== st.python)] : all;
    const usable = order.filter((p) => !(st.bad.has(p) && now - st.bad.get(p) < UI_PYTHON_RETRY_MS));
    let missing = null;
    for (const py of usable) {
      const r = await this._run(py, ['-I', ATSPI_HELPER], { input: JSON.stringify(req), timeoutMs, env: this._env() });
      const res = parseHelperOutput(r.stdout);
      if (!res) {
        if (r.error && r.error.code === 'ENOENT') {
          st.bad.set(py, Date.now());
          continue;
        }
        if (r.timedOut) {
          throw uiError(
            `The accessibility helper did not answer within ${Math.round(timeoutMs / 1000)} s`,
            'TIMEOUT',
            'The app may be busy or not answering accessibility requests: take a screenshot (or use find_text) instead, or try again.',
          );
        }
        const why = firstLine(r.stderr) || (r.error && r.error.message) || `exit code ${r.code}`;
        throw uiError(`The accessibility helper failed: ${why}`, 'UI_ERROR', 'Take a screenshot (or use find_text) and click by position instead.');
      }
      if (res.ok === false && res.code === 'NO_BINDINGS') {
        st.bad.set(py, Date.now());
        if (st.python === py) st.python = null;
        missing = res;
        continue;
      }
      st.python = py;
      st.bad.delete(py);
      if (res.ok === false && res.code) throw this._uiHelperError(res);
      return res;
    }
    const which = missing && missing.python ? ` for Python ${missing.python}` : '';
    throw uiError(
      `UI automation needs the AT-SPI Python bindings (python3-gi and the Atspi typelib${which})`,
      'UNSUPPORTED',
      `Install them: ${this._uiInstallHint()}. Meanwhile use screenshots (or find_text) and click by position.`,
    );
  }

  _uiHelperError(res) {
    const msg = String(res.error || 'the accessibility request failed');
    switch (res.code) {
      case 'NO_BUS':
        return uiError(
          `UI automation is unavailable: ${msg}`,
          'UNSUPPORTED',
          `Run Claude Anywhere inside your desktop session, with the accessibility bus installed (${this._hint(['at-spi2-core'])}); ` +
            'on GNOME also run: gsettings set org.gnome.desktop.interface toolkit-accessibility true. Meanwhile use screenshots and click by position.',
        );
      case 'NO_WINDOW':
        return uiError(
          res.apps === 0 ? 'No application has registered with the accessibility bus (AT-SPI)' : 'This window is not in the accessibility tree (AT-SPI)',
          'NOT_FOUND',
          APP_A11Y_HINT,
        );
      case 'STALE':
        return uiError(msg, 'STALE', 'Call ui_find (or ui_tree) again for a fresh id.');
      case 'BAD_REQUEST':
        return uiError(msg, 'BAD_ARGS');
      default:
        return uiError(`Accessibility request failed: ${msg}`, 'UI_ERROR', 'Take a screenshot (or use find_text) and click by position instead.');
    }
  }

  _uiRemember(id, entry) {
    const ids = this._uiState().ids;
    ids.delete(id);
    ids.set(id, { ...entry, at: Date.now() });
    while (ids.size > UI_CACHE_MAX) ids.delete(ids.keys().next().value);
  }

  _uiCached(id) {
    const ids = this._uiState().ids;
    const e = ids.get(id);
    if (!e) return null;
    if (Date.now() - e.at > UI_CACHE_TTL_MS) {
      ids.delete(id);
      return null;
    }
    return e;
  }

  /** Window origin for window-relative element extents (Wayland), or null for screen coordinates. */
  _uiOrigin() {
    return null;
  }

  /** True when element bounds cannot be placed on the screen (Wayland without window positions). */
  _uiRelative() {
    return false;
  }

  /**
   * The window a UI request is about: listWindows() entry (by id, else the focused window) and the
   * reference the helper matches it by (process id, title, bounds). Without a window list
   * (GNOME/KDE Wayland) the helper takes the active accessible window.
   * @returns {Promise<{key:string|null, window:object|null, ref:object}>}
   */
  async _uiWindowRef(windowId) {
    const raw = windowId && typeof windowId === 'object' && windowId.id != null ? windowId.id : windowId;
    const key = raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
    const app = key ? UI_APP_KEY_RE.exec(key) : null;
    if (app) return { key, window: null, ref: { pid: Number(app[1]), index: Number(app[2]) } };
    let wins = null;
    try {
      wins = await this.listWindows();
    } catch (err) {
      if (!err || err.code !== 'UNSUPPORTED') throw err;
    }
    if (!wins) {
      if (key) throw uiError(`Window ${key} cannot be looked up on this desktop`, 'NOT_FOUND', 'Leave the window out to use the active window.');
      return { key: null, window: null, ref: { active: true } };
    }
    let w = null;
    if (key) {
      w = wins.find((x) => sameWindowId(x.id, key)) || null;
      if (!w) throw uiError(`Window ${key} is not open`, 'NOT_FOUND', 'Call list_windows for the current window ids.');
    } else {
      w = wins.find((x) => x.focused) || null;
      if (!w) {
        const a = await this.activeWindow().catch(() => null);
        if (a) w = wins.find((x) => sameWindowId(x.id, a.id)) || null;
      }
      if (!w) return { key: null, window: null, ref: { active: true } };
    }
    const ref = { pid: Number(w.pid) || 0, title: String(w.title || ''), app: String(w.app || '') };
    if ([w.x, w.y, w.width, w.height].every(Number.isFinite) && w.width > 0 && w.height > 0) {
      ref.bounds = { x: w.x, y: w.y, width: w.width, height: w.height };
    }
    if (ref.pid === 0 && !ref.title) ref.active = Boolean(w.focused);
    return { key: String(w.id), window: w, ref };
  }

  /** Request fields shared by tree/find/action: the window reference and, on Wayland, the origin. */
  _uiRequest(cmd, w, extra = {}) {
    const req = { cmd, window: w.ref, ...extra };
    const origin = this._uiOrigin(w.window);
    if (origin) req.origin = origin;
    return req;
  }

  /** The window key ids are built on, and the reference cached with them (with the helper's index). */
  _uiKeyAndRef(w, res) {
    const hw = (res && res.window) || {};
    const key = w.key || `@${Number(hw.pid) || 0}.${Number(hw.index) || 0}`;
    const ref = { ...w.ref };
    if (Number.isInteger(hw.index)) ref.index = hw.index;
    if (!ref.pid && Number(hw.pid) > 0) ref.pid = Number(hw.pid);
    if (!ref.title && hw.title) ref.title = String(hw.title);
    return { key, ref };
  }

  _uiNotes(res, w) {
    const notes = Array.isArray(res.notes) ? res.notes.filter((n) => typeof n === 'string' && n) : [];
    if (this._uiRelative(w.window)) notes.push(RELATIVE_BOUNDS_NOTE);
    if (res.truncated) notes.push('The walk stopped at its node, depth or time limit; narrow it down with ui_find, or ask for more nodes.');
    return notes;
  }

  /**
   * The accessibility tree of a window (Driver.uiTree), breadth first: up to `depth` listed levels
   * below the window and `maxNodes` nodes. Unnamed containers, decorative images and labels that
   * repeat their parent's name are walked through but not listed; showing pop-up menus of the app
   * are extra roots. Nodes come in document order.
   * @param {{windowId?:string, depth?:number, maxNodes?:number, budgetMs?:number}} [opts]
   * @returns {Promise<{window:{id,app,title}, nodes:object[], truncated:boolean, scanned?:number, notes?:string[], relativeBounds?:boolean}>}
   */
  async uiTree({ windowId, depth = 6, maxNodes = 400, budgetMs = UI_BUDGET_MS } = {}) {
    const w = await this._uiWindowRef(windowId);
    const req = this._uiRequest('tree', w, {
      depth: clampInt(depth == null ? 6 : depth, 0, 50, 6),
      maxNodes: clampInt(maxNodes == null ? 400 : maxNodes, 1, 5000, 400),
      budgetMs: clampInt(budgetMs == null ? UI_BUDGET_MS : budgetMs, 200, UI_MAX_BUDGET_MS, UI_BUDGET_MS),
    });
    const res = await this._atspi(req, { timeoutMs: req.budgetMs + UI_HELPER_MARGIN_MS });
    const { key, ref } = this._uiKeyAndRef(w, res);
    const toId = (r) => (typeof r === 'string' && r ? formatUiId(key, r) : null);
    const nodes = [];
    for (const n of Array.isArray(res.nodes) ? res.nodes : []) {
      if (!n || typeof n.ref !== 'string') continue;
      const out = uiState({ id: toId(n.ref), role: uiRoleOf(n.role), name: typeof n.name === 'string' ? n.name : '' }, n);
      out.parent = toId(n.parent);
      out.children = Array.isArray(n.children) ? n.children.map(toId).filter(Boolean) : [];
      if (Number.isInteger(n.depth)) out.depth = n.depth;
      if (n.more === true) out.more = true;
      nodes.push(out);
      this._uiRemember(out.id, { key, window: ref, bounds: out.bounds, role: out.role, name: out.name });
    }
    const hw = res.window || {};
    const result = {
      window: { id: key, app: String((w.window && w.window.app) || hw.app || ''), title: String(hw.title || (w.window && w.window.title) || '') },
      nodes,
      truncated: res.truncated === true,
    };
    if (Number.isFinite(res.scanned)) result.scanned = res.scanned;
    const notes = this._uiNotes(res, w);
    if (notes.length) result.notes = notes;
    if (this._uiRelative(w.window)) result.relativeBounds = true;
    return result;
  }

  /**
   * Find elements of a window (Driver.uiFind) by name (the accessible name), text (name, value or
   * description) and/or role; case-insensitive substring, or the whole text with exact. Open menus
   * and drop-downs of the app are searched first. Best matches first: whole text, then prefix, then
   * substring; controls before labels, on-screen and enabled first. The array also carries
   * non-enumerable window, truncated, scanned, total, notes and relativeBounds.
   * @param {{windowId?:string, name?:string, role?:string|string[], text?:string, exact?:boolean, limit?:number,
   *   depth?:number, maxNodes?:number, budgetMs?:number}} [opts]
   * @returns {Promise<Array<{id,role,name,value,bounds,windowId,path,enabled,focused}>>}
   */
  async uiFind({ windowId, name, role, text, exact = false, limit = 20, depth, maxNodes, budgetMs = UI_BUDGET_MS } = {}) {
    const n = name == null ? '' : String(name).trim();
    const t = text == null ? '' : String(text).trim();
    const roles = uiRoleFilter(role);
    if (!n && !t && !roles) throw uiError('uiFind needs a name, text or role to look for', 'BAD_ARGS', 'Example: { name: "Save", role: "button" }');
    const w = await this._uiWindowRef(windowId);
    const extra = {
      exact: exact === true,
      limit: clampInt(limit == null ? 20 : limit, 1, 200, 20),
      budgetMs: clampInt(budgetMs == null ? UI_BUDGET_MS : budgetMs, 200, UI_MAX_BUDGET_MS, UI_BUDGET_MS),
    };
    if (n) extra.name = n;
    if (t) extra.text = t;
    if (roles) extra.roles = roles;
    if (depth != null) extra.depth = clampInt(depth, 1, 80, 60);
    if (maxNodes != null) extra.maxNodes = clampInt(maxNodes, 1, 50000, 8000);
    const req = this._uiRequest('find', w, extra);
    const res = await this._atspi(req, { timeoutMs: req.budgetMs + UI_HELPER_MARGIN_MS });
    const { key, ref } = this._uiKeyAndRef(w, res);
    const list = [];
    for (const m of Array.isArray(res.matches) ? res.matches : []) {
      if (!m || typeof m.ref !== 'string') continue;
      const out = uiState({ id: formatUiId(key, m.ref), role: uiRoleOf(m.role), name: typeof m.name === 'string' ? m.name : '' }, m);
      out.value = typeof m.value === 'string' ? m.value : '';
      out.windowId = key;
      out.path = typeof m.path === 'string' ? m.path : '';
      list.push(out);
      this._uiRemember(out.id, { key, window: ref, bounds: out.bounds, role: out.role, name: out.name });
    }
    const hw = res.window || {};
    const notes = this._uiNotes(res, w);
    return withMeta(list, {
      window: { id: key, app: String((w.window && w.window.app) || hw.app || ''), title: String(hw.title || (w.window && w.window.title) || '') },
      truncated: res.truncated === true,
      scanned: Number.isFinite(res.scanned) ? res.scanned : undefined,
      total: Number.isFinite(res.total) ? res.total : undefined,
      notes: notes.length ? notes : undefined,
      relativeBounds: this._uiRelative(w.window) || undefined,
    });
  }

  /**
   * Act on an element from uiFind/uiTree without the mouse (Driver.uiAction): press = the default
   * action (click, press, activate, jump...) or selecting it in its parent; focus = grab_focus;
   * setValue = EditableText (or Value for sliders, or the named option of a combo box); select =
   * selection in the parent, or with a value the named option inside; expand / collapse; scrollIntoView
   * = scroll_to; showMenu = a menu action, else focus + Shift+F10.
   * ok false (method 'none', with a reason) means the element does not support it: click it instead.
   * pending: the app had not answered (an action that opened a modal dialog, usually).
   * @param {{id:string, action?:string, value?:string|number}} opts
   * @returns {Promise<{ok:boolean, method:string, reason?:string, pending?:boolean, disabled?:boolean,
   *   confirmed?:boolean, item?:string, role?:string, name?:string, bounds?:object, value?:string, id?:string, resolved?:string}>}
   */
  async uiAction({ id, action = 'press', value } = {}) {
    const p = parseUiId(id);
    if (!p) throw uiError(`Invalid UI element id ${JSON.stringify(id)}`, 'BAD_ARGS', 'Use an id returned by uiFind or uiTree.');
    const act = UI_ACTION_MAP.get(String(action == null ? 'press' : action).trim().toLowerCase());
    if (!act) throw uiError(`Unknown UI action "${action}"`, 'BAD_ARGS', `Use one of: ${UI_ACTIONS.join(', ')}.`);
    if (act === 'setValue' && value == null) throw uiError('setValue needs a value', 'BAD_ARGS');
    const cached = this._uiCached(String(id).trim());
    let w;
    if (UI_APP_KEY_RE.test(p.windowKey)) {
      w = { key: p.windowKey, window: null, ref: cached ? cached.window : (await this._uiWindowRef(p.windowKey)).ref };
    } else {
      try {
        w = await this._uiWindowRef(p.windowKey);
      } catch (err) {
        if (err && err.code === 'NOT_FOUND') throw uiError(`The window of element ${id} is closed`, 'STALE', 'Call ui_find again.');
        throw err;
      }
      if (cached && cached.window && Number.isInteger(cached.window.index)) w = { ...w, ref: { ...w.ref, index: cached.window.index } };
    }
    const extra = { root: p.root, path: p.pathText, hash: p.hash, action: act };
    if (value != null) extra.value = typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
    const req = this._uiRequest('action', w, extra);
    let res = await this._atspi(req, { timeoutMs: UI_ACTION_TIMEOUT_MS });
    if (res.ok !== true && act === 'showMenu' && !res.disabled) res = await this._uiMenuByKeyboard(req, res);
    const out = { ok: res.ok === true, method: typeof res.method === 'string' && res.method ? res.method : 'none' };
    for (const k of ['reason', 'item', 'resolved']) if (typeof res[k] === 'string' && res[k]) out[k] = res[k];
    if (res.pending === true) out.pending = true;
    if (res.disabled === true) out.disabled = true;
    if (res.confirmed === false) out.confirmed = false;
    if (typeof res.value === 'string' || typeof res.value === 'number') out.value = String(res.value);
    if (typeof res.role === 'string') out.role = uiRoleOf(res.role);
    if (typeof res.name === 'string') out.name = res.name;
    if (res.bounds) out.bounds = uiBounds(res.bounds);
    if (this._uiRelative(w.window)) out.relativeBounds = true;
    const newId = typeof res.ref === 'string' && res.ref ? formatUiId(p.windowKey, res.ref) : null;
    if (newId && newId !== String(id).trim()) out.id = newId;
    this._uiRemember(newId || String(id).trim(), {
      key: p.windowKey,
      window: cached ? cached.window : w.ref,
      bounds: out.bounds || (cached && cached.bounds) || null,
      role: out.role || (cached && cached.role) || '',
      name: out.name != null ? out.name : (cached && cached.name) || '',
    });
    return out;
  }

  /** showMenu without a menu action: give the element focus and press Shift+F10 (the context-menu key). */
  async _uiMenuByKeyboard(req, failed) {
    let focus;
    try {
      focus = await this._atspi({ ...req, action: 'focus' }, { timeoutMs: UI_ACTION_TIMEOUT_MS });
    } catch {
      return failed;
    }
    if (!focus || focus.ok !== true) return failed;
    try {
      await this.keyCombo(['shift', 'f10']);
    } catch (err) {
      log.debug('Shift+F10 for showMenu failed:', err && err.message);
      return failed;
    }
    return { ...focus, ok: true, method: 'focus+shift+F10' };
  }

  /** capabilities().ui: whether the helper runs and reaches the accessibility bus (cached a while). */
  async _uiCapabilities() {
    const st = this._uiState();
    if (st.probe && Date.now() - st.probe.at < UI_PROBE_TTL_MS) return st.probe.value;
    let value;
    try {
      const res = await this._atspi({ cmd: 'probe' }, { timeoutMs: UI_PROBE_TIMEOUT_MS });
      const n = Number(res.appCount) || 0;
      value = {
        ui: true,
        notes: [
          `UI automation (ui_find, ui_click) via AT-SPI with Python ${res.python || '3'}: ${n} application${n === 1 ? '' : 's'} on the accessibility bus.`,
          `${CHROMIUM_A11Y_HINT}.`,
        ],
        hint: '',
      };
    } catch (err) {
      const hint = (err && err.hint) || '';
      value = { ui: false, notes: [`UI automation (ui_find, ui_click) is unavailable: ${err && err.message}.${hint ? ` ${hint}` : ''}`], hint };
    }
    st.probe = { at: Date.now(), value };
    return value;
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

  // ----- window bounds -----

  /** _NET_WM_STATE atoms without the prefix (MAXIMIZED_VERT, FULLSCREEN, HIDDEN...), or null when unknown. */
  async _netWmState(hex) {
    if (!this._has('xprop')) return null;
    const p = await this._xprop(hex, ['_NET_WM_STATE']);
    if (!p) return null;
    const vals = (p._NET_WM_STATE && p._NET_WM_STATE.values) || [];
    return vals.map((v) => String(v).replace(/^_NET_WM_STATE_/, ''));
  }

  /** Add or remove EWMH states (wmctrl takes two at a time; xdotool windowstate one). */
  async _setWmStates(hex, op, props) {
    if (this._has('wmctrl')) {
      const names = props.map((x) => x.toLowerCase());
      for (let i = 0; i < names.length; i += 2) {
        const r = await this._run('wmctrl', ['-i', '-r', hex, '-b', `${op},${names.slice(i, i + 2).join(',')}`], { timeoutMs: 3000 });
        if (!ok(r)) return false;
      }
      return true;
    }
    if (this._has('xdotool')) {
      for (const prop of props) {
        const r = await this._run('xdotool', ['windowstate', op === 'add' ? '--add' : '--remove', prop.toUpperCase(), x11IdToDecimal(hex)], { timeoutMs: 3000 });
        if (!ok(r)) return false;
      }
      return true;
    }
    return false;
  }

  /** Poll _NET_WM_STATE until test(states) holds; true without xprop (it cannot be checked). */
  async _waitWmState(hex, test, ms = STATE_WAIT_MS) {
    const until = Date.now() + ms;
    for (;;) {
      const st = await this._netWmState(hex);
      if (st == null) return true;
      if (test(st)) return true;
      if (Date.now() >= until) return false;
      await sleep(60);
    }
  }

  /** The window's client area in absolute screen pixels (what listWindows() reports). */
  async _clientGeometry(hex) {
    if (this._has('xwininfo')) {
      const r = await this._run('xwininfo', ['-id', hex], { timeoutMs: 2000, env: this._env({ LC_ALL: 'C' }) });
      const g = ok(r) ? parseXwininfoWindow(r.stdout) : null;
      if (g) return g;
    }
    if (this._has('xdotool')) {
      const r = await this._run('xdotool', ['getwindowgeometry', '--shell', x11IdToDecimal(hex)], { timeoutMs: 2000 });
      if (ok(r)) return parseWindowGeometry(r.stdout);
    }
    return null;
  }

  async _moveResize(hex, t) {
    if (this._has('wmctrl')) {
      // Gravity 0: the window's own gravity.
      const r = await this._run('wmctrl', ['-i', '-r', hex, '-e', `0,${t.x},${t.y},${t.width},${t.height}`], { timeoutMs: 3000 });
      if (ok(r)) return true;
    }
    if (this._has('xdotool')) {
      const dec = x11IdToDecimal(hex);
      const a = await this._run('xdotool', ['windowsize', dec, t.width, t.height], { timeoutMs: 3000 });
      const b = await this._run('xdotool', ['windowmove', dec, t.x, t.y], { timeoutMs: 3000 });
      return ok(a) && ok(b);
    }
    return false;
  }

  /**
   * Move/resize a window, or change its state (Driver.setWindowBounds). Bounds are the client area in
   * X11 pixels, as listWindows() reports it (the frame's offset is corrected after a first move);
   * any of x, y, width, height may be left out. maximize / fullscreen / restore use EWMH states
   * (_NET_WM_STATE), minimize iconifies, restore also un-minimizes.
   * @param {string} windowId
   * @param {{x?:number,y?:number,width?:number,height?:number}|{state:'maximize'|'minimize'|'restore'|'fullscreen'}} spec
   * @returns {Promise<boolean>} false when the window is gone or the window manager refused
   */
  async setWindowBounds(windowId, spec) {
    this._requireDisplay();
    const s = parseBoundsSpec(spec);
    const raw = windowId && typeof windowId === 'object' && windowId.id != null ? windowId.id : windowId;
    const hex = normalizeX11Id(raw);
    if (!this._has('wmctrl') && !this._has('xdotool')) {
      throw unsupportedError('Cannot move or resize windows: install wmctrl (or xdotool)', this._hint(['wmctrl', 'xdotool']));
    }
    if (!(await this._windowExists(hex))) return false;
    const MAX = ['MAXIMIZED_VERT', 'MAXIMIZED_HORZ'];
    const minimized = async () => this._has('xprop') && (await this._isMinimized(hex));
    if (s.state === 'minimize') return this.minimizeWindow(hex);
    if (s.state === 'maximize' || s.state === 'fullscreen') {
      if (await minimized()) await this.focusWindow(hex);
      const props = s.state === 'maximize' ? MAX : ['FULLSCREEN'];
      if (s.state === 'maximize') await this._setWmStates(hex, 'remove', ['FULLSCREEN']);
      if (!(await this._setWmStates(hex, 'add', props))) return false;
      return this._waitWmState(hex, (st) => props.every((x) => st.includes(x)));
    }
    if (s.state === 'restore') {
      await this._setWmStates(hex, 'remove', ['FULLSCREEN']);
      await this._setWmStates(hex, 'remove', MAX);
      if (await minimized()) await this.focusWindow(hex);
      const normal = await this._waitWmState(hex, (st) => !st.includes('FULLSCREEN') && !MAX.some((x) => st.includes(x)) && !st.includes('HIDDEN'));
      return normal && !(await minimized());
    }
    // Bounds: leave full screen / maximized first (window managers ignore moves otherwise).
    const st = await this._netWmState(hex);
    if (!st || st.includes('FULLSCREEN')) await this._setWmStates(hex, 'remove', ['FULLSCREEN']);
    if (!st || MAX.some((x) => st.includes(x))) await this._setWmStates(hex, 'remove', MAX);
    if (st && st.includes('HIDDEN')) await this.focusWindow(hex);
    const cur = await this._clientGeometry(hex);
    if (!cur && Object.keys(s).length < 4) {
      throw uiError('Cannot read the window geometry to keep the values left out', 'UNSUPPORTED', this._hint(['xwininfo']));
    }
    const target = {
      x: s.x != null ? s.x : cur.x,
      y: s.y != null ? s.y : cur.y,
      width: s.width != null ? s.width : cur.width,
      height: s.height != null ? s.height : cur.height,
    };
    if (!(await this._moveResize(hex, target))) return false;
    await sleep(BOUNDS_SETTLE_MS);
    let now = await this._clientGeometry(hex);
    if (!now) return true;
    // The window manager may place the frame where the client was asked to go: shift by that offset once.
    const dx = now.x - target.x;
    const dy = now.y - target.y;
    if ((dx || dy) && Math.abs(dx) <= 200 && Math.abs(dy) <= 200) {
      await this._moveResize(hex, { ...target, x: target.x - dx, y: target.y - dy });
      await sleep(BOUNDS_SETTLE_MS);
      now = (await this._clientGeometry(hex)) || now;
    }
    // Size hints (a terminal's character cells) may round the size a little.
    return nearRect(now, target, 8, 64);
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
    const ui = await this._uiCapabilities();
    notes.push(...ui.notes);
    return {
      screenshot: reachable && shotTools.length > 0,
      mouse: reachable && xdotool,
      keyboard: reachable && xdotool,
      windows: reachable && (this._has('wmctrl') || xdotool),
      clipboard: reachable && clip,
      notify,
      speak,
      ui: ui.ui,
      notes,
      install,
      ...(ui.hint ? { uiHint: ui.hint } : {}),
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

  // ----- window bounds -----

  async _swayCmd(cmd) {
    const r = await this._run('swaymsg', [cmd], { timeoutMs: 3000 });
    if (!ok(r)) return false;
    try {
      const j = JSON.parse(r.stdout);
      if (Array.isArray(j)) return j.every((x) => !x || x.success !== false);
    } catch {
      /* older swaymsg prints nothing parseable on success */
    }
    return true;
  }

  async _swayBounds(id, s) {
    const sel = `[con_id=${id}]`;
    const w = (await this.listWindows()).find((x) => x.id === id);
    if (!w) return false;
    if (s.state === 'minimize') return this.minimizeWindow(id);
    if (w.minimized && !(await this._swayCmd(`${sel} scratchpad show, floating disable`))) return false;
    // sway has no maximize: full screen on the window's output is the closest it offers.
    if (s.state === 'maximize' || s.state === 'fullscreen') return this._swayCmd(`${sel} fullscreen enable`);
    if (s.state === 'restore') return this._swayCmd(`${sel} fullscreen disable`);
    const t = {
      x: s.x != null ? s.x : w.x,
      y: s.y != null ? s.y : w.y,
      width: s.width != null ? s.width : w.width,
      height: s.height != null ? s.height : w.height,
    };
    return this._swayCmd(
      `${sel} fullscreen disable, floating enable, resize set width ${t.width} px height ${t.height} px, move absolute position ${t.x} px ${t.y} px`,
    );
  }

  async _hyprClient(addr) {
    const r = await this._run('hyprctl', ['clients', '-j'], { timeoutMs: 3000 });
    if (!ok(r)) return null;
    try {
      const list = JSON.parse(r.stdout);
      return (Array.isArray(list) && list.find((c) => c && c.address === addr)) || null;
    } catch {
      return null;
    }
  }

  /** 'maximize' | 'fullscreen' | null (Hyprland >= 0.42 numbers the mode; older ones have a flag and fullscreenMode). */
  _hyprFullscreen(c) {
    if (typeof c.fullscreen === 'number') return c.fullscreen === 1 ? 'maximize' : c.fullscreen >= 2 ? 'fullscreen' : null;
    if (c.fullscreen === true) return c.fullscreenMode === 1 ? 'maximize' : 'fullscreen';
    return null;
  }

  async _hyprBounds(addr, s) {
    const c = await this._hyprClient(addr);
    if (!c) return false;
    if (s.state === 'minimize') return this.minimizeWindow(addr);
    const wsName = (c.workspace && c.workspace.name) || '';
    if (wsName.startsWith('special')) {
      // Back from the "minimized" special workspace to the one on screen.
      const r = await this._run('hyprctl', ['activeworkspace', '-j'], { timeoutMs: 2000 });
      let wsId = null;
      try {
        wsId = ok(r) ? JSON.parse(r.stdout).id : null;
      } catch {
        wsId = null;
      }
      if (!Number.isInteger(wsId) || !(await this._hyprDispatch('movetoworkspacesilent', `${wsId},address:${addr}`))) return false;
    }
    const mode = this._hyprFullscreen(c);
    // The fullscreen dispatcher toggles the focused window: 1 = maximize, 0 = full screen.
    const toggle = async (m) => (await this._hyprDispatch('focuswindow', `address:${addr}`)) && this._hyprDispatch('fullscreen', m === 'maximize' ? '1' : '0');
    if (s.state === 'maximize' || s.state === 'fullscreen') {
      if (mode === s.state) return true;
      if (mode && !(await toggle(mode))) return false;
      return toggle(s.state);
    }
    if (mode && !(await toggle(mode))) return false;
    if (s.state === 'restore') return true;
    const at = Array.isArray(c.at) ? c.at : [0, 0];
    const size = Array.isArray(c.size) ? c.size : [0, 0];
    const t = {
      x: s.x != null ? s.x : at[0],
      y: s.y != null ? s.y : at[1],
      width: s.width != null ? s.width : size[0],
      height: s.height != null ? s.height : size[1],
    };
    if (!c.floating && !(await this._hyprDispatch('setfloating', `address:${addr}`))) return false;
    const resized = await this._hyprDispatch('resizewindowpixel', `exact ${t.width} ${t.height},address:${addr}`);
    const moved = await this._hyprDispatch('movewindowpixel', `exact ${t.x} ${t.y},address:${addr}`);
    return resized && moved;
  }

  /**
   * Move/resize a window or change its state (Driver.setWindowBounds) on sway (floating, fullscreen,
   * scratchpad) and Hyprland (floating, fullscreen modes, the special "minimized" workspace).
   * GNOME and KDE on Wayland do not let other programs move windows: UNSUPPORTED with a hint.
   * @returns {Promise<boolean>}
   */
  async setWindowBounds(windowId, spec) {
    const s = parseBoundsSpec(spec);
    const raw = windowId && typeof windowId === 'object' && windowId.id != null ? windowId.id : windowId;
    if (this._swayOk()) return this._swayBounds(this._swayId(raw), s);
    if (this._hyprOk()) return this._hyprBounds(this._hyprAddress(raw), s);
    const why = this._windowsUnsupported();
    throw unsupportedError(`Moving and resizing windows is not available on ${this.compositor} (Wayland)`, why.hint);
  }

  // ----- UI automation -----

  /** Apps on Wayland do not know where their windows are: element extents are window-relative plus this origin. */
  _uiOrigin(win) {
    if (win && Number.isFinite(win.x) && Number.isFinite(win.y) && (this._swayOk() || this._hyprOk())) return { x: win.x, y: win.y };
    return null;
  }

  _uiRelative(win) {
    return !this._uiOrigin(win);
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
    const ui = await this._uiCapabilities();
    notes.push(...ui.notes);
    if (ui.ui && !windows) notes.push(RELATIVE_BOUNDS_NOTE);
    return {
      screenshot: shotTools.length > 0,
      mouse,
      keyboard,
      windows,
      clipboard,
      notify,
      speak,
      ui: ui.ui,
      notes,
      install,
      ...(ui.hint ? { uiHint: ui.hint } : {}),
    };
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
  // browser tabs (shared with darwin.js and win32.js)
  readBrowserTab,
  keyboardReadTab,
  resolveBrowserWindow,
  browserWindows,
  identifyBrowser,
  normalizeBrowserQuery,
  normalizeTabUrl,
  looksLikeAddress,
  cleanPageText,
  clipTabText,
  sameWindowId,
  BROWSERS,
  TAB_TIMING,
  DEFAULT_TAB_CHARS,
  // UI automation (shared with the mock driver in index.js) and window bounds
  UI_ROLES,
  UI_ACTIONS,
  normalizeUiRole,
  uiRoleFilter,
  uiMatchScore,
  parseUiId,
  formatUiId,
  parseHelperOutput,
  parseBoundsSpec,
  parseXwininfoWindow,
  withMeta,
  ATSPI_HELPER,
  CHROMIUM_A11Y_HINT,
  CHROMIUM_A11Y_ARGS,
  CHROMIUM_A11Y_ENV,
};
