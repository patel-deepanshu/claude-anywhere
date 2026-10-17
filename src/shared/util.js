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
};
