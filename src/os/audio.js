'use strict';

/**
 * Play a WAV file through the OS speakers.
 *
 *   macOS     afplay
 *   Windows   System.Media.SoundPlayer (PlaySync) in Windows PowerShell, via -EncodedCommand
 *   WSL       the same through powershell.exe, with the file's Windows path from `wslpath -w`
 *   Linux     pw-play (PipeWire), paplay (PulseAudio), aplay (ALSA), then
 *             ffplay -nodisp -autoexit -loglevel error. A player that fails (no server, no
 *             device) hands over to the next one; the one that worked is tried first next time.
 *
 * One playback at a time: a new playFile() stops the one before. playFile() settles when the
 * sound has finished (or was stopped).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const proc = require('../shared/proc');
const platformMod = require('../shared/platform');

const LINUX_PLAYERS = ['pw-play', 'paplay', 'aplay', 'ffplay'];
/** ffplay's messages when it played nothing (it still exits 0). */
const FFPLAY_FAILED_RE = /audio open failed|Failed to open file|Could not initialize SDL|No more combinations to try|SDL_OpenAudio/i;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const WSLPATH_TIMEOUT_MS = 5000;
const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const WSL_TASKKILL = '/mnt/c/Windows/System32/taskkill.exe';

const LINUX_HINT =
  'Install an audio player: sudo apt install pipewire-bin (pw-play), pulseaudio-utils (paplay) or alsa-utils (aplay); ' +
  'Fedora: sudo dnf install pipewire-utils; Arch: sudo pacman -S pipewire. ffplay (from ffmpeg) also works.';

function audioError(message, code, hint) {
  const e = new Error(message);
  e.code = code;
  if (hint) e.hint = hint;
  return e;
}

/**
 * Spawn and wait, never throwing. Kills the child on abort or timeout.
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean, error:Error|null}>}
 */
function defaultRunner(cmd, args = [], { timeoutMs = 15000, signal, onStdout, env, cwd } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    let timedOut = false;
    let aborted = false;
    const out = [];
    const err = [];
    let errLen = 0;
    const kill = () => {
      if (!child) return;
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
      const t = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }, 1500);
      if (t.unref) t.unref();
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        code: r.code ?? null,
        signal: r.signal ?? null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        aborted,
        error: r.error || null,
      });
    };
    let timer = null;
    if (signal && signal.aborted) {
      aborted = true;
      finish({});
      return;
    }
    try {
      child = spawn(cmd, args, { env: env || process.env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ error: e });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      if (out.length < 64) out.push(d);
      if (typeof onStdout === 'function') {
        try {
          onStdout(d);
        } catch {
          /* observers never break playback */
        }
      }
    });
    child.stderr.on('data', (d) => {
      errLen += d.length;
      if (errLen <= 64 * 1024) err.push(d);
    });
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code, sig) => finish({ code, signal: sig }));
  });
}

/** PowerShell single-quoted string literal. */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * The SoundPlayer script for Windows / WSL. It prints its PID first so a stop from WSL can
 * taskkill the real Windows process (the Linux-side process is only an interop relay).
 * @param {string} winPath
 * @returns {string}
 */
function soundPlayerScript(winPath) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::Out.WriteLine('ANYWHERE_PID ' + $PID); [Console]::Out.Flush()",
    `$p = New-Object System.Media.SoundPlayer ${psQuote(winPath)}`,
    '$p.Load()',
    '$p.PlaySync()',
    '$p.Dispose()',
  ].join('; ');
}

/**
 * The command that plays `file` with `player`.
 * @param {string} player afplay | soundplayer | pw-play | paplay | aplay | ffplay
 * @param {string} file path as the player sees it (a Windows path for soundplayer)
 * @param {{bin?:string, device?:string}} [opts]
 * @returns {{cmd:string, args:string[], player:string, script?:string}}
 */
function buildPlayCommand(player, file, { bin, device } = {}) {
  const cmd = bin || player;
  const dev = typeof device === 'string' && device.trim() ? device.trim() : '';
  switch (player) {
    case 'afplay':
      // afplay always uses the default output device.
      return { cmd, args: [file], player };
    case 'soundplayer': {
      const script = soundPlayerScript(file);
      return {
        cmd,
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        player,
        script,
      };
    }
    case 'pw-play':
      return { cmd, args: dev ? ['--target', dev, file] : [file], player };
    case 'paplay':
      return { cmd, args: dev ? [`--device=${dev}`, file] : [file], player };
    case 'aplay':
      return { cmd, args: dev ? ['-q', '-D', dev, file] : ['-q', file], player };
    case 'ffplay':
      // -loglevel error, not quiet: ffplay exits 0 even when it could not open an audio device,
      // and only its error lines tell that apart from a sound that played (see FFPLAY_FAILED_RE).
      return { cmd, args: ['-nodisp', '-autoexit', '-loglevel', 'error', file], player };
    default:
      throw audioError(`Unknown audio player ${player}`, 'UNSUPPORTED');
  }
}

/**
 * A WSL path's Windows form without running wslpath: /mnt/c/Users/x → C:\Users\x. Other paths
 * (inside the Linux file system) need `wslpath -w`; null here.
 * @param {string} p
 * @returns {string|null}
 */
function mntToWindowsPath(p) {
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(String(p || ''));
  if (!m) return null;
  return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
}

function last(s, n = 300) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/**
 * Plays WAV files through the OS, one at a time. Platform, which, runner and env can be
 * injected for tests.
 */
class AudioPlayer {
  /**
   * @param {{platformInfo?:object, which?:(name:string)=>string|null, runner?:Function, env?:object,
   *   isFile?:(p:string)=>boolean}} [opts]
   */
  constructor({ platformInfo, which, runner, env, isFile } = {}) {
    this.platformInfo = platformInfo || null;
    this.which = typeof which === 'function' ? which : proc.which;
    this.runner = typeof runner === 'function' ? runner : defaultRunner;
    this.env = env || process.env;
    this.isFile =
      typeof isFile === 'function'
        ? isFile
        : (p) => {
            try {
              return fs.statSync(p).isFile();
            } catch {
              return false;
            }
          };
    this.current = null;
    this.preferred = null; // the Linux player that worked last
  }

  /** @private */
  info() {
    if (!this.platformInfo) this.platformInfo = platformMod.info();
    return this.platformInfo;
  }

  /** @private Windows PowerShell for SoundPlayer (powershell.exe from WSL). */
  powershell() {
    const pi = this.info();
    if (pi.platform === 'win32') {
      const found = this.which('powershell') || this.which('powershell.exe');
      if (found) return found;
      const sys = path.win32.join(this.env.SystemRoot || this.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return this.isFile(sys) ? sys : null;
    }
    return this.which('powershell.exe') || (this.isFile(WSL_POWERSHELL) ? WSL_POWERSHELL : null);
  }

  /**
   * The players to try on this machine, in order.
   * @returns {{player:string, bin:string}[]}
   */
  candidates() {
    const pi = this.info();
    if (pi.platform === 'darwin') {
      const bin = this.which('afplay') || (this.isFile('/usr/bin/afplay') ? '/usr/bin/afplay' : null);
      return bin ? [{ player: 'afplay', bin }] : [];
    }
    if (pi.platform === 'win32' || pi.isWSL) {
      const ps = this.powershell();
      const out = ps ? [{ player: 'soundplayer', bin: ps }] : [];
      // WSLg also has a PulseAudio server; use it when Windows interop is off.
      if (pi.isWSL) {
        for (const name of LINUX_PLAYERS) {
          const bin = this.which(name);
          if (bin) out.push({ player: name, bin });
        }
      }
      return out;
    }
    const list = [];
    for (const name of LINUX_PLAYERS) {
      const bin = this.which(name);
      if (bin) list.push({ player: name, bin });
    }
    if (this.preferred) list.sort((a, b) => (b.player === this.preferred) - (a.player === this.preferred));
    return list;
  }

  /** @returns {string} how to get a player on this OS */
  hint() {
    const pi = this.info();
    if (pi.platform === 'darwin') return 'afplay is part of macOS; check that /usr/bin/afplay exists.';
    if (pi.platform === 'win32') return 'Windows PowerShell (powershell.exe) was not found.';
    if (pi.isWSL) return 'powershell.exe is not reachable from WSL; enable Windows interop (/etc/wsl.conf [interop] enabled=true), or install pulseaudio-utils for WSLg.';
    return LINUX_HINT;
  }

  /** @returns {Promise<{available:boolean, players:string[], hint?:string}>} */
  async status() {
    const players = this.candidates().map((c) => c.player);
    return players.length ? { available: true, players } : { available: false, players, hint: this.hint() };
  }

  /** @private the file's path for the player (a Windows path for SoundPlayer from WSL) */
  async pathFor(player, file) {
    const pi = this.info();
    if (player !== 'soundplayer' || !pi.isWSL) return file;
    const direct = mntToWindowsPath(file);
    if (direct) return direct;
    const wslpath = this.which('wslpath') || '/usr/bin/wslpath';
    const r = await this.runner(wslpath, ['-w', file], { timeoutMs: WSLPATH_TIMEOUT_MS });
    const win = String((r && r.stdout) || '').trim().split(/\r?\n/)[0];
    if (!r || r.error || r.code !== 0 || !win) {
      throw audioError(`Could not get the Windows path of ${file}: ${last((r && (r.stderr || (r.error && r.error.message))) || 'wslpath failed')}`, 'PLAY_FAILED');
    }
    return win;
  }

  /**
   * Play a WAV file. Stops the sound that is playing, if any.
   * @param {string} file
   * @param {{device?:string, timeoutMs?:number}} [opts] device: a PipeWire target, PulseAudio sink or ALSA device (Linux)
   * @returns {Promise<{ok:true, player:string, stopped?:boolean}>}
   */
  async playFile(file, { device, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const abs = path.resolve(String(file || ''));
    if (!file || !this.isFile(abs)) throw audioError(`The audio file ${abs} does not exist`, 'ENOENT');
    this.stop();
    const ac = new AbortController();
    const cur = { ac, player: null, winPid: null };
    this.current = cur;
    try {
      const list = this.candidates();
      if (!list.length) throw audioError('No audio player was found', 'NO_PLAYER', this.hint());
      const failures = [];
      for (const c of list) {
        if (ac.signal.aborted) return { ok: true, player: c.player, stopped: true };
        cur.player = c.player;
        cur.winPid = null;
        const target = await this.pathFor(c.player, abs);
        const cmd = buildPlayCommand(c.player, target, { bin: c.bin, device });
        const onStdout =
          c.player === 'soundplayer'
            ? (chunk) => {
                if (cur.winPid != null) return;
                const m = /ANYWHERE_PID (\d+)/.exec(String(chunk));
                if (m) cur.winPid = Number(m[1]);
              }
            : undefined;
        const r = await this.runner(cmd.cmd, cmd.args, { timeoutMs, signal: ac.signal, onStdout });
        if (ac.signal.aborted || (r && r.aborted)) return { ok: true, player: c.player, stopped: true };
        // ffplay exits 0 when it could not open an audio device: its error lines say so.
        const silent = c.player === 'ffplay' && r && r.code === 0 && FFPLAY_FAILED_RE.test(String(r.stderr || ''));
        if (r && !r.error && !r.timedOut && r.code === 0 && !silent) {
          if (c.player !== 'soundplayer') this.preferred = c.player;
          return { ok: true, player: c.player };
        }
        const why = r.error
          ? r.error.message
          : silent
            ? `no audio device: ${last(String(r.stderr).split(/\r?\n/).filter((l) => FFPLAY_FAILED_RE.test(l)).join('; '))}`
            : r.timedOut
            ? `took longer than ${Math.round(timeoutMs / 1000)} s`
            : `exit ${r.code}${r.stderr ? `: ${last(c.player === 'soundplayer' ? proc.psErrorText(r.stderr) : r.stderr)}` : ''}`;
        failures.push(`${c.player}: ${why}`);
        if (r.timedOut) break; // it played (or hung) for the whole timeout: do not play it again
      }
      throw audioError(
        `Could not play the sound (${failures.join('; ')})`,
        'PLAY_FAILED',
        /soundplayer/.test(failures.join(' '))
          ? 'Check that Windows has a working audio output device (Settings > System > Sound).'
          : 'Check that an audio output device is connected and the sound server (PipeWire or PulseAudio) is running. ' + LINUX_HINT,
      );
    } finally {
      if (this.current === cur) this.current = null;
    }
  }

  /** @returns {boolean} whether a sound is playing */
  isPlaying() {
    return Boolean(this.current);
  }

  /**
   * Stop the sound that is playing.
   * @returns {boolean} whether something was stopped
   */
  stop() {
    const cur = this.current;
    this.current = null;
    if (!cur) return false;
    try {
      cur.ac.abort();
    } catch {
      /* ignore */
    }
    if (cur.player === 'soundplayer' && cur.winPid != null && this.info().isWSL) {
      // Killing the interop relay does not stop the Windows process.
      const taskkill = this.which('taskkill.exe') || (this.isFile(WSL_TASKKILL) ? WSL_TASKKILL : null);
      if (taskkill) Promise.resolve(this.runner(taskkill, ['/PID', String(cur.winPid), '/T', '/F'], { timeoutMs: 5000 })).catch(() => {});
    }
    return true;
  }
}

let shared = null;
function sharedPlayer() {
  if (!shared) shared = new AudioPlayer();
  return shared;
}

/**
 * Play a WAV file with the shared player (one playback at a time per process).
 * @param {string} file
 * @param {{device?:string, timeoutMs?:number}} [opts]
 */
function playFile(file, opts) {
  return sharedPlayer().playFile(file, opts);
}

/** Stop the shared player. @returns {boolean} */
function stop() {
  return shared ? shared.stop() : false;
}

module.exports = {
  AudioPlayer,
  buildPlayCommand,
  soundPlayerScript,
  mntToWindowsPath,
  playFile,
  stop,
  sharedPlayer,
  defaultRunner,
  LINUX_PLAYERS,
};
