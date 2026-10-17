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

/** Mask likely secrets in strings (deep for objects/arrays). */
function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    let s = value;
    for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
    return s;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(token|apiKey|sttApiKey|password|secret|authorization)$/i.test(k) && typeof v === 'string' && v) {
        out[k] = '***';
      } else if ((k === 'image' || k === 'data' || k === 'dataUrl') && typeof v === 'string' && v.length > 256) {
        out[k] = `[${v.length} chars]`;
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
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
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(redact(arg));
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

/** Append one event to today's audit log (JSONL). Never throws. */
function audit(event) {
  if (!auditEnabled) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...redact(event) });
    fs.appendFileSync(auditLogPath(), `${line}\n`, { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

module.exports = { createLogger, audit, redact, setAuditEnabled };
