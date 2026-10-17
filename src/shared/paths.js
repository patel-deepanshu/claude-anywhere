'use strict';

/**
 * Filesystem locations used by Claude Anywhere. Everything that persists lives
 * under one state directory (default ~/.claude-anywhere, override with
 * ANYWHERE_HOME) so uninstalling is a single `rm -rf`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

function ensureDir(dir, mode = 0o700) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return dir;
}

/** @returns {string} the state directory, created with 0700 if missing */
function stateDir() {
  const dir = process.env.ANYWHERE_HOME
    ? path.resolve(process.env.ANYWHERE_HOME)
    : path.join(os.homedir(), '.claude-anywhere');
  return ensureDir(dir);
}

function configPath() {
  return path.join(stateDir(), 'config.json');
}

function daemonStatePath() {
  return path.join(stateDir(), 'daemon.json');
}

function sessionsPath() {
  return path.join(stateDir(), 'sessions.json');
}

function installInfoPath() {
  return path.join(stateDir(), 'install.json');
}

function logsDir() {
  return ensureDir(path.join(stateDir(), 'logs'));
}

/** @param {Date} [date] */
function auditLogPath(date = new Date()) {
  const d = date.toISOString().slice(0, 10);
  return path.join(logsDir(), `audit-${d}.jsonl`);
}

function daemonLogPath() {
  return path.join(logsDir(), 'daemon.log');
}

function runDir() {
  return ensureDir(path.join(stateDir(), 'run'));
}

function uiProfileDir() {
  return ensureDir(path.join(stateDir(), 'ui-profile'));
}

function modelsDir() {
  return ensureDir(path.join(stateDir(), 'models'));
}

function lastShotPath() {
  return path.join(runDir(), 'last-shot.json');
}

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
}

module.exports = {
  PACKAGE_ROOT,
  ensureDir,
  stateDir,
  configPath,
  daemonStatePath,
  sessionsPath,
  installInfoPath,
  logsDir,
  auditLogPath,
  daemonLogPath,
  runDir,
  uiProfileDir,
  modelsDir,
  lastShotPath,
  claudeHome,
};
