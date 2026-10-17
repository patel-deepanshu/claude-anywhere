'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'anywhere.js');
const cli = require('../bin/anywhere.js');

function tmpDir(prefix = 'anywhere-cli-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Environment for a CLI child: isolated state dir, no inherited daemon target. */
function childEnv(extra = {}) {
  const env = { ...process.env, ANYWHERE_HOME: tmpDir(), NO_COLOR: '1' };
  delete env.ANYWHERE_DAEMON_URL;
  delete env.ANYWHERE_TOKEN;
  delete env.ANYWHERE_DRIVER;
  delete env.FORCE_COLOR;
  return { ...env, ...extra };
}

/** Run the CLI asynchronously (the fake daemon lives in this process). */
function runCli(args, { env, input, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: env || childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Minimal stand-in for the daemon's HTTP API. */
async function fakeDaemon(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        parsed = body;
      }
      const rec = { method: req.method, url: req.url, headers: req.headers, body: parsed };
      requests.push(rec);
      if (req.headers.authorization !== 'Bearer test-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const out = await handler(rec);
      const status = (out && out.__status) || 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out || {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    env: (extra = {}) => childEnv({ ANYWHERE_DAEMON_URL: url, ANYWHERE_TOKEN: 'test-token', ...extra }),
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------- argument parser

test('parseArgs: string flags, inline values, booleans and --no-x', () => {
  const spec = { string: ['project', 'mode'], boolean: ['open', 'json'], alias: { p: 'project' } };
  const p = cli.parseArgs(['--project', '/a b', '--mode=bridge', '--no-open', '--json', 'extra'], spec);
  assert.deepEqual(p.flags, { project: '/a b', mode: 'bridge', open: false, json: true });
  assert.deepEqual(p._, ['extra']);
  assert.deepEqual(p.unknown, []);
  assert.equal(cli.parseArgs(['-p', 'x'], spec).flags.project, 'x');
  assert.equal(cli.parseArgs(['--json=false'], spec).flags.json, false);
  assert.equal(cli.parseArgs(['--open=yes'], spec).flags.open, true);
});

test('parseArgs: short values -n 5 and -n5, multi and pair flags', () => {
  const spec = { string: ['lines'], multi: ['image'], pair: ['at'], boolean: ['follow'], alias: { n: 'lines', f: 'follow' } };
  assert.equal(cli.parseArgs(['-n', '5'], spec).flags.lines, '5');
  assert.equal(cli.parseArgs(['-n5'], spec).flags.lines, '5');
  assert.equal(cli.parseArgs(['-f'], spec).flags.follow, true);
  assert.deepEqual(cli.parseArgs(['--image', 'a.png', '--image=b.png'], spec).flags.image, ['a.png', 'b.png']);
  assert.deepEqual(cli.parseArgs(['--at', '10', '20', 'rest'], spec).flags.at, ['10', '20']);
  assert.deepEqual(cli.parseArgs(['--at', '10', '20', 'rest'], spec)._, ['rest']);
  assert.deepEqual(cli.parseArgs(['--at=3,4'], spec).flags.at, ['3', '4']);
  assert.deepEqual(cli.parseArgs(['--at', '3,4'], spec).flags.at, ['3', '4']);
});

test('parseArgs: "--" passthrough, negative numbers, lone dash, unknown flags', () => {
  const spec = { string: ['kind'], boolean: ['json'] };
  const p = cli.parseArgs(['open', 'app', '--kind', 'app', '--', '--new-window', '-x'], spec);
  assert.deepEqual(p._, ['open', 'app']);
  assert.deepEqual(p.rest, ['--new-window', '-x']);
  assert.deepEqual(cli.parseArgs(['move', '-10', '-20'], spec)._, ['move', '-10', '-20']);
  assert.deepEqual(cli.parseArgs(['-'], spec)._, ['-']);
  const u = cli.parseArgs(['--bogus', '-z', 'x'], spec);
  assert.deepEqual(u.unknown, ['--bogus', '-z']);
  assert.deepEqual(u._, ['x']);
});

test('parseArgs: missing values are usage errors', () => {
  const spec = { string: ['project'], boolean: ['open'], pair: ['at'] };
  assert.throws(() => cli.parseArgs(['--project'], spec), /needs a value/);
  assert.throws(() => cli.parseArgs(['--project', '--no-open'], spec), /needs a value/);
  assert.throws(() => cli.parseArgs(['--at', '1'], spec), /two values/);
  assert.throws(() => cli.parseArgs(['--open=maybe'], spec), /true or false/);
  // A value that merely starts with dashes but is not a known flag is accepted.
  assert.equal(cli.parseArgs(['--project', '--weird-dir'], spec).flags.project, '--weird-dir');
});

test('closestCommand and looksLikeTypo separate typos from tasks', () => {
  assert.equal(cli.closestCommand('stauts'), 'status');
  assert.equal(cli.closestCommand('lisen'), 'listen');
  assert.equal(cli.closestCommand('doc'), 'doctor');
  assert.equal(cli.closestCommand('deploy'), null);
  assert.equal(cli.looksLikeTypo(['stat']), 'start');
  assert.equal(cli.looksLikeTypo(['deploy']), null);
  assert.equal(cli.looksLikeTypo(['stat', 'something']), null);
  assert.equal(cli.looksLikeTypo(['Deploy this']), null);
  assert.equal(cli.levenshtein('abc', 'acb'), 1);
});

test('formatCommand renders the bridge protocol block', () => {
  const text = cli.formatCommand({
    id: 'c1',
    text: 'deploy this repo — ünïcödé',
    context: '<desktop_context>\nOS: test\n</desktop_context>',
    images: ['/tmp/a.png', '/tmp/b.png'],
    source: 'voice',
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '===ANYWHERE COMMAND c1===');
  assert.equal(lines[1], 'deploy this repo — ünïcödé');
  assert.match(text, /speech-recognition/);
  assert.match(text, /<desktop_context>\nOS: test\n<\/desktop_context>/);
  assert.equal(lines[lines.length - 1], '[images: /tmp/a.png, /tmp/b.png]');
  const plain = cli.formatCommand({ id: 'c2', text: 'hi', context: '', images: [], source: 'text' });
  assert.equal(plain, '===ANYWHERE COMMAND c2===\nhi');
});

test('hotkeyLabel, hostLabel and nodeAtLeast', () => {
  assert.equal(cli.hotkeyLabel('CommandOrControl+Shift+Space', 'darwin'), 'Cmd+Shift+Space');
  assert.equal(cli.hotkeyLabel('CommandOrControl+Shift+Space', 'linux'), 'Ctrl+Shift+Space');
  assert.equal(cli.hotkeyLabel('Super+Alt+A', 'win32'), 'Win+Alt+A');
  assert.equal(cli.hostLabel('app'), 'app window');
  assert.equal(cli.hostLabel(null), 'opening');
  assert.equal(cli.nodeAtLeast([18, 17, 0], '18.17.0'), true);
  assert.equal(cli.nodeAtLeast([18, 17, 0], '18.16.9'), false);
  assert.equal(cli.nodeAtLeast([18, 17, 0], 'v20.1.0'), true);
  assert.equal(cli.nodeAtLeast([18, 0, 0], '16.20.2'), false);
});

test('coerceForKey types values by the defaults and validates enums', () => {
  assert.equal(cli.coerceForKey('voice.speakResponses', 'false'), false);
  assert.equal(cli.coerceForKey('port', '47121'), 47121);
  assert.equal(cli.coerceForKey('voice.sttApiKey', '12345'), '12345');
  assert.deepEqual(cli.coerceForKey('engine.extraArgs', '["--verbose"]'), ['--verbose']);
  assert.deepEqual(cli.coerceForKey('permissions.alwaysAllow', 'Bash(git *),Read'), ['Bash(git *)', 'Read']);
  assert.equal(cli.coerceForKey('permissions.mode', 'auto'), 'auto');
  assert.throws(() => cli.coerceForKey('permissions.mode', 'yolo'), /must be one of/);
  assert.throws(() => cli.coerceForKey('voice.ttsRate', 'fast'), /must be a number/);
  assert.throws(() => cli.coerceForKey('ui.alwaysOnTop', 'maybe'), /true or false/);
  assert.throws(() => cli.coerceForKey('voice.speakResponse', 'true'), /Unknown setting.*voice\.speakResponses/);
  assert.throws(() => cli.coerceForKey('ui', 'x'), /is a section/);
});

test('every command has a summary, usage and runner', () => {
  for (const [name, c] of Object.entries(cli.COMMANDS)) {
    assert.ok(c.summary, `${name} summary`);
    assert.ok(c.usage && c.usage.startsWith('anywhere'), `${name} usage`);
    if (name !== 'help') assert.equal(typeof c.run, 'function', `${name} run`);
  }
  for (const name of ['start', 'stop', 'status', 'show', 'url', 'send', 'listen', 'reply', 'ask', 'notify', 'computer', 'doctor', 'install', 'uninstall', 'config', 'logs', 'tui', 'mcp', 'daemon', 'version', 'help']) {
    assert.ok(cli.COMMANDS[name], `missing command ${name}`);
  }
});

// ---------------------------------------------------------------- CLI processes

test('version and help', async () => {
  const v = await runCli(['version']);
  assert.equal(v.code, 0);
  assert.match(v.stdout, /^Claude Anywhere \d+\.\d+\.\d+ \(node /);
  const vj = await runCli(['version', '--json']);
  assert.equal(JSON.parse(vj.stdout).name, 'claude-anywhere');
  const vv = await runCli(['--version']);
  assert.equal(vv.code, 0);

  const h = await runCli(['help']);
  assert.equal(h.code, 0);
  for (const s of ['Usage', 'Examples', 'Exit codes', 'listen', 'computer screenshot', 'doctor', '4  Claude Anywhere is not running']) {
    assert.ok(h.stdout.includes(s), `help mentions ${s}`);
  }
  const none = await runCli([]);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /Usage/);
  const hl = await runCli(['help', 'listen']);
  assert.match(hl.stdout, /Usage: anywhere listen/);
  const hflag = await runCli(['listen', '--help']);
  assert.equal(hflag.code, 0);
  assert.match(hflag.stdout, /TIMEOUT/);
});

test('unknown commands and options exit 1 with help', async () => {
  const typo = await runCli(['stauts']);
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /Unknown command "stauts"\. Did you mean "status"\?/);
  assert.match(typo.stderr, /Usage/);
  const opt = await runCli(['--bogus']);
  assert.equal(opt.code, 1);
  const sub = await runCli(['start', '--bogus']);
  assert.equal(sub.code, 1);
  assert.match(sub.stderr, /Unknown option --bogus/);
  const op = await runCli(['computer', 'teleport']);
  assert.equal(op.code, 1);
  assert.match(op.stderr, /Unknown computer operation/);
});

test('commands that need the daemon exit 4 when it is not running', async () => {
  const env = childEnv();
  for (const args of [['listen', '--timeout', '1'], ['status'], ['reply', 'hi'], ['url'], ['ask', 'q?']]) {
    const r = await runCli(args, { env });
    assert.equal(r.code, 4, `${args.join(' ')} → ${r.code}\n${r.stderr}`);
  }
  const st = await runCli(['status', '--json'], { env });
  assert.deepEqual(JSON.parse(st.stdout), { running: false });
  const stop = await runCli(['stop'], { env });
  assert.equal(stop.code, 0);
  assert.match(stop.stdout, /not running/);
});

test('listen: exit 0 with the command, 2 on timeout, 3 on stop, 1 on auth failure', async (t) => {
  let mode = 'command';
  const d = await fakeDaemon((req) => {
    if (req.url !== '/api/bridge/listen') return { __status: 404, error: 'not found' };
    if (mode === 'command') {
      return { command: { id: 'abc', text: 'Deploy this repo ✓', context: '<desktop_context>\nctx\n</desktop_context>', images: ['/x/shot.png'], source: 'text' } };
    }
    if (mode === 'timeout') return { timeout: true };
    return { stop: true };
  });
  t.after(() => d.close());

  const ok = await runCli(['listen', '--timeout', '7'], { env: d.env() });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, '===ANYWHERE COMMAND abc===\nDeploy this repo ✓\n<desktop_context>\nctx\n</desktop_context>\n[images: /x/shot.png]\n');
  assert.deepEqual(d.requests[0].body, { timeoutSec: 7 });
  assert.equal(d.requests[0].method, 'POST');

  const js = await runCli(['listen', '--json'], { env: d.env() });
  assert.equal(js.code, 0);
  assert.equal(JSON.parse(js.stdout).command.id, 'abc');
  assert.deepEqual(d.requests[1].body, { timeoutSec: 540 });

  mode = 'timeout';
  const to = await runCli(['listen', '--timeout', '1'], { env: d.env() });
  assert.equal(to.code, 2);
  assert.equal(to.stdout.trim(), 'TIMEOUT');

  mode = 'stop';
  const st = await runCli(['listen'], { env: d.env() });
  assert.equal(st.code, 3);
  assert.equal(st.stdout.trim(), 'STOP');

  const bad = await runCli(['listen'], { env: d.env({ ANYWHERE_TOKEN: 'wrong' }) });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /rejected the access token/);

  const range = await runCli(['listen', '--timeout', '9999'], { env: d.env() });
  assert.equal(range.code, 1);
  assert.match(range.stderr, /--timeout must be a whole number from 1 to 590/);
});

test('listen exits 4 when the daemon URL refuses connections', async () => {
  const d = await fakeDaemon(() => ({}));
  const url = d.url;
  await d.close();
  const r = await runCli(['listen', '--timeout', '1'], { env: childEnv({ ANYWHERE_DAEMON_URL: url, ANYWHERE_TOKEN: 'test-token' }) });
  assert.equal(r.code, 4, r.stderr);
});

test('reply, ask, notify, send and the text shortcut talk to the daemon', async (t) => {
  let askMode = 'answer';
  const d = await fakeDaemon((req) => {
    switch (req.url) {
      case '/api/bridge/reply':
        return { ok: true };
      case '/api/mcp/ask':
        return askMode === 'answer' ? { answer: 'Yes' } : { timeout: true };
      case '/api/mcp/notify':
        return { ok: true, delivered: true };
      case '/api/command':
        return { ok: true, id: 'cmd-1' };
      case '/api/interrupt':
        return { ok: true };
      default:
        return { __status: 404, error: 'not found' };
    }
  });
  t.after(() => d.close());
  const env = d.env();
  const find = (u) => d.requests.filter((r) => r.url === u);

  const r1 = await runCli(['reply', '--final', 'All', 'done'], { env });
  assert.equal(r1.code, 0, r1.stderr);
  assert.deepEqual(find('/api/bridge/reply')[0].body, { text: 'All done', final: true, speak: true });
  const r2 = await runCli(['reply', '--no-speak', '--stdin'], { env, input: 'It\'s "quoted"\nline 2\n' });
  assert.equal(r2.code, 0, r2.stderr);
  assert.deepEqual(find('/api/bridge/reply')[1].body, { text: 'It\'s "quoted"\nline 2', final: false, speak: false });

  const a1 = await runCli(['ask', 'Deploy', 'now?', '--options', 'Yes, No', '--timeout', '30'], { env });
  assert.equal(a1.code, 0, a1.stderr);
  assert.equal(a1.stdout.trim(), 'Yes');
  assert.deepEqual(find('/api/mcp/ask')[0].body, { question: 'Deploy now?', timeoutSec: 30, options: ['Yes', 'No'] });
  askMode = 'timeout';
  const a2 = await runCli(['ask', 'Still there?'], { env });
  assert.equal(a2.code, 2);
  assert.equal(a2.stdout.trim(), 'TIMEOUT');
  assert.equal(find('/api/mcp/ask')[1].body.timeoutSec, 540);

  const n = await runCli(['notify', 'Build', 'passed', '--speak', '--level', 'success'], { env });
  assert.equal(n.code, 0, n.stderr);
  assert.deepEqual(find('/api/mcp/notify')[0].body, { message: 'Build passed', level: 'success', speak: true });

  const s = await runCli(['send', '--screenshot', '--', '-v', 'flag fails'], { env });
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /cmd-1/);
  assert.deepEqual(find('/api/command')[0].body, { text: '-v flag fails', source: 'cli', attachScreenshot: true });

  const shortcut = await runCli(['deploy this repo to Cloud Run'], { env });
  assert.equal(shortcut.code, 0, shortcut.stderr);
  assert.deepEqual(find('/api/command')[1].body, { text: 'deploy this repo to Cloud Run', source: 'cli' });

  const sj = await runCli(['send', '--json', '--source', 'skill', '--stdin'], { env, input: 'from the skill\n' });
  assert.equal(JSON.parse(sj.stdout).id, 'cmd-1');
  assert.deepEqual(find('/api/command')[2].body, { text: 'from the skill', source: 'skill' });

  const empty = await runCli(['send'], { env });
  assert.equal(empty.code, 1);

  const intr = await runCli(['interrupt'], { env });
  assert.equal(intr.code, 0);
  assert.equal(find('/api/interrupt').length, 1);
});

test('config set/get/reset in an isolated state dir', async () => {
  const env = childEnv();
  const p = await runCli(['config', 'path'], { env });
  assert.equal(p.stdout.trim(), path.join(env.ANYWHERE_HOME, 'config.json'));
  const s = await runCli(['config', 'set', 'voice.speakResponses', 'false'], { env });
  assert.equal(s.code, 0, s.stderr);
  const g = await runCli(['config', 'get', 'voice.speakResponses'], { env });
  assert.equal(g.stdout.trim(), 'false');
  const saved = JSON.parse(fs.readFileSync(path.join(env.ANYWHERE_HOME, 'config.json'), 'utf8'));
  assert.equal(saved.voice.speakResponses, false);
  const key = await runCli(['config', 'set', 'voice.sttApiKey', 'gsk_abcdefghijklmnopqrstuvwxyz'], { env });
  assert.equal(key.code, 0);
  assert.doesNotMatch(key.stdout, /abcdefghijklmnop/);
  const shown = await runCli(['config', 'get', 'voice.sttApiKey'], { env });
  assert.doesNotMatch(shown.stdout, /abcdefghijklmnop/);
  const bad = await runCli(['config', 'set', 'permissions.mode', 'yolo'], { env });
  assert.equal(bad.code, 1);
  const unknown = await runCli(['config', 'set', 'nope.key', '1'], { env });
  assert.equal(unknown.code, 1);
  const reset = await runCli(['config', 'reset'], { env });
  assert.equal(reset.code, 0);
  const g2 = await runCli(['config', 'get', 'voice.speakResponses'], { env });
  assert.equal(g2.stdout.trim(), 'true');
});

test('logs prints a friendly message when there is no log yet', async () => {
  const r = await runCli(['logs', '-n', '5']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No daemon log yet/);
});

const haveOs = fs.existsSync(path.join(ROOT, 'src', 'os', 'index.js')) && fs.existsSync(path.join(ROOT, 'src', 'os', 'computer.js'));

test('computer screenshot / click / windows with the mock driver', { skip: haveOs ? false : 'src/os (os-core) is not present yet' }, async () => {
  const env = childEnv({ ANYWHERE_DRIVER: 'mock' });
  const out = path.join(env.ANYWHERE_HOME, 'shots', 'screen ü.png');
  const r = await runCli(['computer', 'screenshot', '--out', out], { env });
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.path, out);
  for (const k of ['width', 'height', 'display', 'displays', 'scale']) assert.equal(typeof j[k], 'number', k);
  assert.ok('cursor' in j);
  const buf = fs.readFileSync(out);
  assert.equal(buf.slice(1, 4).toString('latin1'), 'PNG');
  assert.ok(j.width <= 1366 && j.height <= 768);

  const def = await runCli(['computer', 'screenshot'], { env });
  assert.equal(def.code, 0, def.stderr);
  const dj = JSON.parse(def.stdout);
  assert.equal(path.dirname(dj.path), path.join(env.ANYWHERE_HOME, 'run'));
  assert.ok(fs.existsSync(dj.path));
  assert.ok(fs.existsSync(path.join(env.ANYWHERE_HOME, 'run', 'last-shot.json')), 'geometry is persisted for later clicks');

  const click = await runCli(['computer', 'click', '100', '50', '--double'], { env });
  assert.equal(click.code, 0, click.stderr);
  const cj = JSON.parse(click.stdout);
  assert.equal(cj.ok, true);
  assert.equal(cj.clicks, 2);
  assert.equal(cj.x, 100);

  const w = await runCli(['computer', 'windows'], { env });
  assert.equal(w.code, 0, w.stderr);
  assert.ok(Array.isArray(JSON.parse(w.stdout).windows));

  const bad = await runCli(['computer', 'click', 'abc', '1'], { env });
  assert.equal(bad.code, 1);
  const none = await runCli(['computer', 'focus', 'no-such-window-xyz'], { env });
  assert.equal(none.code, 1);
  assert.equal(JSON.parse(none.stdout).ok, false);
});

test('computer reports UNSUPPORTED as JSON when desktop control is disabled', { skip: haveOs ? false : 'src/os (os-core) is not present yet' }, async () => {
  const r = await runCli(['computer', 'screenshot'], { env: childEnv({ ANYWHERE_DRIVER: 'none' }) });
  assert.equal(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.code, 'UNSUPPORTED');
});
