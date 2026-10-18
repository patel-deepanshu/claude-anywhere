'use strict';

/**
 * End to end: runDaemon() + the real MCP server (src/mcp) + the mock desktop
 * driver + test/fixtures/fake-claude.js as the engine. Skips itself while the
 * MCP server or OS layer are not present yet.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const REQUIRED = ['src/mcp/server.js', 'src/mcp/tools.js', 'src/os/index.js', 'src/os/computer.js'];
const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(ROOT, f)));
const SKIP = missing.length ? `needs ${missing.join(', ')}` : false;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-integration-'));
process.env.ANYWHERE_HOME = HOME;
process.env.ANYWHERE_DRIVER = 'mock';
delete process.env.ANYWHERE_LOG_FILE;
delete process.env.ANYWHERE_DAEMON_URL;
delete process.env.ANYWHERE_TOKEN;
delete process.env.FAKE_CLAUDE_ARGS_FILE;

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('full daemon: approval, question and screenshot through the real MCP server', { skip: SKIP, timeout: 120000 }, async () => {
  try {
    fs.chmodSync(FAKE, 0o755);
  } catch {
    /* falls back to node */
  }
  fs.writeFileSync(
    path.join(HOME, 'config.json'),
    JSON.stringify({
      port: 0,
      ui: { host: 'none', openOnStart: false },
      engine: { claudePath: FAKE, addVsCodeWorkspaces: false, resumeLast: false },
      permissions: { mode: 'ask' },
      context: { attachDesktopContext: true },
      voice: { speakResponses: false },
    })
  );
  const project = fs.mkdtempSync(path.join(HOME, 'repo-'));
  const { runDaemon } = require('../src/daemon/main');
  const { DaemonClient } = require('../src/shared/client');
  const { readDaemonState } = require('../src/shared/state');

  const d = await runDaemon({ project, open: false, handleSignals: false });
  const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${d.port}`, token: d.token });
  const events = [];
  const sub = client.subscribe((type, data) => events.push({ type, data }));
  const waitFor = async (pred, what, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    const tail = events.slice(-8).map((e) => `${e.type}:${JSON.stringify(e.data).slice(0, 120)}`).join('\n');
    throw new Error(`timed out waiting for ${what}; last events:\n${tail}`);
  };
  try {
    const st = readDaemonState();
    assert.equal(st.port, d.port);
    assert.equal(st.token, d.token);
    assert.equal(st.instanceId, d.instanceId);
    assert.equal(st.pid, process.pid);
    assert.equal(st.project, project);
    assert.equal(st.mode, 'companion');
    assert.equal(st.url, `http://127.0.0.1:${d.port}/?token=${d.token}`);
    assert.ok(st.version && st.startedAt);
    const health = await (await fetch(`http://127.0.0.1:${d.port}/api/health`)).json();
    assert.equal(health.instanceId, d.instanceId);

    const snap = await waitFor((e) => e.type === 'snapshot', 'snapshot');
    assert.equal(snap.data.project.dir, project);
    assert.equal(snap.data.platform.driver, 'mock');

    // 1. permission_prompt → approval card → POST /api/approval
    await client.request('POST', '/api/command', { text: 'APPROVE_TEST' });
    const card = await waitFor((e) => e.type === 'approval_request', 'approval_request');
    assert.equal(card.data.toolName, 'Bash');
    assert.deepEqual(card.data.input, { command: 'rm -rf build' });
    await waitFor((e) => e.type === 'status' && e.data.status === 'waiting_approval', 'waiting_approval status');
    assert.equal((await client.request('GET', '/api/state')).pending.approvals.length, 1);
    await client.request('POST', '/api/approval', { id: card.data.id, decision: 'allow' });
    const r1 = await waitFor((e) => e.type === 'result' && /DECISION/.test(e.data.text), 'approval result');
    assert.equal(r1.data.text, 'DECISION: allow');
    const bashRow = (await client.request('GET', '/api/state')).messages.find((m) => m.role === 'tool' && m.toolUseId === 'toolu_fake1');
    assert.equal(bashRow.status, 'ok');
    assert.equal(bashRow.displayName, 'Run command');

    // ... and a denial
    events.length = 0;
    await client.request('POST', '/api/command', { text: 'APPROVE_TEST again' });
    const card2 = await waitFor((e) => e.type === 'approval_request', 'second approval_request');
    await client.request('POST', '/api/approval', { id: card2.data.id, decision: 'deny', message: 'Not now' });
    const r2 = await waitFor((e) => e.type === 'result', 'deny result');
    assert.equal(r2.data.text, 'DECISION: deny');

    // 2. ask_user → question card → POST /api/answer
    events.length = 0;
    await client.request('POST', '/api/command', { text: 'ASK_TEST' });
    const q = await waitFor((e) => e.type === 'question', 'question');
    assert.equal(q.data.question, 'Pick one');
    assert.deepEqual(q.data.options, ['A', 'B']);
    await waitFor((e) => e.type === 'status' && e.data.status === 'waiting_answer', 'waiting_answer status');
    await client.request('POST', '/api/answer', { id: q.data.id, text: 'B' });
    const r3 = await waitFor((e) => e.type === 'result', 'answer result');
    assert.match(r3.data.text, /^ANSWER: .*B/);

    // 3. screenshot tool → image in the tool result → screenshot event
    events.length = 0;
    await client.request('POST', '/api/command', { text: 'SCREENSHOT_TEST' });
    const shot = await waitFor((e) => e.type === 'screenshot', 'screenshot event');
    assert.match(shot.data.dataUrl, /^data:image\/png;base64,/);
    const r4 = await waitFor((e) => e.type === 'result', 'screenshot result');
    assert.equal(r4.data.text, 'SCREENSHOT: ok');
    const state = await client.request('GET', '/api/state');
    const shotRow = state.messages.find((m) => m.role === 'tool' && m.toolUseId === 'toolu_fake_shot');
    assert.equal(shotRow.displayName, 'Screenshot');
    assert.match(shotRow.image, /^data:image\/png;base64,/);
    assert.ok(state.screenshot);
    assert.ok(state.session.costUsd > 0);

    // 4. a command with an attached screenshot from the daemon's own (lazy) Computer
    events.length = 0;
    await client.request('POST', '/api/command', { text: 'what is on screen', attachScreenshot: true });
    const r5 = await waitFor((e) => e.type === 'result', 'attached screenshot result');
    assert.equal(r5.data.text, 'Echo: what is on screen [1 image]');
    assert.ok(events.some((e) => e.type === 'screenshot'));

    // 5. shutdown over the API clears daemon.json
    await client.request('POST', '/api/shutdown');
    await d.done;
    assert.equal(readDaemonState(), null);
  } finally {
    sub.close();
    await d.shutdown('test cleanup');
  }
});

test('startDaemonProcess launches a detached daemon that stops via /api/shutdown', { skip: SKIP, timeout: 60000 }, async () => {
  const home = fs.mkdtempSync(path.join(HOME, 'detached-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 0, ui: { host: 'none' }, engine: { claudePath: FAKE } }));
  const prev = process.env.ANYWHERE_HOME;
  process.env.ANYWHERE_HOME = home;
  const { startDaemonProcess } = require('../src/daemon/main');
  const { DaemonClient } = require('../src/shared/client');
  const { readDaemonState, isPidAlive } = require('../src/shared/state');
  try {
    const st = await startDaemonProcess({ project: home, open: false });
    assert.equal(st.reused, false);
    assert.ok(isPidAlive(st.pid));
    assert.notEqual(st.pid, process.pid);
    const again = await startDaemonProcess({ project: home, open: false });
    assert.equal(again.reused, true);
    assert.equal(again.pid, st.pid);
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${st.port}`, token: st.token });
    await client.request('POST', '/api/shutdown');
    const end = Date.now() + 10000;
    while (isPidAlive(st.pid) && Date.now() < end) await sleep(50);
    assert.equal(isPidAlive(st.pid), false);
    assert.equal(readDaemonState(), null);
  } finally {
    const st = readDaemonState();
    if (st && st.pid && isPidAlive(st.pid)) {
      try {
        process.kill(st.pid);
      } catch {
        /* ignore */
      }
    }
    process.env.ANYWHERE_HOME = prev;
  }
});
