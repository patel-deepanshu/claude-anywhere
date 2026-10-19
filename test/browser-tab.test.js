'use strict';

/**
 * Reading the user's browser tab (driver.browserTab and the read_browser_tab MCP tool):
 * URL / Jira parsers, the keyboard reader on every backend's primitives (Linux via a fake
 * runner, macOS via a fake helper transport, Windows via the fake PowerShell host), the JXA
 * helper command, the PowerShell UI Automation walk (pwsh with fake UIA types), the tool, and
 * a live check with Chromium under Xvfb.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const L = require('../src/os/linux');
const D = require('../src/os/darwin');
const W = require('../src/os/win32');
const { createMockDriver } = require('../src/os/index');
const { Computer } = require('../src/os/computer');
const B = require('../src/mcp/tools-browser');
const tools = require('../src/mcp/tools');
const keys = require('../src/os/keys');
const proc = require('../src/shared/proc');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'src', 'os', 'darwin-helper.js');
const FAKE_PS = path.join(__dirname, 'fixtures', 'fake-ps-host.js');
const PWSH = '/usr/local/bin/pwsh';
const HAS_PWSH = fs.existsSync(PWSH);
/** Fast keyboard reader timings for fakes (the real ones wait for real browsers). */
const FAST = { settleMs: 1, keyGapMs: 1, pageFocusMs: 1, pollMs: 2, clipboardMs: 30 };
const JIRA_URL = 'https://acme.atlassian.net/browse/ABC-123';
const PAGE_TEXT = 'Fix login timeout\r\nUsers are logged out after 5 minutes.  \n\n\n\nExpected: 30 minutes.';

// ===========================================================================
// A fake browser: where keyboard focus is and what copy puts on the clipboard
// ===========================================================================

/**
 * @param {{url?:string, text?:string, escapeToPage?:boolean, f6?:string[], copyBlocked?:boolean, clipboard?:string}} [o]
 *   escapeToPage: the second Escape in the address bar focuses the page (Chromium); false keeps it
 *   there (Firefox). f6: the panes F6 visits after the address bar (['page'], or ['toolbar','page']
 *   with a bookmarks bar).
 */
function fakeBrowser(o = {}) {
  const st = {
    url: o.url || JIRA_URL,
    text: o.text === undefined ? PAGE_TEXT : o.text,
    area: 'page',
    escapes: 0,
    selected: null,
    clipboard: o.clipboard === undefined ? 'user clipboard' : o.clipboard,
    keys: [],
    pageEscapes: 0,
    collapsed: 0,
  };
  const cycle = ['omnibox', ...(o.f6 || ['page'])];
  st.press = (combo) => {
    const list = combo.map((k) => String(k).toLowerCase());
    st.keys.push(list.join('+'));
    const mod = list.includes('ctrl') || list.includes('meta');
    const last = list[list.length - 1];
    if (mod && last === 'l' && list.length === 2) {
      st.area = 'omnibox';
      st.escapes = 0;
      st.selected = 'url';
    } else if (last === 'escape' && list.length === 1) {
      if (st.area === 'omnibox') {
        st.escapes++;
        if (st.escapes >= 2 && o.escapeToPage !== false) st.area = 'page';
      } else {
        st.pageEscapes++;
      }
    } else if (last === 'f6' && list.length === 1) {
      st.area = cycle[(cycle.indexOf(st.area) + 1) % cycle.length];
      st.selected = st.area === 'omnibox' ? 'url' : null;
    } else if (mod && last === 'a' && list.length === 2) {
      st.selected = st.area === 'omnibox' ? 'url' : st.area === 'page' ? 'page' : null;
    } else if (mod && last === 'c' && list.length === 2) {
      if (st.selected === 'url') st.clipboard = st.url;
      else if (st.selected === 'page' && !o.copyBlocked && st.text != null) st.clipboard = st.text;
    } else if (list.includes('shift') && (last === 'home' || last === 'up')) {
      st.collapsed++;
      st.selected = null;
    }
  };
  return st;
}

// ===========================================================================
// Parsers
// ===========================================================================

test('normalizeTabUrl adds the scheme browsers hide and rejects search text', () => {
  assert.equal(L.normalizeTabUrl('acme.atlassian.net/browse/ABC-1'), 'https://acme.atlassian.net/browse/ABC-1');
  assert.equal(L.normalizeTabUrl('  https://x.example/a?b=1  '), 'https://x.example/a?b=1');
  assert.equal(L.normalizeTabUrl('http://localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(L.normalizeTabUrl('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(L.normalizeTabUrl('192.168.1.20:8080/browse/ABC-9'), 'http://192.168.1.20:8080/browse/ABC-9');
  assert.equal(L.normalizeTabUrl('8.8.8.8/dns'), 'https://8.8.8.8/dns');
  assert.equal(L.normalizeTabUrl('jira.corp.example:8443/browse/OPS-7'), 'https://jira.corp.example:8443/browse/OPS-7');
  assert.equal(L.normalizeTabUrl('about:blank'), 'about:blank');
  assert.equal(L.normalizeTabUrl('chrome://settings'), 'chrome://settings');
  assert.equal(L.normalizeTabUrl('how to fix login'), null);
  assert.equal(L.normalizeTabUrl('jira'), null);
  assert.equal(L.normalizeTabUrl(''), null);
  assert.equal(L.normalizeTabUrl(null), null);
});

test('identifyBrowser knows the browsers by app name or title suffix on every OS', () => {
  const id = (app, title) => (L.identifyBrowser(app, title) || {}).id || null;
  assert.equal(id('Brave Browser'), 'brave'); // macOS / Windows FileDescription
  assert.equal(id('Brave'), 'brave'); // Linux WM_CLASS brave-browser
  assert.equal(id('brave.exe'), 'brave');
  assert.equal(id('Google Chrome'), 'chrome');
  assert.equal(id('chrome.exe'), 'chrome');
  assert.equal(id('Chromium'), 'chromium');
  assert.equal(id('Microsoft Edge'), 'edge');
  assert.equal(id('msedge'), 'edge');
  assert.equal(id('Vivaldi'), 'vivaldi');
  assert.equal(id('Opera Internet Browser'), 'opera');
  assert.equal(id('Arc'), 'arc');
  assert.equal(id('Firefox'), 'firefox');
  assert.equal(id('Navigator'), 'firefox');
  assert.equal(id('Safari'), 'safari');
  assert.equal(id('Safari Technology Preview'), 'safari');
  assert.equal(id('', '[ABC-1] Fix - Jira - Brave'), 'brave');
  assert.equal(id('', 'Inbox — Mozilla Firefox'), 'firefox');
  assert.equal(id('', 'New Tab - Google Chrome'), 'chrome');
  assert.equal(id('Visual Studio Code', 'browser.js - repo'), null);
  assert.equal(id('Archive Utility'), null);
  assert.equal(id('Anaconda Navigator'), null);
  assert.equal(L.identifyBrowser('Firefox').engine, 'gecko');
  assert.equal(L.identifyBrowser('Safari').engine, 'webkit');
  assert.equal(L.identifyBrowser('Brave').engine, 'chromium');
});

test('normalizeBrowserQuery understands how people name browsers', () => {
  assert.equal(L.normalizeBrowserQuery('Brave'), 'brave');
  assert.equal(L.normalizeBrowserQuery('brave browser'), 'brave');
  assert.equal(L.normalizeBrowserQuery('my Brave browser'), 'brave');
  assert.equal(L.normalizeBrowserQuery('Google Chrome'), 'chrome');
  assert.equal(L.normalizeBrowserQuery('ff'), 'firefox');
  assert.equal(L.normalizeBrowserQuery('MS Edge'), 'edge');
  assert.equal(L.normalizeBrowserQuery('microsoft edge'), 'edge');
  assert.equal(L.normalizeBrowserQuery('browser'), '');
  assert.equal(L.normalizeBrowserQuery(''), '');
  assert.equal(L.normalizeBrowserQuery(undefined), '');
});

test('browserWindows ranks the focused, then most recent, browser window first', () => {
  const wins = [
    { id: '0x1', app: 'Google Chrome', title: 'Docs - Google Chrome', stackIndex: 3 },
    { id: '0x2', app: 'Brave', title: '[ABC-1] One - Jira - Brave', stackIndex: 2 },
    { id: '0x3', app: 'XTerm', title: 'bash', stackIndex: 0, focused: true },
    { id: '0x4', app: 'Brave', title: '[ABC-2] Two - Jira - Brave', stackIndex: 1 },
    { id: '0x5', app: 'Brave', title: 'Minimized - Brave', stackIndex: 4, minimized: true },
    { id: '0x6', app: 'Google Chrome', title: 'Claude Anywhere' },
  ];
  assert.deepEqual(L.browserWindows(wins, '').map((c) => c.window.id), ['0x4', '0x2', '0x1', '0x5']);
  assert.deepEqual(L.browserWindows(wins, 'brave').map((c) => c.window.id), ['0x4', '0x2', '0x5']);
  assert.deepEqual(L.browserWindows(wins, 'chrome').map((c) => c.window.id), ['0x1']);
  assert.deepEqual(L.browserWindows(wins, 'safari'), []);
  // The focused browser window wins over the stacking order.
  const focused = wins.map((w) => (w.id === '0x1' ? { ...w, focused: true } : { ...w, focused: false }));
  assert.equal(L.browserWindows(focused, '')[0].window.id, '0x1');
  // Without stackIndex: list order front to back (macOS, Windows) or newest last (X11 creation order).
  const plain = wins.map(({ stackIndex, ...w }) => w);
  assert.equal(L.browserWindows(plain, 'brave', { zOrdered: true })[0].window.id, '0x2');
  assert.equal(L.browserWindows(plain, 'brave', { zOrdered: false })[0].window.id, '0x4');
  assert.equal(L.browserWindows(wins, '', { exclude: (w) => w.id === '0x4' })[0].window.id, '0x2');
});

test('sameWindowId, looksLikeAddress, cleanPageText and clipTabText', () => {
  assert.equal(L.sameWindowId('0x01200003', '18874371'), true);
  assert.equal(L.sameWindowId('0x1200003', '0x01200003'), true);
  assert.equal(L.sameWindowId('501:42', '501:42'), true);
  assert.equal(L.sameWindowId('501', '501:42'), true);
  assert.equal(L.sameWindowId('501:41', '501:42'), false);
  assert.equal(L.sameWindowId(null, '1'), false);
  assert.equal(L.looksLikeAddress('https://a.example/x'), true);
  assert.equal(L.looksLikeAddress('acme.atlassian.net/browse/A-1', 'https://acme.atlassian.net/browse/A-1'), true);
  assert.equal(L.looksLikeAddress('Fix login timeout\nUsers'), false);
  assert.equal(L.looksLikeAddress('Summary'), false);
  assert.equal(L.cleanPageText(PAGE_TEXT), 'Fix login timeout\nUsers are logged out after 5 minutes.\n\nExpected: 30 minutes.');
  assert.deepEqual(L.clipTabText('abcdef', 4), { text: 'abcd', truncated: true, total: 6 });
  assert.deepEqual(L.clipTabText('abc', 4), { text: 'abc', truncated: false, total: 3 });
  const emoji = `ab${'\u{1F600}'}c`;
  assert.equal(L.clipTabText(emoji, 3).text, 'ab', 'never splits a surrogate pair');
});

test('parseJiraUrl finds the issue on Cloud, Server and Data Center URLs', () => {
  assert.deepEqual(B.parseJiraUrl('https://acme.atlassian.net/browse/ABC-123'), { key: 'ABC-123', baseUrl: 'https://acme.atlassian.net' });
  assert.deepEqual(B.parseJiraUrl('https://acme.atlassian.net/browse/abc-123?focusedCommentId=1'), { key: 'ABC-123', baseUrl: 'https://acme.atlassian.net' });
  assert.deepEqual(
    B.parseJiraUrl('https://acme.atlassian.net/jira/software/c/projects/ABC/boards/12?selectedIssue=ABC-7'),
    { key: 'ABC-7', baseUrl: 'https://acme.atlassian.net' },
  );
  assert.deepEqual(B.parseJiraUrl('https://acme.atlassian.net/jira/software/projects/ABC/issues/ABC-42'), { key: 'ABC-42', baseUrl: 'https://acme.atlassian.net' });
  assert.deepEqual(B.parseJiraUrl('https://acme.atlassian.net/jira/servicedesk/projects/SD/queues/custom/1/SD-12'), { key: 'SD-12', baseUrl: 'https://acme.atlassian.net' });
  // Server / Data Center with and without a context path.
  assert.deepEqual(B.parseJiraUrl('https://jira.corp.example/browse/OPS-9'), { key: 'OPS-9', baseUrl: 'https://jira.corp.example' });
  assert.deepEqual(B.parseJiraUrl('https://tools.corp.example/jira/browse/OPS-9'), { key: 'OPS-9', baseUrl: 'https://tools.corp.example/jira' });
  assert.deepEqual(
    B.parseJiraUrl('https://tools.corp.example/jira/secure/RapidBoard.jspa?rapidView=3&selectedIssue=OPS-10'),
    { key: 'OPS-10', baseUrl: 'https://tools.corp.example/jira' },
  );
  assert.deepEqual(B.parseJiraUrl('http://127.0.0.1:8080/browse/ABC-123'), { key: 'ABC-123', baseUrl: 'http://127.0.0.1:8080' });
  // Custom-domain Cloud UI paths keep the origin.
  assert.deepEqual(B.parseJiraUrl('https://work.acme.example/jira/software/projects/ABC/boards/1?selectedIssue=ABC-5'), { key: 'ABC-5', baseUrl: 'https://work.acme.example' });
  // Not an issue.
  assert.equal(B.parseJiraUrl('https://acme.atlassian.net/jira/your-work'), null);
  assert.equal(B.parseJiraUrl('https://github.com/acme/repo/pull/12'), null);
  assert.equal(B.parseJiraUrl('https://example.com/issues/ABC-1'), null, '/issues/ only counts on Jira hosts');
  assert.equal(B.parseJiraUrl('https://acme.atlassian.net/browse/ABC-0'), null);
  assert.equal(B.parseJiraUrl('ftp://acme.atlassian.net/browse/ABC-1'), null);
  assert.equal(B.parseJiraUrl('not a url'), null);
  assert.equal(B.parseJiraUrl(null), null);
});

test('parseJiraTitle reads "[KEY-123] Summary - Jira" titles, with or without a browser suffix', () => {
  assert.deepEqual(B.parseJiraTitle('[ABC-123] Fix login timeout - Jira'), { key: 'ABC-123', summary: 'Fix login timeout' });
  assert.deepEqual(B.parseJiraTitle('[ABC-123] Fix login timeout - Jira - Brave'), { key: 'ABC-123', summary: 'Fix login timeout' });
  assert.deepEqual(B.parseJiraTitle('[ABC-123] Fix login timeout — Jira — Mozilla Firefox'), { key: 'ABC-123', summary: 'Fix login timeout' });
  assert.deepEqual(B.parseJiraTitle('[OPS-9] Disk full - ACME JIRA'), { key: 'OPS-9', summary: 'Disk full' });
  assert.deepEqual(B.parseJiraTitle('[ABC-1] Migrate - to Jira Cloud - Jira'), { key: 'ABC-1', summary: 'Migrate - to Jira Cloud' });
  assert.deepEqual(B.parseJiraTitle('ABC-77: Crash on save - Jira'), { key: 'ABC-77', summary: 'Crash on save' });
  assert.deepEqual(B.parseJiraTitle('[ABC-5]'), { key: 'ABC-5', summary: '' });
  assert.equal(B.parseJiraTitle('ABC-77 Crash on save - Linear'), null, 'a bare key needs the word Jira');
  assert.equal(B.parseJiraTitle('Board - ABC - Jira'), null);
  assert.equal(B.parseJiraTitle('Pull request #12 - GitHub'), null);
  assert.equal(B.parseJiraTitle(''), null);
});

test('detectJira prefers the URL (with its base URL) and adds the summary from the title', () => {
  assert.deepEqual(B.detectJira(JIRA_URL, '[ABC-123] Fix login timeout - Jira - Brave'), {
    key: 'ABC-123',
    baseUrl: 'https://acme.atlassian.net',
    summary: 'Fix login timeout',
  });
  assert.deepEqual(B.detectJira(null, '', '[ABC-9] From the title - Jira'), { key: 'ABC-9', baseUrl: null, summary: 'From the title' });
  assert.deepEqual(B.detectJira('https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-2', 'Board - Jira'), {
    key: 'ABC-2',
    baseUrl: 'https://acme.atlassian.net',
  });
  assert.equal(B.detectJira('https://example.com', 'Example Domain'), null);
});

// ===========================================================================
// Linux: the keyboard reader through a fake runner
// ===========================================================================

const LX_BROWSER = { hex: '0x01200003', pid: 100, cls: 'brave-browser.Brave-browser', title: '[ABC-123] Fix login timeout - Jira - Brave' };
const LX_TERM = { hex: '0x01400007', pid: 200, cls: 'xterm.XTerm', title: 'bash' };

/** An X11 desktop (wmctrl, xdotool, xclip) whose browser is `br`; key presses go to it while it has focus. */
function fakeX11(br, { windows = [LX_BROWSER, LX_TERM], active = LX_TERM.hex, focusWorks = true } = {}) {
  const desk = { active, focusCalls: [], calls: [] };
  const dec = (hex) => String(parseInt(hex, 16));
  const which = (n) => (['xdotool', 'wmctrl', 'xclip'].includes(n) ? `/usr/bin/${n}` : null);
  const res = (r) => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...r });
  const run = async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    desk.calls.push(line);
    if (line === 'wmctrl -lpGx') {
      return res({ stdout: windows.map((w) => `${w.hex}  0 ${w.pid}   10   10   1000 700  ${w.cls}  vm ${w.title}`).join('\n') + '\n' });
    }
    if (line === 'xdotool getactivewindow') return res({ stdout: `${dec(desk.active)}\n` });
    if (cmd === 'wmctrl' && args[0] === '-i' && args[1] === '-a') {
      desk.focusCalls.push(args[2]);
      if (focusWorks) desk.active = windows.find((w) => parseInt(w.hex, 16) === parseInt(args[2], 16)).hex;
      return res({});
    }
    if (cmd === 'xdotool' && args[0] === 'key') {
      const combo = args[args.length - 1];
      if (parseInt(desk.active, 16) === parseInt(LX_BROWSER.hex, 16)) {
        br.press(combo.split('+').map((k) => ({ super: 'meta', Escape: 'escape', Home: 'home', F6: 'f6', Up: 'up' })[k] || k.toLowerCase()));
      } else {
        desk.strayKeys = (desk.strayKeys || 0) + 1;
      }
      return res({});
    }
    if (cmd === 'xclip' && args.includes('-o')) return res({ stdout: br.clipboard });
    if (cmd === 'xdotool' && args[0] === 'getwindowname') return res({ stdout: 'x\n' });
    if (cmd === 'xdotool' && args[0] === 'getwindowpid') return res({ stdout: '1\n' });
    return res({ code: 1, stderr: `no fake for ${line}` });
  };
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    let data = '';
    child.unref = () => {};
    child.stdin.on('data', (d) => {
      data += d.toString('utf8');
    });
    child.stdin.on('finish', () => {
      br.clipboard = data;
      setImmediate(() => child.emit('exit', 0, null));
    });
    desk.calls.push(`spawn ${cmd} ${args.join(' ')}`);
    return child;
  };
  const driver = L.createDriver({ displayServer: 'x11', run, which, spawn: spawnFn, env: { DISPLAY: ':42', LANG: 'C.UTF-8' }, hostnames: ['vm'] });
  return { driver, desk };
}

test('Linux: browserTab reads the URL and page text with the keyboard and puts everything back', async () => {
  const br = fakeBrowser();
  const { driver, desk } = fakeX11(br);
  let gates = 0;
  const r = await driver.browserTab({ includeText: true, beforeInput: async () => gates++, timing: FAST });
  assert.equal(r.browser, 'Brave');
  assert.equal(r.title, LX_BROWSER.title);
  assert.equal(r.url, JIRA_URL);
  assert.equal(r.method, 'keyboard');
  assert.equal(r.textMethod, 'keyboard');
  assert.equal(r.text, 'Fix login timeout\nUsers are logged out after 5 minutes.\n\nExpected: 30 minutes.');
  assert.equal(r.truncated, false);
  assert.equal(r.tookFocus, true);
  assert.equal(r.clipboard, 'restored');
  assert.equal(r.windowId, LX_BROWSER.hex);
  assert.equal(gates, 2, 'the guard runs before the first key and again before select-all');
  assert.deepEqual(br.keys, ['ctrl+l', 'ctrl+c', 'escape', 'escape', 'ctrl+a', 'ctrl+c', 'ctrl+shift+home']);
  assert.equal(br.pageEscapes, 0, 'Escape never reaches the page (it could close a Jira dialog)');
  assert.equal(br.collapsed, 1, 'the select-all is collapsed');
  assert.equal(br.clipboard, 'user clipboard', 'the clipboard is restored');
  assert.deepEqual(desk.focusCalls.map((h) => parseInt(h, 16)), [parseInt(LX_BROWSER.hex, 16), parseInt(LX_TERM.hex, 16)], 'focus goes back');
  assert.equal(desk.strayKeys || 0, 0);
});

test('Linux: without includeText only the address bar is copied; maxChars truncates the text', async () => {
  const br = fakeBrowser();
  const { driver } = fakeX11(br);
  const r = await driver.browserTab({ timing: FAST });
  assert.equal(r.url, JIRA_URL);
  assert.equal(r.text, undefined);
  assert.deepEqual(br.keys, ['ctrl+l', 'ctrl+c', 'escape', 'escape']);

  const br2 = fakeBrowser();
  const r2 = await fakeX11(br2).driver.browserTab({ includeText: true, maxChars: 10, timing: FAST });
  assert.equal(r2.text, 'Fix login ');
  assert.equal(r2.truncated, true);
  assert.equal(r2.textChars, L.cleanPageText(PAGE_TEXT).length);
});

test('Linux: Firefox keeps focus in the address bar after Escape, so F6 moves it to the page', async () => {
  const br = fakeBrowser({ escapeToPage: false, f6: ['page'] });
  const ff = { hex: '0x01200003', pid: 100, cls: 'Navigator.firefox', title: '[ABC-123] Fix login timeout - Jira — Mozilla Firefox' };
  const { driver } = fakeX11(br, { windows: [ff, LX_TERM] });
  const r = await driver.browserTab({ app: 'firefox', includeText: true, timing: FAST });
  assert.equal(r.browser, 'Firefox');
  assert.equal(r.url, JIRA_URL);
  assert.match(r.text, /^Fix login timeout/);
  assert.deepEqual(br.keys, ['ctrl+l', 'ctrl+c', 'escape', 'escape', 'ctrl+a', 'ctrl+c', 'f6', 'ctrl+a', 'ctrl+c', 'ctrl+shift+home']);
});

test('Linux: a bookmarks bar between the address bar and the page costs one more F6', async () => {
  const br = fakeBrowser({ escapeToPage: false, f6: ['toolbar', 'page'] });
  const { driver } = fakeX11(br);
  const r = await driver.browserTab({ includeText: true, timing: FAST });
  assert.match(r.text, /^Fix login timeout/);
  assert.deepEqual(br.keys.filter((k) => k === 'f6').length, 2);
  assert.equal(br.clipboard, 'user clipboard');
});

test('Linux: a page that blocks copying gives text null with a note, and the clipboard survives', async () => {
  const br = fakeBrowser({ copyBlocked: true });
  const { driver } = fakeX11(br);
  const r = await driver.browserTab({ includeText: true, timing: FAST });
  assert.equal(r.url, JIRA_URL);
  assert.equal(r.text, null);
  assert.ok(r.notes.some((n) => /gave no page text/.test(n)), r.notes.join(' | '));
  assert.equal(br.collapsed, 0);
  assert.equal(br.clipboard, 'user clipboard');
});

test('Linux: a paused guard stops before any key, and focus is not touched', async () => {
  const br = fakeBrowser();
  const { driver, desk } = fakeX11(br);
  const paused = Object.assign(new Error('Actions are paused'), { code: 'PAUSED' });
  await assert.rejects(driver.browserTab({ includeText: true, beforeInput: async () => { throw paused; }, timing: FAST }), (e) => e.code === 'PAUSED');
  assert.deepEqual(br.keys, []);
  assert.deepEqual(desk.focusCalls, []);
  assert.equal(br.clipboard, 'user clipboard');
});

test('Linux: when the browser does not come to the front no keys are sent and only the title is reported', async () => {
  const br = fakeBrowser();
  const { driver, desk } = fakeX11(br, { focusWorks: false });
  const r = await driver.browserTab({ includeText: true, timing: FAST });
  assert.equal(r.method, 'title');
  assert.equal(r.url, null);
  assert.equal(r.text, null);
  assert.ok(r.notes.some((n) => /did not come to the front/.test(n)), r.notes.join(' | '));
  assert.deepEqual(br.keys, []);
  assert.equal(desk.strayKeys || 0, 0);
  assert.equal(br.clipboard, 'user clipboard');
});

test('Linux: keyboard false never touches the keyboard; no browser or a missing one is NOT_FOUND', async () => {
  const br = fakeBrowser();
  const { driver, desk } = fakeX11(br);
  const r = await driver.browserTab({ keyboard: false, timing: FAST });
  assert.equal(r.method, 'title');
  assert.equal(r.url, null);
  assert.deepEqual(desk.focusCalls, []);
  await assert.rejects(driver.browserTab({ app: 'safari', timing: FAST }), (e) => e.code === 'NOT_FOUND' && /No safari window is open\. Open browsers: Brave\./.test(e.message));
  const none = fakeX11(fakeBrowser(), { windows: [LX_TERM] }).driver;
  await assert.rejects(none.browserTab({ timing: FAST }), (e) => e.code === 'NOT_FOUND' && /No browser window is open/.test(e.message) && Boolean(e.hint));
});

test('Linux: the clipboard is left alone when something else changed it meanwhile', async () => {
  const br = fakeBrowser();
  const { driver } = fakeX11(br);
  // Another app copies while the tab is read: after the last copy, the clipboard changes under us.
  const orig = br.press;
  br.press = (combo) => {
    orig(combo);
    if (combo.join('+') === 'ctrl+shift+home') br.clipboard = 'copied by the user meanwhile';
  };
  const r = await driver.browserTab({ includeText: true, timing: FAST });
  assert.equal(r.clipboard, 'changed');
  assert.equal(br.clipboard, 'copied by the user meanwhile');
});

// ===========================================================================
// Mock driver
// ===========================================================================

test('mock driver: browserTab reads state.tabs and calls beforeInput for keyboard reads', async () => {
  const d = createMockDriver();
  let gates = 0;
  const r = await d.browserTab({ includeText: true, beforeInput: async () => gates++ });
  assert.equal(r.browser, 'Google Chrome');
  assert.equal(r.url, 'https://console.cloud.google.com/run?project=my-project');
  assert.equal(r.method, 'keyboard');
  assert.match(r.text, /^Cloud Run\nServices/);
  assert.equal(r.tookFocus, true);
  assert.equal(gates, 1);
  assert.deepEqual(d.actions.filter((a) => a.type === 'browserTab').map((a) => a.windowId), ['0x1002']);

  const s = createMockDriver({
    windows: [{ id: '1:2', app: 'Safari', title: 'Example', focused: true }],
    tabs: { '1:2': { url: 'https://example.com/', method: 'applescript', text: 'x'.repeat(50) } },
  });
  const r2 = await s.browserTab({ beforeInput: async () => gates++ });
  assert.equal(r2.method, 'applescript');
  assert.equal(r2.tookFocus, false);
  assert.equal(gates, 1, 'no input without includeText when the URL is read natively');
  const r3 = await s.browserTab({ includeText: true, maxChars: 10 });
  assert.equal(r3.text.length, 10);
  assert.equal(r3.truncated, true);
  const r4 = await createMockDriver().browserTab({ keyboard: false });
  assert.equal(r4.method, 'title');
  assert.equal(r4.url, null);
});

// ===========================================================================
// macOS: driver over a fake helper transport, and the JXA command itself
// ===========================================================================

const MAC_KEY_NAMES = { 53: 'escape', 97: 'f6', 126: 'up', 115: 'home' };
const MAC_MODS = { 55: 'meta', 56: 'shift', 58: 'alt', 59: 'ctrl' };

function macDesktop(br, { windows, front = 900, handlers = {} } = {}) {
  const state = { front, calls: [] };
  const wins = windows || [
    { number: 41, pid: 501, owner: 'Brave Browser', title: '[ABC-123] Fix login timeout - Jira', layer: 0, alpha: 1, x: 0, y: 25, width: 1200, height: 800 },
    { number: 77, pid: 900, owner: 'iTerm2', title: 'zsh', layer: 0, alpha: 1, x: 100, y: 100, width: 600, height: 400 },
  ];
  const ordered = () => [...wins].sort((a, b) => Number(b.pid === state.front) - Number(a.pid === state.front));
  const transport = {
    calls: state.calls,
    async request(cmd, args = {}, opts = {}) {
      state.calls.push({ cmd, args: JSON.parse(JSON.stringify(args)), opts: { ...opts } });
      if (typeof handlers[cmd] === 'function') return handlers[cmd](args, opts);
      if (cmd === 'perms') return { accessibility: true, screenRecording: true };
      if (cmd === 'automation') return { granted: true, processes: 7 };
      if (cmd === 'inputSource') return { id: 'com.apple.keylayout.US', safe: true };
      if (cmd === 'windows') return { frontPid: state.front, windows: ordered() };
      if (cmd === 'active') {
        const w = ordered().find((x) => x.pid === state.front);
        return { pid: state.front, app: w ? w.owner : '', window: w ? { number: w.number, title: w.title } : null };
      }
      if (cmd === 'focus') {
        state.front = args.pid;
        return { ok: true, raised: true };
      }
      if (cmd === 'key') {
        const mods = (args.modifierKeyCodes || []).map((c) => MAC_MODS[c]).filter(Boolean);
        const name = (args.chars && args.chars[0]) || MAC_KEY_NAMES[args.keyCode] || `key${args.keyCode}`;
        if (state.front === 501) br.press([...mods, name]);
        return { ok: true };
      }
      return { ok: true };
    },
    async restart() {},
    async close() {},
  };
  const run = async (cmd, args = [], opts = {}) => {
    const name = path.basename(cmd);
    if (name === 'pbpaste') return { code: 0, stdout: br.clipboard, stderr: '', timedOut: false, error: null };
    if (name === 'pbcopy') {
      br.clipboard = Buffer.from(opts.input).toString('utf8');
      return { code: 0, stdout: '', stderr: '', timedOut: false, error: null };
    }
    if (name === 'ps') return { code: 0, stdout: '  900     1 /Applications/iTerm.app/Contents/MacOS/iTerm2\n', stderr: '', timedOut: false, error: null };
    return { code: 0, stdout: '', stderr: '', timedOut: false, error: null };
  };
  const driver = D.createDriver({ transport, run, which: (n) => `/usr/bin/${n}`, env: { HOME: '/Users/me', TERM_PROGRAM: 'iTerm.app' }, keys, pid: 4321 });
  return { driver, state };
}

test('macOS: Chromium browsers answer through AppleScript, without any keystroke', async () => {
  const br = fakeBrowser();
  const { driver, state } = macDesktop(br, {
    handlers: { browserTab: () => ({ url: JIRA_URL, title: '[ABC-123] Fix login timeout - Jira', matched: true, text: null, textError: null }) },
  });
  const r = await driver.browserTab({ app: 'brave', timing: FAST });
  assert.equal(r.browser, 'Brave');
  assert.equal(r.url, JIRA_URL);
  assert.equal(r.method, 'applescript');
  assert.equal(r.tookFocus, false);
  const req = state.calls.filter((c) => c.cmd === 'browserTab');
  assert.deepEqual(req[0].args, { app: 'Brave Browser', kind: 'chromium', title: '[ABC-123] Fix login timeout - Jira', wantText: false, pid: 501 });
  assert.equal(req[0].opts.timeoutMs, 60000, 'the first request may wait for the Automation consent prompt');
  assert.equal(state.calls.filter((c) => c.cmd === 'key' || c.cmd === 'focus').length, 0);
  await driver.browserTab({ timing: FAST });
  assert.equal(state.calls.filter((c) => c.cmd === 'browserTab')[1].opts.timeoutMs, 10000, 'later requests use the short timeout');
});

test('macOS: page text from the JavaScript bridge needs no keyboard; without it the keyboard uses Cmd', async () => {
  const br = fakeBrowser();
  const withJs = macDesktop(br, { handlers: { browserTab: (a) => ({ url: JIRA_URL, title: 'T', text: a.wantText ? 'Text via AppleScript' : null }) } });
  const r = await withJs.driver.browserTab({ includeText: true, timing: FAST });
  assert.equal(r.text, 'Text via AppleScript');
  assert.equal(r.textMethod, 'applescript');
  assert.equal(withJs.state.calls.filter((c) => c.cmd === 'key').length, 0);
  assert.equal(withJs.state.calls.find((c) => c.cmd === 'browserTab').args.wantText, true);

  const br2 = fakeBrowser();
  const noJs = macDesktop(br2, {
    handlers: { browserTab: () => ({ url: JIRA_URL, title: 'T', text: null, textError: 'Executing JavaScript through AppleScript is turned off.' }) },
  });
  const r2 = await noJs.driver.browserTab({ includeText: true, timing: FAST });
  assert.equal(r2.method, 'applescript');
  assert.equal(r2.textMethod, 'keyboard');
  assert.match(r2.text, /^Fix login timeout/);
  assert.deepEqual(br2.keys, ['meta+l', 'meta+c', 'escape', 'escape', 'meta+a', 'meta+c', 'shift+meta+up']);
  assert.equal(br2.clipboard, 'user clipboard');
  assert.equal(noJs.state.front, 900, 'focus went back to iTerm');
});

test('macOS: a refused Automation prompt (-1743) gives a PERMISSION hint and falls back to the keyboard', async () => {
  const br = fakeBrowser();
  const refuse = () => {
    const e = new Error('browserTab: not allowed to control Brave Browser (Not authorized to send Apple events to Brave Browser.)');
    e.code = 'PERMISSION';
    e.permission = 'automation';
    e.errorNumber = -1743;
    throw e;
  };
  const { driver } = macDesktop(br, { handlers: { browserTab: refuse } });
  const r = await driver.browserTab({ timing: FAST });
  assert.equal(r.url, JIRA_URL);
  assert.equal(r.method, 'keyboard');
  assert.equal(r.permission, 'automation');
  assert.match(r.hint, /System Settings → Privacy & Security → Automation → iTerm → turn on Brave Browser/);
  assert.match(r.hint, /x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Automation/);
  assert.equal(r.settingsUrl, D.SETTINGS_URLS.automation);

  // keyboard: false reports the refusal instead.
  await assert.rejects(macDesktop(fakeBrowser(), { handlers: { browserTab: refuse } }).driver.browserTab({ keyboard: false }), (e) => {
    assert.equal(e.code, 'PERMISSION');
    assert.equal(e.permission, 'automation');
    assert.match(e.hint, /Privacy & Security → Automation/);
    return true;
  });

  // An unanswered prompt (timeout) is reported the same way.
  const pending = macDesktop(fakeBrowser(), {
    handlers: {
      browserTab: () => {
        throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
      },
    },
  });
  const r3 = await pending.driver.browserTab({ timing: FAST });
  assert.equal(r3.permission, 'automation');
  assert.ok(r3.notes.some((n) => /still asking whether "?iTerm"? may control Brave Browser/.test(n)), r3.notes.join(' | '));
});

test('macOS: Firefox has no AppleScript tab access, so the keyboard reads it', async () => {
  const br = fakeBrowser();
  const { driver, state } = macDesktop(br, {
    windows: [
      { number: 5, pid: 501, owner: 'Firefox', title: '[ABC-123] Fix login timeout - Jira', layer: 0, alpha: 1, x: 0, y: 25, width: 1200, height: 800 },
      { number: 77, pid: 900, owner: 'iTerm2', title: 'zsh', layer: 0, alpha: 1, x: 100, y: 100, width: 600, height: 400 },
    ],
  });
  const r = await driver.browserTab({ timing: FAST });
  assert.equal(r.browser, 'Firefox');
  assert.equal(r.url, JIRA_URL);
  assert.equal(r.method, 'keyboard');
  assert.equal(state.calls.filter((c) => c.cmd === 'browserTab').length, 0);
});

/** Load darwin-helper.js in a vm with just enough of the ObjC bridge for cmdBrowserTab. */
function jxa(apps, procs = {}) {
  const log = [];
  const wrap = (v) => ({ __v: v, isNil: () => v == null });
  const $ = function (v) {
    return wrap(v);
  };
  Object.assign($, {
    CGEventPost: () => {},
    NSRunningApplication: {
      runningApplicationWithProcessIdentifier: (pid) =>
        procs[pid] ? { isNil: () => false, bundleIdentifier: wrap(procs[pid].bundleId), localizedName: wrap(procs[pid].name) } : { isNil: () => true },
    },
  });
  const ObjC = { import: () => {}, unwrap: (v) => (v && typeof v === 'object' && '__v' in v ? v.__v : v) };
  const Application = (name) => {
    log.push(['Application', name]);
    const app = apps[name];
    if (!app) throw new Error(`Application can't be found.`);
    return app;
  };
  const ctx = vm.createContext({ ObjC, $, Application });
  vm.runInContext(fs.readFileSync(HELPER, 'utf8'), ctx, { filename: 'darwin-helper.js' });
  return { call: (args) => JSON.parse(JSON.stringify(ctx.dispatch({ id: 1, cmd: 'browserTab', args }))), log };
}

function chromiumApp({ running = true, windows = [], denied = false, jsError = null }) {
  const log = [];
  // A JXA element array: indexable, with a length that is an Apple event (here: where -1743 is raised).
  const list = {};
  windows.forEach((w, i) => {
    list[i] = {
      name: () => w.title,
      activeTab: () => ({
        url: () => w.url,
        title: () => w.title,
        execute: (o) => {
          log.push(['execute', o.javascript.slice(0, 10)]);
          if (jsError) throw new Error(jsError);
          return w.text;
        },
      }),
    };
  });
  Object.defineProperty(list, 'length', {
    get() {
      if (denied) throw Object.assign(new Error('Not authorized to send Apple events to Brave Browser.'), { errorNumber: -1743 });
      return windows.length;
    },
  });
  return { running: () => running, windows: list, log };
}

test('helper: browserTab reads the matching Chromium window through its bundle id, never launching the app', () => {
  const brave = chromiumApp({
    windows: [
      { title: 'Other tab', url: 'https://example.com/', text: 'other' },
      { title: '[ABC-123] Fix login timeout - Jira', url: JIRA_URL, text: 'Fix login timeout' },
    ],
  });
  const h = jxa({ 'com.brave.Browser': brave }, { 501: { bundleId: 'com.brave.Browser', name: 'Brave Browser' } });
  const r = h.call({ app: 'Brave Browser', pid: 501, kind: 'chromium', title: '[ABC-123] Fix login timeout - Jira', wantText: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.result, { url: JIRA_URL, title: '[ABC-123] Fix login timeout - Jira', matched: true, text: 'Fix login timeout', textError: null, app: 'Brave Browser' });
  assert.deepEqual(h.log, [['Application', 'com.brave.Browser']]);
  // Without a matching title: the front window (index 0).
  const r2 = h.call({ app: 'Brave Browser', pid: 501, kind: 'chromium', title: 'Nope', wantText: false });
  assert.equal(r2.result.url, 'https://example.com/');
  assert.equal(r2.result.matched, false);
  assert.equal(r2.result.text, null);
});

test('helper: browserTab reports -1743 as PERMISSION/automation, a closed browser as NOT_FOUND, a disabled JS bridge as textError', () => {
  const denied = jxa({ 'Brave Browser': chromiumApp({ denied: true, windows: [{ title: 'x', url: 'https://x.example/' }] }) });
  const r = denied.call({ app: 'Brave Browser', kind: 'chromium' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PERMISSION');
  assert.equal(r.perm, 'automation');
  assert.equal(r.errorNumber, -1743);
  assert.match(r.error, /not allowed to control Brave Browser/);

  const closed = jxa({ 'Google Chrome': chromiumApp({ running: false }) });
  const c = closed.call({ app: 'Google Chrome', kind: 'chromium' });
  assert.equal(c.ok, false);
  assert.equal(c.code, 'NOT_FOUND');

  const noJs = jxa({ Vivaldi: chromiumApp({ windows: [{ title: 't', url: 'https://v.example/' }], jsError: 'Executing JavaScript through AppleScript is turned off.' }) });
  const j = noJs.call({ app: 'Vivaldi', kind: 'chromium', wantText: true });
  assert.equal(j.ok, true);
  assert.equal(j.result.url, 'https://v.example/');
  assert.equal(j.result.text, null);
  assert.match(j.result.textError, /turned off/);

  const gone = jxa({}, {});
  assert.equal(gone.call({ app: 'Brave Browser', pid: 999, kind: 'chromium' }).code, 'NOT_FOUND');
  assert.equal(gone.call({ kind: 'chromium' }).code, 'BAD_ARGS');
});

test('helper: Safari is read through window.currentTab (documents[0] as a fallback) and doJavaScript', () => {
  const log = [];
  const tab = { url: () => JIRA_URL, name: () => 'Jira tab' };
  const windows = [{ name: () => 'Jira tab', currentTab: () => tab }];
  const safari = {
    running: () => true,
    windows,
    documents: [{ url: () => 'https://doc.example/', name: () => 'Doc' }],
    doJavaScript: (code, o) => {
      log.push(['doJavaScript', o.in === tab]);
      return 'Safari page text';
    },
  };
  const h = jxa({ Safari: safari });
  const r = h.call({ app: 'Safari', kind: 'safari', title: 'Jira tab', wantText: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.url, JIRA_URL);
  assert.equal(r.result.title, 'Jira tab');
  assert.equal(r.result.text, 'Safari page text');
  assert.deepEqual(log, [['doJavaScript', true]]);
  const noTab = jxa({ Safari: { ...safari, windows: [{ name: () => 'W', currentTab: () => { throw new Error('no tab'); } }] } });
  const r2 = noTab.call({ app: 'Safari', kind: 'safari' });
  assert.equal(r2.result.url, 'https://doc.example/');
});

test('darwin-helper.js passes node --check', () => {
  const r = spawnSync(process.execPath, ['--check', HELPER], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// ===========================================================================
// Windows: the driver over the fake PowerShell host
// ===========================================================================

function fakePsEnv(extra = {}) {
  return { ...process.env, ANYWHERE_PS_EXE: process.execPath, ANYWHERE_PS_ARGS: JSON.stringify([FAKE_PS]), ...extra };
}

async function hostRequests(driver) {
  return (await driver.host.request('__requests')).requests;
}

test('Windows: the address comes from UI Automation (scheme added back), with no input at all', async () => {
  const driver = await W.createDriver({ wsl: false, env: fakePsEnv() });
  try {
    const r = await driver.browserTab({ app: 'chrome', timing: FAST });
    assert.equal(r.browser, 'Google Chrome');
    assert.equal(r.url, 'https://console.cloud.google.com/run?project=my-project');
    assert.equal(r.method, 'uia');
    assert.equal(r.tookFocus, false);
    const reqs = await hostRequests(driver);
    const tab = reqs.find((q) => q.cmd === 'browsertab');
    assert.deepEqual(tab.args, { hwnd: '1002', budgetMs: 4000 });
    assert.equal(reqs.filter((q) => ['keys', 'focus', 'clipset'].includes(q.cmd)).length, 0);
  } finally {
    await driver.close();
  }
});

test('Windows: page text uses the keyboard; nothing copied means no Escape, F6 retries, clipboard and focus restored', async () => {
  const driver = await W.createDriver({ wsl: false, env: fakePsEnv() });
  try {
    await driver.clipboardSet('user clipboard');
    const r = await driver.browserTab({ includeText: true, timing: FAST });
    assert.equal(r.url, 'https://console.cloud.google.com/run?project=my-project');
    assert.equal(r.method, 'uia');
    assert.equal(r.text, null, 'the fake browser never copies');
    assert.equal(r.tookFocus, true);
    assert.equal(r.clipboard, 'restored');
    const reqs = await hostRequests(driver);
    const vks = reqs.filter((q) => q.cmd === 'keys').map((q) => q.args.vks.join('+'));
    const VK = { ctrl: 17, shift: 16, l: 76, a: 65, c: 67, escape: 27, f6: 117, home: 36 };
    assert.equal(vks[0], `${VK.ctrl}+${VK.l}`, 'Ctrl+L first, to put focus in a known place');
    assert.ok(!vks.includes(String(VK.escape)), 'no Escape unless the address bar copy proved it has focus');
    assert.equal(vks.filter((v) => v === String(VK.f6)).length, 3, 'F6 between the four select-all attempts');
    const focus = reqs.filter((q) => q.cmd === 'focus').map((q) => q.args.hwnd);
    assert.deepEqual(focus, ['1002', '1001'], 'focus goes back to VS Code');
    assert.equal(await driver.clipboardGet(), 'user clipboard');
  } finally {
    await driver.close();
  }
});

test('Windows: no address bar found -> keyboard fallback; nothing copied -> title only', async () => {
  const driver = await W.createDriver({ wsl: false, env: fakePsEnv({ FAKE_PS_BROWSER_TABS: JSON.stringify({ 1002: { found: false, url: null } }) }) });
  try {
    const r = await driver.browserTab({ timing: FAST });
    assert.equal(r.method, 'title');
    assert.equal(r.url, null);
    assert.ok(r.notes.some((n) => /Copying the address bar gave no URL/.test(n)), r.notes.join(' | '));
    // An explicit non-browser window id is read like a Chromium browser, and a closed one is NOT_FOUND.
    await assert.rejects(driver.browserTab({ windowId: '4242', timing: FAST }), (e) => e.code === 'NOT_FOUND');
  } finally {
    await driver.close();
  }
  const typing = await W.createDriver({ wsl: false, env: fakePsEnv({ FAKE_PS_BROWSER_TABS: JSON.stringify({ 1002: { found: true, url: 'how do i', editing: true } }) }) });
  try {
    const r = await typing.browserTab({ keyboard: false });
    assert.equal(r.url, null, 'text being typed in the address bar is not an address');
  } finally {
    await typing.close();
  }
});

test('pwsh: win32-host.ps1 still parses and stays ASCII', { skip: !HAS_PWSH && 'pwsh not installed' }, () => {
  const host = W.HOST_SCRIPT;
  const buf = fs.readFileSync(host);
  assert.equal(buf.findIndex((b) => b > 0x7f), -1);
  const r = spawnSync(
    PWSH,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:HOST_PS1,[ref]$t,[ref]$e);"errors=" + $e.Count'],
    { encoding: 'utf8', env: { ...process.env, HOST_PS1: host }, timeout: 60000 },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /errors=0/);
});

// Minimal stand-ins for System.Windows.Automation, so Get-BrowserTab's walk runs on any OS.
const FAKE_UIA_CS = `
using System;
using System.Collections.Generic;
namespace System.Windows.Automation {
  public sealed class ControlType {
    public int Id { get; private set; }
    private ControlType(int id) { Id = id; }
    public static readonly ControlType Window = new ControlType(50032);
    public static readonly ControlType Pane = new ControlType(50033);
    public static readonly ControlType ToolBar = new ControlType(50021);
    public static readonly ControlType Button = new ControlType(50000);
    public static readonly ControlType Group = new ControlType(50026);
    public static readonly ControlType Edit = new ControlType(50004);
    public static readonly ControlType Document = new ControlType(50030);
  }
  public sealed class AutomationPattern { }
  public sealed class ValuePatternInformation { public string Value; }
  public sealed class ValuePattern {
    public static readonly AutomationPattern Pattern = new AutomationPattern();
    public ValuePatternInformation Current;
  }
  public sealed class ElementInformation { public ControlType ControlType; public string Name; public bool HasKeyboardFocus; }
  public sealed class AutomationElement {
    public ElementInformation Current = new ElementInformation();
    public List<AutomationElement> Children = new List<AutomationElement>();
    public AutomationElement Parent;
    public string Value;
    public static Dictionary<long, AutomationElement> Roots = new Dictionary<long, AutomationElement>();
    public static AutomationElement FromHandle(IntPtr h) {
      AutomationElement e;
      if (Roots.TryGetValue(h.ToInt64(), out e)) return e;
      throw new ArgumentException("Element not available for handle " + h.ToInt64());
    }
    public static AutomationElement NewRoot(long h, string name) {
      var e = new AutomationElement(); e.Current.ControlType = ControlType.Window; e.Current.Name = name; Roots[h] = e; return e;
    }
    public AutomationElement Add(ControlType t, string name, string value, bool focus) {
      var c = new AutomationElement(); c.Current.ControlType = t; c.Current.Name = name; c.Current.HasKeyboardFocus = focus;
      c.Value = value; c.Parent = this; Children.Add(c); return c;
    }
    public bool TryGetCurrentPattern(AutomationPattern p, out object pattern) {
      if (Value != null && p == ValuePattern.Pattern) {
        var vp = new ValuePattern(); vp.Current = new ValuePatternInformation(); vp.Current.Value = Value; pattern = vp; return true;
      }
      pattern = null; return false;
    }
  }
  public sealed class TreeWalker {
    public static readonly TreeWalker ControlViewWalker = new TreeWalker();
    public static int Visits;
    public AutomationElement GetFirstChild(AutomationElement e) { Visits++; return e.Children.Count > 0 ? e.Children[0] : null; }
    public AutomationElement GetNextSibling(AutomationElement e) {
      if (e.Parent == null) return null;
      int i = e.Parent.Children.IndexOf(e);
      return i + 1 < e.Parent.Children.Count ? e.Parent.Children[i + 1] : null;
    }
  }
}`;

test('pwsh: Get-BrowserTab finds the address bar outside the page, by name or as the first Edit', { skip: !HAS_PWSH && 'pwsh not installed', timeout: 120000 }, () => {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -TypeDefinition $env:FAKE_UIA_CS',
    '$t = $null; $e = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:HOST_PS1, [ref]$t, [ref]$e)',
    '$assigns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)',
    '$nameRe = $assigns | Where-Object { $_.Left.Extent.Text -eq "`$script:AddressBarName" } | Select-Object -First 1',
    '. ([scriptblock]::Create($nameRe.Extent.Text))',
    '$want = "New-HostError", "Get-Arg", "Get-IntArg", "Get-Hwnd", "Find-AddressBar", "Get-BrowserTab", "Get-ErrorRecordInfo"',
    'foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { if ($want -contains $f.Name) { . ([scriptblock]::Create($f.Extent.Text)) } }',
    'function Assert-Native { }',
    'function Use-Uia { }',
    '$CT = [System.Windows.Automation.ControlType]',
    // A Chromium-like window: title bar, tab strip, toolbar with the omnibox, then the page with its own fields.
    '$w = [System.Windows.Automation.AutomationElement]::NewRoot(77, "[ABC-123] Fix login timeout - Jira - Brave")',
    '$tb = $w.Add($CT::Pane, "Title bar", $null, $false); [void]$tb.Add($CT::Button, "Minimize", $null, $false)',
    '$tabs = $w.Add($CT::Pane, "Tabs", $null, $false); [void]$tabs.Add($CT::Button, "Search tabs", $null, $false)',
    '$bar = $w.Add($CT::ToolBar, "", $null, $false); [void]$bar.Add($CT::Button, "Back", $null, $false); $g = $bar.Add($CT::Group, "", $null, $false)',
    '[void]$g.Add($CT::Edit, "Address and search bar", "acme.atlassian.net/browse/ABC-123", $false)',
    '$page = $w.Add($CT::Pane, "", $null, $false); $doc = $page.Add($CT::Document, "Page", $null, $false); [void]$doc.Add($CT::Edit, "Search issues", "page field", $false)',
    // A localized name that matches no pattern: the first Edit outside the page wins; later ones are ignored.
    '$w2 = [System.Windows.Automation.AutomationElement]::NewRoot(78, "Some page")',
    '$t2 = $w2.Add($CT::ToolBar, "", $null, $false); [void]$t2.Add($CT::Edit, "Barra", "example.com/a", $true)',
    '$s2 = $w2.Add($CT::Pane, "Side", $null, $false); [void]$s2.Add($CT::Edit, "Notes", "notes", $false)',
    // Only the page has fields: no address bar.
    '$w3 = [System.Windows.Automation.AutomationElement]::NewRoot(79, "Kiosk")',
    '$d3 = $w3.Add($CT::Document, "Page", $null, $false); [void]$d3.Add($CT::Edit, "Address", "in-page", $false)',
    '$out = [ordered]@{}',
    '$out.chromium = Get-BrowserTab ([pscustomobject]@{ hwnd = "77" })',
    '$out.localized = Get-BrowserTab ([pscustomobject]@{ hwnd = "78" })',
    '$out.none = Get-BrowserTab ([pscustomobject]@{ hwnd = "79" })',
    'try { [void](Get-BrowserTab ([pscustomobject]@{ hwnd = "80" })); $out.missing = $null } catch { $out.missing = Get-ErrorRecordInfo $_ }',
    'try { [void](Get-BrowserTab ([pscustomobject]@{ hwnd = "abc" })); $out.bad = $null } catch { $out.bad = Get-ErrorRecordInfo $_ }',
    '[System.Windows.Automation.TreeWalker]::Visits = 0',
    '[void](Get-BrowserTab ([pscustomobject]@{ hwnd = "77"; maxNodes = 3 }))',
    '$out.bounded = [System.Windows.Automation.TreeWalker]::Visits',
    'ConvertTo-Json -InputObject $out -Compress -Depth 6',
  ].join('\n');
  const r = spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, HOST_PS1: W.HOST_SCRIPT, FAKE_UIA_CS },
    timeout: 110000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out.chromium, { found: true, url: 'acme.atlassian.net/browse/ABC-123', title: '[ABC-123] Fix login timeout - Jira - Brave', name: 'Address and search bar', editing: false });
  assert.deepEqual(out.localized, { found: true, url: 'example.com/a', title: 'Some page', name: 'Barra', editing: true });
  assert.deepEqual(out.none, { found: false, url: null, title: 'Kiosk', name: null, editing: false });
  assert.equal(out.missing.code, 'NOT_FOUND');
  assert.equal(out.bad.code, 'BAD_ARGS');
  assert.ok(out.bounded <= 3, `the walk is bounded by maxNodes (visited ${out.bounded})`);
});

// ===========================================================================
// The read_browser_tab tool
// ===========================================================================

function fakeClient({ allowed = true } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, urlPath, body) {
      calls.push({ method, urlPath, body });
      if (urlPath === '/api/mcp/guard') return allowed ? { allowed: true } : { allowed: false, reason: 'the user paused Claude' };
      return { ok: true };
    },
  };
}

function toolFor(driver, client = fakeClient()) {
  const comp = new Computer({ driver, config: { actionDelayMs: 0 } });
  const list = tools.createTools({ computer: comp, getClient: async () => client });
  return { tool: list.find((t) => t.name === 'read_browser_tab'), comp, client };
}

const JIRA_WINDOWS = [
  { id: '0x10', app: 'Code', title: 'repo - Visual Studio Code', focused: true },
  { id: '0x11', app: 'Brave', title: '[ABC-123] Fix login timeout - Jira - Brave', stackIndex: 1 },
  { id: '0x12', app: 'Brave', title: 'Old tab - Brave', stackIndex: 2 },
  { id: '0x13', app: 'Google Chrome', title: 'Claude Anywhere' },
];

test('tool: read_browser_tab is registered through tools.js with read-only annotations by default', () => {
  const { tool } = toolFor(createMockDriver());
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['browser', 'includeText', 'maxChars', 'windowId']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(B.annotationsFor({ includeText: true }).readOnlyHint, false);
  assert.equal(B.annotationsFor({}).readOnlyHint, true);
  assert.equal(B.clampMaxChars(undefined), 20000);
  assert.equal(B.clampMaxChars(5), 200);
  assert.equal(B.clampMaxChars(9e9), 200000);
});

test('tool: returns the Jira issue, the method, a focus note, other windows, and the text last', async () => {
  const driver = createMockDriver({ windows: JIRA_WINDOWS, tabs: { '0x11': { url: JIRA_URL, text: PAGE_TEXT }, '0x12': { url: 'https://old.example/' } } });
  const { tool, client } = toolFor(driver);
  const res = await tool.handler({ browser: 'Brave', includeText: true });
  assert.ok(!res.isError, res.content[0].text);
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.browser, 'Brave');
  assert.equal(out.title, '[ABC-123] Fix login timeout - Jira - Brave');
  assert.equal(out.url, JIRA_URL);
  assert.deepEqual(out.jira, { key: 'ABC-123', baseUrl: 'https://acme.atlassian.net', summary: 'Fix login timeout' });
  assert.equal(out.method, 'keyboard');
  assert.match(out.note, /Briefly brought Brave to the front .*Ctrl\+L and Ctrl\+A.*gave focus back; the clipboard was restored/);
  assert.equal(out.windowId, '0x11');
  assert.deepEqual(out.otherWindows, [{ browser: 'Brave', title: 'Old tab - Brave', windowId: '0x12' }]);
  assert.equal(out.truncated, false);
  assert.equal(out.text, 'Fix login timeout\nUsers are logged out after 5 minutes.\n\nExpected: 30 minutes.');
  assert.deepEqual(Object.keys(out).slice(-2), ['truncated', 'text']);
  assert.ok(client.calls.some((c) => c.urlPath === '/api/mcp/guard'), 'the keyboard path asked the daemon guard');
  await new Promise((r) => setTimeout(r, 20)); // activity posts are fire-and-forget
  const act = client.calls.find((c) => c.urlPath === '/api/mcp/activity');
  assert.ok(act, 'activity is posted');
  assert.match(act.body.summary, /Read Brave tab "\[ABC-123\] Fix login timeout - Jira - Brave" with the keyboard \(ABC-123\)/);

  // windowId picks another window.
  const other = JSON.parse((await tool.handler({ windowId: '0x12' })).content[0].text);
  assert.equal(other.url, 'https://old.example/');
  assert.equal(other.jira, null);
});

test('tool: the pause guard and the failsafe stop keyboard reads; native reads still work while paused', async () => {
  const wins = [{ id: '1:1', app: 'Safari', title: '[ABC-9] Paused - Jira', focused: false }, { id: '2:2', app: 'Terminal', title: 'zsh', focused: true }];
  const tabsState = { '1:1': { url: 'https://acme.atlassian.net/browse/ABC-9', method: 'applescript', text: 'body' } };
  const paused = toolFor(createMockDriver({ windows: wins, tabs: tabsState }), fakeClient({ allowed: false })).tool;
  const ok = JSON.parse((await paused.handler({})).content[0].text);
  assert.equal(ok.method, 'applescript');
  assert.equal(ok.jira.key, 'ABC-9');
  await assert.rejects(paused.handler({ includeText: true }), (e) => e.code === 'PAUSED');

  const driver = createMockDriver({ windows: wins, tabs: tabsState });
  driver.setCursor(0, 0);
  const { tool } = toolFor(driver);
  await assert.rejects(tool.handler({ includeText: true }), (e) => e.code === 'FAILSAFE');
});

test('tool: no browser, an unknown browser and a driver without browserTab are explained', async () => {
  const none = toolFor(createMockDriver({ windows: [{ id: '1', app: 'Terminal', title: 'zsh', focused: true }] })).tool;
  const r = await none.handler({});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No browser window is open\. Open apps: Terminal\./);
  const chrome = toolFor(createMockDriver()).tool;
  const r2 = await chrome.handler({ browser: 'brave' });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /No brave window is open\. Open browsers: Google Chrome\./);
  const r3 = await chrome.handler({ windowId: '0xdead' });
  assert.equal(r3.isError, true);
  const bare = createMockDriver();
  delete bare.browserTab;
  await assert.rejects(toolFor(bare).tool.handler({}), (e) => e.code === 'UNSUPPORTED');
});

test('tool: a title-only result still finds the Jira key, and says the address could not be read', async () => {
  const driver = createMockDriver({ windows: JIRA_WINDOWS, tabs: {} });
  const out = JSON.parse((await toolFor(driver).tool.handler({ browser: 'brave' })).content[0].text);
  assert.equal(out.method, 'title');
  assert.equal(out.url, null);
  assert.deepEqual(out.jira, { key: 'ABC-123', baseUrl: null, summary: 'Fix login timeout' });
  assert.match(out.note, /only the window title is reported/);
});

// ===========================================================================
// Live: Chromium under Xvfb with the real Linux driver
// ===========================================================================

function findChromium() {
  for (const v of [process.env.ANYWHERE_TEST_CHROME, process.env.ANYWHERE_BROWSER]) if (v && fs.existsSync(v)) return v;
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers')) {
      const c = path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (/^chromium-\d+$/.test(d) && fs.existsSync(c)) return c;
    }
  } catch {
    /* not a Playwright image */
  }
  for (const n of ['chromium', 'chromium-browser', 'google-chrome', 'brave-browser']) {
    const p = proc.which(n);
    if (p) return p;
  }
  return null;
}

const LIVE_TOOLS = ['Xvfb', 'openbox', 'xdotool', 'wmctrl', 'xclip'];
const liveChrome = process.platform === 'linux' ? findChromium() : null;
const liveMissing = process.platform === 'linux' ? LIVE_TOOLS.filter((t) => !proc.which(t)) : LIVE_TOOLS;
const liveSkip = process.platform !== 'linux' ? 'Linux only' : liveMissing.length ? `missing ${liveMissing.join(', ')}` : !liveChrome ? 'no Chromium found' : false;

function freeDisplay() {
  for (let n = 171; n < 240; n++) {
    if (!fs.existsSync(`/tmp/.X${n}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${n}`)) return n;
  }
  throw new Error('no free X display number');
}

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

test('live X11: Chromium on a local Jira-like page, read by the real driver and the MCP tool', { skip: liveSkip, timeout: 180000 }, async () => {
  const page =
    '<!doctype html><html><head><meta charset="utf-8"><title>[ABC-123] Fix login timeout - Jira</title></head>' +
    '<body><h1>Fix login timeout</h1><p>Users are logged out after 5 minutes. Expected: 30 minutes.</p>' +
    '<script>window.escapes=0;document.addEventListener("keydown",function(e){if(e.key==="Escape")document.title="ESCAPE REACHED THE PAGE";});</script></body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/browse/ABC-123`;
  const n = freeDisplay();
  const dpy = `:${n}`;
  const env = { ...process.env, DISPLAY: dpy };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-tab-live-'));
  const procs = [];
  try {
    procs.push(spawn('Xvfb', [dpy, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' }));
    await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${n}`), 10000, 'Xvfb');
    procs.push(spawn('openbox', [], { stdio: 'ignore', env }));
    await waitFor(async () => (await proc.run('wmctrl', ['-m'], { env, timeoutMs: 2000 })).code === 0, 10000, 'openbox');
    if (proc.which('xterm')) {
      procs.push(spawn('xterm', ['-xrm', 'XTerm*allowTitleOps: false', '-T', 'AnywhereTabPrev', '-geometry', '60x10+700+500', '-e', 'sh'], { stdio: 'ignore', env: { ...env, PS1: '$ ', ENV: '' } }));
    }
    procs.push(
      spawn(
        liveChrome,
        [
          '--no-sandbox', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu',
          '--password-store=basic', '--disable-features=Translate', '--window-position=10,10', '--window-size=1000,700', url,
        ],
        { stdio: 'ignore', env },
      ),
    );
    const driver = L.createDriver({ displayServer: 'x11', env });
    const browser = await waitFor(
      async () => (await driver.listWindows()).find((w) => /ABC-123/.test(w.title) && L.identifyBrowser(w.app, w.title)),
      60000,
      'the Chromium window',
    );
    let prev = null;
    if (proc.which('xterm')) {
      prev = await waitFor(async () => (await driver.listWindows()).find((w) => w.title === 'AnywhereTabPrev'), 15000, 'xterm');
      await driver.focusWindow(prev.id);
    }
    await driver.clipboardSet('live user clipboard');
    await new Promise((r) => setTimeout(r, 1500)); // let the page settle after the first paint

    let gates = 0;
    const r = await driver.browserTab({ includeText: true, beforeInput: async () => gates++ });
    assert.equal(r.url, url, JSON.stringify(r));
    assert.equal(r.method, 'keyboard');
    assert.equal(r.browser, L.identifyBrowser(browser.app, browser.title).name);
    assert.match(r.title, /\[ABC-123\] Fix login timeout - Jira/);
    assert.match(r.text, /Fix login timeout/);
    assert.match(r.text, /Users are logged out after 5 minutes\./);
    assert.equal(gates, 2);
    assert.deepEqual(B.detectJira(r.url, r.title), { key: 'ABC-123', baseUrl: `http://127.0.0.1:${port}`, summary: 'Fix login timeout' });
    assert.equal(await driver.clipboardGet(), 'live user clipboard', 'the clipboard is restored');
    if (prev) {
      const active = await driver.activeWindow();
      assert.ok(L.sameWindowId(active.id, prev.id), `focus went back to the xterm (active: ${active && active.title})`);
    }
    const after = (await driver.listWindows()).find((w) => L.sameWindowId(w.id, browser.id));
    assert.doesNotMatch(after.title, /ESCAPE REACHED THE PAGE/, 'Escape never reached the page');

    // The MCP tool over a Computer on the same driver.
    const comp = new Computer({ driver, config: { actionDelayMs: 0 } });
    const tool = tools.createTools({ computer: comp }).find((t) => t.name === 'read_browser_tab');
    const res = await tool.handler({ browser: 'chromium' });
    assert.ok(!res.isError, res.content[0].text);
    const out = JSON.parse(res.content[0].text);
    assert.equal(out.url, url);
    assert.equal(out.jira.key, 'ABC-123');
    assert.equal(out.method, 'keyboard');
    assert.match(out.note, /Briefly brought .* to the front/);
  } finally {
    for (const p of procs.reverse()) await stop(p);
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
