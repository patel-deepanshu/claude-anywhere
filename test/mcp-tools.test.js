'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-tools-home-'));
process.env.ANYWHERE_HOME = tmpHome;
delete process.env.ANYWHERE_DAEMON_URL;
delete process.env.ANYWHERE_TOKEN;

const { createTools, TOOL_NAMES, daemonRequest, matchWindows, describeShot, NO_DIALOG_MESSAGE } = require('../src/mcp/tools');
const { DaemonClient } = require('../src/shared/client');

const TOKEN = 'test-token-123';
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a5f5d3b50000000049454e44ae426082', 'hex');

test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

// ---------------------------------------------------------------- fakes

function startDaemon() {
  const state = {
    guard: { allowed: true },
    guardDelayMs: 0,
    guardStatus: 200,
    guardCalls: 0,
    activities: [],
    notifications: [],
    notifyResponse: { ok: true, delivered: true },
    asks: [],
    askResponse: { answer: 'us-central1' },
    askDelayMs: 0,
    askClosed: 0,
    permissions: [],
    permissionResponse: null,
    permissionStatus: 200,
    unauthorized: 0,
  };
  const timers = new Set();
  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      state.unauthorized += 1;
      send(401, { error: 'unauthorized' });
      return;
    }
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url;
      if (req.method === 'GET' && url === '/api/mcp/guard') {
        state.guardCalls += 1;
        later(() => send(state.guardStatus, state.guard), state.guardDelayMs);
      } else if (req.method === 'POST' && url === '/api/mcp/activity') {
        state.activities.push(body);
        send(200, { ok: true });
      } else if (req.method === 'POST' && url === '/api/mcp/notify') {
        state.notifications.push(body);
        send(200, state.notifyResponse);
      } else if (req.method === 'POST' && url === '/api/mcp/ask') {
        state.asks.push(body);
        let finished = false;
        res.on('close', () => {
          if (!finished) state.askClosed += 1;
        });
        later(() => {
          finished = true;
          if (!res.destroyed) send(200, state.askResponse);
        }, state.askDelayMs);
      } else if (req.method === 'POST' && url === '/api/mcp/permission') {
        state.permissions.push(body);
        if (state.permissionStatus !== 200) send(state.permissionStatus, { error: 'broker exploded' });
        else send(200, state.permissionResponse || { behavior: 'allow', updatedInput: body.input });
      } else {
        send(404, { error: 'not found' });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve({
        state,
        baseUrl,
        getClient: async () => new DaemonClient({ baseUrl, token: TOKEN }),
        close: () =>
          new Promise((r) => {
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            server.close(r);
            server.closeAllConnections();
          }),
      });
    });
  });
}

function fakeComputer() {
  const calls = [];
  const driver = {
    name: 'fake',
    windows: [
      { id: '0x01a00003', app: 'Visual Studio Code', title: 'server.js - shop-api - Visual Studio Code', pid: 10, x: 0, y: 0, width: 1200, height: 800, focused: true },
      { id: '0x01c00007', app: 'Google Chrome', title: 'Cloud Run – my-proj – Google Cloud console - Google Chrome', pid: 11, x: 0, y: 0, width: 1200, height: 800 },
      { id: '0x01c00009', app: 'Google Chrome', title: 'Inbox - Gmail - Google Chrome', pid: 11, x: 0, y: 0, width: 1200, height: 800, minimized: false },
      { id: '0x02000001', app: 'Claude Anywhere', title: 'Claude Anywhere', pid: 12 },
      { id: '0x02000005', app: 'Slack', title: 'deploys - Slack', pid: 13, minimized: true },
    ],
    clipboard: 'copied text',
    focusResult: true,
    async listWindows() {
      return this.windows.map((w) => ({ ...w }));
    },
    async activeWindow() {
      const w = this.windows.find((x) => x.focused);
      return w ? { id: w.id, app: w.app, title: w.title, pid: w.pid } : null;
    },
    async focusWindow(id) {
      calls.push(['focusWindow', id]);
      return this.focusResult;
    },
    async clipboardGet() {
      return this.clipboard;
    },
    async clipboardSet(t) {
      calls.push(['clipboardSet', t]);
      this.clipboard = t;
    },
    async capabilities() {
      return { screenshot: true, mouse: true, keyboard: true, windows: true, clipboard: true, notify: false, speak: false, notes: ['fake driver'] };
    },
  };
  const comp = {
    driver,
    calls,
    fail: null,
    async screenshot(o) {
      calls.push(['screenshot', o]);
      if (o.region) {
        return { png: PNG_1PX, width: 400, height: 200, display: 0, displays: 2, scale: 0.5, native: { width: 400, height: 200 }, region: { ...o.region }, cursor: null };
      }
      return { png: PNG_1PX, width: 1366, height: 768, display: o.display || 0, displays: 2, scale: 1.406, native: { width: 1920, height: 1080 }, region: null, cursor: { x: 10, y: 20 } };
    },
    async click(o) {
      calls.push(['click', o]);
      if (this.fail) throw this.fail;
      return { ok: true, action: 'click', x: o.x, y: o.y, display: o.display || 0, button: o.button, clicks: o.clicks, modifiers: o.modifiers };
    },
    async moveMouse(o) {
      calls.push(['moveMouse', o]);
      return { ok: true, x: o.x, y: o.y, display: 0 };
    },
    async drag(o) {
      calls.push(['drag', o]);
      return { ok: true, from: { x: o.fromX, y: o.fromY }, to: { x: o.toX, y: o.toY }, display: 0, button: o.button };
    },
    async scroll(o) {
      calls.push(['scroll', o]);
      return { ok: true, direction: o.direction, amount: o.amount, x: o.x == null ? 50 : o.x, y: o.y == null ? 60 : o.y, display: 0 };
    },
    async typeText(o) {
      calls.push(['typeText', o]);
      return { ok: true, method: o.text.length > 20 ? 'paste' : 'keys', chars: Array.from(o.text).length };
    },
    async key(o) {
      calls.push(['key', o]);
      return { ok: true, keys: o.combo === 'primary+s' ? ['ctrl', 's'] : o.combo.split('+'), repeat: o.repeat };
    },
    async cursorPosition() {
      return { x: 5, y: 6, display: 1, logical: { x: 1925, y: 6 } };
    },
    async screenInfo() {
      return {
        displays: [
          { index: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true, lastShot: { width: 1366, height: 768, scale: 1.406 } },
          { index: 1, x: 1920, y: 0, width: 1280, height: 1024, scale: 1, primary: false, lastShot: null },
        ],
      };
    },
  };
  return comp;
}

function toolMap(opts) {
  const tools = createTools({ role: 'engine', ...opts });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

function textOf(result) {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

async function waitFor(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

// ---------------------------------------------------------------- shape

test('interactive sessions do not see the permission_prompt plumbing tool', () => {
  const tools = createTools({ computer: fakeComputer(), getClient: async () => null, config: {}, role: 'interactive' });
  assert.equal(tools.length, 18);
  assert.ok(!tools.some((t) => t.name === 'permission_prompt'));
});

test('createTools returns the 19 contract tools with schemas and annotations', () => {
  const tools = createTools({ computer: fakeComputer(), getClient: async () => null, config: {}, role: 'engine' });
  assert.equal(tools.length, 19);
  assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);
  for (const t of tools) {
    assert.equal(typeof t.handler, 'function', t.name);
    assert.ok(t.description.length > 60, `${t.name} description`);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.inputSchema.properties && typeof t.inputSchema.properties === 'object', t.name);
    for (const r of t.inputSchema.required || []) assert.ok(r in t.inputSchema.properties, `${t.name}.${r}`);
    for (const [k, p] of Object.entries(t.inputSchema.properties)) {
      assert.ok(p.type, `${t.name}.${k} has a type`);
      assert.ok(p.description, `${t.name}.${k} has a description`);
    }
    assert.equal(typeof t.annotations.title, 'string');
    for (const h of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) assert.equal(typeof t.annotations[h], 'boolean', `${t.name}.${h}`);
    JSON.stringify(t.inputSchema); // serialisable
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.screenshot.annotations.readOnlyHint, true);
  assert.equal(byName.click.annotations.readOnlyHint, false);
  assert.equal(byName.click.annotations.destructiveHint, true);
  assert.deepEqual(byName.scroll.inputSchema.properties.direction.enum, ['up', 'down', 'left', 'right']);
  assert.equal(byName.wait.inputSchema.properties.seconds.maximum, 30);
  assert.deepEqual(byName.permission_prompt.inputSchema.required, ['tool_name', 'input']);
  assert.match(byName.key.description, /primary/);
  assert.match(byName.screenshot.description, /latest full screenshot/);
});

// ---------------------------------------------------------------- input actions, guard and activity

test('click: guard, confirmation text and activity', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  const comp = fakeComputer();
  const tools = toolMap({ computer: comp, getClient: d.getClient, config: {}, role: 'engine' });
  const res = await tools.click.handler({ x: 512, y: 300 }, {});
  assert.equal(textOf(res), 'Clicked left at (512, 300) on display 0. Take a screenshot to verify.');
  assert.ok(!res.isError);
  assert.equal(d.state.guardCalls, 1);
  assert.deepEqual(comp.calls[0], ['click', { x: 512, y: 300, button: 'left', clicks: 1, modifiers: [], display: undefined }]);
  const act = await waitFor(() => d.state.activities.find((a) => a.tool === 'click'));
  assert.equal(act.ok, true);
  assert.equal(act.role, 'engine');
  assert.match(act.summary, /Clicked left at \(512, 300\)/);

  const dbl = await tools.click.handler({ x: 1, y: 2, clicks: 2, button: 'right', modifiers: ['shift'] }, {});
  assert.match(textOf(dbl), /^Double-clicked right at \(1, 2\) on display 0 with shift held\./);
  assert.equal(d.state.unauthorized, 0);
});

test('input tools show driver warnings to the model and in the activity (win32 UIPI)', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  const comp = fakeComputer();
  const W = "The window 'Setup' belongs to another user account; Windows may drop this input (UIPI).";
  const orig = comp.click.bind(comp);
  comp.click = async (o) => ({ ...(await orig(o)), warnings: [W] });
  const tools = toolMap({ computer: comp, getClient: d.getClient, config: {}, role: 'engine' });
  const res = await tools.click.handler({ x: 5, y: 6 }, {});
  assert.equal(textOf(res), `Clicked left at (5, 6) on display 0. Take a screenshot to verify.\n\nWarning: ${W}`);
  const act = await waitFor(() => d.state.activities.find((a) => a.tool === 'click'));
  assert.equal(act.warning, W);
});

test('guard: paused blocks the action; slow, failing or missing daemon allows it', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  const comp = fakeComputer();
  const tools = toolMap({ computer: comp, getClient: d.getClient, config: {} });

  d.state.guard = { allowed: false, reason: 'the user pressed Stop' };
  await assert.rejects(tools.click.handler({ x: 1, y: 1 }, {}), (err) => {
    assert.equal(err.code, 'PAUSED');
    assert.match(err.message, /Actions are paused: the user pressed Stop/);
    assert.ok(err.hint);
    return true;
  });
  await assert.rejects(tools.type_text.handler({ text: 'hi' }, {}), /paused/);
  await assert.rejects(tools.key.handler({ combo: 'enter' }, {}), /paused/);
  await assert.rejects(tools.focus_window.handler({ app: 'slack' }, {}), /paused/);
  assert.equal(comp.calls.length, 0, 'nothing ran while paused');
  // read-only tools are not guarded
  const shot = await tools.screenshot.handler({}, {});
  assert.equal(shot.content[0].type, 'image');

  d.state.guard = { allowed: false, reason: 'slow' };
  d.state.guardDelayMs = 600;
  const t0 = Date.now();
  await tools.mouse_move.handler({ x: 3, y: 4 }, {});
  assert.ok(Date.now() - t0 < 550, 'guard timeout is ~200 ms');

  d.state.guardDelayMs = 0;
  d.state.guardStatus = 500;
  await tools.mouse_move.handler({ x: 3, y: 4 }, {});

  const offline = toolMap({ computer: comp, getClient: async () => null, config: {} });
  await offline.mouse_move.handler({ x: 3, y: 4 }, {});
  const throwing = toolMap({ computer: comp, getClient: async () => { throw new Error('boom'); }, config: {} });
  await throwing.mouse_move.handler({ x: 3, y: 4 }, {});
  assert.equal(comp.calls.filter((c) => c[0] === 'moveMouse').length, 4);
});

test('failed actions post ok:false activity and rethrow with hint', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  const comp = fakeComputer();
  const err = new Error('FAILSAFE: mouse is in the top-left corner; actions are paused');
  err.code = 'FAILSAFE';
  err.hint = 'Move the mouse away.';
  comp.fail = err;
  const tools = toolMap({ computer: comp, getClient: d.getClient, config: {} });
  await assert.rejects(tools.click.handler({ x: 9, y: 9 }, {}), /FAILSAFE/);
  const act = await waitFor(() => d.state.activities.find((a) => a.tool === 'click'));
  assert.equal(act.ok, false);
  assert.match(act.error, /FAILSAFE/);
});

test('screenshot returns image + description and posts the image as activity', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  const comp = fakeComputer();
  const tools = toolMap({ computer: comp, getClient: d.getClient, config: {} });
  const res = await tools.screenshot.handler({ display: 0 }, {});
  assert.equal(res.content.length, 2);
  assert.deepEqual(res.content[0], { type: 'image', data: PNG_1PX.toString('base64'), mimeType: 'image/png' });
  const text = res.content[1].text;
  assert.match(text, /1366x768 px/);
  assert.match(text, /display 0 \(primary\) of 2/);
  assert.match(text, /downscaled from 1920x1080/);
  assert.match(text, /1 image px = 1\.406 screen px/);
  assert.match(text, /Mouse cursor: \(10, 20\)/);
  assert.match(text, /Active window: Visual Studio Code — "server\.js - shop-api - Visual Studio Code"/);
  assert.match(text, /pixels in this image/);
  const act = await waitFor(() => d.state.activities.find((a) => a.tool === 'screenshot'));
  assert.equal(act.image, PNG_1PX.toString('base64'));
  assert.equal(act.width, 1366);
  assert.equal(act.height, 768);
  assert.equal(act.ok, true);

  const zoom = await tools.screenshot.handler({ region: { x: 100, y: 50, width: 200, height: 100 } }, {});
  const zt = zoom.content[1].text;
  assert.match(zt, /Zoomed view of region x=100, y=50, 200x100/);
  assert.match(zt, /x = 100 \+ zx \* 0\.5, y = 50 \+ zy \* 0\.5/);
  assert.deepEqual(comp.calls[1][1].region, { x: 100, y: 50, width: 200, height: 100 });
});

test('describeShot flags the dialog as the active window', () => {
  const text = describeShot({ width: 10, height: 10, display: 1, displays: 2, scale: 1, cursor: null, region: null }, { app: 'Claude Anywhere', title: 'Claude Anywhere' });
  assert.match(text, /display 1 of 2/);
  assert.match(text, /not on this display/);
  assert.match(text, /the Claude Anywhere dialog/);
});

test('other input tools call the computer and confirm', async () => {
  const comp = fakeComputer();
  const tools = toolMap({ computer: async () => comp, getClient: async () => null, config: {} });
  assert.equal(textOf(await tools.mouse_move.handler({ x: 7, y: 8 }, {})), 'Moved the mouse to (7, 8) on display 0.');
  assert.match(textOf(await tools.drag.handler({ fromX: 1, fromY: 2, toX: 3, toY: 4 }, {})), /^Dragged with the left button from \(1, 2\) to \(3, 4\) on display 0\./);
  assert.match(textOf(await tools.scroll.handler({ direction: 'down' }, {})), /^Scrolled down 3 notches at \(50, 60\) on display 0\./);
  await assert.rejects(tools.scroll.handler({ direction: 'up', x: 5 }, {}), /both x and y/);
  assert.match(textOf(await tools.type_text.handler({ text: 'hello' }, {})), /^Typed 5 characters \(typed key by key\)/);
  assert.match(textOf(await tools.key.handler({ combo: 'primary+s' }, {})), /^Pressed primary\+s \(ctrl\+s\)\./);
  assert.match(textOf(await tools.key.handler({ combo: 'down', repeat: 3 }, {})), /^Pressed down 3 times\./);
  assert.match(textOf(await tools.cursor_position.handler({}, {})), /Mouse at \(5, 6\) in screenshot pixels of display 1/);
  const info = textOf(await tools.screen_info.handler({}, {}));
  assert.match(info, /Display 0 \(primary\): 1920x1080 logical px at \(0, 0\)/);
  assert.match(info, /Display 1: 1280x1024/);
  assert.match(info, /no screenshot yet/);
  assert.match(info, /Desktop driver: fake\. Supported: screenshot, mouse, keyboard, windows, clipboard\. Unavailable: notify, speak/);
});

test('type_text activity summary previews but never dumps long text', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  const comp = fakeComputer();
  const tools = toolMap({ computer: comp, getClient: d.getClient, config: {} });
  const long = 'x'.repeat(500);
  const res = await tools.type_text.handler({ text: long }, {});
  assert.match(textOf(res), /Typed 500 characters \(pasted\)/);
  const act = await waitFor(() => d.state.activities.find((a) => a.tool === 'type_text'));
  assert.ok(act.summary.length < 120, act.summary);
});

// ---------------------------------------------------------------- windows

test('list_windows and focus_window matching', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  const comp = fakeComputer();
  const tools = toolMap({ computer: comp, getClient: d.getClient, config: {} });

  const all = textOf(await tools.list_windows.handler({}, {}));
  assert.match(all, /^4 windows:/);
  assert.ok(!all.includes('Claude Anywhere'));
  assert.match(all, /id 0x01a00003: Visual Studio Code .*\[focused\]/);
  assert.match(all, /Slack .*\[minimized\]/);
  const filtered = textOf(await tools.list_windows.handler({ filter: 'CHROME' }, {}));
  assert.match(filtered, /^2 windows matching "CHROME":/);
  assert.match(textOf(await tools.list_windows.handler({ filter: 'zzz' }, {})), /No windows match "zzz"/);

  let res = await tools.focus_window.handler({ title: 'google cloud' }, {});
  assert.ok(!res.isError);
  assert.match(textOf(res), /^Focused Google Chrome — "Cloud Run/);
  assert.deepEqual(comp.calls.at(-1), ['focusWindow', '0x01c00007']);

  res = await tools.focus_window.handler({ id: '0x1a00003' }, {});
  assert.match(textOf(res), /Focused Visual Studio Code/);

  res = await tools.focus_window.handler({ app: 'code', title: 'shop-api' }, {});
  assert.match(textOf(res), /Focused Visual Studio Code/);

  res = await tools.focus_window.handler({ title: 'slack' }, {});
  assert.match(textOf(res), /Focused Slack/, 'title query falls back to app names');

  res = await tools.focus_window.handler({ app: 'chrome' }, {});
  assert.equal(res.isError, true);
  assert.match(textOf(res), /^2 windows match; none was focused/);
  assert.match(textOf(res), /0x01c00007/);
  assert.match(textOf(res), /0x01c00009/);
  const act = await waitFor(() => d.state.activities.find((a) => a.tool === 'focus_window' && a.ok === false));
  assert.match(act.summary, /2 windows match/);

  res = await tools.focus_window.handler({ title: 'Claude Anywhere' }, {});
  assert.equal(res.isError, true);
  assert.match(textOf(res), /No window matches title "Claude Anywhere"/);

  await assert.rejects(tools.focus_window.handler({}, {}), /Give id, title or app/);

  comp.driver.focusResult = false;
  await assert.rejects(tools.focus_window.handler({ app: 'slack' }, {}), (err) => err.code === 'FOCUS_FAILED' && /click the window/.test(err.hint));
});

test('matchWindows id normalisation and preferences', () => {
  const wins = [
    { id: '0x0400001', app: 'A', title: 'one' },
    { id: 12345, app: 'B', title: 'two' },
    { id: '7', app: 'B', title: 'two', minimized: true },
  ];
  assert.equal(matchWindows(wins, { id: '0x400001' })[0].title, 'one');
  assert.equal(matchWindows(wins, { id: '12345' })[0].app, 'B');
  assert.equal(matchWindows(wins, { id: '0x3039' })[0].id, 12345);
  assert.equal(matchWindows(wins, { app: 'b' }).length, 1, 'prefers the only non-minimized match');
  assert.equal(matchWindows(wins, { title: 'ONE' }).length, 1);
  assert.equal(matchWindows(wins, { title: 'nothing' }).length, 0);
});

// ---------------------------------------------------------------- clipboard, wait, open, context

test('clipboard, wait, open and get_desktop_context', async () => {
  const comp = fakeComputer();
  const opened = [];
  const gathered = [];
  const tools = toolMap({
    computer: comp,
    getClient: async () => null,
    config: { context: { includeCloud: false } },
    deps: {
      openTarget: async (target, opts) => {
        opened.push([target, opts]);
        return { opened: true, kind: 'url', how: 'xdg-open', target };
      },
      gatherContext: async (opts) => {
        gathered.push(opts);
        return { os: { platform: 'linux' }, windows: [], errors: [] };
      },
    },
  });
  assert.equal(textOf(await tools.clipboard_get.handler({}, {})), 'copied text');
  assert.equal(textOf(await tools.clipboard_set.handler({ text: 'héllo \u{1F600}' }, {})), 'Copied 7 characters to the clipboard.');
  assert.equal(comp.driver.clipboard, 'héllo \u{1F600}');
  comp.driver.clipboard = '';
  assert.match(textOf(await tools.clipboard_get.handler({}, {})), /empty/);

  const t0 = Date.now();
  assert.match(textOf(await tools.wait.handler({ seconds: 0.05 }, {})), /^Waited 0\.05 s\./);
  assert.ok(Date.now() - t0 >= 40);
  const ac = new AbortController();
  const p = tools.wait.handler({ seconds: 10 }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (err) => err.code === 'ABORTED');

  const o = await tools.open.handler({ target: 'https://console.cloud.google.com', kind: 'url' }, {});
  assert.match(textOf(o), /^Opened url https:\/\/console\.cloud\.google\.com \(via xdg-open\)/);
  assert.deepEqual(opened[0], ['https://console.cloud.google.com', { kind: 'url', args: [] }]);

  const ctx = await tools.get_desktop_context.handler({}, {});
  assert.deepEqual(JSON.parse(textOf(ctx)), { os: { platform: 'linux' }, windows: [], errors: [] });
  assert.equal(gathered[0].driver, comp.driver);
  assert.deepEqual(gathered[0].config, { context: { includeCloud: false } });
});

test('a missing computer gives an actionable error', async () => {
  const tools = toolMap({ computer: async () => null, getClient: async () => null, config: {} });
  await assert.rejects(tools.screenshot.handler({}, {}), (err) => err.code === 'UNSUPPORTED' && /anywhere doctor/.test(err.hint));
  await assert.rejects(tools.list_windows.handler({}, {}), /not available/);
});

// ---------------------------------------------------------------- dialog bridge

test('permission_prompt: allow, deny, no daemon, daemon error, bad reply', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  const tools = toolMap({ computer: fakeComputer(), getClient: d.getClient, config: { permissions: { approvalTimeoutSec: 600 } }, role: 'engine' });
  const input = { command: 'gcloud run deploy --source .' };

  let res = await tools.permission_prompt.handler({ tool_name: 'Bash', input, tool_use_id: 'toolu_1' }, {});
  assert.deepEqual(JSON.parse(textOf(res)), { behavior: 'allow', updatedInput: input });
  assert.deepEqual(d.state.permissions[0], { tool_name: 'Bash', input, tool_use_id: 'toolu_1' });

  d.state.permissionResponse = { behavior: 'allow', updatedInput: { command: 'gcloud run deploy --source . --region us-central1' } };
  res = await tools.permission_prompt.handler({ tool_name: 'Bash', input }, {});
  assert.equal(JSON.parse(textOf(res)).updatedInput.command, 'gcloud run deploy --source . --region us-central1');

  d.state.permissionResponse = { behavior: 'deny', message: 'Not now' };
  res = await tools.permission_prompt.handler({ tool_name: 'Bash', input }, {});
  assert.deepEqual(JSON.parse(textOf(res)), { behavior: 'deny', message: 'Not now' });
  assert.ok(!res.isError);

  d.state.permissionResponse = { behavior: 'maybe' };
  res = await tools.permission_prompt.handler({ tool_name: 'Bash', input }, {});
  assert.equal(JSON.parse(textOf(res)).behavior, 'deny');

  d.state.permissionStatus = 500;
  res = await tools.permission_prompt.handler({ tool_name: 'Bash', input }, {});
  const denied = JSON.parse(textOf(res));
  assert.equal(denied.behavior, 'deny');
  assert.match(denied.message, /Could not get approval .*broker exploded/);

  const offline = toolMap({ computer: fakeComputer(), getClient: async () => null, config: {} });
  res = await offline.permission_prompt.handler({ tool_name: 'Write', input: { file_path: '/tmp/x', content: 'y' } }, {});
  assert.deepEqual(JSON.parse(textOf(res)), { behavior: 'allow', updatedInput: { file_path: '/tmp/x', content: 'y' } });
});

test('ask_user: answer with progress, timeout, no daemon, abort', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  const tools = toolMap({ computer: fakeComputer(), getClient: d.getClient, config: {}, progressIntervalMs: 40 });

  d.state.askDelayMs = 220;
  const progress = [];
  const res = await tools.ask_user.handler(
    { question: 'Which region?', options: ['us-central1', 'europe-west1'], timeoutSec: 120 },
    { sendProgress: (m) => progress.push(m), signal: new AbortController().signal }
  );
  assert.equal(textOf(res), 'The user answered: us-central1');
  assert.ok(!res.isError);
  assert.ok(progress.length >= 2, `progress sent ${progress.length} times`);
  assert.match(progress[0], /Waiting for the user to answer/);
  assert.deepEqual(d.state.asks[0], { question: 'Which region?', timeoutSec: 120, options: ['us-central1', 'europe-west1'] });

  d.state.askDelayMs = 0;
  d.state.askResponse = { timeout: true };
  const to = await tools.ask_user.handler({ question: 'Still there?' }, {});
  assert.equal(to.isError, true);
  assert.match(textOf(to), /did not answer within 900 s/);
  assert.equal(d.state.asks[1].timeoutSec, 900);

  const offline = toolMap({ computer: fakeComputer(), getClient: async () => null, config: {} });
  const none = await offline.ask_user.handler({ question: 'x?' }, {});
  assert.equal(none.isError, true);
  assert.equal(textOf(none), NO_DIALOG_MESSAGE);
  assert.equal(NO_DIALOG_MESSAGE, 'The Anywhere dialog is not running; ask the user in your normal reply instead.');

  d.state.askDelayMs = 5000;
  const ac = new AbortController();
  const pending = tools.ask_user.handler({ question: 'cancel me' }, { signal: ac.signal });
  await waitFor(() => d.state.asks.length === 3);
  ac.abort();
  await assert.rejects(pending, (err) => err.code === 'ABORTED');
  assert.ok(await waitFor(() => d.state.askClosed === 1), 'the HTTP request was closed so the daemon can drop the card');
});

test('ask_user with a daemon that refuses the connection', async () => {
  const dead = new DaemonClient({ baseUrl: 'http://127.0.0.1:9', token: TOKEN });
  const tools = toolMap({ computer: fakeComputer(), getClient: async () => dead, config: {} });
  const res = await tools.ask_user.handler({ question: 'x?' }, {});
  assert.equal(res.isError, true);
  assert.match(textOf(res), /Could not ask through the Anywhere dialog .*normal reply/);
});

test('notify_user: dialog, fallback to OS notification, speech', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  const osCalls = [];
  const deps = {
    notify: async (title, body) => osCalls.push(['notify', title, body]),
    speak: async (text) => osCalls.push(['speak', text]),
  };
  const tools = toolMap({ computer: fakeComputer(), getClient: d.getClient, config: {}, deps });
  let res = await tools.notify_user.handler({ message: 'Build finished', level: 'success', speak: true }, {});
  assert.match(textOf(res), /notified in the Anywhere dialog/);
  assert.deepEqual(d.state.notifications[0], { message: 'Build finished', level: 'success', speak: true });
  assert.equal(osCalls.length, 0);

  d.state.notifyResponse = { ok: true, delivered: false };
  res = await tools.notify_user.handler({ message: 'Nobody watching' }, {});
  assert.match(textOf(res), /desktop notification/);
  assert.deepEqual(osCalls[0], ['notify', 'Claude Anywhere', 'Nobody watching']);

  const offline = toolMap({ computer: fakeComputer(), getClient: async () => null, config: {}, deps });
  res = await offline.notify_user.handler({ message: 'Deploy failed', level: 'error', speak: true }, {});
  assert.match(textOf(res), /desktop notification/);
  assert.deepEqual(osCalls[1], ['notify', 'Claude Anywhere: error', 'Deploy failed']);
  assert.ok(await waitFor(() => osCalls.some((c) => c[0] === 'speak' && c[1] === 'Deploy failed')));

  const failing = toolMap({
    computer: fakeComputer(),
    getClient: async () => null,
    config: {},
    deps: { notify: async () => { throw new Error('No desktop notification tool found'); }, speak: async () => {} },
  });
  res = await failing.notify_user.handler({ message: 'x' }, {});
  assert.ok(!res.isError);
  assert.match(textOf(res), /could not be shown \(No desktop notification tool found\)/);
});

test('DaemonClient.connect via ANYWHERE_DAEMON_URL/ANYWHERE_TOKEN works for activity and guard', async (t) => {
  const d = await startDaemon();
  t.after(d.close);
  process.env.ANYWHERE_DAEMON_URL = d.baseUrl;
  process.env.ANYWHERE_TOKEN = TOKEN;
  t.after(() => {
    delete process.env.ANYWHERE_DAEMON_URL;
    delete process.env.ANYWHERE_TOKEN;
  });
  const tools = toolMap({ computer: fakeComputer(), getClient: () => DaemonClient.connect(), config: {}, role: 'interactive' });
  await tools.key.handler({ combo: 'enter' }, {});
  assert.equal(d.state.guardCalls, 1);
  const act = await waitFor(() => d.state.activities.find((a) => a.tool === 'key'));
  assert.equal(act.ok, true);
  assert.equal(act.role, 'interactive');
});

test('daemonRequest falls back to client.request and honours abort', async () => {
  const fake = { request: (m, p, b) => new Promise((r) => setTimeout(() => r({ m, p, b }), 30)) };
  assert.deepEqual(await daemonRequest(fake, 'POST', '/x', { a: 1 }), { m: 'POST', p: '/x', b: { a: 1 } });
  const ac = new AbortController();
  const p = daemonRequest(fake, 'POST', '/x', {}, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (err) => err.code === 'ABORTED');
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(daemonRequest(fake, 'GET', '/x', undefined, { signal: pre.signal }), (err) => err.code === 'ABORTED');
});
