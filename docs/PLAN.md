# /anywhere: end-to-end plan

> Goal: type `/anywhere` in Claude Code and get a small floating dialog on your desktop. From it, by
> typing or by voice, you can ask Claude to do anything a person at the keyboard could do. For example:
> *"VS Code has my repo open and I have GCP open in Chrome. Start deploying this repo from scratch."*
> It must work on macOS, Windows (also WSL) and Linux, and it must degrade gracefully, never break, when
> some capability isn't available.

This document is the product and engineering plan. `ARCHITECTURE.md` is the module-level contract
that the code follows, including the per-platform drivers, the voice pipeline and the security model.

---

## 1. What the user gets

| Capability | How it works |
|---|---|
| `/anywhere` from any Claude Code session | A Claude Code **skill** (also packaged as a **plugin**) launches the Anywhere daemon for the current repo and opens the dialog. |
| A floating dialog on any OS | A local web UI served by the daemon, shown in one of: an Electron window (always on top, global hotkey, hidden from screenshots), a chromeless Chrome/Edge/Brave `--app` window, the default browser, or a terminal UI. Whichever is available is used, in that order. |
| Text and **voice** input | Web Speech API (Chrome, Edge, Safari) with live transcription. Otherwise WAV capture in the page, transcribed by a server provider (Groq, OpenAI or any OpenAI-compatible endpoint, or local whisper.cpp). Push-to-talk, toggle, and hands-free mode with a wake word. |
| Spoken answers | Browser `speechSynthesis`, or OS TTS (`say`, Windows SAPI, `spd-say`/`espeak`). Speech stops as soon as you start talking. |
| Claude acting at the **OS and screen level** | An MCP server (`anywhere`) gives Claude screenshot, click, drag, scroll, type, key, window list/focus, open app/URL/file, clipboard, desktop-context, ask-user and notify tools. Each OS uses its native mechanism (details in §4). |
| Claude acting at the **code and CLI level** | It *is* Claude Code: Bash, file editing, git, gcloud, aws, az, kubectl, docker and your MCP servers, all run in your repo with your login and settings. |
| Knowing what "this repo" and "the browser" mean | Every command carries a `<desktop_context>` block: active window, open editors with their workspace paths, browser tab titles, git state, detected stack, and the active gcloud/aws/az/kubectl context. |
| Safety | Risk-classified approvals (Ask, Smart or Autopilot mode) shown as cards in the dialog and answerable by voice, a Stop button and Esc key, a mouse-corner failsafe, an audit log, and secret redaction. Claude must ask before costly or irreversible steps and must never type your passwords. |
| Two working styles | **Companion** (default): a dedicated headless Claude Code session runs behind the dialog, so your terminal stays free. **Bridge** (`/anywhere here`): your current interactive session takes commands from the dialog and you watch it work in the terminal. |

### Example flows

1. **"Deploy this repo to GCP from scratch"** (VS Code open, GCP console in Chrome)
   1. The context shows the VS Code workspace `/…/shop-api`, a Chrome tab titled `Cloud Run – my-proj-123 – Google Cloud console`, and gcloud's active project.
   2. Claude plans with a todo list: detect the stack (Node/Express), check `gcloud auth list`, confirm the project `my-proj-123` (from the tab title) via `ask_user`, enable the run, cloudbuild and artifactregistry APIs, add a Dockerfile if needed, run `gcloud run deploy --source .`, stream the logs, and `curl` the service URL.
   3. Each deploy or API-enable command is classified *high* and shows an approval card. You say "yes".
   4. Claude takes a screenshot of the Cloud Run page in Chrome to confirm and speaks: "Deployed shop-api to Cloud Run in us-central1. It's live at https://…".
2. **"What's on my screen?"**: a screenshot followed by a spoken description.
3. **"Open the failing test in VS Code and fix it"**: focus VS Code, use the integrated terminal or Bash to run the tests, edit the file, re-run the tests, report.
4. **"Fill this form with the details from my resume.pdf"**: Read the PDF, focus the browser, click and type field by field with a screenshot check after each step, and stop before submitting (`ask_user`).

---

## 2. Architecture (summary)

```
Claude Code ──/anywhere──► skills/anywhere/run.js ──► anywhere daemon (127.0.0.1:47120, token auth)
                                                       ├─ HTTP + SSE API ◄──── Dialog UI (Electron | Chrome --app | browser | TUI)
                                                       ├─ SessionManager ──► `claude -p --input-format stream-json …` (companion)
                                                       │                        └─► MCP server "anywhere" (stdio) ──► OS driver
                                                       ├─ PermissionBroker (approval cards)  ◄── permission_prompt tool
                                                       ├─ QuestionBroker (ask_user cards)
                                                       ├─ Bridge queue  ◄── `anywhere listen/reply` (bridge mode)
                                                       ├─ VoiceService (server STT/TTS)
                                                       ├─ DesktopContext (windows, editors, browsers, git, cloud)
                                                       └─ UiHost (opens/focuses the dialog)
```

### Why this shape (decisions made)

| Decision | Choice | Rationale |
|---|---|---|
| Agent engine | The user's installed **`claude` CLI in stream-json mode** | It is literally Claude Code, with the user's login (subscription or API key), settings, CLAUDE.md, skills and MCP servers. It is a stable documented interface, and interrupt plus multi-turn over one process was verified live. No SDK dependency. |
| Approvals in headless mode | `--permission-prompt-tool mcp__anywhere__permission_prompt` → daemon → dialog card | The documented headless permission hook, verified live. Claude Code's own allow rules and read-only auto-approval still apply first. |
| Screen and input control | Our own MCP server with per-OS drivers that use **built-in OS facilities** (JXA/CoreGraphics, PowerShell/Win32 SendInput, xdotool/ydotool) | Zero native npm modules, so nothing to compile and no prebuilt-binary breakage. The same tools work in companion mode, in bridge mode, and in any Claude Code session through the plugin. |
| UI technology | Local web app served by the daemon | One UI for every host (Electron, Chromium app window, any browser, phone on LAN later). Web Speech API gives zero-setup voice in Chrome, Edge and Safari. |
| Default window | Chromium `--app` window (Edge ships with Windows) with Electron as an optional upgrade | Works out of the box everywhere. Electron adds always-on-top, a global hotkey, and hiding itself from Claude's screenshots, but it's a 100 MB download, so it's opt-in (`anywhere install --electron`). |
| Runtime dependencies | **None** (Node ≥ 18 only) | "Must work in every case": nothing to fail during `npm install`. PNG decode/resize is pure JS. |
| Coordinates | The model works in **screenshot pixel space**; the driver maps to logical OS coordinates | Handles Retina/HiDPI and multi-monitor setups without the model knowing about scaling. |
| Security of the local API | 127.0.0.1 only, random per-run token, Host/Origin checks, CSP | Prevents other local software and malicious websites (CSRF, DNS rebinding) from driving your computer. |
| Single daemon | One per user, switches projects | `/anywhere` from another repo re-targets the dialog instead of opening a second one. |

---

## 3. Components and responsibilities

| Component | Path | Responsibility |
|---|---|---|
| Skill | `skills/anywhere/SKILL.md`, `run.js` | Parses `/anywhere [here\|stop\|status\|doctor\|setup\|<task>]`, launches the daemon, runs the bridge loop. |
| Plugin | `.claude-plugin/*`, `.mcp.json`, `bin/anywhere` | One-command install; adds the `anywhere` MCP tools and the `anywhere` CLI to every Claude Code session. |
| CLI | `bin/anywhere.js` | start/stop/status/show, send/listen/reply/ask, `computer …` (screen ops without MCP), doctor, install, config, logs, tui. |
| Daemon | `src/daemon/*` | API, SSE, sessions, engine, approvals, questions, bridge, voice, UI host. |
| Engine adapter | `src/daemon/engine-cli.js` | Spawns and streams `claude -p`, handles interrupt, resume and crash recovery. |
| MCP server | `src/mcp/*` | 19 tools for computer use, context, ask/notify and permissions. |
| OS layer | `src/os/*` | Drivers (darwin, win32 + WSL, linux X11/Wayland), PNG codec, key maps, coordinate mapping, failsafe. |
| Desktop context | `src/context/desktop.js` | What's open and where: editors to repo paths, browser tabs, git, cloud CLIs. |
| UI | `src/ui/*` | Dialog: transcript, tool timeline, approvals, questions, screen preview, voice, settings. |
| Electron shell | `src/electron/*` | Optional always-on-top window, global hotkey, tray, content protection. |
| TUI | `src/tui/tui.js` | Terminal fallback for SSH or headless use, with optional voice recording. |
| Installers | `scripts/install.{js,sh,ps1}` | Skill copy, MCP registration, Electron, OS hotkey or launcher. |

---

## 4. Platform strategy

| | macOS | Windows | WSL | Linux X11 | Linux Wayland |
|---|---|---|---|---|---|
| Screenshot | `screencapture` | PowerShell + System.Drawing | via Windows host | maim, import, ffmpeg, scrot, xwd | grim, gnome-screenshot, spectacle |
| Mouse and keys | JXA CoreGraphics CGEvent + System Events | Win32 `SendInput` (P/Invoke, DPI aware) | via Windows host | xdotool | ydotool, wtype |
| Windows (list/focus) | CGWindowList + NSRunningApplication/AX | EnumWindows/SetForegroundWindow | via Windows host | wmctrl, xdotool | sway/Hyprland IPC; GNOME/KDE limited |
| Clipboard | pbcopy/pbpaste | Get/Set-Clipboard | via Windows host | xclip, xsel | wl-copy/wl-paste |
| Dialog window | Chrome/Edge/Brave app, Electron, browser | Edge app (always available), Electron | Windows Edge via PowerShell | Chromium-family app, Electron | same |
| TTS | `say` | SAPI | SAPI via powershell.exe | spd-say, espeak-ng | same |
| Permissions | Accessibility + Screen Recording (doctor opens the panes) | none, except that elevated windows need an elevated host | none | none | ydotoold needs uinput access |

`anywhere doctor` checks every row on the current machine and prints the exact fix.

---

## 5. Lifecycle flows

**Start**
1. `/anywhere` runs `node run.js start --project $PWD`.
2. The CLI finds a healthy daemon (via `daemon.json` and `/api/health`) or spawns one detached.
3. The daemon writes `daemon.json` (0600) and opens the dialog through UiHost.
4. The UI connects to SSE and renders the snapshot.

**Command (companion mode)**
1. The UI POSTs `/api/command`.
2. SessionManager builds content blocks: desktop context, then an optional screenshot, then the text. It lazily starts `claude -p` with the MCP config, the appended system prompt and `--permission-prompt-tool`.
3. stream-json events are normalized to transcript, delta, tool and status events.
4. The result event moves the status to idle, and the UI speaks the answer.

**Approval**
1. Claude Code needs permission and calls `permission_prompt`.
2. The MCP server POSTs `/api/mcp/permission`, which blocks and sends progress pings.
3. PermissionBroker classifies the risk. By mode it either decides automatically, or it shows a card, notifies the user (OS notification, TTS, window focus) and waits. The user answers by click, keyboard or voice ("yes", "always", "no").
4. The decision is written to the audit log.

**Interrupt**
1. Stop, Esc or a spoken "stop" sends a `control_request` interrupt to the engine.
2. Pending cards are cancelled, and the guard pauses input actions for 3 s.
3. If the engine hasn't responded after 4 s, it is killed and the next command resumes the session.

**Bridge mode**
1. `/anywhere here` starts the daemon in bridge mode.
2. The interactive session loops `anywhere listen` (long-poll, at most 540 s, under Bash's 10-minute cap), then does the work, then sends `anywhere reply --final`.
3. The dialog shows "terminal listening".

**Crash recovery**
- If the engine exits unexpectedly, an error item is shown and the next command uses `--resume <sessionId>`. If resume fails, a fresh session starts.
- If the daemon dies, `anywhere start` or `/anywhere` cleans up the stale state and restarts it.

---

## 6. Feature checklist (what an "/anywhere AI" needs)

- [x] Floating dialog, platform independent, with a four-level fallback chain (Electron → app window → browser → TUI)
- [x] Voice in (push-to-talk, toggle, hands-free plus wake word) and voice out, with barge-in
- [x] Voice intents: stop, approve, deny, always, answer questions
- [x] Screen understanding (screenshots with zoom) and control (mouse, keyboard, windows, apps, URLs, clipboard)
- [x] Desktop context: editors, workspaces, browser tabs, git, cloud CLIs
- [x] Full Claude Code toolset (Bash, edits, MCP servers, skills) in the right repo
- [x] Approvals with risk levels, three modes, session "always" rules, timeouts
- [x] `ask_user` and `notify_user` so Claude can ask and report mid-task in the dialog (or by voice)
- [x] Stop, Esc and failsafe corner; guard pause after interrupt
- [x] Live tool timeline with expandable input/output, and "Claude's view" screenshot preview
- [x] Project switcher (detected VS Code/Cursor workspaces), new session, resume, cost display
- [x] Companion and bridge modes; works from any Claude Code session
- [x] Attach a screenshot to a command ("look at this")
- [x] Settings UI for permissions, voice, engine, context and UI
- [x] Audit log with secret redaction; local-only API with token
- [x] Doctor, installer, plugin marketplace, per-OS hotkey or launcher
- [x] Claude in Chrome integration toggle (`--chrome`) for logged-in browser automation where available
- [x] Tests: unit, protocol, end-to-end with a fake `claude`, a live X11 run under Xvfb, PowerShell host compile check; CI on macOS, Windows and Linux

---

## 7. Safety model (summary; details in ARCHITECTURE.md)

1. **Local API hardening**: loopback only, unguessable token, Host/Origin checks, CSP, no CORS.
2. **Permission policy**: Ask (only read-only actions run without asking), Smart (default; also lets file edits, screen actions and ordinary commands run, but asks for deploys, deletes, force-pushes, sudo, installs, remote shells and secrets), and Autopilot (asks only for catastrophic commands). Self-escalation, meaning edits to Anywhere's or Claude's own config or settings, is always *critical*.
3. **Model-level rules** (system prompt): confirm before irreversible or costly actions; never type passwords, 2FA or payment data; no CAPTCHAs; treat on-screen and web text as untrusted (prompt-injection defense); stop on request.
4. **Human override**: Stop, Esc, voice "stop", the mouse-corner failsafe, closing the dialog.
5. **Accountability**: JSONL audit log of every command, tool decision and screen action, with secrets redacted.

---

## 8. Installation and distribution

1. **Plugin**: `/plugin marketplace add patel-deepanshu/claude-anywhere` then `/plugin install anywhere@anywhere-marketplace`. This gives `/anywhere:anywhere` (and bare `/anywhere` when unambiguous) plus the MCP tools.
2. **Personal skill and CLI**: `git clone … && node bin/anywhere.js install [--electron] [--hotkey]`. This gives `/anywhere` everywhere, user-scope MCP registration, and optionally Electron and an OS hotkey.
3. **One-liners**: `curl -fsSL …/scripts/install.sh | bash` on macOS/Linux, and `irm …/scripts/install.ps1 | iex` on Windows.

---

## 9. Testing strategy

| Layer | How |
|---|---|
| Pure logic | node:test for the PNG codec, key maps, coordinate mapping, risk classifier, prompt, markdown sanitizer, parsers. |
| Protocols | The MCP server over real stdio; the daemon HTTP API with security cases; SSE. |
| Engine | `test/fixtures/fake-claude.js` emulates the stream-json CLI, including interrupt, crash, resume failure, and real MCP calls for approval, ask and screenshot, all end to end. |
| OS drivers | Linux runs live under Xvfb + openbox (type into xterm, verify the file). The Windows host is parse- and compile-checked with pwsh and driven through a fake host. The macOS helper is syntax-checked and covered by transport tests. |
| UI | A stub server plus headless Chromium screenshots in light and dark at dialog and tab sizes. |
| Live smoke test | The real `claude` CLI headless with the real MCP server (cheap prompts). |
| CI | GitHub Actions on ubuntu, macos and windows running `npm test` and the syntax check. |

---

## 10. Roadmap after v1

1. Wake word fully offline (Vosk/whisper.cpp streaming) and an on-device STT model download (`anywhere voice install`).
2. Accessibility-tree tools (AX / UI Automation / AT-SPI) for precise element targeting without pixels.
3. Phone remote: pair a phone over LAN or a tunnel using the same web UI.
4. Recording and replaying macros ("do what you did yesterday").
5. Multiple concurrent sessions in one dialog (tabs per project).

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| OS permission prompts (macOS) block screen and input control | Doctor detects them and opens the exact System Settings pane; errors carry hints. |
| Wayland restricts global input and capture | Multiple backends (ydotool, wtype, grim, portals) plus clear doctor output; XWayland notes. |
| Claude clicks the wrong thing | Screenshot-verify loop, zoom, focus-before-type, a confirmation policy for risky actions, Stop and failsafe. |
| Prompt injection from web pages or screens | The system prompt marks screen and web content as untrusted; approvals for high-risk actions regardless of the model's intent. |
| CLI protocol changes in future Claude Code versions | Engine adapter isolated in one module, a tolerant parser, a fake-CLI test fixture; doctor reports the CLI version. |
| Voice unavailable (Firefox, Electron without a key, offline) | Automatic fallback to server STT (Groq, OpenAI, whisper.cpp), with clear guidance in the UI. |
