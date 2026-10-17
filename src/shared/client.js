'use strict';

/** HTTP client for the daemon API, used by the CLI, MCP server and TUI. */

const http = require('http');
const https = require('https');
const { findRunningDaemon } = require('./state');

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

class DaemonClient {
  /** @param {{baseUrl:string, token:string}} opts */
  constructor({ baseUrl, token }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  /** Connect via env (ANYWHERE_DAEMON_URL + ANYWHERE_TOKEN) or daemon.json. */
  static async connect() {
    if (process.env.ANYWHERE_DAEMON_URL && process.env.ANYWHERE_TOKEN) {
      return new DaemonClient({ baseUrl: process.env.ANYWHERE_DAEMON_URL, token: process.env.ANYWHERE_TOKEN });
    }
    const st = await findRunningDaemon();
    if (!st) return null;
    return new DaemonClient({ baseUrl: `http://127.0.0.1:${st.port}`, token: st.token });
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  /**
   * JSON request over node:http. Not fetch: undici aborts responses whose
   * headers take longer than 300 s, and approvals or questions can block for
   * much longer than that.
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @param {{timeoutMs?:number, signal?:AbortSignal}} [opts]
   */
  async request(method, path, body, { timeoutMs = 30000, signal } = {}) {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const headers = this.headers(payload ? { 'Content-Type': 'application/json' } : {});
    const { status, text } = await this.raw(method, path, payload, headers, { timeoutMs, signal });
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (status < 200 || status >= 300) {
      const err = new Error((data && data.error) || `HTTP ${status}`);
      err.status = status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async postBinary(path, buffer, contentType, { timeoutMs = 120000, signal } = {}) {
    const { status, text } = await this.raw('POST', path, buffer, this.headers({ 'Content-Type': contentType }), {
      timeoutMs,
      signal,
    });
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (status < 200 || status >= 300) {
      const err = new Error((data && data.error) || `HTTP ${status}`);
      err.status = status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** @returns {Promise<{status:number, text:string}>} */
  raw(method, path, payload, headers, { timeoutMs = 30000, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      let url;
      try {
        url = new URL(this.baseUrl + path);
      } catch (err) {
        reject(err);
        return;
      }
      const lib = url.protocol === 'https:' ? https : http;
      const hdrs = { ...headers };
      if (payload) hdrs['Content-Length'] = payload.length;
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(v);
      };
      const req = lib.request(
        { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: hdrs, agent: false },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => done(resolve, { status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', (err) => done(reject, err));
        },
      );
      const timer = setTimeout(() => {
        const e = new Error(`Request to ${path} timed out after ${Math.round(timeoutMs / 1000)} s`);
        e.code = 'ETIMEDOUT';
        req.destroy();
        done(reject, e);
      }, timeoutMs);
      const onAbort = () => {
        req.destroy();
        done(reject, abortError(signal));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      req.on('error', (err) => done(reject, err));
      if (payload) req.end(payload);
      else req.end();
    });
  }

  /**
   * Subscribe to the SSE stream. Reconnects with backoff until closed.
   * @param {(type:string, data:any)=>void} onEvent
   * @returns {{close:()=>void}}
   */
  subscribe(onEvent) {
    let closed = false;
    let ctrl = null;
    let delay = 1000;
    const loop = async () => {
      while (!closed) {
        ctrl = new AbortController();
        try {
          const res = await fetch(`${this.baseUrl}/api/events?token=${encodeURIComponent(this.token)}`, {
            headers: { Accept: 'text/event-stream' },
            signal: ctrl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
          delay = 1000;
          const decoder = new TextDecoder();
          let buf = '';
          for await (const chunk of res.body) {
            buf += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let type = 'message';
              const dataLines = [];
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) type = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
              }
              if (!dataLines.length) continue;
              let data;
              try {
                data = JSON.parse(dataLines.join('\n'));
              } catch {
                data = dataLines.join('\n');
              }
              try {
                onEvent(type, data);
              } catch {
                /* consumer errors must not kill the stream */
              }
            }
          }
        } catch {
          if (closed) return;
        }
        if (closed) return;
        try {
          onEvent('_disconnected', {});
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10000);
      }
    };
    loop();
    return {
      close() {
        closed = true;
        if (ctrl) ctrl.abort();
      },
    };
  }
}

module.exports = { DaemonClient };
