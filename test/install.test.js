'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_JS = path.join(ROOT, 'scripts', 'install.js');
const installer = require('../scripts/install.js');
const syntax = require('../scripts/check-syntax.js');

function tmpDir(prefix = 'anywhere-install-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function which(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Point HOME, USERPROFILE, CLAUDE_CONFIG_DIR and ANYWHERE_HOME at a temp tree for the test. */
function sandbox(t) {
  const base = tmpDir();
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const saved = {};
  const set = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANYWHERE_HOME: path.join(base, 'state'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  };
  for (const [k, v] of Object.entries(set)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return { base, home, claudeHome: set.CLAUDE_CONFIG_DIR, state: set.ANYWHERE_HOME };
}

test('install copies the skill and writes install.json; uninstall reverses it', async (t) => {
  const sb = sandbox(t);
  const lines = [];
  const res = await installer.install({ mcp: false, hotkey: false, print: (l) => lines.push(l) });
  assert.equal(res.ok, true);
  const skillDir = path.join(sb.claudeHome, 'skills', 'anywhere');
  assert.equal(res.skillDir, skillDir);
  for (const f of ['SKILL.md', 'run.js']) {
    assert.equal(fs.readFileSync(path.join(skillDir, f), 'utf8'), fs.readFileSync(path.join(ROOT, 'skills', 'anywhere', f), 'utf8'));
  }
  const info = JSON.parse(fs.readFileSync(path.join(sb.state, 'install.json'), 'utf8'));
  assert.equal(info.packageRoot, ROOT);
  assert.equal(info.version, require('../package.json').version);
  assert.ok(!Number.isNaN(Date.parse(info.installedAt)));
  assert.equal(info.skillDir, skillDir);
  assert.equal(res.mcp.skipped, true);
  assert.ok(lines.some((l) => /Skill/.test(l)));
  assert.ok(lines.some((l) => /installed\. Next/.test(l)));
  assert.ok(res.nextSteps.length >= 3);

  // The copied launcher resolves the package through install.json.
  const launcher = require(path.join(skillDir, 'run.js'));
  const r = launcher.resolveLauncher({ skillDir, env: process.env });
  assert.equal(r.via, 'install.json');
  assert.equal(r.script, path.join(ROOT, 'bin', 'anywhere.js'));

  // Re-installing overwrites in place.
  fs.writeFileSync(path.join(skillDir, 'stale.txt'), 'old');
  await installer.install({ mcp: false, quiet: true });
  assert.ok(!fs.existsSync(path.join(skillDir, 'stale.txt')));

  fs.mkdirSync(path.join(sb.state, 'electron', 'node_modules'), { recursive: true });
  const un = await installer.uninstall({ quiet: true, mcp: false });
  assert.equal(un.ok, true);
  assert.ok(!fs.existsSync(skillDir));
  assert.ok(!fs.existsSync(path.join(sb.state, 'install.json')));
  assert.ok(!fs.existsSync(path.join(sb.state, 'electron')));
  assert.ok(fs.existsSync(sb.state), 'state dir is kept without --purge');

  await installer.install({ mcp: false, quiet: true });
  fs.writeFileSync(path.join(sb.state, 'config.json'), '{}');
  const purge = await installer.uninstall({ quiet: true, mcp: false, purge: true });
  assert.ok(purge.removed.includes(path.resolve(sb.state)));
  assert.ok(!fs.existsSync(sb.state));
});

test('install moves an unrelated "anywhere" skill aside instead of deleting it', async (t) => {
  const sb = sandbox(t);
  const skillDir = path.join(sb.claudeHome, 'skills', 'anywhere');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: something-else\ndescription: x\n---\n');
  const res = await installer.install({ mcp: false, quiet: true });
  assert.ok(res.skill.backup && fs.existsSync(path.join(res.skill.backup, 'SKILL.md')));
  assert.ok(installer.isOurSkill(skillDir));
  assert.equal(res.warnings.length, 1);
  // uninstall leaves foreign skills alone
  const custom = tmpDir();
  fs.writeFileSync(path.join(custom, 'SKILL.md'), '---\nname: other\n---\n');
  const un = await installer.uninstall({ quiet: true, mcp: false, skillDir: custom });
  assert.ok(fs.existsSync(path.join(custom, 'SKILL.md')));
  assert.ok(un.notes.some((n) => n.includes('not the Claude Anywhere skill')));
  fs.rmSync(custom, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('install honours a custom skillDir', async (t) => {
  const sb = sandbox(t);
  const dir = path.join(sb.base, 'custom', 'anywhere');
  const res = await installer.install({ mcp: false, quiet: true, skillDir: dir });
  assert.equal(res.skillDir, dir);
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
  await installer.uninstall({ quiet: true, mcp: false });
  assert.ok(!fs.existsSync(dir), 'uninstall uses the recorded skillDir');
});

const linuxHotkey = process.platform === 'linux' && !process.env.WSL_DISTRO_NAME && !fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');

test('Linux hotkey: .desktop entry and GNOME keybinding appended without clobbering', { skip: linuxHotkey ? false : 'Linux-only' }, (t) => {
  const base = tmpDir();
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const fakeBin = path.join(base, 'bin');
  fs.mkdirSync(fakeBin);
  const store = path.join(base, 'gsettings.json');
  const existing = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/';
  fs.writeFileSync(store, JSON.stringify({ list: `['${existing}']`, keys: {} }));
  // A fake gsettings that keeps its state in a JSON file.
  fs.writeFileSync(
    path.join(fakeBin, 'gsettings'),
    `#!${process.execPath}\n` +
      `const fs=require('fs');const f=${JSON.stringify(store)};const s=JSON.parse(fs.readFileSync(f,'utf8'));\n` +
      `const [cmd,schema,key,val]=process.argv.slice(2);\n` +
      `if(cmd==='get'&&key==='custom-keybindings'){process.stdout.write(s.list+'\\n');process.exit(0)}\n` +
      `if(cmd==='get'){process.stdout.write((s.keys[schema+' '+key]||"''")+'\\n');process.exit(0)}\n` +
      `if(cmd==='set'&&key==='custom-keybindings'){s.list=val}\n` +
      `else if(cmd==='set'){s.keys[schema+' '+key]=val}\n` +
      `else if(cmd==='reset'){delete s.keys[schema+' '+key]}\n` +
      `fs.writeFileSync(f,JSON.stringify(s));\n`,
    { mode: 0o755 }
  );
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const runner = path.join(base, 'runner.js');
  fs.writeFileSync(
    runner,
    `const i=require(${JSON.stringify(INSTALL_JS)});\n` +
      `(async()=>{const r=await i[process.argv[2]]({mcp:false,hotkey:true,quiet:true});process.stdout.write(JSON.stringify(r));})().catch(e=>{console.error(e);process.exit(1)});\n`
  );
  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANYWHERE_HOME: path.join(base, 'state'),
    XDG_DATA_HOME: path.join(home, 'share'),
    XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
    DISPLAY: process.env.DISPLAY || ':0',
  };
  delete env.WAYLAND_DISPLAY;
  const inst = spawnSync(process.execPath, [runner, 'install'], { env, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  const res = JSON.parse(inst.stdout);
  assert.equal(res.hotkey.installed, true);
  assert.equal(res.hotkey.gnome, true);
  assert.equal(res.hotkey.label, 'Ctrl+Alt+A');
  const desktop = fs.readFileSync(path.join(home, 'share', 'applications', 'claude-anywhere.desktop'), 'utf8');
  assert.match(desktop, /^\[Desktop Entry\]/);
  assert.match(desktop, /^Name=Claude Anywhere$/m);
  assert.ok(desktop.includes(`Exec=${installer.desktopExecArg(process.execPath)} ${installer.desktopExecArg(path.join(ROOT, 'bin', 'anywhere.js'))} show`));
  let s = JSON.parse(fs.readFileSync(store, 'utf8'));
  const list = installer.parseGvStringArray(s.list);
  assert.deepEqual(list, [existing, installer.GNOME_PATH]);
  const rel = `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${installer.GNOME_PATH}`;
  assert.equal(s.keys[`${rel} binding`], "'<Primary><Alt>a'");
  assert.equal(s.keys[`${rel} name`], "'Claude Anywhere'");
  assert.match(s.keys[`${rel} command`], /anywhere\.js show'$/);
  const info = JSON.parse(fs.readFileSync(path.join(base, 'state', 'install.json'), 'utf8'));
  assert.equal(info.hotkey.gnome, true);

  // Installing twice must not duplicate the list entry.
  assert.equal(spawnSync(process.execPath, [runner, 'install'], { env, encoding: 'utf8' }).status, 0);
  s = JSON.parse(fs.readFileSync(store, 'utf8'));
  assert.equal(installer.parseGvStringArray(s.list).length, 2);

  const un = spawnSync(process.execPath, [runner, 'uninstall'], { env, encoding: 'utf8' });
  assert.equal(un.status, 0, un.stderr);
  s = JSON.parse(fs.readFileSync(store, 'utf8'));
  assert.deepEqual(installer.parseGvStringArray(s.list), [existing]);
  assert.deepEqual(s.keys, {});
  assert.ok(!fs.existsSync(path.join(home, 'share', 'applications', 'claude-anywhere.desktop')));
});

test('quoting helpers', () => {
  assert.equal(installer.shQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(installer.shQuote("/a b/it's"), `'/a b/it'\\''s'`);
  assert.equal(installer.psQuote("C:\\Users\\O'Brien"), "'C:\\Users\\O''Brien'");
  assert.equal(installer.vbsQuote('"C:\\node.exe" show'), '"""C:\\node.exe"" show"');
  assert.equal(installer.appleScriptEscape('say "hi" \\ there'), 'say \\"hi\\" \\\\ there');
  assert.equal(installer.gvString("it's"), "'it\\'s'");
  assert.equal(installer.desktopExecArg('/usr/bin/node'), '/usr/bin/node');
  assert.equal(installer.desktopExecArg('/home/me/My Apps/anywhere.js'), '"/home/me/My Apps/anywhere.js"');
  assert.equal(installer.desktopExecArg('/p/$x/100%'), '"/p/\\\\$x/100%%"');
});

test('gsettings list parsing round-trips', () => {
  assert.deepEqual(installer.parseGvStringArray('@as []'), []);
  const list = ['/org/a/custom0/', "/org/it's/"];
  assert.deepEqual(installer.parseGvStringArray(installer.formatGvStringArray(list)), list);
  assert.deepEqual(installer.parseGvStringArray("['/x/', '/y/']\n"), ['/x/', '/y/']);
});

test('Windows launcher, shortcut script and encoding', () => {
  const vbs = installer.windowsLauncherVbs('"C:\\Program Files\\nodejs\\node.exe" "C:\\a\\anywhere.js" show');
  assert.match(vbs, /CreateObject\("WScript\.Shell"\)/);
  assert.ok(vbs.includes('shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\a\\anywhere.js"" show", 0, False'));
  assert.ok(vbs.includes('\r\n'));
  const ps = installer.windowsShortcutScript({ vbsPath: "C:\\Users\\O'Brien\\.claude-anywhere\\launch-anywhere.vbs", iconPath: 'C:\\node.exe' });
  // Ctrl+Alt+<letter> would also fire on AltGr+<letter> (Windows reports AltGr as Ctrl+Alt).
  assert.match(ps, /\$s\.Hotkey = 'CTRL\+ALT\+F12'/);
  assert.match(ps, /O''Brien/);
  assert.match(ps, /Claude Anywhere\.lnk/);
  assert.match(ps, /wscript\.exe/);
  const wsl = installer.windowsShortcutScript({ vbsPath: null, vbsContent: vbs });
  assert.match(wsl, /LOCALAPPDATA/);
  assert.match(wsl, /Set-Content -LiteralPath \$vbs/);
  const decoded = Buffer.from(installer.encodePs('Write-Output "ü"'), 'base64').toString('utf16le');
  assert.equal(decoded, 'Write-Output "ü"');
});

const pwsh = which('pwsh') || which('pwsh.exe') || which('powershell.exe');

test('generated PowerShell scripts parse', { skip: pwsh ? false : 'PowerShell is not installed' }, () => {
  const scripts = [
    installer.windowsShortcutScript({ vbsPath: "C:\\x\\it's.vbs", iconPath: 'C:\\node.exe' }),
    installer.windowsShortcutScript({ vbsPath: null, vbsContent: installer.windowsLauncherVbs('wsl.exe -e "/usr/bin/node" "/a b/anywhere.js" show') }),
    installer.windowsRemoveScript(['C:\\a.lnk', "C:\\b'c.vbs"]),
    installer.windowsRemoveScript([]),
  ];
  for (const s of scripts) {
    const check =
      '$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:PS_SRC)),[ref]$t,[ref]$e);' +
      'if($e -and $e.Count){$e|%{$_.ToString()};exit 1}';
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', check], { env: { ...process.env, PS_SRC: installer.encodePs(s) }, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}\n${s}`);
  }
});

test('macOS AppleScript launcher and MCP registration commands', () => {
  const as = installer.macAppleScript('/opt/homebrew/bin/node', "/Users/me/My Apps/it's/anywhere.js");
  assert.equal(as, `do shell script "/opt/homebrew/bin/node '/Users/me/My Apps/it'\\\\''s/anywhere.js' show --launcher > /dev/null 2>&1 &"`);
  const json = installer.mcpServerJson('/usr/bin/node', '/a b/src/mcp/server.js');
  assert.deepEqual(JSON.parse(json), { type: 'stdio', command: '/usr/bin/node', args: ['/a b/src/mcp/server.js'] });
  assert.equal(installer.manualMcpCommand(json, 'linux'), `claude mcp add-json --scope user anywhere '${json}'`);
  const win = installer.manualMcpCommand(installer.mcpServerJson('C:\\node.exe', 'C:\\a\\server.js'), 'win32');
  // No embedded quotes on Windows (cmd.exe and PowerShell both mangle them): `mcp add <name> <cmd> <args>`.
  assert.equal(win, 'claude mcp add --scope user anywhere "C:\\node.exe" "C:\\a\\server.js"');
  const spec = installer.claudeSpawnSpec('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', ['mcp', 'add-json', 'anywhere', '{"a":1}'], 'win32');
  assert.equal(spec.shell, true);
  assert.equal(spec.args[3], '"{\\"a\\":1}"');
  const posix = installer.claudeSpawnSpec('/usr/local/bin/claude', ['mcp', 'get', 'anywhere'], 'linux');
  assert.deepEqual(posix, { command: '/usr/local/bin/claude', args: ['mcp', 'get', 'anywhere'], shell: false });
  const js = installer.claudeSpawnSpec('/x/cli.js', ['--version'], 'linux');
  assert.equal(js.command, process.execPath);
});

test('script argument parsing', () => {
  assert.deepEqual(installer.parseScriptArgs(['--electron', '--no-mcp', '--hotkey']), {
    command: 'install',
    electron: true,
    mcp: false,
    hotkey: true,
    purge: false,
    quiet: false,
    json: false,
  });
  assert.equal(installer.parseScriptArgs(['uninstall', '--purge']).purge, true);
  assert.throws(() => installer.parseScriptArgs(['--nope']), /Unknown option/);
});

test('install.sh and install.ps1 are syntactically valid', () => {
  const sh = path.join(ROOT, 'scripts', 'install.sh');
  for (const shell of ['sh', 'bash']) {
    if (process.platform === 'win32' || !which(shell)) continue;
    const r = spawnSync(shell, ['-n', sh], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${shell}: ${r.stderr}`);
  }
  const text = fs.readFileSync(sh, 'utf8');
  assert.match(text, /set -eu/);
  assert.match(text, /pipefail/);
  assert.match(text, /git -C "\$APP_DIR" pull --ff-only/);
  assert.match(text, /anywhere\.js" install "\$@"/);
  const ps1 = fs.readFileSync(path.join(ROOT, 'scripts', 'install.ps1'), 'utf8');
  assert.match(ps1, /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(ps1, /Expand-Archive/);
  assert.match(ps1, /install @Arguments/);
  if (pwsh) {
    const check =
      `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(ROOT, 'scripts', 'install.ps1').replace(/'/g, "''")}',[ref]$t,[ref]$e);` +
      'if($e -and $e.Count){$e|%{$_.ToString()};exit 1}';
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

test('check-syntax: SKILL.md frontmatter rules', () => {
  assert.equal(syntax.checkSkillText('---\nname: x\ndescription: y\n---\nbody'), null);
  assert.match(syntax.checkSkillText('# no frontmatter'), /frontmatter/);
  assert.match(syntax.checkSkillText('---\nname: x\n---\n'), /description/);
});

test('check-syntax: catches broken JS, JSON, ES modules and skills in a fixture tree', async (t) => {
  const root = tmpDir('anywhere-syntax-fixture-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const w = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w('src/ok.js', "'use strict';\nmodule.exports = 1;\n");
  w('src/ui/app.js', "import { x } from './x.js';\nexport const y = x;\n");
  w('bin/tool.js', 'const = ;\n');
  w('config.json', '{"a": 1}');
  w('bad.json', '{a: 1}');
  w('skills/demo/SKILL.md', '---\nname: demo\ndescription: d\n---\n');
  w('skills/broken/SKILL.md', 'no frontmatter\n');
  const res = await syntax.checkAll({ root });
  const failed = res.failures.map((f) => path.relative(root, f.file).split(path.sep).join('/')).sort();
  assert.deepEqual(failed, ['bad.json', 'bin/tool.js', 'skills/broken/SKILL.md']);
  assert.ok(syntax.isUiModule(root, path.join(root, 'src', 'ui', 'app.js')));

  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-syntax.js'), '--root', root], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  fs.writeFileSync(path.join(root, 'bin', 'tool.js'), 'const ok = 1;\n');
  fs.writeFileSync(path.join(root, 'bad.json'), '{}');
  fs.writeFileSync(path.join(root, 'skills', 'broken', 'SKILL.md'), '---\nname: b\ndescription: c\n---\n');
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-syntax.js'), '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /passed the syntax check/);
});

test('a plugin install does not register the MCP server a second time', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false }, async (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(sb.claudeHome, { recursive: true });
  // Make ~/.claude/plugins resolve to a folder that contains this package, like a plugin cache.
  fs.symlinkSync(path.dirname(ROOT), path.join(sb.claudeHome, 'plugins'));
  const lines = [];
  const res = await installer.install({ mcp: true, print: (l) => lines.push(l) });
  assert.equal(res.mcp.registered, false);
  assert.equal(res.mcp.reason, 'provided by the anywhere plugin');
  assert.ok(lines.some((l) => l.includes('provided by the anywhere plugin')));
  assert.ok(installer.isInside('/a/b/c', '/a/b'));
  assert.ok(!installer.isInside('/a/bc', '/a/b'));
  assert.ok(!installer.isInside('/a/b', '/a/b'));
});
