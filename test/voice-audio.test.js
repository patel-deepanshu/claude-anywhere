'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-audio-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const { AudioPlayer, buildPlayCommand, soundPlayerScript, mntToWindowsPath, LINUX_PLAYERS } = require('../src/os/audio');
const chime = require('../src/daemon/chime');
const { wavInfo } = require('../src/daemon/piper');

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const OK = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: null };
const WAV = path.join(HOME, 'sound.wav');
fs.writeFileSync(WAV, chime.chimeWav('done'));

function fakeRunner(behavior) {
  const calls = [];
  const runner = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve(behavior ? behavior(cmd, args, opts, calls.length) : OK);
  };
  runner.calls = calls;
  return runner;
}

/** Resolves only when aborted (a long sound being stopped). */
const untilAborted = (cmd, args, opts) =>
  new Promise((resolve) => {
    if (opts.onStdout) opts.onStdout(Buffer.from('ANYWHERE_PID 777\r\n'));
    if (!opts.signal) return resolve(OK);
    opts.signal.addEventListener('abort', () => resolve({ ...OK, code: null, signal: 'SIGTERM', aborted: true }));
  });

// ------------------------------------------------------------------ command construction

test('buildPlayCommand: one command per player, device where the player supports it', () => {
  assert.deepEqual(buildPlayCommand('afplay', '/tmp/a.wav', { bin: '/usr/bin/afplay', device: 'X' }), { cmd: '/usr/bin/afplay', args: ['/tmp/a.wav'], player: 'afplay' });
  assert.deepEqual(buildPlayCommand('pw-play', '/a.wav').args, ['/a.wav']);
  assert.deepEqual(buildPlayCommand('pw-play', '/a.wav', { device: 'alsa_output.usb' }).args, ['--target', 'alsa_output.usb', '/a.wav']);
  assert.deepEqual(buildPlayCommand('paplay', '/a.wav', { device: 'sink1' }).args, ['--device=sink1', '/a.wav']);
  assert.deepEqual(buildPlayCommand('aplay', '/a.wav').args, ['-q', '/a.wav']);
  assert.deepEqual(buildPlayCommand('aplay', '/a.wav', { device: 'hw:1,0' }).args, ['-q', '-D', 'hw:1,0', '/a.wav']);
  assert.deepEqual(buildPlayCommand('ffplay', '/a.wav').args, ['-nodisp', '-autoexit', '-loglevel', 'error', '/a.wav']);
  assert.throws(() => buildPlayCommand('vlc', '/a.wav'), /Unknown audio player/);
});

test('Windows SoundPlayer: PlaySync through -EncodedCommand, the path quoted, the PID printed first', () => {
  const win = "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\a b.wav";
  const c = buildPlayCommand('soundplayer', win, { bin: 'C:\\ps.exe' });
  assert.equal(c.cmd, 'C:\\ps.exe');
  assert.deepEqual(c.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  const script = Buffer.from(c.args[5], 'base64').toString('utf16le');
  assert.equal(script, soundPlayerScript(win));
  assert.match(script, /^\$ErrorActionPreference = 'Stop'; \[Console\]::Out\.WriteLine\('ANYWHERE_PID ' \+ \$PID\)/);
  assert.match(script, /New-Object System\.Media\.SoundPlayer 'C:\\Users\\O''Brien\\AppData\\Local\\Temp\\a b\.wav'/);
  assert.match(script, /\$p\.PlaySync\(\)/);
});

test('mntToWindowsPath converts /mnt/<drive> paths only', () => {
  assert.equal(mntToWindowsPath('/mnt/c/Users/me/a.wav'), 'C:\\Users\\me\\a.wav');
  assert.equal(mntToWindowsPath('/mnt/d'), 'D:\\');
  assert.equal(mntToWindowsPath('/home/me/a.wav'), null);
  assert.equal(mntToWindowsPath('/mnt/wsl/x'), null);
});

// ------------------------------------------------------------------ players per platform

test('macOS plays with afplay', async () => {
  const runner = fakeRunner();
  const p = new AudioPlayer({ platformInfo: { platform: 'darwin' }, which: (n) => (n === 'afplay' ? '/usr/bin/afplay' : null), runner });
  assert.deepEqual(await p.playFile(WAV), { ok: true, player: 'afplay' });
  assert.equal(runner.calls[0].cmd, '/usr/bin/afplay');
  assert.deepEqual(runner.calls[0].args, [WAV]);
});

test('Windows plays with PowerShell SoundPlayer; a failure explains the audio device', async () => {
  const runner = fakeRunner();
  const p = new AudioPlayer({ platformInfo: { platform: 'win32' }, which: (n) => (n === 'powershell' ? 'C:\\WINDOWS\\ps.exe' : null), runner });
  assert.deepEqual(await p.playFile(WAV), { ok: true, player: 'soundplayer' });
  assert.equal(runner.calls[0].cmd, 'C:\\WINDOWS\\ps.exe');
  assert.match(Buffer.from(runner.calls[0].args[5], 'base64').toString('utf16le'), new RegExp(path.basename(WAV)));

  const failing = new AudioPlayer({
    platformInfo: { platform: 'win32' },
    which: (n) => (n === 'powershell' ? 'C:\\ps.exe' : null),
    runner: fakeRunner(() => ({ ...OK, code: 1, stderr: 'Exception calling "PlaySync"' })),
  });
  await assert.rejects(failing.playFile(WAV), (err) => err.code === 'PLAY_FAILED' && /audio output device/.test(err.hint));
});

test('WSL: the Windows path comes from wslpath -w (or /mnt/<drive> directly) and stop() taskkills the Windows PID', async () => {
  const runner = fakeRunner((cmd, args, opts) => {
    if (/wslpath$/.test(cmd)) return { ...OK, stdout: '\\\\wsl.localhost\\Ubuntu\\tmp\\sound.wav\n' };
    return untilAborted(cmd, args, opts);
  });
  const which = (n) => ({ 'powershell.exe': '/mnt/c/ps.exe', wslpath: '/usr/bin/wslpath', 'taskkill.exe': '/mnt/c/taskkill.exe' })[n] || null;
  const p = new AudioPlayer({ platformInfo: { platform: 'linux', isWSL: true }, which, runner });
  const playing = p.playFile(WAV);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.isPlaying(), true);
  assert.deepEqual(runner.calls[0].args, ['-w', path.resolve(WAV)]);
  assert.equal(runner.calls[1].cmd, '/mnt/c/ps.exe');
  assert.match(Buffer.from(runner.calls[1].args[5], 'base64').toString('utf16le'), /'\\\\wsl\.localhost\\Ubuntu\\tmp\\sound\.wav'/);
  assert.equal(p.stop(), true);
  assert.deepEqual(await playing, { ok: true, player: 'soundplayer', stopped: true });
  const kill = runner.calls.find((c) => c.cmd === '/mnt/c/taskkill.exe');
  assert.ok(kill, 'taskkill.exe ends the Windows process');
  assert.deepEqual(kill.args, ['/PID', '777', '/T', '/F']);

  // A file under /mnt/c needs no wslpath.
  const r2 = fakeRunner();
  const p2 = new AudioPlayer({ platformInfo: { platform: 'linux', isWSL: true }, which, runner: r2, isFile: () => true });
  await p2.playFile('/mnt/c/Users/me/a.wav');
  assert.equal(r2.calls.length, 1);
  assert.match(Buffer.from(r2.calls[0].args[5], 'base64').toString('utf16le'), /'C:\\Users\\me\\a\.wav'/);
});

test('Linux tries pw-play, paplay, aplay, ffplay in order, falls through failures and remembers what worked', async () => {
  const which = (n) => (LINUX_PLAYERS.includes(n) ? `/usr/bin/${n}` : null);
  const runner = fakeRunner((cmd) => {
    if (cmd.endsWith('pw-play')) return { ...OK, code: 1, stderr: 'pw-play: error: Host is down' };
    if (cmd.endsWith('paplay')) return { ...OK, code: 1, stderr: 'Connection failure: Connection refused' };
    return OK;
  });
  const p = new AudioPlayer({ platformInfo: { platform: 'linux', isWSL: false }, which, runner });
  assert.deepEqual(await p.playFile(WAV), { ok: true, player: 'aplay' });
  assert.deepEqual(runner.calls.map((c) => path.basename(c.cmd)), ['pw-play', 'paplay', 'aplay']);
  await p.playFile(WAV);
  assert.equal(path.basename(runner.calls[3].cmd), 'aplay', 'the player that worked goes first next time');

  // Device selection reaches the player.
  const r2 = fakeRunner();
  await new AudioPlayer({ platformInfo: { platform: 'linux' }, which: (n) => (n === 'paplay' ? '/usr/bin/paplay' : null), runner: r2 }).playFile(WAV, { device: 'bluez_sink.headset' });
  assert.deepEqual(r2.calls[0].args, ['--device=bluez_sink.headset', path.resolve(WAV)]);

  // Every player failing: one error with each reason and an install hint.
  const all = new AudioPlayer({ platformInfo: { platform: 'linux' }, which, runner: fakeRunner(() => ({ ...OK, code: 1, stderr: 'no device' })) });
  await assert.rejects(all.playFile(WAV), (err) => err.code === 'PLAY_FAILED' && /pw-play: exit 1: no device/.test(err.message) && /ffplay/.test(err.message) && /PipeWire/.test(err.hint));
});

test('ffplay exiting 0 without an audio device is a failure, not a played sound', async () => {
  const which = (n) => (n === 'ffplay' ? '/usr/bin/ffplay' : null);
  const stderr = "ALSA lib confmisc.c:855:(parse_card) cannot find card '0'\nNo more combinations to try, audio open failed\nFailed to open file '/a.wav' or configure filtergraph\n";
  const p = new AudioPlayer({ platformInfo: { platform: 'linux' }, which, runner: fakeRunner(() => ({ ...OK, code: 0, stderr })) });
  await assert.rejects(p.playFile(WAV), (err) => err.code === 'PLAY_FAILED' && /ffplay: no audio device/.test(err.message) && /audio open failed/.test(err.message));
  // ALSA chatter alone (a device that still opened) is a success.
  const ok = new AudioPlayer({ platformInfo: { platform: 'linux' }, which, runner: fakeRunner(() => ({ ...OK, code: 0, stderr: "ALSA lib pcm.c:2721: something\n" })) });
  assert.deepEqual(await ok.playFile(WAV), { ok: true, player: 'ffplay' });
});

test('no player, or no file: actionable errors', async () => {
  const none = new AudioPlayer({ platformInfo: { platform: 'linux' }, which: () => null, runner: fakeRunner() });
  await assert.rejects(none.playFile(WAV), (err) => err.code === 'NO_PLAYER' && /pipewire|pulseaudio|alsa-utils/i.test(err.hint));
  assert.deepEqual(await none.status(), { available: false, players: [], hint: none.hint() });
  const mac = new AudioPlayer({ platformInfo: { platform: 'darwin' }, which: () => '/usr/bin/afplay', runner: fakeRunner() });
  await assert.rejects(mac.playFile(path.join(HOME, 'missing.wav')), (err) => err.code === 'ENOENT');
  assert.deepEqual(await mac.status(), { available: true, players: ['afplay'] });
});

test('one sound at a time: a new playFile() stops the one playing', async () => {
  const runner = fakeRunner(untilAborted);
  const p = new AudioPlayer({ platformInfo: { platform: 'darwin' }, which: () => '/usr/bin/afplay', runner });
  const first = p.playFile(WAV);
  await new Promise((r) => setImmediate(r));
  const second = p.playFile(WAV);
  assert.deepEqual(await first, { ok: true, player: 'afplay', stopped: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(p.stop(), true);
  assert.equal((await second).stopped, true);
  assert.equal(p.stop(), false, 'nothing left to stop');
  assert.equal(p.isPlaying(), false);
});

test('a real player process (node standing in for afplay) settles when it exits', { skip: process.platform === 'win32' }, async () => {
  const fake = path.join(HOME, 'fake-afplay');
  fs.writeFileSync(fake, `#!${process.execPath}\nsetTimeout(() => process.exit(process.argv[2] ? 0 : 3), 50);\n`, { mode: 0o755 });
  const p = new AudioPlayer({ platformInfo: { platform: 'darwin' }, which: (n) => (n === 'afplay' ? fake : null) });
  const t0 = Date.now();
  assert.deepEqual(await p.playFile(WAV), { ok: true, player: 'afplay' });
  assert.ok(Date.now() - t0 >= 40, 'waited for the player');
  const slow = path.join(HOME, 'slow-afplay');
  fs.writeFileSync(slow, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`, { mode: 0o755 });
  const p2 = new AudioPlayer({ platformInfo: { platform: 'darwin' }, which: (n) => (n === 'afplay' ? slow : null) });
  const playing = p2.playFile(WAV);
  await new Promise((r) => setTimeout(r, 100));
  p2.stop();
  assert.equal((await playing).stopped, true);
});

// ------------------------------------------------------------------ chimes

test('chimes are valid 22050 Hz 16-bit mono WAVs of about 350 ms that start and end silently', () => {
  for (const kind of chime.CHIME_KINDS) {
    const buf = chime.chimeWav(kind);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    assert.equal(buf.readUInt32LE(4), buf.length - 8, 'RIFF size');
    assert.equal(buf.readUInt16LE(20), 1, 'PCM');
    assert.equal(buf.readUInt16LE(22), 1, 'mono');
    assert.equal(buf.readUInt32LE(24), 22050);
    assert.equal(buf.readUInt16LE(34), 16);
    assert.equal(buf.readUInt32LE(40), buf.length - 44, 'data size');
    const info = wavInfo(buf);
    assert.ok(info.durationMs >= 300 && info.durationMs <= 450, `${kind}: ${info.durationMs} ms`);
    const samples = chime.renderChime(kind);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    assert.ok(peak > 5000 && peak < 32767 * 0.5, `${kind}: peak ${peak} (audible, never clipping)`);
    assert.ok(Math.abs(samples[0]) < 200, `${kind} starts silently`);
    assert.ok(Math.abs(samples[samples.length - 1]) < 50, `${kind} ends silently (no click)`);
  }
  const q = chime.renderChime('question');
  const d = chime.renderChime('done');
  const peak = (a) => a.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  assert.ok(peak(q) < peak(d), 'the question chime is softer');
  assert.notDeepEqual(chime.chimeWav('error'), chime.chimeWav('done'));
  assert.equal(chime.chimeKind('nonsense'), 'done');
});

test('the error chime is lower than the done chime (zero crossings)', () => {
  const crossings = (a) => {
    let n = 0;
    for (let i = 1; i < a.length; i += 1) if ((a[i - 1] < 0) !== (a[i] < 0)) n += 1;
    return n;
  };
  assert.ok(crossings(chime.renderChime('error')) < crossings(chime.renderChime('done')) * 0.7);
});

test('chimeFile writes each chime once and reuses it', () => {
  const dir = path.join(HOME, 'chimes');
  const a = chime.chimeFile('permission', { dir });
  assert.equal(path.basename(a), 'chime-permission.wav');
  const st = fs.statSync(a);
  assert.equal(chime.chimeFile('permission', { dir }), a);
  assert.equal(fs.statSync(a).mtimeMs, st.mtimeMs, 'not rewritten');
  assert.equal(path.basename(chime.chimeFile('../../etc/passwd', { dir })), 'chime-done.wav', 'unknown kinds never name a file');
});
