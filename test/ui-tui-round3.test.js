'use strict';

/**
 * Round-3 regression tests for the dialog (src/ui) and the terminal dialog (src/tui):
 *  - REGRESSIONS-R2-6 / LIVE-E2E-R3-3: critical approvals need a deliberate act. A spoken "yes"
 *    never allows one in the dialog (voice can still deny); the TUI allows one only for the
 *    typed word "allow" (not y, always, or anything spoken). Decisions carry `via`.
 *  - LIVE-E2E-R3-10: the TUI uses ASCII symbols outside a UTF-8 locale (LANG unset, C, POSIX).
 *  - LIVE-E2E-R3-12: a recorder that exists but fails is not answered with "install a recorder".
 *  - LIVE-E2E-R3-14: in bridge mode the footer names the Claude Code terminal, not the
 *    companion session's model and cost.
 *
 * The browser cases drive headless Chromium against test/fixtures/ui-stub-server.js; they are
 * skipped without a Chromium binary (set ANYWHERE_TEST_CHROME) or a global WebSocket (Node < 22).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const T = require('../src/tui/tui');
const { launchChrome } = require('./fixtures/chrome-launch');
const { createStubServer } = require('./fixtures/ui-stub-server');

const NON_ASCII = /[^\x00-\x7f]/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = (ms = 10) => sleep(ms);

// ------------------------------------------------------------------ LIVE-E2E-R3-10: locale

test('unicodeSupported follows the locale on POSIX, with ASCII/Unicode overrides (LIVE-E2E-R3-10)', () => {
  const u = T.unicodeSupported;
  // A UTF-8 locale, however it is spelled, and whichever variable carries it.
  for (const LANG of ['en_US.UTF-8', 'C.UTF-8', 'de_DE.utf8', 'en_GB.Utf-8']) assert.equal(u({ LANG }, 'linux'), true, LANG);
  assert.equal(u({ LC_CTYPE: 'UTF-8' }, 'darwin'), true, 'macOS terminals set LC_CTYPE=UTF-8');
  assert.equal(u({ LC_ALL: 'en_US.UTF-8', LANG: 'C' }, 'linux'), true, 'LC_ALL wins over LANG');
  assert.equal(u({ LC_CTYPE: 'en_US.UTF-8', LANG: 'C' }, 'linux'), true, 'LC_CTYPE wins over LANG');
  assert.equal(u({ LC_ALL: '', LANG: 'en_US.UTF-8' }, 'linux'), true, 'an empty LC_ALL is ignored');
  // Not UTF-8: explicit C/POSIX, a Latin-1 codeset, or nothing set (the C library's "C").
  for (const env of [{ LANG: 'C' }, { LANG: 'POSIX' }, { LC_ALL: 'C', LANG: 'en_US.UTF-8' }, { LANG: 'en_US.ISO-8859-1' }, { LANG: 'en_US' }, {}]) {
    assert.equal(u(env, 'linux'), false, JSON.stringify(env));
    assert.equal(u(env, 'freebsd'), false, `freebsd ${JSON.stringify(env)}`);
  }
  assert.equal(u({}, 'darwin'), true, 'macOS terminals are UTF-8 whatever the environment says');
  assert.equal(u({ LANG: 'C' }, 'darwin'), false, 'but an explicit C locale is honoured');
  // TERM=dumb and the Linux console get ASCII even under a UTF-8 locale.
  assert.equal(u({ LANG: 'en_US.UTF-8', TERM: 'dumb' }, 'linux'), false);
  assert.equal(u({ LANG: 'en_US.UTF-8', TERM: 'linux' }, 'linux'), false);
  assert.equal(u({ LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }, 'linux'), true);
  // Overrides: ASCII wins over everything; ANYWHERE_UNICODE=1 forces the symbols.
  assert.equal(u({ ANYWHERE_ASCII: '1', ANYWHERE_UNICODE: '1', LANG: 'en_US.UTF-8' }, 'linux'), false);
  assert.equal(u({ ANYWHERE_UNICODE: '1' }, 'linux'), true);
  assert.equal(u({ ANYWHERE_UNICODE: '1', TERM: 'linux' }, 'linux'), true);
  assert.equal(u({ ANYWHERE_UNICODE: '1' }, 'win32'), true);
  // Windows keeps its terminal heuristics; LANG (Git Bash sets it) does not change them.
  assert.equal(u({ LANG: 'en_US.UTF-8' }, 'win32'), false);
  assert.equal(u({ WT_SESSION: 'x' }, 'win32'), true);
  assert.equal(u({ TERM: 'xterm' }, 'win32'), true);
});

test('ASCII theme: the header, status, tool rows and approval cards print no non-ASCII chrome (LIVE-E2E-R3-10)', () => {
  const ascii = T.createTheme({ color: false, unicode: false });
  const snap = {
    version: '0.1.0',
    mode: 'companion',
    status: 'acting',
    statusDetail: 'Run command',
    project: { dir: '/tmp/r3/proj', name: 'proj', git: { branch: 'main', dirty: true } },
    session: { id: 'abcdef123456', model: 'haiku', costUsd: 0.01, turns: 2 },
    voice: { serverStt: true, sttProvider: 'groq', serverTts: false },
    platform: { platform: 'linux', displayServer: 'x11', driver: 'x11' },
    pending: { approvals: [{}], questions: [] },
  };
  const out = [
    T.renderHeader(snap, ascii),
    T.renderStatusLine('acting', 'Run command', ascii),
    T.renderStatusSummary(snap, ascii),
    T.renderToolRow({ displayName: 'Run command', summary: 'x'.repeat(300), status: 'error', output: `fail ${'y'.repeat(300)}` }, ascii),
    T.renderResult({ isError: true, text: 'z'.repeat(400), costUsd: 0.01, durationMs: 1200 }, ascii),
    T.renderApproval({ toolName: 'Bash', summary: 'w'.repeat(800), risk: 'critical', reason: 'Recursively deletes your home directory' }, ascii),
  ].join('\n');
  assert.doesNotMatch(out, NON_ASCII, out.split('\n').find((l) => NON_ASCII.test(l)));
  assert.match(out, /v0\.1\.0 - terminal dialog/);
  assert.match(out, /Project: proj \(\/tmp\/r3\/proj\) - Mode: companion - Status: acting/);
  assert.match(out, /- acting - Run command/);
  assert.match(out, /x{90,}\.\.\. \.\.\. x /, 'a long summary is cut with "..."');
});

/** A stand-in DaemonClient (as in tui.test.js). */
function fakeClient(responses = {}) {
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
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(body);
      return r || { ok: true };
    },
    async postBinary(p, buf, ct) {
      calls.push({ method: 'POST', path: p, binary: buf, contentType: ct });
      const r = responses[`BINARY ${p.split('?')[0]}`];
      if (r instanceof Error) throw r;
      return r || { text: '' };
    },
  };
}

function capture() {
  const out = new PassThrough();
  let text = '';
  out.on('data', (d) => {
    text += d.toString();
  });
  return {
    out,
    get text() {
      return text;
    },
  };
}

async function startTui({ env = { NO_COLOR: '1', LANG: 'en_US.UTF-8' }, responses, deps = {}, tty = false } = {}) {
  const client = fakeClient(responses);
  const input = new PassThrough();
  const cap = capture();
  if (tty) {
    input.isTTY = true;
    input.setRawMode = () => input;
    cap.out.isTTY = true;
    cap.out.columns = 120;
  }
  const tui = new T.Tui({ client, input, output: cap.out, env, platform: 'linux', cwd: '/w', homedir: '/h', ...deps });
  const done = tui.run();
  await tick();
  return { tui, client, input, cap, done };
}

const SNAPSHOT = {
  version: '0.1.0',
  mode: 'companion',
  status: 'idle',
  project: { dir: '/tmp/r3/proj', name: 'proj' },
  session: { id: 's1', model: 'haiku' },
  config: { voice: { language: 'en-US' } },
  messages: [],
  pending: { approvals: [], questions: [] },
};

test('TUI in a POSIX locale (LANG unset): the terminal shows ASCII, not mojibake (LIVE-E2E-R3-10)', async () => {
  const { tui, client, cap, done } = await startTui({ env: { NO_COLOR: '1', TERM: 'xterm' }, tty: true });
  client.emit('snapshot', SNAPSHOT);
  client.emit('status', { status: 'thinking' });
  client.emit('message', { id: 'x1', role: 'tool', toolUseId: 't1', displayName: 'Run command', summary: 'ls', status: 'running' });
  client.emit('tool_update', { toolUseId: 't1', status: 'ok' });
  client.emit('approval_request', { id: 'ap1', toolName: 'Bash', displayName: 'Run command', summary: 'touch config.json', risk: 'critical', reason: 'Writes to the Claude Anywhere settings (self-escalation)' });
  await tui.handleInput('/status');
  client.emit('_disconnected', {});
  tui.quit();
  await done;
  const t = cap.text;
  assert.match(t, /Connecting to Claude Anywhere\.\.\./);
  assert.match(t, /v0\.1\.0 - terminal dialog/);
  assert.match(t, /reconnecting\.\.\. \(\/quit to leave\)/);
  assert.match(t, /critical: type allow \/ \[n\]o > /, 'the prompt arrow is ASCII');
  assert.doesNotMatch(t, NON_ASCII, t.split('\n').find((l) => NON_ASCII.test(l)));
});

// ------------------------------------------------------------------ R2-6 / R3-3: TUI policy

test('criticalRefusal: only the typed word "allow" allows a critical card; deny always works', () => {
  const ans = (s) => T.parseApprovalAnswer(s);
  for (const s of ['allow', 'Allow.', 'allow once', 'ALLOW please']) assert.equal(T.criticalRefusal(ans(s), s, 'typed'), null, s);
  for (const s of ['y', 'yes', 'ok', 'okay', 'sure', 'go ahead', 'allow it', 'yes allow']) assert.match(T.criticalRefusal(ans(s), s, 'typed'), /type allow \(the whole word\)/, s);
  for (const s of ['a', 'always', 'allow for this session']) assert.match(T.criticalRefusal(ans(s), s, 'typed'), /cannot be allowed for the whole session/, s);
  for (const s of ['allow', 'yes', 'always']) assert.match(T.criticalRefusal(ans(s), s, 'voice'), /not allowed by voice/, s);
  for (const via of ['typed', 'voice']) {
    assert.equal(T.criticalRefusal(ans('n'), 'n', via), null);
    assert.equal(T.criticalRefusal(ans('no, use the staging bucket'), 'no, use the staging bucket', via), null);
  }
});

test('TUI: a critical card needs the typed word "allow"; y, always and voice are refused (REGRESSIONS-R2-6, LIVE-E2E-R3-3)', async () => {
  const responses = { 'BINARY /api/stt': { text: 'Yes.' } };
  const { tui, client, input, cap, done } = await startTui({ responses });
  client.emit('snapshot', SNAPSHOT);
  const crit = { id: 'ap_c', toolName: 'Bash', displayName: 'Run command', summary: 'touch ~/.claude-anywhere/config.json', risk: 'critical', reason: 'Writes to the Claude Anywhere settings (self-escalation)' };
  client.emit('approval_request', crit);
  await tui.handleInput('y');
  await tui.handleInput('a');
  await tui.handleInput('allow it');
  await tui.transcribeAndSend(Buffer.alloc(8000));
  assert.deepEqual(client.calls.filter((c) => c.path === '/api/approval'), [], 'nothing was allowed');
  assert.equal(tui.prompts.length, 1, 'the card is still waiting');
  await tui.handleInput('allow');
  // A second critical card: denied by voice, which stays allowed.
  client.emit('approval_request', { ...crit, id: 'ap_c2' });
  responses['BINARY /api/stt'] = { text: 'No, leave the settings alone' };
  await tui.transcribeAndSend(Buffer.alloc(8000));
  // A high-risk card is still allowed by "y", and by voice.
  client.emit('approval_request', { id: 'ap_h', toolName: 'Bash', summary: 'npm publish', risk: 'high' });
  await tui.handleInput('y');
  client.emit('approval_request', { id: 'ap_h2', toolName: 'Bash', summary: 'npm publish', risk: 'high' });
  responses['BINARY /api/stt'] = { text: 'yes please' };
  await tui.transcribeAndSend(Buffer.alloc(8000));
  input.write('/quit\n');
  await done;
  assert.deepEqual(
    client.calls.filter((c) => c.path === '/api/approval').map((c) => c.body),
    [
      { id: 'ap_c', decision: 'allow', via: 'typed' },
      { id: 'ap_c2', decision: 'deny', message: 'leave the settings alone', via: 'voice' },
      { id: 'ap_h', decision: 'allow', via: 'typed' },
      { id: 'ap_h2', decision: 'allow', via: 'voice' },
    ]
  );
  const t = cap.text;
  assert.match(t, /Critical action: type allow \(the whole word\) to allow it once; y and voice are not enough\. n denies\./, 'the card says how');
  assert.match(t, /This is a critical action: type allow \(the whole word\) to allow it once, or n to deny\./);
  assert.match(t, /Critical actions always ask: they cannot be allowed for the whole session\./);
  assert.match(t, /Critical actions are not allowed by voice: type allow/);
  assert.match(t, /\[y\]es \/ \[a\]lways \/ \[n\]o/, 'non-critical cards keep the short answers');
});

test('TUI: the prompt for a critical card asks for "allow" (REGRESSIONS-R2-6)', async () => {
  const { tui, client, cap, done } = await startTui({ tty: true });
  client.emit('snapshot', SNAPSHOT);
  client.emit('approval_request', { id: 'ap_c', toolName: 'Bash', summary: 'rm -rf ~', risk: 'critical' });
  await tick();
  assert.match(cap.text, /critical: type allow \/ \[n\]o › /);
  tui.quit();
  await done;
});

// ------------------------------------------------------------------ LIVE-E2E-R3-12: recorder failure

/** spawn() for a recorder that dies on its own: an exit code, or a spawn error. */
function failingSpawn({ code = 1, stderr = '', error = null } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setTimeout(() => {
      if (stderr) child.stderr.write(stderr);
      setTimeout(() => (error ? child.emit('error', error) : child.emit('exit', code, null)), 5);
    }, 5);
    return child;
  };
}

test('TUI /voice: a recorder that runs but finds no device does not say "install a recorder" (LIVE-E2E-R3-12)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-r3-rec-'));
  try {
    const which = (n) => (n === 'ffmpeg' ? '/usr/bin/ffmpeg' : null);
    const alsa = "ALSA lib confmisc.c:855:(parse_card) cannot find card '0'\n";
    let s = await startTui({ deps: { which, tmpdir: tmp, spawn: failingSpawn({ code: 251, stderr: alsa }) } });
    s.client.emit('snapshot', SNAPSHOT);
    await s.tui.handleInput('/voice');
    await tick(60);
    s.input.write('/quit\n');
    await s.done;
    assert.match(s.cap.text, /Recording with ffmpeg failed \(exit code 251\): ALSA lib confmisc\.c:855:\(parse_card\) cannot find card '0'\. No working microphone or input device was found\. Check the system sound settings; over SSH there is usually no audio device \(set PULSE_SERVER, or use the dialog in a browser\)\./);
    assert.doesNotMatch(s.cap.text, /Install one with/);

    // A plain exit code 1 with nothing on stderr: the same device hint.
    s = await startTui({ deps: { which, tmpdir: tmp, spawn: failingSpawn({ code: 1 }) } });
    s.client.emit('snapshot', SNAPSHOT);
    await s.tui.handleInput('/voice');
    await tick(60);
    s.input.write('/quit\n');
    await s.done;
    assert.match(s.cap.text, /Recording with ffmpeg failed \(exit code 1\)\. No working microphone or input device was found\./);
    assert.doesNotMatch(s.cap.text, /Install one with/);

    // The recorder vanished between the lookup and the spawn: then installing one is the advice.
    s = await startTui({ deps: { which, tmpdir: tmp, spawn: failingSpawn({ error: Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) }) } });
    s.client.emit('snapshot', SNAPSHOT);
    await s.tui.handleInput('/voice');
    await tick(60);
    s.input.write('/quit\n');
    await s.done;
    assert.match(s.cap.text, /Recording with ffmpeg failed \(\/usr\/bin\/ffmpeg was not found\)\. Install one with: sudo apt install sox/);
    assert.doesNotMatch(s.cap.text, /No working microphone/);
    assert.deepEqual(fs.readdirSync(tmp), [], 'no audio files left behind');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('noInputDeviceHint names the right settings per platform (LIVE-E2E-R3-12)', () => {
  assert.match(T.noInputDeviceHint('linux'), /PULSE_SERVER/);
  assert.match(T.noInputDeviceHint('darwin'), /Privacy & Security > Microphone/);
  assert.match(T.noInputDeviceHint('win32'), /Windows Settings > Privacy > Microphone/);
  for (const p of ['linux', 'darwin', 'win32']) assert.doesNotMatch(T.noInputDeviceHint(p), /Install/);
});

// ------------------------------------------------------------------ headless Chromium

function findChrome() {
  if (process.env.ANYWHERE_TEST_CHROME) return fs.existsSync(process.env.ANYWHERE_TEST_CHROME) ? process.env.ANYWHERE_TEST_CHROME : null;
  const candidates = [];
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) candidates.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'));
  } catch {
    /* not a Playwright image */
  }
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge']) {
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

function browserSkip(t) {
  const chrome = findChrome();
  if (!chrome) {
    t.skip('no Chromium found (set ANYWHERE_TEST_CHROME)');
    return null;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('needs a global WebSocket (Node >= 22)');
    return null;
  }
  return chrome;
}

/** Tiny CDP client over the page WebSocket (as in ui-round2.test.js). */
async function openPage(chrome, { width = 440, height = 720 } = {}) {
  const { port, cleanup } = await launchChrome(chrome, { prefix: 'anywhere-chrome-r3-' });
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = (id += 1);
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
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
    cleanup();
  };
  return { send, evaluate, problems, close };
}

async function waitFor(page, expr, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(expr)) return true;
    await sleep(100);
  }
  return false;
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

async function postStub(stub, p, body) {
  const r = await fetch(`http://127.0.0.1:${stub.port}${p}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stub.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

const toasts = `[...document.querySelectorAll('#toasts .toast-text')].map((t) => t.textContent).join(' | ')`;

// A stand-in for the Web Speech API whose recognizer the test can make "hear" a phrase.
const FAKE_SPEECH = `(() => {
  class FakeSR {
    constructor() { window.__recognizer = this; }
    start() { setTimeout(() => this.onstart && this.onstart(), 0); }
    stop() { setTimeout(() => this.onend && this.onend(), 0); }
    abort() {}
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
  window.__hear = (text) => {
    const result = [{ transcript: text, confidence: 0.9 }];
    result.isFinal = true;
    window.__recognizer.onresult({ resultIndex: 0, results: [result] });
  };
})()`;

test('headless Chromium: a spoken "yes" never allows a critical card; voice deny and a click still work (REGRESSIONS-R2-6, LIVE-E2E-R3-3)', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty' });
  t.after(() => stub.close());
  stub.state.config.voice.handsFree = true; // wake word "hey claude"
  const page = await openPage(chrome, { width: 1024, height: 768 });
  t.after(() => page.close());
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_SPEECH });
  // Opened like Claude Anywhere opens its dialog window: a launch code that also gives the dialog credential.
  await page.send('Page.navigate', { url: stub.launchUrl });
  assert.ok(await waitFor(page, `document.getElementById('mic')?.dataset.phase === 'wake'`), 'hands-free listens for the wake word');

  const card = (id, risk, summary) => ({ id, toolName: 'Bash', displayName: 'Run command', summary, input: { command: summary }, risk, reason: risk === 'critical' ? 'Writes to the Claude Anywhere settings (self-escalation)' : '', ts: new Date().toISOString(), timeoutSec: 600 });
  const show = async (c) => {
    stub.state.approvals.set(c.id, c);
    stub.broadcast('status', { status: 'waiting_approval', detail: 'Waiting for your approval' });
    stub.broadcast('approval_request', c);
    assert.ok(await waitFor(page, `Boolean(document.querySelector('.card.approval[data-id="${c.id}"]'))`), `card ${c.id} shown`);
  };

  // The live failure: "Hey Claude, yes." allowed a critical self-escalation.
  await show(card('ap_crit', 'critical', 'touch /tmp/anywhere-r3-home/config.json'));
  for (const phrase of ['Hey Claude, yes.', 'Hey Claude, okay', 'Hey Claude, always']) {
    await page.evaluate(`window.__hear(${JSON.stringify(phrase)})`);
    await sleep(400);
    assert.deepEqual(stub.state.decisions, [], `"${phrase}" decided nothing`);
  }
  assert.equal(await page.evaluate(`Boolean(document.querySelector('.card.approval[data-id="ap_crit"]:not(.busy)'))`), true, 'the card stays open');
  assert.match(await page.evaluate(toasts), /Critical actions need a click: press “Allow once” on the card/);
  // Saying "no" still denies it, and the daemon is told it was a voice decision.
  await page.evaluate(`window.__hear('Hey Claude, no, leave the settings alone')`);
  assert.ok(await until(() => stub.state.decisions.length === 1), 'voice deny decided it');
  assert.deepEqual(stub.state.approvalBodies, [{ id: 'ap_crit', decision: 'deny', message: 'leave the settings alone', via: 'voice' }]);
  assert.ok(await waitFor(page, `!document.querySelector('.card.approval')`));

  // A high-risk card is still allowed by voice.
  await show(card('ap_high', 'high', 'npm publish'));
  await page.evaluate(`window.__hear('Hey Claude, yes')`);
  assert.ok(await until(() => stub.state.decisions.length === 2), 'voice allowed the high-risk card');
  assert.deepEqual(stub.state.approvalBodies[1], { id: 'ap_high', decision: 'allow', via: 'voice' });
  assert.ok(await waitFor(page, `!document.querySelector('.card.approval')`));

  // A critical card behind the spoken refusal is still allowed with a click.
  await show(card('ap_crit2', 'critical', 'rm -rf ~'));
  await page.evaluate(`window.__hear('Hey Claude, what does that do')`);
  assert.ok(await waitFor(page, `${toasts}.includes('approval of a critical action. Click “Allow once” on the card, or say “no”.')`), 'the reminder names the click');
  await page.evaluate(`document.querySelector('.card.approval[data-id="ap_crit2"] .btn-primary').click()`);
  assert.ok(await until(() => stub.state.decisions.length === 3), 'the click decided it');
  assert.deepEqual(stub.state.approvalBodies[2], { id: 'ap_crit2', decision: 'allow', via: 'click' });
  assert.equal(stub.state.approvalHeaders[2].ui, stub.uiKey, 'the click carries the dialog credential (F3-SAFE-D1)');
  assert.equal(stub.state.approvalHeaders[2].origin, `http://127.0.0.1:${stub.port}`);
  assert.deepEqual(stub.state.commands, [], 'no spoken phrase was sent to Claude as a request');
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: in bridge mode the footer names the Claude Code terminal, not the companion model and cost (LIVE-E2E-R3-14)', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty' });
  t.after(() => stub.close());
  const page = await openPage(chrome);
  t.after(() => page.close());
  await page.send('Page.navigate', { url: stub.url });
  assert.ok(await waitFor(page, `document.getElementById('status')?.dataset.state === 'idle'`), 'dialog connects');
  const footer = `({ model: document.getElementById('sb-model').textContent, title: document.getElementById('sb-model').title, cost: !document.getElementById('sb-cost').hidden, sep: !document.getElementById('sb-cost-sep').hidden })`;
  assert.deepEqual(await page.evaluate(footer), { model: 'claude-opus-4', title: 'Model: claude-opus-4', cost: true, sep: true });

  // Another client (the /anywhere here skill) switches to bridge: the 'mode' event updates it.
  await postStub(stub, '/api/mode', { mode: 'bridge' });
  assert.ok(await waitFor(page, `document.getElementById('sb-model').textContent === 'Claude Code terminal'`), 'footer follows the mode event');
  assert.deepEqual(await page.evaluate(footer), { model: 'Claude Code terminal', title: 'Commands run in your Claude Code terminal; its model and cost show there', cost: false, sep: false });
  // A session update (bridge results carry costUsd 0) does not bring the companion model back.
  stub.broadcast('session', { model: 'claude-haiku-5-5', costUsd: 0 });
  await sleep(200);
  assert.equal(await page.evaluate(`document.getElementById('sb-model').textContent`), 'Claude Code terminal');
  // A reload in bridge mode (the snapshot path) shows the same.
  await page.send('Page.navigate', { url: stub.url });
  assert.ok(await waitFor(page, `document.getElementById('mode-label')?.textContent === 'Bridge'`), 'reloaded in bridge mode');
  assert.deepEqual(await page.evaluate(footer), { model: 'Claude Code terminal', title: 'Commands run in your Claude Code terminal; its model and cost show there', cost: false, sep: false });

  // Back to companion from the mode menu: the model and cost return.
  await page.evaluate(`document.getElementById('mode-badge').click()`);
  assert.ok(await waitFor(page, `!document.getElementById('mode-pop').hidden`));
  await page.evaluate(`document.querySelector('#mode-pop .pop-option[data-mode="companion"]').click()`);
  assert.ok(await waitFor(page, `document.getElementById('sb-model').textContent !== 'Claude Code terminal'`), 'footer follows setMode');
  const back = await page.evaluate(footer);
  assert.equal(back.cost, true);
  assert.equal(back.sep, true);
  assert.match(back.model, /^claude-/);
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});
