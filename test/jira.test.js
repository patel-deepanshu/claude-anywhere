'use strict';

/**
 * Jira integration: the REST client against fake Jira Cloud and Server/Data Center servers, the
 * ADF / wiki / Markdown converters, the MCP tools, the daemon routes and the `anywhere jira` CLI.
 * No network: every server here listens on 127.0.0.1.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-test-jira-'));
process.env.ANYWHERE_HOME = HOME;
delete process.env.ANYWHERE_LOG_FILE;

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'anywhere.js');
const jira = require('../src/integrations/jira');
const configMod = require('../src/shared/config');
const toolsJira = require('../src/mcp/tools-jira');
const routesJira = require('../src/daemon/routes-jira');
const cliJira = require('../src/cli/jira');

const TOKEN = 'tok-SECRET-0123456789abcdef';
const EMAIL = 'dev@acme.test';
const NOT_CONNECTED =
  "Jira isn't connected: run `anywhere jira setup`, or add it in Settings → Jira, or read the ticket from the browser with read_browser_tab.";

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test.beforeEach(() => {
  jira.clearDetectionCache();
});

// ---------------------------------------------------------------- fixtures

function b64(s) {
  return Buffer.from(s).toString('base64');
}

function adfDoc(...content) {
  return { version: 1, type: 'doc', content };
}

function p(...content) {
  return { type: 'paragraph', content };
}

function t(text, marks) {
  return marks ? { type: 'text', text, marks } : { type: 'text', text };
}

const DESCRIPTION_ADF = adfDoc(
  { type: 'heading', attrs: { level: 2 }, content: [t('Problem')] },
  p(t('Login times out after '), t('30 s', [{ type: 'strong' }]), t(' on slow networks; see '), t('the runbook', [{ type: 'link', attrs: { href: 'https://wiki.acme.test/runbook' } }]), t(' and '), t('auth.js', [{ type: 'code' }]), t('.')),
  p({ type: 'mention', attrs: { id: '5b10a2844c20165700ede21i', text: '@Priya Shah' } }, t(' please check'), { type: 'hardBreak' }, t('thanks '), { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }),
  {
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [p(t('first'))] },
      { type: 'listItem', content: [p(t('second')), { type: 'orderedList', content: [{ type: 'listItem', content: [p(t('nested one'))] }, { type: 'listItem', content: [p(t('nested two'))] }] }] },
    ],
  },
  { type: 'codeBlock', attrs: { language: 'js' }, content: [t('const timeout = 30000;\nlogin({ timeout });')] },
  {
    type: 'table',
    content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('Network'))] }, { type: 'tableHeader', content: [p(t('Result'))] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('3G'))] }, { type: 'tableCell', content: [p(t('fails | times out'))] }] },
    ],
  },
  { type: 'panel', attrs: { panelType: 'warning' }, content: [p(t('Do not raise the timeout above 60 s.'))] },
  { type: 'taskList', attrs: { localId: 'a' }, content: [{ type: 'taskItem', attrs: { localId: 'b', state: 'DONE' }, content: [t('reproduce')] }, { type: 'taskItem', attrs: { localId: 'c', state: 'TODO' }, content: [t('fix')] }] },
  { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'abc', type: 'file', collection: 'x', alt: 'screenshot.png' } }] },
  p(t('Status '), { type: 'status', attrs: { text: 'blocked', color: 'red' } }, t(' since '), { type: 'date', attrs: { timestamp: String(Date.UTC(2026, 9, 1)) } }, t(' '), { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/ABC-200' } }),
  { type: 'rule' },
  { type: 'blockquote', content: [p(t('Customer quote'))] },
);

function cloudComments(n) {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push({ id: String(i), author: { accountId: `acc${i}`, displayName: `User ${i}` }, body: adfDoc(p(t(`Comment ${i}`))), created: `2026-10-${String(i).padStart(2, '0')}T09:00:00.000+0000`, updated: `2026-10-${String(i).padStart(2, '0')}T09:00:00.000+0000` });
  }
  return out;
}

function cloudIssue() {
  const comments = cloudComments(12);
  return {
    id: '10001',
    key: 'ABC-123',
    names: { summary: 'Summary', customfield_10020: 'Sprint', customfield_10016: 'Story point estimate', customfield_10050: 'Acceptance Criteria', customfield_10060: 'Steps to Reproduce' },
    fields: {
      summary: 'Fix login timeout on slow networks',
      status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      assignee: { accountId: '5b10a2844c20165700ede21g', displayName: 'Ankit Verma', emailAddress: 'ankit@acme.test' },
      reporter: { accountId: '5b10a2844c20165700ede21i', displayName: 'Priya Shah' },
      labels: ['auth', 'backend'],
      components: [{ name: 'API' }],
      fixVersions: [{ name: '2.4' }],
      parent: { key: 'ABC-100', fields: { summary: 'Login revamp', issuetype: { name: 'Epic' }, status: { name: 'In Progress' } } },
      customfield_10020: [
        { id: 7, name: 'Sprint 41', state: 'closed' },
        { id: 8, name: 'Sprint 42', state: 'active' },
      ],
      customfield_10016: 3,
      customfield_10050: adfDoc({ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('Login succeeds on 3G within 60 s'))] }, { type: 'listItem', content: [p(t('A clear error after the timeout'))] }] }),
      customfield_10060: adfDoc(p(t('Throttle to 3G, then sign in.'))),
      description: DESCRIPTION_ADF,
      subtasks: [{ key: 'ABC-124', fields: { summary: 'Add tests', status: { name: 'To Do' } } }],
      issuelinks: [
        { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'ABC-200', fields: { summary: 'Release 2.4', status: { name: 'Open' } } } },
        { type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, inwardIssue: { key: 'ABC-90', fields: { summary: 'Old login bug', status: { name: 'Done' } } } },
      ],
      attachment: [{ filename: 'trace.har', content: 'https://acme.atlassian.net/rest/api/3/attachment/content/1', size: 20480, mimeType: 'application/json' }],
      comment: { total: 12, maxResults: 5, startAt: 0, comments: comments.slice(0, 5) },
      created: '2026-10-01T10:15:30.000+0000',
      updated: '2026-10-17T08:00:00.000+0000',
    },
    _comments: comments,
  };
}

function serverIssue() {
  return {
    id: '20007',
    key: 'OPS-7',
    names: { customfield_10100: 'Sprint', customfield_10200: 'Story Points', customfield_10300: 'Epic Link', customfield_10400: 'Acceptance Criteria' },
    fields: {
      summary: 'Rotate TLS certificates',
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
      issuetype: { name: 'Task' },
      priority: { name: 'Medium' },
      assignee: { name: 'jdoe', key: 'JIRAUSER1', displayName: 'John Doe', emailAddress: 'jdoe@acme.test' },
      description: 'h2. Steps\n# renew\n# deploy\n{code:bash}\necho hi | tee out\n{code}\n*Important* and [the docs|https://wiki.acme.test/x], ask [~jdoe]',
      customfield_10100: ['com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=3,rapidViewId=1,state=ACTIVE,name=Ops Sprint 9,startDate=2026-10-01T00:00:00.000Z,endDate=<null>]'],
      customfield_10200: 5,
      customfield_10300: 'OPS-1',
      customfield_10400: '* certs rotate\n* no downtime',
      comment: { total: 1, maxResults: 1, startAt: 0, comments: [{ id: '1', author: { name: 'jdoe', displayName: 'John Doe' }, body: 'Looks good, see {{cert.pem}}', created: '2026-10-02T09:00:00.000+0000' }] },
      created: '2026-10-01T10:15:30.000+0000',
      updated: '2026-10-02T10:15:30.000+0000',
    },
  };
}

const TRANSITIONS = [
  { id: '11', name: 'Start Progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } } },
  { id: '21', name: 'Ready for Review', to: { name: 'In Review', statusCategory: { key: 'indeterminate', name: 'In Progress' } } },
  { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done', name: 'Done' } } },
];

const CLOUD_USERS = [
  { accountId: '5b10a2844c20165700ede21g', displayName: 'Ankit Verma', emailAddress: 'ankit@acme.test', active: true, accountType: 'atlassian' },
  { accountId: '5b10a2844c20165700ede21h', displayName: 'Ankit Sharma', emailAddress: 'ankit.s@acme.test', active: true, accountType: 'atlassian' },
  { accountId: '5b10a2844c20165700ede21i', displayName: 'Priya Shah', active: true, accountType: 'atlassian' },
  { accountId: 'app-1', displayName: 'Ankit Automation', active: true, accountType: 'app' },
];

const SERVER_USERS = [
  { name: 'jdoe', key: 'JIRAUSER1', displayName: 'John Doe', emailAddress: 'jdoe@acme.test', active: true },
  { name: 'asmith', key: 'JIRAUSER2', displayName: 'Ann Smith', emailAddress: 'asmith@acme.test', active: true },
];

function searchRows(keys) {
  return keys.map((k, i) => ({ key: k, fields: { summary: `Issue ${k}`, status: { name: i ? 'In Progress' : 'To Do' }, issuetype: { name: 'Story' }, priority: { name: 'Low' }, assignee: i ? { displayName: 'Ankit Verma' } : null, updated: '2026-10-10T00:00:00.000+0000' } }));
}

/**
 * The fake Jira's request handler (shared by HTTP and HTTPS servers).
 * @param {object} o options; see fakeJira()
 */
function jiraHandler(o, requests) {
  return (req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake.local');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, raw };
      requests.push(rec);
      const send = (status, obj, headers = {}) => {
        const isText = typeof obj === 'string';
        const text = obj === undefined ? '' : isText ? obj : JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': isText ? 'text/html; charset=utf-8' : 'application/json;charset=UTF-8', ...headers });
        res.end(text);
      };
      if (o.handle && o.handle(rec, send, res) === true) return;
      const cloud = o.deployment === 'Cloud';
      const auth = String(req.headers.authorization || '');
      const authOk =
        (auth === `Bearer ${o.token}` && o.bearer && !cloud) ||
        (auth === `Basic ${b64(`${o.email}:${o.token}`)}` && o.basic);
      const deny = () => send(401, { errorMessages: ['You are not authenticated. Authentication required to perform this operation.'], errors: {} }, { 'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED' });
      const m = /^\/rest\/api\/(2|3)\/(.*)$/.exec(url.pathname);
      if (!m) return send(404, '<html><body>Not found</body></html>');
      const [, v, rest] = m;
      if (rest === 'serverInfo') {
        if (!o.anonymousServerInfo && !authOk) return deny();
        return send(200, { baseUrl: 'x', version: cloud ? '1001.0.0' : '9.12.0', deploymentType: cloud ? 'Cloud' : 'Server', serverTitle: 'Acme Jira' });
      }
      if (!authOk) return deny();
      if (rest === 'myself') return send(200, o.me);
      let mm = /^issue\/([^/]+)$/.exec(rest);
      if (mm && req.method === 'GET') {
        const issue = o.issues[decodeURIComponent(mm[1])];
        if (!issue) return send(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} });
        if (rec.query.fields === 'status') return send(200, { key: issue.key, fields: { status: issue.fields.status } });
        const { _comments, ...copy } = issue;
        return send(200, copy);
      }
      mm = /^issue\/([^/]+)\/comment$/.exec(rest);
      if (mm && req.method === 'GET') {
        const all = (o.issues[mm[1]] && o.issues[mm[1]]._comments) || [];
        const startAt = Number(rec.query.startAt) || 0;
        const max = Number(rec.query.maxResults) || 50;
        return send(200, { startAt, maxResults: max, total: all.length, comments: all.slice(startAt, startAt + max) });
      }
      if (mm && req.method === 'POST') return send(201, { id: '10100', body: body && body.body });
      mm = /^issue\/([^/]+)\/transitions$/.exec(rest);
      if (mm && req.method === 'GET') return send(200, { expand: 'transitions', transitions: o.transitions });
      if (mm && req.method === 'POST') {
        if (o.transitionError) return send(400, { errorMessages: [], errors: { resolution: 'Resolution is required.' } });
        const tr = o.transitions.find((x) => x.id === (body && body.transition && body.transition.id));
        if (tr && o.issues[mm[1]]) o.issues[mm[1]].fields.status = { name: tr.to.name, statusCategory: tr.to.statusCategory };
        return send(204);
      }
      mm = /^issue\/([^/]+)\/assignee$/.exec(rest);
      if (mm && req.method === 'PUT') return send(204);
      if (rest === 'user/assignable/search' || rest === 'user/search') {
        const q = String(rec.query.query || rec.query.username || '').toLowerCase();
        return send(200, o.users.filter((u) => [u.displayName, u.emailAddress, u.name].some((x) => x && x.toLowerCase().includes(q))));
      }
      if (rest === 'user') {
        const u = o.users.find((x) => x.accountId === rec.query.accountId);
        return u ? send(200, u) : send(404, { errorMessages: ['Specified user does not exist or you do not have required permissions'] });
      }
      if (rest === 'search/jql' && v === '3') {
        if (!o.newSearch) return send(404, { errorMessages: ['Not found'] });
        if (/^\s*order by/i.test(rec.query.jql || '')) return send(400, { errorMessages: ['Unbounded JQL queries are not allowed here. Please add a search restriction to your query.'] });
        return send(200, { issues: o.searchIssues, isLast: true });
      }
      if (rest === 'search' && v === '2') return send(200, { startAt: 0, maxResults: Number(rec.query.maxResults), total: o.searchIssues.length, issues: o.searchIssues });
      return send(404, { errorMessages: [`no route ${rest}`] });
    });
  };
}

async function fakeJira(opts = {}) {
  const cloud = (opts.deployment || 'Cloud') === 'Cloud';
  const o = {
    deployment: 'Cloud',
    anonymousServerInfo: true,
    email: EMAIL,
    token: TOKEN,
    bearer: true,
    basic: true,
    newSearch: true,
    issues: cloud ? { 'ABC-123': cloudIssue() } : { 'OPS-7': serverIssue() },
    transitions: TRANSITIONS,
    users: cloud ? CLOUD_USERS : SERVER_USERS,
    me: cloud ? { accountId: '5b10a2844c20165700ede21z', displayName: 'Dev Person', emailAddress: EMAIL, active: true, timeZone: 'UTC' } : { name: 'dev', key: 'JIRAUSER9', displayName: 'Dev Person', emailAddress: EMAIL, active: true },
    searchIssues: searchRows(['ABC-1', 'ABC-2']),
    ...opts,
  };
  const requests = [];
  const server = http.createServer(jiraHandler(o, requests));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    o,
    requests,
    close: () =>
      new Promise((r) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function client(fj, extra = {}) {
  return new jira.JiraClient({ baseUrl: fj.url, email: EMAIL, apiToken: TOKEN, env: {}, ...extra });
}

// ---------------------------------------------------------------- settings and helpers

test('normalizeBaseUrl: site roots, Server context paths, and bad input', () => {
  assert.equal(jira.normalizeBaseUrl('acme.atlassian.net'), 'https://acme.atlassian.net');
  assert.equal(jira.normalizeBaseUrl('http://Acme.Atlassian.net/browse/ABC-1'), 'https://acme.atlassian.net');
  assert.equal(jira.normalizeBaseUrl('https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-2'), 'https://acme.atlassian.net');
  assert.equal(jira.normalizeBaseUrl('https://jira.acme.test/jira/browse/OPS-7'), 'https://jira.acme.test/jira');
  assert.equal(jira.normalizeBaseUrl('http://jira.acme.test:8080/secure/Dashboard.jspa'), 'http://jira.acme.test:8080');
  assert.equal(jira.normalizeBaseUrl('https://jira.acme.test/'), 'https://jira.acme.test');
  assert.throws(() => jira.normalizeBaseUrl(''), /empty/);
  assert.throws(() => jira.normalizeBaseUrl('ftp://x.test'), /https/);
  assert.throws(() => jira.normalizeBaseUrl('https://me:pw@acme.atlassian.net'), /own fields/);
  assert.equal(jira.isCloudHost('acme.atlassian.net'), true);
  assert.equal(jira.isCloudHost('jira.acme.test'), false);
  assert.equal(jira.isCloudHost('evilatlassian.net'), false);
});

test('parseIssueKey and branchName', () => {
  assert.equal(jira.parseIssueKey('abc-123'), 'ABC-123');
  assert.equal(jira.parseIssueKey('https://acme.atlassian.net/browse/ABC-9?x=1'), 'ABC-9');
  assert.equal(jira.parseIssueKey('https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-77'), 'ABC-77');
  assert.equal(jira.parseIssueKey('[ABC-5] Fix it - Jira'), 'ABC-5');
  assert.equal(jira.parseIssueKey('nothing here'), null);
  assert.equal(jira.branchName('ABC-123', 'Fix login timeout'), 'ABC-123-fix-login-timeout');
  assert.equal(jira.branchName('abc-1', 'Café: crème brûlée — “quotes” & stuff!'), 'ABC-1-cafe-creme-brulee-quotes-stuff');
  const long = jira.branchName('PROJ-12345', 'A very long summary that keeps going and going well past sixty characters in total');
  assert.ok(long.length <= 60, long);
  assert.ok(long.startsWith('PROJ-12345-a-very-long-summary'));
  assert.ok(!long.endsWith('-'));
  assert.equal(jira.branchName('ABC-2', ''), 'ABC-2');
});

test('JQL helpers', () => {
  assert.match(jira.myIssuesJql(), /assignee = currentUser\(\) AND statusCategory != Done ORDER BY updated DESC/);
  assert.match(jira.myIssuesJql('done'), /statusCategory = Done/);
  assert.match(jira.myIssuesJql('In Progress'), /statusCategory = "In Progress"/);
  assert.equal(jira.myIssuesJql('all'), 'assignee = currentUser() ORDER BY updated DESC');
  assert.match(jira.myIssuesJql('In "Review"'), /status = "In \\"Review\\""/);
  assert.deepEqual(jira.splitOrderBy('project = ABC order by created DESC'), { where: 'project = ABC', order: 'ORDER BY created DESC' });
});

test('resolveSettings: config first, then JIRA_* / ATLASSIAN_* environment, field by field', () => {
  const env = { JIRA_URL: 'https://env.atlassian.net', ATLASSIAN_EMAIL: 'env@acme.test', JIRA_TOKEN: 'envtok' };
  const a = jira.resolveSettings({ jira: { baseUrl: '', email: '', apiToken: '' } }, env);
  assert.equal(a.configured, true);
  assert.equal(a.baseUrl, 'https://env.atlassian.net');
  assert.deepEqual(a.source, { baseUrl: 'env:JIRA_URL', email: 'env:ATLASSIAN_EMAIL', apiToken: 'env:JIRA_TOKEN' });
  const b = jira.resolveSettings({ jira: { baseUrl: 'acme.atlassian.net', email: 'me@acme.test', apiToken: 'cfgtok' } }, env);
  assert.equal(b.apiToken, 'cfgtok');
  assert.equal(b.source.apiToken, 'config');
  const c = jira.resolveSettings({ jira: { baseUrl: 'https://acme.atlassian.net', apiToken: 'x' } }, {});
  assert.equal(c.configured, false);
  assert.deepEqual(c.missing, ['email']);
  const d = jira.resolveSettings({ jira: { baseUrl: 'https://jira.acme.test', apiToken: 'pat' } }, {});
  assert.equal(d.configured, true, 'Server/Data Center works with a personal access token alone');
  const e = jira.resolveSettings({}, { JIRA_BASE_URL: 'ftp://bad', JIRA_API_TOKEN: 'x' });
  assert.equal(e.configured, false);
  assert.ok(e.urlError);
  const pub = jira.publicSettings(b);
  assert.equal(pub.tokenSet, true);
  assert.ok(!JSON.stringify(pub).includes('cfgtok'));
});

test('currentSettings re-reads config.json (written by `anywhere jira setup`) over an older in-memory copy', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'cs-'));
  const prev = process.env.ANYWHERE_HOME;
  process.env.ANYWHERE_HOME = dir;
  try {
    const live = { jira: { baseUrl: 'https://old.atlassian.net', email: 'old@acme.test', apiToken: 'old' } };
    assert.equal(jira.currentSettings(live, { env: {} }).baseUrl, 'https://old.atlassian.net', 'no config file: the live copy');
    configMod.save({ jira: { baseUrl: 'https://new.atlassian.net', email: 'new@acme.test', apiToken: 'new' } });
    const s = jira.currentSettings(live, { env: {} });
    assert.equal(s.baseUrl, 'https://new.atlassian.net');
    assert.equal(s.apiToken, 'new');
  } finally {
    process.env.ANYWHERE_HOME = prev;
  }
});

test('proxyFor honours HTTPS_PROXY, NO_PROXY and never proxies loopback', () => {
  const env = { HTTPS_PROXY: 'http://proxy.corp:3128', NO_PROXY: 'localhost,.internal.test,jira.other.test:8443' };
  assert.equal(jira.proxyFor(new URL('https://acme.atlassian.net'), env).host, 'proxy.corp:3128');
  assert.equal(jira.proxyFor(new URL('https://jira.internal.test'), env), null);
  assert.equal(jira.proxyFor(new URL('https://x.jira.internal.test'), env), null);
  assert.equal(jira.proxyFor(new URL('https://jira.other.test:8443'), env), null);
  assert.ok(jira.proxyFor(new URL('https://jira.other.test'), env));
  assert.equal(jira.proxyFor(new URL('http://127.0.0.1:9'), { HTTP_PROXY: 'http://p:1' }), null);
  assert.equal(jira.proxyFor(new URL('https://a.test'), { HTTPS_PROXY: 'http://p:1', NO_PROXY: '*' }), null);
  assert.equal(jira.proxyFor(new URL('https://a.test'), { ALL_PROXY: 'socks5://p:1' }), null, 'unsupported proxy schemes go direct');
});

// ---------------------------------------------------------------- converters

test('adfToMarkdown converts headings, marks, links, mentions, lists, code, tables, panels, tasks and media', () => {
  const md = jira.adfToMarkdown(DESCRIPTION_ADF);
  assert.match(md, /^## Problem$/m);
  assert.match(md, /Login times out after \*\*30 s\*\* on slow networks; see \[the runbook\]\(https:\/\/wiki\.acme\.test\/runbook\) and `auth\.js`\./);
  assert.match(md, /@Priya Shah please check\nthanks 😄/);
  assert.match(md, /^- first\n- second\n {2}1\. nested one\n {2}2\. nested two$/m);
  assert.match(md, /```js\nconst timeout = 30000;\nlogin\(\{ timeout \}\);\n```/);
  assert.match(md, /^\| Network \| Result \|\n\| --- \| --- \|\n\| 3G \| fails \\\| times out \|$/m);
  assert.match(md, /^> \*\*Warning:\*\* Do not raise the timeout above 60 s\.$/m);
  assert.match(md, /^- \[x\] reproduce\n- \[ \] fix$/m);
  assert.match(md, /\[attachment: screenshot\.png\]/);
  assert.match(md, /Status \[BLOCKED\] since 2026-10-01 https:\/\/acme\.atlassian\.net\/browse\/ABC-200/);
  assert.match(md, /^---$/m);
  assert.match(md, /^> Customer quote$/m);
  assert.equal(jira.adfToMarkdown(null), '');
  assert.equal(jira.adfToMarkdown('plain'), 'plain');
  assert.equal(jira.adfToMarkdown({ type: 'doc', content: [{ type: 'unknownThing', content: [t('kept')] }] }), 'kept');
});

test('markdownToAdf builds valid ADF for comments', () => {
  const md = [
    '## Done',
    '',
    'Fixed the **timeout** in `auth.js` (see [PR](https://git.test/pr/1) and https://ci.test/run/5).',
    'Second line',
    '',
    '- one',
    '- two',
    '  - nested *em*',
    '1. first',
    '2. second',
    '',
    '```js',
    'a = 1;',
    '```',
    '',
    '> quoted',
    '',
    '| A | B |',
    '|---|:-:|',
    '| 1 | x \\| y |',
    '',
    '---',
    'cc [~accountid:5b10a2844c20165700ede21i] and [~bob], snake_case stays',
  ].join('\n');
  const doc = jira.markdownToAdf(md, { cloud: true });
  assert.equal(doc.type, 'doc');
  assert.equal(doc.version, 1);
  const types = doc.content.map((n) => n.type);
  assert.deepEqual(types, ['heading', 'paragraph', 'bulletList', 'orderedList', 'codeBlock', 'blockquote', 'table', 'rule', 'paragraph']);
  const para = doc.content[1].content;
  assert.deepEqual(para.find((n) => n.text === 'timeout').marks, [{ type: 'strong' }]);
  assert.deepEqual(para.find((n) => n.text === 'auth.js').marks, [{ type: 'code' }]);
  assert.deepEqual(para.find((n) => n.text === 'PR').marks, [{ type: 'link', attrs: { href: 'https://git.test/pr/1' } }]);
  assert.deepEqual(para.find((n) => n.text === 'https://ci.test/run/5').marks, [{ type: 'link', attrs: { href: 'https://ci.test/run/5' } }]);
  assert.ok(para.some((n) => n.type === 'hardBreak'), 'line breaks are kept');
  const nested = doc.content[2].content[1].content[1];
  assert.equal(nested.type, 'bulletList');
  assert.deepEqual(nested.content[0].content[0].content.find((n) => n.text === 'em').marks, [{ type: 'em' }]);
  assert.deepEqual(doc.content[4], { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'a = 1;' }] });
  const table = doc.content[6];
  assert.equal(table.content[0].content[0].type, 'tableHeader');
  assert.equal(table.content[1].content[1].type, 'tableCell');
  assert.equal(table.content[1].content[1].content[0].content[0].text, 'x | y');
  const last = doc.content[8].content;
  assert.deepEqual(last.find((n) => n.type === 'mention'), { type: 'mention', attrs: { id: '5b10a2844c20165700ede21i' } });
  assert.ok(last.some((n) => n.type === 'text' && n.text.includes('@bob')), 'a bare [~name] is plain text on Cloud');
  assert.ok(last.some((n) => n.type === 'text' && n.text.includes('snake_case stays')));
  // Every text node is non-empty and code marks never mix with others.
  const walk = (n) => {
    if (n.type === 'text') {
      assert.ok(n.text.length > 0);
      if (n.marks && n.marks.some((x) => x.type === 'code')) assert.ok(n.marks.every((x) => x.type === 'code' || x.type === 'link'));
    }
    (n.content || []).forEach(walk);
  };
  walk(doc);
  assert.deepEqual(jira.markdownToAdf('').content, [{ type: 'paragraph' }]);
  // Round trip keeps the meaning.
  const back = jira.adfToMarkdown(doc);
  assert.match(back, /Fixed the \*\*timeout\*\* in `auth\.js` \(see \[PR\]\(https:\/\/git\.test\/pr\/1\)/);
});

test('wiki markup ↔ Markdown for Jira Server / Data Center', () => {
  const md = jira.wikiToMarkdown(serverIssue().fields.description);
  assert.match(md, /^## Steps$/m);
  assert.match(md, /^1\. renew\n1\. deploy$/m);
  assert.match(md, /```bash\necho hi \| tee out\n```/);
  assert.match(md, /\*\*Important\*\* and \[the docs\]\(https:\/\/wiki\.acme\.test\/x\), ask @jdoe/);
  assert.equal(jira.wikiToMarkdown('||Name||Link||\n|x \\| y|[docs|https://a.test/c]|'), '| Name | Link |\n| --- | --- |\n| x \\| y | [docs](https://a.test/c) |');
  assert.equal(jira.wikiToMarkdown('{quote}\nsaid so\n{quote}'), '> said so');
  assert.equal(jira.wikiToMarkdown('{noformat}\n*raw*\n{noformat}'), '```\n*raw*\n```');
  const wiki = jira.markdownToWiki('## Title\n\n**bold** and *em* and `code` and [link](https://x.test)\n\n- a\n  - b\n1. c\n\n```sh\nls\n```');
  assert.match(wiki, /^h2\. Title$/m);
  assert.match(wiki, /\*bold\* and _em_ and \{\{code\}\} and \[link\|https:\/\/x\.test\]/);
  assert.match(wiki, /^\* a\n\*\* b$/m);
  assert.match(wiki, /^# c$/m);
  assert.match(wiki, /\{code:sh\}\nls\n\{code\}/);
  assert.equal(jira.markdownToWiki('use {braces} and [x]'), 'use \\{braces\\} and \\[x\\]');
});

test('pickTransition and pickUser', () => {
  const list = TRANSITIONS.map((x) => ({ id: x.id, name: x.name, to: { name: x.to.name, categoryKey: x.to.statusCategory.key } }));
  const id = (q) => (jira.pickTransition(list, q).match || {}).id;
  assert.equal(id('in progress'), '11');
  assert.equal(id('START PROGRESS'), '11');
  assert.equal(id('in-review'), '21');
  assert.equal(id('review'), '21');
  assert.equal(id('done'), '31');
  assert.equal(id('finish'), '31');
  assert.equal(id('progress'), '11');
  assert.equal(jira.pickTransition(list, 'wip').ambiguous.length, 2);
  assert.deepEqual(jira.pickTransition(list, 'shipped'), {});
  const users = CLOUD_USERS.map((u) => ({ displayName: u.displayName, email: u.emailAddress || null, accountId: u.accountId, active: true }));
  assert.equal(jira.pickUser(users, 'ankit.s@acme.test').user.displayName, 'Ankit Sharma');
  assert.equal(jira.pickUser(users, 'ankit verma').user.displayName, 'Ankit Verma');
  assert.equal(jira.pickUser(users.slice(0, 2), 'Ankit').ambiguous.length, 2);
  assert.equal(jira.pickUser([users[2]], 'priya').user.displayName, 'Priya Shah');
  assert.deepEqual(jira.pickUser([], 'x'), {});
  assert.ok(jira.looksLikeAccountId('5b10a2844c20165700ede21g'));
  assert.ok(jira.looksLikeAccountId('557058:f58131cb-b67d-43c7-b30d-6b58d40bd077'));
  assert.ok(!jira.looksLikeAccountId('ankit'));
});

// ---------------------------------------------------------------- client: Jira Cloud

test('Cloud: detection, Basic auth, REST v3, and a full issue as Markdown', async () => {
  const fj = await fakeJira();
  try {
    const c = client(fj);
    const conn = await c.testConnection();
    assert.equal(conn.deployment, 'Cloud');
    assert.deepEqual(conn.user, { displayName: 'Dev Person', email: EMAIL, accountId: '5b10a2844c20165700ede21z' });
    const me = fj.requests.find((r) => r.path.endsWith('/myself'));
    assert.equal(me.path, '/rest/api/3/myself');
    assert.equal(me.headers.authorization, `Basic ${b64(`${EMAIL}:${TOKEN}`)}`);
    assert.equal(fj.requests.find((r) => r.path.endsWith('/serverInfo')).headers.authorization, undefined, 'serverInfo is asked anonymously first');

    const issue = await c.getIssue('abc-123');
    const req = fj.requests.find((r) => r.path === '/rest/api/3/issue/ABC-123');
    assert.equal(req.query.fields, '*all');
    assert.equal(req.query.expand, 'names');
    assert.equal(issue.key, 'ABC-123');
    assert.equal(issue.url, `${fj.url}/browse/ABC-123`);
    assert.equal(issue.status.name, 'To Do');
    assert.equal(issue.type, 'Bug');
    assert.equal(issue.assignee.displayName, 'Ankit Verma');
    assert.deepEqual(issue.sprint, { id: 8, name: 'Sprint 42', state: 'active' });
    assert.equal(issue.storyPoints, 3);
    assert.deepEqual(issue.parent, { key: 'ABC-100', summary: 'Login revamp', type: 'Epic', status: 'In Progress' });
    assert.equal(issue.acceptanceCriteria, '- Login succeeds on 3G within 60 s\n- A clear error after the timeout');
    assert.deepEqual(issue.extraFields, [{ name: 'Steps to Reproduce', markdown: 'Throttle to 3G, then sign in.' }]);
    assert.equal(issue.branchName, 'ABC-123-fix-login-timeout-on-slow-networks');
    assert.equal(issue.commentsTotal, 12);
    assert.equal(issue.comments.length, 10);
    assert.equal(issue.comments[0].body, 'Comment 3');
    assert.equal(issue.comments[9].body, 'Comment 12');
    const page = fj.requests.find((r) => r.path === '/rest/api/3/issue/ABC-123/comment');
    assert.deepEqual([page.query.startAt, page.query.maxResults], ['2', '10']);
    assert.deepEqual(issue.attachments, [{ filename: 'trace.har', url: 'https://acme.atlassian.net/rest/api/3/attachment/content/1', size: 20480, mimeType: 'application/json' }]);
    const md = issue.markdown;
    assert.match(md, /^# ABC-123: Fix login timeout on slow networks$/m);
    assert.match(md, /\*\*Type:\*\* Bug · \*\*Status:\*\* To Do · \*\*Priority:\*\* High/);
    assert.match(md, /\*\*Sprint:\*\* Sprint 42 \(active\) · \*\*Story points:\*\* 3/);
    assert.match(md, /\*\*Parent:\*\* ABC-100 \(Epic\): Login revamp/);
    assert.match(md, /\*\*Suggested branch:\*\* `ABC-123-fix-login-timeout-on-slow-networks`/);
    assert.match(md, /## Description\n\n#### Problem/, 'headings inside the description nest under its section');
    assert.match(md, /## Acceptance criteria\n\n- Login succeeds on 3G within 60 s/);
    assert.match(md, /## Subtasks\n\n- ABC-124 \[To Do\]: Add tests/);
    assert.match(md, /- blocks ABC-200 \[Open\]: Release 2\.4\n- relates to ABC-90 \[Done\]: Old login bug/);
    assert.match(md, /- trace\.har \(application\/json, 20 KB\): https:/);
    assert.match(md, /## Comments \(last 10 of 12\)/);
    assert.match(md, /\*\*User 12\*\* · 2026-10-12 09:00 UTC\n\n> Comment 12/);
    assert.ok(!md.includes(TOKEN));
  } finally {
    await fj.close();
  }
});

test('Cloud: transitions by status or name, with the valid options listed on a miss', async () => {
  const fj = await fakeJira();
  try {
    const c = client(fj);
    const r = await c.transition('ABC-123', 'in progress');
    assert.deepEqual(r, { key: 'ABC-123', from: 'To Do', to: 'In Progress', transition: 'Start Progress' });
    const post = fj.requests.find((x) => x.method === 'POST' && x.path === '/rest/api/3/issue/ABC-123/transitions');
    assert.deepEqual(post.body, { transition: { id: '11' } });
    const again = await c.transition('ABC-123', 'In Progress');
    assert.equal(again.transition, 'Start Progress', 'a listed transition is still taken');
    await assert.rejects(c.transition('ABC-123', 'Shipped'), (err) => {
      assert.equal(err.code, 'NO_TRANSITION');
      assert.match(err.message, /cannot move to "Shipped" from "In Progress"/);
      assert.match(err.message, /"Start Progress" → In Progress, "Ready for Review" → In Review, "Done"/);
      assert.equal(err.options.length, 3);
      return true;
    });
    fj.o.transitions = [TRANSITIONS[2]];
    const already = await c.transition('ABC-123', 'in progress');
    assert.equal(already.already, true);
    fj.o.transitions = TRANSITIONS;
    await assert.rejects(c.transition('ABC-123', 'wip'), { code: 'AMBIGUOUS_TRANSITION' });
    fj.o.transitionError = true;
    await assert.rejects(c.transition('ABC-123', 'done'), (err) => err.status === 400 && /resolution: Resolution is required/.test(err.message));
  } finally {
    await fj.close();
  }
});

test('Cloud: assign by me, email, accountId, name; ambiguity lists the people', async () => {
  const fj = await fakeJira();
  try {
    const c = client(fj);
    const puts = () => fj.requests.filter((x) => x.method === 'PUT').map((x) => x.body);
    assert.equal((await c.assign('ABC-123', 'me')).assignee.accountId, '5b10a2844c20165700ede21z');
    assert.equal((await c.assign('ABC-123', 'ankit.s@acme.test')).assignee.displayName, 'Ankit Sharma');
    assert.equal((await c.assign('ABC-123', 'Priya')).assignee.accountId, '5b10a2844c20165700ede21i');
    const byId = await c.assign('ABC-123', '5b10a2844c20165700ede21g');
    assert.equal(byId.assignee.displayName, 'Ankit Verma');
    assert.equal((await c.assign('ABC-123', 'none')).assignee, null);
    assert.deepEqual(puts(), [
      { accountId: '5b10a2844c20165700ede21z' },
      { accountId: '5b10a2844c20165700ede21h' },
      { accountId: '5b10a2844c20165700ede21i' },
      { accountId: '5b10a2844c20165700ede21g' },
      { accountId: null },
    ]);
    const search = fj.requests.find((x) => x.path === '/rest/api/3/user/assignable/search');
    assert.equal(search.query.issueKey, 'ABC-123');
    await assert.rejects(c.assign('ABC-123', 'Ankit'), (err) => {
      assert.equal(err.code, 'AMBIGUOUS_USER');
      assert.deepEqual(err.candidates.map((u) => u.displayName), ['Ankit Verma', 'Ankit Sharma']);
      assert.match(err.message, /Ankit Verma <ankit@acme\.test> accountId 5b10a2844c20165700ede21g/);
      return true;
    });
    await assert.rejects(c.assign('ABC-123', 'Zed Nobody'), { code: 'NO_USER' });
    assert.equal(puts().length, 5, 'nothing assigned on ambiguity or a miss');
    const found = await c.findUser('ankit');
    assert.deepEqual(found.map((u) => u.displayName), ['Ankit Verma', 'Ankit Sharma'], 'apps are not people');
  } finally {
    await fj.close();
  }
});

test('Cloud: comments are sent as ADF; search uses /search/jql and falls back to /rest/api/2/search', async () => {
  const fj = await fakeJira();
  try {
    const c = client(fj);
    const r = await c.comment('ABC-123', 'PR is up: **#42**\n\n- tests added');
    assert.deepEqual(r, { key: 'ABC-123', id: '10100', url: `${fj.url}/browse/ABC-123?focusedCommentId=10100` });
    const post = fj.requests.find((x) => x.method === 'POST' && x.path === '/rest/api/3/issue/ABC-123/comment');
    assert.equal(post.body.body.type, 'doc');
    assert.equal(post.body.body.content[1].type, 'bulletList');
    await assert.rejects(c.comment('ABC-123', '   '), { code: 'BAD_INPUT' });

    const s = await c.search('project = ABC', 5);
    assert.equal(s.endpoint, '/rest/api/3/search/jql');
    assert.equal(s.issues.length, 2);
    assert.equal(s.total, null);
    const sreq = fj.requests.find((x) => x.path === '/rest/api/3/search/jql');
    assert.deepEqual([sreq.query.jql, sreq.query.maxResults], ['project = ABC', '5']);
    assert.match(sreq.query.fields, /summary/);
    assert.match(jira.searchResultText(s), /^2 issues match: project = ABC\n\n- ABC-1 \[To Do\] Issue ABC-1 \(Story · Low · Unassigned\)\n- ABC-2 \[In Progress\] Issue ABC-2 \(Story · Low · Ankit Verma\)$/);

    const unbounded = await c.search('ORDER BY created DESC');
    assert.equal(unbounded.jql, 'updated >= -365d ORDER BY created DESC');
    assert.match(unbounded.note, /last 365 days/);

    fj.o.newSearch = false;
    const old = await c.search('project = ABC');
    assert.equal(old.endpoint, '/rest/api/2/search');
    assert.equal(old.total, 2);
    const mine = await c.myIssues('todo');
    assert.match(mine.jql, /assignee = currentUser\(\) AND statusCategory = "To Do"/);
  } finally {
    await fj.close();
  }
});

// ---------------------------------------------------------------- client: Server / Data Center

test('Server/Data Center: Bearer PAT, REST v2, wiki converted, sprint strings, username assign, wiki comments', async () => {
  const fj = await fakeJira({ deployment: 'Server', anonymousServerInfo: false });
  try {
    const c = client(fj);
    const conn = await c.testConnection();
    assert.equal(conn.deployment, 'Server');
    assert.equal(conn.serverTitle, 'Acme Jira');
    assert.equal(conn.user.accountId, 'dev', 'the username stands in for the accountId');
    const me = fj.requests.find((r) => r.path === '/rest/api/2/myself');
    assert.equal(me.headers.authorization, `Bearer ${TOKEN}`);
    const basicTries = fj.requests.filter((r) => String(r.headers.authorization || '').startsWith('Basic'));
    assert.equal(basicTries.length, 0, 'a PAT is tried before any password login (no CAPTCHA lockouts)');

    const issue = await c.getIssue('OPS-7');
    assert.ok(fj.requests.some((r) => r.path === '/rest/api/2/issue/OPS-7'));
    assert.deepEqual(issue.sprint, { id: 3, name: 'Ops Sprint 9', state: 'active' });
    assert.equal(issue.storyPoints, 5);
    assert.deepEqual(issue.parent, { key: 'OPS-1', summary: '', type: 'Epic', status: null });
    assert.equal(issue.acceptanceCriteria, '- certs rotate\n- no downtime');
    assert.match(issue.description, /```bash\necho hi \| tee out\n```/);
    assert.equal(issue.comments[0].body, 'Looks good, see `cert.pem`');
    assert.equal(issue.deployment, 'Server');

    const a = await c.assign('OPS-7', 'Ann');
    assert.equal(a.assignee.name, 'asmith');
    const put = fj.requests.find((r) => r.method === 'PUT');
    assert.equal(put.path, '/rest/api/2/issue/OPS-7/assignee');
    assert.deepEqual(put.body, { name: 'asmith' });
    assert.equal(fj.requests.find((r) => r.path === '/rest/api/2/user/assignable/search').query.username, 'Ann');

    await c.comment('OPS-7', 'Rotated **all** certs:\n\n- `a.pem`');
    const post = fj.requests.find((r) => r.method === 'POST' && r.path === '/rest/api/2/issue/OPS-7/comment');
    assert.equal(post.body.body, 'Rotated *all* certs:\n\n* {{a.pem}}');

    const s = await c.search('project = OPS');
    assert.equal(s.endpoint, '/rest/api/2/search');
    assert.ok(!fj.requests.some((r) => r.path === '/rest/api/3/search/jql'), 'Server never tries the Cloud endpoint');
  } finally {
    await fj.close();
  }
});

test('Server without personal access tokens: falls back to username + password (Basic) once and remembers it', async () => {
  const fj = await fakeJira({ deployment: 'Server', anonymousServerInfo: true, bearer: false });
  try {
    const c = client(fj);
    const conn = await c.testConnection();
    assert.equal(conn.deployment, 'Server');
    const auths = fj.requests.filter((r) => r.path === '/rest/api/2/myself').map((r) => String(r.headers.authorization).split(' ')[0]);
    assert.deepEqual(auths, ['Bearer', 'Basic']);
    await c.getIssue('OPS-7');
    assert.equal(fj.requests.find((r) => r.path === '/rest/api/2/issue/OPS-7').headers.authorization.split(' ')[0], 'Basic');
  } finally {
    await fj.close();
  }
});

// ---------------------------------------------------------------- client: errors and transport

test('errors carry the status and Jira\'s messages, never the token', async () => {
  const fj = await fakeJira({
    handle: (rec, send) => {
      if (rec.path === '/rest/api/3/myself') {
        send(401, { errorMessages: [`Bad credentials: ${rec.headers.authorization} (${TOKEN})`] });
        return true;
      }
      return false;
    },
  });
  try {
    const c = client(fj);
    await assert.rejects(c.myself(), (err) => {
      assert.equal(err.name, 'JiraError');
      assert.equal(err.status, 401);
      assert.equal(err.code, 'UNAUTHORIZED');
      assert.match(err.message, /^Jira GET \/rest\/api\/3\/myself failed with HTTP 401: Bad credentials: Basic \*\*\* \(\*\*\*\)$/);
      assert.match(err.hint, /id\.atlassian\.com\/manage-profile\/security\/api-tokens/);
      const all = JSON.stringify({ m: err.message, h: err.hint, x: err.messages });
      assert.ok(!all.includes(TOKEN) && !all.includes(b64(`${EMAIL}:${TOKEN}`)));
      return true;
    });
    await assert.rejects(c.getIssue('ABC-404'), (err) => err.status === 404 && /does not exist/.test(err.hint) && /Issue does not exist/.test(err.message));
    await assert.rejects(c.getIssue('not a key'), { code: 'BAD_KEY' });
    assert.ok(!JSON.stringify(c).includes(TOKEN));
    assert.ok(!require('util').inspect(c).includes(TOKEN));
  } finally {
    await fj.close();
  }
});

test('HTML instead of JSON, timeouts, 429 retry, and redirects', async () => {
  let n429 = 0;
  const other = await fakeJira();
  const fj = await fakeJira({
    handle: (rec, send, res) => {
      if (rec.path === '/rest/api/3/issue/HTML-1') return send(200, '<!doctype html><html>Log in</html>') || true;
      if (rec.path === '/rest/api/3/issue/SLOW-1') return true; // never answers
      if (rec.path === '/rest/api/3/issue/RATE-1' && n429++ === 0) return send(429, { errorMessages: ['slow down'] }, { 'Retry-After': '0' }) || true;
      if (rec.path === '/rest/api/3/issue/AWAY-1') {
        res.writeHead(302, { Location: `${other.url}/rest/api/3/issue/ABC-123` });
        res.end();
        return true;
      }
      if (rec.path === '/rest/api/3/issue/MOVED-1') {
        res.writeHead(301, { Location: '/rest/api/3/issue/ABC-123' });
        res.end();
        return true;
      }
      return false;
    },
  });
  try {
    const c = client(fj, { timeoutMs: 400 });
    await assert.rejects(c.getIssue('HTML-1'), { code: 'NOT_JSON' });
    const t0 = Date.now();
    await assert.rejects(c.getIssue('SLOW-1'), (err) => err.code === 'ETIMEDOUT' && /did not answer within/.test(err.message));
    assert.ok(Date.now() - t0 < 3000);
    fj.o.issues['RATE-1'] = { ...cloudIssue(), key: 'RATE-1' };
    assert.equal((await c.getIssue('RATE-1')).key, 'RATE-1');
    assert.equal(n429, 2);
    await assert.rejects(c.getIssue('AWAY-1'), (err) => err.code === 'REDIRECT' && /different site/.test(err.message));
    assert.equal(other.requests.length, 0, 'credentials never reach another site');
    assert.equal((await c.getIssue('MOVED-1')).key, 'ABC-123', 'a same-site redirect is followed');
    const ac = new AbortController();
    const pending = c.getIssue('SLOW-1', { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(pending, { code: 'ABORTED' });
  } finally {
    await fj.close();
    await other.close();
  }
});

test('an HTTP proxy from the environment is used (with Proxy-Authorization), NO_PROXY bypasses it', async () => {
  const fj = await fakeJira();
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers['proxy-authorization'] });
    const u = new URL(req.url);
    const fwd = http.request({ host: '127.0.0.1', port: fj.port, path: u.pathname + u.search, method: req.method, headers: { ...req.headers, host: u.host } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    req.pipe(fwd);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const lookup = (host, opts, cb) => (opts && opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
  try {
    const env = { HTTP_PROXY: `http://user:pa%20ss@127.0.0.1:${proxy.address().port}` };
    const c = new jira.JiraClient({ baseUrl: `http://jira.example.test:${fj.port}`, email: EMAIL, apiToken: TOKEN, env, lookup });
    const r = await c.testConnection();
    assert.equal(r.user.displayName, 'Dev Person');
    assert.ok(seen.length >= 2);
    assert.equal(seen[0].url, `http://jira.example.test:${fj.port}/rest/api/2/serverInfo`);
    assert.equal(seen[0].auth, `Basic ${b64('user:pa ss')}`);
    jira.clearDetectionCache();
    seen.length = 0;
    const direct = new jira.JiraClient({ baseUrl: `http://jira.example.test:${fj.port}`, email: EMAIL, apiToken: TOKEN, env: { ...env, NO_PROXY: 'example.test' }, lookup });
    await direct.testConnection();
    assert.equal(seen.length, 0);
  } finally {
    if (typeof proxy.closeAllConnections === 'function') proxy.closeAllConnections();
    proxy.close();
    await fj.close();
  }
});

test('HTTPS through an HTTPS_PROXY CONNECT tunnel, with the site certificate verified', async (t) => {
  const dir = fs.mkdtempSync(path.join(HOME, 'tls-'));
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=jira.example.test', '-addext', 'subjectAltName=DNS:jira.example.test'], { encoding: 'utf8' });
  if (gen.error || gen.status !== 0) {
    t.skip('openssl is not available to make a test certificate');
    return;
  }
  const key = fs.readFileSync(path.join(dir, 'key.pem'));
  const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
  const requests = [];
  const o = { deployment: 'Cloud', anonymousServerInfo: true, email: EMAIL, token: TOKEN, bearer: true, basic: true, newSearch: true, issues: {}, transitions: [], users: [], me: { accountId: 'x1', displayName: 'TLS Person' }, searchIssues: [] };
  const site = https.createServer({ key, cert }, jiraHandler(o, requests));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const tunnels = [];
  const proxy = http.createServer((req, res) => res.writeHead(405).end());
  proxy.on('connect', (req, sock, head) => {
    tunnels.push(req.url);
    const upstream = net.connect(site.address().port, '127.0.0.1', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(sock);
      sock.pipe(upstream);
    });
    upstream.on('error', () => sock.destroy());
    sock.on('error', () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `https://jira.example.test:${site.address().port}`;
  const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` };
  try {
    const r = await new jira.JiraClient({ baseUrl: base, email: EMAIL, apiToken: TOKEN, env, ca: cert }).testConnection();
    assert.equal(r.user.displayName, 'TLS Person');
    assert.equal(tunnels[0], `jira.example.test:${site.address().port}`);
    assert.equal(requests.find((x) => x.path === '/rest/api/3/myself').headers.authorization, `Basic ${b64(`${EMAIL}:${TOKEN}`)}`);
    jira.clearDetectionCache();
    await assert.rejects(new jira.JiraClient({ baseUrl: base, email: EMAIL, apiToken: TOKEN, env }).testConnection(), (err) => /NODE_EXTRA_CA_CERTS/.test(err.hint));
  } finally {
    for (const s of [site, proxy]) {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close();
    }
  }
});

// ---------------------------------------------------------------- MCP tools

function toolContext({ config = {}, loadConfig, guard, activity = [] } = {}) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
  return {
    config,
    deps: { env: {}, loadConfig: loadConfig || (() => config) },
    checkGuard: guard || (async () => {}),
    postActivity: (x) => activity.push(x),
    ok,
    fail,
    objectSchema: (properties, required = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) }),
    annotations: (title, { readOnly = false, destructive = false, idempotent = false, openWorld = true } = {}) => ({ title, readOnlyHint: readOnly, destructiveHint: readOnly ? false : destructive, idempotentHint: idempotent, openWorldHint: openWorld }),
  };
}

test('MCP tools: not connected → the exact message, and jira_status explains how to connect', async () => {
  const tools = toolsJira.createTools(toolContext());
  assert.deepEqual(tools.map((x) => x.name), toolsJira.JIRA_TOOL_NAMES);
  const args = { jira_get_issue: { key: 'ABC-1' }, jira_search: { jql: 'x = 1' }, jira_my_issues: {}, jira_transition: { key: 'ABC-1', to: 'Done' }, jira_assign: { key: 'ABC-1', user: 'me' }, jira_comment: { key: 'ABC-1', text: 'hi' }, jira_find_user: { query: 'a' } };
  for (const tool of tools) {
    assert.ok(tool.description.length > 80, `${tool.name} has a real description`);
    assert.equal(tool.inputSchema.type, 'object');
    if (tool.name === 'jira_status') {
      const res = await tool.handler({});
      assert.ok(!res.isError);
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.configured, false);
      assert.match(body.how, /anywhere jira setup/);
      assert.match(body.how, /read_browser_tab/);
      continue;
    }
    const res = await tool.handler(args[tool.name]);
    assert.equal(res.isError, true, tool.name);
    assert.equal(res.content[0].text, NOT_CONNECTED, tool.name);
  }
  const reads = tools.filter((x) => x.annotations.readOnlyHint).map((x) => x.name);
  assert.deepEqual(reads, ['jira_status', 'jira_get_issue', 'jira_search', 'jira_my_issues', 'jira_find_user']);
});

test('MCP tools against a fake Cloud site: read, search, move, assign, comment, with the pause guard and activity', async () => {
  const fj = await fakeJira();
  const activity = [];
  let paused = false;
  const guard = async () => {
    if (paused) {
      const e = new Error('Actions are paused: the user paused Claude in the Anywhere dialog.');
      e.code = 'PAUSED';
      throw e;
    }
  };
  const config = { jira: { baseUrl: fj.url, email: EMAIL, apiToken: TOKEN } };
  const tools = toolsJira.createTools(toolContext({ config, guard, activity }));
  const call = (name, args) => tools.find((x) => x.name === name).handler(args, {});
  try {
    const st = JSON.parse((await call('jira_status', {})).content[0].text);
    assert.deepEqual({ configured: st.configured, connected: st.connected, deployment: st.deployment, user: st.user.displayName }, { configured: true, connected: true, deployment: 'Cloud', user: 'Dev Person' });
    assert.ok(!JSON.stringify(st).includes(TOKEN));

    const issue = await call('jira_get_issue', { key: `${fj.url}/browse/ABC-123` });
    assert.ok(!issue.isError);
    assert.match(issue.content[0].text, /^# ABC-123: Fix login timeout/);

    const search = await call('jira_search', { jql: 'project = ABC', max: 2 });
    assert.match(search.content[0].text, /^2 issues match: project = ABC/);
    const mine = await call('jira_my_issues', {});
    assert.match(mine.content[0].text, /statusCategory != Done/);

    const moved = await call('jira_transition', { key: 'ABC-123', to: 'In Progress' });
    assert.equal(moved.content[0].text, 'Moved ABC-123 from "To Do" to "In Progress" (transition "Start Progress").');
    assert.equal(moved.summary, undefined);
    assert.deepEqual(activity.pop(), { tool: 'jira_transition', summary: 'Moved ABC-123 to In Progress', ok: true });

    const amb = await call('jira_assign', { key: 'ABC-123', user: 'Ankit' });
    assert.equal(amb.isError, true);
    assert.match(amb.content[0].text, /matches 2 people/);
    assert.match(amb.content[0].text, /ask_user \(options: "Ankit Verma", "Ankit Sharma"\)/);
    assert.equal(activity.pop().ok, false);
    const assigned = await call('jira_assign', { key: 'ABC-123', user: 'ankit@acme.test' });
    assert.equal(assigned.content[0].text, 'Assigned ABC-123 to Ankit Verma <ankit@acme.test> accountId 5b10a2844c20165700ede21g.');

    const commented = await call('jira_comment', { key: 'ABC-123', text: 'Started work on branch `ABC-123-fix`' });
    assert.match(commented.content[0].text, /^Added a comment to ABC-123: http/);
    const people = await call('jira_find_user', { query: 'priya' });
    assert.equal(people.content[0].text, '- Priya Shah accountId 5b10a2844c20165700ede21i');

    const nope = await call('jira_transition', { key: 'ABC-123', to: 'Shipped' });
    assert.equal(nope.isError, true);
    assert.match(nope.content[0].text, /Valid now:/);

    paused = true;
    const before = fj.requests.length;
    await assert.rejects(call('jira_comment', { key: 'ABC-123', text: 'x' }), { code: 'PAUSED' });
    assert.equal(fj.requests.length, before, 'a paused dialog stops writes before they reach Jira');
    const read = await call('jira_get_issue', { key: 'ABC-123' });
    assert.ok(!read.isError, 'reads still work while paused');
  } finally {
    await fj.close();
  }
});

test('MCP tools: a rejected token says how to reconnect; jira_status reports connected:false', async () => {
  const fj = await fakeJira({ token: 'other-token' });
  const config = { jira: { baseUrl: fj.url, email: EMAIL, apiToken: TOKEN } };
  const tools = toolsJira.createTools(toolContext({ config }));
  try {
    const res = await tools.find((x) => x.name === 'jira_get_issue').handler({ key: 'ABC-123' }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /HTTP 401/);
    assert.match(res.content[0].text, /anywhere jira setup/);
    assert.ok(!res.content[0].text.includes(TOKEN));
    const st = JSON.parse((await tools.find((x) => x.name === 'jira_status').handler({}, {})).content[0].text);
    assert.equal(st.connected, false);
    assert.match(st.error, /401/);
  } finally {
    await fj.close();
  }
});

test('MCP tools are registered by tools.js', () => {
  const { createTools } = require('../src/mcp/tools');
  const names = createTools({ computer: null, getClient: async () => null, config: {}, role: 'engine' }).map((x) => x.name);
  for (const n of toolsJira.JIRA_TOOL_NAMES) assert.ok(names.includes(n), n);
});

// ---------------------------------------------------------------- daemon routes

class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this.destroyed = false;
    this.writableEnded = false;
    this.writableFinished = false;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }

  end(body) {
    this.body = body ? JSON.parse(body) : null;
    this.writableEnded = true;
    this.writableFinished = true;
  }
}

function routeTable(server) {
  const routes = new Map();
  routesJira.register((method, p, fn, opts = {}) => routes.set(`${method} ${p}`, { fn, opts }), server);
  return {
    routes,
    async call(method, p, body = {}) {
      const route = routes.get(`${method} ${p.split('?')[0]}`);
      const res = new FakeRes();
      const out = await route.fn({ url: new URL(`http://127.0.0.1${p}`), res, body, req: new EventEmitter() });
      return res.headersSent ? { status: res.status, json: res.body } : { status: 200, json: out };
    },
  };
}

test('routes: GET /api/jira/status and POST /api/jira/test (saved token never sent to another site)', async () => {
  const fj = await fakeJira();
  const other = await fakeJira();
  let saved = { jira: { baseUrl: '', email: '', apiToken: '' } };
  const server = { deps: { config: {}, env: {}, loadConfig: () => saved } };
  const { routes, call } = routeTable(server);
  try {
    assert.deepEqual([...routes.keys()], ['GET /api/jira/status', 'POST /api/jira/test']);
    assert.equal(routes.get('GET /api/jira/status').opts.noBody, true);
    let r = await call('GET', '/api/jira/status');
    assert.equal(r.json.configured, false);
    assert.equal(r.json.deployment, null);
    r = await call('POST', '/api/jira/test', {}).catch((e) => e);
    assert.equal(r.status, 400);

    saved = { jira: { baseUrl: fj.url, email: EMAIL, apiToken: TOKEN } };
    r = await call('GET', '/api/jira/status');
    assert.equal(r.json.configured, true);
    assert.equal(r.json.baseUrl, fj.url);
    assert.equal(r.json.email, EMAIL);
    assert.equal(r.json.tokenSet, true);
    assert.ok(!JSON.stringify(r.json).includes(TOKEN));
    r = await call('GET', '/api/jira/status?check=1');
    assert.equal(r.json.connected, true);
    assert.equal(r.json.deployment, 'Cloud');
    assert.equal(r.json.user.displayName, 'Dev Person');

    r = await call('POST', '/api/jira/test', { apiToken: '' });
    assert.deepEqual(r.json, { ok: true, user: { displayName: 'Dev Person', email: EMAIL, accountId: '5b10a2844c20165700ede21z' }, deployment: 'Cloud', baseUrl: fj.url, serverTitle: 'Acme Jira' });

    r = await call('POST', '/api/jira/test', { apiToken: 'wrong-token' });
    assert.equal(r.status, 422);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.jiraStatus, 401);
    assert.equal(r.json.code, 'UNAUTHORIZED');
    assert.ok(r.json.hint);

    const err = await call('POST', '/api/jira/test', { baseUrl: other.url }).catch((e) => e);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'JIRA_NO_TOKEN');
    assert.equal(other.requests.length, 0, 'the saved token is not sent to a different site');
    r = await call('POST', '/api/jira/test', { baseUrl: other.url, apiToken: TOKEN, email: EMAIL });
    assert.equal(r.json.ok, true);
    const bad = await call('POST', '/api/jira/test', { baseUrl: 'ftp://x' }).catch((e) => e);
    assert.equal(bad.status, 400);
  } finally {
    await fj.close();
    await other.close();
  }
});

test('routes are served by the daemon with its token check', async () => {
  const fj = await fakeJira();
  const dir = fs.mkdtempSync(path.join(HOME, 'srv-'));
  const prev = process.env.ANYWHERE_HOME;
  process.env.ANYWHERE_HOME = dir;
  const { createServer } = require('../src/daemon/server');
  const { Hub } = require('../src/daemon/hub');
  const hub = new Hub();
  const config = configMod.save({ jira: { baseUrl: fj.url, email: EMAIL, apiToken: TOKEN } });
  const server = createServer({ hub, session: null, config, token: 'daemon-token-1234567890', instanceId: 'i', version: '0', env: {} });
  const port = await server.listen(0);
  const api = async (method, p, body, token = 'daemon-token-1234567890') => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try {
    assert.equal((await api('GET', '/api/jira/status', undefined, '')).status, 401);
    const st = await api('GET', '/api/jira/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.configured, true);
    assert.ok(!JSON.stringify(st.json).includes(TOKEN));
    const ok = await api('POST', '/api/jira/test', {});
    assert.equal(ok.json.ok, true);
    const bad = await api('POST', '/api/jira/test', { apiToken: 'nope-nope' });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.jiraStatus, 401);
    // A newer config.json (e.g. from `anywhere jira setup`) wins over the daemon's copy.
    configMod.save({ jira: { email: 'someone@acme.test' } });
    assert.equal((await api('GET', '/api/jira/status')).json.email, 'someone@acme.test');
  } finally {
    hub.close();
    await server.close();
    process.env.ANYWHERE_HOME = prev;
    await fj.close();
  }
});

// ---------------------------------------------------------------- CLI

function childEnv(extra = {}) {
  const env = { ...process.env, ANYWHERE_HOME: fs.mkdtempSync(path.join(HOME, 'cli-')), NO_COLOR: '1' };
  // No Jira settings or proxies from the machine running the tests: nothing here may reach the network.
  for (const k of Object.keys(env)) if (/^(JIRA_|ATLASSIAN_)|^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  delete env.ANYWHERE_DAEMON_URL;
  delete env.ANYWHERE_TOKEN;
  delete env.FORCE_COLOR;
  return { ...env, ...extra };
}

function runCli(args, { env, input, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input == null ? '' : input);
  });
}

test('CLI: jira setup --token-stdin tests, saves 0600 and never prints the token; status, issue, test, remove', async () => {
  const fj = await fakeJira();
  const env = childEnv();
  const cfgFile = path.join(env.ANYWHERE_HOME, 'config.json');
  try {
    let r = await runCli(['jira', 'setup', '--url', fj.url, '--email', EMAIL, '--token-stdin'], { env, input: `${TOKEN}\n` });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Connected to Jira Cloud as Dev Person <dev@acme\.test>/);
    assert.match(r.stdout, /id\.atlassian\.com\/manage-profile\/security\/api-tokens/);
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.deepEqual(saved.jira, { baseUrl: fj.url, email: EMAIL, apiToken: TOKEN });
    if (process.platform !== 'win32') assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o600);

    r = await runCli(['jira', 'status', '--json'], { env });
    assert.equal(r.code, 0);
    const st = JSON.parse(r.stdout);
    assert.equal(st.configured, true);
    assert.equal(st.tokenSet, true);
    assert.ok(!r.stdout.includes(TOKEN));
    r = await runCli(['jira', 'status'], { env });
    assert.match(r.stdout, /Token\s+set \(hidden\)/);

    r = await runCli(['jira', 'issue', 'abc-123'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^# ABC-123: Fix login timeout on slow networks/);
    r = await runCli(['jira', 'test', '--json'], { env });
    assert.equal(JSON.parse(r.stdout).deployment, 'Cloud');
    r = await runCli(['jira', 'mine'], { env });
    assert.match(r.stdout, /issues match: assignee = currentUser\(\)/);
    r = await runCli(['jira', 'search', 'project = ABC', '--max', '3'], { env });
    assert.match(r.stdout, /- ABC-2 \[In Progress\]/);

    fj.o.token = 'rotated';
    r = await runCli(['jira', 'test'], { env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 401/);
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN));

    r = await runCli(['jira', 'remove'], { env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Removed the saved Jira connection/);
    assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).jira, { baseUrl: '', email: '', apiToken: '' });
  } finally {
    await fj.close();
  }
});

test('CLI: a failed connection test saves nothing; --no-test saves; bad usage is explained', async () => {
  const fj = await fakeJira({ deployment: 'Server', anonymousServerInfo: false });
  const env = childEnv();
  const cfgFile = path.join(env.ANYWHERE_HOME, 'config.json');
  try {
    let r = await runCli(['jira', 'setup', '--url', fj.url, '--token-stdin'], { env, input: 'wrong\n' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing was saved/);
    assert.ok(!fs.existsSync(cfgFile) || !JSON.parse(fs.readFileSync(cfgFile, 'utf8')).jira);
    r = await runCli(['jira', 'setup', '--url', fj.url, '--token-stdin', '--json'], { env, input: `${TOKEN}\n` });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.deployment, 'Server');
    assert.equal(out.user.displayName, 'Dev Person');
    r = await runCli(['jira', 'setup', '--url', 'https://acme.atlassian.net', '--email', EMAIL, '--token-stdin', '--no-test'], { env, input: 'x-token\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Saved without testing/);
    r = await runCli(['jira', 'setup', '--url', 'https://other.atlassian.net', '--token-stdin'], { env, input: 'x\n' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /needs the email address/);
    r = await runCli(['jira', 'setup', '--token', 'abc'], { env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /never taken as an argument/);
    r = await runCli(['jira', 'issue'], { env });
    assert.equal(r.code, 1);
  } finally {
    await fj.close();
  }
});

test('CLI: interactive setup asks for URL, email and a hidden token, and keeps a saved token on Enter', async () => {
  const fj = await fakeJira();
  const dir = fs.mkdtempSync(path.join(HOME, 'int-'));
  const prev = process.env.ANYWHERE_HOME;
  process.env.ANYWHERE_HOME = dir;
  const asked = [];
  const answers = [fj.url, EMAIL];
  const secrets = [TOKEN, ''];
  const prompter = {
    interactive: true,
    ask: async (q, { defaultValue = '' } = {}) => {
      asked.push(['ask', q, defaultValue]);
      return answers.length ? answers.shift() : defaultValue;
    },
    secret: async (q) => {
      asked.push(['secret', q]);
      return secrets.shift();
    },
  };
  const outLines = [];
  const errLines = [];
  const notRunning = Object.assign(new Error('not running'), { exitCode: 4 });
  const helpers = {
    spec: (e) => e,
    shared: (name) => require(`../src/shared/${name}`),
    call: async () => ({}),
    requireDaemon: async () => {
      throw notRunning;
    },
    writeOut: (s) => outLines.push(s),
    writeErr: (s) => errLines.push(s),
    printJson: (o) => outLines.push(JSON.stringify(o)),
    sym: () => ({ ok: 'OK', warn: '!', fail: 'X', dot: '-', arrow: '->', ell: '...' }),
    color: { green: (s) => s, yellow: (s) => s, red: (s) => s, dim: (s) => s, bold: (s) => s, cyan: (s) => s },
    EXIT: { OK: 0, ERROR: 1, NOT_RUNNING: 4 },
    prompter,
    env: {},
  };
  const cmd = cliJira.commands(helpers).jira;
  try {
    assert.equal(await cmd.run({ _: ['setup'], flags: {} }), 0);
    assert.deepEqual(asked.map((a) => a[0]), ['ask', 'ask', 'secret']);
    assert.match(asked[1][1], /email/i);
    assert.match(errLines.join('\n'), /api-tokens/);
    assert.match(outLines.join('\n'), /Connected to Jira Cloud as Dev Person/);
    assert.equal(configMod.load().jira.apiToken, TOKEN);
    // Run again: Enter on every prompt keeps the saved URL, email and token.
    asked.length = 0;
    assert.equal(await cmd.run({ _: ['setup'], flags: {} }), 0);
    assert.equal(asked[0][2], fj.url);
    assert.equal(asked[1][2], EMAIL);
    assert.match(asked[2][1], /Enter keeps the saved one/);
    assert.equal(configMod.load().jira.apiToken, TOKEN);
  } finally {
    process.env.ANYWHERE_HOME = prev;
    await fj.close();
  }
});

test('hidden token prompt: nothing is echoed, backspace edits, Ctrl+C cancels', async () => {
  const mk = () => {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (v) => {
      input.isRaw = v;
    };
    const output = new PassThrough();
    let written = '';
    output.on('data', (d) => (written += d));
    return { input, output, written: () => written };
  };
  const a = mk();
  const pr = cliJira.createPrompter({ input: a.input, output: a.output });
  assert.equal(pr.interactive, true);
  const pending = pr.secret('API token');
  a.input.write('secr\u007fret\r');
  assert.equal(await pending, 'secret');
  assert.equal(a.input.isRaw, false, 'raw mode is restored');
  assert.equal(a.written(), 'API token: \n');
  const b = mk();
  const cancelled = cliJira.createPrompter({ input: b.input, output: b.output }).secret('API token');
  b.input.write('abc\u0003');
  await assert.rejects(cancelled, (err) => err.exitCode === 130);
  const c = mk();
  const pasted = cliJira.createPrompter({ input: c.input, output: c.output }).secret('API token');
  c.input.write('\u001b[200~pasted-token\u001b[201~\r');
  assert.equal(await pasted, 'pasted-token');
});
