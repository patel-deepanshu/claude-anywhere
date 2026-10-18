'use strict';

/**
 * Voice profile storage (docs/CALLS-DESIGN.md §2.7):
 *
 *   <state>/voice/clone/                  0700
 *     profiles/<id>/                      0700 (id is "default" in v1)
 *       manifest.json                     0600 {version:1, createdAt, ownerName, engine, consent:{text, codeHash,
 *                                              transcript, similarity, nameHeard, verified, verifiedAt, deviceLabel},
 *                                              reference:{file, seconds, sha256, text}, quality:{takes}, consistency, test}
 *       reference.wav / reference.txt     0600 the clip the clone engine conditions on
 *       consent.wav                       0600 the record of consent (deleted with the profile)
 *       phrases/<sha1(engine|text)>.wav   pre-rendered greeting and fillers
 *     sessions/<id>/                      takes in progress (deleted after the build, or after 24 h)
 *
 * A profile is usable only when verifyProfile() passes: the manifest says consent was verified and
 * the reference clip's sha256 matches it. Nothing here sends anything anywhere: there is no upload
 * code path. On Windows (no mode bits) lockDown() runs icacls once, best effort.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const paths = require('../../shared/paths');

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SESSION_ID_RE = /^[a-f0-9]{32}$/;
const DEFAULT_PROFILE = 'default';
const MANIFEST_VERSION = 1;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function profileError(message, code = 'PROFILE_INVALID') {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** The clone root (<state>/voice/clone, 0700) unless a test passes its own. */
function cloneRoot(root) {
  return root ? paths.ensureDir(path.resolve(root)) : paths.cloneDir();
}

function profilesRoot(root) {
  return paths.ensureDir(path.join(cloneRoot(root), 'profiles'));
}

function sessionsRoot(root) {
  return paths.ensureDir(path.join(cloneRoot(root), 'sessions'));
}

function checkId(id) {
  const v = id == null ? DEFAULT_PROFILE : String(id);
  if (!PROFILE_ID_RE.test(v)) throw profileError(`Bad profile id "${v}"`, 'BAD_REQUEST');
  return v;
}

/**
 * @param {string} [id] profile id ("default")
 * @param {{root?:string}} [opts]
 * @returns {string} <clone root>/profiles/<id> (not created)
 */
function profileDir(id = DEFAULT_PROFILE, { root } = {}) {
  return path.join(profilesRoot(root), checkId(id));
}

/** @returns {string} <clone root>/sessions/<sessionId> (not created) */
function sessionDir(sessionId, { root } = {}) {
  if (!SESSION_ID_RE.test(String(sessionId))) throw profileError('Bad session id', 'BAD_REQUEST');
  return path.join(sessionsRoot(root), String(sessionId));
}

/** Write a file with 0600 (atomic: temp file + rename). */
function writeFileSecure(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* windows */
  }
  fs.renameSync(tmp, file);
  return file;
}

/** mkdir -p with 0700 (and chmod, since mkdir's mode is masked). */
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* windows */
  }
  return dir;
}

/** sha256 of a file, hex. */
function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 16);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * @param {string} [id]
 * @param {{root?:string}} [opts]
 * @returns {object|null} the parsed manifest, or null when missing or unreadable
 */
function readManifest(id = DEFAULT_PROFILE, opts = {}) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(profileDir(id, opts), 'manifest.json'), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

/**
 * Write manifest.json (0600) into the profile directory (created 0700).
 * @param {string} id
 * @param {object} manifest
 * @param {{root?:string}} [opts]
 * @returns {string} the file
 */
function writeManifest(id, manifest, opts = {}) {
  const dir = ensurePrivateDir(profileDir(id, opts));
  return writeFileSecure(path.join(dir, 'manifest.json'), `${JSON.stringify({ version: MANIFEST_VERSION, ...manifest }, null, 2)}\n`);
}

/** Is `child` inside `parent` (after resolving symlinks)? */
function inside(parent, child) {
  let p;
  let c;
  try {
    p = fs.realpathSync(parent);
    c = fs.realpathSync(child);
  } catch {
    return false;
  }
  return c !== p && c.startsWith(p + path.sep);
}

/**
 * Is this profile usable for cloning? The directory must sit under profiles/, the manifest must
 * say consent was verified, and reference.wav must match the manifest's sha256.
 * @param {string} [id]
 * @param {{root?:string}} [opts]
 * @returns {{ok:boolean, exists:boolean, code?:string, reason?:string, manifest?:object, dir:string}}
 */
function verifyProfile(id = DEFAULT_PROFILE, opts = {}) {
  const dir = profileDir(id, opts);
  const bad = (code, reason, extra = {}) => ({ ok: false, exists: fs.existsSync(dir), code, reason, dir, ...extra });
  if (!fs.existsSync(dir)) return { ok: false, exists: false, code: 'NO_PROFILE', reason: 'No voice profile yet', dir };
  if (!inside(profilesRoot(opts.root), dir) || !fs.statSync(dir).isDirectory()) return bad('PROFILE_INVALID', 'The profile folder is not where it should be');
  const m = readManifest(id, opts);
  if (!m) return bad('PROFILE_INVALID', 'The profile has no readable manifest');
  if (m.version !== MANIFEST_VERSION) return bad('PROFILE_INVALID', `Unknown profile version ${m.version}`, { manifest: m });
  if (!m.consent || m.consent.verified !== true) return bad('PROFILE_INVALID', 'Consent was not verified for this profile', { manifest: m });
  const ref = m.reference || {};
  if (ref.file !== 'reference.wav' || typeof ref.sha256 !== 'string') return bad('PROFILE_INVALID', 'The profile has no reference clip', { manifest: m });
  const refFile = path.join(dir, 'reference.wav');
  if (!fs.existsSync(refFile) || !inside(dir, refFile)) return bad('PROFILE_INVALID', 'The reference clip is missing', { manifest: m });
  let sum;
  try {
    sum = sha256File(refFile);
  } catch (err) {
    return bad('PROFILE_INVALID', `The reference clip cannot be read: ${err.message}`, { manifest: m });
  }
  if (sum !== ref.sha256) return bad('PROFILE_INVALID', 'The reference clip was changed after enrollment', { manifest: m });
  return { ok: true, exists: true, manifest: m, dir };
}

/**
 * Make a directory tree private: 0700 directories and 0600 files on POSIX; on Windows, icacls
 * removes inherited access and grants only the current user (best effort, once).
 * @param {string} dir
 * @param {{platform?:string, runner?:Function, username?:string}} [opts]
 * @returns {Promise<boolean>} true when the lock-down ran without errors
 */
async function lockDown(dir, { platform = process.platform, runner, username } = {}) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (platform === 'win32') {
    const user = username || process.env.USERNAME || os.userInfo().username;
    if (!user) return false;
    const run = runner || require('../../daemon/piper').defaultRunner;
    try {
      const r = await run('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/T', '/Q'], { timeoutMs: 15000 });
      return Boolean(r && r.code === 0);
    } catch {
      return false;
    }
  }
  let ok = true;
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    try {
      fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
    } catch {
      ok = false;
    }
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  walk(dir);
  return ok;
}

/**
 * The phrase-cache key of a text in an engine's voice: sha1(engine|text), hex.
 * @param {string} engine
 * @param {string} text
 */
function phraseKey(engine, text) {
  return crypto.createHash('sha1').update(`${engine}|${text}`).digest('hex');
}

/** @returns {string} <profile>/phrases/<sha1(engine|text)>.wav (not created) */
function phrasePath(engine, text, { id = DEFAULT_PROFILE, root } = {}) {
  return path.join(profileDir(id, { root }), 'phrases', `${phraseKey(engine, text)}.wav`);
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a profile (with its consent record and phrase cache) and every session in progress.
 * @param {string} [id]
 * @param {{root?:string}} [opts]
 * @returns {{removed:string[]}} what existed and was removed
 */
function deleteProfile(id = DEFAULT_PROFILE, opts = {}) {
  const removed = [];
  const dir = profileDir(id, opts);
  if (fs.existsSync(dir) && rmrf(dir)) removed.push(dir);
  const sessions = path.join(cloneRoot(opts.root), 'sessions');
  if (fs.existsSync(sessions)) {
    const had = fs.readdirSync(sessions).length > 0;
    if (rmrf(sessions) && had) removed.push(sessions);
  }
  return { removed };
}

/**
 * Remove session folders older than maxAgeMs (by modification time), except those in `keep`.
 * @param {{root?:string, maxAgeMs?:number, now?:number, keep?:Set<string>}} [opts]
 * @returns {string[]} removed session ids
 */
function cleanupSessions({ root, maxAgeMs = SESSION_MAX_AGE_MS, now = Date.now(), keep = new Set() } = {}) {
  const base = path.join(cloneRoot(root), 'sessions');
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return out;
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    const p = path.join(base, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (now - st.mtimeMs >= maxAgeMs && rmrf(p)) out.push(name);
  }
  return out;
}

module.exports = {
  DEFAULT_PROFILE,
  MANIFEST_VERSION,
  PROFILE_ID_RE,
  SESSION_ID_RE,
  SESSION_MAX_AGE_MS,
  cloneRoot,
  profilesRoot,
  sessionsRoot,
  profileDir,
  sessionDir,
  ensurePrivateDir,
  writeFileSecure,
  sha256File,
  readManifest,
  writeManifest,
  verifyProfile,
  lockDown,
  phraseKey,
  phrasePath,
  deleteProfile,
  cleanupSessions,
};
