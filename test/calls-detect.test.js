'use strict';

/**
 * Call detection (docs/CALLS-DESIGN.md §4): title signatures (src/calls/signatures.js), OS
 * notifications (notifications.js, with dbus-monitor and busctl output captured from a real session
 * bus), screen diffs (screen-diff.js), the one-shot vision client (vision.js, with a fake claude
 * process) and the detector state machine with calibration (detector.js, fake driver timelines).
 * No network, no audio, no real desktop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const sig = require('../src/calls/signatures');
const notif = require('../src/calls/notifications');
const sd = require('../src/calls/screen-diff');
const vision = require('../src/calls/vision');
const { CallDetector, mergeCaller } = require('../src/calls/detector');
const png = require('../src/os/png');

const ZWSP = '​';

// ---------------------------------------------------------------- fixtures

/** dbus-monitor output: docs/CALLS-DESIGN.md Appendix A.1 (Chromium web Notification). */
const DBUS_A1 = `method call time=1792326436.020347 sender=:1.6 -> destination=org.freedesktop.Notifications serial=31 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify
   string "Chromium"
   uint32 0
   string "file:///tmp/.org.chromium.Chromium.FLhLvo/logo.png"
   string "Ankit Sharma"
   string "localhost:8765

Incoming audio call"
   array [
      string "default"
      string "Activate"
      string "settings"
      string "Settings"
   ]
   array [
      dict entry(
         string "desktop-entry"
         variant             string "chromium-browser"
      )
      dict entry(
         string "urgency"
         variant             byte 2
      )
   ]
   int32 0
`;

/**
 * Captured on a private session bus (dbus-monitor 1.14, a jeepney notification server) from
 * `notify-send -a Brave "Ankit Sharma" 'Incoming call on "Zoho" Cliq<newline>second line'` and
 * `notify-send -a Chromium -h string:desktop-entry:chromium-browser -u critical "Ankit Sharma" 'cliq.zoho.com<nl><nl>Incoming audio call'`.
 * dbus-monitor prints the quotes inside the body unescaped.
 */
const DBUS_CAPTURE = `signal time=1792335172.657156 sender=org.freedesktop.DBus -> destination=:1.7 serial=2 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameAcquired
   string ":1.7"
signal time=1792335172.657196 sender=org.freedesktop.DBus -> destination=:1.7 serial=4 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameLost
   string ":1.7"
method call time=1792335173.662546 sender=:1.9 -> destination=:1.6 serial=9 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify
   string "Brave"
   uint32 0
   string ""
   string "Ankit Sharma"
   string "Incoming call on "Zoho" Cliq
second line"
   array [
   ]
   array [
      dict entry(
         string "urgency"
         variant             byte 1
      )
      dict entry(
         string "sender-pid"
         variant             int64 10192
      )
   ]
   int32 -1
method call time=1792335173.670065 sender=:1.10 -> destination=:1.6 serial=9 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify
   string "Chromium"
   uint32 0
   string ""
   string "Ankit Sharma"
   string "cliq.zoho.com

Incoming audio call"
   array [
   ]
   array [
      dict entry(
         string "desktop-entry"
         variant             string "chromium-browser"
      )
      dict entry(
         string "urgency"
         variant             byte 2
      )
      dict entry(
         string "sender-pid"
         variant             int64 10196
      )
   ]
   int32 -1
`;

/** The same two calls from `busctl --user --json=short monitor org.freedesktop.Notifications` (systemd 255). */
const BUSCTL_CAPTURE = [
  '{"type":"method_call","endian":"l","flags":0,"version":1,"cookie":7,"timestamp-realtime":1792334877333946,"sender":":1.3","destination":"org.freedesktop.Notifications","path":"/org/freedesktop/Notifications","interface":"org.freedesktop.Notifications","member":"GetServerInformation","payload":{"type":"","data":[]}}',
  '{"type":"method_call","endian":"l","flags":0,"version":1,"cookie":9,"timestamp-realtime":1792335173662553,"sender":":1.9","destination":":1.6","path":"/org/freedesktop/Notifications","interface":"org.freedesktop.Notifications","member":"Notify","payload":{"type":"susssasa{sv}i","data":["Brave",0,"","Ankit Sharma","Incoming call on \\"Zoho\\" Cliq\\nsecond line",[],{"urgency":{"type":"y","data":1},"sender-pid":{"type":"x","data":10192}},-1]}}',
  '{"type":"method_call","endian":"l","flags":0,"version":1,"cookie":9,"timestamp-realtime":1792335173670055,"sender":":1.10","destination":":1.6","path":"/org/freedesktop/Notifications","interface":"org.freedesktop.Notifications","member":"Notify","payload":{"type":"susssasa{sv}i","data":["Chromium",0,"","Ankit Sharma","cliq.zoho.com\\n\\nIncoming audio call",[],{"desktop-entry":{"type":"s","data":"chromium-browser"},"urgency":{"type":"y","data":2},"sender-pid":{"type":"x","data":10196}},-1]}}',
];

/** Haiku's answers on the synthetic Cliq ring and the decoy chat (design Appendix A.4). */
const VISION_RING = '{"incoming":true,"app":"Cliq","caller":"Ankit Sharma","accept":{"x":1246,"y":708},"video":false}';
const VISION_DECOY = '{"incoming":false,"app":null,"caller":null,"accept":null,"video":false}';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-calls-detect-'));
}

/** RGBA image filled by fn(x, y) -> [r, g, b]. */
function image(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const W = 1366;
const H = 768;
const desk = () => [238, 240, 243];
const withPopup = (x, y) => (x > 1046 && x < 1346 && y > 618 && y < 748 ? (y > 690 && y < 726 && x > 1214 && x < 1324 ? [47, 168, 79] : [38, 49, 63]) : desk(x, y));
let PNG_DESK = null;
let PNG_POPUP = null;
function pngs() {
  if (!PNG_DESK) {
    PNG_DESK = png.encode(image(W, H, desk), { level: 1 });
    PNG_POPUP = png.encode(image(W, H, withPopup), { level: 1 });
  }
  return { desk: PNG_DESK, popup: PNG_POPUP };
}

// ---------------------------------------------------------------- signatures

test('normalizeTitle removes Edge zero-width spaces, maps dashes and applies NFKC', () => {
  assert.equal(sig.normalizeTitle(`Zoho Cliq - Microsoft${ZWSP} Edge`), 'Zoho Cliq - Microsoft Edge');
  assert.equal(sig.normalizeTitle('Incoming call — Ankit – Cliq'), 'Incoming call - Ankit - Cliq');
  assert.equal(sig.normalizeTitle('Ｉncoming  call now'), 'Incoming call now');
  assert.equal(sig.normalizeTitle('a‮b⁦c﻿'), 'abc');
  assert.equal(sig.normalizeTitle(null), '');
});

test('splitBrowserTitle strips each browser suffix, Edge extras and unread counts', () => {
  const cases = [
    ['Incoming call - Ankit Sharma - Chromium', 'chromium', 'Incoming call - Ankit Sharma'],
    ['Zoho Cliq - Google Chrome', 'chrome', 'Zoho Cliq'],
    ['(3) Zoho Cliq - Brave', 'brave', 'Zoho Cliq'],
    [`Zoho Cliq and 3 more pages - Work - Microsoft${ZWSP} Edge`, 'edge', 'Zoho Cliq and 3 more pages - Work'],
    ['Meet — Mozilla Firefox', 'firefox', 'Meet'],
  ];
  for (const [title, browser, tab] of cases) {
    const r = sig.splitBrowserTitle(title);
    assert.equal(r.browser && r.browser.id, browser, title);
    assert.equal(r.tab, tab.replace(/ and \d+ more pages$/, ''), title);
  }
  // Edge: the variant without the profile segment is also tried.
  const edge = sig.splitBrowserTitle(`Call with Ankit | Microsoft Teams - Work - Microsoft${ZWSP} Edge`);
  assert.deepEqual(edge.variants, ['Call with Ankit | Microsoft Teams - Work', 'Call with Ankit | Microsoft Teams']);
  assert.equal(sig.splitBrowserTitle('Zoho Cliq and 3 more pages - Microsoft Edge').tab, 'Zoho Cliq');
});

test('matchTitle: Zoho Cliq ringing in Brave, Chrome and Edge (0.9, caller from the title)', () => {
  const cases = [
    ['Incoming call - Ankit Sharma - Zoho Cliq - Brave', 'Brave-browser', 'brave'],
    ['Ankit Sharma is calling you | Zoho Cliq - Google Chrome', 'Google-chrome', 'chrome'],
    [`Incoming call from Ankit Sharma - Zoho Cliq - Personal - Microsoft${ZWSP} Edge`, 'msedge.exe', 'edge'],
    ['Incoming video call: Ankit Sharma - Cliq - Brave', 'brave.exe', 'brave'],
  ];
  for (const [title, app, browser] of cases) {
    const m = sig.matchTitle({ id: '1', app, title });
    assert.ok(m, title);
    assert.equal(m.app, 'zoho-cliq', title);
    assert.equal(m.kind, 'ringing');
    assert.equal(m.confidence, 0.9);
    assert.equal(m.caller, 'Ankit Sharma', title);
    assert.equal(m.browser, browser);
  }
  // A Cliq tab that is not ringing is no match.
  assert.equal(sig.matchTitle({ id: '1', app: 'Brave', title: '(2) Zoho Cliq - Brave' }), null);
});

test('matchTitle: the verified Chromium title is a generic ring (0.7, app unknown)', () => {
  const m = sig.matchTitle({ id: '0x1', app: 'Chromium-browser', title: 'Incoming call - Ankit Sharma - Chromium' });
  assert.equal(m.app, null);
  assert.equal(m.confidence, 0.7);
  assert.equal(m.caller, 'Ankit Sharma');
  // The bare word "ringing" stays below the threshold.
  const weak = sig.matchTitle({ id: '2', app: 'Firefox', title: 'Ringing in the ears - Wikipedia — Mozilla Firefox' });
  assert.equal(weak.kind, 'ringing');
  assert.ok(weak.confidence < sig.RING_THRESHOLD);
});

test('matchTitle: Meet, Teams, Zoom and Slack ring and in-call signatures', () => {
  const meet = sig.matchTitle({ id: '1', app: 'Google-chrome', title: 'Meet – abc-defg-hij - Google Chrome' });
  assert.deepEqual([meet.app, meet.kind], ['google-meet', 'in_call']);
  const meetRing = sig.matchTitle({ id: '1', app: 'Google-chrome', title: 'Ankit Sharma is calling - Google Meet - Google Chrome' });
  assert.deepEqual([meetRing.app, meetRing.kind, meetRing.caller], ['google-meet', 'ringing', 'Ankit Sharma']);
  const teamsToast = sig.matchTitle({ id: '2', app: 'Teams.exe', title: 'Microsoft Teams Notification' });
  assert.deepEqual([teamsToast.app, teamsToast.kind, teamsToast.confidence], ['teams', 'ringing', 0.9]);
  const teamsCall = sig.matchTitle({ id: '2', app: 'ms-teams', title: 'Call with Ankit Sharma | Microsoft Teams' });
  assert.deepEqual([teamsCall.app, teamsCall.kind], ['teams', 'in_call']);
  const zoom = sig.matchTitle({ id: '3', app: 'zoom', title: 'Zoom Meeting' });
  assert.deepEqual([zoom.app, zoom.kind], ['zoom', 'in_call']);
  const huddle = sig.matchTitle({ id: '4', app: 'Slack', title: 'Huddle with Ankit - Slack' });
  assert.deepEqual([huddle.app, huddle.kind], ['slack', 'in_call']);
  const cliqInCall = sig.matchTitle({ id: '5', app: 'Brave', title: 'In call with Ankit Sharma - Zoho Cliq - Brave' });
  assert.deepEqual([cliqInCall.app, cliqInCall.kind], ['zoho-cliq', 'in_call']);
});

test('matchTitle ignores our dialog, terminals and editors', () => {
  assert.equal(sig.matchTitle({ id: '1', app: 'Electron', title: 'Claude Anywhere' }), null);
  assert.equal(sig.matchTitle({ id: '1', app: 'Claude Anywhere', title: 'Incoming call - Ankit' }), null);
  assert.equal(sig.matchTitle({ id: '2', app: 'gnome-terminal-server', title: 'echo "Incoming call - Ankit Sharma"' }), null);
  assert.equal(sig.matchTitle({ id: '3', app: 'Code', title: 'incoming call.md - notes - Visual Studio Code' }), null);
  assert.equal(sig.excludedKind({ app: 'WindowsTerminal.exe', title: 'PowerShell' }), 'terminal');
  assert.equal(sig.excludedKind({ app: 'Cursor', title: 'x' }), 'editor');
  // A browser tab named like an editor is still a browser.
  assert.equal(sig.excludedKind({ app: 'Google-chrome', title: 'Pricing - Cursor - Google Chrome' }), null);
});

test('extractCaller and cleanCallerName take the name from the UI text only, cleaned', () => {
  assert.equal(sig.extractCaller('Incoming call - Ankit Sharma - Zoho Cliq'), 'Ankit Sharma');
  assert.equal(sig.extractCaller('Incoming audio call from Priya N.'), 'Priya N');
  assert.equal(sig.extractCaller('Zoho Cliq | Ankit Sharma is calling you'), 'Ankit Sharma');
  assert.equal(sig.extractCaller('Ankit Sharma wants to call'), 'Ankit Sharma');
  assert.equal(sig.extractCaller('Ankit Sharma - Incoming call'), 'Ankit Sharma');
  assert.equal(sig.extractCaller('Incoming call'), null);
  assert.equal(sig.cleanCallerName('Ankit‮ Sharma\u0007'), 'Ankit Sharma');
  assert.equal(sig.cleanCallerName('Zoho Cliq'), null);
  assert.equal(sig.cleanCallerName('https://evil.example'), null);
  assert.equal(sig.cleanCallerName('1234'), null);
  assert.equal(sig.cleanCallerName('Ankit Sharma on Zoho Cliq'), 'Ankit Sharma');
  assert.ok(sig.cleanCallerName('A'.repeat(200)).length <= 60);
});

test('matchNotification: app by origin, app name or text; the caller from the summary', () => {
  const chromium = sig.matchNotification({ app: 'Chromium', summary: 'Ankit Sharma', body: 'Incoming audio call', origin: 'cliq.zoho.com' });
  assert.deepEqual([chromium.app, chromium.confidence, chromium.caller, chromium.origin], ['zoho-cliq', 0.9, 'Ankit Sharma', 'cliq.zoho.com']);
  const eu = sig.matchNotification({ app: 'Google Chrome', summary: 'Ankit', body: 'Incoming video call', origin: 'cliq.zoho.eu' });
  assert.equal(eu.app, 'zoho-cliq');
  const brave = sig.matchNotification({ app: 'Brave', summary: 'Ankit Sharma', body: 'Incoming call on Zoho Cliq' });
  assert.deepEqual([brave.app, brave.caller], ['zoho-cliq', 'Ankit Sharma']);
  const local = sig.matchNotification({ app: 'Chromium', summary: 'Ankit Sharma', body: 'Incoming audio call', origin: 'localhost:8765' });
  assert.deepEqual([local.app, local.confidence], [null, 0.7]);
  const slack = sig.matchNotification({ app: 'Slack', summary: 'Ankit Sharma', body: 'Ankit Sharma invited you to a huddle' });
  assert.deepEqual([slack.app, slack.caller], ['slack', 'Ankit Sharma']);
  const meet = sig.matchNotification({ app: 'Google Chrome', summary: 'Ankit Sharma is calling', body: '', origin: 'meet.google.com' });
  assert.deepEqual([meet.app, meet.caller], ['google-meet', 'Ankit Sharma']);
  assert.equal(sig.matchNotification({ app: 'Slack', summary: '#general', body: 'new message' }), null);
  assert.equal(sig.matchNotification({ app: 'Claude Anywhere', summary: 'Incoming call from Ankit', body: '' }), null);
});

test('matchNewWindow: a new small Teams or Zoom window rings at 0.7', () => {
  const area = 1920 * 1080;
  const teams = sig.matchNewWindow({ id: '9', app: 'ms-teams', title: 'Ankit Sharma', width: 360, height: 180 }, { screenArea: area });
  assert.deepEqual([teams.app, teams.kind, teams.confidence, teams.source], ['teams', 'ringing', 0.7, 'new_window']);
  assert.equal(sig.matchNewWindow({ id: '9', app: 'ms-teams', title: 'Teams', width: 1800, height: 1000 }, { screenArea: area }), null);
  assert.equal(sig.matchNewWindow({ id: '9', app: 'zoom.us', title: '', width: 300, height: 200 }, { screenArea: area, inMeeting: true }), null);
  assert.ok(sig.matchNewWindow({ id: '9', app: 'zoom.us', title: '', width: 300, height: 200 }, { screenArea: area }));
  assert.equal(sig.matchNewWindow({ id: '9', app: 'Google-chrome', title: 'x - Google Chrome', width: 300, height: 200 }, { screenArea: area }), null);
});

test('learned signatures: save (0600), load, replace, skip invalid, match at 0.95 with the caller group', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'calls', 'signatures.json');
  const titleRe = sig.textPattern('Incoming call - Ankit Sharma - Zoho Cliq', 'Ankit Sharma');
  assert.equal(titleRe, '^Incoming call - (?<caller>.+?) - Zoho Cliq$');
  const saved = sig.saveLearned({ app: 'cliq', titleRe, notifRe: '^Incoming audio call$', origin: 'https://cliq.zoho.com/', browser: 'brave', acceptRel: { x: 0.9, y: 0.8, anchor: 'br', dx: -97, dy: -139 } }, { file });
  assert.equal(saved.app, 'zoho-cliq');
  assert.equal(saved.origin, 'cliq.zoho.com');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Replaced, not duplicated; a broken entry in the file is skipped.
  sig.saveLearned({ app: 'zoho-cliq', titleRe, browser: 'brave', origin: 'cliq.zoho.com' }, { file });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.signatures.push({ app: 'teams', titleRe: '([' }, { app: '', titleRe: '^x$' }, { app: 'zoom' });
  fs.writeFileSync(file, JSON.stringify(raw));
  const learned = sig.loadLearned({ file });
  assert.equal(learned.length, 1);
  const m = sig.matchTitle({ id: '1', app: 'Brave-browser', title: 'Incoming call - Priya N - Zoho Cliq - Brave' }, { learned });
  assert.deepEqual([m.app, m.confidence, m.caller], ['zoho-cliq', 0.95, 'Priya N']);
  assert.ok(m.learned);
  // The browser restriction: the same title in Chrome is the built-in 0.9 match.
  const other = sig.matchTitle({ id: '2', app: 'Google-chrome', title: 'Incoming call - Priya N - Zoho Cliq - Google Chrome' }, { learned });
  assert.equal(other.confidence, 0.9);
  assert.throws(() => sig.saveLearned({ app: 'zoho-cliq' }, { file }), /needs an app and a title or notification pattern/);
  assert.deepEqual(sig.loadLearned({ file: path.join(dir, 'missing.json') }), []);
});

test('learned notification signature respects its origin', () => {
  const learned = [sig.compileSignature({ app: 'zoho-cliq', notifRe: '^Incoming audio call$', origin: 'cliq.zoho.com' })];
  const ok = sig.matchNotification({ app: 'Chromium', summary: 'Ankit Sharma', body: 'Incoming audio call', origin: 'cliq.zoho.com' }, { learned });
  assert.equal(ok.confidence, 0.95);
  const other = sig.matchNotification({ app: 'Chromium', summary: 'Ankit Sharma', body: 'Incoming audio call', origin: 'evil.example' }, { learned });
  assert.equal(other.confidence, 0.7);
  assert.equal(other.app, null);
});

test('textPattern, relativePoint and learnedAcceptPoint', () => {
  assert.equal(sig.textPattern('(3) Ankit', 'Ankit'), null, 'not distinctive');
  assert.equal(sig.textPattern('Call 12:05 with Ankit Sharma', 'ankit sharma'), '^Call \\d+:\\d+ with (?<caller>.+?)$');
  const bounds = { x: 0, y: 0, width: 1366, height: 768 };
  const rel = sig.relativePoint({ x: 1269, y: 629 }, bounds);
  assert.deepEqual([rel.anchor, rel.dx, rel.dy], ['br', -97, -139]);
  const s = { acceptRel: rel, windowSize: { width: 1366, height: 768 } };
  assert.deepEqual(sig.learnedAcceptPoint(s, { x: 0, y: 0, width: 1366, height: 768 }), { x: 1269, y: 629 });
  // Resized window: the offset from the bottom-right corner is kept.
  assert.deepEqual(sig.learnedAcceptPoint(s, { x: 100, y: 50, width: 1600, height: 900 }), { x: 1603, y: 811 });
  assert.equal(sig.learnedAcceptPoint(s, { x: 0, y: 0, width: 50, height: 50 }), null);
  assert.equal(sig.relativePoint({ x: 2000, y: 10 }, bounds), null);
});

test('appFromText maps vision and config names to app ids', () => {
  assert.equal(sig.appFromText('Cliq'), 'zoho-cliq');
  assert.equal(sig.appFromText('Google Meet'), 'google-meet');
  assert.equal(sig.appFromText('Microsoft Teams'), 'teams');
  assert.equal(sig.appFromText('Slack huddle'), 'slack');
  assert.equal(sig.appFromText('zoom'), 'zoom');
  assert.equal(sig.appFromText('WhatsApp'), null);
});

// ---------------------------------------------------------------- notifications

test('parseDbusMonitor reads the captured Notify calls (multi-line, unescaped quotes, hints)', () => {
  const r = notif.parseDbusMonitor(DBUS_CAPTURE);
  assert.equal(r.rest, '');
  assert.equal(r.notifications.length, 2);
  const [brave, chromium] = r.notifications;
  assert.deepEqual([brave.app, brave.summary, brave.body, brave.origin, brave.urgency], ['Brave', 'Ankit Sharma', 'Incoming call on "Zoho" Cliq\nsecond line', null, 1]);
  assert.deepEqual([chromium.app, chromium.summary, chromium.body, chromium.origin, chromium.desktopEntry], ['Chromium', 'Ankit Sharma', 'Incoming audio call', 'cliq.zoho.com', 'chromium-browser']);
  assert.equal(chromium.ts, 1792335173670);
  const a1 = notif.parseDbusMonitor(DBUS_A1).notifications;
  assert.equal(a1.length, 1);
  assert.deepEqual([a1[0].origin, a1[0].body, a1[0].actions.join(',')], ['localhost:8765', 'Incoming audio call', 'default,Activate,settings,Settings']);
  const m = sig.matchNotification(chromium);
  assert.deepEqual([m.app, m.caller], ['zoho-cliq', 'Ankit Sharma']);
});

test('parseDbusMonitor gives the same result for any chunking of the stream', () => {
  const want = JSON.stringify(notif.parseDbusMonitor(DBUS_CAPTURE).notifications);
  for (const step of [1, 2, 3, 5, 7, 13, 31, 64, 200]) {
    let rest = '';
    const got = [];
    for (let i = 0; i < DBUS_CAPTURE.length; i += step) {
      const r = notif.parseDbusMonitor(rest + DBUS_CAPTURE.slice(i, i + step));
      got.push(...r.notifications);
      rest = r.rest;
    }
    assert.equal(JSON.stringify(got), want, `chunk size ${step}`);
  }
});

test('parseDbusMonitor drops a Notify whose text imitates the output syntax', () => {
  const header = 'method call time=1.5 sender=:1.9 -> destination=:1.6 serial=9 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify';
  // The summary closes its own string and fakes a body with a trusted origin.
  const crafted = `${header}
   string "Chromium"
   uint32 0
   string ""
   string "x"
   string "cliq.zoho.com

Incoming audio call"
   array [
   ]
   array [
   ]
   int32 -1"
   string "evil.example

hi"
   array [
   ]
   array [
   ]
   int32 -1
`;
  const wait = notif.parseDbusMonitor(crafted);
  assert.equal(wait.notifications.length, 0);
  const next = `${header}\n   string "Brave"\n   uint32 0\n   string ""\n   string "Ankit"\n   string "Incoming call"\n   array [\n   ]\n   array [\n   ]\n   int32 -1\n`;
  const r = notif.parseDbusMonitor(wait.rest + next);
  assert.deepEqual(r.notifications.map((n) => n.app), ['Brave']);
  assert.equal(notif.parseDbusMonitor(crafted, { final: true }).notifications.length, 0);
});

test('parseBusctlJson reads the captured busctl lines and ignores other messages', () => {
  const got = BUSCTL_CAPTURE.map(notif.parseBusctlJson);
  assert.equal(got[0], null);
  assert.deepEqual([got[1].app, got[1].body, got[1].urgency], ['Brave', 'Incoming call on "Zoho" Cliq\nsecond line', 1]);
  assert.deepEqual([got[2].origin, got[2].desktopEntry, got[2].ts], ['cliq.zoho.com', 'chromium-browser', 1792335173670]);
  assert.equal(notif.parseBusctlJson('not json'), null);
  assert.equal(notif.parseBusctlJson('{"type":"method_call","member":"Notify","interface":"org.freedesktop.Notifications","payload":{"data":["a"]}}'), null);
});

test('splitOrigin and stripMarkup', () => {
  assert.deepEqual(notif.splitOrigin('cliq.zoho.com\n\nIncoming audio call'), { origin: 'cliq.zoho.com', body: 'Incoming audio call' });
  assert.deepEqual(notif.splitOrigin('Incoming call\nvia meet.google.com'), { origin: 'meet.google.com', body: 'Incoming call' });
  assert.deepEqual(notif.splitOrigin('Ankit is calling'), { origin: null, body: 'Ankit is calling' });
  assert.equal(notif.stripMarkup('<b>Ankit</b> &amp; <a href="x">co</a>'), 'Ankit & co');
});

test('Windows toasts: normalized, deduplicated while visible, re-emitted after they disappear', async () => {
  // The Windows driver's shape (src/os/win32.js toastTexts): the process is the toast host.
  let toasts = [
    {
      process: 'ShellExperienceHost',
      pid: 4321,
      className: 'Windows.UI.Core.CoreWindow',
      name: 'New notification',
      texts: ['New notification', 'Google Chrome', 'Ankit Sharma', 'cliq.zoho.com', 'Incoming audio call', 'Accept', 'Decline', 'Dismiss'],
      bounds: { x: 1540, y: 860, width: 364, height: 150 },
    },
  ];
  let t = 1000;
  const driver = { toastTexts: async () => toasts };
  const w = notif.createNotificationWatcher({ platform: 'win32', driver, now: () => t, pollMs: 60000 });
  const got = [];
  w.on('notification', (n) => got.push(n));
  assert.deepEqual(w.start(), { ok: true, backend: 'toast' });
  await new Promise((r) => setImmediate(r));
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].app, got[0].summary, got[0].origin, got[0].body, got[0].source], ['Google Chrome', 'Ankit Sharma', 'cliq.zoho.com', 'Incoming audio call\nAccept\nDecline', 'toast']);
  assert.deepEqual(got[0].bounds, { x: 1540, y: 860, width: 364, height: 150 });
  assert.equal(sig.matchNotification(got[0]).app, 'zoho-cliq');
  t += 1000;
  w._onToasts(toasts);
  assert.equal(got.length, 1, 'still visible: not emitted again');
  const saved = toasts;
  toasts = [];
  t += 5000;
  w._onToasts(toasts);
  t += 1000;
  w._onToasts(saved);
  assert.equal(got.length, 2, 'shown again later: emitted again');
  w.stop();
  // Other shapes.
  assert.deepEqual(notif.normalizeToasts(['Microsoft Teams', 'Ankit Sharma', 'Incoming call']), [{ app: '', texts: ['Microsoft Teams', 'Ankit Sharma', 'Incoming call'] }]);
  assert.deepEqual(notif.normalizeToasts([['a', 'b']]), [{ app: '', texts: ['a', 'b'] }]);
  assert.deepEqual(notif.normalizeToasts(null), []);
  assert.equal(notif.toastToNotification({ app: '', texts: ['Dismiss'] }), null);
});

test('chooseBackend per OS', () => {
  const which = (have) => (n) => (have.includes(n) ? `/usr/bin/${n}` : null);
  assert.equal(notif.chooseBackend({ platform: 'darwin' }).backend, null);
  assert.match(notif.chooseBackend({ platform: 'darwin' }).reason, /macOS/);
  assert.equal(notif.chooseBackend({ platform: 'win32', driver: {} }).backend, null);
  assert.equal(notif.chooseBackend({ platform: 'linux', isWSL: true, driver: { toastTexts() {} } }).backend, 'toast');
  assert.equal(notif.chooseBackend({ platform: 'linux', env: {}, which: which(['busctl']) }).backend, null);
  const both = notif.chooseBackend({ platform: 'linux', env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, which: which(['busctl', 'dbus-monitor']) });
  assert.deepEqual([both.backend, both.fallback], ['busctl', 'dbus-monitor']);
  assert.equal(notif.chooseBackend({ platform: 'linux', env: { DBUS_SESSION_BUS_ADDRESS: 'x' }, which: which(['dbus-monitor']) }).backend, 'dbus-monitor');
  const none = notif.chooseBackend({ platform: 'linux', env: { DBUS_SESSION_BUS_ADDRESS: 'x' }, which: which([]) });
  assert.equal(none.backend, null);
  assert.match(none.hint, /dbus-monitor/);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

test('Linux watcher: busctl refused (old systemd) falls back to dbus-monitor; chunks become notifications', async () => {
  const spawned = [];
  const spawn = (cmd, args) => {
    const child = fakeChild();
    spawned.push({ cmd, args, child });
    if (cmd.endsWith('busctl')) {
      setImmediate(() => {
        child.stderr.write("busctl: unrecognized option '--json=short'\n");
        child.emit('exit', 1, null);
      });
    }
    return child;
  };
  const w = notif.createNotificationWatcher({
    platform: 'linux',
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/x' },
    which: (n) => `/usr/bin/${n}`,
    spawn,
  });
  const got = [];
  w.on('notification', (n) => got.push(n));
  assert.equal(w.start().backend, 'busctl');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].cmd, '/usr/bin/dbus-monitor');
  assert.deepEqual(spawned[1].args, ['--session', notif.NOTIFY_MATCH]);
  assert.equal(w.status().backend, 'dbus-monitor');
  const out = spawned[1].child.stdout;
  for (let i = 0; i < DBUS_CAPTURE.length; i += 50) out.write(DBUS_CAPTURE.slice(i, i + 50));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got.map((n) => n.app), ['Brave', 'Chromium']);
  w.stop();
  assert.equal(spawned[1].child.killed, true);
});

test('Linux watcher with busctl parses JSON lines', async () => {
  let child;
  const w = notif.createNotificationWatcher({
    platform: 'linux',
    env: { DBUS_SESSION_BUS_ADDRESS: 'x' },
    which: (n) => (n === 'busctl' ? '/bin/busctl' : null),
    spawn: (cmd, args) => {
      child = fakeChild();
      child.args = args;
      return child;
    },
  });
  const got = [];
  w.on('notification', (n) => got.push(n));
  w.start();
  assert.deepEqual(child.args, ['--user', '--json=short', 'monitor', 'org.freedesktop.Notifications']);
  child.stdout.write(`${BUSCTL_CAPTURE.join('\n')}\n`);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got.map((n) => n.source), ['busctl', 'busctl']);
  w.stop();
});

// ---------------------------------------------------------------- screen diff

test('screen diff: a new popup is a compact block at the bottom right; whole-screen changes are not', () => {
  const shots = pngs();
  const a = sd.thumb(shots.desk);
  const b = sd.thumb(shots.popup);
  assert.equal(a.length, sd.THUMB_W * sd.THUMB_H);
  const r = sd.diff(a, b);
  assert.equal(r.changed, true);
  assert.ok(r.region.x > 0.7 && r.region.y > 0.7, JSON.stringify(r.region));
  const rect = sd.regionToRect(r.region, W, H, 40);
  assert.ok(rect.x <= 1046 && rect.y <= 618 && rect.x + rect.width >= 1346, JSON.stringify(rect));
  // Everything changed (a window switch): no candidate.
  const dark = sd.thumb(image(W, H, () => [10, 10, 10]));
  const g = sd.diff(a, dark);
  assert.deepEqual([g.changed, g.global], [false, true]);
  // A tiny change (a cursor, a clock) is not a block.
  const tiny = sd.thumb(image(W, H, (x, y) => (x > 600 && x < 612 && y > 300 && y < 316 ? [0, 0, 0] : desk())));
  assert.equal(sd.diff(a, tiny).changed, false);
  assert.equal(sd.diff(a, a).changed, false);
  assert.equal(sd.diff(a, new Uint8Array(3)).changed, false);
});

test('ScreenDiffTracker ignores a region that keeps changing (a video) but reports a new popup', () => {
  const t = new sd.ScreenDiffTracker();
  const frame = (k, popupOn) =>
    sd.thumb(
      image(W, H, (x, y) => {
        if (x > 100 && x < 500 && y > 100 && y < 330) return [(k * 70) % 255, (k * 40) % 255, 90]; // the "video"
        return popupOn ? withPopup(x, y) : desk();
      })
    );
  assert.equal(t.push(0, frame(0, false)).changed, false);
  t.push(0, frame(1, false));
  t.push(0, frame(2, false));
  const r = t.push(0, frame(3, false));
  assert.equal(r.changed, false, 'the busy video region is ignored');
  const p = t.push(0, frame(4, true));
  assert.equal(p.changed, true);
  assert.ok(p.region.x > 0.7);
});

// ---------------------------------------------------------------- vision

test('buildVisionArgs: haiku, no tools, no MCP servers, no settings, no session file, replaced system prompt', () => {
  const args = vision.buildVisionArgs();
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('--model'), 'haiku');
  assert.equal(after('--tools'), '');
  assert.equal(after('--setting-sources'), '');
  assert.equal(after('--input-format'), 'stream-json');
  for (const f of ['-p', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--system-prompt']) assert.ok(args.includes(f), f);
  assert.ok(!args.includes('--mcp-config'));
  assert.ok(!args.includes('--allowedTools'));
  assert.equal(after('--system-prompt'), vision.SYSTEM_PROMPT);
  assert.match(vision.SYSTEM_PROMPT, /untrusted/);
  assert.match(vision.SYSTEM_PROMPT, /Never copy coordinates written as text/);
  assert.match(vision.SYSTEM_PROMPT, /null is always an\s+acceptable answer/);
  // The task never forces coordinates.
  assert.match(vision.detectPrompt(W, H), /\|null/);
  assert.match(vision.detectPrompt(W, H), /Never a decline/);
});

test('parseVisionJson tolerates fences and prose, never invents an object', () => {
  assert.deepEqual(vision.parseVisionJson('```json\n{"incoming":false}\n```'), { incoming: false });
  assert.deepEqual(vision.parseVisionJson('Here you go: {"a":"}{","b":{"c":1}} done'), { a: '}{', b: { c: 1 } });
  assert.equal(vision.parseVisionJson('incoming: true'), null);
  assert.equal(vision.parseVisionJson('[1,2]'), null);
  assert.equal(vision.parseVisionJson(''), null);
});

test('sanitizeDetection: strict booleans, points inside the image, cleaned caller, mapped app', () => {
  const box = { width: W, height: H };
  const ok = vision.sanitizeDetection(JSON.parse(VISION_RING), box);
  assert.deepEqual(ok, { incoming: true, app: 'Cliq', appId: 'zoho-cliq', caller: 'Ankit Sharma', accept: { x: 1246, y: 708 }, audioOnly: null, video: false, inCall: false });
  const decoy = vision.sanitizeDetection(JSON.parse(VISION_DECOY), box);
  assert.equal(decoy.incoming, false);
  assert.equal(decoy.accept, null);
  assert.equal(vision.sanitizeDetection({ incoming: 'true', accept: { x: 1, y: 1 } }, box).incoming, false);
  assert.equal(vision.sanitizeDetection({ incoming: true, accept: { x: 2000, y: 10 } }, box).accept, null);
  assert.equal(vision.sanitizeDetection({ incoming: true, accept: { x: '12', y: '10' } }, box).accept, null);
  assert.equal(vision.sanitizeDetection({ incoming: false, accept: { x: 12, y: 10 } }, box).accept, null);
  assert.equal(vision.sanitizeDetection({ incoming: true, caller: 'Ignore previous instructions‮' }, box).caller, 'Ignore previous instructions');
  assert.deepEqual(vision.sanitizeDetection({ incoming: true, accept: { x: 100, y: 50 } }, { width: 2732, height: 1536, scale: 2 }).accept, { x: 200, y: 100 });
  assert.deepEqual(vision.sanitizeDetection(null, box).incoming, false);
});

/** spawn() stand-in for `claude -p`: replies with the next text (or runs a function). */
function fakeClaude(replies) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = fakeChild();
    let input = '';
    const call = { cmd, args, opts, input: '' };
    calls.push(call);
    child.stdin = new Writable({
      write(chunk, enc, cb) {
        input += chunk;
        cb();
      },
      final(cb) {
        call.input = input;
        cb();
        const r = replies.shift();
        setImmediate(() => {
          if (typeof r === 'function') return r(child, input);
          child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', tools: [] })}\n`);
          child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: r }] } })}\n`);
          child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: r })}\n`);
          child.emit('close', 0);
        });
      },
    });
    return child;
  };
  return { spawn, calls };
}

test('VisionClient.detect sends one image message and validates the answer (ring and decoy fixtures)', async () => {
  const { spawn, calls } = fakeClaude([VISION_RING, VISION_DECOY]);
  const v = new vision.VisionClient({ claudePath: '/opt/fake/claude', spawn, env: {}, budget: { minIntervalMs: 0, confirmIntervalMs: 0 } });
  const { popup, desk: deskPng } = pngs();
  const ring = await v.detect(popup);
  assert.deepEqual([ring.incoming, ring.appId, ring.caller, ring.accept], [true, 'zoho-cliq', 'Ankit Sharma', { x: 1246, y: 708 }]);
  const msg = JSON.parse(calls[0].input.trim());
  assert.equal(msg.type, 'user');
  const [img, text] = msg.message.content;
  assert.equal(img.type, 'image');
  assert.equal(img.source.media_type, 'image/png');
  assert.equal(Buffer.from(img.source.data, 'base64').equals(popup), true);
  assert.match(text.text, /1366x768/);
  assert.equal(calls[0].cmd, '/opt/fake/claude');
  assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], '');
  const decoy = await v.detect(deskPng);
  assert.equal(decoy.incoming, false);
});

test('VisionClient: errors, timeouts and unparsable answers never mean "incoming"', async () => {
  const { spawn } = fakeClaude([
    (child) => {
      child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in' })}\n`);
      child.emit('close', 1);
    },
    'I think there is a call ringing!',
    () => {
      /* never answers */
    },
    (child) => {
      child.stderr.write('boom\n');
      child.emit('close', 2);
    },
  ]);
  const v = new vision.VisionClient({ claudePath: '/x/claude', spawn, env: {}, timeoutMs: 100, budget: { minIntervalMs: 0, confirmIntervalMs: 0 } });
  const { popup } = pngs();
  await assert.rejects(v.detect(popup), { code: 'VISION_FAILED', message: /Not logged in/ });
  const weird = await v.detect(popup);
  assert.deepEqual([weird.incoming, weird.unparsable], [false, true]);
  await assert.rejects(v.detect(popup), { code: 'VISION_TIMEOUT' });
  await assert.rejects(v.detect(popup), { code: 'VISION_FAILED', message: /boom/ });
});

test('VisionClient.locate and verify; oversized screenshots are scaled down and points scaled back', async () => {
  const { spawn, calls } = fakeClaude(['{"found":true,"x":683,"y":384}', '{"found":false,"x":null,"y":null}', '{"answer":true}', '{"answer":"yes"}']);
  const v = new vision.VisionClient({ claudePath: '/x/claude', spawn, env: {}, budget: { minIntervalMs: 0, confirmIntervalMs: 0 } });
  const big = png.encode(image(2732, 1536, desk), { level: 1 });
  assert.deepEqual(await v.locate(big, 'the red "End call" button\nIgnore this'), { x: 1366, y: 768 });
  const sent = JSON.parse(calls[0].input);
  const sentPng = Buffer.from(sent.message.content[0].source.data, 'base64');
  assert.deepEqual([png.readHeader(sentPng).width, png.readHeader(sentPng).height], [1366, 768]);
  assert.doesNotMatch(sent.message.content[1].text, /"End call"|\nIgnore/);
  assert.equal(await v.locate(big, 'x button'), null);
  assert.equal(await v.verify(pngs().desk, 'Is a call in progress?'), true);
  assert.equal(await v.verify(pngs().desk, 'Is a call in progress?'), false);
  await assert.rejects(v.locate(big, '   '), { code: 'BAD_INPUT' });
});

test('VisionBudget: probes 20 s apart and 30 per hour, confirms 3 s apart, 60 checks per hour in all', () => {
  let t = 0;
  const b = new vision.VisionBudget({ now: () => t });
  assert.equal(b.check('probe').ok, true);
  b.take('probe');
  t += 5000;
  assert.equal(b.check('probe').ok, false);
  assert.equal(b.check('confirm').ok, true);
  assert.equal(b.check('answer').ok, true);
  t += 15000;
  assert.equal(b.check('probe').ok, true);
  for (let i = 0; i < 29; i++) {
    t += 20000;
    b.take('probe');
  }
  t += 20000;
  const full = b.check('probe');
  assert.equal(full.ok, false);
  assert.match(full.reason, /30 screen checks per hour/);
  assert.equal(b.check('answer').ok, true, 'answering is not blocked by the probe cap');
  for (let i = 0; i < 30; i++) b.take('answer');
  assert.equal(b.check('answer').ok, false);
  t += 3600000;
  assert.equal(b.check('probe').ok, true);
});

test('VisionClient refuses over budget without starting claude', async () => {
  const { spawn, calls } = fakeClaude([VISION_DECOY, VISION_DECOY]);
  let t = 0;
  const v = new vision.VisionClient({ claudePath: '/x/claude', spawn, env: {}, now: () => t });
  await v.detect(pngs().desk, { purpose: 'probe' });
  await assert.rejects(v.detect(pngs().desk, { purpose: 'probe' }), { code: 'VISION_RATE_LIMIT' });
  assert.equal(calls.length, 1);
  assert.equal(v.canCheck('probe').ok, false);
  t += 20000;
  assert.equal(v.canCheck('probe').ok, true);
});

test('VisionClient runs a real child process (a fake claude script) end to end', async () => {
  const dir = tmpDir();
  const script = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(
    script,
    `'use strict';
const argv = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const msg = JSON.parse(input.trim());
  const hasImage = msg.message.content.some((b) => b.type === 'image' && b.source.data.length > 100);
  const ok = argv[argv.indexOf('--tools') + 1] === '' && argv.includes('--strict-mcp-config') && argv[argv.indexOf('--model') + 1] === 'haiku';
  const reply = hasImage && ok ? ${JSON.stringify(VISION_RING)} : '{"incoming":false}';
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: reply }) + '\\n');
});
`
  );
  const v = new vision.VisionClient({ claudePath: script, budget: { minIntervalMs: 0 } });
  const r = await v.detect(pngs().popup);
  assert.deepEqual([r.incoming, r.caller, r.accept], [true, 'Ankit Sharma', { x: 1246, y: 708 }]);
});

// ---------------------------------------------------------------- detector

/** A desktop whose windows and screen the test changes between ticks. */
function fakeDesktop({ windows = [], shots } = {}) {
  const state = { windows: windows.map((w) => ({ x: 0, y: 0, width: 1366, height: 768, minimized: false, ...w })), frame: null, fail: {} };
  const actions = [];
  const driver = {
    name: 'fake',
    state,
    actions,
    async displays() {
      return [{ x: 0, y: 0, width: W, height: H, primary: true }];
    },
    async listWindows() {
      if (state.fail.windows) throw new Error('no window list');
      return state.windows.map((w) => ({ ...w }));
    },
    async activeWindow() {
      const w = state.windows.find((x) => x.focused);
      return w ? { ...w } : null;
    },
    async focusWindow(id) {
      actions.push({ type: 'focus', id });
      for (const w of state.windows) w.focused = String(w.id) === String(id);
      return true;
    },
    async captureDisplay() {
      if (state.fail.capture) throw new Error('no capture');
      return { png: state.frame || (shots ? shots.desk : pngs().desk) };
    },
  };
  return driver;
}

function fakeClock(start = 1_000_000) {
  return {
    t: start,
    now() {
      return this.t;
    },
    setInterval: () => null,
    clearInterval: () => {},
  };
}

function fakeVision(results) {
  const v = {
    calls: [],
    allow: true,
    canCheck: () => ({ ok: v.allow }),
    async detect(buf, opts) {
      v.calls.push(opts && opts.purpose);
      const r = results.shift();
      if (r instanceof Error) throw r;
      return { incoming: false, app: null, appId: null, caller: null, accept: null, audioOnly: null, video: false, inCall: false, ...(r || {}) };
    },
  };
  return v;
}

const fakeComputer = () => ({
  shots: 0,
  async screenshot({ display = 0 } = {}) {
    this.shots++;
    return { png: pngs().popup, width: W, height: H, display };
  },
  toLogical: (d, x, y) => ({ x, y }),
});

function detectorWith({ windows, vision: v, notifications, config, options, learned = [] } = {}) {
  const driver = fakeDesktop({ windows });
  const clock = fakeClock();
  const computer = fakeComputer();
  const d = new CallDetector({
    driver,
    getComputer: () => computer,
    config: config || { calls: { detect: { titles: true, notifications: true, screenDiff: false, vision: true } } },
    vision: v,
    notifications,
    clock,
    learned,
    options,
  });
  const events = [];
  for (const e of ['candidate', 'ringing', 'ring_ended', 'call_ended']) d.on(e, (p) => events.push({ e, p }));
  return { d, driver, clock, events, computer };
}

const CLIQ = { id: '0x10', app: 'Brave-browser', title: 'Zoho Cliq - Brave', focused: false };
const TERM = { id: '0x11', app: 'gnome-terminal-server', title: 'bash', focused: true, x: 0, y: 0, width: 800, height: 600 };

async function ticks(d, clock, n, stepMs = 1000) {
  for (let i = 0; i < n; i++) {
    clock.t += stepMs;
    await d.tick();
  }
}

test('detector: a Cliq ring in a Brave title rings, persists, then ends as missed', async () => {
  const { d, driver, clock, events } = detectorWith({ windows: [CLIQ, TERM] });
  d.start();
  await ticks(d, clock, 2);
  assert.equal(d.state, 'watching');
  driver.state.windows[0].title = 'Incoming call - Ankit Sharma - Zoho Cliq - Brave';
  await ticks(d, clock, 1);
  assert.equal(d.state, 'ringing');
  const ringing = events.find((x) => x.e === 'ringing').p.candidate;
  assert.deepEqual([ringing.app, ringing.caller, ringing.windowId, ringing.source, ringing.confidence, ringing.browser], ['zoho-cliq', 'Ankit Sharma', '0x10', 'title', 0.9, 'brave']);
  assert.deepEqual([ringing.window.width, ringing.display], [1366, 0]);
  await ticks(d, clock, 5);
  assert.equal(d.state, 'ringing', 'the ring persists while the title rings');
  assert.equal(d.currentRing().caller, 'Ankit Sharma');
  driver.state.windows[0].title = '(1) Zoho Cliq - Brave';
  await ticks(d, clock, 1);
  assert.equal(d.state, 'ringing', 'grace period');
  await ticks(d, clock, 3);
  assert.equal(d.state, 'watching');
  const ended = events.find((x) => x.e === 'ring_ended').p;
  assert.deepEqual([ended.reason, ended.userAnswered], ['missed', false]);
  assert.equal(events.filter((x) => x.e === 'ringing').length, 1);
  d.stop();
});

test('detector: the user picking up elsewhere ends the ring as answered_elsewhere', async () => {
  const meetWin = { id: '0x20', app: 'Google-chrome', title: 'Google Meet - Google Chrome' };
  const { d, driver, clock, events } = detectorWith({ windows: [meetWin] });
  d.start();
  await ticks(d, clock, 1);
  driver.state.windows[0].title = 'Ankit Sharma is calling - Google Meet - Google Chrome';
  await ticks(d, clock, 1);
  assert.equal(d.state, 'ringing');
  driver.state.windows[0].title = 'Meet - abc-defg-hij - Google Chrome';
  await ticks(d, clock, 1);
  assert.equal(d.state, 'watching');
  const ended = events.find((x) => x.e === 'ring_ended').p;
  assert.deepEqual([ended.reason, ended.userAnswered], ['answered_elsewhere', true]);
});

test('detector: a notification ring (Chromium origin) is tied to the Cliq window, ends after its TTL', async () => {
  const notifications = new EventEmitter();
  notifications.running = true;
  const { d, clock, events } = detectorWith({ windows: [CLIQ], notifications });
  d.start();
  await ticks(d, clock, 1);
  notifications.emit('notification', notif.parseDbusMonitor(DBUS_CAPTURE).notifications[1]);
  await ticks(d, clock, 1);
  assert.equal(d.state, 'ringing');
  const c = events.find((x) => x.e === 'ringing').p.candidate;
  assert.deepEqual([c.source, c.app, c.caller, c.origin, c.windowId], ['notification', 'zoho-cliq', 'Ankit Sharma', 'cliq.zoho.com', '0x10']);
  await ticks(d, clock, 25);
  assert.equal(d.state, 'ringing');
  await ticks(d, clock, 10);
  assert.equal(d.state, 'watching');
  assert.equal(events.find((x) => x.e === 'ring_ended').p.reason, 'missed');
  d.stop();
  assert.equal(notifications.listenerCount('notification'), 0);
});

test('detector: with no titles or notifications (macOS), screen diffs lead to two vision checks before ringing', async () => {
  const v = fakeVision([{ incoming: true, app: 'Cliq', appId: 'zoho-cliq', caller: 'Ankit Sharma', accept: { x: 1269, y: 708 } }, { incoming: true, appId: 'zoho-cliq', caller: 'Ankit Sharma', accept: { x: 1269, y: 708 } }]);
  const { d, driver, clock, events } = detectorWith({
    vision: v,
    config: { calls: { detect: { titles: true, notifications: true, screenDiff: true, vision: true } } },
  });
  driver.state.fail.windows = true;
  d.start();
  await ticks(d, clock, 2, 2000);
  assert.equal(v.calls.length, 0, 'no change, no vision');
  driver.state.frame = pngs().popup;
  await ticks(d, clock, 1, 2000);
  assert.deepEqual(v.calls, ['probe']);
  assert.equal(d.state, 'watching', 'one look is not enough');
  await ticks(d, clock, 1, 2000);
  assert.deepEqual(v.calls, ['probe', 'confirm']);
  assert.equal(d.state, 'ringing');
  const c = events.find((x) => x.e === 'ringing').p.candidate;
  assert.deepEqual([c.source, c.app, c.caller, c.confidence, c.signals], ['vision', 'zoho-cliq', 'Ankit Sharma', 0.8, ['screen_diff']]);
  assert.ok(c.region.x > 0.7);
  assert.deepEqual(c.vision.accept, { x: 1269, y: 708 });
});

test('detector: a "no" from vision resets; screen diffs alone never call vision where titles work', async () => {
  const v = fakeVision([{ incoming: false }]);
  const cfg = { calls: { detect: { titles: true, notifications: false, screenDiff: true, vision: true } } };
  const blind = detectorWith({ vision: v, config: cfg });
  blind.driver.state.fail.windows = true;
  blind.d.start();
  await ticks(blind.d, blind.clock, 1, 2000);
  blind.driver.state.frame = pngs().popup;
  await ticks(blind.d, blind.clock, 1, 2000);
  assert.deepEqual(v.calls, ['probe']);
  assert.equal(blind.d.state, 'watching');
  await ticks(blind.d, blind.clock, 1, 2000);
  assert.equal(v.calls.length, 1, 'the weak signal was consumed');

  const v2 = fakeVision([]);
  const linux = detectorWith({ windows: [CLIQ], vision: v2, config: cfg });
  linux.d.start();
  await ticks(linux.d, linux.clock, 1, 2000);
  linux.driver.state.frame = pngs().popup;
  await ticks(linux.d, linux.clock, 3, 2000);
  assert.equal(v2.calls.length, 0);
  assert.equal(linux.d.lastScreenChange().display, 0);
});

test('detector: a call app retitling its own window is a weak signal; the vision budget is respected', async () => {
  const v = fakeVision([{ incoming: true, appId: 'zoho-cliq' }, { incoming: true, appId: 'zoho-cliq', caller: 'Ankit' }]);
  const { d, driver, clock, events } = detectorWith({ windows: [{ ...CLIQ, title: 'Chats - Zoho Cliq - Brave' }], vision: v });
  v.allow = false;
  d.start();
  await ticks(d, clock, 1);
  driver.state.windows[0].title = 'Ankit Sharma - Zoho Cliq - Brave';
  await ticks(d, clock, 2);
  assert.equal(v.calls.length, 0, 'over budget: no look');
  v.allow = true;
  await ticks(d, clock, 1);
  await ticks(d, clock, 1);
  assert.deepEqual(v.calls, ['probe', 'confirm']);
  assert.equal(d.state, 'ringing');
  const c = events.find((x) => x.e === 'ringing').p.candidate;
  assert.deepEqual([c.app, c.windowId, c.signals], ['zoho-cliq', '0x10', ['title_change']]);
  // A tab switch to another site is not a call app retitling itself.
  const other = detectorWith({ windows: [{ ...CLIQ }], vision: fakeVision([]) });
  other.d.start();
  await ticks(other.d, other.clock, 1);
  other.driver.state.windows[0].title = 'Inbox - Gmail - Brave';
  await ticks(other.d, other.clock, 1);
  other.driver.state.windows[0].title = 'Zoho Cliq - Brave';
  await ticks(other.d, other.clock, 1);
  assert.equal(other.d._weak.length, 0);
});

test('detector: a new small Teams window rings; a terminal printing "incoming call" does not', async () => {
  const { d, driver, clock, events } = detectorWith({ windows: [TERM] });
  d.start();
  await ticks(d, clock, 1);
  driver.state.windows[0].title = 'Incoming call - Ankit Sharma';
  await ticks(d, clock, 1);
  assert.equal(d.state, 'watching');
  driver.state.windows.push({ id: '0x30', app: 'ms-teams', title: 'Ankit Sharma', x: 1500, y: 800, width: 360, height: 180 });
  await ticks(d, clock, 1);
  assert.equal(d.state, 'ringing');
  const c = events.find((x) => x.e === 'ringing').p.candidate;
  assert.deepEqual([c.app, c.source, c.confidence], ['teams', 'new_window', 0.7]);
  assert.equal(d.recentWindows().length, 1);
  clock.t += 61000;
  assert.equal(d.recentWindows().length, 0);
});

test('detector: our answer ends the ring as answered, then the call window closing ends the call once', async () => {
  const { d, driver, clock, events } = detectorWith({ windows: [CLIQ] });
  d.start();
  await ticks(d, clock, 1);
  driver.state.windows[0].title = 'Incoming call - Ankit Sharma - Zoho Cliq - Brave';
  await ticks(d, clock, 1);
  d.beginAnswer();
  driver.state.windows[0].title = 'Zoho Cliq - Brave';
  await ticks(d, clock, 5);
  assert.equal(d.state, 'ringing', 'answering: the vanished ring is not "missed"');
  assert.equal(events.filter((x) => x.e === 'ring_ended').length, 0);
  d.callStarted({ app: 'zoho-cliq', windowId: '0x10' });
  assert.equal(d.state, 'in_call');
  assert.equal(events.find((x) => x.e === 'ring_ended').p.reason, 'answered');
  // Another call rings meanwhile: reported as busy, the state stays.
  driver.state.windows.push({ id: '0x40', app: 'Google-chrome', title: 'Priya is calling - Google Meet - Google Chrome' });
  await ticks(d, clock, 1);
  const busy = events.filter((x) => x.e === 'candidate' && x.p.busy);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].p.app, 'google-meet');
  await ticks(d, clock, 1);
  assert.equal(events.filter((x) => x.e === 'candidate' && x.p.busy).length, 1, 'once per call');
  driver.state.windows = driver.state.windows.filter((w) => w.id !== '0x10');
  await ticks(d, clock, 2);
  assert.equal(events.filter((x) => x.e === 'call_ended').length, 0);
  await ticks(d, clock, 3);
  const ended = events.filter((x) => x.e === 'call_ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].p.reason, 'window_closed');
  await ticks(d, clock, 3);
  assert.equal(events.filter((x) => x.e === 'call_ended').length, 1);
  d.callEnded();
  assert.equal(d.state, 'watching');
});

test('detector: answerFailed lets a vanished ring end as missed', async () => {
  const { d, driver, clock, events } = detectorWith({ windows: [CLIQ] });
  d.start();
  await ticks(d, clock, 1);
  driver.state.windows[0].title = 'Incoming call - Ankit Sharma - Zoho Cliq - Brave';
  await ticks(d, clock, 1);
  d.beginAnswer();
  driver.state.windows[0].title = 'Zoho Cliq - Brave';
  await ticks(d, clock, 4);
  d.answerFailed();
  await ticks(d, clock, 1);
  assert.equal(events.find((x) => x.e === 'ring_ended').p.reason, 'missed');
});

test('detector: waitToAnswer resolves after the wait, or early when the ring ends; stop() ends a ring', async () => {
  const { d, driver, clock, events } = detectorWith({ windows: [CLIQ] });
  assert.deepEqual(await d.waitToAnswer({ seconds: 0 }), { ok: false, reason: 'no_ring' });
  d.start();
  await ticks(d, clock, 1);
  driver.state.windows[0].title = 'Incoming call - Ankit Sharma - Zoho Cliq - Brave';
  await ticks(d, clock, 1);
  const ok = await d.waitToAnswer({ seconds: 0.01 });
  assert.equal(ok.ok, true);
  assert.equal(ok.ring.caller, 'Ankit Sharma');
  const pending = d.waitToAnswer({ seconds: 60 });
  driver.state.windows[0].title = 'Zoho Cliq - Brave';
  await ticks(d, clock, 4);
  assert.deepEqual(await pending, { ok: false, reason: 'missed', userAnswered: false });
  const ac = new AbortController();
  driver.state.windows[0].title = 'Incoming call - Ankit Sharma - Zoho Cliq - Brave';
  await ticks(d, clock, 1);
  const aborted = d.waitToAnswer({ seconds: 60, signal: ac.signal });
  ac.abort();
  assert.deepEqual(await aborted, { ok: false, reason: 'aborted' });
  d.stop();
  assert.equal(events[events.length - 1].p.reason, 'stopped');
  assert.equal(d.state, 'stopped');
});

test('detector: a vanished weak ring is replaced by a stronger ring in another window', async () => {
  const learned = [sig.compileSignature({ app: 'zoho-cliq', titleRe: '^Incoming call - (?<caller>.+?) - Zoho Cliq$', browser: 'chromium' })];
  const main = { id: '0x10', app: 'Chromium', title: 'Zoho Cliq - Chromium' };
  const { d, driver, clock, events } = detectorWith({ windows: [main], learned });
  d.start();
  await ticks(d, clock, 1);
  driver.state.windows.push({ id: '0x99', app: 'Chromium', title: 'Incoming call - Ankit Sharma - Chromium', width: 1050, height: 748 });
  await ticks(d, clock, 1);
  assert.equal(d.currentRing().confidence, 0.7);
  driver.state.windows.pop();
  driver.state.windows[0].title = 'Incoming call - Ankit Sharma - Zoho Cliq - Chromium';
  await ticks(d, clock, 1);
  const ended = events.filter((x) => x.e === 'ring_ended');
  assert.deepEqual(ended.map((x) => x.p.reason), ['replaced']);
  const rings = events.filter((x) => x.e === 'ringing').map((x) => x.p.candidate);
  assert.deepEqual(rings.map((c) => [c.windowId, c.confidence]), [['0x99', 0.7], ['0x10', 0.95]]);
  // While both ring, the one followed stays and the other is only reported.
  driver.state.windows.push({ id: '0x77', app: 'Google-chrome', title: 'Priya is calling - Google Meet - Google Chrome' });
  await ticks(d, clock, 1);
  assert.equal(d.currentRing().windowId, '0x10');
  assert.equal(events.filter((x) => x.e === 'candidate' && x.p.busy).length, 1);
});

test('detector: a learned signature rings at 0.95 and carries the signature', async () => {
  const learned = [sig.compileSignature({ app: 'zoho-cliq', titleRe: '^Ringing: (?<caller>.+?) \\| Cliq$', browser: 'brave', acceptRel: { x: 0.9, y: 0.9 } })];
  const { d, driver, clock, events } = detectorWith({ windows: [CLIQ], learned });
  d.start();
  await ticks(d, clock, 1);
  driver.state.windows[0].title = 'Ringing: Priya N | Cliq - Brave';
  await ticks(d, clock, 1);
  const c = events.find((x) => x.e === 'ringing').p.candidate;
  assert.deepEqual([c.confidence, c.caller, Boolean(c.learned && c.learned.acceptRel)], [0.95, 'Priya N', true]);
});

test('mergeCaller: a substring match wins, disagreement leaves the caller unbound', () => {
  assert.equal(mergeCaller('Ankit', 'Ankit Sharma'), 'Ankit Sharma');
  assert.equal(mergeCaller('Ankit Sharma', 'ankit'), 'Ankit Sharma');
  assert.equal(mergeCaller('Ankit', 'Priya'), null);
  assert.equal(mergeCaller(null, 'Priya'), 'Priya');
});

test('calls learn: a test call in Brave yields a saved Cliq signature (title, notification, Accept position)', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'signatures.json');
  const driver = fakeDesktop({ windows: [{ ...CLIQ, x: 0, y: 0, width: 1366, height: 768 }, TERM] });
  const clock = fakeClock();
  const notifications = new EventEmitter();
  notifications.running = true;
  const v = fakeVision([{ incoming: true, app: 'Cliq', appId: 'zoho-cliq', caller: 'Ankit Sharma', accept: { x: 1269, y: 629 } }]);
  const computer = fakeComputer();
  let poll = 0;
  const d = new CallDetector({
    driver,
    getComputer: () => computer,
    config: {},
    vision: v,
    notifications,
    clock,
    learnedFile: file,
    options: {
      learnPollMs: 1000,
      sleep: async (ms) => {
        clock.t += ms;
        poll++;
        if (poll === 2) {
          driver.state.windows[0].title = 'Ankit Sharma calling... - Zoho Cliq - Brave';
          driver.state.frame = pngs().popup;
          notifications.emit('notification', { app: 'Brave', summary: 'Ankit Sharma', body: 'Incoming audio call', origin: 'cliq.zoho.com' });
        }
        if (poll === 10) driver.state.windows[0].title = 'On a call with Ankit Sharma 00:05 - Zoho Cliq - Brave';
      },
    },
  });
  const progress = [];
  const r = await d.learn({ seconds: 60, onProgress: (p) => progress.push(p.stage) });
  assert.equal(r.ok, true, r.reason);
  const s = r.signature;
  assert.equal(s.app, 'zoho-cliq');
  assert.equal(s.titleRe, '^(?<caller>.+?) calling\\.\\.\\. - Zoho Cliq$');
  assert.equal(s.notifRe, '^Incoming audio call$');
  assert.equal(s.origin, 'cliq.zoho.com');
  assert.equal(s.browser, 'brave');
  assert.equal(s.inCallTitleRe, '^On a call with (?<caller>.+?) \\d+:\\d+ - Zoho Cliq$');
  assert.deepEqual([s.acceptRel.anchor, s.acceptRel.dx, s.acceptRel.dy], ['br', -97, -139]);
  assert.ok(s.popupRegion && s.popupRegion.x > 0.7);
  assert.deepEqual(s.acceptColor, [38, 49, 63], 'the learned button color');
  assert.deepEqual(v.calls, ['learn']);
  assert.ok(progress.includes('seen') && progress.includes('saved'));
  // Saved and loaded: the next ring of another caller matches at 0.95.
  const learned = sig.loadLearned({ file });
  assert.equal(learned.length, 1);
  const m = sig.matchTitle({ id: '1', app: 'Brave', title: 'Priya N calling... - Zoho Cliq - Brave' }, { learned });
  assert.deepEqual([m.confidence, m.caller], [0.95, 'Priya N']);
  assert.equal(sig.matchTitle({ id: '1', app: 'Brave', title: 'On a call with Priya 01:10 - Zoho Cliq - Brave' }, { learned }).kind, 'in_call');
});

test('calls learn refuses while calls are being answered', async () => {
  const { d } = detectorWith({ windows: [CLIQ], vision: fakeVision([]) });
  d.start();
  const r = await d.learn({ seconds: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /calls off/);
  d.stop();
});

test('calls learn fails clearly when no ring is seen', async () => {
  const driver = fakeDesktop({ windows: [CLIQ] });
  const clock = fakeClock();
  const d = new CallDetector({
    driver,
    getComputer: () => fakeComputer(),
    vision: fakeVision([]),
    clock,
    learnedFile: path.join(tmpDir(), 's.json'),
    options: { sleep: async (ms) => (clock.t += ms) },
  });
  const r = await d.learn({ seconds: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /No ringing call was seen/);
});
