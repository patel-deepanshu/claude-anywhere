'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-voice-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const {
  VoiceService,
  buildTtsCommand,
  parseWavHeader,
  languageCode,
  audioFileName,
  cleanTranscript,
  capSpeech,
  defaultRunner,
} = require('../src/daemon/voice');
const proc = require('../src/shared/proc');

const MODELS = path.join(HOME, 'models-empty');
fs.mkdirSync(MODELS, { recursive: true });

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

const OK = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: null };

function fakeRunner(behavior) {
  const calls = [];
  const runner = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve(behavior ? behavior(cmd, args, opts) : OK);
  };
  runner.calls = calls;
  return runner;
}

function wav(sampleRate = 16000, channels = 1, bits = 16, seconds = 0.05) {
  const bytesPerSample = bits / 8;
  const dataLen = Math.round(sampleRate * seconds) * channels * bytesPerSample;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  b.writeUInt16LE(channels * bytesPerSample, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataLen, 40);
  return b;
}

function service(opts = {}) {
  return new VoiceService({
    config: { voice: { language: 'en-US', ...(opts.voice || {}) } },
    env: opts.env || {},
    which: opts.which || (() => null),
    runner: opts.runner || fakeRunner(),
    fetch: opts.fetch,
    platformInfo: opts.platformInfo || { platform: 'linux', isWSL: false },
    now: opts.now,
    modelsDir: opts.modelsDir || MODELS,
  });
}

// ------------------------------------------------------------------ helpers

test('helpers', () => {
  assert.equal(languageCode('en-US'), 'en');
  assert.equal(languageCode('pt_BR'), 'pt');
  assert.equal(languageCode('de'), 'de');
  assert.equal(languageCode('auto'), '');
  assert.equal(languageCode(''), '');
  assert.equal(languageCode(undefined), '');
  assert.equal(audioFileName('audio/wav'), 'audio.wav');
  assert.equal(audioFileName('audio/x-wav'), 'audio.wav');
  assert.equal(audioFileName('audio/webm;codecs=opus'), 'audio.webm');
  assert.equal(audioFileName('audio/ogg'), 'audio.ogg');
  assert.equal(audioFileName('audio/mp4'), 'audio.m4a');
  assert.equal(audioFileName('audio/mpeg'), 'audio.mp3');
  assert.deepEqual(parseWavHeader(wav(16000, 1)), { format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 });
  assert.deepEqual(parseWavHeader(wav(44100, 2)), { format: 1, channels: 2, sampleRate: 44100, bitsPerSample: 16 });
  assert.equal(parseWavHeader(Buffer.from('not a wav file at all')), null);
  assert.equal(cleanTranscript(' [BLANK_AUDIO]\n Hello   there.\n (music) world '), 'Hello there. world');
  const long = 'Sentence one. '.repeat(200);
  const capped = capSpeech(long, 1500);
  assert.ok(capped.length <= 1500);
  assert.ok(capped.endsWith('.'));
  assert.equal(capSpeech('short'), 'short');
});

// ------------------------------------------------------------------ provider selection

test('STT provider selection from the environment and config', async () => {
  const pick = async (env, voice) => service({ env, voice }).resolveStt();
  let p = await pick({ GROQ_API_KEY: 'gsk_abc' });
  assert.equal(p.name, 'groq');
  assert.equal(p.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(p.model, 'whisper-large-v3-turbo');
  assert.equal(p.apiKey, 'gsk_abc');

  p = await pick({ OPENAI_API_KEY: 'sk-abc' });
  assert.equal(p.name, 'openai');
  assert.equal(p.baseUrl, 'https://api.openai.com/v1');
  assert.equal(p.model, 'gpt-4o-mini-transcribe');

  assert.equal((await pick({ OPENAI_API_KEY: 'sk-a', GROQ_API_KEY: 'gsk_b' })).name, 'groq');
  assert.equal((await pick({ ANYWHERE_STT_API_KEY: 'gsk_x', OPENAI_API_KEY: 'sk-a' })).name, 'groq');
  assert.equal((await pick({ ANYWHERE_STT_API_KEY: 'sk-x' })).name, 'openai');
  p = await pick({ ANYWHERE_STT_API_KEY: 'k', ANYWHERE_STT_BASE_URL: 'http://localhost:9000/v1' });
  assert.equal(p.name, 'custom');
  assert.equal(p.baseUrl, 'http://localhost:9000/v1');

  p = await pick({ GROQ_API_KEY: 'gsk_env' }, { sttApiKey: 'key1', sttBaseUrl: 'http://stt.local/v1', sttModel: 'my-model' });
  assert.deepEqual([p.name, p.apiKey, p.baseUrl, p.model], ['custom', 'key1', 'http://stt.local/v1', 'my-model']);
  assert.equal((await pick({}, { sttBaseUrl: 'http://local/v1' })).name, 'custom');
  assert.equal((await pick({}, { sttApiKey: 'gsk_cfg' })).name, 'groq');

  p = await pick({}, { sttProvider: 'openai' });
  assert.equal(p.name, null);
  assert.match(p.hint, /OPENAI_API_KEY/);
  assert.equal((await pick({ OPENAI_API_KEY: 'sk-1', GROQ_API_KEY: 'gsk_1' }, { sttProvider: 'openai' })).name, 'openai');
  assert.equal((await pick({}, { sttProvider: 'custom' })).name, null);
  assert.equal((await pick({}, { sttProvider: 'whisper.cpp' })).name, null);

  p = await pick({});
  assert.equal(p.name, null);
  assert.match(p.hint, /GROQ_API_KEY/);
});

test('capabilities are cached for 30 s and never expose keys', async () => {
  let t = 1000;
  const env = {};
  const svc = service({ env, now: () => t, which: (n) => (n === 'espeak-ng' ? '/usr/bin/espeak-ng' : null) });
  let caps = await svc.capabilities();
  assert.deepEqual(
    { serverStt: caps.serverStt, sttProvider: caps.sttProvider, serverTts: caps.serverTts, ttsProvider: caps.ttsProvider },
    { serverStt: false, sttProvider: null, serverTts: true, ttsProvider: 'espeak-ng' },
  );
  assert.ok(caps.sttHint);
  env.GROQ_API_KEY = 'gsk_supersecretvalue123';
  t += 10000;
  assert.equal((await svc.capabilities()).serverStt, false, 'still cached');
  t += 21000;
  caps = await svc.capabilities();
  assert.equal(caps.serverStt, true);
  assert.equal(caps.sttProvider, 'groq');
  assert.doesNotMatch(JSON.stringify(caps), /supersecret/);
  // updateConfig clears the cache
  svc.updateConfig({ voice: { sttProvider: 'openai' } });
  assert.equal((await svc.capabilities()).serverStt, false);
});

test('TTS provider per platform', () => {
  const which = (map) => (n) => map[n] || null;
  assert.equal(service({ platformInfo: { platform: 'darwin' }, which: which({ say: '/usr/bin/say' }) }).resolveTts().name, 'say');
  assert.equal(service({ platformInfo: { platform: 'win32' }, which: which({ powershell: 'C:\\ps.exe' }) }).resolveTts().name, 'sapi');
  const wsl = service({
    platformInfo: { platform: 'linux', isWSL: true },
    which: which({ 'powershell.exe': '/mnt/c/ps.exe', 'espeak-ng': '/usr/bin/espeak-ng' }),
  }).resolveTts();
  assert.deepEqual(wsl, { name: 'sapi', bin: '/mnt/c/ps.exe' });
  assert.equal(
    service({ which: which({ 'spd-say': '/usr/bin/spd-say', 'espeak-ng': '/usr/bin/espeak-ng' }) }).resolveTts().name,
    'spd-say',
  );
  assert.equal(service({ which: which({ espeak: '/usr/bin/espeak' }) }).resolveTts().name, 'espeak');
  assert.equal(service({ which: which({ festival: '/usr/bin/festival' }) }).resolveTts().name, 'festival');
  const none = service({}).resolveTts();
  assert.equal(none.name, null);
  assert.match(none.hint, /espeak-ng/);
});

// ------------------------------------------------------------------ HTTP transcription

async function startFakeStt(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const entry = { method: req.method, url: req.url, headers: req.headers, body };
    seen.push(entry);
    await handler(req, res, entry);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { seen, base: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

async function parseMultipart(entry) {
  return new Response(entry.body, { headers: { 'content-type': entry.headers['content-type'] } }).formData();
}

test('transcribe: OpenAI-compatible multipart request', async () => {
  const srv = await startFakeStt((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: '  deploy this repo to cloud run  ' }));
  });
  try {
    const svc = service({
      voice: { sttProvider: 'custom', sttBaseUrl: `${srv.base}/`, sttApiKey: 'test-key-123', sttModel: 'whisper-1', language: 'en-US' },
    });
    const audio = wav(16000, 1);
    const out = await svc.transcribe(audio, { contentType: 'audio/wav' });
    assert.deepEqual(out, { text: 'deploy this repo to cloud run', provider: 'custom' });
    const [req] = srv.seen;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/audio/transcriptions');
    assert.equal(req.headers.authorization, 'Bearer test-key-123');
    assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
    const form = await parseMultipart(req);
    assert.equal(form.get('model'), 'whisper-1');
    assert.equal(form.get('language'), 'en');
    assert.equal(form.get('response_format'), 'json');
    const file = form.get('file');
    assert.equal(file.name, 'audio.wav');
    assert.equal(file.type, 'audio/wav');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio);

    // webm, explicit language, plain-text response, no key
    const svc2 = service({ voice: { sttBaseUrl: srv.base, language: 'auto' } });
    const out2 = await svc2.transcribe(Buffer.from('webm-bytes'), { contentType: 'audio/webm;codecs=opus', language: 'de-DE' });
    assert.equal(out2.provider, 'custom');
    const form2 = await parseMultipart(srv.seen[1]);
    assert.equal(form2.get('file').name, 'audio.webm');
    assert.equal(form2.get('language'), 'de');
    assert.equal(srv.seen[1].headers.authorization, undefined);
    // auto language → no language field
    await svc2.transcribe(Buffer.from('x'), { contentType: 'audio/ogg' });
    const form3 = await parseMultipart(srv.seen[2]);
    assert.equal(form3.get('language'), null);
    assert.equal(form3.get('file').name, 'audio.ogg');
  } finally {
    await srv.close();
  }
});

test('transcribe: HTTP errors carry the status, a body snippet and a hint', async () => {
  const srv = await startFakeStt((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwx' } }));
  });
  try {
    const svc = service({ voice: { sttProvider: 'openai', sttBaseUrl: srv.base, sttApiKey: 'sk-bad' } });
    await assert.rejects(svc.transcribe(wav(), {}), (err) => {
      assert.match(err.message, /HTTP 401/);
      assert.match(err.message, /Incorrect API key/);
      assert.doesNotMatch(err.message, /abcdefghijklmnopqrstuvwx/, 'secrets in the body are redacted');
      assert.equal(err.status, 502);
      assert.equal(err.upstreamStatus, 401);
      assert.match(err.hint, /API key/);
      return true;
    });
  } finally {
    await srv.close();
  }
});

test('transcribe: timeout, unreachable server, empty audio, no provider', async () => {
  const srv = await startFakeStt(() => {
    /* never answer */
  });
  try {
    const svc = service({ voice: { sttBaseUrl: srv.base } });
    svc.sttTimeoutMs = 150;
    await assert.rejects(svc.transcribe(wav()), (err) => err.status === 504 && /did not answer/.test(err.message));
  } finally {
    srv.close();
  }
  const dead = service({ voice: { sttBaseUrl: 'http://127.0.0.1:1/v1' } });
  await assert.rejects(dead.transcribe(wav()), (err) => err.status === 502 && /Could not reach/.test(err.message));
  await assert.rejects(dead.transcribe(Buffer.alloc(0)), (err) => err.status === 400);
  await assert.rejects(service({}).transcribe(wav()), (err) => err.status === 503 && /GROQ_API_KEY/.test(err.hint));
  // injected fetch
  let called = null;
  const svc = service({
    env: { GROQ_API_KEY: 'gsk_x' },
    fetch: async (url, init) => {
      called = { url, init };
      return new Response(JSON.stringify({ text: 'hi' }), { status: 200 });
    },
  });
  assert.deepEqual(await svc.transcribe(new Uint8Array([1, 2, 3])), { text: 'hi', provider: 'groq' });
  assert.equal(called.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(called.init.headers.Authorization, 'Bearer gsk_x');
});

// ------------------------------------------------------------------ whisper.cpp

function makeFakeWhisper(dir, name = 'whisper-cli', { helpText = 'usage: whisper-cli [options]\n  -nt, --no-timestamps\n' } = {}) {
  const file = path.join(dir, name);
  const script = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { process.stderr.write(${JSON.stringify(helpText)}); process.exit(0); }
const f = args[args.indexOf('-f') + 1];
const b = fs.readFileSync(f);
const info = { rate: b.readUInt32LE(24), channels: b.readUInt16LE(22) };
fs.writeFileSync(__filename + '.json', JSON.stringify({ args, info }));
process.stdout.write('\\n [BLANK_AUDIO]\\n Hello from whisper.\\n How are you?\\n');
`;
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

test('whisper.cpp: detection, 16 kHz WAV and output cleanup', async (t) => {
  if (process.platform === 'win32') return t.skip('the fake whisper binary is a shebang script');
  const dir = fs.mkdtempSync(path.join(HOME, 'whisper-'));
  const models = path.join(dir, 'models');
  fs.mkdirSync(models);
  fs.writeFileSync(path.join(models, 'ggml-tiny.en.bin'), '');
  fs.writeFileSync(path.join(models, 'ggml-base.bin'), '');
  fs.writeFileSync(path.join(models, 'notes.txt'), '');
  const bin = makeFakeWhisper(dir);
  const svc = new VoiceService({
    config: { voice: { language: 'en-US' } },
    env: {},
    which: (n) => (n === 'whisper-cli' ? bin : null),
    modelsDir: models,
    platformInfo: { platform: 'linux' },
  });
  const p = await svc.resolveStt();
  assert.deepEqual(p, { name: 'whisper.cpp', kind: 'whisper', bin, model: path.join(models, 'ggml-base.bin') });
  const caps = await svc.capabilities();
  assert.equal(caps.sttProvider, 'whisper.cpp');

  const out = await svc.transcribe(wav(16000, 1), { contentType: 'audio/wav' });
  assert.deepEqual(out, { text: 'Hello from whisper. How are you?', provider: 'whisper.cpp' });
  const record = JSON.parse(fs.readFileSync(`${bin}.json`, 'utf8'));
  assert.deepEqual(record.args.slice(0, 2), ['-m', path.join(models, 'ggml-base.bin')]);
  assert.equal(record.args[2], '-f');
  assert.deepEqual(record.args.slice(4), ['-nt', '-np', '-l', 'en']);
  assert.deepEqual(record.info, { rate: 16000, channels: 1 });

  // explicit model + language auto
  const svc2 = new VoiceService({
    config: { voice: { language: '', sttProvider: 'whisper.cpp', whisperCppPath: bin, whisperModel: 'ggml-tiny.en.bin' } },
    env: { GROQ_API_KEY: 'gsk_ignored' },
    which: () => null,
    modelsDir: models,
    platformInfo: { platform: 'linux' },
  });
  await svc2.transcribe(wav(16000, 1));
  const record2 = JSON.parse(fs.readFileSync(`${bin}.json`, 'utf8'));
  assert.equal(record2.args[1], path.join(models, 'ggml-tiny.en.bin'));
  assert.deepEqual(record2.args.slice(-2), ['-l', 'auto']);

  // a missing model gives a hint
  const svc3 = new VoiceService({
    config: { voice: { sttProvider: 'whisper.cpp', whisperCppPath: bin } },
    env: {},
    which: () => null,
    modelsDir: path.join(dir, 'none'),
    platformInfo: { platform: 'linux' },
  });
  const p3 = await svc3.resolveStt();
  assert.equal(p3.name, null);
  assert.match(p3.hint, /ggml/);
});

test('whisper.cpp: generic binary names are verified, non-16 kHz audio needs ffmpeg', async (t) => {
  if (process.platform === 'win32') return t.skip('the fake whisper binary is a shebang script');
  const dir = fs.mkdtempSync(path.join(HOME, 'whisper2-'));
  const models = path.join(dir, 'models');
  fs.mkdirSync(models);
  fs.writeFileSync(path.join(models, 'ggml-base.en.bin'), '');
  const notWhisper = makeFakeWhisper(dir, 'main', { helpText: 'usage: main [--port N]\n' });
  const svcA = new VoiceService({
    config: { voice: {} },
    env: {},
    which: (n) => (n === 'main' ? notWhisper : null),
    modelsDir: models,
    platformInfo: { platform: 'linux' },
  });
  assert.equal((await svcA.resolveStt()).name, null, 'a random "main" binary is not whisper.cpp');
  const realMain = makeFakeWhisper(fs.mkdtempSync(path.join(HOME, 'whisper3-')), 'main');
  const svcB = new VoiceService({
    config: { voice: {} },
    env: {},
    which: (n) => (n === 'main' ? realMain : null),
    modelsDir: models,
    platformInfo: { platform: 'linux' },
  });
  assert.equal((await svcB.resolveStt()).name, 'whisper.cpp');

  // 44.1 kHz stereo without ffmpeg → actionable error
  const noFfmpeg = new VoiceService({
    config: { voice: {} },
    env: {},
    which: (n) => (n === 'whisper-cli' ? realMain : null),
    modelsDir: models,
    platformInfo: { platform: 'linux' },
  });
  await assert.rejects(
    noFfmpeg.transcribe(wav(44100, 2)),
    (err) => err.status === 415 && /16 kHz/.test(err.message) && /ffmpeg/.test(err.hint),
  );
  await assert.rejects(noFfmpeg.transcribe(Buffer.from('webm'), { contentType: 'audio/webm' }), (err) => err.status === 415);

  const ffmpeg = proc.which('ffmpeg');
  if (!ffmpeg) return t.skip('ffmpeg is not installed');
  const withFfmpeg = new VoiceService({
    config: { voice: { language: 'fr-FR' } },
    env: {},
    which: (n) => (n === 'whisper-cli' ? realMain : n === 'ffmpeg' ? ffmpeg : null),
    modelsDir: models,
    platformInfo: { platform: 'linux' },
  });
  const out = await withFfmpeg.transcribe(wav(44100, 2, 16, 0.2), { contentType: 'audio/wav' });
  assert.equal(out.text, 'Hello from whisper. How are you?');
  const record = JSON.parse(fs.readFileSync(`${realMain}.json`, 'utf8'));
  assert.deepEqual(record.info, { rate: 16000, channels: 1 }, 'converted to 16 kHz mono');
  assert.deepEqual(record.args.slice(-2), ['-l', 'fr']);
});

test('whisper.cpp: failures are reported with stderr', async () => {
  const runner = fakeRunner((cmd, args) => (args.includes('--help') ? OK : { ...OK, code: 3, stderr: 'error: failed to load model' }));
  const dir = fs.mkdtempSync(path.join(HOME, 'whisper4-'));
  fs.writeFileSync(path.join(dir, 'ggml-x.bin'), '');
  const svc = new VoiceService({
    config: { voice: {} },
    env: {},
    runner,
    which: (n) => (n === 'whisper-cli' ? '/fake/whisper-cli' : null),
    modelsDir: dir,
    platformInfo: { platform: 'linux' },
  });
  await assert.rejects(svc.transcribe(wav(16000, 1)), (err) => /exit 3/.test(err.message) && /failed to load model/.test(err.message));
  const last = runner.calls[runner.calls.length - 1];
  assert.equal(last.cmd, '/fake/whisper-cli');
});

// ------------------------------------------------------------------ TTS

test('TTS command construction per platform (injected runner)', async () => {
  const text = '## Done\n**Deployed** `api` to [Cloud Run](https://x.run.app).';
  const spoken = 'Done\nDeployed api to Cloud Run.'.replace(/\s+/g, ' ');

  // macOS
  let runner = fakeRunner();
  let svc = service({
    runner,
    platformInfo: { platform: 'darwin' },
    which: (n) => (n === 'say' ? '/usr/bin/say' : null),
    voice: { ttsRate: 1.5, ttsVoice: 'Samantha' },
  });
  assert.deepEqual(await svc.speak(text), { ok: true, provider: 'say' });
  assert.equal(runner.calls[0].cmd, '/usr/bin/say');
  assert.deepEqual(runner.calls[0].args, ['-r', '270', '-v', 'Samantha']);
  assert.equal(runner.calls[0].opts.input, spoken);
  await svc.speak('hi', { rate: 1, voice: 'Alex' });
  assert.deepEqual(runner.calls[1].args, ['-r', '180', '-v', 'Alex']);

  // Windows: System.Speech via Windows PowerShell, text on stdin
  runner = fakeRunner();
  svc = service({
    runner,
    platformInfo: { platform: 'win32' },
    which: (n) => (n === 'powershell' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : null),
    voice: { ttsRate: 1.5, ttsVoice: "Microsoft Zira's" },
  });
  assert.equal((await svc.speak('héllo wörld 日本')).provider, 'sapi');
  const call = runner.calls[0];
  assert.match(call.cmd, /powershell\.exe$/);
  assert.deepEqual(call.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  const script = Buffer.from(call.args[5], 'base64').toString('utf16le');
  assert.match(script, /System\.Speech/);
  assert.match(script, /\$s\.Rate = 4/);
  assert.match(script, /SelectVoice\('Microsoft Zira''s'\)/);
  assert.match(script, /OpenStandardInput/);
  assert.equal(call.opts.input, 'héllo wörld 日本');

  // WSL uses powershell.exe the same way
  runner = fakeRunner();
  svc = service({
    runner,
    platformInfo: { platform: 'linux', isWSL: true },
    which: (n) => (n === 'powershell.exe' ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : null),
  });
  assert.equal((await svc.speak('hello')).provider, 'sapi');
  assert.equal(runner.calls[0].args[4], '-EncodedCommand');
  assert.match(Buffer.from(runner.calls[0].args[5], 'base64').toString('utf16le'), /\$s\.Rate = 0/);

  // Linux: spd-say
  runner = fakeRunner();
  svc = service({
    runner,
    which: (n) => ({ 'spd-say': '/usr/bin/spd-say', 'espeak-ng': '/usr/bin/espeak-ng' })[n] || null,
    voice: { ttsRate: 1.5, language: 'en-US' },
  });
  await svc.speak('-dash first');
  assert.deepEqual(runner.calls[0].args, ['-w', '-r', '50', '-l', 'en', '--', '-dash first']);

  // Linux: espeak-ng reads stdin
  runner = fakeRunner();
  svc = service({ runner, which: (n) => (n === 'espeak-ng' ? '/usr/bin/espeak-ng' : null), voice: { ttsRate: 1.5, language: 'de-DE' } });
  await svc.speak('Hallo Welt');
  assert.deepEqual(runner.calls[0].args, ['-s', '263', '-v', 'de', '--stdin']);
  assert.equal(runner.calls[0].opts.input, 'Hallo Welt');

  // festival
  runner = fakeRunner();
  svc = service({ runner, which: (n) => (n === 'festival' ? '/usr/bin/festival' : null) });
  await svc.speak('hello');
  assert.deepEqual(runner.calls[0].args, ['--tts']);

  // rate mapping helper
  assert.deepEqual(buildTtsCommand({ name: 'espeak', bin: 'espeak' }, 'x', { rate: 0.5 }).args, ['-s', '88', '--stdin']);
  assert.match(
    Buffer.from(buildTtsCommand({ name: 'sapi', bin: 'ps' }, 'x', { rate: 100 }).args[5], 'base64').toString('utf16le'),
    /Rate = 10/,
  );
});

test('speak sanitizes markdown and caps at 1500 characters', async () => {
  const runner = fakeRunner();
  const svc = service({ runner, which: (n) => (n === 'espeak-ng' ? '/usr/bin/espeak-ng' : null) });
  await svc.speak(`# Title\n\n${'Word and more words. '.repeat(400)}\n\`\`\`js\nconsole.log(1)\n\`\`\``);
  const input = runner.calls[0].opts.input;
  assert.ok(input.length <= 1500, `${input.length}`);
  assert.doesNotMatch(input, /#|console\.log/);
  assert.deepEqual(await svc.speak('```\ncode only\n```'), { ok: true, provider: 'espeak-ng' });
  assert.deepEqual(await svc.speak('   '), { ok: false, provider: null, error: 'Nothing to speak' });
  const off = service({ runner, voice: { tts: 'off' }, which: () => '/x' });
  assert.equal((await off.speak('hello')).ok, false);
});

test('stop() kills the utterance; a new utterance replaces the old one', async () => {
  const waitForAbort = (cmd, args, opts) =>
    new Promise((resolve) => {
      if (!opts.signal) return resolve(OK);
      opts.signal.addEventListener('abort', () => resolve({ ...OK, code: null, signal: 'SIGTERM', aborted: true }));
    });
  const runner = fakeRunner(waitForAbort);
  const svc = service({ runner, which: (n) => (n === 'spd-say' ? '/usr/bin/spd-say' : null) });
  const p = svc.speak('a long announcement');
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.stop(), true);
  assert.deepEqual(await p, { ok: true, provider: 'spd-say', stopped: true });
  assert.deepEqual(runner.calls[1].args, ['-C'], 'speech-dispatcher queue is cancelled');
  assert.equal(svc.stop(), false, 'nothing left to stop');

  const runner2 = fakeRunner(waitForAbort);
  const svc2 = service({ runner: runner2, which: (n) => (n === 'espeak-ng' ? '/usr/bin/espeak-ng' : null) });
  const first = svc2.speak('first');
  await new Promise((r) => setImmediate(r));
  const second = svc2.speak('second');
  assert.equal((await first).stopped, true);
  await new Promise((r) => setImmediate(r));
  svc2.stop();
  assert.equal((await second).stopped, true);
});

test('WSL: the SAPI script prints its Windows PID and stop() taskkills it (WINDOWS-5)', async () => {
  // The script must announce $PID so the stopper can reach the real Windows process.
  const sapiArgs = buildTtsCommand({ name: 'sapi', bin: 'ps' }, 'hi', {}).args;
  const sapiScript = Buffer.from(sapiArgs[5], 'base64').toString('utf16le');
  assert.match(sapiScript, /ANYWHERE_PID ' \+ \$PID/);

  const waitForAbort = (cmd, args, opts) =>
    new Promise((resolve) => {
      if (opts.onStdout) opts.onStdout(Buffer.from('ANYWHERE_PID 4321\r\n'));
      if (!opts.signal) return resolve(OK);
      opts.signal.addEventListener('abort', () => resolve({ ...OK, code: null, signal: 'SIGTERM', aborted: true }));
    });
  const runner = fakeRunner(waitForAbort);
  const svc = service({
    runner,
    platformInfo: { platform: 'linux', isWSL: true },
    which: (n) => ({ 'powershell.exe': '/mnt/c/ps.exe', 'taskkill.exe': '/mnt/c/taskkill.exe' })[n] || null,
  });
  const p = svc.speak('a long WSL announcement that is still being read aloud');
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.stop(), true);
  assert.deepEqual(await p, { ok: true, provider: 'sapi', stopped: true });
  const kill = runner.calls.find((c) => c.cmd === '/mnt/c/taskkill.exe');
  assert.ok(kill, 'taskkill.exe was invoked on stop');
  assert.deepEqual(kill.args, ['/PID', '4321', '/T', '/F']);

  // Native Windows: SIGTERM reaches powershell.exe directly, so no taskkill.
  const winRunner = fakeRunner(waitForAbort);
  const winSvc = service({
    runner: winRunner,
    platformInfo: { platform: 'win32', isWSL: false },
    which: (n) => (n === 'powershell' ? 'C:\\ps.exe' : null),
  });
  const wp = winSvc.speak('windows announcement');
  await new Promise((r) => setImmediate(r));
  winSvc.stop();
  assert.equal((await wp).stopped, true);
  assert.ok(!winRunner.calls.some((c) => /taskkill/i.test(c.cmd)), 'native Windows does not taskkill');
});

test('speak errors are actionable', async () => {
  await assert.rejects(service({}).speak('hello'), (err) => err.status === 503 && /espeak-ng/.test(err.hint));
  const enoent = Object.assign(new Error('spawn espeak-ng ENOENT'), { code: 'ENOENT' });
  const svc = service({
    runner: fakeRunner(() => ({ ...OK, code: null, error: enoent })),
    which: (n) => (n === 'espeak-ng' ? '/usr/bin/espeak-ng' : null),
  });
  await assert.rejects(svc.speak('hello'), (err) => /Could not run espeak-ng/.test(err.message) && /apt install/.test(err.hint));
  const failing = service({
    runner: fakeRunner(() => ({ ...OK, code: 1, stderr: 'audio device busy' })),
    which: (n) => (n === 'espeak-ng' ? '/usr/bin/espeak-ng' : null),
  });
  await assert.rejects(failing.speak('hello'), /audio device busy/);
});

test('defaultRunner: output, input, abort and missing commands', async () => {
  const echo = await defaultRunner(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'héllo', timeoutMs: 10000 });
  assert.equal(echo.code, 0);
  assert.equal(echo.stdout, 'héllo');
  const ac = new AbortController();
  const p = defaultRunner(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { signal: ac.signal, timeoutMs: 30000 });
  setTimeout(() => ac.abort(), 50);
  const aborted = await p;
  assert.equal(aborted.aborted, true);
  const slow = await defaultRunner(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 100 });
  assert.equal(slow.timedOut, true);
});

test('a SAPI failure reports the PowerShell error text, not CLIXML', async () => {
  // Windows PowerShell 5.1 writes -EncodedCommand errors as CLIXML; this one came from the
  // windows-latest runner, which has no audio device. The tail used to keep only closing tags.
  const clixml =
    '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
    '<S S="Error">Exception calling "Speak" with "1" argument(s): "Audio device error encountered. - Error Code: 0x2"_x000D__x000A_</S>' +
    '<S S="Error">    + FullyQualifiedErrorId : AudioException_x000D__x000A_</S><S S="Error"> _x000D__x000A_</S></Objs>';
  const runner = fakeRunner(() => ({ ...OK, code: 1, stderr: clixml }));
  const svc = service({
    runner,
    platformInfo: { platform: 'win32' },
    which: (n) => (n === 'powershell' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : null),
  });
  await assert.rejects(svc.speak('hello'), (err) => {
    assert.match(err.message, /^sapi failed \(exit 1\): Exception calling "Speak".*Audio device error.*AudioException$/);
    assert.doesNotMatch(err.message, /CLIXML|<\/S>|_x000D_/);
    return true;
  });
  const missing = await defaultRunner('definitely-not-a-command-xyz', []);
  assert.ok(missing.error);
  assert.equal(missing.error.code, 'ENOENT');
});
