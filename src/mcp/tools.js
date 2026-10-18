'use strict';

/**
 * The 19 tools of the `anywhere` MCP server: screen and input control through
 * a Computer, window/app/clipboard helpers through its driver, desktop
 * context, and the dialog bridge (notify_user, ask_user, permission_prompt)
 * through the daemon's /api/mcp/* endpoints.
 *
 * Every input action first asks the daemon whether the user paused Claude
 * (GET /api/mcp/guard, 200 ms budget, failures mean "allowed") and afterwards
 * reports itself to the dialog's activity feed (fire-and-forget).
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

// ---------------------------------------------------------------- schemas

const DISPLAY = {
  type: 'integer',
  minimum: 0,
  maximum: 15,
  description: 'Display index, 0-based: 0 is the primary display (the default). screen_info lists all displays.',
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
 *   role?: 'engine'|'interactive', progressIntervalMs?: number,
 *   deps?: {notify?:Function, speak?:Function, openTarget?:Function, gatherContext?:Function}}} opts
 *   computer: a Computer, a promise of one, or a lazy factory returning one.
 * @returns {{name:string,title:string,description:string,inputSchema:object,annotations:object,handler:Function}[]}
 */
function createTools({ computer, getClient, config = {}, role = 'interactive', progressIntervalMs = PROGRESS_INTERVAL_MS, deps = {} } = {}) {
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

  /**
   * Wrap an input action: guard → run → activity. `run` returns
   * {text, summary?, isError?}; thrown errors become isError results upstream.
   */
  function inputTool({ name, title, description, inputSchema, annotations: ann, summarize, run }) {
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
        // Input the OS may have dropped silently (Windows UIPI: another account's window).
        const warnings = Array.isArray(out.warnings) ? out.warnings.filter((w) => typeof w === 'string' && w) : [];
        const text = warnings.length ? `${out.text}\n\nWarning: ${warnings.join('\nWarning: ')}` : out.text;
        const activity = { tool: name, summary: out.summary || summarize(args), ok: !isError };
        if (isError) activity.error = oneLine(out.text, 300);
        if (warnings.length) activity.warning = oneLine(warnings.join(' '), 300);
        postActivity(activity);
        return isError ? fail(text) : ok(text);
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
        'Take a screenshot first so the coordinates are current, aim at the center of the target, then take another screenshot to verify. Never click inside the "Claude Anywhere" dialog.',
      ].join('\n\n'),
      inputSchema: objectSchema(
        {
          x: coord('X'),
          y: coord('Y'),
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
          clicks: { type: 'integer', minimum: 1, maximum: 3, description: '1 = single (default), 2 = double, 3 = triple click.' },
          modifiers: { type: 'array', items: MODIFIER, maxItems: 4, description: 'Keys held during the click, e.g. ["shift"] or ["primary"].' },
          display: DISPLAY,
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
        };
      },
    })
  );

  // ------------------------------------------------------------ mouse_move
  tools.push(
    inputTool({
      name: 'mouse_move',
      title: 'Move mouse',
      description: 'Move the mouse pointer to (x, y), in pixels of your latest screenshot of that display, without clicking. Use it to reveal hover menus or tooltips, or to put the pointer over a panel before scrolling.',
      inputSchema: objectSchema({ x: coord('X'), y: coord('Y'), display: DISPLAY }, ['x', 'y']),
      annotations: annotations('Move mouse', { idempotent: true }),
      summarize: (a) => `Move mouse to (${num(a.x)}, ${num(a.y)})`,
      run: async (a) => {
        const comp = await getComputer();
        const r = await comp.moveMouse({ x: a.x, y: a.y, display: a.display });
        const x = r && Number.isFinite(r.x) ? r.x : a.x;
        const y = r && Number.isFinite(r.y) ? r.y : a.y;
        const display = r && Number.isInteger(r.display) ? r.display : a.display || 0;
        return { text: `Moved the mouse to (${num(x)}, ${num(y)}) on display ${display}.`, summary: `Moved mouse to (${num(x)}, ${num(y)})` };
      },
    })
  );

  // ------------------------------------------------------------ drag
  tools.push(
    inputTool({
      name: 'drag',
      title: 'Drag',
      description: 'Press a mouse button at (fromX, fromY), move to (toX, toY) and release. Coordinates are pixels of your latest screenshot of that display. Use it for sliders, moving files or windows, resizing panes and selecting a range of text. Take a screenshot afterwards to verify.',
      inputSchema: objectSchema(
        {
          fromX: coord('Start X'),
          fromY: coord('Start Y'),
          toX: coord('End X'),
          toY: coord('End Y'),
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
          display: DISPLAY,
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
        };
      },
    })
  );

  // ------------------------------------------------------------ scroll
  tools.push(
    inputTool({
      name: 'scroll',
      title: 'Scroll',
      description: 'Turn the mouse wheel by `amount` notches (default 3, roughly three lines each) in a direction, at (x, y) when given (pixels of your latest screenshot) or at the current mouse position. The wheel scrolls whatever is under the pointer, so aim at the panel you want to scroll. Take a screenshot afterwards to see the new content. In browsers the keys pagedown, space and end are alternatives.',
      inputSchema: objectSchema(
        {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
          amount: { type: 'integer', minimum: 1, maximum: 50, description: 'Wheel notches (default 3).' },
          x: coord('X', 'optional, defaults to the current mouse position'),
          y: coord('Y', 'optional, defaults to the current mouse position'),
          display: DISPLAY,
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
        'First make sure the right window and field have focus (focus_window, then click the field) and confirm with a screenshot; keystrokes go wherever the focus is.',
        'method: "auto" (default) types short text key by key and pastes long or multi-line text through the clipboard (restored afterwards); "keys" always types (use it where pasting is blocked); "paste" always pastes.',
        'Never type passwords, 2FA codes or payment details; ask the user to enter them.',
      ].join('\n\n'),
      inputSchema: objectSchema(
        {
          text: { type: 'string', minLength: 1, description: 'The exact text to type.' },
          method: { type: 'string', enum: ['auto', 'keys', 'paste'], description: 'How to enter the text (default auto).' },
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
        'repeat presses the combination several times (e.g. "down" with repeat 5). Focus the target window first.',
      ].join('\n\n'),
      inputSchema: objectSchema(
        {
          combo: { type: 'string', minLength: 1, description: 'Keys joined with "+", e.g. "primary+s" or "enter".' },
          repeat: { type: 'integer', minimum: 1, maximum: 100, description: 'How many times to press it (default 1).' },
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
      if (!p || p.x == null || p.display == null) return ok(`The mouse is outside every display${logical}.`);
      return ok(`Mouse at (${num(p.x)}, ${num(p.y)}) in screenshot pixels of display ${p.display}${logical}.`);
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
      description: 'Bring a window to the front and give it keyboard focus. Identify it by id (from list_windows), or by a case-insensitive substring of its title and/or app name, e.g. {"app": "chrome"}, {"title": "Google Cloud console"} or {"app": "code", "title": "shop-api"}. If several windows match, nothing is focused and the candidates are listed: call again with an id. Take a screenshot afterwards and before typing.',
      inputSchema: objectSchema({
        id: { type: 'string', description: 'Window id from list_windows.' },
        title: { type: 'string', description: 'Case-insensitive substring of the window title.' },
        app: { type: 'string', description: 'Case-insensitive substring of the application name.' },
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
        return { text: `Focused ${windowLabel(w)} (id ${w.id}). Take a screenshot to confirm it is in front before typing.`, summary: `Focused ${windowLabel(w)}` };
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
        return {
          text: `Opened ${kind} ${oneLine(target, 200)}${how}. It may take a moment to appear; take a screenshot to verify.`,
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
    description: 'Describe what is open on the user\'s desktop right now, as JSON: OS and local time; the active window; every editor window with its workspace folder on disk (VS Code, Cursor, Windsurf, VSCodium, JetBrains IDEs, Zed, Sublime Text, Xcode); browser windows with their tab titles and recognized sites such as the Google Cloud console; other windows; the project directory with git branch, remote, uncommitted changes and detected stack; and the active gcloud, aws, az, kubectl and docker contexts. Use it to resolve "this repo", "the project open in VS Code" or "the GCP console in Chrome".',
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

  // permission_prompt is plumbing for the daemon's engine (--permission-prompt-tool).
  // Interactive sessions have Claude Code's own prompts, so keep it away from the model there.
  return role === 'engine' ? tools : tools.filter((t) => t.name !== 'permission_prompt');
}

/** Names of all tools in contract order. */
const TOOL_NAMES = [
  'screenshot', 'click', 'mouse_move', 'drag', 'scroll', 'type_text', 'key', 'cursor_position', 'screen_info',
  'list_windows', 'focus_window', 'open', 'clipboard_get', 'clipboard_set', 'wait', 'get_desktop_context',
  'notify_user', 'ask_user', 'permission_prompt',
];

module.exports = {
  createTools,
  TOOL_NAMES,
  // helpers exported for tests
  daemonRequest,
  matchWindows,
  describeShot,
  sameWindowId,
  NO_DIALOG_MESSAGE,
};
