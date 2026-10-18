'use strict';

/**
 * Regression tests for the round-3 cli-skill-docs fixes: bridge commands that only wait for a
 * terminal no longer count as "a task is running", and every case that keeps bridge mode says so
 * (REGRESSIONS-R2-2, LIVE-E2E-R3-8); the token URL stays out of doctor, send, --json and logs
 * output (REGRESSIONS-R2-4, LIVE-E2E-R3-9); doctor's label column (LIVE-E2E-R3-13); Windows
 * `start --foreground` daemons are recognized by stop (REGRESSIONS-R2-7); plugin installs link a
 * stable launcher instead of the versioned plugin folder (REGRESSIONS-R2-10); the skill may read
 * the bridge images and CLI screenshots (LIVE-E2E-R3-7).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'anywhere.js');
const cli = require('../bin/anywhere.js');
const installer = require('../scripts/install.js');
const runMod = require('../skills/anywhere/run.js');

const posixOnly = process.platform === 'win32' ? 'POSIX-only (symlinks, shebang scripts)' : false;
const haveDaemon = ['src/daemon/main.js', 'src/daemon/server.js', 'src/daemon/session.js'].every((rel) => fs.existsSync(path.join(ROOT, rel)));

function tmpDir(prefix = 'anywhere-r3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pathWithoutAnywhere() {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, 'anywhere')) && !fs.existsSync(path.join(d, 'anywhere.cmd')))
    .join(path.delimiter);
}

function childEnv(extra = {}) {
  const home = tmpDir('anywhere-r3-home-');
  const env = { ...process.env, ANYWHERE_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), NO_COLOR: '1', PATH: pathWithoutAnywhere() };
  for (const k of ['ANYWHERE_DAEMON_URL', 'ANYWHERE_TOKEN', 'ANYWHERE_DRIVER', 'FORCE_COLOR', 'ANYWHERE_ELECTRON', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANYWHERE_STT_API_KEY']) delete env[k];
  return { ...env, ...extra };
}

function run(command, args, { env, input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env || childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out: ${command} ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input == null ? undefined : input);
  });
}

const runCli = (args, opts) => run(process.execPath, [BIN, ...args], opts);

/** A fake daemon found through daemon.json: /api/health answers without a token, the rest goes to `handler`. */
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
  const daemonJson = { pid: process.pid, port, token: 'fake-token-123', instanceId: 'fake-instance', version: '0.1.0', startedAt: new Date().toISOString(), project, mode, url: `http://127.0.0.1:${port}/?token=fake-token-123` };
  fs.writeFileSync(path.join(env.ANYWHERE_HOME, 'daemon.json'), JSON.stringify(daemonJson));
  return {
    port,
    requests,
    env,
    modeBodies: () => requests.filter((q) => q.url === '/api/mode').map((q) => q.body),
    close: () => new Promise((r) => server.close(r)),
  };
}

function snapshot(over = {}) {
  return { mode: 'companion', status: 'idle', project: { dir: over.dir || '/x' }, pending: { approvals: [], questions: [] }, bridge: { listening: false, queued: 0 }, ...over };
}

/** A bridge dialog whose commands only wait for a terminal (`/anywhere here` ended with Esc). */
function waitingSnap(dir, queued = 1) {
  return snapshot({ dir, mode: 'bridge', status: 'queued', bridge: { listening: false, queued } });
}

const notesOf = (r) => JSON.parse(r.stdout).notes.join('\n');

// ------------------------------------------------------------ REGRESSIONS-R2-2 / LIVE-E2E-R3-8

test('commands that only wait for a terminal are not "a task is running"', () => {
  assert.equal(cli.busyReason(waitingSnap('/p')), 'a command waits for a Claude Code terminal, and none is listening');
  assert.equal(cli.busyReason(waitingSnap('/p', 3)), '3 commands wait for a Claude Code terminal, and none is listening');
  // A listening terminal (or one still in its grace period) has them: that is work in progress.
  assert.equal(cli.busyReason(snapshot({ mode: 'bridge', status: 'queued', bridge: { listening: true, queued: 1 } })), 'a task is running');
  // Open cards come first; companion mode's queue is real work.
  assert.equal(cli.busyReason(snapshot({ mode: 'bridge', status: 'queued', pending: { approvals: [{}], questions: [] } })), 'an approval is waiting');
  assert.equal(cli.busyReason(snapshot({ mode: 'companion', status: 'queued' })), 'a task is running');
  assert.equal(cli.busyReason(snapshot({ mode: 'bridge', status: 'acting' })), 'a task is running');
});

test('plain start hands a bridge dialog with a waiting command back, or says why it stays', async (t) => {
  const dir = tmpDir();
  let state = waitingSnap(dir);
  let modeAnswer = { __status: 409, error: 'A task is running in x; stop it first' };
  const d = await fakeDaemon(
    (req) => {
      if (req.url === '/api/state') return state;
      if (req.url === '/api/mode') return modeAnswer;
      return { __status: 404, error: 'not found' };
    },
    { project: dir, mode: 'bridge' }
  );
  t.after(async () => {
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A daemon that would drop the command refuses (409): the CLI asked without force and explains.
  let r = await runCli(['start', '--no-open', '--project', dir, '--json'], { env: d.env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(d.modeBodies(), [{ mode: 'companion' }], 'tried the switch, never forced it');
  let notes = notesOf(r);
  assert.match(notes, /still in bridge mode: a command waits for a Claude Code terminal, and none is listening\. Run \/anywhere here in Claude Code to pick it up, or rerun with --mode companion --switch to hand the dialog back to its own session \(this drops that command\)/);
  assert.doesNotMatch(notes, /a task is running/);
  assert.equal(JSON.parse(r.stdout).mode, 'bridge');

  // A daemon that moves the waiting commands into the companion session reports it.
  modeAnswer = { ok: true, mode: 'companion', moved: 1 };
  r = await runCli(['start', '--no-open', '--project', dir, '--json'], { env: d.env });
  assert.match(notesOf(r), /switched back to companion mode \(no Claude Code terminal was listening\); the command that waited for a terminal now runs in the dialog's own session/);
  // One that accepts without moving them dropped them: say so.
  modeAnswer = { ok: true, mode: 'companion' };
  state = waitingSnap(dir, 2);
  r = await runCli(['start', '--no-open', '--project', dir, '--json'], { env: d.env });
  assert.match(notesOf(r), /the 2 commands that waited for a terminal were dropped \(send them again\)/);

  // Every case that keeps bridge mode prints a note, and none of them switches.
  const before = d.modeBodies().length;
  const cases = [
    [snapshot({ dir, mode: 'bridge', bridge: { listening: true, queued: 0 } }), /still in bridge mode: a Claude Code terminal is listening \(\/anywhere here\) and takes the dialog's commands; rerun with --mode companion to hand the dialog back/],
    [snapshot({ dir, mode: 'bridge', status: 'acting', bridge: { listening: true, queued: 0 } }), /still in bridge mode: a Claude Code terminal took a command from the dialog and has not finished it \(a task is running\); if that terminal was closed, rerun with --mode companion --switch/],
    [snapshot({ dir, mode: 'bridge', status: 'idle', pending: { approvals: [{}], questions: [] } }), /still in bridge mode \(an approval is waiting\); rerun with --mode companion --switch/],
  ];
  for (const [snap, re] of cases) {
    state = snap;
    const human = await runCli(['start', '--no-open', '--project', dir], { env: d.env });
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, re);
  }
  assert.equal(d.modeBodies().length, before);

  // An unreadable state is not silent either.
  state = { __status: 500, error: 'boom' };
  r = await runCli(['start', '--no-open', '--project', dir, '--json'], { env: d.env });
  assert.match(notesOf(r), /still in bridge mode \(its state could not be read\)/);
});

test('start --mode companion with a waiting command: tried without force, --switch drops it on purpose', async (t) => {
  const dir = tmpDir();
  const d = await fakeDaemon(
    (req) => {
      if (req.url === '/api/state') return waitingSnap(dir);
      if (req.url === '/api/mode') return req.body.force ? { ok: true, mode: 'companion' } : { __status: 409, error: 'A task is running in x; stop it first' };
      return { __status: 404, error: 'not found' };
    },
    { project: dir, mode: 'bridge' }
  );
  t.after(async () => {
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const held = await runCli(['start', '--no-open', '--mode', 'companion', '--project', dir, '--json'], { env: d.env });
  assert.equal(held.code, 0, held.stderr);
  const out = JSON.parse(held.stdout);
  assert.match(out.notes.join('\n'), /the dialog is busy \(a command waits for a Claude Code terminal, and none is listening\), so it stays in bridge mode; rerun with --switch to drop that command and switch to companion mode/);
  assert.match(out.busy, /waits for a Claude Code terminal/);
  const forced = await runCli(['start', '--no-open', '--mode', 'companion', '--switch', '--project', dir, '--json'], { env: d.env });
  assert.match(notesOf(forced), /switched to companion mode; the command that waited for a terminal was dropped \(send it again\)/);
  assert.deepEqual(d.modeBodies(), [{ mode: 'companion' }, { mode: 'companion', force: true }]);
});

test('send --project names the waiting command instead of "wait for it to finish"', async (t) => {
  const a = tmpDir('anywhere-r3-a-');
  const b = tmpDir('anywhere-r3-b-');
  const d = await fakeDaemon(
    (req) => {
      if (req.url === '/api/state') return waitingSnap(a);
      return { ok: true, id: 'c1' };
    },
    { project: a, mode: 'bridge' }
  );
  t.after(async () => {
    await d.close();
    for (const p of [a, b]) fs.rmSync(p, { recursive: true, force: true });
  });
  const r = await runCli(['send', '--project', b, 'deploy it'], { env: d.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Not sent: the dialog in .* has a command waiting for a Claude Code terminal \(none is listening\), so it was not switched to/);
  assert.match(r.stderr, /Run \/anywhere here in Claude Code to pick it up, rerun with --switch to switch anyway/);
  assert.doesNotMatch(r.stderr, /Wait for it to finish|a task is running/);
  assert.ok(!d.requests.some((q) => q.url === '/api/command' || q.url === '/api/project'));
});

test('the send warning names a command that switches (with --switch and the current project)', async (t) => {
  const dir = tmpDir();
  const d = await fakeDaemon(
    (req) => {
      if (req.url === '/api/command') return { ok: true, id: 'c1', mode: 'bridge', bridge: { listening: false } };
      return { __status: 404, error: 'not found' };
    },
    { project: dir, mode: 'bridge' }
  );
  t.after(async () => {
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const r = await runCli(['send', 'deploy it'], { env: d.env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`run: node ".*anywhere\\.js" start --mode companion --switch --project "${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}", then send the task again unless that output says it now runs in the dialog's own session`));
  assert.doesNotMatch(r.stdout, /start --mode companion\) and send it again/);
});

// ------------------------------------------------------------ REGRESSIONS-R2-4 / LIVE-E2E-R3-9 / LIVE-E2E-R3-13

test('doctor prints the bare dialog address, never the token, and does not cut labels', { timeout: 120000, skip: process.platform === 'win32' ? 'POSIX stand-in claude' : false }, async (t) => {
  const dir = tmpDir();
  const d = await fakeDaemon(() => ({ __status: 404, error: 'not found' }), { project: dir });
  t.after(async () => {
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'claude'), `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('2.1.300 (Claude Code)');process.exit(0)}\nprocess.exit(1)\n`, { mode: 0o755 });
  const env = { ...d.env, ANYWHERE_CLAUDE_PATH: path.join(fakeBin, 'claude'), ANYWHERE_DRIVER: 'mock' };
  const human = await runCli(['doctor'], { env, timeoutMs: 110000 });
  assert.doesNotMatch(human.stdout, /token=|fake-token-123/);
  assert.match(human.stdout, new RegExp(`Daemon\\s+running .* http://127\\.0\\.0\\.1:${d.port}/ \\(node ".*anywhere\\.js" url" prints the full link\\)|Daemon\\s+running .* http://127\\.0\\.0\\.1:${d.port}/ \\(.*url.* prints the full link\\)`));
  assert.match(human.stdout, /Claude Code allow rules /, 'the whole label');
  const json = await runCli(['doctor', '--json'], { env, timeoutMs: 110000 });
  assert.doesNotMatch(json.stdout, /token=|fake-token-123/);
});

test('renderDoctor sizes the label column to the longest label', () => {
  const report = {
    version: '0.1.0',
    platform: { osName: 'Linux', displayServer: 'x11' },
    checks: [
      { id: 'a', label: 'Node.js', status: 'ok', detail: 'v22', notes: [] },
      { id: 'b', label: 'Claude Code allow rules', status: 'ok', detail: 'no broad allow rules', notes: [] },
    ],
  };
  const out = cli.renderDoctor(report).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /Claude Code allow rules no broad allow rules/);
  const col = (line) => line.indexOf(line.includes('v22') ? 'v22' : 'no broad');
  const lines = out.split('\n').filter((l) => l.includes('v22') || l.includes('no broad'));
  assert.equal(col(lines[0]), col(lines[1]), 'details line up');
});

test('--json and status print the token URL only when the page must be opened by hand or with --show-token', async (t) => {
  const dir = tmpDir();
  let host = 'browser';
  const d = await fakeDaemon(
    (req) => {
      if (req.url === '/api/state') return snapshot({ dir });
      if (req.url === '/api/show') return { ok: true, host };
      return { __status: 404, error: 'not found' };
    },
    { project: dir }
  );
  t.after(async () => {
    await d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bare = `http://127.0.0.1:${d.port}/`;
  const full = `${bare}?token=fake-token-123`;
  const urlOf = async (args) => {
    const r = await runCli(args, { env: d.env });
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout).url;
  };
  assert.equal(await urlOf(['start', '--project', dir, '--json']), bare, 'a window opened');
  assert.equal(await urlOf(['start', '--project', dir, '--json', '--show-token']), full);
  assert.equal(await urlOf(['start', '--no-open', '--project', dir, '--json']), full, 'the user opens it');
  assert.equal(await urlOf(['status', '--json']), bare);
  assert.equal(await urlOf(['status', '--json', '--show-token']), full);
  assert.equal(await urlOf(['show', '--json']), bare);
  const status = await runCli(['status', '--show-token'], { env: d.env });
  assert.match(status.stdout, new RegExp(`Dialog {4}${full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  host = 'none';
  assert.equal(await urlOf(['start', '--project', dir, '--json']), full, 'no window could open');
  assert.equal(await urlOf(['show', '--json']), full);
  assert.equal(await urlOf(['url', '--json']), full, '`anywhere url` always prints it');
});

test('logs masks the token of a URL the daemon printed', async () => {
  const env = childEnv();
  const logs = path.join(env.ANYWHERE_HOME, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'daemon.log'), 'Claude Anywhere is running. Open this URL to use the dialog (no window host is available):\n  http://127.0.0.1:47120/?token=SECRETsecret_123-x\nOr run: anywhere tui\n');
  const r = await runCli(['logs', '-n', '10'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /http:\/\/127\.0\.0\.1:47120\/\?token=\*\*\*/);
  assert.doesNotMatch(r.stdout, /SECRET/);
});

test('send that starts the dialog prints the bare address', { skip: haveDaemon ? false : 'daemon modules missing', timeout: 90000 }, async (t) => {
  const env = childEnv({ ANYWHERE_DRIVER: 'mock' });
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY']) delete env[k];
  // Bridge mode: the task only queues, no Claude Code session starts. Port 0: any free port.
  fs.writeFileSync(path.join(env.ANYWHERE_HOME, 'config.json'), JSON.stringify({ port: 0, mode: 'bridge' }));
  const dir = tmpDir();
  t.after(async () => {
    await runCli(['stop'], { env }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(env.ANYWHERE_HOME, { recursive: true, force: true });
  });
  const r = await runCli(['send', '--no-open', '--project', dir, 'hello'], { env, timeoutMs: 80000 });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /Started Claude Anywhere for .* \(http:\/\/127\.0\.0\.1:\d+\/; .*url.* prints the full link\)/);
  assert.doesNotMatch(r.stdout + r.stderr, /token=/);
});

// ------------------------------------------------------------ REGRESSIONS-R2-7: Windows foreground daemons

test('a `start --foreground` daemon is recognized from its Windows command line', async () => {
  const startedAt = new Date(Date.now() - 60000).toISOString();
  const raw = { pid: 4242, startedAt };
  const id = (cmdline) => ({ startMs: Date.parse(startedAt) - 300, startTicks: null, cmdline });
  for (const cmd of [
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\claude-anywhere\\bin\\anywhere.js" start --foreground',
    '"node"  "C:\\Users\\me\\.claude-anywhere\\app\\bin\\anywhere.js" start --project C:\\p --foreground --mode bridge',
    'node.exe C:\\a\\bin\\anywhere.js restart --foreground',
    '/usr/bin/node /opt/claude-anywhere/bin/anywhere.js start --foreground',
  ]) {
    assert.equal(cli.looksLikeDaemon(cmd), true, cmd);
    assert.equal(await cli.daemonIdentity(raw, id(cmd)), 'match', cmd);
  }
  for (const cmd of ['node C:\\a\\bin\\anywhere.js start', 'node /a/bin/anywhere.js tui', 'node /a/bin/anywhere.js send start --foreground', 'node /a/bin/anywhere.js start --foregroundish']) {
    assert.equal(cli.looksLikeDaemon(cmd), false, cmd);
    assert.equal(await cli.daemonIdentity(raw, id(cmd)), 'mismatch', cmd);
  }
});

// ------------------------------------------------------------ REGRESSIONS-R2-10: plugin installs

function copyPackage(dest, version) {
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of ['bin', 'scripts', 'skills', 'src', '.claude-plugin']) fs.cpSync(path.join(ROOT, rel), path.join(dest, rel), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.version = version;
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(pkg, null, 2));
  return dest;
}

test('a plugin install links a stable launcher that follows /plugin update', { skip: posixOnly, timeout: 120000 }, async (t) => {
  const base = tmpDir('anywhere-r3-plugin-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const claudeHome = path.join(home, '.claude');
  const state = path.join(base, 'state');
  const binDir = path.join(home, 'bin');
  const pluginsDir = path.join(claudeHome, 'plugins');
  const cache = (v) => path.join(pluginsDir, 'cache', 'anywhere-marketplace', 'anywhere', v);
  const manifest = (v) =>
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'anywhere@anywhere-marketplace': [{ scope: 'user', installPath: cache(v), version: v }] } }));
  copyPackage(cache('0.1.0'), '0.1.0');
  manifest('0.1.0');
  const env = {
    ...childEnv(),
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeHome,
    ANYWHERE_HOME: state,
    ANYWHERE_BIN_DIR: binDir,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CURRENT_DESKTOP: '',
  };
  delete env.ANYWHERE_NO_LINK;
  fs.mkdirSync(home, { recursive: true });

  const inst = await run(process.execPath, [path.join(cache('0.1.0'), 'bin', 'anywhere.js'), 'install', '--no-mcp', '--hotkey'], { env, timeoutMs: 100000 });
  assert.equal(inst.code, 0, `${inst.stdout}\n${inst.stderr}`);
  const link = path.join(binDir, 'anywhere');
  const launcherDir = path.join(state, 'launcher');
  assert.equal(fs.readlinkSync(link), path.join(launcherDir, 'anywhere'), 'not the versioned plugin folder');
  const info = JSON.parse(fs.readFileSync(path.join(state, 'install.json'), 'utf8'));
  assert.equal(info.pluginsDir, pluginsDir);
  assert.equal(info.launcher, launcherDir);
  // The Linux launcher (.desktop entry) runs the stable launcher too.
  if (process.platform === 'linux') {
    const desktop = fs.readFileSync(path.join(home, '.local', 'share', 'applications', 'claude-anywhere.desktop'), 'utf8');
    assert.ok(desktop.includes(path.join(launcherDir, 'anywhere.js')), desktop);
    assert.ok(!desktop.includes(cache('0.1.0')), desktop);
  }

  const version = async (cmd, args = []) => {
    const r = await run(cmd, [...args, 'version'], { env, timeoutMs: 30000 });
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    return r.stdout.trim();
  };
  assert.match(await version(link), /0\.1\.0/);

  // /plugin update: a new versioned folder, the old one removed.
  copyPackage(cache('0.2.0'), '0.2.0');
  manifest('0.2.0');
  fs.rmSync(cache('0.1.0'), { recursive: true, force: true });
  assert.match(await version(link), /0\.2\.0/, 'the link runs the installed version');
  assert.match(await version(process.execPath, [path.join(launcherDir, 'anywhere.js')]), /0\.2\.0/, 'so does the hotkey command');
  assert.match(await version(process.execPath, [path.join(claudeHome, 'skills', 'anywhere', 'run.js')]), /0\.2\.0/, 'and the personal /anywhere skill');

  // Plugin uninstalled and its folders gone: the launcher stops, it never runs itself through PATH.
  fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
  fs.rmSync(cache('0.2.0'), { recursive: true, force: true });
  const gone = await run(link, ['version'], { env: { ...env, PATH: `${binDir}${path.delimiter}${env.PATH}` }, timeoutMs: 20000 });
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /not installed where this skill can find it/);

  // Uninstall (from another copy) removes the link and the launcher.
  const un = await runCli(['uninstall'], { env, timeoutMs: 60000 });
  assert.equal(un.code, 0, `${un.stdout}\n${un.stderr}`);
  assert.throws(() => fs.lstatSync(link), /ENOENT/);
  assert.ok(!fs.existsSync(launcherDir));
});

test('uninstall also removes a link an earlier version made into a versioned plugin folder', { skip: posixOnly }, (t) => {
  const base = tmpDir();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const target = path.join(base, '.claude', 'plugins', 'cache', 'mkt', 'anywhere', '0.1.0', 'bin', 'anywhere');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '#!/bin/sh\n');
  const link = path.join(base, 'anywhere');
  fs.symlinkSync(target, link);
  assert.equal(installer.isOurCliLink(link), true);
  const other = path.join(base, 'other');
  fs.symlinkSync('/usr/bin/env', other);
  assert.equal(installer.isOurCliLink(other), false);
});

test('run.js picks the installed plugin version and only trusts ../../bin inside a package', (t) => {
  const base = tmpDir();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const pluginsDir = path.join(base, 'plugins');
  const pkg = (rel) => {
    const dir = path.join(pluginsDir, ...rel.split('/'));
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'anywhere.js'), '');
    return dir;
  };
  const old = pkg('cache/mkt/anywhere/0.1.0');
  const cur = pkg('cache/mkt/anywhere/0.2.0');
  const other = pkg('cache/elsewhere/anywhere/9.0.0');
  const project = pkg('cache/mkt/anywhere/0.2.0-project');
  const write = (m) => fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify(m));
  write({ version: 2, plugins: { 'anywhere@elsewhere': [{ scope: 'user', installPath: other }], 'anywhere@mkt': [{ scope: 'project', installPath: project }, { scope: 'user', installPath: cur }] } });
  assert.equal(runMod.currentPluginRoot(pluginsDir, old), cur, 'same marketplace, user scope first');
  write({ version: 1, plugins: { 'anywhere@mkt': { installPath: cur } } });
  assert.equal(runMod.currentPluginRoot(pluginsDir, old), cur);
  write({ version: 2, plugins: { 'anywhere@mkt': [{ scope: 'user', installPath: path.join(base, 'gone') }] } });
  assert.equal(runMod.currentPluginRoot(pluginsDir, old), null);

  // install.json of a plugin install: the current version, else packageRoot.
  const state = path.join(base, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'install.json'), JSON.stringify({ packageRoot: old, pluginsDir }));
  const launcherDir = path.join(state, 'launcher');
  fs.mkdirSync(launcherDir);
  const opts = { skillDir: launcherDir, env: { ANYWHERE_HOME: state, PATH: '' }, homedir: base };
  assert.deepEqual(runMod.resolveLauncher(opts), { kind: 'script', script: path.join(old, 'bin', 'anywhere.js'), root: old, via: 'install.json' });
  write({ version: 2, plugins: { 'anywhere@mkt': [{ scope: 'user', installPath: cur }] } });
  assert.deepEqual(runMod.resolveLauncher(opts), { kind: 'script', script: path.join(cur, 'bin', 'anywhere.js'), root: cur, via: 'plugin' });

  // A ../../bin/anywhere.js next to a copy outside <package>/skills/anywhere is not the package.
  fs.mkdirSync(path.join(base, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(base, 'bin', 'anywhere.js'), '');
  const stray = path.join(base, 'x', 'launcher');
  fs.mkdirSync(stray, { recursive: true });
  assert.notEqual(runMod.resolveLauncher({ ...opts, skillDir: stray }).via, 'relative');
});

// ------------------------------------------------------------ LIVE-E2E-R3-7: the skill reads its images

test('SKILL.md lets the skill read the bridge images and says what to do otherwise', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills', 'anywhere', 'SKILL.md'), 'utf8');
  const allowed = /^allowed-tools: (.*)$/m.exec(text)[1].split(/,\s*/);
  assert.ok(allowed.includes('Read(~/.claude-anywhere/run/**)'));
  assert.ok(!allowed.some((a) => /^Read\((~\/\*\*|\/\/\*\*|\*\*)?\)?$/.test(a) || a === 'Read'), 'no broad Read rule');
  assert.match(text, /if reading one\s+is refused, take a fresh screenshot instead/);
  assert.match(text, /custom `ANYWHERE_HOME`, the user approves the read once or adds a `Read\(<that folder>\/run\/\*\*\)` allow rule/);
  assert.match(text, /A note starting "still in bridge mode" means the\s+dialog's tasks go to \(or wait for\) a Claude Code terminal/);
});

test('SECURITY.md lists where the token URL is printed', () => {
  const text = fs.readFileSync(path.join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
  assert.match(text, /`status` \(also `--json`\), `doctor` \(also `--json`/);
  assert.match(text, /`anywhere logs` masks it/);
  assert.match(text, /no window could open, or `--no-open`/);
});
