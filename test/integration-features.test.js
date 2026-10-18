'use strict';

/**
 * Cross-track integration of the natural voice (announcer, voice routes, dialog playback) and the
 * ticket workflow (browser tab, Jira, repositories, hand-off): the seams between modules that
 * were built separately.
 *
 *  - Nothing is said twice: notify_user {speak:true} goes through the announcer only (the daemon's
 *    old fallback and the page stay quiet), and a page never speaks results, cards or notes while
 *    snapshot.voice.announcer is true, which the very first snapshot already says.
 *  - A hand-off result announces where the work continues instead of "done".
 *  - "System voice" (voice.ttsEngine os) speaks through the OS even while the dialog is visible.
 *  - Config, logs and the CLI keep the Jira token secret; voice.ttsEngine is validated.
 *  - Workspace roots typed in Settings (quotes, trailing separators, WSL drive paths) are found.
 *  - read_browser_tab and the desktop context read Jira tab titles the same way.
 *  - Computer.browserTab runs the pause guard and the failsafe before any key.
 *  - The MCP instructions point Claude at the ticket tools.
 *
 * No network, audio or display: the OS voice and the speakers are replaced by recorders. The
 * browser case drives headless Chromium against test/fixtures/ui-stub-server.js and is skipped
 * without a Chromium binary (ANYWHERE_TEST_CHROME) or a global WebSocket (Node < 22).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-features-'));
process.env.ANYWHERE_HOME = HOME;
process.env.ANYWHERE_DRIVER = 'mock';
delete process.env.ANYWHERE_LOG_FILE;
delete process.env.ANYWHERE_PIPER_PATH;

const ROOT = path.join(__dirname, '..');
const { Announcer } = require('../src/daemon/announcer');
const { DaemonServer, validateConfigUpdate } = require('../src/daemon/server');
const { redact } = require('../src/shared/log');
const configMod = require('../src/shared/config');
const project = require('../src/mcp/tools-project');
const browser = require('../src/mcp/tools-browser');
const desktop = require('../src/context/desktop');
const { Computer } = require('../src/os/computer');
const { createMockDriver } = require('../src/os/index');
const { buildInstructions } = require('../src/mcp/server');

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await tick(20);
  }
}

/** A hub with `uiPages` connected dialog pages that records broadcasts. */
function fakeHub(uiPages = 1) {
  const hub = new EventEmitter();
  hub.sent = [];
  hub.broadcast = (type, data) => hub.sent.push({ type, data });
  hub.clientCount = (kind) => (kind === 'ui' ? uiPages : uiPages);
  return hub;
}

/** A VoiceService stand-in that records what the OS would say and play. */
function fakeVoice(info = { setting: 'auto', engine: 'os', piper: {}, os: { provider: 'test' } }) {
  const v = { spoken: [], played: [] };
  v.engineInfo = async () => info;
  v.speak = async (text) => {
    v.spoken.push(text);
    return { ok: true, provider: 'test' };
  };
  v.playFile = async (file) => {
    v.played.push(file);
    return { ok: true, player: 'test' };
  };
  v.onStop = () => () => {};
  return v;
}

// ------------------------------------------------------------------ announcer seams

test('announcer: notify_user {speak:true} is said once, without a chime; only voice.tts off mutes it', async () => {
  const config = { voice: { speakResponses: false, chime: true } };
  const hub = fakeHub(1);
  const an = new Announcer({ config, hub, voice: null, chimeFile: (k) => `chime-${k}.wav` }).start();
  hub.emit('event', 'notify', { text: 'Deployed **shop-api**; the URL is https://shop.run.app.', level: 'success', speak: true });
  hub.emit('event', 'notify', { text: 'A quiet note', level: 'info', speak: false });
  await waitFor(() => hub.sent.length >= 1);
  await tick(30);
  assert.equal(hub.sent.length, 1, 'only the note that asked to be spoken');
  const ev = hub.sent[0];
  assert.equal(ev.type, 'announce');
  assert.equal(ev.data.kind, 'info');
  assert.equal(ev.data.chime, false, 'notes have no chime');
  assert.doesNotMatch(ev.data.text, /\*\*/, 'markdown removed');
  assert.match(ev.data.text, /Deployed shop-api/);

  hub.emit('event', 'notify', { text: 'It failed.', level: 'error', speak: true });
  await waitFor(() => hub.sent.length >= 2);
  assert.equal(hub.sent[1].data.kind, 'error');

  config.voice.tts = 'off';
  hub.emit('event', 'notify', { text: 'Silent', speak: true });
  await tick(30);
  assert.equal(hub.sent.length, 2, 'voice.tts off: nothing');
  an.stop();
});

test('announcer: a hand-off result says where the work continues, not "done"', async () => {
  const hub = fakeHub(1);
  const an = new Announcer({ config: { voice: {} }, hub, voice: null, minQuietTurnMs: 0 }).start();
  hub.emit('event', 'result', { text: 'Handing over.', durationMs: 9000, isError: false, sessionId: 's', commandIds: ['c1'], handoff: { dir: 'C:\\code\\shop-api\\' } });
  await waitFor(() => hub.sent.length >= 1);
  assert.equal(hub.sent[0].data.kind, 'info');
  assert.equal(hub.sent[0].data.text, 'Switching to shop-api to continue.');
  assert.equal(hub.sent[0].data.chime, false);
  // The new session's own result is the real "done".
  hub.emit('event', 'result', { text: 'I created the branch and pushed it.', durationMs: 9000, isError: false, sessionId: 's2', commandIds: ['c2'] });
  await waitFor(() => hub.sent.length >= 2);
  assert.equal(hub.sent[1].data.kind, 'done');
  assert.match(hub.sent[1].data.text, /I created the branch and pushed it\.$/);
  an.stop();
});

test('announcer: "System voice" speaks through the OS even while the dialog is visible; automatic lets the page speak', async () => {
  const hub = fakeHub(1);
  const voice = fakeVoice({ setting: 'os', engine: 'os', piper: {}, os: { provider: 'espeak-ng' } });
  const an = new Announcer({ config: { voice: { chime: true } }, hub, voice, chimeFile: (k) => `chime-${k}.wav`, minQuietTurnMs: 0 }).start();
  assert.equal(an.dialogVisible(), true);
  hub.emit('event', 'result', { text: 'The tests pass.', durationMs: 9000, isError: false, sessionId: 's', commandIds: ['a'] });
  await waitFor(() => voice.spoken.length >= 1);
  assert.deepEqual(voice.played, ['chime-done.wav']);
  assert.match(voice.spoken[0], /The tests pass\.$/);
  assert.equal(hub.sent.filter((e) => e.type === 'announce').length, 0, 'not sent to the page as well');

  const hub2 = fakeHub(1);
  const voice2 = fakeVoice({ setting: 'auto', engine: 'os', piper: {}, os: { provider: 'espeak-ng' } });
  const an2 = new Announcer({ config: { voice: {} }, hub: hub2, voice: voice2, minQuietTurnMs: 0 }).start();
  hub2.emit('event', 'result', { text: 'Built.', durationMs: 9000, isError: false, sessionId: 's', commandIds: ['b'] });
  await waitFor(() => hub2.sent.length >= 1);
  assert.equal(hub2.sent[0].type, 'announce');
  assert.deepEqual(voice2.spoken, [], 'the visible page speaks with its most natural voice');
  an.stop();
  an2.stop();
});

test('POST /api/mcp/notify leaves {speak:true} to the announcer (no second voice), and speaks itself without one', async () => {
  const run = async (announcer) => {
    const spoken = [];
    const fake = {
      session: { notify: () => ({ ok: true, delivered: false }) },
      deps: {
        announcer,
        voice: { speak: async (t) => spoken.push(t) },
        config: { voice: {} },
        notifyOS: null,
      },
    };
    const out = await DaemonServer.prototype.mcpNotify.call(fake, { body: { message: 'Deploy finished', speak: true } });
    await tick(10);
    return { out, spoken };
  };
  const withAnnouncer = await run({ handle() {} });
  assert.deepEqual(withAnnouncer.spoken, [], 'the announcer says it (dialog or speakers)');
  assert.equal(withAnnouncer.out.delivered, true);
  const without = await run(null);
  assert.deepEqual(without.spoken, ['Deploy finished'], 'no announcer: the daemon speaks it as before');
});

test('daemon: the first snapshot already says announcer:true, and a spoken note reaches the speakers exactly once', { skip: process.platform === 'win32' }, async () => {
  const main = require('../src/daemon/main');
  const d = await main.runDaemon({ project: HOME, port: 0, open: false, handleSignals: false, allowMultiple: true });
  const spoken = [];
  d.voice.engineInfo = async () => ({ setting: 'auto', engine: 'os', piper: { installed: false }, os: { provider: 'test' } });
  d.voice.speak = async (text) => {
    spoken.push(text);
    return { ok: true, provider: 'test' };
  };
  d.voice.playerOverride = { playFile: async () => ({ ok: true, player: 'test' }), stop: () => false, status: async () => ({ available: true, players: ['test'] }) };
  const base = `http://127.0.0.1:${d.port}`;
  const auth = { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' };
  let sse = null;
  try {
    const state = await (await fetch(`${base}/api/state`, { headers: auth })).json();
    assert.equal(state.voice.announcer, true, 'set before the voice probe answers');

    const res = await fetch(`${base}/api/mcp/notify`, { method: 'POST', headers: auth, body: JSON.stringify({ message: 'Halfway there: the image is built.', speak: true }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).delivered, true);
    await waitFor(() => spoken.length >= 1);
    await tick(300);
    assert.deepEqual(spoken, ['Halfway there: the image is built.'], 'said once, through the speakers (no dialog)');

    // With a visible dialog page the note goes to the page instead.
    sse = await new Promise((resolve, reject) => {
      const events = [];
      const req = http.get(`${base}/api/events?client=ui`, { headers: { Authorization: `Bearer ${d.token}` } }, (r) => {
        let buf = '';
        r.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const type = /^event: (.*)$/m.exec(frame);
            const data = /^data: (.*)$/m.exec(frame);
            if (type && data) events.push({ type: type[1], data: JSON.parse(data[1]) });
          }
        });
        resolve({ events, close: () => req.destroy() });
      });
      req.on('error', reject);
    });
    await waitFor(() => sse.events.some((e) => e.type === 'snapshot'));
    assert.equal(sse.events.find((e) => e.type === 'snapshot').data.voice.announcer, true);
    await fetch(`${base}/api/mcp/notify`, { method: 'POST', headers: auth, body: JSON.stringify({ message: 'Tests are green.', speak: true }) });
    const ann = await waitFor(() => sse.events.find((e) => e.type === 'announce'));
    assert.ok(ann, 'announce event to the page');
    assert.equal(ann.data.text, 'Tests are green.');
    assert.equal(ann.data.chime, false);
    const note = sse.events.find((e) => e.type === 'notify' && e.data.text === 'Tests are green.');
    assert.ok(note && note.data.speak === true, 'the notify event still carries speak (an older page speaks it; a current one leaves it to announce)');
    await tick(200);
    assert.equal(spoken.length, 1, 'not on the speakers as well');

    // voice.ttsEngine typos are refused by POST /api/config.
    const bad = await fetch(`${base}/api/config`, { method: 'POST', headers: auth, body: JSON.stringify({ voice: { ttsEngine: 'neural' } }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /voice\.ttsEngine.*auto, piper, browser, os/);
  } finally {
    if (sse) sse.close();
    await d.shutdown('test');
  }
});

// ------------------------------------------------------------------ settings and secrets

test('config: voice.ttsEngine is an enum; Jira and workspace keys have their types', () => {
  assert.match(validateConfigUpdate({ voice: { ttsEngine: 'neural' } }), /must be one of: auto, piper, browser, os/);
  for (const ok of ['auto', 'piper', 'browser', 'os']) assert.equal(validateConfigUpdate({ voice: { ttsEngine: ok } }), null);
  assert.equal(validateConfigUpdate({ voice: { announce: { done: false }, chime: false, piperVoice: 'en_GB-alba-medium' } }), null);
  assert.match(validateConfigUpdate({ voice: { announce: { done: 'no' } } }), /true or false/);
  assert.equal(validateConfigUpdate({ jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c', apiToken: 'x' } }), null);
  assert.equal(validateConfigUpdate({ workspace: { roots: ['~/code', 'C:\\dev'] } }), null);
  assert.match(validateConfigUpdate({ workspace: { roots: '~/code' } }), /list of strings/);
  const pub = configMod.publicConfig(configMod.setPath(JSON.parse(JSON.stringify(configMod.DEFAULTS)), 'jira.apiToken', 'ATATT3xFfGF0secret'));
  assert.equal(pub.jira.apiToken, '');
  assert.equal(pub.jira.apiTokenSet, true);
});

test('logs: Jira tokens, Basic auth headers and apiToken fields are redacted', () => {
  const token = `ATATT3xFfGF0${'q'.repeat(40)}=ABCD1234`;
  const basic = Buffer.from(`me@acme.com:${token}`).toString('base64');
  const out = redact({ apiToken: token, line: `GET /rest/api/3/myself Authorization: Basic ${basic}`, msg: `token ${token} failed` });
  assert.equal(out.apiToken, '***');
  assert.doesNotMatch(JSON.stringify(out), /q{20}|ATATT3xFfGF0q/);
  assert.match(out.line, /Basic \*\*\*/);
});

test('CLI: anywhere config and config get jira never print the Jira token', () => {
  const home = fs.mkdtempSync(path.join(HOME, 'cli-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ jira: { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.com', apiToken: 'ATATT3xFfGF0VerySecretTokenValue123' } }), { mode: 0o600 });
  const env = { ...process.env, ANYWHERE_HOME: home, NO_COLOR: '1', ANYWHERE_DAEMON_URL: '', ANYWHERE_TOKEN: '' };
  for (const args of [['config'], ['config', 'get', 'jira'], ['config', 'get', 'jira.apiToken'], ['config', '--json']]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'anywhere.js'), ...args], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /VerySecretTokenValue/, `${args.join(' ')} hides the token`);
  }
  const reveal = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'anywhere.js'), 'config', 'get', 'jira.apiToken', '--reveal'], { env, encoding: 'utf8', timeout: 20000 });
  assert.match(reveal.stdout, /VerySecretTokenValue/, '--reveal shows it on request');
  const help = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'anywhere.js'), 'help'], { env, encoding: 'utf8', timeout: 20000 });
  assert.match(help.stdout, /voice install \[ID\]/);
  assert.match(help.stdout, /jira setup \| test \| status/);
});

// ------------------------------------------------------------------ ticket workflow seams

test('find_repos: workspace roots as typed (quotes, trailing separators, ~, WSL drive paths) are searched', async () => {
  const { cleanRoot, scanRoots } = project;
  assert.equal(cleanRoot(' "~/code/" '), '~/code');
  assert.equal(cleanRoot('/'), '/');
  assert.equal(cleanRoot('C:\\dev\\', { platform: 'win32' }), 'C:\\dev');
  assert.equal(cleanRoot('C:\\', { platform: 'win32' }), 'C:\\');
  assert.equal(cleanRoot('\\\\server\\share\\', { platform: 'win32' }), '\\\\server\\share');
  assert.equal(cleanRoot('C:\\Users\\me\\code', { platform: 'linux', isWSL: true }), '/mnt/c/Users/me/code');
  assert.equal(cleanRoot("'D:'", { platform: 'linux', isWSL: true }), '/mnt/d');
  assert.equal(cleanRoot('   '), '');

  const home = fs.mkdtempSync(path.join(HOME, 'roots-'));
  const work = path.join(home, 'work stuff');
  fs.mkdirSync(path.join(work, 'shop-api', '.git'), { recursive: true });
  const roots = await scanRoots({ home, platform: process.platform, isWSL: false, roots: [`"${work}${path.sep}"`, '~/missing', ''], commonRoots: [] });
  const ws = roots.filter((r) => r.source === 'workspace');
  assert.deepEqual(ws.map((r) => r.dir), [path.resolve(work)], 'the quoted root with a trailing separator; a missing one is skipped');
});

test('read_browser_tab and the desktop context read Jira tab titles the same way', () => {
  const cases = [
    ['[ABC-123] Fix login timeout - Jira - Brave', 'ABC-123', 'Fix login timeout'],
    ['ABC-12: Do the thing - Jira', 'ABC-12', 'Do the thing'],
    ['Fix it - ABC-77 - Jira - Brave', 'ABC-77', 'Fix it'],
    ['[ENG-1] Something - Acme JIRA', 'ENG-1', 'Something'],
  ];
  for (const [title, key, summary] of cases) {
    assert.deepEqual(browser.parseJiraTitle(title), { key, summary }, title);
    const clean = title.replace(/ - Brave$/, '');
    const fromCtx = desktop.parseTicketTitle(clean);
    assert.equal(fromCtx && fromCtx.key, key, `context: ${title}`);
    assert.equal(fromCtx.tracker, 'jira');
  }
  for (const title of ['[ENG-4] Ship it - Linear', 'UTF-8 encoding - Google Search', 'Boards - Jira']) {
    assert.equal(browser.parseJiraTitle(title), null, title);
  }
  assert.deepEqual(browser.detectJira('https://acme.atlassian.net/browse/ABC-9', 'Fix it - ABC-9 - Jira - Brave'), { key: 'ABC-9', baseUrl: 'https://acme.atlassian.net', summary: 'Fix it' });
});

test('Computer.browserTab: in the action queue, the caller\'s check, then the pause guard and the failsafe, before any key', async () => {
  const order = [];
  const driver = createMockDriver({
    windows: [{ id: '0x11', app: 'Brave', title: '[ABC-1] x - Jira - Brave', stackIndex: 0 }],
    tabs: { '0x11': { url: 'https://acme.atlassian.net/browse/ABC-1', text: 'x' } },
  });
  const inner = driver.browserTab.bind(driver);
  driver.browserTab = async (opts) => {
    order.push('driver');
    await opts.beforeInput();
    order.push('keys');
    return inner({ ...opts, beforeInput: async () => {} });
  };
  let allowed = true;
  const comp = new Computer({
    driver,
    config: { actionDelayMs: 0, failsafe: true },
    guard: async () => {
      order.push('guard');
      return allowed ? { allowed: true } : { allowed: false, reason: 'paused in the dialog' };
    },
  });
  driver.setCursor(500, 500);
  const res = await comp.browserTab({ app: 'brave', includeText: true, beforeInput: async () => order.push('caller') });
  assert.equal(res.url, 'https://acme.atlassian.net/browse/ABC-1');
  assert.deepEqual(order, ['driver', 'caller', 'guard', 'keys']);

  allowed = false;
  order.length = 0;
  await assert.rejects(comp.browserTab({ app: 'brave', includeText: true }), (e) => e.code === 'PAUSED');
  assert.ok(!order.includes('keys'), 'no keys while paused');

  allowed = true;
  driver.setCursor(0, 0);
  order.length = 0;
  await assert.rejects(comp.browserTab({ app: 'brave', includeText: true }), (e) => e.code === 'FAILSAFE');
  assert.ok(!order.includes('keys'), 'no keys with the mouse in the corner');

  const bare = new Computer({ driver: { name: 'none', displays: async () => [] }, config: { actionDelayMs: 0 } });
  await assert.rejects(bare.browserTab({}), (e) => e.code === 'UNSUPPORTED');
});

test('MCP instructions point Claude at the ticket tools; switch_project only in the dialog\'s own session', () => {
  for (const role of ['engine', 'interactive']) {
    const text = buildInstructions(role);
    assert.match(text, /read_browser_tab/);
    assert.match(text, /jira_get_issue/);
    assert.match(text, /anywhere jira setup/);
    assert.match(text, /find_repos/);
  }
  assert.match(buildInstructions('engine'), /switch_project/);
  assert.doesNotMatch(buildInstructions('interactive'), /switch_project/);
});

test('terminal dialog: a hand-off task shows as Claude\'s, on one line', () => {
  const T = require('../src/tui/tui');
  assert.equal(T.renderUserMessage({ text: 'Work on ABC-1 in shop-api.\n\nPlan: raise the TTL.\nTests: add one.', source: 'handoff' }), 'Claude (handed over): Work on ABC-1 in shop-api. (+2 more lines)');
  assert.equal(T.renderUserMessage({ text: 'Only one line', source: 'handoff' }), 'Claude (handed over): Only one line');
  assert.equal(T.renderUserMessage({ text: 'hi', source: 'cli' }), 'You (cli): hi');
});

// ------------------------------------------------------------------ the dialog (headless Chromium)

function findChrome() {
  const candidates = [];
  if (process.env.ANYWHERE_TEST_CHROME) candidates.push(process.env.ANYWHERE_TEST_CHROME);
  const pw = '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(pw)) if (/^chromium/.test(d)) candidates.push(path.join(pw, d, 'chrome-linux', 'chrome'));
  } catch {
    /* none */
  }
  if (process.platform !== 'win32') {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
      try {
        const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (p) candidates.push(p);
      } catch {
        /* not installed */
      }
    }
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

async function openPage(chrome) {
  const { launchChrome } = require('./fixtures/chrome-launch');
  const { port, cleanup } = await launchChrome(chrome, { prefix: 'anywhere-chrome-feat-', extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = (id += 1);
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 440, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.bringToFront');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.result.value;
  };
  const close = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return cleanup();
  };
  return { send, evaluate, problems, close };
}

const SPEECH_PROBE = `(() => {
  window.__spoken = [];
  const synth = {
    speaking: false,
    getVoices: () => [{ name: 'Google US English', lang: 'en-US', default: true, localService: false, voiceURI: 'g' }],
    speak(u) { window.__spoken.push(u.text); setTimeout(() => { if (u.onend) u.onend({}); }, 30); },
    cancel() {}, resume() {}, pause() {}, addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
})()`;

test('headless Chromium: the page reports its visibility on connect, leaves spoken notes to the announcer, and labels a hand-off', async (t) => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chromium found (set ANYWHERE_TEST_CHROME)');
  if (typeof globalThis.WebSocket !== 'function') return t.skip('needs a global WebSocket (Node >= 22)');
  const { createStubServer } = require('./fixtures/ui-stub-server');
  const stub = await createStubServer({ token: 'tok', scenario: 'empty' });
  t.after(() => stub.close());
  const page = await openPage(chrome);
  t.after(() => page.close());
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SPEECH_PROBE });
  await page.send('Page.navigate', { url: stub.url });
  const until = async (expr, ms = 6000) => waitFor(() => page.evaluate(expr), ms);
  assert.ok(await until(`document.getElementById('status') && document.getElementById('status').dataset.state === 'idle'`), 'dialog connects');

  // Reported as soon as the event stream opened (no 'show' event was sent).
  assert.ok(await waitFor(() => stub.state.visibility.length >= 1), 'visibility reported on connect');
  assert.equal(stub.state.visibility[0].visible, true);

  // With the announcer, a spoken note arrives as 'announce' only: the notify event stays quiet.
  stub.broadcast('notify', { text: 'Halfway there.', level: 'info', speak: true });
  await tick(600);
  assert.deepEqual(await page.evaluate('window.__spoken'), [], 'not spoken by the page');
  stub.announce({ kind: 'info', text: 'Halfway there.', audio: false, chime: false });
  assert.ok(await until(`window.__spoken.includes('Halfway there.')`), 'the announcement is spoken');

  // An older daemon without the announcer: the page speaks the note itself, as before.
  stub.state.voiceInfo.announcer = false;
  stub.broadcast('snapshot', stub.snapshot());
  await tick(200);
  stub.broadcast('notify', { text: 'Old daemon note.', level: 'info', speak: true });
  assert.ok(await until(`window.__spoken.includes('Old daemon note.')`), 'spoken without the announcer');

  // A hand-off task: labelled and collapsed to its first line.
  const task = `Work on ABC-123 "Fix login timeout" in this repository.\n\n${'Acceptance criteria and the plan. '.repeat(20)}`;
  stub.broadcast('message', { id: 'u-handoff', role: 'user', text: task, source: 'handoff', ts: new Date().toISOString(), images: 0 });
  assert.ok(await until(`!!document.querySelector('.msg.user.handoff[data-id="u-handoff"]')`), 'hand-off item rendered');
  const shown = await page.evaluate(`(() => {
    const n = document.querySelector('.msg.user.handoff[data-id="u-handoff"]');
    const d = n.querySelector('details.handoff-task');
    return { meta: n.querySelector('.msg-meta').textContent, open: d ? d.open : null, summary: d ? d.querySelector('summary').textContent : null };
  })()`);
  assert.match(shown.meta, /Handed over by Claude/);
  assert.equal(shown.open, false, 'collapsed');
  assert.equal(shown.summary, 'Work on ABC-123 "Fix login timeout" in this repository.');
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});
