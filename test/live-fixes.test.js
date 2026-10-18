'use strict';

// Regressions found by the live run of the voice and Jira-ticket features (Xvfb, real claude CLI):
// spoken questions read whole paths and "(Recommended)" aloud, spoken results read commit hashes,
// and the dialog's branch chip kept showing "main" after Claude created the ticket branch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-live-fixes-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const configMod = require('../src/shared/config');
const { sleep } = require('../src/shared/util');
const { Hub } = require('../src/daemon/hub');
const { QuestionBroker } = require('../src/daemon/questions');
const { Bridge } = require('../src/daemon/bridge');
const { SessionManager } = require('../src/daemon/session');
const a = require('../src/daemon/announcer');

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('spoken questions: the asking sentence of a long question, options without paths or asides', () => {
  assert.equal(
    a.composeQuestion({
      question: 'ABC-123 "Fix login timeout" (High, shop-api) is a 30s-vs-minutes bug in src/auth.js. The project open here (other-repo) has no code, so where should I work?',
      options: ['shop-api — /tmp/work/shop-api (Recommended)', 'Another folder (type the path)', 'Create a new folder'],
    }),
    'Quick question: The project open here (other-repo) has no code, so where should I work? Options are shop-api, Another folder or Create a new folder.',
  );
  // Short questions and plain options are unchanged.
  assert.equal(
    a.composeQuestion({ question: 'Move ABC-123 to In Progress and assign it to you before I start?', options: ['Yes, both', 'Only assign', 'No'] }),
    'Quick question: Move ABC-123 to In Progress and assign it to you before I start? Options are Yes, both, Only assign or No.',
  );
  // A long text whose last sentence is not a question is kept whole (then truncated as before).
  const statement = `${'This is context. '.repeat(10)}Pick one.`;
  assert.equal(a.spokenQuestion(statement), statement.trim());
  // Bare paths become folder names; an option that is only an aside stays as it is.
  assert.equal(a.spokenOption('/home/me/code/shop-api'), 'shop-api');
  assert.equal(a.spokenOption('C:\\code\\web\\'), 'web');
  assert.equal(a.spokenOption('~/src/app'), 'app');
  assert.equal(a.spokenOption('(none)'), '(none)');
  assert.equal(a.spokenOption('Yes (recommended)'), 'Yes');
  assert.equal(a.spokenOption('us-central1 – Iowa'), 'us-central1');
});

test('spoken results leave out commit hashes in brackets', () => {
  assert.equal(
    a.composeDone({ text: 'ABC-123 is fixed in a local commit on `ABC-123-fix-login-timeout` (67a4700), and `npm test` passes 4/4. More.' }, { opener: 'Done!' }),
    'Done! ABC-123 is fixed in a local commit on ABC-123-fix-login-timeout, and npm test passes 4/4. More.',
  );
  assert.equal(a.composeDone({ text: 'Committed (commit `abc1234def`) on main.' }, { opener: 'Done!' }), 'Done! Committed on main.');
  // Numbers and words in brackets are not hashes.
  assert.equal(a.composeDone({ text: 'Call (1234567) and (deadbeef) and (CAFE2024) stay.' }, { opener: 'Done!' }), 'Done! Call (1234567) and (deadbeef) and (CAFE2024) stay.');
});

test('a permission for a command chain names the step the card is about, not the first one', () => {
  const card = (summary, reason) => ({ toolName: 'Bash', summary, input: {}, risk: 'high', reason });
  assert.equal(
    a.composePermission(
      card(
        'Run: cd /tmp/work/shop-api && npm test 2>&1 | tail -10 && git -c user.name="Dev Tester" -c user.email="dev@example.com" checkout -b ABC-123-fix-login-timeout',
        'Overrides git configuration (can run commands) — in: git -c user.name="Dev Tester" -c user.email="dev@example.com" checkout -b ABC-12…',
      ),
    ),
    'I need your permission to run git checkout.',
  );
  // Truncated mid-word by the policy: still the right program, never the first step's.
  assert.equal(
    a.composePermission(card('Run: git add a && git -c user.name="${X:-$(git config user.name)}" commit', 'Overrides git configuration (can run commands) — in: git -c user.name="${GIT_AUTHOR_NAME:-$(…)}" -c user.email="${GIT_AUTHOR_EMAIL:-…')),
    'I need your permission to run git.',
  );
  // One command: unchanged.
  assert.equal(a.composePermission(card('Run: sudo apt-get install -y cowsay', 'Installs or removes software on the system (apt-get install)')), 'I need your permission to run apt-get install as administrator.');
  // Quoted words with spaces stay one word; -C/-c take a value.
  assert.equal(a.humanizeCommand('rm -rf "my folder/build"'), 'delete the folder my folder/build');
  assert.equal(a.humanizeCommand('git -C repo status'), 'run git status');
  assert.equal(a.humanizeCommand('make -C build install'), 'run make install');
});

test('spoken results keep branch names before a comma and snake_case names', () => {
  const { secretLike } = require('../src/daemon/permissions');
  const { stripMarkdownForSpeech } = require('../src/shared/util');
  assert.equal(
    a.composeDone(
      { text: 'ABC-123 is fixed and committed on branch `ABC-123-fix-login-timeout`, and `npm test` passes (4 tests). The session timeout now reads `LOGIN_TIMEOUT_MINUTES` and defaults to 30 minutes. More.' },
      { opener: 'Done!', secretLike },
    ),
    'Done! ABC-123 is fixed and committed on branch ABC-123-fix-login-timeout, and npm test passes (4 tests). The session timeout now reads LOGIN_TIMEOUT_MINUTES and defaults to 30 minutes.',
  );
  // A real secret is still hidden, and the punctuation after it stays.
  assert.equal(a.composeDone({ text: 'Set the password to Xk9#mP2qL7vR4wZ1, then restart.' }, { opener: 'Done!', secretLike }), 'Done! Set the password to hidden, then restart.');
  // Emphasis is removed only at word edges (as in src/ui/voice.js).
  assert.equal(stripMarkdownForSpeech('Use *this* and _that_ and snake_case_name or a*b*c.'), 'Use this and that and snake_case_name or a*b*c.');
});

/** Scripted engine (the same shape as test/daemon-session.test.js). */
class ScriptEngine extends EventEmitter {
  static async locate() {
    return { path: '/fake/claude', version: '1.0.0' };
  }

  constructor(opts) {
    super();
    this.opts = opts;
    this.sawInit = false;
    this.alive = false;
    this.sent = [];
    ScriptEngine.instances.push(this);
  }

  get running() {
    return this.alive;
  }

  start() {
    this.alive = true;
  }

  send(blocks) {
    this.sent.push(blocks);
  }

  feed(msg) {
    if (msg.type === 'system' && msg.subtype === 'init') this.sawInit = true;
    this.emit('message', { parent_tool_use_id: null, ...msg });
  }

  async interrupt() {
    this.feed({ type: 'result', result: '', total_cost_usd: 0, is_error: true, subtype: 'error_during_execution' });
    return { ok: true, killed: false };
  }

  async stop() {
    if (!this.alive) return;
    this.alive = false;
    this.emit('exit', { code: 0, signal: null, stderrTail: '', expected: true, sawInit: this.sawInit, uptimeMs: 1 });
  }
}
ScriptEngine.instances = [];

test('after a turn the project git state is read again, so a new branch shows in the dialog', async () => {
  ScriptEngine.instances = [];
  const config = configMod.load();
  config.context.attachDesktopContext = false;
  const hub = new Hub();
  const events = [];
  hub.on('event', (type, data) => events.push({ type, data }));
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  let branch = 'main';
  let calls = 0;
  const context = {
    projectInfo: async (dir) => {
      calls += 1;
      return { dir, name: path.basename(dir), git: { branch, dirty: 0 } };
    },
  };
  const s = new SessionManager({ config, hub, questions: new QuestionBroker({ hub }), bridge: new Bridge({ hub }), port: 1234, token: 'tok', projectDir, mode: 'companion', Engine: ScriptEngine, context });
  const projects = () => events.filter((e) => e.type === 'project').map((e) => e.data.git && e.data.git.branch);
  try {
    await s.init();
    assert.deepEqual(projects(), ['main']);
    await s.submit({ text: 'start ABC-123' });
    for (let i = 0; i < 200 && !ScriptEngine.instances.length; i += 1) await sleep(5);
    const e = ScriptEngine.instances[0];
    await s.drain();
    e.feed({ type: 'system', subtype: 'init', session_id: e.opts.sessionId, model: 'claude-x' });
    branch = 'ABC-123-fix-login-timeout';
    e.feed({ type: 'result', result: 'Started on ABC-123-fix-login-timeout.', total_cost_usd: 0.01, duration_ms: 5000, num_turns: 3, is_error: false });
    for (let i = 0; i < 100 && projects().length < 2; i += 1) await sleep(5);
    assert.deepEqual(projects(), ['main', 'ABC-123-fix-login-timeout']);
    assert.equal(s.snapshot().project.git.branch, 'ABC-123-fix-login-timeout');

    // Nothing changed: no extra event.
    const before = calls;
    await s.submit({ text: 'and now?' });
    await s.drain();
    e.feed({ type: 'result', result: 'ok', total_cost_usd: 0.02, duration_ms: 10, num_turns: 1, is_error: false });
    for (let i = 0; i < 100 && calls === before; i += 1) await sleep(5);
    await sleep(20);
    assert.equal(projects().length, 2);
  } finally {
    await s.shutdown();
    hub.close();
  }
});
