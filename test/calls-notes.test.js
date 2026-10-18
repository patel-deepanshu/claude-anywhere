'use strict';

/**
 * Call notes on the Desktop (docs/CALLS-DESIGN.md §8, src/calls/notes.js): where the Desktop is on
 * each OS (user-dirs.dirs, OneDrive known folder / registry output, WSL, the macOS EPERM fallback),
 * file-name sanitizing and Windows reserved names, collisions, the rendered Markdown (actions from
 * the daemon's log only, follow-ups, privacy: inert caller text, masked secrets, no transcript after
 * an objection), the missed-calls file, listing and safe reading, and the doctor row.
 * No network, no audio; every file lives in a temporary folder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-notes-'));
process.env.ANYWHERE_HOME = path.join(TMP, 'state');
const notes = require('../src/calls/notes');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

let seq = 0;
function tmpHome() {
  const dir = path.join(TMP, `home-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const LINUX = { platform: 'linux', isWSL: false };
const T0 = new Date(2026, 9, 18, 14, 5, 12).getTime(); // local time
const noWhich = () => null;
const noRun = async () => ({ code: 1, stdout: '', stderr: '' });

/** A fake fs over a set of folders (Windows paths on a Linux test machine). */
function fakeFs(dirs) {
  const set = new Set(dirs.map((d) => d.toLowerCase()));
  return {
    statSync(p) {
      if (set.has(String(p).toLowerCase())) return { isDirectory: () => true, isFile: () => false };
      throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    },
    readFileSync() {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
}

// ---------------------------------------------------------------- Desktop location

test('user-dirs.dirs parsing: $HOME, ${HOME}, absolute paths, comments, the last line wins', () => {
  const home = '/home/dee';
  assert.equal(notes.parseUserDirs('XDG_DESKTOP_DIR="$HOME/Desktop"\n', home), '/home/dee/Desktop');
  assert.equal(notes.parseUserDirs('# XDG_DESKTOP_DIR="$HOME/nope"\nXDG_DOWNLOAD_DIR="$HOME/Downloads"\nXDG_DESKTOP_DIR="${HOME}/Schreibtisch"', home), '/home/dee/Schreibtisch');
  assert.equal(notes.parseUserDirs('XDG_DESKTOP_DIR="/data/desk/"', home), '/data/desk');
  assert.equal(notes.parseUserDirs('XDG_DESKTOP_DIR="$HOME/My\\ Desk"', home), '/home/dee/My Desk');
  assert.equal(notes.parseUserDirs('XDG_DESKTOP_DIR="$HOME/a"\nXDG_DESKTOP_DIR="$HOME/b"', home), '/home/dee/b');
  assert.equal(notes.parseUserDirs('XDG_DESKTOP_DIR="$HOME"', home), '/home/dee');
  assert.equal(notes.parseUserDirs('XDG_DESKTOP_DIR="relative/path"', home), null);
  assert.equal(notes.parseUserDirs('XDG_DESKTOP_DIR="$HOMEX/Desktop"', home), null);
  assert.equal(notes.parseUserDirs('XDG_DOCUMENTS_DIR="$HOME/Documents"', home), null);
  assert.equal(notes.parseUserDirs('', home), null);
});

test('Linux: the user-dirs Desktop, else ~/Desktop, else ~/Claude Call Notes', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.config'));
  fs.mkdirSync(path.join(home, 'Schreibtisch'));
  fs.writeFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/Schreibtisch"\n');
  const base = { platformInfo: LINUX, env: { HOME: home }, homedir: home, which: noWhich, runner: noRun };
  let d = await notes.resolveDesktop(base);
  assert.deepEqual(d, { dir: path.join(home, 'Schreibtisch'), source: 'user-dirs', exists: true, synced: null });
  assert.equal(await notes.desktopDir(base), path.join(home, 'Schreibtisch'));

  // XDG_CONFIG_HOME is honoured.
  const cfg = path.join(home, 'cfg');
  fs.mkdirSync(cfg);
  fs.mkdirSync(path.join(home, 'Bureau'));
  fs.writeFileSync(path.join(cfg, 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/Bureau"\n');
  d = await notes.resolveDesktop({ ...base, env: { HOME: home, XDG_CONFIG_HOME: cfg } });
  assert.equal(d.dir, path.join(home, 'Bureau'));

  // Desktop = $HOME (a minimal session): ~/Desktop when it exists.
  fs.writeFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/"\n');
  fs.mkdirSync(path.join(home, 'Desktop'));
  d = await notes.resolveDesktop(base);
  assert.deepEqual([d.dir, d.source], [path.join(home, 'Desktop'), 'home-desktop']);

  // A configured folder that does not exist: same fallback.
  fs.writeFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/Gone"\n');
  d = await notes.resolveDesktop(base);
  assert.equal(d.dir, path.join(home, 'Desktop'));

  // No Desktop at all: the notes go to ~/Claude Call Notes.
  fs.rmdirSync(path.join(home, 'Desktop'));
  d = await notes.resolveDesktop(base);
  assert.deepEqual(d, { dir: null, source: 'none', exists: false, synced: null });
  const folder = await notes.notesFolder(base);
  assert.deepEqual([folder.dir, folder.source], [path.join(home, 'Claude Call Notes'), 'home']);
});

test('Linux: xdg-user-dir is asked when user-dirs.dirs is missing', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'Skrivebord'));
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: `${path.join(home, 'Skrivebord')}\n` };
  };
  const d = await notes.resolveDesktop({ platformInfo: LINUX, env: { HOME: home }, homedir: home, which: (n) => (n === 'xdg-user-dir' ? '/usr/bin/xdg-user-dir' : null), runner });
  assert.deepEqual([d.dir, d.source], [path.join(home, 'Skrivebord'), 'xdg-user-dir']);
  assert.deepEqual(calls, [['/usr/bin/xdg-user-dir', 'DESKTOP']]);
});

test('Windows: the known folder from the PS host (OneDrive), then the registry, OneDrive and USERPROFILE', async () => {
  const WIN = { platform: 'win32', isWSL: false };
  const env = { USERPROFILE: 'C:\\Users\\dee', OneDrive: 'C:\\Users\\dee\\OneDrive - Acme' };
  const oneDriveDesk = 'C:\\Users\\dee\\OneDrive - Acme\\Desktop';
  const driver = { desktopPath: async () => ({ path: oneDriveDesk, exists: true, registry: '%USERPROFILE%\\OneDrive - Acme\\Desktop', oneDrive: env.OneDrive, userProfile: env.USERPROFILE }) };
  let d = await notes.resolveDesktop({ platformInfo: WIN, env, driver, fs: fakeFs([oneDriveDesk]), which: noWhich, runner: noRun });
  assert.deepEqual(d, { dir: oneDriveDesk, source: 'known-folder', exists: true, synced: 'onedrive' });
  const folder = await notes.notesFolder({ platformInfo: WIN, env, driver, fs: fakeFs([oneDriveDesk]), which: noWhich, runner: noRun });
  assert.equal(folder.dir, 'C:\\Users\\dee\\OneDrive - Acme\\Desktop\\Claude Call Notes');
  assert.equal(folder.synced, 'onedrive');

  // No PS host: a one-shot powershell, then `reg query` output with %VARS% expanded.
  const regOut = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive - Acme\\Desktop\r\n\r\n';
  assert.equal(notes.parseRegQuery(regOut, env), oneDriveDesk);
  assert.equal(notes.parseRegQuery('    Desktop    REG_SZ    D:\\Desk', env), 'D:\\Desk');
  assert.equal(notes.parseRegQuery('ERROR: The system was unable to find the specified registry key', env), null);
  const ran = [];
  const runner = async (cmd, args) => {
    ran.push(cmd);
    if (/reg/i.test(cmd)) return { code: 0, stdout: regOut };
    return { code: 0, stdout: 'C:\\Users\\dee\\Desktop\r\n' }; // powershell: a folder that is not there
  };
  const which = (n) => (n === 'powershell.exe' ? 'C:\\WINDOWS\\powershell.exe' : n === 'reg.exe' ? 'C:\\WINDOWS\\reg.exe' : null);
  d = await notes.resolveDesktop({ platformInfo: WIN, env, fs: fakeFs([oneDriveDesk]), which, runner });
  assert.deepEqual([d.dir, d.source, d.synced], [oneDriveDesk, 'registry', 'onedrive']);
  assert.deepEqual(ran, ['C:\\WINDOWS\\powershell.exe', 'C:\\WINDOWS\\reg.exe']);

  // Nothing found: %OneDrive%\Desktop when it exists, else %USERPROFILE%\Desktop.
  d = await notes.resolveDesktop({ platformInfo: WIN, env, fs: fakeFs([oneDriveDesk]), which: noWhich, runner: noRun });
  assert.deepEqual([d.dir, d.source], [oneDriveDesk, 'onedrive']);
  d = await notes.resolveDesktop({ platformInfo: WIN, env, fs: fakeFs([]), which: noWhich, runner: noRun });
  assert.deepEqual([d.dir, d.source, d.exists], ['C:\\Users\\dee\\Desktop', 'userprofile', false]);
  assert.equal(notes.expandWinVars('%userprofile%\\x %NOPE%', env), 'C:\\Users\\dee\\x %NOPE%');
});

test('WSL: the Windows Desktop through the driver, or powershell.exe + wslpath', async () => {
  const WSL = { platform: 'linux', isWSL: true };
  const home = tmpHome();
  const desk = path.join(home, 'mnt-c-desktop');
  fs.mkdirSync(desk);
  let d = await notes.resolveDesktop({ platformInfo: WSL, env: { HOME: home }, homedir: home, driver: { desktopPath: async () => ({ path: 'C:\\Users\\dee\\Desktop', wslPath: desk }) }, which: noWhich, runner: noRun });
  assert.deepEqual([d.dir, d.source], [desk, 'windows-desktop']);
  const ran = [];
  const runner = async (cmd, args) => {
    ran.push([cmd, args[args.length - 1]]);
    if (cmd === '/usr/bin/wslpath') return { code: 0, stdout: `${desk}\n` };
    return { code: 0, stdout: 'C:\\Users\\dee\\OneDrive\\Desktop\r\n' };
  };
  d = await notes.resolveDesktop({ platformInfo: WSL, env: { HOME: home }, homedir: home, which: (n) => (n === 'wslpath' ? '/usr/bin/wslpath' : n === 'powershell.exe' ? '/mnt/c/ps.exe' : null), runner });
  assert.equal(d.dir, desk);
  assert.deepEqual(ran[1], ['/usr/bin/wslpath', 'C:\\Users\\dee\\OneDrive\\Desktop']);
  assert.equal(notes.winToWslPath('C:\\Users\\dee\\Desktop'), '/mnt/c/Users/dee/Desktop');
  // No interop: the distro's own Desktop logic.
  fs.mkdirSync(path.join(home, 'Desktop'));
  d = await notes.resolveDesktop({ platformInfo: WSL, env: { HOME: home }, homedir: home, which: noWhich, runner: noRun });
  assert.equal(d.dir, path.join(home, 'Desktop'));
});

test('macOS: ~/Desktop, iCloud sync is reported, calls.notesDir overrides', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'Desktop'));
  const MAC = { platform: 'darwin', isWSL: false };
  let d = await notes.resolveDesktop({ platformInfo: MAC, env: { HOME: home }, homedir: home });
  assert.deepEqual(d, { dir: path.join(home, 'Desktop'), source: 'home-desktop', exists: true, synced: null });
  fs.mkdirSync(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Desktop'), { recursive: true });
  d = await notes.resolveDesktop({ platformInfo: MAC, env: { HOME: home }, homedir: home });
  assert.equal(d.synced, 'icloud');
  const f = await notes.notesFolder({ platformInfo: MAC, env: { HOME: home }, homedir: home, config: { calls: { notesDir: '~/Work notes' } } });
  assert.deepEqual([f.dir, f.source, f.custom], [path.join(home, 'Work notes'), 'config', true]);
});

// ---------------------------------------------------------------- file names

test('file names: unsafe characters, whitespace, trailing dots, reserved Windows names, length', () => {
  assert.equal(notes.sanitizeFileName('a<b>c:d"e/f\\g|h?i*j'), 'a-b-c-d-e-f-g-h-i-j');
  // Control characters (tabs and line breaks too) become '-', as the design says.
  assert.equal(notes.sanitizeFileName('tab\there\u0007 bell\n new'), 'tab-here- bell- new');
  assert.equal(notes.sanitizeFileName('CON', 120, { reserved: false }), 'CON');
  assert.equal(notes.sanitizeFileName('  name ...  '), 'name');
  assert.equal(notes.sanitizeFileName('CON'), 'CON_');
  assert.equal(notes.sanitizeFileName('nul.md'), 'nul_.md');
  assert.equal(notes.sanitizeFileName('com1.txt'), 'com1_.txt');
  assert.equal(notes.sanitizeFileName('LPT9'), 'LPT9_');
  assert.equal(notes.sanitizeFileName('console'), 'console');
  assert.equal(notes.sanitizeFileName('COM10'), 'COM10');
  assert.equal(notes.sanitizeFileName('x'.repeat(300)).length, 120);
});

test('note file names: local time, first name, app name, unknown caller, at most 120 characters', () => {
  assert.equal(notes.noteFileName({ date: T0, caller: 'Ankit Sharma', app: 'zoho-cliq' }), '2026-10-18 14-05 Ankit (Zoho Cliq).md');
  assert.equal(notes.noteFileName({ date: new Date(2026, 0, 2, 9, 7), caller: { displayName: 'Priya R. Nair' }, app: 'google-meet' }), '2026-01-02 09-07 Priya (Google Meet).md');
  assert.equal(notes.noteFileName({ date: T0, caller: '', app: 'teams' }), '2026-10-18 14-05 Unknown caller (Microsoft Teams).md');
  assert.equal(notes.noteFileName({ date: T0, caller: null, app: 'Cliq' }), '2026-10-18 14-05 Unknown caller (Zoho Cliq).md');
  assert.equal(notes.noteFileName({ date: T0, caller: 'a/b:c', app: 'zoom' }), '2026-10-18 14-05 a-b-c (Zoom).md');
  assert.equal(notes.noteFileName({ date: T0, caller: 'CON', app: '' }), '2026-10-18 14-05 CON.md');
  const long = notes.noteFileName({ date: T0, caller: 'W'.repeat(200), app: 'Some Very Long Conferencing Product Name That Goes On' });
  assert.ok(long.length <= 120, long);
  assert.match(long, /^2026-10-18 14-05 W+ \(Some Very Long Conferencing P\w*\)\.md$/);
  assert.equal(notes.collisionName('2026-10-18 14-05 Ankit (Zoho Cliq).md', 2), '2026-10-18 14-05 Ankit (Zoho Cliq) (2).md');
  assert.ok(notes.collisionName(`${'x'.repeat(117)}.md`, 12).length <= 120);
});

// ---------------------------------------------------------------- rendering

const CALL = {
  id: 'c-1',
  app: 'zoho-cliq',
  caller: { displayName: 'Ankit Sharma', jira: { accountId: 'acc-1', email: 'ankit.sharma@example.com', displayName: 'Ankit Sharma' } },
  owner: { name: 'Deepanshu Patel' },
  startedAt: T0 - 3000,
  answeredAt: T0,
  endedAt: T0 + 232000,
  cloned: true,
  endReason: 'caller_hung_up',
};
const TRANSCRIPT = [
  { role: 'assistant', text: "Hi Ankit, this is Deepanshu's AI assistant, speaking in his voice. I'm transcribing this call to take notes for him. How can I help?", ts: T0 },
  { role: 'caller', text: 'Hi, can you please assign me a ticket from the current sprint?', ts: T0 + 8000 },
  { role: 'assistant', text: 'Sure, let me check the board.', ts: T0 + 10000, interrupted: true },
];
const ACTIONS = [
  { ts: T0 + 50000, name: 'call_find_unassigned_tickets', ok: true, args: { text: 'payments' } },
  { ts: T0 + 60000, name: 'call_assign_ticket_to_caller', ok: true, args: { key: 'PAY-412' }, result: { key: 'PAY-412', summary: 'Fix retry on failed card capture' } },
  { ts: T0 + 70000, name: 'call_assign_ticket_to_caller', allowed: false, reason: 'budget: at most 1 assignment per call', args: { key: 'PAY-413' } },
  { ts: T0 + 80000, name: 'call_comment_on_ticket', ok: false, error: 'Jira answered 500', args: { key: 'PAY-412', text: 'Picked up on a call' } },
  { ts: T0 + 90000, name: 'call_defer', args: { request: 'whether the deployment review moved to Thursday at 4 pm', details: "I didn't confirm it" } },
  { ts: T0 + 95000, name: 'call_note', args: { text: 'Ankit prefers payments work' } },
  { ts: T0 + 232000, name: 'call_send_chat_to_caller', status: 'sent', args: { text: 'Hi Ankit, PAY-412 is assigned to you: https://acme.atlassian.net/browse/PAY-412' } },
  { ts: T0 + 232000, name: 'call_end', ok: true, args: { reason: 'done' } },
];

test('rendering: header table, summary, actions from the log, follow-ups, transcript (§8.3)', () => {
  const md = notes.renderNotes({
    call: CALL,
    transcript: TRANSCRIPT,
    actions: ACTIONS,
    summary: { summary: 'Ankit asked for a ticket from the current sprint. I assigned him PAY-412.', followUps: ['Confirm whether the deployment review moved.', 'confirm whether the deployment review moved'], topics: ['sprint'] },
  });
  const lines = md.split('\n');
  assert.equal(lines[0], '# Call with Ankit Sharma — Zoho Cliq');
  assert.ok(lines.includes('| When | Sun 18 Oct 2026, 14:05–14:09 (3 min 52 s) |'), md);
  assert.ok(lines.includes('| Caller | Ankit Sharma (Jira: ankit.sharma@example.com) |'));
  assert.ok(lines.includes("| Answered by | Claude Anywhere, as Deepanshu's AI assistant (cloned voice; disclosure given) |"));
  assert.ok(lines.includes('| Ended | The caller hung up |'));
  const section = (name) => md.split(`## ${name}\n`)[1].split('\n\n')[0];
  assert.equal(section('Summary'), 'Ankit asked for a ticket from the current sprint. I assigned him PAY-412.');
  assert.deepEqual(section('Actions taken').split('\n'), [
    '- 14:06 Assigned **PAY-412** "Fix retry on failed card capture" to Ankit Sharma ✓',
    '- 14:06 Refused: Assigned **PAY-413** to Ankit Sharma (budget: at most 1 assignment per call)',
    '- 14:06 Commented on **PAY-412**: "Picked up on a call" ✗ (Jira answered 500)',
    '- 14:09 Sent Ankit a Zoho Cliq message: "Hi Ankit, PAY-412 is assigned to you: https://acme.atlassian.net/browse/PAY-412" ✓',
  ]);
  assert.deepEqual(section('Follow-ups for you').split('\n'), [
    "- Ankit asked: whether the deployment review moved to Thursday at 4 pm (I didn't confirm it)",
    '- Confirm whether the deployment review moved.',
  ]);
  assert.equal(section('Notes from the call'), '- Ankit prefers payments work');
  assert.match(md, /^Topics: sprint$/m);
  assert.match(md, /^\*\*14:05:12 Assistant:\*\* Hi Ankit, this is Deepanshu's AI assistant/m);
  assert.match(md, /^\*\*14:05:20 Ankit:\*\* Hi, can you please assign me a ticket from the current sprint\?$/m);
  assert.match(md, /^\*\*14:05:22 Assistant:\*\* Sure, let me check the board\. \[interrupted\]$/m);
  assert.doesNotMatch(md, /unassigned|call_end|call_find/);
  assert.match(md, /No audio is kept with these notes/);
});

test('rendering: an action summary written by the daemon is used as is; nothing comes from the model', () => {
  const md = notes.renderNotes({
    call: CALL,
    transcript: [],
    actions: [{ ts: T0, name: 'call_assign_ticket_to_caller', ok: true, summary: 'Assigned **PAY-9** "Fix it" to Ankit Sharma' }],
    // The model claims an action the log does not have: it is not listed under "Actions taken".
    summary: { summary: 'I assigned PAY-1, PAY-2 and PAY-3 and deleted the backlog.', followUps: [] },
  });
  const actions = md.split('## Actions taken\n')[1].split('\n\n')[0];
  assert.equal(actions, '- 14:05 Assigned **PAY-9** "Fix it" to Ankit Sharma ✓');
  assert.match(md, /## Follow-ups for you\n- None\./);
  assert.match(md, /## Transcript\n_Nothing was transcribed\._/);
});

test('rendering: caller text is inert (no headings, HTML or table breaks) and secrets are masked', () => {
  const md = notes.renderNotes({
    call: { ...CALL, caller: 'Mallory | <b>Boss</b>' },
    transcript: [
      { role: 'caller', text: 'hello\n\n# Fake heading\n- fake item <script>alert(1)</script>', ts: T0 },
      { role: 'caller', text: 'my api_key=sk-ant-abcdefghijklmnop123 and password: hunter2', ts: T0 + 1000 },
      { role: 'caller', text: `bidi\u202etxt.exe and zero\u200bwidth`, ts: T0 + 2000 },
    ],
    actions: [],
    summary: null,
  });
  assert.doesNotMatch(md, /^# Fake heading/m);
  assert.doesNotMatch(md, /^- fake item/m);
  assert.doesNotMatch(md, /<script>|<b>/);
  assert.match(md, /&lt;script&gt;/);
  assert.match(md, /\| Caller \| Mallory \\\| &lt;b&gt;Boss&lt;\/b&gt; \(not matched to a Jira account\) \|/);
  assert.doesNotMatch(md, /sk-ant-abcdefghijklmnop123|hunter2/);
  assert.match(md, /api_key=\*\*\*/);
  assert.doesNotMatch(md, /[\u202e\u200b]/);
  // The fallback summary quotes the caller from the transcript only.
  assert.match(md, /## Summary\nMallory called on Zoho Cliq and said: “hello # Fake heading/);
  assert.match(md, /Written from the transcript only/);
});

test('privacy: no transcript after an objection or with saveTranscript off; takeover and unknown callers', () => {
  const objection = notes.renderNotes({ call: { ...CALL, transcriptStopped: 'objection' }, transcript: TRANSCRIPT, actions: [] });
  assert.match(objection, /## Transcript\n_Not saved: the caller asked not to be transcribed\._/);
  // Not in the transcript, and not quoted by the fallback summary either.
  assert.doesNotMatch(objection, /current sprint/);
  assert.match(objection, /## Summary\nAnkit called on Zoho Cliq\. No summary was written/);
  const withSummary = notes.renderNotes({ call: { ...CALL, transcriptStopped: 'objection' }, transcript: TRANSCRIPT, actions: [], summary: { summary: 'Ankit wanted a ticket.' } });
  assert.match(withSummary, /## Summary\nAnkit wanted a ticket\./);
  // CallSession.status() says saveTranscript:false for both; the config tells them apart.
  const off = notes.renderNotes({ call: { ...CALL, saveTranscript: false }, transcript: TRANSCRIPT, actions: [], config: { calls: { saveTranscript: false } } });
  assert.match(off, /_Not saved: transcript saving is off \(calls\.saveTranscript\)\._/);
  const objected = notes.renderNotes({ call: { ...CALL, saveTranscript: false }, transcript: [], actions: [], config: { calls: { saveTranscript: true } } });
  assert.match(objected, /_Not saved: the caller asked not to be transcribed\._/);
  assert.match(notes.renderNotes({ call: { ...CALL, saveTranscript: false }, transcript: [], actions: [] }), /_Not saved: the transcript was turned off for this call\._/);
  // Session records (ISO times, daemon-written summaries, deferred flags) render as they are.
  const sess = notes.renderNotes({
    call: { ...CALL, caller: 'Ankit Sharma', appName: 'Zoho Cliq' },
    transcript: [],
    actions: [
      { ts: new Date(T0 + 60000).toISOString(), name: 'call_assign_ticket_to_caller', summary: 'Assigned **PAY-412** "Fix retry" to Ankit Sharma', ok: true, key: 'PAY-412' },
      { ts: new Date(T0 + 70000).toISOString(), name: 'call_assign_ticket_to_caller', summary: 'Assign PAY-7 to Priya', ok: false, deferred: true },
    ],
  });
  assert.match(sess, /## Actions taken\n- 14:06 Assigned \*\*PAY-412\*\* "Fix retry" to Ankit Sharma ✓\n\n/);
  assert.match(sess, /## Follow-ups for you\n- Assign PAY-7 to Priya\n/);
  const taken = notes.renderNotes({ call: { ...CALL, takeoverAt: T0 + 120000, endReason: 'takeover', cloned: false, caller: '', owner: 'Deepanshu Patel' }, transcript: [], actions: [] });
  assert.match(taken, /^# Call with an unknown caller — Zoho Cliq$/m);
  assert.match(taken, /\| Taken over \| Deepanshu took over at 14:07; these notes cover the call up to then \|/);
  assert.match(taken, /\(standard voice; disclosure given\)/);
  assert.doesNotMatch(taken, /\| Ended \|/);
  const early = notes.renderNotes({ call: { ...CALL, disclosureSpoken: false }, transcript: [], actions: [] });
  assert.match(early, /the call ended before the AI disclosure finished/);
});

test('rendering what CallManager sends: callerAccount, reason, transcriptSaved, tookOver, simulated, summary.notes', () => {
  // The shape of CallManager._writeNotes() (src/calls/manager.js).
  const call = {
    id: 'c-9',
    caller: 'Ankit Sharma',
    callerAccount: { displayName: 'Ankit Sharma', email: 'ankit@example.com' },
    app: 'zoho-cliq',
    appName: 'Zoho Cliq',
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + 90000).toISOString(),
    reason: 'caller_hung_up',
    ownerName: 'Deepanshu Patel',
    cloned: true,
    disclosure: true,
    transcriptSaved: true,
  };
  const actions = [
    { ts: new Date(T0 + 30000).toISOString(), name: 'assign', key: 'PAY-412', summary: 'Assigned PAY-412 "Fix retry" to Ankit Sharma', ok: true },
    { ts: new Date(T0 + 40000).toISOString(), name: 'chat_queued', summary: 'Queued a Zoho Cliq message to Ankit Sharma: "PAY-412 is yours"', ok: true },
    { ts: new Date(T0 + 90000).toISOString(), name: 'chat_sent', summary: 'Sent Ankit Sharma a Zoho Cliq message: "PAY-412 is yours"', ok: true },
    { ts: new Date(T0 + 50000).toISOString(), name: 'comment', key: 'PAY-412', summary: 'Commenting on PAY-412 failed: HTTP 500', ok: false },
  ];
  const summary = { summary: 'Ankit got PAY-412.', followUps: ['Follow-up for Deepanshu: the deployment review time'], topics: [], notes: ['Ankit is on the payments team'], source: 'engine' };
  const md = notes.renderNotes({ call, transcript: [{ role: 'caller', text: 'Can I get a ticket?', ts: new Date(T0 + 5000).toISOString() }], actions, summary, config: { calls: { saveTranscript: true } } });
  assert.match(md, /\| Caller \| Ankit Sharma \(Jira: ankit@example\.com\) \|/);
  assert.match(md, /\| Answered by \| Claude Anywhere, as Deepanshu's AI assistant \(cloned voice; disclosure given\) \|/);
  assert.match(md, /\| Ended \| The caller hung up \|/);
  const acts = md.split('## Actions taken\n')[1].split('\n\n')[0].split('\n');
  assert.deepEqual(acts, ['- 14:05 Assigned PAY-412 "Fix retry" to Ankit Sharma ✓', '- 14:06 Commenting on PAY-412 failed: HTTP 500 ✗', '- 14:06 Sent Ankit Sharma a Zoho Cliq message: "PAY-412 is yours" ✓']);
  assert.match(md, /## Follow-ups for you\n- Follow-up for Deepanshu: the deployment review time\n/);
  assert.match(md, /## Notes from the call\n- Ankit is on the payments team\n/);
  assert.match(md, /\*\*14:05:17 Ankit:\*\* Can I get a ticket\?/);
  // Not saved (the manager passes an empty transcript too), taken over, simulated.
  const off = notes.renderNotes({ call: { ...call, transcriptSaved: false, tookOver: true, simulated: true, reason: 'takeover' }, transcript: [], actions: [], summary, config: { calls: { saveTranscript: true } } });
  assert.match(off, /_Not saved: the caller asked not to be transcribed\._/);
  assert.match(off, /\| Taken over \| Deepanshu took over the call; these notes cover the call up to then \|/);
  assert.doesNotMatch(off, /\| Ended \|/);
  assert.match(off, /\| Note \| A simulated test call: nobody called \|/);
  // A queued message that was never sent stays visible.
  const queued = notes.renderNotes({ call, transcript: [], actions: [actions[1]], summary });
  assert.match(queued, /- 14:05 Queued a Zoho Cliq message to Ankit Sharma: "PAY-412 is yours" ✓/);
});

test('Windows: the manager passes the Win32 driver as psHost (desktopPath() on it)', async () => {
  const desk = 'C:\\Users\\dee\\OneDrive\\Desktop';
  const psHost = { desktopPath: async () => ({ path: desk, exists: true }), listWindows: async () => [] };
  const d = await notes.resolveDesktop({ platformInfo: { platform: 'win32', isWSL: false }, env: { USERPROFILE: 'C:\\Users\\dee' }, psHost, fs: fakeFs([desk]), which: noWhich, runner: noRun });
  assert.deepEqual([d.dir, d.source, d.synced], [desk, 'known-folder', 'onedrive']);
});

// ---------------------------------------------------------------- writing

test('writeNotes: <Desktop>/Claude Call Notes, 0700 folder, 0600 file, collisions get " (2)"', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'Desktop'));
  const opts = { platformInfo: LINUX, env: { HOME: home }, homedir: home, which: noWhich, runner: noRun, call: CALL, transcript: TRANSCRIPT, actions: ACTIONS, summary: null };
  const p1 = await notes.writeNotes(opts);
  const folder = path.join(home, 'Desktop', 'Claude Call Notes');
  assert.equal(p1, path.join(folder, '2026-10-18 14-05 Ankit (Zoho Cliq).md'));
  assert.match(fs.readFileSync(p1, 'utf8'), /^# Call with Ankit Sharma — Zoho Cliq/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
    assert.equal(fs.statSync(p1).mode & 0o777, 0o600);
  }
  let info = null;
  const p2 = await notes.writeNotes({ ...opts, onWritten: (r) => (info = r) });
  assert.equal(p2, path.join(folder, '2026-10-18 14-05 Ankit (Zoho Cliq) (2).md'));
  assert.deepEqual([info.fallback, info.source, info.dir], [null, 'home-desktop', folder]);
  // Re-render in place once the summary arrives (no third file).
  const r3 = await notes.writeNoteFile({ ...opts, file: p2, summary: { summary: 'Done.', followUps: [] } });
  assert.equal(r3.path, p2);
  assert.match(fs.readFileSync(p2, 'utf8'), /## Summary\nDone\./);
  assert.equal(fs.readdirSync(folder).length, 2);
  // A file outside the notes folder is never rewritten.
  const outside = path.join(home, 'other.md');
  fs.writeFileSync(outside, 'keep');
  const r4 = await notes.writeNoteFile({ ...opts, file: outside });
  assert.notEqual(r4.path, outside);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('macOS: EPERM on the Desktop (TCC) writes to <state>/calls/notes and says so', async () => {
  const home = tmpHome();
  const desk = path.join(home, 'Desktop');
  fs.mkdirSync(desk);
  const fallbackDir = path.join(TMP, 'state', 'calls', 'notes');
  const deny = (p) => String(p).startsWith(desk);
  const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  const tccFs = new Proxy(fs, {
    get(target, prop) {
      if (['mkdirSync', 'openSync', 'writeFileSync', 'appendFileSync'].includes(prop)) {
        return (p, ...rest) => {
          if (deny(p)) throw eperm();
          return target[prop](p, ...rest);
        };
      }
      return target[prop];
    },
  });
  const r = await notes.writeNoteFile({ platformInfo: { platform: 'darwin', isWSL: false }, env: { HOME: home }, homedir: home, fs: tccFs, fallbackDir, call: CALL, transcript: TRANSCRIPT, actions: [] });
  assert.equal(r.fallback, 'tcc');
  assert.match(r.reason, /^EPERM/);
  assert.equal(r.source, 'fallback');
  assert.equal(path.dirname(r.path), fallbackDir);
  assert.match(fs.readFileSync(r.path, 'utf8'), /# Call with Ankit Sharma/);
  assert.deepEqual(fs.readdirSync(desk), []);
  // The default fallback folder is under the state directory.
  assert.equal(notes.fallbackNotesDir(), path.join(TMP, 'state', 'calls', 'notes'));
  // Missed calls go the same way.
  const m = await notes.appendMissedCall({ platformInfo: { platform: 'darwin', isWSL: false }, env: { HOME: home }, homedir: home, fs: tccFs, fallbackDir, date: T0, caller: 'Ankit Sharma', app: 'zoho-cliq', reason: 'quiet hours' });
  assert.equal(m.fallback, 'tcc');
  assert.equal(path.dirname(m.path), fallbackDir);
});

test('missed calls are appended to one file with a header', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'Desktop'));
  const base = { platformInfo: LINUX, env: { HOME: home }, homedir: home, which: noWhich, runner: noRun };
  const a = await notes.appendMissedCall({ ...base, date: T0, caller: 'Ankit Sharma', app: 'zoho-cliq', reason: 'quiet hours' });
  await notes.appendMissedCall({ ...base, date: T0 + 60000, caller: '', app: 'google-meet' });
  assert.equal(a.path, path.join(home, 'Desktop', 'Claude Call Notes', 'Missed calls.md'));
  assert.equal(fs.readFileSync(a.path, 'utf8'), '# Missed calls\n\nCalls Claude Anywhere did not answer for you.\n\n- 2026-10-18 14:05 Ankit Sharma (Zoho Cliq) — quiet hours\n- 2026-10-18 14:06 Unknown caller (Google Meet)\n');
});

test('listing and reading notes: newest first, only inside the notes folder', () => {
  const dir = path.join(tmpHome(), 'notes');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.md'), '# A');
  fs.writeFileSync(path.join(dir, 'b.md'), '# B');
  fs.writeFileSync(path.join(dir, 'skip.txt'), 'x');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(dir, 'a.md'), past, past);
  const list = notes.listNotes(dir);
  assert.deepEqual(list.map((n) => n.name), ['b.md', 'a.md']);
  assert.deepEqual(notes.listNotes(path.join(dir, 'missing')), []);
  assert.equal(notes.readNote(path.join(dir, 'a.md'), { dirs: [dir] }), '# A');
  const outside = path.join(path.dirname(dir), 'secret.md');
  fs.writeFileSync(outside, 'secret');
  assert.throws(() => notes.readNote(outside, { dirs: [dir] }), /not in the call notes folder/);
  assert.throws(() => notes.readNote(path.join(dir, '..', 'secret.md'), { dirs: [dir] }), /not in the call notes folder/);
  assert.throws(() => notes.readNote(path.join(dir, 'skip.txt'), { dirs: [dir] }), /Not a notes file/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(outside, path.join(dir, 'link.md'));
    assert.throws(() => notes.readNote(path.join(dir, 'link.md'), { dirs: [dir] }), /not in the call notes folder/);
  }
});

test('doctor row: the folder, a write test that leaves nothing behind, cloud sync', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'Desktop'));
  const base = { platformInfo: LINUX, env: { HOME: home }, homedir: home, which: noWhich, runner: noRun };
  const row = await notes.doctorRow(base);
  assert.deepEqual([row.id, row.status, row.detail], ['calls-notes', 'ok', path.join(home, 'Desktop', 'Claude Call Notes')]);
  assert.deepEqual(fs.readdirSync(path.join(home, 'Desktop')), []);
  const ro = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'writeFileSync') {
        return () => {
          throw Object.assign(new Error('read-only'), { code: 'EROFS' });
        };
      }
      return target[prop];
    },
  });
  const bad = await notes.doctorRow({ ...base, fs: ro });
  assert.equal(bad.status, 'warn');
  assert.match(bad.detail, /cannot write \(EROFS\)/);
  assert.match(bad.fix, /calls\.notesDir/);
  const mac = await notes.doctorRow({ ...base, platformInfo: { platform: 'darwin' }, fs: ro });
  assert.match(mac.fix, /Privacy & Security › Files and Folders/);
});

test('formatting helpers', () => {
  assert.equal(notes.formatDuration(232000), '3 min 52 s');
  assert.equal(notes.formatDuration(45000), '45 s');
  assert.equal(notes.formatDuration(3720000), '1 h 2 min');
  assert.equal(notes.formatWhen(new Date(2026, 9, 18, 23, 58), new Date(2026, 9, 19, 0, 3)), 'Sun 18 Oct 2026, 23:58 – Mon 19 Oct 2026, 00:03 (5 min)');
  assert.equal(notes.formatWhen(T0, null), 'Sun 18 Oct 2026, 14:05');
  assert.equal(notes.appName('google-meet'), 'Google Meet');
  assert.equal(notes.appName('Microsoft Teams (work)'), 'Microsoft Teams');
  assert.equal(notes.appName('Jitsi'), 'Jitsi');
  assert.equal(notes.syncedBy('C:/Users/x/OneDrive/Desktop', { env: {}, platform: 'win32' }), 'onedrive');
  assert.equal(notes.syncedBy('/home/x/Desktop', { env: {}, platform: 'linux' }), null);
});
