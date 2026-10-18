#!/usr/bin/env node
'use strict';

/**
 * Test runner (npm test): runs `node --test` on every test/*.test.js file.
 *
 * The file list is built here rather than with a shell glob, because cmd.exe does not
 * expand `test/*.test.js` and Node 18/20 do not expand globs given to --test.
 * Extra arguments are passed to node --test first (e.g. --test-name-pattern=voice).
 *
 * Usage: node scripts/test.js [node --test options]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = path.join(__dirname, '..', 'test');

function testFiles(dir = TEST_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join(dir, f));
}

function main(argv = process.argv.slice(2)) {
  const files = testFiles();
  if (!files.length) {
    process.stderr.write(`No *.test.js files found in ${TEST_DIR}\n`);
    return 1;
  }
  const r = spawnSync(process.execPath, ['--test', ...argv, ...files], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`Could not run node --test: ${r.error.message}\n`);
    return 1;
  }
  if (r.signal) return 1;
  return r.status == null ? 1 : r.status;
}

if (require.main === module) process.exit(main());

module.exports = { testFiles, main };
