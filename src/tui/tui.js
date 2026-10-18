'use strict';

/**
 * Terminal dialog for Claude Anywhere (`anywhere tui`): the fallback UI for SSH sessions,
 * headless machines and anyone who prefers a terminal. It mirrors the graphical dialog over
 * the same SSE stream: streaming replies, tool rows, approvals, questions, voice input
 * (records with sox/arecord/ffmpeg and transcribes through the daemon), and slash commands.
 *
 * Colours honour NO_COLOR / FORCE_COLOR and switch off when the output is not a TTY.
 * The render helpers are pure and exported for tests.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const childProcess = require('child_process');
const proc = require('../shared/proc');
const { unicodeSupported } = require('../shared/util');

// 'queued': bridge commands wait for a terminal; Esc, Ctrl+C and /stop drop them.
const BUSY_STATUSES = new Set(['starting', 'thinking', 'acting', 'waiting_approval', 'waiting_answer', 'stopping', 'queued']);
const LOUD_STATUSES = new Set(['starting', 'stopping', 'error', 'offline']);
const DOUBLE_CTRL_C_MS = 2000;
const PIPED_CONNECT_WAIT_MS = 10000;
// Piped input ended: leave once the daemon has stayed idle this long with nothing of ours pending.
// The pause covers a status event racing the POST /api/command reply, and the brief idle between
// a turn and the queued follow-ups the daemon sends next.
const PIPED_IDLE_QUIT_MS = 1500;
const IDLE_STATUSES = new Set(['idle', 'error']);
const MAX_RECORD_MS = 120000;
const MIN_AUDIO_BYTES = 44 + 3200; // 0.1 s of 16 kHz mono 16-bit
const SNAPSHOT_HISTORY = 40;
const LOCAL_ECHO_TTL_MS = 60000;
const STT_HINT = 'Server speech-to-text needs GROQ_API_KEY or OPENAI_API_KEY (or voice.sttApiKey), or whisper.cpp; run "anywhere doctor".';

// ---------------------------------------------------------------- theme

/**
 * Whether to emit ANSI colours: NO_COLOR (non-empty) disables, FORCE_COLOR enables,
 * otherwise only on a TTY that is not TERM=dumb.
 */
function colorEnabled(output, env = process.env) {
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false') return true;
  if (!output || !output.isTTY) return false;
  return env.TERM !== 'dumb';
}

// unicodeSupported(env, platform) lives in src/shared/util.js: the CLI uses the same rule.

/** @param {boolean} enabled */
function createPalette(enabled) {
  const wrap = (open, close) => (enabled ? (s) => `\x1b[${open}m${s}\x1b[${close}m` : (s) => String(s));
  return {
    enabled: Boolean(enabled),
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    italic: wrap(3, 23),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
    gray: wrap(90, 39),
    orange: wrap('38;5;173', 39),
  };
}

/** @param {boolean} unicode */
function createSymbols(unicode) {
  return unicode
    ? { tool: '⚙', ok: '✓', fail: '✗', ellipsis: '…', warn: '⚠', info: 'ℹ', ask: '?', arrow: '›', rec: '●', bell: '•', dot: '·', dash: '—', stop: '■' }
    : { tool: '*', ok: 'ok', fail: 'x', ellipsis: '...', warn: '!', info: 'i', ask: '?', arrow: '>', rec: '(rec)', bell: '*', dot: '-', dash: '-', stop: '#' };
}

/**
 * @param {{output?:object, env?:object, platform?:string, color?:boolean, unicode?:boolean}} [o]
 * @returns {{c:ReturnType<typeof createPalette>, s:ReturnType<typeof createSymbols>}}
 */
function createTheme({ output, env = process.env, platform = process.platform, color, unicode } = {}) {
  return {
    c: createPalette(color != null ? color : colorEnabled(output, env)),
    s: createSymbols(unicode != null ? unicode : unicodeSupported(env, platform)),
  };
}

const PLAIN_THEME = createTheme({ color: false, unicode: true });

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

// ---------------------------------------------------------------- formatting

/** @param {number} usd */
function formatCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** @param {number} ms */
function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)} s`;
  const m = Math.floor(n / 60000);
  const sec = Math.round((n % 60000) / 1000);
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

/** Shorten to n characters with the theme's ellipsis ("..." in ASCII mode). */
function clip(str, n, s = PLAIN_THEME.s) {
  if (str == null) return '';
  const text = String(str);
  if (text.length <= n) return text;
  const ell = s.ellipsis;
  return n <= ell.length ? text.slice(0, n) : `${text.slice(0, n - ell.length)}${ell}`;
}

function firstLine(text, n = 160, s = PLAIN_THEME.s) {
  const line = String(text == null ? '' : text).split(/\r?\n/).find((l) => l.trim()) || '';
  return clip(line.trim(), n, s);
}

function optionLabel(o) {
  if (o == null) return '';
  if (typeof o === 'string') return o;
  if (typeof o === 'number' || typeof o === 'boolean') return String(o);
  return String(o.label || o.text || o.value || o.title || JSON.stringify(o));
}

// ---------------------------------------------------------------- render helpers (pure)

function renderUserMessage(item, t = PLAIN_THEME) {
  const { c } = t;
  // switch_project: the task Claude handed to the new session in another folder (often long).
  if (item && item.source === 'handoff') {
    const lines = String(item.text || '')
      .split(/\r?\n/)
      .filter((l) => l.trim());
    const more = lines.length > 1 ? c.dim(` (+${lines.length - 1} more line${lines.length === 2 ? '' : 's'})`) : '';
    return `${c.bold(c.orange('Claude'))}${c.dim(' (handed over)')}: ${lines[0] || ''}${more}`;
  }
  const src = item && item.source && item.source !== 'text' ? c.dim(` (${item.source})`) : '';
  const n = Number(item && item.images) || 0;
  const imgs = n > 0 ? c.dim(` [+${n} image${n === 1 ? '' : 's'}]`) : '';
  return `${c.bold(c.cyan('You'))}${src}: ${(item && item.text) || ''}${imgs}`;
}

function renderAssistantPrefix(t = PLAIN_THEME) {
  return `${t.c.bold(t.c.orange('Claude'))}: `;
}

function renderAssistantMessage(item, t = PLAIN_THEME) {
  return `${renderAssistantPrefix(t)}${(item && item.text) || ''}`;
}

function toolName(item) {
  return String((item && (item.displayName || item.name)) || 'Tool');
}

/** "⚙ Click (512,300) …" */
function renderToolHead(item, t = PLAIN_THEME) {
  const { c, s } = t;
  const summary = item && item.summary ? ` ${clip(String(item.summary).replace(/\s+/g, ' '), 100, s)}` : '';
  return `${c.gray(s.tool)} ${c.bold(toolName(item))}${summary} ${c.gray(s.ellipsis)}`;
}

/** "✓" or "✗ <first line of the error>" */
function renderToolMark(status, output, t = PLAIN_THEME) {
  const { c, s } = t;
  if (status === 'ok') return c.green(s.ok);
  if (status === 'error') {
    const why = firstLine(typeof output === 'string' ? output : output == null ? '' : JSON.stringify(output), 120, s);
    return c.red(why ? `${s.fail} ${why}` : s.fail);
  }
  return '';
}

/** "⚙ Click (512,300) … ✓" (the mark is omitted while running) */
function renderToolRow(item, t = PLAIN_THEME) {
  const head = renderToolHead(item, t);
  const mark = item && item.status && item.status !== 'running' ? renderToolMark(item.status, item.output, t) : '';
  return mark ? `${head} ${mark}` : head;
}

function renderSystem(item, t = PLAIN_THEME) {
  const { c, s } = t;
  const level = (item && item.level) || 'info';
  const text = (item && item.text) || '';
  if (level === 'error') return c.red(`${s.fail} ${text}`);
  if (level === 'warning') return c.yellow(`${s.warn} ${text}`);
  if (level === 'success') return c.green(`${s.ok} ${text}`);
  return c.dim(`${s.info} ${text}`);
}

function renderNotify(data, t = PLAIN_THEME) {
  const { c, s } = t;
  const text = (data && data.text) || '';
  const level = (data && data.level) || 'info';
  const color = level === 'error' ? c.red : level === 'warning' ? c.yellow : level === 'success' ? c.green : c.magenta;
  return `${color(s.bell)} ${color(text)}`;
}

/** "✓ Done · $0.0123 (session $0.0500) · 12.3 s · 3 turns" */
function renderResult(data, t = PLAIN_THEME) {
  const { c, s } = t;
  const d = data || {};
  const parts = [];
  const cost = Number(d.costUsd) || 0;
  const total = Number(d.totalCostUsd) || 0;
  if (cost > 0 || total > 0) {
    parts.push(total > cost + 1e-9 ? `${formatCost(cost)} (session ${formatCost(total)})` : formatCost(cost || total));
  }
  if (Number(d.durationMs) > 0) parts.push(formatDuration(d.durationMs));
  const turns = Number(d.numTurns) || 0;
  if (turns > 0) parts.push(`${turns} turn${turns === 1 ? '' : 's'}`);
  const meta = parts.length ? c.dim(` ${s.dot} ${parts.join(` ${s.dot} `)}`) : '';
  if (d.interrupted) return `${c.yellow('Stopped')}${meta}`;
  if (d.isError) {
    const why = d.text ? `: ${firstLine(d.text, 300, s)}` : '';
    return `${c.red(`${s.fail} Failed${why}`)}${meta}`;
  }
  return `${c.green(`${s.ok} Done`)}${meta}`;
}

function statusColor(status, t) {
  const { c } = t;
  if (status === 'error' || status === 'offline') return c.red;
  if (status === 'idle') return c.green;
  if (status === 'waiting_approval' || status === 'waiting_answer' || status === 'queued') return c.yellow;
  return c.cyan;
}

function renderStatusLine(status, detail, t = PLAIN_THEME) {
  const { c, s } = t;
  const label = String(status || 'unknown').replace(/_/g, ' ');
  return `${c.dim(s.dot)} ${statusColor(status, t)(label)}${detail ? c.dim(` ${s.dash} ${detail}`) : ''}`;
}

/** A critical card is allowed only by typing the whole word "allow" (see criticalRefusal). */
function isCriticalApproval(req) {
  return String((req && req.risk) || '').toLowerCase() === 'critical';
}

/**
 * Approval card. With `withHint` the "[y]es / [a]lways / [n]o" line is included (non-TTY;
 * in a TTY the readline prompt shows it). A critical card always says how to allow it.
 */
function renderApproval(req, t = PLAIN_THEME, { withHint = true } = {}) {
  const { c, s } = t;
  const r = req || {};
  const risk = String(r.risk || 'medium').toLowerCase();
  const riskColor = risk === 'low' ? c.green : risk === 'medium' ? c.yellow : (x) => c.bold(c.red(x));
  const name = r.displayName || r.toolName || 'Tool';
  const lines = [`${c.yellow(`${s.warn} Approval needed`)} ${c.dim(s.dot)} ${riskColor(`${risk.toUpperCase()} risk`)} ${c.dim(s.dot)} ${c.bold(name)}`];
  let summary = r.summary;
  if (!summary && r.input != null) {
    try {
      summary = typeof r.input === 'string' ? r.input : JSON.stringify(r.input);
    } catch {
      summary = '';
    }
  }
  if (summary) {
    for (const l of clip(String(summary), 600, s).split(/\r?\n/).slice(0, 8)) lines.push(`  ${l}`);
  }
  if (r.reason) lines.push(c.dim(`  Why: ${r.reason}`));
  if (risk === 'critical') lines.push(`  ${c.yellow('Critical action: type allow (the whole word) to allow it once; y and voice are not enough. n denies.')}`);
  else {
    // "always" adds the card's session rule: say what it covers, or that there is none (null).
    if (typeof r.sessionRule === 'string' && r.sessionRule) lines.push(c.dim(`  Always (session) allows ${r.sessionRule}`));
    else if (r.sessionRule === null) lines.push(c.dim('  This action always asks: no session rule covers it.'));
    if (withHint) lines.push(`  ${c.yellow(r.sessionRule === null ? '[y]es / [n]o' : '[y]es / [a]lways / [n]o')}`);
  }
  return lines.join('\n');
}

function renderQuestion(q, t = PLAIN_THEME) {
  const { c, s } = t;
  const d = q || {};
  const lines = [`${c.cyan(c.bold(`${s.ask} Claude asks:`))} ${d.question || ''}`];
  const opts = Array.isArray(d.options) ? d.options : [];
  opts.forEach((o, i) => lines.push(`  ${c.bold(`${i + 1})`)} ${optionLabel(o)}`));
  lines.push(c.dim(opts.length ? '  Type a number or your own answer.' : '  Type your answer.'));
  return lines.join('\n');
}

function renderHeader(snap, t = PLAIN_THEME) {
  const { c, s } = t;
  const d = snap || {};
  const project = d.project || {};
  const where = project.name ? `${c.bold(project.name)}${project.dir ? c.dim(` (${project.dir})`) : ''}` : c.dim('no project');
  return [
    `${c.bold(c.orange('Claude Anywhere'))}${d.version ? c.dim(` v${d.version}`) : ''} ${c.dim(`${s.dot} terminal dialog`)}`,
    `Project: ${where} ${c.dim(s.dot)} Mode: ${c.bold(d.mode || 'companion')} ${c.dim(s.dot)} Status: ${statusColor(d.status, t)(String(d.status || 'unknown').replace(/_/g, ' '))}`,
    c.dim(`Type a request and press Enter ${s.dot} /voice to talk ${s.dot} /help for commands ${s.dot} Ctrl+C to stop`),
  ].join('\n');
}

function renderStatusSummary(snap, t = PLAIN_THEME) {
  const { c, s } = t;
  const sep = ` ${s.dot} `;
  const d = snap || {};
  const row = (k, v) => `${c.dim(`${k}:`.padEnd(10))}${v}`;
  const lines = [];
  lines.push(row('Status', `${statusColor(d.status, t)(String(d.status || 'unknown').replace(/_/g, ' '))}${d.statusDetail ? c.dim(` ${s.dash} ${d.statusDetail}`) : ''}`));
  lines.push(row('Mode', d.mode || 'companion'));
  const p = d.project || {};
  if (p.dir || p.name) {
    const git = p.git && p.git.branch ? c.dim(` [${p.git.branch}${p.git.dirty ? ', uncommitted changes' : ''}]`) : '';
    lines.push(row('Project', `${p.name || path.basename(p.dir || '')}${p.dir ? c.dim(` (${p.dir})`) : ''}${git}`));
  }
  const ses = d.session || {};
  const sesParts = [];
  if (ses.id) sesParts.push(String(ses.id).slice(0, 8));
  if (ses.model) sesParts.push(ses.model);
  if (ses.costUsd != null) sesParts.push(formatCost(ses.costUsd));
  if (ses.turns != null) sesParts.push(`${ses.turns} turn${Number(ses.turns) === 1 ? '' : 's'}`);
  lines.push(row('Session', sesParts.length ? sesParts.join(sep) : c.dim('not started')));
  const v = d.voice || {};
  const voiceParts = [];
  voiceParts.push(v.serverStt ? `speech-to-text: ${v.sttProvider || 'server'}` : c.dim('speech-to-text: not configured'));
  voiceParts.push(v.serverTts ? `text-to-speech: ${v.ttsProvider || 'server'}` : c.dim('text-to-speech: off'));
  lines.push(row('Voice', voiceParts.join(sep)));
  if ((d.mode || '') === 'bridge') lines.push(row('Bridge', d.bridge && d.bridge.listening ? c.green('terminal session listening') : c.yellow('no terminal session listening (run /anywhere here)')));
  const pf = d.platform || {};
  if (pf.platform) lines.push(row('Platform', [pf.platform, pf.displayServer, pf.driver].filter(Boolean).join(sep)));
  const pend = d.pending || {};
  const na = Array.isArray(pend.approvals) ? pend.approvals.length : 0;
  const nq = Array.isArray(pend.questions) ? pend.questions.length : 0;
  if (na || nq) lines.push(row('Pending', `${na} approval${na === 1 ? '' : 's'}, ${nq} question${nq === 1 ? '' : 's'}`));
  return lines.join('\n');
}

function renderHelp(t = PLAIN_THEME) {
  const { c } = t;
  const cmds = [
    ['/stop', 'interrupt Claude (also Ctrl+C)'],
    ['/new', 'start a new session'],
    ['/mode companion|bridge', 'switch mode (add --switch to stop a running task)'],
    ['/project <dir>', 'switch the project directory (add --switch to stop a running task)'],
    ['/screen', 'attach a screenshot to the next message (toggle)'],
    ['/voice', 'record a voice message; press Enter to stop'],
    ['/status', 'show what Claude Anywhere is doing'],
    ['/show', 'open the graphical dialog window'],
    ['/clear', 'clear the screen'],
    ['/help', 'this help'],
    ['/quit', 'leave the terminal dialog (Claude Anywhere keeps running)'],
  ];
  return [
    ...cmds.map(([k, v]) => `  ${c.bold(k.padEnd(24))}${c.dim(v)}`),
    c.dim('  Start a message with // to send text that begins with "/".'),
  ].join('\n');
}

// ---------------------------------------------------------------- input parsing (pure)

const ALLOW_WORDS = new Set(['y', 'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'allow', 'allow once', 'approve', 'approved', 'sure', 'go', 'go ahead', 'do it', 'proceed', 'continue']);
const ALWAYS_WORDS = new Set(['a', 'always', 'always allow', 'allow always', 'allow all', 'yes always', 'allow for this session', 'allow for session', 'allow session', 'always for this session']);
const DENY_WORDS = ['n', 'no', 'nope', 'deny', 'denied', 'reject', 'refuse', 'cancel', 'stop', "don't", 'dont', 'do not'];

function normalizeAnswer(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[“”"]/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(?:,\s*)?(?:please|thanks|thank you)$/, '')
    .trim();
}

/**
 * Parse an answer to an approval prompt.
 * "y" → allow, "a" → allow_session, "n" → deny; "n <reason>" / "no, <reason>" denies with a
 * message for Claude. Spoken variants ("Yes.", "allow it please") work too.
 * @param {string} input
 * @returns {{decision:'allow'|'allow_session'|'deny', message?:string}|null}
 */
function parseApprovalAnswer(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const norm = normalizeAnswer(raw);
  if (!norm) return null;
  if (ALWAYS_WORDS.has(norm)) return { decision: 'allow_session' };
  if (ALLOW_WORDS.has(norm) || norm === 'allow it' || norm === 'yes allow') return { decision: 'allow' };
  for (const w of DENY_WORDS) {
    if (norm === w) return { decision: 'deny' };
  }
  const m = /^(n|no|nope|deny|reject|don't|dont)(?:\s*[,:;.\-—]\s*|\s+)([\s\S]+)$/i.exec(raw);
  if (m && m[2].trim()) return { decision: 'deny', message: m[2].trim() };
  return null;
}

/**
 * The TUI's rule for critical cards, matching the dialog's "critical actions need a click":
 * only the typed word "allow" (or "allow once") allows one. "y", "ok", "always" and anything
 * spoken are refused; a deny always goes through.
 * @param {{decision:string}} ans parsed answer
 * @param {string} input what was typed or transcribed
 * @param {'typed'|'voice'} via
 * @returns {string|null} why the answer is refused, or null to send it
 */
function criticalRefusal(ans, input, via) {
  if (!ans || ans.decision === 'deny') return null;
  if (via === 'voice') return 'Critical actions are not allowed by voice: type allow to allow it once, or n to deny.';
  if (ans.decision === 'allow_session') return 'Critical actions always ask: they cannot be allowed for the whole session. Type allow to allow it once, or n to deny.';
  const norm = normalizeAnswer(input);
  if (norm === 'allow' || norm === 'allow once') return null;
  return 'This is a critical action: type allow (the whole word) to allow it once, or n to deny.';
}

/**
 * Parse an answer to a question: a number picks that option, anything else is free text.
 * @param {string} input
 * @param {Array<string|object>} [options]
 * @returns {string|null}
 */
function parseQuestionAnswer(input, options = []) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const opts = Array.isArray(options) ? options : [];
  if (/^\d{1,3}$/.test(raw) && opts.length) {
    const n = Number(raw);
    if (n >= 1 && n <= opts.length) return optionLabel(opts[n - 1]);
  }
  return raw;
}

/**
 * Parse "/name args". Paths such as "/usr/bin/x" are not commands; "//text" escapes.
 * @param {string} line
 * @returns {{name:string,arg:string}|null}
 */
/**
 * A trailing --switch (or !) on /mode and /project arguments: stop a running task to switch.
 * @param {string} arg
 * @returns {{rest:string, force:boolean}}
 */
function splitSwitchFlag(arg) {
  let rest = String(arg || '').trim();
  let force = false;
  const m = rest.match(/(?:^|\s)(--switch|--force|!)$/);
  if (m) {
    force = true;
    rest = rest.slice(0, rest.length - m[0].length).trim();
  }
  return { rest, force };
}

function parseSlash(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('/') || s.startsWith('//')) return null;
  const m = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(s);
  if (!m) return null;
  return { name: m[1].toLowerCase(), arg: (m[2] || '').trim() };
}

function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

// ---------------------------------------------------------------- audio (pure + helpers)

/**
 * Pick the first available recorder for 16 kHz mono 16-bit WAV.
 * Order: sox `rec`, arecord (Linux), ffmpeg (avfoundation / dshow / pulse|alsa); on Windows
 * ffmpeg first because console programs there cannot be stopped with SIGINT.
 * @returns {{name:string,cmd:string,buildArgs:(file:string,device?:string)=>string[],stop:'signal'|'q',needsDevice:boolean}|null}
 */
function pickRecorder({ platform = process.platform, which = proc.which, env = process.env, exists = fs.existsSync } = {}) {
  const rec = platform !== 'win32' ? which('rec') : null;
  const sox = which('sox');
  const arecord = platform === 'linux' ? which('arecord') : null;
  const ffmpeg = which('ffmpeg');
  const ffCommon = ['-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-y'];
  const fromRec = rec
    ? { name: 'sox (rec)', cmd: rec, buildArgs: (file) => ['-q', '-c', '1', '-r', '16000', '-b', '16', file], stop: 'signal', needsDevice: false }
    : null;
  const fromSox = sox
    ? { name: 'sox', cmd: sox, buildArgs: (file) => ['-q', '-d', '-c', '1', '-r', '16000', '-b', '16', file], stop: 'signal', needsDevice: false }
    : null;
  const fromArecord = arecord
    ? { name: 'arecord', cmd: arecord, buildArgs: (file) => ['-q', '-t', 'wav', '-f', 'S16_LE', '-c1', '-r16000', file], stop: 'signal', needsDevice: false }
    : null;
  let fromFfmpeg = null;
  if (ffmpeg) {
    let input;
    let needsDevice = false;
    if (platform === 'darwin') input = () => ['-f', 'avfoundation', '-i', ':0'];
    else if (platform === 'win32') {
      needsDevice = true;
      input = (device) => ['-f', 'dshow', '-i', `audio=${device}`];
    } else {
      const runtime = env.XDG_RUNTIME_DIR;
      const pulse = Boolean(env.PULSE_SERVER || which('pactl') || which('pipewire-pulse') || (runtime && exists(path.join(runtime, 'pulse', 'native'))));
      input = () => (pulse ? ['-f', 'pulse', '-i', 'default'] : ['-f', 'alsa', '-i', 'default']);
    }
    fromFfmpeg = {
      name: 'ffmpeg',
      cmd: ffmpeg,
      buildArgs: (file, device) => ['-hide_banner', '-loglevel', 'error', ...input(device), ...ffCommon, file],
      stop: 'q',
      needsDevice,
    };
  }
  const order = platform === 'win32' ? [fromFfmpeg, fromSox] : platform === 'darwin' ? [fromRec, fromFfmpeg, fromSox] : [fromRec, fromArecord, fromFfmpeg, fromSox];
  return order.find(Boolean) || null;
}

function recorderInstallHint(platform = process.platform) {
  if (platform === 'darwin') return 'Install one with: brew install sox (or brew install ffmpeg).';
  if (platform === 'win32') return 'Install one with: winget install Gyan.FFmpeg (or install SoX).';
  return 'Install one with: sudo apt install sox (or alsa-utils / ffmpeg; dnf and pacman have the same packages).';
}

/** For a recorder that started and then failed: there is no usable input device. */
function noInputDeviceHint(platform = process.platform) {
  if (platform === 'darwin') return 'No working microphone was found, or this terminal may not use it: check System Settings > Privacy & Security > Microphone, and Sound > Input.';
  if (platform === 'win32') return 'No working microphone was found: check Windows Settings > Privacy > Microphone, and Sound > Input.';
  return 'No working microphone or input device was found. Check the system sound settings; over SSH there is usually no audio device (set PULSE_SERVER, or use the dialog in a browser).';
}

/**
 * Audio device names from `ffmpeg -list_devices true -f dshow -i dummy` (stderr). Handles the
 * old "DirectShow audio devices" sections and the newer `"name" (audio)` lines.
 * @param {string} text
 * @returns {string[]}
 */
function parseDshowAudioDevices(text) {
  const out = [];
  let section = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/^\[[^\]]*\]\s*/, '');
    if (/DirectShow audio devices/i.test(line)) {
      section = 'audio';
      continue;
    }
    if (/DirectShow video devices/i.test(line)) {
      section = 'video';
      continue;
    }
    if (/Alternative name/i.test(line)) continue;
    const typed = /^"(.+)"\s*\((audio|video|none)(?:,\s*(audio|video))?\)\s*$/.exec(line.trim());
    if (typed) {
      if (typed[2] === 'audio' || typed[3] === 'audio') out.push(typed[1]);
      continue;
    }
    const plain = /^"(.+)"\s*$/.exec(line.trim());
    if (plain && section === 'audio') out.push(plain[1]);
  }
  return [...new Set(out)];
}

/**
 * Repair the RIFF and data chunk sizes of a WAV whose recorder was stopped abruptly
 * (sizes left as 0 or 0xFFFFFFFF, or larger than the file). Mutates and returns `buf`.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function fixWavHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return buf;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
  const bad = (size, max) => size === 0 || size >= 0x7fffffff || size > max;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const actual = buf.length - (off + 8);
      if (bad(size, actual)) buf.writeUInt32LE(actual >>> 0, off + 4);
      break;
    }
    if (size > buf.length - off - 8) break;
    off += 8 + size + (size % 2);
  }
  const riff = buf.length - 8;
  if (bad(buf.readUInt32LE(4), riff)) buf.writeUInt32LE(riff >>> 0, 4);
  return buf;
}

// ---------------------------------------------------------------- the TUI

class Tui {
  /**
   * @param {object} o
   * @param {object} o.client DaemonClient (request, postBinary, subscribe)
   * @param {NodeJS.ReadableStream} [o.input]
   * @param {NodeJS.WritableStream} [o.output]
   * Test seams: env, platform, which, spawn, run, tmpdir, cwd, homedir, exists, color, unicode,
   * idleQuitMs.
   */
  constructor({ client, input = process.stdin, output = process.stdout, env = process.env, ...deps }) {
    this.client = client;
    this.input = input;
    this.output = output;
    this.env = env;
    this.platform = deps.platform || process.platform;
    this.which = deps.which || proc.which;
    this.spawn = deps.spawn || childProcess.spawn;
    this.runCmd = deps.run || proc.run;
    this.exists = deps.exists || fs.existsSync;
    this.tmpdir = deps.tmpdir || os.tmpdir();
    this.cwd = deps.cwd || process.cwd();
    this.homedir = deps.homedir || os.homedir();
    this.isTTY = Boolean(input && input.isTTY && output && output.isTTY);
    this.theme = createTheme({ output, env, platform: this.platform, color: deps.color, unicode: deps.unicode });

    this.state = { status: 'offline', statusDetail: '', mode: null, project: null, session: null, config: null, version: null };
    this.seen = new Set();
    this.tools = new Map();
    this.streamText = new Map();
    this.prompts = [];
    this.localEcho = [];
    this.col0 = true;
    this.openKind = null;
    this.openId = null;
    this.lastLineKey = null;
    this.promptVisible = false;
    this.attachNext = false;
    this.attachDefault = false; // config.context.attachScreenshotByDefault, from the snapshot
    this.recording = null;
    // Commands sent and not yet answered by a result. Only a hint (busy prompt, Ctrl+C): the
    // daemon folds follow-ups queued during a turn into one turn (one result), and commands
    // dropped by Stop or a failed engine start get none.
    this.inFlight = 0;
    this.postsPending = 0; // POST /api/command requests not yet answered
    this.idleQuitMs = deps.idleQuitMs != null ? deps.idleQuitMs : PIPED_IDLE_QUIT_MS;
    this._idleTimer = null;
    this.everConnected = false;
    this.disconnectedNotice = false;
    this.lastCtrlC = 0;
    this.closed = false;
    this.quitWhenIdle = false;
    this.rl = null;
    this.sub = null;
    this._done = null;
    this._sigint = null;
    // Piped (non-TTY) input is handled one line at a time, once connected, so
    // `printf '/status\n/quit\n' | anywhere tui` prints the status before quitting.
    this.inputChain = Promise.resolve();
    this._connected = new Promise((resolve) => {
      this._markConnected = resolve;
    });
  }

  /** Start reading input and events; resolves when the user quits. */
  run() {
    return new Promise((resolve) => {
      this._done = resolve;
      this.rl = readline.createInterface({ input: this.input, output: this.output, terminal: this.isTTY, historySize: 200, prompt: '' });
      this.rl.on('line', (line) => this._onLine(line));
      this.rl.on('close', () => this._onInputClosed());
      if (this.isTTY) {
        this.rl.on('SIGINT', () => this._onCtrlC());
      } else if (this.input === process.stdin) {
        this._sigint = () => this._onCtrlC();
        process.on('SIGINT', this._sigint);
      }
      if (this.isTTY) this.line(this.theme.c.dim(`Connecting to Claude Anywhere${this.theme.s.ellipsis}`));
      // A terminal dialog: it shows notifications and approval cards (the daemon counts it).
      this.sub = this.client.subscribe((type, data) => this.handleEvent(type, data), { kind: 'tui' });
    });
  }

  // ----- output primitives

  _write(s) {
    try {
      this.output.write(s);
    } catch {
      /* closed output */
    }
  }

  _clearPrompt() {
    if (this.isTTY && this.promptVisible) {
      readline.cursorTo(this.output, 0);
      readline.clearLine(this.output, 0);
      this.promptVisible = false;
    }
  }

  _closeOpen() {
    if (!this.col0) {
      this._write('\n');
      this.col0 = true;
    }
    this.openKind = null;
    this.openId = null;
  }

  /** Print a complete line (or block) above the prompt. */
  line(text, key = null) {
    if (this.closed) return;
    this._clearPrompt();
    this._closeOpen();
    this._write(`${text}\n`);
    this.col0 = true;
    this.lastLineKey = key;
    this._showPrompt();
  }

  _promptText() {
    const { c, s } = this.theme;
    if (this.recording) return `${c.red(s.rec)} recording${s.ellipsis} press Enter to stop `;
    const head = this.prompts[0];
    if (head && head.kind === 'approval') {
      const hint = isCriticalApproval(head.data) ? 'critical: type allow / [n]o' : head.data && head.data.sessionRule === null ? '[y]es / [n]o' : '[y]es / [a]lways / [n]o';
      return `${c.yellow(hint)} ${s.arrow} `;
    }
    if (head && head.kind === 'question') return `${c.cyan('answer')} ${s.arrow} `;
    const busy = BUSY_STATUSES.has(this.state.status) ? c.dim(`(${String(this.state.status).replace(/_/g, ' ')}) `) : '';
    const screen = this.attachNext ? c.magenta('[+screen] ') : '';
    return `${screen}${busy}${c.bold(s.arrow)} `;
  }

  _showPrompt() {
    if (this.closed || !this.rl || !this.isTTY || this.openKind || !this.col0) return;
    this.rl.setPrompt(this._promptText());
    this.rl.prompt(true);
    this.promptVisible = true;
  }

  _refreshPrompt() {
    if (!this.isTTY || !this.promptVisible) return;
    this._clearPrompt();
    this._showPrompt();
  }

  _fitsOneRow(text) {
    const cols = Number(this.output.columns) || 80;
    const typed = this.rl && typeof this.rl.line === 'string' ? this.rl.line.length : 0;
    return stripAnsi(text).length < cols && stripAnsi(this._promptText()).length + typed < cols;
  }

  // ----- events

  /** Handle one SSE event (exposed for tests). */
  handleEvent(type, data) {
    if (this.closed) return;
    try {
      this._dispatch(type, data || {});
    } catch (err) {
      this.line(this.theme.c.red(`${this.theme.s.fail} display error: ${err.message}`));
    }
  }

  _dispatch(type, data) {
    const { c, s } = this.theme;
    switch (type) {
      case 'snapshot':
        this._onSnapshot(data);
        break;
      case 'status': {
        const prev = this.state.status;
        this.state.status = data.status || prev;
        this.state.statusDetail = data.detail || '';
        if (this.state.status !== prev && LOUD_STATUSES.has(this.state.status)) {
          this.line(renderStatusLine(this.state.status, data.detail, this.theme));
        } else {
          this._refreshPrompt();
        }
        this._checkIdleQuit();
        break;
      }
      case 'message':
        this._onMessage(data);
        break;
      case 'delta':
        this._appendStream(data.id, typeof data.text === 'string' ? data.text : '');
        break;
      case 'tool_update':
        this._onToolUpdate(data);
        break;
      case 'approval_request':
        this._addPrompt('approval', data);
        break;
      case 'approval_resolved':
        this._removePrompt(data.id, data.decision ? c.dim(`(approval answered: ${String(data.decision).replace('_', ' ')})`) : null);
        this._checkIdleQuit();
        break;
      case 'question':
        this._addPrompt('question', data);
        break;
      case 'question_resolved':
        this._removePrompt(data.id, data.answer != null ? c.dim(`(answered: ${clip(String(data.answer), 120, s)})`) : null);
        this._checkIdleQuit();
        break;
      case 'notify':
        if (data.text) this.line(renderNotify(data, this.theme));
        break;
      case 'result':
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.line(renderResult(data, this.theme));
        this._checkIdleQuit();
        break;
      case 'project': {
        const prevDir = this.state.project && this.state.project.dir;
        this.state.project = data;
        if (this.everConnected && data.dir && data.dir !== prevDir) {
          this.line(`${c.dim('Project:')} ${c.bold(data.name || path.basename(data.dir))} ${c.dim(`(${data.dir})`)}`);
        }
        break;
      }
      case 'session': {
        const prevId = this.state.session && this.state.session.id;
        this.state.session = { ...(this.state.session || {}), ...data };
        if (this.everConnected && prevId && data.id && data.id !== prevId) {
          this.line(c.dim(`Session ${String(data.id).slice(0, 8)}${data.model ? ` ${s.dot} ${data.model}` : ''}`));
        }
        break;
      }
      case 'mode':
        if (data.mode && data.mode !== this.state.mode) {
          this.state.mode = data.mode;
          this.line(`${c.dim('Mode:')} ${c.bold(data.mode)}`);
        }
        break;
      case 'bridge':
        if (this.state.mode === 'bridge') {
          this.line(c.dim(data.listening ? 'The terminal Claude Code session is listening.' : 'No terminal Claude Code session is listening (run /anywhere here).'));
        }
        break;
      case 'config':
        this.state.config = data;
        this._seedAttach(data);
        break;
      case 'error':
        this.line(c.red(`${s.fail} ${data.message || 'error'}`));
        break;
      case '_disconnected':
        this.state.status = 'offline';
        this._checkIdleQuit();
        if (!this.disconnectedNotice) {
          this.disconnectedNotice = true;
          this.line(c.yellow(`${s.warn} Lost connection to Claude Anywhere; reconnecting${s.ellipsis} (/quit to leave)`));
        }
        break;
      case '_daemon_replaced': {
        // The client followed daemon.json to a new daemon (a restart); its snapshot comes next and
        // fills everything in again. Cards and streams of the old daemon can no longer be answered.
        this.disconnectedNotice = false;
        this.prompts = [];
        this.streamText.clear();
        this.tools.clear();
        this.openKind = null;
        this.openId = null;
        this.inFlight = this.postsPending;
        this.state.status = 'idle';
        this.state.statusDetail = '';
        const where = [data.pid ? `pid ${data.pid}` : '', data.port ? `port ${data.port}` : ''].filter(Boolean).join(', ');
        this.line(c.green(`${s.ok} Claude Anywhere restarted${where ? ` (${where})` : ''}; reconnected.`));
        this._checkIdleQuit();
        break;
      }
      default:
        // screenshot, show and future events need no terminal output.
        break;
    }
  }

  _onSnapshot(snap) {
    const { c, s } = this.theme;
    const first = !this.everConnected;
    this.everConnected = true;
    if (this.disconnectedNotice) {
      this.disconnectedNotice = false;
      this.line(c.green(`${this.theme.s.ok} Reconnected.`));
    }
    this.state.version = snap.version || this.state.version;
    this.state.mode = snap.mode || this.state.mode;
    this.state.status = snap.status || this.state.status;
    this.state.statusDetail = snap.statusDetail || '';
    // A result missed while disconnected is never replayed: an idle daemon has nothing of ours
    // running except commands whose POST is still out.
    if (!BUSY_STATUSES.has(this.state.status)) this.inFlight = this.postsPending;
    if (snap.project) this.state.project = snap.project;
    if (snap.session) this.state.session = snap.session;
    if (snap.config) {
      this.state.config = snap.config;
      this._seedAttach(snap.config);
    }
    if (first) this.line(renderHeader(snap, this.theme));
    if (first) this._markConnected();

    const msgs = Array.isArray(snap.messages) ? snap.messages.filter((m) => m && m.id) : [];
    const unseen = msgs.filter((m) => !this.seen.has(m.id));
    const shown = first ? unseen.slice(-SNAPSHOT_HISTORY) : unseen;
    if (first && unseen.length > shown.length) this.line(c.dim(`${s.ellipsis} ${unseen.length - shown.length} earlier messages not shown`));
    for (const m of unseen) {
      if (shown.includes(m)) continue;
      this.seen.add(m.id);
      if (m.role === 'tool' && m.toolUseId) this.tools.set(m.toolUseId, { ...m, done: m.status !== 'running' });
    }
    shown.forEach((m, i) => {
      const last = i === shown.length - 1;
      if (m.role === 'assistant' && m.streaming && !last) {
        this.seen.add(m.id);
        if (m.text) this.line(renderAssistantMessage(m, this.theme));
        return;
      }
      this._onMessage(m, { fromSnapshot: true });
    });

    const pend = snap.pending || {};
    const approvals = Array.isArray(pend.approvals) ? pend.approvals : [];
    const questions = Array.isArray(pend.questions) ? pend.questions : [];
    const live = new Set([...approvals, ...questions].map((p) => p && p.id).filter(Boolean));
    const headBefore = this.prompts[0] && this.prompts[0].id;
    this.prompts = this.prompts.filter((p) => live.has(p.id));
    const items = [...approvals.map((d) => ({ kind: 'approval', d })), ...questions.map((d) => ({ kind: 'question', d }))]
      .filter((x) => x.d && x.d.id && !this.prompts.some((p) => p.id === x.d.id))
      .sort((a, b) => String(a.d.ts || '').localeCompare(String(b.d.ts || '')));
    for (const x of items) this.prompts.push({ kind: x.kind, id: x.d.id, data: x.d });
    const head = this.prompts[0];
    if (head && head.id !== headBefore) this._renderPromptCard(head);
    else this._refreshPrompt();
    this._showPrompt();
    this._checkIdleQuit();
  }

  _consumeEcho(text) {
    const now = Date.now();
    this.localEcho = this.localEcho.filter((e) => now - e.at < LOCAL_ECHO_TTL_MS);
    const idx = this.localEcho.findIndex((e) => e.text === String(text || '').trim());
    if (idx < 0) return false;
    this.localEcho.splice(idx, 1);
    return true;
  }

  _onMessage(item, { fromSnapshot = false } = {}) {
    if (!item || !item.id) return;
    if (item.role === 'tool') {
      this._onToolMessage(item);
      return;
    }
    if (item.role === 'assistant') {
      this._onAssistantMessage(item);
      return;
    }
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    if (item.role === 'user') {
      if (!fromSnapshot && this._consumeEcho(item.text)) return;
      this.line(renderUserMessage(item, this.theme));
    } else if (item.role === 'system') {
      this.line(renderSystem(item, this.theme));
    }
  }

  _onAssistantMessage(item) {
    const known = this.seen.has(item.id);
    this.seen.add(item.id);
    if (item.streaming) {
      if (known) return;
      this.streamText.set(item.id, '');
      if (item.text) this._appendStream(item.id, item.text);
      return;
    }
    if (this.streamText.has(item.id)) {
      const streamed = this.streamText.get(item.id);
      const full = String(item.text || '');
      // Print whatever the deltas missed (e.g. text that arrived before we subscribed).
      if (full.length > streamed.length && full.startsWith(streamed)) this._appendStream(item.id, full.slice(streamed.length));
      this.streamText.delete(item.id);
      if (this.openKind === 'stream' && this.openId === item.id) {
        this._clearPrompt();
        this._closeOpen();
        this.lastLineKey = null;
        this._showPrompt();
      }
      return;
    }
    if (known) return;
    if (!item.text || !String(item.text).trim()) return;
    this.line(renderAssistantMessage(item, this.theme));
  }

  _appendStream(id, text) {
    if (!id || !text || this.closed) return;
    if (!this.streamText.has(id)) {
      // A late delta for a finished message is ignored; an unknown id starts a new stream.
      if (this.seen.has(id)) return;
      this.seen.add(id);
      this.streamText.set(id, '');
    }
    const before = this.streamText.get(id);
    if (!(this.openKind === 'stream' && this.openId === id)) {
      this._clearPrompt();
      this._closeOpen();
      this._write(before ? `${this.theme.c.dim(this.theme.s.ellipsis)} ` : renderAssistantPrefix(this.theme));
      this.openKind = 'stream';
      this.openId = id;
      this.col0 = false;
    }
    this._write(text);
    this.col0 = text.endsWith('\n');
    this.lastLineKey = null;
    this.streamText.set(id, before + text);
  }

  _onToolMessage(item) {
    const id = item.toolUseId || item.id;
    const existing = this.tools.get(id);
    if (existing) {
      // A re-broadcast of a known tool row: treat a finished status as an update.
      if (item.status && item.status !== 'running' && !existing.done) this._onToolUpdate({ toolUseId: id, status: item.status, output: item.output });
      this.seen.add(item.id);
      return;
    }
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    const rec = { ...item, done: item.status && item.status !== 'running' };
    this.tools.set(id, rec);
    if (rec.done) {
      this.line(renderToolRow(rec, this.theme), `tool:${id}`);
      return;
    }
    if (this.isTTY) {
      this.line(renderToolHead(rec, this.theme), `tool:${id}`);
    } else {
      this._clearPrompt();
      this._closeOpen();
      this._write(renderToolHead(rec, this.theme));
      this.openKind = 'tool';
      this.openId = id;
      this.col0 = false;
      this.lastLineKey = null;
    }
  }

  _onToolUpdate(data) {
    const id = data.toolUseId;
    const tool = this.tools.get(id);
    if (!tool || tool.done) return;
    tool.done = true;
    tool.status = data.status;
    tool.output = data.output;
    const { c } = this.theme;
    const mark = renderToolMark(data.status, data.output, this.theme);
    if (!mark) return;
    if (this.isTTY) {
      const full = renderToolRow(tool, this.theme);
      if (this.lastLineKey === `tool:${id}` && this.promptVisible && this._fitsOneRow(full)) {
        this._clearPrompt();
        readline.moveCursor(this.output, 0, -1);
        readline.cursorTo(this.output, 0);
        readline.clearLine(this.output, 0);
        this._write(`${full}\n`);
        this.col0 = true;
        this._showPrompt();
        return;
      }
      this.line(`  ${mark} ${c.dim(toolName(tool))}`);
      return;
    }
    if (this.openKind === 'tool' && this.openId === id && !this.col0) {
      this._write(` ${mark}\n`);
      this.col0 = true;
      this.openKind = null;
      this.openId = null;
      this.lastLineKey = null;
      return;
    }
    this.line(`  ${mark} ${toolName(tool)}`);
  }

  // ----- approvals and questions

  _renderPromptCard(p) {
    if (p.kind === 'approval') this.line(renderApproval(p.data, this.theme, { withHint: !this.isTTY }));
    else this.line(renderQuestion(p.data, this.theme));
  }

  _addPrompt(kind, data) {
    if (!data || !data.id || this.prompts.some((p) => p.id === data.id)) return;
    this.prompts.push({ kind, id: data.id, data });
    if (this.prompts.length === 1) this._renderPromptCard(this.prompts[0]);
    else this.line(this.theme.c.dim(`(${this.prompts.length - 1} more waiting after this one)`));
  }

  _removePrompt(id, note) {
    const idx = this.prompts.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const wasHead = idx === 0;
    this.prompts.splice(idx, 1);
    // Prompts answered here are dropped before the request, so a note means "answered elsewhere".
    if (note) this.line(note);
    if (wasHead && this.prompts.length) this._renderPromptCard(this.prompts[0]);
    else this._refreshPrompt();
  }

  /**
   * @param {{kind:string, id:string, data:object}} head the prompt being answered
   * @param {string} text
   * @param {{via?:'typed'|'voice'}} [o] how the answer came in (typed by default)
   */
  async _answerPrompt(head, text, { via = 'typed' } = {}) {
    const { c, s } = this.theme;
    if (head.kind === 'approval') {
      const critical = isCriticalApproval(head.data);
      const ans = parseApprovalAnswer(text);
      if (!ans) {
        this.line(
          c.yellow(
            critical
              ? 'Type allow (the whole word) to allow this critical action once, or n to deny. Add a reason after n to tell Claude why.'
              : 'Answer y (allow once), a (always allow this session) or n (deny). Add a reason after n to tell Claude why.'
          )
        );
        return;
      }
      // "always" adds the card's session rule; without one it would only allow once.
      const refused = critical
        ? criticalRefusal(ans, text, via)
        : ans.decision === 'allow_session' && head.data && head.data.sessionRule === null
          ? 'This action always asks: no session rule covers it. Answer y to allow it once, or n to deny.'
          : null;
      if (refused) {
        this.line(c.yellow(`${s.warn} ${refused}`));
        return;
      }
      const rule = head.data && typeof head.data.sessionRule === 'string' && head.data.sessionRule ? head.data.sessionRule : '';
      const label = ans.decision === 'allow' ? 'Allowed once' : ans.decision === 'allow_session' ? `Allowed for this session${rule ? `: ${rule}` : ''}` : `Denied${ans.message ? `: ${ans.message}` : ''}`;
      // Remove first so the resolved event does not print a second note.
      this._dropPrompt(head.id);
      try {
        await this.client.request('POST', '/api/approval', { id: head.id, decision: ans.decision, ...(ans.message ? { message: ans.message } : {}), via });
        this.line((ans.decision === 'deny' ? c.red : c.green)(`${s.arrow} ${label}`));
      } catch (err) {
        this.line(c.red(`${s.fail} Could not send the answer: ${err.message}`));
      }
      this._afterPromptChange();
      return;
    }
    const answer = parseQuestionAnswer(text, head.data && head.data.options);
    if (answer == null) {
      this.line(c.yellow('Type an answer (or a number to pick an option).'));
      return;
    }
    this._dropPrompt(head.id);
    try {
      await this.client.request('POST', '/api/answer', { id: head.id, text: answer });
      this.line(c.green(`${s.arrow} ${answer}`));
    } catch (err) {
      this.line(c.red(`${s.fail} Could not send the answer: ${err.message}`));
    }
    this._afterPromptChange();
  }

  _dropPrompt(id) {
    this.prompts = this.prompts.filter((p) => p.id !== id);
  }

  _afterPromptChange() {
    if (this.prompts.length) this._renderPromptCard(this.prompts[0]);
    else this._refreshPrompt();
  }

  // ----- input

  _onLine(line) {
    // In a TTY, readline already moved to a fresh line.
    this.promptVisible = false;
    if (this.isTTY) {
      this.col0 = true;
      if (this.openKind === 'stream') {
        this.openKind = null;
        this.openId = null;
      }
    }
    if (this.closed) return;
    if (this.isTTY) {
      this._handleLine(line);
      return;
    }
    this.inputChain = this.inputChain
      .then(() => this._waitConnected())
      .then(() => (this.closed ? null : this._handleLine(line)))
      .catch(() => {});
  }

  _handleLine(line) {
    if (this.recording) {
      return this._stopRecording().catch((err) => this.line(this.theme.c.red(`Recording failed: ${err.message}`)));
    }
    return this.handleInput(line).catch((err) => this.line(this.theme.c.red(`${this.theme.s.fail} ${err.message}`)));
  }

  /** Resolves once the first snapshot arrived (or after a while, so input is never stuck). */
  _waitConnected() {
    if (this.everConnected) return Promise.resolve();
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, PIPED_CONNECT_WAIT_MS);
      if (timer.unref) timer.unref();
    });
    return Promise.race([this._connected, late]).then(() => clearTimeout(timer));
  }

  /** Handle one line of user input (exposed for tests). */
  async handleInput(raw) {
    let text = String(raw == null ? '' : raw).trim();
    const slash = parseSlash(text);
    if (slash) {
      await this._slash(slash);
      return;
    }
    if (text.startsWith('//')) text = text.slice(1);
    const head = this.prompts[0];
    if (head) {
      await this._answerPrompt(head, text);
      return;
    }
    if (!text) {
      this._showPrompt();
      return;
    }
    await this._sendCommand(text, 'text', { echoed: this.isTTY });
  }

  /**
   * Follow config.context.attachScreenshotByDefault, unless /screen already changed the next
   * message's choice.
   * @param {object} cfg public config
   */
  _seedAttach(cfg) {
    const def = Boolean(cfg && cfg.context && cfg.context.attachScreenshotByDefault);
    if (this.attachNext === this.attachDefault) this.attachNext = def;
    this.attachDefault = def;
  }

  async _sendCommand(text, source, { echoed = false } = {}) {
    const { c, s } = this.theme;
    if (echoed) this.localEcho.push({ text, at: Date.now() });
    // Always explicit, so the daemon's default cannot differ from what [+screen] showed.
    const body = { text, source, attachScreenshot: Boolean(this.attachNext) };
    this.attachNext = this.attachDefault;
    this.inFlight += 1;
    this.postsPending += 1;
    this._checkIdleQuit();
    try {
      await this.client.request('POST', '/api/command', body);
    } catch (err) {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.postsPending = Math.max(0, this.postsPending - 1);
      if (echoed) this._consumeEcho(text);
      this.line(c.red(`${s.fail} Could not send: ${err.message}`));
      this._checkIdleQuit();
      return;
    }
    this.postsPending = Math.max(0, this.postsPending - 1);
    this._refreshPrompt();
    this._checkIdleQuit();
  }

  async _post(pathName, body) {
    try {
      return await this.client.request('POST', pathName, body);
    } catch (err) {
      this.line(this.theme.c.red(`${this.theme.s.fail} ${err.message}`));
      return null;
    }
  }

  /**
   * A project or mode switch. The daemon refuses one that would stop a running task (409);
   * the user confirms by repeating the command with --switch, which sends force.
   */
  async _postSwitch(pathName, body, force, retry) {
    const { c, s } = this.theme;
    try {
      return await this.client.request('POST', pathName, force ? { ...body, force: true } : body);
    } catch (err) {
      if (err && err.status === 409 && !force) {
        // Bridge commands that only wait for a terminal: nothing runs, so there is nothing to stop.
        if (/waiting for a Claude Code terminal/i.test(String(err.message))) {
          this.line(c.yellow(`${s.warn} ${err.message}. Run /anywhere here in Claude Code to pick it up, or run ${c.bold(retry)} to switch anyway.`));
        } else this.line(c.yellow(`${s.warn} ${err.message}. Wait for it, stop it (/stop), or run ${c.bold(retry)} to stop it and switch now.`));
      } else this.line(c.red(`${s.fail} ${err.message}`));
      return null;
    }
  }

  async _slash({ name, arg }) {
    const { c, s } = this.theme;
    switch (name) {
      case 'stop':
      case 'interrupt':
        if (await this._post('/api/interrupt')) this.line(c.yellow(`${s.stop} Interrupting${s.ellipsis}`));
        break;
      case 'new':
      case 'reset': {
        const r = await this._post('/api/session/new');
        if (r) this.line(c.dim(`Started a new session${r.sessionId ? ` (${String(r.sessionId).slice(0, 8)})` : ''}.`));
        break;
      }
      case 'mode': {
        const { rest, force } = splitSwitchFlag(arg);
        const mode = rest.toLowerCase();
        if (mode !== 'companion' && mode !== 'bridge') {
          this.line(`Mode is ${c.bold(this.state.mode || 'companion')}. Use ${c.bold('/mode companion')} or ${c.bold('/mode bridge')}.`);
          break;
        }
        const r = await this._postSwitch('/api/mode', { mode }, force, `/mode ${mode} --switch`);
        if (r && r.mode && r.mode !== this.state.mode) {
          this.state.mode = r.mode;
          this.line(`${c.dim('Mode:')} ${c.bold(r.mode)}`);
        }
        const moved = r && Number(r.moved) > 0 ? Number(r.moved) : 0;
        if (moved) this.line(c.dim(`${moved === 1 ? 'The command' : `The ${moved} commands`} that waited for a Claude Code terminal now run${moved === 1 ? 's' : ''} in the dialog's own session.`));
        break;
      }
      case 'project':
      case 'cd': {
        const { rest, force } = splitSwitchFlag(arg);
        if (!rest) {
          const p = this.state.project || {};
          this.line(p.dir ? `Project: ${c.bold(p.name || path.basename(p.dir))} ${c.dim(`(${p.dir})`)}` : 'No project. Use /project <dir>.');
          break;
        }
        const dir = path.resolve(this.cwd, expandHome(rest.replace(/^["']|["']$/g, ''), this.homedir));
        const r = await this._postSwitch('/api/project', { dir }, force, `/${name} ${rest} --switch`);
        if (r && r.project && (!this.state.project || this.state.project.dir !== r.project.dir)) {
          this.state.project = r.project;
          this.line(`${c.dim('Project:')} ${c.bold(r.project.name || path.basename(r.project.dir || dir))} ${c.dim(`(${r.project.dir || dir})`)}`);
        }
        break;
      }
      case 'screen':
      case 'screenshot':
        this.attachNext = !this.attachNext;
        this.line(c.dim(this.attachNext ? 'The next message will include a screenshot.' : 'The next message will not include a screenshot.'));
        break;
      case 'voice':
      case 'mic':
        await this._startRecording();
        break;
      case 'status': {
        try {
          const snap = await this.client.request('GET', '/api/state');
          this.line(renderStatusSummary(snap, this.theme));
        } catch (err) {
          this.line(c.red(`${s.fail} ${err.message}`));
        }
        break;
      }
      case 'show': {
        const r = await this._post('/api/show');
        if (r) this.line(c.dim(r.host && r.host !== 'none' ? `Dialog shown (${r.host}).` : 'No graphical dialog host is available here.'));
        break;
      }
      case 'clear':
        if (this.isTTY) {
          this._clearPrompt();
          this._write('\x1b[2J\x1b[H');
          this.col0 = true;
        }
        this._showPrompt();
        break;
      case 'help':
      case '?':
        this.line(renderHelp(this.theme));
        break;
      case 'quit':
      case 'exit':
      case 'q':
        this.quit();
        break;
      default:
        this.line(c.yellow(`Unknown command /${name}. Type /help (start with // to send it to Claude as text).`));
    }
  }

  _onCtrlC() {
    const { c, s } = this.theme;
    const now = Date.now();
    if (now - this.lastCtrlC < DOUBLE_CTRL_C_MS) {
      this.quit();
      return;
    }
    this.lastCtrlC = now;
    if (this.recording) {
      this._cancelRecording();
      this.line(c.dim('Recording cancelled.'));
      return;
    }
    if (BUSY_STATUSES.has(this.state.status) || this.inFlight > 0) {
      this.line(c.yellow(`${s.stop} Interrupting${s.ellipsis} (press Ctrl+C again within 2 s to quit)`));
      this.client.request('POST', '/api/interrupt').catch((err) => this.line(c.red(`${s.fail} ${err.message}`)));
      return;
    }
    if (this.isTTY && this.rl && this.rl.line) {
      this.rl.write(null, { ctrl: true, name: 'u' });
      return;
    }
    this.line(c.dim('(press Ctrl+C again to quit, or type /quit)'));
  }

  _onInputClosed() {
    if (this.closed) return;
    if (!this.isTTY) {
      // Let the lines read before EOF finish first.
      this.inputChain = this.inputChain.then(() => this._afterInputClosed());
      return;
    }
    this._afterInputClosed();
  }

  _afterInputClosed() {
    if (this.closed) return;
    // Piped input ended: wait for the work it started, then leave.
    if (!this.isTTY && (this.postsPending > 0 || this.inFlight > 0 || BUSY_STATUSES.has(this.state.status))) {
      this.quitWhenIdle = true;
      this._checkIdleQuit();
      return;
    }
    this.quit();
  }

  /**
   * Piped input ended with work pending: whether that work is over. Results are not counted (see
   * inFlight); the daemon's status is the truth: idle or error, nothing of ours still being
   * posted, and no approval or question waiting.
   */
  _idleForQuit() {
    return this.postsPending === 0 && this.prompts.length === 0 && IDLE_STATUSES.has(this.state.status);
  }

  /** With quitWhenIdle set, quit once the daemon has stayed idle for idleQuitMs. */
  _checkIdleQuit() {
    if (!this.quitWhenIdle || this.closed) return;
    if (!this._idleForQuit()) {
      if (this._idleTimer) clearTimeout(this._idleTimer);
      this._idleTimer = null;
      return;
    }
    if (this._idleTimer) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this.quitWhenIdle && !this.closed && this._idleForQuit()) this.quit();
    }, this.idleQuitMs);
  }

  /** Leave the TUI (the daemon keeps running). */
  quit() {
    if (this.closed) return;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
    this._cancelRecording();
    this._clearPrompt();
    if (!this.col0) this._write('\n');
    this.closed = true;
    try {
      if (this.sub) this.sub.close();
    } catch {
      /* ignore */
    }
    if (this._sigint) process.removeListener('SIGINT', this._sigint);
    try {
      if (this.rl) this.rl.close();
    } catch {
      /* ignore */
    }
    if (this._done) this._done();
  }

  // ----- voice

  async _startRecording() {
    const { c, s } = this.theme;
    if (this.recording) return;
    const rec = pickRecorder({ platform: this.platform, which: this.which, env: this.env, exists: this.exists });
    if (!rec) {
      this.line(c.red(`${s.fail} No audio recorder found. `) + recorderInstallHint(this.platform));
      return;
    }
    let device = null;
    if (rec.needsDevice) {
      const r = await this.runCmd(rec.cmd, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { timeoutMs: 10000 });
      device = parseDshowAudioDevices(`${r.stderr || ''}\n${r.stdout || ''}`)[0] || null;
      if (!device) {
        this.line(c.red(`${s.fail} ffmpeg found no microphone (DirectShow audio device). Check Windows Settings > Privacy > Microphone.`));
        return;
      }
    }
    const file = path.join(this.tmpdir, `anywhere-voice-${process.pid}-${Date.now()}.wav`);
    let child;
    try {
      child = this.spawn(rec.cmd, rec.buildArgs(file, device), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      this.line(c.red(`${s.fail} Could not start ${rec.name}: ${err.message}`));
      return;
    }
    const r = { child, file, rec, stderr: '', stopping: false, cancelled: false, error: null, code: null, signal: null, timer: null };
    r.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        r.code = code;
        r.signal = signal;
        resolve();
      });
      child.once('error', (err) => {
        r.error = err;
        resolve();
      });
    });
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        r.stderr = (r.stderr + d.toString()).slice(-4000);
      });
    }
    if (child.stdin) child.stdin.on('error', () => {});
    this.recording = r;
    r.timer = setTimeout(() => {
      if (this.recording === r && !r.stopping) {
        this.line(c.dim('Reached the 2-minute recording limit.'));
        this._stopRecording().catch(() => {});
      }
    }, MAX_RECORD_MS);
    if (r.timer.unref) r.timer.unref();
    r.exited.then(() => {
      if (this.recording !== r || r.stopping) return;
      // The recorder died on its own (no device, permission denied, …).
      clearTimeout(r.timer);
      this.recording = null;
      safeUnlink(file);
      const missing = Boolean(r.error && r.error.code === 'ENOENT');
      const why = r.error ? (missing ? `${rec.cmd} was not found` : r.error.message) : r.signal ? `stopped by ${r.signal}` : `exit code ${r.code}`;
      const detail = firstLine(r.stderr, 200, s);
      // The recorder exists but quit on its own: an install hint would be wrong advice.
      const hint = missing ? recorderInstallHint(this.platform) : r.error ? '' : noInputDeviceHint(this.platform);
      this.line(c.red(`${s.fail} Recording with ${rec.name} failed (${why})${detail ? `: ${detail}` : ''}.${hint ? ` ${hint}` : ''}`));
    });
    this.line(`${c.red(s.rec)} Recording with ${rec.name}${s.ellipsis} press Enter to stop.`);
  }

  _signalRecorder(r, hard) {
    try {
      if (hard) r.child.kill('SIGKILL');
      else if (r.rec.stop === 'q' && r.child.stdin && !r.child.stdin.destroyed) {
        r.child.stdin.write('q');
        r.child.stdin.end();
      } else if (this.platform === 'win32') r.child.kill();
      else r.child.kill('SIGINT');
    } catch {
      /* already gone */
    }
  }

  _cancelRecording() {
    const r = this.recording;
    if (!r) return;
    this.recording = null;
    r.stopping = true;
    r.cancelled = true;
    clearTimeout(r.timer);
    this._signalRecorder(r, false);
    const t = setTimeout(() => this._signalRecorder(r, true), 3000);
    if (t.unref) t.unref();
    r.exited.then(() => {
      clearTimeout(t);
      safeUnlink(r.file);
    });
  }

  async _stopRecording() {
    const r = this.recording;
    if (!r || r.stopping) return;
    r.stopping = true;
    clearTimeout(r.timer);
    this._signalRecorder(r, false);
    const t = setTimeout(() => this._signalRecorder(r, true), 5000);
    await r.exited;
    clearTimeout(t);
    this.recording = null;
    let buf = null;
    try {
      buf = fs.readFileSync(r.file);
    } catch {
      buf = null;
    }
    safeUnlink(r.file);
    const { c, s } = this.theme;
    if (!buf || buf.length < MIN_AUDIO_BYTES) {
      const detail = firstLine(r.stderr, 200, s);
      this.line(c.yellow(`No audio was captured; check that a microphone is connected and allowed.${detail ? ` (${detail})` : ''}`));
      return;
    }
    await this.transcribeAndSend(fixWavHeader(buf));
  }

  /** Send WAV audio to /api/stt and use the text as a command or as the pending answer. */
  async transcribeAndSend(wav) {
    const { c, s } = this.theme;
    this.line(c.dim(`Transcribing${s.ellipsis}`));
    const cfgVoice = (this.state.config && this.state.config.voice) || {};
    const lang = cfgVoice.language ? `?language=${encodeURIComponent(cfgVoice.language)}` : '';
    let res;
    try {
      res = await this.client.postBinary(`/api/stt${lang}`, wav, 'audio/wav', { timeoutMs: 120000 });
    } catch (err) {
      const hint = err.status && [400, 501, 503].includes(err.status) ? ` ${STT_HINT}` : '';
      this.line(c.red(`${s.fail} Speech-to-text failed: ${err.message}.${hint}`));
      return;
    }
    const text = String((res && res.text) || '').trim();
    if (!text) {
      this.line(c.yellow("I didn't catch that. Try /voice again."));
      return;
    }
    this.line(`${c.bold(c.cyan('You'))}${c.dim(' (voice)')}: ${text}`);
    const head = this.prompts[0];
    if (head) {
      await this._answerPrompt(head, text, { via: 'voice' });
      return;
    }
    if (/^(stop|cancel|abort)[.!]?$/i.test(text) && (BUSY_STATUSES.has(this.state.status) || this.inFlight > 0)) {
      if (await this._post('/api/interrupt')) this.line(c.yellow(`${s.stop} Interrupting${s.ellipsis}`));
      return;
    }
    await this._sendCommand(text, 'voice', { echoed: true });
  }
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Run the terminal dialog until the user quits.
 * @param {{client?:object, input?:NodeJS.ReadableStream, output?:NodeJS.WritableStream}} [opts]
 * @returns {Promise<void>}
 */
async function runTui({ client, input = process.stdin, output = process.stdout, ...rest } = {}) {
  let c = client;
  if (!c) {
    const { DaemonClient } = require('../shared/client');
    c = await DaemonClient.connect();
  }
  if (!c) {
    const err = new Error('Claude Anywhere is not running. Start it with: anywhere start');
    err.code = 'NOT_RUNNING';
    throw err;
  }
  const tui = new Tui({ client: c, input, output, ...rest });
  return tui.run();
}

module.exports = {
  runTui,
  Tui,
  colorEnabled,
  unicodeSupported,
  createPalette,
  createSymbols,
  createTheme,
  stripAnsi,
  formatCost,
  formatDuration,
  renderUserMessage,
  renderAssistantPrefix,
  renderAssistantMessage,
  renderToolHead,
  renderToolMark,
  renderToolRow,
  renderSystem,
  renderNotify,
  renderResult,
  renderStatusLine,
  renderApproval,
  renderQuestion,
  renderHeader,
  renderStatusSummary,
  renderHelp,
  parseApprovalAnswer,
  criticalRefusal,
  parseQuestionAnswer,
  parseSlash,
  pickRecorder,
  recorderInstallHint,
  noInputDeviceHint,
  parseDshowAudioDevices,
  fixWavHeader,
  BUSY_STATUSES,
};
