/**
 * Claude Anywhere dialog: connects to the daemon's SSE stream, renders the
 * transcript, tool timeline, approval and question cards, and drives the
 * composer, voice, project switcher and settings.
 */

import { renderMarkdown } from './markdown.js';
import { createVoice, parseVoiceIntent, getBrowserVoices } from './voice.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const EVENT_TYPES = [
  'snapshot', 'status', 'message', 'delta', 'tool_update', 'approval_request', 'approval_resolved', 'question',
  'question_resolved', 'notify', 'result', 'screenshot', 'project', 'session', 'config', 'mode', 'bridge', 'show',
];
// 'queued': bridge commands wait for a terminal; Stop and Esc drop them (POST /api/interrupt).
const BUSY = new Set(['starting', 'thinking', 'acting', 'waiting_approval', 'waiting_answer', 'stopping', 'queued']);
const MAX_ITEMS = 600;
// Tool rows that keep their screenshot (matches the daemon's transcript policy).
const MAX_IMAGES_IN_TRANSCRIPT = 12;
const MAX_IMAGE_CHARS_IN_TRANSCRIPT = 8 * 1024 * 1024; // same caps as the daemon's transcript
// A card that has just taken focus ignores Enter/Esc for this long, so a key meant for
// whatever had focus before (or a held one) can't answer it unseen.
const CARD_ARM_MS = 600;
const DETAIL_LIMIT = 4096;
const IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,/;
const IS_MAC = /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '');
const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+';
const RISK_LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk', critical: 'Critical' };
const PERM_HELP = {
  ask: 'Claude asks before anything that changes your computer. Only read-only actions run on their own.',
  smart: 'File edits, screen actions and everyday commands run on their own. Deploys, deletes, installs, sudo, force-pushes and anything touching secrets ask first.',
  auto: 'Autopilot: everything runs without asking except catastrophic commands. Use only when you trust the task.',
};
const SUGGESTIONS = [
  { icon: 'screen', text: "What's on my screen?" },
  { icon: 'web', text: 'Deploy this repo to Cloud Run' },
  { icon: 'file', text: 'Open the failing test in VS Code and fix it' },
  { icon: 'eye', text: 'Summarize the page in my browser' },
  { icon: 'folder', text: 'Clean up my Downloads folder' },
];

// ------------------------------------------------------------------ small helpers

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try {
      const v = window.localStorage.getItem(`anywhere.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(`anywhere.${key}`, JSON.stringify(value));
    } catch {
      /* private mode or blocked storage */
    }
  },
};

/**
 * Create an element. Props: class, text, dataset, on<event> handlers, and
 * plain attributes (null/false skipped, true → empty attribute).
 */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  use.setAttributeNS(XLINK_NS, 'xlink:href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function setIcon(useEl, name) {
  useEl.setAttribute('href', `#i-${name}`);
  useEl.setAttributeNS(XLINK_NS, 'xlink:href', `#i-${name}`);
}

function truncate(s, n) {
  const str = s == null ? '' : String(s);
  return str.length > n ? `${str.slice(0, n)}\n… (${(str.length - n).toLocaleString()} more characters)` : str;
}

function prettyJson(value, limit = DETAIL_LIMIT) {
  if (value == null) return '';
  if (typeof value === 'string') return truncate(value, limit);
  let s;
  try {
    s = JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  return truncate(s, limit);
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function relTime(ts) {
  const d = new Date(ts).getTime();
  if (!Number.isFinite(d)) return '';
  const s = Math.max(0, Math.round((Date.now() - d) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return fmtTime(ts);
}

function fmtCost(usd) {
  const n = Number(usd) || 0;
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function getPath(obj, key) {
  return key.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function basename(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

/** Only raster data: URLs are shown (never SVG, never remote URLs). */
function safeImage(src) {
  return typeof src === 'string' && src.length < 40 * 1024 * 1024 && IMAGE_RE.test(src.slice(0, 40)) ? src : null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0', 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// ------------------------------------------------------------------ state

const state = {
  token: '',
  themeOverride: null,
  connected: false,
  everConnected: false,
  authFailed: false,
  version: '',
  mode: 'companion',
  status: 'offline',
  statusDetail: '',
  project: null,
  session: { id: null, model: null, costUsd: 0, turns: 0 },
  config: null,
  voiceInfo: {},
  bridge: { listening: false },
  platform: {},
  screenshot: null,
  items: new Map(),
  order: [],
  toolIds: new Map(),
  expanded: new Set(),
  approvals: new Map(),
  questions: new Map(),
  includeScreen: false,
  includeScreenStored: false,
  attachments: [],
  history: [],
  histIdx: -1,
  histDraft: '',
  sending: false,
  lastSentAt: 0,
  // The daemon was found down (diagnose) or quit from this window: keep saying so instead
  // of "Reconnecting…" on every retry.
  offlineDiagnosed: false,
  shutDown: false,
  // Settings drawer: the config and mode the form was filled from, and the keys edited since.
  formBase: null,
  formDirty: new Set(),
  // context.attachScreenshotByDefault as last seen; a change resets the "Include screen" chip.
  lastAttachDefault: undefined,
  voicePhase: 'idle',
  voiceMode: null,
  speaking: false,
  interim: '',
  handsFreeStarted: false,
  lastHandsFree: undefined,
  lastAlwaysOnTop: undefined,
};

const el = {};
const nodes = new Map();
const cardNodes = new Map();

// ------------------------------------------------------------------ token, theme, API

function rememberToken(token) {
  state.token = token;
  try {
    window.sessionStorage.setItem('anywhere.token', token);
  } catch {
    /* storage blocked: keep it in memory */
  }
}

function storedToken() {
  try {
    return window.sessionStorage.getItem('anywhere.token') || '';
  } catch {
    return '';
  }
}

/**
 * Trade a single-use launch code (?launch=, minted by the daemon for browser command lines)
 * for the token. No auth header: the code is the credential.
 * @returns {Promise<string>} the token, or '' when the exchange failed
 */
async function exchangeLaunchCode(code) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) return '';
    const data = await res.json().catch(() => ({}));
    return data && typeof data.token === 'string' ? data.token : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read theme and credentials from the URL. Synchronous up to the launch-code exchange, so
 * the theme is set before the caller's first render; the returned promise settles once
 * state.token is final (always resolves).
 * @returns {Promise<void>}
 */
async function initFromUrl() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    params = new URLSearchParams();
  }
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') state.themeOverride = theme;
  const fromUrl = params.get('token');
  const launch = params.get('launch');
  if (fromUrl || launch) {
    // Keep credentials out of the address bar (and out of history and bookmarks).
    params.delete('token');
    params.delete('launch');
    const qs = params.toString();
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
    } catch {
      /* file:// or sandboxed */
    }
  }
  if (fromUrl) {
    rememberToken(fromUrl);
    return;
  }
  state.token = storedToken();
  if (launch) {
    // A failed exchange (used or expired code, e.g. on reload) keeps the stored token.
    const token = await exchangeLaunchCode(launch);
    if (token) rememberToken(token);
  }
}

function applyTheme(preview) {
  const t = preview || state.themeOverride || (state.config && state.config.ui && state.config.ui.theme) || 'system';
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}

/**
 * Call the daemon API with the Bearer token.
 * @param {string} method
 * @param {string} path
 * @param {*} [body] JSON-serializable object, or a Blob/ArrayBuffer sent raw
 * @param {{timeoutMs?:number, contentType?:string}} [opts]
 */
async function api(method, path, body, { timeoutMs = 30000, contentType } = {}) {
  const headers = { Authorization: `Bearer ${state.token}` };
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    payload = body;
    headers['Content-Type'] = contentType || (body instanceof Blob && body.type) || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, signal: ctrl.signal, cache: 'no-store', credentials: 'same-origin' });
  } catch (err) {
    const timedOut = Boolean(err && err.name === 'AbortError');
    const e = new Error(timedOut ? 'The request timed out.' : "Can't reach Claude Anywhere. Is it still running?");
    e.status = 0;
    e.network = true;
    if (timedOut) e.timeout = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) };
    }
  }
  if (!res.ok) {
    const e = new Error((data && data.error) || `Request failed (HTTP ${res.status})`);
    e.status = res.status;
    if (data && data.hint) e.hint = data.hint;
    if (data && data.code) e.code = data.code;
    if (res.status === 401) onUnauthorized();
    throw e;
  }
  return data;
}

// ------------------------------------------------------------------ visibility

/** This page load's id for POST /api/ui/visibility (several dialog pages can be connected). */
const PAGE_ID = (() => {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  } catch {
    /* not a secure context */
  }
  return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
})();

/** Tell the daemon whether this page can be seen (after a 'show' event, and when that changes). */
function reportVisibility() {
  if (!state.token) return;
  let focused = false;
  try {
    focused = document.hasFocus();
  } catch {
    /* ignore */
  }
  // An older daemon has no such route: it keeps trusting the connection.
  api('POST', '/api/ui/visibility', { page: PAGE_ID, visible: !document.hidden, focused }, { timeoutMs: 5000 }).catch(() => {});
}

// ------------------------------------------------------------------ connection

let es = null;
let retryTimer = 0;
let retryDelay = 1000;
let slowTimer = 0;

function clearSlowTimer() {
  clearTimeout(slowTimer);
  slowTimer = 0;
}

function closeEvents() {
  if (!es) return;
  try {
    es.close();
  } catch {
    /* ignore */
  }
  es = null;
}

function connect() {
  clearTimeout(retryTimer);
  closeEvents();
  if (state.shutDown) return;
  if (!state.token) {
    showBanner('This window has no access key. Open the dialog with /anywhere in Claude Code, or run “anywhere url” and open the link it prints.', 'error', false);
    markOffline();
    return;
  }
  state.authFailed = false;
  let source;
  try {
    source = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}&client=ui`);
  } catch {
    scheduleReconnect();
    return;
  }
  es = source;
  source.onopen = () => {
    if (es !== source) return;
    retryDelay = 1000;
    clearSlowTimer();
    state.connected = true;
    state.everConnected = true;
    state.offlineDiagnosed = false;
    hideBanner();
  };
  source.onerror = (ev) => {
    if (es !== source) return;
    // A server-sent `event: error` arrives here too, as a MessageEvent with data.
    if (ev && typeof ev.data === 'string') {
      dispatch('error', ev.data);
      return;
    }
    const wasConnected = state.connected;
    state.connected = false;
    markOffline();
    if (source.readyState === 2) {
      es = null;
      diagnose(false);
    } else {
      // Once diagnose() has said the daemon is down, keep that banner (and its Retry button).
      if (!state.offlineDiagnosed) showBanner('Reconnecting to Claude Anywhere…', 'warning', false);
      // The browser retries every ~2 s and each failed retry lands here: only arm the check
      // once, or a retry interval shorter than the delay would keep pushing it back forever.
      if (!slowTimer) {
        slowTimer = setTimeout(() => {
          slowTimer = 0;
          if (!state.connected) diagnose(true);
        }, wasConnected ? 6000 : 3000);
      }
    }
  };
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (ev) => {
      if (es === source) dispatch(type, ev.data);
    });
  }
}

function scheduleReconnect(delay) {
  clearTimeout(retryTimer);
  const d = delay == null ? retryDelay : delay;
  retryTimer = setTimeout(connect, d);
  retryDelay = Math.min(10000, Math.round(retryDelay * 1.7));
}

async function diagnose(sourceStillRetrying) {
  let healthy = false;
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    healthy = r.ok;
  } catch {
    healthy = false;
  }
  if (state.connected || state.shutDown || state.authFailed) return;
  if (!healthy) {
    state.offlineDiagnosed = true;
    showBanner('Claude Anywhere isn’t running. Run /anywhere in Claude Code (or “anywhere start”); this window reconnects on its own.', 'error', true);
    if (!sourceStillRetrying) scheduleReconnect();
    return;
  }
  state.offlineDiagnosed = false;
  try {
    await api('GET', '/api/config', undefined, { timeoutMs: 5000 });
    if (!sourceStillRetrying) scheduleReconnect(300);
  } catch (err) {
    if (err.status === 401) return;
    if (!sourceStillRetrying) scheduleReconnect();
  }
}

function onUnauthorized() {
  if (state.authFailed) return;
  state.authFailed = true;
  clearTimeout(retryTimer);
  clearSlowTimer();
  closeEvents();
  state.connected = false;
  markOffline();
  let standalone = false;
  try {
    standalone = Boolean(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  } catch {
    standalone = false;
  }
  if (standalone) {
    // An app window (--app) of a daemon that is gone: the new daemon opens its own window, so
    // close this one rather than leave a dead duplicate behind.
    showBanner('This window’s access key was rejected because Claude Anywhere restarted. This window closes in a moment; run “anywhere show” or /anywhere if no new one appears.', 'error', false);
    setTimeout(() => {
      try {
        window.close();
      } catch {
        /* the browser keeps it */
      }
    }, 4000);
    return;
  }
  showBanner('This window’s access key was rejected, probably because Claude Anywhere restarted. Run “anywhere show” or /anywhere to open a fresh window.', 'error', true);
}

function markOffline() {
  renderStatus();
  renderComposerButtons();
  renderTyping();
}

function showBanner(text, kind = 'warning', retry = false) {
  el.bannerText.textContent = text;
  el.banner.dataset.kind = kind;
  el.bannerRetry.hidden = !retry;
  el.banner.hidden = false;
}

function hideBanner() {
  el.banner.hidden = true;
}

function dispatch(type, raw) {
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
  }
  const fn = handlers[type];
  if (!fn) return;
  try {
    fn(data || {});
  } catch (err) {
    console.error(`Failed to handle "${type}" event`, err);
  }
}

const handlers = {
  snapshot: applySnapshot,
  status(d) {
    state.status = d.status || 'idle';
    state.statusDetail = d.detail || '';
    renderStatus();
    renderComposerButtons();
    renderTyping();
  },
  message: upsertMessage,
  delta: applyDelta,
  tool_update: applyToolUpdate,
  approval_request: addApproval,
  approval_resolved(d) {
    removeCard(d.id, 'approval');
  },
  question: addQuestion,
  question_resolved(d) {
    removeCard(d.id, 'question');
    if (d.timeout) toast('A question from Claude timed out.', 'warning');
  },
  notify: onNotify,
  result: onResult,
  screenshot(d) {
    state.screenshot = d && d.dataUrl ? d : null;
    renderView();
  },
  project(d) {
    state.project = d;
    renderProject();
    renderEmpty();
  },
  session(d) {
    state.session = { ...state.session, ...d };
    renderFooter();
  },
  config(d) {
    state.config = d;
    applyConfig();
  },
  mode(d) {
    state.mode = d.mode || state.mode;
    renderMode();
    renderComposerButtons();
    refreshOpenSettings();
  },
  bridge(d) {
    state.bridge = { ...state.bridge, ...d };
    renderMode();
  },
  show() {
    try {
      window.focus();
    } catch {
      /* ignore */
    }
    // The daemon waits for this to tell a dialog in front from a minimized or hidden one, which
    // window.focus() cannot bring back (it then opens a window).
    reportVisibility();
    focusInput();
    if (!document.hidden) speaker.claim();
  },
  error(d) {
    toast(d.message || 'Something went wrong.', 'error');
  },
};

// ------------------------------------------------------------------ snapshot

function applySnapshot(s) {
  state.version = s.version || '';
  state.mode = s.mode || 'companion';
  state.status = s.status || 'idle';
  state.statusDetail = s.statusDetail || '';
  state.project = s.project || null;
  state.session = { id: null, model: null, costUsd: 0, turns: 0, ...(s.session || {}) };
  state.config = s.config || state.config;
  state.voiceInfo = s.voice || {};
  state.bridge = s.bridge || { listening: false };
  state.platform = s.platform || {};
  state.screenshot = s.screenshot && s.screenshot.dataUrl ? s.screenshot : null;
  state.items.clear();
  state.order = [];
  state.toolIds.clear();
  for (const m of Array.isArray(s.messages) ? s.messages : []) storeItem(m);
  trimItems();
  trimImages(false);
  state.approvals.clear();
  state.questions.clear();
  const pending = s.pending || {};
  for (const a of Array.isArray(pending.approvals) ? pending.approvals : []) if (a && a.id) state.approvals.set(a.id, a);
  for (const q of Array.isArray(pending.questions) ? pending.questions : []) if (q && q.id) state.questions.set(q.id, q);

  applyConfig();
  renderStatus();
  renderProject();
  renderMode();
  renderFooter();
  renderView();
  // Snapshots also come mid-session (reconnects, settings changes): keep a reader's place.
  const follow = following();
  renderTranscript(follow);
  renderCards();
  renderComposerButtons();
  if (follow) scrollToBottom();
  else el.jump.hidden = false;
  maybeStartHandsFree();
}

// ------------------------------------------------------------------ transcript

function storeItem(item) {
  if (!item || !item.id) return null;
  const prev = state.items.get(item.id);
  const next = prev ? { ...prev, ...item } : { ...item };
  if (!prev) state.order.push(item.id);
  state.items.set(item.id, next);
  if (next.role === 'tool' && next.toolUseId) state.toolIds.set(next.toolUseId, next.id);
  return next;
}

function trimItems() {
  while (state.order.length > MAX_ITEMS) {
    const id = state.order.shift();
    const it = state.items.get(id);
    state.items.delete(id);
    if (it && it.toolUseId) state.toolIds.delete(it.toolUseId);
    state.expanded.delete(id);
    const n = nodes.get(id);
    if (n) n.remove();
    nodes.delete(id);
  }
}

/**
 * Keep screenshots only on the newest tool rows, like the daemon's transcript
 * (each one is a large data: URL held in memory and decoded in the DOM).
 * @param {boolean} [render] re-render the rows that lose their image
 */
function trimImages(render = true) {
  let kept = 0;
  let chars = 0;
  for (let i = state.order.length - 1; i >= 0; i -= 1) {
    const id = state.order[i];
    const it = state.items.get(id);
    if (!it || it.role !== 'tool' || !it.image) continue;
    const len = String(it.image).length;
    // By count and by total size, like the daemon (the newest image always stays).
    if (kept === 0 || (kept < MAX_IMAGES_IN_TRANSCRIPT && chars + len <= MAX_IMAGE_CHARS_IN_TRANSCRIPT)) {
      kept += 1;
      chars += len;
      continue;
    }
    it.image = null;
    const n = render ? nodes.get(id) : null;
    const fresh = n ? buildItem(it) : null;
    if (fresh) {
      n.replaceWith(fresh);
      nodes.set(id, fresh);
    }
  }
}

// True while the transcript should follow new content (the user hasn't scrolled up).
let pinned = true;

function isNearBottom() {
  const l = el.log;
  return l.scrollHeight - l.scrollTop - l.clientHeight < 96;
}

function following() {
  return pinned || isNearBottom();
}

function scrollToBottom() {
  el.log.scrollTop = el.log.scrollHeight;
  el.jump.hidden = true;
  pinned = true;
}

function afterChange(wasNear) {
  if (wasNear) scrollToBottom();
  else el.jump.hidden = false;
}

function watchImages(node, wasNear) {
  if (!wasNear) return;
  for (const img of node.querySelectorAll('img')) {
    if (!img.complete) {
      img.addEventListener(
        'load',
        () => {
          if (pinned) scrollToBottom();
        },
        { once: true }
      );
    }
  }
}

function renderTranscript(follow = true) {
  nodes.clear();
  const frag = document.createDocumentFragment();
  for (const id of state.order) {
    const n = buildItem(state.items.get(id));
    if (!n) continue;
    nodes.set(id, n);
    frag.append(n);
  }
  el.items.replaceChildren(frag);
  renderEmpty();
  renderTyping();
  watchImages(el.items, follow);
}

function upsertMessage(item) {
  if (!item || !item.id) return;
  const wasNear = following();
  const existed = nodes.has(item.id);
  const stored = storeItem(item);
  const node = buildItem(stored);
  if (!node) return;
  if (existed) nodes.get(item.id).replaceWith(node);
  else el.items.append(node);
  nodes.set(item.id, node);
  trimItems();
  if (stored.role === 'tool' && stored.image) trimImages();
  renderEmpty();
  renderTyping();
  watchImages(node, wasNear);
  afterChange(wasNear);
}

const pendingRenders = new Set();
let rafId = 0;

function scheduleRender(id) {
  pendingRenders.add(id);
  if (rafId) return;
  const run = () => {
    rafId = 0;
    const wasNear = following();
    for (const pid of pendingRenders) renderAssistantBody(pid);
    pendingRenders.clear();
    afterChange(wasNear);
  };
  rafId = document.hidden ? setTimeout(run, 250) : requestAnimationFrame(run);
}

function applyDelta(d) {
  if (!d || !d.id || typeof d.text !== 'string') return;
  let item = state.items.get(d.id);
  if (!item) {
    upsertMessage({ id: d.id, role: 'assistant', text: '', ts: new Date().toISOString(), streaming: true });
    item = state.items.get(d.id);
  }
  item.text = (item.text || '') + d.text;
  item.streaming = true;
  scheduleRender(d.id);
  renderTyping();
}

function renderAssistantBody(id) {
  const item = state.items.get(id);
  const node = nodes.get(id);
  if (!item || !node) return;
  const md = node.querySelector('.md');
  if (!md) return;
  md.replaceChildren(renderMarkdown(item.text || ''));
  enhanceMarkdown(md);
  node.classList.toggle('streaming', Boolean(item.streaming));
  node.setAttribute('aria-busy', item.streaming ? 'true' : 'false');
}

function applyToolUpdate(d) {
  if (!d || !d.toolUseId) return;
  const id = state.toolIds.get(d.toolUseId);
  if (!id) return;
  const patch = { id, status: d.status || 'ok' };
  if ('output' in d) patch.output = d.output;
  if ('image' in d) patch.image = d.image;
  upsertMessage(patch);
}

function buildItem(item) {
  if (!item) return null;
  switch (item.role) {
    case 'user':
      return buildUser(item);
    case 'assistant':
      return buildAssistant(item);
    case 'tool':
      return buildTool(item);
    case 'system':
      return buildNotice(item);
    default:
      return null;
  }
}

function buildUser(item) {
  const meta = [];
  if (item.source === 'voice') meta.push(h('span', null, icon('mic'), 'Voice'));
  else if (item.source === 'cli' || item.source === 'skill') meta.push(h('span', null, icon('terminal'), 'Terminal'));
  const imgs = Number(item.images) || 0;
  if (imgs > 0) meta.push(h('span', null, icon('image'), `${imgs} image${imgs === 1 ? '' : 's'}`));
  const time = fmtTime(item.ts);
  if (time) meta.push(h('span', null, time));
  return h(
    'div',
    { class: 'msg user', 'data-id': item.id },
    h('div', { class: 'bubble' }, item.text || ''),
    meta.length ? h('div', { class: 'msg-meta' }, meta) : null
  );
}

function buildAssistant(item) {
  const md = h('div', { class: 'md' });
  md.append(renderMarkdown(item.text || ''));
  enhanceMarkdown(md);
  const copyBtn = h('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': 'Copy answer', title: 'Copy' }, icon('copy'));
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(item.text || '');
    toast(ok ? 'Copied' : 'Could not copy', ok ? 'success' : 'error', { timeout: 1500 });
  });
  const speakBtn = h('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': 'Read aloud', title: 'Read aloud' }, icon('volume'));
  speakBtn.addEventListener('click', () => {
    if (voice.isSpeaking()) voice.cancelSpeech();
    else voice.speak(item.text || '');
  });
  return h(
    'div',
    {
      class: `msg assistant${item.streaming ? ' streaming' : ''}`,
      'data-id': item.id,
      'aria-busy': item.streaming ? 'true' : 'false',
      title: fmtTime(item.ts) || null,
    },
    md,
    h('div', { class: 'msg-actions' }, copyBtn, speakBtn)
  );
}

function buildNotice(item) {
  const level = ['info', 'success', 'warning', 'error'].includes(item.level) ? item.level : 'info';
  const ic = { info: 'info', success: 'check', warning: 'alert', error: 'alert' }[level];
  return h(
    'div',
    { class: 'notice', 'data-level': level, 'data-id': item.id, role: level === 'error' ? 'alert' : null, title: fmtTime(item.ts) || null },
    icon(ic),
    h('span', { class: 'notice-text' }, item.text || '')
  );
}

function enhanceMarkdown(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement && pre.parentElement.classList.contains('codeblock')) continue;
    const lang = pre.getAttribute('data-lang') || '';
    const label = h('span', null, 'Copy');
    const btn = h('button', { type: 'button', class: 'copy-btn', 'aria-label': 'Copy code' }, icon('copy'), label);
    btn.addEventListener('click', async () => {
      const ok = await copyText(pre.textContent || '');
      btn.classList.toggle('copied', ok);
      label.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(() => {
        btn.classList.remove('copied');
        label.textContent = 'Copy';
      }, 1500);
    });
    const wrap = h('div', { class: 'codeblock' }, h('div', { class: 'codeblock-head' }, h('span', null, lang || 'code'), btn));
    pre.replaceWith(wrap);
    wrap.append(pre);
  }
}

// tool rows

function toolBase(name) {
  const n = String(name || '');
  if (n.startsWith('mcp__')) {
    const parts = n.split('__');
    return { server: parts[1] || '', tool: parts.slice(2).join('__').toLowerCase() };
  }
  return { server: '', tool: n.toLowerCase() };
}

function toolKind(name) {
  const { server, tool } = toolBase(name);
  if (/chrome|browser|playwright|puppeteer/i.test(server)) return 'web';
  if (['screenshot', 'screen_info', 'cursor_position', 'zoom', 'get_desktop_context', 'list_windows', 'focus_window'].includes(tool)) return 'screen';
  if (['click', 'mouse_move', 'drag', 'scroll', 'left_click', 'right_click', 'double_click', 'mouse_down', 'mouse_up'].includes(tool)) return 'mouse';
  if (['type_text', 'key', 'type', 'clipboard_get', 'clipboard_set', 'hotkey'].includes(tool)) return 'keyboard';
  if (['bash', 'bashoutput', 'killshell', 'killbash', 'powershell', 'shell'].includes(tool)) return 'terminal';
  if (['read', 'write', 'edit', 'multiedit', 'notebookedit', 'notebookread', 'glob', 'grep', 'ls'].includes(tool)) return 'file';
  if (['webfetch', 'websearch', 'open', 'navigate', 'fetch'].includes(tool)) return 'web';
  return 'other';
}

function toolIcon(name, kind) {
  const { tool } = toolBase(name);
  if (tool === 'list_windows' || tool === 'focus_window') return 'window';
  if (tool === 'todowrite') return 'list';
  if (tool === 'ask_user' || tool === 'askuserquestion') return 'question';
  if (tool === 'notify_user') return 'info';
  return { screen: 'screen', mouse: 'mouse', keyboard: 'keyboard', terminal: 'terminal', file: 'file', web: 'web' }[kind] || 'tool';
}

function buildTool(item) {
  const kind = toolKind(item.name);
  const status = ['running', 'ok', 'error'].includes(item.status) ? item.status : 'running';
  const expanded = state.expanded.has(item.id);
  const statusIcon = status === 'running' ? icon('spinner', 'spin') : icon(status === 'ok' ? 'check' : 'x');
  const statusText = status === 'running' ? 'Running' : status === 'ok' ? 'Done' : 'Failed';
  const head = h(
    'button',
    { type: 'button', class: 'tool-head', 'aria-expanded': String(expanded), title: item.summary ? `${item.displayName || item.name}: ${item.summary}` : null },
    h('span', { class: 'tool-icon' }, icon(toolIcon(item.name, kind))),
    h('span', { class: 'tool-text' }, h('span', { class: 'tool-name' }, item.displayName || item.name || 'Tool'), item.summary ? h('span', { class: 'tool-summary' }, item.summary) : null),
    h('span', { class: 'tool-status', role: 'img', 'aria-label': statusText }, statusIcon)
  );
  head.addEventListener('click', () => {
    if (state.expanded.has(item.id)) state.expanded.delete(item.id);
    else state.expanded.add(item.id);
    upsertMessage({ id: item.id });
    const fresh = nodes.get(item.id);
    const btn = fresh && fresh.querySelector('.tool-head');
    if (btn) btn.focus({ preventScroll: true });
  });
  const row = h('div', { class: `tool${item.parentToolUseId ? ' nested' : ''}`, 'data-id': item.id, 'data-kind': kind, 'data-status': status }, head);
  const img = safeImage(item.image);
  if (img) {
    const thumb = h('button', { type: 'button', class: 'tool-thumb', 'aria-label': 'Open screenshot' }, h('img', { src: img, alt: `Screenshot from ${item.displayName || 'a tool'}`, decoding: 'async' }));
    thumb.addEventListener('click', () => openLightbox(img, `${item.displayName || 'Screenshot'} · ${fmtTime(item.ts)}`));
    row.append(thumb);
  }
  if (expanded) row.append(buildToolBody(item, status));
  return row;
}

function buildToolBody(item, status) {
  const secs = [];
  const { tool } = toolBase(item.name);
  if (tool === 'todowrite' && item.input && Array.isArray(item.input.todos)) {
    const mark = { completed: '☑', in_progress: '◐', pending: '☐' };
    secs.push(
      h(
        'div',
        null,
        h('div', { class: 'tool-sec-label' }, 'Plan'),
        h('ul', { class: 'todo-list' }, item.input.todos.map((t) => h('li', { 'data-status': t.status || 'pending' }, h('span', { 'aria-hidden': 'true' }, mark[t.status] || '☐'), h('span', null, String(t.content || t.activeForm || '')))))
      )
    );
  } else if (item.input != null && !(typeof item.input === 'object' && !Object.keys(item.input).length)) {
    secs.push(h('div', null, h('div', { class: 'tool-sec-label' }, 'Input'), h('pre', { class: 'tool-pre' }, prettyJson(item.input))));
  }
  if (item.output) {
    secs.push(h('div', null, h('div', { class: 'tool-sec-label' }, status === 'error' ? 'Error' : 'Output'), h('pre', { class: 'tool-pre' }, truncate(item.output, DETAIL_LIMIT))));
  } else if (status === 'running') {
    secs.push(h('div', { class: 'tool-sec-label' }, 'Running…'));
  } else if (!secs.length) {
    secs.push(h('div', { class: 'tool-sec-label' }, 'No output'));
  }
  return h('div', { class: 'tool-body' }, secs);
}

function renderEmpty() {
  const empty = state.order.length === 0;
  el.empty.hidden = !empty;
  if (!empty) return;
  const name = state.project && (state.project.name || basename(state.project.dir));
  const parts = ['I can see your screen, use your apps and run commands'];
  if (name) parts.push(' in ', h('strong', null, name));
  parts.push('. Type or talk.');
  el.emptySub.replaceChildren(...parts);
}

function renderTyping() {
  const last = state.order.length ? state.items.get(state.order[state.order.length - 1]) : null;
  const streaming = last && last.role === 'assistant' && last.streaming && last.text;
  const show = state.connected && (state.status === 'thinking' || state.status === 'starting') && !streaming;
  if (el.typing.hidden === !show) return;
  const wasNear = following();
  el.typing.hidden = !show;
  if (show) afterChange(wasNear);
}

// ------------------------------------------------------------------ cards

// What each card node was built from, so a snapshot only rebuilds cards that changed.
const cardSource = new WeakMap();

function cardSignature(kind, c) {
  try {
    return `${kind}:${JSON.stringify(c)}`;
  } catch {
    return `${kind}:${c.id}:${Math.random()}`;
  }
}

/**
 * Bring the cards in line with state.approvals/questions. Cards still pending
 * keep their node, so a snapshot mid-session (a reconnect, a settings change)
 * doesn't wipe a half-typed reason or answer, or move focus.
 */
function renderCards() {
  const all = [
    ...[...state.approvals.values()].map((c) => ({ kind: 'approval', c })),
    ...[...state.questions.values()].map((c) => ({ kind: 'question', c })),
  ].sort((a, b) => String(a.c.ts || '').localeCompare(String(b.c.ts || '')));
  const active = document.activeElement;
  const hadFocus = Boolean(active && el.cards.contains(active));
  const wanted = new Set(all.map((x) => x.c.id));
  for (const [id, n] of cardNodes) {
    if (wanted.has(id)) continue;
    cardNodes.delete(id);
    n.remove();
  }
  const order = all.map(({ kind, c }) => {
    const sig = cardSignature(kind, c);
    let n = cardNodes.get(c.id);
    if (n && cardSource.get(n) !== sig) {
      const fresh = kind === 'approval' ? buildApprovalCard(c) : buildQuestionCard(c);
      n.replaceWith(fresh);
      n = fresh;
    } else if (!n) {
      n = kind === 'approval' ? buildApprovalCard(c) : buildQuestionCard(c);
    }
    cardSource.set(n, sig);
    cardNodes.set(c.id, n);
    return n;
  });
  // Moving a node drops its focus, so only touch the DOM when the order differs.
  const current = [...el.cards.children];
  if (order.length !== current.length || order.some((n, i) => current[i] !== n)) el.cards.append(...order);
  if (hadFocus && document.activeElement !== active) {
    if (active.isConnected) active.focus({ preventScroll: true });
    else if (order.length) focusCard(order[0]);
    else focusInput();
  }
  updateTimers();
}

function addApproval(card) {
  if (!card || !card.id) return;
  state.approvals.set(card.id, card);
  if (cardNodes.has(card.id)) return;
  const n = buildApprovalCard(card);
  cardSource.set(n, cardSignature('approval', card));
  cardNodes.set(card.id, n);
  el.cards.append(n);
  updateTimers();
  renderComposerButtons();
  maybeFocusCard(n);
}

function addQuestion(q) {
  if (!q || !q.id) return;
  state.questions.set(q.id, q);
  if (cardNodes.has(q.id)) return;
  const n = buildQuestionCard(q);
  cardSource.set(n, cardSignature('question', q));
  cardNodes.set(q.id, n);
  el.cards.append(n);
  renderComposerButtons();
  maybeFocusCard(n);
}

// card node → time before which Enter/Esc on the card itself are ignored
const cardArmAt = new WeakMap();

/**
 * Enter/Esc on a card count only once it has had focus for CARD_ARM_MS (from a
 * programmatic focus, a click, or the window coming back to the front), and
 * never as key repeats.
 * @returns {(e:KeyboardEvent) => boolean} true when the key must be ignored
 */
function armCard(node) {
  node.addEventListener('focus', () => cardArmAt.set(node, Date.now() + CARD_ARM_MS));
  return (e) => e.repeat || (e.target === node && Date.now() < (cardArmAt.get(node) || 0));
}

/**
 * A card takes focus from an empty composer when it arrives, so someone who starts typing
 * at that moment would type into nothing: send printable keys on the card itself back to
 * the composer (the character follows the focus).
 * @returns {boolean} true when the key was handed to the composer
 */
function typeThrough(node, e) {
  if (e.target !== node || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (typeof e.key !== 'string' || [...e.key].length !== 1 || e.key === ' ') return false;
  focusInput();
  return true;
}

/** Focus a card from code (no focus event fires while the window is in the background). */
function focusCard(node) {
  cardArmAt.set(node, Date.now() + CARD_ARM_MS);
  node.focus({ preventScroll: true });
}

function removeCard(id, kind) {
  if (kind === 'approval') state.approvals.delete(id);
  else state.questions.delete(id);
  renderComposerButtons();
  const n = cardNodes.get(id);
  if (!n) return;
  const hadFocus = n.contains(document.activeElement);
  cardNodes.delete(id);
  n.remove();
  if (hadFocus) {
    const next = el.cards.querySelector('.card');
    if (next) focusCard(next);
    else focusInput();
  }
}

/** A new card takes focus unless the user is busy elsewhere (typing, another card, a menu). */
function maybeFocusCard(node) {
  const a = document.activeElement;
  const idleComposer = a === el.input && !el.input.value.trim() && !state.attachments.length;
  if (!a || a === document.body || a === el.log || idleComposer) focusCard(node);
}

/** The card that Enter in an empty composer goes to (the oldest one, as shown first). */
function firstCardNode() {
  return el.cards.querySelector('.card');
}

function firstApproval() {
  const all = [...state.approvals.values()].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return all[0] || null;
}

function firstQuestion() {
  const all = [...state.questions.values()].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return all[0] || null;
}

function buildApprovalCard(card) {
  const risk = RISK_LABEL[card.risk] ? card.risk : 'medium';
  const reason = h('input', {
    type: 'text',
    class: 'input deny-reason',
    placeholder: 'Optional: why not, or what to do instead',
    'aria-label': 'Reason for denying',
    maxlength: '2000',
  });
  // Critical actions need a deliberate click: Enter on the card never allows them, nor does a
  // spoken "yes" (handleVoiceText).
  const allow =
    risk === 'critical'
      ? h('button', { type: 'button', class: 'btn btn-primary', title: 'Critical actions need a click to allow' }, 'Allow once')
      : h('button', { type: 'button', class: 'btn btn-primary' }, 'Allow once', h('kbd', null, '↵'));
  // "Always (session)" adds the card's session rule, shown as text so the user sees what it
  // covers. A card whose sessionRule is null (critical actions; delete, disable and IAM verbs;
  // sensitive files; edits with no path) would only be allowed once, so the button is disabled.
  const noRule = risk === 'critical' || card.sessionRule === null;
  const rule = !noRule && typeof card.sessionRule === 'string' && card.sessionRule ? card.sessionRule : null;
  const always = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      disabled: noRule,
      title:
        risk === 'critical'
          ? 'Critical actions always ask'
          : rule
            ? `Allow ${rule} for the rest of this session`
            : noRule
              ? 'This action always asks: no session rule covers it'
              : 'Allow this for the rest of this session',
    },
    'Always (session)'
  );
  const ruleNote = rule
    ? h('div', { class: 'card-rule' }, 'Always (session) allows ', h('code', null, rule), ' until the session ends.')
    : noRule && risk !== 'critical'
      ? h('div', { class: 'card-rule' }, 'This action always asks: no session rule covers it.')
      : null;
  const deny = h('button', { type: 'button', class: 'btn btn-danger' }, 'Deny', h('kbd', null, 'Esc'));
  const details = h('details', { class: 'card-details' }, h('summary', null, 'Details'), h('pre', { class: 'tool-pre' }, prettyJson(card.input, DETAIL_LIMIT)));
  const node = h(
    'section',
    { class: 'card approval', 'data-id': card.id, 'data-risk': risk, tabindex: '-1', role: 'group', 'aria-label': `Approval needed: ${card.displayName || card.toolName || 'action'}` },
    h('div', { class: 'card-head' }, icon('shield'), h('span', { class: 'risk', 'data-risk': risk }, RISK_LABEL[risk]), h('span', { class: 'card-title' }, card.displayName || card.toolName || 'Action'), h('span', { class: 'card-timer' })),
    card.summary ? h('div', { class: 'card-summary' }, card.summary) : null,
    card.reason ? h('div', { class: 'card-reason' }, card.reason) : null,
    card.input != null ? details : null,
    reason,
    h('div', { class: 'card-actions' }, allow, always, deny),
    ruleNote
  );
  const decide = (decision, via) => resolveApproval(card.id, decision, decision === 'deny' ? reason.value.trim() : '', via);
  allow.addEventListener('click', () => decide('allow', 'click'));
  always.addEventListener('click', () => decide('allow_session', 'click'));
  deny.addEventListener('click', () => decide('deny', 'click'));
  const ignoreKey = armCard(node);
  node.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (typeThrough(node, e)) return;
    if ((e.key === 'Escape' || e.key === 'Enter') && ignoreKey(e)) {
      // A held key, or one pressed for whatever had focus a moment ago: not a decision.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      decide('deny', 'key');
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      const t = e.target;
      if (t === reason) {
        e.preventDefault();
        decide('deny', 'key');
      } else if (t === node) {
        e.preventDefault();
        if (risk !== 'critical') decide('allow', 'key');
      }
    }
  });
  return node;
}

function buildQuestionCard(q) {
  const input = h('input', { type: 'text', class: 'input', placeholder: 'Type your answer…', 'aria-label': 'Your answer', maxlength: '4000' });
  const form = h('form', { class: 'q-form' }, input, h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Answer'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (t) answerQuestion(q.id, t);
  });
  const options = Array.isArray(q.options) ? q.options.filter((o) => o != null && String(o).trim()) : [];
  const md = h('div', { class: 'card-q md' });
  md.append(renderMarkdown(String(q.question || '')));
  const node = h(
    'section',
    { class: 'card question', 'data-id': q.id, tabindex: '-1', role: 'group', 'aria-label': 'Claude is asking you a question' },
    h('div', { class: 'card-head' }, icon('question'), h('span', { class: 'card-title' }, 'Claude is asking'), h('span', { class: 'card-timer' }, fmtTime(q.ts))),
    md,
    options.length ? h('div', { class: 'q-options' }, options.map((o) => h('button', { type: 'button', class: 'btn btn-sm btn-option', onclick: () => answerQuestion(q.id, String(o)) }, String(o)))) : null,
    form
  );
  const ignoreKey = armCard(node);
  node.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (typeThrough(node, e)) return;
    if ((e.key === 'Escape' || e.key === 'Enter') && ignoreKey(e)) {
      // A held Enter would otherwise focus the first option and then pick it.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      focusInput();
    } else if (e.key === 'Enter' && e.target === node && options.length) {
      e.preventDefault();
      const first = node.querySelector('.btn-option');
      if (first) first.focus();
    }
  });
  return node;
}

/**
 * @param {string} id
 * @param {'allow'|'allow_session'|'deny'} decision
 * @param {string} [message] the deny reason
 * @param {'click'|'key'|'voice'} [via] how the user decided (for the daemon's audit and policy)
 */
async function resolveApproval(id, decision, message, via) {
  const n = cardNodes.get(id);
  if (n) n.classList.add('busy');
  try {
    await api('POST', '/api/approval', { id, decision, ...(message ? { message } : {}), ...(via ? { via } : {}) });
    removeCard(id, 'approval');
  } catch (err) {
    if (n) n.classList.remove('busy');
    if (err.status === 404) {
      removeCard(id, 'approval');
      toast('That request is no longer waiting (it timed out or was cancelled).', 'warning');
    } else {
      toast(`Couldn't send your decision: ${err.message}`, 'error');
    }
  }
}

/** @returns {Promise<boolean>} whether the answer reached the waiting question */
async function answerQuestion(id, text) {
  const n = cardNodes.get(id);
  if (n) n.classList.add('busy');
  try {
    await api('POST', '/api/answer', { id, text });
    removeCard(id, 'question');
    return true;
  } catch (err) {
    if (n) n.classList.remove('busy');
    if (err.status === 404) {
      removeCard(id, 'question');
      toast('That question is no longer waiting.', 'warning');
    } else {
      toast(`Couldn't send your answer: ${err.message}`, 'error');
    }
    return false;
  }
}

function updateTimers() {
  const now = Date.now();
  for (const [id, n] of cardNodes) {
    const card = state.approvals.get(id);
    if (!card) continue;
    const t = n.querySelector('.card-timer');
    if (!t) continue;
    const start = new Date(card.ts).getTime();
    const sec = Number(card.timeoutSec);
    if (!Number.isFinite(start) || !(sec > 0)) {
      t.textContent = fmtTime(card.ts);
      continue;
    }
    const left = Math.max(0, Math.round((start + sec * 1000 - now) / 1000));
    t.textContent = left >= 3600 ? `${Math.floor(left / 3600)}h left` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
  }
}

// ------------------------------------------------------------------ header and footer

function isBusy() {
  return state.connected && BUSY.has(state.status);
}

function pillState() {
  const vp = state.voicePhase;
  if (vp === 'listening' || vp === 'starting') return ['listening', 'Listening'];
  if (vp === 'transcribing') return ['thinking', 'Transcribing'];
  if (!state.connected) return ['offline', state.authFailed || !state.token ? 'Disconnected' : state.everConnected ? 'Offline' : 'Connecting'];
  switch (state.status) {
    case 'starting':
      return ['thinking', 'Starting'];
    case 'thinking':
      return ['thinking', 'Thinking'];
    case 'acting':
      return ['acting', 'Working'];
    case 'waiting_approval':
      return ['waiting', 'Needs approval'];
    case 'waiting_answer':
      return ['waiting', 'Question'];
    case 'stopping':
      return ['waiting', 'Stopping'];
    case 'queued':
      return ['waiting', 'Queued'];
    case 'error':
      return ['error', 'Error'];
    case 'offline':
      return ['offline', 'Offline'];
    default:
      return vp === 'wake' ? ['handsfree', 'Hands-free'] : ['idle', 'Ready'];
  }
}

function wakeWordText() {
  const w = state.config && state.config.voice && state.config.voice.wakeWord;
  return w ? `“${w}”` : 'the wake word';
}

function renderStatus() {
  const [kind, label] = pillState();
  el.status.dataset.state = kind;
  el.statusLabel.textContent = label;
  let detail = '';
  if (state.voicePhase === 'wake' && !isBusy()) detail = `Say ${wakeWordText()}`;
  else if (state.voicePhase === 'listening' || state.voicePhase === 'starting') detail = state.voiceMode === 'ptt' ? 'Release to send' : 'Speak now';
  else if (state.connected) detail = state.statusDetail || '';
  el.statusDetail.textContent = detail;
  el.statusDetail.title = detail;
}

function renderProject() {
  const p = state.project || {};
  const name = p.name || basename(p.dir) || 'No project';
  el.projectName.textContent = name;
  el.projectChip.title = p.dir ? `${p.dir}\nClick to switch project` : 'Choose a project';
  const git = p.git || null;
  if (git && git.branch) {
    el.projectBranchName.textContent = git.branch;
    el.projectBranch.classList.toggle('dirty', Boolean(git.dirty));
    el.projectBranch.title = `${git.branch}${git.dirty ? ' (uncommitted changes)' : ''}`;
    el.projectBranch.hidden = false;
  } else {
    el.projectBranch.hidden = true;
  }
}

function renderMode() {
  const bridge = state.mode === 'bridge';
  const listening = Boolean(state.bridge && state.bridge.listening);
  el.modeBadge.dataset.mode = bridge ? 'bridge' : 'companion';
  el.modeBadge.dataset.listening = String(listening);
  el.modeLabel.textContent = bridge ? 'Bridge' : 'Companion';
  const tip = bridge
    ? listening
      ? 'Bridge mode: your Claude Code terminal is listening'
      : 'Bridge mode: no terminal is listening. Run “/anywhere here” in Claude Code.'
    : 'Companion mode: a dedicated Claude Code session works behind this dialog';
  el.modeBadge.title = tip;
  el.modeBadge.setAttribute('aria-label', `Working style: ${tip}`);
  el.modeNote.textContent = bridge ? (listening ? 'Terminal listening.' : 'No terminal is listening yet. Run “/anywhere here” in Claude Code.') : '';
  for (const b of el.modePop.querySelectorAll('.pop-option')) b.setAttribute('aria-current', String(b.dataset.mode === state.mode));
  renderFooter();
}

const PROVIDER_LABELS = { browser: 'Browser', off: 'Off', none: 'Unavailable', groq: 'Groq', openai: 'OpenAI', custom: 'Custom', 'whisper.cpp': 'whisper.cpp', server: 'Server', system: 'System' };

function providerLabel(name) {
  return PROVIDER_LABELS[name] || String(name || '');
}

function renderFooter() {
  // In bridge mode your Claude Code terminal does the work: the daemon knows neither its model
  // nor its cost, so the companion session's (idle) model and cost would mislead.
  const bridge = state.mode === 'bridge';
  el.sbCost.hidden = bridge;
  el.sbCostSep.hidden = bridge;
  if (bridge) {
    el.sbModel.textContent = 'Claude Code terminal';
    el.sbModel.title = 'Commands run in your Claude Code terminal; its model and cost show there';
  } else {
    const engineModel = state.config && state.config.engine && state.config.engine.model;
    const model = state.session.model || engineModel || 'Default model';
    el.sbModel.textContent = model;
    el.sbModel.title = `Model: ${model}`;
  }
  el.sbCost.textContent = fmtCost(state.session.costUsd);
  const turns = Number(state.session.turns) || 0;
  el.sbCost.title = `Cost of this session (${turns} turn${turns === 1 ? '' : 's'})`;
  let p = { stt: 'none', tts: 'none', sttName: 'none', ttsName: 'none' };
  try {
    p = voice.provider();
  } catch {
    /* voice not ready */
  }
  el.sbStt.textContent = providerLabel(p.sttName);
  el.sbTts.textContent = providerLabel(p.ttsName);
  const vi = state.voiceInfo || {};
  el.sbVoice.title = `Speech input: ${providerLabel(p.sttName)}${vi.sttHint && p.stt !== 'browser' ? ` (${vi.sttHint})` : ''}\nSpeech output: ${providerLabel(p.ttsName)}`;
}

// ------------------------------------------------------------------ Claude's view and lightbox

function renderView() {
  const shot = state.screenshot;
  const src = shot ? safeImage(shot.dataUrl) : null;
  if (!src) {
    el.view.hidden = true;
    return;
  }
  el.view.hidden = false;
  const open = store.get('viewOpen', false) === true;
  el.viewToggle.setAttribute('aria-expanded', String(open));
  el.viewBody.hidden = !open;
  if (el.viewImg.getAttribute('src') !== src) el.viewImg.setAttribute('src', src);
  el.viewTime.textContent = relTime(shot.ts);
  el.viewTime.title = shot.ts ? new Date(shot.ts).toLocaleString() : '';
}

let lightboxReturn = null;

function openLightbox(src, caption) {
  const s = safeImage(src);
  if (!s) return;
  lightboxReturn = document.activeElement;
  el.lightboxImg.src = s;
  el.lightboxImg.alt = caption || 'Screenshot';
  el.lightboxCaption.textContent = caption || '';
  el.lightbox.hidden = false;
  el.lightboxClose.focus();
}

function closeLightbox() {
  el.lightbox.hidden = true;
  el.lightboxImg.removeAttribute('src');
  if (lightboxReturn && lightboxReturn.focus) lightboxReturn.focus();
  lightboxReturn = null;
}

// ------------------------------------------------------------------ toasts

function toast(message, level = 'info', { timeout } = {}) {
  const ic = { info: 'info', success: 'check', warning: 'alert', error: 'alert' }[level] || 'info';
  const close = h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss' }, icon('x'));
  const t = h('div', { class: 'toast', 'data-level': level, role: level === 'error' ? 'alert' : 'status' }, icon(ic), h('span', { class: 'toast-text' }, message), close);
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 220);
  };
  close.addEventListener('click', dismiss);
  el.toasts.append(t);
  while (el.toasts.children.length > 3) el.toasts.firstElementChild.remove();
  setTimeout(dismiss, timeout || (level === 'error' ? 9000 : level === 'warning' ? 6000 : 3500));
}

// ------------------------------------------------------------------ popovers

let openPop = null;

function placePopover(pop, anchor, align) {
  const r = anchor.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 24);
  pop.style.top = `${Math.round(r.bottom + 6)}px`;
  let left = align === 'right' ? r.right - width : r.left;
  left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
  pop.style.left = `${Math.round(left)}px`;
}

function openPopover(pop, anchor, align) {
  closePopover(false);
  openPop = { pop, anchor };
  pop.hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  placePopover(pop, anchor, align);
}

function closePopover(returnFocus) {
  if (!openPop) return;
  const { pop, anchor } = openPop;
  openPop = null;
  pop.hidden = true;
  anchor.setAttribute('aria-expanded', 'false');
  if (returnFocus) anchor.focus();
}

async function openProjects() {
  if (openPop && openPop.pop === el.projectPop) {
    closePopover(true);
    return;
  }
  openPopover(el.projectPop, el.projectChip, 'left');
  el.projectList.replaceChildren(h('div', { class: 'pop-empty' }, 'Looking for projects…'));
  el.projectPath.value = '';
  try {
    const res = await api('GET', '/api/projects', undefined, { timeoutMs: 15000 });
    const list = Array.isArray(res.projects) ? res.projects : [];
    if (!openPop || openPop.pop !== el.projectPop) return;
    if (!list.length) {
      el.projectList.replaceChildren(h('div', { class: 'pop-empty' }, 'No other projects found. Type a folder path below.'));
    } else {
      const current = state.project && state.project.dir;
      const sourceLabel = { vscode: 'VS Code', recent: 'Recent', cwd: 'Current', cursor: 'Cursor' };
      el.projectList.replaceChildren(
        ...list.map((p) => {
          const isCurrent = Boolean(p.current) || p.dir === current;
          const item = h(
            'button',
            { type: 'button', class: 'pop-item', role: 'option', 'aria-selected': String(isCurrent), title: p.dir },
            icon('folder'),
            h('span', { class: 'pop-item-text' }, h('span', { class: 'pop-item-name' }, p.name || basename(p.dir)), h('span', { class: 'pop-item-dir' }, h('bdi', null, p.dir))),
            p.source && sourceLabel[p.source] ? h('span', { class: 'pop-tag' }, sourceLabel[p.source]) : null,
            isCurrent ? icon('check', 'check') : null
          );
          item.addEventListener('click', () => {
            if (isCurrent) closePopover(true);
            else switchProject(p.dir);
          });
          return item;
        })
      );
    }
    const first = el.projectList.querySelector('.pop-item');
    if (first) first.focus();
    else el.projectPath.focus();
  } catch (err) {
    if (!openPop || openPop.pop !== el.projectPop) return;
    el.projectList.replaceChildren(h('div', { class: 'pop-empty' }, `Couldn't list projects: ${err.message}`));
    el.projectPath.focus();
  }
}

/**
 * Bridge commands that only wait for a terminal (none is listening, none took a command, no
 * card is open): nothing runs, so a switch drops them (a mode switch moves them to the dialog's
 * own session). @returns {number} how many (0: not that state)
 */
function waitingForTerminal() {
  if (state.mode !== 'bridge' || state.status !== 'queued') return 0;
  const b = state.bridge || {};
  if (b.listening || state.approvals.size || state.questions.size) return 0;
  return Math.max(1, Number(b.queued) || 0);
}

/**
 * POST a project or mode switch. The daemon refuses one that would stop a running task (409):
 * ask first, then retry with force. Resolves null when the user keeps the task.
 */
async function postSwitch(path, body, opts) {
  try {
    return await api('POST', path, body, opts);
  } catch (err) {
    if (!err || err.status !== 409) throw err;
    const what = path === '/api/project' ? 'switch the project' : 'change the mode';
    const n = waitingForTerminal();
    const ask = n
      ? `${n === 1 ? 'A command is' : `${n} commands are`} waiting for a Claude Code terminal (none is listening). ${path === '/api/project' ? `Switching the project drops ${n === 1 ? 'it' : 'them'}` : `Changing the mode moves ${n === 1 ? 'it' : 'them'} to the dialog's own session, or drops ${n === 1 ? 'it' : 'them'}`}. ${what[0].toUpperCase()}${what.slice(1)} anyway?`
      : `A task is running. Stop it and ${what}?`;
    if (!window.confirm(ask)) return null;
    return api('POST', path, { ...body, force: true }, opts);
  }
}

async function switchProject(dir) {
  const d = String(dir || '').trim();
  if (!d) return;
  closePopover(true);
  try {
    const res = await postSwitch('/api/project', { dir: d }, { timeoutMs: 30000 });
    if (!res) return;
    const p = (res && res.project) || {};
    toast(`Switched to ${p.name || basename(d)}`, 'success');
  } catch (err) {
    toast(`Couldn't switch project: ${err.message}`, 'error');
  }
}

async function setMode(mode) {
  closePopover(true);
  if (mode === state.mode) return;
  try {
    const res = await postSwitch('/api/mode', { mode });
    if (!res) return;
    state.mode = mode;
    renderMode();
    // Bridge commands that waited for a terminal now run in the dialog's own session.
    const moved = Number(res.moved) > 0 ? Number(res.moved) : 0;
    const movedNote = moved ? `: ${moved === 1 ? 'the waiting command runs' : `the ${moved} waiting commands run`} here now` : '';
    toast(mode === 'bridge' ? 'Bridge mode: commands go to your Claude Code terminal' : `Companion mode${movedNote}`, 'success');
  } catch (err) {
    toast(`Couldn't change mode: ${err.message}`, 'error');
  }
}

// ------------------------------------------------------------------ settings drawer

let drawerReturn = null;

function settingsFields() {
  return [...el.settingsForm.querySelectorAll('[data-key]')];
}

function populateVoices(selected) {
  const voices = getBrowserVoices();
  const lang = String((state.config && state.config.voice && state.config.voice.language) || navigator.language || 'en').toLowerCase();
  const prefix = lang.split('-')[0];
  const sorted = [...voices].sort((a, b) => {
    const ra = a.lang && a.lang.toLowerCase().startsWith(prefix) ? 0 : 1;
    const rb = b.lang && b.lang.toLowerCase().startsWith(prefix) ? 0 : 1;
    return ra - rb || String(a.name).localeCompare(String(b.name));
  });
  const opts = [h('option', { value: '' }, voices.length ? 'System default' : 'System default (no browser voices found)')];
  for (const v of sorted) opts.push(h('option', { value: v.name }, `${v.name} (${v.lang || '?'})${v.localService === false ? ' · online' : ''}`));
  if (selected && !voices.some((v) => v.name === selected)) opts.push(h('option', { value: selected }, `${selected} (not in this browser)`));
  el.ttsVoice.replaceChildren(...opts);
  el.ttsVoice.value = selected || '';
}

/**
 * Fill the form from state.config and state.mode, and remember them as the baseline that
 * collectSettings compares against.
 * @param {{keepEdits?:boolean}} [opts] keepEdits: the drawer is open and the config changed
 *   elsewhere; refresh only the fields the user hasn't edited
 */
function populateSettings({ keepEdits = false } = {}) {
  const cfg = state.config || {};
  if (!keepEdits) state.formDirty.clear();
  for (const input of settingsFields()) {
    const key = input.dataset.key;
    if (keepEdits && state.formDirty.has(key)) continue;
    const val = key === 'mode' ? state.mode : getPath(cfg, key);
    if (input.type === 'checkbox') input.checked = Boolean(val);
    else if (input.type === 'radio') input.checked = String(val) === input.value;
    else if (input === el.sttKey) {
      input.value = '';
      input.placeholder = cfg.voice && cfg.voice.sttApiKeySet ? '•••• set (type to replace)' : 'Not set';
    } else if (input === el.ttsVoice) populateVoices(val || '');
    else if (input.type === 'range') input.value = String(val == null ? 1 : val);
    else input.value = val == null ? '' : String(val);
  }
  let base;
  try {
    base = JSON.parse(JSON.stringify(cfg));
  } catch {
    base = {};
  }
  state.formBase = { config: base, mode: state.mode };
  updateSettingsHelp();
  renderAbout();
}

/** The config changed (here or elsewhere) while the drawer is open: keep the user's edits. */
function refreshOpenSettings() {
  if (el.drawer.hidden) return;
  populateSettings({ keepEdits: true });
  const theme = el.settingsForm.querySelector('input[name="ui.theme"]:checked');
  if (theme && state.formDirty.has('ui.theme')) applyTheme(theme.value);
}

function updateSettingsHelp() {
  const checked = el.settingsForm.querySelector('input[name="permissions.mode"]:checked');
  el.permHelp.textContent = PERM_HELP[checked ? checked.value : 'smart'] || '';
  el.rateOut.textContent = `${Number(el.ttsRate.value || 1).toFixed(1)}×`;
}

function renderAbout() {
  const vi = state.voiceInfo || {};
  const pf = state.platform || {};
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rows = [
    ['Version', state.version || '?'],
    ['Platform', [pf.platform, pf.displayServer, pf.driver].filter(Boolean).join(' · ') || '?'],
    ['Session', state.session.id ? String(state.session.id).slice(0, 8) : 'not started'],
    ['Browser speech', SR ? 'available' : 'not available in this window'],
    ['Server speech-to-text', vi.serverStt ? providerLabel(vi.sttProvider) : vi.sttHint || 'not configured'],
    ['Server text-to-speech', vi.serverTts ? providerLabel(vi.ttsProvider) : vi.ttsHint || 'not available'],
  ];
  el.about.replaceChildren(h('dl', null, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  const diag = [];
  if (!SR && !vi.serverStt) diag.push('Voice input needs Chrome, Edge or Safari, or a server transcription provider (a Groq or OpenAI key, or whisper.cpp).');
  el.voiceDiag.textContent = diag.join(' ');
}

function openSettings() {
  closePopover(false);
  drawerReturn = document.activeElement;
  populateSettings();
  el.drawerBackdrop.hidden = false;
  el.drawer.hidden = false;
  el.openSettings.setAttribute('aria-expanded', 'true');
  // A selector list matches in document order (the close button comes first): ask in order of preference.
  const first = el.settingsForm.querySelector('input:checked') || el.settingsForm.querySelector('input, select, button') || el.closeSettings;
  first.focus();
}

function closeSettings(returnFocus) {
  if (el.drawer.hidden) return;
  el.drawer.hidden = true;
  el.drawerBackdrop.hidden = true;
  el.openSettings.setAttribute('aria-expanded', 'false');
  applyTheme();
  if (returnFocus && drawerReturn && drawerReturn.focus) drawerReturn.focus();
  drawerReturn = null;
}

/**
 * The settings the user changed: each field is compared with the values the form was filled
 * from (state.formBase), not the live config, so a change made elsewhere while the drawer
 * was open isn't sent back with its old value.
 */
function collectSettings() {
  const base = state.formBase || { config: state.config || {}, mode: state.mode };
  const cfg = base.config || {};
  const partial = {};
  let mode = null;
  for (const input of settingsFields()) {
    const key = input.dataset.key;
    let val;
    if (input.type === 'checkbox') val = input.checked;
    else if (input.type === 'radio') {
      if (!input.checked) continue;
      val = input.value;
    } else if (input.type === 'number' || input.type === 'range') {
      if (input.value === '') continue;
      val = Number(input.value);
      if (!Number.isFinite(val) || val < 0) throw new Error(`${fieldName(input)} must be a number of zero or more.`);
    } else val = input.value.trim();
    if (key === 'voice.sttApiKey') {
      if (val) setPath(partial, key, val);
      continue;
    }
    if (key === 'mode') {
      if (val !== base.mode) mode = val;
      continue;
    }
    const cur = getPath(cfg, key);
    if (cur === val || (cur == null && val === '')) continue;
    // The form has novalidate (a stored value off the input's step or range must not block
    // saving other fields), so check the range here, and only for what was changed.
    if (input.type === 'number') {
      const min = input.min === '' ? NaN : Number(input.min);
      const max = input.max === '' ? NaN : Number(input.max);
      if (val < min || val > max) {
        throw new Error(Number.isFinite(max) ? `${fieldName(input)} must be between ${min} and ${max}.` : `${fieldName(input)} must be at least ${min}.`);
      }
    }
    setPath(partial, key, val);
  }
  return { partial, mode };
}

function fieldName(input) {
  const label = input.closest('label') && input.closest('label').querySelector('.set-label');
  return label && label.firstChild ? String(label.firstChild.textContent).trim() : input.dataset.key;
}

async function saveSettings() {
  let collected;
  try {
    collected = collectSettings();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const { partial, mode } = collected;
  el.saveSettings.disabled = true;
  try {
    if (Object.keys(partial).length) {
      const pub = await api('POST', '/api/config', partial);
      if (pub && typeof pub === 'object') {
        state.config = pub;
        applyConfig();
      }
    }
    if (mode) {
      if (!(await postSwitch('/api/mode', { mode }))) throw new Error('the mode was not changed because a task is running');
      state.mode = mode;
      renderMode();
    }
    closeSettings(true);
    toast('Settings saved', 'success');
  } catch (err) {
    toast(`Couldn't save settings: ${err.message}`, 'error');
  } finally {
    el.saveSettings.disabled = false;
  }
}

function trapFocus(e) {
  if (e.key !== 'Tab' || el.drawer.hidden) return;
  const focusables = [...el.drawer.querySelectorAll('button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
    (n) => !n.disabled && n.offsetParent !== null
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ------------------------------------------------------------------ config

function applyConfig() {
  const cfg = state.config || {};
  applyTheme();
  const attachDefault = Boolean(cfg.context && cfg.context.attachScreenshotByDefault);
  if (state.config) {
    // The "Include screen" chip remembers its last click, but a change to "Attach a
    // screenshot by default" since then (in this window or anywhere else) wins.
    if (state.includeScreenStored && state.lastAttachDefault !== undefined && attachDefault !== state.lastAttachDefault) {
      state.includeScreenStored = false;
      store.set('includeScreen', null);
      store.set('includeScreenDefault', null);
    }
    state.lastAttachDefault = attachDefault;
    if (state.includeScreenStored) store.set('includeScreenDefault', attachDefault);
  }
  if (!state.includeScreenStored) {
    state.includeScreen = attachDefault;
    renderScreenToggle();
  }
  const ui = cfg.ui || {};
  const shell = window.anywhereShell;
  if (shell && typeof shell.setAlwaysOnTop === 'function' && typeof ui.alwaysOnTop === 'boolean' && ui.alwaysOnTop !== state.lastAlwaysOnTop) {
    state.lastAlwaysOnTop = ui.alwaysOnTop;
    try {
      shell.setAlwaysOnTop(ui.alwaysOnTop);
    } catch {
      /* older shell */
    }
  }
  const hf = Boolean(cfg.voice && cfg.voice.handsFree);
  if (state.lastHandsFree !== undefined && hf !== state.lastHandsFree) {
    if (hf) {
      state.handsFreeStarted = false;
      maybeStartHandsFree();
    } else if (voice.mode() === 'handsfree') {
      voice.cancel();
    }
  }
  state.lastHandsFree = hf;
  renderFooter();
  renderEmpty();
  refreshOpenSettings();
}

// ------------------------------------------------------------------ one speaking window
// With two dialog windows open (a stray browser tab, or a second window on Wayland), only the
// most recently focused or shown one reads replies aloud and listens hands-free; the others
// stay quiet. Best effort: BroadcastChannel reaches windows of the same browser profile.
const speaker = {
  id: Math.random().toString(36).slice(2),
  active: true, // alone until another window claims
  channel: null,
  init() {
    try {
      if (typeof BroadcastChannel === 'function') this.channel = new BroadcastChannel('claude-anywhere');
    } catch {
      this.channel = null;
    }
    if (this.channel) {
      this.channel.onmessage = (e) => {
        const m = e && e.data;
        if (!m || m.type !== 'speaker' || m.id === this.id || !this.active) return;
        this.active = false;
        voice.cancelSpeech();
        if (voice.mode() === 'handsfree') {
          voice.cancel();
          state.handsFreeStarted = false;
        }
      };
    }
    this.claim();
  },
  claim() {
    const was = this.active;
    this.active = true;
    try {
      if (this.channel) this.channel.postMessage({ type: 'speaker', id: this.id });
    } catch {
      /* closed */
    }
    if (!was) maybeStartHandsFree();
  },
};

function maybeStartHandsFree() {
  const cfg = state.config || {};
  if (!cfg.voice || !cfg.voice.handsFree || cfg.voice.stt === 'off') return;
  if (!speaker.active) return;
  if (state.handsFreeStarted || voice.isActive()) return;
  state.handsFreeStarted = true;
  voice.start('handsfree');
}

// ------------------------------------------------------------------ composer

function focusInput() {
  el.input.focus();
  const len = el.input.value.length;
  try {
    el.input.setSelectionRange(len, len);
  } catch {
    /* ignore */
  }
}

function autosize() {
  const ta = el.input;
  ta.style.height = 'auto';
  const max = 21 * 6 + 16;
  const next = Math.min(ta.scrollHeight, max);
  ta.style.height = `${Math.max(44, next)}px`;
  ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
}

function renderComposerButtons() {
  const busy = isBusy();
  const empty = !el.input.value.trim() && !state.attachments.length;
  const stopMode = busy && empty;
  el.send.classList.toggle('stop', stopMode);
  setIcon(el.sendIcon, stopMode ? 'stop' : 'send');
  el.send.setAttribute('aria-label', stopMode ? 'Stop' : 'Send');
  el.send.title = stopMode ? 'Stop (Esc)' : 'Send (Enter)';
  el.send.disabled = !stopMode && (empty || state.sending);
  // While a card waits, say where the answer goes (see composerAnswersQuestion).
  el.input.placeholder = state.approvals.size
    ? 'Allow or deny the request above…'
    : state.questions.size === 1
      ? 'Type your answer to Claude’s question…'
      : state.questions.size
        ? 'Answer Claude’s questions above…'
        : state.mode === 'bridge'
          ? 'Send a task to your Claude Code terminal…'
          : busy
            ? 'Queue a follow-up, or press Esc to stop…'
            : 'Tell Claude what to do…';
}

function renderScreenToggle() {
  el.screenToggle.setAttribute('aria-pressed', String(state.includeScreen));
}

function pushHistory(text) {
  if (!text) return;
  const hist = state.history.filter((t) => t !== text);
  hist.push(text);
  state.history = hist.slice(-100);
  store.set('history', state.history);
}

function recall(dir) {
  const hist = state.history;
  if (!hist.length) return false;
  if (state.histIdx === -1) {
    if (dir > 0) return false;
    state.histDraft = el.input.value;
    state.histIdx = hist.length - 1;
  } else {
    state.histIdx += dir;
    if (state.histIdx < 0) state.histIdx = 0;
    if (state.histIdx >= hist.length) {
      state.histIdx = -1;
      el.input.value = state.histDraft;
      autosize();
      renderComposerButtons();
      return true;
    }
  }
  el.input.value = hist[state.histIdx];
  autosize();
  renderComposerButtons();
  focusInput();
  return true;
}

async function send(textOverride, { source = 'text' } = {}) {
  const fromInput = textOverride == null;
  let text = String(fromInput ? el.input.value : textOverride).trim();
  const images = state.attachments.map((a) => ({ mediaType: a.mediaType, data: a.data }));
  if (!text && !images.length) return;
  if (!text) text = images.length === 1 ? 'Look at the attached image.' : 'Look at the attached images.';
  if (voice.isSpeaking()) voice.cancelSpeech();
  // Always explicit: left out, the daemon falls back to attachScreenshotByDefault, which
  // would ignore the chip being switched off.
  const body = { text, source, attachScreenshot: Boolean(state.includeScreen) };
  if (images.length) body.images = images;
  const saved = { value: el.input.value, attachments: state.attachments };
  if (fromInput) {
    el.input.value = '';
    state.histIdx = -1;
  }
  state.attachments = [];
  renderAttachments();
  autosize();
  pushHistory(text);
  state.sending = true;
  state.lastSentAt = Date.now();
  renderComposerButtons();
  // Sending is a request to see what happens next, even when scrolled up in the history.
  scrollToBottom();
  try {
    await api('POST', '/api/command', body, { timeoutMs: 60000 });
  } catch (err) {
    if (fromInput && !el.input.value) {
      el.input.value = saved.value;
      autosize();
    }
    if (!state.attachments.length) {
      state.attachments = saved.attachments;
      renderAttachments();
    }
    toast(`Couldn't send: ${err.message}${err.hint ? ` ${err.hint}` : ''}`, 'error');
  } finally {
    state.sending = false;
    renderComposerButtons();
  }
}

/**
 * Send what's in the composer; with nothing typed while Claude works, stop it.
 * @param {{fromKey?:boolean}} [opts] fromKey: Enter in the composer, which only
 *   stops Claude when nothing was sent in the last moment (a double-tapped
 *   Enter must not cancel the command it just sent)
 */
function submit({ fromKey = false } = {}) {
  const empty = !el.input.value.trim() && !state.attachments.length;
  if (empty && fromKey && (state.approvals.size || state.questions.size)) {
    // Enter while a card waits means the card (its Allow/answer), never "stop the whole
    // task". Focus it, armed, so this same key press can't decide it; the Stop button still stops.
    const card = firstCardNode();
    if (card) {
      focusCard(card);
      return;
    }
  }
  if (isBusy() && empty) {
    if (fromKey && (state.sending || Date.now() - state.lastSentAt < 1500)) return;
    interrupt();
    return;
  }
  if (composerAnswersQuestion()) {
    answerFromComposer();
    return;
  }
  send();
}

/**
 * Typed text answers Claude's question, as a spoken reply does, when that question is the
 * only thing waiting. Queued as a follow-up instead, it would sit behind the question that
 * keeps the turn blocked.
 */
function composerAnswersQuestion() {
  if (!el.input.value.trim() || state.attachments.length || state.approvals.size || state.questions.size !== 1) return false;
  // Its answer is already on the way: more text is a follow-up.
  const q = firstQuestion();
  const n = q && cardNodes.get(q.id);
  return Boolean(q) && !(n && n.classList.contains('busy'));
}

async function answerFromComposer() {
  const q = firstQuestion();
  const text = el.input.value.trim();
  if (!q || !text) return;
  el.input.value = '';
  state.histIdx = -1;
  autosize();
  renderComposerButtons();
  pushHistory(text);
  const ok = await answerQuestion(q.id, text);
  if (!ok && !el.input.value) {
    // Not delivered (the question went away, or the daemon is unreachable): keep the text.
    el.input.value = text;
    autosize();
    renderComposerButtons();
  }
}

async function interrupt() {
  voice.cancelSpeech();
  try {
    await api('POST', '/api/interrupt', {});
  } catch (err) {
    toast(`Couldn't stop: ${err.message}`, 'error');
  }
}

async function newSession() {
  try {
    await api('POST', '/api/session/new', {});
    toast('Started a new session', 'success');
  } catch (err) {
    toast(`Couldn't start a new session: ${err.message}`, 'error');
  }
}

// attachments (paste or drop images)

const MAX_ATTACH = 4;
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;
// Images being read (FileReader) and not yet in state.attachments.
let pendingReads = 0;

function addFiles(files) {
  const imgs = [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
  if (!imgs.length) return false;
  const tooMany = () => toast(`You can attach up to ${MAX_ATTACH} images.`, 'warning');
  // Files are added when their reader finishes, so count the ones already on their way.
  let queued = state.attachments.length + pendingReads;
  for (const f of imgs) {
    if (queued >= MAX_ATTACH) {
      tooMany();
      break;
    }
    if (f.size > MAX_ATTACH_BYTES) {
      toast(`${f.name || 'Image'} is larger than 8 MB.`, 'warning');
      continue;
    }
    queued += 1;
    pendingReads += 1;
    const reader = new FileReader();
    reader.onloadend = () => {
      pendingReads = Math.max(0, pendingReads - 1);
    };
    reader.onload = () => {
      const url = String(reader.result || '');
      const comma = url.indexOf(',');
      if (comma < 0) return;
      if (state.attachments.length >= MAX_ATTACH) {
        tooMany();
        return;
      }
      state.attachments.push({ mediaType: f.type, data: url.slice(comma + 1), url, name: f.name || 'image' });
      renderAttachments();
      renderComposerButtons();
    };
    reader.onerror = () => toast(`Couldn't read ${f.name || 'the image'}.`, 'error');
    reader.readAsDataURL(f);
  }
  return true;
}

function renderAttachments() {
  el.attachments.hidden = !state.attachments.length;
  el.attachments.replaceChildren(
    ...state.attachments.map((a, i) => {
      const rm = h('button', { type: 'button', 'aria-label': `Remove ${a.name}` }, icon('x'));
      rm.addEventListener('click', () => {
        state.attachments.splice(i, 1);
        renderAttachments();
        renderComposerButtons();
      });
      return h('div', { class: 'attachment', title: a.name }, h('img', { src: a.url, alt: a.name }), rm);
    })
  );
}

// ------------------------------------------------------------------ voice

const voice = createVoice({
  getConfig: () => state.config || {},
  getServerVoice: () => state.voiceInfo || {},
  api,
  onInterim(text) {
    state.interim = text || '';
    renderVoiceLine();
  },
  onFinal(text) {
    handleVoiceText(text);
  },
  onState(s) {
    state.voicePhase = s.phase;
    state.voiceMode = s.mode;
    state.speaking = Boolean(s.speaking);
    renderVoice();
    renderStatus();
  },
  onError(message, opts = {}) {
    const level = opts.level || 'error';
    toast(message, level, { timeout: level === 'info' ? 5000 : 10000 });
    renderFooter();
  },
  onLevel(level) {
    setLevel(level);
  },
});

const METER_SHAPE = [0.5, 0.8, 1, 0.8, 0.5];

function setLevel(level) {
  const l = Math.max(0, Math.min(1, Number(level) || 0));
  el.mic.style.setProperty('--level', String(l));
  const bars = el.meter.children;
  for (let i = 0; i < bars.length; i += 1) bars[i].style.height = `${Math.round(4 + l * 12 * METER_SHAPE[i])}px`;
}

function renderVoice() {
  const p = state.voicePhase;
  const active = p !== 'idle';
  el.mic.setAttribute('aria-pressed', String(active));
  el.mic.dataset.phase = p;
  el.mic.setAttribute('aria-label', active ? 'Stop voice input' : 'Voice input');
  renderVoiceLine();
}

function renderVoiceLine() {
  const p = state.voicePhase;
  el.voiceLine.hidden = p === 'idle';
  if (p === 'idle') return;
  let provider = 'browser';
  try {
    provider = voice.provider().stt;
  } catch {
    /* ignore */
  }
  el.meter.classList.toggle('idle', provider !== 'server' || p === 'wake');
  let text;
  let interim = false;
  if (p === 'starting') text = 'Starting the microphone…';
  else if (p === 'transcribing') text = 'Transcribing…';
  else if (p === 'wake') text = `Hands-free: say ${wakeWordText()} and then your request`;
  else if (state.interim) {
    text = state.interim;
    interim = true;
  } else text = state.voiceMode === 'ptt' ? 'Listening… release to send' : 'Listening…';
  el.voiceText.textContent = text;
  el.voiceText.classList.toggle('interim', interim);
}

function handleVoiceText(text) {
  const t = String(text || '').trim();
  if (!t) return;
  const approval = firstApproval();
  const question = approval ? null : firstQuestion();
  const intent = parseVoiceIntent(t, { approval: Boolean(approval), question: question ? { options: question.options || [] } : null });
  switch (intent.kind) {
    case 'stop':
      voice.cancelSpeech();
      if (isBusy()) {
        interrupt();
        toast('Stopping…', 'info', { timeout: 2000 });
      }
      return;
    case 'approve':
      if (!approval) return;
      // Critical actions need a deliberate click, as with Enter on the card: a heard "yes" (or a
      // mishearing, or someone else in the room) never allows one. Voice can still deny.
      if (approval.risk === 'critical' && intent.decision !== 'deny') {
        showCriticalCard(approval);
        return;
      }
      // "Always" adds the card's session rule; a card without one would only be allowed once.
      if (intent.decision === 'allow_session' && approval.sessionRule === null) {
        toast('This action always asks: no session rule covers it. Say “yes” to allow it once, or “no”.', 'warning');
        return;
      }
      resolveApproval(approval.id, intent.decision, intent.message || '', 'voice');
      toast(
        intent.decision === 'deny' ? 'Denied' : intent.decision === 'allow_session' ? (approval.sessionRule ? `Allowed for this session: ${approval.sessionRule}` : 'Allowed for this session') : 'Allowed',
        intent.decision === 'deny' ? 'warning' : 'success',
        { timeout: intent.decision === 'allow_session' ? 4000 : 2000 }
      );
      return;
    case 'answer':
      if (question) answerQuestion(question.id, intent.text);
      return;
    case 'unmatched_approval':
      toast(
        approval && approval.risk === 'critical'
          ? 'Claude is waiting for your approval of a critical action. Click “Allow once” on the card, or say “no”.'
          : approval && approval.sessionRule === null
            ? 'Claude is waiting for your approval. Say “yes” or “no”.'
            : 'Claude is waiting for your approval. Say “yes”, “always” or “no”.',
        'warning'
      );
      if (!el.input.value.trim()) {
        el.input.value = t;
        autosize();
        renderComposerButtons();
      }
      return;
    default:
      break;
  }
  const autoSend = !(state.config && state.config.voice && state.config.voice.autoSend === false);
  if (autoSend) {
    send(t, { source: 'voice' });
  } else {
    const cur = el.input.value;
    el.input.value = cur && !/\s$/.test(cur) ? `${cur} ${t}` : cur + t;
    autosize();
    renderComposerButtons();
    focusInput();
  }
}

/** Voice tried to allow a critical card: point at the card's Allow button instead. */
function showCriticalCard(approval) {
  toast('Critical actions need a click: press “Allow once” on the card (or say “no” to deny).', 'warning');
  const n = cardNodes.get(approval.id);
  if (n) {
    n.scrollIntoView({ block: 'nearest' });
    maybeFocusCard(n);
  }
  const v = (state.config && state.config.voice) || {};
  if (speaker.active && v.speakResponses !== false && v.tts !== 'off') voice.speak('Critical actions need a click. Press Allow once on the card.');
}

function onResult(d) {
  if (typeof d.totalCostUsd === 'number') state.session.costUsd = d.totalCostUsd;
  if (d.sessionId) state.session.id = d.sessionId;
  state.session.turns = (Number(state.session.turns) || 0) + 1;
  renderFooter();
  const v = (state.config && state.config.voice) || {};
  if (speaker.active && v.speakResponses !== false && v.tts !== 'off' && d.speak !== false && !d.isError && d.text) voice.speak(d.text);
}

function onNotify(d) {
  const v = (state.config && state.config.voice) || {};
  if (speaker.active && d.speak && v.tts !== 'off' && d.text) voice.speak(d.text);
  if (d.text && (d.level === 'warning' || d.level === 'error' || !isNearBottom() || document.hidden)) {
    toast(d.text, ['info', 'success', 'warning', 'error'].includes(d.level) ? d.level : 'info');
  }
}

// mic button: click toggles, press-and-hold is push-to-talk
let pressTimer = 0;
let pttFromButton = false;
let pressStartedActive = false;
let spaceHeld = false;

function bindMic() {
  el.mic.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pressStartedActive = voice.isActive();
    pttFromButton = false;
    clearTimeout(pressTimer);
    if (pressStartedActive) return;
    try {
      el.mic.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    pressTimer = setTimeout(() => {
      pttFromButton = true;
      voice.start('ptt');
    }, 350);
  });
  const release = (cancelled) => {
    clearTimeout(pressTimer);
    if (pttFromButton) {
      pttFromButton = false;
      if (cancelled) voice.cancel();
      else voice.stop();
      return true;
    }
    return false;
  };
  el.mic.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    if (release(false)) return;
    voice.toggle();
  });
  el.mic.addEventListener('pointercancel', () => release(true));
  el.mic.addEventListener('click', (e) => {
    // Keyboard activation (Enter/Space on the focused button) has detail 0.
    if (e.detail === 0) voice.toggle();
  });
  el.mic.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ------------------------------------------------------------------ keyboard

function isTypingTarget(t) {
  if (!t || t === document.body) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || t.isContentEditable;
}

function handleEscape(e) {
  if (!el.lightbox.hidden) {
    e.preventDefault();
    closeLightbox();
    return;
  }
  if (openPop) {
    e.preventDefault();
    closePopover(true);
    return;
  }
  if (!el.drawer.hidden) {
    e.preventDefault();
    closeSettings(true);
    return;
  }
  // Hands-free waiting for its wake word is always "active": Esc first stops Claude's speech or
  // work, and only then turns hands-free off. A request being captured is cancelled first.
  const handsFreeIdle =
    voice.mode() === 'handsfree' && !voice.armed() && voice.phase() !== 'transcribing' && !state.interim;
  if (voice.isActive() && !handsFreeIdle) {
    e.preventDefault();
    voice.cancel();
    return;
  }
  if (voice.isSpeaking()) {
    e.preventDefault();
    voice.cancelSpeech();
    return;
  }
  if (isBusy()) {
    e.preventDefault();
    interrupt();
    return;
  }
  if (voice.isActive()) {
    e.preventDefault();
    voice.cancel();
    toast('Hands-free listening is off. Click the microphone to turn it back on.', 'info');
  }
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    // Cmd on macOS (Ctrl+K there is the text fields' kill-line), Ctrl elsewhere.
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && key === 'k') {
      e.preventDefault();
      closePopover(false);
      if (!el.drawer.hidden) closeSettings(false);
      focusInput();
      return;
    }
    if (mod && e.shiftKey && !e.altKey && key === 'm') {
      e.preventDefault();
      voice.toggle();
      return;
    }
    // New session: Ctrl/Cmd+Alt+N everywhere. Browsers keep Ctrl/Cmd+Shift+N (a private
    // window) in ordinary tabs, so that one only reaches app windows and Electron.
    const altN = e.altKey && !e.shiftKey && (key === 'n' || (IS_MAC && e.code === 'KeyN')) && !(e.getModifierState && e.getModifierState('AltGraph'));
    if (mod && (altN || (e.shiftKey && !e.altKey && key === 'n'))) {
      e.preventDefault();
      newSession();
      return;
    }
    if (e.key === 'Escape' && !e.isComposing) {
      handleEscape(e);
      return;
    }
    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (spaceHeld) {
        e.preventDefault();
        return;
      }
      if (e.repeat || isTypingTarget(e.target) || !el.drawer.hidden || !el.lightbox.hidden || openPop) return;
      e.preventDefault();
      spaceHeld = true;
      if (!voice.isActive()) voice.start('ptt');
      return;
    }
    if (!el.drawer.hidden) trapFocus(e);
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && spaceHeld) {
      spaceHeld = false;
      e.preventDefault();
      if (voice.mode() === 'ptt') voice.stop();
    }
  });
  window.addEventListener('blur', () => {
    if (spaceHeld) {
      spaceHeld = false;
      if (voice.mode() === 'ptt') voice.stop();
    }
  });
}

// ------------------------------------------------------------------ wiring

function bindUi() {
  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (!e.repeat) submit({ fromKey: true });
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && !mod(e)) {
      const onFirstLine = !el.input.value.slice(0, el.input.selectionStart).includes('\n');
      if ((el.input.value === '' || (state.histIdx !== -1 && onFirstLine)) && recall(-1)) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && !mod(e) && state.histIdx !== -1) {
      const onLastLine = !el.input.value.slice(el.input.selectionEnd).includes('\n');
      if (onLastLine && recall(1)) e.preventDefault();
    }
  });
  el.input.addEventListener('input', () => {
    state.histIdx = -1;
    autosize();
    renderComposerButtons();
    if (voice.isSpeaking()) voice.cancelSpeech();
  });
  el.input.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length && addFiles(files)) e.preventDefault();
  });
  el.composer.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) {
      e.preventDefault();
      el.composer.classList.add('dragover');
    }
  });
  el.composer.addEventListener('dragleave', () => el.composer.classList.remove('dragover'));
  el.composer.addEventListener('drop', (e) => {
    el.composer.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      if (!addFiles(e.dataTransfer.files)) toast('Only PNG, JPEG, GIF and WebP images can be attached.', 'warning');
    }
  });

  el.screenToggle.addEventListener('click', () => {
    state.includeScreen = !state.includeScreen;
    state.includeScreenStored = true;
    store.set('includeScreen', state.includeScreen);
    if (state.lastAttachDefault !== undefined) store.set('includeScreenDefault', state.lastAttachDefault);
    renderScreenToggle();
  });
  el.voiceCancel.addEventListener('click', () => voice.cancel());
  bindMic();

  el.newSession.addEventListener('click', newSession);
  el.openSettings.addEventListener('click', openSettings);
  el.closeSettings.addEventListener('click', () => closeSettings(true));
  el.cancelSettings.addEventListener('click', () => closeSettings(true));
  el.drawerBackdrop.addEventListener('click', () => closeSettings(true));
  el.settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
  });
  const markDirty = (e) => {
    const key = e.target && e.target.dataset && e.target.dataset.key;
    if (key) state.formDirty.add(key);
  };
  el.settingsForm.addEventListener('input', markDirty);
  el.settingsForm.addEventListener('change', (e) => {
    markDirty(e);
    const t = e.target;
    if (t && t.name === 'ui.theme') applyTheme(t.value);
    updateSettingsHelp();
  });
  el.ttsRate.addEventListener('input', updateSettingsHelp);
  el.testVoice.addEventListener('click', () => {
    // Speak with the values currently in the form, not the saved ones.
    try {
      const { partial } = collectSettings();
      const v = (partial && partial.voice) || {};
      if (v.tts === 'off') {
        toast('Speech output is set to Off.', 'info');
        return;
      }
      voice.speak("Hi! This is how I'll sound when I answer you.", v);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  el.shutdown.addEventListener('click', async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Quit Claude Anywhere? This stops the background service and Claude’s session.')) return;
    try {
      await api('POST', '/api/shutdown', {});
      // Stop listening: the stream's retries would replace this banner with "Reconnecting…".
      state.shutDown = true;
      clearTimeout(retryTimer);
      clearSlowTimer();
      closeEvents();
      state.connected = false;
      markOffline();
      closeSettings(false);
      showBanner('Claude Anywhere has been shut down. Run /anywhere in Claude Code to start it again.', 'warning', true);
    } catch (err) {
      toast(`Couldn't shut down: ${err.message}`, 'error');
    }
  });
  if (window.speechSynthesis) {
    try {
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        if (!el.drawer.hidden) populateVoices(el.ttsVoice.value);
        renderFooter();
      });
    } catch {
      /* old Safari */
    }
  }

  el.projectChip.addEventListener('click', openProjects);
  el.projectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    switchProject(el.projectPath.value);
  });
  el.modeBadge.addEventListener('click', () => {
    if (openPop && openPop.pop === el.modePop) {
      closePopover(true);
      return;
    }
    openPopover(el.modePop, el.modeBadge, 'right');
    const cur = el.modePop.querySelector(`.pop-option[data-mode="${state.mode}"]`) || el.modePop.querySelector('.pop-option');
    if (cur) cur.focus();
  });
  for (const b of el.modePop.querySelectorAll('.pop-option')) b.addEventListener('click', () => setMode(b.dataset.mode));
  document.addEventListener('pointerdown', (e) => {
    if (!openPop) return;
    if (openPop.pop.contains(e.target) || openPop.anchor.contains(e.target)) return;
    closePopover(false);
  });
  window.addEventListener('resize', () => closePopover(false));

  el.viewToggle.addEventListener('click', () => {
    const open = el.viewToggle.getAttribute('aria-expanded') !== 'true';
    store.set('viewOpen', open);
    renderView();
  });
  el.viewImgBtn.addEventListener('click', () => {
    if (state.screenshot) openLightbox(state.screenshot.dataUrl, `Claude's view · ${fmtTime(state.screenshot.ts)}`);
  });
  el.lightboxClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', (e) => {
    if (e.target === el.lightbox) closeLightbox();
  });

  el.jump.addEventListener('click', scrollToBottom);
  let lastTop = 0;
  el.log.addEventListener(
    'scroll',
    () => {
      // Only a move up unpins: a log that shrank under new cards must keep following.
      const top = el.log.scrollTop;
      if (top < lastTop - 1) pinned = isNearBottom();
      else if (isNearBottom()) pinned = true;
      lastTop = top;
      if (pinned && !el.jump.hidden) el.jump.hidden = true;
    },
    { passive: true }
  );
  // Cards, the voice line or a growing composer shrink the transcript; images
  // and re-rendered markdown grow it. Stay at the bottom through both.
  if (typeof window.ResizeObserver === 'function') {
    const ro = new window.ResizeObserver(() => {
      if (pinned) el.log.scrollTop = el.log.scrollHeight;
    });
    ro.observe(el.log);
    ro.observe(el.items);
  }
  el.bannerRetry.addEventListener('click', () => {
    retryDelay = 1000;
    state.authFailed = false;
    state.shutDown = false;
    state.offlineDiagnosed = false;
    clearSlowTimer();
    showBanner('Reconnecting…', 'warning', false);
    connect();
  });
  document.addEventListener('visibilitychange', () => {
    reportVisibility();
    if (!document.hidden && pendingRenders.size && !rafId) scheduleRender([...pendingRenders][0]);
  });

  el.suggestions.replaceChildren(
    ...SUGGESTIONS.map((s) => {
      const b = h('button', { type: 'button', class: 'suggestion' }, icon(s.icon), s.text);
      b.addEventListener('click', () => {
        el.input.value = s.text;
        autosize();
        renderComposerButtons();
        focusInput();
      });
      return b;
    })
  );
  el.composerHint.textContent = `Enter to send · Shift+Enter for a new line · ${MOD_LABEL}K to focus`;
  el.newSession.title = `New session (${IS_MAC ? '⌥⌘N' : 'Ctrl+Alt+N'})`;

  setInterval(() => {
    updateTimers();
    if (state.screenshot && !el.view.hidden) el.viewTime.textContent = relTime(state.screenshot.ts);
  }, 1000);
}

function mod(e) {
  return e.ctrlKey || e.metaKey || e.altKey;
}

function grabElements() {
  const ids = {
    app: 'app', status: 'status', statusLabel: 'status-label', statusDetail: 'status-detail', newSession: 'new-session',
    openSettings: 'open-settings', projectChip: 'project-chip', projectName: 'project-name', projectBranch: 'project-branch',
    projectBranchName: 'project-branch-name', modeBadge: 'mode-badge', modeLabel: 'mode-label', banner: 'banner',
    bannerText: 'banner-text', bannerRetry: 'banner-retry', view: 'view', viewToggle: 'view-toggle', viewTime: 'view-time',
    viewBody: 'view-body', viewImgBtn: 'view-img-btn', viewImg: 'view-img', log: 'log', empty: 'empty', emptySub: 'empty-sub',
    suggestions: 'suggestions', items: 'items', typing: 'typing', jump: 'jump', cards: 'cards', toasts: 'toasts',
    composer: 'composer', voiceLine: 'voice-line', meter: 'meter', voiceText: 'voice-text', voiceCancel: 'voice-cancel',
    attachments: 'attachments', input: 'input', screenToggle: 'screen-toggle', composerHint: 'composer-hint', mic: 'mic',
    send: 'send', sendIcon: 'send-icon', sbModel: 'sb-model', sbCost: 'sb-cost', sbCostSep: 'sb-cost-sep', sbVoice: 'sb-voice', sbStt: 'sb-stt',
    sbTts: 'sb-tts', projectPop: 'project-pop', projectList: 'project-list', projectForm: 'project-form',
    projectPath: 'project-path', modePop: 'mode-pop', modeNote: 'mode-note', drawerBackdrop: 'drawer-backdrop',
    drawer: 'drawer', closeSettings: 'close-settings', settingsForm: 'settings-form', permHelp: 'perm-help',
    ttsVoice: 'tts-voice', ttsRate: 'tts-rate', rateOut: 'rate-out', testVoice: 'test-voice', sttKey: 'stt-key',
    voiceDiag: 'voice-diag', about: 'about', shutdown: 'shutdown', cancelSettings: 'cancel-settings',
    saveSettings: 'save-settings', lightbox: 'lightbox', lightboxImg: 'lightbox-img', lightboxCaption: 'lightbox-caption',
    lightboxClose: 'lightbox-close',
  };
  for (const [k, id] of Object.entries(ids)) {
    el[k] = $(id);
    if (!el[k]) throw new Error(`Missing #${id} in index.html`);
  }
}

function init() {
  grabElements();
  const credentials = initFromUrl();
  applyTheme();
  const storedScreen = store.get('includeScreen', null);
  if (typeof storedScreen === 'boolean') {
    state.includeScreen = storedScreen;
    state.includeScreenStored = true;
    // "Attach a screenshot by default" as it was then: changed since, the setting wins.
    const def = store.get('includeScreenDefault', null);
    if (typeof def === 'boolean') state.lastAttachDefault = def;
  }
  const hist = store.get('history', []);
  state.history = Array.isArray(hist) ? hist.filter((x) => typeof x === 'string').slice(-100) : [];
  bindUi();
  bindKeys();
  speaker.init();
  window.addEventListener('focus', () => speaker.claim());
  renderScreenToggle();
  renderStatus();
  renderProject();
  renderMode();
  renderFooter();
  renderEmpty();
  renderComposerButtons();
  autosize();
  window.anywhereFocusInput = () => {
    try {
      window.focus();
    } catch {
      /* ignore */
    }
    focusInput();
  };
  // The first API call waits for a ?launch= code to be traded for the token.
  credentials.then(() => connect());
  focusInput();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
