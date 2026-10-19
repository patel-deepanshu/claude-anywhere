/**
 * The calls pill and panel in the dialog (docs/CALLS-DESIGN.md §10.7).
 *
 *   pill   in the top bar: a phone button when calls are not answered, "Answering calls until 18:00"
 *          when armed, "Confirm in the card…" while the arm card waits, "Call from Ankit…" while it
 *          rings and "On a call with Ankit · 1:23" during a call. A click opens the panel.
 *   panel  the arm switch (it asks the daemon, which shows the click-only card: safeguard (d)) with
 *          a duration, the apps that may be answered, quiet hours, the live call (transcript,
 *          actions, Take over, Hang up), recent calls with their notes, and the audio self-test.
 *
 * Mounting (the loader, calls-ui.js): `const panel = mount({api, hooked})`, then feed it the dialog's
 * SSE events with panel.handleEvent(type, data). Without the dialog's hook the loader polls (the
 * panel refreshes /api/calls/status every 3 s) and feeds events from its own EventSource.
 *
 * Everything shown comes from the daemon; caller speech is untrusted and only ever set as text
 * (textContent / the markdown renderer's text nodes), never as HTML.
 */

import { renderMarkdown } from './markdown.js';

export const POLL_MS = 3000;
export const HOOKED_POLL_MS = 30000;
export const ARM_TIMEOUT_MS = 16 * 60 * 1000;
const MAX_TRANSCRIPT = 300;
const MAX_ACTIONS = 50;
const DURATIONS = [60, 120, 240, 480, 720];
const CONFIRM_MS = 3000;
export const APPS = Object.freeze([
  { id: 'zoho-cliq', label: 'Zoho Cliq' },
  { id: 'google-meet', label: 'Google Meet' },
  { id: 'teams', label: 'Microsoft Teams' },
  { id: 'slack', label: 'Slack' },
  { id: 'zoom', label: 'Zoom' },
]);
const STATE_LABEL = {
  ringing: 'ringing',
  answering: 'answering',
  greeting: 'greeting',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  acting: 'working',
  in_call: 'on the call',
  wrap_up: 'wrapping up',
  ending: 'ending',
};
const OUTCOME_LABEL = {
  answered: 'answered',
  ended: 'answered',
  missed: 'missed',
  user_answered: 'you answered',
  you_answered: 'you answered',
  declined: 'not answered',
  not_answered: 'not answered',
  failed: 'could not answer',
  taken_over: 'you took over',
  takeover: 'you took over',
};

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

// ------------------------------------------------------------------ pure helpers (exported for tests)

/** A CallManager reason code in words. */
export function reasonLabel(r) {
  return REASON_LABEL[r] || String(r || '').replace(/_/g, ' ');
}

export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** "18:00" in local time. */
export function clock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** A call timer: "0:07", "12:34", "1:02:03". */
export function timer(ms) {
  const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** "3 min 52 s", "45 s", "1 h 2 min". */
export function durationWords(ms) {
  const t = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  if (m) return `${m} min${s && m < 10 ? ` ${s} s` : ''}`;
  return `${s} s`;
}

export function appLabel(id) {
  const s = String(id == null ? '' : id).trim();
  if (!s) return '';
  const hit = APPS.find((a) => a.id === s);
  if (hit) return hit.label;
  const l = s.toLowerCase();
  if (/\bcliq\b/.test(l)) return 'Zoho Cliq';
  if (/\bmeet\b/.test(l)) return 'Google Meet';
  if (/\bteams\b/.test(l)) return 'Microsoft Teams';
  if (/\bslack\b/.test(l)) return 'Slack';
  if (/\bzoom\b/.test(l)) return 'Zoom';
  return s;
}

export function firstName(name) {
  const s = String(name == null ? '' : name).trim();
  const tok = s.split(/\s+/).find((t) => /\p{L}/u.test(t));
  return tok || '';
}

/** "HH:MM" (24 h) or null. */
export function validHm(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s == null ? '' : s));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${pad2(Number(m[1]))}:${m[2]}`;
}

function callerOf(c) {
  if (!c) return '';
  if (typeof c.caller === 'string') return c.caller;
  if (c.caller && typeof c.caller === 'object') return c.caller.displayName || c.caller.name || '';
  return c.callerName || '';
}

function transcriptItem(t) {
  if (!t || typeof t !== 'object') return null;
  const text = String(t.text == null ? '' : t.text).trim();
  if (!text) return null;
  return { role: t.role === 'assistant' ? 'assistant' : t.role === 'system' ? 'system' : 'caller', text, ts: toMs(t.ts), interrupted: Boolean(t.interrupted) };
}

function actionItem(a) {
  if (!a || typeof a !== 'object') return null;
  const summary = String(a.summary || a.name || '').trim();
  if (!summary) return null;
  return { name: String(a.name || ''), summary, ok: a.ok !== false, ts: toMs(a.ts), deferred: Boolean(a.deferred) };
}

/** The parts of /api/calls/status the panel shows, from whatever shape the daemon sends. */
export function normalizeStatus(st) {
  const s = st && typeof st === 'object' ? st : {};
  const until = toMs(s.until != null ? s.until : s.armedUntil);
  const audio = s.audio && typeof s.audio === 'object' ? s.audio : null;
  const cur = s.current && typeof s.current === 'object' ? s.current : s.ringing && typeof s.ringing === 'object' ? { ...s.ringing, state: s.ringing.state || 'ringing' } : null;
  return {
    armed: Boolean(s.armed),
    until,
    apps: Array.isArray(s.apps) ? s.apps.map(String) : [],
    quietHours: s.quietHours && typeof s.quietHours === 'object' ? s.quietHours : null,
    inQuietHours: Boolean(s.inQuietHours),
    pending: Boolean(s.pending || s.arming),
    audio: audio ? { mode: audio.mode || null, ready: audio.ready !== false, issues: Array.isArray(audio.issues) ? audio.issues : [] } : null,
    clone: s.clone && typeof s.clone === 'object' ? s.clone : null,
    notesDir: typeof s.notesDir === 'string' ? s.notesDir : '',
    current: cur
      ? {
          id: cur.id || cur.callId || null,
          caller: callerOf(cur),
          app: cur.appName || appLabel(cur.app),
          state: cur.state || null,
          since: toMs(cur.answeredAt || cur.startedAt),
          transcript: (Array.isArray(cur.transcript) ? cur.transcript : []).map(transcriptItem).filter(Boolean),
          actions: (Array.isArray(cur.actions) ? cur.actions : []).map(actionItem).filter(Boolean),
          saveTranscript: cur.saveTranscript !== false,
        }
      : null,
    recent: (Array.isArray(s.recent) ? s.recent : [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => {
        const start = toMs(r.answeredAt || r.startedAt || r.ts || r.at);
        const end = toMs(r.endedAt);
        const notesPath = typeof r.notes === 'string' ? r.notes : (r.notes && r.notes.path) || r.notesPath || '';
        return {
          id: r.id || r.callId || null,
          caller: callerOf(r) || 'Unknown caller',
          app: r.appName || appLabel(r.app),
          start,
          durationMs: Number.isFinite(r.durationMs) ? r.durationMs : start != null && end != null ? end - start : null,
          outcome: String(r.outcome || r.type || r.result || r.state || (notesPath ? 'answered' : '')),
          reason: String(r.reason || r.endReason || ''),
          notesPath,
        };
      }),
  };
}

/**
 * What the pill shows.
 * @returns {{kind:'off'|'pending'|'armed'|'quiet'|'ring'|'call', text:string, short:string, title:string}}
 */
export function pillState(st, { now = Date.now(), pending = false } = {}) {
  const s = st || normalizeStatus({});
  const c = s.current;
  if (c && c.state === 'ringing') {
    const who = firstName(c.caller) || 'someone';
    return { kind: 'ring', text: `Call from ${who}…`, short: 'Ringing', title: `${c.caller || 'A caller'} is calling${c.app ? ` on ${c.app}` : ''}` };
  }
  if (c) {
    const who = firstName(c.caller) || 'a caller';
    const t = c.since ? timer(now - c.since) : '';
    return { kind: 'call', text: `On a call with ${who}${t ? ` · ${t}` : ''}`, short: t || 'On a call', title: `The assistant is on a call with ${c.caller || 'a caller'}${c.app ? ` (${c.app})` : ''}. Click to follow it, take over or hang up.` };
  }
  if (pending || s.pending) return { kind: 'pending', text: 'Confirm in the card…', short: 'Confirm', title: 'Click Allow once on the card to let the assistant answer your calls.' };
  if (s.armed && (!s.until || s.until > now)) {
    const until = s.until ? clock(s.until) : '';
    if (s.inQuietHours) {
      const end = s.quietHours && validHm(s.quietHours.end);
      return { kind: 'quiet', text: `Quiet hours${end ? ` until ${end}` : ''}`, short: 'Quiet', title: `Answering calls${until ? ` until ${until}` : ''}, but quiet hours are on: calls ring through.` };
    }
    return { kind: 'armed', text: until ? `Answering calls until ${until}` : 'Answering calls', short: until ? `Until ${until}` : 'On', title: 'The assistant answers your calls. Click for details or to stop.' };
  }
  return { kind: 'off', text: '', short: '', title: 'Calls: the assistant is not answering. Click to set it up.' };
}

/** What the panel shows of a status, minus the live transcript and actions (updated in place). */
function statusKey(st) {
  const c = st.current;
  return JSON.stringify({ ...st, current: c ? { id: c.id, caller: c.caller, app: c.app, state: c.state, since: c.since, saveTranscript: c.saveTranscript } : null });
}

// ------------------------------------------------------------------ DOM helpers

const SVG_NS = 'http://www.w3.org/2000/svg';

function h(doc, tag, attrs, ...children) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'object' && c.nodeType ? c : doc.createTextNode(String(c)));
  }
  return el;
}

function phoneIcon(doc, cls = 'icon') {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = doc.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M5.2 3.5h3.1l1.6 4.1-2 1.4a12 12 0 0 0 7.1 7.1l1.4-2 4.1 1.6v3.1a1.7 1.7 0 0 1-1.8 1.7A17.2 17.2 0 0 1 3.5 5.3a1.7 1.7 0 0 1 1.7-1.8z');
  svg.append(p);
  return svg;
}

const STYLE = `
.ca-calls-pill{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:min(46vw,260px);padding:0 10px 0 8px;border-radius:999px;border:1px solid transparent;background:var(--surface-2);color:var(--text-2);font-size:12px;font-weight:600;white-space:nowrap;flex:none;transition:background var(--dur),color var(--dur)}
.ca-calls-pill:hover{background:var(--surface-3);color:var(--text)}
.ca-calls-pill:focus-visible{box-shadow:var(--focus)}
.ca-calls-pill .icon{width:15px;height:15px}
.ca-calls-pill-text{overflow:hidden;text-overflow:ellipsis;min-width:0}
.ca-calls-pill-short{display:none}
.ca-calls-pill[data-kind="off"]{width:32px;height:32px;padding:0;justify-content:center;background:transparent;color:var(--muted);border-radius:var(--r-sm)}
.ca-calls-pill[data-kind="off"]:hover{background:var(--surface-2);color:var(--text)}
.ca-calls-pill[data-kind="off"] .icon{width:18px;height:18px}
.ca-calls-pill[data-kind="armed"]{background:var(--green-soft);color:var(--green)}
.ca-calls-pill[data-kind="quiet"]{background:var(--surface-2);color:var(--muted)}
.ca-calls-pill[data-kind="pending"]{background:var(--amber-soft);color:var(--amber)}
.ca-calls-pill[data-kind="ring"]{background:var(--amber-soft);color:var(--amber)}
.ca-calls-pill[data-kind="call"]{background:var(--red-soft);color:var(--red)}
.ca-calls-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}
.ca-calls-pill[data-kind="ring"] .ca-calls-dot,.ca-calls-pill[data-kind="call"] .ca-calls-dot,.ca-calls-live-head .ca-calls-dot{animation:pulse 1.2s ease-in-out infinite}
.ca-calls-pill-fixed{position:fixed;top:8px;right:8px;z-index:44}
@media (max-width:399px){.ca-calls-pill:not([data-kind="off"]) .ca-calls-pill-text{display:none}.ca-calls-pill:not([data-kind="off"]) .ca-calls-pill-short{display:inline}}
.ca-calls .ca-body{gap:var(--s4)}
.ca-calls-section{display:flex;flex-direction:column;gap:var(--s2);min-width:0}
.ca-calls-section>h3{margin:0;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.ca-calls-row{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);min-width:0}
.ca-calls-apps{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s3);margin:0;padding:0;border:0}
.ca-calls-apps label{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;min-height:28px}
.ca-calls-apps input{accent-color:var(--accent);width:16px;height:16px;margin:0}
.ca-calls-times{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap;font-size:13px;color:var(--text-2)}
.ca-calls-times .input{width:auto;min-width:96px;flex:0 0 auto}
.ca-calls-live{display:flex;flex-direction:column;gap:var(--s2);padding:var(--s3);border-radius:var(--r);border:1px solid var(--red-dot);background:var(--red-soft)}
.ca-calls-live[data-state="ringing"]{border-color:var(--amber-dot);background:var(--amber-soft)}
.ca-calls-live-head{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap;font-size:13px;color:var(--text)}
.ca-calls-live-head strong{font-weight:650}
.ca-calls-live-head .ca-calls-dot{color:var(--red-dot)}
.ca-calls-live[data-state="ringing"] .ca-calls-live-head .ca-calls-dot{color:var(--amber-dot)}
.ca-calls-live-meta{color:var(--muted);font-variant-numeric:tabular-nums}
.ca-calls-transcript{list-style:none;margin:0;padding:var(--s2);display:flex;flex-direction:column;gap:6px;max-height:min(38vh,300px);overflow-y:auto;border-radius:var(--r-sm);background:var(--surface);border:1px solid var(--border);font-size:13px;line-height:1.45}
.ca-calls-transcript li{overflow-wrap:anywhere}
.ca-calls-transcript .ca-calls-who{font-weight:650;margin-right:6px}
.ca-calls-transcript li[data-role="assistant"] .ca-calls-who{color:var(--accent-text)}
.ca-calls-transcript li[data-role="system"]{color:var(--muted);font-style:italic}
.ca-calls-transcript .ca-calls-cut{color:var(--faint);font-size:11px;margin-left:4px}
.ca-calls-transcript-empty{color:var(--muted)}
.ca-calls-actions-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-2)}
.ca-calls-actions-list li{display:flex;gap:6px;align-items:baseline;overflow-wrap:anywhere}
.ca-calls-actions-list li[data-ok="false"]{color:var(--red)}
.ca-calls-mark{flex:none;font-weight:700}
.ca-calls-recent{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--r)}
.ca-calls-recent li{display:flex;align-items:center;gap:var(--s2);padding:var(--s2) var(--s3);border-top:1px solid var(--border);min-width:0}
.ca-calls-recent li:first-child{border-top:0}
.ca-calls-recent-main{display:flex;flex-direction:column;min-width:0;flex:1 1 auto;font-size:13px}
.ca-calls-recent-main span{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ca-calls-recent-time{flex:none;width:44px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.ca-calls-empty{margin:0;color:var(--muted);font-size:13px}
.ca-calls-link{display:flex;gap:var(--s2);align-items:center;min-width:0}
.ca-calls-link code{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:12px;padding:4px 6px;border-radius:6px;background:var(--code-bg);border:1px solid var(--code-border)}
.ca-calls-notes-view{font-size:13.5px;line-height:1.55;overflow-wrap:anywhere}
.ca-calls-notes-view table{border-collapse:collapse;font-size:12.5px}
.ca-calls-notes-view td,.ca-calls-notes-view th{border:1px solid var(--border);padding:4px 8px;text-align:left}
.ca-calls-notes-view h1{font-size:17px;margin:0 0 var(--s2)}
.ca-calls-notes-view h2{font-size:14px;margin:var(--s3) 0 var(--s1)}
.ca-calls-path{font-family:var(--mono);font-size:11.5px;color:var(--muted);overflow-wrap:anywhere;margin:0}
@media (prefers-reduced-motion:reduce){.ca-calls-dot{animation:none!important}}
`;

function ensureStyles(doc) {
  if (!doc.querySelector('link[data-anywhere-calls-css]')) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./calls.css', import.meta.url).href;
    link.dataset.anywhereCallsCss = '1';
    doc.head.append(link);
  }
  if (!doc.getElementById('ca-calls-style')) {
    const style = doc.createElement('style');
    style.id = 'ca-calls-style';
    style.textContent = STYLE;
    doc.head.append(style);
  }
}

// ------------------------------------------------------------------ the panel

class CallsPanel {
  constructor({ api, request, hooked = false, doc = globalThis.document, win = globalThis.window, now = () => Date.now() } = {}) {
    this.api = api;
    this.request = request || api;
    this.doc = doc;
    this.win = win;
    this.now = now;
    this.hooked = Boolean(hooked);
    this.status = normalizeStatus({});
    this.config = null;
    this.available = true;
    this.arming = false;
    this.flash = null; // {level, text}
    this.live = { id: null, transcript: [], actions: [] };
    this.minutes = null;
    this.isOpen = false;
    this.view = 'main';
    this.selfTest = null;
    this.hangupArmedUntil = 0;
    this.timers = { poll: 0, tick: 0, refresh: 0 };
    this.pill = null;
    this.overlay = null;
    this.els = {};
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    ensureStyles(this.doc);
    this.buildPill();
    this.refresh();
    this.loadConfig();
    this.setPolling(this.hooked ? HOOKED_POLL_MS : POLL_MS);
    this.timers.tick = this.win.setInterval(() => this.tick(), 1000);
  }

  destroy() {
    this.win.clearInterval(this.timers.poll);
    this.win.clearInterval(this.timers.tick);
    this.win.clearTimeout(this.timers.refresh);
    if (this.pill) this.pill.remove();
    if (this.overlay) this.overlay.remove();
  }

  setHooked(on) {
    if (this.hooked === Boolean(on)) return;
    this.hooked = Boolean(on);
    this.setPolling(this.hooked ? HOOKED_POLL_MS : POLL_MS);
  }

  setPolling(ms) {
    this.win.clearInterval(this.timers.poll);
    this.timers.poll = this.win.setInterval(() => {
      if (this.doc.hidden && !this.isOpen) return;
      this.refresh();
    }, ms);
  }

  /** A soon refresh (several events in a row cause one request). */
  refreshSoon(ms = 150) {
    this.win.clearTimeout(this.timers.refresh);
    this.timers.refresh = this.win.setTimeout(() => this.refresh(), ms);
  }

  async refresh() {
    let st;
    try {
      st = await this.api('GET', '/api/calls/status');
    } catch (err) {
      if (err && err.status === 404) {
        // This daemon has no calls feature: hide the pill, check again rarely.
        this.available = false;
        this.renderPill();
      }
      return;
    }
    this.available = true;
    this.applyStatus(normalizeStatus(st));
  }

  applyStatus(st) {
    this.status = st;
    const cur = st.current;
    let transcriptChanged = false;
    let actionsChanged = false;
    if (cur && cur.id && cur.id !== this.live.id) {
      this.live = { id: cur.id, transcript: [], actions: [] };
      transcriptChanged = true;
      actionsChanged = true;
    }
    // The status may carry the call's transcript (polling without the dialog's events).
    if (cur && cur.transcript.length > this.live.transcript.length) {
      this.live.transcript = cur.transcript.slice(-MAX_TRANSCRIPT);
      transcriptChanged = true;
    }
    if (cur && cur.actions.length > this.live.actions.length) {
      this.live.actions = cur.actions.slice(-MAX_ACTIONS);
      actionsChanged = true;
    }
    if (!cur) this.hangupArmedUntil = 0;
    this.renderPill();
    if (!this.isOpen || this.view !== 'main') return;
    // Rebuild only when something shown changed (a rebuild every poll would steal the focus).
    const key = statusKey(st);
    if (key !== this.lastKey) this.renderPanel();
    else {
      if (transcriptChanged) this.renderLiveTranscript();
      if (actionsChanged) this.renderLiveActions();
    }
  }

  async loadConfig() {
    try {
      const cfg = await this.api('GET', '/api/config');
      this.config = (cfg && cfg.calls) || null;
    } catch {
      return;
    }
    if (this.isOpen) this.renderPanel();
  }

  tick() {
    const st = this.status;
    if (st.armed && st.until && st.until <= this.now()) this.refreshSoon(0);
    if (st.current || st.armed) this.renderPill();
    if (this.isOpen && st.current) this.renderLiveHead();
    if (this.hangupArmedUntil && this.hangupArmedUntil <= this.now()) {
      this.hangupArmedUntil = 0;
      if (this.isOpen) this.renderLiveButtons();
    }
  }

  // ---------------------------------------------------------------- events

  /** One SSE event from the daemon (through the dialog's hook or the loader's own stream). */
  handleEvent(type, data) {
    const d = data && typeof data === 'object' ? data : {};
    switch (type) {
      case 'calls': {
        const st = { ...this.status };
        if (d.state === 'disarmed' || d.armed === false) {
          st.armed = false;
          st.until = null;
        } else if (d.armedUntil || d.until) {
          st.armed = true;
          st.until = toMs(d.armedUntil || d.until);
        }
        if ('call' in d) st.current = d.call ? normalizeStatus({ current: d.call }).current : null;
        this.applyStatus(st);
        this.refreshSoon(); // the whole status (recent calls, audio) follows
        break;
      }
      case 'call_transcript': {
        const item = transcriptItem(d);
        if (!item) break;
        if (d.callId && d.callId !== this.live.id) this.live = { id: d.callId, transcript: [], actions: [] };
        this.live.transcript.push(item);
        if (this.live.transcript.length > MAX_TRANSCRIPT) this.live.transcript.splice(0, this.live.transcript.length - MAX_TRANSCRIPT);
        if (this.isOpen) this.appendTranscript(item);
        break;
      }
      case 'call_action': {
        const item = actionItem(d);
        if (!item) break;
        if (d.callId && d.callId !== this.live.id) this.live = { id: d.callId, transcript: [], actions: [] };
        this.live.actions.push(item);
        if (this.live.actions.length > MAX_ACTIONS) this.live.actions.shift();
        if (this.isOpen) this.renderLiveActions();
        break;
      }
      case 'call_notes':
        this.setFlash({ level: 'ok', text: `Call notes saved: ${String(d.path || '').split(/[\\/]/).pop() || 'on your Desktop'}` });
        this.refreshSoon();
        break;
      case 'config':
        if (d.calls) {
          this.config = d.calls;
          if (this.isOpen) this.renderPanel();
        }
        break;
      case 'approval_request':
      case 'question':
        // A card needs the user (the arm card among them): get out of its way.
        if (this.isOpen) this.close();
        break;
      default:
        break;
    }
  }

  /** Show a message at the top of the panel (now, when it is open). */
  setFlash(f) {
    this.flash = f;
    if (this.isOpen && this.view === 'main') this.renderPanel();
  }

  // ---------------------------------------------------------------- pill

  buildPill() {
    const doc = this.doc;
    const text = h(doc, 'span', { class: 'ca-calls-pill-text' });
    const short = h(doc, 'span', { class: 'ca-calls-pill-short', 'aria-hidden': 'true' });
    const dot = h(doc, 'span', { class: 'ca-calls-dot', 'aria-hidden': 'true' });
    const pill = h(doc, 'button', { type: 'button', class: 'ca-calls-pill', id: 'calls-pill', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => (this.isOpen ? this.close() : this.open()) }, phoneIcon(doc), dot, text, short);
    this.pillParts = { text, short, dot };
    const actions = doc.querySelector('.topbar-actions');
    if (actions) actions.prepend(pill);
    else {
      pill.classList.add('ca-calls-pill-fixed');
      doc.body.append(pill);
    }
    this.pill = pill;
    this.renderPill();
  }

  renderPill() {
    if (!this.pill) return;
    if (!this.available) {
      this.pill.hidden = true;
      return;
    }
    this.pill.hidden = false;
    const p = pillState(this.status, { now: this.now(), pending: this.arming });
    this.pill.dataset.kind = p.kind;
    this.pill.title = p.title;
    this.pill.setAttribute('aria-label', p.kind === 'off' ? 'Calls' : `Calls: ${p.text}`);
    this.pillParts.text.textContent = p.text;
    this.pillParts.short.textContent = p.short;
    this.pillParts.dot.hidden = p.kind === 'off';
    this.pill.querySelector('svg').style.display = p.kind === 'off' ? '' : 'none';
  }

  // ---------------------------------------------------------------- panel

  open() {
    if (!this.overlay) this.buildPanel();
    this.isOpen = true;
    this.view = 'main';
    this.overlay.hidden = false;
    this.pill.setAttribute('aria-expanded', 'true');
    this.renderPanel();
    this.refresh();
    this.loadConfig();
    this.els.close.focus();
  }

  close() {
    if (!this.overlay || !this.isOpen) return;
    this.isOpen = false;
    this.overlay.hidden = true;
    this.pill.setAttribute('aria-expanded', 'false');
    if (this.doc.activeElement && this.overlay.contains(this.doc.activeElement)) this.pill.focus();
  }

  buildPanel() {
    const doc = this.doc;
    const close = h(doc, 'button', { type: 'button', class: 'icon-btn ca-close', 'aria-label': 'Close the calls panel', text: '×', onclick: () => this.close() });
    const back = h(doc, 'button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '‹ Back', hidden: true, onclick: () => this.showMain() });
    const title = h(doc, 'h2', { class: 'ca-title', id: 'ca-calls-title', text: 'Calls' });
    const body = h(doc, 'div', { class: 'ca-body' });
    const sheet = h(doc, 'section', { class: 'ca-sheet ca-calls', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ca-calls-title' }, h(doc, 'header', { class: 'ca-head' }, back, title, close), body);
    const overlay = h(doc, 'div', { class: 'ca-overlay ca-calls-overlay', hidden: true }, sheet);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this.close();
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this.view !== 'main') this.showMain();
        else this.close();
      } else if (e.key === 'Tab') this.trapFocus(e, sheet);
    });
    doc.body.append(overlay);
    this.overlay = overlay;
    this.els = { close, back, title, body, sheet };
  }

  trapFocus(e, sheet) {
    const items = [...sheet.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && this.doc.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && this.doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  showMain() {
    this.view = 'main';
    this.renderPanel();
    this.els.close.focus();
  }

  callsConfig() {
    const c = this.config || {};
    return {
      apps: Array.isArray(c.apps) ? c.apps : this.status.apps.length ? this.status.apps : APPS.map((a) => a.id),
      quietHours: c.quietHours || this.status.quietHours || { enabled: true, start: '22:00', end: '08:00' },
      defaultArmMinutes: Number(c.defaultArmMinutes) > 0 ? Number(c.defaultArmMinutes) : 120,
      maxArmMinutes: Number(c.maxArmMinutes) > 0 ? Number(c.maxArmMinutes) : 720,
      notesDir: c.notesDir || '',
    };
  }

  renderPanel() {
    if (!this.overlay) return;
    const { body, title, back } = this.els;
    if (this.view === 'notes') return; // the notes view renders itself
    title.textContent = 'Calls';
    back.hidden = true;
    this.lastKey = statusKey(this.status);
    const keepScroll = body.scrollTop;
    const active = this.doc.activeElement;
    const focusId = active && body.contains(active) && active.id ? active.id : null;
    body.replaceChildren(...[this.renderFlash(), this.renderLive(), this.renderArm(), this.renderApps(), this.renderQuiet(), this.renderRecent(), this.renderAudio(), this.renderFooter()].filter(Boolean));
    body.scrollTop = keepScroll;
    const list = body.querySelector('.ca-calls-transcript');
    if (list) list.scrollTop = list.scrollHeight;
    if (focusId) {
      const again = this.doc.getElementById(focusId);
      if (again && !again.disabled) again.focus();
    }
  }

  renderFlash() {
    if (!this.flash) return null;
    const f = this.flash;
    return h(this.doc, 'p', { class: 'ca-note', dataset: { level: f.level }, role: 'status', text: f.text });
  }

  // live call

  renderLive() {
    const c = this.status.current;
    if (!c) {
      this.els.live = null;
      return null;
    }
    const doc = this.doc;
    const headText = h(doc, 'strong');
    const meta = h(doc, 'span', { class: 'ca-calls-live-meta' });
    const stateTag = h(doc, 'span', { class: 'tag', dataset: { state: 'busy' } });
    const head = h(doc, 'div', { class: 'ca-calls-live-head' }, h(doc, 'span', { class: 'ca-calls-dot', 'aria-hidden': 'true' }), headText, meta, stateTag);
    const transcript = h(doc, 'ol', { class: 'ca-calls-transcript', 'aria-live': 'polite', 'aria-label': 'Live transcript' });
    const actions = h(doc, 'ul', { class: 'ca-calls-actions-list', 'aria-label': 'What the assistant did' });
    const buttons = h(doc, 'div', { class: 'ca-actions' });
    const box = h(doc, 'section', { class: 'ca-calls-live', dataset: { state: c.state || 'in_call' }, 'aria-label': 'Current call' }, head, transcript, actions, buttons);
    this.els.live = { box, headText, meta, stateTag, transcript, actions, buttons };
    this.renderLiveHead();
    this.renderLiveTranscript();
    this.renderLiveActions();
    this.renderLiveButtons();
    return box;
  }

  renderLiveTranscript() {
    const L = this.els.live;
    const c = this.status.current;
    if (!L || !c) return;
    const doc = this.doc;
    const rows = [];
    if (!c.saveTranscript) rows.push(h(doc, 'li', { class: 'ca-calls-transcript-empty', text: 'The caller asked not to be transcribed.' }));
    else if (!this.live.transcript.length) rows.push(h(doc, 'li', { class: 'ca-calls-transcript-empty', text: c.state === 'ringing' ? 'Ringing…' : 'Waiting for the first words…' }));
    else for (const t of this.live.transcript) rows.push(this.transcriptRow(t));
    L.transcript.replaceChildren(...rows);
    L.transcript.scrollTop = L.transcript.scrollHeight;
  }

  renderLiveHead() {
    const c = this.status.current;
    const L = this.els.live;
    if (!c || !L) return;
    const ringing = c.state === 'ringing';
    L.box.dataset.state = c.state || 'in_call';
    L.headText.textContent = ringing ? `${c.caller || 'Someone'} is calling` : `On a call with ${c.caller || 'an unknown caller'}`;
    L.meta.textContent = [c.app, !ringing && c.since ? timer(this.now() - c.since) : ''].filter(Boolean).join(' · ');
    const label = STATE_LABEL[c.state] || c.state || '';
    L.stateTag.textContent = label;
    L.stateTag.hidden = !label;
  }

  transcriptRow(t) {
    const doc = this.doc;
    const who = t.role === 'assistant' ? 'Assistant' : t.role === 'system' ? '' : firstName(this.status.current && this.status.current.caller) || 'Caller';
    const li = h(doc, 'li', { dataset: { role: t.role } });
    if (who) li.append(h(doc, 'span', { class: 'ca-calls-who', text: `${who}:` }));
    li.append(doc.createTextNode(t.text));
    if (t.interrupted) li.append(h(doc, 'span', { class: 'ca-calls-cut', text: '(interrupted)' }));
    return li;
  }

  appendTranscript(t) {
    const L = this.els.live;
    if (!L) {
      this.renderPanel();
      return;
    }
    const list = L.transcript;
    const empty = list.querySelector('.ca-calls-transcript-empty');
    if (empty) empty.remove();
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.append(this.transcriptRow(t));
    while (list.children.length > MAX_TRANSCRIPT) list.firstElementChild.remove();
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  renderLiveActions() {
    const L = this.els.live;
    if (!L) return;
    const doc = this.doc;
    L.actions.replaceChildren(
      ...this.live.actions.map((a) => {
        const at = a.ts ? `${clock(a.ts)} ` : '';
        return h(doc, 'li', { dataset: { ok: String(a.ok) } }, h(doc, 'span', { class: 'ca-calls-mark', 'aria-hidden': 'true', text: a.deferred ? '→' : a.ok ? '✓' : '✗' }), h(doc, 'span', { text: `${at}${a.deferred ? 'For you: ' : ''}${a.summary}` }));
      }),
    );
    L.actions.hidden = !this.live.actions.length;
  }

  renderLiveButtons() {
    const L = this.els.live;
    const c = this.status.current;
    if (!L || !c) return;
    const doc = this.doc;
    if (c.state === 'ringing') {
      L.buttons.replaceChildren(h(doc, 'p', { class: 'ca-fine', text: 'The assistant answers after a few seconds unless you pick up yourself.' }));
      return;
    }
    const confirming = this.hangupArmedUntil > this.now();
    L.buttons.replaceChildren(
      h(doc, 'button', { type: 'button', class: 'btn btn-primary', text: 'Take over', title: 'Switch the call to your own microphone; the assistant stops talking', onclick: () => this.callAction('takeover') }),
      h(doc, 'button', {
        type: 'button',
        class: 'btn btn-danger',
        text: confirming ? 'Click again to hang up' : 'Hang up',
        title: 'End the call for the caller too',
        onclick: () => {
          if (this.hangupArmedUntil > this.now()) {
            this.hangupArmedUntil = 0;
            this.callAction('hangup');
          } else {
            this.hangupArmedUntil = this.now() + CONFIRM_MS;
            this.renderLiveButtons();
          }
        },
      }),
    );
  }

  async callAction(which) {
    const c = this.status.current;
    const before = this.flash;
    let next;
    try {
      await this.api('POST', `/api/calls/${which}`, { callId: c && c.id, via: 'panel' });
      next = which === 'takeover' ? { level: 'ok', text: 'You have the call: your microphone is back on. The notes cover the call up to now.' } : { level: 'ok', text: 'Hanging up…' };
    } catch (err) {
      next = { level: 'error', text: `${which === 'takeover' ? 'Take over' : 'Hang up'} failed: ${err.message}` };
    }
    // A newer message (the notes arrived meanwhile) wins.
    if (this.flash === before) this.setFlash(next);
    this.refresh();
  }

  // arm

  renderArm() {
    const doc = this.doc;
    const st = this.status;
    const cfg = this.callsConfig();
    const now = this.now();
    const armed = st.armed && (!st.until || st.until > now);
    const input = h(doc, 'input', { type: 'checkbox', role: 'switch', id: 'ca-calls-arm', 'aria-describedby': 'ca-calls-arm-help' });
    input.checked = armed || this.arming;
    input.disabled = this.arming;
    input.addEventListener('change', () => (input.checked ? this.arm() : this.disarm()));
    const apps = st.apps.length ? st.apps : cfg.apps;
    let help;
    if (this.arming) help = 'Click Allow once on the card in the dialog.';
    else if (armed) help = `Until ${st.until ? clock(st.until) : 'you turn it off'} · ${apps.map(appLabel).join(', ') || 'no apps'}`;
    else help = 'Off. The assistant answers only after you allow it on a card, and only until the time you choose.';
    const sw = h(doc, 'label', { class: 'set-switch', for: 'ca-calls-arm' }, input, h(doc, 'span', { class: 'switch', 'aria-hidden': 'true' }), h(doc, 'span', { class: 'set-label' }, 'Answer my calls', h(doc, 'small', { id: 'ca-calls-arm-help', text: help })));
    const section = h(doc, 'section', { class: 'ca-calls-section', 'aria-label': 'Answer calls' }, sw);
    if (!armed && !this.arming) {
      const choices = DURATIONS.filter((m) => m <= cfg.maxArmMinutes);
      if (this.minutes == null || !choices.includes(this.minutes)) this.minutes = choices.includes(cfg.defaultArmMinutes) ? cfg.defaultArmMinutes : choices[0] || 60;
      const seg = h(doc, 'div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'For how long' });
      for (const m of choices) {
        const r = h(doc, 'input', { type: 'radio', name: 'ca-calls-minutes', value: String(m), id: `ca-calls-for-${m}` });
        r.checked = m === this.minutes;
        r.addEventListener('change', () => {
          this.minutes = m;
        });
        seg.append(h(doc, 'label', {}, r, h(doc, 'span', { text: `${m / 60} h` })));
      }
      section.append(seg);
    }
    for (const n of this.notices()) section.append(n);
    return section;
  }

  notices() {
    const doc = this.doc;
    const st = this.status;
    const out = [];
    if (st.inQuietHours && st.quietHours && st.quietHours.enabled !== false) {
      out.push(h(doc, 'p', { class: 'ca-note', dataset: { level: 'warn' }, text: `Quiet hours are on until ${validHm(st.quietHours.end) || '08:00'}: calls ring through and are noted as missed.` }));
    }
    if (st.audio && !st.audio.ready) {
      const first = st.audio.issues[0];
      const note = h(doc, 'div', { class: 'ca-alert', dataset: { level: 'warn' } }, h(doc, 'strong', { text: 'Call audio is not ready.' }), h(doc, 'span', { text: first ? first.message || first.code || '' : 'Run the audio self-test below.' }));
      if (first && first.hint) note.append(h(doc, 'span', { class: 'ca-help', text: first.hint }));
      note.append(h(doc, 'div', { class: 'ca-actions' }, h(doc, 'button', { type: 'button', class: 'btn btn-sm', text: 'Set up call audio', onclick: () => this.audioSetup() })));
      out.push(note);
    }
    if (st.clone && st.clone.exists === false) {
      out.push(
        h(doc, 'p', { class: 'ca-note' }, 'Calls use the standard voice. ', h(doc, 'button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Record your voice', onclick: () => this.openClone() })),
      );
    }
    return out;
  }

  openClone() {
    this.close();
    this.win.dispatchEvent(new this.win.CustomEvent('anywhere:clone-open'));
  }

  async arm() {
    if (this.arming) return;
    this.arming = true;
    this.flash = null;
    const minutes = this.minutes || this.callsConfig().defaultArmMinutes;
    this.renderPill();
    // The card appears in the dialog: get out of its way.
    this.close();
    try {
      const r = await this.request('POST', '/api/calls/arm', { minutes, via: 'panel' }, { timeoutMs: ARM_TIMEOUT_MS });
      if (r && r.armed) {
        this.status = { ...this.status, armed: true, until: toMs(r.until) || this.status.until };
        this.flash = null;
      } else if (r && r.error && !r.denied) {
        // Could not arm (the voice runtime is missing, another request waits…): say why and how to fix it.
        this.flash = { level: 'error', text: `Could not turn on call answering: ${r.error}${r.hint ? ` ${r.hint}` : ''}` };
      } else {
        this.flash = { level: 'warn', text: `Not answering calls: it was not allowed${r && (r.reason || r.error) ? ` (${r.reason || r.error})` : ''}.` };
      }
    } catch (err) {
      this.flash = { level: 'error', text: `Could not turn on call answering: ${err.message}` };
    } finally {
      this.arming = false;
      this.renderPill();
      // A failure (no card was shown): reopen the panel so the reason is seen.
      if (this.flash && this.flash.level === 'error' && !this.isOpen) this.open();
      else if (this.isOpen) this.renderPanel();
      this.refresh();
    }
  }

  async disarm() {
    this.status = { ...this.status, armed: false };
    this.renderPill();
    try {
      await this.api('POST', '/api/calls/disarm', { via: 'panel' });
      this.flash = { level: 'ok', text: 'Stopped answering calls.' };
    } catch (err) {
      this.flash = { level: 'error', text: `Could not stop: ${err.message}. Run: anywhere calls off` };
    }
    await this.refresh();
    if (this.isOpen) this.renderPanel();
  }

  // apps and quiet hours (saved settings)

  async saveCalls(partial, okText) {
    try {
      const pub = await this.api('POST', '/api/config', { calls: partial });
      if (pub && pub.calls) this.config = pub.calls;
      else this.config = { ...(this.config || {}), ...partial };
      this.flash = okText ? { level: 'ok', text: okText } : null;
    } catch (err) {
      this.flash = { level: 'error', text: `Not saved: ${err.message}` };
    }
    if (this.isOpen) this.renderPanel();
  }

  renderApps() {
    const doc = this.doc;
    const cfg = this.callsConfig();
    const set = new Set(cfg.apps);
    const box = h(doc, 'fieldset', { class: 'ca-calls-apps' }, h(doc, 'legend', { class: 'sr-only', text: 'Apps the assistant may answer' }));
    for (const a of APPS) {
      const cb = h(doc, 'input', { type: 'checkbox', value: a.id, id: `ca-calls-app-${a.id}` });
      cb.checked = set.has(a.id);
      cb.addEventListener('change', () => {
        const next = APPS.map((x) => x.id).filter((id) => (id === a.id ? cb.checked : set.has(id)));
        if (!next.length) {
          cb.checked = true;
          this.flash = { level: 'warn', text: 'Keep at least one app, or turn call answering off.' };
          this.renderPanel();
          return;
        }
        this.saveCalls({ apps: next }, this.status.armed ? 'Saved. The apps apply from the next time you turn answering on.' : null);
      });
      box.append(h(doc, 'label', {}, cb, a.label));
    }
    return h(doc, 'section', { class: 'ca-calls-section' }, h(doc, 'h3', { text: 'Apps' }), box);
  }

  renderQuiet() {
    const doc = this.doc;
    const qh = this.callsConfig().quietHours || {};
    const enabled = qh.enabled !== false;
    const on = h(doc, 'input', { type: 'checkbox', role: 'switch', id: 'ca-calls-quiet' });
    on.checked = enabled;
    const start = h(doc, 'input', { type: 'time', class: 'input', id: 'ca-calls-qh-start', value: validHm(qh.start) || '22:00', 'aria-label': 'Quiet hours start', step: '300' });
    const end = h(doc, 'input', { type: 'time', class: 'input', id: 'ca-calls-qh-end', value: validHm(qh.end) || '08:00', 'aria-label': 'Quiet hours end', step: '300' });
    start.disabled = !enabled;
    end.disabled = !enabled;
    const save = () => {
      const s = validHm(start.value);
      const e = validHm(end.value);
      if (!s || !e) {
        this.flash = { level: 'warn', text: 'Enter times like 22:00 and 08:00.' };
        this.renderPanel();
        return;
      }
      this.saveCalls({ quietHours: { enabled: on.checked, start: s, end: e } });
    };
    on.addEventListener('change', save);
    start.addEventListener('change', save);
    end.addEventListener('change', save);
    const sw = h(doc, 'label', { class: 'set-switch', for: 'ca-calls-quiet' }, on, h(doc, 'span', { class: 'switch', 'aria-hidden': 'true' }), h(doc, 'span', { class: 'set-label' }, 'Quiet hours', h(doc, 'small', { text: 'Calls ring through and are noted as missed.' })));
    const times = h(doc, 'div', { class: 'ca-calls-times' }, 'From', start, 'to', end);
    return h(doc, 'section', { class: 'ca-calls-section' }, h(doc, 'h3', { text: 'Quiet hours' }), sw, times);
  }

  // recent calls and notes

  renderRecent() {
    const doc = this.doc;
    const list = this.status.recent;
    const section = h(doc, 'section', { class: 'ca-calls-section' }, h(doc, 'h3', { text: 'Recent calls' }));
    if (!list.length) {
      section.append(h(doc, 'p', { class: 'ca-calls-empty', text: 'No calls yet.' }));
      return section;
    }
    const ul = h(doc, 'ul', { class: 'ca-calls-recent' });
    for (const r of list.slice(0, 12)) {
      const outcome = OUTCOME_LABEL[r.outcome] || r.outcome || '';
      const why = r.reason && ['missed', 'not_answered', 'failed'].includes(r.outcome) ? reasonLabel(r.reason) : '';
      const sub = [r.app, outcome, r.durationMs ? durationWords(r.durationMs) : '', why].filter(Boolean).join(' · ');
      const li = h(doc, 'li', {}, h(doc, 'span', { class: 'ca-calls-recent-time', text: r.start ? clock(r.start) : '' }), h(doc, 'div', { class: 'ca-calls-recent-main' }, h(doc, 'strong', { text: r.caller }), h(doc, 'span', { text: sub })));
      if (r.notesPath || (r.id && r.outcome === 'answered')) {
        li.append(h(doc, 'button', { type: 'button', class: 'btn btn-sm', text: 'Notes', 'aria-label': `Notes of the call with ${r.caller}`, onclick: () => this.showNotes(r) }));
      }
      ul.append(li);
    }
    section.append(ul);
    return section;
  }

  async showNotes(r) {
    const doc = this.doc;
    const { body, title, back } = this.els;
    this.view = 'notes';
    title.textContent = `Call with ${r.caller}`;
    back.hidden = false;
    body.replaceChildren(h(doc, 'p', { class: 'ca-muted', text: 'Loading the notes…' }));
    back.focus();
    const q = r.id ? `callId=${encodeURIComponent(r.id)}` : `path=${encodeURIComponent(r.notesPath)}`;
    let data = null;
    let error = null;
    try {
      data = await this.api('GET', `/api/calls/notes?${q}`);
    } catch (err) {
      error = err;
    }
    if (this.view !== 'notes') return;
    const path = (data && data.path) || r.notesPath || '';
    const parts = [];
    if (data && typeof data.markdown === 'string') {
      const view = h(doc, 'div', { class: 'ca-calls-notes-view' });
      view.append(renderMarkdown(data.markdown, doc));
      parts.push(view);
    } else {
      parts.push(h(doc, 'p', { class: 'ca-note', dataset: { level: error && error.status !== 404 ? 'warn' : 'info' }, text: error && error.status !== 404 ? `The notes could not be shown: ${error.message}` : 'Open the notes file on your computer:' }));
    }
    if (path) parts.push(h(doc, 'p', { class: 'ca-calls-path', text: path }));
    const actions = h(doc, 'div', { class: 'ca-actions' });
    actions.append(h(doc, 'button', { type: 'button', class: 'btn btn-sm', text: 'Open the file', onclick: () => this.openNotes(r) }));
    if (path) actions.append(h(doc, 'button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Copy the path', onclick: () => this.copy(path) }));
    parts.push(actions);
    body.replaceChildren(...parts);
  }

  async openNotes(r) {
    try {
      await this.api('POST', '/api/calls/notes/open', r.id ? { callId: r.id } : { path: r.notesPath });
      this.flash = { level: 'ok', text: 'Opened the notes on your computer.' };
    } catch (err) {
      this.flash = { level: 'warn', text: err.status === 404 ? 'This version cannot open files from the dialog: copy the path instead.' : `Could not open the notes: ${err.message}` };
    }
    if (this.view === 'notes') {
      const body = this.els.body;
      const old = body.querySelector('.ca-calls-open-msg');
      if (old) old.remove();
      body.append(h(this.doc, 'p', { class: 'ca-note ca-calls-open-msg', dataset: { level: this.flash.level }, text: this.flash.text }));
      this.flash = null;
    }
  }

  async copy(text) {
    try {
      await this.win.navigator.clipboard.writeText(text);
      this.flash = { level: 'ok', text: 'Copied.' };
    } catch {
      this.flash = { level: 'warn', text: 'Could not copy: select the text instead.' };
    }
  }

  // audio

  renderAudio() {
    const doc = this.doc;
    const a = this.status.audio;
    const section = h(doc, 'section', { class: 'ca-calls-section' }, h(doc, 'h3', { text: 'Call audio' }));
    if (a) {
      const mode = a.mode === 'speakers' ? 'Speakers and microphone (works, lower quality)' : a.mode === 'virtual' ? 'Virtual microphone' : a.mode || 'Unknown';
      section.append(h(doc, 'div', { class: 'ca-calls-row' }, h(doc, 'span', { text: mode }), h(doc, 'span', { class: 'tag', dataset: { state: a.ready ? 'ok' : 'error' }, text: a.ready ? 'ready' : 'not ready' })));
    }
    section.append(h(doc, 'p', { class: 'ca-help', text: 'Check that callers hear the assistant and the assistant hears callers, in the browser you take calls in.' }));
    section.append(h(doc, 'div', { class: 'ca-actions' }, h(doc, 'button', { type: 'button', class: 'btn btn-sm', text: 'Test call audio', onclick: () => this.startSelfTest() })));
    if (this.selfTest) {
      const t = this.selfTest;
      if (t.error) section.append(h(doc, 'p', { class: 'ca-note', dataset: { level: 'error' }, text: t.error }));
      else {
        section.append(h(doc, 'p', { class: 'ca-help', text: t.opened ? 'The test page opened in your default browser. If your calls run in another browser, open this link there (it works once, for 2 minutes):' : 'Open this link in the browser you take calls in (it works once, for 2 minutes):' }));
        section.append(
          h(doc, 'div', { class: 'ca-calls-link' }, h(doc, 'code', { text: t.url }), h(doc, 'a', { class: 'btn btn-sm', href: t.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open' }), h(doc, 'button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Copy', onclick: () => this.copy(t.url) })),
        );
      }
    }
    return section;
  }

  async startSelfTest() {
    try {
      const r = await this.api('POST', '/api/calls/audio-test/start', { open: true });
      let url = String((r && (r.url || r.path)) || '');
      if (url.startsWith('/')) url = `${this.win.location.origin}${url}`;
      this.selfTest = /^https?:\/\//.test(url) ? { url, opened: Boolean(r && r.opened) } : { error: 'The daemon returned no test link.' };
    } catch (err) {
      this.selfTest = { error: `The audio self-test could not start: ${err.message}` };
    }
    this.renderPanel();
  }

  async audioSetup() {
    try {
      const r = await this.api('POST', '/api/calls/audio/setup', {});
      this.flash = r && r.ok === false ? { level: 'warn', text: `Call audio could not be set up${r.error ? `: ${r.error}` : ''}. Run: anywhere calls doctor` } : { level: 'ok', text: 'Call audio is set up. Run the self-test to check it.' };
    } catch (err) {
      this.flash = { level: 'error', text: `Call audio could not be set up: ${err.message}` };
    }
    await this.refresh();
    this.renderPanel();
  }

  renderFooter() {
    const doc = this.doc;
    const dir = this.status.notesDir || this.callsConfig().notesDir;
    return h(
      doc,
      'p',
      { class: 'ca-fine' },
      'The assistant always says it is an AI and that it takes notes. It can only look up and assign tickets to the caller, message them after the call, and note the rest for you. ',
      dir ? `Notes go to ${dir}.` : 'Notes go to your Desktop (Claude Call Notes).',
    );
  }
}

let instance = null;

/**
 * Mount the pill and panel (once per page).
 * @param {{api:(method:string, path:string, body?:any)=>Promise<any>, request?:(method:string, path:string, body?:any, opts?:{timeoutMs?:number})=>Promise<any>,
 *   hooked?:boolean, doc?:Document, win?:Window, now?:()=>number}} opts
 * @returns {{open:()=>void, close:()=>void, refresh:()=>Promise<void>, handleEvent:(type:string, data:any)=>void,
 *   setHooked:(on:boolean)=>void, destroy:()=>void, isOpen:()=>boolean, panel:CallsPanel}}
 */
export function mount(opts = {}) {
  if (instance) return instance;
  const panel = new CallsPanel(opts);
  panel.start();
  instance = {
    panel,
    open: () => panel.open(),
    close: () => panel.close(),
    refresh: () => panel.refresh(),
    handleEvent: (type, data) => panel.handleEvent(type, data),
    setHooked: (on) => panel.setHooked(on),
    isOpen: () => panel.isOpen,
    destroy: () => {
      panel.destroy();
      instance = null;
    },
  };
  return instance;
}
