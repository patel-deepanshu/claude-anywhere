'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');
const { PassThrough } = require('stream');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-session-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const configMod = require('../src/shared/config');
const paths = require('../src/shared/paths');
const { sleep } = require('../src/shared/util');
const { Hub, formatEvent } = require('../src/daemon/hub');
const { QuestionBroker } = require('../src/daemon/questions');
const { Bridge } = require('../src/daemon/bridge');
const {
  SessionManager,
  displayName,
  summary,
  extractToolResult,
  compactInput,
  fallbackSystemPrompt,
  readSessions,
  READ_ONLY_TOOLS,
  MAX_MESSAGES,
} = require('../src/daemon/session');

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ------------------------------------------------------------------ helpers

/** Scripted engine: the test pushes stream-json messages with .feed(). */
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
    this.interrupts = 0;
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
    this.emit('sent', blocks);
  }

  feed(msg) {
    if (msg.type === 'system' && msg.subtype === 'init') this.sawInit = true;
    this.emit('message', { parent_tool_use_id: null, ...msg });
  }

  async interrupt() {
    this.interrupts += 1;
    // What claude 2.1.x really emits for an interrupted turn.
    this.feed({ type: 'result', result: '', total_cost_usd: 0, is_error: true, subtype: 'error_during_execution' });
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
ScriptEngine.instances = [];

function makeSession(over = {}) {
  ScriptEngine.instances = [];
  const config = configMod.load();
  config.context.attachDesktopContext = false;
  const hub = new Hub();
  const events = [];
  hub.on('event', (type, data) => events.push({ type, data }));
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  const questions = new QuestionBroker({ hub });
  const bridge = new Bridge({ hub });
  const s = new SessionManager({
    config,
    hub,
    questions,
    bridge,
    port: 1234,
    token: 'tok',
    projectDir,
    mode: 'companion',
    Engine: ScriptEngine,
    context: {},
    ...over,
  });
  const engine = async () => {
    for (let i = 0; i < 200 && !ScriptEngine.instances.length; i += 1) await sleep(5);
    return ScriptEngine.instances[ScriptEngine.instances.length - 1];
  };
  const of = (type) => events.filter((e) => e.type === type).map((e) => e.data);
  return { s, hub, events, of, engine, config, projectDir, questions, bridge };
}

// ------------------------------------------------------------------ pure helpers

test('displayName maps tools to friendly names', () => {
  assert.equal(displayName('mcp__anywhere__click'), 'Click');
  assert.equal(displayName('mcp__anywhere__type_text'), 'Type text');
  assert.equal(displayName('Bash'), 'Run command');
  assert.equal(displayName('Edit'), 'Edit file');
  assert.equal(displayName('Read'), 'Read file');
  assert.equal(displayName('WebFetch'), 'Fetch web page');
  assert.equal(displayName('mcp__github__create_issue'), 'Create issue (github)');
  assert.equal(displayName('mcp__plugin_anywhere_anywhere__screenshot'), 'Screenshot');
  assert.equal(displayName('SomeNewTool'), 'Some new tool');
  assert.equal(displayName(''), 'Tool');
});

test('summary describes calls in ≤ 80 chars', () => {
  assert.equal(summary('Bash', { command: 'gcloud run deploy --source .\n  --region us-central1' }), 'gcloud run deploy --source . --region us-central1');
  assert.equal(summary('Edit', { file_path: '/repo/src/app.js' }), '/repo/src/app.js');
  assert.equal(summary('mcp__anywhere__click', { x: 10.4, y: 20 }), '(10, 20)');
  assert.equal(summary('mcp__anywhere__click', { x: 1, y: 2, button: 'right', clicks: 2 }), '(1, 2) right button double');
  assert.equal(summary('mcp__anywhere__drag', { fromX: 1, fromY: 2, toX: 3, toY: 4 }), '(1, 2) → (3, 4)');
  assert.equal(summary('mcp__anywhere__type_text', { text: 'hello' }), '"hello"');
  assert.equal(summary('mcp__anywhere__key', { combo: 'primary+s', repeat: 2 }), 'primary+s ×2');
  assert.equal(summary('mcp__anywhere__open', { target: 'https://console.cloud.google.com' }), 'https://console.cloud.google.com');
  assert.equal(summary('mcp__anywhere__screenshot', {}), 'full screen');
  assert.equal(summary('mcp__anywhere__screenshot', { region: { x: 1, y: 2, width: 30, height: 40 } }), 'zoom (1, 2) 30×40');
  assert.equal(summary('WebSearch', { query: 'cloud run pricing' }), 'cloud run pricing');
  assert.equal(summary('TodoWrite', { todos: [{ content: 'a', status: 'pending' }, { content: 'b', activeForm: 'Building', status: 'in_progress' }] }), 'Building');
  const long = summary('Bash', { command: 'x'.repeat(500) });
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('…'));
  assert.equal(summary('Unknown', { foo: 1 }), '{"foo":1}');
  assert.equal(summary('Bash', null), '');
  assert.equal(summary('mcp__anywhere__type_text', { text: 'héllo 👋 世界' }), '"héllo 👋 世界"');
});

test('extractToolResult handles strings, text blocks and images', () => {
  assert.deepEqual(extractToolResult('plain'), { text: 'plain', image: null, imageB64: null, mediaType: null });
  const r = extractToolResult([{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'b' }]);
  assert.equal(r.text, 'a\nb');
  assert.equal(r.image, 'data:image/png;base64,AAAA');
  assert.equal(extractToolResult([{ type: 'image', source: { media_type: 'text/html', data: 'x' } }]).image, null);
  assert.equal(extractToolResult(null).text, '');
});

test('compactInput truncates long strings deeply', () => {
  const out = compactInput({ content: 'y'.repeat(5000), nested: { list: ['z'.repeat(3000)] }, n: 3 });
  assert.equal(out.content.length, 2000);
  assert.equal(out.nested.list[0].length, 2000);
  assert.equal(out.n, 3);
});

test('read-only tool list and fallback prompt', () => {
  assert.deepEqual(READ_ONLY_TOOLS.map((t) => t.replace('mcp__anywhere__', '')).sort(), [
    'ask_user', 'clipboard_get', 'cursor_position', 'get_desktop_context', 'list_windows', 'notify_user', 'screen_info', 'screenshot', 'wait',
  ]);
  const p = fallbackSystemPrompt({ platformInfo: { platform: 'darwin', osName: 'macOS', displayServer: 'quartz' } });
  assert.match(p, /Claude Anywhere/);
  assert.match(p, /Cmd/);
  assert.match(p, /ask_user/);
});

// ------------------------------------------------------------------ hub

function fakeRes() {
  const res = new PassThrough();
  res.headersSent = false;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headersSentWith = headers;
    res.headersSent = true;
  };
  res.data = '';
  res.on('data', (c) => (res.data += c));
  return res;
}

test('formatEvent frames SSE events', () => {
  assert.equal(formatEvent('status', { status: 'idle' }), 'event: status\ndata: {"status":"idle"}\n\n');
  assert.equal(formatEvent('x\ny', 1), 'event: x y\ndata: 1\n\n');
});

test('hub: retry, snapshot first, broadcast, heartbeat, dead clients dropped', async () => {
  const hub = new Hub({ heartbeatMs: 30, snapshot: () => ({ hello: 1 }) });
  try {
    const res = fakeRes();
    hub.addClient({ socket: null }, res);
    assert.equal(res.status, 200);
    assert.match(res.headersSentWith['Content-Type'], /text\/event-stream/);
    assert.equal(hub.clientCount(), 1);
    hub.broadcast('message', { a: 'ü👋' });
    await sleep(80);
    assert.ok(res.data.startsWith('retry: 2000\n\nevent: snapshot\ndata: {"hello":1}\n\n'));
    assert.match(res.data, /event: message\ndata: {"a":"ü👋"}\n\n/);
    assert.match(res.data, /: ping \d+\n\n/);
    const seen = [];
    hub.on('event', (t, d) => seen.push([t, d]));
    hub.broadcast('status', { status: 'idle' });
    assert.deepEqual(seen, [['status', { status: 'idle' }]]);
    res.destroy();
    await sleep(10);
    hub.broadcast('status', { status: 'thinking' });
    assert.equal(hub.clientCount(), 0);
    // slow consumers are dropped
    const slow = fakeRes();
    hub.maxBufferedBytes = 10;
    hub.addClient({ socket: null }, slow);
    slow.pause();
    slow.removeAllListeners('data');
    Object.defineProperty(slow, 'writableLength', { get: () => 1000 });
    hub.broadcast('x', {});
    assert.equal(hub.clientCount(), 0);
  } finally {
    hub.close();
  }
});

// ------------------------------------------------------------------ question broker

test('question broker: answer, timeout, cancel, abort', async () => {
  const hub = new Hub();
  const events = [];
  hub.on('event', (t, d) => events.push([t, d]));
  let attention = 0;
  const qb = new QuestionBroker({ hub, onNeedAttention: () => (attention += 1) });
  try {
    const p = qb.ask({ question: '  Which project?  ', options: ['a', 'b', 'a', '', null] });
    const [type, card] = events[0];
    assert.equal(type, 'question');
    assert.equal(card.question, 'Which project?');
    assert.deepEqual(card.options, ['a', 'b']);
    assert.equal(attention, 1);
    assert.equal(qb.pending().length, 1);
    assert.equal(qb.answer('nope', 'x'), false);
    assert.equal(qb.answer(card.id, 'b'), true);
    assert.deepEqual(await p, { id: card.id, answer: 'b' });
    assert.deepEqual(events[1], ['question_resolved', { id: card.id, answer: 'b' }]);
    assert.equal(qb.answer(card.id, 'again'), false);

    const t = await qb.ask({ question: 'fast', timeoutSec: 0.001 });
    assert.equal(t.timeout, true);

    const c = qb.ask({ question: 'cancel me' });
    qb.cancelAll('Interrupted by user');
    const cr = await c;
    assert.equal(cr.cancelled, true);
    assert.equal(cr.reason, 'Interrupted by user');

    const ac = new AbortController();
    const a = qb.ask({ question: 'abort me', signal: ac.signal });
    ac.abort();
    assert.equal((await a).cancelled, true);
    assert.equal(qb.pending().length, 0);

    await assert.rejects(qb.ask({ question: '' }), /question/);
    await assert.rejects(qb.ask({ question: 'x', options: 'nope' }), /options/);
  } finally {
    hub.close();
  }
});

// ------------------------------------------------------------------ bridge

test('bridge: queue, waiters, listening window, stop/resume, requeue', async () => {
  const hub = new Hub();
  const events = [];
  hub.on('event', (t, d) => events.push([t, d]));
  // The terminal holds an unanswered command at the end, so the longer busy window applies.
  const b = new Bridge({ hub, listenGraceMs: 80, busyGraceMs: 120 });
  try {
    assert.equal(b.listening, false);
    const c1 = b.enqueue({ text: 'one', images: ['/tmp/a.png'] });
    assert.ok(c1.id);
    assert.equal(b.queueLength(), 1);
    const got = await b.next(1000);
    assert.equal(got.text, 'one');
    assert.deepEqual(got.images, ['/tmp/a.png']);
    assert.equal(b.listening, true);
    // a waiting poll gets the next command directly
    const waiting = b.next(1000);
    await sleep(5);
    b.enqueue({ text: 'two' });
    assert.equal((await waiting).text, 'two');
    assert.equal(await b.next(10), null);
    // requeue goes to the front
    const three = b.enqueue({ text: 'three' });
    b.requeue({ id: 'zero', text: 'zero' });
    assert.equal((await b.next(10)).text, 'zero');
    assert.equal((await b.next(10)).text, 'three');
    // abort releases the slot
    const ac = new AbortController();
    const aborted = b.next(5000, { signal: ac.signal });
    ac.abort();
    assert.equal(await aborted, null);
    assert.equal(b.waiters.size, 0);
    // listening flips off after the grace window
    await sleep(150);
    assert.equal(b.listening, false);
    assert.ok(events.some(([t, d]) => t === 'bridge' && d.listening === false));
    // reply events
    const replies = [];
    b.on('reply', (r) => replies.push(r));
    b.reply({ text: 'done', final: true });
    assert.deepEqual(replies[0], { text: 'done', final: true, speak: true, commandId: three.id });
    b.reply({ text: 'late', speak: false });
    assert.deepEqual(replies[1], { text: 'late', final: false, speak: false, commandId: null });
    // stop answers waiters and future polls
    const w = b.next(5000);
    b.stop();
    assert.deepEqual(await w, { stop: true });
    assert.deepEqual(await b.next(10), { stop: true });
    b.resume();
    assert.equal(await b.next(10), null);
  } finally {
    b.close();
    hub.close();
  }
});

// ------------------------------------------------------------------ session manager

test('session normalizes the stream into transcript items and events', async () => {
  const { s, of, engine, hub } = makeSession();
  try {
    const { id } = await s.submit({ text: 'deploy 🚀', source: 'voice' });
    const e = await engine();
    await s.drain();
    assert.equal(e.opts.cwd, s.projectDir);
    assert.deepEqual(e.opts.allowedTools, READ_ONLY_TOOLS);
    assert.equal(e.opts.resume, false);
    assert.ok(fs.existsSync(e.opts.mcpConfigPath));
    assert.ok(fs.existsSync(e.opts.systemPromptPath));
    const mcp = JSON.parse(fs.readFileSync(e.opts.mcpConfigPath, 'utf8'));
    assert.equal(mcp.mcpServers.anywhere.command, process.execPath);
    assert.equal(mcp.mcpServers.anywhere.env.ANYWHERE_ROLE, 'engine');
    assert.equal(mcp.mcpServers.anywhere.env.ANYWHERE_TOKEN, 'tok');
    assert.equal(mcp.mcpServers.anywhere.env.ANYWHERE_DAEMON_URL, 'http://127.0.0.1:1234');
    assert.equal(mcp.mcpServers.anywhere.alwaysLoad, true);
    // CROSS-MODULE-3: a per-server timeout outlasts the longest approval deadline (86400 s).
    assert.ok(mcp.mcpServers.anywhere.timeout > 86400 * 1000, `timeout ${mcp.mcpServers.anywhere.timeout}`);
    assert.match(path.basename(e.opts.mcpConfigPath), /^mcp-.+\.json$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(e.opts.mcpConfigPath).mode & 0o777, 0o600);
    assert.deepEqual(e.sent[0], [{ type: 'text', text: 'deploy 🚀' }]);
    const user = s.messages[0];
    assert.equal(user.id, id);
    assert.equal(user.role, 'user');
    assert.equal(user.source, 'voice');

    e.feed({ type: 'system', subtype: 'init', session_id: e.opts.sessionId, model: 'claude-x', mcp_servers: [{ name: 'anywhere', status: 'connected' }] });
    e.feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg1' } } });
    e.feed({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    e.feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Deploy' } } });
    e.feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ing…' } } });
    // subagent output is not streamed into the transcript
    e.emit('message', { type: 'stream_event', parent_tool_use_id: 'toolu_task', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SUB' } } });
    e.feed({ type: 'assistant', message: { id: 'msg1', content: [{ type: 'text', text: 'Deploying now.' }] } });
    e.feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg2' } } });
    e.feed({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash' } } });
    assert.equal(s.status, 'acting');
    e.feed({ type: 'assistant', message: { id: 'msg2', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'gcloud run deploy' } }] } });
    e.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(10000), is_error: false }] } });
    const png = Buffer.from('89504e470d0a1a0a0000000d494844520000002000000010', 'hex').toString('base64');
    e.feed({ type: 'assistant', message: { id: 'msg3', content: [{ type: 'tool_use', id: 'toolu_2', name: 'mcp__anywhere__screenshot', input: {} }] } });
    e.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: '32x16' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] } });
    e.feed({ type: 'result', result: 'Deploying now.', total_cost_usd: 0.25, duration_ms: 1234, num_turns: 3, is_error: false, session_id: e.opts.sessionId });

    assert.deepEqual(of('session')[0], { id: e.opts.sessionId, model: 'claude-x' });
    const deltas = of('delta').map((d) => d.text);
    assert.deepEqual(deltas, ['Deploy', 'ing…']);
    const assistant = s.messages.filter((m) => m.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].text, 'Deploying now.');
    assert.equal(assistant[0].streaming, false);
    const tools = s.messages.filter((m) => m.role === 'tool');
    assert.equal(tools.length, 2);
    assert.equal(tools[0].displayName, 'Run command');
    assert.equal(tools[0].summary, 'gcloud run deploy');
    assert.equal(tools[0].status, 'ok');
    assert.equal(tools[0].output.length, 4096);
    assert.equal(tools[1].image, `data:image/png;base64,${png}`);
    const shot = of('screenshot')[0];
    assert.equal(shot.width, 32);
    assert.equal(shot.height, 16);
    const updates = of('tool_update');
    assert.equal(updates.length, 2);
    assert.equal(updates[0].toolUseId, 'toolu_1');
    const result = of('result')[0];
    assert.equal(result.costUsd, 0.25);
    assert.equal(result.totalCostUsd, 0.25);
    assert.equal(result.durationMs, 1234);
    assert.equal(result.isError, false);
    assert.equal(result.sessionId, e.opts.sessionId);
    assert.equal(result.numTurns, 3);
    assert.equal(s.status, 'idle');
    assert.equal(readSessions()[s.projectDir].sessionId, e.opts.sessionId);
    const snap = s.snapshot();
    assert.equal(snap.session.costUsd, 0.25);
    assert.equal(snap.session.turns, 1);
    assert.equal(snap.session.model, 'claude-x');
    assert.ok(snap.screenshot.dataUrl.startsWith('data:image/png'));
    // statuses passed through the machine in order
    const statuses = of('status').map((x) => x.status);
    assert.ok(statuses.indexOf('starting') < statuses.indexOf('acting'));
    assert.equal(statuses[statuses.length - 1], 'idle');

    // second turn on the same process: the CLI reports cumulative cost
    await s.submit({ text: 'again' });
    await s.drain();
    e.feed({ type: 'result', result: 'ok', total_cost_usd: 0.3, duration_ms: 1, num_turns: 1, is_error: false });
    assert.equal(of('result')[1].costUsd, 0.05);
    assert.equal(of('result')[1].totalCostUsd, 0.3);
    assert.equal(ScriptEngine.instances.length, 1);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('session warns when the anywhere MCP server is not connected', async () => {
  const { s, engine, hub } = makeSession();
  try {
    await s.submit({ text: 'hi' });
    const e = await engine();
    e.feed({ type: 'system', subtype: 'init', session_id: 'abc', model: 'm', mcp_servers: [{ name: 'anywhere', status: 'failed' }] });
    e.feed({ type: 'system', subtype: 'init', session_id: 'abc', model: 'm', mcp_servers: [{ name: 'anywhere', status: 'failed' }] });
    const warns = s.messages.filter((m) => m.role === 'system' && /not connected/.test(m.text));
    assert.equal(warns.length, 1);
    assert.equal(warns[0].level, 'warning');
    assert.equal(s.sessionId, 'abc');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('desktop context and images become their own content blocks', async () => {
  const shotPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000080000000408', 'hex');
  const fakeComputer = { screenshot: async () => ({ png: shotPng, width: 8, height: 4 }) };
  const { s, engine, hub, config, of } = makeSession({
    computer: fakeComputer,
    context: {
      gatherContext: async ({ projectDir }) => ({ projectDir }),
      formatContext: (ctx) => `<desktop_context>project: ${ctx.projectDir}</desktop_context>`,
    },
  });
  config.context.attachDesktopContext = true;
  try {
    await s.submit({ text: 'look', attachScreenshot: true, images: [{ mediaType: 'image/jpeg', data: '/9j/AAAA' }, { mediaType: 'image/png', data: 'data:image/png;base64,iVBORw==' }] });
    const e = await engine();
    await s.drain();
    const blocks = e.sent[0];
    assert.equal(blocks.length, 5);
    assert.match(blocks[0].text, /^<desktop_context>project: /);
    assert.deepEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shotPng.toString('base64') } });
    assert.deepEqual(blocks[2], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/AAAA' } });
    assert.deepEqual(blocks[3], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } });
    assert.deepEqual(blocks[4], { type: 'text', text: 'look' });
    assert.equal(s.messages[0].images, 3);
    assert.equal(of('screenshot')[0].width, 8);
    await assert.rejects(s.submit({ text: 'x', images: [{ mediaType: 'text/html', data: 'AAAA' }] }), /mediaType/);
    await assert.rejects(s.submit({ text: 'x', images: [{ mediaType: 'image/png', data: '<script>' }] }), /base64/);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('approvals and questions drive the status; interrupt cancels them and pauses the guard', async () => {
  const pendingList = [];
  const perms = {
    cancelled: null,
    pending: () => pendingList,
    cancelAll(reason) {
      this.cancelled = reason;
      pendingList.length = 0;
    },
  };
  const { s, engine, hub, questions } = makeSession({ permissions: perms });
  try {
    await s.submit({ text: 'work' });
    const e = await engine();
    await s.drain();
    e.feed({ type: 'system', subtype: 'init', session_id: 'sid', model: 'm', mcp_servers: [{ name: 'anywhere', status: 'connected' }] });
    assert.equal(s.status, 'thinking');
    pendingList.push({ id: 'ap1' });
    hub.broadcast('approval_request', { id: 'ap1' });
    await sleep(5);
    assert.equal(s.status, 'waiting_approval');
    pendingList.length = 0;
    hub.broadcast('approval_resolved', { id: 'ap1', decision: 'allow' });
    await sleep(5);
    assert.equal(s.status, 'thinking');
    const q = questions.ask({ question: 'Which region?' });
    await sleep(5);
    assert.equal(s.status, 'waiting_answer');
    assert.equal(s.snapshot().pending.questions.length, 1);
    assert.deepEqual(s.guard(), { allowed: true });
    await s.interrupt();
    assert.equal(e.interrupts, 1);
    assert.equal(perms.cancelled, 'Interrupted by user');
    const qr = await q;
    assert.equal(qr.cancelled, true);
    assert.equal(qr.reason, 'Interrupted by user');
    assert.equal(s.status, 'idle');
    const g = s.guard();
    assert.equal(g.allowed, false);
    assert.match(g.reason, /resume/);
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text === 'Stopped.'));
    assert.ok(!s.messages.some((m) => m.role === 'system' && m.level === 'error'), 'a user Stop is not reported as an error');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('stop during a tool call: status stays "stopping" and no error line is added', async () => {
  const { s, engine, hub, of } = makeSession();
  try {
    await s.submit({ text: 'delete it' });
    const e = await engine();
    await s.drain();
    e.feed({ type: 'system', subtype: 'init', session_id: 'sid', model: 'm', mcp_servers: [] });
    e.feed({ type: 'assistant', message: { id: 'msg1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf x' } }] } });
    e.interrupt = async () => {
      e.interrupts += 1;
      // The CLI rejects the pending tool, then ends the turn.
      e.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'rejected' }] } });
      e.feed({ type: 'result', result: '', total_cost_usd: 0, is_error: true, subtype: 'error_during_execution' });
      return { ok: true, killed: false };
    };
    const before = of('status').length;
    await s.interrupt();
    const after = of('status').slice(before).map((x) => x.status);
    assert.equal(after[0], 'stopping');
    assert.ok(!after.includes('thinking'), `no "thinking" while stopping: ${after.join(', ')}`);
    assert.equal(s.status, 'idle');
    assert.equal(of('result').pop().interrupted, true);
    assert.ok(!s.messages.some((m) => m.role === 'system' && m.level === 'error'));
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text === 'Stopped.'));
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('answered approval cards leave a line in the transcript; cancelled ones do not', async () => {
  const { s, hub } = makeSession();
  try {
    const card = (id, summary, risk = 'high') => hub.broadcast('approval_request', { id, toolName: 'Bash', displayName: 'Run command', summary, risk });
    card('a1', 'Run: rm -rf /tmp/x');
    hub.broadcast('approval_resolved', { id: 'a1', decision: 'allow', by: 'user' });
    card('a2', 'Run: rm -rf /tmp/y');
    hub.broadcast('approval_resolved', { id: 'a2', decision: 'deny', by: 'user', message: 'User denied: keep it' });
    card('a3', 'Run: rm -rf /tmp/z');
    hub.broadcast('approval_resolved', { id: 'a3', decision: 'cancelled', by: 'cancel', message: 'Interrupted by user' });
    card('a4', 'Run: git push', 'medium');
    hub.broadcast('approval_resolved', { id: 'a4', decision: 'timeout', by: 'timeout' });
    hub.broadcast('approval_resolved', { id: 'unknown', decision: 'allow', by: 'user' });
    const notes = s.messages.filter((m) => m.role === 'system').map((m) => [m.level, m.text]);
    assert.deepEqual(notes, [
      ['info', 'You allowed (high risk): Run: rm -rf /tmp/x'],
      ['warning', 'You denied: Run: rm -rf /tmp/y (“keep it”)'],
      ['warning', 'Denied, no answer in time: Run: git push'],
    ]);
    assert.equal(s.approvalCards.size, 0);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('stop while the command is still being prepared drops it', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { s, hub, config } = makeSession({
    context: { gatherContext: () => gate.then(() => ({})), formatContext: () => '<desktop_context></desktop_context>' },
  });
  config.context.attachDesktopContext = true;
  try {
    await s.submit({ text: 'never sent' });
    await sleep(20);
    await s.interrupt();
    release();
    await s.drain();
    const e = ScriptEngine.instances[0];
    assert.ok(!e || e.sent.length === 0);
    assert.ok(s.messages.some((m) => /cancelled before it was sent/.test(m.text)));
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('transcript is capped at 500 items and old images are dropped', async () => {
  const { s, hub } = makeSession();
  try {
    for (let i = 0; i < MAX_MESSAGES + 25; i += 1) s.system(`n${i}`);
    assert.equal(s.messages.length, MAX_MESSAGES);
    assert.equal(s.messages[0].text, 'n25');
    s.setMode('bridge');
    for (let i = 0; i < 20; i += 1) s.activity({ tool: 'screenshot', image: 'iVBORw0KGgo=', summary: `${i}` });
    const withImages = s.messages.filter((m) => m.role === 'tool' && m.image);
    assert.equal(withImages.length, 12);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('engine crash → error status, next submit resumes; config change restarts when idle', async () => {
  const { s, engine, hub, of, config } = makeSession();
  try {
    await s.submit({ text: 'one' });
    const e1 = await engine();
    await s.drain();
    e1.feed({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', mcp_servers: [{ name: 'anywhere', status: 'connected' }] });
    e1.crash('Error: something exploded');
    assert.equal(s.status, 'error');
    const err = s.messages.filter((m) => m.role === 'system' && m.level === 'error').pop();
    assert.match(err.text, /exited unexpectedly/);
    assert.match(err.text, /something exploded/);
    await s.submit({ text: 'two' });
    await s.drain();
    const e2 = ScriptEngine.instances[1];
    assert.equal(e2.opts.resume, true);
    assert.equal(e2.opts.sessionId, 'sess-1');
    e2.feed({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', mcp_servers: [{ name: 'anywhere', status: 'connected' }] });
    e2.feed({ type: 'result', result: 'ok', total_cost_usd: 0.01, is_error: false });
    assert.equal(s.status, 'idle');
    // settings change while idle → engine stops now, next submit respawns with resume
    config.engine = { ...config.engine, model: 'opus' };
    s.applyConfig(config);
    await sleep(5);
    assert.equal(e2.running, false);
    await s.submit({ text: 'three' });
    await s.drain();
    const e3 = ScriptEngine.instances[2];
    assert.equal(e3.opts.model, 'opus');
    assert.equal(e3.opts.resume, true);
    assert.ok(of('status').some((x) => x.status === 'error'));
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('a command sent while a settings change restarts the engine goes to the new engine', async () => {
  const { s, engine, hub, config } = makeSession();
  try {
    await s.submit({ text: 'one' });
    const e1 = await engine();
    await s.drain();
    e1.feed({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', mcp_servers: [{ name: 'anywhere', status: 'connected' }] });
    e1.feed({ type: 'result', result: 'ok', total_cost_usd: 0.01, is_error: false });
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
    config.engine = { ...config.engine, model: 'opus' };
    s.applyConfig(config);
    await s.submit({ text: 'two' });
    await s.drain();
    const e2 = ScriptEngine.instances[1];
    assert.ok(e2, 'a new engine was started');
    assert.equal(e2.opts.model, 'opus');
    assert.equal(e2.opts.resume, true);
    assert.equal(e2.sent.length, 1);
    assert.equal(e1.sent.length, 1);
    assert.ok(!s.messages.some((m) => m.role === 'system' && m.level === 'error'), 'no "Claude Code is not running" error');
    assert.notEqual(s.status, 'error');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('resume failure retries once with a fresh session id and resends the turn', async () => {
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  fs.writeFileSync(paths.sessionsPath(), JSON.stringify({ [projectDir]: { sessionId: 'missing-1', updatedAt: new Date().toISOString() } }));
  const { s, engine, hub } = makeSession({ projectDir });
  try {
    await s.submit({ text: 'hello' });
    const e1 = await engine();
    await s.drain();
    assert.equal(e1.opts.resume, true);
    assert.equal(e1.opts.sessionId, 'missing-1');
    e1.crash('No conversation found with session ID: missing-1', 300);
    await sleep(20);
    const e2 = ScriptEngine.instances[1];
    assert.ok(e2, 'a second engine was started');
    assert.equal(e2.opts.resume, false);
    assert.notEqual(e2.opts.sessionId, 'missing-1');
    assert.deepEqual(e2.sent[0], [{ type: 'text', text: 'hello' }]);
    assert.ok(s.messages.some((m) => /Could not resume/.test(m.text)));
    assert.equal(readSessions()[projectDir], undefined);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('missing claude CLI gives an actionable error', async () => {
  class NoClaude extends ScriptEngine {
    static async locate() {
      return null;
    }
  }
  const { s, hub } = makeSession({ Engine: NoClaude });
  try {
    await s.submit({ text: 'hi' });
    await s.drain();
    assert.equal(s.status, 'error');
    const err = s.messages.filter((m) => m.level === 'error').pop();
    assert.match(err.text, /npm install -g @anthropic-ai\/claude-code/);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('bridge mode: commands carry context and image files; replies become messages', async () => {
  const shotPng = Buffer.from('89504e470d0a1a0a', 'hex');
  const { s, hub, bridge, of, config } = makeSession({
    mode: 'bridge',
    computer: { screenshot: async () => ({ png: shotPng, width: 1, height: 1 }) },
    context: { gatherContext: async () => ({}), formatContext: () => '<desktop_context>ctx</desktop_context>' },
  });
  config.context.attachDesktopContext = true;
  try {
    const { id } = await s.submit({ text: 'fix the test', attachScreenshot: true, images: [{ mediaType: 'image/jpeg', data: '/9j/AAAA' }] });
    await s.drain();
    assert.ok(s.messages.some((m) => /No Claude Code terminal is listening/.test(m.text)));
    const cmd = await bridge.next(100);
    assert.equal(cmd.id, id);
    assert.equal(cmd.context, '<desktop_context>ctx</desktop_context>');
    assert.equal(cmd.images.length, 2);
    assert.ok(cmd.images[0].endsWith('.png'));
    assert.ok(cmd.images[1].endsWith('.jpg'));
    assert.deepEqual(fs.readFileSync(cmd.images[0]), shotPng);
    assert.ok(cmd.images.every((f) => path.dirname(f) === paths.runDir()));
    bridge.reply({ text: 'step 1', speak: true });
    assert.equal(s.status, 'acting');
    assert.deepEqual(of('notify')[0], { text: 'step 1', level: 'info', speak: true });
    bridge.reply({ text: 'All fixed.', final: true });
    assert.equal(of('result')[0].text, 'All fixed.');
    assert.equal(s.status, 'idle');
    s.activity({ tool: 'click', summary: '(1, 2)', ok: true });
    const row = s.messages.filter((m) => m.role === 'tool').pop();
    assert.equal(row.displayName, 'Click');
    assert.equal(row.summary, '(1, 2)');
    const files = cmd.images.slice();
    await s.shutdown();
    assert.ok(files.every((f) => !fs.existsSync(f)), 'bridge image files are removed on shutdown');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('newSession, setProject and setMode', async () => {
  const { s, hub, of, engine } = makeSession();
  try {
    await s.submit({ text: 'x' });
    const e = await engine();
    await s.drain();
    const old = s.sessionId;
    const { sessionId } = await s.newSession();
    assert.notEqual(sessionId, old);
    assert.equal(e.running, false);
    assert.equal(s.messages.length, 0);
    assert.ok(of('snapshot').length >= 1);
    await assert.rejects(s.setProject(path.join(HOME, 'nope')), /No such directory/);
    const file = path.join(HOME, 'a-file');
    fs.writeFileSync(file, '');
    await assert.rejects(s.setProject(file), /Not a directory/);
    const dir = fs.mkdtempSync(path.join(HOME, 'p2-'));
    const proj = await s.setProject(dir);
    assert.equal(proj.dir, path.resolve(dir));
    assert.equal(of('project').pop().dir, path.resolve(dir));
    await assert.rejects(s.setMode('weird'), /mode/);
    assert.deepEqual(await s.setMode('bridge'), { mode: 'bridge' });
    assert.deepEqual(of('mode').pop(), { mode: 'bridge' });
    assert.equal(s.snapshot().mode, 'bridge');
    await s.setMode('companion');
    assert.deepEqual(await s.bridge.next(10), { stop: true });
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('notify adds a system item and an event', async () => {
  const { s, hub, of } = makeSession();
  try {
    const out = s.notify({ message: 'Build finished', level: 'success', speak: true });
    assert.deepEqual(out, { ok: true, delivered: false });
    assert.deepEqual(of('notify')[0], { text: 'Build finished', level: 'success', speak: true });
    assert.equal(s.messages.pop().level, 'success');
    assert.throws(() => s.notify({ message: '' }), /message/);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('hub events reach a listener in order (once helper sanity)', async () => {
  const hub = new Hub();
  try {
    const p = once(hub, 'event');
    hub.broadcast('a', 1);
    assert.deepEqual(await p, ['a', 1]);
  } finally {
    hub.close();
  }
});
