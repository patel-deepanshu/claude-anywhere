'use strict';

/**
 * HTTP routes for the Jira connection (registered by server.js):
 *
 *   GET  /api/jira/status[?check=1] → {configured, baseUrl, email, deployment, tokenSet, missing, source}
 *        deployment is 'Cloud' | 'Server' when known without a network call, else null; with check=1
 *        it also tries the connection: {connected, user?, error?, hint?}
 *   POST /api/jira/test {baseUrl?, email?, apiToken?} → {ok:true, user:{displayName, email, accountId},
 *        deployment, baseUrl}; a failure answers 422 {ok:false, error, hint?, code?, jiraStatus?}.
 *        Fields not sent (or sent empty, as the settings form does for the masked token) come from
 *        the saved settings. The saved token is only ever sent to the saved site: testing another
 *        URL needs its own token.
 *
 * Settings are read from config.json on every call, because `anywhere jira setup` writes it
 * directly while the daemon holds an older copy. Nothing here returns the token.
 */

const { SECURITY_HEADERS } = require('./server');
const jira = require('../integrations/jira');
const { createLogger } = require('../shared/log');

const log = createLogger('routes-jira');

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function sendJson(res, status, obj) {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function settingsOf(server) {
  const deps = server.deps || {};
  return jira.currentSettings(deps.config, { env: deps.env || process.env, load: deps.loadConfig });
}

function makeClient(server, opts) {
  const factory = server.deps && typeof server.deps.jiraClient === 'function' ? server.deps.jiraClient : (o) => new jira.JiraClient(o);
  return factory(opts);
}

function sameSite(a, b) {
  try {
    return new URL(jira.normalizeBaseUrl(a)).origin === new URL(jira.normalizeBaseUrl(b)).origin;
  } catch {
    return false;
  }
}

function field(body, name) {
  const v = body && body[name];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {(method:string, path:string, fn:Function, opts?:object)=>void} add
 * @param {object} server DaemonServer
 */
function register(add, server) {
  add(
    'GET',
    '/api/jira/status',
    async ({ url, res }) => {
      const s = settingsOf(server);
      const out = { ...jira.publicSettings(s), deployment: s.configured ? jira.knownDeployment(s.baseUrl) : null };
      if (url.searchParams.get('check') === '1' && s.configured) {
        const ac = new AbortController();
        const onClose = () => {
          if (!res.writableFinished) ac.abort();
        };
        res.on('close', onClose);
        try {
          const r = await makeClient(server, { baseUrl: s.baseUrl, email: s.email, apiToken: s.apiToken }).testConnection({ signal: ac.signal });
          Object.assign(out, { connected: true, deployment: r.deployment, user: r.user });
        } catch (err) {
          Object.assign(out, { connected: false, error: err && err.message, ...(err && err.hint ? { hint: err.hint } : {}) });
        } finally {
          res.removeListener('close', onClose);
        }
      }
      return out;
    },
    { noBody: true },
  );

  add('POST', '/api/jira/test', async ({ body, res }) => {
    const saved = settingsOf(server);
    const sentUrl = field(body, 'baseUrl');
    const sentEmail = field(body, 'email');
    const sentToken = field(body, 'apiToken');
    const baseUrl = sentUrl || saved.baseUrl;
    if (!baseUrl) throw httpError(400, 'Enter the Jira URL (for example https://yourcompany.atlassian.net).', { code: 'JIRA_NOT_CONFIGURED' });
    let normalized;
    try {
      normalized = jira.normalizeBaseUrl(baseUrl);
    } catch (err) {
      throw httpError(400, err.message, { code: 'JIRA_BAD_URL' });
    }
    let apiToken = sentToken;
    if (!apiToken) {
      // Never hand the saved token to a different site than the one it was saved for.
      if (saved.apiToken && (!sentUrl || (saved.baseUrl && sameSite(normalized, saved.baseUrl)))) apiToken = saved.apiToken;
      else {
        throw httpError(400, saved.apiToken ? 'Enter the API token for this Jira site (the saved token belongs to another site).' : 'Enter the API token.', {
          code: 'JIRA_NO_TOKEN',
          hint: `Create one for free: ${jira.tokenPageFor(normalized)}`,
        });
      }
    }
    const email = sentEmail || (!sentUrl || sameSite(normalized, saved.baseUrl || normalized) ? saved.email : '');
    const ac = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) ac.abort();
    };
    res.on('close', onClose);
    try {
      const client = makeClient(server, { baseUrl: normalized, email, apiToken });
      const r = await client.testConnection({ signal: ac.signal });
      return { ok: true, user: r.user, deployment: r.deployment, baseUrl: r.baseUrl, ...(r.serverTitle ? { serverTitle: r.serverTitle } : {}) };
    } catch (err) {
      if (err && err.code === 'ABORTED') return undefined;
      log.info(`Jira connection test for ${normalized} failed: ${err && err.message}`);
      const out = { ok: false, error: (err && err.message) || 'The Jira connection test failed', code: (err && err.code) || 'JIRA_ERROR' };
      if (err && err.hint) out.hint = err.hint;
      if (err && Number.isFinite(err.status)) out.jiraStatus = err.status;
      sendJson(res, 422, out);
      return undefined;
    } finally {
      res.removeListener('close', onClose);
    }
  });
}

module.exports = { register };
