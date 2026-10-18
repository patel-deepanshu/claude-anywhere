'use strict';

/**
 * Jira tools for the `anywhere` MCP server (loaded by tools.js): read a ticket, search, list my
 * issues, move an issue through its workflow, assign it, comment on it and look people up, through
 * the user's own free Jira API token (src/integrations/jira.js).
 *
 * Credentials are read from config.json on every call (`anywhere jira setup` writes it while this
 * server keeps running), else from JIRA_* / ATLASSIAN_* environment variables. Without them every
 * tool answers with NOT_CONNECTED (isError) except jira_status, which explains how to connect.
 *
 * Writes (transition, assign, comment) honour the dialog's pause (GET /api/mcp/guard) and show up
 * in its activity feed.
 */

const jira = require('../integrations/jira');

const KEY_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 2000,
  description: 'The issue key, e.g. "ABC-123" (case-insensitive), or a Jira URL that contains one (…/browse/ABC-123, …?selectedIssue=ABC-123).',
};

/**
 * @param {object} ext the context tools.js passes to feature modules
 *   ext.deps.jiraClient?: (settings) => client, ext.deps.loadConfig?: () => config, ext.deps.env?: object (tests)
 * @returns {object[]} tools
 */
function createTools(ext) {
  const { config, checkGuard, postActivity, ok, fail, objectSchema, annotations } = ext;
  const deps = ext.deps || {};
  const env = deps.env || process.env;
  const makeClient = typeof deps.jiraClient === 'function' ? deps.jiraClient : (s) => new jira.JiraClient(s);

  let cached = null; // {fingerprint, client}: keeps deployment detection between calls

  function settings() {
    return jira.currentSettings(config, { env, load: deps.loadConfig });
  }

  function clientFor(s) {
    const fp = `${s.baseUrl}\n${s.email}\n${s.apiToken}`;
    if (!cached || cached.fingerprint !== fp) cached = { fingerprint: fp, client: makeClient({ baseUrl: s.baseUrl, email: s.email, apiToken: s.apiToken }) };
    return cached.client;
  }

  function errorResult(err) {
    if (err && err.code === 'ABORTED') throw err;
    if (err && err.code === 'NOT_CONFIGURED' && err.message === jira.NOT_CONNECTED) return fail(jira.NOT_CONNECTED);
    let text = jira.errorText(err);
    if (err && err.code === 'AMBIGUOUS_USER' && Array.isArray(err.candidates)) {
      text += `\n\nAsk the user which person they mean with ask_user (options: ${err.candidates
        .map((c) => JSON.stringify(c.displayName || c.email || c.accountId || c.name))
        .join(', ')}), then call jira_assign again with that person's email or accountId.`;
    } else if (err && err.code === 'UNAUTHORIZED') {
      text += '\nTell the user Jira rejected the saved credentials; they can reconnect with `anywhere jira setup` (or Settings → Jira).';
    } else if (err && (err.code === 'NO_TRANSITION' || err.code === 'AMBIGUOUS_TRANSITION')) {
      text += '\nPick one of the valid options (ask the user if it is not clear which one they want).';
    }
    return fail(text);
  }

  /** Run fn(client, signal) with the current credentials; not connected → the contract's error. */
  async function withJira(extra, fn) {
    const s = settings();
    if (!s.configured) return fail(jira.NOT_CONNECTED);
    let client;
    try {
      client = clientFor(s);
    } catch (err) {
      return errorResult(err);
    }
    try {
      return await fn(client, extra && extra.signal);
    } catch (err) {
      return errorResult(err);
    }
  }

  /** A write: pause check, then the call, then an activity line in the dialog. */
  async function writeOp(extra, tool, summarize, fn) {
    const s = settings();
    if (!s.configured) return fail(jira.NOT_CONNECTED);
    await checkGuard();
    const res = await withJira(extra, fn);
    const text = res && res.content && res.content[0] ? res.content[0].text : '';
    postActivity(res && res.isError ? { tool, summary: summarize(), ok: false, error: String(text).slice(0, 300) } : { tool, summary: (res && res.summary) || summarize(), ok: true });
    if (res) delete res.summary;
    return res;
  }

  const tools = [];

  tools.push({
    name: 'jira_status',
    title: 'Jira connection',
    description: [
      'Check whether Jira is connected for ticket work, and as whom. Returns JSON: {configured, connected, baseUrl, email, deployment ("Cloud" or "Server"), user:{displayName, email, accountId}} or, on a failed check, {configured:true, connected:false, error, hint}.',
      'When it returns {configured:false, how}, the jira_* tools are unavailable: fall back to an Atlassian/Jira MCP server if one is connected (tools named like mcp__atlassian__* or mcp__*jira*), or read the ticket from the browser tab with read_browser_tab, and tell the user they can connect Jira for free with `anywhere jira setup`.',
    ].join('\n\n'),
    inputSchema: objectSchema({}),
    annotations: annotations('Jira connection', { readOnly: true, idempotent: true }),
    handler: async (_args = {}, extra = {}) => {
      const s = settings();
      if (!s.configured) {
        const out = { configured: false, how: jira.HOW_TO_CONNECT };
        if (s.baseUrl || s.apiToken || s.email) out.missing = s.missing;
        if (s.urlError) out.urlError = s.urlError;
        return ok(JSON.stringify(out, null, 2));
      }
      try {
        const r = await clientFor(s).testConnection({ signal: extra.signal });
        return ok(JSON.stringify({ configured: true, connected: true, baseUrl: r.baseUrl, email: s.email, deployment: r.deployment, user: r.user }, null, 2));
      } catch (err) {
        if (err && err.code === 'ABORTED') throw err;
        return ok(JSON.stringify({ configured: true, connected: false, baseUrl: s.baseUrl, email: s.email, deployment: jira.knownDeployment(s.baseUrl), error: err && err.message, hint: err && err.hint }, null, 2));
      }
    },
  });

  tools.push({
    name: 'jira_get_issue',
    title: 'Read Jira issue',
    description: [
      'Read a Jira issue (ticket) as Markdown: summary, type, status, priority, assignee, reporter, sprint, story points, labels, components, fix versions, parent/epic, the full description, acceptance criteria, steps to reproduce, subtasks, linked issues, attachments (names and links), the last 10 comments, and a suggested git branch name (e.g. ABC-123-fix-login-timeout).',
      'Use it when the user mentions a ticket or says "work on the Jira ticket open in my browser" (get the key from read_browser_tab or get_desktop_context). Before changing code, read the description and acceptance criteria carefully; ask_user about anything ambiguous, and confirm which repository and folder to work in.',
    ].join('\n\n'),
    inputSchema: objectSchema({ key: KEY_SCHEMA }, ['key']),
    annotations: annotations('Read Jira issue', { readOnly: true, idempotent: true }),
    handler: async (args = {}, extra = {}) =>
      withJira(extra, async (client, signal) => {
        const issue = await client.getIssue(args.key, { signal });
        return ok(issue.markdown);
      }),
  });

  tools.push({
    name: 'jira_search',
    title: 'Search Jira',
    description: [
      'Search Jira issues with JQL and list them, one line each: key, status, summary, type, priority and assignee.',
      'Examples: project = ABC AND status = "In Progress" · text ~ "login timeout" ORDER BY updated DESC · assignee = currentUser() AND sprint in openSprints() · key in (ABC-1, ABC-2). Quote values with spaces. Jira Cloud rejects queries with no condition at all, so always include one (the server then bounds it to the last year and says so).',
      'For the user\'s own tickets, jira_my_issues is simpler. Use jira_get_issue to read one in full.',
    ].join('\n\n'),
    inputSchema: objectSchema(
      {
        jql: { type: 'string', minLength: 1, maxLength: 4000, description: 'The JQL query.' },
        max: { type: 'integer', minimum: 1, maximum: 100, description: 'Most results to return (default 20).' },
      },
      ['jql'],
    ),
    annotations: annotations('Search Jira', { readOnly: true, idempotent: true }),
    handler: async (args = {}, extra = {}) =>
      withJira(extra, async (client, signal) => {
        const r = await client.search(args.jql, args.max, { signal });
        return ok(jira.searchResultText(r));
      }),
  });

  tools.push({
    name: 'jira_my_issues',
    title: 'My Jira issues',
    description:
      'List the issues assigned to the connected Jira user, most recently updated first. status: "open" (the default: everything not done), "todo", "in progress", "done", "all", or an exact workflow status name such as "In Review". Use it for "what are my tickets?" or to find the ticket the user means when they describe it instead of giving a key.',
    inputSchema: objectSchema({
      status: { type: 'string', maxLength: 100, description: 'open (default), todo, in progress, done, all, or a status name.' },
    }),
    annotations: annotations('My Jira issues', { readOnly: true, idempotent: true }),
    handler: async (args = {}, extra = {}) =>
      withJira(extra, async (client, signal) => {
        const r = await client.myIssues(args.status, { signal });
        return ok(jira.searchResultText(r));
      }),
  });

  tools.push({
    name: 'jira_transition',
    title: 'Move Jira issue',
    description: [
      'Move an issue through its workflow, e.g. to "In Progress" when you start the work or "In Review" when you open the pull request. to: the target status or the transition name, case-insensitive ("in progress", "Start Progress", "done").',
      'If the issue cannot reach that status from where it is, the error lists the valid transitions: pick one or ask the user. Only move tickets the user asked you to work on, as part of that work or when they ask.',
    ].join('\n\n'),
    inputSchema: objectSchema({ key: KEY_SCHEMA, to: { type: 'string', minLength: 1, maxLength: 200, description: 'Target status or transition name, e.g. "In Progress".' } }, ['key', 'to']),
    annotations: annotations('Move Jira issue', { idempotent: true }),
    handler: async (args = {}, extra = {}) => {
      const key = jira.parseIssueKey(args.key) || String(args.key || '');
      return writeOp(extra, 'jira_transition', () => `Move ${key} to ${args.to}`, async (client, signal) => {
        const r = await client.transition(args.key, args.to, { signal });
        if (r.already) return { ...ok(`${r.key} is already in "${r.to}"; nothing changed.`), summary: `${r.key} already in ${r.to}` };
        const via = r.transition && r.transition.toLowerCase() !== String(r.to).toLowerCase() ? ` (transition "${r.transition}")` : '';
        return { ...ok(`Moved ${r.key}${r.from ? ` from "${r.from}"` : ''} to "${r.to}"${via}.`), summary: `Moved ${r.key} to ${r.to}` };
      });
    },
  });

  tools.push({
    name: 'jira_assign',
    title: 'Assign Jira issue',
    description: [
      'Assign an issue to someone. user: "me" (the connected Jira account), "none" to unassign, an email address, a Jira Cloud accountId, a Server username, or a display name such as "Ankit".',
      'Names are matched among the people who can be assigned this issue. When a name fits several people the error lists them with their emails and accountIds: ask the user which one with ask_user (the names as options), then call again with that email or accountId. Use jira_find_user to look someone up first.',
    ].join('\n\n'),
    inputSchema: objectSchema({ key: KEY_SCHEMA, user: { type: 'string', minLength: 1, maxLength: 200, description: '"me", "none", an email, an accountId, a username or a display name.' } }, ['key', 'user']),
    annotations: annotations('Assign Jira issue', { idempotent: true }),
    handler: async (args = {}, extra = {}) => {
      const key = jira.parseIssueKey(args.key) || String(args.key || '');
      return writeOp(extra, 'jira_assign', () => `Assign ${key} to ${args.user}`, async (client, signal) => {
        const r = await client.assign(args.key, args.user, { signal });
        if (!r.assignee) return { ...ok(`${r.key} is now unassigned.`), summary: `Unassigned ${r.key}` };
        const who = jira.describeUser(r.assignee);
        return { ...ok(`Assigned ${r.key} to ${who}.`), summary: `Assigned ${r.key} to ${jira.userLabel(r.assignee)}` };
      });
    },
  });

  tools.push({
    name: 'jira_comment',
    title: 'Comment on Jira issue',
    description: [
      'Add a comment to an issue. text is Markdown: paragraphs, **bold**, *italic*, `code`, fenced code blocks, lists, tables, quotes and links are converted to Jira\'s format. Mention someone with [~accountid:ACCOUNT_ID] (get the id from jira_find_user).',
      'Comments are visible to everyone on the project and cannot be unsent by you: post only what the user asked for or agreed to (e.g. a summary of the change with the PR link when you finish the ticket).',
    ].join('\n\n'),
    inputSchema: objectSchema({ key: KEY_SCHEMA, text: { type: 'string', minLength: 1, maxLength: 32000, description: 'The comment, in Markdown.' } }, ['key', 'text']),
    annotations: annotations('Comment on Jira issue'),
    handler: async (args = {}, extra = {}) => {
      const key = jira.parseIssueKey(args.key) || String(args.key || '');
      return writeOp(extra, 'jira_comment', () => `Comment on ${key}`, async (client, signal) => {
        const r = await client.comment(args.key, args.text, { signal });
        return { ...ok(`Added a comment to ${r.key}: ${r.url}`), summary: `Commented on ${r.key}` };
      });
    },
  });

  tools.push({
    name: 'jira_find_user',
    title: 'Find Jira user',
    description: 'Find Jira users by name or email. Returns one line per person: display name, email (when the person shares it) and accountId (Jira Cloud) or username (Server). Use the accountId with jira_assign or in a comment mention ([~accountid:…]).',
    inputSchema: objectSchema({ query: { type: 'string', minLength: 1, maxLength: 200, description: 'A name, part of a name, or an email address.' } }, ['query']),
    annotations: annotations('Find Jira user', { readOnly: true, idempotent: true }),
    handler: async (args = {}, extra = {}) =>
      withJira(extra, async (client, signal) => {
        const users = await client.findUser(args.query, { signal });
        if (!users.length) return ok(`No active Jira user matches "${args.query}".`);
        return ok(users.map((u) => `- ${jira.describeUser(u)}`).join('\n'));
      }),
  });

  return tools;
}

/** Tool names this module contributes, in order. */
const JIRA_TOOL_NAMES = ['jira_status', 'jira_get_issue', 'jira_search', 'jira_my_issues', 'jira_transition', 'jira_assign', 'jira_comment', 'jira_find_user'];

module.exports = { createTools, JIRA_TOOL_NAMES };
