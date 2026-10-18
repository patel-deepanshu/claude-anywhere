'use strict';

/**
 * SidecarClient (src/voice/clone/client.js) against a fake sidecar written in Node: the ready
 * handshake, request/response matching, per-request events, sidecar errors, garbage on stdout,
 * crashes and the automatic restart, timeouts and cancellation, start failures, and the stop
 * escalation (shutdown op → SIGTERM → SIGKILL, taskkill for Windows children). No Python, no
 * network, no audio.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { SidecarClient, MAX_GARBAGE } = require('../src/voice/clone/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-clone-client-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

// A fake sidecar: protocol v1 over stdio, steered by env variables and request ops.
const FAKE_SRC = `
'use strict';
const fs = require('fs');
const env = process.env;
const logFile = env.FAKE_LOG;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (env.FAKE_IGNORE_TERM) process.on('SIGTERM', () => {});
if (env.FAKE_EXIT_AT_START) { process.stderr.write('Traceback: ImportError: no module named sherpa_onnx\\n'); process.exit(4); }
const garbageFirst = Number(env.FAKE_GARBAGE_FIRST || 0);
for (let i = 0; i < garbageFirst; i += 1) process.stdout.write('warning: native log line ' + i + '\\n');
const ready = () => out({ event: 'ready', protocol: Number(env.FAKE_PROTOCOL || 1), pid: process.pid, python: '3.12.0', sherpa: 'fake', ops: ['echo'] });
if (!env.FAKE_NO_READY) setTimeout(ready, Number(env.FAKE_READY_DELAY || 0));
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); handle(line); }
});
process.stdin.on('end', () => { if (!env.FAKE_IGNORE_SHUTDOWN) process.exit(0); });
function handle(line) {
  const req = JSON.parse(line);
  if (logFile) fs.appendFileSync(logFile, JSON.stringify(req) + '\\n');
  const { id, op, ...p } = req;
  switch (op) {
    case 'echo': out({ id, ok: true, params: p }); break;
    case 'fail': out({ id, ok: false, error: 'The voice profile has no verified consent', code: 'PROFILE_INVALID', hint: 'Record your voice again' }); break;
    case 'slow': setTimeout(() => out({ id, ok: true, late: true }), p.ms || 1000); break;
    case 'events':
      for (let i = 0; i < (p.n || 3); i += 1) out({ event: 'tts.chunk', id, index: i, samples: 100 * (i + 1) });
      out({ event: 'level', rms: 0.1 });
      out({ id, ok: true, chunks: p.n || 3 });
      break;
    case 'split': {
      const s = JSON.stringify({ id, ok: true, split: true });
      process.stdout.write(s.slice(0, 7));
      setTimeout(() => process.stdout.write(s.slice(7) + '\\r\\n'), 30);
      break;
    }
    case 'garbage':
      for (let i = 0; i < p.n; i += 1) process.stdout.write('not json ' + i + '\\n');
      out({ id, ok: true });
      break;
    case 'stderr': process.stderr.write('line one\\nline two\\n'); out({ id, ok: true }); break;
    case 'crash': process.stderr.write('Segmentation fault in onnxruntime\\n'); process.exit(3); break;
    case 'cancel': out({ id, ok: true, cancelled: true }); break;
    case 'shutdown':
      out({ id, ok: true, bye: true });
      if (!env.FAKE_IGNORE_SHUTDOWN) setTimeout(() => process.exit(0), 10);
      break;
    default: out({ id, ok: false, error: 'Unknown op ' + op, code: 'BAD_REQUEST' });
  }
}
`;
const FAKE = path.join(TMP, 'fake-sidecar.js');
fs.writeFileSync(FAKE, FAKE_SRC);

let logN = 0;
function client(env = {}, opts = {}) {
  const log = path.join(TMP, `log-${(logN += 1)}.jsonl`);
  const c = new SidecarClient({
    python: process.execPath,
    flags: [],
    script: FAKE,
    args: ['--state', TMP],
    env: { ...process.env, FAKE_LOG: log, ...env },
    startTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    ...opts,
  });
  c.logFile = log;
  return c;
}

function sent(c) {
  try {
    return fs
      .readFileSync(c.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}

test('start resolves with the ready payload; requests match responses by id', async () => {
  const c = client();
  assert.equal(c.running, false);
  const hello = await c.start();
  try {
    assert.equal(hello.protocol, 1);
    assert.equal(hello.sherpa, 'fake');
    assert.equal(hello.event, undefined, 'the event name is not part of hello');
    assert.equal(c.running, true);
    assert.ok(c.pid > 0);
    assert.deepEqual(c.info, hello);
    // start() again is a no-op while running.
    assert.equal(await c.start(), hello);

    const [a, b] = await Promise.all([c.request('echo', { text: 'hi', n: 1 }), c.request('echo', { text: 'there' })]);
    assert.deepEqual(a, { params: { text: 'hi', n: 1 } });
    assert.deepEqual(b, { params: { text: 'there' } });
    // id and op cannot be overridden by params.
    const r = await c.request('echo', { id: 'evil', op: 'crash' });
    assert.deepEqual(r.params, {});
    const reqs = sent(c);
    assert.ok(reqs.every((q) => Number.isInteger(q.id)), 'ids are integers');
    assert.equal(new Set(reqs.map((q) => q.id)).size, reqs.length, 'ids are unique');

    // A response split over two writes, with CRLF.
    assert.deepEqual(await c.request('split'), { split: true });
  } finally {
    await c.stop();
  }
});

test('sidecar errors reject with code, hint and op', async () => {
  const c = client();
  await c.start();
  try {
    await assert.rejects(c.request('fail'), (err) => {
      assert.equal(err.code, 'PROFILE_INVALID');
      assert.equal(err.hint, 'Record your voice again');
      assert.equal(err.op, 'fail');
      assert.match(err.message, /verified consent/);
      return true;
    });
    await assert.rejects(c.request('nope'), { code: 'BAD_REQUEST' });
    // Still usable afterwards.
    assert.ok(await c.request('echo'));
  } finally {
    await c.stop();
  }
});

test('events: onEvent gets the request’s events, every event is emitted', async () => {
  const c = client();
  await c.start();
  const all = [];
  c.on('event', (e) => all.push(e));
  try {
    const mine = [];
    const r = await c.request('events', { n: 3 }, { onEvent: (e) => mine.push(e) });
    assert.equal(r.chunks, 3);
    assert.deepEqual(
      mine.map((e) => [e.event, e.index, e.samples]),
      [
        ['tts.chunk', 0, 100],
        ['tts.chunk', 1, 200],
        ['tts.chunk', 2, 300],
      ],
    );
    assert.ok(all.some((e) => e.event === 'level' && e.rms === 0.1), 'events without an id still reach listeners');
    assert.equal(all.filter((e) => e.event === 'tts.chunk').length, 3);
    // A throwing listener does not break the protocol.
    assert.ok(await c.request('events', { n: 1 }, { onEvent: () => { throw new Error('boom'); } }));
  } finally {
    await c.stop();
  }
});

test('stderr lines are emitted and kept as a tail', async () => {
  const c = client();
  await c.start();
  const lines = [];
  c.on('stderr', (l) => lines.push(l));
  try {
    await c.request('stderr');
    await waitFor(() => lines.length >= 2);
    assert.deepEqual(lines.slice(0, 2), ['line one', 'line two']);
    assert.deepEqual(c.stderrTail.slice(-2), ['line one', 'line two']);
  } finally {
    await c.stop();
  }
});

test('non-JSON stdout lines are ignored up to the limit, then SIDECAR_PROTOCOL', async () => {
  const c = client({ FAKE_GARBAGE_FIRST: '3' });
  const garbage = [];
  c.on('stdout', (l) => garbage.push(l));
  await c.start();
  try {
    assert.equal(garbage.length, 3, 'stray lines before ready are tolerated');
    assert.ok(await c.request('garbage', { n: MAX_GARBAGE - 5 }));
    const exited = new Promise((r) => c.once('exit', r));
    const pending = assert.rejects(c.request('slow', { ms: 3000 }), { code: 'SIDECAR_PROTOCOL' });
    await c.request('garbage', { n: 10 }).catch(() => {});
    await pending;
    await exited;
    assert.equal(c.running, false);
  } finally {
    await c.stop();
  }
});

test('a crash rejects pending requests with the stderr tail; autoRestart restarts once', async () => {
  let inits = 0;
  const c = client({}, { autoRestart: 1, init: async (cl, hello) => { inits += 1; assert.equal(hello.protocol, 1); await cl.request('echo', { init: inits }); } });
  await c.start();
  assert.equal(inits, 1);
  const exits = [];
  c.on('exit', (e) => exits.push(e));
  try {
    const slow = assert.rejects(c.request('slow', { ms: 4000 }), { code: 'SIDECAR_EXITED' });
    const restarted = new Promise((r) => c.once('restarted', r));
    await assert.rejects(c.request('crash'), (err) => {
      assert.equal(err.code, 'SIDECAR_EXITED');
      assert.equal(err.exit.code, 3);
      assert.match(err.exit.stderrTail, /Segmentation fault/);
      return true;
    });
    await slow;
    const hello = await restarted;
    assert.equal(hello.protocol, 1);
    assert.equal(inits, 2, 'init runs again after the restart');
    assert.equal(exits.length, 1);
    assert.equal(exits[0].expected, false);
    assert.deepEqual((await c.request('echo', { again: true })).params, { again: true });

    // The budget is spent: a second crash is not restarted.
    let restartedAgain = false;
    c.once('restarted', () => (restartedAgain = true));
    await assert.rejects(c.request('crash'), { code: 'SIDECAR_EXITED' });
    await sleep(300);
    assert.equal(restartedAgain, false);
    assert.equal(c.running, false);
    await assert.rejects(c.request('echo'), { code: 'SIDECAR_NOT_RUNNING' });
  } finally {
    await c.stop();
  }
});

test('a request timeout rejects SIDECAR_TIMEOUT and asks the sidecar to cancel', async () => {
  const c = client();
  await c.start();
  try {
    const t0 = Date.now();
    await assert.rejects(c.request('slow', { ms: 1500 }, { timeoutMs: 150 }), (err) => {
      assert.equal(err.code, 'SIDECAR_TIMEOUT');
      assert.equal(err.op, 'slow');
      return true;
    });
    assert.ok(Date.now() - t0 < 1000);
    await waitFor(() => sent(c).some((q) => q.op === 'cancel'));
    const reqs = sent(c);
    const slow = reqs.find((q) => q.op === 'slow');
    const cancel = reqs.find((q) => q.op === 'cancel');
    assert.equal(cancel.target, slow.id);
    // The late answer and the cancel's own answer are dropped; the client keeps working.
    await sleep(1600);
    assert.ok(await c.request('echo'));
    assert.equal(c.pending.size, 0);
  } finally {
    await c.stop();
  }
});

test('an AbortSignal cancels a request', async () => {
  const c = client();
  await c.start();
  try {
    const ac = new AbortController();
    const p = c.request('slow', { ms: 2000 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, { code: 'ABORTED' });
    await waitFor(() => sent(c).some((q) => q.op === 'cancel'));
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(c.request('echo', {}, { signal: pre.signal }), { code: 'ABORTED' });
  } finally {
    await c.stop();
  }
});

test('requests are refused when not running or larger than 1 MB', async () => {
  const c = client();
  await assert.rejects(c.request('echo'), { code: 'SIDECAR_NOT_RUNNING' });
  await c.start();
  try {
    await assert.rejects(c.request('echo', { blob: 'x'.repeat(1024 * 1024 + 10) }), { code: 'BAD_REQUEST' });
    await assert.rejects(c.request(''), { code: 'BAD_REQUEST' });
    assert.ok(await c.request('echo'));
  } finally {
    await c.stop();
  }
});

test('start fails cleanly: no ready (timeout), wrong protocol, exit before ready, missing interpreter', async () => {
  const quiet = client({ FAKE_NO_READY: '1' }, { startTimeoutMs: 300 });
  await assert.rejects(quiet.start(), { code: 'SIDECAR_START_TIMEOUT' });
  await waitFor(() => quiet.lastExit !== null);
  assert.ok(quiet.lastExit, 'the silent child was killed');

  const v2 = client({ FAKE_PROTOCOL: '2' });
  await assert.rejects(v2.start(), { code: 'SIDECAR_PROTOCOL' });
  assert.equal(v2.running, false);

  const dead = client({ FAKE_EXIT_AT_START: '1' });
  await assert.rejects(dead.start(), (err) => {
    assert.equal(err.code, 'SIDECAR_EXITED');
    assert.match(err.message, /sherpa_onnx/);
    assert.equal(err.exit.code, 4);
    return true;
  });

  const missing = new SidecarClient({ python: path.join(TMP, 'no-such-python'), flags: [], script: FAKE, startTimeoutMs: 2000 });
  await assert.rejects(missing.start(), { code: 'SIDECAR_EXITED' });

  assert.throws(() => new SidecarClient({ script: FAKE }), { code: 'BAD_REQUEST' });
});

test('init failure stops the sidecar and rejects start', async () => {
  const c = client({}, { init: async () => { throw Object.assign(new Error('tts.load failed'), { code: 'MODEL_MISSING' }); } });
  await assert.rejects(c.start(), { code: 'MODEL_MISSING' });
  assert.equal(c.running, false);
});

test('stop: graceful shutdown op, then SIGTERM, then SIGKILL', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const nice = client();
  await nice.start();
  const t0 = Date.now();
  const info = await nice.stop({ graceMs: 2000 });
  assert.equal(info.code, 0);
  assert.equal(info.expected, true);
  assert.ok(Date.now() - t0 < 1500, 'a cooperative sidecar exits on the shutdown op');
  assert.ok(sent(nice).some((q) => q.op === 'shutdown'));
  assert.equal(nice.running, false);
  assert.equal(await nice.stop(), info, 'stopping again returns the last exit');

  const stubborn = client({ FAKE_IGNORE_SHUTDOWN: '1', FAKE_IGNORE_TERM: '1' });
  await stubborn.start();
  const t1 = Date.now();
  const killed = await stubborn.stop({ graceMs: 200 });
  assert.equal(killed.signal, 'SIGKILL');
  assert.ok(Date.now() - t1 < 3000);

  const termable = client({ FAKE_IGNORE_SHUTDOWN: '1' });
  await termable.start();
  const termed = await termable.stop({ graceMs: 200 });
  assert.equal(termed.signal, 'SIGTERM');
});

test('stop on a Windows child runs taskkill /T /F with the sidecar pid', async () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    if (cmd === 'fake-taskkill') {
      calls.push(args);
      return new (require('events').EventEmitter)();
    }
    return childProcess.spawn(cmd, args, opts);
  };
  const c = client({ FAKE_IGNORE_SHUTDOWN: '1' }, { spawn, platform: 'linux', windowsChild: true, taskkill: 'fake-taskkill' });
  const hello = await c.start();
  const info = await c.stop({ graceMs: 150 });
  assert.ok(info, 'the child exited');
  assert.deepEqual(calls[0], ['/PID', String(hello.pid), '/T', '/F']);
});

test('childPath converts with toChildPath (WSL) and is the identity otherwise', () => {
  const plain = new SidecarClient({ python: 'py', script: 's.py' });
  assert.equal(plain.childPath('/a/b'), '/a/b');
  const wsl = new SidecarClient({ python: 'py', script: 's.py', toChildPath: (p) => `C:${p.replace(/\//g, '\\')}` });
  assert.equal(wsl.childPath('/a/b'), 'C:\\a\\b');
});

test('the spawn command line: flags, script, args and an isolated environment', async () => {
  const seen = [];
  const spawn = (cmd, args, opts) => {
    seen.push({ cmd, args, opts });
    return childProcess.spawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env } });
  };
  const c = new SidecarClient({ python: '/venv/bin/python', script: '/pkg/sidecar.py', args: ['--state', '/s', '--models', '/m'], pythonArgs: ['-3'], env: { PATH: process.env.PATH, PYTHONPATH: '/x' }, spawn, platform: 'linux' });
  await c.start();
  await c.stop();
  assert.equal(seen[0].cmd, '/venv/bin/python');
  assert.deepEqual(seen[0].args, ['-3', '-I', '-u', '-X', 'utf8', '/pkg/sidecar.py', '--state', '/s', '--models', '/m']);
  assert.equal(seen[0].opts.env.PYTHONNOUSERSITE, '1');
  assert.equal(seen[0].opts.env.PYTHONUNBUFFERED, '1');
  assert.equal(seen[0].opts.windowsHide, true);
  assert.equal(seen[0].opts.detached, true, 'POSIX: its own process group');
});
