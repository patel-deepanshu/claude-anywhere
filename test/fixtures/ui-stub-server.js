#!/usr/bin/env node
'use strict';

/**
 * Stand-alone stub of the Claude Anywhere daemon for working on the dialog UI
 * without Claude Code, a desktop or a network.
 *
 *   node test/fixtures/ui-stub-server.js [port] [--scenario=full|empty] [--token=T] [--no-stream]
 *
 * Serves src/ui with the daemon's routes and security headers (Host check,
 * token auth, Origin check, CSP, no-store) and fakes every /api/* endpoint the
 * UI calls. The SSE stream starts with a snapshot that holds user, assistant
 * and system messages, a running and a finished tool row (with a generated
 * PNG screenshot), a pending approval card and a question card, then streams
 * deltas, a tool update, a result and status changes. POST /api/command
 * simulates a full turn. POST /api/debug/emit {type, data} broadcasts any
 * event, which helps when poking at the UI by hand.
 *
 * Prints the dialog URL (with ?token=) on stdout.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const UI_DIR = path.resolve(__dirname, '..', '..', 'src', 'ui');
const DEFAULT_TOKEN = 'stub-token';

const CSP =
  "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/**
 * Encode RGB pixels as a PNG.
 * @param {number} width
 * @param {number} height
 * @param {(x:number, y:number) => [number, number, number]} pixel
 * @returns {Buffer}
 */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o++] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A small synthetic "desktop": editor on the left, a cloud console in a browser on the right. */
function desktopPng(width = 480, height = 300) {
  const inRect = (x, y, rx, ry, rw, rh) => x >= rx && x < rx + rw && y >= ry && y < ry + rh;
  return encodePng(width, height, (x, y) => {
    const W = width;
    const H = height;
    if (y < 14) return [32, 33, 36]; // menu bar
    // editor window
    const ex = Math.round(W * 0.03);
    const ew = Math.round(W * 0.44);
    if (inRect(x, y, ex, 26, ew, H - 50)) {
      if (y < 40) return [60, 60, 66];
      if (x < ex + 34) return [44, 44, 50];
      const line = Math.floor((y - 48) / 9);
      const lx = ex + 42 + ((line * 37) % 23);
      const lw = 40 + ((line * 53) % 90);
      if ((y - 48) % 9 < 4 && x >= lx && x < lx + lw && y < H - 40) {
        const palette = [[198, 120, 221], [97, 175, 239], [152, 195, 121], [229, 192, 123]];
        return palette[line % palette.length];
      }
      return [30, 31, 36];
    }
    // browser window
    const bx = Math.round(W * 0.5);
    const bw = Math.round(W * 0.47);
    if (inRect(x, y, bx, 26, bw, H - 50)) {
      if (y < 40) return [222, 225, 230];
      if (y < 52) return [241, 243, 244];
      if (inRect(x, y, bx, 52, bw, 16)) return [26, 115, 232];
      if (inRect(x, y, bx + 10, 80, bw - 20, 30)) return [232, 240, 254];
      if (inRect(x, y, bx + 10, 120, 70, 14)) return [26, 115, 232];
      if ((y - 146) % 18 < 8 && y > 146 && y < H - 40 && inRect(x, y, bx + 10, 146, bw - 40, H)) return [218, 220, 224];
      return [255, 255, 255];
    }
    // wallpaper gradient
    const t = (x / W + y / H) / 2;
    return [Math.round(217 - 90 * t), Math.round(119 - 40 * t), Math.round(87 + 40 * t)];
  });
}

// ------------------------------------------------------------------ data

const ago = (ms) => new Date(Date.now() - ms).toISOString();

const DEFAULT_CONFIG = {
  port: 47120,
  mode: 'companion',
  ui: { host: 'auto', alwaysOnTop: true, hotkey: 'CommandOrControl+Shift+Space', theme: 'system', width: 440, height: 720, position: 'right', hideFromScreenshots: true, openOnStart: true },
  engine: { claudePath: '', model: '', fallbackModel: '', effort: '', chrome: false, addVsCodeWorkspaces: true, resumeLast: true, maxBudgetUsd: 0, extraArgs: [], stripEnv: [] },
  permissions: { mode: 'smart', approvalTimeoutSec: 600, alwaysAllow: [], alwaysAsk: [] },
  computer: { maxWidth: 1366, maxHeight: 768, failsafe: true, actionDelayMs: 120, pasteThreshold: 200 },
  context: { attachDesktopContext: true, attachScreenshotByDefault: false, includeWindows: true, includeCloud: true },
  voice: {
    stt: 'auto', tts: 'auto', language: 'en-US', autoSend: true, speakResponses: false, handsFree: false, wakeWord: 'hey claude',
    ttsRate: 1, ttsVoice: '', sttProvider: 'auto', sttBaseUrl: '', sttApiKey: '', sttModel: '', whisperCppPath: '', whisperModel: '',
  },
  privacy: { redactSecretsInLogs: true, auditLog: true },
};

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function publicConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  out.voice.sttApiKeySet = Boolean(out.voice.sttApiKey);
  out.voice.sttApiKey = '';
  return out;
}

function fullScenario(shotUrl) {
  return {
    status: 'waiting_approval',
    statusDetail: 'Waiting for your approval',
    messages: [
      { id: 'm1', role: 'system', text: 'Claude Anywhere is ready. Companion session started in shop-api.', level: 'info', ts: ago(240000) },
      {
        id: 'm2',
        role: 'user',
        text: 'VS Code has my repo open and I have GCP open in Chrome. Start deploying this repo from scratch.',
        source: 'voice',
        ts: ago(230000),
        images: 0,
      },
      {
        id: 'm3',
        role: 'assistant',
        text:
          "I'll deploy **shop-api** to Cloud Run. Here's the plan:\n\n" +
          '1. Check `gcloud` auth and the active project (`my-proj-123` from your Chrome tab)\n' +
          '2. Enable the Run, Cloud Build and Artifact Registry APIs\n' +
          '3. Deploy with source builds:\n\n' +
          '```bash\ngcloud run deploy shop-api --source . --region us-central1\n```\n\n' +
          '> I\'ll ask before anything that costs money. Docs: https://cloud.google.com/run/docs',
        ts: ago(225000),
        streaming: false,
      },
      {
        id: 'm4',
        role: 'tool',
        toolUseId: 'tu_1',
        name: 'mcp__anywhere__screenshot',
        displayName: 'Screenshot',
        summary: 'Display 1 (1366×768)',
        input: {},
        status: 'ok',
        output: 'Screenshot 480x300 (scale 2.85), 1 display. Active window: Google Chrome (Cloud Run – my-proj-123).',
        image: shotUrl,
        parentToolUseId: null,
        ts: ago(220000),
      },
      {
        id: 'm5',
        role: 'tool',
        toolUseId: 'tu_2',
        name: 'Bash',
        displayName: 'Run command',
        summary: 'gcloud auth list --format=json',
        input: { command: 'gcloud auth list --format=json', description: 'Check gcloud login' },
        status: 'ok',
        output: '[\n  {\n    "account": "dev@example.com",\n    "status": "ACTIVE"\n  }\n]',
        image: null,
        parentToolUseId: null,
        ts: ago(210000),
      },
      {
        id: 'm6',
        role: 'tool',
        toolUseId: 'tu_3',
        name: 'Bash',
        displayName: 'Run command',
        summary: 'gcloud services enable run.googleapis.com cloudbuild.googleapis.com',
        input: { command: 'gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com' },
        status: 'running',
        output: null,
        image: null,
        parentToolUseId: null,
        ts: ago(60000),
      },
      { id: 'm7', role: 'system', text: 'Claude found a Dockerfile, so Cloud Build will use it.', level: 'success', ts: ago(50000) },
    ],
    approvals: [
      {
        id: 'ap_1',
        toolName: 'Bash',
        displayName: 'Run command',
        summary: 'gcloud run deploy shop-api --source . --region us-central1 --allow-unauthenticated',
        input: { command: 'gcloud run deploy shop-api --source . --region us-central1 --allow-unauthenticated', description: 'Deploy to Cloud Run' },
        risk: 'high',
        reason: 'Deploys to the cloud: creates billable resources and a public URL',
        ts: ago(5000),
        toolUseId: 'tu_4',
        sessionRule: 'Bash(gcloud run*)',
        timeoutSec: 600,
        mode: 'smart',
      },
    ],
    questions: [{ id: 'q_1', question: 'Which **GCP project** should I deploy to?', options: ['my-proj-123', 'shop-staging', 'Create a new project'], ts: ago(3000) }],
  };
}

function emptyScenario() {
  return { status: 'idle', statusDetail: '', messages: [], approvals: [], questions: [] };
}

// ------------------------------------------------------------------ server

/**
 * Start the stub daemon.
 * @param {{port?:number, host?:string, token?:string, scenario?:'full'|'empty', stream?:boolean,
 *   uiDir?:string, exitOnShutdown?:boolean, log?:(msg:string)=>void}} [opts]
 * @returns {Promise<{server:http.Server, port:number, url:string, token:string, broadcast:Function, close:Function, state:object}>}
 */
async function createStubServer(opts = {}) {
  const token = opts.token || DEFAULT_TOKEN;
  const uiDir = path.resolve(opts.uiDir || UI_DIR);
  const host = opts.host || '127.0.0.1';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const stream = opts.stream !== false;
  const png = desktopPng();
  const shotUrl = `data:image/png;base64,${png.toString('base64')}`;
  const scenario = opts.scenario === 'empty' ? emptyScenario() : fullScenario(shotUrl);
  const instanceId = crypto.randomUUID();
  const clients = new Set();
  const timers = new Set();
  let port = 0;

  const st = {
    config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    mode: 'companion',
    status: scenario.status,
    statusDetail: scenario.statusDetail,
    project: { dir: '/home/dev/code/shop-api', name: 'shop-api', git: { branch: 'main', remote: 'git@github.com:dev/shop-api.git', dirty: true } },
    session: { id: '6f1c2d3e-4b5a-4c3d-9e8f-0a1b2c3d4e5f', model: 'claude-opus-4', costUsd: 0.0421, turns: 3 },
    messages: scenario.messages.slice(),
    approvals: new Map(scenario.approvals.map((a) => [a.id, a])),
    questions: new Map(scenario.questions.map((q) => [q.id, q])),
    bridge: { listening: false },
    screenshot: scenario.messages.length ? { dataUrl: shotUrl, width: 480, height: 300, ts: ago(220000) } : null,
    // What the dialog sent, for tests: command bodies (without images), approval decisions, interrupts.
    commands: [],
    decisions: [],
    interrupts: 0,
  };

  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const snapshot = () => ({
    version: '0.0.0-stub',
    mode: st.mode,
    status: st.status,
    statusDetail: st.statusDetail,
    project: st.project,
    session: st.session,
    messages: st.messages,
    pending: { approvals: [...st.approvals.values()], questions: [...st.questions.values()] },
    config: publicConfig(st.config),
    voice: { serverStt: true, sttProvider: 'groq', serverTts: true, ttsProvider: 'espeak-ng' },
    bridge: st.bridge,
    platform: { platform: process.platform, displayServer: 'x11', driver: 'stub' },
    screenshot: st.screenshot,
  });

  const send = (res, type, data) => {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client went away */
    }
  };
  const broadcast = (type, data) => {
    for (const res of clients) send(res, type, data);
  };
  const setStatus = (status, detail = '') => {
    st.status = status;
    st.statusDetail = detail;
    broadcast('status', detail ? { status, detail } : { status });
  };
  const addMessage = (m) => {
    const i = st.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) st.messages[i] = { ...st.messages[i], ...m };
    else st.messages.push(m);
    broadcast('message', i >= 0 ? st.messages[i] : m);
  };

  /** Scripted activity right after a client connects (full scenario only). */
  const playIntro = () => {
    const id = `a_${Date.now()}`;
    const parts = ['The APIs are ', 'enabled. Next I need ', 'your **approval** to deploy, ', 'and which `project` to use.'];
    later(250, () => setStatus('thinking'));
    later(350, () => addMessage({ id, role: 'assistant', text: '', ts: new Date().toISOString(), streaming: true }));
    parts.forEach((p, i) => later(450 + i * 120, () => broadcast('delta', { id, text: p })));
    later(450 + parts.length * 120 + 50, () => {
      const m = st.messages.find((x) => x.id === 'm6');
      if (m) {
        m.status = 'ok';
        m.output = 'Operation "operations/acf.p2-123" finished successfully.';
      }
      broadcast('tool_update', { toolUseId: 'tu_3', status: 'ok', output: 'Operation "operations/acf.p2-123" finished successfully.', image: null });
    });
    later(450 + parts.length * 120 + 150, () => {
      addMessage({ id, role: 'assistant', text: parts.join(''), streaming: false });
      st.session.costUsd = 0.0587;
      broadcast('result', { text: parts.join(''), costUsd: 0.0166, totalCostUsd: 0.0587, durationMs: 4200, isError: false, sessionId: st.session.id, numTurns: 4 });
      setStatus('waiting_approval', 'Waiting for your approval');
    });
  };

  /** Simulated turn for POST /api/command. */
  const playTurn = (text, images, source) => {
    const uid = `u_${crypto.randomUUID()}`;
    addMessage({ id: uid, role: 'user', text, source, ts: new Date().toISOString(), images });
    setStatus('thinking');
    const toolUseId = `tu_${crypto.randomUUID()}`;
    const toolId = `t_${crypto.randomUUID()}`;
    later(300, () => {
      addMessage({
        id: toolId, role: 'tool', toolUseId, name: 'mcp__anywhere__screenshot', displayName: 'Screenshot', summary: 'Display 1',
        input: {}, status: 'running', output: null, image: null, parentToolUseId: null, ts: new Date().toISOString(),
      });
      setStatus('acting', 'Screenshot');
    });
    later(800, () => {
      const m = st.messages.find((x) => x.id === toolId);
      if (m) Object.assign(m, { status: 'ok', output: 'Screenshot 480x300', image: shotUrl });
      broadcast('tool_update', { toolUseId, status: 'ok', output: 'Screenshot 480x300', image: shotUrl });
      st.screenshot = { dataUrl: shotUrl, width: 480, height: 300, ts: new Date().toISOString() };
      broadcast('screenshot', st.screenshot);
      setStatus('thinking');
    });
    const aid = `a_${crypto.randomUUID()}`;
    const reply = `You said: “${text.slice(0, 200)}”. This is the **UI stub**, so nothing actually ran.\n\n- Screen captured\n- No changes made`;
    later(1000, () => addMessage({ id: aid, role: 'assistant', text: '', ts: new Date().toISOString(), streaming: true }));
    const words = reply.split(/(?<= )/);
    words.forEach((w, i) => later(1050 + i * 40, () => broadcast('delta', { id: aid, text: w })));
    later(1100 + words.length * 40, () => {
      addMessage({ id: aid, role: 'assistant', text: reply, streaming: false });
      st.session.costUsd = Math.round((st.session.costUsd + 0.0123) * 1e6) / 1e6;
      st.session.turns += 1;
      broadcast('result', { text: reply, costUsd: 0.0123, totalCostUsd: st.session.costUsd, durationMs: 1200, isError: false, sessionId: st.session.id, numTurns: 2 });
      setStatus(st.approvals.size ? 'waiting_approval' : st.questions.size ? 'waiting_answer' : 'idle', st.approvals.size ? 'Waiting for your approval' : '');
    });
  };

  const json = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  const fail = (status, message, extra) => {
    const e = new Error(message);
    e.status = status;
    if (extra) Object.assign(e, extra);
    return e;
  };
  const readBody = (req, limit) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(fail(413, 'Request body is too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  const tokenOk = (req, url, allowQuery) => {
    let given = '';
    const auth = req.headers.authorization || '';
    if (/^Bearer\s+/i.test(auth)) given = auth.replace(/^Bearer\s+/i, '').trim();
    else if (req.headers['x-anywhere-token']) given = String(req.headers['x-anywhere-token']).trim();
    else if (allowQuery) given = url.searchParams.get('token') || '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const serveStatic = (req, res, url) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Method not allowed');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw fail(400, 'Bad path encoding');
    }
    if (rel.includes('\0')) throw fail(400, 'Bad path');
    if (rel === '/' || rel === '') rel = '/index.html';
    const segs = rel.split(/[\\/]+/).filter(Boolean);
    if (segs.some((s) => s === '..' || s.includes(':'))) throw fail(403, 'Forbidden path');
    if (segs.some((s) => s.startsWith('.'))) throw fail(404, 'Not found');
    const file = path.resolve(uiDir, ...segs);
    if (!file.startsWith(uiDir + path.sep)) throw fail(403, 'Forbidden path');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw fail(404, 'Not found');
    }
    if (!stat.isFile()) throw fail(404, 'Not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': stat.size });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  };

  const routes = {
    'GET /api/health': () => ({ ok: true, app: 'claude-anywhere', version: '0.0.0-stub', instanceId, pid: process.pid }),
    'GET /api/state': () => snapshot(),
    'GET /api/events': ({ req, res }) => {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      clients.add(res);
      send(res, 'snapshot', snapshot());
      if (stream && opts.scenario !== 'empty' && !st.introPlayed) {
        st.introPlayed = true;
        playIntro();
      }
      const hb = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(hb);
        clients.delete(res);
      });
      return 'handled';
    },
    'POST /api/command': ({ body }) => {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw fail(400, 'text is required');
      const images = (Array.isArray(body.images) ? body.images.length : 0) + (body.attachScreenshot ? 1 : 0);
      const source = ['text', 'voice', 'cli', 'skill'].includes(body.source) ? body.source : 'text';
      const sent = { ...body };
      delete sent.images;
      st.commands.push(sent);
      playTurn(text, images, source);
      return { ok: true, id: `cmd_${Date.now()}` };
    },
    'POST /api/interrupt': () => {
      st.interrupts += 1;
      setStatus('stopping');
      for (const id of st.approvals.keys()) broadcast('approval_resolved', { id, decision: 'deny', by: 'interrupt', message: 'Interrupted by user' });
      for (const id of st.questions.keys()) broadcast('question_resolved', { id, answer: null, cancelled: true });
      st.approvals.clear();
      st.questions.clear();
      later(300, () => setStatus('idle'));
      return { ok: true };
    },
    'POST /api/approval': ({ body }) => {
      if (!['allow', 'allow_session', 'deny'].includes(body.decision)) throw fail(400, 'decision must be allow, allow_session or deny');
      if (!st.approvals.has(body.id)) throw fail(404, 'No pending approval with that id (it may have timed out or been cancelled)');
      st.approvals.delete(body.id);
      st.decisions.push({ id: body.id, decision: body.decision, ...(body.message ? { message: body.message } : {}) });
      broadcast('approval_resolved', { id: body.id, decision: body.decision, by: 'user', ...(body.message ? { message: body.message } : {}) });
      setStatus(st.questions.size ? 'waiting_answer' : 'acting', st.questions.size ? 'Claude asked you a question' : 'Run command');
      return { ok: true };
    },
    'POST /api/answer': ({ body }) => {
      if (!st.questions.has(body.id)) throw fail(404, 'No pending question with that id (it may have timed out or been cancelled)');
      st.questions.delete(body.id);
      broadcast('question_resolved', { id: body.id, answer: String(body.text || '') });
      setStatus(st.approvals.size ? 'waiting_approval' : 'thinking', st.approvals.size ? 'Waiting for your approval' : '');
      return { ok: true };
    },
    'POST /api/session/new': () => {
      st.session = { id: crypto.randomUUID(), model: st.session.model, costUsd: 0, turns: 0 };
      st.messages = [];
      st.approvals.clear();
      st.questions.clear();
      setStatus('idle');
      broadcast('session', { id: st.session.id, model: st.session.model });
      broadcast('snapshot', snapshot());
      return { ok: true, sessionId: st.session.id };
    },
    'GET /api/projects': () => ({
      projects: [
        { dir: st.project.dir, name: st.project.name, source: 'cwd', current: true },
        { dir: '/home/dev/code/web-frontend', name: 'web-frontend', source: 'vscode', current: false },
        { dir: '/home/dev/work/very/deeply/nested/infra-terraform-modules', name: 'infra-terraform-modules', source: 'recent', current: false },
      ],
    }),
    'POST /api/project': ({ body }) => {
      const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
      if (!dir) throw fail(400, 'dir is required');
      if (dir.includes('missing')) throw fail(400, `Folder not found: ${dir}`);
      st.project = { dir, name: path.basename(dir) || dir, git: { branch: 'main', remote: null, dirty: false } };
      broadcast('project', st.project);
      return { ok: true, project: st.project };
    },
    'GET /api/config': () => publicConfig(st.config),
    'POST /api/config': ({ body }) => {
      const partial = isObj(body) ? JSON.parse(JSON.stringify(body)) : {};
      if (partial.voice) {
        delete partial.voice.sttApiKeySet;
        if (!partial.voice.sttApiKey) delete partial.voice.sttApiKey;
      }
      for (const k of Object.keys(partial)) if (!(k in DEFAULT_CONFIG)) throw fail(400, `Unknown setting "${k}"`);
      st.config = deepMerge(st.config, partial);
      const pub = publicConfig(st.config);
      broadcast('config', pub);
      return pub;
    },
    'POST /api/mode': ({ body }) => {
      if (!['companion', 'bridge'].includes(body.mode)) throw fail(400, 'mode must be companion or bridge');
      st.mode = body.mode;
      broadcast('mode', { mode: st.mode });
      return { ok: true, mode: st.mode };
    },
    'POST /api/stt': ({ req, raw }) => {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!/^audio\//.test(ct)) throw fail(415, 'Send audio as audio/wav (webm, ogg and mp4 are also accepted)');
      if (!raw || raw.length <= 44) throw fail(400, 'The audio body is empty');
      return { text: "What's on my screen?", provider: 'stub' };
    },
    'POST /api/tts': ({ body }) => {
      if (typeof body.text !== 'string' || !body.text.trim()) throw fail(400, 'text must be a non-empty string');
      return { ok: true, provider: 'stub' };
    },
    'POST /api/tts/stop': () => ({ ok: true }),
    'GET /api/context': () => ({
      os: { platform: process.platform, osName: 'Stub OS', release: '1.0', arch: process.arch, user: 'dev', hostname: 'stub', displayServer: 'x11' },
      time: new Date().toISOString(),
      activeWindow: { app: 'Google Chrome', title: 'Cloud Run – my-proj-123 – Google Cloud console' },
      windows: [],
      editors: [{ app: 'Visual Studio Code', workspaceName: 'shop-api', path: st.project.dir, active: false }],
      browsers: [{ app: 'Google Chrome', title: 'Cloud Run – my-proj-123', url: null }],
      project: st.project,
      cloud: { gcloud: { account: 'dev@example.com', project: 'my-proj-123' }, aws: null, az: null, kubectl: null, docker: null },
      errors: [],
    }),
    'POST /api/show': () => {
      broadcast('show', {});
      return { ok: true, host: 'browser' };
    },
    'POST /api/shutdown': ({ res }) => {
      json(res, 200, { ok: true });
      broadcast('status', { status: 'offline' });
      if (opts.exitOnShutdown) setTimeout(() => process.exit(0), 100);
      return 'handled';
    },
    'POST /api/mcp/notify': ({ body }) => {
      const text = String(body.message || '').trim();
      if (!text) throw fail(400, 'message must be a non-empty string');
      const level = ['info', 'success', 'warning', 'error'].includes(body.level) ? body.level : 'info';
      addMessage({ id: crypto.randomUUID(), role: 'system', text, level, ts: new Date().toISOString() });
      broadcast('notify', { text, level, speak: Boolean(body.speak) });
      return { ok: true, delivered: clients.size > 0 };
    },
    'POST /api/mcp/activity': () => ({ ok: true }),
    'GET /api/mcp/guard': () => ({ allowed: true }),
    'POST /api/debug/emit': ({ body }) => {
      if (typeof body.type !== 'string' || !body.type) throw fail(400, 'type is required');
      if (body.type === 'approval_request' && body.data && body.data.id) st.approvals.set(body.data.id, body.data);
      if (body.type === 'question' && body.data && body.data.id) st.questions.set(body.data.id, body.data);
      if (body.type === 'message' && body.data && body.data.id) {
        addMessage(body.data);
        return { ok: true };
      }
      broadcast(body.type, body.data || {});
      return { ok: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const hostHeader = String(req.headers.host || '');
      if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) {
        json(res, 403, { error: 'Forbidden host' });
        return;
      }
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
        serveStatic(req, res, url);
        return;
      }
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const origin = req.headers.origin;
      if (method !== 'GET' && origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        throw fail(403, 'Forbidden origin');
      }
      const key = `${method} ${url.pathname}`;
      const fn = routes[key];
      if (key !== 'GET /api/health' && !tokenOk(req, url, key === 'GET /api/events')) throw fail(401, 'Unauthorized');
      if (!fn) throw fail(404, 'Not found');
      let body = {};
      let raw = null;
      if (method === 'POST') {
        if (key === 'POST /api/stt') raw = await readBody(req, 25 * 1024 * 1024);
        else {
          const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          const buf = await readBody(req, 25 * 1024 * 1024);
          if (buf.length) {
            if (ct && ct !== 'application/json') throw fail(415, 'Content-Type must be application/json');
            try {
              body = JSON.parse(buf.toString('utf8'));
            } catch {
              throw fail(400, 'Invalid JSON body');
            }
            if (!isObj(body)) throw fail(400, 'JSON body must be an object');
          }
        }
      }
      const out = await fn({ req, res, url, body, raw });
      if (out === 'handled') return;
      json(res, 200, out === undefined ? { ok: true } : out);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log(`error: ${err.stack || err.message}`);
      if (!res.headersSent) json(res, status, { error: err.message || 'Internal error', ...(err.hint ? { hint: err.hint } : {}) });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  port = server.address().port;
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  log(`UI stub listening on ${url}`);

  const close = () =>
    new Promise((resolve) => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });

  return { server, port, url, token, broadcast, close, state: st, snapshot };
}

function parseArgs(argv) {
  const out = { port: 0, scenario: 'full', token: DEFAULT_TOKEN, stream: true };
  for (const a of argv) {
    if (/^\d+$/.test(a)) out.port = Number(a);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7)) || 0;
    else if (a.startsWith('--scenario=')) out.scenario = a.slice(11);
    else if (a.startsWith('--token=')) out.token = a.slice(8) || DEFAULT_TOKEN;
    else if (a === '--no-stream') out.stream = false;
  }
  return out;
}

if (require.main === module) {
  // `node --test` without arguments also picks up files under test/; a stub
  // started that way (no arguments, inside the runner) must exit at once.
  if (process.env.NODE_TEST_CONTEXT && process.argv.length <= 2) process.exit(0);
  const args = parseArgs(process.argv.slice(2));
  createStubServer({ ...args, exitOnShutdown: true, log: (m) => process.stderr.write(`${m}\n`) })
    .then(({ url, close }) => {
      process.stdout.write(`${url}\n`);
      const stop = () => close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      process.stderr.write(`ui-stub-server: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { createStubServer, desktopPng, encodePng, crc32, SECURITY_HEADERS, CSP };
