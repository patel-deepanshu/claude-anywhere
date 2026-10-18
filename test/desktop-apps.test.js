'use strict';

// Installed apps (src/os/apps.js): .desktop, .lnk and plist parsing, the per-OS catalogs from fixture
// folders, fuzzy matching with aliases, launch/quit command construction through injected runners,
// and the MCP tools list_apps, launch_app, quit_app, set_window, wait_for (src/mcp/tools-desktop.js)
// plus `anywhere desktop` (src/cli/desktop.js) on the mock driver. No display needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const apps = require('../src/os/apps');
const osIndex = require('../src/os/index');
const { Computer } = require('../src/os/computer');
const desktopTools = require('../src/mcp/tools-desktop');

const tmpRoots = [];
function tmpdir(prefix = 'anywhere-apps-') {
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
  fs.writeFileSync(file, content);
}

/** Decode the script of a -EncodedCommand PowerShell call. */
function decodePs(args) {
  const i = args.indexOf('-EncodedCommand');
  return Buffer.from(args[i + 1], 'base64').toString('utf16le');
}

/** The value a script assigns to $name through psString(). */
function psVar(script, name) {
  const m = new RegExp(`\\$${name} = \\(\\[System\\.Text\\.Encoding\\]::UTF8\\.GetString\\(\\[System\\.Convert\\]::FromBase64String\\('([^']*)'\\)\\)\\)`).exec(script);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
}

function fakeClock() {
  const c = { t: 1000 };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.t += ms;
  };
  return c;
}

// ---------------------------------------------------------------------------
// Linux desktop entries
// ---------------------------------------------------------------------------

const VSCODE_DESKTOP = `[Desktop Entry]
Name=Visual Studio Code
Name[de]=Visual Studio Code
GenericName=Text Editor
Comment=Code Editing. Redefined.
Exec=/usr/share/code/code --unity-launch %F
Icon=vscode
Type=Application
StartupNotify=false
StartupWMClass=Code
Categories=TextEditor;Development;IDE;
Keywords=vscode;editor\\;ide;

[Desktop Action new-empty-window]
Name=New Empty Window
Exec=/usr/share/code/code --new-window %F
`;

test('parseDesktopFile reads the main group only, with locale names, lists and escapes', () => {
  const e = apps.parseDesktopFile(VSCODE_DESKTOP);
  assert.equal(e.name, 'Visual Studio Code');
  assert.equal(e.exec, '/usr/share/code/code --unity-launch %F');
  assert.equal(e.wmClass, 'Code');
  assert.equal(e.genericName, 'Text Editor');
  assert.deepEqual(e.keywords, ['vscode', 'editor;ide']);
  assert.deepEqual(e.categories, ['TextEditor', 'Development', 'IDE']);
  assert.equal(e.type, 'Application');
  assert.equal(e.noDisplay, false);
  assert.equal(e.hidden, false);
  const hidden = apps.parseDesktopFile('[Desktop Entry]\nName=X\nExec=x\nType=Application\nNoDisplay=true\nHidden=TRUE\nTerminal=true\n');
  assert.equal(hidden.noDisplay, true);
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.terminal, true);
});

test('parseExecLine replaces field codes with the arguments', () => {
  assert.deepEqual(apps.parseExecLine('/usr/share/code/code --unity-launch %F', ['a.txt', 'b c.txt']), ['/usr/share/code/code', '--unity-launch', 'a.txt', 'b c.txt']);
  assert.deepEqual(apps.parseExecLine('firefox %u', ['https://x']), ['firefox', 'https://x']);
  assert.deepEqual(apps.parseExecLine('firefox %u', []), ['firefox']);
  assert.deepEqual(apps.parseExecLine('xterm', ['-e', 'top']), ['xterm', '-e', 'top'], 'no field code: arguments appended');
  assert.deepEqual(apps.parseExecLine('app %i --name=%c %k', [], { icon: 'appicon', name: 'App', file: '/x/app.desktop' }), ['app', '--icon', 'appicon', '--name=App', '/x/app.desktop']);
  assert.deepEqual(apps.parseExecLine('"/opt/My App/run" --flag "quoted \\"x\\"" %U', ['u1']), ['/opt/My App/run', '--flag', 'quoted "x"', 'u1']);
  assert.deepEqual(
    apps.parseExecLine('/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=brave --file-forwarding com.brave.Browser @@u %U @@', ['https://a']),
    ['/usr/bin/flatpak', 'run', '--branch=stable', '--arch=x86_64', '--command=brave', '--file-forwarding', 'com.brave.Browser', 'https://a']
  );
  assert.deepEqual(apps.parseExecLine('app %d %D %n %N %v %m 100%%'), ['app', '100%']);
});

test('execIdentity names the program behind env, flatpak and snap launchers', () => {
  assert.deepEqual(apps.execIdentity('env BAMF_DESKTOP_FILE_HINT=/x.desktop /snap/bin/chromium %U'), { execName: 'chromium' });
  assert.deepEqual(apps.execIdentity('/usr/bin/flatpak run --branch=stable --command=brave com.brave.Browser @@u %U @@'), { execName: 'browser', flatpak: 'com.brave.Browser' });
  assert.deepEqual(apps.execIdentity('snap run spotify %U'), { execName: 'spotify', snap: 'spotify' });
  assert.deepEqual(apps.execIdentity('"/opt/Figma Linux/figma-linux" %U'), { execName: 'figma-linux' });
});

function linuxFixture() {
  const root = tmpdir();
  const home = path.join(root, 'home');
  const user = path.join(home, '.local', 'share', 'applications');
  const sys = path.join(root, 'usr', 'share');
  const sysApps = path.join(sys, 'applications');
  write(path.join(sysApps, 'code.desktop'), VSCODE_DESKTOP);
  write(path.join(sysApps, 'debian-xterm.desktop'), '[Desktop Entry]\nName=XTerm\nExec=xterm\nType=Application\nStartupWMClass=XTerm\nCategories=System;TerminalEmulator;\n');
  write(path.join(sysApps, 'org.gnome.Terminal.desktop'), '[Desktop Entry]\nName=Terminal\nExec=gnome-terminal --window\nType=Application\nStartupWMClass=Gnome-terminal\n');
  write(path.join(sysApps, 'hidden-by-user.desktop'), '[Desktop Entry]\nName=Old Thing\nExec=oldthing\nType=Application\n');
  write(path.join(user, 'hidden-by-user.desktop'), '[Desktop Entry]\nName=Old Thing\nExec=oldthing\nType=Application\nHidden=true\n');
  write(path.join(sysApps, 'helper.desktop'), '[Desktop Entry]\nName=Helper\nExec=helper\nType=Application\nNoDisplay=true\n');
  write(path.join(sysApps, 'missing.desktop'), '[Desktop Entry]\nName=Missing Tool\nExec=missing-tool\nTryExec=missing-tool\nType=Application\n');
  write(path.join(sysApps, 'kde-only.desktop'), '[Desktop Entry]\nName=KDE Thing\nExec=kdething\nType=Application\nOnlyShowIn=KDE;\n');
  write(path.join(sysApps, 'link.desktop'), '[Desktop Entry]\nName=Website\nType=Link\nURL=https://x\n');
  write(path.join(sysApps, 'kde', 'dolphin.desktop'), '[Desktop Entry]\nName=Dolphin\nGenericName=File Manager\nExec=dolphin %u\nType=Application\n');
  write(path.join(user, 'figma-linux.desktop'), '[Desktop Entry]\nName=Figma Linux\nExec="/opt/Figma Linux/figma-linux" %U\nType=Application\nTerminal=false\n');
  write(path.join(user, 'htop.desktop'), '[Desktop Entry]\nName=Htop\nExec=htop\nType=Application\nTerminal=true\n');
  const deps = {
    platform: 'linux',
    isWSL: false,
    env: { HOME: home, XDG_DATA_DIRS: sys, XDG_CURRENT_DESKTOP: 'GNOME' },
    homedir: () => home,
    linuxSystemDirs: [],
    which: (n) => (['xterm', 'gnome-terminal', 'xterm-bin'].includes(n) ? `/usr/bin/${n}` : null),
    cache: new Map(),
  };
  return { root, home, user, sys, deps };
}

test('Linux catalog: user entries shadow system ones; Hidden, NoDisplay, TryExec, OnlyShowIn and non-apps are left out', async () => {
  const fx = linuxFixture();
  const r = await apps.listApps({}, fx.deps);
  const names = r.apps.map((a) => a.name);
  assert.deepEqual(names, ['Dolphin', 'Figma Linux', 'Htop', 'Terminal', 'Visual Studio Code', 'XTerm']);
  const code = r.apps.find((a) => a.name === 'Visual Studio Code');
  assert.equal(code.kind, 'desktop');
  assert.equal(code.desktopId, 'code.desktop');
  assert.equal(code.execName, 'code');
  assert.equal(code.wmClass, 'Code');
  assert.equal(code.source, 'system');
  assert.equal(r.apps.find((a) => a.name === 'Dolphin').desktopId, 'kde-dolphin.desktop', 'sub-folders become id prefixes');
  assert.equal(r.apps.find((a) => a.name === 'Figma Linux').source, 'user');
  const kde = await apps.listApps({}, { ...fx.deps, env: { ...fx.deps.env, XDG_CURRENT_DESKTOP: 'KDE' }, cache: new Map() });
  assert.ok(kde.apps.some((a) => a.name === 'KDE Thing'), 'OnlyShowIn=KDE shows on KDE');
});

test('the catalog is cached for five minutes; refresh re-reads it', async () => {
  const fx = linuxFixture();
  let reads = 0;
  const countingFs = { ...fs, readdirSync: (...a) => (reads++, fs.readdirSync(...a)) };
  const clock = fakeClock();
  const deps = { ...fx.deps, fs: countingFs, now: clock.now };
  await apps.listApps({}, deps);
  const first = reads;
  assert.ok(first > 0);
  await apps.listApps({ query: 'code' }, deps);
  assert.equal(reads, first, 'served from the cache');
  await apps.listApps({ refresh: true }, deps);
  assert.ok(reads > first, 'refresh re-reads');
  const second = reads;
  clock.t += apps.CACHE_TTL_MS + 1;
  await apps.listApps({}, deps);
  assert.ok(reads > second, 'expired after the TTL');
});

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

function cat(...names) {
  return names.map((n) => (typeof n === 'string' ? { name: n, id: n, kind: 'bundle', altNames: [], keywords: [] } : { id: n.name, kind: 'bundle', altNames: [], keywords: [], ...n }));
}

const BIG = cat(
  'Visual Studio Code', 'Xcode', 'Google Chrome', 'Chromium', 'Brave Browser', 'Figma', 'WhatsApp', 'DaVinci Resolve',
  'Adobe Premiere Pro 2024', 'Adobe Premiere Rush', 'CapCut', 'Shotcut', 'Kdenlive', 'OBS Studio', 'Slack', 'zoom.us', 'Microsoft Teams',
  'Spotify', 'Terminal', 'iTerm', 'Uninstall Spotify', 'Microsoft Edge', 'Firefox', 'Notepad++', 'Finder', 'Code - OSS'
);

function best(apps_, q, flavor = 'darwin') {
  const r = apps.matchApps(apps_, q, { flavor, limit: 3 });
  return r.length ? r[0].app.name : null;
}

test('matchApps knows everyday names and aliases', () => {
  assert.equal(best(BIG, 'vs code'), 'Visual Studio Code');
  assert.equal(best(BIG, 'VSCode'), 'Visual Studio Code');
  assert.equal(best(BIG, 'code'), 'Visual Studio Code');
  assert.equal(best(BIG, 'chrome'), 'Google Chrome');
  assert.equal(best(BIG, 'brave'), 'Brave Browser');
  assert.equal(best(BIG, 'figma'), 'Figma');
  assert.equal(best(BIG, 'whats app'), 'WhatsApp');
  assert.equal(best(BIG, 'whatsap'), 'WhatsApp', 'one typo');
  assert.equal(best(BIG, 'davinci'), 'DaVinci Resolve');
  assert.equal(best(BIG, 'davinci resolve'), 'DaVinci Resolve');
  assert.equal(best(BIG, 'premiere'), 'Adobe Premiere Pro 2024');
  assert.equal(best(BIG, 'capcut'), 'CapCut');
  assert.equal(best(BIG, 'shotcut'), 'Shotcut');
  assert.equal(best(BIG, 'kdenlive'), 'Kdenlive');
  assert.equal(best(BIG, 'obs'), 'OBS Studio');
  assert.equal(best(BIG, 'slack'), 'Slack');
  assert.equal(best(BIG, 'zoom'), 'zoom.us');
  assert.equal(best(BIG, 'teams'), 'Microsoft Teams');
  assert.equal(best(BIG, 'spotify'), 'Spotify', 'the uninstaller ranks below the app');
  assert.equal(best(BIG, 'terminal'), 'Terminal');
  assert.equal(best(BIG, 'edge'), 'Microsoft Edge');
  assert.equal(best(BIG, 'notepad++', 'win32'), 'Notepad++');
  assert.equal(best(BIG, 'file explorer'), 'Finder');
  assert.equal(best(BIG, 'the figma app'), 'Figma');
  assert.equal(best(BIG, 'photoshop'), null);
});

test('matchApps uses platform aliases and secondary names (executables, window classes, bundle ids)', () => {
  const linuxApps = cat({ name: 'GNOME Terminal', execName: 'gnome-terminal' }, { name: 'XTerm', execName: 'xterm' }, { name: 'Files', execName: 'nautilus', desktopId: 'org.gnome.Nautilus.desktop' });
  assert.equal(best(linuxApps, 'terminal', 'linux'), 'GNOME Terminal');
  assert.equal(best(linuxApps, 'xterm', 'linux'), 'XTerm');
  assert.equal(best(linuxApps, 'nautilus', 'linux'), 'Files');
  assert.equal(best(linuxApps, 'file manager', 'linux'), 'Files');
  const win = cat({ name: 'Windows Terminal' }, { name: 'Command Prompt' }, { name: 'Windows PowerShell' }, { name: 'File Explorer' });
  assert.equal(best(win, 'terminal', 'win32'), 'Windows Terminal');
  assert.equal(best(win, 'cmd', 'win32'), 'Command Prompt');
  assert.equal(best(win, 'explorer', 'wsl'), 'File Explorer');
  assert.deepEqual(apps.queryVariants('VS Code', 'darwin').slice(0, 3), ['vs code', 'visual studio code', 'code']);
});

// ---------------------------------------------------------------------------
// Property lists
// ---------------------------------------------------------------------------

const INFO_PLIST = (id, name, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- a comment -->
  <key>CFBundleIdentifier</key>
  <string>${id}</string>
  <key>CFBundleName</key>
  <string>${name}</string>
  <key>CFBundleExecutable</key>
  <string>${name.replace(/ /g, '')}</string>
  ${extra}
</dict>
</plist>`;

test('parsePlistXml reads every plist type', () => {
  const v = apps.parsePlistXml(`<?xml version="1.0"?><plist version="1.0"><dict>
    <key>s</key><string>a &amp; b &lt;c&gt; &#x263A; &#65;</string>
    <key>e</key><string/>
    <key>i</key><integer>-42</integer>
    <key>r</key><real>1.5</real>
    <key>t</key><true/>
    <key>f</key><false/>
    <key>d</key><date>2026-10-18T10:00:00Z</date>
    <key>b</key><data>aGVs
      bG8=</data>
    <key>a</key><array><string>x</string><dict/><array/></array>
    <key>n</key><dict><key>k</key><integer>1</integer></dict>
  </dict></plist>`);
  assert.equal(v.s, 'a & b <c> \u263a A');
  assert.equal(v.e, '');
  assert.equal(v.i, -42);
  assert.equal(v.r, 1.5);
  assert.equal(v.t, true);
  assert.equal(v.f, false);
  assert.equal(v.d, '2026-10-18T10:00:00Z');
  assert.equal(v.b.toString(), 'hello');
  assert.deepEqual(v.a, ['x', {}, []]);
  assert.deepEqual(v.n, { k: 1 });
  assert.throws(() => apps.parsePlistXml('{"json": true}'), /Not an XML property list/);
  assert.throws(() => apps.parsePlistXml('<plist><dict><string>x</string></dict></plist>'), /Expected <key>/);
});

test('macOS catalog: bundles in sub-folders, binary Info.plist through plutil, background agents and duplicates left out', async () => {
  const root = tmpdir();
  const A = path.join(root, 'Applications');
  const S = path.join(root, 'System', 'Applications');
  write(path.join(A, 'Figma.app', 'Contents', 'Info.plist'), INFO_PLIST('com.figma.Desktop', 'Figma'));
  write(path.join(A, 'Adobe Premiere Pro 2024', 'Adobe Premiere Pro 2024.app', 'Contents', 'Info.plist'), INFO_PLIST('com.adobe.PremierePro.24', 'Adobe Premiere Pro 2024'));
  write(path.join(A, 'Brave Browser.app', 'Contents', 'Info.plist'), Buffer.from('bplist00\x00\x01binary'));
  write(path.join(A, 'Agent.app', 'Contents', 'Info.plist'), INFO_PLIST('com.example.agent', 'Agent', '<key>LSBackgroundOnly</key><true/>'));
  write(path.join(S, 'Figma.app', 'Contents', 'Info.plist'), INFO_PLIST('com.figma.Desktop', 'Figma'));
  write(path.join(S, 'Utilities', 'Terminal.app', 'Contents', 'Info.plist'), INFO_PLIST('com.apple.Terminal', 'Terminal'));
  write(path.join(A, '.Hidden.app', 'Contents', 'Info.plist'), INFO_PLIST('x.hidden', 'Hidden'));
  const calls = [];
  const deps = {
    platform: 'darwin',
    isWSL: false,
    env: { HOME: path.join(root, 'home') },
    macAppDirs: [
      { dir: A, source: 'applications', depth: 2 },
      { dir: S, source: 'system', depth: 2 },
    ],
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'plutil') return { code: 0, stdout: INFO_PLIST('com.brave.Browser', 'Brave Browser'), stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    cache: new Map(),
  };
  const r = await apps.listApps({}, deps);
  assert.deepEqual(r.apps.map((a) => a.name), ['Adobe Premiere Pro 2024', 'Brave Browser', 'Figma', 'Terminal']);
  const brave = r.apps.find((a) => a.name === 'Brave Browser');
  assert.equal(brave.bundleId, 'com.brave.Browser');
  assert.equal(brave.execName, 'BraveBrowser');
  assert.deepEqual(calls, [['plutil', '-convert', 'xml1', '-o', '-', path.join(A, 'Brave Browser.app', 'Contents', 'Info.plist')]]);
  assert.equal(r.apps.find((a) => a.name === 'Figma').source, 'applications', '/Applications wins over a duplicate bundle id');
  const premiere = await apps.findApp('premiere', {}, deps);
  assert.equal(premiere.app.name, 'Adobe Premiere Pro 2024');
});

// ---------------------------------------------------------------------------
// Windows shortcuts (.lnk) and Store apps
// ---------------------------------------------------------------------------

const CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');

function u16z(s) {
  return Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.alloc(2)]);
}

function ansiz(s) {
  return Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(1)]);
}

function stringData(s) {
  const len = Buffer.alloc(2);
  len.writeUInt16LE(s.length);
  return Buffer.concat([len, Buffer.from(s, 'utf16le')]);
}

/** Build a shell link following MS-SHLLINK (Unicode string data). */
function makeLnk({ localBase, suffix = '', unicodePath = false, net, description, workingDir, args, envTarget, idList = false, darwin = false } = {}) {
  let flags = 0x80;
  const parts = [];
  const header = Buffer.alloc(76);
  header.writeUInt32LE(0x4c, 0);
  CLSID.copy(header, 4);
  parts.push(header);
  if (idList) {
    flags |= 0x1;
    const item = Buffer.from([0x14, 0x00, 0x1f, 0x50, ...Buffer.alloc(16)]); // one 20-byte item
    const terminal = Buffer.alloc(2);
    const size = Buffer.alloc(2);
    size.writeUInt16LE(item.length + terminal.length);
    parts.push(size, item, terminal);
  }
  if (localBase != null || net) {
    flags |= 0x2;
    const headerSize = unicodePath ? 0x24 : 0x1c;
    const fixed = Buffer.alloc(headerSize);
    const tail = [];
    let off = headerSize;
    const push = (b) => {
      const at = off;
      tail.push(b);
      off += b.length;
      return at;
    };
    let liFlags = 0;
    let volOff = 0;
    let localOff = 0;
    let netOff = 0;
    let localUOff = 0;
    if (localBase != null) {
      liFlags |= 1;
      const vol = Buffer.alloc(0x11);
      vol.writeUInt32LE(0x11, 0);
      vol.writeUInt32LE(3, 4);
      vol.writeUInt32LE(0x10, 12);
      volOff = push(vol);
      localOff = push(ansiz(unicodePath ? '?' : localBase));
    } else {
      liFlags |= 2;
      const name = ansiz(net);
      const cnrl = Buffer.alloc(0x14);
      cnrl.writeUInt32LE(0x14 + name.length, 0);
      cnrl.writeUInt32LE(0x14, 8);
      netOff = push(Buffer.concat([cnrl, name]));
    }
    const suffixOff = push(ansiz(unicodePath ? '' : suffix));
    let suffixUOff = 0;
    if (unicodePath) {
      localUOff = push(u16z(localBase));
      suffixUOff = push(u16z(suffix));
    }
    const body = Buffer.concat(tail);
    fixed.writeUInt32LE(headerSize + body.length, 0);
    fixed.writeUInt32LE(headerSize, 4);
    fixed.writeUInt32LE(liFlags, 8);
    fixed.writeUInt32LE(volOff, 12);
    fixed.writeUInt32LE(localOff, 16);
    fixed.writeUInt32LE(netOff, 20);
    fixed.writeUInt32LE(suffixOff, 24);
    if (unicodePath) {
      fixed.writeUInt32LE(localUOff, 28);
      fixed.writeUInt32LE(suffixUOff, 32);
    }
    parts.push(fixed, body);
  }
  if (description != null) {
    flags |= 0x4;
    parts.push(stringData(description));
  }
  if (workingDir != null) {
    flags |= 0x10;
    parts.push(stringData(workingDir));
  }
  if (args != null) {
    flags |= 0x20;
    parts.push(stringData(args));
  }
  if (envTarget) {
    flags |= 0x200;
    const blk = Buffer.alloc(0x314);
    blk.writeUInt32LE(0x314, 0);
    blk.writeUInt32LE(0xa0000001, 4);
    Buffer.from(envTarget, 'latin1').copy(blk, 8);
    Buffer.from(envTarget, 'utf16le').copy(blk, 8 + 260);
    parts.push(blk);
  }
  if (darwin) {
    const blk = Buffer.alloc(0x314);
    blk.writeUInt32LE(0x314, 0);
    blk.writeUInt32LE(0xa0000006, 4);
    parts.push(blk);
  }
  parts.push(Buffer.alloc(4)); // terminal block
  const out = Buffer.concat(parts);
  out.writeUInt32LE(flags, 20);
  return out;
}

test('parseLnk resolves local, Unicode, network and environment-variable targets with their arguments', () => {
  const a = apps.parseLnk(makeLnk({ localBase: 'C:\\Program Files\\', suffix: 'Slack\\slack.exe', idList: true, description: 'Slack', workingDir: 'C:\\Users\\me', args: '--startup "x y"' }));
  assert.equal(a.target, 'C:\\Program Files\\Slack\\slack.exe');
  assert.equal(a.description, 'Slack');
  assert.equal(a.workingDir, 'C:\\Users\\me');
  assert.equal(a.args, '--startup "x y"');
  const b = apps.parseLnk(makeLnk({ localBase: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\Figma\\Figma.exe', unicodePath: true }));
  assert.equal(b.target, 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\Figma\\Figma.exe');
  const c = apps.parseLnk(makeLnk({ net: '\\\\server\\share', suffix: 'tools\\app.exe' }));
  assert.equal(c.target, '\\\\server\\share\\tools\\app.exe');
  const d = apps.parseLnk(makeLnk({ envTarget: '%ProgramFiles%\\Mozilla Firefox\\firefox.exe', darwin: true }));
  assert.equal(d.target, '%ProgramFiles%\\Mozilla Firefox\\firefox.exe');
  assert.equal(d.advertised, true);
  assert.equal(apps.expandWinEnv(d.target, { programfiles: 'C:\\Program Files' }), 'C:\\Program Files\\Mozilla Firefox\\firefox.exe');
  assert.equal(apps.expandWinEnv('%Unknown%\\x', {}), '%Unknown%\\x');
  assert.throws(() => apps.parseLnk(Buffer.from('not a link at all, definitely not 76 bytes long........................................')), /Not a Windows shortcut/);
  const truncated = makeLnk({ localBase: 'C:\\x\\', suffix: 'y.exe', args: 'long arguments here' }).subarray(0, 120);
  assert.throws(() => apps.parseLnk(truncated), /Damaged shortcut|Not a Windows shortcut/);
});

function windowsFixture() {
  const root = tmpdir();
  const common = path.join(root, 'ProgramData', 'Start Menu', 'Programs');
  const user = path.join(root, 'AppData', 'Start Menu', 'Programs');
  write(path.join(common, 'Google Chrome.lnk'), makeLnk({ localBase: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', unicodePath: true, workingDir: 'C:\\Program Files\\Google\\Chrome\\Application' }));
  write(path.join(common, 'Firefox.lnk'), makeLnk({ envTarget: '%ProgramFiles%\\Mozilla Firefox\\firefox.exe' }));
  write(path.join(user, 'Slack Technologies Inc', 'Slack.lnk'), makeLnk({ localBase: 'C:\\Users\\me\\AppData\\Local\\slack\\', suffix: 'slack.exe', args: '--process-start-args --startup' }));
  write(path.join(user, 'Slack Technologies Inc', 'Uninstall Slack.lnk'), makeLnk({ localBase: 'C:\\x\\', suffix: 'unins000.exe' }));
  write(path.join(user, 'Read me.lnk'), makeLnk({ localBase: 'C:\\x\\', suffix: 'readme.txt' }));
  write(path.join(user, 'broken.lnk'), Buffer.from('garbage'));
  const psCalls = [];
  const startApps = {
    folders: { commonPrograms: common, programs: user, local: path.join(root, 'Local'), roaming: path.join(root, 'Roaming') },
    env: { ProgramFiles: 'C:\\Program Files' },
    apps: [
      { n: 'WhatsApp', u: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' },
      { n: 'Spotify', u: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
      { n: 'Google Chrome', u: 'Chrome' },
      { n: 'Notepad++', u: '{6D809377-6AF0-444B-8957-A3773F02200E}\\Notepad++\\notepad++.exe' },
      { n: 'Uninstall Thing', u: 'thing.uninstall' },
    ],
    note: '',
  };
  const deps = {
    platform: 'win32',
    isWSL: false,
    env: { USERPROFILE: 'C:\\Users\\me', SystemRoot: 'C:\\Windows' },
    which: (n) => (n === 'powershell.exe' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : null),
    run: async (cmd, args) => {
      const script = decodePs(args);
      psCalls.push(script);
      if (script.includes('Get-StartApps')) return { code: 0, stdout: `noise\r\n${JSON.stringify(startApps)}\r\n`, stderr: '' };
      if (script.includes('Invoke-Taskkill')) return { code: 0, stdout: JSON.stringify({ ok: true, found: 1, closedWindows: 1, closed: [300], killed: [], remaining: [], skipped: [] }), stderr: '' };
      if (script.includes('shell:AppsFolder')) return { code: 0, stdout: JSON.stringify({ ok: true, how: psVar(script, 'mode'), pid: 0 }), stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected script' };
    },
    cache: new Map(),
  };
  return { root, deps, psCalls };
}

test('Windows catalog: Start Menu shortcuts parsed, Store apps from Get-StartApps merged, uninstallers and documents left out', async () => {
  const fx = windowsFixture();
  const r = await apps.listApps({}, fx.deps);
  assert.deepEqual(r.apps.map((a) => a.name), ['Firefox', 'Google Chrome', 'Notepad++', 'Slack', 'Spotify', 'WhatsApp']);
  const chrome = r.apps.find((a) => a.name === 'Google Chrome');
  assert.equal(chrome.kind, 'shortcut');
  assert.equal(chrome.execName, 'chrome');
  assert.equal(chrome.aumid, 'Chrome', 'the Start apps entry of a shortcut joins it');
  const firefox = r.apps.find((a) => a.name === 'Firefox');
  assert.equal(firefox.target, 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', '%ProgramFiles% expanded');
  const slack = r.apps.find((a) => a.name === 'Slack');
  assert.equal(slack.folder, 'Slack Technologies Inc');
  assert.equal(slack.targetArgs, '--process-start-args --startup');
  assert.ok(slack.winPath.endsWith('Slack Technologies Inc\\Slack.lnk'));
  const wa = r.apps.find((a) => a.name === 'WhatsApp');
  assert.equal(wa.kind, 'store');
  assert.equal(wa.aumid, '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App');
  assert.equal(r.apps.find((a) => a.name === 'Notepad++').execName, 'notepad++');
  assert.equal(fx.psCalls.length, 1);
  assert.equal(psVar(fx.psCalls[0], 'withApps'), '1');
});

// ---------------------------------------------------------------------------
// Launch plans (command construction)
// ---------------------------------------------------------------------------

test('launchPlan builds the right command per OS', () => {
  const mac = apps.makeContext({ platform: 'darwin', isWSL: false, env: { HOME: '/Users/me' }, fs: { ...fs, existsSync: (p) => p === '/Users/me/design.fig' } });
  const figma = { name: 'Figma', kind: 'bundle', path: '/Applications/Figma.app', bundleId: 'com.figma.Desktop' };
  assert.deepEqual(apps.launchPlan(mac, figma, []).argv, ['-a', '/Applications/Figma.app']);
  assert.deepEqual(apps.launchPlan(mac, figma, ['https://figma.com/file/x', '/Users/me/design.fig', '--disable-gpu']).argv, ['-a', '/Applications/Figma.app', 'https://figma.com/file/x', '/Users/me/design.fig', '--args', '--disable-gpu']);
  assert.deepEqual(apps.launchPlan(mac, figma, [], { newInstance: true }).argv, ['-n', '-a', '/Applications/Figma.app']);
  const brave = { name: 'Brave Browser', kind: 'bundle', path: '/Applications/Brave Browser.app', bundleId: 'com.brave.Browser' };
  assert.deepEqual(apps.launchPlan(mac, brave, ['--incognito']).argv, ['-n', '-a', '/Applications/Brave Browser.app', '--args', '--incognito']);
  assert.deepEqual(apps.launchPlan(mac, brave, [], { accessibility: true }).argv, ['-n', '-a', '/Applications/Brave Browser.app', '--args', '--force-renderer-accessibility']);

  const win = apps.makeContext({ platform: 'win32', isWSL: false, env: { USERPROFILE: 'C:\\Users\\me' } });
  const store = { name: 'WhatsApp', kind: 'store', aumid: 'X!App' };
  const p1 = apps.launchPlan(win, store, ['--x']);
  assert.deepEqual(p1.ps, { mode: 'apps-folder', aumid: 'X!App' });
  assert.match(p1.note, /cannot be given command-line arguments/);
  const slack = { name: 'Slack', kind: 'shortcut', winPath: 'C:\\Start\\Slack.lnk', target: 'C:\\Users\\me\\slack.exe', targetArgs: '--startup', workingDir: 'C:\\Users\\me' };
  assert.deepEqual(apps.launchPlan(win, slack, []).ps, { mode: 'shortcut', path: 'C:\\Start\\Slack.lnk', argLine: '' });
  assert.deepEqual(apps.launchPlan(win, slack, ['C:\\a b\\x.txt']).ps, { mode: 'exe', path: 'C:\\Users\\me\\slack.exe', argLine: '--startup "C:\\a b\\x.txt"', wd: 'C:\\Users\\me' });

  const lin = apps.makeContext({ platform: 'linux', isWSL: false, env: { HOME: '/home/me' }, which: (n) => ({ 'gtk-launch': '/usr/bin/gtk-launch', code: '/usr/bin/code', xterm: '/usr/bin/xterm' })[n] || null });
  const code = { name: 'Visual Studio Code', kind: 'desktop', desktopId: 'code.desktop', exec: 'code --unity-launch %F', path: '/usr/share/applications/code.desktop' };
  assert.deepEqual(apps.launchPlan(lin, code, []), { mode: 'gtk-launch', cmd: '/usr/bin/gtk-launch', argv: ['code'] });
  const withArgs = apps.launchPlan(lin, code, ['/home/me/repo']);
  assert.equal(withArgs.mode, 'spawn');
  assert.equal(withArgs.cmd, '/usr/bin/code');
  assert.deepEqual(withArgs.argv, ['--unity-launch', '/home/me/repo']);
  const a11y = apps.launchPlan(lin, code, [], { accessibility: true });
  assert.deepEqual(a11y.argv, ['--unity-launch', '--force-renderer-accessibility']);
  assert.equal(a11y.env.ACCESSIBILITY_ENABLED, '1');
  const htop = { name: 'Htop', kind: 'desktop', desktopId: 'htop.desktop', exec: 'htop', terminal: true };
  const noGtk = apps.makeContext({ platform: 'linux', isWSL: false, env: { HOME: '/home/me' }, which: (n) => (n === 'xterm' ? '/usr/bin/xterm' : null) });
  const t = apps.launchPlan(noGtk, htop, []);
  assert.equal(t.cmd, '/usr/bin/xterm');
  assert.deepEqual(t.argv, ['-e', 'htop'], 'Terminal=true runs in a terminal emulator');
});

// ---------------------------------------------------------------------------
// launch() and quit() with injected runners and the mock driver
// ---------------------------------------------------------------------------

function xtermFixture() {
  const fx = linuxFixture();
  const clock = fakeClock();
  const launched = [];
  const driver = osIndex.createMockDriver({
    windows: [{ id: '0x100', app: 'Visual Studio Code', title: 'repo - Visual Studio Code', pid: 50, x: 0, y: 0, width: 800, height: 600, focused: true, minimized: false }],
  });
  const deps = {
    ...fx.deps,
    now: clock.now,
    sleep: clock.sleep,
    launch: async (cmd, args, opts) => {
      launched.push({ cmd, args, opts });
      if (!deps.noWindow) {
        driver.state.windows.push({ id: '0x200', app: 'XTerm', title: 'xterm', pid: 4242, x: 10, y: 10, width: 500, height: 300, focused: false, minimized: false });
      }
      return { ok: true, pid: 4242, running: true };
    },
  };
  return { fx, deps, driver, launched, clock };
}

test('launch starts the app, waits for its window and focuses it', async () => {
  const { deps, driver, launched } = xtermFixture();
  const r = await apps.launch('xterm', { driver }, deps);
  assert.equal(r.launched, true);
  assert.equal(r.app.name, 'XTerm');
  assert.deepEqual(launched.map((l) => [l.cmd, l.args]), [['/usr/bin/xterm', []]]);
  assert.equal(r.window.id, '0x200');
  assert.equal(r.matchedBy, 'pid');
  assert.equal(r.focused, true);
  assert.ok(driver.state.windows.find((w) => w.id === '0x200').focused);
});

test('launch focuses an app that already has a window instead of starting it again', async () => {
  const { deps, driver, launched } = xtermFixture();
  driver.state.windows.push({ id: '0x300', app: 'XTerm', title: 'old xterm', pid: 77, x: 0, y: 0, width: 400, height: 300, focused: false, minimized: true });
  const r = await apps.launch('XTerm', { driver }, deps);
  assert.equal(r.launched, false);
  assert.equal(r.alreadyRunning, true);
  assert.equal(r.window.id, '0x300');
  assert.equal(r.focused, true);
  assert.equal(launched.length, 0);
  const again = await apps.launch('xterm', { driver, newInstance: true }, deps);
  assert.equal(again.launched, true, 'newInstance starts another one');
  assert.equal(launched.length, 1);
});

test('launch reports a window that never appears, and unknown apps with suggestions', async () => {
  const { deps, driver } = xtermFixture();
  deps.noWindow = true;
  const r = await apps.launch('xterm', { driver, timeoutMs: 2000 }, deps);
  assert.equal(r.launched, true);
  assert.equal(r.timedOut, true);
  assert.equal(r.window, null);
  await assert.rejects(apps.launch('photoshop', { driver }, deps), (err) => err.code === 'NOT_FOUND' && /list_apps/.test(err.hint));
});

test('launch falls back from a failed gtk-launch to the Exec line', async () => {
  const fx = linuxFixture();
  const calls = [];
  const deps = {
    ...fx.deps,
    which: (n) => (n === 'gtk-launch' ? '/usr/bin/gtk-launch' : n === 'gnome-terminal' ? '/usr/bin/gnome-terminal' : null),
    launch: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return cmd.endsWith('gtk-launch') ? { ok: false, code: 2 } : { ok: true, pid: 9, running: true };
    },
  };
  const r = await apps.launch('terminal', { waitForWindow: false }, deps);
  assert.equal(r.how, 'desktop-exec');
  assert.deepEqual(calls, [['/usr/bin/gtk-launch', 'org.gnome.Terminal'], ['/usr/bin/gnome-terminal', '--window']]);
});

test('launch on Windows falls back to Start-Process lookup (PATH, App Paths) for names outside the Start menu', async () => {
  const fx = windowsFixture();
  const opened = [];
  const driver = osIndex.createMockDriver({ windows: [] });
  const r = await apps.launch('mytool', { driver, waitForWindow: false, args: ['--x'] }, { ...fx.deps, openTarget: async (t, o) => (opened.push([t, o]), { opened: true, how: 'Start-Process (path)' }) });
  assert.deepEqual(opened, [['mytool', { kind: 'app', args: ['--x'] }]]);
  assert.equal(r.how, 'Start-Process (path)');
  assert.equal(r.app.kind, 'exec');
  const close = await apps.launch('whatsap', { driver, waitForWindow: false }, { ...fx.deps, openTarget: async () => assert.fail('a close catalog match is used instead') });
  assert.equal(close.app.name, 'WhatsApp');
  assert.equal(close.how, 'shell:AppsFolder');
});

function quitFixture({ protectedPids = [process.pid], alive = [100, 200] } = {}) {
  const fx = linuxFixture();
  const clock = fakeClock();
  const driver = osIndex.createMockDriver({
    windows: [
      { id: '0xa', app: 'XTerm', title: 'one', pid: 100, x: 0, y: 0, width: 10, height: 10, focused: true, minimized: false },
      { id: '0xb', app: 'XTerm', title: 'two (unsaved)', pid: 200, x: 0, y: 0, width: 10, height: 10, focused: false, minimized: false },
      { id: '0xc', app: 'Visual Studio Code', title: 'code', pid: 300, x: 0, y: 0, width: 10, height: 10, focused: false, minimized: false },
    ],
  });
  const runs = [];
  const signals = [];
  const living = new Set(alive);
  const deps = {
    ...fx.deps,
    now: clock.now,
    sleep: clock.sleep,
    which: (n) => (n === 'wmctrl' ? '/usr/bin/wmctrl' : fx.deps.which(n)),
    run: async (cmd, args) => {
      runs.push([cmd, ...args]);
      if (cmd.endsWith('wmctrl') && args[2] === '0xa') driver.state.windows = driver.state.windows.filter((w) => w.id !== '0xa');
      return { code: 0, stdout: '', stderr: '' };
    },
    kill: (pid, sig) => {
      signals.push([pid, sig]);
      if (!living.has(pid)) {
        const e = new Error('ESRCH');
        e.code = 'ESRCH';
        throw e;
      }
      if (sig === 'SIGKILL') living.delete(pid);
    },
    fs: { ...fs, readFileSync: (p, enc) => (String(p).startsWith('/proc/') ? 'xterm\n' : fs.readFileSync(p, enc)) },
    ancestorPids: async () => protectedPids,
  };
  return { deps, driver, runs, signals, living };
}

test('quit closes the windows politely, signals windowless processes, and leaves a window asking to save', async () => {
  const { deps, driver, runs, signals } = quitFixture();
  const r = await apps.quit('xterm', { driver }, deps);
  assert.deepEqual(runs, [['/usr/bin/wmctrl', '-i', '-c', '0xa'], ['/usr/bin/wmctrl', '-i', '-c', '0xb']]);
  assert.deepEqual(signals.filter(([, s]) => s !== 0), [[100, 'SIGTERM']], 'the windowless process gets SIGTERM; the one showing a window is left alone');
  assert.equal(r.running, true);
  assert.deepEqual(r.remaining.map((x) => x.pid), [200]);
  assert.match(r.notes.join(' '), /asking to save/);
  assert.ok(!signals.some(([pid]) => pid === 300), 'other apps are untouched');
});

test('quit with force terminates, then kills what is left', async () => {
  const { deps, driver, signals } = quitFixture();
  const r = await apps.quit('xterm', { driver, force: true }, deps);
  const sent = signals.filter(([, s]) => s !== 0);
  assert.deepEqual(sent, [[100, 'SIGTERM'], [200, 'SIGTERM'], [100, 'SIGKILL'], [200, 'SIGKILL']]);
  assert.equal(r.how, 'wmctrl -c');
});

test('quit without wmctrl asks with SIGTERM and says how to close windows more gently', async () => {
  const { deps, driver, runs, signals } = quitFixture();
  deps.which = () => null;
  const r = await apps.quit('xterm', { driver }, deps);
  assert.equal(runs.length, 0);
  assert.deepEqual(signals.filter(([, s]) => s !== 0), [[100, 'SIGTERM'], [200, 'SIGTERM']]);
  assert.equal(r.how, 'SIGTERM');
  assert.match(r.notes.join(' '), /wmctrl is not installed/);
});

test('quit prefers the driver\'s own close request when it has one', async () => {
  const { deps, driver, runs } = quitFixture();
  const closed = [];
  driver.closeWindow = async (id) => {
    closed.push(id);
    driver.state.windows = driver.state.windows.filter((w) => w.id !== id);
    return true;
  };
  const r = await apps.quit('xterm', { driver }, deps);
  assert.deepEqual(closed, ['0xa', '0xb']);
  assert.equal(runs.length, 0, 'no wmctrl');
  assert.equal(r.how, 'close request');
  assert.equal(r.closedWindows, 2);
});

test('quit refuses to end the app Claude itself runs in', async () => {
  const { deps, driver, runs } = quitFixture({ protectedPids: [process.pid, 200] });
  await assert.rejects(apps.quit('xterm', { driver }, deps), (err) => err.code === 'PROTECTED' && /Claude itself runs inside it/.test(err.message));
  assert.equal(runs.length, 0);
});

test('quit on Windows passes the windows, processes and host exclusions to one PowerShell script', async () => {
  const fx = windowsFixture();
  const driver = osIndex.createMockDriver({
    windows: [{ id: '123456', app: 'WhatsApp', title: 'WhatsApp', pid: 300, process: 'WhatsApp.exe', x: 0, y: 0, width: 10, height: 10, focused: true, minimized: false }],
  });
  const r = await apps.quit('whatsapp', { driver, force: false, timeoutMs: 3000 }, { ...fx.deps, ancestorPids: async () => [1] });
  const script = fx.psCalls.find((s) => s.includes('Invoke-Taskkill'));
  assert.ok(script);
  assert.equal(psVar(script, 'hwndCsv'), '123456');
  assert.equal(psVar(script, 'pidCsv'), '300');
  assert.equal(psVar(script, 'nameCsv'), 'whatsapp');
  assert.equal(psVar(script, 'force'), '0');
  assert.ok(psVar(script, 'hostCsv').split(',').includes('explorer'));
  assert.equal(r.closedWindows, 1);
});

test('quit on macOS terminates through NSRunningApplication (JXA) with the protected processes', async () => {
  const root = tmpdir();
  write(path.join(root, 'Applications', 'Spotify.app', 'Contents', 'Info.plist'), INFO_PLIST('com.spotify.client', 'Spotify'));
  const calls = [];
  const deps = {
    platform: 'darwin',
    isWSL: false,
    env: { HOME: path.join(root, 'home') },
    macAppDirs: [{ dir: path.join(root, 'Applications'), source: 'applications', depth: 1 }],
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: JSON.stringify({ apps: [{ pid: 500, name: 'Spotify', ok: true }], skipped: [] }), stderr: '' };
    },
    ancestorPids: async () => [11, 22],
    cache: new Map(),
  };
  const r = await apps.quit('spotify', { force: true }, deps);
  assert.equal(calls.length, 1);
  const [cmd, l, js, e, , bundle, name, force, prot] = calls[0];
  assert.equal(e, '-e');
  assert.equal(cmd, 'osascript');
  assert.equal(l, '-l');
  assert.equal(js, 'JavaScript');
  assert.deepEqual([bundle, name, force, prot], ['com.spotify.client', 'Spotify', '1', '11,22']);
  assert.equal(r.how, 'forceTerminate');
  assert.deepEqual(r.signaled, [500]);
});

// ---------------------------------------------------------------------------
// Embedded scripts
// ---------------------------------------------------------------------------

function pwshParse(script) {
  const r = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', '$t=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$t, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }'],
    { input: script, encoding: 'utf8', timeout: 60000 }
  );
  return r;
}

const HAS_PWSH = !spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { timeout: 30000 }).error;

test('the PowerShell scripts parse and stay short enough for -EncodedCommand', { skip: !HAS_PWSH && 'pwsh is not installed' }, () => {
  for (const [name, script] of Object.entries({ START_APPS_PS: apps.START_APPS_PS, LAUNCH_PS: apps.LAUNCH_PS, QUIT_PS: apps.QUIT_PS })) {
    const r = pwshParse(script);
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
  }
});

test('the encoded PowerShell commands fit the Windows command-line limit', () => {
  const { psArgs } = require('../src/os/common');
  for (const script of [apps.START_APPS_PS, apps.LAUNCH_PS, apps.QUIT_PS]) {
    const encoded = psArgs(`${'$x = 1\n'.repeat(8)}${script}`).join(' ');
    assert.ok(encoded.length < 30000, `${encoded.length} chars`);
  }
});

test('the JXA quit script is valid JavaScript', () => {
  const run = new Function(`${apps.QUIT_JXA}\nreturn run;`)(); // eslint-disable-line no-new-func
  assert.equal(typeof run, 'function');
});

// ---------------------------------------------------------------------------
// MCP tools on the mock driver
// ---------------------------------------------------------------------------

function toolsFor(driver, { appDeps, guard, ocr } = {}) {
  const comp = new Computer({ driver, config: { actionDelayMs: 0, failsafe: true }, platform: 'linux' });
  const activity = [];
  const clock = fakeClock();
  const ext = {
    getComputer: async () => comp,
    checkGuard: guard || (async () => {}),
    postActivity: (a) => activity.push(a),
    desktopDeps: { appDeps, ocr, sleep: clock.sleep, now: clock.now },
  };
  const tools = Object.fromEntries(desktopTools.createTools(ext).map((t) => [t.name, t]));
  return { tools, activity, comp };
}

function textOf(res) {
  return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

test('the desktop tools have the contract names, schemas and annotations', () => {
  const list = desktopTools.createTools({});
  assert.deepEqual(list.map((t) => t.name), desktopTools.TOOL_NAMES);
  assert.deepEqual(desktopTools.TOOL_NAMES, ['list_apps', 'launch_app', 'quit_app', 'set_window', 'wait_for', 'browser_bookmarks', 'browser_open', 'browser_tabs', 'browser_switch_tab']);
  for (const t of list) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.ok(t.description.length > 80, t.name);
    assert.equal(typeof t.handler, 'function');
  }
  const by = Object.fromEntries(list.map((t) => [t.name, t]));
  assert.deepEqual(by.launch_app.inputSchema.required, ['name']);
  assert.deepEqual(by.browser_open.inputSchema.required, ['url']);
  assert.equal(by.list_apps.annotations.readOnlyHint, true);
  assert.equal(by.wait_for.annotations.readOnlyHint, true);
  assert.equal(by.browser_bookmarks.annotations.readOnlyHint, true);
  assert.equal(by.quit_app.annotations.destructiveHint, true);
  assert.ok(by.set_window.inputSchema.properties.state.enum.includes('left-half'));
});

test('list_apps and launch_app through the tools, with activity and a guard check first', async () => {
  const { deps, driver } = xtermFixture();
  let guarded = 0;
  const { tools, activity } = toolsFor(driver, { appDeps: deps, guard: async () => guarded++ });
  const list = textOf(await tools.list_apps.handler({ query: 'term' }));
  assert.match(list, /Installed apps matching "term"/);
  assert.match(list, /- Terminal/);
  const launch = await tools.launch_app.handler({ name: 'xterm' });
  assert.ok(!launch.isError);
  assert.match(textOf(launch), /Launched XTerm \(desktop-exec\) and focused its new window XTerm — "xterm" \(id 0x200/);
  assert.equal(guarded, 1);
  assert.deepEqual(activity.map((a) => [a.tool, a.ok, a.summary]), [['launch_app', true, 'Launched XTerm']]);
});

test('a paused dialog stops launch_app before anything starts', async () => {
  const { deps, driver, launched } = xtermFixture();
  const paused = async () => {
    const e = new Error('Actions are paused: the user pressed Stop.');
    e.code = 'PAUSED';
    throw e;
  };
  const { tools, activity } = toolsFor(driver, { appDeps: deps, guard: paused });
  await assert.rejects(tools.launch_app.handler({ name: 'xterm' }), (err) => err.code === 'PAUSED');
  assert.equal(launched.length, 0);
  assert.equal(activity.length, 0);
});

test('quit_app reports a polite quit that left a window open', async () => {
  const { deps, driver } = quitFixture();
  const { tools } = toolsFor(driver, { appDeps: deps });
  const t = textOf(await tools.quit_app.handler({ name: 'xterm' }));
  assert.match(t, /Asked XTerm to quit \(wmctrl -c\)\. Still open: XTerm — "two \(unsaved\)" \(id 0xb\)\./);
  assert.match(t, /force/);
});

test('set_window maximizes, snaps to a half, moves, and reports unknown windows', async () => {
  const driver = osIndex.createMockDriver();
  const { tools } = toolsFor(driver);
  assert.match(textOf(await tools.set_window.handler({ window: 'Chrome', state: 'maximize' })), /maximized\. It is now 1280x1024 at \(1920, 0\)/);
  assert.match(textOf(await tools.set_window.handler({ window: 'Terminal', state: 'right-half' })), /right half of its display\. It is now 960x1080 at \(960, 0\)/);
  assert.match(textOf(await tools.set_window.handler({ window: '0x1001', bounds: { x: 5, y: 6, width: 700, height: 500 } })), /moved to 700x500 at \(5, 6\)/);
  await assert.rejects(tools.set_window.handler({ window: 'Nothing like it', state: 'minimize' }), (err) => err.code === 'NOT_FOUND' && /Open windows:/.test(err.message));
  await assert.rejects(tools.set_window.handler({ window: 'Chrome' }), (err) => err.code === 'INVALID_INPUT');
  await assert.rejects(tools.set_window.handler({ window: 'Chrome', state: 'maximize', bounds: { x: 0, y: 0, width: 100, height: 100 } }), (err) => err.code === 'INVALID_INPUT');
  const shot = await tools.set_window.handler({ window: 'Chrome', state: 'restore', screenshotAfter: true });
  assert.ok(shot.content.some((c) => c.type === 'image'), 'screenshotAfter adds an image');
});

test('wait_for: a window that appears, one that goes away, and a timeout', async () => {
  const driver = osIndex.createMockDriver();
  const { tools } = toolsFor(driver);
  let polls = 0;
  const orig = driver.listWindows.bind(driver);
  driver.listWindows = async () => {
    polls++;
    if (polls === 3) driver.state.windows.push({ id: '0x9', app: 'Figma', title: 'Untitled – Figma', pid: 9, x: 0, y: 0, width: 800, height: 600, focused: false, minimized: false });
    return orig();
  };
  const appeared = await tools.wait_for.handler({ window: 'Figma', timeoutSec: 30 });
  assert.match(textOf(appeared), /Window Figma — "Untitled – Figma" \(id 0x9, 800x600 at \(0, 0\)\) is open/);
  driver.state.windows = driver.state.windows.filter((w) => w.id !== '0x9');
  assert.match(textOf(await tools.wait_for.handler({ window: 'Figma', gone: true, timeoutSec: 5 })), /is gone/);
  const late = await tools.wait_for.handler({ window: 'Never', timeoutSec: 1 });
  assert.equal(late.isError, true);
  assert.match(textOf(late), /Timed out after 1 s/);
  await assert.rejects(tools.wait_for.handler({}), (err) => err.code === 'INVALID_INPUT');
});

test('wait_for text uses OCR (within the window), else the accessibility tree', async () => {
  const driver = osIndex.createMockDriver();
  const seen = [];
  let n = 0;
  const ocr = {
    available: async () => ({ engine: 'tesseract', hint: null }),
    findText: async (comp, opts) => {
      seen.push(opts);
      n++;
      return n < 2 ? [] : [{ text: 'Sign in', shot: { x: 100, y: 200, width: 60, height: 20, cx: 130, cy: 210 }, confidence: 0.9, display: 1 }];
    },
  };
  const { tools } = toolsFor(driver, { ocr });
  const r = await tools.wait_for.handler({ text: 'sign in', window: 'Chrome', timeoutSec: 10 });
  assert.match(textOf(r), /Found "Sign in" in Google Chrome .* at \(130, 210\) on display 1 .*\(OCR\)\. .*click \{x: 130, y: 210, display: 1\}/);
  assert.equal(seen[0].display, 1, 'the Chrome window is on display 1');
  assert.deepEqual(seen[0].region, { x: 0, y: 0, width: 1280, height: 1000 }, 'searched within the window');

  const noOcr = toolsFor(osIndex.createMockDriver(), { ocr: null });
  const viaUi = await noOcr.tools.wait_for.handler({ text: 'For you', window: 'Chrome', timeoutSec: 3 });
  assert.match(textOf(viaUi), /Found "For you" .*accessibility tree/);
});

// ---------------------------------------------------------------------------
// anywhere desktop (CLI)
// ---------------------------------------------------------------------------

function cliHarness() {
  const out = [];
  const h = {
    spec: (extra = {}) => ({ string: extra.string || [], boolean: ['help', 'json', ...(extra.boolean || [])], multi: [], pair: [], alias: {} }),
    shared: (name) => require(path.join('..', 'src', 'shared', name)),
    requireDaemon: async () => {
      const e = new Error('not running');
      e.exitCode = 4;
      throw e;
    },
    writeOut: (s) => out.push(String(s)),
    writeErr: () => {},
    printJson: (o) => out.push(JSON.stringify(o)),
    EXIT: { OK: 0, ERROR: 1, TIMEOUT: 2 },
  };
  return { h, out };
}

test('anywhere desktop: usage errors, window arrangement and JSON output on the mock driver', async () => {
  const home = tmpdir('anywhere-cli-home-');
  const prev = { driver: process.env.ANYWHERE_DRIVER, home: process.env.ANYWHERE_HOME };
  process.env.ANYWHERE_DRIVER = 'mock';
  process.env.ANYWHERE_HOME = home;
  try {
    await osIndex.resetDriver();
    const { commands, parseBounds } = require('../src/cli/desktop');
    const { h, out } = cliHarness();
    const cmd = commands(h).desktop;
    assert.equal(cmd.group, 'Desktop control');
    await assert.rejects(cmd.run({ _: [], flags: {} }), (e) => e.usage === true);
    await assert.rejects(cmd.run({ _: ['fly'], flags: {} }), (e) => e.usage === true && /Unknown desktop command/.test(e.message));
    await assert.rejects(cmd.run({ _: ['launch'], flags: {} }), (e) => e.usage === true);
    await assert.rejects(cmd.run({ _: ['switch-tab'], flags: {} }), (e) => e.usage === true);
    assert.deepEqual(parseBounds('10,20,800,600'), { x: 10, y: 20, width: 800, height: 600 });
    assert.throws(() => parseBounds('10,20'), (e) => e.usage === true);
    const code = await cmd.run({ _: ['window', 'Chrome'], flags: { state: 'maximize', json: true } });
    assert.equal(code, 0);
    const res = JSON.parse(out.pop());
    assert.equal(res.ok, true);
    assert.equal(res.state, 'maximize');
    assert.equal(res.after.width, 1280);
    const missing = await cmd.run({ _: ['window', 'Nope'], flags: { state: 'maximize', json: true } });
    assert.equal(missing, 1);
    assert.equal(JSON.parse(out.pop()).code, 'NOT_FOUND');
    const waited = await cmd.run({ _: ['wait'], flags: { window: 'Nope', timeout: '1' } });
    assert.equal(waited, 2, 'a wait that times out exits 2');
    assert.match(out.pop(), /Timed out after 1 s/);
  } finally {
    if (prev.driver == null) delete process.env.ANYWHERE_DRIVER;
    else process.env.ANYWHERE_DRIVER = prev.driver;
    if (prev.home == null) delete process.env.ANYWHERE_HOME;
    else process.env.ANYWHERE_HOME = prev.home;
    await osIndex.resetDriver();
  }
});
