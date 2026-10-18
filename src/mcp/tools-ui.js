'use strict';

/**
 * ui_find, ui_tree, ui_click, ui_set_value: the controls of any app through the platform's
 * accessibility API (AT-SPI on Linux, the AX API on macOS, UI Automation on Windows), via the
 * Computer's uiFind/uiTree/uiClick/uiSetValue (docs/ARCHITECTURE.md §4 and §6). Loaded by
 * src/mcp/tools.js (TOOL_MODULES) with the shared tool context `ext`.
 *
 * Elements come with ids (opaque, valid for a while, re-resolved when the window changes) and with
 * their centre in pixels of the latest screenshot, so the model can press them without guessing
 * coordinates, or click the point itself. ui_click and ui_set_value are input actions: the user's
 * pause guard first, then the Computer's guard and failsafe; they can return a fresh screenshot
 * (screenshotAfter) after a short settle delay.
 */

const desktop = require('../context/desktop');
const { sameWindowId } = require('../os/linux');
const { truncate } = require('../shared/util');
const { createLogger } = require('../shared/log');

const log = createLogger('mcp-ui');

const SETTLE_MS = 400;
const LIST_TIMEOUT_MS = 10000;
const DEFAULT_FIND_LIMIT = 10;
const MAX_FIND_LIMIT = 50;
const DEFAULT_TREE_DEPTH = 8;
const MAX_TREE_DEPTH = 20;
const DEFAULT_TREE_NODES = 200;
const MAX_TREE_NODES = 300;
const MAX_WINDOWS_LISTED = 15;
const ROLES = [
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listitem', 'menuitem', 'menu', 'tab', 'tablist',
  'treeitem', 'image', 'text', 'heading', 'window', 'toolbar', 'group', 'table', 'row', 'cell', 'slider', 'other',
];

function toolError(message, code, hint) {
  const err = new Error(message);
  if (code) err.code = code;
  if (hint) err.hint = hint;
  return err;
}

function oneLine(s, max = 200) {
  return truncate(String(s == null ? '' : s).replace(/\s+/g, ' ').trim(), max);
}

function lower(s) {
  return String(s == null ? '' : s).toLowerCase();
}

function hasText(v) {
  return v != null && String(v).trim() !== '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(toolError(`${what} took longer than ${Math.round(ms / 1000)} s`, 'TIMEOUT')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function windowLabel(w) {
  if (!w) return 'the active window';
  const app = oneLine(w.app, 60);
  const title = oneLine(w.title, 100);
  if (!title || title === app) return app || 'an untitled window';
  return app ? `${app} — "${title}"` : `"${title}"`;
}

/** Windows best first: focused, not minimized, then frontmost (stackIndex; list order otherwise). */
function rankWindows(list) {
  return list
    .map((w, i) => ({ w, i }))
    .sort((a, b) => {
      const f = Number(Boolean(b.w.focused)) - Number(Boolean(a.w.focused));
      if (f) return f;
      const m = Number(Boolean(a.w.minimized)) - Number(Boolean(b.w.minimized));
      if (m) return m;
      const sa = Number.isInteger(a.w.stackIndex) ? a.w.stackIndex : Infinity;
      const sb = Number.isInteger(b.w.stackIndex) ? b.w.stackIndex : Infinity;
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.w);
}

/**
 * The window a UI tool is about: an id from list_windows, else part of a title, else part of an
 * app name. Without one, the focused window, or, while the Claude Anywhere dialog has focus, the
 * frontmost other window. Desktops that cannot list windows (GNOME/KDE Wayland) use the active window.
 * @returns {Promise<{id:string|undefined, window:object|null, note?:string}>}
 */
async function resolveWindow(driver, spec) {
  const s = hasText(spec) ? String(spec).trim() : '';
  let wins = null;
  try {
    wins = (await withTimeout(driver.listWindows(), LIST_TIMEOUT_MS, 'Listing windows')) || [];
  } catch (err) {
    if (!err || err.code !== 'UNSUPPORTED') throw err;
  }
  if (!wins) return { id: s || undefined, window: null };
  const others = wins.filter((w) => !desktop.isOwnWindow(w));
  if (!s) {
    const focused = wins.find((w) => w.focused);
    if (focused && !desktop.isOwnWindow(focused)) return { id: String(focused.id), window: focused };
    const ranked = rankWindows(others.filter((w) => !w.minimized));
    if (!ranked.length) return { id: undefined, window: null };
    const note = focused ? 'The Claude Anywhere dialog has focus, so the frontmost other window was used.' : undefined;
    return { id: String(ranked[0].id), window: ranked[0], note };
  }
  const byId = wins.find((w) => sameWindowId(w.id, s));
  if (byId) return { id: String(byId.id), window: byId };
  const q = lower(s);
  let matches = others.filter((w) => lower(w.title).includes(q));
  if (!matches.length) matches = others.filter((w) => lower(w.app).includes(q));
  // A window handle list_windows does not show (a Windows pop-up menu or drop-down that ui_tree
  // reported under "Open pop-ups"): the driver checks it.
  if (!matches.length && /^(0x[0-9a-f]+|\d+)$/i.test(s)) return { id: s, window: null };
  if (!matches.length) {
    const listing = rankWindows(others)
      .slice(0, MAX_WINDOWS_LISTED)
      .map((w) => `- id ${w.id}: ${windowLabel(w)}`)
      .join('\n');
    throw toolError(`No window matches "${s}". Open windows:\n${listing || '(none)'}`, 'NOT_FOUND', 'Pass a window id from list_windows, or part of its title or app name.');
  }
  const ranked = rankWindows(matches);
  const note = matches.length > 1 ? `${matches.length} windows match "${s}"; the frontmost one was used (pass a window id for another).` : undefined;
  return { id: String(ranked[0].id), window: ranked[0], note };
}

function quoted(s, max) {
  return `"${oneLine(s, max).replace(/"/g, '\\"')}"`;
}

function flagsOf(m) {
  const f = [];
  if (m.enabled === false) f.push('disabled');
  if (m.focused) f.push('focused');
  if (m.selected) f.push('selected');
  if (m.checked === true) f.push('checked');
  else if (m.checked === 'mixed') f.push('mixed');
  if (m.expanded === true) f.push('expanded');
  else if (m.expanded === false) f.push('collapsed');
  if (m.offscreen) f.push('off screen');
  return f.length ? ` [${f.join(', ')}]` : '';
}

function pointOf(m, baseDisplay) {
  if (!m.shot) return '';
  const d = Number.isInteger(m.shot.display) && m.shot.display !== baseDisplay ? ` d${m.shot.display}` : '';
  return ` (${m.shot.cx}, ${m.shot.cy}${d})`;
}

/** One search result: role "name" = "value" at (x, y) on display d [flags] · id. */
function matchLine(m) {
  const value = hasText(m.value) && oneLine(m.value, 60) !== oneLine(m.name, 60) ? ` = ${quoted(m.value, 60)}` : '';
  const at = m.shot ? ` at (${m.shot.cx}, ${m.shot.cy}) on display ${m.shot.display}` : '';
  return `- ${m.role}${hasText(m.name) ? ` ${quoted(m.name, 80)}` : ''}${value}${at}${flagsOf(m)} · id ${m.id}`;
}

/** The display most nodes are on (for the outline's header). */
function mainDisplay(nodes) {
  const counts = new Map();
  for (const n of nodes) if (n.shot && Number.isInteger(n.shot.display)) counts.set(n.shot.display, (counts.get(n.shot.display) || 0) + 1);
  let best = 0;
  let max = -1;
  for (const [d, c] of counts) {
    if (c > max) {
      best = d;
      max = c;
    }
  }
  return best;
}

/**
 * The tree as an indented outline: one line per node, children indented under their parent, at
 * most `max` nodes in document order.
 */
function formatOutline(nodes, max = MAX_TREE_NODES) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots = nodes.filter((n) => !n.parent || !byId.has(n.parent));
  const base = mainDisplay(nodes);
  const lines = [];
  const seen = new Set();
  const walk = (n, depth) => {
    if (lines.length >= max || seen.has(n.id)) return;
    seen.add(n.id);
    const value = hasText(n.value) && oneLine(n.value, 60) !== oneLine(n.name, 60) ? ` = ${quoted(n.value, 60)}` : '';
    const more = n.more ? ' …' : '';
    lines.push(`${'  '.repeat(depth)}${n.role}${hasText(n.name) ? ` ${quoted(n.name, 80)}` : ''}${value}${pointOf(n, base)}${flagsOf(n)}${more} · ${n.id}`);
    for (const c of n.children || []) if (byId.has(c)) walk(byId.get(c), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return { text: lines.join('\n'), shown: lines.length, display: base };
}

/**
 * The driver's notes (macOS, Linux: switched-on Chromium/Electron trees, sparse apps, partial
 * results), warnings (Windows: a window that exposes almost nothing) and open pop-ups (Windows:
 * menus and drop-downs of the same app, each a window ui_tree can read), as lines for the model.
 */
function notesText(res) {
  const strings = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === 'string' && n) : []);
  const notes = [...strings(res && res.notes), ...strings(res && res.warnings)].filter((n, i, all) => all.indexOf(n) === i);
  let out = notes.length ? `\nNote: ${notes.map((n) => oneLine(n, 400)).join('\nNote: ')}` : '';
  const popups = res && Array.isArray(res.popups) ? res.popups.filter((p) => p != null && String(p).trim()) : [];
  if (popups.length) out += `\nOpen pop-ups (menus, drop-downs) of this app: ${popups.map((p) => `window ${oneLine(p, 40)}`).join(', ')}; read one with ui_tree {"window": "<id>"}.`;
  return out;
}

function queryLabel(a) {
  const role = hasText(a.role) ? a.role : 'element';
  if (hasText(a.name) && hasText(a.text)) return `${role} named ${quoted(a.name, 60)} containing ${quoted(a.text, 60)}`;
  if (hasText(a.name)) return `${role} named ${quoted(a.name, 60)}`;
  if (hasText(a.text)) return `${role} with text ${quoted(a.text, 60)}`;
  return `${role}s`;
}

// ---------------------------------------------------------------- tools

/**
 * @param {object} ext the shared tool context from src/mcp/tools.js
 * @returns {object[]} [ui_find, ui_tree, ui_click, ui_set_value]
 */
function createTools(ext = {}) {
  const { getComputer, checkGuard, postActivity, ok, fail, objectSchema, annotations } = ext;
  const guard = typeof checkGuard === 'function' ? checkGuard : async () => {};
  const activity = typeof postActivity === 'function' ? postActivity : () => {};
  const okText = typeof ok === 'function' ? ok : (text) => ({ content: [{ type: 'text', text }] });
  const failText = typeof fail === 'function' ? fail : (text) => ({ content: [{ type: 'text', text }], isError: true });
  const schema =
    typeof objectSchema === 'function'
      ? objectSchema
      : (properties, required = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
  const ann =
    typeof annotations === 'function'
      ? annotations
      : (title, { readOnly = false, destructive = false, idempotent = false } = {}) => ({
          title,
          readOnlyHint: readOnly,
          destructiveHint: readOnly ? false : destructive,
          idempotentHint: idempotent,
          openWorldHint: true,
        });

  async function computer() {
    if (typeof getComputer !== 'function') throw toolError('Desktop control is not available in this process.', 'UNSUPPORTED');
    const comp = await getComputer();
    if (!comp || typeof comp.uiFind !== 'function') {
      throw toolError('This desktop driver cannot read the controls of apps.', 'UNSUPPORTED', 'Take a screenshot (or use find_text) and click by position instead.');
    }
    return comp;
  }

  /**
   * A fresh screenshot after an action (screenshotAfter): ext.screenshotAfter when the core tools
   * provide it (async ({display}) -> content blocks), else one taken here after SETTLE_MS.
   */
  async function screenshotBlocks(comp, display) {
    if (typeof ext.screenshotAfter === 'function') {
      const blocks = await ext.screenshotAfter({ display });
      if (Array.isArray(blocks)) return blocks;
    }
    await sleep(SETTLE_MS);
    try {
      const shot = await comp.screenshot({ display: Number.isInteger(display) ? display : 0 });
      let active = null;
      try {
        active = comp.driver && typeof comp.driver.activeWindow === 'function' ? await withTimeout(comp.driver.activeWindow(), 1500, 'Reading the active window') : null;
      } catch {
        active = null;
      }
      const data = shot.png.toString('base64');
      activity({ tool: 'screenshot', summary: `Screenshot of display ${shot.display} (${shot.width}x${shot.height})`, ok: true, image: data, width: shot.width, height: shot.height });
      let text;
      try {
        text = require('./tools').describeShot(shot, active);
      } catch {
        text = `Screenshot of display ${shot.display}: ${shot.width}x${shot.height} px.`;
      }
      return [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text }];
    } catch (err) {
      log.debug('screenshot after a UI action failed:', err && err.message);
      return [{ type: 'text', text: `(No screenshot afterwards: ${oneLine(err && err.message, 200)})` }];
    }
  }

  /** Guard -> run -> activity, like tools.js inputTool, with an optional screenshot afterwards. */
  function uiInputTool({ name, title, description, inputSchema, summarize, run }) {
    return {
      name,
      title,
      description,
      inputSchema,
      annotations: ann(title, { destructive: true }),
      handler: async (args = {}) => {
        await guard();
        let out;
        let comp;
        try {
          comp = await computer();
          out = await run(comp, args);
        } catch (err) {
          activity({ tool: name, summary: summarize(args), ok: false, error: oneLine(err && err.message, 300) });
          throw err;
        }
        const warnings = Array.isArray(out.warnings) ? out.warnings.filter((w) => typeof w === 'string' && w) : [];
        const text = warnings.length ? `${out.text}\n\nWarning: ${warnings.join('\nWarning: ')}` : out.text;
        const act = { tool: name, summary: out.summary || summarize(args), ok: true };
        if (warnings.length) act.warning = oneLine(warnings.join(' '), 300);
        activity(act);
        if (!args.screenshotAfter) return okText(text);
        const blocks = await screenshotBlocks(comp, out.display);
        return { content: [{ type: 'text', text }, ...blocks] };
      },
    };
  }

  const WINDOW = { type: 'string', maxLength: 300, description: 'Window id from list_windows, or part of its title or app name. Default: the active window (the frontmost other one while the Claude Anywhere dialog has focus).' };
  const ROLE = { type: 'string', maxLength: 60, description: `Role filter: ${ROLES.join(', ')} ("tab|link" for either; AT-SPI, ARIA and UI Automation names work too).` };
  const SHOT_AFTER = { type: 'boolean', description: 'Return a fresh screenshot after the action (after a short settle delay). Default false.' };

  const tools = [];

  // ------------------------------------------------------------ ui_find
  tools.push({
    name: 'ui_find',
    title: 'Find UI elements',
    description: [
      'Find buttons, links, tabs, text boxes, menu items and other controls of an app window by their accessible name, text or role, through the operating system\'s accessibility API. Faster and more reliable than reading a screenshot: use it before clicking whenever you know the label ("For you", "Save", "Search").',
      'name matches the accessible name (what a screen reader says), text matches name, value or description; both case-insensitive substrings, or the whole text with exact. role narrows it down (button, link, tab, textbox, menuitem...).',
      'Each match has an id for ui_click and ui_set_value, and its centre (x, y) in pixels of your latest screenshot of that display (so click works too). Best matches first: whole text, then prefix, then substring; controls before labels.',
      'Apps that draw their own UI (games, canvases, some Electron apps) expose little: use find_text (OCR) or a screenshot then. On Linux, Chromium-based browsers and Electron apps show page content only when started with --force-renderer-accessibility and ACCESSIBILITY_ENABLED=1 (the result says so).',
    ].join('\n\n'),
    inputSchema: schema({
      name: { type: 'string', maxLength: 300, description: 'Accessible name to look for, e.g. "For you", "Save".' },
      text: { type: 'string', maxLength: 300, description: 'Text in the name, value or description.' },
      role: ROLE,
      window: WINDOW,
      exact: { type: 'boolean', description: 'Match the whole name/text instead of a substring. Default false.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_FIND_LIMIT, description: `Maximum matches (default ${DEFAULT_FIND_LIMIT}).` },
    }),
    annotations: ann('Find UI elements', { readOnly: true }),
    handler: async (args = {}) => {
      if (!hasText(args.name) && !hasText(args.text) && !hasText(args.role)) {
        return failText('Give name, text or role to look for, e.g. {"name": "For you", "role": "tab"}.');
      }
      const comp = await computer();
      const win = await resolveWindow(comp.driver, args.window);
      const limit = Number.isInteger(args.limit) ? args.limit : DEFAULT_FIND_LIMIT;
      const list = await comp.uiFind({ windowId: win.id, name: args.name, text: args.text, role: args.role, exact: args.exact === true, limit });
      const w = list.window || win.window;
      const where = `${windowLabel(w)}${w && w.id ? ` (window ${w.id})` : ''}`;
      const extra = (win.note ? `\nNote: ${win.note}` : '') + notesText(list);
      if (!list.length) {
        return okText(
          `No ${queryLabel(args)} in ${where}.${list.truncated ? ' The search stopped at its time or size limit.' : ''} ` +
            'Try a shorter or different name, text instead of name, no role, ui_tree to see what the window offers, or find_text / a screenshot.' +
            extra,
        );
      }
      const total = Number.isFinite(list.total) && list.total > list.length ? ` (of ${list.total})` : '';
      const lines = list.map(matchLine).join('\n');
      return okText(
        `${list.length} match${list.length === 1 ? '' : 'es'}${total} for ${queryLabel(args)} in ${where}:\n${lines}\n` +
          'Press one with ui_click {"id": ...} (or ui_set_value for fields); (x, y) are pixels of your latest screenshot of that display.' +
          extra,
      );
    },
  });

  // ------------------------------------------------------------ ui_tree
  tools.push({
    name: 'ui_tree',
    title: 'Window UI tree',
    description: [
      'The controls of an app window as an indented outline from the accessibility API: one line per element with its role, name, value, centre (x, y) in pixels of your latest screenshot, state and id. Unnamed containers are left out (their children move up).',
      'Use it to understand an unfamiliar window or to read text a screenshot shows too small, then act with ui_click / ui_set_value by id. For one known label, ui_find is quicker. A line ending in "…" has children below the depth limit: raise depth or use ui_find.',
    ].join('\n\n'),
    inputSchema: schema({
      window: WINDOW,
      depth: { type: 'integer', minimum: 1, maximum: MAX_TREE_DEPTH, description: `Levels below the window (default ${DEFAULT_TREE_DEPTH}).` },
      maxNodes: { type: 'integer', minimum: 10, maximum: MAX_TREE_NODES, description: `Maximum elements (default ${DEFAULT_TREE_NODES}, at most ${MAX_TREE_NODES}).` },
    }),
    annotations: ann('Window UI tree', { readOnly: true }),
    handler: async (args = {}) => {
      const comp = await computer();
      const win = await resolveWindow(comp.driver, args.window);
      const maxNodes = Number.isInteger(args.maxNodes) ? Math.min(MAX_TREE_NODES, args.maxNodes) : DEFAULT_TREE_NODES;
      const depth = Number.isInteger(args.depth) ? args.depth : DEFAULT_TREE_DEPTH;
      const tree = await comp.uiTree({ windowId: win.id, depth, maxNodes });
      const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
      const w = tree.window || win.window;
      const where = `${windowLabel(w)}${w && w.id ? ` (window ${w.id})` : ''}`;
      const extra = (win.note ? `\nNote: ${win.note}` : '') + notesText(tree);
      if (!nodes.length) return okText(`${where} exposes no UI elements to accessibility. Use find_text (OCR) or a screenshot instead.${extra}`);
      const outline = formatOutline(nodes, maxNodes);
      const cut = tree.truncated || outline.shown < nodes.length ? ' (cut at the size, depth or time limit; use ui_find for anything missing)' : '';
      const header =
        `UI tree of ${where}: ${outline.shown} element${outline.shown === 1 ? '' : 's'}${cut}. ` +
        `Each line: role "name" = "value" (x, y) [state] · id, where (x, y) is the centre in pixels of your latest screenshot of display ${outline.display}` +
        ' ("dN" marks another display).';
      return okText(`${header}\n${outline.text}${extra}`);
    },
  });

  // ------------------------------------------------------------ ui_click
  tools.push(
    uiInputTool({
      name: 'ui_click',
      title: 'Click UI element',
      description: [
        'Press a control by its id (from ui_find or ui_tree), or by name/text (+ role, window) in one step: e.g. {"name": "For you", "role": "tab"} or {"name": "Save", "role": "button", "window": "Code"}.',
        'It uses the accessibility action (no mouse needed, works even when the element is partly covered); a text box gets focus. When the element has no such action, the real mouse clicks its centre. If several elements match equally, nothing is pressed and their ids are listed: call again with one.',
        'screenshotAfter returns a fresh screenshot so you can check the result in the same step.',
      ].join('\n\n'),
      inputSchema: schema({
        id: { type: 'string', maxLength: 600, description: 'Element id from ui_find or ui_tree.' },
        name: { type: 'string', maxLength: 300, description: 'Accessible name, when there is no id.' },
        text: { type: 'string', maxLength: 300, description: 'Text in the name, value or description, when there is no id.' },
        role: ROLE,
        window: WINDOW,
        exact: { type: 'boolean', description: 'Match the whole name/text. Default false.' },
        screenshotAfter: SHOT_AFTER,
      }),
      summarize: (a) => (hasText(a.id) ? `Press UI element ${oneLine(a.id, 80)}` : `Press ${queryLabel(a)}`),
      run: async (comp, a) => {
        if (!hasText(a.id) && !hasText(a.name) && !hasText(a.text)) {
          throw toolError('Give the element id (from ui_find or ui_tree), or its name or text.', 'INVALID_INPUT');
        }
        const win = hasText(a.id) ? { id: undefined } : await resolveWindow(comp.driver, a.window);
        const r = await comp.uiClick({ id: hasText(a.id) ? String(a.id).trim() : undefined, name: a.name, text: a.text, role: a.role, windowId: win.id, exact: a.exact === true });
        const what = `${r.role || 'element'}${hasText(r.name) ? ` ${quoted(r.name, 80)}` : ''}`;
        const at = r.shot ? ` at (${r.shot.cx}, ${r.shot.cy}) on display ${r.shot.display}` : '';
        let text;
        if (r.method === 'click') {
          text = `Clicked the centre of ${what}${at} with the mouse${r.reason ? ` (no accessibility action: ${oneLine(r.reason, 160)})` : ''}.`;
        } else {
          text = `Pressed ${what}${at} through accessibility (${r.method}).`;
          if (r.pending) text += ' The app has not answered yet; it probably opened a dialog.';
        }
        if (win.note) text += ` ${win.note}`;
        if (!a.screenshotAfter) text += ' Take a screenshot (or pass screenshotAfter) to check the result.';
        if (r.id && r.id !== a.id && hasText(a.id)) text += ` Its id is now ${r.id}.`;
        const display = r.shot ? r.shot.display : Number.isInteger(r.display) ? r.display : undefined;
        return { text, summary: `${r.method === 'click' ? 'Clicked' : 'Pressed'} ${what}`, warnings: r.warnings, display };
      },
    }),
  );

  // ------------------------------------------------------------ ui_set_value
  tools.push(
    uiInputTool({
      name: 'ui_set_value',
      title: 'Set field value',
      description: [
        'Replace the text of a text box (or the value of a combo box or slider) by its id, or by name/text (+ role, window), e.g. {"name": "Search", "value": "login timeout"} or {"id": "...", "value": "42"}.',
        'It sets the value through accessibility when the app allows it; otherwise it focuses the field (or clicks it), selects all and types the value (long or multi-line text is pasted, the clipboard restored). To submit, press Enter afterwards with key.',
      ].join('\n\n'),
      inputSchema: schema(
        {
          value: { type: ['string', 'number'], minLength: 0, maxLength: 100000, description: 'The new text or value ("" clears the field).' },
          id: { type: 'string', maxLength: 600, description: 'Element id from ui_find or ui_tree.' },
          name: { type: 'string', maxLength: 300, description: 'Accessible name (the field\'s label or placeholder), when there is no id.' },
          text: { type: 'string', maxLength: 300, description: 'Text in the name, value or description, when there is no id.' },
          role: ROLE,
          window: WINDOW,
          exact: { type: 'boolean', description: 'Match the whole name/text. Default false.' },
          screenshotAfter: SHOT_AFTER,
        },
        ['value'],
      ),
      summarize: (a) => `Set ${hasText(a.id) ? `UI element ${oneLine(a.id, 60)}` : queryLabel(a)} to ${quoted(a.value, 40)}`,
      run: async (comp, a) => {
        if (!hasText(a.id) && !hasText(a.name) && !hasText(a.text)) {
          throw toolError('Give the field id (from ui_find or ui_tree), or its name or text.', 'INVALID_INPUT');
        }
        if (a.value == null) throw toolError('value is required ("" clears the field).', 'INVALID_INPUT');
        const win = hasText(a.id) ? { id: undefined } : await resolveWindow(comp.driver, a.window);
        const r = await comp.uiSetValue({ id: hasText(a.id) ? String(a.id).trim() : undefined, value: String(a.value), name: a.name, text: a.text, role: a.role, windowId: win.id, exact: a.exact === true });
        const what = `${r.role || 'field'}${hasText(r.name) ? ` ${quoted(r.name, 80)}` : ''}`;
        const shown = String(a.value) === '' ? 'empty' : quoted(a.value, 80);
        const how = /select-all/.test(r.method) ? `focused it and typed over its text (${r.method})` : `through accessibility (${r.method})`;
        let text = `Set ${what} to ${shown}: ${how}.`;
        if (win.note) text += ` ${win.note}`;
        if (!a.screenshotAfter) text += ' Take a screenshot (or pass screenshotAfter) to check it.';
        const display = r.shot ? r.shot.display : Number.isInteger(r.display) ? r.display : undefined;
        return { text, summary: `Set ${what} to ${shown}`, warnings: r.warnings, display };
      },
    }),
  );

  return tools;
}

module.exports = {
  createTools,
  // helpers (exported for tests)
  resolveWindow,
  formatOutline,
  matchLine,
  rankWindows,
  SETTLE_MS,
  MAX_TREE_NODES,
};
