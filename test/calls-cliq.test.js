'use strict';

/**
 * Messaging the caller on Zoho Cliq after a call (docs/CALLS-DESIGN.md §7.4, src/calls/cliq.js).
 *  - REST: OAuth refresh (form body, cached access token, one refresh at a time, Zoho's
 *    "200 + {error}" answers), buddy messages (URL, header, JSON), 401 → refresh and retry once,
 *    403 scope hint, 404, bad emails; secrets never appear in errors; the grant-code exchange.
 *  - GUI: the real Computer over the in-memory mock driver with a scripted vision client: the
 *    happy path (focus, open check, empty-box check, locate, click, paste, Enter, verify), opening
 *    the caller's chat from the list, a draft in the box, gates (outside the Cliq window, our
 *    dialog on top), focus lost before typing, the user's pause guard, opening Cliq when no
 *    window has it, an unverified send.
 *  - sendChat(): API first with a GUI fallback only when the API certainly sent nothing.
 * No network: every HTTP exchange goes to a fake.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const cliq = require('../src/calls/cliq');
const { createMockDriver } = require('../src/os/index');
const { Computer } = require('../src/os/computer');

const SECRET = 'client-secret-XYZ-123456';
const REFRESH = '1000.refresh-token-ABC-987654';
const ACCESS1 = '1000.access-one-111111';
const ACCESS2 = '1000.access-two-222222';

/** A fake HTTP client: scripted answers by URL pattern, every request recorded. */
function fakeHttp(script) {
  const calls = [];
  const http = async (url, opts) => {
    calls.push({ url, ...opts });
    for (const s of script) {
      if (s.match.test(url) && (s.times == null || s.times > 0)) {
        if (s.times != null) s.times--;
        const r = typeof s.reply === 'function' ? s.reply(url, opts, calls) : s.reply;
        if (r instanceof Error) throw r;
        return { status: r.status, headers: {}, body: Buffer.from(r.body == null ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
      }
    }
    throw new Error(`unexpected request ${url}`);
  };
  http.calls = calls;
  return http;
}

const TOKEN_OK = (token, expires = 3600) => ({ match: /\/oauth\/v2\/token$/, reply: { status: 200, body: { access_token: token, api_domain: 'https://www.zohoapis.com', token_type: 'Bearer', expires_in: expires } } });

function api(http, extra = {}) {
  return new cliq.CliqApi({ dc: 'eu', clientId: '1000.CLIENTID', clientSecret: SECRET, refreshToken: REFRESH, http, ...extra });
}

function noSecrets(err) {
  const text = `${err.message} ${err.hint || ''}`;
  for (const s of [SECRET, REFRESH, ACCESS1, ACCESS2]) assert.ok(!text.includes(s), `secret leaked: ${text}`);
}

// ---------------------------------------------------------------- helpers

test('data centers, URLs and the chat text cleaner', () => {
  assert.equal(cliq.normalizeDc(''), 'com');
  assert.equal(cliq.normalizeDc('EU'), 'eu');
  assert.equal(cliq.normalizeDc('https://cliq.zoho.com.au/company/1/chats'), 'com.au');
  assert.throws(() => cliq.normalizeDc('evil.example'), (e) => e.code === 'CLIQ_CONFIG');
  assert.equal(cliq.dcFromUrl('https://cliq.zoho.in/company/1'), 'in');
  assert.equal(cliq.dcFromUrl('https://example.com/zoho.eu'), null);
  assert.equal(cliq.accountsUrl('jp'), 'https://accounts.zoho.jp');
  assert.equal(cliq.apiConsoleUrl('ca'), 'https://api-console.zoho.ca');
  assert.equal(cliq.cliqUrl('eu'), 'https://cliq.zoho.eu/');
  assert.equal(cliq.cleanChatText(`Hi Ankit,\nPAY-412\tis yours${String.fromCharCode(0x202e)}  `), 'Hi Ankit, PAY-412 is yours');
  const long = cliq.cleanChatText('word '.repeat(200));
  assert.ok(long.length <= 500 && long.endsWith('…'), long);
  assert.equal(cliq.cleanChatText(' \n\t '), '');
});

// ---------------------------------------------------------------- REST

test('refresh: form body to accounts.zoho.<dc>, token cached until it expires, one refresh at a time', async () => {
  let t = 1000000;
  const http = fakeHttp([{ ...TOKEN_OK(ACCESS1, 3600), times: 1 }, TOKEN_OK(ACCESS2, 3600)]);
  const a = api(http, { now: () => t });
  const [x, y] = await Promise.all([a.accessToken(), a.accessToken()]);
  assert.deepEqual([x, y], [ACCESS1, ACCESS1]);
  assert.equal(http.calls.length, 1);
  const c = http.calls[0];
  assert.equal(c.url, 'https://accounts.zoho.eu/oauth/v2/token');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(c.body);
  assert.deepEqual(Object.fromEntries(form), { grant_type: 'refresh_token', client_id: '1000.CLIENTID', client_secret: SECRET, refresh_token: REFRESH });
  assert.ok(!c.url.includes(SECRET), 'secrets stay out of the URL');
  t += 3000 * 1000;
  assert.equal(await a.accessToken(), ACCESS1, 'still valid');
  t += 600 * 1000; // within a minute of expiry: refreshed
  assert.equal(await a.accessToken(), ACCESS2);
  assert.equal(http.calls.length, 2);
  assert.deepEqual(await a.test(), { ok: true, dc: 'eu' });
});

test('refresh failures: Zoho answers 200 with {error}; a revoked token says to run setup; no secrets in errors', async () => {
  const a = api(fakeHttp([{ match: /token$/, reply: { status: 200, body: { error: 'invalid_code' } } }]));
  await assert.rejects(a.accessToken(), (e) => {
    noSecrets(e);
    return e.code === 'CLIQ_AUTH' && /invalid_code/.test(e.message) && /anywhere calls cliq setup/.test(e.hint);
  });
  const b = api(fakeHttp([{ match: /token$/, reply: { status: 503, body: 'down' } }]));
  await assert.rejects(b.accessToken(), (e) => e.code === 'CLIQ_HTTP' && /HTTP 503/.test(e.message));
  const unset = new cliq.CliqApi({ dc: 'com' });
  await assert.rejects(unset.accessToken(), (e) => e.code === 'CLIQ_CONFIG');
  assert.equal(cliq.CliqApi.fromConfig({ calls: { cliq: { mode: 'api', clientId: 'x', clientSecret: '', refreshToken: 'r' } } }), null);
  assert.ok(cliq.CliqApi.fromConfig({ calls: { cliq: { dc: 'in', clientId: 'x', clientSecret: 's', refreshToken: 'r' } } }) instanceof cliq.CliqApi);
});

test('sendToBuddy: URL, Zoho-oauthtoken header, JSON body; 401 refreshes once and retries', async () => {
  let n = 0;
  const http = fakeHttp([
    { ...TOKEN_OK(ACCESS1), times: 1 },
    TOKEN_OK(ACCESS2),
    { match: /\/buddies\//, reply: () => (++n === 1 ? { status: 401, body: { code: 'oauthtoken_invalid', message: 'Invalid OAuth token' } } : { status: 204, body: '' }) },
  ]);
  const a = api(http);
  const r = await a.sendToBuddy('ankit.sharma+qa@example.com', 'Hi Ankit,\nPAY-412 is yours');
  assert.deepEqual(r, { ok: true, status: 204 });
  const sends = http.calls.filter((c) => /buddies/.test(c.url));
  assert.equal(sends.length, 2);
  assert.equal(sends[0].url, 'https://cliq.zoho.eu/api/v2/buddies/ankit.sharma%2Bqa%40example.com/message');
  assert.equal(sends[0].headers.Authorization, `Zoho-oauthtoken ${ACCESS1}`);
  assert.equal(sends[1].headers.Authorization, `Zoho-oauthtoken ${ACCESS2}`);
  assert.deepEqual(JSON.parse(sends[1].body), { text: 'Hi Ankit, PAY-412 is yours' });
});

test('sendToBuddy errors: scope (403), auth (401 twice), unknown user, rate limit, bad email, empty text', async () => {
  const fail = (status, body) => api(fakeHttp([{ match: /token$/, reply: { status: 200, body: { access_token: ACCESS1, expires_in: 3600 } } }, { match: /buddies/, reply: { status, body } }]));
  await assert.rejects(fail(403, { code: 'scope_mismatch', message: 'Scope does not match' }).sendToBuddy('a@b.co', 'hi'), (e) => {
    noSecrets(e);
    return e.code === 'CLIQ_SCOPE' && e.status === 403 && e.hint.includes(cliq.SCOPE) && e.hint.includes('https://api-console.zoho.eu');
  });
  await assert.rejects(fail(401, { code: 'oauthtoken_invalid' }).sendToBuddy('a@b.co', 'hi'), (e) => e.code === 'CLIQ_AUTH' && /oauthtoken_invalid/.test(e.message));
  await assert.rejects(fail(404, { message: 'User not found' }).sendToBuddy('a@b.co', 'hi'), (e) => e.code === 'CLIQ_NOT_FOUND' && /cliq\.zoho\.eu/.test(e.hint));
  await assert.rejects(fail(429, {}).sendToBuddy('a@b.co', 'hi'), (e) => e.code === 'CLIQ_RATE_LIMIT');
  await assert.rejects(fail(500, {}).sendToBuddy('a@b.co', 'hi'), (e) => e.code === 'CLIQ_HTTP');
  const http = fakeHttp([]);
  await assert.rejects(api(http).sendToBuddy('not an email', 'hi'), (e) => e.code === 'CLIQ_BAD_EMAIL');
  await assert.rejects(api(http).sendToBuddy('a@b.co/../x@y.z', 'hi'), (e) => e.code === 'CLIQ_BAD_EMAIL');
  await assert.rejects(api(http).sendToBuddy('a@b.co', ' \n '), (e) => e.code === 'CLIQ_EMPTY');
  assert.equal(http.calls.length, 0);
});

test('grant exchange: refresh token issued; a used or expired code explains what to do', async () => {
  const ok = fakeHttp([{ match: /token$/, reply: { status: 200, body: { access_token: ACCESS1, refresh_token: REFRESH, expires_in: 3600, api_domain: 'https://www.zohoapis.in' } } }]);
  const r = await cliq.CliqApi.exchangeGrant({ dc: 'in', clientId: 'id', clientSecret: SECRET, code: '1000.grant', http: ok });
  assert.deepEqual(r, { refreshToken: REFRESH, accessToken: ACCESS1, expiresIn: 3600, apiDomain: 'https://www.zohoapis.in' });
  assert.equal(ok.calls[0].url, 'https://accounts.zoho.in/oauth/v2/token');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(ok.calls[0].body)), { grant_type: 'authorization_code', client_id: 'id', client_secret: SECRET, code: '1000.grant' });
  const used = fakeHttp([{ match: /token$/, reply: { status: 200, body: { error: 'invalid_code' } } }]);
  await assert.rejects(cliq.CliqApi.exchangeGrant({ dc: 'in', clientId: 'id', clientSecret: SECRET, code: 'old', http: used }), (e) => {
    noSecrets(e);
    return e.code === 'CLIQ_AUTH' && /work once/.test(e.hint) && e.hint.includes(cliq.SCOPE);
  });
  await assert.rejects(cliq.CliqApi.exchangeGrant({ dc: 'in', clientId: 'id', clientSecret: '', code: 'x', http: used }), (e) => e.code === 'CLIQ_CONFIG');
});

// ---------------------------------------------------------------- GUI

const W = 1366;
const H = 768;
const BRAVE = { id: '0x10', app: 'Brave-browser', title: 'Ankit Sharma - Zoho Cliq - Brave', pid: 10, x: 0, y: 0, width: W, height: H, focused: false, minimized: false };
const EDITOR = { id: '0x40', app: 'code', title: 'notes.md - project - Visual Studio Code', pid: 40, x: 0, y: 0, width: 800, height: 600, focused: true, minimized: false };
const DIALOG = { id: '0x20', app: 'Claude Anywhere', title: 'Claude Anywhere', pid: 20, x: 900, y: 400, width: 466, height: 368, focused: false, minimized: false };
const BOX = { x: 700, y: 720 };
const ENTRY = { x: 120, y: 200 };

/** Scripted vision: verify answers by question kind; locate points by element kind. */
function scriptedVision({ open = [true], empty = [true], sent = [true], entry = ENTRY, box = BOX } = {}) {
  const v = { calls: [] };
  v.verify = async (png, q) => {
    const kind = /one-to-one chat conversation/.test(q) ? 'open' : /empty/.test(q) ? 'empty' : /newest message/.test(q) ? 'sent' : 'other';
    v.calls.push(`verify:${kind}`);
    const list = { open, empty, sent }[kind] || [];
    return list.length > 1 ? list.shift() : list[0];
  };
  v.locate = async (png, what) => {
    const kind = /entry named/.test(what) ? 'entry' : /message input box/.test(what) ? 'box' : 'other';
    v.calls.push(`locate:${kind}`);
    return kind === 'entry' ? entry : kind === 'box' ? box : null;
  };
  v.detect = async () => {
    throw new Error('detect is not used');
  };
  return v;
}

function setup({ windows = [BRAVE, EDITOR], vision = scriptedVision(), guard, onFocus } = {}) {
  const driver = createMockDriver({ displays: [{ x: 0, y: 0, width: W, height: H }], windows, cursor: { x: 50, y: 50 } });
  if (onFocus) {
    const focus = driver.focusWindow;
    driver.focusWindow = async (id) => {
      const r = await focus(id);
      onFocus(id, driver);
      return r;
    };
  }
  const computer = new Computer({ driver, config: { actionDelayMs: 0 }, guard, platform: 'linux' });
  let t = 1000;
  return {
    driver,
    computer,
    vision,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    clicks: () => driver.actions.filter((a) => a.type === 'click').map((a) => ({ x: a.x, y: a.y })),
    inputs: () => driver.actions.filter((a) => ['click', 'typeText', 'keyCombo'].includes(a.type)).map((a) => (a.type === 'click' ? `click ${a.x},${a.y}` : a.type === 'typeText' ? `type ${a.text}` : a.pasted != null ? `paste ${a.pasted}` : `key ${a.keys.join('+')}`)),
  };
}

const opts = (s, extra = {}) => ({ callerName: 'Ankit Sharma', text: 'Hi Ankit, PAY-412 is assigned to you.', computer: s.computer, driver: s.driver, vision: s.vision, sleep: s.sleep, now: s.now, callWindowId: '0x10', ...extra });

test('GUI: focus the Cliq window, check the chat and an empty box, click, paste, Enter, verify', async () => {
  const s = setup();
  const r = await cliq.sendViaGui(opts(s));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.method, r.sent, r.verified, r.reason], ['gui', true, true, null]);
  assert.deepEqual(s.vision.calls, ['verify:open', 'verify:empty', 'locate:box', 'verify:sent']);
  assert.deepEqual(s.inputs(), [`click ${BOX.x},${BOX.y}`, 'paste Hi Ankit, PAY-412 is assigned to you.', 'key enter']);
  assert.ok(s.driver.actions.some((a) => a.type === 'focusWindow' && a.id === '0x10'));
  assert.equal(s.driver.state.clipboard, '', 'the clipboard is restored');
});

test('GUI: opens the chat from the list when another conversation is open (3 locating steps at most)', async () => {
  const s = setup({ vision: scriptedVision({ open: [false, true] }) });
  const r = await cliq.sendViaGui(opts(s, { text: 'Line one\nline two' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(s.vision.calls, ['verify:open', 'locate:entry', 'verify:open', 'verify:empty', 'locate:box', 'verify:sent']);
  assert.deepEqual(s.inputs(), [`click ${ENTRY.x},${ENTRY.y}`, `click ${BOX.x},${BOX.y}`, 'paste Line one line two', 'key enter']);
  // The caller is nowhere in the list: nothing is typed.
  const s2 = setup({ vision: scriptedVision({ open: [false], entry: null }) });
  const r2 = await cliq.sendViaGui(opts(s2));
  assert.deepEqual([r2.ok, r2.reason, r2.sent], [false, 'caller_not_found', false]);
  assert.deepEqual(s2.inputs(), []);
  // Clicked, but the conversation still is not the caller's.
  const s3 = setup({ vision: scriptedVision({ open: [false, false] }) });
  assert.equal((await cliq.sendViaGui(opts(s3))).reason, 'chat_not_open');
  assert.deepEqual(s3.inputs(), [`click ${ENTRY.x},${ENTRY.y}`]);
});

test('GUI: a draft in the message box is never sent or overwritten', async () => {
  const s = setup({ vision: scriptedVision({ empty: [false] }) });
  const r = await cliq.sendViaGui(opts(s));
  assert.deepEqual([r.ok, r.reason, r.sent, r.typed], [false, 'draft_in_box', false, false]);
  assert.deepEqual(s.inputs(), []);
});

test('GUI gates: points outside the Cliq window or on our dialog are never clicked', async () => {
  const small = { ...BRAVE, width: 600, height: 500 };
  const s = setup({ windows: [small, EDITOR], vision: scriptedVision({ box: { x: 900, y: 700 } }) });
  const r = await cliq.sendViaGui(opts(s));
  assert.deepEqual([r.ok, r.reason], [false, 'gate:outside_call_area']);
  assert.deepEqual(s.inputs(), []);
  const s2 = setup({ windows: [BRAVE, DIALOG], vision: scriptedVision({ box: { x: 1000, y: 600 } }) });
  const r2 = await cliq.sendViaGui(opts(s2));
  assert.deepEqual([r2.ok, r2.reason], [false, 'gate:own_dialog']);
  assert.deepEqual(s2.inputs(), []);
  // The browser's tab strip is not a message box.
  const s3 = setup({ vision: scriptedVision({ box: { x: 300, y: 20 } }) });
  assert.equal((await cliq.sendViaGui(opts(s3))).reason, 'gate:browser_chrome');
});

test('GUI: focus moving away after the click stops before typing; the pause guard stops input', async () => {
  const s = setup();
  const click = s.driver.click;
  s.driver.click = async (...a) => {
    await click(...a);
    for (const w of s.driver.state.windows) w.focused = w.id === '0x40'; // the user clicked into the editor
  };
  const r = await cliq.sendViaGui(opts(s));
  assert.deepEqual([r.ok, r.reason, r.typed], [false, 'focus_lost', false]);
  assert.deepEqual(s.inputs(), [`click ${BOX.x},${BOX.y}`]);

  let calls = 0;
  const s2 = setup();
  const paused = async () => {
    calls++;
    if (calls >= 2) throw Object.assign(new Error('Actions are paused'), { code: 'PAUSED' });
  };
  const r2 = await cliq.sendViaGui(opts(s2, { checkGuard: paused }));
  assert.deepEqual([r2.ok, r2.reason, r2.sent], [false, 'paused', false]);
  assert.deepEqual(s2.inputs(), [`click ${BOX.x},${BOX.y}`]);

  // The Computer's own guard (the dialog's Pause) is honoured too.
  const s3 = setup({ guard: async () => ({ allowed: false, reason: 'paused by the user' }) });
  const r3 = await cliq.sendViaGui(opts(s3));
  assert.deepEqual([r3.ok, r3.reason], [false, 'paused']);
  assert.deepEqual(s3.inputs(), []);
});

test('GUI: focus that cannot be confirmed (or lands on an editor) sends nothing', async () => {
  const s = setup({
    onFocus: (id, driver) => {
      for (const w of driver.state.windows) w.focused = w.id === '0x40';
    },
  });
  const r = await cliq.sendViaGui(opts(s));
  assert.deepEqual([r.ok, r.reason], [false, 'focus_not_confirmed']);
  assert.deepEqual(s.inputs(), []);
  assert.deepEqual(s.vision.calls, []);
});

test('GUI: no Cliq window → https://cliq.zoho.<dc>/ is opened and used once it appears', async () => {
  const s = setup({ windows: [EDITOR] });
  const opened = [];
  const open = async (url) => {
    opened.push(url);
    s.driver.state.windows.push({ ...BRAVE, id: '0x99', title: 'Zoho Cliq - Brave' });
  };
  const r = await cliq.sendViaGui(opts(s, { callWindowId: null, dc: 'eu', open }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(opened, ['https://cliq.zoho.eu/']);
  assert.ok(s.driver.actions.some((a) => a.type === 'focusWindow' && a.id === '0x99'));
  const s2 = setup({ windows: [EDITOR] });
  const r2 = await cliq.sendViaGui(opts(s2, { callWindowId: null, openIfMissing: false }));
  assert.deepEqual([r2.ok, r2.reason], [false, 'no_cliq_window']);
  const s3 = setup({ windows: [EDITOR] });
  const r3 = await cliq.sendViaGui(opts(s3, { callWindowId: null, open: async () => {}, openWaitMs: 2000 }));
  assert.equal(r3.reason, 'no_cliq_window');
});

test('GUI with the CallManager options: windowId, app and config (the data center)', async () => {
  const s = setup();
  const r = await cliq.sendViaGui({ callerName: 'Ankit Sharma', text: 'Hi', windowId: '0x10', app: 'zoho-cliq', appName: 'Zoho Cliq', driver: s.driver, computer: s.computer, vision: s.vision, config: { calls: { cliq: { dc: 'in' } } }, sleep: s.sleep, now: s.now });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(s.driver.actions.some((a) => a.type === 'focusWindow' && a.id === '0x10'));
  const meet = await cliq.sendViaGui({ callerName: 'Ankit Sharma', text: 'Hi', app: 'google-meet', driver: s.driver, computer: s.computer, vision: s.vision });
  assert.deepEqual([meet.ok, meet.reason], [false, 'unsupported_app']);
  const s2 = setup({ windows: [EDITOR] });
  const opened = [];
  await cliq.sendViaGui({ callerName: 'Ankit Sharma', text: 'Hi', app: 'Zoho Cliq', driver: s2.driver, computer: s2.computer, vision: s2.vision, config: { calls: { cliq: { dc: 'in' } } }, open: async (u) => opened.push(u), openWaitMs: 1000, sleep: s2.sleep, now: s2.now });
  assert.deepEqual(opened, ['https://cliq.zoho.in/']);
});

test('GUI: not verified on screen → sent but not ok (the manager must not retry blindly)', async () => {
  const s = setup({ vision: scriptedVision({ sent: [false] }) });
  const r = await cliq.sendViaGui(opts(s));
  assert.deepEqual([r.ok, r.sent, r.verified, r.reason], [false, true, false, 'not_verified']);
  const bad = await cliq.sendViaGui(opts(s, { text: '  \n ' }));
  assert.equal(bad.reason, 'empty_text');
  assert.equal((await cliq.sendViaGui(opts(s, { callerName: '' }))).reason, 'no_caller');
  assert.equal((await cliq.sendViaGui(opts(s, { vision: null }))).reason, 'no_vision');
});

test('sendChat: API first; GUI only when the API certainly sent nothing; never for other apps', async () => {
  const config = { calls: { cliq: { mode: 'api', dc: 'eu', clientId: 'id', clientSecret: SECRET, refreshToken: REFRESH } } };
  const okHttp = fakeHttp([TOKEN_OK(ACCESS1), { match: /buddies/, reply: { status: 204 } }]);
  const s = setup();
  let r = await cliq.sendChat({ ...opts(s), config, email: 'ankit@example.com', http: okHttp });
  assert.deepEqual([r.ok, r.via, r.sent], [true, 'api', true]);
  assert.deepEqual(s.inputs(), [], 'no GUI when the API worked');

  // Scope missing: certainly not sent → the GUI sends it.
  const scopeHttp = fakeHttp([TOKEN_OK(ACCESS1), { match: /buddies/, reply: { status: 403, body: { code: 'scope_mismatch' } } }]);
  const s2 = setup();
  r = await cliq.sendChat({ ...opts(s2), config, email: 'ankit@example.com', http: scopeHttp });
  assert.deepEqual([r.ok, r.via, r.apiError.code], [true, 'gui', 'CLIQ_SCOPE']);
  assert.equal(s2.inputs().length, 3);

  // A timeout: maybe sent. Never sent twice.
  const slowHttp = fakeHttp([TOKEN_OK(ACCESS1), { match: /buddies/, reply: new cliq.CliqError('Could not reach cliq.zoho.eu (timed out)', { code: 'CLIQ_TIMEOUT' }) }]);
  const s3 = setup();
  r = await cliq.sendChat({ ...opts(s3), config, email: 'ankit@example.com', http: slowHttp });
  assert.deepEqual([r.ok, r.via, r.sent, r.reason], [false, 'api', null, 'CLIQ_TIMEOUT']);
  assert.deepEqual(s3.inputs(), []);

  // No email known for the caller: the GUI path.
  const s4 = setup();
  r = await cliq.sendChat({ ...opts(s4), config, email: '', http: fakeHttp([]) });
  assert.deepEqual([r.ok, r.via, r.apiError.code], [true, 'gui', 'CLIQ_NO_EMAIL']);

  // GUI mode, and a Meet call (Cliq messages only).
  const s5 = setup();
  r = await cliq.sendChat({ ...opts(s5), config: { calls: { cliq: { mode: 'gui' } } } });
  assert.deepEqual([r.ok, r.via], [true, 'gui']);
  r = await cliq.sendChat({ ...opts(setup()), config, app: 'google-meet' });
  assert.deepEqual([r.ok, r.reason], [false, 'unsupported_app']);
});
