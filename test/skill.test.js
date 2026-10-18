'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'anywhere');
const RUN_JS = path.join(SKILL_DIR, 'run.js');
const runMod = require('../skills/anywhere/run.js');

function tmpDir(prefix = 'anywhere-skill-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

/** Tiny YAML-frontmatter reader for flat `key: value` pairs. */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'SKILL.md starts with frontmatter');
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return { fields: out, body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------- SKILL.md

test('SKILL.md frontmatter has the required fields', () => {
  const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const { fields } = frontmatter(text);
  assert.equal(fields.name, 'anywhere');
  assert.ok(fields.description.startsWith('Open Claude Anywhere: a floating, voice-enabled command dialog'));
  assert.match(fields.description, /Use when the user runs \/anywhere/);
  assert.ok(fields.description.length <= 1024, 'description fits the skill limit');
  assert.equal(fields['argument-hint'], '[here | stop | status | doctor | setup | <task to run>]');
  // Only the skill's own launcher is pre-approved (not any `node …` command), plus read-only screen tools.
  const allowed = fields['allowed-tools'].split(/,\s*/);
  assert.equal(allowed[0], 'Bash(node "${CLAUDE_SKILL_DIR}/run.js"*)');
  assert.ok(!allowed.includes('Bash(node *)'));
  for (const server of ['mcp__anywhere__', 'mcp__plugin_anywhere_anywhere__']) {
    for (const tool of ['screenshot', 'list_windows', 'cursor_position', 'screen_info', 'get_desktop_context']) assert.ok(allowed.includes(server + tool), server + tool);
    for (const tool of ['click', 'type_text', 'key', 'clipboard_get', 'open']) assert.ok(!allowed.includes(server + tool), `${server}${tool} is not pre-approved`);
  }
  assert.ok(allowed.includes('Read(~/.claude-anywhere/run/**)'), 'the skill may read the bridge images and CLI screenshots');
  assert.equal(allowed.length, 12);
  assert.equal(fields['disable-model-invocation'], 'true');
});

test('SKILL.md body covers every argument case through run.js', () => {
  const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const { body } = frontmatter(text);
  assert.ok(text.split('\n').length <= 200, 'SKILL.md stays short');
  assert.ok(body.includes('$ARGUMENTS'));
  assert.ok(body.includes('node "${CLAUDE_SKILL_DIR}/run.js"'));
  // Every command line goes through the launcher (no bare `anywhere` invocations in code blocks).
  const commands = body.match(/^\s*node .*$/gm) || [];
  assert.ok(commands.length >= 8);
  for (const c of commands) assert.match(c, /node "\$\{CLAUDE_SKILL_DIR\}\/run\.js" /);
  for (const needle of [
    'start --project "<cwd>"',
    'start --mode bridge --project "<cwd>"',
    'listen --timeout 540',
    '600000',
    'TIMEOUT',
    'STOP',
    'reply --final',
    "ask '",
    '--options',
    'computer screenshot',
    'Read tool',
    'mcp__anywhere__',
    'send --source skill --stdin',
    'run.js" stop',
    'run.js" status',
    'run.js" doctor',
    'run.js" install',
    'config set engine.claudePath',
    'Accessibility',
    'Screen Recording',
    'xdotool',
    'winget install OpenJS.NodeJS.LTS',
    'Never type passwords',
  ]) {
    assert.ok(body.includes(needle), `SKILL.md mentions ${needle}`);
  }
});

// ---------------------------------------------------------------- plugin files

test('plugin.json basics', () => {
  const p = readJson('.claude-plugin/plugin.json');
  const pkg = readJson('package.json');
  assert.equal(p.name, 'anywhere');
  assert.equal(p.version, '0.1.0');
  assert.equal(p.version, pkg.version);
  assert.equal(typeof p.description, 'string');
  assert.deepEqual(p.author, { name: 'Deepanshu Patel' });
  assert.equal(p.repository, 'https://github.com/patel-deepanshu/claude-anywhere');
  assert.match(p.homepage, /^https:\/\//);
  assert.equal(p.license, 'MIT');
  assert.ok(Array.isArray(p.keywords) && p.keywords.length > 0);
});

test('marketplace.json basics', () => {
  const m = readJson('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'anywhere-marketplace');
  assert.deepEqual(m.owner, { name: 'Deepanshu Patel' });
  assert.equal(m.plugins.length, 1);
  const p = m.plugins[0];
  assert.equal(p.name, 'anywhere');
  assert.equal(p.source, '.');
  assert.equal(p.version, '0.1.0');
  assert.equal(p.category, 'productivity');
  assert.equal(typeof p.description, 'string');
});

test('plugin.json starts the MCP server from the plugin root (no root .mcp.json)', () => {
  const p = readJson('.claude-plugin/plugin.json');
  assert.deepEqual(p.mcpServers, { anywhere: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/src/mcp/server.js'] } });
  // A root .mcp.json would also load as a broken project-scope server for anyone working in this repo.
  assert.equal(fs.existsSync(path.join(ROOT, '.mcp.json')), false);
});

test('plugin bin/ shims exist for POSIX shells and cmd.exe', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'bin', 'anywhere'), 'utf8');
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.match(sh, /exec "\$node_bin" "\$dir\/anywhere\.js" "\$@"/);
  const cmd = fs.readFileSync(path.join(ROOT, 'bin', 'anywhere.cmd'), 'utf8');
  assert.match(cmd, /^@echo off\r\n/);
  assert.match(cmd, /"%NODE_EXE%" "%ANYWHERE_JS%" %\*/);
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(ROOT, 'bin', 'anywhere')).mode & 0o111, 'bin/anywhere is executable');
    const r = spawnSync('sh', [path.join(ROOT, 'bin', 'anywhere'), 'version'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Claude Anywhere /);
  }
});

// ---------------------------------------------------------------- run.js resolution

function makePackage(base, { withBin = true } = {}) {
  const pkg = path.join(base, 'pkg');
  fs.mkdirSync(path.join(pkg, 'skills', 'anywhere'), { recursive: true });
  fs.copyFileSync(RUN_JS, path.join(pkg, 'skills', 'anywhere', 'run.js'));
  if (withBin) {
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'bin', 'anywhere.js'),
      "'use strict';\n" +
        "process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }) + '\\n');\n" +
        "if (process.argv[2] === 'wait') { process.on('SIGTERM', () => { process.stdout.write('got SIGTERM\\n'); process.exit(5); }); setInterval(() => {}, 1000); process.stdout.write('ready\\n'); }\n" +
        "else process.exit(Number(process.env.STUB_EXIT || 0));\n"
    );
  }
  return pkg;
}

test('run.js resolution 1: ../../bin/anywhere.js next to the skill', () => {
  const base = tmpDir();
  const pkg = makePackage(base);
  const r = runMod.resolveLauncher({ skillDir: path.join(pkg, 'skills', 'anywhere'), env: { PATH: '' }, homedir: base });
  assert.deepEqual(r, { kind: 'script', script: path.join(pkg, 'bin', 'anywhere.js'), root: pkg, via: 'relative' });
  // The real repository layout resolves the same way.
  const real = runMod.resolveLauncher({ env: { PATH: '' }, homedir: base });
  assert.equal(real.script, path.join(ROOT, 'bin', 'anywhere.js'));
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('run.js resolution 2: packageRoot from install.json', () => {
  const base = tmpDir();
  const pkg = makePackage(base);
  const skillDir = path.join(base, 'claude', 'skills', 'anywhere');
  fs.mkdirSync(skillDir, { recursive: true });
  const state = path.join(base, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'install.json'), JSON.stringify({ packageRoot: pkg, version: '0.1.0', installedAt: new Date().toISOString() }));
  const r = runMod.resolveLauncher({ skillDir, env: { ANYWHERE_HOME: state, PATH: '' }, homedir: base });
  assert.equal(r.via, 'install.json');
  assert.equal(r.script, path.join(pkg, 'bin', 'anywhere.js'));
  // Default state dir is ~/.claude-anywhere.
  fs.mkdirSync(path.join(base, '.claude-anywhere'));
  fs.copyFileSync(path.join(state, 'install.json'), path.join(base, '.claude-anywhere', 'install.json'));
  assert.equal(runMod.resolveLauncher({ skillDir, env: { PATH: '' }, homedir: base }).via, 'install.json');
  // A stale install.json (package moved) is ignored.
  fs.writeFileSync(path.join(state, 'install.json'), JSON.stringify({ packageRoot: path.join(base, 'gone') }));
  assert.equal(runMod.resolveLauncher({ skillDir, env: { ANYWHERE_HOME: state, PATH: '' }, homedir: path.join(base, 'nohome') }), null);
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('run.js resolution 3: `anywhere` on PATH', { skip: process.platform === 'win32' ? 'POSIX executable bits' : false }, () => {
  const base = tmpDir();
  const skillDir = path.join(base, 'claude', 'skills', 'anywhere');
  fs.mkdirSync(skillDir, { recursive: true });
  const env = (dir) => ({ PATH: dir, ANYWHERE_HOME: path.join(base, 'nostate') });

  // Our own shim (anywhere.js beside it, reached through a symlink) → run the script directly.
  const pkg = makePackage(base);
  fs.copyFileSync(path.join(ROOT, 'bin', 'anywhere'), path.join(pkg, 'bin', 'anywhere'));
  fs.chmodSync(path.join(pkg, 'bin', 'anywhere'), 0o755);
  const linkDir = path.join(base, 'links');
  fs.mkdirSync(linkDir);
  fs.symlinkSync(path.join(pkg, 'bin', 'anywhere'), path.join(linkDir, 'anywhere'));
  const viaShim = runMod.resolveLauncher({ skillDir, env: env(linkDir), homedir: base });
  assert.equal(viaShim.kind, 'script');
  assert.equal(viaShim.via, 'path');
  assert.equal(fs.realpathSync(viaShim.script), fs.realpathSync(path.join(pkg, 'bin', 'anywhere.js')));

  // Some other `anywhere` executable → run it as a command.
  const other = path.join(base, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'anywhere'), '#!/bin/sh\necho other\n', { mode: 0o755 });
  const cmd = runMod.resolveLauncher({ skillDir, env: env(other), homedir: base });
  assert.deepEqual(cmd, { kind: 'command', command: path.join(other, 'anywhere'), via: 'path' });

  // Non-executable files are ignored; nothing found → null.
  const noexec = path.join(base, 'noexec');
  fs.mkdirSync(noexec);
  fs.writeFileSync(path.join(noexec, 'anywhere'), 'x', { mode: 0o644 });
  assert.equal(runMod.resolveLauncher({ skillDir, env: env(noexec), homedir: base }), null);
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('run.js findOnPath honours PATHEXT on Windows-style lookups', () => {
  const base = tmpDir();
  fs.writeFileSync(path.join(base, 'anywhere.cmd'), '@echo off\r\n');
  const found = runMod.findOnPath('anywhere', { PATH: base, PATHEXT: '.EXE;.CMD' }, 'win32');
  assert.equal(found, path.join(base, 'anywhere.cmd'));
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('run.js spawnSpec: node for scripts, quoted shell for .cmd shims', () => {
  const s = runMod.spawnSpec({ kind: 'script', script: '/p/bin/anywhere.js' }, ['send', 'a b']);
  assert.deepEqual(s, { command: process.execPath, args: ['/p/bin/anywhere.js', 'send', 'a b'], shell: false });
  const w = runMod.spawnSpec({ kind: 'command', command: 'C:\\npm\\anywhere.cmd' }, ['send', 'deploy & "ship"'], 'win32');
  assert.equal(w.shell, true);
  assert.deepEqual(w.args, ['send', '"deploy & \\"ship\\""']);
  const p = runMod.spawnSpec({ kind: 'command', command: '/usr/local/bin/anywhere' }, ['status'], 'linux');
  assert.deepEqual(p, { command: '/usr/local/bin/anywhere', args: ['status'], shell: false });
  assert.match(runMod.notFoundMessage(), /install\.sh \| bash/);
  assert.match(runMod.notFoundMessage(), /install\.ps1 \| iex/);
});

test('run.js forwards argv, unicode and the exit code', async () => {
  const base = tmpDir();
  const pkg = makePackage(base);
  const run = path.join(pkg, 'skills', 'anywhere', 'run.js');
  const r = spawnSync(process.execPath, [run, 'send', 'déploy "this" ✓', '--json'], { encoding: 'utf8', env: { ...process.env, STUB_EXIT: '7' } });
  assert.equal(r.status, 7, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { args: ['send', 'déploy "this" ✓', '--json'] });
  const ok = spawnSync(process.execPath, [run, 'status'], { encoding: 'utf8', env: { ...process.env, STUB_EXIT: '0' } });
  assert.equal(ok.status, 0);
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('run.js prints install instructions when the package cannot be found', () => {
  const base = tmpDir();
  const lone = path.join(base, 'skills', 'anywhere');
  fs.mkdirSync(lone, { recursive: true });
  fs.copyFileSync(RUN_JS, path.join(lone, 'run.js'));
  const r = spawnSync(process.execPath, [path.join(lone, 'run.js'), 'status'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: path.dirname(process.execPath), ANYWHERE_HOME: path.join(base, 'nostate'), HOME: base, USERPROFILE: base },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not installed where this skill can find it/);
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('run.js forwards SIGTERM to the CLI', { skip: process.platform === 'win32' ? 'POSIX signals' : false }, async () => {
  const base = tmpDir();
  const pkg = makePackage(base);
  const child = spawn(process.execPath, [path.join(pkg, 'skills', 'anywhere', 'run.js'), 'wait'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stub never became ready: ${out}`)), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.on('close', (c) => resolve(c)));
  assert.equal(code, 5);
  assert.match(out, /got SIGTERM/);
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('run.js and bin/anywhere.js avoid syntax newer than Node 10 (so old Node gets upgrade advice)', () => {
  for (const f of [RUN_JS, path.join(ROOT, 'bin', 'anywhere.js')]) {
    const code = fs
      .readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\?\?/, `${path.basename(f)} uses ??`);
    assert.doesNotMatch(code, /\?\.[A-Za-z_$([]/, `${path.basename(f)} uses optional chaining`);
  }
  assert.equal(runMod.nodeMajor('v16.20.0'), 16);
  assert.equal(runMod.nodeMajor('22.1.0'), 22);
});
