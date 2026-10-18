# Claude Anywhere: architecture and module contract

This document is the **binding contract** between modules. Every module must
match the exports, message shapes, and file paths below. If you change one,
update this file in the same commit.

- Runtime: **Node.js ≥ 18** (uses global `fetch`, `FormData`, `Blob`, `crypto.randomUUID`).
- Module system: **CommonJS** everywhere under `bin/`, `src/` (except `src/ui/*`,
  which is browser code loaded with `<script type="module">`).
- **Zero runtime npm dependencies.** Only Node built-ins plus OS tools that are
  present by default or have clear install hints (`anywhere doctor`).
  Electron is optional and only used if it's already resolvable.
- Style: 2-space indent, single quotes, semicolons, `'use strict';` at the top of
  every CJS file, JSDoc on exported functions. Never `console.log` from
  library code that might run inside the MCP stdio server (stdout is the
  protocol channel). Use `src/shared/log.js`, which writes to stderr or a file.

---

## 1. Big picture

```
 ┌────────────────────────────┐        /anywhere (skill)
 │ Claude Code (interactive)  │──────► node skills/anywhere/run.js start --project $PWD
 └────────────────────────────┘                     │
                                                    ▼
 ┌──────────────────────── anywhere daemon (Node, 127.0.0.1:47120) ─────────────────────────┐
 │ HTTP + SSE API (token auth) · SessionManager · PermissionBroker · QuestionBroker · Bridge │
 │ VoiceService (server STT/TTS) · UiHost (opens the dialog) · DesktopContext · Computer     │
 │                                                                                            │
 │ companion mode:  ClaudeCliEngine ──spawns──► `claude -p --input-format stream-json ...`    │
 │                                                  │  (cwd = project dir)                   │
 │                                                  └─spawns─► MCP server `anywhere` (stdio)  │
 │                                                              screen/mouse/keyboard/windows │
 │                                                              ask_user/notify_user/perm.    │
 │ bridge mode:     commands queue ◄── `anywhere listen` / `anywhere reply` (interactive CC)  │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
          ▲  SSE events / REST
          │
 ┌────────┴─────────────────────────┐
 │ Dialog UI (src/ui) in:           │  voice: Web Speech API or WAV → /api/stt
 │ Electron | Chromium --app | tab  │  tts: speechSynthesis or /api/tts
 │ | terminal TUI                   │
 └──────────────────────────────────┘
```

### Modes
- **companion** (default): the daemon runs its own headless Claude Code session
  (`claude -p` with stream-json in and out) in the project directory. The
  interactive terminal session that ran `/anywhere` stays free.
- **bridge**: the dialog's commands are queued for the interactive Claude Code
  session that ran `/anywhere here`. That session loops `anywhere listen` →
  does the work → `anywhere reply`.

---

## 2. File layout

```
.claude-plugin/plugin.json          plugin manifest (name "anywhere"; inline mcpServers "anywhere" → node ${CLAUDE_PLUGIN_ROOT}/src/mcp/server.js.
                                    Inline rather than a root .mcp.json, which would also load as a broken project server in this repo)
.claude-plugin/marketplace.json     marketplace "anywhere-marketplace" listing plugin "anywhere" with source "."
skills/anywhere/SKILL.md            the /anywhere skill
skills/anywhere/run.js              locates the package and forwards argv to bin/anywhere.js
bin/anywhere.js                     CLI entry point
bin/anywhere, bin/anywhere.cmd      tiny shims (plugin bin/ dirs are added to the Bash PATH while the plugin is enabled)
src/shared/{paths,config,log,state,client,proc,platform,util}.js
src/os/{index,computer,png,keys,common,darwin,win32,linux}.js
src/os/audio.js                     WAV playback (afplay / SoundPlayer / pw-play|paplay|aplay|ffplay)
src/os/darwin-helper.js             JXA script run via `osascript -l JavaScript`
src/os/win32-host.ps1               persistent PowerShell JSON-lines host
src/os/{ocr,apps,browsers}.js       desktop assistant: on-device OCR, installed apps (launch, quit), browser bookmarks / open / tabs
src/os/atspi-helper.py              Linux AT-SPI helper for uiTree / uiFind / uiAction (python3 -I, one JSON request per run)
src/os/darwin-ocr.js, win32-ocr.ps1 one-shot OCR scripts: Apple Vision (osascript -l JavaScript), Windows.Media.Ocr (powershell.exe 5.1)
src/context/desktop.js
src/mcp/{server,tools}.js
src/mcp/tools-{browser,jira,project}.js   feature tools: read_browser_tab · jira_* · find_repos, switch_project
src/mcp/tools-{ui,ocr,desktop}.js   desktop assistant tools: ui_* · find_text, read_screen_text · apps, windows, browsers
src/daemon/{main,server,hub,session,engine-cli,permissions,questions,bridge,prompt,voice,uihost}.js
src/daemon/{piper,announcer,chime,routes-voice}.js   free neural voice (Piper), spoken announcements, chimes, voice routes
src/daemon/routes-{jira,project}.js  GET /api/jira/status, POST /api/jira/test · POST /api/mcp/switch-project
src/integrations/jira.js            Jira Cloud / Server REST client (zero dependencies)
src/cli/{voice,jira,desktop}.js     anywhere voice … · anywhere jira … · anywhere desktop …
src/ui/{index.html,app.css,app.js,voice.js,wav-recorder.js,markdown.js}
src/electron/{main,preload}.js
src/tui/tui.js
scripts/{install.js,install.sh,install.ps1}
scripts/{check-syntax,test}.js          npm run lint / npm test
test/*.test.js, test/fixtures/fake-claude.js
docs/{PLAN,ARCHITECTURE,VOICE,JIRA,PLATFORMS,SECURITY,DESKTOP}.md
package.json, README.md, .github/workflows/ci.yml
```

**Feature modules.** New features live in their own files, loaded when present (a missing file is skipped,
any other load error still throws):
- `src/mcp/tools.js` loads `src/mcp/tools-{browser,jira,project,calls,ui,ocr,desktop}.js` (`TOOL_MODULES`); each exports
  `createTools(ext) -> tool[]` with `ext = {computer, getClient, config, role, progressIntervalMs, deps, getComputer,
  getDriver, client, checkGuard, postActivity, keepAlive, ok, fail, daemonRequest, objectSchema, annotations,
  screenshotAfter, screenshotAfterSchema}` (§6).
- `src/daemon/server.js` loads `src/daemon/routes-{voice,jira,project,calls}.js`; each exports `register(add, server)`.
  Handlers are bound to the DaemonServer and get `({req, res, url, body, raw})` like the built-in ones; paths match
  exactly (ids go in the query string).
- `bin/anywhere.js` loads `src/cli/{voice,jira,clone,calls,desktop}.js`; each exports `commands(helpers) -> {name: {run, group,
  summary, usage, spec, details?}}` with `helpers = {spec, shared, call, requireDaemon, ensureDaemon, writeOut,
  writeErr, printJson, sym, color, EXIT}`.

---

## 3. Shared modules (`src/shared`)

### paths.js
```js
PACKAGE_ROOT                 // absolute repo/package root
stateDir()                   // env ANYWHERE_HOME || ~/.claude-anywhere (mkdir -p, 0700)
configPath()                 // stateDir()/config.json
daemonStatePath()            // stateDir()/daemon.json
sessionsPath()               // stateDir()/sessions.json   { [projectDir]: {sessionId, updatedAt, lastTotalCostUsd?} }
                             //   lastTotalCostUsd: the CLI's cumulative cost, the base for the next turn after --resume
installInfoPath()            // stateDir()/install.json    { packageRoot, version, installedAt }
logsDir()                    // stateDir()/logs (mkdir -p)
auditLogPath(date?)          // logsDir()/audit-YYYY-MM-DD.jsonl
daemonLogPath()              // logsDir()/daemon.log
runDir()                     // stateDir()/run (mkdir -p): mcp config, system prompt, temp files
uiProfileDir()               // stateDir()/ui-profile (Chromium --user-data-dir)
modelsDir()                  // stateDir()/models
lastShotPath()               // runDir()/last-shot.json (shared screenshot geometry, Computer geometryStore 'file')
claudeHome()                 // env CLAUDE_CONFIG_DIR || ~/.claude
```

### config.js
```js
DEFAULTS                      // see below
load()            -> config   // deep-merge DEFAULTS <- file; tolerate missing or corrupt file
save(partial)     -> config   // deep-merge into current, write 0600, return merged
get(cfg, 'a.b.c')             // dotted path read
setPath(cfg, 'a.b', value)    // dotted path write (returns cfg)
coerce(str)                   // 'true'/'false'/numbers/JSON → typed
publicConfig(cfg) -> object   // secrets replaced: voice.sttApiKey → '' plus voice.sttApiKeySet: bool,
                              // jira.apiToken → '' plus jira.apiTokenSet: bool
```
`DEFAULTS`:
```js
{
  port: 47120,                       // falls back to a random free port if busy
  mode: 'companion',                 // 'companion' | 'bridge'
  ui: { host: 'auto',                // 'auto'|'electron'|'app'|'browser'|'tui'|'none'
        alwaysOnTop: true, hotkey: 'CommandOrControl+Shift+Space', theme: 'system',
        width: 440, height: 720, position: 'right', hideFromScreenshots: true, openOnStart: true },
  engine: { claudePath: '', model: '', fallbackModel: '', effort: '', chrome: false,
            addVsCodeWorkspaces: true, resumeLast: true, maxBudgetUsd: 0, extraArgs: [],
            stripEnv: ['CLAUDECODE','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_CHILD_SESSION','CLAUDE_PID',
                       'CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_SSE_PORT','CLAUDE_CODE_MESSAGING_SOCKET',
                       'CLAUDE_CODE_MESSAGING_TOKEN','CLAUDE_CODE_REMOTE_SESSION_ID','CLAUDE_CODE_DIAGNOSTICS_FILE',
                       'CLAUDE_CODE_TEE_SDK_STDOUT'] },
  permissions: { mode: 'smart', approvalTimeoutSec: 600, alwaysAllow: [], alwaysAsk: [] },
  computer: { maxWidth: 1366, maxHeight: 768, failsafe: true, actionDelayMs: 120, pasteThreshold: 200 },
  context: { attachDesktopContext: true, attachScreenshotByDefault: false, includeWindows: true, includeCloud: true },
  voice: { stt: 'auto',              // 'auto'|'browser'|'server'|'off'
           tts: 'auto',              // 'auto'|'browser'|'server'|'off'
           language: 'en-US', autoSend: true, speakResponses: true, handsFree: false,
           wakeWord: 'hey claude', ttsRate: 1.0, ttsVoice: '',
           sttProvider: 'auto',      // 'auto'|'openai'|'groq'|'custom'|'whisper.cpp'
           sttBaseUrl: '', sttApiKey: '', sttModel: '', whisperCppPath: '', whisperModel: '',
           ttsEngine: 'auto',        // 'auto' (Piper when installed, else browser/OS) | 'piper' | 'browser' | 'os'
           piperVoice: 'en_US-lessac-medium',
           announce: { done: true, permission: true, question: true, error: true },   // what is said aloud
           chime: true },            // a short tone before announcements
  jira: { baseUrl: '', email: '', apiToken: '' },   // optional; env JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN… also work
  workspace: { roots: [] },          // folders find_repos searches first ('~', POSIX, C:\…, UNC)
  privacy: { redactSecretsInLogs: true,   // masks secrets in daemon/MCP log lines and the audit log
             auditLog: true }
}
```

### log.js
```js
createLogger(name) -> { debug, info, warn, error }   // writes "[ts] [name] level msg" to stderr,
                                                     // or to daemonLogPath() if env ANYWHERE_LOG_FILE=1.
                                                     // debug only when env ANYWHERE_DEBUG=1
audit(event)                                         // JSONL append {ts, ...redact(event)} to auditLogPath()
redact(value) -> value                               // deep; masks secrets in strings (API keys, tokens, bearer
                                                     // headers, Basic auth headers, Atlassian ATATT… tokens, key=value
                                                     // passwords, private keys), masks the values of
                                                     // token/apiKey/apiToken/sttApiKey/password/secret/authorization keys,
                                                     // and elides Buffers and long image/data strings. Always masks.
setAuditEnabled(on)                                  // privacy.auditLog
setRedactLogs(on)                                    // privacy.redactSecretsInLogs (default on)
applyPrivacyConfig(config)                           // both of the above; only an explicit false turns one off
```
Log lines redact every argument: strings, `Error` stacks and objects (deep). When `redactSecretsInLogs` is off,
log lines and audit events keep secret-looking text verbatim, but the credential keys above are still masked and
binary/image payloads are still elided. `applyPrivacyConfig(config)` is called by the daemon at startup and on every
config change, and by the MCP server whenever it (re)loads `config.json`.

### state.js
```js
readDaemonState()  -> {pid, port, token, instanceId, version, startedAt, project, mode, url} | null
writeDaemonState(obj)                    // 0600
clearDaemonState()
async findRunningDaemon({timeoutMs=1500}) -> state | null   // pid alive AND GET /api/health 2xx AND instanceId matches; clears stale file (a daemon that is shutting down answers 503, so it is not reused)
isPidAlive(pid) -> bool
```

### client.js
```js
class DaemonClient {
  constructor({ baseUrl, token })
  static async connect() -> DaemonClient | null      // env ANYWHERE_DAEMON_URL+ANYWHERE_TOKEN first, else findRunningDaemon()
  async request(method, path, body?, { timeoutMs = 30000 } = {}) -> parsed JSON (throws Error with .status on non-2xx)
  async postBinary(path, buffer, contentType, { timeoutMs }) -> JSON
  subscribe(onEvent /* (type, data) */) -> { close() }   // SSE over fetch, auto-reconnect with 1s..10s backoff
}
```
Auth header: `Authorization: Bearer <token>`.

### proc.js
```js
async run(cmd, args = [], { timeoutMs = 15000, input, cwd, env, encoding = 'utf8', maxBuffer = 64 * 1024 * 1024, windowsHide = true } = {})
   -> { code, signal, stdout, stderr, timedOut, error }   // never throws; error set on spawn failure (e.g. ENOENT)
which(name) -> absolute path | null                        // PATH (+PATHEXT on win32); hits cached, a miss is re-checked after 10 s
spawnDetached(cmd, args, { cwd, env, logFile }) -> ChildProcess (unref'd)
```

### platform.js
```js
info() -> { platform: 'darwin'|'win32'|'linux', isWSL, displayServer: 'quartz'|'windows'|'x11'|'wayland'|'none',
            desktop, arch, release, osName, hostname, user, shell, isHeadless }
```
`isWSL`: linux and `/proc/version` contains "microsoft". WSL uses the Windows desktop
through `powershell.exe` (see `src/os/win32.js`).

### util.js
```js
uuid(), randomToken(bytes = 24), sleep(ms), truncate(str, n), safeJsonParse(str, fallback),
deepMerge(a, b), stripMarkdownForSpeech(text), escapeRegExp(s), nowIso(), debounce(fn, ms)
```

---

## 4. OS layer (`src/os`)

### Units and coordinates
- A **driver** works in **logical global coordinates**: points on macOS (CGEvent space,
  origin top-left of the main display), physical pixels on Windows (the PS host is
  per-monitor DPI aware), and X11 pixels on Linux.
- **Tools and CLI** work in **screenshot space**: pixel coordinates in the most
  recent *full-display* screenshot returned to the model. `Computer` maps between them.

### Driver interface (`src/os/index.js` → `getDriver()`)
```js
async getDriver() -> Driver            // cached singleton; picks darwin | win32 (also WSL) | linux-x11 | linux-wayland | unsupported
Driver {
  name                                  // string
  async capabilities() -> { screenshot, mouse, keyboard, windows, clipboard, notify, speak, ui: bool, notes: string[], uiHint?: string }
  async displays() -> [{ index, id, x, y, width, height, scale, primary }]   // logical; index 0 = primary
  async captureDisplay(index) -> { png: Buffer, width, height }             // native pixels of that display
  async cursorPosition() -> { x, y }                                         // logical global
  async moveMouse(x, y)
  async click(x, y, { button = 'left', clicks = 1, modifiers = [] })
  async mouseDown(button), async mouseUp(button)
  async drag(x1, y1, x2, y2, { button = 'left' })
  async scroll(x, y, dx, dy)            // wheel notches; dy > 0 = down, dx > 0 = right
  async typeText(text)                  // literal unicode text into the focused window
  async keyCombo(keys)                  // normalized names from keys.js, e.g. ['ctrl','shift','t']
  async listWindows() -> [{ id, app, title, pid, x, y, width, height, focused, minimized, stackIndex? }]
  async activeWindow() -> { id, app, title, pid, process? } | null   // process: executable name (cmd.exe, conhost) when known
  async focusWindow(id) -> bool
  async minimizeWindow(id) -> bool
  async setTopmost(id, on) -> bool      // best effort (false if unsupported)
  async clipboardGet() -> string
  async clipboardSet(text)
  async close()                         // stop persistent helpers
  windowsZOrdered?                      // optional flag: true when listWindows() is front to back on every backend
  async closeWindow?(id) -> bool        // optional (macOS): press the window's close button; the app keeps running
  async browserTab({ app?, windowId?, window?, includeText? = false, maxChars? = 20000, keyboard? = true, beforeInput?, timing? })
    -> { browser, app, title, url: string|null, method: 'applescript'|'uia'|'keyboard'|'title', windowId, tookFocus,
         clipboard?: 'restored'|'changed'|'unknown'|'lost', text?, truncated?, textChars?, textMethod?, tabTitle?,
         hint?, permission?: 'automation'|'accessibility', settingsUrl?, notes?: string[] }
  // UI automation (accessibility) and window geometry: see "UI automation and window geometry" below
  async uiTree({ windowId?, depth = 6, maxNodes = 400 }) -> { window: { id, app, title }, nodes: Node[], truncated, notes? }
  async uiFind({ windowId?, name?, role?, text?, exact = false, limit = 20 }) -> Match[]   // + non-enumerable window, truncated, notes…
  async uiAction({ id, action, value? }) -> { ok, method, reason?, pending?, confirmed?, disabled?, item?, id?, role, name, bounds?, warnings? }
  async setWindowBounds(windowId, { x?, y?, width?, height? } | { state: 'maximize'|'minimize'|'restore'|'fullscreen' }) -> bool
}
```
`browserTab` reads a browser window's address (and with `includeText` its page text). `app` is a browser query
("brave", "Google Chrome", "ff"), `window` a `listWindows()` entry the caller already picked, `keyboard: false`
never sends input. Native first: macOS asks the browser through the helper command `browserTab` (`darwin-helper.js`;
`{app, pid?, kind:'chromium'|'safari', title?, wantText?}`, PERMISSION -1743 → Automation hint), Windows and WSL read
the address bar through UI Automation (host command `browsertab` `{hwnd, budgetMs?, maxNodes?}` in `win32-host.ps1`).
Otherwise (X11, Wayland, or a native miss) the shared keyboard reader in `src/os/linux.js` (`readBrowserTab`,
`keyboardReadTab`) saves the clipboard, focuses the window, checks it is active, sends primary+L / primary+C (and
primary+A / primary+C for the text, F6 between attempts until the copy is page text), collapses the selection,
restores the clipboard unless something else changed it, and refocuses the previous window. `beforeInput` runs before
the first keystroke and again before select-all; a PAUSED/FAILSAFE error aborts with no further input. No matching
browser → NOT_FOUND with a hint; other failures degrade to method `title` with notes. `src/os/linux.js` also exports
`browserWindows`, `identifyBrowser`, `normalizeTabUrl`, `cleanPageText`, `BROWSERS` for reuse.
Unsupported operations throw `Error` with `.code = 'UNSUPPORTED'` and an
actionable `.hint` (e.g. "Install xdotool: sudo apt install xdotool").
- `stackIndex` (optional) is the window's place in the stacking order, 0 = frontmost: X11 reads it
  from `_NET_CLIENT_LIST_STACKING`, Hyprland from `focusHistoryID`; windows without one leave it out.
  `desktop.js` sorts by it, and treats a list as front to back when every window is ranked this way or
  the driver sets `windowsZOrdered` (macOS and Windows list front to back already).
- Input methods (`click`, `mouseDown`, `drag`, `scroll`, `typeText`, `keyCombo`) resolve to `undefined`,
  or to `{ warnings: string[] }` when the OS may have dropped the input silently. Only the win32 driver
  does this today: input aimed at a window of another user account (an installer elevated with other
  credentials) can be discarded by UIPI. `Computer` passes the warnings on in its action results, and
  the MCP tools append them to the text the model sees ("Warning: …") and to the dialog activity.
- win32 `listWindows()` entries also carry `elevated: true | false | null` (null = another account's
  process, elevation unknown); `list_windows` marks them `[admin]` / `[other account; may be admin]`.
  In the PowerShell host protocol a successful result may carry `"warnings": ["…"]`.
- macOS: `listWindows({ axTitles: false })` / `activeWindow({ axTitles: false })` skip reading blank
  titles through System Events (which can raise the Automation prompt); UiHost uses it for background
  polling and other drivers ignore the argument. `DarwinDriver.supportsTopmost` is `false` and
  `capabilities().permissions` also reports `automation` (System Events consent), from what is already known.

### UI automation and window geometry (every backend and the mock)

The desktop assistant reads and drives the controls of any app through the platform's accessibility API, so Claude
can press "For you" or fill "Search" by name instead of guessing pixels.
```js
Node  = { id, role, name, value?, description?, bounds: { x, y, width, height } /* logical global; all 0 = unknown */,
          enabled, focused, selected?, checked?, expanded?, parent: id | null, children: id[] }   // + per-backend extras
Match = { id, role, name, value, bounds, windowId, path, enabled, focused?, description?, offscreen?, selected?, checked?, expanded? }
```
- **Roles** (shared vocabulary): button, link, textbox, checkbox, radio, combobox, listitem, menuitem, menu, tab,
  tablist, treeitem, image, text, heading, window, toolbar, group, table, row, cell, slider, other. Role filters also
  take aliases ("edit", "hyperlink", "page tab", "list item", "dropdown"…), `"a|b"` and arrays
  (`linux.js` exports `UI_ROLES`, `normalizeUiRole`, `uiRoleFilter`, `uiMatchScore`; `win32.js` its own `normalizeUiRole`).
- **Matching**: `name` matches the accessible name, `text` the name, value or description; case-insensitive substring,
  or the whole string with `exact`. Ranked whole match, then prefix, then substring; enabled and on-screen first.
- **Trees are compact**: unnamed containers, decorative images and repeated labels are walked through but not listed
  (their children attach to the nearest listed ancestor); `depth` counts listed levels.
- **Ids** are opaque, cached about 30 s per window and re-resolved by their path (plus a role+name hash) after that,
  so a stale id never acts on a different element: it fails with a STALE code and a hint to look the element up again.
- **uiAction**: `press | focus | setValue | select | expand | collapse | scrollIntoView | showMenu`. `ok:false` with
  `method:'none'` means "no accessibility action: click the centre of `bounds` instead"; `disabled:true` means the
  element is disabled; `pending:true` (Windows) or `confirmed:false` (macOS) means the app did not answer in time,
  usually because the press opened a modal dialog or menu: the press happened, so the caller must not click again.
- **setWindowBounds** takes `{x, y, width, height}` (partial bounds keep the rest, in the coordinates `listWindows`
  reports) or a `state`; it returns false for an unknown window or one the OS refuses to resize.
- `capabilities().ui` says whether this works on the machine; `uiHint` (when false) is the fix, and `notes` explain
  the Chromium/Electron accessibility switches.

**macOS** (`darwin.js`, helper commands `uiTree`, `uiFind`, `uiAction`, `setBounds` in `darwin-helper.js`; `uiTree`
and `uiFind` are retried after a helper crash like other idempotent commands). The AX C API through JXA, calibrated
at runtime, with System Events as the fallback; `ANYWHERE_DARWIN_UI=ax|systemEvents` forces one. Accessibility is
checked before every call (PERMISSION with a Settings hint; System Events paths can also need Automation). Ids are
`mac:<pid>:<window>:<w|a><path>:<hash>` (FNV-1a of role and name; `a` = the app's menu bar), so they validate
themselves; bounds are remembered 30 s. The walk is breadth first; unnamed groups are flattened, scrolled-away
elements and zero-size leaves are left out; the app's open menus are extra roots, and an app without windows shows
its menu bar. When a Chromium/Electron web area comes back empty, `AXManualAccessibility` (and
`AXEnhancedUserInterface` for Chromium browsers) is set once per pid and the tree read again. Extras: `engine`
(`ax`|`systemEvents`), `enabledAccessibility`, `uiAction` returns `resolved: 'path'|'search'` and may return a fresh
`id`; `focus` is ok:false when the app did not come to the front; `setValue` is ok:false (method `AXValue`) when the
app did not keep the value. `setWindowBounds` goes through System Events (Automation, like `focusWindow`); maximize
fills the screen's visible frame and `restore` returns to the frame saved before maximize or fullscreen.

**Windows and WSL** (`win32.js`; host commands `uiinfo`, `uitree`, `uifind`, `uiaction`, `winbounds` in
`win32-host.ps1`, UI Automation loaded lazily; `uitree`/`uifind`/`uiinfo` are retried once after a host crash).
Breadth-first over the ControlView with one `GetUpdatedCache` round trip per expanded element (21 cached properties),
stopping at depth, `maxNodes`, a scan cap or a 3 s budget; ScrollBar and Thumb subtrees are skipped; `compact:false`
gives the raw tree. Ids are `<hwnd>.<raw child index>…~<tag>` (2-character FNV-1a of role and lowercased name),
cached in the host 30 s, then re-walked by path; a tag mismatch is STALE_ELEMENT. `uiFind` searches visible pop-ups of
the same process (open `#32768` menus, drop-downs) first, ranks as above, and carries non-enumerable `truncated`,
`scanned`, `window` and `warnings` (a Chromium/Electron window that exposes almost nothing is walked again after
500 ms, then a warning suggests `--force-renderer-accessibility`); `uiTree` may list `popups: [hwnd]`. `press` tries
Invoke, Toggle, SelectionItem, ExpandCollapse, then the MSAA default action (oleacc `AccessibleObjectFromPoint` at the
centre, only when the names agree). Every pattern call runs on a worker thread with a 2 s wait (`pending:true` when the
provider has not returned). Values never come from password fields. Elevated windows throw UIPI_BLOCKED.
`setWindowBounds` works on the visible frame (DWM extended frame, as `listWindows` reports), compensates the invisible
resize borders, restores a minimized or maximized window first, re-applies after a per-monitor DPI change, and maps
`fullscreen` to maximize.

**Linux** (`linux.js` + `atspi-helper.py`). The helper runs as `python3 -I atspi-helper.py` with one JSON request on
stdin and one answer on stdout (`version`, `roles`, `match`, `probe`, `tree`, `find`, `action`; codes NO_BINDINGS,
NO_BUS, NO_WINDOW, STALE, BAD_REQUEST). It checks the session bus through Gio before libatspi (which aborts without
one), matches the top-level window by pid and title (plus bounds and the active state), walks breadth first with
depth, node and time budgets (6 s by default), never reads password values, and acts through
`Action.do_action`, `Selection`, `Component.grab_focus` / `scroll_to`, `EditableText.set_text_contents` and
`Value.set_current_value`. The interpreter is the first with the Atspi typelib among `$ANYWHERE_PYTHON`, `python3`,
`/usr/bin/python3`, `/usr/bin/python3.N`. Ids are `lx:<listWindows id | @pid.appIndex>:<w|p<k>>:<child path>:<6-hex
hash>`, re-resolved by path then by a hash search, cached 30 s. On GNOME/KDE Wayland applications do not know screen
positions: results carry `relativeBounds` and no screenshot point. Chromium/Electron apps join the bus only with
`ACCESSIBILITY_ENABLED=1` and show page content only with `--force-renderer-accessibility` (`CHROMIUM_A11Y_ENV`,
`CHROMIUM_A11Y_ARGS`, `CHROMIUM_A11Y_HINT`). `setWindowBounds`: X11 bounds are the client area as `listWindows`
reports it (frame offset corrected), states through EWMH with wmctrl (xdotool fallback), verified through
`_NET_WM_STATE`; sway (floating, fullscreen, scratchpad) and Hyprland (setfloating, resize/move window pixel,
fullscreen modes, `special:minimized`); GNOME/KDE Wayland throw UNSUPPORTED with a hint. `capabilities()` probes the
helper (cached 30 s) and adds notes (Python version, application count) or `uiHint`
(`sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core`).

**Mock** (`createMockDriver`): `state.ui` maps window ids to trees (`MOCK_UI`: a VS Code window and a Jira-like
"Your work" page in Chrome); ids are `mock:<window id>:<child path>`; `uiAction` selects tabs and list items, toggles
check boxes, sets values and appends to `state.uiLog`; `setWindowBounds` moves windows (maximize to the window's
display, restore to the saved frame). The unsupported driver throws UNSUPPORTED for all four.

### common.js (OS-agnostic helpers that shell out)
```js
async openTarget(target, { kind = 'auto', args = [] }) -> { opened, kind, how }  // url | path | app
async notify(title, body)                    // osascript / PS host balloon / notify-send
async speak(text, { rate, voice })           // say / System.Speech / spd-say|espeak-ng|espeak; returns {pid}
stopSpeaking()                               // from WSL also taskkills the Windows powershell.exe (its PID is printed first)
```

### keys.js
```js
normalizeCombo('Ctrl+Shift+T') -> ['ctrl','shift','t']
// modifiers: ctrl, alt, shift, meta (cmd/command/super/win/windows/os); 'primary'/'mod' → meta on darwin else ctrl
// named keys: enter, escape, tab, space, backspace, delete, insert, home, end, pageup, pagedown,
//             up, down, left, right, f1..f24, capslock, printscreen, menu, plus single characters
toXdotool(keys) -> 'ctrl+shift+t'
toMacKeyCodes(keys) -> { keyCode, keyCodes, chars, flags, modifierKeyCodes }  // kVK codes (US ANSI positions) + per-key layout chars (null for position-independent keys) + CGEventFlags
// darwin-helper.js presses the key that types chars[i] on the active layout (Cmd+A on AZERTY,
// Cmd+V when pasting on Dvorak); a character the layout lacks keeps the US position.
toWindowsVk(keys) -> number[]                  // VK codes, modifiers first
```

### png.js (pure JS, zlib only)
```js
decode(buffer) -> { width, height, data: Uint8Array RGBA }   // color types 0,2,3,4,6; bit depth 8 (and 16 → 8); non-interlaced (+ Adam7)
encode({ width, height, data }) -> Buffer                    // RGBA 8-bit, filter type chosen per row (none/sub/up/paeth)
resize(img, newW, newH) -> img                               // area-average (box) downscale; bilinear upscale
crop(img, x, y, w, h) -> img
fitWithin(w, h, maxW, maxH) -> { width, height, scale }      // never upscales
```

### computer.js
```js
class Computer {
  constructor({ driver, config /* computer section */, guard /* async () => ({allowed, reason}) */, geometryStore /* 'memory' | 'file' */ })
  // 'file' persists the last shot's geometry in lastShotPath(); the CLI, the MCP server and the daemon all use
  // it, so a screenshot taken by any of them sets the coordinate mapping the others use. 'memory' is per instance.
  async screenshot({ display = 0, region /* {x,y,width,height} in full-shot space */, maxWidth, maxHeight })
     -> { png, width, height, display, scale, region, cursor /* in shot space or null */, displays /* count */ }
  async click({ x, y, button, clicks, modifiers, display })
  async moveMouse({ x, y, display }), async drag({ fromX, fromY, toX, toY, button, display })
  async scroll({ x, y, direction, amount = 3, display })
  async typeText({ text, method = 'auto' /* auto|keys|paste */ })
  async key({ combo, repeat = 1 })
  // input actions resolve to { ok: true, action, …, warnings? } (driver warnings, de-duplicated)
  async cursorPosition() -> { x, y, display }      // shot space
  async screenInfo() -> { displays, lastShot }
  toLogical(display, x, y) -> { x, y }; toShot(display, lx, ly) -> { x, y }
  async browserTab(opts) -> driver.browserTab(opts)   // in the action queue; opts.beforeInput, then the guard and failsafe, before any key
  // UI elements (not input actions: uiFind, uiTree)
  async uiFind(opts) -> Match[]   // driver.uiFind + shot: { x, y, width, height, cx, cy, display } | null, metadata kept
  async uiTree(opts) -> { window, nodes /* each with shot */, truncated, notes? }
  // input actions (guard, failsafe, settle delay)
  async uiClick({ id? | name? | text?, role?, windowId?, exact? })
     -> { ok, action: 'ui_click', method, id, role, name, windowId?, shot?, pending?, logical?, display?, reason?, warnings? }
  async uiSetValue({ id? | name? | text? | query?, value, role?, windowId?, exact? })
     -> { ok, action: 'ui_set_value', method, chars, id, role, name, shot?, warnings? }
  async uiAction({ id, action, value? })   // any driver.uiAction, guarded; ok:false is returned as is
}
```
- Mapping: `logical = display.x + shotX * (display.width / shot.width)` (same for y). If
  no screenshot of that display was taken yet, shot space = logical display-local space.
- Failsafe: if `config.failsafe` and the cursor is within 3 logical px of the primary
  display's top-left corner before an input action, throw
  `Error('FAILSAFE: mouse is in the top-left corner; actions are paused')` with `.code = 'FAILSAFE'`.
- `guard()`, when given, is awaited before each input action; `{allowed:false}` throws `.code='PAUSED'`.
- Paste method: save the clipboard, set the text, send primary+v, restore the clipboard after 400 ms.
  `auto` uses paste when text length > `pasteThreshold` or text contains newlines or non-BMP characters.
- Sleeps `actionDelayMs` after each input action.
- UI elements: `shot` is the element in the latest-screenshot space of the display holding its centre (null with no
  size, off every display, or `relativeBounds`), so `click` and `ui_click` agree. `uiClick` uses the accessibility
  action (`focus` for a text box, else `press`) and clicks the centre with the real mouse only when the driver says
  the element has no such action (`ok:false`); it never clicks after `pending` / `confirmed:false`. Disabled elements
  throw DISABLED; several equally good matches throw AMBIGUOUS (listing ids, nothing pressed); nothing found is
  NOT_FOUND; no position to click is UI_ACTION_FAILED; off screen is OFFSCREEN. Errors meaning the element or window
  is gone or protected (STALE, STALE_ELEMENT, NOT_FOUND, BAD_ARGS, PERMISSION, UIPI_BLOCKED) are never followed by a
  click; a query (not an id) that hits STALE/STALE_ELEMENT is looked up once more. `uiSetValue` prefers
  `setValue`, else focus (or a centre click), primary+A and types (pastes long or multi-line text, deletes for "");
  without a role it prefers textbox, combobox and slider matches. Before a fallback click or typing, the element's
  window (when `listWindows` shows it; pop-up menus are left alone) is brought to the front, since the focus action
  does not raise windows in every toolkit and a covered centre belongs to another window; if it stays behind, the
  error is FOCUS_FAILED and nothing is sent. Warnings from the driver (also uiFind's
  non-enumerable `warnings`) are passed on. Ids seen in results are remembered 30 s for the fallback click.

### ocr.js (on-device text recognition)
```js
async available({ refresh? }) -> { engine: 'vision'|'windows'|'tesseract'|null, hint, engines: [{ engine, ok, note?, languages?, hint? }] }
async recognize({ png, region?, engine?, lang?, upscale?, pixelScale?, timeoutMs? })
  -> { engine, width, height, region, lines: [{ text, bounds, confidence, words: [{ text, bounds, confidence }] }], language?, notes? }
async findText(computer, { text, display?, region?, exact?, limit? })
  -> [{ text, shot: { x, y, width, height, cx, cy }, confidence, score, match: 'exact'|'contains'|'fuzzy', display, line }]  // .scan non-enumerable
async scanScreen(computer, opts), async readScreenText(computer, { display?, region? }) -> { engine, display, region, lines: [{ text, shot, confidence }], hint? }
matchText, normalizeText
```
- Engines: **Vision** on macOS (`darwin-ocr.js` under `osascript -l JavaScript`: `VNRecognizeTextRequest`, accurate,
  language correction, automatic language detection on macOS 13+, word boxes from `boundingBoxForRange`;
  `parseVisionOutput` flips the bottom-left origin); **Windows.Media.Ocr** on Windows and WSL (`win32-ocr.ps1`, always
  `powershell.exe` 5.1, never pwsh: WinRT through `System.Runtime.WindowsRuntime`, `TryCreateFromUserProfileLanguages`
  then any installed recognizer, `-Probe` mode; from WSL the script and image are staged in a private folder in the
  Windows `%TEMP%` and passed as `wslpath -w` paths); **tesseract** on Linux (and wherever installed): TSV from three
  parallel passes (`--psm 11`, `6`, `3`, each with `OMP_THREAD_LIMIT=1`) over a grayscale PGM with light-on-dark blocks
  flipped, plus a `--psm 6` pass over the dark regions stacked as clean inverted crops; small images are upscaled 2x;
  words merge by confidence and group into lines by position.
- A working engine is cached 5 minutes, a missing one 10 s; concurrent callers share one probe. No engine:
  `recognize` returns `{engine: null, lines: [], hint}`, `findText` throws OCR_UNAVAILABLE with the install hint
  (`sudo apt install tesseract-ocr`, an OCR language on Windows); nothing is installed automatically.
- `findText` captures the whole display at native resolution through `Computer.screenshot` with a region (which never
  changes the stored mapping), crops the requested region itself and maps the result to screenshot space.
  Matching ignores case, width and whitespace; fuzzy matching allows an edit distance of 1 for words of 3–7 letters
  and 2 for 8+ (at most 3 in all) and never swaps one digit for another.
- Environment: `ANYWHERE_OCR_ENGINE` (vision|windows|tesseract|none), `ANYWHERE_OCR_LANG`, `ANYWHERE_OCR_PSM`,
  `ANYWHERE_TESSERACT`.

### apps.js (installed apps)
```js
async listApps({ query?, limit?, refresh? }, deps?) -> { platform, total, apps: App[], notes }
async findApp(name, opts, deps?) -> { app, score, alternatives } | null
async launch(name, { args?, waitForWindow = true, timeoutMs = 20000, newInstance?, accessibility?, driver?, focus = true, signal? }, deps?)
  -> { app, launched, alreadyRunning, how, window, focused, timedOut?, waitedMs?, alternatives, notes }
async quit(name, { force?, driver?, timeoutMs = 8000 }, deps?) -> { app, found, running, how, windowsLeft, notes }
matchApps, windowMatchesApp, appWindows, launchPlan, catalog, clearCache, parseLnk, parseDesktopFile, parseExecLine, parsePlistXml/readPlist, runPowerShell, windowsFolders
```
- Catalog (cached 5 minutes): macOS `*.app` bundles in /Applications, ~/Applications and /System/Applications (names and
  bundle ids from Info.plist; binary plists through `plutil`); Windows and WSL Start Menu shortcuts (.lnk parsed here)
  plus `Get-StartApps` for Store apps; Linux `.desktop` files (XDG dirs, flatpak and snap exports; Hidden, NoDisplay,
  TryExec, OnlyShowIn/NotShowIn). Fuzzy matching knows everyday names ("vs code", "premiere", "terminal").
- `launch` focuses an app that already has a window unless `newInstance`; otherwise `open -a`, the shortcut or
  `shell:AppsFolder\<AUMID>`, `gtk-launch` or the Exec line; then waits for a new window (by pid, app or title) and
  focuses it. `accessibility` adds `--force-renderer-accessibility` for Chromium/Electron apps and, on Linux,
  `ACCESSIBILITY_ENABLED=1` / `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`.
- `quit` is polite by default: macOS `NSRunningApplication.terminate` (`forceTerminate` with `force`), Windows UI
  Automation WindowPattern.Close / CloseMainWindow, then `taskkill` (`/F` only with `force`), Linux `driver.closeWindow`
  when a driver has it, else `wmctrl -c`, then SIGTERM (SIGKILL only with `force`). It refuses Claude's own ancestor
  processes (PROTECTED) and never signals shared host processes.
- Every OS command goes through injectable `deps` (`run, which, launch, openTarget, fs, kill, now, sleep, env, platform,
  isWSL`); user data reaches PowerShell only as base64 literals (`-EncodedCommand`) and osascript only as argv.

### browsers.js (bookmarks, opening pages, tabs)
```js
BROWSER_DEFS, resolveBrowser(query) -> def | null
async bookmarks({ browser?, query?, folder?, profile?, limit?, prefer? }, deps?) -> { items, total, sources, notes, hints }
async open({ browser?, url, newTab = true, newWindow?, driver?, computer?, beforeInput?, timeoutMs?, signal? }, deps?)
async listTabs({ browser?, driver, computer?, cycle?, beforeInput? }, deps?) -> { browser, method, windows: [{ windowId, tabs }], note?, hint? }
async switchTab({ browser?, match?, index?, driver, computer?, beforeInput? }, deps?) -> { browser, method, tab, window }
```
- Bookmarks are read from disk for every profile, the bar first: Chromium family (`Bookmarks` JSON; Chrome, Brave,
  Edge, Chromium, Vivaldi, Opera, Arc), Firefox (`places.sqlite` through the `sqlite3` CLI on a copy, else the newest
  `bookmarkbackups/*.jsonlz4`, decoded here), Safari (`Bookmarks.plist`; needs Full Disk Access). Paths honour `HOME`,
  `XDG_CONFIG_HOME`, `LOCALAPPDATA` and `APPDATA`; WSL reads the Windows profiles under /mnt/c. `folder: 'bar'` means the
  bookmarks bar, toolbar or favourites.
- `open` reuses the running browser (a new tab, or `newWindow`; `newTab:false` loads in the current tab through
  AppleScript on macOS, else the keyboard); `javascript:`, `data:` and `vbscript:` URLs are refused.
- Tab methods: `applescript` (macOS Chromium browsers and Safari: titles, URLs, the active tab), `uia` (Windows: the
  tab strip's TabItems), `accessibility` (Linux: the tab strip through AT-SPI `uiFind {role: 'tab'}`, the top-most row of
  sibling tabs whose selected one is named like the window title; switched with `uiAction` press; no keys, and tabs with
  the same title stay apart), `keyboard` (with `cycle`: primary+1..8 / primary+9 and Ctrl+PageDown, checking the title
  after each key, `beforeInput` before every key; a later tab titled like the first one ends the cycle early), `title`
  (only each window's active tab).

---

## 5. Desktop context (`src/context/desktop.js`)
```js
async gatherContext({ driver, projectDir, config }) -> {
  os: { platform, osName, release, arch, user, hostname, displayServer },
  time: ISO,
  activeWindow: { app, title } | null,
  windows: [{ app, title }],                         // ≤ 25, excludes our own "Claude Anywhere" window
  editors: [{ app, workspaceName, path | null, active }],   // VS Code / Cursor / Windsurf / VSCodium / Zed / JetBrains from titles + VS Code storage.json
  browsers: [{ app, title, url | null }],
  tickets: [{ key, summary, browser, tracker: 'jira'|'linear'|'github'|'gitlab'|'azure', active? }],  // ≤ 8, from tab titles
  apps: [{ app, windows }],                          // running apps by window count (most first, ≤ 12; our dialog left out)
  defaultBrowser: { name, id, source: 'launchservices'|'registry'|'mimeapps'|'xdg-settings'|'default' } | null,
  project: { dir, name, git: { branch, remote, dirty } | null, stack: string[] },
  cloud: { gcloud: { account, project } | null, aws: { profile, region } | null, az: { subscription } | null,
           kubectl: { context } | null, docker: { running, accessible? } | null },  // accessible:false = daemon up, socket not readable by the user
  errors: string[]
}
formatContext(ctx) -> string        // compact "<desktop_context>…</desktop_context>" block, ≤ 2,500 chars
async detectProjects({ driver }) -> [{ dir, name, source: 'vscode'|'recent'|'cwd' }]
async projectInfo(dir) -> ctx.project
```
Every probe has a 2.5 s timeout and never throws.
`tickets` come from `parseTicketTitle(title)` (also exported, with `ticketsFromBrowsers`): Jira ("[ABC-1] Summary - Jira",
"ABC-1: Summary - Jira", "Summary - ABC-1 - Jira", Server "… - Acme JIRA"), Linear, GitHub and GitLab issues, and Azure
Boards ("AB#1234"); unbracketed keys count only next to a tracker's name. `formatContext` adds a line
`Tickets (from tab titles): ABC-1 "Summary" (Jira in Brave) [active]`. `read_browser_tab` falls back to the same parser,
so the tool and the context agree.
`formatContext` also prints `Running apps (by window count): Code (3), Brave Browser (2), …` and `Default browser: Brave`.
`readDefaultBrowser(sys?, deps?)` (exported; macOS LaunchServices plist, Windows/WSL the HKCU UrlAssociations choice
through reg.exe, Linux mimeapps.list then `xdg-settings`; cached 60 s, never throws) and `runningApps(windows, max?)`
(exported) feed them, and `anywhere computer apps` prints both.

---

## 6. MCP server (`src/mcp`)

`server.js`: a minimal MCP stdio server (newline-delimited JSON-RPC 2.0).
- `initialize` → echo the client's `protocolVersion`; capabilities `{ tools: { listChanged: false } }`; serverInfo `{ name: 'anywhere', version }`.
- `tools/list`, `tools/call`, `ping`; notifications are ignored. Unknown methods with an id → error `-32601`.
- Tool handler exceptions → result `{ content: [{type:'text', text: 'Error: …'}], isError: true }`.
- Exported: `startStdioServer({ name, version, tools, log })`, plus `main()` that runs the anywhere server when executed directly.

`tools.js`: `createTools({ computer, getClient /* async () => DaemonClient|null */, config, role })` → `[{ name, description, inputSchema, handler }]`.

| Tool | Input | Notes |
|---|---|---|
| `screenshot` | `{display?, region?:{x,y,width,height}, maxWidth?}` | returns `image/png` + text: size, scale, display count, cursor, active window, mapping note |
| `click` | `{x, y, button?, clicks?, modifiers?, display?}` | |
| `mouse_move` | `{x, y, display?}` | |
| `drag` | `{fromX, fromY, toX, toY, button?, display?}` | |
| `scroll` | `{direction:'up'|'down'|'left'|'right', amount?, x?, y?, display?}` | |
| `type_text` | `{text, method?:'auto'|'keys'|'paste'}` | |
| `key` | `{combo, repeat?}` | e.g. `"primary+s"`, `"enter"` |
| `cursor_position` | `{}` | |
| `screen_info` | `{}` | |
| `list_windows` | `{filter?}` | |
| `focus_window` | `{id?, title?, app?}` | title/app = case-insensitive substring |
| `open` | `{target, kind?:'auto'|'url'|'path'|'app', args?}` | |
| `clipboard_get` | `{}` | |
| `clipboard_set` | `{text}` | |
| `wait` | `{seconds}` | max 30 |
| `get_desktop_context` | `{}` | JSON of `gatherContext` |
| `notify_user` | `{message, level?, speak?}` | POST /api/mcp/notify; falls back to OS notification |
| `ask_user` | `{question, options?, timeoutSec?}` | POST /api/mcp/ask (blocks); an answer → text, a timeout or a cancelled/dismissed question → error result; without a daemon → error "dialog not running" |
| `permission_prompt` | `{tool_name, input, tool_use_id?}` | POST /api/mcp/permission (blocks) → text JSON `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`; without a daemon → allow |
| `read_browser_tab` | `{browser?, includeText?, maxChars? (200..200000, default 20000), windowId?}` | text JSON `{browser, title, url, jira: {key, baseUrl\|null, summary?}\|null, method, note?, hint?, settingsUrl?, windowId, otherWindows?, truncated?, text?}` (text last). `Computer.browserTab` (guard + failsafe before keys); isError when no (matching) browser window. Read-only annotations unless `includeText` |
| `jira_status` | `{}` | text JSON: `{configured:true, connected:true, baseUrl, email, deployment:'Cloud'\|'Server', user}`, `{configured:true, connected:false, …, error, hint}` or `{configured:false, how, missing?}`; never isError |
| `jira_get_issue` | `{key}` (ABC-123 or a Jira URL) | Markdown: facts (type, status, priority, assignee, reporter, sprint, points, labels, components, fix versions, parent, dates, link, `**Suggested branch:** \`KEY-slug\``), then Description, Acceptance criteria, Steps to Reproduce…, Subtasks, Linked issues, Attachments, last 10 Comments |
| `jira_search` | `{jql, max? (1..100, default 20)}` | "N issues match: <jql>" then `- KEY [Status] Summary (Type · Priority · Assignee)` lines |
| `jira_my_issues` | `{status?}` | open (default) \| todo \| in progress \| done \| all \| a status name; same lines |
| `jira_transition` | `{key, to}` | by status or transition name, case-insensitive; a miss is isError listing the valid ones |
| `jira_assign` | `{key, user}` | `me` \| `none` \| email \| accountId \| username \| display name; several matches → isError listing them (use ask_user) |
| `jira_comment` | `{key, text}` | Markdown, sent as ADF (Cloud) or wiki markup (Server) |
| `jira_find_user` | `{query}` | display name, email, accountId (Cloud) or username (Server) |
| `find_repos` | `{query?, limit? (1..50, default 12)}` | text JSON `{query, repos:[{name, path, remote, branch, lastCommit, source: editor\|current\|recent\|workspace\|scan\|home\|query, score?, …}], searched, timedOut?, hint?}`: git repositories (open editors, `workspace.roots`, common code folders, the current project), ranked; read-only, no git process except `git log -1` |
| `switch_project` | `{dir, task, create?, gitInit?}` | POST /api/mcp/switch-project; the daemon switches when the turn ends, a fresh session there gets `task` with source `handoff` |
| `batch_actions` | `{actions: [{type, …args}] (1..20), screenshotAfter?}` | step types click, double_click, right_click, move, drag, type, key, scroll, wait (≤ 10 s), focus_window, ui_click, each run as its single tool (`batchStepCall`); every step is validated before any runs; the guard is checked before each step; stops at the first failure and says which steps ran; no final screenshot after PAUSED or FAILSAFE |
| `ui_find` | `{name?, text?, role?, window?, exact?, limit? (≤ 50, default 10)}` | tools-ui: matches as `- role "name" = "value" at (x, y) on display d [state] · id`, (x, y) in screenshot pixels; driver notes and warnings as `Note:` lines. `window` = id, part of a title or app name; default the focused window, or the frontmost other one while the dialog has focus |
| `ui_tree` | `{window?, depth? (≤ 20, default 8), maxNodes? (≤ 300, default 200)}` | indented outline with roles, names, values, centres, states (checked, expanded, off screen…) and ids; lists open pop-ups (Windows) |
| `ui_click` | `{id? \| name? \| text?, role?, window?, exact?, screenshotAfter?}` | `Computer.uiClick`: accessibility press, else a real click at the centre; AMBIGUOUS lists candidate ids |
| `ui_set_value` | `{value, id? \| name? \| text?, role?, window?, exact?, screenshotAfter?}` | `Computer.uiSetValue`; `value: ""` clears the field (`minLength: 0` lets a required string be empty in the validator) |
| `find_text` | `{text, display?, region?, exact?, limit?}` | tools-ocr: `1. "For you" center (311, 216), box 290,210 41x11, exact, confidence 0.97`; a miss lists lines with similar words; no engine → isError with the install hint. Read-only |
| `read_screen_text` | `{display?, region?, maxLines?}` | lines in reading order as `(cx, cy) WxH: text`, at most 40,000 characters. Read-only |
| `list_apps` | `{query?, limit?}` | tools-desktop: installed apps, `[running]` when a window is open. Read-only |
| `launch_app` | `{name, args?, waitForWindow? = true, timeoutSec? = 20, newInstance?, accessibility?, screenshotAfter?}` | fuzzy name; focuses an app that already has a window; returns the window (id, title, geometry) |
| `quit_app` | `{name, force?}` | polite quit; `force` terminates; PROTECTED for Claude's own terminal/editor |
| `set_window` | `{window, bounds? \| state?, screenshotAfter?}` | states maximize, minimize, restore, fullscreen, left-half, right-half; bounds in `list_windows` coordinates (`driver.setWindowBounds`) |
| `wait_for` | `{window?, text?, gone?, timeoutSec? (≤ 120, default 15), display?, exact?}` | polls `listWindows`; text through `ocr.findText` within the window's region, else `Computer.uiFind`; a timeout is isError. Read-only |
| `browser_bookmarks` | `{browser?, query?, folder?, profile?, limit?}` | `folder: "bar"` = bookmarks bar / toolbar / favourites. Read-only |
| `browser_open` | `{url, browser?, newTab? = true, newWindow?, screenshotAfter?}` | `browser` may also be an executable path |
| `browser_tabs` | `{browser?, cycle?}` | AppleScript (macOS), UI Automation (Windows), AT-SPI (Linux), else window titles; `cycle` reads every tab with the keyboard |
| `browser_switch_tab` | `{browser?, match? \| index?, screenshotAfter?}` | `index: -1` = last tab |

**screenshotAfter.** `click`, `mouse_move`, `drag`, `scroll`, `type_text`, `key` and `focus_window` (plus `ui_click`,
`ui_set_value`, `launch_app`, `set_window`, `browser_open`, `browser_switch_tab` and `batch_actions`) take
`screenshotAfter: true`: after a 350 ms settle (`SHOT_AFTER_SETTLE_MS`) the result also carries a screenshot of at most
1024x640 (`SHOT_AFTER_MAX_WIDTH/HEIGHT`) of the display the action happened on (else the window's, else the pointer's),
which becomes the latest screenshot for later coordinates; the "take a screenshot to verify" advice is dropped from
the text. Feature modules get it as `ext.screenshotAfter` in two forms: `screenshotAfter(result, args, {display?,
window?, signal?})` appends the blocks to a non-error result when `args.screenshotAfter` is true, and
`screenshotAfter({display?, window?, signal?})` returns just the `[image, text]` blocks; `ext.screenshotAfterSchema`
is the shared property schema. Exports: `TOOL_NAMES` (the 19 contract tools, unchanged), `EXTRA_TOOL_NAMES`
(`batch_actions`, listed right after them, before the module tools), `TOOL_MODULES`, `BATCH_STEP_TYPES`,
`BATCH_STEP_TOOL`, `SCREENSHOT_AFTER_TOOLS`, `MAX_BATCH_STEPS = 20`, `MAX_BATCH_WAIT_SEC = 10`, and the helpers
`batchStepCall`, `batchStepProblem`, `batchStepLabel`, `withoutVerifyHint`.
The desktop tools (tools-ui, tools-ocr, tools-desktop) that change the desktop call the guard (and the failsafe
corner) first and post activity afterwards; the reads only post activity. `createDesktopOps(ctx)` in tools-desktop
is shared with the CLI (`anywhere desktop …`).

Jira tools without a connection (config `jira.*`, else env `JIRA_BASE_URL`/`JIRA_URL`, `JIRA_EMAIL`/`JIRA_USER`,
`JIRA_API_TOKEN`/`JIRA_TOKEN` and `ATLASSIAN_*` equivalents) return isError with exactly: "Jira isn't connected: run
\`anywhere jira setup\`, or add it in Settings → Jira, or read the ticket from the browser with read_browser_tab."
Writes (`jira_transition`, `jira_assign`, `jira_comment`, `switch_project`) call the guard first and post activity.
The client (`src/integrations/jira.js`, `JiraClient({baseUrl, email, apiToken, deployment?, timeoutMs=15000})`) uses
Basic email:token with REST v3 on Cloud and a Bearer personal access token with REST v2 on Server/Data Center (on a
401 it retries once with Basic username:password when a username is set), follows redirects only within the site, honours
`HTTPS_PROXY`/`NO_PROXY`, and never puts the token in an error. `server.js` `buildInstructions()` tells Claude when to
use `read_browser_tab`, the Jira tools (or an Atlassian MCP server, or the page) and `find_repos`, and, for the
engine role, `switch_project`.

Every input-action tool posts fire-and-forget `POST /api/mcp/activity` `{tool, summary, ok, error?}` and
`screenshot` also posts `{tool:'screenshot', image: <base64 png>, width, height}`. Before each input action the
server calls `GET /api/mcp/guard` (200 ms timeout; unreachable daemon → allowed).

Environment: `ANYWHERE_DAEMON_URL`, `ANYWHERE_TOKEN`, `ANYWHERE_ROLE` (`engine` when spawned by the daemon's
engine, else `interactive`).

While a blocking call (`ask_user`, `permission_prompt`) waits, the server sends
`notifications/progress` (`{progressToken: params._meta.progressToken, progress: n, message}`) every 15 s when the
request carried a progress token, so Claude Code's stdio idle timeout never fires.

---

## 7. Daemon (`src/daemon`)

### main.js
`async runDaemon({ project, mode, ui, open = true })`: load config, start HTTP on `config.port`
(random port if busy), write daemon state (`url = http://127.0.0.1:<port>/?token=<token>`), open the
UI, handle SIGINT/SIGTERM/SIGHUP (stop engine, close UI host, clear state, exit 0).

### hub.js
```js
class Hub { addClient(req, res); broadcast(type, data); clientCount(kind?); dialogCount(); close() }  // SSE with 15 s heartbeat comments
```
Clients say what they are with `GET /api/events?client=ui|tui|cli` (the dialog page, `anywhere tui`, and watchers
such as `anywhere send --wait`; `DaemonClient.subscribe(onEvent, {kind})` adds it). `dialogCount()` = ui + tui
clients: `notify_user` reports `delivered` from it, and an approval or question reopens the dialog window (or
shows an OS notification) only when it is 0. A CLI watcher does not count.

### server.js — HTTP API
Bind `127.0.0.1` only. Security on **every** request:
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defense), else 403.
- `/api/*` (except `GET /api/health` and `POST /api/launch`) requires the token: `Authorization: Bearer`, `X-Anywhere-Token`, or `?token=` (SSE only), compared with `crypto.timingSafeEqual`.
- Launch codes: process command lines are readable by every local user, so a browser is never started with the
  token URL. `server.launchUrl()` mints `http://127.0.0.1:<port>/?launch=<code>` (18 random bytes, base64url,
  single use, valid 60 s; at most 64 outstanding) and UiHost asks for a fresh one for every browser launch. The
  page trades it through `POST /api/launch` (no token; the Origin check applies) before its first API call, keeps
  the token in sessionStorage and removes `launch` from the address bar. `get url` (the token URL) is unchanged:
  it is printed to the user's own terminal and given to Electron through its environment.
- While the daemon shuts down, `POST /api/command`, `/api/session/new`, `/api/project`, `/api/mode` and `/api/show`
  answer 503 ("Claude Anywhere is shutting down").
- Non-GET requests with an `Origin` header must match `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- JSON bodies ≤ 25 MB; `/api/stt` audio ≤ 25 MB.
- HTML has CSP `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'`.

| Method & path | Body | Response |
|---|---|---|
| GET `/` and static `/app.js` etc. | | files from `src/ui` (no auth; static only) |
| GET `/api/health` | | `{ok, app:'claude-anywhere', version, instanceId, pid, home, uid}` (`home`: a non-secret id of the state dir); 503 `{ok:false, shuttingDown:true, …}` while the daemon stops |
| POST `/api/launch` | `{code}` (no token) | `{token}` once per code; 401 for an unknown, used or expired code |
| GET `/api/permissions` | | `{platform, permissions}`: the daemon driver's `capabilities().permissions` (macOS TCC state, read-only) or null |
| GET `/api/events?token=` | | SSE stream; first event `snapshot` |
| GET `/api/state` | | snapshot |
| POST `/api/command` | `{text, attachScreenshot?, images?:[{mediaType,data}], source?:'text'|'voice'|'cli'|'skill'}` | `{ok, id, mode, bridge:{listening}}` |
| POST `/api/interrupt` | | `{ok}` |
| POST `/api/approval` | `{id, decision:'allow'|'allow_session'|'deny', message?, via?:'click'|'key'|'typed'|'voice'}` | `{ok}`; 409 `{code:'CRITICAL_NEEDS_CLICK'}` for an allow of a critical card sent by voice or key (the card stays). `via` is how the user answered: the dialog sends click or key (Enter/Esc on the card) or voice, the TUI typed or voice; other values are ignored, and older clients send none |
| POST `/api/answer` | `{id, text}` | `{ok}` |
| POST `/api/session/new` | | `{ok, sessionId}` |
| POST `/api/project` | `{dir, force?}` | `{ok, project}` (restarts engine in the new cwd); 409 while a task runs unless `force:true`, which stops it first. Bridge commands that only wait for a terminal get their own 409 text ("A command is waiting for a Claude Code terminal…"); forced, they are dropped (`commands_cancelled` reason `reset`) |
| GET `/api/projects` | | `{projects:[…]}` |
| GET `/api/config` · POST `/api/config` | partial config | public config |
| POST `/api/mode` | `{mode, force?}` | `{ok, mode, moved?}`; 409 while a task runs unless `force:true`. Bridge commands that only wait for a terminal (none listens, none took a command, no card is open) do not make it busy: a switch to companion mode sends them to the dialog's own session under their ids (`moved`: how many) |
| POST `/api/stt` | raw `audio/wav` (also webm/ogg/mp4 pass-through) `?language=` | `{text, provider}` |
| POST `/api/tts` | `{text}` | `{ok, provider}` |
| POST `/api/tts/stop` | | `{ok}`: stops daemon speech and playback, and drops the announcements still queued (barge-in) |
| GET `/api/tts/audio?id=` | | `audio/wav` bytes of a `/api/tts/synthesize` id (32 hex) or a chime (`chime-done\|info\|permission\|question\|error`); 400 malformed id, 404 unknown (gone from the cache of the last 60); HEAD supported |
| POST `/api/tts/synthesize` | `{text, voice?, rate?}` | `{id, mime:'audio/wav', engine:'piper', durationMs, cached}`; 503 + hint when Piper is not installed |
| GET `/api/voice/status` | | `{engine, ttsEngine, piper:{installed, binary, binaryKind, voice, installedVoices, installing, catalog:[{id, name, language, gender, quality, sizeMb, sampleText, description, installed}]}, os:{provider, hint?}, player:{available, players, hint?}, announcer}` |
| POST `/api/voice/install` | `{voice?, force?}` | `{ok, started:true, voice}` (or `{ok, started:false, running:true, voice}` while one runs); progress as SSE `voice_install`; on success saves `voice.piperVoice` and refreshes the snapshot |
| POST `/api/voice/use` | `{voice}` | `{ok, voice}`; 400 bad id, 409 + hint when that voice is not installed |
| POST `/api/voice/test` | `{text?}` | `{ok, delivered:'dialog'\|'local'\|'none'\|'skipped', engine, text, error?}`: a sample through the announce path (ignores the announce toggles) |
| POST `/api/voice/remove` | `{voice}` | `{ok, removed}` |
| GET `/api/jira/status[?check=1]` | | `{configured, baseUrl, email, tokenSet, missing:[…], source:{baseUrl, email, apiToken: 'config'\|'env:NAME'\|null}, urlError?, deployment:'Cloud'\|'Server'\|null}`; `check=1` adds `{connected, user?, error?, hint?}`. Never returns the token |
| POST `/api/jira/test` | `{baseUrl?, email?, apiToken?}` | 200 `{ok:true, user:{displayName, email, accountId}, deployment, baseUrl, serverTitle?}`; a Jira failure 422 `{ok:false, error, code, hint?, jiraStatus?}`; bad input 400 `{error, hint?, code:'JIRA_NOT_CONFIGURED'\|'JIRA_BAD_URL'\|'JIRA_NO_TOKEN'}`. Unsent or empty fields come from the saved settings; the saved token goes only to the saved site |
| POST `/api/mcp/switch-project` | `{dir, task, create?, gitInit?, role?}` | from the dialog's session during its turn: `{ok, scheduled:true, dir, replaced?, created?, initialized?}` (switches when the turn ends); from the user's terminal (`role:'interactive'`) to an idle dialog: `{ok, scheduled:true, immediate:true, dir}`; already the project: `{ok, scheduled:false, same:true, dir}`. 400 bad input / relative path / missing folder without `create`; 409 `BRIDGE_MODE`, `BUSY` or `NO_TURN` (checked before any mkdir); 413 task too long; 422 git init failed. On WSL `C:\x` becomes `/mnt/c/x` |
| GET `/api/context` | | gatherContext JSON |
| POST `/api/show` | | `{ok, host}` |
| POST `/api/shutdown` | | `{ok}` then exit |
| POST `/api/mcp/permission` | `{tool_name, input, tool_use_id}` | `{behavior, updatedInput?, message?}` (blocks) |
| POST `/api/mcp/ask` | `{question, options?, timeoutSec?}` | `{id, answer}`, `{id, timeout:true}` or `{id, cancelled:true, reason}` (blocks; `cancelled` when the user stops the turn, the caller disconnects or the daemon shuts down). Bridge mode: 409 `{code:'COMMAND_STOPPED'}` after Stop cancelled the terminal's command, until its next listen (`anywhere ask` prints STOPPED and exits 5; the MCP `ask_user` tells Claude to abandon the command) |
| POST `/api/mcp/notify` | `{message, level?, speak?}` | `{ok, delivered}` |
| POST `/api/mcp/activity` | `{tool, summary?, ok?, error?, warning?, image?, width?, height?}` | `{ok}` |
| GET `/api/mcp/guard` | | `{allowed, reason?}`; bridge mode refuses the screen actions of a command the user stopped until the terminal listens again (at most 10 min) |
| POST `/api/bridge/listen` | `{timeoutSec ≤ 590}` | `{command:{id,text,images:[path],context,source}}` or `{timeout:true}` or `{stop:true}` |
| POST `/api/bridge/reply` | `{text, final?, speak?}` | `{ok}`; 409 (with a hint) when the dialog is in companion mode: `anywhere reply` then prints STOP and exits 3. 409 `{code:'COMMAND_STOPPED'}` after Stop cancelled the terminal's command, until its next listen: the reply is not shown, and `anywhere reply` prints STOPPED and exits 5 |
| POST `/api/ui/visibility` | `{page, visible, focused?}` | `{ok}`: a dialog page (its own id per page load) reports whether it can be seen when its event stream opens, after a `show` event and on `visibilitychange`; `UiHost.show()` opens a window when every page reports hidden, and the announcer plays announcements itself then |

### SSE events (server → UI): `event: <type>` + `data: <json>`
- `snapshot` `{version, mode, status, statusDetail, project:{dir,name,git}, session:{id, model, costUsd, turns}, messages:[…], pending:{approvals:[…], questions:[…]}, config:<public>, voice:{serverStt, sttProvider, serverTts, ttsProvider, engine:'piper'|'os'|'browser'|null, ttsEngine, piper:{installed, voice}, announcer, sttHint?, ttsHint?}, bridge:{listening, queued}, platform:{platform, displayServer, driver}, screenshot:{dataUrl,width,height,ts}|null}`
- `status` `{status:'idle'|'starting'|'thinking'|'acting'|'waiting_approval'|'waiting_answer'|'stopping'|'queued'|'error'|'offline', detail?}`
  (`queued`: bridge commands wait for a terminal to run `/anywhere here`; Stop drops them)
- `message` (transcript item; see below), `delta` `{id, text}` (append to an assistant item)
- `tool_update` `{toolUseId, status:'ok'|'error', output?, image?}`
- `approval_request` `{id, toolName, displayName, summary, input, risk, reason, sessionRule, ts}` · `approval_resolved` `{id, decision, by?, via?, message?}`
- `question` `{id, question, options, ts}` · `question_resolved` `{id, answer}`
- `notify` `{text, level, speak}` · `result` `{text, costUsd, totalCostUsd, durationMs, isError, sessionId, numTurns, commandIds, interrupted?, handoff?:{dir}}`
  (`handoff`: switch_project moves the work on to `dir`; a `project` event and a new user item with source `handoff` follow)
  (`commandIds`: the commands this result answers, so a command queued during a turn waits for the next result;
  `interrupted` marks a turn the user stopped; `engineInitiated:true` with `commandIds: []` marks a turn Claude Code
  started by itself after a background task finished)
- `commands_cancelled` `{commandIds, reason:'stopped'|'reset'|'cancelled'|'interrupted'|'engine_exit'|'failed'}`: these
  commands will get no `result` (Stop, a new session, a project or mode switch dropped them, or Claude Code exited);
  `interrupted`: Claude had the command, so it may have partly run. `anywhere send --wait` ends on it (exit 130 for
  stopped and interrupted)
- `screenshot` `{dataUrl, width, height, ts}` · `project` `{dir, name, git}` · `session` `{id, model}`
- `config` `<public config>` · `mode` `{mode}` · `bridge` `{listening}` · `show` `{}` · `error` `{message}`
- `announce` `{id:'an_<uuid>', kind:'done'|'permission'|'question'|'error'|'info', text, audio:null|{id, mime:'audio/wav', durationMs}, chime, ts}`:
  sent only while a dialog page (`?client=ui`) is connected and visible; the page plays it (see §8). `audio.id` is for
  `GET /api/tts/audio`; `chime` is false for spoken notifications and hand-offs, else `voice.chime !== false`
- `voice_install` `{stage:'binary'|'voice'|'verify'|'done'|'error', percent (overall 0-100, never decreasing), stagePercent:number|null, message, voice}`;
  the last event is `done` or `error` (its message includes the fix)

Transcript items (`message` event and `snapshot.messages`):
```js
{ id, role: 'user', text, source, ts, images }                                  // images = count; source text|voice|cli|skill|handoff
{ id, role: 'assistant', text, ts, streaming: bool }
{ id, role: 'tool', toolUseId, name, displayName, summary, input, status: 'running'|'ok'|'error', output, image, parentToolUseId, ts }
{ id, role: 'system', text, level: 'info'|'success'|'warning'|'error', ts }
```

### engine-cli.js
```js
class ClaudeCliEngine extends EventEmitter {
  static async locate(config) -> { path, version } | null   // config.engine.claudePath | env ANYWHERE_CLAUDE_PATH | which('claude')
                                                             // | <dirname(process.execPath)>/claude(.cmd) | known install paths
  constructor({ claudePath, cwd, sessionId, resume: bool, mcpConfigPath, systemPromptPath, allowedTools,
                model, fallbackModel, effort, chrome, addDirs, maxBudgetUsd, extraArgs, env,
                permissionMode, settingsPath, baseEnv, stripEnv })
  start()                    // spawn; emits 'spawn'
  send(contentBlocks)        // writes {"type":"user","message":{"role":"user","content":[…]}}\n
  async interrupt()          // control_request {subtype:'interrupt'}; resolves on the turn's result, or (no turn
                             // active) on the control_response matching its request_id; SIGKILL after 4 s only for an active turn
  async stop()               // end stdin, SIGTERM, SIGKILL after 3 s
  get running()
  // events: 'message' (every parsed stdout JSON line), 'stderr' (line), 'exit' ({code, signal, stderrTail})
}
```
`locate()` returns a configured path (engine.claudePath, ANYWHERE_CLAUDE_PATH) as soon as it is a usable file; among
discovered candidates it prefers the first that answers `--version` (a broken shim earlier on PATH must not hide a
working install) and falls back to the first usable file only when none does. Turn state is tracked from send,
init and result.

Args (in this order):
`-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
`(--session-id <uuid> | --resume <id>) --mcp-config <file> --permission-prompt-tool mcp__anywhere__permission_prompt`
`--permission-mode default [--settings <runDir>/settings-<instanceId>.json]`
`--append-system-prompt-file <file> --allowedTools <comma list>`
`[--model] [--fallback-model] [--effort] [--chrome] [--max-budget-usd] [...extraArgs] [--add-dir <dir>...]` (add-dir last because it is variadic).
`--permission-mode default` pins the mode, so a `permissions.defaultMode` in the user's settings cannot bypass the
dialog's approvals; `engine.permissionMode` overrides it, and both flags are left out when `engine.extraArgs` sets
them. The settings file is `{"enabledPlugins":{"anywhere@anywhere-marketplace":false, …every anywhere@* key from the
user/project settings: false}}`, so the plugin's copy of the desktop tools and the /anywhere skill stay off inside
the daemon's own session.
`--disallowedTools mcp__plugin_anywhere_anywhere` keeps a plugin copy of the anywhere MCP server out of the
engine (its tools would duplicate the daemon's own server, which runs with `ANYWHERE_ROLE=engine`).
Env: `process.env` minus `engine.stripEnv` and minus any `ANYWHERE_ENGINE_CHILD` (set by older daemons, now
unused: the MCP server always serves its tools); on POSIX the directory of `process.execPath` is prepended to `PATH`
when missing, so `#!/usr/bin/env node` shims resolve; `MCP_TOOL_TIMEOUT` raised to at least 3600000 (an inherited
larger value is kept, a smaller or invalid one is replaced, since approvals and `ask_user` block inside MCP calls) and
`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` (blocking `ask_user` calls must not be auto-backgrounded after 2 min);
`BASH_DEFAULT_TIMEOUT_MS=600000` (deploys and builds outlast the 2-minute default; a larger inherited value is kept).
MCP config file: `{"mcpServers":{"anywhere":{"type":"stdio","command":<process.execPath>,"args":[<PACKAGE_ROOT>/src/mcp/server.js],
"env":{"ANYWHERE_DAEMON_URL":"http://127.0.0.1:<port>","ANYWHERE_TOKEN":<token>,"ANYWHERE_ROLE":"engine"},"alwaysLoad":true,
"timeout":86460000}}}`. The per-server `timeout` (86400 s + 60 s) overrides `MCP_TOOL_TIMEOUT` for this server only, so
Claude Code never cancels a pending approval or question before the broker's own deadline (`approvalTimeoutSec` is
read live and capped at 86400 s). On win32, `.cmd` shims are resolved to the `cli.js` they run (started with
`process.execPath`) or to an `.exe`, and launched without cmd.exe; the cmd.exe fallback (`shell: true`, every argument
quoted) refuses a UNC cwd (error code `UNC_CWD`). The system prompt and MCP config always go through files, so no
argument holds newlines.

Interrupt message: `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}`.
On POSIX, interrupt and stop also signal the command trees the CLI started in other process groups (Bash tool
commands, background tasks): SIGTERM first, then SIGKILL if they outlive it.

### session.js
```js
class SessionManager extends EventEmitter {
  constructor({ config, hub, permissions, questions, bridge, computer, driver, port, token, projectDir, mode })
  snapshot() -> snapshot payload
  async submit({ text, images, attachScreenshot, source }) -> { id }
  async interrupt()
  async newSession()
  async setProject(dir, { force, fresh?, keepTranscript?, note? })   // 409 while busy (a turn, queued follow-ups, approvals, questions, busy bridge) unless force
  setMode(mode, { force })
  handoffCheck({ dir, from }) -> { same, dir }       // throws 503 / 400 / 409 BRIDGE_MODE | BUSY | NO_TURN
  handoff({ dir, task, from: 'engine'|'interactive' }) -> { scheduled, dir, same?, immediate?, replaced? }
  async shutdown()
}
```
- Companion mode: lazily starts the engine. Content blocks = `[{type:'text', text: formatContext(...)}]`
  (if `context.attachDesktopContext`) + image blocks `{type:'image', source:{type:'base64', media_type, data}}`
  + `{type:'text', text}`.
- Engine stream normalization:
  - `system/init` → `session` event; warn if the `anywhere` MCP server isn't `connected`.
  - `stream_event` `content_block_start`/`content_block_delta` (`text_delta`) with `parent_tool_use_id == null` → `message`/`delta`.
  - `assistant` → finalize text items (full text replaces streamed text); each `tool_use` block → tool item (`running`).
  - `user` `tool_result` → `tool_update` (output truncated to 4 KB; image → `image` dataURL + `screenshot` event).
  - `result` → `result` event; status `idle`; persist sessionId in `sessions.json`.
  - Unexpected exit → system error item, status `error`; the next submit spawns with `--resume`.
- `displayName`: `mcp__anywhere__click` → `Click`, `Bash` → `Run command`, `Edit` → `Edit file`, and so on. `summary`: a
  short human description (command, file path, coordinates, URL, text preview ≤ 80 chars).
- Bridge mode: `submit` enqueues to the Bridge (context string included; images are written to `runDir()` PNG files).
  `listening` stays true while a dequeued command has no final reply (a 30-minute window, refreshed by activity,
  notify and ask); `POST /api/bridge/reply` returns 409 when bridge mode is off.
- One user message is with the CLI at a time. Commands submitted during a turn are held by the daemon (info line
  "Queued: Claude reads this when the current task finishes (Stop cancels both).") and sent together as one message
  after that turn's result. Stop drops them ("Stopped. Dropped N queued command(s)."), and a Stop while idle does not
  contact the CLI.
- A result that arrives before init (resume of an unknown id) is not reported. Only "No conversation found…" stderr
  triggers the fresh-session retry; other early exits keep `sessions.json`.
- New session and project switch clear the broker's session allow rules and cancel commands still being prepared.
  `session.engineAddDirs` holds the `--add-dir` folders of the running engine (reset when it stops or the project
  changes); main.js hands them to the broker (`getExtraDirs`).
- Settings: only engine settings (model, effort, Chrome, extra args… see `signature()`) restart the engine, with the
  next command (the conversation resumes); while Claude Code runs background tasks the restart waits, with a notice.
  Prompt-only settings (approval mode, spoken replies…) reach Claude as a `<settings>` block with the next message.
- Approval and question cards: `createAttentionHandler()` in main.js reopens the dialog when no dialog page or TUI is
  connected (`dialogCount()` is 0) and posts an OS notification (both throttled). Speaking them is the announcer's job
  (`announcer.js`, below); the handler's own `attentionSpeech()` is used only when the announcer could not start.
- Bridge mode, mode switch: commands that only wait for a terminal move to the companion session (same ids, their
  context and images); a terminal's command in progress is announced `interrupted`.
- The transcript keeps at most 12 screenshots and 8 MB of image data; older images are dropped from the items.
- Hand-off (`switch_project`, `POST /api/mcp/switch-project`): from the dialog's own session it is scheduled for the
  end of the current turn; that turn's `result` carries `handoff:{dir}`, then `setProject(dir, {force, fresh: true,
  keepTranscript: true, note})` starts a new conversation there (the transcript stays on screen) and `submit({text:
  task, source:'handoff'})` sends the task. A Stop, an error result, a new session, a mode or project switch, or the
  engine exiting cancels it (with a transcript line); commands the user sent during the turn go first, with a note to
  Claude that the switch did not happen. From the user's terminal (`role:'interactive'`) an idle dialog switches at once.
- `READ_ONLY_TOOLS` (`--allowedTools`): screenshot, cursor_position, screen_info, list_windows, get_desktop_context,
  wait, notify_user, ask_user, clipboard_get, find_repos, jira_status, jira_get_issue, jira_search, jira_my_issues,
  jira_find_user, and the desktop assistant's reads ui_find, ui_tree, find_text, read_screen_text, list_apps,
  browser_bookmarks, wait_for. `read_browser_tab` and `browser_tabs` are not (with `includeText` / `cycle` they send
  keystrokes), so the broker judges each call. Every pre-approved tool is low risk in permissions.js.
- Transcript names of the desktop tools match `permissions.displayName` (ui_click → "Click UI element", set_window →
  "Arrange window", batch_actions → "Run several actions"…); their summaries are short (`"For you" (tab) in Brave`,
  `3 steps: click, type, key`), and a secret-looking `ui_set_value` value shows only its length.
- main.js: `run/daemon.lock` is the start lock. Ports are tried in this order: the one recorded in
  `run/last-port.json` for the configured port, the configured port, its 19 neighbours in an order rotated by a hash of
  the state dir, then a random free port. A busy port means ALREADY_RUNNING (exit 0; `anywhere start` keeps waiting for
  that daemon) only when its `/api/health` reports the same `home` and `uid`; a daemon of another user or
  `ANYWHERE_HOME` just moves this one to the next port, and our own daemon that is shutting down is waited for.
  Shutdown removes `daemon.json` first, so nothing reuses a daemon that is going away. A saved
  `mode` (Settings or `config set mode`) switches the session live; `privacy.*` applies to the daemon and, on its next
  config read, to the MCP server.

### permissions.js
```js
classify(toolName, input, { projectDir, platform?, homeDir?, extraDirs?, focusedApp?, focusedProcess? })
  -> { risk: 'low'|'medium'|'high'|'critical', reason, summary, parts?, sensitive? }   // sensitive: true for an edit of a sensitive file
sessionRuleFor(toolName, input, cls, opts) -> string | null   // null: no "Always (session)" rule is safe (the card disables it)
class PermissionBroker {
  constructor({ config, hub, onNeedAttention, projectDir?, getProjectDir?, getExtraDirs?, activeWindow? })
    // getExtraDirs: the engine's --add-dir folders (session.engineAddDirs); activeWindow: the driver's, for type_text
  async request({ tool_name, input, tool_use_id }) -> { behavior:'allow', updatedInput } | { behavior:'deny', message }
  resolve(id, decision, message, { via? }) -> bool   // throws 409 CRITICAL_NEEDS_CLICK: critical allow by voice or key
  cancelAll(reason)
  pending() -> [...]   // cards carry sessionRule (string, or null when "Always" is not offered)
  setMode(mode)
}
```
`extraDirs` (from `getExtraDirs`, the VS Code workspaces passed to the engine with `--add-dir`) are judged like
the project folder for edits. `focusedProcess` is the focused window's process name when the driver reports
`process`. Session rules are scoped: cloud CLIs get the verb plus the resource (`Bash(gcloud run deploy shop-api*)`),
other commands their first two words, a command whose second word is an option the exact command, file edits their
folder (`Write(<folder>/**)`). Delete, disable and IAM-policy verbs, commands that read or send credentials, sensitive files
and edits with no path get none (`sessionRule: null`), and a session rule never covers a credential read, a
sensitive file or settings. `resolve()` records `via` in the audit entry and the `approval_resolved` event.
Policy: `ask` allows only `low`; `smart` (default) allows `low` and `medium`; `auto` allows everything except `critical`.
`alwaysAsk` patterns force a prompt. Session `allow_session` rules and config `alwaysAllow` (`"ToolName"` or
`"Bash(prefix*)"`) allow, except for `critical`. Timeout → deny with "No response from the user within N s"
(`approvalTimeoutSec`, read live, capped at 86400 s to stay below the engine's per-server MCP timeout).
Every decision is written to the audit log. The anywhere `open` tool with `args` is classified like the command it
runs (`{target:'bash', args:['-c', …]}` gets the verdict of that `bash -c`): at least high for shells, interpreters,
PowerShell, cmd/osascript/wscript/cscript/mshta, and terminal emulators given a command (`-e`, `--`, `-x`,
`--command`); its summary shows the arguments. `type_text` is judged by where it lands (the broker asks the
driver for the focused window): command-shaped text keeps its full verdict in any app (focus never lowers it);
only known non-terminal apps (chat, mail, office, notes) relax a plain sentence to medium; in a terminal, with a
Return, or in an unknown app the text gets full scrutiny.
Ticket tools: `read_browser_tab` is low without `includeText`, medium with it (it focuses the browser and uses the
keyboard and clipboard); `find_repos` and the Jira reads are low; `jira_transition`, `jira_assign` and `jira_comment`
are medium (a comment with a secret-looking value is high and gets no session rule); `switch_project` is medium, high
for a system, credential or root folder or for creating a folder outside home, and never gets a session rule. Tools
of a Jira/Atlassian/Confluence MCP server: reads low, writes medium, deletes and "destructive" tiers high.
Desktop-assistant tools (`desktopToolVerdict`, `DESKTOP_TOOLS`): the reads (ui_find, ui_tree, find_text,
read_screen_text, list_apps, browser_bookmarks, browser_tabs, wait_for) are low, except `browser_tabs {cycle: true}`
(keyboard) which is medium. `ui_click`, `set_window` and `browser_switch_tab` are medium. `ui_set_value` is medium, high
for a secret-looking value, and gets `type_text`'s scrutiny of the text. `launch_app` is judged like `open {kind:'app',
args}` (medium for an app, at least high with a shell or interpreter command). `quit_app` is medium, high with `force`,
for a system process (Finder, explorer, dwm, gnome-shell…) or Claude Anywhere / Claude Code itself. `browser_open` is
medium for web pages, `about:` and local files, high for other schemes and executables. `batch_actions` classifies
each step as its single tool (`batchStepCall`, which must agree with the one in tools.js) and takes the riskiest; its
card lists every step. A high desktop-tool call is `sensitive` (its own card), and `sessionRuleFor` returns null for it
and for every `batch_actions` (an "Always" for one batch would approve any later batch).

### questions.js · bridge.js
```js
class QuestionBroker { constructor({hub, onNeedAttention}); async ask({question, options, timeoutSec=900}); answer(id, text) -> bool; cancelAll(); pending() }
class Bridge { constructor({hub}); enqueue(cmd); async next(timeoutMs) -> cmd | null | {stop:true}; reply({text, final, speak}); stop(); get listening() }
```
`listening` is true if a `listen` poll is active or happened in the last 20 s.

### prompt.js
`buildSystemPrompt({ platformInfo, config, mode }) -> string` appended to Claude Code's default prompt. It
covers: identity (Claude Anywhere, a desktop operator with OS and screen control); the observe → plan → act → verify
loop; preferring CLIs and APIs (gcloud/aws/az/kubectl/git/gh) over GUI clicking; screen tools usage (screenshot
first, coordinates in the latest screenshot's space, focus the target window before typing, re-screenshot to verify,
zoom with `region`); ignoring the "Claude Anywhere" window; safety (`ask_user` before irreversible, costly, public,
or financial actions; never type passwords, 2FA codes, or payment data, so the user does those; no CAPTCHA solving);
progress (`notify_user` for milestones); voice-friendly final answers (≤ 3 sentences, no markdown tables); "this repo"
means the project dir or the active editor workspace from `<desktop_context>`; and a deployment playbook (detect the
stack, Dockerfile or buildpacks, Cloud Run / App Engine / GKE, enable APIs, `gcloud run deploy --source`, verify the URL);
and a "Work on a ticket" playbook (find the ticket from the context's Tickets line or `read_browser_tab`, read it with
`jira_get_issue` / an Atlassian MCP / the page, summarize with a plan, one `ask_user` for where to work from
`find_repos`, one for the transition and assignment, `switch_project` when the repo is elsewhere, then branch
`KEY-123-slug`, implement, test, commit, ask before pushing, comment on the ticket).
A "Desktop assistant (any app)" section says how to target elements (ui_find / ui_click / ui_set_value, then
find_text, then pixels), to save turns (screenshotAfter, batch_actions), to open apps (launch_app, wait_for,
focus_window, set_window), bookmarks and tabs (browser_bookmarks, browser_open, browser_tabs, browser_switch_tab), and
covers Jira "For you", Figma (the Figma MCP server first), messaging (send only dictated or approved text) and video
(ffmpeg first, new files only). Platform specifics: key names (`primary` = Cmd on macOS, Ctrl elsewhere), shells. At
most 18,000 characters (`MAX_CHARS`).

### voice.js
```js
class VoiceService {
  constructor({ config, piper?, player?, ttsCache?, … })
  async capabilities() -> { serverStt, sttProvider, serverTts, ttsProvider /* 'piper' when Piper speaks */,
                            engine: 'piper'|'os'|'browser'|null, ttsEngine, piper: { installed, voice }, sttHint?, ttsHint? }
  async transcribe(buffer, { contentType = 'audio/wav', language }) -> { text, provider }
  async speak(text, { rate, voice }) -> { ok, provider }   // Piper (synthesize + play) when the engine is piper, else the OS voice
  stop()                                                   // stops speech and playback; tells onStop() listeners
  piper                                                    // PiperManager
  player() -> AudioPlayer
  ttsEngineSetting() -> 'auto'|'piper'|'browser'|'os'      // unknown values count as auto
  piperVoiceId() -> string
  async engineInfo() -> { setting, engine, piper, os: { provider, hint? } }
  invalidate()                                             // forget cached capabilities
  async voiceStatus() -> GET /api/voice/status body (without announcer)
  async installPiper({ voice?, force?, onProgress?, signal? })
  async synthesize(text, { voice?, rate? }) -> { id, path, mime: 'audio/wav', engine: 'piper', durationMs, cached, voice }
  audioFile(id) -> path | null
  playFile(file, opts) -> Promise<{ ok, player, stopped? }>
  onStop(fn) -> unsubscribe
}
```
`auto` uses Piper when it is installed, else the OS voice; `piper` only Piper (503 with the install command until it is
installed); `os` the OS voice; `browser` leaves speaking to the dialog. A new utterance replaces the old one without
notifying `onStop` listeners. Synthesized WAVs are cached in `runDir()/tts-cache` (the last 60; the same voice, speed and
text give the same id).
STT: OpenAI-compatible `POST {base}/audio/transcriptions` (multipart: `file`, `model`, `language`) using
`voice.sttApiKey` | `ANYWHERE_STT_API_KEY` | `GROQ_API_KEY` (base `https://api.groq.com/openai/v1`, model
`whisper-large-v3-turbo`) | `OPENAI_API_KEY` (base `https://api.openai.com/v1`, model `gpt-4o-mini-transcribe`).
Then whisper.cpp (`whisper-cli` | `whisper-cpp` | `main` + model file; needs 16 kHz WAV).

### piper.js · chime.js · announcer.js · src/os/audio.js
```js
class PiperManager {   // free, offline neural TTS (MIT), installed on request into stateDir()/voice
  constructor({ root?, venvDir?, env?, platformInfo?, which?, runner?, releaseBase?, voicesBase?, legacyBase?, ca?, arch?, pipSpec? })
  findBinary({ refresh }) -> { bin, kind: 'env'|'bundled'|'venv'|'path' } | null
  async status(voice) -> { installed, binary, binaryKind, voice, installedVoices, … }
  async install({ voice, force, onProgress, signal })      // release binary (Linux x64/arm64/armv7, Windows x64), else pip piper-tts in a private venv (macOS)
  async synthesize(text, { voice, outFile, lengthScale, speaker, timeoutMs, signal }) -> { path, durationMs, sampleRate, voice, binaryKind, ms }
  removeVoice(id), voiceInstalled(id), installedVoices(), voicePaths(id)
}
// also: TtsCache, CATALOG, DEFAULT_VOICE, parseVoiceId, validVoiceName, voiceUrls, releaseAsset, wavInfo, wavFileInfo,
// downloadFile(url, dest, {onProgress, minBytes, maxBytes, signal, timeoutMs, ca, env, resume}), httpGet, proxyFor
// env: ANYWHERE_PIPER_PATH, ANYWHERE_PYTHON, ANYWHERE_PIPER_RELEASE_BASE / _VOICES_BASE / _LEGACY_BASE, ANYWHERE_PIPER_PIP_SPEC

chimeWav(kind) -> Buffer; chimeFile(kind, { dir? }) -> runDir()/chimes/chime-<kind>.wav; CHIME_KINDS   // two soft notes per kind

class Announcer {
  constructor({ config, hub, voice, findCard?, secretLike?, chimeFile?, now?, random?, minQuietTurnMs = 4000 })
  start(); stop(); noteVisibility({ page, visible }); dialogVisible() -> bool
  handle(type, data) -> queued item | null; async deliver(item); async test(text?); cancelPending()
}
// composers: composeDone, composeError, composePermission, composeQuestion, humanizeAction, humanizeCommand, firstSentences

class AudioPlayer { constructor({ platformInfo?, which?, runner?, env?, isFile? }); async playFile(file, { device?, timeoutMs? }) -> { ok, player, stopped? }; stop() -> bool; isPlaying(); async status() -> { available, players, hint? } }
// errors carry .code ENOENT | NO_PLAYER | PLAY_FAILED and .hint; also buildPlayCommand, soundPlayerScript, mntToWindowsPath
```
The **announcer** decides what is said aloud and when, in one place. It listens to the hub's `event` and `clients`
emits: `result` → `done` ("All done." + the first sentence or two; not for a stopped turn, a `speak:false` bridge reply,
or a quick turn under 4 s that used no tools; a result with `handoff` → info "Switching to <folder> to continue."),
`approval_request` → `permission`, `question` → `question`, an error result, `status` error or `error` event → `error`,
and `notify` with `speak:true` → info (no chime; only `voice.tts = off` mutes it). It honours `voice.speakResponses`,
`voice.tts`, `voice.announce.*` and `voice.chime`, masks secrets, says each event once, plays one at a time (queue of 4;
cards are kept over older items), and skips a card answered meanwhile. Delivery: when a dialog page is connected and
visible (pages report through `/api/ui/visibility`; a page that has not reported counts as visible) it broadcasts
`announce`, with a Piper WAV id when the engine is piper; otherwise it plays the chime and speaks through the OS
(Piper WAV or OS voice). With `ttsEngine` `browser` it stays silent when no page is visible; with `os` the OS always
speaks. `voice.stop()` (barge-in, Stop, `POST /api/tts/stop`) drops what is queued. main.js wires it: hub listeners,
`uihost.noteVisibility` also feeds it, `server.deps.announcer` / `server.deps.refreshVoice`, the attention handler stops
speaking cards, `session.setVoiceInfo({…caps, announcer:true})` (set before the first probe, so a dialog never speaks
results, cards or notifications itself), and `POST /api/mcp/notify` leaves `speak:true` to it.

### uihost.js
```js
class UiHost {
  constructor({ config, platformInfo, driver, launchUrl })   // launchUrl(tokenUrl) -> single-use launch URL for browsers
  async open(url) -> { host: 'electron'|'app'|'browser'|'none', detail }
  async show(url) -> { host }          // focus the existing window ("Claude Anywhere" title) or reopen
  async close()
  status() -> { host, open }
}
```
`auto` order: Electron (if resolvable) → Chromium-family `--app` window (Chrome, Edge, Brave, Chromium, Vivaldi; per-OS
paths, plus Windows browsers from WSL) with `--user-data-dir=uiProfileDir()` `--window-size` `--window-position`
`--no-first-run` `--no-default-browser-check` `--autoplay-policy=no-user-gesture-required` `--class=claude-anywhere` →
default browser → `none` (prints the URL, suggests `anywhere tui`).
- Electron gets the token URL through `ANYWHERE_UI_URL`; every browser launch asks `launchUrl` for a fresh
  single-use URL (the daemon wires it to `server.launchUrl()`), so no command line carries the token.
- Background window searches call `listWindows({ axTitles: false })`. Always-on-top is never attempted on macOS
  (no public API; `DarwinDriver.supportsTopmost` is false, and the daemon's lazy driver cannot report it, so the
  platform is checked too).
- macOS: closing an app-mode dialog whose browser instance also holds other windows presses only the dialog's
  close button (`driver.closeWindow`, AXCloseButton) and leaves the instance running. `focusWindow` skips the
  `open -a`/`open -b` LaunchServices fallback when several instances of the bundle run (it could activate the
  user's browser instead of the dialog's) and returns false.

---

## 8. UI (`src/ui`)
Single page, no framework, ES modules. Title is exactly **"Claude Anywhere"**. Reads `token` from the URL query (or
trades a `launch` code for it, see Credentials below), stores it in `sessionStorage`, removes it from the address bar
(`history.replaceState`), and sends it as a Bearer
header on fetch and `?token=` on EventSource. Features:

- Header: status pill, project chip and picker, mode badge, settings button.
- Transcript: user and assistant bubbles (safe markdown via `markdown.js`, never `innerHTML` of untrusted HTML),
  tool rows (icon, name, summary, spinner/✓/✗, expandable input and output, screenshot thumbnail),
  approval cards (Allow once / Always this session / Deny, risk badge, keyboard Enter/Esc), question cards (options
  and free text), system notices. Enter/Esc on a card are ignored as key repeats and for 600 ms after the card takes
  focus; a focused card shows a focus ring. A new card takes focus when the composer is empty; Enter in an empty
  composer while a card waits moves focus to the card (armed) instead of stopping Claude, and the card's ↵/Esc hints
  show only while the card has focus. With exactly one question pending (and no approval), text typed in the
  composer answers it.
- "Claude's view": collapsible latest-screenshot preview.
- Composer: textarea (Enter sends, Shift+Enter adds a newline), mic button (click to toggle, press-and-hold for
  push-to-talk), "include screen" toggle, Send/Stop button.
- Voice (`voice.js`): providers `browser` (SpeechRecognition with interim results) and `server` (`wav-recorder.js` →
  16 kHz mono WAV with a silence VAD → POST `/api/stt`); `auto` picks browser unless Electron or unsupported, and falls
  back to server on `network`/`not-allowed`/`service-not-allowed` errors. Inside Electron, browser speech is never
  tried (it has no speech-service key there): server speech or none. Hands-free mode with wake word. Voice intents:
  "stop"/"cancel" → interrupt; with a pending approval, an utterance that is only a yes ("yes", "yeah, go ahead",
  "do it") → allow, only an "always" ("always", "yes always", "always allow", "allow it for this session") →
  allow_session, one starting with "no"/"deny"/"don't" → deny with the rest as the reason; anything hedged ("okay
  wait…", "yes, but…", "always ask me first") is not applied and the card stays. With a pending question, the
  utterance answers it: options match whole words, and hedged or ambiguous answers are sent as said. The wake word
  must open the utterance (after at most one filler such as "okay"; later only the exact phrase); while Claude
  speaks and ~0.7 s after, only the exact wake phrase (or "stop" with no wake word set) gets through.
  TTS: `speechSynthesis` or `/api/tts`. While `snapshot.voice.announcer` is true (always with a current daemon)
  the page never speaks `result` events, cards or `notify` messages by itself: it plays the daemon's `announce` events. Only without the announcer (an older daemon) does it speak `result` text
  (via stripMarkdown, ≤ 600 chars) and `notify` with `speak:true`. With several dialog windows open, only the most
  recently focused or shown one speaks and listens hands-free (BroadcastChannel `claude-anywhere`).
- Announcements (`voice.announce(item)`): only the speaker window plays them. An optional WebAudio chime (two notes per
  kind, `CHIME_NOTES`) when the event's `chime` is true and `voice.chime !== false`; then `GET /api/tts/audio?id=` with
  the Bearer header → Blob → `URL.createObjectURL` → `new Audio()` (revoked after); without audio, or when it fails,
  `speechSynthesis` with the chosen voice, else the most natural one (`rankVoices`/`pickNaturalVoice`; the picker
  defaults to "Most natural available"), else `POST /api/tts`. Queue of 8; permission and question go first; entries
  older than 120 s are dropped; an entry waits up to 20 s behind a read-aloud the user started; ids are de-duplicated;
  `voice.tts === 'off'` ignores them. Answering a card drops its announcement (`dropAnnouncements('permission' |
  'question')`). Barge-in (mic, typing, Esc, Stop) cancels browser speech and announcements and POSTs `/api/tts/stop`
  (daemon playback and its queue). Read aloud uses Piper (`POST /api/tts/synthesize`, then the WAV) when
  `snapshot.voice.engine === 'piper'`, else the browser voice.
- Settings drawer, in tabs **General | Voice | Jira & repos | Advanced**: permission mode, mode, theme and
  always-on-top; voice input and spoken replies (engine `voice.ttsEngine`, the Piper voice picker with Install and a
  progress bar from `voice_install`, Test, `voice.announce.*` toggles, chime); Jira (`jira.baseUrl` normalized to
  `https://host[/context]`, email, the token as a password field showing "•••• set" and never sent empty, Test
  connection → `POST /api/jira/test`, status from `GET /api/jira/status`); workspace roots (`workspace.roots`, the whole
  list, with suggestions from `GET /api/projects`); engine model, Claude in Chrome, context and privacy options.
  Save sends only the fields changed in the drawer; a config change made elsewhere while it is open refreshes the
  untouched fields. A project or mode switch the daemon refuses because a task is running (409) asks for
  confirmation, then retries with `force`.
- The event stream is opened with `&client=ui`, so the daemon counts dialog pages apart from TUIs and watchers. An app
  window (`display-mode: standalone`) whose token is rejected (the daemon restarted) closes itself after 4 s.
- Shortcuts: Ctrl/Cmd+K focuses input; Esc closes the lightbox/popover/drawer, cancels a voice capture, then stops
  speech, then interrupts Claude; hands-free that is only waiting for its wake word is turned off last (the mic
  button turns it back on); Ctrl/Cmd+Shift+M toggles the mic, holding Space (when not typing) is push-to-talk,
  Ctrl/Cmd+Alt+N starts a new session (Ctrl/Cmd+Shift+N also works in the app window and Electron; ordinary browser
  tabs keep it for a private window). On macOS these shortcuts use Cmd only, so Ctrl+K keeps its kill-line meaning
  in text fields.
- Credentials: `?token=` (Electron, or a URL the user opened) or `?launch=<code>` (browsers the daemon starts) is read
  once, the launch code is traded through `POST /api/launch` before the first API call, the token is kept in
  sessionStorage, and both are removed from the address bar. A failed trade (used or expired code) falls back to the
  stored token, so reloads keep working.
- Transcript: a user item with source `handoff` (the task `switch_project` handed to the new session) is labelled
  "Handed over by Claude" and collapsed to its first line when long; ticket tools show a ticket icon, `find_repos` and
  `switch_project` a folder.
- Reconnect banner; dark and light themes (`prefers-color-scheme` + manual); aria-live transcript.
- `window.anywhereFocusInput()` is exposed for the Electron hotkey.

## 9. Electron shell (`src/electron`)
`main.js` (run as `ANYWHERE_UI_URL=<url> electron src/electron/main.js [--always-on-top] [--hotkey <accel>]`; the URL goes
through the environment because command lines are readable by every local user, and browsers get single-use launch
codes instead, see server.js; `--url <url>` still works for manual runs): one
`BrowserWindow` titled "Claude Anywhere" (440×720, positioned right, `alwaysOnTop`, `setContentProtection(hideFromScreenshots)`),
mic permission granted only for the daemon origin, `autoplay-policy=no-user-gesture-required` (announcements play
before the first click; the app windows get the same flag), `globalShortcut` hotkey toggles show/focus, and the window is
hidden on close (tray menu with Show and Quit). `preload.js` exposes `window.anywhereShell = { isElectron: true, platform, hide(), setAlwaysOnTop(bool) }`.

## 10. CLI (`bin/anywhere.js`)
```
anywhere start [--project DIR] [--mode companion|bridge] [--ui HOST] [--no-open] [--foreground] [--json]
anywhere stop | status [--json] [--show-token] | show | url   # only `url` (and start/show when no window opens) print the token
anywhere send <text…> [--screenshot | --no-screenshot]   # neither = context.attachScreenshotByDefault
anywhere listen [--timeout SEC] [--json]      # exit 0 command printed, 2 timeout, 3 stop
anywhere reply <text…> [--final] [--no-speak] # prints STOP and exits 3 when the dialog left bridge mode (HTTP 409);
                                             # STOPPED and exit 5 when the user stopped this command (409 COMMAND_STOPPED)
anywhere ask <question…> [--options a,b,c] [--timeout SEC]   # STOPPED / exit 5 likewise
anywhere notify <text…> [--speak]
anywhere computer <op> …                     # screenshot [--display N] [--out FILE] | click X Y [--button B] [--double]
                                             # | move X Y | drag X1 Y1 X2 Y2 | scroll DIR [AMOUNT] [--at X Y]
                                             # | type TEXT | key COMBO | windows | focus QUERY | open TARGET
                                             # | clipboard get|set [TEXT] | cursor | screens | context
                                             # | ui-find NAME [--role R] [--contains T] [--window W] [--exact] [--limit N]
                                             # | ocr [TEXT] [--display N] [--region X,Y,W,H] [--exact] | apps [QUERY]
anywhere desktop apps [QUERY] | launch NAME [--no-wait] [--timeout SEC] [--new] [--accessibility] [-- ARGS]
             | quit NAME [--force] | bookmarks [QUERY] [--browser B] [--folder F] [--profile P] [--limit N]
             | open-url URL [--browser B] [--new-window] [--same-tab] | tabs [--browser B] [--cycle]
             | switch-tab TEXT|--index N [--browser B] | window QUERY --state S|--bounds X,Y,W,H
             | wait [--window W] [--text T] [--gone] [--timeout SEC] [--display N] [--exact]   [--json]
anywhere doctor [--json]
anywhere install [--electron] [--no-mcp] [--hotkey [--hotkey-key COMBO]] [--no-permissions] | uninstall
anywhere show [--launcher]                    # --launcher (macOS applet): only show a running dialog; else open Terminal to start it
anywhere config [path | get KEY | set KEY VALUE | reset]   # voice.sttApiKey and jira.apiToken are masked unless --reveal
anywhere voice install [ID] [--voice ID] [--force] | list | use ID [--install] | test ["text"] [--local] | status | remove ID [--json]
anywhere jira setup [--url URL] [--email EMAIL] [--token-stdin] [--no-test] | test | status | issue KEY
             | search "JQL" [--max N] | mine [--status S] | remove [--json]   # --token VALUE is refused
anywhere logs [--audit] [-n N]
anywhere tui
anywhere mcp                                  # MCP stdio server
anywhere daemon [--project DIR] [--mode M] [--ui HOST] [--no-open]   # foreground daemon (internal)
anywhere version | help
```
`start` reuses a running daemon (it switches the project and mode if they differ, then calls `show`; without
`--mode` it hands a bridge dialog that no terminal listens to back to companion mode, and says "still in bridge mode"
with the reason when it does not; bridge commands that only wait for a terminal are not "a task is running"); otherwise it
spawns `node bin/anywhere.js daemon …` detached (logs to `daemonLogPath()`), waits up to 15 s for `/api/health`, and
prints a human summary (or JSON with `--json`). A spawned daemon that exits 0 (ALREADY_RUNNING: it lost the start-lock
race) is not a failure; `start` keeps polling for the winner until the deadline. No CLI path starts a browser or
other process with the token URL: `show` posts `/api/show`, so the daemon's UiHost mints a launch URL.
- Hotkeys (`install --hotkey`): Ctrl+Alt+F12 on Windows and WSL (Ctrl+Alt+<letter> is AltGr on many layouts),
  Ctrl+Alt+A on GNOME, a launcher app to bind in Shortcuts on macOS; `--hotkey-key COMBO` picks another. `install.json`
  records `envPath` (the install-time PATH) so daemons started by launchers find node and claude.
- `voice install`, `list`, `use` and `remove` work without the daemon (`use`/`install` then tell a running one through
  `POST /api/voice/use`); `test` plays through the dialog when it is open, else locally. `jira setup` prompts on a TTY
  (hidden token), probes Cloud vs Server, tests, saves with `config.save` (0600) and tells a running daemon.
- `doctor`'s Voice line also shows the natural voice: `Piper ✓ <voice>`, or `not installed (anywhere voice install)`.
- Desktop assistant: `computer ui-find` prints `Computer.uiFind` matches (with `shot`) as JSON, `computer ocr` runs
  `ocr.findText` (with TEXT) or `ocr.readScreenText`, and `computer apps` prints `runningApps` and the default browser.
  `src/cli/desktop.js` (group "Desktop control") runs the same operations as the MCP tools through `createDesktopOps`:
  text by default, `--json` for JSON; actions honour the dialog's pause guard (`GET /api/mcp/guard` when a daemon runs)
  and the failsafe corner and post to the activity feed; `wait` exits 2 on timeout. `doctor` adds "App controls
  (accessibility)" (`capabilities().ui`, its notes, and `uiHint` as the fix; UI notes no longer turn the Desktop
  control line into a warning), "Screen text (OCR)" (`ocr.available()`), and on Linux "Desktop assistant tools"
  (wmctrl, sqlite3, gtk-launch, informational).
- `doctor` also warns about broad Claude Code allow rules (`Bash`, `Bash(*)`, `Write`, `Edit`, `mcp__anywhere__*` in
  ~/.claude/settings.json and the project's .claude/settings(.local).json), which apply before the dialog's approval
  broker; on macOS it shows Automation consent and the running daemon's permissions (`GET /api/permissions`), and
  suggests `anywhere install --electron` when the dialog would be an app-mode browser window. An interactive
  `install` on macOS shows the Accessibility, Screen Recording and Automation prompts up front.

## 11. Skill and plugin
- `skills/anywhere/run.js` resolves the package root in this order: `../../bin/anywhere.js` relative to itself
  when it sits at `<package>/skills/anywhere/` (repo or plugin layout); then `install.json`: for a plugin install
  (`pluginsDir`, recorded by `anywhere install` when it runs from `<claudeHome>/plugins/`) the `anywhere@*` install
  path in `<pluginsDir>/installed_plugins.json` (same marketplace and user scope first), because every plugin update
  moves the plugin to a new versioned folder, else `packageRoot`; then `anywhere` on PATH (never itself again).
  It forwards argv and the exit code. A plugin install also copies it to `<state>/launcher/anywhere.js` with the
  `bin/anywhere` and `anywhere.cmd` shims beside it: the stable launcher that the `~/.local/bin/anywhere` link and the
  hotkey run (`install.json` `launcher`), removed by `uninstall`.
- `SKILL.md` invokes `node "${CLAUDE_SKILL_DIR}/run.js" …` (`${CLAUDE_SKILL_DIR}` is substituted by Claude Code in
  skill content; `${CLAUDE_PLUGIN_ROOT}` is also available for plugin skills). Frontmatter: `name: anywhere`,
  `description`, `argument-hint`, `allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/run.js"*)` plus the read-only MCP
  tools screenshot, list_windows, cursor_position, screen_info and get_desktop_context under both `mcp__anywhere__`
  and `mcp__plugin_anywhere_anywhere__` (Claude Code 2.1.302 expands `${CLAUDE_SKILL_DIR}` in allowed-tools),
  `disable-model-invocation: true`.
- `SKILL.md` handles `$ARGUMENTS`: empty → start the companion; `here`/`bridge` → bridge loop; `stop`; `status`;
  `doctor`/`setup`; anything else → start, then send it as a command.
- Install paths: (1) plugin: `/plugin marketplace add patel-deepanshu/claude-anywhere` then
  `/plugin install anywhere@anywhere-marketplace` (skill is `/anywhere:anywhere`, and bare `/anywhere` when unambiguous);
  (2) personal skill: `node bin/anywhere.js install` copies `skills/anywhere/` to `~/.claude/skills/anywhere/`
  (giving `/anywhere`), writes `install.json`, and registers the MCP server at user scope with
  `claude mcp add-json --scope user anywhere '<json>'`.

## 12. Testing
`npm test` runs `node scripts/test.js`, which lists `test/*.test.js` itself and runs `node --test` on those files: the
same as `node --test test/*.test.js` in a POSIX shell, but it also works in cmd.exe with Node 18/20, which expand no
globs (not `node --test test/`: Node 21+ loads a bare directory argument as a module and fails, and without a file
list `node --test` would also run `test/fixtures/*.js`). No network or display
is required (display tests skip unless `DISPLAY` is set and xdotool exists). `test/fixtures/fake-claude.js` emulates
the stream-json CLI. It also connects to the MCP server named in `--mcp-config` to exercise `permission_prompt`,
`ask_user`, and `screenshot` end to end. CI (`.github/workflows/ci.yml`) runs `npm test` and `npm run lint` on
ubuntu, macos and windows.
The voice, Jira and ticket features are tested without network or audio: local fake HTTP servers stand in for the
Piper release, Hugging Face and Jira, fake `piper`/player binaries for the real ones, the mock driver and
`test/fixtures/fake-ps-host.js` for browser tabs, and `test/fixtures/ui-stub-server.js` (voice status, install,
`/api/tts/audio`, `announce` and Jira routes) for the dialog in headless Chromium.
The desktop assistant's tests need no display: `test/desktop-core.test.js` (screenshotAfter, batch_actions, permissions,
prompt), `desktop-ui-tools.test.js` (mock driver, Computer UI methods, tools-ui), `desktop-linux.test.js`
(atspi-helper protocol, linux.js through a fake `run`), `desktop-macos.test.js` (darwin.js and the JXA helper with a
fake transport), `desktop-windows.test.js` (win32.js against `fake-ps-host.js`, PowerShell parse checks when pwsh is
present), `desktop-ocr.test.js` (parsers, matching, coordinate mapping; real tesseract when installed),
`desktop-apps.test.js` and `desktop-browsers.test.js` (catalogs, launch/quit plans, bookmark files, tab methods through
injected deps), and `desktop-integration.test.js` (the seams between them). Opt-in live checks:
`ANYWHERE_LIVE_DESKTOP=1` (Chromium through AT-SPI on Linux; on macOS the Finder menu bar and front window through the
AX API, which CI's "Live desktop (macos-latest)" job runs with `--test-name-pattern=live-desktop`) and `ANYWHERE_LIVE_OCR=1` (find_text on a Chromium page). The CI Xvfb job also
installs tesseract and the AT-SPI bindings and runs `desktop-linux` and `desktop-ocr`.
