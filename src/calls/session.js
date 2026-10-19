'use strict';

/**
 * One AI-answered call (docs/CALLS-DESIGN.md §6, §7): the conversation loop.
 *
 *   caller audio → sidecar (capture → Silero VAD → local STT) → asr.final
 *     → CallSession: transcript, objections, end-of-turn merging, barge-in, filler decision
 *     → call engine (claude -p --model haiku, stream-json, --tools "", only the call_* MCP tools,
 *       --system-prompt-file) → text deltas → ClauseSplitter → VoiceChain (cloned voice → Piper → OS voice)
 *     → sidecar tts.say → playback into the virtual microphone → the call
 *
 * Safeguard (b): the greeting (greeting.js, disclosure + transcription notice composed in code) is the first
 * thing said. No LLM speech reaches the sidecar before a disclosure utterance has been heard in full: when a
 * barge-in cuts the greeting before its disclosure ended, a short re-disclosure is said before the next
 * reply. Safeguard (c): the engine has no built-in tools; its tool calls reach the daemon (manager.js →
 * policy.js), never this class.
 *
 *   class CallSession extends EventEmitter {
 *     constructor({id, caller, app, appName, config, sidecar, voice, engine, engineFactory, clock, ownerName,
 *                  ownerFirst, pronoun, audioParams, hangUpCall, restartAudio, options})
 *     async start(); async handleUtterance(text); say(text); requestEnd(reason); async hangup(reason, opts);
 *     async takeover(); async summarize(); async close(); transcript(); actions(); recordAction(a); status()
 *   }  events: 'transcript' {role, text, ts, interrupted?}, 'action', 'state' {state}, 'ended' {reason}, 'warning'
 *
 * Also exported: ClauseSplitter, VoiceChain, createCallEngine(), writeCallRunFiles(), callEngineArgs().
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const greetingMod = require('./greeting');
const promptMod = require('./prompt');
const policyMod = require('./policy');
const { createLogger } = require('../shared/log');

const log = createLogger('calls-session');

const DEFAULTS = Object.freeze({
  fillerAfterMs: 900, // no clause from the LLM this long after the caller's turn → a cached filler (§6.4)
  maxReplyWords: 40, // words spoken per reply (the prompt asks for 2 sentences)
  stillThereMs: 8000, // silence → "Are you still there?" (§6.5)
  silenceHangupMs: 20000, // silence → goodbye and hang-up
  conjunctionWaitMs: 1200, // an utterance ending in "and|but|so|um|uh|like" waits for more
  bargeSettleMs: 1500, // after the caller stops talking, how long a barge-in waits for its transcript
  goodbyeTimeoutMs: 8000,
  primeTimeoutMs: 20000,
  summaryTimeoutMs: 25000,
  warnBeforeEndMs: 60000,
  tickMs: 500,
  speechStallMs: 30000, // an utterance that never reports its end counts as ended after this
  maxDisclosureFailures: 3, // the disclosure failed to play this often: hang up without speaking (F3-SAFE-B1)
});

const FILLER = 'Okay, one moment.';
/** A sentence that ends a reply may run this many words past maxReplyWords instead of being dropped. */
const REPLY_GRACE_WORDS = 8;
const STILL_THERE = 'Are you still there?';
const GOODBYE = 'Thanks for calling. Bye!';
const SILENCE_GOODBYE = "I'll let you go now. Thanks for calling. Bye!";
const FILLERS = Object.freeze(['Sure.', 'Okay, one moment.', 'Let me check that.', 'Got it.', 'Sorry, could you say that again?', 'Thanks for calling. Bye!']);
/** Short backchannels: a barge-in that only says this does not interrupt (§6.5). */
const BACKCHANNEL_RE = /^(?:ok(?:ay)?|k|mm+(?:[- ]?hmm+)?|m+hm+|uh[- ]?huh|yeah|yes|yep|yup|right|sure|got it|hmm+|ah+|oh+|i see|cool|alright|all right|hi|hello|hey|thanks|thank you)[.!?,]*$/i;
const CONJ_END_RE = /\b(?:and|but|so|um+|uh+|like|or|because)[\s.,…-]*$/i;
/** The caller objects to the transcription (§7.1): the session stops saving the transcript. */
const OBJECTION_RE = /\b(?:don['’]?t|do not|stop|please stop|no|not (?:okay|ok|fine|comfortable)|i (?:don['’]?t|do not) (?:want|consent|agree|like))\b[^.?!]{0,40}\b(?:record\w*|transcrib\w*|transcripts?|take notes|taking notes|notes)\b/i;
const GOODBYE_RE = /\b(?:bye|goodbye|good-bye|take care|talk (?:to you )?(?:soon|later)|have a (?:good|great|nice|lovely) (?:day|one|evening|night|weekend))\b/i;
const AUDIO_DEAD_CODES = new Set(['SIDECAR_EXITED', 'SIDECAR_NOT_RUNNING', 'SHUTTING_DOWN', 'SIDECAR_PROTOCOL']);

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function oneLine(s) {
  return str(s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normPhrase(s) {
  return str(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function realClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t),
  };
}

function bindClock(clock) {
  const real = realClock();
  const c = clock || {};
  const out = {};
  for (const k of Object.keys(real)) out[k] = typeof c[k] === 'function' ? (...a) => c[k](...a) : real[k];
  return out;
}

function unref(t) {
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function isAudioDead(err) {
  return Boolean(err && AUDIO_DEAD_CODES.has(err.code));
}

// ------------------------------------------------------------------------------------------ clauses

/**
 * Splits streamed LLM text into speakable clauses (§6.4): at . ! ? (followed by a space), at , ; : once the
 * clause has 4 words, or after 12 words.
 */
class ClauseSplitter {
  constructor({ commaWords = 4, maxWords = 12 } = {}) {
    this.buf = '';
    this.commaWords = commaWords;
    this.maxWords = maxWords;
  }

  /** @returns {string[]} the clauses completed by this delta */
  push(delta) {
    this.buf += str(delta);
    const out = [];
    for (;;) {
      const cut = this._boundary();
      if (cut < 0) break;
      const clause = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut).replace(/^\s+/, '');
      if (clause) out.push(clause);
    }
    return out;
  }

  /** @returns {string|null} what is left (end of the reply) */
  flush() {
    const c = this.buf.trim();
    this.buf = '';
    return c || null;
  }

  _wordCut(b, n) {
    const re = /\S+/g;
    let m;
    let i = 0;
    while ((m = re.exec(b))) {
      if (policyMod.countWords(m[0]) > 0) i += 1;
      if (i === n) {
        const end = m.index + m[0].length;
        return end < b.length && /\s/.test(b[end]) ? end : -1;
      }
    }
    return -1;
  }

  _boundary() {
    const b = this.buf;
    const s = /[.!?…]+["'”’)\]]*(?=\s)/.exec(b);
    const sentence = s ? s.index + s[0].length : -1;
    let comma = -1;
    const re = /[,;:](?=\s)/g;
    let c;
    while ((c = re.exec(b))) {
      if (sentence >= 0 && c.index >= sentence) break;
      if (policyMod.countWords(b.slice(0, c.index)) >= this.commaWords) {
        comma = c.index + 1;
        break;
      }
    }
    const cuts = [sentence, comma].filter((x) => x >= 0);
    const first = cuts.length ? Math.min(...cuts) : -1;
    const long = this._wordCut(b, this.maxWords);
    if (long >= 0 && (first < 0 || long < first)) return long;
    return first;
  }
}

// ------------------------------------------------------------------------------------------ voices

/**
 * The speaking chain of a call (§3.2): the cloned voice (phrase cache, then live tts.say) → Piper → the OS
 * voice. Every utterance is played by the sidecar's player (tts.say), so barge-in and playback events work
 * the same for all three. Utterances are queued in order.
 */
class VoiceChain {
  /**
   * @param {{clone?:object, request:(op:string, params:object, opts?:object)=>Promise<object>, piper?:object,
   *   piperVoice?:string, osRender?:(text:string, out:string)=>Promise<any>, tmpDir?:string, cloned?:boolean,
   *   phrasePath?:(engine:string, text:string)=>string}} o
   *   request: a sidecar request that converts local paths for the child (CloneService.request)
   */
  constructor(o = {}) {
    if (typeof o.request !== 'function') throw new TypeError('VoiceChain needs a sidecar request function');
    this.clone = o.clone || null;
    this.request = o.request;
    this.piper = o.piper && typeof o.piper.synthesize === 'function' ? o.piper : null;
    this.piperVoice = o.piperVoice || undefined;
    this.osRender = typeof o.osRender === 'function' ? o.osRender : null;
    this.tmpDir = o.tmpDir || null;
    this.useClone = Boolean(o.cloned && this.clone && typeof this.clone.speak === 'function');
    this.phrasePathFn = typeof o.phrasePath === 'function' ? o.phrasePath : null;
    this.cloneBroken = false;
    this.piperBroken = false;
    this.lastEngine = null;
    this._chain = Promise.resolve();
    this._tmp = [];
    this._cloneRenders = [];
  }

  /** The cloned voice is in use (the disclosure says "speaking in his voice" only then). */
  get cloned() {
    return this.useClone && !this.cloneBroken;
  }

  /** The canonical text of a known filler ("sure" → "Sure."), else the text. */
  canonical(text) {
    const n = normPhrase(text);
    return FILLERS.find((f) => normPhrase(f) === n) || text;
  }

  /** A pre-rendered WAV of this text in the cloned voice, or null. */
  cachedPhrase(text) {
    if (!this.cloned) return null;
    try {
      const engine = typeof this.clone.cloneConfig === 'function' ? this.clone.cloneConfig().engine : 'pocket';
      const fn = this.phrasePathFn || ((eng, t) => require('../voice/clone/profile').phrasePath(eng, t, { root: this.clone.root || undefined }));
      const f = fn(engine, this.canonical(text));
      return f && fs.existsSync(f) ? f : null;
    } catch {
      return null;
    }
  }

  _tmpFile(prefix) {
    const dir = this.tmpDir || path.join(require('../shared/paths').runDir(), 'voice-tmp');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, `call-${prefix}-${crypto.randomBytes(8).toString('hex')}.wav`);
    this._tmp.push(f);
    // Old renders have played long ago: keep the folder small during a long call.
    while (this._tmp.length > 60) this._rm(this._tmp.shift());
    return f;
  }

  _rm(f) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* gone */
    }
  }

  /**
   * Queue one utterance (in order with the earlier ones).
   * @returns {Promise<{engine:'clone'|'piper'|'os', cached?:boolean}>}
   */
  say(text, { utteranceId } = {}) {
    const run = this._chain.then(() => this._say(text, utteranceId));
    this._chain = run.catch(() => {});
    return run;
  }

  async _say(text, utteranceId) {
    if (this.cloned) {
      try {
        const cached = this.cachedPhrase(text);
        if (cached) await this.request('tts.say', { text, utteranceId, wav: cached });
        else await this.clone.speak(text, { utteranceId });
        this.lastEngine = 'clone';
        return { engine: 'clone', cached: Boolean(cached) };
      } catch (err) {
        if (isAudioDead(err)) throw err;
        this.cloneBroken = true;
        log.warn(`the cloned voice failed (${err && err.message}); using the next voice for this call`);
      }
    }
    if (this.piper && !this.piperBroken) {
      try {
        const out = this._tmpFile('piper');
        await this.piper.synthesize(text, { voice: this.piperVoice, outFile: out });
        await this.request('tts.say', { text, utteranceId, wav: out });
        this.lastEngine = 'piper';
        return { engine: 'piper' };
      } catch (err) {
        if (isAudioDead(err)) throw err;
        this.piperBroken = true;
        log.warn(`the Piper voice failed (${err && err.message}); using the OS voice for this call`);
      }
    }
    if (this.osRender && !this.osBroken) {
      const out = this._tmpFile('os');
      await this.osRender(text, out);
      await this.request('tts.say', { text, utteranceId, wav: out });
      this.lastEngine = 'os';
      return { engine: 'os' };
    }
    const e = new Error('No voice is available to speak in the call');
    e.code = 'NO_VOICE';
    throw e;
  }

  /**
   * Render text to a WAV without playing it (arm-time check that the greeting can be spoken).
   * @returns {Promise<{engine:string, file:string}>}
   */
  async render(text) {
    if (this.cloned && typeof this.clone.synthesize === 'function') {
      try {
        const r = await this.clone.synthesize(text);
        // A live render (not the phrase cache) is removed by cleanup() with this call's other renders.
        if (r && r.file && !r.cached) this._cloneRenders.push(r.file);
        return { engine: 'clone', file: r.file };
      } catch (err) {
        this.cloneBroken = true;
        log.warn(`the cloned voice cannot render the greeting (${err && err.message})`);
      }
    }
    if (this.piper && !this.piperBroken) {
      try {
        const out = this._tmpFile('piper');
        await this.piper.synthesize(text, { voice: this.piperVoice, outFile: out });
        return { engine: 'piper', file: out };
      } catch (err) {
        this.piperBroken = true;
        log.warn(`Piper cannot render the greeting (${err && err.message})`);
      }
    }
    if (this.osRender) {
      const out = this._tmpFile('os');
      await this.osRender(text, out);
      return { engine: 'os', file: out };
    }
    const e = new Error('No voice can speak the greeting');
    e.code = 'NO_VOICE';
    throw e;
  }

  /**
   * An utterance this voice queued did not play (the sidecar could not synthesize or play it):
   * use the next voice from now on (F3-SAFE-B1).
   * @param {'clone'|'piper'|'os'|null} engine
   */
  markBroken(engine) {
    if (engine === 'clone') this.cloneBroken = true;
    else if (engine === 'piper') this.piperBroken = true;
    else if (engine === 'os') this.osBroken = true;
  }

  /** Some voice is left to try. */
  hasVoice() {
    return this.cloned || Boolean(this.piper && !this.piperBroken) || Boolean(this.osRender && !this.osBroken);
  }

  /** Stop speaking now and drop the queue (≤ 100 ms in the sidecar). */
  async stop() {
    try {
      await this.request('tts.stop', {}, { timeoutMs: 3000 });
    } catch (err) {
      log.debug(`tts.stop failed: ${err && err.message}`);
    }
  }

  /** Delete this call's temporary renders (the cloned voice's too, F3-SAFE-A2). */
  cleanup() {
    for (const f of this._tmp.splice(0)) this._rm(f);
    for (const f of this._cloneRenders.splice(0)) {
      if (this.clone && typeof this.clone.discardRender === 'function' && this.clone.discardRender(f)) continue;
      this._rm(f);
    }
  }
}

// ------------------------------------------------------------------------------------------ call engine

/** The MCP tool names of the call role, as the engine sees them. */
function callToolIds(server = 'anywhere') {
  return policyMod.DAEMON_TOOLS.map((n) => `mcp__${server}__${n}`);
}

/**
 * Arguments of the dedicated call engine (§6.3): stream-json both ways, no built-in tools, only our MCP
 * server (strict), the replaced system prompt, every call_* tool pre-allowed and anything else sent to the
 * always-deny call_permission prompt tool, no session file and no user/project settings.
 */
function callEngineArgs({ model = 'haiku', mcpConfigPath, systemPromptPath, server = 'anywhere' } = {}) {
  if (!mcpConfigPath || !systemPromptPath) throw new TypeError('callEngineArgs needs mcpConfigPath and systemPromptPath');
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', String(model || 'haiku'),
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--system-prompt-file', systemPromptPath,
    '--permission-prompt-tool', `mcp__${server}__call_permission`,
    '--permission-mode', 'default',
    '--allowedTools', callToolIds(server).join(','),
    '--disallowedTools', 'mcp__plugin_anywhere_anywhere',
    '--no-session-persistence',
    '--setting-sources', '',
  ];
}

/**
 * Write the call engine's MCP config (our server with ANYWHERE_ROLE=call and this call's id) and system
 * prompt, 0600 in a private folder.
 * @returns {{dir:string, mcpConfigPath:string, systemPromptPath:string}}
 */
function writeCallRunFiles({ dir, callId, daemonUrl, token, prompt, env = process.env, serverScript } = {}) {
  if (!dir || !callId || !daemonUrl || !token) throw new TypeError('writeCallRunFiles needs dir, callId, daemonUrl and token');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* windows */
  }
  const serverEnv = { ANYWHERE_DAEMON_URL: daemonUrl, ANYWHERE_TOKEN: token, ANYWHERE_ROLE: 'call', ANYWHERE_CALL_ID: callId };
  for (const k of ['ANYWHERE_HOME', 'ANYWHERE_DEBUG', 'ANYWHERE_LOG_FILE']) if (env[k]) serverEnv[k] = env[k];
  const script = serverScript || path.join(__dirname, '..', 'mcp', 'server.js');
  const mcp = { mcpServers: { anywhere: { type: 'stdio', command: process.execPath, args: [script], env: serverEnv, alwaysLoad: true } } };
  const mcpConfigPath = path.join(dir, 'mcp.json');
  const systemPromptPath = path.join(dir, 'system-prompt.txt');
  const write = (f, data) => {
    fs.writeFileSync(f, data, { mode: 0o600 });
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      /* windows */
    }
  };
  write(mcpConfigPath, `${JSON.stringify(mcp, null, 2)}\n`);
  write(systemPromptPath, `${str(prompt)}\n`);
  return { dir, mcpConfigPath, systemPromptPath };
}

/**
 * A ClaudeCliEngine (process handling, interrupts, tree kill) with the call engine's own arguments.
 * Not started.
 * @param {{claudePath:string, cwd:string, model?:string, mcpConfigPath:string, systemPromptPath:string,
 *   Engine?:Function, baseEnv?:object}} o
 */
function createCallEngine(o = {}) {
  const Engine = o.Engine || require('../daemon/engine-cli').ClaudeCliEngine;
  const engine = new Engine({ claudePath: o.claudePath, cwd: o.cwd, baseEnv: o.baseEnv, env: { ANYWHERE_ENGINE_CHILD: null, ANYWHERE_ROLE: null, ANYWHERE_CALL_ID: null } });
  engine.args = callEngineArgs(o);
  return engine;
}

// ------------------------------------------------------------------------------------------ the session

class CallSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.id                        the call id (also the MCP server's ANYWHERE_CALL_ID)
   * @param {{displayName?:string}|string} [o.caller] the name from the call app (never from speech)
   * @param {string} [o.app]                     app id ('zoho-cliq'); appName: its display name
   * @param {object} [o.config]                  the live config (calls.*)
   * @param {object} o.sidecar                   {request(op, params, opts), on/removeListener('event'|'exit')}
   * @param {object} o.voice                     a VoiceChain (or {cloned, say(text,{utteranceId}), stop()})
   * @param {object} [o.engine]                  a started call engine (ClaudeCliEngine-like)
   * @param {()=>Promise<object>} [o.engineFactory] a started engine (first one when o.engine is missing, and one restart)
   * @param {(reason:string)=>Promise<any>} [o.hangUpCall] clicks End call in the call app
   * @param {()=>Promise<object>} [o.restartAudio] restarts the sidecar after a crash; resolves to the new sidecar
   * @param {object} [o.audioParams]             the sidecar's audio.start parameters (AudioBridge.startParams())
   * @param {object} [o.clock]
   * @param {object} [o.options]                 DEFAULTS overrides
   */
  constructor(o = {}) {
    super();
    if (!o.id) throw new TypeError('CallSession needs an id');
    if (!o.sidecar || typeof o.sidecar.request !== 'function') throw new TypeError('CallSession needs a sidecar');
    if (!o.voice || typeof o.voice.say !== 'function') throw new TypeError('CallSession needs a voice');
    this.id = String(o.id);
    const callerName = typeof o.caller === 'string' ? o.caller : o.caller && o.caller.displayName;
    this.caller = { displayName: oneLine(callerName) || null };
    this.app = o.app || null;
    this.appName = o.appName || o.app || null;
    this.configRef = o.config || {};
    this.sidecar = o.sidecar;
    this.voice = o.voice;
    this.engine = o.engine || null;
    this.engineFactory = typeof o.engineFactory === 'function' ? o.engineFactory : null;
    this.hangUpCall = typeof o.hangUpCall === 'function' ? o.hangUpCall : null;
    this.restartAudio = typeof o.restartAudio === 'function' ? o.restartAudio : null;
    this.audioParams = o.audioParams || null;
    this.clock = bindClock(o.clock);
    this.opts = { ...DEFAULTS, ...(o.options || {}) };
    this.ownerName = o.ownerName || '';
    this.ownerFirst = oneLine(o.ownerFirst).split(' ')[0] || oneLine(this.ownerName).split(' ')[0] || '';
    this.pronoun = o.pronoun || 'their';
    this.halfDuplex = Boolean(this.audioParams && this.audioParams.halfDuplex);
    this.saveTranscript = this.callsCfg().saveTranscript !== false;
    this.state = 'new';
    this.startedAt = null;
    this.endedAt = null;
    this.endReason = null;
    this._transcript = [];
    this._actions = [];
    this.utts = new Map(); // id -> {id, text, kind, turnId, started, ended, interrupted, playedChars, queuedAt}
    this.uttSeq = 0;
    this.held = []; // speech waiting for the disclosure (or for a barge-in to settle): [{text, kind, turnId}]
    this.disclosureSpoken = false;
    this.disclosureUtt = null; // id of the disclosure utterance in flight
    this.greeting = null;
    this.turn = null;
    this.turnSeq = 0;
    this.callerQueue = [];
    this.primed = false;
    this.pending = null; // {text, timer}: an utterance waiting for its continuation (ends in "and", "um" …)
    this.barge = null; // {at, ids:[], settleTimer, callerSpeaking}
    this.callerSpeaking = false;
    this.lastActivityAt = 0;
    this.askedStillThere = false;
    this.warned = false;
    this.endRequested = null;
    this.saidGoodbye = false;
    this.pendingNotes = [];
    this.engineRestarted = false;
    this.audioRestarted = false;
    this.ignoreResults = 0;
    this.speechFailures = 0;
    this._ending = null;
    this._stopped = false;
    this._timers = new Set();
    this._onSidecarEvent = (ev) => this._sidecarEvent(ev);
    this._onSidecarExit = (info) => this._sidecarExit(info);
    this._onEngineMessage = (msg) => this._engineMessage(msg);
    this._onEngineExit = (info) => this._engineExit(info);
  }

  callsCfg() {
    const c = typeof this.configRef === 'function' ? this.configRef() : this.configRef;
    return c && typeof c.calls === 'object' && c.calls ? c.calls : {};
  }

  now() {
    return this.clock.now();
  }

  _setTimer(fn, ms) {
    const t = unref(
      this.clock.setTimeout(() => {
        this._timers.delete(t);
        try {
          fn();
        } catch (err) {
          log.warn(`call timer failed: ${err && err.message}`);
        }
      }, ms)
    );
    this._timers.add(t);
    return t;
  }

  _clearTimer(t) {
    if (!t) return;
    this.clock.clearTimeout(t);
    this._timers.delete(t);
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emit('state', { callId: this.id, state });
  }

  _emit(name, payload) {
    try {
      this.emit(name, payload);
    } catch (err) {
      log.warn(`a '${name}' listener failed: ${err && err.message}`);
    }
  }

  get active() {
    return !this._stopped && this.state !== 'new';
  }

  // ------------------------------------------------------------------------------- lifecycle

  /**
   * Start the call: audio, greeting (disclosure first), engine priming, timers.
   */
  async start() {
    if (this.state !== 'new') return;
    this._setState('starting');
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
    this._subscribeSidecar(this.sidecar);
    if (this.audioParams) {
      try {
        await this.sidecar.request('audio.start', this.audioParams, { timeoutMs: 20000 });
      } catch (err) {
        log.error(`the call audio did not start: ${err && err.message}`);
        await this.hangup('audio_failed', { goodbye: false });
        throw err;
      }
    }
    const cfg = this.callsCfg();
    this.greeting = greetingMod.composeGreeting({
      callerName: this.caller.displayName,
      ownerName: this.ownerName,
      ownerFirst: this.ownerFirst,
      pronoun: this.pronoun,
      cloned: Boolean(this.voice.cloned),
      template: cfg.greeting || '',
    });
    if (this.greeting.templateRejected) log.warn(`the calls.greeting template was not used: ${this.greeting.templateRejected}`);
    this._setState('greeting');
    this._queueDisclosure(this.greeting.text, 'greeting');
    // The engine: prewarmed by the manager, else started now; primed while the greeting plays.
    try {
      if (!this.engine && this.engineFactory) this.engine = await this.engineFactory();
    } catch (err) {
      log.error(`the call engine could not start: ${err && err.message}`);
      this.engine = null;
    }
    if (this.engine) {
      this._attachEngine(this.engine);
      this._prime();
    } else {
      this._engineGone('the call engine could not start');
    }
    const maxMin = Number(cfg.maxCallMinutes) > 0 ? Number(cfg.maxCallMinutes) : 15;
    this.maxAt = this.startedAt + maxMin * 60000;
    this.warnAt = maxMin > 2 ? this.maxAt - this.opts.warnBeforeEndMs : Infinity;
    this._tick = unref(this.clock.setInterval(() => this._onTick(), this.opts.tickMs));
  }

  _subscribeSidecar(sc) {
    if (!sc || typeof sc.on !== 'function') return;
    sc.on('event', this._onSidecarEvent);
    sc.on('exit', this._onSidecarExit);
  }

  _unsubscribeSidecar(sc) {
    if (!sc || typeof sc.removeListener !== 'function') return;
    sc.removeListener('event', this._onSidecarEvent);
    sc.removeListener('exit', this._onSidecarExit);
  }

  _attachEngine(engine) {
    engine.on('message', this._onEngineMessage);
    engine.on('exit', this._onEngineExit);
  }

  _detachEngine(engine) {
    if (!engine || typeof engine.removeListener !== 'function') return;
    engine.removeListener('message', this._onEngineMessage);
    engine.removeListener('exit', this._onEngineExit);
  }

  // ------------------------------------------------------------------------------- speech out

  _newUtt(text, kind, turnId) {
    this.uttSeq += 1;
    const id = `${this.id.slice(0, 8)}-${this.uttSeq}`;
    const u = { id, text, kind, turnId: turnId || null, started: false, ended: false, interrupted: false, playedChars: 0, queuedAt: this.now() };
    this.utts.set(id, u);
    return u;
  }

  /** Send one utterance to the voice chain now (no gating). */
  _sendUtt(u) {
    u.engine = null;
    this.voice.say(u.text, { utteranceId: u.id, kind: u.kind }).then((r) => {
      if (r && r.engine) u.engine = r.engine;
    }).catch((err) => {
      log.warn(`speaking failed: ${err && err.message}`);
      this.speechFailures += 1;
      const dead = isAudioDead(err);
      // Several failures in a row (no playback device, every voice broken): the caller hears nothing.
      const mute = !dead && ((err && err.code === 'NO_VOICE') || this.speechFailures >= 3);
      if (mute) this.held = [];
      // fromSay: the whole voice chain failed (handled here: mute and hang up after repeated failures).
      this._uttEnded({ utteranceId: u.id, interrupted: true, started: false, playedChars: 0, error: { message: err && err.message }, fromSay: true });
      if (dead) this._sidecarExit({ error: err });
      else if (mute) this.hangup(err && err.code === 'NO_VOICE' ? 'no_voice' : 'audio_failed', { goodbye: false }).catch(() => {});
    });
    return u;
  }

  /** The greeting or a re-disclosure: played at once; nothing else is sent before one ends in full. */
  _queueDisclosure(text, kind) {
    const u = this._newUtt(text, kind, null);
    if (kind === 'greeting') {
      u.disclosureEnd = this.greeting ? this.greeting.disclosureEnd : text.length;
      u.disclosureStart = this.greeting ? this.greeting.disclosureStart : 0;
    } else {
      u.disclosureEnd = text.length;
      u.disclosureStart = 0;
    }
    this.disclosureUtt = u.id;
    return this._sendUtt(u);
  }

  /**
   * Speak text from code (filler, prompts, objection answer) or a reply clause. Waits for the disclosure
   * and for a barge-in to settle.
   * @param {string} text
   * @param {{kind?:string, turnId?:number|null, force?:boolean}} [o] force: skip the gates (goodbye)
   */
  _speak(text, { kind = 'system', turnId = null, force = false } = {}) {
    const t = policyMod.sanitizeSpeechText(text, { maxWords: 0 });
    if (!t || this._stopped) return null;
    if (force) return this._sendUtt(this._newUtt(t, kind, turnId));
    this.held.push({ text: t, kind, turnId });
    this._flushHeld();
    return true;
  }

  _flushHeld() {
    if (this._stopped || this._ending || !this.held.length) return;
    if (this.barge) return;
    if (!this.disclosureSpoken) {
      if (!this.disclosureUtt) this._queueDisclosure(greetingMod.redisclosure({ ownerName: this.ownerName, ownerFirst: this.ownerFirst, pronoun: this.pronoun, cloned: Boolean(this.voice.cloned) }), 'disclosure');
      return;
    }
    const items = this.held.splice(0);
    for (const it of items) {
      // A reply interrupted for real is dropped with its turn.
      if (it.turnId != null && this.turn && this.turn.id === it.turnId && this.turn.cancelled) continue;
      if (it.turnId != null && (!this.turn || this.turn.id !== it.turnId) && this._cancelledTurns && this._cancelledTurns.has(it.turnId)) continue;
      const u = this._sendUtt(this._newUtt(it.text, it.kind, it.turnId));
      if (it.kind === 'reply' && GOODBYE_RE.test(it.text)) this.saidGoodbye = true;
      if (u && it.kind !== 'still_there') this.lastActivityAt = this.now();
    }
  }

  /** Something is queued or playing. */
  speaking() {
    if (this.held.length) return true;
    const stall = this.opts.speechStallMs;
    const now = this.now();
    for (const u of this.utts.values()) if (!u.ended && now - u.queuedAt < stall) return true;
    return false;
  }

  _waitSpeechDone(timeoutMs) {
    return new Promise((resolve) => {
      if (!this.speaking()) return resolve(true);
      let timer = null;
      const check = () => {
        if (this.speaking()) return;
        this.removeListener('_utt_end', check);
        this._clearTimer(timer);
        resolve(true);
      };
      timer = this._setTimer(() => {
        this.removeListener('_utt_end', check);
        resolve(false);
      }, timeoutMs);
      this.on('_utt_end', check);
    });
  }

  // ------------------------------------------------------------------------------- sidecar events

  _sidecarEvent(ev) {
    if (!ev || typeof ev !== 'object' || this._stopped) return;
    switch (ev.event) {
      case 'playback.start': {
        const u = this.utts.get(ev.utteranceId);
        if (u) u.started = true;
        this.speechFailures = 0;
        this.lastActivityAt = Math.max(this.lastActivityAt, u && u.kind === 'still_there' ? 0 : this.now());
        return;
      }
      case 'playback.end':
        this._uttEnded(ev);
        return;
      case 'vad.start':
        this.callerSpeaking = true;
        this.lastActivityAt = this.now();
        this.askedStillThere = false;
        if (this.pending) this._clearTimer(this.pending.timer);
        if (this.barge) this._clearTimer(this.barge.settleTimer);
        return;
      case 'vad.end':
        this.callerSpeaking = false;
        this.lastActivityAt = this.now();
        if (this.barge) this._armBargeSettle();
        if (this.pending && !this.pending.timer) this._armPending();
        return;
      case 'barge_in':
        this._bargeIn(ev);
        return;
      case 'asr.final':
        this._asrFinal(ev);
        return;
      case 'audio.error':
        log.warn(`call audio: ${ev.code || ''} ${ev.message || ''}`);
        this._emit('warning', { callId: this.id, code: ev.code || 'AUDIO_ERROR', message: ev.message || 'audio error' });
        return;
      default:
    }
  }

  _uttEnded(ev) {
    const u = this.utts.get(ev.utteranceId);
    if (!u || u.ended) return;
    u.ended = true;
    if (ev.started === true) u.started = true;
    // F3-SAFE-B1: an utterance that failed (synthesis or the device: ev.error) or never started
    // (started:false) was not heard, whatever `interrupted` says; only one that started, ended without
    // an error and was not cut counts as played in full.
    const failed = Boolean(ev.error);
    const notStarted = !u.started && ev.started === false;
    const fullyPlayed = !ev.interrupted && !failed && !notStarted;
    u.failed = failed || notStarted;
    u.interrupted = !fullyPlayed;
    const chars = Number(ev.playedChars);
    u.playedChars = fullyPlayed ? u.text.length : notStarted ? 0 : Number.isFinite(chars) ? Math.max(0, Math.min(u.text.length, chars)) : 0;
    if (!u.interrupted && u.kind !== 'still_there') this.lastActivityAt = this.now();
    // What the caller heard goes to the transcript.
    if (u.started && u.playedChars > 0) {
      const heard = u.interrupted ? `${u.text.slice(0, u.playedChars).trim()}…` : u.text;
      this._addTranscript('assistant', heard, u.interrupted ? { interrupted: true } : {});
    }
    if (this.barge && u.interrupted) this.barge.ids.push(u.id);
    let disclosureFailed = false;
    if (u.id === this.disclosureUtt) {
      this.disclosureUtt = null;
      // Never from an utterance that failed: what the caller heard of it is not known.
      if (!u.failed && u.playedChars >= u.disclosureEnd) this.disclosureSpoken = true;
      else if (u.failed) disclosureFailed = true;
    }
    if ((u.kind === 'greeting' || u.kind === 'disclosure') && this.state === 'greeting') this._setState('active');
    // Keep the map small: forget ended utterances that no barge-in can still resume.
    if (!this.barge && this.utts.size > 200) {
      for (const [id, x] of this.utts) if (x.ended && this.utts.size > 100) this.utts.delete(id);
    }
    if (disclosureFailed && !ev.fromSay) this._disclosureFailed(u, ev);
    this._flushHeld();
    this.emit('_utt_end', u);
    this._maybeEnd();
  }

  /**
   * The greeting or a re-disclosure did not play (F3-SAFE-B1): the voice that failed is dropped, the
   * disclosure is said again with the next one (Piper, then the OS voice), and after repeated failures,
   * or with no voice left, the call is ended without another word.
   */
  _disclosureFailed(u, ev) {
    if (this._stopped || this._ending) return;
    this.disclosureFailures = (this.disclosureFailures || 0) + 1;
    const engine = u.engine || this.voice.lastEngine || null;
    if (typeof this.voice.markBroken === 'function') this.voice.markBroken(engine);
    const why = (ev && ev.error && (ev.error.message || ev.error.code)) || 'it did not start';
    log.warn(`the AI disclosure did not play (${engine || 'unknown voice'}: ${why}); attempt ${this.disclosureFailures}`);
    this._emit('warning', { callId: this.id, code: 'DISCLOSURE_FAILED', message: `The greeting did not play (${oneLine(why, 120)})` });
    const left = typeof this.voice.hasVoice === 'function' ? this.voice.hasVoice() : true;
    if (this.disclosureFailures >= this.opts.maxDisclosureFailures || !left) {
      this.held = [];
      this.hangup('disclosure_failed', { goodbye: false }).catch(() => {});
      return;
    }
    this._queueDisclosure(greetingMod.redisclosure({ ownerName: this.ownerName, ownerFirst: this.ownerFirst, pronoun: this.pronoun, cloned: Boolean(this.voice.cloned) }), 'disclosure');
  }

  // ------------------------------------------------------------------------------- barge-in (§6.5)

  _bargeIn(ev) {
    if (this.halfDuplex || this._stopped || this._ending) return;
    if (!this.barge) this.barge = { at: this.now(), ids: [], settleTimer: null };
    this.callerSpeaking = true;
    this.lastActivityAt = this.now();
    // The sidecar stopped playback itself (bargeIn.stopPlayback): its playback.end events follow.
    log.debug(`barge-in during ${ev && ev.utteranceId ? ev.utteranceId : 'playback'}`);
  }

  _armBargeSettle() {
    if (!this.barge) return;
    this._clearTimer(this.barge.settleTimer);
    this.barge.settleTimer = this._setTimer(() => this._settleBarge('noise'), this.opts.bargeSettleMs);
  }

  /**
   * End a barge-in. 'noise' and 'backchannel' resume what was cut; 'real' drops the rest of the reply.
   * @returns {string|null} for 'real': the part of the interrupted reply the caller heard
   */
  _settleBarge(kind) {
    const b = this.barge;
    if (!b) return null;
    this.barge = null;
    this._clearTimer(b.settleTimer);
    const cut = b.ids.map((id) => this.utts.get(id)).filter(Boolean);
    if (kind === 'real') {
      const turnIds = new Set(cut.map((u) => u.turnId).filter((x) => x != null));
      if (this.turn && this.turn.kind === 'caller') turnIds.add(this.turn.id);
      this._cancelledTurns = this._cancelledTurns || new Set();
      for (const id of turnIds) this._cancelledTurns.add(id);
      if (this.turn && turnIds.has(this.turn.id)) {
        this.turn.cancelled = true;
        if (!this.turn.done && this.engine && typeof this.engine.interrupt === 'function') this.engine.interrupt().catch(() => {});
      }
      this.held = this.held.filter((h) => h.turnId == null || !turnIds.has(h.turnId));
      // What the caller heard of the cut reply: its clauses played in full, then the part of the cut one.
      // (A cut disclosure is said again before the next reply anyway: disclosureSpoken stays false.)
      const heard = [...this.utts.values()]
        .filter((u) => u.kind === 'reply' && turnIds.has(u.turnId) && u.started && u.ended)
        .map((u) => (u.interrupted ? u.text.slice(0, u.playedChars) : u.text))
        .join(' ')
        .trim();
      for (const u of cut) this.utts.delete(u.id);
      this._flushHeld();
      return heard;
    }
    // Resume: what was cut is said again (a cut greeting from its disclosure on), before what waited.
    const again = [];
    for (const u of cut) {
      this.utts.delete(u.id);
      if (u.kind === 'disclosure' || u.kind === 'greeting') continue; // the disclosure gate re-queues it
      if (u.kind === 'still_there' || u.kind === 'filler') continue;
      again.push({ text: u.text, kind: u.kind, turnId: u.turnId });
    }
    const greetingCut = cut.find((u) => u.kind === 'greeting' && u.playedChars < u.disclosureEnd);
    if (greetingCut && this.greeting) {
      // "This is Deepanshu's AI assistant … How can I help?" — the greeting from its disclosure on.
      const rest = this.greeting.text.slice(this.greeting.disclosureStart);
      this._queueDisclosure(rest.charAt(0).toUpperCase() + rest.slice(1), 'disclosure');
    } else if (cut.find((u) => u.kind === 'greeting')) {
      // The disclosure was heard; the rest of the greeting ("How can I help?") is not needed again.
    }
    this.held = [...again, ...this.held];
    this._flushHeld();
    return null;
  }

  // ------------------------------------------------------------------------------- caller speech

  _asrFinal(ev) {
    const text = oneLine(ev && ev.text);
    this.callerSpeaking = false;
    if (!text || this._stopped) return;
    if (this.barge) {
      this._clearTimer(this.barge.settleTimer);
      if (BACKCHANNEL_RE.test(text) || policyMod.countWords(text) <= 1) {
        this._addTranscript('caller', text);
        this.lastActivityAt = this.now();
        this._settleBarge('backchannel');
        return;
      }
      const heard = this._settleBarge('real');
      this.handleUtterance(text, { heard }).catch((err) => log.warn(`handling the caller's words failed: ${err && err.message}`));
      return;
    }
    this.handleUtterance(text).catch((err) => log.warn(`handling the caller's words failed: ${err && err.message}`));
  }

  /**
   * One finished caller utterance (asr.final).
   * @param {string} text
   * @param {{heard?:string|null}} [o] heard: what the caller heard of an interrupted reply
   */
  async handleUtterance(text, { heard } = {}) {
    const t = oneLine(text);
    if (!t || this._stopped || this._ending) return;
    this.lastActivityAt = this.now();
    this.askedStillThere = false;
    this._addTranscript('caller', t);
    if (OBJECTION_RE.test(t) && this.saveTranscript) {
      this.stopTranscript('the caller objected');
      this._speak(greetingMod.transcriptStoppedText(), { kind: 'system' });
      this.pendingNotes.push('The caller asked not to be transcribed: the transcript is no longer saved; continue the conversation normally');
    }
    // End of turn: wait a little when the caller trails off ("so, um …").
    if (this.pending) {
      this._clearTimer(this.pending.timer);
      this.pending.text = `${this.pending.text} ${t}`;
      if (heard != null) this.pending.heard = heard;
    } else {
      this.pending = { text: t, heard: heard != null ? heard : null, timer: null };
    }
    if (CONJ_END_RE.test(t)) {
      if (!this.callerSpeaking) this._armPending();
      return;
    }
    this._submitPending();
  }

  _armPending() {
    if (!this.pending) return;
    this._clearTimer(this.pending.timer);
    this.pending.timer = this._setTimer(() => this._submitPending(), this.opts.conjunctionWaitMs);
  }

  _submitPending() {
    const p = this.pending;
    if (!p) return;
    this._clearTimer(p.timer);
    this.pending = null;
    this.callerQueue.push({ text: p.text, heard: p.heard });
    this._pump();
  }

  /** Send queued caller words when the engine is free. */
  _pump() {
    if (this._stopped || this._ending || !this.callerQueue.length) return;
    if (!this.primed || this.turn || !this.engine) return;
    const items = this.callerQueue.splice(0);
    const text = items.map((i) => i.text).join(' ');
    const heardItem = items.find((i) => i.heard != null);
    this._callerTurn(text, heardItem ? heardItem.heard : null);
  }

  _callerTurn(text, heard) {
    const notes = this.pendingNotes.splice(0);
    const msg = promptMod.callerTurnMessage(text, { heard, notes });
    const turn = this._startTurn('caller', msg);
    if (!turn) return;
    // No "one moment" before a goodbye or a plain thank-you: the reply is short anyway.
    if (GOODBYE_RE.test(text) || /^(?:ok(?:ay)?[,.!]?\s*)?(?:thanks?|thank you)(?: (?:so|very) much)?[.!]*$/i.test(text.trim())) return;
    turn.fillerTimer = this._setTimer(() => {
      if (this.turn === turn && !turn.spoke && !turn.cancelled && !turn.done) {
        turn.spoke = true;
        this._speak(FILLER, { kind: 'filler', turnId: turn.id });
      }
    }, this.opts.fillerAfterMs);
  }

  // ------------------------------------------------------------------------------- engine turns

  _startTurn(kind, text) {
    if (!this.engine) return null;
    this.turnSeq += 1;
    const turn = { id: this.turnSeq, kind, startedAt: this.now(), text: '', words: 0, spoke: false, truncated: false, cancelled: false, done: false, deltaMsgs: new Set(), msgId: null, splitter: new ClauseSplitter(), resolve: null, result: null };
    turn.promise = new Promise((resolve) => {
      turn.resolve = resolve;
    });
    this.turn = turn;
    try {
      this.engine.send(text);
    } catch (err) {
      log.warn(`the call engine did not take the message: ${err && err.message}`);
      this._finishTurn(turn, { error: err && err.message });
      this._engineGone('the call engine stopped');
      return null;
    }
    return turn;
  }

  _finishTurn(turn, result) {
    if (!turn || turn.done) return;
    turn.done = true;
    turn.result = result || null;
    this._clearTimer(turn.fillerTimer);
    if (turn.kind === 'caller' && !turn.cancelled) {
      const rest = turn.splitter.flush();
      if (rest) this._replyClause(turn, rest);
    }
    if (this.turn === turn) this.turn = null;
    this.lastActivityAt = this.now();
    turn.resolve(result || null);
    this._pump();
    this._maybeEnd();
  }

  /**
   * One clause of a reply, within the word limit (§6.4: 40 words). The limit ends a reply at a clause
   * boundary: a short clause that finishes the sentence may run a few words over, a longer one is dropped,
   * and only a single over-long first clause is cut mid-way.
   */
  _replyClause(turn, clause) {
    if (turn.cancelled || turn.truncated || this._stopped) return;
    // After call_end, a model that repeats its goodbye once the tool returned is not heard twice.
    if (this.endRequested && this.saidGoodbye) return;
    let c = policyMod.sanitizeSpeechText(clause, { maxWords: 0 });
    if (!c) return;
    const n = policyMod.countWords(c);
    const max = this.opts.maxReplyWords;
    if (turn.words + n > max) {
      turn.truncated = true;
      const finishesSentence = /[.!?…]["'”’)]*$/.test(c);
      if (turn.words > 0 && !(finishesSentence && turn.words + n <= max + REPLY_GRACE_WORDS)) return;
      if (turn.words === 0) c = policyMod.sanitizeSpeechText(c, { maxWords: max });
    }
    turn.words += n;
    turn.spoke = true;
    this._speak(c, { kind: 'reply', turnId: turn.id });
  }

  _onText(text, msgId) {
    const turn = this.turn;
    if (!turn) return;
    turn.text += text;
    if (msgId) turn.deltaMsgs.add(msgId);
    if (turn.kind !== 'caller' || turn.cancelled) return;
    for (const clause of turn.splitter.push(text)) this._replyClause(turn, clause);
  }

  _engineMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this.ignoreResults > 0) {
      // Output of a turn given up on (priming or summary timeout) comes before the next turn's.
      if (msg.type === 'result') this.ignoreResults -= 1;
      return;
    }
    const turn = this.turn;
    if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
      const e = msg.event || {};
      if (e.type === 'message_start' && e.message && turn) {
        const id = e.message.id || null;
        // A new model message within the turn (after a tool result) is a new reply with its own 40 words:
        // "Sure, let me check" said before the tools ran must not crowd out the answer or its closing question.
        if (turn.msgId && id && id !== turn.msgId) {
          turn.words = 0;
          turn.truncated = false;
        }
        turn.msgId = id;
      } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && turn) this._onText(str(e.delta.text), turn.msgId);
      else if (e.type === 'content_block_stop' && turn && turn.kind === 'caller' && !turn.cancelled) {
        // "Sure, let me check" before a tool call: say it now, not after the tools ran.
        const rest = turn.splitter.flush();
        if (rest) this._replyClause(turn, rest);
      }
      return;
    }
    if (msg.type === 'assistant' && !msg.parent_tool_use_id && msg.message && turn) {
      const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
      // Without partial messages the whole text comes here once.
      const id = msg.message.id || null;
      if (!id || !turn.deltaMsgs.has(id)) {
        const text = blocks
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text)
          .join(' ');
        if (text) {
          this._onText(`${text} `, null);
          if (turn.kind === 'caller' && !turn.cancelled) {
            const rest = turn.splitter.flush();
            if (rest) this._replyClause(turn, rest);
          }
        }
      }
      if (blocks.some((b) => b && b.type === 'tool_use')) this.lastActivityAt = this.now();
      return;
    }
    if (msg.type === 'result' && turn) {
      this._finishTurn(turn, { text: typeof msg.result === 'string' ? msg.result : turn.text, isError: Boolean(msg.is_error), subtype: msg.subtype || null });
    }
  }

  _prime() {
    const turn = this._startTurn('prime', promptMod.primingMessage({ caller: this.caller.displayName, app: this.appName }));
    if (!turn) return;
    const timer = this._setTimer(() => {
      if (!this.primed && !turn.done) {
        log.warn('the call engine did not answer the priming turn in time');
        this._abandonTurn(turn);
      }
    }, this.opts.primeTimeoutMs);
    turn.promise.then(() => {
      this._clearTimer(timer);
      this.primed = true;
      this._pump();
    });
  }

  /** Give up on a running turn: its output is skipped when it comes. */
  _abandonTurn(turn) {
    if (!turn || turn.done) return;
    turn.cancelled = true;
    this.ignoreResults += 1;
    this._finishTurn(turn, null);
  }

  _engineExit(info) {
    if (this._stopped || this._closing) return;
    log.warn(`the call engine exited during the call (code ${info && info.code})`);
    const turn = this.turn;
    this.ignoreResults = 0;
    if (turn) this._finishTurn(turn, { error: 'engine exited' });
    this._detachEngine(this.engine);
    this.engine = null;
    if (this.engineFactory && !this.engineRestarted) {
      this.engineRestarted = true;
      this.primed = false;
      this.engineFactory()
        .then((eng) => {
          if (this._stopped) {
            if (eng && typeof eng.stop === 'function') eng.stop().catch(() => {});
            return;
          }
          this.engine = eng;
          this._attachEngine(eng);
          const recap = this._transcript
            .slice(-6)
            .map((t) => `${t.role === 'caller' ? 'Caller' : 'You'}: ${t.text}`)
            .join(' / ');
          const t2 = this._startTurn('prime', `${promptMod.primingMessage({ caller: this.caller.displayName, app: this.appName })}\n[You were restarted mid-call. The conversation so far: ${oneLine(recap).slice(0, 1500) || 'nothing yet'}]`);
          if (t2) {
            t2.promise.then(() => {
              this.primed = true;
              this._pump();
            });
          }
        })
        .catch((err) => this._engineGone(`the call engine could not restart: ${err && err.message}`));
      return;
    }
    this._engineGone('the call engine stopped');
  }

  _engineGone(why) {
    if (this._stopped || this._ending) return;
    log.error(`call ${this.id}: ${why}`);
    this._emit('warning', { callId: this.id, code: 'ENGINE_FAILED', message: why });
    const first = this.ownerFirst || 'the owner';
    this.hangup('engine_failed', { text: `Sorry, I'm having trouble on my end. ${first} will get back to you. Bye!` }).catch(() => {});
  }

  // ------------------------------------------------------------------------------- sidecar crash

  _sidecarExit(info) {
    if (this._stopped || this._ending || this._restartingAudio) return;
    log.warn(`the voice sidecar stopped during the call${info && info.code != null ? ` (code ${info.code})` : ''}`);
    this._unsubscribeSidecar(this.sidecar);
    for (const u of this.utts.values()) if (!u.ended) this._uttEnded({ utteranceId: u.id, interrupted: true, started: u.started, playedChars: 0 });
    if (!this.restartAudio || this.audioRestarted) {
      this.hangup('audio_failed', { goodbye: false }).catch(() => {});
      return;
    }
    this.audioRestarted = true;
    this._restartingAudio = true;
    this.restartAudio()
      .then(async (sc) => {
        this._restartingAudio = false;
        if (this._stopped) return;
        if (sc && typeof sc.request === 'function') this.sidecar = sc;
        this._subscribeSidecar(this.sidecar);
        if (this.audioParams) await this.sidecar.request('audio.start', this.audioParams, { timeoutMs: 20000 });
        this._flushHeld();
      })
      .catch((err) => {
        this._restartingAudio = false;
        log.error(`restarting the call audio failed: ${err && err.message}`);
        this.hangup('audio_failed', { goodbye: false }).catch(() => {});
      });
  }

  // ------------------------------------------------------------------------------- timers

  _onTick() {
    if (this._stopped || this._ending) return;
    const now = this.now();
    if (now >= this.maxAt) {
      const first = this.ownerFirst || 'the owner';
      this.hangup('max_duration', { text: `I'm sorry, I need to end the call now. ${first} will follow up. Bye!` }).catch(() => {});
      return;
    }
    if (!this.warned && now >= this.warnAt) {
      this.warned = true;
      this.pendingNotes.push('About 1 minute is left in this call: start wrapping up');
      if (!this.turn && !this.speaking()) this._speak("Just so you know, I'll need to wrap up in about a minute.", { kind: 'system' });
    }
    this._maybeEnd();
    const idle = this.state === 'active' && !this.turn && !this.speaking() && !this.callerSpeaking && !this.pending && !this.barge && !this.callerQueue.length;
    if (!idle) return;
    const silent = now - this.lastActivityAt;
    if (silent >= this.opts.silenceHangupMs) {
      this.hangup('silence', { text: SILENCE_GOODBYE }).catch(() => {});
    } else if (silent >= this.opts.stillThereMs && !this.askedStillThere) {
      this.askedStillThere = true;
      this._speak(STILL_THERE, { kind: 'still_there' });
    }
  }

  // ------------------------------------------------------------------------------- ending

  /** call_end: hang up once the current reply has been said (a goodbye is added when it had none). */
  requestEnd(reason = 'assistant_ended') {
    if (this._stopped || this._ending) return false;
    this.endRequested = oneLine(reason) || 'assistant_ended';
    this._maybeEnd();
    return true;
  }

  _maybeEnd() {
    if (!this.endRequested || this._stopped || this._ending) return;
    if (this.turn || this.speaking() || this.barge) return;
    this.hangup(this.endRequested, { goodbye: !this.saidGoodbye }).catch(() => {});
  }

  /**
   * End the call: goodbye (unless the caller already hung up), click End call, stop audio and engine turn.
   * @param {string} reason
   * @param {{goodbye?:boolean, text?:string}} [o]
   */
  hangup(reason = 'hangup', { goodbye = true, text } = {}) {
    // The call app shows the call ended (perhaps while our own goodbye is under way): no End call click then.
    if (reason === 'caller_hung_up' || reason === 'call_ended') this.callerGone = true;
    if (this._ending) return this._ending;
    if (this._stopped) return Promise.resolve();
    this._ending = (async () => {
      this._setState('ending');
      this.held = [];
      if (this.pending) this._clearTimer(this.pending.timer);
      this.pending = null;
      this.callerQueue = [];
      if (this.barge) {
        this._clearTimer(this.barge.settleTimer);
        this.barge = null;
      }
      const turn = this.turn;
      if (turn && !turn.done) {
        turn.cancelled = true;
        if (this.engine && typeof this.engine.interrupt === 'function') {
          await Promise.race([this.engine.interrupt().catch(() => {}), new Promise((r) => this._setTimer(r, 3000))]);
        }
      }
      const callerGone = reason === 'caller_hung_up' || reason === 'call_ended';
      const mute = reason === 'audio_failed' || reason === 'no_voice' || reason === 'disclosure_failed';
      if (!callerGone) {
        if (mute) {
          this.held = [];
        } else {
          if (goodbye) {
            this.held = [];
            const u = this._speak(text || GOODBYE, { kind: 'goodbye', force: true });
            if (u) this.saidGoodbye = true;
          }
          await this._waitSpeechDone(this.opts.goodbyeTimeoutMs);
        }
        if (this.hangUpCall && !this.callerGone) {
          try {
            await this.hangUpCall(reason);
          } catch (err) {
            log.warn(`hanging up in the call app failed: ${err && err.message}`);
            this._emit('warning', { callId: this.id, code: 'HANGUP_FAILED', message: err && err.message });
          }
        }
      }
      await this._stop(reason);
    })();
    return this._ending;
  }

  /** Take over: our audio stops at once; the call goes on with the user (the manager restores the mic). */
  async takeover() {
    if (this._stopped) return;
    await this._stop('takeover');
  }

  async _stop(reason) {
    if (this._stopped) return;
    this._stopped = true;
    this.endReason = reason;
    this.endedAt = this.now();
    if (this._tick) this.clock.clearInterval(this._tick);
    this._tick = null;
    for (const t of [...this._timers]) this._clearTimer(t);
    if (this.turn && !this.turn.done) {
      this.turn.cancelled = true;
      if (this.engine && typeof this.engine.interrupt === 'function') this.engine.interrupt().catch(() => {});
    }
    this.held = [];
    try {
      await this.voice.stop();
    } catch {
      /* ignore */
    }
    try {
      await this.sidecar.request('audio.stop', {}, { timeoutMs: 5000 });
    } catch (err) {
      log.debug(`audio.stop failed: ${err && err.message}`);
    }
    this._unsubscribeSidecar(this.sidecar);
    this._setState('ended');
    this._emit('ended', { callId: this.id, reason, at: this.endedAt });
  }

  /**
   * The final summary turn (§8.3): JSON {summary, followUps, topics}; a transcript-only summary when the
   * engine cannot give one.
   * @returns {Promise<{summary:string, followUps:string[], topics:string[], source:'engine'|'transcript'}>}
   */
  async summarize() {
    // F3-SAFE-E1: after the caller objected to the transcription, the engine (whose context still holds
    // the conversation) is not asked: the notes keep only what was done, from the action log.
    if (!this.saveTranscript) return { ...this.actionOnlySummary(), source: 'actions' };
    const fallback = () => ({ ...this.fallbackSummary(), source: 'transcript' });
    if (!this.engine || this.engine.running === false) return fallback();
    if (this.turn && !this.turn.done) {
      await Promise.race([this.turn.promise, new Promise((r) => this._setTimerRaw(r, 5000))]);
      if (this.turn && !this.turn.done) return fallback();
    }
    this._closingSummary = true;
    const turn = this._startTurn('summary', promptMod.summaryRequest());
    if (!turn) return fallback();
    const result = await Promise.race([turn.promise, new Promise((r) => this._setTimerRaw(() => r(null), this.opts.summaryTimeoutMs))]);
    if (!turn.done) this._abandonTurn(turn);
    const parsed = promptMod.parseSummary((result && result.text) || turn.text);
    return parsed ? { ...parsed, source: 'engine' } : fallback();
  }

  _setTimerRaw(fn, ms) {
    return unref(this.clock.setTimeout(fn, ms));
  }

  /**
   * The summary of a call that is not transcribed: no words of the caller, no topics, only the actions
   * and the requests deferred to the owner, as the daemon logged them.
   */
  actionOnlySummary() {
    const who = this.caller.displayName || 'The caller';
    const done = this._actions.filter((a) => a.ok !== false && a.summary && a.name !== 'call_defer' && a.name !== 'call_note').map((a) => oneLine(a.summary));
    const followUps = this._actions
      .filter((a) => a.name === 'call_defer' && a.args && a.args.request)
      .map((a) => oneLine(a.args.request).slice(0, 300))
      .filter(Boolean);
    const parts = [`${who} asked not to be transcribed, so only what was done is kept.`];
    parts.push(done.length ? `Done: ${done.join('; ')}.` : 'Nothing was done during the call.');
    return { summary: parts.join(' '), followUps: [...new Set(followUps)], topics: [] };
  }

  /** A summary written from the transcript and the action log only. */
  fallbackSummary() {
    const who = this.caller.displayName || 'The caller';
    const said = this._transcript.filter((t) => t.role === 'caller').map((t) => t.text);
    const done = this._actions.filter((a) => a.ok !== false && a.summary).map((a) => a.summary);
    const parts = [];
    if (said.length) parts.push(`${who} said: "${oneLine(said.slice(0, 3).join(' ')).slice(0, 300)}".`);
    else if (!this.saveTranscript) parts.push(`${who} asked not to be transcribed.`);
    else parts.push(`${who} called; nothing was transcribed.`);
    if (done.length) parts.push(`Done: ${done.join('; ')}.`);
    return { summary: parts.join(' '), followUps: [], topics: [] };
  }

  /** Stop the engine (after summarize()). */
  async close() {
    this._closing = true;
    const eng = this.engine;
    this._detachEngine(eng);
    this.engine = null;
    if (eng && typeof eng.stop === 'function') {
      try {
        await eng.stop();
      } catch (err) {
        log.debug(`stopping the call engine failed: ${err && err.message}`);
      }
    }
    if (typeof this.voice.cleanup === 'function') this.voice.cleanup();
  }

  // ------------------------------------------------------------------------------- transcript, actions

  _addTranscript(role, text, extra = {}) {
    if (!this.saveTranscript) return;
    const item = { role, text: oneLine(text), ts: new Date(this.now()).toISOString(), ...extra };
    if (!item.text) return;
    this._transcript.push(item);
    this._emit('transcript', { callId: this.id, ...item });
  }

  /** The caller objected (or the user turned it off): forget the transcript and stop saving it. */
  stopTranscript(why = '') {
    if (!this.saveTranscript) return;
    this.saveTranscript = false;
    this._transcript = [];
    log.info(`call ${this.id}: the transcript is no longer saved${why ? ` (${why})` : ''}`);
    this._emit('transcript_stopped', { callId: this.id, why });
  }

  /** Record a daemon-side action (from the action log, not from the model's claims). */
  recordAction(a = {}) {
    const item = { ts: new Date(this.now()).toISOString(), name: str(a.name), summary: oneLine(a.summary), ok: a.ok !== false };
    for (const k of ['key', 'url', 'detail', 'deferred', 'args', 'result', 'status', 'error', 'reason', 'via']) if (a[k] != null) item[k] = a[k];
    this._actions.push(item);
    this.lastActivityAt = this.now();
    this._emit('action', { callId: this.id, ...item });
    return item;
  }

  /** Mark activity (a tool call is running). */
  noteActivity() {
    this.lastActivityAt = this.now();
  }

  /** Say a fixed sentence from code (after the disclosure). */
  say(text, kind = 'system') {
    return Boolean(this._speak(text, { kind }));
  }

  transcript() {
    return this._transcript.map((t) => ({ ...t }));
  }

  actions() {
    return this._actions.map((a) => ({ ...a }));
  }

  status() {
    return {
      id: this.id,
      state: this.state,
      caller: this.caller.displayName,
      app: this.app,
      appName: this.appName,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      endedAt: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      endReason: this.endReason,
      cloned: Boolean(this.voice.cloned),
      disclosureSpoken: this.disclosureSpoken,
      saveTranscript: this.saveTranscript,
      transcriptLines: this._transcript.length,
      actions: this._actions.length,
      halfDuplex: this.halfDuplex,
    };
  }
}

module.exports = {
  CallSession,
  ClauseSplitter,
  VoiceChain,
  createCallEngine,
  callEngineArgs,
  callToolIds,
  writeCallRunFiles,
  DEFAULTS,
  FILLER,
  FILLERS,
  GOODBYE,
  STILL_THERE,
  SILENCE_GOODBYE,
  BACKCHANNEL_RE,
  CONJ_END_RE,
  OBJECTION_RE,
  GOODBYE_RE,
};
