'use strict';

/**
 * scripts/test.js prints a recap of the failing tests after the run, so a CI log that keeps only
 * its last lines still names them (the TAP reporter buries them mid-log).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const runner = require('../scripts/test.js');
const reporter = require('../scripts/test-reporter.js');

test('test runner: the failure recorder is added next to the default or the caller\'s reporter', () => {
  const out = path.join(ROOT, 'failures.jsonl');
  const ci = runner.reporterArgs([], out, { isTTY: false, nodeVersion: '22.3.0' });
  assert.equal(ci[0], '--test-reporter=tap', 'TAP when not on a terminal, as node --test does');
  assert.equal(ci[1], '--test-reporter-destination=stdout');
  assert.match(ci[2], /^--test-reporter=file:\/\/.*test-reporter\.js$/);
  assert.equal(ci[3], `--test-reporter-destination=${out}`);
  assert.equal(runner.reporterArgs([], out, { isTTY: true, nodeVersion: '18.20.4' })[0], '--test-reporter=spec');
  assert.equal(runner.reporterArgs([], out, { isTTY: false, nodeVersion: '23.0.0' })[0], '--test-reporter=spec');
  // A lone --test-reporter gets stdout as its destination; matched pairs are kept as given.
  assert.deepEqual(runner.reporterArgs(['--test-reporter=dot'], out).slice(0, 1), ['--test-reporter-destination=stdout']);
  assert.equal(runner.reporterArgs(['--test-reporter', 'dot', '--test-reporter-destination', 'stdout'], out).length, 2);
  assert.equal(runner.reporterArgs(['--test-reporter=dot', '--test-reporter=tap', '--test-reporter-destination=stdout'], out), null);
});

test('test runner: the recap lists each failing test with file:line, name and the start of its error', async () => {
  const file = path.join(ROOT, 'test', 'x.test.js');
  const cause = new Error('Expected values to be strictly equal:\n\n1 !== 2\n');
  cause.stack = `AssertionError [ERR_ASSERTION]: ${cause.message}\n    at TestContext.<anonymous> (${file}:7:10)\n    at Test.runInAsyncScope (node:async_hooks:214:14)`;
  const fail = (name, failureType, extra = {}) => ({
    type: 'test:fail',
    data: { name, file, line: 7, nesting: 0, details: { error: Object.assign(new Error('x'), { failureType, cause }) }, ...extra },
  });
  async function* events() {
    yield { type: 'test:pass', data: { name: 'fine', file } };
    yield fail('a leaf', 'testCodeFailure');
    yield fail('its parent', 'subtestsFailed');
    yield fail('a todo', 'testCodeFailure', { todo: true });
  }
  let jsonl = '';
  for await (const chunk of reporter(events())) jsonl += chunk;
  const failures = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(failures.map((f) => f.name), ['a leaf'], 'parents of failing subtests and todo tests are left out');

  const text = runner.failureSummary(failures);
  assert.match(text, /# 1 failing test:/);
  assert.match(text, /# FAIL test\/x\.test\.js:7 {2}a leaf\n/);
  assert.match(text, /# {5}AssertionError \[ERR_ASSERTION\]: Expected values to be strictly equal:/);
  assert.match(text, /1 !== 2/);
  assert.match(text, /at TestContext\.<anonymous> \(test[\\/]x\.test\.js:7:10\)/);
  assert.doesNotMatch(text, /node:async_hooks/, 'node-internal frames are dropped');
  assert.equal(runner.failureSummary([], { exitCode: 0 }), '');
  assert.match(runner.failureSummary([], { exitCode: 1 }), /exited with code 1, but no failing test was recorded/);
});
