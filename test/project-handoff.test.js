'use strict';

/**
 * switch_project: the daemon finishes the current turn, switches the project (fresh conversation,
 * transcript kept), then sends the task as a new command (source 'handoff').
 *   - SessionManager scheduling with a scripted engine (result, Stop, error, follow-ups, crash,
 *     manual switch, bridge mode, the user's own terminal)
 *   - POST /api/mcp/switch-project (routes-project.js): validation, create, git init, refusals
 *   - end to end: runDaemon + the real MCP server + test/fixtures/fake-claude.js (HANDOFF_TEST)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-handoff-'));
process.env.ANYWHERE_HOME = HOME;
process.env.ANYWHERE_DRIVER = 'mock';
delete process.env.ANYWHERE_LOG_FILE;
delete process.env.ANYWHERE_DAEMON_URL;
delete process.env.ANYWHERE_TOKEN;
delete process.env.FAKE_CLAUDE_ARGS_FILE;

const configMod = require('../src/shared/config');
const { sleep } = require('../src/shared/util');
const { Hub } = require('../src/daemon/hub');
const { QuestionBroker } = require('../src/daemon/questions');
const { Bridge } = require('../src/daemon/bridge');
const { SessionManager, readSessions, writeSessions } = require('../src/daemon/session');
const routes = require('../src/daemon/routes-project');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ------------------------------------------------------------------ scripted engine

class ScriptEngine extends EventEmitter {
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
    ScriptEngine.instances.push(this);
  }

  get running() {
    return this.alive;
  }

  start() {
    this.alive = true;
  }

  send(blocks) {
    this.sent.push(blocks);
  }

  feed(msg) {
    if (msg.type === 'system' && msg.subtype === 'init') this.sawInit = true;
    this.emit('message', { parent_tool_use_id: null, session_id: this.opts.sessionId, ...msg });
  }

  init() {
    this.feed({ type: 'system', subtype: 'init', model: 'fake', mcp_servers: [{ name: 'anywhere', status: 'connected' }] });
  }

  reply(text, extra = {}) {
    this.feed({ type: 'assistant', message: { id: `m_${Math.random()}`, role: 'assistant', content: [{ type: 'text', text }] } });
    this.feed({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.001, duration_ms: 5, num_turns: 1, ...extra });
  }

  async interrupt() {
    this.feed({ type: 'result', result: '', total_cost_usd: 0, is_error: true, subtype: 'error_during_execution' });
    return { ok: true, killed: false };
  }

  async stop() {
    if (!this.alive) return;
    this.alive = false;
    this.emit('exit', { code: 0, signal: null, stderrTail: '', expected: true, sawInit: this.sawInit, uptimeMs: 1 });
  }

  crash() {
    this.alive = false;
    this.emit('exit', { code: 1, signal: null, stderrTail: 'boom', expected: false, sawInit: this.sawInit, uptimeMs: 60000 });
  }
}
ScriptEngine.instances = [];

function makeSession(over = {}) {
  ScriptEngine.instances = [];
  const config = configMod.load();
  config.context.attachDesktopContext = false;
  const hub = new Hub();
  const events = [];
  hub.on('event', (type, data) => events.push({ type, data }));
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  const target = fs.mkdtempSync(path.join(HOME, 'target-'));
  const questions = new QuestionBroker({ hub });
  const bridge = new Bridge({ hub });
  const s = new SessionManager({ config, hub, questions, bridge, port: 1234, token: 'tok', projectDir, mode: 'companion', Engine: ScriptEngine, context: {}, ...over });
  const engineN = async (n) => {
    for (let i = 0; i < 400 && ScriptEngine.instances.length < n; i += 1) await sleep(5);
    assert.ok(ScriptEngine.instances.length >= n, `engine #${n} started`);
    return ScriptEngine.instances[n - 1];
  };
  const of = (type) => events.filter((e) => e.type === type).map((e) => e.data);
  const systemTexts = () => s.messages.filter((m) => m.role === 'system').map((m) => m.text);
  return { s, hub, events, of, engineN, projectDir, target, bridge, systemTexts };
}

/** A turn in progress: a command sent and its engine initialized. */
async function startTurn(h, text = 'Start on SHOP-1') {
  await h.s.submit({ text });
  const e = await h.engineN(1);
  await h.s.drain();
  e.init();
  assert.equal(h.s.turnActive, true);
  return e;
}

const TASK = 'SHOP-1: Fix the login timeout\nAcceptance: users stay signed in for 30 minutes.\nPlan: raise the TTL; add a test.';

// ------------------------------------------------------------------ session scheduling

test('handoff: switches when the turn ends, in a fresh session, keeping the transcript, and sends the task', async () => {
  const h = makeSession();
  try {
    // The target folder had an older conversation: the hand-off does not resume it.
    writeSessions({ ...readSessions(), [h.target]: { sessionId: 'old-target-session', updatedAt: new Date().toISOString() } });
    const e1 = await startTurn(h);
    const oldSession = h.s.sessionId;
    const r = h.s.handoff({ dir: h.target, task: TASK });
    assert.deepEqual(r, { scheduled: true, dir: h.target });
    assert.equal(h.s.projectDir, h.projectDir, 'nothing switches before the turn ends');
    assert.ok(h.systemTexts().some((t) => t === `When this step finishes, Claude continues in ${h.target} with a fresh session.`));

    e1.reply('Switching to the target repo to start SHOP-1.');
    const e2 = await h.engineN(2);
    await h.s.drain();
    // The turn's result says the work continues elsewhere (voice: not "done").
    const results = h.of('result');
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].handoff, { dir: h.target });
    assert.equal(results[0].text, 'Switching to the target repo to start SHOP-1.');
    // The new engine: the target folder, a new conversation (no --resume of the old one there).
    assert.equal(e2.opts.cwd, h.target);
    assert.equal(e2.opts.resume, false);
    assert.notEqual(e2.opts.sessionId, 'old-target-session');
    assert.notEqual(e2.opts.sessionId, oldSession);
    assert.equal(e1.running, false, 'the old engine was stopped');
    // Its first message is the task, verbatim.
    assert.equal(e2.sent.length, 1);
    const blocks = e2.sent[0];
    assert.equal(blocks[blocks.length - 1].text, TASK);
    // The transcript kept the earlier items and shows the hand-off.
    assert.equal(h.s.projectDir, h.target);
    const texts = h.s.messages.map((m) => `${m.role}:${m.source || m.level || ''}:${m.text || ''}`);
    assert.ok(texts.some((t) => t === 'user:text:Start on SHOP-1'), 'the earlier command is still shown');
    assert.ok(texts.some((t) => t.startsWith('assistant::Switching to the target repo')));
    const note = h.s.messages.find((m) => m.role === 'system' && m.text.startsWith('Continuing in'));
    assert.equal(note.text, `Continuing in ${h.target}: SHOP-1: Fix the login timeout`);
    const handoffItem = h.s.messages.find((m) => m.role === 'user' && m.source === 'handoff');
    assert.equal(handoffItem.text, TASK);
    assert.ok(h.s.messages.indexOf(note) < h.s.messages.indexOf(handoffItem));
    assert.ok(!h.systemTexts().some((t) => /^Switched to /.test(t)), 'the hand-off line replaces "Switched to…"');
    assert.ok(h.of('project').some((p) => p.dir === h.target));
    // The new conversation's result answers the hand-off command.
    e2.init();
    e2.reply('Branch SHOP-1-fix-login created.');
    const last = h.of('result').pop();
    assert.deepEqual(last.commandIds, [handoffItem.id]);
    assert.equal(last.handoff, undefined);
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
});

test('handoff: a second call in the same turn replaces the first', async () => {
  const h = makeSession();
  try {
    const e1 = await startTurn(h);
    const other = fs.mkdtempSync(path.join(HOME, 'other-'));
    assert.deepEqual(h.s.handoff({ dir: other, task: 'first' }), { scheduled: true, dir: other });
    assert.deepEqual(h.s.handoff({ dir: h.target, task: TASK }), { scheduled: true, dir: h.target, replaced: true });
    e1.reply('ok');
    const e2 = await h.engineN(2);
    await h.s.drain();
    assert.equal(e2.opts.cwd, h.target);
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
});

test('handoff: Stop, an error result, a crash or a manual project switch cancel it', async () => {
  // Stop
  let h = makeSession();
  try {
    const e1 = await startTurn(h);
    h.s.handoff({ dir: h.target, task: TASK });
    await h.s.interrupt();
    await sleep(20);
    assert.equal(h.s.projectDir, h.projectDir);
    assert.equal(ScriptEngine.instances.length, 1);
    assert.ok(h.systemTexts().includes(`Not continuing in ${h.target}: you pressed Stop.`));
    assert.equal(h.of('result').pop().handoff, undefined);
    assert.equal(e1.running, true);
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
  // An error result
  h = makeSession();
  try {
    const e1 = await startTurn(h);
    h.s.handoff({ dir: h.target, task: TASK });
    e1.feed({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '', total_cost_usd: 0.002 });
    await sleep(20);
    assert.equal(h.s.projectDir, h.projectDir);
    assert.ok(h.systemTexts().some((t) => t.startsWith(`Not continuing in ${h.target}: this step ended with an error`)));
    assert.equal(h.s.messages.find((m) => m.text && m.text.startsWith('Not continuing')).level, 'warning');
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
  // Claude Code crashed mid-turn
  h = makeSession();
  try {
    const e1 = await startTurn(h);
    h.s.handoff({ dir: h.target, task: TASK });
    e1.crash();
    await sleep(20);
    assert.equal(h.s.pendingHandoff, null);
    assert.ok(h.systemTexts().includes(`Not continuing in ${h.target}: Claude Code stopped before the step finished.`));
    assert.equal(h.s.projectDir, h.projectDir);
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
  // The user picks another project meanwhile
  h = makeSession();
  try {
    const e1 = await startTurn(h);
    h.s.handoff({ dir: h.target, task: TASK });
    const mine = fs.mkdtempSync(path.join(HOME, 'mine-'));
    await h.s.setProject(mine, { force: true });
    assert.equal(h.s.pendingHandoff, null);
    e1.reply('late result of the old engine');
    await sleep(20);
    assert.equal(h.s.projectDir, mine);
    assert.ok(!h.s.messages.some((m) => m.source === 'handoff'));
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
});

test('handoff: a message the user sent during the turn goes to Claude first, with a note, instead of switching', async () => {
  const h = makeSession();
  try {
    const e1 = await startTurn(h);
    h.s.handoff({ dir: h.target, task: TASK });
    await h.s.submit({ text: 'wait, use the other repo' });
    await h.s.drain();
    assert.equal(h.s.pendingFollowUps.length, 1);
    e1.reply('Switching.');
    await sleep(20);
    assert.equal(h.s.projectDir, h.projectDir);
    assert.equal(ScriptEngine.instances.length, 1);
    assert.equal(e1.sent.length, 2, 'the queued message was sent to the same session');
    const blocks = e1.sent[1];
    assert.match(blocks[0].text, new RegExp(`switch_project to ${h.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} was not carried out`));
    assert.equal(blocks[blocks.length - 1].text, 'wait, use the other repo');
    assert.ok(h.systemTexts().includes(`Not continuing in ${h.target}: Claude reads your new message first.`));
    assert.equal(h.of('result')[0].handoff, undefined);
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
});

test('handoff: refusals: same folder, no turn, bridge mode, a busy dialog for the user\'s terminal, bad input', async () => {
  const h = makeSession();
  try {
    assert.deepEqual(h.s.handoff({ dir: h.projectDir, task: TASK }), { scheduled: false, same: true, dir: h.projectDir });
    assert.throws(() => h.s.handoff({ dir: h.target, task: TASK }), (err) => err.status === 409 && err.code === 'NO_TURN');
    const e1 = await startTurn(h);
    assert.throws(() => h.s.handoff({ dir: h.target, task: TASK, from: 'interactive' }), (err) => err.status === 409 && err.code === 'BUSY');
    assert.throws(() => h.s.handoff({ dir: h.target, task: '  ' }), (err) => err.status === 400);
    assert.throws(() => h.s.handoff({ dir: path.join(h.target, 'missing'), task: TASK }), (err) => err.status === 400 && /No such directory/.test(err.message));
    assert.throws(() => h.s.handoff({ dir: '', task: TASK }), (err) => err.status === 400);
    assert.throws(() => h.s.handoff({ dir: h.target, task: 'x'.repeat(100001) }), (err) => err.status === 413);
    e1.reply('done');
    await h.s.setMode('bridge');
    assert.throws(() => h.s.handoff({ dir: h.target, task: TASK }), (err) => err.status === 409 && err.code === 'BRIDGE_MODE' && /directly/.test(err.hint));
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
});

test('handoff: from the user\'s own terminal an idle dialog switches right away', async () => {
  const h = makeSession();
  try {
    const r = h.s.handoff({ dir: h.target, task: TASK, from: 'interactive' });
    assert.deepEqual(r, { scheduled: true, dir: h.target, immediate: true });
    assert.equal(h.s.projectDir, h.target, 'switched synchronously');
    const e = await h.engineN(1);
    await h.s.drain();
    assert.equal(e.opts.cwd, h.target);
    assert.equal(e.sent[0][e.sent[0].length - 1].text, TASK);
    assert.equal(h.s.messages.find((m) => m.role === 'user').source, 'handoff');
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
});

// ------------------------------------------------------------------ route

function routeOf(session) {
  const table = {};
  routes.register((method, p, fn, opts) => {
    table[`${method} ${p}`] = { fn, opts };
  }, { session });
  const r = table['POST /api/mcp/switch-project'];
  assert.ok(r, 'route registered');
  assert.equal(r.opts.notWhileStopping, true);
  return (body) => r.fn({ body });
}

test('route: validates, creates the folder and runs git init, then schedules', async () => {
  const h = makeSession();
  try {
    const call = routeOf(h.s);
    await assert.rejects(call({ task: TASK }), (err) => err.status === 400);
    await assert.rejects(call({ dir: h.target }), (err) => err.status === 400 && /task/.test(err.message));
    await assert.rejects(call({ dir: 'relative/path', task: TASK }), (err) => err.status === 400 && /absolute/.test(err.message) && /find_repos/.test(err.hint));
    // No turn running (role engine): refused before anything touches the disk.
    const fresh = path.join(HOME, 'never-created');
    await assert.rejects(call({ dir: fresh, task: TASK, create: true }), (err) => err.status === 409 && err.code === 'NO_TURN');
    assert.equal(fs.existsSync(fresh), false);

    const e1 = await startTurn(h);
    await assert.rejects(call({ dir: path.join(HOME, 'missing-dir'), task: TASK }), (err) => err.status === 400 && /No such folder/.test(err.message) && /create: true/.test(err.hint));
    const file = path.join(HOME, 'a-file.txt');
    fs.writeFileSync(file, 'x');
    await assert.rejects(call({ dir: file, task: TASK }), (err) => err.status === 400 && /Not a folder/.test(err.message));
    assert.deepEqual(await call({ dir: h.projectDir, task: TASK }), { ok: true, scheduled: false, same: true, dir: h.projectDir });

    const created = path.join(HOME, 'new-work', 'shop-new');
    const res = await call({ dir: created, task: TASK, create: true, gitInit: HAS_GIT });
    assert.equal(res.ok, true);
    assert.equal(res.scheduled, true);
    assert.equal(res.dir, created);
    assert.equal(res.created, true);
    assert.ok(fs.statSync(created).isDirectory());
    if (HAS_GIT) {
      assert.equal(res.initialized, true);
      assert.ok(fs.existsSync(path.join(created, '.git')));
    }
    e1.reply('Switching.');
    const e2 = await h.engineN(2);
    await h.s.drain();
    assert.equal(e2.opts.cwd, created);
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
});

test('route: bridge mode is refused before the folder is created', async () => {
  const h = makeSession({ mode: 'bridge' });
  try {
    const call = routeOf(h.s);
    const dir = path.join(HOME, 'bridge-new');
    await assert.rejects(call({ dir, task: TASK, create: true }), (err) => err.status === 409 && err.code === 'BRIDGE_MODE');
    assert.equal(fs.existsSync(dir), false);
  } finally {
    await h.s.shutdown();
    h.hub.close();
  }
});

test('route: normalizeDir expands ~, maps Windows paths on WSL and refuses relative paths', () => {
  const n = routes.normalizeDir;
  assert.equal(n('~/code/shop', { platform: 'linux', isWSL: false, home: '/home/me' }), '/home/me/code/shop');
  assert.equal(n('"/home/me/my repo/"', { platform: 'linux', isWSL: false, home: '/home/me' }), '/home/me/my repo');
  assert.equal(n('C:\\Users\\me\\code\\shop', { platform: 'linux', isWSL: true, home: '/home/me' }), '/mnt/c/Users/me/code/shop');
  assert.equal(n('D:/work/api', { platform: 'linux', isWSL: true, home: '/home/me' }), '/mnt/d/work/api');
  assert.equal(n('C:\\code\\shop\\', { platform: 'win32', isWSL: false, home: 'C:\\Users\\me' }), 'C:\\code\\shop');
  assert.equal(n('~\\code', { platform: 'win32', isWSL: false, home: 'C:\\Users\\me' }), 'C:\\Users\\me\\code');
  for (const [raw, sys] of [
    ['code/shop', { platform: 'linux', isWSL: false, home: '/h' }],
    ['C:\\code', { platform: 'linux', isWSL: false, home: '/h' }],
    ['code\\shop', { platform: 'win32', isWSL: false, home: 'C:\\h' }],
    ['\\code', { platform: 'win32', isWSL: false, home: 'C:\\h' }],
    ['', { platform: 'linux', isWSL: false, home: '/h' }],
    ['/a\0b', { platform: 'linux', isWSL: false, home: '/h' }],
  ]) {
    assert.throws(() => n(raw, sys), (err) => err.status === 400, JSON.stringify(raw));
  }
});

// ------------------------------------------------------------------ end to end

test('end to end: HANDOFF_TEST calls switch_project through the real MCP server and the work continues in the new folder', { timeout: 120000 }, async () => {
  try {
    fs.chmodSync(FAKE, 0o755);
  } catch {
    /* node runs it */
  }
  const home = fs.mkdtempSync(path.join(HOME, 'e2e-'));
  const argsFile = path.join(home, 'fake-args.jsonl');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  fs.writeFileSync(
    path.join(HOME, 'config.json'),
    JSON.stringify({
      port: 0,
      ui: { host: 'none', openOnStart: false },
      engine: { claudePath: FAKE, addVsCodeWorkspaces: false, resumeLast: true },
      permissions: { mode: 'smart' },
      context: { attachDesktopContext: true },
      voice: { speakResponses: false },
    }),
  );
  const start = fs.mkdtempSync(path.join(home, 'start-'));
  const target = fs.mkdtempSync(path.join(home, 'shop-api-'));
  const created = path.join(home, 'brand new', 'svc');
  const { runDaemon } = require('../src/daemon/main');
  const { DaemonClient } = require('../src/shared/client');
  const d = await runDaemon({ project: start, open: false, handleSignals: false });
  const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${d.port}`, token: d.token });
  const events = [];
  const sub = client.subscribe((type, data) => events.push({ type, data }));
  const waitFor = async (pred, what, ms = 40000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    const tail = events.slice(-10).map((e) => `${e.type}:${JSON.stringify(e.data).slice(0, 160)}`).join('\n');
    throw new Error(`timed out waiting for ${what}; last events:\n${tail}`);
  };
  try {
    await waitFor((e) => e.type === 'snapshot', 'snapshot');
    await client.request('POST', '/api/command', { text: `HANDOFF_TEST ${target}` });
    const first = await waitFor((e) => e.type === 'result' && /^HANDOFF:/.test(e.data.text), 'the hand-off turn result');
    assert.match(first.data.text, /Scheduled: when this turn ends/);
    assert.deepEqual(first.data.handoff, { dir: target });
    await waitFor((e) => e.type === 'project' && e.data.dir === target, 'project switch');
    const echo = await waitFor((e) => e.type === 'result' && /^Echo: HANDOFF_TASK SHOP-1: Fix the login timeout/.test(e.data.text), 'the task in the new session');
    assert.equal(echo.data.handoff, undefined);
    const state = await client.request('GET', '/api/state');
    assert.equal(state.project.dir, target);
    assert.ok(state.messages.some((m) => m.role === 'user' && m.text === `HANDOFF_TEST ${target}`), 'transcript kept');
    assert.ok(state.messages.some((m) => m.role === 'system' && m.text === `Continuing in ${target}: HANDOFF_TASK SHOP-1: Fix the login timeout`));
    const handoffItem = state.messages.find((m) => m.role === 'user' && m.source === 'handoff');
    assert.match(handoffItem.text, /^HANDOFF_TASK SHOP-1: Fix the login timeout\nAcceptance:/);
    assert.deepEqual(echo.data.commandIds, [handoffItem.id]);
    const launches = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(launches.length, 2);
    assert.equal(fs.realpathSync(launches[1].cwd), fs.realpathSync(target));
    assert.ok(launches[1].argv.includes('--session-id') && !launches[1].argv.includes('--resume'), 'a fresh conversation');
    const tool = state.messages.find((m) => m.role === 'tool' && m.toolUseId === 'toolu_fake_handoff');
    assert.equal(tool.displayName, 'Switch project');
    assert.equal(tool.status, 'ok');

    // From there, a hand-off into a folder that does not exist yet (create).
    events.length = 0;
    await client.request('POST', '/api/command', { text: `HANDOFF_TEST "${created}" CREATE` });
    const second = await waitFor((e) => e.type === 'result' && /^HANDOFF:/.test(e.data.text), 'the second hand-off');
    assert.match(second.data.text, /created the folder/);
    await waitFor((e) => e.type === 'result' && /^Echo: HANDOFF_TASK/.test(e.data.text), 'the task in the created folder');
    assert.ok(fs.statSync(created).isDirectory());
    assert.equal((await client.request('GET', '/api/state')).project.dir, created);

    // Bridge mode refuses: the tool's error reaches Claude, nothing switches.
    events.length = 0;
    await client.request('POST', '/api/mode', { mode: 'bridge' });
    const res = await client.request('POST', '/api/mcp/switch-project', { dir: target, task: 'x' }).catch((err) => err);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'BRIDGE_MODE');
  } finally {
    delete process.env.FAKE_CLAUDE_ARGS_FILE;
    sub.close();
    await d.shutdown('test cleanup');
  }
});

test('the fixture documents HANDOFF_TEST and the module is wired into server.js and tools.js', () => {
  const fixture = fs.readFileSync(FAKE, 'utf8');
  assert.match(fixture, /HANDOFF_TEST <dir> \[CREATE\]/);
  assert.ok(require('../src/daemon/server').DaemonServer);
  assert.ok(fs.readFileSync(path.join(ROOT, 'src', 'daemon', 'server.js'), 'utf8').includes("'routes-project'"));
  assert.ok(fs.readFileSync(path.join(ROOT, 'src', 'mcp', 'tools.js'), 'utf8').includes("'tools-project'"));
});
