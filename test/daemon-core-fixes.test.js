'use strict';

/**
 * Regression tests for the daemon-core fixes: follow-up commands and Stop (one user
 * message with the CLI at a time), session rules, resets during preparation, the
 * engine restart race, resume-failure handling, the engine's isolation from the
 * user's plugin and permission settings, bridge replies and connection state,
 * explicit "no screenshot", and the single-instance start lock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-core-fixes-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const configMod = require('../src/shared/config');
const paths = require('../src/shared/paths');
const state = require('../src/shared/state');
const { sleep } = require('../src/shared/util');
const { Hub } = require('../src/daemon/hub');
const { QuestionBroker } = require('../src/daemon/questions');
const { Bridge } = require('../src/daemon/bridge');
const { SessionManager, readSessions } = require('../src/daemon/session');

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers

/**
 * Scripted engine that behaves like claude 2.1.x where it matters here: a message
 * written during a turn is folded into that turn (one result for both), and an
 * interrupt of an idle CLI produces only a control_response (no result).
 */
class CliLikeEngine extends EventEmitter {
  static async locate() {
    return { path: '/fake/claude', version: '1.0.0' };
  }

  constructor(opts) {
    super();
    this.opts = opts;
    this.resume = Boolean(opts.resume);
    this.sawInit = false;
    this.alive = false;
    this.sent = [];
    this.interrupts = 0;
    this.turn = false;
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
    this.interrupts += 1;
    if (this.turn) this.feed({ type: 'result', result: '', total_cost_usd: 0, is_error: true, subtype: 'error_during_execution' });
    return { ok: true, killed: false };
  }

  async stop() {
    if (!this.alive) return;
    this.alive = false;
    this.emit('exit', { code: 0, signal: null, stderrTail: '', expected: true, sawInit: this.sawInit, uptimeMs: 1 });
  }

  crash(stderrTail = 'boom', uptimeMs = 10000) {
    this.alive = false;
    this.emit('exit', { code: 1, signal: null, stderrTail, expected: false, sawInit: this.sawInit, uptimeMs });
  }
}
CliLikeEngine.instances = [];

function makeSession(over = {}) {
  CliLikeEngine.instances = [];
  const config = configMod.load();
  config.context.attachDesktopContext = false;
  config.context.attachScreenshotByDefault = false;
  config.engine.addVsCodeWorkspaces = false;
  const hub = new Hub();
  const events = [];
  hub.on('event', (type, data) => events.push({ type, data }));
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  const bridge = new Bridge({ hub });
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

/** sleep() that does not keep the test process alive */
const later = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref();
  });

// ------------------------------------------------------------------ DAEMON-PROTOCOL-1

test('follow-ups during a turn wait in the daemon and go out together after its result', async () => {
  const { s, hub, engine, of, systemTexts } = makeSession();
  try {
    await s.submit({ text: 'deploy this repo' });
    await s.drain();
    const e = await engine();
    e.feed({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'gcloud run deploy' } }] } });
    await s.submit({ text: 'also open the Cloud Run console' });
    await s.submit({ text: 'and tell me the URL' });
    await s.drain();
    assert.equal(e.sent.length, 1, 'nothing else is written to the CLI while its turn runs');
    assert.ok(systemTexts().some((t) => /^Queued: Claude reads this/.test(t)));
    assert.equal(s.status, 'acting');
    // One result for the first turn: the queued commands go out as ONE message.
    e.finishTurn('Deployed.');
    assert.equal(e.sent.length, 2);
    assert.deepEqual(textsOf(e.sent[1]), ['also open the Cloud Run console', 'and tell me the URL']);
    assert.equal(s.status, 'thinking');
    e.finishTurn('Opened; the URL is https://x.run.app');
    assert.equal(s.status, 'idle', 'the session returns to idle');
    assert.equal(s.turnActive, false);
    assert.equal(of('result').length, 2);
    // Stop on an idle session does not poke the CLI (no 4 s wait, no kill).
    await s.interrupt();
    assert.equal(e.interrupts, 0);
    assert.ok(!systemTexts().some((t) => /did not stop in time/.test(t)));
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('a settings change during a turn restarts the engine once the session is idle again', async () => {
  const { s, hub, engine, config } = makeSession();
  try {
    await s.submit({ text: 'one' });
    await s.drain();
    const e1 = await engine();
    await s.submit({ text: 'two' });
    await s.drain();
    config.engine = { ...config.engine, model: 'opus' };
    s.applyConfig(config);
    assert.equal(e1.running, true, 'not restarted mid-turn');
    e1.finishTurn();
    assert.equal(e1.sent.length, 2, 'the follow-up still runs on the current engine');
    assert.equal(e1.running, true);
    e1.finishTurn();
    await sleep(5);
    assert.equal(e1.running, false, 'restarted after the last result');
    await s.submit({ text: 'three' });
    await s.drain();
    const e2 = await engine(2);
    assert.equal(e2.opts.model, 'opus');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ DAEMON-PROTOCOL-2

test('Stop drops queued follow-ups, so nothing starts after "Stopped."', async () => {
  const { s, hub, engine, systemTexts } = makeSession();
  try {
    await s.submit({ text: 'long task' });
    await s.drain();
    const e = await engine();
    await s.submit({ text: 'delete the old staging VM' });
    await s.drain();
    await s.interrupt();
    assert.equal(e.interrupts, 1);
    assert.equal(e.sent.length, 1, 'the queued command never reached the CLI');
    assert.ok(systemTexts().includes('Stopped. Dropped 1 queued command.'));
    assert.equal(s.status, 'idle');
    assert.equal(s.pendingFollowUps.length, 0);
    await sleep(20);
    assert.equal(e.sent.length, 1);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('every Stop reaches the CLI while a turn runs, and a command sent while stopping runs afterwards', async () => {
  const { s, hub, engine } = makeSession();
  try {
    await s.submit({ text: 'first' });
    await s.drain();
    const e = await engine();
    // A slow interrupt: the result arrives 50 ms later.
    e.interrupt = async function interrupt() {
      this.interrupts += 1;
      await sleep(50);
      if (this.turn) this.feed({ type: 'result', result: '', total_cost_usd: 0, is_error: true, subtype: 'error_during_execution' });
      return { ok: true, killed: false };
    };
    const stopping = s.interrupt();
    await sleep(5);
    assert.equal(s.status, 'stopping');
    await s.submit({ text: 'after the stop' });
    await stopping;
    await s.drain();
    assert.equal(e.sent.length, 2, 'the command submitted during the stop was sent once the CLI was idle');
    assert.deepEqual(textsOf(e.sent[1]), ['after the stop']);
    assert.equal(s.turnActive, true);
    // A second Stop for this new turn reaches the CLI too.
    await s.interrupt();
    assert.equal(e.interrupts, 2);
    assert.equal(s.status, 'idle');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ DAEMON-PROTOCOL-4

test('"allow for this session" rules end with New session and project switches', async () => {
  const perms = { cleared: 0, pending: () => [], cancelAll() {}, clearSessionRules() { this.cleared += 1; } };
  const { s, hub } = makeSession({ permissions: perms });
  try {
    await s.newSession();
    assert.equal(perms.cleared, 1);
    await s.setProject(fs.mkdtempSync(path.join(HOME, 'other-')));
    assert.equal(perms.cleared, 2);
  } finally {
    await s.shutdown();
    hub.close();
  }
  // A broker without the method (the basic fallback) is fine.
  const { BasicPermissionBroker } = require('../src/daemon/main');
  const basic = new BasicPermissionBroker({ config: configMod.load(), hub: new Hub() });
  basic.sessionAllow.add('Write');
  basic.clearSessionRules();
  assert.equal(basic.sessionAllow.size, 0);
});

// ------------------------------------------------------------------ DAEMON-PROTOCOL-5

test('New session and project switch cancel a command still being prepared', async () => {
  let release;
  let gate = new Promise((r) => (release = r));
  const { s, hub, config, systemTexts } = makeSession({
    context: { gatherContext: () => gate.then(() => ({})), formatContext: () => '<desktop_context>old</desktop_context>' },
  });
  config.context.attachDesktopContext = true;
  try {
    await s.submit({ text: 'delete the build folder' });
    await sleep(20);
    await s.newSession();
    release();
    await s.drain();
    assert.ok(CliLikeEngine.instances.every((e) => e.sent.length === 0), 'not sent into the new conversation');
    assert.ok(systemTexts().some((t) => /cancelled before it was sent/.test(t)));
    assert.equal(s.turnActive, false);

    gate = new Promise((r) => (release = r));
    await s.submit({ text: 'run the tests' });
    await sleep(20);
    const other = fs.mkdtempSync(path.join(HOME, 'projB-'));
    // A switch that would stop the command needs force (LIFECYCLE-4); forced, it cancels it.
    await assert.rejects(s.setProject(other), (e) => e.status === 409);
    await s.setProject(other, { force: true });
    release();
    await s.drain();
    assert.ok(CliLikeEngine.instances.every((e) => e.sent.length === 0), 'not sent into project B');
    assert.notEqual(s.status, 'error');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('a project switch during an engine start never mixes the old conversation with the new folder', async () => {
  const projectA = fs.mkdtempSync(path.join(HOME, 'projA-'));
  fs.writeFileSync(paths.sessionsPath(), JSON.stringify({ [projectA]: { sessionId: 'session-of-A', updatedAt: new Date().toISOString() } }));
  let releaseDetect;
  const detectGate = new Promise((r) => (releaseDetect = r));
  const { s, hub, config } = makeSession({
    projectDir: projectA,
    context: { detectProjects: () => detectGate.then(() => []) },
  });
  config.engine.addVsCodeWorkspaces = true;
  try {
    await s.submit({ text: 'hello' });
    await sleep(20); // startEngine waits in vsCodeDirs()
    const projectB = fs.mkdtempSync(path.join(HOME, 'projB-'));
    const switching = s.setProject(projectB, { force: true });
    await sleep(5);
    releaseDetect();
    await switching;
    await s.drain();
    for (const e of CliLikeEngine.instances) {
      assert.ok(!(e.opts.cwd === projectB && e.opts.sessionId === 'session-of-A'), 'B folder with A conversation');
      assert.ok(!(e.opts.cwd === projectA && e.opts.sessionId !== 'session-of-A'), 'A folder with another conversation');
    }
    assert.equal(readSessions()[projectA].sessionId, 'session-of-A', "A's saved conversation is kept");
    // The next command runs in B with B's own conversation.
    await s.submit({ text: 'in B' });
    await s.drain();
    const last = CliLikeEngine.instances[CliLikeEngine.instances.length - 1];
    assert.equal(last.opts.cwd, projectB);
    assert.notEqual(last.opts.sessionId, 'session-of-A');
    assert.equal(last.opts.resume, false);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ DAEMON-PROTOCOL-6

test('a command prepared while the engine restarts for new settings goes to the new engine', async () => {
  let release;
  let gate = Promise.resolve();
  const { s, hub, config, engine } = makeSession({
    context: { gatherContext: () => gate.then(() => ({})), formatContext: () => '<desktop_context></desktop_context>' },
  });
  config.context.attachDesktopContext = true;
  try {
    await s.submit({ text: 'one' });
    await s.drain();
    const e1 = await engine();
    e1.finishTurn();
    // Like the real CLI: stdin closes at once, the process exits a little later.
    let inputClosed = false;
    e1.stop = () =>
      new Promise((resolve) => {
        inputClosed = true;
        setTimeout(() => {
          e1.alive = false;
          e1.emit('exit', { code: 143, signal: null, stderrTail: '', expected: true, sawInit: true, uptimeMs: 1000 });
          resolve();
        }, 40);
      });
    const send = e1.send.bind(e1);
    e1.send = (blocks) => {
      if (inputClosed) throw Object.assign(new Error('Claude Code is not running'), { code: 'ENGINE_NOT_RUNNING' });
      send(blocks);
    };
    gate = new Promise((r) => (release = r));
    await s.submit({ text: 'two' });
    await sleep(20); // gathering context: ensureEngine() already returned e1
    config.engine = { ...config.engine, model: 'opus' };
    s.applyConfig(config); // stopEngine() starts now
    release();
    await s.drain();
    const e2 = await engine(2);
    assert.ok(e2, 'a new engine was started');
    assert.equal(e2.opts.model, 'opus');
    assert.deepEqual(textsOf(e2.sent[0]).pop(), 'two');
    assert.ok(!s.messages.some((m) => m.role === 'system' && m.level === 'error'), 'no "Claude Code is not running" error');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('a command whose send finds the CLI just gone is sent to a fresh engine', async () => {
  const { s, hub, engine } = makeSession();
  try {
    await s.submit({ text: 'one' });
    await s.drain();
    const e1 = await engine();
    e1.finishTurn();
    e1.send = () => {
      // The process died a moment ago; its exit is reported as the write fails.
      e1.crash('killed by the OOM killer');
      throw Object.assign(new Error('Claude Code is not running'), { code: 'ENGINE_NOT_RUNNING' });
    };
    await s.submit({ text: 'two' });
    await s.drain();
    const e2 = await engine(2);
    assert.ok(e2, 'a new engine was started');
    assert.deepEqual(textsOf(e2.sent[0]), ['two']);
    assert.equal(e2.opts.resume, true);
    assert.equal(s.turnActive, true);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ DAEMON-PROTOCOL-7

test('a resume failure answers with no premature result and starts fresh', async () => {
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  fs.writeFileSync(paths.sessionsPath(), JSON.stringify({ [projectDir]: { sessionId: 'gone-1', updatedAt: new Date().toISOString() } }));
  const { s, hub, engine, of } = makeSession({ projectDir });
  try {
    await s.submit({ text: 'hello' });
    await s.drain();
    const e1 = await engine();
    assert.equal(e1.opts.resume, true);
    // claude 2.1.x with --resume <unknown id>: an error result before any init, then exit 1.
    e1.sawInit = false;
    e1.emit('message', { type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, session_id: 'gone-1' });
    assert.equal(of('result').length, 0, 'no result event for the startup failure');
    assert.equal(s.turns, 0);
    assert.ok(!s.messages.some((m) => m.level === 'error'), 'no "reported an error" line');
    e1.crash('No conversation found with session ID: gone-1', 300);
    const e2 = await engine(2);
    await sleep(10);
    assert.equal(e2.opts.resume, false);
    assert.deepEqual(textsOf(e2.sent[0]), ['hello']);
    e2.finishTurn('Hi');
    assert.equal(of('result').length, 1);
    assert.equal(of('result')[0].text, 'Hi');
    assert.equal(readSessions()[projectDir].sessionId, e2.opts.sessionId);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('other early exits of a resumed engine keep the saved conversation and show the error', async () => {
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  fs.writeFileSync(paths.sessionsPath(), JSON.stringify({ [projectDir]: { sessionId: 'keep-me', updatedAt: new Date().toISOString() } }));
  const { s, hub, engine } = makeSession({ projectDir });
  try {
    await s.submit({ text: 'hello' });
    await s.drain();
    const e1 = await engine();
    e1.sawInit = false;
    e1.crash("error: option '--setting-sources <sources>' argument missing", 150);
    await sleep(20);
    assert.equal(CliLikeEngine.instances.length, 1, 'no fresh retry');
    assert.equal(readSessions()[projectDir].sessionId, 'keep-me');
    const err = s.messages.filter((m) => m.level === 'error').pop();
    assert.match(err.text, /exited unexpectedly/);
    assert.match(err.text, /--setting-sources/);
    assert.equal(s.status, 'error');
    // Once the setting is fixed, the old conversation resumes.
    await s.submit({ text: 'again' });
    await s.drain();
    const e2 = await engine(2);
    assert.equal(e2.opts.resume, true);
    assert.equal(e2.opts.sessionId, 'keep-me');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('a result before init from a CLI that stays alive is still reported', async () => {
  const { s, hub, engine, of } = makeSession();
  try {
    await s.submit({ text: 'hello' });
    await s.drain();
    const e = await engine();
    e.sawInit = false;
    e.emit('message', { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Invalid API key', total_cost_usd: 0 });
    assert.equal(of('result').length, 0);
    await sleep(3300);
    assert.equal(of('result').length, 1);
    assert.equal(s.status, 'idle');
    assert.ok(s.messages.some((m) => m.level === 'error' && /Invalid API key/.test(m.text)));
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ DAEMON-PROTOCOL-8, CROSS-MODULE-5

test("the engine runs with the dialog's permission mode and without the user's anywhere plugin", async () => {
  const claudeHome = fs.mkdtempSync(path.join(HOME, 'claude-home-'));
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'bypassPermissions' },
    enabledPlugins: { 'anywhere@my-fork': true, 'other@market': true },
  }));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const { s, hub, engine, projectDir } = makeSession();
  fs.mkdirSync(path.join(projectDir, '.claude'));
  fs.writeFileSync(path.join(projectDir, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'anywhere@team': true } }));
  try {
    await s.submit({ text: 'hi' });
    await s.drain();
    const e = await engine();
    // No inheritable marker (it leaked into every app the engine opened); the plugin copy's tools are denied instead.
    assert.ok('ANYWHERE_ENGINE_CHILD' in e.opts.env && e.opts.env.ANYWHERE_ENGINE_CHILD == null);
    assert.deepEqual(e.opts.disallowedTools, ['mcp__plugin_anywhere_anywhere']);
    assert.equal(e.opts.permissionMode, undefined, 'buildArgs pins "default"');
    const settings = JSON.parse(fs.readFileSync(e.opts.settingsPath, 'utf8'));
    assert.deepEqual(settings, { enabledPlugins: { 'anywhere@anywhere-marketplace': false, 'anywhere@my-fork': false, 'anywhere@team': false } });
    if (process.platform !== 'win32') assert.equal(fs.statSync(e.opts.settingsPath).mode & 0o777, 0o600);
    const { buildArgs } = require('../src/daemon/engine-cli');
    const args = buildArgs(e.opts);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
    assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__plugin_anywhere_anywhere');
    assert.equal(args[args.indexOf('--settings') + 1], e.opts.settingsPath);
    const file = e.opts.settingsPath;
    await s.shutdown();
    assert.equal(fs.existsSync(file), false, 'removed on shutdown');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ DAEMON-PROTOCOL-9

test('a bridge reply in companion mode does not end the companion turn', async () => {
  const { s, hub, engine, of, bridge } = makeSession({ mode: 'bridge' });
  try {
    s.setMode('companion');
    bridge.resume(); // a terminal that missed the switch
    await s.submit({ text: 'companion work' });
    await s.drain();
    const e = await engine();
    e.feed({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 100' } }] } });
    const before = s.messages.length;
    bridge.reply({ text: 'Done', final: true });
    bridge.reply({ text: 'progress' });
    assert.equal(of('result').length, 0);
    assert.equal(s.turns, 0);
    assert.equal(s.status, 'acting');
    assert.equal(s.messages.length, before);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ CROSS-MODULE-2

test('attachScreenshot:false wins over attachScreenshotByDefault', async () => {
  let shots = 0;
  const computer = { screenshot: async () => ((shots += 1), { png: Buffer.from('89504e470d0a1a0a', 'hex'), width: 1, height: 1 }) };
  const { s, hub, engine, config } = makeSession({ computer });
  config.context.attachScreenshotByDefault = true;
  try {
    await s.submit({ text: 'sensitive request', attachScreenshot: false });
    await s.drain();
    const e = await engine();
    assert.equal(s.messages[0].images, 0);
    assert.equal(shots, 0, 'the screen was not captured');
    assert.ok(e.sent[0].every((b) => b.type !== 'image'));
    e.finishTurn();
    await s.submit({ text: 'default applies when left out' });
    await s.drain();
    assert.equal(shots, 1);
    assert.equal(s.messages.filter((m) => m.role === 'user').pop().images, 1);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ CROSS-MODULE-4

test('bridge: a terminal working on a command stays connected past the 20 s poll window', async () => {
  const hub = new Hub();
  const b = new Bridge({ hub, listenGraceMs: 40, busyGraceMs: 300 });
  try {
    b.resume();
    b.enqueue({ id: 'deploy', text: 'deploy' });
    const cmd = await b.next(10);
    assert.equal(cmd.id, 'deploy');
    await sleep(100);
    assert.equal(b.listening, true, 'working on "deploy"');
    b.touch();
    await sleep(250);
    assert.equal(b.listening, true, 'a sign of life extends the window');
    b.reply({ text: 'Deployed', final: true });
    await sleep(80);
    assert.equal(b.listening, false, 'back to the short window once the command is done');
    // A terminal that died mid-command stops counting as connected eventually.
    b.enqueue({ id: 'x', text: 'x' });
    await b.next(10);
    await sleep(350);
    assert.equal(b.listening, false);
  } finally {
    b.close();
    hub.close();
  }
});

test('bridge mode: a follow-up while the terminal works is queued, not "no terminal is listening"', async () => {
  const { s, hub, bridge, systemTexts } = makeSession({ mode: 'bridge' });
  bridge.listenGraceMs = 30;
  try {
    await s.submit({ text: 'gcloud run deploy' });
    await s.drain();
    const cmd = await bridge.next(10);
    assert.equal(cmd.text, 'gcloud run deploy');
    assert.equal(s.status, 'thinking');
    s.activity({ tool: 'screenshot', summary: 'full screen' });
    await sleep(60); // past the poll window, still working
    assert.equal(bridge.listening, true);
    assert.equal(s.snapshot().bridge.listening, true);
    const warnings = () => systemTexts().filter((t) => /No Claude Code terminal is listening/.test(t)).length;
    const before = warnings(); // the first command came before any terminal polled
    await s.submit({ text: 'also open the console' });
    await s.drain();
    assert.equal(warnings(), before, 'no "run /anywhere here" warning while the terminal works');
    assert.ok(systemTexts().some((t) => /^Queued: the terminal picks this up/.test(t)));
    assert.notEqual(s.status, 'idle');
    assert.equal(bridge.queueLength(), 1);
    bridge.reply({ text: 'Deployed.', final: true });
    assert.notEqual(s.status, 'idle', 'the queued command is still to do');
    const next = await bridge.next(10);
    assert.equal(next.text, 'also open the console');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ DAEMON-PROTOCOL-3

test('start lock: a live holder makes the next start wait and report "already running"; stale locks are removed', async () => {
  const { acquireStartLock, startLockPath } = require('../src/daemon/main');
  const file = startLockPath();
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: holder.pid }));
    const t0 = Date.now();
    await assert.rejects(acquireStartLock({ waitMs: 300 }), (err) => err.code === 'ALREADY_RUNNING' && /still starting/.test(err.message));
    assert.ok(Date.now() - t0 >= 250);
    assert.ok(fs.existsSync(file), "another starter's lock is left alone");
  } finally {
    holder.kill();
  }
  await new Promise((r) => holder.once('exit', r));
  // The holder died: its lock is stale.
  const release = await acquireStartLock({ waitMs: 300 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  release();
  release();
  assert.equal(fs.existsSync(file), false);
});

test('runDaemon: our port held by another Claude Anywhere daemon means "already running", not a random port', async () => {
  const { runDaemon } = require('../src/daemon/main');
  const first = await runDaemon({ project: HOME, port: 0, open: false, handleSignals: false, allowMultiple: true });
  try {
    state.clearDaemonState(); // its daemon.json was lost or overwritten
    await assert.rejects(
      runDaemon({ project: HOME, port: first.port, open: false, handleSignals: false }),
      (err) => err.code === 'ALREADY_RUNNING' && err.message.includes(String(process.pid))
    );
    assert.equal(fs.existsSync(require('../src/daemon/main').startLockPath()), false, 'the lock is released');
  } finally {
    await first.shutdown('test');
  }
});

test('two daemons started at the same moment: one runs, the other exits as "already running"', { timeout: 60000 }, async () => {
  const home = fs.mkdtempSync(path.join(HOME, 'race-'));
  const net = require('net');
  const port = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  const env = { ...process.env, ANYWHERE_HOME: home };
  delete env.ANYWHERE_LOG_FILE;
  const main = path.join(__dirname, '..', 'src', 'daemon', 'main.js');
  const start = () => {
    const child = spawn(process.execPath, [main, '--no-open', '--project', home, '--port', String(port)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.err = '';
    child.stderr.on('data', (d) => (child.err += d));
    child.done = new Promise((r) => child.once('exit', (code) => r(code)));
    return child;
  };
  const a = start();
  const b = start();
  try {
    const loser = await Promise.race([a.done.then(() => a), b.done.then(() => b), later(20000).then(() => null)]);
    assert.ok(loser, 'one of the two exited');
    assert.equal(await loser.done, 0);
    assert.match(loser.err, /already running/);
    const winner = loser === a ? b : a;
    assert.equal(winner.exitCode, null, 'the other keeps running');
    const st = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'));
    assert.equal(st.pid, winner.pid);
    assert.equal(st.port, port);
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${st.token}`, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    await Promise.race([winner.done, later(10000)]);
  } finally {
    for (const c of [a, b]) if (c.exitCode === null) c.kill('SIGKILL');
  }
});
