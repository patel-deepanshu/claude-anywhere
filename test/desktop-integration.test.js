'use strict';

// The desktop assistant's seams between modules (integration of the parallel builders): the
// Computer's handling of each driver's uiAction outcomes (Windows STALE_ELEMENT / UIPI_BLOCKED,
// macOS confirmed:false, uiFind warnings), tools-ui notes and pop-up windows, the MCP validator and
// ui_set_value's empty value, tool names across permissions.js / session.js, the doctor's app
// controls check, and the MCP instructions. Mock driver only: no display needed.

const test = require('node:test');
const assert = require('node:assert/strict');

const osIndex = require('../src/os/index');
const { Computer } = require('../src/os/computer');
const uiTools = require('../src/mcp/tools-ui');
const tools = require('../src/mcp/tools');
const { validateArguments, buildInstructions } = require('../src/mcp/server');
const permissions = require('../src/daemon/permissions');
const session = require('../src/daemon/session');
const cli = require('../bin/anywhere.js');

const CHROME = '0x1002';

function computer(driver) {
  return new Computer({ driver, config: { actionDelayMs: 0, failsafe: true }, platform: 'linux' });
}

function codeError(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const clicks = (d) => d.actions.filter((a) => a.type === 'click');
const finds = (d) => d.actions.filter((a) => a.type === 'uiFind');

function toolSet(driver) {
  const comp = computer(driver);
  const list = uiTools.createTools({ getComputer: async () => comp, checkGuard: async () => {}, postActivity: () => {} });
  return { comp, by: Object.fromEntries(list.map((t) => [t.name, t])) };
}

const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

// ---------------------------------------------------------------------------
// Computer: driver outcomes
// ---------------------------------------------------------------------------

test('uiClick by name looks the element up once more after STALE_ELEMENT (Windows) and presses it', async () => {
  const d = osIndex.createMockDriver();
  const press = d.uiAction.bind(d);
  let calls = 0;
  d.uiAction = async (a) => {
    calls += 1;
    if (calls === 1) throw codeError('STALE_ELEMENT', 'UI element is no longer there');
    return press(a);
  };
  const r = await computer(d).uiClick({ name: 'For you', role: 'tab', windowId: CHROME });
  assert.equal(r.method, 'mock:press');
  assert.equal(r.name, 'For you');
  assert.equal(calls, 2);
  assert.equal(finds(d).length, 2, 'the query ran again');
  assert.equal(clicks(d).length, 0, 'never a click at the old position');
  assert.equal(d.state.ui[CHROME].children[1].children[1].children[1].selected, true);
});

test('uiClick by id: STALE / STALE_ELEMENT / UIPI_BLOCKED / NOT_FOUND stand, and nothing is clicked', async () => {
  for (const code of ['STALE', 'STALE_ELEMENT', 'UIPI_BLOCKED', 'NOT_FOUND']) {
    const d = osIndex.createMockDriver();
    const c = computer(d);
    const [m] = await c.uiFind({ windowId: CHROME, name: 'For you', role: 'tab' });
    d.uiAction = async () => {
      throw codeError(code);
    };
    await assert.rejects(c.uiClick({ id: m.id }), (e) => e.code === code, code);
    assert.equal(clicks(d).length, 0, `${code}: no click`);
  }
  // By name, a second STALE_ELEMENT is reported (one retry only).
  const d = osIndex.createMockDriver();
  d.uiAction = async () => {
    throw codeError('STALE_ELEMENT');
  };
  await assert.rejects(computer(d).uiClick({ name: 'For you', role: 'tab', windowId: CHROME }), (e) => e.code === 'STALE_ELEMENT');
  assert.equal(finds(d).length, 2);
  assert.equal(clicks(d).length, 0);
});

test('uiClick: macOS confirmed:false (a dialog or menu opened) is pending and never followed by a click', async () => {
  const d = osIndex.createMockDriver();
  d.uiAction = async () => ({ ok: true, method: 'AXPress', confirmed: false });
  const r = await computer(d).uiClick({ name: 'Back', role: 'button', windowId: CHROME });
  assert.equal(r.pending, true);
  assert.equal(r.method, 'AXPress');
  assert.equal(clicks(d).length, 0);
});

test('uiClick and uiSetValue carry the warnings of the uiFind that found the element (Windows)', async () => {
  const d = osIndex.createMockDriver();
  const find = d.uiFind.bind(d);
  d.uiFind = async (q) => {
    const list = await find(q);
    Object.defineProperty(list, 'warnings', { value: ['This window exposes almost no controls.'], enumerable: false });
    return list;
  };
  const c = computer(d);
  const r = await c.uiClick({ name: 'For you', role: 'tab', windowId: CHROME });
  assert.deepEqual(r.warnings, ['This window exposes almost no controls.']);
  const s = await c.uiSetValue({ name: 'Search', value: 'ABC-42', windowId: CHROME });
  assert.equal(s.method, 'mock:setValue');
  assert.deepEqual(s.warnings, ['This window exposes almost no controls.']);
});

// ---------------------------------------------------------------------------
// tools-ui
// ---------------------------------------------------------------------------

test('ui_find shows driver warnings; ui_tree lists open pop-ups, which ui_tree can then read by handle', async () => {
  const d = osIndex.createMockDriver();
  const find = d.uiFind.bind(d);
  d.uiFind = async (q) => {
    const list = await find(q);
    Object.defineProperty(list, 'warnings', { value: ['Start it with --force-renderer-accessibility.'], enumerable: false });
    return list;
  };
  const tree = d.uiTree.bind(d);
  const asked = [];
  d.uiTree = async (q) => {
    asked.push(q.windowId);
    const t = await tree({ ...q, windowId: q.windowId === '4242' ? CHROME : q.windowId });
    return q.windowId === CHROME ? { ...t, popups: ['4242'] } : t;
  };
  const { by } = toolSet(d);
  assert.match(textOf(await by.ui_find.handler({ name: 'For you', window: 'chrome' })), /Note: Start it with --force-renderer-accessibility\./);
  const t = textOf(await by.ui_tree.handler({ window: 'chrome' }));
  assert.match(t, /Open pop-ups \(menus, drop-downs\) of this app: window 4242; read one with ui_tree/);
  // A handle that list_windows does not show goes to the driver as it is.
  await by.ui_tree.handler({ window: '4242' });
  assert.deepEqual(asked, [CHROME, '4242']);
  assert.deepEqual(await uiTools.resolveWindow(d, '4242'), { id: '4242', window: null });
  await assert.rejects(uiTools.resolveWindow(d, 'Photoshop'), (e) => e.code === 'NOT_FOUND');
});

test('ui_set_value: the MCP validator accepts "" (clear the field) and still requires value', async () => {
  const d = osIndex.createMockDriver();
  const { by } = toolSet(d);
  const schema = by.ui_set_value.inputSchema;
  assert.deepEqual(schema.required, ['value']);
  assert.deepEqual(validateArguments(schema, { name: 'Search', value: '' }).errors, []);
  assert.match(validateArguments(schema, { name: 'Search' }).errors.join(' '), /missing required argument: value/);
  // Other required strings still treat "" as missing.
  const findText = { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] };
  assert.match(validateArguments(findText, { text: '' }).errors.join(' '), /missing required argument: text/);
  // And the empty value really clears the field.
  d.state.ui[CHROME].children[1].children[2].value = 'old';
  const res = await by.ui_set_value.handler({ name: 'Search', value: '', window: CHROME });
  assert.match(textOf(res), /Set textbox "Search" to empty/);
  assert.equal(d.state.ui[CHROME].children[1].children[2].value, '');
});

// ---------------------------------------------------------------------------
// Names, risk classes and transcript lines agree for every tool
// ---------------------------------------------------------------------------

const DESKTOP = [
  'ui_find', 'ui_tree', 'ui_click', 'ui_set_value', 'find_text', 'read_screen_text', 'list_apps', 'launch_app', 'quit_app',
  'set_window', 'wait_for', 'browser_bookmarks', 'browser_open', 'browser_tabs', 'browser_switch_tab', 'batch_actions',
];

test('every desktop-assistant tool is served, classified, named alike in the transcript and on cards', () => {
  const names = tools.createTools({ computer: () => null, role: 'engine' }).map((t) => t.name);
  for (const n of DESKTOP) {
    assert.ok(names.includes(n), `${n} is served`);
    assert.ok(permissions.DESKTOP_TOOLS.has(n), `${n} is classified as a desktop tool`);
    const full = `mcp__anywhere__${n}`;
    assert.equal(session.displayName(full), permissions.displayName(full), `${n}: transcript and card names agree`);
    assert.notEqual(session.displayName(full), n, `${n} has a readable name`);
  }
  for (const full of session.READ_ONLY_TOOLS) {
    assert.equal(permissions.classify(full, {}).risk, 'low', `${full} is pre-approved, so it must be low risk`);
  }
  // Tools that can send input are never pre-approved.
  for (const n of ['ui_click', 'ui_set_value', 'launch_app', 'quit_app', 'set_window', 'browser_open', 'browser_tabs', 'browser_switch_tab', 'batch_actions']) {
    assert.ok(!session.READ_ONLY_TOOLS.includes(`mcp__anywhere__${n}`), n);
  }
});

test('transcript summaries of the desktop tools are short and hide secret-looking values', () => {
  const s = (tool, input) => session.summary(`mcp__anywhere__${tool}`, input);
  assert.equal(s('ui_click', { name: 'For you', role: 'tab', window: 'Brave' }), '"For you" (tab) in Brave');
  assert.equal(s('ui_set_value', { name: 'Search', value: 'login timeout' }), '"Search" = "login timeout"');
  assert.match(s('ui_set_value', { name: 'Token', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }), /secret-looking value \(40 characters\)/);
  assert.doesNotMatch(s('ui_set_value', { name: 'Token', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }), /ghp_/);
  assert.equal(s('batch_actions', { actions: [{ type: 'click', x: 1, y: 2 }, { type: 'type', text: 'x' }, { type: 'key', combo: 'enter' }] }), '3 steps: click, type, key');
  assert.equal(s('browser_bookmarks', { browser: 'brave', folder: 'bar', query: 'jira' }), 'brave, folder bar, "jira"');
  assert.equal(s('set_window', { window: 'Chrome', state: 'maximize' }), 'Chrome → maximize');
  assert.equal(s('wait_for', { text: 'Export complete', timeoutSec: 60 }), '"Export complete", 60s');
  for (const n of DESKTOP) assert.ok(s(n, {}).length <= 80, n);
});

// ---------------------------------------------------------------------------
// Doctor and instructions
// ---------------------------------------------------------------------------

test('doctor: app controls get their own check; UI notes leave the Desktop control check alone', () => {
  const linuxNote = 'UI automation (ui_find, ui_click) is unavailable: the AT-SPI Python bindings are missing. sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core';
  assert.equal(cli.isUiNote(linuxNote), true);
  assert.equal(cli.isUiNote('Install missing tools: sudo apt install xdotool'), false);
  assert.equal(cli.isUiNote('UI Automation: controls can be found by name and role'), true);
  const off = cli.appControlsCheck({ ui: false, uiHint: 'sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core', notes: [linuxNote, 'Install missing tools: x'] }, { platform: 'linux', isWSL: false });
  assert.equal(off.status, 'warn');
  assert.equal(off.fix, 'sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core');
  assert.deepEqual(off.notes, [linuxNote]);
  assert.match(off.detail, /^AT-SPI unavailable/);
  const mac = cli.appControlsCheck({ ui: true, notes: ['UI automation (ui_find, ui_tree, ui_click) reads apps\' accessibility trees'] }, { platform: 'darwin' });
  assert.equal(mac.status, undefined);
  assert.match(mac.detail, /^macOS accessibility API: ui_find, ui_tree, ui_click and ui_set_value work/);
  assert.match(cli.appControlsCheck({ ui: false, notes: [] }, { platform: 'linux', isWSL: true }).detail, /^UI Automation unavailable/);
});

test('MCP instructions steer to the accessibility tree, OCR, apps and bookmarks for every role', () => {
  for (const role of ['engine', 'interactive']) {
    const text = buildInstructions(role);
    for (const name of ['ui_find', 'ui_click', 'ui_set_value', 'find_text', 'read_screen_text', 'launch_app', 'browser_bookmarks', 'browser_open', 'wait_for', 'batch_actions', 'screenshotAfter']) {
      assert.ok(text.includes(name), `${role}: ${name}`);
    }
    assert.match(text, /--force-renderer-accessibility and ACCESSIBILITY_ENABLED=1/);
  }
});

test('wait_for without OCR finds text in the accessibility tree, with a centre ready for click', async () => {
  const desktopTools = require('../src/mcp/tools-desktop');
  const d = osIndex.createMockDriver();
  const comp = computer(d);
  const list = desktopTools.createTools({ getComputer: async () => comp, checkGuard: async () => {}, postActivity: () => {}, desktopDeps: { ocr: null } });
  const waitFor = list.find((t) => t.name === 'wait_for');
  const res = await waitFor.handler({ window: 'Cloud Run', text: 'ABC-42', timeoutSec: 2 });
  assert.ok(!res.isError, textOf(res));
  assert.match(textOf(res), /Found "ABC-42 Fix login timeout" in Google Chrome .* at \(\d+, \d+\) on display 1 after [\d.]+ s \(accessibility tree\)\. .*click \{x: \d+, y: \d+, display: 1\} hits it/);
});

test('docs: DESKTOP.md covers the examples and per-OS setup; ARCHITECTURE has a row for every desktop tool', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const guide = read('docs/DESKTOP.md');
  for (const needle of ['Brave bookmarks bar', 'For you', 'Figma', 'WhatsApp', 'ffmpeg', '### macOS', '### Windows', '### Linux',
    'python3-gi gir1.2-atspi-2.0 at-spi2-core', 'tesseract-ocr', '--force-renderer-accessibility', 'ACCESSIBILITY_ENABLED=1', '## Safety']) {
    assert.ok(guide.includes(needle), `DESKTOP.md mentions ${needle}`);
  }
  const served = new Set(tools.createTools({ computer: () => null, role: 'engine' }).map((t) => t.name));
  for (const name of new Set(guide.match(/`([a-z]+(?:_[a-z]+)+)\b/g).map((m) => m.slice(1)))) {
    if (/^(screenshot_?after|batch_step)/.test(name)) continue;
    assert.ok(served.has(name), `DESKTOP.md names the tool ${name}, which exists`);
  }
  const arch = read('docs/ARCHITECTURE.md');
  for (const n of DESKTOP) assert.ok(arch.includes(`| \`${n}\` |`), `ARCHITECTURE §6 has a ${n} row`);
  assert.match(read('README.md'), /docs\/DESKTOP\.md/);
});

test('fallback input goes to the element\'s window: it is brought to the front first, or nothing is done', async () => {
  // A click at the centre of an element of a background window (Chrome behind VS Code).
  const d = osIndex.createMockDriver();
  const r = await computer(d).uiClick({ windowId: CHROME, name: 'Board canvas' });
  assert.equal(r.method, 'click');
  const order = d.actions.filter((a) => a.type === 'focusWindow' || a.type === 'click').map((a) => a.type);
  assert.deepEqual(order, ['focusWindow', 'click']);
  assert.equal(d.state.windows.find((w) => w.id === CHROME).focused, true);

  // Typing into a field after focusing it: the window comes forward before the keys.
  const t = osIndex.createMockDriver();
  const set = t.uiAction.bind(t);
  t.uiAction = async (a) => (a.action === 'setValue' ? { ok: false, method: 'none', reason: 'read-only value' } : set(a));
  const s = await computer(t).uiSetValue({ name: 'Search', value: 'ABC-42', windowId: CHROME });
  assert.equal(s.method, 'focus+select-all+type');
  const seq = t.actions.filter((a) => ['focusWindow', 'keyCombo', 'typeText'].includes(a.type)).map((a) => a.type);
  assert.deepEqual(seq, ['focusWindow', 'keyCombo', 'typeText']);

  // A window that refuses to come forward: FOCUS_FAILED, no click and no keys.
  for (const op of ['click', 'type']) {
    const f = osIndex.createMockDriver();
    f.focusWindow = async () => false;
    const setF = f.uiAction.bind(f);
    f.uiAction = async (a) => (a.action === 'setValue' ? { ok: false, method: 'none' } : setF(a));
    const c = computer(f);
    const call = op === 'click' ? c.uiClick({ windowId: CHROME, name: 'Board canvas' }) : c.uiSetValue({ name: 'Search', value: 'x', windowId: CHROME });
    await assert.rejects(call, (e) => e.code === 'FOCUS_FAILED' && /focus_window with id 0x1002/.test(e.hint), op);
    assert.ok(!f.actions.some((a) => ['click', 'keyCombo', 'typeText'].includes(a.type)), `${op}: nothing sent`);
  }

  // The accessibility press itself needs no focus: nothing is focused for it.
  const p = osIndex.createMockDriver();
  await computer(p).uiClick({ windowId: CHROME, name: 'For you', role: 'tab' });
  assert.ok(!p.actions.some((a) => a.type === 'focusWindow'));
});
