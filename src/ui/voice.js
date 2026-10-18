/**
 * Voice input and output for the dialog.
 *
 * Input providers:
 *   browser  Web Speech API (SpeechRecognition) with interim results.
 *   server   WavRecorder (16 kHz WAV, VAD auto-stop) → POST /api/stt.
 * `auto` uses the browser unless this is Electron (no Google speech keys) or
 * the API is missing, and falls back to the server on network/not-allowed/
 * service-not-allowed errors when the daemon has a transcription provider.
 *
 * Modes: 'toggle' (click), 'ptt' (hold to talk) and 'handsfree' (continuous,
 * gated by a wake word: only the words after it are sent, and the wake word
 * alone arms the next utterance).
 *
 * Output: speechSynthesis (sentence-chunked, Chrome stops utterances after
 * ~15 s) or POST /api/tts. cancelSpeech() also POSTs /api/tts/stop.
 */

import { WavRecorder } from './wav-recorder.js';

// Browser recognition errors after which server transcription is tried instead. The contract
// lists the first three; audio-capture and language-not-supported are also recoverable there
// (getUserMedia may still work, and Whisper covers more languages).
const FALLBACK_ERRORS = new Set(['network', 'not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);
const ARM_MS = 8000;
const SPEECH_MAX = 600;
// After Claude stops talking, how long recognition results may still hold its words.
const ECHO_TAIL_MS = 700;
// Whisper's usual output for silence; dropped when the recorder heard no speech.
const SILENCE_HALLUCINATIONS = new Set(['thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'you', 'bye', 'bye bye']);

export const ELECTRON_VOICE_HELP =
  'The Electron window has no browser speech recognition, so it needs server transcription: set GROQ_API_KEY or ' +
  'OPENAI_API_KEY before starting Claude Anywhere (or add a key in Settings › Voice), or install whisper.cpp. ' +
  'Or use the Chrome/Edge app window, which has browser speech (anywhere config set ui.host app, then anywhere restart).';

export const VOICE_HELP =
  'To use voice, open this dialog in Chrome, Edge or Safari (built-in speech recognition), or enable server ' +
  'transcription: set GROQ_API_KEY or OPENAI_API_KEY before starting Claude Anywhere (or add a key in ' +
  'Settings › Voice), or install whisper.cpp.';

// ------------------------------------------------------------------ text helpers

/**
 * Turn markdown into text that reads well aloud (mirrors src/shared/util.js).
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdownForSpeech(text) {
  if (!text) return '';
  let s = String(text);
  s = s.replace(/```[\s\S]*?```/g, ' (code omitted) ');
  s = s.replace(/```[\s\S]*$/g, ' (code omitted) ');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s*\|.*\|\s*$/gm, '');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, '');
  s = s.replace(/^\s*\d+[.)]\s+/gm, '');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2');
  s = s.replace(/~~(.*?)~~/g, '$1');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/https?:\/\/\S+/g, 'the link');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{2,}/g, '\n');
  return s.trim();
}

/**
 * Markdown → speakable text, cut at a sentence boundary near `max` chars.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function speechText(text, max = SPEECH_MAX) {
  const s = stripMarkdownForSpeech(text).replace(/\s*\n\s*/g, '. ').replace(/\.\s*\./g, '.').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

/**
 * Split text into chunks of whole sentences no longer than maxLen (long
 * sentences are split at commas or spaces).
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string[]}
 */
export function splitSentences(text, maxLen = 180) {
  const sentences = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?。！？]+(?:[.!?。！？]+|$)\s*/g);
  if (!sentences) return [];
  const out = [];
  let cur = '';
  const pushPiece = (piece) => {
    let p = piece.trim();
    while (p.length > maxLen) {
      let at = p.lastIndexOf(', ', maxLen);
      if (at < maxLen * 0.4) at = p.lastIndexOf(' ', maxLen);
      if (at < maxLen * 0.4) at = maxLen;
      out.push(p.slice(0, at + 1).trim());
      p = p.slice(at + 1).trim();
    }
    return p;
  };
  for (const s of sentences) {
    if ((cur + s).length <= maxLen) {
      cur += s;
      continue;
    }
    if (cur.trim()) out.push(cur.trim());
    cur = pushPiece(s);
    if (cur) cur += ' ';
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** Lowercase, strip punctuation, collapse spaces. */
export function normalizeSpeech(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Close mishearings of a wake word, accepted wherever that word is expected.
const WORD_ALIASES = {
  claude: ['claud', 'clawed', 'clawd', 'klaud', 'clode', 'claudes', "claude's"],
  hey: ['hi', 'hay', 'hei', 'hej', 'heh', 'hello'],
};
// Everyday words a recognizer also hears for a wake word. They count only inside the whole
// phrase, after the words before them matched ("hey cloud"), never on their own: Claude's own
// answers ("Cloud Run is deployed", "Glad that worked") must not wake it.
const LOOSE_ALIASES = {
  claude: ['cloud', 'clod', 'klaus', 'claws', 'clause', 'clyde', 'glad'],
};
// One of these may come before the wake phrase ("okay, hey claude", "so claude…").
const LEAD_FILLERS = new Set(['ok', 'okay', 'so', 'um', 'uh', 'umm', 'uhm', 'er', 'erm', 'oh', 'well', 'and', 'yo', 'alright', 'hey', 'hi', 'hello']);

/**
 * @param {string} heard normalized word
 * @param {string} want normalized wake word
 * @param {'exact'|'near'|'close'|'loose'} mode exact spelling; or within one edit; or also
 *   close aliases and edits; or also loose aliases
 */
function wordMatches(heard, want, mode = 'close') {
  const h = heard.replace(/'/g, '');
  const w = want.replace(/'/g, '');
  if (h === w) return true;
  if (mode === 'exact') return false;
  const listed = (list) => Boolean(list) && list.some((a) => a.replace(/'/g, '') === h);
  if (listed(LOOSE_ALIASES[w])) return mode === 'loose';
  if (mode === 'near') return w.length >= 4 && levenshtein(h, w) <= 1;
  if (listed(WORD_ALIASES[w])) return true;
  if (w.length >= 7) return levenshtein(h, w) <= 2;
  if (w.length >= 4) return levenshtein(h, w) <= 1;
  return false;
}

/**
 * Find the wake word at the start of an utterance (tolerant of common
 * mishearings such as "hey cloud"). Returns the text spoken after it.
 * The phrase must open the utterance (after at most one filler such as
 * "okay"); later on, only the exact multi-word phrase counts. With `strict`
 * (used while Claude is speaking), only the exact phrase at the start counts.
 * @param {string} text
 * @param {string} wakeWord
 * @param {{strict?:boolean}} [opts]
 * @returns {{matched:boolean, rest:string}}
 */
export function matchWakeWord(text, wakeWord, { strict = false } = {}) {
  const want = normalizeSpeech(wakeWord).split(' ').filter(Boolean);
  const src = String(text || '');
  if (!want.length) return { matched: true, rest: src.trim() };
  const words = [];
  const re = /[\p{L}\p{N}'’]+/gu;
  let m;
  while ((m = re.exec(src))) words.push({ w: normalizeSpeech(m[0]), end: m.index + m[0].length });
  const tidy = (end) => src.slice(end).replace(/^[\s,.:;!?'"’-]+/, '').trim();
  const phraseAt = (k, exact) => {
    if (k + want.length > words.length) return false;
    for (let j = 0; j < want.length; j += 1) {
      if (!wordMatches(words[k + j].w, want[j], exact ? 'exact' : j > 0 ? 'loose' : 'close')) return false;
    }
    return true;
  };
  const found = (k, n) => ({ matched: true, rest: tidy(words[k + n - 1].end) });
  const starts = [0];
  if (words.length > 1 && LEAD_FILLERS.has(words[0].w)) starts.push(1);
  for (const k of starts) if (phraseAt(k, strict)) return found(k, want.length);
  if (strict) return { matched: false, rest: '' };
  // Further in, only the exact phrase counts ("so I said hey claude, open mail").
  if (want.length > 1) {
    for (let k = 1; k + want.length <= words.length; k += 1) if (phraseAt(k, true)) return found(k, want.length);
  }
  // Recognizers often drop a short greeting ("hey"): accept the last wake word on its own,
  // spelled (nearly) right, when it opens the utterance.
  const last = want[want.length - 1];
  if (want.length > 1 && last.length >= 4) {
    for (const k of starts) if (k < words.length && wordMatches(words[k].w, last, 'near')) return found(k, 1);
  }
  return { matched: false, rest: '' };
}

const ORDINALS = { first: 1, one: 1, second: 2, two: 2, third: 3, three: 3, fourth: 4, four: 4, fifth: 5, five: 5, sixth: 6, six: 6, seventh: 7, seven: 7, eighth: 8, eight: 8, ninth: 9, nine: 9, tenth: 10, ten: 10, last: -1 };

const STOP_RE = /^(?:please )?(?:stop|cancel|halt|abort|enough|never ?mind|stop it|stop that|cancel that|stop stop|stop now|stop please|cancel it)(?: please)?$/;
// Approvals: "no…" anywhere at the start denies (the safe direction, and the rest becomes the
// reason). Allowing takes a whole utterance that is nothing but a yes ("yeah, go ahead") or an
// "always"; anything hedged ("okay wait…", "yes, but…", "always ask me first") is left for the
// card. The alternatives below are unambiguous word sequences, so matching stays linear.
const ALWAYS_RE = /^(?:(?:yes|yeah|ok|okay) )?(?:always|always allow|allow always|always yes|always allow (?:it|this|that)|allow (?:it|this|that) always|(?:always )?allow (?:it |this |that )?for (?:this|the) session)(?: (?:please|thanks|thank you))?$/;
const AFFIRM = 'yes|yeah|yep|yup|ya|allow|approve|approved|ok|okay|go ahead|go for it|go on|do it|sure|sure thing|confirm|confirmed|proceed|continue|allow once|sounds good|affirmative';
const ALLOW_FILLER = 'please|it|this|that|thanks|thank you|and|then|now|claude';
const ALLOW_RE = new RegExp(`^(?:please )?(?:${AFFIRM})(?: (?:${AFFIRM}|${ALLOW_FILLER}))*$`);
const DENY_RE = /^(?:no|nope|nah|deny|denied|don't|do not|reject|decline|refuse|negative|cancel)\b/;
const APPROVAL_HEDGE_RE = /\b(?:no|not|nope|nah|don't|dont|never|deny|denied|reject|refuse|cancel|stop|wait|hold|hang|but|ask|asking|what|why|how|which|instead|before|unless|except|first|later|maybe)\b/;
// Words around a spoken option that mean it is not simply being chosen ("not sure", "no, not staging").
const ANSWER_HEDGE_RE = /\b(?:no|not|don't|dont|never|neither|nor|or|but|instead|unless|except|what|why|which|how|who|where|when|maybe|perhaps|unsure|wait|mean)\b/;

/**
 * Interpret a spoken utterance given what the dialog is waiting for.
 * @param {string} text
 * @param {{approval?:boolean, question?:{options?:string[]}|null}} [ctx]
 * @returns {{kind:'stop'}|{kind:'approve', decision:'allow'|'allow_session'|'deny', message?:string}|
 *   {kind:'answer', text:string}|{kind:'unmatched_approval', text:string}|{kind:'command', text:string}}
 */
export function parseVoiceIntent(text, ctx = {}) {
  const raw = String(text || '').trim();
  const t = normalizeSpeech(raw);
  if (!t) return { kind: 'command', text: '' };
  if (STOP_RE.test(t)) return { kind: 'stop' };
  if (ctx.approval) {
    const deny = /^no (?:problem|worries)\b/.test(t) ? null : DENY_RE.exec(t);
    if (deny) {
      const lead = deny[0]
        .split(' ')
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]?"))
        .join('[\\s,.:;!-]+');
      const rest = raw.replace(new RegExp(`^[\\s"'“]*${lead}[\\s,.:;!-]*`, 'iu'), '').trim();
      return { kind: 'approve', decision: 'deny', ...(rest && rest !== raw ? { message: rest } : {}) };
    }
    if (t.length <= 80 && !APPROVAL_HEDGE_RE.test(t)) {
      if (ALWAYS_RE.test(t)) return { kind: 'approve', decision: 'allow_session' };
      if (ALLOW_RE.test(t)) return { kind: 'approve', decision: 'allow' };
    }
    return { kind: 'unmatched_approval', text: raw };
  }
  if (ctx.question) {
    const options = Array.isArray(ctx.question.options) ? ctx.question.options.map(String) : [];
    if (options.length) {
      const exact = options.find((o) => normalizeSpeech(o) === t);
      if (exact) return { kind: 'answer', text: exact };
      const m = /^(?:(?:option|number|choice|the)\s+)?(\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|one|two|three|four|five|six|seven|eight|nine|ten|last)(?:\s+(?:one|option))?$/.exec(t);
      if (m) {
        let n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : ORDINALS[m[1]];
        if (n === -1) n = options.length;
        if (n >= 1 && n <= options.length) return { kind: 'answer', text: options[n - 1] };
      }
      // Whole words only ("yesterday" is not "yes"); exactly one option named ("yes no" is
      // neither); and nothing around it that hedges or negates it ("not sure", "no, not that one").
      const padded = ` ${t} `;
      const norm = options.map((o) => ({ o, no: normalizeSpeech(o) })).filter((x) => x.no);
      let named = norm.filter((x) => padded.includes(` ${x.no} `));
      named = named.filter((x) => !named.some((y) => y !== x && y.no !== x.no && ` ${y.no} `.includes(` ${x.no} `)));
      if (named.length === 1) {
        const { o, no } = named[0];
        const around = padded.replace(` ${no} `, ' ').trim();
        // A short option ("Yes", "Staging") counts only when it is most of what was said.
        const short = no.split(' ').length <= 2;
        if (!ANSWER_HEDGE_RE.test(around) && (!short || (around ? around.split(' ').length : 0) <= 2)) return { kind: 'answer', text: o };
      } else if (!named.length && t.split(' ').length >= 2 && !ANSWER_HEDGE_RE.test(t)) {
        // A few words from inside one longer option ("new project").
        const inside = norm.filter((x) => x.no !== t && ` ${x.no} `.includes(padded));
        if (inside.length === 1) return { kind: 'answer', text: inside[0].o };
      }
    }
    return { kind: 'answer', text: raw };
  }
  return { kind: 'command', text: raw };
}

/** @returns {SpeechSynthesisVoice[]} the browser's voices (may be empty until voiceschanged) */
export function getBrowserVoices() {
  try {
    return globalThis.speechSynthesis ? globalThis.speechSynthesis.getVoices() || [] : [];
  } catch {
    return [];
  }
}

function sttErrorMessage(code, lang) {
  switch (code) {
    case 'not-allowed':
      return 'Microphone access is blocked. Allow the microphone for this page (the icon in the address bar), and on macOS also in System Settings › Privacy & Security › Microphone.';
    case 'service-not-allowed':
      return "This browser's speech recognition service isn't available here.";
    case 'network':
      return "The browser's speech recognition service couldn't be reached (it needs the internet, and some Chromium builds and Electron don't include it).";
    case 'audio-capture':
      return 'No microphone was found. Connect one or choose a default input device.';
    case 'language-not-supported':
      return `Speech recognition doesn't support "${lang}". Change the language in Settings › Voice.`;
    case 'bad-grammar':
    default:
      return `Speech recognition stopped (${code || 'unknown error'}).`;
  }
}

// ------------------------------------------------------------------ createVoice

/**
 * @param {{
 *   getConfig: () => object,                       public config (uses config.voice)
 *   api: (method:string, path:string, body?:any, opts?:object) => Promise<any>,
 *   onInterim?: (text:string) => void,
 *   onFinal?: (text:string, meta:{mode:string, provider:string}) => void,
 *   onState?: (state:{phase:string, mode:string|null, provider:string|null, speaking:boolean}) => void,
 *   onError?: (message:string, opts?:{level?:string, code?:string}) => void,
 *   onLevel?: (level:number) => void,              0..1 microphone level (server recording)
 *   getServerVoice?: () => {serverStt?:boolean, sttProvider?:string, sttHint?:string, serverTts?:boolean, ttsProvider?:string},
 *   Recorder?: typeof WavRecorder                  server-transcription recorder (tests pass a fake)
 * }} opts
 */
export function createVoice({ getConfig, api, onInterim, onFinal, onState, onError, onLevel, getServerVoice, Recorder = WavRecorder } = {}) {
  const g = globalThis;
  const SR = g.SpeechRecognition || g.webkitSpeechRecognition || null;
  const synth = g.speechSynthesis || null;
  const isElectron = Boolean(g.anywhereShell && g.anywhereShell.isElectron);

  let session = null;
  let phase = 'idle';
  let armedUntil = 0;
  let browserFailed = false;
  let speakingBrowser = false;
  let serverSpeakUntil = 0;
  let serverPending = 0; // speakGen of the POST /api/tts still waiting for the daemon to finish
  let speakTimer = 0; // re-emits state when the server speech estimate runs out
  let lastSpeechEnd = 0;
  let speakGen = 0;
  let lastStopPost = 0;
  const liveUtterances = new Set();

  const cb = (fn, ...args) => {
    if (typeof fn !== 'function') return undefined;
    try {
      return fn(...args);
    } catch (err) {
      if (g.console) g.console.error('voice callback failed', err);
      return undefined;
    }
  };

  const voiceCfg = () => {
    try {
      const c = (getConfig && getConfig()) || {};
      return c.voice || {};
    } catch {
      return {};
    }
  };
  const serverVoice = () => {
    try {
      return (getServerVoice && getServerVoice()) || {};
    } catch {
      return {};
    }
  };

  function isSpeaking() {
    return speakingBrowser || Boolean(synth && synth.speaking) || (serverPending !== 0 && serverPending === speakGen) || Date.now() < serverSpeakUntil;
  }

  /**
   * True while Claude is speaking and for a moment after: speech synthesis and the daemon's
   * TTS bypass the browser's echo cancellation, so the microphone hears Claude's own words.
   */
  function echoLikely() {
    return isSpeaking() || Date.now() < Math.max(lastSpeechEnd, serverSpeakUntil) + ECHO_TAIL_MS;
  }

  /** The user spoke over Claude on purpose: stop speaking, and trust what follows. */
  function bargeIn() {
    if (isSpeaking()) cancelSpeech();
    lastSpeechEnd = 0;
    serverSpeakUntil = 0;
  }

  function emitState() {
    cb(onState, {
      phase,
      mode: session ? session.mode : null,
      provider: session ? session.provider : null,
      speaking: isSpeaking(),
      armed: Date.now() < armedUntil,
    });
  }

  function setPhase(p) {
    phase = p;
    emitState();
  }

  function sttProvider() {
    const v = voiceCfg();
    const mode = v.stt || 'auto';
    const canRecord = Recorder.isSupported();
    if (mode === 'off') return 'off';
    if (mode === 'server') return canRecord ? 'server' : 'none';
    if (mode === 'browser') return SR ? 'browser' : 'none';
    const srv = serverVoice();
    // The daemon reports serverStt:false both before it has checked (no hint yet) and once it
    // knows there is no provider (with a hint saying what to set up). Only the second rules it out.
    const noServerStt = srv.serverStt === false && Boolean(srv.sttHint);
    if (browserFailed && srv.serverStt && canRecord) return 'server';
    // Electron's Chromium has webkitSpeechRecognition but no key for Google's speech service, so
    // it always fails there: only server speech can work.
    if (isElectron) return canRecord && !noServerStt ? 'server' : 'none';
    if (SR && !browserFailed) return 'browser';
    if (canRecord && !noServerStt) return 'server';
    return SR ? 'browser' : 'none';
  }

  function ttsProvider(vc) {
    const v = vc || voiceCfg();
    const mode = v.tts || 'auto';
    if (mode === 'off') return 'off';
    if (mode === 'server') return 'server';
    if (mode === 'browser') return synth ? 'browser' : 'server';
    if (synth && getBrowserVoices().length) return 'browser';
    const srv = serverVoice();
    if (srv.serverTts !== false) return 'server';
    return synth ? 'browser' : 'none';
  }

  function wakeWord() {
    const v = voiceCfg();
    return typeof v.wakeWord === 'string' ? v.wakeWord.trim() : '';
  }

  function deliver(text, s) {
    const t = String(text || '').trim();
    cb(onInterim, '');
    if (!t) return;
    cb(onFinal, t, { mode: s.mode, provider: s.provider });
  }

  /** Hands-free: apply wake-word gating to a finished utterance. */
  function handsFreeUtterance(text, s) {
    const t = String(text || '').trim();
    if (!t) return;
    const ww = wakeWord();
    // While Claude talks (and just after), the microphone hears Claude: without a wake word only
    // "stop" gets through, and with one only the exact phrase at the start.
    const echo = echoLikely();
    if (!ww) {
      if (echo && !STOP_RE.test(normalizeSpeech(t))) return;
      bargeIn();
      deliver(t, s);
      return;
    }
    if (!echo && Date.now() < armedUntil) {
      armedUntil = 0;
      const again = matchWakeWord(t, ww);
      deliver(again.matched && again.rest ? again.rest : t, s);
      setPhase(session === s ? 'wake' : phase);
      return;
    }
    const m = matchWakeWord(t, ww, { strict: echo });
    if (!m.matched) return;
    bargeIn();
    if (m.rest) {
      if (armedUntil) {
        armedUntil = 0;
        if (session === s) setPhase('wake');
      }
      deliver(m.rest, s);
      return;
    }
    armedUntil = Date.now() + ARM_MS;
    cb(onInterim, '');
    setPhase('listening');
    setTimeout(() => {
      if (session === s && armedUntil && Date.now() >= armedUntil) {
        armedUntil = 0;
        setPhase('wake');
      }
    }, ARM_MS + 50);
  }

  function handsFreeInterim(text) {
    const ww = wakeWord();
    const echo = echoLikely();
    if (!ww || (!echo && Date.now() < armedUntil)) {
      cb(onInterim, text);
      return;
    }
    const m = matchWakeWord(text, ww, { strict: echo });
    if (m.matched) {
      bargeIn();
      cb(onInterim, m.rest);
    }
  }

  function fail(message, code, level = 'error') {
    cb(onError, message, { code, level });
  }

  // -------------------------------------------------------------- browser STT

  function startBrowser(mode) {
    const v = voiceCfg();
    const s = {
      provider: 'browser',
      mode,
      held: mode === 'ptt',
      stopping: false,
      cancelled: false,
      finals: '',
      error: null,
      quickEnds: 0,
      startedAt: 0,
      rec: null,
      ended: false, // s.rec has ended (a restart may be pending)
      restartTimer: 0,
    };
    session = s;

    const spawn = () => {
      const rec = new SR();
      rec.lang = v.language || (g.navigator && g.navigator.language) || 'en-US';
      rec.interimResults = true;
      rec.continuous = mode === 'handsfree';
      rec.maxAlternatives = 1;
      s.rec = rec;
      s.ended = false;
      s.startedAt = Date.now();
      rec.onstart = () => {
        if (session !== s) return;
        setPhase(mode === 'handsfree' && wakeWord() && Date.now() >= armedUntil ? 'wake' : 'listening');
      };
      rec.onresult = (e) => {
        if (session !== s) return;
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const r = e.results[i];
          const txt = r && r[0] ? r[0].transcript : '';
          if (r.isFinal) {
            if (mode === 'handsfree') handsFreeUtterance(txt, s);
            else s.finals = `${s.finals} ${txt}`.trim();
          } else {
            interim += txt;
          }
        }
        if (mode === 'handsfree') {
          if (interim) handsFreeInterim(interim);
        } else {
          cb(onInterim, `${s.finals} ${interim}`.trim());
        }
      };
      rec.onerror = (e) => {
        if (session !== s) return;
        const code = (e && e.error) || 'unknown';
        if (code === 'no-speech' || code === 'aborted') return;
        s.error = code;
      };
      rec.onend = () => {
        if (session !== s) return;
        s.ended = true;
        const err = s.error;
        s.error = null;
        if (err) {
          const lang = rec.lang;
          const srv = serverVoice();
          const autoMode = (voiceCfg().stt || 'auto') === 'auto';
          if (FALLBACK_ERRORS.has(err) && autoMode && srv.serverStt && Recorder.isSupported() && !s.cancelled) {
            browserFailed = true;
            session = null;
            const name = srv.sttProvider ? ` (${srv.sttProvider})` : '';
            fail(`Browser speech recognition is unavailable (${err}); using server transcription${name} instead.`, err, 'info');
            if (!s.stopping || s.held) startServer(mode).catch(() => {});
            else setPhase('idle');
            return;
          }
          finish(s);
          fail(`${sttErrorMessage(err, lang)}${FALLBACK_ERRORS.has(err) ? ` ${VOICE_HELP}` : ''}`, err);
          return;
        }
        const shouldRestart = !s.stopping && !s.cancelled && (mode === 'handsfree' || (mode === 'ptt' && s.held));
        if (shouldRestart) {
          s.quickEnds = Date.now() - s.startedAt < 1000 ? s.quickEnds + 1 : 0;
          if (s.quickEnds >= 5) {
            finish(s);
            fail('Speech recognition keeps stopping right after it starts. Check the microphone, or switch Speech input to "Server transcription" in Settings.', 'restart-loop');
            return;
          }
          // stop() and cancel() clear this timer: a recognizer that already ended never fires
          // onend again, so they finish the session themselves.
          s.restartTimer = setTimeout(() => {
            s.restartTimer = 0;
            if (session !== s || s.stopping || s.cancelled) return;
            try {
              spawn();
              s.rec.start();
            } catch (err2) {
              finish(s);
              fail(`Speech recognition could not restart: ${err2.message}`, 'restart');
            }
          }, mode === 'handsfree' ? 250 : 50);
          return;
        }
        const text = s.finals;
        finish(s);
        if (s.cancelled || mode === 'handsfree') return;
        if (text.trim()) deliver(text, s);
        else if (!s.stopping) fail("I didn't hear anything. Check that the right microphone is selected and try again.", 'no-speech', 'info');
      };
    };

    try {
      spawn();
      s.rec.start();
      setPhase('starting');
    } catch (err) {
      session = null;
      setPhase('idle');
      fail(`Speech recognition could not start: ${err.message}`, 'start');
    }
  }

  function finish(s) {
    if (session === s) session = null;
    armedUntil = 0;
    cb(onInterim, '');
    setPhase('idle');
  }

  // -------------------------------------------------------------- server STT

  async function startServer(mode) {
    const s = { provider: 'server', mode, held: mode === 'ptt', stopping: false, cancelled: false, rec: null };
    session = s;
    setPhase('starting');
    const record = async () => {
      const rec = new Recorder({
        onLevel: (l) => cb(onLevel, l),
        vad: {
          silenceMs: mode === 'ptt' ? Infinity : 1200,
          maxMs: 60000,
          noSpeechMs: mode === 'handsfree' ? 0 : mode === 'ptt' ? 0 : 10000,
          onStop: (reason) => {
            if (session !== s || s.rec !== rec) return;
            if (reason === 'nospeech' && mode !== 'handsfree') {
              s.cancelled = true;
              rec.cancel();
              finish(s);
              fail("I didn't hear anything. Check that the right microphone is selected.", 'no-speech', 'info');
              return;
            }
            transcribe(s, rec).catch(() => {});
          },
        },
      });
      s.rec = rec;
      await rec.start();
      if (session !== s) {
        rec.cancel();
        return;
      }
      setPhase(mode === 'handsfree' && wakeWord() && Date.now() >= armedUntil ? 'wake' : 'listening');
    };
    s.record = record;
    try {
      await record();
    } catch (err) {
      if (session === s) finish(s);
      fail(err.code === 'unsupported' ? `${err.message} ${VOICE_HELP}` : err.message, err.code || 'audio-capture');
    }
  }

  async function transcribe(s, rec) {
    if (s.transcribing) return;
    s.transcribing = true;
    const blob = await rec.stop();
    const heard = rec.hasSpeech;
    const again = () => {
      s.transcribing = false;
      if (session === s && s.mode === 'handsfree' && !s.stopping && !s.cancelled) {
        s.record().catch((err) => {
          finish(s);
          fail(err.message, err.code || 'audio-capture');
        });
      } else if (session === s) {
        finish(s);
      }
    };
    if (s.cancelled) return;
    // A quiet or distant microphone may never trip the VAD: when the user ended a push-to-talk or
    // click recording themselves, send anything of 300 ms or more and let the server decide.
    const userEnded = s.mode !== 'handsfree' && s.stopping;
    if (blob.size <= 44 + 3200 || (!heard && !(userEnded && blob.size >= 44 + 9600))) {
      if (s.mode !== 'handsfree' && session === s) {
        finish(s);
        fail("I didn't catch that. Try again a little closer to the microphone.", 'no-speech', 'info');
        return;
      }
      again();
      return;
    }
    if (session === s) setPhase('transcribing');
    const lang = voiceCfg().language || '';
    let text = '';
    try {
      const res = await api('POST', `/api/stt${lang ? `?language=${encodeURIComponent(lang)}` : ''}`, blob, {
        contentType: 'audio/wav',
        timeoutMs: 120000,
      });
      text = (res && typeof res.text === 'string' ? res.text : '').trim();
      s.failures = 0;
    } catch (err) {
      s.transcribing = false;
      const hint = err.hint ? ` ${err.hint}` : '';
      const help = err.status === 503 || err.status === 501 ? ` ${VOICE_HELP}` : '';
      const message = `${err.message || 'Transcription failed.'}${hint}${help}`;
      // Hands-free keeps listening through a dropped connection, rate limit or provider hiccup
      // (backing off), and stops only when transcription isn't set up or keeps failing.
      const transient = err.status === 0 || err.status === 408 || err.status === 429 || (err.status >= 500 && err.status !== 501 && err.status !== 503);
      if (s.mode === 'handsfree' && session === s && !s.stopping && !s.cancelled && transient && (s.failures || 0) < 5) {
        s.failures = (s.failures || 0) + 1;
        const delay = Math.min(8000, 1000 * 2 ** (s.failures - 1));
        fail(`${message} Listening again in ${Math.round(delay / 1000)} s.`, 'server-stt', 'warning');
        setPhase('starting');
        setTimeout(again, delay);
        return;
      }
      if (session === s) finish(s);
      fail(message, 'server-stt');
      return;
    }
    if (s.cancelled) return;
    if (!heard && SILENCE_HALLUCINATIONS.has(normalizeSpeech(text))) text = '';
    if (s.mode === 'handsfree') {
      handsFreeUtterance(text, s);
      again();
      return;
    }
    s.transcribing = false;
    finish(s);
    if (text) deliver(text, s);
    else fail("I couldn't make out any words. Try again.", 'empty', 'info');
  }

  // -------------------------------------------------------------- public STT

  function start(mode = 'toggle') {
    const m = ['toggle', 'ptt', 'handsfree'].includes(mode) ? mode : 'toggle';
    cancelSpeech();
    if (session) {
      if (session.mode === m) return;
      cancel();
    }
    const p = sttProvider();
    if (p === 'off') {
      fail('Voice input is turned off. Turn it on in Settings › Voice.', 'off', 'info');
      return;
    }
    if (p === 'none') {
      fail(`Voice input isn't available in this window. ${isElectron ? ELECTRON_VOICE_HELP : VOICE_HELP}`, 'unsupported');
      return;
    }
    if (p === 'browser') startBrowser(m);
    else startServer(m).catch(() => {});
  }

  /** Stop listening; toggle/push-to-talk input that was heard is delivered. */
  function stop() {
    const s = session;
    if (!s) return;
    s.stopping = true;
    s.held = false;
    if (s.provider === 'browser') {
      if (s.ended || s.restartTimer) {
        // Released between a recognizer ending and its restart: stop() on an ended recognizer
        // does nothing, so end the session here with what was heard.
        clearTimeout(s.restartTimer);
        s.restartTimer = 0;
        const text = s.finals;
        finish(s);
        if (s.mode !== 'handsfree' && text.trim()) deliver(text, s);
        return;
      }
      try {
        s.rec.stop();
      } catch {
        finish(s);
      }
      return;
    }
    if (s.mode === 'handsfree') {
      cancel();
      return;
    }
    if (s.rec && s.rec.recording) transcribe(s, s.rec).catch(() => {});
    else if (!s.transcribing) finish(s);
  }

  /** Stop listening and throw away anything heard. */
  function cancel() {
    const s = session;
    if (!s) return;
    s.cancelled = true;
    s.stopping = true;
    s.held = false;
    session = null;
    if (s.provider === 'browser') {
      clearTimeout(s.restartTimer);
      s.restartTimer = 0;
      try {
        s.rec.abort();
      } catch {
        /* already ended */
      }
    } else if (s.rec) {
      s.rec.cancel();
    }
    armedUntil = 0;
    cb(onInterim, '');
    cb(onLevel, 0);
    setPhase('idle');
  }

  function toggle() {
    if (session) stop();
    else start(voiceCfg().handsFree ? 'handsfree' : 'toggle');
  }

  // -------------------------------------------------------------- TTS

  function waitForVoices(ms) {
    if (!synth || getBrowserVoices().length) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        try {
          synth.removeEventListener('voiceschanged', done);
        } catch {
          /* old Safari */
        }
        resolve();
      };
      const t = setTimeout(done, ms);
      try {
        synth.addEventListener('voiceschanged', done);
      } catch {
        /* old Safari */
      }
    });
  }

  function pickVoice(name, lang) {
    const voices = getBrowserVoices();
    if (!voices.length) return null;
    if (name) {
      const v = voices.find((x) => x.name === name || x.voiceURI === name);
      if (v) return v;
    }
    const base = String(lang || '').toLowerCase();
    const prefix = base.split('-')[0];
    return (
      voices.find((x) => x.lang && x.lang.toLowerCase() === base && x.default) ||
      voices.find((x) => x.lang && x.lang.toLowerCase() === base) ||
      voices.find((x) => x.lang && x.lang.toLowerCase().startsWith(prefix)) ||
      null
    );
  }

  function speakBrowser(text, gen, vc) {
    const v = vc || voiceCfg();
    const chunks = splitSentences(text, 180);
    if (!chunks.length) return;
    const voice = pickVoice(v.ttsVoice, v.language);
    const rate = Math.max(0.5, Math.min(2, Number(v.ttsRate) || 1));
    speakingBrowser = true;
    emitState();
    chunks.forEach((chunk, i) => {
      const u = new g.SpeechSynthesisUtterance(chunk);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else if (v.language) {
        u.lang = v.language;
      }
      u.rate = rate;
      const last = i === chunks.length - 1;
      const end = () => {
        liveUtterances.delete(u);
        if (last && gen === speakGen) {
          speakingBrowser = false;
          lastSpeechEnd = Date.now();
          emitState();
        }
      };
      u.onend = end;
      u.onerror = (e) => {
        end();
        if (gen === speakGen) {
          speakingBrowser = false;
          emitState();
        }
        const code = e && e.error;
        if (code && code !== 'interrupted' && code !== 'canceled' && i === 0) {
          speakServer(text, gen, v).catch(() => {});
        }
      };
      liveUtterances.add(u);
      synth.speak(u);
    });
    try {
      synth.resume();
    } catch {
      /* not paused */
    }
  }

  async function speakServer(text, gen, vc) {
    if (gen !== speakGen) return;
    const rate = Math.max(0.5, Math.min(2, Number((vc || voiceCfg()).ttsRate) || 1));
    const est = ((text.length / 14) * 1000) / rate + 2000;
    serverSpeakUntil = Date.now() + Math.min(120000, est);
    emitState();
    clearTimeout(speakTimer);
    speakTimer = setTimeout(emitState, serverSpeakUntil - Date.now() + 50);
    // The daemon answers once it has finished speaking: until then Claude counts as speaking
    // even past the estimate (slow engines, low rates), so Esc and barge-in still stop it.
    serverPending = gen;
    try {
      await api('POST', '/api/tts', { text }, { timeoutMs: Math.min(310000, Math.max(30000, est * 1.5 + 15000)) });
      if (gen === speakGen) serverSpeakUntil = Date.now();
    } catch (err) {
      if (gen !== speakGen) return; // stopped or replaced meanwhile
      // Our own timeout says nothing about the daemon (it caps speech itself): no error.
      if (err && (err.timeout || err.name === 'AbortError')) return;
      if (Date.now() < serverSpeakUntil) lastSpeechEnd = Date.now();
      serverSpeakUntil = 0;
      if (err && err.status !== 400) fail(`Could not speak the answer: ${err.message}${err.hint ? ` ${err.hint}` : ''}`, 'tts', 'warning');
    } finally {
      if (serverPending === gen) serverPending = 0;
      if (gen === speakGen) {
        clearTimeout(speakTimer);
        speakTimer = 0;
      }
      emitState();
    }
  }

  /**
   * Speak text aloud (markdown is stripped; long answers are cut near 600 chars).
   * @param {string} text
   * @param {object} [overrides] voice settings to use instead of the saved ones
   *   (tts, ttsVoice, ttsRate, language), e.g. to preview unsaved settings
   */
  async function speak(text, overrides) {
    const clean = speechText(text);
    if (!clean) return;
    const gen = ++speakGen;
    stopBrowserSpeech();
    const vc = { ...voiceCfg(), ...(overrides || {}) };
    let p = ttsProvider(vc);
    if (p === 'off' || p === 'none') return;
    if (p === 'server' && (vc.tts || 'auto') === 'auto' && synth) {
      await waitForVoices(800);
      if (gen !== speakGen) return;
      p = ttsProvider(vc);
    }
    if (p === 'browser' && synth) {
      // Chrome drops speak() calls issued in the same tick as cancel().
      setTimeout(() => {
        if (gen === speakGen) speakBrowser(clean, gen, vc);
      }, 60);
    } else {
      await speakServer(clean, gen, vc);
    }
  }

  function stopBrowserSpeech() {
    if (speakingBrowser || (synth && synth.speaking)) lastSpeechEnd = Date.now();
    if (synth) {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
    }
    liveUtterances.clear();
    speakingBrowser = false;
  }

  /** Stop any speech, in the browser and on the daemon (POST /api/tts/stop). */
  function cancelSpeech() {
    const wasSpeaking = isSpeaking();
    speakGen += 1;
    stopBrowserSpeech();
    if (wasSpeaking) lastSpeechEnd = Date.now();
    serverSpeakUntil = 0;
    clearTimeout(speakTimer);
    speakTimer = 0;
    const now = Date.now();
    if (now - lastStopPost > 400) {
      lastStopPost = now;
      Promise.resolve()
        .then(() => api('POST', '/api/tts/stop', {}, { timeoutMs: 5000 }))
        .catch(() => {});
    }
    if (wasSpeaking) emitState();
  }

  /** @returns {{stt:string, tts:string, sttName:string, ttsName:string}} */
  function provider() {
    const stt = sttProvider();
    const tts = ttsProvider();
    const srv = serverVoice();
    return {
      stt,
      tts,
      sttName: stt === 'server' ? srv.sttProvider || 'server' : stt,
      ttsName: tts === 'server' ? srv.ttsProvider || 'system' : tts,
    };
  }

  if (synth) {
    // Chrome loads voices lazily; touching the list starts the load.
    getBrowserVoices();
  }

  return {
    start,
    stop,
    cancel,
    toggle,
    isActive: () => Boolean(session),
    isSpeaking,
    speak,
    cancelSpeech,
    provider,
    phase: () => phase,
    mode: () => (session ? session.mode : null),
    /** Hands-free heard the wake word alone and takes the next utterance as the request. */
    armed: () => Boolean(session) && Date.now() < armedUntil,
  };
}
