'use strict';

/**
 * Regression tests for the feature-3 safety review (F3-SAFE-*). Each test reproduces the reviewer's
 * scenario and fails without its fix. A1 (mixed-speaker enrollment, line transcripts) lives in
 * clone-enroll.test.js; the rest is here. No network, no audio hardware.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-safety-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_DAEMON_URL;
delete process.env.ANYWHERE_TOKEN;
delete process.env.ANYWHERE_LOG_FILE;

const ROOT = path.join(__dirname, '..');
const { createServer, validateConfigUpdate } = require('../src/daemon/server');
const { Hub } = require('../src/daemon/hub');
const { PermissionBroker, classify, sessionRuleFor } = require('../src/daemon/permissions');
const { SessionManager } = require('../src/daemon/session');
const { Computer } = require('../src/os/computer');
const { createMockDriver } = require('../src/os/index');
const desktop = require('../src/context/desktop');
const { CallSession, VoiceChain } = require('../src/calls/session');
const { CallManager } = require('../src/calls/manager');
const { AudioBridge, AudioSelfTest } = require('../src/calls/audio-bridge');
const answer = require('../src/calls/answer');
const greeting = require('../src/calls/greeting');
const policy = require('../src/calls/policy');
const signatures = require('../src/calls/signatures');
const quality = require('../src/voice/clone/quality');
const profile = require('../src/voice/clone/profile');
const { CloneService, cleanupCloneRenders } = require('../src/voice/clone');

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function waitFor(cond, { timeoutMs = 4000, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// ------------------------------------------------------------------------------ F3-SAFE-D1

const TOKEN = 'main-token-0123456789abcdef';
const ENGINE = 'engine-token-0123456789abcdef';

async function daemon({ broker, hub = new Hub(), extra = {} } = {}) {
  const server = createServer({ hub, session: null, permissions: broker, questions: { answer: () => true }, config: { calls: {}, voice: {} }, token: TOKEN, engineToken: ENGINE, instanceId: 'i', version: '0', ...extra });
  const port = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body, { token = TOKEN, headers = {} } = {}) => {
    const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
  const dialog = { 'X-Anywhere-UI': server.uiKey, Origin: base };
  return { server, port, base, api, dialog, hub, close: () => server.close() };
}

test('F3-SAFE-D1: the engines\' token cannot answer cards, change settings or modes; a "click" counts only from the dialog window', async () => {
  const hub = new Hub();
  const broker = new PermissionBroker({ config: { permissions: { mode: 'smart' } }, hub, audit: () => {} });
  const d = await daemon({ broker, hub });
  try {
    // The repro: the arm card is raised, then an engine (or anyone with a token) posts via:"click".
    const pending = broker.requestCritical({ toolName: 'mcp__anywhere__calls_arm', input: {}, reason: 'Answer phone calls for you with your voice', summary: 'Answer calls?', toolUseId: 'calls_arm_x', clickOnly: true });
    const card = await waitFor(() => broker.pending()[0], { what: 'the card' });
    for (const [method, p, body] of [
      ['POST', '/api/approval', { id: card.id, decision: 'allow', via: 'click' }],
      ['POST', '/api/answer', { id: 'q', text: 'yes' }],
      ['POST', '/api/config', { permissions: { mode: 'auto' } }],
      ['POST', '/api/mode', { mode: 'bridge' }],
      ['POST', '/api/shutdown', {}],
    ]) {
      const r = await d.api(method, p, body, { token: ENGINE });
      assert.equal(r.status, 403, `${p} with the engine token`);
      assert.equal(r.json.code, 'ENGINE_FORBIDDEN');
    }
    // ...even with the dialog's header (the engine never has the main token's dialog credential anyway).
    assert.equal((await d.api('POST', '/api/approval', { id: card.id, decision: 'allow', via: 'click' }, { token: ENGINE, headers: d.dialog })).status, 403);
    // The engines' token still reaches its own routes.
    assert.equal((await d.api('GET', '/api/mcp/guard', undefined, { token: ENGINE })).status !== 401, true);
    // The main token without the dialog credential: a "click" is refused, and so is an allow without via.
    const forged = await d.api('POST', '/api/approval', { id: card.id, decision: 'allow', via: 'click' });
    assert.equal(forged.status, 403);
    assert.equal(forged.json.code, 'CLICK_NEEDS_DIALOG');
    assert.equal((await d.api('POST', '/api/approval', { id: card.id, decision: 'allow' })).status, 409, 'no via: refused for a critical card (the live run found it accepted)');
    assert.equal((await d.api('POST', '/api/approval', { id: card.id, decision: 'allow', via: 'typed' })).status, 409, 'click-only: the terminal cannot allow it');
    assert.equal((await d.api('POST', '/api/approval', { id: card.id, decision: 'allow', via: 'click' }, { headers: { 'X-Anywhere-UI': d.server.uiKey, Origin: 'http://evil.example' } })).status, 403, 'a foreign origin');
    assert.equal(broker.pending().length, 1, 'the card is still waiting');
    // The dialog window's click allows it, and the decision says so.
    const decisions = [];
    broker.on('decision', (e) => decisions.push(e));
    assert.equal((await d.api('POST', '/api/approval', { id: card.id, decision: 'allow', via: 'click' }, { headers: d.dialog })).status, 200);
    assert.equal((await pending).behavior, 'allow');
    assert.equal(decisions.find((e) => e.toolUseId === 'calls_arm_x').dialog, true);
  } finally {
    await d.close();
    hub.close();
  }
});

test('SEC-1: an engine cannot report the dialog hidden, and the approval policy is not loosened while Claude works', async () => {
  const hub = new Hub();
  const broker = new PermissionBroker({ config: { permissions: { mode: 'smart' } }, hub, audit: () => {} });
  const reports = [];
  const d = await daemon({ broker, hub, extra: { config: { calls: {}, voice: {}, permissions: { mode: 'smart', alwaysAllow: [], alwaysAsk: ['Bash(git push:*)'] } }, uihost: { noteVisibility: (r) => reports.push(r) } } });
  let working = true;
  d.server.session = { engineWorking: () => working };
  try {
    // Where windows cannot be listed, these reports decide whether an engine's clicks may run.
    const fake = await d.api('POST', '/api/ui/visibility', { page: 'p', visible: false, focused: false }, { token: ENGINE });
    assert.equal(fake.status, 403);
    assert.equal(fake.json.code, 'ENGINE_FORBIDDEN');
    assert.equal((await d.api('POST', '/api/ui/visibility', { page: 'p', visible: true, focused: true }, { headers: d.dialog })).status, 200);
    assert.deepEqual(reports, [{ page: 'p', visible: true, focused: true }]);
    // ...nor through a command that uses the user's token (self-escalation, as for /api/config).
    assert.equal(classify('Bash', { command: `curl -s -X POST -H "Authorization: Bearer $T" -d '{"page":"p","visible":false}' http://127.0.0.1:47120/api/ui/visibility` }).risk, 'critical');
    // The reviewer's escalation: Settings → Autopilot → Save, pressed by the engine's own input during its turn.
    for (const body of [
      { permissions: { mode: 'auto' } },
      { permissions: { alwaysAllow: ['Bash'] } },
      { permissions: { alwaysAsk: [] } },
    ]) {
      const r = await d.api('POST', '/api/config', body, { headers: d.dialog });
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.equal(r.json.code, 'LOOSENING_WHILE_WORKING');
    }
    assert.equal(d.server.deps.config.permissions.mode, 'smart');
    // Tightening, and other settings, still save during a turn; loosening saves once Claude is idle.
    assert.equal((await d.api('POST', '/api/config', { permissions: { mode: 'ask' } }, { headers: d.dialog })).status, 200);
    assert.equal((await d.api('POST', '/api/config', { voice: { speakResponses: false } }, { headers: d.dialog })).status, 200);
    working = false;
    assert.equal((await d.api('POST', '/api/config', { permissions: { mode: 'auto' } }, { headers: d.dialog })).status, 200);
    assert.equal(d.server.deps.config.permissions.mode, 'auto');
  } finally {
    await d.close();
    hub.close();
  }
});

test('F3-SAFE-D1: the dialog credential comes only from a dialog launch code; API-minted pages get the caller\'s own token', async () => {
  const d = await daemon({ broker: new PermissionBroker({ config: { permissions: { mode: 'ask' } }, hub: new Hub(), audit: () => {} }) });
  try {
    const trade = async (url) => {
      const code = new URL(url).searchParams.get('launch');
      const res = await fetch(`${d.base}/api/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      return res.json();
    };
    assert.deepEqual(await trade(d.server.launchUrl()), { token: TOKEN, ui: d.server.uiKey }, 'the window host\'s launch');
    assert.deepEqual(await trade(d.server.launchUrl(undefined, { grant: 'user' })), { token: TOKEN });
    assert.deepEqual(await trade(d.server.launchUrl(undefined, { grant: 'engine' })), { token: ENGINE });
    // /api/clone/standalone: the engine's page gets the engine token, a user's page the token; never the credential.
    const deps = d.server.deps;
    deps.cloneFactory = () => new EventEmitter();
    const byEngine = await d.api('POST', '/api/clone/standalone', {}, { token: ENGINE });
    assert.equal(byEngine.status, 200);
    assert.deepEqual(await trade(byEngine.json.url), { token: ENGINE });
    const byUser = await d.api('POST', '/api/clone/standalone', {});
    assert.deepEqual(await trade(byUser.json.url), { token: TOKEN });
    // The dialog credential is in no run file: the engine's MCP config carries the engine token only.
    assert.ok(d.server.uiKey && d.server.uiKey.length >= 24);
  } finally {
    await d.close();
  }
});

test('F3-SAFE-D1: reading run files is a credential read; commands that reach the daemon\'s approval, settings or mode routes are critical', () => {
  const ctx = { homeDir: os.homedir(), anywhereHome: HOME };
  for (const cmd of ['cat ~/.claude-anywhere/run/mcp-1234.json', `cat ${HOME}/run/mcp-1234.json`, `cat ${HOME}/run/*.json`, `cat ${HOME}/calls/abc/engine/mcp.json`, `grep -r token ${HOME}/run`]) {
    const r = classify('Bash', { command: cmd }, ctx);
    assert.equal(r.risk, 'high', cmd);
    if (!cmd.startsWith('grep')) assert.equal(sessionRuleFor('Bash', { command: cmd }, r, ctx), null, `no "always" rule: ${cmd}`);
  }
  for (const cmd of [
    `curl -X POST http://127.0.0.1:47611/api/approval -H 'Content-Type: application/json' -d '{"id":"ap_1","decision":"allow","via":"click"}'`,
    `node -e "fetch('http://127.0.0.1:'+port+'/api/calls/arm',{method:'POST'})"`,
    `python3 -c "import urllib.request as u; u.urlopen(u.Request('http://localhost:47120/api/config', b'{}', method='POST'))"`,
    `wget --post-data='{"mode":"auto"}' http://127.0.0.1:47120/api/mode`,
  ]) {
    assert.equal(classify('Bash', { command: cmd }, ctx).risk, 'critical', cmd);
  }
  assert.notEqual(classify('Bash', { command: 'curl https://api.example.com/api/config' }, ctx).risk, 'critical', 'someone else\'s API');
});

test('LIVE-1: interpreter code that reads the run files or daemon.json is a credential read too, not "Runs python3 code"', () => {
  const ctx = { homeDir: os.homedir(), anywhereHome: HOME };
  // The live repro: these ran with no card (medium) and printed the token's length, while cat/grep/jq asked.
  for (const cmd of [
    `python3 -c "import json;print(len(json.load(open('${HOME}/daemon.json'))['token']))"`,
    `node -e "require('${HOME}/daemon.json').token.length"`,
    `node -p "require('fs').readFileSync('${HOME}/run/mcp-1234.json','utf8')"`,
    `python3 -c "import os,json;print(json.load(open(os.environ['ANYWHERE_HOME']+'/daemon.json'))['token'])"`,
    `node -e "console.log(require(require('path').join(require('os').homedir(),'.claude-anywhere','daemon.json')).token)"`,
    `ruby -e 'puts File.read("${HOME}/daemon.json")'`,
    'python3 -c "print(open(\'/home/u/.ssh/id_rsa\').read())"',
    `python3 tool.py ${HOME}/daemon.json`,
  ]) {
    const r = classify('Bash', { command: cmd }, ctx);
    assert.equal(r.risk, 'high', cmd);
    assert.match(r.reason, /^Reads /, cmd);
    assert.equal(sessionRuleFor('Bash', { command: cmd }, r, ctx), null, `no "always" rule: ${cmd}`);
  }
  // Other inline code stays as it was.
  for (const cmd of ['python3 -c "print(1+1)"', `node -e "console.log(require('./package.json').version)"`, 'python3 manage.py runserver', `python3 -c "import json; json.load(open('/etc/docker/daemon.json'))"`]) {
    assert.equal(classify('Bash', { command: cmd }, ctx).risk, 'medium', cmd);
  }
});

test('F3-SAFE-D1: engine input never clicks, drags, scrolls or types in the Claude Anywhere dialog; actions pause while a critical card waits', async () => {
  const dialogWin = { id: '0x99', app: 'Claude Anywhere', title: 'Claude Anywhere', pid: 1, x: 1000, y: 100, width: 400, height: 600, focused: false, minimized: false };
  const other = { id: '0x10', app: 'Brave-browser', title: 'Zoho Cliq - Brave', pid: 2, x: 0, y: 0, width: 1000, height: 768, focused: true, minimized: false };
  const driver = createMockDriver({ displays: [{ x: 0, y: 0, width: 1600, height: 900 }], windows: [other, dialogWin], cursor: { x: 500, y: 500 } });
  const comp = new Computer({ driver, config: { actionDelayMs: 0, failsafe: false, maxWidth: 1600, maxHeight: 900 }, platform: 'linux', protect: desktop.isOwnWindow });
  await comp.screenshot({});
  // "Allow once" on the card: refused.
  await assert.rejects(comp.click({ x: 1200, y: 600 }), (e) => e.code === 'OWN_DIALOG');
  await assert.rejects(comp.drag({ fromX: 500, fromY: 300, toX: 1200, toY: 600 }), (e) => e.code === 'OWN_DIALOG');
  await assert.rejects(comp.scroll({ x: 1100, y: 300, direction: 'down' }), (e) => e.code === 'OWN_DIALOG');
  assert.equal(driver.actions.filter((a) => a.type === 'click').length, 0);
  await comp.click({ x: 500, y: 300 });
  assert.equal(driver.actions.filter((a) => a.type === 'click').length, 1, 'elsewhere clicks work');
  await comp.key({ combo: 'enter' });
  // With the dialog focused, no key or text reaches it.
  await driver.focusWindow('0x99');
  await assert.rejects(comp.key({ combo: 'enter' }), (e) => e.code === 'OWN_DIALOG');
  await assert.rejects(comp.typeText({ text: 'allow' }), (e) => e.code === 'OWN_DIALOG');

  // The daemon's guard (GET /api/mcp/guard) pauses input while a critical card waits.
  const guard = SessionManager.prototype.guard;
  const self = { pauseUntil: 0, status: 'idle', mode: 'companion', bridge: null, permissions: { pending: () => [{ id: 'a', risk: 'critical' }] } };
  assert.equal(guard.call(self).allowed, false);
  assert.match(guard.call(self).reason, /critical action is waiting/);
  self.permissions.pending = () => [{ id: 'b', risk: 'high' }];
  assert.equal(guard.call(self).allowed, true);
});

// ------------------------------------------------------------------------------ F3-SAFE-B1

/** The sidecar's live player: the first `failFirst` utterances fail like a synthesis error does. */
class Player extends EventEmitter {
  constructor({ failFirst = 0 } = {}) {
    super();
    this.failFirst = failFirst;
    this.said = [];
  }

  async request(op, p = {}) {
    if (op !== 'tts.say') return { ok: true };
    const fail = this.said.filter((x) => x.failed).length < this.failFirst;
    this.said.push({ text: p.text, failed: fail, wav: p.wav || null });
    setImmediate(() => {
      if (fail) {
        // audio_io.py _end for a synthesis error before any audio (the reviewer's repro shape).
        this.emit('event', { event: 'playback.end', utteranceId: p.utteranceId, interrupted: false, started: false, chars: p.text.length, playedChars: 0, error: { code: 'INTERNAL', message: 'synthesis failed' } });
      } else {
        this.emit('event', { event: 'playback.start', utteranceId: p.utteranceId });
        this.emit('event', { event: 'playback.end', utteranceId: p.utteranceId, interrupted: false, started: true, chars: p.text.length, playedChars: p.text.length });
      }
    });
    return { queued: true };
  }
}

class Engine extends EventEmitter {
  constructor(reply = 'Sure, I am Deepanshu. What do you need?') {
    super();
    this.running = true;
    this.reply = reply;
    this.sent = [];
  }

  send(t) {
    const text = typeof t === 'string' ? t : t.map((b) => b.text).join('\n');
    this.sent.push(text);
    const reply = text.includes('[call connected') ? 'OK' : this.reply;
    setImmediate(() => {
      const id = `m${Math.random()}`;
      this.emit('message', { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id } } });
      this.emit('message', { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
      this.emit('message', { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop' } });
      this.emit('message', { type: 'result', subtype: 'success', is_error: false, result: reply });
    });
  }

  interrupt() {
    return Promise.resolve();
  }

  stop() {
    this.running = false;
    return Promise.resolve();
  }
}

function callSession({ sidecar, voice, engine = new Engine(), hangups = [] } = {}) {
  return new CallSession({
    id: 'c0ffee00-0000-4000-8000-0000000000b1',
    caller: 'Ankit Sharma',
    app: 'zoho-cliq',
    appName: 'Zoho Cliq',
    config: { calls: { maxCallMinutes: 15 } },
    sidecar,
    voice,
    engine,
    hangUpCall: async (why) => hangups.push(why),
    audioParams: null,
    ownerName: 'Deepanshu Patel',
    pronoun: 'his',
    options: { fillerAfterMs: 5000, stillThereMs: 60000, silenceHangupMs: 120000 },
  });
}

test('F3-SAFE-B1: a greeting that failed to play is not a heard disclosure; it is said again with the next voice, and nothing else is said before', async () => {
  const sc = new Player({ failFirst: 1 });
  const voice = new VoiceChain({
    clone: { speak: (text, { utteranceId }) => sc.request('tts.say', { text, utteranceId }) },
    request: (op, p) => sc.request(op, p),
    piper: { synthesize: async (text, { outFile }) => fs.writeFileSync(outFile, 'RIFF') },
    tmpDir: path.join(HOME, 'b1-tmp'),
    cloned: true,
  });
  const s = callSession({ sidecar: sc, voice });
  await s.start();
  await waitFor(() => sc.said.length >= 2, { what: 'the disclosure said again' });
  assert.equal(sc.said[0].failed, true);
  assert.match(sc.said[0].text, /^Hi Ankit, this is Deepanshu's AI assistant, speaking in his voice\. I'm transcribing this call/);
  // Said again with Piper: the clone failed, so the disclosure no longer claims "speaking in his voice".
  assert.match(sc.said[1].text, /^Sorry, just so you know: This is Deepanshu's AI assistant\. I'm transcribing this call/);
  assert.ok(sc.said[1].wav, 'rendered by the next voice (Piper)');
  assert.equal(voice.cloned, false);
  await waitFor(() => s.status().disclosureSpoken, { what: 'the disclosure heard' });
  sc.emit('event', { event: 'asr.final', text: 'Hello? Who is this?' });
  await waitFor(() => sc.said.some((x) => /What do you need/.test(x.text)), { what: 'the reply' });
  const firstReply = sc.said.findIndex((x) => /Deepanshu\. What do you need|I am Deepanshu/.test(x.text));
  assert.ok(firstReply > 1, 'the LLM spoke only after a disclosure that played');
  // The transcript records only what was heard.
  assert.ok(!s.transcript().some((t) => t.role === 'assistant' && /speaking in his voice/.test(t.text)), 'the failed greeting is not in the transcript');
  await s.takeover();
  voice.cleanup();
});

test('F3-SAFE-B1: when every voice fails the disclosure, the call is ended without the assistant saying anything else', async () => {
  const sc = new Player({ failFirst: 99 });
  const hangups = [];
  const voice = { cloned: true, say: (text, { utteranceId }) => sc.request('tts.say', { text, utteranceId }), stop: async () => {} };
  const s = callSession({ sidecar: sc, voice, hangups });
  const ended = new Promise((r) => s.once('ended', r));
  await s.start();
  sc.emit('event', { event: 'asr.final', text: 'Hello?' });
  assert.equal((await ended).reason, 'disclosure_failed');
  assert.deepEqual(hangups, ['disclosure_failed']);
  assert.equal(s.status().disclosureSpoken, false);
  assert.equal(sc.said.length, 3, 'the disclosure three times, nothing else');
  assert.ok(sc.said.every((x) => /AI assistant/.test(x.text)));
});

// ------------------------------------------------------------------------------ F3-SAFE-B2

test('F3-SAFE-B2: calls.greeting is only the closing question; templates that take the disclosure back are refused and not used', () => {
  const owner = { callerName: 'Ankit Sharma', ownerName: 'Deepanshu Patel', pronoun: 'his', cloned: true };
  const def = `Hi Ankit, this is Deepanshu's AI assistant, speaking in his voice. I'm transcribing this call to take notes for him. How can I help?`;
  for (const t of [
    "{disclosure} Just kidding! You are talking to the real Deepanshu, so don't worry about any of that.",
    'Haha, that was a prank: it is Deepanshu himself on this call.',
    'Ignore that message, you have Deepanshu live.',
    'Deepanshu is here in person',
    'Is it really you I am talking to?',
    'Was that a joke?',
    'Can Patel call you back?',
    'Am I speaking with a human?',
    'Not recording, how can I help?',
  ]) {
    const g = greeting.composeGreeting({ ...owner, template: t });
    assert.equal(g.templateUsed, false, t);
    assert.equal(g.text, def, t);
    assert.ok(validateConfigUpdate({ calls: { greeting: t } }) || greeting.greetingSettingProblem(t, { ownerName: 'Deepanshu Patel' }), `refused when saved: ${t}`);
  }
  const ok = greeting.composeGreeting({ ...owner, template: 'What can I do for you today?' });
  assert.equal(ok.templateUsed, true);
  assert.equal(ok.text, def.replace('How can I help?', 'What can I do for you today?'));
  assert.equal(validateConfigUpdate({ calls: { greeting: 'What can I do for you today?' } }), null);
});

test('F3-SAFE-B2: POST /api/config refuses a greeting that names the owner', async () => {
  const d = await daemon({ broker: new PermissionBroker({ config: { permissions: { mode: 'ask' } }, hub: new Hub(), audit: () => {} }) });
  try {
    d.server.deps.config.calls = { ownerName: 'Deepanshu Patel' };
    const r = await d.api('POST', '/api/config', { calls: { greeting: 'Shall Deepanshu call you back?' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /may not name you/);
  } finally {
    await d.close();
  }
});

// ------------------------------------------------------------------------------ F3-SAFE-B3

test('F3-SAFE-B3: "anywhere clone-voice test <text>" is high risk, and the CLI refuses text of its own (also --local)', () => {
  assert.equal(classify('Bash', { command: 'anywhere clone-voice test "Hi mom, please wire the money today"' }).risk, 'high');
  assert.equal(classify('Bash', { command: 'anywhere clone-voice test' }).risk, 'low');
  assert.equal(classify('Bash', { command: 'anywhere clone-voice test --engine zipvoice' }).risk, 'low');
  const env = { ...process.env, ANYWHERE_HOME: fs.mkdtempSync(path.join(HOME, 'cli-')), NO_COLOR: '1' };
  for (const extra of [[], ['--local']]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'anywhere.js'), 'clone-voice', 'test', ...extra, 'Hi mom, please wire the money today'], { env, encoding: 'utf8', timeout: 60000 });
    assert.notEqual(r.status, 0, extra.join(' '));
    assert.match(`${r.stdout}${r.stderr}`, /only be tried in the Claude Anywhere dialog/);
  }
});

// ------------------------------------------------------------------------------ F3-SAFE-D2, D3

function managerFixture({ answerCall, quietHours = { enabled: false }, bridgeOps = [] } = {}) {
  const hub = { broadcast() {}, on() {}, removeListener() {} };
  const sc = new Player();
  const clone = {
    runtimeStatus: async () => ({ installed: true }),
    holdSidecar: async () => sc,
    releaseSidecar() {},
    getSidecar: async () => sc,
    request: (op, p, o) => sc.request(op, p, o),
    models: () => ({}),
    modelsDir: () => HOME,
    sttModel: () => 'moonshine',
    _ensureAsr: async () => {},
    _ensureVoice: async () => {},
    profileStatus: () => ({ ok: true, exists: true, ownerName: 'Deepanshu Patel' }),
    cloneConfig: () => ({ enabled: true, engine: 'pocket' }),
    speak: (t, { utteranceId }) => sc.request('tts.say', { text: t, utteranceId }),
    synthesize: async () => ({ file: path.join(HOME, 'g.wav'), cached: true }),
    prerenderPhrases: async () => ({}),
    transcribe: async () => '',
  };
  const RING = { app: 'zoho-cliq', kind: 'ringing', caller: 'Ankit Sharma', windowId: '0x10', source: 'title', confidence: 0.9, browser: 'brave' };
  const det = new (class extends EventEmitter {
    start() {}
    stop() {}
    status() {
      return {};
    }
    waitToAnswer() {
      return Promise.resolve({ ok: true, ring: RING });
    }
    beginAnswer() {}
    answerFailed() {}
    callStarted() {}
    callEnded() {}
    currentRing() {
      return null;
    }
  })();
  const bridge = {
    check: async () => ({ mode: 'virtual', ready: true, issues: [] }),
    engage: async () => {
      bridgeOps.push('engage');
      return { ok: true, startParams: null };
    },
    release: async () => {
      bridgeOps.push('release');
      return { ok: true };
    },
    teardown: async () => {
      bridgeOps.push('teardown');
      return { ok: true };
    },
    setup: async () => ({ ok: true }),
  };
  const broker = new PermissionBroker({ config: { permissions: { mode: 'auto' } }, hub, audit: () => {} });
  const mgr = new CallManager({
    config: { calls: { apps: ['zoho-cliq'], answerAfterSec: 0, quietHours }, voice: {} },
    hub,
    permissions: broker,
    clone,
    getDriver: async () => ({}),
    getComputer: async () => ({}),
    bridge,
    detector: det,
    vision: {},
    jira: null,
    osRender: async (t, out) => fs.writeFileSync(out, 'x'),
    answer: { answerCall, hangUp: async () => ({ ok: true }), cameraOff: async () => ({}) },
    notes: { writeNotes: async () => path.join(HOME, 'n.md') },
    cliq: null,
    engineFactory: async () => new Engine('OK'),
    audit: () => {},
    callsDir: path.join(HOME, 'calls'),
    sessionOptions: { fillerAfterMs: 5000, stillThereMs: 60000, silenceHangupMs: 120000 },
  });
  const arm = async () => {
    const p = mgr.requestArm({ minutes: 30 });
    const card = await waitFor(() => broker.pending()[0], { what: 'the arm card' });
    broker.resolve(card.id, 'allow', undefined, { via: 'click', dialog: true });
    return p;
  };
  return { mgr, det, RING, arm, broker, bridgeOps, bridge };
}

test('LIVE-4: calls on with no call audio route fails before the click-only card, not after it', async () => {
  const f = managerFixture();
  f.bridge.check = async () => ({ mode: 'virtual', ready: false, issues: [{ level: 'error', code: 'NO_SOUND_SERVER', message: 'pactl: Connection refused', hint: 'Start PipeWire or PulseAudio' }] });
  const r = await f.mgr.requestArm({ minutes: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUDIO_NOT_READY');
  assert.match(r.error, /Call audio is not ready: pactl: Connection refused/);
  assert.equal(r.hint, 'Start PipeWire or PulseAudio');
  assert.equal(f.broker.pending().length, 0, 'no card was shown, so no click was spent');
  // With a route the card comes as before.
  f.bridge.check = async () => ({ mode: 'virtual', ready: true, issues: [] });
  const armed = await f.arm();
  assert.equal(armed.ok, true);
  await f.mgr.disarm('test');
});

test('F3-SAFE-D2: "stop answering calls" during the answer routine stops it before Accept; the routine releases the audio itself', async () => {
  let clicked = 0;
  let cont = null;
  const bridgeOps = [];
  const f = managerFixture({
    bridgeOps,
    answerCall: async (opts) => {
      await sleep(150); // vision locating Accept
      cont = opts.shouldContinue();
      if (!cont) return { ok: false, reason: 'disarmed' };
      clicked += 1;
      return { ok: true, method: 'click', caller: 'Ankit Sharma', app: 'zoho-cliq' };
    },
  });
  assert.equal((await f.arm()).armed, true);
  f.det.emit('ringing', { candidate: f.RING });
  await waitFor(() => f.mgr.state === 'answering', { what: 'answering' });
  f.mgr.disarm('user');
  assert.deepEqual(bridgeOps, ['engage'], 'disarm does not tear the route down under the answer routine');
  await waitFor(() => cont === false, { what: 'the routine asked before clicking' });
  await sleep(50);
  assert.equal(clicked, 0, 'Accept was never pressed');
  assert.equal(f.mgr.call, null, 'no AI call runs');
  assert.equal(f.mgr.status().armed, false);
  assert.deepEqual(bridgeOps, ['engage', 'release', 'teardown'], 'released by the routine, then the devices removed');
});

test('F3-SAFE-D2: turned off after Accept was pressed: the user takes the call over, the assistant says nothing', async () => {
  const bridgeOps = [];
  let f = null;
  f = managerFixture({
    bridgeOps,
    answerCall: async () => {
      await sleep(30);
      f.mgr.disarm('user'); // between the click and the verification
      return { ok: true, method: 'click', caller: 'Ankit Sharma', app: 'zoho-cliq' };
    },
  });
  await f.arm();
  f.det.emit('ringing', { candidate: f.RING });
  await waitFor(() => f.mgr.recent.some((r) => r.type === 'taken_over'), { what: 'the takeover' });
  assert.equal(f.mgr.call, null);
  assert.ok(bridgeOps.includes('release'));
});

test('F3-SAFE-D2: answerCall asks shouldContinue() right before pressing Accept and presses nothing when told to stop', async () => {
  const W = 1366;
  const H = 768;
  const BRAVE = { id: '0x10', app: 'Brave-browser', title: 'Incoming call - Ankit Sharma - Zoho Cliq - Brave', pid: 10, x: 0, y: 0, width: W, height: H, focused: true, minimized: false };
  const driver = createMockDriver({ displays: [{ x: 0, y: 0, width: W, height: H }], windows: [BRAVE], cursor: { x: 700, y: 300 } });
  const computer = new Computer({ driver, config: { actionDelayMs: 0, failsafe: false }, platform: 'linux' });
  const vision = { async detect() { return { incoming: true, app: 'Cliq', appId: 'zoho-cliq', caller: 'Ankit Sharma', accept: { x: 1269, y: 629 }, audioOnly: null, video: false, inCall: false }; } };
  const m = signatures.matchTitle(BRAVE);
  const cand = { ...m, windowId: BRAVE.id, window: { ...BRAVE }, display: 0 };
  let t = Date.now();
  let asked = 0;
  const r = await answer.answerCall({ candidate: cand, computer, driver, vision, config: { calls: { apps: ['zoho-cliq'], quietHours: { enabled: false } } }, armedUntil: t + 3600000, now: () => t, sleep: async (ms) => { t += ms; }, shouldContinue: () => (asked += 1) < 2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disarmed');
  assert.equal(driver.actions.filter((a) => a.type === 'click' || a.type === 'keyCombo').length, 0, 'no input at all');
});

test('F3-SAFE-D3: quiet-hour times must be HH:MM; bad ones are refused when saved, fail closed, and block arming', async () => {
  for (const [start, end] of [['10pm', '8am'], ['22:00', '24:00'], ['22.00', '08.00']]) {
    assert.match(validateConfigUpdate({ calls: { quietHours: { start, end } } }) || '', /must be a time as HH:MM/, `${start}–${end}`);
    assert.equal(policy.inQuietHours(new Date(2026, 9, 18, 23, 30), { enabled: true, start, end }), true, 'fail closed');
  }
  assert.equal(validateConfigUpdate({ calls: { quietHours: { start: '22:00', end: '8:00' } } }), null);
  const f = managerFixture({ quietHours: { enabled: true, start: '10pm', end: '8am' }, answerCall: async () => ({ ok: false }) });
  const r = await f.mgr.requestArm({ minutes: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'QUIET_HOURS_INVALID');
  assert.equal(f.broker.pending().length, 0, 'no card');
  // Valid hours: the card shows them as parsed.
  const g = managerFixture({ quietHours: { enabled: true, start: '22:00', end: '8:00' }, answerCall: async () => ({ ok: false }) });
  const p = g.mgr.requestArm({ minutes: 30 });
  const card = await waitFor(() => g.broker.pending()[0]);
  assert.match(card.summary, /Not during quiet hours \(22:00–08:00\)\./);
  g.broker.resolve(card.id, 'deny', 'no', { via: 'key' });
  await p;
  // `anywhere config set` refuses them too.
  const env = { ...process.env, ANYWHERE_HOME: fs.mkdtempSync(path.join(HOME, 'cfg-')), NO_COLOR: '1' };
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'anywhere.js'), 'config', 'set', 'calls.quietHours.start', '10pm'], { env, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(cli.status, 0);
  assert.match(`${cli.stdout}${cli.stderr}`, /HH:MM/);
});

// ------------------------------------------------------------------------------ F3-SAFE-C1, C2

test('F3-SAFE-C1: vision\'s caller name never overrides the call app\'s; when they disagree the caller is unbound', async () => {
  assert.deepEqual(answer.resolveCaller('Ankit Sharma', 'Priya Sharma'), { caller: null, conflict: { deterministic: 'Ankit Sharma', vision: 'Priya Sharma' } });
  assert.deepEqual(answer.resolveCaller('Ankit', 'Ankit Sharma'), { caller: 'Ankit Sharma' });
  assert.deepEqual(answer.resolveCaller('Ankit Sharma', 'ankit'), { caller: 'Ankit Sharma' });
  assert.deepEqual(answer.resolveCaller(null, 'Priya Sharma'), { caller: 'Priya Sharma' });
  assert.deepEqual(answer.resolveCaller('Ankit Sharma', null), { caller: 'Ankit Sharma' });
  // The reviewer's repro: the title says Ankit, vision reads Priya from the page.
  const W = 1366;
  const H = 768;
  const BRAVE = { id: '0x10', app: 'Brave-browser', title: 'Incoming call - Ankit Sharma - Zoho Cliq - Brave', pid: 10, x: 0, y: 0, width: W, height: H, focused: true, minimized: false };
  const driver = createMockDriver({ displays: [{ x: 0, y: 0, width: W, height: H }], windows: [BRAVE], cursor: { x: 700, y: 300 } });
  const click = driver.click;
  driver.click = async (...a) => {
    await click(...a);
    driver.state.windows[0].title = 'In call with Ankit Sharma - Zoho Cliq - Brave';
  };
  const computer = new Computer({ driver, config: { actionDelayMs: 0, failsafe: false }, platform: 'linux' });
  const vision = { async detect() { return { incoming: true, app: 'Cliq', appId: 'zoho-cliq', caller: 'Priya Sharma', accept: { x: 1269, y: 629 }, audioOnly: null, video: false, inCall: false }; } };
  const cand = { ...signatures.matchTitle(BRAVE), windowId: BRAVE.id, window: { ...BRAVE }, display: 0 };
  let t = Date.now();
  const r = await answer.answerCall({ candidate: cand, computer, driver, vision, config: { calls: { apps: ['zoho-cliq'], quietHours: { enabled: false } } }, armedUntil: t + 3600000, now: () => t, sleep: async (ms) => { t += ms; } });
  assert.equal(r.ok, true);
  assert.equal(r.caller, null);
  assert.deepEqual(r.callerConflict, { deterministic: 'Ankit Sharma', vision: 'Priya Sharma' });
  // The manager runs that call with no caller (nothing assigned or sent to anyone).
  const ran = [];
  const f = managerFixture({ answerCall: async () => ({ ...r }) });
  f.mgr._runCall = async (o) => ran.push(o);
  await f.arm();
  f.det.emit('ringing', { candidate: f.RING });
  await waitFor(() => ran.length === 1, { what: 'the call' });
  assert.equal(ran[0].caller, null);
});

test('F3-SAFE-C2: the caller\'s display name is cleaned of links before it is used in a name or a Jira comment', () => {
  for (const [raw, clean] of [
    ['Ankit bit.ly/x1', 'Ankit'],
    ['Ankit evil.dev/login', 'Ankit'],
    ['Ankit https://evil.example/x Sharma', 'Ankit Sharma'],
    ['Ankit Sharma', 'Ankit Sharma'],
  ]) {
    assert.equal(signatures.cleanCallerName(raw), clean, raw);
    assert.equal(policy.sanitizeCallerName(raw), clean, raw);
  }
  assert.equal(policy.sanitizeCallerName('Ankit sk-ant-abcdefghijklmnop1234 Sharma').includes('abcdefghijklmnop'), false, 'secrets masked');
  assert.ok(policy.sanitizeCallerName('x'.repeat(200)).length <= 60);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'calls', 'manager.js'), 'utf8');
  assert.match(src, /\(via phone call with \$\{policyMod\.sanitizeCallerName\(callerName\)/, 'the comment prefix uses the cleaned name');
});

// ------------------------------------------------------------------------------ F3-SAFE-E1

test('F3-SAFE-E1: after the caller objects to the transcription, the notes summary holds only actions, never what they said', async () => {
  const sc = new Player();
  const engine = new Engine('Okay.');
  const s = callSession({ sidecar: sc, voice: { cloned: true, say: (text, { utteranceId }) => sc.request('tts.say', { text, utteranceId }), stop: async () => {} }, engine });
  await s.start();
  await waitFor(() => s.status().disclosureSpoken);
  await s.handleUtterance("Please don't record or transcribe this call.");
  await s.handleUtterance('My divorce hearing is on Friday, can Deepanshu cover my on-call shift?');
  await sleep(50);
  s.recordAction({ name: 'call_defer', args: { request: 'Cover an on-call shift on Friday' }, summary: 'Follow-up for Deepanshu: Cover an on-call shift on Friday', deferred: true });
  assert.equal(s.saveTranscript, false);
  const before = engine.sent.length;
  const sum = await s.summarize();
  assert.equal(sum.source, 'actions');
  assert.equal(engine.sent.length, before, 'the engine is not asked for a summary');
  assert.doesNotMatch(JSON.stringify(sum), /divorce|hearing/i);
  assert.match(sum.summary, /asked not to be transcribed/);
  assert.deepEqual(sum.followUps, ['Cover an on-call shift on Friday']);
  assert.deepEqual(sum.topics, []);
  await s.takeover();
});

// ------------------------------------------------------------------------------ F3-SAFE-F1

test('F3-SAFE-F1: a self-test ending in the middle of a call does not release the call\'s audio route', async () => {
  const bridge = new AudioBridge({ platformInfo: { platform: 'linux' }, stateFile: path.join(HOME, 'f1-audio.json'), followMs: 0 });
  let released = 0;
  bridge._crashCheck = async () => {};
  bridge._mode = 'speakers';
  bridge._engageSpeakers = async () => ({ ok: true, mode: 'speakers' });
  bridge.startParams = () => ({});
  bridge._release = async () => {
    released += 1;
    return { ok: true, restored: true };
  };
  bridge.check = async () => ({ mode: 'speakers', platform: 'linux', ready: true, issues: [] });
  const st = new AudioSelfTest({ bridge, testTtlMs: 150, renderSpeech: async (t, out) => fs.writeFileSync(out, 'RIFF'), tmpDir: path.join(HOME, 'f1-tmp'), resultFile: path.join(HOME, 'f1.json') });
  const { code } = st.mint();
  await st.route('begin', { url: new URL(`http://x/?code=${code}`) }).catch(() => {});
  assert.deepEqual(bridge.holders(), ['selftest']);
  await bridge.engage({ browserApp: 'brave' }); // an armed call is answered meanwhile
  await sleep(300); // the self-test times out
  assert.deepEqual(bridge.holders(), ['call']);
  assert.equal(released, 0, 'the call keeps the route');
  await bridge.release();
  assert.equal(released, 1, 'the call ending releases it');
  await st.close();
});

test('F3-SAFE-F1: every self-test step is refused while a call is in progress', async () => {
  const fakeMgr = { call: { id: 'x' }, state: 'in_call', selfTest: () => ({ route: async () => ({ ok: true }) }) };
  const d = await daemon({ broker: new PermissionBroker({ config: { permissions: { mode: 'ask' } }, hub: new Hub(), audit: () => {} }), extra: { callsFactory: () => fakeMgr, callsRestoreOnStart: false } });
  try {
    const { SELF_TEST_ROUTES } = require('../src/calls/audio-bridge');
    assert.ok(SELF_TEST_ROUTES.length >= 5);
    for (const r of SELF_TEST_ROUTES) {
      const res = await fetch(`${d.base}${r.path}?test=${'a'.repeat(32)}&code=${'b'.repeat(32)}`, { method: r.method, headers: r.raw ? { 'Content-Type': 'audio/wav' } : r.method === 'POST' ? { 'Content-Type': 'application/json' } : {}, body: r.method === 'POST' ? (r.raw ? Buffer.from('RIFF') : '{}') : undefined });
      assert.equal(res.status, 409, `${r.step} during a call`);
    }
  } finally {
    await d.close();
  }
});

// ------------------------------------------------------------------------------ F3-SAFE-A2, live leftover

function consentedProfile(root) {
  const dir = profile.ensurePrivateDir(profile.profileDir('default', { root }));
  const ref = path.join(dir, 'reference.wav');
  profile.writeFileSecure(ref, quality.writeWav(new Float32Array(24000 * 3).fill(0.01), 24000));
  profile.writeManifest('default', { createdAt: 'x', ownerName: 'Deepanshu Patel', engine: 'pocket', consent: { verified: true, verifiedAt: 'x' }, reference: { file: 'reference.wav', sha256: profile.sha256File(ref) } }, { root });
  return dir;
}

function cloneFixture({ says } = {}) {
  const root = path.join(fs.mkdtempSync(path.join(HOME, 'clone-')), 'clone');
  consentedProfile(root);
  const rendered = new Map();
  const sc = new (class extends EventEmitter {
    constructor() {
      super();
      this.running = true;
      this.renders = 0;
    }
    childPath(p) {
      return p;
    }
    async request(op, p) {
      if (op === 'tts.synthesize') {
        this.renders += 1;
        fs.writeFileSync(p.out, 'RIFF....WAVE cloned voice');
        rendered.set(p.out, says ? says(p.text, this.renders) : p.text);
      }
      if (op === 'asr.transcribe') return { text: rendered.get(p.wav) || '' };
      return { loadMs: 1 };
    }
    async stop() {
      this.running = false;
    }
  })();
  const tmpDir = path.join(path.dirname(root), 'tmp');
  const svc = new CloneService({
    config: { voice: { clone: { enabled: true } }, calls: { ownerName: 'Deepanshu Patel', ownerPronoun: 'his' } },
    root,
    tmpDir,
    saveConfig: () => null,
    sidecarFactory: async () => sc,
    installer: { status: async () => ({ installed: true, engines: { pocket: true } }) },
    lookupJira: false,
    lookupOs: false,
    idleMs: 0,
    log: QUIET,
  });
  svc.models = () => ({ ttsLoadParams: () => ({}), asrLoadParams: () => ({}), spkLoadParams: () => ({}) });
  return { svc, sc, root, tmpDir };
}

test('F3-SAFE-A2: nothing in the cloned voice survives delete: live renders, earlier runs\' leftovers; calls discard their renders', async () => {
  const { svc, tmpDir } = cloneFixture();
  const r = await svc.synthesize("Hi, this is Deepanshu's AI assistant, speaking in his voice.", { useCache: false });
  assert.ok(fs.existsSync(r.file));
  // A render an earlier daemon run left behind.
  fs.writeFileSync(path.join(tmpDir, 'clone-say-0123456789abcdef01234567.wav'), 'RIFF');
  fs.writeFileSync(path.join(tmpDir, 'call-piper-abc.wav'), 'RIFF'); // not the cloned voice: kept
  await svc.delete();
  assert.deepEqual(fs.readdirSync(tmpDir).filter((n) => /^clone-/.test(n)), []);
  assert.ok(fs.existsSync(path.join(tmpDir, 'call-piper-abc.wav')));
  // The daemon start removes old leftovers, not fresh renders of another run.
  const old = path.join(tmpDir, 'clone-test-old.wav');
  const fresh = path.join(tmpDir, 'clone-test-new.wav');
  fs.writeFileSync(old, 'RIFF');
  fs.writeFileSync(fresh, 'RIFF');
  const past = (Date.now() - 120000) / 1000;
  fs.utimesSync(old, past, past);
  assert.deepEqual(cleanupCloneRenders(tmpDir, { olderThanMs: 60000 }), [old]);
  assert.ok(fs.existsSync(fresh));
  // VoiceChain.render (the arm-time greeting check) discards the clone render with cleanup().
  const b = cloneFixture();
  const chain = new VoiceChain({ clone: { speak: async () => {}, synthesize: (t) => b.svc.synthesize(t, { useCache: false }), discardRender: (f) => b.svc.discardRender(f) }, request: async () => ({}), cloned: true, tmpDir: path.join(HOME, 'a2-chain') });
  const g = await chain.render('Hi, this is a test.');
  assert.ok(fs.existsSync(g.file));
  chain.cleanup();
  assert.equal(fs.existsSync(g.file), false);
});

test('live leftover: the cached greeting is checked by local speech recognition and rendered again when the disclosure is garbled', async () => {
  // The first render's end is unintelligible; the second is fine.
  const a = cloneFixture({ says: (text, n) => (/AI assistant/.test(text) && /transcribing/.test(text) && n <= 1 ? 'Hi, this is Deepanshu A.S. system, speaking in his voice. Mumble mumble.' : text) });
  const texts = a.svc.phraseTexts();
  const g = texts.find((t) => /transcribing this call/.test(t));
  assert.ok(g, 'the greeting is in the phrase cache');
  await a.svc.prerenderPhrases({ engine: 'pocket' });
  assert.ok(fs.existsSync(profile.phrasePath('pocket', g, { root: a.root })), 'cached after a good render');
  // Never intelligible: not cached (calls render it live).
  const b = cloneFixture({ says: (text) => (/transcribing/.test(text) ? 'Hi, this is something garbled.' : text) });
  const gb = b.svc.phraseTexts().find((t) => /transcribing this call/.test(t));
  const before = b.sc.renders;
  await b.svc.prerenderPhrases({ engine: 'pocket' });
  assert.equal(fs.existsSync(profile.phrasePath('pocket', gb, { root: b.root })), false);
  assert.equal(b.sc.renders - before, b.svc.phraseTexts().length - 1 + 3, 'three tries for the greeting, one for each other phrase');
  assert.ok(fs.existsSync(profile.phrasePath('pocket', 'Got it.', { root: b.root })), 'the fillers are cached as before');
});
