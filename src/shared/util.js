'use strict';

/** Small dependency-free helpers shared by every module. */

const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID();
}

/** @param {number} [bytes] */
function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate a string to n characters, appending an ellipsis marker.
 * @param {string} str
 * @param {number} n
 */
function truncate(str, n) {
  if (str == null) return '';
  const s = String(str);
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, n);
  return `${s.slice(0, n - 1)}…`;
}

function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Buffer);
}

/**
 * Recursively merge b into a copy of a. Arrays and scalars from b replace a.
 * @returns {object}
 */
function deepMerge(a, b) {
  if (!isPlainObject(a)) return isPlainObject(b) ? deepMerge({}, b) : b === undefined ? a : b;
  const out = { ...a };
  if (!isPlainObject(b)) return out;
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : isPlainObject(v) ? deepMerge({}, v) : v;
  }
  return out;
}

/**
 * Turn markdown into something pleasant to read aloud: drop code blocks,
 * tables, links' URLs, emphasis markers and heading hashes.
 * @param {string} text
 */
function stripMarkdownForSpeech(text) {
  if (!text) return '';
  let s = String(text);
  s = s.replace(/```[\s\S]*?```/g, ' (code omitted) ');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s*\|.*\|\s*$/gm, '');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/https?:\/\/\S+/g, 'the link');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{2,}/g, '\n');
  return s.trim();
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nowIso() {
  return new Date().toISOString();
}

function debounce(fn, ms) {
  let t = null;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * Whether the terminal can show symbols like ⚙ ✓ ✗ … ·. ANYWHERE_ASCII=1 forces the ASCII set
 * and ANYWHERE_UNICODE=1 forces Unicode. Otherwise never with TERM=dumb or on the Linux console
 * (TERM=linux: its fonts lack most of these glyphs). On Windows only in terminals known to
 * draw them (legacy consoles often cannot). Elsewhere only under a UTF-8 locale, or the bytes
 * show as mojibake ("â€¦"): the effective locale is the first non-empty of LC_ALL, LC_CTYPE
 * and LANG. With none set the C library runs in the "C"/"POSIX" locale, so Linux and the other
 * Unixes get ASCII (always readable; set LANG=C.UTF-8 or ANYWHERE_UNICODE=1 for the symbols),
 * while macOS terminals are UTF-8 whatever the environment says.
 * @param {object} [env]
 * @param {string} [platform]
 */
function unicodeSupported(env = process.env, platform = process.platform) {
  if (env.ANYWHERE_ASCII === '1') return false;
  if (env.ANYWHERE_UNICODE === '1') return true;
  const term = String(env.TERM || '');
  if (term === 'dumb' || term === 'linux') return false;
  if (platform === 'win32') return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || /xterm|256color/i.test(term));
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (!locale) return platform === 'darwin';
  return /utf-?8/i.test(locale);
}

module.exports = {
  uuid,
  randomToken,
  sleep,
  truncate,
  safeJsonParse,
  isPlainObject,
  deepMerge,
  stripMarkdownForSpeech,
  escapeRegExp,
  nowIso,
  debounce,
  unicodeSupported,
};
