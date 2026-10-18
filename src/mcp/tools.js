'use strict';

/**
 * The core tools of the `anywhere` MCP server (the 19 contract tools plus
 * batch_actions): screen and input control through a Computer, window/app/
 * clipboard helpers through its driver, desktop context, and the dialog bridge
 * (notify_user, ask_user, permission_prompt) through the daemon's /api/mcp/*
 * endpoints. Feature modules (TOOL_MODULES) add the rest.
 *
 * Every input action first asks the daemon whether the user paused Claude
 * (GET /api/mcp/guard, 200 ms budget, failures mean "allowed") and afterwards
 * reports itself to the dialog's activity feed (fire-and-forget). With
 * screenshotAfter it also returns a fresh (smaller) screenshot after a short
 * settle delay, and batch_actions runs several of them in one call, checking
 * the guard before each step and stopping at the first failure.
 */

const { createLogger } = require('../shared/log');
const { truncate } = require('../shared/util');
const desktop = require('../context/desktop');

const log = createLogger('mcp-tools');

const GUARD_TIMEOUT_MS = 200;
const ACTIVITY_TIMEOUT_MS = 5000;
const NOTIFY_TIMEOUT_MS = 5000;
const PROGRESS_INTERVAL_MS = 15000;
const MAX_WAIT_SEC = 30;
const DEFAULT_ASK_TIMEOUT_SEC = 900;
// The daemon's PermissionBroker owns the approval deadline (approvalTimeoutSec, read
// live from config) and answers "deny" when it passes; Claude Code's cancellation
// reaches us through extra.signal. This HTTP limit is only a backstop for a daemon
// that never answers, so it must outlast any deadline the user can set.
const PERMISSION_HTTP_TIMEOUT_MS = 24 * 3600 * 1000;
const CLIPBOARD_MAX_CHARS = 50000;
const MAX_LISTED_WINDOWS = 100;
const NO_DIALOG_MESSAGE = 'The Anywhere dialog is not running; ask the user in your normal reply instead.';
// screenshotAfter: let the UI settle, then capture a smaller image than a plain screenshot
// (1366x768) so verifying each step stays cheap. It becomes the latest screenshot, so later
// coordinates are pixels of this image (its text says so).
const SHOT_AFTER_SETTLE_MS = 350;
const SHOT_AFTER_MAX_WIDTH = 1024;
const SHOT_AFTER_MAX_HEIGHT = 640;
const CURSOR_TIMEOUT_MS = 1000;
// batch_actions
const MAX_BATCH_STEPS = 20;
const MAX_BATCH_WAIT_SEC = 10;
/** Step types of batch_actions, each run as its single tool (BATCH_STEP_TOOL). */
const BATCH_STEP_TYPES = ['click', 'double_click', 'right_click', 'move', 'drag', 'type', 'key', 'scroll', 'wait', 'focus_window', 'ui_click'];
const BATCH_STEP_TOOL = {
  click: 'click',
  double_click: 'click',
  right_click: 'click',
  move: 'mouse_move',
  drag: 'drag',
  type: 'type_text',
  key: 'key',
  scroll: 'scroll',
  wait: 'wait',
  focus_window: 'focus_window',
  ui_click: 'ui_click',
};

// ---------------------------------------------------------------- helpers

function toolError(message, code, hint) {
  const err = new Error(message);
  if (code) err.code = code;
  if (hint) err.hint = hint;
  return err;
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function lower(s) {
  return String(s == null ? '' : s).toLowerCase();
}

/** Round to at most 3 decimals for display. */
function num(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return String(Math.round(v * 1000) / 1000);
}

function oneLine(s, max = 200) {
  return truncate(String(s == null ? '' : s).replace(/\s+/g, ' ').trim(), max);
}

function windowLabel(w) {
  if (!w) return 'unknown';
  const app = oneLine(w.app, 60);
  const title = oneLine(w.title, 120);
  if (!title || title === app) return app || '(untitled window)';
  return app ? `${app} — "${title}"` : `"${title}"`;
}

function abortError(signal) {
  const reason = signal && signal.reason;
  const err = new Error(reason && reason.message ? reason.message : 'The request was cancelled');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

/** setTimeout as a promise that rejects when `signal` aborts. */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Call the daemon. Aborting `signal` closes the HTTP request so a cancelled
 * ask_user or permission prompt lets the daemon drop its card. DaemonClient
 * uses node:http because fetch gives up on responses slower than 300 s.
 * @param {object} client DaemonClient-like
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [opts]
 */
async function daemonRequest(client, method, urlPath, body, { timeoutMs = 30000, signal } = {}) {
  if (signal && signal.aborted) throw abortError(signal);
  const call = client.request(method, urlPath, body, { timeoutMs, signal });
  if (!signal) return call;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    call.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function sameWindowId(a, b) {
  if (a == null || b == null) return false;
  const x = String(a).trim();
  const y = String(b).trim();
  if (x === y) return true;
  if (/^0x[0-9a-f]+$/i.test(x) && /^0x[0-9a-f]+$/i.test(y)) return parseInt(x, 16) === parseInt(y, 16);
  if (/^\d+$/.test(x) && /^0x[0-9a-f]+$/i.test(y)) return Number(x) === parseInt(y, 16);
  if (/^0x[0-9a-f]+$/i.test(x) && /^\d+$/.test(y)) return parseInt(x, 16) === Number(y);
  return false;
}

/**
 * Find windows for focus_window: by id; otherwise by case-insensitive
 * substring of title and/or app (a lone `title` query falls back to app names).
 * Our own dialog is never matched by title/app.
 * @returns {object[]} matches, best first
 */
function matchWindows(windows, { id, title, app } = {}) {
  const list = Array.isArray(windows) ? windows : [];
  if (id != null && String(id).trim() !== '') return list.filter((w) => sameWindowId(w.id, id));
  const t = lower(title).trim();
  const a = lower(app).trim();
  const pool = list.filter((w) => !desktop.isOwnWindow(w));
  let matches = pool.filter((w) => (!t || lower(w.title).includes(t)) && (!a || lower(w.app).includes(a)));
  if (!matches.length && t && !a) matches = pool.filter((w) => lower(w.app).includes(t));
  if (matches.length > 1) {
    const exact = matches.filter((w) => (t && lower(w.title) === t) || (!t && a && lower(w.app) === a));
    if (exact.length === 1) return exact;
    const visible = matches.filter((w) => !w.minimized);
    if (visible.length === 1) return visible;
  }
  return matches;
}

function windowLine(w) {
  const geo = [w.width, w.height].every(Number.isFinite) ? ` · ${w.width}x${w.height} at (${w.x}, ${w.y})` : '';
  // Windows: elevated true = runs as admin, null = another account's process (unknown); input
  // to either may be dropped by UIPI unless Claude Code itself runs elevated.
  const elevated = w.elevated === true ? ' [admin]' : w.elevated === null ? ' [other account; may be admin]' : '';
  const flags = `${w.focused ? ' [focused]' : ''}${w.minimized ? ' [minimized]' : ''}${elevated}`;
  return `- id ${w.id}: ${windowLabel(w)}${geo}${w.pid ? ` · pid ${w.pid}` : ''}${flags}`;
}

/**
 * The text block returned with every screenshot.
 * @param {object} shot Computer.screenshot() result
 * @param {object|null} active driver.activeWindow()
 */
function describeShot(shot, active) {
  const d = Number.isInteger(shot.display) ? shot.display : 0;
  const n = shot.displays || 1;
  const where = `display ${d}${d === 0 ? ' (primary)' : ''} of ${n} (0-based)`;
  const activeText = !active
    ? 'unknown'
    : desktop.isOwnWindow(active)
      ? 'the Claude Anywhere dialog (the user\'s control panel; focus the target window before typing)'
      : windowLabel(active);
  if (!shot.region) {
    const cursor = shot.cursor ? `(${shot.cursor.x}, ${shot.cursor.y})` : 'not on this display';
    const native = shot.native && (shot.native.width !== shot.width || shot.native.height !== shot.height) ? `, downscaled from ${shot.native.width}x${shot.native.height}` : '';
    return [
      `Screenshot of ${where}: ${shot.width}x${shot.height} px${native}; scale: 1 image px = ${num(shot.scale || 1)} screen px.`,
      `Mouse cursor: ${cursor}. Active window: ${activeText}.`,
      `Coordinates for click, mouse_move, drag and scroll with display ${d} are pixels in this image; the server maps them to the real screen.`,
    ].join(' ');
  }
  const r = shot.region;
  const fx = r.width / shot.width;
  const fy = r.height / shot.height;
  const cursor = shot.cursor ? `(${shot.cursor.x}, ${shot.cursor.y}) in full-screenshot px` : 'not on this display';
  return [
    `Zoomed view of region x=${r.x}, y=${r.y}, ${r.width}x${r.height} (full-screenshot px) of ${where}, shown at ${shot.width}x${shot.height} px (${num(1 / fx)}x).`,
    `This zoom does not change the coordinate space: for a point (zx, zy) in this image, act at x = ${r.x} + zx * ${num(fx)}, y = ${r.y} + zy * ${num(fy)} (full-screenshot px).`,
    `Mouse cursor: ${cursor}. Active window: ${activeText}.`,
  ].join(' ');
}

// ---------------------------------------------------------------- batch_actions steps

function hasText(v) {
  return v != null && String(v).trim() !== '';
}

function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The single tool a batch_actions step runs as, with only the arguments that tool takes.
 * permissions.js classifies each step the same way (batchStepCall there must agree).
 * @param {object} step {type, ...arguments}
 * @returns {{type:string, tool:string, args:object}|null} null for a step of unknown type
 */
function batchStepCall(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
  const type = String(step.type == null ? '' : step.type).trim().toLowerCase();
  const tool = Object.prototype.hasOwnProperty.call(BATCH_STEP_TOOL, type) ? BATCH_STEP_TOOL[type] : null;
  if (!tool) return null;
  const pick = (...keys) => {
    const o = {};
    for (const k of keys) if (step[k] !== undefined && step[k] !== null) o[k] = step[k];
    return o;
  };
  const idText = (o) => {
    if (o.id != null) o.id = String(o.id);
    return o;
  };
  let args;
  switch (type) {
    case 'click':
      args = pick('x', 'y', 'button', 'clicks', 'modifiers', 'display');
      break;
    case 'double_click':
      args = { ...pick('x', 'y', 'modifiers', 'display'), clicks: 2 };
      break;
    case 'right_click':
      args = { ...pick('x', 'y', 'modifiers', 'display'), button: 'right' };
      break;
    case 'move':
      args = pick('x', 'y', 'display');
      break;
    case 'drag':
      args = pick('fromX', 'fromY', 'toX', 'toY', 'button', 'display');
      break;
    case 'type':
      args = pick('text', 'method');
      break;
    case 'key':
      args = pick('combo', 'repeat');
      break;
    case 'scroll':
      args = pick('direction', 'amount', 'x', 'y', 'display');
      break;
    case 'wait':
      args = pick('seconds');
      break;
    case 'focus_window':
      args = idText(pick('id', 'title', 'app'));
      break;
    default: // ui_click
      args = idText(pick('id', 'name', 'text', 'role', 'window', 'exact'));
  }
  return { type, tool, args };
}

/**
 * What is wrong with a batch step, checked for every step before any runs.
 * @returns {string|null} the problem, or null when the step is complete
 */
function batchStepProblem(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return 'each step must be an object like {"type": "click", "x": 100, "y": 200}';
  const call = batchStepCall(step);
  if (!call) return `unknown type ${JSON.stringify(step.type == null ? '' : step.type)}; use one of ${BATCH_STEP_TYPES.join(', ')}`;
  const a = call.args;
  const coords = (...keys) => keys.every((k) => finiteNumber(a[k]) && a[k] >= 0);
  switch (call.tool) {
    case 'click':
    case 'mouse_move':
      if (!coords('x', 'y')) return 'x and y (pixels of your latest screenshot) are required';
      break;
    case 'drag':
      if (!coords('fromX', 'fromY', 'toX', 'toY')) return 'fromX, fromY, toX and toY (pixels of your latest screenshot) are required';
      break;
    case 'type_text':
      if (typeof a.text !== 'string' || a.text === '') return 'text (the exact text to type) is required';
      break;
    case 'key':
      if (!hasText(a.combo)) return 'combo is required, e.g. "enter" or "primary+s"';
      break;
    case 'scroll':
      if (!['up', 'down', 'left', 'right'].includes(String(a.direction))) return 'direction must be up, down, left or right';
      if ((a.x == null) !== (a.y == null)) return 'give both x and y, or neither to scroll at the mouse position';
      if (a.x != null && !coords('x', 'y')) return 'x and y must be pixels of your latest screenshot';
      break;
    case 'wait':
      if (!finiteNumber(a.seconds) || a.seconds < 0 || a.seconds > MAX_BATCH_WAIT_SEC) return `seconds must be a number from 0 to ${MAX_BATCH_WAIT_SEC}`;
      break;
    case 'focus_window':
      if (!hasText(a.id) && !hasText(a.title) && !hasText(a.app)) return 'give the window id, or part of its title or app name';
      break;
    default: // ui_click
      if (!hasText(a.id) && !hasText(a.name) && !hasText(a.text)) return 'give the element id (from ui_find or ui_tree), or its name or text';
  }
  if (a.display != null && !(Number.isInteger(a.display) && a.display >= 0 && a.display <= 15)) return 'display must be a display index from 0 to 15';
  return null;
}

/** Short label of a step for messages: click (100, 200), type "hello", key "enter"… */
function batchStepLabel(step) {
  const call = batchStepCall(step);
  if (!call) return `step of type ${JSON.stringify(step && step.type != null ? step.type : '')}`;
  const a = call.args;
  const at = (x, y) => (x != null && y != null ? ` (${num(x)}, ${num(y)})` : '');
  switch (call.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move':
      return `${call.type}${at(a.x, a.y)}`;
    case 'drag':
      return `drag${at(a.fromX, a.fromY)} to${at(a.toX, a.toY)}`;
    case 'type':
      return `type "${oneLine(a.text, 40)}"`;
    case 'key':
      return `key "${oneLine(a.combo, 40)}"${a.repeat > 1 ? ` x${a.repeat}` : ''}`;
    case 'scroll':
      return `scroll ${a.direction}${at(a.x, a.y)}`;
    case 'wait':
      return `wait ${num(a.seconds)} s`;
    case 'focus_window':
      return `focus_window ${hasText(a.id) ? `id ${a.id}` : [a.app && `app "${oneLine(a.app, 40)}"`, a.title && `title "${oneLine(a.title, 40)}"`].filter(Boolean).join(' ')}`;
    default:
      return `ui_click ${hasText(a.id) ? `id ${oneLine(a.id, 60)}` : `"${oneLine(a.name || a.text, 40)}"${a.role ? ` (${a.role})` : ''}`}`;
  }
}

/** Drop the "Take a screenshot to verify." advice from a result text (a screenshot comes with it, or it is one step of many). */
function withoutVerifyHint(text) {
  return String(text == null ? '' : text)
    .replace(/\s*Take (?:a|another) screenshot\b[^.\n]*\./g, '')
    .trim();
}

// ---------------------------------------------------------------- schemas

const DISPLAY = {
  type: 'integer',
  minimum: 0,
  maximum: 15,
  description: 'Display index, 0-based: 0 is the primary display (the default). screen_info lists all displays.',
};

const SHOT_AFTER = {
  type: 'boolean',
  description: `Also return a fresh screenshot (at most ${SHOT_AFTER_MAX_WIDTH}x${SHOT_AFTER_MAX_HEIGHT}, taken ${SHOT_AFTER_SETTLE_MS} ms after the action) to verify the result without another call. It becomes your latest screenshot: later coordinates are pixels of it. Default false.`,
};

function coord(axis, extra) {
  return { type: 'number', minimum: 0, description: `${axis} coordinate in pixels of your latest screenshot of the display${extra ? `; ${extra}` : ''}.` };
}

function objectSchema(properties, required = []) {
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function annotations(title, { readOnly = false, destructive = false, idempotent = false, openWorld = true } = {}) {
  return { title, readOnlyHint: readOnly, destructiveHint: readOnly ? false : destructive, idempotentHint: idempotent, openWorldHint: openWorld };
}

// ---------------------------------------------------------------- factory

/**
 * Build the anywhere tool set.
 * @param {{computer: object|(()=>Promise<object>), getClient?: ()=>Promise<object|null>, config?: object,
 *   role?: 'engine'|'interactive', progressIntervalMs?: number, screenshotSettleMs?: number,
 *   deps?: {notify?:Function, speak?:Function, openTarget?:Function, gatherContext?:Function}}} opts
 *   computer: a Computer, a promise of one, or a lazy factory returning one.
 *   screenshotSettleMs: the pause before a screenshotAfter capture (default 350 ms).
 * @returns {{name:string,title:string,description:string,inputSchema:object,annotations:object,handler:Function}[]}
 */
function createTools({
  computer,
  getClient,
  config = {},
  role = 'interactive',
  progressIntervalMs = PROGRESS_INTERVAL_MS,
  screenshotSettleMs = SHOT_AFTER_SETTLE_MS,
  deps = {},
} = {}) {
  const common = () => require('../os/common');
  const notifyOs = deps.notify || ((title, body) => common().notify(title, body));
  const speakOs = deps.speak || ((text, opts) => common().speak(text, opts));
  const openTarget = deps.openTarget || ((target, opts) => common().openTarget(target, opts));
  const gather = deps.gatherContext || desktop.gatherContext;

  async function getComputer() {
    const c = typeof computer === 'function' ? await computer() : await computer;
    if (!c) {
      throw toolError('Desktop control is not available in this process.', 'UNSUPPORTED', 'Run "anywhere doctor" to see what is missing on this machine.');
    }
    return c;
  }

  async function getDriver() {
    const c = await getComputer();
    if (!c.driver) throw toolError('The desktop driver is not available.', 'UNSUPPORTED', 'Run "anywhere doctor" to see what is missing on this machine.');
    return c.driver;
  }

  async function client() {
    if (typeof getClient !== 'function') return null;
    try {
      return (await getClient()) || null;
    } catch (err) {
      log.debug('daemon lookup failed:', err && err.message);
      return null;
    }
  }

  async function checkGuard() {
    const c = await client();
    if (!c) return;
    let verdict;
    try {
      verdict = await c.request('GET', '/api/mcp/guard', undefined, { timeoutMs: GUARD_TIMEOUT_MS });
    } catch {
      return; // unreachable or slow daemon: never block the user's work on it
    }
    if (verdict && verdict.allowed === false) {
      throw toolError(
        `Actions are paused: ${verdict.reason || 'the user paused Claude in the Anywhere dialog'}.`,
        'PAUSED',
        'Do not retry. Stop and tell the user what you were about to do; continue only after they resume.'
      );
    }
  }

  function postActivity(payload) {
    client()
      .then((c) => (c ? c.request('POST', '/api/mcp/activity', { ...payload, role }, { timeoutMs: ACTIVITY_TIMEOUT_MS }) : null))
      .catch((err) => log.debug('activity post failed:', err && err.message));
  }

  function keepAlive(extra, describeWait) {
    if (!extra || typeof extra.sendProgress !== 'function') return () => {};
    const started = Date.now();
    const timer = setInterval(() => {
      try {
        extra.sendProgress(describeWait(Math.round((Date.now() - started) / 1000)));
      } catch {
        /* ignore */
      }
    }, progressIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  // ------------------------------------------------------------ screenshot after an action

  /** The display index whose rectangle holds the centre of `rect` (logical coordinates), or null. */
  function displayOfRect(displays, rect) {
    if (!Array.isArray(displays) || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const i = displays.findIndex((d) => d && cx >= d.x && cy >= d.y && cx < d.x + d.width && cy < d.y + d.height);
    if (i < 0) return null;
    return Number.isInteger(displays[i].index) ? displays[i].index : i;
  }

  /**
   * Which display to capture after an action: the one it happened on, else the one holding the
   * window it acted on, else the one under the mouse pointer, else the primary display.
   */
  async function displayForShot(comp, { display, window } = {}) {
    if (Number.isInteger(display) && display >= 0) return display;
    if (window && typeof comp.screenInfo === 'function') {
      const info = await withTimeout(comp.screenInfo(), CURSOR_TIMEOUT_MS, null);
      const d = displayOfRect(info && info.displays, window);
      if (d != null) return d;
    }
    if (typeof comp.cursorPosition === 'function') {
      const p = await withTimeout(comp.cursorPosition(), CURSOR_TIMEOUT_MS, null);
      if (p && Number.isInteger(p.display)) return p.display;
    }
    return 0;
  }

  /**
   * Content blocks [image, text] of a fresh, smaller screenshot taken after a settle delay. A failed
   * capture becomes a text block (the action itself succeeded); only a cancelled call throws.
   * @param {{display?:number, window?:object, signal?:AbortSignal}} [opts]
   */
  async function shotAfterBlocks({ display, window, signal } = {}) {
    await sleepAbortable(Math.max(0, Number(screenshotSettleMs) || 0), signal);
    try {
      const comp = await getComputer();
      const d = await displayForShot(comp, { display, window });
      const shot = await comp.screenshot({ display: d, maxWidth: SHOT_AFTER_MAX_WIDTH, maxHeight: SHOT_AFTER_MAX_HEIGHT });
      const active = await activeWindowOf(comp.driver);
      const data = shot.png.toString('base64');
      postActivity({ tool: 'screenshot', summary: `Screenshot of display ${shot.display} (${shot.width}x${shot.height}) after the action`, ok: true, image: data, width: shot.width, height: shot.height });
      return [
        { type: 'image', data, mimeType: 'image/png' },
        { type: 'text', text: `After the action: ${describeShot(shot, active)}` },
      ];
    } catch (err) {
      log.debug('screenshot after an action failed:', err && err.message);
      return [{ type: 'text', text: `(No screenshot afterwards: ${oneLine(err && err.message, 200)}. Take one with screenshot.)` }];
    }
  }

  /**
   * screenshotAfter for feature modules (ext.screenshotAfter), in two forms:
   * - screenshotAfter(result, args, {display?, window?, signal?}): when args.screenshotAfter is true and
   *   the MCP result is not an error, a copy of it with a fresh screenshot appended (after the settle
   *   delay, on opts.display, else args.display, else the window's or the pointer's display);
   *   otherwise the result unchanged.
   * - screenshotAfter({display?, window?, signal?}): just the content blocks [image, text].
   */
  async function screenshotAfter(result, args, opts = {}) {
    if (!result || !Array.isArray(result.content)) {
      const o = result && typeof result === 'object' ? result : {};
      return shotAfterBlocks({ display: o.display, window: o.window, signal: o.signal });
    }
    if (!args || args.screenshotAfter !== true || result.isError) return result;
    const o = opts && typeof opts === 'object' ? opts : {};
    const display = Number.isInteger(o.display) ? o.display : Number.isInteger(args.display) ? args.display : undefined;
    const blocks = await shotAfterBlocks({ display, window: o.window, signal: o.signal });
    return { ...result, content: [...result.content, ...blocks] };
  }

  /** Tools made by inputTool: they check the guard themselves (batch_actions need not). */
  const guardedTools = new Set();

  /**
   * Wrap an input action: guard → run → activity → optional screenshot. `run` returns
   * {text, summary?, isError?, warnings?, display?, window?}; display/window pick the display the
   * screenshotAfter capture shows. Thrown errors become isError results upstream.
   */
  function inputTool({ name, title, description, inputSchema, annotations: ann, summarize, run }) {
    guardedTools.add(name);
    return {
      name,
      title,
      description,
      inputSchema,
      annotations: ann,
      handler: async (args = {}, extra = {}) => {
        await checkGuard();
        let out;
        try {
          out = await run(args, extra);
        } catch (err) {
          postActivity({ tool: name, summary: summarize(args), ok: false, error: oneLine(err && err.message, 300) });
          throw err;
        }
        const isError = Boolean(out.isError);
        const shotAfter = args.screenshotAfter === true && !isError;
        // Input the OS may have dropped silently (Windows UIPI: another account's window).
        const warnings = Array.isArray(out.warnings) ? out.warnings.filter((w) => typeof w === 'string' && w) : [];
        const base = shotAfter ? withoutVerifyHint(out.text) : out.text;
        const text = warnings.length ? `${base}\n\nWarning: ${warnings.join('\nWarning: ')}` : base;
        const activity = { tool: name, summary: out.summary || summarize(args), ok: !isError };
        if (isError) activity.error = oneLine(out.text, 300);
        if (warnings.length) activity.warning = oneLine(warnings.join(' '), 300);
        postActivity(activity);
        if (isError) return fail(text);
        if (!shotAfter) return ok(text);
        const display = Number.isInteger(out.display) ? out.display : Number.isInteger(args.display) ? args.display : undefined;
        const blocks = await shotAfterBlocks({ display, window: out.window, signal: extra && extra.signal });
        return { content: [{ type: 'text', text }, ...blocks] };
      },
    };
  }

  async function activeWindowOf(driver) {
    if (!driver || typeof driver.activeWindow !== 'function') return null;
    return withTimeout(driver.activeWindow(), 1500, null);
  }

  const tools = [];

  // ------------------------------------------------------------ screenshot
  tools.push({
    name: 'screenshot',
    title: 'Take screenshot',
    description: [
      'Capture one display and return it as a PNG image, followed by a line of text with the image size, the display, the scale, the mouse position and the active window.',
      'Take a screenshot before any GUI action and again after each action to verify what happened. Coordinates you pass to click, mouse_move, drag and scroll are pixels in your latest full screenshot of that display. The image may be downscaled from the real resolution; the server maps your coordinates back, so never rescale them yourself.',
      'To read small text or inspect a detail, pass region {x, y, width, height} in full-screenshot pixels to get a sharper zoomed crop. A zoom does not change the coordinate space: convert a point you find in it back to full-screenshot pixels (the response gives the formula) before clicking.',
      'The "Claude Anywhere" window is the user\'s control dialog; ignore it. When a CLI or API can do the job (git, gh, gcloud, aws, az, kubectl), prefer it over the GUI.',
    ].join('\n\n'),
    inputSchema: objectSchema({
      display: DISPLAY,
      region: {
        type: 'object',
        description: 'Optional zoom rectangle in pixels of your latest full screenshot of this display.',
        properties: {
          x: { type: 'number', minimum: 0, description: 'Left edge.' },
          y: { type: 'number', minimum: 0, description: 'Top edge.' },
          width: { type: 'number', minimum: 1, description: 'Width.' },
          height: { type: 'number', minimum: 1, description: 'Height.' },
        },
        required: ['x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
      maxWidth: { type: 'integer', minimum: 320, maximum: 3840, description: 'Downscale so the image is at most this wide (default 1366). Larger shows more detail but costs more tokens.' },
      maxHeight: { type: 'integer', minimum: 240, maximum: 2160, description: 'Downscale so the image is at most this tall (default 768).' },
    }),
    annotations: annotations('Take screenshot', { readOnly: true }),
    handler: async (args = {}) => {
      let shot;
      let active = null;
      try {
        const comp = await getComputer();
        shot = await comp.screenshot({ display: args.display == null ? 0 : args.display, region: args.region, maxWidth: args.maxWidth, maxHeight: args.maxHeight });
        active = await activeWindowOf(comp.driver);
      } catch (err) {
        postActivity({ tool: 'screenshot', summary: 'Screenshot', ok: false, error: oneLine(err && err.message, 300) });
        throw err;
      }
      const data = shot.png.toString('base64');
      const summary = shot.region
        ? `Zoomed screenshot of display ${shot.display} (${shot.region.width}x${shot.region.height} at ${shot.region.x},${shot.region.y})`
        : `Screenshot of display ${shot.display} (${shot.width}x${shot.height})`;
      postActivity({ tool: 'screenshot', summary, ok: true, image: data, width: shot.width, height: shot.height });
      return {
        content: [
          { type: 'image', data, mimeType: 'image/png' },
          { type: 'text', text: describeShot(shot, active) },
        ],
      };
    },
  });

  // ------------------------------------------------------------ click
  const MODIFIER = { type: 'string', enum: ['primary', 'ctrl', 'alt', 'shift', 'meta', 'cmd', 'option', 'win', 'super'] };
  tools.push(
    inputTool({
      name: 'click',
      title: 'Click',
      description: [
        'Click the mouse at (x, y), given in pixels of your latest screenshot of that display.',
        'clicks: 2 double-clicks (open an item, select a word), 3 triple-clicks (select a line or paragraph). button "right" opens context menus. modifiers are held during the click, e.g. ["shift"] to extend a selection or ["primary"] (Cmd on macOS, Ctrl elsewhere) to open a link in a new tab.',
        'Take a screenshot first so the coordinates are current, aim at the center of the target, then take another screenshot to verify (or pass screenshotAfter: true to get it with the result). When the target has a label, ui_click by name is more reliable than pixels. Never click inside the "Claude Anywhere" dialog.',
      ].join('\n\n'),
      inputSchema: objectSchema(
        {
          x: coord('X'),
          y: coord('Y'),
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
          clicks: { type: 'integer', minimum: 1, maximum: 3, description: '1 = single (default), 2 = double, 3 = triple click.' },
          modifiers: { type: 'array', items: MODIFIER, maxItems: 4, description: 'Keys held during the click, e.g. ["shift"] or ["primary"].' },
          display: DISPLAY,
          screenshotAfter: SHOT_AFTER,
        },
        ['x', 'y']
      ),
      annotations: annotations('Click', { destructive: true }),
      summarize: (a) => `${a.clicks === 2 ? 'Double-click' : a.clicks === 3 ? 'Triple-click' : 'Click'} ${a.button || 'left'} at (${num(a.x)}, ${num(a.y)})`,
      run: async (a) => {
        const comp = await getComputer();
        const r = await comp.click({ x: a.x, y: a.y, button: a.button || 'left', clicks: a.clicks || 1, modifiers: a.modifiers || [], display: a.display });
        const n = (r && r.clicks) || a.clicks || 1;
        const verb = n === 2 ? 'Double-clicked' : n === 3 ? 'Triple-clicked' : 'Clicked';
        const button = (r && r.button) || a.button || 'left';
        const x = r && Number.isFinite(r.x) ? r.x : a.x;
        const y = r && Number.isFinite(r.y) ? r.y : a.y;
        const display = r && Number.isInteger(r.display) ? r.display : a.display || 0;
        const mods = r && r.modifiers && r.modifiers.length ? ` with ${r.modifiers.join('+')} held` : '';
        return {
          text: `${verb} ${button} at (${num(x)}, ${num(y)}) on display ${display}${mods}. Take a screenshot to verify.`,
          summary: `${verb} ${button} at (${num(x)}, ${num(y)})${mods}`,
          warnings: r && r.warnings,
          display,
        };
      },
    })
  );

  // ------------------------------------------------------------ mouse_move
  tools.push(
    inputTool({
      name: 'mouse_move',
      title: 'Move mouse',
      description: 'Move the mouse pointer to (x, y), in pixels of your latest screenshot of that display, without clicking. Use it to reveal hover menus or tooltips (screenshotAfter shows them in the same call), or to put the pointer over a panel before scrolling.',
      inputSchema: objectSchema({ x: coord('X'), y: coord('Y'), display: DISPLAY, screenshotAfter: SHOT_AFTER }, ['x', 'y']),
      annotations: annotations('Move mouse', { idempotent: true }),
      summarize: (a) => `Move mouse to (${num(a.x)}, ${num(a.y)})`,
      run: async (a) => {
        const comp = await getComputer();
        const r = await comp.moveMouse({ x: a.x, y: a.y, display: a.display });
        const x = r && Number.isFinite(r.x) ? r.x : a.x;
        const y = r && Number.isFinite(r.y) ? r.y : a.y;
        const display = r && Number.isInteger(r.display) ? r.display : a.display || 0;
        return { text: `Moved the mouse to (${num(x)}, ${num(y)}) on display ${display}.`, summary: `Moved mouse to (${num(x)}, ${num(y)})`, display };
      },
    })
  );

  // ------------------------------------------------------------ drag
  tools.push(
    inputTool({
      name: 'drag',
      title: 'Drag',
      description: 'Press a mouse button at (fromX, fromY), move to (toX, toY) and release. Coordinates are pixels of your latest screenshot of that display. Use it for sliders, moving files or windows, resizing panes, drawing shapes on a canvas and selecting a range of text. Take a screenshot afterwards to verify (or pass screenshotAfter: true).',
      inputSchema: objectSchema(
        {
          fromX: coord('Start X'),
          fromY: coord('Start Y'),
          toX: coord('End X'),
          toY: coord('End Y'),
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
          display: DISPLAY,
          screenshotAfter: SHOT_AFTER,
        },
        ['fromX', 'fromY', 'toX', 'toY']
      ),
      annotations: annotations('Drag', { destructive: true }),
      summarize: (a) => `Drag from (${num(a.fromX)}, ${num(a.fromY)}) to (${num(a.toX)}, ${num(a.toY)})`,
      run: async (a) => {
        const comp = await getComputer();
        const r = await comp.drag({ fromX: a.fromX, fromY: a.fromY, toX: a.toX, toY: a.toY, button: a.button || 'left', display: a.display });
        const from = (r && r.from) || { x: a.fromX, y: a.fromY };
        const to = (r && r.to) || { x: a.toX, y: a.toY };
        const display = r && Number.isInteger(r.display) ? r.display : a.display || 0;
        const button = (r && r.button) || a.button || 'left';
        return {
          text: `Dragged with the ${button} button from (${num(from.x)}, ${num(from.y)}) to (${num(to.x)}, ${num(to.y)}) on display ${display}. Take a screenshot to verify.`,
          summary: `Dragged from (${num(from.x)}, ${num(from.y)}) to (${num(to.x)}, ${num(to.y)})`,
          warnings: r && r.warnings,
          display,
        };
      },
    })
  );

  // ------------------------------------------------------------ scroll
  tools.push(
    inputTool({
      name: 'scroll',
      title: 'Scroll',
      description: 'Turn the mouse wheel by `amount` notches (default 3, roughly three lines each) in a direction, at (x, y) when given (pixels of your latest screenshot) or at the current mouse position. The wheel scrolls whatever is under the pointer, so aim at the panel you want to scroll. Take a screenshot afterwards to see the new content (or pass screenshotAfter: true). In browsers the keys pagedown, space and end are alternatives.',
      inputSchema: objectSchema(
        {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
          amount: { type: 'integer', minimum: 1, maximum: 50, description: 'Wheel notches (default 3).' },
          x: coord('X', 'optional, defaults to the current mouse position'),
          y: coord('Y', 'optional, defaults to the current mouse position'),
          display: DISPLAY,
          screenshotAfter: SHOT_AFTER,
        },
        ['direction']
      ),
      annotations: annotations('Scroll'),
      summarize: (a) => `Scroll ${a.direction} ${a.amount || 3}${a.x != null && a.y != null ? ` at (${num(a.x)}, ${num(a.y)})` : ''}`,
      run: async (a) => {
        if ((a.x == null) !== (a.y == null)) throw toolError('Give both x and y, or neither to scroll at the current mouse position.', 'INVALID_INPUT');
        const comp = await getComputer();
        const r = await comp.scroll({ direction: a.direction, amount: a.amount || 3, x: a.x, y: a.y, display: a.display });
        const n = (r && r.amount) || a.amount || 3;
        const x = r && Number.isFinite(r.x) ? r.x : a.x;
        const y = r && Number.isFinite(r.y) ? r.y : a.y;
        const at = x != null && y != null ? ` at (${num(x)}, ${num(y)})` : '';
        const display = r && Number.isInteger(r.display) ? r.display : a.display || 0;
        return {
          text: `Scrolled ${a.direction} ${n} notch${n === 1 ? '' : 'es'}${at} on display ${display}. Take a screenshot to see the new content.`,
          summary: `Scrolled ${a.direction} ${n}${at}`,
          warnings: r && r.warnings,
          display,
        };
      },
    })
  );

  // ------------------------------------------------------------ type_text
  tools.push(
    inputTool({
      name: 'type_text',
      title: 'Type text',
      description: [
        'Type literal text into the window that has keyboard focus, as if typed on the keyboard (any Unicode). It does not press Enter: send key "enter" afterwards when needed.',
        'First make sure the right window and field have focus (focus_window, then click the field) and confirm with a screenshot; keystrokes go wherever the focus is. screenshotAfter: true shows the result in the same call.',
        'method: "auto" (default) types short text key by key and pastes long or multi-line text through the clipboard (restored afterwards); "keys" always types (use it where pasting is blocked); "paste" always pastes. To replace a field\'s whole text, ui_set_value is more reliable.',
        'Never type passwords, 2FA codes or payment details; ask the user to enter them.',
      ].join('\n\n'),
      inputSchema: objectSchema(
        {
          text: { type: 'string', minLength: 1, description: 'The exact text to type.' },
          method: { type: 'string', enum: ['auto', 'keys', 'paste'], description: 'How to enter the text (default auto).' },
          screenshotAfter: SHOT_AFTER,
        },
        ['text']
      ),
      annotations: annotations('Type text', { destructive: true }),
      summarize: (a) => `Type ${Array.from(String(a.text || '')).length} chars: "${oneLine(a.text, 60)}"`,
      run: async (a) => {
        const comp = await getComputer();
        const r = await comp.typeText({ text: a.text, method: a.method || 'auto' });
        const chars = r && Number.isFinite(r.chars) ? r.chars : Array.from(a.text).length;
        const how = r && r.method && r.method !== 'none' ? ` (${r.method === 'paste' ? 'pasted' : 'typed key by key'})` : '';
        return {
          text: `Typed ${chars} character${chars === 1 ? '' : 's'}${how} into the focused window. Take a screenshot to verify.`,
          summary: `Typed ${chars} chars: "${oneLine(a.text, 60)}"`,
          warnings: r && r.warnings,
        };
      },
    })
  );

  // ------------------------------------------------------------ key
  tools.push(
    inputTool({
      name: 'key',
      title: 'Press keys',
      description: [
        'Press a key or key combination in the focused window, e.g. "enter", "escape", "tab", "shift+tab", "primary+s" (save), "primary+t" (new tab), "primary+l" (browser address bar), "primary+shift+p", "alt+tab", "f5", "pagedown", "up".',
        '"primary" is Cmd on macOS and Ctrl on Windows and Linux. Modifiers: ctrl, alt (option), shift, meta (cmd, win, super). Named keys: enter, escape, tab, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, f1-f24, capslock, printscreen, menu, or any single character.',
        'repeat presses the combination several times (e.g. "down" with repeat 5). Focus the target window first. screenshotAfter: true returns the result on screen in the same call.',
      ].join('\n\n'),
      inputSchema: objectSchema(
        {
          combo: { type: 'string', minLength: 1, description: 'Keys joined with "+", e.g. "primary+s" or "enter".' },
          repeat: { type: 'integer', minimum: 1, maximum: 100, description: 'How many times to press it (default 1).' },
          screenshotAfter: SHOT_AFTER,
        },
        ['combo']
      ),
      annotations: annotations('Press keys', { destructive: true }),
      summarize: (a) => `Press ${a.combo}${a.repeat > 1 ? ` x${a.repeat}` : ''}`,
      run: async (a) => {
        const comp = await getComputer();
        const r = await comp.key({ combo: a.combo, repeat: a.repeat || 1 });
        const keys = r && Array.isArray(r.keys) && r.keys.length ? r.keys.join('+') : a.combo;
        const n = (r && r.repeat) || a.repeat || 1;
        const shown = keys.toLowerCase() === String(a.combo).toLowerCase() ? keys : `${a.combo} (${keys})`;
        return {
          text: `Pressed ${shown}${n > 1 ? ` ${n} times` : ''}. Take a screenshot to verify.`,
          summary: `Pressed ${shown}${n > 1 ? ` x${n}` : ''}`,
          warnings: r && r.warnings,
        };
      },
    })
  );

  // ------------------------------------------------------------ cursor_position
  tools.push({
    name: 'cursor_position',
    title: 'Mouse position',
    description: 'Get the mouse pointer position in pixels of your latest screenshot of the display it is on, plus that display index.',
    inputSchema: objectSchema({}),
    annotations: annotations('Mouse position', { readOnly: true, idempotent: true }),
    handler: async () => {
      const comp = await getComputer();
      const p = await comp.cursorPosition();
      const logical = p && p.logical ? ` (logical screen position ${num(p.logical.x)}, ${num(p.logical.y)})` : '';
      const est = p && p.estimated ? ' (estimated: this Wayland session cannot read the real pointer; this is the last position Claude set, so the user may have moved it)' : '';
      if (!p || p.x == null || p.display == null) return ok(`The mouse is outside every display${logical}${est}.`);
      return ok(`Mouse at (${num(p.x)}, ${num(p.y)}) in screenshot pixels of display ${p.display}${logical}${est}.`);
    },
  });

  // ------------------------------------------------------------ screen_info
  tools.push({
    name: 'screen_info',
    title: 'Screen info',
    description: 'List the displays (index, position, size in logical pixels, scale, which one is primary), the size of your latest screenshot of each, and what the desktop driver supports on this machine. Use it on multi-monitor setups to pick the display parameter, or to find out why a GUI tool is unavailable.',
    inputSchema: objectSchema({}),
    annotations: annotations('Screen info', { readOnly: true, idempotent: true }),
    handler: async () => {
      const comp = await getComputer();
      const info = await comp.screenInfo();
      const lines = [];
      for (const d of info.displays || []) {
        let line = `Display ${d.index}${d.primary ? ' (primary)' : ''}: ${d.width}x${d.height} logical px at (${d.x}, ${d.y}), scale ${num(d.scale || 1)}`;
        if (d.lastShot) line += `; your latest screenshot is ${d.lastShot.width}x${d.lastShot.height} (1 image px = ${num(d.lastShot.scale)} logical px)`;
        else line += '; no screenshot yet (take one before using coordinates)';
        lines.push(line);
      }
      const driver = comp.driver;
      if (driver && typeof driver.capabilities === 'function') {
        const caps = await withTimeout(driver.capabilities(), 3000, null);
        if (caps) {
          const keys = ['screenshot', 'mouse', 'keyboard', 'windows', 'clipboard', 'notify', 'speak'];
          const yes = keys.filter((k) => caps[k]);
          const no = keys.filter((k) => !caps[k]);
          lines.push(`Desktop driver: ${driver.name || 'unknown'}. Supported: ${yes.join(', ') || 'nothing'}${no.length ? `. Unavailable: ${no.join(', ')}` : ''}.`);
          if (Array.isArray(caps.notes) && caps.notes.length) lines.push(`Notes: ${caps.notes.map((s) => oneLine(s, 300)).join(' ')}`);
        }
      }
      return ok(lines.join('\n') || 'No displays were reported.');
    },
  });

  // ------------------------------------------------------------ list_windows
  tools.push({
    name: 'list_windows',
    title: 'List windows',
    description: 'List open application windows with their id, app, title, position, size and state (the focused one is marked). filter keeps windows whose app or title contains the text (case-insensitive). Pass an id to focus_window to switch to one. The "Claude Anywhere" dialog is left out.',
    inputSchema: objectSchema({ filter: { type: 'string', description: 'Optional case-insensitive substring of the app name or title.' } }),
    annotations: annotations('List windows', { readOnly: true }),
    handler: async (args = {}) => {
      const driver = await getDriver();
      const wins = (await driver.listWindows()) || [];
      let list = wins.filter((w) => !desktop.isOwnWindow(w));
      const f = lower(args.filter).trim();
      if (f) list = list.filter((w) => lower(w.app).includes(f) || lower(w.title).includes(f));
      if (!list.length) {
        const apps = [...new Set(wins.filter((w) => !desktop.isOwnWindow(w)).map((w) => w.app).filter(Boolean))];
        return ok(f ? `No windows match "${args.filter}". Open apps: ${apps.join(', ') || 'none'}.` : 'No application windows are open.');
      }
      list.sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)));
      const shown = list.slice(0, MAX_LISTED_WINDOWS);
      const header = `${list.length} window${list.length === 1 ? '' : 's'}${f ? ` matching "${args.filter}"` : ''}:`;
      const more = list.length > shown.length ? `\n(+${list.length - shown.length} more; use filter to narrow the list)` : '';
      return ok(`${header}\n${shown.map(windowLine).join('\n')}${more}`);
    },
  });

  // ------------------------------------------------------------ focus_window
  tools.push(
    inputTool({
      name: 'focus_window',
      title: 'Focus window',
      description: 'Bring a window to the front and give it keyboard focus. Identify it by id (from list_windows), or by a case-insensitive substring of its title and/or app name, e.g. {"app": "chrome"}, {"title": "Google Cloud console"} or {"app": "code", "title": "shop-api"}. If several windows match, nothing is focused and the candidates are listed: call again with an id. Take a screenshot afterwards and before typing (screenshotAfter: true includes one, of the window\'s display).',
      inputSchema: objectSchema({
        id: { type: 'string', description: 'Window id from list_windows.' },
        title: { type: 'string', description: 'Case-insensitive substring of the window title.' },
        app: { type: 'string', description: 'Case-insensitive substring of the application name.' },
        screenshotAfter: SHOT_AFTER,
      }),
      annotations: annotations('Focus window', { idempotent: true }),
      summarize: (a) => `Focus window ${a.id ? `id ${a.id}` : [a.app && `app "${a.app}"`, a.title && `title "${a.title}"`].filter(Boolean).join(' ')}`,
      run: async (a) => {
        const hasId = a.id != null && String(a.id).trim() !== '';
        if (!hasId && !String(a.title || '').trim() && !String(a.app || '').trim()) {
          throw toolError('Give id, title or app to choose the window (list_windows shows them).', 'INVALID_INPUT');
        }
        const driver = await getDriver();
        const wins = (await driver.listWindows()) || [];
        const matches = matchWindows(wins, a);
        const others = wins.filter((w) => !desktop.isOwnWindow(w));
        if (!matches.length) {
          const what = hasId ? `id ${a.id}` : [a.title && `title "${a.title}"`, a.app && `app "${a.app}"`].filter(Boolean).join(' and ');
          const listing = others.slice(0, 30).map(windowLine).join('\n');
          return { isError: true, text: `No window matches ${what}. Open windows:\n${listing || '(none)'}`, summary: `No window matches ${what}` };
        }
        if (matches.length > 1) {
          return {
            isError: true,
            text: `${matches.length} windows match; none was focused. Call focus_window again with one of these ids:\n${matches.slice(0, 30).map(windowLine).join('\n')}`,
            summary: `${matches.length} windows match; none focused`,
          };
        }
        const w = matches[0];
        const done = await driver.focusWindow(w.id);
        if (done === false) {
          throw toolError(
            `Could not focus ${windowLabel(w)} (id ${w.id}).`,
            'FOCUS_FAILED',
            'The OS may refuse to switch focus; take a screenshot and click the window instead, or use open with kind "app".'
          );
        }
        return { text: `Focused ${windowLabel(w)} (id ${w.id}). Take a screenshot to confirm it is in front before typing.`, summary: `Focused ${windowLabel(w)}`, window: w };
      },
    })
  );

  // ------------------------------------------------------------ open
  tools.push(
    inputTool({
      name: 'open',
      title: 'Open URL, file or app',
      description: [
        'Open a URL, a file or folder, or an application with the operating system\'s default handler.',
        'kind "auto" (default) decides: http(s), mailto and similar URLs open in the default browser, existing paths open in their default app, anything else is treated as an application name ("Google Chrome", "Visual Studio Code", "Terminal", "code", "firefox").',
        'args are extra command-line arguments for kind "app", e.g. {"target": "Google Chrome", "kind": "app", "args": ["https://console.cloud.google.com"]} to open a URL in a specific browser, or {"target": "code", "kind": "app", "args": ["/path/to/repo"]}.',
        'On macOS, URLs and existing files in args are handed to the app as documents, so they reach it even when it is already running; flags reach only an app that open starts (the result says when they were not passed); Chromium browsers (Chrome, Edge, Brave) get all args through a new instance that forwards them to the user\'s own browser window; a name that is not an installed app (e.g. "code") runs that command from PATH.',
        'Apps can take a few seconds to appear: wait, then take a screenshot.',
      ].join('\n\n'),
      inputSchema: objectSchema(
        {
          target: { type: 'string', minLength: 1, description: 'URL, file or folder path (absolute, relative or ~), or application name.' },
          kind: { type: 'string', enum: ['auto', 'url', 'path', 'app'], description: 'What target is (default auto).' },
          args: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Extra arguments when launching an app.' },
        },
        ['target']
      ),
      annotations: annotations('Open URL, file or app'),
      summarize: (a) => `Open ${oneLine(a.target, 100)}`,
      run: async (a) => {
        const r = await openTarget(a.target, { kind: a.kind || 'auto', args: a.args || [] });
        const kind = (r && r.kind) || a.kind || 'target';
        const how = r && r.how ? ` (via ${r.how})` : '';
        const target = (r && r.target) || a.target;
        const note = r && r.note ? ` ${r.note}` : '';
        return {
          text: `Opened ${kind} ${oneLine(target, 200)}${how}.${note} It may take a moment to appear; take a screenshot to verify.`,
          summary: `Opened ${kind} ${oneLine(target, 100)}`,
        };
      },
    })
  );

  // ------------------------------------------------------------ clipboard
  tools.push({
    name: 'clipboard_get',
    title: 'Read clipboard',
    description: 'Read the text currently on the system clipboard (for example after copying something with primary+c).',
    inputSchema: objectSchema({}),
    annotations: annotations('Read clipboard', { readOnly: true }),
    handler: async () => {
      const driver = await getDriver();
      const text = await driver.clipboardGet();
      if (text == null || text === '') return ok('(the clipboard is empty or holds no text)');
      const s = String(text);
      if (s.length > CLIPBOARD_MAX_CHARS) return ok(`${s.slice(0, CLIPBOARD_MAX_CHARS)}\n\n[clipboard truncated: showing ${CLIPBOARD_MAX_CHARS} of ${s.length} characters]`);
      return ok(s);
    },
  });

  tools.push(
    inputTool({
      name: 'clipboard_set',
      title: 'Write clipboard',
      description: 'Replace the system clipboard with this text. Follow with key "primary+v" to paste it into the focused field.',
      inputSchema: objectSchema({ text: { type: 'string', description: 'Text to put on the clipboard.' } }, ['text']),
      annotations: annotations('Write clipboard', { idempotent: true }),
      summarize: (a) => `Copy ${Array.from(String(a.text || '')).length} chars to the clipboard`,
      run: async (a) => {
        const driver = await getDriver();
        await driver.clipboardSet(String(a.text));
        const n = Array.from(String(a.text)).length;
        return { text: `Copied ${n} character${n === 1 ? '' : 's'} to the clipboard.`, summary: `Copied ${n} chars to the clipboard` };
      },
    })
  );

  // ------------------------------------------------------------ wait
  tools.push({
    name: 'wait',
    title: 'Wait',
    description: `Pause for a number of seconds (at most ${MAX_WAIT_SEC}) while a page loads, a build runs or an app starts. Prefer a short wait followed by a screenshot over one long wait.`,
    inputSchema: objectSchema({ seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SEC, description: `Seconds to wait (0-${MAX_WAIT_SEC}).` } }, ['seconds']),
    annotations: annotations('Wait', { readOnly: true, idempotent: true, openWorld: false }),
    handler: async (args = {}, extra = {}) => {
      const sec = Math.min(MAX_WAIT_SEC, Math.max(0, Number(args.seconds) || 0));
      await sleepAbortable(Math.round(sec * 1000), extra.signal);
      return ok(`Waited ${num(sec)} s. Take a screenshot to see the current state.`);
    },
  });

  // ------------------------------------------------------------ get_desktop_context
  tools.push({
    name: 'get_desktop_context',
    title: 'Desktop context',
    description: 'Describe what is open on the user\'s desktop right now, as JSON: OS and local time; the active window; every editor window with its workspace folder on disk (VS Code, Cursor, Windsurf, VSCodium, JetBrains IDEs, Zed, Sublime Text, Xcode); browser windows with their active tab\'s title (URLs are not captured) and recognized sites, e.g. the Google Cloud console with its project display name (not necessarily the project id); tickets named in tab titles (Jira, Linear, GitHub/GitLab issues, Azure Boards) as tickets: [{key, summary, browser, tracker}]; other windows; running apps by window count (apps) and the default browser (defaultBrowser); the project directory with git branch, remote, uncommitted changes and detected stack; and the active gcloud, aws, az, kubectl and docker contexts. Use it to resolve "this repo", "the project open in VS Code", "the GCP console in Chrome" or "my Jira ticket" (read_browser_tab gets the tab\'s URL).',
    inputSchema: objectSchema({}),
    annotations: annotations('Desktop context', { readOnly: true }),
    handler: async () => {
      let driver = null;
      try {
        const comp = await getComputer();
        driver = comp.driver || null;
      } catch (err) {
        log.debug('no driver for desktop context:', err && err.message);
      }
      const ctx = await gather({ driver, projectDir: process.env.ANYWHERE_PROJECT_DIR || process.cwd(), config });
      return ok(JSON.stringify(ctx, null, 2));
    },
  });

  // ------------------------------------------------------------ notify_user
  tools.push({
    name: 'notify_user',
    title: 'Notify user',
    description: 'Show a short status message to the user in the Claude Anywhere dialog (or as a desktop notification when the dialog is closed), optionally spoken aloud. Use it for milestones during long tasks ("Build finished, deploying to Cloud Run now"). Use ask_user for questions, and put the final answer in your reply.',
    inputSchema: objectSchema(
      {
        message: { type: 'string', minLength: 1, maxLength: 2000, description: 'One or two short sentences.' },
        level: { type: 'string', enum: ['info', 'success', 'warning', 'error'], description: 'Severity (default info).' },
        speak: { type: 'boolean', description: 'Also read the message aloud (default false).' },
      },
      ['message']
    ),
    annotations: annotations('Notify user', { idempotent: false }),
    handler: async (args = {}) => {
      const message = String(args.message);
      const level = args.level || 'info';
      const speak = Boolean(args.speak);
      const c = await client();
      if (c) {
        try {
          const res = await c.request('POST', '/api/mcp/notify', { message, level, speak }, { timeoutMs: NOTIFY_TIMEOUT_MS });
          if (!res || res.delivered !== false) return ok('The user was notified in the Anywhere dialog.');
        } catch (err) {
          log.debug('dialog notify failed, falling back to an OS notification:', err && err.message);
        }
      }
      const title = level === 'error' ? 'Claude Anywhere: error' : level === 'warning' ? 'Claude Anywhere: warning' : 'Claude Anywhere';
      let delivered = false;
      let why = '';
      try {
        await notifyOs(title, message);
        delivered = true;
      } catch (err) {
        why = oneLine(err && err.message, 200);
      }
      if (speak) {
        Promise.resolve()
          .then(() => speakOs(message, {}))
          .catch((err) => log.debug('speech failed:', err && err.message));
      }
      if (delivered) return ok('The Anywhere dialog is not open, so the user was notified with a desktop notification.');
      return ok(`The notification could not be shown (${why || 'no notification service'}). Mention it in your reply instead.`);
    },
  });

  // ------------------------------------------------------------ ask_user
  tools.push({
    name: 'ask_user',
    title: 'Ask user',
    description: [
      'Ask the user a question in the Claude Anywhere dialog and wait for the answer (typed or spoken).',
      'Use it whenever you need a decision or information to continue: which project, account or region to use; confirmation before an irreversible, costly, public or financial action (deploying to production, deleting resources, sending messages, purchases); or when the screen shows something unexpected.',
      'options become quick-reply buttons (the user may still type something else). The call blocks until the user answers or timeoutSec passes. Keep the question short and specific.',
    ].join('\n\n'),
    inputSchema: objectSchema(
      {
        question: { type: 'string', minLength: 1, maxLength: 4000, description: 'The question, in one or two sentences.' },
        options: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 10, description: 'Optional suggested answers shown as buttons.' },
        timeoutSec: { type: 'integer', minimum: 10, maximum: 3600, description: `How long to wait for an answer (default ${DEFAULT_ASK_TIMEOUT_SEC}).` },
      },
      ['question']
    ),
    annotations: annotations('Ask user', { readOnly: true, openWorld: false }),
    handler: async (args = {}, extra = {}) => {
      const c = await client();
      if (!c) return fail(NO_DIALOG_MESSAGE);
      const timeoutSec = Number.isFinite(args.timeoutSec) ? args.timeoutSec : DEFAULT_ASK_TIMEOUT_SEC;
      const body = { question: String(args.question), timeoutSec };
      if (Array.isArray(args.options) && args.options.length) body.options = args.options.map(String);
      const stop = keepAlive(extra, (s) => `Waiting for the user to answer in the Anywhere dialog (${s} s)`);
      try {
        const res = await daemonRequest(c, 'POST', '/api/mcp/ask', body, { timeoutMs: (timeoutSec + 30) * 1000, signal: extra.signal });
        if (res && typeof res.answer === 'string') {
          return ok(res.answer.trim() ? `The user answered: ${res.answer}` : 'The user sent an empty answer.');
        }
        if (res && res.timeout) {
          return fail(`The user did not answer within ${timeoutSec} s. Do not guess on anything risky: stop and explain what you need, or continue only with safe steps.`);
        }
        if (res && (res.cancelled || res.dismissed)) return fail('The user dismissed the question without answering.');
        return fail('The Anywhere dialog returned no answer. Ask the user in your normal reply instead.');
      } catch (err) {
        if (err && err.code === 'ABORTED') throw err;
        if (err && err.status === 404) return fail(NO_DIALOG_MESSAGE);
        // Bridge mode: the user stopped the command this terminal works on.
        if (err && err.status === 409 && err.data && err.data.code === 'COMMAND_STOPPED') {
          return fail('The user pressed Stop in the Anywhere dialog: abandon this command, do not continue its steps, and run "anywhere listen" for the next one.');
        }
        return fail(`Could not ask through the Anywhere dialog (${oneLine(err && err.message, 200)}). Ask the user in your normal reply instead.`);
      } finally {
        stop();
      }
    },
  });

  // ------------------------------------------------------------ permission_prompt
  tools.push({
    name: 'permission_prompt',
    title: 'Permission prompt',
    description: 'Internal: Claude Code calls this to ask the user to approve a tool call; the request appears as an approval card in the Claude Anywhere dialog. Do not call it yourself. Returns JSON {"behavior":"allow","updatedInput":{...}} or {"behavior":"deny","message":"..."}.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Name of the tool that needs approval.' },
        input: { type: 'object', description: 'The input the tool will be called with.' },
        tool_use_id: { type: 'string', description: 'The tool_use id, when known.' },
      },
      required: ['tool_name', 'input'],
    },
    annotations: annotations('Permission prompt', { readOnly: true, openWorld: false }),
    handler: async (args = {}, extra = {}) => {
      const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input) ? args.input : {};
      const toolName = String(args.tool_name);
      const c = await client();
      let decision;
      if (!c) {
        decision = { behavior: 'allow', updatedInput: input };
      } else {
        const stop = keepAlive(extra, (s) => `Waiting for the user to approve ${toolName} in the Anywhere dialog (${s} s)`);
        try {
          const body = { tool_name: toolName, input };
          if (args.tool_use_id) body.tool_use_id = String(args.tool_use_id);
          const res = await daemonRequest(c, 'POST', '/api/mcp/permission', body, { timeoutMs: PERMISSION_HTTP_TIMEOUT_MS, signal: extra.signal });
          if (res && res.behavior === 'allow') {
            const updated = res.updatedInput && typeof res.updatedInput === 'object' && !Array.isArray(res.updatedInput) ? res.updatedInput : input;
            decision = { behavior: 'allow', updatedInput: updated };
          } else if (res && res.behavior === 'deny') {
            decision = { behavior: 'deny', message: String(res.message || 'The user denied this action.') };
            if (res.interrupt === true) decision.interrupt = true;
          } else {
            decision = { behavior: 'deny', message: 'The Anywhere dialog returned an invalid permission decision, so the action was not run.' };
          }
        } catch (err) {
          if (err && err.code === 'ABORTED') throw err;
          decision = { behavior: 'deny', message: `Could not get approval from the Anywhere dialog (${oneLine(err && err.message, 200)}), so the action was not run.` };
        } finally {
          stop();
        }
      }
      return ok(JSON.stringify(decision));
    },
  });

  // ------------------------------------------------------------ batch_actions
  const BATCH_STEP = {
    type: 'object',
    description: 'One step: its type plus that action\'s arguments.',
    properties: {
      type: { type: 'string', enum: BATCH_STEP_TYPES, description: 'The action: click, double_click, right_click, move (mouse), drag, type (text), key, scroll, wait, focus_window or ui_click.' },
      x: { type: 'number', minimum: 0, description: 'click, double_click, right_click, move, scroll: X in pixels of your latest screenshot.' },
      y: { type: 'number', minimum: 0, description: 'click, double_click, right_click, move, scroll: Y in pixels of your latest screenshot.' },
      fromX: { type: 'number', minimum: 0, description: 'drag: start X.' },
      fromY: { type: 'number', minimum: 0, description: 'drag: start Y.' },
      toX: { type: 'number', minimum: 0, description: 'drag: end X.' },
      toY: { type: 'number', minimum: 0, description: 'drag: end Y.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click, drag: mouse button (default left).' },
      clicks: { type: 'integer', minimum: 1, maximum: 3, description: 'click: 1-3 (default 1).' },
      modifiers: { type: 'array', items: MODIFIER, maxItems: 4, description: 'click, double_click, right_click: keys held, e.g. ["shift"].' },
      display: DISPLAY,
      text: { type: 'string', maxLength: 100000, description: 'type: the exact text to type. ui_click: text in the element\'s name, value or description.' },
      method: { type: 'string', enum: ['auto', 'keys', 'paste'], description: 'type: how to enter the text (default auto).' },
      combo: { type: 'string', maxLength: 100, description: 'key: e.g. "enter", "tab", "primary+s", "alt+tab".' },
      repeat: { type: 'integer', minimum: 1, maximum: 100, description: 'key: how many presses (default 1).' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll: direction.' },
      amount: { type: 'integer', minimum: 1, maximum: 50, description: 'scroll: wheel notches (default 3).' },
      seconds: { type: 'number', minimum: 0, maximum: MAX_BATCH_WAIT_SEC, description: `wait: seconds (0-${MAX_BATCH_WAIT_SEC}).` },
      id: { type: 'string', maxLength: 600, description: 'focus_window: window id from list_windows. ui_click: element id from ui_find or ui_tree.' },
      title: { type: 'string', maxLength: 300, description: 'focus_window: part of the window title.' },
      app: { type: 'string', maxLength: 300, description: 'focus_window: part of the app name.' },
      name: { type: 'string', maxLength: 300, description: 'ui_click: the accessible name, e.g. "Save" or "For you".' },
      role: { type: 'string', maxLength: 60, description: 'ui_click: role filter, e.g. "button", "tab", "link".' },
      window: { type: 'string', maxLength: 300, description: 'ui_click: window id, or part of its title or app name (default: the active window).' },
      exact: { type: 'boolean', description: 'ui_click: match the whole name/text.' },
    },
    required: ['type'],
    additionalProperties: false,
  };

  tools.push({
    name: 'batch_actions',
    title: 'Run several actions',
    description: [
      `Run a short sequence of input actions in one call (at most ${MAX_BATCH_STEPS} steps), e.g. click a field, type, press enter: [{"type": "click", "x": 640, "y": 120}, {"type": "type", "text": "quarterly report"}, {"type": "key", "combo": "enter"}]. Each step takes the same arguments as its tool (click, mouse_move, drag, type_text, key, scroll, wait, focus_window, ui_click); double_click and right_click are click shortcuts, wait is at most ${MAX_BATCH_WAIT_SEC} s.`,
      'Steps run in order. The pause guard is checked before each one, and the batch stops at the first step that fails; the result says which steps ran. All coordinates refer to the screenshot you had before the call, so batch only steps whose targets do not move in between (typing into a field you just clicked, a known key sequence); take a screenshot (or screenshotAfter) before acting on what the batch changed.',
      'screenshotAfter returns a fresh screenshot after the last step. The approval card lists every step and is as risky as the riskiest one.',
    ].join('\n\n'),
    inputSchema: objectSchema(
      {
        actions: { type: 'array', minItems: 1, maxItems: MAX_BATCH_STEPS, items: BATCH_STEP, description: 'The steps, in order: {"type": ..., plus that action\'s arguments}.' },
        screenshotAfter: SHOT_AFTER,
      },
      ['actions']
    ),
    annotations: annotations('Run several actions', { destructive: true }),
    handler: async (args = {}, extra = {}) => {
      const steps = Array.isArray(args.actions) ? args.actions : [];
      if (!steps.length) {
        throw toolError('actions must list at least one step, e.g. [{"type": "click", "x": 100, "y": 200}, {"type": "type", "text": "hello"}, {"type": "key", "combo": "enter"}].', 'INVALID_INPUT');
      }
      if (steps.length > MAX_BATCH_STEPS) throw toolError(`A batch has at most ${MAX_BATCH_STEPS} steps (got ${steps.length}); split it into several calls.`, 'INVALID_INPUT');
      steps.forEach((s, i) => {
        const problem = batchStepProblem(s);
        if (problem) throw toolError(`Step ${i + 1} (${batchStepLabel(s)}): ${problem}. Nothing was run.`, 'INVALID_INPUT');
      });
      const byName = new Map(tools.map((t) => [t.name, t]));
      const done = [];
      let failure = null;
      let lastDisplay;
      for (let i = 0; i < steps.length; i += 1) {
        const call = batchStepCall(steps[i]);
        const tool = byName.get(call.tool);
        try {
          if (extra && extra.signal && extra.signal.aborted) throw abortError(extra.signal);
          if (!tool) {
            throw toolError(
              `${call.tool} is not available in this session`,
              'UNSUPPORTED',
              call.tool === 'ui_click' ? 'Click the element by its position (click with x, y) instead.' : undefined
            );
          }
          // Input tools check the guard themselves; anything else (wait, module tools) is checked here.
          if (!guardedTools.has(call.tool)) await checkGuard();
          const res = await tool.handler(call.args, extra);
          const text = withoutVerifyHint(
            (res && Array.isArray(res.content) ? res.content : [])
              .filter((c) => c && c.type === 'text')
              .map((c) => c.text)
              .join(' ')
          ).replace(/\s*\n+\s*/g, ' ');
          if (res && res.isError) {
            failure = { index: i, text: text || 'the step reported an error' };
            break;
          }
          done.push(`${i + 1}. ${text || 'Done.'}`);
          if (Number.isInteger(call.args.display)) lastDisplay = call.args.display;
        } catch (err) {
          if (err && err.code === 'ABORTED') throw err;
          failure = { index: i, text: oneLine(err && err.message, 500) || 'unknown error', code: err && err.code, hint: err && err.hint };
          break;
        }
      }
      const n = steps.length;
      let text;
      if (!failure) {
        text = `Ran all ${n} step${n === 1 ? '' : 's'}:\n${done.join('\n')}`;
        if (args.screenshotAfter !== true) text += '\nTake a screenshot (or pass screenshotAfter) to verify the result.';
      } else {
        const f = failure;
        const lines = [`Step ${f.index + 1} of ${n} (${batchStepLabel(steps[f.index])}) failed: ${f.text}`];
        if (f.hint) lines.push(`Hint: ${f.hint}`);
        const left = n - f.index - 1;
        if (left > 0) lines.push(left === 1 ? `Step ${n} was not run.` : `Steps ${f.index + 2}-${n} were not run.`);
        lines.push(done.length ? `Done before it:\n${done.join('\n')}` : 'No step ran before it.');
        text = lines.join('\n');
      }
      // Stopped by the user (Stop, the top-left corner): no more screen activity, not even a capture.
      const stopped = Boolean(failure && (failure.code === 'PAUSED' || failure.code === 'FAILSAFE'));
      const content = [{ type: 'text', text }];
      if (args.screenshotAfter === true && !stopped) {
        content.push(...(await shotAfterBlocks({ display: lastDisplay, signal: extra && extra.signal })));
      }
      return failure ? { content, isError: true } : { content };
    },
  });

  // permission_prompt is plumbing for the daemon's engine (--permission-prompt-tool).
  // Interactive sessions have Claude Code's own prompts, so keep it away from the model there.
  // Feature modules (src/mcp/tools-*.js) contribute their own tools: each exports
  // createTools(ctx) -> [{name, description, inputSchema, annotations, handler}].
  // ext.screenshotAfter(result, args, opts) appends a fresh screenshot when args.screenshotAfter is
  // true (or, called with just {display}, returns the [image, text] blocks): see screenshotAfter above.
  const ext = {
    computer,
    getClient,
    config,
    role,
    progressIntervalMs,
    deps,
    getComputer,
    getDriver,
    client,
    checkGuard,
    postActivity,
    keepAlive,
    ok,
    fail,
    daemonRequest,
    objectSchema,
    annotations,
    screenshotAfter,
    screenshotAfterSchema: SHOT_AFTER,
  };
  for (const name of TOOL_MODULES) {
    const mod = loadOptional(`./${name}`);
    if (mod && typeof mod.createTools === 'function') tools.push(...mod.createTools(ext));
  }

  const out = role === 'engine' ? tools : tools.filter((t) => t.name !== 'permission_prompt');
  // The shared context the feature modules got (tests check ext.screenshotAfter through it).
  Object.defineProperty(out, 'ext', { value: ext, enumerable: false });
  return out;
}

/** Optional feature modules that add tools (missing ones are skipped). */
const TOOL_MODULES = ['tools-browser', 'tools-jira', 'tools-project', 'tools-calls', 'tools-ui', 'tools-ocr', 'tools-desktop'];

/** require() a sibling module that may not exist; other load errors still throw. */
function loadOptional(rel) {
  try {
    return require(rel);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(rel.replace(/^\.\//, ''))) return null;
    throw err;
  }
}

/** Names of all tools in contract order. */
const TOOL_NAMES = [
  'screenshot', 'click', 'mouse_move', 'drag', 'scroll', 'type_text', 'key', 'cursor_position', 'screen_info',
  'list_windows', 'focus_window', 'open', 'clipboard_get', 'clipboard_set', 'wait', 'get_desktop_context',
  'notify_user', 'ask_user', 'permission_prompt',
];

/** Core tools after the contract ones (TOOL_NAMES), before the feature modules' tools. */
const EXTRA_TOOL_NAMES = ['batch_actions'];

/** Core tools that take screenshotAfter (ui_click and ui_set_value get it from tools-ui via ext). */
const SCREENSHOT_AFTER_TOOLS = ['click', 'mouse_move', 'drag', 'scroll', 'type_text', 'key', 'focus_window', 'batch_actions'];

module.exports = {
  createTools,
  TOOL_NAMES,
  EXTRA_TOOL_NAMES,
  TOOL_MODULES,
  BATCH_STEP_TYPES,
  BATCH_STEP_TOOL,
  SCREENSHOT_AFTER_TOOLS,
  MAX_BATCH_STEPS,
  MAX_BATCH_WAIT_SEC,
  SHOT_AFTER_SETTLE_MS,
  SHOT_AFTER_MAX_WIDTH,
  SHOT_AFTER_MAX_HEIGHT,
  // helpers exported for tests
  daemonRequest,
  matchWindows,
  describeShot,
  sameWindowId,
  batchStepCall,
  batchStepProblem,
  batchStepLabel,
  withoutVerifyHint,
  NO_DIALOG_MESSAGE,
};
