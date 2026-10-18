'use strict';

/**
 * CloneInstaller (src/voice/clone/installer.js), models.js and piper.js findPython, offline:
 * a fake python (a Node shim that is the system python, the venv python and a protocol-speaking
 * sidecar), a fake uv packaged in a real tar.gz, tiny tar.bz2 model archives served by a local
 * HTTP server (Range support, 404s, corrupt bodies, delays). Covers the progress stages, the
 * file whitelist, sha256 mismatch, resume, mirror fallback, hand-placed downloads, the uv
 * fallbacks, requirement updates, the lock, cancellation, sidecar specs and the WSL layout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-clone-installer-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;
delete process.env.ANYWHERE_CLONE_ASSET_BASE;
for (const k of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];

const models = require('../src/voice/clone/models');
const piper = require('../src/daemon/piper');
const { CloneInstaller, wslToWindowsPath, windowsToWslPath, withWslEnv } = require('../src/voice/clone/installer');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const NO_EXEC = process.platform === 'win32' && 'fake interpreters are shebang scripts';
const TAR = (() => {
  if (process.platform === 'win32') return null;
  const which = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' });
  const tar = String(which.stdout || '').trim();
  if (!tar) return null;
  const probe = fs.mkdtempSync(path.join(HOME, 'probe-'));
  fs.writeFileSync(path.join(probe, 'a'), 'a');
  const r = spawnSync(tar, ['-cjf', path.join(probe, 'a.tar.bz2'), '-C', probe, 'a']);
  return r.status === 0 ? tar : null;
})();
const SKIP = NO_EXEC || (!TAR && 'tar with bzip2 is not available');

// ------------------------------------------------------------------ fakes

const SHIM_DIR = path.join(HOME, 'shims');
fs.mkdirSync(SHIM_DIR, { recursive: true });

const FAKE_PY_SRC = `
const fs = require('fs');
const path = require('path');
const self = __filename;
const venvRoot = path.dirname(path.dirname(self));
let a = process.argv.slice(2);
if (process.env.FAKE_PY_LOG) fs.appendFileSync(process.env.FAKE_PY_LOG, JSON.stringify({ self, args: a }) + '\\n');
while (a.length && (a[0] === '-I' || a[0] === '-u' || a[0] === '-X')) a = a[0] === '-X' ? a.slice(2) : a.slice(1);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (a[0] === '-c') {
  const code = a[1];
  if (code.includes('import sys, venv')) { process.stdout.write((process.env.FAKE_PY_VERSION || '3.12') + '\\n'); process.exit(0); }
  if (code.includes('ANYWHERE-OK')) {
    if (fs.existsSync(path.join(venvRoot, 'installed.txt'))) { process.stdout.write('ANYWHERE-OK 3.12.9 1.13.8 2.5.4\\n'); process.exit(0); }
    process.stderr.write("ModuleNotFoundError: No module named 'sherpa_onnx'\\n");
    process.exit(1);
  }
  process.exit(0);
}
if (a[0] === '-m' && a[1] === 'venv') {
  if (process.env.FAKE_VENV_FAIL) {
    process.stderr.write('Error: Command [\\'python3\\', \\'-m\\', \\'ensurepip\\'] returned non-zero exit status 1.\\n');
    process.exit(1);
  }
  const dir = a[2];
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.copyFileSync(self, path.join(dir, 'bin', 'python'));
  fs.chmodSync(path.join(dir, 'bin', 'python'), 0o755);
  process.exit(0);
}
if (a[0] === '-m' && a[1] === 'pip') {
  if (!a.includes('-r')) process.exit(0);
  if (process.env.FAKE_PIP_FAIL === 'nowheel') {
    process.stderr.write('ERROR: Could not find a version that satisfies the requirement sherpa-onnx==1.13.8\\nERROR: No matching distribution found for sherpa-onnx==1.13.8\\n');
    process.exit(1);
  }
  if (process.env.FAKE_PIP_FAIL === 'net') { process.stderr.write('ERROR: Could not install packages due to an OSError: Network is unreachable\\n'); process.exit(1); }
  fs.writeFileSync(path.join(venvRoot, 'installed.txt'), a.join(' '));
  process.stdout.write('Collecting sherpa-onnx==1.13.8\\nCollecting numpy<3,>=1.24\\nInstalling collected packages: numpy, sherpa-onnx\\nSuccessfully installed numpy-2.5.4 sherpa-onnx-1.13.8\\n');
  process.exit(0);
}
if (a[0] && a[0].endsWith('sidecar.py')) {
  const ops = ['hello', 'models.check', 'tts.load', 'asr.load', 'bench', 'shutdown'];
  out({ event: 'ready', protocol: 1, pid: process.pid, python: '3.12.9', sherpa: '1.13.8', fake: false, runtimeError: null, ops, audioIo: { available: false }, argv: a });
  const RTF = { pocket: { 1: 0.5, 2: 0.45, 4: 0.9 }, zipvoice: { '2:2': 1.4, '2:3': 1.6, '4:2': 0.6, '4:3': 0.8 } };
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\\n')) >= 0) {
      const req = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const { id, op, ...p } = req;
      if (process.env.FAKE_SIDECAR_LOG) fs.appendFileSync(process.env.FAKE_SIDECAR_LOG, JSON.stringify(req) + '\\n');
      if (op === 'hello') out({ id, ok: true, protocol: 1 });
      else if (op === 'models.check') {
        const missing = [];
        for (const asset of p.assets) for (const f of asset.files) if (!fs.existsSync(f)) missing.push({ id: asset.id, file: f });
        out({ id, ok: true, missing, complete: missing.length === 0 });
      } else if (op === 'tts.load') out({ id, ok: true, loadMs: 5, sampleRate: 24000, engine: p.engine, threads: p.threads });
      else if (op === 'asr.load') out({ id, ok: true, loadMs: 7, model: p.model });
      else if (op === 'bench') {
        const runs = [];
        for (const t of p.threads) for (const s of p.steps) {
          const steps = s || 5;
          const rtf = p.engine === 'pocket' ? RTF.pocket[t] : RTF.zipvoice[t + ':' + s];
          const run = { engine: p.engine, threads: t, steps, rtf, firstChunkMs: 700, audioMs: 2500, loadMs: 800 };
          runs.push(run);
          out({ event: 'bench.progress', id, ...run });
        }
        const best = runs.slice().sort((x, y) => x.rtf - y.rtf)[0];
        out({ id, ok: true, runs, best, cpus: 4 });
      } else if (op === 'shutdown') { out({ id, ok: true, bye: true }); setTimeout(() => process.exit(0), 5); }
      else out({ id, ok: false, error: 'Unknown op ' + op, code: 'BAD_REQUEST' });
    }
  });
} else {
  process.stderr.write('fake python: unexpected ' + JSON.stringify(a) + '\\n');
  process.exit(2);
}
`;

const FAKE_UV_SRC = `
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
if (process.env.FAKE_UV_LOG) fs.appendFileSync(process.env.FAKE_UV_LOG, JSON.stringify({ args: a, env: { py: process.env.UV_PYTHON_INSTALL_DIR, cache: process.env.UV_CACHE_DIR, noConfig: process.env.UV_NO_CONFIG, pref: process.env.UV_PYTHON_PREFERENCE } }) + '\\n');
if (a[0] === '--version') { process.stdout.write('uv 0.11.32 (fake)\\n'); process.exit(0); }
if (a[0] === 'venv') {
  const dir = a[a.length - 1];
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.copyFileSync(process.env.FAKE_PY_SRC, path.join(dir, 'bin', 'python'));
  fs.chmodSync(path.join(dir, 'bin', 'python'), 0o755);
  process.stdout.write('Using CPython 3.12.9\\nCreating virtual environment at: ' + dir + '\\n');
  process.exit(0);
}
if (a[0] === 'pip' && a[1] === 'install') {
  const py = a[a.indexOf('--python') + 1];
  fs.writeFileSync(path.join(path.dirname(path.dirname(py)), 'installed.txt'), 'uv');
  process.stderr.write('Resolved 5 packages in 10ms\\nInstalled 5 packages in 20ms\\n');
  process.exit(0);
}
process.exit(2);
`;

function writeExe(file, src) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\n${src}`, { mode: 0o755 });
  return file;
}

const FAKEPY = writeExe(path.join(SHIM_DIR, 'python3'), FAKE_PY_SRC);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Tiny archives for every asset (the real file names, plus junk that must be dropped). */
function buildCatalog() {
  const dir = fs.mkdtempSync(path.join(HOME, 'assets-'));
  const files = new Map();
  const assets = {};
  for (const [id, real] of Object.entries(models.ASSETS)) {
    const name = path.posix.basename(real.path);
    let body;
    if (real.archive) {
      const top = path.join(dir, id, real.topDir);
      const put = (rel, content) => {
        const f = path.join(top, ...rel.split('/'));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content);
      };
      for (const [role, rel] of Object.entries(real.files)) {
        if (role === 'data_dir') put(`${rel}/en_dict`, 'dict');
        else put(rel, `${id}:${role}`);
      }
      for (const rel of real.keep) put(rel, `keep:${rel}`);
      put('test_wavs/junk.wav', 'junk');
      put('model.fp32.onnx', 'fp32 duplicate');
      const out = path.join(dir, name);
      const r = spawnSync(TAR, ['-cjf', out, '-C', path.join(dir, id), real.topDir]);
      assert.equal(r.status, 0, String(r.stderr));
      body = fs.readFileSync(out);
    } else {
      body = Buffer.from(`model bytes of ${id}`.repeat(50));
    }
    const p = `tiny/${name}`;
    files.set(`/good/${p}`, body);
    assets[id] = Object.freeze({ ...real, path: p, bytes: body.length, sha256: sha(body) });
  }
  // uv: a tar.gz with the fake uv in a folder, like the real release.
  const uvTop = path.join(dir, 'uvpkg', 'uv-fake');
  writeExe(path.join(uvTop, 'uv'), FAKE_UV_SRC);
  fs.writeFileSync(path.join(uvTop, 'uvx'), 'not this one');
  const uvTgz = path.join(dir, 'uv-fake.tar.gz');
  assert.equal(spawnSync(TAR, ['-czf', uvTgz, '-C', path.join(dir, 'uvpkg'), 'uv-fake']).status, 0);
  const uvBody = fs.readFileSync(uvTgz);
  files.set('/uv/uv-fake.tar.gz', uvBody);
  const uvAssets = { [`${process.platform}:x64`]: { name: 'uv-fake.tar.gz', sha256: sha(uvBody) } };
  return { assets, files, uvAssets };
}

let CAT = null;
let SRV = null;
let BASE = '';
const hits = new Map();
const ranges = [];
const corrupt = new Set();
const delays = new Map();

function startServer() {
  return new Promise((resolve) => {
    SRV = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      hits.set(url, (hits.get(url) || 0) + 1);
      if (req.headers.range) ranges.push({ url, range: req.headers.range });
      const body = CAT.files.get(url.replace(/^\/(alt|mirror)\//, '/good/'));
      const send = () => {
        if (!body || url.startsWith('/missing/')) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const data = corrupt.has(url) ? Buffer.concat([body.subarray(0, body.length - 1), Buffer.from([body[body.length - 1] ^ 0xff])]) : body;
        const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
        if (m && Number(m[1]) < data.length) {
          const start = Number(m[1]);
          res.writeHead(206, { 'Content-Length': data.length - start, 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` });
          res.end(data.subarray(start));
          return;
        }
        res.writeHead(200, { 'Content-Length': data.length });
        res.end(data);
      };
      const d = delays.get(url);
      if (d) setTimeout(send, d);
      else send();
    });
    SRV.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${SRV.address().port}`;
      resolve();
    });
  });
}

test.before(async () => {
  if (SKIP) return;
  CAT = buildCatalog();
  await startServer();
});
test.after(() => SRV && SRV.close());

let homeN = 0;
/** An installer in a fresh state folder with the fakes. */
function makeInstaller({ python = true, env = {}, base = `${BASE}/good/`, ...opts } = {}) {
  homeN += 1;
  const state = fs.mkdtempSync(path.join(HOME, `state${homeN}-`));
  const root = path.join(state, 'voice');
  const logs = { py: path.join(state, 'py.log'), uv: path.join(state, 'uv.log'), sidecar: path.join(state, 'sidecar.log') };
  const fullEnv = { ...process.env, FAKE_PY_LOG: logs.py, FAKE_UV_LOG: logs.uv, FAKE_SIDECAR_LOG: logs.sidecar, FAKE_PY_SRC: FAKEPY, ...env };
  const which = (n) => ({ python3: python ? FAKEPY : null, tar: TAR }[n] || null);
  const inst = new CloneInstaller({
    root,
    env: fullEnv,
    which,
    assets: CAT.assets,
    uvAssets: CAT.uvAssets,
    uvBase: `${BASE}/uv/`,
    assetBase: base,
    defaultBase: `${BASE}/missing/`,
    arch: 'x64',
    platformInfo: { platform: process.platform, isWSL: false },
    ...opts,
  });
  inst.logs = logs;
  inst.state = state;
  return inst;
}

function lines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const hitCount = (prefix) => [...hits.entries()].filter(([u]) => u.startsWith(prefix)).reduce((n, [, c]) => n + c, 0);

// ------------------------------------------------------------------ tests

test('models.js: the catalog, required assets, URLs and load parameters', () => {
  for (const [id, a] of Object.entries(models.ASSETS)) {
    assert.equal(a.id, id);
    assert.match(a.sha256, /^[0-9a-f]{64}$/, id);
    assert.ok(Number.isInteger(a.bytes) && a.bytes > 100000, id);
    assert.ok(Object.keys(a.files).length > 0, id);
    assert.ok(a.license, id);
    assert.ok(!a.path.startsWith('/') && !a.path.includes('..'), id);
  }
  assert.deepEqual(models.requiredAssets(), ['silero-vad', 'spk-3dspeaker', 'pocket-int8', 'moonshine-base-int8']);
  assert.deepEqual(models.requiredAssets({ voice: { clone: { engine: 'zipvoice' } }, calls: { stt: { model: 'parakeet' } } }), ['silero-vad', 'spk-3dspeaker', 'pocket-int8', 'parakeet-v2-int8', 'zipvoice-int8', 'vocos-24k']);
  assert.deepEqual(models.requiredAssets({ engine: 'nope', stt: 'whisper-tiny', extras: ['whisper-tiny-en', 'bogus'] }), ['silero-vad', 'spk-3dspeaker', 'pocket-int8', 'whisper-tiny-en']);
  // About 425 MB with the wheels (design §0): the models alone are 389 MB.
  assert.equal(models.totalBytes(models.requiredAssets()), 389381444);
  assert.deepEqual(models.assetUrls('silero-vad', { env: {} }), ['https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx']);
  assert.deepEqual(models.assetUrls('silero-vad', { env: { ANYWHERE_CLONE_ASSET_BASE: 'https://mirror.example/sherpa' } }), ['https://mirror.example/sherpa/asr-models/silero_vad.onnx', 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx']);
  assert.match(models.assetUrls('spk-3dspeaker', { env: {} })[0], /speaker-recongition-models\//);
  assert.throws(() => models.getAsset('xtts'), { code: 'BAD_ASSET' });

  const root = path.join(HOME, 'm');
  const p = models.assetPaths('pocket-int8', root);
  assert.equal(p.dir, path.join(root, 'pocket-int8'));
  assert.equal(p.files.lm_main, path.join(root, 'pocket-int8', 'lm_main.int8.onnx'));
  assert.equal(p.benchReference, path.join(root, 'pocket-int8', 'test_wavs', 'bria.wav'));
  const t = models.ttsLoadParams('zipvoice', root, { threads: 4, steps: 0 });
  assert.equal(t.engine, 'zipvoice');
  assert.equal(t.steps, 3);
  assert.equal(t.vocoder, path.join(root, 'vocos-24k', 'vocos_24khz.onnx'));
  assert.equal(t.files.data_dir, path.join(root, 'zipvoice-int8', 'espeak-ng-data'));
  assert.equal(models.ttsLoadParams('anything', root).engine, 'pocket');
  assert.equal(models.asrLoadParams('parakeet', root).model, 'parakeet');
  assert.equal(models.asrLoadParams('whisper-tiny', root).files.encoder, path.join(root, 'whisper-tiny-en', 'tiny.en-encoder.int8.onnx'));
  assert.equal(models.spkLoadParams(root).model, path.join(root, 'spk-3dspeaker', '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'));
  assert.deepEqual(models.vadLoadParams(root, { minSilenceMs: 800 }), { model: path.join(root, 'silero-vad', 'silero_vad.onnx'), threshold: 0.5, minSilenceMs: 800, minSpeechMs: 250 });
  const u = models.uvAsset('win32', 'x64', { env: {} });
  assert.equal(u.kind, 'zip');
  assert.equal(u.exe, 'uv.exe');
  assert.match(u.url, /astral-sh\/uv\/releases\/download\/0\.11\.32\/uv-x86_64-pc-windows-msvc\.zip$/);
  assert.equal(models.uvAsset('sunos', 'x64'), null);
});

test('piper findPython: version range, preferred interpreter, Windows Store stub, macOS CLT stub', async () => {
  const versions = { '/py/3.8': '3.8', '/py/3.15': '3.15', '/py/3.12': '3.12', '/py/custom': '3.11' };
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === '/usr/bin/xcode-select') return { code: 2, stdout: '' };
    return versions[cmd] ? { code: 0, stdout: `${versions[cmd]}\n` } : { code: 1, stdout: '', error: null };
  };
  const which = (map) => (n) => map[n] || null;
  let r = await piper.findPython({ env: {}, runner, which: which({ python3: '/py/3.8', python: '/py/3.12' }), platform: 'linux' });
  assert.deepEqual(r, { cmd: '/py/3.12', args: [], version: '3.12' });
  r = await piper.findPython({ env: {}, runner, which: which({ python3: '/py/3.15' }), platform: 'linux', max: [3, 14] });
  assert.equal(r, null);
  r = await piper.findPython({ env: { ANYWHERE_PYTHON: '/py/3.12' }, runner, which: which({ python3: '/py/3.15' }), platform: 'linux', preferred: [['/py/custom', []]], max: [3, 14] });
  assert.equal(r.cmd, '/py/custom', 'the configured interpreter comes first');
  r = await piper.findPython({ env: {}, runner, which: which({ python3: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe', py: '/py/3.12' }), platform: 'win32' });
  assert.deepEqual(r, { cmd: '/py/3.12', args: ['-3'], version: '3.12' });
  r = await piper.findPython({ env: {}, runner, which: which({ python3: '/usr/bin/python3' }), platform: 'darwin' });
  assert.equal(r, null, 'the macOS stub is not run without the Command Line Tools');
  assert.ok(!calls.some((c) => c[0] === '/usr/bin/python3'));
  // Piper's own probe still works through the shared function.
  const pm = new piper.PiperManager({ env: {}, runner, which: which({ python3: '/py/3.12' }), platformInfo: { platform: 'linux' } });
  assert.equal((await pm.findPython()).version, '3.12');
});

test('wslToWindowsPath, windowsToWslPath and withWslEnv', () => {
  assert.equal(wslToWindowsPath('/mnt/c/Users/Deep/.claude-anywhere/voice', 'Ubuntu'), 'C:\\Users\\Deep\\.claude-anywhere\\voice');
  assert.equal(wslToWindowsPath('/mnt/d', 'Ubuntu'), 'D:\\');
  assert.equal(wslToWindowsPath('/home/deep/.claude-anywhere', 'Ubuntu-24.04'), '\\\\wsl.localhost\\Ubuntu-24.04\\home\\deep\\.claude-anywhere');
  assert.equal(windowsToWslPath('C:\\Users\\Deep'), '/mnt/c/Users/Deep');
  assert.equal(windowsToWslPath('D:\\'), '/mnt/d');
  assert.equal(windowsToWslPath('\\\\server\\share'), null);
  assert.deepEqual(withWslEnv({ WSLENV: 'WT_SESSION:USERPROFILE/p' }, ['OMP_NUM_THREADS', 'UV_CACHE_DIR/p', 'USERPROFILE']).WSLENV, 'WT_SESSION:USERPROFILE/p:OMP_NUM_THREADS:UV_CACHE_DIR/p');
});

test('the WSL layout keeps the runtime on the Windows side', { skip: process.platform === 'win32' && 'POSIX paths' }, async () => {
  const state = fs.mkdtempSync(path.join(HOME, 'wsl-'));
  const spawnCalls = [];
  const spawnSyncFake = (cmd, args) => {
    spawnCalls.push([cmd, ...args]);
    return { status: 0, stdout: 'C:\\Users\\Deep\r\n', stderr: '' };
  };
  const env = { PATH: process.env.PATH, WSL_DISTRO_NAME: 'Ubuntu-24.04', WSLENV: 'WT_SESSION' };
  const inst = new CloneInstaller({ root: path.join(state, 'voice'), env, platformInfo: { platform: 'linux', isWSL: true }, which: (n) => (n === 'python3' ? '/usr/bin/python3' : null), spawnSync: spawnSyncFake });
  const lay = await inst.layout();
  assert.equal(lay.kind, 'wsl');
  assert.equal(lay.root, '/mnt/c/Users/Deep/.claude-anywhere/voice');
  assert.equal(inst.venvPython(), '/mnt/c/Users/Deep/.claude-anywhere/voice/clone-venv/Scripts/python.exe');
  assert.equal(inst.modelsRoot, '/mnt/c/Users/Deep/.claude-anywhere/voice/clone-models');
  assert.equal(spawnCalls.length, 1);
  assert.match(spawnCalls[0][0], /cmd\.exe$/);
  await assert.rejects(inst.sidecarSpec(), { code: 'NOT_INSTALLED' });
  const spec = await inst.sidecarSpec({ fake: true, threads: 3 });
  assert.deepEqual(spec.args, ['--state', `\\\\wsl.localhost\\Ubuntu-24.04${state.replace(/\//g, '\\')}`, '--models', 'C:\\Users\\Deep\\.claude-anywhere\\voice\\clone-models']);
  assert.equal(spec.windowsChild, true);
  assert.match(spec.taskkill, /taskkill\.exe$/);
  assert.equal(spec.env.OMP_NUM_THREADS, '3');
  assert.deepEqual(spec.env.WSLENV.split(':').slice(0, 3), ['WT_SESSION', 'OMP_NUM_THREADS', 'PYTHONNOUSERSITE']);
  assert.ok(spec.env.WSLENV.split(':').includes('ANYWHERE_CLONE_FAKE'));
  assert.equal(spec.toChildPath('/mnt/c/x/y.wav'), 'C:\\x\\y.wav');

  // ANYWHERE_CLONE_WSL=linux, or no interop: the runtime stays inside WSL.
  const linux = new CloneInstaller({ root: path.join(state, 'voice'), env: { ...env, ANYWHERE_CLONE_WSL: 'linux' }, platformInfo: { platform: 'linux', isWSL: true }, spawnSync: spawnSyncFake });
  assert.equal((await linux.layout()).kind, 'native');
  const broken = new CloneInstaller({ root: path.join(state, 'voice'), env, platformInfo: { platform: 'linux', isWSL: true }, spawnSync: () => ({ status: 1, stdout: '', error: new Error('ENOENT') }) });
  const lb = await broken.layout();
  assert.equal(lb.kind, 'native');
  assert.match(lb.note, /interop/);
  assert.equal(lb.venvPython, path.join(state, 'voice', 'clone-venv', 'bin', 'python'));
});

test('full install: stages in order, verified and pruned models, verify, bench; a second run does nothing', { skip: SKIP }, async () => {
  const inst = makeInstaller();
  const before = await inst.status();
  assert.equal(before.installed, false);
  assert.deepEqual(before.missing, ['silero-vad', 'spk-3dspeaker', 'pocket-int8', 'moonshine-base-int8']);
  await assert.rejects(inst.sidecarSpec(), { code: 'NOT_INSTALLED' });

  const progress = [];
  const r = await inst.install({ engine: 'pocket', stt: 'moonshine', onProgress: (p) => progress.push(p) });
  assert.equal(r.ok, true);
  assert.equal(r.python, '3.12.9');
  assert.deepEqual(r.downloaded, ['silero-vad', 'spk-3dspeaker', 'pocket-int8', 'moonshine-base-int8']);

  const stages = [...new Set(progress.map((p) => p.stage))];
  assert.deepEqual(stages, ['python', 'venv', 'pip', 'models', 'verify', 'bench', 'done']);
  for (let i = 1; i < progress.length; i += 1) assert.ok(progress[i].percent >= progress[i - 1].percent, `percent never goes back: ${JSON.stringify(progress[i])}`);
  assert.equal(progress[progress.length - 1].percent, 100);
  assert.ok(progress.some((p) => p.stage === 'models' && p.asset === 'pocket-int8'));
  assert.ok(progress.some((p) => p.stage === 'pip' && /pip: Successfully installed/.test(p.message)));

  // Only the files the runtime uses are kept.
  const pocket = path.join(inst.modelsDir(), 'pocket-int8');
  const kept = [];
  const walk = (d, pre = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${pre}${e.name}/`);
      else kept.push(`${pre}${e.name}`);
    }
  };
  walk(pocket);
  assert.deepEqual(kept.sort(), ['.installed.json', 'LICENSE', 'README.md', 'decoder.int8.onnx', 'encoder.onnx', 'lm_flow.int8.onnx', 'lm_main.int8.onnx', 'test_wavs/bria.wav', 'text_conditioner.onnx', 'token_scores.json', 'vocab.json'].sort());
  const marker = JSON.parse(fs.readFileSync(path.join(pocket, '.installed.json'), 'utf8'));
  assert.equal(marker.sha256, CAT.assets['pocket-int8'].sha256);
  assert.equal(fs.readFileSync(path.join(inst.modelsDir(), 'silero-vad', 'silero_vad.onnx'), 'utf8'), 'model bytes of silero-vad'.repeat(50));
  assert.deepEqual(fs.readdirSync(path.join(inst.modelsDir(), 'downloads')), [], 'no leftover downloads');
  assert.ok(!fs.readdirSync(inst.modelsDir()).some((n) => n.startsWith('.staging') || n.startsWith('.new')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(inst.modelsDir()).mode & 0o777, 0o700);

  // The venv was made with the system python, packages from requirements.txt, binary wheels only.
  const py = lines(inst.logs.py);
  assert.ok(py.some((l) => l.self === FAKEPY && l.args[0] === '-m' && l.args[1] === 'venv'));
  const pip = py.find((l) => l.args.includes('-r'));
  assert.deepEqual(pip.args.slice(0, 3), ['-I', '-m', 'pip']);
  assert.ok(pip.args.includes('--only-binary=:all:'));
  assert.equal(pip.args[pip.args.indexOf('-r') + 1], path.join(__dirname, '..', 'src', 'voice', 'clone', 'requirements.txt'));

  // Verify loaded the engine and the recognizer through the sidecar protocol.
  const sc = lines(inst.logs.sidecar);
  assert.deepEqual(sc.filter((q) => q.op !== 'bench').map((q) => q.op), ['models.check', 'tts.load', 'asr.load', 'shutdown', 'shutdown'].slice(0, sc.filter((q) => q.op !== 'bench').length));
  assert.equal(sc.find((q) => q.op === 'tts.load').engine, 'pocket');
  assert.equal(sc.find((q) => q.op === 'asr.load').model, 'moonshine');

  const st = await inst.status();
  assert.equal(st.installed, true);
  assert.deepEqual(st.missing, []);
  assert.equal(st.runtime.via, 'venv');
  assert.equal(st.runtime.sherpa, '1.13.8');
  assert.deepEqual(st.engines, { pocket: true, zipvoice: false });
  assert.equal(st.stt.moonshine, true);
  assert.equal(st.stt.parakeet, false);
  assert.equal(st.bench.recommended.pocket.threads, 2);
  assert.equal(st.bench.recommended.pocket.realtime, true);
  assert.ok(st.bench.engines.pocket.runs.length >= 2);
  assert.deepEqual(r.bench, st.bench);

  // Second run: nothing to download, the venv is reused.
  const hitsBefore = hitCount('/good/');
  const venvBefore = py.filter((l) => l.args[1] === 'venv').length;
  const again = await inst.install({ bench: false });
  assert.deepEqual(again.downloaded, []);
  assert.equal(hitCount('/good/'), hitsBefore);
  assert.equal(lines(inst.logs.py).filter((l) => l.args[1] === 'venv').length, venvBefore);

  // The sidecar spec now points at the venv.
  const spec = await inst.sidecarSpec({ config: { voice: { clone: { threads: 3 } } } });
  assert.equal(spec.python, inst.venvPython());
  assert.equal(spec.script, path.join(__dirname, '..', 'src', 'voice', 'clone', 'sidecar.py'));
  assert.deepEqual(spec.args, ['--state', inst.state, '--models', inst.modelsDir()]);
  assert.equal(spec.env.OMP_NUM_THREADS, '3');
  assert.equal(spec.env.ANYWHERE_CLONE_FAKE, undefined);
  const fake = await inst.sidecarSpec({ fake: true });
  assert.equal(fake.env.ANYWHERE_CLONE_FAKE, '1');
  assert.notEqual(fake.python, inst.venvPython());
  const client = await inst.startSidecar();
  assert.equal(client.info.sherpa, '1.13.8');
  await client.stop();
});

test('the opt-in ZipVoice adds its two assets; bench marks it live only at RTF ≤ 0.75', { skip: SKIP }, async () => {
  const inst = makeInstaller();
  await inst.install({ bench: false });
  const r = await inst.install({ engine: 'zipvoice' });
  assert.deepEqual(r.downloaded, ['zipvoice-int8', 'vocos-24k']);
  const st = await inst.status({ engine: 'zipvoice' });
  assert.deepEqual(st.engines, { pocket: true, zipvoice: true });
  assert.ok(fs.existsSync(path.join(inst.modelsDir(), 'zipvoice-int8', 'espeak-ng-data', 'en_dict')), 'data folders are kept whole');
  assert.ok(fs.existsSync(path.join(inst.modelsDir(), 'zipvoice-int8', 'test_wavs', 'prompt.txt')));
  assert.deepEqual(st.bench.recommended.zipvoice, { threads: 4, steps: 2, rtf: 0.6, live: true });
  const runs = st.bench.engines.zipvoice.runs;
  assert.deepEqual(runs.map((x) => `${x.threads}:${x.steps}`), ['2:2', '2:3', '4:2', '4:3']);
  assert.equal(await inst.removeAsset('zipvoice-int8'), true);
  assert.equal((await inst.status()).engines.zipvoice, false);
});

test('a sha256 mismatch fails with an actionable error after one fresh retry', { skip: SKIP }, async () => {
  const inst = makeInstaller();
  const url = `/good/${CAT.assets['silero-vad'].path}`;
  corrupt.add(url);
  const before = hits.get(url) || 0;
  try {
    await assert.rejects(inst.installAsset('silero-vad'), (err) => {
      assert.equal(err.code, 'CHECKSUM_MISMATCH');
      assert.match(err.message, /upstream file changed/);
      assert.match(err.hint, /Update Claude Anywhere/);
      return true;
    });
  } finally {
    corrupt.delete(url);
  }
  assert.equal((hits.get(url) || 0) - before, 2);
  assert.equal((await inst.status()).assets['silero-vad'].installed, false);
  assert.equal(fs.existsSync(path.join(inst.modelsDir(), 'silero-vad')), false);
});

test('a partial download resumes with a Range request', { skip: SKIP }, async () => {
  const inst = makeInstaller();
  const a = CAT.assets['spk-3dspeaker'];
  const body = CAT.files.get(`/good/${a.path}`);
  const part = path.join(inst.modelsDir(), 'downloads', `${path.posix.basename(a.path)}.part`);
  fs.mkdirSync(path.dirname(part), { recursive: true });
  fs.writeFileSync(part, body.subarray(0, 300));
  const n = ranges.length;
  await inst.installAsset('spk-3dspeaker');
  assert.deepEqual(ranges.slice(n), [{ url: `/good/${a.path}`, range: 'bytes=300-' }]);
  assert.equal(fs.readFileSync(models.assetPaths('spk-3dspeaker', inst.modelsDir()).files.model, 'utf8'), body.toString());
});

test('sources: the mirror, then the next base; a file placed by hand; every source failing', { skip: SKIP }, async () => {
  const inst = makeInstaller({ base: `${BASE}/missing/`, env: { ANYWHERE_CLONE_ASSET_BASE: `${BASE}/alt/` } });
  const a = CAT.assets['silero-vad'];
  await inst.installAsset('silero-vad');
  assert.equal(hits.get(`/missing/${a.path}`) >= 1, true);
  assert.equal(hits.get(`/alt/${a.path}`) >= 1, true);
  const marker = JSON.parse(fs.readFileSync(path.join(inst.modelsDir(), 'silero-vad', '.installed.json'), 'utf8'));
  assert.equal(marker.url, `${BASE}/alt/${a.path}`);

  // Placed by hand (locked-down network): used without any request when the sha256 matches.
  const offline = makeInstaller({ base: `${BASE}/missing/` });
  const b = CAT.assets['spk-3dspeaker'];
  const dl = path.join(offline.modelsDir(), 'downloads', path.posix.basename(b.path));
  fs.mkdirSync(path.dirname(dl), { recursive: true });
  fs.writeFileSync(dl, CAT.files.get(`/good/${b.path}`));
  const n = hits.get(`/missing/${b.path}`) || 0;
  await offline.installAsset('spk-3dspeaker');
  assert.equal(hits.get(`/missing/${b.path}`) || 0, n);
  assert.equal((await offline.status()).assets['spk-3dspeaker'].installed, true);

  // A wrong file placed by hand is replaced by a download; with no source left the error says where to put it.
  fs.writeFileSync(path.join(offline.modelsDir(), 'downloads', path.posix.basename(CAT.assets['silero-vad'].path)), 'wrong');
  await assert.rejects(offline.installAsset('silero-vad'), (err) => {
    assert.equal(err.code, 'NOT_FOUND');
    assert.match(err.hint, /put it at .*downloads/);
    return true;
  });
});

test('no Python: uv is downloaded (pinned sha256) and makes the venv with its own Python', { skip: SKIP }, async () => {
  const inst = makeInstaller({ python: false });
  const r = await inst.install({ bench: false });
  assert.equal(r.ok, true);
  const st = await inst.status();
  assert.equal(st.installed, true);
  assert.equal(st.runtime.via, 'uv');
  const uv = lines(inst.logs.uv);
  const venv = uv.find((l) => l.args[0] === 'venv');
  assert.deepEqual(venv.args.slice(0, 3), ['venv', '--python', '3.12']);
  assert.equal(venv.env.py, path.join(inst.state, 'voice', 'python'));
  assert.equal(venv.env.cache, path.join(inst.state, 'voice', 'uv-cache'));
  assert.equal(venv.env.noConfig, '1');
  assert.equal(venv.env.pref, 'only-managed');
  const pip = uv.find((l) => l.args[0] === 'pip');
  assert.ok(pip.args.includes('--only-binary') && pip.args.includes('-r'));
  assert.ok(fs.existsSync(path.join(inst.state, 'voice', 'bin', 'uv')));
  assert.equal(hits.get('/uv/uv-fake.tar.gz') >= 1, true);
  assert.equal(fs.existsSync(path.join(inst.state, 'voice', 'downloads', 'uv-fake.tar.gz')), false);

  // The next install reuses the downloaded uv.
  const n = hits.get('/uv/uv-fake.tar.gz');
  fs.rmSync(path.join(inst.state, 'voice', 'clone-venv'), { recursive: true });
  await inst.install({ bench: false, verify: false });
  assert.equal(hits.get('/uv/uv-fake.tar.gz'), n);
});

test('uv also covers a broken venv module and a Python without sherpa-onnx wheels', { skip: SKIP }, async () => {
  const noVenv = makeInstaller({ env: { FAKE_VENV_FAIL: '1' } });
  const progress = [];
  await noVenv.install({ bench: false, onProgress: (p) => progress.push(p) });
  assert.equal((await noVenv.status()).runtime.via, 'uv');
  assert.ok(progress.some((p) => /ensurepip/.test(p.message) && /uv/.test(p.message)));

  const noWheel = makeInstaller({ env: { FAKE_PIP_FAIL: 'nowheel' } });
  await noWheel.install({ bench: false, verify: false });
  assert.equal((await noWheel.status()).runtime.via, 'uv');
});

test('no Python and no uv for this machine: NO_PYTHON with install advice', { skip: SKIP }, async () => {
  const inst = makeInstaller({ python: false, uvAssets: {} });
  const progress = [];
  await assert.rejects(inst.install({ onProgress: (p) => progress.push(p) }), (err) => {
    assert.equal(err.code, 'NO_PYTHON');
    assert.match(err.hint, /Python/);
    return true;
  });
  assert.equal(progress[progress.length - 1].stage, 'error');
  assert.equal(hitCount('/good/tiny/sherpa-onnx-pocket'), hitCount('/good/tiny/sherpa-onnx-pocket'), 'no model was downloaded before the runtime failed');
  // pip failing for another reason keeps its own hint.
  const net = makeInstaller({ env: { FAKE_PIP_FAIL: 'net' }, uvAssets: {} });
  await assert.rejects(net.install({ bench: false }), (err) => err.code === 'PIP_FAILED' && /internet/.test(err.hint));
});

test('a changed requirements file reinstalls the packages into the same venv', { skip: SKIP }, async () => {
  const inst = makeInstaller();
  await inst.install({ bench: false });
  const rtFile = path.join(inst.state, 'voice', 'clone-venv', 'anywhere-runtime.json');
  const rt = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
  fs.writeFileSync(rtFile, JSON.stringify({ ...rt, requirementsSha: 'older' }));
  const st = await inst.status();
  assert.equal(st.installed, false);
  assert.equal(st.runtime.outdated, true);
  const venvs = lines(inst.logs.py).filter((l) => l.args[1] === 'venv').length;
  const pips = lines(inst.logs.py).filter((l) => l.args.includes('-r')).length;
  await inst.install({ bench: false, verify: false });
  assert.equal(lines(inst.logs.py).filter((l) => l.args[1] === 'venv').length, venvs, 'the venv is reused');
  assert.equal(lines(inst.logs.py).filter((l) => l.args.includes('-r')).length, pips + 1);
  assert.equal((await inst.status()).installed, true);
});

test('one install at a time; an AbortSignal cancels; an unpack failure is reported', { skip: SKIP }, async () => {
  const inst = makeInstaller();
  const slow = `/good/${CAT.assets['silero-vad'].path}`;
  delays.set(slow, 600);
  try {
    const ac = new AbortController();
    const first = assert.rejects(inst.install({ signal: ac.signal, bench: false }), { code: 'ABORTED' });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(inst.install(), { code: 'INSTALL_BUSY' });
    const waitDownload = Date.now() + 5000;
    while (!(inst.installing && inst.installing.stage === 'models') && Date.now() < waitDownload) await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await first;
  } finally {
    delays.delete(slow);
  }
  assert.equal(inst.installing, null);
  // The lock is released: a new install proceeds.
  await inst.install({ bench: false, verify: false });

  const badTar = makeInstaller({ which: (n) => (n === 'tar' ? '/bin/false' : n === 'python3' ? FAKEPY : null) });
  await assert.rejects(badTar.installAsset('pocket-int8'), (err) => err.code === 'EXTRACT_FAILED' && /bzip2/.test(err.hint));
  assert.equal(fs.existsSync(path.join(badTar.modelsDir(), 'pocket-int8')), false);
});

test('bench before an install is refused; uninstall removes the runtime but not the profile', { skip: SKIP }, async () => {
  const inst = makeInstaller();
  await assert.rejects(inst.bench(), { code: 'NOT_INSTALLED' });
  await inst.install({ bench: false });
  await assert.rejects(inst.bench({ engine: 'zipvoice' }), { code: 'MODEL_MISSING' });
  const profile = path.join(inst.state, 'voice', 'clone', 'profiles', 'default');
  fs.mkdirSync(profile, { recursive: true });
  await inst.uninstall();
  const st = await inst.status();
  assert.equal(st.runtime.venv, false);
  assert.equal(st.installed, false);
  assert.ok(fs.existsSync(profile), 'the voice profile is separate (profile.js deletes it)');
});
