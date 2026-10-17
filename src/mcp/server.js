'use strict';

/**
 * Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0, tools only.
 *
 * stdout is the protocol channel, so startStdioServer() reroutes console.log,
 * console.info, console.debug and stray process.stdout.write calls to stderr
 * the moment it takes over process.stdout. Responses are written as one line
 * each with a single write() call.
 *
 * Run directly (`node src/mcp/server.js`) or via `anywhere mcp` to serve the
 * Claude Anywhere desktop tools.
 */

const util = require('util');
const { StringDecoder } = require('string_decoder');
const { createLogger } = require('../shared/log');

const JSONRPC = '2.0';
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

// ---------------------------------------------------------------- argument validation

const TYPE_NAMES = { integer: 'a whole number', number: 'a number', string: 'a string', boolean: 'true or false', array: 'an array', object: 'an object' };

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function describe(v) {
  if (v === undefined) return 'nothing';
  const s = JSON.stringify(v);
  return s && s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/**
 * Coerce one value toward a JSON Schema type the way models commonly get it
 * wrong ("512" for 512, "true" for true, a JSON string for an object).
 * Returns {ok, value}.
 */
function coerce(value, type, schema) {
  switch (type) {
    case 'integer':
    case 'number': {
      let n = value;
      if (typeof n === 'string' && n.trim() !== '' && Number.isFinite(Number(n))) n = Number(n);
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false };
      if (type === 'integer' && !Number.isInteger(n)) return { ok: false };
      return { ok: true, value: n };
    }
    case 'string':
      if (typeof value === 'string') return { ok: true, value };
      if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
      return { ok: false };
    case 'boolean':
      if (typeof value === 'boolean') return { ok: true, value };
      if (value === 'true' || value === 1 || value === '1') return { ok: true, value: true };
      if (value === 'false' || value === 0 || value === '0') return { ok: true, value: false };
      return { ok: false };
    case 'array': {
      if (Array.isArray(value)) return { ok: true, value };
      if (typeof value === 'string') {
        const t = value.trim();
        if (t.startsWith('[')) {
          try {
            const parsed = JSON.parse(t);
            if (Array.isArray(parsed)) return { ok: true, value: parsed };
          } catch {
            /* fall through */
          }
        }
        const itemType = schema && schema.items && schema.items.type;
        if (itemType === 'string') return { ok: true, value: [value] };
      }
      return { ok: false };
    }
    case 'object': {
      if (isPlainObject(value)) return { ok: true, value };
      if (typeof value === 'string' && value.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(value);
          if (isPlainObject(parsed)) return { ok: true, value: parsed };
        } catch {
          /* fall through */
        }
      }
      return { ok: false };
    }
    default:
      return { ok: true, value };
  }
}

function checkValue(value, schema, name, errors) {
  if (!schema || typeof schema !== 'object') return value;
  let v = value;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    let matched = false;
    for (const t of types) {
      const r = coerce(v, t, schema);
      if (r.ok) {
        v = r.value;
        matched = true;
        break;
      }
    }
    if (!matched) {
      errors.push(`${name} must be ${types.map((t) => TYPE_NAMES[t] || t).join(' or ')} (got ${describe(value)})`);
      return value;
    }
  }
  if (Array.isArray(schema.enum)) {
    let hit = schema.enum.find((e) => e === v);
    if (hit === undefined && typeof v === 'string') hit = schema.enum.find((e) => typeof e === 'string' && e.toLowerCase() === v.trim().toLowerCase());
    if (hit === undefined) {
      errors.push(`${name} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')} (got ${describe(v)})`);
      return v;
    }
    v = hit;
  }
  if (typeof v === 'number') {
    if (typeof schema.minimum === 'number' && v < schema.minimum) errors.push(`${name} must be at least ${schema.minimum} (got ${v})`);
    if (typeof schema.maximum === 'number' && v > schema.maximum) errors.push(`${name} must be at most ${schema.maximum} (got ${v})`);
  }
  if (typeof v === 'string') {
    if (typeof schema.minLength === 'number' && v.length < schema.minLength) errors.push(`${name} must not be empty`);
    if (typeof schema.maxLength === 'number' && v.length > schema.maxLength) errors.push(`${name} is too long (${v.length} characters; the limit is ${schema.maxLength})`);
  }
  if (Array.isArray(v)) {
    if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) errors.push(`${name} has too many items (${v.length}; the limit is ${schema.maxItems})`);
    if (typeof schema.minItems === 'number' && v.length < schema.minItems) errors.push(`${name} needs at least ${schema.minItems} item(s)`);
    if (schema.items) v = v.map((item, i) => checkValue(item, schema.items, `${name}[${i}]`, errors));
  }
  if (isPlainObject(v) && isPlainObject(schema.properties)) v = checkObject(v, schema, name, errors);
  return v;
}

function checkObject(obj, schema, prefix, errors) {
  const out = { ...obj };
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  for (const k of Object.keys(out)) if (out[k] === null && props[k] && !allowsNull(props[k])) delete out[k];
  const missing = (Array.isArray(schema.required) ? schema.required : []).filter((k) => out[k] === undefined || out[k] === '');
  if (missing.length) {
    const label = prefix ? `${prefix}.` : '';
    errors.push(`missing required argument${missing.length > 1 ? 's' : ''}: ${missing.map((k) => label + k).join(', ')}`);
  }
  for (const [k, sub] of Object.entries(props)) {
    if (out[k] === undefined || missing.includes(k)) continue;
    out[k] = checkValue(out[k], sub, prefix ? `${prefix}.${k}` : k, errors);
  }
  return out;
}

function allowsNull(schema) {
  return schema && (schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')));
}

/**
 * Validate (and lightly coerce) tool arguments against a JSON Schema subset:
 * type, required, enum, minimum/maximum, minLength/maxLength, items, nested properties.
 * Unknown properties are passed through. Null optional values are dropped.
 * @param {object} schema inputSchema
 * @param {object} args
 * @returns {{value:object, errors:string[]}}
 */
function validateArguments(schema, args) {
  const errors = [];
  let input = args;
  if (input === undefined || input === null) input = {};
  if (typeof input === 'string' && input.trim().startsWith('{')) {
    try {
      input = JSON.parse(input);
    } catch {
      /* reported below */
    }
  }
  if (!isPlainObject(input)) return { value: {}, errors: ['arguments must be a JSON object'] };
  if (!schema || typeof schema !== 'object') return { value: input, errors };
  const value = checkObject(input, schema, '', errors);
  return { value, errors };
}

// ---------------------------------------------------------------- results

function textContent(text) {
  return [{ type: 'text', text: String(text) }];
}

/**
 * Turn whatever a handler returned into an MCP CallToolResult.
 * @returns {{content:object[], isError:boolean}}
 */
function normalizeResult(out) {
  if (out === undefined || out === null) return { content: textContent('Done.'), isError: false };
  if (typeof out === 'string') return { content: textContent(out), isError: false };
  if (Array.isArray(out)) return { content: out, isError: false };
  if (isPlainObject(out) && Array.isArray(out.content)) {
    const res = { content: out.content, isError: Boolean(out.isError) };
    if (isPlainObject(out.structuredContent)) res.structuredContent = out.structuredContent;
    return res;
  }
  let text;
  try {
    text = JSON.stringify(out, null, 2);
  } catch {
    text = String(out);
  }
  return { content: textContent(text), isError: false };
}

/** Exception → isError result whose text includes err.hint when present. */
function errorResult(err) {
  const msg = err && err.message ? err.message : String(err);
  let text = /^error\b/i.test(msg) ? msg : `Error: ${msg}`;
  if (err && err.hint && !text.includes(err.hint)) text += `\nHint: ${err.hint}`;
  return { content: textContent(text), isError: true };
}

// ---------------------------------------------------------------- stdout protection

let rawStdoutWrite = null;

/**
 * Route everything except our own protocol writes away from stdout.
 * Idempotent; always returns the writer bound to the real stdout.
 * @returns {(line:string)=>boolean}
 */
function guardStdout() {
  if (rawStdoutWrite) return rawStdoutWrite;
  const rawWrite = process.stdout.write.bind(process.stdout);
  rawStdoutWrite = rawWrite;
  const toStderr = (...args) => {
    try {
      process.stderr.write(`${util.format(...args)}\n`);
    } catch {
      /* ignore */
    }
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.trace = toStderr;
  process.stdout.write = (chunk, encoding, cb) => process.stderr.write(chunk, encoding, cb);
  return rawWrite;
}

// ---------------------------------------------------------------- server

/**
 * Start an MCP server on newline-delimited JSON-RPC streams.
 *
 * Tool handlers are called as handler(args, extra) with
 * extra = { signal, progressToken, requestId, sendProgress(message, progress?) }.
 * The signal aborts when the client sends notifications/cancelled for the
 * request or the input ends.
 *
 * @param {{name?:string, version?:string, tools?:object[], log?:object, instructions?:string,
 *   input?:NodeJS.ReadableStream, output?:NodeJS.WritableStream}} opts
 * @returns {{done:Promise<void>, close:()=>void, notify:(method:string, params?:object)=>void, inflight:()=>number}}
 */
function startStdioServer({ name = 'anywhere', version = '0.0.0', tools = [], log, instructions, input = process.stdin, output = process.stdout } = {}) {
  const logger = log || createLogger('mcp');
  const toolMap = new Map();
  for (const t of tools) {
    if (!t || typeof t.name !== 'string' || typeof t.handler !== 'function') throw new TypeError('each tool needs a name and a handler');
    if (toolMap.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    toolMap.set(t.name, t);
  }
  const toolList = tools.map((t) => {
    const def = { name: t.name };
    if (t.title) def.title = t.title;
    def.description = t.description || '';
    def.inputSchema = t.inputSchema || { type: 'object', properties: {} };
    if (t.annotations) def.annotations = t.annotations;
    return def;
  });

  const write = output === process.stdout ? guardStdout() : (line) => output.write(line);
  const inflight = new Map(); // request id → AbortController
  let closed = false;
  let closing = false;
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });

  function send(msg) {
    if (closed) return;
    let line;
    try {
      line = JSON.stringify(msg);
    } catch (err) {
      line = JSON.stringify({ jsonrpc: JSONRPC, id: msg && msg.id !== undefined ? msg.id : null, error: { code: ERR.INTERNAL, message: `Could not serialize the response: ${err.message}` } });
    }
    try {
      write(`${line}\n`);
    } catch (err) {
      logger.error('stdout write failed:', err.message);
    }
  }

  const ok = (id, result) => ({ jsonrpc: JSONRPC, id, result });
  const fail = (id, code, message, data) => ({ jsonrpc: JSONRPC, id, error: data === undefined ? { code, message } : { code, message, data } });

  async function callTool(id, params) {
    const p = isPlainObject(params) ? params : {};
    const toolName = p.name;
    const tool = toolMap.get(toolName);
    if (!tool) {
      return {
        content: textContent(`Error: Unknown tool "${toolName}". Available tools: ${[...toolMap.keys()].join(', ')}.`),
        isError: true,
      };
    }
    const { value: args, errors } = validateArguments(tool.inputSchema, p.arguments);
    if (errors.length) {
      return { content: textContent(`Error: Invalid arguments for ${toolName}: ${errors.join('; ')}.`), isError: true };
    }
    const ac = new AbortController();
    inflight.set(id, ac);
    const progressToken = isPlainObject(p._meta) ? p._meta.progressToken : undefined;
    let progress = 0;
    const extra = {
      signal: ac.signal,
      progressToken,
      requestId: id,
      sendProgress(message, value) {
        if (progressToken === undefined || progressToken === null || ac.signal.aborted || closed) return false;
        progress = typeof value === 'number' && value > progress ? value : progress + 1;
        const prm = { progressToken, progress };
        if (message) prm.message = String(message);
        send({ jsonrpc: JSONRPC, method: 'notifications/progress', params: prm });
        return true;
      },
    };
    const started = Date.now();
    let result;
    try {
      result = normalizeResult(await tool.handler(args, extra));
    } catch (err) {
      if (!ac.signal.aborted) logger.debug(`tool ${toolName} failed:`, err && err.message);
      result = errorResult(err);
    } finally {
      inflight.delete(id);
    }
    logger.debug(`tool ${toolName} ${result.isError ? 'error' : 'ok'} in ${Date.now() - started} ms`);
    if (ac.signal.aborted) return undefined; // cancelled: the client expects no response
    return result;
  }

  async function handleRequest(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize': {
        const requested = isPlainObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_PROTOCOL_VERSION;
        const result = {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        };
        if (instructions) result.instructions = instructions;
        const client = isPlainObject(params) && isPlainObject(params.clientInfo) ? params.clientInfo : {};
        logger.debug(`initialize from ${client.name || 'client'} ${client.version || ''} (protocol ${requested})`);
        return ok(id, result);
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: toolList });
      case 'tools/call': {
        const result = await callTool(id, params);
        return result === undefined ? null : ok(id, result);
      }
      default:
        return fail(id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  function handleNotification(msg) {
    if (msg.method === 'notifications/cancelled') {
      const reqId = isPlainObject(msg.params) ? msg.params.requestId : undefined;
      const ac = inflight.get(reqId);
      if (ac) {
        logger.debug(`request ${reqId} cancelled by the client`);
        ac.abort(new Error((msg.params && msg.params.reason) || 'Cancelled by the client'));
      }
    }
    // notifications/initialized, progress, roots/list_changed…: nothing to do.
  }

  async function handleMessage(msg) {
    if (!isPlainObject(msg)) return fail(null, ERR.INVALID_REQUEST, 'Invalid Request: expected a JSON object');
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null && msg.id !== undefined;
    if (typeof msg.method !== 'string') {
      if (hasId && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) return null; // reply to a request we never send
      return fail(hasId ? msg.id : null, ERR.INVALID_REQUEST, 'Invalid Request: missing method');
    }
    if (!hasId) {
      handleNotification(msg);
      return null;
    }
    try {
      return await handleRequest(msg);
    } catch (err) {
      logger.error(`${msg.method} failed:`, err);
      return fail(msg.id, ERR.INTERNAL, `Internal error: ${err && err.message ? err.message : err}`);
    }
  }

  async function onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send(fail(null, ERR.PARSE, 'Parse error: each line must be one JSON-RPC message'));
      return;
    }
    if (Array.isArray(msg)) {
      if (!msg.length) {
        send(fail(null, ERR.INVALID_REQUEST, 'Invalid Request: empty batch'));
        return;
      }
      const replies = (await Promise.all(msg.map(handleMessage))).filter(Boolean);
      if (replies.length) send(replies);
      return;
    }
    const reply = await handleMessage(msg);
    if (reply) send(reply);
  }

  const decoder = new StringDecoder('utf8');
  let buf = '';
  const drain = () => {
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line).catch((err) => logger.error('message handling failed:', err));
    }
  };
  const onData = (chunk) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    drain();
  };
  const finish = () => {
    if (closing) return;
    buf += decoder.end();
    if (buf.trim()) {
      const last = buf;
      buf = '';
      onLine(last.replace(/\r$/, '')).catch(() => {});
    }
    close();
  };

  function close() {
    if (closing) return;
    closing = true;
    for (const ac of inflight.values()) {
      try {
        ac.abort(new Error('The MCP client disconnected'));
      } catch {
        /* ignore */
      }
    }
    // Let a final reply produced synchronously above go out before closing.
    setImmediate(() => {
      closed = true;
      input.removeListener('data', onData);
      input.removeListener('end', finish);
      input.removeListener('close', finish);
      resolveDone();
    });
  }

  input.on('data', onData);
  input.on('end', finish);
  input.on('close', finish);
  input.on('error', (err) => {
    logger.warn('stdin error:', err.message);
    finish();
  });
  if (typeof input.resume === 'function') input.resume();

  return {
    done,
    close,
    notify(method, params) {
      send(params === undefined ? { jsonrpc: JSONRPC, method } : { jsonrpc: JSONRPC, method, params });
    },
    inflight: () => inflight.size,
  };
}

// ---------------------------------------------------------------- main

function buildInstructions(role) {
  const lines = [
    'Claude Anywhere gives you eyes and hands on the user\'s desktop (macOS, Windows, WSL or Linux): screenshots, mouse, keyboard, windows, apps, URLs and the clipboard, plus ask_user / notify_user to talk to the user through the floating Anywhere dialog.',
    'Prefer CLIs and APIs (Bash with git, gh, gcloud, aws, az, kubectl, docker) when they can do the job; use the screen tools for things that only exist on screen, such as a cloud console in the browser or a desktop app.',
    'GUI loop: screenshot → decide → one action → screenshot to verify. Coordinates are pixels in your latest full screenshot of that display; zoom with screenshot.region to read small text, then convert back as the response explains.',
    'Before type_text or key, bring the target window to the front with focus_window (or click into it) and check with a screenshot. In key combos "primary" means Cmd on macOS and Ctrl elsewhere.',
    'The window titled "Claude Anywhere" is the user\'s control dialog: never click, type into, move or close it.',
    'Use ask_user before irreversible, costly, public or financial steps. Never type passwords, 2FA codes or payment details; ask the user to do that part. Do not solve CAPTCHAs.',
    'If a tool says actions are paused or the FAILSAFE tripped, stop and wait for the user.',
    'get_desktop_context tells you which editors, repos, browser tabs and cloud accounts are open.',
  ];
  if (role === 'interactive') lines.push('If ask_user reports that the dialog is not running, ask in your normal reply instead.');
  return lines.join('\n');
}

/**
 * Run the anywhere MCP server on this process's stdin/stdout until stdin ends.
 * @returns {Promise<void>}
 */
async function main() {
  guardStdout();
  const log = createLogger('mcp');
  process.on('uncaughtException', (err) => log.error('uncaught exception:', err));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });

  let version = '0.0.0';
  try {
    version = require('../../package.json').version || version;
  } catch {
    /* keep default */
  }
  let config;
  try {
    config = require('../shared/config').load();
  } catch (err) {
    log.warn('could not load config, using defaults:', err.message);
    config = JSON.parse(JSON.stringify(require('../shared/config').DEFAULTS));
  }
  const role = process.env.ANYWHERE_ROLE || 'interactive';

  let computerPromise = null;
  let driverRef = null;
  const getComputer = () => {
    if (!computerPromise) {
      computerPromise = (async () => {
        const { getDriver } = require('../os/index');
        const { Computer } = require('../os/computer');
        const driver = await getDriver();
        driverRef = driver;
        return new Computer({ driver, config: config.computer, geometryStore: 'file' });
      })();
      computerPromise.catch((err) => {
        log.error('desktop driver failed to start:', err);
        computerPromise = null;
      });
    }
    return computerPromise;
  };

  const { DaemonClient } = require('../shared/client');
  let cached = { at: 0, client: null };
  let pending = null;
  const getClient = async () => {
    if (Date.now() - cached.at < 5000) return cached.client;
    if (!pending) {
      pending = DaemonClient.connect()
        .catch(() => null)
        .then((client) => {
          cached = { at: Date.now(), client: client || null };
          pending = null;
          return cached.client;
        });
    }
    return pending;
  };

  const { createTools } = require('./tools');
  const tools = createTools({ computer: getComputer, getClient, config, role });
  const server = startStdioServer({ name: 'anywhere', version, tools, log, instructions: buildInstructions(role) });
  log.debug(`anywhere MCP server ${version} ready (role ${role}, ${tools.length} tools)`);

  let exiting = false;
  const shutdown = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    server.close();
    if (driverRef && typeof driverRef.close === 'function') {
      await Promise.race([Promise.resolve(driverRef.close()).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    }
    process.exit(code);
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  await server.done;
  await shutdown(0);
}

module.exports = {
  startStdioServer,
  main,
  validateArguments,
  normalizeResult,
  errorResult,
  buildInstructions,
  LATEST_PROTOCOL_VERSION,
  ERR,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`anywhere MCP server failed: ${(err && err.stack) || err}\n`);
    process.exit(1);
  });
}
