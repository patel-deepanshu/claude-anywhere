'use strict';

/**
 * Permission policy for Claude Anywhere.
 *
 * classify() gives every tool call a risk level (low, medium, high,
 * critical), a human reason and a one-line summary for the approval card.
 * Shell commands are split into their parts (&&, ||, ;, |, newlines, $( ),
 * backticks, heredocs) and the riskiest part wins.
 *
 * PermissionBroker combines the risk with the permission mode and the user's
 * rules. When the user has to decide, it shows an approval card in the dialog
 * and waits (with a timeout) for allow / allow for this session / deny.
 * Every decision is written to the audit log.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const logMod = require('../shared/log');
const { uuid, truncate, isPlainObject, escapeRegExp } = require('../shared/util');

const log = logMod.createLogger('permissions');

const RISKS = ['low', 'medium', 'high', 'critical'];
const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const MODES = ['ask', 'smart', 'auto'];
// How the user answered an approval card (POST /api/approval `via`): dialog button, Enter/Esc on
// the card, typed in the terminal dialog, or spoken.
const APPROVAL_VIA = ['click', 'key', 'typed', 'voice'];
const MODE_MAX = { ask: 'low', smart: 'medium', auto: 'high' };
const DEFAULT_TIMEOUT_SEC = 600;
// The engine's MCP config gives the anywhere server a timeout of 86400 s + 60 s, so the
// broker's deadline must stay below it (the dialog's Settings input has the same max).
const MAX_TIMEOUT_SEC = 86400;
const MAX_DEPTH = 4;

const SHELL_TOOLS = { Bash: 'bash', PowerShell: 'powershell' };
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'LS']);
const LOW_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'Task',
  'Agent',
  'ToolSearch',
  'Skill',
  'NotebookRead',
  'ExitPlanMode',
  'EnterPlanMode',
  'BashOutput',
  'KillShell',
  'KillBash',
  'AskUserQuestion',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
  'TaskOutput',
  'Monitor',
]);

const ANYWHERE_LOW = new Set([
  'screenshot',
  'cursor_position',
  'screen_info',
  'list_windows',
  'get_desktop_context',
  'wait',
  'notify_user',
  'ask_user',
  'clipboard_get',
  'permission_prompt',
]);
const ANYWHERE_MEDIUM = new Set(['click', 'mouse_move', 'drag', 'scroll', 'focus_window', 'open', 'clipboard_set', 'key', 'type_text']);

// ------------------------------------------------------------------ small helpers

function V(risk, reason) {
  return { risk, reason };
}

function maxVerdict(a, b) {
  if (!b) return a;
  if (!a) return b;
  return RANK[b.risk] > RANK[a.risk] ? b : a;
}

/** @returns {'low'|'medium'|'high'|'critical'} the higher of two risks */
function maxRisk(a, b) {
  return RANK[b] > RANK[a] ? b : a;
}

function oneLine(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim();
}

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function humanize(name) {
  const s = String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function normalizeMode(mode) {
  const m = String(mode || '')
    .toLowerCase()
    .trim();
  if (m === 'autopilot') return 'auto';
  return MODES.includes(m) ? m : 'smart';
}

/**
 * Does a permission mode let a risk level run without asking?
 * @param {'ask'|'smart'|'auto'} mode
 * @param {'low'|'medium'|'high'|'critical'} risk
 * @returns {boolean}
 */
function modeAllows(mode, risk) {
  return RANK[risk] <= RANK[MODE_MAX[normalizeMode(mode)]];
}

// ------------------------------------------------------------------ shell splitting

const SHELL_SYNTAX = {
  bash: {
    backslash: true,
    backtickSubst: true,
    backtickEscape: false,
    caret: false,
    single: true,
    braces: false,
    heredoc: true,
    procSubst: true,
    comments: true,
  },
  powershell: {
    backslash: false,
    backtickSubst: false,
    backtickEscape: true,
    caret: false,
    single: true,
    braces: true,
    heredoc: false,
    procSubst: false,
    comments: true,
  },
  cmd: {
    backslash: false,
    backtickSubst: false,
    backtickEscape: false,
    caret: true,
    single: false,
    braces: false,
    heredoc: false,
    procSubst: false,
    comments: false,
  },
};

/**
 * Split a shell command into its simple commands, with pipeline and heredoc
 * information. Quote aware: nothing splits inside single quotes, and inside
 * double quotes only $( ) and backticks start a nested command.
 * @param {string} command
 * @param {'bash'|'powershell'|'cmd'} [shell]
 * @returns {{text:string, start:number, heredocs:{delim:string, body:string}[], pipeline:number, pipeIndex:number, nested:boolean}[]}
 */
function splitDetailed(command, shell = 'bash') {
  const o = SHELL_SYNTAX[shell] || SHELL_SYNTAX.bash;
  const s = String(command == null ? '' : command);
  const out = [];
  const pendingHeredocs = [];
  let pipelineSeq = 0;

  /**
   * For `$((` at `start`: the index of the final `)` when this is really arithmetic, i.e. the
   * inner `(` closes right before the outer one (`$(( … ))`); else -1 (`$((cmd) )` is a command
   * substitution holding a subshell).
   */
  function arithmeticEnd(start) {
    let d = 0;
    let innerClose = -1;
    for (let j = start + 1; j < s.length; j += 1) {
      if (s[j] === '(') d += 1;
      else if (s[j] === ')') {
        d -= 1;
        if (d === 1 && innerClose === -1) innerClose = j;
        if (d === 0) return innerClose === j - 1 ? j : -1;
      }
    }
    return -1;
  }

  function readHeredocBodies(pos) {
    for (const h of pendingHeredocs.splice(0)) {
      const lines = [];
      while (pos < s.length) {
        let eol = s.indexOf('\n', pos);
        if (eol === -1) eol = s.length;
        let line = s.slice(pos, eol);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        pos = eol + 1;
        const cmp = h.dash ? line.replace(/^\t+/, '') : line;
        if (cmp === h.delim || cmp.trim() === h.delim) break;
        lines.push(line);
      }
      h.owner.heredocs.push({ delim: h.delim, body: lines.join('\n') });
    }
    return pos;
  }

  function scan(start, closer, nested) {
    let i = start;
    let pipeline = pipelineSeq++;
    let pipeIndex = 0;
    let part = { text: '', start: i, heredocs: [], pipeline, pipeIndex, nested };
    let quote = null;
    let depth = 0;
    const push = (pipeNext) => {
      part.text = part.text.trim();
      if (part.text || part.heredocs.length) out.push(part);
      if (pipeNext) pipeIndex += 1;
      else {
        pipeline = pipelineSeq++;
        pipeIndex = 0;
      }
      part = { text: '', start: i, heredocs: [], pipeline, pipeIndex, nested };
    };
    while (i < s.length) {
      const c = s[i];
      const n = s[i + 1];
      if (quote === "'") {
        part.text += c;
        if (c === "'") quote = null;
        i += 1;
        continue;
      }
      if (o.backslash && c === '\\') {
        if (n === '\n') {
          i += 2;
          continue;
        }
        part.text += c + (n === undefined ? '' : n);
        i += 2;
        continue;
      }
      if (o.backtickEscape && c === '`') {
        if (n === '\n') {
          i += 2;
          continue;
        }
        part.text += c + (n === undefined ? '' : n);
        i += 2;
        continue;
      }
      if (o.caret && c === '^' && quote !== '"') {
        part.text += c + (n === undefined ? '' : n);
        i += 2;
        continue;
      }
      if (c === '$' && n === '(') {
        const arithEnd = s[i + 2] === '(' && shell === 'bash' ? arithmeticEnd(i) : -1;
        if (arithEnd !== -1) {
          // $(( arithmetic )) is data, but bash still runs every $( ) and backtick inside it
          // (CLASSIFIER-R3-01): those are commands, scanned like any other substitution.
          part.text += '$((';
          let k = i + 3;
          while (k < arithEnd - 1) {
            if (s[k] === '$' && s[k + 1] === '(' && s[k + 2] !== '(') {
              part.text += '$(…)';
              k = scan(k + 2, ')', true);
            } else if (s[k] === '`') {
              part.text += '`…`';
              k = scan(k + 1, '`', true);
            } else {
              part.text += s[k];
              k += 1;
            }
          }
          if (k <= arithEnd - 1) {
            part.text += '))';
            i = arithEnd + 1;
          } else i = k;
          continue;
        }
        // `$((cmd) )` is a command substitution holding a subshell, not arithmetic; and in
        // PowerShell `$((…))` is a subexpression: both run commands.
        part.text += '$(…)';
        i = scan(i + 2, ')', true);
        continue;
      }
      if (o.backtickSubst && c === '`') {
        if (closer === '`') {
          push(false);
          return i + 1;
        }
        part.text += '`…`';
        i = scan(i + 1, '`', true);
        continue;
      }
      if (quote === '"') {
        part.text += c;
        if (c === '"') quote = null;
        i += 1;
        continue;
      }
      // ---- unquoted
      if (closer === ')' && c === ')' && depth === 0) {
        push(false);
        return i + 1;
      }
      if (closer === '}' && c === '}' && depth === 0) {
        push(false);
        return i + 1;
      }
      if (shell === 'powershell' && c === '@' && (n === "'" || n === '"') && /^\r?\n/.test(s.slice(i + 2))) {
        // PowerShell here-string: data up to a line starting with '@ or "@
        const endRe = n === "'" ? /\r?\n'@/g : /\r?\n"@/g;
        endRe.lastIndex = i + 2;
        const m = endRe.exec(s);
        const end = m ? m.index + m[0].length : s.length;
        part.text += `${n}${s.slice(i + 2, m ? m.index : s.length).replace(/[\r\n]+/g, ' ')}${n}`;
        i = end;
        continue;
      }
      if (c === "'" && o.single) {
        quote = "'";
        part.text += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        quote = '"';
        part.text += c;
        i += 1;
        continue;
      }
      if (o.procSubst && (c === '<' || c === '>') && n === '(') {
        part.text += `${c}(…)`;
        i = scan(i + 2, ')', true);
        continue;
      }
      if (o.braces && c === '{') {
        if (s[i - 1] === '$') {
          // PowerShell ${variable} syntax
          const j = s.indexOf('}', i);
          const end = j === -1 ? s.length : j + 1;
          part.text += s.slice(i, end);
          i = end;
          continue;
        }
        part.text += '{…}';
        i = scan(i + 1, '}', true);
        continue;
      }
      if (shell === 'powershell' && c === '(' && !/(\.|::)\s*[A-Za-z_]\w*$/.test(part.text)) {
        // PowerShell runs a parenthesized pipeline wherever it appears: `Write-Output (Remove-Item
        // …)`, `(New-Object …).Run(…)`, `if (…)`. Only a method call's argument list is data.
        const end = scan(i + 1, ')', true);
        // The source of each (…), in order, so a receiver like `(Get-Item $HOME).Delete()` can be read.
        (part.parens || (part.parens = [])).push(s.slice(i + 1, Math.max(i + 1, end - 1)));
        part.text += '(…)';
        i = end;
        continue;
      }
      if (c === '(') {
        depth += 1;
        part.text += c;
        i += 1;
        continue;
      }
      if (c === ')') {
        if (depth > 0) depth -= 1;
        part.text += c;
        i += 1;
        continue;
      }
      if (o.heredoc && c === '<' && n === '<' && s[i + 2] !== '<') {
        let j = i + 2;
        let dash = false;
        if (s[j] === '-') {
          dash = true;
          j += 1;
        }
        while (s[j] === ' ' || s[j] === '\t') j += 1;
        let delim = '';
        let q = null;
        let k = j;
        while (k < s.length) {
          const ch = s[k];
          if (q) {
            if (ch === q) q = null;
            else delim += ch;
            k += 1;
            continue;
          }
          if (ch === "'" || ch === '"') {
            q = ch;
            k += 1;
            continue;
          }
          if (ch === '\\') {
            delim += s[k + 1] || '';
            k += 2;
            continue;
          }
          if (/[\s;&|<>()]/.test(ch)) break;
          delim += ch;
          k += 1;
        }
        if (delim) {
          pendingHeredocs.push({ delim, dash, owner: part });
          part.text += s.slice(i, k);
          i = k;
          continue;
        }
      }
      if (c === '&' && n === '&') {
        push(false);
        i += 2;
        continue;
      }
      if (c === '|' && n === '|') {
        push(false);
        i += 2;
        continue;
      }
      if (c === '|') {
        push(true);
        i += n === '&' ? 2 : 1;
        continue;
      }
      if (c === ';') {
        push(false);
        i += 1;
        continue;
      }
      if (c === '\n' || c === '\r') {
        push(false);
        i += 1;
        if (c === '\r' && s[i] === '\n') i += 1;
        if (pendingHeredocs.length) i = readHeredocBodies(i);
        continue;
      }
      if (c === '&') {
        if (/[<>]$/.test(part.text) || n === '>') {
          part.text += c;
          i += 1;
          continue;
        }
        if (shell === 'powershell' && (!part.text.trim() || /=\s*$/.test(part.text))) {
          // the call operator: & "C:\path\tool.exe" args, also as a value: $out = & $tool
          part.callOp = true;
          i += 1;
          continue;
        }
        push(false);
        i += 1;
        continue;
      }
      part.text += c;
      i += 1;
    }
    push(false);
    return i;
  }

  scan(0, null, false);
  if (pendingHeredocs.length) readHeredocBodies(s.length);
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Split a compound shell command into its simple commands.
 * @param {string} command
 * @param {{shell?:'bash'|'powershell'|'cmd'}} [opts]
 * @returns {string[]}
 */
function splitCommands(command, opts = {}) {
  return splitDetailed(command, opts.shell || 'bash')
    .map((p) => p.text)
    .filter(Boolean);
}

/**
 * Word-split one simple command (quotes removed) and pull out redirections.
 * @returns {{argv:string[], redirects:{op:string,target:string|null,write:boolean}[], herestrings:string[]}}
 */
function tokenize(text, shell = 'bash', platform = process.platform) {
  const o = SHELL_SYNTAX[shell] || SHELL_SYNTAX.bash;
  const win = platform === 'win32';
  const toks = [];
  let cur = null;
  let quoted = false;
  let q = null;
  const flush = () => {
    if (cur !== null) toks.push({ v: cur, quoted });
    cur = null;
    quoted = false;
  };
  const add = (x) => {
    cur = (cur === null ? '' : cur) + x;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (q === "'") {
      if (c === "'") {
        if (shell === 'powershell' && n === "'") {
          add("'");
          i += 1;
        } else q = null;
      } else add(c);
      continue;
    }
    if (shell === 'bash' && c === '$' && n === '(' && text[i + 2] === '(') {
      // `$(( 1 + x ))` is one word, spaces and all (its commands were split out already).
      let d = 0;
      let j = i + 1;
      for (; j < text.length; j += 1) {
        if (text[j] === '(') d += 1;
        else if (text[j] === ')' && --d === 0) break;
      }
      if (j < text.length) {
        add(text.slice(i, j + 1));
        i = j;
        continue;
      }
    }
    if (q === '"') {
      if (c === '"') {
        if (shell === 'powershell' && n === '"') {
          add('"');
          i += 1;
        } else q = null;
        continue;
      }
      if (o.backslash && c === '\\' && n !== undefined && '"\\$`\n'.includes(n)) {
        add(n);
        i += 1;
        continue;
      }
      if (o.backtickEscape && c === '`' && n !== undefined) {
        add(n);
        i += 1;
        continue;
      }
      add(c);
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      flush();
      continue;
    }
    if (c === "'" && o.single) {
      add('');
      quoted = true;
      q = "'";
      continue;
    }
    if (c === '"') {
      add('');
      quoted = true;
      q = '"';
      continue;
    }
    if (o.backslash && c === '\\') {
      if (n === undefined || (win && /[A-Za-z0-9_.$%*-]/.test(n))) add(c);
      else {
        add(n);
        i += 1;
      }
      continue;
    }
    if (o.backtickEscape && c === '`') {
      if (n !== undefined) {
        add(n);
        i += 1;
      }
      continue;
    }
    if (o.caret && c === '^') {
      if (n !== undefined) {
        add(n);
        i += 1;
      }
      continue;
    }
    if (c === '>' || c === '<') {
      let prefix = '';
      if (cur !== null && !quoted && /^(\d+|&|\*)$/.test(cur)) {
        prefix = cur;
        cur = null;
        quoted = false;
      } else flush();
      const m = /^(<<<|<<-|<<|<>|>>|>\||>&|<&|>|<)/.exec(text.slice(i));
      const op = prefix + m[1];
      i += m[1].length - 1;
      let fd = null;
      if (/[<>]&$/.test(m[1])) {
        const fm = /^(\d+-?|-)/.exec(text.slice(i + 1));
        if (fm) {
          fd = fm[1];
          i += fm[1].length;
        }
      }
      toks.push({ v: op, op: true, fd });
      continue;
    }
    if (o.comments && c === '#' && cur === null) break;
    add(c);
  }
  flush();
  const argv = [];
  const redirects = [];
  const herestrings = [];
  for (let k = 0; k < toks.length; k += 1) {
    const t = toks[k];
    if (!t.op) {
      argv.push(t.v);
      continue;
    }
    if (t.fd != null) continue;
    const next = toks[k + 1] && !toks[k + 1].op ? toks[k + 1].v : null;
    if (next !== null) k += 1;
    if (t.v.includes('<<<')) {
      if (next !== null) herestrings.push(next);
      continue;
    }
    if (t.v.includes('<<')) continue;
    redirects.push({ op: t.v, target: next, write: t.v.includes('>') });
  }
  return { argv, redirects, herestrings };
}

// ------------------------------------------------------------------ command normalization

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', '!', '{', '(', 'fi', 'done', 'esac', 'function']);
const ELEVATORS = new Set(['sudo', 'doas', 'pkexec', 'gsudo', 'run0', 'sudo-rs']);

/** Lower-cased program name without directory and Windows executable extension. */
function progName(word) {
  const w = String(word || '').replace(/^[({!]+/, '');
  const base = w.split(/[\\/]/).pop() || w;
  return base.toLowerCase().replace(/\.(exe|com|cmd|bat)$/i, '');
}

function skipOpts(argv, start, withValue = new Set(), { extra = 0 } = {}) {
  let i = start;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      i += 1;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    i += withValue.has(a) ? 2 : 1;
  }
  i += extra;
  return i < argv.length ? i : 0;
}

function afterDoubleDash(argv) {
  const k = argv.indexOf('--');
  return k > 0 && k < argv.length - 1 ? k + 1 : 0;
}

const WRAPPERS = {
  nohup: (a) => skipOpts(a, 1),
  command: (a) => (a[1] === '-v' || a[1] === '-V' ? 0 : skipOpts(a, 1)),
  builtin: (a) => skipOpts(a, 1),
  exec: (a) => skipOpts(a, 1, new Set(['-a'])),
  noglob: (a) => skipOpts(a, 1),
  nice: (a) => skipOpts(a, 1, new Set(['-n', '--adjustment'])),
  ionice: (a) => skipOpts(a, 1, new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'])),
  timeout: (a) => skipOpts(a, 1, new Set(['-s', '-k', '--signal', '--kill-after']), { extra: 1 }),
  gtimeout: (a) => skipOpts(a, 1, new Set(['-s', '-k', '--signal', '--kill-after']), { extra: 1 }),
  stdbuf: (a) => skipOpts(a, 1, new Set(['-i', '-o', '-e'])),
  chronic: (a) => skipOpts(a, 1),
  unbuffer: (a) => skipOpts(a, 1),
  caffeinate: (a) => skipOpts(a, 1, new Set(['-t', '-w'])),
  'xvfb-run': (a) => skipOpts(a, 1, new Set(['-n', '-s', '-f', '-e', '-p', '--server-args', '--server-num'])),
  npx: (a) => skipOpts(a, 1, new Set(['-p', '--package'])),
  pnpx: (a) => skipOpts(a, 1, new Set(['-p', '--package'])),
  bunx: (a) => skipOpts(a, 1, new Set(['-p', '--package'])),
  uvx: (a) => skipOpts(a, 1, new Set(['--from', '--with', '-p', '--python'])),
  doppler: (a) => (a[1] === 'run' ? afterDoubleDash(a) : 0),
  op: (a) => (a[1] === 'run' ? afterDoubleDash(a) : 0),
  infisical: (a) => (a[1] === 'run' ? afterDoubleDash(a) : 0),
  dotenv: (a) => afterDoubleDash(a),
  'aws-vault': (a) => (a[1] === 'exec' ? afterDoubleDash(a) : 0),
  npm: (a) => (a[1] === 'exec' || a[1] === 'x' ? skipOpts(a, 2, new Set(['-p', '--package', '-c', '--call'])) : 0),
  pnpm: (a) => (a[1] === 'dlx' || a[1] === 'exec' ? skipOpts(a, 2) : 0),
  yarn: (a) => (a[1] === 'dlx' || a[1] === 'exec' ? skipOpts(a, 2) : 0),
  bundle: (a) => (a[1] === 'exec' ? skipOpts(a, 2) : 0),
  poetry: (a) => (a[1] === 'run' ? skipOpts(a, 2) : 0),
  pipenv: (a) => (a[1] === 'run' ? skipOpts(a, 2) : 0),
  pdm: (a) => (a[1] === 'run' ? skipOpts(a, 2) : 0),
  hatch: (a) => (a[1] === 'run' ? skipOpts(a, 2) : 0),
  rye: (a) => (a[1] === 'run' ? skipOpts(a, 2) : 0),
  uv: (a) => (a[1] === 'run' ? skipOpts(a, 2, new Set(['--with', '--python', '-p', '--project', '--directory', '--env-file'])) : 0),
  conda: (a) => (a[1] === 'run' ? skipOpts(a, 2, new Set(['-n', '--name', '-p', '--prefix'])) : 0),
  pipx: (a) => (a[1] === 'run' ? skipOpts(a, 2, new Set(['--spec', '--python'])) : 0),
};

const SUDO_VALUE_OPTS = new Set([
  '-u',
  '-g',
  '-h',
  '-p',
  '-C',
  '-r',
  '-t',
  '-U',
  '-T',
  '-D',
  '--user',
  '--group',
  '--host',
  '--prompt',
  '--chdir',
  '--role',
  '--type',
  '--other-user',
  '--close-from',
  '--command-timeout',
]);

/**
 * Strip wrappers (env assignments, sudo, nohup, timeout, npx, …) so the
 * command that actually runs comes first.
 * @param {string[]} argv0
 * @param {string} shell
 * @returns {{argv:string[], sudo:string|null, sudoShell:boolean, sudoEdit:boolean, wrappers:string[], env:object}}
 */
function unwrap(argv0, shell = 'bash') {
  let argv = argv0.slice();
  let sudo = null;
  let sudoShell = false;
  let sudoEdit = false;
  const env = {};
  const wrappers = [];
  for (let guard = 0; guard < 24 && argv.length; guard += 1) {
    while (argv.length && (/^[({!]+$/.test(argv[0]) || argv[0] === '')) argv.shift();
    if (!argv.length) break;
    if (/^[({]+/.test(argv[0])) argv[0] = argv[0].replace(/^[({]+/, '');
    while (argv.length && /^[)}]+;?$/.test(argv[argv.length - 1])) argv.pop();
    if (argv.length && !argv[argv.length - 1].includes('$(') && /[^)(]\)+$/.test(argv[argv.length - 1])) {
      argv[argv.length - 1] = argv[argv.length - 1].replace(/\)+$/, '');
    }
    if (!argv.length) break;
    if (shell === 'powershell') {
      // `$x = Remove-Item …`, `[int]$n += (…)`: the value is what runs. A leading cast
      // (`[void](…)`, `[void]$x.Delete()`) only converts the result.
      const a0 = argv[0];
      const cast = /^(\[[\w.`, [\]]*?\])+(?!:)/.exec(a0);
      if (cast && !/^\[[^\]]*\]\s*::/.test(a0) && (cast[0].length < a0.length || argv.length > 1)) {
        if (cast[0].length < a0.length) argv[0] = a0.slice(cast[0].length);
        else argv.shift();
        continue;
      }
      const asg = /^\$(\{[^}]+\}|[\w:]+)([+\-*/%?]?=)(.*)$/.exec(a0);
      if (asg) {
        if (asg[3]) argv[0] = asg[3];
        else argv.shift();
        continue;
      }
      if (/^\$(\{[^}]+\}|[\w:]+)$/.test(a0) && /^[+\-*/%?]?=$/.test(argv[1] || '')) {
        argv.splice(0, 2);
        continue;
      }
    }
    const w = argv[0];
    const p = progName(w);
    if (shell !== 'powershell' && ASSIGN_RE.test(w)) {
      const eq = w.indexOf('=');
      env[w.slice(0, eq)] = w.slice(eq + 1);
      argv.shift();
      continue;
    }
    if (KEYWORDS.has(w)) {
      argv.shift();
      continue;
    }
    if (p === 'env' && shell !== 'powershell') {
      let i = 1;
      while (i < argv.length) {
        const a = argv[i];
        if (a === '--') {
          i += 1;
          break;
        }
        if (a === '-u' || a === '--unset' || a === '-C' || a === '--chdir') i += 2;
        else if (a === '-S' || a === '--split-string') {
          // env -S "cmd args": the string is the command
          const rest = argv.slice(i + 1);
          argv = [
            ...String(rest[0] || '')
              .split(/\s+/)
              .filter(Boolean),
            ...rest.slice(1),
          ];
          i = -1;
          break;
        } else if (a.startsWith('-')) i += 1;
        else if (ASSIGN_RE.test(a)) {
          const eq = a.indexOf('=');
          env[a.slice(0, eq)] = a.slice(eq + 1);
          i += 1;
        } else break;
      }
      if (i === -1) {
        wrappers.push('env');
        continue;
      }
      if (i >= argv.length) break; // bare `env` prints the environment
      wrappers.push('env');
      argv = argv.slice(i);
      continue;
    }
    if (ELEVATORS.has(p)) {
      sudo = sudo || p;
      let i = 1;
      while (i < argv.length) {
        const a = argv[i];
        if (a === '--') {
          i += 1;
          break;
        }
        if (!a.startsWith('-')) break;
        if (a === '-i' || a === '-s' || a === '--login' || a === '--shell') sudoShell = true;
        if (a === '-e' || a === '--edit') sudoEdit = true;
        i += SUDO_VALUE_OPTS.has(a) ? 2 : 1;
      }
      argv = argv.slice(i);
      if (!argv.length) sudoShell = true;
      continue;
    }
    if (p === 'sudoedit') {
      sudo = sudo || 'sudo';
      sudoEdit = true;
      break;
    }
    const wrap = WRAPPERS[p];
    if (wrap && shell !== 'powershell') {
      const skip = wrap(argv);
      if (skip > 0) {
        wrappers.push(p);
        argv = argv.slice(skip);
        continue;
      }
    }
    break;
  }
  return { argv, sudo, sudoShell, sudoEdit, wrappers, env };
}

/** The normalized text rules are matched against: wrappers and env stripped, sudo kept. */
function ruleTextOf(u) {
  const words = u.argv.map((a) => oneLine(a)).filter(Boolean);
  if (u.sudo) words.unshift(u.sudo);
  return words.join(' ');
}

// ------------------------------------------------------------------ paths

function classifyContext(opts = {}) {
  const platform = opts.platform || process.platform;
  const homeDir = opts.homeDir || os.homedir();
  const P = platform === 'win32' ? path.win32 : path.posix;
  const projectDir = opts.projectDir ? P.resolve(String(opts.projectDir)) : null;
  const real = platform === process.platform && !opts.noRealpath;
  const env = opts.env || process.env;
  const home = P.resolve(homeDir);
  const anywhereHome = env.ANYWHERE_HOME ? P.resolve(env.ANYWHERE_HOME) : null;
  const claudeHome = env.CLAUDE_CONFIG_DIR ? P.resolve(env.CLAUDE_CONFIG_DIR) : null;
  return {
    platform,
    homeDir: home,
    projectDir,
    projectReal: projectDir && real ? realish(projectDir) : projectDir,
    extraDirs: (Array.isArray(opts.extraDirs) ? opts.extraDirs : []).filter(Boolean).map((d) => P.resolve(String(d))),
    anywhereHome,
    claudeHome,
    // The same roots with symlinks resolved, to compare with a resolved target (realSensitiveKind).
    homeReal: real ? realish(home) : home,
    anywhereReal: anywhereHome && real ? realish(anywhereHome) : anywhereHome,
    claudeReal: claudeHome && real ? realish(claudeHome) : claudeHome,
    tmpDir: opts.tmpDir || (platform === process.platform ? os.tmpdir() : null),
    real,
    // The app of the focused window (type_text), when the broker could tell; null when unknown.
    focusedApp: typeof opts.focusedApp === 'string' && opts.focusedApp.trim() ? opts.focusedApp.trim() : null,
    // Its process name (cmd.exe, conhost, kgx) when the driver reports one.
    focusedProcess: typeof opts.focusedProcess === 'string' && opts.focusedProcess.trim() ? opts.focusedProcess.trim() : null,
    shell: 'bash',
    cwd: projectDir,
    depth: 0,
  };
}

/** realpath of the deepest existing ancestor, with the rest appended (best effort). */
function realish(p) {
  let cur = p;
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const r = fs.realpathSync.native(cur);
      return tail.length ? path.join(r, ...tail.reverse()) : r;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

const NULL_DEVICE_RE = /^(\/dev\/(null|zero|stdout|stderr|stdin|tty|fd\/\d+)|nul:?|\$null|con:?)$/i;
const DISK_DEVICE_RE =
  /^(\/dev\/(sd[a-z]|hd[a-z]|nvme\d|mmcblk\d|xvd[a-z]|vd[a-z]|disk\d|rdisk\d|md\d|dm-\d|mapper\/|loop\d|sr\d)|\\\\\.\\(physicaldrive\d|[a-z]:))/i;

/**
 * The plain form of a Windows path written through an alias Win32 accepts (WINDOWS-2-2):
 * `\\?\C:\x` and `\\.\C:\x` are `C:\x`, `\\?\UNC\h\s` is `\\h\s`, the loopback admin share
 * `\\localhost\C$\x` is `C:\x`, and trailing dots and spaces of a component are dropped (Win32
 * strips them). null when it cannot be known: other device paths (`\\?\GLOBALROOT`, volume GUIDs,
 * pipes) and alternate data streams (`file:stream`).
 * @param {string} s a path with backslashes
 * @returns {string|null}
 */
function win32Canonical(s) {
  let p = s;
  const dev = /^\\\\[?.]\\(.*)$/.exec(p);
  if (dev) {
    const rest = dev[1];
    if (/^[a-zA-Z]:(\\|$)/.test(rest)) p = rest;
    else if (/^unc\\/i.test(rest)) p = `\\\\${rest.slice(4)}`;
    else return null;
  }
  const loop = /^\\\\([^\\]+)\\([a-zA-Z])\$(\\.*)?$/.exec(p);
  if (loop) {
    const host = loop[1].toLowerCase().replace(/^\[|\]$/g, '');
    let self = false;
    try {
      self = process.platform === 'win32' && host === os.hostname().toLowerCase();
    } catch {
      self = false;
    }
    if (host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0:0:0:0:0:0:0:1' || self) {
      p = `${loop[2].toUpperCase()}:${loop[3] || '\\'}`;
    }
  }
  // An alternate data stream (a ":" after the drive) names data the path checks cannot see.
  if (/:/.test(p.replace(/^[a-zA-Z]:/, ''))) return null;
  const head = /^([a-zA-Z]:\\?|\\\\[^\\]+\\[^\\]+\\?)/.exec(p);
  const prefix = head ? head[0] : '';
  const parts = p
    .slice(prefix.length)
    .split('\\')
    .map((c) => (c === '.' || c === '..' ? c : c.replace(/[. ]+$/, '')));
  return prefix + parts.join('\\');
}

/**
 * A credential folder named in a path that could not be resolved ($VAR, %VAR%, a device path):
 * judged by its segments alone, wherever the home folder is.
 */
function credentialSegments(raw) {
  const segs = String(raw || '')
    .toLowerCase()
    .split(/[\\/]+/)
    .map((x) => x.replace(/[. ]+$/, '') || x);
  for (let i = 0; i < segs.length; i += 1) {
    const sg = segs[i];
    const next = segs[i + 1];
    if (sg === '.ssh') return { what: 'your SSH keys and config', env: false };
    if (sg === '.aws') return { what: 'your AWS credentials', env: false };
    if (sg === '.azure') return { what: 'your Azure credentials', env: false };
    if (sg === '.kube') return { what: 'your Kubernetes credentials', env: false };
    if (sg === '.gnupg' || sg === '.password-store') return { what: 'your GPG keys or password store', env: false };
    if (sg === '.config' && ['gcloud', 'gh', 'op', 'rclone', 'hub', 'doctl'].includes(next)) return { what: 'CLI login tokens', env: false };
    if ((sg === '.cargo' || sg === '.gem') && /^credentials(\.toml)?$/.test(next || '')) return { what: 'a file with login tokens', env: false };
    if (sg === '.local' && next === 'share' && ['keyrings', 'kwalletd'].includes(segs[i + 2])) return { what: 'your keyring (saved passwords)', env: false };
    if (sg === 'library' && next === 'keychains') return { what: 'your keychain (saved passwords)', env: false };
    if (sg === '.claude-anywhere' && ['config.json', 'daemon.json'].includes(next)) return { what: 'a Claude Anywhere file that holds keys or tokens', env: false };
    // F3-SAFE-D1: the run files (MCP configs with the daemon token) and a call engine's files.
    if (sg === '.claude-anywhere' && next === 'run' && (i + 2 === segs.length - 1 ? /\.json$|[*?[]/.test(segs[i + 2] || '') : i + 2 < segs.length)) {
      return { what: 'a Claude Anywhere run file that holds its access token', env: false };
    }
    if (sg === '.claude-anywhere' && next === 'calls' && segs[i + 3] === 'engine') return { what: "a call engine's files, which hold the Claude Anywhere access token", env: false };
    if (/^(\.pgpass|\.mylogin\.cnf|\.vault-token|\.git-credentials|\.netrc|_netrc)$/.test(sg) && i === segs.length - 1)
      return { what: 'a file with login tokens or passwords', env: false };
  }
  return null;
}

// Browser profile files that hold saved passwords, cookies (live sessions) or their keys.
const BROWSER_SECRET_FILE = /^(cookies|cookies-journal|login data|login data-journal|login data for account|web data|logins\.json|key[34]\.db|cookies\.sqlite|signons\.sqlite|local state)$/i;
const BROWSER_PROFILE_DIR =
  /[\\/](google-chrome(-beta|-unstable)?|chromium|google[\\/]chrome( beta| canary| dev)?|bravesoftware|microsoft-edge(-beta|-dev)?|microsoft[\\/]edge|vivaldi|opera( software)?|\.mozilla|mozilla[\\/]firefox|firefox|librewolf|waterfox|thorium|arc)[\\/]/i;
const HISTORY_FILE = /^(\.(bash|zsh|sh|ksh|fish|python|node_repl|psql|mysql|sqlite|rediscli|irb|php)_history|\.zhistory|\.histfile|consolehost_history\.txt|fish_history)$/i;

/**
 * credentialKind for a path being read: the path as written, where it really points (symlinks,
 * 8.3 short names on Windows), and, when it cannot be resolved, its folder names.
 */
function readCredentialKind(raw, ctx, cwd) {
  const t = resolveTarget(raw, ctx, cwd);
  if (!t) return credentialSegments(raw);
  const cred = credentialKind(t, ctx);
  if (cred || !ctx.real) return cred;
  const real = realOf(t, ctx);
  if (real === t.abs) return null;
  const roots = { ...ctx, homeDir: ctx.homeReal ?? ctx.homeDir, anywhereHome: ctx.anywhereReal ?? ctx.anywhereHome };
  return credentialKind({ ...t, abs: real }, roots);
}

/**
 * Resolve a path argument the way the shell would (~, $HOME, %USERPROFILE%,
 * relative to cwd). Returns null when it can't be known (variables, URLs).
 * @returns {{abs:string, glob:boolean, win:boolean, raw:string}|null}
 */
function resolveTarget(raw, ctx, cwd) {
  let s = str(raw).trim();
  if (!s || s === '-' || s === '{}') return null;
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(s)) return null;
  if (/^[^\s/\\:@]+@[^\s/\\:]+:/.test(s)) return null;
  let glob = false;
  const gm = /^(.*?)(\*|\.\*|\*\.\*)$/.exec(s);
  if (gm && (gm[1] === '' || /[\\/]$/.test(gm[1]))) {
    glob = true;
    s = gm[1] || '.';
  }
  const home = ctx.homeDir;
  const W0 = ctx.platform === 'win32';
  const winHome = (...segs) => (W0 ? path.win32.join(home, ...segs) : null);
  const rep = [
    [/^~(?=$|[\\/])/, home],
    [/^\$\{?HOME\}?(?=$|[\\/])/, home],
    [/^\$env:(USERPROFILE|HOME)(?=$|[\\/])/i, home],
    [/^%(USERPROFILE|HOME)%(?=$|[\\/])/i, home],
    [/^\$\{?PWD\}?(?=$|[\\/])/, cwd],
    [/^\$\{?(TMPDIR|TMP|TEMP)\}?(?=$|[\\/])/, ctx.tmpDir],
    [/^\$env:(TEMP|TMP)(?=$|[\\/])/i, ctx.tmpDir],
    [/^%(TEMP|TMP)%(?=$|[\\/])/i, ctx.tmpDir],
    [/^(\$env:(SystemRoot|windir)|%(SystemRoot|windir)%)(?=$|[\\/])/i, 'C:\\Windows'],
    [/^(\$env:ProgramData|%ProgramData%)(?=$|[\\/])/i, 'C:\\ProgramData'],
    [/^(\$env:SystemDrive|%SystemDrive%)(?=$|[\\/])/i, 'C:'],
    [/^(\$env:APPDATA|%APPDATA%)(?=$|[\\/])/i, winHome('AppData', 'Roaming')],
    [/^(\$env:LOCALAPPDATA|%LOCALAPPDATA%)(?=$|[\\/])/i, winHome('AppData', 'Local')],
  ];
  for (const [re, val] of rep) {
    if (re.test(s)) {
      if (val == null) return null;
      s = s.replace(re, () => val);
      break;
    }
  }
  // NTFS: "file::$DATA" is the file itself (WINDOWS-2-2).
  if ((W0 || /^([a-zA-Z]:|\\\\|\/\/)/.test(s)) && /::?\$DATA$/i.test(s)) s = s.replace(/::?\$DATA$/i, '');
  if (/\$[A-Za-z_{(]|%[A-Za-z_]+%|`|…/.test(s)) return null;
  if (W0 && /^\/[a-zA-Z](\/|$)/.test(s)) s = `${s[1].toUpperCase()}:\\${s.slice(3)}`;
  const W = W0 || /^[a-zA-Z]:([\\/]|$)/.test(s) || s.startsWith('\\\\');
  let abs;
  if (W) {
    s = s.replace(/\//g, '\\');
    s = win32Canonical(s);
    if (s == null) return null;
    if (/^[a-zA-Z]:$/.test(s)) s += '\\';
    if (/^([a-zA-Z]:\\|\\\\)/.test(s)) abs = path.win32.normalize(s);
    else {
      if (!cwd) return null;
      abs = path.win32.resolve(cwd, s);
    }
    if (abs.length > 3 && abs.endsWith('\\')) abs = abs.replace(/\\+$/, '');
  } else {
    if (s.startsWith('/')) abs = path.posix.normalize(s);
    else {
      if (!cwd) return null;
      abs = path.posix.resolve(cwd, s);
    }
    if (abs.length > 1) abs = abs.replace(/\/+$/, '');
  }
  return { abs, glob, win: W, raw: str(raw) };
}

function normFor(win, p) {
  return win ? p.toLowerCase().replace(/\//g, '\\') : p;
}

function isUnder(child, dir, win) {
  if (!child || !dir) return false;
  const a = normFor(win, child);
  const b = normFor(win, dir);
  if (a === b) return true;
  const sep = win ? '\\' : '/';
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
}

function realOf(t, ctx) {
  if (!ctx.real || t.win !== (process.platform === 'win32')) return t.abs;
  return realish(t.abs);
}

/**
 * sensitiveKind for where a written path really lands: symlinks resolved in the target and, to
 * match, in the home, state and config roots it is compared with. Resolving only the target
 * misses a link into ~/.ssh whenever the home folder itself sits behind a symlink (macOS
 * /var -> /private/var, /home -> /var/home on Fedora Atomic, automounted home folders).
 */
function realSensitiveKind(t, ctx) {
  if (!ctx.real) return null;
  const roots = {
    ...ctx,
    homeDir: ctx.homeReal ?? ctx.homeDir,
    anywhereHome: ctx.anywhereReal ?? ctx.anywhereHome,
    claudeHome: ctx.claudeReal ?? ctx.claudeHome,
  };
  return sensitiveKind({ ...t, abs: realOf(t, ctx) }, roots);
}

/** Is a resolved target inside the project (or an extra allowed directory)? */
function insideProject(t, ctx) {
  if (!ctx.projectDir) return false;
  const p = realOf(t, ctx);
  if (isUnder(p, ctx.projectReal || ctx.projectDir, t.win)) return true;
  return ctx.extraDirs.some((d) => isUnder(p, ctx.real ? realish(d) : d, t.win));
}

function isTempPath(t, ctx) {
  const a = t.abs;
  if (!t.win && /^\/(tmp|var\/tmp|private\/tmp|var\/folders|private\/var\/folders|dev\/shm)(\/|$)/.test(a)) return true;
  if (ctx.tmpDir && isUnder(a, ctx.tmpDir, t.win)) return true;
  if (t.win && ctx.platform === 'win32' && isUnder(a, path.win32.join(ctx.homeDir, 'AppData', 'Local', 'Temp'), true)) return true;
  return false;
}

const POSIX_SYSTEM_TOP =
  /^\/(bin|boot|dev|etc|lib|lib32|lib64|opt|proc|root|sbin|srv|sys|usr|var|home|Users|System|Library|Applications|private|Volumes|mnt|media|snap|nix|cores)$/;

/** Describe a path whose recursive deletion would be catastrophic, else null. */
function rootLike(t, ctx) {
  const { abs, win } = t;
  if (win) {
    const lc = abs.toLowerCase();
    if (/^[a-z]:\\?$/.test(lc)) return `the whole ${abs.slice(0, 2).toUpperCase()} drive`;
    if (/^\\\\[^\\]+\\[^\\]+$/.test(lc)) return 'a whole network share';
    if (ctx.platform === 'win32' && lc === ctx.homeDir.toLowerCase()) return 'your user profile';
    if (/^[a-z]:\\users$/.test(lc)) return 'the Users folder';
    if (/^[a-z]:\\users\\[^\\]+$/.test(lc)) return 'a user profile';
    if (/^[a-z]:\\(windows(\\system32)?|program files( \(x86\))?|programdata)$/.test(lc)) return `the system folder ${abs}`;
    return null;
  }
  if (abs === '/') return 'the whole filesystem (/)';
  if (ctx.platform !== 'win32' && abs === ctx.homeDir) return 'your home directory';
  if (ctx.platform !== 'win32' && abs === path.posix.dirname(ctx.homeDir) && abs !== '/') return `${abs} (every user's home)`;
  if (POSIX_SYSTEM_TOP.test(abs)) return `the system directory ${abs}`;
  if (/^\/(usr|var|System|Library|private)\/[^/]+$/.test(abs) && !/^\/(var|private)\/(tmp|folders)$/.test(abs))
    return `the system directory ${abs}`;
  if (/^\/mnt\/[a-z]$/i.test(abs)) return `the whole Windows ${abs[5].toUpperCase()}: drive`;
  if (/^\/mnt\/[a-z]\/(windows|users(\/[^/]+)?|program files( \(x86\))?|programdata)$/i.test(abs)) return `the Windows folder ${abs}`;
  return null;
}

const RC_FILES = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.zlogout',
  '.cshrc',
  '.tcshrc',
  '.kshrc',
  '.mkshrc',
  '.inputrc',
  '.xprofile',
  '.xinitrc',
  '.xsessionrc',
]);

/**
 * Credential-bearing files (reading them is also risky).
 * @returns {{what:string, env:boolean}|null}
 */
function credentialKind(t, ctx) {
  const P = t.win ? path.win32 : path.posix;
  const a = normFor(t.win, t.abs);
  const lbase = P.basename(a).toLowerCase();
  const parent = P.basename(P.dirname(a)).toLowerCase();
  const homeOk = (ctx.platform === 'win32') === t.win;
  const home = homeOk ? normFor(t.win, ctx.homeDir) : null;
  const inHome = (...segs) => Boolean(home) && isUnder(a, normFor(t.win, P.join(home, ...segs)), t.win);
  const isHome = (...segs) => Boolean(home) && a === normFor(t.win, P.join(home, ...segs));
  if (/^\.env(\..+)?$/.test(lbase) && !/^\.env\.(example|sample|template|dist|defaults?|schema)$/.test(lbase)) {
    return { what: 'an environment file (.env) that may hold secrets', env: true };
  }
  if (
    /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|gpg)$/.test(lbase) ||
    (/^id_(rsa|dsa|ecdsa|ed25519)/.test(lbase) && !lbase.endsWith('.pub'))
  ) {
    return { what: 'a private key or certificate', env: false };
  }
  if (inHome('.ssh')) return { what: 'your SSH keys and config', env: false };
  if (inHome('.aws')) return { what: 'your AWS credentials', env: false };
  if (inHome('.config', 'gcloud') || inHome('AppData', 'Roaming', 'gcloud')) return { what: 'your gcloud credentials', env: false };
  if (inHome('.azure')) return { what: 'your Azure credentials', env: false };
  if (inHome('.kube')) return { what: 'your Kubernetes credentials', env: false };
  if (inHome('.gnupg') || inHome('.password-store')) return { what: 'your GPG keys or password store', env: false };
  if (inHome('.config', 'gh') || inHome('.terraform.d')) return { what: 'CLI login tokens', env: false };
  // F3-SAFE-D1: <state>/run/*.json (the MCP configs carry the daemon's token) and a call engine's
  // folder <state>/calls/<id>/engine/ are credential files, like daemon.json.
  for (const root of [home ? P.join(home, '.claude-anywhere') : null, ctx.anywhereHome || null]) {
    if (!root) continue;
    const r = normFor(t.win, root);
    const runDir = normFor(t.win, P.join(r, 'run'));
    if (isUnder(a, runDir, t.win) && a !== runDir && (/\.json$/.test(lbase) || /[*?[]/.test(lbase) || P.dirname(a) !== runDir)) {
      return { what: 'a Claude Anywhere run file that holds its access token', env: false };
    }
    const callsDir = normFor(t.win, P.join(r, 'calls'));
    if (isUnder(a, callsDir, t.win)) {
      const rest = a.slice(callsDir.length + 1).split(/[\\/]+/);
      if (rest[1] && rest[1].toLowerCase() === 'engine') return { what: "a call engine's files, which hold the Claude Anywhere access token", env: false };
    }
  }
  if (
    isHome('.docker', 'config.json') ||
    isHome('.netrc') ||
    isHome('_netrc') ||
    isHome('.npmrc') ||
    isHome('.pypirc') ||
    isHome('.git-credentials') ||
    isHome('.terraformrc') ||
    isHome('.claude', '.credentials.json') ||
    isHome('.claude-anywhere', 'daemon.json') ||
    (ctx.anywhereHome && a === normFor(t.win, P.join(ctx.anywhereHome, 'daemon.json')))
  ) {
    return { what: 'a file with login tokens', env: false };
  }
  // The settings file stores voice.sttApiKey; ~/.claude.json can hold an API key (LIVE-E2E-R3-6).
  if (isHome('.claude-anywhere', 'config.json') || (ctx.anywhereHome && a === normFor(t.win, P.join(ctx.anywhereHome, 'config.json')))) {
    return { what: 'the Claude Anywhere settings, which hold API keys', env: false };
  }
  if (isHome('.claude.json')) return { what: 'the Claude Code settings, which can hold an API key', env: false };
  if (/^(application_default_credentials|service[-_]account([-_].*)?|credentials)\.json$/.test(lbase)) {
    return { what: 'a cloud credentials file', env: false };
  }
  // CLASSIFIER-R3-03: more files that hold live passwords or tokens.
  if (
    /^(\.pgpass|pgpass\.conf|\.mylogin\.cnf|\.vault-token|\.git-credentials|\.databrickscfg|\.databricks-token)$/.test(lbase) ||
    isHome('.my.cnf') ||
    isHome('.cargo', 'credentials') ||
    isHome('.cargo', 'credentials.toml') ||
    isHome('.gem', 'credentials') ||
    isHome('.config', 'hub') ||
    isHome('.s3cfg') ||
    isHome('.boto') ||
    isHome('.config', 'doctl', 'config.yaml') ||
    isHome('AppData', 'Roaming', 'doctl', 'config.yaml') ||
    (lbase === 'auth.json' && parent === 'containers')
  ) {
    return { what: 'a file with login tokens or passwords', env: false };
  }
  if (inHome('.config', 'op') || inHome('.op') || inHome('.config', 'rclone') || inHome('AppData', 'Roaming', 'rclone')) {
    return { what: 'CLI login tokens', env: false };
  }
  // CLASSIFIER-R3-11: keychains and keyrings, browser password and cookie stores, shell history
  // and process environments are where an attacker looks first.
  if (
    inHome('.local', 'share', 'keyrings') ||
    inHome('.local', 'share', 'kwalletd') ||
    inHome('Library', 'Keychains') ||
    (!t.win && /^\/library\/keychains(\/|$)/i.test(a)) ||
    inHome('AppData', 'Roaming', 'Microsoft', 'Credentials') ||
    inHome('AppData', 'Local', 'Microsoft', 'Credentials') ||
    inHome('AppData', 'Roaming', 'Microsoft', 'Protect') ||
    inHome('AppData', 'Local', 'Microsoft', 'Vault')
  ) {
    return { what: 'your keychain or keyring (saved passwords)', env: false };
  }
  if ((BROWSER_SECRET_FILE.test(lbase) && BROWSER_PROFILE_DIR.test(a)) || lbase === 'cookies.binarycookies') {
    return { what: "a browser's saved passwords or cookies", env: false };
  }
  if (HISTORY_FILE.test(lbase)) return { what: 'your shell history (it can hold secrets typed in commands)', env: false };
  if (!t.win && /^\/proc\/(self|thread-self|\d+)(\/task\/\d+)?\/environ$/.test(a)) {
    return { what: "a process's environment variables (they can hold tokens)", env: false };
  }
  // Another user's credential folders (/root/.aws, /home/other/.ssh) are just as sensitive.
  return credentialSegments(a);
}

/**
 * Is writing this path sensitive? critical = self-escalation (Claude Anywhere
 * or Claude Code settings), high = credentials, startup files, system paths.
 * @returns {{level:'critical'|'high', what:string}|null}
 */
function sensitiveKind(t, ctx) {
  const P = t.win ? path.win32 : path.posix;
  const a = normFor(t.win, t.abs);
  const lbase = P.basename(a).toLowerCase();
  const parent = P.basename(P.dirname(a)).toLowerCase();
  const homeOk = (ctx.platform === 'win32') === t.win;
  const home = homeOk ? normFor(t.win, ctx.homeDir) : null;
  const inHome = (...segs) => Boolean(home) && isUnder(a, P.join(home, ...segs), t.win);
  const sep = t.win ? '\\' : '/';

  if (
    lbase === 'config.json' &&
    (parent === '.claude-anywhere' || (ctx.anywhereHome && a === normFor(t.win, P.join(ctx.anywhereHome, 'config.json'))))
  ) {
    return { level: 'critical', what: 'the Claude Anywhere settings' };
  }
  if (
    /^settings(\.[\w-]+)?\.json$/.test(lbase) &&
    (parent === '.claude' || (ctx.claudeHome && P.dirname(a) === normFor(t.win, ctx.claudeHome)))
  ) {
    return { level: 'critical', what: 'the Claude Code settings' };
  }
  if (lbase === '.claude.json' || lbase === 'managed-settings.json' || lbase === 'managed-mcp.json') {
    return { level: 'critical', what: 'the Claude Code settings' };
  }
  if (inHome('.claude-anywhere') || (ctx.anywhereHome && isUnder(a, ctx.anywhereHome, t.win))) {
    return { level: 'high', what: 'the Claude Anywhere state folder' };
  }
  if (inHome('.claude') || (ctx.claudeHome && isUnder(a, ctx.claudeHome, t.win))) {
    return { level: 'high', what: 'the Claude Code configuration folder' };
  }
  if (a.includes(`${sep}.claude${sep}`)) return { level: 'high', what: "the project's Claude Code configuration (.claude/)" };
  if (lbase === '.mcp.json') return { level: 'high', what: 'the MCP server configuration' };
  const cred = credentialKind(t, ctx);
  if (cred) return { level: 'high', what: cred.what };
  if (RC_FILES.has(lbase) || inHome('.config', 'fish') || /^(microsoft\.(powershell|vscode)_)?profile\.ps1$/.test(lbase)) {
    return { level: 'high', what: 'a shell startup file' };
  }
  if (
    inHome('Library', 'LaunchAgents') ||
    /^\/library\/(launchagents|launchdaemons)(\/|$)/i.test(a) ||
    inHome('.config', 'autostart') ||
    inHome('.config', 'systemd') ||
    a.includes(`${sep}start menu${sep}programs${sep}startup`)
  ) {
    return { level: 'high', what: 'a login or autostart location' };
  }
  if (a.includes(`${sep}.git${sep}hooks${sep}`) || a.endsWith(`${sep}.git${sep}config`)) {
    return { level: 'high', what: 'git hooks or git config (they can run code)' };
  }
  // Files that run code on a later action, even inside the project (CLASSIFIER-R3-14).
  if (/[\\/](site|dist)-packages[\\/]/i.test(a) && (/\.pth$/.test(lbase) || /^(site|user)customize\.py$/.test(lbase))) {
    return { level: 'high', what: 'a Python startup hook (it runs on every interpreter start)' };
  }
  if (parent === '.vscode' && /^(tasks|settings|launch)\.json$/.test(lbase)) {
    return { level: 'high', what: 'editor settings that can run commands (.vscode)' };
  }
  if (a.includes(`${sep}.husky${sep}`) && !a.includes(`${sep}.husky${sep}_${sep}`)) {
    return { level: 'high', what: 'git hooks (.husky), which run on every commit' };
  }
  if (t.win) {
    if (/^[a-z]:\\(windows|program files|program files \(x86\)|programdata)(\\|$)/.test(a))
      return { level: 'high', what: 'a Windows system folder' };
  } else {
    if (/^\/(etc|usr|bin|sbin|boot|lib|lib32|lib64|opt|System|Library|root|srv|sys|proc|dev|snap|nix)(\/|$)/.test(a))
      return { level: 'high', what: 'a system location' };
    if (/^\/(var|private\/var)\//.test(a) && !/^\/(var|private\/var)\/(tmp|folders)(\/|$)/.test(a))
      return { level: 'high', what: 'a system location' };
    if (/^\/private\/etc(\/|$)/.test(a)) return { level: 'high', what: 'a system location' };
    if (/^\/mnt\/[a-z]\/(windows|program files|programdata)(\/|$)/i.test(a)) return { level: 'high', what: 'a Windows system folder' };
  }
  return null;
}

function displayPath(p, ctx) {
  const s = str(p);
  if (!s) return '(no path)';
  const t = resolveTarget(s, ctx, ctx.projectDir);
  if (!t) return truncate(s, 100);
  if (ctx.projectDir && isUnder(t.abs, ctx.projectDir, t.win)) {
    const P = t.win ? path.win32 : path.posix;
    const rel = P.relative(ctx.projectDir, t.abs);
    return truncate(rel || '.', 100);
  }
  if (ctx.homeDir && isUnder(t.abs, ctx.homeDir, t.win) && (ctx.platform === 'win32') === t.win) {
    const P = t.win ? path.win32 : path.posix;
    return truncate(`~${P.sep}${P.relative(ctx.homeDir, t.abs)}`.replace(/[\\/]$/, ''), 100);
  }
  return truncate(t.abs, 100);
}

// ------------------------------------------------------------------ shell command classification

const READ_ONLY_PROGS = new Set([
  'ls',
  'dir',
  'll',
  'la',
  'l',
  'vdir',
  'cat',
  'bat',
  'batcat',
  'less',
  'more',
  'most',
  'head',
  'tail',
  'pwd',
  'echo',
  'printf',
  'which',
  'where',
  'whereis',
  'type',
  'whoami',
  'id',
  'groups',
  'hostname',
  'uname',
  'date',
  'cal',
  'uptime',
  'printenv',
  'env',
  'df',
  'du',
  'free',
  'ps',
  'pgrep',
  'pstree',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'tac',
  'rev',
  'column',
  'diff',
  'cmp',
  'comm',
  'file',
  'stat',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'tree',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'jq',
  'xxd',
  'hexdump',
  'od',
  'strings',
  'md5sum',
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'shasum',
  'md5',
  'cksum',
  'b2sum',
  'base64',
  'true',
  'false',
  'test',
  '[',
  '[[',
  'sleep',
  'seq',
  'history',
  'man',
  'help',
  'tldr',
  'nproc',
  'lscpu',
  'lsblk',
  'lsusb',
  'lspci',
  'lsof',
  'netstat',
  'ss',
  'dig',
  'nslookup',
  'host',
  'ping',
  'traceroute',
  'tracepath',
  'whois',
  'sw_vers',
  'system_profiler',
  'locale',
  'tty',
  'getconf',
  'arch',
  'lsb_release',
  'fc-list',
  'xdpyinfo',
  'xwininfo',
  'xprop',
  'fd',
  'fdfind',
  'locate',
  'mdfind',
  'mdls',
  'apropos',
  'whatis',
  'fold',
  'paste',
  'join',
  'expand',
  'unexpand',
  'numfmt',
  'factor',
  'bc',
  'expr',
  'cd',
  'pushd',
  'popd',
  'export',
  'unset',
  'alias',
  'unalias',
  'declare',
  'typeset',
  'local',
  'readonly',
  'shopt',
  'setopt',
  'set',
  'ulimit',
  'umask',
  'wait',
  'exit',
  'return',
  ':',
  'clear',
  'cls',
  'reset',
  'pbpaste',
  'notify-send',
  'say',
  'espeak',
  'espeak-ng',
  'spd-say',
  'vmstat',
  'iostat',
  'mpstat',
  'w',
  'who',
  'last',
  'getent',
  'dmesg',
  'journalctl',
  'nvidia-smi',
  'wslpath',
  'cygpath',
  'chdir',
  'more',
  'findstr',
  'ver',
  'vol',
  'systeminfo',
  'tasklist',
  'ipconfig',
  'whoami',
  'hash',
  'jobs',
  'fg',
  'bg',
  'disown',
  'shift',
  'getopts',
  'trap',
  'read',
  'mapfile',
  'dirs',
  'complete',
  'compgen',
  'bind',
  'enable',
  'caller',
  'times',
  'let',
  'for',
  'case',
  'select',
  'in',
  ']]',
  '((',
  '))',
]);

const PS_ALIASES = {
  rm: 'remove-item',
  del: 'remove-item',
  erase: 'remove-item',
  rd: 'remove-item',
  rmdir: 'remove-item',
  ri: 'remove-item',
  ls: 'get-childitem',
  dir: 'get-childitem',
  gci: 'get-childitem',
  cat: 'get-content',
  gc: 'get-content',
  type: 'get-content',
  cp: 'copy-item',
  copy: 'copy-item',
  cpi: 'copy-item',
  mv: 'move-item',
  move: 'move-item',
  mi: 'move-item',
  ren: 'rename-item',
  rni: 'rename-item',
  ni: 'new-item',
  md: 'new-item',
  mkdir: 'new-item',
  sc: 'set-content',
  ac: 'add-content',
  clc: 'clear-content',
  echo: 'write-output',
  write: 'write-output',
  kill: 'stop-process',
  spps: 'stop-process',
  iex: 'invoke-expression',
  iwr: 'invoke-webrequest',
  irm: 'invoke-restmethod',
  start: 'start-process',
  saps: 'start-process',
  ii: 'invoke-item',
  cd: 'set-location',
  sl: 'set-location',
  chdir: 'set-location',
  pushd: 'push-location',
  popd: 'pop-location',
  gl: 'get-location',
  pwd: 'get-location',
  gp: 'get-itemproperty',
  sp: 'set-itemproperty',
  rp: 'remove-itemproperty',
  cls: 'clear-host',
  clear: 'clear-host',
  gps: 'get-process',
  ps: 'get-process',
  gsv: 'get-service',
  select: 'select-object',
  where: 'where-object',
  '?': 'where-object',
  foreach: 'foreach-object',
  '%': 'foreach-object',
  sort: 'sort-object',
  measure: 'measure-object',
  ft: 'format-table',
  fl: 'format-list',
  fw: 'format-wide',
  sls: 'select-string',
  gcm: 'get-command',
  h: 'get-history',
  history: 'get-history',
  icm: 'invoke-command',
  etsn: 'enter-pssession',
  sleep: 'start-sleep',
  tee: 'tee-object',
  gal: 'get-alias',
  man: 'get-help',
  help: 'get-help',
  oh: 'out-host',
  gi: 'get-item',
  gm: 'get-member',
  ghy: 'get-history',
  gv: 'get-variable',
  sv: 'set-variable',
  nv: 'new-variable',
  ipmo: 'import-module',
  '.': 'dot-source',
};

const PS_LOW = new Set([
  'select-string',
  'select-object',
  'where-object',
  'sort-object',
  'measure-object',
  'format-table',
  'format-list',
  'format-wide',
  'out-string',
  'out-host',
  'out-null',
  'write-output',
  'write-host',
  'write-verbose',
  'write-information',
  'write-warning',
  'write-error',
  'write-debug',
  'test-path',
  'resolve-path',
  'split-path',
  'join-path',
  'convertto-json',
  'convertfrom-json',
  'convertto-csv',
  'convertfrom-csv',
  'convertto-xml',
  'compare-object',
  'group-object',
  'test-connection',
  'resolve-dnsname',
  'foreach-object',
  'measure-command',
  'set-location',
  'push-location',
  'pop-location',
  'clear-host',
  'start-sleep',
  'test-netconnection',
  'set-variable',
  'new-variable',
  'set-strictmode',
  'add-type',
  'new-object',
  'select-xml',
  'test-json',
  'out-gridview',
]);

const INTERPRETERS =
  /^(python[0-9.]*|py|pypy[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|lua|luajit|rscript|julia|tclsh|osascript|groovy|kotlin|scala|java|dotnet-script|ts-node|tsx)$/;
const SHELLS = /^(bash|sh|zsh|dash|ksh|mksh|fish|tcsh|csh|ash|busybox)$/;
const PS_HOSTS = /^(pwsh|powershell|pwsh-preview)$/;
const DOWNLOADERS = new Set([
  'curl',
  'wget',
  'invoke-webrequest',
  'invoke-restmethod',
  'iwr',
  'irm',
  'fetch',
  'http',
  'https',
  'aria2c',
  'certutil',
  'bitsadmin',
]);
const STDIN_EXECUTORS =
  /^(bash|sh|zsh|dash|ksh|mksh|fish|ash|python[0-9.]*|py|node|perl|ruby|php|pwsh|powershell|iex|invoke-expression|cmd|sudo|doas)$/;

/**
 * A pipeline stage that turns its input into text the classifier never sees: base64/xxd/openssl
 * decoding, decompression, reversing. Fed to a shell, the script is uninspectable (SECURITY-ADVERSARIAL-1).
 */
function isDecoder(prog, args) {
  const has = (re) => args.some((a) => re.test(a));
  switch (prog) {
    case 'base64':
    case 'base32':
    case 'basenc':
    case 'gbase64':
      return has(/^(-[a-ce-zA-CE-Z]*[dD][a-zA-Z]*|--decode)$/);
    case 'xxd':
      return has(/^(-r|-revert|-[a-z]*r[a-z]*)$/);
    case 'openssl':
      return has(/^-(d|base64|a)$/) && (has(/^-d$/) || args[0] === 'base64');
    case 'gzip':
    case 'bzip2':
    case 'xz':
    case 'lzma':
    case 'zstd':
    case 'lz4':
    case 'brotli':
      return has(/^(-[a-zA-Z]*d[a-zA-Z]*|--decompress|--uncompress)$/);
    case 'gunzip':
    case 'zcat':
    case 'gzcat':
    case 'bzcat':
    case 'bunzip2':
    case 'unxz':
    case 'xzcat':
    case 'lzcat':
    case 'unlzma':
    case 'zstdcat':
    case 'unzstd':
    case 'lz4cat':
    case 'unlz4':
    case 'uudecode':
    case 'rev':
    case 'certutil':
      return prog !== 'certutil' || has(/^[-/]decode(hex)?$/i);
    default:
      return false;
  }
}

/**
 * A command whose program is only known at run time: `$X args`, `$(…) args`, `${X}`, a backtick
 * substitution, cmd `%X%`/`!X!`, or PowerShell `& $x` / `& ([scriptblock]::Create(...))`.
 * A variable directory with a literal program name ("$VENV/bin/python") is not computed.
 */
function computedCommandName(word, shell, tk) {
  const w = String(word || '');
  if (!w) return false;
  if (shell === 'powershell') {
    // `& (…)`: the parenthesized pipeline is split out, leaving a `(…)` placeholder.
    const first = String((tk && tk.argv && tk.argv[0]) || '');
    return Boolean(tk && tk.callOp) && (/^[$(…]/.test(w) || /^\(/.test(first) || /\[scriptblock\]::create/i.test(w));
  }
  const name = progName(w);
  if (shell === 'cmd') return /%[^%\s]+%|![^!\s]+!/.test(name);
  return /[$`…]/.test(name);
}

// `eval "$(...)"` / `source <(...)` generators that print shell setup code: common, and
// trusted as much as running the tool itself.
const EVAL_GENERATORS =
  /^(ssh-agent( -[sc])?|(pyenv|rbenv|nodenv|goenv|jenv|plenv|phpenv|swiftenv|scalaenv|tfenv)( virtualenv-)? init( -| -[-\w]+)*|direnv (hook|export) \w+|brew shellenv|conda shell\.\w+ hook|fnm env( --[-\w=]+)*|starship init \w+|zoxide init \w+|mise (activate|hook-env)( \w+)*|rtx activate \w+|atuin init \w+|dircolors( -[bc])?( \S+)?|opam env( --[-\w=]+)*|keychain( --?[-\w]+)*( \S+)*|(kubectl|helm|gh|docker|minikube|kind|npm|pip|rustup|poetry|deno|bun|uv|glab|flux|argocd|k9s|stern|terraform|gcloud|az) completion( \w+)*)$/;

function isEvalGenerator(text) {
  const words = String(text || '').trim().split(/\s+/);
  if (!words[0]) return false;
  words[0] = progName(words[0]);
  return EVAL_GENERATORS.test(words.join(' '));
}
const NETWORK_PROGS = new Set([
  'curl',
  'wget',
  'http',
  'https',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'scp',
  'rsync',
  'sftp',
  'ftp',
  'ssh',
  'rclone',
  'gsutil',
  'aws',
  'az',
  'gcloud',
  'telnet',
  'mail',
  'mailx',
  'sendmail',
  'mutt',
  'invoke-webrequest',
  'invoke-restmethod',
  'send-mailmessage',
  'gh',
  'aria2c',
]);
const SQL_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'sqlite',
  'sqlcmd',
  'mongosh',
  'mongo',
  'redis-cli',
  'cqlsh',
  'clickhouse-client',
  'clickhouse',
  'duckdb',
  'snowsql',
  'pgcli',
  'mycli',
  'usql',
  'cockroach',
  'osql',
  'isql',
]);
const SQL_DANGER =
  /\b(drop\s+(table|database|schema|index|view|user|role|collection)|truncate\s+(table\s+)?\w|delete\s+from|alter\s+table\s+\S+\s+drop)\b|\bdropDatabase\s*\(|\.drop\s*\(|\bdeleteMany\s*\(|\bflushall\b|\bflushdb\b/i;
const EXEC_EXT =
  /\.(exe|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msix|appx|scr|cpl|jar|sh|bash|zsh|command|app|pkg|dmg|deb|rpm|run|appimage|lnk|reg|hta|py|rb|pl|desktop|terminal|workflow|scpt|applescript|url|webloc|inetloc|fileloc|pif|msc|library-ms|settingcontent-ms|appref-ms|application|xll|search-ms|searchconnector-ms)$/i;
const DEPLOY_WORD = /(^|[-_:./])(deploy|deployment|release|publish|destroy|teardown|undeploy|nuke|rollout|ship|prod|production)([-_:.]|$)/i;
const FORCE_FLAG = /^(--force|-f|--yes|-y|--auto-approve|-auto-approve|--quiet|-q|--confirm|--no-confirm|--non-interactive|-Force)$/;
const DELETE_WORD = /^(delete|destroy|remove|rm|purge|drop|terminate|uninstall|wipe|nuke|deploy)$/i;

const CLOUD_CLIS = new Set([
  'gcloud',
  'gsutil',
  'bq',
  'aws',
  'az',
  'doctl',
  'heroku',
  'flyctl',
  'fly',
  'vercel',
  'netlify',
  'firebase',
  'kubectl',
  'oc',
  'helm',
  'terraform',
  'tofu',
  'terragrunt',
  'pulumi',
  'serverless',
  'sls',
  'sam',
  'cdk',
  'cdktf',
  'eb',
  'wrangler',
  'railway',
  'render',
  'eksctl',
  'copilot',
  'amplify',
  'supabase',
  'skaffold',
  'argocd',
  'ansible',
  'ansible-playbook',
  'ibmcloud',
  'oci',
  'linode-cli',
  'hcloud',
  'scw',
  'cf',
  'ecs-cli',
  'kn',
  'kubectx',
]);

const MUTATING_VERBS = new Set([
  'deploy',
  'delete',
  'destroy',
  'apply',
  'create',
  'up',
  'rm',
  'remove',
  'terminate',
  'scale',
  'set-iam-policy',
  'add-iam-policy-binding',
  'remove-iam-policy-binding',
  'publish',
  'release',
  'rollout',
  'import',
  'update',
  'patch',
  'replace',
  'set',
  'enable',
  'disable',
  'purge',
  'submit',
  'execute',
  'ssh',
  'scp',
  'launch',
  'sync',
  'upgrade',
  'install',
  'uninstall',
  'rollback',
  'promote',
  'restart',
  'start',
  'stop',
  'invoke',
  'reset',
  'resize',
  'push',
  'upload',
  'put',
  'grant',
  'revoke',
  'attach',
  'detach',
  'move',
  'rename',
  'unset',
  'mk',
  'rb',
  'kill',
  'drain',
  'cordon',
  'uncordon',
  'taint',
  'untaint',
  'expose',
  'autoscale',
  'refresh',
  'down',
  'migrate',
  'restore',
  'failover',
  'reboot',
  'suspend',
  'resume',
  'add',
  'force-unlock',
  'redeploy',
  'alias',
  'bootstrap',
  'setenv',
  'swap',
  'abort',
  'run-task',
  'trigger',
  'retry',
  'approve',
]);
const READ_VERBS = new Set([
  'list',
  'ls',
  'describe',
  'get',
  'show',
  'info',
  'status',
  'version',
  '--version',
  'help',
  '--help',
  'logs',
  'log',
  'read',
  'tail',
  'whoami',
  'plan',
  'validate',
  'preview',
  'diff',
  'synth',
  'template',
  'lint',
  'explain',
  'top',
  'inspect',
  'output',
  'outputs',
  'view',
  'search',
  'history',
  'current-context',
  'get-contexts',
  'get-value',
  'get-iam-policy',
  'can-i',
  'api-resources',
  'api-versions',
  'cluster-info',
  'doctor',
  'check',
  'metadata',
  'notices',
  'graph',
  'providers',
  'print',
  'cat',
  'du',
  'stat',
  'hash',
  'head',
  'query-only',
  'watch-only',
  'env-list',
  'whoami',
]);
const EXTRA_VERBS = {
  kubectl: ['run', 'exec', 'edit', 'debug', 'label', 'annotate'],
  oc: ['run', 'exec', 'edit', 'debug', 'label', 'annotate', 'new-app', 'new-project', 'delete-project'],
  cdk: ['watch'],
};

// Global options of cloud CLIs that take a value, so `aws --profile prod s3 rm` finds "s3 rm".
const CLOUD_VALUE_FLAGS = new Set([
  '--project',
  '--account',
  '--format',
  '--verbosity',
  '--configuration',
  '--impersonate-service-account',
  '--billing-project',
  '--region',
  '--zone',
  '--profile',
  '--output',
  '-o',
  '--endpoint-url',
  '--query',
  '--color',
  '-n',
  '--namespace',
  '--context',
  '--kubeconfig',
  '-l',
  '--selector',
  '--cluster',
  '-f',
  '--filename',
  '--subscription',
  '-g',
  '--resource-group',
  '--values',
  '--set',
  '--set-string',
  '-H',
  '--host',
  '--log-level',
  '-a',
  '--app',
  '--team',
  '--scope',
  '--token',
  '--stage',
  '--site',
  '--location',
  '--org',
  '--space',
  '-s',
  '--stack',
  '--cwd',
  '-C',
  '-chdir',
  '--config',
  '--env',
  '-e',
]);

function leadingWords(args, n = 6, valueFlags = null) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (out.length >= n) break;
    if (!a) continue;
    if (a.startsWith('-')) {
      if (valueFlags && valueFlags.has(a) && !a.includes('=')) i += 1;
      continue;
    }
    out.push(a.toLowerCase());
  }
  return out;
}

function verbOf(word, prog) {
  const segs = word.includes(':') ? word.split(':') : [word];
  let read = false;
  for (const w of segs) {
    if (!w) continue;
    const extra = EXTRA_VERBS[prog];
    if (MUTATING_VERBS.has(w) || (extra && extra.includes(w))) return 'mutating';
    for (const v of MUTATING_VERBS) {
      if (v.length > 2 && w.startsWith(`${v}-`)) return 'mutating';
    }
    if (READ_VERBS.has(w) || /^(list|describe|get|show)-/.test(w)) read = true;
  }
  return read ? 'read' : null;
}

function hasFlag(args, ...flags) {
  return args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)));
}

function flagValue(args, ...flags) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (flags.includes(a)) return args[i + 1] != null ? args[i + 1] : null;
    for (const f of flags) if (f.startsWith('--') && a.startsWith(`${f}=`)) return a.slice(f.length + 1);
  }
  return null;
}

// CLIs whose -h is help (elsewhere -h can be --host or a value flag).
const CLI_HELP_H = new Set(['gcloud', 'kubectl', 'oc', 'az', 'helm', 'terraform', 'tofu']);

/** gcloud, aws, az, kubectl, terraform, vercel, … */
function classifyCloud(prog, args, ctx) {
  // Help changes nothing, whatever subcommand it is about (HEADLINE-SCENARIO-16). Only the CLI's
  // own options count: after `--` they belong to a remote or child command.
  const dd = args.indexOf('--');
  const own = dd === -1 ? args : args.slice(0, dd);
  if (own.includes('--help') || (CLI_HELP_H.has(prog) && own.includes('-h'))) return V('low', 'Shows CLI help');
  const v = cloudVerdict(prog, args);
  return prog === 'gcloud' ? gcloudNotes(args, v, ctx) : v;
}

/** A --set-env-vars style list ("A=1,B=2", or "^:^A=1:B=2") holding a secret-looking value. */
function envVarsHaveSecret(list) {
  let s = str(list);
  let sep = ',';
  const alt = /^\^(.)\^/.exec(s);
  if (alt) {
    sep = alt[1];
    s = s.slice(3);
  }
  return s.split(sep).some((kv) => {
    const eq = kv.indexOf('=');
    if (eq <= 0) return false;
    const key = kv.slice(0, eq);
    const val = kv.slice(eq + 1);
    if (!val || /^\$/.test(val)) return false;
    return Boolean(secretLike(val)) || /key|token|secret|passw|pwd|credential|private/i.test(key);
  });
}

/** Where a path really is, for a reason the user reads: ~/x for the home folder, else absolute. */
function shortAbs(t, ctx) {
  const P = t.win ? path.win32 : path.posix;
  if ((ctx.platform === 'win32') === t.win && isUnder(t.abs, ctx.homeDir, t.win) && t.abs.length > ctx.homeDir.length) {
    return truncate(`~${P.sep}${P.relative(ctx.homeDir, t.abs)}`, 100);
  }
  return truncate(t.abs, 100);
}

/**
 * What a gcloud deploy card must say (HEADLINE-SCENARIO-6): that the service becomes public,
 * that a secret goes into plain env vars, which folder ships, and who the command acts as.
 */
function gcloudNotes(args, v, ctx) {
  const words = leadingWords(args, 6, CLOUD_VALUE_FLAGS);
  let { risk, reason } = v;
  const deployish =
    (words[0] === 'run' &&
      (words[1] === 'deploy' ||
        (['services', 'jobs'].includes(words[1]) && ['update', 'replace', 'deploy', 'create'].includes(words[2])))) ||
    (['functions', 'app'].includes(words[0]) && words[1] === 'deploy') ||
    words.some((w) => /add-iam-policy-binding$/.test(w));
  if (deployish) {
    const member = flagValue(args, '--member') || '';
    if (hasFlag(args, '--allow-unauthenticated') || /^(allUsers|allAuthenticatedUsers)$/i.test(member)) {
      reason += '; makes it publicly reachable on the internet';
    }
    const envs = ['--set-env-vars', '--update-env-vars', '--env-vars'].map((f) => flagValue(args, f)).filter(Boolean);
    if (envs.some(envVarsHaveSecret)) reason += '; puts a secret-looking value in plain env vars';
    const src = flagValue(args, '--source');
    const t = src && ctx ? resolveTarget(src, ctx, ctx.cwd) : null;
    if (t) reason += ` (source folder: ${shortAbs(t, ctx)})`;
  }
  if (hasFlag(args, '--impersonate-service-account')) {
    risk = maxRisk(risk, 'high');
    reason += '; acts as another identity (--impersonate-service-account)';
  }
  return V(risk, reason);
}

function cloudVerdict(prog, args) {
  const words = leadingWords(args, 6, CLOUD_VALUE_FLAGS);
  const label = `${prog} ${words.slice(0, 3).join(' ')}`.trim();
  const has = (w) => words.includes(w);
  const versionOnly = !words.length && args.length > 0 && args.every((a) => /^(-v|--version|-h|--help|version)$/.test(a));
  if (versionOnly) return V('low', 'Shows CLI help or version');

  if (prog === 'aws') return classifyAws(args, words);
  if (prog === 'gcloud') {
    const pi = words.indexOf('projects');
    if (pi !== -1 && words[pi + 1] === 'delete') return V('critical', 'Deletes a whole Google Cloud project and everything in it');
    if (has('folders') && has('delete')) return V('critical', 'Deletes a Google Cloud folder');
    // Billing commits the user's money, or stops every paid service (HEADLINE-SCENARIO-3).
    if (has('billing')) {
      if (has('unlink')) return V('critical', 'Disables billing: paid services in the project stop');
      if (has('link')) return V('high', 'Links a billing account: the project can now incur charges');
    }
    if (words[0] === 'config' && ['set', 'unset'].includes(words[1])) {
      // The account changes who every later command acts as (HEADLINE-SCENARIO-19).
      if (/^((core\/)?account|auth\/(impersonate_service_account|credential_file_override|access_token_file))$/.test(words[2] || '')) {
        return V('high', 'Switches the gcloud identity that later commands act as');
      }
      return V('medium', 'Changes local gcloud CLI settings');
    }
    if (words[0] === 'config' && words[1] === 'config-helper') return V('high', 'Prints a gcloud access token');
    if (words[0] === 'secrets' && words[1] === 'versions' && words[2] === 'access') return V('high', 'Prints a secret from Secret Manager');
    if (words[0] === 'config' && words[1] === 'configurations' && ['activate', 'create', 'list', 'describe'].includes(words[2])) {
      return V(words[2] === 'list' || words[2] === 'describe' ? 'low' : 'medium', 'Switches gcloud configurations');
    }
    if (words[0] === 'config' && ['list', 'get', 'get-value'].includes(words[1])) return V('low', 'Reads gcloud settings');
    if (words[0] === 'auth') {
      if (words[1] === 'list') return V('low', 'Lists gcloud accounts');
      // A live token in the transcript can be sent anywhere (CLASSIFIER-R3-05).
      if (words.some((w) => /^print-/.test(w))) return V('high', 'Prints a gcloud access or identity token');
      if (words[1] === 'activate-service-account' || hasFlag(args, '--cred-file')) {
        return V('high', 'Switches gcloud to a different identity (service-account key)');
      }
      if (words[1] === 'revoke') return V('medium', 'Signs gcloud accounts out');
      return V('medium', 'Changes gcloud sign-in (the user completes it in the browser)');
    }
    if (words[0] === 'info' || words[0] === 'version') return V('low', 'Shows gcloud information');
  }
  if (prog === 'az') {
    if (
      words.some((w) => /^(get-access-token|show-connection-string|list-connection-strings|list-publishing-(credentials|profiles)|list-keys)$/.test(w)) ||
      (has('keys') && has('list')) ||
      (words[0] === 'keyvault' && words[1] === 'secret' && ['show', 'download'].includes(words[2])) ||
      (words[0] === 'acr' && words[1] === 'login' && hasFlag(args, '--expose-token'))
    ) {
      return V('high', 'Prints Azure credentials or secrets');
    }
    if (words[0] === 'group' && words[1] === 'delete') {
      if (hasFlag(args, '--yes', '-y')) return V('critical', 'Deletes a whole Azure resource group without confirmation');
      return V('high', 'Deletes an Azure resource group');
    }
    if (
      ['login', 'logout', 'configure'].includes(words[0]) ||
      (words[0] === 'account' && words[1] === 'set') ||
      (words[0] === 'config' && words[1] === 'set') ||
      (words[0] === 'extension' && ['add', 'update'].includes(words[1]))
    ) {
      return V('medium', 'Changes local Azure CLI settings');
    }
  }
  if (prog === 'kubectl' || prog === 'oc') {
    if (words[0] === 'config' && words[1] === 'view' && hasFlag(args, '--raw')) return V('high', 'Prints kubeconfig credentials (--raw)');
    if (
      words[0] === 'get' &&
      /^secrets?(\/|$)/.test(words[1] || '') &&
      args.some((x, k) => /^(-o|--output)$/.test(args[k - 1] || '') || /^(-o|--output=)./.test(x))
    ) {
      return V('high', 'Prints Kubernetes secrets');
    }
    if (words[0] === 'config') {
      if (['view', 'get-contexts', 'current-context', 'get-clusters', 'get-users'].includes(words[1])) return V('low', 'Reads kubeconfig');
      return V('medium', 'Changes the local kubeconfig');
    }
    if (words[0] === 'rollout' && ['status', 'history'].includes(words[1])) return V('low', 'Reads rollout status');
    if (['port-forward', 'proxy', 'wait', 'cp'].includes(words[0])) return V('medium', `Runs ${label}`);
  }
  if (prog === 'helm' && ['repo', 'dependency', 'dep', 'plugin', 'registry'].includes(words[0])) {
    if (words[1] === 'list' || words[1] === 'ls') return V('low', 'Lists Helm repositories');
    return V('medium', 'Changes local Helm configuration');
  }
  if (['terraform', 'tofu', 'terragrunt'].includes(prog)) {
    if (words[0] === 'init' || words[0] === 'get') return V('medium', 'Initializes Terraform (downloads providers)');
    if (words[0] === 'fmt')
      return hasFlag(args, '-check') ? V('low', 'Checks Terraform formatting') : V('medium', 'Formats Terraform files');
    if (words[0] === 'state' && ['list', 'show', 'pull'].includes(words[1])) return V('low', 'Reads Terraform state');
    if (words[0] === 'workspace') {
      if (['list', 'show'].includes(words[1])) return V('low', 'Lists Terraform workspaces');
      if (['new', 'select'].includes(words[1])) return V('medium', 'Switches Terraform workspace');
    }
    if (words[0] === 'console') return V('low', 'Opens the Terraform console');
  }
  if (prog === 'pulumi') {
    if (words[0] === 'config' && ['set', 'rm', 'unset', 'set-all'].includes(words[1])) return V('medium', 'Changes Pulumi stack config');
    if (words[0] === 'config' || (words[0] === 'stack' && ['ls', 'output', 'select', 'init', 'history'].includes(words[1]))) {
      return V(words[1] === 'select' || words[1] === 'init' ? 'medium' : 'low', 'Pulumi stack configuration');
    }
    if (words[0] === 'login' || words[0] === 'logout') return V('medium', 'Changes Pulumi sign-in');
  }
  if (prog === 'vercel') {
    if (!words.length) return V('high', 'Deploys to Vercel (vercel with no subcommand deploys)');
    if (words[0] === 'env' && ['add', 'rm', 'remove', 'pull'].includes(words[1])) {
      return words[1] === 'pull' ? V('medium', 'Downloads Vercel env vars') : V('high', 'Changes Vercel environment variables');
    }
    if (['dev', 'link', 'pull', 'login', 'logout', 'switch', 'init', 'build', 'git', 'telemetry'].includes(words[0]))
      return V('medium', `Runs ${label}`);
  }
  if (
    prog === 'netlify' &&
    ['dev', 'link', 'init', 'login', 'logout', 'build', 'serve', 'unlink', 'switch', 'functions:serve'].includes(words[0])
  ) {
    return V('medium', `Runs ${label}`);
  }
  if (prog === 'firebase' && words[0] === 'login:ci') return V('high', 'Prints a Firebase CI token');
  if (prog === 'heroku' && ['auth:token', 'authorizations:create'].includes(words[0])) return V('high', 'Prints a Heroku token');
  if (prog === 'firebase') {
    const w0 = words[0] || '';
    if (
      /^emulators(:|$)/.test(w0) ||
      ['serve', 'use', 'login', 'logout', 'init', 'open'].includes(w0) ||
      /^setup:/.test(w0) ||
      w0 === 'login:list'
    ) {
      return V(w0 === 'login:list' ? 'low' : 'medium', `Runs ${label}`);
    }
  }
  if (
    ['wrangler', 'railway', 'netlify', 'sam', 'serverless', 'sls', 'fly', 'flyctl', 'skaffold', 'heroku', 'supabase'].includes(prog) &&
    [
      'dev',
      'local',
      'offline',
      'serve',
      'login',
      'logout',
      'link',
      'init',
      'build',
      'whoami',
      'run',
      'shell',
      'proxy',
      'open',
      'auth',
    ].includes(words[0])
  ) {
    return V(words[0] === 'whoami' ? 'low' : 'medium', `Runs ${label}`);
  }
  if ((prog === 'serverless' || prog === 'sls' || prog === 'sam') && words[0] === 'invoke' && words[1] === 'local')
    return V('medium', 'Invokes a function locally');
  if (prog === 'sam' && words[0] === 'local') return V('medium', 'Runs a function locally');
  if (prog === 'gsutil') {
    const w0 = words[0];
    if (['rm', 'rb'].includes(w0)) return V('high', 'Deletes Cloud Storage objects or buckets');
    if (w0 === 'rsync' && hasFlag(args, '-d')) return V('high', 'Syncs with deletion to/from Cloud Storage');
    if (
      ['acl', 'iam', 'defacl', 'web', 'setmeta', 'lifecycle', 'versioning', 'cors', 'retention'].includes(w0) &&
      ['ch', 'set'].includes(words[1])
    ) {
      return V('high', 'Changes Cloud Storage permissions or settings');
    }
    if (w0 === 'mb') return V('high', 'Creates a Cloud Storage bucket');
    if (['ls', 'cat', 'du', 'stat', 'hash', 'version', 'help'].includes(w0)) return V('low', 'Reads Cloud Storage');
    return V('medium', `Runs ${label}`);
  }
  if (prog === 'bq' && words[0] === 'query') {
    if (SQL_DANGER.test(args.join(' '))) return V('high', 'Runs a BigQuery statement that deletes data');
    return V('medium', 'Runs a BigQuery query');
  }
  if (prog === 'ansible-playbook' || prog === 'ansible') {
    return hasFlag(args, '--check', '-C') ? V('medium', 'Dry-runs an Ansible playbook') : V('high', 'Runs Ansible against remote hosts');
  }
  for (const w of words) {
    const kind = verbOf(w, prog);
    if (kind === 'mutating') return V('high', `Deploys or changes cloud infrastructure (${label})`);
    if (kind === 'read') return V('low', `Reads cloud resources (${label})`);
  }
  if (prog === 'vercel' || prog === 'railway') return V('high', `Deploys or changes cloud resources (${label})`);
  return V('medium', `Runs ${label || prog}`);
}

const AWS_READ =
  /^(describe|list|get|head|lookup|search|scan|query|batch-get|select|validate|estimate|simulate|test|preview|filter|wait|help|show|view|check|decode|detect|tail|ls|download-db-log-file-portion|generate-presigned-url|presign)/;

function classifyAws(args, words) {
  const [svc, action = ''] = words;
  if (!svc) return V('medium', 'Runs the AWS CLI');
  const label = `aws ${svc} ${action}`.trim();
  if (svc === 'configure') {
    // CLASSIFIER-R3-05: keys and tokens printed into the transcript.
    if (action === 'export-credentials' || (action === 'get' && /secret|token|key/.test(words[2] || ''))) {
      return V('high', 'Prints your AWS credentials');
    }
    if (['list', 'get', 'list-profiles'].includes(action)) return V('low', 'Reads AWS CLI settings');
    return V('medium', 'Changes local AWS CLI settings');
  }
  const printsSecret = {
    sts: /^(get-session-token|get-federation-token|assume-role.*)$/,
    sso: /^get-role-credentials$/,
    secretsmanager: /^(batch-)?get-secret-value$/,
    ecr: /^get-login(-password)?$/,
    'ecr-public': /^get-login-password$/,
    codeartifact: /^get-authorization-token$/,
    eks: /^get-token$/,
    rds: /^generate-db-auth-token$/,
    'cognito-identity': /^get-credentials-for-identity$/,
  }[svc];
  if (
    (printsSecret && printsSecret.test(action)) ||
    (svc === 'ssm' && /^get-parameters?(-by-path)?$/.test(action) && hasFlag(args, '--with-decryption'))
  ) {
    return V('high', `Prints AWS credentials or secrets (${label})`);
  }
  if (svc === 'sso' || svc === 'login' || svc === 'logout') return V('medium', 'Changes AWS sign-in');
  if (svc === 'help' || svc === '--version') return V('low', 'Shows AWS CLI help');
  if (svc === 's3') {
    if (action === 'ls') return V('low', 'Lists S3');
    if (action === 'rm' || action === 'rb') return V('high', 'Deletes S3 objects or buckets');
    if (action === 'sync' && args.some((a) => a.startsWith('--delete'))) return V('high', 'Syncs to S3 with deletion');
    if (action === 'mb' || action === 'website') return V('high', 'Creates or publishes an S3 bucket');
    return V('medium', `Copies files with ${label}`);
  }
  if (svc === 'organizations' && action && !AWS_READ.test(action)) {
    return V('critical', 'Changes the AWS organization (accounts can be removed or closed)');
  }
  if (svc === 'sts' && action !== 'assume-role') return V('low', 'Reads AWS identity');
  if (action && AWS_READ.test(action)) return V('low', `Reads AWS resources (${label})`);
  if (!action) return V('medium', `Runs ${label}`);
  return V('high', `Changes AWS resources (${label})`);
}

// "Read-only" git subcommands. (difftool is deliberately NOT here: it runs an external command.)
const GIT_READ_ONLY_SUBS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'shortlog',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'cat-file',
  'rev-parse',
  'describe',
  'grep',
  'whatchanged',
  'count-objects',
  'merge-base',
  'name-rev',
  'rev-list',
  'show-ref',
  'for-each-ref',
  'check-ignore',
  'check-attr',
  'cherry',
  'var',
  'help',
  'version',
  '--version',
  'show-branch',
  'range-diff',
  'annotate',
  'fsck',
  'verify-commit',
  'verify-tag',
  'archive',
]);

// git config keys whose value is run as a command (or loads more config that can be): setting one
// in the repository config runs it on later, ordinary git commands (SECURITY-ADVERSARIAL-5).
const GIT_EXEC_CONFIG_KEY =
  /^(core\.(hookspath|fsmonitor|pager|editor|sshcommand|askpass|gitproxy)|sequence\.editor|pager\.[^.]+|credential\.(helper|[^\n]+\.helper)|diff\.(external|[^.]+\.(command|textconv))|difftool\.[^.]+\.cmd|mergetool\.[^.]+\.cmd|merge\.[^.]+\.driver|filter\.[^.]+\.(clean|smudge|process)|gpg\.(program|[^.]+\.program)|uploadpack\.packobjectshook|remote\.[^\n]+\.(uploadpack|receivepack)|protocol\.[^\n]*allow|include\.path|includeif\.[^\n]+\.path|web\.browser|browser\.[^.]+\.(cmd|path)|man\.[^.]+\.(cmd|path)|alias\.[^.]+|init\.templatedir)$/i;

/** The key a `git config` write sets (after its options and the set/unset/add subcommand), else null. */
function gitConfigKey(rest) {
  const VALUE_OPTS = /^(--file|-f|--blob|--type|--default|--comment|--value|--fixed-value)$/;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (VALUE_OPTS.test(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (/^(set|unset|add|replace-all|rename-section|remove-section)$/.test(a)) continue;
    return a.toLowerCase();
  }
  return null;
}

/** Options that make an otherwise read-only git subcommand run a command or write recovered objects. */
function gitExecOptionVerdict(sub, rest) {
  const has = (...names) => rest.some((a) => names.includes(a));
  const hasPrefix = (...prefixes) => rest.some((a) => prefixes.some((p) => a.startsWith(p)));
  // The ext:: transport runs an arbitrary program (e.g. `git ls-remote ext::sh -c …`).
  if (rest.some((a) => /(^|[/@])ext::/.test(a))) return V('high', 'Uses the git ext:: transport, which runs a command');
  if (sub === 'grep' && (has('-O', '--open-files-in-pager') || hasPrefix('-O', '--open-files-in-pager=')))
    return V('high', 'Opens matches in a pager/command (git grep -O)');
  if (sub === 'ls-remote' && (has('--upload-pack', '-u', '--receive-pack') || hasPrefix('--upload-pack=', '--receive-pack=')))
    return V('high', 'Runs a remote helper command (git ls-remote)');
  if (sub === 'archive' && (has('--exec', '--remote') || hasPrefix('--exec=', '--remote=')))
    return V('high', 'Runs a remote command (git archive)');
  if (sub === 'fsck' && has('--lost-found')) return V('high', 'Writes recovered objects to disk (git fsck --lost-found)');
  return null;
}

function classifyGit(args, ctx) {
  let i = 0;
  let override = null;
  const flagOverride = () => {
    override = maxVerdict(override, V('high', 'Overrides git configuration (can run commands)'));
  };
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') {
      i += 2;
      continue;
    }
    if (a === '-c' || a === '--config-env') {
      flagOverride();
      i += 2;
      continue;
    }
    if (a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
      flagOverride();
      i += 2;
      continue;
    }
    if (/^-c./.test(a) || /^--config-env=/.test(a) || /^--(git-dir|work-tree|namespace|exec-path)(=|$)/.test(a)) {
      flagOverride();
      i += 1;
      continue;
    }
    i += 1;
  }
  const sub = (args[i] || '').toLowerCase();
  const rest = args.slice(i + 1);
  const shortHas = (ch) => rest.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(ch));
  // Fold the global-option override into every verdict.
  const done = (v) => maxVerdict(override, v);
  if (!sub) return done(V('low', 'Shows git help'));
  if (GIT_READ_ONLY_SUBS.has(sub)) {
    let v = V('low', 'Read-only git command');
    v = maxVerdict(v, gitExecOptionVerdict(sub, rest));
    const outPath = sub === 'archive' ? flagValue(rest, '-o', '--output') : flagValue(rest, '--output');
    if (outPath) {
      v = maxVerdict(v, V('medium', 'Writes git output to a file'));
      v = maxVerdict(v, targetVerdict(outPath, ctx));
    }
    return done(v);
  }
  if (sub === 'difftool') {
    if (rest.some((a) => /^(--extcmd|--tool|-x|-t)$/.test(a) || /^(--extcmd|--tool)=/.test(a) || /^-[xt]./.test(a)))
      return done(V('high', 'Runs an external command (git difftool --extcmd/--tool)'));
    return done(V('medium', 'Runs git difftool'));
  }
  if (sub === 'push') {
    if (
      rest.some(
        (a) =>
          /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--delete|-d|--prune)$/.test(a) ||
          (/^-[a-zA-Z]+$/.test(a) && /[fd]/.test(a)),
      ) ||
      rest.some((a) => /^\+/.test(a) || /^:[^/]/.test(a))
    ) {
      return done(V('high', 'Force-pushes or deletes remote git history/branches'));
    }
    return done(V('medium', 'Pushes commits to the remote'));
  }
  if (sub === 'reset' && rest.includes('--hard')) return done(V('high', 'Discards uncommitted changes (git reset --hard)'));
  if (sub === 'clean' && (rest.includes('--force') || shortHas('f'))) return done(V('high', 'Deletes untracked files (git clean -f)'));
  if (sub === 'branch') {
    if (rest.includes('-D') || (rest.includes('--delete') && (rest.includes('--force') || rest.includes('-f'))) || shortHas('D')) {
      return done(V('high', 'Force-deletes a git branch'));
    }
    if (
      rest.some((a) => /^(-d|--delete|-m|-M|--move|-c|-C|--copy|-u|--set-upstream-to.*|--unset-upstream|--edit-description)$/.test(a)) ||
      leadingWords(rest).length
    ) {
      return done(V('medium', 'Changes git branches'));
    }
    return done(V('low', 'Lists git branches'));
  }
  if (
    sub === 'checkout' &&
    (rest.includes('-f') ||
      rest.includes('--force') ||
      (rest.includes('--') && rest[rest.length - 1] === '.') ||
      (rest.length === 1 && rest[0] === '.'))
  ) {
    return done(V('high', 'Discards local changes (git checkout)'));
  }
  if (sub === 'restore' && !rest.includes('--staged') && rest.includes('.'))
    return done(V('high', 'Discards local changes (git restore .)'));
  if (sub === 'stash' && ['drop', 'clear'].includes(rest[0])) return done(V('high', 'Deletes stashed changes'));
  if (sub === 'stash' && ['list', 'show'].includes(rest[0])) return done(V('low', 'Reads git stashes'));
  if (sub === 'reflog')
    return done(['expire', 'delete'].includes(rest[0]) ? V('high', 'Deletes git reflog entries') : V('low', 'Reads the git reflog'));
  if (['filter-branch', 'filter-repo'].includes(sub)) return done(V('high', 'Rewrites git history'));
  if (sub === 'update-ref' && rest.includes('-d')) return done(V('high', 'Deletes a git ref'));
  if (sub === 'gc' && rest.some((a) => a.startsWith('--prune'))) return done(V('high', 'Permanently prunes git objects'));
  if (sub === 'config') {
    if (
      rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l|get|list|--show-origin|--show-scope)$/.test(a)) &&
      !rest.some((a) => /^(--unset|--add|--replace-all|set|unset)$/.test(a))
    ) {
      return done(V('low', 'Reads git config'));
    }
    if (rest.includes('--global') || rest.includes('--system')) return done(V('high', 'Changes global git configuration'));
    // --file names the config file written: ~/.gitconfig or .git/config by another name.
    const fi = rest.findIndex((a) => a === '--file' || a === '-f' || a.startsWith('--file='));
    const file = fi === -1 ? null : rest[fi].startsWith('--file=') ? rest[fi].slice(7) : rest[fi + 1];
    if (file) {
      const tv = targetVerdict(file, ctx, 'Writes git config to');
      if (tv) return done(maxVerdict(tv, V('high', 'Changes a git config file outside the repository')));
    }
    const key = gitConfigKey(rest);
    const unsetting = rest.some((a) => /^(--unset|--unset-all|unset)$/.test(a));
    // An alias runs a command only when its value starts with "!".
    if (key && !unsetting && GIT_EXEC_CONFIG_KEY.test(key) && (!key.startsWith('alias.') || rest.some((a) => a.startsWith('!')))) {
      return done(V('high', `Sets the git config key ${key}, which can run commands`));
    }
    return done(V('medium', 'Changes repository git config'));
  }
  if (sub === 'remote') {
    if (!rest.length || ['-v', '--verbose', 'show', 'get-url'].includes(rest[0])) return done(V('low', 'Lists git remotes'));
    return done(V('medium', 'Changes git remotes'));
  }
  if (sub === 'tag') {
    if (rest.includes('-d') || rest.includes('--delete')) return done(V('medium', 'Deletes a local git tag'));
    if (!leadingWords(rest).length || rest.includes('-l') || rest.includes('--list')) return done(V('low', 'Lists git tags'));
    return done(V('medium', 'Creates a git tag'));
  }
  if (sub === 'worktree' && rest[0] === 'list') return done(V('low', 'Lists git worktrees'));
  if (sub === 'submodule' && (!rest.length || rest[0] === 'status')) return done(V('low', 'Reads git submodules'));
  return done(V('medium', `Runs git ${sub}`));
}

function classifyGh(args) {
  const w = leadingWords(args, 3);
  const [a = '', b = ''] = w;
  if (!a || ['status', 'help', 'version', 'search', '--version'].includes(a)) return V('low', 'Reads GitHub');
  if (a === 'auth') {
    // A token in the transcript can be sent anywhere (CLASSIFIER-R3-05).
    if (b === 'token' || (b === 'status' && hasFlag(args, '-t', '--show-token'))) return V('high', 'Prints your GitHub token');
    return b === 'status' ? V('low', 'Reads GitHub sign-in') : V('medium', 'Changes GitHub CLI sign-in');
  }
  if (a === 'api') {
    // pflag accepts `-XPOST`, `-X=POST` and `-fkey=value` as well as the spaced forms (CLASSIFIER-R3-06).
    let method = (flagValue(args, '-X', '--method') || '').toUpperCase();
    for (const x of args) {
      const m = /^-i*X=?(.+)$/.exec(x);
      if (m) method = m[1].toUpperCase();
    }
    const fields = args.some((x) => x === '-f' || x === '-F' || /^-[fF]./.test(x) || /^--(field|raw-field|input)(=|$)/.test(x));
    if ((method && !['GET', 'HEAD'].includes(method)) || fields) return V('high', 'Changes GitHub data through the API');
    return V('low', 'Reads the GitHub API');
  }
  if (['view', 'list', 'ls', 'status', 'diff', 'checks', 'watch', 'download'].includes(b)) return V('low', `Reads GitHub (${a} ${b})`);
  if (a === 'pr' && ['merge'].includes(b)) return V('high', 'Merges a pull request');
  if (a === 'repo' && ['delete', 'archive', 'rename', 'edit', 'transfer', 'unarchive'].includes(b))
    return V('high', `Changes a GitHub repository (repo ${b})`);
  if (a === 'release' && ['create', 'delete', 'upload', 'edit', 'delete-asset'].includes(b))
    return V('high', `Publishes or changes a GitHub release (release ${b})`);
  if (['secret', 'variable'].includes(a) && ['set', 'delete', 'remove'].includes(b)) return V('high', `Changes GitHub ${a}s`);
  if (a === 'workflow' && ['run', 'enable', 'disable'].includes(b))
    return V('high', `Triggers or changes GitHub workflows (workflow ${b})`);
  if (['ssh-key', 'gpg-key', 'ruleset'].includes(a) && b !== 'list') return V('high', `Changes GitHub ${a}s`);
  if (a === 'extension' && ['install', 'upgrade'].includes(b)) return V('high', 'Installs a GitHub CLI extension');
  if (['issue', 'label', 'cache', 'gist', 'project'].includes(a) && b === 'delete') return V('high', `Deletes a GitHub ${a}`);
  if (a === 'gist' && b === 'create' && hasFlag(args, '--public', '-p')) return V('high', 'Creates a public gist');
  return V('medium', `Runs gh ${a} ${b}`.trim());
}

function classifyDocker(prog, args) {
  const w = leadingWords(args, 4);
  const [a = '', b = ''] = w;
  const label = `${prog} ${w.slice(0, 2).join(' ')}`.trim();
  if (!a) return V('low', 'Shows docker help');
  const READ = ['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'port', 'history', 'search', 'events', 'diff'];
  if (READ.includes(a)) return V('low', 'Read-only docker command');
  if (
    [
      'container',
      'image',
      'volume',
      'network',
      'context',
      'buildx',
      'builder',
      'system',
      'node',
      'service',
      'stack',
      'secret',
      'config',
      'plugin',
      'manifest',
      'compose',
      'swarm',
    ].includes(a)
  ) {
    if (['ls', 'list', 'inspect', 'ps', 'logs', 'show', 'df', 'config', 'top', 'images', 'version', 'port', 'history'].includes(b))
      return V('low', 'Read-only docker command');
    if (['rm', 'remove', 'prune', 'leave', 'kill'].includes(b)) return V('high', `Deletes docker data (${label})`);
    if (a === 'compose' && b === 'down' && hasFlag(args, '-v', '--volumes', '--rmi'))
      return V('high', 'Stops containers and deletes their volumes/images');
    if (a === 'compose' && b === 'push') return V('high', 'Publishes images to a registry');
  }
  if (['rm', 'rmi', 'prune'].includes(a)) return V('high', `Deletes docker data (${label})`);
  if (a === 'push') return V('high', 'Publishes an image to a registry');
  if (a === 'run' || a === 'create') {
    if (
      hasFlag(args, '--privileged', '--pid=host') ||
      args.some((x, k) => (x === '-v' || x === '--volume') && /^(\/|\/var\/run\/docker\.sock|[a-zA-Z]:\\?):/.test(args[k + 1] || '')) ||
      args.some((x) => /^--(volume|mount)=(\/:|.*source=\/,)/.test(x))
    ) {
      return V('high', 'Runs a container with access to the host system');
    }
  }
  return V('medium', `Runs ${label}`);
}

// npm/pnpm/yarn options that take a value, so `npm --registry URL publish` finds "publish" (CLASSIFIER-R3-07).
const NODE_PM_VALUE_FLAGS = new Set([
  '--registry',
  '--otp',
  '--tag',
  '--userconfig',
  '--globalconfig',
  '--prefix',
  '-C',
  '--workspace',
  '-w',
  '--access',
  '--cache',
  '--loglevel',
  '--filter',
  '-F',
  '--cwd',
  '--dir',
  '--scope',
  '--auth-type',
  '--provenance-file',
]);
const NODE_PM_PUBLISH = ['publish', 'unpublish', 'deprecate', 'owner', 'access', 'dist-tag', 'team'];

function classifyNodePm(prog, args) {
  const w = leadingWords(args, 3, NODE_PM_VALUE_FLAGS);
  let a = w[0] || '';
  // Backstop for a value flag not listed above: a publish word right after a word that may be
  // that flag's value (`npm --some-flag value publish`) is the subcommand.
  if (!NODE_PM_PUBLISH.includes(a)) {
    for (let i = 1; i < Math.min(args.length, 6); i += 1) {
      if (NODE_PM_PUBLISH.includes(args[i]) && !args[i - 1].startsWith('-') && i >= 2 && /^-/.test(args[i - 2]) && !args[i - 2].includes('=')) {
        a = args[i];
        break;
      }
    }
  }
  const global = hasFlag(args, '-g', '--global', '--location=global') || (prog === 'yarn' && a === 'global');
  if (NODE_PM_PUBLISH.includes(a) && !(a === 'dist-tag' && ['ls', 'list'].includes(w[1]))) {
    return V('high', `Publishes or changes a package on the registry (${prog} ${a})`);
  }
  if (a === 'config' || a === 'set') {
    if (['get', 'list', 'ls'].includes(w[1]) || (a === 'config' && !w[1])) return V('low', `Reads ${prog} config`);
    return V('high', `Changes ${prog} configuration`);
  }
  if (['install', 'i', 'add', 'ci', 'isntall', 'in', 'update', 'up', 'upgrade', 'link', 'ln'].includes(a) || (prog === 'yarn' && !a)) {
    return global ? V('high', `Installs a global package (${prog} ${a} -g)`) : V('medium', 'Installs project dependencies');
  }
  if (['uninstall', 'remove', 'rm', 'un', 'r', 'unlink'].includes(a)) {
    return global ? V('high', 'Uninstalls a global package') : V('medium', 'Removes project dependencies');
  }
  if (
    [
      'ls',
      'list',
      'll',
      'la',
      'view',
      'info',
      'show',
      'outdated',
      'why',
      'explain',
      'root',
      'bin',
      'prefix',
      'whoami',
      'search',
      'help',
      'doctor',
      'query',
      'fund',
      'licenses',
    ].includes(a) ||
    (a === 'audit' && !w.includes('fix')) ||
    (!a && hasFlag(args, '-v', '--version', '-h', '--help'))
  ) {
    return V('low', `Reads package information (${prog} ${a})`.trim());
  }
  const script = ['run', 'run-script', 'rum', 'urn'].includes(a) ? w[1] || '' : a;
  if (script && DEPLOY_WORD.test(script)) return V('high', `Runs the "${script}" script, which looks like a deploy or release`);
  return V('medium', `Runs ${prog} ${a}${script && script !== a ? ` ${script}` : ''}`.trim());
}

function classifyPip(args) {
  const w = leadingWords(args, 2);
  const a = w[0] || '';
  if (a === 'install' || (a === 'download' && hasFlag(args, '--break-system-packages'))) {
    return V(
      'high',
      hasFlag(args, '--break-system-packages') ? 'Installs Python packages over the system Python' : 'Installs Python packages',
    );
  }
  if (a === 'uninstall') return V('high', 'Uninstalls Python packages');
  if (a === 'config' && ['set', 'unset', 'edit'].includes(w[1])) return V('high', 'Changes pip configuration');
  if (
    ['list', 'show', 'freeze', 'check', 'help', 'search', 'inspect', 'index', 'debug', 'hash', 'cache'].includes(a) ||
    hasFlag(args, '--version', '-V')
  ) {
    return V('low', 'Reads Python package information');
  }
  return V('medium', `Runs pip ${a}`.trim());
}

const SYS_PKG = new Set([
  'apt',
  'apt-get',
  'aptitude',
  'dnf',
  'yum',
  'zypper',
  'pacman',
  'yay',
  'paru',
  'apk',
  'snap',
  'flatpak',
  'port',
  'emerge',
  'xbps-install',
  'xbps-remove',
  'nix-env',
  'brew',
  'choco',
  'winget',
  'scoop',
  'mas',
  'pkg',
  'dpkg',
  'rpm',
  'opkg',
  'pipx',
  'gem',
  'cargo',
  'go',
  'dotnet',
  'rustup',
  'sdk',
  'asdf',
  'mise',
  'nvm',
  'volta',
  'conda',
  'mamba',
  'micromamba',
]);

function classifySysPkg(prog, args) {
  const w = leadingWords(args, 3);
  const a = w[0] || '';
  const label = `${prog} ${a}`.trim();
  if (prog === 'pacman' || prog === 'yay' || prog === 'paru') {
    const op = args.find((x) => /^-[A-Za-z]/.test(x)) || '';
    if (/^-(Q|Ss|Si|F)/.test(op) || hasFlag(args, '--version', '-V')) return V('low', 'Reads package information');
    if (/^-(S|U|R)/.test(op) || /^--(sync|remove|upgrade)/.test(op))
      return V('high', `Installs or removes system packages (${prog} ${op})`);
    return V('medium', `Runs ${prog}`);
  }
  if (prog === 'dpkg' || prog === 'rpm') {
    if (hasFlag(args, '-i', '--install', '-r', '--remove', '-P', '--purge', '-U', '-e', '--erase'))
      return V('high', `Installs or removes system packages (${prog})`);
    return V('low', 'Reads package information');
  }
  if (prog === 'go') {
    if (a === 'install') return V('high', 'Installs a Go program');
    return V('medium', `Runs go ${a}`.trim());
  }
  if (prog === 'cargo') {
    if (a === 'install' || a === 'uninstall') return V('high', `${a === 'install' ? 'Installs' : 'Uninstalls'} a Rust program`);
    if (['publish', 'yank', 'owner'].includes(a)) return V('high', 'Publishes a crate');
    return V('medium', `Runs cargo ${a}`.trim());
  }
  if (prog === 'gem') {
    if (['push', 'yank', 'owner'].includes(a)) return V('high', 'Publishes a gem');
    if (['install', 'uninstall', 'update'].includes(a)) return V('high', `${humanize(a)}s Ruby gems`);
    return V(['list', 'search', 'info', 'contents', 'env', 'help'].includes(a) ? 'low' : 'medium', `Runs gem ${a}`.trim());
  }
  if (prog === 'dotnet') {
    if (a === 'nuget' && w[1] === 'push') return V('high', 'Publishes a NuGet package');
    if (a === 'tool' && ['install', 'uninstall', 'update'].includes(w[1]) && hasFlag(args, '-g', '--global'))
      return V('high', 'Installs a global .NET tool');
    if (a === 'workload' && ['install', 'uninstall', 'update'].includes(w[1])) return V('high', 'Changes .NET workloads');
    return V('medium', `Runs dotnet ${a}`.trim());
  }
  if (prog === 'conda' || prog === 'mamba' || prog === 'micromamba') {
    if (['install', 'remove', 'uninstall', 'update', 'upgrade'].includes(a) && !hasFlag(args, '-n', '--name', '-p', '--prefix'))
      return V('high', 'Changes the base conda environment');
    if (['list', 'info', 'search'].includes(a)) return V('low', 'Reads conda information');
    return V('medium', `Runs ${label}`);
  }
  if (prog === 'brew' && (a === 'update' || (a === 'services' && ['list', 'info'].includes(w[1])))) return V('medium', `Runs ${label}`);
  const MUT = [
    'install',
    'reinstall',
    'remove',
    'purge',
    'autoremove',
    'uninstall',
    'erase',
    'upgrade',
    'dist-upgrade',
    'full-upgrade',
    'update',
    'add',
    'del',
    'tap',
    'untap',
    'link',
    'unlink',
    'switch',
    'pin',
    'refresh',
    'revert',
    'cleanup',
    'clean',
    'use',
    'global',
    'default',
    'services',
    'set',
  ];
  if (MUT.includes(a) || (prog === 'snap' && a === 'remove')) {
    if (['use', 'switch', 'default', 'global', 'set'].includes(a) && ['sdk', 'asdf', 'mise', 'nvm', 'volta', 'rustup'].includes(prog)) {
      return V('medium', `Switches a tool version (${label})`);
    }
    return V('high', `Installs or removes software on the system (${label})`);
  }
  if (
    [
      'list',
      'search',
      'show',
      'info',
      'policy',
      'outdated',
      'deps',
      'leaves',
      'doctor',
      'config',
      'home',
      'desc',
      'which',
      'current',
      'ls',
      'ls-remote',
      'help',
      'madison',
      'depends',
      'rdepends',
    ].includes(a) ||
    hasFlag(args, '--version', '-v', '-V')
  ) {
    return V('low', 'Reads package information');
  }
  return V('medium', `Runs ${label}`);
}

function sqlTexts(prog, args) {
  const texts = [];
  const valFlags = ['-c', '--command', '-e', '--execute', '--eval', '-Q', '-q', '--query', '-cmd'];
  for (let i = 0; i < args.length; i += 1) {
    if (valFlags.includes(args[i]) && args[i + 1] != null) texts.push(args[i + 1]);
    for (const f of ['--command=', '--execute=', '--eval=', '--query=']) if (args[i].startsWith(f)) texts.push(args[i].slice(f.length));
  }
  if (['sqlite3', 'sqlite', 'duckdb'].includes(prog)) {
    const pos = args.filter((a) => !a.startsWith('-'));
    if (pos.length >= 2) texts.push(pos.slice(1).join(' '));
  }
  if (prog === 'redis-cli') texts.push(args.filter((a) => !a.startsWith('-')).join(' '));
  return texts;
}

function psParams(args) {
  // PowerShell-style "-Name value" parsing (switches are known names).
  const SWITCHES =
    /^-(recurse|r|rec|recu|recur|recurs|force|fo|forc|whatif|confirm|nonewline|append|passthru|noclobber|wait|nonewwindow|usebasicparsing|asjob|verbose|debug|erroraction|includeuserprofile|container|scope|norestart|allowclobber|skippublishercheck)(:\S+)?$/i;
  const named = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (/^-[A-Za-z]/.test(a)) {
      const name = a.replace(/:.*$/, '').slice(1).toLowerCase();
      if (a.includes(':') && !/^-[A-Za-z]+:$/.test(a)) {
        named[name] = a.slice(a.indexOf(':') + 1);
      } else if (SWITCHES.test(a) || i + 1 >= args.length || /^-[A-Za-z]/.test(args[i + 1])) {
        named[name] = true;
      } else {
        named[name] = args[i + 1];
        i += 1;
      }
    } else positional.push(a);
  }
  return { named, positional };
}

/** Value of a named PowerShell parameter, honouring unambiguous prefixes (-Dest for -Destination). */
function psNamed(named, ...names) {
  for (const [k, v] of Object.entries(named)) {
    if (names.some((n) => n === k || (k.length >= 2 && n.startsWith(k)))) return v;
  }
  return undefined;
}

const PS_RECURSE = /^-r(e(c(u(r(se?)?)?)?)?)?(:\$?true)?$/i;

/**
 * The trailing command of a wrapper: skip leading options (value-taking ones
 * consume the next token), honour a `--` separator, then skip `skipPos` leading
 * positionals (e.g. a lock file or chroot NEWROOT) before the command.
 */
function wrapTrailing(args, valueFlags = new Set(), skipPos = 0) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--') {
      i += 1;
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      i += valueFlags.has(a) ? 2 : 1;
      continue;
    }
    break;
  }
  i += skipPos;
  return args.slice(i);
}

/** Non-flag positional arguments, skipping the values of the given value-taking flags. */
function positionals(args, valueFlags = new Set()) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i + 1).filter((x) => x !== ''));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      if (valueFlags.has(a)) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Paths a command writes to or deletes, as raw strings.
 */
function writeTargets(p, args, tk) {
  const out = [];
  for (const r of tk.redirects) if (r.write && r.target) out.push(r.target);
  const nonFlag = args.filter((a) => !a.startsWith('-'));
  const lastNonFlag = nonFlag.length ? nonFlag[nonFlag.length - 1] : null;
  switch (p) {
    case 'tee':
      out.push(...nonFlag);
      break;
    case 'cp':
    case 'mv':
    case 'install':
    case 'ln':
    case 'rsync':
    case 'scp':
    case 'ditto':
    case 'rename': {
      const t = flagValue(args, '-t', '--target-directory');
      if (t) out.push(t);
      else if (nonFlag.length >= 2) out.push(lastNonFlag);
      break;
    }
    case 'dd':
      for (const a of args) if (a.startsWith('of=')) out.push(a.slice(3));
      break;
    case 'sed':
    case 'perl':
    case 'ruby':
      // the first non-flag word is the script (or the -e value); the rest are edited in place
      if (args.some((a) => a.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(a))) out.push(...nonFlag.slice(1));
      break;
    case 'touch':
    case 'truncate':
    case 'mkdir':
    case 'rmdir':
    case 'rm':
    case 'unlink':
    case 'shred':
    case 'srm':
    case 'trash':
    case 'del':
    case 'erase':
    case 'rd':
      out.push(...nonFlag.filter((a) => !/^\/[a-z]$/i.test(a)));
      break;
    case 'chmod':
    case 'chown':
    case 'chgrp':
      out.push(...nonFlag.slice(1));
      break;
    case 'curl':
      for (const v of [flagValue(args, '-o', '--output')]) if (v) out.push(v);
      break;
    case 'wget':
      for (const v of [flagValue(args, '-O', '--output-document'), flagValue(args, '-P', '--directory-prefix')]) if (v) out.push(v);
      break;
    case 'tar': {
      const d = flagValue(args, '-C', '--directory');
      if (d && args.some((a) => /^-?[a-zA-Z]*x/.test(a) || a === '--extract')) out.push(d);
      break;
    }
    case 'unzip': {
      const d = flagValue(args, '-d');
      if (d) out.push(d);
      break;
    }
    case 'ssh-keygen': {
      const f = flagValue(args, '-f');
      if (f && !args.some((a) => /^-[lyFBH]$/.test(a))) out.push(f);
      break;
    }
    case 'uniq': {
      // uniq [OPTION] [INPUT [OUTPUT]] — the 2nd positional is an output file.
      const pos = positionals(args, new Set(['-f', '--skip-fields', '-s', '--skip-chars', '-w', '--check-chars']));
      if (pos.length >= 2) out.push(pos[1]);
      break;
    }
    case 'xxd': {
      // xxd [options] [infile [outfile]] — the 2nd positional is an output file (with or without -r).
      const pos = positionals(args, new Set(['-c', '-cols', '-g', '-groupsize', '-l', '-len', '-o', '-s', '-seek']));
      if (pos.length >= 2) out.push(pos[1]);
      break;
    }
    case 'tree': {
      const o = flagValue(args, '-o');
      if (o) out.push(o);
      break;
    }
    case 'base64':
    case 'sort':
    case 'shuf':
    case 'iconv':
    case 'strace':
    case 'ltrace': {
      const o = flagValue(args, '-o', '--output');
      if (o) out.push(o);
      break;
    }
    case 'split': {
      // split [OPTION] [FILE [PREFIX]] — files are written as PREFIXaa, PREFIXab, …
      const pfx = positionals(
        args,
        new Set(['-a', '--suffix-length', '-b', '--bytes', '-C', '--line-bytes', '-l', '--lines', '-n', '--number', '--additional-suffix']),
      );
      if (pfx.length >= 2) out.push(pfx[1]);
      break;
    }
    case 'csplit': {
      const o = flagValue(args, '-f', '--prefix');
      if (o) out.push(o);
      break;
    }
    case 'remove-item':
    case 'new-item':
    case 'set-content':
    case 'add-content':
    case 'out-file':
    case 'clear-content':
    case 'copy-item':
    case 'move-item':
    case 'rename-item':
    case 'tee-object':
    case 'set-acl':
    case 'invoke-webrequest':
    case 'invoke-restmethod':
    case 'export-csv':
    case 'set-itemproperty': {
      const { named, positional } = psParams(args);
      const pathVal = psNamed(named, 'path', 'literalpath', 'filepath');
      const dest = psNamed(named, 'destination');
      const outFile = psNamed(named, 'outfile');
      if (['copy-item', 'move-item'].includes(p)) {
        if (typeof dest === 'string') out.push(dest);
        else if (positional[1]) out.push(positional[1]);
      } else if (['invoke-webrequest', 'invoke-restmethod'].includes(p)) {
        if (typeof outFile === 'string') out.push(outFile);
      } else if (typeof pathVal === 'string') out.push(...pathVal.split(',').map((x) => x.trim()));
      else if (positional[0]) out.push(positional[0]);
      if (p === 'rename-item' || p === 'move-item') {
        if (typeof pathVal === 'string') out.push(pathVal);
        else if (positional[0]) out.push(positional[0]);
      }
      break;
    }
    default:
      break;
  }
  return out.filter((x) => x != null && x !== '');
}

// cmd.exe builtins (and xcopy/robocopy) that write files. Their switches are /x, never -x.
const CMD_WRITERS = new Set(['copy', 'xcopy', 'robocopy', 'move', 'ren', 'rename', 'md', 'mkdir']);

/**
 * Paths a cmd.exe builtin writes, as raw strings: copy/move write their last path (copy's
 * destination defaults to the current folder), xcopy and robocopy their second, ren the file it
 * renames, md every folder. `/y`-style switches are dropped first.
 */
function cmdWriteTargets(p, args, tk) {
  const out = [];
  for (const r of tk.redirects) if (r.write && r.target) out.push(r.target);
  const pos = args.filter((a) => a && !/^\/[A-Za-z0-9?-]+(:\S*)?$/.test(a) && a !== '+');
  switch (p) {
    case 'copy':
    case 'move':
      if (pos.length >= 2) out.push(pos[pos.length - 1]);
      break;
    case 'xcopy':
    case 'robocopy':
      if (pos.length >= 2) out.push(pos[1]);
      break;
    case 'ren':
    case 'rename':
      if (pos.length) out.push(pos[0]);
      break;
    case 'md':
    case 'mkdir':
      out.push(...pos);
      break;
    default:
      break;
  }
  return out.filter((x) => x != null && x !== '');
}

/**
 * Check a written path: device, self-escalation, sensitive, outside project.
 * @returns {{risk:string, reason:string}|null}
 */
function targetVerdict(raw, ctx, verb = 'Writes to') {
  const r = str(raw).replace(/^@/, '');
  if (NULL_DEVICE_RE.test(r)) return null;
  if (DISK_DEVICE_RE.test(r)) return V('critical', `Writes directly to the disk device ${r}`);
  const t = resolveTarget(r, ctx, ctx.cwd);
  if (!t) return null;
  if (!t.win && DISK_DEVICE_RE.test(t.abs)) return V('critical', `Writes directly to the disk device ${t.abs}`);
  const sens = sensitiveKind(t, ctx) || realSensitiveKind(t, ctx);
  if (sens && sens.level === 'critical') return V('critical', `${verb} ${sens.what} (self-escalation)`);
  if (sens) return V('high', `${verb} ${sens.what}`);
  if (insideProject(t, ctx) || isTempPath(t, ctx)) return null;
  return V('high', `${verb} a path outside the project: ${truncate(t.abs, 120)}`);
}

function selfEscalationText(text) {
  return /\.claude[\\/]+settings(\.[\w-]+)?\.json|\.claude-anywhere[\\/]+config\.json|\.claude\.json\b|managed-settings\.json/i.test(text);
}

function isScriptPath(word) {
  return /[\\/]/.test(word) || /\.(sh|bash|zsh|ps1|py|rb|pl|js|mjs|cjs|ts|cmd|bat)$/i.test(word);
}

// ------------------------------------------------------------------ reading credentials

// Programs that print (or copy) the contents of the files they are given (CLASSIFIER-R3-04).
const CONTENT_READERS = new Set([
  'cat',
  'bat',
  'batcat',
  'less',
  'more',
  'most',
  'head',
  'tail',
  'nl',
  'tac',
  'rev',
  'cut',
  'paste',
  'fold',
  'column',
  'expand',
  'unexpand',
  'join',
  'comm',
  'cmp',
  'diff',
  'diff3',
  'sdiff',
  'sort',
  'uniq',
  'shuf',
  'split',
  'csplit',
  'pr',
  'fmt',
  'look',
  'iconv',
  'grep',
  'egrep',
  'fgrep',
  'zgrep',
  'rg',
  'ag',
  'ack',
  'findstr',
  'jq',
  'yq',
  'gojq',
  'sed',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'xxd',
  'hexdump',
  'hd',
  'od',
  'strings',
  'base64',
  'base32',
  'basenc',
  'zcat',
  'gzcat',
  'bzcat',
  'xzcat',
  'zstdcat',
  'lzcat',
  'zless',
  'zmore',
  'openssl',
  'gpg',
  'dd',
  'cp',
  'scp',
  'rsync',
  'type',
  'get-content',
  'select-string',
  'copy-item',
  'import-csv',
  'import-clixml',
  'format-hex',
  'tar',
  'zip',
  '7z',
  '7za',
  'gzip',
  'bzip2',
  'xz',
  'zstd',
  'compress-archive',
]);
const GREP_VALUE_FLAGS = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--label']);
const RG_VALUE_FLAGS = new Set([
  ...GREP_VALUE_FLAGS,
  '-g',
  '-t',
  '-T',
  '-j',
  '-M',
  '-E',
  '-r',
  '--glob',
  '--iglob',
  '--type',
  '--type-not',
  '--type-add',
  '--threads',
  '--max-columns',
  '--max-depth',
  '--max-filesize',
  '--sort',
  '--sortr',
  '--color',
  '--colors',
  '--encoding',
  '--engine',
  '--ignore-file',
  '--path-separator',
  '--replace',
  '--context-separator',
  '--pre',
  '--pre-glob',
  '--hostname-bin',
]);

// Credential stores under the home folder; a folder holding one of them holds credentials.
const CRED_HOME_PATHS = [
  ['.ssh'],
  ['.aws'],
  ['.azure'],
  ['.kube'],
  ['.gnupg'],
  ['.password-store'],
  ['.terraform.d'],
  ['.config', 'gcloud'],
  ['.config', 'gh'],
  ['.config', 'op'],
  ['.config', 'rclone'],
  ['.config', 'hub'],
  ['.config', 'doctl'],
  ['.config', 'containers', 'auth.json'],
  ['.config', 'google-chrome'],
  ['.config', 'chromium'],
  ['.config', 'BraveSoftware'],
  ['.config', 'microsoft-edge'],
  ['.mozilla'],
  ['.local', 'share', 'keyrings'],
  ['.local', 'share', 'kwalletd'],
  ['Library', 'Keychains'],
  ['Library', 'Cookies'],
  ['Library', 'Application Support', 'Google', 'Chrome'],
  ['Library', 'Application Support', 'Firefox'],
  ['AppData', 'Roaming', 'gcloud'],
  ['AppData', 'Roaming', 'Microsoft', 'Credentials'],
  ['AppData', 'Roaming', 'Microsoft', 'Protect'],
  ['AppData', 'Roaming', 'Mozilla'],
  ['AppData', 'Local', 'Google', 'Chrome', 'User Data'],
  ['AppData', 'Local', 'Microsoft', 'Edge', 'User Data'],
  ['.docker', 'config.json'],
  ['.netrc'],
  ['_netrc'],
  ['.npmrc'],
  ['.pypirc'],
  ['.git-credentials'],
  ['.terraformrc'],
  ['.pgpass'],
  ['.my.cnf'],
  ['.mylogin.cnf'],
  ['.vault-token'],
  ['.cargo', 'credentials'],
  ['.cargo', 'credentials.toml'],
  ['.gem', 'credentials'],
  ['.databrickscfg'],
  ['.s3cfg'],
  ['.boto'],
  ['.bash_history'],
  ['.zsh_history'],
  ['.claude', '.credentials.json'],
  ['.claude.json'],
  ['.claude-anywhere', 'config.json'],
  ['.claude-anywhere', 'daemon.json'],
];

function credLocations(ctx, win) {
  const P = win ? path.win32 : path.posix;
  if ((ctx.platform === 'win32') !== win) return [];
  // (_netrc and AppData are Windows names; elsewhere they would only make `cat ~/*` look risky.)
  const out = CRED_HOME_PATHS.filter((segs) => win || !/^(_netrc|AppData)$/.test(segs[0])).map((segs) => normFor(win, P.join(ctx.homeDir, ...segs)));
  if (ctx.anywhereHome) {
    for (const f of [['config.json'], ['daemon.json'], ['run', 'mcp.json'], ['calls', 'call', 'engine', 'mcp.json']]) out.push(normFor(win, P.join(ctx.anywhereHome, ...f)));
  }
  return out;
}

/**
 * A folder read as a whole that holds credential stores: searched recursively (`grep -r x ~`,
 * `rg x ~/.config`), or globbed (`cat ~/.claude-anywhere/*`, `cat ~/.*`). The place, else null.
 */
function credentialAncestor(t, ctx, { recursive, raw }) {
  const P = t.win ? path.win32 : path.posix;
  const a = normFor(t.win, t.abs);
  const locs = credLocations(ctx, t.win);
  if (!locs.length) return null;
  const home = normFor(t.win, ctx.homeDir);
  const name = (d) => (d === home ? 'your home folder' : shortAbs({ ...t, abs: d }, ctx));
  if (recursive) return locs.some((l) => isUnder(l, a, t.win)) ? name(a) : null;
  let dir = null;
  let pat = null;
  if (t.glob) {
    dir = a;
    pat = /(^|[\\/])\.\*$/.test(str(raw)) ? '.*' : '*';
  } else if (/[*?]/.test(P.basename(a))) {
    dir = P.dirname(a);
    pat = P.basename(a);
  }
  if (!dir) return null;
  const re = globToRegExp(pat, t.win ? 'i' : '');
  const hit = locs.some((l) => P.dirname(l) === dir && re.test(P.basename(l)) && (pat.startsWith('.') || !P.basename(l).startsWith('.')));
  return hit ? name(dir) : null;
}

/**
 * Folders a program reads as a whole tree: grep -r / rg / ag / ack search paths, and the sources
 * of an archive being created (tar c, zip -r, 7z a, Compress-Archive). null when it reads none.
 */
function recursiveSearchPaths(prog, args) {
  if (prog === 'tar') {
    const bundle = args[0] && !args[0].startsWith('-') ? args[0] : '';
    const create = /c/.test(bundle) || args.some((a) => a === '--create' || (/^-[a-zA-Z]+$/.test(a) && a.includes('c')));
    if (!create) return null;
    const f = flagValue(args, '-f', '--file');
    const pos = positionals(bundle ? args.slice(1) : args, new Set(['-f', '--file', '-C', '--directory', '-T', '--files-from', '-X', '--exclude-from']));
    // `tar czf out.tgz src`: the archive name is the first word after a bundle ending in f.
    const srcs = bundle && /f/.test(bundle) && !f ? pos.slice(1) : pos.filter((x) => x !== f);
    return srcs.length ? srcs : null;
  }
  if (prog === 'zip') {
    if (!args.some((a) => a === '--recurse-paths' || (/^-[a-zA-Z]+$/.test(a) && /r/i.test(a)))) return null;
    return positionals(args, new Set(['-x', '-i', '-b', '-n', '-P', '-t', '-tt', '-Z'])).slice(1);
  }
  if (prog === '7z' || prog === '7za') {
    const pos = positionals(args);
    return pos[0] === 'a' ? pos.slice(2) : null;
  }
  if (prog === 'compress-archive') {
    const { named, positional } = psParams(args);
    const p = psNamed(named, 'path', 'literalpath');
    return typeof p === 'string' ? p.split(',').map((x) => x.trim()) : positional.slice(0, 1);
  }
  const rg = ['rg', 'ag', 'ack'].includes(prog);
  const grep = ['grep', 'egrep', 'fgrep', 'zgrep'].includes(prog);
  if (!rg && !grep) return null;
  if (
    grep &&
    !args.some(
      (a, k) =>
        /^(--recursive|--dereference-recursive|--directories=recurse)$/.test(a) ||
        (/^-[a-zA-Z]+$/.test(a) && /[rR]/.test(a)) ||
        (a === '-d' && args[k + 1] === 'recurse'),
    )
  ) {
    return null;
  }
  const valueFlags = rg ? RG_VALUE_FLAGS : GREP_VALUE_FLAGS;
  const pos = positionals(args, valueFlags);
  const patternGiven = args.some((a) => /^(-e|-f|--regexp|--file)(=|$)/.test(a) || /^-[ef]./.test(a));
  const paths = patternGiven ? pos : pos.slice(1);
  return paths.length ? paths : ['.'];
}

/**
 * A credential file read by any program that prints file contents, or fed to any program on
 * stdin (`cat < ~/.ssh/id_rsa`, `while read l; do :; done < ~/.aws/credentials`).
 */
function readerVerdict(prog, psProg, args, tk, ctx) {
  const net = NETWORK_PROGS.has(prog) || NETWORK_PROGS.has(psProg);
  const say = (cred) => V('high', net ? `May send ${cred.what} over the network` : `Reads ${cred.what}`);
  // CLASSIFIER-R3-02: stdin redirects (`<`, `0<`) and here-strings.
  const stdin = tk.redirects.filter((r) => !r.write && r.target).map((r) => r.target).concat(tk.herestrings || []);
  for (const c of stdin) {
    const cred = readCredentialKind(c, ctx, ctx.cwd);
    if (cred && !cred.env) return say(cred);
  }
  if (!CONTENT_READERS.has(prog) && !CONTENT_READERS.has(psProg)) return null;
  for (const a0 of args) {
    let a = a0;
    if (a.startsWith('-')) {
      // --opt=value names a file as often as a plain argument does.
      const eq = a.indexOf('=');
      if (!a.startsWith('--') || eq === -1) continue;
      a = a.slice(eq + 1);
    } else if (prog === 'dd' && a.startsWith('if=')) a = a.slice(3);
    if (!a) continue;
    const cred = readCredentialKind(a, ctx, ctx.cwd);
    if (cred && !cred.env) return say(cred);
    const t = resolveTarget(a, ctx, ctx.cwd);
    const where = t && credentialAncestor(t, ctx, { recursive: false, raw: a });
    if (where) return V('high', `Reads credential files in ${where}`);
  }
  const archiver = /^(tar|zip|7za?|compress-archive)$/.test(psProg);
  for (const p of recursiveSearchPaths(psProg, args) || []) {
    const t = resolveTarget(p, ctx, ctx.cwd);
    const where = t && credentialAncestor(t, ctx, { recursive: true });
    if (where) return V('high', `${archiver ? 'Archives' : 'Searches'} ${where}, which holds credential files`);
  }
  return null;
}

// ------------------------------------------------------------------ PowerShell expressions

/** Replace PowerShell string literals with \u0001N\u0001 placeholders, keeping their values. */
function maskPsStrings(text) {
  const lits = [];
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c !== "'" && c !== '"') {
      out += c;
      continue;
    }
    let j = i + 1;
    let val = '';
    for (; j < text.length; j += 1) {
      if (text[j] === c) {
        if (text[j + 1] === c) {
          val += c;
          j += 1;
          continue;
        }
        break;
      }
      if (c === '"' && text[j] === '`' && j + 1 < text.length) {
        val += text[j + 1];
        j += 1;
        continue;
      }
      val += text[j];
    }
    lits.push(val);
    out += `\u0001${lits.length - 1}\u0001`;
    i = j;
  }
  return { masked: out, lits };
}

/** The top-level, comma-separated arguments of a call whose "(" is at `open`, with string values. */
function psCallArgs(masked, open, lits) {
  let d = 0;
  let cur = '';
  const out = [];
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') d += 1;
    if (c === ')' || c === ']' || c === '}') d -= 1;
    if (d === 0) break;
    if (i === open) continue;
    if (c === ',' && d === 1) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => {
    const v = x.trim();
    const m = /^\u0001(\d+)\u0001$/.exec(v);
    return m ? lits[Number(m[1])] : v;
  });
}

// .NET types whose static methods only compute or read a value (CLASSIFIER-R3-08).
const PS_PURE_TYPES =
  /^(math|mathf|string|char|convert|datetime|datetimeoffset|timespan|timezoneinfo|guid|version|uri|bitconverter|u?int(16|32|64)?|long|double|single|float|decimal|byte|sbyte|bool(ean)?|array|object|enum|text\.encoding|text\.stringbuilder|text\.regularexpressions\.regex|regex|io\.path|net\.ipaddress|net\.webutility|net\.dns|web\.httputility|globalization\.cultureinfo|stringcomparer|linq\.enumerable|collections\.[\w.]+|management\.automation\.(language\.parser|wildcardpattern)|wildcardpattern|xml|xml\.xmldocument|console|security\.principal\.windowsidentity|runtime\.interopservices\.runtimeinformation|threading\.thread|diagnostics\.stopwatch|psobject|pscustomobject|hashtable|ordered|type|void)$/;

/**
 * Constructors that open a file: `[IO.StreamWriter]::new(path)` and `New-Object IO.FileStream
 * path, Create` truncate or create it, so they are writes; a StreamReader is a read. Else null.
 */
function psConstructorVerdict(type, callArgs, ctx) {
  const t = String(type || '')
    .toLowerCase()
    .replace(/^system\./, '');
  const p0 = callArgs[0];
  if (/^io\.(streamwriter|filestream|binarywriter)$/.test(t)) {
    return maxVerdict(V('medium', `Opens a file for writing (${t})`), p0 ? targetVerdict(p0, ctx) : null);
  }
  if (/^io\.(streamreader|binaryreader)$/.test(t) && p0) {
    const cred = readCredentialKind(p0, ctx, ctx.cwd);
    if (cred && !cred.env) return V('high', `Reads ${cred.what}`);
  }
  return null;
}

/** Verdict for a static .NET call `[Type]::Method(args)` (CLASSIFIER-R3-08). */
function psStaticCallVerdict(type, method, callArgs, ctx) {
  const t = type.toLowerCase().replace(/`/g, '').replace(/\s+/g, '').replace(/^system\./, '');
  const m = method.toLowerCase();
  const label = `[${type}]::${method}`;
  const p0 = callArgs[0];
  const tv = (raw, verb) => (raw ? targetVerdict(raw, ctx, verb) : null);
  if (m === 'new') return psConstructorVerdict(t, callArgs, ctx) || V('low', 'Creates a .NET object');
  if (t === 'scriptblock' && m === 'create') return V('high', 'Builds a script block from text at run time (code that cannot be inspected)');
  if (/^io\.(directory|directoryinfo)$/.test(t)) {
    if (m === 'delete') {
      const recursive = callArgs.slice(1).some((x) => /^\$true$/i.test(x));
      return maxVerdict(rmVerdict([], ctx, { recursive, targets: p0 ? [p0] : [], label }), tv(p0, 'Deletes'));
    }
    if (/^(get|enumerate|exists)/.test(m)) return V('low', 'Lists folders (.NET)');
    return maxVerdict(V('medium', `Changes folders (${label})`), maxVerdict(tv(p0, m === 'move' ? 'Moves' : 'Writes to'), tv(callArgs[1])));
  }
  if (/^io\.(file|fileinfo)$/.test(t)) {
    if (m === 'delete') return maxVerdict(V('medium', `Deletes a file (${label})`), tv(p0, 'Deletes'));
    if (/^(read\w*|openread|opentext|exists|get\w*)$/.test(m)) {
      const cred = p0 ? readCredentialKind(p0, ctx, ctx.cwd) : null;
      return cred && !cred.env ? V('high', `Reads ${cred.what}`) : V('low', 'Reads a file (.NET)');
    }
    if (/^(move|copy|replace)$/.test(m)) {
      return maxVerdict(V('medium', `${humanize(m)}s a file (${label})`), maxVerdict(tv(callArgs[1]), m === 'copy' ? null : tv(p0, 'Moves')));
    }
    // WriteAll*, AppendAll*, Create*, Open*, Set*, Encrypt, Decrypt…
    return maxVerdict(V('medium', `Writes a file (${label})`), tv(p0));
  }
  if (t === 'diagnostics.process') return /^get/.test(m) ? V('low', 'Reads processes') : V('high', `Starts a program through .NET (${label})`);
  if (t === 'environment') {
    if (m === 'setenvironmentvariable') {
      return /user|machine/i.test(String(callArgs[2] || ''))
        ? V('high', 'Permanently changes environment variables')
        : V('medium', 'Sets an environment variable');
    }
    if (m === 'getenvironmentvariables') return V('medium', 'Prints all environment variables, which may hold secrets');
    if (/^(get\w*|expandenvironmentvariables|exit)$/.test(m)) return V('low', 'Reads the environment');
  }
  if (/^microsoft\.win32\.registry(key)?$/.test(t)) {
    return m === 'getvalue' ? V('low', 'Reads the Windows registry') : V('high', 'Changes the Windows registry through .NET');
  }
  if (PS_PURE_TYPES.test(t)) return V('low', 'Calls a .NET method that only computes a value');
  return V('high', `Calls a .NET method PowerShell cannot inspect (${truncate(label, 60)})`);
}

// Methods that only compute or read a value, on strings, collections, dates and readers.
const PS_PURE_METHOD =
  /^(tostring|gettype|equals|gethashcode|compareto|contains(key|value)?|startswith|endswith|(last)?indexof(any)?|split|trim(start|end)?|substring|replace|pad(left|right)|insert|remove(at)?|normalize|format|join|concat|clone|get\w*|is\w*|has\w*|to\w*|try\w*|find\w*|match(es)?|parse\w*|where|foreach|add(range|days|hours|minutes|seconds|milliseconds|months|years|ticks)?|append(line|format)?|clear|push|pop|peek|enqueue|dequeue|sort|reverse|round|floor|ceiling|abs|min|max|pow|sqrt|sum|average|exists|waitforexit|waitone|close|dispose|flush|read\w*|write(line)?|movenext|reset|compute\w*|encode\w*|decode\w*|select\w*|item|count|asreadonly)$/i;

/** The path inside a parenthesized receiver: `(Get-Item C:\x)`, `(New-Object IO.DirectoryInfo 'C:\x')`. */
function psReceiverPath(rawParen) {
  const tk = tokenize(String(rawParen || ''), 'powershell', 'win32');
  const u = unwrap(tk.argv, 'powershell');
  let prog = progName(u.argv[0] || '');
  prog = PS_ALIASES[prog] || prog;
  const { named, positional } = psParams(u.argv.slice(1));
  if (['get-item', 'get-childitem', 'get-itemproperty', 'resolve-path'].includes(prog)) {
    const p = psNamed(named, 'path', 'literalpath');
    return typeof p === 'string' ? p : positional[0] || null;
  }
  if (prog === 'new-object') {
    const al = psNamed(named, 'argumentlist');
    const glued = /^[\w.`]+\((.*?)\)?$/.exec(positional[0] || '');
    if (glued) return glued[1].split(',')[0].trim() || null;
    return typeof al === 'string' ? al.split(',')[0] : positional[1] || null;
  }
  return null;
}

/**
 * .NET and COM calls a PowerShell statement makes, which no cmdlet name reveals
 * (CLASSIFIER-R3-08/09): `[IO.Directory]::Delete(...)`, `(New-Object -ComObject
 * WScript.Shell).Run(...)`, `$sb.Invoke()`. Pure value methods (ToString, Split…) are low.
 */
function psExpressionVerdict(raw, tk, ctx) {
  const { masked, lits } = maskPsStrings(String(raw || ''));
  let v = null;
  const staticRe = /\[\s*([A-Za-z_][\w.`]*)\s*\]\s*::\s*([A-Za-z_]\w*)(\s*\()?/g;
  let m;
  while ((m = staticRe.exec(masked))) {
    if (!m[3]) continue; // a property, not a call
    const open = m.index + m[0].length - 1;
    v = maxVerdict(v, psStaticCallVerdict(m[1], m[2], psCallArgs(masked, open, lits), ctx));
  }
  const memberRe = /([\w)\]}…\u0001])\s*\??\.\s*([A-Za-z_]\w*)\(/g;
  const parens = (tk && tk.parens) || [];
  while ((m = memberRe.exec(masked))) {
    const name = m[2];
    const lname = name.toLowerCase();
    if (PS_PURE_METHOD.test(lname) && !/^get(async|stringasync|bytearrayasync|streamasync|response(async)?|requeststream(async)?)$/.test(lname)) continue;
    // `New-Object IO.StreamWriter(path)`: a type name and its constructor arguments, not a method.
    if (/new-object\s+(-typename\s+)?[\w.`]*$/i.test(masked.slice(0, m.index + 1))) continue;
    const open = m.index + m[0].length - 1;
    let mv;
    if (/^invoke\w*$/.test(lname)) mv = V('high', `Runs a script block or command (.${name})`);
    else if (/^get(async|stringasync|bytearrayasync|streamasync|response(async)?|requeststream(async)?)$/.test(lname)) {
      mv = V('medium', `Makes a network request (.${name})`);
    }
    else if (/^(run|exec|shellexecute|start|startinfo)$/.test(lname)) mv = V('high', `Runs a program through a COM or .NET object (.${name})`);
    else if (/^(download|upload)\w*$/.test(lname)) mv = V('high', `Transfers data over the network (.${name})`);
    else if (lname === 'kill') mv = V('high', 'Kills a process (.Kill)');
    else mv = V('high', `Calls a .NET or COM method PowerShell cannot inspect (.${name})`);
    if (lname === 'delete') {
      // `(Get-Item $HOME).Delete($true)`: judge the receiver's path like Remove-Item would.
      const before = masked.slice(0, m.index + 1);
      let p = null;
      if (/(?<!\$)\(…\)$/.test(before)) {
        const k = (before.match(/(?<!\$)\(…\)/g) || []).length - 1;
        p = psReceiverPath(parens[k]);
      } else {
        const nm = /::\s*new\s*\(([^()]*)\)$/i.exec(before);
        if (nm) p = psCallArgs(`(${nm[1]})`, 0, lits)[0] || null;
      }
      const recursive = psCallArgs(masked, open, lits).some((x) => /^\$true$/i.test(x));
      if (p) mv = maxVerdict(mv, maxVerdict(rmVerdict([], ctx, { recursive, targets: [p], label: `.Delete(${recursive ? '$true' : ''})` }), targetVerdict(p, ctx, 'Deletes')));
    }
    v = maxVerdict(v, mv);
  }
  return v;
}

/**
 * The part's text with each `(…)` that only held a literal path put back (`Remove-Item -Recurse
 * ('C:\Users\me')`), so the path checks see it; other (…) stay placeholders.
 */
function psInlineLiteralParens(part) {
  if (!part.parens || !part.parens.length) return part.text;
  let k = -1;
  return part.text.replace(/([$@])?\(…\)/g, (m, pre) => {
    if (pre === '$') return m;
    k += 1;
    if (pre) return m;
    const src = String(part.parens[k] || '').trim();
    const path0 = /^(~|\$HOME|\$env:\w+|[A-Za-z]:|\.{1,2}[\\/]|[\\/])[^\s()'"`;|&{}@,]*$/i;
    if (/^'[^']*'$/.test(src) || /^"(\$HOME|\$env:\w+)?[^"`$]*"$/i.test(src) || path0.test(src)) return src;
    return m;
  });
}

/** A PowerShell statement that is an expression (a value, variable, string, (…) or [Type]::…), not a command. */
function psExpressionStatement(raw, tk) {
  if (tk && tk.callOp) return false;
  let s = String(raw || '').trim();
  for (let g = 0; g < 8; g += 1) {
    const before = s;
    // Control keywords: their conditions and bodies are split out and judged on their own.
    s = s.replace(/^(if|elseif|else|while|switch|foreach|for|until|do|try|catch|finally|trap|throw|break|continue|param|function\s+[\w-]+)(?![\w-])\s*/i, '');
    s = s.replace(/^(\[[^\]]*\]\s*)*\$(\{[^}]+\}|[\w:]+)\s*[+\-*/%?]?=(?!=)\s*/, '');
    s = s.replace(/^(\[[\w.`, [\]]*?\])+(?!\s*::)\s*/, '');
    if (s === before) break;
  }
  if (!s) return true;
  return /^(["'@$(…{]|\[[^\]]*\]\s*::|-?\d+(\.\d+)?([eE][+-]?\d+)?(kb|mb|gb|tb|pb)?(\s|$|[)\];,+\-*/%.])|0x[0-9a-f]+\b)/i.test(s);
}

/**
 * Classify one simple command (already tokenized and unwrapped).
 * @returns {{risk:string, reason:string, stdinExecutor?:boolean, downloader?:boolean, cwd?:string|null}}
 */
function classifyArgv(u, tk, ctx, raw) {
  const argv = u.argv;
  if (!argv.length) {
    if (u.sudo) return V('high', `Opens a root shell (${u.sudo})`);
    // `done < ~/.aws/credentials`, `$(< ~/.ssh/id_rsa)`: a file read on stdin (CLASSIFIER-R3-02).
    return maxVerdict(V('low', 'No command'), readerVerdict('', '', [], tk, ctx));
  }
  let prog = progName(argv[0]);
  if (ctx.shell === 'powershell' && PS_ALIASES[prog]) prog = PS_ALIASES[prog];
  if (ctx.shell === 'cmd' && ['rd', 'rmdir', 'del', 'erase'].includes(prog))
    prog = `cmd-${prog === 'erase' ? 'del' : prog === 'rmdir' ? 'rd' : prog}`;
  const args = argv.slice(1);
  const computed = computedCommandName(argv[0], ctx.shell, tk);
  const psExpr = !computed && ctx.shell === 'powershell' && psExpressionStatement(raw, tk);
  let v = computed
    ? { ...V('high', `Runs a command whose name is only known at run time (${truncate(argv[0], 40)})`), stdinExecutor: true }
    : psExpr
      ? V('low', 'PowerShell expression')
      : baseVerdict(prog, args, u, tk, ctx, raw);
  const extra = { stdinExecutor: false, downloader: DOWNLOADERS.has(prog), cwd: undefined };
  if (v && v.stdinExecutor) extra.stdinExecutor = true;
  if (v && v.cwd !== undefined) extra.cwd = v.cwd;
  const ownCard = Boolean(v && v.ownCard);
  v = V(v.risk, v.reason);
  // .NET and COM calls hide behind expressions and cmdlets that look harmless (CLASSIFIER-R3-08/09).
  if (ctx.shell === 'powershell') v = maxVerdict(v, psExpressionVerdict(raw, tk, ctx));

  if (u.sudo) {
    v = maxVerdict(v, V('high', `Runs with administrator privileges (${u.sudo})`));
    if (u.sudoShell && argv.length === 0) v = maxVerdict(v, V('high', 'Opens a root shell'));
  }
  if (u.sudoEdit) v = maxVerdict(v, V('high', 'Edits a file as root'));

  // written / deleted paths
  const psProg = PS_ALIASES[prog] || prog;
  const verb = /^(rm|unlink|shred|srm|del|erase|rd|cmd-del|cmd-rd|remove-item|trash)$/.test(prog)
    ? 'Deletes'
    : /^(chmod|chown|chgrp|set-acl)$/.test(prog)
      ? 'Changes permissions of'
      : 'Writes to';
  // prog is already PowerShell-aliased when the shell is PowerShell; using psProg here would
  // wrongly alias bash programs too (e.g. `sort` → `sort-object`), hiding their output files.
  const targetProg = prog.startsWith('cmd-') ? prog.slice(4) : prog;
  // cmd.exe's copy/move/ren/md take /switches and write their own targets (REGRESSIONS-1).
  const writes = ctx.shell === 'cmd' && CMD_WRITERS.has(prog) ? cmdWriteTargets(prog, args, tk) : writeTargets(targetProg, args, tk);
  for (const target of writes) {
    v = maxVerdict(v, targetVerdict(target, ctx, verb));
  }
  // A "read-only" utility that writes to a real output file is not read-only. targetVerdict returns
  // null for project/temp paths, so bump low to medium here or it would auto-run in ask mode.
  // (Null-device redirects like `ls 2>/dev/null` do not count.)
  if (
    RANK[v.risk] < RANK.medium &&
    (READ_ONLY_PROGS.has(prog) || READ_ONLY_PROGS.has(psProg)) &&
    writes.some((t) => !NULL_DEVICE_RE.test(str(t).replace(/^@/, '')))
  ) {
    v = maxVerdict(v, V('medium', 'Writes to a file'));
  }
  // self-escalation through an interpreter or editor
  if (
    RANK[v.risk] < RANK.critical &&
    selfEscalationText(raw) &&
    prog !== 'git' &&
    (INTERPRETERS.test(prog) ||
      SHELLS.test(prog) ||
      PS_HOSTS.test(prog) ||
      /^(sed|awk|gawk|ed|ex|vi|vim|nvim|nano|emacs|sponge|xargs|cp|mv|ln|install|tee|truncate|rm|uniq|xxd|tree|base64|sort|shuf|iconv|set-content|add-content|out-file|copy-item|move-item|remove-item|new-item)$/.test(
        prog,
      ) ||
      (ctx.shell === 'cmd' && CMD_WRITERS.has(prog)))
  ) {
    v = maxVerdict(v, V('critical', 'Modifies Claude Code or Claude Anywhere settings (self-escalation)'));
  }
  // credential files sent over the network
  if (NETWORK_PROGS.has(prog) || NETWORK_PROGS.has(psProg)) {
    for (const a of args) {
      const cands = new Set([a]);
      if (a.includes('@')) cands.add(a.slice(a.lastIndexOf('@') + 1));
      if (a.includes('=')) cands.add(a.slice(a.indexOf('=') + 1));
      for (const c0 of cands) {
        const c = c0.replace(/^[<@]+/, '');
        if (!c || c.startsWith('-')) continue;
        const t = resolveTarget(c, ctx, ctx.cwd);
        const cred = t && credentialKind(t, ctx);
        if (cred) v = maxVerdict(v, V('high', `May send ${cred.what} over the network`));
      }
    }
  }
  // The daemon's own feature routes, called directly (CALLS-DESIGN §13.4): deleting the voice is high, and
  // arming calls is critical (the route still raises its own click-only card).
  if (NETWORK_PROGS.has(prog) || NETWORK_PROGS.has(psProg)) {
    if (args.some((a) => /\/api\/calls\/arm\b/i.test(a))) v = maxVerdict(v, V('critical', CALLS_ARM_REASON));
    else if (args.some((a) => /\/api\/clone\/delete\b/i.test(a))) v = maxVerdict(v, V('high', 'Deletes your cloned voice'));
  }
  // F3-SAFE-D1: any program (curl, node -e, python -c, a script given inline) that names the daemon
  // routes which answer cards or change settings and modes is self-escalation, and so is one that
  // names the calls arm route outside curl/wget.
  if (namesDaemonRoute(str(raw), DAEMON_USER_API_RE)) v = maxVerdict(v, V('critical', DAEMON_USER_API_REASON));
  else if (!(NETWORK_PROGS.has(prog) || NETWORK_PROGS.has(psProg)) && namesDaemonRoute(str(raw), /\/api\/calls\/arm\b/i)) {
    v = maxVerdict(v, V('critical', 'Turns on answering your calls through the Claude Anywhere API'));
  }
  // Reading credential stores is not harmless, whatever program prints them (CLASSIFIER-R3-04),
  // and neither is a credential file fed on stdin (CLASSIFIER-R3-02).
  if (RANK[v.risk] < RANK.high) v = maxVerdict(v, readerVerdict(prog, psProg, args, tk, ctx));
  // writing output to a file is never read-only
  if (v.risk === 'low' && tk.redirects.some((r) => r.write && r.target && !NULL_DEVICE_RE.test(r.target))) {
    v = V('medium', 'Writes command output to a file');
  }
  // deploy scripts and forced deletes
  if (RANK[v.risk] < RANK.high) {
    const scriptWord = isScriptPath(argv[0])
      ? argv[0]
      : SHELLS.test(prog) || INTERPRETERS.test(prog) || PS_HOSTS.test(prog)
        ? args.find((a) => !a.startsWith('-'))
        : null;
    if (
      scriptWord &&
      isScriptPath(scriptWord) &&
      DEPLOY_WORD.test(
        scriptWord
          .split(/[\\/]/)
          .pop()
          .replace(/\.[a-z0-9]+$/i, ''),
      )
    ) {
      v = V('high', `Runs ${scriptWord.split(/[\\/]/).pop()}, which looks like a deploy or release script`);
    } else if (
      [
        'make',
        'just',
        'task',
        'rake',
        'invoke',
        'mage',
        'nx',
        'turbo',
        'lerna',
        'gulp',
        'grunt',
        'deno',
        'composer',
        'mix',
        'gradle',
        'gradlew',
        'mvn',
        'mvnw',
        'sbt',
        'ant',
        'cake',
        'fab',
        'poe',
        'nox',
        'tox',
        'bazel',
        'buck',
        'earthly',
        'dagger',
      ].includes(prog)
    ) {
      const targets = leadingWords(args, 4);
      const hit = targets.find((x) => DEPLOY_WORD.test(x));
      if (hit) v = V('high', `Runs the "${hit}" target, which looks like a deploy or release`);
    }
    const words = leadingWords(args, 3);
    if (RANK[v.risk] < RANK.high && words.some((x) => DELETE_WORD.test(x)) && args.some((a) => FORCE_FLAG.test(a))) {
      v = V('high', `Forced ${words.find((x) => DELETE_WORD.test(x))} (${prog} ${words.join(' ')})`);
    }
    // PowerShell's -Force (any prefix, any case) and -Confirm:$false on a deleting cmdlet such as
    // Remove-AzResourceGroup (Remove-Item has its own path checks).
    const psVerb = ctx.shell === 'powershell' && /^[a-z]+-[a-z]/.test(prog) ? prog.split('-')[0] : '';
    if (
      RANK[v.risk] < RANK.high &&
      /^(remove|clear|uninstall|unregister|reset|disable)$/.test(psVerb) &&
      !/^remove-item(property)?$/.test(prog) &&
      args.some((a) => /^-(f|fo|for|forc|force)(:\$?true)?$/i.test(a) || /^-confirm:\$?false$/i.test(a))
    ) {
      v = V('high', `Forced ${psVerb} without confirmation (${prog})`);
    }
  }
  // `anywhere calls on` keeps its own-card mark only while nothing else (sudo, a redirect) raised the verdict.
  if (ownCard && v.risk === 'critical' && v.reason === CALLS_ARM_REASON) extra.ownCard = true;
  return { ...v, ...extra };
}

function recurse(text, shell, ctx) {
  const r = classifyShellCommand(text, shell, { ...ctx, depth: ctx.depth + 1 });
  return V(r.risk, r.reason);
}

function recurseArgv(argv, ctx) {
  const u = unwrap(argv, ctx.shell);
  return classifyArgv(u, { argv, redirects: [], herestrings: [], parens: [] }, { ...ctx, depth: ctx.depth + 1 }, argv.join(' '));
}

/**
 * A command run on every file a search visits (find -exec, fd -x, rg --pre): its scope is the
 * search's start paths, not the "{}" it is given (SECURITY-ADVERSARIAL-4, CLASSIFIER-R3-10).
 */
function perFileCommandVerdict(cmd, starts, ctx, who) {
  const inner = recurseArgv(cmd, ctx);
  let v = V(maxRisk(inner.risk, 'medium'), `${who} runs: ${inner.reason}`);
  const ip = progName(cmd[0]);
  const deletes = /^(rm|unlink|shred|srm|trash|trash-put|rmdir|del|remove-item)$/.test(ip);
  const writes =
    /^(mv|cp|ln|install|chmod|chown|chgrp|truncate|tee|dd|touch|rsync|set-content|out-file)$/.test(ip) ||
    (/^(sed|perl|ruby)$/.test(ip) && cmd.some((x) => x.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(x)));
  const reads = CONTENT_READERS.has(ip);
  for (const s0 of starts) {
    const t = resolveTarget(s0, ctx, ctx.cwd);
    if (deletes || writes) {
      const what = t && rootLike(t, ctx);
      if (what) return V(deletes ? 'critical' : 'high', `${deletes ? 'Deletes' : 'Changes'} files throughout ${what}`);
      const tv = targetVerdict(s0, ctx, deletes ? 'Deletes files under' : 'Changes files under');
      if (tv) v = maxVerdict(v, tv);
    } else if (reads && t) {
      // `find ~ -exec cat {} +` prints every credential file under the home folder.
      const where = credentialAncestor(t, ctx, { recursive: true }) || (readCredentialKind(s0, ctx, ctx.cwd) || {}).what;
      if (where) v = maxVerdict(v, V('high', `${who} feeds the files in ${where} to ${ip}, which prints them`));
    }
  }
  return v;
}

const XARGS_VALUE_FLAGS = new Set([
  '-I',
  '-i',
  '-n',
  '-P',
  '-L',
  '-l',
  '-d',
  '-E',
  '-e',
  '-s',
  '-a',
  '--max-args',
  '--max-procs',
  '--delimiter',
  '--arg-file',
  '--replace',
  '--max-lines',
  '--eof',
  '--max-chars',
]);

/** The command xargs runs (its options skipped). */
function xargsPayload(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += XARGS_VALUE_FLAGS.has(args[i]) ? 2 : 1;
  return args.slice(i);
}

const PIPE_DELETERS = /^(rm|unlink|shred|srm|trash|trash-put|remove-item|del|erase)$/;

// fd options that take a value, so its pattern and search paths can be found.
const FD_VALUE_FLAGS = new Set([
  '-e',
  '--extension',
  '-t',
  '--type',
  '-E',
  '--exclude',
  '-d',
  '--max-depth',
  '--min-depth',
  '--exact-depth',
  '-S',
  '--size',
  '--changed-within',
  '--changed-before',
  '-o',
  '--owner',
  '-j',
  '--threads',
  '--max-results',
  '-c',
  '--color',
  '--base-directory',
  '--search-path',
  '--path-separator',
  '--ignore-file',
  '--batch-size',
]);

/** A secret-store CLI asked to print a secret: vault, 1Password, Bitwarden, pass… (CLASSIFIER-R3-05). */
function secretStoreRead(prog, w) {
  const [a = '', b = ''] = w;
  switch (prog) {
    case 'vault':
      return ['read', 'login'].includes(a) || (a === 'kv' && b === 'get') || (a === 'print' && b === 'token') || (a === 'token' && b === 'create');
    case 'op':
      return ['read', 'inject'].includes(a) || (['item', 'document'].includes(a) && b === 'get');
    case 'bw':
    case 'lpass':
      return ['get', 'show', 'export'].includes(a);
    case 'pass':
    case 'gopass':
      // `pass email/work` shows that entry.
      return ['show', 'cat', 'otp'].includes(a) || (w.length === 1 && !/^(ls|list|find|search|init|git|insert|generate|rm|mv|cp|edit|grep|help|version)$/.test(a));
    case 'secret-tool':
      return a === 'lookup';
    case 'keyring':
      return a === 'get';
    default:
      return false;
  }
}

/**
 * A pipeline stage that lists files for the next stage: its paths, and whether it lists a whole
 * tree (Get-ChildItem -Recurse, find, fd, ls -R) or one folder (gci, ls). Else null.
 */
function enumeratorScope(u, shell) {
  let prog = progName(u.argv[0] || '');
  if (shell === 'powershell') prog = PS_ALIASES[prog] || prog;
  const args = u.argv.slice(1);
  if (prog === 'get-childitem') {
    const targets = [];
    let recursive = false;
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      const valued = /^-(path|literalpath|pspath|lp)(:|$)/i.exec(a);
      if (valued) {
        const val = a.includes(':') && !/:$/.test(a) ? a.slice(a.indexOf(':') + 1) : args[(i += 1)];
        if (val) targets.push(...val.split(',').map((x) => x.trim()));
      } else if (/^-(filter|include|exclude|attributes|attr|af|ad)(:|$)/i.test(a) && !a.includes(':')) i += 1;
      else if (/^-(depth)(:|$)/i.test(a)) {
        recursive = true;
        if (!a.includes(':')) i += 1;
      } else if (PS_RECURSE.test(a)) recursive = true;
      else if (!a.startsWith('-') && !targets.length) targets.push(a);
    }
    return { targets: targets.length ? targets : ['.'], recursive, label: 'Get-ChildItem' };
  }
  if (prog === 'ls' && shell !== 'powershell') {
    const recursive = args.some((a) => a === '--recursive' || /^-[a-zA-Z]*R/.test(a));
    const pos = args.filter((a) => !a.startsWith('-'));
    return { targets: pos.length ? pos : ['.'], recursive, label: 'ls' };
  }
  if (prog === 'find') {
    const starts = [];
    for (const a of args) {
      if (/^[-(!]/.test(a) && !/^-[HLP]$/.test(a)) break;
      if (!/^-[HLP]$/.test(a)) starts.push(a);
    }
    return { targets: starts.length ? starts : ['.'], recursive: true, label: 'find' };
  }
  if (prog === 'fd' || prog === 'fdfind') {
    const pos = positionals(args, FD_VALUE_FLAGS);
    return { targets: pos.length > 1 ? pos.slice(1) : ['.'], recursive: true, label: prog };
  }
  return null;
}

function rmVerdict(args, ctx, { recursive, targets, label }) {
  for (const raw of targets) {
    const t = resolveTarget(raw, ctx, ctx.cwd);
    if (!t) continue;
    const what = rootLike(t, ctx);
    if (what && recursive) return V('critical', `Recursively deletes ${what}`);
    if (what && t.glob) return V('critical', `Deletes everything in ${what}`);
  }
  if (recursive) return V('high', `Deletes files and folders recursively (${label})`);
  return V('medium', `Deletes files (${label})`);
}

// PowerShell cmdlets that change system-wide configuration.
const PS_SYSTEM_CMDLETS = new Set([
  'set-executionpolicy',
  'new-service',
  'set-service',
  'stop-service',
  'start-service',
  'restart-service',
  'suspend-service',
  'resume-service',
  'remove-service',
  'register-scheduledtask',
  'unregister-scheduledtask',
  'set-scheduledtask',
  'disable-scheduledtask',
  'enable-scheduledtask',
  'set-mppreference',
  'add-mppreference',
  'remove-mppreference',
  'install-module',
  'install-package',
  'install-script',
  'uninstall-module',
  'uninstall-package',
  'update-module',
  'install-packageprovider',
  'register-psrepository',
  'set-psrepository',
  'new-netfirewallrule',
  'set-netfirewallrule',
  'remove-netfirewallrule',
  'set-netfirewallprofile',
  'disable-netfirewallrule',
  'enable-netfirewallrule',
  'new-localuser',
  'set-localuser',
  'remove-localuser',
  'add-localgroupmember',
  'remove-localgroupmember',
  'enable-windowsoptionalfeature',
  'disable-windowsoptionalfeature',
  'add-windowscapability',
  'remove-windowscapability',
  'set-netipaddress',
  'new-netipaddress',
  'remove-netipaddress',
  'set-dnsclientserveraddress',
  'disable-netadapter',
  'enable-netadapter',
  'restart-netadapter',
  'set-timezone',
  'set-date',
  'rename-computer',
  'add-computer',
  'remove-computer',
  'set-tpm',
  'clear-tpm',
  'disable-bitlocker',
  'enable-bitlocker',
  'suspend-bitlocker',
  'clear-eventlog',
  'remove-eventlog',
  'limit-eventlog',
  'set-item',
  'set-alias',
  'new-psdrive',
  'remove-appxpackage',
  'add-appxpackage',
  'install-windowsfeature',
  'uninstall-windowsfeature',
  'set-processmitigation',
  'disable-computerrestore',
  'checkpoint-computer',
  'set-wmiinstance',
  'remove-wmiobject',
  'remove-ciminstance',
  'set-ciminstance',
  'invoke-wmimethod',
  'invoke-cimmethod',
]);

/**
 * Collect sed script text from -e/--expression values, or the first non-flag
 * argument when neither -e nor -f is given.
 */
function sedScripts(args) {
  const scripts = [];
  let hasFile = false;
  let sawScriptFlag = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-e' || a === '--expression') {
      if (args[i + 1] != null) scripts.push(args[i + 1]);
      sawScriptFlag = true;
      i += 1;
      continue;
    }
    if (a.startsWith('--expression=')) {
      scripts.push(a.slice('--expression='.length));
      sawScriptFlag = true;
      continue;
    }
    if (a.startsWith('-e') && a.length > 2 && !a.startsWith('--')) {
      scripts.push(a.slice(2));
      sawScriptFlag = true;
      continue;
    }
    if (a === '-f' || a === '--file') {
      hasFile = true;
      sawScriptFlag = true;
      i += 1;
      continue;
    }
    if (a.startsWith('--file=') || (a.startsWith('-f') && a.length > 2 && !a.startsWith('--'))) {
      hasFile = true;
      sawScriptFlag = true;
      continue;
    }
  }
  if (!sawScriptFlag) {
    const first = args.find((a) => !a.startsWith('-'));
    if (first != null) scripts.push(first);
  }
  return { scripts, hasFile };
}

// The sed `e` command / `s///e` flag run a shell; `w`/`W` write a file.
const SED_EXEC_CMD = /(^|;|\n|\})\s*\d*\s*e(\s|$)/;
const SED_EXEC_SFLAG = /s[^\w\s].*[^\\]e[a-z]*\s*($|;)/;

function sedExecCommand(script) {
  const m = /(?:^|;|\n|\})\s*\d*\s*e\s+([^\n;]+)/.exec(script);
  return m ? m[1].trim() : null;
}

function sedWriteTarget(script) {
  // `w file` / `W file` command (optionally address-prefixed), or the `w file` flag on s///.
  const flag = /s([^\w\s])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-z0-9]*w\s+([^\n;]+)/.exec(script);
  if (flag) return flag[2].trim();
  const cmd = /(?:^|;|\n|\})\s*(?:\d+|\$)?(?:,\s*(?:\d+|\$))?\s*[wW]\s+([^\n;]+)/.exec(script);
  return cmd ? cmd[1].trim() : null;
}

/**
 * sed is read-only text processing UNLESS: it edits in place (-i), runs a shell
 * (the `e` command or `s///e` flag), writes files (`w`/`W`), or runs an unknown
 * script from a file. GNU --sandbox disables e/w/r.
 */
function classifySed(args, ctx) {
  const sandbox = args.includes('--sandbox');
  const inPlace = args.some((a) => /^(-i|--in-place)/.test(a) || (/^-[a-hj-zA-Z]*i/.test(a) && !a.startsWith('--')));
  let v = inPlace ? V('medium', 'Edits files in place (sed -i)') : V('low', 'Read-only text processing (sed)');
  if (sandbox) return v;
  const { scripts, hasFile } = sedScripts(args);
  for (const s of scripts) {
    if (SED_EXEC_CMD.test(s) || SED_EXEC_SFLAG.test(s)) {
      v = maxVerdict(v, V('high', 'Runs a shell command (sed e command)'));
      const cmd = sedExecCommand(s);
      if (cmd) {
        try {
          v = maxVerdict(v, recurse(cmd, 'bash', ctx));
        } catch {
          /* the text after `e` may not parse as a command */
        }
      }
      continue;
    }
    const wt = sedWriteTarget(s);
    if (wt != null) {
      v = maxVerdict(v, V('medium', 'Writes a file (sed w command)'));
      v = maxVerdict(v, targetVerdict(wt, ctx));
    }
  }
  if (hasFile) v = maxVerdict(v, V('medium', 'Runs a sed script from a file'));
  return v;
}

/** Program-specific verdict (before sudo / target / network bumps). */
function baseVerdict(prog, args, u, tk, ctx, raw) {
  if (/^#/.test(prog)) return V('low', 'Comment');
  if (ctx.depth > MAX_DEPTH) return V('high', 'Deeply nested command that could not be fully inspected');

  // ---- catastrophic first
  if (/^mkfs(\..+)?$|^mke2fs$|^mkswap$|^wipefs$|^newfs(_.*)?$|^mkntfs$|^mkdosfs$/.test(prog))
    return V('critical', 'Formats a disk or partition');
  if (['diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'set-disk'].includes(prog))
    return V('critical', 'Changes disks or partitions');
  if (prog === 'format' && args.some((a) => /^[a-z]:$/i.test(a))) return V('critical', 'Formats a drive');
  if (['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'].includes(prog)) {
    if (prog === 'shutdown' && args.some((a) => /^(-c|\/a)$/i.test(a))) return V('medium', 'Cancels a pending shutdown');
    return V('critical', 'Shuts down or restarts the computer');
  }
  if ((prog === 'init' || prog === 'telinit') && ['0', '6'].includes(args[0])) return V('critical', 'Shuts down or restarts the computer');
  if (prog === 'diskutil') {
    const a = (args[0] || '').toLowerCase();
    if (/^(erase\w*|partitiondisk|zerodisk|randomdisk|secureerase|reformat)$/.test(a))
      return V('critical', 'Erases or repartitions a disk');
    if (['list', 'info', 'activity', 'verifyvolume', 'verifydisk'].includes(a)) return V('low', 'Reads disk information');
    return V('high', `Changes disks (diskutil ${a})`);
  }
  if (['fdisk', 'sfdisk', 'gdisk', 'sgdisk', 'parted', 'cfdisk'].includes(prog)) {
    if (hasFlag(args, '-l', '--list', 'print', '-p')) return V('low', 'Lists partitions');
    if (args.some((a) => DISK_DEVICE_RE.test(a))) return V('critical', 'Repartitions a disk');
    return V('high', `Runs ${prog}`);
  }
  if (prog === 'dd') {
    const of = args.find((a) => a.startsWith('of='));
    if (of && DISK_DEVICE_RE.test(of.slice(3))) return V('critical', `Overwrites the disk device ${of.slice(3)}`);
    return V('medium', 'Copies raw data (dd)');
  }
  if (prog === 'shred' && args.some((a) => DISK_DEVICE_RE.test(a))) return V('critical', 'Wipes a disk device');
  if (prog === 'vssadmin' && /delete|resize/i.test(args.join(' '))) return V('critical', 'Deletes Windows shadow copies (backups)');
  if (prog === 'wsl') {
    if (hasFlag(args, '--unregister')) return V('critical', 'Unregisters a WSL distribution and deletes all its files');
    if (
      hasFlag(
        args,
        '--shutdown',
        '--terminate',
        '-t',
        '--install',
        '--uninstall',
        '--import',
        '--set-default-version',
        '--update',
        '--set-version',
        '--mount',
        '--unmount',
      )
    )
      return V('high', 'Changes WSL itself');
    if (hasFlag(args, '--list', '-l', '--status', '--version', '-v', '--help')) return V('low', 'Reads WSL information');
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (a === '--' || a === '-e' || a === '--exec') {
        const rest = args.slice(i + 1);
        return a === '--' ? recurse(rest.join(' '), 'bash', ctx) : recurseArgv(rest, { ...ctx, shell: 'bash' });
      }
      if (['-d', '--distribution', '-u', '--user', '--cd'].includes(a)) i += 2;
      else if (a.startsWith('-')) i += 1;
      else break;
    }
    const rest = args.slice(i);
    return rest.length ? recurse(rest.join(' '), 'bash', ctx) : V('medium', 'Opens a WSL shell');
  }

  // ---- self-escalation via CLIs
  if (prog === 'claude') {
    if (
      hasFlag(args, '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions') ||
      /bypassPermissions/i.test(flagValue(args, '--permission-mode') || '')
    ) {
      return V('critical', 'Starts a Claude Code session with permission checks disabled (self-escalation)');
    }
    const w = leadingWords(args, 2);
    if (w[0] === 'config' && ['set', 'add', 'remove', 'unset'].includes(w[1]))
      return V('critical', 'Changes Claude Code settings (self-escalation)');
    if (w[0] === 'mcp' && ['add', 'add-json', 'remove', 'add-from-claude-desktop'].includes(w[1]))
      return V('high', 'Changes Claude Code MCP servers');
    if (w[0] === 'plugin' && ['install', 'uninstall', 'enable', 'disable', 'marketplace'].includes(w[1]))
      return V('high', 'Changes Claude Code plugins');
    if (
      hasFlag(args, '--version', '-v', '--help', '-h') ||
      (['doctor', 'mcp'].includes(w[0]) && (w[1] === 'list' || w[1] === 'get' || w[0] === 'doctor'))
    )
      return V('low', 'Reads Claude Code information');
    return V('medium', 'Starts another Claude Code session');
  }
  const anywhereIdx =
    prog === 'anywhere' || prog === 'claude-anywhere'
      ? 0
      : prog === 'node' &&
          args[0] &&
          /(^|[\\/])(anywhere\.js|run\.js)$/.test(args[0]) &&
          // `cd ~/.claude/skills/anywhere && node run.js config set …` names no "anywhere" itself.
          (/anywhere/.test(args[0]) || /anywhere/i.test((resolveTarget(args[0], ctx, ctx.cwd) || {}).abs || ''))
        ? 1
        : -1;
  if (anywhereIdx >= 0) {
    const sub = args.slice(anywhereIdx);
    const w = sub.filter((a) => !a.startsWith('-'));
    if (w[0] === 'config' && ['set', 'reset', 'unset'].includes(w[1]))
      return V('critical', 'Changes Claude Anywhere settings (self-escalation)');
    if (['install', 'uninstall'].includes(w[0])) return V('high', `Runs anywhere ${w[0]}`);
    const callsCli = anywhereCallsCliVerdict(w);
    if (callsCli) return callsCli;
    if (w[0] === 'computer') {
      const op = w[1] || '';
      if (op === 'type') return anywhereToolVerdict('type_text', { text: w.slice(2).join(' ') }, ctx);
      if (op === 'key') return anywhereToolVerdict('key', { combo: w[2] || '' }, ctx);
      if (op === 'open') return anywhereToolVerdict('open', { target: w[2] || '' }, ctx);
      if (['screenshot', 'windows', 'cursor', 'screens', 'context'].includes(op) || (op === 'clipboard' && w[2] === 'get'))
        return V('low', 'Reads the screen or desktop');
      return V('medium', `Controls the screen (anywhere computer ${op})`);
    }
    if (
      ['status', 'url', 'version', 'help', 'doctor', 'logs', 'listen', 'reply', 'notify', 'ask', 'show', 'send', 'start'].includes(w[0]) ||
      (w[0] === 'config' && (!w[1] || ['get', 'path'].includes(w[1])))
    ) {
      return V('low', 'Claude Anywhere command');
    }
    return V('medium', `Runs anywhere ${w[0] || ''}`.trim());
  }

  // ---- shells and interpreters (recursive)
  if (SHELLS.test(prog)) {
    const ci = args.findIndex((a) => a === '-c' || (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a) && !a.startsWith('--')));
    if (ci !== -1 && args[ci + 1] != null) return recurse(args[ci + 1], 'bash', ctx);
    if (tk.herestrings.length) return recurse(tk.herestrings.join('\n'), 'bash', ctx);
    const script = args.find((a) => !a.startsWith('-'));
    if (!script) return { ...V('medium', `Starts a ${prog} shell`), stdinExecutor: true };
    return V('medium', `Runs the shell script ${truncate(script, 80)}`);
  }
  if (PS_HOSTS.test(prog)) {
    const encIdx = args.findIndex((a) =>
      /^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/i.test(
        a,
      ),
    );
    if (encIdx !== -1) {
      const b64 = (args[encIdx + 1] || '').trim();
      let decoded = '';
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0) {
        const bytes = Buffer.from(b64, 'base64');
        if (bytes.length % 2 === 0) decoded = bytes.toString('utf16le');
      }
      if (!decoded.trim() || /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(decoded))
        return V('high', 'Runs an encoded PowerShell command that cannot be inspected');
      return maxVerdict(recurse(decoded, 'powershell', ctx), V('medium', 'Runs an encoded PowerShell command'));
    }
    const cIdx = args.findIndex((a) => /^-(c|co|com|comm|comma|comman|command)$/i.test(a));
    if (cIdx !== -1) {
      const text = args.slice(cIdx + 1).join(' ');
      if (text.trim() === '-') return { ...V('medium', 'Runs PowerShell commands from stdin'), stdinExecutor: true };
      return recurse(text, 'powershell', ctx);
    }
    const fIdx = args.findIndex((a) => /^-(f|fi|fil|file)$/i.test(a));
    if (fIdx !== -1) return V('medium', `Runs the PowerShell script ${truncate(args[fIdx + 1] || '', 80)}`);
    const VALUE_OPTS =
      /^-(executionpolicy|ep|ex|exe|exec|version|v|windowstyle|w|workingdirectory|wd|configurationname|outputformat|o|of|inputformat|if|psconsolefile|settingsfile)$/i;
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += VALUE_OPTS.test(args[i]) ? 2 : 1;
    const rest = args.slice(i);
    if (!rest.length) return { ...V('medium', 'Starts PowerShell'), stdinExecutor: true };
    if (/\.ps1$/i.test(rest[0])) return V('medium', `Runs the PowerShell script ${truncate(rest[0], 80)}`);
    return recurse(rest.join(' '), 'powershell', ctx);
  }
  if (prog === 'cmd') {
    const ci = args.findIndex((a) => /^\/[ck]$/i.test(a));
    if (ci !== -1) {
      // `cmd /c "copy a b"` passes one command line; `cmd /c copy a "C:\Start Menu\x"` passes
      // words, and a word with spaces must stay one path.
      const rest = args.slice(ci + 1);
      const line = rest.length === 1 ? rest[0] : rest.map((a) => (/\s/.test(a) && !/"/.test(a) ? `"${a}"` : a)).join(' ');
      return recurse(line, 'cmd', ctx);
    }
    return { ...V('medium', 'Starts cmd.exe'), stdinExecutor: true };
  }
  if (prog === 'eval') {
    // `eval "$(cmd)"` runs cmd's output: classifyShellCommand judges it from cmd (see there).
    const literal = args.filter((a) => !/^(\$\(…\)|`…`)$/.test(a));
    const inner = literal.length
      ? recurse(literal.join(' '), ctx.shell === 'powershell' ? 'powershell' : 'bash', ctx)
      : V('medium', 'Evaluates the output of a command');
    // A variable's value is unknown here; a substitution is judged in classifyShellCommand,
    // which sees the command it runs (known generators such as `ssh-agent -s` stay as they are).
    if (args.some((a) => /\$[A-Za-z_{]/.test(a.replace(/\$\(…\)/g, '')))) {
      return maxVerdict(inner, V('high', 'Evaluates a command that is only known at run time (eval of a variable)'));
    }
    return inner;
  }
  if (prog === 'invoke-expression') return V('high', 'Runs a dynamically built PowerShell command (Invoke-Expression)');
  if (prog === 'source' || (prog === '.' && ctx.shell !== 'powershell') || prog === 'dot-source') {
    // A bare variable names a script nobody can see here ("$X"); "$VENV/bin/activate" is a path.
    if (args[0] && /^\$(\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)$/.test(args[0])) {
      return V('high', `Runs a script whose path is only known at run time (${truncate(args[0], 40)}) in the current shell`);
    }
    // `. ([scriptblock]::Create(...))`, `. (Get-Script)`: code made at run time (CLASSIFIER-R3-09).
    if (ctx.shell === 'powershell' && args[0] && /^[(…]|^\$\(/.test(args[0])) {
      return V('high', 'Runs code built at run time in the current shell (dot-sourcing an expression)');
    }
    if (!args[0] && /<\(…\)/.test(raw || '')) return V('medium', 'Runs the output of a command in the current shell');
    return V('medium', `Runs the script ${truncate(args[0] || '', 80)} in the current shell`);
  }
  if (prog === 'su') {
    const ci = args.indexOf('-c');
    if (ci !== -1 && args[ci + 1] != null)
      return maxVerdict(recurse(args[ci + 1], 'bash', ctx), V('high', 'Runs a command as another user (su)'));
    return V('high', 'Switches to another user (su)');
  }
  if (prog === 'runas') return V('high', 'Runs a program as another user (runas)');
  if (prog === 'xargs') {
    const rest = xargsPayload(args);
    if (!rest.length) return V('low', 'xargs echo');
    const inner = recurseArgv(rest, ctx);
    // Its paths come from stdin, unseen here: a reader may be fed credential files (CLASSIFIER-R3-04).
    if (CONTENT_READERS.has(progName(rest[0]))) return maxVerdict(inner, V('medium', `Reads the files named on its input (xargs ${progName(rest[0])})`));
    return inner;
  }

  // ---- command wrappers that run another command (by their payload, not a fixed risk)
  if (prog === 'watch') {
    // watch runs its arguments through `sh -c`.
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += args[i] === '-n' || args[i] === '--interval' ? 2 : 1;
    const rest = args.slice(i);
    if (!rest.length) return V('medium', 'Runs watch');
    return maxVerdict(V('medium', 'Repeatedly runs a command (watch)'), recurse(rest.join(' '), 'bash', ctx));
  }
  if (prog === 'script') {
    // script [options] [file]; the recorded command is the -c/--command value (also in combined flags like -qec).
    let cmd = flagValue(args, '-c', '--command');
    if (cmd == null) {
      const idx = args.findIndex((a) => !a.startsWith('--') && /^-[a-z]*c$/i.test(a));
      if (idx !== -1 && args[idx + 1] != null) cmd = args[idx + 1];
    }
    const base = V('medium', 'Records a terminal session (script)');
    return cmd != null ? maxVerdict(base, recurse(cmd, 'bash', ctx)) : base;
  }
  if (prog === 'flock') {
    const cmd = flagValue(args, '-c', '--command');
    if (cmd != null) return maxVerdict(V('medium', 'Runs a command under a lock (flock)'), recurse(cmd, 'bash', ctx));
    // flock [options] LOCKFILE COMMAND [args]
    const rest = wrapTrailing(args, new Set(['-w', '--timeout', '-E', '--conflict-exit-code']), 1);
    if (!rest.length) return V('low', 'Takes a file lock (flock)');
    return maxVerdict(V('medium', 'Runs a command under a lock (flock)'), recurseArgv(rest, ctx));
  }
  if (prog === 'strace' || prog === 'ltrace') {
    // [options] COMMAND [args]; the trace file (-o) is handled by writeTargets.
    const rest = wrapTrailing(
      args,
      new Set(['-o', '--output', '-e', '-p', '--attach', '-s', '-u', '--user', '-E', '-a', '-O', '-S', '-P', '-I', '-b', '-D', '-x']),
    );
    if (!rest.length) return V('medium', `Traces a process (${prog})`);
    return maxVerdict(V('medium', `Traces a command (${prog})`), recurseArgv(rest, ctx));
  }
  if (prog === 'ssh-agent') {
    const rest = wrapTrailing(args, new Set(['-t', '-a', '-O', '-P']));
    if (!rest.length) return V('medium', 'Starts the SSH agent');
    return maxVerdict(V('medium', 'Runs a command under ssh-agent'), recurseArgv(rest, ctx));
  }
  if (prog === 'setsid' || prog === 'firejail' || prog === 'unshare' || prog === 'dbus-run-session' || prog === 'eatmydata') {
    const rest = wrapTrailing(args, new Set(['--config-file', '--dbus-daemon', '--profile', '--private', '--netns']));
    if (!rest.length) return V('medium', `Runs ${prog}`);
    return maxVerdict(V('medium', `Runs a command (${prog})`), recurseArgv(rest, ctx));
  }
  if (prog === 'systemd-run') {
    const rest = wrapTrailing(
      args,
      new Set([
        '--unit',
        '-u',
        '-p',
        '--property',
        '--on-active',
        '--on-boot',
        '--on-calendar',
        '--on-startup',
        '--on-unit-active',
        '--on-unit-inactive',
        '--timer-property',
        '--description',
        '--slice',
        '--uid',
        '--gid',
        '--setenv',
        '-E',
        '--working-directory',
      ]),
    );
    if (!rest.length) return V('high', 'Runs systemd-run');
    return maxVerdict(V('high', 'Runs a command as a transient systemd unit (systemd-run)'), recurseArgv(rest, ctx));
  }
  if (prog === 'chroot') {
    // chroot [options] NEWROOT [COMMAND [args]]
    const rest = wrapTrailing(args, new Set(['--userspec', '--groups']), 1);
    if (!rest.length) return V('high', 'Runs a shell in a chroot');
    return maxVerdict(V('high', 'Runs a command in a chroot'), recurseArgv(rest, ctx));
  }
  if (prog === 'sg' || prog === 'newgrp') {
    const cmd = flagValue(args, '-c');
    if (cmd != null) return maxVerdict(V('high', `Runs a command as another group (${prog})`), recurse(cmd, 'bash', ctx));
    const rest = wrapTrailing(args, new Set(['-c']), 1);
    if (!rest.length) return V('high', `Switches group (${prog})`);
    return maxVerdict(V('high', `Runs a command as another group (${prog})`), recurseArgv(rest, ctx));
  }
  if (prog === 'runuser') {
    const cmd = flagValue(args, '-c', '--command');
    if (cmd != null) return maxVerdict(V('high', 'Runs a command as another user (runuser)'), recurse(cmd, 'bash', ctx));
    let i = 0;
    const VAL = new Set(['-u', '--user', '-g', '--group', '-G', '--supp-group', '-s', '--shell', '--session-command']);
    while (i < args.length && args[i].startsWith('-') && args[i] !== '--') i += VAL.has(args[i]) ? 2 : 1;
    if (args[i] === '--') i += 1;
    else if (args[i] != null && !hasFlag(args, '-u', '--user')) i += 1; // positional USER
    const rest = args.slice(i);
    if (!rest.length) return V('high', 'Switches to another user (runuser)');
    return maxVerdict(V('high', 'Runs a command as another user (runuser)'), recurseArgv(rest, ctx));
  }
  if (['xterm', 'urxvt', 'rxvt', 'konsole', 'alacritty', 'kitty', 'xfce4-terminal', 'lxterminal', 'st', 'foot'].includes(prog)) {
    const ei = args.findIndex((a) => a === '-e' || a === '--command' || a === '--');
    if (ei !== -1 && args[ei + 1] != null) {
      return maxVerdict(V('medium', `Opens a terminal running a command (${prog})`), recurseArgv(args.slice(ei + 1), ctx));
    }
    return V('medium', `Opens a terminal (${prog})`);
  }
  if (['gnome-terminal', 'tilix', 'terminator', 'kgx'].includes(prog)) {
    const dd = args.indexOf('--');
    if (dd !== -1 && args[dd + 1] != null)
      return maxVerdict(V('medium', `Opens a terminal running a command (${prog})`), recurseArgv(args.slice(dd + 1), ctx));
    const e = flagValue(args, '-e', '--command');
    if (e != null) return maxVerdict(V('medium', `Opens a terminal running a command (${prog})`), recurse(e, 'bash', ctx));
    return V('medium', `Opens a terminal (${prog})`);
  }
  if (['vim', 'nvim', 'vi', 'ex', 'view', 'rvim', 'gvim'].includes(prog)) {
    const cmds = [];
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === '-c' || a === '--cmd') {
        if (args[i + 1] != null) cmds.push(args[i + 1]);
        i += 1;
      } else if (a.startsWith('+') && a.length > 1) cmds.push(a.slice(1));
    }
    let v = V('medium', `Edits files (${prog})`);
    for (const cstr of cmds) {
      if (/^\s*:?\s*!/.test(cstr) || /:\s*!/.test(cstr) || /\b[rw]\s*!/.test(cstr)) {
        v = maxVerdict(v, V('high', `Runs a shell command from ${prog}`));
        const sh = cstr.slice(cstr.indexOf('!') + 1).trim();
        if (sh) {
          try {
            v = maxVerdict(v, recurse(sh, 'bash', ctx));
          } catch {
            /* the ex command may not be a shell command */
          }
        }
      }
    }
    return v;
  }
  if (prog === 'find') {
    let v = V('low', 'Searches for files');
    const starts = [];
    for (const a of args) {
      if (/^[-(!]/.test(a) && !/^-[HLP]$/.test(a)) break;
      if (!/^-[HLP]$/.test(a)) starts.push(a);
    }
    if (args.includes('-delete')) {
      v = V('high', 'Deletes the files it finds (find -delete)');
      for (const s0 of starts.length ? starts : ['.']) {
        const t = resolveTarget(s0, ctx, ctx.cwd);
        const what = t && rootLike(t, ctx);
        if (what) return V('critical', `Deletes files throughout ${what}`);
      }
    }
    for (let i = 0; i < args.length; i += 1) {
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(args[i])) {
        const cmd = [];
        let j = i + 1;
        for (; j < args.length && args[j] !== ';' && args[j] !== '+'; j += 1) cmd.push(args[j]);
        i = j;
        if (cmd.length) {
          const pv = perFileCommandVerdict(cmd, starts.length ? starts : ['.'], ctx, 'find');
          if (pv.risk === 'critical') return pv;
          v = maxVerdict(v, pv);
        }
      }
      if (/^-(fprint|fprint0|fprintf|fls)$/.test(args[i])) v = maxVerdict(v, V('medium', 'find writes its results to a file'));
    }
    return v;
  }
  if (prog === 'osascript') {
    const script = args.filter((a, k) => args[k - 1] === '-e').join('\n') || args.join(' ');
    if (
      /tell\s+application\s+"?System Events"?[\s\S]*\b(shut down|restart|log out)\b/i.test(script) ||
      /\b(shut down|restart)\b\s*$/im.test(script)
    ) {
      return V('critical', 'Shuts down, restarts or logs out the Mac');
    }
    let v = V('medium', 'Runs AppleScript');
    // Persistence, deletion and GUI scripting through AppleScript (CLASSIFIER-R3-16).
    if (/make\s+(new\s+)?login\s+item/i.test(script)) v = maxVerdict(v, V('high', 'Adds a login item (it runs at every login)'));
    if (/tell\s+application\s+"?Finder"?[\s\S]*\b(delete|empty(\s+the)?\s+trash)\b/i.test(script)) {
      v = maxVerdict(v, V('high', 'Deletes files or empties the Trash through Finder'));
      for (const pm of script.matchAll(/POSIX file\s+"((?:[^"\\]|\\.)*)"/gi)) {
        v = maxVerdict(v, rmVerdict([], ctx, { recursive: true, targets: [pm[1]], label: 'Finder delete' }));
      }
    }
    if (/\b(keystroke|key code)\b/i.test(script) && /System Events/i.test(script)) {
      v = maxVerdict(v, V('high', 'Types keystrokes through System Events'));
    }
    if (/System (Settings|Preferences)|Security\s*&\s*Privacy|Privacy_/i.test(script) && /System Events|click|reveal/i.test(script)) {
      v = maxVerdict(v, V('high', 'Scripts System Settings'));
    }
    const m = /do shell script\s+"((?:[^"\\]|\\.)*)"(?:\s+with administrator privileges)?/i.exec(script);
    const jxa = /doShellScript\s*\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/.exec(script);
    if (m || jxa) {
      const inner = recurse((m ? m[1] : jxa[2]).replace(/\\(["'`])/g, '$1'), 'bash', ctx);
      if ((m && /with administrator privileges/i.test(m[0])) || (jxa && /administratorPrivileges\s*:\s*true/.test(script)))
        return maxVerdict(maxVerdict(inner, v), V('high', 'Runs a shell command as administrator via AppleScript'));
      return maxVerdict(inner, v);
    }
    return v;
  }
  // ---- secrets printed into the transcript (CLASSIFIER-R3-05, R3-12)
  if (prog === 'security') {
    const sub = (args[0] || '').toLowerCase();
    const reveal = args.some((a) => /^-[a-zA-Z]*[wg][a-zA-Z]*$/.test(a));
    if ((/^find-(generic|internet)-password$/.test(sub) && reveal) || /^(dump-keychain|export)$/.test(sub)) {
      return V('high', 'Reads secrets from the macOS keychain');
    }
    const changes =
      /^(delete-[\w-]+|set-keychain-\w+|set-key-partition-list|(un)?lock-keychain|(add|remove)-trusted-cert|add-(generic|internet)-password|import|create-keychain)$/.test(sub) ||
      (sub === 'authorizationdb' && args[1] !== 'read') ||
      (/^(default|login|list)-keychains?$/.test(sub) && hasFlag(args, '-s'));
    if (changes) return V('high', `Changes the macOS keychain or security settings (security ${sub})`);
    if (/^(find-[\w-]+|list-keychains|show-keychain-info|default-keychain|login-keychain|dump-trust-settings|verify-cert|help|authorizationdb)$/.test(sub)) {
      return V('low', 'Reads keychain information');
    }
    return V('medium', `Runs security ${sub}`.trim());
  }
  if (secretStoreRead(prog, leadingWords(args, 3))) return V('high', `Prints secrets from ${prog}`);
  // ---- whole environment dumps (CLASSIFIER-R3-15): API keys and tokens live there
  if (
    (['env', 'printenv'].includes(prog) && args.every((a) => /^(-0|--null)$/.test(a))) ||
    (['declare', 'typeset'].includes(prog) && args.every((a) => /^-[a-zA-Z]*$/.test(a))) ||
    (prog === 'export' && args.every((a) => a === '-p')) ||
    (prog === 'set' && !args.length && ctx.shell !== 'powershell') ||
    (prog === 'get-childitem' && args.some((a) => /^env:[\\/]?\*?$/i.test(a)))
  ) {
    return V('medium', 'Prints all environment variables, which may hold secrets');
  }
  if (prog === 'rg' && args.some((a) => /^--(pre|hostname-bin)(=|$)/.test(a))) {
    // ripgrep runs the preprocessor on every file it searches (CLASSIFIER-R3-10).
    const pre = flagValue(args, '--pre') || flagValue(args, '--hostname-bin');
    const base = V('high', 'ripgrep runs a preprocessor command on every searched file');
    if (!pre) return base;
    return maxVerdict(base, perFileCommandVerdict([pre], recursiveSearchPaths('rg', args) || ['.'], ctx, 'ripgrep'));
  }
  if ((prog === 'fd' || prog === 'fdfind') && args.some((a) => /^(-x|-X|--exec|--exec-batch)(=|$)/.test(a))) {
    // fd -x/-X run a command per match (or on all of them), like find -exec (CLASSIFIER-R3-10).
    const xi = args.findIndex((a) => /^(-x|-X|--exec|--exec-batch)(=|$)/.test(a));
    const cmd = [];
    if (args[xi].includes('=')) cmd.push(args[xi].slice(args[xi].indexOf('=') + 1));
    for (let j = xi + 1; j < args.length && args[j] !== ';' && args[j] !== '\\;'; j += 1) cmd.push(args[j]);
    const before = args.slice(0, xi);
    const pos = positionals(before, FD_VALUE_FLAGS);
    const starts = pos.slice(1).concat(before.flatMap((a, k) => (a === '--search-path' && before[k + 1] ? [before[k + 1]] : [])));
    if (!cmd.length) return V('high', 'fd runs a command on every match');
    return perFileCommandVerdict(cmd, starts.length ? starts : ['.'], ctx, 'fd');
  }
  if (prog === 'new-object') {
    // A file-opening constructor writes (or reads) as it is created (CLASSIFIER-R3-08).
    const { named, positional } = psParams(args);
    let type = psNamed(named, 'typename');
    let ctorArgs = [];
    const al = psNamed(named, 'argumentlist');
    if (typeof type !== 'string') type = positional.shift() || '';
    const glued = /^([\w.`]+)\((.*?)\)?$/.exec(type);
    if (glued) {
      type = glued[1];
      ctorArgs = glued[2].split(',');
    } else if (typeof al === 'string') ctorArgs = al.split(',');
    else ctorArgs = positional;
    const cv = psConstructorVerdict(type, ctorArgs.map((x) => x.trim()).filter(Boolean), ctx);
    if (cv) return cv;
    return V('low', 'Creates a .NET or COM object');
  }
  if (prog === 'import-module') {
    // Importing a module runs its code: a downloaded .psm1 is a script (CLASSIFIER-R3-09).
    const { named, positional } = psParams(args);
    const nm = psNamed(named, 'name');
    const target = typeof nm === 'string' ? nm : positional[0] || '';
    if (!/[\\/]|\.(psm1|ps1|psd1|dll)$/i.test(target)) return V('low', 'Loads an installed PowerShell module');
    const t = resolveTarget(target, ctx, ctx.cwd);
    if (t && (insideProject(t, ctx) || isTempPath(t, ctx))) {
      return V('medium', 'Loads a PowerShell module from the project (runs its code)');
    }
    return V('high', `Loads a PowerShell module from ${truncate(t ? t.abs : target, 80)} (runs its code)`);
  }

  // ---- deletion
  if (prog === 'rm' || prog === 'unlink') {
    const recursive = args.some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a));
    if (args.includes('--no-preserve-root')) return V('critical', 'Deletes files with --no-preserve-root');
    const di = args.indexOf('--');
    const targets = (di === -1 ? args : args.slice(0, di)).filter((a) => !a.startsWith('-')).concat(di === -1 ? [] : args.slice(di + 1));
    return rmVerdict(args, ctx, { recursive, targets, label: recursive ? 'rm -r' : 'rm' });
  }
  if (prog === 'remove-item') {
    const recursive = args.some((a) => PS_RECURSE.test(a));
    const { named, positional } = psParams(args);
    const pv = psNamed(named, 'path', 'literalpath');
    const targets = typeof pv === 'string' ? pv.split(',').map((x) => x.trim()) : positional;
    return rmVerdict(args, ctx, { recursive, targets, label: recursive ? 'Remove-Item -Recurse' : 'Remove-Item' });
  }
  if (prog === 'cmd-rd' || prog === 'cmd-del') {
    const recursive = args.some((a) => /^\/s$/i.test(a));
    const targets = args.filter((a) => !/^\/[a-z]$/i.test(a));
    return rmVerdict(args, ctx, { recursive, targets, label: `${prog.slice(4)}${recursive ? ' /s' : ''}` });
  }
  if (prog === 'rmdir') return V('medium', 'Removes empty folders');
  if (prog === 'shred' || prog === 'srm') return V('high', 'Irreversibly destroys files');
  if (['trash', 'trash-put'].includes(prog) || (prog === 'gio' && args[0] === 'trash')) return V('medium', 'Moves files to the trash');
  if (prog === 'clear-recyclebin') return V('high', 'Empties the Recycle Bin');

  // ---- permissions
  if (prog === 'chmod' || prog === 'chown' || prog === 'chgrp') {
    const recursive = args.some((a) => a === '--recursive' || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(a));
    const nonFlag = args.filter((a) => !a.startsWith('-'));
    for (const raw0 of nonFlag.slice(1)) {
      const t = resolveTarget(raw0, ctx, ctx.cwd);
      const what = t && rootLike(t, ctx);
      if (what && recursive) return V('critical', `Recursively changes permissions of ${what}`);
      if (what) return V('high', `Changes permissions of ${what}`);
    }
    if (prog === 'chmod' && /(^|[^a-z])[ugoa]*\+[rwxXt]*s|^[2467][0-7]{3}$/.test(nonFlag[0] || ''))
      return V('high', 'Sets a setuid/setgid bit');
    return V('medium', `Changes file permissions (${prog})`);
  }
  if (['icacls', 'takeown', 'cacls', 'xcacls', 'set-acl'].includes(prog)) return V('high', 'Changes Windows file permissions or ownership');

  // ---- processes
  if (prog === 'kill') {
    if (args.length >= 2 && args[args.length - 1] === '-1') return V('critical', 'Kills every process you own');
    if (
      args.some((a) => /^-(9|kill|sigkill)$/i.test(a)) ||
      (args.includes('-s') && /^(9|kill|sigkill)$/i.test(args[args.indexOf('-s') + 1] || ''))
    ) {
      return V('high', 'Force-kills processes (kill -9)');
    }
    if (args.some((a) => /^-(l|L)$/.test(a))) return V('low', 'Lists signals');
    return V('medium', 'Stops a process');
  }
  if (['pkill', 'killall', 'killall5', 'xkill', 'skill', 'slay'].includes(prog)) return V('high', `Kills processes by name (${prog})`);
  if (prog === 'taskkill')
    return args.some((a) => /^\/f$/i.test(a))
      ? V('high', 'Force-kills Windows processes (taskkill /f)')
      : V('medium', 'Stops a Windows process');
  if (prog === 'stop-process')
    return args.some((a) => /^-f(o(r(ce?)?)?)?$/i.test(a))
      ? V('high', 'Force-kills processes (Stop-Process -Force)')
      : V('medium', 'Stops a process');

  // ---- services, scheduled tasks, registry, system configuration
  if (prog === 'crontab') return args.includes('-l') ? V('low', 'Lists cron jobs') : V('high', 'Changes scheduled cron jobs');
  if (prog === 'at' || prog === 'batch' || prog === 'atrm')
    return args.includes('-l') ? V('low', 'Lists at jobs') : V('high', 'Schedules commands to run later');
  if (prog === 'launchctl') {
    const a = (args[0] || '').toLowerCase();
    return [
      'list',
      'print',
      'blame',
      'getenv',
      'print-disabled',
      'managername',
      'manageruid',
      'version',
      'help',
      'dumpstate',
      'procinfo',
      'error',
      'hostinfo',
      'examine',
      'resolveport',
      'limit',
    ].includes(a) && !(a === 'limit' && args.length > 2)
      ? V('low', 'Reads launchd state')
      : V('high', `Changes launchd services (launchctl ${a})`);
  }
  if (prog === 'systemctl') {
    const w = leadingWords(args, 2);
    const a = w[0] || '';
    if (
      ['poweroff', 'reboot', 'halt', 'kexec', 'emergency', 'rescue', 'soft-reboot'].includes(a) ||
      (a === 'isolate' && /(poweroff|reboot|halt|rescue|emergency)/.test(w[1] || ''))
    ) {
      return V('critical', 'Shuts down or restarts the computer');
    }
    if (
      !a ||
      [
        'status',
        'show',
        'list-units',
        'list-unit-files',
        'list-timers',
        'list-sockets',
        'list-dependencies',
        'list-jobs',
        'is-active',
        'is-enabled',
        'is-failed',
        'is-system-running',
        'cat',
        'help',
        'get-default',
        'show-environment',
      ].includes(a)
    ) {
      return V('low', 'Reads systemd state');
    }
    return V('high', `Changes system services (systemctl ${a})`);
  }
  if (prog === 'service') {
    const a = args[1] || args[0] || '';
    return a === 'status' || args[0] === '--status-all'
      ? V('low', 'Reads service status')
      : V('high', `Changes system services (service ${args.join(' ')})`);
  }
  if (prog === 'loginctl')
    return /^(terminate|kill|lock|poweroff|reboot)/.test(args[0] || '')
      ? V('high', 'Ends or locks login sessions')
      : V('low', 'Reads login sessions');
  if (prog === 'reg') {
    const a = (args[0] || '').toLowerCase();
    if (a === 'query' || a === 'compare') return V('low', 'Reads the Windows registry');
    if (a === 'export' || a === 'save') return V('medium', 'Exports the Windows registry');
    return V('high', `Changes the Windows registry (reg ${a})`);
  }
  if (prog === 'schtasks')
    return args.some((a) => /^\/query$/i.test(a)) || !args.length
      ? V('low', 'Lists scheduled tasks')
      : V('high', 'Changes Windows scheduled tasks');
  if (
    prog === 'sc' &&
    (ctx.shell !== 'powershell' ||
      /^(create|delete|config|stop|start|failure|pause|continue|sdset|privs|triggerinfo|description)$/i.test(args[0] || ''))
  ) {
    return /^(query|queryex|qc|qdescription|qfailure|getdisplayname|getkeyname|enumdepend|sdshow)$/i.test(args[0] || '')
      ? V('low', 'Reads Windows services')
      : V('high', `Changes Windows services (sc ${args[0] || ''})`);
  }
  if (PS_SYSTEM_CMDLETS.has(prog)) {
    if (prog === 'set-item' && !/^(hk|registry|env:|wsman:|cert:)/i.test(args.join(' '))) return V('medium', 'Sets an item');
    return V('high', `Changes Windows system configuration (${prog})`);
  }
  if (
    /^(set-itemproperty|new-itemproperty|remove-itemproperty|rename-itemproperty|clear-itemproperty)$/.test(prog) ||
    (/^(new-item|remove-item)$/.test(prog) && /\b(hk(lm|cu|cr|u|cc)|registry)::?/i.test(args.join(' ')))
  ) {
    return /\b(hk(lm|cu|cr|u|cc)|registry)::?/i.test(args.join(' ')) || /^hk/i.test(args[0] || '')
      ? V('high', 'Changes the Windows registry')
      : V('medium', 'Changes an item property');
  }
  if (prog === 'start-process') {
    const { named } = psParams(args);
    const verb = psNamed(named, 'verb');
    if (typeof verb === 'string' && /^runas$/i.test(verb)) return V('high', 'Starts a program as administrator');
    const fp = psNamed(named, 'filepath');
    const target = typeof fp === 'string' ? fp : args.find((a) => !a.startsWith('-')) || '';
    if (PS_HOSTS.test(progName(target)) || SHELLS.test(progName(target)) || progName(target) === 'cmd') {
      const al = psNamed(named, 'argumentlist');
      if (typeof al === 'string') {
        const inner = recurse(`${target} ${al}`, 'powershell', ctx);
        if (RANK[inner.risk] >= RANK.high) return inner;
      }
    }
    return V('medium', `Starts ${truncate(target || 'a program', 60)}`);
  }
  if (['invoke-command', 'enter-pssession', 'new-pssession'].includes(prog)) {
    return hasFlag(args, '-computername', '-ComputerName', '-cn', '-session', '-Session', '-hostname', '-HostName') ||
      prog !== 'invoke-command'
      ? V('high', 'Runs commands on a remote computer')
      : V('medium', 'Runs a PowerShell script block');
  }
  if (
    [
      'bcdedit',
      'bootcfg',
      'csrutil',
      'spctl',
      'nvram',
      'bless',
      'kextload',
      'kextunload',
      'kmutil',
      'efibootmgr',
      'grub-install',
      'update-grub',
      'grub-mkconfig',
      'mokutil',
    ].includes(prog)
  ) {
    if (prog === 'csrutil' && args[0] === 'status') return V('low', 'Reads SIP status');
    if (prog === 'spctl' && (args.includes('--status') || args.includes('--assess'))) return V('low', 'Reads Gatekeeper status');
    if (prog === 'bcdedit' && (!args.length || /^\/enum$/i.test(args[0]))) return V('low', 'Reads boot configuration');
    return V('high', `Changes boot or system security settings (${prog})`);
  }
  if (
    [
      'mount',
      'umount',
      'swapon',
      'swapoff',
      'modprobe',
      'insmod',
      'rmmod',
      'losetup',
      'cryptsetup',
      'lvremove',
      'vgremove',
      'pvremove',
      'lvcreate',
      'mdadm',
      'zpool',
      'zfs',
      'btrfs',
    ].includes(prog)
  ) {
    if ((prog === 'mount' && !args.length) || ((prog === 'zfs' || prog === 'zpool') && ['list', 'status', 'get'].includes(args[0])))
      return V('low', 'Reads mounts');
    return V('high', `Changes disks or kernel modules (${prog})`);
  }
  if (prog === 'sysctl')
    return hasFlag(args, '-w', '--write', '-p', '--load') || args.some((a) => a.includes('='))
      ? V('high', 'Changes kernel parameters')
      : V('low', 'Reads kernel parameters');
  if (['iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'pfctl'].includes(prog)) {
    if (hasFlag(args, '-L', '--list', '-S', '--list-rules', 'status', '--state', '--list-all', '-s', '-sr', 'list', '-n'))
      return V('low', 'Reads firewall rules');
    return V('high', `Changes firewall rules (${prog})`);
  }
  if (prog === 'netsh')
    return /\b(show|dump)\b/i.test(args.join(' ')) && !/\b(set|add|delete|reset)\b/i.test(args.join(' '))
      ? V('low', 'Reads network settings')
      : V('high', 'Changes Windows network or firewall settings');
  if (prog === 'ip') {
    const w = leadingWords(args, 3);
    if (w.some((x) => ['add', 'del', 'delete', 'set', 'change', 'replace', 'flush', 'append'].includes(x)))
      return V('high', 'Changes network configuration');
    return V('low', 'Reads network configuration');
  }
  if (prog === 'ifconfig') return args.length > 1 ? V('high', 'Changes network interfaces') : V('low', 'Reads network interfaces');
  if (prog === 'nmcli')
    return /\b(up|down|delete|add|modify|connect|disconnect|radio|off|on)\b/.test(args.join(' '))
      ? V('high', 'Changes network connections')
      : V('low', 'Reads network connections');
  if (prog === 'networksetup')
    return /^-(get|list|show|print)/i.test(args[0] || '') ? V('low', 'Reads network settings') : V('high', 'Changes network settings');
  if (prog === 'route')
    return /\b(add|delete|del|change|flush)\b/.test(args.join(' '))
      ? V('high', 'Changes network routes')
      : V('low', 'Reads network routes');
  if (
    [
      'useradd',
      'userdel',
      'usermod',
      'groupadd',
      'groupdel',
      'groupmod',
      'passwd',
      'chpasswd',
      'adduser',
      'deluser',
      'addgroup',
      'delgroup',
      'visudo',
      'chsh',
      'chfn',
      'gpasswd',
      'dscl',
      'sysadminctl',
      'dseditgroup',
      'pwpolicy',
    ].includes(prog)
  ) {
    if (prog === 'dscl' && /\s-(read|list|search)\b/.test(` ${args.join(' ')}`)) return V('low', 'Reads directory services');
    return V('high', `Changes user accounts (${prog})`);
  }
  if (prog === 'net') {
    const a = (args[0] || '').toLowerCase();
    if (
      ['user', 'localgroup', 'group', 'accounts'].includes(a) &&
      args.some((x) => /^\/(add|delete|del|active|passwordreq|domain)/i.test(x) || x.includes(':'))
    )
      return V('high', 'Changes Windows user accounts');
    if (['stop', 'start', 'share', 'use', 'session', 'pause', 'continue'].includes(a) && args.length > 1)
      return V('high', `Changes Windows services or shares (net ${a})`);
    return V('low', 'Reads Windows network information');
  }
  if (prog === 'setx') return V('high', 'Permanently changes Windows environment variables');
  if (
    [
      'bitsadmin',
      'mshta',
      'rundll32',
      'regsvr32',
      'wscript',
      'cscript',
      'installutil',
      'regasm',
      'regsvcs',
      'msbuild',
      'msiexec',
      'wmic',
      'cipher',
      'wevtutil',
      'fsutil',
      'auditpol',
      'secedit',
      'gpupdate',
      'dism',
      'sfc',
      'pnputil',
      'bcdboot',
      'powercfg',
      'manage-bde',
    ].includes(prog)
  ) {
    if (prog === 'wmic' && /\b(get|list)\b/i.test(args.join(' ')) && !/\b(call|delete|set|create)\b/i.test(args.join(' ')))
      return V('low', 'Reads Windows management data');
    if (prog === 'wevtutil' && /^(qe|query-events|el|enum-logs|gl|get-log)$/i.test(args[0] || ''))
      return V('low', 'Reads Windows event logs');
    if (prog === 'powercfg' && /^\/(l|list|q|query|a|availablesleepstates|batteryreport|energy)$/i.test(args[0] || ''))
      return V('low', 'Reads power settings');
    if (prog === 'fsutil' && /^(fsinfo|volume|file)$/i.test(args[0] || '') && /\b(query|list|diskfree)/i.test(args.join(' ')))
      return V('low', 'Reads filesystem information');
    if (prog === 'cipher' && !args.some((a) => /^\/w/i.test(a))) return V('medium', 'Runs cipher');
    return V('high', `Runs a Windows system tool (${prog})`);
  }
  if (prog === 'certutil')
    return /-urlcache|-addstore|-delstore|-importpfx|-decode|-encode/i.test(args.join(' '))
      ? V('high', 'Downloads files or changes certificates (certutil)')
      : V('low', 'Reads certificates');
  if (prog === 'defaults') {
    const a = (args[0] || '').toLowerCase();
    return ['read', 'read-type', 'domains', 'find', 'export', 'help'].includes(a)
      ? V('low', 'Reads macOS preferences')
      : V('medium', `Changes macOS preferences (defaults ${a})`);
  }
  if (prog === 'tmutil')
    return /^(delete|deletelocalsnapshots|disable|thinlocalsnapshots|removeexclusion|setdestination|removedestination)$/i.test(
      args[0] || '',
    )
      ? V('high', 'Changes or deletes Time Machine backups')
      : V('medium', 'Runs tmutil');
  if (prog === 'pmset')
    return /^-g$/.test(args[0] || '')
      ? V('low', 'Reads power settings')
      : args[0] === 'sleepnow' || args[0] === 'displaysleepnow'
        ? V('medium', 'Puts the Mac to sleep')
        : V('high', 'Changes power settings');
  if (
    ['gnome-session-quit', 'qdbus', 'xfce4-session-logout', 'lxqt-leave'].includes(prog) &&
    /logout|shutdown|reboot|halt|power/i.test(`${prog} ${args.join(' ')}`)
  )
    return V('high', 'Logs out or shuts down the desktop');

  // ---- remote access and transfers
  if (prog === 'ssh') {
    if (hasFlag(args, '-V', '-G', '-Q')) return V('low', 'Reads SSH information');
    return V('high', 'Runs commands on a remote host (ssh)');
  }
  if (['sftp', 'telnet', 'mosh', 'ssh-copy-id', 'rlogin', 'rsh', 'autossh', 'sshpass'].includes(prog))
    return V('high', `Connects to a remote host (${prog})`);
  if (prog === 'scp') {
    return args.some((a) => /^[^\s/\\]+:/.test(a) && !/^[a-zA-Z]:[\\/]/.test(a))
      ? V('high', 'Copies files to or from a remote host (scp)')
      : V('medium', 'Copies files (scp)');
  }
  if (prog === 'rsync') {
    if (args.some((a) => /^--(delete|remove-source-files)/.test(a))) return V('high', 'Syncs files with deletion (rsync --delete)');
    if (args.some((a) => (/^[^\s/\\]+:/.test(a) && !/^[a-zA-Z]:[\\/]/.test(a)) || a.includes('::') || a.startsWith('rsync://')))
      return V('high', 'Copies files to or from a remote host (rsync)');
    return V('medium', 'Copies files (rsync)');
  }
  if (prog === 'rclone') {
    const a = (args.find((x) => !x.startsWith('-')) || '').toLowerCase();
    if (
      [
        'ls',
        'lsd',
        'lsl',
        'lsf',
        'lsjson',
        'cat',
        'size',
        'about',
        'listremotes',
        'version',
        'check',
        'md5sum',
        'sha1sum',
        'tree',
        'ncdu',
      ].includes(a)
    )
      return V('low', 'Reads remote storage');
    if (['delete', 'purge', 'deletefile', 'rmdir', 'rmdirs', 'sync', 'move', 'moveto', 'cleanup', 'dedupe', 'bisync'].includes(a))
      return V('high', `Deletes or overwrites remote files (rclone ${a})`);
    return V('medium', `Runs rclone ${a}`);
  }
  if (['nc', 'ncat', 'netcat', 'socat'].includes(prog)) {
    if (hasFlag(args, '-e', '-c', '--exec', '--sh-exec', '--lua-exec') || /EXEC:|SYSTEM:/i.test(args.join(' ')))
      return V('high', 'Exposes a shell over the network');
    return V('medium', `Opens a network connection (${prog})`);
  }

  // ---- packages and publishing
  if (['npm', 'pnpm', 'yarn', 'bun', 'cnpm'].includes(prog)) return classifyNodePm(prog, args);
  if (/^pip[0-9.]*$/.test(prog)) return classifyPip(args);
  if (INTERPRETERS.test(prog) && args[0] === '-m' && /^pip[0-9.]*$/.test(args[1] || '')) return classifyPip(args.slice(2));
  if (prog === 'uv' && args[0] === 'pip') return classifyPip(args.slice(1));
  if (prog === 'uv' && args[0] === 'tool' && ['install', 'uninstall', 'upgrade'].includes(args[1]))
    return V('high', 'Installs a Python tool for the user');
  if (prog === 'uv' && args[0] === 'publish') return V('high', 'Publishes a Python package');
  if (
    ['twine', 'flit', 'hatch', 'poetry', 'pdm', 'vsce', 'ovsx', 'jsr', 'pod'].includes(prog) &&
    args.some((a) => ['upload', 'publish', 'push', 'trunk'].includes(a))
  ) {
    return V('high', `Publishes a package (${prog} ${args[0] || ''})`.trim());
  }
  if (prog === 'deno' && args[0] === 'publish') return V('high', 'Publishes a package to JSR');
  if (prog === 'deno' && args[0] === 'install' && hasFlag(args, '-g', '--global')) return V('high', 'Installs a global Deno tool');
  if (['mvn', 'mvnw'].includes(prog) && args.some((a) => /^(deploy|release:perform|release:prepare|deploy:deploy-file)$/.test(a)))
    return V('high', 'Publishes artifacts to a Maven repository');
  if (['gradle', 'gradlew'].includes(prog) && args.some((a) => /^(:?[\w-]+:)*publish\w*$/i.test(a)))
    return V('high', 'Publishes artifacts (gradle publish)');
  if (['dart', 'flutter'].includes(prog) && args[0] === 'pub' && args[1] === 'publish') return V('high', 'Publishes a Dart package');
  if (prog === 'nuget' && args[0] && /^(push|delete)$/i.test(args[0])) return V('high', 'Publishes or deletes a NuGet package');
  if (
    ['code', 'cursor', 'codium', 'windsurf', 'code-insiders'].includes(prog) &&
    hasFlag(args, '--install-extension', '--uninstall-extension')
  )
    return V('high', 'Installs or removes an editor extension');
  if (SYS_PKG.has(prog)) return classifySysPkg(prog, args);

  // ---- version control, cloud, containers, databases
  if (prog === 'git') return classifyGit(args, ctx);
  if (prog === 'gh') return classifyGh(args);
  if (['docker', 'podman', 'nerdctl', 'docker-compose'].includes(prog)) {
    return classifyDocker(prog === 'docker-compose' ? 'docker' : prog, prog === 'docker-compose' ? ['compose', ...args] : args);
  }
  if (CLOUD_CLIS.has(prog)) return classifyCloud(prog, args, ctx);
  if (SQL_CLIENTS.has(prog)) {
    const texts = sqlTexts(prog, args).concat(tk.heredocBodies || [], tk.herestrings);
    if (texts.some((t) => SQL_DANGER.test(t))) return V('high', 'Runs a database statement that deletes data (DROP/TRUNCATE/DELETE)');
    if (prog === 'redis-cli' && texts.some((t) => /\b(del|unlink|config\s+set|shutdown|debug|script\s+flush)\b/i.test(t)))
      return V('high', 'Deletes or changes Redis data');
    return V('medium', `Runs a database client (${prog})`);
  }
  if (['dropdb', 'dropuser', 'dropuserdb'].includes(prog) || (prog === 'mysqladmin' && args.some((a) => /^(drop|shutdown)$/i.test(a)))) {
    return V('high', 'Deletes a database or database user');
  }

  // ---- downloads and execution of downloads
  if (['curl', 'wget', 'http', 'https', 'aria2c', 'invoke-webrequest', 'invoke-restmethod'].includes(prog)) {
    return V('medium', `Makes a network request (${prog})`);
  }

  // ---- files and editors
  if (prog === 'sed') return classifySed(args, ctx);
  if (prog === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a))) return V('medium', 'Edits files in place (perl -i)');
  if (
    prog === 'open' ||
    prog === 'xdg-open' ||
    prog === 'invoke-item' ||
    prog === 'explorer' ||
    (prog === 'gio' && args[0] === 'open') ||
    prog === 'wslview' ||
    (prog === 'start' && ctx.shell !== 'powershell')
  ) {
    const target = args.filter((a) => !a.startsWith('-')).pop() || '';
    if (hasFlag(args, '-a', '-b') && !target) return V('medium', 'Opens an app');
    return anywhereToolVerdict('open', { target }, ctx);
  }
  if (prog === 'cd' || prog === 'pushd' || prog === 'set-location' || prog === 'push-location' || prog === 'chdir') {
    const dest = args.filter((a) => !a.startsWith('-')).pop();
    let next;
    if (args.includes('-') || prog === 'popd') next = null;
    else if (!dest) next = ctx.homeDir;
    else {
      const t = resolveTarget(dest, ctx, ctx.cwd);
      next = t ? t.abs : null;
    }
    return { ...V('low', 'Changes directory'), cwd: next };
  }
  if (prog === 'tee' || prog === 'tee-object') return V('medium', 'Writes output to a file (tee)');
  if (READ_ONLY_PROGS.has(prog)) {
    if (prog === 'sort' && hasFlag(args, '-o', '--output')) return V('medium', 'Writes sorted output to a file');
    return V('low', 'Read-only command');
  }
  if (ctx.shell === 'powershell' || /^[a-z]+-[a-z]+$/.test(prog)) {
    if (/^get-/.test(prog) && prog !== 'get-credential') return V('low', 'Read-only PowerShell command');
    if (PS_LOW.has(prog)) return V('low', 'Read-only PowerShell command');
  }
  if (/^(--?(version|help)|-v|-h)$/.test(args[0] || '') && args.length === 1) return V('low', `Shows ${prog} version or help`);
  if (INTERPRETERS.test(prog)) {
    if (!args.length || (args.length === 1 && args[0] === '-')) return { ...V('medium', `Starts ${prog}`), stdinExecutor: true };
    return V('medium', `Runs ${prog} code`);
  }
  if (isScriptPath(argv0Of(u))) return V('medium', `Runs ${truncate(argv0Of(u).split(/[\\/]/).pop(), 60)}`);
  const words = leadingWords(args, 3);
  const verb = words.find((w) => /^(deploy|publish|release|destroy|undeploy|teardown)$/.test(w));
  if (verb) return V('high', `Runs "${prog} ${words.slice(0, words.indexOf(verb) + 1).join(' ')}", which looks like a ${verb}`);
  return V('medium', `Runs ${[prog, ...words.slice(0, 2)].join(' ')}`);
}

function argv0Of(u) {
  return u.argv[0] || '';
}

/**
 * The text an echo/printf prints when it holds only literal words (no substitution or variable),
 * else null. Leading echo flags are dropped; printf's format escapes are applied roughly.
 */
function echoedText(argv) {
  const prog = progName(argv[0] || '');
  let args = argv.slice(1);
  if (args.some((a) => /\$|`|…/.test(a))) return null;
  if (prog === 'echo') {
    while (args.length && /^-[neE]+$/.test(args[0])) args = args.slice(1);
    return args.join(' ').replace(/\\n/g, '\n');
  }
  if (prog === 'printf') {
    if (args[0] === '--') args = args.slice(1);
    if (!args.length || /%[^%]/.test(args[0])) return args.length ? args.slice(1).join(' ') || null : null;
    return args[0].replace(/\\n/g, '\n').replace(/%%/g, '%');
  }
  return null;
}

/**
 * Classify a full shell command line.
 * @returns {{risk:string, reason:string, parts:{command:string, normalized:string, risk:string, reason:string}[]}}
 */
function classifyShellCommand(command, shell, ctx) {
  const text = str(command);
  if (ctx.depth > MAX_DEPTH) return { risk: 'high', reason: 'Deeply nested command that could not be fully inspected', parts: [] };
  if (!text.trim()) return { risk: 'low', reason: 'Empty command', parts: [] };
  const splitShell = shell === 'cmd' ? 'cmd' : shell;
  const parts = splitDetailed(text, splitShell);
  const results = [];
  let cwd = ctx.cwd;
  const local = { ...ctx, shell };
  for (const part of parts) {
    const tk = tokenize(psInlineLiteralParens(part), shell, ctx.platform);
    tk.heredocBodies = part.heredocs.map((h) => h.body);
    tk.parens = part.parens || [];
    if (part.callOp) tk.callOp = true;
    const u = unwrap(tk.argv, shell);
    let r;
    try {
      r = classifyArgv(u, tk, { ...local, cwd }, part.text);
    } catch (err) {
      log.warn(`classifier error on "${truncate(part.text, 80)}": ${err.message}`);
      r = V('high', 'Could not inspect this command');
    }
    if (r.cwd !== undefined && !part.nested) cwd = r.cwd;
    results.push({
      cwd,
      command: part.text,
      normalized: ruleTextOf(u),
      risk: r.risk,
      reason: r.reason,
      prog: progName(u.argv[0] || ''),
      stdinExecutor:
        Boolean(r.stdinExecutor) ||
        ['invoke-expression', 'iex'].includes(progName(u.argv[0] || '')) ||
        (Boolean(u.sudo) && u.argv.length === 0),
      downloader: Boolean(r.downloader),
      decoder: isDecoder(progName(u.argv[0] || ''), u.argv.slice(1)),
      ownCard: Boolean(r.ownCard),
      part,
      u,
    });
  }

  // fork bombs
  if (/(\b[\w:.]+|:)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1\s*&/.test(text) && results.length) {
    results[0].risk = 'critical';
    results[0].reason = 'Fork bomb (makes the computer unresponsive)';
  }
  // downloaded scripts piped into an interpreter: curl … | sh, iwr … | iex
  const byPipeline = new Map();
  for (const r of results) {
    const k = r.part.pipeline;
    if (!byPipeline.has(k)) byPipeline.set(k, []);
    byPipeline.get(k).push(r);
  }
  for (const list of byPipeline.values()) {
    list.sort((a, b) => a.part.pipeIndex - b.part.pipeIndex);
    let seenDownload = false;
    let seenDecoder = false;
    for (let i = 0; i < list.length; i += 1) {
      const r = list[i];
      const executes = r.stdinExecutor || STDIN_EXECUTORS.test(r.prog);
      if (seenDownload && executes && RANK[r.risk] < RANK.high) {
        r.risk = 'high';
        r.reason = 'Runs a script downloaded from the internet (download piped into a shell)';
      } else if (seenDecoder && executes && RANK[r.risk] < RANK.high) {
        r.risk = 'high';
        r.reason = 'Runs decoded data that cannot be inspected (piped into a shell)';
      }
      // `echo "rm -rf ~" | sh` runs that text: judge it like the command it is.
      const prev = i > 0 ? list[i - 1] : null;
      if (r.stdinExecutor && (SHELLS.test(r.prog) || PS_HOSTS.test(r.prog)) && prev && /^(echo|printf)$/.test(prev.prog)) {
        const literal = echoedText(prev.u.argv);
        if (literal == null && RANK[r.risk] < RANK.high) {
          r.risk = 'high';
          r.reason = 'Runs text that is only known at run time (a variable or command output piped into a shell)';
        } else if (literal != null && literal.trim()) {
          const inner = classifyShellCommand(literal, PS_HOSTS.test(r.prog) ? 'powershell' : 'bash', { ...ctx, cwd, depth: ctx.depth + 1 });
          if (RANK[inner.risk] > RANK[r.risk]) {
            r.risk = inner.risk;
            r.reason = `Text piped into ${r.prog}: ${inner.reason}`;
          }
        }
      }
      if (r.downloader) seenDownload = true;
      if (r.decoder) seenDecoder = true;
    }
  }
  // An enumerator piped into a delete deletes everything it lists, so judge the delete over the
  // enumerator's paths (CLASSIFIER-R3-13): `gci -r ~ | ri -fo`, `find ~ -type f | xargs rm`.
  for (const list of byPipeline.values()) {
    let scope = null;
    for (const r of list) {
      let prog = r.prog;
      if (shell === 'powershell') prog = PS_ALIASES[prog] || prog;
      let del = null;
      if (PIPE_DELETERS.test(prog)) del = r.u.argv[0] || prog;
      else if (prog === 'xargs') {
        const payload = xargsPayload(r.u.argv.slice(1));
        if (payload.length && PIPE_DELETERS.test(progName(payload[0]))) del = `xargs ${progName(payload[0])}`;
      } else if (shell === 'powershell' && prog === 'foreach-object') {
        const k = results.indexOf(r);
        for (let j = k + 1; j < results.length && results[j].part.nested && results[j].part.start > r.part.start; j += 1) {
          const ip = PS_ALIASES[results[j].prog] || results[j].prog;
          if (PIPE_DELETERS.test(ip) || /\.delete\(/i.test(results[j].command)) del = 'ForEach-Object';
        }
      }
      if (del && scope) {
        // Scoped like find -exec rm: a whole drive or the home folder is critical, a folder
        // outside the project high, and the project itself stays as it was.
        const sctx = { ...ctx, shell, cwd: scope.cwd };
        let v = null;
        for (const raw of scope.targets) {
          const t = resolveTarget(raw, sctx, sctx.cwd);
          const what = t && rootLike(t, sctx);
          if (what) v = maxVerdict(v, V('critical', `${scope.recursive ? 'Deletes files throughout' : 'Deletes everything in'} ${what}`));
          v = maxVerdict(v, targetVerdict(raw, sctx, 'Deletes files under'));
        }
        if (v && RANK[v.risk] > RANK[r.risk]) {
          r.risk = v.risk;
          r.reason = `${v.reason} (${scope.label} piped into ${del})`;
        }
      }
      const en = enumeratorScope(r.u, shell);
      if (en) scope = { ...en, cwd: r.cwd };
    }
  }
  // eval/source of command output: the command that prints the script decides. Known setup
  // generators (ssh-agent -s, pyenv init -, brew shellenv…) are trusted like running them.
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (!(r.prog === 'eval' || r.prog === 'source' || (r.prog === '.' && shell !== 'powershell'))) continue;
    if (!/<\(…\)|\$\(…\)|`…`/.test(r.command) || RANK[r.risk] >= RANK.high) continue;
    const inner = [];
    for (let j = i + 1; j < results.length && results[j].part.nested && results[j].part.start > r.part.start; j += 1) inner.push(results[j]);
    const byPipe = new Map();
    for (const x of inner) byPipe.set(x.part.pipeline, (byPipe.get(x.part.pipeline) || []).concat(x));
    const trusted = inner.length > 0 && [...byPipe.values()].every((pl) => pl.length === 1 && isEvalGenerator(pl[0].command));
    if (!trusted) {
      r.risk = 'high';
      r.reason = `Runs a script made at run time (${r.prog} of command output) that cannot be inspected`;
    }
  }
  const anyDownloader = results.some((r) => r.downloader);
  const anyDecoder = results.some((r) => r.decoder);
  for (const r of results) {
    if (
      anyDecoder &&
      /<\(…\)|\$\(…\)|`…`/.test(r.command) &&
      (SHELLS.test(r.prog) || INTERPRETERS.test(r.prog) || PS_HOSTS.test(r.prog)) &&
      RANK[r.risk] < RANK.high
    ) {
      r.risk = 'high';
      r.reason = 'Runs decoded data that cannot be inspected';
    }
    if (
      anyDownloader &&
      /<\(…\)|\$\(…\)|`…`/.test(r.command) &&
      (SHELLS.test(r.prog) ||
        INTERPRETERS.test(r.prog) ||
        PS_HOSTS.test(r.prog) ||
        r.prog === 'eval' ||
        r.prog === 'source' ||
        r.prog === '.') &&
      RANK[r.risk] < RANK.high
    ) {
      r.risk = 'high';
      r.reason = 'Runs a script downloaded from the internet';
    }
  }
  // heredoc bodies fed to a shell are commands too
  const pipelineHasShell = (k) =>
    (byPipeline.get(k) || []).some((x) => x.stdinExecutor && (SHELLS.test(x.prog) || PS_HOSTS.test(x.prog) || ELEVATORS.has(x.prog)));
  for (const r of results) {
    if (!r.part.heredocs.length) continue;
    if (SHELLS.test(r.prog) || PS_HOSTS.test(r.prog) || pipelineHasShell(r.part.pipeline) || r.prog === 'ssh') {
      for (const h of r.part.heredocs) {
        const inner = classifyShellCommand(h.body, shell, { ...ctx, cwd, depth: ctx.depth + 1 });
        if (RANK[inner.risk] > RANK[r.risk]) {
          r.risk = inner.risk;
          r.reason = `Script fed to ${SHELLS.test(r.prog) || PS_HOSTS.test(r.prog) || r.prog === 'ssh' ? r.prog : 'a shell'}: ${inner.reason}`;
        }
      }
    }
  }

  let best = null;
  for (const r of results) if (!best || RANK[r.risk] > RANK[best.risk]) best = r;
  if (!best) return { risk: 'low', reason: 'Empty command', parts: [] };
  let reason = best.reason;
  if (results.length > 1 && best.risk !== 'low') reason = `${reason} — in: ${truncate(oneLine(best.command), 80)}`;
  // `anywhere calls on` asks on its own click-only card; only when nothing else in the command needs one.
  const ownCard = best.ownCard && best.risk === 'critical' && results.every((r) => r.ownCard || r.risk === 'low');
  return {
    risk: best.risk,
    reason,
    parts: results.map((r) => ({ command: r.command, normalized: r.normalized, risk: r.risk, reason: r.reason })),
    ...(ownCard ? { ownCard: true } : {}),
  };
}

// ------------------------------------------------------------------ anywhere / browser / other tools

const KEY_ALIASES = {
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  windows: 'meta',
  os: 'meta',
  meta: 'meta',
  '⌘': 'meta',
  control: 'ctrl',
  ctl: 'ctrl',
  ctrl: 'ctrl',
  '^': 'ctrl',
  option: 'alt',
  opt: 'alt',
  alt: 'alt',
  altgr: 'alt',
  '⌥': 'alt',
  shift: 'shift',
  '⇧': 'shift',
  del: 'delete',
  delete: 'delete',
  esc: 'escape',
  escape: 'escape',
  bksp: 'backspace',
  backspace: 'backspace',
  return: 'enter',
  enter: 'enter',
};

const SYSTEM_COMBOS = [
  ['ctrl', 'alt', 'delete'],
  ['meta', 'alt', 'escape'],
  ['alt', 'f4'],
  ['meta', 'q'],
  ['meta', 'l'],
  ['ctrl', 'shift', 'escape'],
  ['ctrl', 'alt', 'backspace'],
  ['meta', 'shift', 'q'],
  ['ctrl', 'meta', 'q'],
  ['meta', 'alt', 'shift', 'escape'],
  ['ctrl', 'alt', 'f1'],
  ['ctrl', 'alt', 'f2'],
  ['ctrl', 'alt', 'f3'],
  ['meta', 'alt', 'eject'],
  ['ctrl', 'meta', 'eject'],
  ['ctrl', 'alt', 'meta', 'eject'],
  ['ctrl', 'meta', 'power'],
].map((c) => c.slice().sort().join('+'));

/** Normalize "Cmd+Option+Esc" → sorted canonical names. */
function normalizeKeyCombo(combo, platform = process.platform) {
  const parts = str(combo)
    .toLowerCase()
    .split(/\s*\+\s*|\s+/)
    .filter(Boolean);
  return parts.map((k) => {
    if (k === 'primary' || k === 'mod') return platform === 'darwin' ? 'meta' : 'ctrl';
    return KEY_ALIASES[k] || k;
  });
}

/**
 * Does typed text look like a password, token or one-time code?
 * @returns {string|null} why, or null
 */
function secretLike(text) {
  const t = str(text);
  if (!t.trim()) return null;
  if (logMod.redact(t) !== t) return 'looks like a secret (key, token or password)';
  const s = t.trim();
  if (/^\d{6,8}$/.test(s)) return 'looks like a one-time code';
  if (
    !/\s/.test(s) &&
    s.length >= 8 &&
    s.length <= 64 &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) &&
    !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s) &&
    !/[\\/]/.test(s) &&
    !/^[A-Za-z_$][\w$.]*\(.*\)$/.test(s) &&
    /[a-z]/.test(s) &&
    /[A-Z]/.test(s) &&
    /\d/.test(s) &&
    /[!@#$%^&*+=?~|<>{}[\]();:'",]/.test(s)
  ) {
    return 'looks like a password';
  }
  if (
    !/\s/.test(s) &&
    s.length >= 24 &&
    /^[A-Za-z0-9+/=_.-]+$/.test(s) &&
    /[a-z]/.test(s) &&
    /[A-Z]/.test(s) &&
    /\d/.test(s) &&
    entropy(s) >= 4
  ) {
    return 'looks like an access token';
  }
  return null;
}

function entropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function pt(x, y) {
  return x == null || y == null ? '' : `(${Math.round(Number(x))}, ${Math.round(Number(y))})`;
}

// Typed/pasted text that changes Claude Code or Claude Anywhere settings (self-escalation). Only
// command- or config-shaped text counts: "Set defaultMode in the docs" is prose (REGRESSIONS-7).
const SELF_ESCALATION_TYPED =
  /(^|[\n;&|(`\\/"']\s*|\bsudo\s+)(claude-)?anywhere(\.js)?["']?\s+config\s+(set|unset|reset|edit|add|remove|rm|delete)\b|\brun\.js["']?\s+config\s+(set|unset|reset|edit|add|remove|rm|delete)\b|(^|[\n;&|(`]\s*|\bsudo\s+)claude\s+config\s+(set|add|remove|unset|rm)\b|["']?defaultMode["']?\s*[:=]|\bpermissions\.mode\s*[:=]|\bconfig\s+set\s+permissions\.|bypassPermissions|dangerously-skip-permissions/im;

// Apps where typed text runs as a command once Return is pressed. Windows reports an exe's
// FileDescription ("Windows Command Processor", "Console Window Host"); GNOME Console is "Console".
const TERMINAL_APP_RE =
  /terminal|iterm|\bwarp\b|\bhyper\b|ghostty|konsole|xterm|alacritty|kitty|wezterm|tilix|terminator|terminology|tilda|rxvt|\bfoot\b|guake|yakuake|termite|sakura|qterminal|ptyxis|blackbox|st-256color|conhost|openconsole|command processor|console window host|^console$|\bkgx\b|conemu|cmder|^cmd(\.exe)?$|powershell|pwsh|windowsterminal|mintty|putty|mobaxterm|termius|tabby|cool-retro-term|\bssh\b/i;
// Process names of terminals and shells, for drivers that report the process as well as the app.
const TERMINAL_PROCESS_RE =
  /^(cmd|conhost|openconsole|windowsterminal|wt|kgx|conemu(c)?(64)?|cmder|wsl|wslhost|bash|zsh|fish|sh|dash|mintty|powershell|pwsh|putty|kitty|alacritty|wezterm(-gui)?|xterm|gnome-terminal(-server)?|konsole|tilix|terminator|terminology|tilda|guake|yakuake|foot|ghostty|iterm2?|terminal)(\.exe)?$/i;
// Apps that may be showing a terminal: integrated terminals, cloud shells in a browser, remote
// desktops and virtual machines, and run launchers (Win+R is Explorer).
const MAYBE_TERMINAL_APP_RE =
  /code|cursor|windsurf|vscodium|idea|pycharm|webstorm|goland|clion|rider|phpstorm|rubymine|datagrip|android studio|fleet|\bzed\b|sublime|emacs|n?vim|neovide|chrome|chromium|firefox|safari|edge|brave|opera|vivaldi|\barc\b|electron|java|remmina|remote desktop|mstsc|\bvnc|freerdp|rdesktop|anydesk|teamviewer|citrix|virtualbox|vmware|parallels|\butm\b|virt-manager|virt-viewer|\bboxes\b|vmconnect|qemu|explorer|krunner|\brun\b/i;
// Apps known not to run typed text: mail, chat, office, notes and plain text editors. Only these
// relax scrutiny, and only for sentences; everything unknown is judged like a terminal.
const NON_TERMINAL_APP_RE =
  /\b(slack|discord|microsoft teams|teams|zoom|telegram|signal|whatsapp|messages|messenger|skype|element|mattermost|rocket\.chat|zulip|viber|thunderbird|mail|outlook|spark|airmail|mailspring|geary|evolution|microsoft (word|excel|powerpoint|onenote)|word|excel|powerpoint|onenote|wordpad|libreoffice|soffice|writer|calc|impress|pages|numbers|keynote|notes|notion|obsidian|evernote|bear|joplin|simplenote|logseq|typora|ulysses|scrivener|textedit|notepad|gedit|text editor|mousepad|pluma|xed|figma|preview)\b/i;

/**
 * true: a terminal; false: an app known not to run typed text; null: unknown, or an app that may
 * show a terminal. Both the app name and, when the driver reports it, the process are checked.
 */
function focusIsTerminal(app, proc) {
  const names = [app, proc].filter((x) => typeof x === 'string' && x.trim());
  if (!names.length) return null;
  const procBase = typeof proc === 'string' ? proc.trim().split(/[\\/]/).pop() : '';
  if (names.some((n) => TERMINAL_APP_RE.test(n)) || (procBase && TERMINAL_PROCESS_RE.test(procBase))) return true;
  if (names.some((n) => MAYBE_TERMINAL_APP_RE.test(n))) return null;
  if (names.some((n) => NON_TERMINAL_APP_RE.test(n))) return false;
  return null;
}

/**
 * A sentence, not a command: four or more words, a capitalised first word, no shell syntax,
 * options or paths ("Reboot the router if the light is red."). A trailing newline is ignored.
 */
function looksLikeProse(text) {
  const t = String(text || '').replace(/\r?\n$/, '');
  if (/[\r\n]/.test(t)) return false;
  const words = t.trim().split(/\s+/);
  if (words.length < 4 || !/^[A-Z][a-z]/.test(words[0])) return false;
  if (/[|;&<>$`\\{}()*=~]/.test(t)) return false;
  return !words.some((w) => w.startsWith('-') || w.includes('/'));
}

function capVerdict(v, max, why) {
  if (!v || RANK[v.risk] <= RANK[max]) return v;
  return V(max, `${why}: ${v.reason}`);
}

/**
 * type_text and clipboard_set can drive a terminal: a trailing newline runs the
 * line, and a paste is the same. So the text gets the same scrutiny as Bash, and
 * self-escalation payloads are critical. For type_text (`typed`), the focused app
 * (ctx.focusedApp) and the text's shape decide how far that goes; see below.
 * Returns a verdict to maxVerdict with the base (never lowers it), or null when
 * the text is empty.
 */
function typedTextVerdict(text, ctx, { typed = false } = {}) {
  const t = str(text);
  if (!t.trim()) return null;
  if (selfEscalationText(t) || SELF_ESCALATION_TYPED.test(t))
    return V('critical', 'Types a command that changes Claude Code/Anywhere settings (self-escalation)');
  let v;
  try {
    v = recurse(t.replace(/\r?\n$/, ''), ctx.platform === 'win32' ? 'powershell' : 'bash', ctx);
  } catch {
    // prose does not always parse as a command; fall back to the medium base.
    return null;
  }
  // Command scrutiny matters where the text can run: a terminal, or text that presses Return.
  // Typed into an app known not to be a terminal, or as a sentence, it stays below critical, so
  // writing an email in auto mode does not ask about "Reboot the router…" (REGRESSIONS-7).
  // Unknown focus keeps full scrutiny: "type `reboot`, then press Return" must not slip through.
  const term = typed ? focusIsTerminal(ctx.focusedApp, ctx.focusedProcess) : null;
  const newline = /[\r\n]/.test(t);
  if (term === true) return v;
  if (looksLikeProse(t)) {
    if (term === false) return capVerdict(v, 'medium', 'Ordinary text typed outside a terminal');
    if (!newline) return capVerdict(v, 'high', 'Looks like a sentence, not a command');
    return v;
  }
  // Command-shaped text keeps its full verdict wherever it lands: a terminal the app list misses
  // ("Windows Command Processor", GNOME "Console", a remote desktop) must not turn critical into
  // high, which auto mode runs without asking (REGRESSIONS-R2-1).
  return v;
}

const OPEN_RUNNERS = /^(cmd|osascript|wscript|cscript|mshta)$/i;
const OPEN_TERMINALS =
  /^(xterm|uxterm|urxvt|rxvt|konsole|alacritty|kitty|xfce4-terminal|lxterminal|st|foot|footclient|gnome-terminal|mate-terminal|qterminal|tilix|terminator|kgx|ptyxis|wezterm|ghostty|hyper|terminology|x-terminal-emulator|wt|windowsterminal|windows terminal|conhost|terminal|iterm|iterm2)$/i;
// Terminal hosts whose positional arguments are already a command line.
const OPEN_TERMINAL_CMDLINE = /^(wt|windowsterminal|windows terminal|conhost)$/i;

/** Verdict for open {target, args}: the target run with those arguments, like a command. */
function openArgsVerdict(t, args, ctx) {
  const base = progName(t).replace(/\.app$/i, '');
  let v = null;
  try {
    v = recurseArgv([t, ...args], { ...ctx, depth: ctx.depth || 0, shell: ctx.platform === 'win32' ? 'powershell' : 'bash' });
  } catch {
    v = null;
  }
  if (SHELLS.test(base) || INTERPRETERS.test(base) || PS_HOSTS.test(base) || OPEN_RUNNERS.test(base)) {
    v = maxVerdict(v, V('high', 'Launches an interpreter or shell with arguments'));
  } else if (OPEN_TERMINALS.test(base)) {
    const runs = OPEN_TERMINAL_CMDLINE.test(base) || args.some((a) => a === '-e' || a === '--' || a === '-x' || a === '--command' || /^--command=/.test(a));
    if (runs) v = maxVerdict(v, V('high', `Opens a terminal running a command (${base})`));
  }
  return v;
}

function anywhereToolVerdict(tool, input, ctx) {
  if (tool === 'key') {
    const keys = normalizeKeyCombo(input.combo, ctx.platform);
    const id = keys.slice().sort().join('+');
    if (SYSTEM_COMBOS.includes(id)) return V('high', `Presses a system shortcut (${str(input.combo)}) that can quit apps, lock or restart`);
    return V('medium', 'Presses keys in the focused window');
  }
  if (tool === 'type_text') {
    const why = secretLike(input.text);
    let v = why ? V('high', `Types text that ${why}`) : V('medium', 'Types text into the focused window');
    return maxVerdict(v, typedTextVerdict(input.text, ctx, { typed: true }));
  }
  if (tool === 'clipboard_set') {
    const why = secretLike(input.text);
    let v = why ? V('high', `Puts text on the clipboard that ${why}`) : V('medium', 'Changes the clipboard');
    return maxVerdict(v, typedTextVerdict(input.text, ctx));
  }
  if (tool === 'open') {
    const t = str(input.target).trim();
    if (/^https?:\/\//i.test(t)) return V('medium', 'Opens a web page');
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) {
      const scheme = t.slice(0, t.indexOf(':')).toLowerCase();
      if (scheme === 'about') return V('medium', 'Opens a browser page');
      return V('high', `Opens a ${scheme}: link, which can launch other programs`);
    }
    let v;
    if (EXEC_EXT.test(t.replace(/[\\/]+$/, ''))) v = V('high', 'Opens an executable, script or installer');
    else if (input.kind === 'app' || (!/[\\/.]/.test(t) && t)) v = V('medium', 'Opens an app');
    else v = V('medium', 'Opens a file or folder');
    // Arguments make `open` a way to run commands: {target:'bash', args:['-c', ...]}.
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    if (args.length && t) v = maxVerdict(v, openArgsVerdict(t, args, ctx));
    return v;
  }
  const desk = desktopToolVerdict(tool, input, ctx);
  if (desk) return desk;
  const ticket = ticketToolVerdict(tool, input, ctx);
  if (ticket) return ticket;
  const calls = callsToolVerdict(tool);
  if (calls) return calls;
  if (ANYWHERE_LOW.has(tool)) return V('low', 'Reads the screen or talks to the user');
  if (ANYWHERE_MEDIUM.has(tool)) return V('medium', 'Controls the mouse, keyboard or windows');
  return V('medium', `Runs ${tool}`);
}

// Feature 3 (docs/CALLS-DESIGN.md §1.3(d), §13.4). Arming calls is CRITICAL and click-only, and the
// card that asks is raised by POST /api/calls/arm itself (CallManager, through requestCritical) in every
// permission mode. The tool call that leads to it is therefore marked ownCard: decide() lets it reach that
// card instead of showing a second critical card first (the user would have to click twice).
const CALLS_ARM_REASON = 'Answer phone calls for you with your voice';
// F3-SAFE-D1: the daemon routes that answer approval cards and questions, change settings or modes, or
// trade launch codes for the dialog's credentials. Only the user's own dialog, terminal and CLI use them.
const DAEMON_USER_API_RE = /\/api\/(approval|answer|config|mode|launch|shutdown)\b/i;
const DAEMON_USER_API_REASON = 'Answers approval cards or changes Claude Anywhere settings through its API (self-escalation)';

/**
 * Does a command's text name one of the daemon's routes? A route on a named internet host
 * (https://example.com/api/config) is someone else's API; anything else (localhost, an IP address,
 * a port, a variable, a path built in a script) may be the daemon.
 * @param {string} text
 * @param {RegExp} routeRe
 */
function namesDaemonRoute(text, routeRe) {
  const t = String(text || '');
  if (!routeRe.test(t)) return false;
  const re = new RegExp(routeRe.source, 'gi');
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 300), m.index);
    const url = /([a-z][a-z0-9+.-]*):\/\/([^\s'"`/]+)[^\s'"`]*$/i.exec(before);
    const host = url ? url[2].replace(/^[^@]*@/, '').replace(/:\d*$/, '').toLowerCase() : '';
    const internetHost = host && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) && !/(^|\.)localhost$/.test(host);
    if (!internetHost) return true;
  }
  return false;
}

/** @returns {{risk:string, reason:string, ownCard?:boolean}|null} null: not a calls or clone-voice tool */
function callsToolVerdict(tool) {
  if (tool === 'calls_arm') return { ...V('critical', CALLS_ARM_REASON), ownCard: true, sensitive: true };
  if (tool === 'calls_disarm') return V('low', 'Stops answering your calls');
  if (tool === 'calls_status' || tool === 'clone_voice_status') return V('low', 'Reads the status of call answering or the voice clone');
  if (tool === 'clone_voice_open') return V('low', 'Opens the voice enrollment in the Claude Anywhere dialog');
  // The call engine's own tools are never run by the companion session; a stray one asks.
  if (/^call_/.test(tool)) return V('high', 'A tool for the call assistant only');
  return null;
}

/** `anywhere calls …` / `anywhere clone-voice …` (w: the words after the program, without flags). */
function anywhereCallsCliVerdict(w) {
  if (w[0] === 'calls') {
    const sub = w[1] || 'status';
    if (sub === 'on') return { ...V('critical', CALLS_ARM_REASON), ownCard: true };
    if (['off', 'status', 'doctor', 'notes', 'help'].includes(sub)) return V('low', 'Claude Anywhere command');
    if (sub === 'cliq') return V('medium', 'Sets up Zoho Cliq messages for calls');
    if (sub === 'audio') return w[2] === 'check' ? V('low', 'Claude Anywhere command') : V('medium', 'Changes the call audio devices');
    if (sub === 'learn') return V('medium', 'Watches the screen to learn how a call rings');
    if (sub === 'test-audio') return V('medium', 'Runs the call audio self-test');
    return V('medium', `Runs anywhere calls ${sub}`);
  }
  if (w[0] === 'clone-voice') {
    const sub = w[1] || 'start';
    if (sub === 'delete') return V('high', 'Deletes your cloned voice');
    if (sub === 'install') return V('medium', 'Downloads the free voice runtime and models (about 425 MB)');
    if (sub === 'bench') return V('medium', 'Benchmarks the voice engines (uses the CPU for a minute)');
    // F3-SAFE-B3: the cloned voice saying any text aloud, outside a call and without the disclosure.
    if (sub === 'test' && w.slice(2).some((x) => !['pocket', 'zipvoice'].includes(x))) return V('high', 'Speaks text of your choice aloud in your cloned voice');
    if (['start', 'status', 'test', 'help'].includes(sub)) return V('low', 'Claude Anywhere command');
    return V('medium', `Runs anywhere clone-voice ${sub}`);
  }
  return null;
}

// ------------------------------------------------------------------ desktop assistant tools

// The virtual-assistant tools (tools-ui, tools-ocr, tools-desktop) and batch_actions. Reads are low
// (most are pre-approved for the engine; browser_tabs is not, since {cycle: true} uses the keyboard
// and is medium); input and app control is medium, high where it can run code,
// leak a secret or lose work. A session rule ("Always") never covers a high call of these tools:
// none is offered for one, and an "Always" given on a medium call does not stretch to it.
const DESKTOP_READS = {
  ui_find: 'Reads the controls of an app window (accessibility, read-only)',
  ui_tree: 'Reads the controls of an app window (accessibility, read-only)',
  find_text: 'Reads text on the screen (OCR, read-only)',
  read_screen_text: 'Reads text on the screen (OCR, read-only)',
  list_apps: 'Lists apps on this computer (read-only)',
  browser_bookmarks: 'Reads browser bookmarks (read-only)',
  browser_tabs: 'Lists open browser tabs (read-only)',
  wait_for: 'Waits for a window or text on the screen (read-only)',
};
const DESKTOP_TOOLS = new Set([
  ...Object.keys(DESKTOP_READS),
  'ui_click',
  'ui_set_value',
  'launch_app',
  'quit_app',
  'set_window',
  'browser_open',
  'browser_switch_tab',
  'batch_actions',
]);

// batch_actions: each step is classified as its single tool (must agree with batchStepCall in src/mcp/tools.js).
const BATCH_STEP_TOOL = {
  click: 'click',
  double_click: 'click',
  right_click: 'click',
  move: 'mouse_move',
  drag: 'drag',
  type: 'type_text',
  key: 'key',
  scroll: 'scroll',
  wait: 'wait',
  focus_window: 'focus_window',
  ui_click: 'ui_click',
};

/**
 * The single tool a batch_actions step runs as, with that tool's arguments.
 * @returns {{type:string, tool:string, args:object}|null} null for an unknown step
 */
function batchStepCall(step) {
  if (!isPlainObject(step)) return null;
  const type = str(step.type).trim().toLowerCase();
  const tool = Object.prototype.hasOwnProperty.call(BATCH_STEP_TOOL, type) ? BATCH_STEP_TOOL[type] : null;
  if (!tool) return null;
  const pick = (...keys) => {
    const o = {};
    for (const k of keys) if (step[k] !== undefined && step[k] !== null) o[k] = step[k];
    return o;
  };
  const idText = (o) => {
    if (o.id != null) o.id = String(o.id);
    return o;
  };
  let args;
  switch (type) {
    case 'click':
      args = pick('x', 'y', 'button', 'clicks', 'modifiers', 'display');
      break;
    case 'double_click':
      args = { ...pick('x', 'y', 'modifiers', 'display'), clicks: 2 };
      break;
    case 'right_click':
      args = { ...pick('x', 'y', 'modifiers', 'display'), button: 'right' };
      break;
    case 'move':
      args = pick('x', 'y', 'display');
      break;
    case 'drag':
      args = pick('fromX', 'fromY', 'toX', 'toY', 'button', 'display');
      break;
    case 'type':
      args = pick('text', 'method');
      break;
    case 'key':
      args = pick('combo', 'repeat');
      break;
    case 'scroll':
      args = pick('direction', 'amount', 'x', 'y', 'display');
      break;
    case 'wait':
      args = pick('seconds');
      break;
    case 'focus_window':
      args = idText(pick('id', 'title', 'app'));
      break;
    default: // ui_click
      args = idText(pick('id', 'name', 'text', 'role', 'window', 'exact'));
  }
  return { type, tool, args };
}

/**
 * batch_actions: as risky as its riskiest step (each classified as its single tool), with every
 * step listed on the card.
 * @returns {{verdict:{risk:string, reason:string}, steps:string[]}}
 */
function batchClassification(input, ctx) {
  const steps = Array.isArray(input.actions) ? input.actions : [];
  if (!steps.length) return { verdict: V('low', 'Runs no actions'), steps: [] };
  let worst = null;
  let worstIndex = -1;
  const lines = [];
  steps.forEach((s, i) => {
    const call = batchStepCall(s);
    let v;
    if (!call) {
      v = V('medium', 'A step of unknown type (the batch is rejected before anything runs)');
      lines.push(`unknown step '${truncate(oneLine(isPlainObject(s) ? s.type : s), 30)}'`);
    } else {
      v = anywhereToolVerdict(call.tool, call.args, ctx);
      lines.push(anywhereSummary(call.tool, call.args, ctx));
    }
    if (!worst || RANK[v.risk] > RANK[worst.risk]) {
      worst = v;
      worstIndex = i;
    }
  });
  let reason;
  if (steps.length === 1) reason = worst.reason;
  else if (RANK[worst.risk] >= RANK.high) reason = `Step ${worstIndex + 1} of ${steps.length}: ${worst.reason}`;
  else if (worst.risk === 'medium') reason = `Runs ${steps.length} mouse, keyboard or window actions in a row`;
  else reason = 'Only waits or reads the screen';
  return { verdict: V(worst.risk, reason), steps: lines };
}

/** Card summary of a batch: every step, numbered, cut to a readable length. */
function batchSummary(input, ctx) {
  const { steps } = batchClassification(input, ctx);
  if (!steps.length) return 'Run actions (none listed)';
  const max = 400;
  let out = `Run ${steps.length} action${steps.length === 1 ? '' : 's'}: `;
  for (let i = 0; i < steps.length; i += 1) {
    const part = `${i ? '; ' : ''}${i + 1}. ${steps[i]}`;
    if (out.length + part.length > max) return `${out}; +${steps.length - i} more`;
    out += part;
  }
  return out;
}

// System processes and desktop shells: quitting one can log the user out or break the desktop.
const SYSTEM_APP_RE =
  /^(finder|dock|systemuiserver|loginwindow|windowserver|controlcenter|launchd|kernel_task|explorer|dwm|winlogon|csrss|lsass|services|svchost|smss|wininit|sihost|fontdrvhost|ctfmon|taskhostw|startmenuexperiencehost|shellexperiencehost|searchhost|gnome-shell|gnome-session(-binary)?|plasmashell|kwin(_x11|_wayland)?|ksmserver|xorg|xwayland|mutter|systemd|init|sddm|gdm3?|lightdm|xfwm4|xfce4-panel|xfce4-session|openbox|lxsession|mate-session|cinnamon(-session)?|budgie-wm|i3|sway|hyprland|weston|wayfire|labwc|pulseaudio|pipewire|dbus-daemon)$/i;

function quitAppVerdict(input) {
  const name = oneLine(input.name);
  const base = name.replace(/\.(exe|app)$/i, '').trim();
  const shown = truncate(name, 40) || 'an app';
  if (base && SYSTEM_APP_RE.test(base)) return V('high', `Quits a system process (${shown}), which can log you out or break the desktop`);
  if (/\b(claude|anywhere)\b/i.test(base)) return V('high', 'Quits Claude Anywhere or Claude Code itself');
  if (input.force === true) return V('high', `Force-quits ${shown}: unsaved work is lost`);
  return V('medium', `Quits ${shown} (it may ask to save unsaved work)`);
}

/** browser_open: web pages are medium; other schemes and local executables are high, as for open. */
function browserOpenVerdict(input) {
  const u = str(input.url).trim();
  const where = input.browser ? ` in ${truncate(oneLine(input.browser), 30)}` : ' in the browser';
  if (!u) return V('medium', `Opens a new tab or window${where}`);
  if (/^https?:\/\//i.test(u)) return V('medium', `Opens a web page${where}`);
  if (/^about:/i.test(u)) return V('medium', `Opens a browser page${where}`);
  const localPath = /^file:/i.test(u) ? u.replace(/^file:(\/\/)?/i, '') : /^([a-z]:[\\/]|[\\/~])/i.test(u) ? u : null;
  if (localPath != null) {
    let p = localPath.replace(/[?#].*$/, '');
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep it encoded */
    }
    if (EXEC_EXT.test(p.replace(/[\\/]+$/, ''))) return V('high', 'Opens a local executable, script or installer through the browser');
    return V('medium', `Opens a local file${where}`);
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u);
  // "localhost:3000/x" and "example.com:8443" are hosts with a port, not schemes.
  if (scheme && !/^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(u)) {
    return V('high', `Opens a ${scheme[1].toLowerCase()}: link, which can run code or launch other programs`);
  }
  return V('medium', `Opens a web page${where}`);
}

/** launch_app: an app by name is medium; arguments, executables and links are judged as for open. */
function launchAppVerdict(input, ctx) {
  const name = str(input.name).trim();
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const v = anywhereToolVerdict('open', { target: name, kind: 'app', args }, ctx);
  if (v.risk === 'medium') return V('medium', args.length ? 'Launches an app with arguments' : 'Launches an app');
  return v;
}

/** @returns {{risk:string, reason:string}|null} null: not a desktop-assistant tool */
function desktopToolVerdict(tool, input, ctx) {
  // browser_tabs {cycle: true} steps through the tabs with Ctrl+PageDown where they cannot be read.
  if (tool === 'browser_tabs' && input.cycle === true) return V('medium', 'Steps through the browser tabs with the keyboard (brings the browser to the front)');
  if (Object.prototype.hasOwnProperty.call(DESKTOP_READS, tool)) return V('low', DESKTOP_READS[tool]);
  switch (tool) {
    case 'ui_click':
      return V('medium', 'Presses a control in an app window');
    case 'ui_set_value': {
      const value = str(input.value);
      const why = secretLike(value);
      const v = why ? V('high', `Enters text into a field that ${why}`) : V('medium', 'Sets the text of a field in an app window');
      // It types into whatever field it finds (a terminal's too): the same scrutiny as type_text.
      return maxVerdict(v, typedTextVerdict(value, ctx, { typed: true }));
    }
    case 'launch_app':
      return launchAppVerdict(input, ctx);
    case 'quit_app':
      return quitAppVerdict(input);
    case 'set_window':
      return V('medium', 'Moves, resizes, maximizes or minimizes a window');
    case 'browser_open':
      return browserOpenVerdict(input);
    case 'browser_switch_tab':
      return V('medium', 'Switches to another browser tab');
    case 'batch_actions':
      return batchClassification(input, ctx).verdict;
    default:
      return null;
  }
}

function quotedArg(s, max = 40) {
  return `'${truncate(oneLine(s), max)}'`;
}

/** Card summaries of the desktop-assistant tools (null: not one of them). */
function desktopSummary(tool, input, ctx) {
  const i = input;
  const named = (v) => v != null && str(v).trim() !== '';
  const win = (w) => (named(w) ? ` in ${quotedArg(w, 40)}` : '');
  switch (tool) {
    case 'ui_find': {
      const what = i.name || i.text;
      return `Find ${named(i.role) ? `${truncate(oneLine(i.role), 20)} ` : ''}${named(what) ? quotedArg(what) : 'elements'}${win(i.window)}`;
    }
    case 'ui_tree':
      return `Read the controls of ${named(i.window) ? quotedArg(i.window) : 'the active window'}`;
    case 'ui_click':
      if (named(i.id) && !named(i.name) && !named(i.text)) return `Press UI element ${truncate(oneLine(i.id), 50)}`;
      return `Press ${quotedArg(i.name || i.text || i.id)}${named(i.role) ? ` (${truncate(oneLine(i.role), 20)})` : ''}${win(i.window)}`;
    case 'ui_set_value': {
      const field = named(i.id) && !named(i.name) && !named(i.text) ? `UI element ${truncate(oneLine(i.id), 40)}` : quotedArg(i.name || i.text || i.id || 'a field');
      const value = str(i.value);
      if (secretLike(value)) return `Set ${field} to a secret-looking value (${value.length} characters)`;
      return value === '' ? `Clear ${field}` : `Set ${field} to ${quotedArg(value)}`;
    }
    case 'find_text':
      return `Find ${quotedArg(i.text)} on the screen`;
    case 'read_screen_text':
      return i.region ? 'Read the text in a region of the screen' : 'Read the text on the screen';
    case 'list_apps':
      return named(i.query) ? `List apps matching ${quotedArg(i.query)}` : 'List apps';
    case 'launch_app': {
      const args = Array.isArray(i.args) ? i.args.map((a) => (/^[\w@%+=:,./-]+$/.test(String(a)) ? String(a) : `'${String(a)}'`)) : [];
      return `Launch ${truncate(oneLine([str(i.name), ...args].join(' ')), 140)}`;
    }
    case 'quit_app':
      return `${i.force === true ? 'Force-quit' : 'Quit'} ${truncate(oneLine(i.name), 60) || 'an app'}`;
    case 'set_window': {
      const w = truncate(oneLine(i.window), 60) || 'a window';
      const state = str(i.state).toLowerCase().trim();
      if (state) return `${state === 'fullscreen' ? 'Make full screen' : humanize(state)}: ${w}`;
      const b = isPlainObject(i.bounds) ? i.bounds : {};
      const size = b.width != null && b.height != null ? `, ${Math.round(Number(b.width))}x${Math.round(Number(b.height))}` : '';
      return `Move ${w} to ${pt(b.x, b.y) || 'a new place'}${size}`;
    }
    case 'wait_for': {
      const sec = Number(i.timeoutSec) > 0 ? ` (up to ${Number(i.timeoutSec)} s)` : '';
      const what = named(i.text) ? `the text ${quotedArg(i.text)}` : named(i.window) ? `the window ${quotedArg(i.window)}` : 'the screen';
      return `Wait for ${what}${i.gone === true ? ' to go away' : ''}${sec}`;
    }
    case 'browser_bookmarks':
      return `Read ${named(i.browser) ? `${truncate(oneLine(i.browser), 30)} ` : ''}bookmarks${named(i.query) ? ` matching ${quotedArg(i.query)}` : ''}${named(i.folder) ? ` in ${quotedArg(i.folder, 30)}` : ''}`;
    case 'browser_open': {
      const how = i.newWindow === true ? ' (new window)' : i.newTab === false ? ' (current tab)' : '';
      return `Open ${truncate(oneLine(i.url), 120)} in ${named(i.browser) ? truncate(oneLine(i.browser), 30) : 'the browser'}${how}`;
    }
    case 'browser_tabs':
      return `List the tabs of ${named(i.browser) ? truncate(oneLine(i.browser), 30) : 'the browser'}${i.cycle === true ? ' (stepping through them with the keyboard)' : ''}`;
    case 'browser_switch_tab': {
      const which = named(i.match) ? `the tab ${quotedArg(i.match)}` : i.index != null && Number.isFinite(Number(i.index)) ? `tab ${Number(i.index)}` : 'another tab';
      return `Switch ${named(i.browser) ? truncate(oneLine(i.browser), 30) : 'the browser'} to ${which}`;
    }
    case 'batch_actions':
      return batchSummary(i, ctx);
    default:
      return null;
  }
}

// The ticket workflow's tools (tools-browser, tools-jira, tools-project). Reads are low; Jira writes
// and the hand-off to another folder are medium: smart mode runs them without a card (they still show
// as tool rows in the transcript), ask mode asks.
const JIRA_READS = new Set(['jira_status', 'jira_get_issue', 'jira_search', 'jira_my_issues', 'jira_find_user']);
const JIRA_WRITES = {
  jira_transition: 'Changes the status of a Jira issue',
  jira_assign: 'Changes who a Jira issue is assigned to',
  jira_comment: 'Posts a comment on a Jira issue (your team sees it)',
};

/** @returns {{risk:string, reason:string}|null} null: not a ticket-workflow tool */
function ticketToolVerdict(tool, input, ctx) {
  if (tool === 'read_browser_tab') {
    return input.includeText === true
      ? V('medium', 'Copies the page text of a browser tab (briefly uses the keyboard and clipboard)')
      : V('low', 'Reads the address and title of a browser tab');
  }
  if (tool === 'find_repos') return V('low', 'Looks for git repositories in local folders (read-only)');
  if (JIRA_READS.has(tool)) return V('low', 'Reads from Jira');
  if (tool === 'jira_comment') {
    const why = secretLike(input.text);
    if (why) return V('high', `Posts a Jira comment that ${why}`);
  }
  if (JIRA_WRITES[tool]) return V('medium', JIRA_WRITES[tool]);
  if (tool === 'switch_project') return switchProjectVerdict(input, ctx);
  return null;
}

/** switch_project: medium for an ordinary folder; high for system, credential or out-of-home creation. */
function switchProjectVerdict(input, ctx) {
  const raw = str(input.dir).trim();
  if (!raw) return V('medium', 'Continues the work in another folder');
  const t = resolveTarget(raw, ctx, ctx.projectDir);
  if (!t || t.glob) return V('high', 'Continues the work in a folder whose location could not be resolved');
  const create = input.create === true;
  const inHome = (ctx.platform === 'win32') === t.win && isUnder(t.abs, ctx.homeDir, t.win);
  const root = rootLike(t, ctx);
  if (root) return V('high', `Continues the work in ${root}`);
  const sens = sensitiveKind(t, ctx) || realSensitiveKind(t, ctx);
  // "A system location" is about writing files there; a home under /root, or an existing repository
  // under /opt or /srv, is an ordinary place to work.
  const generic = sens && /^a (system location|Windows system folder)$/.test(sens.what);
  if (sens && !(generic && (inHome || (!create && isGitRepo(t))))) return V('high', `Continues the work in ${sens.what}`);
  if (create) {
    if (!inHome && !isTempPath(t, ctx) && !insideProject(t, ctx)) return V('high', `Creates a folder outside your home folder (${truncate(t.abs, 100)})`);
    return V('medium', 'Creates a folder and continues the work there in a fresh session');
  }
  return V('medium', 'Continues the work in another folder, in a fresh session');
}

/** Does a resolved local folder hold a git repository? (false for another platform's paths) */
function isGitRepo(t) {
  if (t.win !== (process.platform === 'win32')) return false;
  try {
    return fs.existsSync(path.join(t.abs, '.git'));
  } catch {
    return false;
  }
}

// Jira / Confluence MCP servers (Atlassian's own, mcp-atlassian, jira-mcp…): reads are low; writes
// medium; deletes and the server's own "destructive" tier high.
const TRACKER_SERVER_RE = /atlassian|jira|confluence/i;

function trackerServerVerdict(tool) {
  const t = str(tool).toLowerCase();
  if (/destructive|delete|remove|destroy|purge|archive/.test(t)) return V('high', 'Deletes or irreversibly changes Jira or Confluence data');
  if (/^(get|search|list|lookup|fetch|read|find|query|view|discover|describe)|userinfo|executeread|whoami/.test(t)) return V('low', 'Reads from Jira or Confluence');
  return V('medium', 'Changes Jira or Confluence data (your team sees it)');
}

function firstLineOf(s) {
  return (
    str(s)
      .split(/\r?\n/)
      .find((l) => l.trim()) || ''
  );
}

function anywhereSummary(tool, input, ctx) {
  const i = input;
  const desk = desktopSummary(tool, i, ctx);
  if (desk != null) return desk;
  switch (tool) {
    case 'read_browser_tab':
      return `Read the ${i.browser ? `${truncate(oneLine(i.browser), 30)} ` : ''}browser tab${i.includeText === true ? ' and copy its text' : ''}`;
    case 'find_repos':
      return i.query ? `Find git repositories matching '${truncate(oneLine(i.query), 60)}'` : 'Find git repositories on this computer';
    case 'switch_project': {
      const where = ctx ? displayPath(i.dir, ctx) : truncate(str(i.dir), 100);
      const task = truncate(oneLine(firstLineOf(i.task)), 70);
      return `Continue in ${where}${i.create === true ? ' (new folder)' : ''}${task ? `: ${task}` : ''}`;
    }
    case 'jira_status':
      return 'Check the Jira connection';
    case 'jira_get_issue':
      return `Read Jira issue ${truncate(oneLine(i.key), 60)}`;
    case 'jira_search':
      return `Search Jira: ${truncate(oneLine(i.jql), 80)}`;
    case 'jira_my_issues':
      return `List your Jira issues${i.status ? ` (${truncate(oneLine(i.status), 30)})` : ''}`;
    case 'jira_transition':
      return `Move ${truncate(oneLine(i.key), 40)} to '${truncate(oneLine(i.to), 40)}'`;
    case 'jira_assign': {
      const user = oneLine(i.user);
      return `Assign ${truncate(oneLine(i.key), 40)} to ${/^me$/i.test(user) ? 'you' : `'${truncate(user, 50)}'`}`;
    }
    case 'jira_comment': {
      const text = str(i.text);
      if (secretLike(text)) return `Comment on ${truncate(oneLine(i.key), 40)} with a secret-looking value (${text.length} characters)`;
      return `Comment on ${truncate(oneLine(i.key), 40)}: '${truncate(oneLine(text), 60)}'`;
    }
    case 'jira_find_user':
      return `Find the Jira user '${truncate(oneLine(i.query), 40)}'`;
    case 'screenshot':
      return i.region ? 'Take a screenshot of a region' : 'Take a screenshot';
    case 'click': {
      const clicks = Number(i.clicks) || 1;
      const button = str(i.button || 'left').toLowerCase();
      let verb = clicks === 2 ? 'Double-click' : clicks >= 3 ? 'Triple-click' : 'Click';
      if (button === 'right') verb = clicks === 2 ? 'Double right-click' : 'Right-click';
      else if (button === 'middle') verb = 'Middle-click';
      const mods = Array.isArray(i.modifiers) && i.modifiers.length ? ` with ${i.modifiers.join('+')}` : '';
      return `${verb} at ${pt(i.x, i.y)}${mods}`;
    }
    case 'mouse_move':
      return `Move the mouse to ${pt(i.x, i.y)}`;
    case 'drag':
      return `Drag from ${pt(i.fromX, i.fromY)} to ${pt(i.toX, i.toY)}`;
    case 'scroll':
      return `Scroll ${str(i.direction || 'down')} ${Number(i.amount) || 3}${i.x != null && i.y != null ? ` at ${pt(i.x, i.y)}` : ''}`;
    case 'type_text': {
      const text = str(i.text);
      if (secretLike(text)) return `Type a secret-looking value (${text.length} characters)`;
      return `Type '${truncate(oneLine(text), 40)}'`;
    }
    case 'key': {
      const n = Number(i.repeat) || 1;
      return `Press ${str(i.combo)}${n > 1 ? ` ×${n}` : ''}`;
    }
    case 'focus_window':
      return `Focus ${truncate(str(i.title || i.app || i.id || 'a window'), 60)}`;
    case 'open': {
      // Show the arguments too: they decide what an app such as a shell actually runs.
      const args = Array.isArray(i.args) ? i.args.map((a) => (/^[\w@%+=:,./-]+$/.test(String(a)) ? String(a) : `'${String(a)}'`)) : [];
      return `Open ${truncate(oneLine([str(i.target), ...args].join(' ')), 140)}`;
    }
    case 'clipboard_set': {
      const text = str(i.text);
      return secretLike(text)
        ? `Put a secret-looking value on the clipboard (${text.length} characters)`
        : `Set the clipboard to '${truncate(oneLine(text), 40)}'`;
    }
    case 'clipboard_get':
      return 'Read the clipboard';
    case 'cursor_position':
      return 'Get the cursor position';
    case 'screen_info':
      return 'Get screen information';
    case 'list_windows':
      return i.filter ? `List windows matching '${truncate(str(i.filter), 40)}'` : 'List windows';
    case 'get_desktop_context':
      return 'Read the desktop context';
    case 'wait':
      return `Wait ${Number(i.seconds) || 1} s`;
    case 'notify_user':
      return `Notify: ${truncate(oneLine(i.message), 80)}`;
    case 'ask_user':
      return `Ask: ${truncate(oneLine(i.question), 80)}`;
    case 'calls_arm': {
      const mins = Number(i.minutes);
      const apps = Array.isArray(i.apps) ? i.apps.filter((a) => typeof a === 'string').slice(0, 6).join(', ') : '';
      return `Answer your calls${Number.isFinite(mins) && mins > 0 ? ` for ${Math.round(mins)} min` : ''}${apps ? ` (${truncate(apps, 60)})` : ''}`;
    }
    case 'calls_disarm':
      return 'Stop answering your calls';
    case 'calls_status':
      return 'Read the call-answering status';
    case 'clone_voice_status':
      return 'Read the voice clone status';
    case 'clone_voice_open':
      return 'Open the voice enrollment';
    default:
      return humanize(tool);
  }
}

const BROWSER_SERVER_RE = /chrome|browser|playwright|puppeteer|devtools|selenium|webdriver|browserbase|stagehand|firefox|safari/i;

function browserVerdict(tool, input) {
  const t = tool.toLowerCase();
  if (t === 'computer') {
    const action = str(input.action).toLowerCase();
    if (/^(screenshot|scroll|scroll_to|wait|zoom|hover|mouse_move|cursor_position)$/.test(action))
      return V('low', 'Looks at or scrolls the browser page');
    return V('medium', 'Clicks or types in the browser');
  }
  if (t === 'upload_image' || t === 'shortcuts_execute' || t === 'gif_creator') return V('medium', 'Interacts with the browser page');
  if (/javascript|eval|evaluate|execute|run_code|run_script|script|file_upload|upload_file|set_input_files|install/.test(t)) {
    return V('high', 'Runs code in the page or sends local files to a website');
  }
  if (
    /click|type|fill|form|select|press|key|drag|hover|resize|new_tab|tab_new|tabs_create|create|close|back|forward|reload|dialog|check|focus|switch|drop|upload|install|submit/.test(
      t,
    )
  ) {
    return V('medium', 'Interacts with the browser page');
  }
  if (
    /navigate|read|get|screenshot|snapshot|find|list|context|console|network|wait|title|url|text|content|query|search|inspect|accessibility|view|plan|pdf|tabs/.test(
      t,
    )
  ) {
    return V('low', 'Reads or navigates the browser');
  }
  return V('medium', 'Uses the browser');
}

function firstString(input) {
  for (const k of [
    'url',
    'command',
    'query',
    'text',
    'path',
    'file_path',
    'target',
    'selector',
    'element',
    'name',
    'title',
    'prompt',
    'message',
  ]) {
    if (typeof input[k] === 'string' && input[k].trim()) return input[k];
  }
  for (const v of Object.values(input)) if (typeof v === 'string' && v.trim()) return v;
  return '';
}

/** Card title for a tool. */
function displayName(name) {
  const n = str(name);
  const BUILTIN = {
    Bash: 'Run command',
    PowerShell: 'Run PowerShell',
    Edit: 'Edit file',
    MultiEdit: 'Edit file',
    Write: 'Write file',
    NotebookEdit: 'Edit notebook',
    Read: 'Read file',
    NotebookRead: 'Read notebook',
    Glob: 'Find files',
    Grep: 'Search files',
    LS: 'List folder',
    WebFetch: 'Fetch web page',
    WebSearch: 'Search the web',
    Task: 'Sub-agent',
    Agent: 'Sub-agent',
    TodoWrite: 'Update to-dos',
    ToolSearch: 'Load tools',
    Skill: 'Use skill',
    ExitPlanMode: 'Finish planning',
  };
  if (BUILTIN[n]) return BUILTIN[n];
  const ANY = {
    screenshot: 'Screenshot',
    click: 'Click',
    mouse_move: 'Move mouse',
    drag: 'Drag',
    scroll: 'Scroll',
    type_text: 'Type text',
    key: 'Press keys',
    cursor_position: 'Cursor position',
    screen_info: 'Screen info',
    list_windows: 'List windows',
    focus_window: 'Focus window',
    open: 'Open',
    clipboard_get: 'Read clipboard',
    clipboard_set: 'Set clipboard',
    wait: 'Wait',
    get_desktop_context: 'Desktop context',
    notify_user: 'Notify',
    ask_user: 'Ask you',
    permission_prompt: 'Permission',
    read_browser_tab: 'Read browser tab',
    find_repos: 'Find repositories',
    switch_project: 'Switch project',
    jira_status: 'Jira connection',
    jira_get_issue: 'Read Jira issue',
    jira_search: 'Search Jira',
    jira_my_issues: 'My Jira issues',
    jira_transition: 'Move Jira issue',
    jira_assign: 'Assign Jira issue',
    jira_comment: 'Comment on Jira issue',
    jira_find_user: 'Find Jira user',
    calls_arm: 'Answer my calls',
    calls_disarm: 'Stop answering calls',
    calls_status: 'Calls status',
    clone_voice_status: 'Voice clone status',
    clone_voice_open: 'Clone my voice',
    ui_find: 'Find UI elements',
    ui_tree: 'Read window controls',
    ui_click: 'Click UI element',
    ui_set_value: 'Set field value',
    find_text: 'Find text on screen',
    read_screen_text: 'Read screen text',
    list_apps: 'List apps',
    launch_app: 'Launch app',
    quit_app: 'Quit app',
    set_window: 'Arrange window',
    wait_for: 'Wait for screen',
    browser_bookmarks: 'Read bookmarks',
    browser_open: 'Open in browser',
    browser_tabs: 'List browser tabs',
    browser_switch_tab: 'Switch browser tab',
    batch_actions: 'Run several actions',
  };
  const m = /^mcp__(.+?)__(.+)$/.exec(n);
  if (m) {
    if (m[1] === 'anywhere' || /(^|_)anywhere$/.test(m[1])) return ANY[m[2]] || humanize(m[2]);
    return `${humanize(m[2])} (${m[1].replace(/^plugin_/, '')})`;
  }
  return humanize(n) || 'Tool';
}

// ------------------------------------------------------------------ classify()

/**
 * Classify a tool call by risk.
 * @param {string} toolName e.g. 'Bash', 'Edit', 'mcp__anywhere__click'
 * @param {object} input the tool input
 * @param {{projectDir?:string, platform?:string, homeDir?:string, extraDirs?:string[], tmpDir?:string}} [opts]
 * @returns {{risk:'low'|'medium'|'high'|'critical', reason:string, summary:string, parts?:object[]}}
 */
function classify(toolName, input, opts = {}) {
  const name = str(toolName);
  const inp = isPlainObject(input) ? input : {};
  const ctx = classifyContext(opts);

  if (SHELL_TOOLS[name]) {
    const shell = SHELL_TOOLS[name];
    const command = str(inp.command);
    const r = classifyShellCommand(command, shell, ctx);
    // A risky command's card shows all of it (a cut-off `--allow-unauthenticated` is how a
    // service goes public unnoticed, HEADLINE-SCENARIO-6), with secret-looking values masked.
    const limit = RANK[r.risk] >= RANK.high ? 300 : 120;
    const out = { risk: r.risk, reason: r.reason, summary: `Run: ${truncate(redactSecrets(oneLine(command)), limit)}`, parts: r.parts };
    if (r.ownCard) out.ownCard = true;
    return out;
  }

  if (FILE_EDIT_TOOLS.has(name)) {
    const raw = str(inp.file_path || inp.notebook_path || inp.path);
    const verb = name === 'Write' ? 'Write' : name === 'NotebookEdit' ? 'Edit notebook' : 'Edit';
    const summary = `${verb} ${displayPath(raw, ctx)}`;
    if (!raw) return { risk: 'medium', reason: 'Edits a file (no path given)', summary };
    const t = resolveTarget(raw, ctx, ctx.projectDir);
    if (!t) return { risk: 'high', reason: 'Edits a file whose location could not be resolved', summary };
    const sens = sensitiveKind(t, ctx) || realSensitiveKind(t, ctx);
    if (sens && sens.level === 'critical') return { risk: 'critical', reason: `Modifies ${sens.what} (self-escalation)`, summary, sensitive: true };
    if (sens) return { risk: 'high', reason: `Modifies ${sens.what}`, summary, sensitive: true };
    if (insideProject(t, ctx)) return { risk: 'medium', reason: 'Edits a file inside the project', summary };
    if (isTempPath(t, ctx)) return { risk: 'medium', reason: 'Writes a temporary file', summary };
    return { risk: 'high', reason: `Edits a file outside the project (${truncate(t.abs, 100)})`, summary };
  }

  if (LOW_TOOLS.has(name)) {
    let summary;
    switch (name) {
      case 'Read':
        summary = `Read ${displayPath(inp.file_path, ctx)}`;
        break;
      case 'NotebookRead':
        summary = `Read notebook ${displayPath(inp.notebook_path || inp.file_path, ctx)}`;
        break;
      case 'Glob':
        summary = `Find files matching ${truncate(str(inp.pattern), 60)}${inp.path ? ` in ${displayPath(inp.path, ctx)}` : ''}`;
        break;
      case 'Grep':
        summary = `Search for '${truncate(str(inp.pattern), 50)}'${inp.path ? ` in ${displayPath(inp.path, ctx)}` : ''}`;
        break;
      case 'LS':
        summary = `List ${displayPath(inp.path, ctx)}`;
        break;
      case 'WebFetch':
        summary = `Fetch ${truncate(str(inp.url), 100)}`;
        break;
      case 'WebSearch':
        summary = `Search the web for '${truncate(str(inp.query), 60)}'`;
        break;
      case 'Task':
      case 'Agent':
        summary = `Run a sub-agent: ${truncate(oneLine(inp.description || inp.prompt), 70)}`;
        break;
      case 'TodoWrite':
        summary = 'Update the to-do list';
        break;
      case 'ToolSearch':
        summary = `Load tools: ${truncate(str(inp.query), 70)}`;
        break;
      case 'Skill':
        summary = `Use the ${truncate(str(inp.skill || inp.command || inp.name), 50)} skill`;
        break;
      case 'ExitPlanMode':
        summary = 'Finish planning';
        break;
      default:
        summary = displayName(name);
    }
    if (READ_TOOLS.has(name) && name !== 'Glob') {
      const raw = str(inp.file_path || inp.notebook_path || inp.path);
      const cred = raw ? readCredentialKind(raw, ctx, ctx.projectDir) : null;
      if (cred && !cred.env) return { risk: 'high', reason: `Reads ${cred.what}`, summary };
      if (cred) return { risk: 'medium', reason: `Reads ${cred.what}`, summary };
      // Grep over a folder that holds credential stores (~, ~/.claude-anywhere) prints them (LIVE-E2E-R3-6).
      const t = raw && name === 'Grep' ? resolveTarget(raw, ctx, ctx.projectDir) : null;
      const where = t && credentialAncestor(t, ctx, { recursive: true });
      if (where) return { risk: 'high', reason: `Searches ${where}, which holds credential files`, summary };
    }
    return { risk: 'low', reason: name === 'Skill' ? 'Loads a skill (no side effects by itself)' : 'Read-only or planning tool', summary };
  }

  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) {
    const [, server, tool] = m;
    if (server === 'anywhere' || /(^|_)anywhere$/.test(server)) {
      const v = anywhereToolVerdict(tool, inp, ctx);
      const out = { risk: v.risk, reason: v.reason, summary: anywhereSummary(tool, inp, ctx) };
      if (v.ownCard) out.ownCard = true;
      if (v.sensitive) out.sensitive = true;
      // A high desktop-assistant call gets its own card: no session rule covers it.
      if (DESKTOP_TOOLS.has(tool) && RANK[v.risk] >= RANK.high) out.sensitive = true;
      return out;
    }
    if (TRACKER_SERVER_RE.test(server)) {
      const v = trackerServerVerdict(tool);
      const arg = firstString(inp);
      const label = server.replace(/^plugin_/, '');
      return { risk: v.risk, reason: v.reason, summary: `${label}: ${humanize(tool)}${arg ? ` ${truncate(oneLine(arg), 70)}` : ''}` };
    }
    if (BROWSER_SERVER_RE.test(server)) {
      const v = browserVerdict(tool, inp);
      const arg = firstString(inp);
      let summary = `${humanize(tool)}${arg ? `: ${truncate(oneLine(arg), 80)}` : ''}`;
      if (/navigate/i.test(tool) && inp.url) summary = `Navigate to ${truncate(str(inp.url), 100)}`;
      return { risk: v.risk, reason: v.reason, summary };
    }
    const arg = firstString(inp);
    return {
      risk: 'medium',
      reason: `Uses the ${server.replace(/^plugin_/, '')} MCP server`,
      summary: `${server.replace(/^plugin_/, '')}: ${humanize(tool)}${arg ? ` ${truncate(oneLine(arg), 70)}` : ''}`,
    };
  }

  if (name === 'SlashCommand') return { risk: 'medium', reason: 'Runs a slash command', summary: `Run ${truncate(str(inp.command), 80)}` };
  return {
    risk: 'medium',
    reason: `Uses the ${name || 'unknown'} tool`,
    summary: `${displayName(name)}${firstString(inp) ? `: ${truncate(oneLine(firstString(inp)), 80)}` : ''}`,
  };
}

// ------------------------------------------------------------------ rules

function parseRule(rule) {
  const s = str(rule).trim();
  if (!s) return null;
  const m = /^([^()]+?)(?:\(([\s\S]*)\))?$/.exec(s);
  if (!m) return null;
  return { tool: m[1].trim(), spec: m[2] == null ? null : m[2].trim() };
}

function globToRegExp(glob, flags = '') {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else re += '.*';
    } else if (c === '?') re += '.';
    else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`, flags);
}

/** Does a command pattern ('gcloud run*', 'npm run test:*', 'git status') match a normalized command? */
function commandPatternMatch(spec, text, caseInsensitive = false) {
  const t = oneLine(text);
  const sp = oneLine(spec);
  if (!sp) return false;
  if (sp.endsWith(':*')) {
    const prefix = sp.slice(0, -2);
    const a = caseInsensitive ? t.toLowerCase() : t;
    const b = caseInsensitive ? prefix.toLowerCase() : prefix;
    return a === b || a.startsWith(`${b} `);
  }
  return globToRegExp(sp, caseInsensitive ? 'i' : '').test(t);
}

/**
 * Match a permission rule against a tool call.
 *
 * Syntax: 'ToolName', 'mcp__server__*' (glob on the tool name), 'Bash(prefix*)'
 * (glob on the normalized command; every part of a compound command must match,
 * or any part with {any:true}), 'Edit(src/**)' (path glob, project-relative or
 * absolute), 'WebFetch(domain:example.com)', or 'Tool(glob)' on the main argument.
 * @param {string} rule
 * @param {string} toolName
 * @param {object} [input]
 * @param {{any?:boolean, projectDir?:string, platform?:string, homeDir?:string}} [opts]
 * @returns {boolean}
 */
function matchRule(rule, toolName, input = {}, opts = {}) {
  const r = parseRule(rule);
  if (!r) return false;
  const name = str(toolName);
  if (r.tool.includes('*') ? !globToRegExp(r.tool).test(name) : r.tool !== name) return false;
  if (r.spec == null || r.spec === '' || r.spec === '*' || r.spec === '**') return true;
  const inp = isPlainObject(input) ? input : {};
  if (SHELL_TOOLS[name]) {
    const shell = SHELL_TOOLS[name];
    const texts = shellRuleTexts(inp.command, shell, opts.platform);
    if (!texts.length) return false;
    const test = (t) => commandPatternMatch(r.spec, t, shell === 'powershell');
    return opts.any ? texts.some(test) : texts.every(test);
  }
  if (FILE_EDIT_TOOLS.has(name) || READ_TOOLS.has(name)) {
    const ctx = classifyContext(opts);
    const raw = str(inp.file_path || inp.notebook_path || inp.path);
    if (!raw) return false;
    const t = resolveTarget(raw, ctx, ctx.projectDir);
    if (!t) return false;
    const win = t.win;
    const P = win ? path.win32 : path.posix;
    let spec = r.spec;
    if (spec.startsWith('~/') || spec.startsWith('~\\')) spec = P.join(ctx.homeDir, spec.slice(2));
    const candidates = [t.abs.replace(/\\/g, '/')];
    if (ctx.projectDir && isUnder(t.abs, ctx.projectDir, win)) candidates.push(P.relative(ctx.projectDir, t.abs).replace(/\\/g, '/'));
    const re = globToRegExp(spec.replace(/\\/g, '/').replace(/^\.\//, ''), win ? 'i' : '');
    return candidates.some((c) => re.test(c) || re.test(c.replace(/^\/+/, '')));
  }
  if (name === 'WebFetch' && /^domain:/i.test(r.spec)) {
    let host = '';
    try {
      host = new URL(str(inp.url)).hostname.toLowerCase();
    } catch {
      return false;
    }
    const want = r.spec.slice(7).trim().toLowerCase();
    return host === want || host.endsWith(`.${want}`);
  }
  const arg = firstString(inp);
  return Boolean(arg) && globToRegExp(r.spec, 'i').test(oneLine(arg));
}

function shellRuleTexts(command, shell, platform) {
  const out = [];
  for (const p of splitDetailed(str(command), shell)) {
    const tk = tokenize(p.text, shell, platform || process.platform);
    const u = unwrap(tk.argv, shell);
    const t = ruleTextOf(u);
    if (t && !/^#/.test(t)) out.push(t);
  }
  return out;
}

// Cloud verbs a session rule must never cover: approving one deploy must not approve deleting,
// disabling or opening up the service (HEADLINE-SCENARIO-2).
const NO_SESSION_RULE_VERB = /^(delete|destroy|remove|rm|rb|disable|purge|terminate|uninstall|unlink|drop|wipe|nuke|undeploy|.*iam-polic.*)$/;

// High verdicts that expose credentials start with these words: reading or printing a secret
// store ("Reads your shell history", "Prints a gcloud access token", "Reads secrets from the macOS
// keychain"), sending one out ("May send … over the network"), or searching or archiving a
// folder that holds them. Other reasons that name secrets (an environment dump, keychain changes).
const CREDENTIAL_REASON = /^(Reads|Prints|May send|Searches|Archives) /;
const SECRET_WORDS = /\b(secrets?|credentials?|tokens?|passwords?|keychain|keyring|cookies|shell history)\b/i;

/**
 * Does this part of a shell command read, print or send credentials? A session rule ("Always" on
 * an earlier card) never covers such a part, and none is offered for it: each gets its own card.
 * @param {{risk?:string, reason?:string}} part
 * @returns {boolean}
 */
function exposesCredentials(part) {
  if (!part) return false;
  const reason = str(part.reason);
  if (RANK[part.risk] >= RANK.high && CREDENTIAL_REASON.test(reason)) return true;
  return RANK[part.risk] >= RANK.medium && SECRET_WORDS.test(reason);
}

/**
 * The rule "Always this session" adds for a call, or null when no rule would be safe (the card
 * then offers no "Always"). Shell: the riskiest part's first two words; for cloud CLIs, up to the
 * verb and the resource ("gcloud run deploy shop-api*"); the exact command when its second word is
 * an option. File edits: the file's folder ("Write(/x/y/**)"), never a sensitive file.
 * @param {string} toolName
 * @param {object} input
 * @param {object} cls classify() result
 * @param {object} [opts] classify() options (project, platform, home)
 * @returns {string|null}
 */
function sessionRuleFor(toolName, input, cls, opts = {}) {
  const name = str(toolName);
  if (SHELL_TOOLS[name]) {
    const parts = (cls && cls.parts) || [];
    // Credentials (a keychain, shell history, cookies, tokens): never a session rule. A prefix
    // rule from one read would cover the other secrets beside it (`cat …/Application*`).
    if (parts.some(exposesCredentials)) return null;
    let best = null;
    for (const p of parts) if (!best || RANK[p.risk] > RANK[best.risk]) best = p;
    const norm = best ? oneLine(best.normalized) : '';
    const words = norm.split(' ').filter(Boolean);
    if (!words.length) return name;
    const exact = () => (/[*?()]/.test(norm) ? null : `${name}(${norm})`);
    // `rm -rf*` or `gcloud --project p*` would approve anything that starts that way.
    if (words.length > 1 && words[1].startsWith('-')) return exact();
    const prog = progName(words[0]);
    if (CLOUD_CLIS.has(prog)) {
      const head = [words[0]];
      for (let i = 1; i < words.length && i <= 6; i += 1) {
        const w = words[i];
        if (w.startsWith('-')) return exact();
        head.push(w);
        if (verbOf(w.toLowerCase(), prog)) {
          if (NO_SESSION_RULE_VERB.test(w.toLowerCase())) return null;
          const next = words[i + 1];
          if (next && !next.startsWith('-')) head.push(next);
          const text = head.join(' ');
          return /[*?()]/.test(text) ? null : `${name}(${text}*)`;
        }
      }
      return exact();
    }
    const head = words.slice(0, 2).join(' ').replace(/[()]/g, '');
    return `${name}(${head}*)`;
  }
  if (FILE_EDIT_TOOLS.has(name)) {
    const ctx = classifyContext(opts);
    const inp = isPlainObject(input) ? input : {};
    const raw = str(inp.file_path || inp.notebook_path || inp.path);
    const t = raw ? resolveTarget(raw, ctx, ctx.projectDir) : null;
    if (!t || t.glob || sensitiveKind(t, ctx) || realSensitiveKind(t, ctx)) return null;
    const P = t.win ? path.win32 : path.posix;
    const dirAbs = P.dirname(t.abs);
    const fwd = (x) => x.replace(/\\/g, '/');
    if (/[*?()]/.test(t.abs)) return null;
    // A whole drive or home folder is too wide a scope: then only this file.
    if (dirAbs === t.abs || rootLike({ ...t, abs: dirAbs }, ctx)) return `${name}(${fwd(t.abs)})`;
    return `${name}(${fwd(dirAbs).replace(/\/+$/, '')}/**)`;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp && (mcp[1] === 'anywhere' || /(^|_)anywhere$/.test(mcp[1]))) {
    // Each hand-off names its own folder; a secret in a Jira comment always gets its own card.
    if (mcp[2] === 'switch_project') return null;
    if (mcp[2] === 'jira_comment' && secretLike(str(isPlainObject(input) ? input.text : ''))) return null;
    // A batch can hold any steps: an "Always" for one would approve every later batch.
    if (mcp[2] === 'batch_actions') return null;
    // A high desktop-assistant call (a secret typed into a field, a force-quit, a non-web link, an
    // executable) is approved one at a time.
    if (DESKTOP_TOOLS.has(mcp[2])) {
      const c = cls && RISKS.includes(cls.risk) ? cls : classify(name, input, opts);
      if (RANK[c.risk] >= RANK.high) return null;
    }
  }
  return name;
}

/** Mask secret-looking values in a command shown on a card or written to the audit log. */
function redactSecrets(text) {
  return logMod
    .redact(str(text))
    .replace(/(^|[\s'"(,;:=])([A-Za-z_][A-Za-z0-9_]*)=([^\s,;'"]+)/g, (all, pre, key, val) =>
      /key|token|secret|passw|pwd|credential|private/i.test(key) || secretLike(val) ? `${pre}${key}=***` : all,
    );
}

/** redactSecrets over every string in a card's input. */
function redactInput(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactInput);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactInput(v);
    return out;
  }
  return value;
}

// ------------------------------------------------------------------ PermissionBroker

/**
 * Decides tool permissions for the headless engine and shows approval cards.
 */
class PermissionBroker extends EventEmitter {
  /**
   * @param {{config?:object, hub?:{broadcast:Function, on?:Function, removeListener?:Function},
   *   onNeedAttention?:(info:object)=>void, audit?:(event:object)=>void, now?:()=>number,
   *   projectDir?:string, getProjectDir?:()=>string, getExtraDirs?:()=>string[], platform?:string, homeDir?:string}} [opts]
   *   getExtraDirs: the folders the engine was given with --add-dir (VS Code workspaces); edits
   *   there are judged like project edits (HEADLINE-SCENARIO-10).
   */
  constructor({ config, hub, onNeedAttention, audit, now, projectDir, getProjectDir, getExtraDirs, platform, homeDir, activeWindow } = {}) {
    super();
    this.getExtraDirs = typeof getExtraDirs === 'function' ? getExtraDirs : null;
    this.config = config || {};
    // () => Promise<{app?:string}|null>: the focused window, so typed text is judged by where it lands.
    this.activeWindow = typeof activeWindow === 'function' ? activeWindow : null;
    this.hub = hub || null;
    this.onNeedAttention = typeof onNeedAttention === 'function' ? onNeedAttention : null;
    this.auditFn = typeof audit === 'function' ? audit : logMod.audit;
    this.now = typeof now === 'function' ? now : Date.now;
    this.platform = platform || process.platform;
    this.homeDir = homeDir || undefined;
    this.projectDir = this.absDir(projectDir);
    this.getProjectDir = typeof getProjectDir === 'function' ? getProjectDir : null;
    this.mode = normalizeMode(this.perms().mode);
    this.sessionRules = [];
    /** @type {Map<string, {card:object, input:object, cls:object, toolName:string, resolve:Function, timer:any}>} */
    this.entries = new Map();
    this.onHubEvent = null;
    if (this.hub && typeof this.hub.on === 'function') {
      this.onHubEvent = (type, data) => {
        if (type === 'project' && data && typeof data.dir === 'string' && data.dir) this.projectDir = this.absDir(data.dir);
      };
      this.hub.on('event', this.onHubEvent);
    }
  }

  /** @private */
  perms() {
    const p = this.config && this.config.permissions;
    return isPlainObject(p) ? p : {};
  }

  /** @private absolute directory in the classified platform's path style */
  absDir(dir) {
    if (!dir || typeof dir !== 'string') return null;
    const P = this.platform === 'win32' ? path.win32 : path.posix;
    return P.isAbsolute(dir) ? P.normalize(dir) : path.resolve(dir);
  }

  /** @private */
  rulesOf(key) {
    const list = this.perms()[key];
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : [];
  }

  /** @returns {string} the project directory used to judge paths */
  currentProjectDir() {
    if (this.getProjectDir) {
      try {
        const d = this.getProjectDir();
        if (d) return d;
      } catch {
        /* fall through */
      }
    }
    return this.projectDir || process.cwd();
  }

  /** @param {string} dir */
  setProjectDir(dir) {
    if (dir) this.projectDir = this.absDir(dir);
  }

  /** @private */
  ctxOpts() {
    let extraDirs = [];
    if (this.getExtraDirs) {
      try {
        const d = this.getExtraDirs();
        if (Array.isArray(d)) extraDirs = d.filter((x) => typeof x === 'string' && x.trim());
      } catch {
        extraDirs = [];
      }
    }
    return { projectDir: this.currentProjectDir(), platform: this.platform, homeDir: this.homeDir, extraDirs };
  }

  /** @private the focused window's app and process names, each null when unknown (slow or failing driver) */
  async focusedWindow() {
    const none = { app: null, process: null };
    if (!this.activeWindow) return none;
    let timer;
    try {
      const w = await Promise.race([
        Promise.resolve().then(() => this.activeWindow()),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 1500);
        }),
      ]);
      if (!w || typeof w !== 'object') return none;
      const clean = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);
      const proc = clean(w.process) || clean(w.processName) || clean(w.exe);
      return { app: clean(w.app) || clean(w.owner) || proc || clean(w.name), process: proc };
    } catch {
      return none;
    } finally {
      clearTimeout(timer);
    }
  }

  /** @private the focused window's app name, or null */
  async focusedApp() {
    return (await this.focusedWindow()).app;
  }

  /** @private */
  timeoutSec() {
    const n = Number(this.perms().approvalTimeoutSec);
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMEOUT_SEC) : DEFAULT_TIMEOUT_SEC;
  }

  /**
   * Policy decision without prompting.
   * @returns {{allow:boolean, rule?:string, why:string}}
   */
  decide(toolName, input, cls) {
    // Arming calls: the click-only critical card is raised by the arm route itself (CallManager), in every
    // mode, so the tool call goes on to that card rather than a second one (CALLS-DESIGN §13.4).
    if (cls.ownCard && cls.risk === 'critical') return { allow: true, why: 'it asks on its own click-only card' };
    if (cls.risk === 'critical') return { allow: false, why: 'critical' };
    const opts = this.ctxOpts();
    const ask = this.rulesOf('alwaysAsk').find((r) => matchRule(r, toolName, input, { ...opts, any: true }));
    if (ask) return { allow: false, why: `alwaysAsk rule ${ask}`, rule: ask };
    if (modeAllows(this.mode, cls.risk)) return { allow: true, why: `${this.mode} mode` };
    // A session rule ("Always" on an earlier card) never covers credentials, startup files or
    // settings: those always get their own card.
    const userRules = this.rulesOf('alwaysAllow');
    const rules = [...userRules, ...(cls.sensitive ? [] : this.sessionRules)];
    if (!rules.length) return { allow: false, why: 'needs approval' };
    if (SHELL_TOOLS[toolName] && Array.isArray(cls.parts) && cls.parts.length) {
      let used = null;
      const ok = cls.parts.every((p) => {
        if (p.risk === 'critical') return false;
        if (modeAllows(this.mode, p.risk)) return true;
        // A part that reads or sends credentials: only the user's own allow rules cover it.
        const pool = exposesCredentials(p) ? userRules : rules;
        const hit = pool.find((r) => {
          const pr = parseRule(r);
          if (!pr || (pr.tool.includes('*') ? !globToRegExp(pr.tool).test(toolName) : pr.tool !== toolName)) return false;
          if (pr.spec == null || pr.spec === '' || pr.spec === '*') return true;
          return commandPatternMatch(pr.spec, p.normalized, toolName === 'PowerShell');
        });
        if (hit) used = used || hit;
        return Boolean(hit);
      });
      return ok ? { allow: true, why: `rule ${used}`, rule: used || undefined } : { allow: false, why: 'needs approval' };
    }
    const hit = rules.find((r) => matchRule(r, toolName, input, opts));
    return hit ? { allow: true, why: `rule ${hit}`, rule: hit } : { allow: false, why: 'needs approval' };
  }

  /**
   * Called by POST /api/mcp/permission (the permission_prompt MCP tool).
   * @param {{tool_name:string, input?:object, tool_use_id?:string}} req
   * @returns {Promise<{behavior:'allow', updatedInput:object}|{behavior:'deny', message:string}>}
   */
  async request({ tool_name: toolNameRaw, input, tool_use_id: toolUseId } = {}) {
    const toolName = str(toolNameRaw);
    const inp = isPlainObject(input) ? input : {};
    let cls;
    try {
      const opts = this.ctxOpts();
      if (/^mcp__(.+_)?anywhere__type_text$/.test(toolName)) {
        const f = await this.focusedWindow();
        opts.focusedApp = f.app;
        opts.focusedProcess = f.process;
      }
      cls = classify(toolName, inp, opts);
    } catch (err) {
      log.error(`classify failed for ${toolName}:`, err);
      cls = { risk: 'high', reason: `Could not assess this action (${err.message})`, summary: displayName(toolName) };
    }
    let d;
    try {
      d = this.decide(toolName, inp, cls);
    } catch (err) {
      log.error('permission decision failed:', err);
      d = { allow: false, why: 'error' };
    }
    if (d.allow) {
      this.record({
        tool: toolName,
        risk: cls.risk,
        decision: 'allow',
        by: 'policy',
        summary: cls.summary,
        reason: cls.reason,
        rule: d.rule,
        mode: this.mode,
        toolUseId,
      });
      return { behavior: 'allow', updatedInput: inp };
    }
    return this.prompt(toolName, inp, cls, toolUseId, d.why);
  }

  /**
   * Raise a critical card that is not tied to an engine tool call, and wait for it. CallManager arms
   * calls with it (CALLS-DESIGN §1.3(d)): the card has no "Always" rule, and resolve() refuses an allow
   * by voice or key. The 'decision' event of the answer carries `via` and this toolUseId.
   * @param {{toolName:string, input?:object, reason?:string, summary?:string, toolUseId?:string}} req
   * @returns {Promise<{behavior:'allow', updatedInput:object}|{behavior:'deny', message:string}>}
   */
  requestCritical({ toolName, input, reason, summary, toolUseId, clickOnly = false } = {}) {
    const name = str(toolName) || 'critical_action';
    const inp = isPlainObject(input) ? input : {};
    const cls = {
      risk: 'critical',
      reason: str(reason) || 'Needs your click',
      summary: truncate(oneLine(str(summary)), 600) || displayName(name),
      sensitive: true,
      // F3-SAFE-D1: only a click in the dialog window (the request carries the dialog's credential)
      // allows it; the terminal dialog's typed "allow" does not.
      clickOnly: clickOnly === true,
    };
    return this.prompt(name, inp, cls, toolUseId, 'needs a click');
  }

  /** @private */
  prompt(toolName, input, cls, toolUseId, why) {
    const id = `ap_${uuid()}`;
    const timeoutSec = this.timeoutSec();
    const card = {
      id,
      toolName,
      displayName: displayName(toolName),
      summary: cls.summary,
      input: redactInput(logMod.redact(input)),
      risk: cls.risk,
      reason: cls.reason,
      ts: new Date(this.now()).toISOString(),
      toolUseId: toolUseId || null,
      sessionRule: cls.risk === 'critical' ? null : sessionRuleFor(toolName, input, cls, this.ctxOpts()),
      timeoutSec,
      mode: this.mode,
      ...(cls.clickOnly ? { clickOnly: true } : {}),
    };
    log.info(`approval needed (${cls.risk}, ${why}): ${card.summary}`);
    return new Promise((resolve) => {
      const entry = { card, input, cls, toolName, resolve, timer: null };
      this.entries.set(id, entry);
      entry.timer = setTimeout(
        () => {
          this.finish(id, 'deny', `No response from the user within ${formatSec(timeoutSec)} seconds`, 'timeout');
        },
        Math.max(1, Math.round(timeoutSec * 1000)),
      );
      if (entry.timer.unref) entry.timer.unref();
      this.broadcast('approval_request', card);
      this.broadcast('status', { status: 'waiting_approval', detail: 'Waiting for your approval' });
      this.emit('request', card);
      if (this.onNeedAttention) {
        try {
          this.onNeedAttention({ kind: 'approval', id, toolName, displayName: card.displayName, summary: card.summary, risk: card.risk });
        } catch (err) {
          log.warn(`onNeedAttention failed: ${err.message}`);
        }
      }
    });
  }

  /** @private */
  broadcast(type, data) {
    if (!this.hub || typeof this.hub.broadcast !== 'function') return;
    try {
      this.hub.broadcast(type, data);
    } catch (err) {
      log.warn(`broadcast ${type} failed: ${err.message}`);
    }
  }

  /** @private */
  record(event) {
    const e = { type: 'permission' };
    for (const [k, v] of Object.entries(event)) if (v !== undefined && v !== null) e[k] = v;
    try {
      this.auditFn(e);
    } catch (err) {
      log.warn(`audit failed: ${err.message}`);
    }
    this.emit('decision', e);
  }

  /**
   * @private settle a pending card
   * @param {string} [via] how the user answered: 'click', 'key', 'typed' or 'voice' (audit only)
   */
  finish(id, decision, message, by, via, dialog) {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    clearTimeout(e.timer);
    const allow = decision === 'allow' || decision === 'allow_session';
    let rule = null;
    if (decision === 'allow_session' && e.card.sessionRule) {
      rule = e.card.sessionRule;
      this.addSessionRule(rule);
    }
    this.record({
      tool: e.toolName,
      risk: e.card.risk,
      decision: allow ? decision : 'deny',
      by,
      via,
      dialog: dialog === true ? true : undefined,
      summary: e.card.summary,
      reason: e.card.reason,
      rule: rule || undefined,
      message: allow ? undefined : message,
      toolUseId: e.card.toolUseId || undefined,
    });
    const shown = by === 'timeout' ? 'timeout' : by === 'cancel' ? 'cancelled' : decision;
    this.broadcast('approval_resolved', { id, decision: shown, by, ...(via ? { via } : {}), ...(allow ? {} : { message }) });
    e.resolve(allow ? { behavior: 'allow', updatedInput: e.input } : { behavior: 'deny', message: message || 'Denied' });
    if (rule) this.reevaluatePending();
    return true;
  }

  /**
   * Answer a pending approval card.
   *
   * A critical card is allowed only by a deliberate act: a click on "Allow once" in the dialog
   * window (opts.dialog: the request carried the dialog's own credential, which DaemonServer checks)
   * or, for a critical card that is not click-only, the typed word "allow" in the terminal dialog.
   * An allow by speech, by Enter on the card, without a `via`, or a "click" that did not come from
   * the dialog is refused and the card stays pending; any of them can still deny. Click-only cards
   * (answering calls) accept only the dialog's click.
   * @param {string} id
   * @param {'allow'|'allow_session'|'deny'} decision
   * @param {string} [message] optional note from the user (deny)
   * @param {{via?:'click'|'key'|'typed'|'voice', dialog?:boolean}} [opts] how the user answered
   *   (anything else is ignored); dialog: the request came from the dialog window
   * @returns {boolean} false if no such pending card
   * @throws {Error} status 409, code CRITICAL_NEEDS_CLICK: a critical card allowed another way
   */
  resolve(id, decision, message, { via, dialog } = {}) {
    if (!['allow', 'allow_session', 'deny'].includes(decision)) return false;
    const how = APPROVAL_VIA.includes(via) ? via : undefined;
    const fromDialog = dialog === true;
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (decision !== 'deny' && entry.card.risk === 'critical') {
      const clicked = how === 'click' && fromDialog;
      const typed = how === 'typed' && !entry.card.clickOnly;
      if (!clicked && !typed) {
        const what =
          how === 'voice'
            ? 'a spoken'
            : how === 'key'
              ? 'a keyboard'
              : how === 'click'
                ? 'a click that did not come from the dialog window:'
                : how === 'typed'
                  ? 'a typed'
                  : 'an unspecified';
        this.record({
          tool: entry.toolName,
          risk: 'critical',
          decision: 'refused',
          by: 'user',
          via: how || 'none',
          summary: entry.card.summary,
          reason: `${what} ${decision === 'allow_session' ? 'always' : 'allow'} does not allow a critical action`,
          toolUseId: entry.card.toolUseId || undefined,
        });
        const err = new Error('Critical actions need a click on “Allow once”');
        err.status = 409;
        err.code = 'CRITICAL_NEEDS_CLICK';
        err.hint = entry.card.clickOnly
          ? 'Click “Allow once” on the card in the Claude Anywhere dialog window. Voice, keys and the terminal can still deny it.'
          : 'Click “Allow once” on the card in the dialog (or type allow in the terminal dialog). Voice and Esc can still deny it.';
        throw err;
      }
    }
    let msg;
    if (decision === 'deny') {
      const note = typeof message === 'string' ? message.trim() : '';
      msg = note ? `User denied: ${truncate(note, 2000)}` : 'User denied this action.';
    }
    return this.finish(id, decision, msg, 'user', how, fromDialog);
  }

  /**
   * Cancel one pending card (e.g. Claude Code stopped waiting).
   * @returns {boolean}
   */
  cancel(id, reason = 'Cancelled') {
    return this.finish(id, 'deny', reason, 'cancel');
  }

  /** Deny every pending card (interrupt, shutdown). */
  cancelAll(reason = 'Cancelled') {
    for (const id of [...this.entries.keys()]) this.finish(id, 'deny', reason, 'cancel');
  }

  /** @returns {object[]} pending approval cards */
  pending() {
    return [...this.entries.values()].map((e) => ({ ...e.card }));
  }

  /**
   * Change the permission mode; pending cards the new mode allows are approved.
   * @param {'ask'|'smart'|'auto'} mode
   * @returns {string} the mode now in effect
   */
  setMode(mode) {
    const m = String(mode || '').toLowerCase();
    if (!MODES.includes(m) && m !== 'autopilot') throw new Error(`Unknown permission mode "${mode}" (use ask, smart or auto)`);
    this.mode = normalizeMode(m);
    if (isPlainObject(this.config.permissions)) this.config.permissions.mode = this.mode;
    this.reevaluatePending();
    return this.mode;
  }

  /** @returns {string[]} rules added with "Always this session" */
  getSessionRules() {
    return this.sessionRules.slice();
  }

  /** @param {string} rule */
  addSessionRule(rule) {
    if (typeof rule === 'string' && rule && !this.sessionRules.includes(rule)) this.sessionRules.push(rule);
  }

  clearSessionRules() {
    this.sessionRules = [];
  }

  /** @private approve pending cards that the current policy now allows */
  reevaluatePending() {
    for (const [id, e] of [...this.entries]) {
      if (e.card.risk === 'critical') continue;
      let d;
      try {
        d = this.decide(e.toolName, e.input, e.cls);
      } catch {
        continue;
      }
      if (d.allow) {
        e.card.reason = `${e.card.reason} (allowed by ${d.why})`;
        this.finish(id, 'allow', undefined, 'policy');
      }
    }
  }

  /** Stop listening to the hub and deny anything pending. */
  close() {
    this.cancelAll('Claude Anywhere is shutting down');
    if (this.hub && this.onHubEvent && typeof this.hub.removeListener === 'function') this.hub.removeListener('event', this.onHubEvent);
    this.onHubEvent = null;
  }
}

function formatSec(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

module.exports = {
  classify,
  PermissionBroker,
  splitCommands,
  matchRule,
  // helpers (exported for tests and other modules)
  splitDetailed,
  tokenize,
  unwrap,
  sessionRuleFor,
  exposesCredentials,
  displayName,
  batchStepCall,
  DESKTOP_TOOLS,
  secretLike,
  normalizeKeyCombo,
  maxRisk,
  modeAllows,
  RISKS,
  MODES,
  APPROVAL_VIA,
};
