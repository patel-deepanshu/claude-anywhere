'use strict';

/**
 * Bridge: in bridge mode the dialog's commands are queued here for the
 * interactive Claude Code session that ran `/anywhere here`. That session
 * long-polls `anywhere listen` (→ next()) and answers with `anywhere reply`
 * (→ reply()).
 *
 * Events (EventEmitter):
 *   'enqueued' (cmd), 'dequeued' (cmd), 'requeued' (cmd),
 *   'reply' ({text, final, speak, commandId}), 'listening' (bool), 'stop'.
 * Hub broadcasts: `bridge` {listening, queued} whenever listening changes.
 */

const { EventEmitter } = require('events');
const { uuid, nowIso, truncate } = require('../shared/util');
const { createLogger } = require('../shared/log');

const log = createLogger('bridge');

const LISTEN_GRACE_MS = 20000;
const MAX_QUEUE = 100;

class Bridge extends EventEmitter {
  /**
   * @param {{hub?:{broadcast:Function}, listenGraceMs?:number}} [opts]
   */
  constructor({ hub, listenGraceMs = LISTEN_GRACE_MS } = {}) {
    super();
    this.hub = hub || null;
    this.listenGraceMs = listenGraceMs;
    /** @type {object[]} */
    this.queue = [];
    /** @type {Set<{resolve:Function, timer:NodeJS.Timeout, cleanup:Function}>} */
    this.waiters = new Set();
    this.lastPollAt = 0;
    this.stopped = false;
    this.current = null; // the command the terminal is working on
    this.graceTimer = null;
    this.lastListening = false;
  }

  /** True while a listen poll is active or one happened in the last 20 s. */
  get listening() {
    if (this.stopped) return false;
    if (this.waiters.size > 0) return true;
    return this.lastPollAt > 0 && Date.now() - this.lastPollAt < this.listenGraceMs;
  }

  /** @returns {number} queued commands */
  queueLength() {
    return this.queue.length;
  }

  /** @private */
  updateListening() {
    const now = this.listening;
    if (now !== this.lastListening) {
      this.lastListening = now;
      if (this.hub) {
        try {
          this.hub.broadcast('bridge', { listening: now, queued: this.queue.length });
        } catch (err) {
          log.error('broadcast failed:', err);
        }
      }
      this.emit('listening', now);
    }
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (now && this.waiters.size === 0 && this.lastPollAt) {
      const remaining = this.listenGraceMs - (Date.now() - this.lastPollAt);
      this.graceTimer = setTimeout(() => this.updateListening(), Math.max(10, remaining + 5));
      if (this.graceTimer.unref) this.graceTimer.unref();
    }
  }

  /**
   * Queue a command for the terminal session.
   * @param {{id?:string, text:string, images?:string[], context?:string, source?:string}} cmd
   * @param {{front?:boolean}} [opts]
   * @returns {object} the queued command (with id and ts)
   */
  enqueue(cmd, { front = false } = {}) {
    const item = {
      id: (cmd && cmd.id) || uuid(),
      text: truncate(String((cmd && cmd.text) || ''), 100000),
      images: Array.isArray(cmd && cmd.images) ? cmd.images.slice() : [],
      context: (cmd && cmd.context) || '',
      source: (cmd && cmd.source) || 'text',
      ts: (cmd && cmd.ts) || nowIso(),
    };
    // Hand straight to a waiting poll when there is one.
    const waiter = this.waiters.values().next().value;
    if (waiter) {
      waiter.deliver(item);
      return item;
    }
    if (front) this.queue.unshift(item);
    else this.queue.push(item);
    while (this.queue.length > MAX_QUEUE) {
      const dropped = this.queue.shift();
      log.warn(`bridge queue full; dropped command ${dropped.id}`);
    }
    this.emit('enqueued', item);
    return item;
  }

  /**
   * Put a command back at the front of the queue (its listen response never
   * reached the terminal).
   * @param {object} cmd
   */
  requeue(cmd) {
    if (!cmd) return;
    if (this.current && this.current.id === cmd.id) this.current = null;
    log.info(`re-queueing bridge command ${cmd.id}: the listener disconnected before receiving it`);
    this.emit('requeued', cmd);
    this.enqueue(cmd, { front: true });
  }

  /**
   * Wait for the next command.
   * @param {number} timeoutMs
   * @param {{signal?:AbortSignal}} [opts] aborting resolves null and releases the slot
   * @returns {Promise<object|null|{stop:true}>}
   */
  next(timeoutMs = 540000, { signal } = {}) {
    this.lastPollAt = Date.now();
    if (this.stopped) {
      this.updateListening();
      return Promise.resolve({ stop: true });
    }
    if (this.queue.length) {
      const cmd = this.queue.shift();
      this.current = cmd;
      this.emit('dequeued', cmd);
      this.updateListening();
      return Promise.resolve(cmd);
    }
    if (signal && signal.aborted) return Promise.resolve(null);
    const ms = Math.max(1, Number(timeoutMs) || 0);
    return new Promise((resolve) => {
      let onAbort = null;
      const waiter = {
        cleanup: () => {
          clearTimeout(waiter.timer);
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          this.waiters.delete(waiter);
          this.lastPollAt = Date.now();
          this.updateListening();
        },
        finish: (value) => {
          if (!this.waiters.has(waiter)) return;
          waiter.cleanup();
          resolve(value);
        },
        deliver: (cmd) => {
          this.current = cmd;
          waiter.finish(cmd);
          this.emit('dequeued', cmd);
        },
        timer: null,
      };
      waiter.timer = setTimeout(() => waiter.finish(null), ms);
      if (signal) {
        onAbort = () => waiter.finish(null);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.add(waiter);
      this.updateListening();
    });
  }

  /**
   * The terminal session reports progress or its final answer.
   * @param {{text:string, final?:boolean, speak?:boolean}} reply
   * @returns {{ok:true}}
   */
  reply({ text, final = false, speak } = {}) {
    const body = text == null ? '' : String(text);
    const commandId = this.current ? this.current.id : null;
    if (final) this.current = null;
    this.lastPollAt = Date.now();
    this.updateListening();
    this.emit('reply', { text: body, final: Boolean(final), speak: speak !== false, commandId });
    return { ok: true };
  }

  /** Drop queued (not yet delivered) commands. @returns {number} how many */
  clear() {
    const n = this.queue.length;
    this.queue = [];
    return n;
  }

  /** Tell every current and future listener to stop (mode switch / shutdown). */
  stop() {
    this.stopped = true;
    for (const w of [...this.waiters]) w.finish({ stop: true });
    this.current = null;
    this.emit('stop');
    this.updateListening();
  }

  /** Accept listeners again (back in bridge mode). */
  resume() {
    this.stopped = false;
    this.updateListening();
  }

  /** Release timers (daemon shutdown). */
  close() {
    this.stop();
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }
}

module.exports = { Bridge, LISTEN_GRACE_MS };
