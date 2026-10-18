'use strict';

/**
 * Regression tests for the round-2 daemon-core fixes: whose daemon holds our port and the
 * stable fallback port (REGRESSIONS-2, LIFECYCLE-1, LIFECYCLE-14), a daemon that is shutting
 * down (LIFECYCLE-9), the approval policy's live project (LIFECYCLE-15), no inheritable engine
 * marker (REGRESSIONS-3), Stop reaching the CLI's commands (LIFECYCLE-12), results naming their
 * commands (REGRESSIONS-4), mode switches during preparation (LIFECYCLE-5, LIFECYCLE-6), a command
 * typed during a reset (LIFECYCLE-7), big snapshots (LIFECYCLE-8), stoppable queued bridge
 * commands (UI-DYNAMIC-5) and the image count of a failed screenshot (UI-DYNAMIC-10).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-core-r2-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const configMod = require('../src/shared/config');
const state = require('../src/shared/state');
const { sleep, uuid } = require('../src/shared/util');
const { Hub } = require('../src/daemon/hub');
const { QuestionBroker } = require('../src/daemon/questions');
const { Bridge } = require('../src/daemon/bridge');
const { SessionManager } = require('../src/daemon/session');
const { homeId, currentUid } = require('../src/daemon/server');
const main = require('../src/daemon/main');
const { ClaudeCliEngine, buildEnv, buildArgs } = require('../src/daemon/engine-cli');

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers

/** A scripted engine like claude 2.1.x (see daemon-core-fixes.test.js), with a configurable stop delay. */
class CliLikeEngine extends EventEmitter {
  static async locate() {
    if (CliLikeEngine.locateGate) await CliLikeEngine.locateGate;
    return { path: '/fake/claude', version: '1.0.0' };
  }

  constructor(opts) {
    super();
    this.opts = opts;
    this.resume = Boolean(opts.resume);
    this.sawInit = false;
    this.alive = false;
    this.sent = [];
    this.turn = false;
    this.stopDelayMs = CliLikeEngine.stopDelayMs;
    CliLikeEngine.instances.push(this);
  }

  get running() {
    return this.alive;
  }

  start() {
    this.alive = true;
  }

  send(blocks) {
    if (!this.alive) throw Object.assign(new Error('Claude Code is not running'), { code: 'ENGINE_NOT_RUNNING' });
    this.sent.push(blocks);
    if (!this.turn) {
      this.turn = true;
      this.feed({ type: 'system', subtype: 'init', session_id: this.opts.sessionId, model: 'm', mcp_servers: [{ name: 'anywhere', status: 'connected' }] });
    }
  }

  feed(msg) {
    if (msg.type === 'system' && msg.subtype === 'init') this.sawInit = true;
    if (msg.type === 'result') this.turn = false;
    this.emit('message', { parent_tool_use_id: null, ...msg });
  }

  finishTurn(text = 'done') {
    this.feed({ type: 'result', result: text, total_cost_usd: 0, is_error: false, subtype: 'success' });
  }

  async interrupt() {
    if (this.turn) this.feed({ type: 'result', result: '', total_cost_usd: 0, is_error: true, subtype: 'error_during_execution' });
    return { ok: true, killed: false };
  }

  async stop() {
    if (!this.alive) return;
    if (this.stopDelayMs) await sleep(this.stopDelayMs);
    this.alive = false;
    this.emit('exit', { code: 0, signal: null, stderrTail: '', expected: true, sawInit: this.sawInit, uptimeMs: 1 });
  }
}
CliLikeEngine.instances = [];
CliLikeEngine.locateGate = null;
CliLikeEngine.stopDelayMs = 0;

function makeSession(over = {}) {
  CliLikeEngine.instances = [];
  CliLikeEngine.locateGate = null;
  CliLikeEngine.stopDelayMs = 0;
  const config = configMod.load();
  config.context.attachDesktopContext = false;
  config.context.attachScreenshotByDefault = false;
  config.engine.addVsCodeWorkspaces = false;
  const hub = new Hub();
  const events = [];
  hub.on('event', (type, data) => events.push({ type, data }));
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  const bridge = new Bridge({ hub });
  if (over.mode !== 'bridge') bridge.stop();
  const s = new SessionManager({
    config,
    hub,
    questions: new QuestionBroker({ hub }),
    bridge,
    port: 1234,
    token: 'tok',
    projectDir,
    mode: 'companion',
    Engine: CliLikeEngine,
    context: {},
    ...over,
  });
  const engine = async (n = 1) => {
    for (let i = 0; i < 400 && CliLikeEngine.instances.length < n; i += 1) await sleep(5);
    return CliLikeEngine.instances[n - 1];
  };
  const of = (type) => events.filter((e) => e.type === type).map((e) => e.data);
  const systemTexts = () => s.messages.filter((m) => m.role === 'system').map((m) => m.text);
  return { s, hub, events, of, engine, config, projectDir, bridge, systemTexts };
}

const textsOf = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text);

function gate() {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
}

/** A port P with P..P+19 free right now. */
async function freePortRange() {
  const isFree = (p) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
  for (let i = 0; i < 50; i += 1) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    let ok = true;
    for (let p = base; p < base + 20 && ok; p += 1) ok = await isFree(p);
    if (ok) return base;
  }
  throw new Error('no free port range');
}

/** process.kill(pid, 0) also succeeds for a zombie (this container's init does not always reap). */
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return process.platform !== 'linux';
  }
}

async function waitUntil(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}

const daemonOpts = (over = {}) => ({ project: HOME, open: false, handleSignals: false, ...over });

// ------------------------------------------------------------------ REGRESSIONS-2, LIFECYCLE-1, LIFECYCLE-14

test('isOwnDaemon: only a daemon of this state dir and user counts', () => {
  const self = { home: homeId(), uid: currentUid() };
  assert.equal(main.isOwnDaemon({ app: 'claude-anywhere', home: self.home, uid: self.uid }, self), true);
  assert.equal(main.isOwnDaemon({ app: 'claude-anywhere', home: homeId(path.join(HOME, 'other')), uid: self.uid }, self), false);
  assert.equal(main.isOwnDaemon({ app: 'claude-anywhere', pid: 1 }, self), false, 'an older daemon without an identity');
  assert.equal(main.isOwnDaemon({ app: 'claude-anywhere', home: self.home, uid: 4242 }, { home: self.home, uid: 1000 }), false, "another user's");
  assert.equal(main.isOwnDaemon({ app: 'claude-anywhere', home: self.home, uid: null }, { home: self.home, uid: null }), true, 'Windows: no uid');
  assert.equal(main.isOwnDaemon(null, self), false);
});

test('candidatePorts: last port first, then the configured one, then 19 neighbours rotated by state dir', () => {
  const a = main.candidatePorts(47120, { last: 47125, home: '00000000aaaa' });
  assert.equal(a.length, 20, 'the last port is one of the neighbours');
  assert.deepEqual(a.slice(0, 3), [47125, 47120, 47121]);
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => 47120 + i));
  const b = main.candidatePorts(47120, { home: '00000005ffff' });
  assert.deepEqual(b.slice(0, 2), [47120, 47126], 'another state dir tries another neighbour first');
  assert.deepEqual(main.candidatePorts(65530, { home: '00000000' }), [65530, 65531, 65532, 65533, 65534, 65535]);
});

test("another ANYWHERE_HOME's daemon on our port moves us to a stable fallback port, not 'already running'", async () => {
  const port = await freePortRange();
  const homeB = fs.mkdtempSync(path.join(HOME, 'homeB-'));
  const a = await main.runDaemon(daemonOpts({ port, allowMultiple: true }));
  let b = null;
  try {
    process.env.ANYWHERE_HOME = homeB;
    b = await main.runDaemon(daemonOpts({ port }));
    assert.notEqual(b.port, port);
    assert.ok(b.port > port && b.port <= port + 19, `fallback ${b.port} next to ${port}`);
    assert.equal(state.readDaemonState().pid, process.pid, "B's own daemon.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(main.lastPortPath(), 'utf8')), { wanted: port, port: b.port });
    const fallback = b.port;
    await b.shutdown('test');
    b = null;
    process.env.ANYWHERE_HOME = HOME;
    await a.shutdown('test');
    // The configured port is free again, but B keeps its origin (microphone permission, saved UI state).
    process.env.ANYWHERE_HOME = homeB;
    b = await main.runDaemon(daemonOpts({ port }));
    assert.equal(b.port, fallback);
  } finally {
    if (b) await b.shutdown('test');
    process.env.ANYWHERE_HOME = HOME;
    await a.shutdown('test');
  }
});

test('a start waits for our previous daemon to finish shutting down and takes over its port', { skip: process.platform === 'win32' && 'POSIX test' }, async () => {
  const port = await freePortRange();
  const serverJs = path.join(__dirname, '..', 'src', 'daemon', 'server.js');
  // What a daemon in shutdown answers on its port, for 700 ms.
  const stub = `
    const http = require('http');
    const { homeId, currentUid } = require(${JSON.stringify(serverJs)});
    const body = JSON.stringify({ ok: false, app: 'claude-anywhere', shuttingDown: true, pid: process.pid, instanceId: 'old', home: homeId(), uid: currentUid() });
    const srv = http.createServer((req, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(body); });
    srv.listen(Number(process.argv[1]), '127.0.0.1', () => { process.stdout.write('ready\\n'); setTimeout(() => process.exit(0), 700); });
  `;
  const env = { ...process.env, ANYWHERE_HOME: HOME };
  const old = spawn(process.execPath, ['-e', stub, String(port)], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => old.stdout.once('data', resolve));
  const t0 = Date.now();
  const d = await main.runDaemon(daemonOpts({ port }));
  try {
    assert.equal(d.port, port, 'same port, same dialog origin');
    assert.ok(Date.now() - t0 >= 400, 'it waited for the old daemon');
  } finally {
    await d.shutdown('test');
    if (old.exitCode === null) old.kill('SIGKILL');
  }
});

// ------------------------------------------------------------------ LIFECYCLE-9

test('shutdown: daemon.json goes first, health answers 503 shuttingDown, new work is refused', async () => {
  const d = await main.runDaemon(daemonOpts({ port: 0 }));
  const base = `http://127.0.0.1:${d.port}`;
  const auth = { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' };
  const g = gate();
  const realShutdown = d.session.shutdown.bind(d.session);
  d.session.shutdown = async () => {
    await g.promise;
    return realShutdown();
  };
  let stopping = null;
  try {
    assert.equal(state.readDaemonState().instanceId, d.instanceId);
    const healthy = await (await fetch(`${base}/api/health`)).json();
    assert.equal(healthy.home, homeId());
    stopping = d.shutdown('test');
    assert.equal(state.readDaemonState(), null, 'daemon.json is removed at once');
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.shuttingDown, true);
    assert.equal(body.app, 'claude-anywhere');
    assert.equal(main.isOwnDaemon(body), true);
    assert.equal(await state.findRunningDaemon(), null, '/anywhere does not reuse it');
    for (const route of ['/api/show', '/api/command', '/api/session/new', '/api/project', '/api/mode']) {
      const r = await fetch(`${base}${route}`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'x', dir: HOME, mode: 'bridge' }) });
      assert.equal(r.status, 503, route);
    }
    assert.equal((await fetch(`${base}/api/interrupt`, { method: 'POST', headers: auth, body: '{}' })).status, 200, 'Stop still works');
    d.session.emit('mode', 'bridge');
    assert.equal(state.readDaemonState(), null, 'not written again');
  } finally {
    g.release();
    await (stopping || d.shutdown('test'));
  }
});

// ------------------------------------------------------------------ LIFECYCLE-15

test('the approval policy judges paths against the live project, before the git probe answers', async () => {
  const d = await main.runDaemon(daemonOpts({ port: 0 }));
  try {
    assert.equal(typeof d.permissions.currentProjectDir, 'function', 'the policy module is loaded');
    assert.equal(d.permissions.currentProjectDir(), d.session.projectDir);
    const other = fs.mkdtempSync(path.join(HOME, 'other-'));
    const switching = d.session.setProject(other);
    assert.equal(d.permissions.currentProjectDir(), other, 'at once, not after projectInfo()');
    await switching;
  } finally {
    await d.shutdown('test');
  }
});

// ------------------------------------------------------------------ REGRESSIONS-3

test('engine: no inheritable marker in its environment; the plugin copy of the server is denied by name', () => {
  const env = buildEnv({ PATH: '/usr/bin', ANYWHERE_ENGINE_CHILD: '1' }, { extra: { ANYWHERE_ENGINE_CHILD: null } });
  assert.equal('ANYWHERE_ENGINE_CHILD' in env, false, 'one inherited from an older daemon is dropped too');
  const args = buildArgs({ sessionId: 's', allowedTools: ['a'], disallowedTools: ['mcp__plugin_anywhere_anywhere'] });
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__plugin_anywhere_anywhere');
  assert.equal(buildArgs({ sessionId: 's' }).includes('--disallowedTools'), false);
});

// ------------------------------------------------------------------ LIFECYCLE-12

/**
 * A CLI that, like Claude Code, runs a "Bash command" in a session of its own (which starts a
 * grandchild in yet another process group, as `timeout` does), and an MCP server in the CLI's
 * process group that opened an "app" on purpose. cliIgnoresTerm / commandIgnoresTerm: SIGTERM
 * does nothing to the CLI / to the command and its grandchild.
 */
function treeCli(cliIgnoresTerm, commandIgnoresTerm = cliIgnoresTerm) {
  const file = path.join(HOME, `tree-cli-${uuid()}.js`);
  const hold = `${commandIgnoresTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000);`;
  fs.writeFileSync(
    file,
    `
const { spawn } = require('child_process');
const fs = require('fs');
const out = process.env.TREE_PIDS_FILE;
const command = spawn(process.execPath, ['-e', ${JSON.stringify(
      `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(hold)}], { detached: true, stdio: 'ignore' });
       require('fs').writeFileSync(process.argv[1], String(c.pid)); ${hold}`
    )}, out + '.grand'], { detached: true, stdio: 'ignore' });
const mcp = spawn(process.execPath, ['-e', ${JSON.stringify(
      `const a = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
       a.unref(); require('fs').writeFileSync(process.argv[1], String(a.pid));
       process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`
    )}, out + '.app'], { stdio: ['pipe', 'ignore', 'ignore'] });
fs.writeFileSync(out, JSON.stringify({ command: command.pid, mcp: mcp.pid }));
${cliIgnoresTerm ? "process.on('SIGTERM', () => {});" : ''}
process.stdin.resume();
setInterval(() => {}, 1000);
`
  );
  return file;
}

async function startTree(cliIgnoresTerm, commandIgnoresTerm) {
  const pidsFile = path.join(HOME, `pids-${uuid()}.json`);
  const engine = new ClaudeCliEngine({ claudePath: treeCli(cliIgnoresTerm, commandIgnoresTerm), cwd: HOME, sessionId: uuid(), env: { TREE_PIDS_FILE: pidsFile } });
  engine.start();
  assert.ok(await waitUntil(() => fs.existsSync(pidsFile) && fs.existsSync(`${pidsFile}.grand`) && fs.existsSync(`${pidsFile}.app`), 5000), 'the fake CLI started its tree');
  await sleep(50);
  const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
  pids.grand = Number(fs.readFileSync(`${pidsFile}.grand`, 'utf8'));
  pids.app = Number(fs.readFileSync(`${pidsFile}.app`, 'utf8'));
  return { engine, pids };
}

const posixOnly = process.platform === 'win32' ? 'POSIX process groups' : false;

test("engine stop ends the CLI's commands, but not an app an MCP server opened on purpose", { skip: posixOnly }, async () => {
  const { engine, pids } = await startTree(false);
  try {
    assert.ok(alive(pids.command) && alive(pids.grand) && alive(pids.app));
    await engine.stop();
    assert.ok(await waitUntil(() => !alive(pids.command) && !alive(pids.grand)), 'the command and its grandchild are gone');
    assert.ok(await waitUntil(() => !alive(pids.mcp)), 'the MCP server exits on stdin EOF');
    assert.equal(alive(pids.app), true, 'the opened app outlives the engine');
  } finally {
    for (const pid of Object.values(pids)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
});

test('engine stop: a command that ignores SIGTERM gets SIGKILL even though the CLI itself exited', { skip: posixOnly }, async () => {
  const { engine, pids } = await startTree(false, true);
  try {
    await engine.stop();
    assert.equal(engine.running, false);
    assert.ok(alive(pids.command), 'SIGTERM did not end it');
    assert.ok(await waitUntil(() => !alive(pids.command) && !alive(pids.grand), 5000), 'SIGKILL 3 s later did');
  } finally {
    for (const pid of Object.values(pids)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
});

test('an interrupt that has to kill the CLI escalates SIGTERM to SIGKILL and takes its commands along', { skip: posixOnly }, async () => {
  const { engine, pids } = await startTree(true);
  try {
    engine.send('work forever');
    const t0 = Date.now();
    const res = await engine.interrupt({ timeoutMs: 200 });
    assert.equal(res.killed, true);
    assert.ok(Date.now() - t0 >= 1200, 'SIGKILL only after the SIGTERM grace');
    assert.equal(engine.running, false);
    assert.ok(await waitUntil(() => !alive(pids.command) && !alive(pids.grand)), 'commands that ignore SIGTERM are killed too');
  } finally {
    for (const pid of Object.values(pids)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    await engine.stop();
  }
});

// ------------------------------------------------------------------ REGRESSIONS-4

test('each result names the commands it answers; a queued follow-up gets the next one', async () => {
  const { s, hub, engine, of } = makeSession();
  try {
    const a = await s.submit({ text: 'deploy this repo' });
    await s.drain();
    const e = await engine();
    const b = await s.submit({ text: 'what URL did you deploy to?' });
    await s.drain();
    e.finishTurn('Deployed.');
    assert.deepEqual(of('result')[0].commandIds, [a.id], 'not the queued command');
    e.finishTurn('https://x.run.app');
    assert.deepEqual(of('result')[1].commandIds, [b.id]);
    // Stop drops a queued command: it is announced, since no result will name it.
    await s.submit({ text: 'three' });
    await s.drain();
    const c = await s.submit({ text: 'four' });
    await s.drain();
    await s.interrupt();
    assert.ok(of('commands_cancelled').some((x) => x.commandIds.includes(c.id) && x.reason === 'stopped'));
    assert.equal(of('result')[2].interrupted, true);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('bridge: the final reply names its command', async () => {
  const { s, hub, bridge, of } = makeSession({ mode: 'bridge' });
  try {
    const { id } = await s.submit({ text: 'run the tests' });
    await s.drain();
    const cmd = await bridge.next(10);
    assert.equal(cmd.id, id);
    bridge.reply({ text: 'All green', final: true });
    assert.deepEqual(of('result').pop().commandIds, [id]);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ LIFECYCLE-5

test('switching to bridge mode while Claude Code starts: the command is dropped and no engine is left running', async () => {
  const { s, hub, engine, of } = makeSession();
  const g = gate();
  CliLikeEngine.locateGate = g.promise;
  try {
    await s.submit({ text: 'hello one' });
    await sleep(10);
    await assert.rejects(s.setMode('bridge'), (e) => e.status === 409, 'a busy dialog keeps its mode unless forced');
    const switching = s.setMode('bridge', { force: true });
    g.release();
    await switching;
    await s.drain();
    await sleep(20);
    assert.equal(s.mode, 'bridge');
    assert.ok(CliLikeEngine.instances.every((e) => !e.running && e.sent.length === 0), 'no companion engine runs in bridge mode');
    assert.equal(of('result').length, 0);
    assert.ok(!['starting', 'thinking'].includes(s.status), `status ${s.status}`);
    // An engine that was already running is stopped, and a command still being prepared is not sent.
    await s.setMode('companion');
    await s.submit({ text: 'first' });
    await s.drain();
    const e = await engine();
    e.finishTurn();
    const ctx = gate();
    s.context = { gatherContext: () => ctx.promise.then(() => ({})), formatContext: () => '<desktop_context></desktop_context>' };
    s.config.context.attachDesktopContext = true;
    await s.submit({ text: 'second' });
    await sleep(10);
    await s.setMode('bridge', { force: true });
    ctx.release();
    await s.drain();
    await sleep(20);
    assert.equal(e.running, false);
    assert.equal(e.sent.length, 1);
    assert.ok(CliLikeEngine.instances.every((x) => !x.running), 'no fresh engine was started for it');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ LIFECYCLE-6

test('a bridge command prepared while switching to companion mode is dropped, not run later', async () => {
  const ctx = gate();
  const { s, hub, bridge, config, systemTexts } = makeSession({
    mode: 'bridge',
    context: { gatherContext: () => ctx.promise.then(() => ({})), formatContext: () => '<desktop_context></desktop_context>' },
  });
  config.context.attachDesktopContext = true;
  try {
    await s.submit({ text: 'deploy prod' });
    await sleep(10);
    await s.setMode('companion');
    ctx.release();
    await s.drain();
    assert.equal(bridge.queueLength(), 0);
    assert.equal(s.bridgeBusy, false);
    assert.ok(systemTexts().some((t) => /cancelled before it was sent/.test(t)));
    await s.setMode('bridge');
    assert.equal(await bridge.next(30), null, 'the next "/anywhere here" gets nothing');
    // A stopped bridge takes no commands at all.
    bridge.stop();
    assert.equal(bridge.enqueue({ text: 'late' }), null);
    assert.equal(bridge.queueLength(), 0);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ LIFECYCLE-7

test('a command typed during New session keeps its bubble and runs in the new conversation', async () => {
  const { s, hub, engine } = makeSession();
  try {
    await s.submit({ text: 'first' });
    await s.drain();
    const e1 = await engine();
    e1.finishTurn('one');
    const oldSession = s.sessionId;
    CliLikeEngine.stopDelayMs = 40;
    e1.stopDelayMs = 40;
    const resetting = s.newSession();
    await sleep(2);
    // The old engine's late output does not reach the new conversation.
    e1.feed({ type: 'assistant', message: { id: 'late', content: [{ type: 'text', text: 'late words from the old turn' }] } });
    await s.submit({ text: 'second' });
    const { sessionId } = await resetting;
    await s.drain();
    const e2 = await engine(2);
    assert.deepEqual(textsOf(e2.sent[0]), ['second']);
    assert.equal(e2.opts.sessionId, sessionId);
    assert.notEqual(sessionId, oldSession);
    assert.equal(e2.opts.resume, false, 'a new conversation, not a resume of the old one');
    e2.feed({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Echo: second' }] } });
    e2.finishTurn('Echo: second');
    const transcript = s.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${m.text}`);
    assert.deepEqual(transcript, ['user: second', 'assistant: Echo: second']);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('a command typed during a project switch keeps its bubble and runs in the new folder', async () => {
  const { s, hub, engine } = makeSession();
  try {
    await s.submit({ text: 'first' });
    await s.drain();
    (await engine()).finishTurn();
    CliLikeEngine.instances[0].stopDelayMs = 40;
    const other = fs.mkdtempSync(path.join(HOME, 'projB-'));
    const switching = s.setProject(other);
    await sleep(2);
    await s.submit({ text: 'in B' });
    await switching;
    await s.drain();
    const e2 = await engine(2);
    assert.equal(e2.opts.cwd, other);
    assert.deepEqual(textsOf(e2.sent[0]), ['in B']);
    assert.ok(s.messages.some((m) => m.role === 'user' && m.text === 'in B'));
    assert.ok(s.messages.some((m) => m.role === 'system' && /^Switched to/.test(m.text)));
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ LIFECYCLE-8

test('hub: a snapshot bigger than the slow-consumer limit does not get a reconnecting dialog dropped', async () => {
  const big = 'A'.repeat(24 * 1024 * 1024);
  const hub = new Hub({ maxBufferedBytes: 1024 * 1024, snapshot: () => ({ messages: [{ image: big }] }) });
  const srv = http.createServer((req, res) => hub.addClient(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  let received = 0;
  let sawSnapshot = false;
  let tail = '';
  const req = http.get({ host: '127.0.0.1', port: srv.address().port, path: '/' });
  const res = await new Promise((r) => req.once('response', r));
  res.pause(); // a busy dialog: the snapshot queues in the daemon
  try {
    for (let i = 0; i < 20; i += 1) {
      hub.broadcast('delta', { id: 'x', text: `t${i}` });
      await sleep(10);
    }
    assert.equal(hub.clientCount(), 1, 'still connected while the snapshot drains');
    res.on('data', (d) => {
      received += d.length;
      const s = tail + d.toString('latin1');
      if (!sawSnapshot && s.includes('event: snapshot')) sawSnapshot = true;
      tail = s.slice(-200);
    });
    res.resume();
    assert.ok(await waitUntil(() => received > big.length && tail.includes('t19'), 10000), 'snapshot and deltas arrive');
    assert.ok(sawSnapshot);
    // The exemption ends once it drained: a consumer that stops reading is still dropped.
    res.pause();
    const chunk = 'B'.repeat(256 * 1024);
    for (let i = 0; i < 80 && hub.clientCount() === 1; i += 1) {
      hub.broadcast('delta', { id: 'y', text: chunk });
      await sleep(5);
    }
    assert.equal(hub.clientCount(), 0, 'a slow consumer is dropped');
  } finally {
    req.destroy();
    hub.close();
    await new Promise((r) => srv.close(r));
  }
});

test('transcript images are capped by total size too (the newest stays), and a tool image is sent once', async () => {
  const { s, hub, of, engine } = makeSession({ mode: 'bridge' });
  try {
    const img = (c, n) => `iVBORw0KGgo${c.repeat(n)}`;
    s.activity({ tool: 'screenshot', image: img('A', 9 * 1024 * 1024) });
    const newest = img('B', 3 * 1024 * 1024);
    for (let i = 0; i < 3; i += 1) s.activity({ tool: 'screenshot', image: img(String.fromCharCode(67 + i), 3 * 1024 * 1024) });
    s.activity({ tool: 'screenshot', image: newest });
    const kept = s.messages.filter((m) => m.role === 'tool' && m.image);
    assert.equal(kept.length, 2, '2 × 3 MB fit in 8 MB; the 9 MB one and older ones are dropped');
    assert.equal(kept[kept.length - 1].image, `data:image/png;base64,${newest}`);
    const total = s.messages.reduce((n, m) => n + (m.image ? m.image.length : 0), 0);
    assert.ok(total <= 8 * 1024 * 1024 + 64);
    // A huge newest image is still kept.
    s.activity({ tool: 'screenshot', image: img('Z', 9 * 1024 * 1024) });
    assert.equal(s.messages.filter((m) => m.role === 'tool' && m.image).length, 1);

    // Companion: the MCP activity report and the tool result carry the same screenshot.
    await s.setMode('companion');
    await s.submit({ text: 'look' });
    await s.drain();
    const e = await engine();
    const shot = img('S', 1000);
    const before = of('screenshot').length;
    e.feed({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__anywhere__screenshot', input: {} }] } });
    s.activity({ tool: 'screenshot', image: shot });
    e.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot } }] }] } });
    assert.equal(of('screenshot').length - before, 1);
    assert.equal(s.messages.find((m) => m.toolUseId === 'tu1').image, `data:image/png;base64,${shot}`);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ UI-DYNAMIC-5

test('bridge mode with no terminal: the queued command shows a stoppable status and Stop drops it', async () => {
  const { s, hub, bridge, of, systemTexts } = makeSession({ mode: 'bridge' });
  try {
    const { id } = await s.submit({ text: 'delete the build folder' });
    await s.drain();
    assert.equal(s.status, 'queued');
    assert.equal(s.statusDetail, 'Waiting for the terminal');
    assert.equal(s.snapshot().bridge.queued, 1);
    await s.interrupt();
    assert.equal(bridge.queueLength(), 0);
    assert.equal(s.status, 'idle');
    assert.ok(systemTexts().some((t) => /Dropped 1 queued command/.test(t)));
    assert.ok(of('commands_cancelled').some((x) => x.commandIds.includes(id)));
    assert.equal(await bridge.next(30), null, 'a terminal connecting later gets nothing');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ UI-DYNAMIC-10

test("a screenshot that could not be taken is not counted in the user's bubble", async () => {
  for (const mode of ['companion', 'bridge']) {
    const computer = {
      screenshot: async () => {
        throw new Error('no graphical display');
      },
    };
    const { s, hub, of } = makeSession({ computer, mode });
    try {
      const { id } = await s.submit({ text: 'with screen', attachScreenshot: true });
      assert.equal(s.messages.find((m) => m.id === id).images, 1, 'counted while it is being taken');
      await s.drain();
      assert.equal(s.messages.find((m) => m.id === id).images, 0, mode);
      assert.equal(of('message').filter((m) => m.id === id).pop().images, 0, 'the bubble is corrected');
      assert.ok(s.messages.some((m) => /Could not attach a screenshot/.test(m.text || '')));
    } finally {
      await s.shutdown();
      hub.close();
    }
  }
});
