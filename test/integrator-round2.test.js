'use strict';

/**
 * Round 2, final integration: the cross-group handoffs.
 *  - `anywhere send --wait` matches results by commandIds and ends on commands_cancelled.
 *  - UiHost launches nothing after close() (LIFECYCLE-9).
 *  - The hub counts dialog pages (?client=ui) apart from other clients (JOURNEYS-DOCS-6).
 *  - Busy project/mode switches need force (LIFECYCLE-4); /api/command reports the mode.
 *  - An estimated (Wayland) pointer never trips the failsafe and is reported as such.
 *  - `anywhere start` hides the token URL when a window opened, and suggests an SSH tunnel.
 *  - CLI screenshots are pruned by age too.
 *  - The TUI reports a restarted daemon and asks for --switch on a refused switch.
 *  - Electron never tries browser speech recognition.
 *  - The Windows host retries a failed Add-Type.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { PassThrough } = require('stream');
const { pathToFileURL } = require('url');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-integrator-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_DAEMON_URL;
delete process.env.ANYWHERE_TOKEN;
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const ROOT = path.join(__dirname, '..');
const cli = require('../bin/anywhere.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ send --wait

function fakeEvents() {
  let handler = null;
  return {
    closed: false,
    subscribe(fn) {
      handler = fn;
      const self = this;
      return {
        close() {
          self.closed = true;
        },
      };
    },
    emit(type, data) {
      handler(type, data);
    },
  };
}

test('send --wait: a result for another command never ends the wait; ours does', async () => {
  const client = fakeEvents();
  const id = { value: null };
  const waiting = cli.waitForResult(client, id, 5000);
  // A turn that was already running answers before our POST returned.
  client.emit('result', { text: 'old answer', commandIds: ['other'] });
  id.value = 'mine';
  waiting.idKnown();
  client.emit('message', { role: 'user', id: 'mine', text: 'do it' });
  client.emit('result', { text: 'not ours either', commandIds: ['other-2'] });
  client.emit('result', { text: 'done', commandIds: ['mine'] });
  const r = await waiting;
  assert.equal(r.text, 'done');
  assert.deepEqual(r.result.commandIds, ['mine']);
  assert.equal(client.closed, true);
});

test('send --wait: a result that arrives before the POST answers is matched once the id is known', async () => {
  const client = fakeEvents();
  const id = { value: null };
  const waiting = cli.waitForResult(client, id, 5000);
  client.emit('result', { text: 'fast', commandIds: ['quick'] });
  id.value = 'quick';
  waiting.idKnown();
  assert.equal((await waiting).text, 'fast');
});

test('send --wait: commands_cancelled and a restarted daemon end the wait as cancelled', async () => {
  const a = fakeEvents();
  const idA = { value: 'c1' };
  const wa = cli.waitForResult(a, idA, 5000);
  a.emit('commands_cancelled', { commandIds: ['someone-else'], reason: 'stopped' });
  a.emit('commands_cancelled', { commandIds: ['c1'], reason: 'stopped' });
  assert.equal((await wa).cancelled, 'stopped');

  const b = fakeEvents();
  const wb = cli.waitForResult(b, { value: 'c2' }, 5000);
  b.emit('_daemon_replaced', { pid: 2, port: 3, instanceId: 'x' });
  assert.equal((await wb).cancelled, 'daemon_restarted');
});

test('send --wait: an older daemon without commandIds still ends on the first result after our message', async () => {
  const client = fakeEvents();
  const id = { value: 'old-1' };
  const waiting = cli.waitForResult(client, id, 5000);
  client.emit('result', { text: 'before ours' }); // not after our user message: ignored
  client.emit('message', { role: 'user', id: 'old-1', text: 'x' });
  client.emit('message', { role: 'assistant', text: 'streamed', streaming: false });
  client.emit('result', {});
  assert.equal((await waiting).text, 'streamed');
});

test('send --wait: times out with what was said so far', async () => {
  const client = fakeEvents();
  const r = await cli.waitForResult(client, { value: 'slow' }, 30);
  assert.equal(r.timeout, true);
});

// ------------------------------------------------------------------ UiHost after close

test('UiHost: open() and show() launch nothing once close() ran (daemon shutdown)', async () => {
  const { UiHost } = require('../src/daemon/uihost');
  const spawned = [];
  const host = new UiHost({
    config: { ui: { host: 'browser' } },
    platformInfo: { platform: 'linux', isWSL: false, displayServer: 'x11', isHeadless: false },
    env: { DISPLAY: ':0' },
    which: () => '/usr/bin/xdg-open',
    exists: () => false,
    spawn: (cmd, args) => {
      spawned.push([cmd, args]);
      throw new Error('must not launch');
    },
    run: async () => ({ code: 1, stdout: '', stderr: '', error: null }),
    kill: () => true,
    profileDir: path.join(HOME, 'ui-profile'),
    stateDir: HOME,
    logFile: false,
    cleanupLeftovers: false,
  });
  await host.close();
  assert.deepEqual(await host.open('http://127.0.0.1:1/?token=t'), { host: 'none', detail: 'the daemon is shutting down' });
  assert.deepEqual(await host.show('http://127.0.0.1:1/?token=t'), { host: 'none' });
  assert.deepEqual(spawned, []);
});

test('uihost exports the WSL powershell lookup the doctor uses (JOURNEYS-DOCS-11)', () => {
  const U = require('../src/daemon/uihost');
  const which = (n) => (n === 'pwsh.exe' ? '/x/pwsh.exe' : null);
  assert.equal(U.wslPowershellPath({ which, exists: () => false }), '/x/pwsh.exe');
  assert.equal(U.wslPowershellPath({ which: () => null, exists: () => true }), '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.equal(U.UiHost.wslPowershellPath({ which: () => null, exists: () => false }), null);
});

// ------------------------------------------------------------------ hub client kinds

test('hub: clientCount(kind) counts only the clients that connected with ?client=<kind>', () => {
  const { Hub } = require('../src/daemon/hub');
  const hub = new Hub({ heartbeatMs: 0 });
  const res = () => {
    const r = new PassThrough();
    r.headersSent = false;
    r.writeHead = () => {};
    return r;
  };
  try {
    hub.addClient({ url: '/api/events?token=t&client=ui' }, res());
    hub.addClient({ url: '/api/events?token=t' }, res());
    hub.addClient({ url: '/api/events?token=t&client=ui' }, res());
    assert.equal(hub.clientCount(), 3);
    assert.equal(hub.clientCount('ui'), 2);
    assert.equal(hub.clientCount('tui'), 0);
  } finally {
    hub.close();
  }
  // The dialog page identifies itself.
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8'), /\/api\/events\?token=\$\{encodeURIComponent\(state\.token\)\}&client=ui/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'daemon', 'main.js'), 'utf8'), /clientCount: \(\) => hub\.clientCount\('ui'\)/);
});

// ------------------------------------------------------------------ busy switches (LIFECYCLE-4)

function request(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.end(data);
    else req.end();
  });
}

test('server: /api/command reports the mode and whether a terminal listens; project and mode pass force', async () => {
  const { createServer } = require('../src/daemon/server');
  const calls = [];
  const noop = () => {};
  const session = {
    mode: 'bridge',
    projectDir: ROOT,
    snapshot: () => ({}),
    guard: () => ({ allowed: true }),
    submit: async () => ({ id: 'cmd-1' }),
    setProject: async (dir, opts) => {
      calls.push(['project', dir, opts]);
      return { dir, name: 'x', git: null };
    },
    setMode: async (mode, opts) => {
      calls.push(['mode', mode, opts]);
      return { mode };
    },
  };
  const srv = createServer({
    hub: { addClient: noop, broadcast: noop, clientCount: () => 0, close: noop, on: noop },
    session,
    permissions: null,
    questions: { pending: () => [], answer: () => false },
    bridge: { listening: false },
    config: {},
    token: 'tok',
    instanceId: 'test',
    version: '0.0.0',
    uiDir: path.join(ROOT, 'src', 'ui'),
  });
  const port = await srv.listen(0);
  try {
    const r = await request(port, 'POST', '/api/command', { text: 'hi' }, 'tok');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, id: 'cmd-1', mode: 'bridge', bridge: { listening: false } });
    await request(port, 'POST', '/api/project', { dir: ROOT }, 'tok');
    await request(port, 'POST', '/api/project', { dir: ROOT, force: true }, 'tok');
    await request(port, 'POST', '/api/mode', { mode: 'companion', force: 'yes' }, 'tok');
    assert.deepEqual(calls, [
      ['project', ROOT, { force: false }],
      ['project', ROOT, { force: true }],
      ['mode', 'companion', { force: false }],
    ]);
  } finally {
    srv.close();
  }
});

test('session: a busy switch is refused with 409 unless forced, which notes that the task was stopped', async () => {
  const { SessionManager } = require('../src/daemon/session');
  const broadcasts = [];
  const hub = { broadcast: (type, data) => broadcasts.push([type, data]), on() {}, removeListener() {}, clientCount: () => 0 };
  let pendingApprovals = [{ id: 'a1' }];
  let cancelled = 0;
  const permissions = {
    pending: () => pendingApprovals,
    cancelAll: () => {
      cancelled += 1;
      pendingApprovals = [];
    },
    clearSessionRules() {},
  };
  const projA = fs.mkdtempSync(path.join(HOME, 'projA-'));
  const projB = fs.mkdtempSync(path.join(HOME, 'projB-'));
  const s = new SessionManager({
    config: require('../src/shared/config').load(),
    hub,
    permissions,
    questions: { pending: () => [], cancelAll() {} },
    bridge: null,
    port: 1,
    token: 't',
    projectDir: projA,
    mode: 'companion',
    instanceId: 'integrator',
  });
  try {
    assert.equal(s.isBusy(), true, 'an approval card is waiting');
    await assert.rejects(s.setProject(projB), (e) => e.status === 409 && /A task is running/.test(e.message) && Boolean(e.hint));
    await assert.rejects(s.setMode('bridge'), (e) => e.status === 409);
    assert.equal(s.projectDir, projA);
    assert.equal(s.mode, 'companion');
    await s.setProject(projB, { force: true });
    assert.equal(s.projectDir, projB);
    assert.equal(cancelled, 1, 'the open card was cancelled');
    const texts = broadcasts.filter(([t, d]) => t === 'message' && d.role === 'system').map(([, d]) => d.text);
    assert.ok(texts.includes('The running task was stopped.'), texts.join(' | '));
    assert.equal(s.isBusy(), false);
    assert.deepEqual(await s.setMode('bridge'), { mode: 'bridge' }, 'an idle dialog switches without force');
  } finally {
    await s.shutdown();
  }
});

// ------------------------------------------------------------------ estimated pointer (os-linux)

test('computer: an estimated pointer (Wayland) never trips the failsafe and is reported as estimated', async () => {
  const { Computer } = require('../src/os/computer');
  const { createMockDriver } = require('../src/os/index');
  const make = (estimated) => {
    const driver = createMockDriver({ displays: [{ x: 0, y: 0, width: 1920, height: 1080, primary: true }] });
    driver.cursorPosition = async () => (estimated ? { x: 0, y: 0, estimated: true } : { x: 0, y: 0 });
    return new Computer({ driver, config: { actionDelayMs: 0, failsafe: true }, geometryStore: 'memory', platform: 'linux' });
  };
  const est = make(true);
  await est.key({ combo: 'enter' });
  const pos = await est.cursorPosition();
  assert.equal(pos.estimated, true);
  assert.deepEqual(pos.logical, { x: 0, y: 0 });
  const shot = await est.screenshot();
  assert.equal(shot.cursor, null, 'a made-up cursor is left out of the screenshot metadata');
  // The real pointer in the corner still stops everything.
  await assert.rejects(make(false).key({ combo: 'enter' }), { code: 'FAILSAFE' });
  assert.equal((await make(false).cursorPosition()).estimated, undefined);
});

test('cursor_position says when the position is only an estimate', async () => {
  const { createTools } = require('../src/mcp/tools');
  const comp = { cursorPosition: async () => ({ x: 5, y: 6, display: 0, logical: { x: 5, y: 6 }, estimated: true }) };
  const tools = createTools({ computer: async () => comp, getClient: async () => null, config: {}, role: 'engine' });
  const tool = tools.find((t) => t.name === 'cursor_position');
  const out = await tool.handler({}, {});
  const text = out.content.map((c) => c.text || '').join('');
  assert.match(text, /Mouse at \(5, 6\)/);
  assert.match(text, /estimated: this Wayland session cannot read the real pointer/);
});

// ------------------------------------------------------------------ start summary

test('anywhere start prints the token URL only when no window opened; SSH sessions get the tunnel line', () => {
  const st = { url: 'http://127.0.0.1:47120/?token=SECRET', port: 47120, project: '/p', mode: 'companion', pid: 1 };
  const config = { mode: 'companion', ui: { hotkey: 'CommandOrControl+Shift+Space' } };
  const opened = cli.startSummary({ state: st, host: 'app', notes: [] }, config);
  assert.doesNotMatch(opened, /SECRET/);
  assert.match(opened, /http:\/\/127\.0\.0\.1:47120\//);
  assert.match(opened, /url.*prints the full link/);
  assert.match(cli.startSummary({ state: st, host: 'app', notes: [] }, config, { showToken: true }), /SECRET/);
  const prev = process.env.SSH_CONNECTION;
  try {
    delete process.env.SSH_CONNECTION;
    const local = cli.startSummary({ state: st, host: 'none', notes: [] }, config);
    assert.match(local, /SECRET/);
    assert.doesNotMatch(local, /Tunnel/);
    process.env.SSH_CONNECTION = '10.0.0.2 5000 10.0.0.1 22';
    const ssh = cli.startSummary({ state: st, host: 'none', notes: [] }, config);
    assert.match(ssh, /Tunnel {3}ssh -L 47120:127\.0\.0\.1:47120 <user>@<this host>/);
  } finally {
    if (prev === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = prev;
  }
});

test('CLI screenshots: the newest 30 are kept, none older than an hour (JOURNEYS-DOCS-8)', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'shots-'));
  const now = Date.now() / 1000;
  // A minute either side of the one-hour limit: a file exactly 60 minutes old raced the clock
  // (kept when pruneScreenshots ran in the same millisecond as `now`, removed otherwise).
  [0, 20, 59, 61, 80].forEach((minutes, i) => {
    const f = path.join(dir, `screenshot-${i}.png`);
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, now - minutes * 60, now - minutes * 60);
  });
  fs.writeFileSync(path.join(dir, 'bridge-1.png'), 'x');
  cli.pruneScreenshots(dir, 30);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['bridge-1.png', 'screenshot-0.png', 'screenshot-1.png', 'screenshot-2.png']);
  cli.pruneScreenshots(dir, 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['bridge-1.png', 'screenshot-0.png']);
});

// ------------------------------------------------------------------ TUI

function tuiClient(responses = {}) {
  const calls = [];
  let onEvent = null;
  return {
    calls,
    emit: (type, data) => onEvent(type, data),
    subscribe(fn) {
      onEvent = fn;
      return { close() {} };
    },
    async request(method, p, body) {
      calls.push({ method, path: p, body });
      const r = responses[`${method} ${p}`];
      if (typeof r === 'function') return r(body);
      if (r instanceof Error) throw r;
      return r || { ok: true };
    },
  };
}

test('TUI: a restarted daemon is reported once; a refused switch asks for --switch, which sends force', async () => {
  const T = require('../src/tui/tui');
  const busy = Object.assign(new Error('A task is running in proj; stop it first'), { status: 409 });
  const client = tuiClient({
    'POST /api/mode': (body) => {
      if (!body.force) throw busy;
      return { ok: true, mode: body.mode };
    },
  });
  const input = new PassThrough();
  const out = new PassThrough();
  let text = '';
  out.on('data', (d) => {
    text += d.toString();
  });
  const tui = new T.Tui({ client, input, output: out, env: { NO_COLOR: '1' }, platform: 'linux', cwd: '/w', homedir: '/h' });
  const done = tui.run();
  await sleep(10);
  client.emit('snapshot', { version: '1', mode: 'companion', status: 'queued', project: { dir: '/w', name: 'w' }, messages: [] });
  client.emit('approval_request', { id: 'a1', toolName: 'Bash', displayName: 'Run command', summary: 'ls', risk: 'high', reason: 'r' });
  client.emit('_daemon_replaced', { pid: 42, port: 47121, instanceId: 'new' });
  await sleep(10);
  assert.match(text, /Claude Anywhere restarted \(pid 42, port 47121\); reconnected\./);
  assert.equal(tui.prompts.length, 0, "the old daemon's cards are gone");
  await tui.handleInput('/mode bridge');
  assert.match(text, /A task is running in proj; stop it first\. .*\/mode bridge --switch/);
  await tui.handleInput('/mode bridge --switch');
  const modeCalls = client.calls.filter((c) => c.path === '/api/mode').map((c) => c.body);
  assert.deepEqual(modeCalls, [{ mode: 'bridge' }, { mode: 'bridge', force: true }]);
  tui.quit();
  input.end();
  await done;
});

// ------------------------------------------------------------------ Electron voice

test('voice: inside Electron browser speech is never tried; with no server provider it is unavailable', async () => {
  const TMP = fs.mkdtempSync(path.join(HOME, 'ui-'));
  fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"module"}\n');
  const UI = path.join(ROOT, 'src', 'ui');
  for (const f of fs.readdirSync(UI)) if (f.endsWith('.js')) fs.copyFileSync(path.join(UI, f), path.join(TMP, f));
  const { createVoice } = await import(pathToFileURL(path.join(TMP, 'voice.js')).href);
  class Recorder {
    static isSupported() {
      return true;
    }
  }
  const prevSR = globalThis.SpeechRecognition;
  const prevShell = globalThis.anywhereShell;
  globalThis.SpeechRecognition = function FakeSR() {};
  globalThis.anywhereShell = { isElectron: true };
  try {
    const make = (serverVoice) =>
      createVoice({ getConfig: () => ({ voice: { stt: 'auto' } }), getServerVoice: () => serverVoice, api: async () => ({}), Recorder });
    assert.equal(make({ serverStt: false, sttHint: 'set GROQ_API_KEY' }).provider().stt, 'none');
    assert.equal(make({ serverStt: true, sttProvider: 'groq' }).provider().stt, 'server');
    // Not known yet (no hint): server, never the browser recognizer.
    assert.equal(make({ serverStt: false }).provider().stt, 'server');
    globalThis.anywhereShell = undefined;
    assert.equal(make({ serverStt: false, sttHint: 'x' }).provider().stt, 'browser', 'a real browser keeps browser speech');
  } finally {
    globalThis.SpeechRecognition = prevSR;
    globalThis.anywhereShell = prevShell;
  }
});

// ------------------------------------------------------------------ Windows host

test('win32 host: a failed Add-Type is retried by later commands (WINDOWS-2-4)', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'src', 'os', 'win32-host.ps1'), 'utf8');
  assert.match(ps, /function Initialize-Native \{/);
  assert.match(ps, /^Initialize-Native$/m, 'called at startup');
  const assertNative = /function Assert-Native \{([\s\S]*?)\n\}/.exec(ps);
  assert.ok(assertNative);
  assert.match(assertNative[1], /Assert-Windows[\s\S]*-not \$script:NativeOk[\s\S]*NativeTriedAt[\s\S]*Initialize-Native[\s\S]*NATIVE_UNAVAILABLE/);
});

// ------------------------------------------------------------------ MCP open tool

test('open: a note from openTarget reaches Claude, and the macOS argument rules are described', async () => {
  const toolsPath = require.resolve('../src/mcp/tools');
  const commonPath = require.resolve('../src/os/common');
  const common = require(commonPath);
  const orig = common.openTarget;
  common.openTarget = async () => ({ kind: 'app', target: 'Safari', how: 'open -a', note: 'The flags were not passed: Safari was already running.' });
  delete require.cache[toolsPath];
  try {
    const { createTools } = require(toolsPath);
    const tools = createTools({ computer: async () => ({}), getClient: async () => null, config: {}, role: 'engine' });
    const open = tools.find((t) => t.name === 'open');
    assert.match(open.description, /On macOS, URLs and existing files in args are handed to the app as documents/);
    const out = await open.handler({ target: 'Safari', kind: 'app', args: ['--x'] }, {});
    const text = out.content.map((c) => c.text || '').join('');
    assert.match(text, /^Opened app Safari \(via open -a\)\. The flags were not passed: Safari was already running\. It may take a moment/);
  } finally {
    common.openTarget = orig;
    delete require.cache[toolsPath];
  }
});
