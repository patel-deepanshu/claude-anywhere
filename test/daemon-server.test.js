'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-server-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const configMod = require('../src/shared/config');
const { randomToken, sleep } = require('../src/shared/util');
const { Hub } = require('../src/daemon/hub');
const { QuestionBroker } = require('../src/daemon/questions');
const { Bridge } = require('../src/daemon/bridge');
const { SessionManager } = require('../src/daemon/session');
const { createServer, tokenMatches, validateConfigUpdate } = require('../src/daemon/server');

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

/** Engine stand-in: answers every send with a tiny turn. */
class FakeEngine extends EventEmitter {
  static async locate() {
    return { path: '/fake/claude', version: '1.0.0' };
  }

  constructor(opts) {
    super();
    this.opts = opts;
    this.resume = Boolean(opts.resume);
    this.sawInit = false;
    this.alive = false;
  }

  get running() {
    return this.alive;
  }

  start() {
    this.alive = true;
    setImmediate(() => {
      this.sawInit = true;
      this.emit('message', { type: 'system', subtype: 'init', session_id: this.opts.sessionId, model: 'm', mcp_servers: [{ name: 'anywhere', status: 'connected' }] });
    });
  }

  send(blocks) {
    const text = blocks[blocks.length - 1].text;
    setImmediate(() => {
      this.emit('message', { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: `ok ${text}` }] }, parent_tool_use_id: null });
      this.emit('message', { type: 'result', result: `ok ${text}`, total_cost_usd: 0.01, duration_ms: 5, num_turns: 1, is_error: false });
    });
  }

  async interrupt() {
    return { ok: true, killed: false };
  }

  async stop() {
    if (!this.alive) return;
    this.alive = false;
    this.emit('exit', { code: 0, signal: null, stderrTail: '', expected: true, sawInit: this.sawInit, uptimeMs: 10 });
  }
}

/** Permission broker stand-in following the contract (cards via hub events). */
class StubBroker {
  constructor(hub) {
    this.hub = hub;
    this.entries = new Map();
    this.calls = [];
    this.n = 0;
  }

  request({ tool_name: toolName, input }) {
    const id = `ap_${++this.n}`;
    return new Promise((resolve) => {
      this.entries.set(id, { resolve, input, card: { id, toolName, input } });
      this.hub.broadcast('approval_request', { id, toolName, displayName: toolName, summary: '', input, risk: 'high', reason: 'test', ts: new Date().toISOString() });
    });
  }

  resolve(id, decision, message) {
    this.calls.push({ id, decision, message });
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    this.hub.broadcast('approval_resolved', { id, decision });
    e.resolve(decision === 'deny' ? { behavior: 'deny', message: message || 'denied' } : { behavior: 'allow', updatedInput: e.input });
    return true;
  }

  cancelAll(reason) {
    for (const id of [...this.entries.keys()]) this.resolve(id, 'deny', reason);
  }

  pending() {
    return [...this.entries.values()].map((e) => e.card);
  }
}

async function setup({ uiDir, bridge: bridgeOverride } = {}) {
  const config = configMod.load();
  config.port = 0;
  config.context.attachDesktopContext = false;
  const hub = new Hub();
  const events = [];
  hub.on('event', (type, data) => events.push({ type, data }));
  const permissions = new StubBroker(hub);
  const questions = new QuestionBroker({ hub });
  const bridge = bridgeOverride || new Bridge({ hub });
  const token = randomToken();
  let shutdownCalls = 0;
  const server = createServer({
    hub,
    session: null,
    permissions,
    questions,
    bridge,
    config,
    token,
    instanceId: 'inst-1',
    version: '9.9.9',
    uiDir,
    onShutdown: () => {
      shutdownCalls += 1;
    },
  });
  const port = await server.listen(0);
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  const session = new SessionManager({
    config,
    hub,
    permissions,
    questions,
    bridge,
    port,
    token,
    projectDir,
    mode: 'companion',
    instanceId: `t-${port}`,
    Engine: FakeEngine,
    context: {},
  });
  server.session = session;
  server.deps.session = session;
  hub.setSnapshotProvider(() => session.snapshot());
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error('timed out waiting for event');
  };
  return {
    config,
    hub,
    events,
    permissions,
    questions,
    bridge,
    session,
    server,
    port,
    token,
    base,
    api,
    waitFor,
    shutdownCalls: () => shutdownCalls,
    async close() {
      await session.shutdown();
      hub.close();
      await server.close();
    },
  };
}

/** Raw HTTP request (full control over Host and the request path). */
function raw({ port, method = 'GET', path: p = '/', headers = {}, body, setHost = true }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, setHost }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('tokenMatches is constant-time and length-safe', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abd', 'abc'), false);
  assert.equal(tokenMatches('abcd', 'abc'), false);
  assert.equal(tokenMatches('', 'abc'), false);
  assert.equal(tokenMatches(undefined, 'abc'), false);
  assert.equal(tokenMatches('ü', 'ü'), true);
});

test('validateConfigUpdate checks types and enums', () => {
  assert.equal(validateConfigUpdate({ permissions: { mode: 'smart' } }), null);
  assert.match(validateConfigUpdate({ permissions: { mode: 'yolo' } }), /permissions\.mode/);
  assert.match(validateConfigUpdate({ voice: { ttsRate: 'fast' } }), /voice\.ttsRate/);
  assert.match(validateConfigUpdate({ engine: { extraArgs: [1] } }), /engine\.extraArgs/);
  assert.match(validateConfigUpdate({ port: 70000 }), /port/);
  assert.match(validateConfigUpdate({ ui: { bogus: 1 } }), /Unknown setting "ui\.bogus"/);
});

test('Host header check (DNS rebinding defense)', async () => {
  const s = await setup();
  try {
    const bad = await raw({ port: s.port, path: '/api/health', headers: { Host: `evil.example:${s.port}` } });
    assert.equal(bad.status, 403);
    assert.deepEqual(Object.keys(JSON.parse(bad.body)), ['error']);
    const wrongPort = await raw({ port: s.port, path: '/api/health', headers: { Host: '127.0.0.1:1' } });
    assert.equal(wrongPort.status, 403);
    // Node's parser already rejects HTTP/1.1 requests without Host (400); either way it is refused.
    const none = await raw({ port: s.port, path: '/api/health', setHost: false });
    assert.ok(none.status === 403 || none.status === 400, `no Host → ${none.status}`);
    const local = await raw({ port: s.port, path: '/api/health', headers: { Host: `localhost:${s.port}` } });
    assert.equal(local.status, 200);
    const ip = await raw({ port: s.port, path: '/api/health' });
    assert.equal(ip.status, 200);
    const staticBad = await raw({ port: s.port, path: '/', headers: { Host: `attacker.test:${s.port}` } });
    assert.equal(staticBad.status, 403);
  } finally {
    await s.close();
  }
});

test('health needs no token and reports the instance', async () => {
  const s = await setup();
  try {
    const res = await fetch(`${s.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, app: 'claude-anywhere', version: '9.9.9', instanceId: 'inst-1', pid: process.pid });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.close();
  }
});

const realNow = Date.now.bind(Date);

test('SECURITY-7: launch URLs carry a single-use code that expires after 60 s', async (t) => {
  const s = await setup();
  try {
    const url = s.server.launchUrl();
    const m = new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/\\?launch=([A-Za-z0-9_-]{24})$`).exec(url);
    assert.ok(m, url);
    assert.ok(!url.includes(s.token), 'no token on the command line');
    const code = m[1];
    const post = (body, headers = {}) =>
      fetch(`${s.base}/api/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    // A foreign page cannot trade a code (Origin check), and does not use it up.
    assert.equal((await post({ code }, { Origin: 'http://evil.example' })).status, 403);
    const first = await post({ code });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { token: s.token });
    const again = await post({ code });
    assert.equal(again.status, 401, 'single use');
    assert.equal((await again.json()).token, undefined);
    assert.equal((await post({ code: 'nope' })).status, 401);
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ code: 42 })).status, 401);
    // Expired codes are refused (and removed).
    const late = new URL(s.server.launchUrl()).searchParams.get('launch');
    t.mock.method(Date, 'now', () => realNow() + 61000);
    assert.equal((await post({ code: late })).status, 401);
    t.mock.restoreAll();
    assert.equal(s.server.launchCodes.has(late), false);
    // Each call mints a different code.
    assert.notEqual(s.server.launchUrl(), s.server.launchUrl());
  } finally {
    await s.close();
  }
});

test('GET /api/permissions reports the driver\'s permission state (MACOS-2)', async () => {
  const s = await setup();
  try {
    assert.deepEqual((await s.api('GET', '/api/permissions')).json, { platform: process.platform, permissions: null });
    s.server.deps.getDriver = async () => ({ capabilities: async () => ({ permissions: { accessibility: true, screenRecording: false, automation: null } }) });
    const r = await s.api('GET', '/api/permissions');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.permissions, { accessibility: true, screenRecording: false, automation: null });
    s.server.deps.getDriver = async () => ({
      capabilities: async () => {
        throw new Error('helper died');
      },
    });
    assert.equal((await s.api('GET', '/api/permissions')).json.permissions, null);
    assert.equal((await s.api('GET', '/api/permissions', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  } finally {
    await s.close();
  }
});

test('token is required on /api/* and accepted from the right places', async () => {
  const s = await setup();
  try {
    const noTok = await fetch(`${s.base}/api/state`);
    assert.equal(noTok.status, 401);
    assert.ok((await noTok.json()).error);
    const sameLen = 'x'.repeat(s.token.length);
    assert.equal((await fetch(`${s.base}/api/state`, { headers: { Authorization: `Bearer ${sameLen}` } })).status, 401);
    assert.equal((await fetch(`${s.base}/api/state`, { headers: { Authorization: 'Bearer short' } })).status, 401);
    assert.equal((await fetch(`${s.base}/api/state`, { headers: { Authorization: `Bearer ${s.token}` } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/state`, { headers: { 'X-Anywhere-Token': s.token } })).status, 200);
    // ?token= only works for the SSE stream
    assert.equal((await fetch(`${s.base}/api/state?token=${encodeURIComponent(s.token)}`)).status, 401);
    // unknown API paths reveal nothing without a token
    assert.equal((await fetch(`${s.base}/api/nope`)).status, 401);
    const nf = await s.api('GET', '/api/nope');
    assert.equal(nf.status, 404);
    assert.deepEqual(Object.keys(nf.json), ['error']);
    const wrongMethod = await s.api('GET', '/api/command');
    assert.equal(wrongMethod.status, 405);
  } finally {
    await s.close();
  }
});

test('Origin check on non-GET requests', async () => {
  const s = await setup();
  try {
    const evil = await s.api('POST', '/api/interrupt', {}, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const nullOrigin = await s.api('POST', '/api/interrupt', {}, { Origin: 'null' });
    assert.equal(nullOrigin.status, 403);
    const otherPort = await s.api('POST', '/api/interrupt', {}, { Origin: 'http://127.0.0.1:1' });
    assert.equal(otherPort.status, 403);
    const own = await s.api('POST', '/api/interrupt', {}, { Origin: `http://127.0.0.1:${s.port}` });
    assert.equal(own.status, 200);
    const ownLocal = await s.api('POST', '/api/interrupt', {}, { Origin: `http://localhost:${s.port}` });
    assert.equal(ownLocal.status, 200);
    const noOrigin = await s.api('POST', '/api/interrupt');
    assert.equal(noOrigin.status, 200);
    const getForeign = await s.api('GET', '/api/state', undefined, { Origin: 'https://evil.example' });
    assert.equal(getForeign.status, 200);
  } finally {
    await s.close();
  }
});

test('body validation: bad JSON, wrong content type, oversized body', async () => {
  const s = await setup();
  try {
    const bad = await raw({
      port: s.port,
      method: 'POST',
      path: '/api/command',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.body).error, /Invalid JSON/);
    const form = await raw({
      port: s.port,
      method: 'POST',
      path: '/api/command',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'text/plain' },
      body: '{"text":"hi"}',
    });
    assert.equal(form.status, 415);
    const arr = await s.api('POST', '/api/command', ['x']);
    assert.equal(arr.status, 400);
    const big = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/command', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json', 'Content-Length': 30 * 1024 * 1024 } },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }
      );
      req.on('error', reject);
      req.write('{"text":"');
    });
    assert.equal(big.status, 413);
    const empty = await s.api('POST', '/api/command', { text: '   ' });
    assert.equal(empty.status, 400);
  } finally {
    await s.close();
  }
});

test('static files: index, MIME types, CSP, traversal protection', async () => {
  const ui = fs.mkdtempSync(path.join(HOME, 'ui-'));
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>Claude Anywhere</title>');
  fs.writeFileSync(path.join(ui, 'app.js'), 'export {};');
  fs.writeFileSync(path.join(ui, 'app.css'), 'body{}');
  fs.writeFileSync(path.join(ui, 'icon.svg'), '<svg/>');
  fs.writeFileSync(path.join(ui, 'a.png'), Buffer.from([0x89, 0x50]));
  fs.writeFileSync(path.join(ui, 'm.json'), '{}');
  fs.writeFileSync(path.join(ui, 'favicon.ico'), Buffer.from([0]));
  fs.writeFileSync(path.join(ui, 'site.webmanifest'), '{}');
  fs.writeFileSync(path.join(ui, '.secret'), 'nope');
  fs.mkdirSync(path.join(ui, 'sub'));
  fs.writeFileSync(path.join(HOME, 'outside.txt'), 'TOP SECRET');
  try {
    fs.symlinkSync(path.join(HOME, 'outside.txt'), path.join(ui, 'link.txt'));
  } catch {
    /* symlinks may be unavailable (Windows without privilege) */
  }
  const s = await setup({ uiDir: ui });
  try {
    const index = await raw({ port: s.port, path: '/?token=abc' });
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /^text\/html/);
    assert.match(index.headers['content-security-policy'], /default-src 'self'/);
    assert.match(index.headers['content-security-policy'], /script-src 'self'/);
    assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['referrer-policy'], 'no-referrer');
    assert.equal(index.headers['cache-control'], 'no-store');
    const types = {
      '/app.js': /^text\/javascript/,
      '/app.css': /^text\/css/,
      '/icon.svg': /^image\/svg\+xml/,
      '/a.png': /^image\/png/,
      '/m.json': /^application\/json/,
      '/favicon.ico': /^image\/x-icon/,
      '/site.webmanifest': /^application\/manifest\+json/,
    };
    for (const [p, re] of Object.entries(types)) {
      const r = await raw({ port: s.port, path: p });
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], re, p);
    }
    for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/..%5coutside.txt', '/sub/../../outside.txt', '/C:/Windows/win.ini']) {
      const r = await raw({ port: s.port, path: p });
      assert.ok(r.status === 403 || r.status === 404, `${p} → ${r.status}`);
      assert.doesNotMatch(r.body, /TOP SECRET/, p);
    }
    assert.equal((await raw({ port: s.port, path: '/.secret' })).status, 404);
    assert.equal((await raw({ port: s.port, path: '/sub' })).status, 404);
    assert.equal((await raw({ port: s.port, path: '/missing.js' })).status, 404);
    assert.equal((await raw({ port: s.port, path: '/bad%zzpath' })).status, 400);
    assert.equal((await raw({ port: s.port, path: '/app.js', method: 'POST', body: '' })).status, 405);
    if (fs.existsSync(path.join(ui, 'link.txt'))) {
      const link = await raw({ port: s.port, path: '/link.txt' });
      assert.equal(link.status, 403);
      assert.doesNotMatch(link.body, /TOP SECRET/);
    }
    const head = await raw({ port: s.port, path: '/app.js', method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  } finally {
    await s.close();
  }
});

test('missing UI files fall back to a help page', async () => {
  const s = await setup({ uiDir: path.join(HOME, 'no-such-ui') });
  try {
    const r = await raw({ port: s.port, path: '/' });
    assert.equal(r.status, 200);
    assert.match(r.body, /Claude Anywhere/);
    assert.match(r.body, /anywhere tui/);
  } finally {
    await s.close();
  }
});

test('config round trip masks the secret and validates', async () => {
  const s = await setup();
  try {
    const saved = await s.api('POST', '/api/config', { voice: { sttApiKey: 'gsk_supersecretvalue1234567890', language: 'de-DE' }, bogusTop: 1 });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.voice.sttApiKey, '');
    assert.equal(saved.json.voice.sttApiKeySet, true);
    assert.equal(saved.json.voice.language, 'de-DE');
    assert.equal(saved.json.bogusTop, undefined);
    const got = await s.api('GET', '/api/config');
    assert.equal(got.json.voice.sttApiKey, '');
    assert.equal(got.json.voice.sttApiKeySet, true);
    const onDisk = JSON.parse(fs.readFileSync(require('../src/shared/paths').configPath(), 'utf8'));
    assert.equal(onDisk.voice.sttApiKey, 'gsk_supersecretvalue1234567890');
    // Round-tripping the public config must not wipe the key.
    const again = await s.api('POST', '/api/config', got.json);
    assert.equal(again.status, 200);
    assert.equal(configMod.load().voice.sttApiKey, 'gsk_supersecretvalue1234567890');
    assert.equal(s.config.voice.language, 'de-DE');
    const bad = await s.api('POST', '/api/config', { permissions: { mode: 'yolo' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /permissions\.mode/);
    const evt = s.events.filter((e) => e.type === 'config').pop();
    assert.equal(evt.data.voice.sttApiKey, '');
    const snap = await s.api('GET', '/api/state');
    assert.equal(snap.json.config.voice.sttApiKey, '');
  } finally {
    await s.close();
  }
});

test('SSE stream starts with retry and a snapshot', async () => {
  const s = await setup();
  try {
    const text = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: s.port, path: `/api/events?token=${encodeURIComponent(s.token)}` }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^text\/event-stream/);
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (/event: snapshot\ndata: .*\n\n/.test(buf)) {
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    });
    assert.ok(text.startsWith('retry: 2000\n\n'));
    const m = text.match(/event: snapshot\ndata: (.*)\n\n/);
    const snap = JSON.parse(m[1]);
    for (const k of ['version', 'mode', 'status', 'statusDetail', 'project', 'session', 'messages', 'pending', 'config', 'voice', 'bridge', 'platform', 'screenshot']) {
      assert.ok(k in snap, `snapshot.${k}`);
    }
    assert.equal(snap.mode, 'companion');
    assert.deepEqual(snap.pending, { approvals: [], questions: [] });
    assert.equal(snap.config.voice.sttApiKey, '');
    // without the token the stream is refused
    assert.equal((await fetch(`${s.base}/api/events`)).status, 401);
  } finally {
    await s.close();
  }
});

test('command → result events; interrupt pauses the guard', async () => {
  const s = await setup();
  try {
    const r = await s.api('POST', '/api/command', { text: 'hello', source: 'voice' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(r.json.id);
    const result = await s.waitFor((e) => e.type === 'result');
    assert.equal(result.data.text, 'ok hello');
    const g1 = await s.api('GET', '/api/mcp/guard');
    assert.deepEqual(g1.json, { allowed: true });
    await s.api('POST', '/api/interrupt');
    const g2 = await s.api('GET', '/api/mcp/guard');
    assert.equal(g2.json.allowed, false);
    assert.match(g2.json.reason, /Stop/);
  } finally {
    await s.close();
  }
});

test('approval endpoint resolves cards; unknown ids are 404', async () => {
  const s = await setup();
  try {
    const pending = s.api('POST', '/api/mcp/permission', { tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 't1' });
    const req = await s.waitFor((e) => e.type === 'approval_request');
    const snap = await s.api('GET', '/api/state');
    assert.equal(snap.json.pending.approvals.length, 1);
    assert.equal((await s.api('POST', '/api/approval', { id: req.data.id, decision: 'maybe' })).status, 400);
    assert.equal((await s.api('POST', '/api/approval', { id: 'nope', decision: 'allow' })).status, 404);
    assert.equal((await s.api('POST', '/api/approval', { id: req.data.id, decision: 'allow' })).status, 200);
    const out = await pending;
    assert.deepEqual(out.json, { behavior: 'allow', updatedInput: { command: 'rm -rf build' } });
  } finally {
    await s.close();
  }
});

test('a disconnected permission request cancels its card', async () => {
  const s = await setup();
  try {
    const ac = new AbortController();
    const p = fetch(`${s.base}/api/mcp/permission`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Bash', input: { command: 'deploy' }, tool_use_id: 't2' }),
      signal: ac.signal,
    }).catch((e) => e);
    const req = await s.waitFor((e) => e.type === 'approval_request');
    ac.abort();
    await p;
    const resolved = await s.waitFor((e) => e.type === 'approval_resolved' && e.data.id === req.data.id);
    assert.ok(resolved);
    assert.equal(s.permissions.pending().length, 0);
    assert.equal(s.permissions.calls[0].decision, 'deny');
    assert.match(s.permissions.calls[0].message, /Cancelled/);
  } finally {
    await s.close();
  }
});

test('ask_user: answer, timeout and disconnect', async () => {
  const s = await setup();
  try {
    const p = s.api('POST', '/api/mcp/ask', { question: 'Pick one', options: ['A', 'B'] });
    const q = await s.waitFor((e) => e.type === 'question');
    assert.deepEqual(q.data.options, ['A', 'B']);
    assert.equal((await s.api('POST', '/api/answer', { id: 'nope', text: 'x' })).status, 404);
    assert.equal((await s.api('POST', '/api/answer', { id: q.data.id, text: 'B' })).status, 200);
    assert.equal((await p).json.answer, 'B');

    const t = await s.api('POST', '/api/mcp/ask', { question: 'Quick?', timeoutSec: 0.05 });
    assert.equal(t.json.timeout, true);

    const ac = new AbortController();
    const pa = fetch(`${s.base}/api/mcp/ask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Still there?' }),
      signal: ac.signal,
    }).catch((e) => e);
    const q2 = await s.waitFor((e) => e.type === 'question' && e.data.question === 'Still there?');
    ac.abort();
    await pa;
    const r2 = await s.waitFor((e) => e.type === 'question_resolved' && e.data.id === q2.data.id);
    assert.equal(r2.data.cancelled, true);
    assert.equal(s.questions.pending().length, 0);
    assert.equal((await s.api('POST', '/api/mcp/ask', { question: '' })).status, 400);
  } finally {
    await s.close();
  }
});

test('notify and activity endpoints', async () => {
  const s = await setup();
  try {
    const n = await s.api('POST', '/api/mcp/notify', { message: 'Deployed', level: 'success', speak: true });
    assert.equal(n.json.ok, true);
    assert.equal(n.json.delivered, false); // no SSE client connected and no OS notifier injected
    const ev = await s.waitFor((e) => e.type === 'notify');
    assert.deepEqual(ev.data, { text: 'Deployed', level: 'success', speak: true });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000100000000c08060000001ff3ff61', 'hex').toString('base64');
    const a = await s.api('POST', '/api/mcp/activity', { tool: 'screenshot', image: png, width: 16, height: 12 });
    assert.equal(a.json.ok, true);
    const shot = await s.waitFor((e) => e.type === 'screenshot');
    assert.match(shot.data.dataUrl, /^data:image\/png;base64,/);
    assert.equal(shot.data.width, 16);
    // companion mode: no tool rows from activity
    const snap = await s.api('GET', '/api/state');
    assert.equal(snap.json.messages.filter((m) => m.role === 'tool').length, 0);
    assert.ok(snap.json.screenshot);
  } finally {
    await s.close();
  }
});

test('bridge listen/reply, timeout, stop, and no loss on disconnect', async () => {
  const s = await setup();
  try {
    await s.api('POST', '/api/mode', { mode: 'bridge' });
    assert.equal((await s.api('POST', '/api/mode', { mode: 'nope' })).status, 400);
    const t = await s.api('POST', '/api/bridge/listen', { timeoutSec: 1 });
    assert.deepEqual(t.json, { timeout: true });

    // A listener that disconnects while waiting must not swallow the next command.
    const ac = new AbortController();
    const pl = fetch(`${s.base}/api/bridge/listen`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeoutSec: 30 }),
      signal: ac.signal,
    }).catch((e) => e);
    await sleep(100);
    assert.equal(s.bridge.waiters.size, 1);
    ac.abort();
    await pl;
    await sleep(100);
    assert.equal(s.bridge.waiters.size, 0);
    const c = await s.api('POST', '/api/command', { text: 'deploy it' });
    await s.session.drain();
    assert.equal(s.bridge.queueLength(), 1);

    const got = await s.api('POST', '/api/bridge/listen', { timeoutSec: 5 });
    assert.equal(got.json.command.id, c.json.id);
    assert.equal(got.json.command.text, 'deploy it');
    assert.deepEqual(got.json.command.images, []);
    assert.equal(got.json.command.source, 'text');
    assert.equal(typeof got.json.command.context, 'string');
    assert.equal((await s.api('GET', '/api/state')).json.bridge.listening, true);

    await s.api('POST', '/api/bridge/reply', { text: 'Working on it', speak: false });
    await s.api('POST', '/api/bridge/reply', { text: 'Done: deployed.', final: true });
    const result = await s.waitFor((e) => e.type === 'result');
    assert.equal(result.data.text, 'Done: deployed.');
    const msgs = (await s.api('GET', '/api/state')).json.messages.filter((m) => m.role === 'assistant').map((m) => m.text);
    assert.deepEqual(msgs, ['Working on it', 'Done: deployed.']);

    await s.api('POST', '/api/mode', { mode: 'companion' });
    const stop = await s.api('POST', '/api/bridge/listen', { timeoutSec: 5 });
    assert.deepEqual(stop.json, { stop: true });
  } finally {
    await s.close();
  }
});

test('bridge reply after the switch to companion mode is refused with 409; questions keep a working terminal connected', async () => {
  const s = await setup();
  try {
    await s.api('POST', '/api/mode', { mode: 'bridge' });
    await s.api('POST', '/api/command', { text: 'long deploy' });
    await s.session.drain();
    const got = await s.api('POST', '/api/bridge/listen', { timeoutSec: 5 });
    assert.equal(got.json.command.text, 'long deploy');
    // A question from the terminal counts as a sign of life.
    s.bridge.lastPollAt = 1;
    const ask = s.api('POST', '/api/mcp/ask', { question: 'Which region?', timeoutSec: 0.2 });
    await sleep(50);
    assert.ok(Date.now() - s.bridge.lastPollAt < 1000);
    await ask;

    await s.api('POST', '/api/mode', { mode: 'companion' });
    const r = await s.api('POST', '/api/bridge/reply', { text: 'Done', final: true });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Bridge mode is off/);
    assert.ok(r.json.hint);
    const snap = (await s.api('GET', '/api/state')).json;
    assert.ok(!snap.messages.some((m) => m.role === 'assistant' && m.text === 'Done'));
  } finally {
    await s.close();
  }
});

test('a command dequeued for a closed listen request is re-enqueued at the front', async () => {
  // Simulates the race: the command is handed out just as the listener goes away.
  class RacyBridge extends Bridge {
    next(timeoutMs, { signal } = {}) {
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          const cmd = this.queue.shift();
          resolve(cmd || null);
        });
      });
    }
  }
  const hubless = new RacyBridge({});
  const s = await setup({ bridge: hubless });
  try {
    hubless.resume();
    hubless.enqueue({ id: 'second', text: 'b' });
    hubless.queue.unshift({ id: 'first', text: 'a', images: [], context: '', source: 'text' });
    const ac = new AbortController();
    const pl = fetch(`${s.base}/api/bridge/listen`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: ac.signal,
    }).catch((e) => e);
    await sleep(100);
    ac.abort();
    await pl;
    await sleep(150);
    assert.deepEqual(hubless.queue.map((c) => c.id), ['first', 'second']);
  } finally {
    await s.close();
  }
});

test('session/new, project and shutdown endpoints', async () => {
  const s = await setup();
  try {
    const before = (await s.api('GET', '/api/state')).json.session.id;
    const n = await s.api('POST', '/api/session/new');
    assert.equal(n.json.ok, true);
    assert.notEqual(n.json.sessionId, before);
    const bad = await s.api('POST', '/api/project', { dir: path.join(HOME, 'does-not-exist') });
    assert.equal(bad.status, 400);
    const dir = fs.mkdtempSync(path.join(HOME, 'other-'));
    const ok = await s.api('POST', '/api/project', { dir });
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.project.dir, path.resolve(dir));
    const projects = await s.api('GET', '/api/projects');
    assert.equal(projects.json.projects[0].dir, path.resolve(dir));
    assert.equal(projects.json.projects[0].current, true);
    const ctx = await s.api('GET', '/api/context');
    assert.equal(ctx.status, 200);
    const stt = await raw({ port: s.port, method: 'POST', path: '/api/stt', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'audio/wav' }, body: 'RIFF' });
    assert.equal(stt.status, 503);
    const show = await s.api('POST', '/api/show');
    assert.equal(show.json.host, 'none');
    const down = await s.api('POST', '/api/shutdown');
    assert.deepEqual(down.json, { ok: true });
    await sleep(50);
    assert.equal(s.shutdownCalls(), 1);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ main.js pieces

test('parseDaemonArgs', () => {
  const { parseDaemonArgs } = require('../src/daemon/main');
  assert.deepEqual(parseDaemonArgs(['--project', '/x y', '--mode', 'bridge', '--ui=tui', '--no-open', '--port', '0']), {
    open: false,
    project: '/x y',
    mode: 'bridge',
    ui: 'tui',
    port: 0,
  });
  assert.deepEqual(parseDaemonArgs([]), { open: true });
  assert.throws(() => parseDaemonArgs(['--port', '99999']), /port/);
  assert.throws(() => parseDaemonArgs(['--project']), /needs a value/);
});

test('createLazyDriver creates the driver on first use only', async () => {
  const { createLazyDriver } = require('../src/daemon/main');
  let created = 0;
  const lazy = createLazyDriver(async () => {
    created += 1;
    return { name: 'x', cursorPosition: async () => ({ x: 1, y: 2 }) };
  }, ['cursorPosition', 'click']);
  assert.equal(created, 0);
  assert.deepEqual(await lazy.cursorPosition(), { x: 1, y: 2 });
  assert.equal(created, 1);
  await assert.rejects(lazy.click(1, 2), (err) => err.code === 'UNSUPPORTED');
});

test('optionalRequire degrades instead of throwing', () => {
  const { optionalRequire } = require('../src/daemon/main');
  assert.equal(optionalRequire('./definitely-not-here'), null);
  assert.equal(optionalRequire('./hub', ['NoSuchExport']), null);
  assert.ok(optionalRequire('./hub', ['Hub']).Hub);
});

test('BasicPermissionBroker (fallback) asks for everything but read-only tools', async () => {
  const { BasicPermissionBroker } = require('../src/daemon/main');
  const hub = new Hub();
  const events = [];
  hub.on('event', (t, d) => events.push([t, d]));
  let attention = 0;
  const config = configMod.load();
  config.permissions.approvalTimeoutSec = 0.05;
  const b = new BasicPermissionBroker({ config, hub, onNeedAttention: () => (attention += 1) });
  try {
    assert.deepEqual(await b.request({ tool_name: 'mcp__anywhere__screenshot', input: {} }), { behavior: 'allow', updatedInput: {} });
    const p = b.request({ tool_name: 'Bash', input: { command: 'rm -rf build' } });
    const card = events.find(([t]) => t === 'approval_request')[1];
    assert.equal(card.displayName, 'Run command');
    assert.equal(card.summary, 'rm -rf build');
    assert.equal(attention, 1);
    assert.equal(b.pending().length, 1);
    assert.equal(b.resolve(card.id, 'bogus'), false);
    assert.equal(b.resolve(card.id, 'allow_session'), true);
    assert.deepEqual(await p, { behavior: 'allow', updatedInput: { command: 'rm -rf build' } });
    // the session rule now allows Bash without a card
    assert.equal((await b.request({ tool_name: 'Bash', input: { command: 'ls' } })).behavior, 'allow');
    const t = await b.request({ tool_name: 'Write', input: { file_path: '/x' } });
    assert.equal(t.behavior, 'deny');
    assert.match(t.message, /No response from the user/);
    const c = b.request({ tool_name: 'Edit', input: {} });
    b.cancelAll('Interrupted by user');
    assert.deepEqual(await c, { behavior: 'deny', message: 'Interrupted by user' });
    assert.ok(events.some(([t2, d]) => t2 === 'approval_resolved' && d.decision === 'deny'));
  } finally {
    hub.close();
  }
});

test('runDaemon falls back to a free port when busy, writes and clears daemon.json', async () => {
  const net = require('net');
  const { runDaemon } = require('../src/daemon/main');
  const { readDaemonState } = require('../src/shared/state');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  const project = fs.mkdtempSync(path.join(HOME, 'rd-'));
  const d = await runDaemon({ project, port: busy, open: false, handleSignals: false, allowMultiple: true });
  try {
    assert.notEqual(d.port, busy);
    const st = readDaemonState();
    assert.equal(st.port, d.port);
    assert.equal(st.pid, process.pid);
    assert.equal(st.project, project);
    assert.equal(st.mode, 'companion');
    assert.equal(st.url, `http://127.0.0.1:${d.port}/?token=${d.token}`);
    for (const k of ['token', 'instanceId', 'version', 'startedAt']) assert.ok(st[k], k);
    const health = await (await fetch(`http://127.0.0.1:${d.port}/api/health`)).json();
    assert.equal(health.instanceId, d.instanceId);
    // mode and project changes are reflected in daemon.json
    await fetch(`http://127.0.0.1:${d.port}/api/mode`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bridge' }),
    });
    assert.equal(readDaemonState().mode, 'bridge');
  } finally {
    await d.shutdown('test');
    blocker.close();
  }
  assert.equal(readDaemonState(), null);
});
