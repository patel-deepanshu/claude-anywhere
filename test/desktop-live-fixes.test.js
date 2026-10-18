'use strict';

// Regressions found by the live desktop-assistant run (Xvfb + openbox, a Chromium "Brave", a fake Jira):
// - OCR: white text on a coloured bar (Jira's blue header) was not read: the dark-box composite was
//   mid-gray after inversion. It is now level-stretched so the box's background is white.
// - Tabs on Linux: the keyboard cycle cannot tell two tabs with the same title apart (two "Your work -
//   Jira" tabs listed as one, and the wrong one selected afterwards). The tab strip is now read and
//   switched through the accessibility tree when the browser exposes it, with no keys at all.

const test = require('node:test');
const assert = require('node:assert/strict');

const ocr = require('../src/os/ocr');
const browsers = require('../src/os/browsers');
const osIndex = require('../src/os/index');
const desktopTools = require('../src/mcp/tools-desktop');

test('darkComposite: a coloured box (white text on a blue header) is stretched to dark-on-white', () => {
  const W = 96;
  const H = 40;
  const gray = new Uint8Array(W * H).fill(255);
  for (let y = 8; y < 32; y++) for (let x = 8; x < 88; x++) gray[y * W + x] = 73; // #0052cc as luma
  for (let y = 14; y < 26; y++) for (let x = 16; x < 80; x += 4) gray[y * W + x] = 255; // white strokes
  const comp = ocr.darkComposite(gray, W, H, [{ x: 8, y: 8, width: 80, height: 24 }]);
  const b = comp.bands[0];
  const at = (sx, sy) => comp.gray[(b.top + sy - 8) * comp.width + comp.pad + sx - 8];
  assert.equal(at(18, 20), 255, 'the blue background becomes white');
  assert.equal(at(16, 20), 0, 'the white text becomes black');
  // A region whose inverted background is too dark to be a page (mostly ink) is not stretched.
  const inky = new Uint8Array(W * H).fill(200);
  const c2 = ocr.darkComposite(inky, W, H, [{ x: 0, y: 0, width: W, height: H }]);
  assert.equal(c2.gray[(c2.bands[0].top + 5) * c2.width + c2.pad + 5], 55);
  // An already-white inverted background (black box) is left as it is.
  const black = new Uint8Array(W * H).fill(0);
  const c3 = ocr.darkComposite(black, W, H, [{ x: 0, y: 0, width: W, height: H }]);
  assert.equal(c3.gray[(c3.bands[0].top + 5) * c3.width + c3.pad + 5], 255);
});

function kbDeps() {
  const c = { t: 1000 };
  return { platform: 'linux', isWSL: false, env: { HOME: '/nowhere' }, now: () => c.t, sleep: async (ms) => { c.t += ms; }, which: () => null };
}

/**
 * A Brave window on Linux whose tab strip is in the accessibility tree (like Chromium with AT-SPI):
 * tabs (strip, top edge) and a page with its own tablist lower down ("Worked on" / "For you").
 */
function a11yBrave(tabs = ['Your work - Jira', 'Your work - Jira', 'Inbox'], active = 1, { stripY = 0, title } = {}) {
  const strip = tabs.map((t, i) => ({ role: 'tab', name: t, selected: i === active, bounds: { x: 10 + i * 240, y: stripY, width: 230, height: 40 } }));
  const ui = {
    '0x10': {
      role: 'window', name: 'Brave', bounds: { x: 0, y: 0, width: 1600, height: 900 },
      children: [
        { role: 'group', name: '', bounds: { x: 0, y: 0, width: 1600, height: 90 }, children: [
          { role: 'tablist', name: '', bounds: { x: 0, y: stripY, width: 1600, height: 40 }, children: strip },
          { role: 'textbox', name: 'Address and search bar', value: '127.0.0.1/jira/', editable: true, bounds: { x: 120, y: 48, width: 900, height: 30 } },
        ] },
        { role: 'group', name: 'Your work - Jira', bounds: { x: 0, y: 90, width: 1600, height: 810 }, children: [
          { role: 'tablist', name: 'Your work', bounds: { x: 30, y: 230, width: 500, height: 44 }, children: [
            { role: 'tab', name: 'Worked on', selected: true, bounds: { x: 30, y: 230, width: 120, height: 44 } },
            { role: 'tab', name: 'For you', selected: false, bounds: { x: 160, y: 230, width: 100, height: 44 } },
          ] },
        ] },
      ],
    },
  };
  const d = osIndex.createMockDriver({
    windows: [
      { id: '0x20', app: 'XTerm', title: 'xterm', pid: 5, x: 0, y: 0, width: 800, height: 600, focused: true, minimized: false },
      { id: '0x10', app: 'Brave', title: title || `${tabs[active]} - Brave`, pid: 7, x: 0, y: 0, width: 1600, height: 900, focused: false, minimized: false },
    ],
    ui,
  });
  const keys = [];
  d.keyCombo = async (k) => keys.push(k.join('+'));
  d.typeText = async (t) => keys.push(`type:${t}`);
  // Pressing a strip tab selects it and the window title follows, as in Chromium.
  const press = d.uiAction.bind(d);
  d.uiAction = async (a) => {
    const r = await press(a);
    const list = d.state.ui['0x10'].children[0].children[0].children;
    const sel = list.findIndex((t) => t.selected);
    if (r.ok && sel >= 0) d.state.windows.find((w) => w.id === '0x10').title = `${list[sel].name} - Brave`;
    return r;
  };
  return { d, keys };
}

test('listTabs on Linux reads the tab strip through the accessibility tree: same titles stay apart, no keys', async () => {
  const { d, keys } = a11yBrave();
  const r = await browsers.listTabs({ driver: d, cycle: true }, kbDeps());
  assert.equal(r.method, 'accessibility');
  assert.deepEqual(r.windows[0].tabs.map((t) => [t.index, t.title, t.active]), [[1, 'Your work - Jira', false], [2, 'Your work - Jira', true], [3, 'Inbox', false]]);
  assert.equal(r.windows[0].windowId, '0x10');
  assert.equal(keys.length, 0, 'no keys, even with cycle');
  assert.ok(d.state.windows.find((w) => w.id === '0x20').focused, 'focus stays where it was');
  assert.match(desktopTools.formatTabs(r), /^Brave tabs \(accessibility tree\):/);
});

test('switchTab on Linux presses the strip tab through the accessibility tree (by text and by index)', async () => {
  const { d, keys } = a11yBrave();
  let guards = 0;
  const r = await browsers.switchTab({ match: 'inbox', driver: d, beforeInput: async () => guards++ }, kbDeps());
  assert.equal(r.method, 'accessibility');
  assert.deepEqual(r.tab, { index: 3, title: 'Inbox' });
  assert.equal(r.window.title, 'Inbox - Brave');
  assert.equal(guards, 1, 'the guard is checked before the press');
  assert.equal(keys.length, 0);
  assert.ok(d.state.windows.find((w) => w.id === '0x10').focused, 'the browser window is brought to the front');
  const first = await browsers.switchTab({ index: 1, driver: d }, kbDeps());
  assert.deepEqual(first.tab, { index: 1, title: 'Your work - Jira' });
  const last = await browsers.switchTab({ index: -1, driver: d }, kbDeps());
  assert.deepEqual(last.tab, { index: 3, title: 'Inbox' });
  await assert.rejects(browsers.switchTab({ index: 7, driver: d }, kbDeps()), (e) => e.code === 'NOT_FOUND' && /has 3 tabs/.test(e.message));
  await assert.rejects(browsers.switchTab({ match: 'nothing like it', driver: d }, kbDeps()), (e) => e.code === 'NOT_FOUND');
  assert.equal(keys.length, 0, 'a miss is known from the tree: no keyboard cycle');
  assert.match(desktopTools.formatSwitch(r), /via the accessibility tree/);
});

test('the accessibility path steps aside when the strip cannot be trusted: the keyboard fallback runs', async () => {
  // Page tabs only (no strip near the top edge): not a tab strip.
  const low = a11yBrave(['Jira', 'Inbox'], 0, { stripY: 400 });
  const r1 = await browsers.listTabs({ driver: low.d }, kbDeps());
  assert.equal(r1.method, 'title');
  // The selected strip tab is not the one the window title names (stale tree): not trusted either.
  const stale = a11yBrave(['Jira', 'Inbox'], 0, { title: 'Something else - Brave' });
  const r2 = await browsers.listTabs({ driver: stale.d }, kbDeps());
  assert.equal(r2.method, 'title');
  // A driver without a tree for the window (mock without ui): unchanged keyboard behaviour.
  const plain = osIndex.createMockDriver({ windows: [{ id: '0x10', app: 'Brave', title: 'Jira - Brave', pid: 7, x: 0, y: 0, width: 1200, height: 800, focused: true, minimized: false }] });
  const r3 = await browsers.listTabs({ driver: plain }, kbDeps());
  assert.equal(r3.method, 'title');
});
