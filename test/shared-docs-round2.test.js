'use strict';

// Round-2 regression tests for the shared-docs fix group:
// - LIFECYCLE-11: a DaemonClient built from daemon.json follows a restarted daemon (new token,
//   maybe a new port) instead of retrying the old URL and token forever;
// - WINDOWS-2-1: shell scripts must reach users with LF line endings, cmd scripts with CRLF;
// - JOURNEYS-DOCS-*: SECURITY.md and PLATFORMS.md describe what the code really does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-shared-docs-r2-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;
delete process.env.ANYWHERE_DAEMON_URL;
delete process.env.ANYWHERE_TOKEN;

const { DaemonClient } = require('../src/shared/client');
const { writeDaemonState, clearDaemonState } = require('../src/shared/state');

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    }),
  ]);
}

/**
 * A minimal daemon: /api/health, token-checked /api/events (sends a snapshot on connect) and
 * any other token-checked path, which answers {ok, instanceId}. `rotate()` simulates a restart
 * on the same port (new token and instance id).
 */
function fakeDaemon({ token, instanceId }) {
  const streams = new Set();
  const d = { token, instanceId, hits: [], delay401: 0 };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/health') {
      json(res, 200, { app: 'claude-anywhere', instanceId: d.instanceId });
      return;
    }
    const authed = req.headers.authorization === `Bearer ${d.token}` || url.searchParams.get('token') === d.token;
    if (!authed) {
      setTimeout(() => json(res, 401, { error: 'Unauthorized' }), d.delay401 || 0);
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ instanceId: d.instanceId })}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      d.hits.push({ method: req.method, path: url.pathname, body });
      json(res, 200, { ok: true, instanceId: d.instanceId });
    });
  });
  d.rotate = (next) => {
    d.token = next.token;
    d.instanceId = next.instanceId;
    for (const s of streams) s.end();
  };
  d.writeState = () => writeDaemonState({ pid: process.pid, port: d.port, token: d.token, instanceId: d.instanceId });
  d.close = () =>
    new Promise((resolve) => {
      for (const s of streams) s.end();
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      d.port = server.address().port;
      resolve(d);
    });
  });
}

// ------------------------------------------------------------------ LIFECYCLE-11

test('DaemonClient.connect marks daemon.json clients; env-provided clients stay fixed', async (t) => {
  const a = await fakeDaemon({ token: 'tok-a', instanceId: 'inst-a' });
  t.after(async () => {
    clearDaemonState();
    await a.close();
  });
  a.writeState();
  const c = await DaemonClient.connect();
  assert.ok(c);
  assert.equal(c.fromState, true);
  assert.equal(c.baseUrl, `http://127.0.0.1:${a.port}`);

  process.env.ANYWHERE_DAEMON_URL = `http://127.0.0.1:${a.port}`;
  process.env.ANYWHERE_TOKEN = 'tok-a';
  try {
    const e = await DaemonClient.connect();
    assert.equal(e.fromState, false);
    assert.equal(await e.refresh(), null);
  } finally {
    delete process.env.ANYWHERE_DAEMON_URL;
    delete process.env.ANYWHERE_TOKEN;
  }
  assert.equal(new DaemonClient({ baseUrl: 'http://127.0.0.1:1', token: 'x' }).fromState, false);
});

test('request() follows a daemon restarted on another port (old port refuses connections)', async (t) => {
  const a = await fakeDaemon({ token: 'tok-a', instanceId: 'inst-a' });
  a.writeState();
  const c = await DaemonClient.connect();
  assert.deepEqual(await c.request('GET', '/api/state'), { ok: true, instanceId: 'inst-a' });

  await a.close();
  const b = await fakeDaemon({ token: 'tok-b', instanceId: 'inst-b' });
  t.after(async () => {
    clearDaemonState();
    await b.close();
  });
  b.writeState();

  const res = await c.request('POST', '/api/command', { text: 'hi' });
  assert.deepEqual(res, { ok: true, instanceId: 'inst-b' });
  assert.equal(c.baseUrl, `http://127.0.0.1:${b.port}`);
  assert.equal(c.token, 'tok-b');
  assert.deepEqual(
    b.hits.map((h) => [h.method, h.path, h.body]),
    [['POST', '/api/command', JSON.stringify({ text: 'hi' })]],
  );
});

test('request() and postBinary() follow a same-port restart with a new token (401)', async (t) => {
  const a = await fakeDaemon({ token: 'tok-a', instanceId: 'inst-a' });
  t.after(async () => {
    clearDaemonState();
    await a.close();
  });
  a.writeState();
  const c = await DaemonClient.connect();
  await c.request('GET', '/api/state');

  a.rotate({ token: 'tok-a2', instanceId: 'inst-a2' });
  a.writeState();
  // Two calls in flight at once: both switch (one daemon.json lookup) and both succeed.
  const [r1, r2] = await Promise.all([c.request('GET', '/api/state'), c.postBinary('/api/stt', Buffer.from('RIFF'), 'audio/wav')]);
  assert.equal(r1.instanceId, 'inst-a2');
  assert.equal(r2.instanceId, 'inst-a2');
  assert.equal(c.token, 'tok-a2');
  // A call sent with the old token whose 401 arrives after another lookup already switched
  // the client: it is sent again with the new token instead of failing.
  a.rotate({ token: 'tok-a3', instanceId: 'inst-a3' });
  a.writeState();
  a.delay401 = 300;
  const late = c.request('GET', '/api/state');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await c.refresh(), { pid: process.pid, port: a.port, instanceId: 'inst-a3' });
  assert.equal((await late).instanceId, 'inst-a3');
});

test('a client with explicit coordinates does not re-resolve on 401', async (t) => {
  const a = await fakeDaemon({ token: 'tok-a', instanceId: 'inst-a' });
  t.after(async () => {
    clearDaemonState();
    await a.close();
  });
  const c = new DaemonClient({ baseUrl: `http://127.0.0.1:${a.port}`, token: 'tok-a' });
  a.rotate({ token: 'tok-new', instanceId: 'inst-new' });
  a.writeState();
  await assert.rejects(c.request('GET', '/api/state'), (err) => err.status === 401);
  assert.equal(c.token, 'tok-a');
});

test('a daemon.json client gives up on 401 when daemon.json names no other daemon', async (t) => {
  const a = await fakeDaemon({ token: 'tok-a', instanceId: 'inst-a' });
  t.after(async () => {
    clearDaemonState();
    await a.close();
  });
  a.writeState();
  const c = await DaemonClient.connect();
  a.rotate({ token: 'tok-other', instanceId: 'inst-a' }); // daemon.json still says tok-a
  await assert.rejects(c.request('GET', '/api/state'), (err) => err.status === 401);
  assert.equal(c.token, 'tok-a');
});

test('subscribe() reports _daemon_replaced and streams from the restarted daemon', async (t) => {
  const a = await fakeDaemon({ token: 'tok-a', instanceId: 'inst-a' });
  a.writeState();
  const c = await DaemonClient.connect();
  const events = [];
  let gotA;
  let gotB;
  const seenA = new Promise((r) => {
    gotA = r;
  });
  const seenB = new Promise((r) => {
    gotB = r;
  });
  const sub = c.subscribe((type, data) => {
    events.push([type, data]);
    if (type === 'snapshot' && data.instanceId === 'inst-a') gotA();
    if (type === 'snapshot' && data.instanceId === 'inst-b') gotB();
  });
  let b = null;
  t.after(async () => {
    sub.close();
    clearDaemonState();
    await a.close();
    if (b) await b.close();
  });
  await withTimeout(seenA, 5000, 'the first snapshot');

  b = await fakeDaemon({ token: 'tok-b', instanceId: 'inst-b' });
  b.writeState();
  await a.close();
  await withTimeout(seenB, 8000, 'a snapshot from the restarted daemon');

  const types = events.map((e) => e[0]);
  const iDisc = types.indexOf('_disconnected');
  const iRepl = types.indexOf('_daemon_replaced');
  assert.ok(iDisc > 0, types.join(','));
  assert.ok(iRepl > iDisc, types.join(','));
  assert.deepEqual(events[iRepl][1], { pid: process.pid, port: b.port, instanceId: 'inst-b' });
  assert.equal(types.lastIndexOf('snapshot') > iRepl, true);
  assert.equal(c.baseUrl, `http://127.0.0.1:${b.port}`);
});

test('subscribe() on an env/explicit client never switches daemons', async (t) => {
  const a = await fakeDaemon({ token: 'tok-a', instanceId: 'inst-a' });
  const b = await fakeDaemon({ token: 'tok-b', instanceId: 'inst-b' });
  const c = new DaemonClient({ baseUrl: `http://127.0.0.1:${a.port}`, token: 'tok-a' });
  const types = [];
  let disc;
  const disconnected = new Promise((r) => {
    disc = r;
  });
  let snap;
  const snapshot = new Promise((r) => {
    snap = r;
  });
  const sub = c.subscribe((type) => {
    types.push(type);
    if (type === 'snapshot') snap();
    if (type === '_disconnected') disc();
  });
  t.after(async () => {
    sub.close();
    clearDaemonState();
    await a.close();
    await b.close();
  });
  await withTimeout(snapshot, 5000, 'the first snapshot');
  b.writeState();
  await a.close();
  await withTimeout(disconnected, 5000, '_disconnected');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!types.includes('_daemon_replaced'), types.join(','));
  assert.equal(c.baseUrl, `http://127.0.0.1:${a.port}`);
});

// ------------------------------------------------------------------ WINDOWS-2-1

const LF_ONLY = ['bin/anywhere', 'scripts/install.sh'];

test('POSIX shell scripts are checked out with LF line endings (Git Bash runs bin/anywhere)', () => {
  for (const rel of LF_ONLY) {
    const text = read(rel);
    assert.ok(
      !text.includes('\r'),
      `${rel} has CR characters, so sh fails with "/bin/sh^M: bad interpreter". ` +
        'Check it out with LF: .gitattributes needs "* text=auto eol=lf".',
    );
  }
});

test('every shebang line is free of CR, and bin/anywhere.cmd uses CRLF throughout', () => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const files = r.status === 0 && r.stdout ? r.stdout.split('\0').filter(Boolean) : [...LF_ONLY, 'bin/anywhere.js', 'skills/anywhere/run.js'];
  for (const rel of files) {
    let head;
    try {
      head = fs.readFileSync(path.join(ROOT, rel)).subarray(0, 256).toString('latin1');
    } catch {
      continue; // deleted in the working tree
    }
    if (!head.startsWith('#!')) continue;
    const first = head.split('\n')[0];
    assert.ok(!first.endsWith('\r'), `${rel}: the shebang line ends in CR`);
  }
  const cmd = read('bin/anywhere.cmd');
  assert.ok(!/(^|[^\r])\n/.test(cmd), 'bin/anywhere.cmd has LF-only lines; cmd.exe needs CRLF for labels and goto');
});

test('.gitattributes pins LF for scripts and CRLF for .cmd (when present)', (t) => {
  if (!fs.existsSync(path.join(ROOT, '.gitattributes'))) {
    t.skip('no .gitattributes in this checkout');
    return;
  }
  const r = spawnSync('git', ['check-attr', 'eol', '--', 'bin/anywhere', 'scripts/install.sh', 'skills/anywhere/SKILL.md', 'bin/anywhere.cmd'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    t.skip('git is not available');
    return;
  }
  const eol = {};
  for (const line of r.stdout.trim().split(/\r?\n/)) {
    const m = /^(.*): eol: (\S+)$/.exec(line);
    if (m) eol[m[1]] = m[2];
  }
  assert.equal(eol['bin/anywhere'], 'lf');
  assert.equal(eol['scripts/install.sh'], 'lf');
  assert.equal(eol['skills/anywhere/SKILL.md'], 'lf');
  assert.equal(eol['bin/anywhere.cmd'], 'crlf');
});

test('the Windows CI job keeps the runner default autocrlf, matching users\' clones', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.doesNotMatch(ci, /core\.autocrlf\s+false/);
  assert.match(ci, /autocrlf/);
});

// ------------------------------------------------------------------ JOURNEYS-DOCS-*

test('SECURITY.md: closing the dialog does not claim to stop the daemon (JOURNEYS-DOCS-1)', () => {
  const sec = read('docs/SECURITY.md');
  assert.doesNotMatch(sec, /closing the dialog[^.\n]*stops the daemon/i);
  assert.match(sec, /Closing the dialog window does \*\*not\*\* stop Claude/);
  assert.match(sec, /`anywhere stop`/);
  const plan = read('docs/PLAN.md');
  assert.doesNotMatch(plan, /mouse-corner failsafe, closing the dialog\./);
  // The code facts behind the doc: Electron hides on close, and the daemon reopens the dialog
  // for approvals when no client is connected.
  assert.match(read('src/electron/main.js'), /win\.on\('close'[\s\S]{0,200}win\.hide\(\)/);
  assert.match(read('src/daemon/main.js'), /clientCount\(\) === 0[\s\S]{0,120}uihost\.show/);
});

test('SECURITY.md lists every place the token goes (JOURNEYS-DOCS-15)', () => {
  const sec = read('docs/SECURITY.md');
  assert.doesNotMatch(sec, /stored only in/);
  for (const where of ['daemon.json', 'run/mcp-<instance>.json', 'environment', '`anywhere url`', 'transcript']) {
    assert.ok(sec.includes(where), `SECURITY.md should mention ${where}`);
  }
  const session = read('src/daemon/session.js');
  assert.match(session, /`mcp-\$\{this\.instanceId\}\.json`/);
  assert.match(session, /ANYWHERE_TOKEN: this\.token/);
});

test('SECURITY.md describes which screenshots stay on disk (JOURNEYS-DOCS-8)', () => {
  const sec = read('docs/SECURITY.md');
  assert.doesNotMatch(sec, /They aren't written to disk, except temporary files on macOS/);
  const keep = /pruneScreenshots\(runDir, (\d+)\)/.exec(read('bin/anywhere.js'));
  assert.ok(keep, 'bin/anywhere.js prunes CLI screenshots');
  assert.match(sec, new RegExp(`screenshot-\\*\\.png\` and keeps the last ${keep[1]}`));
  assert.match(sec, /bridge-\*/);
  assert.match(sec, /Linux/);
});

test('PLATFORMS.md: macOS prompts only for an interactive install (JOURNEYS-DOCS-12)', () => {
  const doc = read('docs/PLATFORMS.md');
  assert.doesNotMatch(doc, /^`anywhere install` asks macOS to show these permission prompts\./m);
  assert.match(doc, /interactive terminal/);
  assert.match(doc, /curl … \| bash/);
  assert.match(doc, /anywhere doctor/);
});

test('PLATFORMS.md: SSH tunnels must keep the daemon port (JOURNEYS-DOCS-13)', () => {
  const doc = read('docs/PLATFORMS.md');
  assert.match(doc, /ssh -L <port>:127\.0\.0\.1:<port>/);
  assert.match(doc, /Forbidden host/);
  assert.match(doc, /anywhere config set port/);
  // The Host check that makes a different local port fail.
  assert.match(read('src/daemon/server.js'), /h === `127\.0\.0\.1:\$\{this\.port\}` \|\| h === `localhost:\$\{this\.port\}`/);
});

test('PLATFORMS.md: Wayland input needs ydotool >= 1.0; wtype is not used on GNOME (JOURNEYS-DOCS-17)', () => {
  const doc = read('docs/PLATFORMS.md');
  assert.match(doc, /`ydotool` \*\*1\.0 or newer\*\*/);
  assert.match(doc, /0\.1\.8/);
  assert.match(doc, /github\.com\/ReimuNotMoe\/ydotool/);
  assert.match(doc, /`wtype` isn't used on GNOME/);
  const linux = read('src/os/linux.js');
  assert.match(linux, /ydotool >= 1\.0 with ydotoold is required/);
  assert.match(linux, /_canWtype\(\) \{\s*return this\._has\('wtype'\) && this\.compositor !== 'gnome'/);
});
