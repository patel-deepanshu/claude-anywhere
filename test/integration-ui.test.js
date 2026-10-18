'use strict';

/**
 * UI integration:
 *  1. The real daemon server (src/daemon/server.js) serves every file the
 *     dialog references, with the right MIME type and the CSP.
 *  2. Headless Chromium loads the dialog against the UI stub server and the
 *     page renders with no console errors or exceptions, keyboard shortcuts
 *     and approval/question cards work. Skipped without a Chromium binary
 *     (set ANYWHERE_TEST_CHROME) or without a global WebSocket (Node < 22).
 * Neither needs a display or the network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { launchChrome } = require('./fixtures/chrome-launch');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'src', 'ui');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-ui-int-'));
process.env.ANYWHERE_HOME = HOME;

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', reject);
  });
}

test('daemon server serves every dialog asset with the right type and CSP', async (t) => {
  let createServer;
  try {
    ({ createServer } = require('../src/daemon/server'));
  } catch (err) {
    t.skip(`daemon server not available yet (${err.message})`);
    return;
  }
  const noop = () => {};
  const srv = createServer({
    hub: { addClient: noop, broadcast: noop, clientCount: () => 0, close: noop, on: noop },
    session: { snapshot: () => ({}), projectDir: ROOT, guard: () => ({ allowed: true }) },
    permissions: null,
    questions: { pending: () => [], answer: () => false },
    bridge: null,
    config: {},
    token: 'tok',
    instanceId: 'test',
    version: '0.0.0',
    uiDir: UI,
  });
  const port = await srv.listen(0);
  t.after(() => srv.close());
  const page = await get(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Claude Anywhere<\/title>/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  const refs = [...page.body.matchAll(/\s(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1]);
  const files = new Set([...refs, 'app.js', 'voice.js', 'markdown.js', 'wav-recorder.js', 'wav-worklet.js', 'app.css', 'icon.svg']);
  const types = { '.js': /^text\/javascript/, '.css': /^text\/css/, '.svg': /^image\/svg\+xml/ };
  for (const f of files) {
    const r = await get(port, `/${f}`);
    assert.equal(r.status, 200, f);
    const want = types[path.extname(f)];
    if (want) assert.match(r.headers['content-type'], want, f);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', f);
  }
});

// ------------------------------------------------------------------ headless Chromium

function findChrome() {
  if (process.env.ANYWHERE_TEST_CHROME) return fs.existsSync(process.env.ANYWHERE_TEST_CHROME) ? process.env.ANYWHERE_TEST_CHROME : null;
  const candidates = [];
  const pw = '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(pw)) if (/^chromium-\d+$/.test(d)) candidates.push(path.join(pw, d, 'chrome-linux', 'chrome'));
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

/** Tiny CDP client over the browser's page WebSocket. */
async function openPage(chrome, { width, height, scheme }) {
  const { port, cleanup } = await launchChrome(chrome, {
    extraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    prefix: 'anywhere-chrome-',
  });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((x) => x.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push(`log: ${m.params.entry.text} ${m.params.entry.url || ''}`);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = (id += 1);
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  // Behave like a focused window, so focus events fire as they do for a user.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.bringToFront');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (page, expr, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(expr)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

test('headless Chromium: a ?launch= code is traded for the token before the first API call (SECURITY-7)', async (t) => {
  const chrome = findChrome();
  if (!chrome) {
    t.skip('no Chromium found (set ANYWHERE_TEST_CHROME)');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('needs a global WebSocket (Node >= 22)');
    return;
  }
  const { createServer } = require('../src/daemon/server');
  const noop = () => {};
  const authSeen = [];
  const srv = createServer({
    hub: { addClient: (req) => authSeen.push(new URL(req.url, 'http://x').searchParams.get('token')), broadcast: noop, clientCount: () => 0, close: noop, on: noop },
    session: { snapshot: () => ({}), projectDir: ROOT, guard: () => ({ allowed: true }) },
    permissions: null,
    questions: { pending: () => [], answer: () => false },
    bridge: null,
    config: {},
    token: 'launch-tok',
    instanceId: 'test',
    version: '0.0.0',
    uiDir: UI,
  });
  await srv.listen(0);
  t.after(() => srv.close());
  const page = await openPage(chrome, { width: 440, height: 720, scheme: 'light' });
  try {
    const url = srv.launchUrl();
    assert.ok(!url.includes('launch-tok'));
    await page.send('Page.navigate', { url });
    assert.ok(await waitFor(page, `sessionStorage.getItem('anywhere.token') === 'launch-tok'`), 'token stored after the exchange');
    assert.equal(await page.evaluate('location.search'), '', 'launch code removed from the address bar');
    assert.equal(srv.launchCodes.size, 0, 'the code was used up');
    const end = Date.now() + 5000;
    while (!authSeen.length && Date.now() < end) await sleep(50);
    assert.deepEqual(authSeen.slice(0, 1), ['launch-tok'], 'the event stream connects with the traded token');
  } finally {
    page.close();
  }
});

test('headless Chromium renders the dialog against the stub with no errors', async (t) => {
  const chrome = findChrome();
  if (!chrome) {
    t.skip('no Chromium found (set ANYWHERE_TEST_CHROME)');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('needs a global WebSocket (Node >= 22)');
    return;
  }
  const { createStubServer } = require('./fixtures/ui-stub-server');
  const stub = await createStubServer({ token: 'tok' });
  t.after(() => stub.close());
  for (const [width, height, scheme] of [[440, 720, 'light'], [1024, 768, 'dark']]) {
    const page = await openPage(chrome, { width, height, scheme });
    try {
      await page.send('Page.navigate', { url: stub.url });
      assert.ok(await waitFor(page, `document.querySelectorAll('#items .tool').length >= 3 && document.querySelector('.card.approval') !== null`), 'transcript and cards render');
      assert.ok(await waitFor(page, `[...document.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('which project to use'))`), 'streamed deltas render');
      assert.ok(await waitFor(page, `document.getElementById('status').dataset.state === 'waiting'`), 'status pill follows status events');
      const info = await page.evaluate(`(${() => ({
        title: document.title,
        tokenInUrl: location.search.includes('token'),
        overflow: document.documentElement.scrollWidth > innerWidth,
        pill: document.getElementById('status').dataset.state,
        project: document.getElementById('project-name').textContent,
        thumbs: document.querySelectorAll('.tool-thumb img').length,
        codeCopy: document.querySelectorAll('.codeblock .copy-btn').length,
        focusFn: typeof window.anywhereFocusInput,
      })})()`);
      assert.equal(info.title, 'Claude Anywhere');
      assert.equal(info.tokenInUrl, false, 'token is removed from the address bar');
      assert.equal(info.overflow, false, `no horizontal scroll at ${width}px`);
      assert.equal(info.pill, 'waiting');
      assert.equal(info.project, 'shop-api');
      assert.ok(info.thumbs >= 1);
      assert.ok(info.codeCopy >= 1);
      assert.equal(info.focusFn, 'function');

      // Answer the question by clicking an option, then approve with Enter on the focused card.
      await page.evaluate(`document.querySelector('.card.question .btn-option').click()`);
      assert.ok(await waitFor(page, `!document.querySelector('.card.question')`), 'question card resolves');
      const shadow = `getComputedStyle(document.querySelector('.card.approval')).boxShadow`;
      const unfocused = await page.evaluate(shadow);
      await page.evaluate(`document.querySelector('.card.approval').focus()`);
      assert.notEqual(await page.evaluate(shadow), unfocused, 'a focused approval card shows a focus ring');
      // Enter (or a held Enter) right after the card took focus was meant for something else.
      const enterOnCard = (repeat) =>
        page.evaluate(`document.querySelector('.card.approval').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: ${repeat}, bubbles: true, cancelable: true }))`);
      await enterOnCard(false);
      await sleep(300);
      assert.equal(await page.evaluate(`Boolean(document.querySelector('.card.approval'))`), true, 'Enter right after the card took focus is ignored');
      await sleep(450);
      await enterOnCard(true);
      await sleep(300);
      assert.equal(await page.evaluate(`Boolean(document.querySelector('.card.approval'))`), true, 'a repeated Enter is ignored');
      assert.deepEqual(stub.state.decisions, []);
      await enterOnCard(false);
      assert.ok(await waitFor(page, `!document.querySelector('.card.approval')`), 'approval card resolves');
      assert.deepEqual(stub.state.decisions, [{ id: 'ap_1', decision: 'allow' }]);

      // Send a typed command; the stub plays a full turn. A second, quick Enter on the now
      // empty composer must not stop the command that was just sent.
      const enterInInput = `document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`;
      await page.evaluate(`(() => { const i = document.getElementById('input'); i.value = 'Summarize the page in my browser'; i.dispatchEvent(new Event('input')); ${enterInInput}; })()`);
      assert.ok(await waitFor(page, `document.getElementById('send').classList.contains('stop')`), 'composer turns into Stop while Claude works');
      await page.evaluate(enterInInput);
      assert.ok(await waitFor(page, `[...document.querySelectorAll('.msg.user')].some(m => m.textContent.includes('Summarize the page'))`), 'user message appears');
      assert.ok(await waitFor(page, `[...document.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('UI stub'))`, 8000), 'reply streams in');
      assert.equal(stub.state.interrupts, 0, 'the double Enter did not interrupt');
      assert.equal(stub.state.commands.length, 1);
      assert.equal(stub.state.commands[0].attachScreenshot, false, 'the "Include screen" chip state is always sent');

      // A snapshot mid-session keeps a pending card, its typed reason and focus.
      const card2 = { id: 'ap_2', toolName: 'Bash', displayName: 'Run command', summary: 'rm -rf build', input: { command: 'rm -rf build' }, risk: 'high', ts: new Date().toISOString(), timeoutSec: 600 };
      stub.state.approvals.set(card2.id, card2);
      stub.broadcast('approval_request', card2);
      assert.ok(await waitFor(page, `Boolean(document.querySelector('.card.approval[data-id="ap_2"]'))`), 'new approval card');
      await page.evaluate(`(() => { const r = document.querySelector('.card.approval[data-id="ap_2"] .deny-reason'); r.focus(); r.value = 'use make clean instead'; window.__card = r.closest('.card'); })()`);
      stub.broadcast('snapshot', stub.snapshot());
      await sleep(400);
      assert.deepEqual(
        await page.evaluate(`(() => { const c = document.querySelector('.card.approval[data-id="ap_2"]'); const r = c.querySelector('.deny-reason'); return { same: c === window.__card, value: r.value, focused: document.activeElement === r }; })()`),
        { same: true, value: 'use make clean instead', focused: true }
      );
      await page.evaluate(`document.querySelector('.card.approval[data-id="ap_2"] .deny-reason').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
      assert.ok(await waitFor(page, `!document.querySelector('.card.approval')`), 'denied from the reason box');
      assert.deepEqual(stub.state.decisions[1], { id: 'ap_2', decision: 'deny', message: 'use make clean instead' });

      // Only the newest 12 screenshots stay in the transcript.
      const shot = stub.snapshot().messages.find((m) => m.image).image;
      for (let i = 0; i < 14; i += 1) {
        stub.broadcast('message', { id: `shot_${i}`, role: 'tool', toolUseId: `tu_shot_${i}`, name: 'mcp__anywhere__screenshot', displayName: 'Screenshot', status: 'ok', image: shot, ts: new Date().toISOString() });
      }
      assert.ok(await waitFor(page, `document.querySelector('[data-id="shot_13"] .tool-thumb') !== null`), 'screenshot rows render');
      assert.equal(await page.evaluate(`document.querySelectorAll('#items .tool-thumb img').length`), 12);
      assert.equal(await page.evaluate(`document.querySelector('[data-id="shot_1"] .tool-thumb')`), null, 'older rows lose their thumbnail');

      // Settings drawer opens, shows the permission mode, and Escape closes it.
      await page.evaluate(`document.getElementById('open-settings').click()`);
      assert.equal(await page.evaluate(`!document.getElementById('drawer').hidden && document.querySelector('input[name="permissions.mode"]:checked').value`), 'smart');
      await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      assert.equal(await page.evaluate(`document.getElementById('drawer').hidden`), true);

      // Ctrl+K focuses the composer.
      await page.evaluate(`document.body.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
      assert.equal(await page.evaluate(`document.activeElement.id`), 'input');

      // Project popover lists projects from GET /api/projects.
      await page.evaluate(`document.getElementById('project-chip').click()`);
      assert.ok(await waitFor(page, `document.querySelectorAll('#project-list .pop-item').length === 3`), 'project list');

      assert.deepEqual(page.problems, [], `console errors at ${width}px:\n${page.problems.join('\n')}`);
    } finally {
      page.close();
    }
    // The stub's scripted state was consumed; restart it for the next viewport.
    await stub.close();
    Object.assign(stub, await createStubServer({ token: 'tok' }));
  }
});

test('headless Chromium: in hands-free mode Esc stops Claude before it turns listening off', async (t) => {
  const chrome = findChrome();
  if (!chrome) {
    t.skip('no Chromium found (set ANYWHERE_TEST_CHROME)');
    return;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('needs a global WebSocket (Node >= 22)');
    return;
  }
  const { createStubServer } = require('./fixtures/ui-stub-server');
  const stub = await createStubServer({ token: 'tok' });
  t.after(() => stub.close());
  stub.state.config.voice.handsFree = true;
  const page = await openPage(chrome, { width: 440, height: 720, scheme: 'light' });
  try {
    // A stand-in for the Web Speech API: hands-free starts and waits for its wake word.
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        class FakeSR {
          start() { setTimeout(() => this.onstart && this.onstart(), 0); }
          stop() { setTimeout(() => this.onend && this.onend(), 0); }
          abort() {}
        }
        window.SpeechRecognition = FakeSR;
        window.webkitSpeechRecognition = FakeSR;
      })()`,
    });
    await page.send('Page.navigate', { url: stub.url });
    const phase = `document.getElementById('mic')?.dataset.phase`;
    assert.ok(await waitFor(page, `${phase} === 'wake'`), 'hands-free listens for the wake word');
    // Let the stub's scripted intro finish; Claude is then waiting for an approval (busy).
    assert.ok(await waitFor(page, `[...document.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('which project to use'))`), 'intro plays');
    assert.ok(await waitFor(page, `document.getElementById('status').dataset.state === 'waiting'`), 'busy');
    await sleep(300);
    const esc = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`;
    await page.evaluate(esc);
    // Idle again; with hands-free waiting the pill reads "Hands-free".
    assert.ok(await waitFor(page, `document.getElementById('status').dataset.state === 'handsfree'`), 'Esc stopped Claude');
    assert.equal(stub.state.interrupts, 1);
    assert.equal(await page.evaluate(phase), 'wake', 'hands-free is still listening');
    // With nothing else running, Esc turns hands-free off.
    await page.evaluate(esc);
    assert.ok(await waitFor(page, `${phase} === 'idle'`), 'second Esc turns listening off');
    assert.equal(stub.state.interrupts, 1);
    assert.deepEqual(page.problems, [], page.problems.join('\n'));
  } finally {
    page.close();
  }
});
