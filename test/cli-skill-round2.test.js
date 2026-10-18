'use strict';

/**
 * Regression tests for the round-2 cli-skill fixes: claude spawned without cmd.exe on Windows
 * (WINDOWS-2-5), uninstall removing the `anywhere` command (WINDOWS-2-7), busy-aware project and
 * mode switches (JOURNEYS-DOCS-7, LIFECYCLE-4), leaving a forgotten bridge mode
 * (JOURNEYS-DOCS-2), identity-checked kills (LIFECYCLE-3, LIFECYCLE-13), doctor on headless,
 * WSL and Electron machines (JOURNEYS-DOCS-4, -11, -18), plugin detection (JOURNEYS-DOCS-9), the
 * printed CLI command (JOURNEYS-DOCS-10) and the Electron download (JOURNEYS-DOCS-16).
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

const posixOnly = process.platform === 'win32' ? 'POSIX-only (symlinks, shebang scripts)' : false;

function tmpDir(prefix = 'anywhere-r2-') {
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

/** PATH without any directory that holds an `anywhere` command. */
function pathWithoutAnywhere() {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, 'anywhere')) && !fs.existsSync(path.join(d, 'anywhere.cmd')))
    .join(path.delimiter);
}

function childEnv(extra = {}) {
  const home = tmpDir('anywhere-r2-home-');
  const env = { ...process.env, ANYWHERE_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), NO_COLOR: '1', PATH: pathWithoutAnywhere() };
  for (const k of ['ANYWHERE_DAEMON_URL', 'ANYWHERE_TOKEN', 'ANYWHERE_DRIVER', 'FORCE_COLOR', 'ANYWHERE_ELECTRON', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANYWHERE_STT_API_KEY']) delete env[k];
  return { ...env, ...extra };
}

function runCli(args, { env, input, timeoutMs = 60000 } = {}) {
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

/**
 * A fake daemon found through daemon.json (like a real one): /api/health answers without a token,
 * everything else goes to `handler`. Returns its state dir, requests and an env for the CLI.
 */
async function fakeDaemon(handler, { project, mode = 'companion' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ app: 'claude-anywhere', instanceId: 'fake-instance' }));
        return;
      }
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
  const port = server.address().port;
  const env = childEnv();
  const daemonJson = { pid: process.pid, port, token: 'fake-token', instanceId: 'fake-instance', version: '0.1.0', startedAt: new Date().toISOString(), project, mode, url: `http://127.0.0.1:${port}/?token=fake-token` };
  fs.writeFileSync(path.join(env.ANYWHERE_HOME, 'daemon.json'), JSON.stringify(daemonJson));
  return {
    requests,
    env,
    urls: () => requests.map((q) => `${q.method} ${q.url}`),
    close: () => new Promise((r) => server.close(r)),
  };
}

function snapshot(over = {}) {
  return { mode: 'companion', status: 'idle', project: { dir: over.dir || '/x' }, pending: { approvals: [], questions: [] }, bridge: { listening: false }, ...over };
}

// ------------------------------------------------------------ WINDOWS-2-5: claude without cmd.exe

test('an npm claude.cmd shim runs as node cli.js, without cmd.exe', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'claude.cmd');
  fs.writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  const cliJs = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(cliJs), { recursive: true });
  fs.writeFileSync(cliJs, '');
  const json = installer.mcpServerJson('C:\\Users\\R&D\\node.exe', 'C:\\Users\\R&D\\app\\src\\mcp\\server.js');
  const spec = installer.claudeSpawnSpec(shim, ['mcp', 'add-json', '--scope', 'user', 'anywhere', json], 'win32');
  assert.equal(spec.shell, false);
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, [cliJs, 'mcp', 'add-json', '--scope', 'user', 'anywhere', json], 'the JSON is passed as one untouched argument');
  assert.equal(spec.unsafe, undefined);
});

test('the cmd.exe fallback refuses an argument cmd would misread; the manual command has no embedded quotes', () => {
  const json = installer.mcpServerJson('C:\\Users\\R&D\\node.exe', 'C:\\Users\\R&D\\app\\src\\mcp\\server.js');
  // A .cmd that names no target (here: does not exist) can only run through cmd.exe.
  const spec = installer.claudeSpawnSpec('C:\\tools\\claude.cmd', ['mcp', 'add-json', '--scope', 'user', 'anywhere', json], 'win32');
  assert.equal(spec.shell, true);
  assert.match(spec.unsafe, /cmd\.exe/);
  const plain = installer.claudeSpawnSpec('C:\\tools\\claude.cmd', ['mcp', 'remove', '--scope', 'user', 'anywhere'], 'win32');
  assert.equal(plain.unsafe, undefined);
  assert.equal(installer.claudeSpawnSpec('C:\\tools\\claude.cmd', ['x', '{"a":1}'], 'win32').unsafe, undefined, 'quotes alone are fine');
  assert.equal(installer.manualMcpCommand(json, 'win32'), 'claude mcp add --scope user anywhere "C:\\Users\\R&D\\node.exe" "C:\\Users\\R&D\\app\\src\\mcp\\server.js"');
  assert.match(installer.manualMcpCommand('{not json', 'win32'), /^claude mcp add-json --scope user anywhere '\{not json'$/);
});

// ------------------------------------------------------------ WINDOWS-2-7: uninstall the command

function sandbox(t, extra = {}) {
  const base = tmpDir();
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const set = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANYWHERE_HOME: path.join(base, 'state'), XDG_DATA_HOME: path.join(home, '.local', 'share'), ANYWHERE_BIN_DIR: path.join(home, 'bin'), ...extra };
  const saved = {};
  for (const [k, v] of Object.entries(set)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.ANYWHERE_NO_LINK;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, home, state: set.ANYWHERE_HOME, binDir: set.ANYWHERE_BIN_DIR };
}

test('Windows uninstall removes the user PATH entry install.ps1 added', async (t) => {
  const sb = sandbox(t);
  const calls = [];
  const win = { platform: 'win32', isWSL: false };
  const res = await installer.uninstall({
    quiet: true,
    mcp: false,
    platformInfo: win,
    runPowerShell: async (info, script) => {
      calls.push(script);
      return { code: 0, stdout: 'removed\r\n', stderr: '' };
    },
  });
  const binDir = path.join(sb.state, 'app', 'bin');
  const script = calls.find((s) => s.includes('Environment'));
  assert.ok(script, 'a PATH script ran');
  assert.ok(script.includes(installer.psQuote(binDir)), 'it targets <state>\\app\\bin');
  assert.match(script, /DoNotExpandEnvironmentNames/);
  assert.match(script, /GetValueKind\('Path'\)/);
  assert.match(script, /RegistryValueKind\]::ExpandString/);
  assert.match(script, /SetEnvironmentVariable\('CLAUDE_ANYWHERE_PATH_REFRESH', \$null, 'User'\)/);
  assert.ok(res.removed.includes(`user PATH entry ${binDir}`));

  // Nothing to remove: no entry reported. A failing runner: a note with the manual step.
  const quiet = await installer.uninstall({ quiet: true, mcp: false, platformInfo: win, runPowerShell: async () => ({ code: 0, stdout: '', stderr: '' }) });
  assert.ok(!quiet.removed.some((r) => r.startsWith('user PATH entry')));
  const failed = await installer.uninstall({ quiet: true, mcp: false, platformInfo: win, runPowerShell: async () => ({ code: 1, stdout: '', stderr: 'Access denied' }) });
  assert.ok(failed.notes.some((n) => /Access denied/.test(n) && /Environment Variables/.test(n)));
});

const pwsh = which('pwsh') || which('pwsh.exe') || which('powershell.exe');

test('the PATH removal script parses in PowerShell', { skip: pwsh ? false : 'PowerShell is not installed' }, () => {
  const script = installer.windowsPathRemoveScript("C:\\Users\\O'Brien\\.claude-anywhere\\app\\bin");
  const check =
    '$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:PS_SRC)),[ref]$t,[ref]$e);' +
    'if($e -and $e.Count){$e|%{$_.ToString()};exit 1}';
  const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', check], { env: { ...process.env, PS_SRC: installer.encodePs(script) }, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}\n${script}`);
});

test('install links the anywhere command; uninstall removes only links it owns', { skip: posixOnly }, async (t) => {
  const sb = sandbox(t);
  const res = await installer.install({ mcp: false, quiet: true });
  const link = path.join(sb.binDir, 'anywhere');
  assert.equal(res.cli.linked, true);
  assert.equal(fs.readlinkSync(link), path.join(ROOT, 'bin', 'anywhere'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(sb.state, 'install.json'), 'utf8')).cliLink, link);
  const un = await installer.uninstall({ quiet: true, mcp: false });
  assert.ok(un.removed.includes(link));
  assert.ok(!fs.existsSync(link) && !fs.lstatSync(sb.binDir).isFile());

  // install.sh's link into <state>/app/bin is ours too.
  fs.mkdirSync(path.join(sb.state, 'app', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sb.state, 'app', 'bin', 'anywhere'), '#!/bin/sh\n');
  fs.symlinkSync(path.join(sb.state, 'app', 'bin', 'anywhere'), link);
  await installer.uninstall({ quiet: true, mcp: false });
  assert.throws(() => fs.lstatSync(link), /ENOENT/);

  // Someone else's file or link stays.
  fs.writeFileSync(link, '#!/bin/sh\necho mine\n');
  const kept = await installer.install({ mcp: false, quiet: true });
  assert.equal(kept.cli.linked, false);
  assert.match(kept.cli.reason, /not a link/);
  await installer.uninstall({ quiet: true, mcp: false });
  assert.equal(fs.readFileSync(link, 'utf8'), '#!/bin/sh\necho mine\n');
  fs.unlinkSync(link);
  fs.symlinkSync('/usr/bin/env', link);
  assert.equal(installer.linkCli().linked, false);
  await installer.uninstall({ quiet: true, mcp: false });
  assert.equal(fs.readlinkSync(link), '/usr/bin/env');

  // ANYWHERE_NO_LINK=1 (install.sh's switch) skips it.
  fs.unlinkSync(link);
  process.env.ANYWHERE_NO_LINK = '1';
  t.after(() => delete process.env.ANYWHERE_NO_LINK);
  const skipped = await installer.install({ mcp: false, quiet: true });
  assert.equal(skipped.cli.skipped, true);
  assert.throws(() => fs.lstatSync(link), /ENOENT/);
});

// ------------------------------------------------------------ JOURNEYS-DOCS-16: Electron download

function fakeNpm(dir, { fail = false } = {}) {
  const npm = path.join(dir, 'fake-npm');
  fs.writeFileSync(
    npm,
    `#!${process.execPath}\n` +
      "const fs=require('fs');const path=require('path');\n" +
      "const a=process.argv.slice(2);const prefix=a[a.indexOf('--prefix')+1];\n" +
      (fail ? "process.stderr.write('network error\\n');process.exit(1);\n" : '') +
      "const mod=path.join(prefix,'node_modules','electron');fs.mkdirSync(path.join(mod,'dist'),{recursive:true});\n" +
      "fs.writeFileSync(path.join(mod,'dist','electron'),'');\n" +
      "fs.writeFileSync(path.join(mod,'index.js'),\"module.exports=require('path').join(__dirname,'dist','electron');\");\n" +
      "fs.writeFileSync(path.join(prefix,'package.json'),'{}');\n",
    { mode: 0o755 }
  );
  return npm;
}

test('Electron downloads into a temporary prefix and moves into place only when complete', { skip: posixOnly }, async (t) => {
  const sb = sandbox(t);
  const prefix = path.join(sb.state, 'electron');
  const failed = await installer.installElectron({ npm: fakeNpm(sb.base, { fail: true }) });
  assert.equal(failed.installed, false);
  assert.match(failed.reason, /npm exited with code 1/);
  assert.deepEqual(fs.readdirSync(sb.state).filter((n) => n.startsWith('electron')), [], 'nothing half-installed is left');

  // A leftover of an interrupted run (its pid is gone) is cleaned up by the next install.
  fs.mkdirSync(path.join(sb.state, 'electron.partial-999999999', 'node_modules'), { recursive: true });
  const ok = await installer.installElectron({ npm: fakeNpm(sb.base) });
  assert.equal(ok.installed, true, ok.reason);
  assert.equal(ok.prefix, prefix);
  assert.equal(ok.binary, path.join(prefix, 'node_modules', 'electron', 'dist', 'electron'));
  assert.deepEqual(fs.readdirSync(sb.state).filter((n) => n.startsWith('electron')), ['electron']);

  // Reinstalling replaces the old prefix.
  fs.writeFileSync(path.join(prefix, 'old-marker'), '');
  assert.equal((await installer.installElectron({ npm: fakeNpm(sb.base) })).installed, true);
  assert.ok(!fs.existsSync(path.join(prefix, 'old-marker')));
  fs.mkdirSync(path.join(sb.state, 'electron.partial-999999998'));
  const un = await installer.uninstall({ quiet: true, mcp: false });
  assert.ok(un.removed.includes(prefix) && un.removed.includes(path.join(sb.state, 'electron.partial-999999998')));
});

test('SKILL.md runs install --electron with a long Bash timeout and names the voice trade-off', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills', 'anywhere', 'SKILL.md'), 'utf8');
  const doctor = text.slice(text.indexOf('## 5.'), text.indexOf('## 6.'));
  assert.match(doctor, /install --electron`, mention its trade-off: voice input in Electron needs/);
  assert.match(doctor, /`timeout` set to `600000`/);
});

// ------------------------------------------------------------ JOURNEYS-DOCS-7 / LIFECYCLE-4: busy switches

test('a busy dialog keeps its project unless --switch; symlinked paths are the same project', { skip: posixOnly }, async (t) => {
  const a = tmpDir('anywhere-r2-a-');
  const b = tmpDir('anywhere-r2-b-');
  let state = snapshot({ dir: a, status: 'acting' });
  let projectStatus = 200;
  const d = await fakeDaemon(
    (req) => {
      if (req.url === '/api/state') return state;
      if (req.url === '/api/project') return projectStatus === 200 ? { ok: true } : { __status: projectStatus, error: 'A task is running in a; stop it first' };
      return { __status: 404, error: 'not found' };
    },
    { project: a }
  );
  t.after(async () => {
    await d.close();
    for (const p of [a, b]) fs.rmSync(p, { recursive: true, force: true });
  });

  const held = await runCli(['start', '--no-open', '--project', b, '--json'], { env: d.env });
  assert.equal(held.code, 0, held.stderr);
  const out = JSON.parse(held.stdout);
  assert.equal(out.busy, 'a task is running');
  assert.match(out.notes.join('\n'), new RegExp(`busy in ${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(a task is running\\), so it stays on that project; rerun with --switch`));
  assert.ok(!d.urls().includes('POST /api/project'), 'the running task was not stopped');

  // Waiting approvals count as busy too.
  state = snapshot({ dir: a, status: 'idle', pending: { approvals: [{ id: 'x' }], questions: [] } });
  const human = await runCli(['start', '--no-open', '--project', b], { env: d.env });
  assert.match(human.stdout, /an approval is waiting/);
  assert.ok(!d.urls().includes('POST /api/project'));

  // --switch stops it on purpose (force: true for the daemon).
  const forced = await runCli(['start', '--no-open', '--switch', '--project', b, '--json'], { env: d.env });
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual(d.requests.find((q) => q.url === '/api/project').body, { dir: b, force: true });
  assert.match(JSON.parse(forced.stdout).notes.join('\n'), /switched the project to .*the running task was stopped/);

  // A daemon that refuses (HTTP 409) is reported the same way.
  state = snapshot({ dir: a, status: 'idle' });
  projectStatus = 409;
  const refused = await runCli(['start', '--no-open', '--project', b, '--json'], { env: d.env });
  assert.match(JSON.parse(refused.stdout).notes.join('\n'), /stays on that project/);

  // The same folder through a symlink is not a switch at all.
  const link = path.join(os.tmpdir(), `anywhere-r2-link-${process.pid}`);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(a, link);
  t.after(() => fs.rmSync(link, { force: true }));
  const before = d.requests.length;
  const same = await runCli(['start', '--no-open', '--project', link, '--json'], { env: d.env });
  assert.equal(same.code, 0, same.stderr);
  assert.deepEqual(JSON.parse(same.stdout).notes, []);
  assert.equal(d.requests.length, before, 'no state read, no switch');
  assert.ok(cli.samePath(link, a));
});

test('send --project refuses to hand a task to a dialog busy elsewhere', { skip: posixOnly }, async (t) => {
  const a = tmpDir('anywhere-r2-a-');
  const b = tmpDir('anywhere-r2-b-');
  const d = await fakeDaemon(
    (req) => {
      if (req.url === '/api/state') return snapshot({ dir: a, status: 'thinking' });
      if (req.url === '/api/command') return { ok: true, id: 'c1' };
      return { ok: true };
    },
    { project: a }
  );
  t.after(async () => {
    await d.close();
    for (const p of [a, b]) fs.rmSync(p, { recursive: true, force: true });
  });
  const r = await runCli(['send', '--project', b, 'deploy it'], { env: d.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Not sent: the dialog is busy in .* \(a task is running\), so it was not switched to/);
  assert.ok(!d.urls().includes('POST /api/command'));
  assert.ok(!d.urls().includes('POST /api/project'));
  const same = await runCli(['send', '--project', a, 'queue it here'], { env: d.env });
  assert.equal(same.code, 0, same.stderr);
  assert.ok(d.urls().includes('POST /api/command'));
});

test('busyReason reads the snapshot', () => {
  assert.equal(cli.busyReason(null), '');
  assert.equal(cli.busyReason(snapshot()), '');
  for (const status of ['starting', 'thinking', 'acting', 'waiting_approval', 'waiting_answer']) assert.equal(cli.busyReason(snapshot({ status })), 'a task is running', status);
  assert.equal(cli.busyReason(snapshot({ pending: { approvals: [], questions: [{}, {}] } })), '2 questions are waiting for answers');
  assert.equal(cli.busyReason(snapshot({ status: 'error' })), '');
});

test('config set mode reports a busy dialog (HTTP 409) instead of asking for a restart', async (t) => {
  const d = await fakeDaemon((req) => {
    if (req.url === '/api/config') return {};
    if (req.url === '/api/mode') return { __status: 409, error: 'A task is running' };
    return { __status: 404, error: 'nope' };
  });
  t.after(() => d.close());
  const r = await runCli(['config', 'set', 'mode', 'bridge'], { env: d.env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /keeps its mode while a task runs/);
  assert.doesNotMatch(r.stdout, /restart to apply/);
});

// ------------------------------------------------------------ JOURNEYS-DOCS-2: forgotten bridge mode

test('start without --mode takes a bridge dialog nobody listens to back to companion mode', async (t) => {
  const dir = tmpDir();
  let state = snapshot({ dir, mode: 'bridge', bridge: { listening: false } });
  const d = await fakeDaemon(
    (req) => {
      if (req.url === '/api/state') return state;
      if (req.url === '/api/mode') return { ok: true, mode: req.body.mode };
      return { __status: 404, error: 'not found' };
    },
    { project: dir, mode: 'bridge' }
  );
  t.after(async () => {
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const r = await runCli(['start', '--no-open', '--project', dir, '--json'], { env: d.env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(d.requests.filter((q) => q.url === '/api/mode').map((q) => q.body), [{ mode: 'companion' }]);
  assert.match(JSON.parse(r.stdout).notes.join('\n'), /switched back to companion mode \(no Claude Code terminal was listening\)/);

  // A terminal is listening (another /anywhere here), or one was asked for: bridge mode stays.
  state = snapshot({ dir, mode: 'bridge', bridge: { listening: true } });
  await runCli(['start', '--no-open', '--project', dir], { env: d.env });
  await runCli(['start', '--no-open', '--mode', 'bridge', '--project', dir], { env: d.env });
  state = snapshot({ dir, mode: 'bridge', status: 'acting' });
  await runCli(['start', '--no-open', '--project', dir], { env: d.env });
  assert.equal(d.requests.filter((q) => q.url === '/api/mode').length, 1);
});

test('send warns when its task waits for a terminal that is not listening', async (t) => {
  let answer = { ok: true, id: 'c1', mode: 'bridge', bridge: { listening: false } };
  let state = null;
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(req.url);
      const out = req.url === '/api/command' ? answer : req.url === '/api/state' && state ? state : null;
      res.writeHead(out ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out || { error: 'not found' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const env = childEnv({ ANYWHERE_DAEMON_URL: `http://127.0.0.1:${server.address().port}`, ANYWHERE_TOKEN: 't' });

  const warned = await runCli(['send', 'deploy it'], { env });
  assert.equal(warned.code, 0, warned.stderr);
  assert.match(warned.stdout, /It is queued in the dialog\./);
  assert.match(warned.stdout, /! The dialog is in bridge mode and no Claude Code terminal is listening/);
  const json = JSON.parse((await runCli(['send', '--json', 'deploy it'], { env })).stdout);
  assert.equal(json.mode, 'bridge');
  assert.match(json.warning, /no Claude Code terminal is listening/);

  // An older daemon without mode in the answer: the snapshot tells.
  answer = { ok: true, id: 'c2' };
  state = snapshot({ mode: 'bridge', bridge: { listening: false } });
  assert.match((await runCli(['send', 'x'], { env })).stdout, /no Claude Code terminal is listening/);
  state = snapshot({ mode: 'bridge', bridge: { listening: true } });
  const fine = await runCli(['send', 'x'], { env });
  assert.doesNotMatch(fine.stdout, /not listening|! /);
  assert.match(fine.stdout, /Follow along in the dialog/);
  answer = { ok: true, id: 'c3', mode: 'companion' };
  assert.doesNotMatch((await runCli(['send', 'x'], { env })).stdout, /bridge mode/);
});

test('SKILL.md tells the user what Esc leaves behind and relays busy and bridge warnings', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills', 'anywhere', 'SKILL.md'), 'utf8');
  assert.match(text, /stays in bridge mode until the next\s+`\/anywhere`/);
  assert.match(text, /busy in <folder>/);
  assert.match(text, /If `send` printed a `!` warning/);
  assert.match(text, /do not send the task/);
  assert.doesNotMatch(text, /use the terminal dialog: `run\.js tui`/, 'Claude does not run the interactive TUI itself');
});

// ------------------------------------------------------------ LIFECYCLE-3 / -13: kill only the daemon

test('daemonIdentity needs a matching start time and command line', async () => {
  const startedAt = new Date(Date.now() - 60000).toISOString();
  const recorded = Date.parse(startedAt);
  const raw = { pid: 4242, startedAt };
  const id = (o) => ({ startMs: null, startTicks: null, cmdline: null, ...o });
  assert.equal(await cli.daemonIdentity(raw, id({ startMs: recorded - 300, cmdline: 'claude-anywhere-daemon' })), 'match');
  assert.equal(await cli.daemonIdentity(raw, id({ startMs: recorded - 300, cmdline: '/usr/bin/node /opt/claude-anywhere/bin/anywhere.js daemon --project /p' })), 'match');
  assert.equal(await cli.daemonIdentity(raw, id({ startMs: recorded - 300, cmdline: '"C:\\Program Files\\nodejs\\node.exe" "C:\\a\\bin\\anywhere.js" daemon --project C:\\p' })), 'match');
  // Started after daemon.json was written: the pid was reused.
  assert.equal(await cli.daemonIdentity(raw, id({ startMs: recorded + 30000, cmdline: 'claude-anywhere-daemon' })), 'mismatch');
  // Any other program, even another node or Claude Anywhere process.
  for (const cmd of ['node /home/me/.vscode/extensions/tsserver.js', 'node /home/me/claude-anywhere/src/mcp/server.js', 'node /a/bin/anywhere.js tui', '/opt/chrome --user-data-dir=/home/me/.claude-anywhere/ui-profile']) {
    assert.equal(await cli.daemonIdentity(raw, id({ startMs: recorded - 300, cmdline: cmd })), 'mismatch', cmd);
  }
  // Unknown start time or command line: never a kill.
  assert.equal(await cli.daemonIdentity(raw, id({ cmdline: 'claude-anywhere-daemon' })), 'unknown');
  assert.equal(await cli.daemonIdentity(raw, id({ startMs: recorded - 300 })), 'unknown');
  assert.equal(await cli.daemonIdentity({ pid: 1 }, id({ startMs: 0, cmdline: 'claude-anywhere-daemon' })), 'unknown');
  // A recorded tick count is compared exactly.
  assert.equal(await cli.daemonIdentity({ ...raw, startTicks: 5 }, id({ startTicks: 6, startMs: recorded - 300, cmdline: 'claude-anywhere-daemon' })), 'mismatch');
  assert.equal(await cli.daemonIdentity({ ...raw, startTicks: 5 }, id({ startTicks: 5, startMs: recorded + 99999, cmdline: 'claude-anywhere-daemon' })), 'match');
  assert.equal(cli.parseEtime('01:02'), 62);
  assert.equal(cli.parseEtime('03:00:05'), 10805);
  assert.equal(cli.parseEtime('2-00:00:01'), 172801);
  assert.equal(cli.parseEtime('garbage'), null);
  assert.equal(cli.looksLikeDaemon(null), null);
});

function spawnSleeper(title) {
  const code = `${title ? `process.title=${JSON.stringify(title)};` : ''}setTimeout(()=>{},60000)`;
  return spawn(process.execPath, ['-e', code, 'daemon'], { stdio: 'ignore' });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

test('stop leaves a process that reused a stale daemon.json pid alone, and kills a hung daemon', { skip: process.platform === 'win32' ? 'POSIX process tools' : false, timeout: 60000 }, async (t) => {
  const env = childEnv();
  const deadPort = await new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const other = spawnSleeper(null);
  t.after(() => other.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 300));
  // The daemon "started" an hour ago; the process now holding its pid started just now.
  const stale = { pid: other.pid, port: deadPort, token: 't', instanceId: 'gone', startedAt: new Date(Date.now() - 3600 * 1000).toISOString() };
  fs.writeFileSync(path.join(env.ANYWHERE_HOME, 'daemon.json'), JSON.stringify(stale));
  const r = await runCli(['stop', '--json'], { env });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.stopped, false);
  assert.equal(out.stale, true);
  assert.ok(alive(other.pid), 'the unrelated process survives');
  assert.ok(!fs.existsSync(path.join(env.ANYWHERE_HOME, 'daemon.json')));

  // A process that runs the daemon's command line and started before daemon.json was written.
  const hung = spawnSleeper('claude-anywhere-daemon');
  t.after(() => hung.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(env.ANYWHERE_HOME, 'daemon.json'), JSON.stringify({ ...stale, pid: hung.pid, startedAt: new Date().toISOString() }));
  const k = await runCli(['stop', '--json'], { env });
  assert.equal(k.code, 0, k.stderr);
  assert.equal(JSON.parse(k.stdout).stopped, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!alive(hung.pid), 'the hung daemon was killed');
});

test('Windows stops a hung daemon tree with taskkill /T before TerminateProcess', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  const body = src.slice(src.indexOf('async function killPid('), src.indexOf('async function stopDaemon('));
  const win = body.slice(body.indexOf("if (process.platform === 'win32')"));
  assert.ok(win.indexOf("'taskkill'") > 0 && win.indexOf("'taskkill'") < win.indexOf('process.kill('), 'taskkill runs first on Windows');
  assert.doesNotMatch(src, /tasklist/, 'no "any node process" identity check is left');
});

// ------------------------------------------------------------ doctor: headless, WSL, Electron

function doctorEnv(t, extra = {}) {
  const dir = tmpDir('anywhere-r2-doc-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(fakeBin);
  // A stand-in claude: answers --version, has no MCP registration.
  fs.writeFileSync(path.join(fakeBin, 'claude'), `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('2.1.300 (Claude Code)');process.exit(0)}\nprocess.exit(1)\n`, { mode: 0o755 });
  const env = childEnv({ ANYWHERE_CLAUDE_PATH: path.join(fakeBin, 'claude'), ...extra });
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'WSL_DISTRO_NAME', 'WSL_INTEROP']) if (!(k in extra)) delete env[k];
  return { env, fakeBin, dir };
}

const linuxOnly = process.platform === 'linux' && !process.env.WSL_DISTRO_NAME && !fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') ? false : 'Linux (not WSL) only';

test('headless doctor: no display is a warning, not a blocker', { skip: linuxOnly, timeout: 120000 }, async (t) => {
  const { env } = doctorEnv(t);
  const r = await runCli(['doctor', '--json'], { env, timeoutMs: 110000 });
  const report = JSON.parse(r.stdout);
  const driver = report.checks.find((c) => c.id === 'driver');
  assert.equal(driver.status, 'warn', JSON.stringify(driver));
  assert.match(driver.detail, /no graphical display/);
  assert.match(driver.fix, /terminal dialog: node ".*anywhere\.js" tui/, 'the full command, since anywhere is not on PATH');
  assert.equal(report.ok, true);
  assert.equal(r.code, 0);
  const human = await runCli(['doctor'], { env, timeoutMs: 110000 });
  assert.doesNotMatch(human.stdout, /Fix first/);
});

test('WSL doctor counts the Windows browser reached through powershell.exe', { skip: linuxOnly, timeout: 120000 }, async (t) => {
  const { env, fakeBin } = doctorEnv(t, { WSL_DISTRO_NAME: 'Ubuntu', ANYWHERE_DRIVER: 'mock' });
  fs.writeFileSync(path.join(fakeBin, 'powershell.exe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const withPs = { ...env, PATH: `${fakeBin}${path.delimiter}${env.PATH}` };
  const report = JSON.parse((await runCli(['doctor', '--json'], { env: withPs, timeoutMs: 110000 })).stdout);
  const ui = report.checks.find((c) => c.id === 'ui');
  assert.match(ui.detail, /app window: Windows Edge\/Chrome \(via powershell\.exe\)/);
  assert.equal(ui.status, 'ok', JSON.stringify(ui));
  const voice = report.checks.find((c) => c.id === 'voice');
  assert.match(voice.detail, /speech-to-text: browser \(Chrome\/Edge\)/);
  assert.equal(voice.status, 'ok', JSON.stringify(voice));

  // Without interop the interop hint is the advice.
  const noPs = JSON.parse((await runCli(['doctor', '--json'], { env, timeoutMs: 110000 })).stdout);
  const ui2 = noPs.checks.find((c) => c.id === 'ui');
  assert.match(`${ui2.fix} ${ui2.notes.join(' ')}`, /\[interop\] enabled=true and appendWindowsPath=true/);
});

test('with Electron as the dialog, doctor does not promise browser speech', { skip: linuxOnly, timeout: 120000 }, async (t) => {
  const { env, dir } = doctorEnv(t, { ANYWHERE_DRIVER: 'mock' });
  const electron = path.join(dir, 'electron');
  fs.writeFileSync(electron, '');
  const report = JSON.parse((await runCli(['doctor', '--json'], { env: { ...env, ANYWHERE_ELECTRON: electron }, timeoutMs: 110000 })).stdout);
  const voice = report.checks.find((c) => c.id === 'voice');
  assert.match(voice.detail, /no browser speech in the Electron window/);
  const ui = report.checks.find((c) => c.id === 'ui');
  if (/server none/.test(voice.detail)) {
    assert.equal(voice.status, 'warn');
    assert.match(voice.fix, /Voice input in Electron needs GROQ_API_KEY or OPENAI_API_KEY, or whisper\.cpp/);
    assert.ok(ui.notes.some((n) => /The dialog opens in Electron\. Voice input in Electron needs/.test(n)), JSON.stringify(ui));
  }
  assert.notEqual(ui.status, 'warn');
});

// ------------------------------------------------------------ JOURNEYS-DOCS-9: plugin detection

test('findPluginInstall trusts installed_plugins.json, not a marketplace clone or cache leftovers', (t) => {
  const home = tmpDir('anywhere-r2-claude-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pluginCopy = (rel) => {
    const dir = path.join(home, 'plugins', ...rel.split('/'));
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills', 'anywhere'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'anywhere' }));
    fs.writeFileSync(path.join(dir, 'skills', 'anywhere', 'SKILL.md'), '---\nname: anywhere\n---\n');
    return dir;
  };
  // Only `/plugin marketplace add`: the clone holds the plugin files, nothing is installed.
  pluginCopy('marketplaces/anywhere-marketplace');
  assert.equal(cli.findPluginInstall(home), null);
  // Installed (manifest version 2, as Claude Code 2.1 writes it).
  const cache = pluginCopy('cache/anywhere-marketplace/anywhere/0.1.0');
  const manifest = path.join(home, 'plugins', 'installed_plugins.json');
  fs.writeFileSync(manifest, JSON.stringify({ version: 2, plugins: { 'anywhere@anywhere-marketplace': [{ scope: 'user', installPath: cache, version: '0.1.0' }] } }));
  assert.equal(cli.findPluginInstall(home), cache);
  // Version 1 entries.
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, plugins: { 'anywhere@anywhere-marketplace': { version: '0.1.0', installPath: cache } } }));
  assert.equal(cli.findPluginInstall(home), cache);
  // After /plugin uninstall the cache copy stays, the manifest entry goes.
  fs.writeFileSync(manifest, JSON.stringify({ version: 2, plugins: { 'other@x': [{ installPath: cache }] } }));
  assert.equal(cli.findPluginInstall(home), null);
  // A listed path that is gone does not count.
  fs.writeFileSync(manifest, JSON.stringify({ version: 2, plugins: { 'anywhere@m': [{ installPath: path.join(home, 'nope') }] } }));
  assert.equal(cli.findPluginInstall(home), null);
  // No manifest at all: the folder walk still skips marketplaces/.
  fs.unlinkSync(manifest);
  assert.equal(cli.findPluginInstall(home), cache);

  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'anywhere@anywhere-marketplace': false } }));
  assert.equal(cli.pluginDisabled(home), true);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'anywhere@anywhere-marketplace': true } }));
  assert.equal(cli.pluginDisabled(home), false);
});

test('doctor does not report the plugin from a marketplace clone alone', { timeout: 120000 }, async (t) => {
  const { env } = doctorEnv(t, { ANYWHERE_DRIVER: 'mock' });
  const clone = path.join(env.CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'anywhere-marketplace');
  fs.mkdirSync(path.join(clone, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(clone, 'skills', 'anywhere'), { recursive: true });
  fs.writeFileSync(path.join(clone, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'anywhere' }));
  fs.writeFileSync(path.join(clone, 'skills', 'anywhere', 'SKILL.md'), '---\nname: anywhere\n---\n');
  const report = JSON.parse((await runCli(['doctor', '--json'], { env, timeoutMs: 110000 })).stdout);
  const skill = report.checks.find((c) => c.id === 'skill');
  const mcp = report.checks.find((c) => c.id === 'mcp');
  assert.equal(skill.status, 'warn', JSON.stringify(skill));
  assert.match(skill.detail, /not installed/);
  assert.doesNotMatch(mcp.detail, /provided by the anywhere plugin/);
});

// ------------------------------------------------------------ JOURNEYS-DOCS-10: the printed command

test('hints name the full node command unless this package is "anywhere" on PATH', { skip: posixOnly }, async (t) => {
  const env = childEnv();
  const r = await runCli(['url'], { env });
  assert.equal(r.code, 4);
  assert.ok(r.stderr.includes(`run: node "${BIN}" start`), r.stderr);

  // A link in a PATH folder (install.sh / anywhere install): plain "anywhere".
  const binDir = tmpDir('anywhere-r2-bin-');
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(ROOT, 'bin', 'anywhere'), path.join(binDir, 'anywhere'));
  const linked = await runCli(['url'], { env: { ...env, PATH: `${binDir}${path.delimiter}${env.PATH}` } });
  assert.match(linked.stderr, /or run: anywhere start/);

  // A plugin's own bin/ on PATH is Claude Code's Bash PATH, not the user's: full command.
  const claudeHome = path.join(env.ANYWHERE_HOME, 'claude');
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.symlinkSync(path.dirname(ROOT), path.join(claudeHome, 'plugins'));
  const plugin = await runCli(['url'], { env: { ...env, CLAUDE_CONFIG_DIR: claudeHome, PATH: `${path.join(ROOT, 'bin')}${path.delimiter}${env.PATH}` } });
  assert.ok(plugin.stderr.includes(`node "${BIN}" start`), plugin.stderr);
  // The same bin/ on PATH for a non-plugin install (install.ps1 adds app\bin): plain "anywhere".
  const direct = await runCli(['url'], { env: { ...env, PATH: `${path.join(ROOT, 'bin')}${path.delimiter}${env.PATH}` } });
  assert.match(direct.stderr, /or run: anywhere start/);
});
