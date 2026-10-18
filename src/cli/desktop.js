'use strict';

/**
 * `anywhere desktop …`: the virtual-assistant desktop operations from a terminal (bridge mode, scripts),
 * the same ones the MCP tools use (src/mcp/tools-desktop.js):
 *
 *   anywhere desktop apps [QUERY] [--limit N]                                installed apps (fuzzy search)
 *   anywhere desktop launch NAME [--no-wait] [--timeout SEC] [--new] [--accessibility] [-- ARGS…]
 *   anywhere desktop quit NAME [--force]
 *   anywhere desktop bookmarks [QUERY] [--browser B] [--folder F] [--profile P] [--limit N]
 *   anywhere desktop open-url URL [--browser B] [--new-window] [--same-tab]
 *   anywhere desktop tabs [--browser B] [--cycle]
 *   anywhere desktop switch-tab (TEXT | --index N) [--browser B]
 *   anywhere desktop window QUERY (--state S | --bounds X,Y,W,H)
 *   anywhere desktop wait [--window W] [--text T] [--gone] [--timeout SEC]
 *
 * Prints what happened as text, or JSON with --json. Actions honour the dialog's pause (Stop) when a
 * daemon runs, the failsafe corner, and show up in the dialog's activity feed.
 */

const path = require('path');

const SUBCOMMANDS = ['apps', 'launch', 'quit', 'bookmarks', 'open-url', 'tabs', 'switch-tab', 'window', 'wait'];
const ACTIONS = { launch: 'launch_app', quit: 'quit_app', 'open-url': 'browser_open', 'switch-tab': 'browser_switch_tab', window: 'set_window' };

function cliError(message, hint, exitCode, code) {
  const e = new Error(message);
  e.name = 'CliError';
  e.exitCode = exitCode == null ? 1 : exitCode;
  if (hint) e.hint = hint;
  if (code) e.code = code;
  return e;
}

function usage(message) {
  const e = cliError(message, 'Run "anywhere help desktop" for usage.');
  e.usage = true;
  return e;
}

function toolsDesktop() {
  return require(path.join(__dirname, '..', 'mcp', 'tools-desktop'));
}

/** JSON without internal fields (cached identities, functions). */
function plain(value) {
  return JSON.parse(JSON.stringify(value, (k, v) => (k.startsWith('_') || typeof v === 'function' ? undefined : v)));
}

function intFlag(v, name, min, max) {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw usage(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function parseBounds(v) {
  const parts = String(v).split(/[ ,x]+/).filter(Boolean).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw usage('--bounds must be X,Y,WIDTH,HEIGHT, e.g. --bounds 0,0,1280,800');
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/**
 * @param {object} h helpers from bin/anywhere.js
 */
function commands(h) {
  const { spec, shared, requireDaemon, writeOut, printJson, EXIT } = h;

  /** The desktop driver, a Computer on the shared screenshot geometry, and the dialog's guard. */
  async function openEnv() {
    const osIndex = require(path.join(__dirname, '..', 'os', 'index'));
    const { Computer } = require(path.join(__dirname, '..', 'os', 'computer'));
    const driver = await osIndex.getDriver();
    let config = {};
    try {
      config = shared('config').load() || {};
    } catch (_) {
      config = {};
    }
    let pending = null;
    const daemon = () => {
      if (!pending) pending = Promise.resolve().then(() => requireDaemon()).catch(() => null);
      return pending;
    };
    const verdict = async () => {
      const d = await daemon();
      if (!d) return { allowed: true };
      try {
        const r = await d.client.request('GET', '/api/mcp/guard', undefined, { timeoutMs: 300 });
        return r && typeof r.allowed === 'boolean' ? r : { allowed: true };
      } catch (_) {
        return { allowed: true };
      }
    };
    const computer = new Computer({ driver, config: config.computer, geometryStore: 'file', guard: verdict });
    const checkGuard = async () => {
      const v = await verdict();
      if (v && v.allowed === false) {
        throw cliError(`Actions are paused: ${v.reason || 'the user paused Claude in the Anywhere dialog'}.`, 'Resume from the Claude Anywhere dialog.', 1, 'PAUSED');
      }
    };
    const report = async (body) => {
      try {
        const d = await daemon();
        if (d) await d.client.request('POST', '/api/mcp/activity', { ...body, role: 'cli' }, { timeoutMs: 1000 });
      } catch (_) {
        /* the dialog is optional */
      }
    };
    const close = async () => {
      try {
        if (typeof osIndex.resetDriver === 'function') await osIndex.resetDriver();
      } catch (_) {
        /* ignore */
      }
    };
    return { driver, computer, checkGuard, report, close };
  }

  async function run(p) {
    const sub = String(p._[0] || '').toLowerCase();
    if (!sub) throw usage(`desktop needs a command: ${SUBCOMMANDS.join(', ')}`);
    if (!SUBCOMMANDS.includes(sub)) throw usage(`Unknown desktop command "${sub}" (use ${SUBCOMMANDS.join(', ')})`);
    const f = p.flags;
    const rest = p._.slice(1);
    const T = toolsDesktop();
    let env = null;
    let summary = '';
    try {
      env = await openEnv();
      const ops = T.createDesktopOps({ getComputer: async () => env.computer, checkGuard: env.checkGuard });
      let result;
      let text;
      let code = EXIT.OK;
      switch (sub) {
        case 'apps': {
          const query = rest.join(' ').trim();
          result = await ops.listApps({ query: query || undefined, limit: intFlag(f.limit, '--limit', 1, 500) });
          text = T.formatApps(result);
          break;
        }
        case 'launch': {
          const name = rest.join(' ').trim();
          if (!name) throw usage('Usage: anywhere desktop launch NAME [--no-wait] [--timeout SEC] [--new] [--accessibility] [-- ARGS…]');
          const timeoutSec = intFlag(f.timeout, '--timeout', 1, 120);
          summary = `Launch ${name}`;
          result = await ops.launchApp({ name, args: p.rest || [], waitForWindow: f.wait !== false, timeoutSec, newInstance: Boolean(f.new), accessibility: Boolean(f.accessibility) });
          text = T.formatLaunch(result, timeoutSec || 20);
          summary = result.alreadyRunning && !result.launched ? `Focused ${result.app.name}` : `Launched ${result.app.name}`;
          break;
        }
        case 'quit': {
          const name = rest.join(' ').trim();
          if (!name) throw usage('Usage: anywhere desktop quit NAME [--force]');
          summary = `Quit ${name}`;
          result = await ops.quitApp({ name, force: Boolean(f.force) });
          text = T.formatQuit(result, Boolean(f.force));
          break;
        }
        case 'bookmarks': {
          const args = { browser: f.browser, query: rest.join(' ').trim() || undefined, folder: f.folder, profile: f.profile, limit: intFlag(f.limit, '--limit', 1, 500) };
          result = await ops.bookmarks(args);
          text = T.formatBookmarks(result, args);
          break;
        }
        case 'open-url': {
          const url = rest.join(' ').trim();
          if (!url) throw usage('Usage: anywhere desktop open-url URL [--browser B] [--new-window] [--same-tab]');
          summary = `Open ${url}`;
          result = await ops.browserOpen({ url, browser: f.browser, newWindow: Boolean(f['new-window']), newTab: !f['same-tab'] });
          text = T.formatOpen(result);
          break;
        }
        case 'tabs': {
          result = await ops.browserTabs({ browser: f.browser, cycle: Boolean(f.cycle) });
          text = T.formatTabs(result);
          break;
        }
        case 'switch-tab': {
          const match = rest.join(' ').trim();
          let index = intFlag(f.index, '--index', -1, 500);
          let m = match;
          if (index == null && /^-?\d+$/.test(match)) {
            index = Number(match);
            m = '';
          }
          if (!m && (index == null || index === 0)) throw usage('Usage: anywhere desktop switch-tab TEXT | --index N  (1 = first tab, -1 = last)');
          summary = m ? `Switch to tab "${m}"` : `Switch to tab ${index}`;
          result = await ops.browserSwitchTab({ browser: f.browser, match: m || undefined, index: m ? undefined : index });
          text = T.formatSwitch(result);
          break;
        }
        case 'window': {
          const query = rest.join(' ').trim();
          if (!query || (!f.state && !f.bounds)) throw usage('Usage: anywhere desktop window QUERY (--state maximize|minimize|restore|fullscreen|left-half|right-half | --bounds X,Y,W,H)');
          summary = `${f.state || 'Move'} window ${query}`;
          result = await ops.setWindow({ window: query, state: f.state, bounds: f.bounds ? parseBounds(f.bounds) : undefined });
          text = T.formatSetWindow(result);
          break;
        }
        case 'wait': {
          if (!f.window && !f.text) throw usage('Usage: anywhere desktop wait [--window W] [--text T] [--gone] [--timeout SEC]');
          const timeoutSec = intFlag(f.timeout, '--timeout', 1, 120);
          result = await ops.waitFor({ window: f.window, text: f.text, gone: Boolean(f.gone), timeoutSec, display: intFlag(f.display, '--display', 0, 15), exact: Boolean(f.exact) });
          text = T.formatWaitFor(result, timeoutSec || 15);
          if (!result.ok) code = EXIT.TIMEOUT;
          break;
        }
        default:
          throw usage(`Unknown desktop command "${sub}"`);
      }
      if (ACTIONS[sub]) await env.report({ tool: ACTIONS[sub], summary: summary || sub, ok: true });
      if (f.json) printJson({ ok: code === EXIT.OK, ...plain(result) });
      else writeOut(text);
      return code;
    } catch (err) {
      if (err && err.usage) throw err;
      if (env && ACTIONS[sub] && !(err && err.code === 'PAUSED')) await env.report({ tool: ACTIONS[sub], summary: summary || sub, ok: false, error: String((err && err.message) || err).slice(0, 300) });
      if (f.json) {
        const out = { ok: false, error: (err && err.message) || String(err) };
        if (err && err.code) out.code = err.code;
        if (err && err.hint) out.hint = err.hint;
        printJson(out);
        return EXIT.ERROR;
      }
      if (err && err.name === 'CliError') throw err;
      throw cliError((err && err.message) || String(err), err && err.hint, 1, err && err.code);
    } finally {
      if (env) await env.close();
    }
  }

  return {
    desktop: {
      run,
      group: 'Desktop control',
      summary: 'Apps, windows and browsers: launch, quit, bookmarks, open URLs, tabs',
      usage:
        'anywhere desktop apps [QUERY] | launch NAME [--no-wait] [--timeout SEC] [--new] [--accessibility] [-- ARGS] | quit NAME [--force] | bookmarks [QUERY] [--browser B] [--folder F] [--profile P] | open-url URL [--browser B] [--new-window] [--same-tab] | tabs [--browser B] [--cycle] | switch-tab TEXT|--index N [--browser B] | window QUERY --state S|--bounds X,Y,W,H | wait [--window W] [--text T] [--gone] [--timeout SEC]  [--json]',
      details: [
        'apps lists installed apps (fuzzy: "vs code", "premiere", "terminal"); launch starts one, waits for its window and focuses it (an open window is just focused).',
        'bookmarks reads every browser profile from disk, the bookmarks bar first: e.g. anywhere desktop bookmarks jira --browser brave --folder bar',
        'open-url opens a page as a new tab of the running browser; tabs lists tabs (macOS AppleScript, Windows UI Automation; elsewhere titles, or --cycle with the keyboard); switch-tab goes to one.',
        'window arranges a window (maximize, minimize, restore, fullscreen, left-half, right-half, or --bounds in list_windows coordinates); wait waits for a window or on-screen text (OCR) and exits 2 on timeout.',
        'Actions honour the dialog\'s Stop button and the failsafe corner (mouse in the top-left corner pauses them).',
      ],
      spec: spec({
        string: ['limit', 'timeout', 'browser', 'folder', 'profile', 'index', 'state', 'bounds', 'window', 'text', 'display'],
        boolean: ['wait', 'new', 'accessibility', 'force', 'new-window', 'same-tab', 'cycle', 'gone', 'exact'],
      }),
    },
  };
}

module.exports = { commands, SUBCOMMANDS, parseBounds };
