#!/usr/bin/env node
'use strict';

// Launcher for /anywhere:clone-voice: forwards to the /anywhere skill's launcher (which finds the
// Claude Anywhere package), e.g. `node run.js clone-voice status`, with the same exit code.
const path = require('path');
const childProcess = require('child_process');

const child = childProcess.spawn(process.execPath, [path.join(__dirname, '..', 'anywhere', 'run.js')].concat(process.argv.slice(2)), { stdio: 'inherit' });
child.on('error', function (err) {
  process.stderr.write('Could not start the Claude Anywhere launcher: ' + err.message + '\n');
  process.exit(1);
});
child.on('exit', function (code) {
  process.exit(code == null ? 1 : code);
});
