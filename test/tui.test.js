'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

const T = require('../src/tui/tui');

const plain = T.createTheme({ color: false, unicode: true });
const ascii = T.createTheme({ color: false, unicode: false });

// ---------------------------------------------------------------- colours and formatting

test('colorEnabled honours NO_COLOR, FORCE_COLOR, TTY and TERM=dumb', () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  assert.equal(T.colorEnabled(tty, {}), true);
  assert.equal(T.colorEnabled(pipe, {}), false);
  assert.equal(T.colorEnabled(tty, { NO_COLOR: '1' }), false);
  assert.equal(T.colorEnabled(tty, { NO_COLOR: '' }), true, 'empty NO_COLOR is ignored per no-color.org');
  assert.equal(T.colorEnabled(pipe, { FORCE_COLOR: '1' }), true);
  assert.equal(T.colorEnabled(tty, { FORCE_COLOR: '0' }), true);
  assert.equal(T.colorEnabled(tty, { TERM: 'dumb' }), false);
  assert.equal(T.colorEnabled(undefined, {}), false);
});

test('palette wraps only when enabled; unicode fallback for legacy consoles', () => {
  assert.equal(T.createPalette(false).red('x'), 'x');
  assert.equal(T.createPalette(true).red('x'), '\x1b[31mx\x1b[39m');
  assert.equal(T.stripAnsi(T.createPalette(true).bold(T.createPalette(true).cyan('hi'))), 'hi');
  assert.equal(T.unicodeSupported({ LANG: 'en_US.UTF-8' }, 'linux'), true);
  assert.equal(T.unicodeSupported({}, 'linux'), false, 'no locale: the C library runs in "C" (ASCII)');
  assert.equal(T.unicodeSupported({}, 'win32'), false);
  assert.equal(T.unicodeSupported({ WT_SESSION: 'x' }, 'win32'), true);
  assert.equal(T.unicodeSupported({ ANYWHERE_ASCII: '1' }, 'darwin'), false);
});

test('formatCost and formatDuration', () => {
  assert.equal(T.formatCost(0), '$0.00');
  assert.equal(T.formatCost(0.0123), '$0.0123');
  assert.equal(T.formatCost(1.5), '$1.50');
  assert.equal(T.formatCost('x'), '$0.00');
  assert.equal(T.formatDuration(850), '850 ms');
  assert.equal(T.formatDuration(12300), '12.3 s');
  assert.equal(T.formatDuration(125000), '2m 05s');
  assert.equal(T.formatDuration(-1), '');
});

// ---------------------------------------------------------------- render helpers

test('tool rows: running, ok, error', () => {
  const item = { displayName: 'Click', name: 'mcp__anywhere__click', summary: '(512,300)', status: 'running' };
  assert.equal(T.renderToolHead(item, plain), '⚙ Click (512,300) …');
  assert.equal(T.renderToolRow(item, plain), '⚙ Click (512,300) …');
  assert.equal(T.renderToolRow({ ...item, status: 'ok' }, plain), '⚙ Click (512,300) … ✓');
  assert.equal(T.renderToolRow({ ...item, status: 'error', output: 'boom\nstack' }, plain), '⚙ Click (512,300) … ✗ boom');
  assert.equal(T.renderToolRow({ name: 'Bash', status: 'ok' }, ascii), '* Bash ... ok');
  const long = T.renderToolHead({ displayName: 'Run command', summary: 'x'.repeat(300) }, plain);
  assert.ok(long.length < 130);
});

test('result, notify, system, user and assistant lines', () => {
  assert.equal(
    T.renderResult({ costUsd: 0.0123, totalCostUsd: 0.05, durationMs: 12300, numTurns: 3 }, plain),
    '✓ Done · $0.0123 (session $0.0500) · 12.3 s · 3 turns'
  );
  assert.equal(T.renderResult({ costUsd: 0.2, totalCostUsd: 0.2, numTurns: 1 }, plain), '✓ Done · $0.2000 · 1 turn');
  assert.equal(T.renderResult({}, plain), '✓ Done');
  assert.equal(T.renderResult({ isError: true, text: 'Budget exceeded\nmore', durationMs: 900 }, plain), '✗ Failed: Budget exceeded · 900 ms');
  assert.equal(T.renderResult({ isError: true, interrupted: true, durationMs: 900 }, plain), 'Stopped · 900 ms');
  assert.equal(T.renderNotify({ text: 'Deployed!', level: 'success' }, plain), '• Deployed!');
  assert.equal(T.renderSystem({ text: 'MCP missing', level: 'warning' }, plain), '⚠ MCP missing');
  assert.equal(T.renderSystem({ text: 'oops', level: 'error' }, plain), '✗ oops');
  assert.equal(T.renderUserMessage({ text: 'deploy it', source: 'voice', images: 2 }, plain), 'You (voice): deploy it [+2 images]');
  assert.equal(T.renderUserMessage({ text: 'hi', source: 'text' }, plain), 'You: hi');
  assert.equal(T.renderAssistantMessage({ text: 'Sure.' }, plain), 'Claude: Sure.');
  assert.equal(T.renderStatusLine('waiting_approval', 'Run command', plain), '· waiting approval — Run command');
});

test('approval and question cards', () => {
  const card = T.renderApproval({ id: 'a1', toolName: 'Bash', displayName: 'Run command', summary: 'gcloud run deploy api --source .', risk: 'high', reason: 'Deploys to production' }, plain);
  assert.equal(card, ['⚠ Approval needed · HIGH risk · Run command', '  gcloud run deploy api --source .', '  Why: Deploys to production', '  [y]es / [a]lways / [n]o'].join('\n'));
  const noHint = T.renderApproval({ toolName: 'Write', input: { file_path: '/x' } }, plain, { withHint: false });
  assert.match(noHint, /MEDIUM risk · Write/);
  assert.match(noHint, /"file_path":"\/x"/);
  assert.ok(!noHint.includes('[y]es'));
  const q = T.renderQuestion({ question: 'Which region?', options: ['us-central1', { label: 'europe-west1' }] }, plain);
  assert.equal(q, ['? Claude asks: Which region?', '  1) us-central1', '  2) europe-west1', '  Type a number or your own answer.'].join('\n'));
  assert.match(T.renderQuestion({ question: 'Name?' }, plain), /Type your answer\./);
});

test('header, status summary and help', () => {
  const snap = {
    version: '0.1.0',
    mode: 'bridge',
    status: 'idle',
    project: { dir: '/w/api', name: 'api', git: { branch: 'main', dirty: true } },
    session: { id: '1234567890ab', model: 'claude-opus', costUsd: 0.5, turns: 2 },
    voice: { serverStt: true, sttProvider: 'groq', serverTts: false },
    bridge: { listening: false },
    platform: { platform: 'linux', displayServer: 'x11', driver: 'linux-x11' },
    pending: { approvals: [{}], questions: [] },
  };
  const header = T.renderHeader(snap, plain);
  assert.match(header, /Claude Anywhere v0\.1\.0/);
  assert.match(header, /Project: api \(\/w\/api\) · Mode: bridge · Status: idle/);
  const sum = T.renderStatusSummary(snap, plain);
  assert.match(sum, /Project: {2}api \(\/w\/api\) \[main, uncommitted changes\]/);
  assert.match(sum, /Session: {2}12345678 · claude-opus · \$0\.5000 · 2 turns/);
  assert.match(sum, /speech-to-text: groq · text-to-speech: off/);
  assert.match(sum, /no terminal session listening/);
  assert.match(sum, /Pending: {2}1 approval, 0 questions/);
  const help = T.renderHelp(plain);
  for (const cmd of ['/stop', '/new', '/mode', '/project', '/screen', '/voice', '/status', '/help', '/quit']) assert.ok(help.includes(cmd), cmd);
});

// ---------------------------------------------------------------- parsing

test('parseApprovalAnswer: y / a / n, spoken variants and deny reasons', () => {
  const cases = [
    ['y', { decision: 'allow' }],
    ['Yes.', { decision: 'allow' }],
    ['  OK  ', { decision: 'allow' }],
    ['go ahead please', { decision: 'allow' }],
    ['allow', { decision: 'allow' }],
    ['a', { decision: 'allow_session' }],
    ['Always', { decision: 'allow_session' }],
    ['always allow!', { decision: 'allow_session' }],
    ['n', { decision: 'deny' }],
    ['No.', { decision: 'deny' }],
    ['deny', { decision: 'deny' }],
    ['n use europe-west1 instead', { decision: 'deny', message: 'use europe-west1 instead' }],
    ['no, deploy to staging first', { decision: 'deny', message: 'deploy to staging first' }],
    ['', null],
    ['maybe', null],
    ['yesterday', null],
    ['nothing', null],
  ];
  for (const [input, want] of cases) assert.deepEqual(T.parseApprovalAnswer(input), want, JSON.stringify(input));
});

test('parseQuestionAnswer: numbers pick options, other text is free-form', () => {
  const opts = ['us-central1', { label: 'europe-west1' }];
  assert.equal(T.parseQuestionAnswer('2', opts), 'europe-west1');
  assert.equal(T.parseQuestionAnswer(' 1 ', opts), 'us-central1');
  assert.equal(T.parseQuestionAnswer('3', opts), '3');
  assert.equal(T.parseQuestionAnswer('asia-east1', opts), 'asia-east1');
  assert.equal(T.parseQuestionAnswer('5', []), '5');
  assert.equal(T.parseQuestionAnswer('   ', opts), null);
});

test('parseSlash: commands, paths and the // escape', () => {
  assert.deepEqual(T.parseSlash('/stop'), { name: 'stop', arg: '' });
  assert.deepEqual(T.parseSlash('  /Mode  bridge '), { name: 'mode', arg: 'bridge' });
  assert.deepEqual(T.parseSlash('/project ~/code/my app'), { name: 'project', arg: '~/code/my app' });
  assert.equal(T.parseSlash('/usr/bin/node is missing'), null);
  assert.equal(T.parseSlash('//compact'), null);
  assert.equal(T.parseSlash('deploy it'), null);
});

// ---------------------------------------------------------------- audio helpers

test('pickRecorder: sox rec, arecord, ffmpeg per platform', () => {
  const which = (map) => (n) => map[n] || null;
  const linux = T.pickRecorder({ platform: 'linux', which: which({ rec: '/usr/bin/rec', arecord: '/usr/bin/arecord', ffmpeg: '/usr/bin/ffmpeg' }), env: {} });
  assert.equal(linux.cmd, '/usr/bin/rec');
  assert.deepEqual(linux.buildArgs('/t/a.wav'), ['-q', '-c', '1', '-r', '16000', '-b', '16', '/t/a.wav']);
  assert.equal(linux.stop, 'signal');

  const arec = T.pickRecorder({ platform: 'linux', which: which({ arecord: '/usr/bin/arecord', ffmpeg: '/usr/bin/ffmpeg' }), env: {} });
  assert.deepEqual(arec.buildArgs('/t/a.wav'), ['-q', '-t', 'wav', '-f', 'S16_LE', '-c1', '-r16000', '/t/a.wav']);

  const ffPulse = T.pickRecorder({ platform: 'linux', which: which({ ffmpeg: '/usr/bin/ffmpeg', pactl: '/usr/bin/pactl' }), env: {} });
  assert.equal(ffPulse.stop, 'q');
  assert.deepEqual(ffPulse.buildArgs('/t/a.wav'), ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', 'default', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-y', '/t/a.wav']);
  const ffAlsa = T.pickRecorder({ platform: 'linux', which: which({ ffmpeg: '/usr/bin/ffmpeg' }), env: {}, exists: () => false });
  assert.deepEqual(ffAlsa.buildArgs('/t/a.wav').slice(3, 7), ['-f', 'alsa', '-i', 'default']);

  const mac = T.pickRecorder({ platform: 'darwin', which: which({ ffmpeg: '/opt/homebrew/bin/ffmpeg' }), env: {} });
  assert.deepEqual(mac.buildArgs('/t/a.wav').slice(3, 7), ['-f', 'avfoundation', '-i', ':0']);

  const win = T.pickRecorder({ platform: 'win32', which: which({ ffmpeg: 'C:\\ffmpeg\\ffmpeg.exe', sox: 'C:\\sox\\sox.exe' }), env: {} });
  assert.equal(win.name, 'ffmpeg');
  assert.equal(win.needsDevice, true);
  assert.deepEqual(win.buildArgs('C:\\t\\a.wav', 'Microphone (Realtek Audio)').slice(3, 7), ['-f', 'dshow', '-i', 'audio=Microphone (Realtek Audio)']);
  const winSox = T.pickRecorder({ platform: 'win32', which: which({ sox: 'C:\\sox\\sox.exe' }), env: {} });
  assert.deepEqual(winSox.buildArgs('a.wav'), ['-q', '-d', '-c', '1', '-r', '16000', '-b', '16', 'a.wav']);

  assert.equal(T.pickRecorder({ platform: 'linux', which: () => null, env: {} }), null);
  assert.match(T.recorderInstallHint('darwin'), /brew install sox/);
  assert.match(T.recorderInstallHint('win32'), /winget install Gyan\.FFmpeg/);
  assert.match(T.recorderInstallHint('linux'), /apt install sox/);
});

test('parseDshowAudioDevices: old and new ffmpeg formats', () => {
  const oldFmt = [
    '[dshow @ 000001] DirectShow video devices (some may be both video and audio devices)',
    '[dshow @ 000001]  "Integrated Camera"',
    '[dshow @ 000001]     Alternative name "@device_pnp_\\\\?\\usb#vid"',
    '[dshow @ 000001] DirectShow audio devices',
    '[dshow @ 000001]  "Microphone Array (Realtek(R) Audio)"',
    '[dshow @ 000001]     Alternative name "@device_cm_{33D9A762}"',
    'dummy: Immediate exit requested',
  ].join('\r\n');
  assert.deepEqual(T.parseDshowAudioDevices(oldFmt), ['Microphone Array (Realtek(R) Audio)']);
  const newFmt = [
    '[in#0 @ 0000] "Integrated Webcam" (video)',
    '[in#0 @ 0000]   Alternative name "@device_pnp_x"',
    '[in#0 @ 0000] "Headset Microphone (Jabra)" (audio)',
    '[in#0 @ 0000] "OBS Virtual Camera" (none)',
  ].join('\n');
  assert.deepEqual(T.parseDshowAudioDevices(newFmt), ['Headset Microphone (Jabra)']);
  assert.deepEqual(T.parseDshowAudioDevices(''), []);
});

function wav(dataBytes, { riffSize, dataSize } = {}) {
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(riffSize != null ? riffSize : 36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize != null ? dataSize : dataBytes, 40);
  return buf;
}

test('fixWavHeader repairs sizes left by interrupted recorders', () => {
  const broken = T.fixWavHeader(wav(1000, { riffSize: 0xffffffff, dataSize: 0 }));
  assert.equal(broken.readUInt32LE(4), 36 + 1000);
  assert.equal(broken.readUInt32LE(40), 1000);
  const big = T.fixWavHeader(wav(1000, { riffSize: 0x7fffffff, dataSize: 0x7fffffff }));
  assert.equal(big.readUInt32LE(40), 1000);
  const good = wav(500);
  assert.deepEqual(T.fixWavHeader(Buffer.from(good)), good);
  const notWav = Buffer.from('hello world, this is not a wav file at all......');
  assert.deepEqual(T.fixWavHeader(Buffer.from(notWav)), notWav);
});

// ---------------------------------------------------------------- the TUI end to end

function fakeClient(responses = {}) {
  const calls = [];
  let onEvent = null;
  return {
    calls,
    emit: (type, data) => onEvent(type, data),
    subscribed: () => Boolean(onEvent),
    closed: false,
    subscribe(fn) {
      onEvent = fn;
      const self = this;
      return {
        close() {
          self.closed = true;
        },
      };
    },
    async request(method, p, body) {
      calls.push({ method, path: p, body });
      const r = responses[`${method} ${p}`];
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(body);
      return r || { ok: true };
    },
    async postBinary(p, buf, ct, opts) {
      calls.push({ method: 'POST', path: p, binary: buf, contentType: ct, opts });
      const r = responses[`BINARY ${p.split('?')[0]}`];
      if (r instanceof Error) throw r;
      return r || { text: '' };
    },
  };
}

function capture() {
  const out = new PassThrough();
  let text = '';
  out.on('data', (d) => {
    text += d.toString();
  });
  return { out, get text() { return text; } };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function startTui(opts = {}) {
  const client = opts.client || fakeClient(opts.responses);
  const input = new PassThrough();
  const cap = capture();
  const tui = new T.Tui({ client, input, output: cap.out, env: { NO_COLOR: '1', LANG: 'en_US.UTF-8' }, platform: 'linux', cwd: '/home/me/work', homedir: '/home/me', ...(opts.deps || {}) });
  const done = tui.run();
  await tick();
  return { tui, client, input, cap, done };
}

const SNAPSHOT = {
  version: '0.1.0',
  mode: 'companion',
  status: 'idle',
  project: { dir: '/w/api', name: 'api' },
  session: { id: 's1', model: 'm' },
  config: { voice: { language: 'en-US' } },
  messages: [
    { id: 'm1', role: 'user', text: 'earlier question', source: 'text' },
    { id: 'm2', role: 'assistant', text: 'earlier answer', streaming: false },
    { id: 'm3', role: 'tool', toolUseId: 't0', name: 'Bash', displayName: 'Run command', summary: 'ls', status: 'ok' },
  ],
  pending: { approvals: [], questions: [] },
};

test('TUI: snapshot, streaming reply, tool row, result, no ANSI with NO_COLOR', async () => {
  const { client, input, cap, done } = await startTui();
  client.emit('snapshot', SNAPSHOT);
  client.emit('status', { status: 'thinking' });
  client.emit('message', { id: 'a1', role: 'assistant', text: '', streaming: true });
  client.emit('delta', { id: 'a1', text: 'Deploying ' });
  client.emit('delta', { id: 'a1', text: 'now.' });
  client.emit('message', { id: 'a1', role: 'assistant', text: 'Deploying now. Done', streaming: false });
  client.emit('message', { id: 'x1', role: 'tool', toolUseId: 't1', name: 'mcp__anywhere__click', displayName: 'Click', summary: '(512,300)', status: 'running' });
  client.emit('tool_update', { toolUseId: 't1', status: 'ok' });
  client.emit('message', { id: 'x2', role: 'tool', toolUseId: 't2', displayName: 'Run command', summary: 'gcloud x', status: 'running' });
  client.emit('delta', { id: 'a2', text: 'Interleaved text' });
  client.emit('tool_update', { toolUseId: 't2', status: 'error', output: 'permission denied' });
  client.emit('notify', { text: 'Build finished', level: 'success' });
  client.emit('result', { costUsd: 0.01, totalCostUsd: 0.01, durationMs: 4200, numTurns: 2 });
  client.emit('status', { status: 'error', detail: 'engine crashed' });
  input.write('/quit\n');
  await done;
  const t = cap.text;
  assert.ok(!t.includes('\x1b['), 'no escape codes');
  assert.match(t, /Claude Anywhere v0\.1\.0/);
  assert.match(t, /You: earlier question\nClaude: earlier answer\n⚙ Run command ls … ✓\n/);
  assert.match(t, /Claude: Deploying now\. Done\n/);
  assert.match(t, /⚙ Click \(512,300\) … ✓\n/);
  assert.match(t, /⚙ Run command gcloud x …\nClaude: Interleaved text\n {2}✗ permission denied Run command\n/);
  assert.match(t, /• Build finished/);
  assert.match(t, /✓ Done · \$0\.0100 · 4\.2 s · 2 turns/);
  assert.match(t, /· error — engine crashed/);
  assert.equal(client.closed, true, 'SSE subscription closed on quit');
});

test('TUI: approvals and questions are answered from the prompt', async () => {
  const { client, input, cap, done } = await startTui();
  client.emit('snapshot', SNAPSHOT);
  client.emit('approval_request', { id: 'ap1', toolName: 'Bash', displayName: 'Run command', summary: 'gcloud run deploy', risk: 'high', reason: 'deploys', input: {} });
  client.emit('question', { id: 'q1', question: 'Which region?', options: ['us-central1', 'europe-west1'] });
  input.write('maybe\n');
  await tick();
  input.write('y\n');
  await tick();
  client.emit('approval_resolved', { id: 'ap1', decision: 'allow' });
  input.write('2\n');
  await tick();
  client.emit('question_resolved', { id: 'q1', answer: 'europe-west1' });
  client.emit('approval_request', { id: 'ap2', toolName: 'Bash', summary: 'rm -rf build', risk: 'critical' });
  input.write('n not that directory\n');
  await tick();
  client.emit('approval_request', { id: 'ap3', toolName: 'Edit', summary: 'x', risk: 'low' });
  client.emit('approval_resolved', { id: 'ap3', decision: 'allow_session' });
  input.write('/quit\n');
  await done;
  const posts = client.calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts, [
    { method: 'POST', path: '/api/approval', body: { id: 'ap1', decision: 'allow', via: 'typed' } },
    { method: 'POST', path: '/api/answer', body: { id: 'q1', text: 'europe-west1' } },
    { method: 'POST', path: '/api/approval', body: { id: 'ap2', decision: 'deny', message: 'not that directory', via: 'typed' } },
  ]);
  const t = cap.text;
  assert.match(t, /⚠ Approval needed · HIGH risk · Run command\n {2}gcloud run deploy\n {2}Why: deploys\n {2}\[y\]es \/ \[a\]lways \/ \[n\]o/);
  assert.match(t, /\(1 more waiting after this one\)/);
  assert.match(t, /Answer y \(allow once\)/);
  assert.match(t, /› Allowed once\n\? Claude asks: Which region\?\n {2}1\) us-central1\n {2}2\) europe-west1/);
  assert.match(t, /› europe-west1/);
  assert.match(t, /› Denied: not that directory/);
  assert.match(t, /\(approval answered: allow session\)/, 'resolution from another client is reported');
  assert.ok(!/approval answered: allow\)/.test(t), 'no duplicate note for our own answer');
});

test('TUI: the screenshot marker follows attachScreenshotByDefault and resets after each send (CROSS-MODULE-2)', async () => {
  const { client, input, cap, done } = await startTui({ responses: {} });
  client.emit('snapshot', { ...SNAPSHOT, config: { ...SNAPSHOT.config, context: { attachScreenshotByDefault: true } } });
  for (const line of ['first', '/screen', 'second', 'third']) {
    input.write(`${line}\n`);
    await tick(5);
  }
  input.write('/quit\n');
  await done;
  assert.deepEqual(
    client.calls.filter((c) => c.path === '/api/command').map((c) => [c.body.text, c.body.attachScreenshot]),
    [['first', true], ['second', false], ['third', true]],
  );
  assert.match(cap.text, /The next message will not include a screenshot\./);
});

test('TUI: commands, slash commands and the screenshot toggle', async () => {
  const responses = {
    'POST /api/mode': { ok: true, mode: 'bridge' },
    'POST /api/project': (body) => ({ ok: true, project: { dir: body.dir, name: path.basename(body.dir) } }),
    'POST /api/session/new': { ok: true, sessionId: 'abcdef123456' },
    'GET /api/state': { ...SNAPSHOT, status: 'idle' },
    'POST /api/show': { ok: true, host: 'app' },
  };
  const { client, input, cap, done } = await startTui({ responses });
  client.emit('snapshot', SNAPSHOT);
  for (const line of ['deploy this repo to Cloud Run', '/screen', 'what is on screen?', '//compact please', '/mode bridge', '/mode', '/project ~/code/web', '/project ../other', '/new', '/stop', '/status', '/show', '/frobnicate', '/help']) {
    input.write(`${line}\n`);
    await tick(5);
  }
  input.write('/quit\n');
  await done;
  const byPath = (p) => client.calls.filter((c) => c.path === p);
  // CROSS-MODULE-2: always an explicit boolean, so the daemon's default cannot override [+screen].
  assert.deepEqual(byPath('/api/command').map((c) => c.body), [
    { text: 'deploy this repo to Cloud Run', source: 'text', attachScreenshot: false },
    { text: 'what is on screen?', source: 'text', attachScreenshot: true },
    { text: '/compact please', source: 'text', attachScreenshot: false },
  ]);
  assert.deepEqual(byPath('/api/mode').map((c) => c.body), [{ mode: 'bridge' }]);
  assert.deepEqual(byPath('/api/project').map((c) => c.body.dir), [
    path.resolve('/home/me/work', path.join('/home/me', 'code/web')),
    path.resolve('/home/me/work', '../other'),
  ]);
  assert.equal(byPath('/api/session/new').length, 1);
  assert.equal(byPath('/api/interrupt').length, 1);
  assert.equal(byPath('/api/state').length, 1);
  assert.equal(byPath('/api/show').length, 1);
  const t = cap.text;
  assert.match(t, /The next message will include a screenshot\./);
  assert.match(t, /Mode: bridge/);
  assert.match(t, /Use \/mode companion or \/mode bridge/);
  assert.match(t, /Project: web \(/);
  assert.match(t, /Started a new session \(abcdef12\)\./);
  assert.match(t, /Status: +idle/);
  assert.match(t, /Dialog shown \(app\)\./);
  assert.match(t, /Unknown command \/frobnicate/);
  assert.match(t, /\/voice/);
});

test('TUI: send errors are reported; daemon echo of piped input is printed', async () => {
  const err = Object.assign(new Error('Claude Anywhere is busy'), { status: 409 });
  const { client, input, cap, done } = await startTui({ responses: { 'POST /api/command': err } });
  client.emit('snapshot', SNAPSHOT);
  input.write('hello\n');
  await tick();
  client.emit('message', { id: 'u9', role: 'user', text: 'from the GUI', source: 'voice' });
  client.emit('_disconnected', {});
  client.emit('_disconnected', {});
  client.emit('snapshot', { ...SNAPSHOT, messages: [...SNAPSHOT.messages, { id: 'm4', role: 'system', text: 'Engine restarted', level: 'info' }] });
  input.write('/quit\n');
  await done;
  const t = cap.text;
  assert.match(t, /✗ Could not send: Claude Anywhere is busy/);
  assert.match(t, /You \(voice\): from the GUI/);
  assert.equal((t.match(/Lost connection/g) || []).length, 1);
  assert.match(t, /✓ Reconnected\.\nℹ Engine restarted\n/);
  assert.equal((t.match(/earlier question/g) || []).length, 1, 'reconnect snapshots do not repeat the transcript');
});

test('TUI: piped input waits for the result before exiting', async () => {
  const { client, input, cap, done } = await startTui({ deps: { idleQuitMs: 200 } });
  client.emit('snapshot', SNAPSHOT);
  input.end('open the GCP console\n');
  await tick(30);
  let finished = false;
  done.then(() => {
    finished = true;
  });
  await tick(30);
  assert.equal(finished, false, 'still waiting for the result');
  client.emit('status', { status: 'thinking' });
  client.emit('result', { costUsd: 0.02, numTurns: 1 });
  // LIFECYCLE-10: the daemon going idle ends it, not the result count.
  client.emit('status', { status: 'idle' });
  await done;
  assert.match(cap.text, /✓ Done/);
});

test('TUI: piped lines run in order after connecting (/status before /quit)', async () => {
  const responses = { 'GET /api/state': { ...SNAPSHOT, status: 'idle' } };
  const { client, input, cap, done } = await startTui({ responses });
  input.end('/status\n/quit\n');
  await tick(20);
  assert.equal(client.calls.length, 0, 'nothing runs before the first snapshot');
  client.emit('snapshot', SNAPSHOT);
  await done;
  assert.deepEqual(client.calls.map((c) => c.path), ['/api/state']);
  assert.match(cap.text, /Claude Anywhere v0\.1\.0[\s\S]*Status: +idle/);
});

test('TUI: Ctrl+C interrupts when busy and a second Ctrl+C within 2 s quits', async () => {
  const { tui, client, cap, done } = await startTui();
  client.emit('snapshot', { ...SNAPSHOT, status: 'acting' });
  tui._onCtrlC();
  await tick();
  assert.deepEqual(client.calls.map((c) => c.path), ['/api/interrupt']);
  assert.match(cap.text, /Interrupting… \(press Ctrl\+C again within 2 s to quit\)/);
  tui._onCtrlC();
  await done;
  assert.equal(tui.closed, true);
});

test('TUI: Ctrl+C when idle only hints, and a slow second press does not quit', async () => {
  const { tui, client, cap, input, done } = await startTui();
  client.emit('snapshot', SNAPSHOT);
  tui._onCtrlC();
  assert.match(cap.text, /press Ctrl\+C again to quit/);
  tui.lastCtrlC -= 5000;
  tui._onCtrlC();
  assert.equal(tui.closed, false);
  assert.equal(client.calls.length, 0);
  input.write('/quit\n');
  await done;
});

test('TUI: /voice records, transcribes and sends the text as a voice command', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-tui-'));
  const spawned = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (sig) => {
      spawned.push(['kill', sig]);
      fs.writeFileSync(args[args.length - 1], wav(16000, { riffSize: 0, dataSize: 0 }));
      setImmediate(() => child.emit('exit', 0, null));
      return true;
    };
    spawned.push([cmd, args]);
    return child;
  };
  const responses = { 'BINARY /api/stt': { text: 'deploy to cloud run', provider: 'groq' } };
  const { client, input, cap, done } = await startTui({ responses, deps: { spawn, which: (n) => (n === 'rec' ? '/usr/bin/rec' : null), tmpdir: tmp } });
  client.emit('snapshot', SNAPSHOT);
  input.write('/voice\n');
  await tick();
  assert.match(cap.text, /● Recording with sox \(rec\)… press Enter to stop\./);
  input.write('\n');
  await tick(50);
  input.write('/quit\n');
  await done;
  assert.equal(spawned[0][0], '/usr/bin/rec');
  assert.deepEqual(spawned[1], ['kill', 'SIGINT']);
  const stt = client.calls.find((c) => c.path.startsWith('/api/stt'));
  assert.equal(stt.path, '/api/stt?language=en-US');
  assert.equal(stt.contentType, 'audio/wav');
  assert.equal(stt.binary.readUInt32LE(40), 16000, 'WAV header repaired before upload');
  const cmd = client.calls.find((c) => c.path === '/api/command');
  assert.deepEqual(cmd.body, { text: 'deploy to cloud run', source: 'voice', attachScreenshot: false });
  assert.match(cap.text, /You \(voice\): deploy to cloud run/);
  assert.deepEqual(fs.readdirSync(tmp), [], 'temporary audio removed');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TUI: a spoken answer resolves a pending approval; missing recorder gives an install hint', async () => {
  const responses = { 'BINARY /api/stt': { text: 'Yes, please.' } };
  const { tui, client, input, cap, done } = await startTui({ responses, deps: { which: () => null } });
  client.emit('snapshot', { ...SNAPSHOT, pending: { approvals: [{ id: 'ap9', toolName: 'Bash', summary: 'npm publish', risk: 'high', ts: '1' }], questions: [] } });
  await tui.transcribeAndSend(wav(8000));
  input.write('/voice\n');
  await tick();
  input.write('/quit\n');
  await done;
  assert.deepEqual(client.calls.find((c) => c.path === '/api/approval').body, { id: 'ap9', decision: 'allow', via: 'voice' });
  assert.match(cap.text, /No audio recorder found\. Install one with: sudo apt install sox/);
});

test('TUI: speech-to-text errors include a configuration hint', async () => {
  const err = Object.assign(new Error('No speech-to-text provider'), { status: 501 });
  const { tui, client, input, cap, done } = await startTui({ responses: { 'BINARY /api/stt': err } });
  client.emit('snapshot', SNAPSHOT);
  await tui.transcribeAndSend(wav(8000));
  input.write('/quit\n');
  await done;
  assert.match(cap.text, /Speech-to-text failed: No speech-to-text provider\. Server speech-to-text needs GROQ_API_KEY/);
});

test('TUI: TTY mode rewrites a finished tool row in place and shows a prompt', async () => {
  const client = fakeClient();
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const cap = capture();
  cap.out.isTTY = true;
  cap.out.columns = 100;
  const tui = new T.Tui({ client, input, output: cap.out, env: { NO_COLOR: '1', LANG: 'en_US.UTF-8' }, platform: 'linux' });
  const done = tui.run();
  await tick();
  client.emit('snapshot', SNAPSHOT);
  client.emit('message', { id: 'x1', role: 'tool', toolUseId: 't1', displayName: 'Screenshot', summary: '', status: 'running' });
  client.emit('tool_update', { toolUseId: 't1', status: 'ok' });
  tui.quit();
  await done;
  const t = cap.text;
  assert.match(t, /\x1b\[1A/, 'cursor moved up to rewrite the row');
  assert.match(t, /⚙ Screenshot … ✓\n/);
  assert.match(t, /› /, 'prompt drawn');
});

test('runTui without a daemon throws NOT_RUNNING', async () => {
  const saved = { url: process.env.ANYWHERE_DAEMON_URL, token: process.env.ANYWHERE_TOKEN, home: process.env.ANYWHERE_HOME };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-tui-home-'));
  delete process.env.ANYWHERE_DAEMON_URL;
  delete process.env.ANYWHERE_TOKEN;
  process.env.ANYWHERE_HOME = home;
  try {
    await assert.rejects(() => T.runTui({ input: new PassThrough(), output: new PassThrough() }), (e) => e.code === 'NOT_RUNNING' && /anywhere start/.test(e.message));
  } finally {
    if (saved.url !== undefined) process.env.ANYWHERE_DAEMON_URL = saved.url;
    if (saved.token !== undefined) process.env.ANYWHERE_TOKEN = saved.token;
    if (saved.home !== undefined) process.env.ANYWHERE_HOME = saved.home;
    else delete process.env.ANYWHERE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
