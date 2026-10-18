# Jira

Claude Anywhere can read and update Jira tickets through your own Jira account, so you can say
"my Jira tab is open in Brave, work on that ticket" and Claude reads the ticket, asks where the
repository is, and starts the work. It costs nothing: Jira Cloud API tokens are free, and nothing
goes through any server other than your Jira site.

## Connect Jira

### Jira Cloud (yourcompany.atlassian.net)

1. Create a free API token at <https://id.atlassian.com/manage-profile/security/api-tokens>
   (**Create API token**, give it a name, copy it).
2. Run:

   ```sh
   anywhere jira setup
   ```

   It asks for the Jira URL, the email you sign in to Jira with, and the token. The token is typed
   hidden (paste it and press Enter). The connection is tested before anything is saved.

You can also enter the same three values in the dialog: **Settings → Jira**, then **Test connection**.

### Jira Server / Data Center

Create a personal access token in Jira (your avatar → **Profile** → **Personal Access Tokens**,
or `https://jira.example.com/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens`),
then run `anywhere jira setup` with your Jira URL and leave the username empty. Older servers
without personal access tokens work with a username and password instead.

`anywhere jira setup` finds out which kind of Jira it is talking to (from the host name, else from
`/rest/api/2/serverInfo`): Cloud uses Basic auth with email and token and REST API v3; Server and
Data Center use the token as a Bearer token and REST API v2.

### Without a terminal prompt

```sh
printf %s "$JIRA_API_TOKEN" | anywhere jira setup --url https://yourcompany.atlassian.net --email you@company.com --token-stdin
```

The token is never accepted as a command-line argument (it would end up in your shell history and
in the process list). `--no-test` saves without testing, for a site you cannot reach right now.

### Environment variables

Instead of saving the settings, the daemon and the MCP server also read these (the saved settings
win, field by field):

| Setting | Variables (first one set wins) |
|---|---|
| URL | `JIRA_BASE_URL`, `JIRA_URL`, `ATLASSIAN_BASE_URL`, `ATLASSIAN_URL` |
| Email / username | `JIRA_EMAIL`, `JIRA_USER`, `JIRA_USERNAME`, `ATLASSIAN_EMAIL`, `ATLASSIAN_USER`, `ATLASSIAN_USERNAME` |
| Token | `JIRA_API_TOKEN`, `JIRA_TOKEN`, `JIRA_PERSONAL_TOKEN`, `ATLASSIAN_API_TOKEN`, `ATLASSIAN_TOKEN` |

They must be set where the daemon starts; restart it with `anywhere restart` after changing them.

## Commands

```sh
anywhere jira setup                      # connect (prompts on a terminal)
anywhere jira test                       # check the saved connection: "Connected to Jira Cloud as …"
anywhere jira status                     # what is configured, without contacting Jira
anywhere jira issue ABC-123              # the ticket as Markdown (exactly what Claude reads)
anywhere jira mine [--status "in progress"]
anywhere jira search 'project = ABC AND status = "In Review"' [--max 50]
anywhere jira remove                     # forget the saved connection
```

Every command takes `--json`.

## What Claude can do with tickets

The `anywhere` MCP server gives Claude these tools once Jira is connected:

| Tool | What it does |
|---|---|
| `jira_status` | Whether Jira is connected, and as whom |
| `jira_get_issue {key}` | The whole ticket as Markdown: summary, type, status, priority, assignee, reporter, sprint, story points, labels, components, fix versions, parent or epic, description, acceptance criteria, steps to reproduce, subtasks, linked issues, attachments (names and links), the last 10 comments, and a suggested branch name such as `ABC-123-fix-login-timeout` |
| `jira_search {jql, max?}` | Issues matching a JQL query |
| `jira_my_issues {status?}` | Your issues: open (default), todo, in progress, done, all, or a status name |
| `jira_transition {key, to}` | Move an issue, by target status or transition name ("in progress", "Start Progress", "done"); a wrong name gets the list of valid ones |
| `jira_assign {key, user}` | Assign to `me`, `none`, an email, an accountId or a name; when a name fits several people Claude asks you which one |
| `jira_comment {key, text}` | Comment in Markdown (converted to Jira's format); visible to the whole project, so Claude posts only what you asked for |
| `jira_find_user {query}` | Look people up by name or email |

Descriptions and comments arrive as clean Markdown: Jira Cloud's rich text (Atlassian Document
Format) and Server's wiki markup are both converted, with headings, lists, code blocks, tables,
links and @mentions kept.

A typical request: *"My Jira tab is open in Brave. Start work on that ticket."* Claude reads the
ticket key from the browser tab, reads the ticket, asks which repository and folder to use (and
whether to create a branch), moves the ticket to In Progress if you want, and starts.

Moving, assigning and commenting stop while you have paused Claude in the dialog, and appear in the
dialog's activity list.

### Where the work happens

Claude never picks the repository for you. It calls `find_repos` (the folders open in your editors and
recently used, the folders in **Settings → Jira & repos → Workspace roots** (`workspace.roots`), common code
folders such as `~/code`, `~/projects`, `~/src` and `~/Documents/GitHub`, and the current project), ranks them
by the ticket key and summary, and asks you with the top matches, "Another folder (type the path)" and "Create
a new folder". When the folder you pick is not the dialog's project, Claude calls `switch_project`: when its
current step ends, the dialog switches to that folder and starts a fresh Claude session there with the
ticket, the plan and your answers (shown in the transcript as "Handed over by Claude"). Pressing Stop before
then cancels the switch. In bridge mode (`/anywhere here`) the terminal session works in the other folder
directly instead.

The voice says "Switching to shop-api to continue." at the hand-off, and "All done…" when the work there is
finished.

## When Jira is not connected

Every Jira tool then answers: *Jira isn't connected: run `anywhere jira setup`, or add it in
Settings → Jira, or read the ticket from the browser with read_browser_tab.* Claude falls back to:

1. an Atlassian or Jira MCP server, if you have one connected in Claude Code, or
2. reading the ticket straight from your browser tab (`read_browser_tab`), which needs no setup but
   only sees what the page shows, and cannot move, assign or comment.

## Security

- The token stays on your computer, in `~/.claude-anywhere/config.json`, which only your user can
  read (mode 0600). It is sent only to the Jira site it was saved for, over HTTPS for Cloud.
- The dialog, `anywhere config`, `anywhere jira status` and the HTTP API never show it: the settings
  page shows "•••• set", and `GET /api/config` and `GET /api/jira/status` report only that a token
  is set. **Test connection** with a different URL needs that site's own token; the saved one is
  never sent elsewhere.
- Redirects are followed only within the same site, so credentials never reach another host.
  Errors show Jira's HTTP status and messages, never the token.
- Claude reading `config.json` is a high-risk action that always shows an approval card.
- Use a token you can revoke: delete it at the same page you created it when you no longer need it,
  and run `anywhere jira remove`.

## Network

Requests time out after 15 s. `HTTPS_PROXY` / `HTTP_PROXY` (with `user:password@` if your proxy
needs it) and `NO_PROXY` are honoured. A company certificate authority goes in
`NODE_EXTRA_CA_CERTS` (restart the daemon after setting it).

## Troubleshooting

| Message | Fix |
|---|---|
| HTTP 401 | Wrong email or token, or the token was revoked: run `anywhere jira setup` again. On Cloud the email must be the one of the account that created the token. |
| HTTP 401/403 and "CAPTCHA" | Jira Server locked password sign-in after failed attempts: sign in once in the browser. |
| HTTP 403 | Your account lacks the permission (browse, transition, assign or comment) in that project. |
| HTTP 404 on an issue | The key is wrong, or your account cannot see the issue. |
| "redirected to a different site" | Your Jira moved, or single sign-on is in front of it: use the new URL, and an API token or personal access token. |
| "answered with a web page instead of data" | The URL is not the Jira site root (use `https://yourcompany.atlassian.net`). |
| "did not answer within 15 s" / "could not be resolved" | Network, VPN or proxy: check `HTTPS_PROXY` and `NO_PROXY`. |
