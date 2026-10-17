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
.claude-plugin/plugin.json          plugin manifest (name "anywhere")
.claude-plugin/marketplace.json     marketplace "anywhere-marketplace" listing plugin "anywhere" with source "."
.mcp.json                           plugin MCP server "anywhere" → node ${CLAUDE_PLUGIN_ROOT}/src/mcp/server.js
skills/anywhere/SKILL.md            the /anywhere skill
skills/anywhere/run.js              locates the package and forwards argv to bin/anywhere.js
bin/anywhere.js                     CLI entry point
bin/anywhere, bin/anywhere.cmd      tiny shims (plugin bin/ dirs are added to the Bash PATH while the plugin is enabled)
src/shared/{paths,config,log,state,client,proc,platform,util}.js
src/os/{index,computer,png,keys,common,darwin,win32,linux}.js
src/os/darwin-helper.js             JXA script run via `osascript -l JavaScript`
src/os/win32-host.ps1               persistent PowerShell JSON-lines host
src/context/desktop.js
src/mcp/{server,tools}.js
src/daemon/{main,server,hub,session,engine-cli,permissions,questions,bridge,prompt,voice,uihost}.js
src/ui/{index.html,app.css,app.js,voice.js,wav-recorder.js,markdown.js}
src/electron/{main,preload}.js
src/tui/tui.js
scripts/{install.js,install.sh,install.ps1}
test/*.test.js, test/fixtures/fake-claude.js
docs/{PLAN,ARCHITECTURE,PLATFORMS,SECURITY,VOICE}.md
package.json, README.md, .github/workflows/ci.yml
```

---

## 3. Shared modules (`src/shared`)

### paths.js
```js
PACKAGE_ROOT                 // absolute repo/package root
stateDir()                   // env ANYWHERE_HOME || ~/.claude-anywhere (mkdir -p, 0700)
configPath()                 // stateDir()/config.json
daemonStatePath()            // stateDir()/daemon.json
sessionsPath()               // stateDir()/sessions.json   { [projectDir]: {sessionId, updatedAt} }
installInfoPath()            // stateDir()/install.json    { packageRoot, version, installedAt }
logsDir()                    // stateDir()/logs (mkdir -p)
auditLogPath(date?)          // logsDir()/audit-YYYY-MM-DD.jsonl
daemonLogPath()              // logsDir()/daemon.log
runDir()                     // stateDir()/run (mkdir -p): mcp config, system prompt, temp files
uiProfileDir()               // stateDir()/ui-profile (Chromium --user-data-dir)
modelsDir()                  // stateDir()/models
lastShotPath()               // runDir()/last-shot.json (CLI geometry persistence)
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
publicConfig(cfg) -> object   // secrets replaced: voice.sttApiKey → '' plus voice.sttApiKeySet: bool
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
           sttBaseUrl: '', sttApiKey: '', sttModel: '', whisperCppPath: '', whisperModel: '' },
  privacy: { redactSecretsInLogs: true, auditLog: true }
}
```

### log.js
```js
createLogger(name) -> { debug, info, warn, error }   // writes "[ts] [name] level msg" to stderr,
                                                     // or to daemonLogPath() if env ANYWHERE_LOG_FILE=1.
                                                     // debug only when env ANYWHERE_DEBUG=1
audit(event)                                         // JSONL append {ts, ...redact(event)} to auditLogPath()
redact(value) -> value                               // deep; masks secrets in strings (see SECURITY.md)
```

### state.js
```js
readDaemonState()  -> {pid, port, token, instanceId, version, startedAt, project, mode, url} | null
writeDaemonState(obj)                    // 0600
clearDaemonState()
async findRunningDaemon({timeoutMs=1500}) -> state | null   // pid alive AND GET /api/health ok AND instanceId matches; clears stale file
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
which(name) -> absolute path | null                        // PATH (+PATHEXT on win32), cached
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
  async capabilities() -> { screenshot, mouse, keyboard, windows, clipboard, notify, speak: bool, notes: string[] }
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
  async listWindows() -> [{ id, app, title, pid, x, y, width, height, focused, minimized }]
  async activeWindow() -> { id, app, title, pid } | null
  async focusWindow(id) -> bool
  async minimizeWindow(id) -> bool
  async setTopmost(id, on) -> bool      // best effort (false if unsupported)
  async clipboardGet() -> string
  async clipboardSet(text)
  async close()                         // stop persistent helpers
}
```
Unsupported operations throw `Error` with `.code = 'UNSUPPORTED'` and an
actionable `.hint` (e.g. "Install xdotool: sudo apt install xdotool").

### common.js (OS-agnostic helpers that shell out)
```js
async openTarget(target, { kind = 'auto', args = [] }) -> { opened, kind, how }  // url | path | app
async notify(title, body)                    // osascript / PS host balloon / notify-send
async speak(text, { rate, voice })           // say / System.Speech / spd-say|espeak-ng|espeak; returns {pid}
stopSpeaking()
```

### keys.js
```js
normalizeCombo('Ctrl+Shift+T') -> ['ctrl','shift','t']
// modifiers: ctrl, alt, shift, meta (cmd/command/super/win/windows/os); 'primary'/'mod' → meta on darwin else ctrl
// named keys: enter, escape, tab, space, backspace, delete, insert, home, end, pageup, pagedown,
//             up, down, left, right, f1..f24, capslock, printscreen, menu, plus single characters
toXdotool(keys) -> 'ctrl+shift+t'
toMacKeyCodes(keys) -> { keyCode, flags }      // kVK codes + CGEventFlags
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
  async screenshot({ display = 0, region /* {x,y,width,height} in full-shot space */, maxWidth, maxHeight })
     -> { png, width, height, display, scale, region, cursor /* in shot space or null */, displays /* count */ }
  async click({ x, y, button, clicks, modifiers, display })
  async moveMouse({ x, y, display }), async drag({ fromX, fromY, toX, toY, button, display })
  async scroll({ x, y, direction, amount = 3, display })
  async typeText({ text, method = 'auto' /* auto|keys|paste */ })
  async key({ combo, repeat = 1 })
  async cursorPosition() -> { x, y, display }      // shot space
  async screenInfo() -> { displays, lastShot }
  toLogical(display, x, y) -> { x, y }; toShot(display, lx, ly) -> { x, y }
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
  project: { dir, name, git: { branch, remote, dirty } | null, stack: string[] },
  cloud: { gcloud: { account, project } | null, aws: { profile, region } | null, az: { subscription } | null,
           kubectl: { context } | null, docker: { running } | null },
  errors: string[]
}
formatContext(ctx) -> string        // compact "<desktop_context>…</desktop_context>" block, ≤ 2,500 chars
async detectProjects({ driver }) -> [{ dir, name, source: 'vscode'|'recent'|'cwd' }]
async projectInfo(dir) -> ctx.project
```
Every probe has a 2.5 s timeout and never throws.

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
| `ask_user` | `{question, options?, timeoutSec?}` | POST /api/mcp/ask (blocks); without a daemon → error "dialog not running" |
| `permission_prompt` | `{tool_name, input, tool_use_id?}` | POST /api/mcp/permission (blocks) → text JSON `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`; without a daemon → allow |

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
class Hub { addClient(req, res); broadcast(type, data); clientCount(); close() }  // SSE with 15 s heartbeat comments
```

### server.js — HTTP API
Bind `127.0.0.1` only. Security on **every** request:
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defense), else 403.
- `/api/*` (except `GET /api/health`) requires the token: `Authorization: Bearer`, `X-Anywhere-Token`, or `?token=` (SSE only), compared with `crypto.timingSafeEqual`.
- Non-GET requests with an `Origin` header must match `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- JSON bodies ≤ 25 MB; `/api/stt` audio ≤ 25 MB.
- HTML has CSP `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'`.

| Method & path | Body | Response |
|---|---|---|
| GET `/` and static `/app.js` etc. | | files from `src/ui` (no auth; static only) |
| GET `/api/health` | | `{ok, app:'claude-anywhere', version, instanceId, pid}` |
| GET `/api/events?token=` | | SSE stream; first event `snapshot` |
| GET `/api/state` | | snapshot |
| POST `/api/command` | `{text, attachScreenshot?, images?:[{mediaType,data}], source?:'text'|'voice'|'cli'|'skill'}` | `{ok, id}` |
| POST `/api/interrupt` | | `{ok}` |
| POST `/api/approval` | `{id, decision:'allow'|'allow_session'|'deny', message?}` | `{ok}` |
| POST `/api/answer` | `{id, text}` | `{ok}` |
| POST `/api/session/new` | | `{ok, sessionId}` |
| POST `/api/project` | `{dir}` | `{ok, project}` (restarts engine in the new cwd) |
| GET `/api/projects` | | `{projects:[…]}` |
| GET `/api/config` · POST `/api/config` | partial config | public config |
| POST `/api/mode` | `{mode}` | `{ok, mode}` |
| POST `/api/stt` | raw `audio/wav` (also webm/ogg/mp4 pass-through) `?language=` | `{text, provider}` |
| POST `/api/tts` | `{text}` | `{ok, provider}` |
| POST `/api/tts/stop` | | `{ok}` |
| GET `/api/context` | | gatherContext JSON |
| POST `/api/show` | | `{ok, host}` |
| POST `/api/shutdown` | | `{ok}` then exit |
| POST `/api/mcp/permission` | `{tool_name, input, tool_use_id}` | `{behavior, updatedInput?, message?}` (blocks) |
| POST `/api/mcp/ask` | `{question, options?, timeoutSec?}` | `{answer}` or `{timeout:true}` (blocks) |
| POST `/api/mcp/notify` | `{message, level?, speak?}` | `{ok, delivered}` |
| POST `/api/mcp/activity` | `{tool, summary?, ok?, error?, image?, width?, height?}` | `{ok}` |
| GET `/api/mcp/guard` | | `{allowed, reason?}` |
| POST `/api/bridge/listen` | `{timeoutSec ≤ 590}` | `{command:{id,text,images:[path],context,source}}` or `{timeout:true}` or `{stop:true}` |
| POST `/api/bridge/reply` | `{text, final?, speak?}` | `{ok}` |

### SSE events (server → UI): `event: <type>` + `data: <json>`
- `snapshot` `{version, mode, status, statusDetail, project:{dir,name,git}, session:{id, model, costUsd, turns}, messages:[…], pending:{approvals:[…], questions:[…]}, config:<public>, voice:{serverStt, sttProvider, serverTts, ttsProvider}, bridge:{listening}, platform:{platform, displayServer, driver}, screenshot:{dataUrl,width,height,ts}|null}`
- `status` `{status:'idle'|'starting'|'thinking'|'acting'|'waiting_approval'|'waiting_answer'|'stopping'|'error'|'offline', detail?}`
- `message` (transcript item; see below), `delta` `{id, text}` (append to an assistant item)
- `tool_update` `{toolUseId, status:'ok'|'error', output?, image?}`
- `approval_request` `{id, toolName, displayName, summary, input, risk, reason, ts}` · `approval_resolved` `{id, decision}`
- `question` `{id, question, options, ts}` · `question_resolved` `{id, answer}`
- `notify` `{text, level, speak}` · `result` `{text, costUsd, totalCostUsd, durationMs, isError, sessionId, numTurns}`
- `screenshot` `{dataUrl, width, height, ts}` · `project` `{dir, name, git}` · `session` `{id, model}`
- `config` `<public config>` · `mode` `{mode}` · `bridge` `{listening}` · `show` `{}` · `error` `{message}`

Transcript items (`message` event and `snapshot.messages`):
```js
{ id, role: 'user', text, source, ts, images }                                  // images = count
{ id, role: 'assistant', text, ts, streaming: bool }
{ id, role: 'tool', toolUseId, name, displayName, summary, input, status: 'running'|'ok'|'error', output, image, parentToolUseId, ts }
{ id, role: 'system', text, level: 'info'|'success'|'warning'|'error', ts }
```

### engine-cli.js
```js
class ClaudeCliEngine extends EventEmitter {
  static async locate(config) -> { path, version } | null   // config.engine.claudePath | env ANYWHERE_CLAUDE_PATH | which('claude') | known install paths
  constructor({ claudePath, cwd, sessionId, resume: bool, mcpConfigPath, systemPromptPath, allowedTools,
                model, fallbackModel, effort, chrome, addDirs, maxBudgetUsd, extraArgs, env })
  start()                    // spawn; emits 'spawn'
  send(contentBlocks)        // writes {"type":"user","message":{"role":"user","content":[…]}}\n
  async interrupt()          // control_request {subtype:'interrupt'}; if no result in 4 s → kill
  async stop()               // end stdin, SIGTERM, SIGKILL after 3 s
  get running()
  // events: 'message' (every parsed stdout JSON line), 'stderr' (line), 'exit' ({code, signal, stderrTail})
}
```
Args (in this order):
`-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
`(--session-id <uuid> | --resume <id>) --mcp-config <file> --permission-prompt-tool mcp__anywhere__permission_prompt`
`--append-system-prompt-file <file> --allowedTools <comma list>`
`[--model] [--fallback-model] [--effort] [--chrome] [--max-budget-usd] [...extraArgs] [--add-dir <dir>...]` (add-dir last because it is variadic).
Env: `process.env` minus `engine.stripEnv`, plus (unless already set) `MCP_TOOL_TIMEOUT=3600000` and
`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` (blocking `ask_user` calls must not be auto-backgrounded after 2 min).
MCP config file: `{"mcpServers":{"anywhere":{"type":"stdio","command":<process.execPath>,"args":[<PACKAGE_ROOT>/src/mcp/server.js],
"env":{"ANYWHERE_DAEMON_URL":"http://127.0.0.1:<port>","ANYWHERE_TOKEN":<token>,"ANYWHERE_ROLE":"engine"},"alwaysLoad":true}}}`. On win32, `.cmd`/`.bat`
shims are spawned with `shell: true` and every argument quoted. The system prompt and MCP config always go through
files, so no argument holds newlines.

Interrupt message: `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}`.

### session.js
```js
class SessionManager extends EventEmitter {
  constructor({ config, hub, permissions, questions, bridge, computer, driver, port, token, projectDir, mode })
  snapshot() -> snapshot payload
  async submit({ text, images, attachScreenshot, source }) -> { id }
  async interrupt()
  async newSession()
  async setProject(dir)
  setMode(mode)
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

### permissions.js
```js
classify(toolName, input, { projectDir }) -> { risk: 'low'|'medium'|'high'|'critical', reason, summary }
class PermissionBroker {
  constructor({ config, hub, onNeedAttention })
  async request({ tool_name, input, tool_use_id }) -> { behavior:'allow', updatedInput } | { behavior:'deny', message }
  resolve(id, decision, message) -> bool
  cancelAll(reason)
  pending() -> [...]
  setMode(mode)
}
```
Policy: `ask` allows only `low`; `smart` (default) allows `low` and `medium`; `auto` allows everything except `critical`.
`alwaysAsk` patterns force a prompt. Session `allow_session` rules and config `alwaysAllow` (`"ToolName"` or
`"Bash(prefix*)"`) allow, except for `critical`. Timeout → deny with "No response from the user within N s".
Every decision is written to the audit log.

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
stack, Dockerfile or buildpacks, Cloud Run / App Engine / GKE, enable APIs, `gcloud run deploy --source`, verify the URL).
Platform specifics: key names (`primary` = Cmd on macOS, Ctrl elsewhere), shells.

### voice.js
```js
class VoiceService {
  constructor({ config })
  async capabilities() -> { serverStt: bool, sttProvider, serverTts: bool, ttsProvider }
  async transcribe(buffer, { contentType = 'audio/wav', language }) -> { text, provider }
  async speak(text, { rate, voice }) -> { ok, provider }
  stop()
}
```
STT: OpenAI-compatible `POST {base}/audio/transcriptions` (multipart: `file`, `model`, `language`) using
`voice.sttApiKey` | `ANYWHERE_STT_API_KEY` | `GROQ_API_KEY` (base `https://api.groq.com/openai/v1`, model
`whisper-large-v3-turbo`) | `OPENAI_API_KEY` (base `https://api.openai.com/v1`, model `gpt-4o-mini-transcribe`).
Then whisper.cpp (`whisper-cli` | `whisper-cpp` | `main` + model file; needs 16 kHz WAV).

### uihost.js
```js
class UiHost {
  constructor({ config, platformInfo, driver })
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

---

## 8. UI (`src/ui`)
Single page, no framework, ES modules. Title is exactly **"Claude Anywhere"**. Reads `token` from the URL query,
stores it in `sessionStorage`, removes it from the address bar (`history.replaceState`), and sends it as a Bearer
header on fetch and `?token=` on EventSource. Features:

- Header: status pill, project chip and picker, mode badge, settings button.
- Transcript: user and assistant bubbles (safe markdown via `markdown.js`, never `innerHTML` of untrusted HTML),
  tool rows (icon, name, summary, spinner/✓/✗, expandable input and output, screenshot thumbnail),
  approval cards (Allow once / Always this session / Deny, risk badge, keyboard Enter/Esc), question cards (options
  and free text), system notices.
- "Claude's view": collapsible latest-screenshot preview.
- Composer: textarea (Enter sends, Shift+Enter adds a newline), mic button (click to toggle, press-and-hold for
  push-to-talk), "include screen" toggle, Send/Stop button.
- Voice (`voice.js`): providers `browser` (SpeechRecognition with interim results) and `server` (`wav-recorder.js` →
  16 kHz mono WAV with a silence VAD → POST `/api/stt`); `auto` picks browser unless Electron or unsupported, and falls
  back to server on `network`/`not-allowed`/`service-not-allowed` errors. Hands-free mode with wake word. Voice intents:
  "stop"/"cancel" → interrupt; with a pending approval, "yes"/"allow"/"approve" → allow, "always" → allow_session,
  "no"/"deny" → deny; with a pending question, the utterance answers it. TTS: `speechSynthesis` or `/api/tts`; speak
  `result` text (via stripMarkdown, ≤ 600 chars) and `notify` with `speak:true`; barge-in cancels speech.
- Settings drawer: permission mode, voice options, engine model and Claude in Chrome, context options, UI theme and always-on-top.
- Shortcuts: Ctrl/Cmd+K focuses input, Esc stops or closes, Ctrl/Cmd+Shift+M toggles the mic, holding Space (when
  not typing) is push-to-talk, Ctrl/Cmd+Shift+N starts a new session.
- Reconnect banner; dark and light themes (`prefers-color-scheme` + manual); aria-live transcript.
- `window.anywhereFocusInput()` is exposed for the Electron hotkey.

## 9. Electron shell (`src/electron`)
`main.js` (run as `electron src/electron/main.js --url <url> [--always-on-top] [--hotkey <accel>]`): one
`BrowserWindow` titled "Claude Anywhere" (440×720, positioned right, `alwaysOnTop`, `setContentProtection(hideFromScreenshots)`),
mic permission granted only for the daemon origin, `globalShortcut` hotkey toggles show/focus, and the window is
hidden on close (tray menu with Show and Quit). `preload.js` exposes `window.anywhereShell = { isElectron: true, platform, hide(), setAlwaysOnTop(bool) }`.

## 10. CLI (`bin/anywhere.js`)
```
anywhere start [--project DIR] [--mode companion|bridge] [--ui HOST] [--no-open] [--foreground] [--json]
anywhere stop | status [--json] | show | url
anywhere send <text…> [--screenshot]
anywhere listen [--timeout SEC] [--json]      # exit 0 command printed, 2 timeout, 3 stop
anywhere reply <text…> [--final] [--no-speak]
anywhere ask <question…> [--options a,b,c] [--timeout SEC]
anywhere notify <text…> [--speak]
anywhere computer <op> …                     # screenshot [--display N] [--out FILE] | click X Y [--button B] [--double]
                                             # | move X Y | drag X1 Y1 X2 Y2 | scroll DIR [AMOUNT] [--at X Y]
                                             # | type TEXT | key COMBO | windows | focus QUERY | open TARGET
                                             # | clipboard get|set [TEXT] | cursor | screens | context
anywhere doctor [--json]
anywhere install [--electron] [--no-mcp] [--hotkey] | uninstall
anywhere config [path | get KEY | set KEY VALUE | reset]
anywhere logs [--audit] [-n N]
anywhere tui
anywhere mcp                                  # MCP stdio server
anywhere daemon [--project DIR] [--mode M] [--ui HOST] [--no-open]   # foreground daemon (internal)
anywhere version | help
```
`start` reuses a running daemon (it switches the project and mode if they differ, then calls `show`); otherwise it
spawns `node bin/anywhere.js daemon …` detached (logs to `daemonLogPath()`), waits up to 15 s for `/api/health`, and
prints a human summary (or JSON with `--json`).

## 11. Skill and plugin
- `skills/anywhere/run.js` resolves the package root in this order: `../../bin/anywhere.js` relative to itself
  (repo or plugin layout), then `install.json`'s `packageRoot`, then `anywhere` on PATH. It forwards argv and the exit code.
- `SKILL.md` invokes `node "${CLAUDE_SKILL_DIR}/run.js" …` (`${CLAUDE_SKILL_DIR}` is substituted by Claude Code in
  skill content; `${CLAUDE_PLUGIN_ROOT}` is also available for plugin skills). Frontmatter: `name: anywhere`,
  `description`, `argument-hint`, `allowed-tools: Bash(node *)`, `disable-model-invocation: true`.
- `SKILL.md` handles `$ARGUMENTS`: empty → start the companion; `here`/`bridge` → bridge loop; `stop`; `status`;
  `doctor`/`setup`; anything else → start, then send it as a command.
- Install paths: (1) plugin: `/plugin marketplace add patel-deepanshu/claude-anywhere` then
  `/plugin install anywhere@anywhere-marketplace` (skill is `/anywhere:anywhere`, and bare `/anywhere` when unambiguous);
  (2) personal skill: `node bin/anywhere.js install` copies `skills/anywhere/` to `~/.claude/skills/anywhere/`
  (giving `/anywhere`), writes `install.json`, and registers the MCP server at user scope with
  `claude mcp add-json --scope user anywhere '<json>'`.

## 12. Testing
`node --test test/` with no network or display required (display tests skip unless `DISPLAY` is set and xdotool
exists). `test/fixtures/fake-claude.js` emulates the stream-json CLI. It also connects to the MCP server named in
`--mcp-config` to exercise `permission_prompt`, `ask_user`, and `screenshot` end to end.
