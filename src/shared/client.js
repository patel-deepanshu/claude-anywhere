'use strict';

/** HTTP client for the daemon API, used by the CLI, MCP server and TUI. */

const { findRunningDaemon } = require('./state');

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
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @param {{timeoutMs?:number}} [opts]
   */
  async request(method, path, body, { timeoutMs = 30000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: this.headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const err = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error(`Request to ${path} timed out after ${timeoutMs} ms`);
        e.code = 'ETIMEDOUT';
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async postBinary(path, buffer, contentType, { timeoutMs = 120000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': contentType }),
        body: buffer,
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
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
