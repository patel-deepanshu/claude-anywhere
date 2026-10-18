#!/usr/bin/env node
'use strict';

/**
 * A stand-in for `claude -p --input-format stream-json --output-format stream-json
 * --verbose --include-partial-messages`, used by the daemon tests.
 *
 * It speaks the verified stream-json protocol: system/init, stream_event deltas,
 * assistant, user (tool_result) and result lines, plus control_request interrupts.
 * Keywords in the user's last text block select behaviours:
 *   TOOL_TEST        Bash tool_use + tool_result, then text
 *   APPROVE_TEST     calls the MCP tool permission_prompt → "DECISION: <behavior>"
 *   ASK_TEST         calls the MCP tool ask_user → "ANSWER: <text>"
 *   SCREENSHOT_TEST  calls the MCP tool screenshot → tool_result with the image
 *   SLOW_TEST        deltas every 300 ms for 15 s, honouring interrupts
 *   CRASH_TEST       exits 1 with a stderr message
 *   NOISE_TEST       prints a non-JSON stdout line before answering
 * Startup: --resume missing* → an error result before any init (like claude 2.1.x), then
 *   "No conversation found with session ID" on stderr and exit 1.
 * An interrupt while idle is answered with a control_response only ({still_queued: []}).
 * FAKE_CLAUDE_ARGS_FILE (env) gets one JSON line per launch: {argv, cwd, env}.
 * total_cost_usd is cumulative per process (0.001 per turn), like the real CLI.
 */

const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);

if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('0.0.0-fake (Claude Code)\n');
  process.exit(0);
}

function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function argValues(name) {
  // Variadic flags (--add-dir) take every following non-flag argument.
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== name) continue;
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j += 1) out.push(argv[j]);
  }
  return out;
}

const opts = {
  sessionId: argValue('--session-id'),
  resume: argValue('--resume'),
  mcpConfig: argValue('--mcp-config'),
  systemPromptFile: argValue('--append-system-prompt-file'),
  allowedTools: argValue('--allowedTools'),
  model: argValue('--model'),
  addDirs: argValues('--add-dir'),
};

if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  const record = {
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    env: {
      MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT,
      CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS,
      CLAUDECODE: process.env.CLAUDECODE,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    },
  };
  fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, `${JSON.stringify(record)}\n`);
}

if (opts.resume && opts.resume.startsWith('missing')) {
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, num_turns: 0, total_cost_usd: 0, session_id: opts.resume })}\n`);
  process.stderr.write(`No conversation found with session ID: ${opts.resume}\n`);
  process.exit(1);
}

const sessionId = opts.resume || opts.sessionId || crypto.randomUUID();
const model = 'fake-model';

let mcpServers = {};
if (opts.mcpConfig) {
  try {
    const parsed = JSON.parse(fs.readFileSync(opts.mcpConfig, 'utf8'));
    mcpServers = (parsed && parsed.mcpServers) || {};
  } catch (err) {
    process.stderr.write(`fake-claude: cannot read --mcp-config ${opts.mcpConfig}: ${err.message}\n`);
  }
}

function out(obj) {
  process.stdout.write(`${JSON.stringify({ parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID(), ...obj })}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emitInit() {
  out({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    model,
    tools: ['Bash', 'Read', 'Edit', 'Write', ...Object.keys(mcpServers).map((n) => `mcp__${n}__screenshot`)],
    mcp_servers: Object.keys(mcpServers).map((name) => ({ name, status: 'connected' })),
    permissionMode: 'default',
    apiKeySource: 'none',
  });
}

// ------------------------------------------------------------------ MCP client

let mcp = null;

function startMcp() {
  if (mcp) return mcp;
  const names = Object.keys(mcpServers);
  const name = names.includes('anywhere') ? 'anywhere' : names[0];
  if (!name) throw new Error('no MCP server in --mcp-config');
  const def = mcpServers[name];
  const child = spawn(def.command, def.args || [], {
    env: { ...process.env, ...(def.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        p(msg);
      } else if (msg.id != null && msg.method) {
        // Server → client request (ping/roots): answer minimally.
        const reply = msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
        child.stdin.write(`${JSON.stringify(reply)}\n`);
      }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('exit', (code) => {
    for (const p of pending.values()) p({ error: { code: -32000, message: `MCP server exited (${code})` } });
    pending.clear();
    mcp = null;
  });
  child.on('error', (err) => {
    for (const p of pending.values()) p({ error: { code: -32000, message: err.message } });
    pending.clear();
    mcp = null;
  });
  let nextId = 1;
  const request = (method, params, { id, timeoutMs = 3600000 } = {}) =>
    new Promise((resolve) => {
      const rid = id != null ? id : nextId++;
      const timer = setTimeout(() => {
        pending.delete(rid);
        resolve({ error: { code: -32001, message: `${method} timed out` } });
      }, timeoutMs);
      pending.set(rid, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`);
    });
  const ready = (async () => {
    await request('server/discover', {}, { id: 'server-discover-probe-1', timeoutMs: 10000 });
    const init = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'fake-claude', version: '0.0.0' },
    }, { timeoutMs: 15000 });
    if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  })();
  let progress = 1;
  mcp = {
    child,
    async call(tool, args) {
      await ready;
      const res = await request('tools/call', { name: tool, arguments: args, _meta: { progressToken: progress++ } });
      if (res.error) throw new Error(res.error.message);
      return res.result;
    },
  };
  return mcp;
}

function textOf(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
}

process.on('exit', () => {
  if (mcp && mcp.child) {
    try {
      mcp.child.kill();
    } catch {
      /* ignore */
    }
  }
});

// ------------------------------------------------------------------ turns

let turns = 0;
let interruptRequested = false;
let busy = false;
const queue = [];

function messageId() {
  return `msg_fake_${crypto.randomBytes(6).toString('hex')}`;
}

function chunks(text, n) {
  const chars = Array.from(text);
  const size = Math.max(1, Math.ceil(chars.length / n));
  const outChunks = [];
  for (let i = 0; i < chars.length; i += size) outChunks.push(chars.slice(i, i + size).join(''));
  return outChunks.length ? outChunks : [''];
}

function streamText(text, { id = messageId(), split = 3 } = {}) {
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [] } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const c of chunks(text, split)) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } } });
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }] } });
}

function toolUse(id, name, input) {
  const mid = messageId();
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: mid, type: 'message', role: 'assistant', model, content: [] } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { id: mid, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id, name, input }] } });
}

function toolResult(id, content, isError = false) {
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
}

function result(text, { isError = false, subtype = 'success', started }) {
  turns += 1;
  out({
    type: 'result',
    subtype,
    is_error: isError,
    result: text,
    total_cost_usd: Math.round(turns * 0.001 * 1e6) / 1e6,
    duration_ms: Date.now() - started,
    duration_api_ms: Date.now() - started,
    num_turns: 1,
    session_id: sessionId,
  });
}

async function slowTurn(started) {
  const id = messageId();
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [] } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  let text = '';
  const until = Date.now() + 15000;
  let n = 0;
  while (Date.now() < until) {
    if (interruptRequested) break;
    const piece = `tick ${n} `;
    n += 1;
    text += piece;
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
    await sleep(300);
  }
  if (interruptRequested) {
    interruptRequested = false;
    out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }] } });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    result('', { subtype: 'error_during_execution', started });
    return;
  }
  out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }] } });
  result(text, { started });
}

async function runTurn(msg) {
  const started = Date.now();
  if (turns > 0) emitInit(); // the real CLI repeats init on every turn
  const content = (msg.message && msg.message.content) || [];
  const texts = (Array.isArray(content) ? content : [{ type: 'text', text: String(content) }]).filter((b) => b && b.type === 'text');
  const last = texts.length ? texts[texts.length - 1].text : '';
  const images = Array.isArray(content) ? content.filter((b) => b && b.type === 'image').length : 0;

  if (/CRASH_TEST/.test(last)) {
    process.stderr.write('fake-claude: simulated crash (CRASH_TEST)\n');
    process.exit(1);
  }
  if (/SLOW_TEST/.test(last)) {
    await slowTurn(started);
    return;
  }
  if (/NOISE_TEST/.test(last)) {
    process.stdout.write('this line is not JSON\n');
    process.stdout.write('{broken json\n');
  }
  if (/TOOL_TEST/.test(last)) {
    toolUse('toolu_fake_ls', 'Bash', { command: 'ls' });
    toolResult('toolu_fake_ls', 'file1.txt\nfile2.txt');
    streamText('Listed 2 files.');
    result('Listed 2 files.', { started });
    return;
  }
  if (/APPROVE_TEST/.test(last)) {
    toolUse('toolu_fake1', 'Bash', { command: 'rm -rf build' });
    let decision;
    try {
      const res = await startMcp().call('permission_prompt', { tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_fake1' });
      decision = JSON.parse(textOf(res));
    } catch (err) {
      toolResult('toolu_fake1', `MCP ERROR: ${err.message}`, true);
      streamText(`MCP ERROR: ${err.message}`);
      result(`MCP ERROR: ${err.message}`, { isError: true, started });
      return;
    }
    if (decision.behavior === 'allow') toolResult('toolu_fake1', '(fake) removed build/');
    else toolResult('toolu_fake1', decision.message || 'Permission denied', true);
    const text = `DECISION: ${decision.behavior}`;
    streamText(text);
    result(text, { started });
    return;
  }
  if (/ASK_TEST/.test(last)) {
    toolUse('toolu_fake_ask', 'mcp__anywhere__ask_user', { question: 'Pick one', options: ['A', 'B'] });
    let answer;
    try {
      const res = await startMcp().call('ask_user', { question: 'Pick one', options: ['A', 'B'] });
      answer = textOf(res);
      toolResult('toolu_fake_ask', answer, Boolean(res && res.isError));
    } catch (err) {
      answer = `MCP ERROR: ${err.message}`;
      toolResult('toolu_fake_ask', answer, true);
    }
    const text = `ANSWER: ${answer}`;
    streamText(text);
    result(text, { started });
    return;
  }
  if (/SCREENSHOT_TEST/.test(last)) {
    toolUse('toolu_fake_shot', 'mcp__anywhere__screenshot', {});
    try {
      const res = await startMcp().call('screenshot', {});
      const blocks = [];
      for (const b of (res && res.content) || []) {
        if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: b.mimeType || 'image/png', data: b.data } });
      }
      toolResult('toolu_fake_shot', blocks, Boolean(res && res.isError));
      const text = `SCREENSHOT: ${blocks.some((b) => b.type === 'image') ? 'ok' : 'no image'}`;
      streamText(text);
      result(text, { started });
    } catch (err) {
      toolResult('toolu_fake_shot', `MCP ERROR: ${err.message}`, true);
      streamText(`MCP ERROR: ${err.message}`);
      result(`MCP ERROR: ${err.message}`, { isError: true, started });
    }
    return;
  }
  const reply = `Echo: ${last}${images ? ` [${images} image${images === 1 ? '' : 's'}]` : ''}`;
  streamText(reply);
  result(reply, { started });
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const msg = queue.shift();
      interruptRequested = false;
      try {
        await runTurn(msg);
      } catch (err) {
        process.stderr.write(`fake-claude: turn failed: ${err.stack || err.message}\n`);
        result(`fake-claude error: ${err.message}`, { isError: true, subtype: 'error_during_execution', started: Date.now() });
      }
    }
  } finally {
    busy = false;
    if (stdinEnded) shutdown(0);
  }
}

function handleLine(line) {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    process.stderr.write(`fake-claude: ignoring bad input line: ${t.slice(0, 80)}\n`);
    return;
  }
  if (msg.type === 'control_request') {
    if (msg.request && msg.request.subtype === 'interrupt') {
      if (busy) interruptRequested = true;
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: busy ? {} : { still_queued: [] } } });
    } else {
      out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'unsupported' } });
    }
    return;
  }
  if (msg.type === 'user') {
    queue.push(msg);
    pump();
  }
}

let stdinEnded = false;
function shutdown(code) {
  if (mcp && mcp.child) {
    try {
      mcp.child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exitCode = code;
  setImmediate(() => process.exit(code));
}

emitInit();

let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i);
    inBuf = inBuf.slice(i + 1);
    handleLine(line);
  }
});
process.stdin.on('end', () => {
  if (inBuf.trim()) handleLine(inBuf);
  stdinEnded = true;
  if (!busy && !queue.length) shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
