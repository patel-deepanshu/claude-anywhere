'use strict';

/**
 * `anywhere jira …`: connect Jira (free API token) so Claude can read and update tickets.
 *
 *   anywhere jira setup [--url URL] [--email EMAIL] [--token-stdin] [--no-test]   connect (prompts on a terminal)
 *   anywhere jira test                                                            check the saved connection
 *   anywhere jira status                                                          what is configured (no network)
 *   anywhere jira issue KEY                                                       print a ticket as Markdown
 *   anywhere jira search "JQL" [--max N]                                          list matching issues
 *   anywhere jira mine [--status S]                                               issues assigned to you
 *   anywhere jira remove                                                          forget the saved connection
 *
 * setup tests the connection before it saves anything, stores the settings in
 * ~/.claude-anywhere/config.json (mode 0600) and tells a running dialog. The token is never printed
 * and never accepted as a command-line argument (shell history, process list): it is typed hidden on
 * a terminal or piped with --token-stdin.
 */

const path = require('path');

const SUBCOMMANDS = ['setup', 'test', 'status', 'issue', 'search', 'mine', 'remove'];
const STDIN_MAX = 64 * 1024;

function lib() {
  return require(path.join(__dirname, '..', 'integrations', 'jira'));
}

function cliError(message, hint, exitCode) {
  const e = new Error(message);
  e.name = 'CliError';
  e.exitCode = exitCode == null ? 1 : exitCode;
  if (hint) e.hint = hint;
  return e;
}

function usage(message) {
  const e = cliError(message, 'Run "anywhere help jira" for usage.');
  e.usage = true;
  return e;
}

function cancelled() {
  return cliError('Cancelled.', null, 130);
}

/** Strip terminal escape sequences (bracketed paste markers, arrow keys) from typed input. */
function stripEscapes(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\u001b\[[0-9;?]*[~A-Za-z]|\u001b[O][A-Za-z]/g, '');
}

/**
 * Terminal prompts: a visible line, and hidden input for secrets (raw mode; nothing is echoed).
 * @param {{input?:object, output?:object}} [io]
 */
function createPrompter({ input = process.stdin, output = process.stderr } = {}) {
  return {
    interactive: Boolean(input && input.isTTY && typeof input.setRawMode === 'function'),
    ask(question, { defaultValue = '' } = {}) {
      const readline = require('readline');
      return new Promise((resolve, reject) => {
        const rl = readline.createInterface({ input, output, terminal: true });
        let answered = false;
        rl.on('SIGINT', () => {
          rl.close();
          reject(cancelled());
        });
        rl.on('close', () => {
          if (!answered) reject(cancelled());
        });
        rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ''}: `, (answer) => {
          answered = true;
          rl.close();
          resolve(stripEscapes(answer).trim() || defaultValue);
        });
      });
    },
    secret(question) {
      return new Promise((resolve, reject) => {
        output.write(`${question}: `);
        let buf = '';
        const wasRaw = Boolean(input.isRaw);
        const finish = (err, value) => {
          input.removeListener('data', onData);
          try {
            input.setRawMode(wasRaw);
          } catch (_) {
            /* stream closed */
          }
          input.pause();
          output.write('\n');
          if (err) reject(err);
          else resolve(value);
        };
        const onData = (chunk) => {
          for (const ch of stripEscapes(chunk)) {
            if (ch === '\r' || ch === '\n') return finish(null, buf.trim());
            if (ch === '\u0003') return finish(cancelled());
            if (ch === '\u0004') return buf ? finish(null, buf.trim()) : finish(cancelled());
            if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
            else if (ch === '\u0015') buf = '';
            else if (ch >= ' ') buf += ch;
          }
          return undefined;
        };
        try {
          input.setRawMode(true);
        } catch (err) {
          reject(cliError(`Cannot hide typed input on this terminal (${err.message}).`, 'Pipe the token instead: anywhere jira setup --url URL --email EMAIL --token-stdin'));
          return;
        }
        input.setEncoding('utf8');
        input.on('data', onData);
        input.resume();
      });
    },
  };
}

/** Read the token from stdin (first non-empty line; at most 64 KB). */
function readStdinToken(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      const line = data.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
      resolve(line);
    };
    if (stream.isTTY) {
      reject(cliError('--token-stdin reads the token from a pipe, but stdin is a terminal.', 'Example: printf %s "$JIRA_API_TOKEN" | anywhere jira setup --url URL --email EMAIL --token-stdin'));
      return;
    }
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      data += d;
      if (data.length > STDIN_MAX) {
        done = true;
        stream.pause();
        reject(cliError('The token read from stdin is too long.', 'Pipe only the token.'));
      }
    });
    stream.on('end', end);
    stream.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
    stream.resume();
  });
}

/**
 * @param {object} h helpers from bin/anywhere.js (tests may add `prompter`, `stdin` and `env`)
 * @returns {Object<string, object>}
 */
function commands(h) {
  const { spec, shared, call, requireDaemon, writeOut, writeErr, printJson, sym, color, EXIT } = h;
  const env = h.env || process.env;

  async function maybeDaemon() {
    try {
      return await requireDaemon();
    } catch (_) {
      return null; // not running (or unreachable): config.json is what counts
    }
  }

  /** Tell a running dialog about new Jira settings (best effort: config.json is already saved). */
  async function tellDaemon(partial) {
    const d = await maybeDaemon();
    if (!d) return false;
    try {
      await call(d.client, 'POST', '/api/config', partial, { timeoutMs: 10000 });
      return true;
    } catch (err) {
      writeErr(`${color.yellow(sym().warn, process.stderr)} The running dialog did not take the new Jira settings (${err.message}); restart it to pick them up.`);
      return false;
    }
  }

  function settingsNow() {
    return lib().resolveSettings(shared('config').load(), env);
  }

  function missingText(s) {
    const names = { baseUrl: 'URL', email: 'email', apiToken: 'API token' };
    return (s.missing || []).map((m) => names[m] || m).join(', ');
  }

  function requireConnected() {
    const J = lib();
    const s = settingsNow();
    if (!s.configured) {
      const why = s.urlError ? `the saved URL is invalid: ${s.urlError}` : `missing: ${missingText(s)}`;
      throw cliError(`Jira is not connected (${why}).`, `Run: anywhere jira setup   (Jira Cloud API tokens are free: ${J.TOKEN_PAGE})`);
    }
    return { s, client: new J.JiraClient({ baseUrl: s.baseUrl, email: s.email, apiToken: s.apiToken }) };
  }

  function jiraFailure(err, what) {
    if (err && err.name === 'CliError') return err;
    const J = lib();
    if (err && err.name === 'JiraError') return cliError(`${what}: ${err.message}`, err.hint);
    return cliError(`${what}: ${J.errorText(err)}`);
  }

  function deploymentLabel(dep) {
    return dep === 'Cloud' ? 'Jira Cloud' : dep === 'Server' ? 'Jira Server / Data Center' : 'Jira';
  }

  function sameSite(a, b) {
    const J = lib();
    try {
      return Boolean(a && b) && new URL(J.normalizeBaseUrl(a)).origin === new URL(J.normalizeBaseUrl(b)).origin;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------- setup

  async function doSetup(p) {
    const J = lib();
    const f = p.flags;
    if (f.token != null) {
      throw usage('The token is never taken as an argument (it would land in your shell history and the process list). Use --token-stdin, or run "anywhere jira setup" in a terminal to type it hidden.');
    }
    const configMod = shared('config');
    const saved = (configMod.load().jira) || {};
    const prompter = h.prompter || createPrompter();
    const interactive = !f['token-stdin'] && prompter.interactive;
    const out = f.json ? () => {} : (s) => writeErr(s);

    // 1. URL
    let baseUrl = '';
    const urlIn = typeof f.url === 'string' ? f.url : '';
    if (urlIn) {
      try {
        baseUrl = J.normalizeBaseUrl(urlIn);
      } catch (err) {
        throw usage(err.message);
      }
    } else if (interactive) {
      out('Connect Claude Anywhere to Jira (free: it uses your own API token, stored only on this computer).');
      for (let tries = 0; !baseUrl; tries += 1) {
        const answer = await prompter.ask('Jira URL (e.g. https://yourcompany.atlassian.net)', { defaultValue: saved.baseUrl || '' });
        try {
          baseUrl = J.normalizeBaseUrl(answer);
        } catch (err) {
          if (tries >= 2) throw usage(err.message);
          out(`  ${err.message}`);
        }
      }
    } else if (saved.baseUrl) {
      baseUrl = J.normalizeBaseUrl(saved.baseUrl);
    } else {
      throw usage('Pass the Jira URL: anywhere jira setup --url https://yourcompany.atlassian.net --email you@company.com --token-stdin');
    }
    const keepSaved = sameSite(baseUrl, saved.baseUrl);
    // Which kind of Jira decides the questions (email vs username) and the token page.
    let probe = { deployment: J.isCloudHost(new URL(baseUrl).hostname) ? 'Cloud' : null, reachable: true };
    if (interactive && !probe.deployment) {
      probe = await J.probeDeployment(baseUrl, { env });
      if (!probe.reachable) out(`  Could not reach ${baseUrl} yet (${probe.error}); continuing.`);
    }
    const cloud = probe.deployment === 'Cloud';
    const serverPage = `${baseUrl}${J.SERVER_TOKEN_PATH}`;
    let tokenPage = cloud ? J.TOKEN_PAGE : probe.deployment === 'Server' ? serverPage : J.tokenPageFor(baseUrl);

    // 2. email / username
    let email = typeof f.email === 'string' ? f.email.trim() : '';
    if (!email && interactive) {
      const dflt = keepSaved ? saved.email || '' : '';
      for (let tries = 0; ; tries += 1) {
        const question = cloud
          ? 'Atlassian account email'
          : probe.deployment === 'Server'
            ? 'Username (leave empty to use a personal access token)'
            : 'Email (Jira Cloud) or username (Jira Server; leave empty for a personal access token)';
        email = await prompter.ask(question, { defaultValue: dflt });
        if (!cloud || /^[^@\s]+@[^@\s]+$/.test(email)) break;
        if (tries >= 2) throw usage('Jira Cloud needs the email address of your Atlassian account.');
        out('  Enter the email address you sign in to Jira with.');
      }
    } else if (!email && keepSaved) {
      email = saved.email || '';
    }
    if (cloud && !email) throw usage('Jira Cloud needs the email address of your Atlassian account: --email you@company.com');

    // 3. token
    let apiToken = '';
    if (f['token-stdin']) {
      apiToken = await readStdinToken(h.stdin || process.stdin);
      if (!apiToken) throw usage('No token arrived on stdin.');
    } else if (interactive) {
      if (cloud) out(`Create a free API token at ${J.TOKEN_PAGE} ("Create API token"), then paste it here.`);
      else if (probe.deployment === 'Server') out(`Create a personal access token in Jira (Profile → Personal Access Tokens): ${serverPage}`);
      else out(`Jira Cloud: create a free API token at ${J.TOKEN_PAGE}\nJira Server / Data Center: create a personal access token at ${serverPage}`);
      const hasSaved = keepSaved && saved.apiToken;
      for (let tries = 0; !apiToken; tries += 1) {
        apiToken = await prompter.secret(`${cloud ? 'API token' : probe.deployment === 'Server' ? 'Personal access token (or password)' : 'API token or personal access token'}${hasSaved ? ' (Enter keeps the saved one)' : ''}`);
        if (!apiToken && hasSaved) apiToken = saved.apiToken;
        if (!apiToken && tries >= 2) throw usage('No token entered.');
      }
    } else if (keepSaved && saved.apiToken) {
      apiToken = saved.apiToken;
    } else {
      throw usage(`No terminal to type the token in: pipe it with --token-stdin, e.g.\n  printf %s "$JIRA_API_TOKEN" | anywhere jira setup --url ${baseUrl} ${email ? `--email ${email} ` : ''}--token-stdin\n  (free token: ${tokenPage})`);
    }

    // 4. test, then save
    let result = null;
    if (f.test !== false) {
      out(`Connecting to ${baseUrl} …`);
      try {
        result = await new J.JiraClient({ baseUrl, email, apiToken }).testConnection();
      } catch (err) {
        const e = jiraFailure(err, 'Could not connect to Jira, so nothing was saved');
        if (!e.hint) e.hint = `Check the URL, email and token (${tokenPage}). To save anyway: --no-test`;
        throw e;
      }
    }
    if (result) tokenPage = result.deployment === 'Cloud' ? J.TOKEN_PAGE : serverPage;
    configMod.save({ jira: { baseUrl, email, apiToken } });
    const file = shared('paths').configPath();
    const toldDialog = await tellDaemon({ jira: { baseUrl, email, apiToken } });
    if (f.json) {
      printJson({ ok: true, saved: true, tested: Boolean(result), baseUrl, email, deployment: result ? result.deployment : J.knownDeployment(baseUrl), user: result ? result.user : null, configPath: file, dialogUpdated: toldDialog });
      return EXIT.OK;
    }
    const s = sym();
    if (result) {
      const who = [result.user.displayName, result.user.email ? `<${result.user.email}>` : ''].filter(Boolean).join(' ');
      writeOut(`${color.green(s.ok)} Connected to ${deploymentLabel(result.deployment)} as ${who || 'you'}.`);
    } else {
      writeOut(`${color.yellow(s.warn)} Saved without testing the connection (--no-test). Check it with: anywhere jira test`);
    }
    writeOut(`  Saved to ${file} (only your user can read it; the token is never shown).`);
    writeOut(`  Try: anywhere jira mine   ${s.dot} or tell Claude "work on the Jira ticket open in my browser".`);
    writeOut(`  Token page: ${tokenPage}`);
    return EXIT.OK;
  }

  // ---------------------------------------------------------------- test / status

  async function doTest(p) {
    const { s, client } = requireConnected();
    let r;
    try {
      r = await client.testConnection();
    } catch (err) {
      throw jiraFailure(err, `Jira connection failed (${s.baseUrl})`);
    }
    if (p.flags.json) {
      printJson(r);
      return EXIT.OK;
    }
    const who = [r.user.displayName, r.user.email ? `<${r.user.email}>` : ''].filter(Boolean).join(' ');
    writeOut(`${color.green(sym().ok)} Connected to ${deploymentLabel(r.deployment)} (${r.baseUrl}) as ${who || 'you'}.`);
    return EXIT.OK;
  }

  async function doStatus(p) {
    const J = lib();
    const st = settingsNow();
    const pub = { ...J.publicSettings(st), deployment: st.configured ? J.knownDeployment(st.baseUrl) : null, configPath: shared('paths').configPath() };
    if (p.flags.json) {
      printJson(pub);
      return EXIT.OK;
    }
    const s = sym();
    const from = (src) => (src && src !== 'config' ? color.dim(`  (from ${src.replace(/^env:/, 'environment ')})`) : '');
    if (!st.baseUrl && !st.apiToken && !st.email) {
      writeOut(`Jira        ${color.yellow('not connected')}  ${s.arrow} anywhere jira setup`);
      writeOut(`            Jira Cloud API tokens are free: ${J.TOKEN_PAGE}`);
      return EXIT.OK;
    }
    const dep = pub.deployment ? ` (${deploymentLabel(pub.deployment)})` : '';
    writeOut(`Jira        ${st.configured ? color.green('configured') : color.yellow(`incomplete: missing ${missingText(st)}`)}${st.urlError ? color.yellow(` (bad URL: ${st.urlError})`) : ''}`);
    writeOut(`URL         ${st.baseUrl || color.dim('not set')}${dep}${from(st.source.baseUrl)}`);
    writeOut(`Email       ${st.email || color.dim('not set')}${from(st.source.email)}`);
    writeOut(`Token       ${st.apiToken ? 'set (hidden)' : color.yellow('not set')}${from(st.source.apiToken)}`);
    writeOut(st.configured ? `Check it:   anywhere jira test` : `Fix it:     anywhere jira setup`);
    return EXIT.OK;
  }

  // ---------------------------------------------------------------- reading

  async function doIssue(p) {
    const J = lib();
    const ref = p._[1];
    if (!ref) throw usage('Usage: anywhere jira issue <KEY or URL>   e.g. anywhere jira issue ABC-123');
    if (!J.parseIssueKey(ref)) throw usage(`"${ref}" is not a Jira issue key (keys look like ABC-123).`);
    const { client } = requireConnected();
    let issue;
    try {
      issue = await client.getIssue(ref);
    } catch (err) {
      throw jiraFailure(err, `Could not read ${J.parseIssueKey(ref)}`);
    }
    if (p.flags.json) printJson(issue);
    else writeOut(issue.markdown);
    return EXIT.OK;
  }

  async function printSearch(p, fn, what) {
    const J = lib();
    const { client } = requireConnected();
    let r;
    try {
      r = await fn(client);
    } catch (err) {
      throw jiraFailure(err, what);
    }
    if (p.flags.json) printJson(r);
    else writeOut(J.searchResultText(r));
    return EXIT.OK;
  }

  async function doSearch(p) {
    const jql = p._.slice(1).concat(p.rest || []).join(' ').trim();
    if (!jql) throw usage('Usage: anywhere jira search "<JQL>" [--max N]   e.g. anywhere jira search "project = ABC AND status = \\"In Progress\\""');
    const max = p.flags.max != null ? Number(p.flags.max) : undefined;
    if (max != null && (!Number.isInteger(max) || max < 1 || max > 100)) throw usage('--max must be a whole number from 1 to 100');
    return printSearch(p, (c) => c.search(jql, max), 'Jira search failed');
  }

  async function doMine(p) {
    const status = p.flags.status || p._.slice(1).join(' ');
    return printSearch(p, (c) => c.myIssues(status), 'Could not list your Jira issues');
  }

  // ---------------------------------------------------------------- remove

  async function doRemove(p) {
    const J = lib();
    const configMod = shared('config');
    const before = (configMod.load().jira) || {};
    configMod.save({ jira: { baseUrl: '', email: '', apiToken: '' } });
    // The dialog cannot be sent an empty token (the API keeps secrets it is not given), but without a URL it is not connected.
    await tellDaemon({ jira: { baseUrl: '', email: '' } });
    const left = lib().resolveSettings({}, env);
    const envLeft = Object.values(left.source).filter(Boolean);
    if (p.flags.json) {
      printJson({ ok: true, removed: Boolean(before.baseUrl || before.apiToken), environment: envLeft });
      return EXIT.OK;
    }
    writeOut(before.baseUrl || before.apiToken ? `${color.green(sym().ok)} Removed the saved Jira connection.` : 'No Jira connection was saved.');
    if (before.apiToken) writeOut(`  If you no longer need the token, revoke it: ${J.tokenPageFor(before.baseUrl || '')}`);
    if (envLeft.length) writeOut(`  Still set in your environment: ${envLeft.map((x) => x.replace(/^env:/, '')).join(', ')}`);
    return EXIT.OK;
  }

  async function run(p) {
    const sub = p._[0] || 'status';
    if (!SUBCOMMANDS.includes(sub)) throw usage(`Unknown jira command "${sub}" (use ${SUBCOMMANDS.join(', ')})`);
    if (sub === 'setup') return doSetup(p);
    if (sub === 'test') return doTest(p);
    if (sub === 'issue') return doIssue(p);
    if (sub === 'search') return doSearch(p);
    if (sub === 'mine') return doMine(p);
    if (sub === 'remove') return doRemove(p);
    return doStatus(p);
  }

  return {
    jira: {
      run,
      group: 'Setup',
      summary: 'Connect Jira (free API token) so Claude can work on tickets',
      usage: 'anywhere jira setup [--url URL] [--email EMAIL] [--token-stdin] [--no-test] | test | status | issue KEY | search "JQL" [--max N] | mine [--status S] | remove  [--json]',
      details: [
        'setup asks for the Jira URL, your email and an API token (typed hidden), tests the connection, then saves it to ~/.claude-anywhere/config.json (mode 0600).',
        'Jira Cloud API tokens are free: https://id.atlassian.com/manage-profile/security/api-tokens. Server/Data Center: a personal access token (Profile → Personal Access Tokens).',
        'Non-interactive: printf %s "$TOKEN" | anywhere jira setup --url https://you.atlassian.net --email you@company.com --token-stdin',
        'The environment works too: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (or JIRA_URL / JIRA_USER / JIRA_TOKEN, ATLASSIAN_*).',
        'issue prints a ticket as Markdown (what Claude reads); mine lists your open issues (--status todo|in progress|done|all|<name>).',
      ],
      spec: spec({ string: ['url', 'email', 'token', 'max', 'status'], boolean: ['token-stdin', 'test'] }),
    },
  };
}

module.exports = { commands, createPrompter, readStdinToken, SUBCOMMANDS };
