'use strict';

/**
 * `anywhere voice …`: the free neural voice (Piper) and spoken announcements.
 *
 *   anywhere voice install [ID] [--voice ID] [--force]   download Piper and a voice (progress bar on a TTY)
 *   anywhere voice list                                   the curated voices, installed ones marked
 *   anywhere voice use ID [--install]                     speak with an installed voice
 *   anywhere voice test ["text"] [--local]                hear it (through the dialog when it is open)
 *   anywhere voice status                                 engine, voice, installed voices, OS voice, player
 *   anywhere voice remove ID                              delete a voice
 *
 * Install, list, use and remove work without the daemon (files live in ~/.claude-anywhere/voice);
 * a running daemon is told about the change so it switches voices at once.
 */

const path = require('path');

const SUBCOMMANDS = ['install', 'list', 'use', 'test', 'status', 'remove'];

function lib(name) {
  return require(path.join(__dirname, '..', 'daemon', name));
}

function cliError(message, hint, exitCode) {
  const e = new Error(message);
  e.name = 'CliError';
  e.exitCode = exitCode == null ? 1 : exitCode;
  if (hint) e.hint = hint;
  return e;
}

function usage(message) {
  const e = cliError(message, 'Run "anywhere help voice" for usage.');
  e.usage = true;
  return e;
}

/**
 * @param {object} h helpers from bin/anywhere.js
 * @returns {Object<string, object>}
 */
function commands(h) {
  const { spec, shared, call, requireDaemon, writeOut, writeErr, printJson, sym, color, EXIT } = h;

  /** The running daemon, or null (never throws for "not running"). */
  async function maybeDaemon() {
    try {
      return await requireDaemon();
    } catch (err) {
      if (err && err.exitCode === EXIT.NOT_RUNNING) return null;
      throw err;
    }
  }

  function loadConfig() {
    return shared('config').load();
  }

  function voiceName(id) {
    const e = lib('piper').catalogEntry(id);
    return e ? `${e.name} (${e.language}, ${e.gender})` : id;
  }

  function engineNote(cfg) {
    const e = String((cfg.voice && cfg.voice.ttsEngine) || 'auto');
    if (e === 'os') return `voice.ttsEngine is "os", so the OS voice is used. Switch: anywhere config set voice.ttsEngine auto`;
    if (e === 'browser') return `voice.ttsEngine is "browser": the daemon stays silent when the dialog is hidden. Switch: anywhere config set voice.ttsEngine auto`;
    return '';
  }

  /** A progress renderer for PiperManager.install (bar on a TTY, one line per message otherwise). */
  function progressPrinter({ json }) {
    const tty = Boolean(process.stderr.isTTY) && !json;
    let lastLine = '';
    let lastStage = '';
    let open = false;
    const s = sym();
    return {
      update(p) {
        if (json) return;
        if (tty) {
          const width = 24;
          const filled = Math.round((Math.max(0, Math.min(100, p.percent)) / 100) * width);
          const bar = s.ok === '✓' ? `${'█'.repeat(filled)}${'░'.repeat(width - filled)}` : `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`;
          const cols = Math.max(40, (process.stderr.columns || 100) - 1);
          let line = `${bar} ${String(p.percent).padStart(3)}%  ${p.message}`;
          if (line.length > cols) line = `${line.slice(0, cols - 1)}${s.ell === '…' ? '…' : '.'}`;
          process.stderr.write(`\r\u001b[2K${line}`);
          open = true;
          if (p.stage === 'done' || p.stage === 'error') {
            process.stderr.write('\n');
            open = false;
          }
          return;
        }
        // Not a terminal: a line when the stage changes or every few percent of a download.
        const msg = p.message.replace(/\s+\d+(\.\d+)? MB of \d+(\.\d+)? MB$/, '');
        const line = `[${p.stage}] ${msg}`;
        if (p.stage !== lastStage || (line !== lastLine && !/Downloading/.test(msg))) writeErr(`${line}${p.stage === 'voice' || p.stage === 'binary' ? ` (${p.percent}%)` : ''}`);
        lastStage = p.stage;
        lastLine = line;
      },
      end() {
        if (open) process.stderr.write('\n');
        open = false;
      },
    };
  }

  async function notifyDaemon(d, id) {
    if (!d) return false;
    try {
      await call(d.client, 'POST', '/api/voice/use', { voice: id }, { timeoutMs: 10000 });
      return true;
    } catch (err) {
      writeErr(`${color.yellow(sym().warn, process.stderr)} The running dialog did not switch voices: ${err.message}`);
      return false;
    }
  }

  async function doInstall(p, { voiceId } = {}) {
    const f = p.flags;
    const piper = lib('piper');
    const cfg = loadConfig();
    const explicit = voiceId || f.voice || (p._[0] === 'install' ? p._[1] : null);
    const id = explicit || (cfg.voice && cfg.voice.piperVoice) || piper.DEFAULT_VOICE;
    if (!piper.parseVoiceId(id)) throw usage(`"${id}" is not a Piper voice id (they look like en_US-lessac-medium); see: anywhere voice list`);
    const d = await maybeDaemon();
    if (d) {
      try {
        const st = await call(d.client, 'GET', '/api/voice/status', undefined, { timeoutMs: 15000 });
        if (st && st.piper && st.piper.installing) {
          throw cliError(`The dialog is installing ${st.piper.installing.voice || 'a voice'} right now (${st.piper.installing.percent || 0}%).`, 'Wait for it to finish: anywhere voice status');
        }
      } catch (err) {
        if (err && err.name === 'CliError' && !err.status) throw err;
        /* an older daemon without the voice routes: install here anyway */
      }
    }
    const pm = new piper.PiperManager();
    const printer = progressPrinter({ json: f.json });
    const ac = new AbortController();
    const onSigint = () => ac.abort();
    process.once('SIGINT', onSigint);
    const t0 = Date.now();
    let r;
    try {
      if (!f.json) writeErr(`Installing the free neural voice ${voiceName(id)}: it runs offline and costs nothing.`);
      r = await pm.install({ voice: id, force: Boolean(f.force), signal: ac.signal, onProgress: (x) => printer.update(x) });
    } catch (err) {
      printer.end();
      if (err && err.code === 'ABORTED') throw cliError('Install cancelled.', 'Run it again to resume the download.', EXIT.INTERRUPTED);
      throw cliError(err.message, err.hint);
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
    printer.end();
    const current = cfg.voice && cfg.voice.piperVoice;
    if (explicit || current !== id) shared('config').save({ voice: { piperVoice: id } });
    const told = await notifyDaemon(d, id);
    const out = { ok: true, voice: id, binary: r.binary, binaryKind: r.binaryKind, sentenceMs: r.testMs, seconds: Math.round((Date.now() - t0) / 100) / 10, daemonUpdated: told };
    if (f.json) {
      printJson(out);
      return EXIT.OK;
    }
    const how = r.binaryKind === 'venv' ? 'Python package in a private venv' : r.binaryKind === 'bundled' ? 'release binary' : r.binary;
    writeOut(`${color.green(sym().ok)} ${voiceName(id)} is ready (Piper, ${how}). A short sentence takes about ${r.testMs} ms.`);
    const note = engineNote(loadConfig());
    if (note) writeOut(`  ${note}`);
    writeOut(`  Hear it: anywhere voice test${d ? '' : '   (the dialog uses it from its next start, or now if it is running)'}`);
    return EXIT.OK;
  }

  function doList(p) {
    const piper = lib('piper');
    const cfg = loadConfig();
    const pm = new piper.PiperManager();
    const installed = new Set(pm.installedVoices());
    const current = (cfg.voice && cfg.voice.piperVoice) || piper.DEFAULT_VOICE;
    const rows = piper.CATALOG.map((v) => ({ ...v, installed: installed.has(v.id), current: v.id === current }));
    for (const id of installed) if (!piper.catalogEntry(id)) rows.push({ id, name: id, language: '', gender: '', quality: '', sizeMb: null, installed: true, current: id === current });
    if (p.flags.json) {
      printJson({ current, voices: rows });
      return EXIT.OK;
    }
    const s = sym();
    const w = Math.max(...rows.map((r) => r.id.length));
    // One write: `anywhere voice list | head` must not hit a closed pipe halfway.
    const lines = [`Free neural voices (Piper; offline, no cost). ${s.ok} installed, * in use.`];
    let lang = null;
    for (const r of rows) {
      if (r.language !== lang) {
        lang = r.language;
        lines.push('', color.bold(lang || 'Other installed voices'));
      }
      const mark = `${r.installed ? color.green(s.ok) : ' '.repeat(s.ok.length)} ${r.current ? '*' : ' '}`;
      const meta = [r.gender, r.quality, r.sizeMb ? `~${r.sizeMb} MB` : ''].filter(Boolean).join(', ');
      lines.push(`  ${mark} ${r.id.padEnd(w)}  ${r.name}${meta ? color.dim(`  (${meta})`) : ''}`);
    }
    lines.push('', `Install one: anywhere voice install --voice <id>   ${s.dot}   Any id from huggingface.co/rhasspy/piper-voices also works.`);
    writeOut(lines.join('\n'));
    return EXIT.OK;
  }

  async function doUse(p) {
    const piper = lib('piper');
    const id = p._[1] || p.flags.voice;
    if (!id) throw usage('Usage: anywhere voice use <voice id>   (see: anywhere voice list)');
    if (!piper.validVoiceName(id)) throw usage(`"${id}" is not a voice id (they look like en_US-lessac-medium)`);
    const pm = new piper.PiperManager();
    if (!pm.voiceInstalled(id)) {
      if (p.flags.install) return doInstall(p, { voiceId: id });
      throw cliError(`The voice ${id} is not installed.`, `Install it: anywhere voice install --voice ${id}   (or: anywhere voice use ${id} --install)`);
    }
    shared('config').save({ voice: { piperVoice: id } });
    const told = await notifyDaemon(await maybeDaemon(), id);
    if (p.flags.json) {
      printJson({ ok: true, voice: id, daemonUpdated: told });
      return EXIT.OK;
    }
    writeOut(`${color.green(sym().ok)} Speaking with ${voiceName(id)}.`);
    const note = engineNote(loadConfig());
    if (note) writeOut(`  ${note}`);
    return EXIT.OK;
  }

  async function doTest(p) {
    const text = [...p._.slice(1), ...(p.rest || [])].join(' ').trim();
    const d = p.flags.local ? null : await maybeDaemon();
    if (d) {
      const r = await call(d.client, 'POST', '/api/voice/test', text ? { text } : {}, { timeoutMs: 120000 });
      if (p.flags.json) {
        printJson(r);
        return r && r.ok ? EXIT.OK : EXIT.ERROR;
      }
      if (r && r.delivered === 'dialog') writeOut(`${color.green(sym().ok)} Played in the dialog (${r.engine === 'piper' ? 'neural voice' : 'browser voice'}).`);
      else if (r && r.delivered === 'local') writeOut(`${color.green(sym().ok)} Played through the speakers (${r.engine || 'OS voice'}).`);
      else throw cliError(`Nothing was played${r && r.error ? `: ${r.error}` : ''}.`, r && r.engine === 'browser' ? 'voice.ttsEngine is "browser": open the dialog, or: anywhere config set voice.ttsEngine auto' : 'Check: anywhere voice status');
      return EXIT.OK;
    }
    // No daemon: speak here (chime, then Piper or the OS voice).
    const { VoiceService } = lib('voice');
    const cfg = loadConfig();
    const svc = new VoiceService({ config: cfg });
    const sample = text || "Hi! This is how I'll sound when your work is done or when I need you.";
    const info = await svc.engineInfo();
    if (info.engine === null) {
      throw cliError('No voice is available.', info.setting === 'piper' ? 'Install it: anywhere voice install' : info.os.hint || 'Install the free neural voice: anywhere voice install');
    }
    const t0 = Date.now();
    try {
      if ((cfg.voice || {}).chime !== false) {
        try {
          await svc.playFile(lib('chime').chimeFile('info'));
        } catch (err) {
          if (!p.flags.json) writeErr(`${color.yellow(sym().warn, process.stderr)} No chime: ${err.message}`);
        }
      }
      const r = await svc.speak(sample, {});
      if (p.flags.json) printJson({ ok: Boolean(r && r.ok), delivered: 'local', engine: (r && r.provider) || null, ms: Date.now() - t0 });
      else writeOut(`${color.green(sym().ok)} Played through the speakers (${(r && r.provider) || 'OS voice'}).`);
      return r && r.ok ? EXIT.OK : EXIT.ERROR;
    } catch (err) {
      throw cliError(`Could not play the voice: ${err.message}`, err.hint);
    }
  }

  async function doStatus(p) {
    const d = await maybeDaemon();
    let st = null;
    let source = 'local';
    if (d) {
      try {
        st = await call(d.client, 'GET', '/api/voice/status', undefined, { timeoutMs: 20000 });
        source = 'daemon';
      } catch (err) {
        if (!err || err.status !== 404) throw err;
      }
    }
    if (!st) {
      const { VoiceService } = lib('voice');
      st = await new VoiceService({ config: loadConfig() }).voiceStatus();
    }
    const cfg = loadConfig();
    const v = cfg.voice || {};
    const ann = v.announce || {};
    if (p.flags.json) {
      printJson({ ...st, source, announce: { speakResponses: v.speakResponses !== false, ...ann, chime: v.chime !== false } });
      return EXIT.OK;
    }
    const s = sym();
    const on = (b) => (b !== false ? color.green('on') : color.dim('off'));
    const engineLabel = { piper: 'Piper neural voice', os: `OS voice (${(st.os && st.os.provider) || '?'})`, browser: 'the dialog (browser voice)' };
    writeOut(`Voice engine   ${st.engine ? engineLabel[st.engine] : color.yellow('none available')}  ${color.dim(`(voice.ttsEngine = ${st.ttsEngine})`)}`);
    const pi = st.piper || {};
    if (pi.installed) {
      writeOut(`Piper          ${color.green(s.ok)} ${voiceName(pi.voice)}  ${color.dim(`${pi.binaryKind || ''} ${pi.binary || ''}`.trim())}`);
    } else {
      writeOut(`Piper          ${color.yellow('not installed')}${pi.binary ? ` (engine found; voice ${pi.voice} missing)` : ''}  ${s.arrow} anywhere voice install`);
    }
    if (pi.installing) writeOut(`               installing ${pi.installing.voice || ''}: ${pi.installing.percent || 0}% ${pi.installing.message || ''}`);
    writeOut(`Installed      ${(pi.installedVoices || []).length ? pi.installedVoices.join(', ') : color.dim('no voices yet')}`);
    writeOut(`OS voice       ${(st.os && st.os.provider) || color.dim(`none${st.os && st.os.hint ? ` (${st.os.hint})` : ''}`)}`);
    if (st.player) writeOut(`Audio player   ${st.player.available ? st.player.players.join(', ') : color.yellow(`none (${st.player.hint})`)}`);
    writeOut(
      `Announcements  ${v.speakResponses === false ? color.dim('off (voice.speakResponses = false)') : `done ${on(ann.done)} ${s.dot} permission ${on(ann.permission)} ${s.dot} question ${on(ann.question)} ${s.dot} error ${on(ann.error)} ${s.dot} chime ${on(v.chime)}`}`,
    );
    if (source === 'local') writeOut(color.dim('(the dialog is not running; this is what it will use)'));
    return EXIT.OK;
  }

  async function doRemove(p) {
    const piper = lib('piper');
    const id = p._[1] || p.flags.voice;
    if (!id) throw usage('Usage: anywhere voice remove <voice id>');
    if (!piper.validVoiceName(id)) throw usage(`"${id}" is not a voice id`);
    const d = await maybeDaemon();
    let removed;
    if (d) {
      try {
        removed = (await call(d.client, 'POST', '/api/voice/remove', { voice: id }, { timeoutMs: 15000 })).removed;
      } catch (err) {
        if (!err || err.status !== 404) throw err;
      }
    }
    if (removed === undefined) removed = new piper.PiperManager().removeVoice(id);
    const cfg = loadConfig();
    if (p.flags.json) {
      printJson({ ok: true, removed });
      return EXIT.OK;
    }
    if (!removed) writeOut(`${id} was not installed.`);
    else writeOut(`${color.green(sym().ok)} Removed ${id}.`);
    if ((cfg.voice && cfg.voice.piperVoice) === id) writeOut(`  It was your voice: pick another with anywhere voice use <id> (until then the OS voice speaks).`);
    return EXIT.OK;
  }

  async function run(p) {
    const sub = p._[0] || 'status';
    if (!SUBCOMMANDS.includes(sub)) throw usage(`Unknown voice command "${sub}" (use ${SUBCOMMANDS.join(', ')})`);
    if (sub === 'install') return doInstall(p);
    if (sub === 'list') return doList(p);
    if (sub === 'use') return doUse(p);
    if (sub === 'test') return doTest(p);
    if (sub === 'remove') return doRemove(p);
    return doStatus(p);
  }

  return {
    voice: {
      run,
      group: 'Setup',
      summary: 'Free natural-sounding voice (Piper): install, choose, test',
      usage: 'anywhere voice install [ID] [--force] | list | use ID [--install] | test ["text"] [--local] | status | remove ID  [--json]',
      details: [
        'install downloads Piper (MIT, offline neural text-to-speech) and a voice (default en_US-lessac-medium, ~63 MB) into ~/.claude-anywhere/voice.',
        'Nothing is sent anywhere and nothing costs money. A running dialog switches to the new voice at once.',
        'list shows the curated voices (✓ installed, * in use); any id from huggingface.co/rhasspy/piper-voices also installs.',
        'test plays a sample through the dialog when it is open, else through the speakers (--local forces the speakers).',
        'Announcements: voice.speakResponses, voice.announce.done|permission|question|error and voice.chime (anywhere config set …).',
      ],
      spec: spec({ string: ['voice'], boolean: ['force', 'install', 'local'] }),
    },
  };
}

module.exports = { commands, SUBCOMMANDS };
