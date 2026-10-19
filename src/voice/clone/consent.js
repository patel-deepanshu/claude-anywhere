'use strict';

/**
 * Consent verification for voice enrollment (docs/CALLS-DESIGN.md §2.5).
 *
 * The enrollment starts with a spoken consent sentence that contains the owner's name and a fresh,
 * single-use 4-digit code. The take is transcribed by the local STT of the clone sidecar (never a
 * cloud service) and passes only when ALL of these hold:
 *   - the code digits appear in order (close together), so an older recording cannot be replayed;
 *   - a word starting with agree|consent appears, and the word "voice" appears;
 *   - a fuzzy word alignment against the expected sentence scores ≥ 0.80 (words of 4+ letters count
 *     as equal at edit distance ≤ ⌊len/3⌋, which tolerates ASR spellings of names).
 * The name is checked loosely and only recorded (`nameHeard`): names are the most common ASR error,
 * and the code is the liveness check.
 */

const crypto = require('crypto');
const { consentSentence, cleanName } = require('./script');

const CODE_TTL_MS = 10 * 60 * 1000;
const MIN_SIMILARITY = 0.8;
const MAX_ATTEMPTS = 3; // failed readings of one code before a fresh code is issued
const CODE_WINDOW = 8; // the 4 code digits must fall within this many words

const NUMBER_WORDS = {
  zero: '0',
  oh: '0',
  o: '0',
  one: '1',
  won: '1',
  two: '2',
  to: '2',
  too: '2',
  three: '3',
  tree: '3',
  four: '4',
  for: '4',
  fore: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  ate: '8',
  nine: '9',
};

/**
 * Normalize a sentence into comparable words: lower case, accents and punctuation removed, digits
 * split apart ("4729" → 4 7 2 9) and number words mapped to digits ("four"/"for" → 4).
 * @param {string} text
 * @returns {string[]}
 */
function normalizeWords(text) {
  const s = String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/(\d)/g, ' $1 ')
    .replace(/'s\b/g, 's')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!s) return [];
  return s.split(/\s+/).map((w) => NUMBER_WORDS[w] || w);
}

/** Levenshtein distance (small strings). */
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * Whether a heard word counts as the expected one: equal, or (4+ letters) within ⌊len/3⌋ edits.
 * @param {string} expected
 * @param {string} heard
 */
function wordsMatch(expected, heard) {
  if (expected === heard) return true;
  if (expected.length < 4 || /\d/.test(expected) || /\d/.test(heard)) return false;
  return editDistance(expected, heard) <= Math.floor(expected.length / 3);
}

/**
 * Fuzzy word alignment (LCS with fuzzy word equality).
 * @param {string[]} expected
 * @param {string[]} heard
 * @returns {{matches:number, similarity:number}} similarity = matches / max(len(expected), len(heard))
 */
function alignWords(expected, heard) {
  const m = expected.length;
  const n = heard.length;
  if (!m || !n) return { matches: 0, similarity: 0 };
  let prev = new Array(n + 1).fill(0);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= n; j += 1) {
      cur[j] = wordsMatch(expected[i - 1], heard[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const matches = prev[n];
  return { matches, similarity: matches / Math.max(m, n) };
}

/**
 * Do the code digits appear in order, within a window of CODE_WINDOW words?
 * @param {string[]} words normalized words
 * @param {string} code 4 digits
 */
function codeHeard(words, code) {
  const digits = String(code).replace(/\D/g, '').split('');
  if (!digits.length) return false;
  for (let start = 0; start < words.length; start += 1) {
    if (words[start] !== digits[0]) continue;
    let k = 1;
    let j = start + 1;
    for (; j < words.length && k < digits.length && j - start < CODE_WINDOW; j += 1) {
      if (words[j] === digits[k]) k += 1;
    }
    if (k === digits.length) return true;
  }
  return false;
}

/**
 * The name, checked loosely: some heard word within ½ of its length in edits for each name part
 * of 3+ letters (the first name is enough).
 * @param {string[]} heard
 * @param {string} name
 * @returns {boolean}
 */
function nameWasHeard(heard, name) {
  const parts = normalizeWords(name).filter((w) => w.length >= 2);
  if (!parts.length) return false;
  const close = (part) => heard.some((w) => w === part || (part.length >= 3 && editDistance(part, w) <= Math.floor(part.length / 2)));
  return close(parts[0]) || parts.slice(1).some(close);
}

/**
 * Check a transcript of the consent take.
 * @param {{expected:string, transcript:string, code:string, name?:string}} args
 * @returns {{ok:boolean, similarity:number, nameHeard:boolean, codeHeard:boolean, reasons:string[]}}
 *   reasons: 'empty' | 'code' | 'agree' | 'voice' | 'wording'
 */
function checkConsent({ expected, transcript, code, name } = {}) {
  const exp = normalizeWords(expected);
  const heard = normalizeWords(transcript);
  const reasons = [];
  if (!heard.length) {
    return { ok: false, similarity: 0, nameHeard: false, codeHeard: false, reasons: ['empty'] };
  }
  const hasCode = codeHeard(heard, code);
  if (!hasCode) reasons.push('code');
  if (!heard.some((w) => /^(agree|consent)/.test(w))) reasons.push('agree');
  if (!heard.includes('voice')) reasons.push('voice');
  const { similarity } = alignWords(exp, heard);
  if (similarity < MIN_SIMILARITY) reasons.push('wording');
  return {
    ok: reasons.length === 0,
    similarity: Math.round(similarity * 1000) / 1000,
    nameHeard: nameWasHeard(heard, name || ''),
    codeHeard: hasCode,
    reasons,
  };
}

const REASON_TEXT = {
  empty: 'Nothing was heard. Check the microphone and read the sentence aloud.',
  code: 'The code was not heard. Read the four digits shown on screen, one by one.',
  agree: 'The words "agree that" were not heard. Read the sentence exactly as shown.',
  voice: 'The words "copy of my voice" were not heard. Read the sentence exactly as shown.',
  wording: 'The wording did not match. Read the sentence exactly as shown, at a normal pace.',
  expired: 'The code expired. A new code is shown: read the sentence again.',
  used: 'This code was already used. Start a new enrollment.',
};

/** A user-facing explanation for checkConsent() reasons. */
function reasonText(reasons) {
  return (reasons || []).map((r) => REASON_TEXT[r] || r);
}

/**
 * A fresh consent: the sentence with the owner's name and a new 4-digit code.
 * @param {{ownerName:string, now?:number, ttlMs?:number, randomInt?:(min:number,max:number)=>number}} args
 * @returns {{text:string, code:string, expiresAt:number}}
 */
function newConsent({ ownerName, now = Date.now(), ttlMs = CODE_TTL_MS, randomInt = crypto.randomInt } = {}) {
  const name = cleanName(ownerName);
  if (!name) {
    const e = new Error('The owner name is missing');
    e.code = 'OWNER_NAME';
    throw e;
  }
  const code = String(randomInt(0, 10000)).padStart(4, '0');
  return { text: consentSentence(name, code), code, expiresAt: now + ttlMs };
}

/** sha256 of the code salted with the session id (what the manifest keeps instead of the code). */
function codeHash(sessionId, code) {
  return crypto.createHash('sha256').update(`${sessionId}:${code}`).digest('hex');
}

/**
 * The consent state of one enrollment session: a code that expires after 10 minutes, can be read
 * up to MAX_ATTEMPTS times before a fresh one is issued, and is consumed by the first passing take.
 */
class ConsentTracker {
  /**
   * @param {{ownerName:string, clock?:()=>number, ttlMs?:number, randomInt?:Function, maxAttempts?:number}} opts
   */
  constructor({ ownerName, clock = Date.now, ttlMs = CODE_TTL_MS, randomInt = crypto.randomInt, maxAttempts = MAX_ATTEMPTS } = {}) {
    this.ownerName = cleanName(ownerName);
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.randomInt = randomInt;
    this.maxAttempts = maxAttempts;
    this.passed = null; // the accepted check result
    this.renew();
  }

  /** Issue a fresh code (not after the consent passed). */
  renew() {
    if (this.passed) {
      const e = new Error(REASON_TEXT.used);
      e.code = 'CONSENT_USED';
      throw e;
    }
    this.current = newConsent({ ownerName: this.ownerName, now: this.clock(), ttlMs: this.ttlMs, randomInt: this.randomInt });
    this.attempts = 0;
    return this.public();
  }

  get expired() {
    return this.clock() >= this.current.expiresAt;
  }

  /** What the UI shows: the sentence and when its code expires. */
  public() {
    return { text: this.current.text, expiresAt: this.current.expiresAt, passed: Boolean(this.passed) };
  }

  /**
   * Check a transcript against the current code. An expired code is refused (and renewed);
   * a passing take consumes the code.
   * @param {string} transcript
   * @returns {{ok:boolean, similarity:number, nameHeard:boolean, reasons:string[], renewed?:object}}
   */
  check(transcript) {
    if (this.passed) return { ok: false, similarity: 0, nameHeard: false, codeHeard: false, reasons: ['used'] };
    if (this.expired) {
      const renewed = this.renew();
      return { ok: false, similarity: 0, nameHeard: false, codeHeard: false, reasons: ['expired'], renewed };
    }
    const r = checkConsent({ expected: this.current.text, transcript, code: this.current.code, name: this.ownerName });
    this.attempts += 1;
    if (r.ok) {
      this.passed = { ...r, text: this.current.text, code: this.current.code, transcript: String(transcript || ''), at: this.clock() };
      return r;
    }
    if (this.attempts >= this.maxAttempts) return { ...r, renewed: this.renew() };
    return r;
  }
}

module.exports = {
  CODE_TTL_MS,
  MIN_SIMILARITY,
  MAX_ATTEMPTS,
  normalizeWords,
  editDistance,
  wordsMatch,
  alignWords,
  codeHeard,
  nameWasHeard,
  checkConsent,
  reasonText,
  newConsent,
  codeHash,
  ConsentTracker,
};
