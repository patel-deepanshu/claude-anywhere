'use strict';

/**
 * Round-2 regression tests for the dialog (src/ui):
 *  - UI-DYNAMIC-1: Enter in an empty composer while a card waits goes to the card instead of
 *    stopping the task; a new card takes focus from an empty composer; the card's key hints
 *    show only where the keys apply; typing on a freshly focused card reaches the composer.
 *  - UI-DYNAMIC-2: a dead daemon is reported (not "Reconnecting…" forever), and the Quit
 *    banner is not overwritten.
 *  - UI-DYNAMIC-3: a stored number off an input's step/range doesn't block Save.
 *  - UI-DYNAMIC-4: an open Settings drawer doesn't send back stale values for settings
 *    changed elsewhere.
 *  - UI-DYNAMIC-6: changing "Attach a screenshot by default" resets the remembered chip.
 *  - UI-DYNAMIC-7: typed text answers the one pending question.
 *  - UI-DYNAMIC-8: long tokens wrap inside the question card.
 *  - UI-DYNAMIC-9: pasting more than 4 images warns.
 *  - UI-DYNAMIC-11: opening Settings focuses the selected option.
 *
 * The browser cases drive headless Chromium against test/fixtures/ui-stub-server.js; they are
 * skipped without a Chromium binary (set ANYWHERE_TEST_CHROME) or a global WebSocket (Node < 22).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchChrome } = require('./fixtures/chrome-launch');
const { createStubServer, encodePng } = require('./fixtures/ui-stub-server');

const UI = path.join(__dirname, '..', 'src', 'ui');

// ------------------------------------------------------------------ static checks (every Node)

test('settings form: novalidate, and steps that accept any stored value (UI-DYNAMIC-3)', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.match(html, /<form class="drawer-body" id="settings-form"[^>]*\snovalidate[\s>]/);
  const input = (key) => (new RegExp(`<input[^>]*data-key="${key.replace(/\./g, '\\.')}"[^>]*>`).exec(html) || [''])[0];
  assert.match(input('engine.maxBudgetUsd'), /step="any"/);
  assert.match(input('permissions.approvalTimeoutSec'), /step="1"/);
  assert.match(input('computer.actionDelayMs'), /step="1"/);
});

test('cards: long tokens wrap, and key hints hide while the card has no focus (UI-DYNAMIC-8, UI-DYNAMIC-1)', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const rule = (sel) => {
    const m = new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
    return m ? m[1] : '';
  };
  for (const sel of ['.card-q', '.card-reason']) {
    assert.match(rule(sel), /overflow-wrap:\s*anywhere/, sel);
    assert.match(rule(sel), /min-width:\s*0/, sel);
  }
  assert.match(css, /\.card:not\(:focus-within\) \.card-actions kbd/);
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

/** Tiny CDP client over the page WebSocket (as in integration-ui.test.js). */
async function openPage(chrome, { width = 440, height = 720 } = {}) {
  const { port, cleanup } = await launchChrome(chrome, { prefix: 'anywhere-chrome-r2-' });
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
  const KEYS = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  };
  /** A real key press (keydown, text input, keyup), like a user's. */
  const press = async (k) => {
    const d = KEYS[k] || { key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), text: k };
    await send('Input.dispatchKeyEvent', { type: d.text ? 'keyDown' : 'rawKeyDown', ...d });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: d.key, code: d.code, windowsVirtualKeyCode: d.windowsVirtualKeyCode });
  };
  const close = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return cleanup();
  };
  return { send, evaluate, press, problems, close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, expr, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(expr)) return true;
    await sleep(100);
  }
  return false;
}

/** Wait for a Node-side condition (the stub's recorded state). */
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

/** Talk to the stub as another client would (the CLI, a second dialog, the TUI). */
async function postStub(stub, p, body) {
  const r = await fetch(`http://127.0.0.1:${stub.port}${p}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stub.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function loadDialog(page, stub) {
  await page.send('Page.navigate', { url: stub.url });
  assert.ok(await waitFor(page, `document.getElementById('status') && document.getElementById('status').dataset.state === 'idle'`), 'dialog connects');
}

const activeId = `(document.activeElement && (document.activeElement.id || document.activeElement.dataset.id || document.activeElement.tagName))`;
const toasts = `[...document.querySelectorAll('#toasts .toast-text')].map((t) => t.textContent).join(' | ')`;

test('headless Chromium: cards own Enter while they wait, and typed text answers the question (UI-DYNAMIC-1, -7, -8, -9)', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty' });
  t.after(() => stub.close());
  const page = await openPage(chrome, { width: 1024, height: 768 });
  t.after(() => page.close());
  await loadDialog(page, stub);

  // An approval arrives while the composer has focus and is empty: the card takes focus.
  const card = { id: 'ap_r2', toolName: 'Bash', displayName: 'Run command', summary: 'rm -rf build', input: { command: 'rm -rf build' }, risk: 'high', ts: new Date().toISOString(), timeoutSec: 600 };
  await page.evaluate(`document.getElementById('input').focus()`);
  stub.state.approvals.set(card.id, card);
  stub.broadcast('status', { status: 'waiting_approval', detail: 'Waiting for your approval' });
  stub.broadcast('approval_request', card);
  assert.ok(await waitFor(page, `document.activeElement && document.activeElement.dataset.id === 'ap_r2'`), 'a new card takes focus from an empty composer');
  assert.equal(await page.evaluate(`document.getElementById('input').placeholder`), 'Allow or deny the request above…');
  const allowHint = `getComputedStyle(document.querySelector('.card.approval .btn-primary kbd')).display`;
  const denyHint = `getComputedStyle(document.querySelector('.card.approval .btn-danger kbd')).display`;
  assert.notEqual(await page.evaluate(allowHint), 'none', '↵ shows on the focused card');
  assert.notEqual(await page.evaluate(denyHint), 'none', 'Esc shows on the focused card');

  // Back in the composer (a click), the hints go, and Enter (well past the 1.5 s grace) focuses
  // the card instead of stopping the task. That same press can't allow it.
  await page.evaluate(`document.getElementById('input').focus()`);
  assert.equal(await page.evaluate(allowHint), 'none', '↵ hidden while the composer has focus');
  assert.equal(await page.evaluate(denyHint), 'none', 'Esc hidden while the composer has focus');
  await page.press('Enter');
  assert.equal(await page.evaluate(activeId), 'ap_r2', 'Enter moved focus to the card');
  await page.press('Enter');
  await sleep(200);
  assert.equal(stub.state.interrupts, 0, 'Enter in the empty composer did not stop the task');
  assert.deepEqual(stub.state.decisions, [], 'a second Enter right away is not a decision');

  // Typing on the card (it took focus just as the user started typing) reaches the composer.
  await page.press('x');
  assert.equal(await page.evaluate(`document.getElementById('input').value`), 'x');
  assert.equal(await page.evaluate(activeId), 'input');
  await page.evaluate(`(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);

  // Once armed, Esc on the card denies just this action; the task keeps going.
  await page.press('Enter');
  await sleep(700);
  await page.press('Escape');
  assert.ok(await until(() => stub.state.decisions.length === 1), 'Esc on the card decided it');
  assert.deepEqual(stub.state.decisions, [{ id: 'ap_r2', decision: 'deny' }]);
  assert.equal(stub.state.interrupts, 0);
  assert.ok(await waitFor(page, `!document.querySelector('.card.approval')`));

  // A question: typed text answers it rather than queueing a follow-up behind it.
  const longToken = `https://console.cloud.google.com/run/create?project=${'x'.repeat(150)}`;
  const q = { id: 'q_r2', question: `Pick one. Then open ${longToken}`, options: ['A', 'B'], ts: new Date().toISOString() };
  stub.state.questions.set(q.id, q);
  stub.broadcast('status', { status: 'waiting_answer', detail: 'Claude asked you a question' });
  stub.broadcast('question', q);
  assert.ok(await waitFor(page, `Boolean(document.querySelector('.card.question'))`));
  assert.equal(await page.evaluate(`document.getElementById('input').placeholder`), 'Type your answer to Claude’s question…');
  const wrap = await page.evaluate(`(() => { const e = document.querySelector('.card.question .card-q'); return { sw: e.scrollWidth, cw: e.clientWidth }; })()`);
  assert.ok(wrap.sw <= wrap.cw + 1, `the long token wraps inside the card (${wrap.sw} > ${wrap.cw})`);
  await page.evaluate(`document.getElementById('input').focus()`);
  await page.press('B');
  await page.press('Enter');
  assert.ok(await until(() => stub.state.answers.length === 1), 'the typed text answered the question');
  assert.deepEqual(stub.state.answers, [{ id: 'q_r2', text: 'B' }]);
  assert.equal(stub.state.commands.length, 0, 'nothing was queued as a follow-up');
  assert.ok(await waitFor(page, `!document.querySelector('.card.question')`));
  assert.equal(await page.evaluate(`document.getElementById('input').value`), '');
  assert.equal(stub.state.interrupts, 0);

  // Pasting six images keeps four and says so.
  stub.broadcast('status', { status: 'idle' });
  const png = encodePng(2, 2, () => [200, 80, 40]).toString('base64');
  const pasted = await page.evaluate(`(() => {
    const bytes = Uint8Array.from(atob('${png}'), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    for (let i = 0; i < 6; i += 1) dt.items.add(new File([bytes], 'shot' + i + '.png', { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById('input').dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`);
  assert.equal(pasted, true);
  assert.ok(await waitFor(page, `document.querySelectorAll('#attachments .attachment').length === 4`), 'four thumbnails');
  assert.match(await page.evaluate(toasts), /up to 4 images/);
  await sleep(300);
  assert.equal(await page.evaluate(`document.querySelectorAll('#attachments .attachment').length`), 4);
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: Enter never allows a critical action; it needs a click', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty' });
  t.after(() => stub.close());
  const page = await openPage(chrome, { width: 1024, height: 768 });
  t.after(() => page.close());
  await loadDialog(page, stub);

  const card = { id: 'ap_crit', toolName: 'Bash', displayName: 'Run command', summary: 'rm -rf ~', input: { command: 'rm -rf ~' }, risk: 'critical', ts: new Date().toISOString(), timeoutSec: 600 };
  await page.evaluate(`document.getElementById('input').focus()`);
  stub.state.approvals.set(card.id, card);
  stub.broadcast('status', { status: 'waiting_approval', detail: 'Waiting for your approval' });
  stub.broadcast('approval_request', card);
  assert.ok(await waitFor(page, `document.activeElement && document.activeElement.dataset.id === 'ap_crit'`), 'the critical card takes focus');
  assert.equal(await page.evaluate(`document.querySelector('.card.approval .btn-primary kbd')`), null, 'no ↵ hint on a critical Allow');

  // Armed (past the grace period) and focused: Enter still decides nothing.
  await sleep(1700);
  await page.press('Enter');
  await sleep(300);
  assert.deepEqual(stub.state.decisions, [], 'Enter on a critical card is not an approval');

  await page.evaluate(`document.querySelector('.card.approval .btn-primary').click()`);
  assert.ok(await until(() => stub.state.decisions.length === 1), 'the click decided it');
  assert.deepEqual(stub.state.decisions, [{ id: 'ap_crit', decision: 'allow' }]);
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: Settings sends only what was edited, and the screenshot default wins over the chip (UI-DYNAMIC-3, -4, -6, -11)', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty' });
  t.after(() => stub.close());
  // Values another client stored that don't fit the inputs' step attributes.
  await postStub(stub, '/api/config', { engine: { maxBudgetUsd: 0.3 }, computer: { actionDelayMs: 125 } });
  stub.state.configPosts.length = 0;
  const page = await openPage(chrome);
  t.after(() => page.close());
  await loadDialog(page, stub);
  const drawerOpen = `!document.getElementById('drawer').hidden`;
  const field = (key) => `document.querySelector('#settings-form [data-key="${key}"]')`;
  const setNumber = (key, v) => page.evaluate(`(() => { const i = ${field(key)}; i.focus(); i.value = '${v}'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const pick = (name, value) => page.evaluate(`document.querySelector('#settings-form input[name="${name}"][value="${value}"]').click()`);
  const save = () => page.evaluate(`document.getElementById('save-settings').click()`);

  // Opening Settings focuses the selected permission mode, not the close button.
  await page.evaluate(`document.getElementById('open-settings').click()`);
  assert.ok(await page.evaluate(drawerOpen));
  assert.deepEqual(await page.evaluate(`[document.activeElement.name, document.activeElement.value, document.activeElement.checked]`), ['permissions.mode', 'smart', true]);

  // Saving only the theme works despite the off-step budget and delay, and sends only the theme.
  await pick('ui.theme', 'dark');
  await save();
  assert.ok(await until(() => stub.state.config.ui.theme === 'dark'), 'the theme was saved');
  assert.deepEqual(stub.state.configPosts, [{ ui: { theme: 'dark' } }]);
  assert.equal(stub.state.config.engine.maxBudgetUsd, 0.3);
  assert.equal(stub.state.config.computer.actionDelayMs, 125);
  assert.ok(await waitFor(page, `document.getElementById('drawer').hidden`), 'the drawer closed');

  // A budget like $1.25 can be entered; an out-of-range timeout is reported, not saved.
  await page.evaluate(`document.getElementById('open-settings').click()`);
  await setNumber('engine.maxBudgetUsd', '1.25');
  await save();
  assert.ok(await until(() => stub.state.config.engine.maxBudgetUsd === 1.25), 'the budget was saved');
  assert.ok(await waitFor(page, `document.getElementById('drawer').hidden`));
  await page.evaluate(`document.getElementById('open-settings').click()`);
  await setNumber('permissions.approvalTimeoutSec', '5');
  await save();
  assert.ok(await waitFor(page, `${toasts}.includes('between 10 and 86400')`), 'out-of-range timeout reported');
  assert.equal(await page.evaluate(drawerOpen), true);
  assert.equal(stub.state.config.permissions.approvalTimeoutSec, 600);
  await page.evaluate(`document.getElementById('cancel-settings').click()`);

  // With the drawer open, another client tightens permissions and picks a model; the user had
  // edited the budget and now changes the theme. Their edits are kept, and only they are sent.
  stub.state.configPosts.length = 0;
  await page.evaluate(`document.getElementById('open-settings').click()`);
  await setNumber('engine.maxBudgetUsd', '2');
  await postStub(stub, '/api/config', { engine: { model: 'opus', maxBudgetUsd: 5 }, permissions: { mode: 'ask' } });
  assert.ok(await waitFor(page, `document.querySelector('#settings-form input[name="permissions.mode"]:checked').value === 'ask'`), 'untouched fields follow the change');
  assert.equal(await page.evaluate(`${field('engine.model')}.value`), 'opus');
  assert.equal(await page.evaluate(`${field('engine.maxBudgetUsd')}.value`), '2', 'the edited field keeps the edit');
  await pick('ui.theme', 'light');
  await save();
  assert.ok(await until(() => stub.state.config.ui.theme === 'light'));
  assert.ok(await waitFor(page, `document.getElementById('drawer').hidden`));
  assert.deepEqual(stub.state.configPosts.slice(1), [{ engine: { maxBudgetUsd: 2 }, ui: { theme: 'light' } }]);
  assert.equal(stub.state.config.permissions.mode, 'ask', 'the stricter mode set elsewhere stays');
  assert.equal(stub.state.config.engine.model, 'opus');

  // The chip remembers its last click until "Attach a screenshot by default" changes.
  const chip = `document.getElementById('screen-toggle').getAttribute('aria-pressed')`;
  await page.evaluate(`document.getElementById('screen-toggle').click()`);
  await page.evaluate(`document.getElementById('screen-toggle').click()`);
  assert.equal(await page.evaluate(chip), 'false');
  await page.evaluate(`document.getElementById('open-settings').click()`);
  await page.evaluate(`${field('context.attachScreenshotByDefault')}.click()`);
  await save();
  assert.ok(await until(() => stub.state.config.context.attachScreenshotByDefault === true));
  assert.ok(await waitFor(page, `document.getElementById('drawer').hidden`));
  assert.ok(await waitFor(page, `${chip} === 'true'`), 'turning the default on turns the chip on');
  await loadDialog(page, stub);
  assert.equal(await page.evaluate(chip), 'true', 'and it stays on after a reload');
  // With the default unchanged, a click is still remembered across a reload.
  await page.evaluate(`document.getElementById('screen-toggle').click()`);
  await loadDialog(page, stub);
  assert.equal(await page.evaluate(chip), 'false', 'the remembered click wins over an unchanged default');
  // Changed while no dialog was open: the next load follows the new default.
  await page.evaluate(`document.getElementById('screen-toggle').click()`);
  assert.equal(await page.evaluate(chip), 'true');
  await page.send('Page.navigate', { url: 'about:blank' });
  await postStub(stub, '/api/config', { context: { attachScreenshotByDefault: false } });
  await loadDialog(page, stub);
  assert.equal(await page.evaluate(chip), 'false', 'a default changed since the click wins');
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: a dead daemon is reported, and the Quit banner stays (UI-DYNAMIC-2)', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const banner = `(document.getElementById('banner').hidden ? '' : document.getElementById('banner-text').textContent)`;
  const retryShown = `!document.getElementById('banner-retry').hidden`;

  // The daemon dies: after the browser's retries, the dialog says it isn't running.
  let stub = await createStubServer({ token: 'tok', scenario: 'empty' });
  const port = stub.port;
  t.after(() => stub.close());
  const page = await openPage(chrome);
  t.after(() => page.close());
  await loadDialog(page, stub);
  await stub.close();
  assert.ok(await waitFor(page, `${banner}.includes('Reconnecting')`, 3000), 'reconnecting first');
  assert.ok(await waitFor(page, `${banner}.includes('isn’t running') && ${retryShown}`, 12000), `diagnosed as down (banner: ${await page.evaluate(banner)})`);
  await sleep(2500);
  assert.match(await page.evaluate(banner), /isn’t running/, 'later retries keep the diagnosis');
  // It comes back on the same port: the window reconnects on its own and the banner goes.
  stub = await createStubServer({ token: 'tok', scenario: 'empty', port });
  assert.ok(await waitFor(page, `${banner} === '' && document.getElementById('status').dataset.state === 'idle'`, 8000), 'reconnected');

  // Quit from Settings: the shut-down banner is not replaced by "Reconnecting…".
  await page.evaluate(`window.confirm = () => true; document.getElementById('open-settings').click(); document.getElementById('shutdown').click()`);
  assert.ok(await waitFor(page, `${banner}.includes('has been shut down')`), 'shut-down banner');
  await stub.close();
  await sleep(3500);
  assert.match(await page.evaluate(banner), /has been shut down/);
  assert.equal(await page.evaluate(retryShown), true);
  // Retry reconnects once the daemon is back.
  stub = await createStubServer({ token: 'tok', scenario: 'empty', port });
  await sleep(2500);
  assert.match(await page.evaluate(banner), /has been shut down/, 'no reconnect on its own after a Quit');
  await page.evaluate(`document.getElementById('banner-retry').click()`);
  assert.ok(await waitFor(page, `${banner} === '' && document.getElementById('status').dataset.state === 'idle'`, 8000), 'Retry reconnects');
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});
