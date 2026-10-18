'use strict';

/**
 * `anywhere clone-voice …`: record and clone your own voice (consent-gated, stays on this computer;
 * docs/CALLS-DESIGN.md §2).
 *
 *   anywhere clone-voice [start]         start the dialog if needed and open its enrollment view
 *   anywhere clone-voice install         the free voice runtime and models (~425 MB, once)
 *   anywhere clone-voice status          runtime, voice profile, speed
 *   anywhere clone-voice test [TEXT]     hear a sentence in your cloned voice
 *   anywhere clone-voice bench           measure the clone engines' speed on this computer
 *   anywhere clone-voice delete          delete the voice profile, its consent record and phrase cache
 *   flags: --engine pocket|zipvoice  --json  --yes (delete without the typed confirmation)  --standalone (start in a browser tab)
 *
 * install, status, test, bench and delete also work without the daemon; a running daemon does the
 * work itself (it holds the warm voice runtime) and is told about deletions at once.
 */

const fs = require('fs');
const path = require('path');

const SUBCOMMANDS = ['start', 'install', 'status', 'test', 'bench', 'delete'];
const ENGINES = ['pocket', 'zipvoice'];
const ACK_POLL_MS = 400;

function cliError(message, hint, exitCode) {
  const e = new Error(message);
  e.name = 'CliError';
  e.exitCode = exitCode == null ? 1 : exitCode;
  if (hint) e.hint = hint;
  return e;
}

function usage(message) {
  const e = cliError(message, 'Run "anywhere help clone-voice" for usage.');
  e.usage = true;
  return e;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} h helpers from bin/anywhere.js
 * @returns {Object<string, object>}
 */
function commands(h) {
  const { spec, shared, call, requireDaemon, ensureDaemon, writeOut, writeErr, printJson, sym, color, EXIT } = h;

  async function maybeDaemon() {
    try {
      return await requireDaemon();
    } catch (err) {
      if (err && err.exitCode === EXIT.NOT_RUNNING) return null;
      throw err;
    }
  }

  /** A CloneService in this process (no daemon). */
  function localService() {
    const { CloneService } = require(path.join(__dirname, '..', 'voice', 'clone'));
    // Warnings only: the command prints its own outcome.
    const quiet = { debug() {}, info() {}, warn: (m) => writeErr(`${sym().warn} ${m}`), error: (m) => writeErr(`${sym().fail} ${m}`) };
    return new CloneService({ config: shared('config').load(), idleMs: 0, log: quiet });
  }

  /** Call a daemon route; null when this daemon has no clone routes (an older version). */
  async function daemonCall(d, method, p, body, timeoutMs = 30000) {
    try {
      return await call(d.client, method, p, body, { timeoutMs });
    } catch (err) {
      if (err && err.status === 404 && /Not found/i.test(err.serverMessage || err.message)) return null;
      throw err;
    }
  }

  function engineFlag(p) {
    const e = p.flags.engine;
    if (e == null || e === '') return undefined;
    if (!ENGINES.includes(e)) throw usage(`--engine must be pocket or zipvoice (got "${e}")`);
    return e;
  }

  /** Most recently used project that still exists (sessions.json), else the cwd. */
  function lastProject() {
    try {
      const data = JSON.parse(fs.readFileSync(shared('paths').sessionsPath(), 'utf8'));
      const entries = Object.keys(data || {})
        .map((dir) => ({ dir, at: String((data[dir] && data[dir].updatedAt) || '') }))
        .filter((e) => {
          try {
            return fs.statSync(e.dir).isDirectory();
          } catch (_) {
            return false;
          }
        })
        .sort((a, b) => b.at.localeCompare(a.at));
      if (entries.length) return entries[0].dir;
    } catch (_) {
      /* no history */
    }
    return process.cwd();
  }

  /** Bench runs as a flat list: the installer's record {engines:{pocket:{runs}, zipvoice:{runs}}} or {runs}. */
  function benchRuns(b) {
    if (!b || typeof b !== 'object') return [];
    if (Array.isArray(b.runs)) return b.runs;
    const out = [];
    for (const [engine, e] of Object.entries(b.engines || {})) for (const r of (e && e.runs) || []) out.push({ engine, ...r });
    return out;
  }

  function fmtMb(bytes) {
    return `${Math.round(bytes / 1024 / 1024)} MB`;
  }

  function profileLine(pr) {
    if (!pr || !pr.exists) return 'none yet';
    if (!pr.ok) return color.yellow(`unusable (${pr.reason || 'invalid'}): record it again`);
    const when = pr.createdAt ? String(pr.createdAt).slice(0, 16).replace('T', ' ') : '?';
    const sim = pr.testSimilarity != null ? `, test match ${pr.testSimilarity} (${pr.testLabel || ''})` : '';
    return `${color.green(sym().ok)} recorded ${when} for ${pr.ownerName || 'you'} (${pr.engine || 'pocket'}${sim})`;
  }

  // ------------------------------------------------------------------ start

  async function waitForAck(d, seq, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const st = await call(d.client, 'GET', '/api/clone/status?light=1', undefined, { timeoutMs: 5000 });
        if (st && Number(st.openAck) >= seq) return true;
      } catch (_) {
        /* keep trying until the deadline */
      }
      await sleep(ACK_POLL_MS);
    }
    return false;
  }

  async function doStart(p) {
    const f = p.flags;
    let d = await maybeDaemon();
    const started = !d;
    let startRes = null;
    if (!d) {
      startRes = await ensureDaemon({ project: lastProject(), open: !f.standalone, keepMode: true });
      d = await requireDaemon();
    }
    const opened = await daemonCall(d, 'POST', '/api/clone/open', {}, 30000);
    if (!opened) throw cliError('This Claude Anywhere daemon has no voice cloning yet.', 'Restart it to load the update: anywhere restart');
    let view = 'dialog';
    let browserError = null;
    // No window and no dialog page connected: nothing can show the view, so use the standalone page at once.
    const noDialog = opened.host === 'none' && opened.dialogs === 0;
    const acked = f.standalone || noDialog ? false : await waitForAck(d, opened.seq, started ? 12000 : 8000);
    if (!acked) {
      // The dialog has no enrollment view mounted (or no window could open): use the standalone page.
      view = 'browser';
      try {
        const s = await call(d.client, 'POST', '/api/clone/standalone', {}, { timeoutMs: 10000 });
        await require(path.join(__dirname, '..', 'os', 'common')).openTarget(s.url, { kind: 'url' });
      } catch (err) {
        view = 'none';
        browserError = err.message;
      }
    }
    let st = null;
    try {
      st = await call(d.client, 'GET', '/api/clone/status', undefined, { timeoutMs: 20000 });
    } catch (_) {
      st = null;
    }
    const out = {
      ok: view !== 'none',
      view,
      daemonStarted: started,
      host: (opened && opened.host) || (startRes && startRes.host) || null,
      installed: Boolean(st && st.installed),
      profile: (st && st.profile) || null,
      owner: (st && st.owner && st.owner.name) || null,
    };
    if (browserError) out.error = browserError;
    if (f.json) {
      printJson(out);
      return out.ok ? EXIT.OK : EXIT.ERROR;
    }
    const s = sym();
    if (view === 'dialog') writeOut(`${color.green(s.ok)} Voice enrollment is open in the Claude Anywhere dialog.`);
    else if (view === 'browser') writeOut(`${color.green(s.ok)} Voice enrollment opened in a browser tab (the dialog has no enrollment view in this version).`);
    else {
      writeOut(`${color.yellow(s.warn)} The enrollment view could not be opened: ${browserError}`);
      writeOut(`  Open the dialog (anywhere show), or run: anywhere clone-voice start --standalone`);
    }
    writeOut('  It takes about 3 minutes: read a consent sentence with a one-time code, then 14 short lines.');
    writeOut('  Your voice stays on this computer and is used only to answer calls you arm.');
    if (st && !st.installed) writeOut(`  First it downloads the free voice runtime (about 425 MB, once); or run: anywhere clone-voice install`);
    if (st && st.profile && st.profile.exists) writeOut(`  You already have a cloned voice: recording again replaces it.`);
    writeOut(`  Delete it any time: /anywhere:clone-voice delete (or: anywhere clone-voice delete).`);
    return out.ok ? EXIT.OK : EXIT.ERROR;
  }

  // ------------------------------------------------------------------ install

  function progressPrinter({ json }) {
    const tty = Boolean(process.stderr.isTTY) && !json;
    let lastStage = '';
    let open = false;
    return {
      update(pr) {
        if (json || !pr) return;
        const pct = Math.max(0, Math.min(100, Number(pr.percent) || 0));
        if (tty) {
          const width = 24;
          const filled = Math.round((pct / 100) * width);
          const bar = sym().ok === '✓' ? `${'█'.repeat(filled)}${'░'.repeat(width - filled)}` : `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`;
          const cols = Math.max(40, (process.stderr.columns || 100) - 1);
          let line = `${bar} ${String(Math.round(pct)).padStart(3)}%  ${pr.message || pr.stage}`;
          if (line.length > cols) line = `${line.slice(0, cols - 3)}...`;
          process.stderr.write(`\r\u001b[2K${line}`);
          open = true;
          if (pr.stage === 'done' || pr.stage === 'error') {
            process.stderr.write('\n');
            open = false;
          }
          return;
        }
        if (pr.stage !== lastStage) writeErr(`[${pr.stage}] ${pr.message || ''} (${Math.round(pct)}%)`);
        lastStage = pr.stage;
      },
      end() {
        if (open) process.stderr.write('\n');
        open = false;
      },
    };
  }

  async function doInstall(p) {
    const f = p.flags;
    const engine = engineFlag(p);
    const printer = progressPrinter({ json: f.json });
    const t0 = Date.now();
    const d = await maybeDaemon();
    if (d) {
      const r = await daemonCall(d, 'POST', '/api/clone/install', engine ? { engine } : {});
      if (r) {
        if (!f.json) writeErr(r.running ? 'The dialog is already installing the voice runtime; following it.' : 'Installing the free voice runtime in the running dialog (about 425 MB, once).');
        let last = null;
        for (;;) {
          await sleep(1000);
          const st = await call(d.client, 'GET', '/api/clone/status?light=1', undefined, { timeoutMs: 10000 });
          if (st.installing) {
            last = st.installing;
            printer.update(st.installing);
            continue;
          }
          const end = st.lastInstall || last;
          printer.update(end && (end.stage === 'done' || end.stage === 'error') ? end : { stage: 'done', percent: 100, message: 'Done' });
          printer.end();
          if (end && end.stage === 'error') throw cliError(`Installing the voice runtime failed: ${end.message}`, 'Run it again to resume the downloads, or check: anywhere clone-voice status');
          break;
        }
        return finishInstall(f, engine, t0, true);
      }
    }
    const svc = localService();
    const ac = new AbortController();
    const onSigint = () => ac.abort();
    process.once('SIGINT', onSigint);
    svc.on('install', (pr) => printer.update(pr));
    try {
      if (!f.json) writeErr('Installing the free voice runtime (Pocket TTS, Moonshine STT, 3D-Speaker; about 425 MB, once). Nothing is installed into your own Python.');
      await svc.install({ engine, signal: ac.signal });
    } catch (err) {
      printer.end();
      if (err && (err.code === 'ABORTED' || err.name === 'AbortError')) throw cliError('Install cancelled.', 'Run it again to resume the downloads.', EXIT.INTERRUPTED);
      throw cliError(`Installing the voice runtime failed: ${err.message}`, err.hint);
    } finally {
      process.removeListener('SIGINT', onSigint);
      await svc.shutdown().catch(() => {});
    }
    printer.end();
    return finishInstall(f, engine, t0, false);
  }

  function finishInstall(f, engine, t0, viaDaemon) {
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    if (f.json) {
      printJson({ ok: true, engine: engine || 'pocket', seconds, viaDaemon });
      return EXIT.OK;
    }
    writeOut(`${color.green(sym().ok)} The voice runtime is ready${engine === 'zipvoice' ? ' (with the quality voice)' : ''}.`);
    writeOut('  Next: anywhere clone-voice   (or /anywhere:clone-voice) to record your voice.');
    return EXIT.OK;
  }

  // ------------------------------------------------------------------ status

  async function doStatus(p) {
    const d = await maybeDaemon();
    let st = d ? await daemonCall(d, 'GET', '/api/clone/status', undefined, 20000) : null;
    const source = st ? 'daemon' : 'local';
    if (!st) {
      const svc = localService();
      try {
        st = await svc.status();
      } finally {
        await svc.shutdown().catch(() => {});
      }
    }
    if (p.flags.json) {
      printJson({ ...st, source });
      return EXIT.OK;
    }
    const s = sym();
    const rt = st.runtime || {};
    const engines = Object.entries(st.engines || {})
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (st.installed) writeOut(`Runtime        ${color.green(s.ok)} installed (${engines.join(', ') || 'pocket'})${rt.python ? color.dim(`  python ${rt.python.version || rt.python}`) : ''}`);
    else writeOut(`Runtime        ${color.yellow('not installed')}  ${s.arrow} anywhere clone-voice install${rt.reason ? color.dim(`  (${rt.reason})`) : ''}`);
    if (st.installing) writeOut(`               installing: ${st.installing.percent || 0}% ${st.installing.message || ''}`);
    if (Array.isArray(rt.missing) && rt.missing.length && st.installed === false && rt.downloadBytes) writeOut(`               to download: ${fmtMb(rt.downloadBytes)}`);
    writeOut(`Voice profile  ${profileLine(st.profile)}`);
    writeOut(`Cloned voice   ${st.enabled ? color.green('on') : color.dim('off')} ${color.dim(`(voice.clone.enabled; engine ${st.engine})`)}`);
    const runs = benchRuns(st.bench).filter((r) => Number.isFinite(r.rtf));
    if (runs.length) {
      const best = runs.filter((r) => r.engine === st.engine).sort((a, b) => a.rtf - b.rtf)[0] || runs[0];
      writeOut(`Speed          real-time factor ${best.rtf} (${best.engine}, ${best.threads} threads)${best.rtf > 0.9 ? color.yellow('  slow: calls will lean on pre-rendered phrases') : ''}`);
    }
    if (st.session) writeOut(`Enrollment     in progress: ${st.session.takes}/${st.session.total} lines${st.session.consentPassed ? '' : ' (consent not recorded yet)'}`);
    if (st.owner && st.owner.name) writeOut(`Your name      ${st.owner.name} ${color.dim(`(from ${st.owner.source}; set calls.ownerName to change it)`)}`);
    if (source === 'local') writeOut(color.dim('(the dialog is not running)'));
    if (!st.profile || !st.profile.exists) writeOut(`Record your voice: anywhere clone-voice   (or /anywhere:clone-voice)`);
    return EXIT.OK;
  }

  // ------------------------------------------------------------------ test

  async function doTest(p) {
    const text = [...p._.slice(1), ...(p.rest || [])].join(' ').trim();
    const engine = engineFlag(p);
    const d = p.flags.local ? null : await maybeDaemon();
    let r = null;
    if (d) r = await daemonCall(d, 'POST', '/api/clone/test', { text: text || undefined, engine, play: 'local' }, 240000);
    if (!r) {
      const svc = localService();
      try {
        const out = await svc.test(text || undefined, { engine });
        let played = false;
        let playError = null;
        try {
          const { VoiceService } = require(path.join(__dirname, '..', 'daemon', 'voice'));
          await new VoiceService({ config: shared('config').load() }).playFile(out.file);
          played = true;
        } catch (err) {
          playError = err.message;
        }
        r = { ok: true, text: out.text, engine: out.engine, played, playError };
      } catch (err) {
        throw cliError(err.message, err.hint);
      } finally {
        await svc.shutdown().catch(() => {});
      }
    }
    if (p.flags.json) {
      printJson(r);
      return r.played ? EXIT.OK : EXIT.ERROR;
    }
    if (r.played) writeOut(`${color.green(sym().ok)} Played in your cloned voice (${r.engine}): "${r.text}"`);
    else throw cliError(`Rendered "${r.text}" in your cloned voice, but it could not be played${r.playError ? `: ${r.playError}` : ''}.`, 'Use the Test button in the enrollment view instead.');
    return EXIT.OK;
  }

  // ------------------------------------------------------------------ bench

  async function doBench(p) {
    const d = await maybeDaemon();
    let r = d ? await daemonCall(d, 'POST', '/api/clone/bench', {}, 600000) : null;
    if (!r) {
      const svc = localService();
      try {
        if (!p.flags.json) writeErr('Measuring the clone engines on this computer (this takes a minute)…');
        r = await svc.bench();
      } catch (err) {
        throw cliError(err.message, err.hint);
      } finally {
        await svc.shutdown().catch(() => {});
      }
    }
    if (p.flags.json) {
      printJson(r);
      return EXIT.OK;
    }
    const runs = benchRuns(r).slice().sort((a, b) => String(a.engine || '').localeCompare(String(b.engine || '')) || a.rtf - b.rtf);
    if (!runs.length) {
      writeOut('No benchmark results.');
      return EXIT.ERROR;
    }
    writeOut('engine     threads  steps  real-time factor  first audio');
    for (const x of runs) {
      writeOut(`${String(x.engine).padEnd(10)} ${String(x.threads).padStart(7)}  ${String(x.steps == null ? '-' : x.steps).padStart(5)}  ${String(x.rtf).padStart(16)}  ${x.firstChunkMs != null ? `${x.firstChunkMs} ms` : '-'}`);
    }
    writeOut(color.dim('A real-time factor below 1 means faster than speech; calls need about 0.75 or less.'));
    return EXIT.OK;
  }

  // ------------------------------------------------------------------ delete

  function askTyped(question) {
    const readline = require('readline');
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question(question, (answer) => {
        rl.close();
        resolve(String(answer || '').trim());
      });
      rl.on('SIGINT', () => {
        rl.close();
        resolve('');
      });
    });
  }

  async function doDelete(p) {
    const f = p.flags;
    // The typed subcommand is the confirmation in scripts and skills; a person at a terminal types it again.
    if (process.stdin.isTTY && process.stderr.isTTY && !f.yes && !f.json) {
      const a = await askTyped('This deletes your cloned voice, its consent recording and the phrase cache. Type delete to confirm: ');
      if (a.toLowerCase() !== 'delete') {
        writeOut('Nothing was deleted.');
        return EXIT.ERROR;
      }
    }
    const d = await maybeDaemon();
    let r = d ? await daemonCall(d, 'POST', '/api/clone/delete', { confirm: 'delete' }, 60000) : null;
    if (!r) {
      const svc = localService();
      try {
        r = await svc.delete();
      } catch (err) {
        throw cliError(err.message, err.hint);
      } finally {
        await svc.shutdown().catch(() => {});
      }
    }
    if (f.json) {
      printJson({ ok: true, removed: Boolean(r && r.removed) });
      return EXIT.OK;
    }
    if (r && r.removed) writeOut(`${color.green(sym().ok)} Your cloned voice was deleted (profile, consent recording, phrase cache). Calls will not use it.`);
    else writeOut('There was no cloned voice to delete (voice.clone.enabled is off).');
    return EXIT.OK;
  }

  async function run(p) {
    const sub = String(p._[0] || 'start').toLowerCase();
    if (!SUBCOMMANDS.includes(sub)) throw usage(`Unknown clone-voice command "${sub}" (use ${SUBCOMMANDS.join(', ')})`);
    if (sub === 'install') return doInstall(p);
    if (sub === 'status') return doStatus(p);
    if (sub === 'test') return doTest(p);
    if (sub === 'bench') return doBench(p);
    if (sub === 'delete') return doDelete(p);
    return doStart(p);
  }

  return {
    'clone-voice': {
      run,
      group: 'Setup',
      summary: 'Record and clone your own voice (consent-gated, stays on this computer)',
      usage: 'anywhere clone-voice [start | install | status | test [TEXT] | bench | delete] [--engine pocket|zipvoice] [--json]',
      details: [
        'start (the default) opens the enrollment view in the dialog: a consent sentence with a one-time code, then 14 short lines (about 3 minutes).',
        'install downloads the free voice runtime into a private venv under ~/.claude-anywhere/voice (about 425 MB, once; --engine zipvoice adds the quality voice).',
        'Only your own live microphone recording is used; nothing is uploaded. delete removes the profile, the consent recording and the phrase cache.',
        'test plays a sentence in your cloned voice through the speakers; bench measures the engines on this computer.',
      ],
      spec: spec({ string: ['engine'], boolean: ['yes', 'local', 'standalone'], alias: { y: 'yes' } }),
    },
  };
}

module.exports = { commands, SUBCOMMANDS };
