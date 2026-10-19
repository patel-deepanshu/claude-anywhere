'use strict';

/**
 * What the user reads during voice enrollment (docs/CALLS-DESIGN.md §2.2), plus the fixed sentences
 * that are rendered in the cloned voice (the test sentence and the call fillers of §2.6).
 *
 * The 14 lines were checked with `espeak-ng -v en-us -x`: together they cover all 39 General
 * American phonemes (including /ʒ/, /ɔɪ/ and /aʊ/) and add call-style prosody (questions, numbers,
 * apologies, sign-offs). 171 words, about 70 s of speech. English only for now: the sherpa INT8
 * export of Pocket TTS used here is English.
 */

const LINES = Object.freeze([
  'Hi, thanks for calling. Give me one second while I pull that up.',
  'The quick brown fox jumps over the lazy dog beside the riverbank.',
  'Could you share the ticket number? Was it four, five, or nine?',
  'We shipped the payments fix on Thursday, and the dashboard looks much healthier.',
  'Judge Vivian measured the beige garage with a zigzag ruler.',
  'Our new office is three floors up, just past the yellow elevator.',
  "I'd rather wait until the build is green before we merge anything.",
  'Choose the cheaper ship; the sheep can wait on the shore.',
  "Thank you so much! That's exactly what I was hoping to hear.",
  'Honestly, I think the thirty-third version is worth a quick look.',
  'Jackdaws love my big sphinx of quartz, said the boy with the toy.',
  "The meeting moved to half past two, so let's sync right after lunch.",
  "Hmm, that's odd. Let me check the logs and get back to you.",
  "Great, I'll send you the link on chat as soon as we hang up.",
]);

/** Short phrases pre-rendered in the cloned voice and played from cache during calls (§2.6, §6.4). */
const FILLERS = Object.freeze([
  'Sure.',
  'Okay, one moment.',
  'Let me check that.',
  'Got it.',
  'Sorry, could you say that again?',
  'Thanks for calling. Bye!',
]);

const PRONOUNS = Object.freeze(['his', 'her', 'their']);
const NAME_MAX = 60;

/**
 * A display name made safe for a spoken sentence: letters (any script), spaces, apostrophes,
 * hyphens and dots; collapsed whitespace; at most 60 characters. '' when nothing usable is left.
 * @param {*} name
 * @returns {string}
 */
function cleanName(name) {
  if (typeof name !== 'string') return '';
  const s = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}' .\-’]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, NAME_MAX).trim();
}

/** The first word of a name ("Deepanshu Patel" → "Deepanshu"). */
function firstName(name) {
  const s = cleanName(name);
  return s ? s.split(' ')[0] : '';
}

/**
 * The 4-digit code as it is shown and read: "4 7 2 9".
 * @param {string|number} code
 * @returns {string}
 */
function spacedCode(code) {
  return String(code).replace(/\D/g, '').split('').join(' ');
}

/**
 * The consent sentence, recorded first (§2.2):
 * "I, {full name}, agree that Claude Anywhere may create a copy of my voice on this computer. My code is {d d d d}."
 * @param {string} name the owner's full name
 * @param {string|number} code 4 digits
 * @returns {string}
 */
function consentSentence(name, code) {
  const who = cleanName(name);
  if (!who) throw new Error('consentSentence: a name is required');
  const digits = String(code).replace(/\D/g, '');
  if (digits.length !== 4) throw new Error('consentSentence: the code must have 4 digits');
  return `I, ${who}, agree that Claude Anywhere may create a copy of my voice on this computer. My code is ${spacedCode(digits)}.`;
}

/** 'his' | 'her' | 'their' (anything else → 'their'). */
function pronounOf(p) {
  const v = String(p || '').toLowerCase();
  return PRONOUNS.includes(v) ? v : 'their';
}

/**
 * The enrollment test sentence (§2.1 step 7): "Hi, this is Deepanshu's AI assistant, speaking in his voice."
 * @param {{ownerName?:string, pronoun?:string}} [opts]
 * @returns {string}
 */
function testSentence({ ownerName, pronoun } = {}) {
  const first = firstName(ownerName);
  const who = first ? `${first}'s` : 'your';
  return `Hi, this is ${who} AI assistant, speaking in ${pronounOf(pronoun)} voice.`;
}

module.exports = { LINES, FILLERS, PRONOUNS, cleanName, firstName, spacedCode, consentSentence, pronounOf, testSentence };
