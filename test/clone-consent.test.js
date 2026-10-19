'use strict';

/**
 * Consent verification for voice enrollment (src/voice/clone/consent.js and script.js,
 * docs/CALLS-DESIGN.md §2.2, §2.5): the 8 real local-STT transcripts captured in the research
 * (Appendix A.3), number words, the code's order and window, expiry and single use.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const consent = require('../src/voice/clone/consent');
const script = require('../src/voice/clone/script');

const EXPECTED = 'I, Deepanshu Patel, agree that Claude Anywhere may create a copy of my voice on this computer. My code is 4 7 2 9.';

// Appendix A.3: the sentence synthesized with Piper and transcribed by Moonshine and Parakeet.
const A3 = {
  exact: {
    moonshine: 'I, Dipancio Patel, agree that Claude anywhere may create a copy of my voice on this computer. My code is 4729.',
    parakeet: 'I, Dipanchu Patel, agree that Claude Anywhere may create a copy of my voice on this computer. My code is 4729.',
  },
  paraphrase: {
    moonshine: 'I am Dipanchu and I agree to Claude anywhere copying my voice on this computer code 4729',
    parakeet: 'I am Dipanchu and I agree to claw it anywhere copying my voice on this computer. Code 4729',
  },
  wrong_code: {
    moonshine: 'I, Dipancho Patel, agree that Claude Anywhere may create a copy of my voice on this computer. My code is 4719.',
    parakeet: 'I, Gipanchu Patel, agree that Claude Anywhere may create a copy of my voice on this computer. My code is 4719.',
  },
  no_consent: {
    moonshine: 'The quick brown fox jumps over the lazy dog while the code 4729 is red allowed.',
    parakeet: 'The quick brown fox jumps over the lazy dog while the code 4729 is read aloud.',
  },
};

function check(transcript, code = '4729') {
  return consent.checkConsent({ expected: EXPECTED, transcript, code, name: 'Deepanshu Patel' });
}

test('the consent sentence has the name and the spaced code (§2.2)', () => {
  assert.equal(script.consentSentence('Deepanshu Patel', '4729'), EXPECTED);
  assert.equal(script.consentSentence('  Ana   María <b>López</b> ', '0007'), 'I, Ana María b López b, agree that Claude Anywhere may create a copy of my voice on this computer. My code is 0 0 0 7.');
  assert.equal(script.consentSentence('Ana María López', '0007'), 'I, Ana María López, agree that Claude Anywhere may create a copy of my voice on this computer. My code is 0 0 0 7.');
  assert.throws(() => script.consentSentence('', '1234'), /name is required/);
  assert.throws(() => script.consentSentence('Ana', '123'), /4 digits/);
  assert.equal(script.cleanName('  Ana <script>alert(1)</script>  López '), 'Ana script alert script López');
  assert.equal(script.firstName("Siobhán O'Neil"), 'Siobhán');
  assert.equal(script.testSentence({ ownerName: 'Deepanshu Patel', pronoun: 'his' }), "Hi, this is Deepanshu's AI assistant, speaking in his voice.");
  assert.equal(script.testSentence({ ownerName: 'Priya', pronoun: 'nonsense' }), "Hi, this is Priya's AI assistant, speaking in their voice.");
});

test('the script: 14 lines, 171 words; the fillers of §2.6', () => {
  assert.equal(script.LINES.length, 14);
  assert.equal(script.LINES.join(' ').split(/\s+/).length, 171);
  assert.ok(Object.isFrozen(script.LINES));
  assert.ok(script.LINES[4].includes('beige garage'), 'the /ʒ/ line');
  assert.deepEqual(script.FILLERS, ['Sure.', 'Okay, one moment.', 'Let me check that.', 'Got it.', 'Sorry, could you say that again?', 'Thanks for calling. Bye!']);
});

test('Appendix A.3: the exact reading passes with both STT models', () => {
  for (const [model, text] of Object.entries(A3.exact)) {
    const r = check(text);
    assert.equal(r.ok, true, `${model}: ${JSON.stringify(r)}`);
    assert.ok(r.similarity >= 0.95, `${model} similarity ${r.similarity}`);
    assert.equal(r.codeHeard, true);
    assert.equal(r.nameHeard, true, `${model}: "Dipancio/Dipanchu Patel" counts as the name`);
  }
});

test('Appendix A.3: paraphrase, wrong code and no consent all fail for the right reasons', () => {
  for (const [model, text] of Object.entries(A3.paraphrase)) {
    const r = check(text);
    assert.equal(r.ok, false, model);
    assert.deepEqual(r.reasons, ['wording'], model);
    assert.ok(r.similarity < 0.8);
  }
  for (const [model, text] of Object.entries(A3.wrong_code)) {
    const r = check(text);
    assert.equal(r.ok, false, model);
    assert.deepEqual(r.reasons, ['code'], model);
    assert.equal(r.codeHeard, false);
  }
  for (const [model, text] of Object.entries(A3.no_consent)) {
    const r = check(text);
    assert.equal(r.ok, false, model);
    assert.deepEqual(r.reasons, ['agree', 'voice', 'wording'], model);
  }
  assert.deepEqual(check('').reasons, ['empty']);
});

test('number words and homophones map to digits; digits are split; accents and punctuation go', () => {
  assert.deepEqual(consent.normalizeWords('My code is 4729.'), ['my', 'code', 'is', '4', '7', '2', '9']);
  assert.deepEqual(consent.normalizeWords('four, seven; TWO... nine!'), ['4', '7', '2', '9']);
  assert.deepEqual(consent.normalizeWords('for seven to nine'), ['4', '7', '2', '9']);
  assert.deepEqual(consent.normalizeWords('oh won ate'), ['0', '1', '8']);
  assert.deepEqual(consent.normalizeWords('Dépanshu’s café'), ['depanshus', 'cafe']);
  for (const reading of ['four seven two nine', 'for seven to nine', '47 29', '4, 7, 2, 9', 'four seven, uh, two nine']) {
    const r = check(`I, Deepanshu Patel, agree that Claude Anywhere may create a copy of my voice on this computer. My code is ${reading}.`);
    assert.equal(r.ok, true, `${reading}: ${JSON.stringify(r)}`);
  }
});

test('the code must be in order and close together', () => {
  const w = (s) => consent.normalizeWords(s);
  assert.equal(consent.codeHeard(w('code 4 7 2 9'), '4729'), true);
  assert.equal(consent.codeHeard(w('code 9 2 7 4'), '4729'), false);
  assert.equal(consent.codeHeard(w('4 apples and 7 pears, then a very long story about 2 dogs and 9 cats'), '4729'), false);
  assert.equal(consent.codeHeard(w('4 7 1 9'), '4729'), false);
  assert.equal(consent.codeHeard(w('0 0 0 7'), '0007'), true);
});

test('fuzzy words: 4+ letters within ⌊len/3⌋ edits; short words and digits exact', () => {
  assert.equal(consent.wordsMatch('deepanshu', 'dipanchu'), true);
  assert.equal(consent.wordsMatch('anywhere', 'anywher'), true);
  assert.equal(consent.wordsMatch('copy', 'copying'), false);
  assert.equal(consent.wordsMatch('may', 'way'), false);
  assert.equal(consent.wordsMatch('4', '1'), false);
  assert.equal(consent.editDistance('kitten', 'sitting'), 3);
  assert.deepEqual(consent.alignWords(['a', 'b', 'c'], ['a', 'x', 'c']), { matches: 2, similarity: 2 / 3 });
  assert.deepEqual(consent.alignWords([], ['a']), { matches: 0, similarity: 0 });
  // Reading the sentence buried in a long ramble lowers the score: extra words count against it.
  const ramble = `${'so anyway '.repeat(10)}${A3.exact.parakeet}`;
  assert.equal(check(ramble).ok, false);
});

test('newConsent: a fresh zero-padded 4-digit code, valid for 10 minutes', () => {
  const c = consent.newConsent({ ownerName: 'Deepanshu Patel', now: 1000, randomInt: () => 7 });
  assert.equal(c.code, '0007');
  assert.equal(c.expiresAt, 1000 + 10 * 60 * 1000);
  assert.ok(c.text.endsWith('My code is 0 0 0 7.'));
  const real = consent.newConsent({ ownerName: 'X Y' });
  assert.match(real.code, /^\d{4}$/);
  assert.throws(() => consent.newConsent({ ownerName: '  ' }), (e) => e.code === 'OWNER_NAME');
  assert.equal(consent.codeHash('s1', '4729'), consent.codeHash('s1', '4729'));
  assert.notEqual(consent.codeHash('s1', '4729'), consent.codeHash('s2', '4729'));
  assert.ok(!consent.codeHash('s1', '4729').includes('4729'));
});

test('ConsentTracker: expiry issues a new code; the code is single-use', () => {
  let now = 0;
  const codes = [4729, 1111, 2222, 3333];
  const t = new consent.ConsentTracker({ ownerName: 'Deepanshu Patel', clock: () => now, randomInt: () => codes.shift() });
  assert.ok(t.public().text.endsWith('My code is 4 7 2 9.'));
  now = 10 * 60 * 1000; // exactly at expiry
  const expired = t.check(A3.exact.moonshine);
  assert.equal(expired.ok, false);
  assert.deepEqual(expired.reasons, ['expired']);
  assert.ok(expired.renewed.text.endsWith('My code is 1 1 1 1.'));
  // The old code no longer works; the new one does.
  assert.equal(t.check(A3.exact.moonshine).reasons.includes('code'), true);
  const ok = t.check(A3.exact.moonshine.replace('4729', '1111'));
  assert.equal(ok.ok, true);
  assert.equal(t.passed.code, '1111');
  // Single use: a second reading (even a correct one) is refused, and no new code is issued.
  const again = t.check(A3.exact.moonshine.replace('4729', '1111'));
  assert.equal(again.ok, false);
  assert.deepEqual(again.reasons, ['used']);
  assert.throws(() => t.renew(), (e) => e.code === 'CONSENT_USED');
  assert.equal(t.public().passed, true);
});

test('ConsentTracker: three failed readings of one code bring a fresh code', () => {
  const codes = [4729, 5555];
  const t = new consent.ConsentTracker({ ownerName: 'Deepanshu Patel', randomInt: () => codes.shift() });
  assert.equal(t.check(A3.paraphrase.moonshine).renewed, undefined);
  assert.equal(t.check(A3.wrong_code.moonshine).renewed, undefined);
  const third = t.check(A3.no_consent.moonshine);
  assert.equal(third.ok, false);
  assert.ok(third.renewed && third.renewed.text.endsWith('My code is 5 5 5 5.'));
  assert.equal(t.attempts, 0);
  assert.deepEqual(consent.reasonText(['code', 'expired']).length, 2);
});
