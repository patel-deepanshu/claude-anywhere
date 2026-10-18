/**
 * Feature 3 loader for the dialog (docs/CALLS-DESIGN.md §10.7): mounts the voice enrollment view
 * (clone.js) and the calls pill and panel (calls-panel.js).
 *
 *   index.html: <script type="module" src="calls-ui.js"></script>   (after app.js)
 *
 * Daemon access: window.anywhereApi(method, path, body) when the dialog exposes it, else fetch()
 * with the dialog's token (sessionStorage 'anywhere.token'). The arm request waits for the user's
 * click on a card, so it always gets a long timeout.
 *
 * Live events: the dialog re-dispatches its SSE events as window 'anywhere:event' {type, data}.
 * Without that hook (an older app.js) this loader opens its own event stream (?client=calls, which
 * does not count as a dialog) and the panel polls /api/calls/status every 3 s; the first
 * 'anywhere:event' switches to the hook.
 */

import { mount as mountPanel } from './calls-panel.js';

const EVENT_TYPES = ['calls', 'call_transcript', 'call_action', 'call_notes', 'config', 'approval_request', 'question'];
const TOKEN_WAIT_MS = 15000;
const DEFAULT_TIMEOUT_MS = 30000;

function storedToken(win) {
  try {
    return win.sessionStorage.getItem('anywhere.token') || '';
  } catch {
    return '';
  }
}

/**
 * The daemon request function.
 * @param {Window} win
 * @returns {(method:string, path:string, body?:any, opts?:{timeoutMs?:number})=>Promise<any>}
 */
export function createApi(win = globalThis.window) {
  return async function request(method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const hook = typeof win.anywhereApi === 'function' ? win.anywhereApi : null;
    const token = storedToken(win);
    // The dialog's own helper for ordinary requests (it handles an expired token); long waits
    // (the arm card) need their own timeout.
    if (hook && (timeoutMs <= DEFAULT_TIMEOUT_MS || !token)) return hook(method, path, body, { timeoutMs });
    if (!token) {
      const e = new Error('This window has no access key yet.');
      e.status = 0;
      throw e;
    }
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const ctrl = new win.AbortController();
    const timer = win.setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await win.fetch(path, { method, headers, body: payload, signal: ctrl.signal, cache: 'no-store', credentials: 'same-origin' });
    } catch (err) {
      const e = new Error(err && err.name === 'AbortError' ? 'The request timed out.' : "Can't reach Claude Anywhere. Is it still running?");
      e.status = 0;
      throw e;
    } finally {
      win.clearTimeout(timer);
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
      if (data && data.code) e.code = data.code;
      if (data && data.hint) e.hint = data.hint;
      throw e;
    }
    return data;
  };
}

/**
 * Feed the panel the daemon's events: the dialog's 'anywhere:event' hook, else an own EventSource.
 * @returns {{hooked:()=>boolean, stop:()=>void}}
 */
export function connectEvents(panel, win = globalThis.window) {
  let hooked = typeof win.anywhereApi === 'function';
  let es = null;
  let retry = 0;
  let stopped = false;
  const closeOwn = () => {
    if (es) es.close();
    es = null;
    win.clearTimeout(retry);
  };
  const onHook = (e) => {
    const d = (e && e.detail) || {};
    if (!d.type) return;
    if (!hooked) {
      hooked = true;
      closeOwn();
      panel.setHooked(true);
    }
    panel.handleEvent(d.type, d.data);
  };
  win.addEventListener('anywhere:event', onHook);
  const openOwn = (delay = 0) => {
    win.clearTimeout(retry);
    retry = win.setTimeout(() => {
      if (stopped || hooked || es) return;
      const token = storedToken(win);
      if (!token || typeof win.EventSource !== 'function') {
        openOwn(1000);
        return;
      }
      const src = new win.EventSource(`/api/events?token=${encodeURIComponent(token)}&client=calls`);
      es = src;
      for (const type of EVENT_TYPES) {
        src.addEventListener(type, (ev) => {
          if (es !== src || hooked) return;
          let data = {};
          try {
            data = ev.data ? JSON.parse(ev.data) : {};
          } catch {
            return;
          }
          panel.handleEvent(type, data);
        });
      }
      src.onerror = () => {
        if (es !== src) return;
        if (src.readyState === 2) {
          es = null;
          openOwn(5000); // closed for good (daemon restarted, new token): look again
        }
      };
    }, delay);
  };
  if (!hooked) openOwn(0);
  return {
    hooked: () => hooked,
    stop: () => {
      stopped = true;
      closeOwn();
      win.removeEventListener('anywhere:event', onHook);
    },
  };
}

async function waitForToken(win, ms) {
  const end = Date.now() + ms;
  while (!storedToken(win) && typeof win.anywhereApi !== 'function' && Date.now() < end) {
    await new Promise((r) => win.setTimeout(r, 250));
  }
}

async function boot(win = globalThis.window) {
  const doc = win.document;
  // Only in the dialog: the standalone pages (clone.html, the audio self-test) load their own modules.
  if (doc.documentElement.dataset.page) return;
  // app.js may still be trading a launch code for the token.
  await waitForToken(win, TOKEN_WAIT_MS);
  try {
    const clone = await import('./clone.js');
    if (clone && typeof clone.mount === 'function') clone.mount();
  } catch (err) {
    console.warn('Claude Anywhere: the voice enrollment view did not load', err);
  }
  try {
    const request = createApi(win);
    const panel = mountPanel({ api: request, request, hooked: typeof win.anywhereApi === 'function' });
    const events = connectEvents(panel, win);
    win.anywhereCalls = { open: () => panel.open(), close: () => panel.close(), refresh: () => panel.refresh(), hooked: () => events.hooked() };
  } catch (err) {
    console.warn('Claude Anywhere: the calls panel did not load', err);
  }
}

if (typeof window !== 'undefined' && window.document && !window.__anywhereCallsUiBooted) {
  window.__anywhereCallsUiBooted = true;
  boot(window);
}
