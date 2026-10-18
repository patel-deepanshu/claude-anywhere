'use strict';

/**
 * `anywhere calls …`: AI-answered calls (docs/CALLS-DESIGN.md §10.5).
 *
 *   anywhere calls on [--for 2h | --until 18:00] [--apps cliq,meet] [--instructions TEXT]
 *        asks the dialog for a click-only card and waits: "Click Allow once in the Claude Anywhere dialog…"
 *   anywhere calls off                         stop answering at once (no confirmation needed)
 *   anywhere calls status                      armed or not, quiet hours, audio, the current and recent calls
 *   anywhere calls doctor [--deep]             everything calls need, with exact fixes
 *   anywhere calls test-audio [--no-open] [--no-wait]   the browser audio self-test (§5.5)
 *   anywhere calls learn [--seconds 60] [--app cliq]    calibrate a call app from a test call (§4.4)
 *   anywhere calls audio setup|teardown|check  the virtual microphone and caller capture (§5)
 *   anywhere calls cliq setup|test|gui|status  Zoho Cliq messages through the API (optional) or the window
 *   anywhere calls notes [--open] [-n N]       where the call notes are, and the latest ones
 *   all: --json
 *
 * Safeguard (d): arming is never stored. `calls on` only asks the running dialog, which shows a card
 * that only a click can allow; it expires and respects quiet hours. `calls off` disarms at once.
 */

const fs = require('fs');
const path = require('path');

const SUBCOMMANDS = ['on', 'off', 'status', 'doctor', 'test-audio', 'learn', 'audio', 'cliq', 'notes'];
const AUDIO_SUB = ['setup', 'teardown', 'check'];
const CLIQ_SUB = ['setup', 'test', 'gui', 'status'];
const ARM_WAIT_MS = 16 * 60 * 1000; // the card waits for the user; the daemon decides the timeout
const SELF_TEST_WAIT_MS = 3 * 60 * 1000;
const MAX_INSTRUCTIONS = 1000;
const APP_LABELS = { 'zoho-cliq': 'Zoho Cliq', 'google-meet': 'Google Meet', teams: 'Microsoft Teams', slack: 'Slack', zoom: 'Zoom' };

function cliError(message, hint, exitCode) {
  const e = new Error(message);
  e.name = 'CliError';
  e.exitCode = exitCode == null ? 1 : exitCode;
  if (hint) e.hint = hint;
  return e;
}

function usage(message) {
  const e = cliError(message, 'Run "anywhere help calls" for usage.');
  e.usage = true;
  return e;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------- pure helpers (exported for tests)

/**
 * "2h", "90m", "1h30m", "1.5h", "45" (minutes), "2 hours", "30 min" → minutes.
 * @returns {number|null}
 */
function parseDuration(text) {
  const s = String(text == null ? '' : text).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s));
  const re = /(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m)(?![a-z])/g;
  let total = 0;
  let matched = '';
  let m;
  while ((m = re.exec(s))) {
    total += Number(m[1]) * (m[2].startsWith('h') ? 60 : 1);
    matched += m[0];
  }
  if (!matched || s.replace(/\s+/g, '') !== matched.replace(/\s+/g, '')) return null;
  return Math.round(total);
}

/**
 * Minutes from now until a local "HH:MM" (tomorrow when it has passed today).
 * @returns {number|null}
 */
function minutesUntil(hhmm, now = new Date()) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const t = new Date(now.getTime());
  t.setHours(h, min, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return Math.max(1, Math.round((t - now) / 60000));
}

/** "cliq,meet" → ['zoho-cliq', 'google-meet']; 'all' → every known app; throws a usage error for unknown names. */
function parseApps(text) {
  const sig = require('../calls/signatures');
  const parts = String(text || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1 && parts[0].toLowerCase() === 'all') return sig.APP_IDS.slice();
  const out = [];
  const add = (p) => {
    const id = sig.appFromText(p);
    if (!id) throw usage(`Unknown call app "${p}" (use ${['cliq', 'meet', 'teams', 'slack', 'zoom'].join(', ')} or all)`);
    if (!out.includes(id)) out.push(id);
  };
  // "zoho cliq" is one app; "cliq meet" (no commas) is two.
  for (const p of parts) {
    if (sig.appFromText(p) && !/\s/.test(p.replace(/^(?:zoho|google|microsoft)\s+/i, ''))) add(p);
    else for (const w of p.split(/\s+/)) add(w);
  }
  return out;
}

function appLabel(id) {
  if (!id) return '';
  if (APP_LABELS[id]) return APP_LABELS[id];
  try {
    const a = require('../calls/signatures').appFromText(id);
    if (a && APP_LABELS[a]) return APP_LABELS[a];
  } catch {
    /* free text */
  }
  return String(id);
}

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function clock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** "18:00", or "Mon 09:30" when not today. */
function whenLabel(ms, now) {
  if (sameDay(ms, now)) return clock(ms);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ms).getDay()]} ${clock(ms)}`;
}

function durationLabel(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  if (m) return `${m} min${s && m < 10 ? ` ${s} s` : ''}`;
  return `${s} s`;
}

function callerName(c) {
  if (!c) return '';
  if (typeof c.caller === 'string') return c.caller;
  if (c.caller && typeof c.caller === 'object') return c.caller.displayName || c.caller.name || '';
  return c.callerName || '';
}

/** The parts of /api/calls/status this CLI shows, from whatever shape the daemon sends. */
function normalizeStatus(st = {}) {
  const s = st && typeof st === 'object' ? st : {};
  const until = toMs(s.until != null ? s.until : s.armedUntil);
  const audio = s.audio && typeof s.audio === 'object' ? s.audio : null;
  const call = s.current && typeof s.current === 'object' ? s.current : null;
  const recent = Array.isArray(s.recent) ? s.recent : [];
  return {
    armed: Boolean(s.armed) && (until == null || until > 0),
    until,
    apps: Array.isArray(s.apps) ? s.apps : [],
    quietHours: s.quietHours && typeof s.quietHours === 'object' ? s.quietHours : null,
    inQuietHours: Boolean(s.inQuietHours),
    pending: Boolean(s.pending || s.arming),
    audio: audio ? { mode: audio.mode || null, ready: audio.ready !== false, issues: Array.isArray(audio.issues) ? audio.issues : [] } : null,
    current: call
      ? {
          id: call.id || call.callId || null,
          caller: callerName(call),
          app: call.appName || appLabel(call.app),
          state: call.state || null,
          since: toMs(call.answeredAt || call.startedAt),
        }
      : null,
    recent: recent
      .filter((r) => r && typeof r === 'object')
      .map((r) => {
        const start = toMs(r.answeredAt || r.startedAt || r.ts || r.at);
        const end = toMs(r.endedAt);
        const notesPath = typeof r.notes === 'string' ? r.notes : (r.notes && r.notes.path) || r.notesPath || null;
        return {
          id: r.id || r.callId || null,
          caller: callerName(r) || 'Unknown caller',
          app: r.appName || appLabel(r.app),
          start,
          durationMs: Number.isFinite(r.durationMs) ? r.durationMs : start != null && end != null ? end - start : null,
          outcome: r.outcome || r.type || r.result || r.state || (notesPath ? 'answered' : ''),
          reason: r.reason || r.endReason || '',
          notesPath,
        };
      }),
  };
}

const OUTCOME_LABEL = {
  answered: 'answered by the assistant',
  ended: 'answered by the assistant',
  missed: 'missed',
  user_answered: 'you answered',
  you_answered: 'you answered',
  declined: 'not answered',
  not_answered: 'not answered',
  failed: 'could not answer',
  taken_over: 'you took over',
  takeover: 'you took over',
};

/** Why a call was not answered (CallManager reason codes) in words. */
const REASON_LABEL = {
  quiet_hours: 'quiet hours',
  busy: 'another call was active',
  app_not_armed: 'app not allowed',
  owner_active: 'you were at the computer',
  idle_unknown: 'could not tell if you were away',
  ring_ended: 'stopped ringing',
  not_answered: 'not picked up',
  audio: 'call audio failed',
};

function reasonLabel(r) {
  return REASON_LABEL[r] || String(r || '').replace(/_/g, ' ');
}

/**
 * The status lines of `anywhere calls status` (no colors; the caller adds them).
 * @param {object} raw /api/calls/status (or a local stand-in)
 * @param {{now?:number, notesDir?:string, voice?:string, running?:boolean}} [o]
 * @returns {string[]}
 */
function statusLines(raw, { now = Date.now(), notesDir = '', voice = '', running = true } = {}) {
  const st = normalizeStatus(raw);
  const lines = [];
  const apps = st.apps.map(appLabel).filter(Boolean).join(', ');
  if (!running) lines.push('Calls        not answering (the dialog is not running; arming never survives a restart)');
  else if (st.armed && st.until) lines.push(`Calls        answering until ${whenLabel(st.until, now)} (${durationLabel(st.until - now)} left)${apps ? ` · ${apps}` : ''}`);
  else if (st.armed) lines.push(`Calls        answering${apps ? ` · ${apps}` : ''}`);
  else if (st.pending) lines.push('Calls        waiting for your click on the card in the dialog');
  else lines.push('Calls        not answering · turn on: anywhere calls on (needs a click in the dialog)');
  const qh = st.quietHours;
  if (qh) {
    const on = qh.enabled !== false;
    lines.push(`Quiet hours  ${on ? `${qh.start || '22:00'}–${qh.end || '08:00'}` : 'off'}${on && st.inQuietHours ? ' · now: calls ring through and are noted as missed' : ''}`);
  }
  if (st.audio) {
    const mode = st.audio.mode === 'speakers' ? 'speakers + microphone (half duplex, lower quality)' : st.audio.mode === 'virtual' ? 'virtual microphone' : st.audio.mode || 'unknown';
    const first = st.audio.issues.find((i) => i && (i.level === 'error' || !i.level)) || st.audio.issues[0];
    lines.push(`Audio        ${mode}: ${st.audio.ready ? 'ready' : `not ready${first ? ` (${first.message || first.code})` : ''} · anywhere calls doctor`}`);
  }
  if (voice) lines.push(`Voice        ${voice}`);
  if (st.current) {
    const c = st.current;
    const dur = c.since ? ` · ${durationLabel(now - c.since)}` : '';
    lines.push(`Now          on a call with ${c.caller || 'an unknown caller'}${c.app ? ` (${c.app})` : ''}${dur}${c.state ? ` · ${c.state}` : ''}`);
  }
  if (st.recent.length) {
    lines.push('Recent');
    for (const r of st.recent.slice(0, 8)) {
      const when = r.start ? whenLabel(r.start, now) : '--:--';
      const dur = r.durationMs ? ` · ${durationLabel(r.durationMs)}` : '';
      const outcome = OUTCOME_LABEL[r.outcome] || r.outcome || '';
      const why = r.reason && ['missed', 'not_answered', 'failed'].includes(r.outcome) ? ` (${reasonLabel(r.reason)})` : '';
      lines.push(`  ${when}  ${r.caller}${r.app ? ` (${r.app})` : ''}${outcome ? ` · ${outcome}` : ''}${dur}${why}`);
      if (r.notesPath) lines.push(`         notes: ${r.notesPath}`);
    }
  }
  if (notesDir) lines.push(`Notes        ${notesDir}`);
  return lines;
}

// ---------------------------------------------------------------- doctor (§5.6)

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)} s`)), ms);
      if (t.unref) t.unref();
    }),
  ]).finally(() => clearTimeout(t));
}

/**
 * The calls rows of `anywhere calls doctor` and `anywhere doctor`, in the doctor's check format
 * ({id, label, status:'ok'|'warn'|'fail', detail, fix, notes, critical}). Changes nothing.
 * @param {{config?:object, env?:object, platformInfo?:object, deep?:boolean, network?:boolean, daemon?:{client:object}|null,
 *   call?:Function, getDriver?:()=>Promise<object>, cloneStatus?:()=>Promise<object>, timeoutMs?:number}} [opts]
 * @returns {Promise<object[]>}
 */
async function doctorChecks(opts = {}) {
  const configMod = require('../shared/config');
  const config = opts.config || configMod.load();
  const calls = config.calls || {};
  const env = opts.env || process.env;
  const pinfo = opts.platformInfo || require('../shared/platform').info();
  const winSide = pinfo.platform === 'win32' || pinfo.isWSL;
  const timeoutMs = opts.timeoutMs || 20000;
  const rows = [];
  const row = (id, label, status, detail, fix = '', notes = []) => rows.push({ id, label, status, detail, fix, notes, critical: false });
  const guard = async (id, label, fn) => {
    try {
      await withTimeout(Promise.resolve().then(fn), timeoutMs, label);
    } catch (err) {
      row(id, label, 'fail', (err && err.message) || String(err), (err && err.hint) || '');
    }
  };
  const driverP = () => (opts.getDriver ? opts.getDriver() : require('../os').getDriver());

  // Safeguards (always): how answering is switched on.
  const qh = calls.quietHours || {};
  row(
    'calls-safety',
    'Call answering',
    'ok',
    `off until you arm it with a click (at most ${Math.round((calls.maxArmMinutes || 720) / 60)} h); quiet hours ${qh.enabled === false ? 'off' : `${qh.start || '22:00'}–${qh.end || '08:00'}`}`,
    '',
    ['The assistant always says it is an AI and that it takes notes; it can only use the call tools.'],
  );

  // Voice: the cloned voice (else Piper / the OS voice, and the disclosure drops "in his voice").
  await guard('calls-voice', 'Cloned voice', async () => {
    let st = null;
    if (typeof opts.cloneStatus === 'function') st = await opts.cloneStatus();
    else if (opts.daemon && opts.call) {
      try {
        st = await opts.call(opts.daemon.client, 'GET', '/api/clone/status', undefined, { timeoutMs: 15000 });
      } catch {
        st = null;
      }
    }
    if (!st) {
      const { CloneService } = require('../voice/clone');
      const quiet = { debug() {}, info() {}, warn() {}, error() {} };
      const svc = new CloneService({ config, idleMs: 0, log: quiet });
      try {
        st = await svc.status();
      } finally {
        await svc.shutdown().catch(() => {});
      }
    }
    const pr = (st && st.profile) || {};
    // The runtime (installer.status(): runtime.ok/outdated/python/sherpa, missing assets): STT is needed
    // for every call, with or without a cloned voice.
    const rt = (st && st.runtime) || {};
    const r2 = rt.runtime || {};
    const missing = Array.isArray(rt.missing) ? rt.missing : Array.isArray(st && st.missing) ? st.missing : [];
    const rtDetail = [r2.python ? `Python ${r2.python}` : '', r2.sherpa ? `sherpa-onnx ${r2.sherpa}` : ''].filter(Boolean).join(', ');
    if (st && st.installed && (r2.ok === false || r2.outdated)) {
      row('calls-runtime', 'Voice runtime', 'warn', `${r2.outdated ? 'outdated' : 'not working'}${rtDetail ? ` (${rtDetail})` : ''}`, 'Repair it: anywhere clone-voice install');
    } else if (st && !st.installed && missing.length && r2.venv) {
      row('calls-runtime', 'Voice runtime', 'warn', `models missing: ${missing.slice(0, 4).join(', ')}`, 'anywhere clone-voice install');
    } else if (st && st.installed) row('calls-runtime', 'Voice runtime', 'ok', rtDetail || 'installed');
    if (!st || !st.installed) row('calls-voice', 'Cloned voice', 'warn', 'voice runtime not installed: calls cannot listen or speak yet', 'anywhere clone-voice install, then anywhere clone-voice');
    else if (!pr.exists) row('calls-voice', 'Cloned voice', 'warn', 'no voice recorded: calls use the standard voice', 'anywhere clone-voice (or /anywhere:clone-voice)');
    else if (pr.ok === false) row('calls-voice', 'Cloned voice', 'fail', `the voice profile is unusable (${pr.reason || 'invalid'})`, 'Record it again: anywhere clone-voice');
    else {
      // bench.json (installer.bench): engines.<engine>.runs and recommended.pocket.realtime (§5.6 speed).
      const bench = st.bench || {};
      const eng = st.engine || 'pocket';
      const runs = bench.engines && bench.engines[eng] && Array.isArray(bench.engines[eng].runs) ? bench.engines[eng].runs : Array.isArray(bench.runs) ? bench.runs : [];
      const slowRun = runs.find((r) => r && (r.engine == null || r.engine === eng) && Number(r.threads) === 2 && Number(r.rtf) > 0.9);
      const rec = bench.recommended && bench.recommended.pocket;
      const slow = Boolean(slowRun) || (eng === 'pocket' && rec && rec.realtime === false);
      const speed = rec && Number.isFinite(Number(rec.rtf)) ? `, speed ${Number(rec.rtf).toFixed(2)}× real time at ${rec.threads} threads` : '';
      row('calls-voice', 'Cloned voice', slow ? 'warn' : 'ok', `${eng} voice of ${pr.ownerName || 'you'}${pr.testSimilarity != null ? `, test match ${pr.testSimilarity}` : ''}${speed}`, slow ? 'This computer is slow for live speech; calls lean on pre-rendered phrases. Check: anywhere clone-voice bench' : '');
    }
  });

  // Audio routing (B4's checks; `deep` records 1 s from the caller capture).
  await guard('calls-audio', 'Call audio', async () => {
    const ab = require('../calls/audio-bridge');
    const extra = {};
    if (typeof opts.runner === 'function') extra.runner = opts.runner;
    if (typeof opts.which === 'function') extra.which = opts.which;
    if (opts.resultFile) extra.resultFile = opts.resultFile;
    const out = await ab.doctorChecks({ config, platformInfo: pinfo, record: Boolean(opts.deep), deep: Boolean(opts.deep), ...(winSide ? { psHost: () => driverP() } : {}), ...extra });
    rows.push(...out);
  });

  // Detection.
  await guard('calls-detect', 'Call detection', async () => {
    const notes = [];
    let status = 'ok';
    let fix = '';
    let windowsOk = false;
    try {
      const d = await driverP();
      const list = await d.listWindows();
      windowsOk = Array.isArray(list);
      if (winSide && typeof d.toastTexts === 'function') {
        try {
          await d.toastTexts({ budgetMs: 500 });
          notes.push('Windows notifications can be read (UI Automation).');
        } catch (err) {
          status = 'warn';
          notes.push(`Windows notifications cannot be read (${err.message}); window titles and vision still work.`);
        }
      }
    } catch (err) {
      status = 'fail';
      fix = 'Run anywhere doctor for the desktop driver.';
      notes.push(`Window list: ${err.message}`);
    }
    if (pinfo.platform === 'linux' && !pinfo.isWSL) {
      const which = typeof opts.which === 'function' ? opts.which : require('../shared/proc').which;
      // notifications.js prefers `busctl --user monitor` and falls back to dbus-monitor.
      const tool = which('busctl') ? 'busctl' : which('dbus-monitor') ? 'dbus-monitor' : null;
      if (!tool || !env.DBUS_SESSION_BUS_ADDRESS) {
        if (status === 'ok') status = 'warn';
        notes.push('Desktop notifications are not watched (needs busctl or dbus-monitor and a session bus): install dbus (e.g. sudo apt install dbus).');
      } else notes.push(`Desktop notifications are watched through ${tool}.`);
    }
    if (pinfo.platform === 'darwin') notes.push('macOS notifications are not readable: window titles, screen changes and vision find the ring.');
    let learned = [];
    try {
      learned = require('../calls/signatures').loadLearned();
    } catch {
      learned = [];
    }
    const apps = Array.isArray(calls.apps) ? calls.apps : [];
    const cliqLearned = learned.some((s) => s && s.app === 'zoho-cliq');
    if (apps.includes('zoho-cliq') && !cliqLearned) {
      if (status === 'ok') status = 'warn';
      fix = fix || 'Calibrate Zoho Cliq with a test call: anywhere calls learn --app cliq';
      notes.push("Zoho Cliq's ringing screen is not documented: calibrate it once, and keep Cliq in its own window.");
    }
    const det = calls.detect || {};
    const off = Object.entries(det).filter(([, v]) => v === false).map(([k]) => k);
    if (off.length) notes.push(`Turned off: ${off.join(', ')} (calls.detect).`);
    row('calls-detect', 'Call detection', status, `${windowsOk ? 'window titles' : 'no window list'}; ${learned.length} learned signature${learned.length === 1 ? '' : 's'}`, fix, notes);
  });

  // Claude (the call engine and vision use haiku through the user's own login).
  await guard('calls-claude', 'Claude for calls', async () => {
    const { ClaudeCliEngine } = require('../daemon/engine-cli');
    const found = await ClaudeCliEngine.locate(config);
    if (!found || !found.path) row('calls-claude', 'Claude for calls', 'fail', 'the claude CLI was not found', 'Install Claude Code, or set engine.claudePath.');
    else row('calls-claude', 'Claude for calls', 'ok', `${calls.model || 'haiku'} through ${found.path}`);
  });

  // Jira (ticket requests) and Cliq (messages after the call).
  await guard('calls-jira', 'Jira for calls', async () => {
    const J = require('../integrations/jira');
    const s = J.resolveSettings(config, env);
    const projects = calls.jira && Array.isArray(calls.jira.projects) && calls.jira.projects.length ? calls.jira.projects.join(', ') : 'the projects of your open issues';
    if (s.configured) row('calls-jira', 'Jira for calls', 'ok', `${s.baseUrl}; callers can get tickets from ${projects}`);
    else row('calls-jira', 'Jira for calls', 'warn', 'not connected: ticket requests are noted as follow-ups for you', 'anywhere jira setup');
  });
  await guard('calls-cliq', 'Cliq messages', async () => {
    const c = calls.cliq || {};
    if (c.mode !== 'api') {
      row('calls-cliq', 'Cliq messages', 'ok', 'through the Cliq window after the call (no setup); the API is optional: anywhere calls cliq setup');
      return;
    }
    const { CliqApi } = require('../calls/cliq');
    const api = CliqApi.fromConfig(config, opts.http ? { http: opts.http } : {});
    if (!api) {
      row('calls-cliq', 'Cliq messages', 'warn', 'calls.cliq.mode is api but the credentials are incomplete: the Cliq window is used', 'anywhere calls cliq setup');
      return;
    }
    if (opts.network === false) {
      row('calls-cliq', 'Cliq messages', 'ok', `Zoho Cliq API (${api.dc}); not tested`);
      return;
    }
    try {
      await api.test();
      row('calls-cliq', 'Cliq messages', 'ok', `Zoho Cliq API (${api.dc}): the token refreshes`);
    } catch (err) {
      row('calls-cliq', 'Cliq messages', 'warn', `Zoho Cliq API (${api.dc}): ${err.message}; the Cliq window is used instead`, err.hint || 'anywhere calls cliq setup');
    }
  });

  // Notes.
  await guard('calls-notes', 'Call notes', async () => {
    const notes = require('../calls/notes');
    let driver = null;
    if (winSide) {
      try {
        driver = await driverP();
      } catch {
        driver = null;
      }
    }
    rows.push(await notes.doctorRow({ config, env, platformInfo: pinfo, driver, ...(opts.notesOptions || {}) }));
  });
  return rows;
}

// ---------------------------------------------------------------- commands

/**
 * @param {object} h helpers from bin/anywhere.js (tests may add env, prompter, stdin, now, openTarget, http,
 *   doctorChecks, selfTestFile, pollMs, notesOptions)
 * @returns {Object<string, object>}
 */
function commands(h) {
  const { spec, shared, call, requireDaemon, ensureDaemon, writeOut, writeErr, printJson, sym, color, EXIT } = h;
  const env = h.env || process.env;
  const now = typeof h.now === 'function' ? h.now : Date.now;
  const STOPPED = EXIT.STOPPED != null ? EXIT.STOPPED : EXIT.ERROR;
  const TIMEOUT = EXIT.TIMEOUT != null ? EXIT.TIMEOUT : EXIT.ERROR;
  const openTarget = h.openTarget || ((target, o) => require(path.join(__dirname, '..', 'os', 'common')).openTarget(target, o));

  async function maybeDaemon() {
    try {
      return await requireDaemon();
    } catch (err) {
      if (err && err.exitCode === EXIT.NOT_RUNNING) return null;
      throw err;
    }
  }

  const noRoutes = () => cliError('This Claude Anywhere daemon cannot answer calls yet.', 'Restart it to load the update: anywhere restart');

  /** Call a daemon route; null when the route does not exist (an older daemon). */
  async function daemonCall(d, method, p, body, timeoutMs = 30000) {
    try {
      return await call(d.client, method, p, body, { timeoutMs });
    } catch (err) {
      if (err && err.status === 404 && /not found/i.test(err.serverMessage || err.message)) return null;
      throw err;
    }
  }

  function config() {
    return shared('config').load();
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
          } catch {
            return false;
          }
        })
        .sort((a, b) => b.at.localeCompare(a.at));
      if (entries.length) return entries[0].dir;
    } catch {
      /* no history */
    }
    return process.cwd();
  }

  function notesOpts(cfg) {
    return { config: cfg, env, ...(h.notesOptions || {}) };
  }

  // ------------------------------------------------------------ on / off

  function armMinutes(f, cfg) {
    const c = cfg.calls || {};
    const max = Number(c.maxArmMinutes) > 0 ? Number(c.maxArmMinutes) : 720;
    if (f.for != null && f.until != null) throw usage('Use --for or --until, not both.');
    let minutes = null;
    if (f.for != null) {
      minutes = parseDuration(f.for);
      if (minutes == null || minutes < 1) throw usage(`--for takes a duration such as 2h, 90m or 1h30m (got "${f.for}")`);
    } else if (f.until != null) {
      minutes = minutesUntil(f.until, new Date(now()));
      if (minutes == null) throw usage(`--until takes a local time such as 18:00 (got "${f.until}")`);
    }
    if (minutes != null && minutes > max) throw usage(`Calls can be answered for at most ${Math.round(max / 60)} hours at a time (calls.maxArmMinutes).`);
    return minutes;
  }

  async function doOn(p) {
    const f = p.flags;
    const cfg = config();
    const minutes = armMinutes(f, cfg);
    const apps = f.apps != null ? parseApps(f.apps) : null;
    if (f.apps != null && !apps) throw usage('--apps needs app names, e.g. --apps cliq,meet');
    const fromArgs = p._.slice(1).concat(p.rest || []).join(' ').trim();
    const instructions = String(f.instructions != null ? f.instructions : fromArgs).trim();
    if (instructions.length > MAX_INSTRUCTIONS) throw usage(`--instructions is too long (at most ${MAX_INSTRUCTIONS} characters).`);
    let d = await maybeDaemon();
    let started = false;
    if (!d) {
      await ensureDaemon({ project: lastProject(), open: true, keepMode: true });
      d = await requireDaemon();
      started = true;
    }
    const body = { via: 'cli' };
    if (minutes != null) body.minutes = minutes;
    if (apps) body.apps = apps;
    if (instructions) body.instructions = instructions;
    writeErr(`Click Allow once in the Claude Anywhere dialog to let the assistant answer your calls${minutes != null ? ` for ${durationLabel(minutes * 60000)}` : ''}${started ? ' (the dialog is opening)' : ''}…`);
    // Stopping this command (Ctrl+C) closes the request, and the daemon withdraws the card.
    let r;
    try {
      r = await daemonCall(d, 'POST', '/api/calls/arm', body, ARM_WAIT_MS);
    } catch (err) {
      if (err && /timed out/i.test(err.message)) {
        if (f.json) printJson({ ok: false, armed: false, timedOut: true });
        else writeOut(`${color.yellow(sym().warn)} Nobody clicked the card in time, so it was withdrawn: calls are not being answered. Run it again when you are at the dialog.`);
        return TIMEOUT;
      }
      throw err;
    }
    if (!r) throw noRoutes();
    const armed = Boolean(r.ok !== false && r.armed);
    // Not allowed (the card was denied or withdrawn) vs could not arm (no voice, no dialog, busy…).
    const failed = !armed && !r.denied && Boolean(r.error);
    if (f.json) {
      printJson({ ok: armed, armed, until: r.until || null, denied: !armed && !failed, reason: r.reason || null, error: r.error || null, code: r.code || null, hint: r.hint || null, apps: r.apps || apps || null });
      return armed ? EXIT.OK : failed ? EXIT.ERROR : STOPPED;
    }
    if (failed) throw cliError(`Could not turn on call answering: ${r.error}`, r.hint);
    if (!armed) {
      const why = r.reason || (r.denied && r.error) ? ` (${r.reason || r.error})` : '';
      writeOut(`${color.yellow(sym().warn)} Not answering calls: it was not allowed${why}.`);
      return STOPPED;
    }
    const until = toMs(r.until);
    const list = (Array.isArray(r.apps) ? r.apps : apps || (cfg.calls && cfg.calls.apps) || []).map(appLabel).join(', ');
    writeOut(`${color.green(sym().ok)} Answering your calls${until ? ` until ${whenLabel(until, now())}` : ''}${list ? ` (${list})` : ''}.`);
    writeOut('  The assistant says it is an AI and that it takes notes; notes go to your Desktop.');
    writeOut('  Stop any time: anywhere calls off (or the Calls panel in the dialog).');
    if (r.inQuietHours) writeOut(`  Quiet hours are on now: calls ring through until ${(cfg.calls && cfg.calls.quietHours && cfg.calls.quietHours.end) || '08:00'}.`);
    return EXIT.OK;
  }

  async function doOff(p) {
    const d = await maybeDaemon();
    if (!d) {
      if (p.flags.json) printJson({ ok: true, armed: false, running: false });
      else writeOut('Calls are not being answered (the dialog is not running, and arming never survives a restart).');
      return EXIT.OK;
    }
    const r = await daemonCall(d, 'POST', '/api/calls/disarm', { via: 'cli' }, 15000);
    if (!r) throw noRoutes();
    if (p.flags.json) printJson({ ok: true, armed: false, wasArmed: r.wasArmed != null ? Boolean(r.wasArmed) : undefined });
    else writeOut(`${color.green(sym().ok)} Stopped answering calls.`);
    return EXIT.OK;
  }

  // ------------------------------------------------------------ status

  async function voiceLine(d) {
    try {
      const st = await call(d.client, 'GET', '/api/clone/status', undefined, { timeoutMs: 8000 });
      const pr = (st && st.profile) || {};
      if (pr.exists && pr.ok !== false) return `your cloned voice (${st.engine || pr.engine || 'pocket'})`;
      return 'the standard voice (record yours: anywhere clone-voice)';
    } catch {
      return '';
    }
  }

  async function doStatus(p) {
    const cfg = config();
    const d = await maybeDaemon();
    let st = null;
    if (d) {
      st = await daemonCall(d, 'GET', '/api/calls/status', undefined, 15000);
      if (!st) throw noRoutes();
    }
    let folder = null;
    try {
      folder = await require(path.join(__dirname, '..', 'calls', 'notes')).notesFolder(notesOpts(cfg));
    } catch {
      folder = null;
    }
    const local = { armed: false, apps: (cfg.calls && cfg.calls.apps) || [], quietHours: (cfg.calls && cfg.calls.quietHours) || null };
    if (p.flags.json) {
      printJson({ running: Boolean(d), ...(st || local), notesDir: folder ? folder.dir : null });
      return EXIT.OK;
    }
    const voice = d ? await voiceLine(d) : '';
    for (const line of statusLines(st || local, { now: now(), notesDir: folder ? folder.dir : '', voice, running: Boolean(d) })) writeOut(line);
    if (folder && folder.synced) writeOut(color.dim(`             (synced by ${folder.synced === 'onedrive' ? 'OneDrive' : 'iCloud'}: set calls.notesDir to keep notes local)`));
    return EXIT.OK;
  }

  // ------------------------------------------------------------ doctor

  async function doDoctor(p) {
    const d = await maybeDaemon();
    const run = h.doctorChecks || doctorChecks;
    const rows = await run({ config: config(), env, deep: Boolean(p.flags.deep), daemon: d, call, http: h.http, notesOptions: h.notesOptions });
    const ok = !rows.some((r) => r.status === 'fail');
    if (p.flags.json) {
      printJson({ ok, checks: rows });
      return ok ? EXIT.OK : EXIT.ERROR;
    }
    const s = sym();
    const width = Math.max(18, ...rows.map((r) => String(r.label).length));
    writeOut('Calls doctor');
    for (const r of rows) {
      const mark = r.status === 'ok' ? color.green(s.ok) : r.status === 'warn' ? color.yellow(s.warn) : color.red(s.fail);
      const one = (t) => String(t == null ? '' : t).replace(/\s*[\r\n]+\s*/g, ' ').trim();
      writeOut(`  ${mark} ${String(r.label).padEnd(width)} ${one(r.detail)}`);
      for (const n of r.notes || []) writeOut(color.dim(`      ${s.dot} ${one(n)}`));
      if (r.fix && r.status !== 'ok') writeOut(`      ${color.cyan('fix:')} ${one(r.fix)}`);
    }
    const fails = rows.filter((r) => r.status === 'fail').length;
    const warns = rows.filter((r) => r.status === 'warn').length;
    writeOut('');
    writeOut(!fails && !warns ? `${color.green(s.ok)} Ready to answer calls: anywhere calls on` : `${fails} problem${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}.`);
    return ok ? EXIT.OK : EXIT.ERROR;
  }

  // ------------------------------------------------------------ test-audio

  function selfTestFile() {
    if (h.selfTestFile) return h.selfTestFile;
    return path.join(shared('paths').runDir(), 'calls-audio-test.json');
  }

  function readSelfTest() {
    try {
      return JSON.parse(fs.readFileSync(selfTestFile(), 'utf8'));
    } catch {
      return null;
    }
  }

  function selfTestPart(x) {
    if (!x) return 'not run';
    if (x.pass) return `pass${x.verified === 'level' ? ' (level only)' : ''}${x.transcript ? ` (heard "${String(x.transcript).slice(0, 60)}")` : ''}`;
    return `fail${x.transcript ? ` (heard "${String(x.transcript).slice(0, 60)}")` : x.error ? ` (${x.error.message || x.error})` : ''}`;
  }

  async function doTestAudio(p) {
    const f = p.flags;
    const d = await requireDaemon('(the audio self-test runs in the dialog)');
    const before = readSelfTest();
    const r = await daemonCall(d, 'POST', '/api/calls/audio-test/start', {}, 30000);
    if (!r) throw noRoutes();
    let url = String(r.url || r.path || '');
    if (url.startsWith('/')) url = `${d.client.baseUrl}${url}`;
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//.test(url)) throw cliError('The daemon returned no self-test link.');
    let opened = false;
    let openError = null;
    if (f.open !== false) {
      try {
        await openTarget(url, { kind: 'url' });
        opened = true;
      } catch (err) {
        openError = err.message;
      }
    }
    if (!f.json) {
      writeErr(opened ? 'The audio self-test opened in your default browser.' : `Open this link${openError ? ` (could not open it: ${openError})` : ''}:`);
      writeErr(`  ${url}`);
      writeErr('  If your calls run in another browser (Brave, Edge…), open the link there instead. It works once, for 2 minutes.');
      writeErr('  Allow the microphone when the page asks; it plays and records a few seconds of test speech.');
    }
    if (f.wait === false) {
      if (f.json) printJson({ ok: true, url, opened, waiting: false });
      return EXIT.OK;
    }
    const startedAt = before && before.at ? Date.parse(before.at) : 0;
    const deadline = Date.now() + (h.selfTestWaitMs || SELF_TEST_WAIT_MS);
    let result = null;
    while (Date.now() < deadline) {
      await sleep(h.pollMs || 1000);
      const cur = readSelfTest();
      if (cur && cur.at && Date.parse(cur.at) > startedAt) {
        result = cur;
        break;
      }
    }
    if (!result) {
      if (f.json) printJson({ ok: false, url, opened, timedOut: true });
      else writeOut(`${color.yellow(sym().warn)} No result yet. Finish the test in the browser, then check: anywhere calls doctor`);
      return TIMEOUT;
    }
    if (f.json) {
      printJson({ ok: Boolean(result.pass), url, opened, result });
      return result.pass ? EXIT.OK : EXIT.ERROR;
    }
    const mark = result.pass ? color.green(sym().ok) : color.red(sym().fail);
    writeOut(`${mark} Call audio self-test: ${result.pass ? 'passed' : 'failed'}`);
    writeOut(`  Your voice to the call (virtual microphone): ${selfTestPart(result.mic)}`);
    writeOut(`  The caller to the assistant (capture):       ${selfTestPart(result.capture)}`);
    if (!result.pass) writeOut('  If the call app has a specific microphone selected, choose "Default" in its audio settings. More: anywhere calls doctor');
    return result.pass ? EXIT.OK : EXIT.ERROR;
  }

  // ------------------------------------------------------------ learn

  async function doLearn(p) {
    const f = p.flags;
    const seconds = f.seconds != null ? Number(f.seconds) : 60;
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 300) throw usage('--seconds must be a whole number from 10 to 300');
    let app;
    if (f.app != null) {
      const list = parseApps(f.app);
      if (!list || list.length !== 1) throw usage('--app takes one app, e.g. --app cliq');
      app = list[0];
    }
    const d = await requireDaemon('(learning a call app runs in the dialog)');
    if (!f.json) {
      writeErr(`Place a test call to this computer now${app ? ` on ${appLabel(app)}` : ''} and let it ring. Listening for ${seconds} s…`);
      writeErr('  When the dialog says the ring was seen, you may answer and hang up a few seconds later: that also teaches how a call in progress looks.');
      writeErr('  Tip: keep the call app in its own window (for Zoho Cliq: "Open in new window" or install it as an app).');
    }
    const r = await daemonCall(d, 'POST', '/api/calls/learn', { seconds, ...(app ? { app } : {}) }, (seconds + 90) * 1000);
    if (!r) throw noRoutes();
    if (f.json) {
      printJson(r);
      return r.ok ? EXIT.OK : EXIT.ERROR;
    }
    if (!r.ok) throw cliError(`Nothing was learned: ${r.reason || 'no ringing call was seen'}`, 'Try again while a test call rings, or name the app: anywhere calls learn --app cliq');
    const s = r.signature || {};
    writeOut(`${color.green(sym().ok)} Learned how ${appLabel(s.app) || 'the app'} rings. Saved for future calls.`);
    const parts = [];
    if (s.titleRe) parts.push(`title /${s.titleRe}/`);
    if (s.notifRe) parts.push(`notification /${s.notifRe}/`);
    if (s.origin) parts.push(`site ${s.origin}`);
    if (s.acceptRel) parts.push('Accept button position');
    if (parts.length) writeOut(`  Recognized by: ${parts.join(', ')}`);
    return EXIT.OK;
  }

  // ------------------------------------------------------------ audio

  async function localBridge() {
    const { AudioBridge } = require(path.join(__dirname, '..', 'calls', 'audio-bridge'));
    const pinfo = shared('platform').info();
    const winSide = pinfo.platform === 'win32' || pinfo.isWSL;
    return new AudioBridge({ config: config(), platformInfo: pinfo, ...(winSide ? { psHost: () => require(path.join(__dirname, '..', 'os')).getDriver() } : {}) });
  }

  function printCheck(c) {
    const s = sym();
    const mode = c.mode === 'virtual' ? `virtual microphone ${c.virtualMic || ''}`.trim() : 'speakers + microphone (half duplex, lower quality)';
    writeOut(`Audio        ${mode}: ${c.ready ? color.green('ready') : color.yellow('not ready')}${c.server ? color.dim(`  (${c.server})`) : ''}`);
    if (c.capture) writeOut(`Caller       ${c.capture.backend || ''}${c.capture.device ? ` ${c.capture.device}` : ''}`);
    for (const i of c.issues || []) {
      const mark = i.level === 'error' ? color.red(s.fail) : i.level === 'warn' ? color.yellow(s.warn) : color.dim(s.dot);
      writeOut(`  ${mark} ${i.message || i.code}`);
      if (i.hint && i.level !== 'info') writeOut(`      ${color.cyan('fix:')} ${i.hint}`);
    }
  }

  async function doAudio(p) {
    const sub = String(p._[1] || 'check').toLowerCase();
    if (!AUDIO_SUB.includes(sub)) throw usage(`Unknown audio command "${sub}" (use ${AUDIO_SUB.join(', ')})`);
    const d = await maybeDaemon();
    let r = null;
    if (d) r = sub === 'check' ? await daemonCall(d, 'GET', '/api/calls/audio/check', undefined, 30000) : await daemonCall(d, 'POST', `/api/calls/audio/${sub}`, {}, 60000);
    let source = 'daemon';
    if (!r) {
      source = 'local';
      const bridge = typeof h.audioBridge === 'function' ? await h.audioBridge() : await localBridge();
      try {
        r = sub === 'check' ? await bridge.check() : sub === 'setup' ? await bridge.setup() : await bridge.teardown();
      } catch (err) {
        throw cliError(`Audio ${sub} failed: ${err.message}`, err.hint);
      }
    }
    if (p.flags.json) {
      printJson({ ...r, source });
      return r.ok === false ? EXIT.ERROR : EXIT.OK;
    }
    if (sub === 'check') {
      printCheck(r.check || r);
      return EXIT.OK;
    }
    const s = sym();
    if (sub === 'setup') {
      if (r.ok === false) throw cliError(`The call audio devices could not be set up${r.error ? `: ${r.error}` : ''}.`, 'See: anywhere calls doctor');
      writeOut(`${color.green(s.ok)} Call audio is set up (${r.mode === 'speakers' ? 'speakers + microphone' : 'virtual microphone'}).`);
      writeOut('  The default microphone is switched only while the assistant is on a call, and always restored.');
    } else {
      const errors = Array.isArray(r.errors) ? r.errors : [];
      writeOut(errors.length ? `${color.yellow(s.warn)} Call audio removed, with problems: ${errors.map((e) => e.message).join('; ')}` : `${color.green(s.ok)} Call audio devices removed and your audio restored.`);
    }
    return EXIT.OK;
  }

  // ------------------------------------------------------------ cliq

  async function tellDaemon(partial) {
    const d = await maybeDaemon();
    if (!d) return false;
    try {
      await call(d.client, 'POST', '/api/config', partial, { timeoutMs: 10000 });
      return true;
    } catch (err) {
      writeErr(`${color.yellow(sym().warn)} The running dialog did not take the new Cliq settings (${err.message}); restart it to pick them up.`);
      return false;
    }
  }

  async function doCliqSetup(p) {
    const C = require(path.join(__dirname, '..', 'calls', 'cliq'));
    const jiraCli = require('./jira');
    const f = p.flags;
    if (f.secret != null || f['client-secret'] != null) throw usage('The client secret is never taken as an argument: pipe it with --secret-stdin, or type it when asked.');
    const saved = (config().calls || {}).cliq || {};
    const prompter = h.prompter || jiraCli.createPrompter();
    const interactive = !f['secret-stdin'] && prompter.interactive;
    const out = f.json ? () => {} : (s) => writeErr(s);
    let dc;
    try {
      dc = f.dc != null ? C.normalizeDc(C.dcFromUrl(f.dc) || f.dc) : null;
    } catch (err) {
      throw usage(err.message);
    }
    if (!dc && interactive) {
      out('Send Cliq messages through the Zoho Cliq API (optional; without it the assistant types the message in your Cliq window).');
      for (let tries = 0; !dc; tries++) {
        const a = await prompter.ask('Your Cliq address or data center (com, eu, in, com.au, jp, ca)', { defaultValue: saved.dc || 'com' });
        try {
          dc = C.normalizeDc(C.dcFromUrl(a) || a);
        } catch (err) {
          if (tries >= 2) throw usage(err.message);
          out(`  ${err.message}`);
        }
      }
    }
    if (!dc) dc = C.normalizeDc(saved.dc || 'com');
    if (interactive) {
      out(`1. Open ${C.apiConsoleUrl(dc)} → Add Client → Self Client → Create.`);
      out(`2. In "Generate Code" enter the scope ${C.SCOPE}, 10 minutes, any description → Create, and copy the code.`);
      out('3. The Client ID and Client Secret are on the "Client Secret" tab.');
    }
    let clientId = typeof f['client-id'] === 'string' ? f['client-id'].trim() : '';
    if (!clientId && interactive) clientId = await prompter.ask('Client ID', { defaultValue: saved.dc === dc ? saved.clientId || '' : '' });
    if (!clientId) throw usage('Pass the Self Client ID: --client-id 1000.XXXX');
    let clientSecret = '';
    if (f['secret-stdin']) {
      clientSecret = await jiraCli.readStdinToken(h.stdin || process.stdin);
      if (!clientSecret) throw usage('No client secret arrived on stdin.');
    } else if (interactive) {
      clientSecret = await prompter.secret('Client Secret');
    }
    if (!clientSecret) throw usage(`No terminal to type the client secret in: pipe it, e.g. printf %s "$SECRET" | anywhere calls cliq setup --dc ${dc} --client-id ${clientId} --code CODE --secret-stdin`);
    let code = typeof f.code === 'string' ? f.code.trim() : '';
    if (!code && interactive) code = await prompter.secret('Grant code');
    if (!code) throw usage('Pass the grant code you generated (it works once, for a few minutes): --code 1000.xxxx');
    out('Exchanging the grant code with Zoho …');
    let res;
    try {
      res = await C.CliqApi.exchangeGrant({ dc, clientId, clientSecret, code, http: h.http });
    } catch (err) {
      throw cliError(`Zoho did not accept it, so nothing was saved: ${err.message}`, err.hint);
    }
    const cliq = { mode: 'api', dc, clientId, clientSecret, refreshToken: res.refreshToken };
    shared('config').save({ calls: { cliq } });
    const told = await tellDaemon({ calls: { cliq } });
    if (f.json) {
      printJson({ ok: true, mode: 'api', dc, dialogUpdated: told });
      return EXIT.OK;
    }
    writeOut(`${color.green(sym().ok)} Cliq messages after calls go through the Zoho Cliq API (cliq.zoho.${dc}).`);
    writeOut(`  Saved to ${shared('paths').configPath()} (only your user can read it; the secrets are never shown).`);
    writeOut('  Check it: anywhere calls cliq test   ·   back to the Cliq window: anywhere calls cliq gui');
    return EXIT.OK;
  }

  async function doCliq(p) {
    const sub = String(p._[1] || 'status').toLowerCase();
    if (!CLIQ_SUB.includes(sub)) throw usage(`Unknown cliq command "${sub}" (use ${CLIQ_SUB.join(', ')})`);
    if (sub === 'setup') return doCliqSetup(p);
    const C = require(path.join(__dirname, '..', 'calls', 'cliq'));
    const cfg = config();
    const c = (cfg.calls && cfg.calls.cliq) || {};
    if (sub === 'gui') {
      shared('config').save({ calls: { cliq: { mode: 'gui', clientSecret: '', refreshToken: '' } } });
      await tellDaemon({ calls: { cliq: { mode: 'gui' } } });
      if (p.flags.json) printJson({ ok: true, mode: 'gui' });
      else {
        writeOut(`${color.green(sym().ok)} Cliq messages after calls are typed in your Cliq window (no API). The saved Zoho tokens were removed.`);
        if (c.clientId) writeOut(`  You can also delete the Self Client at ${C.apiConsoleUrl(c.dc || 'com')}.`);
      }
      return EXIT.OK;
    }
    const api = C.CliqApi.fromConfig(cfg, h.http ? { http: h.http } : {});
    if (sub === 'status') {
      const out = { mode: c.mode === 'api' ? 'api' : 'gui', dc: c.dc || 'com', configured: Boolean(api) };
      if (p.flags.json) printJson(out);
      else if (out.mode === 'api') writeOut(`Cliq messages  Zoho Cliq API (cliq.zoho.${out.dc})${api ? '' : color.yellow(': credentials incomplete, so the Cliq window is used')}`);
      else writeOut('Cliq messages  typed in your Cliq window after the call (no setup) · API: anywhere calls cliq setup');
      return EXIT.OK;
    }
    // test
    if (!api) throw cliError('The Zoho Cliq API is not set up.', 'Run: anywhere calls cliq setup');
    try {
      await api.test();
    } catch (err) {
      throw cliError(`Zoho Cliq API: ${err.message}`, err.hint);
    }
    if (p.flags.json) printJson({ ok: true, mode: c.mode === 'api' ? 'api' : 'gui', dc: api.dc });
    else {
      writeOut(`${color.green(sym().ok)} The Zoho Cliq API works (cliq.zoho.${api.dc}): the access token refreshed.`);
      if (c.mode !== 'api') writeOut(`  It is not used yet: anywhere config set calls.cliq.mode api`);
    }
    return EXIT.OK;
  }

  // ------------------------------------------------------------ notes

  async function doNotes(p) {
    const f = p.flags;
    const N = require(path.join(__dirname, '..', 'calls', 'notes'));
    const cfg = config();
    const folder = await N.notesFolder(notesOpts(cfg));
    const limit = f.lines != null ? Number(f.lines) : 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw usage('-n must be a whole number from 1 to 200');
    const list = N.listNotes(folder.dir, { limit });
    let fallbackDir = null;
    try {
      fallbackDir = N.fallbackNotesDir();
    } catch {
      fallbackDir = null;
    }
    const fallback = fallbackDir ? N.listNotes(fallbackDir, { limit }) : [];
    let opened = false;
    if (f.open) {
      const target = fs.existsSync(folder.dir) ? folder.dir : fallback.length ? fallbackDir : null;
      if (!target) {
        if (f.json) printJson({ ok: false, dir: folder.dir, notes: [], reason: 'no notes yet' });
        else writeOut(`No call notes yet. They will be written to ${folder.dir}`);
        return EXIT.OK;
      }
      try {
        await openTarget(target, { kind: 'path' });
        opened = true;
      } catch (err) {
        throw cliError(`Could not open ${target}: ${err.message}`);
      }
    }
    const strip = (n) => ({ name: n.name, path: n.path, modified: new Date(n.mtimeMs).toISOString(), size: n.size });
    if (f.json) {
      printJson({ ok: true, dir: folder.dir, source: folder.source, synced: folder.synced, opened, notes: list.map(strip), fallbackDir: fallback.length ? fallbackDir : null, fallbackNotes: fallback.map(strip) });
      return EXIT.OK;
    }
    writeOut(`Call notes   ${folder.dir}${opened ? color.dim('  (opened)') : ''}`);
    if (folder.synced) writeOut(color.dim(`             synced by ${folder.synced === 'onedrive' ? 'OneDrive' : 'iCloud'}; set calls.notesDir to keep them local`));
    if (!list.length && !fallback.length) writeOut('  No call notes yet.');
    for (const n of list) writeOut(`  ${n.name}`);
    if (fallback.length) {
      writeOut(`Also in ${fallbackDir} (the Desktop could not be written):`);
      for (const n of fallback) writeOut(`  ${n.name}`);
    }
    return EXIT.OK;
  }

  async function run(p) {
    const sub = String(p._[0] || 'status').toLowerCase();
    if (!SUBCOMMANDS.includes(sub)) throw usage(`Unknown calls command "${sub}" (use ${SUBCOMMANDS.join(', ')})`);
    if (sub === 'on') return doOn(p);
    if (sub === 'off') return doOff(p);
    if (sub === 'doctor') return doDoctor(p);
    if (sub === 'test-audio') return doTestAudio(p);
    if (sub === 'learn') return doLearn(p);
    if (sub === 'audio') return doAudio(p);
    if (sub === 'cliq') return doCliq(p);
    if (sub === 'notes') return doNotes(p);
    return doStatus(p);
  }

  return {
    calls: {
      run,
      group: 'Setup',
      summary: 'Let the assistant answer your calls (armed by a click; it says it is an AI)',
      usage:
        'anywhere calls [on [--for 2h | --until 18:00] [--apps cliq,meet] [--instructions TEXT] | off | status | doctor [--deep] | test-audio [--no-open] [--no-wait] | learn [--seconds N] [--app APP] | audio setup|teardown|check | cliq setup|test|gui|status | notes [--open] [-n N]] [--json]',
      details: [
        'on asks the dialog to show a card; only a click on "Allow once" arms it. It expires (at most 12 h), respects quiet hours and is forgotten on restart.',
        'off stops answering at once. status shows whether calls are answered, quiet hours, audio, the current and recent calls.',
        'The assistant always says it is an AI assistant and that it takes notes; it can look up and assign Jira tickets to the caller, message them on Cliq after the call, and note everything else for you.',
        'doctor checks the cloned voice, audio routing, detection, Claude, Jira, Cliq and the notes folder; test-audio runs the browser self-test.',
        'learn calibrates a call app from a test call (recommended for Zoho Cliq). cliq setup connects the optional Zoho Cliq API (Self Client grant code).',
        'notes lists the call notes (<Desktop>/Claude Call Notes); --open opens the folder.',
      ],
      spec: spec({
        string: ['for', 'until', 'apps', 'instructions', 'seconds', 'app', 'dc', 'client-id', 'code', 'lines', 'secret', 'client-secret'],
        boolean: ['deep', 'open', 'wait', 'secret-stdin'],
        alias: { n: 'lines' },
      }),
    },
  };
}

module.exports = {
  commands,
  doctorChecks,
  parseDuration,
  minutesUntil,
  parseApps,
  normalizeStatus,
  statusLines,
  reasonLabel,
  appLabel,
  SUBCOMMANDS,
};
