'use strict';

/**
 * The greeting of an AI-answered call (docs/CALLS-DESIGN.md §7.1, safeguard (b) in §1.3).
 *
 *   composeGreeting({callerName, ownerName, ownerFirst, pronoun, cloned, template, lang})
 *     -> {text, disclosure, disclosureStart, disclosureEnd, salutation, rest, cloned, templateUsed, templateRejected?}
 *
 * The disclosure ("this is Deepanshu's AI assistant[, speaking in his voice]. I'm transcribing this call to
 * take notes for him.") is ALWAYS generated here and ALWAYS part of the text. calls.greeting is a user
 * template that may use {caller}, {owner}, {rest} and {disclosure}; without {disclosure} the disclosure is
 * prepended. A template can never remove the disclosure, and a template that contradicts it ("I'm not an
 * AI", "this is Deepanshu himself", "this call isn't recorded") is ignored in favour of the default.
 * When the cloned voice is not used, the disclosure drops "speaking in his voice".
 *
 * disclosureStart/disclosureEnd are character offsets in `text`: CallSession treats the disclosure as
 * spoken only when playback reached disclosureEnd (a barge-in before that repeats it).
 */

const script = require('../voice/clone/script');

const OBJECT_PRONOUN = Object.freeze({ his: 'him', her: 'her', their: 'them' });
const DEFAULT_REST = 'How can I help?';
const TEMPLATE_MAX = 300;
const TEXT_MAX = 600;
const KNOWN_PLACEHOLDERS = ['caller', 'owner', 'rest', 'disclosure'];

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
  const rest = oneLine(opts.rest).slice(0, 200) || DEFAULT_REST;
  const build = (text, start) => {
    const end = start + parts.disclosure.length;
    return { text, disclosure: text.slice(start, end), disclosureStart: start, disclosureEnd: end, salutation: parts.salutation, rest, cloned: parts.cloned };
  };
  const fallback = (rejected) => {
    const head = `${parts.salutation} `;
    const text = `${head}${parts.disclosure} ${rest}`;
    const out = { ...build(text, head.length), templateUsed: false };
    if (rejected) out.templateRejected = rejected;
    return out;
  };

  const template = oneLine(opts.template);
  if (!template) return fallback(null);
  if (template.length > TEMPLATE_MAX) return fallback(`it is longer than ${TEMPLATE_MAX} characters`);
  const values = { caller: parts.callerFirst || 'there', owner: parts.ownerFirst || 'the owner', rest };
  const { out, usedDisclosure, disclosureAt } = expandTemplate(template, values);
  const withoutDisclosure = out.replace('\u0000', ' ');
  const problem = templateProblem(withoutDisclosure, parts.ownerFirst);
  if (problem) return fallback(problem);

  let text;
  let start;
  if (usedDisclosure) {
    const before = oneLine(out.slice(0, disclosureAt));
    const after = oneLine(out.slice(disclosureAt + 1));
    // At the start of a sentence the disclosure starts with a capital ("Hello! This is …").
    const sentenceStart = !before || /[.!?]$/.test(before);
    const disclosure = sentenceStart ? capitalizeFirst(parts.disclosure) : parts.disclosure;
    const head = before ? `${before} ` : '';
    text = `${head}${disclosure}${after ? ` ${after}` : ''}`;
    start = head.length;
  } else {
    // Prepended: drop the template's own salutation so the caller is not greeted twice.
    const body = oneLine(withoutDisclosure.replace(/^(?:hi|hello|hey|hiya|good\s+(?:morning|afternoon|evening))\b[^,.!?]{0,40}[,.!]\s*/i, ''));
    const head = `${parts.salutation} `;
    text = `${head}${parts.disclosure}${body ? ` ${body}` : ''}`;
    start = head.length;
  }
  if (text.length > TEXT_MAX) return fallback(`the greeting would be longer than ${TEXT_MAX} characters`);
  const res = build(text, start);
  // Defense in depth: the disclosure must be in the text, verbatim (case aside).
  if (res.disclosure.toLowerCase() !== parts.disclosure.toLowerCase() || !text.toLowerCase().includes(parts.disclosure.toLowerCase())) return fallback('the disclosure would be missing');
  return { ...res, templateUsed: true };
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

module.exports = { composeGreeting, greetingParts, redisclosure, transcriptStoppedText, hasDisclosure, templateProblem, DEFAULT_REST, TEMPLATE_MAX, CONTRADICTIONS };
