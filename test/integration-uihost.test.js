'use strict';

/**
 * End to end for the dialog hosts: the real daemon (runDaemon + fake-claude engine + mock
 * desktop driver) driven through the terminal TUI, plus /api/show through the real UiHost.
 * Skips itself while the daemon, MCP server or OS layer are not present.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const REQUIRED = ['src/daemon/main.js', 'src/mcp/server.js', 'src/mcp/tools.js', 'src/os/index.js', 'src/os/computer.js', 'test/fixtures/fake-claude.js'];
const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(ROOT, f)));
const SKIP = missing.length ? `needs ${missing.join(', ')}` : false;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-uihost-int-'));
process.env.ANYWHERE_HOME = HOME;
process.env.ANYWHERE_DRIVER = 'mock';
delete process.env.ANYWHERE_LOG_FILE;
delete process.env.ANYWHERE_DAEMON_URL;
delete process.env.ANYWHERE_TOKEN;

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForText(get, re, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (re.test(get())) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}; output tail:\n${get().slice(-1500)}`);
}

test('TUI drives the real daemon: streaming, tools, approvals, questions, /status, /show', { skip: SKIP, timeout: 120000 }, async () => {
  try {
    fs.chmodSync(FAKE, 0o755);
  } catch {
    /* node fallback */
  }
  fs.writeFileSync(
    path.join(HOME, 'config.json'),
    JSON.stringify({
      port: 0,
      ui: { host: 'none', openOnStart: false },
      engine: { claudePath: FAKE, addVsCodeWorkspaces: false, resumeLast: false },
      permissions: { mode: 'ask' },
      context: { attachDesktopContext: false },
      voice: { speakResponses: false },
    })
  );
  const project = fs.mkdtempSync(path.join(HOME, 'repo-'));
  const { runDaemon } = require('../src/daemon/main');
  const { DaemonClient } = require('../src/shared/client');
  const { Tui } = require('../src/tui/tui');

  const d = await runDaemon({ project, open: false, handleSignals: false });
  const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${d.port}`, token: d.token });
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => {
    text += c.toString();
  });
  const get = () => text;
  const tui = new Tui({ client, input, output, env: { NO_COLOR: '1' } });
  const done = tui.run();
  try {
    await waitForText(get, /Claude Anywhere v[\d.]+/, 'the snapshot header');
    assert.ok(!text.includes('\x1b['), 'NO_COLOR output is plain');

    input.write('please run TOOL_TEST\n');
    await waitForText(get, /✓ Done/, 'the first result');
    assert.match(text, /You: please run TOOL_TEST/, 'piped input is echoed from the daemon');
    assert.match(text, /⚙ .+ … ✓/, 'a finished tool row');
    assert.match(text, /Claude: \S/, 'an assistant reply');

    input.write('APPROVE_TEST\n');
    await waitForText(get, /Approval needed/, 'the approval card');
    assert.match(text, /\[y\]es \/ \[a\]lways \/ \[n\]o/);
    input.write('y\n');
    await waitForText(get, /DECISION: allow/, 'the allowed decision reaching Claude');
    assert.match(text, /› Allowed once/);

    input.write('ASK_TEST\n');
    await waitForText(get, /\? Claude asks:/, 'the question card');
    input.write('blue\n');
    await waitForText(get, /ANSWER: .*blue/, 'the answer reaching Claude');

    input.write('/status\n');
    await waitForText(get, /Mode: +companion/, 'the status summary');

    const shown = await client.request('POST', '/api/show');
    assert.equal(shown.ok, true);
    assert.equal(typeof shown.host, 'string');
  } finally {
    tui.quit();
    await done;
    await d.shutdown('test');
  }
});

test('UiHost inside a daemon: host "none" reports the URL and the TUI hint', { skip: SKIP }, async () => {
  const { UiHost } = require('../src/daemon/uihost');
  const host = new UiHost({ config: { ui: { host: 'none' } }, platformInfo: { platform: 'linux', isWSL: false }, driver: null, env: {} });
  const url = 'http://127.0.0.1:1/?token=t';
  assert.deepEqual(await host.open(url), { host: 'none', detail: `Open ${url} in a browser or run: anywhere tui` });
  assert.deepEqual(await host.show(url), { host: 'none' });
  await host.close();
  assert.deepEqual(host.status(), { host: 'none', open: false });
});
