'use strict';

/**
 * Settings drawer additions for the natural voice, Jira and repo folders (src/ui):
 *  - tabs (General, Voice, Jira & repos, Advanced); every field maps to a config key;
 *  - Voice: engine, the Piper voice picker from GET /api/voice/status (installed versus
 *    downloadable, with sizes), Install with progress from SSE voice_install, Test voice
 *    (POST /api/voice/test), announce toggles and the chime;
 *  - Jira: site URL (normalized), email, an API token that is never sent empty, and Test
 *    connection (POST /api/jira/test) showing the Jira user or the error;
 *  - Repo folders (workspace.roots): add, validate, de-duplicate, suggestions, remove;
 *  - Save sends only what was edited, through POST /api/config;
 *  - no horizontal overflow at 360 px, light and dark (screenshots go to ANYWHERE_TEST_SHOTS when set).
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
const { createStubServer, PIPER_CATALOG } = require('./fixtures/ui-stub-server');
const { DEFAULTS } = require('../src/shared/config');

const UI = path.join(__dirname, '..', 'src', 'ui');
const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');

const getPath = (obj, key) => key.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);

// ------------------------------------------------------------------ static checks (every Node)

test('settings form: every field is a real config key; the new voice, Jira and workspace fields are there', () => {
  const keys = [...new Set([...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]))];
  for (const key of keys) {
    if (key === 'mode') continue;
    assert.notEqual(getPath(DEFAULTS, key), undefined, `data-key="${key}" is not in config DEFAULTS`);
  }
  for (const key of [
    'voice.ttsEngine', 'voice.piperVoice', 'voice.announce.done', 'voice.announce.permission', 'voice.announce.question',
    'voice.announce.error', 'voice.chime', 'voice.speakResponses', 'voice.ttsVoice', 'voice.ttsRate',
    'jira.baseUrl', 'jira.email', 'jira.apiToken', 'workspace.roots',
  ]) {
    assert.ok(keys.includes(key), `missing field ${key}`);
  }
  const engine = /<select[^>]*data-key="voice\.ttsEngine"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.deepEqual([...engine[1].matchAll(/value="([^"]*)"/g)].map((m) => m[1]), ['auto', 'piper', 'browser', 'os']);
  assert.match(engine[1], /Natural voice · free &amp; offline/);
  assert.match(html, /<input type="password"[^>]*data-key="jira\.apiToken"[^>]*autocomplete="new-password"/);
  // The token link is set from app.js: the page itself references only its own files.
  assert.match(appJs, /const JIRA_TOKEN_URL = 'https:\/\/id\.atlassian\.com\/manage-profile\/security\/api-tokens';/);
  assert.match(html, /<a id="jira-token-link" target="_blank" rel="noopener noreferrer">/);
  assert.match(appJs, /const SECRET_FIELDS = new Set\(\['voice\.sttApiKey', 'jira\.apiToken'\]\);/);
  // Tabs: a tab list whose tabs control the panels.
  for (const tab of ['general', 'voice', 'work', 'advanced']) {
    assert.match(html, new RegExp(`role="tab" id="tab-${tab}" data-tab="${tab}" aria-controls="panel-${tab}"`));
    assert.match(html, new RegExp(`id="panel-${tab}" role="tabpanel" aria-labelledby="tab-${tab}"`));
  }
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
  const { port, cleanup } = await launchChrome(chrome, { prefix: 'anywhere-chrome-set-', extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
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
  const KEYS = { Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' } };
  const press = async (k) => {
    const d = KEYS[k];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...d });
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

async function waitFor(page, expr, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(expr)) return true;
    await sleep(60);
  }
  return false;
}

async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(40);
  }
  return false;
}

async function loadDialog(page, stub) {
  await page.send('Page.navigate', { url: stub.url });
  assert.ok(await waitFor(page, `document.getElementById('status') && document.getElementById('status').dataset.state === 'idle'`), 'dialog connects');
}

const toasts = `[...document.querySelectorAll('#toasts .toast-text')].map((t) => t.textContent).join(' | ')`;
const field = (key) => `document.querySelector('#settings-form [data-key="${key}"]')`;
const openSettings = (page) => page.evaluate(`document.getElementById('open-settings').click()`);
const tab = (page, name) => page.evaluate(`document.getElementById('tab-${name}').click()`);
const save = (page) => page.evaluate(`document.getElementById('save-settings').click()`);
/** Set a text field or select like a user would (input, then change). */
const setValue = (page, sel, v) =>
  page.evaluate(`(() => { const i = ${sel}; i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);

test('headless Chromium: the tabs show the new sections, and the Piper picker lists installed and downloadable voices with sizes', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty', piperInstalled: true });
  t.after(() => stub.close());
  const page = await openPage(chrome);
  t.after(() => page.close());
  await loadDialog(page, stub);
  await openSettings(page);
  const visibleLegends = `[...document.querySelectorAll('#settings-form .set-panel:not([hidden]) legend')].map((l) => l.textContent.trim())`;
  assert.deepEqual(await page.evaluate(visibleLegends), ['Permissions', 'Working style', 'Appearance']);
  assert.equal(await page.evaluate(`document.activeElement.name + '=' + document.activeElement.value`), 'permissions.mode=smart', 'opening focuses the selected permission mode');

  await tab(page, 'voice');
  assert.deepEqual(await page.evaluate(visibleLegends), ['Spoken replies', 'Voice input']);
  assert.equal(await page.evaluate(`document.getElementById('tab-voice').getAttribute('aria-selected')`), 'true');
  assert.ok(await waitFor(page, `document.getElementById('piper-state').textContent === 'In use'`), 'the natural voice is in use');
  const picker = await page.evaluate(`[...document.querySelectorAll('#piper-voice optgroup')].map((g) => ({ label: g.label, options: [...g.children].map((o) => o.textContent) }))`);
  assert.deepEqual(picker[0], { label: 'On this computer', options: ['Lessac · American English, female'] });
  assert.equal(picker[1].label, 'Free to download');
  assert.deepEqual(picker[1].options, [
    'Ryan · American English, male · high quality · 121 MB',
    'Amy · American English, female · 63 MB',
    'Alba · British English, female · 63 MB',
    'Thorsten · German (Germany), male · 63 MB',
  ]);
  assert.equal(await page.evaluate(`document.getElementById('piper-voice').value`), 'en_US-lessac-medium');
  assert.equal(await page.evaluate(`document.getElementById('piper-install').hidden`), true, 'nothing to install for the voice in use');
  // A voice that isn't downloaded yet offers its download.
  await setValue(page, `document.getElementById('piper-voice')`, 'en_US-ryan-high');
  assert.equal(await page.evaluate(`document.getElementById('piper-install').hidden`), false);
  assert.equal(await page.evaluate(`document.getElementById('piper-install-label').textContent`), 'Download this voice (121 MB)');
  // Announce toggles and the chime come from the config.
  for (const k of ['done', 'permission', 'question', 'error']) assert.equal(await page.evaluate(`${field(`voice.announce.${k}`)}.checked`), true, k);
  assert.equal(await page.evaluate(`${field('voice.chime')}.checked`), true);

  // Keyboard: arrows move between tabs.
  await page.evaluate(`document.getElementById('tab-voice').focus()`);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  assert.equal(await page.evaluate(`document.activeElement.id`), 'tab-work');
  assert.deepEqual(await page.evaluate(visibleLegends), ['Jira', 'Repo folders']);
  assert.equal(await page.evaluate(`document.getElementById('jira-token-link').href`), 'https://id.atlassian.com/manage-profile/security/api-tokens');
  await tab(page, 'advanced');
  assert.deepEqual(await page.evaluate(visibleLegends), ['Engine', 'Context', 'Screen control', 'Privacy']);
  assert.match(await page.evaluate(`document.getElementById('about').textContent`), /Natural voiceIn use \(en_US-lessac-medium\)|Natural voicein use \(en_US-lessac-medium\)/);
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: Save sends exactly what was edited; the Jira API token is never sent empty', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty' });
  t.after(() => stub.close());
  const page = await openPage(chrome);
  t.after(() => page.close());
  await loadDialog(page, stub);
  await openSettings(page);
  await tab(page, 'voice');
  assert.ok(await waitFor(page, `Boolean(document.querySelector('#piper-voice option[value="en_US-ryan-high"]'))`), 'the catalog loaded');
  await setValue(page, field('voice.ttsEngine'), 'piper');
  await setValue(page, field('voice.piperVoice'), 'en_US-ryan-high');
  await page.evaluate(`${field('voice.announce.question')}.click()`);
  await page.evaluate(`${field('voice.chime')}.click()`);
  await tab(page, 'work');
  await setValue(page, field('jira.baseUrl'), 'acme.atlassian.net/jira/software/projects/ABC/boards/1');
  assert.equal(await page.evaluate(`${field('jira.baseUrl')}.value`), 'https://acme.atlassian.net', 'a pasted page address becomes the site URL');
  await setValue(page, field('jira.email'), 'dev@acme.com');
  await setValue(page, field('jira.apiToken'), 'tok-123');
  await setValue(page, `document.getElementById('roots-input')`, '~/code');
  await page.evaluate(`document.getElementById('roots-add').click()`);
  await setValue(page, `document.getElementById('roots-input')`, '"C:\\Users\\dev\\repos\\"');
  await page.evaluate(`document.getElementById('roots-input').focus()`);
  await page.press('Enter');
  assert.equal(await page.evaluate(`document.getElementById('drawer').hidden`), false, 'Enter in the folder field adds it, not Save');
  assert.deepEqual(stub.state.configPosts, []);
  await save(page);
  assert.ok(await until(() => stub.state.configPosts.length === 1), 'saved');
  assert.deepEqual(stub.state.configPosts[0], {
    voice: { ttsEngine: 'piper', piperVoice: 'en_US-ryan-high', announce: { question: false }, chime: false },
    jira: { baseUrl: 'https://acme.atlassian.net', email: 'dev@acme.com', apiToken: 'tok-123' },
    workspace: { roots: ['~/code', 'C:\\Users\\dev\\repos'] },
  });
  assert.ok(await waitFor(page, `document.getElementById('drawer').hidden`), 'the drawer closed');
  assert.equal(stub.state.config.jira.apiToken, 'tok-123');

  // Opened again: the token shows as set, its field is empty, and an untouched field is not sent.
  await openSettings(page);
  assert.equal(await page.evaluate(`document.getElementById('tab-work').getAttribute('aria-selected')`), 'true', 'the last tab stays selected');
  assert.equal(await page.evaluate(`document.getElementById('jira-token-set').hidden`), false, '•••• set is shown');
  assert.equal(await page.evaluate(`document.getElementById('jira-token-set').textContent`), '•••• set');
  assert.equal(await page.evaluate(`${field('jira.apiToken')}.value`), '');
  assert.match(await page.evaluate(`${field('jira.apiToken')}.placeholder`), /^Saved\./);
  await setValue(page, field('jira.email'), 'ankit@acme.com');
  await save(page);
  assert.ok(await until(() => stub.state.configPosts.length === 2));
  assert.deepEqual(stub.state.configPosts[1], { jira: { email: 'ankit@acme.com' } }, 'no apiToken key at all');
  assert.equal(stub.state.config.jira.apiToken, 'tok-123', 'the saved token is kept');

  // Nothing changed: nothing is sent.
  assert.ok(await waitFor(page, `document.getElementById('drawer').hidden`));
  await openSettings(page);
  await save(page);
  assert.ok(await waitFor(page, `document.getElementById('drawer').hidden`));
  assert.equal(stub.state.configPosts.length, 2);

  // A site URL that isn't a web address is refused before anything is sent.
  await openSettings(page);
  await setValue(page, field('jira.baseUrl'), 'ftp://jira.acme.com');
  await save(page);
  assert.ok(await waitFor(page, `${toasts}.includes('https:// address')`), 'reported');
  assert.equal(stub.state.configPosts.length, 2);
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: Test connection uses the form as typed and shows the Jira user or the error', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty' });
  t.after(() => stub.close());
  stub.state.config.jira = { baseUrl: 'https://acme.atlassian.net', email: 'dev@acme.com', apiToken: 'saved-token' };
  const page = await openPage(chrome);
  t.after(() => page.close());
  await loadDialog(page, stub);
  await openSettings(page);
  await tab(page, 'work');
  assert.ok(await waitFor(page, `document.getElementById('jira-state').textContent === 'Jira Cloud'`), 'the status tag');
  const result = `[document.getElementById('jira-result').dataset.state, document.getElementById('jira-result').textContent]`;

  await setValue(page, field('jira.apiToken'), 'bad');
  await page.evaluate(`document.getElementById('jira-test').click()`);
  assert.ok(await waitFor(page, `document.getElementById('jira-result').dataset.state === 'error'`), 'an error');
  const [, err] = await page.evaluate(result);
  assert.match(err, /Jira rejected the email and API token \(HTTP 401\)\. Create a new token at https:\/\/id\.atlassian\.com/);
  assert.deepEqual(stub.state.jiraTests[0], { baseUrl: 'https://acme.atlassian.net', email: 'dev@acme.com', apiToken: 'bad' });

  await setValue(page, field('jira.apiToken'), '');
  assert.deepEqual(await page.evaluate(result), ['', ''], 'editing clears the old result');
  await page.evaluate(`document.getElementById('jira-test').click()`);
  assert.ok(await waitFor(page, `document.getElementById('jira-result').dataset.state === 'ok'`), 'connected');
  assert.deepEqual(await page.evaluate(result), ['ok', 'Connected as Ankit Sharma (dev@acme.com) · Jira Cloud']);
  assert.deepEqual(stub.state.jiraTests[1], { baseUrl: 'https://acme.atlassian.net', email: 'dev@acme.com' }, 'an empty token field uses the saved one');
  assert.deepEqual(stub.state.configPosts, [], 'testing saves nothing');
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: Install natural voice shows SSE progress, then uses the voice; Test voice plays through the announce path', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty', installStepMs: 150 });
  t.after(() => stub.close());
  const page = await openPage(chrome);
  t.after(() => page.close());
  await loadDialog(page, stub);
  await openSettings(page);
  await tab(page, 'voice');
  assert.ok(await waitFor(page, `document.getElementById('piper-state').textContent === 'Not installed'`));
  assert.equal(await page.evaluate(`document.getElementById('piper-install-label').textContent`), 'Install natural voice');
  assert.match(await page.evaluate(`document.getElementById('piper-help').textContent`), /free, one-time download \(about 63 MB with this voice\)/);
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#piper-voice optgroup')].map((g) => g.label)`), ['Free to download']);

  // An install started elsewhere (the CLI) that fails: its progress and error show here too.
  await fetch(`http://127.0.0.1:${stub.port}/api/voice/install`, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: 'en_US-broken-low' }) });
  assert.ok(await waitFor(page, `document.getElementById('piper-state').textContent === 'Installing'`), 'progress from another client shows');
  assert.ok(await waitFor(page, `document.getElementById('piper-state').textContent === 'Failed'`), 'the failure shows');
  assert.match(await page.evaluate(`document.getElementById('piper-progress-text').textContent`), /Download failed: HTTP 404/);
  assert.match(await page.evaluate(toasts), /Couldn’t install the natural voice: Download failed/);
  assert.equal(await page.evaluate(`document.getElementById('piper-install-label').textContent`), 'Try again');

  // Install Ryan from the picker.
  await setValue(page, `document.getElementById('piper-voice')`, 'en_US-ryan-high');
  await page.evaluate(`document.getElementById('piper-install').click()`);
  assert.ok(await until(() => stub.state.voiceInstalls.length === 2));
  assert.deepEqual(stub.state.voiceInstalls[1], { voice: 'en_US-ryan-high' });
  const seen = [];
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const [now, text, hidden] = await page.evaluate(`[Number(document.getElementById('piper-bar').getAttribute('aria-valuenow')), document.getElementById('piper-progress-text').textContent, document.getElementById('piper-progress').hidden]`);
    if (!hidden && (!seen.length || seen[seen.length - 1].text !== text)) seen.push({ now, text });
    if (await page.evaluate(`document.getElementById('piper-state').textContent === 'In use'`)) break;
    await sleep(25);
  }
  assert.equal(await page.evaluate(`document.getElementById('piper-state').textContent`), 'In use', 'installed and in use');
  const texts = seen.map((s) => s.text);
  // The daemon's own words, with the whole install's percentage.
  assert.ok(texts.some((x) => /^\d+% · Downloading Piper… [\d.]+ MB of 25\.0 MB$/.test(x)), `engine download shown (${texts.join(' | ')})`);
  assert.ok(texts.some((x) => /^\d+% · Downloading the voice… [\d.]+ MB of 121\.0 MB$/.test(x)), `voice download shown (${texts.join(' | ')})`);
  const values = seen.map((s) => s.now);
  assert.ok(values.some((v) => v > 0 && v < 100), `partial progress shown (${values.join(', ')})`);
  assert.deepEqual(values, [...values].sort((a, b) => a - b), 'the bar never moves back');
  assert.match(await page.evaluate(toasts), /Natural voice installed/);
  assert.deepEqual(stub.state.voiceUses, [{ voice: 'en_US-ryan-high' }], 'the installed voice is put to use');
  assert.equal(stub.state.config.voice.piperVoice, 'en_US-ryan-high');
  assert.ok(await waitFor(page, `[...document.querySelectorAll('#piper-voice optgroup')][0].label === 'On this computer'`));
  assert.equal(await page.evaluate(`document.getElementById('piper-install').hidden`), true);

  // Test voice: the daemon plays the voice's sample through an announcement, which this window plays.
  await page.evaluate(`document.getElementById('voice-test').click()`);
  assert.ok(await until(() => stub.state.voiceTests.length === 1));
  assert.deepEqual(stub.state.voiceTests[0], { text: PIPER_CATALOG.find((v) => v.id === 'en_US-ryan-high').sampleText });
  assert.ok(await until(() => stub.state.audioRequests.length === 1), 'the sample audio was fetched to play');
  assert.equal(stub.state.audioRequests[0].auth, 'Bearer tok');

  // Progress in the contract's plain shape ({stage, percent, message}, percent within the step)
  // is placed in that step's share of the bar.
  stub.broadcast('voice_install', { stage: 'voice', percent: 50, message: '' });
  assert.ok(await waitFor(page, `document.getElementById('piper-bar').getAttribute('aria-valuenow') === '62'`), 'half of the voice step');
  assert.equal(await page.evaluate(`document.getElementById('piper-progress-text').textContent`), '62% · Downloading the voice…');
  stub.broadcast('voice_install', { stage: 'done', percent: 100, message: '' });
  assert.ok(await waitFor(page, `document.getElementById('piper-progress-text').textContent === 'Installed'`));
  assert.deepEqual(stub.state.voiceUses, [{ voice: 'en_US-ryan-high' }], 'an install this window did not start changes no voice');

  // Saving now sends nothing: the voice was already put to use.
  await save(page);
  assert.ok(await waitFor(page, `document.getElementById('drawer').hidden`));
  assert.deepEqual(stub.state.configPosts, []);
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: repo folders are added, checked, de-duplicated, suggested and removed', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty' });
  t.after(() => stub.close());
  stub.state.config.workspace.roots = ['/home/dev/code'];
  const page = await openPage(chrome);
  t.after(() => page.close());
  await loadDialog(page, stub);
  await openSettings(page);
  await tab(page, 'work');
  const rows = `[...document.querySelectorAll('#roots-list .root-path')].map((r) => r.textContent)`;
  const error = `(document.getElementById('roots-error').hidden ? '' : document.getElementById('roots-error').textContent)`;
  assert.deepEqual(await page.evaluate(rows), ['/home/dev/code']);

  await setValue(page, `document.getElementById('roots-input')`, 'code');
  await page.evaluate(`document.getElementById('roots-add').click()`);
  assert.match(await page.evaluate(error), /Use a full folder path/);
  await setValue(page, `document.getElementById('roots-input')`, '/home/dev/code/');
  assert.equal(await page.evaluate(error), '', 'typing clears the message');
  await page.evaluate(`document.getElementById('roots-add').click()`);
  assert.match(await page.evaluate(error), /already in the list/);
  assert.deepEqual(await page.evaluate(rows), ['/home/dev/code']);

  // Suggestions: parent folders of the projects the daemon found, minus the ones listed.
  assert.ok(await waitFor(page, `!document.getElementById('roots-suggest').hidden`), 'suggestions shown');
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#roots-suggest .chip-suggest')].map((b) => b.textContent)`), ['/home/dev/work/very/deeply/nested']);
  await page.evaluate(`document.querySelector('#roots-suggest .chip-suggest').click()`);
  assert.ok(await waitFor(page, `document.getElementById('roots-suggest').hidden`), 'a used suggestion goes away');
  await setValue(page, `document.getElementById('roots-input')`, '~/repos');
  await page.evaluate(`document.getElementById('roots-input').focus()`);
  await page.press('Enter');
  assert.deepEqual(await page.evaluate(rows), ['/home/dev/code', '/home/dev/work/very/deeply/nested', '~/repos']);
  assert.equal(await page.evaluate(`document.getElementById('roots-input').value`), '');
  await page.evaluate(`document.querySelector('#roots-list .root-remove').click()`);
  assert.deepEqual(await page.evaluate(rows), ['/home/dev/work/very/deeply/nested', '~/repos']);
  assert.deepEqual(stub.state.configPosts, [], 'nothing saved before Save');
  await save(page);
  assert.ok(await until(() => stub.state.configPosts.length === 1));
  assert.deepEqual(stub.state.configPosts[0], { workspace: { roots: ['/home/dev/work/very/deeply/nested', '~/repos'] } });
  // Cancel throws edits away.
  await openSettings(page);
  await page.evaluate(`document.querySelector('#roots-list .root-remove').click()`);
  await page.evaluate(`document.getElementById('cancel-settings').click()`);
  await openSettings(page);
  assert.deepEqual(await page.evaluate(rows), ['/home/dev/work/very/deeply/nested', '~/repos']);
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});

test('headless Chromium: every settings tab fits 360 px without sideways scrolling, light and dark', async (t) => {
  const chrome = browserSkip(t);
  if (!chrome) return;
  const stub = await createStubServer({ token: 'tok', scenario: 'empty', installStepMs: 2000 });
  t.after(() => stub.close());
  stub.state.config.jira = { baseUrl: 'https://a-really-long-company-name.atlassian.net', email: 'someone.with.a.long.name@a-really-long-company-name.com', apiToken: 'x' };
  stub.state.config.workspace.roots = ['/home/dev/code', '/home/dev/work/very/deeply/nested/client-projects/2026/infrastructure-and-tools'];
  const shots = process.env.ANYWHERE_TEST_SHOTS || '';
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const page = await openPage(chrome, { width: 360, height: 720 });
  t.after(() => page.close());
  const overflow = `(() => {
    const W = document.documentElement.clientWidth;
    const out = [];
    for (const e of document.querySelectorAll('#drawer *')) {
      if (e.offsetParent === null || e.closest('.set-tabs')) continue;
      const r = e.getBoundingClientRect();
      if (r.width && r.right > W + 0.5) out.push((e.id || e.className || e.tagName) + '@' + Math.round(r.right));
    }
    const form = document.getElementById('settings-form');
    if (form.scrollWidth > form.clientWidth) out.push('form scrolls sideways');
    const tabs = document.getElementById('set-tabs');
    if (tabs.scrollWidth > tabs.clientWidth + 1) out.push('tabs do not fit');
    return out;
  })()`;
  for (const [width, themes] of [[360, ['light', 'dark']], [440, ['light', 'dark']]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false });
    for (const theme of themes) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await loadDialog(page, stub);
      await openSettings(page);
      for (const name of ['general', 'voice', 'work', 'advanced']) {
        await tab(page, name);
        // Measure the drawer where it rests, not mid slide-in.
        await page.evaluate(`document.getAnimations().forEach((a) => a.finish())`);
        if (name === 'voice') assert.ok(await waitFor(page, `document.getElementById('piper-state').textContent !== 'Checking…'`));
        if (name === 'work') assert.ok(await waitFor(page, `!document.getElementById('roots-suggest').hidden`));
        await page.evaluate(`document.querySelectorAll('#settings-form .set-panel:not([hidden]) details').forEach((d) => { d.open = true; })`);
        assert.deepEqual(await page.evaluate(overflow), [], `${name} at ${width} px (${theme})`);
        if (shots && (name === 'voice' || name === 'work')) {
          for (const [suffix, top] of [['top', 0], ['bottom', 99999]]) {
            await page.evaluate(`document.getElementById('settings-form').scrollTop = ${top}`);
            await sleep(120);
            const r = await page.send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(shots, `settings-${name}-${theme}-${width}-${suffix}.png`), Buffer.from(r.result.data, 'base64'));
          }
        }
      }
      await page.evaluate(`document.getElementById('cancel-settings').click()`);
    }
  }
  assert.deepEqual(page.problems, [], page.problems.join('\n'));
});
