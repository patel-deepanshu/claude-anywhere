'use strict';

/**
 * Browsers as the user has them: profiles and bookmarks, opening a URL in a particular browser
 * (reusing its running instance), and listing or switching tabs. Used by the desktop MCP tools
 * (src/mcp/tools-desktop.js) and the CLI (`anywhere desktop bookmarks|open-url|tabs|switch-tab`).
 *
 * Bookmarks (read from disk, no browser needed):
 *   Chromium family (Chrome, Brave, Edge, Chromium, Vivaldi, Opera, Arc): <user data>/<profile>/Bookmarks
 *     JSON for every profile ("Default", "Profile N", names from "Local State"), the bookmarks bar first.
 *     Arc's pinned tabs and favourites come from StorableSidebar.json (macOS).
 *   Firefox: places.sqlite through the sqlite3 CLI (a copy, so a running Firefox does not lock it),
 *     else the newest bookmarkbackups/*.jsonlz4 (decoded here), else a hint.
 *   Safari (macOS): ~/Library/Safari/Bookmarks.plist through `plutil -convert xml1`.
 * Paths honour HOME, XDG_CONFIG_HOME (Linux) and LOCALAPPDATA / APPDATA (Windows); WSL reads the
 * Windows profiles under /mnt/c.
 *
 * Opening: macOS `open -a <app> <url>` (Chromium `--new-window` through `open -n`; same tab and Safari
 * windows through AppleScript); Windows the browser's executable (App Paths, then install folders)
 * through Start-Process; Linux the executable or flatpak. A running browser takes the URL as a new tab.
 *
 * Tabs: macOS AppleScript (JXA) for Chromium browsers and Safari: every window's tabs with title, URL
 * and the active one; Windows UI Automation (TabItem controls of the tab strip, one-shot powershell.exe),
 * switched with SelectionItemPattern.Select; Linux the tab strip through the accessibility tree
 * (driver.uiFind / uiAction over AT-SPI, when the browser exposes it), switched with its press action;
 * elsewhere (and as the fallback) the window titles, and on request the keyboard: primary+1..8 /
 * primary+9 and ctrl+PageDown, checking the window title after each key. Keyboard paths call
 * beforeInput (the user's pause guard) before every key, focus the browser first and stop if it did
 * not come to the front. Titles cannot tell two tabs with the same title apart, so the keyboard cycle
 * can stop early on duplicates: the accessibility path has no such limit.
 *
 *   BROWSER_DEFS, resolveBrowser(query) -> def|null
 *   async bookmarks({browser?, query?, folder?, profile?, limit?, prefer?}, deps?) -> {items, total, sources, notes, hints}
 *   async open({browser?, url, newTab?, newWindow?, driver?, computer?, beforeInput?, timeoutMs?}, deps?)
 *   async listTabs({browser?, driver, computer?, cycle?, beforeInput?}, deps?)
 *   async switchTab({browser?, match?, index?, driver, computer?, beforeInput?}, deps?)
 */

const path = require('path');
const { pathToFileURL } = require('url');
const apps = require('./apps');
const linux = require('./linux');
const { createLogger } = require('../shared/log');

const log = createLogger('browsers');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const OPEN_WAIT_MS = 10000;
const KEY_SETTLE_MS = 120;
const TITLE_WAIT_MS = 900;
const TITLE_POLL_MS = 80;
const MAX_CYCLE_TABS = 60;
const FOCUS_WAIT_MS = 1500;
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'vbscript']);

// ---------------------------------------------------------------- registry

/**
 * Known browsers. mac.data: under ~/Library/Application Support; win.data: [base, relative] with base
 * local (LOCALAPPDATA), roaming (APPDATA) or packages (LOCALAPPDATA\Packages\<glob>\...); linux.data:
 * under XDG_CONFIG_HOME, plus the flatpak (~/.var/app/<id>/config) and snap copies.
 */
const BROWSER_DEFS = [
  {
    id: 'chrome', name: 'Google Chrome', family: 'chromium',
    mac: { app: 'Google Chrome', bundleId: 'com.google.Chrome', data: ['Google/Chrome'] },
    win: { exes: ['chrome.exe'], data: [['local', 'Google\\Chrome\\User Data']], paths: ['Google\\Chrome\\Application\\chrome.exe'] },
    linux: { exes: ['google-chrome', 'google-chrome-stable'], data: ['google-chrome'], flatpak: 'com.google.Chrome' },
  },
  {
    id: 'brave', name: 'Brave', family: 'chromium',
    mac: { app: 'Brave Browser', bundleId: 'com.brave.Browser', data: ['BraveSoftware/Brave-Browser'] },
    win: { exes: ['brave.exe'], data: [['local', 'BraveSoftware\\Brave-Browser\\User Data']], paths: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'] },
    linux: { exes: ['brave-browser', 'brave', 'brave-browser-stable'], data: ['BraveSoftware/Brave-Browser'], flatpak: 'com.brave.Browser', snap: ['snap/brave/current/.config/BraveSoftware/Brave-Browser'] },
  },
  {
    id: 'edge', name: 'Microsoft Edge', family: 'chromium',
    mac: { app: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac', data: ['Microsoft Edge'] },
    win: { exes: ['msedge.exe'], data: [['local', 'Microsoft\\Edge\\User Data']], paths: ['Microsoft\\Edge\\Application\\msedge.exe'] },
    linux: { exes: ['microsoft-edge', 'microsoft-edge-stable'], data: ['microsoft-edge'], flatpak: 'com.microsoft.Edge' },
  },
  {
    id: 'chromium', name: 'Chromium', family: 'chromium',
    mac: { app: 'Chromium', bundleId: 'org.chromium.Chromium', data: ['Chromium'] },
    win: { exes: [], data: [['local', 'Chromium\\User Data']], paths: ['Chromium\\Application\\chrome.exe'] },
    linux: { exes: ['chromium', 'chromium-browser'], data: ['chromium'], flatpak: 'org.chromium.Chromium', snap: ['snap/chromium/common/chromium'] },
  },
  {
    id: 'vivaldi', name: 'Vivaldi', family: 'chromium',
    mac: { app: 'Vivaldi', bundleId: 'com.vivaldi.Vivaldi', data: ['Vivaldi'] },
    win: { exes: ['vivaldi.exe'], data: [['local', 'Vivaldi\\User Data']], paths: ['Vivaldi\\Application\\vivaldi.exe'] },
    linux: { exes: ['vivaldi', 'vivaldi-stable'], data: ['vivaldi'], flatpak: 'com.vivaldi.Vivaldi' },
  },
  {
    id: 'opera', name: 'Opera', family: 'chromium',
    mac: { app: 'Opera', bundleId: 'com.operasoftware.Opera', data: ['com.operasoftware.Opera'] },
    win: { exes: ['opera.exe'], data: [['roaming', 'Opera Software\\Opera Stable'], ['roaming', 'Opera Software\\Opera GX Stable']], paths: ['Programs\\Opera\\launcher.exe', 'Programs\\Opera GX\\launcher.exe'] },
    linux: { exes: ['opera'], data: ['opera'], flatpak: 'com.opera.Opera' },
  },
  {
    id: 'arc', name: 'Arc', family: 'chromium',
    mac: { app: 'Arc', bundleId: 'company.thebrowser.Browser', data: ['Arc/User Data'], sidebar: 'Arc/StorableSidebar.json' },
    win: { exes: ['Arc.exe'], data: [['packages', 'TheBrowserCompany.Arc_', 'LocalCache\\Local\\Arc\\User Data']], paths: [] },
  },
  {
    id: 'firefox', name: 'Firefox', family: 'firefox',
    mac: { app: 'Firefox', bundleId: 'org.mozilla.firefox', data: ['Firefox'] },
    win: { exes: ['firefox.exe'], data: [['roaming', 'Mozilla\\Firefox']], paths: ['Mozilla Firefox\\firefox.exe'] },
    linux: { exes: ['firefox', 'firefox-esr'], home: ['.mozilla/firefox', 'snap/firefox/common/.mozilla/firefox', '.var/app/org.mozilla.firefox/.mozilla/firefox'], config: ['mozilla/firefox'], flatpak: 'org.mozilla.firefox' },
  },
  {
    id: 'safari', name: 'Safari', family: 'safari',
    mac: { app: 'Safari', bundleId: 'com.apple.Safari' },
  },
];

function browserError(message, code, hint, extra) {
  const err = new Error(message);
  if (code) err.code = code;
  if (hint) err.hint = hint;
  if (extra) Object.assign(err, extra);
  return err;
}

function osKey(ctx) {
  return ctx.flavor === 'darwin' ? 'mac' : ctx.flavor === 'linux' ? 'linux' : 'win';
}

/** Browsers this OS can have. */
function defsFor(ctx) {
  const k = osKey(ctx);
  return BROWSER_DEFS.filter((d) => d[k]);
}

/**
 * "brave", "Brave Browser", "google chrome", "ff", "edge" -> its BROWSER_DEFS entry, or null.
 * @param {string} query
 */
function resolveBrowser(query) {
  const q = linux.normalizeBrowserQuery(query);
  if (!q) return null;
  const norm = (s) => String(s).toLowerCase();
  return (
    BROWSER_DEFS.find((d) => d.id === q) ||
    BROWSER_DEFS.find((d) => norm(d.name) === q) ||
    BROWSER_DEFS.find((d) => (d.mac && norm(d.mac.app) === q)) ||
    BROWSER_DEFS.find((d) => q.split(' ').includes(d.id)) ||
    BROWSER_DEFS.find((d) => norm(d.name).includes(q) || q.includes(d.id)) ||
    null
  );
}

function unknownBrowser(query) {
  return browserError(
    `"${String(query).trim()}" is not a browser this tool knows`,
    'INVALID_INPUT',
    `Use one of: ${BROWSER_DEFS.map((d) => d.id).join(', ')}.`
  );
}

// ---------------------------------------------------------------- small helpers

function exists(ctx, p) {
  try {
    return ctx.fs.existsSync(p);
  } catch {
    return false;
  }
}

function readText(ctx, p) {
  try {
    return ctx.fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJson(ctx, p) {
  const t = readText(ctx, p);
  if (t == null) return null;
  try {
    return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  } catch {
    return null;
  }
}

function listNames(ctx, dir) {
  try {
    return ctx.fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function joinUnder(base, rel) {
  return path.join(base, ...String(rel).split(/[\\/]+/).filter(Boolean));
}

function own(ctx) {
  return ctx.isOwnWindow || ((w) => /^Claude Anywhere\b/.test(String((w && w.title) || '')) || String((w && w.app) || '') === 'Claude Anywhere');
}

function zOrdered(driver) {
  return Boolean(driver) && (driver.windowsZOrdered === true || /^(?:darwin|win32|wsl)$/.test(String(driver.name || '')));
}

async function listWindowsSafe(driver) {
  if (!driver || typeof driver.listWindows !== 'function') return [];
  try {
    return (await driver.listWindows()) || [];
  } catch (err) {
    if (err && err.code === 'UNSUPPORTED') return [];
    throw err;
  }
}

/** "Jira - Brave" -> "Jira" (the browser's own suffix on window titles). */
function stripBrowserSuffix(title) {
  const t = String(title == null ? '' : title).trim();
  for (const b of linux.BROWSERS) {
    if (b.title && b.title.test(t)) return t.replace(b.title, '').trim();
  }
  return t;
}

/** Chrome's accessible tab names carry extras ("- Memory usage - 120 MB", "- Audio playing"). */
function cleanTabTitle(name) {
  return String(name == null ? '' : name)
    .replace(/\s+-\s+(?:Memory usage|Speicherverbrauch|Utilisation de la mémoire)\s+-\s+[\d.,]+\s*[KMG]B$/i, '')
    .replace(/\s+-\s+(?:Audio playing|Playing audio|Muted|Pinned|Network error|Crashed|Camera or microphone recording|Sharing your screen|Sleeping|Inactive)$/i, '')
    .trim();
}

// ---------------------------------------------------------------- data directories

async function dataRoots(ctx) {
  if (ctx._roots) return ctx._roots;
  const env = ctx.env || {};
  let roots;
  if (ctx.flavor === 'darwin') roots = { appSupport: path.join(ctx.home, 'Library', 'Application Support'), home: ctx.home };
  else if (ctx.flavor === 'linux') roots = { config: env.XDG_CONFIG_HOME || path.join(ctx.home, '.config'), home: ctx.home };
  else {
    const f = await apps.windowsFolders(ctx);
    roots = { local: f.local, roaming: f.roaming, home: ctx.home };
  }
  ctx._roots = roots;
  return roots;
}

/** Chromium user-data directories that exist for a browser. */
function chromiumDataDirs(ctx, def, roots) {
  const out = [];
  if (ctx.flavor === 'darwin') {
    for (const d of def.mac.data || []) out.push({ dir: joinUnder(roots.appSupport, d), variant: '' });
  } else if (ctx.flavor === 'linux') {
    const L = def.linux;
    for (const d of L.data || []) {
      out.push({ dir: joinUnder(roots.config, d), variant: '' });
      if (L.flatpak) out.push({ dir: joinUnder(path.join(roots.home, '.var', 'app', L.flatpak, 'config'), d), variant: 'flatpak' });
    }
    for (const s of L.snap || []) out.push({ dir: joinUnder(roots.home, s), variant: 'snap' });
  } else {
    for (const [base, rel, rel2] of def.win.data || []) {
      if (base === 'packages') {
        const pk = roots.local ? path.join(roots.local, 'Packages') : null;
        for (const n of pk ? listNames(ctx, pk) : []) if (n.startsWith(rel)) out.push({ dir: joinUnder(path.join(pk, n), rel2), variant: '' });
      } else if (roots[base]) {
        out.push({ dir: joinUnder(roots[base], rel), variant: /GX/.test(rel) ? 'GX' : '' });
      }
    }
  }
  return out.filter((d) => exists(ctx, d.dir));
}

/**
 * Profiles of a Chromium user-data directory: names from "Local State", every "Default" /
 * "Profile N" folder, the last used one first. Opera keeps one profile in the directory itself.
 * @returns {Array<{dir:string, path:string, name:string, email?:string, lastUsed:boolean}>}
 */
function chromiumProfiles(ctx, userDataDir) {
  const state = readJson(ctx, path.join(userDataDir, 'Local State')) || {};
  const prof = (state && state.profile) || {};
  const cache = prof.info_cache && typeof prof.info_cache === 'object' ? prof.info_cache : {};
  const lastUsed = typeof prof.last_used === 'string' ? prof.last_used : 'Default';
  const dirs = new Set(Object.keys(cache));
  for (const n of listNames(ctx, userDataDir)) if (n === 'Default' || /^Profile \d+$/.test(n)) dirs.add(n);
  dirs.delete('System Profile');
  dirs.delete('Guest Profile');
  const list = [...dirs]
    .map((d) => {
      const info = cache[d] || {};
      const name = String(info.name || info.gaia_given_name || (d === 'Default' ? 'Default' : d)).trim();
      const email = info.user_name ? String(info.user_name) : undefined;
      return { dir: d, path: path.join(userDataDir, d), name, email, lastUsed: d === lastUsed };
    })
    .filter((p) => exists(ctx, path.join(p.path, 'Bookmarks')));
  if (!list.length && exists(ctx, path.join(userDataDir, 'Bookmarks'))) {
    list.push({ dir: '.', path: userDataDir, name: 'Default', lastUsed: true });
  }
  const num = (d) => (d === 'Default' ? 0 : Number((/(\d+)$/.exec(d) || [])[1] || 9999));
  return list.sort((a, b) => Number(b.lastUsed) - Number(a.lastUsed) || num(a.dir) - num(b.dir));
}

// ---------------------------------------------------------------- bookmark parsers

const CHROMIUM_ROOTS = [
  ['bookmark_bar', 'Bookmarks bar', true],
  ['other', 'Other bookmarks', false],
  ['synced', 'Mobile bookmarks', false],
];

/**
 * Bookmarks of a Chromium "Bookmarks" file in display order: the bookmarks bar first, then other and
 * mobile bookmarks; folder is the path of folders ("Bookmarks bar/Work").
 * @param {string|object} json
 * @param {{browser?:string, profile?:string}} [meta]
 * @returns {Array<{title:string, url:string, folder:string, root:string, bar:boolean, position:number, browser?:string, profile?:string}>}
 */
function parseChromiumBookmarks(json, meta = {}) {
  const data = typeof json === 'string' ? JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json) : json;
  const roots = (data && data.roots) || {};
  const out = [];
  for (const [key, label, bar] of CHROMIUM_ROOTS) {
    const root = roots[key];
    if (!root || typeof root !== 'object') continue;
    const rootName = String(root.name || label);
    const walk = (node, trail, depth) => {
      if (depth > 40) return;
      (Array.isArray(node.children) ? node.children : []).forEach((c, i) => {
        if (!c || typeof c !== 'object') return;
        if (c.type === 'url' && c.url) {
          out.push({ title: String(c.name || ''), url: String(c.url), folder: trail.join('/'), root: rootName, bar, position: depth === 0 ? i + 1 : 0, ...meta });
        } else if (c.type === 'folder') {
          walk(c, [...trail, String(c.name || '(folder)')], depth + 1);
        }
      });
    };
    walk(root, [rootName], 0);
  }
  return out;
}

const FIREFOX_ROOTS = [
  ['toolbar_____', 'Bookmarks Toolbar', true],
  ['menu________', 'Bookmarks Menu', false],
  ['unfiled_____', 'Other Bookmarks', false],
  ['mobile______', 'Mobile Bookmarks', false],
];

const FIREFOX_SQL =
  "SELECT b.id, b.parent, b.type, b.position, IFNULL(b.guid, ''), IFNULL(b.title, ''), IFNULL(p.url, '') " +
  'FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position;';

function firefoxTreeItems(nodesByGuid, childrenOf, meta) {
  const out = [];
  for (const [guid, label, bar] of FIREFOX_ROOTS) {
    const root = nodesByGuid.get(guid);
    if (!root) continue;
    const walk = (node, trail, depth) => {
      if (depth > 40) return;
      childrenOf(node).forEach((c, i) => {
        if (c.kind === 'url') {
          if (!c.url || /^place:/i.test(c.url)) return;
          out.push({ title: c.title || '', url: c.url, folder: trail.join('/'), root: label, bar, position: depth === 0 ? i + 1 : 0, ...meta });
        } else if (c.kind === 'folder') {
          walk(c, [...trail, c.title || '(folder)'], depth + 1);
        }
      });
    };
    walk(root, [label], 0);
  }
  return out;
}

/**
 * Bookmarks from `sqlite3 -ascii` rows of FIREFOX_SQL (fields \x1F, rows \x1E).
 * @param {string} text
 * @param {object} [meta]
 */
function parseFirefoxRows(text, meta = {}) {
  const nodes = new Map();
  const byGuid = new Map();
  for (const row of String(text || '').split('\x1e')) {
    const f = row.replace(/^\r?\n/, '').split('\x1f');
    if (f.length < 7) continue;
    const node = {
      id: Number(f[0]),
      parent: Number(f[1]),
      type: Number(f[2]),
      position: Number(f[3]),
      guid: f[4],
      title: f[5],
      url: f[6].replace(/\r?\n$/, ''),
      children: [],
    };
    node.kind = node.type === 1 ? 'url' : node.type === 2 ? 'folder' : 'other';
    nodes.set(node.id, node);
    if (node.guid) byGuid.set(node.guid, node);
  }
  for (const n of nodes.values()) {
    const p = nodes.get(n.parent);
    if (p && p !== n) p.children.push(n);
  }
  for (const n of nodes.values()) n.children.sort((a, b) => a.position - b.position);
  return firefoxTreeItems(byGuid, (n) => n.children, meta);
}

/** Bookmarks from a Firefox JSON backup (bookmarkbackups/*.jsonlz4, decoded). */
function parseFirefoxBackup(json, meta = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const byGuid = new Map();
  const convert = (n) => {
    if (!n || typeof n !== 'object') return null;
    const kind = n.type === 'text/x-moz-place' ? 'url' : n.type === 'text/x-moz-place-container' ? 'folder' : 'other';
    const node = { guid: n.guid, title: String(n.title || ''), url: n.uri ? String(n.uri) : '', kind, children: [] };
    if (Array.isArray(n.children)) node.children = n.children.map(convert).filter(Boolean);
    if (node.guid) byGuid.set(node.guid, node);
    return node;
  };
  convert(data);
  return firefoxTreeItems(byGuid, (n) => n.children, meta);
}

/** Decompress one LZ4 block (the format of mozLz4 files). */
function lz4Block(src, size) {
  const out = Buffer.alloc(size);
  let i = 0;
  let o = 0;
  const fail = () => {
    throw browserError('Damaged LZ4 data', 'PARSE');
  };
  while (i < src.length) {
    const token = src[i++];
    let lit = token >> 4;
    if (lit === 15) {
      let b;
      do {
        if (i >= src.length) fail();
        b = src[i++];
        lit += b;
      } while (b === 255);
    }
    if (i + lit > src.length || o + lit > size) fail();
    src.copy(out, o, i, i + lit);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    if (i + 2 > src.length) fail();
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    let len = token & 15;
    if (len === 15) {
      let b;
      do {
        if (i >= src.length) fail();
        b = src[i++];
        len += b;
      } while (b === 255);
    }
    len += 4;
    let from = o - offset;
    if (!offset || from < 0 || o + len > size) fail();
    for (let k = 0; k < len; k++) out[o++] = out[from++];
  }
  return out.subarray(0, o);
}

/** Decode a Firefox mozLz4 file ("mozLz40\0", u32 size, LZ4 block). */
function decodeMozLz4(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('latin1', 0, 8) !== 'mozLz40\0') throw browserError('Not a mozLz4 file', 'PARSE');
  return lz4Block(buf.subarray(12), buf.readUInt32LE(8));
}

/**
 * Firefox profiles from profiles.ini: the installation's default profile first.
 * @param {string} text
 * @param {string} baseDir
 * @returns {Array<{name:string, path:string, isDefault:boolean}>}
 */
function parseFirefoxProfilesIni(text, baseDir) {
  const sections = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      cur = { name: sec[1], values: {} };
      sections.push(cur);
      continue;
    }
    const eq = line.indexOf('=');
    if (cur && eq > 0) cur.values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const installDefaults = new Set(sections.filter((s) => /^Install/i.test(s.name) && s.values.Default).map((s) => s.values.Default));
  const out = [];
  for (const s of sections) {
    if (!/^Profile\d+$/i.test(s.name) || !s.values.Path) continue;
    const rel = s.values.IsRelative !== '0';
    const p = rel ? joinUnder(baseDir, s.values.Path) : s.values.Path;
    out.push({ name: s.values.Name || path.basename(p), path: p, isDefault: installDefaults.has(s.values.Path) || (s.values.Default === '1' && !installDefaults.size) });
  }
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

const SAFARI_ROOTS = { BookmarksBar: ['Favorites', true, 0], BookmarksMenu: ['Bookmarks Menu', false, 1], 'com.apple.ReadingList': ['Reading List', false, 3] };

/** Bookmarks of Safari's Bookmarks.plist (parsed): Favorites first, the Reading List last. */
function parseSafariBookmarks(plist, meta = {}) {
  const tops = (plist && Array.isArray(plist.Children) ? plist.Children : []).filter((c) => c && c.WebBookmarkType === 'WebBookmarkTypeList');
  const ordered = tops
    .map((c) => {
      const known = SAFARI_ROOTS[c.Title];
      return { node: c, label: known ? known[0] : String(c.Title || 'Bookmarks'), bar: known ? known[1] : false, rank: known ? known[2] : 2 };
    })
    .sort((a, b) => a.rank - b.rank);
  const out = [];
  for (const top of ordered) {
    const walk = (node, trail, depth) => {
      if (depth > 40) return;
      (Array.isArray(node.Children) ? node.Children : []).forEach((c, i) => {
        if (!c || typeof c !== 'object') return;
        if (c.WebBookmarkType === 'WebBookmarkTypeLeaf' && c.URLString) {
          const title = (c.URIDictionary && c.URIDictionary.title) || c.Title || '';
          out.push({ title: String(title), url: String(c.URLString), folder: trail.join('/'), root: top.label, bar: top.bar, position: depth === 0 ? i + 1 : 0, ...meta });
        } else if (c.WebBookmarkType === 'WebBookmarkTypeList') {
          walk(c, [...trail, String(c.Title || '(folder)')], depth + 1);
        }
      });
    };
    walk(top.node, [top.label], 0);
  }
  return out;
}

/** Arc's pinned tabs and favourites (StorableSidebar.json), best effort. */
function parseArcSidebar(json, meta = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const containers = (data && data.sidebar && Array.isArray(data.sidebar.containers) && data.sidebar.containers) || [];
  const c = containers.find((x) => x && Array.isArray(x.items));
  if (!c) return [];
  const items = new Map();
  for (const it of c.items) if (it && typeof it === 'object' && it.id) items.set(it.id, it);
  const labels = new Map();
  for (const s of Array.isArray(c.spaces) ? c.spaces : []) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.containerIDs)) continue;
    for (let i = 0; i + 1 < s.containerIDs.length; i += 2) {
      const kind = s.containerIDs[i];
      const id = s.containerIDs[i + 1];
      if (typeof id === 'string' && kind === 'pinned') labels.set(id, { label: `${s.title || 'Space'} / Pinned`, bar: false });
    }
  }
  for (const id of Array.isArray(c.topAppsContainerIDs) ? c.topAppsContainerIDs : []) if (typeof id === 'string') labels.set(id, { label: 'Favorites', bar: true });
  const out = [];
  for (const it of items.values()) {
    const tab = it.data && it.data.tab;
    if (!tab || !tab.savedURL) continue;
    const trail = [];
    let root = null;
    let p = it.parentID;
    for (let guard = 0; p && guard < 40; guard++) {
      if (labels.has(p)) {
        root = labels.get(p);
        break;
      }
      const parent = items.get(p);
      if (!parent) break;
      if (parent.title) trail.unshift(String(parent.title));
      p = parent.parentID;
    }
    if (!root) continue; // unpinned (temporary) tabs are not bookmarks
    out.push({ title: String(it.title || tab.savedTitle || ''), url: String(tab.savedURL), folder: [root.label, ...trail].join('/'), root: root.label, bar: root.bar, position: 0, ...meta });
  }
  return out.sort((a, b) => Number(b.bar) - Number(a.bar));
}

// ---------------------------------------------------------------- reading bookmarks

const SQLITE_HINT = {
  linux: 'Install the sqlite3 command-line tool to read Firefox bookmarks: sudo apt install sqlite3 (Debian/Ubuntu) or sudo dnf install sqlite (Fedora).',
  win: 'Install the sqlite3 command-line tool to read Firefox bookmarks: winget install SQLite.SQLite (then restart the dialog).',
  mac: 'macOS ships /usr/bin/sqlite3; check that it runs.',
};

async function firefoxSources(ctx, roots) {
  const bases = [];
  if (ctx.flavor === 'darwin') bases.push(path.join(roots.appSupport, 'Firefox'));
  else if (ctx.flavor === 'linux') {
    const L = BROWSER_DEFS.find((d) => d.id === 'firefox').linux;
    for (const h of L.home) bases.push(joinUnder(roots.home, h));
    for (const c of L.config) bases.push(joinUnder(roots.config, c));
  } else if (roots.roaming) bases.push(joinUnder(roots.roaming, 'Mozilla\\Firefox'));
  const out = [];
  const seen = new Set();
  for (const base of bases) {
    const ini = readText(ctx, path.join(base, 'profiles.ini'));
    if (ini == null) continue;
    for (const p of parseFirefoxProfilesIni(ini, base)) {
      if (seen.has(p.path) || !exists(ctx, p.path)) continue;
      seen.add(p.path);
      out.push({ profile: p.name, dir: p.path, isDefault: p.isDefault });
    }
  }
  return out;
}

async function readFirefox(ctx, src, meta) {
  const db = path.join(src.dir, 'places.sqlite');
  const sqlite = ctx.which('sqlite3') || ctx.which('sqlite3.exe');
  let error = null;
  if (exists(ctx, db) && sqlite) {
    let tmp = null;
    try {
      tmp = ctx.fs.mkdtempSync(path.join(ctx.tmpdir(), 'anywhere-places-'));
      const copy = path.join(tmp, 'places.sqlite');
      ctx.fs.copyFileSync(db, copy);
      if (exists(ctx, `${db}-wal`)) ctx.fs.copyFileSync(`${db}-wal`, `${copy}-wal`);
      const r = await ctx.run(sqlite, ['-batch', '-ascii', copy, FIREFOX_SQL], { timeoutMs: 20000 });
      if (r.code === 0) return { items: parseFirefoxRows(r.stdout, meta), method: 'places.sqlite' };
      error = String(r.stderr || '').trim() || `sqlite3 exit ${r.code}`;
    } catch (err) {
      error = err.message;
    } finally {
      if (tmp) {
        try {
          ctx.fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* temp folder */
        }
      }
    }
  }
  const backupDir = path.join(src.dir, 'bookmarkbackups');
  const backups = listNames(ctx, backupDir)
    .filter((n) => /\.jsonlz4$/i.test(n))
    .map((n) => ({ n, date: (/(\d{4}-\d{2}-\d{2})/.exec(n) || [])[1] || '' }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.n.localeCompare(a.n)));
  for (const b of backups.slice(0, 3)) {
    try {
      const json = decodeMozLz4(ctx.fs.readFileSync(path.join(backupDir, b.n))).toString('utf8');
      const note = `Firefox bookmarks of ${meta.profile} come from its backup of ${b.date || b.n} (Firefox writes one a day), so the newest ones may be missing.`;
      return { items: parseFirefoxBackup(json, meta), method: 'backup', note, hint: sqlite ? undefined : SQLITE_HINT[osKey(ctx)] };
    } catch (err) {
      log.debug('firefox backup unreadable', b.n, err && err.message);
    }
  }
  if (!sqlite) return { items: [], method: 'none', note: `Firefox bookmarks of ${meta.profile} could not be read.`, hint: SQLITE_HINT[osKey(ctx)] };
  return { items: [], method: 'none', note: `Firefox bookmarks of ${meta.profile} could not be read${error ? ` (${error})` : ''}.` };
}

async function readSafari(ctx, meta) {
  const file = path.join(ctx.home, 'Library', 'Safari', 'Bookmarks.plist');
  const fdaHint = 'Reading Safari bookmarks needs Full Disk Access for the app running Claude (System Settings › Privacy & Security › Full Disk Access).';
  try {
    ctx.fs.statSync(file);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return { items: [], method: 'none', note: 'Safari bookmarks are protected by macOS.', hint: fdaHint };
    return null;
  }
  const r = await ctx.run(ctx.plutil || 'plutil', ['-convert', 'xml1', '-o', '-', file], { timeoutMs: 15000 });
  if (r.code !== 0) {
    const msg = String(r.stderr || '').trim();
    if (/not permitted|permission|denied/i.test(msg)) return { items: [], method: 'none', note: 'Safari bookmarks are protected by macOS.', hint: fdaHint };
    return { items: [], method: 'none', note: `Safari bookmarks could not be read (${msg || `plutil exit ${r.code}`}).` };
  }
  return { items: parseSafariBookmarks(apps.parsePlistXml(r.stdout), meta), method: 'Bookmarks.plist' };
}

/** Every bookmark source of a browser: [{profile, read: async () => {items, method, note?, hint?}}]. */
async function bookmarkSources(ctx, def, roots) {
  const out = [];
  if (def.family === 'chromium') {
    for (const d of chromiumDataDirs(ctx, def, roots)) {
      for (const p of chromiumProfiles(ctx, d.dir)) {
        const profile = d.variant ? `${p.name} (${d.variant})` : p.name;
        out.push({
          profile,
          dir: p.dir,
          email: p.email,
          lastUsed: p.lastUsed,
          read: async () => {
            const meta = { browser: def.name, profile };
            const text = readText(ctx, path.join(p.path, 'Bookmarks'));
            if (text == null) return { items: [], method: 'none', note: `${def.name} (${profile}): the Bookmarks file could not be read.` };
            try {
              return { items: parseChromiumBookmarks(text, meta), method: 'Bookmarks' };
            } catch (err) {
              return { items: [], method: 'none', note: `${def.name} (${profile}): the Bookmarks file is damaged (${err.message}).` };
            }
          },
        });
      }
    }
    if (ctx.flavor === 'darwin' && def.mac.sidebar) {
      const file = joinUnder(roots.appSupport, def.mac.sidebar);
      if (exists(ctx, file)) {
        out.push({
          profile: 'Sidebar',
          read: async () => {
            const json = readJson(ctx, file);
            try {
              return { items: json ? parseArcSidebar(json, { browser: def.name, profile: 'Sidebar' }) : [], method: 'StorableSidebar.json' };
            } catch (err) {
              return { items: [], method: 'none', note: `Arc's sidebar could not be read (${err.message}).` };
            }
          },
        });
      }
    }
  } else if (def.family === 'firefox') {
    for (const src of await firefoxSources(ctx, roots)) {
      out.push({ profile: src.profile, lastUsed: src.isDefault, read: () => readFirefox(ctx, src, { browser: def.name, profile: src.profile }) });
    }
  } else if (def.family === 'safari' && ctx.flavor === 'darwin') {
    // Always listed: ~/Library/Safari may be unreadable (Full Disk Access) rather than missing.
    out.push({ profile: 'Default', read: async () => (await readSafari(ctx, { browser: def.name, profile: 'Default' })) || { items: [], method: 'none' } });
  }
  return out;
}

const BAR_RE = /^(?:bar|bookmarks? ?bar|bookmark ?bar|toolbar|bookmarks? toolbar|favou?rites(?: ?bar)?)$/i;

function bookmarkText(b) {
  return apps.normalizeName(`${b.title} ${b.url}`);
}

/**
 * Bookmarks of the user's browsers (or one browser), the bookmarks bar first, filtered by text
 * (every word in the title or URL) and folder ("bar" means the bookmarks bar / toolbar / favourites).
 * @param {{browser?:string, query?:string, folder?:string, profile?:string, limit?:number, prefer?:string[]}} [opts]
 * @param {object} [deps]
 */
async function bookmarks(opts = {}, deps) {
  const ctx = apps.makeContext(deps);
  const { query, folder, profile, prefer = [] } = opts || {};
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(Number(opts.limit)) || DEFAULT_LIMIT));
  let defs;
  if (opts.browser != null && String(opts.browser).trim()) {
    const def = resolveBrowser(opts.browser);
    if (!def) throw unknownBrowser(opts.browser);
    if (!def[osKey(ctx)]) throw browserError(`${def.name} is not available on this operating system`, 'UNSUPPORTED');
    defs = [def];
  } else {
    defs = defsFor(ctx);
    const rank = (d) => {
      const i = prefer.indexOf(d.id);
      return i < 0 ? prefer.length : i;
    };
    defs = defs.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map((x) => x.d);
  }
  const roots = await dataRoots(ctx);
  const sources = [];
  const notes = [];
  const hints = [];
  let items = [];
  for (const def of defs) {
    let list;
    try {
      list = await bookmarkSources(ctx, def, roots);
    } catch (err) {
      notes.push(`${def.name}: ${err.message}`);
      continue;
    }
    const wanted = profile ? list.filter((s) => `${s.profile} ${s.dir || ''} ${s.email || ''}`.toLowerCase().includes(String(profile).toLowerCase())) : list;
    if (!wanted.length && opts.browser) {
      notes.push(list.length ? `${def.name} has no profile matching "${profile}" (profiles: ${list.map((s) => s.profile).join(', ')}).` : `No ${def.name} profile with bookmarks was found on this computer.`);
    }
    for (const s of wanted) {
      let r;
      try {
        r = await s.read();
      } catch (err) {
        r = { items: [], method: 'none', note: `${def.name} (${s.profile}): ${err.message}` };
      }
      sources.push({ browser: def.name, profile: s.profile, email: s.email, count: r.items.length, method: r.method });
      if (r.note) notes.push(r.note);
      if (r.hint && !hints.includes(r.hint)) hints.push(r.hint);
      items = items.concat(r.items);
    }
  }
  if (folder != null && String(folder).trim()) {
    const f = String(folder).trim();
    items = BAR_RE.test(f) ? items.filter((b) => b.bar) : items.filter((b) => apps.normalizeName(b.folder).includes(apps.normalizeName(f)));
  }
  if (query != null && String(query).trim()) {
    const q = apps.normalizeName(query);
    const words = q.split(' ').filter(Boolean);
    items = items
      .map((b, i) => ({ b, i, text: bookmarkText(b), title: apps.normalizeName(b.title) }))
      .filter((x) => words.every((w) => x.text.includes(w)))
      .sort((x, y) => Number(y.title.includes(q)) - Number(x.title.includes(q)) || Number(y.b.bar) - Number(x.b.bar) || x.i - y.i)
      .map((x) => x.b);
  }
  const total = items.length;
  return { items: items.slice(0, limit), total, sources, notes, hints };
}

// ---------------------------------------------------------------- URLs

const LOCAL_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[[0-9a-f:]+\]|[a-z0-9-]+\.(?:local|localhost|internal|lan))(?::\d+)?$/i;

/**
 * A URL to open: http(s), file, about:, browser pages (chrome://...), and bare addresses
 * ("example.com/x" -> https://, "localhost:3000" -> http://); local paths become file:// URLs.
 * javascript:, data: and vbscript: are refused.
 * @param {string} raw
 * @returns {string}
 */
function normalizeUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw browserError('The URL is empty', 'INVALID_INPUT');
  if (/[\u0000-\u001f\u007f]/.test(s)) throw browserError('The URL contains control characters', 'INVALID_INPUT');
  // Windows paths (also from WSL, where the browser is a Windows program): C:\x -> file:///C:/x, \\host\share -> file://host/share.
  if (/^[a-z]:[\\/]/i.test(s)) return `file:///${encodeURI(s.replace(/\\/g, '/'))}`;
  if (s.startsWith('\\\\')) return `file:${encodeURI(s.replace(/\\/g, '/'))}`;
  if (s.startsWith('/') || s.startsWith('~/')) return pathToFileURL(s.startsWith('~/') ? path.join(require('os').homedir(), s.slice(2)) : s).href;
  const hostPort = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(s);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (scheme && !hostPort) {
    const sc = scheme[1].toLowerCase();
    if (BLOCKED_SCHEMES.has(sc)) throw browserError(`Refusing to open a ${sc}: URL`, 'BLOCKED', 'Only web addresses, files and browser pages can be opened.');
    return s.replace(/ /g, '%20');
  }
  if (/\s/.test(s)) throw browserError(`"${s}" is not a web address`, 'INVALID_INPUT', 'Pass a URL such as https://example.com, or search with the browser itself.');
  const host = s.split(/[/?#]/)[0];
  if (LOCAL_HOST_RE.test(host)) return `http://${s}`;
  if (/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*\.?(?::\d+)?$/i.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(host)) return `https://${s}`;
  throw browserError(`"${s}" is not a web address`, 'INVALID_INPUT', 'Pass a URL such as https://example.com.');
}

// ---------------------------------------------------------------- keyboard helpers

function sameWindow(a, b) {
  return linux.sameWindowId(a, b);
}

async function press(env, combo) {
  if (typeof env.beforeInput === 'function') await env.beforeInput();
  if (env.computer && typeof env.computer.key === 'function') {
    await env.computer.key({ combo });
    return;
  }
  const keys = require('./keys');
  const platform = env.ctx.platform === 'darwin' ? 'darwin' : env.ctx.platform === 'win32' ? 'win32' : 'linux';
  await env.driver.keyCombo(keys.normalizeCombo(combo, { platform }));
}

async function typeText(env, text) {
  if (typeof env.beforeInput === 'function') await env.beforeInput();
  if (env.computer && typeof env.computer.typeText === 'function') {
    await env.computer.typeText({ text });
    return;
  }
  await env.driver.typeText(text);
}

async function activeTitle(env, windowId) {
  const d = env.driver;
  if (typeof d.activeWindow === 'function') {
    try {
      const a = await d.activeWindow();
      if (a && sameWindow(a.id, windowId)) return String(a.title || '');
    } catch {
      /* fall back to the list */
    }
  }
  const w = (await listWindowsSafe(d)).find((x) => sameWindow(x.id, windowId));
  return w ? String(w.title || '') : '';
}

/** Bring the browser window to the front and make sure it is there before any key is sent. */
async function focusForKeys(env, win) {
  const d = env.driver;
  if (typeof env.beforeInput === 'function') await env.beforeInput();
  const ok = typeof d.focusWindow === 'function' ? await d.focusWindow(win.id) : false;
  const deadline = env.ctx.now() + FOCUS_WAIT_MS;
  let active = null;
  for (;;) {
    try {
      active = typeof d.activeWindow === 'function' ? await d.activeWindow() : null;
    } catch {
      active = null;
    }
    if (active && sameWindow(active.id, win.id)) return;
    if (env.ctx.now() >= deadline) break;
    await env.ctx.sleep(100);
  }
  if (!active && ok) return; // this desktop cannot tell which window is active; focusWindow said yes
  throw browserError(
    `Could not bring the ${win.app || 'browser'} window to the front, so no keys were sent.`,
    'FOCUS_FAILED',
    'Click the browser window (or call focus_window), then try again.'
  );
}

async function waitTitleChange(env, windowId, prev, ms = TITLE_WAIT_MS) {
  const deadline = env.ctx.now() + ms;
  let t = await activeTitle(env, windowId);
  while (t === prev && env.ctx.now() < deadline) {
    await env.ctx.sleep(TITLE_POLL_MS);
    t = await activeTitle(env, windowId);
  }
  return t;
}

async function goToIndex(env, win, index, count) {
  if (index === -1 || (count && index === count && index > 8)) {
    await press(env, 'primary+9');
  } else if (index >= 1 && index <= 8) {
    await press(env, `primary+${index}`);
  } else {
    await press(env, 'primary+8');
    for (let i = 8; i < index; i++) {
      await env.ctx.sleep(KEY_SETTLE_MS / 2);
      await press(env, 'ctrl+pagedown');
    }
  }
}

/**
 * Read every tab title of one window with the keyboard: tab 1, then ctrl+PageDown until the first
 * title comes back; the tab that was active is selected again and focus returns where it was.
 */
async function cycleTabs(env, win, { maxTabs = MAX_CYCLE_TABS } = {}) {
  const prevActive = typeof env.driver.activeWindow === 'function' ? await env.driver.activeWindow().catch(() => null) : null;
  await focusForKeys(env, win);
  const startTitle = await activeTitle(env, win.id);
  await press(env, 'primary+1');
  let t = await waitTitleChange(env, win.id, startTitle);
  const titles = [t];
  for (let i = 1; i < maxTabs; i++) {
    await press(env, 'ctrl+pagedown');
    const next = await waitTitleChange(env, win.id, t);
    if (next === titles[0]) break;
    titles.push(next);
    t = next;
  }
  const wasAt = titles.indexOf(startTitle) + 1 || 1;
  await goToIndex(env, win, wasAt, titles.length);
  if (prevActive && !sameWindow(prevActive.id, win.id) && typeof env.driver.focusWindow === 'function') {
    try {
      await env.driver.focusWindow(prevActive.id);
    } catch {
      /* best effort */
    }
  }
  return { titles, activeIndex: wasAt, truncated: titles.length >= maxTabs };
}

// ---------------------------------------------------------------- Linux accessibility tree (AT-SPI)

const MAX_A11Y_WINDOWS = 6;
const STRIP_BAND_PX = 140; // the tab strip sits at most this far below the window's top edge (logical px)

function lastSegment(p) {
  const s = String(p == null ? '' : p);
  const i = s.lastIndexOf('.');
  return Number(i >= 0 ? s.slice(i + 1) : s.replace(/^\D+/, '')) || 0;
}

/**
 * The tab strip of one browser window through the accessibility tree, without any input: the
 * top-most row of sibling tabs at the window's top edge. Page tabs (Jira's "For you") are siblings
 * of each other lower down, inside the page. The strip must hold a selected tab named like the
 * window title (the active tab), else this is not the strip (full screen, a browser without a tree).
 * @returns {Promise<{tabs:Array<{id:string, title:string, active:boolean}>}|null>} null: use another method
 */
async function accessibleTabs(driver, win) {
  if (!driver || typeof driver.uiFind !== 'function' || !win || win.minimized) return null;
  let found;
  try {
    found = await driver.uiFind({ windowId: win.id, role: 'tab', limit: 200 });
  } catch (err) {
    log.debug('accessibility tab listing failed:', err && err.message);
    return null;
  }
  if (!Array.isArray(found) || !found.length) return null;
  const groups = new Map();
  for (const t of found) {
    if (!t || !t.id || !t.bounds || !Number.isFinite(Number(t.bounds.y)) || t.path == null) continue;
    const p = String(t.path);
    const parent = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '';
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(t);
  }
  let strip = null;
  let stripY = Infinity;
  for (const g of groups.values()) {
    const y = Math.min(...g.map((t) => Number(t.bounds.y)));
    if (y < stripY) {
      strip = g;
      stripY = y;
    }
  }
  if (!strip || stripY - (Number(win.y) || 0) > STRIP_BAND_PX) return null;
  const tabs = strip
    .slice()
    .sort((a, b) => lastSegment(a.path) - lastSegment(b.path))
    .map((t) => ({ id: String(t.id), title: cleanTabTitle(t.name), active: Boolean(t.selected) }));
  const want = stripBrowserSuffix(win.title).toLowerCase();
  const active = tabs.filter((t) => t.active);
  const named = (t) => {
    const n = t.title.toLowerCase();
    return Boolean(n) && (n === want || want.startsWith(n) || n.startsWith(want));
  };
  if (active.length !== 1 || (want && !named(active[0]))) return null;
  return { tabs };
}

/** accessibleTabs for each browser window (front first); null when the front one cannot be read. */
async function accessibleWindows(driver, cands) {
  const out = [];
  for (const c of cands.slice(0, MAX_A11Y_WINDOWS)) {
    const a = await accessibleTabs(driver, c.window);
    if (!a) {
      if (!out.length) return null;
      out.push({ cand: c, tabs: null });
      continue;
    }
    out.push({ cand: c, tabs: a.tabs });
  }
  return out;
}

// ---------------------------------------------------------------- macOS AppleScript (JXA)

const MAC_TABS_JXA = `function run(argv) {
  var app = Application(argv[0]), kind = argv[1];
  if (!app.running()) return JSON.stringify({ running: false, windows: [] });
  var out = [], wins = app.windows();
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i], titles, urls, active = 0, name = '';
    try { name = w.name(); } catch (e) {}
    try {
      if (kind === 'safari') { titles = w.tabs.name(); urls = w.tabs.url(); active = w.currentTab().index(); }
      else { titles = w.tabs.title(); urls = w.tabs.url(); active = w.activeTabIndex(); }
    } catch (e) { continue; }
    var tabs = [];
    for (var j = 0; j < titles.length; j++) tabs.push({ title: titles[j] || '', url: (urls && urls[j]) || '' });
    out.push({ index: i + 1, title: name || '', active: active, tabs: tabs });
  }
  return JSON.stringify({ running: true, windows: out });
}`;

const MAC_SWITCH_JXA = `function run(argv) {
  var app = Application(argv[0]), kind = argv[1], match = (argv[2] || '').toLowerCase(), index = parseInt(argv[3] || '0', 10);
  if (!app.running()) return JSON.stringify({ ok: false, error: 'not_running' });
  var wins = app.windows(), pick = null, count = 0;
  for (var i = 0; i < wins.length && !pick; i++) {
    var w = wins[i], titles, urls;
    try {
      if (kind === 'safari') { titles = w.tabs.name(); urls = w.tabs.url(); } else { titles = w.tabs.title(); urls = w.tabs.url(); }
    } catch (e) { continue; }
    if (match) {
      for (var j = 0; j < titles.length; j++) {
        if (String(titles[j] || '').toLowerCase().indexOf(match) >= 0 || String((urls && urls[j]) || '').toLowerCase().indexOf(match) >= 0) { pick = { w: w, i: i, j: j, title: titles[j], url: urls[j] }; break; }
      }
    } else {
      count = titles.length;
      var k = index > 0 ? index - 1 : titles.length + index;
      if (k >= 0 && k < titles.length) pick = { w: w, i: i, j: k, title: titles[k], url: urls[k] };
      break;
    }
  }
  if (!pick) return JSON.stringify({ ok: false, error: match ? 'no_match' : 'bad_index', count: count });
  if (kind === 'safari') pick.w.currentTab = pick.w.tabs[pick.j]; else pick.w.activeTabIndex = pick.j + 1;
  try { pick.w.index = 1; } catch (e) {}
  app.activate();
  return JSON.stringify({ ok: true, window: pick.i + 1, index: pick.j + 1, title: pick.title || '', url: pick.url || '' });
}`;

const MAC_SAME_TAB_JXA = `function run(argv) {
  var app = Application(argv[0]), kind = argv[1], url = argv[2];
  if (!app.running() || app.windows.length === 0) return JSON.stringify({ ok: false, error: 'no_window' });
  var w = app.windows[0];
  if (kind === 'safari') w.currentTab.url = url; else w.activeTab.url = url;
  app.activate();
  return JSON.stringify({ ok: true });
}`;

const MAC_SAFARI_WINDOW_AS = `on run argv
  tell application "Safari"
    make new document with properties {URL:(item 1 of argv)}
    activate
  end tell
  return "{\\"ok\\":true}"
end run`;

function macAutomationHint(appName) {
  return `Allow the app running Claude to control ${appName}: System Settings › Privacy & Security › Automation.`;
}

async function runJxa(ctx, script, args, appName) {
  const r = await ctx.run('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeoutMs: 20000 });
  const err = String(r.stderr || '');
  if (r.code !== 0) {
    if (/-1743|not authori[sz]ed|not allowed/i.test(err)) {
      throw browserError(`macOS did not allow controlling ${appName}.`, 'PERMISSION', macAutomationHint(appName), { permission: 'automation' });
    }
    throw browserError(`AppleScript failed for ${appName}: ${err.trim() || `exit ${r.code}`}`, 'SCRIPT_FAILED');
  }
  try {
    return JSON.parse(String(r.stdout || '').trim());
  } catch {
    throw browserError(`AppleScript returned no result for ${appName}`, 'SCRIPT_FAILED');
  }
}

function macAppName(cand) {
  const def = BROWSER_DEFS.find((d) => d.id === cand.browser.id);
  return (cand.window && cand.window.app) || (def && def.mac && def.mac.app) || cand.browser.name;
}

function macScriptable(cand) {
  return cand.browser.engine === 'chromium' || cand.browser.id === 'safari';
}

// ---------------------------------------------------------------- Windows UI Automation

const WIN_TABS_PS = `
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  [Console]::Out.WriteLine('{"ok":false,"error":"uia_unavailable"}')
  exit 0
}
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$tabId = [System.Windows.Automation.ControlType]::TabItem.Id
$docId = [System.Windows.Automation.ControlType]::Document.Id
$selPat = [System.Windows.Automation.SelectionItemPattern]::Pattern
$invPat = [System.Windows.Automation.InvokePattern]::Pattern
function Find-Tabs($Root) {
  $found = New-Object System.Collections.Generic.List[object]
  $queue = New-Object 'System.Collections.Generic.Queue[object]'
  $queue.Enqueue([object[]]@($Root, 0))
  $seen = 0
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($queue.Count -gt 0 -and $sw.ElapsedMilliseconds -lt 4000 -and $seen -lt 5000) {
    $item = $queue.Dequeue()
    $depth = [int]$item[1]
    $child = $null
    try { $child = $walker.GetFirstChild($item[0]) } catch { $child = $null }
    while ($null -ne $child -and $seen -lt 5000) {
      $seen++
      $typeId = -1
      try { $typeId = [int]$child.Current.ControlType.Id } catch { $typeId = -1 }
      if ($typeId -eq $tabId) { $found.Add($child) }
      elseif ($typeId -ne $docId -and $typeId -ne -1 -and $depth -lt 16) { $queue.Enqueue([object[]]@($child, ($depth + 1))) }
      try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
    }
  }
  return ,$found
}
function Get-Name($El) { try { return [string]$El.Current.Name } catch { return '' } }
function Get-Selected($El) {
  $p = $null
  try { if ($El.TryGetCurrentPattern($selPat, [ref]$p)) { return [bool]$p.Current.IsSelected } } catch { }
  return $false
}
$hwnds = @($hwndCsv.Split(',') | Where-Object { $_ })
$windows = New-Object System.Collections.Generic.List[object]
$all = New-Object System.Collections.Generic.List[object]
foreach ($h in $hwnds) {
  $root = $null
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$h) } catch { $root = $null }
  if ($null -eq $root) { continue }
  $tabs = Find-Tabs $root
  $list = New-Object System.Collections.Generic.List[object]
  $i = 0
  foreach ($t in $tabs) {
    $i++
    $list.Add([ordered]@{ index = $i; title = (Get-Name $t); active = (Get-Selected $t) })
    $all.Add([object[]]@([string]$h, $i, $t))
  }
  $windows.Add([ordered]@{ hwnd = [string]$h; title = (Get-Name $root); tabs = $list.ToArray() })
}
$out = [ordered]@{ ok = $true; windows = $windows.ToArray() }
if ($mode -eq 'select') {
  $pick = $null
  if ($match) {
    foreach ($e in $all) { if ((Get-Name $e[2]).IndexOf($match, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $pick = $e; break } }
  } elseif ($hwnds.Count -gt 0) {
    $first = @($all | Where-Object { $_[0] -eq [string]$hwnds[0] })
    $k = [int]$index
    if ($k -lt 0) { $k = $first.Count + $k + 1 }
    if ($k -ge 1 -and $k -le $first.Count) { $pick = $first[$k - 1] }
  }
  if ($null -eq $pick) {
    $out.ok = $false
    $out.error = 'no_match'
  } else {
    $el = $pick[2]
    $how = ''
    $p = $null
    try { if ($el.TryGetCurrentPattern($selPat, [ref]$p)) { $p.Select(); $how = 'select' } } catch { $how = '' }
    if (-not $how) { try { if ($el.TryGetCurrentPattern($invPat, [ref]$p)) { $p.Invoke(); $how = 'invoke' } } catch { $how = '' } }
    $out.ok = [bool]$how
    if (-not $how) { $out.error = 'no_action' }
    $out.picked = [ordered]@{ hwnd = [string]$pick[0]; index = [int]$pick[1]; title = (Get-Name $el); how = $how }
  }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 6))
`;

async function winTabs(ctx, hwnds, { mode = 'list', match = '', index = 0 } = {}) {
  const script = [
    `$hwndCsv = ${apps.psValue(hwnds.filter((h) => /^\d+$/.test(String(h))).join(','))}`,
    `$mode = ${apps.psValue(mode)}`,
    `$match = ${apps.psValue(match || '')}`,
    `$index = ${apps.psValue(String(index || 0))}`,
    WIN_TABS_PS,
  ].join('\n');
  const { data, res } = await apps.runPowerShell(ctx, script, { timeoutMs: 30000 });
  if (!data) throw browserError(`UI Automation could not read the tabs: ${res.stderr.trim() || (res.timedOut ? 'timed out' : `exit ${res.code}`)}`, 'UIA_FAILED');
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const windows = arr(data.windows).map((w) => ({ hwnd: String(w.hwnd), title: String(w.title || ''), tabs: arr(w.tabs).map((t) => ({ index: Number(t.index), title: cleanTabTitle(t.title), active: Boolean(t.active) })) }));
  return { ok: data.ok !== false, error: data.error, windows, picked: data.picked };
}

// ---------------------------------------------------------------- opening URLs

const WIN_OPEN_PS = `
$result = $null
try {
  $exe = $null
  if ($direct -and (Test-Path -LiteralPath $direct)) { $exe = $direct }
  if (-not $exe) {
    $roots = @('HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths')
    foreach ($n in @($exeCsv.Split(',') | Where-Object { $_ })) {
      foreach ($r in $roots) {
        $key = $r + '\\' + $n
        if (Test-Path -LiteralPath $key) {
          $v = (Get-Item -LiteralPath $key).GetValue('')
          if ($v) {
            $v = [Environment]::ExpandEnvironmentVariables(([string]$v).Trim('"'))
            if (Test-Path -LiteralPath $v) { $exe = $v; break }
          }
        }
      }
      if ($exe) { break }
    }
  }
  if (-not $exe) {
    $bases = @($env:LOCALAPPDATA, $env:ProgramFiles, \${env:ProgramFiles(x86)}) | Where-Object { $_ }
    foreach ($rel in @($relCsv.Split('|') | Where-Object { $_ })) {
      foreach ($b in $bases) {
        $p = Join-Path $b $rel
        if (Test-Path -LiteralPath $p) { $exe = $p; break }
      }
      if ($exe) { break }
    }
  }
  if (-not $exe) {
    $result = [ordered]@{ ok = $false; error = 'not_found' }
  } else {
    if ($argLine) { Start-Process -FilePath $exe -ArgumentList $argLine } else { Start-Process -FilePath $exe }
    $result = [ordered]@{ ok = $true; exe = $exe }
  }
} catch {
  $result = [ordered]@{ ok = $false; error = $_.Exception.Message }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
`;

/** Which family a browser executable is ("chrome", "brave-browser", "firefox.exe", "Arc.app"). */
function defFromPath(p) {
  const base = path.basename(String(p)).replace(/\.(?:exe|app)$/i, '').toLowerCase();
  if (/firefox|librewolf|waterfox|floorp|zen/.test(base)) return BROWSER_DEFS.find((d) => d.id === 'firefox');
  if (/brave/.test(base)) return BROWSER_DEFS.find((d) => d.id === 'brave');
  if (/msedge|edge/.test(base)) return BROWSER_DEFS.find((d) => d.id === 'edge');
  if (/vivaldi/.test(base)) return BROWSER_DEFS.find((d) => d.id === 'vivaldi');
  if (/opera|launcher/.test(base)) return BROWSER_DEFS.find((d) => d.id === 'opera');
  if (/safari/.test(base)) return BROWSER_DEFS.find((d) => d.id === 'safari');
  if (/google.?chrome/.test(base)) return BROWSER_DEFS.find((d) => d.id === 'chrome');
  return BROWSER_DEFS.find((d) => d.id === 'chromium');
}

function looksLikePath(s) {
  return /[\\/]/.test(String(s)) && !/^[a-z]+:\/\//i.test(String(s));
}

// The executables (and macOS app names) of the browsers this module knows. browser_open with a path runs
// that program with the URL, so a path to anything else is refused (SEC-2); src/daemon/permissions.js
// KNOWN_BROWSER_EXEC must agree.
const KNOWN_BROWSER_EXEC =
  /^(chrome|google-chrome(-stable|-beta|-unstable)?|google chrome( beta| dev| canary)?|chromium(-browser)?|brave(-browser(-stable|-beta|-nightly)?)?|brave browser( beta| nightly)?|msedge|microsoft-edge(-stable|-beta|-dev)?|microsoft edge( beta| dev| canary)?|firefox(-esr)?|firefox (developer edition|nightly)|vivaldi(-stable)?|opera|safari|arc|librewolf|waterfox|floorp)$/i;

/** Whether a path names a browser's executable or app bundle (Opera's launcher.exe only in its own folder). */
function isBrowserExecutable(p) {
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  const base = (parts.pop() || '').replace(/\.(exe|app)$/i, '');
  if (base.toLowerCase() === 'launcher') return /^opera( gx)?$/i.test(parts.pop() || '');
  return KNOWN_BROWSER_EXEC.test(base);
}

/** Flags that open `url` in a family's browser: a new tab (default) or a new window. */
function openArgs(family, url, { newWindow = false } = {}) {
  if (family === 'firefox') return newWindow ? ['-new-window', url] : ['-new-tab', url];
  if (family === 'chromium') return newWindow ? ['--new-window', url] : [url];
  return [url];
}

/**
 * The command that opens a URL in a browser (pure).
 * @returns {{mode:'run'|'spawn'|'ps'|'applescript', cmd?:string, argv?:string[], ps?:object}}
 */
function openPlan(ctx, pick, url, { newWindow = false } = {}) {
  const def = pick.def;
  const family = def ? def.family : 'chromium';
  if (ctx.flavor === 'darwin') {
    if (pick.path && !/\.app\/?$/i.test(pick.path)) return { mode: 'spawn', cmd: pick.path, argv: openArgs(family, url, { newWindow }) };
    const app = pick.path || def.mac.app;
    if (family === 'safari' && newWindow) return { mode: 'applescript', script: MAC_SAFARI_WINDOW_AS, argv: [url] };
    if (newWindow) return { mode: 'run', cmd: 'open', argv: ['-n', '-a', app, '--args', ...openArgs(family, url, { newWindow: true })] };
    return { mode: 'run', cmd: 'open', argv: ['-a', app, url] };
  }
  if (ctx.flavor === 'linux') {
    const argv = openArgs(family, url, { newWindow });
    if (pick.path) return { mode: 'spawn', cmd: pick.path, argv };
    const L = def.linux || {};
    for (const e of L.exes || []) {
      const p = ctx.which(e);
      if (p) return { mode: 'spawn', cmd: p, argv };
    }
    if (L.flatpak && ctx.which('flatpak') && pick.flatpakInstalled) return { mode: 'spawn', cmd: ctx.which('flatpak'), argv: ['run', L.flatpak, ...argv] };
    return null;
  }
  const quote = (a) => require('./common').quoteWinArgv(a);
  const W = (def && def.win) || { exes: [], paths: [] };
  return {
    mode: 'ps',
    ps: { direct: pick.path || '', exes: W.exes || [], paths: W.paths || [], argLine: openArgs(family, url, { newWindow }).map(quote).join(' ') },
  };
}

async function flatpakInstalled(ctx, id) {
  const fp = ctx.which('flatpak');
  if (!fp || !id) return false;
  const r = await ctx.run(fp, ['info', id], { timeoutMs: 5000 });
  return r.code === 0;
}

const PLACEHOLDER_RE = /^(?:|new tab|neuer tab|nouvel onglet|nueva pestaña|untitled|about:blank|blank page|loading|loading…|loading\.\.\.|start page|speed dial|new private tab|private browsing|mozilla firefox|firefox|google chrome|chromium|brave|microsoft edge|vivaldi|opera|safari)$/i;

function isPlaceholderTitle(title, url) {
  const t = stripBrowserSuffix(title);
  if (PLACEHOLDER_RE.test(t)) return true;
  if (url) {
    const bare = String(url).replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
    if (t && (t === url || t === bare || bare.startsWith(t))) return true;
  }
  return false;
}

async function waitForBrowserWindow(ctx, driver, query, before, { timeoutMs = OPEN_WAIT_MS, url, signal } = {}) {
  const beforeTitles = new Map(before.map((w) => [String(w.id), String(w.title || '')]));
  const start = ctx.now();
  let candidate = null;
  const isOwn = own(ctx);
  for (;;) {
    if (signal && signal.aborted) throw browserError('The request was cancelled', 'ABORTED');
    const wins = await listWindowsSafe(driver);
    const list = linux.browserWindows(wins, query || '', { zOrdered: zOrdered(driver), exclude: isOwn });
    const fresh = list.filter((c) => !beforeTitles.has(String(c.window.id)));
    const changed = list.filter((c) => beforeTitles.has(String(c.window.id)) && beforeTitles.get(String(c.window.id)) !== String(c.window.title || ''));
    const hit = fresh[0] || changed[0];
    const elapsed = ctx.now() - start;
    if (hit) {
      candidate = hit.window;
      if (!isPlaceholderTitle(candidate.title, url) || elapsed >= timeoutMs * 0.6) return { window: candidate, settled: !isPlaceholderTitle(candidate.title, url) };
    }
    if (elapsed >= timeoutMs) {
      if (candidate) return { window: candidate, settled: false };
      return list[0] ? { window: list[0].window, settled: false, unchanged: true } : null;
    }
    await ctx.sleep(300);
  }
}

/**
 * The browser to use: a path to an executable, a name ("brave"), else the most recently used
 * open browser window, else null (the system's default browser).
 */
async function pickBrowser(ctx, browser, driver) {
  const wins = driver ? await listWindowsSafe(driver) : [];
  const isOwn = own(ctx);
  const recent = (q) => linux.browserWindows(wins, q, { zOrdered: zOrdered(driver), exclude: isOwn });
  const b = browser == null ? '' : String(browser).trim();
  if (b && looksLikePath(b)) {
    if (!exists(ctx, b)) throw browserError(`No browser at ${b}`, 'NOT_FOUND');
    if (!isBrowserExecutable(b)) {
      throw browserError(`${b} is not a browser this tool knows, so it was not started`, 'NOT_A_BROWSER', 'Name the browser instead (chrome, brave, edge, firefox, vivaldi, opera, safari, arc), or start other programs with launch_app.');
    }
    const def = defFromPath(b);
    return { def, path: b, name: def ? def.name : path.basename(b), query: '', window: null, windows: wins };
  }
  if (b) {
    const def = resolveBrowser(b);
    if (!def) throw unknownBrowser(b);
    if (!def[osKey(ctx)]) throw browserError(`${def.name} is not available on this operating system`, 'UNSUPPORTED');
    const open = recent(def.id);
    return { def, name: def.name, query: def.id, window: open[0] ? open[0].window : null, windows: wins };
  }
  const open = recent('');
  if (open.length) {
    const def = BROWSER_DEFS.find((d) => d.id === open[0].browser.id) || defFromPath(open[0].browser.name);
    return { def, name: open[0].browser.name, query: open[0].browser.id, window: open[0].window, windows: wins };
  }
  return null;
}

/**
 * Open a URL in a browser. newTab (default) opens it as a new tab of the running browser,
 * newWindow in a new window; newTab: false replaces the page in the current tab (AppleScript on
 * macOS, else the keyboard: primary+L, the URL, Enter). Waits for the browser window and focuses it.
 * @param {{browser?:string, url:string, newTab?:boolean, newWindow?:boolean, driver?:object, computer?:object,
 *   beforeInput?:Function, timeoutMs?:number, signal?:AbortSignal}} opts
 * @param {object} [deps]
 * @returns {Promise<{browser:string, url:string, how:string, window:object|null, focused:boolean, settled:boolean, notes:string[]}>}
 */
async function open(opts = {}, deps) {
  const ctx = apps.makeContext(deps);
  const { driver = null, computer = null, beforeInput, signal } = opts;
  const newWindow = Boolean(opts.newWindow);
  const newTab = opts.newTab !== false || newWindow;
  const url = normalizeUrl(opts.url);
  const pick = await pickBrowser(ctx, opts.browser, driver);
  const before = pick ? pick.windows : await listWindowsSafe(driver);
  const notes = [];
  let how;
  if (!pick) {
    const openTarget = ctx.openTarget || ((t, o) => require('./common').openTarget(t, o));
    const r = await openTarget(url, { kind: 'url' });
    how = `default browser (${r.how})`;
  } else if (!newTab && pick.window) {
    how = await openInCurrentTab(ctx, { driver, computer, beforeInput, ctx }, pick, url);
  } else {
    if (!newTab && !pick.window) notes.push(`No ${pick.name} window was open, so the page opened in a new window.`);
    if (ctx.flavor === 'linux' && pick.def && pick.def.linux && pick.def.linux.flatpak && !pick.path) pick.flatpakInstalled = await flatpakInstalled(ctx, pick.def.linux.flatpak);
    how = await runOpenPlan(ctx, pick, url, { newWindow });
  }
  const result = { browser: pick ? pick.name : 'default browser', url, how, window: null, focused: false, settled: false, notes };
  if (!driver) return result;
  const hit = await waitForBrowserWindow(ctx, driver, pick ? pick.query : '', before, { timeoutMs: opts.timeoutMs || OPEN_WAIT_MS, url, signal });
  if (hit) {
    result.window = hit.window;
    result.settled = hit.settled;
    if (hit.unchanged) notes.push('No browser window changed yet; the page may still be loading.');
    if (typeof driver.focusWindow === 'function') {
      try {
        result.focused = Boolean(await driver.focusWindow(hit.window.id));
      } catch {
        result.focused = false;
      }
    }
  }
  return result;
}

async function runOpenPlan(ctx, pick, url, { newWindow }) {
  const plan = openPlan(ctx, pick, url, { newWindow });
  if (!plan) {
    throw browserError(
      `${pick.name} does not seem to be installed (no ${((pick.def.linux && pick.def.linux.exes) || []).join(' / ') || 'executable'} on PATH)`,
      'NOT_FOUND',
      'Install it, pass the path to its executable as browser, or leave browser out to use the default one.'
    );
  }
  if (plan.mode === 'run') {
    const r = await ctx.run(plan.cmd, plan.argv, { timeoutMs: 20000 });
    if (r.code !== 0) {
      const msg = String(r.stderr || '').trim();
      if (/unable to find application/i.test(msg)) throw browserError(`${pick.name} is not installed`, 'NOT_FOUND', 'Leave browser out to use the default browser.');
      throw browserError(`Could not open the URL in ${pick.name}: ${msg || `exit ${r.code}`}`, 'OPEN_FAILED');
    }
    return plan.argv[0] === '-n' ? 'open -n -a (new window)' : 'open -a';
  }
  if (plan.mode === 'applescript') {
    const r = await ctx.run('osascript', ['-e', plan.script, ...plan.argv], { timeoutMs: 20000 });
    if (r.code !== 0) {
      const msg = String(r.stderr || '').trim();
      if (/-1743|not authori[sz]ed/i.test(msg)) throw browserError('macOS did not allow controlling Safari.', 'PERMISSION', macAutomationHint('Safari'), { permission: 'automation' });
      throw browserError(`Could not open a Safari window: ${msg || `exit ${r.code}`}`, 'OPEN_FAILED');
    }
    return 'AppleScript (new Safari window)';
  }
  if (plan.mode === 'spawn') {
    const r = await ctx.launch(plan.cmd, plan.argv, { waitMs: 1500 });
    if (!r.ok) {
      const why = r.error ? (r.error.code === 'ENOENT' ? `${plan.cmd} was not found` : r.error.message) : `it exited with code ${r.code}${r.signal ? ` (${r.signal})` : ''}`;
      throw browserError(`Could not start ${pick.name}: ${why}`, 'OPEN_FAILED');
    }
    return `${path.basename(plan.cmd)}${newWindow ? ' (new window)' : ''}`;
  }
  const s = plan.ps;
  const script = [
    `$direct = ${apps.psValue(s.direct)}`,
    `$exeCsv = ${apps.psValue(s.exes.join(','))}`,
    `$relCsv = ${apps.psValue(s.paths.join('|'))}`,
    `$argLine = ${apps.psValue(s.argLine)}`,
    WIN_OPEN_PS,
  ].join('\n');
  const { data, res } = await apps.runPowerShell(ctx, script, { timeoutMs: 30000 });
  if (!data || data.ok !== true) {
    if (data && data.error === 'not_found') throw browserError(`${pick.name} does not seem to be installed`, 'NOT_FOUND', 'Leave browser out to use the default browser, or pass the path to its .exe.');
    throw browserError(`Could not open the URL in ${pick.name}: ${(data && data.error) || res.stderr.trim() || (res.timedOut ? 'timed out' : `exit ${res.code}`)}`, 'OPEN_FAILED');
  }
  return `Start-Process ${path.win32.basename(String(data.exe || ''))}${newWindow ? ' (new window)' : ''}`;
}

async function openInCurrentTab(ctx, env, pick, url) {
  const w = pick.window;
  if (ctx.flavor === 'darwin' && pick.def && (pick.def.family === 'chromium' || pick.def.family === 'safari')) {
    const app = w.app || pick.def.mac.app;
    const r = await runJxa(ctx, MAC_SAME_TAB_JXA, [app, pick.def.family === 'safari' ? 'safari' : 'chromium', url], app);
    if (r && r.ok) return 'AppleScript (current tab)';
  }
  if (!env.driver) throw browserError('Opening in the current tab needs desktop control', 'UNSUPPORTED');
  await focusForKeys(env, w);
  await press(env, 'primary+l');
  await ctx.sleep(KEY_SETTLE_MS);
  await typeText(env, url);
  await ctx.sleep(KEY_SETTLE_MS / 2);
  await press(env, 'enter');
  return 'keyboard (current tab)';
}

// ---------------------------------------------------------------- tabs

/** Open windows of `browser` (any browser when unset), most recently used first. */
function browserCandidates(ctx, windows, browser, driver) {
  const raw = browser != null ? String(browser).trim() : '';
  const def = raw ? resolveBrowser(raw) : null;
  return linux.browserWindows(windows, def ? def.id : raw, { zOrdered: zOrdered(driver), exclude: own(ctx) });
}

async function focusQuietly(driver, w) {
  if (!w || !driver || typeof driver.focusWindow !== 'function') return false;
  try {
    return Boolean(await driver.focusWindow(w.id));
  } catch {
    return false;
  }
}

function noBrowserError(windows, browser, ctx) {
  const open = [...new Set(linux.browserWindows(windows, '', { exclude: own(ctx) }).map((c) => c.browser.name))];
  const what = browser ? `${browser} window` : 'browser window';
  return browserError(
    `No ${what} is open.${open.length ? ` Open browsers: ${open.join(', ')}.` : ''}`,
    'NOT_FOUND',
    browser ? `Open it with browser_open {browser: "${browser}", url: ...} or launch_app.` : 'Open one with browser_open or launch_app.'
  );
}

function titleOnlyWindows(cands) {
  return cands.map((c) => ({
    windowId: String(c.window.id),
    title: stripBrowserSuffix(c.window.title),
    minimized: Boolean(c.window.minimized),
    tabs: [{ index: null, title: stripBrowserSuffix(c.window.title), active: true }],
  }));
}

/**
 * The tabs of the user's browser (the most recently used one, or `browser`).
 * @param {{browser?:string, driver:object, computer?:object, cycle?:boolean, beforeInput?:Function}} opts
 * @param {object} [deps]
 * @returns {Promise<{browser:string, method:'applescript'|'uia'|'keyboard'|'title', windows:Array<{windowId:string|null,
 *   title:string, tabs:Array<{index:number|null, title:string, url?:string, active:boolean}>}>, note?:string, hint?:string}>}
 */
async function listTabs(opts = {}, deps) {
  const ctx = apps.makeContext(deps);
  const { driver, computer, beforeInput, cycle = false } = opts;
  if (!driver) throw browserError('Listing tabs needs desktop control', 'UNSUPPORTED');
  const windows = await listWindowsSafe(driver);
  const cands = browserCandidates(ctx, windows, opts.browser, driver);
  if (!cands.length) throw noBrowserError(windows, opts.browser, ctx);
  const first = cands[0];
  const same = cands.filter((c) => c.browser.id === first.browser.id);
  const name = first.browser.name;
  const env = { ctx, driver, computer, beforeInput };

  if (ctx.flavor === 'darwin' && macScriptable(first)) {
    const app = macAppName(first);
    try {
      const r = await runJxa(ctx, MAC_TABS_JXA, [app, first.browser.id === 'safari' ? 'safari' : 'chromium'], app);
      const used = new Set();
      const wins = (r.windows || []).map((w) => {
        const tabs = (w.tabs || []).map((t, i) => ({ index: i + 1, title: String(t.title || ''), url: t.url || undefined, active: i + 1 === Number(w.active) }));
        const activeTitle = (tabs.find((t) => t.active) || {}).title || w.title;
        const match = same.find((c) => !used.has(String(c.window.id)) && stripBrowserSuffix(c.window.title) === activeTitle);
        if (match) used.add(String(match.window.id));
        return { windowId: match ? String(match.window.id) : null, title: activeTitle || '', tabs };
      });
      return { browser: name, method: 'applescript', windows: wins };
    } catch (err) {
      if (err.code !== 'PERMISSION') throw err;
      return { browser: name, method: 'title', windows: titleOnlyWindows(same), note: 'Only the window titles could be read.', hint: err.hint };
    }
  }

  if (ctx.flavor === 'win32' || ctx.flavor === 'wsl') {
    let r = null;
    try {
      r = await winTabs(ctx, same.map((c) => String(c.window.id)));
    } catch (err) {
      log.debug('UIA tab listing failed', err && err.message);
    }
    if (r && r.windows.some((w) => w.tabs.length)) {
      const wins = r.windows.map((w) => ({ windowId: w.hwnd, title: stripBrowserSuffix(w.title), tabs: w.tabs }));
      // The address of the active tab of the front window, through the address bar (no keys).
      if (typeof driver.browserTab === 'function') {
        try {
          const t = await Promise.race([driver.browserTab({ window: first.window, windowId: first.window.id, keyboard: false }), new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
          const front = wins.find((w) => sameWindow(w.windowId, first.window.id));
          const active = front && front.tabs.find((x) => x.active);
          if (t && t.url && active) active.url = t.url;
        } catch {
          /* titles are enough */
        }
      }
      return { browser: name, method: 'uia', windows: wins };
    }
  }

  if (ctx.flavor === 'linux') {
    const a = await accessibleWindows(driver, same);
    if (a) {
      const wins = a.map(({ cand, tabs }) =>
        tabs
          ? { windowId: String(cand.window.id), title: stripBrowserSuffix(cand.window.title), minimized: Boolean(cand.window.minimized), tabs: tabs.map((t, i) => ({ index: i + 1, title: t.title, active: t.active })) }
          : titleOnlyWindows([cand])[0]
      );
      const rest = titleOnlyWindows(same.slice(a.length));
      const partial = a.some((w) => !w.tabs) || rest.length;
      return {
        browser: name,
        method: 'accessibility',
        windows: [...wins, ...rest],
        note: partial ? 'Windows without numbered tabs show only their active tab.' : undefined,
      };
    }
  }

  if (cycle) {
    const c = await cycleTabs(env, first.window);
    const wins = [
      { windowId: String(first.window.id), title: c.titles[c.activeIndex - 1] ? stripBrowserSuffix(c.titles[c.activeIndex - 1]) : '', tabs: c.titles.map((t, i) => ({ index: i + 1, title: stripBrowserSuffix(t), active: i + 1 === c.activeIndex })) },
      ...titleOnlyWindows(same.slice(1)),
    ];
    const note = [
      `Read ${c.titles.length} tab title${c.titles.length === 1 ? '' : 's'} of the front ${name} window with the keyboard (primary+1, then ctrl+PageDown), then selected tab ${c.activeIndex} again.`,
      c.truncated ? `Stopped after ${MAX_CYCLE_TABS} tabs.` : '',
      same.length > 1 ? 'Other windows show only their active tab.' : '',
    ].filter(Boolean).join(' ');
    return { browser: name, method: 'keyboard', windows: wins, note };
  }
  return {
    browser: name,
    method: 'title',
    windows: titleOnlyWindows(same),
    note: 'Only the active tab of each window can be read without input here. Pass cycle: true to read every tab title with the keyboard, or use ui_find {role: "tab"} when the browser exposes its accessibility tree.',
  };
}

/**
 * Switch to a tab by text in its title (or URL on macOS) or by position (1-based; -1 = last).
 * @param {{browser?:string, match?:string, index?:number, driver:object, computer?:object, beforeInput?:Function}} opts
 * @param {object} [deps]
 * @returns {Promise<{browser:string, method:string, window:object|null, tab:{index:number|null, title:string, url?:string}}>}
 */
async function switchTab(opts = {}, deps) {
  const ctx = apps.makeContext(deps);
  const { driver, computer, beforeInput } = opts;
  const match = opts.match != null ? String(opts.match).trim() : '';
  const index = opts.index != null && opts.index !== '' ? Math.trunc(Number(opts.index)) : null;
  if (!match && (index == null || !Number.isFinite(index) || index === 0 || index < -1)) {
    throw browserError('Say which tab: match (text in its title) or index (1 = first, -1 = last)', 'INVALID_INPUT');
  }
  if (!driver) throw browserError('Switching tabs needs desktop control', 'UNSUPPORTED');
  const windows = await listWindowsSafe(driver);
  const cands = browserCandidates(ctx, windows, opts.browser, driver);
  if (!cands.length) throw noBrowserError(windows, opts.browser, ctx);
  const first = cands[0];
  const same = cands.filter((c) => c.browser.id === first.browser.id);
  const name = first.browser.name;
  const env = { ctx, driver, computer, beforeInput };
  const findWindow = (id) => same.find((c) => sameWindow(c.window.id, id));

  if (ctx.flavor === 'darwin' && macScriptable(first)) {
    const app = macAppName(first);
    if (typeof beforeInput === 'function') await beforeInput();
    const r = await runJxa(ctx, MAC_SWITCH_JXA, [app, first.browser.id === 'safari' ? 'safari' : 'chromium', match, String(index || 0)], app);
    if (!r.ok) {
      if (r.error === 'no_match') throw browserError(`No ${name} tab matches "${match}"`, 'NOT_FOUND', 'Call browser_tabs to see the open tabs.');
      if (r.error === 'bad_index') throw browserError(`The front ${name} window has ${r.count} tab${r.count === 1 ? '' : 's'}; there is no tab ${index}`, 'NOT_FOUND');
      throw browserError(`${name} is not running`, 'NOT_FOUND');
    }
    await ctx.sleep(250);
    const after = linux.browserWindows(await listWindowsSafe(driver), first.browser.id, { zOrdered: zOrdered(driver), exclude: own(ctx) });
    const w = (after.find((c) => stripBrowserSuffix(c.window.title) === r.title) || after[0] || {}).window || null;
    await focusQuietly(driver, w);
    return { browser: name, method: 'applescript', window: w, tab: { index: r.index, title: r.title, url: r.url || undefined } };
  }

  if (ctx.flavor === 'win32' || ctx.flavor === 'wsl') {
    let r = null;
    if (typeof beforeInput === 'function') await beforeInput();
    try {
      r = await winTabs(ctx, same.map((c) => String(c.window.id)), { mode: 'select', match, index: index || 0 });
    } catch (err) {
      log.debug('UIA tab switch failed', err && err.message);
    }
    if (r && r.windows.some((w) => w.tabs.length)) {
      if (!r.ok && r.error === 'no_match') {
        throw browserError(match ? `No ${name} tab matches "${match}"` : `The front ${name} window has no tab ${index}`, 'NOT_FOUND', 'Call browser_tabs to see the open tabs.');
      }
      if (r.ok && r.picked) {
        const c = findWindow(r.picked.hwnd);
        await focusQuietly(driver, c && c.window);
        // The window title follows the selected tab: report it as it is now.
        await ctx.sleep(150);
        const now = c ? (await listWindowsSafe(driver)).find((w) => sameWindow(w.id, c.window.id)) : null;
        return { browser: name, method: 'uia', window: now || (c ? c.window : null), tab: { index: r.picked.index, title: cleanTabTitle(r.picked.title) } };
      }
      // A tab without a select action: fall through to the keyboard.
    }
  }

  // Keyboard: first the windows whose active tab already matches (no input), then the front window.
  if (match) {
    const already = same.find((c) => stripBrowserSuffix(c.window.title).toLowerCase().includes(match.toLowerCase()));
    if (already) {
      if (typeof beforeInput === 'function') await beforeInput();
      if (typeof driver.focusWindow === 'function') await driver.focusWindow(already.window.id);
      return { browser: name, method: 'title', window: already.window, tab: { index: null, title: stripBrowserSuffix(already.window.title) } };
    }
  }

  // Linux: the tab strip through the accessibility tree (every tab, even ones with the same title).
  if (ctx.flavor === 'linux') {
    const a = await accessibleWindows(driver, same);
    if (a) {
      let pick = null;
      if (match) {
        const want = match.toLowerCase();
        for (const w of a) {
          const i = (w.tabs || []).findIndex((t) => t.title.toLowerCase().includes(want));
          if (i >= 0) {
            pick = { w, i };
            break;
          }
        }
      } else {
        const tabs = a[0].tabs;
        const i = index === -1 ? tabs.length - 1 : index - 1;
        if (i < 0 || i >= tabs.length) throw browserError(`The front ${name} window has ${tabs.length} tab${tabs.length === 1 ? '' : 's'}; there is no tab ${index}`, 'NOT_FOUND');
        pick = { w: a[0], i };
      }
      const complete = a.length === same.length && a.every((w) => w.tabs);
      if (!pick && complete) {
        throw browserError(`No ${name} tab matches "${match}"`, 'NOT_FOUND', 'Call browser_tabs to see the open tabs, or open the page with browser_open.');
      }
      if (pick) {
        const tab = pick.w.tabs[pick.i];
        if (typeof beforeInput === 'function') await beforeInput();
        let res = null;
        try {
          res = typeof driver.uiAction === 'function' ? await driver.uiAction({ id: tab.id, action: 'press' }) : null;
        } catch (err) {
          if (err && (err.code === 'PAUSED' || err.code === 'FAILSAFE')) throw err;
          log.debug('accessibility tab press failed:', err && err.message);
        }
        if (res && res.ok) {
          const c = pick.w.cand;
          await focusQuietly(driver, c.window);
          await ctx.sleep(150);
          const now = (await listWindowsSafe(driver)).find((w) => sameWindow(w.id, c.window.id));
          return { browser: name, method: 'accessibility', window: now || c.window, tab: { index: pick.i + 1, title: tab.title } };
        }
        // No press action on this tab: the keyboard below.
      }
    }
  }

  const win = first.window;
  await focusForKeys(env, win);
  if (index != null && !match) {
    const before = await activeTitle(env, win.id);
    await goToIndex(env, win, index);
    const t = await waitTitleChange(env, win.id, before);
    return { browser: name, method: 'keyboard', window: { ...win, title: t || win.title }, tab: { index, title: stripBrowserSuffix(t) } };
  }
  const want = match.toLowerCase();
  const start = await activeTitle(env, win.id);
  let t = start;
  for (let i = 1; i < MAX_CYCLE_TABS; i++) {
    await press(env, 'ctrl+pagedown');
    t = await waitTitleChange(env, win.id, t);
    if (stripBrowserSuffix(t).toLowerCase().includes(want)) {
      return { browser: name, method: 'keyboard', window: { ...win, title: t }, tab: { index: null, title: stripBrowserSuffix(t) } };
    }
    if (t === start) break;
  }
  throw browserError(
    `No tab of the front ${name} window has "${match}" in its title (went through the tabs with ctrl+PageDown and back to the start).`,
    'NOT_FOUND',
    'Call browser_tabs {cycle: true} to see the titles, or open the page with browser_open.'
  );
}

module.exports = {
  BROWSER_DEFS,
  resolveBrowser,
  bookmarks,
  open,
  listTabs,
  switchTab,
  // helpers (exported for tests and the tools)
  normalizeUrl,
  parseChromiumBookmarks,
  parseFirefoxRows,
  parseFirefoxBackup,
  parseFirefoxProfilesIni,
  parseSafariBookmarks,
  parseArcSidebar,
  decodeMozLz4,
  lz4Block,
  chromiumProfiles,
  chromiumDataDirs,
  stripBrowserSuffix,
  cleanTabTitle,
  isPlaceholderTitle,
  openPlan,
  openArgs,
  defFromPath,
  isBrowserExecutable,
  winTabs,
  FIREFOX_SQL,
  MAC_TABS_JXA,
  MAC_SWITCH_JXA,
  MAC_SAME_TAB_JXA,
  MAC_SAFARI_WINDOW_AS,
  WIN_TABS_PS,
  WIN_OPEN_PS,
};
