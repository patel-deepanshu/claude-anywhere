'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');

const { startStdioServer, validateArguments, normalizeResult, errorResult, buildInstructions, ERR } = require('../src/mcp/server');

const SERVER = path.join(__dirname, '..', 'src', 'mcp', 'server.js');
const hasMockDriver = (() => {
  try {
    return typeof require('../src/os/index').createMockDriver === 'function' && fs.existsSync(path.join(__dirname, '..', 'src', 'os', 'computer.js'));
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------- JSON-RPC client over a child or streams

class RpcPeer {
  constructor(readable, writable) {
    this.writable = writable;
    this.pending = new Map();
    this.timers = new Set();
    this.messages = [];
    this.badLines = [];
    this.nextId = 1;
    let buf = '';
    readable.setEncoding('utf8');
    readable.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.badLines.push(line);
          continue;
        }
        this.messages.push(msg);
        if (!Array.isArray(msg) && msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }

  send(obj) {
    this.writable.write(`${JSON.stringify(obj)}\n`);
  }

  request(method, params, id = this.nextId++) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.pending.delete(id);
        reject(new Error(`no response to ${method} (id ${id})`));
      }, 15000);
      this.timers.add(timer);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        this.timers.delete(timer);
        resolve(msg);
      });
      const msg = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      this.send(msg);
    });
  }

  notify(method, params) {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  /** Forget outstanding requests (their promises stay pending) so no timer keeps the test alive. */
  close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }
}

function spawnServer(t, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-mcp-home-'));
  const env = { ...process.env, ANYWHERE_HOME: home, ANYWHERE_DRIVER: 'mock' };
  delete env.ANYWHERE_DAEMON_URL;
  delete env.ANYWHERE_TOKEN;
  delete env.ANYWHERE_DEBUG;
  delete env.ANYWHERE_ROLE;
  delete env.ANYWHERE_ENGINE_CHILD;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const peer = new RpcPeer(child.stdout, child.stdin);
  t.after(async () => {
    peer.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return { child, peer, exited, stderr: () => stderr };
}

// ---------------------------------------------------------------- spawned server

test('stdio server: discovery probe, initialize, list, ping, unknown tool', async (t) => {
  const { peer, child, exited } = spawnServer(t);

  const probe = await peer.request('server/discover', {}, 'server-discover-probe-1');
  assert.equal(probe.error.code, -32601);
  assert.equal(probe.id, 'server-discover-probe-1');

  const init = await peer.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'anywhere');
  assert.equal(init.result.serverInfo.version, require('../package.json').version);
  assert.match(init.result.instructions, /screenshot/);
  peer.notify('notifications/initialized');

  const older = await peer.request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(older.result.protocolVersion, '2025-06-18');

  const list = await peer.request('tools/list', {});
  const tools = list.result.tools;
  // Spawned without ANYWHERE_ROLE=engine, so the permission_prompt plumbing tool is hidden.
  assert.equal(tools.length, 18);
  assert.ok(!tools.some((t) => t.name === 'permission_prompt'));
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.description.length > 40, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    for (const r of tool.inputSchema.required || []) assert.ok(r in tool.inputSchema.properties, `${tool.name}.${r}`);
    assert.ok(tool.annotations && typeof tool.annotations.readOnlyHint === 'boolean');
    assert.equal(tool.handler, undefined);
  }

  const ping = await peer.request('ping');
  assert.deepEqual(ping.result, {});

  const unknown = await peer.request('tools/call', { name: 'teleport', arguments: {} });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /Unknown tool "teleport"/);

  const bad = await peer.request('tools/call', { name: 'click', arguments: { x: 1 } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /Invalid arguments for click: missing required argument: y/);

  const enumBad = await peer.request('tools/call', { name: 'scroll', arguments: { direction: 'sideways' } });
  assert.match(enumBad.result.content[0].text, /direction must be one of "up", "down", "left", "right"/);

  const resources = await peer.request('resources/list');
  assert.equal(resources.error.code, -32601);

  peer.writable.write('this is not json\n');
  await new Promise((r) => setTimeout(r, 100));
  const parseErr = peer.messages.find((m) => m.error && m.error.code === -32700);
  assert.ok(parseErr, 'parse error reported');
  assert.equal(parseErr.id, null);

  // No response for notifications, and nothing but JSON-RPC on stdout.
  assert.equal(peer.badLines.length, 0, `non-JSON stdout: ${peer.badLines.join(' | ')}`);
  assert.ok(peer.messages.every((m) => m.jsonrpc === '2.0'));
  assert.ok(!peer.messages.some((m) => m.method === 'notifications/initialized'));

  child.stdin.end();
  const { code } = await exited;
  assert.equal(code, 0, 'exits cleanly when stdin ends');
});

test('stdio server: a leftover ANYWHERE_ENGINE_CHILD no longer blanks the tools (DAEMON-PROTOCOL-8, round 2)', async (t) => {
  // The daemon now keeps the plugin copy out of its engine with --disallowedTools, and no
  // longer sets this variable. A VS Code or terminal started from a round-1 daemon can still
  // carry it, and an interactive session there must keep its tools.
  const { peer } = spawnServer(t, { ANYWHERE_ENGINE_CHILD: '1' });
  const init = await peer.request('initialize', { protocolVersion: '2025-11-25' });
  assert.equal(init.result.serverInfo.name, 'anywhere');
  assert.ok(init.result.instructions, 'instructions are served');
  const list = await peer.request('tools/list', {});
  assert.ok(list.result.tools.some((tool) => tool.name === 'screenshot'), 'interactive tools are listed');
  // The daemon's own server (role engine) in the same environment keeps its tools.
  const own = spawnServer(t, { ANYWHERE_ENGINE_CHILD: '1', ANYWHERE_ROLE: 'engine' });
  await own.peer.request('initialize', { protocolVersion: '2025-11-25' });
  const ownList = await own.peer.request('tools/list', {});
  assert.ok(ownList.result.tools.some((tool) => tool.name === 'permission_prompt'));
});

test('stdio server: screenshot and actions through the mock driver', { skip: hasMockDriver ? false : 'mock driver (src/os) not available' }, async (t) => {
  const { peer } = spawnServer(t, { ANYWHERE_ROLE: 'engine' });
  await peer.request('initialize', { protocolVersion: '2025-11-25' });
  const shot = await peer.request('tools/call', { name: 'screenshot', arguments: {} });
  assert.ok(!shot.result.isError, JSON.stringify(shot.result).slice(0, 300));
  const [img, txt] = shot.result.content;
  assert.equal(img.type, 'image');
  assert.equal(img.mimeType, 'image/png');
  const bytes = Buffer.from(img.data, 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.match(txt.text, /Screenshot of display 0 \(primary\) of 2/);

  const click = await peer.request('tools/call', { name: 'click', arguments: { x: '100', y: 200 } });
  assert.equal(click.result.content[0].text, 'Clicked left at (100, 200) on display 0. Take a screenshot to verify.');

  const wins = await peer.request('tools/call', { name: 'list_windows', arguments: {} });
  assert.match(wins.result.content[0].text, /Visual Studio Code/);

  const focus = await peer.request('tools/call', { name: 'focus_window', arguments: { app: 'chrome' } });
  assert.match(focus.result.content[0].text, /^Focused Google Chrome/);

  const ctx = await peer.request('tools/call', { name: 'get_desktop_context', arguments: {} });
  const parsed = JSON.parse(ctx.result.content[0].text);
  assert.ok(Array.isArray(parsed.editors));
  assert.ok(parsed.editors.some((e) => e.app === 'Visual Studio Code'));

  const perm = await peer.request('tools/call', { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'ls' } } });
  assert.deepEqual(JSON.parse(perm.result.content[0].text), { behavior: 'allow', updatedInput: { command: 'ls' } });

  const ask = await peer.request('tools/call', { name: 'ask_user', arguments: { question: 'ok?' } });
  assert.equal(ask.result.isError, true);
  assert.match(ask.result.content[0].text, /not running/);
  assert.equal(peer.badLines.length, 0);
});

test('stdio server: notifications/cancelled aborts the call and suppresses its response', async (t) => {
  const { peer } = spawnServer(t);
  await peer.request('initialize', { protocolVersion: '2025-11-25' });
  const id = 'wait-1';
  let answered = false;
  peer.request('tools/call', { name: 'wait', arguments: { seconds: 10 } }, id).then(() => {
    answered = true;
  }, () => {});
  await new Promise((r) => setTimeout(r, 150));
  peer.notify('notifications/cancelled', { requestId: id, reason: 'user interrupted' });
  const ping = await peer.request('ping');
  assert.deepEqual(ping.result, {});
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(answered, false, 'cancelled requests get no response');
  const quick = await peer.request('tools/call', { name: 'wait', arguments: { seconds: 0.01 } });
  assert.match(quick.result.content[0].text, /^Waited 0\.01 s/);
});

// ---------------------------------------------------------------- in-process server

function inProcess(t, tools, extra = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const logs = [];
  const log = { debug: () => {}, info: () => {}, warn: (...a) => logs.push(a), error: (...a) => logs.push(a) };
  const server = startStdioServer({ name: 'test', version: '9.9.9', tools, log, input, output, ...extra });
  const peer = new RpcPeer(output, input);
  t.after(() => {
    peer.close();
    server.close();
  });
  return { server, peer, input, logs };
}

test('handlers receive progress, signal and validated args; errors carry hints', async (t) => {
  let seen = null;
  const tools = [
    {
      name: 'slow',
      description: 'slow tool',
      inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 5 }, flag: { type: 'boolean' }, list: { type: 'array', items: { type: 'string' } }, obj: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] } }, required: ['n'] },
      handler: async (args, extra) => {
        seen = { args, hasSignal: extra.signal instanceof AbortSignal, token: extra.progressToken };
        extra.sendProgress('step one');
        extra.sendProgress('step two');
        return 'done';
      },
    },
    {
      name: 'boom',
      description: 'throws',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const err = new Error('xdotool is missing');
        err.hint = 'Install xdotool: sudo apt install xdotool';
        throw err;
      },
    },
    { name: 'obj', description: 'object result', inputSchema: { type: 'object', properties: {} }, handler: async () => ({ a: 1 }) },
    { name: 'raw', description: 'content result', inputSchema: { type: 'object', properties: {} }, handler: async () => ({ content: [{ type: 'text', text: 'x' }], isError: true }) },
  ];
  const { peer, server } = inProcess(t, tools, { instructions: 'hello' });

  const init = await peer.request('initialize', { protocolVersion: '2099-01-01' });
  assert.equal(init.result.protocolVersion, '2099-01-01');
  assert.equal(init.result.instructions, 'hello');
  assert.deepEqual(init.result.serverInfo, { name: 'test', version: '9.9.9' });

  const res = await peer.request('tools/call', { name: 'slow', arguments: { n: '3', flag: 'true', list: 'one', obj: '{"a":"2"}' }, _meta: { progressToken: 'tok-7' } });
  assert.deepEqual(res.result, { content: [{ type: 'text', text: 'done' }], isError: false });
  assert.deepEqual(seen.args, { n: 3, flag: true, list: ['one'], obj: { a: 2 } });
  assert.equal(seen.hasSignal, true);
  assert.equal(seen.token, 'tok-7');
  const progress = peer.messages.filter((m) => m.method === 'notifications/progress');
  assert.deepEqual(progress.map((m) => m.params), [
    { progressToken: 'tok-7', progress: 1, message: 'step one' },
    { progressToken: 'tok-7', progress: 2, message: 'step two' },
  ]);

  // Without a progress token, sendProgress is a no-op.
  await peer.request('tools/call', { name: 'slow', arguments: { n: 1 } });
  assert.equal(peer.messages.filter((m) => m.method === 'notifications/progress').length, 2);

  const range = await peer.request('tools/call', { name: 'slow', arguments: { n: 9 } });
  assert.match(range.result.content[0].text, /n must be at most 5 \(got 9\)/);
  const nested = await peer.request('tools/call', { name: 'slow', arguments: { n: 1, obj: {} } });
  assert.match(nested.result.content[0].text, /missing required argument: obj\.a/);

  const boom = await peer.request('tools/call', { name: 'boom', arguments: {} });
  assert.equal(boom.result.isError, true);
  assert.equal(boom.result.content[0].text, 'Error: xdotool is missing\nHint: Install xdotool: sudo apt install xdotool');

  const obj = await peer.request('tools/call', { name: 'obj' });
  assert.equal(obj.result.content[0].text, '{\n  "a": 1\n}');
  const raw = await peer.request('tools/call', { name: 'raw', arguments: {} });
  assert.deepEqual(raw.result, { content: [{ type: 'text', text: 'x' }], isError: true });

  // Batches, invalid requests and stray responses.
  peer.send([{ jsonrpc: '2.0', id: 'b1', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b2', method: 'nope' }]);
  peer.send({ jsonrpc: '2.0', id: 'r1', result: {} });
  peer.send({ jsonrpc: '2.0', id: 'x1' });
  await new Promise((r) => setTimeout(r, 50));
  const batch = peer.messages.find((m) => Array.isArray(m));
  assert.deepEqual(batch.map((m) => m.id), ['b1', 'b2']);
  assert.equal(batch[1].error.code, ERR.METHOD_NOT_FOUND);
  const invalid = peer.messages.find((m) => m.id === 'x1');
  assert.equal(invalid.error.code, ERR.INVALID_REQUEST);
  assert.ok(!peer.messages.some((m) => m.id === 'r1'));
  assert.equal(server.inflight(), 0);
});

test('input end aborts in-flight handlers and resolves done', async (t) => {
  let aborted = false;
  const tools = [
    {
      name: 'block',
      description: 'blocks until aborted',
      inputSchema: { type: 'object', properties: {} },
      handler: (args, extra) =>
        new Promise((resolve, reject) => {
          extra.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    },
  ];
  const { peer, server, input } = inProcess(t, tools);
  peer.request('tools/call', { name: 'block', arguments: {} }, 'blk').catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(server.inflight(), 1);
  input.end();
  await server.done;
  assert.equal(aborted, true);
  assert.ok(!peer.messages.some((m) => m.id === 'blk'));
});

test('handles CRLF, split chunks and multi-byte characters across chunks', async (t) => {
  const tools = [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { s: { type: 'string' } }, required: ['s'] }, handler: async (a) => a.s }];
  const { peer, input } = inProcess(t, tools);
  const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'u', method: 'tools/call', params: { name: 'echo', arguments: { s: 'héllo \u{1F600} 世界' } } })}\r\n`);
  const done = new Promise((resolve) => {
    peer.pending.set('u', resolve);
  });
  for (let i = 0; i < line.length; i += 3) input.write(line.subarray(i, i + 3));
  const res = await done;
  assert.equal(res.result.content[0].text, 'héllo \u{1F600} 世界');
});

test('startStdioServer rejects bad tool definitions', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  assert.throws(() => startStdioServer({ tools: [{ name: 'x' }], input, output }), /needs a name and a handler/);
  const h = async () => 'ok';
  assert.throws(
    () => startStdioServer({ tools: [{ name: 'x', handler: h }, { name: 'x', handler: h }], input, output }),
    /duplicate tool name/
  );
});

// ---------------------------------------------------------------- helpers

test('validateArguments coerces common model mistakes and reports clearly', () => {
  const schema = {
    type: 'object',
    properties: {
      x: { type: 'number', minimum: 0 },
      button: { type: 'string', enum: ['left', 'right'] },
      mods: { type: 'array', items: { type: 'string' } },
      opt: { type: 'string' },
    },
    required: ['x'],
  };
  assert.deepEqual(validateArguments(schema, { x: '12.5', button: 'LEFT', opt: null }), { value: { x: 12.5, button: 'left' }, errors: [] });
  assert.deepEqual(validateArguments(schema, '{"x":1}').value, { x: 1 });
  assert.deepEqual(validateArguments(schema, { x: 1, mods: '["ctrl","shift"]' }).value.mods, ['ctrl', 'shift']);
  assert.match(validateArguments(schema, {}).errors[0], /missing required argument: x/);
  assert.match(validateArguments(schema, { x: 'abc' }).errors[0], /x must be a number \(got "abc"\)/);
  assert.match(validateArguments(schema, { x: -1 }).errors[0], /x must be at least 0/);
  assert.match(validateArguments(schema, [1]).errors[0], /must be a JSON object/);
  assert.deepEqual(validateArguments(schema, { x: 1, extra: true }).value, { x: 1, extra: true });
  assert.deepEqual(validateArguments({ type: 'object', properties: { n: { type: 'integer' } } }, { n: 2.5 }).errors, ['n must be a whole number (got 2.5)']);
});

test('normalizeResult, errorResult and instructions', () => {
  assert.deepEqual(normalizeResult(undefined), { content: [{ type: 'text', text: 'Done.' }], isError: false });
  assert.deepEqual(normalizeResult([{ type: 'text', text: 'a' }]), { content: [{ type: 'text', text: 'a' }], isError: false });
  assert.deepEqual(errorResult(new Error('Error: already prefixed')).content[0].text, 'Error: already prefixed');
  assert.deepEqual(errorResult('plain').content[0].text, 'Error: plain');
  assert.match(buildInstructions('interactive'), /normal reply/);
  assert.doesNotMatch(buildInstructions('engine'), /normal reply/);
  assert.match(buildInstructions('engine'), /primary/);
});
