'use strict';

/**
 * PermissionBroker and VoiceService wired into the real Hub and HTTP server.
 * Skips itself while the hub/server modules are not present yet.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-policy-int-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

function tryRequire(p) {
  try {
    return require(p);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

const hubMod = tryRequire('../src/daemon/hub');
const serverMod = tryRequire('../src/daemon/server');
const mainMod = tryRequire('../src/daemon/main');
const { PermissionBroker } = require('../src/daemon/permissions');
const { VoiceService } = require('../src/daemon/voice');
const promptMod = require('../src/daemon/prompt');
const configMod = require('../src/shared/config');
const { randomToken, sleep } = require('../src/shared/util');

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

const OK = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: null };

async function setup(t, { voice } = {}) {
  if (!hubMod || !serverMod) {
    t.skip('src/daemon/hub.js or server.js is not available yet');
    return null;
  }
  const config = configMod.load();
  config.permissions.mode = 'smart';
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  const hub = new hubMod.Hub();
  const events = [];
  hub.on('event', (type, data) => events.push({ type, data }));
  const attention = [];
  const permissions = new PermissionBroker({ config, hub, onNeedAttention: (i) => attention.push(i), projectDir, audit: () => {} });
  const token = randomToken();
  const sessionStub = { snapshot: () => ({}), projectDir, guard: () => ({ allowed: true }) };
  const server = serverMod.createServer({
    hub,
    session: sessionStub,
    permissions,
    questions: { pending: () => [], ask: async () => ({ timeout: true }), answer: () => false, cancelAll() {} },
    bridge: null,
    config,
    token,
    instanceId: 'policy-int',
    version: '0.0.0-test',
    voice,
  });
  const port = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body, { signal, raw, contentType } = {}) => {
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (raw) {
      payload = raw;
      headers['Content-Type'] = contentType || 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(base + p, { method, headers, body: payload, signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error('timed out waiting for an event');
  };
  t.after(async () => {
    permissions.close();
    await server.close();
    hub.close();
  });
  return { config, hub, events, permissions, server, api, waitFor, projectDir, attention };
}

test('main.js loads the policy modules through optionalRequire', (t) => {
  if (!mainMod || typeof mainMod.optionalRequire !== 'function') return t.skip('src/daemon/main.js is not available');
  assert.ok(mainMod.optionalRequire('./permissions', ['PermissionBroker']));
  assert.ok(mainMod.optionalRequire('./voice', ['VoiceService']));
  assert.ok(mainMod.optionalRequire('./prompt', ['buildSystemPrompt']));
  assert.equal(typeof promptMod.buildSystemPrompt({}), 'string');
});

test('POST /api/mcp/permission: policy allow, approval card, allow_session', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { api, waitFor, permissions, attention } = ctx;

  const quick = await api('POST', '/api/mcp/permission', { tool_name: 'Bash', input: { command: 'ls -la' }, tool_use_id: 'a' });
  assert.equal(quick.status, 200);
  assert.deepEqual(quick.json, { behavior: 'allow', updatedInput: { command: 'ls -la' } });

  const pending = api('POST', '/api/mcp/permission', {
    tool_name: 'Bash',
    input: { command: 'gcloud run deploy api --source .' },
    tool_use_id: 'b',
  });
  const req = await waitFor((e) => e.type === 'approval_request');
  assert.equal(req.data.risk, 'high');
  assert.equal(req.data.summary, 'Run: gcloud run deploy api --source .');
  assert.ok(ctx.events.some((e) => e.type === 'status' && e.data.status === 'waiting_approval'));
  assert.equal(attention.length, 1);
  const ok = await api('POST', '/api/approval', { id: req.data.id, decision: 'allow_session' });
  assert.equal(ok.status, 200);
  const res = await pending;
  assert.deepEqual(res.json, { behavior: 'allow', updatedInput: { command: 'gcloud run deploy api --source .' } });
  // Round 3 (HEADLINE-SCENARIO-2): the rule covers redeploying this service, not all of `gcloud run`.
  assert.deepEqual(permissions.getSessionRules(), ['Bash(gcloud run deploy api*)']);

  const again = await api('POST', '/api/mcp/permission', { tool_name: 'Bash', input: { command: 'gcloud run deploy api --region us-east1' } });
  assert.equal(again.json.behavior, 'allow');

  const denied = api('POST', '/api/mcp/permission', { tool_name: 'Bash', input: { command: 'rm -rf ~' } });
  const crit = await waitFor((e) => e.type === 'approval_request' && e.data.risk === 'critical');
  await api('POST', '/api/approval', { id: crit.data.id, decision: 'deny', message: 'never do that' });
  assert.deepEqual((await denied).json, { behavior: 'deny', message: 'User denied: never do that' });
  assert.equal((await api('POST', '/api/approval', { id: crit.data.id, decision: 'allow' })).status, 404);
});

test('a disconnected permission request cancels its card', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { api, waitFor, permissions } = ctx;
  const ac = new AbortController();
  const pending = api(
    'POST',
    '/api/mcp/permission',
    { tool_name: 'Bash', input: { command: 'git push --force' } },
    { signal: ac.signal },
  ).catch((e) => e);
  const req = await waitFor((e) => e.type === 'approval_request');
  ac.abort();
  await pending;
  await waitFor((e) => e.type === 'approval_resolved' && e.data.id === req.data.id);
  for (let i = 0; i < 100 && permissions.pending().length; i += 1) await sleep(10);
  assert.equal(permissions.pending().length, 0);
});

test('/api/stt and /api/tts use the VoiceService', async (t) => {
  const seen = [];
  const stt = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'open the console' }));
  });
  await new Promise((r) => stt.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => stt.close(r)));
  const calls = [];
  const voice = new VoiceService({
    config: { voice: { sttBaseUrl: `http://127.0.0.1:${stt.address().port}/v1`, language: 'en-US' } },
    env: {},
    which: (n) => (n === 'espeak-ng' ? '/usr/bin/espeak-ng' : null),
    runner: async (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts.input });
      return OK;
    },
    platformInfo: { platform: 'linux' },
  });
  const ctx = await setup(t, { voice });
  if (!ctx) return;
  const { api } = ctx;
  const wav = Buffer.alloc(64);
  wav.write('RIFF', 0, 'ascii');
  wav.write('WAVE', 8, 'ascii');
  const r = await api('POST', '/api/stt?language=en-US', undefined, { raw: wav, contentType: 'audio/wav' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { text: 'open the console', provider: 'custom' });
  assert.equal(seen.length, 1);
  assert.match(seen[0].headers['content-type'], /multipart\/form-data/);

  const s = await api('POST', '/api/tts', { text: '**Done.** Deployed.' });
  assert.equal(s.status, 200);
  assert.deepEqual(s.json, { ok: true, provider: 'espeak-ng' });
  assert.equal(calls[0].cmd, '/usr/bin/espeak-ng');
  assert.equal(calls[0].input, 'Done. Deployed.');
  assert.equal((await api('POST', '/api/tts/stop', {})).status, 200);
});
