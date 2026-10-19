'use strict';

/**
 * The announcer (what is said, when, and where it plays) and the voice routes (audio ids that
 * cannot traverse paths, synthesize, use, test) on a real daemon with a fake Piper.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-announcer-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;
delete process.env.ANYWHERE_PIPER_PATH;

const a = require('../src/daemon/announcer');
const { Announcer } = a;
const routes = require('../src/daemon/routes-voice');
const { secretLike } = require('../src/daemon/permissions');

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ wording

test('done: a short varied opener plus the first sentence or two, markdown and links removed, at most 220 characters', () => {
  assert.equal(
    a.composeDone({ text: '## Deployed\n\nI deployed **shop-api** to Cloud Run. The service is live at https://shop-api.run.app. Next I would add a domain.' }, { opener: 'All done.' }),
    'All done. I deployed shop-api to Cloud Run. The service is live at the link.',
  );
  assert.equal(a.composeDone({ text: 'Done. Fixed the failing test in `src/x.js`. Also tidied imports. And more.' }), 'Done. Fixed the failing test in src/x.js. Also tidied imports.', 'no second opener; "Done." is not one of the two sentences');
  assert.equal(a.composeDone({ text: '' }, { opener: 'Finished.' }), 'Finished.');
  assert.equal(a.composeDone({ text: 'Here is what I found:\n- one\n- two' }, { opener: 'Finished.' }), 'Finished. Here is what I found.', 'lists are for the screen');
  assert.equal(a.composeDone({ text: 'I moved PROJ-123 (https://acme.atlassian.net/browse/PROJ-123) to In Progress.' }, { opener: 'Done!' }), 'Done! I moved PROJ-123 to In Progress.');
  assert.equal(
    a.composeDone({ text: 'Version 1.2.3 is out now. The changelog is updated. The third sentence is not read.' }, { opener: 'Done!' }),
    'Done! Version 1.2.3 is out now. The changelog is updated.',
    'a dot inside a word is not a sentence end',
  );
  const long = a.composeDone({ text: `${'word '.repeat(120)}end.` }, { opener: 'Done!' });
  assert.ok(long.length <= 'Done! '.length + 220, String(long.length));
  assert.match(long, /…$/);
  const code = a.composeDone({ text: 'Run this:\n```\nrm -rf /\n```\nThat cleans up.' }, { opener: 'Done!' });
  assert.doesNotMatch(code, /rm -rf/);
  const secret = a.composeDone({ text: 'Set the key to sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 in .env.' }, { opener: 'Done!', secretLike });
  assert.doesNotMatch(secret, /abcdefghijklmnop/);
  assert.ok(a.DONE_OPENERS.length >= 3);
});

test('error: "I ran into a problem: …"', () => {
  assert.equal(a.composeError('Claude Code reported an error: Credit balance is too low. Visit the console.'), 'I ran into a problem: Credit balance is too low.');
  assert.equal(a.composeError('Claude Code stopped unexpectedly'), 'I ran into a problem: Claude Code stopped unexpectedly.');
  assert.equal(a.composeError(''), 'I ran into a problem. Have a look at the dialog.');
});

test('permission: "I need your permission to …" with the action humanized and never a long command', () => {
  const card = (summary, extra = {}) => a.composePermission({ summary, ...extra }, { secretLike });
  assert.equal(card('Run: gcloud run deploy shop-api --source . --region us-central1 --project my-proj-123 --allow-unauthenticated'), 'I need your permission to run gcloud run deploy for shop-api.');
  assert.equal(card('Run: rm -rf tmp/build'), 'I need your permission to delete the folder tmp/build.');
  assert.equal(card('Run: rm notes.txt old.txt'), 'I need your permission to delete notes.txt and 1 more.');
  assert.equal(card('Run: cd app && npm test -- --watch=false'), 'I need your permission to run npm test.');
  assert.equal(card('Run: sudo apt install ffmpeg'), 'I need your permission to run apt install as administrator.');
  assert.equal(card('Run: git push origin main --force'), 'I need your permission to run git push.');
  assert.equal(card('Run: kubectl -n prod delete pod web-1'), 'I need your permission to run kubectl delete pod for web-1.');
  assert.equal(card('Run: gcloud --project p1 compute instances create vm-1 --zone x'), 'I need your permission to run gcloud compute instances create for vm-1.');
  assert.equal(card('Run: az group delete --name rg1 --yes'), 'I need your permission to run az group delete for rg1.');
  assert.equal(card('Run: mv a.txt archive/a.txt'), 'I need your permission to move a.txt to archive/a.txt.');
  assert.equal(card('Run: FOO=1 node scripts/migrate.js'), 'I need your permission to run node scripts/migrate.js.');
  assert.equal(card('Edit /home/me/proj/src/app.js'), 'I need your permission to edit src/app.js.');
  assert.equal(card('Write ~/notes/todo.md'), 'I need your permission to write notes/todo.md.');
  assert.equal(card('Fetch https://example.com/a/b?c=d'), 'I need your permission to fetch a page from example.com.');
  assert.equal(card('Type text: "Tr0ub4dor&3xyz!"', { toolName: 'mcp__anywhere__type_text' }), 'I need your permission to type some text.');
  assert.equal(card('jira: Transition issue PROJ-12 to Done', { toolName: 'mcp__jira__transition' }), 'I need your permission to use jira to transition issue PROJ-12 to Done.');
  assert.equal(a.composePermission({}), 'I need your permission to do something.');
  // High risk: one short note from the reason.
  assert.equal(
    card('Run: gcloud run deploy shop-api --allow-unauthenticated', { risk: 'high', reason: 'Deploys or changes cloud infrastructure (gcloud run deploy shop-api); makes it publicly reachable on the internet (source folder: /home/me/shop)' }),
    'I need your permission to run gcloud run deploy for shop-api. It makes it publicly reachable on the internet.',
  );
  // Never a long command or a secret.
  const long = card(`Run: curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" https://api.example.com/v1/${'x'.repeat(300)}`);
  assert.ok(long.length < 140, long);
  assert.doesNotMatch(long, /abcdefghijklmnop|Bearer/);
  assert.equal(long, 'I need your permission to run curl on api.example.com.');
});

test('question: "Quick question: …" with up to three options', () => {
  assert.equal(a.composeQuestion({ question: 'Which region should I deploy to', options: ['us-central1', 'europe-west1'] }), 'Quick question: Which region should I deploy to? Options are us-central1 or europe-west1.');
  assert.equal(a.composeQuestion({ question: 'Deploy now?', options: ['Yes', 'No', 'Later', 'Never'] }), 'Quick question: Deploy now? Options are Yes, No, Later, or something else.');
  assert.equal(a.composeQuestion({ question: 'Which repo?', options: ['shop-api'] }), 'Quick question: Which repo? Option: shop-api.');
  assert.equal(a.composeQuestion({ question: 'Proceed?' }), 'Quick question: Proceed?');
  assert.equal(a.composeQuestion({}), 'Quick question for you. Have a look at the dialog.');
});

// ------------------------------------------------------------------ policy and delivery (fakes)

function fakeHub({ ui = 1 } = {}) {
  const hub = new EventEmitter();
  hub.ui = ui;
  hub.sent = [];
  hub.clientCount = (kind) => (kind === 'ui' ? hub.ui : hub.ui);
  hub.broadcast = (type, data) => {
    hub.sent.push({ type, data });
    hub.emit('event', type, data);
  };
  return hub;
}

function fakeVoice({ engine = 'piper' } = {}) {
  const v = {
    engine,
    synthesized: [],
    played: [],
    spoken: [],
    stopFns: new Set(),
    async engineInfo() {
      return { setting: 'auto', engine: this.engine, piper: { installed: this.engine === 'piper' }, os: { provider: 'espeak-ng' } };
    },
    async synthesize(text) {
      this.synthesized.push(text);
      return { id: crypto.createHash('md5').update(text).digest('hex'), mime: 'audio/wav', durationMs: 1234, engine: 'piper' };
    },
    async playFile(file) {
      this.played.push(file);
      return { ok: true, player: 'fake' };
    },
    async speak(text) {
      this.spoken.push(text);
      return { ok: true, provider: this.engine === 'piper' ? 'piper' : 'espeak-ng' };
    },
    onStop(fn) {
      this.stopFns.add(fn);
      return () => this.stopFns.delete(fn);
    },
    stop() {
      for (const fn of this.stopFns) fn();
    },
  };
  return v;
}

function make({ voice = {}, ui = 1, engine = 'piper', findCard = null } = {}) {
  const hub = fakeHub({ ui });
  const v = fakeVoice({ engine });
  const config = { voice: { speakResponses: true, tts: 'auto', chime: true, announce: { done: true, permission: true, question: true, error: true }, ...voice } };
  const ann = new Announcer({ config, hub, voice: v, findCard, secretLike, chimeFile: (k) => `/chimes/${k}.wav`, random: () => 0 }).start();
  return { hub, v, ann, config };
}

const announces = (hub) => hub.sent.filter((e) => e.type === 'announce').map((e) => e.data);

async function settle(ann) {
  for (let i = 0; i < 50 && (ann.running || ann.queue.length); i += 1) await tick(2);
  await tick(2);
}

test('a visible dialog gets an announce event with a Piper audio id; it plays it itself', async () => {
  const { hub, v, ann } = make();
  hub.broadcast('message', { role: 'tool', name: 'Bash' });
  hub.broadcast('result', { text: 'I deployed shop-api. It is live.', durationMs: 1500, isError: false, sessionId: 's1', commandIds: ['c1'] });
  await settle(ann);
  const [ev] = announces(hub);
  assert.ok(ev, 'announced');
  assert.equal(ev.kind, 'done');
  assert.equal(ev.text, 'All done. I deployed shop-api. It is live.');
  assert.deepEqual(ev.audio, { id: crypto.createHash('md5').update(ev.text).digest('hex'), mime: 'audio/wav', durationMs: 1234 });
  assert.equal(ev.chime, true);
  assert.match(ev.id, /^an_/);
  assert.ok(!Number.isNaN(Date.parse(ev.ts)));
  assert.deepEqual(v.spoken, [], 'the daemon did not speak as well');
  assert.deepEqual(v.played, []);
});

test('with the OS engine the dialog gets text only (audio null) and uses its own voice', async () => {
  const { hub, ann } = make({ engine: 'os', voice: { chime: false } });
  hub.broadcast('approval_request', { id: 'ap_1', summary: 'Run: npm publish', toolName: 'Bash' });
  await settle(ann);
  const [ev] = announces(hub);
  assert.deepEqual({ kind: ev.kind, text: ev.text, audio: ev.audio, chime: ev.chime }, { kind: 'permission', text: 'I need your permission to run npm publish.', audio: null, chime: false });
});

test('no visible dialog: the daemon plays the chime, then speaks; browser engine stays silent', async () => {
  const { hub, v, ann } = make({ ui: 0 });
  hub.broadcast('question', { id: 'q1', question: 'Which region?', options: ['us', 'eu'] });
  await settle(ann);
  assert.deepEqual(announces(hub), [], 'nobody to broadcast to');
  assert.deepEqual(v.played, ['/chimes/question.wav']);
  assert.deepEqual(v.spoken, ['Quick question: Which region? Options are us or eu.']);

  const b = make({ ui: 0, engine: 'browser' });
  b.hub.broadcast('question', { id: 'q2', question: 'Which region?' });
  await settle(b.ann);
  assert.deepEqual(b.v.spoken, []);
  assert.deepEqual(b.v.played, []);
  const r = await b.ann.test('hello');
  assert.equal(r.delivered, 'none');
});

test('visibility: a hidden dialog plays locally; a newly connected page counts as visible until it reports', async () => {
  const { hub, v, ann } = make({ ui: 1 });
  ann.noteVisibility({ page: 'p1', visible: false });
  assert.equal(ann.dialogVisible(), false);
  hub.broadcast('approval_request', { id: 'ap_h', summary: 'Edit src/a.js' });
  await settle(ann);
  assert.deepEqual(announces(hub), []);
  assert.deepEqual(v.spoken, ['I need your permission to edit src/a.js.']);
  ann.noteVisibility({ page: 'p1', visible: true });
  assert.equal(ann.dialogVisible(), true);
  ann.noteVisibility({ page: 'p1', visible: false });
  // The hidden page closes and a fresh one opens without reporting yet.
  hub.ui = 0;
  hub.emit('clients', 0);
  hub.ui = 1;
  hub.emit('clients', 1);
  assert.equal(ann.dialogVisible(), true, 'a page that just connected opened in front');
  // Two pages, one hidden: the other is still visible.
  hub.ui = 2;
  hub.emit('clients', 2);
  ann.noteVisibility({ page: 'p3', visible: false });
  assert.equal(ann.dialogVisible(), true);
  hub.ui = 0;
  assert.equal(ann.dialogVisible(), false, 'no page connected');
});

test('policy: quick tool-less answers, stopped turns and --no-speak replies are not announced; errors are', async () => {
  const { hub, ann } = make();
  hub.broadcast('result', { text: 'Paris.', durationMs: 900, isError: false, sessionId: 's', commandIds: ['a'] });
  hub.broadcast('result', { text: 'Stopped.', durationMs: 20000, isError: true, interrupted: true, subtype: 'error_during_execution', sessionId: 's', commandIds: ['b'] });
  hub.broadcast('result', { text: 'Terminal reply', durationMs: 20000, isError: false, speak: false, commandIds: ['c'] });
  await settle(ann);
  assert.deepEqual(announces(hub), []);
  hub.broadcast('result', { text: 'A long think without tools.', durationMs: 8000, isError: false, sessionId: 's', commandIds: ['d'] });
  hub.broadcast('result', { text: 'Credit balance is too low', durationMs: 300, isError: true, subtype: 'error_during_execution', sessionId: 's', commandIds: ['e'] });
  await settle(ann);
  const evs = announces(hub);
  assert.deepEqual(evs.map((e) => e.kind), ['done', 'error']);
  assert.equal(evs[1].text, 'I ran into a problem: Credit balance is too low.');
  // A crashed engine (status error) is announced once.
  hub.broadcast('status', { status: 'error', detail: 'Claude Code stopped unexpectedly' });
  hub.broadcast('status', { status: 'error', detail: 'Claude Code stopped unexpectedly' });
  await settle(ann);
  assert.equal(announces(hub).filter((e) => e.kind === 'error').length, 2);
  // The same card twice: once.
  hub.broadcast('approval_request', { id: 'ap_x', summary: 'Run: make deploy' });
  hub.broadcast('approval_request', { id: 'ap_x', summary: 'Run: make deploy' });
  await settle(ann);
  assert.equal(announces(hub).filter((e) => e.kind === 'permission').length, 1);
});

test('settings: speakResponses, voice.tts off and announce toggles silence what they cover', async () => {
  const off = make({ voice: { speakResponses: false } });
  off.hub.broadcast('approval_request', { id: 'p1', summary: 'Run: ls' });
  off.hub.broadcast('result', { text: 'x', durationMs: 60000, sessionId: 's', commandIds: ['1'] });
  await settle(off.ann);
  assert.deepEqual(announces(off.hub), []);
  assert.equal((await off.ann.test('sample')).delivered, 'dialog', 'an explicit test still plays');

  const ttsOff = make({ voice: { tts: 'off' } });
  ttsOff.hub.broadcast('question', { id: 'q', question: 'x?' });
  await settle(ttsOff.ann);
  assert.deepEqual(announces(ttsOff.hub), []);
  assert.equal((await ttsOff.ann.test()).ok, false);

  const some = make({ voice: { announce: { done: false, permission: true, question: false, error: true } } });
  some.hub.broadcast('message', { role: 'tool' });
  some.hub.broadcast('result', { text: 'Done thing.', durationMs: 9000, sessionId: 's', commandIds: ['1'] });
  some.hub.broadcast('question', { id: 'q', question: 'x?' });
  some.hub.broadcast('approval_request', { id: 'p', summary: 'Run: ls' });
  await settle(some.ann);
  assert.deepEqual(announces(some.hub).map((e) => e.kind), ['permission']);
});

test('queue: one at a time, answered cards are skipped, a barge-in stop drops what waits', async () => {
  const pending = new Map([['ap_1', {}], ['ap_2', {}], ['ap_3', {}]]);
  const { hub, v, ann } = make({ ui: 0, findCard: (kind, id) => (pending.has(id) ? pending.get(id) : null) });
  let release;
  const gate = new Promise((r) => (release = r));
  v.speak = async (text) => {
    v.spoken.push(text);
    if (v.spoken.length === 1) await gate;
    return { ok: true, provider: 'piper' };
  };
  hub.broadcast('approval_request', { id: 'ap_1', summary: 'Run: one' });
  hub.broadcast('approval_request', { id: 'ap_2', summary: 'Run: two' });
  hub.broadcast('approval_request', { id: 'ap_3', summary: 'Run: three' });
  await tick(5);
  assert.equal(v.spoken.length, 1, 'one at a time');
  pending.delete('ap_2'); // answered on screen meanwhile
  release();
  await settle(ann);
  assert.deepEqual(v.spoken, ['I need your permission to run one.', 'I need your permission to run three.']);

  // Barge-in: voice.stop() from the dialog drops queued announcements.
  const b = make({ ui: 0 });
  let rel2;
  const gate2 = new Promise((r) => (rel2 = r));
  b.v.speak = async (text) => {
    b.v.spoken.push(text);
    await gate2;
    return { ok: true, provider: 'piper', stopped: true };
  };
  b.hub.broadcast('question', { id: 'q1', question: 'One?' });
  b.hub.broadcast('question', { id: 'q2', question: 'Two?' });
  await tick(5);
  b.v.stop();
  rel2();
  await settle(b.ann);
  assert.deepEqual(b.v.spoken, ['Quick question: One?']);

  // stop() detaches from the hub.
  b.ann.stop();
  b.hub.broadcast('question', { id: 'q3', question: 'Three?' });
  await tick(5);
  assert.equal(b.v.spoken.length, 1);
});

test('openers vary from one announcement to the next', async () => {
  const hub = fakeHub();
  const v = fakeVoice();
  let i = 0;
  const seq = [0, 0, 0.5, 0.99];
  const ann = new Announcer({ config: { voice: {} }, hub, voice: v, random: () => seq[i++ % seq.length], chimeFile: () => '/c.wav' }).start();
  for (let k = 0; k < 4; k += 1) {
    hub.broadcast('message', { role: 'tool' });
    hub.broadcast('result', { text: `Task ${k} complete.`, durationMs: 5000, sessionId: 's', commandIds: [`c${k}`] });
  }
  await settle(ann);
  const openers = announces(hub).map((e) => e.text.split(' Task')[0]);
  assert.equal(openers.length, 4);
  for (let k = 1; k < openers.length; k += 1) assert.notEqual(openers[k], openers[k - 1], 'never the same opener twice in a row');
  for (const o of openers) assert.ok(a.DONE_OPENERS.includes(o), o);
});

// ------------------------------------------------------------------ routes: id validation

test('audio ids: only 32 hex characters or a chime name reach the file system', () => {
  const good = 'a'.repeat(32);
  assert.equal(routes.validAudioId(good), true);
  assert.equal(routes.validAudioId('chime-done'), true);
  assert.equal(routes.validAudioId('chime-permission'), true);
  for (const bad of ['../../etc/passwd', '..%2f..%2fconfig.json', `${good}.wav`, `${good}/`, 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'chime-../x', 'chime-nope', '', null, 42, `${'a'.repeat(31)}\0`]) {
    assert.equal(routes.validAudioId(bad), false, JSON.stringify(bad));
  }
  const voice = { audioFile: (id) => `/cache/${id}.wav` };
  assert.equal(routes.audioPathFor(voice, '../x'), null);
  assert.equal(routes.audioPathFor(voice, good), `/cache/${good}.wav`);
  const chime = routes.audioPathFor(voice, 'chime-error', { chimeDir: path.join(HOME, 'chimes') });
  assert.equal(path.basename(chime), 'chime-error.wav');
  assert.ok(fs.statSync(chime).size > 44);
});

// ------------------------------------------------------------------ daemon integration

const FAKE_PIPER = `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a.includes('--help')) { console.log('usage: piper --model FILE --output_file FILE'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const out = a[a.indexOf('--output_file') + 1];
  const n = 22050;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii'); b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(out, b);
});
`;

function sseClient(port, token, kind) {
  const events = [];
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/events?client=${kind}`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(frame);
          const data = /^data: (.*)$/m.exec(frame);
          if (type && data) events.push({ type: type[1], data: JSON.parse(data[1]) });
        }
      });
      resolve({ events, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await tick(25);
  }
}

test('daemon: voice routes (audio, synthesize, status, use, test) and announcements to the dialog or the speakers', { skip: process.platform === 'win32' }, async () => {
  const bin = path.join(HOME, 'fake-piper');
  fs.writeFileSync(bin, FAKE_PIPER, { mode: 0o755 });
  process.env.ANYWHERE_PIPER_PATH = bin;
  const voices = path.join(HOME, 'voice', 'piper', 'voices');
  fs.mkdirSync(voices, { recursive: true });
  fs.writeFileSync(path.join(voices, 'en_US-lessac-medium.onnx'), crypto.randomBytes(4096));
  fs.writeFileSync(path.join(voices, 'en_US-lessac-medium.onnx.json'), JSON.stringify({ audio: { sample_rate: 22050 }, espeak: { voice: 'en-us' } }));
  const main = require('../src/daemon/main');
  const d = await main.runDaemon({ project: HOME, port: 0, open: false, handleSignals: false, allowMultiple: true });
  // The speakers: a recording player instead of a real one.
  const played = [];
  d.voice.playerOverride = {
    async playFile(file) {
      played.push(file);
      return { ok: true, player: 'test' };
    },
    stop: () => false,
    async status() {
      return { available: true, players: ['test'] };
    },
  };
  const base = `http://127.0.0.1:${d.port}`;
  const auth = { Authorization: `Bearer ${d.token}` };
  const api = async (method, p, body, headers = auth) => {
    const res = await fetch(`${base}${p}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  let ui = null;
  try {
    // Status, and the snapshot flag that tells the dialog not to speak by itself.
    const st = await api('GET', '/api/voice/status');
    assert.equal(st.status, 200);
    assert.equal(st.body.engine, 'piper');
    assert.equal(st.body.piper.binaryKind, 'env');
    assert.deepEqual(st.body.piper.installedVoices, ['en_US-lessac-medium']);
    assert.equal(st.body.announcer, true);
    const snap = await waitFor(async () => {
      const s = (await api('GET', '/api/state')).body;
      return s.voice && s.voice.announcer === true && s.voice.engine === 'piper' ? s : null;
    });
    assert.ok(snap, 'snapshot.voice.announcer and engine');
    assert.deepEqual(snap.voice.piper, { installed: true, voice: 'en_US-lessac-medium' });

    // Synthesize, then fetch the WAV.
    assert.equal((await api('POST', '/api/tts/synthesize', { text: '' })).status, 400);
    assert.equal((await api('POST', '/api/tts/synthesize', { text: 'hi', voice: '../x' })).status, 400);
    const syn = await api('POST', '/api/tts/synthesize', { text: 'All done. The deploy worked.' });
    assert.equal(syn.status, 200);
    assert.match(syn.body.id, /^[a-f0-9]{32}$/);
    assert.deepEqual({ mime: syn.body.mime, engine: syn.body.engine, durationMs: syn.body.durationMs }, { mime: 'audio/wav', engine: 'piper', durationMs: 1000 });
    const wav = await api('GET', `/api/tts/audio?id=${syn.body.id}`);
    assert.equal(wav.status, 200);
    assert.equal(wav.headers.get('content-type'), 'audio/wav');
    assert.equal(wav.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(wav.body.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.body.length, 44 + 22050 * 2);
    const chimeWav = await api('GET', '/api/tts/audio?id=chime-permission');
    assert.equal(chimeWav.status, 200);
    assert.equal(chimeWav.body.toString('ascii', 8, 12), 'WAVE');
    // Traversal and malformed ids never reach the disk; unknown ones are 404; no token is 401.
    for (const bad of ['../../config.json', '..%2F..%2Fconfig.json', `${syn.body.id}.wav`, syn.body.id.toUpperCase(), '%00', '']) {
      assert.equal((await api('GET', `/api/tts/audio?id=${bad}`)).status, 400, bad);
    }
    assert.equal((await api('GET', `/api/tts/audio?id=${'0'.repeat(32)}`)).status, 404);
    assert.equal((await api('GET', `/api/tts/audio?id=${syn.body.id}`, undefined, {})).status, 401);

    // use: only installed voices.
    const notInstalled = await api('POST', '/api/voice/use', { voice: 'en_GB-alba-medium' });
    assert.equal(notInstalled.status, 409);
    assert.match(notInstalled.body.hint, /anywhere voice install --voice en_GB-alba-medium/);
    assert.equal((await api('POST', '/api/voice/use', { voice: '../../x' })).status, 400);
    assert.deepEqual((await api('POST', '/api/voice/use', { voice: 'en_US-lessac-medium' })).body, { ok: true, voice: 'en_US-lessac-medium' });

    // A visible dialog page: announcements arrive as SSE 'announce' with a Piper audio id.
    ui = await sseClient(d.port, d.token, 'ui');
    await waitFor(() => d.hub.clientCount('ui') === 1);
    const t = await api('POST', '/api/voice/test', { text: 'Testing one two.' });
    assert.deepEqual({ ok: t.body.ok, delivered: t.body.delivered, engine: t.body.engine }, { ok: true, delivered: 'dialog', engine: 'piper' });
    const testEv = await waitFor(() => ui.events.find((e) => e.type === 'announce' && e.data.kind === 'info'));
    assert.equal(testEv.data.text, 'Testing one two.');
    assert.match(testEv.data.audio.id, /^[a-f0-9]{32}$/);
    assert.equal((await api('GET', `/api/tts/audio?id=${testEv.data.audio.id}`)).status, 200, 'the page can fetch it');

    d.hub.broadcast('message', { role: 'tool', name: 'Bash' });
    d.hub.broadcast('result', { text: 'I deployed **shop-api**. It is live.', durationMs: 2000, isError: false, sessionId: 'x', commandIds: ['c1'] });
    const done = await waitFor(() => ui.events.find((e) => e.type === 'announce' && e.data.kind === 'done'));
    assert.match(done.data.text, /I deployed shop-api\. It is live\.$/);
    assert.ok(done.data.audio && done.data.audio.mime === 'audio/wav');
    assert.equal(played.length, 0, 'nothing played on the speakers while the dialog is visible');

    // The page reports itself hidden (minimized): the daemon plays through the speakers.
    assert.equal((await api('POST', '/api/ui/visibility', { page: 'page-1', visible: false, focused: false })).status, 200);
    // A real approval card (the permission broker asks before rm -rf).
    const asking = api('POST', '/api/mcp/permission', { tool_name: 'Bash', input: { command: 'rm -rf tmp/build' } });
    const card = await waitFor(() => ui.events.find((e) => e.type === 'approval_request'));
    assert.ok(card, 'the broker showed a card');
    await waitFor(() => played.length >= 2);
    assert.equal(path.basename(played[0] || ''), 'chime-permission.wav');
    assert.match(played[1] || '', /tts-cache[\\/][a-f0-9]{32}\.wav$/);
    assert.ok(!ui.events.some((e) => e.type === 'announce' && e.data.kind === 'permission'), 'not sent to the hidden page');
    assert.equal((await api('POST', '/api/approval', { id: card.data.id, decision: 'deny' })).status, 200);
    assert.equal((await asking).body.behavior, 'deny');
  } finally {
    if (ui) ui.close();
    await d.shutdown('test');
    delete process.env.ANYWHERE_PIPER_PATH;
  }
});
