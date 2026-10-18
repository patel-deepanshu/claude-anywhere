'use strict';

// Regression tests for the shared-docs fix group: secret redaction in log
// lines (and the privacy.redactSecretsInLogs setting), the npm test script,
// and the ARCHITECTURE contract's references.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-shared-docs-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const log = require('../src/shared/log');
const paths = require('../src/shared/paths');

const GH_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const SK_TOKEN = `sk-live-${'x9Y8z7W6v5'.repeat(3)}`;

/** Run fn with process.stderr.write captured; returns everything written. */
function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk, ...rest) => {
    out += String(chunk);
    const cb = rest.find((r) => typeof r === 'function');
    if (cb) cb();
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

function readAudit() {
  try {
    return fs.readFileSync(paths.auditLogPath(), 'utf8');
  } catch {
    return '';
  }
}

test.after(() => {
  log.setRedactLogs(true);
  log.setAuditEnabled(true);
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('string log messages are redacted (approval summaries carry raw commands)', () => {
  log.setRedactLogs(true);
  const logger = log.createLogger('perm');
  const out = captureStderr(() => {
    logger.info(`approval needed (high, network): Run: curl -H 'Authorization: Bearer ${GH_TOKEN}' https://api.github.com`);
    logger.warn('deploying with', `--set-env-vars API_KEY=${SK_TOKEN}`);
  });
  assert.match(out, /approval needed/);
  assert.ok(!out.includes(GH_TOKEN), out);
  assert.ok(!out.includes(SK_TOKEN), out);
  assert.match(out, /Authorization: Bearer \S*\*\*\*/);
  assert.match(out, /API_KEY=\*\*\*/);
});

test('Error stacks and messages are redacted too', () => {
  log.setRedactLogs(true);
  const logger = log.createLogger('engine');
  const out = captureStderr(() => logger.error('engine failed:', new Error(`spawn failed: token=${GH_TOKEN}`)));
  assert.match(out, /engine failed:/);
  assert.match(out, /spawn failed/);
  assert.ok(!out.includes(GH_TOKEN), out);
});

test('object arguments stay deeply redacted', () => {
  log.setRedactLogs(true);
  const out = captureStderr(() => log.createLogger('x').info('state', { cmd: `echo ${GH_TOKEN}`, token: 'abc' }));
  assert.ok(!out.includes(GH_TOKEN), out);
  assert.match(out, /"token":"\*\*\*"/);
});

test('setRedactLogs(false) keeps log text verbatim but still masks credential keys and elides images', () => {
  log.setRedactLogs(false);
  try {
    const out = captureStderr(() =>
      log.createLogger('x').info(`raw ${GH_TOKEN}`, { token: 'daemon-token', image: 'A'.repeat(400) })
    );
    assert.ok(out.includes(GH_TOKEN), out);
    assert.match(out, /"token":"\*\*\*"/);
    assert.match(out, /"image":"\[400 chars\]"/);
    // redact() itself is used for secret detection and approval cards: it always masks.
    assert.ok(!log.redact(`x ${GH_TOKEN}`).includes(GH_TOKEN));
  } finally {
    log.setRedactLogs(true);
  }
});

test('the audit log honors the redaction setting', () => {
  log.setAuditEnabled(true);
  log.setRedactLogs(true);
  log.audit({ type: 'tool', command: `curl -H "Authorization: Bearer ${GH_TOKEN}"` });
  let text = readAudit();
  assert.match(text, /"type":"tool"/);
  assert.ok(!text.includes(GH_TOKEN), text);

  log.setRedactLogs(false);
  try {
    log.audit({ type: 'tool2', command: `echo ${SK_TOKEN}`, apiKey: 'k' });
    text = readAudit();
    assert.ok(text.includes(SK_TOKEN), text);
    assert.match(text, /"apiKey":"\*\*\*"/);
  } finally {
    log.setRedactLogs(true);
  }
});

test('applyPrivacyConfig wires privacy.redactSecretsInLogs and privacy.auditLog', () => {
  const logger = log.createLogger('cfg');
  const line = () => captureStderr(() => logger.info(`t ${GH_TOKEN}`));
  try {
    log.applyPrivacyConfig({ privacy: { redactSecretsInLogs: false, auditLog: true } });
    assert.ok(line().includes(GH_TOKEN));
    log.applyPrivacyConfig({ privacy: { redactSecretsInLogs: true, auditLog: true } });
    assert.ok(!line().includes(GH_TOKEN));
    // Missing or partial config keeps both defaults on.
    log.applyPrivacyConfig({ privacy: { redactSecretsInLogs: false } });
    log.applyPrivacyConfig({});
    assert.ok(!line().includes(GH_TOKEN));

    log.applyPrivacyConfig({ privacy: { auditLog: false } });
    const before = readAudit();
    log.audit({ type: 'should_not_be_written' });
    assert.equal(readAudit(), before);
  } finally {
    log.applyPrivacyConfig(null);
  }
  log.audit({ type: 'written_again' });
  assert.match(readAudit(), /written_again/);
});

test('npm test lists the test files instead of a bare directory (Node 21+ treats test/ as a module)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const script = pkg.scripts.test;
  assert.doesNotMatch(script, /--test\s+test\/?(\s|$)/);
  // CROSS-MODULE-9: scripts/test.js builds the file list itself, so cmd.exe with Node 18/20
  // (no glob expansion) runs the same files as a POSIX shell.
  assert.equal(script, 'node scripts/test.js');
  const runner = require(path.join(ROOT, 'scripts', 'test.js'));
  const files = runner.testFiles().map((f) => path.relative(path.join(ROOT, 'test'), f));
  assert.deepEqual(files, fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort());
  assert.ok(files.includes('shared-docs-fixes.test.js'));
  // The pattern must not reach fixtures (they are not tests).
  assert.ok(files.every((f) => !f.includes('fixtures')));
  assert.ok(fs.readdirSync(path.join(ROOT, 'test', 'fixtures')).every((f) => !f.endsWith('.test.js')));
  const arch = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
  const testing = arch.slice(arch.indexOf('## 12. Testing'));
  assert.ok(testing.includes('`node --test test/*.test.js`'), 'ARCHITECTURE §12 documents the test command');
});

test('ARCHITECTURE file layout and doc references point at files that exist', () => {
  const arch = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'PLAN.md'), 'utf8');
  const docs = arch.match(/^docs\/\{([^}]+)\}\.md$/m);
  assert.ok(docs, 'layout lists docs/{...}.md');
  for (const name of docs[1].split(',')) {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs', `${name.trim()}.md`)), `docs/${name.trim()}.md exists`);
  }
  const ci = arch.match(/\.github\/workflows\/[\w.-]+\.ya?ml/g) || [];
  for (const f of ci) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  for (const text of [arch, plan]) {
    for (const ref of new Set(text.match(/\b[A-Z][A-Z_]+\.md\b/g) || [])) {
      if (ref === 'SKILL.md' || ref === 'README.md' || ref === 'CLAUDE.md') continue;
      assert.ok(fs.existsSync(path.join(ROOT, 'docs', ref)), `referenced docs/${ref} exists`);
    }
  }
});

test('the CI workflow runs the syntax check and npm test on all three OSes', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const osName of ['ubuntu-latest', 'macos-latest', 'windows-latest']) assert.ok(yml.includes(osName), osName);
  assert.match(yml, /run: npm run lint/);
  assert.match(yml, /run: npm test/);
});

test('ARCHITECTURE documents every /api/mcp/ask outcome and the real MCP_TOOL_TIMEOUT rule', () => {
  const arch = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
  const row = arch.split('\n').find((l) => l.startsWith('| POST `/api/mcp/ask`'));
  assert.ok(row, 'ask row present');
  for (const shape of ['{id, answer}', '{id, timeout:true}', '{id, cancelled:true, reason}']) assert.ok(row.includes(shape), shape);
  assert.doesNotMatch(arch, /unless already set\) `MCP_TOOL_TIMEOUT/);
  assert.match(arch, /MCP_TOOL_TIMEOUT` raised to at least 3600000/);
});
