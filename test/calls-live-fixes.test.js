'use strict';

// Regressions found by the live Linux run of feature 3 (Xvfb, PulseAudio, Chromium, the real claude CLI):
// - a reply's 40-word limit counted the "Sure, let me check" said before a tool call, so the answer's
//   closing question ("Which one would you like me to assign to you?") was dropped and the caller, who was
//   never asked anything, got "Are you still there?" and then a goodbye.
// - when the caller hung up while the assistant was saying its silence goodbye, it still looked for the End call
//   button, did not find it (the call was over) and told the user "Please end the call yourself".

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { CallSession } = require('../src/calls/session');
const policy = require('../src/calls/policy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, { timeoutMs = 4000, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Live audio of the sidecar: every tts.say plays at once (playback.start, then playback.end). */
class Sidecar extends EventEmitter {
  constructor({ playMs = 2 } = {}) {
    super();
    this.requests = [];
    this.playMs = playMs;
  }

  async request(op, params = {}) {
    this.requests.push({ op, params });
    if (op === 'tts.say') {
      setImmediate(() => {
        this.emit('event', { event: 'playback.start', utteranceId: params.utteranceId });
        setTimeout(() => this.emit('event', { event: 'playback.end', utteranceId: params.utteranceId, interrupted: false, started: true, playedChars: params.text.length, chars: params.text.length }), this.playMs);
      });
      return { queued: true };
    }
    return { ok: true };
  }

  said() {
    return this.requests.filter((r) => r.op === 'tts.say').map((r) => r.params.text);
  }

  caller(text) {
    this.emit('event', { event: 'vad.start', t: 0 });
    this.emit('event', { event: 'vad.end', t: 0, ms: 600 });
    this.emit('event', { event: 'asr.final', text, t0: 0, t1: 1, ms: 300 });
  }
}

/** A call engine in stream-json: each say() is one model message (its own message id), like the real CLI. */
class Engine extends EventEmitter {
  constructor(script) {
    super();
    this.script = script;
    this.running = true;
    this.n = 0;
  }

  send(text) {
    const t = typeof text === 'string' ? text : text.map((b) => b.text).join('\n');
    setImmediate(() => this._run(t));
  }

  async _run(text) {
    const emit = (m) => this.emit('message', { parent_tool_use_id: null, ...m });
    const say = (words) => {
      this.n += 1;
      const id = `msg_${this.n}`;
      emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
      for (const piece of words.split(/(?<=\s)/)) emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
      emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: words }] } });
    };
    await this.script(text, { say, emit });
    emit({ type: 'result', subtype: 'success', is_error: false, result: '' });
  }

  interrupt() {
    return Promise.resolve({ ok: true });
  }

  stop() {
    this.running = false;
    return Promise.resolve();
  }
}

test('live fix: the words said before a tool call do not use up the reply that answers (its question is spoken)', async () => {
  const lead = 'Sure, let me look up the unassigned tickets in the open sprint.';
  const list = 'I found two unassigned tickets: PAY-412, a High priority bug to fix retry on failed card capture, and PAY-415, a Low priority story for the payouts dashboard empty state.';
  const question = 'Which one would you like me to assign to you, Ankit?';
  const script = async (text, api) => {
    if (text.includes('[call connected')) return api.say('OK');
    if (text.includes('[The call has ended')) return api.say('{"summary": "x", "followUps": [], "topics": []}');
    api.say(lead);
    api.emit({ type: 'assistant', message: { id: 'msg_lead', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__anywhere__call_find_unassigned_tickets', input: {} }] } });
    await sleep(5);
    api.say(`${list} ${question}`);
    return undefined;
  };
  const sc = new Sidecar();
  const s = new CallSession({
    id: 'c0ffee00-0000-4000-8000-0000000000aa',
    caller: 'Ankit Sharma',
    app: 'zoho-cliq',
    appName: 'Zoho Cliq',
    config: { calls: { maxCallMinutes: 15 } },
    sidecar: sc,
    voice: { cloned: true, say: (t, { utteranceId }) => sc.request('tts.say', { text: t, utteranceId }), stop: () => sc.request('tts.stop', {}) },
    engine: new Engine(script),
    engineFactory: async () => new Engine(script),
    hangUpCall: async () => {},
    audioParams: { capture: { backend: 'pulse', device: 'anywhere_call.monitor' }, playback: { backend: 'pulse', device: 'anywhere_tts' }, halfDuplex: false },
    ownerName: 'Deepanshu Patel',
    pronoun: 'his',
    options: { fillerAfterMs: 5000, stillThereMs: 60000, silenceHangupMs: 120000, primeTimeoutMs: 3000, summaryTimeoutMs: 2000, goodbyeTimeoutMs: 2000 },
  });
  await s.start();
  await waitFor(() => s.disclosureSpoken, { what: 'the greeting' });
  sc.caller('Hi, this is Ankit. Can you please assign me a ticket?');
  await waitFor(() => sc.said().some((t) => /payouts dashboard/.test(t)), { what: 'the list' });
  await sleep(50);
  const reply = sc.said().slice(1).join(' ');
  // The lead (11 words) and the list (29 words) are 40 words together; the question used to be dropped.
  assert.ok(policy.countWords(`${lead} ${list}`) >= 40);
  assert.match(reply, /Which one would you like me to assign to you/, reply);
  assert.match(reply, /^Sure, let me look up/);
  await s.takeover();
});

test('live fix: the caller hangs up during the silence goodbye → no End call click (and no "end it yourself" warning)', async () => {
  const script = async (text, api) => {
    if (text.includes('[call connected')) return api.say('OK');
    if (text.includes('[The call has ended')) return api.say('{"summary": "x", "followUps": [], "topics": []}');
    return api.say('Sure.');
  };
  const sc = new Sidecar({ playMs: 150 });
  const hangups = [];
  const s = new CallSession({
    id: 'c0ffee00-0000-4000-8000-0000000000ab',
    caller: 'Ankit Sharma',
    app: 'zoho-cliq',
    appName: 'Zoho Cliq',
    config: { calls: { maxCallMinutes: 15 } },
    sidecar: sc,
    voice: { cloned: true, say: (t, { utteranceId }) => sc.request('tts.say', { text: t, utteranceId }), stop: () => sc.request('tts.stop', {}) },
    engine: new Engine(script),
    engineFactory: async () => new Engine(script),
    hangUpCall: async (reason) => {
      hangups.push(reason);
    },
    audioParams: { capture: { backend: 'pulse', device: 'anywhere_call.monitor' }, playback: { backend: 'pulse', device: 'anywhere_tts' }, halfDuplex: false },
    ownerName: 'Deepanshu Patel',
    pronoun: 'his',
    options: { fillerAfterMs: 5000, stillThereMs: 100, silenceHangupMs: 400, tickMs: 50, primeTimeoutMs: 3000, summaryTimeoutMs: 2000, goodbyeTimeoutMs: 3000 },
  });
  let e = null;
  s.once('ended', (x) => (e = x));
  await s.start();
  await waitFor(() => s.disclosureSpoken, { what: 'the greeting' });
  // Silence: "Are you still there?", then the goodbye starts; the call app shows the call ended meanwhile.
  await waitFor(() => s.state === 'ending', { what: 'the silence goodbye', timeoutMs: 5000 });
  await s.hangup('caller_hung_up', { goodbye: false });
  await waitFor(() => e, { what: 'the end' });
  assert.equal(e.reason, 'silence');
  assert.deepEqual(hangups, [], 'no End call click once the call app showed the call ended');
  assert.equal(s.callerGone, true);

  // Without the caller hanging up, the silence goodbye still clicks End call.
  const sc2 = new Sidecar({ playMs: 20 });
  const hangups2 = [];
  const s2 = new CallSession({
    id: 'c0ffee00-0000-4000-8000-0000000000ac',
    caller: 'Ankit Sharma',
    app: 'zoho-cliq',
    appName: 'Zoho Cliq',
    config: { calls: { maxCallMinutes: 15 } },
    sidecar: sc2,
    voice: { cloned: true, say: (t, { utteranceId }) => sc2.request('tts.say', { text: t, utteranceId }), stop: () => sc2.request('tts.stop', {}) },
    engine: new Engine(script),
    engineFactory: async () => new Engine(script),
    hangUpCall: async (reason) => {
      hangups2.push(reason);
    },
    audioParams: { capture: { backend: 'pulse', device: 'anywhere_call.monitor' }, playback: { backend: 'pulse', device: 'anywhere_tts' }, halfDuplex: false },
    ownerName: 'Deepanshu Patel',
    pronoun: 'his',
    options: { fillerAfterMs: 5000, stillThereMs: 100, silenceHangupMs: 300, tickMs: 50, primeTimeoutMs: 3000, summaryTimeoutMs: 2000, goodbyeTimeoutMs: 3000 },
  });
  let ended2 = null;
  s2.once('ended', (e2) => (ended2 = e2));
  await s2.start();
  await waitFor(() => ended2, { what: 'the silence hang-up', timeoutMs: 5000 });
  assert.deepEqual(hangups2, ['silence']);
});
