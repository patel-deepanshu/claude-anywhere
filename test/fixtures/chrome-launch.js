'use strict';

/**
 * Starts headless Chromium with a DevTools port for the browser tests
 * (integration-ui.test.js, ui-round2.test.js) and waits until it is ready.
 *
 * A cold start on a CI runner (first launch, empty font and shader caches, other test
 * files running in parallel) can take well over 15 s, so the wait is generous
 * (ANYWHERE_TEST_CHROME_START_MS, default 60 s). A browser that exits early is
 * reported at once with the end of its stderr, and a start that fails is retried
 * once with a fresh profile.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const START_MS = Number(process.env.ANYWHERE_TEST_CHROME_START_MS) || 60000;

function startOnce(chrome, extraArgs, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const proc = spawn(
    chrome,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', ...extraArgs, `--user-data-dir=${dir}`, '--remote-debugging-port=0', 'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d.toString('utf8')).slice(-2000);
  });
  let exited = null;
  proc.on('exit', (code, signal) => {
    exited = signal || `code ${code}`;
  });
  proc.on('error', (err) => {
    exited = err.message;
  });
  const cleanup = () => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500).unref();
  };
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      let port = null;
      try {
        port = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
      } catch {
        /* not yet */
      }
      if (port) return resolve({ proc, port, dir, cleanup });
      const waited = Date.now() - started;
      if (exited || waited > START_MS) {
        cleanup();
        const why = exited ? `exited (${exited})` : `did not open its DevTools port within ${Math.round(waited / 1000)} s`;
        const tail = stderr.trim() ? `; stderr: ${stderr.trim().split('\n').slice(-5).join(' | ')}` : '';
        return reject(new Error(`Chromium did not start: ${why}${tail}`));
      }
      return setTimeout(poll, 100);
    };
    setTimeout(poll, 100);
  });
}

/** Resolves {proc, port, dir, cleanup}; cleanup() kills the browser and removes its profile. */
async function launchChrome(chrome, { extraArgs = [], prefix = 'anywhere-chrome-' } = {}) {
  try {
    return await startOnce(chrome, extraArgs, prefix);
  } catch (first) {
    try {
      return await startOnce(chrome, extraArgs, prefix);
    } catch (second) {
      second.message = `${second.message} (first attempt: ${first.message})`;
      throw second;
    }
  }
}

module.exports = { launchChrome, START_MS };
