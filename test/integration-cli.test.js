'use strict';

/**
 * End-to-end CLI tests against the real daemon (src/daemon) and diagnostics.
 * Each test skips itself while the modules it needs are not present yet.
 * No network and no display are needed: the daemon runs headless with --no-open.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'anywhere.js');
const has = (rel) => fs.existsSync(path.join(ROOT, rel));
const haveDaemon = ['src/daemon/main.js', 'src/daemon/server.js', 'src/daemon/session.js', 'src/daemon/bridge.js', 'src/daemon/hub.js'].every(has);

function env(home, extra = {}) {
  const e = { ...process.env, ANYWHERE_HOME: home, NO_COLOR: '1', ANYWHERE_DRIVER: 'mock' };
  for (const k of ['ANYWHERE_DAEMON_URL', 'ANYWHERE_TOKEN', 'DISPLAY', 'WAYLAND_DISPLAY', 'FORCE_COLOR']) delete e[k];
  return { ...e, ...extra };
}

function runCli(args, e, { input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: e, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out: anywhere ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input == null ? undefined : input);
  });
}

test('start → status → bridge send/listen/reply → stop with the real daemon', { skip: haveDaemon ? false : 'daemon modules are not present yet', timeout: 120000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-int-'));
  const e = env(home);
  t.after(async () => {
    await runCli(['stop'], e).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });

  const start = await runCli(['start', '--no-open', '--port', '0', '--mode', 'bridge', '--project', ROOT, '--json'], e);
  assert.equal(start.code, 0, `${start.stdout}\n${start.stderr}`);
  const s = JSON.parse(start.stdout);
  assert.equal(s.ok, true);
  assert.equal(s.reused, false);
  assert.equal(s.mode, 'bridge');
  assert.equal(s.project, ROOT);
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  assert.ok(fs.existsSync(path.join(home, 'daemon.json')));

  const again = await runCli(['start', '--no-open', '--json'], e);
  assert.equal(JSON.parse(again.stdout).reused, true, again.stderr);

  const status = await runCli(['status', '--json'], e);
  assert.equal(status.code, 0, status.stderr);
  const st = JSON.parse(status.stdout);
  assert.equal(st.running, true);
  assert.equal(st.state.mode, 'bridge');

  const human = await runCli(['status'], e);
  assert.match(human.stdout, /Claude Anywhere .* is running/);

  const url = await runCli(['url'], e);
  assert.equal(url.stdout.trim(), s.url);

  const listen = runCli(['listen', '--timeout', '20'], e);
  await new Promise((r) => setTimeout(r, 400));
  const send = await runCli(['send', '--stdin'], e, { input: 'Deploy "this" repo ✓\n' });
  assert.equal(send.code, 0, send.stderr);
  const got = await listen;
  assert.equal(got.code, 0, got.stderr);
  const lines = got.stdout.split('\n');
  assert.match(lines[0], /^===ANYWHERE COMMAND [\w-]+===$/);
  assert.equal(lines[1], 'Deploy "this" repo ✓');

  const reply = await runCli(['reply', '--final', '--no-speak', 'Done.'], e);
  assert.equal(reply.code, 0, reply.stderr);

  const timeout = await runCli(['listen', '--timeout', '1'], e);
  assert.equal(timeout.code, 2);
  assert.equal(timeout.stdout.trim(), 'TIMEOUT');

  const toCompanion = await runCli(['start', '--no-open', '--mode', 'companion', '--json'], e);
  assert.equal(JSON.parse(toCompanion.stdout).mode, 'companion', toCompanion.stderr);
  const stop = await runCli(['listen', '--timeout', '5'], e);
  assert.equal(stop.code, 3);
  assert.equal(stop.stdout.trim(), 'STOP');

  const halt = await runCli(['stop', '--json'], e);
  assert.equal(halt.code, 0, halt.stderr);
  assert.equal(JSON.parse(halt.stdout).stopped, true);
  assert.ok(!fs.existsSync(path.join(home, 'daemon.json')));
  const after = await runCli(['status'], e);
  assert.equal(after.code, 4);
});

test('start reports a clear error with the log tail when the daemon cannot start', { skip: haveDaemon ? false : 'daemon modules are not present yet', timeout: 60000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-int-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // An invalid port makes the daemon exit during startup.
  const r = await runCli(['start', '--no-open', '--port', '99999'], env(home));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--port must be|did not start/);
});

const haveDoctorDeps = has('src/os/index.js');

test('doctor --json returns a structured report and a matching exit code', { skip: haveDoctorDeps ? false : 'src/os is not present yet', timeout: 120000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-int-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const r = await runCli(['doctor', '--json'], env(home));
  const report = JSON.parse(r.stdout);
  assert.equal(r.code, report.ok ? 0 : 1);
  const ids = report.checks.map((c) => c.id);
  for (const id of ['node', 'claude', 'platform', 'driver', 'ui', 'voice', 'daemon', 'skill', 'mcp', 'config']) assert.ok(ids.includes(id), `doctor checks ${id}`);
  for (const c of report.checks) {
    assert.ok(['ok', 'warn', 'fail'].includes(c.status), `${c.id} status`);
    assert.equal(typeof c.detail, 'string');
  }
  const driver = report.checks.find((c) => c.id === 'driver');
  assert.equal(driver.status, 'ok', JSON.stringify(driver));
  assert.match(driver.detail, /mock .*screenshot \d+x\d+/);
  const human = await runCli(['doctor'], env(home));
  assert.match(human.stdout, /Claude Anywhere doctor/);
  assert.match(human.stdout, /Desktop control/);
});
