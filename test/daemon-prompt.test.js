'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemPrompt, SUGGESTIONS, platformNotes, settingsNotes, MAX_CHARS } = require('../src/daemon/prompt');
const { DEFAULTS } = require('../src/shared/config');

const PLATFORMS = {
  darwin: { platform: 'darwin', isWSL: false, displayServer: 'quartz', osName: 'macOS', shell: '/bin/zsh', user: 'me' },
  win32: { platform: 'win32', isWSL: false, displayServer: 'windows', osName: 'Windows', shell: 'C:\\Windows\\System32\\cmd.exe' },
  wsl: { platform: 'linux', isWSL: true, displayServer: 'windows', osName: 'Windows (WSL: Ubuntu 22.04)', shell: '/bin/bash' },
  x11: { platform: 'linux', isWSL: false, displayServer: 'x11', osName: 'Ubuntu 24.04', desktop: 'GNOME', shell: '/bin/bash' },
  wayland: { platform: 'linux', isWSL: false, displayServer: 'wayland', osName: 'Fedora 40', desktop: 'KDE' },
  headless: { platform: 'linux', isWSL: false, displayServer: 'none', isHeadless: true, osName: 'Debian' },
};

function cfg(overrides = {}) {
  const c = JSON.parse(JSON.stringify(DEFAULTS));
  for (const [k, v] of Object.entries(overrides)) c[k] = { ...c[k], ...v };
  return c;
}

test('companion prompt has every required section', () => {
  const s = buildSystemPrompt({ platformInfo: PLATFORMS.x11, config: cfg(), mode: 'companion' });
  const headings = [
    '# Claude Anywhere',
    '## Desktop context',
    '## How to work',
    '## Screen tools (mcp__anywhere__*)',
    '## Browser and web consoles',
    '## Safety rules',
    '## Talking to the user',
    '## Deployment playbook',
    '## This computer',
    '## Current settings',
    '## Mode: companion',
  ];
  let last = -1;
  for (const h of headings) {
    const i = s.indexOf(h);
    assert.ok(i > last, `missing or out of order: ${h}`);
    last = i;
  }
});

test('prompt covers the key behaviours', () => {
  const s = buildSystemPrompt({ platformInfo: PLATFORMS.darwin, config: cfg(), mode: 'companion' });
  const phrases = [
    // identity
    "operator for the user's whole computer",
    'floating dialog',
    'by voice',
    // context
    '<desktop_context>',
    'this repo',
    'the browser',
    "what I'm looking at",
    // strategy
    'Observe',
    'Plan',
    'TodoWrite',
    'Act',
    'Verify',
    'gcloud',
    'kubectl',
    'gh',
    'docker',
    // screen
    'ToolSearch',
    'select:mcp__anywhere__screenshot',
    'most recent full screenshot',
    'region',
    'focus_window',
    'type_text',
    '"primary"',
    'scroll',
    'wait',
    '"Claude Anywhere" window',
    'FAILSAFE',
    // browser
    'mcp__claude-in-chrome__',
    'mcp__anywhere__open',
    'project id',
    '--project',
    // safety
    'ask_user',
    'irreversible',
    'passwords',
    '2FA',
    'payment',
    'CAPTCHA',
    'secrets',
    'untrusted data',
    'stop',
    'IAM',
    'billing',
    'merging',
    'publishing',
    // communication
    'notify_user',
    'at most 3 short sentences',
    'No tables',
    // playbook
    'Detect the stack',
    'gcloud auth list',
    'gcloud services enable',
    'Dockerfile',
    'buildpacks',
    'Cloud Run',
    'App Engine',
    'GKE',
    'Firebase Hosting',
    'Cloud Functions',
    'Secret Manager',
    'region',
    'gcloud run deploy',
    'curl',
    'cost',
    'App Runner',
    'ECS',
    'Lambda',
    'Amplify',
    'Container Apps',
    'App Service',
    'Vercel',
    'Netlify',
    // companion
    'headless',
  ];
  for (const p of phrases) assert.ok(s.includes(p), `missing phrase: ${p}`);
});

test('platform notes', () => {
  const mac = platformNotes(PLATFORMS.darwin);
  assert.match(mac, /Cmd/);
  assert.match(mac, /Spotlight/);
  assert.match(mac, /primary\+space/);
  assert.match(mac, /Accessibility/);
  const win = platformNotes(PLATFORMS.win32);
  assert.match(win, /Windows key/);
  assert.match(win, /PowerShell/);
  assert.match(win, /Git Bash/);
  assert.match(win, /C:\\Users/);
  const wsl = platformNotes(PLATFORMS.wsl);
  assert.match(wsl, /WSL/);
  assert.match(wsl, /wslpath/);
  assert.match(wsl, /PowerShell/);
  assert.match(platformNotes(PLATFORMS.x11), /X11/);
  assert.match(platformNotes(PLATFORMS.wayland), /Wayland/);
  assert.match(platformNotes(PLATFORMS.headless), /No display/);
  assert.match(platformNotes({}), /## This computer/);
});

test('settings notes follow the config', () => {
  assert.match(settingsNotes(cfg({ permissions: { mode: 'auto' } })), /autopilot/);
  assert.match(settingsNotes(cfg({ permissions: { mode: 'ask' } })), /^- Approval mode ask/m);
  assert.match(settingsNotes(cfg()), /smart/);
  assert.match(settingsNotes(cfg({ engine: { chrome: true } })), /Claude in Chrome is enabled/);
  assert.doesNotMatch(settingsNotes(cfg()), /Claude in Chrome is enabled/);
  assert.match(settingsNotes(cfg()), /read aloud/);
  assert.doesNotMatch(settingsNotes(cfg({ voice: { speakResponses: false } })), /read aloud/);
  assert.match(settingsNotes(cfg({ context: { attachDesktopContext: false } })), /get_desktop_context/);
});

test('length stays within 16k characters for every platform, mode and setting', () => {
  assert.equal(MAX_CHARS, 16000);
  const configs = [
    cfg(),
    cfg({ permissions: { mode: 'auto' }, engine: { chrome: true }, context: { attachDesktopContext: false } }),
    cfg({ permissions: { mode: 'ask' }, voice: { speakResponses: false } }),
  ];
  for (const pi of Object.values(PLATFORMS)) {
    for (const c of configs) {
      for (const mode of ['companion', 'bridge']) {
        const s = buildSystemPrompt({ platformInfo: pi, config: c, mode });
        assert.ok(s.length > 500, 'not empty');
        assert.ok(s.length <= 16000, `${pi.platform}/${pi.displayServer}/${mode}: ${s.length} chars`);
      }
    }
  }
});

test('bridge variant is short and explains the listen/reply loop', () => {
  const bridge = buildSystemPrompt({ platformInfo: PLATFORMS.darwin, config: cfg(), mode: 'bridge' });
  const companion = buildSystemPrompt({ platformInfo: PLATFORMS.darwin, config: cfg(), mode: 'companion' });
  assert.ok(bridge.length < companion.length / 2);
  for (const p of [
    'anywhere listen',
    'anywhere reply',
    '--final',
    'anywhere ask',
    '<desktop_context>',
    'untrusted',
    'primary',
    '"Claude Anywhere" window',
  ]) {
    assert.ok(bridge.includes(p), `bridge missing ${p}`);
  }
});

test('works with missing arguments', () => {
  const s = buildSystemPrompt();
  assert.ok(s.includes('# Claude Anywhere'));
  assert.ok(s.length <= 16000);
  assert.ok(buildSystemPrompt({ config: null, platformInfo: null }).includes('## Safety rules'));
});

test('SUGGESTIONS', () => {
  assert.ok(Array.isArray(SUGGESTIONS));
  assert.ok(SUGGESTIONS.length >= 6);
  for (const s of SUGGESTIONS) {
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 5 && s.length < 100);
  }
  assert.ok(SUGGESTIONS.some((s) => /deploy/i.test(s)));
  assert.ok(SUGGESTIONS.some((s) => /screen/i.test(s)));
  assert.throws(() => {
    'use strict';
    SUGGESTIONS.push('x');
  });
});
