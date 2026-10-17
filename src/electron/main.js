'use strict';

/**
 * Optional Electron shell for the Claude Anywhere dialog (Electron >= 28).
 *
 *   electron src/electron/main.js --url http://127.0.0.1:<port>/?token=<token>
 *     [--always-on-top true|false] [--hotkey <accelerator>] [--hide-from-screenshots true|false]
 *     [--width N] [--height N] [--position right|left|center]
 *
 * One frameless-feeling, always-on-top window that only ever shows the daemon's origin. The
 * window hides instead of closing (tray: Show / Always on top / Quit), a global hotkey toggles
 * it, the microphone is granted to the daemon origin only, and the app quits by itself when
 * the daemon stops answering /api/health.
 *
 * Requiring this file from plain Node (tests) only exports the pure helpers.
 */

const path = require('path');

let electron = null;
try {
  electron = require('electron');
} catch {
  electron = null;
}
const IS_ELECTRON_MAIN = Boolean(
  electron && typeof electron === 'object' && electron.app && process.versions && process.versions.electron && process.type === 'browser'
);

const WINDOW_TITLE = 'Claude Anywhere';
const HEALTH_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_MAX_FAILURES = 3;
const MARGIN = 16;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 360;

// 16x16 PNG: an orange disc with a light spark.
const ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAnklEQVR42mO4WR7OgAMr3CwPd4BiBVzqsAkm3CwPv3+zPPw/Gr4PlcNpgMDN8vD9WDSi4/1QtRgGYGh+Or8djHEYgmJAAjbb3mxfAsY4XJKAbAA2P/9/t38tGOMw4D7MAAVc/v12/RQY4wkPBQZoNMH9DHIyyFaQxr/vn4ExiA0SA8mhhYkDVQyg2AsUByJVopHihESVpExxZiIrOwMA6IJnn2/Qoo4AAAAASUVORK5CYII=';

// ---------------------------------------------------------------- pure helpers

function parseBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function parsePositiveInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse our switches from an argv (Electron passes its own switches too; unknown ones are ignored).
 * Both "--name value" and "--name=value" work; boolean switches may omit the value.
 * @param {string[]} argv
 * @returns {{url:string|null,alwaysOnTop:boolean,hotkey:string,hideFromScreenshots:boolean,width:number,height:number,position:string}}
 */
function parseArgs(argv) {
  const out = {
    url: null,
    alwaysOnTop: true,
    hotkey: '',
    hideFromScreenshots: true,
    width: 440,
    height: 720,
    position: 'right',
  };
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const BOOLS = { '--always-on-top': 'alwaysOnTop', '--hide-from-screenshots': 'hideFromScreenshots' };
  const VALUES = { '--url': 'url', '--hotkey': 'hotkey', '--width': 'width', '--height': 'height', '--position': 'position' };
  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    if (BOOLS[name]) {
      if (inline !== undefined) {
        out[BOOLS[name]] = parseBool(inline, true);
      } else if (i + 1 < list.length && /^(true|false|1|0|yes|no|on|off)$/i.test(list[i + 1])) {
        out[BOOLS[name]] = parseBool(list[i + 1], true);
        i += 1;
      } else {
        out[BOOLS[name]] = true;
      }
    } else if (VALUES[name]) {
      let value = inline;
      if (value === undefined && i + 1 < list.length) {
        value = list[i + 1];
        i += 1;
      }
      if (value === undefined) continue;
      const key = VALUES[name];
      if (key === 'width') out.width = parsePositiveInt(value, out.width);
      else if (key === 'height') out.height = parsePositiveInt(value, out.height);
      else if (key === 'position') out.position = ['left', 'right', 'center', 'centre'].includes(value) ? value : 'right';
      else out[key] = value;
    }
  }
  return out;
}

/**
 * Origin of a URL (blob: URLs map to their inner origin), or null for anything but http(s).
 * @param {string} u
 * @returns {string|null}
 */
function originOf(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'blob:') return originOf(parsed.pathname);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Permission policy: only the daemon origin, only the microphone (plus sanitized clipboard
 * writes for "copy" buttons). Works for both request (mediaTypes) and check (mediaType) handlers.
 * @param {{permission:string,origin:string|null,trustedOrigin:string|null,mediaTypes?:string[],mediaType?:string}} o
 * @returns {boolean}
 */
function permissionAllowed({ permission, origin, trustedOrigin, mediaTypes, mediaType }) {
  if (!origin || !trustedOrigin || origin !== trustedOrigin) return false;
  if (permission === 'media') {
    if (Array.isArray(mediaTypes) && mediaTypes.some((t) => t !== 'audio')) return false;
    if (mediaType && mediaType !== 'audio' && mediaType !== 'unknown') return false;
    return true;
  }
  return permission === 'clipboard-sanitized-write';
}

/**
 * Window bounds inside a display work area.
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {number} width
 * @param {number} height
 * @param {string} [position]
 */
function windowBounds(workArea, width, height, position = 'right') {
  const wa = workArea && workArea.width > 0 ? workArea : { x: 0, y: 0, width: 1440, height: 900 };
  const w = Math.max(Math.min(MIN_WIDTH, wa.width), Math.min(width, wa.width - 2 * MARGIN));
  const h = Math.max(Math.min(MIN_HEIGHT, wa.height), Math.min(height, wa.height - 2 * MARGIN));
  let x;
  if (position === 'left') x = wa.x + MARGIN;
  else if (position === 'center' || position === 'centre') x = wa.x + Math.round((wa.width - w) / 2);
  else x = wa.x + wa.width - w - MARGIN;
  const y = position === 'center' || position === 'centre' ? wa.y + Math.round((wa.height - h) / 2) : wa.y + MARGIN;
  return {
    x: Math.max(wa.x, Math.min(x, wa.x + wa.width - w)),
    y: Math.max(wa.y, Math.min(y, wa.y + wa.height - h)),
    width: Math.round(w),
    height: Math.round(h),
  };
}

function warn(msg) {
  try {
    process.stderr.write(`[claude-anywhere electron] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- the app

function start() {
  const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, ipcMain, shell, screen, session, systemPreferences, nativeTheme, net } = electron;
  const opts = parseArgs(process.argv);
  const startOrigin = originOf(opts.url);
  if (!opts.url || !startOrigin) {
    warn('--url http://127.0.0.1:<port>/?token=<token> is required');
    app.exit(2);
    return;
  }

  app.setName(WINDOW_TITLE);
  try {
    // A private userData dir: keeps the single-instance lock and storage away from other Electron apps.
    const { stateDir } = require('../shared/paths');
    app.setPath('userData', path.join(stateDir(), 'electron-data'));
  } catch (err) {
    warn(`using the default userData directory: ${err.message}`);
  }
  if (process.platform === 'win32') app.setAppUserModelId('com.claude-anywhere.dialog');
  if (process.env.ANYWHERE_ELECTRON_DISABLE_GPU === '1') app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  if (!app.requestSingleInstanceLock({ url: opts.url })) {
    // The running instance gets 'second-instance' and shows its window.
    app.quit();
    return;
  }

  const state = {
    url: opts.url,
    origin: startOrigin,
    alwaysOnTop: opts.alwaysOnTop,
    quitting: false,
    healthFailures: 0,
    win: null,
    tray: null,
    shownOnce: false,
    retryTimer: null,
  };

  const quit = () => {
    state.quitting = true;
    app.quit();
  };

  const trustedSender = (event) => {
    try {
      const url = event.senderFrame ? event.senderFrame.url : event.sender.getURL();
      return originOf(url) === state.origin;
    } catch {
      return false;
    }
  };

  function applyAlwaysOnTop(on) {
    state.alwaysOnTop = Boolean(on);
    if (state.win && !state.win.isDestroyed()) state.win.setAlwaysOnTop(state.alwaysOnTop, 'floating');
    updateTrayMenu();
  }

  function focusInput() {
    const win = state.win;
    if (!win || win.isDestroyed()) return;
    win.webContents.executeJavaScript('window.anywhereFocusInput && window.anywhereFocusInput()', true).catch(() => {});
  }

  function showWindow(withInputFocus) {
    if (!app.isReady()) {
      app.whenReady().then(() => showWindow(withInputFocus));
      return;
    }
    if (!state.win || state.win.isDestroyed()) createWindow();
    const win = state.win;
    if (win.isMinimized()) win.restore();
    win.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.focus();
    // Some window managers drop the topmost flag while a window is hidden.
    if (state.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
    if (withInputFocus) focusInput();
  }

  function toggleWindow() {
    const win = state.win;
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused() && !win.isMinimized()) win.hide();
    else showWindow(true);
  }

  function scheduleReload(delayMs) {
    if (state.retryTimer || state.quitting) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (!state.quitting && state.win && !state.win.isDestroyed()) state.win.loadURL(state.url).catch(() => {});
    }, delayMs);
  }

  function createWindow() {
    let workArea = null;
    try {
      workArea = screen.getPrimaryDisplay().workArea;
    } catch {
      workArea = null;
    }
    const b = windowBounds(workArea, opts.width, opts.height, opts.position);
    let icon;
    try {
      icon = nativeImage.createFromDataURL(ICON_DATA_URL);
    } catch {
      icon = undefined;
    }
    const win = new BrowserWindow({
      title: WINDOW_TITLE,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      alwaysOnTop: state.alwaysOnTop,
      autoHideMenuBar: true,
      icon,
      backgroundColor: nativeTheme && nativeTheme.shouldUseDarkColors ? '#1f1e1d' : '#faf9f5',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
        webviewTag: false,
        // Keep the voice pipeline and SSE timers running while the window is hidden.
        backgroundThrottling: false,
      },
    });
    state.win = win;
    if (state.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
    try {
      win.setContentProtection(Boolean(opts.hideFromScreenshots));
    } catch (err) {
      warn(`content protection is unavailable: ${err.message}`);
    }

    win.once('ready-to-show', () => {
      state.shownOnce = true;
      win.show();
    });
    // Show anyway if the first paint never happens (e.g. the daemon is briefly unreachable).
    setTimeout(() => {
      if (!state.shownOnce && !win.isDestroyed()) {
        state.shownOnce = true;
        win.show();
      }
    }, 5000);
    // The title stays fixed so the daemon (and the model) can always find this window.
    win.on('page-title-updated', (e) => e.preventDefault());
    win.on('close', (e) => {
      if (!state.quitting) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => {
      if (state.win === win) state.win = null;
    });

    const wc = win.webContents;
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      // -3 is ERR_ABORTED (a navigation replaced by another one).
      if (isMainFrame && code !== -3) scheduleReload(2000);
    });
    wc.on('render-process-gone', (_e, details) => {
      if (!details || details.reason !== 'clean-exit') scheduleReload(1000);
    });
    win.loadURL(state.url).catch(() => {
      /* did-fail-load retries */
    });
    return win;
  }

  function updateTrayMenu() {
    if (!state.tray) return;
    try {
      state.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: `Show ${WINDOW_TITLE}`, click: () => showWindow(true) },
          { label: 'Always on top', type: 'checkbox', checked: state.alwaysOnTop, click: (item) => applyAlwaysOnTop(item.checked) },
          { type: 'separator' },
          { label: 'Quit', click: quit },
        ])
      );
    } catch (err) {
      warn(`tray menu failed: ${err.message}`);
    }
  }

  function createTray() {
    try {
      state.tray = new Tray(nativeImage.createFromDataURL(ICON_DATA_URL));
      state.tray.setToolTip(WINDOW_TITLE);
      state.tray.on('click', () => toggleWindow());
      updateTrayMenu();
    } catch (err) {
      // Some Linux desktops have no status area; the hotkey and `anywhere show` still work.
      warn(`no tray icon: ${err.message}`);
      state.tray = null;
    }
  }

  async function checkHealth() {
    if (state.quitting) return;
    let ok = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const doFetch = typeof fetch === 'function' ? fetch : net && net.fetch ? net.fetch.bind(net) : null;
      if (!doFetch) return;
      const res = await doFetch(`${state.origin}/api/health`, { signal: ctrl.signal, cache: 'no-store' });
      const body = res.ok ? await res.json().catch(() => null) : null;
      ok = Boolean(body && body.app === 'claude-anywhere');
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    state.healthFailures = ok ? 0 : state.healthFailures + 1;
    if (state.healthFailures >= HEALTH_MAX_FAILURES) {
      warn('the Claude Anywhere daemon is gone; quitting');
      quit();
    }
  }

  // ----- security for every web contents (including same-origin popups)
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    const guard = (e, legacyUrl) => {
      // Electron >= 28 puts the URL on the event; the positional argument is deprecated.
      const url = typeof legacyUrl === 'string' ? legacyUrl : (e && e.url) || '';
      if (originOf(url) === state.origin) return;
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      if (originOf(url) === state.origin) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
          },
        };
      }
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
  });

  app.on('second-instance', (_e, argv, _cwd, additionalData) => {
    const next = parseArgs(argv);
    const nextUrl = (additionalData && typeof additionalData.url === 'string' && additionalData.url) || next.url;
    if (nextUrl && originOf(nextUrl) && nextUrl !== state.url) {
      // The daemon restarted (new port or token): follow it.
      state.url = nextUrl;
      state.origin = originOf(nextUrl);
      state.healthFailures = 0;
      if (state.win && !state.win.isDestroyed()) state.win.loadURL(state.url).catch(() => {});
    }
    showWindow(true);
  });

  app.on('before-quit', () => {
    state.quitting = true;
  });
  app.on('window-all-closed', () => {
    if (state.quitting || process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => showWindow(false));
  app.on('will-quit', () => {
    try {
      globalShortcut.unregisterAll();
    } catch {
      /* ignore */
    }
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, quit);
    } catch {
      /* not supported on this platform */
    }
  }

  ipcMain.on('anywhere:hide', (event) => {
    if (!trustedSender(event)) return;
    if (state.win && !state.win.isDestroyed()) state.win.hide();
  });
  ipcMain.on('anywhere:always-on-top', (event, on) => {
    if (!trustedSender(event)) return;
    applyAlwaysOnTop(Boolean(on));
  });

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const requestingUrl = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
      const allowed = permissionAllowed({
        permission,
        origin: originOf(requestingUrl),
        trustedOrigin: state.origin,
        mediaTypes: details && details.mediaTypes,
      });
      if (!allowed) {
        callback(false);
        return;
      }
      if (permission === 'media' && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
        systemPreferences
          .askForMediaAccess('microphone')
          .then((granted) => callback(Boolean(granted)))
          .catch(() => callback(false));
        return;
      }
      callback(true);
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
      permissionAllowed({
        permission,
        origin: originOf(requestingOrigin || (details && details.requestingUrl)),
        trustedOrigin: state.origin,
        mediaType: details && details.mediaType,
      })
    );

    createWindow();
    createTray();

    if (opts.hotkey) {
      try {
        if (!globalShortcut.register(opts.hotkey, toggleWindow)) {
          warn(`the hotkey ${opts.hotkey} is already in use by another app; change ui.hotkey`);
        }
      } catch (err) {
        warn(`invalid hotkey "${opts.hotkey}": ${err.message}`);
      }
    }

    const health = setInterval(() => {
      checkHealth().catch(() => {});
    }, HEALTH_INTERVAL_MS);
    app.on('will-quit', () => clearInterval(health));
  });
}

if (IS_ELECTRON_MAIN) {
  start();
} else if (require.main === module) {
  process.stderr.write('src/electron/main.js must be run with Electron: electron src/electron/main.js --url <url>\n');
  process.exitCode = 1;
}

module.exports = {
  parseArgs,
  parseBool,
  originOf,
  permissionAllowed,
  windowBounds,
  ICON_DATA_URL,
  WINDOW_TITLE,
  HEALTH_INTERVAL_MS,
  HEALTH_MAX_FAILURES,
};
