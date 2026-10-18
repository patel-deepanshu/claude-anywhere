'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const win32 = require('../src/os/win32');

const FAKE = path.join(__dirname, 'fixtures', 'fake-ps-host.js');

const tmpRoots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-win32-r2-'));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function fakeDriver(extra = {}, opts = {}) {
  const env = { ...process.env, ANYWHERE_PS_EXE: process.execPath, ANYWHERE_PS_ARGS: JSON.stringify([FAKE]), ...extra };
  return win32.createDriver({ wsl: false, env, ...opts });
}

function readLog(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Feed `child` a protocol line as if it had been waiting in its stdout pipe. */
function lateAnswer(child, id, result) {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id, ok: true, result })}\n`));
}

// WINDOWS-2-6: the host's answer can land after the deadline but before the killed host's exit
// is processed. It must not free the slot, or the next queued command is written to the dying
// host and fails with HOST_EXITED although it never ran.
test('transport: an answer that lands after a timeout does not send the next command to the killed host', async () => {
  const log = path.join(tmpDir(), 'requests.jsonl');
  const driver = await fakeDriver({ FAKE_PS_HANG: 'clipget', FAKE_PS_LOG: log }, { timeoutMs: 400 });
  const host = driver.host;
  try {
    const firstPid = host.pid;
    const child = host._child;
    const onTimeout = host._onTimeout;
    let heldUntilExit = null;
    host._onTimeout = function patched(job) {
      host._onTimeout = onTimeout;
      onTimeout.call(this, job);
      lateAnswer(child, job.id, { text: 'late' });
      heldUntilExit = host._inflight === job;
    };
    const slow = host.request('clipget');
    const queued = host.request('type', { text: 'hi' });
    await assert.rejects(slow, (e) => e.code === 'TIMEOUT' && /clipget/.test(e.message));
    assert.equal(heldUntilExit, true, 'the timed-out job stays in flight until the killed host exits');
    assert.deepEqual(await queued, { typed: 2 }, 'the queued (non-retryable) command runs on a fresh host');
    assert.notEqual(host.pid, firstPid);
    const types = readLog(log).filter((r) => r.cmd === 'type');
    assert.equal(types.length, 1);
    assert.notEqual(types[0].pid, firstPid, 'nothing was written to the timed-out host');
    assert.deepEqual(await host.request('cursor'), { x: 10, y: 10 });
  } finally {
    await driver.close();
  }
});

test('transport: a host being killed gets no further commands, even if it answers before it exits', async () => {
  const log = path.join(tmpDir(), 'requests.jsonl');
  const driver = await fakeDriver({ FAKE_PS_HANG: 'cursor', FAKE_PS_LOG: log }, { timeoutMs: 5000 });
  const host = driver.host;
  try {
    const firstPid = host.pid;
    const child = host._child;
    const first = host.request('cursor');
    const queued = host.request('click', { x: 1, y: 2 });
    // Let the cursor request reach the host, then kill it (as an oversized stdout line does)
    // and deliver the in-flight answer before its exit is processed.
    for (let i = 0; i < 100 && !readLog(log).some((r) => r.cmd === 'cursor'); i++) await new Promise((r) => setTimeout(r, 20));
    const job = host._inflight;
    assert.equal(job && job.cmd, 'cursor');
    host._kill('test');
    lateAnswer(child, job.id, { x: 3, y: 4 });
    assert.deepEqual(await first, { x: 3, y: 4 });
    assert.deepEqual(await queued, { x: 1, y: 2 }, 'the queued click runs on a fresh host');
    assert.notEqual(host.pid, firstPid);
    const clicks = readLog(log).filter((r) => r.cmd === 'click');
    assert.equal(clicks.length, 1);
    assert.notEqual(clicks[0].pid, firstPid);
  } finally {
    await driver.close();
  }
});

test('transport: start() after a timeout does not report the killed host as ready', async () => {
  const driver = await fakeDriver({ FAKE_PS_HANG: 'clipget' }, { timeoutMs: 300 });
  const host = driver.host;
  try {
    const firstPid = host.pid;
    const onTimeout = host._onTimeout;
    let info = null;
    host._onTimeout = function patched(job) {
      host._onTimeout = onTimeout;
      onTimeout.call(this, job);
      info = host.start();
    };
    await assert.rejects(host.request('clipget'), (e) => e.code === 'TIMEOUT');
    const ping = await info;
    assert.equal(ping.pong, true);
    assert.notEqual(ping.pid, firstPid, 'start() launched a fresh host');
    assert.deepEqual(await host.request('cursor'), { x: 10, y: 10 });
  } finally {
    await driver.close();
  }
});
