'use strict';

/**
 * Ticket-workflow tools for the `anywhere` MCP server (loaded by tools.js):
 *
 *   find_repos {query?, limit?}               git repositories on this computer, best match first
 *   switch_project {dir, task, create?, gitInit?}  continue the work in another folder, in a fresh
 *                                             session that starts with `task` (POST /api/mcp/switch-project)
 *
 * find_repos looks where people keep code: the folders open in editors (and their recent ones), the
 * configured workspace.roots, common folders (~/code, ~/projects, ~/src, ~/dev, ~/workspace, ~/work,
 * ~/repos, ~/git, ~/github, ~/Documents/GitHub, ~/Developer, ~/source/repos, ~/IdeaProjects,
 * ~/go/src; C:\dev and D:\dev on Windows; the Windows user folders from WSL), the current project
 * and the home folder's own children. A folder with a .git entry is a repository; the scan goes at
 * most 3 levels below a root, never into node_modules, vendor, virtualenvs or hidden folders, and
 * stops after 1.5 s. Branch, remote and recency come from the .git files themselves; only the
 * returned repositories get a `git log -1` for their last commit.
 *
 * Ranking: a fuzzy match of the query (a ticket key's project prefix, component and summary words,
 * a repo name, owner/repo#123) against each repository's folder name, remote and path; ties go to
 * folders open in an editor and the current project, then to the most recently used.
 */

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const desktop = require('../context/desktop');
const proc = require('../shared/proc');
const platformMod = require('../shared/platform');
const { createLogger } = require('../shared/log');

const log = createLogger('mcp-project');

const SCAN_BUDGET_MS = 1500;
const SCAN_DEPTH = 3;
const EDITOR_SCAN_DEPTH = 2;
const SCAN_CONCURRENCY = 12;
const MAX_REPOS_FOUND = 3000;
const DETECT_TIMEOUT_MS = 3000;
const DRIVER_TIMEOUT_MS = 2500;
const GIT_LOG_TIMEOUT_MS = 2000;
const MAX_GIT_FILE_BYTES = 256 * 1024;
const MAX_PARENT_WALK = 12;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const SWITCH_TIMEOUT_MS = 60000;

/** Never descended into: dependency trees, virtualenvs, caches. Hidden folders are skipped too. */
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'bower_components', 'jspm_packages', '__pycache__', 'site-packages', 'Pods', 'venv', 'virtualenv']);

/** Where people keep code, relative to the home folder. */
const HOME_ROOTS = [
  'code',
  'Code',
  'projects',
  'Projects',
  'src',
  'dev',
  'Dev',
  'workspace',
  'Workspace',
  'workspaces',
  'work',
  'Work',
  'repos',
  'Repos',
  'git',
  'github',
  'GitHub',
  'Documents/GitHub',
  'Documents/Projects',
  'Documents/code',
  'Developer',
  'source/repos',
  'IdeaProjects',
  'PycharmProjects',
  'WebstormProjects',
  'AndroidStudioProjects',
  'go/src',
];
const WINDOWS_ROOTS = ['C:\\dev', 'D:\\dev', 'C:\\src', 'C:\\code', 'C:\\repos', 'C:\\projects'];
const WSL_USER_ROOTS = ['source/repos', 'Documents/GitHub', 'code', 'projects', 'dev', 'repos', 'src'];
const WINDOWS_PROFILE_SKIP = new Set(['all users', 'default', 'default user', 'public', 'wdagutilityaccount', 'desktop.ini']);

/** Words that say nothing about which repository a ticket belongs to. */
const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can do does for from has have in into is it its of on or so that the this to up was ' +
    'were when where which while who will with without not no new add adds added fix fixes fixed update updates make ' +
    'use should must need needs want wants after before into over under via per also all any some more less only ' +
    'bug bugs issue issues ticket task story feature epic sub subtask jira linear github gitlab work start please ' +
    'repo repository project folder code my our your their its'
  ).split(/\s+/),
);

const SOURCE_RANK = { query: 0, editor: 1, current: 2, recent: 3, workspace: 4, scan: 5, home: 6 };

// ---------------------------------------------------------------- small helpers

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function caseInsensitive(plat) {
  return plat === 'win32' || plat === 'darwin';
}

function keyOf(p, plat) {
  const s = String(p).replace(/[\\/]+$/, '') || String(p);
  return caseInsensitive(plat) ? s.toLowerCase() : s;
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

async function readSmall(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_GIT_FILE_BYTES) return null;
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function clampLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(v)));
}

function expandHome(p, home) {
  return String(p).replace(/^~(?=$|[\\/])/, () => home);
}

/**
 * A workspace root as typed in Settings or `anywhere config set`: surrounding quotes and trailing
 * separators removed, and on WSL a Windows drive path (C:\\code) mapped to its /mnt/c mount, like
 * switch_project's dir. UNC paths (\\\\server\\share) and ~ are kept (~ is expanded later).
 * @param {string} raw
 * @param {{platform?:string, isWSL?:boolean}} [sys]
 * @returns {string} '' when nothing is left
 */
function cleanRoot(raw, { platform = process.platform, isWSL = false } = {}) {
  let s = String(raw == null ? '' : raw)
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim();
  if (platform !== 'win32' && isWSL) {
    const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(s);
    if (m) s = `/mnt/${m[1].toLowerCase()}/${String(m[2] || '').replace(/\\/g, '/')}`;
  }
  // Keep "/" and "C:\\" whole; drop other trailing separators (also after a UNC share).
  if (!/^(?:[\\/]|[A-Za-z]:[\\/])$/.test(s)) s = s.replace(/(?<=[^\\/])[\\/]+$/, '');
  return s;
}

// ---------------------------------------------------------------- git metadata (no git process)

/**
 * The remote of a repository from its config file: origin, else the first one; credentials removed.
 * @param {string|null} text .git/config
 * @returns {string|null}
 */
function parseRemote(text) {
  if (!text) return null;
  let current = null;
  const urls = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[\s*remote\s+"([^"]+)"\s*\]$/i.exec(line);
    if (sec) {
      current = sec[1];
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    const kv = /^url\s*=\s*(.+)$/i.exec(line);
    if (current && kv) urls.push({ name: current, url: kv[1].trim().replace(/^"(.*)"$/, '$1') });
  }
  const pick = urls.find((u) => u.name === 'origin') || urls[0];
  return pick ? desktop.stripCredentials(pick.url) : null;
}

/**
 * Branch, remote and last activity of a repository, read from its .git files.
 * @param {string} root the folder that holds .git
 * @returns {Promise<{branch:string|null, remote:string|null, recency:number}|null>}
 */
async function readRepo(root) {
  const dotGit = path.join(root, '.git');
  const st = await statOrNull(dotGit);
  if (!st) return null;
  let gitDir = dotGit;
  if (st.isFile()) {
    // A worktree or submodule: ".git" is a file "gitdir: <path>".
    const m = /^gitdir:\s*(.+)$/m.exec((await readSmall(dotGit)) || '');
    if (!m) return null;
    gitDir = path.resolve(root, m[1].trim());
  }
  let commonDir = gitDir;
  const common = await readSmall(path.join(gitDir, 'commondir'));
  if (common && common.trim()) commonDir = path.resolve(gitDir, common.trim());
  const head = ((await readSmall(path.join(gitDir, 'HEAD'))) || '').trim();
  let branch = null;
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) branch = ref[1].trim();
  else if (/^[0-9a-f]{7,64}$/i.test(head)) branch = `detached at ${head.slice(0, 7)}`;
  const remote = parseRemote(await readSmall(path.join(commonDir, 'config')));
  let recency = 0;
  const marks = [path.join(gitDir, 'index'), path.join(gitDir, 'logs', 'HEAD'), path.join(gitDir, 'HEAD'), path.join(commonDir, 'FETCH_HEAD')];
  const stats = await Promise.all(marks.map(statOrNull));
  for (const s of stats) if (s && s.mtimeMs > recency) recency = s.mtimeMs;
  return { branch, remote, recency };
}

/**
 * The repository a folder belongs to: itself or the nearest parent holding .git, below the home
 * folder (a dotfiles repository in ~ does not make every project folder part of it).
 * @param {string} dir
 * @param {{home?:string, platform?:string}} [o]
 * @returns {Promise<string|null>}
 */
async function repoRootOf(dir, { home, platform } = {}) {
  let cur = path.resolve(dir);
  const homeKey = home ? keyOf(path.resolve(home), platform) : null;
  const insideHome = Boolean(homeKey) && keyOf(cur, platform).startsWith(`${homeKey}${path.sep}`);
  for (let i = 0; i < MAX_PARENT_WALK; i += 1) {
    if (insideHome && keyOf(cur, platform) === homeKey) return null;
    if (await statOrNull(path.join(cur, '.git'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/**
 * The last commit of a repository (date and subject), from `git log -1`, hardened so the repo's own
 * config cannot run programs (fsmonitor, signature checks) or page.
 * @returns {Promise<{date:string, subject:string}|null>}
 */
async function lastCommit(root, gitPath) {
  if (!gitPath) return null;
  const args = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-C', root, 'log', '-1', '--no-show-signature', '--format=%cI%x1f%s'];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  const r = await proc.run(gitPath, args, { timeoutMs: GIT_LOG_TIMEOUT_MS, env });
  if (r.code !== 0 || !r.stdout) return null;
  const [date, subject] = String(r.stdout).trim().split('\x1f');
  if (!date || Number.isNaN(Date.parse(date))) return null;
  return { date, subject: (subject || '').slice(0, 200) };
}

// ---------------------------------------------------------------- roots

/**
 * The folders scanned for repositories, in priority order (existing ones only).
 * @param {{home:string, platform:string, isWSL:boolean, roots?:string[], commonRoots?:string[]|null}} o
 * @returns {Promise<{dir:string, depth:number, source:string, skipSelf?:boolean}[]>}
 */
async function scanRoots(o) {
  const wanted = [];
  const add = (dir, depth, source, extra = {}) => {
    if (dir) wanted.push({ dir: path.resolve(expandHome(dir, o.home)), depth, source, ...extra });
  };
  for (const r of Array.isArray(o.roots) ? o.roots : []) {
    const root = typeof r === 'string' ? cleanRoot(r, { platform: o.platform, isWSL: o.isWSL }) : '';
    if (root) add(root, SCAN_DEPTH, 'workspace');
  }
  const common = Array.isArray(o.commonRoots) ? o.commonRoots : HOME_ROOTS.map((r) => path.join(o.home, ...r.split('/')));
  for (const r of common) add(r, SCAN_DEPTH, 'scan');
  if (!Array.isArray(o.commonRoots)) {
    if (o.platform === 'win32') for (const r of WINDOWS_ROOTS) add(r, SCAN_DEPTH, 'scan');
    if (o.isWSL && o.platform !== 'win32') {
      // The Windows side of a WSL machine (slow 9p mounts: listed last, one readdir to find users).
      for (const d of ['c', 'd']) add(`/mnt/${d}/dev`, SCAN_DEPTH, 'scan');
      const users = await withTimeout(fsp.readdir('/mnt/c/Users', { withFileTypes: true }), 800, []);
      for (const u of users || []) {
        if (!u.isDirectory() || WINDOWS_PROFILE_SKIP.has(u.name.toLowerCase())) continue;
        for (const r of WSL_USER_ROOTS) add(path.posix.join('/mnt/c/Users', u.name, r), SCAN_DEPTH, 'scan');
      }
    }
  }
  // The home folder's own children (~/shop-api), one level only; home itself may be a dotfiles repo.
  add(o.home, 1, 'home', { skipSelf: true });
  const stats = await Promise.all(wanted.map((w) => withTimeout(statOrNull(w.dir), 1000, null)));
  const out = [];
  const seen = new Set();
  wanted.forEach((w, i) => {
    const k = keyOf(w.dir, o.platform);
    if (seen.has(k) || !stats[i] || !stats[i].isDirectory()) return;
    seen.add(k);
    out.push(w);
  });
  return out;
}

/**
 * Breadth-first search for folders holding .git below the roots, within a time budget.
 * @returns {Promise<{found:Map<string,{path:string, source:string}>, timedOut:boolean, visited:number}>}
 */
async function scanForRepos(roots, { deadline, platform, maxFound = MAX_REPOS_FOUND }) {
  const found = new Map();
  const visited = new Set();
  const queue = roots.map((r) => ({ dir: r.dir, depth: 0, maxDepth: r.depth, source: r.source, skipSelf: Boolean(r.skipSelf) }));
  let timedOut = false;
  const visit = async (item) => {
    const k = keyOf(item.dir, platform);
    if (visited.has(k)) return;
    visited.add(k);
    let entries;
    try {
      entries = await fsp.readdir(item.dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, vanished)
    }
    if (!item.skipSelf && entries.some((e) => e.name === '.git')) {
      if (!found.has(k)) found.set(k, { path: item.dir, source: item.source });
      return; // a repository's own folders are not separate projects
    }
    if (item.depth >= item.maxDepth) return;
    for (const e of entries) {
      const name = e.name;
      if (name.startsWith('.') || name.startsWith('$') || SKIP_DIRS.has(name)) continue;
      let dirLike = e.isDirectory();
      if (!dirLike && e.isSymbolicLink()) {
        const st = await statOrNull(path.join(item.dir, name));
        dirLike = Boolean(st && st.isDirectory());
      }
      if (dirLike) queue.push({ dir: path.join(item.dir, name), depth: item.depth + 1, maxDepth: item.maxDepth, source: item.source, skipSelf: false });
    }
  };
  await new Promise((resolve) => {
    let active = 0;
    let finished = false;
    const done = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };
    const pump = () => {
      if (finished) return;
      if (Date.now() >= deadline || found.size >= maxFound) {
        if (queue.length) timedOut = Date.now() >= deadline;
        queue.length = 0;
        if (!active) done();
        return;
      }
      while (active < SCAN_CONCURRENCY && queue.length) {
        const item = queue.shift();
        active += 1;
        visit(item)
          .catch(() => {})
          .finally(() => {
            active -= 1;
            pump();
          });
      }
      if (!active && !queue.length) done();
    };
    pump();
    // The budget also bounds one slow readdir (a network drive): stop waiting for it.
    const timer = setTimeout(() => {
      if (queue.length || active) timedOut = true;
      queue.length = 0;
      done();
    }, Math.max(0, deadline - Date.now()) + 50);
    if (timer.unref) timer.unref();
  });
  return { found, timedOut, visited: visited.size };
}

// ---------------------------------------------------------------- ranking

/**
 * What a query says about the repository: ticket key prefixes ("SHOP-123" → "shop"), words
 * (stop words, numbers and single letters dropped) and the query squeezed to letters and digits.
 * @param {string} query
 */
function queryTerms(query) {
  const q = String(query || '').slice(0, 1000);
  const keys = [];
  const words = [];
  const names = []; // repository names from owner/repo#123, squeezed like `flat`
  const push = (list, w) => {
    if (w && !list.includes(w)) list.push(w);
  };
  let rest = q.replace(/\b([\w.-]+)\/([\w.-]+)#\d+\b/g, (m, owner, repo) => {
    push(names, repo.toLowerCase().replace(/[^a-z0-9]/g, ''));
    return ' ';
  });
  rest = rest.replace(/\bAB#\d+\b/gi, ' ');
  rest = rest.replace(/\b([A-Za-z][A-Za-z0-9_]{0,49})-\d+\b/g, (m, prefix) => {
    push(keys, prefix.toLowerCase());
    return ' ';
  });
  for (const w of rest.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2 || /^\d+$/.test(w) || STOP_WORDS.has(w)) continue;
    push(words, w);
  }
  return { keys, words: words.slice(0, 24), names, flat: q.toLowerCase().replace(/[^a-z0-9]/g, '') };
}

function segmentsOf(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * How well a repository matches the query terms (0 = no match).
 * @param {{name:string, path:string, remote?:string|null}} repo
 * @param {ReturnType<typeof queryTerms>} t
 * @returns {number}
 */
function scoreRepo(repo, t) {
  const name = String(repo.name || '').toLowerCase();
  const segs = segmentsOf(name);
  const flat = name.replace(/[^a-z0-9]/g, '');
  const remote = desktop.shortRemote(repo.remote || '').toLowerCase();
  const remoteName = remote.split('/').pop() || '';
  const remoteFlat = remoteName.replace(/[^a-z0-9]/g, '');
  const remoteSegs = segmentsOf(remote);
  const parentWords = new Set(segmentsOf(path.dirname(String(repo.path || ''))));
  let score = 0;
  if (t.flat.length >= 3 && (flat === t.flat || remoteFlat === t.flat)) score += 20;
  for (const n of t.names || []) if (n && (flat === n || remoteFlat === n)) score += 20;
  const prefixMatch = (w) => w.length >= 4 && segs.some((s) => (s.length >= 4 && s.startsWith(w)) || (s.length >= 4 && w.startsWith(s)));
  for (const k of t.keys) {
    if (segs.includes(k) || flat === k) score += 10;
    else if (flat.startsWith(k) && k.length >= 2) score += 7;
    else if (k.length >= 3 && flat.includes(k)) score += 5;
    else if (remoteSegs.includes(k)) score += 4;
    else if (k.length >= 3 && remote.includes(k)) score += 3;
    else if (parentWords.has(k)) score += 2;
  }
  for (const w of t.words) {
    if (segs.includes(w) || flat === w) score += 4;
    else if (w.length >= 4 && flat.includes(w)) score += 3;
    else if (prefixMatch(w)) score += 2;
    else if (remoteSegs.includes(w)) score += 2;
    else if (parentWords.has(w)) score += 1;
  }
  return score;
}

/**
 * Order repositories: by query match, then open in an editor / the current project, then the most
 * recently used. Without a query: editor and current project first, then by recency.
 * @param {object[]} repos {name, path, remote, source, recency}
 * @param {string} [query]
 * @returns {object[]} the same objects (with .score when there was a query), sorted
 */
function rankRepos(repos, query) {
  const t = queryTerms(query);
  const hasQuery = Boolean(t.keys.length || t.words.length || t.names.length || t.flat.length >= 3);
  for (const r of repos) r.score = hasQuery ? scoreRepo(r, t) : 0;
  const near = (r) => (r.source === 'query' ? 0 : r.source === 'editor' || r.source === 'current' ? 1 : 2);
  return repos.sort((a, b) => b.score - a.score || near(a) - near(b) || (b.recency || 0) - (a.recency || 0) || (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- find

/**
 * Find git repositories the user is likely to mean.
 * @param {object} [o]
 * @param {string} [o.query] ticket key, summary, component or repo name
 * @param {number} [o.limit=12]
 * @param {string} [o.projectDir] the current project
 * @param {string[]} [o.roots] config.workspace.roots
 * @param {()=>Promise<object[]>} [o.detectProjects] editor folders [{dir, name, source:'vscode'|'recent'|'cwd'}]
 * @param {string} [o.home] @param {string} [o.platform] @param {boolean} [o.isWSL]
 * @param {string[]|null} [o.commonRoots] replaces the built-in folder list (tests)
 * @param {number} [o.budgetMs=1500] scan time budget
 * @param {boolean} [o.gitLog=true] read the returned repositories' last commit with git
 * @returns {Promise<{repos:object[], searched:string[], timedOut:boolean, total:number}>}
 */
async function findRepos(o = {}) {
  const info = o.platform && o.isWSL != null ? null : platformMod.info();
  const plat = o.platform || (info && info.platform) || process.platform;
  const isWSL = o.isWSL != null ? Boolean(o.isWSL) : Boolean(info && info.isWSL);
  const home = o.home || os.homedir();
  const limit = clampLimit(o.limit);
  const started = Date.now();
  const deadline = started + (Number.isFinite(o.budgetMs) ? o.budgetMs : SCAN_BUDGET_MS);
  const query = typeof o.query === 'string' ? o.query.trim() : '';

  const candidates = new Map(); // key → {path, root, source, editorApp?}
  const addCandidate = (p, source, extra = {}) => {
    const k = keyOf(p, plat);
    const prev = candidates.get(k);
    if (prev && (SOURCE_RANK[prev.source] ?? 9) <= (SOURCE_RANK[source] ?? 9)) return;
    candidates.set(k, { ...(prev || {}), path: p, source, ...extra });
  };

  // Editor folders (open windows and their history) and the current project, in parallel with the scan.
  const detect = typeof o.detectProjects === 'function' ? withTimeout(Promise.resolve().then(o.detectProjects), DETECT_TIMEOUT_MS, []) : Promise.resolve([]);
  const roots = await scanRoots({ home, platform: plat, isWSL, roots: o.roots, commonRoots: o.commonRoots });
  const [scan, projects] = await Promise.all([scanForRepos(roots, { deadline, platform: plat }), detect]);
  for (const f of scan.found.values()) addCandidate(f.path, f.source);

  const direct = [];
  if (query && path.isAbsolute(expandHome(query, home))) direct.push({ dir: path.resolve(expandHome(query, home)), source: 'query' });
  if (o.projectDir) direct.push({ dir: path.resolve(o.projectDir), source: 'current' });
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!p || typeof p.dir !== 'string' || !p.dir) continue;
    direct.push({ dir: path.resolve(p.dir), source: p.source === 'cwd' ? 'current' : p.source === 'vscode' ? 'editor' : 'recent', app: p.app });
  }
  const editorRoots = [];
  await Promise.all(
    direct.map(async (d) => {
      const st = await statOrNull(d.dir);
      if (!st || !st.isDirectory()) return;
      const root = await repoRootOf(d.dir, { home, platform: plat });
      if (root) {
        // A folder inside a repository (a monorepo package) stays the folder the user works in.
        addCandidate(d.dir, d.source, keyOf(root, plat) === keyOf(d.dir, plat) ? {} : { repoRoot: root });
      } else if (d.source !== 'recent') {
        addCandidate(d.dir, d.source, { git: false });
        if (d.source === 'editor' || d.source === 'query') editorRoots.push({ dir: d.dir, depth: EDITOR_SCAN_DEPTH, source: d.source, skipSelf: true });
      }
    }),
  );
  // An editor window on a folder of repositories (~/work): its repositories are candidates too.
  if (editorRoots.length) {
    const more = await scanForRepos(editorRoots, { deadline: Math.max(deadline, Date.now() + 300), platform: plat });
    for (const f of more.found.values()) addCandidate(f.path, f.source === 'query' ? 'query' : 'editor');
  }

  const repos = [];
  await Promise.all(
    [...candidates.values()].map(async (c) => {
      const meta = c.git === false ? null : await readRepo(c.repoRoot || c.path);
      const r = { name: path.basename(c.path) || c.path, path: c.path, remote: meta ? meta.remote : null, branch: meta ? meta.branch : null, source: c.source, recency: meta ? meta.recency : 0 };
      if (c.repoRoot) r.repoRoot = c.repoRoot;
      if (c.git === false) r.git = false;
      repos.push(r);
    }),
  );
  // The same repository reached through a symlink (~/code → ~/Projects) is listed once, under the
  // path of its best source.
  const reals = await Promise.all(repos.map((r) => fsp.realpath(r.path).catch(() => r.path)));
  const byReal = new Map();
  repos.forEach((r, i) => {
    const k = keyOf(reals[i], plat);
    const prev = byReal.get(k);
    if (!prev || (SOURCE_RANK[r.source] ?? 9) < (SOURCE_RANK[prev.source] ?? 9)) byReal.set(k, r);
  });
  const ranked = rankRepos([...byReal.values()], query).slice(0, limit);
  const gitPath = o.gitLog === false ? null : proc.which('git');
  await Promise.all(
    ranked.map(async (r) => {
      const lc = r.git === false ? null : await lastCommit(r.repoRoot || r.path, gitPath).catch(() => null);
      r.lastCommit = lc ? lc.date : r.recency ? new Date(r.recency).toISOString() : null;
      if (lc && lc.subject) r.lastCommitSubject = lc.subject;
      else if (!lc && r.recency) r.lastCommitApprox = true; // from the .git files' times (git unavailable)
    }),
  );
  const out = ranked.map((r) => {
    const item = { name: r.name, path: r.path, remote: r.remote, branch: r.branch, lastCommit: r.lastCommit, source: r.source };
    if (r.lastCommitSubject) item.lastCommitSubject = r.lastCommitSubject;
    if (r.lastCommitApprox) item.lastCommitApprox = true;
    if (r.repoRoot) item.repoRoot = r.repoRoot;
    if (r.git === false) item.git = false;
    if (query) item.score = r.score;
    return item;
  });
  log.debug(`find_repos: ${repos.length} candidates, ${scan.visited} folders in ${Date.now() - started} ms${scan.timedOut ? ' (budget hit)' : ''}`);
  return { repos: out, searched: roots.map((r) => r.dir), timedOut: scan.timedOut, total: byReal.size };
}

// ---------------------------------------------------------------- tools

/**
 * @param {object} ext the context tools.js passes to feature modules
 *   ext.deps.findRepos?: (opts) => result, ext.deps.loadConfig?: () => config, ext.deps.detectProjects?,
 *   ext.deps.projectDir? (tests)
 * @returns {object[]} tools
 */
function createTools(ext) {
  const { config, role, client, checkGuard, postActivity, ok, fail, daemonRequest, objectSchema, annotations } = ext;
  const deps = ext.deps || {};
  const find = typeof deps.findRepos === 'function' ? deps.findRepos : findRepos;

  function workspaceRoots() {
    let cfg = config;
    try {
      // `anywhere config set` and the Settings drawer write config.json while this server runs.
      cfg = typeof deps.loadConfig === 'function' ? deps.loadConfig() : require('../shared/config').load();
    } catch (err) {
      log.debug('config reload failed:', err && err.message);
    }
    const roots = cfg && cfg.workspace && Array.isArray(cfg.workspace.roots) ? cfg.workspace.roots : [];
    return roots.filter((r) => typeof r === 'string' && r.trim());
  }

  async function detectProjects() {
    if (typeof deps.detectProjects === 'function') return deps.detectProjects();
    let driver = null;
    if (typeof ext.getDriver === 'function') driver = await withTimeout(ext.getDriver(), DRIVER_TIMEOUT_MS, null);
    return desktop.detectProjects({ driver: driver || null });
  }

  function projectDir() {
    return deps.projectDir || process.env.ANYWHERE_PROJECT_DIR || process.cwd();
  }

  const tools = [];

  tools.push({
    name: 'find_repos',
    title: 'Find repositories',
    description: [
      'Find git repositories on this computer to work in: folders open in editors (and recent ones), the configured workspace roots, common code folders (~/code, ~/projects, ~/src, ~/dev, ~/workspace, ~/repos, ~/Documents/GitHub, ~/source/repos, ~/go/src, C:\\dev…) and the current project.',
      'query ranks them: pass the ticket key (its project prefix often names the repo), the component and a few words of the summary, a repository name, or an absolute path. Ranking is by match on folder name, remote and path, then by recent use.',
      'Returns JSON {repos:[{name, path, remote, branch, lastCommit, source: editor|current|recent|workspace|scan|home|query, repoRoot?, git?:false}], searched, timedOut?}. Offer the top matches to the user with ask_user (options "name — path", plus "Another folder (type the path)" and "Create a new folder"); never pick a repository for them when more than one could fit.',
    ].join('\n\n'),
    inputSchema: objectSchema({
      query: { type: 'string', maxLength: 1000, description: 'Ticket key, summary words, component or repository name to rank by (optional).' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Most repositories to return (default ${DEFAULT_LIMIT}).` },
    }),
    annotations: annotations('Find repositories', { readOnly: true, idempotent: true, openWorld: false }),
    handler: async (args = {}) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const res = await find({ query, limit: args.limit, roots: workspaceRoots(), projectDir: projectDir(), detectProjects });
      const body = { query: query || null, repos: res.repos, searched: res.searched };
      if (res.timedOut) body.timedOut = true;
      if (!res.repos.length) {
        body.hint = 'No git repositories found. Ask the user for the folder (ask_user with "Type the path" and "Create a new folder"), or suggest adding their code folder to Settings → Workspace roots.';
      }
      return ok(JSON.stringify(body, null, 2));
    },
  });

  tools.push({
    name: 'switch_project',
    title: 'Continue in another project',
    description: [
      'Hand the work over to another folder: when your current turn ends, the dialog switches its project to dir and starts a fresh Claude session there, whose first message is task. Call it as the last action of your turn, then end the turn with one short sentence; do not keep working here.',
      'The new session starts with no memory of this conversation, so task must carry everything it needs: the ticket key and link, summary, description and acceptance criteria, the agreed plan, the base branch and branch name, and the user\'s answers (e.g. "move it to In Progress and assign it to me": yes).',
      'dir is an absolute path (~ allowed). create: true makes the folder when it does not exist (gitInit: true also runs git init). If dir already is the current project, nothing switches: continue here. Not available in bridge mode.',
    ].join('\n\n'),
    inputSchema: objectSchema(
      {
        dir: { type: 'string', minLength: 1, maxLength: 4096, description: 'Absolute path of the repository or folder to work in.' },
        task: { type: 'string', minLength: 1, maxLength: 100000, description: 'The complete task for the new session (it remembers nothing else).' },
        create: { type: 'boolean', description: 'Create the folder (mkdir -p) when it does not exist. Default false.' },
        gitInit: { type: 'boolean', description: 'Run git init in the folder when it is not a git repository yet. Default false.' },
      },
      ['dir', 'task'],
    ),
    annotations: annotations('Continue in another project', { destructive: false, idempotent: false, openWorld: false }),
    handler: async (args = {}, extra = {}) => {
      const dirRaw = typeof args.dir === 'string' ? args.dir.trim() : '';
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!dirRaw) return fail('dir is required: the absolute path of the folder to work in (see find_repos).');
      if (!task) return fail('task is required: everything the new session needs (ticket, acceptance criteria, plan, the user\'s answers).');
      await checkGuard();
      const c = await client();
      if (!c) {
        return fail(`The Anywhere dialog is not running, so the work cannot move to ${dirRaw}. Tell the user to open that folder in Claude Code (or run /anywhere there) and give them the task.`);
      }
      const body = { dir: dirRaw, task, role: role === 'interactive' ? 'interactive' : 'engine' };
      if (args.create === true) body.create = true;
      if (args.gitInit === true) body.gitInit = true;
      let res;
      try {
        res = await daemonRequest(c, 'POST', '/api/mcp/switch-project', body, { timeoutMs: SWITCH_TIMEOUT_MS, signal: extra.signal });
      } catch (err) {
        if (err && err.code === 'ABORTED') throw err;
        const msg = String((err && err.message) || err).replace(/\s+/g, ' ').trim();
        postActivity({ tool: 'switch_project', summary: `Continue in ${dirRaw}`, ok: false, error: msg.slice(0, 300) });
        if (err && err.status === 404) {
          return fail('This Anywhere daemon is too old to switch projects. Ask the user to restart it (anywhere stop, then /anywhere), or to open the folder themselves.');
        }
        const hint = err && err.data && err.data.hint ? ` ${err.data.hint}` : '';
        return fail(`Could not switch to ${dirRaw}: ${msg}.${hint}`);
      }
      if (res && res.same) return ok(`${res.dir} already is the current project: continue the work here, in this session.`);
      const dir = (res && res.dir) || dirRaw;
      postActivity({ tool: 'switch_project', summary: `Continue in ${dir}`, ok: true });
      const did = [res && res.created ? 'created the folder' : '', res && res.initialized ? 'ran git init' : ''].filter(Boolean);
      const prefix = did.length ? `Done: ${did.join(' and ')}. ` : '';
      if (res && res.immediate) return ok(`${prefix}The Anywhere dialog switched to ${dir} and started a fresh session there with the task.`);
      const name = path.basename(dir) || dir;
      return ok(
        `${prefix}Scheduled: when this turn ends, the dialog switches to ${dir} and a fresh session starts there with your task as its first message.${res && res.replaced ? ' (This replaces the switch you scheduled earlier in this turn.)' : ''} Do no more work here: end your turn now with one short spoken sentence, e.g. "Switching to ${name} to start the work."`,
      );
    },
  });

  return tools;
}

module.exports = {
  createTools,
  findRepos,
  rankRepos,
  scoreRepo,
  queryTerms,
  parseRemote,
  readRepo,
  scanRoots,
  cleanRoot,
  scanForRepos,
  HOME_ROOTS,
  SCAN_BUDGET_MS,
};
