'use strict';

/**
 * Piper: catalog, URLs, downloads (redirects, resume, proxies, HTTPS), install (release binary,
 * Hugging Face voice, GitHub fallback, Python venv fallback), synthesis, the TTS cache, the
 * VoiceService engine choice, and a daemon install over HTTP + SSE. Everything runs against
 * local fake servers and fake binaries (node scripts); nothing touches the network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-piper-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;
delete process.env.ANYWHERE_PIPER_PATH;
for (const k of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];

const piper = require('../src/daemon/piper');
const { VoiceService } = require('../src/daemon/voice');

const NO_EXEC = process.platform === 'win32'; // fake binaries are shebang scripts
const SCRIPTS = fs.mkdtempSync(path.join(HOME, 'scripts-'));

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ------------------------------------------------------------------ fakes

/** A fake piper: `--help` prints usage; otherwise reads stdin and writes a WAV to --output_file. */
const FAKE_PIPER_SRC = `
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  if (process.env.FAKE_PIPER_BROKEN || fs.existsSync(__filename + '.broken')) {
    process.stderr.write('./piper: error while loading shared libraries: libonnxruntime.so.1.14.1');
    process.exit(127);
  }
  process.stdout.write('usage: piper [options]\\n  -m FILE --model FILE\\n  -f FILE --output_file FILE\\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const get = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  if (process.env.FAKE_PIPER_LOG) fs.appendFileSync(process.env.FAKE_PIPER_LOG, JSON.stringify({ args, input, cwd: process.cwd() }) + '\\n');
  if (process.env.FAKE_PIPER_FAIL || fs.existsSync(__filename + '.broken')) { process.stderr.write('boom: the model is corrupt'); process.exit(2); }
  if (process.env.FAKE_PIPER_SLEEP) { setTimeout(() => {}, 60000); return; }
  const rate = 22050;
  const n = Math.round(rate * Math.max(0.5, input.trim().length * 0.05));
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(get('--output_file'), b);
  process.stdout.write(get('--output_file') + '\\n');
});
`;

function writeScript(file, src) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\n${src}`, { mode: 0o755 });
  return file;
}

function makeFakePiper(file) {
  return writeScript(file, FAKE_PIPER_SRC);
}

/** A fake python for the venv fallback: -c prints a version, -m venv makes a venv, -m pip installs the fake piper. */
function makeFakePython(file) {
  return writeScript(
    file,
    `
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
if (a[0] === '-c') { process.stdout.write('3.12\\n'); process.exit(0); }
if (a[0] === '-m' && a[1] === 'venv') {
  fs.mkdirSync(path.join(a[2], 'bin'), { recursive: true });
  fs.copyFileSync(__filename, path.join(a[2], 'bin', 'python'));
  fs.chmodSync(path.join(a[2], 'bin', 'python'), 0o755);
  process.exit(0);
}
if (a[0] === '-m' && a[1] === 'pip') {
  const venv = path.dirname(path.dirname(__filename));
  process.stdout.write('Collecting piper-tts\\nDownloading piper_tts-1.8.0.whl (34 MB)\\nSuccessfully installed piper-tts-1.8.0\\n');
  fs.writeFileSync(path.join(venv, 'bin', 'piper'), fs.readFileSync(process.env.FAKE_PIPER_SRC_FILE));
  fs.chmodSync(path.join(venv, 'bin', 'piper'), 0o755);
  process.exit(0);
}
process.exit(1);
`,
  );
}

const MODEL = crypto.randomBytes(1100 * 1024);
const CONFIG = JSON.stringify({ audio: { sample_rate: 22050 }, espeak: { voice: 'en-us' }, phoneme_id_map: { _: [0] } });

function tarGz(dir, name, out) {
  const r = spawnSync('tar', ['-czf', out, '-C', dir, name]);
  assert.equal(r.status, 0, String(r.stderr));
  return fs.readFileSync(out);
}

/** The release archive: piper/piper (+ a 1.1 MB library so the size check passes). */
function releaseArchive({ broken = false } = {}) {
  const stage = fs.mkdtempSync(path.join(HOME, 'stage-'));
  const bin = makeFakePiper(path.join(stage, 'piper', 'piper'));
  if (broken) fs.writeFileSync(`${bin}.broken`, '1');
  fs.writeFileSync(path.join(stage, 'piper', 'libonnxruntime.so.1.14.1'), crypto.randomBytes(1100 * 1024));
  fs.mkdirSync(path.join(stage, 'piper', 'espeak-ng-data'));
  fs.writeFileSync(path.join(stage, 'piper', 'espeak-ng-data', 'phontab'), 'x');
  return tarGz(stage, 'piper', path.join(stage, 'rel.tar.gz'));
}

/** The GitHub v0.0.2 voice archive: en-us-lessac-medium.onnx(.json) + MODEL_CARD. */
function legacyVoiceArchive() {
  const stage = fs.mkdtempSync(path.join(HOME, 'legacy-'));
  const dir = path.join(stage, 'v');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'en-us-lessac-medium.onnx'), MODEL);
  fs.writeFileSync(path.join(dir, 'en-us-lessac-medium.onnx.json'), CONFIG);
  fs.writeFileSync(path.join(dir, 'MODEL_CARD'), 'lessac');
  const r = spawnSync('tar', ['-czf', path.join(stage, 'v.tar.gz'), '-C', dir, '.']);
  assert.equal(r.status, 0, String(r.stderr));
  return fs.readFileSync(path.join(stage, 'v.tar.gz'));
}

/**
 * A local file server. routes: path → Buffer | {status, body, headers, redirect, truncateAt}.
 * Honors Range requests on Buffers.
 */
function serve(routes, { tlsOpts } = {}) {
  const requests = [];
  const handler = (req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push({ path: u.pathname, range: req.headers.range || null, headers: req.headers });
    let r = typeof routes === 'function' ? routes(u.pathname, req) : routes[u.pathname];
    if (r === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (Buffer.isBuffer(r) || typeof r === 'string') r = { body: Buffer.from(r) };
    if (r.redirect) {
      res.writeHead(r.status || 302, { Location: r.redirect });
      res.end();
      return;
    }
    if (r.status && r.status >= 400) {
      res.writeHead(r.status, { 'Content-Type': 'text/plain' });
      res.end(r.body || 'error');
      return;
    }
    let body = r.body;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (m && !r.noRange) {
      const start = Number(m[1]);
      if (start >= body.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
        res.end();
        return;
      }
      res.writeHead(206, { 'Content-Length': body.length - start, 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, ...(r.headers || {}) });
      res.end(body.subarray(start));
      return;
    }
    res.writeHead(200, { 'Content-Length': body.length, ...(r.headers || {}) });
    if (r.truncateAt != null) {
      res.write(body.subarray(0, r.truncateAt));
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.end(body);
  };
  const server = tlsOpts ? https.createServer(tlsOpts, handler) : http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `${tlsOpts ? 'https' : 'http'}://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((r) => {
            if (server.closeAllConnections) server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

function hfRoutes(prefix = '/hf') {
  return {
    [`${prefix}/en/en_US/lessac/medium/en_US-lessac-medium.onnx`]: MODEL,
    [`${prefix}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json`]: CONFIG,
    [`${prefix}/en/en_GB/alba/medium/en_GB-alba-medium.onnx`]: MODEL,
    [`${prefix}/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json`]: CONFIG,
  };
}

function manager(over = {}) {
  const root = fs.mkdtempSync(path.join(HOME, 'piper-'));
  return new piper.PiperManager({
    root: path.join(root, 'piper'),
    env: { PATH: process.env.PATH, ...(over.env || {}) },
    platformInfo: { platform: 'linux', isWSL: false },
    arch: 'x64',
    which: over.which || ((n) => (n === 'tar' ? 'tar' : null)),
    ...over,
    ...(over.env ? { env: { PATH: process.env.PATH, ...over.env } } : {}),
  });
}

function wavOk(file) {
  const info = piper.wavFileInfo(file);
  assert.ok(info, `${file} is a WAV`);
  assert.ok(info.durationMs > 0);
  return info;
}

// ------------------------------------------------------------------ catalog and helpers

test('catalog: unique valid ids with the fields the UI shows, and the required voices', () => {
  const ids = piper.CATALOG.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const v of piper.CATALOG) {
    assert.ok(piper.parseVoiceId(v.id), v.id);
    for (const k of ['name', 'language', 'gender', 'quality', 'sampleText', 'description']) assert.ok(typeof v[k] === 'string' && v[k], `${v.id}.${k}`);
    assert.ok(Number.isFinite(v.sizeMb) && v.sizeMb > 10 && v.sizeMb < 200, `${v.id}.sizeMb`);
    assert.equal(v.quality, piper.parseVoiceId(v.id).quality);
  }
  for (const want of [
    'en_US-lessac-medium', 'en_US-amy-medium', 'en_US-ryan-high', 'en_US-libritts_r-medium', 'en_US-hfc_female-medium',
    'en_GB-alba-medium', 'en_GB-jenny_dioco-medium', 'en_GB-northern_english_male-medium', 'en_GB-cori-high',
  ]) assert.ok(ids.includes(want), want);
  assert.ok(new Set(piper.CATALOG.map((v) => v.id.slice(0, 2))).size >= 5, 'major non-English voices too');
  assert.equal(piper.DEFAULT_VOICE, 'en_US-lessac-medium');
  assert.equal(piper.catalogEntry('en_US-lessac-medium').legacy, 'voice-en-us-lessac-medium');
});

test('voice ids, URLs and release assets', () => {
  assert.deepEqual(piper.parseVoiceId('en_GB-northern_english_male-medium'), {
    id: 'en_GB-northern_english_male-medium', lang: 'en', region: 'GB', locale: 'en_GB', name: 'northern_english_male', quality: 'medium',
  });
  assert.equal(piper.parseVoiceId('en_US-lessac-ultra'), null);
  assert.equal(piper.parseVoiceId('../../etc/passwd'), null);
  assert.equal(piper.validVoiceName('my-custom.voice'), true, 'a local voice file name');
  assert.equal(piper.validVoiceName('../x'), false);
  assert.equal(piper.validVoiceName('a/b'), false);
  assert.equal(piper.validVoiceName('..'), false);
  assert.deepEqual(piper.voiceUrls('en_US-lessac-medium'), {
    onnx: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx',
    json: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json',
  });
  assert.equal(piper.voiceUrls('en_US-libritts_r-medium', { base: 'http://127.0.0.1:1/x/' }).onnx, 'http://127.0.0.1:1/x/en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx');
  const base = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2';
  assert.deepEqual(piper.releaseAsset('linux', 'x64'), { name: 'piper_linux_x86_64.tar.gz', url: `${base}/piper_linux_x86_64.tar.gz`, kind: 'tar.gz', usable: true });
  assert.equal(piper.releaseAsset('linux', 'arm64').name, 'piper_linux_aarch64.tar.gz');
  assert.equal(piper.releaseAsset('linux', 'arm').name, 'piper_linux_armv7l.tar.gz');
  assert.equal(piper.releaseAsset('darwin', 'x64').name, 'piper_macos_x64.tar.gz');
  assert.equal(piper.releaseAsset('darwin', 'arm64').name, 'piper_macos_aarch64.tar.gz');
  assert.equal(piper.releaseAsset('darwin', 'arm64').usable, false, 'the macOS archives lack their libraries: macOS uses the venv');
  assert.deepEqual(piper.releaseAsset('win32', 'x64'), { name: 'piper_windows_amd64.zip', url: `${base}/piper_windows_amd64.zip`, kind: 'zip', usable: true });
  assert.equal(piper.releaseAsset('freebsd', 'x64'), null);
});

test('NO_PROXY matching and proxy selection', () => {
  const np = 'localhost,.corp.example,github.com:8443,10.1.2.3,*.internal';
  assert.equal(piper.noProxyMatch('127.0.0.1', 443, ''), true, 'loopback never goes through a proxy');
  assert.equal(piper.noProxyMatch('a.corp.example', 443, np), true);
  assert.equal(piper.noProxyMatch('corp.example', 443, np), true);
  assert.equal(piper.noProxyMatch('github.com', 443, np), false, 'port-specific entry');
  assert.equal(piper.noProxyMatch('github.com', 8443, np), true);
  assert.equal(piper.noProxyMatch('10.1.2.3', 443, np), true);
  assert.equal(piper.noProxyMatch('x.internal', 443, np), true);
  assert.equal(piper.noProxyMatch('huggingface.co', 443, np), false);
  assert.equal(piper.noProxyMatch('anything', 443, '*'), true);
  const u = new URL('https://huggingface.co/x');
  assert.equal(piper.proxyFor(u, { HTTPS_PROXY: 'http://user:pw@proxy:3128' }).host, 'proxy:3128');
  assert.equal(piper.proxyFor(u, { https_proxy: 'proxy:3128' }).hostname, 'proxy');
  assert.equal(piper.proxyFor(u, { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'huggingface.co' }), null);
  assert.equal(piper.proxyFor(new URL('http://127.0.0.1/x'), { HTTPS_PROXY: 'http://proxy:3128' }), null);
});

test('wavInfo: duration from the header, also for streamed WAVs with unknown sizes', () => {
  const pcm = (n, size = n * 2) => {
    const b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0, 'ascii');
    b.write('WAVE', 8, 'ascii');
    b.write('fmt ', 12, 'ascii');
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24);
    b.writeUInt32LE(32000, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36, 'ascii');
    b.writeUInt32LE(size, 40);
    return b;
  };
  assert.deepEqual(piper.wavInfo(pcm(16000)), { sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
  assert.equal(piper.wavInfo(pcm(8000, 0xffffffff)).durationMs, 500);
  assert.equal(piper.wavInfo(pcm(8000, 0)).durationMs, 500);
  assert.equal(piper.wavInfo(Buffer.from('nope')), null);
});

// ------------------------------------------------------------------ downloads

test('downloadFile: follows redirects across hosts, reports progress, and writes the file only when complete', async () => {
  const body = crypto.randomBytes(300 * 1024);
  const b = await serve({ '/real/file.bin': body });
  const a = await serve({ '/start/file.bin': { redirect: `${b.url}/real/file.bin`, status: 302 }, '/rel': { redirect: '/start/file.bin', status: 301 } });
  try {
    const dest = path.join(HOME, 'dl', 'file.bin');
    const seen = [];
    const out = await piper.downloadFile(`${a.url}/rel`, dest, { onProgress: (p) => seen.push(p) });
    assert.equal(out.bytes, body.length);
    assert.equal(out.url, `${b.url}/real/file.bin`);
    assert.ok(fs.readFileSync(dest).equals(body));
    assert.ok(!fs.existsSync(`${dest}.part`));
    assert.equal(seen[seen.length - 1].percent, 100);
    for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i].received >= seen[i - 1].received);
  } finally {
    await a.close();
    await b.close();
  }
});

test('downloadFile: an interrupted download keeps its .part file and the next run resumes with Range', async () => {
  const body = crypto.randomBytes(256 * 1024);
  let truncate = true;
  const s = await serve((p, req) => (p === '/f' ? (truncate && !req.headers.range ? { body, truncateAt: 100 * 1024 } : { body }) : undefined));
  try {
    const dest = path.join(HOME, 'dl2', 'f.bin');
    await assert.rejects(piper.downloadFile(`${s.url}/f`, dest), (err) => ['INCOMPLETE', 'DOWNLOAD_FAILED'].includes(err.code) && /resumes/.test(err.hint));
    assert.ok(!fs.existsSync(dest));
    const partial = fs.statSync(`${dest}.part`).size;
    assert.ok(partial > 0 && partial < body.length, `partial ${partial}`);
    truncate = false;
    await piper.downloadFile(`${s.url}/f`, dest);
    assert.ok(fs.readFileSync(dest).equals(body), 'resumed bytes are appended correctly');
    const last = s.requests[s.requests.length - 1];
    assert.equal(last.range, `bytes=${partial}-`);
  } finally {
    await s.close();
  }
});

test('downloadFile: 404, too-small files and plain http to a remote host are refused with clear errors', async () => {
  const s = await serve({ '/tiny': 'tiny' });
  try {
    await assert.rejects(piper.downloadFile(`${s.url}/missing.onnx`, path.join(HOME, 'dl3', 'm')), (err) => err.code === 'NOT_FOUND' && err.status === 404 && /voice id/.test(err.hint));
    await assert.rejects(piper.downloadFile(`${s.url}/tiny`, path.join(HOME, 'dl3', 't'), { minBytes: 1024 }), (err) => err.code === 'BAD_DOWNLOAD');
    assert.ok(!fs.existsSync(path.join(HOME, 'dl3', 't.part')), 'a bad file does not linger');
    await assert.rejects(piper.downloadFile('http://example.com/x', path.join(HOME, 'dl3', 'x')), (err) => err.code === 'INSECURE_URL');
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(piper.downloadFile(`${s.url}/tiny`, path.join(HOME, 'dl3', 'a'), { signal: ac.signal }), (err) => err.code === 'ABORTED');
  } finally {
    await s.close();
  }
});

/** A self-signed certificate for 127.0.0.1 and piper.test (null without openssl). */
function selfSigned() {
  const dir = fs.mkdtempSync(path.join(HOME, 'tls-'));
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=piper.test',
    '-addext', 'subjectAltName=DNS:piper.test,IP:127.0.0.1',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
  ], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}

const CERT = (() => {
  try {
    return selfSigned();
  } catch {
    return null;
  }
})();

test('HTTPS downloads: certificate checked, CONNECT proxy with credentials, proxy refusal explained', { skip: !CERT && 'openssl is not available' }, async () => {
  const body = crypto.randomBytes(64 * 1024);
  const tlsServer = await serve({ '/v.onnx': body }, { tlsOpts: CERT });
  const connects = [];
  let refuse = false;
  const proxy = http.createServer();
  const proxySockets = new Set();
  proxy.on('connection', (sock) => proxySockets.add(sock));
  proxy.on('connect', (req, client, head) => {
    connects.push({ target: req.url, auth: req.headers['proxy-authorization'] || null });
    if (refuse) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(tlsServer.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    proxySockets.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://bob:s3cret@127.0.0.1:${proxy.address().port}`;
  try {
    // Direct, with the test CA.
    const d1 = path.join(HOME, 'tls', 'direct.onnx');
    await piper.downloadFile(`${tlsServer.url}/v.onnx`, d1, { ca: CERT.cert });
    assert.ok(fs.readFileSync(d1).equals(body));
    // Without trusting the certificate: refused.
    await assert.rejects(piper.downloadFile(`${tlsServer.url}/v.onnx`, path.join(HOME, 'tls', 'untrusted.onnx')), (err) => err.code === 'DOWNLOAD_FAILED');
    // Through the proxy, by host name (the proxy resolves it).
    const d2 = path.join(HOME, 'tls', 'proxied.onnx');
    await piper.downloadFile(`https://piper.test:${tlsServer.port}/v.onnx`, d2, { ca: CERT.cert, env: { HTTPS_PROXY: proxyUrl } });
    assert.ok(fs.readFileSync(d2).equals(body));
    assert.equal(connects[0].target, `piper.test:${tlsServer.port}`);
    assert.equal(connects[0].auth, `Basic ${Buffer.from('bob:s3cret').toString('base64')}`);
    // NO_PROXY bypasses it (and then the fake host does not resolve).
    const before = connects.length;
    await assert.rejects(piper.downloadFile(`https://piper.test:${tlsServer.port}/v.onnx`, path.join(HOME, 'tls', 'np.onnx'), { ca: CERT.cert, env: { HTTPS_PROXY: proxyUrl, NO_PROXY: '.test' } }));
    assert.equal(connects.length, before, 'NO_PROXY skipped the proxy');
    // A proxy that refuses the host.
    refuse = true;
    await assert.rejects(
      piper.downloadFile(`https://piper.test:${tlsServer.port}/v.onnx`, path.join(HOME, 'tls', 'refused.onnx'), { ca: CERT.cert, env: { HTTPS_PROXY: proxyUrl } }),
      (err) => err.code === 'PROXY_REFUSED' && /403/.test(err.message) && /Allow piper\.test/.test(err.hint),
    );
  } finally {
    await tlsServer.close();
    // Tunnelled sockets leave the HTTP server's bookkeeping: close() would wait for them forever.
    for (const sock of proxySockets) sock.destroy();
    proxy.close();
  }
});

// ------------------------------------------------------------------ install

test('install: release binary + Hugging Face voice, then a spoken self-test; progress stages in order', { skip: NO_EXEC }, async () => {
  const rel = releaseArchive();
  const s = await serve({ '/rel/piper_linux_x86_64.tar.gz': { redirect: '/objects/piper.tgz' }, '/objects/piper.tgz': rel, ...hfRoutes() });
  try {
    const pm = manager({ releaseBase: `${s.url}/rel`, voicesBase: `${s.url}/hf`, legacyBase: `${s.url}/legacy` });
    const progress = [];
    const r = await pm.install({ voice: 'en_US-lessac-medium', onProgress: (p) => progress.push(p) });
    assert.equal(r.ok, true);
    assert.equal(r.binaryKind, 'bundled');
    assert.equal(r.binary, path.join(pm.root(), 'bin', 'piper', 'piper'));
    assert.ok(r.durationMs > 0);
    const stages = [...new Set(progress.map((p) => p.stage))];
    assert.deepEqual(stages, ['binary', 'voice', 'verify', 'done']);
    for (let i = 1; i < progress.length; i += 1) assert.ok(progress[i].percent >= progress[i - 1].percent, 'percent never goes back');
    assert.equal(progress[progress.length - 1].percent, 100);
    assert.match(progress[progress.length - 1].message, /costs nothing/);
    assert.ok(progress.some((p) => p.stage === 'voice' && p.stagePercent === 100));

    const st = await pm.status('en_US-lessac-medium');
    assert.equal(st.installed, true);
    assert.deepEqual(st.installedVoices, ['en_US-lessac-medium']);
    assert.equal(st.installing, null);
    assert.ok(!fs.existsSync(path.join(pm.root(), 'install.lock')), 'lock released');
    assert.ok(!fs.existsSync(path.join(pm.root(), 'downloads', 'piper_linux_x86_64.tar.gz')), 'archive removed after unpacking');

    // Synthesis: text on stdin, model/config/output on the command line.
    const log = path.join(HOME, 'calls1.jsonl');
    pm.env.FAKE_PIPER_LOG = log;
    const out = path.join(HOME, 'out', 'a.wav');
    const syn = await pm.synthesize('Hello\nthere,   world.', { voice: 'en_US-lessac-medium', outFile: out, lengthScale: 0.8 });
    wavOk(out);
    assert.equal(syn.durationMs, wavOk(out).durationMs);
    const call = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
    assert.equal(call.input, 'Hello there, world.\n', 'one line (piper writes one file per line)');
    const vp = pm.voicePaths('en_US-lessac-medium');
    assert.deepEqual(call.args.slice(0, 6), ['--model', vp.onnx, '--config', vp.json, '--output_file', call.args[5]]);
    assert.ok(call.args.includes('--length_scale') && call.args[call.args.indexOf('--length_scale') + 1] === '0.8');
    assert.ok(call.args.includes('--quiet'), 'the release binary is told to be quiet');
    assert.equal(fs.readdirSync(path.dirname(out)).filter((n) => /tmp/.test(n)).length, 0, 'no temp files left');

    // A second voice: only the voice is downloaded.
    const before = s.requests.filter((q) => q.path.includes('piper_linux')).length;
    await pm.install({ voice: 'en_GB-alba-medium' });
    assert.equal(s.requests.filter((q) => q.path.includes('piper_linux')).length, before, 'the binary is not downloaded again');
    assert.deepEqual(pm.installedVoices(), ['en_GB-alba-medium', 'en_US-lessac-medium']);
    assert.equal(pm.removeVoice('en_GB-alba-medium'), true);
    assert.equal(pm.removeVoice('en_GB-alba-medium'), false);
  } finally {
    await s.close();
  }
});

test('install: when Hugging Face is unreachable the voice comes from the GitHub release', { skip: NO_EXEC }, async () => {
  const rel = releaseArchive();
  const s = await serve({
    '/rel/piper_linux_x86_64.tar.gz': rel,
    '/hf/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json': { status: 403 },
    '/legacy/voice-en-us-lessac-medium.tar.gz': legacyVoiceArchive(),
  });
  try {
    const pm = manager({ releaseBase: `${s.url}/rel`, voicesBase: `${s.url}/hf`, legacyBase: `${s.url}/legacy` });
    const progress = [];
    await pm.install({ voice: 'en_US-lessac-medium', onProgress: (p) => progress.push(p) });
    assert.ok(progress.some((p) => /from GitHub/.test(p.message)));
    const vp = pm.voicePaths('en_US-lessac-medium');
    assert.ok(fs.readFileSync(vp.onnx).equals(MODEL));
    assert.deepEqual(JSON.parse(fs.readFileSync(vp.json, 'utf8')).audio, { sample_rate: 22050 });
    // A voice without a GitHub copy reports the real problem.
    await assert.rejects(pm.install({ voice: 'en_US-amy-medium' }), (err) => err.code === 'NOT_FOUND' || err.code === 'HTTP_ERROR');
  } finally {
    await s.close();
  }
});

test('install: a release binary that does not run is replaced by piper-tts in a private venv', { skip: NO_EXEC }, async () => {
  const s = await serve({ '/rel/piper_linux_x86_64.tar.gz': releaseArchive({ broken: true }), ...hfRoutes() });
  const srcFile = makeFakePiper(path.join(SCRIPTS, 'piper-src.js'));
  const python = makeFakePython(path.join(SCRIPTS, 'python3'));
  try {
    const pm = manager({ releaseBase: `${s.url}/rel`, voicesBase: `${s.url}/hf`, env: { ANYWHERE_PYTHON: python, FAKE_PIPER_SRC_FILE: srcFile } });
    const progress = [];
    const r = await pm.install({ voice: 'en_US-lessac-medium', onProgress: (p) => progress.push(p) });
    assert.equal(r.binaryKind, 'venv');
    assert.equal(r.binary, path.join(pm.venvDir(), 'bin', 'piper'));
    assert.ok(fs.existsSync(path.join(pm.root(), 'bin', 'BROKEN')), 'the broken binary is not tried again');
    assert.ok(progress.some((p) => /pip: (Collecting|Successfully installed)/.test(p.message)), 'pip progress is shown');
    assert.deepEqual(await pm.findBinary({ refresh: true }), { bin: r.binary, kind: 'venv' });
    const out = path.join(HOME, 'venv-out.wav');
    await pm.synthesize('Hi', { voice: 'en_US-lessac-medium', outFile: out });
    wavOk(out);
  } finally {
    await s.close();
  }
});

test('install: no Python and no working binary gives an actionable error; a second install waits for the first', { skip: NO_EXEC }, async () => {
  const s = await serve({ '/rel/piper_linux_x86_64.tar.gz': releaseArchive({ broken: true }), ...hfRoutes() });
  try {
    const pm = manager({ releaseBase: `${s.url}/rel`, voicesBase: `${s.url}/hf` });
    const progress = [];
    await assert.rejects(pm.install({ onProgress: (p) => progress.push(p) }), (err) => err.code === 'NO_PYTHON' && /python3-venv/.test(err.hint));
    assert.equal(progress[progress.length - 1].stage, 'error');
    assert.match(progress[progress.length - 1].message, /Python 3\.9/);
    assert.equal(pm.installing, null);

    // The lock: another live process holds it.
    fs.writeFileSync(path.join(pm.root(), 'install.lock'), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    await assert.rejects(pm.install(), (err) => err.code === 'INSTALL_BUSY' && err.status === 409);
    // A stale lock (dead pid) is taken over.
    fs.writeFileSync(path.join(pm.root(), 'install.lock'), JSON.stringify({ pid: 2147483646 }));
    await assert.rejects(pm.install(), (err) => err.code === 'NO_PYTHON');
    await assert.rejects(pm.install({ voice: 'evil/../../x' }), (err) => err.code === 'BAD_VOICE' && err.status === 400);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ binary lookup and synthesis errors

test('findBinary: ANYWHERE_PIPER_PATH, then the release binary, the venv, and a piper on PATH that really is Piper', { skip: NO_EXEC }, async () => {
  const envBin = makeFakePiper(path.join(SCRIPTS, 'env', 'piper'));
  const pathBin = makeFakePiper(path.join(SCRIPTS, 'onpath', 'piper'));
  const mouseGui = writeScript(path.join(SCRIPTS, 'mouse', 'piper'), "process.stdout.write('Piper: GTK app to configure gaming mice\\n');");
  let pm = manager({ env: { ANYWHERE_PIPER_PATH: envBin } });
  assert.deepEqual(await pm.findBinary(), { bin: envBin, kind: 'env' });
  pm = manager({ env: { ANYWHERE_PIPER_PATH: path.dirname(envBin) } });
  assert.deepEqual(await pm.findBinary(), { bin: envBin, kind: 'env' }, 'a folder works too');

  pm = manager({ which: (n) => (n === 'piper' ? mouseGui : null) });
  assert.equal(await pm.findBinary(), null, 'the gaming-mouse "piper" is not Piper TTS');
  pm = manager({ which: (n) => (n === 'piper' ? pathBin : null) });
  assert.deepEqual(await pm.findBinary(), { bin: pathBin, kind: 'path' });
  makeFakePiper(pm.venvPiperPath());
  assert.deepEqual(await pm.findBinary({ refresh: true }), { bin: pm.venvPiperPath(), kind: 'venv' });
  makeFakePiper(pm.bundledPath());
  assert.deepEqual(await pm.findBinary({ refresh: true }), { bin: pm.bundledPath(), kind: 'bundled' });
  fs.writeFileSync(path.join(pm.root(), 'bin', 'BROKEN'), 'x');
  assert.equal((await pm.findBinary({ refresh: true })).kind, 'venv', 'a broken release binary is skipped');
});

test('synthesize: not installed, missing voice, failures and timeouts are reported clearly', { skip: NO_EXEC }, async () => {
  const out = path.join(HOME, 'err', 'x.wav');
  let pm = manager();
  await assert.rejects(pm.synthesize('hi', { outFile: out }), (err) => err.code === 'PIPER_NOT_INSTALLED' && err.status === 503 && /anywhere voice install/.test(err.hint));
  const bin = makeFakePiper(path.join(SCRIPTS, 'synth', 'piper'));
  pm = manager({ env: { ANYWHERE_PIPER_PATH: bin } });
  await assert.rejects(pm.synthesize('hi', { voice: 'en_GB-alba-medium', outFile: out }), (err) => err.code === 'PIPER_VOICE_MISSING' && /--voice en_GB-alba-medium/.test(err.hint));
  const vp = pm.voicePaths('en_US-lessac-medium');
  fs.mkdirSync(path.dirname(vp.onnx), { recursive: true });
  fs.writeFileSync(vp.onnx, MODEL);
  fs.writeFileSync(vp.json, CONFIG);
  await assert.rejects(pm.synthesize('   ', { outFile: out }), (err) => err.status === 400);
  pm.env.FAKE_PIPER_FAIL = '1';
  await assert.rejects(pm.synthesize('hi', { outFile: out }), (err) => err.code === 'PIPER_FAILED' && /model is corrupt/.test(err.message));
  delete pm.env.FAKE_PIPER_FAIL;
  pm.env.FAKE_PIPER_SLEEP = '1';
  await assert.rejects(pm.synthesize('hi', { outFile: out, timeoutMs: 400 }), (err) => err.code === 'PIPER_TIMEOUT' && err.status === 504);
  delete pm.env.FAKE_PIPER_SLEEP;
  assert.ok(!fs.existsSync(out), 'a failed synthesis leaves no file');
  const ok = await pm.synthesize('hi', { outFile: out });
  assert.equal(ok.binaryKind, 'env');
  wavOk(out);
});

// ------------------------------------------------------------------ cache

test('TtsCache: stable ids, strict id format, and least-recently-used pruning to 60 files', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'cache-'));
  const cache = new piper.TtsCache({ dir, max: 60 });
  const id = cache.keyFor(['piper', 'en_US-lessac-medium', 1, 'All done.']);
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(cache.keyFor(['piper', 'en_US-lessac-medium', 1, 'All done.']), id);
  assert.notEqual(cache.keyFor(['piper', 'en_US-lessac-medium', 0.9, 'All done.']), id);
  for (const bad of ['../x', id.toUpperCase(), `${id}0`, id.slice(1), '', null, `${id.slice(0, 31)}/`]) assert.equal(piper.TtsCache.validId(bad), false, String(bad));
  assert.equal(cache.pathFor('../../etc/passwd'), null);
  assert.equal(cache.get(id), null);
  const t0 = Date.now() / 1000 - 10000;
  for (let i = 0; i < 65; i += 1) {
    const p = cache.pathFor(cache.keyFor([i]));
    fs.writeFileSync(p, Buffer.alloc(100));
    fs.utimesSync(p, t0 + i, t0 + i);
  }
  const oldest = cache.pathFor(cache.keyFor([0]));
  assert.ok(cache.get(cache.keyFor([0])), 'a hit marks it recently used');
  fs.writeFileSync(path.join(dir, 'x.wav.123.tmp.wav'), 'x');
  fs.utimesSync(path.join(dir, 'x.wav.123.tmp.wav'), t0, t0);
  cache.prune();
  const left = fs.readdirSync(dir);
  assert.equal(left.length, 60);
  assert.ok(fs.existsSync(oldest), 'the one just used survived');
  assert.ok(!fs.existsSync(cache.pathFor(cache.keyFor([1]))), 'the least recently used went');
  assert.ok(!left.some((n) => /tmp/.test(n)), 'stale temp files are removed');
});

// ------------------------------------------------------------------ VoiceService

function voiceService({ ttsEngine = 'auto', env = {}, runner, which, player } = {}) {
  const OK = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: null };
  const calls = [];
  const r = runner || ((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve(OK);
  });
  const played = [];
  const fakePlayer = player || {
    playing: null,
    async playFile(file) {
      played.push(file);
      return { ok: true, player: 'fake' };
    },
    stop() {
      return false;
    },
    async status() {
      return { available: true, players: ['fake'] };
    },
  };
  const root = fs.mkdtempSync(path.join(HOME, 'svc-'));
  const pm = new piper.PiperManager({ root: path.join(root, 'piper'), env: { PATH: process.env.PATH, ...env }, platformInfo: { platform: 'linux' }, which: () => null });
  const svc = new VoiceService({
    config: { voice: { language: 'en-US', ttsEngine, piperVoice: 'en_US-lessac-medium', ttsRate: 1 } },
    env: {},
    runner: r,
    which: which || ((n) => (n === 'espeak-ng' ? '/usr/bin/espeak-ng' : null)),
    platformInfo: { platform: 'linux', isWSL: false },
    piper: pm,
    player: fakePlayer,
    ttsCache: new piper.TtsCache({ dir: path.join(root, 'cache') }),
  });
  return { svc, pm, calls, played };
}

function installFakeVoice(pm, id = 'en_US-lessac-medium') {
  const vp = pm.voicePaths(id);
  fs.mkdirSync(path.dirname(vp.onnx), { recursive: true });
  fs.writeFileSync(vp.onnx, MODEL);
  fs.writeFileSync(vp.json, CONFIG);
}

test('VoiceService: auto uses Piper when installed (capabilities, synthesize cache, speak), else the OS voice', { skip: NO_EXEC }, async () => {
  const bin = makeFakePiper(path.join(SCRIPTS, 'svc', 'piper'));
  const none = voiceService();
  let caps = await none.svc.capabilities();
  assert.deepEqual({ engine: caps.engine, ttsEngine: caps.ttsEngine, serverTts: caps.serverTts, ttsProvider: caps.ttsProvider, piper: caps.piper }, {
    engine: 'os', ttsEngine: 'auto', serverTts: true, ttsProvider: 'espeak-ng', piper: { installed: false, voice: 'en_US-lessac-medium' },
  });
  assert.deepEqual(await none.svc.speak('hello'), { ok: true, provider: 'espeak-ng' });
  await assert.rejects(none.svc.synthesize('hello'), (err) => err.status === 503 && /anywhere voice install/.test(err.hint));

  const log = path.join(HOME, 'svc-calls.jsonl');
  const { svc, pm, calls, played } = voiceService({ env: { ANYWHERE_PIPER_PATH: bin, FAKE_PIPER_LOG: log } });
  installFakeVoice(pm);
  caps = await svc.capabilities();
  assert.equal(caps.engine, 'piper');
  assert.equal(caps.ttsProvider, 'piper');
  assert.deepEqual(caps.piper, { installed: true, voice: 'en_US-lessac-medium' });

  const a = await svc.synthesize('**All done.** I deployed `shop-api`.');
  assert.match(a.id, /^[a-f0-9]{32}$/);
  assert.equal(a.mime, 'audio/wav');
  assert.equal(a.engine, 'piper');
  assert.equal(a.cached, false);
  assert.ok(a.durationMs > 0);
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8').trim()).input, 'All done. I deployed shop-api.\n', 'markdown is stripped');
  const b = await svc.synthesize('**All done.** I deployed `shop-api`.');
  assert.equal(b.id, a.id);
  assert.equal(b.cached, true, 'the same phrase replays from the cache');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'piper ran once');
  assert.equal(svc.audioFile(a.id), a.path);
  assert.equal(svc.audioFile('../../config.json'), null);
  assert.equal(svc.audioFile('0'.repeat(32)), null);
  const [c1, c2] = await Promise.all([svc.synthesize('Concurrent phrase'), svc.synthesize('Concurrent phrase')]);
  assert.equal(c1.path, c2.path, 'concurrent requests for one phrase share one synthesis');

  assert.deepEqual(await svc.speak('Finished the deploy.'), { ok: true, provider: 'piper' });
  assert.equal(played.length, 1);
  wavOk(played[0]);
  assert.equal(calls.length, 0, 'the OS voice was not used');

  // A Piper failure falls back to the OS voice in auto mode.
  pm.env.FAKE_PIPER_FAIL = '1';
  assert.deepEqual(await svc.speak('A brand new sentence.'), { ok: true, provider: 'espeak-ng' });
  delete pm.env.FAKE_PIPER_FAIL;
});

test('VoiceService: ttsEngine piper requires Piper, os ignores it, browser still speaks explicit requests', { skip: NO_EXEC }, async () => {
  const bin = makeFakePiper(path.join(SCRIPTS, 'svc2', 'piper'));
  const forced = voiceService({ ttsEngine: 'piper' });
  const caps = await forced.svc.capabilities();
  assert.equal(caps.engine, null);
  assert.equal(caps.serverTts, false);
  assert.match(caps.ttsHint, /anywhere voice install/);
  await assert.rejects(forced.svc.speak('hello'), (err) => err.status === 503 && /anywhere voice install/.test(err.hint));

  const osOnly = voiceService({ ttsEngine: 'os', env: { ANYWHERE_PIPER_PATH: bin } });
  installFakeVoice(osOnly.pm);
  assert.equal((await osOnly.svc.capabilities()).engine, 'os');
  assert.deepEqual(await osOnly.svc.speak('hello'), { ok: true, provider: 'espeak-ng' });
  assert.equal(osOnly.played.length, 0);
  assert.equal((await osOnly.svc.synthesize('still renders on request')).engine, 'piper', 'synthesize() uses Piper whenever it is installed');

  const browser = voiceService({ ttsEngine: 'browser' });
  assert.equal((await browser.svc.engineInfo()).engine, 'browser');
  assert.equal((await browser.svc.speak('hello')).provider, 'espeak-ng');

  const status = await osOnly.svc.voiceStatus();
  assert.equal(status.engine, 'os');
  assert.equal(status.ttsEngine, 'os');
  assert.equal(status.piper.installed, true);
  assert.deepEqual(status.piper.installedVoices, ['en_US-lessac-medium']);
  assert.equal(status.piper.catalog.find((v) => v.id === 'en_US-lessac-medium').installed, true);
  for (const k of ['id', 'name', 'language', 'gender', 'quality', 'sizeMb', 'sampleText']) assert.ok(k in status.piper.catalog[0], k);
  assert.deepEqual(status.os, { provider: 'espeak-ng' });
  assert.deepEqual(status.player, { available: true, players: ['fake'] });
});

test('VoiceService: stop() ends Piper playback and tells onStop listeners; a replacing utterance does not', { skip: NO_EXEC }, async () => {
  const bin = makeFakePiper(path.join(SCRIPTS, 'svc3', 'piper'));
  let release = null;
  const player = {
    playing: false,
    playFile() {
      this.playing = true;
      return new Promise((resolve) => {
        release = () => {
          this.playing = false;
          resolve({ ok: true, player: 'fake', stopped: true });
        };
      });
    },
    stop() {
      if (!this.playing) return false;
      release();
      return true;
    },
    async status() {
      return { available: true, players: ['fake'] };
    },
  };
  const { svc, pm } = voiceService({ env: { ANYWHERE_PIPER_PATH: bin }, player });
  installFakeVoice(pm);
  let stops = 0;
  const off = svc.onStop(() => (stops += 1));
  const first = svc.speak('The first long announcement.');
  for (let i = 0; i < 100 && !player.playing; i += 1) await new Promise((r) => setTimeout(r, 10));
  const second = svc.speak('The second announcement replaces it.');
  assert.deepEqual(await first, { ok: true, provider: 'piper', stopped: true });
  assert.equal(stops, 0, 'replacing is not a stop');
  for (let i = 0; i < 100 && !player.playing; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(svc.stop(), true);
  assert.deepEqual(await second, { ok: true, provider: 'piper', stopped: true });
  assert.equal(stops, 1);
  off();
  svc.stop();
  assert.equal(stops, 1, 'unsubscribed');
});

// ------------------------------------------------------------------ daemon: POST /api/voice/install

test('daemon: POST /api/voice/install streams voice_install progress over SSE and switches the voice', { skip: process.platform !== 'linux' }, async () => {
  const rel = releaseArchive();
  const s = await serve((p) => {
    if (/^\/rel\/piper_linux_[a-z0-9_]+\.tar\.gz$/.test(p)) return rel;
    return hfRoutes()[p];
  });
  process.env.ANYWHERE_PIPER_RELEASE_BASE = `${s.url}/rel`;
  process.env.ANYWHERE_PIPER_VOICES_BASE = `${s.url}/hf`;
  process.env.ANYWHERE_PIPER_LEGACY_BASE = `${s.url}/legacy`;
  const main = require('../src/daemon/main');
  const d = await main.runDaemon({ project: HOME, port: 0, open: false, handleSignals: false, allowMultiple: true });
  const events = [];
  const sse = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${d.port}/api/events?client=cli`, { headers: { Authorization: `Bearer ${d.token}` } }, (res) => {
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
      resolve(req);
    });
    req.on('error', reject);
  });
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${d.port}${p}`, {
      method,
      headers: { Authorization: `Bearer ${d.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    let st = await api('GET', '/api/voice/status');
    assert.equal(st.status, 200);
    assert.equal(st.body.piper.installed, false);
    assert.equal(st.body.announcer, true);
    assert.ok(st.body.piper.catalog.length >= 10);
    assert.equal((await api('POST', '/api/voice/install', { voice: 'nope' })).status, 400);
    const started = await api('POST', '/api/voice/install', { voice: 'en_GB-alba-medium' });
    assert.deepEqual(started.body, { ok: true, started: true, voice: 'en_GB-alba-medium' });
    const again = await api('POST', '/api/voice/install', {});
    assert.equal(again.body.started, false, 'one install at a time');
    for (let i = 0; i < 300 && !events.some((e) => e.type === 'voice_install' && ['done', 'error'].includes(e.data.stage)); i += 1) await new Promise((r) => setTimeout(r, 50));
    const progress = events.filter((e) => e.type === 'voice_install').map((e) => e.data);
    assert.equal(progress[progress.length - 1].stage, 'done', JSON.stringify(progress[progress.length - 1]));
    assert.deepEqual([...new Set(progress.map((p) => p.stage))], ['binary', 'voice', 'verify', 'done']);
    for (const p of progress) for (const k of ['stage', 'percent', 'message']) assert.ok(k in p, k);
    // The chosen voice is saved and the snapshot says Piper is in use.
    for (let i = 0; i < 100; i += 1) {
      st = await api('GET', '/api/voice/status');
      if (st.body.piper.installed && st.body.piper.voice === 'en_GB-alba-medium') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(st.body.engine, 'piper');
    assert.equal(st.body.piper.voice, 'en_GB-alba-medium');
    assert.equal(st.body.piper.installing, null);
    assert.equal(d.server.deps.config.voice.piperVoice, 'en_GB-alba-medium');
    let snap = null;
    for (let i = 0; i < 100; i += 1) {
      snap = (await api('GET', '/api/state')).body;
      if (snap.voice && snap.voice.engine === 'piper') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(snap.voice.engine, 'piper');
    assert.equal(snap.voice.announcer, true);
    assert.deepEqual(snap.voice.piper, { installed: true, voice: 'en_GB-alba-medium' });
  } finally {
    sse.destroy();
    await d.shutdown('test');
    await s.close();
    delete process.env.ANYWHERE_PIPER_RELEASE_BASE;
    delete process.env.ANYWHERE_PIPER_VOICES_BASE;
    delete process.env.ANYWHERE_PIPER_LEGACY_BASE;
  }
});
