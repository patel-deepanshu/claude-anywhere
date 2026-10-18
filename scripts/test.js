#!/usr/bin/env node
'use strict';

/**
 * Test runner (npm test): runs `node --test` on every test/*.test.js file.
 *
 * The file list is built here rather than with a shell glob, because cmd.exe does not
 * expand `test/*.test.js` and Node 18/20 do not expand globs given to --test.
 * Extra arguments are passed to node --test first (e.g. --test-name-pattern=voice).
 *
 * After the run it prints a recap of every failing test (file:line, name, the first lines of
 * the error), so the failures are at the end of the output even with the TAP reporter, whose
 * failures are otherwise buried in the middle of a long CI log. The recap comes from a second
 * reporter (scripts/test-reporter.js) that writes the failures to a temporary file; the normal
 * reporter is the one node --test would pick (spec on a terminal, else TAP) or the caller's own
 * --test-reporter options.
 *
 * Usage: node scripts/test.js [node --test options]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const REPORTER = path.join(__dirname, 'test-reporter.js');
const ERROR_LINES = 10;
const MAX_LISTED = 50;

function testFiles(dir = TEST_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join(dir, f));
}

/** The reporter node --test uses when none is given: spec on a terminal (always from Node 23), else TAP. */
function defaultReporter(isTTY = Boolean(process.stdout.isTTY), nodeVersion = process.versions.node) {
  return isTTY || Number(String(nodeVersion).split('.')[0]) >= 23 ? 'spec' : 'tap';
}

function countFlag(argv, flag) {
  const re = new RegExp(`^${flag}(=|$)`);
  return argv.filter((a) => re.test(a)).length;
}

/**
 * The reporter options that add the failure recorder (writing to `out`) to the caller's argv, or
 * null when the caller's own --test-reporter options leave no clean way to add one.
 */
function reporterArgs(argv, out, { isTTY, nodeVersion } = {}) {
  const reporters = countFlag(argv, '--test-reporter');
  const destinations = countFlag(argv, '--test-reporter-destination');
  const recorder = [`--test-reporter=${pathToFileURL(REPORTER).href}`, `--test-reporter-destination=${out}`];
  if (reporters === 0 && destinations === 0) {
    return [`--test-reporter=${defaultReporter(isTTY, nodeVersion)}`, '--test-reporter-destination=stdout', ...recorder];
  }
  // A lone --test-reporter writes to stdout; with a second reporter each one needs its destination.
  if (destinations === 0) return [...Array(reporters).fill('--test-reporter-destination=stdout'), ...recorder];
  if (destinations === reporters) return recorder;
  return null;
}

function readFailures(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a line cut short by a crash */
    }
  }
  return out;
}

function shortPath(file) {
  if (!file) return '';
  let p = String(file);
  if (p.startsWith('file://')) {
    try {
      p = require('url').fileURLToPath(p);
    } catch {
      /* keep the URL */
    }
  }
  const rel = path.relative(ROOT, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
}

/** The recap printed after the run: every failing test with the first lines of its error. */
function failureSummary(failures, { exitCode = 1 } = {}) {
  const lines = [];
  const rule = '#'.padEnd(78, '-');
  if (!failures.length) {
    if (exitCode === 0) return '';
    lines.push(rule, `# node --test exited with code ${exitCode}, but no failing test was recorded; see the output above.`, rule);
    return `${lines.join('\n')}\n`;
  }
  lines.push(rule, `# ${failures.length} failing test${failures.length === 1 ? '' : 's'}:`);
  for (const f of failures.slice(0, MAX_LISTED)) {
    const where = [shortPath(f.file), f.line].filter(Boolean).join(':');
    const name = f.file && f.name === f.file ? '(the test file itself)' : f.name;
    lines.push('#', `# FAIL ${where ? `${where}  ` : ''}${name}${f.failureType && f.failureType !== 'testCodeFailure' ? ` (${f.failureType})` : ''}`);
    const errLines = String(f.error || '')
      .split(/\r?\n/)
      .filter((l) => !/^\s+at (.*\((node:|internal\/|<anonymous>\))|node:|async node:)/.test(l))
      .map((l) => l.split(ROOT + path.sep).join(''));
    while (errLines.length && !errLines[errLines.length - 1].trim()) errLines.pop();
    for (const l of errLines.slice(0, ERROR_LINES)) lines.push(`#     ${l}`.trimEnd());
    if (errLines.length > ERROR_LINES) lines.push(`#     ... ${errLines.length - ERROR_LINES} more line(s) in the full output above`);
  }
  if (failures.length > MAX_LISTED) lines.push('#', `# ... and ${failures.length - MAX_LISTED} more failing tests (see the output above)`);
  lines.push(rule);
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const files = testFiles();
  if (!files.length) {
    process.stderr.write(`No *.test.js files found in ${TEST_DIR}\n`);
    return 1;
  }
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-failures-'));
  } catch {
    tmp = null; // run without the recap
  }
  const out = tmp && path.join(tmp, 'failures.jsonl');
  const extra = out ? reporterArgs(argv, out) : null;
  const r = spawnSync(process.execPath, ['--test', ...argv, ...(extra || []), ...files], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`Could not run node --test: ${r.error.message}\n`);
    return 1;
  }
  const code = r.signal ? 1 : r.status == null ? 1 : r.status;
  if (extra) process.stdout.write(failureSummary(readFailures(out), { exitCode: code }));
  if (tmp) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* a temp file left behind */
    }
  }
  return code;
}

if (require.main === module) process.exitCode = main();

module.exports = { testFiles, main, reporterArgs, defaultReporter, failureSummary };
