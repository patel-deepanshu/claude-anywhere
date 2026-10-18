'use strict';

/**
 * QuestionBroker: Claude's `ask_user` tool lands here. Each question becomes a
 * card in the dialog (SSE `question`), and the HTTP long-poll that asked it is
 * resolved when the user answers (`answer`), the timeout expires, the caller
 * disconnects (AbortSignal) or everything is cancelled (interrupt/shutdown).
 */

const { EventEmitter } = require('events');
const { uuid, truncate, nowIso } = require('../shared/util');
const { createLogger, audit } = require('../shared/log');

const log = createLogger('questions');

const DEFAULT_TIMEOUT_SEC = 900;
const MAX_TIMEOUT_SEC = 24 * 3600;
const MAX_OPTIONS = 12;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Validate and normalize ask() input.
 * @returns {{question:string, options:string[], timeoutSec:number}}
 */
function normalizeAsk({ question, options, timeoutSec } = {}) {
  if (typeof question !== 'string' || !question.trim()) throw badRequest('question must be a non-empty string');
  let opts = [];
  if (options != null) {
    if (!Array.isArray(options)) throw badRequest('options must be an array of strings');
    opts = options
      .filter((o) => o != null && String(o).trim())
      .map((o) => truncate(String(o).trim(), 200))
      .slice(0, MAX_OPTIONS);
  }
  let t = Number(timeoutSec);
  if (!Number.isFinite(t) || t <= 0) t = DEFAULT_TIMEOUT_SEC;
  t = Math.min(Math.max(0.01, t), MAX_TIMEOUT_SEC);
  return { question: truncate(question.trim(), 4000), options: [...new Set(opts)], timeoutSec: t };
}

class QuestionBroker extends EventEmitter {
  /**
   * @param {{hub?:{broadcast:Function}, onNeedAttention?:(info:object)=>void}} [opts]
   */
  constructor({ hub, onNeedAttention } = {}) {
    super();
    this.hub = hub || null;
    this.onNeedAttention = typeof onNeedAttention === 'function' ? onNeedAttention : null;
    /** @type {Map<string, {card:object, settle:Function, timer:NodeJS.Timeout, cleanup:Function}>} */
    this.entries = new Map();
  }

  /** @private */
  broadcast(type, data) {
    if (!this.hub) return;
    try {
      this.hub.broadcast(type, data);
    } catch (err) {
      log.error(`broadcast ${type} failed:`, err);
    }
  }

  /**
   * Show a question card and wait for the user.
   * @param {{question:string, options?:string[], timeoutSec?:number, signal?:AbortSignal}} params
   * @returns {Promise<{id:string, answer:string}|{id:string, timeout:true}|{id:string, cancelled:true, reason:string}>}
   */
  ask(params = {}) {
    let norm;
    try {
      norm = normalizeAsk(params);
    } catch (err) {
      return Promise.reject(err);
    }
    const { signal } = params;
    const id = `q_${uuid()}`;
    const card = { id, question: norm.question, options: norm.options, ts: nowIso(), timeoutSec: norm.timeoutSec };
    if (signal && signal.aborted) {
      return Promise.resolve({ id, cancelled: true, reason: 'The request was cancelled before the question was shown' });
    }
    return new Promise((resolve) => {
      let onAbort = null;
      const cleanup = () => {
        clearTimeout(entry.timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      const settle = (outcome, resolvedEvent) => {
        if (!this.entries.has(id)) return false;
        this.entries.delete(id);
        cleanup();
        this.broadcast('question_resolved', { id, ...resolvedEvent });
        this.emit('resolved', { id, ...resolvedEvent });
        audit({ type: 'question_resolved', id, question: card.question, ...resolvedEvent });
        resolve({ id, ...outcome });
        return true;
      };
      const entry = {
        card,
        settle,
        cleanup,
        timer: setTimeout(() => {
          log.info(`question ${id} timed out after ${norm.timeoutSec}s`);
          settle({ timeout: true }, { answer: null, timeout: true });
        }, norm.timeoutSec * 1000),
      };
      this.entries.set(id, entry);
      if (signal) {
        onAbort = () => settle(
          { cancelled: true, reason: 'The caller disconnected' },
          { answer: null, cancelled: true, reason: 'The caller disconnected' }
        );
        signal.addEventListener('abort', onAbort, { once: true });
      }
      audit({ type: 'question', id, question: card.question, options: card.options });
      this.broadcast('question', { id, question: card.question, options: card.options, ts: card.ts });
      this.emit('question', card);
      if (this.onNeedAttention) {
        try {
          // The question and its options, so a voice user hears what is asked (HEADLINE-SCENARIO-12).
          this.onNeedAttention({ kind: 'question', id, summary: card.question, question: card.question, options: card.options.slice() });
        } catch (err) {
          log.warn('onNeedAttention failed:', err && err.message);
        }
      }
    });
  }

  /**
   * Answer a pending question.
   * @param {string} id
   * @param {string} text
   * @returns {boolean} false when no such pending question
   */
  answer(id, text) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const answer = text == null ? '' : truncate(String(text), 20000);
    return entry.settle({ answer }, { answer });
  }

  /**
   * Cancel one pending question.
   * @param {string} id
   * @param {string} [reason]
   * @returns {boolean}
   */
  cancel(id, reason = 'Cancelled') {
    const entry = this.entries.get(id);
    if (!entry) return false;
    return entry.settle({ cancelled: true, reason }, { answer: null, cancelled: true, reason });
  }

  /** Cancel every pending question (interrupt, mode switch, shutdown). */
  cancelAll(reason = 'Cancelled') {
    for (const id of [...this.entries.keys()]) this.cancel(id, reason);
  }

  /** @returns {{id:string, question:string, options:string[], ts:string}[]} */
  pending() {
    return [...this.entries.values()].map(({ card }) => ({
      id: card.id,
      question: card.question,
      options: card.options,
      ts: card.ts,
    }));
  }
}

module.exports = { QuestionBroker, normalizeAsk };
