'use strict';

/**
 * read_browser_tab: the address, title and (on request) text of the user's browser tab, plus the
 * Jira issue it shows, on every desktop backend through driver.browserTab() (docs/ARCHITECTURE.md
 * §4). Loaded by src/mcp/tools.js (TOOL_MODULES) with the shared tool context `ext`.
 *
 * macOS (Chromium browsers and Safari, AppleScript) and Windows (UI Automation) read the address
 * bar without input. Everything else, and the page text everywhere, uses the keyboard: that is an
 * input action, so it runs behind the user's pause guard and the failsafe corner, serialized with
 * the Computer's other actions.
 */

const desktop = require('../context/desktop');
const tabs = require('../os/linux');
const { createLogger } = require('../shared/log');
const { truncate } = require('../shared/util');

const log = createLogger('mcp-browser');

const TOOL_NAME = 'read_browser_tab';
const DEFAULT_MAX_CHARS = 20000;
const MIN_MAX_CHARS = 200;
const MAX_MAX_CHARS = 200000;
const LIST_TIMEOUT_MS = 10000;
const MAX_OTHER_WINDOWS = 5;
const FAILSAFE_RADIUS = 3;

// ---------------------------------------------------------------- Jira

const KEY_RE = /^[A-Z][A-Z0-9_]{0,49}-[1-9]\d{0,9}$/;
const LOOSE_KEY = '[A-Za-z][A-Za-z0-9_]{0,49}-[1-9]\\d{0,9}';
/** Jira Cloud hosts; their issues always live at the origin. */
const CLOUD_HOST_RE = /(?:^|\.)(?:atlassian\.net|jira\.com|jira-dev\.com)$/i;
/** Paths only Jira Cloud's UI uses (also on custom domains): the base URL is the origin. */
const CLOUD_UI_RE = /^\/jira\/(?:software|core|business|your-work|for-you|discovery|polaris|plans|teams|apps|servicedesk\/projects)(?:\/|$)/i;
/** Where Jira Server / Data Center paths start after the context path ("/jira/secure/..." -> base ".../jira"). */
const SERVER_MARKERS = ['/browse/', '/secure/', '/projects/', '/issues/', '/plugins/', '/servicedesk/', '/rest/', '/si/'];

function decodePath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function jiraBaseUrl(u, path, cut) {
  if (CLOUD_HOST_RE.test(u.hostname) || CLOUD_UI_RE.test(path)) return u.origin;
  let at = cut;
  if (at < 0) {
    for (const m of SERVER_MARKERS) {
      const i = path.indexOf(m);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
  }
  const prefix = at > 0 ? path.slice(0, at).replace(/\/+$/, '') : '';
  return u.origin + prefix;
}

/**
 * The Jira issue a URL shows: /browse/KEY-123 on any host (and any context path), or
 * selectedIssue=KEY-123 in the query (boards, backlogs, issue search); on Jira hosts also
 * .../issues/KEY-123 and service desk queue paths ending in a key.
 * @param {string} url
 * @returns {{key:string, baseUrl:string}|null}
 */
function parseJiraUrl(url) {
  let u;
  try {
    u = new URL(String(url == null ? '' : url).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const path = decodePath(u.pathname);
  let key = null;
  let cut = -1;
  const browse = new RegExp(`/browse/(${LOOSE_KEY})(?:/|$)`).exec(path);
  if (browse) {
    key = browse[1].toUpperCase();
    cut = browse.index;
  }
  if (!key) {
    const sel = String(u.searchParams.get('selectedIssue') || '').trim();
    if (new RegExp(`^${LOOSE_KEY}$`).test(sel)) key = sel.toUpperCase();
  }
  if (!key && (CLOUD_HOST_RE.test(u.hostname) || /\/jira\//i.test(path) || /\bjira\b/i.test(u.hostname))) {
    const m = new RegExp(`/(?:issues|queues/[^/]+(?:/\\d+)?)/(${LOOSE_KEY})(?:/|$)`).exec(path);
    if (m) key = m[1].toUpperCase();
  }
  if (!key || !KEY_RE.test(key)) return null;
  return { key, baseUrl: jiraBaseUrl(u, path, cut) };
}

const TITLE_SEP = /\s[-–—|]\s/;
const BROWSER_SUFFIX_RE = /^(?:brave(?:\s(?:browser|beta|nightly|dev))*|google chrome.*|chromium|microsoft.*edge.*|(?:mozilla\s)?firefox.*|librewolf|waterfox|zen browser|floorp|safari|vivaldi|opera(?:\sgx)?|arc)$/i;

/**
 * The Jira issue in a page or window title: "[ABC-123] Fix login timeout - Jira" (Cloud, Server
 * and Data Center put the key in brackets), also followed by the browser's name (" - Brave"), and
 * "ABC-123: Summary - Jira" when the title names Jira.
 * @param {string} title
 * @returns {{key:string, summary:string}|null}
 */
function parseJiraTitle(title) {
  const t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  let key = null;
  let rest = '';
  const bracket = /^\[([A-Z][A-Z0-9_]{0,49}-[1-9]\d{0,9})\]\s*(.*)$/.exec(t);
  if (bracket) {
    key = bracket[1];
    rest = bracket[2];
  } else if (/\bjira\b/i.test(t)) {
    const plain = /^([A-Z][A-Z0-9_]{0,49}-[1-9]\d{0,9})(?::\s*|\s[-–—]\s|\s)(.*)$/.exec(t);
    if (!plain) return ticketTitleFallback(t);
    key = plain[1];
    rest = plain[2];
  }
  if (!key) return ticketTitleFallback(t);
  const parts = rest.split(TITLE_SEP);
  if (parts.length > 1 && BROWSER_SUFFIX_RE.test(parts[parts.length - 1].trim())) parts.pop();
  // "[ENG-4] Title - Linear" is a Linear issue, not a Jira one.
  if (parts.length > 1 && /^linear$/i.test(parts[parts.length - 1].trim())) return null;
  if (parts.length > 1 && /\bjira\b/i.test(parts[parts.length - 1])) parts.pop();
  return { key, summary: parts.join(' - ').trim() };
}

/**
 * Other Jira title shapes the desktop context recognises ("Summary - ABC-12 - Jira", Server
 * "… - Acme JIRA"), so the tool and the Tickets line of <desktop_context> agree.
 * @returns {{key:string, summary:string}|null}
 */
function ticketTitleFallback(t) {
  if (typeof desktop.parseTicketTitle !== 'function') return null;
  const parts = t.split(TITLE_SEP);
  if (parts.length > 1 && BROWSER_SUFFIX_RE.test(parts[parts.length - 1].trim())) parts.pop();
  const tk = desktop.parseTicketTitle(parts.join(' - '));
  return tk && tk.tracker === 'jira' ? { key: tk.key, summary: tk.summary || '' } : null;
}

/**
 * The Jira issue a tab shows, from its URL (with the site's base URL) or else its title (baseUrl null).
 * @returns {{key:string, baseUrl:string|null, summary?:string}|null}
 */
function detectJira(url, ...titles) {
  const fromUrl = url ? parseJiraUrl(url) : null;
  let fromTitle = null;
  for (const t of titles) {
    fromTitle = parseJiraTitle(t);
    if (fromTitle) break;
  }
  if (fromUrl) {
    const out = { key: fromUrl.key, baseUrl: fromUrl.baseUrl };
    if (fromTitle && fromTitle.key === fromUrl.key && fromTitle.summary) out.summary = fromTitle.summary;
    return out;
  }
  if (fromTitle) {
    const out = { key: fromTitle.key, baseUrl: null };
    if (fromTitle.summary) out.summary = fromTitle.summary;
    return out;
  }
  return null;
}

// ---------------------------------------------------------------- helpers

function toolError(message, code, hint) {
  const err = new Error(message);
  if (code) err.code = code;
  if (hint) err.hint = hint;
  return err;
}

function oneLine(s, max = 200) {
  return truncate(String(s == null ? '' : s).replace(/\s+/g, ' ').trim(), max);
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(toolError(`${what} timed out after ${Math.round(ms / 1000)} s`, 'TIMEOUT')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function clampMaxChars(v) {
  const n = Math.round(Number(v));
  if (v == null || v === '' || !Number.isFinite(n)) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, n));
}

/** MCP annotations for a call: reading the page text sends keystrokes, so it is not read-only. */
function annotationsFor(args = {}, annotations) {
  const make =
    typeof annotations === 'function'
      ? annotations
      : (title, o) => ({ title, readOnlyHint: o.readOnly, destructiveHint: false, idempotentHint: o.idempotent, openWorldHint: true });
  const text = Boolean(args && args.includeText);
  return make('Read browser tab', { readOnly: !text, idempotent: !text, openWorld: true });
}

function zOrderedDriver(driver) {
  return driver.windowsZOrdered === true || /^(?:darwin|win32|wsl)$/.test(String(driver.name || ''));
}

/**
 * The failsafe corner check, for a Computer without the internals readBrowserTab relies on.
 * @throws {Error} code FAILSAFE
 */
async function cornerFailsafe(comp) {
  if (comp && comp.config && comp.config.failsafe === false) return;
  const driver = comp && comp.driver;
  if (!driver || typeof driver.cursorPosition !== 'function' || typeof driver.displays !== 'function') return;
  let pos;
  let displays;
  try {
    [pos, displays] = await Promise.all([driver.cursorPosition(), driver.displays()]);
  } catch {
    return;
  }
  if (!pos || pos.estimated || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Array.isArray(displays) || !displays.length) return;
  const primary = displays.find((d) => d.primary) || displays[0];
  if (Math.abs(pos.x - (Number(primary.x) || 0)) > FAILSAFE_RADIUS || Math.abs(pos.y - (Number(primary.y) || 0)) > FAILSAFE_RADIUS) return;
  throw toolError(
    'FAILSAFE: mouse is in the top-left corner; actions are paused',
    'FAILSAFE',
    'Move the mouse away from the top-left corner of the primary display to resume.',
  );
}

/** Computer's own guard and failsafe (Computer._preflight), else the corner check above. */
async function computerPreflight(comp) {
  if (comp && typeof comp._preflight === 'function' && typeof comp._getDisplays === 'function') {
    const displays = await comp._getDisplays();
    await comp._preflight(displays);
    return;
  }
  await cornerFailsafe(comp);
}

/** Run fn in the Computer's action queue, so keystrokes never interleave with another action. */
function serialized(comp, fn) {
  return comp && typeof comp._serial === 'function' ? comp._serial(fn) : fn();
}

function noteFor(res, { includeText, maxChars, primary }) {
  const notes = [];
  if (res.tookFocus) {
    const keys = [res.method === 'keyboard' ? `${primary}+L` : null, includeText ? `${primary}+A` : null].filter(Boolean).join(' and ');
    const clip = {
      restored: '; the clipboard was restored',
      changed: '; the clipboard was left alone because something else changed it meanwhile',
      lost: '; the clipboard could not be restored',
      unknown: '; the clipboard could not be read beforehand, so it now holds what was copied',
    }[res.clipboard] || '';
    notes.push(`Briefly brought ${res.browser} to the front and copied with the keyboard (${keys || 'copy'}), then gave focus back${clip}.`);
  }
  if (res.method === 'title') notes.push('The address could not be read, so only the window title is reported.');
  if (includeText && res.text == null) notes.push('The page text could not be copied.');
  if (res.truncated) notes.push(`The page text was cut to ${maxChars} of ${res.textChars || 'more'} characters (raise maxChars for more).`);
  if (Array.isArray(res.notes)) for (const n of res.notes) if (n && !notes.includes(n)) notes.push(oneLine(n, 300));
  return notes.length ? notes.join(' ') : undefined;
}

function noBrowserMessage(windows, query) {
  const browsers = tabs.browserWindows(windows, '', { exclude: desktop.isOwnWindow });
  const names = [...new Set(browsers.map((c) => c.browser.name))];
  if (query && tabs.normalizeBrowserQuery(query)) {
    return names.length
      ? `No ${query} window is open. Open browsers: ${names.join(', ')}. Call read_browser_tab with one of them, or ask the user to open the page in ${query}.`
      : `No ${query} window is open, and no other browser either. Ask the user to open the page.`;
  }
  const apps = [...new Set((windows || []).filter((w) => !desktop.isOwnWindow(w)).map((w) => w.app).filter(Boolean))].slice(0, 15);
  return `No browser window is open.${apps.length ? ` Open apps: ${apps.join(', ')}.` : ''} Ask the user to open the page in a browser.`;
}

// ---------------------------------------------------------------- tool

/**
 * @param {object} ext the shared tool context from src/mcp/tools.js
 * @returns {object[]} [read_browser_tab]
 */
function createTools(ext = {}) {
  const { getComputer, checkGuard, postActivity, keepAlive, ok, fail, objectSchema, annotations } = ext;
  const guard = typeof checkGuard === 'function' ? checkGuard : async () => {};
  const activity = typeof postActivity === 'function' ? postActivity : () => {};
  const alive = typeof keepAlive === 'function' ? keepAlive : () => () => {};
  const okText = typeof ok === 'function' ? ok : (text) => ({ content: [{ type: 'text', text }] });
  const failText = typeof fail === 'function' ? fail : (text) => ({ content: [{ type: 'text', text }], isError: true });
  const schema =
    typeof objectSchema === 'function'
      ? objectSchema
      : (properties, required = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });

  return [
    {
      name: TOOL_NAME,
      title: 'Read browser tab',
      description: [
        'Read the tab the user has open in a browser: its URL and title, the Jira issue it shows (jira: {key, baseUrl}; baseUrl is null when the key only came from the title) and, with includeText, the page text.',
        'Use it when the user points at a page instead of naming it ("my Jira tab in Brave", "the ticket I have open", "this PR in Chrome"). browser picks the browser (brave, chrome, edge, firefox, safari, arc, opera, vivaldi, chromium); without it the most recently active browser window is read. otherWindows lists other matching windows; pass one\'s windowId to read it instead.',
        'On macOS (Chromium browsers and Safari, through AppleScript) and Windows (UI Automation) the URL is read without touching the keyboard. On Linux, for Firefox on macOS, and always for includeText, the tool briefly brings the browser to the front and copies with the keyboard (address bar, then select-all in the page), restores the clipboard and gives focus back; the result\'s note says when that happened.',
        'Returns JSON {browser, title, url, jira, text?, truncated?, method: "applescript"|"uia"|"keyboard"|"title", note?, hint?}. For a Jira issue, prefer jira_get_issue with jira.key when Jira is connected; otherwise read the ticket with includeText.',
      ].join('\n\n'),
      inputSchema: schema({
        browser: { type: 'string', maxLength: 60, description: 'Which browser, e.g. "brave", "chrome", "edge", "firefox", "safari". Default: the most recently active browser window.' },
        includeText: { type: 'boolean', description: 'Also copy the page text (select-all + copy; briefly focuses the browser). Default false.' },
        maxChars: { type: 'integer', minimum: MIN_MAX_CHARS, maximum: MAX_MAX_CHARS, description: `Maximum characters of page text to return (default ${DEFAULT_MAX_CHARS}).` },
        windowId: { type: 'string', maxLength: 100, description: 'Read this browser window (an id from otherWindows or list_windows) instead of the most recent one.' },
      }),
      annotations: annotationsFor({}, annotations),
      handler: async (args = {}, extra = {}) => {
        const includeText = Boolean(args.includeText);
        const maxChars = clampMaxChars(args.maxChars);
        if (typeof getComputer !== 'function') throw toolError('Desktop control is not available in this process.', 'UNSUPPORTED');
        const comp = await getComputer();
        const driver = comp && comp.driver;
        if (!driver || typeof driver.browserTab !== 'function') {
          throw toolError(
            `This desktop driver (${(driver && driver.name) || 'none'}) cannot read browser tabs.`,
            'UNSUPPORTED',
            'Use get_desktop_context for the browser window titles, or take a screenshot of the browser.',
          );
        }
        const windows = (await withTimeout(Promise.resolve(driver.listWindows()), LIST_TIMEOUT_MS, 'Listing windows')) || [];
        const zOrdered = zOrderedDriver(driver);
        let candidates;
        if (args.windowId != null && String(args.windowId).trim() !== '') {
          const w = windows.find((x) => tabs.sameWindowId(x.id, args.windowId));
          if (!w) return failText(`Window ${args.windowId} is not open. ${noBrowserMessage(windows, args.browser)}`);
          const browser = tabs.identifyBrowser(w.app, w.title) || { id: 'browser', name: w.app || 'Browser', engine: 'chromium' };
          candidates = [{ window: w, browser }, ...tabs.browserWindows(windows, args.browser, { zOrdered, exclude: (x) => desktop.isOwnWindow(x) || tabs.sameWindowId(x.id, w.id) })];
        } else {
          candidates = tabs.browserWindows(windows, args.browser, { zOrdered, exclude: desktop.isOwnWindow });
        }
        if (!candidates.length) return failText(noBrowserMessage(windows, args.browser));
        const target = candidates[0];
        const label = `${target.browser.name} tab "${oneLine(target.window.title, 60)}"`;

        // The keyboard path is an input action: the user's pause (daemon guard) and the Computer's
        // failsafe first (Computer.browserTab runs its own failsafe after beforeInput).
        const ownPreflight = typeof comp.browserTab === 'function';
        const beforeInput = async () => {
          await guard();
          if (!ownPreflight) await computerPreflight(comp);
        };
        const opts = { window: target.window, windowId: target.window.id, app: target.window.app, includeText, maxChars, beforeInput };
        const stop = alive(extra, (s) => `Reading the ${target.browser.name} tab (${s} s)`);
        let res;
        try {
          res =
            typeof comp.browserTab === 'function'
              ? await comp.browserTab(opts)
              : await serialized(comp, () => driver.browserTab(opts));
        } catch (err) {
          activity({ tool: TOOL_NAME, summary: `Read ${label}`, ok: false, error: oneLine(err && err.message, 300) });
          throw err;
        } finally {
          stop();
        }

        const primary = driver.name === 'darwin' ? 'Cmd' : 'Ctrl';
        const out = {
          browser: res.browser || target.browser.name,
          title: res.title || target.window.title || '',
          url: res.url || null,
          jira: detectJira(res.url, res.tabTitle, res.title, target.window.title),
          method: res.method || 'title',
        };
        const note = noteFor({ ...res, browser: out.browser }, { includeText, maxChars, primary });
        if (note) out.note = note;
        if (res.hint) out.hint = res.hint;
        if (res.settingsUrl) out.settingsUrl = res.settingsUrl;
        out.windowId = String(res.windowId || target.window.id);
        const others = candidates.slice(1, 1 + MAX_OTHER_WINDOWS).map((c) => ({ browser: c.browser.name, title: oneLine(c.window.title, 120), windowId: String(c.window.id) }));
        if (others.length) out.otherWindows = others;
        // The page text goes last: it is long, and the fields above are what the model scans first.
        if (includeText) {
          out.truncated = Boolean(res.truncated);
          out.text = typeof res.text === 'string' ? res.text : null;
        }

        const how = res.tookFocus ? ' with the keyboard' : '';
        activity({ tool: TOOL_NAME, summary: `Read ${out.browser} tab "${oneLine(out.title, 60)}"${how}${out.jira ? ` (${out.jira.key})` : ''}`, ok: true });
        log.debug(`read_browser_tab: ${out.browser} via ${out.method}${res.tookFocus ? ' (took focus)' : ''}`);
        return okText(JSON.stringify(out, null, 2));
      },
    },
  ];
}

module.exports = {
  createTools,
  TOOL_NAME,
  // helpers (exported for tests and other modules)
  parseJiraUrl,
  parseJiraTitle,
  detectJira,
  annotationsFor,
  clampMaxChars,
  computerPreflight,
  DEFAULT_MAX_CHARS,
};
