'use strict';

/**
 * `anywhere calls …` (docs/CALLS-DESIGN.md §10.5, src/cli/calls.js) and the dialog's calls pill and
 * panel (§10.7, src/ui/calls-panel.js + calls-ui.js).
 *  - argument parsing (durations, --until, apps), every subcommand against a fake daemon, --json
 *    output and exit codes (0 ok, 1 error/usage, 2 timeout, 4 not running, 5 not allowed);
 *  - doctorChecks() with fakes; the real CLI in a child process (no daemon);
 *  - the panel's pure helpers in Node, and the pill and panel in headless Chromium against a fake
 *    daemon (polling + its own event stream, and the dialog's 'anywhere:event' hook): arming
 *    through the card, disarming, the live call (caller text stays text), Take over, Hang up (two
 *    clicks), notes, apps, quiet hours, the audio self-test, and stepping aside for cards.
 * No network and no audio: every daemon route and HTTP exchange is a fake. The browser part is
 * skipped without Chromium (set ANYWHERE_TEST_CHROME) or a global WebSocket (Node < 22).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { PassThrough } = require('stream');
const { execFileSync, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-calls-cli-'));
process.env.ANYWHERE_HOME = path.join(TMP, 'state');
const cli = require('../src/cli/calls');
const anywhere = require('../bin/anywhere.js');
const configMod = require('../src/shared/config');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const EXIT = { OK: 0, ERROR: 1, TIMEOUT: 2, STOP: 3, NOT_RUNNING: 4, STOPPED: 5, INTERRUPTED: 130 };
const NOW = new Date(2026, 9, 18, 14, 0, 0).getTime(); // local time
const BASE = 'http://127.0.0.1:47011';
const SECRET = 'zoho-client-secret-123456';
const REFRESH = '1000.refresh-abcdef';

/** commands() with fake helpers and a fake daemon (routes: {'METHOD /path': (body, fullPath, opts) => result}). */
function harness({ running = true, routes = {}, extra = {} } = {}) {
  const out = [];
  const err = [];
  const json = [];
  const requests = [];
  const ensured = [];
  let isRunning = running;
  const notRunning = Object.assign(new Error('Claude Anywhere is not running.'), { name: 'CliError', exitCode: EXIT.NOT_RUNNING });
  const h = {
    spec: (e) => e,
    shared: (n) => require(`../src/shared/${n}`),
    call: async (client, method, p, body, opts) => {
      requests.push({ method, path: p, body, opts });
      const fn = routes[`${method} ${p.split('?')[0]}`];
      if (!fn) throw Object.assign(new Error('Claude Anywhere: Not found (HTTP 404)'), { status: 404, serverMessage: 'Not found' });
      return fn(body, p, opts);
    },
    requireDaemon: async () => {
      if (!isRunning) throw notRunning;
      return { client: { baseUrl: BASE } };
    },
    ensureDaemon: async (o) => {
      ensured.push(o);
      isRunning = true;
      return { host: 'browser' };
    },
    writeOut: (s) => out.push(String(s)),
    writeErr: (s) => err.push(String(s)),
    printJson: (o) => json.push(JSON.parse(JSON.stringify(o))),
    sym: () => ({ ok: 'OK', warn: '!', fail: 'X', dot: '-', arrow: '->', ell: '...' }),
    color: { green: (s) => s, yellow: (s) => s, red: (s) => s, dim: (s) => s, bold: (s) => s, cyan: (s) => s },
    EXIT,
    now: () => NOW,
    ...extra,
  };
  const cmd = cli.commands(h).calls;
  return {
    run: (argv) => cmd.run(anywhere.parseArgs(argv, anywhere.COMMANDS.calls.spec)),
    out,
    err,
    json,
    requests,
    ensured,
    text: () => out.join('\n'),
  };
}

// ---------------------------------------------------------------- pure helpers

test('durations, --until, apps', () => {
  assert.equal(cli.parseDuration('2h'), 120);
  assert.equal(cli.parseDuration('90m'), 90);
  assert.equal(cli.parseDuration('1h30m'), 90);
  assert.equal(cli.parseDuration('1.5h'), 90);
  assert.equal(cli.parseDuration('45'), 45);
  assert.equal(cli.parseDuration('2 hours'), 120);
  assert.equal(cli.parseDuration('30 min'), 30);
  for (const bad of ['', 'soon', '2h later', 'h2', '-1h']) assert.equal(cli.parseDuration(bad), null, bad);
  const now = new Date(NOW);
  assert.equal(cli.minutesUntil('18:00', now), 240);
  assert.equal(cli.minutesUntil('13:00', now), 23 * 60);
  assert.equal(cli.minutesUntil('14:00', now), 24 * 60);
  for (const bad of ['24:00', '7pm', '', '12:60']) assert.equal(cli.minutesUntil(bad, now), null, bad);
  assert.deepEqual(cli.parseApps('cliq, meet,Teams'), ['zoho-cliq', 'google-meet', 'teams']);
  assert.deepEqual(cli.parseApps('cliq,zoho cliq'), ['zoho-cliq']);
  assert.deepEqual(cli.parseApps('Google Meet, Microsoft Teams'), ['google-meet', 'teams']);
  assert.deepEqual(cli.parseApps('cliq meet'), ['zoho-cliq', 'google-meet']);
  assert.deepEqual(cli.parseApps('all'), ['zoho-cliq', 'google-meet', 'teams', 'slack', 'zoom']);
  assert.throws(() => cli.parseApps('skype'), /Unknown call app "skype"/);
  assert.equal(cli.parseApps(''), null);
});

/** A status as CallManager.status() reports it (src/calls/manager.js). */
function managerStatus(extra = {}) {
  return {
    state: 'armed',
    armed: true,
    until: new Date(NOW + 4 * 3600000).toISOString(),
    untilLocal: '18:00',
    apps: ['zoho-cliq', 'google-meet'],
    quietHours: { enabled: true, start: '22:00', end: '08:00' },
    inQuietHours: false,
    audio: { mode: 'virtual', ready: true, issues: [] },
    current: null,
    recent: [
      { at: new Date(NOW - 3600000).toISOString(), type: 'answered', callId: 'c-1', caller: 'Ankit Sharma', app: 'zoho-cliq', endedAt: new Date(NOW - 3600000 + 232000).toISOString(), reason: 'caller_hung_up', notesPath: '/home/dee/Desktop/Claude Call Notes/2026-10-18 13-00 Ankit (Zoho Cliq).md' },
      { at: new Date(NOW - 7200000).toISOString(), type: 'missed', reason: 'quiet_hours', caller: 'Priya Nair', app: 'google-meet' },
    ],
    arming: false,
    ...extra,
  };
}

test('status lines from a CallManager status', () => {
  const lines = cli.statusLines(managerStatus(), { now: NOW, notesDir: '/home/dee/Desktop/Claude Call Notes', voice: 'your cloned voice (pocket)' });
  assert.deepEqual(lines, [
    'Calls        answering until 18:00 (4 h left) · Zoho Cliq, Google Meet',
    'Quiet hours  22:00–08:00',
    'Audio        virtual microphone: ready',
    'Voice        your cloned voice (pocket)',
    'Recent',
    '  13:00  Ankit Sharma (Zoho Cliq) · answered by the assistant · 3 min 52 s',
    '         notes: /home/dee/Desktop/Claude Call Notes/2026-10-18 13-00 Ankit (Zoho Cliq).md',
    '  12:00  Priya Nair (Google Meet) · missed (quiet hours)',
    'Notes        /home/dee/Desktop/Claude Call Notes',
  ]);
  const inCall = cli.statusLines(managerStatus({ current: { id: 'c-2', caller: 'Ankit Sharma', app: 'zoho-cliq', appName: 'Zoho Cliq', state: 'listening', startedAt: new Date(NOW - 83000).toISOString() }, recent: [], inQuietHours: true, audio: { mode: 'speakers', ready: false, issues: [{ code: 'NO_PULSE', level: 'error', message: 'The sound server does not answer' }] } }), { now: NOW });
  assert.ok(inCall.includes('Now          on a call with Ankit Sharma (Zoho Cliq) · 1 min 23 s · listening'), inCall.join('\n'));
  assert.ok(inCall.includes('Quiet hours  22:00–08:00 · now: calls ring through and are noted as missed'));
  assert.ok(inCall.includes('Audio        speakers + microphone (half duplex, lower quality): not ready (The sound server does not answer) · anywhere calls doctor'));
  assert.deepEqual(cli.statusLines({ armed: false }, { now: NOW }), ['Calls        not answering · turn on: anywhere calls on (needs a click in the dialog)']);
  assert.deepEqual(cli.statusLines({ armed: false, arming: true }, { now: NOW }), ['Calls        waiting for your click on the card in the dialog']);
  assert.equal(cli.reasonLabel('owner_active'), 'you were at the computer');
});

// ---------------------------------------------------------------- on / off

test('calls on: asks the dialog, waits for the click, reports until when and which apps', async () => {
  let body = null;
  const t = harness({ routes: { 'POST /api/calls/arm': (b) => ((body = b), { ok: true, armed: true, until: new Date(NOW + 2 * 3600000).toISOString(), apps: b.apps }) } });
  const code = await t.run(['on', '--for', '2h', '--apps', 'cliq,meet', '--instructions', 'Assign tickets from the PAY board']);
  assert.equal(code, 0);
  assert.deepEqual(body, { via: 'cli', minutes: 120, apps: ['zoho-cliq', 'google-meet'], instructions: 'Assign tickets from the PAY board' });
  assert.match(t.err.join('\n'), /^Click Allow once in the Claude Anywhere dialog/);
  assert.match(t.text(), /^OK Answering your calls until 16:00 \(Zoho Cliq, Google Meet\)\./);
  assert.match(t.text(), /anywhere calls off/);
  const arm = t.requests.find((r) => r.path === '/api/calls/arm');
  assert.ok(arm.opts.timeoutMs >= 10 * 60 * 1000, 'the request waits for the click');

  // Positional words are the instructions; --until is local time; the default duration is the daemon's.
  let b2 = null;
  const t2 = harness({ routes: { 'POST /api/calls/arm': (b) => ((b2 = b), { ok: true, armed: true }) } });
  assert.equal(await t2.run(['on', 'answer', 'and', 'assign', 'tickets', '--until', '18:00']), 0);
  assert.deepEqual(b2, { via: 'cli', minutes: 240, instructions: 'answer and assign tickets' });
  const t3 = harness({ routes: { 'POST /api/calls/arm': (b) => ((b2 = b), { ok: true, armed: true }) } });
  assert.equal(await t3.run(['on']), 0);
  assert.deepEqual(b2, { via: 'cli' });
});

test('calls on: not allowed (5), no answer (2), JSON, starting the dialog, usage errors, an old daemon', async () => {
  const denied = harness({ routes: { 'POST /api/calls/arm': () => ({ ok: false, denied: true }) } });
  assert.equal(await denied.run(['on']), EXIT.STOPPED);
  assert.match(denied.text(), /Not answering calls: it was not allowed\./);
  const deniedJson = harness({ routes: { 'POST /api/calls/arm': () => ({ ok: false, denied: true, reason: 'Denied by click' }) } });
  assert.equal(await deniedJson.run(['on', '--json']), EXIT.STOPPED);
  assert.deepEqual(deniedJson.json[0], { ok: false, armed: false, until: null, denied: true, reason: 'Denied by click', error: null, code: null, hint: null, apps: null });
  // Could not arm (not a denial): the daemon's reason and hint, exit 1.
  const busy = harness({ routes: { 'POST /api/calls/arm': () => ({ ok: false, error: 'A request to answer your calls is already waiting for your click in the Claude Anywhere dialog.', code: 'BUSY' }) } });
  await assert.rejects(busy.run(['on']), (e) => e.exitCode === 1 && /Could not turn on call answering: A request to answer your calls is already waiting/.test(e.message));
  const busyJson = harness({ routes: { 'POST /api/calls/arm': () => ({ ok: false, error: 'No dialog is open', hint: 'anywhere show', code: 'NO_UI' }) } });
  assert.equal(await busyJson.run(['on', '--json']), 1);
  assert.deepEqual([busyJson.json[0].denied, busyJson.json[0].code, busyJson.json[0].hint], [false, 'NO_UI', 'anywhere show']);
  const slow = harness({
    routes: {
      'POST /api/calls/arm': () => {
        throw new Error('Request to /api/calls/arm timed out after 960 s');
      },
    },
  });
  assert.equal(await slow.run(['on']), EXIT.TIMEOUT);
  assert.match(slow.text(), /it was withdrawn: calls are not being answered/);
  const cold = harness({ running: false, routes: { 'POST /api/calls/arm': () => ({ ok: true, armed: true, until: new Date(NOW + 3600000).toISOString() }) } });
  assert.equal(await cold.run(['on', '--for', '60']), 0);
  assert.equal(cold.ensured.length, 1);
  assert.equal(cold.ensured[0].open, true);
  assert.match(cold.err.join('\n'), /the dialog is opening/);
  for (const [args, re] of [
    [['on', '--for', '2h', '--until', '18:00'], /--for or --until, not both/],
    [['on', '--for', '13h'], /at most 12 hours/],
    [['on', '--for', 'soon'], /--for takes a duration/],
    [['on', '--until', '25:00'], /--until takes a local time/],
    [['on', '--apps', 'skype'], /Unknown call app "skype"/],
    [['on', '--instructions', 'x'.repeat(1001)], /too long/],
  ]) {
    const t = harness({ routes: { 'POST /api/calls/arm': () => assert.fail('must not arm') } });
    await assert.rejects(t.run(args), (e) => e.name === 'CliError' && e.exitCode === 1 && re.test(e.message), args.join(' '));
  }
  const old = harness({ routes: {} });
  await assert.rejects(old.run(['on']), /cannot answer calls yet/);
});

test('calls off: disarms at once; without a daemon there is nothing to stop', async () => {
  const t = harness({ routes: { 'POST /api/calls/disarm': (b) => (assert.deepEqual(b, { via: 'cli' }), { ok: true }) } });
  assert.equal(await t.run(['off']), 0);
  assert.equal(t.text(), 'OK Stopped answering calls.');
  const idle = harness({ running: false });
  assert.equal(await idle.run(['off', '--json']), 0);
  assert.deepEqual(idle.json[0], { ok: true, armed: false, running: false });
});

// ---------------------------------------------------------------- status / doctor

test('calls status: the daemon status, the voice, the notes folder; JSON; no daemon', async () => {
  const home = path.join(TMP, 'home-status');
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  const notesOptions = { platformInfo: { platform: 'linux', isWSL: false }, env: { HOME: home }, homedir: home, which: () => null };
  const t = harness({
    routes: {
      'GET /api/calls/status': () => managerStatus(),
      'GET /api/clone/status': () => ({ installed: true, engine: 'pocket', profile: { exists: true, ok: true } }),
    },
    extra: { notesOptions },
  });
  assert.equal(await t.run(['status']), 0);
  assert.match(t.text(), /^Calls {8}answering until 18:00/m);
  assert.match(t.text(), /^Voice {8}your cloned voice \(pocket\)$/m);
  assert.match(t.text(), new RegExp(`^Notes {8}${path.join(home, 'Desktop', 'Claude Call Notes').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  const j = harness({ routes: { 'GET /api/calls/status': () => managerStatus() }, extra: { notesOptions } });
  assert.equal(await j.run(['status', '--json']), 0);
  assert.equal(j.json[0].running, true);
  assert.equal(j.json[0].armed, true);
  assert.equal(j.json[0].notesDir, path.join(home, 'Desktop', 'Claude Call Notes'));
  const off = harness({ running: false, extra: { notesOptions } });
  assert.equal(await off.run(['status']), 0);
  assert.match(off.text(), /not answering \(the dialog is not running/);
  const bad = harness();
  await assert.rejects(bad.run(['dance']), /Unknown calls command "dance"/);
});

test('calls doctor: rows, fixes and the exit code', async () => {
  const rows = [
    { id: 'a', label: 'Call audio', status: 'fail', detail: 'not ready:\nno server', fix: 'Start the sound server', notes: ['line one\nline two'], critical: false },
    { id: 'b', label: 'Call notes', status: 'ok', detail: '/x', fix: '', notes: [], critical: false },
  ];
  const t = harness({ extra: { doctorChecks: async (o) => (assert.equal(o.deep, true), rows) } });
  assert.equal(await t.run(['doctor', '--deep']), 1);
  assert.match(t.text(), /X Call audio {9}not ready: no server/);
  assert.match(t.text(), /- line one line two/);
  assert.match(t.text(), /fix: Start the sound server/);
  assert.match(t.text(), /1 problem, 0 warnings\./);
  const j = harness({ extra: { doctorChecks: async () => rows.slice(1) } });
  assert.equal(await j.run(['doctor', '--json']), 0);
  assert.deepEqual(j.json[0], { ok: true, checks: rows.slice(1) });
});

test('doctorChecks(): voice, audio, detection, Cliq token refresh and notes, with fakes', async () => {
  const home = path.join(TMP, 'home-doctor');
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  const httpCalls = [];
  const fakeHttp = async (url, o) => {
    httpCalls.push(url);
    return { status: 200, body: Buffer.from(JSON.stringify({ access_token: 'tok', expires_in: 3600 })) };
  };
  const config = configMod.load();
  config.calls.cliq = { mode: 'api', dc: 'eu', clientId: 'id', clientSecret: SECRET, refreshToken: REFRESH };
  const rows = await cli.doctorChecks({
    config,
    env: { HOME: home },
    platformInfo: { platform: 'linux', isWSL: false },
    getDriver: async () => ({ listWindows: async () => [] }),
    cloneStatus: async () => ({ installed: true, engine: 'pocket', profile: { exists: true, ok: true, ownerName: 'Deepanshu', testSimilarity: 0.51 }, bench: { runs: [{ engine: 'pocket', threads: 2, rtf: 0.5 }] } }),
    runner: async () => ({ code: 1, stdout: '', stderr: 'Connection refused' }),
    which: () => null,
    http: fakeHttp,
    notesOptions: { homedir: home, which: () => null },
    resultFile: path.join(TMP, 'no-self-test.json'),
  });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId['calls-safety'].status, 'ok');
  assert.match(byId['calls-safety'].detail, /off until you arm it with a click \(at most 12 h\); quiet hours 22:00–08:00/);
  assert.equal(byId['calls-voice'].status, 'ok');
  assert.match(byId['calls-voice'].detail, /pocket voice of Deepanshu, test match 0\.51/);
  assert.ok(byId['calls-audio'], 'the audio rows are included');
  assert.equal(byId['calls-detect'].status, 'warn');
  assert.match(byId['calls-detect'].notes.join(' '), /dbus-monitor/);
  assert.match(byId['calls-detect'].fix, /anywhere calls learn --app cliq/);
  assert.equal(byId['calls-cliq'].status, 'ok');
  assert.match(byId['calls-cliq'].detail, /Zoho Cliq API \(eu\): the token refreshes/);
  assert.deepEqual(httpCalls, ['https://accounts.zoho.eu/oauth/v2/token']);
  assert.equal(byId['calls-notes'].status, 'ok');
  assert.equal(byId['calls-notes'].detail, path.join(home, 'Desktop', 'Claude Call Notes'));
  assert.ok(byId['calls-jira']);
  for (const r of rows) assert.ok(!JSON.stringify(r).includes(SECRET), 'no secrets in doctor rows');
});

// ---------------------------------------------------------------- test-audio / learn / audio

test('calls test-audio: opens the single-use link and waits for the result file', async () => {
  const resultFile = path.join(TMP, 'calls-audio-test.json');
  fs.writeFileSync(resultFile, JSON.stringify({ at: new Date(Date.now() - 60000).toISOString(), pass: false }));
  const opened = [];
  const t = harness({
    routes: { 'POST /api/calls/audio-test/start': () => ({ url: '/calls-audio-test.html?code=0123456789abcdef', expiresAt: 'x' }) },
    extra: {
      selfTestFile: resultFile,
      pollMs: 20,
      openTarget: async (u, o) => {
        opened.push([u, o]);
        setTimeout(() => fs.writeFileSync(resultFile, JSON.stringify({ at: new Date().toISOString(), pass: true, mic: { pass: true, transcript: 'testing one two three' }, capture: { pass: true, verified: 'level' } })), 60);
      },
    },
  });
  assert.equal(await t.run(['test-audio']), 0);
  assert.deepEqual(opened, [[`${BASE}/calls-audio-test.html?code=0123456789abcdef`, { kind: 'url' }]]);
  assert.match(t.err.join('\n'), /open the link there instead/);
  assert.match(t.text(), /OK Call audio self-test: passed/);
  assert.match(t.text(), /virtual microphone\): pass \(heard "testing one two three"\)/);
  assert.match(t.text(), /capture\): {7}pass \(level only\)/);
  const nowait = harness({ routes: { 'POST /api/calls/audio-test/start': () => ({ url: '/calls-audio-test.html?code=ab' }) }, extra: { selfTestFile: resultFile } });
  assert.equal(await nowait.run(['test-audio', '--no-open', '--no-wait', '--json']), 0);
  assert.deepEqual(nowait.json[0], { ok: true, url: `${BASE}/calls-audio-test.html?code=ab`, opened: false, waiting: false });
  const evil = harness({ routes: { 'POST /api/calls/audio-test/start': () => ({ url: 'https://evil.example/x' }) } });
  await assert.rejects(evil.run(['test-audio', '--no-open']), /no self-test link/);
  await assert.rejects(harness({ running: false }).run(['test-audio']), (e) => e.exitCode === EXIT.NOT_RUNNING);
  const late = harness({ routes: { 'POST /api/calls/audio-test/start': () => ({ url: '/calls-audio-test.html?code=cd' }) }, extra: { selfTestFile: resultFile, pollMs: 10, selfTestWaitMs: 50, openTarget: async () => {} } });
  assert.equal(await late.run(['test-audio']), EXIT.TIMEOUT);
});

test('calls learn: posts seconds and app, prints what was learned', async () => {
  let body = null;
  const t = harness({ routes: { 'POST /api/calls/learn': (b) => ((body = b), { ok: true, signature: { app: 'zoho-cliq', titleRe: 'Incoming call', origin: 'cliq.zoho.com', acceptRel: { x: 0.9, y: 0.92 } } }) } });
  assert.equal(await t.run(['learn', '--app', 'cliq', '--seconds', '45']), 0);
  assert.deepEqual(body, { seconds: 45, app: 'zoho-cliq' });
  assert.match(t.err.join('\n'), /Place a test call to this computer now on Zoho Cliq/);
  assert.match(t.text(), /OK Learned how Zoho Cliq rings/);
  assert.match(t.text(), /title \/Incoming call\/, site cliq\.zoho\.com, Accept button position/);
  const none = harness({ routes: { 'POST /api/calls/learn': () => ({ ok: false, reason: 'no ringing call was seen' }) } });
  await assert.rejects(none.run(['learn']), /Nothing was learned: no ringing call was seen/);
  await assert.rejects(harness().run(['learn', '--seconds', '5']), /--seconds must be/);
  await assert.rejects(harness().run(['learn', '--app', 'cliq,meet']), /one app/);
});

test('calls audio setup|teardown|check: the daemon first, else this process', async () => {
  const check = { mode: 'virtual', ready: false, virtualMic: 'Claude-Anywhere-Mic', capture: { backend: 'pulse', device: 'anywhere_call.monitor' }, issues: [{ code: 'NOT_SET_UP', level: 'warn', message: 'The virtual devices are not loaded', hint: 'anywhere calls audio setup' }] };
  const t = harness({ routes: { 'GET /api/calls/audio/check': () => check, 'POST /api/calls/audio/setup': () => ({ ok: true, mode: 'virtual', modules: [1, 2] }), 'POST /api/calls/audio/teardown': () => ({ ok: true, errors: [] }) } });
  assert.equal(await t.run(['audio', 'check']), 0);
  assert.match(t.text(), /Audio {8}virtual microphone Claude-Anywhere-Mic: not ready/);
  assert.match(t.text(), /! The virtual devices are not loaded\n {6}fix: anywhere calls audio setup/);
  assert.equal(await t.run(['audio', 'setup']), 0);
  assert.match(t.text(), /OK Call audio is set up \(virtual microphone\)/);
  assert.equal(await t.run(['audio', 'teardown']), 0);
  assert.match(t.text(), /OK Call audio devices removed/);
  const used = [];
  const local = harness({ running: false, extra: { audioBridge: async () => ({ check: async () => (used.push('check'), { ...check, ready: true, issues: [] }), setup: async () => (used.push('setup'), { ok: true, mode: 'speakers' }) }) } });
  assert.equal(await local.run(['audio', 'check', '--json']), 0);
  assert.equal(local.json[0].source, 'local');
  assert.equal(await local.run(['audio', 'setup']), 0);
  assert.deepEqual(used, ['check', 'setup']);
  await assert.rejects(harness().run(['audio', 'louder']), /Unknown audio command "louder"/);
});

// ---------------------------------------------------------------- cliq

function zohoHttp() {
  const calls = [];
  const fn = async (url, o) => {
    calls.push({ url, body: o.body });
    if (/oauth\/v2\/token/.test(url)) {
      const form = new URLSearchParams(o.body);
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== '1000.grant') return { status: 200, body: Buffer.from(JSON.stringify({ error: 'invalid_code' })) };
        return { status: 200, body: Buffer.from(JSON.stringify({ access_token: 'acc', refresh_token: REFRESH, expires_in: 3600 })) };
      }
      return { status: 200, body: Buffer.from(JSON.stringify({ access_token: 'acc2', expires_in: 3600 })) };
    }
    throw new Error(`unexpected ${url}`);
  };
  fn.calls = calls;
  return fn;
}

test('calls cliq setup: grant code exchange, secrets from stdin or hidden prompts, saved and sent to the dialog', async () => {
  const z = zohoHttp();
  const stdin = new PassThrough();
  stdin.end(`${SECRET}\n`);
  let told = null;
  const t = harness({ routes: { 'POST /api/config': (b) => ((told = b), {}) }, extra: { http: z, stdin } });
  assert.equal(await t.run(['cliq', 'setup', '--dc', 'https://cliq.zoho.eu/company/1/chats', '--client-id', '1000.ID', '--code', '1000.grant', '--secret-stdin']), 0);
  const saved = configMod.load().calls.cliq;
  assert.deepEqual(saved, { mode: 'api', dc: 'eu', clientId: '1000.ID', clientSecret: SECRET, refreshToken: REFRESH });
  assert.deepEqual(told, { calls: { cliq: saved } });
  assert.equal(z.calls[0].url, 'https://accounts.zoho.eu/oauth/v2/token');
  const all = [...t.out, ...t.err].join('\n');
  assert.match(all, /Zoho Cliq API \(cliq\.zoho\.eu\)/);
  assert.ok(!all.includes(SECRET) && !all.includes(REFRESH), 'secrets are never printed');

  // Interactive: data center, client id, hidden secret and code.
  const asked = [];
  const prompter = {
    interactive: true,
    ask: async (q, { defaultValue } = {}) => (asked.push(['ask', q, defaultValue]), q.startsWith('Your Cliq') ? 'in' : '1000.ID2'),
    secret: async (q) => (asked.push(['secret', q]), q === 'Client Secret' ? SECRET : '1000.grant'),
  };
  const ti = harness({ running: false, extra: { http: zohoHttp(), prompter } });
  assert.equal(await ti.run(['cliq', 'setup']), 0);
  assert.deepEqual(asked.map((a) => a.slice(0, 2)), [['ask', 'Your Cliq address or data center (com, eu, in, com.au, jp, ca)'], ['ask', 'Client ID'], ['secret', 'Client Secret'], ['secret', 'Grant code']]);
  assert.match(ti.err.join('\n'), /api-console\.zoho\.in/);
  assert.match(ti.err.join('\n'), /ZohoCliq\.Webhooks\.CREATE/);
  assert.equal(configMod.load().calls.cliq.dc, 'in');

  // A used code: nothing is saved.
  const before = JSON.stringify(configMod.load().calls.cliq);
  const stdin2 = new PassThrough();
  stdin2.end(SECRET);
  const bad = harness({ running: false, extra: { http: zohoHttp(), stdin: stdin2 } });
  await assert.rejects(bad.run(['cliq', 'setup', '--dc', 'eu', '--client-id', 'x', '--code', 'old', '--secret-stdin']), (e) => /nothing was saved/.test(e.message) && /work once/.test(e.hint));
  assert.equal(JSON.stringify(configMod.load().calls.cliq), before);
  await assert.rejects(harness().run(['cliq', 'setup', '--secret', SECRET]), /never taken as an argument/);
  await assert.rejects(harness({ extra: { prompter: { interactive: false } } }).run(['cliq', 'setup', '--dc', 'eu']), /Pass the Self Client ID/);
});

test('calls cliq status|test|gui', async () => {
  configMod.save({ calls: { cliq: { mode: 'api', dc: 'eu', clientId: 'id', clientSecret: SECRET, refreshToken: REFRESH } } });
  const z = zohoHttp();
  const t = harness({ running: false, extra: { http: z } });
  assert.equal(await t.run(['cliq', 'status']), 0);
  assert.match(t.text(), /Zoho Cliq API \(cliq\.zoho\.eu\)$/);
  assert.equal(await t.run(['cliq', 'test']), 0);
  assert.match(t.text(), /The Zoho Cliq API works \(cliq\.zoho\.eu\)/);
  assert.equal(z.calls.length, 1);
  assert.equal(await t.run(['cliq', 'gui']), 0);
  const c = configMod.load().calls.cliq;
  assert.deepEqual([c.mode, c.clientSecret, c.refreshToken], ['gui', '', '']);
  await assert.rejects(t.run(['cliq', 'test']), /not set up/);
  await assert.rejects(t.run(['cliq', 'send']), /Unknown cliq command "send"/);
});

// ---------------------------------------------------------------- notes

test('calls notes: the folder, the newest notes, --open, JSON', async () => {
  const home = path.join(TMP, 'home-notes');
  const dir = path.join(home, 'Desktop', 'Claude Call Notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-10-18 13-00 Ankit (Zoho Cliq).md'), '# A');
  const old = new Date(Date.now() - 86400000);
  fs.writeFileSync(path.join(dir, '2026-10-17 09-00 Priya (Google Meet).md'), '# B');
  fs.utimesSync(path.join(dir, '2026-10-17 09-00 Priya (Google Meet).md'), old, old);
  const opened = [];
  const notesOptions = { platformInfo: { platform: 'linux', isWSL: false }, env: { HOME: home }, homedir: home, which: () => null };
  const t = harness({ running: false, extra: { notesOptions, openTarget: async (p, o) => opened.push([p, o]) } });
  assert.equal(await t.run(['notes']), 0);
  assert.deepEqual(t.out, [`Call notes   ${dir}`, '  2026-10-18 13-00 Ankit (Zoho Cliq).md', '  2026-10-17 09-00 Priya (Google Meet).md']);
  assert.equal(await t.run(['notes', '--open', '-n', '1', '--json']), 0);
  assert.deepEqual(opened, [[dir, { kind: 'path' }]]);
  assert.equal(t.json[0].opened, true);
  assert.deepEqual(t.json[0].notes.map((n) => n.name), ['2026-10-18 13-00 Ankit (Zoho Cliq).md']);
  await assert.rejects(t.run(['notes', '-n', '0']), /-n must be/);
});

// ---------------------------------------------------------------- the real CLI

test('the real CLI: help, status and notes without a daemon, bad subcommands', () => {
  const env = { ...process.env, ANYWHERE_HOME: path.join(TMP, 'child-state'), HOME: path.join(TMP, 'child-home'), NO_COLOR: '1', ANYWHERE_ASCII: '1' };
  fs.mkdirSync(env.HOME, { recursive: true });
  const bin = path.join(__dirname, '..', 'bin', 'anywhere.js');
  const help = execFileSync(process.execPath, [bin, 'help', 'calls'], { env, encoding: 'utf8' });
  assert.match(help, /Usage: anywhere calls \[on \[--for 2h \| --until 18:00\]/);
  assert.match(help, /only a click on "Allow once" arms it/);
  const st = JSON.parse(execFileSync(process.execPath, [bin, 'calls', 'status', '--json'], { env, encoding: 'utf8' }));
  assert.deepEqual([st.running, st.armed], [false, false]);
  assert.equal(st.notesDir, path.join(env.HOME, 'Claude Call Notes'));
  const bad = spawnSync(process.execPath, [bin, 'calls', 'on', '--for', '20h'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /at most 12 hours/);
});

// ---------------------------------------------------------------- the panel: pure helpers

const UI = path.join(__dirname, '..', 'src', 'ui');
const UI_TMP = path.join(TMP, 'ui-esm');
fs.mkdirSync(UI_TMP, { recursive: true });
fs.writeFileSync(path.join(UI_TMP, 'package.json'), '{"type":"module"}\n');
for (const f of fs.readdirSync(UI)) if (f.endsWith('.js')) fs.copyFileSync(path.join(UI, f), path.join(UI_TMP, f));
const loadPanel = () => import(pathToFileURL(path.join(UI_TMP, 'calls-panel.js')).href);

test('panel helpers: the pill for every state, status from CallManager, formatting', async () => {
  const p = await loadPanel();
  const st = p.normalizeStatus(managerStatus());
  assert.equal(st.armed, true);
  assert.deepEqual(st.recent.map((r) => [r.caller, r.outcome, r.notesPath ? 'notes' : '']), [['Ankit Sharma', 'answered', 'notes'], ['Priya Nair', 'missed', '']]);
  assert.equal(st.recent[0].durationMs, 232000);
  assert.deepEqual(p.pillState(st, { now: NOW }), { kind: 'armed', text: 'Answering calls until 18:00', short: 'Until 18:00', title: 'The assistant answers your calls. Click for details or to stop.' });
  assert.equal(p.pillState(p.normalizeStatus({ armed: false }), { now: NOW }).kind, 'off');
  assert.equal(p.pillState(p.normalizeStatus({ armed: false }), { now: NOW, pending: true }).text, 'Confirm in the card…');
  assert.equal(p.pillState(p.normalizeStatus({ armed: false, arming: true }), { now: NOW }).kind, 'pending');
  assert.equal(p.pillState(p.normalizeStatus({ ...managerStatus(), inQuietHours: true }), { now: NOW }).text, 'Quiet hours until 08:00');
  const ring = p.normalizeStatus({ ...managerStatus(), current: { id: 'c', caller: 'Ankit Sharma', app: 'zoho-cliq', state: 'ringing' } });
  assert.deepEqual(p.pillState(ring, { now: NOW }).text, 'Call from Ankit…');
  const live = p.normalizeStatus({ ...managerStatus(), current: { id: 'c', caller: 'Ankit Sharma', app: 'zoho-cliq', appName: 'Zoho Cliq', state: 'listening', startedAt: new Date(NOW - 83000).toISOString(), transcript: [{ role: 'caller', text: 'hi', ts: new Date(NOW).toISOString() }, { role: 'x', text: '  ' }], actions: [{ name: 'assign', summary: 'Assigned PAY-1', ok: true }] } });
  assert.deepEqual(p.pillState(live, { now: NOW }), { kind: 'call', text: 'On a call with Ankit · 1:23', short: '1:23', title: 'The assistant is on a call with Ankit Sharma (Zoho Cliq). Click to follow it, take over or hang up.' });
  assert.equal(live.current.transcript.length, 1);
  assert.equal(live.current.actions[0].summary, 'Assigned PAY-1');
  assert.equal(p.pillState(p.normalizeStatus({ armed: true, until: new Date(NOW - 1000).toISOString() }), { now: NOW }).kind, 'off', 'an expired window shows as off');
  assert.equal(p.timer(83000), '1:23');
  assert.equal(p.timer(3723000), '1:02:03');
  assert.equal(p.durationWords(232000), '3 min 52 s');
  assert.equal(p.validHm('7:05'), '07:05');
  assert.equal(p.validHm('24:00'), null);
  assert.equal(p.appLabel('teams'), 'Microsoft Teams');
  assert.equal(p.appLabel('Cliq web'), 'Zoho Cliq');
  assert.equal(p.firstName('  Ankit Sharma'), 'Ankit');
  assert.equal(p.reasonLabel('quiet_hours'), 'quiet hours');
});

// ---------------------------------------------------------------- the panel in headless Chromium

function findChrome() {
  if (process.env.ANYWHERE_TEST_CHROME) return fs.existsSync(process.env.ANYWHERE_TEST_CHROME) ? process.env.ANYWHERE_TEST_CHROME : null;
  const candidates = [];
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers')) if (/^chromium-\d+$/.test(d)) candidates.push(path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'));
  } catch {
    /* not a Playwright image */
  }
  if (process.platform === 'darwin') candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  else if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
      try {
        const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (p) candidates.push(p);
      } catch {
        /* not installed */
      }
    }
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'";
const TOKEN = 'panel-token';

/** The page: the dialog's top bar and cards area, app.css, a stand-in for app.js, and the loader. */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Claude Anywhere</title>
<link rel="stylesheet" href="app.css"><script type="module" src="app-stub.js"></script></head>
<body><div class="app" id="app"><header class="topbar"><div class="topbar-row"><div class="status-pill" id="status"><span class="status-label">Ready</span></div>
<div class="topbar-actions"><button type="button" class="icon-btn" id="open-settings">S</button></div></div></header>
<section class="cards" id="cards"></section></div><script type="module" src="calls-ui.js"></script></body></html>`;

/** Stands in for app.js: stores the token and, with ?hook, exposes anywhereApi and re-dispatches SSE as 'anywhere:event'. */
const APP_STUB = `
sessionStorage.setItem('anywhere.token', ${JSON.stringify(TOKEN)});
if (location.search.includes('hook')) {
  window.anywhereApi = async (method, path, body) => {
    window.__hookCalls = (window.__hookCalls || 0) + 1;
    const r = await fetch(path, { method, headers: { Authorization: 'Bearer ${TOKEN}', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || 'failed'), { status: r.status });
    return d;
  };
  const es = new EventSource('/api/events?token=${TOKEN}&client=ui');
  for (const type of ['calls', 'call_transcript', 'call_action', 'call_notes', 'config', 'approval_request']) {
    es.addEventListener(type, (ev) => window.dispatchEvent(new CustomEvent('anywhere:event', { detail: { type, data: JSON.parse(ev.data) } })));
  }
}`;

/** A fake daemon for the panel: status, arm (held until the test "clicks"), config, notes, SSE. */
async function fakeDaemon() {
  const state = {
    status: { state: 'disarmed', armed: false, until: null, apps: ['zoho-cliq', 'google-meet'], quietHours: { enabled: true, start: '22:00', end: '08:00' }, inQuietHours: false, audio: { mode: 'virtual', ready: true, issues: [] }, current: null, recent: [], arming: false },
    config: { calls: { apps: ['zoho-cliq', 'google-meet'], quietHours: { enabled: true, start: '22:00', end: '08:00' }, defaultArmMinutes: 120, maxArmMinutes: 720, notesDir: '' } },
    posts: [],
    streams: [],
    clients: [],
    armWaiter: null,
    unauthorized: 0,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (!url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      let body;
      if (name === 'index.html') body = PAGE;
      else if (name === 'app-stub.js') body = APP_STUB;
      else if (/^[\w.-]+\.(js|css|svg)$/.test(name) && fs.existsSync(path.join(UI, name))) body = fs.readFileSync(path.join(UI, name));
      else {
        res.writeHead(404);
        res.end();
        return;
      }
      const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript';
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    const authed = req.headers.authorization === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN;
    if (!authed) {
      state.unauthorized++;
      send(401, { error: 'Unauthorized' });
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': hi\n\n');
      state.streams.push(res);
      state.clients.push(url.searchParams.get('client'));
      req.on('close', () => (state.streams = state.streams.filter((s) => s !== res)));
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const key = `${req.method} ${url.pathname}`;
    if (req.method === 'POST') state.posts.push({ path: url.pathname, body, query: url.search });
    switch (key) {
      case 'GET /api/calls/status':
        return send(200, state.status);
      case 'GET /api/config':
        return send(200, state.config);
      case 'POST /api/config':
        state.config = { ...state.config, calls: { ...state.config.calls, ...(body.calls || {}) } };
        return send(200, state.config);
      case 'POST /api/calls/arm':
        if (state.armFail) return send(200, state.armFail);
        state.status = { ...state.status, arming: true };
        state.armWaiter = (result) => {
          state.status = { ...state.status, arming: false, ...(result.armed ? { armed: true, until: result.until, state: 'armed' } : {}) };
          send(200, result);
        };
        return undefined;
      case 'POST /api/calls/disarm':
        state.status = { ...state.status, armed: false, until: null, state: 'disarmed' };
        return send(200, { ok: true });
      case 'POST /api/calls/takeover':
      case 'POST /api/calls/hangup':
        return send(200, { ok: true });
      case 'GET /api/calls/notes':
        return send(200, { path: '/home/dee/Desktop/Claude Call Notes/2026-10-18 13-00 Ankit (Zoho Cliq).md', markdown: '# Call with Ankit Sharma — Zoho Cliq\n\n## Summary\nAnkit got <b>PAY-412</b>.\n' });
      case 'POST /api/calls/notes/open':
        return send(404, { error: 'Not found' });
      case 'POST /api/calls/audio-test/start':
        return send(200, { url: '/calls-audio-test.html?code=feedface', opened: true });
      case 'GET /api/clone/status':
        return send(200, {});
      default:
        return send(404, { error: 'Not found' });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const push = (type, data) => {
    for (const s of state.streams) s.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return {
    state,
    push,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((r) => {
        for (const s of state.streams) s.end();
        server.close(r);
        server.closeAllConnections && server.closeAllConnections();
      }),
  };
}

async function openBrowser(chrome) {
  const { launchChrome } = require('./fixtures/chrome-launch');
  const { port, cleanup } = await launchChrome(chrome, { prefix: 'anywhere-chrome-calls-' });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Log.entryAdded' && /Content Security Policy|Refused/.test(m.params.entry.text)) problems.push(`log: ${m.params.entry.text}`);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = (id += 1);
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 460, height: 760, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'evaluate failed');
    return r.result.result.value;
  };
  const until = async (expression, ms = 8000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      last = await evaluate(expression).catch((e) => e.message);
      if (last === true) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for: ${expression} (last: ${JSON.stringify(last)})`);
  };
  return {
    send,
    evaluate,
    until,
    problems,
    goto: async (url) => {
      await send('Page.navigate', { url });
      await until("document.readyState === 'complete' && Boolean(document.getElementById('calls-pill'))", 15000);
    },
    close: () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return cleanup();
    },
  };
}

test('the calls pill and panel in the dialog (headless Chromium)', { timeout: 120000 }, async (t) => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chromium found (set ANYWHERE_TEST_CHROME)');
  if (typeof globalThis.WebSocket !== 'function') return t.skip('needs a global WebSocket (Node >= 22)');
  const daemon = await fakeDaemon();
  const page = await openBrowser(chrome);
  try {
    // ---- polling mode (no hook): the pill sits in the top bar, before the dialog's own buttons.
    await page.goto(`${daemon.url}/`);
    assert.equal(await page.evaluate("document.querySelector('.topbar-actions').firstElementChild.id"), 'calls-pill');
    await page.until("document.getElementById('calls-pill').dataset.kind === 'off'");
    assert.equal(await page.evaluate("document.getElementById('calls-pill').getAttribute('aria-label')"), 'Calls');
    assert.equal(await page.evaluate("Boolean(document.getElementById('ca-calls-style')) && Boolean(document.querySelector('link[data-anywhere-calls-css]'))"), true);
    // The loader opened its own event stream (client=calls), which does not count as a dialog.
    for (let i = 0; i < 100 && !daemon.state.clients.includes('calls'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(daemon.state.clients.includes('calls'), JSON.stringify(daemon.state.clients));

    // ---- arm through the card: the panel steps aside, the pill asks for the click.
    await page.evaluate("document.getElementById('calls-pill').click()");
    await page.until("!document.querySelector('.ca-calls-overlay').hidden && document.activeElement.classList.contains('ca-close')");
    assert.equal(await page.evaluate("document.querySelector('.ca-calls[role=dialog]').getAttribute('aria-modal')"), 'true');
    assert.equal(await page.evaluate("document.getElementById('ca-calls-arm').checked"), false);
    assert.equal(await page.evaluate("document.querySelector('input[name=ca-calls-minutes]:checked').value"), '120');
    await page.evaluate("document.getElementById('ca-calls-for-240').click()");
    await page.evaluate("document.getElementById('ca-calls-arm').click()");
    await page.until("document.querySelector('.ca-calls-overlay').hidden && document.getElementById('calls-pill').dataset.kind === 'pending'");
    assert.equal(await page.evaluate("document.querySelector('.ca-calls-pill-text').textContent"), 'Confirm in the card…');
    for (let i = 0; i < 100 && !daemon.state.armWaiter; i++) await new Promise((r) => setTimeout(r, 20));
    const arm = daemon.state.posts.find((p) => p.path === '/api/calls/arm');
    assert.deepEqual(arm.body, { minutes: 240, via: 'panel' });
    const until = new Date(Date.now() + 4 * 3600000);
    const hhmm = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
    daemon.state.armWaiter({ ok: true, armed: true, until: until.toISOString() });
    await page.until(`document.getElementById('calls-pill').dataset.kind === 'armed' && document.querySelector('.ca-calls-pill-text').textContent === 'Answering calls until ${hhmm}'`);

    // ---- disarm: no confirmation.
    await page.evaluate("document.getElementById('calls-pill').click()");
    await page.until("document.getElementById('ca-calls-arm') && document.getElementById('ca-calls-arm').checked");
    await page.evaluate("document.getElementById('ca-calls-arm').click()");
    await page.until("document.getElementById('calls-pill').dataset.kind === 'off'");
    assert.ok(daemon.state.posts.some((p) => p.path === '/api/calls/disarm'));

    // ---- arming that fails before any card (the voice runtime is missing): the panel comes back with why.
    daemon.state.armFail = { ok: false, error: 'The free voice runtime (speech recognition and voices) is not installed yet.', hint: 'Install it: anywhere clone-voice install', code: 'NOT_INSTALLED' };
    await page.evaluate("document.getElementById('ca-calls-arm').click()");
    await page.until("!document.querySelector('.ca-calls-overlay').hidden && /Could not turn on call answering: The free voice runtime .* Install it: anywhere clone-voice install/.test(document.querySelector('.ca-calls .ca-note').textContent)");
    assert.equal(await page.evaluate("document.getElementById('calls-pill').dataset.kind"), 'off');
    assert.equal(await page.evaluate("document.getElementById('ca-calls-arm').checked"), false);
    delete daemon.state.armFail;

    // ---- apps and quiet hours are saved settings; the last app cannot be unticked.
    // A save re-renders the panel once the daemon answered: wait for that, not just for the click.
    const afterRerender = async (action) => {
      await page.evaluate("document.querySelectorAll('.ca-calls .ca-body > *').forEach((e) => e.setAttribute('data-stale', '1'))");
      await page.evaluate(action);
      await page.until("!document.querySelector('.ca-calls .ca-body > [data-stale]')");
    };
    await page.until("Boolean(document.getElementById('ca-calls-app-teams'))");
    await afterRerender("document.getElementById('ca-calls-app-teams').click()");
    assert.equal(await page.evaluate("document.getElementById('ca-calls-app-teams').checked"), true);
    assert.deepEqual(daemon.state.posts.filter((p) => p.path === '/api/config').pop().body, { calls: { apps: ['zoho-cliq', 'google-meet', 'teams'] } });
    await afterRerender("const e = document.getElementById('ca-calls-qh-start'); e.value = '21:30'; e.dispatchEvent(new Event('change', { bubbles: true }))");
    assert.equal(await page.evaluate("document.getElementById('ca-calls-qh-start').value"), '21:30');
    assert.deepEqual(daemon.state.posts.filter((p) => p.path === '/api/config').pop().body, { calls: { quietHours: { enabled: true, start: '21:30', end: '08:00' } } });
    daemon.state.config.calls.apps = ['zoho-cliq'];
    daemon.push('config', { calls: daemon.state.config.calls });
    await page.until("document.getElementById('ca-calls-app-teams') && !document.getElementById('ca-calls-app-teams').checked");
    const savesBefore = daemon.state.posts.filter((p) => p.path === '/api/config').length;
    await page.evaluate("document.getElementById('ca-calls-app-zoho-cliq').click()");
    await page.until("document.getElementById('ca-calls-app-zoho-cliq').checked && /at least one app/.test(document.querySelector('.ca-calls .ca-body').textContent)");
    assert.equal(daemon.state.posts.filter((p) => p.path === '/api/config').length, savesBefore);

    // ---- the audio self-test link.
    await page.evaluate("[...document.querySelectorAll('.ca-calls button')].find((b) => b.textContent === 'Test call audio').click()");
    await page.until("Boolean(document.querySelector('.ca-calls-link code'))");
    assert.equal(await page.evaluate("document.querySelector('.ca-calls-link code').textContent"), `${daemon.url}/calls-audio-test.html?code=feedface`);
    assert.deepEqual(daemon.state.posts.find((p) => p.path === '/api/calls/audio-test/start').body, { open: true });

    // ---- a card appears (e.g. a permission): the panel gets out of the way; Escape also closes it.
    daemon.push('approval_request', { id: 'a1' });
    await page.until("document.querySelector('.ca-calls-overlay').hidden");
    await page.evaluate("document.getElementById('calls-pill').click()");
    await page.until("!document.querySelector('.ca-calls-overlay').hidden");
    await page.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await page.until("document.querySelector('.ca-calls-overlay').hidden && document.activeElement.id === 'calls-pill'");

    // ---- a live call: the pill, the transcript (caller text stays text), actions, Take over, Hang up.
    daemon.state.status = { ...daemon.state.status, armed: true, until: until.toISOString(), current: { id: 'c-7', caller: 'Ankit Sharma', app: 'zoho-cliq', appName: 'Zoho Cliq', state: 'listening', startedAt: new Date(Date.now() - 65000).toISOString(), transcript: [{ role: 'assistant', text: "Hi Ankit, this is Deepanshu's AI assistant.", ts: new Date().toISOString() }], actions: [], saveTranscript: true } };
    daemon.push('calls', { state: 'in_call', armed: true, armedUntil: until.toISOString(), call: daemon.state.status.current });
    await page.until("document.getElementById('calls-pill').dataset.kind === 'call' && /^On a call with Ankit · 1:0\\d$/.test(document.querySelector('.ca-calls-pill-text').textContent)");
    await page.evaluate("document.getElementById('calls-pill').click()");
    await page.until("document.querySelectorAll('.ca-calls-transcript li').length === 1");
    daemon.push('call_transcript', { callId: 'c-7', role: 'caller', text: 'Assign me a ticket <img src=x onerror="window.__pwned=1">', ts: new Date().toISOString() });
    daemon.push('call_action', { callId: 'c-7', name: 'assign', summary: 'Assigned PAY-412 "Fix retry" to Ankit Sharma', ok: true });
    await page.until("document.querySelectorAll('.ca-calls-transcript li').length === 2 && document.querySelectorAll('.ca-calls-actions-list li').length === 1");
    assert.equal(await page.evaluate("document.querySelector('.ca-calls-transcript li:last-child').textContent"), 'Ankit:Assign me a ticket <img src=x onerror="window.__pwned=1">');
    assert.equal(await page.evaluate("document.querySelectorAll('.ca-calls-transcript img').length + (window.__pwned ? 1 : 0)"), 0);
    assert.match(await page.evaluate("document.querySelector('.ca-calls-live-head').textContent"), /On a call with Ankit Sharma.*Zoho Cliq · 1:\d\d.*listening/);
    await page.evaluate("[...document.querySelectorAll('.ca-calls-live button')].find((b) => b.textContent === 'Take over').click()");
    await page.until("/You have the call: your microphone is back on/.test(document.querySelector('.ca-calls .ca-body').textContent)");
    assert.deepEqual(daemon.state.posts.find((p) => p.path === '/api/calls/takeover').body, { callId: 'c-7', via: 'panel' });
    await page.until("Boolean([...document.querySelectorAll('.ca-calls-live button')].find((b) => b.textContent === 'Hang up'))");
    await page.evaluate("[...document.querySelectorAll('.ca-calls-live button')].find((b) => b.textContent === 'Hang up').click()");
    await page.until("Boolean([...document.querySelectorAll('.ca-calls-live button')].find((b) => b.textContent === 'Click again to hang up'))");
    assert.equal(daemon.state.posts.some((p) => p.path === '/api/calls/hangup'), false, 'one click does not hang up');
    await page.evaluate("[...document.querySelectorAll('.ca-calls-live button')].find((b) => b.textContent === 'Click again to hang up').click()");
    for (let i = 0; i < 100 && !daemon.state.posts.some((p) => p.path === '/api/calls/hangup'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(daemon.state.posts.find((p) => p.path === '/api/calls/hangup').body, { callId: 'c-7', via: 'panel' });
    await page.until("/Hanging up…/.test(document.querySelector('.ca-calls .ca-body').textContent)");

    // ---- the call ends: recent calls with notes, shown inside the dialog (rendered as text, no HTML).
    daemon.state.status = { ...daemon.state.status, current: null, recent: [{ at: new Date(Date.now() - 65000).toISOString(), type: 'answered', callId: 'c-7', caller: 'Ankit Sharma', app: 'zoho-cliq', endedAt: new Date().toISOString(), notesPath: '/home/dee/Desktop/Claude Call Notes/2026-10-18 13-00 Ankit (Zoho Cliq).md' }, { at: new Date().toISOString(), type: 'missed', reason: 'quiet_hours', caller: 'Priya Nair', app: 'google-meet' }] };
    daemon.push('calls', { state: 'armed', armed: true, armedUntil: until.toISOString(), call: null });
    daemon.push('call_notes', { callId: 'c-7', path: '/home/dee/Desktop/Claude Call Notes/2026-10-18 13-00 Ankit (Zoho Cliq).md' });
    await page.until("document.querySelectorAll('.ca-calls-recent li').length === 2");
    assert.match(await page.evaluate("document.querySelector('.ca-calls-recent li:last-child').textContent"), /Priya Nair.*Google Meet · missed · quiet hours/);
    assert.match(await page.evaluate("document.querySelector('.ca-calls .ca-note').textContent"), /Call notes saved: 2026-10-18 13-00 Ankit \(Zoho Cliq\)\.md/);
    await page.evaluate("document.querySelector('.ca-calls-recent li:first-child button').click()");
    await page.until("Boolean(document.querySelector('.ca-calls-notes-view h1'))");
    assert.equal(await page.evaluate("document.querySelector('.ca-calls-notes-view h1').textContent"), 'Call with Ankit Sharma — Zoho Cliq');
    assert.equal(await page.evaluate("document.querySelectorAll('.ca-calls-notes-view b').length"), 0);
    assert.match(await page.evaluate("document.querySelector('.ca-calls-path').textContent"), /Claude Call Notes/);
    await page.evaluate("[...document.querySelectorAll('.ca-calls button')].find((b) => b.textContent === 'Open the file').click()");
    await page.until("/copy the path instead/.test(document.querySelector('.ca-calls .ca-body').textContent)");
    await page.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await page.until("Boolean(document.getElementById('ca-calls-arm'))");

    // ---- with the dialog's hook: events come through 'anywhere:event' and requests through anywhereApi.
    const before = daemon.state.clients.length;
    daemon.state.status = { ...daemon.state.status, armed: false, until: null, current: null };
    await page.goto(`${daemon.url}/?hook`);
    for (let i = 0; i < 100 && daemon.state.clients.length < before + 1; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(daemon.state.clients.slice(before), ['ui'], 'no second event stream with the hook');
    await page.until("document.getElementById('calls-pill').dataset.kind === 'off' && window.__hookCalls > 0");
    daemon.state.status = { ...daemon.state.status, armed: true, until: until.toISOString() };
    daemon.push('calls', { state: 'armed', armed: true, armedUntil: until.toISOString(), call: null });
    await page.until("document.getElementById('calls-pill').dataset.kind === 'armed'");
    assert.equal(daemon.state.unauthorized, 0);
    assert.deepEqual(page.problems, []);
  } finally {
    await page.close();
    await daemon.close();
  }
});
