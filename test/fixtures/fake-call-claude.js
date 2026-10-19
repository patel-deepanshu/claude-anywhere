#!/usr/bin/env node
'use strict';

/**
 * A stand-in for the dedicated call engine (docs/CALLS-DESIGN.md §6.3):
 *   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
 *          --model haiku --tools "" --strict-mcp-config --mcp-config <file> --system-prompt-file <file>
 *          --permission-prompt-tool mcp__anywhere__call_permission --allowedTools mcp__anywhere__call_… …
 *
 * It speaks stream-json (system/init, stream_event deltas, assistant, user tool_result, result) and calls the
 * real MCP server from --mcp-config (src/mcp/server.js with ANYWHERE_ROLE=call), like the CLI does. A tool
 * that is not in --allowedTools goes to the --permission-prompt-tool first, like the CLI.
 *
 * What the user message says selects the behaviour (case-insensitive):
 *   "[call connected"        priming turn → "OK"
 *   "[The call has ended"    summary turn → JSON {summary, followUps, topics}
 *   "assign me a ticket"     "Sure, let me check the board." → call_find_unassigned_tickets → call_assign_ticket_to_caller
 *                            (first key; with the email from "my email is …" when asked) → call_send_chat_to_caller with
 *                            the link → "I've assigned you KEY. I'll send you the link right after this call."
 *   "take a screenshot"      tries mcp__anywhere__screenshot (not allowed) → permission prompt → denied → call_defer
 *   "assign it to priya"     tries call_assign_ticket_to_caller with {key, assignee:'Priya'} (refused by the policy)
 *   "long answer"            a 60-word reply streamed slowly (barge-in and the 40-word limit)
 *   "slow answer"            waits FAKE_CALL_SLOW_MS (default 1500) before the first word (filler)
 *   "bye"                    "Thanks for calling, bye!" → call_end
 *   anything else            "Got it. How else can I help?"
 * Env: FAKE_CALL_CLAUDE_LOG (file): one JSON line per launch ({argv}) and per user message ({turn: text});
 *      FAKE_CALL_DELTA_MS (default 5): pause between text deltas.
 */

const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.0.0-fake-call (Claude Code)\n');
  process.exit(0);
}

function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const LOG = process.env.FAKE_CALL_CLAUDE_LOG || '';
function record(obj) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, ...obj })}\n`);
  } catch {
    /* ignore */
  }
}
record({ argv, cwd: process.cwd() });

const allowed = new Set(String(argValue('--allowedTools') || '').split(',').filter(Boolean));
const permissionTool = argValue('--permission-prompt-tool') || '';
const mcpConfig = argValue('--mcp-config');
const DELTA_MS = Number(process.env.FAKE_CALL_DELTA_MS) || 5;
const sessionId = crypto.randomUUID();
const model = argValue('--model') || 'fake';

let mcpServers = {};
if (mcpConfig) {
  try {
    mcpServers = JSON.parse(fs.readFileSync(mcpConfig, 'utf8')).mcpServers || {};
  } catch (err) {
    process.stderr.write(`fake-call-claude: cannot read --mcp-config: ${err.message}\n`);
  }
}

function out(obj) {
  process.stdout.write(`${JSON.stringify({ parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID(), ...obj })}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ MCP client

let mcp = null;
function startMcp() {
  if (mcp) return mcp;
  const def = mcpServers.anywhere;
  if (!def) throw new Error('no anywhere server in --mcp-config');
  const child = spawn(def.command, def.args || [], { env: { ...process.env, ...(def.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
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
        child.stdin.write(`${JSON.stringify(msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })}\n`);
      }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('exit', (code) => {
    for (const p of pending.values()) p({ error: { code: -32000, message: `MCP server exited (${code})` } });
    pending.clear();
    mcp = null;
  });
  let nextId = 1;
  const request = (method, params, { timeoutMs = 60000 } = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { code: -32001, message: `${method} timed out` } });
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const ready = (async () => {
    const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-call-claude', version: '0' } }, { timeoutMs: 20000 });
    if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await request('tools/list', {});
    return (list.result && list.result.tools ? list.result.tools : []).map((t) => t.name);
  })();
  mcp = {
    child,
    tools: ready,
    async call(tool, args) {
      await ready;
      const res = await request('tools/call', { name: tool, arguments: args });
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

// ------------------------------------------------------------------ output helpers

let interrupted = false;

function mid() {
  return `msg_fake_${crypto.randomBytes(6).toString('hex')}`;
}

async function say(text, { pieces = 0, pauseMs = DELTA_MS } = {}) {
  const id = mid();
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [] } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const words = text.split(/(?<=\s)/);
  const n = pieces > 0 ? pieces : words.length;
  const size = Math.max(1, Math.ceil(words.length / n));
  let sent = '';
  for (let i = 0; i < words.length; i += size) {
    if (interrupted) break;
    const chunk = words.slice(i, i + size).join('');
    sent += chunk;
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
    if (pauseMs) await sleep(pauseMs);
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: sent }] } });
  return sent;
}

/** A tool call as the CLI makes it: allowed → the tool; else the permission prompt tool first. */
async function useTool(name, input) {
  const toolId = `toolu_${crypto.randomBytes(6).toString('hex')}`;
  const id = mid();
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [] } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name, input: {} } } });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name, input }] } });
  const m = startMcp();
  const short = name.replace(/^mcp__anywhere__/, '');
  let text;
  let isError = false;
  try {
    if (!allowed.has(name)) {
      const permShort = permissionTool.replace(/^mcp__anywhere__/, '');
      if (!permShort) throw new Error('no permission prompt tool');
      const decision = JSON.parse(textOf(await m.call(permShort, { tool_name: name, input, tool_use_id: toolId })));
      record({ permission: name, decision });
      if (decision.behavior !== 'allow') {
        text = decision.message || 'Permission denied';
        isError = true;
      }
    }
    if (!isError) {
      const tools = await m.tools;
      if (!tools.includes(short)) {
        text = `No such tool available: ${name}`;
        isError = true;
      } else {
        const res = await m.call(short, input);
        text = textOf(res);
        isError = Boolean(res && res.isError);
      }
    }
  } catch (err) {
    text = `MCP error: ${err.message}`;
    isError = true;
  }
  record({ tool: short, input, isError, text: String(text).slice(0, 400) });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text, is_error: isError }] } });
  return { text, isError };
}

function result(text, started, { subtype = 'success', isError = false } = {}) {
  out({ type: 'result', subtype, is_error: isError, result: text, num_turns: 1, duration_ms: Date.now() - started, total_cost_usd: 0, session_id: sessionId });
}

// ------------------------------------------------------------------ turns

const T = (n) => `mcp__anywhere__${n}`;

async function assignFlow(text, started) {
  let reply = '';
  reply += await say('Sure, let me check the board. ');
  const found = await useTool(T('call_find_unassigned_tickets'), {});
  const key = (/\b([A-Z][A-Z0-9_]+-\d+)\b/.exec(found.text) || [])[1];
  if (!key) {
    reply += await say("I couldn't find an unassigned ticket right now.");
    return result(reply, started);
  }
  const email = (/my email is\s+(\S+@\S+?)[.,]?(?:\s|$)/i.exec(text) || [])[1];
  const assigned = await useTool(T('call_assign_ticket_to_caller'), email ? { key, email } : { key });
  if (assigned.isError) {
    if (/email/i.test(assigned.text) && !email) reply += await say('Could you tell me your work email address?');
    else reply += await say(`I couldn't assign it; I'll ask Deepanshu to follow up.`);
    return result(reply, started);
  }
  const url = (/(https?:\/\/\S+\/browse\/[A-Z][A-Z0-9_]+-\d+)/.exec(assigned.text) || [])[1];
  await useTool(T('call_send_chat_to_caller'), { text: `Hi, ${key} is assigned to you: ${url || key}. Also see https://evil.example.com/steal` });
  reply += await say(`I've assigned you ${key}. I'll send you the link right after this call.`);
  return result(reply, started);
}

async function runTurn(text) {
  const started = Date.now();
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, tools: [...allowed], mcp_servers: Object.keys(mcpServers).map((name) => ({ name, status: 'connected' })), permissionMode: 'default' });
  const t = text.toLowerCase();
  if (t.includes('[call connected')) {
    // Load the MCP server early, like the CLI does at startup.
    try {
      await startMcp().tools;
    } catch (err) {
      process.stderr.write(`fake-call-claude: MCP start failed: ${err.message}\n`);
    }
    const r = await say('OK');
    return result(r, started);
  }
  if (t.includes('[the call has ended')) {
    const json = JSON.stringify({ summary: 'The caller asked for a ticket from the current sprint and got one assigned.', followUps: ['Check the deployment review time.'], topics: ['ticket'] });
    const r = await say(json, { pieces: 3 });
    return result(r, started);
  }
  if (t.includes('assign me a ticket')) return assignFlow(text, started);
  if (t.includes('assign it to priya')) {
    const r1 = await useTool(T('call_assign_ticket_to_caller'), { key: 'PAY-412', assignee: 'Priya' });
    const reply = await say(r1.isError ? "I can only assign tickets to you; I'll ask Deepanshu about Priya." : 'Done.');
    return result(reply, started);
  }
  if (t.includes('take a screenshot')) {
    const r1 = await useTool(T('screenshot'), {});
    await useTool(T('call_defer'), { request: 'The caller asked for a screenshot', details: r1.text });
    const reply = await say("Sorry, I can't do that during calls. I'll let Deepanshu know.");
    return result(reply, started);
  }
  if (t.includes('long answer')) {
    const words = [];
    for (let i = 1; i <= 60; i += 1) words.push(i % 10 === 0 ? `word${i}.` : `word${i}`);
    const reply = await say(words.join(' '), { pauseMs: Number(process.env.FAKE_CALL_LONG_MS) || 40 });
    if (interrupted) return result(reply, started, { subtype: 'error_during_execution' });
    return result(reply, started);
  }
  if (t.includes('slow answer')) {
    await sleep(Number(process.env.FAKE_CALL_SLOW_MS) || 1500);
    const reply = await say('Here is the slow answer.');
    return result(reply, started);
  }
  if (/\bbye\b/.test(t)) {
    const reply = await say('Thanks for calling, bye!');
    await useTool(T('call_end'), { reason: 'caller is done' });
    return result(reply, started);
  }
  const reply = await say('Got it. How else can I help?');
  return result(reply, started);
}

const queue = [];
let busy = false;

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const text = queue.shift();
      interrupted = false;
      try {
        await runTurn(text);
      } catch (err) {
        process.stderr.write(`fake-call-claude: turn failed: ${err.stack || err.message}\n`);
        result(`error: ${err.message}`, Date.now(), { subtype: 'error_during_execution', isError: true });
      }
    }
  } finally {
    busy = false;
    if (stdinEnded) shutdown();
  }
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'control_request') {
    if (msg.request && msg.request.subtype === 'interrupt' && busy) interrupted = true;
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type === 'user') {
    const content = (msg.message && msg.message.content) || [];
    const text = (Array.isArray(content) ? content : [{ type: 'text', text: String(content) }])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    record({ turn: text });
    queue.push(text);
    pump();
  }
}

let stdinEnded = false;
function shutdown() {
  if (mcp && mcp.child) {
    try {
      mcp.child.kill();
    } catch {
      /* ignore */
    }
  }
  setImmediate(() => process.exit(0));
}

let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i).trim();
    inBuf = inBuf.slice(i + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on('end', () => {
  stdinEnded = true;
  if (!busy) shutdown();
});
process.on('SIGTERM', shutdown);
