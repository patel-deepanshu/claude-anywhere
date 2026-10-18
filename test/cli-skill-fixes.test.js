'use strict';

/**
 * Regression tests for the cli-skill review fixes: installer PATH handling (Windows),
 * daemon PATH from OS launchers, the Windows hotkey, the macOS launcher, stable node paths,
 * `config set` reporting, CLI activity in the dialog and GNOME shortcut verification.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'anywhere.js');
const cli = require('../bin/anywhere.js');
const installer = require('../scripts/install.js');

function tmpDir(prefix = 'anywhere-fixes-') {
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

function childEnv(extra = {}) {
  const env = { ...process.env, ANYWHERE_HOME: tmpDir(), NO_COLOR: '1' };
  for (const k of ['ANYWHERE_DAEMON_URL', 'ANYWHERE_TOKEN', 'ANYWHERE_DRIVER', 'FORCE_COLOR']) delete env[k];
  return { ...env, ...extra };
}

function runCli(args, { env, input, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: env || childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input == null ? undefined : input);
  });
}

async function fakeDaemon(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        parsed = body;
      }
      const rec = { method: req.method, url: req.url, body: parsed };
      requests.push(rec);
      const out = (await handler(rec)) || {};
      res.writeHead(out.__status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    env: (extra = {}) => childEnv({ ANYWHERE_DAEMON_URL: url, ANYWHERE_TOKEN: 'test-token', ...extra }),
    close: () => new Promise((r) => server.close(r)),
  };
}

const pwsh = which('pwsh') || which('pwsh.exe') || which('powershell.exe');

// ------------------------------------------------------------ WINDOWS-2: install.ps1 user PATH

test('install.ps1 keeps a one-entry user Path and %VAR% entries intact', { skip: pwsh ? false : 'PowerShell is not installed' }, () => {
  const ps1 = path.join(ROOT, 'scripts', 'install.ps1');
  const script = [
    'Set-StrictMode -Version 2.0',
    "$ErrorActionPreference = 'Stop'",
    '$e = $null; $t = $null',
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${ps1.replace(/'/g, "''")}', [ref]$t, [ref]$e)`,
    "$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-PathWithEntry' }, $true)",
    '. ([scriptblock]::Create($fn.Extent.Text))',
    "$bin = 'C:\\Users\\me\\.claude-anywhere\\app\\bin'",
    "Write-Output ('A=' + (Get-PathWithEntry -Current 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;' -Dir $bin))",
    "Write-Output ('B=' + (Get-PathWithEntry -Current '' -Dir $bin))",
    "Write-Output ('C=' + (Get-PathWithEntry -Current '%USERPROFILE%\\bin;%JAVA_HOME%\\bin' -Dir $bin))",
    "Write-Output ('D=' + ($null -eq (Get-PathWithEntry -Current ('x;' + $bin + '\\') -Dir $bin)))",
  ].join('\n');
  const dir = tmpDir('anywhere-ps1-');
  const file = path.join(dir, 'path-test.ps1');
  fs.writeFileSync(file, script);
  const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = Object.fromEntries(
    r.stdout
      .split(/\r?\n/)
      .filter((l) => /^[A-D]=/.test(l))
      .map((l) => [l[0], l.slice(2)])
  );
  assert.equal(out.A, 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\me\\.claude-anywhere\\app\\bin');
  assert.equal(out.B, 'C:\\Users\\me\\.claude-anywhere\\app\\bin');
  assert.equal(out.C, '%USERPROFILE%\\bin;%JAVA_HOME%\\bin;C:\\Users\\me\\.claude-anywhere\\app\\bin');
  assert.equal(out.D, 'True');
});

test('install.ps1 writes the raw registry Path as REG_EXPAND_SZ', () => {
  const text = fs.readFileSync(path.join(ROOT, 'scripts', 'install.ps1'), 'utf8');
  assert.doesNotMatch(text, /SetEnvironmentVariable\('Path'/);
  assert.match(text, /DoNotExpandEnvironmentNames/);
  assert.match(text, /RegistryValueKind\]::ExpandString/);
  assert.match(text, /@\(\$Current\.Split\(';'\)/);
});

// ------------------------------------------------------------ WINDOWS-6: daemon PATH from launchers

test('daemonPath puts node first and adds recorded and per-user directories', () => {
  const nodeDir = '/home/u/.nvm/versions/node/v22.11.0/bin';
  const isDir = (p) => p !== '/gone/bin';
  const base = { nodeDir, home: '/home/u', platform: 'linux', isDir };
  assert.equal(
    cli.daemonPath('/usr/bin:/bin', { ...base, recorded: `/usr/bin:${nodeDir}:/home/u/.cargo/bin:/gone/bin:relative/bin` }),
    `${nodeDir}:/usr/bin:/bin:/home/u/.cargo/bin:/home/u/.local/bin`
  );
  // Already there (trailing slash too): nothing is moved or repeated.
  assert.equal(cli.daemonPath(`/usr/bin:${nodeDir}/:/home/u/.local/bin`, base), `/usr/bin:${nodeDir}/:/home/u/.local/bin`);
  // No PATH at all still keeps the system directories.
  assert.deepEqual(cli.daemonPath('', base).split(':').slice(0, 3), [nodeDir, '/usr/local/bin', '/usr/bin']);
  // macOS: `do shell script` PATH gets Homebrew back.
  const mac = cli.daemonPath('/usr/bin:/bin:/usr/sbin:/sbin', { nodeDir: '/opt/homebrew/Cellar/node/22.11.0/bin', home: '/Users/u', platform: 'darwin', isDir: () => true });
  assert.ok(mac.split(':').includes('/opt/homebrew/bin'));
  assert.ok(mac.split(':').includes('/usr/local/bin'));
  assert.equal(cli.daemonPath('C:\\Windows', { nodeDir: 'C:\\node', platform: 'win32' }), 'C:\\Windows');
});

test('a daemon started from a bare PATH gets node and the install-time PATH', { skip: process.platform === 'linux' ? false : '/proc is Linux-only', timeout: 60000 }, async (t) => {
  const home = tmpDir('anywhere-fixes-daemon-');
  const extra = path.join(home, 'tools-bin');
  fs.mkdirSync(extra);
  fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify({ packageRoot: ROOT, envPath: `/usr/bin:${extra}` }));
  const env = childEnv({ ANYWHERE_HOME: home, ANYWHERE_DRIVER: 'mock', PATH: '/usr/bin:/bin' });
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  t.after(async () => {
    await runCli(['stop'], { env }).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const start = await runCli(['start', '--no-open', '--port', '0', '--project', ROOT, '--json'], { env, timeoutMs: 45000 });
  assert.equal(start.code, 0, start.stdout + start.stderr);
  const { pid } = JSON.parse(start.stdout);
  const vars = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  const daemonPathVar = (vars.find((v) => v.startsWith('PATH=')) || '').slice(5).split(':');
  assert.equal(daemonPathVar[0], path.dirname(process.execPath));
  assert.ok(daemonPathVar.includes('/usr/bin'));
  assert.ok(daemonPathVar.includes(extra), daemonPathVar.join(':'));
});

test('install records a stable node path and the install-time PATH', async (t) => {
  const base = tmpDir();
  const saved = {};
  const set = { HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'), CLAUDE_CONFIG_DIR: path.join(base, 'home', '.claude'), ANYWHERE_HOME: path.join(base, 'state') };
  fs.mkdirSync(set.HOME, { recursive: true });
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
  await installer.install({ mcp: false, quiet: true });
  const info = JSON.parse(fs.readFileSync(path.join(set.ANYWHERE_HOME, 'install.json'), 'utf8'));
  assert.equal(info.nodePath, installer.stableNodePath());
  if (process.platform === 'win32') assert.equal(info.envPath, undefined);
  else assert.equal(info.envPath, process.env.PATH);
});

// ------------------------------------------------------------ WINDOWS-7: Windows hotkey vs AltGr

test('the Windows shortcut avoids Ctrl+Alt+<letter> (AltGr) and can be chosen', () => {
  assert.equal(installer.WIN_HOTKEY, 'CTRL+ALT+F12');
  assert.equal(installer.WIN_HOTKEY_LABEL, 'Ctrl+Alt+F12');
  assert.match(installer.windowsShortcutScript({ vbsPath: 'C:\\a.vbs' }), /\$s\.Hotkey = 'CTRL\+ALT\+F12'/);
  assert.match(installer.windowsShortcutScript({ vbsPath: 'C:\\a.vbs', hotkey: 'CTRL+SHIFT+F9' }), /\$s\.Hotkey = 'CTRL\+SHIFT\+F9'/);
  assert.equal(installer.HOTKEY_LABEL, 'Ctrl+Alt+A', 'Linux keeps AltGr separate, so GNOME keeps Ctrl+Alt+A');
  assert.equal(installer.GNOME_BINDING, '<Primary><Alt>a');

  assert.deepEqual(installer.parseHotkeyCombo('shift+ctrl+f9'), { label: 'Ctrl+Shift+F9', win: 'CTRL+SHIFT+F9', gnome: '<Primary><Shift>F9', mods: ['ctrl', 'shift'], key: 'F9', altGrClash: false });
  const a = installer.parseHotkeyCombo('Ctrl+Alt+A');
  assert.equal(a.gnome, installer.GNOME_BINDING);
  assert.equal(a.altGrClash, true);
  assert.equal(installer.parseHotkeyCombo('Ctrl+Alt+F12').altGrClash, false);
  for (const bad of ['', 'Ctrl+A', 'Ctrl+Alt+Space', 'Ctrl+Alt+A+B', 'Win+Alt+A', 'Ctrl++A', 'Ctrl+Alt+F25']) {
    assert.throws(() => installer.parseHotkeyCombo(bad), /Unsupported shortcut/, bad);
  }
  const o = installer.parseScriptArgs(['--hotkey-key=Ctrl+Shift+F9']);
  assert.equal(o.hotkey, true);
  assert.equal(o.hotkeyKey, 'Ctrl+Shift+F9');
  assert.throws(() => installer.parseScriptArgs(['--hotkey-key=Ctrl+A']), /Unsupported shortcut/);
  assert.match(installer.otherDesktopInstructions('cmd', installer.parseHotkeyCombo('Ctrl+Shift+F9')).join('\n'), /bindsym Ctrl\+Shift\+F9 exec cmd.*bind = CTRL SHIFT, F9, exec, cmd/);
});

test('anywhere install --hotkey-key validates the shortcut; help names the new default', async () => {
  const r = await runCli(['install', '--hotkey-key', 'Ctrl+A']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unsupported shortcut "Ctrl\+A"/);
  const help = await runCli(['help', 'install']);
  assert.match(help.stdout, /Ctrl\+Alt\+F12 on Windows/);
  assert.match(help.stdout, /--hotkey-key/);
  assert.doesNotMatch(cli.commandHelp('install'), /OS shortcut \(Ctrl\+Alt\+A\)/);
});

// ------------------------------------------------------------ MACOS-2: macOS launcher

test('the macOS launcher only shows a running dialog (show --launcher)', async (t) => {
  assert.match(installer.macAppleScript('/usr/local/bin/node', '/a/anywhere.js'), /anywhere\.js show --launcher > \/dev\/null/);
  assert.ok(cli.COMMANDS.show.spec.boolean.includes('launcher'));
  // With a daemon running, --launcher simply shows it (every platform).
  const d = await fakeDaemon((req) => (req.url === '/api/show' ? { host: 'browser' } : { __status: 404, error: 'nope' }));
  t.after(() => d.close());
  const r = await runCli(['show', '--launcher'], { env: d.env() });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(d.requests.some((q) => q.url === '/api/show'));
});

// ------------------------------------------------------------ MACOS-5: Homebrew Cellar paths

test('stableNodePath swaps a Homebrew Cellar path for a link that survives upgrades', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false }, (t) => {
  const prefix = tmpDir('anywhere-brew-');
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const keg = path.join(prefix, 'Cellar', 'node', '22.11.0');
  fs.mkdirSync(path.join(keg, 'bin'), { recursive: true });
  const cellarNode = path.join(keg, 'bin', 'node');
  fs.writeFileSync(cellarNode, '');
  const noWhich = { which: () => null };
  // Nothing better available: keep the real path.
  assert.equal(installer.stableNodePath(cellarNode, noWhich), cellarNode);
  // <prefix>/bin/node pointing into the same formula.
  fs.mkdirSync(path.join(prefix, 'bin'));
  fs.symlinkSync(cellarNode, path.join(prefix, 'bin', 'node'));
  assert.equal(installer.stableNodePath(cellarNode, noWhich), `${prefix}/bin/node`);
  // The formula's opt/ link wins (also covers keg-only node@22).
  fs.mkdirSync(path.join(prefix, 'opt'));
  fs.symlinkSync(keg, path.join(prefix, 'opt', 'node'));
  assert.equal(installer.stableNodePath(cellarNode, noWhich), `${prefix}/opt/node/bin/node`);
  // A different formula's link is not used.
  const other = path.join(prefix, 'Cellar', 'node@20', '20.18.0', 'bin', 'node');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, '');
  assert.equal(installer.stableNodePath(other, noWhich), other);
  // Non-Homebrew paths are returned unchanged.
  assert.equal(installer.stableNodePath('/usr/bin/node', noWhich), '/usr/bin/node');
  assert.equal(installer.stableNodePath('C:\\Program Files\\nodejs\\node.exe', noWhich), 'C:\\Program Files\\nodejs\\node.exe');
  // The MCP registration uses the stable path by default.
  assert.equal(JSON.parse(installer.mcpServerJson()).command, installer.stableNodePath());
});

test('doctor flags an MCP registration whose node or server.js is gone', () => {
  const out = [
    'anywhere:',
    '  Scope: User config (available in all your projects)',
    '  Status: × Failed to connect',
    '  Type: stdio',
    '  Command: /opt/homebrew/Cellar/node/22.11.0/bin/node-gone',
    `  Args: ${path.join(ROOT, 'src', 'mcp', 'server.js')}`,
  ].join('\n');
  assert.deepEqual(cli.staleMcpPaths(out), ['/opt/homebrew/Cellar/node/22.11.0/bin/node-gone']);
  assert.deepEqual(cli.staleMcpPaths(out.replace('/opt/homebrew/Cellar/node/22.11.0/bin/node-gone', process.execPath)), []);
  assert.deepEqual(cli.staleMcpPaths(`Command: node\nArgs: ${path.join(os.tmpdir(), 'missing-pkg', 'src', 'mcp', 'server.js')}`), [path.join(os.tmpdir(), 'missing-pkg', 'src', 'mcp', 'server.js')]);
});

// ------------------------------------------------------------ CROSS-MODULE-6: config set

test('config set mode switches the running dialog; start-up settings ask for a restart', async (t) => {
  let modeStatus = 200;
  const d = await fakeDaemon((req) => {
    if (req.url === '/api/config') return {};
    if (req.url === '/api/mode') return modeStatus === 200 ? { ok: true, mode: req.body.mode } : { __status: modeStatus, error: 'bad mode' };
    return { __status: 404, error: 'not found' };
  });
  t.after(() => d.close());
  const env = d.env();
  const m = await runCli(['config', 'set', 'mode', 'bridge'], { env });
  assert.equal(m.code, 0, m.stderr);
  assert.match(m.stdout, /applied to the running dialog/);
  assert.deepEqual(d.requests.find((q) => q.url === '/api/mode').body, { mode: 'bridge' });

  const port = await runCli(['config', 'set', 'port', '47555', '--json'], { env });
  assert.equal(JSON.parse(port.stdout).appliedToRunningDaemon, false);
  const host = await runCli(['config', 'set', 'ui.host', 'browser'], { env });
  assert.match(host.stdout, /restart to apply/);
  assert.equal(d.requests.filter((q) => q.url === '/api/mode').length, 1, 'only mode changes call /api/mode');

  modeStatus = 400;
  const failed = await runCli(['config', 'set', 'mode', 'companion'], { env });
  assert.equal(failed.code, 0);
  assert.match(failed.stdout, /restart to apply/);

  const live = await runCli(['config', 'set', 'voice.speakResponses', 'false'], { env });
  assert.match(live.stdout, /applied to the running dialog/);
  for (const k of ['port', 'ui.host', 'ui.width', 'ui.height', 'ui.position', 'ui.hotkey']) assert.ok(cli.STARTUP_ONLY.includes(k), k);
});

test('send --screenshot / --no-screenshot always send an explicit attachScreenshot (CROSS-MODULE-2)', async (t) => {
  const d = await fakeDaemon((req) => (req.url === '/api/command' ? { id: 'c1' } : { __status: 404, error: 'not found' }));
  t.after(() => d.close());
  const env = d.env();
  for (const args of [['send', 'plain'], ['send', '--screenshot', 'with'], ['send', '--no-screenshot', 'without']]) {
    const r = await runCli(args, { env });
    assert.equal(r.code, 0, r.stderr);
  }
  const bodies = d.requests.filter((q) => q.url === '/api/command').map((q) => q.body);
  assert.deepEqual(bodies.map((b) => [b.text, b.attachScreenshot]), [['plain', undefined], ['with', true], ['without', false]]);
});

test('doctor flags broad Claude Code allow rules (CROSS-MODULE-5)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash', 'Bash(npm test:*)', 'Read', 'mcp__anywhere__*', 'Edit(**)', 'mcp__anywhere__screenshot'] } }));
  const found = cli.broadAllowRules([file, path.join(dir, 'missing.json')]);
  assert.deepEqual(found.map((f) => f.rule), ['Bash', 'mcp__anywhere__*', 'Edit(**)']);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(cli.broadAllowRules([file]), []);
});

// ------------------------------------------------------------ CROSS-MODULE-8: CLI activity

const haveOs = fs.existsSync(path.join(ROOT, 'src', 'os', 'index.js')) && fs.existsSync(path.join(ROOT, 'src', 'os', 'computer.js'));

test('computer actions show up in the dialog like MCP tool calls', { skip: haveOs ? false : 'src/os is not present' }, async (t) => {
  const d = await fakeDaemon((req) => {
    if (req.url === '/api/mcp/guard') return { allowed: true };
    if (req.url === '/api/mcp/activity') return { ok: true };
    return { __status: 404, error: 'not found' };
  });
  t.after(() => d.close());
  const env = d.env({ ANYWHERE_DRIVER: 'mock' });
  const activity = () => d.requests.filter((q) => q.url === '/api/mcp/activity').map((q) => q.body);

  const click = await runCli(['computer', 'click', '100', '50', '--double'], { env });
  assert.equal(click.code, 0, click.stderr);
  assert.equal(JSON.parse(click.stdout).ok, true, 'stdout is unchanged JSON');
  assert.deepEqual(activity()[0], { tool: 'click', summary: 'Double-click left at (100, 50)', ok: true });

  const shot = await runCli(['computer', 'screenshot'], { env });
  assert.equal(shot.code, 0, shot.stderr);
  const a = activity()[1];
  assert.equal(a.tool, 'screenshot');
  assert.equal(a.ok, true);
  assert.match(a.summary, /^Screenshot of display 0 \(\d+x\d+\)$/);
  assert.equal(Buffer.from(a.image, 'base64').slice(1, 4).toString('latin1'), 'PNG');
  assert.equal(a.width, JSON.parse(shot.stdout).width);

  const typed = await runCli(['computer', 'type', 'hello   world'], { env });
  assert.equal(typed.code, 0, typed.stderr);
  assert.deepEqual(activity()[2], { tool: 'type_text', summary: 'Type 13 chars: "hello world"', ok: true });

  const miss = await runCli(['computer', 'focus', 'no-such-window-xyz'], { env });
  assert.equal(miss.code, 1);
  const f = activity()[3];
  assert.equal(f.tool, 'focus_window');
  assert.equal(f.ok, false);
  assert.match(f.error, /No window matches/);

  // Read-only queries and usage errors are not reported (the MCP tools do the same).
  await runCli(['computer', 'windows'], { env });
  await runCli(['computer', 'cursor'], { env });
  const bad = await runCli(['computer', 'click', 'abc', '1'], { env });
  assert.equal(bad.code, 1);
  assert.equal(activity().length, 4);
});

// ------------------------------------------------------------ LINUX-CONTEXT-11: GNOME shortcut

/** A fake gsettings for gnomeAddBinding: `persist` false behaves like the memory backend. */
function fakeGsettings({ persist = true, stderr = '' } = {}) {
  const store = { list: "['/org/x/custom0/']", keys: {} };
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const [cmd, schema, key, value] = args;
    if (cmd === 'get') return { code: 0, stdout: `${key === 'custom-keybindings' ? store.list : store.keys[`${schema} ${key}`] || "''"}\n`, stderr };
    if (persist) {
      if (key === 'custom-keybindings') store.list = value;
      else store.keys[`${schema} ${key}`] = value;
    }
    return { code: 0, stdout: '', stderr };
  };
  return { run, store, calls };
}

test('GNOME shortcut: ok only when gsettings really kept it', async () => {
  const good = fakeGsettings();
  assert.deepEqual(await installer.gnomeAddBinding('/usr/bin/node /a/anywhere.js show', { run: good.run }), { ok: true });
  assert.deepEqual(installer.parseGvStringArray(good.store.list), ['/org/x/custom0/', installer.GNOME_PATH]);
  const custom = fakeGsettings();
  assert.equal((await installer.gnomeAddBinding('cmd', { binding: '<Primary><Shift>F9', run: custom.run })).ok, true);
  assert.ok(Object.values(custom.store.keys).includes("'<Primary><Shift>F9'"));

  // No D-Bus session: gsettings warns about the memory backend and exits 0.
  const memory = fakeGsettings({ persist: false, stderr: "(process:42): GLib-GIO-WARNING **: Using the 'memory' GSettings backend.  Your settings will not be saved or shared with other applications.\n" });
  const m = await installer.gnomeAddBinding('cmd', { run: memory.run });
  assert.equal(m.ok, false);
  assert.match(m.reason, /memory' GSettings backend/);
  assert.ok(!memory.calls.some((c) => c[0] === 'set'), 'nothing is written once the backend is known not to save');

  // Writes "succeed" but nothing sticks (silent backend): verification catches it.
  const silent = fakeGsettings({ persist: false });
  const s = await installer.gnomeAddBinding('cmd', { run: silent.run });
  assert.equal(s.ok, false);
  assert.match(s.reason, /did not keep the change/);
});

test('COSMIC is not treated as GNOME and gets its own instructions', () => {
  for (const d of ['GNOME', 'ubuntu:GNOME', 'Budgie:GNOME', 'pop:GNOME', 'Unity', 'Pantheon', 'GNOME-Classic:GNOME', 'ubuntu']) assert.equal(installer.isGnomeLike(d), true, d);
  for (const d of ['COSMIC', 'pop:COSMIC', 'cosmic', 'KDE', 'X-Cinnamon', 'XFCE', 'Hyprland', '', undefined]) assert.equal(installer.isGnomeLike(d), false, String(d));
  const lines = installer.otherDesktopInstructions('/usr/bin/node /a/anywhere.js show');
  assert.ok(lines.some((l) => /COSMIC: Settings → Keyboard → Keyboard Shortcuts → Custom/.test(l)));
  assert.match(lines[0], /^Bind Ctrl\+Alt\+A to: /);
});
