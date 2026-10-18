'use strict';

/**
 * The greeting of an AI-answered call (docs/CALLS-DESIGN.md §7.1, safeguard (b) in §1.3).
 *
 *   composeGreeting({callerName, ownerName, ownerFirst, pronoun, cloned, template, lang})
 *     -> {text, disclosure, disclosureStart, disclosureEnd, salutation, rest, cloned, templateUsed, templateRejected?}
 *
 * The disclosure ("this is Deepanshu's AI assistant[, speaking in his voice]. I'm transcribing this call to
 * take notes for him.") is ALWAYS generated here and ALWAYS part of the text, and so is the salutation
 * before it: the greeting is always "<salutation> <disclosure> <closing question>". calls.greeting sets only
 * the closing question (F3-SAFE-B2: free text around the disclosure could take it back, as in "Just
 * kidding, you have Deepanshu live"): one question of at most 80 characters that does not name the owner
 * and has none of the words that could contradict the disclosure (not, real, human, person, live, kidding,
 * ignore, AI, recorded …). Anything else is ignored in favour of the default "How can I help?".
 * When the cloned voice is not used, the disclosure drops "speaking in his voice".
 *
 * disclosureStart/disclosureEnd are character offsets in `text`: CallSession treats the disclosure as
 * spoken only when playback reached disclosureEnd (a barge-in before that repeats it).
 */

const script = require('../voice/clone/script');

const OBJECT_PRONOUN = Object.freeze({ his: 'him', her: 'her', their: 'them' });
const DEFAULT_REST = 'How can I help?';
const TEMPLATE_MAX = 80;
const TEXT_MAX = 600;
const KNOWN_PLACEHOLDERS = ['caller', 'owner', 'rest', 'disclosure'];

/**
 * Words a closing question may not contain (F3-SAFE-B2): anything that could take the disclosure back,
 * claim a person is speaking, or talk about the AI, the recording or the instructions.
 */
const REST_BLOCKLIST = [
  /\b(?:kidding|joke|jokes|joking|jk|prank\w*|gotcha|lol|haha\w*)\b/i,
  /\b(?:real|really|actual|actually|truly|genuine\w*|honest\w*|seriously)\b/i,
  /\b(?:himself|herself|themselves|themself|myself|yourself|in\s+person|live|human\w*|person\w*|people|man|woman|guy|girl|boy|lady)\b/i,
  /\b(?:not|no|never|nobody|none|nothing|neither|nor|without|isn|aren|wasn|weren|don|doesn|didn|won|can['’]?t|cannot)\b|n['’]t\b/i,
  /\b(?:ignore|disregard|forget|skip|omit|remove|drop|instead|pretend\w*|fake\w*|impersonat\w*|lie|lying|trick\w*)\b/i,
  /\b(?:ai|a\.i\.?|bot|bots|robot\w*|machine\w*|automat\w*|assistant\w*|computer\w*|synthetic|voice\w*|clone\w*|deepfake\w*)\b/i,
  /\b(?:record\w*|transcri\w*|notes?|note-taking|disclos\w*|notice|instruction\w*|message|said|earlier|above|before)\b/i,
  /\b(?:owner|boss|me|i['’]m|i\s+am|this\s+is|it['’]s|here|speaking|himself|him|her|his|hers|he|she|they|them)\b/i,
];

/** Phrases that would contradict the disclosure: a template containing one is not used. */
const CONTRADICTIONS = Object.freeze([
  // "not an AI", "I'm not a bot", "this isn't recorded", "no notes", "won't be transcribed"
  /\b(?:not|n['’]t|never|no|nobody|without)\b[^.!?]{0,30}\b(?:ai|a\.i\.|bot|robot|machine|assistant|automated|computer|recorded|recording|record|transcrib\w*|transcript\w*|notes?|note-taking)\b/i,
  // "I am a real person", "this is a human"
  /\b(?:i\s+am|i['’]m|this\s+is|it['’]s|you['’]re\s+(?:talking|speaking)\s+(?:to|with))\s+(?:really\s+|actually\s+|truly\s+)?(?:a\s+|the\s+)?(?:real\s+)?(?:human|person|people|live\s+person)\b/i,
  // instructions aimed at the reader instead of a greeting
  /\b(?:ignore|skip|omit|remove|drop|disregard)\b[^.!?]{0,40}\b(?:disclos\w*|instruction\w*|notice|ai|assistant)\b/i,
]);

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function oneLine(s) {
  return str(s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u2060\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The parts every greeting is built from. */
function greetingParts({ callerName, ownerName, ownerFirst, pronoun, cloned } = {}) {
  const callerFirst = script.firstName(script.cleanName(str(callerName)));
  const ownerFull = script.cleanName(str(ownerName));
  const first = script.cleanName(str(ownerFirst)).split(' ')[0] || script.firstName(ownerFull);
  const p = script.pronounOf(pronoun);
  const obj = OBJECT_PRONOUN[p];
  const who = first ? `${first}'s AI assistant` : 'an AI assistant answering this call';
  const voiceClause = cloned ? `, speaking in ${first ? p : "the owner's"} voice` : '';
  const notice = `I'm transcribing this call to take notes for ${first ? obj : 'the owner'}.`;
  const disclosure = `this is ${who}${voiceClause}. ${notice}`;
  return {
    callerFirst,
    ownerFirst: first,
    pronoun: p,
    pronounObj: obj,
    disclosure,
    salutation: callerFirst ? `Hi ${callerFirst},` : 'Hi,',
    cloned: Boolean(cloned),
  };
}

/**
 * Why a user template cannot be used (null when it can).
 * @param {string} expanded the template with its placeholders filled, the disclosure removed
 * @param {string} ownerFirst
 */
function templateProblem(expanded, ownerFirst) {
  for (const re of CONTRADICTIONS) if (re.test(expanded)) return 'it contradicts the AI disclosure';
  if (ownerFirst) {
    // "Hi, this is Deepanshu" / "It's Deepanshu here" pretends to be the owner (but "Deepanshu's" is fine).
    const re = new RegExp(`\\b(?:i\\s+am|i['’]m|this\\s+is|it['’]s|here\\s+is)\\s+(?:really\\s+|actually\\s+)?${escapeRegExp(ownerFirst)}\\b(?!['’]s)`, 'i');
    const here = new RegExp(`\\b${escapeRegExp(ownerFirst)}\\s+(?:here|speaking|on\\s+the\\s+(?:line|phone))\\b`, 'i');
    if (re.test(expanded) || here.test(expanded)) return `it says the speaker is ${ownerFirst}`;
  }
  return null;
}

function foldName(s) {
  return str(s)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/**
 * Why a closing question cannot be used as calls.greeting (null when it can). The greeting is always
 * "<salutation> <disclosure> <closing question>"; the setting replaces only the question.
 * @param {string} text the setting
 * @param {{ownerName?:string, ownerFirst?:string}} [owner]
 * @returns {string|null}
 */
function greetingSettingProblem(text, { ownerName, ownerFirst } = {}) {
  const t = oneLine(text);
  if (!t) return null;
  if (t.length > TEMPLATE_MAX) return `it is longer than ${TEMPLATE_MAX} characters (it is only the closing question, such as "${DEFAULT_REST}")`;
  if (/[{}<>[\]\\|@#*_~`^=+$%&]|https?:|www\./i.test(t)) return 'it may only be the closing question: no placeholders, links or symbols (the start of the greeting and the AI disclosure are always composed by Claude Anywhere)';
  if (!/^[^.!?;:]+\?$/.test(t)) return 'it must be one short question that ends with "?"';
  const words = foldName(t);
  const names = [...new Set([ownerName, ownerFirst].flatMap((n) => foldName(script.cleanName(str(n))).split(/\s+/)).filter((w) => w.length >= 2))];
  for (const n of names) if (new RegExp(`\\b${escapeRegExp(n)}\\b`, 'i').test(words)) return 'it may not name you (the disclosure already says whose assistant is speaking)';
  for (const re of REST_BLOCKLIST) {
    const m = re.exec(t);
    if (m) return `it may not say "${m[0].trim()}" (a closing question cannot talk about who is speaking, the AI or the recording)`;
  }
  return null;
}

/**
 * Fill a template in one pass (a value is never expanded again). {disclosure} is replaced only once;
 * unknown placeholders and stray braces are removed.
 */
function expandTemplate(template, values) {
  let usedDisclosure = false;
  let disclosureAt = -1;
  let out = '';
  let last = 0;
  const re = /\{\s*([a-zA-Z_]+)\s*\}/g;
  let m;
  while ((m = re.exec(template))) {
    out += template.slice(last, m.index);
    last = re.lastIndex;
    const key = m[1].toLowerCase();
    if (key === 'disclosure') {
      if (!usedDisclosure) {
        usedDisclosure = true;
        disclosureAt = out.length;
        out += '\u0000';
      }
      continue;
    }
    if (KNOWN_PLACEHOLDERS.includes(key)) out += values[key];
  }
  out += template.slice(last);
  out = out.replace(/[{}]/g, '');
  return { out, usedDisclosure, disclosureAt };
}

/**
 * Compose the greeting.
 * @param {{callerName?:string, ownerName?:string, ownerFirst?:string, pronoun?:'his'|'her'|'their',
 *   cloned?:boolean, template?:string, lang?:string, rest?:string}} [opts]
 *   cloned: the cloned voice will speak it (else the disclosure drops "speaking in his voice")
 * @returns {{text:string, disclosure:string, disclosureStart:number, disclosureEnd:number, salutation:string,
 *   rest:string, cloned:boolean, templateUsed:boolean, templateRejected?:string}}
 */
function composeGreeting(opts = {}) {
  const parts = greetingParts(opts);
  const codeRest = oneLine(opts.rest);
  const compose = (rest, used, rejected) => {
    const head = `${parts.salutation} `;
    const text = `${head}${parts.disclosure} ${rest}`;
    const start = head.length;
    const end = start + parts.disclosure.length;
    const out = { text, disclosure: text.slice(start, end), disclosureStart: start, disclosureEnd: end, salutation: parts.salutation, rest, cloned: parts.cloned, templateUsed: used };
    if (rejected) out.templateRejected = rejected;
    return out;
  };
  const fallbackRest = codeRest && !greetingSettingProblem(codeRest, opts) ? codeRest : DEFAULT_REST;
  // F3-SAFE-B2: the setting is only the closing question; the salutation and the disclosure are code's.
  const template = oneLine(opts.template);
  if (!template) return compose(fallbackRest, false, null);
  const problem = greetingSettingProblem(template, { ownerName: opts.ownerName, ownerFirst: parts.ownerFirst });
  if (problem) return compose(fallbackRest, false, problem);
  const res = compose(template, true, null);
  if (res.text.length > TEXT_MAX || !hasDisclosure(res.text)) return compose(fallbackRest, false, 'the disclosure would be missing');
  return res;
}

/**
 * Said before the assistant's next words when a barge-in cut the greeting before the disclosure was
 * heard in full.
 * @returns {string}
 */
function redisclosure(opts = {}) {
  const parts = greetingParts(opts);
  return `Sorry, just so you know: ${capitalizeFirst(parts.disclosure)}`;
}

/** Said when the caller objects to the transcription (the session then stops saving it). */
function transcriptStoppedText() {
  return "Okay, I've stopped the transcript. I'll only keep a note of what I do for you.";
}

/** Whether a text carries the AI disclosure and the transcription notice (tests, doctor). */
function hasDisclosure(text) {
  const t = str(text);
  return /\bAI assistant\b/i.test(t) && /\btranscribing this call\b/i.test(t);
}

module.exports = { composeGreeting, greetingParts, greetingSettingProblem, redisclosure, transcriptStoppedText, hasDisclosure, templateProblem, expandTemplate, DEFAULT_REST, TEMPLATE_MAX, CONTRADICTIONS, REST_BLOCKLIST };
