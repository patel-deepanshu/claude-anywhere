'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-engine-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const configMod = require('../src/shared/config');
const paths = require('../src/shared/paths');
const proc = require('../src/shared/proc');
const { uuid, sleep } = require('../src/shared/util');
const { Hub } = require('../src/daemon/hub');
const { QuestionBroker } = require('../src/daemon/questions');
const { Bridge } = require('../src/daemon/bridge');
const { SessionManager } = require('../src/daemon/session');
const {
  ClaudeCliEngine,
  buildArgs,
  buildEnv,
  launchSpec,
  resolveCmdShim,
  isUncPath,
  parseVersion,
  knownInstallPaths,
  LineSplitter,
} = require('../src/daemon/engine-cli');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
try {
  fs.chmodSync(FAKE, 0o755);
} catch {
  /* read-only checkout: the engine falls back to running it with node */
}

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function argsFile() {
  const f = path.join(HOME, `args-${uuid()}.jsonl`);
  process.env.FAKE_CLAUDE_ARGS_FILE = f;
  return {
    file: f,
    launches() {
      try {
        return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

function collect(engine) {
  const msgs = [];
  engine.on('message', (m) => msgs.push(m));
  const until = async (pred, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error('timed out waiting for engine message');
  };
  return { msgs, until };
}

function newEngine(extra = {}) {
  const cwd = fs.mkdtempSync(path.join(HOME, 'cwd-'));
  return new ClaudeCliEngine({ claudePath: FAKE, cwd, sessionId: uuid(), ...extra });
}

// ------------------------------------------------------------------ pure helpers

test('buildArgs follows the contract order (add-dir last)', () => {
  const args = buildArgs({
    sessionId: 'S',
    mcpConfigPath: '/run/mcp.json',
    systemPromptPath: '/run/prompt.md',
    allowedTools: ['mcp__anywhere__screenshot', 'mcp__anywhere__wait'],
    model: 'opus',
    fallbackModel: 'sonnet',
    effort: 'high',
    chrome: true,
    maxBudgetUsd: 2.5,
    extraArgs: ['--verbose-x', 'a\nb'],
    addDirs: ['/w1', '/w2', '/w1'],
  });
  assert.deepEqual(args, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--session-id', 'S',
    '--mcp-config', '/run/mcp.json',
    '--permission-prompt-tool', 'mcp__anywhere__permission_prompt',
    '--permission-mode', 'default',
    '--append-system-prompt-file', '/run/prompt.md',
    '--allowedTools', 'mcp__anywhere__screenshot,mcp__anywhere__wait',
    '--model', 'opus', '--fallback-model', 'sonnet', '--effort', 'high', '--chrome', '--max-budget-usd', '2.5',
    '--verbose-x', 'a b',
    '--add-dir', '/w1', '/w2',
  ]);
  const resume = buildArgs({ sessionId: 'R', resume: true });
  assert.deepEqual(resume.slice(7, 9), ['--resume', 'R']);
  assert.ok(!buildArgs({ sessionId: 'x', maxBudgetUsd: 0 }).includes('--max-budget-usd'));
  assert.ok(!buildArgs({ sessionId: 'x' }).includes('--allowedTools'));
  // The user's own defaultMode (acceptEdits, bypassPermissions) never applies to the engine…
  const pinned = buildArgs({ sessionId: 'x', settingsPath: '/run/settings.json' });
  assert.deepEqual(pinned.slice(9, 15), ['--permission-prompt-tool', 'mcp__anywhere__permission_prompt', '--permission-mode', 'default', '--settings', '/run/settings.json']);
  assert.deepEqual(buildArgs({ sessionId: 'x', permissionMode: 'plan' }).slice(11, 13), ['--permission-mode', 'plan']);
  // …unless engine.extraArgs sets these flags on purpose.
  const own = buildArgs({ sessionId: 'x', settingsPath: '/s.json', extraArgs: ['--permission-mode=acceptEdits', '--settings', '/mine.json'] });
  assert.equal(own.filter((a) => a.startsWith('--permission-mode')).length, 1);
  assert.equal(own.filter((a) => a === '--settings').length, 1);
  assert.ok(!own.includes('/s.json'));
});

test('buildEnv strips nested-session variables and adds MCP timeouts', () => {
  const env = buildEnv(
    { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', claude_pid: '5', KEEP: 'y' },
    { stripEnv: ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID'], extra: { ANYWHERE_X: 1, KEEP: null } }
  );
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.claude_pid, undefined, 'case-insensitive (Windows env)');
  assert.equal(env.KEEP, undefined);
  // WINDOWS-6: the node running the daemon is put on PATH (POSIX) so `#!/usr/bin/env node` shims resolve.
  const nodeDir = path.dirname(process.execPath);
  assert.equal(env.PATH, process.platform === 'win32' || nodeDir === '/bin' ? '/bin' : `${nodeDir}:/bin`);
  assert.equal(buildEnv({ PATH: `/bin:${nodeDir}/` }, { platform: 'linux' }).PATH, `/bin:${nodeDir}/`, 'not added twice');
  assert.equal(buildEnv({ PATH: '/bin' }, { platform: 'linux', nodeDir: '/opt/node/bin' }).PATH, '/opt/node/bin:/bin');
  assert.equal(buildEnv({ PATH: 'C:\\bin' }, { platform: 'win32', nodeDir: 'C:\\node' }).PATH, 'C:\\bin', 'Windows PATH untouched');
  assert.equal(env.MCP_TOOL_TIMEOUT, '3600000');
  assert.equal(env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, '0');
  assert.equal(env.ANYWHERE_X, '1');
  const raised = buildEnv({ MCP_TOOL_TIMEOUT: '60000', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '7' });
  assert.equal(raised.MCP_TOOL_TIMEOUT, '3600000');
  assert.equal(raised.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, '0');
  const longer = buildEnv({ MCP_TOOL_TIMEOUT: '7200000' });
  assert.equal(longer.MCP_TOOL_TIMEOUT, '7200000');
});

test('launchSpec quotes Windows .cmd shims and runs scripts with node', () => {
  const cmd = launchSpec('C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd', ['-p', '--add-dir', 'C:\\My Repo', 'a&b'], 'win32');
  assert.equal(cmd.shell, true);
  assert.equal(cmd.command, '"C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd"');
  assert.deepEqual(cmd.args, ['-p', '--add-dir', '"C:\\My Repo"', '"a&b"']);
  const exe = launchSpec('C:\\Program Files\\claude\\claude.exe', ['-p'], 'win32');
  assert.deepEqual(exe, { command: 'C:\\Program Files\\claude\\claude.exe', args: ['-p'], shell: false });
  const js = launchSpec('C:\\x\\cli.js', ['-p'], 'win32');
  assert.deepEqual(js, { command: process.execPath, args: ['C:\\x\\cli.js', '-p'], shell: false });
  const posix = launchSpec('/usr/local/bin/claude', ['-p'], 'linux');
  assert.deepEqual(posix, { command: '/usr/local/bin/claude', args: ['-p'], shell: false });
});

// The shim npm writes for `npm install -g @anthropic-ai/claude-code` (cmd-shim).
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n');

function npmPrefix({ shim = NPM_SHIM, withCli = true, withNodeExe = true } = {}) {
  const dir = fs.mkdtempSync(path.join(HOME, 'npm-'));
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (withCli) {
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '// cli\n');
  }
  if (withNodeExe) fs.writeFileSync(path.join(dir, 'node.exe'), '');
  const cmd = path.join(dir, 'claude.cmd');
  fs.writeFileSync(cmd, shim);
  return { dir, cmd, cli };
}

test('npm claude.cmd shims run their cli.js with node, without cmd.exe', () => {
  const { cmd, cli } = npmPrefix();
  assert.equal(resolveCmdShim(cmd), cli, 'the target, not the node.exe the shim also names');
  assert.deepEqual(launchSpec(cmd, ['-p', 'a&b'], 'win32'), { command: process.execPath, args: [cli, '-p', 'a&b'], shell: false });
  // Older shims: "%~dp0\node_modules\…\cli.js" %*
  const old = npmPrefix({ shim: '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n', withNodeExe: false });
  assert.equal(resolveCmdShim(old.cmd), old.cli);
  // A shim for a native binary.
  const exeDir = fs.mkdtempSync(path.join(HOME, 'npm-exe-'));
  fs.mkdirSync(path.join(exeDir, 'bin'));
  fs.writeFileSync(path.join(exeDir, 'bin', 'claude.exe'), '');
  fs.writeFileSync(path.join(exeDir, 'claude.cmd'), '@"%~dp0\\bin\\claude.exe" %*\r\n');
  const exe = launchSpec(path.join(exeDir, 'claude.cmd'), ['-p'], 'win32');
  assert.deepEqual(exe, { command: path.join(exeDir, 'bin', 'claude.exe'), args: ['-p'], shell: false });
  // A shim that names nothing usable falls back to the npm layout next to it…
  const odd = npmPrefix({ shim: '@echo off\r\nnode "%APPDATA%\\elsewhere.js" %*\r\n' });
  assert.equal(resolveCmdShim(odd.cmd), odd.cli);
  // …and only then to cmd.exe.
  const bare = npmPrefix({ shim: '@echo off\r\nclaude-real %*\r\n', withCli: false });
  assert.equal(resolveCmdShim(bare.cmd), null);
  const viaShell = launchSpec(bare.cmd, ['-p'], 'win32');
  assert.equal(viaShell.shell, true);
  assert.equal(resolveCmdShim(path.join(HOME, 'missing.cmd')), null);
});

test('a cmd.exe launch refuses a UNC project folder instead of running in C:\\Windows', async () => {
  assert.equal(isUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'), true);
  assert.equal(isUncPath('\\\\server\\share\\repo'), true);
  assert.equal(isUncPath('//server/share'), true);
  assert.equal(isUncPath('C:\\repo'), false);
  assert.equal(isUncPath('/home/me/repo'), false);
  const bare = npmPrefix({ shim: '@echo off\r\nclaude-real %*\r\n', withCli: false });
  const engine = new ClaudeCliEngine({ claudePath: bare.cmd, cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', sessionId: uuid(), platform: 'win32' });
  const exit = new Promise((r) => engine.once('exit', r));
  engine.start();
  const info = await exit;
  assert.equal(info.errorCode, 'UNC_CWD');
  assert.match(info.error, /cannot use the network or WSL folder/);
  assert.equal(engine.running, false);
});

test('parseVersion and known install paths', () => {
  assert.equal(parseVersion('2.1.302 (Claude Code)\n'), '2.1.302');
  assert.equal(parseVersion('0.0.0-fake (Claude Code)'), '0.0.0-fake');
  assert.equal(parseVersion(''), null);
  const posix = knownInstallPaths({}, 'linux').map((p) => p.replace(os.homedir(), '~'));
  for (const p of ['~/.claude/local/claude', '~/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '~/.npm-global/bin/claude', '~/.bun/bin/claude']) {
    assert.ok(posix.includes(p.replace(/\//g, path.sep).replace(/^~/, '~')) || posix.includes(p), p);
  }
  const win = knownInstallPaths({ APPDATA: 'C:\\U\\AppData\\Roaming', USERPROFILE: 'C:\\U', LOCALAPPDATA: 'C:\\U\\AppData\\Local' }, 'win32');
  assert.ok(win.includes('C:\\U\\AppData\\Roaming\\npm\\claude.cmd'));
  assert.ok(win.includes('C:\\U\\.local\\bin\\claude.exe'));
  assert.ok(win.includes('C:\\U\\AppData\\Local\\Programs\\claude\\claude.exe'));
});

test('LineSplitter handles split UTF-8, CRLF and a trailing line', () => {
  const lines = [];
  const sp = new LineSplitter((l) => lines.push(l));
  const buf = Buffer.from('{"a":"héllo 👋"}\r\n{"b":1}\n{"c"', 'utf8');
  for (let i = 0; i < buf.length; i += 3) sp.push(buf.subarray(i, i + 3));
  sp.push(Buffer.from(':2}'));
  sp.end();
  assert.deepEqual(lines, ['{"a":"héllo 👋"}', '{"b":1}', '{"c":2}']);
});

test('locate() prefers a discovered claude that answers --version over a broken one earlier on PATH (WINDOWS-6)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shims');
    return;
  }
  const bin = fs.mkdtempSync(path.join(HOME, 'brokenbin-'));
  const broken = path.join(bin, 'claude');
  fs.writeFileSync(broken, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  const savedEnv = process.env.ANYWHERE_CLAUDE_PATH;
  try {
    process.env.PATH = `${bin}:${savedPath}`;
    delete process.env.ANYWHERE_CLAUDE_PATH;
    proc.clearWhichCache();
    const found = await ClaudeCliEngine.locate({ engine: {} });
    const others = [...knownInstallPaths(), path.join(path.dirname(process.execPath), 'claude')].filter((p) => fs.existsSync(p));
    if (others.length) {
      assert.notEqual(found.path, broken, 'a working install wins over the broken shim');
      assert.ok(found.version);
    } else {
      assert.deepEqual(found, { path: broken, version: null }, 'falls back to the first usable file');
    }
    // An explicitly configured path is used even when --version fails.
    const explicit = await ClaudeCliEngine.locate({ engine: { claudePath: broken } });
    assert.deepEqual(explicit, { path: broken, version: null });
  } finally {
    process.env.PATH = savedPath;
    if (savedEnv !== undefined) process.env.ANYWHERE_CLAUDE_PATH = savedEnv;
    proc.clearWhichCache();
  }
});

test('locate() finds claude next to the running node when PATH lacks it (WINDOWS-6)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shims');
    return;
  }
  const nodeDir = fs.mkdtempSync(path.join(HOME, 'nodebin-'));
  fs.symlinkSync(FAKE, path.join(nodeDir, 'claude'));
  const savedPath = process.env.PATH;
  const savedEnv = process.env.ANYWHERE_CLAUDE_PATH;
  try {
    // A launcher-started daemon: PATH has neither claude nor node (the shim's `env node` relies on buildEnv).
    process.env.PATH = fs.mkdtempSync(path.join(HOME, 'emptybin-'));
    delete process.env.ANYWHERE_CLAUDE_PATH;
    proc.clearWhichCache();
    const found = await ClaudeCliEngine.locate({ engine: {} }, { nodeDir });
    assert.deepEqual(found, { path: path.join(nodeDir, 'claude'), version: '0.0.0-fake' });
  } finally {
    process.env.PATH = savedPath;
    if (savedEnv !== undefined) process.env.ANYWHERE_CLAUDE_PATH = savedEnv;
    proc.clearWhichCache();
  }
});

test('locate() honours engine.claudePath and reads the version', async () => {
  const found = await ClaudeCliEngine.locate({ engine: { claudePath: FAKE } });
  assert.equal(found.path, FAKE);
  assert.equal(found.version, '0.0.0-fake');
});

test('locate() returns null when nothing is installed', async (t) => {
  const real = knownInstallPaths().filter((p) => fs.existsSync(p));
  if (real.length) {
    t.skip(`a claude CLI exists at ${real[0]}`);
    return;
  }
  const savedPath = process.env.PATH;
  const savedEnv = process.env.ANYWHERE_CLAUDE_PATH;
  try {
    process.env.PATH = fs.mkdtempSync(path.join(HOME, 'emptybin-'));
    delete process.env.ANYWHERE_CLAUDE_PATH;
    proc.clearWhichCache();
    const emptyNodeDir = fs.mkdtempSync(path.join(HOME, 'nodedir-'));
    assert.equal(await ClaudeCliEngine.locate({ engine: { claudePath: path.join(HOME, 'nope') } }, { nodeDir: emptyNodeDir }), null);
  } finally {
    process.env.PATH = savedPath;
    if (savedEnv !== undefined) process.env.ANYWHERE_CLAUDE_PATH = savedEnv;
    proc.clearWhichCache();
  }
});

// ------------------------------------------------------------------ engine against fake-claude

test('engine: init, streamed deltas, assistant and result; env stripped', async () => {
  const af = argsFile();
  process.env.CLAUDECODE = '1';
  const mcp = path.join(HOME, 'mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { anywhere: { type: 'stdio', command: process.execPath, args: ['x.js'] } } }));
  const sessionId = uuid();
  const engine = newEngine({ sessionId, mcpConfigPath: mcp, systemPromptPath: path.join(HOME, 'p.md'), allowedTools: ['mcp__anywhere__wait'], addDirs: ['/tmp/a dir'], model: 'm1' });
  delete process.env.CLAUDECODE;
  const c = collect(engine);
  let spawned = null;
  engine.on('spawn', (s) => (spawned = s));
  engine.start();
  assert.equal(engine.running, true);
  const init = await c.until((m) => m.type === 'system' && m.subtype === 'init');
  assert.ok(spawned && spawned.pid);
  assert.equal(init.session_id, sessionId);
  assert.equal(init.model, 'fake-model');
  assert.deepEqual(init.mcp_servers, [{ name: 'anywhere', status: 'connected' }]);
  engine.send([{ type: 'text', text: 'héllo 👋 世界' }]);
  const result = await c.until((m) => m.type === 'result');
  assert.equal(result.result, 'Echo: héllo 👋 世界');
  assert.equal(result.total_cost_usd, 0.001);
  assert.equal(result.is_error, false);
  const deltas = c.msgs.filter((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta').map((m) => m.event.delta.text);
  assert.ok(deltas.length >= 2);
  assert.equal(deltas.join(''), 'Echo: héllo 👋 世界');
  const launch = af.launches()[0];
  assert.deepEqual(launch.argv.slice(0, 9), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--session-id', sessionId]);
  assert.deepEqual(launch.argv.slice(-2), ['--add-dir', '/tmp/a dir']);
  assert.equal(launch.env.CLAUDECODE, undefined);
  assert.ok(launch.env.MCP_TOOL_TIMEOUT);
  assert.ok(launch.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS !== undefined);
  // second turn reports cumulative cost like the real CLI
  engine.send('again');
  await c.until((m) => m.type === 'result' && m.result === 'Echo: again');
  assert.equal(c.msgs.filter((m) => m.type === 'result').pop().total_cost_usd, 0.002);
  const exit = new Promise((r) => engine.once('exit', r));
  await engine.stop();
  const info = await exit;
  assert.equal(info.expected, true);
  assert.equal(engine.running, false);
  assert.throws(() => engine.send('late'), /not running/);
});

test('engine: non-JSON stdout lines are ignored', async () => {
  const engine = newEngine();
  const c = collect(engine);
  engine.start();
  engine.send('NOISE_TEST please');
  const r = await c.until((m) => m.type === 'result');
  assert.equal(r.result, 'Echo: NOISE_TEST please');
  await engine.stop();
});

test('engine: interrupt during SLOW_TEST yields a result and keeps the process alive', async () => {
  const engine = newEngine();
  const c = collect(engine);
  engine.start();
  engine.send('SLOW_TEST');
  await c.until((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta' && /tick 1/.test(m.event.delta.text));
  const t0 = Date.now();
  const res = await engine.interrupt();
  assert.deepEqual(res, { ok: true, killed: false });
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(c.msgs.some((m) => m.type === 'control_response' && m.response.subtype === 'success'));
  const result = c.msgs.find((m) => m.type === 'result');
  assert.equal(result.subtype, 'error_during_execution');
  assert.equal(result.is_error, false);
  assert.ok(c.msgs.some((m) => m.type === 'user' && JSON.stringify(m).includes('[Request interrupted by user]')));
  assert.equal(engine.running, true);
  engine.send('after');
  await c.until((m) => m.type === 'result' && m.result === 'Echo: after');
  await engine.stop();
  // interrupt on a stopped engine is a no-op
  assert.deepEqual(await engine.interrupt(), { ok: true, killed: false });
});

test('engine: interrupt kills a CLI that never ends its turn', async () => {
  const stuck = path.join(HOME, 'stuck-cli.js');
  fs.writeFileSync(stuck, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  const engine = new ClaudeCliEngine({ claudePath: stuck, cwd: HOME, sessionId: uuid() });
  const exit = new Promise((r) => engine.once('exit', r));
  engine.start();
  await sleep(200);
  engine.send('work forever');
  assert.equal(engine.turnActive, true);
  const res = await engine.interrupt({ timeoutMs: 300 });
  assert.equal(res.killed, true);
  const info = await exit;
  assert.equal(info.expected, true);
  assert.equal(engine.running, false);
});

test('engine: interrupting an idle CLI ends on its control_response, without a kill', async () => {
  const engine = newEngine();
  const c = collect(engine);
  engine.start();
  engine.send('hello');
  await c.until((m) => m.type === 'result');
  assert.equal(engine.turnActive, false);
  const t0 = Date.now();
  const res = await engine.interrupt({ timeoutMs: 3000 });
  assert.deepEqual(res, { ok: true, killed: false });
  assert.ok(Date.now() - t0 < 1500, 'did not wait for the timeout');
  assert.ok(c.msgs.some((m) => m.type === 'control_response' && m.response.response && Array.isArray(m.response.response.still_queued)));
  assert.equal(engine.running, true);
  engine.send('still alive?');
  await c.until((m) => m.type === 'result' && m.result === 'Echo: still alive?');
  await engine.stop();
});

test('engine: an idle CLI that never answers an interrupt is left alone', async () => {
  const mute = path.join(HOME, 'mute-cli.js');
  fs.writeFileSync(mute, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  const engine = new ClaudeCliEngine({ claudePath: mute, cwd: HOME, sessionId: uuid() });
  engine.start();
  await sleep(100);
  const res = await engine.interrupt({ timeoutMs: 200 });
  assert.deepEqual(res, { ok: true, killed: false });
  assert.equal(engine.running, true);
  await engine.stop();
});

test('engine: turn state follows send, init and result', async () => {
  const engine = newEngine();
  const c = collect(engine);
  engine.start();
  await c.until((m) => m.type === 'system' && m.subtype === 'init');
  assert.equal(engine.turnActive, false, 'the startup init is not a turn');
  engine.send('one');
  assert.equal(engine.turnActive, true);
  await c.until((m) => m.type === 'result');
  assert.equal(engine.turnActive, false);
  // A queued message that starts its own turn announces it with a new init.
  engine.onStdoutLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }));
  assert.equal(engine.turnActive, true);
  engine.onStdoutLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
  assert.equal(engine.turnActive, false);
  await engine.stop();
});

test('engine: crash reports code and stderr tail', async () => {
  const engine = newEngine();
  const exit = new Promise((r) => engine.once('exit', r));
  engine.start();
  engine.send('CRASH_TEST');
  const info = await exit;
  assert.equal(info.code, 1);
  assert.equal(info.expected, false);
  assert.equal(info.sawInit, true);
  assert.match(info.stderrTail, /simulated crash/);
});

test('engine: resume of a missing conversation fails fast without init', async () => {
  const engine = newEngine({ sessionId: 'missing-xyz', resume: true });
  const exit = new Promise((r) => engine.once('exit', r));
  engine.start();
  const info = await exit;
  assert.equal(info.code, 1);
  assert.equal(info.sawInit, false);
  assert.match(info.stderrTail, /No conversation found with session ID/);
  assert.ok(info.uptimeMs < 5000);
});

test('engine: a missing executable reports a spawn error', async () => {
  const engine = new ClaudeCliEngine({ claudePath: path.join(HOME, 'no-such-claude'), cwd: HOME, sessionId: uuid() });
  const exit = new Promise((r) => engine.once('exit', r));
  engine.start();
  const info = await exit;
  assert.ok(info.error);
  assert.equal(engine.running, false);
});

// ------------------------------------------------------------------ session + real engine

function makeSession(projectDir) {
  const config = configMod.load();
  config.engine.claudePath = FAKE;
  config.engine.addVsCodeWorkspaces = false;
  config.context.attachDesktopContext = false;
  const hub = new Hub();
  const events = [];
  hub.on('event', (type, data) => events.push({ type, data }));
  const s = new SessionManager({
    config,
    hub,
    questions: new QuestionBroker({ hub }),
    bridge: new Bridge({ hub }),
    port: 1,
    token: 't',
    projectDir: projectDir || fs.mkdtempSync(path.join(HOME, 'proj-')),
    mode: 'companion',
    context: {},
  });
  const waitFor = async (pred, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error(`timed out; last events: ${events.slice(-5).map((e) => e.type).join(', ')}`);
  };
  return { s, hub, events, waitFor };
}

test('session + fake CLI: basic turn with deltas and per-turn/total cost', async () => {
  const { s, hub, events, waitFor } = makeSession();
  try {
    await s.submit({ text: 'first' });
    const r1 = await waitFor((e) => e.type === 'result');
    assert.equal(r1.data.text, 'Echo: first');
    assert.equal(r1.data.costUsd, 0.001);
    await s.submit({ text: 'second' });
    const r2 = await waitFor((e) => e.type === 'result' && e.data.text === 'Echo: second');
    assert.equal(r2.data.costUsd, 0.001);
    assert.equal(r2.data.totalCostUsd, 0.002);
    assert.ok(events.some((e) => e.type === 'delta'));
    assert.equal(s.snapshot().session.turns, 2);
    assert.equal(s.snapshot().session.model, 'fake-model');
    assert.equal(s.status, 'idle');
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('session + fake CLI: interrupt during SLOW_TEST', async () => {
  const { s, hub, events, waitFor } = makeSession();
  try {
    await s.submit({ text: 'SLOW_TEST' });
    await waitFor((e) => e.type === 'delta' && /tick 1/.test(e.data.text));
    await s.interrupt();
    assert.equal(s.status, 'idle');
    assert.ok(events.some((e) => e.type === 'status' && e.data.status === 'stopping'));
    assert.ok(s.messages.some((m) => m.role === 'system' && m.text === 'Stopped.'));
    const partial = s.messages.find((m) => m.role === 'assistant');
    assert.match(partial.text, /tick 0/);
    assert.equal(partial.streaming, false);
    assert.equal(s.guard().allowed, false);
    await s.submit({ text: 'next' });
    const r = await waitFor((e) => e.type === 'result' && e.data.text === 'Echo: next');
    assert.ok(r);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('session + fake CLI: crash, then the next submit resumes the session', async () => {
  const af = argsFile();
  const { s, hub, waitFor } = makeSession();
  try {
    await s.submit({ text: 'hello' });
    await waitFor((e) => e.type === 'result');
    const sid = s.sessionId;
    await s.submit({ text: 'CRASH_TEST' });
    await waitFor((e) => e.type === 'status' && e.data.status === 'error');
    assert.ok(s.messages.some((m) => m.level === 'error' && /simulated crash/.test(m.text)));
    await s.submit({ text: 'are you back?' });
    const r = await waitFor((e) => e.type === 'result' && e.data.text === 'Echo: are you back?');
    assert.equal(r.data.sessionId, sid);
    const launches = af.launches();
    assert.equal(launches.length, 2);
    assert.ok(launches[0].argv.includes('--session-id'));
    const i = launches[1].argv.indexOf('--resume');
    assert.ok(i > 0);
    assert.equal(launches[1].argv[i + 1], sid);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('session + fake CLI: failed resume falls back to a fresh session', async () => {
  const af = argsFile();
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  fs.writeFileSync(paths.sessionsPath(), JSON.stringify({ [projectDir]: { sessionId: 'missing-abc', updatedAt: new Date().toISOString() } }));
  const { s, hub, waitFor } = makeSession(projectDir);
  try {
    await s.submit({ text: 'resume me' });
    const r = await waitFor((e) => e.type === 'result');
    assert.equal(r.data.text, 'Echo: resume me');
    const launches = af.launches();
    assert.equal(launches.length, 2);
    const a0 = launches[0].argv;
    assert.equal(a0[a0.indexOf('--resume') + 1], 'missing-abc');
    const a1 = launches[1].argv;
    assert.ok(!a1.includes('--resume'));
    const fresh = a1[a1.indexOf('--session-id') + 1];
    assert.match(fresh, /^[0-9a-f-]{36}$/);
    assert.equal(r.data.sessionId, fresh);
    assert.ok(s.messages.some((m) => /Could not resume/.test(m.text)));
    const saved = JSON.parse(fs.readFileSync(paths.sessionsPath(), 'utf8'));
    assert.equal(saved[projectDir].sessionId, fresh);
  } finally {
    await s.shutdown();
    hub.close();
  }
});

test('session + fake CLI: resumeLast picks the saved session on first spawn', async () => {
  const af = argsFile();
  const projectDir = fs.mkdtempSync(path.join(HOME, 'proj-'));
  const saved = uuid();
  fs.writeFileSync(paths.sessionsPath(), JSON.stringify({ [projectDir]: { sessionId: saved, updatedAt: new Date().toISOString() } }));
  const { s, hub, waitFor } = makeSession(projectDir);
  try {
    await s.submit({ text: 'continue' });
    await waitFor((e) => e.type === 'result');
    const a = af.launches()[0].argv;
    assert.equal(a[a.indexOf('--resume') + 1], saved);
  } finally {
    await s.shutdown();
    hub.close();
  }
});
