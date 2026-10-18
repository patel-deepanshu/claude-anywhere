'use strict';

/**
 * HTTP route for the ticket workflow's hand-off (registered by server.js):
 *
 *   POST /api/mcp/switch-project {dir, task, create?, gitInit?, role?}
 *        → {ok:true, scheduled:true, dir, replaced?, created?, initialized?}   switched when the turn ends
 *        → {ok:true, scheduled:true, dir, immediate:true}                       role 'interactive', idle dialog
 *        → {ok:true, scheduled:false, same:true, dir}                           dir already is the project
 *
 * The MCP tool switch_project calls it from inside a turn of the dialog's own session (role
 * 'engine'); SessionManager.handoff() carries the switch out once that turn's result arrives: the
 * project changes (forced: the hand-off is intended), a fresh conversation starts there, and task
 * is sent as its first command (source 'handoff'). The user's own Claude Code terminal (role
 * 'interactive', the plugin's tools) can hand work to an idle dialog, which switches at once.
 *
 * dir: an absolute path (~ allowed; on WSL a Windows path such as C:\code\x becomes /mnt/c/code/x).
 * create: make the folder (mkdir -p) when it does not exist; gitInit: run `git init` in a folder
 * that is not a repository yet. Errors: 400 bad input or a missing folder without create, 409 bridge
 * mode (BRIDGE_MODE), a busy dialog (BUSY) or a turn that already ended (NO_TURN), 422 git init failed.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const proc = require('../shared/proc');
const platformMod = require('../shared/platform');
const { createLogger, audit } = require('../shared/log');

const log = createLogger('routes-project');

const GIT_INIT_TIMEOUT_MS = 20000;
const MAX_DIR_CHARS = 4096;

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function firstLine(s) {
  return (
    String(s || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || ''
  );
}

/**
 * The absolute folder a request names: ~ expanded; on WSL a Windows drive path is mapped to
 * /mnt/<drive>/…; anything relative is refused (the engine's cwd is not the user's).
 * @param {string} raw
 * @param {{platform?:string, isWSL?:boolean, home?:string}} [sys]
 * @returns {string}
 */
function normalizeDir(raw, sys = {}) {
  const plat = sys.platform || process.platform;
  const isWSL = sys.isWSL != null ? Boolean(sys.isWSL) : plat === 'linux' && platformMod.info().isWSL;
  const home = sys.home || os.homedir();
  let s = String(raw == null ? '' : raw).trim();
  if (!s) throw httpError(400, 'dir must be the absolute path of a folder');
  if (s.length > MAX_DIR_CHARS || s.includes('\0')) throw httpError(400, 'dir is not a valid path');
  // A path pasted with quotes around it.
  s = s.replace(/^(["'])(.*)\1$/, '$2').trim();
  s = s.replace(/^~(?=$|[\\/])/, () => home);
  if (plat !== 'win32' && isWSL) {
    const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(s);
    if (m) s = `/mnt/${m[1].toLowerCase()}/${String(m[2] || '').replace(/\\/g, '/')}`;
  }
  const P = plat === 'win32' ? path.win32 : path.posix;
  if (!P.isAbsolute(s) || (plat === 'win32' && !/^([A-Za-z]:[\\/]|\\\\)/.test(s))) {
    throw httpError(400, `dir must be an absolute path (got "${String(raw).trim()}")`, {
      hint: 'Use a folder from find_repos, or ask the user for the full path.',
    });
  }
  return P.resolve(s);
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/**
 * `git init` in dir (no-op when it already holds a .git).
 * @returns {Promise<boolean>} true when a repository was created
 */
async function gitInit(dir) {
  if (fs.existsSync(path.join(dir, '.git'))) return false;
  const git = proc.which('git');
  if (!git) {
    throw httpError(422, 'git is not installed, so the folder could not be made a repository', {
      hint: 'Switch without gitInit, or install git (https://git-scm.com/downloads) first.',
    });
  }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  const r = await proc.run(git, ['init'], { cwd: dir, env, timeoutMs: GIT_INIT_TIMEOUT_MS });
  if (r.code !== 0) {
    const why = r.timedOut ? 'it timed out' : firstLine(r.stderr) || (r.error && r.error.message) || `exit code ${r.code}`;
    throw httpError(422, `git init failed in ${dir}: ${why}`);
  }
  return true;
}

/**
 * @param {Function} add server.js route registrar: add(method, path, handler, opts)
 * @param {object} server the DaemonServer (server.session is the SessionManager)
 */
function register(add, server) {
  add(
    'POST',
    '/api/mcp/switch-project',
    async ({ body }) => {
      const session = server.session || (server.deps && server.deps.session);
      if (!session || typeof session.handoff !== 'function') throw httpError(501, 'This daemon cannot switch projects');
      const task = typeof body.task === 'string' ? body.task.trim() : '';
      if (typeof body.dir !== 'string' || !body.dir.trim()) throw httpError(400, 'dir must be the absolute path of a folder');
      if (!task) throw httpError(400, 'task must be a non-empty string: everything the new session needs to continue');
      const from = body.role === 'interactive' ? 'interactive' : 'engine';
      const dir = normalizeDir(body.dir);
      // Refuse (bridge mode, busy, stale) before touching the disk.
      const check = session.handoffCheck({ dir, from });
      if (check.same) return { ok: true, scheduled: false, same: true, dir: check.dir };
      const st = await statOrNull(dir);
      let created = false;
      if (!st) {
        if (body.create !== true) {
          throw httpError(400, `No such folder: ${dir}`, { hint: 'Check the path with the user, or pass create: true to make a new folder there.' });
        }
        try {
          await fsp.mkdir(dir, { recursive: true });
        } catch (err) {
          throw httpError(400, `Could not create ${dir}: ${err.message}`);
        }
        created = true;
        log.info(`created ${dir} for a hand-off`);
      } else if (!st.isDirectory()) {
        throw httpError(400, `Not a folder: ${dir}`);
      }
      const initialized = body.gitInit === true ? await gitInit(dir) : false;
      if (created || initialized) audit({ type: 'handoff_folder', dir, created, initialized });
      const r = session.handoff({ dir, task, from });
      const out = { ok: true, ...r };
      if (created) out.created = true;
      if (initialized) out.initialized = true;
      return out;
    },
    { notWhileStopping: true },
  );
}

module.exports = { register, normalizeDir, gitInit };
