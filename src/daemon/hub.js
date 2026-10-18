'use strict';

/**
 * Server-Sent Events fan-out to every connected dialog (UI, TUI, CLI watchers).
 *
 * Each client first receives `retry: 2000` and a `snapshot` event (when a
 * snapshot provider is set). A comment line is written every 15 s so proxies
 * and the browser keep the stream open and dead sockets are detected. Clients
 * whose socket died or whose unsent buffer grew too large are dropped; a
 * snapshot frame (it carries the transcript's screenshots, often more than the
 * limit) does not count toward that limit until it has drained.
 *
 * The hub is also an EventEmitter: every broadcast is re-emitted locally as
 * `('event', type, data)` so daemon components can react to each other's
 * events (for example the session recomputing its status on approval cards).
 */

const { EventEmitter } = require('events');
const { createLogger } = require('../shared/log');

const log = createLogger('hub');

const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_MAX_BUFFERED = 16 * 1024 * 1024;

/**
 * Format one SSE frame. Multi-line payloads are split into several data: lines.
 * @param {string} type
 * @param {*} data
 * @returns {string}
 */
function formatEvent(type, data) {
  let json;
  try {
    json = JSON.stringify(data === undefined ? {} : data);
  } catch (err) {
    json = JSON.stringify({ error: `unserializable event payload: ${err.message}` });
  }
  const safeType = String(type || 'message').replace(/[\r\n]/g, ' ');
  // JSON.stringify never emits raw newlines, but keep the framing correct regardless.
  const dataLines = json.split(/\r?\n/).map((l) => `data: ${l}`).join('\n');
  return `event: ${safeType}\n${dataLines}\n\n`;
}

class Hub extends EventEmitter {
  /**
   * @param {{heartbeatMs?:number, maxBufferedBytes?:number, snapshot?:()=>object}} [opts]
   */
  constructor({ heartbeatMs = DEFAULT_HEARTBEAT_MS, maxBufferedBytes = DEFAULT_MAX_BUFFERED, snapshot } = {}) {
    super();
    this.setMaxListeners(100);
    this.heartbeatMs = heartbeatMs;
    this.maxBufferedBytes = maxBufferedBytes;
    this.snapshotProvider = typeof snapshot === 'function' ? snapshot : null;
    /** @type {Set<{id:number,res:import('http').ServerResponse,since:number,allowance:number,draining:boolean}>} */
    this.clients = new Set();
    this.nextId = 1;
    this.closed = false;
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** @param {()=>object} fn returns the `snapshot` payload sent to each new client */
  setSnapshotProvider(fn) {
    this.snapshotProvider = typeof fn === 'function' ? fn : null;
  }

  /**
   * Attach an HTTP response as an SSE stream.
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   * @param {{snapshot?:object}} [opts] explicit first snapshot (else the provider is used)
   * @returns {{id:number}|null}
   */
  addClient(req, res, opts = {}) {
    if (this.closed) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'daemon is shutting down' }));
      return null;
    }
    const client = { id: this.nextId++, res, since: Date.now(), allowance: 0, draining: false };
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
    if (req && req.socket) {
      req.socket.setKeepAlive(true, 30000);
      req.socket.setNoDelay(true);
      req.socket.setTimeout(0);
    }
    const drop = () => this.removeClient(client, 'closed');
    res.on('close', drop);
    res.on('error', drop);
    this.clients.add(client);
    this.write(client, 'retry: 2000\n\n');
    let snap = opts.snapshot;
    if (snap === undefined && this.snapshotProvider) {
      try {
        snap = this.snapshotProvider();
      } catch (err) {
        log.error('snapshot provider failed:', err);
        snap = undefined;
      }
    }
    if (snap !== undefined) {
      const frame = formatEvent('snapshot', snap);
      this.write(client, frame, Buffer.byteLength(frame));
    }
    this.emit('clients', this.clients.size);
    log.debug(`client ${client.id} connected (${this.clients.size} total)`);
    return { id: client.id };
  }

  /** @private */
  removeClient(client, why) {
    if (!this.clients.delete(client)) return;
    try {
      if (!client.res.writableEnded) client.res.end();
    } catch {
      /* already gone */
    }
    try {
      client.res.destroy();
    } catch {
      /* ignore */
    }
    log.debug(`client ${client.id} dropped (${why}); ${this.clients.size} left`);
    this.emit('clients', this.clients.size);
  }

  /**
   * @private
   * @param {number} [exemptBytes] the frame's size when it is a snapshot: until the socket drains,
   *   only what queues beyond it counts toward the slow-consumer limit
   * @returns {boolean} false when the client was dropped
   */
  write(client, chunk, exemptBytes = 0) {
    const { res } = client;
    if (res.destroyed || res.writableEnded || (res.socket && res.socket.destroyed)) {
      this.removeClient(client, 'dead socket');
      return false;
    }
    if (res.writableLength > this.maxBufferedBytes + client.allowance) {
      this.removeClient(client, `slow consumer (${res.writableLength} bytes queued)`);
      return false;
    }
    let flushed;
    try {
      flushed = res.write(chunk);
    } catch (err) {
      this.removeClient(client, `write failed: ${err.message}`);
      return false;
    }
    if (exemptBytes > 0 && !flushed) {
      client.allowance += exemptBytes;
      if (!client.draining) {
        client.draining = true;
        res.once('drain', () => {
          client.allowance = 0;
          client.draining = false;
        });
      }
    }
    return true;
  }

  /**
   * Send an event to every client and re-emit it locally as ('event', type, data).
   * @param {string} type
   * @param {*} data
   */
  broadcast(type, data) {
    if (!this.closed && this.clients.size) {
      const frame = formatEvent(type, data);
      const exempt = type === 'snapshot' ? Buffer.byteLength(frame) : 0;
      for (const client of [...this.clients]) this.write(client, frame, exempt);
    }
    try {
      this.emit('event', type, data);
    } catch (err) {
      log.error(`listener for "${type}" threw:`, err);
    }
  }

  /** Write a heartbeat comment to every client (drops dead ones). */
  heartbeat() {
    const frame = `: ping ${Date.now()}\n\n`;
    for (const client of [...this.clients]) this.write(client, frame);
  }

  /** @returns {number} connected SSE clients */
  clientCount() {
    return this.clients.size;
  }

  /** End every stream and stop the heartbeat. */
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const client of [...this.clients]) this.removeClient(client, 'hub closed');
  }
}

module.exports = { Hub, formatEvent };
