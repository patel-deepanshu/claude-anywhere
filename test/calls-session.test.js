'use strict';

/**
 * The AI-answered call (docs/CALLS-DESIGN.md §6, §7, §10.2–§10.4): the conversation loop (greeting first,
 * disclosure gate, priming, clause streaming, fillers, the 40-word limit, barge-in trimming and
 * backchannels, silence, call_end, engine restart), the voice chain, the call engine's arguments, the
 * CallManager (click-only critical arming, quiet hours, answering, tools, wrap-up), the /api/calls routes,
 * the MCP tool sets per role, and one end-to-end call: a real DaemonServer, the real MCP server in the call
 * role, the fake call engine (test/fixtures/fake-call-claude.js) and a fake Jira HTTP server.
 * No network beyond 127.0.0.1, no audio hardware.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-calls-session-'));
process.env.ANYWHERE_HOME = HOME;

const sessionMod = require('../src/calls/session');
const { CallSession, ClauseSplitter, VoiceChain } = sessionMod;
const { CallManager } = require('../src/calls/manager');
const policy = require('../src/calls/policy');

const FAKE_CALL_CLAUDE = path.join(__dirname, 'fixtures', 'fake-call-claude.js');

// The session's own timers are unref'd (the daemon's server keeps the process alive); here a ref'd
// interval does that until every test has finished.
const keepAlive = setInterval(() => {}, 1000);
test.after(() => {
  clearInterval(keepAlive);
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond, { timeoutMs = 4000, stepMs = 5, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

// ------------------------------------------------------------------------------ fakes

/** The voice sidecar's live audio: a FIFO player with playback.start/end, barge-in and caller speech. */
class FakeSidecar extends EventEmitter {
  constructor({ msPerChar = 1, minMs = 15 } = {}) {
    super();
    this.msPerChar = msPerChar;
    this.minMs = minMs;
    this.requests = [];
    this.queue = [];
    this.current = null;
  }

  async request(op, params = {}) {
    this.requests.push({ op, params });
    if (op === 'tts.say') {
      this.queue.push({ id: params.utteranceId, text: params.text || '', wav: params.wav || null });
      setImmediate(() => this._next());
      return { queued: true, utteranceId: params.utteranceId };
    }
    if (op === 'tts.stop') {
      this._stopAll();
      return { stopped: true };
    }
    return { ok: true };
  }

  said() {
    return this.requests.filter((r) => r.op === 'tts.say').map((r) => r.params.text);
  }

  ops() {
    return this.requests.map((r) => r.op);
  }

  _next() {
    if (this.current || !this.queue.length) return;
    const u = this.queue.shift();
    this.current = u;
    u.startedAt = Date.now();
    u.ms = Math.max(this.minMs, u.text.length * this.msPerChar);
    this.emit('event', { event: 'playback.start', utteranceId: u.id });
    u.timer = setTimeout(() => {
      this.current = null;
      this.emit('event', { event: 'playback.end', utteranceId: u.id, interrupted: false, started: true, playedChars: u.text.length, chars: u.text.length });
      this._next();
    }, u.ms);
  }

  _stopAll(playedChars) {
    const u = this.current;
    if (u) {
      clearTimeout(u.timer);
      this.current = null;
      const frac = Math.min(1, (Date.now() - u.startedAt) / u.ms);
      const played = Number.isFinite(playedChars) ? playedChars : Math.floor(u.text.length * frac);
      this.emit('event', { event: 'playback.end', utteranceId: u.id, interrupted: true, started: true, playedChars: played, chars: u.text.length });
    }
    for (const q of this.queue.splice(0)) this.emit('event', { event: 'playback.end', utteranceId: q.id, interrupted: true, started: false, playedChars: 0, chars: q.text.length });
  }

  /** The caller talks over us (≥ 400 ms): the sidecar stops playback itself. */
  bargeIn({ playedChars } = {}) {
    this.emit('event', { event: 'barge_in', utteranceId: this.current && this.current.id });
    this._stopAll(playedChars);
    this.emit('event', { event: 'vad.start', t: 0 });
  }

  /** One caller utterance: VAD start, end, final transcript. */
  caller(text, { vad = true } = {}) {
    if (vad) this.emit('event', { event: 'vad.start', t: 0 });
    this.emit('event', { event: 'vad.end', t: 0, ms: 600 });
    this.emit('event', { event: 'asr.final', text, t0: 0, t1: 1, ms: 300 });
  }

  playing() {
    return this.current ? this.current.text : null;
  }
}

/** A call engine speaking stream-json: `script(text, api)` decides each turn. */
class FakeEngine extends EventEmitter {
  constructor(script) {
    super();
    this.script = script || defaultScript;
    this.sent = [];
    this.running = true;
    this.interrupts = 0;
    this.cur = null;
    this.stopped = false;
  }

  send(text) {
    if (!this.running) throw Object.assign(new Error('Claude Code is not running'), { code: 'ENGINE_NOT_RUNNING' });
    const t = typeof text === 'string' ? text : text.map((b) => b.text).join('\n');
    this.sent.push(t);
    setImmediate(() => this._run(t));
  }

  async _run(text) {
    const turn = { interrupted: false, ended: false };
    this.cur = turn;
    const emit = (m) => {
      if (this.running) this.emit('message', { parent_tool_use_id: null, ...m });
    };
    const api = {
      turn,
      say: async (words, { delayMs = 0, chunk = 1 } = {}) => {
        const id = `msg_${Math.random().toString(16).slice(2)}`;
        emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
        const parts = words.split(/(?<=\s)/);
        let sent = '';
        for (let i = 0; i < parts.length; i += chunk) {
          if (turn.interrupted) break;
          const piece = parts.slice(i, i + chunk).join('');
          sent += piece;
          emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
          if (delayMs) await sleep(delayMs);
        }
        emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
        emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: sent }] } });
        return sent;
      },
      tool: (name, input) => emit({ type: 'assistant', message: { id: `msg_t${Math.random()}`, content: [{ type: 'tool_use', id: 'toolu_1', name, input }] } }),
      done: (result = '') => {
        if (turn.ended) return;
        turn.ended = true;
        emit({ type: 'result', subtype: turn.interrupted ? 'error_during_execution' : 'success', is_error: false, result });
      },
      sleep: async (ms) => {
        const until = Date.now() + ms;
        while (Date.now() < until && !turn.interrupted) await sleep(5);
      },
    };
    try {
      await this.script(text, api, this);
    } finally {
      api.done('');
      if (this.cur === turn) this.cur = null;
    }
  }

  interrupt() {
    this.interrupts += 1;
    if (this.cur) this.cur.interrupted = true;
    return Promise.resolve({ ok: true, killed: false });
  }

  stop() {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    this.running = false;
    this.emit('exit', { code: 0, expected: true });
    return Promise.resolve();
  }

  crash() {
    this.running = false;
    this.emit('exit', { code: 1 });
  }
}

async function defaultScript(text, api) {
  if (text.includes('[call connected')) return api.done(await api.say('OK'));
  if (text.includes('[The call has ended')) return api.done(await api.say('{"summary": "Ankit asked for a ticket.", "followUps": ["Confirm the review time."], "topics": ["tickets"]}'));
  return api.done(await api.say('Got it. How else can I help?'));
}

function liveVoice(sc, { cloned = true } = {}) {
  return { cloned, say: (text, { utteranceId }) => sc.request('tts.say', { text, utteranceId }), stop: () => sc.request('tts.stop', {}) };
}

const AUDIO = { capture: { backend: 'pulse', device: 'anywhere_call.monitor' }, playback: { backend: 'pulse', device: 'anywhere_tts' }, halfDuplex: false };
const QUICK = { fillerAfterMs: 5000, stillThereMs: 60000, silenceHangupMs: 120000, bargeSettleMs: 120, conjunctionWaitMs: 150, goodbyeTimeoutMs: 2000, primeTimeoutMs: 3000, summaryTimeoutMs: 2000 };

function setup({ script, cloned = true, options = {}, calls = {}, sidecar } = {}) {
  const sc = sidecar || new FakeSidecar();
  const engine = new FakeEngine(script);
  const engines = [engine];
  const hangups = [];
  const s = new CallSession({
    id: 'c0ffee00-0000-4000-8000-000000000001',
    caller: 'Ankit Sharma',
    app: 'zoho-cliq',
    appName: 'Zoho Cliq',
    config: { calls: { maxCallMinutes: 15, ...calls } },
    sidecar: sc,
    voice: liveVoice(sc, { cloned }),
    engine,
    engineFactory: async () => {
      const e = new FakeEngine(script);
      engines.push(e);
      return e;
    },
    hangUpCall: async (reason) => {
      hangups.push(reason);
    },
    audioParams: AUDIO,
    ownerName: 'Deepanshu Patel',
    pronoun: 'his',
    options: { ...QUICK, ...options },
  });
  return { sc, engine, engines, s, hangups };
}

const GREETING = "Hi Ankit, this is Deepanshu's AI assistant, speaking in his voice. I'm transcribing this call to take notes for him. How can I help?";

// ------------------------------------------------------------------------------ clause splitting

test('clauses: split at . ! ?, at , ; : after 4 words, and after 12 words', () => {
  const sp = new ClauseSplitter();
  const out = [];
  for (const piece of ['Sure', ', let', ' me check', ' the board. I', "'ve assigned you PAY-412", ', the card-capture retry bug', '. Version 1.5 is', ' out']) out.push(...sp.push(piece));
  assert.deepEqual(out, ['Sure, let me check the board.', "I've assigned you PAY-412,", 'the card-capture retry bug.']);
  assert.equal(sp.flush(), 'Version 1.5 is out');
  const long = new ClauseSplitter();
  const got = long.push('one two three four five six seven eight nine ten eleven twelve thirteen fourteen ');
  assert.deepEqual(got, ['one two three four five six seven eight nine ten eleven twelve']);
  assert.equal(long.flush(), 'thirteen fourteen');
  const short = new ClauseSplitter();
  assert.deepEqual(short.push('Hi, Ankit; yes: '), [], 'a comma before 4 words does not split');
  assert.deepEqual(short.push('this is fine. '), ['Hi, Ankit; yes: this is fine.']);
});

// ------------------------------------------------------------------------------ voices

test('voice chain: cached clone phrase, then live clone, then Piper, then the OS voice', async () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'voice-'));
  const cached = path.join(dir, 'sure.wav');
  fs.writeFileSync(cached, 'RIFF');
  const requests = [];
  const request = async (op, params) => {
    requests.push({ op, params });
    return { queued: true };
  };
  const spoke = [];
  let cloneFails = false;
  const clone = {
    root: dir,
    cloneConfig: () => ({ engine: 'pocket' }),
    speak: async (text, { utteranceId }) => {
      if (cloneFails) throw Object.assign(new Error('PROFILE_INVALID'), { code: 'PROFILE_INVALID' });
      spoke.push([text, utteranceId]);
      return { queued: true };
    },
  };
  let piperFails = false;
  const piper = {
    synthesize: async (text, { outFile }) => {
      if (piperFails) throw Object.assign(new Error('Piper is not installed'), { code: 'PIPER_NOT_INSTALLED' });
      fs.writeFileSync(outFile, 'piper');
      return { path: outFile };
    },
  };
  const osRender = async (text, out) => fs.writeFileSync(out, 'os');
  const v = new VoiceChain({ clone, request, piper, osRender, tmpDir: dir, cloned: true, phrasePath: (eng, text) => (text === 'Sure.' ? cached : path.join(dir, 'missing.wav')) });
  assert.equal(v.cloned, true);
  assert.deepEqual(await v.say('sure', { utteranceId: 'u1' }), { engine: 'clone', cached: true });
  assert.deepEqual(requests[0], { op: 'tts.say', params: { text: 'sure', utteranceId: 'u1', wav: cached } });
  assert.deepEqual(await v.say('Let me look.', { utteranceId: 'u2' }), { engine: 'clone', cached: false });
  assert.deepEqual(spoke, [['Let me look.', 'u2']]);
  cloneFails = true;
  assert.deepEqual(await v.say('Piper now.', { utteranceId: 'u3' }), { engine: 'piper' });
  assert.equal(v.cloned, false, 'a failed clone is not used again in this call');
  assert.match(requests[1].params.wav, /call-piper-/);
  piperFails = true;
  assert.deepEqual(await v.say('OS now.', { utteranceId: 'u4' }), { engine: 'os' });
  const none = new VoiceChain({ request, cloned: false });
  await assert.rejects(none.say('x', { utteranceId: 'u5' }), { code: 'NO_VOICE' });
  // A dead sidecar is not hidden behind a fallback.
  const dead = new VoiceChain({ clone: { ...clone, speak: async () => Promise.reject(Object.assign(new Error('gone'), { code: 'SIDECAR_EXITED' })) }, request, piper, cloned: true });
  await assert.rejects(dead.say('x', { utteranceId: 'u6' }), { code: 'SIDECAR_EXITED' });
  v.cleanup();
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('call-')).length, 0, 'temporary renders are removed');
});

// ------------------------------------------------------------------------------ the call engine

test('call engine: no built-in tools, only our MCP server, the replaced prompt, call tools allowed, everything else denied', () => {
  const args = sessionMod.callEngineArgs({ model: 'haiku', mcpConfigPath: '/x/mcp.json', systemPromptPath: '/x/prompt.txt' });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--tools'), '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(at('--mcp-config'), '/x/mcp.json');
  assert.equal(at('--system-prompt-file'), '/x/prompt.txt');
  assert.ok(!args.includes('--append-system-prompt-file'));
  assert.equal(at('--permission-prompt-tool'), 'mcp__anywhere__call_permission');
  assert.equal(at('--model'), 'haiku');
  assert.equal(at('--setting-sources'), '');
  assert.ok(args.includes('--no-session-persistence'));
  const allowed = at('--allowedTools').split(',');
  assert.deepEqual(allowed, policy.DAEMON_TOOLS.map((n) => `mcp__anywhere__${n}`));
  assert.ok(!allowed.includes('mcp__anywhere__call_permission'));
  assert.ok(allowed.every((t) => /^mcp__anywhere__call_/.test(t)));

  const dir = path.join(HOME, 'calls', 'run-files');
  const files = sessionMod.writeCallRunFiles({ dir, callId: 'abc', daemonUrl: 'http://127.0.0.1:1', token: 'tok', prompt: 'PROMPT' });
  const mcp = JSON.parse(fs.readFileSync(files.mcpConfigPath, 'utf8')).mcpServers.anywhere;
  assert.equal(mcp.env.ANYWHERE_ROLE, 'call');
  assert.equal(mcp.env.ANYWHERE_CALL_ID, 'abc');
  assert.match(mcp.args[0], /src[\\/]mcp[\\/]server\.js$/);
  assert.equal(fs.readFileSync(files.systemPromptPath, 'utf8'), 'PROMPT\n');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(files.mcpConfigPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  class StubEngine extends EventEmitter {
    constructor(o) {
      super();
      this.o = o;
      this.args = ['--append-system-prompt-file', 'x'];
    }
  }
  const e = sessionMod.createCallEngine({ Engine: StubEngine, claudePath: '/bin/claude', cwd: dir, mcpConfigPath: files.mcpConfigPath, systemPromptPath: files.systemPromptPath });
  assert.deepEqual(e.args, sessionMod.callEngineArgs({ mcpConfigPath: files.mcpConfigPath, systemPromptPath: files.systemPromptPath }));
  assert.equal(e.o.env.ANYWHERE_ROLE, null, 'the role of the daemon is not inherited');
});

// ------------------------------------------------------------------------------ CallSession

test('session: the greeting with the disclosure comes first; the reply waits until it has been heard', async () => {
  const { sc, engine, s } = setup();
  sc.msPerChar = 2;
  const states = [];
  s.on('state', (e) => states.push(e.state));
  await s.start();
  assert.deepEqual(sc.ops().slice(0, 2), ['audio.start', 'tts.say']);
  assert.deepEqual(sc.requests[0].params, AUDIO);
  assert.equal(sc.said()[0], GREETING);
  await waitFor(() => engine.sent.length >= 1, { what: 'priming' });
  assert.equal(engine.sent[0], '[call connected: caller "Ankit Sharma" on Zoho Cliq; the greeting was spoken; reply exactly OK]');
  // The caller talks while the greeting still plays: the reply is held back.
  await sleep(20);
  sc.caller('Hello, can you hear me?');
  await waitFor(() => engine.sent.length >= 2, { what: 'caller turn' });
  assert.equal(engine.sent[1], 'Caller (speech recognition, may contain errors): Hello, can you hear me?');
  await sleep(30);
  assert.equal(sc.playing(), GREETING);
  assert.deepEqual(sc.said(), [GREETING], 'no LLM speech before the disclosure was heard');
  await waitFor(() => sc.said().length >= 3, { what: 'reply' });
  assert.deepEqual(sc.said(), [GREETING, 'Got it.', 'How else can I help?']);
  assert.equal(s.disclosureSpoken, true);
  await waitFor(() => !s.speaking());
  const roles = s.transcript().map((t) => `${t.role}: ${t.text}`);
  assert.deepEqual(roles, [`caller: Hello, can you hear me?`, `assistant: ${GREETING}`, 'assistant: Got it.', 'assistant: How else can I help?']);
  assert.deepEqual(states.slice(0, 3), ['starting', 'greeting', 'active']);
  await s.takeover();
});

test('session: a barge-in that cuts the disclosure → a re-disclosure before any reply', async () => {
  const { sc, engine, s } = setup();
  sc.msPerChar = 3;
  await s.start();
  await waitFor(() => sc.playing() === GREETING);
  sc.bargeIn({ playedChars: 20 });
  sc.caller('Wait, who is this exactly?');
  await waitFor(() => engine.sent.some((t) => t.includes('who is this')), { what: 'caller turn' });
  await waitFor(() => sc.said().length >= 4, { what: 'speech' });
  const said = sc.said();
  assert.equal(said[0], GREETING);
  assert.match(said[1], /^Sorry, just so you know: This is Deepanshu's AI assistant, speaking in his voice\. I'm transcribing this call to take notes for him\.$/);
  assert.deepEqual(said.slice(2), ['Got it.', 'How else can I help?']);
  const first = s.transcript().find((t) => t.role === 'assistant');
  assert.equal(first.interrupted, true);
  assert.equal(first.text, `${GREETING.slice(0, 20).trim()}…`);
  await waitFor(() => s.disclosureSpoken);
  await s.takeover();
});

test('session: a backchannel ("hello") during the greeting resumes it from the disclosure, without an LLM turn', async () => {
  const { sc, engine, s } = setup();
  sc.msPerChar = 3;
  await s.start();
  await waitFor(() => engine.sent.length === 1 && sc.playing() === GREETING);
  sc.bargeIn({ playedChars: 5 });
  sc.caller('Hello?');
  await waitFor(() => sc.said().length >= 2, { what: 'resumed greeting' });
  assert.equal(sc.said()[1], "This is Deepanshu's AI assistant, speaking in his voice. I'm transcribing this call to take notes for him. How can I help?");
  await waitFor(() => s.disclosureSpoken, { what: 'disclosure' });
  await sleep(50);
  assert.equal(engine.sent.length, 1, 'a backchannel is not a turn');
  await s.takeover();
});

async function longScript(text, api) {
  if (text.includes('[call connected')) return api.done(await api.say('OK'));
  if (text.includes('long answer')) {
    const words = [];
    for (let i = 1; i <= 60; i += 1) words.push(i % 6 === 0 ? `word${i}.` : `word${i}`);
    return api.done(await api.say(words.join(' '), { delayMs: 3 }));
  }
  return defaultScript(text, api);
}

test('session: a real barge-in trims the reply, marks it interrupted, stops the engine and tells it what was heard', async () => {
  const { sc, engine, s } = setup({ script: longScript });
  sc.msPerChar = 4;
  await s.start();
  await waitFor(() => s.disclosureSpoken, { timeoutMs: 6000, what: 'greeting' });
  sc.caller('Give me the long answer please');
  await waitFor(() => sc.playing() && sc.playing().startsWith('word1'), { what: 'reply playing' });
  const cut = sc.playing();
  sc.bargeIn({ playedChars: 11 });
  sc.caller('Stop, I only need PAY-412 instead');
  await waitFor(() => engine.sent.some((t) => t.includes('PAY-412 instead')), { what: 'next turn' });
  const next = engine.sent.find((t) => t.includes('PAY-412 instead'));
  assert.match(next, new RegExp(`^\\[The caller interrupted you; they only heard: "${cut.slice(0, 11).trim()}"\\]`));
  assert.ok(engine.interrupts >= 1, 'the engine was interrupted');
  const trimmed = s.transcript().find((t) => t.role === 'assistant' && t.interrupted);
  assert.equal(trimmed.text, `${cut.slice(0, 11).trim()}…`);
  await waitFor(() => sc.said().includes('How else can I help?'), { what: 'answer to the interruption' });
  await sleep(40);
  const after = sc.said().slice(sc.said().indexOf(cut) + 1);
  assert.ok(!after.some((t) => /^word/.test(t)), `the rest of the cut reply is dropped: ${JSON.stringify(after)}`);
  await s.takeover();
});

test('session: a reply stops at 40 spoken words, on a clause boundary', async () => {
  const { sc, s } = setup({ script: longScript });
  sc.msPerChar = 0;
  await s.start();
  await waitFor(() => s.disclosureSpoken, { what: 'greeting' });
  sc.caller('Give me the long answer please');
  await waitFor(() => sc.said().some((t) => /word42/.test(t)), { what: 'reply' });
  await sleep(60);
  const reply = sc.said().slice(1);
  // Sentences of 6 words: 36 words, then a sentence that ends within the grace (42), then nothing.
  assert.equal(policy.countWords(reply.join(' ')), 42);
  assert.equal(reply[reply.length - 1], 'word37 word38 word39 word40 word41 word42.');
  await s.takeover();

  const ramble = async (text, api) => {
    if (text.includes('[call connected')) return api.done(await api.say('OK'));
    const words = Array.from({ length: 60 }, (_, i) => `w${i + 1}`);
    words[34] += '.';
    return api.done(await api.say(words.join(' ')));
  };
  const r = setup({ script: ramble });
  r.sc.msPerChar = 0;
  await r.s.start();
  await waitFor(() => r.s.disclosureSpoken);
  r.sc.caller('Tell me everything');
  await waitFor(() => r.sc.said().some((t) => /w35\./.test(t)), { what: 'ramble' });
  await sleep(60);
  const said = r.sc.said().slice(1);
  assert.ok(policy.countWords(said.join(' ')) <= 40, said.join(' | '));
  assert.ok(!said.some((t) => /w4[0-9]/.test(t)), 'a clause that would pass the limit mid-sentence is dropped, not cut');
  await r.s.takeover();
});

test('session: a cached filler once per turn when the reply is slow; conjunctions wait for the rest', async () => {
  const slow = async (text, api) => {
    if (text.includes('[call connected')) return api.done(await api.say('OK'));
    if (text.includes('slow')) {
      await api.sleep(250);
      return api.done(await api.say('Here is the slow answer.'));
    }
    return defaultScript(text, api);
  };
  const { sc, engine, s } = setup({ script: slow, options: { fillerAfterMs: 60, conjunctionWaitMs: 200 } });
  sc.msPerChar = 0;
  await s.start();
  await waitFor(() => s.disclosureSpoken);
  sc.caller('A slow one please');
  await waitFor(() => sc.said().includes('Here is the slow answer.'), { what: 'slow answer' });
  const said = sc.said();
  assert.deepEqual(said.slice(1), ['Okay, one moment.', 'Here is the slow answer.']);
  // "I need a ticket and" waits for the continuation.
  sc.caller('I need a ticket and');
  await sleep(60);
  sc.caller('it should be for payments');
  await waitFor(() => engine.sent.some((t) => t.includes('payments')), { what: 'merged turn' });
  assert.ok(engine.sent.some((t) => t.endsWith('Caller (speech recognition, may contain errors): I need a ticket and it should be for payments')), engine.sent.join(' | '));
  await s.takeover();
});

test('session: an objection to the transcription stops saving it, and the assistant says so', async () => {
  const { sc, engine, s } = setup();
  sc.msPerChar = 0;
  await s.start();
  await waitFor(() => s.disclosureSpoken);
  sc.caller("Please don't record or transcribe this call");
  await waitFor(() => engine.sent.length >= 2);
  assert.equal(s.saveTranscript, false);
  assert.deepEqual(s.transcript(), []);
  assert.ok(sc.said().includes("Okay, I've stopped the transcript. I'll only keep a note of what I do for you."));
  assert.match(engine.sent[1], /\[The caller asked not to be transcribed/);
  sc.caller('My secret plan is fine');
  await sleep(50);
  assert.deepEqual(s.transcript(), [], 'later speech is not saved either');
  s.recordAction({ name: 'call_note', summary: 'Note: x' });
  assert.equal(s.actions().length, 1, 'actions are still logged');
  await s.takeover();
});

test('session: silence → "Are you still there?" → goodbye and hang-up', async () => {
  const { sc, s, hangups } = setup({ options: { stillThereMs: 120, silenceHangupMs: 400, tickMs: 20 } });
  sc.msPerChar = 0;
  const ended = new Promise((r) => s.once('ended', r));
  await s.start();
  const e = await ended;
  assert.equal(e.reason, 'silence');
  assert.deepEqual(hangups, ['silence']);
  const said = sc.said();
  assert.ok(said.includes('Are you still there?'));
  assert.equal(said[said.length - 1], "I'll let you go now. Thanks for calling. Bye!");
  assert.ok(sc.ops().includes('audio.stop'));
});

test('session: call_end hangs up after the reply, without a second goodbye; max duration ends the call', async () => {
  const bye = async (text, api, engine) => {
    if (text.includes('[call connected')) return api.done(await api.say('OK'));
    if (/\bbye\b/i.test(text)) {
      await api.say('Thanks for calling, bye!');
      api.tool('mcp__anywhere__call_end', { reason: 'done' });
      engine.onEnd();
      // Models sometimes repeat the goodbye after the tool result: it is not said twice.
      await api.say('Thanks for calling, bye!');
      return api.done('');
    }
    return defaultScript(text, api);
  };
  const { sc, engine, s, hangups } = setup({ script: bye });
  engine.onEnd = () => s.requestEnd('assistant_ended');
  sc.msPerChar = 1;
  const ended = new Promise((r) => s.once('ended', r));
  await s.start();
  await waitFor(() => s.disclosureSpoken);
  sc.caller("That's all, bye");
  const e = await ended;
  assert.equal(e.reason, 'assistant_ended');
  assert.deepEqual(hangups, ['assistant_ended']);
  assert.deepEqual(sc.said().slice(1), ['Thanks for calling, bye!'], 'no extra goodbye');

  const timed = setup({ calls: { maxCallMinutes: 0.005 }, options: { tickMs: 20 } });
  timed.sc.msPerChar = 0;
  const end2 = new Promise((r) => timed.s.once('ended', r));
  await timed.s.start();
  assert.equal((await end2).reason, 'max_duration');
  assert.match(timed.sc.said().pop(), /I need to end the call now\. Deepanshu will follow up\. Bye!/);
});

test('session: Take over stops at once (no goodbye, no hang-up click); summary from the engine, else the transcript', async () => {
  const { sc, s, hangups } = setup();
  sc.msPerChar = 0;
  await s.start();
  await waitFor(() => s.disclosureSpoken);
  sc.caller('Can you assign me something?');
  await waitFor(() => sc.said().length >= 3);
  await s.takeover();
  assert.equal(s.state, 'ended');
  assert.equal(s.endReason, 'takeover');
  assert.deepEqual(hangups, []);
  assert.ok(sc.ops().includes('tts.stop') && sc.ops().includes('audio.stop'));
  const sum = await s.summarize();
  assert.deepEqual(sum, { summary: 'Ankit asked for a ticket.', followUps: ['Confirm the review time.'], topics: ['tickets'], source: 'engine' });
  await s.close();
  const fb = await s.summarize();
  assert.equal(fb.source, 'transcript');
  assert.match(fb.summary, /Ankit Sharma said: "Can you assign me something\?"/);
});

test('session: the engine is restarted once with a recap; a second crash ends the call with an apology', async () => {
  const { sc, engines, s, hangups } = setup();
  sc.msPerChar = 0;
  const ended = new Promise((r) => s.once('ended', r));
  await s.start();
  await waitFor(() => s.disclosureSpoken);
  sc.caller('Hi there');
  await waitFor(() => sc.said().includes('How else can I help?'));
  engines[0].crash();
  await waitFor(() => engines.length === 2 && engines[1].sent.length >= 1, { what: 'restart' });
  assert.match(engines[1].sent[0], /^\[call connected: caller "Ankit Sharma" on Zoho Cliq;[^\n]*\n\[You were restarted mid-call\. The conversation so far: .*Caller: Hi there/);
  sc.caller('Are you back?');
  await waitFor(() => engines[1].sent.some((t) => t.includes('Are you back')));
  engines[1].crash();
  const e = await ended;
  assert.equal(e.reason, 'engine_failed');
  assert.deepEqual(hangups, ['engine_failed']);
  assert.match(sc.said().pop(), /^Sorry, I'm having trouble on my end\. Deepanshu will get back to you\. Bye!$/);
});

test('session: when nothing can be spoken the call is hung up instead of looping', async () => {
  const { sc, s, hangups } = setup();
  let tries = 0;
  s.voice = {
    cloned: true,
    say: async () => {
      tries += 1;
      throw Object.assign(new Error('No playback device'), { code: 'AUDIO_BACKEND' });
    },
    stop: async () => {},
  };
  const ended = new Promise((r) => s.once('ended', r));
  await s.start();
  sc.caller('Hello?');
  assert.equal((await ended).reason, 'audio_failed');
  assert.deepEqual(hangups, ['audio_failed'], 'the call is still ended in the app');
  assert.equal(tries, 3);
});

test('session: a sidecar crash restarts the call audio once; without a restart the call ends', async () => {
  const sc = new FakeSidecar({ msPerChar: 0 });
  const sc2 = new FakeSidecar({ msPerChar: 0 });
  const { s } = setup({ sidecar: sc });
  // Like CloneService.request, the voice always talks to the current sidecar.
  let current = sc;
  s.voice = { cloned: true, say: (text, { utteranceId }) => current.request('tts.say', { text, utteranceId }), stop: () => current.request('tts.stop', {}) };
  let restarts = 0;
  s.restartAudio = async () => {
    restarts += 1;
    current = sc2;
    return sc2;
  };
  await s.start();
  await waitFor(() => s.disclosureSpoken);
  sc.emit('exit', { code: 1 });
  await waitFor(() => sc2.ops().includes('audio.start'), { what: 'audio restarted' });
  assert.equal(restarts, 1);
  sc2.caller('Still there?');
  await waitFor(() => sc2.said().includes('How else can I help?'), { what: 'speech on the new sidecar' });
  const ended = new Promise((r) => s.once('ended', r));
  sc2.emit('exit', { code: 1 });
  assert.equal((await ended).reason, 'audio_failed');
});

// ------------------------------------------------------------------------------ CallManager

const { PermissionBroker } = require('../src/daemon/permissions');

const ANKIT = { displayName: 'Ankit Sharma', email: 'ankit.sharma@example.com', accountId: '5b10ac8d82e05b22cc7d4ef5', active: true };
const RING = { app: 'zoho-cliq', kind: 'ringing', caller: 'Ankit Sharma', windowId: '0x10', source: 'title', confidence: 0.9, browser: 'brave' };

function fakeHub() {
  const events = [];
  return {
    events,
    broadcast(type, data) {
      events.push({ type, data });
    },
    on() {},
    removeListener() {},
  };
}

function fakeClone(sc, { installed = true, profileOk = true, enabled = true, synthFails = false } = {}) {
  return {
    held: 0,
    runtimeStatus: async () => ({ installed }),
    async holdSidecar() {
      this.held += 1;
      return sc;
    },
    releaseSidecar() {
      this.held -= 1;
    },
    getSidecar: async () => sc,
    request: (op, p, o) => sc.request(op, p, o),
    models: () => ({ vadLoadParams: () => ({ model: 'silero.onnx' }), asrLoadParams: () => ({ model: 'moonshine' }) }),
    modelsDir: () => HOME,
    sttModel: () => 'moonshine',
    _ensureAsr: async () => {},
    _ensureVoice: async () => {},
    profileStatus: () => ({ ok: profileOk, exists: profileOk, ownerName: 'Deepanshu Patel' }),
    cloneConfig: () => ({ enabled, engine: 'pocket' }),
    speak: (text, { utteranceId }) => sc.request('tts.say', { text, utteranceId }),
    synthesize: async () => {
      if (synthFails) throw new Error('no voice');
      return { file: path.join(HOME, 'greeting.wav'), cached: true };
    },
    prerenderPhrases: async () => ({}),
    transcribe: async () => '',
  };
}

class FakeDetector extends EventEmitter {
  constructor() {
    super();
    this.state = 'stopped';
    this.calls = [];
    this.learned = [];
    this.nextWait = { ok: true, ring: RING };
  }

  start() {
    this.state = 'watching';
    this.calls.push('start');
    return {};
  }

  stop() {
    this.state = 'stopped';
    this.calls.push('stop');
  }

  status() {
    return { state: this.state };
  }

  waitToAnswer(o) {
    this.calls.push(['wait', o.seconds]);
    const w = this.nextWait;
    return Promise.resolve(typeof w === 'function' ? w(o) : w);
  }

  beginAnswer() {
    this.calls.push('beginAnswer');
  }

  answerFailed() {
    this.calls.push('answerFailed');
  }

  callStarted(info) {
    this.calls.push(['callStarted', info]);
    this.state = 'in_call';
  }

  callEnded() {
    this.calls.push('callEnded');
    this.state = 'watching';
  }

  currentRing() {
    return null;
  }

  ring(candidate = RING) {
    this.emit('ringing', { candidate, since: Date.now() });
  }
}

function fakeBridge() {
  const calls = [];
  return {
    calls,
    check: async () => {
      calls.push('check');
      return { mode: 'virtual', ready: true, issues: [] };
    },
    engage: async (o) => {
      calls.push(['engage', o]);
      return { ok: true, startParams: AUDIO };
    },
    release: async () => {
      calls.push('release');
      return { ok: true };
    },
    teardown: async () => {
      calls.push('teardown');
      return { ok: true };
    },
    setup: async () => ({ ok: true }),
  };
}

function fakeJira() {
  const reqs = [];
  const issues = {
    'PAY-412': { key: 'PAY-412', summary: 'Fix retry on failed card capture', status: { name: 'To Do', categoryKey: 'new' }, type: 'Bug', priority: 'High', assignee: null },
    'PAY-500': { key: 'PAY-500', summary: 'Taken', status: { name: 'In Progress', categoryKey: 'indeterminate' }, type: 'Task', priority: 'Low', assignee: { displayName: 'Priya' } },
  };
  return {
    reqs,
    issues,
    baseUrl: 'https://acme.atlassian.net',
    async myIssues() {
      reqs.push(['myIssues']);
      return { issues: [{ key: 'PAY-1' }, { key: 'OPS-7' }, { key: 'PAY-2' }] };
    },
    async search(jql, max) {
      reqs.push(['search', jql, max]);
      const m = /key = "([^"]+)"/.exec(jql);
      if (m) return { issues: issues[m[1]] ? [issues[m[1]]] : [] };
      return { issues: [issues['PAY-412'], issues['PAY-500']] };
    },
    async findUser(q) {
      reqs.push(['findUser', q]);
      return [ANKIT];
    },
    async assignable() {
      return [ANKIT];
    },
    async assign(key, who) {
      reqs.push(['assign', key, who]);
      issues[key].assignee = { displayName: 'Ankit Sharma' };
      return { key };
    },
    async comment(key, text) {
      reqs.push(['comment', key, text]);
      return { key, url: `https://acme.atlassian.net/browse/${key}` };
    },
  };
}

/** A call engine whose turns use the manager's tools directly (what the MCP server does over HTTP). */
function toolScript(getMgr, callIdRef) {
  return async (text, api) => {
    const mgr = getMgr();
    const tool = (name, args) => mgr.tool(callIdRef.id, name, args);
    if (text.includes('[call connected')) return api.done(await api.say('OK'));
    if (text.includes('[The call has ended')) return api.done(await api.say('{"summary": "Ankit asked for a sprint ticket and got PAY-412.", "followUps": [], "topics": ["tickets"]}'));
    if (/assign me a ticket/i.test(text)) {
      await api.say('Sure, let me check the board.');
      const found = await tool('call_find_unassigned_tickets', {});
      const key = /\b(PAY-\d+)\b/.exec(found.text)[1];
      const a = await tool('call_assign_ticket_to_caller', { key });
      const url = /(https:\/\/\S+\/browse\/PAY-\d+)/.exec(a.text)[1];
      await tool('call_send_chat_to_caller', { text: `Hi Ankit, ${key} is assigned to you: ${url} (more: https://evil.example.com/x)` });
      return api.done(await api.say(`I've assigned you ${key}. I'll send you the link on Cliq right after this call.`));
    }
    if (/screenshot/i.test(text)) {
      const r = await tool('screenshot', {});
      api.turn.denied = r;
      await tool('call_defer', { request: 'A screenshot of the screen' });
      return api.done(await api.say("Sorry, I can't do that during calls. Deepanshu will follow up."));
    }
    if (/\bbye\b/i.test(text)) {
      await api.say('Thanks for calling, bye!');
      await tool('call_end', { reason: 'caller is done' });
      return api.done('');
    }
    return defaultScript(text, api);
  };
}

function makeManager(o = {}) {
  const sc = o.sidecar || new FakeSidecar({ msPerChar: 0 });
  const hub = o.hub || fakeHub();
  const broker = o.broker || new PermissionBroker({ config: { permissions: { mode: 'auto' } }, hub, audit: () => {} });
  const clone = o.clone || fakeClone(sc, o.cloneOpts);
  const det = new FakeDetector();
  const bridge = fakeBridge();
  const jira = o.jira === undefined ? fakeJira() : o.jira;
  const engines = [];
  const notesCalls = [];
  const chats = [];
  const answers = [];
  const hangUps = [];
  const audits = [];
  const callIdRef = { id: null };
  let mgr;
  const config = { calls: { ownerPronoun: 'his', apps: ['zoho-cliq', 'google-meet'], answerAfterSec: 0, quietHours: { enabled: false, start: '22:00', end: '08:00' }, maxCallMinutes: 15, ...(o.calls || {}) }, voice: {} };
  mgr = new CallManager({
    config,
    hub,
    permissions: broker,
    clone,
    getDriver: async () => ({ name: 'mock' }),
    getComputer: async () => ({ platform: 'linux' }),
    bridge,
    detector: det,
    vision: { verify: async () => true },
    jira,
    answer: {
      answerCall: async (a) => {
        answers.push(a);
        return o.answerResult || { ok: true, method: 'shortcut', caller: a.candidate.caller, app: a.candidate.app };
      },
      hangUp: async (a) => {
        hangUps.push(a);
        return { ok: true, method: 'shortcut' };
      },
      cameraOff: async () => ({ ok: true }),
    },
    notes: o.notes !== undefined ? o.notes : {
      writeNotes: async (n) => {
        notesCalls.push(n);
        return path.join(HOME, 'Desktop', 'Claude Call Notes', 'note.md');
      },
    },
    cliq: o.cliq !== undefined ? o.cliq : {
      sendChat: async (c) => {
        chats.push(c);
        return { ok: true, via: 'gui', sent: true };
      },
    },
    piper: o.piper || null,
    osRender: o.osRender || (async (text, out) => fs.writeFileSync(out, 'os')),
    engineFactory: o.engineFactory || (async (spec) => {
      callIdRef.id = spec.callId;
      const e = new FakeEngine(o.script || toolScript(() => mgr, callIdRef));
      e.spec = spec;
      engines.push(e);
      return e;
    }),
    audit: (e) => audits.push(e),
    callsDir: path.join(HOME, 'calls-mgr'),
    sessionOptions: { ...QUICK, ...(o.sessionOptions || {}) },
    ...(o.extra || {}),
  });
  return { mgr, sc, hub, broker, clone, det, bridge, jira, engines, notesCalls, chats, answers, hangUps, audits, callIdRef, config };
}

async function armByClick(t, req = {}) {
  const p = t.mgr.requestArm({ minutes: 30, via: 'test', ...req });
  const card = await waitFor(() => t.broker.pending()[0], { what: 'the arm card' });
  t.broker.resolve(card.id, 'allow', undefined, { via: 'click' });
  return { card, res: await p };
}

function hhmmFrom(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

test('manager: arming is a critical card that only a click allows; voice, keys and typed allows do not arm', async () => {
  const t = makeManager();
  const p = t.mgr.requestArm({ minutes: 30, apps: ['cliq'], instructions: 'Assign sprint tickets only.', via: 'mcp' });
  const card = await waitFor(() => t.broker.pending()[0], { what: 'the arm card' });
  assert.equal(card.risk, 'critical');
  assert.equal(card.sessionRule, null, 'no "always" for this card');
  assert.equal(card.toolName, 'mcp__anywhere__calls_arm');
  assert.equal(card.reason, 'Answer phone calls for you with your voice');
  assert.match(card.summary, /^Answer calls for you until \d\d:\d\d \(Zoho Cliq\)\? The assistant says it is an AI and takes notes\. Your instructions: Assign sprint tickets only$/);
  assert.equal(t.mgr.status().arming, true);
  assert.throws(() => t.broker.resolve(card.id, 'allow', undefined, { via: 'voice' }), { code: 'CRITICAL_NEEDS_CLICK' });
  assert.throws(() => t.broker.resolve(card.id, 'allow_session', undefined, { via: 'key' }), { code: 'CRITICAL_NEEDS_CLICK' });
  assert.equal(t.broker.pending().length, 1, 'the card is still waiting');
  t.broker.resolve(card.id, 'allow', undefined, { via: 'typed' });
  const typed = await p;
  assert.equal(typed.ok, false);
  assert.equal(typed.code, 'CLICK_REQUIRED');
  assert.equal(t.mgr.status().armed, false);
  assert.equal(t.det.state, 'stopped');

  const before = Date.now();
  const { res } = await armByClick(t, { apps: ['cliq'] });
  assert.equal(res.ok, true);
  assert.equal(res.armed, true);
  assert.deepEqual(res.apps, ['zoho-cliq']);
  assert.equal(res.minutes, 30);
  const until = Date.parse(res.until);
  assert.ok(until >= before + 30 * 60000 && until <= Date.now() + 30 * 60000);
  assert.equal(res.cloned, true);
  assert.equal(t.det.state, 'watching');
  assert.equal(t.mgr.status().armed, true);
  assert.equal(t.mgr.status().state, 'armed');
  await waitFor(() => t.engines.length === 1, { what: 'prewarmed engine' });
  assert.match(t.engines[0].spec.prompt, /You are Deepanshu Patel's AI phone assistant/);
  assert.equal(t.clone.held, 1, 'the sidecar stays loaded while armed');
  assert.ok(t.sc.ops().includes('vad.load') && t.sc.ops().includes('warmup'));
  assert.ok(t.audits.some((a) => a.type === 'calls_arm' && a.armed === true));
  assert.ok(t.hub.events.some((e) => e.type === 'calls' && e.data.armed === true));

  // A denied re-arm keeps the current arming.
  const p2 = t.mgr.requestArm({ minutes: 60 });
  const card2 = await waitFor(() => t.broker.pending()[0]);
  t.broker.resolve(card2.id, 'deny', 'not now', { via: 'click' });
  const denied = await p2;
  assert.equal(denied.denied, true);
  assert.equal(t.mgr.status().armed, true);

  const off = t.mgr.disarm('user');
  assert.equal(off.ok, true);
  assert.equal(t.mgr.status().armed, false);
  assert.equal(t.det.state, 'stopped');
  assert.equal(t.clone.held, 0);
  assert.ok(t.engines[0].stopped, 'the prewarmed engine is stopped');
  await waitFor(() => t.bridge.calls.includes('teardown'));
});

test('manager: no card when the voice runtime is missing; arming fails when the greeting cannot be spoken', async () => {
  const t = makeManager({ cloneOpts: { installed: false } });
  const r = await t.mgr.requestArm({ minutes: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_INSTALLED');
  assert.match(r.hint, /anywhere clone-voice install/);
  assert.equal(t.broker.pending().length, 0);

  const mute = makeManager({ cloneOpts: { profileOk: false }, osRender: async () => Promise.reject(new Error('no espeak')) });
  const { res } = await armByClick(mute);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_VOICE');
  assert.equal(mute.mgr.status().armed, false);
  assert.equal(mute.clone.held, 0, 'the sidecar is released again');
});

test('manager: arming expires; quiet hours, other apps and a user who picks up are not answered', async () => {
  const t = makeManager();
  await armByClick(t);
  t.mgr.armed.until = Date.now() + 40;
  t.mgr._scheduleExpiry();
  await waitFor(() => !t.mgr.status().armed, { what: 'expiry' });
  assert.ok(t.hub.events.some((e) => e.type === 'notify' && /time you set ran out/.test(e.data.text)));

  const now = Date.now();
  const quiet = makeManager({ calls: { quietHours: { enabled: true, start: hhmmFrom(now - 3600000), end: hhmmFrom(now + 3600000) } } });
  await armByClick(quiet);
  quiet.det.ring();
  await waitFor(() => quiet.mgr.recent.length, { what: 'missed call' });
  assert.equal(quiet.mgr.recent[0].type, 'missed');
  assert.equal(quiet.mgr.recent[0].reason, 'quiet_hours');
  assert.equal(quiet.answers.length, 0);
  assert.ok(quiet.hub.events.some((e) => e.type === 'notify' && /Missed call from Ankit Sharma \(quiet hours/.test(e.data.text)));

  const meetOnly = makeManager();
  await armByClick(meetOnly, { apps: ['meet'] });
  meetOnly.det.ring();
  await waitFor(() => meetOnly.mgr.recent.length);
  assert.deepEqual([meetOnly.mgr.recent[0].type, meetOnly.mgr.recent[0].reason], ['not_answered', 'app_not_armed']);

  const picked = makeManager();
  picked.det.nextWait = { ok: false, reason: 'answered_elsewhere', userAnswered: true };
  await armByClick(picked);
  picked.det.ring();
  await waitFor(() => picked.mgr.recent.length);
  assert.equal(picked.mgr.recent[0].type, 'user_answered');
  assert.equal(picked.answers.length, 0);
  assert.equal(picked.mgr.status().state, 'armed');
});

test('manager: a failed answer restores the audio and tells the user', async () => {
  const t = makeManager({ answerResult: { ok: false, reason: 'not_verified' } });
  await armByClick(t);
  t.det.ring();
  await waitFor(() => t.mgr.recent.length, { what: 'failed answer' });
  assert.deepEqual(t.bridge.calls.filter((c) => c === 'release' || (Array.isArray(c) && c[0] === 'engage')).map((c) => (Array.isArray(c) ? c[0] : c)), ['engage', 'release']);
  assert.ok(t.det.calls.includes('answerFailed'));
  assert.ok(t.hub.events.some((e) => e.type === 'notify' && e.data.text === "I couldn't answer Ankit Sharma's call (not_verified)." && e.data.speak === true));
  assert.equal(t.mgr.status().state, 'armed');
  assert.equal(t.answers[0].armedUntil, t.mgr.armed.until);
  assert.deepEqual(t.answers[0].config.calls.apps, ['zoho-cliq', 'google-meet']);
});

test('manager: a whole call — answer, greeting, ticket assigned to the bound caller, chat after the call, notes, announcement', async () => {
  const t = makeManager();
  await armByClick(t);
  await waitFor(() => t.engines.length === 1);
  const prewarmedId = t.callIdRef.id;
  t.det.ring();
  await waitFor(() => t.mgr.currentCall(), { what: 'the call' });
  const call = t.mgr.currentCall();
  assert.equal(call.id, prewarmedId, 'the prewarmed engine and its call id are used');
  assert.equal(t.answers.length, 1);
  assert.deepEqual(t.bridge.calls.find((c) => Array.isArray(c) && c[0] === 'engage')[1], { browserApp: 'brave' });
  const session = t.mgr.currentSession();
  await waitFor(() => session.disclosureSpoken, { what: 'greeting' });
  assert.equal(t.sc.said()[0], GREETING);
  assert.equal(t.engines[0].sent[0], '[call connected: caller "Ankit Sharma" on Zoho Cliq; the greeting was spoken; reply exactly OK]');

  t.sc.caller('Hi, can you please assign me a ticket from the current sprint?');
  await waitFor(() => t.sc.said().some((x) => /I've assigned you PAY-412/.test(x)), { what: 'assignment reply' });
  const search = t.jira.reqs.find((r) => r[0] === 'search' && /openSprints/.test(r[1]));
  assert.equal(search[1], 'assignee is EMPTY AND statusCategory != Done AND sprint in openSprints() AND project in ("PAY", "OPS") ORDER BY priority DESC, Rank ASC');
  assert.deepEqual(t.jira.reqs.find((r) => r[0] === 'assign'), ['assign', 'PAY-412', ANKIT.accountId]);
  // A second assignment is over budget; tools that are not call tools are refused.
  const again = await t.mgr.tool(call.id, 'call_assign_ticket_to_caller', { key: 'PAY-413' });
  assert.equal(again.isError, true);
  assert.match(again.text, /limit for assignments/);
  const shot = await t.mgr.tool(call.id, 'screenshot', {});
  assert.deepEqual(shot, { ok: false, isError: true, text: `Not allowed: ${policy.DENY_TEXT}` });
  await assert.rejects(t.mgr.tool('someone-else', 'call_note', { text: 'x' }), { status: 403 });
  assert.ok(t.audits.some((a) => a.type === 'call_tool' && a.name === 'screenshot' && a.allowed === false));
  assert.ok(t.audits.some((a) => a.type === 'call_tool' && a.name === 'call_assign_ticket_to_caller' && a.allowed === true && a.ok === true));

  t.sc.caller("Thanks, that's all. Bye!");
  await waitFor(() => !t.mgr.currentCall(), { timeoutMs: 6000, what: 'wrap-up' });
  assert.equal(t.hangUps.length, 1, 'End call was clicked in the app');
  assert.equal(t.hangUps[0].windowId, '0x10');
  assert.ok(t.bridge.calls.includes('release'));
  assert.ok(t.det.calls.includes('callEnded'));
  // The chat message went out after the call, links limited to this call's ticket.
  assert.equal(t.chats.length, 1);
  assert.equal(t.chats[0].text, 'Hi Ankit, PAY-412 is assigned to you: https://acme.atlassian.net/browse/PAY-412 (more: [link removed])');
  assert.equal(t.chats[0].callerName, 'Ankit Sharma');
  assert.equal(t.chats[0].email, ANKIT.email);
  assert.equal(t.chats[0].callWindowId, '0x10');
  // Notes: actions from the daemon's log, the summary from the engine.
  assert.equal(t.notesCalls.length, 1);
  const n = t.notesCalls[0];
  assert.equal(n.summary.summary, 'Ankit asked for a sprint ticket and got PAY-412.');
  assert.equal(n.call.caller.displayName, 'Ankit Sharma');
  assert.equal(n.call.caller.jiraAccount.email, ANKIT.email);
  assert.equal(n.call.cloned, true);
  assert.equal(n.call.disclosureSpoken, true);
  assert.equal(n.call.endReason, 'assistant_ended');
  const names = n.actions.map((a) => `${a.name}:${a.ok}`);
  assert.deepEqual(names, ['call_assign_ticket_to_caller:true', 'chat_sent:true']);
  assert.equal(n.transcript[0].role, 'assistant');
  assert.equal(n.transcript[0].text, GREETING);
  assert.ok(t.hub.events.some((e) => e.type === 'notify' && e.data.text === 'Call with Ankit finished; notes are on your Desktop.' && e.data.speak === true));
  assert.ok(t.hub.events.some((e) => e.type === 'call_notes' && e.data.callId === call.id));
  assert.ok(t.hub.events.some((e) => e.type === 'call_transcript' && e.data.role === 'caller'));
  assert.ok(t.hub.events.some((e) => e.type === 'call_action' && e.data.name === 'call_assign_ticket_to_caller'));
  const rec = t.mgr.recent.find((r) => r.callId === call.id);
  assert.match(rec.notesPath, /note\.md$/);
  // Call data is kept privately; the engine's run files are gone.
  const dir = path.join(HOME, 'calls-mgr', call.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).caller, 'Ankit Sharma');
  assert.ok(fs.readFileSync(path.join(dir, 'actions.jsonl'), 'utf8').includes('PAY-412'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'transcript.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(dir, 'engine')), false);
  await assert.rejects(t.mgr.tool(call.id, 'call_note', { text: 'late' }), { status: 403 });
  // Back to armed with a fresh engine for the next call.
  assert.equal(t.mgr.status().state, 'armed');
  await waitFor(() => t.engines.length === 2, { what: 'next prewarm' });
  assert.notEqual(t.callIdRef.id, call.id);
  t.mgr.disarm('test');
});

test('manager: an unconfirmed caller gets nothing assigned (deferred); the call app hanging up ends the call without a click', async () => {
  const jira = fakeJira();
  jira.findUser = async () => [ANKIT, { ...ANKIT, accountId: '5b10ac8d82e05b22cc7d4ef6', email: 'other@example.com' }];
  jira.assignable = async () => [ANKIT, { ...ANKIT, accountId: '5b10ac8d82e05b22cc7d4ef6', email: 'other@example.com' }];
  const t = makeManager({ jira });
  await armByClick(t);
  t.det.ring();
  await waitFor(() => t.mgr.currentSession() && t.mgr.currentSession().disclosureSpoken);
  const id = t.mgr.currentCall().id;
  const ask = await t.mgr.tool(id, 'call_assign_ticket_to_caller', { key: 'PAY-412' });
  assert.match(ask.text, /Ask the caller for their work email/);
  const wrong = await t.mgr.tool(id, 'call_assign_ticket_to_caller', { key: 'PAY-412', email: 'priya@example.com' });
  assert.match(wrong.text, /could not confirm Ankit's Jira account, so nothing was assigned/);
  assert.equal(jira.reqs.filter((r) => r[0] === 'assign').length, 0);
  assert.equal(t.mgr.policy.budgetLeft(t.mgr.call.state).assign, 1, 'a refused assignment does not use the budget');
  const ok = await t.mgr.tool(id, 'call_assign_ticket_to_caller', { key: 'PAY-412', email: 'ANKIT.SHARMA@example.com' });
  assert.match(ok.text, /^Assigned PAY-412/);
  const taken = await t.mgr.tool(id, 'call_ticket_brief', { key: 'PAY-500' });
  assert.match(taken.text, /assigned to someone/, 'other people are not named');
  t.det.emit('call_ended', { reason: 'window_closed' });
  await waitFor(() => !t.mgr.currentCall(), { timeoutMs: 6000 });
  assert.equal(t.hangUps.length, 0, 'the caller hung up: no click');
  const follow = t.notesCalls[0].actions.filter((a) => a.deferred).map((a) => a.args.request);
  assert.deepEqual(follow, ['Assign PAY-412 to Ankit Sharma']);
  t.mgr.disarm('test');
});

// ------------------------------------------------------------------------------ MCP tools per role

const toolsMod = require('../src/mcp/tools');
const toolsCalls = require('../src/mcp/tools-calls');

function toolsExt({ role, client, env }) {
  return {
    role,
    client: async () => client,
    ok: (text) => ({ content: [{ type: 'text', text }] }),
    fail: (text) => ({ content: [{ type: 'text', text }], isError: true }),
    objectSchema: (properties, required = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) }),
    annotations: (title) => ({ title }),
    keepAlive: () => () => {},
    daemonRequest: (c, method, p, body) => c.request(method, p, body),
    deps: { env: env || {} },
  };
}

test('tools: the call role gets only the call_* tools; call_permission always denies; tools carry the call id and role header', async () => {
  const sent = [];
  let reply = { status: 200, text: JSON.stringify({ ok: true, text: 'Assigned PAY-412.' }) };
  const client = {
    async send(method, p, payload, headers) {
      sent.push({ method, p, body: JSON.parse(payload.toString()), headers });
      return reply;
    },
  };
  const tools = toolsCalls.createTools(toolsExt({ role: 'call', client, env: { ANYWHERE_CALL_ID: 'call-123' } }));
  assert.deepEqual(tools.map((t) => t.name), toolsCalls.CALL_TOOL_NAMES);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  const perm = await by.call_permission.handler({ tool_name: 'mcp__anywhere__screenshot', input: {} });
  assert.deepEqual(JSON.parse(perm.content[0].text), { behavior: 'deny', message: 'Not allowed during calls. Use call_defer.' });
  const r = await by.call_assign_ticket_to_caller.handler({ key: 'PAY-412' });
  assert.equal(r.content[0].text, 'Assigned PAY-412.');
  assert.equal(r.isError, undefined);
  assert.deepEqual(sent[0], { method: 'POST', p: '/api/calls/tool', body: { callId: 'call-123', name: 'call_assign_ticket_to_caller', args: { key: 'PAY-412' } }, headers: { 'Content-Type': 'application/json', 'X-Anywhere-Role': 'call' } });
  reply = { status: 200, text: JSON.stringify({ ok: false, isError: true, text: 'Not allowed: nope' }) };
  assert.equal((await by.call_note.handler({ text: 'x' })).isError, true);
  reply = { status: 403, text: JSON.stringify({ error: 'No call is active' }) };
  const gone = await by.call_note.handler({ text: 'x' });
  assert.equal(gone.isError, true);
  assert.match(gone.content[0].text, /call is over/);
  const noId = toolsCalls.createTools(toolsExt({ role: 'call', client, env: {} }));
  assert.match((await noId.find((t) => t.name === 'call_context').handler({})).content[0].text, /only during a call/);

  // Through tools.js: the main roles get the arming tools and none of the call tools.
  for (const role of ['interactive', 'engine']) {
    const names = toolsMod.createTools({ computer: async () => null, role }).map((t) => t.name);
    for (const n of toolsCalls.MAIN_TOOL_NAMES) assert.ok(names.includes(n), `${role} has ${n}`);
    assert.ok(!names.some((n) => /^call_/.test(n)), `${role} has no call_* tools`);
  }
  const callNames = toolsMod.createTools({ computer: async () => null, role: 'call' }).map((t) => t.name);
  for (const n of toolsCalls.CALL_TOOL_NAMES) assert.ok(callNames.includes(n));
  assert.ok(!callNames.includes('calls_arm'), 'the call engine cannot arm calls');
});

test('tools: calls_arm waits for the card and reports the result; calls_disarm', async () => {
  const reqs = [];
  const client = {
    async request(method, p, body) {
      reqs.push([method, p, body]);
      if (p === '/api/calls/arm') return { ok: true, armed: true, untilLocal: '18:00', apps: ['zoho-cliq'], cloned: true };
      return { ok: true };
    },
  };
  const tools = Object.fromEntries(toolsCalls.createTools(toolsExt({ role: 'interactive', client })).map((t) => [t.name, t]));
  const r = await tools.calls_arm.handler({ minutes: 90, apps: ['cliq'], instructions: 'Assign sprint tickets' });
  assert.match(r.content[0].text, /^Answering calls until 18:00 \(zoho-cliq\)\. The assistant speaks in the user's cloned voice\./);
  assert.deepEqual(reqs[0], ['POST', '/api/calls/arm', { via: 'mcp', minutes: 90, apps: ['cliq'], instructions: 'Assign sprint tickets' }]);
  assert.match(tools.calls_arm.description, /never on your own initiative/);
  assert.equal((await tools.calls_disarm.handler({})).content[0].text, 'Stopped answering calls.');
  const denied = Object.fromEntries(toolsCalls.createTools(toolsExt({ role: 'interactive', client: { request: async () => ({ ok: false, denied: true, message: 'You did not allow answering calls.' }) } })).map((t) => [t.name, t]));
  const d = await denied.calls_arm.handler({});
  assert.equal(d.isError, true);
  assert.match(d.content[0].text, /^Not turned on: You did not allow answering calls\./);
});

// ------------------------------------------------------------------------------ routes

const TOKEN = 'calls-test-token-1234567890';

async function startDaemon({ manager, broker, hub }) {
  const { createServer } = require('../src/daemon/server');
  const server = createServer({ hub, session: null, permissions: broker, config: { calls: {} }, token: TOKEN, instanceId: 'calls', version: '0', env: {}, callsFactory: () => manager, callsRestoreOnStart: false });
  const port = await server.listen(0);
  const api = async (method, p, body, { token = TOKEN, headers = {}, signal } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  };
  return { server, port, api };
}

test('routes: status, arm blocks on the card (click only), tool calls need the call role and an active call', async () => {
  const { Hub } = require('../src/daemon/hub');
  const hub = new Hub();
  const broker = new PermissionBroker({ config: { permissions: { mode: 'auto' } }, hub, audit: () => {} });
  const t = makeManager({ hub, broker });
  const d = await startDaemon({ manager: t.mgr, broker, hub });
  try {
    assert.equal((await d.api('GET', '/api/calls/status', undefined, { token: '' })).status, 401);
    const st = await d.api('GET', '/api/calls/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.armed, false);
    assert.equal(st.json.state, 'disarmed');

    const arming = d.api('POST', '/api/calls/arm', { minutes: 45, apps: ['cliq'], via: 'cli' });
    const card = await waitFor(() => broker.pending()[0], { what: 'card' });
    const byVoice = await d.api('POST', '/api/approval', { id: card.id, decision: 'allow', via: 'voice' });
    assert.equal(byVoice.status, 409);
    assert.equal(byVoice.json.code, 'CRITICAL_NEEDS_CLICK');
    assert.equal((await d.api('POST', '/api/approval', { id: card.id, decision: 'allow', via: 'click' })).status, 200);
    const armed = await arming;
    assert.equal(armed.status, 200);
    assert.equal(armed.json.ok, true);
    assert.equal(armed.json.armed, true);
    assert.equal(armed.json.minutes, 45);
    assert.equal((await d.api('GET', '/api/calls/status')).json.armed, true);

    // The call role cannot arm; tool calls need the role header and the active call's id.
    assert.equal((await d.api('POST', '/api/calls/arm', {}, { headers: { 'X-Anywhere-Role': 'call' } })).status, 403);
    const noRole = await d.api('POST', '/api/calls/tool', { callId: 'x', name: 'call_note', args: { text: 'hi' } });
    assert.equal(noRole.status, 403);
    assert.equal(noRole.json.code, 'NOT_CALL_ROLE');
    const noCall = await d.api('POST', '/api/calls/tool', { callId: 'x', name: 'call_note', args: { text: 'hi' } }, { headers: { 'X-Anywhere-Role': 'call' } });
    assert.equal(noCall.status, 403);
    assert.equal(noCall.json.error, 'No call is active');
    assert.equal((await d.api('POST', '/api/calls/simulate', { app: 'cliq' })).status, 404, 'simulation needs ANYWHERE_CALLS_SIMULATE=1');

    // A withdrawn arm request (the CLI was stopped) cancels its card.
    const ac = new AbortController();
    const withdrawn = d.api('POST', '/api/calls/arm', { minutes: 5 }, { signal: ac.signal }).catch((err) => err);
    await waitFor(() => broker.pending()[0], { what: 'second card' });
    ac.abort();
    await withdrawn;
    await waitFor(() => broker.pending().length === 0, { what: 'card cancelled' });

    const code = await d.api('POST', '/api/calls/audio-test/start');
    assert.equal(code.status, 200);
    assert.match(code.json.url, new RegExp(`^http://127\\.0\\.0\\.1:${d.port}/calls-audio-test\\.html\\?code=[0-9a-f]{32}$`));
    const badCode = await d.api('POST', '/api/calls/audio-test/begin?code=0123', {}, { token: '' });
    assert.equal(badCode.status, 403, 'the self-test page needs its single-use code, not the token');

    const off = await d.api('POST', '/api/calls/disarm', {});
    assert.equal(off.json.armed, false);
    assert.equal((await d.api('GET', '/api/calls/status')).json.armed, false);
  } finally {
    t.mgr.disarm('test');
    hub.close();
    await d.server.close();
  }
});

// ------------------------------------------------------------------------------ end to end

/** A Jira Cloud stand-in: search, user search and assignee changes. */
async function fakeJiraServer() {
  const requests = [];
  const raw = (key, summary, assignee = null) => ({
    key,
    fields: { summary, status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } }, issuetype: { name: 'Bug' }, priority: { name: 'High' }, assignee, updated: '2026-10-18T10:00:00.000+0000' },
  });
  const issues = { 'PAY-412': raw('PAY-412', 'Fix retry on failed card capture') };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };
      if (req.method === 'GET' && url.pathname === '/rest/api/3/search/jql') {
        const jql = url.searchParams.get('jql');
        const k = /key = "([^"]+)"/.exec(jql);
        if (k) return send(200, { issues: issues[k[1]] ? [issues[k[1]]] : [] });
        if (/currentUser/.test(jql)) return send(200, { issues: [raw('PAY-1', 'Mine'), raw('OPS-7', 'Mine too')] });
        return send(200, { issues: Object.values(issues).filter((i) => !i.fields.assignee) });
      }
      if (req.method === 'GET' && url.pathname === '/rest/api/3/user' && url.searchParams.get('accountId') === ANKIT.accountId) {
        return send(200, { accountId: ANKIT.accountId, displayName: 'Ankit Sharma', emailAddress: ANKIT.email, active: true, accountType: 'atlassian' });
      }
      if (req.method === 'GET' && url.pathname === '/rest/api/3/user/search') {
        return send(200, [{ accountId: ANKIT.accountId, displayName: 'Ankit Sharma', emailAddress: ANKIT.email, active: true, accountType: 'atlassian' }]);
      }
      const m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/assignee$/.exec(url.pathname);
      if (req.method === 'PUT' && m) {
        const b = JSON.parse(body || '{}');
        issues[m[1]].fields.assignee = { accountId: b.accountId, displayName: 'Ankit Sharma' };
        res.writeHead(204);
        return res.end();
      }
      return send(404, { errorMessages: ['not found'] });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

test('end to end: a call through the real MCP server (call role) and the fake call engine, with Jira, chat and notes', { timeout: 90000 }, async () => {
  const { Hub } = require('../src/daemon/hub');
  const { JiraClient } = require('../src/integrations/jira');
  const hub = new Hub();
  const broker = new PermissionBroker({ config: { permissions: { mode: 'auto' } }, hub, audit: () => {} });
  const fj = await fakeJiraServer();
  const notesDir = path.join(HOME, 'notes-e2e');
  const log = path.join(HOME, 'fake-call-claude.log');
  process.env.FAKE_CALL_CLAUDE_LOG = log;
  const sc = new FakeSidecar({ msPerChar: 0 });
  const chats = [];
  const opened = [];
  let d = null;
  const t = makeManager({
    hub,
    broker,
    sidecar: sc,
    jira: new JiraClient({ baseUrl: fj.url, email: 'deepanshu@example.com', apiToken: 'jira-token-123456', deployment: 'Cloud' }),
    notes: undefined,
    cliq: {
      sendChat: async (c) => {
        chats.push(c);
        return { ok: true, via: 'gui', sent: true };
      },
    },
    engineFactory: null,
    calls: { notesDir, ownerName: 'Deepanshu Patel' },
    extra: {
      engineFactory: undefined,
      openTarget: async (file, opts) => opened.push([file, opts]),
      locateClaude: async () => ({ path: FAKE_CALL_CLAUDE }),
      daemonInfo: () => ({ url: `http://127.0.0.1:${d.port}`, token: TOKEN }),
    },
  });
  t.mgr.o.notes = undefined;
  delete t.mgr.o.notes;
  d = await startDaemon({ manager: t.mgr, broker, hub });
  try {
    const arming = d.api('POST', '/api/calls/arm', { minutes: 20, via: 'test' });
    const card = await waitFor(() => broker.pending()[0], { what: 'card' });
    await d.api('POST', '/api/approval', { id: card.id, decision: 'allow', via: 'click' });
    assert.equal((await arming).json.armed, true);
    await waitFor(() => t.mgr.prewarmed, { timeoutMs: 10000, what: 'prewarmed engine' });
    await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('argv'), { timeoutMs: 10000, what: 'the engine launch' });
    const launch = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
    const at = (flag) => launch.argv[launch.argv.indexOf(flag) + 1];
    assert.equal(at('--tools'), '');
    assert.equal(at('--permission-prompt-tool'), 'mcp__anywhere__call_permission');
    assert.ok(launch.argv.includes('--strict-mcp-config') && launch.argv.includes('--system-prompt-file'));

    t.det.ring();
    const session = await waitFor(() => t.mgr.currentSession(), { what: 'call' });
    const callId = t.mgr.currentCall().id;
    await waitFor(() => session.disclosureSpoken && session.primed, { timeoutMs: 20000, what: 'greeting and priming' });
    assert.equal(sc.said()[0], GREETING);

    sc.caller('Hi, can you please assign me a ticket from the current sprint?');
    await waitFor(() => sc.said().some((x) => /I've assigned you PAY-412/.test(x)), { timeoutMs: 30000, what: 'assignment' });
    const put = fj.requests.find((r) => r.method === 'PUT');
    assert.equal(put.path, '/rest/api/3/issue/PAY-412/assignee');
    assert.deepEqual(JSON.parse(put.body), { accountId: ANKIT.accountId });
    const search = fj.requests.find((r) => r.path === '/rest/api/3/search/jql' && /openSprints/.test(r.query.jql));
    assert.equal(search.query.jql, 'assignee is EMPTY AND statusCategory != Done AND sprint in openSprints() AND project in ("PAY", "OPS") ORDER BY priority DESC, Rank ASC');
    assert.equal(search.query.maxResults, '5');
    assert.ok(sc.said().indexOf('Sure, let me check the board.') > 0, 'the reply was streamed clause by clause');

    // Anything else (a screenshot) goes to the always-deny permission tool, then to call_defer.
    sc.caller('Can you take a screenshot of my screen for me?');
    await waitFor(() => sc.said().some((x) => /can't do that during calls/.test(x)), { timeoutMs: 30000, what: 'refusal' });
    const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const perm = entries.find((e) => e.permission === 'mcp__anywhere__screenshot');
    assert.deepEqual(perm.decision, { behavior: 'deny', message: 'Not allowed during calls. Use call_defer.' });
    assert.ok(entries.some((e) => e.turn && e.turn.startsWith('Caller (speech recognition, may contain errors): Hi, can you please')));

    sc.caller("Great, thanks. That's all, bye!");
    await waitFor(() => !t.mgr.currentCall(), { timeoutMs: 30000, what: 'wrap-up' });
    assert.equal(t.hangUps.length, 1);
    assert.equal(chats.length, 1);
    assert.equal(chats[0].text, `Hi, PAY-412 is assigned to you: ${fj.url}/browse/PAY-412. Also see [link removed]`);
    const files = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d\d-\d\d \d\d-\d\d Ankit \(Zoho Cliq\)\.md$/);
    const md = fs.readFileSync(path.join(notesDir, files[0]), 'utf8');
    assert.match(md, /^# Call with Ankit Sharma — Zoho Cliq/);
    assert.match(md, /Assigned \*\*PAY-412\*\* "Fix retry on failed card capture" to Ankit Sharma ✓/);
    assert.match(md, /Sent Ankit a Zoho Cliq message/);
    assert.match(md, /- Ankit asked: The caller asked for a screenshot/);
    assert.match(md, /\| Ended \| The assistant ended the call \|/);
    assert.match(md, /The caller asked for a ticket from the current sprint and got one assigned\./);
    assert.ok(md.includes(GREETING), 'the transcript has the disclosure');
    const meta = JSON.parse(fs.readFileSync(path.join(HOME, 'calls-mgr', callId, 'meta.json'), 'utf8'));
    assert.equal(meta.notesPath, path.join(notesDir, files[0]));
    assert.equal(t.mgr.status().state, 'armed');
    // The panel reads and opens these notes, and only notes the daemon wrote.
    const viaId = await d.api('GET', `/api/calls/notes?callId=${callId}`);
    assert.equal(viaId.status, 200);
    assert.equal(viaId.json.markdown, md);
    assert.equal((await d.api('GET', `/api/calls/notes?path=${encodeURIComponent(meta.notesPath)}`)).json.path, meta.notesPath);
    assert.equal((await d.api('GET', `/api/calls/notes?path=${encodeURIComponent('/etc/passwd')}`)).status, 404);
    assert.equal((await d.api('GET', '/api/calls/notes?callId=../../etc')).status, 404);
    assert.equal((await d.api('POST', '/api/calls/notes/open', { callId })).status, 200);
    assert.deepEqual(opened, [[meta.notesPath, { kind: 'path' }]]);
    assert.equal((await d.api('POST', '/api/calls/notes/open', { path: path.join(HOME, 'calls-mgr', callId, 'meta.json') })).status, 404);
    const recent = (await d.api('GET', '/api/calls/status')).json.recent.find((r) => r.callId === callId);
    assert.equal(recent.outcome, 'answered');
    assert.equal(recent.notesPath, meta.notesPath);
  } finally {
    delete process.env.FAKE_CALL_CLAUDE_LOG;
    await t.mgr.shutdown();
    hub.close();
    await d.server.close();
    await fj.close();
  }
});
