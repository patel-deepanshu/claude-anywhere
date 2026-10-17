#!/usr/bin/env node
'use strict';

/**
 * Repository syntax check (npm run lint):
 *   - `node --check` on every .js file under bin, src, scripts, test and skills;
 *     browser ES modules in src/ui are checked as modules (via a temporary .mjs copy),
 *   - `sh -n` on POSIX shell scripts (bin/anywhere, scripts/*.sh) when sh exists,
 *   - PowerShell parse check of *.ps1 when pwsh/powershell is available,
 *   - JSON.parse on every .json file (outside node_modules and .git),
 *   - SKILL.md files must start with YAML frontmatter that has name and description.
 *
 * Usage: node scripts/check-syntax.js [--root DIR] [--quiet]
 * Exits 1 when anything fails.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const JS_DIRS = ['bin', 'src', 'scripts', 'test', 'skills'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'tmp']);
const CONCURRENCY = Math.max(2, Math.min(8, (os.cpus() || []).length || 4));

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.anywhere-test-')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function runProc(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
    } catch (error) {
      resolve({ code: null, out: '', error });
      return;
    }
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, out: Buffer.concat(chunks).toString('utf8'), error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

function findExe(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function isUiModule(root, file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  return rel.startsWith('src/ui/') && file.endsWith('.js');
}

async function checkJs(root, file, tmpDir) {
  if (isUiModule(root, file)) {
    const copy = path.join(tmpDir, `${path.basename(file, '.js')}-${Math.random().toString(36).slice(2)}.mjs`);
    fs.copyFileSync(file, copy);
    const r = await runProc(process.execPath, ['--check', copy]);
    return r.code === 0 ? null : (r.out || String(r.error)).split(copy).join(file);
  }
  const r = await runProc(process.execPath, ['--check', file]);
  return r.code === 0 ? null : r.out || String(r.error);
}

function checkJson(file) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Validate SKILL.md frontmatter.
 * @param {string} text
 * @returns {string|null} error message or null
 */
function checkSkillText(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return 'missing YAML frontmatter (the file must start with --- … ---)';
  const fm = m[1];
  for (const key of ['name', 'description']) {
    if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(fm)) return `frontmatter has no "${key}"`;
  }
  return null;
}

function isShellScript(root, file) {
  if (file.endsWith('.sh')) return true;
  if (path.extname(file)) return false;
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 64);
    return /^#!.*\b(sh|bash|dash)\b/.test(head);
  } catch {
    return false;
  }
}

async function pool(items, worker) {
  const results = [];
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      results[idx] = await worker(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return results;
}

/**
 * Check a repository tree.
 * @param {{root?:string}} [opts]
 * @returns {Promise<{checked:number, failures:Array<{file:string, kind:string, error:string}>, skipped:string[]}>}
 */
async function checkAll({ root = path.resolve(__dirname, '..') } = {}) {
  const failures = [];
  const skipped = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-syntax-'));
  let checked = 0;
  try {
    const jsFiles = [];
    const shellFiles = [];
    const psFiles = [];
    for (const d of JS_DIRS) {
      for (const f of walk(path.join(root, d))) {
        if (/\.(c)?js$/.test(f)) jsFiles.push(f);
        else if (f.endsWith('.ps1')) psFiles.push(f);
        else if (isShellScript(root, f)) shellFiles.push(f);
      }
    }
    const jsResults = await pool(jsFiles, (f) => checkJs(root, f, tmpDir));
    jsResults.forEach((err, idx) => {
      checked += 1;
      if (err) failures.push({ file: jsFiles[idx], kind: 'js', error: err.trim() });
    });

    for (const f of walk(root)) {
      if (f.endsWith('.json')) {
        checked += 1;
        const err = checkJson(f);
        if (err) failures.push({ file: f, kind: 'json', error: err });
      } else if (path.basename(f) === 'SKILL.md') {
        checked += 1;
        const err = checkSkillText(fs.readFileSync(f, 'utf8'));
        if (err) failures.push({ file: f, kind: 'skill', error: err });
      }
    }

    const sh = process.platform === 'win32' ? null : findExe('sh');
    for (const f of shellFiles) {
      if (!sh) {
        skipped.push(f);
        continue;
      }
      checked += 1;
      const r = await runProc(sh, ['-n', f]);
      if (r.code !== 0) failures.push({ file: f, kind: 'sh', error: r.out.trim() || String(r.error) });
    }

    const ps = findExe('pwsh') || (process.platform === 'win32' ? findExe('powershell') : null);
    for (const f of psFiles) {
      if (!ps) {
        skipped.push(f);
        continue;
      }
      checked += 1;
      const script =
        `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}',[ref]$t,[ref]$e);` +
        'if($e -and $e.Count){$e|%{$_.ToString()};exit 1}';
      const r = await runProc(ps, ['-NoProfile', '-NonInteractive', '-Command', script]);
      if (r.code !== 0) failures.push({ file: f, kind: 'ps1', error: r.out.trim() || String(r.error) });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return { checked, failures, skipped };
}

async function main() {
  const argv = process.argv.slice(2);
  let root = path.resolve(__dirname, '..');
  const quiet = argv.includes('--quiet');
  const ri = argv.indexOf('--root');
  if (ri >= 0) {
    if (!argv[ri + 1]) {
      process.stderr.write('--root needs a directory\n');
      process.exit(2);
    }
    root = path.resolve(argv[ri + 1]);
  }
  const { checked, failures, skipped } = await checkAll({ root });
  for (const f of failures) {
    process.stderr.write(`✗ ${path.relative(root, f.file) || f.file} (${f.kind})\n${f.error.replace(/^/gm, '    ')}\n`);
  }
  if (!quiet) {
    if (skipped.length) process.stdout.write(`(skipped ${skipped.length} file(s): no sh/pwsh available)\n`);
    process.stdout.write(failures.length ? `${failures.length} of ${checked} checks failed.\n` : `✓ ${checked} files passed the syntax check.\n`);
  }
  process.exit(failures.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`check-syntax failed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

module.exports = { checkAll, checkSkillText, checkJson, isUiModule };
