'use strict';

/**
 * Jira REST client for ticket work: Jira Cloud (free API token, REST v3, Atlassian Document Format)
 * and Jira Server / Data Center (personal access token, REST v2, wiki markup). Node built-ins only.
 *
 * - Credentials: config.jira, field by field, else the environment (JIRA_BASE_URL / JIRA_URL,
 *   JIRA_EMAIL / JIRA_USER, JIRA_API_TOKEN / JIRA_TOKEN and the ATLASSIAN_* equivalents).
 * - Cloud (*.atlassian.net, or serverInfo deploymentType "Cloud"): Basic auth email:token, REST v3.
 *   Server/Data Center: Bearer personal access token, REST v2 (Basic username:password when the
 *   server has no PATs and a username is set).
 * - Every request: 15 s timeout, gzip, the HTTPS_PROXY / NO_PROXY environment, redirects followed
 *   only within the same site (credentials never go to another host), 429 retried after Retry-After.
 * - Errors (JiraError) carry the HTTP status, Jira's errorMessages and an actionable hint, and never
 *   the token.
 *
 * Descriptions and comments come back as Markdown (ADF and wiki markup converted); comments are
 * written as ADF (Cloud) or wiki markup (Server) converted from Markdown.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const util = require('util');
const zlib = require('zlib');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_RETRY_WAIT_MS = 5000;
const DETECT_TTL_MS = 10 * 60 * 1000;
const COMMENTS_SHOWN = 10;
const MAX_TEXT_CHARS = 60000;
const BRANCH_MAX = 60;
const SEARCH_MAX = 100;
const SEARCH_DEFAULT = 20;
const USER_AGENT = 'claude-anywhere-jira/1';

const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const SERVER_TOKEN_PATH = '/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens';
const NOT_CONNECTED =
  "Jira isn't connected: run `anywhere jira setup`, or add it in Settings → Jira, or read the ticket from the browser with read_browser_tab.";
const HOW_TO_CONNECT =
  `Run \`anywhere jira setup\` in a terminal (Jira Cloud API tokens are free: ${TOKEN_PAGE}), or add it in Settings → Jira. ` +
  'Until then, use an Atlassian MCP server if one is connected, or read the ticket from the browser with read_browser_tab.';

const ENV_NAMES = Object.freeze({
  baseUrl: ['JIRA_BASE_URL', 'JIRA_URL', 'ATLASSIAN_BASE_URL', 'ATLASSIAN_URL'],
  email: ['JIRA_EMAIL', 'JIRA_USER', 'JIRA_USERNAME', 'ATLASSIAN_EMAIL', 'ATLASSIAN_USER', 'ATLASSIAN_USERNAME'],
  apiToken: ['JIRA_API_TOKEN', 'JIRA_TOKEN', 'JIRA_PERSONAL_TOKEN', 'ATLASSIAN_API_TOKEN', 'ATLASSIAN_TOKEN'],
});

const CLOUD_HOST_RE = /(^|\.)(atlassian\.net|jira\.com|jira-dev\.com|atlassian-us-gov-mod\.net|atlassian-us-gov\.net)$/i;
// Path segments that start a Jira page rather than a Server/Data Center context path.
const PAGE_SEGMENTS = new Set(['browse', 'secure', 'projects', 'issues', 'rest', 'plugins', 'servicedesk', 'login.jsp', 'logout', 's', 'images', 'download', 'issue', 'filters', 'dashboards']);

// ---------------------------------------------------------------- small helpers

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return v == null ? '' : String(v);
}

function oneLine(s, max = 300) {
  const t = str(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function abortError(signal) {
  const reason = signal && signal.reason;
  const err = new Error(reason && reason.message ? reason.message : 'The request was cancelled');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** An error from Jira or from reaching it. Its message never contains the token. */
class JiraError extends Error {
  /**
   * @param {string} message
   * @param {{status?:number, code?:string, hint?:string, messages?:string[], candidates?:object[], options?:object[]}} [extra]
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'JiraError';
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) this[k] = v;
  }
}

// ---------------------------------------------------------------- settings

/** Is this a Jira Cloud host name (site.atlassian.net and friends)? */
function isCloudHost(host) {
  return CLOUD_HOST_RE.test(str(host).toLowerCase().replace(/\.$/, ''));
}

/**
 * Normalize what a user pastes as the Jira URL to the site root: adds https://, drops page paths
 * (/browse/ABC-1, /jira/software/..., /secure/...), keeps a Server context path (/jira) and always
 * uses https for Cloud.
 * @param {string} input
 * @returns {string} e.g. https://acme.atlassian.net or https://jira.example.com/jira
 */
function normalizeBaseUrl(input) {
  let s = str(input).trim();
  if (!s) throw new JiraError('The Jira URL is empty.', { code: 'BAD_URL' });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new JiraError(`"${oneLine(input, 120)}" is not a valid URL (example: https://yourcompany.atlassian.net).`, { code: 'BAD_URL' });
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new JiraError(`The Jira URL must start with https:// (got ${u.protocol}).`, { code: 'BAD_URL' });
  }
  if (u.username || u.password) {
    throw new JiraError('Do not put the email or token in the Jira URL; they have their own fields.', { code: 'BAD_URL' });
  }
  const host = u.hostname.toLowerCase();
  if (!host) throw new JiraError('The Jira URL has no host name.', { code: 'BAD_URL' });
  if (isCloudHost(host)) return `https://${host}${u.port && u.port !== '443' ? `:${u.port}` : ''}`;
  const keep = [];
  for (const seg of u.pathname.split('/').filter(Boolean)) {
    const low = seg.toLowerCase();
    if (PAGE_SEGMENTS.has(low) || /\.jspa?$/.test(low)) break;
    keep.push(seg);
  }
  const ctx = keep.length ? `/${keep.join('/')}` : '';
  return `${u.protocol}//${u.host.toLowerCase()}${ctx}`;
}

/**
 * The Jira settings to use: each field from `config.jira` when set there, else from the environment.
 * @param {object} config the user's config (only `.jira` is read)
 * @param {object} [env] process.env
 * @returns {{baseUrl:string, email:string, apiToken:string, configured:boolean, missing:string[],
 *   urlError:string|null, cloudHost:boolean, source:{baseUrl:string|null, email:string|null, apiToken:string|null}}}
 */
function resolveSettings(config, env = process.env) {
  const cfg = config && isObj(config.jira) ? config.jira : {};
  const e = env || {};
  const out = { baseUrl: '', email: '', apiToken: '', source: {} };
  for (const field of ['baseUrl', 'email', 'apiToken']) {
    const own = typeof cfg[field] === 'string' ? cfg[field].trim() : '';
    if (own) {
      out[field] = own;
      out.source[field] = 'config';
      continue;
    }
    const name = ENV_NAMES[field].find((n) => typeof e[n] === 'string' && e[n].trim());
    out[field] = name ? e[name].trim() : '';
    out.source[field] = name ? `env:${name}` : null;
  }
  out.urlError = null;
  if (out.baseUrl) {
    try {
      out.baseUrl = normalizeBaseUrl(out.baseUrl);
    } catch (err) {
      out.urlError = err.message;
    }
  }
  let host = '';
  try {
    host = out.baseUrl && !out.urlError ? new URL(out.baseUrl).hostname : '';
  } catch {
    host = '';
  }
  out.cloudHost = isCloudHost(host);
  const missing = [];
  if (!out.baseUrl) missing.push('baseUrl');
  if (!out.apiToken) missing.push('apiToken');
  if (out.cloudHost && !out.email) missing.push('email');
  out.missing = missing;
  out.configured = missing.length === 0 && !out.urlError;
  return out;
}

/**
 * Settings for a long-lived process (daemon, MCP server): config.json is re-read on every call,
 * because `anywhere jira setup` writes it directly while those processes hold older copies. The
 * in-memory config is used only when there is no config file (tests, embedders).
 * @param {object} liveConfig
 * @param {{env?:object, load?:()=>object}} [opts]
 */
function currentSettings(liveConfig, { env = process.env, load } = {}) {
  let cfg = null;
  if (typeof load === 'function') {
    try {
      cfg = load();
    } catch {
      cfg = null;
    }
  } else {
    try {
      const paths = require('../shared/paths');
      if (fs.existsSync(paths.configPath())) cfg = require('../shared/config').load();
    } catch {
      cfg = null;
    }
  }
  return resolveSettings(cfg || liveConfig || {}, env);
}

/** The page where a user creates a token for this site. */
function tokenPageFor(baseUrl) {
  let cloud = true;
  try {
    cloud = !baseUrl || isCloudHost(new URL(normalizeBaseUrl(baseUrl)).hostname);
  } catch {
    cloud = true;
  }
  if (cloud) return TOKEN_PAGE;
  return `${normalizeBaseUrl(baseUrl)}${SERVER_TOKEN_PATH}`;
}

/** Public, token-free view of resolved settings. */
function publicSettings(s) {
  return {
    configured: Boolean(s.configured),
    baseUrl: s.baseUrl || '',
    email: s.email || '',
    tokenSet: Boolean(s.apiToken),
    missing: s.missing || [],
    source: s.source || {},
    ...(s.urlError ? { urlError: s.urlError } : {}),
  };
}

// ---------------------------------------------------------------- issue keys and branches

const KEY_IN_URL_RE = /(?:\/browse\/|\/issues\/|[?&](?:selectedIssue|issueKey|issue)=)([A-Za-z][A-Za-z0-9_]*-\d+)/i;
const KEY_RE = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]{0,49}-\d{1,12})(?![A-Za-z0-9_])/;

/**
 * The issue key in a key, a Jira URL or a title ("ABC-123", "abc-123", ".../browse/ABC-123").
 * @param {string} input
 * @returns {string|null} upper-case key
 */
function parseIssueKey(input) {
  const s = str(input).trim();
  if (!s) return null;
  let m = KEY_IN_URL_RE.exec(s);
  if (m) return m[1].toUpperCase();
  m = KEY_RE.exec(s);
  return m ? m[1].toUpperCase() : null;
}

function requireKey(input) {
  const key = parseIssueKey(input);
  if (!key) {
    throw new JiraError(`"${oneLine(input, 80)}" is not a Jira issue key (keys look like ABC-123).`, { code: 'BAD_KEY' });
  }
  return key;
}

/**
 * A git branch name for an issue: ABC-123-fix-login-timeout (ASCII, at most `max` characters,
 * cut at a word boundary).
 * @param {string} key
 * @param {string} [summary]
 * @param {number} [max]
 */
function branchName(key, summary, max = BRANCH_MAX) {
  const k = parseIssueKey(key) || str(key).toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'ISSUE';
  const slug = str(summary)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return k.slice(0, max);
  let name = `${k}-${slug}`;
  if (name.length <= max) return name;
  name = name.slice(0, max);
  const cut = name.lastIndexOf('-');
  if (cut > k.length) name = name.slice(0, cut);
  return name.replace(/-+$/, '');
}

// ---------------------------------------------------------------- JQL helpers

/** Quote a value for JQL. */
function jqlQuote(v) {
  return `"${str(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * JQL for "my issues" with a status filter: open (default: not done), todo, in progress, done, all,
 * or an exact workflow status name.
 * @param {string} [status]
 */
function myIssuesJql(status) {
  const s = str(status).trim();
  const low = s.toLowerCase().replace(/[\s_-]+/g, ' ');
  const base = 'assignee = currentUser()';
  const order = ' ORDER BY updated DESC';
  if (!low || ['open', 'unresolved', 'active', 'current', 'not done', 'pending'].includes(low)) return `${base} AND statusCategory != Done${order}`;
  if (['all', 'any', 'everything'].includes(low)) return `${base}${order}`;
  if (['done', 'closed', 'resolved', 'complete', 'completed', 'finished'].includes(low)) return `${base} AND statusCategory = Done${order}`;
  if (['todo', 'to do', 'new', 'backlog', 'not started'].includes(low)) return `${base} AND statusCategory = "To Do"${order}`;
  if (['in progress', 'inprogress', 'started', 'doing', 'wip'].includes(low)) return `${base} AND statusCategory = "In Progress"${order}`;
  return `${base} AND status = ${jqlQuote(s)}${order}`;
}

/** Split "where ORDER BY x" into its parts. */
function splitOrderBy(jql) {
  const m = /^([\s\S]*?)\s*\border\s+by\b([\s\S]*)$/i.exec(str(jql));
  if (!m) return { where: str(jql).trim(), order: '' };
  return { where: m[1].trim(), order: `ORDER BY${m[2]}`.trim() };
}

// ---------------------------------------------------------------- ADF → Markdown

const PANEL_LABELS = { info: 'Info', note: 'Note', warning: 'Warning', error: 'Error', success: 'Success', tip: 'Tip', custom: 'Note' };

function fenceFor(text, ch = '`') {
  let longest = 0;
  const re = ch === '`' ? /`+/g : /~+/g;
  for (const m of str(text).matchAll(re)) longest = Math.max(longest, m[0].length);
  return ch.repeat(Math.max(3, longest + 1));
}

function codeSpan(text) {
  const t = str(text);
  let longest = 0;
  for (const m of t.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const tick = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${tick}${pad}${t}${pad}${tick}`;
}

function quoteLines(text) {
  return str(text)
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

function indentRest(text, pad) {
  return str(text)
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join('\n');
}

function formatDateMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return str(ms);
  try {
    return new Date(n).toISOString().slice(0, 10);
  } catch {
    return str(ms);
  }
}

function textOf(node) {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) return node.content.map(textOf).join(node.type === 'codeBlock' ? '' : '');
  return '';
}

function markOf(node, type) {
  return Array.isArray(node.marks) ? node.marks.find((m) => m && m.type === type) : undefined;
}

function cardUrl(node) {
  const a = (node && node.attrs) || {};
  if (a.url) return a.url;
  if (a.data && (a.data.url || a.data.name)) return a.data.url || a.data.name;
  return '';
}

function mentionText(node) {
  const a = (node && node.attrs) || {};
  const t = str(a.text).trim();
  if (t) return t.startsWith('@') ? t : `@${t}`;
  return a.id ? `@user(${a.id})` : '@user';
}

function mediaMd(node) {
  const a = (node && node.attrs) || {};
  if (a.type === 'external' && a.url) return `![${str(a.alt) || 'image'}](${a.url})`;
  const alt = str(a.alt || a.name || a.fileName).trim();
  return alt ? `[attachment: ${alt}]` : '[attachment]';
}

function emphasize(text, marks) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  let core = m[2];
  if (!core) return text;
  if (marks.some((x) => x.type === 'strike')) core = `~~${core}~~`;
  if (marks.some((x) => x.type === 'em')) core = `*${core}*`;
  if (marks.some((x) => x.type === 'strong')) core = `**${core}**`;
  return m[1] + core + m[3];
}

function textMd(node) {
  const marks = Array.isArray(node.marks) ? node.marks.filter(Boolean) : [];
  if (marks.some((x) => x.type === 'code')) return codeSpan(node.text);
  return emphasize(str(node.text), marks);
}

/** Inline ADF nodes → Markdown. Adjacent text with the same link becomes one link. */
function inlineMd(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let out = '';
  for (let i = 0; i < list.length; i += 1) {
    const n = list[i];
    if (!n || typeof n !== 'object') continue;
    if (n.type === 'text') {
      const link = markOf(n, 'link');
      const href = link && link.attrs && link.attrs.href;
      if (href) {
        let inner = '';
        let j = i;
        while (j < list.length && list[j] && list[j].type === 'text') {
          const l2 = markOf(list[j], 'link');
          if (!l2 || !l2.attrs || l2.attrs.href !== href) break;
          inner += textMd(list[j]);
          j += 1;
        }
        i = j - 1;
        out += inner.trim() === href ? href : `[${inner}](${href})`;
      } else {
        out += textMd(n);
      }
      continue;
    }
    switch (n.type) {
      case 'hardBreak':
        out += '\n';
        break;
      case 'mention':
        out += mentionText(n);
        break;
      case 'emoji':
        out += str((n.attrs && (n.attrs.text || n.attrs.shortName)) || '');
        break;
      case 'inlineCard':
        out += cardUrl(n);
        break;
      case 'date':
        out += formatDateMs(n.attrs && n.attrs.timestamp);
        break;
      case 'status':
        out += `[${str(n.attrs && n.attrs.text).toUpperCase()}]`;
        break;
      case 'mediaInline':
        out += mediaMd(n);
        break;
      case 'placeholder':
      case 'inlineExtension':
        break;
      default:
        if (Array.isArray(n.content)) out += inlineMd(n.content);
        else if (typeof n.text === 'string') out += n.text;
    }
  }
  return out;
}

function listItemMd(item) {
  if (!item || !Array.isArray(item.content)) return inlineMd(item ? [item] : []);
  return item.content
    .map((c) => blockMd(c))
    .filter((s) => s !== '')
    .join('\n');
}

function listMd(node, ordered) {
  let num = ordered ? Number(node.attrs && node.attrs.order) || 1 : 0;
  return (node.content || [])
    .map((item) => {
      const marker = ordered ? `${num++}. ` : '- ';
      return indentRest(marker + listItemMd(item), ' '.repeat(marker.length));
    })
    .join('\n');
}

function taskListMd(node) {
  return (node.content || [])
    .map((item) => {
      if (item && item.type === 'taskList') return indentRest(`  ${taskListMd(item)}`, '  ');
      const done = item && item.attrs && item.attrs.state === 'DONE';
      return indentRest(`- [${done ? 'x' : ' '}] ${inlineMd((item && item.content) || [])}`, '      ');
    })
    .join('\n');
}

function cellMd(cell) {
  return blocksMd((cell && cell.content) || [])
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, '<br>')
    .trim();
}

function tableMd(node) {
  const rows = (node.content || []).filter((r) => r && r.type === 'tableRow').map((r) => (r.content || []).map(cellMd));
  if (!rows.length) return '';
  const width = Math.max(1, ...rows.map((r) => r.length));
  const pad = (r) => {
    const c = r.slice();
    while (c.length < width) c.push('');
    return c;
  };
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const out = [line(pad(rows[0])), `|${' --- |'.repeat(width)}`];
  for (const r of rows.slice(1)) out.push(line(pad(r)));
  return out.join('\n');
}

function blockMd(n) {
  if (!n || typeof n !== 'object') return '';
  switch (n.type) {
    case 'doc':
      return blocksMd(n.content);
    case 'paragraph':
      return inlineMd(n.content);
    case 'heading': {
      const level = clampInt(n.attrs && n.attrs.level, 1, 6, 1);
      return `${'#'.repeat(level)} ${inlineMd(n.content).replace(/\n+/g, ' ').trim()}`;
    }
    case 'bulletList':
      return listMd(n, false);
    case 'orderedList':
      return listMd(n, true);
    case 'taskList':
      return taskListMd(n);
    case 'decisionList':
      return (n.content || []).map((d) => `- Decision: ${inlineMd((d && d.content) || [])}`).join('\n');
    case 'listItem':
      return listItemMd(n);
    case 'codeBlock': {
      const text = textOf(n).replace(/\n$/, '');
      const fence = fenceFor(text);
      const lang = str(n.attrs && n.attrs.language).replace(/\s+/g, '');
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case 'blockquote':
      return quoteLines(blocksMd(n.content));
    case 'panel': {
      const label = PANEL_LABELS[n.attrs && n.attrs.panelType] || 'Note';
      return quoteLines(`**${label}:** ${blocksMd(n.content)}`);
    }
    case 'rule':
      return '---';
    case 'table':
      return tableMd(n);
    case 'mediaSingle':
    case 'mediaGroup':
      return (n.content || []).map(mediaMd).join('\n');
    case 'media':
      return mediaMd(n);
    case 'expand':
    case 'nestedExpand': {
      const title = str(n.attrs && n.attrs.title).trim() || 'Details';
      const body = blocksMd(n.content);
      return body ? `**${title}**\n\n${body}` : `**${title}**`;
    }
    case 'blockCard':
    case 'embedCard':
      return cardUrl(n);
    case 'layoutSection':
    case 'layoutColumn':
    case 'bodiedExtension':
      return blocksMd(n.content);
    case 'extension':
      return '';
    case 'text':
    case 'hardBreak':
    case 'mention':
    case 'emoji':
    case 'inlineCard':
    case 'date':
    case 'status':
    case 'mediaInline':
      return inlineMd([n]);
    default:
      if (Array.isArray(n.content)) return blocksMd(n.content);
      return typeof n.text === 'string' ? n.text : '';
  }
}

function blocksMd(nodes) {
  return (Array.isArray(nodes) ? nodes : [])
    .map((c) => blockMd(c))
    .filter((s) => s !== '')
    .join('\n\n');
}

/** Is this an Atlassian Document Format node? */
function isAdf(v) {
  return isObj(v) && typeof v.type === 'string' && (v.type === 'doc' || Array.isArray(v.content));
}

/**
 * Atlassian Document Format → clean Markdown (headings, lists, task lists, code, tables, quotes,
 * panels, links, mentions, emoji, dates, status lozenges, media placeholders).
 * @param {object|string|null} doc
 * @returns {string}
 */
function adfToMarkdown(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc;
  const md = Array.isArray(doc) ? blocksMd(doc) : blockMd(doc);
  return md
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- Markdown → ADF

const ESCAPABLE = new Set('\\`*_{}[]()#+-.!|~<>'.split(''));
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/;
const TABLE_SEP_RE = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

function expandTabs(line) {
  return line.replace(/^\t+/, (t) => '    '.repeat(t.length));
}

function indentOf(line) {
  return /^ */.exec(line)[0].length;
}

function sameMarks(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function textNode(text, marks) {
  let ms = [];
  for (const m of marks || []) if (!ms.some((x) => x.type === m.type)) ms.push(m);
  if (ms.some((m) => m.type === 'code')) ms = ms.filter((m) => m.type === 'code' || m.type === 'link');
  const node = { type: 'text', text };
  if (ms.length) node.marks = ms;
  return node;
}

function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === 'text' && last && last.type === 'text' && sameMarks(last.marks, n.marks)) last.text += n.text;
    else out.push(n);
  }
  return out.filter((n) => n.type !== 'text' || n.text !== '');
}

/** Skip a code span starting at i (a run of backticks); returns the index after it, or -1. */
function codeSpanEnd(src, i) {
  let run = 0;
  while (src[i + run] === '`') run += 1;
  let k = i + run;
  while (k < src.length) {
    if (src[k] === '`') {
      let r = 0;
      while (src[k + r] === '`') r += 1;
      if (r === run) return k + r;
      k += r;
    } else k += 1;
  }
  return -1;
}

/** `[text](url "title")` at `at` (src[at] === '['): {text, href, end} or null. */
function matchLink(src, at) {
  let depth = 0;
  let k = at;
  for (; k < src.length; k += 1) {
    const c = src[k];
    if (c === '\\') {
      k += 1;
      continue;
    }
    if (c === '`') {
      const e = codeSpanEnd(src, k);
      if (e > 0) {
        k = e - 1;
        continue;
      }
    }
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || src[k + 1] !== '(') return null;
  const text = src.slice(at + 1, k);
  let p = k + 2;
  while (src[p] === ' ') p += 1;
  let href = '';
  if (src[p] === '<') {
    const close = src.indexOf('>', p);
    if (close < 0) return null;
    href = src.slice(p + 1, close);
    p = close + 1;
  } else {
    let parens = 0;
    const start = p;
    for (; p < src.length; p += 1) {
      const c = src[p];
      if (c === '\\') {
        p += 1;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === '(') parens += 1;
      else if (c === ')') {
        if (parens === 0) break;
        parens -= 1;
      }
    }
    href = src.slice(start, p);
  }
  while (src[p] === ' ') p += 1;
  if (src[p] === '"' || src[p] === "'") {
    const q = src[p];
    const close = src.indexOf(q, p + 1);
    if (close < 0) return null;
    p = close + 1;
    while (src[p] === ' ') p += 1;
  }
  if (src[p] !== ')') return null;
  return { text, href: href.trim(), end: p + 1 };
}

/** Emphasis (`*x*`, `**x**`, `_x_`, `__x__`, `~~x~~`) starting at i: {inner, end, mark} or null. */
function matchEmphasis(src, i, c) {
  let run = 0;
  while (src[i + run] === c) run += 1;
  const before = i > 0 ? src[i - 1] : ' ';
  const lengths = c === '~' ? (run >= 2 ? [2] : []) : run >= 2 ? [2, 1] : [1];
  for (const n of lengths) {
    const open = i + n;
    if (open >= src.length || /\s/.test(src[open])) continue;
    if (c === '_' && /[A-Za-z0-9]/.test(before)) continue;
    let k = open;
    while (k < src.length) {
      if (src[k] === '\\') {
        k += 2;
        continue;
      }
      if (src[k] === '`') {
        const e = codeSpanEnd(src, k);
        if (e > 0) {
          k = e;
          continue;
        }
      }
      if (src[k] === c && k > open) {
        let r = 0;
        while (src[k + r] === c) r += 1;
        // The closer is the last n characters of a run of exactly n, or of 3 (`*a **b***`).
        const ok = (r === n || r === 3) && !/\s/.test(src[k - 1]) && (c !== '_' || !/[A-Za-z0-9]/.test(src[k + r] || ' '));
        if (ok) {
          const close = k + r - n;
          const inner = src.slice(open, close);
          if (inner.trim()) {
            const mark = c === '~' ? { type: 'strike' } : n === 2 ? { type: 'strong' } : { type: 'em' };
            return { inner, end: close + n, mark };
          }
        }
        k += r;
        continue;
      }
      k += 1;
    }
  }
  return null;
}

/**
 * Inline Markdown → ADF inline nodes.
 * @param {string} src
 * @param {object[]} marks marks applied to everything inside
 * @param {{cloud:boolean}} opts
 */
function parseInline(src, marks, opts) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(textNode(buf, marks));
    buf = '';
  };
  const inLink = marks.some((m) => m.type === 'link');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '\n') {
      flush();
      out.push({ type: 'hardBreak' });
      i += 1;
      continue;
    }
    if (c === '`') {
      const end = codeSpanEnd(src, i);
      if (end > 0) {
        let run = 0;
        while (src[i + run] === '`') run += 1;
        let code = src.slice(i + run, end - run).replace(/\n/g, ' ');
        if (/^ [\s\S]* $/.test(code) && code.trim()) code = code.slice(1, -1);
        flush();
        if (code) out.push(textNode(code, [...marks.filter((m) => m.type === 'link'), { type: 'code' }]));
        i = end;
        continue;
      }
      let run = 0;
      while (src[i + run] === '`') run += 1;
      buf += '`'.repeat(run);
      i += run;
      continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const image = c === '!';
      const at = image ? i + 1 : i;
      if (!image) {
        const mention = /^\[~(accountid:)?([^\]\s]+)\]/i.exec(src.slice(at, at + 200));
        if (mention) {
          flush();
          const id = mention[2];
          if (opts.cloud && !mention[1]) out.push(textNode(`@${id}`, marks));
          else out.push({ type: 'mention', attrs: { id } });
          i = at + mention[0].length;
          continue;
        }
      }
      const link = matchLink(src, at);
      if (link && link.href) {
        flush();
        const label = link.text || link.href;
        if (image) out.push(textNode(link.text || link.href, inLink ? marks : [...marks, { type: 'link', attrs: { href: link.href } }]));
        else if (inLink) out.push(...parseInline(label, marks, opts));
        else out.push(...parseInline(label, [...marks, { type: 'link', attrs: { href: link.href } }], opts));
        i = link.end;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }
    if (c === '<') {
      const m = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(src.slice(i, i + 2100));
      if (m) {
        flush();
        out.push(textNode(m[1], inLink ? marks : [...marks, { type: 'link', attrs: { href: m[1] } }]));
        i += m[0].length;
        continue;
      }
    }
    if (!inLink && (c === 'h' || c === 'H') && (i === 0 || /[\s(\[{"'>]/.test(src[i - 1]))) {
      const m = /^https?:\/\/[^\s<]+/i.exec(src.slice(i, i + 2100));
      if (m) {
        let url = m[0];
        while (/[.,;:!?'")\]*_]$/.test(url)) {
          if (url.endsWith(')') && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
          url = url.slice(0, -1);
        }
        flush();
        out.push(textNode(url, [...marks, { type: 'link', attrs: { href: url } }]));
        i += url.length;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const em = matchEmphasis(src, i, c);
      if (em) {
        flush();
        out.push(...parseInline(em.inner, [...marks, em.mark], opts));
        i = em.end;
        continue;
      }
      let run = 0;
      while (src[i + run] === c) run += 1;
      buf += c.repeat(run);
      i += run;
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return mergeText(out);
}

function paragraphNode(text, opts) {
  const content = parseInline(str(text).replace(/\\\n/g, '\n').replace(/ {2,}\n/g, '\n'), [], opts);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (c === '`') {
      const e = codeSpanEnd(s, i);
      if (e > 0) {
        cur += s.slice(i, e);
        i = e - 1;
      } else cur += c;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_SEP_RE.test(lines[i + 1]);
}

function startsBlock(lines, i) {
  const l = lines[i];
  if (FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l)) return true;
  const m = LIST_RE.exec(l);
  if (m && m[3]) return true;
  return isTableStart(lines, i);
}

function cellNode(type, text, opts) {
  const parts = str(text).split(/<br\s*\/?>/i).join('\n');
  return { type, attrs: {}, content: [paragraphNode(parts, opts)] };
}

/** Block nodes allowed inside a list item or a quote; others are converted. */
function restrictBlocks(nodes, allowed, opts) {
  const out = [];
  for (const n of nodes) {
    if (allowed.has(n.type)) out.push(n);
    else if (n.type === 'heading') out.push({ type: 'paragraph', content: (n.content || []).map((t) => (t.type === 'text' ? textNode(t.text, [...(t.marks || []), { type: 'strong' }]) : t)) });
    else if (n.type === 'blockquote') out.push(...restrictBlocks(n.content || [], allowed, opts));
    else if (n.type === 'table') {
      for (const row of n.content || []) {
        const texts = (row.content || []).map((cell) => adfToMarkdown({ type: 'doc', content: cell.content || [] }).replace(/\n+/g, ' '));
        out.push(paragraphNode(texts.join(' | '), opts));
      }
    }
  }
  return out;
}

const LIST_ITEM_BLOCKS = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock']);
const QUOTE_BLOCKS = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock']);

function parseList(lines, start, opts) {
  const first = LIST_RE.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      const next = j < lines.length ? LIST_RE.exec(lines[j]) : null;
      if (next && next[1].length === base && /\d/.test(next[2]) === ordered) {
        i = j;
        continue;
      }
      break;
    }
    const m = LIST_RE.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = base + m[2].length + 1;
    const itemLines = [m[3] || ''];
    i += 1;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j += 1;
        if (j < lines.length && indentOf(lines[j]) > base) {
          for (; i < j; i += 1) itemLines.push('');
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind > base) {
        itemLines.push(l.slice(Math.min(ind, contentIndent)));
        i += 1;
        continue;
      }
      if (startsBlock(lines, i) || LIST_RE.test(l)) break;
      itemLines.push(l.trim());
      i += 1;
    }
    itemLines[0] = itemLines[0].replace(/^\[ \][ \t]+/, '☐ ').replace(/^\[[xX]\][ \t]+/, '☑ ');
    let content = restrictBlocks(parseBlocks(itemLines, opts), LIST_ITEM_BLOCKS, opts);
    if (!content.length || (content[0].type !== 'paragraph' && content[0].type !== 'codeBlock')) content = [{ type: 'paragraph' }, ...content];
    items.push({ type: 'listItem', content });
  }
  const node = { type: ordered ? 'orderedList' : 'bulletList', content: items };
  const startNum = Number(/\d+/.exec(first[2]) && /\d+/.exec(first[2])[0]);
  if (ordered && Number.isFinite(startNum) && startNum !== 1) node.attrs = { order: startNum };
  return { node, next: i };
}

function parseBlocks(rawLines, opts) {
  const lines = rawLines.map(expandTabs);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    let m = FENCE_RE.exec(line);
    if (m) {
      const indent = m[1].length;
      const fence = m[2];
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      const body = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(indent ? lines[i].replace(new RegExp(`^ {0,${indent}}`), '') : lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const text = body.join('\n');
      const node = { type: 'codeBlock' };
      if (m[3]) node.attrs = { language: m[3] };
      if (text) node.content = [{ type: 'text', text }];
      out.push(node);
      continue;
    }
    m = HEADING_RE.exec(line);
    if (m) {
      const content = parseInline(m[2] || '', [], opts);
      out.push(content.length ? { type: 'heading', attrs: { level: m[1].length }, content } : { type: 'heading', attrs: { level: m[1].length } });
      i += 1;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push({ type: 'rule' });
      i += 1;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && lines[i].trim()) {
        const q = QUOTE_RE.exec(lines[i]);
        if (q) inner.push(q[1]);
        else if (startsBlock(lines, i)) break;
        else inner.push(lines[i]);
        i += 1;
      }
      const content = restrictBlocks(parseBlocks(inner, opts), QUOTE_BLOCKS, opts);
      out.push({ type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] });
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(lines[i]);
      const width = header.length;
      const rows = [header.map((c) => cellNode('tableHeader', c, opts))];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i]).slice(0, width);
        while (cells.length < width) cells.push('');
        rows.push(cells.map((c) => cellNode('tableCell', c, opts)));
        i += 1;
      }
      out.push({ type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: rows.map((content) => ({ type: 'tableRow', content })) });
      continue;
    }
    m = LIST_RE.exec(line);
    if (m && (m[3] || (lines[i + 1] && indentOf(lines[i + 1]) > m[1].length))) {
      const { node, next } = parseList(lines, i, opts);
      out.push(node);
      i = next;
      continue;
    }
    const para = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      para.push(lines[i].replace(/^ +/, ''));
      i += 1;
    }
    out.push(paragraphNode(para.join('\n'), opts));
  }
  return out;
}

/**
 * Markdown → an ADF document (for Jira Cloud comments). Handles headings, paragraphs (line breaks
 * kept), bullet/ordered/task lists, fenced code, quotes, rules, pipe tables, **bold**, *italic*,
 * ~~strike~~, `code`, links, bare URLs and [~accountid:ID] mentions.
 * @param {string} markdown
 * @param {{cloud?:boolean}} [opts]
 * @returns {{version:1, type:'doc', content:object[]}}
 */
function markdownToAdf(markdown, opts = {}) {
  const o = { cloud: opts.cloud !== false };
  const lines = str(markdown).replace(/\r\n?/g, '\n').split('\n');
  const content = parseBlocks(lines, o);
  return { version: 1, type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

// ---------------------------------------------------------------- ADF → Jira wiki markup (Server)

function wikiEscape(text) {
  return str(text).replace(/[{}[\]|]|[*_+^~!-]/g, (ch, at, s) => {
    if ('{}[]|'.includes(ch)) return `\\${ch}`;
    const prev = at > 0 ? s[at - 1] : ' ';
    const next = at + 1 < s.length ? s[at + 1] : ' ';
    return /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next) ? ch : `\\${ch}`;
  });
}

function inlineWikiOut(nodes) {
  let out = '';
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n) continue;
    if (n.type === 'text') {
      const marks = Array.isArray(n.marks) ? n.marks : [];
      const has = (t) => marks.some((m) => m && m.type === t);
      let t = has('code') ? `{{${str(n.text).replace(/[{}]/g, (c) => `\\${c}`)}}}` : wikiEscape(n.text);
      if (!has('code')) {
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t);
        let core = m[2];
        if (core) {
          if (has('strike')) core = `-${core}-`;
          if (has('underline')) core = `+${core}+`;
          if (has('em')) core = `_${core}_`;
          if (has('strong')) core = `*${core}*`;
        }
        t = m[1] + core + m[3];
      }
      const link = marks.find((m) => m && m.type === 'link');
      if (link && link.attrs && link.attrs.href) t = n.text === link.attrs.href ? `[${link.attrs.href}]` : `[${t}|${link.attrs.href}]`;
      out += t;
    } else if (n.type === 'hardBreak') out += '\n';
    else if (n.type === 'mention') out += `[~${str(n.attrs && n.attrs.id)}]`;
    else if (n.type === 'emoji') out += str(n.attrs && (n.attrs.text || n.attrs.shortName));
    else if (n.type === 'inlineCard') out += `[${cardUrl(n)}]`;
    else if (Array.isArray(n.content)) out += inlineWikiOut(n.content);
    else if (typeof n.text === 'string') out += wikiEscape(n.text);
  }
  return out;
}

function listWiki(node, prefix) {
  const lines = [];
  for (const item of node.content || []) {
    const blocks = (item && item.content) || [];
    const texts = [];
    const nested = [];
    for (const b of blocks) {
      if (b.type === 'bulletList') nested.push(listWiki(b, `${prefix}*`));
      else if (b.type === 'orderedList') nested.push(listWiki(b, `${prefix}#`));
      else texts.push(blockWiki(b).replace(/\n/g, ' \\\\ '));
    }
    lines.push(`${prefix} ${texts.join(' \\\\ ')}`.trimEnd());
    lines.push(...nested);
  }
  return lines.join('\n');
}

function blockWiki(n) {
  if (!n) return '';
  switch (n.type) {
    case 'doc':
      return blocksWiki(n.content);
    case 'paragraph':
      return inlineWikiOut(n.content);
    case 'heading':
      return `h${clampInt(n.attrs && n.attrs.level, 1, 6, 1)}. ${inlineWikiOut(n.content).replace(/\n+/g, ' ')}`;
    case 'bulletList':
      return listWiki(n, '*');
    case 'orderedList':
      return listWiki(n, '#');
    case 'codeBlock': {
      const lang = str(n.attrs && n.attrs.language).replace(/[^\w+#.-]/g, '');
      return `{code${lang ? `:${lang}` : ''}}\n${textOf(n)}\n{code}`;
    }
    case 'blockquote':
      return `{quote}\n${blocksWiki(n.content)}\n{quote}`;
    case 'rule':
      return '----';
    case 'table': {
      const rows = (n.content || []).map((row) => {
        const cells = row.content || [];
        const header = cells.length && cells.every((c) => c.type === 'tableHeader');
        const sep = header ? '||' : '|';
        return `${sep}${cells.map((c) => blocksWiki(c.content || []).replace(/\n+/g, ' \\\\ ') || ' ').join(sep)}${sep}`;
      });
      return rows.join('\n');
    }
    default:
      if (Array.isArray(n.content)) return blocksWiki(n.content);
      return typeof n.text === 'string' ? wikiEscape(n.text) : '';
  }
}

function blocksWiki(nodes) {
  return (Array.isArray(nodes) ? nodes : [])
    .map(blockWiki)
    .filter((s) => s !== '')
    .join('\n\n');
}

/**
 * Markdown → Jira wiki markup (for Server / Data Center comments).
 * @param {string} markdown
 */
function markdownToWiki(markdown) {
  return blocksWiki(markdownToAdf(markdown, { cloud: false }).content).trim();
}

// ---------------------------------------------------------------- Jira wiki markup → Markdown (Server)

function inlineFromWiki(s, { inTable = false } = {}) {
  const slots = [];
  const keep = (v) => `\u0000${slots.push(v) - 1}\u0000`;
  let t = str(s);
  t = t.replace(/\{\{([\s\S]+?)\}\}/g, (_, c) => keep(codeSpan(c)));
  t = t.replace(/\\\\/g, () => keep(inTable ? '<br>' : '\n'));
  t = t.replace(/\\([*_\-+^~{}[\]|!?#])/g, (_, ch) => keep(ch));
  t = t.replace(/!([^!\s|][^!|\n]*?)(?:\|[^!\n]*)?!/g, (_, f) => keep(/^https?:/i.test(f) ? `![image](${f})` : `[image: ${f}]`));
  t = t.replace(/\[~(?:accountid:)?([^\]]+)\]/g, (_, u) => keep(`@${u}`));
  t = t.replace(/\[([^\]|\n]*?)\|([^\]\n]+?)\]/g, (_, text, url) => keep(text.trim() ? `[${text.trim()}](${url.trim()})` : url.trim()));
  t = t.replace(/\[((?:https?|mailto|ftp|file):[^\]\n]+)\]/g, (_, url) => keep(url));
  t = t.replace(/\{color(?::[^}]*)?\}/g, '');
  t = t.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?=$|[^\w*])/g, '$1**$2**');
  t = t.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?=$|[^\w])/g, '$1*$2*');
  t = t.replace(/(^|[\s(])-(?=[^\s-])([^-\n]*?[^\s-])-(?=$|[\s).,;:!?])/g, '$1~~$2~~');
  t = t.replace(/(^|[^\w])\+(?=\S)([^+\n]*?\S)\+(?=$|[^\w])/g, '$1$2');
  t = t.replace(/\?\?(.+?)\?\?/g, '*$1*');
  // eslint-disable-next-line no-control-regex
  return t.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
}

function wikiTableCells(line, sep) {
  // \| is a literal pipe inside a cell; links ([text|url]) and images (!a.png|thumbnail!) hold pipes too.
  const slots = [];
  let s = line
    .trim()
    .replace(/\\\||\[[^\]\n]*\]|![^!\s][^!\n]*!/g, (m) => `\u0001${slots.push(m) - 1}\u0001`);
  if (s.startsWith(sep)) s = s.slice(sep.length);
  if (s.endsWith(sep)) s = s.slice(0, -sep.length);
  else if (s.endsWith('|')) s = s.slice(0, -1);
  // eslint-disable-next-line no-control-regex
  const restore = (c) => c.replace(/\u0001(\d+)\u0001/g, (_, n) => slots[Number(n)]);
  return s.split(sep === '||' ? /\|\|?/ : /\|/).map((c) => inlineFromWiki(restore(c).trim(), { inTable: true }).replace(/(^|[^\\])\|/g, '$1\\|'));
}

/**
 * Jira wiki markup (Server/Data Center descriptions and comments) → Markdown.
 * @param {string} src
 */
function wikiToMarkdown(src) {
  const lines = str(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inTable = false;
  while (i < lines.length) {
    const line = lines[i];
    let m = /^\s*\{(code|noformat)(?::([^}]*))?\}(.*)$/.exec(line);
    if (m) {
      const tag = m[1];
      const segs = str(m[2]).split('|').map((x) => x.trim()).filter(Boolean);
      let lang = segs.find((x) => !x.includes('=')) || '';
      if (!lang) {
        const lp = segs.find((x) => /^language=/i.test(x));
        if (lp) lang = lp.slice(lp.indexOf('=') + 1);
      }
      lang = tag === 'code' ? lang.replace(/[^\w+#.-]/g, '') : '';
      const closeRe = new RegExp(`\\{${tag}\\}`);
      const body = [];
      const rest = m[3];
      if (closeRe.test(rest)) {
        body.push(rest.split(closeRe)[0]);
        i += 1;
      } else {
        if (rest.trim()) body.push(rest);
        i += 1;
        while (i < lines.length && !closeRe.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) {
          const before = lines[i].split(closeRe)[0];
          if (before.trim()) body.push(before);
          i += 1;
        }
      }
      const text = body.join('\n');
      const fence = fenceFor(text);
      out.push(`${fence}${lang}`, text, fence, '');
      inTable = false;
      continue;
    }
    m = /^\s*\{(quote|panel|info|note|warning|tip)(?::([^}]*))?\}(.*)$/.exec(line);
    if (m) {
      const tag = m[1];
      const closeRe = new RegExp(`\\{${tag}\\}`);
      const body = [];
      const rest = m[3];
      if (closeRe.test(rest)) {
        body.push(rest.split(closeRe)[0]);
        i += 1;
      } else {
        if (rest.trim()) body.push(rest);
        i += 1;
        while (i < lines.length && !closeRe.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) {
          const before = lines[i].split(closeRe)[0];
          if (before.trim()) body.push(before);
          i += 1;
        }
      }
      const inner = wikiToMarkdown(body.join('\n'));
      const title = /(?:^|\|)title=([^|]*)/.exec(str(m[2]));
      const label = tag === 'quote' ? '' : `**${(title && title[1].trim()) || tag[0].toUpperCase() + tag.slice(1)}:** `;
      out.push(quoteLines(label + inner), '');
      inTable = false;
      continue;
    }
    m = /^\s*h([1-6])\.\s+(.*)$/.exec(line);
    if (m) {
      out.push(`${'#'.repeat(Number(m[1]))} ${inlineFromWiki(m[2])}`, '');
      inTable = false;
      i += 1;
      continue;
    }
    m = /^\s*bq\.\s+(.*)$/.exec(line);
    if (m) {
      out.push(quoteLines(inlineFromWiki(m[1])));
      inTable = false;
      i += 1;
      continue;
    }
    if (/^\s*-{4,}\s*$/.test(line)) {
      out.push('---', '');
      inTable = false;
      i += 1;
      continue;
    }
    m = /^\s*([*#-]+)\s+(.*)$/.exec(line);
    if (m && !/^-{2,}$/.test(m[1])) {
      const prefix = m[1];
      let indent = '';
      for (const ch of prefix.slice(0, -1)) indent += ch === '#' ? '   ' : '  ';
      out.push(`${indent}${prefix.endsWith('#') ? '1.' : '-'} ${inlineFromWiki(m[2])}`);
      inTable = false;
      i += 1;
      continue;
    }
    if (/^\s*\|\|/.test(line)) {
      const cells = wikiTableCells(line, '||');
      out.push(`| ${cells.join(' | ')} |`, `|${' --- |'.repeat(cells.length)}`);
      inTable = true;
      i += 1;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const cells = wikiTableCells(line, '|');
      if (!inTable) out.push(`| ${cells.map(() => ' ').join(' | ')} |`, `|${' --- |'.repeat(cells.length)}`);
      out.push(`| ${cells.join(' | ')} |`);
      inTable = true;
      i += 1;
      continue;
    }
    inTable = false;
    out.push(inlineFromWiki(line));
    i += 1;
  }
  return out
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- HTTP transport

function isLoopbackHost(host) {
  const h = str(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  return h === '::1';
}

function noProxyMatches(list, host, port) {
  const h = str(host).toLowerCase().replace(/^\[|\]$/g, '');
  for (const raw of str(list).split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryPort = '';
    const pm = /^(.*):(\d+)$/.exec(entry);
    if (pm && !net.isIPv6(entry)) {
      entry = pm[1];
      entryPort = pm[2];
    }
    if (entryPort && entryPort !== String(port)) continue;
    entry = entry.replace(/^\*?\./, '.');
    if (h === entry.replace(/^\./, '') || (entry.startsWith('.') ? h.endsWith(entry) : h.endsWith(`.${entry}`))) return true;
  }
  return false;
}

/**
 * The proxy for a target URL from HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (either case) and NO_PROXY;
 * loopback targets never use one.
 * @returns {URL|null}
 */
function proxyFor(target, env = process.env) {
  const e = env || {};
  if (isLoopbackHost(target.hostname)) return null;
  const port = target.port || (target.protocol === 'https:' ? 443 : 80);
  if (noProxyMatches(e.NO_PROXY || e.no_proxy || '', target.hostname, port)) return null;
  const raw =
    target.protocol === 'https:'
      ? e.HTTPS_PROXY || e.https_proxy || e.ALL_PROXY || e.all_proxy
      : e.HTTP_PROXY || e.http_proxy || e.ALL_PROXY || e.all_proxy;
  if (!raw || !str(raw).trim()) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function proxyAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) return null;
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function decodeBody(buf, encoding) {
  const enc = str(encoding).toLowerCase().trim();
  if (!buf.length || !enc || enc === 'identity') return buf;
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch (err) {
    throw new JiraError(`Could not decode Jira's ${enc} response: ${err.message}`, { code: 'BAD_RESPONSE' });
  }
  return buf;
}

/**
 * One HTTP exchange (no redirects). Resolves {status, headers, body:Buffer}.
 * @private
 */
function sendOnce(u, { method, headers, body, timeoutMs, signal, ca, lookup, env }) {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === 'https:';
    const proxy = proxyFor(u, env);
    let req = null;
    let tunnelReq = null;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(v);
    };
    const destroyAll = (e) => {
      for (const r of [req, tunnelReq]) {
        try {
          if (r) r.destroy(e);
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      const e = new JiraError(`Jira (${u.host}) did not answer within ${Math.round(timeoutMs / 1000)} s.`, {
        code: 'ETIMEDOUT',
        hint: 'Check the Jira URL and your network or VPN, then try again.',
      });
      finish(reject, e);
      destroyAll(e);
    }, timeoutMs);
    const onAbort = () => {
      const e = abortError(signal);
      finish(reject, e);
      destroyAll(e);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const netError = (err) => {
      if (settled) return;
      const code = err && err.code;
      let hint = 'Check the Jira URL and your network or VPN, then try again.';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') hint = `The host name ${u.hostname} could not be resolved: check the Jira URL (or your VPN).`;
      else if (code === 'ECONNREFUSED') hint = `Nothing answered on ${u.host}: check the Jira URL and port.`;
      else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(str(code))) hint = 'The server\'s TLS certificate is not trusted: if your company uses its own CA, point NODE_EXTRA_CA_CERTS at it and restart.';
      finish(reject, new JiraError(`Could not reach Jira at ${u.host}: ${(err && err.message) || err}`, { code: code || 'ENETWORK', hint }));
    };
    const onResponse = (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > MAX_RESPONSE_BYTES) {
          const e = new JiraError('Jira sent a response larger than 32 MB.', { code: 'TOO_LARGE' });
          finish(reject, e);
          destroyAll(e);
          return;
        }
        chunks.push(d);
      });
      res.on('error', netError);
      res.on('end', () => {
        if (settled) return;
        let buf;
        try {
          buf = decodeBody(Buffer.concat(chunks), res.headers['content-encoding']);
        } catch (err) {
          finish(reject, err);
          return;
        }
        finish(resolve, { status: res.statusCode, headers: res.headers, body: buf });
      });
    };
    const start = (createConnection) => {
      const port = u.port || (isHttps ? 443 : 80);
      const opts = {
        method,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port,
        path: `${u.pathname}${u.search}`,
        headers: { ...headers, Host: u.host },
        agent: false,
      };
      if (lookup) opts.lookup = lookup;
      let mod = isHttps ? https : http;
      if (createConnection) {
        delete opts.agent;
        opts.createConnection = createConnection;
        mod = http;
      } else if (proxy && !isHttps) {
        opts.hostname = proxy.hostname;
        opts.port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);
        opts.path = u.href;
        const pa = proxyAuthHeader(proxy);
        if (pa) opts.headers['Proxy-Authorization'] = pa;
        mod = proxy.protocol === 'https:' ? https : http;
      } else if (isHttps) {
        if (ca) opts.ca = ca;
        if (!net.isIP(opts.hostname)) opts.servername = opts.hostname;
      }
      try {
        req = mod.request(opts, onResponse);
      } catch (err) {
        netError(err);
        return;
      }
      req.on('error', netError);
      if (body) req.write(body);
      req.end();
    };
    if (proxy && isHttps) {
      const port = u.port || 443;
      const target = `${u.hostname.replace(/^\[|\]$/g, '')}:${port}`;
      const ph = { Host: target };
      const pa = proxyAuthHeader(proxy);
      if (pa) ph['Proxy-Authorization'] = pa;
      const pmod = proxy.protocol === 'https:' ? https : http;
      try {
        tunnelReq = pmod.request({ hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: target, headers: ph, agent: false, ...(lookup ? { lookup } : {}) });
      } catch (err) {
        netError(err);
        return;
      }
      tunnelReq.on('error', (err) => netError(Object.assign(err, { message: `proxy ${proxy.host}: ${err.message}` })));
      tunnelReq.on('connect', (res, socket) => {
        if (settled) {
          socket.destroy();
          return;
        }
        if (res.statusCode !== 200) {
          socket.destroy();
          finish(reject, new JiraError(`The proxy ${proxy.host} refused to connect to ${u.host} (HTTP ${res.statusCode}).`, { code: 'PROXY', hint: 'Check HTTPS_PROXY / NO_PROXY, or ask your network admin to allow the Jira site.' }));
          return;
        }
        const host = u.hostname.replace(/^\[|\]$/g, '');
        const secure = tls.connect({ socket, host, servername: net.isIP(host) ? undefined : host, ca, ALPNProtocols: ['http/1.1'] });
        secure.once('error', netError);
        secure.once('secureConnect', () => start(() => secure));
      });
      tunnelReq.end();
      return;
    }
    start(null);
  });
}

/**
 * HTTP request with same-site redirects only.
 * @returns {Promise<{status:number, headers:object, body:Buffer, url:URL}>}
 */
async function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal, ca, lookup, env = process.env, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = url instanceof URL ? url : new URL(url);
  for (let hop = 0; ; hop += 1) {
    const res = await sendOnce(current, { method, headers, body, timeoutMs, signal, ca, lookup, env });
    if (![301, 302, 303, 307, 308].includes(res.status) || !res.headers.location) return { ...res, url: current };
    let next;
    try {
      next = new URL(res.headers.location, current);
    } catch {
      return { ...res, url: current };
    }
    const upgrade = current.protocol === 'http:' && next.protocol === 'https:' && next.hostname === current.hostname && (!next.port || next.port === '443') && (!current.port || current.port === '80');
    if (next.origin !== current.origin && !upgrade) {
      throw new JiraError(`Jira redirected to ${next.origin}${next.pathname === '/' ? '' : next.pathname}, a different site, so the request was stopped (credentials are never sent to another site).`, {
        status: res.status,
        code: 'REDIRECT',
        hint: 'If your Jira moved, set its new address with `anywhere jira setup`. If that is a single sign-on page, use an API token (Jira Cloud) or a personal access token (Data Center) instead.',
      });
    }
    if (hop >= maxRedirects) throw new JiraError(`Jira redirected too many times (last: ${next.pathname}).`, { status: res.status, code: 'REDIRECT', hint: 'Check the Jira URL.' });
    if (method !== 'GET' && method !== 'HEAD' && res.status !== 307 && res.status !== 308) {
      throw new JiraError(`Jira redirected the ${method} request to ${next.pathname}, which would drop its data.`, { status: res.status, code: 'REDIRECT', hint: 'Check the Jira URL (it may need https:// or a different path).' });
    }
    current = next;
  }
}

// ---------------------------------------------------------------- normalizers

function normUser(u) {
  if (!isObj(u)) return null;
  const out = { displayName: str(u.displayName || u.name || u.accountId) || null, email: u.emailAddress || null };
  if (u.accountId) out.accountId = u.accountId;
  if (u.name && !u.accountId) out.name = u.name;
  if (u.key && !u.accountId) out.key = u.key;
  if (typeof u.active === 'boolean') out.active = u.active;
  if (u.timeZone) out.timeZone = u.timeZone;
  return out;
}

function userLabel(u) {
  if (!u) return 'Unassigned';
  return u.displayName || u.email || u.accountId || u.name || 'someone';
}

function statusOf(s) {
  if (!isObj(s)) return null;
  const cat = isObj(s.statusCategory) ? s.statusCategory : {};
  return { name: str(s.name), category: str(cat.name) || null, categoryKey: str(cat.key) || null };
}

function formatWhen(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return str(v);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function humanSize(n) {
  const b = Number(n);
  if (!Number.isFinite(b)) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 102.4) / 10} KB`;
  return `${Math.round(b / (1024 * 104.8576)) / 10} MB`;
}

function capText(md, max = MAX_TEXT_CHARS) {
  const s = str(md);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n… (truncated: ${s.length - max} more characters; open the issue in the browser for the rest)`;
}

function parseSprintString(s) {
  const m = /\[(.*)\]$/.exec(str(s));
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(/,(?=[A-Za-z]+=)/)) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1) === '<null>' ? null : part.slice(eq + 1);
  }
  return out.name ? { id: out.id ? Number(out.id) : null, name: out.name, state: str(out.state).toLowerCase() || null } : null;
}

function pickSprint(value) {
  const list = (Array.isArray(value) ? value : value ? [value] : [])
    .map((v) => (typeof v === 'string' ? parseSprintString(v) : isObj(v) ? { id: v.id == null ? null : v.id, name: str(v.name), state: str(v.state).toLowerCase() || null } : null))
    .filter((v) => v && v.name);
  if (!list.length) return null;
  return list.find((s) => s.state === 'active') || list.find((s) => s.state === 'future') || list[list.length - 1];
}

function fieldIdsByName(names, regexes) {
  if (!isObj(names)) return [];
  const ids = [];
  for (const re of regexes) for (const [id, name] of Object.entries(names)) if (re.test(str(name)) && !ids.includes(id)) ids.push(id);
  return ids;
}

const STORY_POINT_NAMES = [/^story points?$/i, /^story point estimate$/i, /^story points? estimate$/i];
const SPRINT_NAMES = [/^sprint$/i];
const AC_NAMES = [/acceptance\s*criteria/i];
const EPIC_LINK_NAMES = [/^epic link$/i];
const EXTRA_TEXT_NAMES = [/^steps to reproduce$/i, /^expected (result|behaviou?r)s?$/i, /^actual (result|behaviou?r)s?$/i, /^definition of done$/i];
const FALLBACK_IDS = { sprint: ['customfield_10020'], storyPoints: ['customfield_10016', 'customfield_10026', 'customfield_10028', 'customfield_10002'] };

function richToMarkdown(value, deployment) {
  if (value == null) return '';
  if (typeof value === 'string') return deployment === 'Server' ? wikiToMarkdown(value) : value.trim();
  if (isAdf(value)) return adfToMarkdown(value);
  if (Array.isArray(value)) return value.map((v) => richToMarkdown(v, deployment)).filter(Boolean).join(', ');
  if (isObj(value)) return str(value.value || value.name || value.displayName || '');
  return str(value);
}

function issueRow(raw, baseUrl) {
  const f = (raw && raw.fields) || {};
  return {
    key: raw.key,
    summary: str(f.summary),
    status: statusOf(f.status),
    type: f.issuetype ? str(f.issuetype.name) : null,
    priority: f.priority ? str(f.priority.name) : null,
    assignee: normUser(f.assignee),
    updated: f.updated || null,
    url: baseUrl ? `${baseUrl}/browse/${raw.key}` : null,
  };
}

function linkRow(l) {
  const other = l.outwardIssue || l.inwardIssue;
  if (!other) return null;
  const type = l.type || {};
  const relation = l.outwardIssue ? str(type.outward || type.name) : str(type.inward || type.name);
  const f = other.fields || {};
  return { relation: relation || 'relates to', key: other.key, summary: str(f.summary), status: f.status ? str(f.status.name) : null };
}

/**
 * Compact issue object from a REST issue (fields=*all, expand=names).
 * @param {object} raw
 * @param {{baseUrl:string, deployment:'Cloud'|'Server', comments?:object[], commentsTotal?:number}} ctx
 */
function buildIssue(raw, { baseUrl, deployment, comments, commentsTotal } = {}) {
  const f = (raw && raw.fields) || {};
  const names = (raw && raw.names) || {};
  const dep = deployment || 'Cloud';
  const firstValue = (ids) => {
    for (const id of ids) {
      const v = f[id];
      if (v != null && !(Array.isArray(v) && !v.length) && v !== '') return v;
    }
    return null;
  };
  const sprintIds = fieldIdsByName(names, SPRINT_NAMES);
  const spIds = fieldIdsByName(names, STORY_POINT_NAMES);
  // Field ids differ per site, so they come from the names (expand=names); the usual Cloud ids are
  // only a guess when Jira sent no names.
  const noNames = !Object.keys(names).length;
  const sprint = pickSprint(firstValue(sprintIds.length ? sprintIds : noNames ? FALLBACK_IDS.sprint : []));
  let storyPoints = firstValue(spIds);
  if (storyPoints == null && noNames) {
    const v = firstValue(FALLBACK_IDS.storyPoints);
    storyPoints = typeof v === 'number' ? v : null;
  }
  if (storyPoints != null && typeof storyPoints !== 'number') storyPoints = Number(storyPoints) || null;
  const acId = fieldIdsByName(names, AC_NAMES).find((id) => f[id] != null && f[id] !== '');
  const acceptanceCriteria = acId ? capText(richToMarkdown(f[acId], dep)) || null : null;
  const extraFields = [];
  for (const id of fieldIdsByName(names, EXTRA_TEXT_NAMES)) {
    const md = richToMarkdown(f[id], dep);
    if (md) extraFields.push({ name: str(names[id]), markdown: capText(md, 20000) });
  }
  if (f.environment) {
    const md = richToMarkdown(f.environment, dep);
    if (md) extraFields.push({ name: 'Environment', markdown: capText(md, 20000) });
  }
  let parent = null;
  if (isObj(f.parent)) {
    const pf = f.parent.fields || {};
    parent = { key: f.parent.key, summary: str(pf.summary), type: pf.issuetype ? str(pf.issuetype.name) : null, status: pf.status ? str(pf.status.name) : null };
  } else {
    const epicId = fieldIdsByName(names, EPIC_LINK_NAMES).find((id) => typeof f[id] === 'string' && f[id]);
    if (epicId) parent = { key: f[epicId], summary: '', type: 'Epic', status: null };
  }
  const allComments = Array.isArray(comments) ? comments : f.comment && Array.isArray(f.comment.comments) ? f.comment.comments : [];
  const total = Number.isFinite(commentsTotal) ? commentsTotal : f.comment && Number.isFinite(f.comment.total) ? f.comment.total : allComments.length;
  const shown = allComments.slice(-COMMENTS_SHOWN).map((c) => ({
    id: c.id,
    author: userLabel(normUser(c.author)),
    created: c.created || null,
    updated: c.updated && c.updated !== c.created ? c.updated : null,
    body: capText(richToMarkdown(c.body, dep), 8000),
  }));
  const issue = {
    key: raw.key,
    id: raw.id || null,
    url: baseUrl ? `${baseUrl}/browse/${raw.key}` : null,
    summary: str(f.summary),
    status: statusOf(f.status),
    type: f.issuetype ? str(f.issuetype.name) : null,
    priority: f.priority ? str(f.priority.name) : null,
    assignee: normUser(f.assignee),
    reporter: normUser(f.reporter),
    labels: Array.isArray(f.labels) ? f.labels.map(str) : [],
    components: Array.isArray(f.components) ? f.components.map((c) => str(c && c.name)).filter(Boolean) : [],
    fixVersions: Array.isArray(f.fixVersions) ? f.fixVersions.map((v) => str(v && v.name)).filter(Boolean) : [],
    parent,
    sprint,
    storyPoints: storyPoints == null ? null : storyPoints,
    created: f.created || null,
    updated: f.updated || null,
    description: capText(richToMarkdown(f.description, dep)),
    acceptanceCriteria,
    extraFields,
    subtasks: Array.isArray(f.subtasks) ? f.subtasks.map((s) => ({ key: s.key, summary: str(s.fields && s.fields.summary), status: s.fields && s.fields.status ? str(s.fields.status.name) : null })) : [],
    links: Array.isArray(f.issuelinks) ? f.issuelinks.map(linkRow).filter(Boolean) : [],
    attachments: Array.isArray(f.attachment)
      ? f.attachment.map((a) => ({ filename: str(a.filename), url: a.content || null, size: Number.isFinite(a.size) ? a.size : null, mimeType: a.mimeType || null }))
      : [],
    comments: shown,
    commentsTotal: total,
    branchName: branchName(raw.key, f.summary),
    deployment: dep,
  };
  issue.markdown = issueMarkdown(issue);
  return issue;
}

/** Push Markdown headings down `by` levels (outside code fences) so they nest under a section. */
function demoteHeadings(md, by = 2) {
  let fence = null;
  return str(md)
    .split('\n')
    .map((line) => {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (!fence) fence = f[1];
        else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        return line;
      }
      if (fence) return line;
      return line.replace(/^(#{1,6})(?=\s)/, (h) => '#'.repeat(Math.min(6, h.length + by)));
    })
    .join('\n');
}

/** Markdown rendering of a buildIssue() object, for the model and the terminal. */
function issueMarkdown(issue) {
  const facts = (pairs) =>
    pairs
      .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `**${k}:** ${Array.isArray(v) ? v.join(', ') : v}`)
      .join(' · ');
  const st = issue.status ? `${issue.status.name}${issue.status.category && issue.status.category !== issue.status.name ? ` (${issue.status.category})` : ''}` : null;
  const lines = [`# ${issue.key}: ${issue.summary || '(no summary)'}`, ''];
  const rows = [
    facts([['Type', issue.type], ['Status', st], ['Priority', issue.priority]]),
    facts([['Assignee', issue.assignee ? userLabel(issue.assignee) : 'Unassigned'], ['Reporter', issue.reporter ? userLabel(issue.reporter) : null]]),
    facts([['Sprint', issue.sprint ? `${issue.sprint.name}${issue.sprint.state ? ` (${issue.sprint.state})` : ''}` : null], ['Story points', issue.storyPoints]]),
    facts([['Labels', issue.labels], ['Components', issue.components], ['Fix versions', issue.fixVersions]]),
    issue.parent ? `**Parent:** ${issue.parent.key}${issue.parent.type ? ` (${issue.parent.type})` : ''}${issue.parent.summary ? `: ${issue.parent.summary}` : ''}` : '',
    facts([['Created', formatWhen(issue.created)], ['Updated', formatWhen(issue.updated)]]),
    issue.url ? `**Link:** ${issue.url}` : '',
    `**Suggested branch:** \`${issue.branchName}\``,
  ].filter(Boolean);
  lines.push(rows.join('  \n'), '');
  lines.push('## Description', '', demoteHeadings(issue.description) || '_No description._', '');
  if (issue.acceptanceCriteria) lines.push('## Acceptance criteria', '', demoteHeadings(issue.acceptanceCriteria), '');
  for (const x of issue.extraFields || []) lines.push(`## ${x.name}`, '', demoteHeadings(x.markdown), '');
  if (issue.subtasks.length) {
    lines.push('## Subtasks', '');
    for (const s of issue.subtasks) lines.push(`- ${s.key}${s.status ? ` [${s.status}]` : ''}: ${s.summary}`);
    lines.push('');
  }
  if (issue.links.length) {
    lines.push('## Linked issues', '');
    for (const l of issue.links) lines.push(`- ${l.relation} ${l.key}${l.status ? ` [${l.status}]` : ''}: ${l.summary}`);
    lines.push('');
  }
  if (issue.attachments.length) {
    lines.push('## Attachments', '');
    for (const a of issue.attachments) {
      const meta = [a.mimeType, humanSize(a.size)].filter(Boolean).join(', ');
      lines.push(`- ${a.filename}${meta ? ` (${meta})` : ''}${a.url ? `: ${a.url}` : ''}`);
    }
    lines.push('');
  }
  if (issue.comments.length) {
    const label = issue.commentsTotal > issue.comments.length ? `last ${issue.comments.length} of ${issue.commentsTotal}` : `${issue.comments.length}`;
    lines.push(`## Comments (${label})`, '');
    for (const c of issue.comments) {
      lines.push(`**${c.author}** · ${formatWhen(c.created)}${c.updated ? ` (edited ${formatWhen(c.updated)})` : ''}`, '', quoteLines(demoteHeadings(c.body) || '_(empty)_'), '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** One line per issue for search results. */
function issueListMarkdown(rows) {
  return rows
    .map((r) => {
      const meta = [r.type, r.priority, r.assignee ? userLabel(r.assignee) : 'Unassigned'].filter(Boolean).join(' · ');
      return `- ${r.key} [${r.status ? r.status.name : '?'}] ${r.summary}${meta ? ` (${meta})` : ''}`;
    })
    .join('\n');
}

/**
 * Text for a search() result: a count line with the JQL, an optional note, then one line per issue.
 * @param {{jql:string, issues:object[], total:number|null, more?:boolean, note?:string}} r
 */
function searchResultText(r) {
  const n = r.issues.length;
  let head;
  if (!n) head = `No issues match: ${r.jql}`;
  else {
    const count = r.total != null ? r.total : n;
    const plus = r.total == null && r.more ? '+' : '';
    const showing = (r.total != null && r.total > n) || (r.total == null && r.more) ? ` (showing ${n})` : '';
    head = `${count}${plus} ${count === 1 && !plus ? 'issue matches' : 'issues match'}${showing}: ${r.jql}`;
  }
  const parts = [head];
  if (r.note) parts.push(r.note);
  if (n) parts.push('', issueListMarkdown(r.issues));
  return parts.join('\n');
}

function transitionRow(t) {
  const to = t.to || {};
  const cat = isObj(to.statusCategory) ? to.statusCategory : {};
  return { id: str(t.id), name: str(t.name), to: { name: str(to.name), category: str(cat.name) || null, categoryKey: str(cat.key) || null }, hasScreen: Boolean(t.hasScreen) };
}

function normName(s) {
  return str(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function squash(s) {
  return str(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const CATEGORY_WORDS = {
  done: ['done', 'complete', 'completed', 'finish', 'finished', 'close', 'closed', 'resolve', 'resolved'],
  indeterminate: ['inprogress', 'start', 'started', 'startprogress', 'begin', 'doing', 'wip', 'working'],
  new: ['todo', 'backlog', 'open', 'reopen', 'reopened', 'notstarted', 'stopprogress'],
};

/**
 * Pick the transition for "to" (a target status or a transition name, case-insensitive).
 * @param {{id,name,to:{name,categoryKey}}[]} list
 * @param {string} to
 * @returns {{match?:object, ambiguous?:object[]}}
 */
function pickTransition(list, to) {
  const want = normName(to);
  const flat = squash(to);
  if (!want) return {};
  let hits = list.filter((t) => normName(t.name) === want);
  if (hits.length) return { match: hits[0] };
  hits = list.filter((t) => normName(t.to.name) === want);
  if (hits.length) return { match: hits[0] };
  hits = list.filter((t) => squash(t.name) === flat || squash(t.to.name) === flat);
  if (hits.length) return { match: hits[0] };
  if (flat.length >= 3) {
    hits = list.filter((t) => squash(t.name).includes(flat) || squash(t.to.name).includes(flat) || (squash(t.to.name).length >= 3 && flat.includes(squash(t.to.name))));
    const byStatus = [...new Map(hits.map((t) => [squash(t.to.name), t])).values()];
    if (byStatus.length === 1) return { match: byStatus[0] };
    if (byStatus.length > 1) return { ambiguous: byStatus };
  }
  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    if (!words.includes(flat)) continue;
    const inCat = list.filter((t) => t.to.categoryKey === cat);
    const byStatus = [...new Map(inCat.map((t) => [squash(t.to.name), t])).values()];
    if (byStatus.length === 1) return { match: byStatus[0] };
    if (byStatus.length > 1) return { ambiguous: byStatus };
  }
  return {};
}

// Classic ids are 24 characters (Atlassian's own examples are not always hex: 5b10a2844c20165700ede21g);
// newer ones are "<number>:<uuid>".
const ACCOUNT_ID_RE = /^(?:(?=[a-z]*\d)[0-9a-z]{24}|\d{1,10}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Does this look like a Jira Cloud accountId? */
function looksLikeAccountId(s) {
  return ACCOUNT_ID_RE.test(str(s).trim());
}

/**
 * Choose one user for `query` among candidates: exact email, accountId or username, exact display
 * name, then a single candidate.
 * @returns {{user?:object, ambiguous?:object[]}}
 */
function pickUser(candidates, query) {
  const q = normName(query);
  const list = candidates.filter((u) => u && u.active !== false);
  if (!list.length) return {};
  const exactId = list.filter((u) => [u.email, u.accountId, u.name, u.key].some((v) => v && normName(v) === q));
  if (exactId.length === 1) return { user: exactId[0] };
  const exactName = list.filter((u) => normName(u.displayName) === q);
  if (exactName.length === 1) return { user: exactName[0] };
  if (exactName.length > 1) return { ambiguous: exactName };
  if (list.length === 1) return { user: list[0] };
  const words = q.split(' ').filter(Boolean);
  const wordHits = list.filter((u) => {
    const dn = normName(u.displayName).split(' ');
    return words.every((w) => dn.some((d) => d.startsWith(w)));
  });
  if (wordHits.length === 1) return { user: wordHits[0] };
  return { ambiguous: wordHits.length ? wordHits : list };
}

function describeUser(u) {
  const bits = [u.displayName || u.name || u.accountId];
  if (u.email) bits.push(`<${u.email}>`);
  if (u.accountId) bits.push(`accountId ${u.accountId}`);
  else if (u.name) bits.push(`username ${u.name}`);
  return bits.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- client

const detectCache = new Map();

function detectKey(baseUrl, email, token) {
  return `${baseUrl}\n${email}\n${crypto.createHash('sha256').update(str(token)).digest('hex').slice(0, 16)}`;
}

function normalizeDeployment(d) {
  const s = str(d).toLowerCase();
  if (s === 'cloud') return 'Cloud';
  if (s === 'server' || s === 'datacenter' || s === 'data center' || s === 'dc') return 'Server';
  return null;
}

class JiraClient {
  /**
   * @param {{baseUrl:string, email?:string, apiToken:string, deployment?:'Cloud'|'Server',
   *   timeoutMs?:number, env?:object, ca?:string|Buffer, lookup?:Function}} opts
   *   ca / lookup: custom CA and DNS lookup (company CAs can also come from NODE_EXTRA_CA_CERTS)
   */
  constructor(opts = {}) {
    const token = str(opts.apiToken).trim();
    if (!str(opts.baseUrl).trim() || !token) throw new JiraError(NOT_CONNECTED, { code: 'NOT_CONFIGURED' });
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.email = str(opts.email).trim();
    Object.defineProperty(this, 'apiToken', { value: token, enumerable: false });
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.env = opts.env || process.env;
    this.ca = opts.ca;
    this.lookup = opts.lookup;
    this.forced = normalizeDeployment(opts.deployment);
    this.host = new URL(this.baseUrl).hostname;
    this._deployment = null;
    this._scheme = null;
    this._info = null;
    this._me = null;
  }

  [util.inspect.custom]() {
    return `JiraClient { baseUrl: '${this.baseUrl}', email: '${this.email}', apiToken: '***' }`;
  }

  toJSON() {
    return { baseUrl: this.baseUrl, email: this.email, apiToken: '***' };
  }

  /** Replace the token (and its Basic form) in text that may echo it. @private */
  scrub(text) {
    let s = str(text);
    const secrets = [this.apiToken, Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')].filter((x) => x && x.length >= 4);
    for (const sec of secrets) s = s.split(sec).join('***');
    return s;
  }

  /** @private */
  authHeader(scheme) {
    if (scheme === 'none') return {};
    if (scheme === 'bearer') return { Authorization: `Bearer ${this.apiToken}` };
    return { Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')}` };
  }

  /** @private */
  defaultScheme() {
    if (this._scheme) return this._scheme;
    if (this._deployment === 'Cloud' || (!this._deployment && isCloudHost(this.host))) return 'basic';
    return 'bearer';
  }

  /** @private */
  hintFor(status, res, apiPath) {
    const cloud = this._deployment === 'Cloud' || isCloudHost(this.host);
    const reason = str(res && res.headers && res.headers['x-seraph-loginreason']);
    if ((status === 401 || status === 403) && /AUTHENTICATION_DENIED/i.test(reason)) {
      return 'Jira wants a CAPTCHA after failed sign-ins: sign in once in the browser, then try again.';
    }
    if (status === 401) {
      return cloud
        ? `Check the email and API token (create a free token at ${TOKEN_PAGE}), then run \`anywhere jira setup\`.`
        : `Check the personal access token (Jira → Profile → Personal Access Tokens: ${this.baseUrl}${SERVER_TOKEN_PATH}), then run \`anywhere jira setup\`.`;
    }
    if (status === 403) return 'This Jira account is not allowed to do that (project permissions), or the token lacks access.';
    if (status === 404) {
      if (/\/issue\//.test(apiPath)) return 'The issue does not exist, or this Jira account cannot see it.';
      return 'Check the Jira URL (the site root, e.g. https://yourcompany.atlassian.net).';
    }
    if (status === 429) return 'Jira is rate-limiting requests: wait a minute and try again.';
    if (status >= 500) return 'Jira had a server error: try again in a moment.';
    return undefined;
  }

  /**
   * One REST call. Returns parsed JSON, or null for an empty answer (204).
   * @param {string} method
   * @param {string} apiPath path under the base URL, e.g. /rest/api/3/myself
   * @param {{query?:object, body?:any, signal?:AbortSignal, scheme?:'basic'|'bearer'|'none'}} [opts]
   */
  async request(method, apiPath, { query, body, signal, scheme } = {}) {
    const url = new URL(this.baseUrl + apiPath);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let payload = null;
    const baseHeaders = { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate', 'User-Agent': USER_AGENT, 'X-Atlassian-Token': 'no-check' };
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      baseHeaders['Content-Type'] = 'application/json; charset=utf-8';
      baseHeaders['Content-Length'] = String(payload.length);
    }
    let useScheme = scheme || this.defaultScheme();
    let triedBasic = useScheme === 'basic';
    for (let attempt = 0; ; attempt += 1) {
      const headers = { ...baseHeaders, ...this.authHeader(useScheme) };
      const res = await httpRequest(url, { method, headers, body: payload, timeoutMs: this.timeoutMs, signal, ca: this.ca, lookup: this.lookup, env: this.env });
      const status = res.status;
      if ((status === 429 || (status === 503 && method === 'GET')) && attempt < 2) {
        const ra = Number(res.headers['retry-after']);
        await sleep(Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, MAX_RETRY_WAIT_MS) : 1000 * (attempt + 1), signal);
        continue;
      }
      // Server/Data Center without personal access tokens: fall back to username:password once.
      if (status === 401 && !scheme && useScheme === 'bearer' && !triedBasic && this.email) {
        useScheme = 'basic';
        triedBasic = true;
        continue;
      }
      if (status >= 200 && status < 300) {
        if (!scheme && useScheme !== 'none' && this._deployment !== 'Cloud') this._scheme = useScheme;
        return this.parse(res, method, apiPath);
      }
      throw this.errorFrom(res, method, apiPath);
    }
  }

  /** @private */
  parse(res, method, apiPath) {
    const text = res.body.toString('utf8');
    if (res.status === 204 || !text.trim()) return null;
    const ct = str(res.headers['content-type']).toLowerCase();
    if (ct.includes('json') || /^\s*[[{]/.test(text)) {
      try {
        return JSON.parse(text);
      } catch {
        throw new JiraError(`Jira sent invalid JSON for ${method} ${apiPath}.`, { status: res.status, code: 'BAD_RESPONSE' });
      }
    }
    throw new JiraError(`Jira answered ${method} ${apiPath} with a web page instead of data (HTTP ${res.status}).`, {
      status: res.status,
      code: 'NOT_JSON',
      hint: 'The Jira URL may be wrong (use the site root), or a sign-in page or proxy is in the way.',
    });
  }

  /** @private */
  errorFrom(res, method, apiPath) {
    const status = res.status;
    const messages = [];
    const text = res.body.toString('utf8');
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data.errorMessages)) messages.push(...data.errorMessages.map(str).filter(Boolean));
      if (isObj(data.errors)) for (const [k, v] of Object.entries(data.errors)) messages.push(`${k}: ${str(v)}`);
      if (typeof data.message === 'string' && data.message) messages.push(data.message);
      if (typeof data.errorMessage === 'string' && data.errorMessage) messages.push(data.errorMessage);
    } catch {
      const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain && !/^<!doctype|<html/i.test(text.trim())) messages.push(oneLine(plain, 200));
    }
    const pathOnly = apiPath.split('?')[0];
    const detail = messages.length ? `: ${messages.map((m) => oneLine(m, 400)).join('; ')}` : '';
    const msg = this.scrub(`Jira ${method} ${pathOnly} failed with HTTP ${status}${detail}`);
    return new JiraError(msg, { status, code: status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', hint: this.hintFor(status, res, apiPath), messages: messages.map((m) => this.scrub(m)) });
  }

  /**
   * 'Cloud' or 'Server' (Server covers Data Center): from the host name, else /rest/api/2/serverInfo.
   * @param {{signal?:AbortSignal}} [opts]
   */
  async deployment({ signal } = {}) {
    if (this._deployment) return this._deployment;
    if (this.forced) return (this._deployment = this.forced);
    if (isCloudHost(this.host)) return (this._deployment = 'Cloud');
    const key = detectKey(this.baseUrl, this.email, this.apiToken);
    const hit = detectCache.get(key);
    if (hit && Date.now() - hit.at < DETECT_TTL_MS) {
      this._scheme = hit.scheme;
      this._info = hit.info;
      return (this._deployment = hit.deployment);
    }
    let info = null;
    let scheme = null;
    try {
      info = await this.request('GET', '/rest/api/2/serverInfo', { signal, scheme: 'none' });
    } catch (err) {
      if (!err || ![401, 403, 404].includes(err.status)) throw err;
    }
    if (!isObj(info) || !info.deploymentType) {
      // Anonymous access is off: personal access token first (no failed password logins), then email/username + token.
      let last = null;
      info = null;
      for (const s of this.email ? ['bearer', 'basic'] : ['bearer']) {
        try {
          info = await this.request('GET', '/rest/api/2/serverInfo', { signal, scheme: s });
          scheme = s;
          break;
        } catch (err) {
          if (!err || (err.status !== 401 && err.status !== 403)) throw err;
          last = err;
        }
      }
      if (!info && last) throw last;
    }
    const dep = /cloud/i.test(str(info && info.deploymentType)) ? 'Cloud' : 'Server';
    this._deployment = dep;
    this._info = isObj(info) ? { serverTitle: info.serverTitle || null, version: info.version || null, deploymentType: info.deploymentType || null } : null;
    if (dep === 'Cloud') this._scheme = 'basic';
    else if (scheme) this._scheme = scheme;
    detectCache.set(key, { deployment: dep, scheme: this._scheme, info: this._info, at: Date.now() });
    return dep;
  }

  /** REST API version for this deployment: 3 on Cloud, 2 on Server/Data Center. */
  async api(path, opts) {
    const dep = await this.deployment(opts);
    if (dep === 'Cloud' && !this.email) {
      throw new JiraError('Jira Cloud needs the email address of the account the API token belongs to.', { code: 'NOT_CONFIGURED', hint: 'Run `anywhere jira setup` and enter the email.' });
    }
    return `/rest/api/${dep === 'Cloud' ? 3 : 2}${path}`;
  }

  /** The connected account. */
  async myself({ signal } = {}) {
    const data = await this.request('GET', await this.api('/myself', { signal }), { signal });
    this._me = normUser(data);
    return this._me;
  }

  /** Check the connection: {ok, deployment, user, baseUrl, serverTitle?, version?}. */
  async testConnection({ signal } = {}) {
    const deployment = await this.deployment({ signal });
    const user = await this.myself({ signal });
    const out = { ok: true, deployment, baseUrl: this.baseUrl, user: { displayName: user.displayName, email: user.email, accountId: user.accountId || user.name || null } };
    if (this._info && this._info.serverTitle) out.serverTitle = this._info.serverTitle;
    if (this._info && this._info.version) out.version = this._info.version;
    return out;
  }

  /**
   * An issue with everything needed to work on it, plus its Markdown rendering (`.markdown`).
   * @param {string} keyOrUrl
   */
  async getIssue(keyOrUrl, { signal } = {}) {
    const key = requireKey(keyOrUrl);
    const base = await this.api(`/issue/${encodeURIComponent(key)}`, { signal });
    const raw = await this.request('GET', base, { query: { fields: '*all', expand: 'names' }, signal });
    const f = (raw && raw.fields) || {};
    let comments = null;
    let total;
    const c = f.comment;
    if (c && Number.isFinite(c.total) && Array.isArray(c.comments) && c.total > c.comments.length) {
      try {
        const startAt = Math.max(0, c.total - COMMENTS_SHOWN);
        const page = await this.request('GET', `${base}/comment`, { query: { startAt, maxResults: COMMENTS_SHOWN }, signal });
        if (page && Array.isArray(page.comments)) {
          comments = page.comments;
          total = Number.isFinite(page.total) ? page.total : c.total;
        }
      } catch (err) {
        if (err && err.code === 'ABORTED') throw err;
        /* keep the comments that came with the issue */
      }
    }
    return buildIssue(raw, { baseUrl: this.baseUrl, deployment: this._deployment, comments, commentsTotal: total });
  }

  /**
   * Search with JQL: /rest/api/3/search/jql on Cloud (falls back to /rest/api/2/search), /rest/api/2/search on Server.
   * @returns {{jql:string, issues:object[], total:number|null, endpoint:string, note?:string}}
   */
  async search(jql, max, { signal } = {}) {
    const q = str(jql).trim();
    if (!q) throw new JiraError('The JQL query is empty.', { code: 'BAD_JQL' });
    const limit = clampInt(max, 1, SEARCH_MAX, SEARCH_DEFAULT);
    const fields = 'summary,status,issuetype,priority,assignee,updated';
    const dep = await this.deployment({ signal });
    const run = async (text) => {
      if (dep === 'Cloud') {
        try {
          const data = await this.request('GET', '/rest/api/3/search/jql', { query: { jql: text, maxResults: limit, fields }, signal });
          return { data, endpoint: '/rest/api/3/search/jql' };
        } catch (err) {
          if (!err || ![404, 405, 410].includes(err.status)) throw err;
        }
      }
      const data = await this.request('GET', '/rest/api/2/search', { query: { jql: text, maxResults: limit, fields }, signal });
      return { data, endpoint: '/rest/api/2/search' };
    };
    let note;
    let used = q;
    let out;
    try {
      out = await run(q);
    } catch (err) {
      // Jira Cloud's search refuses queries with no restriction: bound it to the last year.
      if (err && err.status === 400 && /unbounded/i.test(err.message)) {
        const { where, order } = splitOrderBy(q);
        used = `${where ? `(${where}) AND ` : ''}updated >= -365d${order ? ` ${order}` : ''}`;
        note = 'Jira Cloud rejects searches without a restriction, so this one is limited to issues updated in the last 365 days.';
        out = await run(used);
      } else throw err;
    }
    const issues = Array.isArray(out.data && out.data.issues) ? out.data.issues.map((r) => issueRow(r, this.baseUrl)) : [];
    const total = out.data && Number.isFinite(out.data.total) ? out.data.total : null;
    const res = { jql: used, issues, total, endpoint: out.endpoint, more: Boolean(out.data && (out.data.nextPageToken || (total != null && total > issues.length))) };
    if (note) res.note = note;
    return res;
  }

  /** Issues assigned to the connected account (status: open (default), todo, in progress, done, all, or a status name). */
  async myIssues(status, { signal, max = 50 } = {}) {
    return this.search(myIssuesJql(status), max, { signal });
  }

  /** Transitions available from the issue's current status. */
  async transitions(keyOrUrl, { signal } = {}) {
    const key = requireKey(keyOrUrl);
    const data = await this.request('GET', await this.api(`/issue/${encodeURIComponent(key)}/transitions`, { signal }), { signal });
    return (data && Array.isArray(data.transitions) ? data.transitions : []).filter((t) => t && t.isAvailable !== false).map(transitionRow);
  }

  /**
   * Move an issue to a status (or through a named transition), case-insensitively.
   * @returns {{key, from:string|null, to:string, transition:string|null, already?:boolean}}
   */
  async transition(keyOrUrl, to, { signal } = {}) {
    const key = requireKey(keyOrUrl);
    const target = str(to).trim();
    if (!target) throw new JiraError('Say which status to move the issue to.', { code: 'BAD_INPUT' });
    const issuePath = await this.api(`/issue/${encodeURIComponent(key)}`, { signal });
    const [list, current] = await Promise.all([
      this.transitions(key, { signal }),
      this.request('GET', issuePath, { query: { fields: 'status' }, signal }).catch((err) => {
        if (err && err.code === 'ABORTED') throw err;
        return null;
      }),
    ]);
    const from = current && current.fields && current.fields.status ? str(current.fields.status.name) : null;
    const pick = pickTransition(list, target);
    if (!pick.match) {
      if (from && (normName(from) === normName(target) || squash(from) === squash(target))) {
        return { key, from, to: from, transition: null, already: true };
      }
      const options = list.map((t) => ({ transition: t.name, to: t.to.name }));
      const listText = options.length ? options.map((o) => (normName(o.transition) === normName(o.to) ? `"${o.to}"` : `"${o.transition}" → ${o.to}`)).join(', ') : 'none (this account may lack the Transition Issues permission)';
      if (pick.ambiguous) {
        throw new JiraError(`"${target}" matches several transitions of ${key}: ${pick.ambiguous.map((t) => `"${t.name}" → ${t.to.name}`).join(', ')}. Say which one.`, { code: 'AMBIGUOUS_TRANSITION', options });
      }
      throw new JiraError(`${key} cannot move to "${target}" from ${from ? `"${from}"` : 'its current status'}. Valid now: ${listText}.`, { code: 'NO_TRANSITION', options });
    }
    try {
      await this.request('POST', `${issuePath}/transitions`, { body: { transition: { id: pick.match.id } }, signal });
    } catch (err) {
      if (err && err.status === 400 && pick.match.hasScreen && !err.hint) {
        err.hint = `The "${pick.match.name}" transition asks for fields on a screen: fill them in Jira in the browser.`;
      }
      throw err;
    }
    return { key, from, to: pick.match.to.name || target, transition: pick.match.name };
  }

  /** Users that can be assigned an issue, matching `query`. @private */
  async assignable(key, query, { signal } = {}) {
    const dep = await this.deployment({ signal });
    const data =
      dep === 'Cloud'
        ? await this.request('GET', '/rest/api/3/user/assignable/search', { query: { issueKey: key, query, maxResults: 20 }, signal })
        : await this.request('GET', '/rest/api/2/user/assignable/search', { query: { issueKey: key, username: query, maxResults: 20 }, signal });
    return (Array.isArray(data) ? data : []).filter((d) => isObj(d) && (!d.accountType || d.accountType === 'atlassian')).map(normUser);
  }

  /**
   * Assign an issue. user: 'me', 'none' (unassign), an email, a Cloud accountId, a username or a
   * display name. Several matching people → JiraError code AMBIGUOUS_USER with .candidates.
   * @returns {{key, assignee:object|null}}
   */
  async assign(keyOrUrl, user, { signal } = {}) {
    const key = requireKey(keyOrUrl);
    const u = str(user).trim();
    if (!u) throw new JiraError('Say who to assign the issue to ("me", a name, an email or an accountId).', { code: 'BAD_INPUT' });
    const dep = await this.deployment({ signal });
    const path = await this.api(`/issue/${encodeURIComponent(key)}/assignee`, { signal });
    let target = null;
    if (/^(none|nobody|no one|unassigned|unassign|null|-)$/i.test(u)) {
      target = null;
    } else if (/^(me|myself|self|i)$/i.test(u)) {
      target = await this.myself({ signal });
    } else if (dep === 'Cloud' && looksLikeAccountId(u)) {
      const info = await this.request('GET', '/rest/api/3/user', { query: { accountId: u }, signal }).catch((err) => {
        if (err && err.code === 'ABORTED') throw err;
        if (err && err.status === 404) throw new JiraError(`No Jira account has the id ${u}.`, { status: 404, code: 'NO_USER', hint: 'Search with jira_find_user to get the right accountId.' });
        return null;
      });
      target = normUser(info) || { displayName: null, email: null, accountId: u };
      if (!target.accountId) target.accountId = u;
    } else {
      let found = await this.assignable(key, u, { signal });
      // "Ankit Verma" may not match as one query on Server: try the first word too.
      if (!found.length && /\s/.test(u)) found = await this.assignable(key, u.split(/\s+/)[0], { signal });
      const pick = pickUser(found, u);
      if (pick.ambiguous) {
        const candidates = pick.ambiguous.slice(0, 10);
        throw new JiraError(`"${u}" matches ${pick.ambiguous.length} people who can be assigned ${key}: ${candidates.map(describeUser).join('; ')}. Ask which one, then assign by email or accountId.`, {
          code: 'AMBIGUOUS_USER',
          candidates,
        });
      }
      if (!pick.user) {
        throw new JiraError(`No one who can be assigned ${key} matches "${u}".`, {
          code: 'NO_USER',
          hint: 'Check the spelling, search with jira_find_user, or the person may not have access to this project.',
        });
      }
      target = pick.user;
    }
    let body;
    if (dep === 'Cloud') body = { accountId: target ? target.accountId || null : null };
    else body = { name: target ? target.name || target.key || null : null };
    if (target && dep === 'Cloud' && !body.accountId) throw new JiraError(`Could not find the Jira account id for ${userLabel(target)}.`, { code: 'NO_USER' });
    if (target && dep !== 'Cloud' && !body.name) throw new JiraError(`Could not find the Jira username for ${userLabel(target)}.`, { code: 'NO_USER' });
    await this.request('PUT', path, { body, signal });
    return { key, assignee: target };
  }

  /**
   * Add a comment written in Markdown (sent as ADF on Cloud, wiki markup on Server).
   * @returns {{key, id:string|null, url:string}}
   */
  async comment(keyOrUrl, markdownText, { signal } = {}) {
    const key = requireKey(keyOrUrl);
    const text = str(markdownText);
    if (!text.trim()) throw new JiraError('The comment is empty.', { code: 'BAD_INPUT' });
    const dep = await this.deployment({ signal });
    const path = await this.api(`/issue/${encodeURIComponent(key)}/comment`, { signal });
    const body = dep === 'Cloud' ? { body: markdownToAdf(text, { cloud: true }) } : { body: markdownToWiki(text) };
    const data = await this.request('POST', path, { body, signal });
    const id = data && data.id ? String(data.id) : null;
    return { key, id, url: `${this.baseUrl}/browse/${key}${id ? `?focusedCommentId=${encodeURIComponent(id)}` : ''}` };
  }

  /** Find people by name or email. */
  async findUser(query, { signal, max = 20 } = {}) {
    const q = str(query).trim();
    if (!q) throw new JiraError('Say whose name or email to look for.', { code: 'BAD_INPUT' });
    const dep = await this.deployment({ signal });
    const data =
      dep === 'Cloud'
        ? await this.request('GET', '/rest/api/3/user/search', { query: { query: q, maxResults: max }, signal })
        : await this.request('GET', '/rest/api/2/user/search', { query: { username: q, maxResults: max }, signal });
    // Cloud lists apps and service-desk customers too; people have accountType "atlassian".
    return (Array.isArray(data) ? data : [])
      .filter((d) => isObj(d) && d.active !== false && (!d.accountType || d.accountType === 'atlassian'))
      .map(normUser);
  }

  /** Branch name for an issue: ABC-123-fix-login-timeout. */
  branchName(key, summary) {
    return branchName(key, summary);
  }
}

/**
 * Guess a site's deployment before there are credentials (setup prompts): 'Cloud' for Atlassian
 * hosts, else the anonymous /rest/api/2/serverInfo answer. Never throws.
 * @param {string} baseUrl
 * @param {{env?:object, timeoutMs?:number, ca?:any, lookup?:Function}} [opts]
 * @returns {Promise<{deployment:'Cloud'|'Server'|null, reachable:boolean, error?:string, serverTitle?:string}>}
 */
async function probeDeployment(baseUrl, { env = process.env, timeoutMs = 8000, ca, lookup } = {}) {
  let norm;
  try {
    norm = normalizeBaseUrl(baseUrl);
  } catch (err) {
    return { deployment: null, reachable: false, error: err.message };
  }
  if (isCloudHost(new URL(norm).hostname)) return { deployment: 'Cloud', reachable: true };
  try {
    const res = await httpRequest(new URL(`${norm}/rest/api/2/serverInfo`), { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, timeoutMs, env, ca, lookup });
    let info = null;
    try {
      info = JSON.parse(res.body.toString('utf8'));
    } catch {
      info = null;
    }
    if (res.status >= 200 && res.status < 300 && isObj(info) && info.deploymentType) {
      return { deployment: /cloud/i.test(str(info.deploymentType)) ? 'Cloud' : 'Server', reachable: true, ...(info.serverTitle ? { serverTitle: str(info.serverTitle) } : {}) };
    }
    return { deployment: null, reachable: true };
  } catch (err) {
    return { deployment: null, reachable: false, error: err && err.message };
  }
}

/** Forget cached deployment detection (tests, or after the user changes settings). */
function clearDetectionCache() {
  detectCache.clear();
}

/** The deployment already known for a base URL without a network call, or null. */
function knownDeployment(baseUrl) {
  if (!baseUrl) return null;
  let norm;
  try {
    norm = normalizeBaseUrl(baseUrl);
  } catch {
    return null;
  }
  if (isCloudHost(new URL(norm).hostname)) return 'Cloud';
  for (const [k, v] of detectCache) if (k.startsWith(`${norm}\n`) && Date.now() - v.at < DETECT_TTL_MS) return v.deployment;
  return null;
}

/** A user-facing message for an error from this module (message plus hint). */
function errorText(err) {
  if (!err) return 'Unknown Jira error';
  const msg = str(err.message || err);
  return err.hint ? `${msg}\n${err.hint}` : msg;
}

module.exports = {
  JiraClient,
  JiraError,
  NOT_CONNECTED,
  HOW_TO_CONNECT,
  TOKEN_PAGE,
  SERVER_TOKEN_PATH,
  ENV_NAMES,
  resolveSettings,
  currentSettings,
  publicSettings,
  normalizeBaseUrl,
  isCloudHost,
  tokenPageFor,
  parseIssueKey,
  branchName,
  myIssuesJql,
  jqlQuote,
  splitOrderBy,
  adfToMarkdown,
  markdownToAdf,
  markdownToWiki,
  wikiToMarkdown,
  buildIssue,
  issueMarkdown,
  issueListMarkdown,
  searchResultText,
  pickTransition,
  pickUser,
  describeUser,
  userLabel,
  looksLikeAccountId,
  proxyFor,
  httpRequest,
  knownDeployment,
  probeDeployment,
  clearDetectionCache,
  errorText,
};
