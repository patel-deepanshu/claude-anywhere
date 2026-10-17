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
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'src', 'ui');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-ui-int-'));
process.env.ANYWHERE_HOME = HOME;

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-chrome-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--user-data-dir=${dir}`, '--remote-debugging-port=0', 'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );
  let port = null;
  for (let i = 0; i < 150 && !port; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      port = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      /* not yet */
    }
  }
  if (!port) {
    proc.kill('SIGKILL');
    throw new Error('Chromium did not start');
  }
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
    proc.kill('SIGKILL');
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500).unref();
  };
  return { send, evaluate, problems, close };
}

const waitFor = async (page, expr, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(expr)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

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
      await page.evaluate(`(() => { const c = document.querySelector('.card.approval'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      assert.ok(await waitFor(page, `!document.querySelector('.card.approval')`), 'approval card resolves');

      // Send a typed command; the stub plays a full turn.
      await page.evaluate(`(() => { const i = document.getElementById('input'); i.value = 'Summarize the page in my browser'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      assert.ok(await waitFor(page, `[...document.querySelectorAll('.msg.user')].some(m => m.textContent.includes('Summarize the page'))`), 'user message appears');
      assert.ok(await waitFor(page, `[...document.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('UI stub'))`, 8000), 'reply streams in');

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
