'use strict';

// Browsers (src/os/browsers.js): bookmarks of Chromium-family profiles, Firefox (sqlite3 rows and
// jsonlz4 backups), Safari and Arc from fixtures; URL normalization; open/tab command construction
// through injected runners; keyboard tab cycling and switching on the mock driver; and the MCP tools
// browser_bookmarks, browser_open, browser_tabs, browser_switch_tab. No display needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const browsers = require('../src/os/browsers');
const osIndex = require('../src/os/index');
const { Computer } = require('../src/os/computer');
const desktopTools = require('../src/mcp/tools-desktop');

const tmpRoots = [];
function tmpdir(prefix = 'anywhere-browsers-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
}

function fakeClock() {
  const c = { t: 1000 };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.t += ms;
  };
  return c;
}

function decodePs(args) {
  const i = args.indexOf('-EncodedCommand');
  return Buffer.from(args[i + 1], 'base64').toString('utf16le');
}

function psVar(script, name) {
  const m = new RegExp(`\\$${name} = \\(\\[System\\.Text\\.Encoding\\]::UTF8\\.GetString\\(\\[System\\.Convert\\]::FromBase64String\\('([^']*)'\\)\\)\\)`).exec(script);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
}

// ---------------------------------------------------------------------------
// Chromium bookmarks and profiles
// ---------------------------------------------------------------------------

function chromiumBookmarks(bar, other = [], synced = []) {
  return {
    checksum: 'x',
    roots: {
      bookmark_bar: { name: 'Bookmarks bar', type: 'folder', children: bar },
      other: { name: 'Other bookmarks', type: 'folder', children: other },
      synced: { name: 'Mobile bookmarks', type: 'folder', children: synced },
    },
    version: 1,
  };
}

const url = (name, u) => ({ type: 'url', name, url: u, date_added: '13300000000000000' });
const folder = (name, children) => ({ type: 'folder', name, children });

test('parseChromiumBookmarks: bookmarks bar first, folders as paths, bar positions', () => {
  const data = chromiumBookmarks(
    [url('Jira', 'https://acme.atlassian.net/jira/for-you'), folder('Work', [url('CI', 'https://ci.acme.dev'), folder('Docs', [url('API', 'https://api.acme.dev')])]), url('Mail', 'https://mail.google.com')],
    [url('Recipes', 'https://food.example')],
    [url('Phone link', 'https://m.example')]
  );
  const list = browsers.parseChromiumBookmarks(`\ufeff${JSON.stringify(data)}`, { browser: 'Brave', profile: 'Work' });
  assert.deepEqual(
    list.map((b) => [b.folder, b.title, b.bar, b.position]),
    [
      ['Bookmarks bar', 'Jira', true, 1],
      ['Bookmarks bar/Work', 'CI', true, 0],
      ['Bookmarks bar/Work/Docs', 'API', true, 0],
      ['Bookmarks bar', 'Mail', true, 3],
      ['Other bookmarks', 'Recipes', false, 1],
      ['Mobile bookmarks', 'Phone link', false, 1],
    ]
  );
  assert.equal(list[0].browser, 'Brave');
  assert.equal(list[0].profile, 'Work');
});

function linuxHome() {
  const home = tmpdir('anywhere-home-');
  const brave = path.join(home, '.config', 'BraveSoftware', 'Brave-Browser');
  write(path.join(brave, 'Local State'), {
    profile: {
      info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work', user_name: 'me@acme.dev' }, 'System Profile': { name: 'System' } },
      last_used: 'Profile 1',
    },
  });
  write(path.join(brave, 'Default', 'Bookmarks'), chromiumBookmarks([url('YouTube', 'https://youtube.com')], [url('Jira (old)', 'https://old.atlassian.net/jira')]));
  write(path.join(brave, 'Profile 1', 'Bookmarks'), chromiumBookmarks([url('Jira', 'https://acme.atlassian.net/jira/for-you'), url('GitHub', 'https://github.com')]));
  write(path.join(brave, 'Profile 3', 'Bookmarks'), chromiumBookmarks([url('Side', 'https://side.example')]));
  write(path.join(brave, 'System Profile', 'Bookmarks'), chromiumBookmarks([url('Hidden', 'https://hidden.example')]));
  write(path.join(home, '.config', 'google-chrome', 'Default', 'Bookmarks'), chromiumBookmarks([url('Jira board', 'https://acme.atlassian.net/jira/software/projects/ABC/boards/1')]));
  write(path.join(home, '.var', 'app', 'com.brave.Browser', 'config', 'BraveSoftware', 'Brave-Browser', 'Default', 'Bookmarks'), chromiumBookmarks([url('Flatpak bookmark', 'https://flat.example')]));
  return { home, brave };
}

function linuxDeps(home, extra = {}) {
  return { platform: 'linux', isWSL: false, env: { HOME: home }, homedir: () => home, which: () => null, cache: new Map(), ...extra };
}

test('chromiumProfiles: names from Local State, the last used first, System Profile left out', () => {
  const { brave } = linuxHome();
  const ctx = require('../src/os/apps').makeContext(linuxDeps('/nowhere'));
  const list = browsers.chromiumProfiles(ctx, brave);
  assert.deepEqual(list.map((p) => [p.dir, p.name, p.lastUsed]), [['Profile 1', 'Work', true], ['Default', 'Personal', false], ['Profile 3', 'Profile 3', false]]);
  assert.equal(list[0].email, 'me@acme.dev');
  const opera = tmpdir();
  write(path.join(opera, 'Bookmarks'), chromiumBookmarks([]));
  assert.deepEqual(browsers.chromiumProfiles(ctx, opera).map((p) => p.dir), ['.'], 'Opera keeps its one profile in the data folder');
});

test('bookmarks: the Jira link in the Brave bookmarks bar, across profiles and flatpak copies', async () => {
  const { home } = linuxHome();
  const r = await browsers.bookmarks({ browser: 'brave', folder: 'bar', query: 'jira' }, linuxDeps(home));
  assert.deepEqual(r.items.map((b) => [b.profile, b.title, b.url]), [['Work', 'Jira', 'https://acme.atlassian.net/jira/for-you']]);
  assert.deepEqual(r.sources.map((s) => [s.browser, s.profile, s.count]), [
    ['Brave', 'Work', 2],
    ['Brave', 'Personal', 2],
    ['Brave', 'Profile 3', 1],
    ['Brave', 'Default (flatpak)', 1],
  ]);
  const all = await browsers.bookmarks({ query: 'jira' }, linuxDeps(home));
  assert.deepEqual(all.items.map((b) => `${b.browser}:${b.title}`), ['Google Chrome:Jira board', 'Brave:Jira', 'Brave:Jira (old)'], 'registry order without preference; title matches first');
  const preferred = await browsers.bookmarks({ query: 'jira', prefer: ['brave'] }, linuxDeps(home));
  assert.equal(preferred.items[0].browser, 'Brave', 'browsers with open windows first');
  const work = await browsers.bookmarks({ browser: 'brave', profile: 'acme.dev' }, linuxDeps(home));
  assert.deepEqual(work.items.map((b) => b.title), ['Jira', 'GitHub'], 'profile matches the email too');
  const other = await browsers.bookmarks({ browser: 'brave', folder: 'other bookmarks' }, linuxDeps(home));
  assert.deepEqual(other.items.map((b) => b.title), ['Jira (old)']);
  const limited = await browsers.bookmarks({ browser: 'brave', limit: 2 }, linuxDeps(home));
  assert.equal(limited.items.length, 2);
  assert.equal(limited.total, 6);
  await assert.rejects(browsers.bookmarks({ browser: 'netscape' }, linuxDeps(home)), (err) => err.code === 'INVALID_INPUT');
  await assert.rejects(browsers.bookmarks({ browser: 'safari' }, linuxDeps(home)), (err) => err.code === 'UNSUPPORTED');
  const none = await browsers.bookmarks({ browser: 'vivaldi' }, linuxDeps(home));
  assert.match(none.notes.join(' '), /No Vivaldi profile with bookmarks/);
});

test('bookmarks honour XDG_CONFIG_HOME and Windows LOCALAPPDATA', async () => {
  const cfg = tmpdir();
  write(path.join(cfg, 'chromium', 'Default', 'Bookmarks'), chromiumBookmarks([url('Local', 'http://localhost:3000')]));
  const r = await browsers.bookmarks({ browser: 'chromium' }, linuxDeps('/nowhere', { env: { HOME: '/nowhere', XDG_CONFIG_HOME: cfg } }));
  assert.deepEqual(r.items.map((b) => b.title), ['Local']);

  const local = tmpdir();
  write(path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks'), chromiumBookmarks([url('Teams', 'https://teams.microsoft.com')]));
  write(path.join(local, 'Packages', 'TheBrowserCompany.Arc_ttt1ap7aakyb4', 'LocalCache', 'Local', 'Arc', 'User Data', 'Default', 'Bookmarks'), chromiumBookmarks([url('Arc thing', 'https://arc.net')]));
  const winDeps = { platform: 'win32', isWSL: false, env: { USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: local, APPDATA: path.join(local, 'roaming') }, cache: new Map(), which: () => null };
  const edge = await browsers.bookmarks({ browser: 'edge' }, winDeps);
  assert.deepEqual(edge.items.map((b) => b.title), ['Teams']);
  const arc = await browsers.bookmarks({ browser: 'arc' }, winDeps);
  assert.deepEqual(arc.items.map((b) => b.title), ['Arc thing'], 'Arc lives in a Store package folder');
});

// ---------------------------------------------------------------------------
// Firefox
// ---------------------------------------------------------------------------

const PROFILES_INI = `[Install4F96D1932A9F858E]
Default=Profiles/abcd.default-release
Locked=1

[Profile1]
Name=default
IsRelative=1
Path=Profiles/xyz.default
Default=1

[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/abcd.default-release

[General]
StartWithLastProfile=1
Version=2
`;

test('parseFirefoxProfilesIni: the installation default first, relative paths resolved', () => {
  const list = browsers.parseFirefoxProfilesIni(PROFILES_INI, '/home/me/.mozilla/firefox');
  assert.deepEqual(list.map((p) => [p.name, p.path, p.isDefault]), [
    ['default-release', path.join('/home/me/.mozilla/firefox', 'Profiles', 'abcd.default-release'), true],
    ['default', path.join('/home/me/.mozilla/firefox', 'Profiles', 'xyz.default'), false],
  ]);
});

const US = '\x1f';
const RS = '\x1e';
function rows(list) {
  return list.map((r) => r.join(US)).join(RS) + RS;
}
const FIREFOX_ROWS = rows([
  [1, 0, 2, 0, 'root________', '', ''],
  [2, 1, 2, 0, 'menu________', 'menu', ''],
  [3, 1, 2, 1, 'toolbar_____', 'toolbar', ''],
  [4, 1, 2, 2, 'tags________', 'tags', ''],
  [5, 1, 2, 3, 'unfiled_____', 'unfiled', ''],
  [6, 1, 2, 4, 'mobile______', 'mobile', ''],
  [10, 3, 1, 1, 'aaaaaaaaaaaa', 'GitHub', 'https://github.com'],
  [11, 3, 1, 0, 'bbbbbbbbbbbb', 'Jira', 'https://acme.atlassian.net/jira/for-you'],
  [12, 3, 2, 2, 'cccccccccccc', 'Work', ''],
  [13, 12, 1, 0, 'dddddddddddd', 'Wiki', 'https://wiki.acme.dev'],
  [14, 3, 3, 3, 'eeeeeeeeeeee', '', ''],
  [15, 2, 1, 0, 'ffffffffffff', 'Most Visited', 'place:sort=8&maxResults=10'],
  [16, 5, 1, 0, 'gggggggggggg', 'Recipes', 'https://food.example'],
  [17, 4, 2, 0, 'hhhhhhhhhhhh', 'tagname', ''],
  [18, 17, 1, 0, 'iiiiiiiiiiii', '', 'https://tagged.example'],
]);

test('parseFirefoxRows: toolbar first in position order, folders, separators, smart folders and tags skipped', () => {
  const list = browsers.parseFirefoxRows(FIREFOX_ROWS, { browser: 'Firefox', profile: 'default-release' });
  assert.deepEqual(list.map((b) => [b.folder, b.title, b.bar]), [
    ['Bookmarks Toolbar', 'Jira', true],
    ['Bookmarks Toolbar', 'GitHub', true],
    ['Bookmarks Toolbar/Work', 'Wiki', true],
    ['Other Bookmarks', 'Recipes', false],
  ]);
});

/** A mozLz4 file holding `buf` as one literal-only LZ4 block. */
function mozlz4(buf) {
  const n = buf.length;
  const parts = [Buffer.from([(n >= 15 ? 15 : n) << 4])];
  if (n >= 15) {
    let rem = n - 15;
    while (rem >= 255) {
      parts.push(Buffer.from([255]));
      rem -= 255;
    }
    parts.push(Buffer.from([rem]));
  }
  parts.push(buf);
  const hdr = Buffer.alloc(12);
  hdr.write('mozLz40\0', 0, 'latin1');
  hdr.writeUInt32LE(n, 8);
  return Buffer.concat([hdr, ...parts]);
}

test('LZ4 blocks and mozLz4 files decode (literals and back-references)', () => {
  const block = Buffer.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00]); // "abc" then copy 9 bytes from 3 back
  assert.equal(browsers.lz4Block(block, 12).toString(), 'abcabcabcabc');
  const big = Buffer.from('x'.repeat(700) + 'tail');
  assert.equal(browsers.decodeMozLz4(mozlz4(big)).toString(), big.toString());
  assert.throws(() => browsers.decodeMozLz4(Buffer.from('nope')), /Not a mozLz4 file/);
  assert.throws(() => browsers.lz4Block(Buffer.from([0x05, 0x61]), 10), /Damaged LZ4/);
  assert.throws(() => browsers.lz4Block(Buffer.from([0x11, 0x61, 0x09, 0x00]), 10), /Damaged LZ4/, 'an offset before the start');
});

function firefoxHome() {
  const home = tmpdir('anywhere-ff-');
  const base = path.join(home, '.mozilla', 'firefox');
  write(path.join(base, 'profiles.ini'), PROFILES_INI);
  const prof = path.join(base, 'Profiles', 'abcd.default-release');
  write(path.join(prof, 'places.sqlite'), 'SQLite format 3\0fake');
  write(path.join(prof, 'places.sqlite-wal'), 'wal');
  const backup = {
    guid: 'root________',
    type: 'text/x-moz-place-container',
    children: [
      { guid: 'menu________', type: 'text/x-moz-place-container', title: 'menu', children: [{ type: 'text/x-moz-place', title: 'Menu link', uri: 'https://menu.example' }] },
      {
        guid: 'toolbar_____',
        type: 'text/x-moz-place-container',
        title: 'toolbar',
        children: [
          { type: 'text/x-moz-place', title: 'Jira', uri: 'https://acme.atlassian.net/jira/for-you' },
          { type: 'text/x-moz-place-separator' },
          { type: 'text/x-moz-place-container', title: 'Dev', children: [{ type: 'text/x-moz-place', title: 'Docs', uri: 'https://docs.example' }] },
        ],
      },
    ],
  };
  write(path.join(prof, 'bookmarkbackups', 'bookmarks-2026-10-16_10_old.jsonlz4'), mozlz4(Buffer.from(JSON.stringify({ guid: 'root________', children: [] }))));
  write(path.join(prof, 'bookmarkbackups', 'bookmarks-2026-10-17_12_abc.jsonlz4'), mozlz4(Buffer.from(JSON.stringify(backup))));
  write(path.join(base, 'Profiles', 'xyz.default', 'times.json'), '{}');
  return { home, prof };
}

test('Firefox bookmarks through a copy of places.sqlite and the sqlite3 CLI', async () => {
  const { home, prof } = firefoxHome();
  const calls = [];
  const deps = linuxDeps(home, {
    which: (n) => (n === 'sqlite3' ? '/usr/bin/sqlite3' : null),
    run: async (cmd, args) => {
      const db = args[2];
      calls.push({ cmd, args, copied: fs.existsSync(db) && fs.existsSync(`${db}-wal`) });
      return { code: 0, stdout: FIREFOX_ROWS, stderr: '' };
    },
  });
  const r = await browsers.bookmarks({ browser: 'firefox', folder: 'toolbar' }, deps);
  assert.deepEqual(r.items.map((b) => b.title), ['Jira', 'GitHub', 'Wiki']);
  assert.equal(calls.length, 1, 'only the profile with places.sqlite is queried');
  assert.equal(calls[0].cmd, '/usr/bin/sqlite3');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-batch', '-ascii']);
  assert.notEqual(calls[0].args[2], path.join(prof, 'places.sqlite'), 'a copy is read, never the live database');
  assert.equal(calls[0].copied, true, 'the WAL file is copied along');
  assert.equal(calls[0].args[3], browsers.FIREFOX_SQL);
  assert.ok(!fs.existsSync(calls[0].args[2]), 'the copy is removed afterwards');
  assert.deepEqual(r.sources.map((s) => [s.profile, s.method]), [['default-release', 'places.sqlite'], ['default', 'none']]);
});

test('Firefox bookmarks fall back to the newest jsonlz4 backup without sqlite3, with a hint', async () => {
  const { home } = firefoxHome();
  const r = await browsers.bookmarks({ browser: 'ff' }, linuxDeps(home));
  assert.deepEqual(r.items.map((b) => [b.folder, b.title]), [['Bookmarks Toolbar', 'Jira'], ['Bookmarks Toolbar/Dev', 'Docs'], ['Bookmarks Menu', 'Menu link']]);
  assert.match(r.notes.join(' '), /backup of 2026-10-17/);
  assert.match(r.hints.join(' '), /sudo apt install sqlite3/);
});

// ---------------------------------------------------------------------------
// Safari and Arc (macOS)
// ---------------------------------------------------------------------------

const SAFARI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Children</key><array>
    <dict><key>Title</key><string>History</string><key>WebBookmarkType</key><string>WebBookmarkTypeProxy</string></dict>
    <dict><key>Title</key><string>com.apple.ReadingList</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string>
      <key>Children</key><array><dict><key>URLString</key><string>https://read.example</string><key>URIDictionary</key><dict><key>title</key><string>To read</string></dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string><key>ReadingList</key><dict><key>DateAdded</key><date>2026-10-01T00:00:00Z</date></dict></dict></array></dict>
    <dict><key>Title</key><string>BookmarksMenu</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string>
      <key>Children</key><array><dict><key>URLString</key><string>https://menu.example</string><key>URIDictionary</key><dict><key>title</key><string>Menu</string></dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict></array></dict>
    <dict><key>Title</key><string>BookmarksBar</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string>
      <key>Children</key><array>
        <dict><key>URLString</key><string>https://acme.atlassian.net/jira</string><key>URIDictionary</key><dict><key>title</key><string>Jira &amp; Co</string></dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict>
        <dict><key>Title</key><string>Team</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Children</key><array>
          <dict><key>URLString</key><string>https://team.example</string><key>URIDictionary</key><dict><key>title</key><string>Team site</string></dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict>
        </array></dict>
      </array></dict>
  </array>
</dict></plist>`;

test('Safari bookmarks: Favorites first, the Reading List last, through plutil; Full Disk Access hint', async () => {
  const home = tmpdir('anywhere-mac-');
  write(path.join(home, 'Library', 'Safari', 'Bookmarks.plist'), 'bplist00binary');
  const calls = [];
  const deps = {
    platform: 'darwin',
    isWSL: false,
    env: { HOME: home },
    homedir: () => home,
    which: () => null,
    cache: new Map(),
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: SAFARI_XML, stderr: '' };
    },
  };
  const r = await browsers.bookmarks({ browser: 'safari' }, deps);
  assert.deepEqual(r.items.map((b) => [b.folder, b.title, b.bar]), [
    ['Favorites', 'Jira & Co', true],
    ['Favorites/Team', 'Team site', true],
    ['Bookmarks Menu', 'Menu', false],
    ['Reading List', 'To read', false],
  ]);
  assert.deepEqual(calls[0].slice(0, 5), ['plutil', '-convert', 'xml1', '-o', '-']);
  const denied = await browsers.bookmarks({ browser: 'safari' }, { ...deps, run: async () => ({ code: 1, stdout: '', stderr: 'Operation not permitted' }) });
  assert.equal(denied.items.length, 0);
  assert.match(denied.hints.join(' '), /Full Disk Access/);
});

test('Arc sidebar: favourites and pinned tabs with their folders; unpinned tabs are not bookmarks', () => {
  const sidebar = {
    sidebar: {
      containers: [
        { global: {} },
        {
          spaces: ['space1', { id: 'space1', title: 'Work', containerIDs: ['pinned', 'pin1', 'unpinned', 'unpin1'] }],
          topAppsContainerIDs: [{ default: true }, 'fav1'],
          items: [
            'a', { id: 'a', parentID: 'fav1', title: null, data: { tab: { savedTitle: 'Gmail', savedURL: 'https://mail.google.com' } } },
            'f', { id: 'f', parentID: 'pin1', title: 'Projects', data: { list: {} } },
            'b', { id: 'b', parentID: 'f', title: 'Jira board', data: { tab: { savedTitle: 'Board', savedURL: 'https://acme.atlassian.net/jira' } } },
            'c', { id: 'c', parentID: 'unpin1', title: null, data: { tab: { savedTitle: 'Temp', savedURL: 'https://temp.example' } } },
          ],
        },
      ],
    },
  };
  const list = browsers.parseArcSidebar(sidebar, { browser: 'Arc', profile: 'Sidebar' });
  assert.deepEqual(list.map((b) => [b.folder, b.title, b.bar]), [
    ['Favorites', 'Gmail', true],
    ['Work / Pinned/Projects', 'Jira board', false],
  ]);
});

// ---------------------------------------------------------------------------
// URLs and open commands
// ---------------------------------------------------------------------------

test('normalizeUrl adds schemes, turns paths into file URLs and refuses script URLs', () => {
  assert.equal(browsers.normalizeUrl('acme.atlassian.net/jira/for-you'), 'https://acme.atlassian.net/jira/for-you');
  assert.equal(browsers.normalizeUrl('localhost:5173/x'), 'http://localhost:5173/x');
  assert.equal(browsers.normalizeUrl('192.168.1.10:8080'), 'http://192.168.1.10:8080');
  assert.equal(browsers.normalizeUrl('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(browsers.normalizeUrl('chrome://settings'), 'chrome://settings');
  assert.equal(browsers.normalizeUrl('/tmp/page one.html'), 'file:///tmp/page%20one.html');
  assert.equal(browsers.normalizeUrl('C:\\Users\\me\\x.html'), 'file:///C:/Users/me/x.html');
  assert.throws(() => browsers.normalizeUrl('javascript:alert(1)'), (e) => e.code === 'BLOCKED');
  assert.throws(() => browsers.normalizeUrl('DATA:text/html,x'), (e) => e.code === 'BLOCKED');
  assert.throws(() => browsers.normalizeUrl('find my tickets'), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => browsers.normalizeUrl('a\nb'), (e) => e.code === 'INVALID_INPUT');
});

test('resolveBrowser and defFromPath recognise browsers by name and executable', () => {
  assert.equal(browsers.resolveBrowser('Brave Browser').id, 'brave');
  assert.equal(browsers.resolveBrowser('google chrome').id, 'chrome');
  assert.equal(browsers.resolveBrowser('ms edge').id, 'edge');
  assert.equal(browsers.resolveBrowser('ff').id, 'firefox');
  assert.equal(browsers.resolveBrowser('Opera GX').id, 'opera');
  assert.equal(browsers.resolveBrowser(''), null);
  assert.equal(browsers.resolveBrowser('lynx'), null);
  assert.equal(browsers.defFromPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome').id, 'chromium');
  assert.equal(browsers.defFromPath('C:\\Program Files\\Mozilla Firefox\\firefox.exe').id, 'firefox');
  assert.equal(browsers.defFromPath('/Applications/Brave Browser.app').id, 'brave');
});

test('openPlan: new tab, new window and executables per OS', () => {
  const apps = require('../src/os/apps');
  const def = (id) => browsers.BROWSER_DEFS.find((d) => d.id === id);
  const mac = apps.makeContext({ platform: 'darwin', isWSL: false, env: { HOME: '/Users/me' } });
  assert.deepEqual(browsers.openPlan(mac, { def: def('brave') }, 'https://x'), { mode: 'run', cmd: 'open', argv: ['-a', 'Brave Browser', 'https://x'] });
  assert.deepEqual(browsers.openPlan(mac, { def: def('chrome') }, 'https://x', { newWindow: true }).argv, ['-n', '-a', 'Google Chrome', '--args', '--new-window', 'https://x']);
  assert.deepEqual(browsers.openPlan(mac, { def: def('firefox') }, 'https://x', { newWindow: true }).argv, ['-n', '-a', 'Firefox', '--args', '-new-window', 'https://x']);
  assert.equal(browsers.openPlan(mac, { def: def('safari') }, 'https://x', { newWindow: true }).mode, 'applescript');
  const lin = apps.makeContext({ platform: 'linux', isWSL: false, env: { HOME: '/home/me' }, which: (n) => ({ 'brave-browser': '/usr/bin/brave-browser', firefox: '/usr/bin/firefox', flatpak: '/usr/bin/flatpak' })[n] || null });
  assert.deepEqual(browsers.openPlan(lin, { def: def('brave') }, 'https://x'), { mode: 'spawn', cmd: '/usr/bin/brave-browser', argv: ['https://x'] });
  assert.deepEqual(browsers.openPlan(lin, { def: def('firefox') }, 'https://x').argv, ['-new-tab', 'https://x']);
  assert.deepEqual(browsers.openPlan(lin, { def: def('chrome'), flatpakInstalled: true }, 'https://x', { newWindow: true }), { mode: 'spawn', cmd: '/usr/bin/flatpak', argv: ['run', 'com.google.Chrome', '--new-window', 'https://x'] });
  assert.equal(browsers.openPlan(lin, { def: def('vivaldi') }, 'https://x'), null, 'not installed');
  assert.deepEqual(browsers.openPlan(lin, { def: def('chromium'), path: '/opt/chrome' }, 'https://x').cmd, '/opt/chrome');
  const win = apps.makeContext({ platform: 'win32', isWSL: false, env: { USERPROFILE: 'C:\\Users\\me' } });
  assert.deepEqual(browsers.openPlan(win, { def: def('edge') }, 'https://x?a=1&b="2"', { newWindow: true }).ps, {
    direct: '',
    exes: ['msedge.exe'],
    paths: ['Microsoft\\Edge\\Application\\msedge.exe'],
    argLine: '--new-window "https://x?a=1&b=\\"2\\""',
  });
});

// ---------------------------------------------------------------------------
// open / tabs on the mock driver
// ---------------------------------------------------------------------------

function braveDriver(tabs = ['Jira', 'Inbox', 'GitHub'], active = 1, { title = (t) => `${t} - Brave` } = {}) {
  const d = osIndex.createMockDriver({
    windows: [
      { id: '0x20', app: 'Visual Studio Code', title: 'repo - Visual Studio Code', pid: 5, x: 0, y: 0, width: 800, height: 600, focused: true, minimized: false },
      { id: '0x10', app: 'Brave', title: title(tabs[active]), pid: 7, x: 0, y: 0, width: 1200, height: 800, focused: false, minimized: false },
    ],
  });
  const tab = { list: tabs.slice(), i: active };
  const win = () => d.state.windows.find((w) => w.id === '0x10');
  const sync = () => {
    win().title = title(tab.list[tab.i]);
  };
  const keys = [];
  d.keyCombo = async (k) => {
    keys.push(k.join('+'));
    const combo = k.join('+');
    const n = /^ctrl\+([1-9])$/.exec(combo);
    if (n) tab.i = n[1] === '9' ? tab.list.length - 1 : Math.min(tab.list.length - 1, Number(n[1]) - 1);
    else if (combo === 'ctrl+pagedown') tab.i = (tab.i + 1) % tab.list.length;
    sync();
  };
  d.typeText = async (t) => keys.push(`type:${t}`);
  return { d, tab, keys, win };
}

test('open: a new tab in the browser the user has, then its window is focused', async () => {
  const { d, win } = braveDriver();
  const launched = [];
  const clock = fakeClock();
  const deps = {
    platform: 'linux',
    isWSL: false,
    env: { HOME: '/nowhere' },
    now: clock.now,
    sleep: clock.sleep,
    which: (n) => (n === 'brave-browser' ? '/usr/bin/brave-browser' : null),
    launch: async (cmd, args) => {
      launched.push([cmd, ...args]);
      win().title = 'For you - Jira - Brave';
      return { ok: true, pid: 0, running: false, code: 0 };
    },
  };
  const r = await browsers.open({ url: 'acme.atlassian.net/jira/for-you', driver: d }, deps);
  assert.deepEqual(launched, [['/usr/bin/brave-browser', 'https://acme.atlassian.net/jira/for-you']]);
  assert.equal(r.browser, 'Brave');
  assert.equal(r.window.id, '0x10');
  assert.equal(r.settled, true);
  assert.equal(r.focused, true);
  assert.ok(win().focused);
  const nw = await browsers.open({ browser: 'brave', url: 'https://x.example', newWindow: true, driver: d }, deps);
  assert.deepEqual(launched[1], ['/usr/bin/brave-browser', '--new-window', 'https://x.example']);
  assert.equal(nw.window.id, '0x10');
  await assert.rejects(browsers.open({ browser: 'vivaldi', url: 'https://x', driver: d }, deps), (e) => e.code === 'NOT_FOUND');
});

test('open without any browser window uses the default browser', async () => {
  const d = osIndex.createMockDriver({ windows: [{ id: '0x1', app: 'XTerm', title: 'xterm', pid: 1, focused: true }] });
  const opened = [];
  const clock = fakeClock();
  const r = await browsers.open(
    { url: 'example.com', driver: d, timeoutMs: 1000 },
    { platform: 'linux', isWSL: false, env: { HOME: '/nowhere' }, now: clock.now, sleep: clock.sleep, which: () => null, openTarget: async (t, o) => (opened.push([t, o]), { how: 'xdg-open' }) }
  );
  assert.deepEqual(opened, [['https://example.com', { kind: 'url' }]]);
  assert.equal(r.browser, 'default browser');
  assert.equal(r.how, 'default browser (xdg-open)');
  assert.equal(r.window, null, 'no browser window showed up in the mock');
});

test('open in the current tab types the address with the guard before every key', async () => {
  const { d, keys } = braveDriver();
  let guards = 0;
  const clock = fakeClock();
  const deps = { platform: 'linux', isWSL: false, env: { HOME: '/nowhere' }, now: clock.now, sleep: clock.sleep, which: () => null };
  const r = await browsers.open({ browser: 'brave', url: 'https://acme.atlassian.net/jira', newTab: false, driver: d, beforeInput: async () => guards++, timeoutMs: 1000 }, deps);
  assert.equal(r.how, 'keyboard (current tab)');
  assert.deepEqual(keys, ['ctrl+l', 'type:https://acme.atlassian.net/jira', 'enter']);
  assert.equal(guards, 4, 'focus, ctrl+L, typing and Enter each check the guard');
});

test('open with an executable path starts it and finds the new window titled after the page', async () => {
  const exe = path.join(tmpdir(), 'chrome');
  write(exe, '#!/bin/sh\n');
  const d = osIndex.createMockDriver({ windows: [] });
  const clock = fakeClock();
  const deps = {
    platform: 'linux',
    isWSL: false,
    env: { HOME: '/nowhere' },
    now: clock.now,
    sleep: async (ms) => {
      clock.t += ms;
      if (clock.t > 2000 && !d.state.windows.length) d.state.windows.push({ id: '0x77', app: 'Chromium', title: 'about:blank - Chromium', pid: 3, x: 0, y: 0, width: 900, height: 700, focused: true, minimized: false });
      else if (clock.t > 3000 && d.state.windows.length) d.state.windows[0].title = 'Anywhere Live Page - Chromium';
    },
    which: () => null,
    launch: async () => ({ ok: true, pid: 3, running: true }),
  };
  const r = await browsers.open({ browser: exe, url: 'file:///tmp/page.html', driver: d }, deps);
  assert.equal(r.window.id, '0x77');
  assert.equal(r.window.title, 'Anywhere Live Page - Chromium');
  assert.equal(r.settled, true);
  await assert.rejects(browsers.open({ browser: '/no/such/browser', url: 'https://x', driver: d }, deps), (e) => e.code === 'NOT_FOUND');
});

test('SEC-2: a browser path that is not a browser is never started, and is judged as the program it is', async () => {
  // The reviewer's repro: browser_open {browser: <a script>} ran the script with the URL, at medium (no card in smart mode).
  const dir = tmpdir();
  const script = path.join(dir, 'not-a-browser.sh');
  const marker = path.join(dir, 'ran.txt');
  write(script, `#!/bin/sh\necho "ran with: $1" > '${marker}'\n`);
  fs.chmodSync(script, 0o755);
  let launched = 0;
  const deps = { platform: 'linux', isWSL: false, env: { HOME: '/nowhere' }, which: () => null, launch: async () => ((launched += 1), { ok: true, pid: 1, running: true }) };
  await assert.rejects(browsers.open({ browser: script, url: 'https://example.com/x' }, deps), (e) => e.code === 'NOT_A_BROWSER' && /launch_app/.test(e.hint));
  assert.equal(launched, 0);
  assert.equal(fs.existsSync(marker), false, 'the script did not run');
  for (const p of ['/usr/bin/google-chrome-stable', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', '/Applications/Brave Browser.app', 'C:\\Users\\u\\AppData\\Local\\Programs\\Opera GX\\launcher.exe']) {
    assert.equal(browsers.isBrowserExecutable(p), true, p);
  }
  for (const p of ['/home/u/proj/deploy.sh', '/usr/bin/sudo', 'C:\\Users\\u\\proj\\tool.bat', '/home/u/Downloads/evil.AppImage', '/tmp/launcher', '/home/u/.claude/hooks/x']) {
    assert.equal(browsers.isBrowserExecutable(p), false, p);
  }

  // The approval policy agrees: such a path is at least high (no card-less run in smart or auto mode).
  const { classify } = require('../src/daemon/permissions');
  const bo = (input, platform = 'linux') => classify('mcp__anywhere__browser_open', input, { platform });
  for (const [input, platform] of [
    [{ browser: '/home/u/proj/tool.sh', url: 'https://x.example/' }],
    [{ browser: '/home/u/proj/deploy', url: 'https://x.example/' }],
    [{ browser: '/home/u/Downloads/evil.AppImage', url: 'https://x.example/' }],
    [{ browser: '/usr/bin/sudo', url: 'https://x.example/' }],
    [{ browser: 'C:\\Users\\u\\proj\\tool.bat', url: 'https://x.example/' }, 'win32'],
  ]) {
    assert.ok(['high', 'critical'].includes(bo(input, platform).risk), `${JSON.stringify(input)}: ${bo(input, platform).reason}`);
  }
  assert.equal(bo({ browser: '/bin/bash', url: 'https://x' }).risk, 'high');
  // Real browsers keep the URL's own verdict.
  assert.equal(bo({ browser: '/usr/bin/google-chrome', url: 'https://x' }).risk, 'medium');
  assert.equal(bo({ browser: '/Applications/Brave Browser.app', url: 'https://x' }, 'darwin').risk, 'medium');
  assert.equal(bo({ browser: 'brave', url: 'https://x' }).risk, 'medium');
  assert.equal(bo({ browser: '/usr/bin/firefox', url: 'file:///tmp/a.sh' }).risk, 'high');
});

function kbDeps() {
  const clock = fakeClock();
  return { platform: 'linux', isWSL: false, env: { HOME: '/nowhere' }, now: clock.now, sleep: clock.sleep, which: () => null };
}

test('listTabs on Linux: window titles only, or every tab with the keyboard cycle (back to the active tab)', async () => {
  const { d, tab, keys } = braveDriver(['Jira', 'Inbox', 'GitHub', 'Docs'], 2);
  const plain = await browsers.listTabs({ driver: d }, kbDeps());
  assert.equal(plain.method, 'title');
  assert.deepEqual(plain.windows.map((w) => [w.windowId, w.tabs.map((t) => t.title)]), [['0x10', ['GitHub']]]);
  assert.equal(keys.length, 0, 'no keys without cycle');
  let guards = 0;
  const r = await browsers.listTabs({ driver: d, cycle: true, beforeInput: async () => guards++ }, kbDeps());
  assert.equal(r.method, 'keyboard');
  assert.deepEqual(r.windows[0].tabs.map((t) => [t.index, t.title, t.active]), [[1, 'Jira', false], [2, 'Inbox', false], [3, 'GitHub', true], [4, 'Docs', false]]);
  assert.equal(tab.i, 2, 'the active tab is selected again');
  assert.deepEqual(keys, ['ctrl+1', 'ctrl+pagedown', 'ctrl+pagedown', 'ctrl+pagedown', 'ctrl+pagedown', 'ctrl+3']);
  assert.equal(guards, 1 + keys.length);
  assert.ok(d.state.windows.find((w) => w.id === '0x20').focused, 'focus goes back to the window that had it');
});

test('switchTab on Linux: by text (Ctrl+PageDown until the title matches), by index, and not found', async () => {
  const { d, tab, keys } = braveDriver(['Jira', 'Inbox', 'GitHub'], 0);
  const r = await browsers.switchTab({ match: 'git', driver: d }, kbDeps());
  assert.equal(r.method, 'keyboard');
  assert.equal(r.tab.title, 'GitHub');
  assert.equal(tab.i, 2);
  assert.deepEqual(keys.splice(0), ['ctrl+pagedown', 'ctrl+pagedown']);
  const byIndex = await browsers.switchTab({ index: 2, driver: d }, kbDeps());
  assert.equal(byIndex.tab.title, 'Inbox');
  assert.deepEqual(keys.splice(0), ['ctrl+2']);
  await browsers.switchTab({ index: -1, driver: d }, kbDeps());
  assert.deepEqual(keys.splice(0), ['ctrl+9']);
  await assert.rejects(browsers.switchTab({ match: 'nothing', driver: d }, kbDeps()), (e) => e.code === 'NOT_FOUND');
  assert.equal(tab.list[tab.i], 'GitHub', 'a full cycle ends where it started');
  const already = await browsers.switchTab({ match: 'github', driver: d }, kbDeps());
  assert.equal(already.method, 'title', 'the active tab already matches: no keys');
  await assert.rejects(browsers.switchTab({ driver: d }, kbDeps()), (e) => e.code === 'INVALID_INPUT');
});

test('no keys are sent when the browser does not come to the front', async () => {
  const { d, keys } = braveDriver();
  d.focusWindow = async () => true; // claims success, but the active window never changes
  await assert.rejects(browsers.switchTab({ match: 'zzz', driver: d }, kbDeps()), (e) => e.code === 'FOCUS_FAILED');
  assert.equal(keys.length, 0);
  const none = osIndex.createMockDriver({ windows: [{ id: '0x1', app: 'Code', title: 'x', pid: 1, focused: true }] });
  await assert.rejects(browsers.listTabs({ driver: none }, kbDeps()), (e) => e.code === 'NOT_FOUND' && /No browser window is open/.test(e.message));
});

test('macOS tabs through AppleScript (JXA): all windows with URLs; a missing Automation permission falls back to titles', async () => {
  const d = osIndex.createMockDriver({ windows: [{ id: '501:1', app: 'Google Chrome', title: 'Inbox', pid: 501, x: 0, y: 0, width: 100, height: 100, focused: true, minimized: false }] });
  const calls = [];
  const out = { running: true, windows: [{ index: 1, title: 'Inbox', active: 2, tabs: [{ title: 'Jira', url: 'https://j' }, { title: 'Inbox', url: 'https://mail' }] }] };
  const deps = { platform: 'darwin', isWSL: false, env: { HOME: '/Users/me' }, which: () => null, run: async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: JSON.stringify(out), stderr: '' }) };
  const r = await browsers.listTabs({ driver: d }, deps);
  assert.equal(r.method, 'applescript');
  assert.deepEqual(r.windows, [{ windowId: '501:1', title: 'Inbox', tabs: [{ index: 1, title: 'Jira', url: 'https://j', active: false }, { index: 2, title: 'Inbox', url: 'https://mail', active: true }] }]);
  assert.deepEqual(calls[0].slice(0, 4), ['osascript', '-l', 'JavaScript', '-e']);
  assert.deepEqual(calls[0].slice(5), ['Google Chrome', 'chromium']);
  const denied = await browsers.listTabs({ driver: d }, { ...deps, run: async () => ({ code: 1, stdout: '', stderr: 'execution error: Not authorized to send Apple events to Google Chrome. (-1743)' }) });
  assert.equal(denied.method, 'title');
  assert.match(denied.hint, /Automation/);
  const switched = await browsers.switchTab({ match: 'jira', driver: d }, { ...deps, sleep: async () => {}, run: async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: JSON.stringify({ ok: true, window: 1, index: 1, title: 'Jira', url: 'https://j' }), stderr: '' }) });
  assert.equal(switched.method, 'applescript');
  assert.deepEqual(switched.tab, { index: 1, title: 'Jira', url: 'https://j' });
  assert.deepEqual(calls[calls.length - 1].slice(5), ['Google Chrome', 'chromium', 'jira', '0']);
});

test('Windows tabs through UI Automation: names cleaned, select by text then focus the window', async () => {
  const d = osIndex.createMockDriver({ windows: [{ id: '123456', app: 'Brave Browser', title: 'Jira - Brave', pid: 9, x: 0, y: 0, width: 100, height: 100, focused: true, minimized: false }] });
  const scripts = [];
  const listing = { ok: true, windows: [{ hwnd: '123456', title: 'Jira - Brave', tabs: [{ index: 1, title: 'Jira - Memory usage - 120 MB', active: true }, { index: 2, title: 'Mail - Audio playing', active: false }] }] };
  const deps = {
    platform: 'win32',
    isWSL: false,
    env: { USERPROFILE: 'C:\\Users\\me' },
    which: (n) => (n === 'powershell.exe' ? 'C:\\ps.exe' : null),
    run: async (cmd, args) => {
      const s = decodePs(args);
      scripts.push(s);
      const out = psVar(s, 'mode') === 'select' ? { ...listing, picked: { hwnd: '123456', index: 2, title: 'Mail - Audio playing', how: 'select' } } : listing;
      return { code: 0, stdout: JSON.stringify(out), stderr: '' };
    },
  };
  d.browserTab = async () => ({ url: 'https://acme.atlassian.net/jira', method: 'uia' });
  const r = await browsers.listTabs({ driver: d }, deps);
  assert.equal(r.method, 'uia');
  assert.deepEqual(r.windows[0].tabs, [{ index: 1, title: 'Jira', active: true, url: 'https://acme.atlassian.net/jira' }, { index: 2, title: 'Mail', active: false }]);
  assert.equal(psVar(scripts[0], 'hwndCsv'), '123456');
  const s = await browsers.switchTab({ match: 'mail', driver: d }, deps);
  assert.equal(s.method, 'uia');
  assert.deepEqual(s.tab, { index: 2, title: 'Mail' });
  assert.equal(psVar(scripts[1], 'mode'), 'select');
  assert.equal(psVar(scripts[1], 'match'), 'mail');
  assert.ok(d.actions.some((a) => a.type === 'focusWindow' && a.id === '123456'));
});

// ---------------------------------------------------------------------------
// Embedded scripts
// ---------------------------------------------------------------------------

const HAS_PWSH = !spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { timeout: 30000 }).error;

test('the Windows PowerShell scripts parse', { skip: !HAS_PWSH && 'pwsh is not installed' }, () => {
  for (const [name, script] of Object.entries({ WIN_TABS_PS: browsers.WIN_TABS_PS, WIN_OPEN_PS: browsers.WIN_OPEN_PS })) {
    const r = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', '$t=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$t, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }'],
      { input: script, encoding: 'utf8', timeout: 60000 }
    );
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
  }
  assert.match(browsers.WIN_OPEN_PS, /\$\{env:ProgramFiles\(x86\)\}/);
});

test('the JXA scripts are valid JavaScript', () => {
  for (const s of [browsers.MAC_TABS_JXA, browsers.MAC_SWITCH_JXA, browsers.MAC_SAME_TAB_JXA]) {
    assert.equal(typeof new Function(`${s}\nreturn run;`)(), 'function'); // eslint-disable-line no-new-func
  }
  assert.match(browsers.MAC_SAFARI_WINDOW_AS, /^on run argv/);
});

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

function toolsFor(driver, appDeps) {
  const comp = new Computer({ driver, config: { actionDelayMs: 0, failsafe: true }, platform: 'linux' });
  const activity = [];
  let guards = 0;
  const tools = Object.fromEntries(
    desktopTools
      .createTools({ getComputer: async () => comp, checkGuard: async () => guards++, postActivity: (a) => activity.push(a), desktopDeps: { appDeps } })
      .map((t) => [t.name, t])
  );
  return { tools, activity, guards: () => guards };
}

function textOf(res) {
  return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

test('browser_bookmarks tool: grouped by browser and profile, open browsers first', async () => {
  const { home } = linuxHome();
  const { d } = braveDriver();
  const { tools } = toolsFor(d, linuxDeps(home));
  const t = textOf(await tools.browser_bookmarks.handler({ query: 'jira' }));
  assert.match(
    t,
    /^3 bookmarks for "jira":\nBrave \(profile Work\):\n- \[Bookmarks bar #1\] Jira — https:\/\/acme\.atlassian\.net\/jira\/for-you\nGoogle Chrome \(profile Default\):\n- \[Bookmarks bar #1\] Jira board — \S+\nBrave \(profile Personal\):\n- \[Other bookmarks\] Jira \(old\) — https:\/\/old\.atlassian\.net\/jira\n/
  );
  assert.match(t, /Read: Brave\/Work \(2\), Brave\/Personal \(2\), Brave\/Profile 3 \(1\), Brave\/Default \(flatpak\) \(1\), Google Chrome\/Default \(1\)\./);
  const grouped = desktopTools.formatBookmarks(
    { items: [{ browser: 'A', profile: 'p', title: 'x', url: 'u1', folder: 'f', bar: false }, { browser: 'B', profile: 'p', title: 'y', url: 'u2', folder: 'f', bar: false }, { browser: 'A', profile: 'p', title: 'z', url: 'u3', folder: 'f', bar: false }], total: 3, sources: [], notes: [], hints: [] },
    {}
  );
  assert.equal(grouped.split('\n').filter((l) => l === 'A (profile p):').length, 1, 'a group header appears once');
  assert.match(t, /Open one with browser_open \{browser, url\}\./);
  const none = textOf(await tools.browser_bookmarks.handler({ browser: 'brave', query: 'zzzz' }));
  assert.match(none, /^No bookmarks found for browser brave, "zzzz"\./);
});

test('browser_open, browser_tabs and browser_switch_tab tools post activity and check the guard', async () => {
  const { d, win } = braveDriver(['Jira', 'Inbox'], 0);
  const clock = fakeClock();
  const deps = {
    platform: 'linux',
    isWSL: false,
    env: { HOME: '/nowhere' },
    now: clock.now,
    sleep: clock.sleep,
    which: (n) => (n === 'brave-browser' ? '/usr/bin/brave-browser' : null),
    launch: async () => {
      win().title = 'GitHub - Brave';
      return { ok: true, code: 0 };
    },
  };
  const { tools, activity, guards } = toolsFor(d, deps);
  const open = textOf(await tools.browser_open.handler({ url: 'github.com', browser: 'brave' }));
  assert.match(open, /^Opened https:\/\/github\.com in Brave \(brave-browser\)\. Focused Brave — "GitHub - Brave" \(id 0x10\)\./);
  assert.ok(guards() >= 1);
  const tabs = textOf(await tools.browser_tabs.handler({}));
  assert.match(tabs, /Brave tabs \(window titles only\):\nWindow 1 \(id 0x10\):\n {2}- \[active\] GitHub/);
  const bad = await tools.browser_switch_tab.handler({});
  assert.equal(bad.isError, true);
  assert.deepEqual(activity.map((a) => [a.tool, a.ok]), [['browser_open', true], ['browser_switch_tab', false]]);
});
