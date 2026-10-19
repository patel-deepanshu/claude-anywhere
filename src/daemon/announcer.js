'use strict';

/**
 * The announcer decides WHAT the daemon says aloud and WHEN, in one place:
 *
 *   done        a finished turn: "All done." / "Finished." / "Done!" + its first sentence or two
 *   error       a failed turn or a crashed engine: "I ran into a problem: …"
 *   permission  an approval card: "I need your permission to run gcloud run deploy for shop-api."
 *   question    Claude asks: "Quick question: which region? Options are us-central1 or europe-west1."
 *   info        a voice test; notify_user {speak:true} (and a bridge reply with speak); a hand-off
 *               ("Switching to shop-api to continue."): the real "done" comes from the new session
 *
 * Policy: nothing when voice.speakResponses is off, voice.tts is 'off', or voice.announce.<kind>
 * is false; nothing for a turn the user stopped; nothing for a quick turn (under ~4 s) that used
 * no tools (it would chatter after every small answer). Permission cards and questions are
 * always announced. Each event is announced once. A notify_user message Claude asked to be
 * spoken is said whenever voice.tts is not 'off' (as before the announcer), without a chime.
 * The dialog does not speak results, cards or notifications itself while snapshot.voice.announcer
 * is true, so nothing is said twice.
 *
 * Delivery: when a dialog page is connected and visible, the daemon broadcasts 'announce'
 * {id, kind, text, audio, chime, ts} and the page plays it (audio is a Piper WAV id for
 * GET /api/tts/audio, or null: the page uses browser speech). Otherwise the daemon plays it
 * itself: the chime, then the Piper voice or the OS voice. With voice.ttsEngine 'browser' the
 * daemon stays silent when no page is visible; with 'os' the daemon always speaks itself.
 */

const { stripMarkdownForSpeech, truncate, uuid, nowIso } = require('../shared/util');
const { createLogger, redact } = require('../shared/log');

const log = createLogger('announcer');

const KINDS = ['done', 'permission', 'question', 'error', 'info'];
const DONE_OPENERS = ['All done.', 'Finished.', 'Done!', "That's done.", 'Okay, finished.'];
const MIN_QUIET_TURN_MS = 4000;
const MAX_QUEUE = 4;
const MAX_SEEN = 300;
const DONE_MAX = 220;

// ------------------------------------------------------------------ wording

/**
 * Text that is safe and pleasant to read aloud: secrets masked, whitespace collapsed.
 * @param {*} text
 * @param {(word:string)=>any} [secretLike]
 * @returns {string}
 */
function safeSpeech(text, secretLike) {
  let s = redact(String(text == null ? '' : text));
  if (typeof secretLike === 'function') {
    s = s
      .split(/(\s+)/)
      .map((w) => {
        // Judge the word without the sentence's punctuation around it: "ABC-123-fix-login-timeout,"
        // is a branch name followed by a comma, not a password.
        const m = /^([("'`[]*)(.*?)([)"'`\],.;:!?]*)$/s.exec(w);
        const core = m && m[2] ? m[2] : w;
        try {
          return core.trim() && secretLike(core) ? `${m ? m[1] : ''}hidden${m ? m[3] : ''}` : w;
        } catch {
          return w;
        }
      })
      .join('');
  }
  return s
    .replace(/\*{3,}/g, 'hidden')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first one or two sentences of a reply, markdown removed, at most `max` characters
 * (cut at a word boundary).
 * @param {string} text
 * @param {{max?:number, sentences?:number}} [opts]
 * @returns {string}
 */
function firstSentences(text, { max = DONE_MAX, sentences = 2 } = {}) {
  let raw = String(text || '');
  // A heading ("## Summary") is a title, not something to say, when text follows it.
  const noHeadings = raw.replace(/^\s{0,3}#{1,6}\s+.*$/gm, '');
  if (noHeadings.trim()) raw = noHeadings;
  // List items and tables after a sentence are details the dialog shows; the sentence is the gist.
  const prose = raw.replace(/^\s*(?:[-*+]|\d+[.)]|\|).*$/gm, '');
  if (prose.trim()) raw = prose;
  // A link becomes "the link" but keeps the punctuation after it (the sentence end).
  raw = raw.replace(/https?:\/\/[^\s<>()]+?(?=[.,;:!?)]*(?:\s|$))/g, 'the link');
  const plain = stripMarkdownForSpeech(raw)
    .replace(/\(code omitted\)/g, ' ')
    .replace(/\s*\(the link\)/g, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/:\s*(\.|$)/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  // Sentence ends are punctuation followed by a space ("app.js" is not one).
  const parts = plain.split(/(?<=[.!?…]["')\]]?)\s+(?=\S)/);
  let out = '';
  let n = 0;
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const next = out ? `${out} ${t}` : t;
    if (next.length > max) break;
    out = next;
    // "Done." or "OK." is an interjection, not one of the sentences that carry the news.
    if (t.length >= 12) n += 1;
    if (n >= sentences) break;
  }
  if (!out) {
    const cut = plain.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    out = `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, '')}…`;
  }
  return out ? out[0].toUpperCase() + out.slice(1) : out;
}

function sentence(t) {
  const s = String(t || '').trim();
  if (!s) return s;
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

function lowerFirst(s) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/** The last segment of a folder path, POSIX or Windows ("C:\\code\\shop-api\\" → "shop-api"). */
function folderName(p) {
  const parts = String(p || '')
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'the other folder';
}

/** Shorten a path to its last two segments ("…/src/app.js" → "src/app.js"). */
function shortPath(p) {
  const s = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!s) return s;
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return s.replace(/[\\/]+$/, '') || s;
  return parts.slice(-2).join('/');
}

/** Split a shell command into words (quotes respected, no expansion). */
function shellWords(cmd) {
  const out = [];
  // A word may mix quoted and bare parts: user.name="Dev Tester" is one word.
  const re = /(?:"(?:[^"\\]|\\.)*"?|'[^']*'?|[^\s"']+)+/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[0].replace(/"((?:[^"\\]|\\.)*)"?|'([^']*)'?/g, (_, d, q) => (d != null ? d : q)));
  return out;
}

// Programs whose first words are subcommands, and how many: gcloud/az end at their verb.
const VERBS = new Set([
  'create', 'delete', 'deploy', 'update', 'list', 'describe', 'set', 'enable', 'disable', 'add', 'remove', 'get',
  'apply', 'submit', 'start', 'stop', 'restart', 'ssh', 'scp', 'import', 'export', 'login', 'logout', 'init', 'call',
  'upload', 'download', 'publish', 'rollback', 'scale', 'resize', 'attach', 'detach', 'grant', 'revoke', 'bind',
  'add-iam-policy-binding', 'remove-iam-policy-binding', 'replace', 'patch', 'promote', 'connect', 'cancel', 'execute',
]);
const NESTED = {
  gcloud: { verbEnded: true, max: 4, target: true },
  az: { verbEnded: true, max: 4, target: true },
  aws: { max: 2, target: true },
  kubectl: { max: 2, target: true },
  oc: { max: 2, target: true },
  helm: { max: 1, target: true },
  firebase: { max: 1, target: true },
  vercel: { max: 1, target: true },
  flyctl: { max: 1, target: true },
  fly: { max: 1, target: true },
  heroku: { max: 1, target: true },
  terraform: { max: 1 },
  docker: { max: 1, mgmt: new Set(['compose', 'container', 'image', 'network', 'volume', 'system', 'builder', 'buildx', 'context']) },
  podman: { max: 1, mgmt: new Set(['compose', 'container', 'image', 'network', 'volume', 'system']) },
  git: { max: 1 },
  gh: { max: 2 },
  npm: { max: 1, mgmt: new Set(['run', 'exec']) },
  pnpm: { max: 1, mgmt: new Set(['run', 'exec', 'dlx']) },
  yarn: { max: 1, mgmt: new Set(['run', 'dlx']) },
  bun: { max: 1, mgmt: new Set(['run', 'x']) },
  pip: { max: 1 },
  pip3: { max: 1 },
  cargo: { max: 1 },
  go: { max: 1 },
  dotnet: { max: 1 },
  brew: { max: 1 },
  apt: { max: 1 },
  'apt-get': { max: 1 },
  dnf: { max: 1 },
  yum: { max: 1 },
  pacman: { max: 1 },
  winget: { max: 1 },
  choco: { max: 1 },
  systemctl: { max: 1, target: true },
  launchctl: { max: 1 },
  make: { max: 1 },
  gradle: { max: 1 },
  mvn: { max: 1 },
};
// Flags whose value is the next word ("--project p1"); other flags are taken as switches.
const VALUE_FLAGS = new Set([
  '--project', '--region', '--zone', '--account', '--format', '--configuration', '--name', '--resource-group', '-g',
  '--namespace', '-n', '--profile', '--subscription', '--location', '--context', '--cluster', '--image', '--source',
  '--file', '-f', '--output', '-o', '--tag', '-t', '--env', '-e', '--platform', '--service', '--revision', '--memory',
  '--set', '--values', '--version', '--port', '-p', '-c', '-C',
]);
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'command', 'exec', 'nice', 'stdbuf']);
const WORD_RE = /^[a-z][a-z0-9:_-]*$/;

/**
 * "rm -rf tmp/build" → "delete the folder tmp/build"; "gcloud run deploy shop-api --region x" →
 * "run gcloud run deploy for shop-api"; anything else → "run <program> <first argument>".
 * Long commands are never read out.
 * @param {string} command
 * @returns {string}
 */
function humanizeCommand(command) {
  let cmd = String(command || '').replace(/\s+/g, ' ').trim();
  if (!cmd) return 'run a command';
  // The first real step of a chain: "cd app && npm test" → "npm test".
  const steps = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  let step = steps[0] || cmd;
  if (/^(cd|pushd|set|export)\b/.test(step) && steps.length > 1) step = steps.find((s) => !/^(cd|pushd|set|export)\b/.test(s)) || step;
  cmd = step;
  let words = shellWords(cmd);
  let admin = false;
  while (words.length && (WRAPPERS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
    if (words[0] === 'sudo' || words[0] === 'doas') admin = true;
    words = words.slice(1);
    while (words.length && words[0].startsWith('-')) words = words.slice(1);
  }
  if (!words.length) return 'run a command';
  const prog = words[0].split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  const args = words.slice(1);
  const flags = args.filter((a) => a.startsWith('-'));
  const plain = args.filter((a) => !a.startsWith('-'));
  const asAdmin = admin ? ' as administrator' : '';
  const more = (list) => (list.length > 1 ? ` and ${list.length - 1} more` : '');
  const progLower = prog.toLowerCase();

  if (progLower === 'rm' || progLower === 'del' || progLower === 'erase' || progLower === 'rmdir' || progLower === 'rd' || progLower === 'remove-item') {
    const recursive = progLower === 'rmdir' || progLower === 'rd' || flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || /^--recursive$/i.test(f) || /^-recurse$/i.test(f) || /^\/s$/i.test(f));
    const targets = plain.filter((a) => !/^\/[a-z]$/i.test(a));
    if (!targets.length) return `delete files${asAdmin}`;
    return `delete ${recursive ? 'the folder ' : ''}${shortPath(targets[0])}${more(targets)}${asAdmin}`;
  }
  if ((progLower === 'mv' || progLower === 'move' || progLower === 'move-item') && plain.length >= 2) {
    return `move ${shortPath(plain[0])} to ${shortPath(plain[plain.length - 1])}${asAdmin}`;
  }
  if ((progLower === 'cp' || progLower === 'copy' || progLower === 'copy-item') && plain.length >= 2) {
    return `copy ${shortPath(plain[0])} to ${shortPath(plain[plain.length - 1])}${asAdmin}`;
  }
  if ((progLower === 'mkdir' || progLower === 'md') && plain.length) return `create the folder ${shortPath(plain[0])}${asAdmin}`;
  if (progLower === 'chmod' || progLower === 'chown') return `change permissions of ${shortPath(plain[plain.length - 1] || 'files')}${asAdmin}`;
  if (progLower === 'kill' || progLower === 'pkill' || progLower === 'killall' || progLower === 'taskkill') return `stop a running process${asAdmin}`;
  if (progLower === 'curl' || progLower === 'wget') {
    const url = plain.find((a) => /^https?:\/\//i.test(a));
    let host = '';
    try {
      host = url ? new URL(url).hostname : '';
    } catch {
      host = '';
    }
    return `run ${progLower}${host ? ` on ${host}` : ''}${asAdmin}`;
  }

  const nested = NESTED[progLower];
  if (nested) {
    const sub = [];
    let i = 0;
    for (; i < args.length; i += 1) {
      const a = args[i];
      if (a.startsWith('-')) {
        // "--project p1": skip the flag's value too when it is a separate word.
        if (!a.includes('=') && VALUE_FLAGS.has(a)) i += 1;
        continue;
      }
      if (!WORD_RE.test(a)) break;
      sub.push(a);
      if (nested.verbEnded && VERBS.has(a)) {
        i += 1;
        break;
      }
      const limit = nested.mgmt && nested.mgmt.has(sub[0]) ? nested.max + 1 : nested.max;
      if (!nested.verbEnded && sub.length >= limit) {
        i += 1;
        break;
      }
      if (nested.verbEnded && sub.length >= nested.max) {
        i += 1;
        break;
      }
    }
    let target = '';
    if (nested.target) {
      for (let j = i; j < args.length; j += 1) {
        const a = args[j];
        if (a.startsWith('-')) {
          if (!a.includes('=') && VALUE_FLAGS.has(a)) j += 1; // its value
          continue;
        }
        target = a;
        break;
      }
      // "az group delete --name rg1": the name flag is the target.
      if (!target) {
        const k = args.findIndex((a) => a === '--name' || a.startsWith('--name='));
        if (k >= 0) target = args[k].includes('=') ? args[k].slice(7) : args[k + 1] || '';
      }
    }
    const t = target && target.length <= 40 && target !== '.' ? ` for ${shortPath(target)}` : '';
    return `run ${[progLower, ...sub].join(' ')}${t}${asAdmin}`;
  }
  const first = plain[0];
  const arg = first && first.length <= 40 ? ` ${shortPath(first)}` : '';
  return `run ${progLower}${arg}${asAdmin}`;
}

/**
 * The action of an approval card in plain words ("run npm test", "edit src/app.js").
 * @param {{summary?:string, displayName?:string, toolName?:string, input?:object}} card
 * @param {(word:string)=>any} [secretLike]
 * @returns {string}
 */
function humanizeAction(card = {}, secretLike) {
  const c = card && typeof card === 'object' ? card : {};
  const summary = String(c.summary || '').replace(/\s+/g, ' ').trim();
  const tool = String(c.toolName || '');
  const input = c.input && typeof c.input === 'object' ? c.input : {};
  let action = '';
  let m;
  if ((m = /^Run:\s*(.*)$/s.exec(summary)) || (tool === 'Bash' && (m = [null, input.command || summary]))) {
    // In a chain ("npm test && git -c … checkout -b x"), name the step the card is about: the
    // policy's reason ends with "— in: <that step>".
    const risky = /\s—\s+in:\s+(.+)$/.exec(String(c.reason || ''));
    action = humanizeCommand(risky ? risky[1].replace(/…$/, '') : m[1]);
  } else if ((m = /^(Edit notebook|Edit|Write)\s+(.+)$/.exec(summary))) {
    action = `${m[1] === 'Write' ? 'write' : m[1].toLowerCase()} ${shortPath(m[2])}`;
  } else if ((m = /^Read(?: notebook)?\s+(.+)$/.exec(summary))) {
    action = `read ${shortPath(m[1])}`;
  } else if ((m = /^Fetch\s+(\S+)/.exec(summary)) || (m = /^Navigate to\s+(\S+)/.exec(summary))) {
    let host = m[1];
    try {
      host = new URL(m[1]).hostname;
    } catch {
      /* keep */
    }
    action = `${summary.startsWith('Fetch') ? 'fetch a page from' : 'open'} ${host}`;
  } else if (/^Type text\b/i.test(summary) || /__type_text$/.test(tool)) {
    action = 'type some text';
  } else if (/^(Set clipboard|Read clipboard)/i.test(summary) || /__clipboard_(set|get)$/.test(tool)) {
    action = /set/i.test(summary + tool) ? 'change the clipboard' : 'read the clipboard';
  } else if ((m = /^Press keys:?\s*(.+)$/i.exec(summary)) || (/__key$/.test(tool) && (m = [null, input.combo || '']))) {
    action = `press ${String(m[1]).split(/\s+/)[0] || 'keys'}`;
  } else if (/^Click\b/i.test(summary) || /__click$/.test(tool)) {
    action = 'click on the screen';
  } else if ((m = /^Open:?\s+(.+)$/i.exec(summary))) {
    action = `open ${shortPath(m[1])}`;
  } else if ((m = /^Run a sub-agent:?\s*(.*)$/.exec(summary))) {
    action = 'start a helper agent';
  } else if ((m = /^Use the (.+) skill$/.exec(summary))) {
    action = `use the ${m[1]} skill`;
  } else if ((m = /^([a-z0-9_-]+): (.+)$/i.exec(summary)) && /^mcp__/.test(tool)) {
    // "jira: Transition issue PROJ-12" → "use jira to transition issue PROJ-12"
    action = `use ${m[1].replace(/_/g, ' ')} to ${lowerFirst(m[2])}`;
  } else if (summary) {
    action = lowerFirst(summary.replace(/^([A-Z][a-z]+(?: [a-z]+)?):\s*/, '$1 '));
  } else {
    action = lowerFirst(String(c.displayName || tool || 'do something').replace(/^mcp__[^_]+__/, '').replace(/_/g, ' '));
  }
  const safe = safeSpeech(action, secretLike).replace(/[?.!:;,]+$/, '');
  return truncate(safe, 110).replace(/…$/, '');
}

/** One short risk note for high and critical cards ("It makes the service public."). */
function riskNote(card, secretLike) {
  if (!card || !['high', 'critical'].includes(card.risk)) return '';
  let notes = [];
  if (Array.isArray(card.notes)) notes = card.notes.filter((n) => typeof n === 'string' && n.trim());
  else if (typeof card.reason === 'string') notes = card.reason.split(';').slice(1).map((n) => n.replace(/\s*\([^)]*\)/g, '').trim()).filter(Boolean);
  const n = notes[0] ? safeSpeech(notes[0], secretLike).replace(/[.;,]+$/, '') : '';
  if (!n || n.length > 90) return card.risk === 'critical' ? 'It needs a click on the card.' : '';
  return `It ${lowerFirst(n)}.`;
}

/**
 * @param {object} card an approval_request payload
 * @param {{secretLike?:Function}} [opts]
 * @returns {string}
 */
function composePermission(card, { secretLike } = {}) {
  const action = humanizeAction(card, secretLike);
  const note = riskNote(card, secretLike);
  return `I need your permission to ${action || 'continue'}.${note ? ` ${note}` : ''}`;
}

/**
 * A long question with its context first ("ABC-123 is a bug in auth.js. Where should I work?"):
 * only the asking sentence at the end is said; the dialog shows the rest.
 * @param {string} text
 * @returns {string}
 */
function spokenQuestion(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= 120) return t;
  const parts = t.split(/(?<=[.!?…])\s+(?=\S)/);
  if (parts.length < 2 || !/\?$/.test(parts[parts.length - 1])) return t;
  return parts[parts.length - 1];
}

/**
 * An answer option as a person would say it: "shop-api — /tmp/work/shop-api (Recommended)" →
 * "shop-api", "Another folder (type the path)" → "Another folder"; a bare path → its folder name.
 * @param {*} option
 * @returns {string}
 */
function spokenOption(option) {
  const raw = String(option == null ? '' : option).replace(/\s+/g, ' ').trim();
  let t = raw.replace(/\s*\([^()]*\)/g, '').split(/\s+[—–]\s+/)[0].trim();
  if (!t) t = raw;
  if (/^(?:~|\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(t) && !/\s/.test(t)) t = folderName(t);
  return t;
}

/**
 * @param {{question?:string, options?:string[]}} q a question payload
 * @param {{secretLike?:Function}} [opts]
 * @returns {string}
 */
function composeQuestion(q = {}, { secretLike } = {}) {
  const text = truncate(safeSpeech(spokenQuestion(stripMarkdownForSpeech(q.question || '')), secretLike), 200);
  if (!text) return 'Quick question for you. Have a look at the dialog.';
  const ask = /[?.!…]$/.test(text) ? text : `${text}?`;
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((o) => truncate(safeSpeech(spokenOption(typeof o === 'string' ? o : o && o.label), secretLike), 50).replace(/[.?!]+$/, ''))
    .filter(Boolean);
  let tail = '';
  if (options.length === 1) tail = ` Option: ${options[0]}.`;
  else if (options.length > 1 && options.length <= 3) tail = ` Options are ${options.slice(0, -1).join(', ')} or ${options[options.length - 1]}.`;
  else if (options.length > 3) tail = ` Options are ${options.slice(0, 3).join(', ')}, or something else.`;
  return `Quick question: ${ask}${tail}`;
}

/**
 * @param {{text?:string}} result a 'result' payload
 * @param {{opener?:string, secretLike?:Function}} [opts]
 * @returns {string}
 */
function composeDone(result = {}, { opener = DONE_OPENERS[0], secretLike } = {}) {
  // Commit hashes in brackets ("on main (67a4700)") are for the screen, not for the ear.
  const text = String(result.text || '').replace(/\s*\((?:[Cc]ommit\s+)?`?(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}`?\)/g, '');
  const gist = safeSpeech(firstSentences(text), secretLike);
  if (!gist) return opener;
  // "Done. I deployed…" already says it: no second opener.
  if (/^(all )?done\b|^finished\b|^complete(d)?\b|^that'?s done\b/i.test(gist)) return sentence(gist);
  return `${opener} ${sentence(gist)}`;
}

/**
 * @param {string} what what failed
 * @param {{secretLike?:Function}} [opts]
 * @returns {string}
 */
function composeError(what, { secretLike } = {}) {
  const gist = safeSpeech(firstSentences(what || '', { max: 180, sentences: 1 }), secretLike).replace(/^(error|claude code reported an error):\s*/i, '');
  return gist ? `I ran into a problem: ${sentence(gist)}` : 'I ran into a problem. Have a look at the dialog.';
}

// ------------------------------------------------------------------ announcer

/**
 * Listens to the hub's broadcasts and announces finished work, permission cards, questions and
 * failures (see the file comment).
 */
class Announcer {
  /**
   * @param {object} deps
   * @param {object} deps.config the live config object
   * @param {import('./hub').Hub} deps.hub
   * @param {object|null} [deps.voice] VoiceService
   * @param {(kind:'approval'|'question', id:string)=>object|null|undefined} [deps.findCard] the pending card (null when answered)
   * @param {(word:string)=>any} [deps.secretLike]
   * @param {(kind:string)=>string} [deps.chimeFile] path of the chime WAV for a kind
   * @param {()=>number} [deps.now]
   * @param {()=>number} [deps.random]
   * @param {number} [deps.minQuietTurnMs]
   */
  constructor({ config, hub, voice = null, findCard = null, secretLike = null, chimeFile = null, now = Date.now, random = Math.random, minQuietTurnMs = MIN_QUIET_TURN_MS } = {}) {
    this.config = config || {};
    this.hub = hub;
    this.voice = voice;
    this.findCard = typeof findCard === 'function' ? findCard : null;
    this.secretLike = typeof secretLike === 'function' ? secretLike : null;
    this.chimeFile = typeof chimeFile === 'function' ? chimeFile : defaultChimeFile;
    this.now = now;
    this.random = random;
    this.minQuietTurnMs = minQuietTurnMs;
    this.seen = new Set();
    this.queue = [];
    this.running = null;
    this.toolsThisTurn = 0;
    this.lastStatus = null;
    this.lastOpener = null;
    this.visibility = new Map(); // page or synthetic connect key → {visible, seq}
    this.seq = 0;
    this.uiClients = 0;
    this.started = false;
    this.stopped = false;
    this.unsubStop = null;
    this.onEvent = (type, data) => {
      try {
        this.handle(type, data);
      } catch (err) {
        log.warn(`announcing "${type}" failed: ${err.message}`);
      }
    };
    this.onClients = () => this.noteClients();
  }

  /** Start listening to the hub. */
  start() {
    if (this.started || !this.hub) return this;
    this.started = true;
    this.hub.on('event', this.onEvent);
    this.hub.on('clients', this.onClients);
    this.uiClients = this.uiCount();
    if (this.voice && typeof this.voice.onStop === 'function') this.unsubStop = this.voice.onStop(() => this.cancelPending());
    return this;
  }

  /** Stop listening and drop what is queued. */
  stop() {
    this.stopped = true;
    this.cancelPending();
    if (this.hub && this.started) {
      this.hub.removeListener('event', this.onEvent);
      this.hub.removeListener('clients', this.onClients);
    }
    if (this.unsubStop) this.unsubStop();
    this.started = false;
  }

  /** @private */
  get voiceCfg() {
    const v = this.config && this.config.voice;
    return v && typeof v === 'object' ? v : {};
  }

  /** @private */
  uiCount() {
    try {
      return this.hub && typeof this.hub.clientCount === 'function' ? Number(this.hub.clientCount('ui')) || 0 : 0;
    } catch {
      return 0;
    }
  }

  /**
   * A dialog page reported whether it can be seen (POST /api/ui/visibility).
   * @param {{page:string, visible:boolean}} report
   */
  noteVisibility({ page, visible } = {}) {
    if (typeof page !== 'string' || !page) return;
    this.seq += 1;
    this.visibility.delete(page);
    this.visibility.set(page, { visible: Boolean(visible), seq: this.seq });
    this.trimVisibility();
  }

  /** @private a newly connected page counts as visible until it reports otherwise */
  noteClients() {
    const n = this.uiCount();
    if (n > this.uiClients) {
      for (let i = this.uiClients; i < n; i += 1) {
        this.seq += 1;
        this.visibility.set(`connect-${this.seq}`, { visible: true, seq: this.seq });
      }
      this.trimVisibility();
    }
    this.uiClients = n;
  }

  /** @private */
  trimVisibility() {
    while (this.visibility.size > 40) this.visibility.delete(this.visibility.keys().next().value);
  }

  /**
   * Whether a dialog page is connected and visible: the newest report per connected page (pages
   * that connected later count as visible until they report) decides.
   * @returns {boolean}
   */
  dialogVisible() {
    const n = this.uiCount();
    if (n <= 0) return false;
    const recent = [...this.visibility.values()].sort((a, b) => b.seq - a.seq).slice(0, n);
    if (recent.length < n) return true; // a page that never reported: it opened in front
    return recent.some((e) => e.visible);
  }

  /** @private */
  enabled(kind, { force = false } = {}) {
    const v = this.voiceCfg;
    if (v.tts === 'off') return false;
    if (force) return true;
    if (v.speakResponses === false) return false;
    const a = v.announce && typeof v.announce === 'object' ? v.announce : {};
    if (kind === 'info') return true;
    return a[kind] !== false;
  }

  /** @private true the first time a key is seen */
  once(key) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value);
    return true;
  }

  /** @private */
  opener() {
    const choices = DONE_OPENERS.filter((o) => o !== this.lastOpener);
    const pick = choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))];
    this.lastOpener = pick;
    return pick;
  }

  /**
   * React to one hub broadcast.
   * @param {string} type
   * @param {object} data
   * @returns {object|null} the queued announcement, if any
   */
  handle(type, data) {
    if (this.stopped) return null;
    const d = data && typeof data === 'object' ? data : {};
    switch (type) {
      case 'message':
        if (d.role === 'tool') this.toolsThisTurn += 1;
        return null;
      case 'result':
        return this.onResult(d);
      case 'approval_request':
        if (!d.id || !this.once(`approval:${d.id}`) || !this.enabled('permission')) return null;
        return this.enqueue({ kind: 'permission', text: composePermission(d, { secretLike: this.secretLike }), card: { kind: 'approval', id: d.id } });
      case 'question':
        if (!d.id || !this.once(`question:${d.id}`) || !this.enabled('question')) return null;
        return this.enqueue({ kind: 'question', text: composeQuestion(d, { secretLike: this.secretLike }), card: { kind: 'question', id: d.id } });
      case 'status': {
        const prev = this.lastStatus;
        this.lastStatus = d.status || null;
        if (d.status !== 'error' || prev === 'error' || !this.enabled('error')) return null;
        return this.enqueue({ kind: 'error', text: composeError(d.detail || 'Claude Code stopped working', { secretLike: this.secretLike }) });
      }
      case 'notify': {
        // notify_user {speak:true}: Claude asked for this to be said (only voice.tts 'off' mutes it).
        if (d.speak !== true || !this.enabled('info', { force: true })) return null;
        const text = truncate(safeSpeech(stripMarkdownForSpeech(String(d.text || '')), this.secretLike), 600);
        if (!text) return null;
        return this.enqueue({ kind: d.level === 'error' ? 'error' : 'info', text, chime: false });
      }
      case 'error':
        if (!this.enabled('error')) return null;
        if (d.id && !this.once(`error:${d.id}`)) return null;
        return this.enqueue({ kind: 'error', text: composeError(d.message || d.text || d.error || '', { secretLike: this.secretLike }) });
      default:
        return null;
    }
  }

  /** @private */
  onResult(r) {
    const tools = this.toolsThisTurn;
    this.toolsThisTurn = 0;
    const key = `result:${r.sessionId || ''}:${(r.commandIds || []).join(',')}:${r.totalCostUsd || 0}:${r.durationMs || 0}:${String(r.text || '').length}`;
    if (!this.once(key)) return null;
    if (r.interrupted) return null; // the user pressed Stop
    if (r.speak === false) return null; // bridge reply --no-speak
    if (r.isError) {
      if (!this.enabled('error')) return null;
      return this.enqueue({ kind: 'error', text: composeError(r.text || String(r.subtype || 'the task failed').replace(/_/g, ' '), { secretLike: this.secretLike }) });
    }
    if (!this.enabled('done')) return null;
    // switch_project: the work goes on in another folder; the new session's result says "done".
    if (r.handoff && r.handoff.dir) return this.enqueue({ kind: 'info', text: `Switching to ${folderName(r.handoff.dir)} to continue.`, chime: false });
    const ms = Number(r.durationMs) || 0;
    if (tools === 0 && ms < this.minQuietTurnMs) return null; // a quick answer: the dialog shows it
    return this.enqueue({ kind: 'done', text: composeDone(r, { opener: this.opener(), secretLike: this.secretLike }) });
  }

  /** @private */
  enqueue(item) {
    const entry = { id: `an_${uuid()}`, ts: nowIso(), ...item };
    this.queue.push(entry);
    while (this.queue.length > MAX_QUEUE) {
      // Drop the oldest that is not a card waiting for the user, else the oldest.
      const i = this.queue.findIndex((q) => !q.card);
      this.queue.splice(i >= 0 ? i : 0, 1);
    }
    this.pump();
    return entry;
  }

  /** @private play queued announcements one after another */
  pump() {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = this.deliver(next)
      .then((out) => {
        log.info(`announcement ${next.kind}: ${out.delivered}${out.engine ? ` (${out.engine})` : ''}${out.error ? `: ${out.error}` : ''}`);
        log.debug(`announced: ${next.text}`);
      })
      .catch((err) => log.warn(`announcement failed: ${err.message}`))
      .finally(() => {
        this.running = null;
        if (!this.stopped) this.pump();
      });
  }

  /** Drop announcements that have not started (the user spoke, typed or pressed Stop). */
  cancelPending() {
    this.queue.length = 0;
  }

  /** @private a card answered while earlier announcements played */
  answered(card) {
    if (!card || !this.findCard) return false;
    try {
      return this.findCard(card.kind, card.id) === null;
    } catch {
      return false;
    }
  }

  /**
   * Say one announcement: to the visible dialog, else through the OS.
   * @param {{id:string, kind:string, text:string, ts:string, card?:object}} item
   * @returns {Promise<{delivered:'dialog'|'local'|'none'|'skipped', engine?:string|null, error?:string}>}
   */
  async deliver(item) {
    if (this.answered(item.card)) return { delivered: 'skipped' };
    const v = this.voiceCfg;
    let info = { engine: null };
    if (this.voice && typeof this.voice.engineInfo === 'function') {
      try {
        info = await this.voice.engineInfo();
      } catch (err) {
        log.debug(`voice engine lookup failed: ${err.message}`);
      }
    }
    const payload = { id: item.id, kind: KINDS.includes(item.kind) ? item.kind : 'info', text: item.text, audio: null, chime: item.chime !== false && v.chime !== false, ts: item.ts };
    // "System voice" chosen explicitly: the OS speaks even while the dialog is visible (the page
    // would use a browser voice). Automatic with no Piper lets the page pick its most natural voice.
    const osVoice = info.setting === 'os' && info.engine === 'os';
    if (!osVoice && this.dialogVisible()) {
      if (info.engine === 'piper' && this.voice && typeof this.voice.synthesize === 'function') {
        try {
          const s = await this.voice.synthesize(item.text);
          payload.audio = { id: s.id, mime: s.mime || 'audio/wav', durationMs: s.durationMs };
        } catch (err) {
          log.warn(`the neural voice could not render the announcement (${err.message}); the dialog will use its own voice`);
        }
      }
      if (this.answered(item.card)) return { delivered: 'skipped' };
      this.hub.broadcast('announce', payload);
      return { delivered: 'dialog', engine: info.engine };
    }
    if (!this.voice || info.engine === 'browser' || info.engine === null) {
      return { delivered: 'none', engine: info.engine, ...(info.engine === null ? { error: 'no voice is available' } : {}) };
    }
    if (payload.chime && typeof this.voice.playFile === 'function') {
      try {
        await this.voice.playFile(this.chimeFile(payload.kind));
      } catch (err) {
        log.debug(`chime failed: ${err.message}`);
      }
    }
    if (this.answered(item.card) || this.stopped) return { delivered: 'skipped' };
    try {
      const r = await this.voice.speak(item.text, { rate: v.ttsRate, voice: v.ttsVoice || undefined });
      if (r && r.ok === false) return { delivered: 'none', engine: info.engine, error: r.error };
      return { delivered: 'local', engine: (r && r.provider) || info.engine };
    } catch (err) {
      log.warn(`speaking the announcement failed: ${err.message}`);
      return { delivered: 'none', engine: info.engine, error: err.message };
    }
  }

  /**
   * Play a sample through the announce path (POST /api/voice/test). Ignores the announce toggles.
   * @param {string} [text]
   * @returns {Promise<{ok:boolean, delivered:string, engine?:string|null, text:string, error?:string}>}
   */
  async test(text) {
    const t = String(text || '').trim() || "Hi! This is how I'll sound when your work is done or when I need you.";
    const item = { id: `an_${uuid()}`, ts: nowIso(), kind: 'info', text: truncate(t, 600) };
    if (!this.enabled('info', { force: true })) return { ok: false, delivered: 'none', text: item.text, error: 'Text-to-speech is turned off (voice.tts is "off")' };
    const out = await this.deliver(item);
    return { ok: out.delivered === 'dialog' || out.delivered === 'local', ...out, text: item.text };
  }
}

function defaultChimeFile(kind) {
  return require('./chime').chimeFile(kind);
}

module.exports = {
  Announcer,
  KINDS,
  DONE_OPENERS,
  MIN_QUIET_TURN_MS,
  composeDone,
  composeError,
  composePermission,
  composeQuestion,
  humanizeAction,
  humanizeCommand,
  spokenOption,
  spokenQuestion,
  firstSentences,
  safeSpeech,
  shortPath,
};
