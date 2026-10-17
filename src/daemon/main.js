'use strict';

/**
 * Daemon entry point: wires the hub, brokers, bridge, session, HTTP server,
 * voice and UI host together, writes daemon.json and handles shutdown.
 *
 * Optional modules (permissions, prompt, voice, uihost, os, context) are
 * loaded defensively: a missing or broken one degrades the daemon instead of
 * stopping it (no voice → voice capabilities false, no UI host → the URL is
 * printed, no policy module → every non-read-only tool asks the user).
 *
 * Run directly: node src/daemon/main.js [--project DIR] [--mode companion|bridge]
 *                                       [--ui HOST] [--no-open] [--port N]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const configMod = require('../shared/config');
const paths = require('../shared/paths');
const state = require('../shared/state');
const platformMod = require('../shared/platform');
const { spawnDetached } = require('../shared/proc');
const { uuid, randomToken, sleep, nowIso, truncate } = require('../shared/util');
const { createLogger, audit, setAuditEnabled } = require('../shared/log');
const { Hub } = require('./hub');
const { QuestionBroker } = require('./questions');
const { Bridge } = require('./bridge');
const { SessionManager, displayName, summary, READ_ONLY_TOOLS } = require('./session');
const { createServer } = require('./server');

const log = createLogger('daemon');

const ATTENTION_THROTTLE_MS = 3000;
const SHUTDOWN_HARD_MS = 8000;
const UI_OPEN_TIMEOUT_MS = 20000;
const FALLBACK_DRIVER_METHODS = [
  'capabilities', 'displays', 'captureDisplay', 'cursorPosition', 'moveMouse', 'click', 'mouseDown', 'mouseUp', 'drag',
  'scroll', 'typeText', 'keyCombo', 'listWindows', 'activeWindow', 'focusWindow', 'minimizeWindow', 'setTopmost',
  'clipboardGet', 'clipboardSet', 'close',
];

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.PACKAGE_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * require() that never throws: logs and returns null when the module is
 * missing or fails to load.
 * @param {string} rel path relative to this file
 * @param {string[]} [exportsNeeded]
 * @returns {object|null}
 */
function optionalRequire(rel, exportsNeeded = []) {
  try {
    const mod = require(rel);
    const missing = exportsNeeded.filter((n) => !mod || mod[n] == null);
    if (missing.length) {
      log.warn(`${rel} does not export ${missing.join(', ')}; that feature is disabled`);
      return null;
    }
    return mod;
  } catch (err) {
    const target = path.basename(rel);
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(target)) {
      log.warn(`${rel} is not available; continuing without it`);
    } else {
      log.error(`${rel} failed to load; continuing without it:`, err);
    }
    return null;
  }
}

/**
 * A driver stand-in that creates the real driver on the first method call.
 * @param {()=>Promise<object>} getDriver
 * @param {string[]} [methods]
 * @returns {object}
 */
function createLazyDriver(getDriver, methods = FALLBACK_DRIVER_METHODS) {
  const lazy = { name: 'lazy', lazy: true };
  for (const m of methods) {
    lazy[m] = async (...args) => {
      const d = await getDriver();
      if (!d || typeof d[m] !== 'function') {
        const e = new Error(`The desktop driver does not support ${m}()`);
        e.code = 'UNSUPPORTED';
        throw e;
      }
      return d[m](...args);
    };
  }
  return lazy;
}

/**
 * Minimal approval broker used only when src/daemon/permissions.js is
 * unavailable: read-only anywhere tools pass, everything else asks the user.
 */
class BasicPermissionBroker {
  constructor({ config, hub, onNeedAttention } = {}) {
    this.config = config;
    this.hub = hub;
    this.onNeedAttention = onNeedAttention;
    this.entries = new Map();
    this.sessionAllow = new Set();
  }

  async request({ tool_name: toolName, input, tool_use_id: toolUseId } = {}) {
    const name = String(toolName || '');
    const inp = input && typeof input === 'object' ? input : {};
    if (READ_ONLY_TOOLS.includes(name) || this.sessionAllow.has(name)) {
      audit({ type: 'permission', tool: name, decision: 'allow', by: 'rule' });
      return { behavior: 'allow', updatedInput: inp };
    }
    const id = `ap_${uuid()}`;
    const card = {
      id,
      toolName: name,
      displayName: displayName(name),
      summary: summary(name, inp),
      input: inp,
      risk: 'medium',
      reason: 'Approval required (the permission policy module is not installed)',
      ts: nowIso(),
      toolUseId: toolUseId || null,
    };
    const timeoutSec = Number((this.config.permissions || {}).approvalTimeoutSec) || 600;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finish(id, 'deny', `No response from the user within ${timeoutSec} s`, 'timeout');
      }, timeoutSec * 1000);
      this.entries.set(id, { card, resolve, timer });
      this.hub.broadcast('approval_request', card);
      if (typeof this.onNeedAttention === 'function') {
        try {
          this.onNeedAttention({ kind: 'approval', id, summary: `${card.displayName}: ${card.summary}` });
        } catch {
          /* ignore */
        }
      }
    });
  }

  finish(id, decision, message, why) {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    clearTimeout(e.timer);
    const allow = decision === 'allow' || decision === 'allow_session';
    if (decision === 'allow_session') this.sessionAllow.add(e.card.toolName);
    audit({ type: 'permission', tool: e.card.toolName, summary: e.card.summary, decision, by: why || 'user' });
    this.hub.broadcast('approval_resolved', { id, decision });
    e.resolve(allow ? { behavior: 'allow', updatedInput: e.card.input } : { behavior: 'deny', message: message || 'The user denied this action' });
    return true;
  }

  resolve(id, decision, message) {
    if (!['allow', 'allow_session', 'deny'].includes(decision)) return false;
    return this.finish(id, decision, message, 'user');
  }

  cancelAll(reason = 'Cancelled') {
    for (const id of [...this.entries.keys()]) this.finish(id, 'deny', reason, 'cancel');
  }

  pending() {
    return [...this.entries.values()].map((e) => e.card);
  }

  setMode() {
    /* the basic broker always asks */
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Run the daemon in this process.
 * @param {{project?:string, mode?:'companion'|'bridge', ui?:string, open?:boolean, port?:number,
 *   handleSignals?:boolean, exitProcess?:boolean, installCrashHandlers?:boolean, allowMultiple?:boolean}} [opts]
 * @returns {Promise<{url:string, port:number, token:string, instanceId:string, hub:Hub, session:SessionManager,
 *   server:object, shutdown:(reason?:string)=>Promise<void>, done:Promise<void>}>}
 */
async function runDaemon(opts = {}) {
  const {
    project,
    mode,
    ui,
    open = true,
    port,
    handleSignals = true,
    exitProcess = handleSignals,
    installCrashHandlers = handleSignals,
    allowMultiple = false,
  } = opts;
  const config = configMod.load();
  setAuditEnabled(!(config.privacy && config.privacy.auditLog === false));
  if (ui) config.ui.host = ui;
  const platformInfo = platformMod.info();
  const version = packageVersion();

  if (!allowMultiple) {
    const existing = await state.findRunningDaemon({ timeoutMs: 1500 });
    if (existing && existing.pid !== process.pid) {
      const e = new Error(`Claude Anywhere is already running (pid ${existing.pid}, ${existing.url || `port ${existing.port}`})`);
      e.code = 'ALREADY_RUNNING';
      e.state = existing;
      throw e;
    }
  }

  let projectDir = path.resolve(project || process.cwd());
  if (!isDir(projectDir)) {
    log.warn(`project directory ${projectDir} does not exist; using ${process.cwd()}`);
    projectDir = process.cwd();
  }
  let daemonMode = mode || config.mode || 'companion';
  if (daemonMode !== 'companion' && daemonMode !== 'bridge') {
    log.warn(`unknown mode "${daemonMode}"; using companion`);
    daemonMode = 'companion';
  }
  const instanceId = uuid();
  const token = randomToken();
  const startedAt = nowIso();

  // ---- optional modules
  const osMod = optionalRequire('../os/index', ['getDriver']);
  const computerMod = optionalRequire('../os/computer', ['Computer']);
  const commonMod = optionalRequire('../os/common', ['notify']);
  const contextMod = optionalRequire('../context/desktop');
  const promptMod = optionalRequire('./prompt', ['buildSystemPrompt']);
  const permMod = optionalRequire('./permissions', ['PermissionBroker']);
  const voiceMod = optionalRequire('./voice', ['VoiceService']);
  const uihostMod = optionalRequire('./uihost', ['UiHost']);

  // ---- lazy driver / computer (created by the first request that needs them)
  let session = null;
  let driverPromise = null;
  let driverInstance = null;
  const getDriver = () => {
    if (!driverPromise) {
      driverPromise = (async () => {
        if (!osMod) {
          const e = new Error('Desktop control is not available in this installation (src/os is missing)');
          e.code = 'UNSUPPORTED';
          throw e;
        }
        const d = await osMod.getDriver();
        driverInstance = d;
        if (session && d && d.name) session.setDriverName(d.name);
        return d;
      })();
      driverPromise.catch(() => {
        driverPromise = null;
      });
    }
    return driverPromise;
  };
  let computerPromise = null;
  const getComputer = () => {
    if (!computerPromise) {
      computerPromise = (async () => {
        if (!computerMod) {
          const e = new Error('Screen capture is not available in this installation (src/os/computer.js is missing)');
          e.code = 'UNSUPPORTED';
          throw e;
        }
        const driver = await getDriver();
        // 'memory': the daemon only takes full-display shots (deterministic size), and must not
        // overwrite the CLI's last-shot.json geometry.
        return new computerMod.Computer({ driver, config: config.computer, geometryStore: 'file' });
      })();
      computerPromise.catch(() => {
        computerPromise = null;
      });
    }
    return computerPromise;
  };
  const driverMethods = [...new Set([...FALLBACK_DRIVER_METHODS, ...(osMod && Array.isArray(osMod.DRIVER_METHODS) ? osMod.DRIVER_METHODS : [])])];
  const lazyDriver = createLazyDriver(getDriver, driverMethods);

  const context = contextMod
    ? {
        gatherContext: typeof contextMod.gatherContext === 'function' ? contextMod.gatherContext : undefined,
        formatContext: typeof contextMod.formatContext === 'function' ? contextMod.formatContext : undefined,
        detectProjects: typeof contextMod.detectProjects === 'function' ? contextMod.detectProjects : undefined,
        projectInfo: typeof contextMod.projectInfo === 'function' ? contextMod.projectInfo : undefined,
      }
    : {};

  // ---- core
  const hub = new Hub();
  let voice = null;
  if (voiceMod) {
    try {
      voice = new voiceMod.VoiceService({ config });
    } catch (err) {
      log.error('VoiceService failed to start; voice is disabled:', err);
    }
  }
  let uihost = null;
  if (uihostMod) {
    try {
      uihost = new uihostMod.UiHost({ config, platformInfo, driver: lazyDriver });
    } catch (err) {
      log.error('UiHost failed to start; the dialog URL will be printed instead:', err);
    }
  }
  const notifyOS = commonMod ? (title, body) => commonMod.notify(title, body) : null;

  let server = null;
  let lastAttention = 0;
  const onNeedAttention = (info = {}) => {
    const now = Date.now();
    if (now - lastAttention < ATTENTION_THROTTLE_MS) return;
    lastAttention = now;
    const kind = info && info.kind === 'question' ? 'question' : 'approval';
    const detail = truncate(String((info && (info.summary || info.question || info.displayName || info.toolName)) || ''), 200);
    if (hub.clientCount() === 0 && uihost && server) {
      Promise.resolve()
        .then(() => uihost.show(server.url))
        .catch((err) => log.warn(`could not show the dialog: ${err.message}`));
    }
    if (notifyOS) {
      Promise.resolve()
        .then(() => notifyOS('Claude needs your input', detail || (kind === 'question' ? 'Claude has a question for you.' : 'Claude is waiting for your approval.')))
        .catch((err) => log.debug(`OS notification failed: ${err.message}`));
    }
    const v = config.voice || {};
    if (voice && v.speakResponses && v.tts !== 'off') {
      Promise.resolve()
        .then(() => voice.speak(kind === 'question' ? 'Claude has a question for you' : 'Claude needs your approval', { rate: v.ttsRate, voice: v.ttsVoice || undefined }))
        .catch((err) => log.debug(`speaking the attention prompt failed: ${err.message}`));
    }
  };

  let permissions = null;
  if (permMod) {
    try {
      permissions = new permMod.PermissionBroker({ config, hub, onNeedAttention });
    } catch (err) {
      log.error('PermissionBroker failed to start; using the basic always-ask broker:', err);
    }
  }
  if (!permissions) permissions = new BasicPermissionBroker({ config, hub, onNeedAttention });
  const questions = new QuestionBroker({ hub, onNeedAttention });
  const bridge = new Bridge({ hub });
  if (daemonMode !== 'bridge') bridge.stop();

  // ---- shutdown plumbing (declared before the server so /api/shutdown can call it)
  let shuttingDown = null;
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });
  const signalHandlers = [];

  const applyConfig = (next, prev) => {
    for (const k of Object.keys(next)) config[k] = next[k];
    setAuditEnabled(!(config.privacy && config.privacy.auditLog === false));
    const pm = config.permissions && config.permissions.mode;
    if (prev && prev.permissions && pm !== prev.permissions.mode && typeof permissions.setMode === 'function') {
      try {
        permissions.setMode(pm);
      } catch (err) {
        log.warn(`permission mode change failed: ${err.message}`);
      }
    }
    if (prev && JSON.stringify(prev.computer) !== JSON.stringify(config.computer)) computerPromise = null;
    if (session) session.applyConfig(config);
    if (voice) {
      try {
        if (typeof voice.updateConfig === 'function') voice.updateConfig(config);
        else if ('config' in voice) voice.config = config;
      } catch {
        /* ignore */
      }
      refreshVoice(true);
    }
  };

  const refreshVoice = (broadcastSnapshot) => {
    if (!voice || typeof voice.capabilities !== 'function') return;
    Promise.race([voice.capabilities(), sleep(8000).then(() => null)])
      .then((caps) => {
        if (!caps || !session) return;
        const before = JSON.stringify(session.voiceInfo);
        session.setVoiceInfo(caps);
        if (broadcastSnapshot && JSON.stringify(session.voiceInfo) !== before) hub.broadcast('snapshot', session.snapshot());
      })
      .catch((err) => log.warn(`voice capabilities failed: ${err.message}`));
  };

  const shutdown = (reason = 'shutdown') => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      log.info(`shutting down (${reason})`);
      audit({ type: 'daemon_stop', reason, instanceId });
      const hard = setTimeout(() => {
        log.warn('shutdown is taking too long; exiting now');
        state.clearDaemonState(instanceId);
        if (exitProcess) process.exit(0);
      }, SHUTDOWN_HARD_MS);
      if (hard.unref) hard.unref();
      const step = async (what, fn) => {
        try {
          await fn();
        } catch (err) {
          log.warn(`shutdown: ${what} failed: ${err && err.message}`);
        }
      };
      hub.broadcast('status', { status: 'offline', detail: 'Claude Anywhere stopped' });
      await step('cancel approvals', () => permissions.cancelAll('Claude Anywhere is shutting down'));
      await step('cancel questions', () => questions.cancelAll('Claude Anywhere is shutting down'));
      await step('close bridge', () => bridge.close());
      if (session) await step('stop session', () => session.shutdown());
      if (uihost) await step('close dialog', () => uihost.close());
      if (voice) await step('stop voice', () => voice.stop());
      if (driverInstance) {
        await step('close driver', () => (osMod && typeof osMod.resetDriver === 'function' ? osMod.resetDriver() : driverInstance.close && driverInstance.close()));
      }
      hub.close();
      if (server) await step('close server', () => server.close());
      state.clearDaemonState(instanceId);
      for (const [sig, fn] of signalHandlers) process.removeListener(sig, fn);
      clearTimeout(hard);
      resolveDone();
      if (exitProcess) setImmediate(() => process.exit(0));
    })();
    return shuttingDown;
  };

  // ---- HTTP server
  server = createServer({
    hub,
    session: null,
    permissions,
    questions,
    bridge,
    voice,
    uihost,
    context,
    getDriver,
    config,
    token,
    instanceId,
    version,
    applyConfig,
    notifyOS,
    onShutdown: (why) => shutdown(why),
  });
  const wanted = Number.isInteger(port) ? port : Number.isInteger(config.port) ? config.port : 47120;
  let boundPort;
  try {
    boundPort = await server.listen(wanted);
  } catch (err) {
    if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES') && wanted !== 0) {
      log.warn(`port ${wanted} is unavailable (${err.code}); using a random free port`);
      boundPort = await server.listen(0);
    } else {
      throw err;
    }
  }
  const url = server.url;

  session = new SessionManager({
    config,
    hub,
    permissions,
    questions,
    bridge,
    port: boundPort,
    token,
    projectDir,
    mode: daemonMode,
    instanceId,
    version,
    getComputer,
    getDriver,
    context,
    buildSystemPrompt: promptMod ? promptMod.buildSystemPrompt : null,
    platformInfo,
  });
  server.session = session;
  server.deps.session = session;
  hub.setSnapshotProvider(() => session.snapshot());
  if (osMod && typeof osMod.selectBackend === 'function') {
    try {
      session.setDriverName(osMod.selectBackend().backend);
    } catch {
      /* ignore */
    }
  }

  const writeState = () => {
    try {
      state.writeDaemonState({
        pid: process.pid,
        port: boundPort,
        token,
        instanceId,
        version,
        startedAt,
        project: session.projectDir,
        mode: session.mode,
        url,
      });
    } catch (err) {
      log.error(`could not write ${paths.daemonStatePath()}: ${err.message}`);
    }
  };
  writeState();
  session.on('project', writeState);
  session.on('mode', writeState);

  audit({ type: 'daemon_start', instanceId, port: boundPort, project: projectDir, mode: daemonMode, version, pid: process.pid });
  log.info(`Claude Anywhere ${version} listening on 127.0.0.1:${boundPort} (project ${projectDir}, ${daemonMode} mode)`);

  session.init().catch((err) => log.warn(`project info failed: ${err.message}`));
  refreshVoice(false);

  // ---- process hooks
  if (handleSignals) {
    const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    if (process.platform === 'win32') sigs.push('SIGBREAK');
    for (const sig of sigs) {
      const fn = () => shutdown(sig);
      try {
        process.on(sig, fn);
        signalHandlers.push([sig, fn]);
      } catch {
        /* signal not supported here */
      }
    }
  }
  if (installCrashHandlers) {
    const onUncaught = (err) => log.error('uncaught exception (the daemon keeps running):', err);
    const onRejection = (reason) => log.error('unhandled promise rejection (the daemon keeps running):', reason instanceof Error ? reason : String(reason));
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    signalHandlers.push(['uncaughtException', onUncaught], ['unhandledRejection', onRejection]);
  }

  // ---- open the dialog
  const printUrl = (why) => {
    process.stderr.write(`Claude Anywhere is running. Open this URL to use the dialog${why ? ` (${why})` : ''}:\n  ${url}\nOr run: anywhere tui\n`);
  };
  const wantOpen = open && (config.ui || {}).openOnStart !== false && (config.ui || {}).host !== 'none';
  if (wantOpen) {
    if (uihost) {
      try {
        const r = await Promise.race([
          uihost.open(url),
          sleep(UI_OPEN_TIMEOUT_MS).then(() => {
            throw new Error(`no window after ${UI_OPEN_TIMEOUT_MS / 1000} s`);
          }),
        ]);
        log.info(`dialog opened with ${(r && r.host) || 'none'}${r && r.detail ? ` (${r.detail})` : ''}`);
        if (!r || r.host === 'none') printUrl('no window host is available');
      } catch (err) {
        log.warn(`opening the dialog failed: ${err.message}`);
        printUrl('the window could not be opened');
      }
    } else {
      printUrl('no window host is installed');
    }
  } else if (handleSignals) {
    printUrl();
  }

  return {
    url,
    port: boundPort,
    token,
    instanceId,
    version,
    hub,
    session,
    server,
    permissions,
    questions,
    bridge,
    voice,
    uihost,
    shutdown,
    done,
  };
}

/**
 * Parse `main.js` argv.
 * @param {string[]} argv
 * @returns {{project?:string, mode?:string, ui?:string, open:boolean, port?:number}}
 */
function parseDaemonArgs(argv) {
  const out = { open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (a === '--project' || a === '-p') out.project = val();
    else if (a.startsWith('--project=')) out.project = a.slice(10);
    else if (a === '--mode') out.mode = val();
    else if (a.startsWith('--mode=')) out.mode = a.slice(7);
    else if (a === '--ui') out.ui = val();
    else if (a.startsWith('--ui=')) out.ui = a.slice(5);
    else if (a === '--no-open') out.open = false;
    else if (a === '--port') out.port = Number(val());
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535)) throw new Error('--port must be 0..65535');
  return out;
}

function logTail(file, lines = 20) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Start the daemon as a detached background process (or reuse a running one)
 * and wait until it answers /api/health.
 * @param {{project?:string, mode?:string, ui?:string, open?:boolean, timeoutMs?:number, env?:object}} [opts]
 * @returns {Promise<object>} daemon state plus {reused:boolean}
 */
async function startDaemonProcess({ project, mode, ui, open = true, timeoutMs = 15000, env } = {}) {
  const existing = await state.findRunningDaemon();
  if (existing) return { ...existing, reused: true };
  const projectDir = path.resolve(project || process.cwd());
  const args = [__filename, '--project', projectDir];
  if (mode) args.push('--mode', mode);
  if (ui) args.push('--ui', ui);
  if (!open) args.push('--no-open');
  const logFile = paths.daemonLogPath();
  const child = spawnDetached(process.execPath, args, {
    cwd: isDir(projectDir) ? projectDir : os.homedir(),
    env: env || process.env,
    logFile,
  });
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.on('error', (error) => {
    exited = { error };
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await state.findRunningDaemon({ timeoutMs: 1000 });
    if (st && (!child.pid || st.pid === child.pid)) return { ...st, reused: false };
    if (st && exited) return { ...st, reused: true }; // another start won the race
    if (exited) {
      const how = exited.error ? exited.error.message : `exit code ${exited.code}${exited.signal ? `, ${exited.signal}` : ''}`;
      throw new Error(`The Claude Anywhere daemon stopped during startup (${how}). Log (${logFile}):\n${logTail(logFile)}`);
    }
    await sleep(150);
  }
  throw new Error(`The Claude Anywhere daemon did not answer within ${Math.round(timeoutMs / 1000)} s. Log (${logFile}):\n${logTail(logFile)}`);
}

if (require.main === module) {
  let parsed;
  try {
    parsed = parseDaemonArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`anywhere daemon: ${err.message}\n`);
    process.exit(2);
  }
  try {
    process.title = 'claude-anywhere-daemon';
  } catch {
    /* ignore */
  }
  runDaemon(parsed).catch((err) => {
    if (err && err.code === 'ALREADY_RUNNING') {
      process.stderr.write(`${err.message}\n`);
      process.exit(0);
    }
    process.stderr.write(`anywhere daemon failed to start: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

module.exports = { runDaemon, startDaemonProcess, parseDaemonArgs, createLazyDriver, BasicPermissionBroker, optionalRequire };
