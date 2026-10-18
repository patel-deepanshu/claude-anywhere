'use strict';

/**
 * User configuration (~/.claude-anywhere/config.json). The file only needs to
 * hold overrides; everything else comes from DEFAULTS.
 */

const fs = require('fs');
const { configPath } = require('./paths');
const { deepMerge, isPlainObject } = require('./util');

const DEFAULTS = Object.freeze({
  port: 47120,
  mode: 'companion',
  ui: {
    host: 'auto',
    alwaysOnTop: true,
    hotkey: 'CommandOrControl+Shift+Space',
    theme: 'system',
    width: 440,
    height: 720,
    position: 'right',
    hideFromScreenshots: true,
    openOnStart: true,
  },
  engine: {
    claudePath: '',
    model: '',
    fallbackModel: '',
    effort: '',
    chrome: false,
    addVsCodeWorkspaces: true,
    resumeLast: true,
    maxBudgetUsd: 0,
    extraArgs: [],
    stripEnv: [
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_PID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SSE_PORT',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_CODE_REMOTE_SESSION_ID',
      'CLAUDE_CODE_DIAGNOSTICS_FILE',
      'CLAUDE_CODE_TEE_SDK_STDOUT',
    ],
  },
  permissions: {
    mode: 'smart',
    approvalTimeoutSec: 600,
    alwaysAllow: [],
    alwaysAsk: [],
  },
  computer: {
    maxWidth: 1366,
    maxHeight: 768,
    failsafe: true,
    actionDelayMs: 120,
    pasteThreshold: 200,
  },
  context: {
    attachDesktopContext: true,
    attachScreenshotByDefault: false,
    includeWindows: true,
    includeCloud: true,
  },
  voice: {
    stt: 'auto',
    tts: 'auto',
    language: 'en-US',
    autoSend: true,
    speakResponses: true,
    handsFree: false,
    wakeWord: 'hey claude',
    ttsRate: 1.0,
    ttsVoice: '',
    sttProvider: 'auto',
    sttBaseUrl: '',
    sttApiKey: '',
    sttModel: '',
    whisperCppPath: '',
    whisperModel: '',
    // Spoken voice. 'auto' prefers a free local neural voice (Piper) when installed, then the
    // best natural browser voice, then the OS voice. 'piper' | 'browser' | 'os' force one.
    ttsEngine: 'auto',
    piperVoice: 'en_US-lessac-medium',
    // What is announced aloud (when speakResponses is on): finished work, a permission card,
    // a question from Claude, and failures. chime plays a short tone first.
    announce: { done: true, permission: true, question: true, error: true },
    chime: true,
  },
  // Jira Cloud/Data Center REST access for ticket work (optional: Claude falls back to a Jira MCP
  // server, then to reading the browser tab). apiToken is stored locally (0600) and never shown.
  jira: {
    baseUrl: '',
    email: '',
    apiToken: '',
  },
  // Folders searched for git repositories when Claude asks where to work (besides open editors).
  workspace: {
    roots: [],
  },
  privacy: {
    redactSecretsInLogs: true,
    auditLog: true,
  },
});

const SECRET_KEYS = [['voice', 'sttApiKey'], ['jira', 'apiToken']];

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function readFileConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @returns {typeof DEFAULTS} merged config (defaults + file) */
function load() {
  return deepMerge(clone(DEFAULTS), readFileConfig());
}

/**
 * Merge `partial` into the stored overrides and write the file (0600).
 * @returns {typeof DEFAULTS} the full merged config
 */
function save(partial) {
  const current = readFileConfig();
  const next = deepMerge(current, partial || {});
  const file = configPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return deepMerge(clone(DEFAULTS), next);
}

/** Remove all overrides. */
function reset() {
  try {
    fs.unlinkSync(configPath());
  } catch {
    /* already gone */
  }
  return load();
}

/** @param {object} cfg @param {string} dotted */
function get(cfg, dotted) {
  if (!dotted) return cfg;
  return dotted.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), cfg);
}

/** @param {object} cfg @param {string} dotted @param {*} value */
function setPath(cfg, dotted, value) {
  const keys = dotted.split('.');
  let cur = cfg;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return cfg;
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') return cfg;
  cur[last] = value;
  return cfg;
}

/** Turn CLI strings into typed values: "true" → true, "3" → 3, '["a"]' → array. */
function coerce(str) {
  if (typeof str !== 'string') return str;
  const t = str.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      return str;
    }
  }
  return str;
}

/** Config safe to send to the UI: secrets blanked, with *Set flags. */
function publicConfig(cfg) {
  const out = clone(cfg);
  for (const [section, key] of SECRET_KEYS) {
    if (out[section]) {
      out[section][`${key}Set`] = Boolean(out[section][key]);
      out[section][key] = '';
    }
  }
  return out;
}

/**
 * Validate a partial update coming from the UI or CLI. Unknown top-level
 * keys are dropped; secret fields that arrive empty are ignored so the UI
 * can round-trip publicConfig() without wiping keys.
 */
function sanitizeUpdate(partial) {
  if (!isPlainObject(partial)) return {};
  const out = {};
  for (const [k, v] of Object.entries(partial)) {
    if (!(k in DEFAULTS)) continue;
    out[k] = clone(v);
  }
  for (const [section, key] of SECRET_KEYS) {
    if (out[section] && isPlainObject(out[section])) {
      delete out[section][`${key}Set`];
      if (out[section][key] === '' || out[section][key] == null) delete out[section][key];
    }
  }
  return out;
}

module.exports = {
  DEFAULTS,
  load,
  save,
  reset,
  get,
  setPath,
  coerce,
  publicConfig,
  sanitizeUpdate,
};
