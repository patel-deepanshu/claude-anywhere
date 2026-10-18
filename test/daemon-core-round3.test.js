'use strict';

/**
 * Regression tests for the round-3 daemon-core fixes:
 *  - REGRESSIONS-R2-3: bridge-mode busy state follows the bridge (New session, forced switch).
 *  - REGRESSIONS-R2-5: only dialogs and TUIs count for notify delivery and the approval reopen.
 *  - REGRESSIONS-R2-8: commands Claude already had are cancelled as 'interrupted'.
 *  - REGRESSIONS-R2-9: show() opens a window when the connected dialog page is hidden.
 *  - HEADLINE-SCENARIO-1: a 10 min Bash timeout for the engine; turns Claude Code starts itself.
 *  - HEADLINE-SCENARIO-12: approvals and questions are spoken with their content.
 *  - LIVE-E2E-R3-1: Stop in bridge mode cancels the terminal's command.
 *  - LIVE-E2E-R3-2: an empty pre-turn result after a resume does not answer the command.
 *  - LIVE-E2E-R3-4: settings that only change the prompt reach the engine without a restart.
 *  - LIVE-E2E-R3-5: the cost after a resume is not counted twice.
 *  - LIVE-E2E-R3-11: voice info is replaced, not merged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-core-r3-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const configMod = require('../src/shared/config');
const paths = require('../src/shared/paths');
const { sleep, randomToken } = require('../src/shared/util');
const { Hub } = require('../src/daemon/hub');
const { QuestionBroker } = require('../src/daemon/questions');
const { Bridge } = require('../src/daemon/bridge');
const { SessionManager } = require('../src/daemon/session');
const { createServer } = require('../src/daemon/server');
const main = require('../src/daemon/main');
const prompt = require('../src/daemon/prompt');
const U = require('../src/daemon/uihost');
const { ClaudeCliEngine, buildEnv, BASH_DEFAULT_TIMEOUT_MS } = require('../src/daemon/engine-cli');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
try {
  fs.chmodSync(FAKE, 0o755);
} catch {
  /* read-only checkout: the engine runs it with node */
}

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ------------------------------------------------------------------ helpers

/** An engine driven by the test: nothing happens unless the test feeds it (like claude 2.1.x). */
class ScriptedEngine extends EventEmitter {
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
    this.turn = false;
    this.interrupts = 0;
    ScriptedEngine.instances.push(this);
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
    this.turn = true;
  }

  feed(msg) {
    if (msg.type === 'system' && msg.subtype === 'init') this.sawInit = true;
    if (msg.type === 'result') this.turn = false;
    this.emit('message', { parent_tool_use_id: null, ...msg });
  }

  init() {
    this.feed({ type: 'system', subtype: 'init', session_id: this.opts.sessionId, model: 'm', mcp_servers: [{ name: 'anywhere', status: 'connected' }] });
  }

  say(text) {
    this.feed({ type: 'stream_event', event: { type: 'message_start', message: { id: `m-${text.length}-${Math.random()}` } } });
    this.feed({ type: 'assistant', message: { id: `a-${Math.random()}`, content: [{ type: 'text', text }] } });
  }

  result(text, extra = {}) {
    this.feed({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0, ...extra });
  }

  async interrupt() {
    this.interrupts += 1;
    if (this.turn) this.feed({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', num_turns: 1, total_cost_usd: 0 });
    return { ok: true, killed: false };
  }

  async stop() {
    if (!this.alive) return;
    this.alive = false;
    this.emit('exit', { code: 0, signal: null, stderrTail: '', expected: true, sawInit: this.sawInit, uptimeMs: 1 });
  }
}
ScriptedEngine.instances = [];

function makeSession(over = {}) {
  ScriptedEngine.instances = [];
  const config = configMod.load();
  config.context.attachDesktopContext = false;
  config.context.attachScreenshotByDefault = false;
  config.engine.addVsCodeWorkspaces = false;
  const hub = new Hub();
  const events = [];
  hub.on('event', (type, data) => events.push({ type, data }));
  const projectDir = over.projectDir || fs.mkdtempSync(path.join(HOME, 'proj-'));
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
    Engine: ScriptedEngine,
    context: {},
    ...over,
  });
  const engine = async (n = 1) => {
    for (let i = 0; i < 400 && ScriptedEngine.instances.length < n; i += 1) await sleep(5);
    return ScriptedEngine.instances[n - 1];
  };
  const of = (type) => events.filter((e) => e.type === type).map((e) => e.data);
  const systemTexts = () => s.messages.filter((m) => m.role === 'system').map((m) => m.text);
  return { s, hub, events, of, engine, config, projectDir, bridge, systemTexts };
}

/** A response object the hub accepts as an SSE stream. */
function sseRes() {
  const r = new PassThrough();
  r.headersSent = false;
  r.writeHead = () => {};
  return r;
}

async function waitUntil(pred, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ REGRESSIONS-R2-3

test('R2-3: New session in bridge mode clears the bridge, so a project switch is not refused', async () => {
  const { s, hub, bridge, of } = makeSession({ mode: 'bridge' });
  const other = fs.mkdtempSync(path.join(HOME, 'other-'));
  try {
    const a = await s.submit({ text: 'deploy prod' });
    await s.drain();
    assert.equal(bridge.queueLength(), 1);
    assert.equal(s.status, 'queued');
    assert.equal(s.isBusy(), true);
    await s.newSession();
    assert.equal(bridge.queueLength(), 0);
    assert.equal(s.bridgeBusy, false);
    assert.equal(s.isBusy(), false, 'idle after New session');
    assert.ok(of('commands_cancelled').some((c) => c.commandIds.includes(a.id) && c.reason === 'reset'));
    // No 409: nothing is running any more.
    const project = await s.setProject(other);
    assert.equal(project.dir, other);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('R2-3: New session cancels the command the terminal took; its replies are refused', async () => {
  const { s, hub, bridge, of, events } = makeSession({ mode: 'bridge' });
  try {
    const listen = bridge.next(5000);
    const a = await s.submit({ text: 'run the tests' });
    await s.drain();
    assert.equal((await listen).id, a.id);
    assert.equal(s.isBusy(), true, 'the terminal is working on it');
    await s.newSession();
    assert.equal(s.isBusy(), false);
    assert.ok(of('commands_cancelled').some((c) => c.commandIds.includes(a.id) && c.reason === 'interrupted'));
    const before = events.length;
    assert.deepEqual(bridge.reply({ text: 'tests passed', final: true }), { ok: false, stopped: true, commandId: a.id });
    assert.equal(events.slice(before).filter((e) => e.type === 'result' || e.type === 'message').length, 0);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('R2-3: a forced project switch in bridge mode drops the queue: nothing is delivered afterwards', async () => {
  const { s, hub, bridge, of, systemTexts } = makeSession({ mode: 'bridge' });
  const other = fs.mkdtempSync(path.join(HOME, 'other-'));
  try {
    const a = await s.submit({ text: 'deploy prod' });
    await s.drain();
    await assert.rejects(s.setProject(other), (err) => err.status === 409);
    await s.setProject(other, { force: true });
    // Nothing ran (the command only waited for a terminal): it is reported dropped, not "stopped"
    // (REGRESSIONS-R2-2 / LIVE-E2E-R3-8, integrator round 3).
    assert.ok(systemTexts().some((t) => /command that waited for a Claude Code terminal was dropped/.test(t)));
    assert.ok(!systemTexts().some((t) => /running task was stopped/.test(t)));
    assert.equal(bridge.queueLength(), 0);
    assert.equal(s.isBusy(), false);
    assert.equal(s.status, 'idle');
    assert.ok(of('commands_cancelled').some((c) => c.commandIds.includes(a.id)));
    assert.equal(await bridge.next(30), null, 'the next "/anywhere here" gets nothing');
    // Switching back works without --switch.
    await s.setProject(s.project.dir === other ? HOME : other);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('R2-3: after a final reply with more commands queued, the status offers Stop (queued)', async () => {
  const { s, hub, bridge } = makeSession({ mode: 'bridge' });
  try {
    const first = bridge.next(5000);
    await s.submit({ text: 'one' });
    await s.drain();
    await first;
    await s.submit({ text: 'two' });
    await s.drain();
    bridge.reply({ text: 'done one', final: true });
    assert.equal(s.status, 'queued');
    assert.equal(s.isBusy(), true);
    await s.interrupt();
    assert.equal(bridge.queueLength(), 0);
    assert.equal(s.isBusy(), false);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ LIVE-E2E-R3-1

async function bridgeServer() {
  const ctx = makeSession({ mode: 'bridge' });
  const token = randomToken();
  const server = createServer({
    hub: ctx.hub,
    session: ctx.s,
    permissions: { pending: () => [], cancelAll() {} },
    questions: ctx.s.questions,
    bridge: ctx.bridge,
    config: ctx.config,
    token,
    instanceId: 'r3',
    version: '0.0.0',
  });
  const port = await server.listen(0);
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
  return {
    ...ctx,
    api,
    async close() {
      await ctx.s.shutdown();
      ctx.hub.close();
      await server.close();
    },
  };
}

test('R3-1: Stop in bridge mode cancels the terminal\'s command: its replies get 409 COMMAND_STOPPED and are not shown', async () => {
  const t = await bridgeServer();
  try {
    const listen = t.api('POST', '/api/bridge/listen', { timeoutSec: 5 });
    await sleep(30);
    const cmd = await t.api('POST', '/api/command', { text: 'Do these 4 steps' });
    const got = await listen;
    assert.equal(got.json.command.id, cmd.json.id);
    assert.equal((await t.api('POST', '/api/bridge/reply', { text: 'Step 1 done' })).status, 200);
    assert.equal(t.s.status, 'acting');

    await t.api('POST', '/api/interrupt', {});
    assert.equal(t.s.status, 'idle');
    assert.ok(t.of('commands_cancelled').some((c) => c.commandIds.includes(cmd.json.id) && c.reason === 'interrupted'));
    assert.ok(t.systemTexts().some((m) => /terminal's command was cancelled/.test(m) && /Esc/.test(m)));

    const before = t.events.length;
    const r2 = await t.api('POST', '/api/bridge/reply', { text: 'Step 2 done', speak: true });
    assert.equal(r2.status, 409);
    assert.equal(r2.json.code, 'COMMAND_STOPPED');
    const fin = await t.api('POST', '/api/bridge/reply', { text: 'All done', final: true });
    assert.equal(fin.status, 409);
    const ask = await t.api('POST', '/api/mcp/ask', { question: 'Continue with step 3?', timeoutSec: 5 });
    assert.equal(ask.status, 409);
    assert.equal(ask.json.code, 'COMMAND_STOPPED');
    const shown = t.events.slice(before).filter((e) => ['message', 'notify', 'result', 'question'].includes(e.type));
    assert.deepEqual(shown, [], 'nothing from the stopped command reaches the dialog');
    assert.equal(t.s.status, 'idle', 'the status does not go back to acting');
    // Its screen actions are refused until the terminal listens again.
    const guard = await t.api('GET', '/api/mcp/guard');
    assert.equal(guard.json.allowed, false);
    assert.match(guard.json.reason, /pressed Stop/);

    // Listening again: the next command works normally.
    const listen2 = t.api('POST', '/api/bridge/listen', { timeoutSec: 5 });
    await sleep(30);
    assert.equal(t.bridge.commandStopped, false);
    const after = (await t.api('GET', '/api/mcp/guard')).json;
    assert.doesNotMatch(String(after.reason || ''), /command was cancelled/, 'only the short Stop pause remains');
    const cmd2 = await t.api('POST', '/api/command', { text: 'next task' });
    assert.equal((await listen2).json.command.id, cmd2.json.id);
    assert.equal((await t.api('POST', '/api/bridge/reply', { text: 'Done.', final: true })).status, 200);
    const res = t.of('result').pop();
    assert.deepEqual(res.commandIds, [cmd2.json.id]);
  } finally {
    await t.close();
  }
});

test('R3-1: Stop with no command in the terminal keeps the short pause only', async () => {
  const { s, hub, bridge } = makeSession({ mode: 'bridge' });
  try {
    await s.interrupt();
    assert.equal(bridge.commandStopped, false);
    assert.deepEqual(bridge.reply({ text: 'hello' }), { ok: true });
    // The 3 s pause, not the stopped-command refusal.
    assert.match(s.guard().reason, /actions resume/);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ REGRESSIONS-R2-8

test('R2-8: a command Claude was working on is cancelled as interrupted, a queued one as stopped', async () => {
  const { s, hub, engine, of } = makeSession();
  try {
    const a = await s.submit({ text: 'deploy' });
    await s.drain();
    const e = await engine();
    e.init();
    e.say('working');
    const b = await s.submit({ text: 'and then?' });
    await s.drain();
    // The engine dies without a result (e.g. killed): the command it had may have partly run.
    e.turn = false;
    await s.interrupt();
    const cancelled = of('commands_cancelled');
    assert.ok(cancelled.some((c) => c.commandIds.includes(a.id) && c.reason === 'interrupted'), JSON.stringify(cancelled));
    assert.ok(cancelled.some((c) => c.commandIds.includes(b.id) && c.reason === 'stopped'));

    // A project switch while a command runs: interrupted, not "reset before it ran".
    const c = await s.submit({ text: 'migrate the database' });
    await s.drain();
    await s.newSession();
    assert.ok(of('commands_cancelled').some((x) => x.commandIds.includes(c.id) && x.reason === 'interrupted'));
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ HEADLINE-SCENARIO-1

test('HEADLINE-1: the engine gets a 10 min Bash timeout (a larger inherited one is kept)', () => {
  assert.equal(BASH_DEFAULT_TIMEOUT_MS, 600000);
  assert.equal(buildEnv({ PATH: '/usr/bin' }).BASH_DEFAULT_TIMEOUT_MS, '600000');
  assert.equal(buildEnv({ PATH: '/usr/bin', BASH_DEFAULT_TIMEOUT_MS: '120000' }).BASH_DEFAULT_TIMEOUT_MS, '600000');
  assert.equal(buildEnv({ PATH: '/usr/bin', BASH_DEFAULT_TIMEOUT_MS: '900000' }).BASH_DEFAULT_TIMEOUT_MS, '900000');
  assert.equal(buildEnv({ PATH: '/usr/bin', BASH_DEFAULT_TIMEOUT_MS: 'junk' }).BASH_DEFAULT_TIMEOUT_MS, '600000');
  assert.equal(buildEnv({ PATH: '/usr/bin' }).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, undefined);
});

test('HEADLINE-1: a turn Claude Code starts itself is tracked: Stop interrupts it and a command sent meanwhile gets its own result', async () => {
  const { s, hub, engine, of, systemTexts } = makeSession();
  try {
    const a = await s.submit({ text: 'deploy this repo' });
    await s.drain();
    const e = await engine();
    e.init();
    e.say('The deploy is still building in the background.');
    e.result('The deploy is still building in the background.');
    assert.deepEqual(of('result')[0].commandIds, [a.id]);
    assert.equal(s.status, 'idle');

    // Minutes later the background build finishes and the CLI starts a turn of its own.
    e.feed({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
    e.init();
    assert.equal(s.status, 'thinking', 'busy from the init that follows the notification');
    assert.equal(s.isBusy(), true);
    assert.ok(systemTexts().some((t) => /continuing on its own/.test(t)));
    e.feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } });
    e.feed({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash' } } });

    // A question typed meanwhile waits for that turn instead of joining it.
    const b = await s.submit({ text: 'what is the URL?' });
    await s.drain();
    assert.equal(e.sent.length, 1, 'not sent into the running turn');
    e.result('Deployed: https://shop.run.app');
    const self = of('result')[1];
    assert.deepEqual(self.commandIds, [], 'the self-started turn answers no command');
    assert.equal(self.engineInitiated, true);
    assert.equal(e.sent.length, 2, 'the queued command went out after it');
    e.init();
    e.say('https://shop.run.app');
    e.result('https://shop.run.app');
    assert.deepEqual(of('result')[2].commandIds, [b.id]);

    // Stop reaches the CLI during a self-started turn.
    e.feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm3' } } });
    assert.equal(s.isBusy(), true);
    e.turn = true;
    await s.interrupt();
    assert.equal(e.interrupts, 1, 'the CLI was really interrupted');
    assert.equal(s.status, 'idle');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('HEADLINE-1: an init alone (no notification) does not start a turn; a user turn is never mistaken for one', async () => {
  const { s, hub, engine, of } = makeSession();
  try {
    const a = await s.submit({ text: 'hi' });
    await s.drain();
    const e = await engine();
    e.init();
    e.say('hello');
    e.result('hello');
    e.init(); // e.g. a CLI that announces itself again
    assert.equal(s.status, 'idle');
    assert.equal(s.isBusy(), false);
    // Output during the user's own turn keeps its command.
    const b = await s.submit({ text: 'again' });
    await s.drain();
    e.feed({ type: 'system', subtype: 'task_notification', task_id: 'x', status: 'completed' }); // during a turn: no hint
    e.init();
    e.say('again');
    e.result('again');
    assert.deepEqual(of('result').map((r) => r.commandIds), [[a.id], [b.id]]);
    assert.ok(!of('result').some((r) => r.engineInitiated));
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('HEADLINE-1: ClaudeCliEngine counts a self-started turn as running, so interrupt() waits for its result', () => {
  const engine = new ClaudeCliEngine({ claudePath: '/fake/claude', sessionId: 's1' });
  const line = (m) => engine.onStdoutLine(JSON.stringify(m));
  engine.sendCount = 1;
  line({ type: 'system', subtype: 'init' });
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok' });
  assert.equal(engine.turnActive, false);
  line({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
  assert.equal(engine.turnActive, true);
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done' });
  assert.equal(engine.turnActive, false);
});

test('HEADLINE-1: session + fake CLI: a backgrounded deploy, then the CLI\'s own turn; a command sent meanwhile keeps its own answer', async () => {
  process.env.FAKE_CLAUDE_BG_MS = '200';
  process.env.FAKE_CLAUDE_SELF_MS = '2000';
  const { s, hub, events, of } = makeSession({ Engine: ClaudeCliEngine });
  s.config.engine.claudePath = FAKE;
  try {
    const a = await s.submit({ text: 'BGTASK_TEST' });
    await waitUntil(() => of('result').length >= 1, 10000, 'the first result');
    assert.deepEqual(of('result')[0].commandIds, [a.id]);
    await waitUntil(() => events.some((e) => e.type === 'delta' && /build 1/.test(e.data.text)), 10000, 'the self-started turn');
    assert.equal(s.isBusy(), true);
    const b = await s.submit({ text: 'what is the URL?' });
    await s.drain();
    await waitUntil(() => of('result').length >= 3, 10000, 'both results');
    const [, self, own] = of('result');
    assert.deepEqual(self.commandIds, []);
    assert.equal(self.engineInitiated, true);
    assert.match(self.text, /The deploy finished/);
    assert.deepEqual(own.commandIds, [b.id]);
    assert.equal(own.text, 'Echo: what is the URL?');
  } finally {
    delete process.env.FAKE_CLAUDE_BG_MS;
    delete process.env.FAKE_CLAUDE_SELF_MS;
    await s.shutdown();
    hub.close();
  }
});

test('HEADLINE-1: session + fake CLI: Stop interrupts a turn the CLI started itself', async () => {
  process.env.FAKE_CLAUDE_BG_MS = '100';
  process.env.FAKE_CLAUDE_SELF_MS = '15000';
  const { s, hub, events, of } = makeSession({ Engine: ClaudeCliEngine });
  s.config.engine.claudePath = FAKE;
  try {
    await s.submit({ text: 'BGTASK_TEST' });
    await waitUntil(() => events.some((e) => e.type === 'delta' && /build 2/.test(e.data.text)), 10000, 'the self-started turn');
    const started = Date.now();
    await s.interrupt();
    assert.ok(Date.now() - started < 3500, 'answered by the CLI, not a kill');
    const last = of('result').pop();
    assert.equal(last.interrupted, true, 'the CLI stopped the turn');
    assert.equal(s.engine && s.engine.running, true, 'the CLI keeps running');
    assert.equal(s.status, 'idle');
    const n = events.filter((e) => e.type === 'delta').length;
    await sleep(400);
    assert.equal(events.filter((e) => e.type === 'delta').length, n, 'no more output');
  } finally {
    delete process.env.FAKE_CLAUDE_BG_MS;
    delete process.env.FAKE_CLAUDE_SELF_MS;
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ LIVE-E2E-R3-2

test('R3-2: an empty zero-turn result before the turn does not take the command; the status stays busy', async () => {
  const { s, hub, engine, of, events } = makeSession();
  try {
    const a = await s.submit({ text: 'what is in the xterm?' });
    await s.drain();
    const e = await engine();
    e.feed({ type: 'system', subtype: 'task_notification', task_id: 'old', status: 'killed' });
    e.init();
    e.feed({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, duration_ms: 41, total_cost_usd: 0.0179 });
    assert.equal(of('result').length, 0, 'held, not reported');
    assert.equal(s.isBusy(), true);
    assert.notEqual(s.status, 'idle');
    e.init();
    e.say('The xterm shows the command.');
    e.result('The xterm shows the command.', { total_cost_usd: 0.0209 });
    const results = of('result');
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].commandIds, [a.id]);
    assert.equal(results[0].text, 'The xterm shows the command.');
    assert.equal(results[0].costUsd, 0.003, 'measured from the restored total');
    assert.ok(!events.some((x) => x.type === 'status' && x.data.status === 'idle' && events.indexOf(x) < events.findIndex((y) => y.type === 'result')), 'never idle before the answer');
    await sleep(20);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('R3-2: a zero-turn empty result that no turn follows is reported after the hold', async () => {
  const { s, hub, engine, of } = makeSession({ preTurnHoldMs: 80 });
  try {
    const a = await s.submit({ text: '/compact' });
    await s.drain();
    const e = await engine();
    e.init();
    e.feed({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, total_cost_usd: 0 });
    assert.equal(of('result').length, 0);
    await waitUntil(() => of('result').length === 1, 2000, 'the held result');
    assert.deepEqual(of('result')[0].commandIds, [a.id]);
    assert.equal(s.status, 'idle');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('R3-2: ClaudeCliEngine keeps the turn running across an empty pre-turn result', () => {
  const engine = new ClaudeCliEngine({ claudePath: '/fake/claude', sessionId: 's1', resume: true });
  const line = (m) => engine.onStdoutLine(JSON.stringify(m));
  engine.send = ClaudeCliEngine.prototype.send; // not started: record only
  engine.sendCount = 1;
  engine.turnActive = true;
  line({ type: 'system', subtype: 'init' });
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '' });
  assert.equal(engine.turnActive, true);
  line({ type: 'system', subtype: 'init' });
  line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'two' }] } });
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '' });
  assert.equal(engine.turnActive, false, 'after output, any result ends the turn');
});

// ------------------------------------------------------------------ LIVE-E2E-R3-5 (+ R3-2 end to end)

test('R3-5 + R3-2: session + fake CLI: a restarted daemon resumes without counting the old cost again', async () => {
  const stateDir = fs.mkdtempSync(path.join(HOME, 'fake-state-'));
  process.env.FAKE_CLAUDE_STATE_DIR = stateDir;
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  try {
    const one = makeSession({ Engine: ClaudeCliEngine, projectDir });
    one.s.config.engine.claudePath = FAKE;
    try {
      await one.s.submit({ text: 'one' });
      await waitUntil(() => one.of('result').length === 1, 10000, 'result one');
      await one.s.submit({ text: 'two' });
      await waitUntil(() => one.of('result').length === 2, 10000, 'result two');
      assert.equal(one.of('result')[1].costUsd, 0.001);
      const saved = JSON.parse(fs.readFileSync(paths.sessionsPath(), 'utf8'))[projectDir];
      assert.equal(saved.lastTotalCostUsd, 0.002);
    } finally {
      await one.s.shutdown();
      one.hub.close();
    }
    // A new daemon: the CLI resumes with the restored total (0.002) and a pending task notification.
    process.env.FAKE_CLAUDE_PENDING_TASK = '1';
    const two = makeSession({ Engine: ClaudeCliEngine, projectDir });
    two.s.config.engine.claudePath = FAKE;
    try {
      const c = await two.s.submit({ text: 'three' });
      await waitUntil(() => two.of('result').length >= 1, 10000, 'result three');
      await sleep(100);
      const results = two.of('result');
      assert.equal(results.length, 1, 'the empty pre-turn result is not reported');
      assert.deepEqual(results[0].commandIds, [c.id]);
      assert.equal(results[0].text, 'Echo: three');
      assert.equal(results[0].costUsd, 0.001, 'only this turn');
      assert.equal(results[0].totalCostUsd, 0.001);
      assert.equal(two.s.snapshot().session.costUsd, 0.001);
    } finally {
      await two.s.shutdown();
      two.hub.close();
    }
  } finally {
    delete process.env.FAKE_CLAUDE_STATE_DIR;
    delete process.env.FAKE_CLAUDE_PENDING_TASK;
  }
});

test('R3-5: an engine restart in the same daemon resumes from the last total; an old sessions.json uses the first result as the baseline', async () => {
  const { s, hub, engine, of, projectDir } = makeSession();
  try {
    await s.submit({ text: 'one' });
    await s.drain();
    const e = await engine();
    e.init();
    e.result('one', { total_cost_usd: 0.02 });
    assert.equal(of('result')[0].costUsd, 0.02);
    // Engine settings change: restarted, resumed.
    s.applyConfig({ ...s.config, engine: { ...s.config.engine, model: 'other' } });
    await waitUntil(() => !e.running, 2000, 'the restart');
    await s.submit({ text: 'two' });
    await s.drain();
    const e2 = await engine(2);
    assert.equal(e2.opts.resume, true);
    e2.init();
    e2.result('two', { total_cost_usd: 0.023 }); // restored 0.02 + 0.003
    assert.equal(of('result')[1].costUsd, 0.003);
    assert.equal(s.snapshot().session.costUsd, 0.023);
  } finally {
    await s.shutdown();
    hub.close();
  }
  // sessions.json without lastTotalCostUsd (an older version): no double count.
  fs.writeFileSync(paths.sessionsPath(), JSON.stringify({ [projectDir]: { sessionId: 'abc-old', updatedAt: new Date().toISOString() } }));
  const t = makeSession({ projectDir });
  try {
    await t.s.submit({ text: 'hi' });
    await t.s.drain();
    const e = await t.engine();
    assert.equal(e.opts.resume, true);
    e.init();
    e.result('hi', { total_cost_usd: 0.5 });
    assert.equal(t.of('result')[0].costUsd, 0, 'the restored total is a baseline, not this turn');
    await t.s.submit({ text: 'again' });
    await t.s.drain();
    e.init();
    e.result('again', { total_cost_usd: 0.504 });
    assert.equal(t.of('result')[1].costUsd, 0.004);
  } finally {
    await t.s.shutdown();
    t.hub.close();
  }
});

// ------------------------------------------------------------------ LIVE-E2E-R3-4

function promptSession(over = {}) {
  return makeSession({ buildSystemPrompt: prompt.buildSystemPrompt, settingsNotes: prompt.settingsNotes, ...over });
}

test('R3-4: approval mode, speech and desktop-context settings do not restart the engine; the next message carries them', async () => {
  const { s, hub, engine, systemTexts } = promptSession();
  try {
    await s.submit({ text: 'start a dev server in the background' });
    await s.drain();
    const e = await engine();
    e.init();
    e.result('Started.');
    const sig = s.engineSignature;
    s.applyConfig({ ...s.config, permissions: { ...s.config.permissions, mode: 'auto' } });
    s.applyConfig({ ...s.config, voice: { ...s.config.voice, speakResponses: !s.config.voice.speakResponses } });
    s.applyConfig({ ...s.config, context: { ...s.config.context, attachDesktopContext: false } });
    assert.equal(s.signature(), sig);
    assert.equal(s.engineStale, false);
    assert.equal(e.running, true, 'the engine (and its background tasks) keep running');
    assert.ok(!systemTexts().some((t) => /restarts/.test(t)));
    await s.submit({ text: 'next' });
    await s.drain();
    assert.equal(ScriptedEngine.instances.length, 1);
    const blocks = e.sent[1];
    assert.match(blocks[0].text, /^<settings>/);
    assert.match(blocks[0].text, /autopilot/);
    assert.equal(blocks[blocks.length - 1].text, 'next');
    e.init();
    e.result('ok');
    await s.submit({ text: 'once more' });
    await s.drain();
    assert.equal(e.sent[2].length, 1, 'sent once, not with every message');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('R3-4: an engine setting still restarts, with a notice, but waits for running background tasks', async () => {
  const { s, hub, engine, systemTexts } = promptSession();
  try {
    await s.submit({ text: 'npm run dev in the background' });
    await s.drain();
    const e = await engine();
    e.init();
    e.feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', status: 'running' }] });
    e.result('The dev server runs.');
    s.applyConfig({ ...s.config, engine: { ...s.config.engine, model: 'opus' } });
    assert.equal(s.engineStale, true);
    assert.equal(e.running, true, 'not killed under its background task');
    assert.ok(systemTexts().some((t) => /background task finishes/.test(t)), systemTexts().join(' | '));
    e.feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await waitUntil(() => !e.running, 2000, 'the restart');
    assert.ok(systemTexts().some((t) => /Claude Code restarts with your next command/.test(t)));
  } finally {
    await s.shutdown();
    hub.close();
  }
});

// ------------------------------------------------------------------ LIVE-E2E-R3-11

test('R3-11: voice info is replaced, so an old setup hint disappears once a provider is configured', () => {
  const { s, hub } = makeSession();
  try {
    s.setVoiceInfo({ serverStt: false, sttProvider: null, sttHint: 'Set GROQ_API_KEY (free tier) or OPENAI_API_KEY' });
    assert.equal(s.snapshot().voice.sttHint, 'Set GROQ_API_KEY (free tier) or OPENAI_API_KEY');
    s.setVoiceInfo({ serverStt: true, sttProvider: 'custom', serverTts: true, ttsProvider: 'espeak-ng' });
    assert.equal('sttHint' in s.snapshot().voice, false);
    assert.equal(s.snapshot().voice.sttProvider, 'custom');
    s.setVoiceInfo({ serverStt: true });
    assert.equal(s.voiceInfo.serverTts, false, 'missing fields fall back to the defaults');
    s.setVoiceInfo(null);
    assert.equal(s.voiceInfo.serverStt, true, 'ignored');
  } finally {
    hub.close();
  }
});

// ------------------------------------------------------------------ REGRESSIONS-R2-5

test('R2-5: a CLI watcher does not count as a dialog for notify_user or the approval reopen', async () => {
  const hub = new Hub({ heartbeatMs: 1e9 });
  const { s } = makeSession({ hub });
  try {
    hub.addClient({ url: '/api/events?token=t&client=cli' }, sseRes());
    hub.addClient({ url: '/api/events?token=t' }, sseRes());
    assert.equal(hub.clientCount(), 2);
    assert.equal(hub.dialogCount(), 0);
    assert.equal(s.notify({ message: 'Deployed.' }).delivered, false, 'falls back to an OS notification');

    const shown = [];
    const attention = main.createAttentionHandler({
      config: { voice: {} },
      clientCount: () => hub.dialogCount(),
      getUihost: () => ({ show: async (url) => shown.push(url) }),
      getUrl: () => 'http://127.0.0.1:1/',
    });
    attention({ kind: 'approval', id: 'ap_1', summary: 'Run: gcloud run deploy' });
    await sleep(5);
    assert.deepEqual(shown, ['http://127.0.0.1:1/'], 'the closed dialog is reopened');

    hub.addClient({ url: '/api/events?token=t&client=tui' }, sseRes());
    assert.equal(hub.dialogCount(), 1);
    assert.equal(s.notify({ message: 'Deployed.' }).delivered, true);
    const shown2 = [];
    const attention2 = main.createAttentionHandler({
      config: { voice: {} },
      clientCount: () => hub.dialogCount(),
      getUihost: () => ({ show: async (url) => shown2.push(url) }),
      getUrl: () => 'http://127.0.0.1:1/',
    });
    attention2({ kind: 'question', id: 'q_1', question: 'Which project?' });
    await sleep(5);
    assert.deepEqual(shown2, [], 'a TUI shows the card');
    hub.addClient({ url: '/api/events?token=t&client=ui' }, sseRes());
    assert.equal(hub.dialogCount(), 2);
  } finally {
    await s.shutdown();
    hub.close();
  }
  // main.js wires the handler to dialog-capable clients.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon', 'main.js'), 'utf8'), /clientCount: \(\) => hub\.dialogCount\(\)/);
});

// ------------------------------------------------------------------ HEADLINE-SCENARIO-12

test('HEADLINE-12: approvals are spoken with the action and its risk notes, secrets hidden', () => {
  const say = main.attentionSpeech({
    kind: 'approval',
    summary: 'Run: gcloud run deploy shop-api --source . --region us-central1 --project my-proj-123 --allow-unauthenticated',
    risk: 'high',
    reason: 'Deploys or changes cloud infrastructure (gcloud run deploy shop-api); makes it publicly reachable on the internet (source folder: /home/me/shop)',
  });
  assert.match(say, /^Approve: gcloud run deploy shop-api source \. region us-central1 project my-proj-123 allow-unauthenticated\?/);
  assert.match(say, /Makes it publicly reachable on the internet\.$/);
  assert.doesNotMatch(say, /source folder|--/);

  const secret = main.attentionSpeech(
    { kind: 'approval', summary: 'Run: curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" https://api.example.com', risk: 'medium' },
    { secretLike: require('../src/daemon/permissions').secretLike },
  );
  assert.doesNotMatch(secret, /abcdefghijklmnop/);
  assert.match(secret, /hidden/);
  const pw = main.attentionSpeech({ kind: 'approval', summary: 'Type text: "Tr0ub4dor&3xyz!"' }, { secretLike: require('../src/daemon/permissions').secretLike });
  assert.doesNotMatch(pw, /Tr0ub4dor/);

  assert.equal(main.attentionSpeech({ kind: 'approval' }), 'Claude needs your approval');
  assert.ok(main.attentionSpeech({ kind: 'approval', summary: 'x'.repeat(500) }).length < 140, 'kept short');
});

test('HEADLINE-12: questions are spoken with up to three options', () => {
  assert.equal(
    main.attentionSpeech({ kind: 'question', question: 'Which project: my-proj-123 or other-proj-999', options: ['my-proj-123', 'other-proj-999'] }),
    'Claude asks: Which project: my-proj-123 or other-proj-999? Options: my-proj-123 or other-proj-999.',
  );
  assert.equal(main.attentionSpeech({ kind: 'question', question: 'Deploy now?', options: ['Yes', 'No', 'Later', 'Never'] }), 'Claude asks: Deploy now? Options: Yes, No, Later, or another.');
  assert.equal(main.attentionSpeech({ kind: 'question', question: 'Proceed?' }), 'Claude asks: Proceed?');
  assert.equal(main.attentionSpeech({ kind: 'question' }), 'Claude has a question for you');
});

test('HEADLINE-12: announcements queue instead of being dropped, skip answered cards, and use the card\'s reason', async () => {
  const spoken = [];
  const pending = new Map([
    ['ap_1', { id: 'ap_1', summary: 'Run: gcloud services enable run.googleapis.com --project p1', risk: 'high', reason: 'Deploys or changes cloud infrastructure; costs money' }],
    ['ap_2', { id: 'ap_2', summary: 'Run: gcloud run deploy shop --project p1', risk: 'high' }],
    ['q_1', { id: 'q_1', question: 'Public or private?', options: ['Public', 'Private'] }],
  ]);
  const voice = {
    speak: async (text) => {
      spoken.push(text);
      await sleep(20);
    },
  };
  const attention = main.createAttentionHandler({
    config: { voice: { speakResponses: true, tts: 'auto' } },
    clientCount: () => 1,
    getVoice: () => voice,
    findCard: (kind, id) => pending.get(id) || null,
  });
  attention({ kind: 'approval', id: 'ap_1', summary: 'Run: gcloud services enable run.googleapis.com --project p1', risk: 'high' });
  attention({ kind: 'approval', id: 'ap_2', summary: 'Run: gcloud run deploy shop --project p1', risk: 'high' });
  attention({ kind: 'question', id: 'q_1', summary: 'Public or private?' });
  pending.delete('ap_2'); // answered on screen before its turn
  await sleep(150);
  assert.equal(spoken.length, 2, spoken.join(' | '));
  assert.match(spoken[0], /^Approve: gcloud services enable run\.googleapis\.com project p1\? Costs money\.$/);
  assert.equal(spoken[1], 'Claude asks: Public or private? Options: Public or Private.');

  // Speech off: nothing is said.
  const quiet = [];
  main.createAttentionHandler({ config: { voice: { speakResponses: false } }, clientCount: () => 1, getVoice: () => ({ speak: async (t) => quiet.push(t) }) })({ kind: 'question', id: 'q', question: 'x?' });
  await sleep(10);
  assert.deepEqual(quiet, []);
});

test('HEADLINE-12: the question broker hands the question and its options to onNeedAttention', async () => {
  const seen = [];
  const q = new QuestionBroker({ onNeedAttention: (info) => seen.push(info) });
  const p = q.ask({ question: 'Which region?', options: ['us-central1', 'europe-west1'], timeoutSec: 5 });
  assert.deepEqual(seen[0].options, ['us-central1', 'europe-west1']);
  assert.equal(seen[0].question, 'Which region?');
  q.cancelAll();
  await p;
});

// ------------------------------------------------------------------ REGRESSIONS-R2-9

function waylandHost(o = {}) {
  const children = [];
  const spawn = (cmd, args) => {
    const c = new EventEmitter();
    c.pid = 4000 + children.length;
    c.exitCode = null;
    c.signalCode = null;
    c.unref = () => {};
    c.kill = () => {
      c.exitCode = 0;
      c.emit('exit', 0, null);
      return true;
    };
    children.push({ cmd, args, child: c });
    return c;
  };
  const profile = fs.mkdtempSync(path.join(HOME, 'ui-profile-'));
  const host = new U.UiHost({
    config: { ui: { host: 'auto', alwaysOnTop: false, width: 440, height: 720, position: 'right' } },
    platformInfo: { platform: 'linux', isWSL: false, displayServer: 'wayland', isHeadless: false },
    driver: {
      listWindows: async () => {
        throw Object.assign(new Error('Window management is not available on gnome (Wayland)'), { code: 'UNSUPPORTED' });
      },
    },
    env: { WAYLAND_DISPLAY: 'wayland-0', ANYWHERE_BROWSER: '/opt/chrome' },
    which: () => null,
    exists: (p) => p === '/opt/chrome',
    spawn,
    run: async () => ({ code: 1, stdout: '', stderr: '', error: null }),
    kill: () => true,
    getuid: () => 1000,
    homedir: '/home/me',
    realpath: (p) => p,
    readHead: () => '',
    resolveModule: () => {
      throw new Error('not installed');
    },
    profileDir: profile,
    stateDir: HOME,
    logFile: false,
    earlyExitMs: 60,
    topmostWaitMs: 200,
    browserWaitMs: 30,
    pidWaitMs: 50,
    driverTimeoutMs: 1000,
    cleanupLeftovers: false,
    visibleWaitMs: 300,
    clientCount: () => 1,
    ...o,
  });
  return { host, children };
}

const URL_ = 'http://127.0.0.1:47120/?token=abc';

test('R2-9: a connected but hidden (minimized) dialog page gets a window; a visible one is only asked to come forward', async () => {
  const { host, children } = waylandHost({ visibleWaitMs: 3000 });
  try {
    assert.equal((await host.open(URL_)).host, 'app');
    assert.equal(children.length, 1);
    // The page answers each 'show' with its visibility (POST /api/ui/visibility).
    host.noteVisibility({ page: 'p1', visible: true, focused: true });
    const front = host.show(URL_);
    setTimeout(() => host.noteVisibility({ page: 'p1', visible: true, focused: true }), 20);
    assert.deepEqual(await front, { host: 'app' });
    assert.equal(children.length, 1, 'visible: no second window');

    // Minimized: the page answers hidden, so a window is opened (a duplicate beats an unreachable dialog).
    const t0 = Date.now();
    const hidden = host.show(URL_);
    setTimeout(() => host.noteVisibility({ page: 'p1', visible: false, focused: false }), 20);
    assert.deepEqual(await hidden, { host: 'app' });
    assert.equal(children.length, 2, 'a window was opened');
    assert.ok(Date.now() - t0 < 2000, 'every connected page answered hidden: no need to wait the full time');

    // A page that does not answer at all (frozen, discarded) also gets a window after the wait.
    host.visibleWaitMs = 200;
    await host.show(URL_);
    assert.equal(children.length, 3);
  } finally {
    await host.close();
  }
});

test('R2-9: pages that never report visibility keep the old behaviour (no duplicate window)', async () => {
  const { host, children } = waylandHost();
  try {
    await host.open(URL_);
    assert.deepEqual(await host.show(URL_), { host: 'app' });
    assert.equal(children.length, 1);
  } finally {
    await host.close();
  }
});

test('R2-9: POST /api/ui/visibility feeds the dialog host', async () => {
  const reports = [];
  const config = configMod.load();
  const hub = new Hub();
  const token = randomToken();
  const server = createServer({
    hub,
    session: { mode: 'companion' },
    permissions: { pending: () => [] },
    questions: new QuestionBroker({ hub }),
    bridge: null,
    uihost: { noteVisibility: (r) => reports.push(r), show: async () => ({ host: 'app' }) },
    config,
    token,
    instanceId: 'v',
    version: '0',
  });
  const port = await server.listen(0);
  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/api/ui/visibility`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ page: 'abc', visible: false, focused: false })).status, 200);
    assert.deepEqual(reports, [{ page: 'abc', visible: false, focused: false }]);
    assert.equal((await post({ visible: true })).status, 400);
    assert.equal((await post({ page: 'abc', visible: 'yes' })).status, 400);
    const unauth = await fetch(`http://127.0.0.1:${port}/api/ui/visibility`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(unauth.status, 401);
  } finally {
    hub.close();
    await server.close();
  }
});
