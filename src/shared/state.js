'use strict';

/** The running daemon's coordinates (pid, port, token) in daemon.json. */

const fs = require('fs');
const { daemonStatePath } = require('./paths');

function readDaemonState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(daemonStatePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeDaemonState(obj) {
  const file = daemonStatePath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

/** Remove daemon.json, optionally only if it still belongs to instanceId. */
function clearDaemonState(instanceId) {
  try {
    if (instanceId) {
      const cur = readDaemonState();
      if (cur && cur.instanceId && cur.instanceId !== instanceId) return;
    }
    fs.unlinkSync(daemonStatePath());
  } catch {
    /* already gone */
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Return the daemon state if a healthy daemon is answering, else null
 * (stale files are removed).
 */
async function findRunningDaemon({ timeoutMs = 1500 } = {}) {
  const st = readDaemonState();
  if (!st || !st.port) return null;
  if (st.pid && !isPidAlive(st.pid)) {
    clearDaemonState(st.instanceId);
    return null;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${st.port}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    if (body && body.app === 'claude-anywhere' && (!st.instanceId || body.instanceId === st.instanceId)) return st;
    return null;
  } catch {
    return null;
  }
}

module.exports = { readDaemonState, writeDaemonState, clearDaemonState, isPidAlive, findRunningDaemon };
