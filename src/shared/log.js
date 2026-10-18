'use strict';

/**
 * Logging that never touches stdout (the MCP server speaks JSON-RPC there)
 * plus an append-only JSONL audit trail of everything the agent did.
 */

const fs = require('fs');
const { auditLogPath, daemonLogPath } = require('./paths');

const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-***'],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-***'],
  [/gsk_[A-Za-z0-9]{20,}/g, 'gsk_***'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***'],
  [/AIza[0-9A-Za-z_-]{35}/g, 'AIza***'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/g, 'gh*_***'],
  [/github_pat_[A-Za-z0-9_]{30,}/g, 'github_pat_***'],
  [/xox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/ya29\.[0-9A-Za-z_-]{20,}/g, 'ya29.***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 ***'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2***'],
];

/**
 * Deep copy for logging: elides binary/image payloads and, when `secrets` is
 * true, masks likely secrets in strings. Fields that are Claude Anywhere's own
 * credentials (token, apiKey, ...) are always masked.
 */
function scrub(value, secrets) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (!secrets) return value;
    let s = value;
    for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(token|apiKey|sttApiKey|password|secret|authorization)$/i.test(k) && typeof v === 'string' && v) {
        out[k] = '***';
      } else if ((k === 'image' || k === 'data' || k === 'dataUrl') && typeof v === 'string' && v.length > 256) {
        out[k] = `[${v.length} chars]`;
      } else {
        out[k] = scrub(v, secrets);
      }
    }
    return out;
  }
  return value;
}

/** Mask likely secrets in strings (deep for objects/arrays). Always masks, whatever the log setting. */
function redact(value) {
  return scrub(value, true);
}

// privacy.redactSecretsInLogs: masks secrets in daemon/MCP log lines and the audit trail.
let redactLogs = true;
function setRedactLogs(on) {
  redactLogs = Boolean(on);
}

let fileStream = null;
function sink() {
  if (process.env.ANYWHERE_LOG_FILE === '1') {
    if (!fileStream) {
      try {
        fileStream = fs.createWriteStream(daemonLogPath(), { flags: 'a' });
      } catch {
        fileStream = null;
      }
    }
    if (fileStream) return (line) => fileStream.write(`${line}\n`);
  }
  return (line) => process.stderr.write(`${line}\n`);
}

function fmt(arg) {
  if (arg instanceof Error) return scrub(String(arg.stack || arg.message), redactLogs);
  if (typeof arg === 'string') return scrub(arg, redactLogs);
  try {
    return JSON.stringify(scrub(arg, redactLogs));
  } catch {
    return String(arg);
  }
}

/** @param {string} name */
function createLogger(name) {
  const write = (level, args) => {
    if (level === 'debug' && process.env.ANYWHERE_DEBUG !== '1') return;
    const line = `[${new Date().toISOString()}] [${name}] ${level.toUpperCase()} ${args.map(fmt).join(' ')}`;
    try {
      sink()(line);
    } catch {
      /* never let logging crash the process */
    }
  };
  return {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
  };
}

let auditEnabled = true;
function setAuditEnabled(on) {
  auditEnabled = Boolean(on);
}

/** Apply config.privacy to this process; only an explicit `false` turns a setting off. */
function applyPrivacyConfig(config) {
  const privacy = (config && config.privacy) || {};
  setAuditEnabled(privacy.auditLog !== false);
  setRedactLogs(privacy.redactSecretsInLogs !== false);
}

/** Append one event to today's audit log (JSONL). Never throws. */
function audit(event) {
  if (!auditEnabled) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...scrub(event, redactLogs) });
    fs.appendFileSync(auditLogPath(), `${line}\n`, { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

module.exports = { createLogger, audit, redact, setAuditEnabled, setRedactLogs, applyPrivacyConfig };
