'use strict';

// Regression tests for the mcp-context fixes: the engine's MCP server follows
// settings changed in the dialog, permission_prompt leaves the approval deadline
// to the daemon, Linux window lists in stacking order give a front window, and
// a Docker daemon the user cannot reach is not reported as stopped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-mcpctx-home-'));
process.env.ANYWHERE_HOME = tmpHome;
delete process.env.ANYWHERE_DAEMON_URL;
delete process.env.ANYWHERE_TOKEN;

const { createConfigSource, createComputerSource } = require('../src/mcp/server');
const { createTools } = require('../src/mcp/tools');
const desktop = require('../src/context/desktop');
const proc = require('../src/shared/proc');
const configMod = require('../src/shared/config');
const { configPath } = require('../src/shared/paths');

test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

function toolMap(opts) {
  return Object.fromEntries(createTools(opts).map((t) => [t.name, t]));
}

// ---------------------------------------------------------------- live config (CROSS-MODULE-3)

test('createConfigSource picks up dialog changes in place and keeps the object identity', (t) => {
  t.after(() => configMod.reset());
  configMod.reset();
  const source = createConfigSource();
  const cfg = source.config;
  assert.equal(cfg.computer.failsafe, true);
  assert.equal(cfg.permissions.approvalTimeoutSec, 600);
  assert.equal(source.refresh(), false, 'nothing changed yet');
  assert.equal(source.version(), 0);

  configMod.save({ computer: { failsafe: false, actionDelayMs: 0 }, permissions: { approvalTimeoutSec: 1800 } });
  assert.equal(source.refresh(), true);
  assert.equal(source.config, cfg, 'same object, new contents');
  assert.equal(cfg.computer.failsafe, false);
  assert.equal(cfg.computer.actionDelayMs, 0);
  assert.equal(cfg.permissions.approvalTimeoutSec, 1800);
  assert.equal(source.version(), 1);
  assert.equal(source.refresh(), false);

  // Two quick saves with the same size are both seen (the text is compared, not the mtime).
  configMod.save({ computer: { actionDelayMs: 5 } });
  assert.equal(source.refresh(), true);
  configMod.save({ computer: { actionDelayMs: 7 } });
  assert.equal(source.refresh(), true);
  assert.equal(cfg.computer.actionDelayMs, 7);

  configMod.reset();
  assert.equal(source.refresh(), true, 'deleting the file restores the defaults');
  assert.equal(cfg.computer.failsafe, true);
  assert.equal(source.version(), 4);
});

test('createConfigSource keeps the last good settings when loading fails', () => {
  const file = path.join(tmpHome, 'fake-config.json');
  fs.writeFileSync(file, '{"a":1}');
  let fail = false;
  const source = createConfigSource({
    file: () => file,
    load: () => {
      if (fail) throw new Error('boom');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
  });
  assert.deepEqual(source.config, { a: 1 });
  fail = true;
  fs.writeFileSync(file, '{"a":2}');
  assert.equal(source.refresh(), false);
  assert.deepEqual(source.config, { a: 1 });
  fail = false;
  assert.equal(source.refresh(), true, 'retried on the next call');
  assert.deepEqual(source.config, { a: 2 });
});

test('createComputerSource applies changed computer settings to the live Computer', async (t) => {
  t.after(() => configMod.reset());
  configMod.reset();
  const { createMockDriver } = require('../src/os/index');
  const source = createConfigSource();
  let starts = 0;
  const driver = createMockDriver();
  const computers = createComputerSource({
    source,
    getDriver: async () => {
      starts += 1;
      if (starts === 1) throw new Error('no display');
      return driver;
    },
  });
  assert.equal(computers.driver(), null);
  await assert.rejects(computers.getComputer(), /no display/);
  const comp = await computers.getComputer();
  assert.equal(starts, 2, 'a failed start is retried');
  assert.equal(computers.driver(), driver);
  assert.equal(comp.config.failsafe, true);
  assert.equal(comp.config.actionDelayMs, 120);

  configMod.save({ computer: { failsafe: false, actionDelayMs: 0, maxWidth: 1024 } });
  const again = await computers.getComputer();
  assert.equal(again, comp, 'the same Computer keeps running');
  assert.equal(comp.config.failsafe, false);
  assert.equal(comp.config.actionDelayMs, 0);
  assert.equal(comp.config.maxWidth, 1024);
  assert.equal(starts, 2);

  configMod.save({ computer: { failsafe: true, actionDelayMs: -5 } });
  await computers.getComputer();
  assert.equal(comp.config.failsafe, true);
  assert.equal(comp.config.actionDelayMs, 120, 'invalid values fall back to the defaults, as at startup');
});

test('permission_prompt leaves the approval deadline to the daemon', async () => {
  const calls = [];
  const fakeClient = {
    async request(method, urlPath, body, opts) {
      calls.push({ method, urlPath, body, opts });
      return { behavior: 'allow', updatedInput: body.input };
    },
  };
  const tools = toolMap({ computer: async () => null, getClient: async () => fakeClient, config: { permissions: { approvalTimeoutSec: 10 } }, role: 'engine' });
  const ctrl = new AbortController();
  const res = await tools.permission_prompt.handler({ tool_name: 'Bash', input: { command: 'ls' } }, { signal: ctrl.signal });
  assert.deepEqual(JSON.parse(res.content[0].text), { behavior: 'allow', updatedInput: { command: 'ls' } });
  const call = calls.find((c) => c.urlPath === '/api/mcp/permission');
  assert.ok(call);
  // The user may raise approvalTimeoutSec in the dialog after this server started;
  // the HTTP request must not give up before the broker's own deadline.
  assert.ok(call.opts.timeoutMs >= 24 * 3600 * 1000, `timeoutMs ${call.opts.timeoutMs}`);
  assert.equal(call.opts.signal, ctrl.signal);
});

// ---------------------------------------------------------------- window stacking (LINUX-CONTEXT-4)

const DIALOG = { id: 'd', app: 'Claude Anywhere', title: 'Claude Anywhere' };

function linuxDriver(windows, extra = {}) {
  return {
    name: 'fake-x11',
    async listWindows() {
      return windows.map((w) => ({ ...w }));
    },
    async activeWindow() {
      return { ...DIALOG };
    },
    ...extra,
  };
}

const LINUX_SYS = { platform: 'linux', isWSL: false, env: {}, home: tmpHome };

test('classifyWindows sorts by stackIndex and finds the front window without a platform hint', () => {
  // wmctrl order (mapping order) differs from the stacking order.
  const wins = [
    { id: 'a', app: 'Code', title: 'a.js - shop - Visual Studio Code', stackIndex: 3 },
    { id: 'b', app: 'Google Chrome', title: 'Cloud Run - Google Cloud console - Google Chrome', stackIndex: 1 },
    { ...DIALOG, focused: true, stackIndex: 0 },
    { id: 'c', app: 'Slack', title: 'general - Slack', stackIndex: 2 },
    { id: 'e', app: 'XTerm', title: 'xterm' },
  ];
  const r = desktop.classifyWindows(wins, DIALOG);
  assert.equal(r.dialogFocused, true);
  assert.deepEqual(r.frontWindow, { app: 'Google Chrome', title: 'Cloud Run - Google Cloud console - Google Chrome' });
  assert.deepEqual(r.windows.map((w) => w.id), ['b', 'c', 'a', 'e'], 'front to back; unranked windows last');

  // A minimized window on top is skipped for the front window.
  const min = desktop.classifyWindows([{ ...wins[1], minimized: true }, wins[0]], DIALOG);
  assert.deepEqual(min.frontWindow, { app: 'Code', title: 'a.js - shop - Visual Studio Code' });

  // Without stacking information a plain Linux list says nothing about the front window.
  const plain = desktop.classifyWindows(wins.map(({ stackIndex, ...w }) => w), DIALOG);
  assert.equal(plain.frontWindow, null);
  assert.deepEqual(plain.windows.map((w) => w.id), ['a', 'b', 'c', 'e']);
});

test('gatherContext on native Linux reports the window the user came from', async () => {
  const wins = [
    { id: 'a', app: 'Code', title: 'server.js - shop-api - Visual Studio Code', stackIndex: 2 },
    { id: 'b', app: 'Google Chrome', title: 'Cloud Run – my-proj – Google Cloud console - Google Chrome', stackIndex: 1 },
    { ...DIALOG, stackIndex: 0 },
  ];
  const opts = { projectDir: tmpHome, config: { context: { includeCloud: false } }, _sys: LINUX_SYS };

  const ctx = await desktop.gatherContext({ ...opts, driver: linuxDriver(wins) });
  assert.equal(ctx.dialogFocused, true);
  assert.equal(ctx.activeWindow, null);
  assert.deepEqual(ctx.frontWindow, { app: 'Google Chrome', title: 'Cloud Run – my-proj – Google Cloud console' + ' - Google Chrome' });
  assert.equal(ctx.browsers[0].active, true, 'the front browser tab is the one "this page" means');
  assert.match(desktop.formatContext(ctx), /Active window: the Claude Anywhere dialog; frontmost other window: Google Chrome/);

  // A driver that already lists front to back says so with windowsZOrdered.
  const flagged = wins.map(({ stackIndex, ...w }) => w).reverse();
  const ctx2 = await desktop.gatherContext({ ...opts, driver: linuxDriver(flagged, { windowsZOrdered: true }) });
  assert.deepEqual(ctx2.frontWindow, { app: 'Google Chrome', title: 'Cloud Run – my-proj – Google Cloud console - Google Chrome' });

  // Neither: no guess (mapping order is not stacking order).
  const ctx3 = await desktop.gatherContext({ ...opts, driver: linuxDriver(wins.map(({ stackIndex, ...w }) => w)) });
  assert.equal(ctx3.frontWindow, null);
  assert.match(desktop.formatContext(ctx3), /Active window: the Claude Anywhere dialog\n/);

  // macOS lists front to back without any marker.
  const ctx4 = await desktop.gatherContext({ ...opts, _sys: { ...LINUX_SYS, platform: 'darwin' }, driver: linuxDriver(flagged) });
  assert.equal(ctx4.frontWindow.app, 'Google Chrome');
});

// ---------------------------------------------------------------- docker (LINUX-CONTEXT-10)

const realRun = proc.run;
const realWhich = proc.which;

async function probeDockerWith(t, result) {
  t.after(() => {
    proc.run = realRun;
    proc.which = realWhich;
    desktop._resetCaches();
  });
  desktop._resetCaches();
  proc.which = (name) => (name === 'docker' ? '/usr/bin/docker' : realWhich(name));
  proc.run = async (cmd, args) => {
    assert.equal(cmd, '/usr/bin/docker');
    assert.deepEqual(args.slice(0, 1), ['info']);
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return desktop.probeDocker(LINUX_SYS);
}

function dockerLine(docker) {
  const text = desktop.formatContext({ os: { platform: 'linux', osName: 'Ubuntu', arch: 'x64', user: 'd' }, time: new Date().toISOString(), windows: [], editors: [], browsers: [], project: null, cloud: { docker }, errors: [] });
  return text.split('\n').find((l) => l.startsWith('Cloud: '));
}

test('probeDocker: a daemon the user may not reach is running, not stopped', async (t) => {
  const v = await probeDockerWith(t, {
    code: 1,
    stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied\n',
  });
  assert.deepEqual(v, { running: true, accessible: false, version: null, cli: true });
  assert.equal(dockerLine(v), 'Cloud: docker running (no socket permission: use sudo or join the docker group)');
});

test('probeDocker: stopped daemon and healthy daemon', async (t) => {
  let v = await probeDockerWith(t, { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' });
  assert.deepEqual(v, { running: false, version: null, cli: true });
  assert.equal(dockerLine(v), 'Cloud: docker not running');

  v = await probeDockerWith(t, { code: 1, stderr: '' });
  assert.equal(v.running, false);

  v = await probeDockerWith(t, { code: 0, stdout: '27.3.1\n' });
  assert.deepEqual(v, { running: true, version: '27.3.1', cli: true });
  assert.equal(dockerLine(v), 'Cloud: docker running');

  v = await probeDockerWith(t, { code: null, timedOut: true, stderr: 'permission denied' });
  assert.equal(v.running, false, 'a timeout is not a permission answer');
  assert.equal(v.timedOut, true);
});
