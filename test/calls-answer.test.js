'use strict';

/**
 * Answering calls (docs/CALLS-DESIGN.md §4.3, src/calls/answer.js): the click gates, the
 * safeguard (d) re-checks, shortcut vs vision click vs learned position, the banner path for a
 * notification-only ring, post-click verification with one retry, hang-up and camera-off.
 * Runs against the real Computer over the in-memory mock driver with a scripted vision client.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const answer = require('../src/calls/answer');
const sig = require('../src/calls/signatures');
const png = require('../src/os/png');
const { createMockDriver } = require('../src/os/index');
const { Computer } = require('../src/os/computer');

const W = 1366;
const H = 768;
const T0 = new Date(2026, 9, 18, 14, 5, 0).getTime(); // a Sunday afternoon, local time
const CFG = { calls: { apps: ['zoho-cliq', 'google-meet', 'teams', 'slack', 'zoom'], quietHours: { enabled: true, start: '22:00', end: '08:00' } } };

const BRAVE = { id: '0x10', app: 'Brave-browser', title: 'Incoming call - Ankit Sharma - Zoho Cliq - Brave', pid: 10, x: 0, y: 0, width: W, height: H, focused: true, minimized: false };
const DIALOG = { id: '0x20', app: 'Claude Anywhere', title: 'Claude Anywhere', pid: 20, x: 1000, y: 100, width: 360, height: 500, focused: false, minimized: false };
const TERM = { id: '0x30', app: 'gnome-terminal-server', title: 'bash', pid: 30, x: 0, y: 400, width: 600, height: 368, focused: false, minimized: false };

/** Vision stand-in: scripted detect results (anything else throws), locate points and verify answers. */
function scriptedVision({ detect = [], locate = [], verify = [] } = {}) {
  const v = {
    calls: [],
    async detect(buf, opts = {}) {
      v.calls.push(`detect:${opts.purpose}`);
      if (!detect.length) throw Object.assign(new Error('unexpected vision.detect'), { code: 'VISION_FAILED' });
      return { incoming: false, app: null, appId: null, caller: null, accept: null, audioOnly: null, video: false, inCall: false, ...detect.shift() };
    },
    async locate(buf, what) {
      v.calls.push(`locate:${what.slice(0, 20)}`);
      return locate.length ? locate.shift() : null;
    },
    async verify(buf, q) {
      v.calls.push(`verify:${q.slice(0, 20)}`);
      return verify.length ? verify.shift() : false;
    },
  };
  return v;
}

const RING = { incoming: true, app: 'Cliq', appId: 'zoho-cliq', caller: 'Ankit Sharma', accept: { x: 1269, y: 629 } };

/**
 * A desktop with the real Computer: one 1366x768 display, the given windows, a fake clock, and
 * optional reactions to clicks and key presses.
 */
function setup({ windows = [BRAVE], vision, guard, onClick, onKey } = {}) {
  const driver = createMockDriver({ displays: [{ x: 0, y: 0, width: W, height: H }], windows, cursor: { x: 700, y: 300 } });
  const click = driver.click;
  let clicks = 0;
  driver.click = async (...a) => {
    await click(...a);
    clicks++;
    if (onClick) onClick(clicks, a, driver);
  };
  const keyCombo = driver.keyCombo;
  driver.keyCombo = async (keys) => {
    await keyCombo(keys);
    if (onKey) onKey(keys, driver);
  };
  const computer = new Computer({ driver, config: { actionDelayMs: 0 }, guard, platform: 'linux' });
  const clock = { t: T0 };
  return {
    driver,
    computer,
    vision,
    clock,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    clicks: () => driver.actions.filter((a) => a.type === 'click'),
    keys: () => driver.actions.filter((a) => a.type === 'keyCombo').map((a) => a.keys.join('+')),
    setTitle: (id, title) => {
      driver.state.windows.find((w) => w.id === id).title = title;
    },
  };
}

function candidateFor(w, extra = {}) {
  const m = sig.matchTitle(w);
  return { ...m, windowId: w.id, window: { id: w.id, app: w.app, title: w.title, x: w.x, y: w.y, width: w.width, height: w.height }, display: 0, ts: T0, ...extra };
}

function run(env, candidate, extra = {}) {
  return answer.answerCall({
    candidate,
    computer: env.computer,
    driver: env.driver,
    vision: env.vision,
    config: CFG,
    armedUntil: env.clock.t + 3600000,
    now: env.now,
    sleep: env.sleep,
    ...extra,
  });
}

// ---------------------------------------------------------------- gates

test('gatePoint: inside the call window passes; outside, off-screen and not-incoming are refused', () => {
  const base = { incoming: true, shot: { width: W, height: H, display: 0 }, windows: [{ ...BRAVE, x: 100, y: 100, width: 800, height: 600 }], callWindow: { x: 100, y: 100, width: 800, height: 600 }, callWindowId: '0x10', now: T0 };
  assert.deepEqual(answer.gatePoint({ x: 500, y: 500 }, base), { ok: true, reason: null, logical: { x: 500, y: 500 } });
  assert.equal(answer.gatePoint({ x: 1200, y: 700 }, base).reason, 'outside_call_area');
  assert.equal(answer.gatePoint({ x: 1400, y: 10 }, base).reason, 'outside_screenshot');
  assert.equal(answer.gatePoint(null, base).reason, 'no_point');
  assert.equal(answer.gatePoint({ x: '5', y: 5 }, base).reason, 'no_point');
  assert.equal(answer.gatePoint({ x: 500, y: 500 }, { ...base, incoming: false }).reason, 'not_incoming');
  assert.equal(answer.gatePoint({ x: 500, y: 500 }, { ...base, incoming: 'true' }).reason, 'not_incoming');
  assert.equal(answer.gatePoint({ x: 500, y: 500 }, { ...base, incoming: undefined, requireIncoming: false }).ok, true);
  // Screenshot space is mapped to logical space before the window checks.
  const scaled = { ...base, toLogical: (d, x, y) => ({ x: x * 2, y: y * 2 }) };
  assert.equal(answer.gatePoint({ x: 300, y: 300 }, scaled).ok, true);
  assert.equal(answer.gatePoint({ x: 600, y: 600 }, scaled).reason, 'outside_call_area');
});

test('gatePoint: our dialog, terminals and editors are never clicked', () => {
  const shot = { width: W, height: H, display: 0 };
  const callWindow = { x: 0, y: 0, width: W, height: H };
  // The dialog over the call window: refused even though the point is inside the call window.
  const withDialog = { incoming: true, shot, callWindow, windows: [BRAVE, DIALOG], now: T0 };
  assert.equal(answer.gatePoint({ x: 1100, y: 300 }, withDialog).reason, 'own_dialog');
  // Refused even when the dialog is behind (conservative).
  assert.equal(answer.gatePoint({ x: 1100, y: 300 }, { ...withDialog, windows: [{ ...BRAVE, focused: true }, { ...DIALOG, focused: false, stackIndex: 5 }] }).reason, 'own_dialog');
  assert.equal(answer.gatePoint({ x: 1100, y: 300 }, { ...withDialog, windows: [BRAVE, { ...DIALOG, minimized: true }] }).ok, true);
  const term = { incoming: true, shot, callWindow, windows: [{ ...BRAVE, focused: false }, { ...TERM, focused: true }], now: T0 };
  assert.equal(answer.gatePoint({ x: 100, y: 500 }, term).reason, 'terminal');
  const stacked = { incoming: true, shot, callWindow, windows: [{ ...BRAVE, focused: false, stackIndex: 1 }, { ...TERM, stackIndex: 0 }], now: T0 };
  assert.equal(answer.gatePoint({ x: 100, y: 500 }, stacked).reason, 'terminal');
  const below = { incoming: true, shot, callWindow, windows: [{ ...BRAVE, focused: false, stackIndex: 0 }, { ...TERM, stackIndex: 1 }], now: T0 };
  assert.equal(answer.gatePoint({ x: 100, y: 500 }, below).ok, true, 'the terminal is behind the call window');
  const editor = { id: '0x40', app: 'Code', title: 'answer.js - claude-anywhere - Visual Studio Code', x: 0, y: 0, width: W, height: H, focused: true };
  assert.equal(answer.gatePoint({ x: 600, y: 500 }, { incoming: true, shot, callWindow, windows: [editor], now: T0 }).reason, 'editor');
});

test('gatePoint: the screen-diff region (40 px margin), recently appeared windows and banner zones', () => {
  const shot = { width: W, height: H, display: 0 };
  const region = { x: 1000 / W, y: 600 / H, width: 300 / W, height: 100 / H };
  const ctx = { incoming: true, shot, diffRegion: region, windows: [], now: T0 };
  assert.equal(answer.gatePoint({ x: 1100, y: 650 }, ctx).ok, true);
  assert.equal(answer.gatePoint({ x: 965, y: 650 }, ctx).ok, true, 'inside the margin');
  assert.equal(answer.gatePoint({ x: 955, y: 650 }, ctx).reason, 'outside_call_area');
  const toast = { x: 1000, y: 580, width: 360, height: 180, appearedAt: T0 - 30000 };
  assert.equal(answer.gatePoint({ x: 1100, y: 650 }, { incoming: true, shot, recentWindows: [toast], now: T0 }).ok, true);
  assert.equal(answer.gatePoint({ x: 1100, y: 650 }, { incoming: true, shot, recentWindows: [toast], now: T0 + 40000 }).reason, 'outside_call_area');
  const zones = answer.bannerZones(W, H);
  assert.equal(answer.gatePoint({ x: 1200, y: 700 }, { requireIncoming: false, shot, zones, now: T0 }).ok, true);
  assert.equal(answer.gatePoint({ x: 300, y: 500 }, { requireIncoming: false, shot, zones, now: T0 }).reason, 'outside_call_area');
});

test("gatePoint: a browser's tab strip is not a call button (no tab closing)", () => {
  const ctx = { incoming: true, shot: { width: W, height: H, display: 0 }, callWindow: BRAVE, windows: [BRAVE], now: T0 };
  assert.equal(answer.gatePoint({ x: 300, y: 20 }, ctx).reason, 'browser_chrome');
  assert.equal(answer.gatePoint({ x: 300, y: 120 }, ctx).ok, true);
});

test('inQuietHours: across midnight, same-day ranges, disabled and empty ranges', () => {
  const at = (h, m = 0) => new Date(2026, 9, 18, h, m);
  const night = { enabled: true, start: '22:00', end: '08:00' };
  assert.equal(answer.inQuietHours(at(23), night), true);
  assert.equal(answer.inQuietHours(at(3), night), true);
  assert.equal(answer.inQuietHours(at(8), night), false);
  assert.equal(answer.inQuietHours(at(21, 59), night), false);
  assert.equal(answer.inQuietHours(at(12, 30), { start: '12:00', end: '13:00' }), true);
  assert.equal(answer.inQuietHours(at(13), { start: '12:00', end: '13:00' }), false);
  assert.equal(answer.inQuietHours(at(23), { ...night, enabled: false }), false);
  assert.equal(answer.inQuietHours(at(23), { start: '10:00', end: '10:00' }), false);
  // F3-SAFE-D3: enabled hours that do not parse count as quiet (fail closed), never as "no quiet hours".
  assert.equal(answer.inQuietHours(at(23), { start: 'late', end: '08:00' }), true);
  assert.equal(answer.inQuietHours(at(12), { start: 'late', end: '08:00', enabled: false }), false);
  assert.equal(answer.inQuietHours(at(23), null), false);
});

test('patchStill compares the area around a point between two screenshots', () => {
  const img = (fill) => {
    const data = new Uint8Array(200 * 100 * 4).fill(255);
    fill(data);
    return png.encode({ width: 200, height: 100, data });
  };
  const a = img(() => {});
  const b = img((d) => {
    for (let y = 40; y < 60; y++) for (let x = 140; x < 180; x++) d.set([0, 0, 0, 255], (y * 200 + x) * 4);
  });
  assert.equal(answer.patchStill(a, a, { x: 50, y: 50 }), true);
  assert.equal(answer.patchStill(a, b, { x: 50, y: 50 }), true, 'a change elsewhere');
  assert.equal(answer.patchStill(a, b, { x: 160, y: 50 }), false);
  assert.equal(answer.patchStill(a, png.encode({ width: 10, height: 10, data: new Uint8Array(400) }), { x: 5, y: 5 }), false);
});

// ---------------------------------------------------------------- safeguard (d) before any input

test('answerCall refuses without a live arming, in quiet hours, or for an app not in calls.apps', async () => {
  const env = setup({ vision: scriptedVision({ detect: [RING, RING, RING, RING] }) });
  const cand = candidateFor(BRAVE);
  assert.equal((await run(env, cand, { armedUntil: undefined })).reason, 'not_armed');
  assert.equal((await run(env, cand, { armedUntil: env.clock.t - 1 })).reason, 'not_armed');
  const late = setup({ vision: scriptedVision({ detect: [RING] }) });
  late.clock.t = new Date(2026, 9, 18, 23, 15).getTime();
  assert.equal((await run(late, cand)).reason, 'quiet_hours');
  const onlyMeet = await answer.answerCall({ candidate: cand, computer: env.computer, driver: env.driver, vision: env.vision, config: { calls: { ...CFG.calls, apps: ['meet'] } }, armedUntil: env.clock.t + 1000, now: env.now, sleep: env.sleep });
  assert.equal(onlyMeet.reason, 'app_not_allowed');
  assert.equal((await run(env, null)).reason, 'no_candidate');
  assert.deepEqual(env.clicks(), []);
  assert.deepEqual(env.keys(), []);
  assert.deepEqual(env.vision.calls, [], 'no vision check either');
});

// ---------------------------------------------------------------- shortcut, click, learned

test('Teams: the accept shortcut (audio only) after focusing the window, verified by the in-call title', async () => {
  const teams = { id: '0x50', app: 'ms-teams', title: 'Ankit Sharma is calling | Microsoft Teams', x: 0, y: 0, width: W, height: H, focused: false };
  const env = setup({
    windows: [teams, { ...BRAVE, focused: true }],
    vision: scriptedVision(),
    onKey: (keys, driver) => {
      if (keys.join('+') === 'ctrl+shift+s') driver.state.windows[0].title = 'Call with Ankit Sharma | Microsoft Teams';
    },
  });
  const r = await run(env, candidateFor(teams));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.method, r.verified], ['shortcut', 'title']);
  assert.deepEqual(env.keys(), ['ctrl+shift+s']);
  assert.equal(env.driver.actions.find((a) => a.type === 'focusWindow').id, '0x50');
  assert.deepEqual(env.clicks(), []);
  assert.deepEqual(env.vision.calls, []);
});

test('Teams: a shortcut that does not answer falls back to the vision click', async () => {
  const teams = { id: '0x50', app: 'ms-teams', title: 'Ankit Sharma is calling | Microsoft Teams', x: 0, y: 0, width: W, height: H, focused: true };
  const env = setup({
    windows: [teams],
    vision: scriptedVision({ detect: [{ incoming: true }, { incoming: true, appId: 'teams', accept: { x: 1200, y: 600 } }] }),
    onClick: (n, a, driver) => {
      driver.state.windows[0].title = 'Call with Ankit Sharma | Microsoft Teams';
    },
  });
  const r = await run(env, candidateFor(teams));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.method, 'click');
  assert.deepEqual(r.attempts.map((x) => x.method), ['shortcut', 'click']);
  assert.deepEqual(env.vision.calls, ['detect:verify', 'detect:answer']);
  assert.deepEqual(env.clicks().map((c) => [c.x, c.y]), [[1200, 600]]);
});

test('Zoho Cliq: vision locates Accept, prefers audio only, clicks once, verifies the in-call title', async () => {
  const env = setup({
    vision: scriptedVision({ detect: [{ ...RING, audioOnly: { x: 1150, y: 629 }, video: true }] }),
    onClick: (n, a, driver) => {
      driver.state.windows[0].title = 'In call with Ankit Sharma - Zoho Cliq - Brave';
    },
  });
  const r = await run(env, candidateFor(BRAVE));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.method, r.verified, r.video, r.caller, r.app], ['click', 'title', false, 'Ankit Sharma', 'zoho-cliq']);
  assert.deepEqual(env.clicks().map((c) => [c.x, c.y, c.button]), [[1150, 629, 'left']]);
  assert.deepEqual(env.vision.calls, ['detect:answer']);
  assert.deepEqual(env.keys(), [], 'no shortcut, no tab closing');
});

test('a point on our own dialog is refused: no click', async () => {
  const env = setup({ windows: [BRAVE, DIALOG], vision: scriptedVision({ detect: [{ ...RING, accept: { x: 1100, y: 300 } }] }) });
  const r = await run(env, candidateFor(BRAVE));
  assert.deepEqual([r.ok, r.reason], [false, 'gate:own_dialog']);
  assert.deepEqual(env.clicks(), []);
});

test('verification: an unverified click is retried once; a second failure gives up after two clicks', async () => {
  const env = setup({
    vision: scriptedVision({ detect: [RING, { incoming: true }, RING] }),
    onClick: (n, a, driver) => {
      if (n === 2) driver.state.windows[0].title = 'In call with Ankit Sharma - Zoho Cliq - Brave';
    },
  });
  const r = await run(env, candidateFor(BRAVE));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(env.clicks().length, 2);
  assert.deepEqual(r.attempts.map((x) => x.verified), ['still_ringing', 'title']);
  assert.deepEqual(env.vision.calls, ['detect:answer', 'detect:verify', 'detect:answer']);

  const never = setup({ vision: scriptedVision({ detect: [RING, { incoming: true }, RING, { incoming: true }] }) });
  const f = await run(never, candidateFor(BRAVE));
  assert.deepEqual([f.ok, f.reason], [false, 'still_ringing']);
  assert.equal(never.clicks().length, 2);
});

test('a click that connects late is recognised on the retry look', async () => {
  const env = setup({ vision: scriptedVision({ detect: [RING, { incoming: false }, { incoming: false, inCall: true }] }) });
  const r = await run(env, candidateFor(BRAVE));
  assert.deepEqual([r.ok, r.method, r.verified], [true, 'click', 'vision']);
  assert.equal(env.clicks().length, 1);
});

test('no ring on screen, an unknown app or no Accept button: nothing is clicked', async () => {
  const quiet = setup({ vision: scriptedVision({ detect: [{ incoming: false }] }) });
  assert.equal((await run(quiet, candidateFor(BRAVE))).reason, 'not_ringing');
  const generic = { ...BRAVE, app: 'Chromium-browser', title: 'Incoming call - Ankit Sharma - Chromium' };
  const unknown = setup({ windows: [generic], vision: scriptedVision({ detect: [{ incoming: true, app: 'WhatsApp', accept: { x: 600, y: 600 } }] }) });
  const cand = candidateFor(generic);
  assert.equal(cand.app, null);
  assert.equal((await run(unknown, cand)).reason, 'unknown_app');
  const known = setup({ windows: [generic], vision: scriptedVision({ detect: [{ incoming: true, appId: 'zoho-cliq' }] }) });
  assert.equal((await run(known, cand)).reason, 'no_accept_button');
  for (const e of [quiet, unknown, known]) assert.deepEqual(e.clicks(), []);
});

test('a popup that moves during the vision look is not clicked', async () => {
  const env = setup({ vision: scriptedVision({ detect: [RING, RING] }) });
  let n = 0;
  const capture = env.driver.captureDisplay;
  env.driver.captureDisplay = async (i) => {
    n++;
    if (n % 2 === 1) return capture(i);
    const data = new Uint8Array(W * H * 4).fill(30);
    return { png: png.encode({ width: W, height: H, data }, { level: 1 }), width: W, height: H };
  };
  const r = await run(env, candidateFor(BRAVE));
  assert.deepEqual([r.ok, r.reason], [false, 'popup_moved']);
  assert.deepEqual(env.clicks(), []);
});

test('the pause guard stops the click (Computer guard), and answerCall reports it', async () => {
  const env = setup({ vision: scriptedVision({ detect: [RING] }), guard: async () => ({ allowed: false, reason: 'the user paused Claude' }) });
  const r = await run(env, candidateFor(BRAVE));
  assert.deepEqual([r.ok, r.reason], [false, 'paused']);
  assert.deepEqual(env.clicks(), []);
});

test('a notification-only ring: the banner is clicked first, then Accept in the focused tab', async () => {
  const brave = { ...BRAVE, title: 'Inbox - Gmail - Brave', focused: false };
  const editor = { id: '0x60', app: 'Code', title: 'notes.md - Visual Studio Code', x: 0, y: 0, width: 900, height: 500, focused: true };
  const env = setup({
    windows: [brave, editor],
    vision: scriptedVision({ detect: [{ incoming: false }, { ...RING, accept: { x: 1100, y: 600 } }], locate: [{ x: 1200, y: 700 }] }),
    onClick: (n, a, driver) => {
      const b = driver.state.windows[0];
      if (n === 1) {
        for (const w of driver.state.windows) w.focused = w === b;
        b.title = 'Incoming call - Ankit Sharma - Zoho Cliq - Brave';
      } else {
        b.title = 'In call with Ankit Sharma - Zoho Cliq - Brave';
      }
    },
  });
  const cand = { ...sig.matchNotification({ app: 'Brave', summary: 'Ankit Sharma', body: 'Incoming audio call', origin: 'cliq.zoho.com' }), ts: T0, display: 0 };
  const r = await run(env, cand);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.attempts.map((x) => x.method), ['banner', 'click']);
  assert.deepEqual(env.clicks().map((c) => [c.x, c.y]), [[1200, 700], [1100, 600]]);
});

test('a banner outside the notification areas is not clicked', async () => {
  const env = setup({ windows: [{ ...BRAVE, title: 'Inbox - Brave' }], vision: scriptedVision({ detect: [{ incoming: false }], locate: [{ x: 300, y: 500 }] }) });
  const cand = { app: 'zoho-cliq', kind: 'ringing', source: 'notification', confidence: 0.9, caller: 'Ankit', ts: T0 };
  const r = await run(env, cand);
  assert.equal(r.reason, 'banner:gate:outside_call_area');
  assert.deepEqual(env.clicks(), []);
});

test('a toast whose bounds the OS reported may be clicked where it is', async () => {
  const env = setup({
    windows: [{ ...BRAVE, title: 'Inbox - Brave', focused: false }],
    vision: scriptedVision({ detect: [{ incoming: false }, { incoming: false }], locate: [{ x: 300, y: 500 }] }),
  });
  const cand = { app: 'zoho-cliq', kind: 'ringing', source: 'notification', confidence: 0.9, caller: 'Ankit', ts: T0, banner: { x: 250, y: 450, width: 360, height: 120 } };
  const r = await run(env, cand);
  assert.equal(r.attempts[0].method, 'banner');
  assert.equal(r.attempts[0].ok, true);
  assert.deepEqual(env.clicks().map((c) => [c.x, c.y]), [[300, 500]]);
  assert.equal(r.reason, 'not_ringing', 'no in-page ring after the banner: nothing else is clicked');
});

test('a learned Accept position is clicked without a vision look, and still verified', async () => {
  const bounds = { x: 0, y: 0, width: W, height: H };
  const learned = sig.compileSignature({
    app: 'zoho-cliq',
    titleRe: '^Ringing: (?<caller>.+?) \\| Cliq$',
    inCallTitleRe: '^On a call with (?<caller>.+?) \\| Cliq$',
    browser: 'brave',
    acceptRel: sig.relativePoint({ x: 1269, y: 629 }, bounds),
    windowSize: { width: W, height: H },
  });
  const win = { ...BRAVE, title: 'Ringing: Ankit Sharma | Cliq - Brave' };
  const env = setup({
    windows: [win],
    vision: scriptedVision(),
    onClick: (n, a, driver) => {
      driver.state.windows[0].title = 'On a call with Ankit Sharma | Cliq - Brave';
    },
  });
  const cand = candidateFor(win);
  assert.equal(cand.learned, undefined);
  const r = await run(env, { ...sig.matchTitle(win, { learned: [learned] }), windowId: win.id, display: 0, ts: T0 }, { learned: [learned] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.method, r.verified, r.point], ['learned', 'title', { x: 1269, y: 629 }]);
  assert.deepEqual(env.clicks().map((c) => [c.x, c.y]), [[1269, 629]]);
  assert.deepEqual(env.vision.calls, []);
});

test('a learned position that no longer shows the learned button color falls back to vision', async () => {
  const bounds = { x: 0, y: 0, width: W, height: H };
  const learned = sig.compileSignature({
    app: 'zoho-cliq',
    titleRe: '^Ringing: (?<caller>.+?) \\| Cliq$',
    browser: 'brave',
    acceptRel: sig.relativePoint({ x: 1269, y: 629 }, bounds),
    windowSize: { width: W, height: H },
    acceptColor: [47, 168, 79],
  });
  const win = { ...BRAVE, title: 'Ringing: Ankit Sharma | Cliq - Brave' };
  const env = setup({
    windows: [win],
    vision: scriptedVision({ detect: [{ ...RING, accept: { x: 1200, y: 650 } }] }),
    onClick: (n, a, driver) => {
      driver.state.windows[0].title = 'In call with Ankit Sharma - Zoho Cliq - Brave';
    },
  });
  const r = await run(env, { ...sig.matchTitle(win, { learned: [learned] }), windowId: win.id, display: 0, ts: T0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.attempts.map((x) => [x.method, x.reason || null]), [['learned', 'learned_mismatch'], ['click', null]]);
  assert.deepEqual(env.clicks().map((c) => [c.x, c.y]), [[1200, 650]]);
  // The mock screen's own color at that point is accepted.
  const color = require('../src/calls/screen-diff').patchColor((await env.computer.screenshot()).png, { x: 1269, y: 629 });
  const same = setup({ windows: [win], vision: scriptedVision(), onClick: (n, a, driver) => (driver.state.windows[0].title = 'In call with Ankit - Zoho Cliq - Brave') });
  const ok = await run(same, { ...sig.matchTitle(win, { learned: [sig.compileSignature({ ...learned, acceptColor: color })] }), windowId: win.id, display: 0, ts: T0 });
  assert.deepEqual([ok.ok, ok.method], [true, 'learned']);
});

test('a video call answered with the only Accept button turns the camera off (Meet shortcut)', async () => {
  const meet = { ...BRAVE, app: 'Google-chrome', title: 'Ankit Sharma is calling - Google Meet - Google Chrome' };
  const env = setup({
    windows: [meet],
    vision: scriptedVision({ detect: [{ incoming: true, appId: 'google-meet', caller: 'Ankit Sharma', accept: { x: 700, y: 500 }, video: true }], verify: [true] }),
    onClick: (n, a, driver) => {
      driver.state.windows[0].title = 'Meet - abc-defg-hij - Google Chrome';
    },
  });
  const r = await run(env, candidateFor(meet));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.video, true);
  assert.deepEqual([r.camera.ok, r.camera.method, r.camera.combo], [true, 'shortcut', 'primary+e']);
  assert.deepEqual(env.keys(), ['ctrl+e']);
});

// ---------------------------------------------------------------- hang up, camera

test('hangUp: Teams uses its shortcut; Cliq clicks the End button vision finds inside the call window', async () => {
  const teams = { id: '0x50', app: 'ms-teams', title: 'Call with Ankit | Microsoft Teams', x: 0, y: 0, width: W, height: H, focused: false };
  const t = setup({ windows: [teams], vision: scriptedVision() });
  const r = await answer.hangUp({ app: 'teams', windowId: '0x50', computer: t.computer, driver: t.driver, vision: t.vision, sleep: t.sleep, now: t.now });
  assert.deepEqual([r.ok, r.method], [true, 'shortcut']);
  assert.deepEqual(t.keys(), ['ctrl+shift+h']);

  const small = { ...BRAVE, x: 100, y: 100, width: 800, height: 600, title: 'In call with Ankit - Zoho Cliq - Brave' };
  const c = setup({ windows: [small], vision: scriptedVision({ locate: [{ x: 500, y: 650 }, { x: 1300, y: 50 }] }) });
  const ok = await answer.hangUp({ app: 'zoho-cliq', windowId: small.id, computer: c.computer, driver: c.driver, vision: c.vision, sleep: c.sleep, now: c.now });
  assert.deepEqual([ok.ok, ok.method, ok.point], [true, 'click', { x: 500, y: 650 }]);
  const outside = await answer.hangUp({ app: 'zoho-cliq', windowId: small.id, computer: c.computer, driver: c.driver, vision: c.vision, sleep: c.sleep, now: c.now });
  assert.deepEqual([outside.ok, outside.reason], [false, 'gate:outside_call_area']);
  assert.equal(c.clicks().length, 1);
  assert.deepEqual(c.keys(), [], 'never ctrl+w');
  const gone = await answer.hangUp({ app: 'zoho-cliq', windowId: '0x999', computer: c.computer, driver: c.driver, vision: c.vision, sleep: c.sleep, now: c.now });
  assert.equal(gone.reason, 'no_call_window');
});

test('cameraOff: nothing to do when the camera is off; otherwise shortcut or the camera button', async () => {
  const meet = { ...BRAVE, app: 'Google-chrome', title: 'Meet - abc-defg-hij - Google Chrome' };
  const off = setup({ windows: [meet], vision: scriptedVision({ verify: [false] }) });
  const r = await answer.cameraOff({ app: 'google-meet', windowId: meet.id, computer: off.computer, driver: off.driver, vision: off.vision, sleep: off.sleep, now: off.now });
  assert.deepEqual([r.ok, r.method], [true, 'already_off']);
  assert.deepEqual(off.keys(), []);
  const cliq = setup({ windows: [BRAVE], vision: scriptedVision({ verify: [true], locate: [{ x: 640, y: 700 }] }) });
  const c = await answer.cameraOff({ app: 'zoho-cliq', windowId: BRAVE.id, computer: cliq.computer, driver: cliq.driver, vision: cliq.vision, sleep: cliq.sleep, now: cliq.now });
  assert.deepEqual([c.ok, c.method], [true, 'click']);
  assert.deepEqual(cliq.clicks().map((x) => [x.x, x.y]), [[640, 700]]);
  const zoom = setup({ windows: [{ ...BRAVE, app: 'zoom', title: 'Zoom Meeting' }], vision: scriptedVision() });
  const z = await answer.cameraOff({ app: 'zoom', windowId: BRAVE.id, force: true, computer: zoom.computer, driver: zoom.driver, vision: zoom.vision, sleep: zoom.sleep, now: zoom.now });
  assert.deepEqual([z.ok, z.combo], [true, 'alt+v']);
  assert.deepEqual(zoom.keys(), ['alt+v']);
});

test('appAllowed maps config names and treats an empty list as none', () => {
  assert.equal(answer.appAllowed('zoho-cliq', { calls: { apps: ['cliq'] } }), true);
  assert.equal(answer.appAllowed('google-meet', { calls: { apps: ['cliq'] } }), false);
  assert.equal(answer.appAllowed('teams', {}), true);
  assert.equal(answer.appAllowed('teams', { calls: { apps: [] } }), false);
  assert.equal(answer.appAllowed(null, {}), false);
});
