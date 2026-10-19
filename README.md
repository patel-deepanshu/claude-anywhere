# Claude Anywhere

**`/anywhere` for Claude Code: a floating, voice-enabled dialog that lets Claude Code see and operate your whole
desktop.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js 18.17+](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20WSL%20%7C%20Linux-lightgrey.svg)
![Dependencies](https://img.shields.io/badge/npm%20dependencies-0-brightgreen.svg)

Created by **[Deepanshu Patel](https://github.com/patel-deepanshu)** · [MIT License](LICENSE) ·
[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

Type **`/anywhere`** in Claude Code and a small floating dialog opens on your desktop. Type or **talk** to it, and
Claude Code works across your whole computer: it sees the screen, clicks, types, switches windows, opens apps and
URLs, and still has every Claude Code tool (shell, git, file edits, your MCP servers) running in your repo.

> *"VS Code has my repo open and I have GCP open in Chrome. Start deploying this repo from scratch."*
>
> Claude reads which repo VS Code is showing and which GCP project the Chrome tab is on. It checks `gcloud`,
> enables the APIs, containerizes the app and asks you before the deploy. It deploys to Cloud Run, checks the
> result on screen, and tells you the URL out loud.

> **Note:** Claude Anywhere is an independent open-source project. It is not affiliated with, endorsed by or
> sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC; Claude Anywhere is a plugin
> that works with your own Claude Code installation and account.

---

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Examples](#examples)
- [Safety](#safety)
- [Platforms](#platforms)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Reporting bugs](#reporting-bugs)
- [Contributing](#contributing)
- [Development](#development)
- [Author and credits](#author-and-credits)
- [License](#license)

---

## Features

- **A dialog for Claude Code on your desktop.** A small, always-available window (Electron, a Chrome/Edge app
  window, a browser tab, or a terminal dialog) with a streaming transcript, a timeline of every action, and
  approval and question cards. A dedicated headless Claude Code session works behind it, so your terminal stays
  free.
- **Real screen control.** Screenshots, mouse, keyboard, windows, apps, URLs and the clipboard on macOS, Windows,
  WSL and Linux (X11 and Wayland), mapped correctly across HiDPI and multiple monitors.
- **Desktop assistant.** Presses buttons, tabs, links and menu items **by name** through your OS's accessibility
  API, reads on-screen text with on-device OCR, launches and quits apps, arranges windows, and finds browser
  bookmarks and tabs.
- **Voice.** Talk instead of typing (push-to-talk or hands-free with a wake word), hear answers, and get spoken
  announcements when work is done or Claude needs you, with an optional free, offline neural voice (Piper).
- **Jira tickets to working code.** Reads the ticket from your open browser tab or the Jira API, asks which repo
  to work in, creates the branch, implements, tests and commits.
- **Answer calls in your own voice** (opt-in). After a consented voice recording and a click, an AI assistant
  answers your Zoho Cliq, Google Meet, Teams, Slack and Zoom calls, always says it is an AI, helps with safe
  requests and leaves notes on your Desktop.
- **Safety by design.** A local-only API with tokens, a risk classifier with permission modes, approval cards for
  risky actions, click-only approval for critical ones, a failsafe corner, and an audit log.
- **Zero npm dependencies.** Node.js and your OS's own tools; optional components are downloaded only when you ask
  for them.

When a capability is missing, Claude Anywhere falls back to something simpler: an Electron window, then a
Chrome/Edge app window, then a browser tab. With no display at all it prints the dialog's URL (open it through an
SSH tunnel) and the command for the terminal dialog (`anywhere tui`). `anywhere doctor` tells you exactly what to
fix.

---

## Screenshots

These screenshots were captured from a live test run on Linux (an Xvfb virtual display with the openbox window
manager), driving the real Claude Code CLI.

| The dialog | An approval card for a risky command |
|---|---|
| ![The Claude Anywhere dialog, ready for a command](docs/images/dialog.png) | ![A high-risk approval card for rm -rf, with Allow once, Always (session) and Deny](docs/images/approval-card.png) |

Claude typing a command into a terminal and checking the result on screen, with every step in the dialog's
timeline:

![Claude Anywhere controlling an xterm window while the dialog shows the screenshots and actions it took](docs/images/screen-control.png)

---

## Requirements

- **Node.js 18.17 or newer**.
- **Claude Code**, with `claude` on your PATH and logged in.
- **A desktop**: macOS, Windows 10/11, WSL, or Linux with X11 or Wayland. Per-OS setup and permissions are in
  [docs/PLATFORMS.md](docs/PLATFORMS.md):
  - **macOS 11 or newer** (13 or newer for call audio capture): grant **Accessibility** and **Screen Recording** to
    the app that runs Claude Code.
  - **Windows**: nothing extra (it uses the built-in PowerShell).
  - **Linux X11**: `xdotool wmctrl xclip imagemagick x11-xserver-utils`. **Wayland**: `ydotool` 1.0+, `grim` and
    `wl-clipboard`.
- **Optional**: Chrome or Edge for in-browser speech recognition; Python 3 for the voice clone runtime; free Linux
  packages for the desktop assistant (`python3-gi gir1.2-atspi-2.0 at-spi2-core`, `tesseract-ocr`).

---

## Installation

**Option A: Claude Code plugin** (inside Claude Code)

```
/plugin marketplace add patel-deepanshu/claude-anywhere
/plugin install anywhere@anywhere-marketplace
```

This adds the `/anywhere:anywhere` skill (also `/anywhere` when no other command uses that name) and gives every
session the `anywhere` screen-control tools.

**Option B: personal skill plus CLI** (gives exactly `/anywhere` in every project)

```bash
git clone https://github.com/patel-deepanshu/claude-anywhere ~/.claude-anywhere/app
node ~/.claude-anywhere/app/bin/anywhere.js install            # add --hotkey and/or --electron
```

**Option C: one-line installers**

```bash
curl -fsSL https://raw.githubusercontent.com/patel-deepanshu/claude-anywhere/main/scripts/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/patel-deepanshu/claude-anywhere/main/scripts/install.ps1 | iex
```

Then run `/anywhere doctor` in Claude Code (or `anywhere doctor` in a terminal; for Option B, before `anywhere` is
on your PATH, run `node ~/.claude-anywhere/app/bin/anywhere.js doctor`) and follow any `✗` fixes.

- `anywhere install` links the `anywhere` command into `~/.local/bin` on macOS, Linux and WSL. For the plugin
  (Option A), the link and the hotkey run a small launcher in `~/.claude-anywhere/launcher` that finds the
  installed plugin version each time, so they keep working after `/plugin update`.
- On macOS, Option B and Option C show the Accessibility and Screen Recording prompts when run in a terminal;
  Option A and `/anywhere setup` print the System Settings shortcuts instead.

Optional extras:

- `anywhere install --electron`: an always-on-top window, a global hotkey (Ctrl/Cmd+Shift+Space), and a dialog
  that is hidden from Claude's screenshots. It installs the current Electron release, which needs Node.js 22.12 or
  newer.
- `anywhere install --hotkey`: an OS-level shortcut or launcher (Windows Ctrl+Alt+F12, GNOME Ctrl+Alt+A, a macOS
  app to bind in Shortcuts).

**Uninstall:** `anywhere uninstall` removes the skill, the MCP registration, the `~/.local/bin/anywhere` link (and
the plugin launcher) and the user PATH entry that install.ps1 added; `--purge` also deletes `~/.claude-anywhere`.

---

## Quick start

1. Open Claude Code in a project and type `/anywhere`. The dialog opens for that repo.
2. Type or say what you want: *"What's on my screen?"*, *"Run the tests and fix the failing one"*, *"Deploy this
   repo to Cloud Run"*.
3. Watch the timeline. When Claude wants to do something risky, an approval card appears: click **Allow once**,
   **Always (session)** or **Deny** (or say *"yes"*, *"always"* or *"no"*).
4. Press **Esc**, click **Stop** or say *"stop"* to interrupt at any time. `/anywhere stop` shuts it down.

---

## Usage

### In Claude Code

| Command | What happens |
|---|---|
| `/anywhere` | Opens the dialog for the current repo. A dedicated headless Claude Code session works behind it, and your terminal stays free. A dialog left in bridge mode with no terminal listening goes back to companion mode; when it cannot (a terminal still listens or holds a command, or a command typed meanwhile waits for one), the output says so and how to switch. |
| `/anywhere deploy this to Cloud Run` | Opens the dialog and hands it the task. |
| `/anywhere here` | **Bridge mode**: *this* terminal session takes the dialog's commands, so you can watch it work. |
| `/anywhere status` · `/anywhere stop` | Shows what it's doing, or shuts it down. |
| `/anywhere doctor` · `/anywhere setup` | Checks this machine, or installs the personal skill and MCP tools. |
| `/anywhere:clone-voice` · `/anywhere clone-voice` | Records your own voice (consent sentence + 14 short lines, about 3 minutes) for answering calls. It stays on this computer; `delete` removes it. |
| `/anywhere answer my calls until 6` | After **your click** in the dialog, an AI assistant answers your calls in your voice, says it is an AI, helps with safe requests and leaves notes on your Desktop. `calls off` stops it. |

### In the dialog

- **Type** and press Enter, or **talk**: click the mic, or hold Space for push-to-talk. Say "stop" to interrupt.
- **Approvals** appear as cards for risky actions (deploys, deletes, `sudo`, force-pushes…). Click, or say
  *"yes"*, *"always"* or *"no"*.
- **Questions** from Claude appear as cards with options. Answer by clicking, typing or speaking.
- **Include screen** attaches a screenshot to your message ("what's wrong with this page?"), remembered per
  browser until "Attach a screenshot by default" changes.
- **Claude's view** shows the last screenshot Claude took. The tool timeline shows every click, keystroke and
  command.
- Pick a different repo from the project chip (it lists detected VS Code/Cursor workspaces). ⚙ opens the settings.
- Shortcuts: Esc stops, Ctrl/Cmd+K focuses the input, Ctrl/Cmd+Shift+M toggles the mic, Ctrl/Cmd+Shift+N starts a
  new session.

### From any terminal

```bash
anywhere "summarize the PR that's open in my browser"   # start if needed, then send the task
anywhere show                                           # bring the dialog back
anywhere tui                                            # terminal dialog (SSH or headless)
anywhere computer screenshot --out screen.png           # the screen tools, without MCP
anywhere send --project ~/other-repo "run the tests"    # a task for another folder
anywhere status · anywhere stop · anywhere doctor · anywhere logs -n 80
```

A busy dialog keeps its project and mode: `anywhere start` and `anywhere send --project` leave a running task
alone and say so. Add `--switch` to stop that task and switch.

### Voice

| | Works out of the box | Optional upgrades |
|---|---|---|
| Speech to text | Chrome, Edge and Safari (Web Speech API, live transcript) | Set `GROQ_API_KEY` or `OPENAI_API_KEY`, or any OpenAI-compatible endpoint, or install **whisper.cpp** for fully local STT. These are used automatically in Firefox, Electron and the TUI, or when browser speech fails. |
| Text to speech | Piper, a free offline neural voice (`anywhere voice install`), browser voices, or the OS (`say`, Windows SAPI, `spd-say`/`espeak-ng`) | Spoken announcements when work is done or Claude needs you |

Hands-free mode listens continuously and acts on what you say after the wake word (*"hey claude"*).

Claude tells you out loud when the work is done, when it needs your permission, when it has a question, and when
something failed. For a voice that sounds like a person, install **Piper**, a free and open-source neural
text-to-speech engine that runs offline on your computer (no account, no API key, no cost):

```bash
anywhere voice install            # Piper + a natural US English voice (about 80-100 MB, into ~/.claude-anywhere/voice)
anywhere voice list               # more voices: US/UK English, German, French, Spanish, Italian, …
anywhere voice use en_US-ryan-high
anywhere voice test
```

Or press **Install** in ⚙ Settings → Voice. Without Piper, Claude Anywhere uses the most natural voice your browser
or OS has. Turn kinds of announcements off in Settings → Voice, or with
`anywhere config set voice.announce.done false` (also `.permission`, `.question`, `.error`). Details:
[docs/VOICE.md](docs/VOICE.md).

---

## Examples

### Deploy a repo to the cloud

> *"VS Code has my repo open and GCP is open in Chrome. Deploy this repo from scratch."*

Claude reads the open workspace and the GCP project from the browser, checks `gcloud`, asks you the questions it
needs up front (region, public or private), containerizes the app, deploys it, verifies the service and reports
the URL. Deploys and IAM changes always show an approval card first.

### Work on a Jira ticket

> *"My Jira tab is open in Brave. Analyze the ticket and start working on it."*

Claude finds the ticket key in the browser tab, reads the ticket with its acceptance criteria, summarizes it with a
short plan, then **asks you** which repository and folder to work in (it lists the git repositories it finds, plus
"another folder" and "create a new folder") and whether to move the ticket to In Progress and assign it to you.
It then creates a branch such as `ABC-123-fix-login-timeout`, implements and tests the change, commits, and asks
before pushing or opening a PR.

Connecting Jira is optional and free (an Atlassian API token):

```bash
anywhere jira setup               # Jira Cloud or Server/Data Center; the token is typed hidden
anywhere jira issue ABC-123       # what Claude reads
```

or ⚙ Settings → Jira & repos. Without it, Claude uses an Atlassian/Jira MCP server if you have one, or reads the
ticket straight from the page. Add the folders where you keep code under Settings → Jira & repos → Workspace roots
(`workspace.roots`) so the repository list is complete. Details: [docs/JIRA.md](docs/JIRA.md).

### Use any app like a person would

> *"Open the Jira site saved in my Brave bookmarks bar, check my work in the For you tab, pick the ticket and start
> it in the shop-api repo."* · *"Open Figma and design an e-commerce dashboard."* · *"Check my WhatsApp messages
> and reply."* · *"Trim the first 10 seconds of this video in Shotcut."*

Claude opens and quits apps, arranges windows, finds bookmarks in any browser profile and opens them where you are
signed in, switches tabs, and presses buttons, tabs, links and menu items **by name** through your OS's
accessibility API (macOS AX, Windows UI Automation, Linux AT-SPI). Where an app draws its own interface (Figma's
canvas, games, video editors) it finds text with on-device OCR (Apple Vision, Windows OCR, tesseract) and clicks it
with the real pointer. It checks each step on screen and can run short sequences in one go, pausing whenever you
press Stop.

| Tools | |
|---|---|
| Apps and windows | `list_apps`, `launch_app`, `quit_app`, `set_window` (maximize, halves, bounds), `wait_for` |
| Browsers | `browser_bookmarks`, `browser_open`, `browser_tabs`, `browser_switch_tab` |
| App controls | `ui_find`, `ui_tree`, `ui_click`, `ui_set_value` |
| Screen text | `find_text`, `read_screen_text` |
| Faster loops | `screenshotAfter` on every action, `batch_actions` |

The same from a terminal: `anywhere desktop apps|launch|quit|bookmarks|open-url|tabs|switch-tab|window|wait` and
`anywhere computer ui-find|ocr|apps`. It costs nothing extra: built-in OS features, plus optional free packages on
Linux (`python3-gi gir1.2-atspi-2.0 at-spi2-core` for app controls, `tesseract-ocr` for screen text, and `wmctrl`,
`sqlite3`, `gtk-launch` for gentler quits, current Firefox bookmarks and exact app launches). Safari bookmarks need
Full Disk Access, and listing tabs on macOS needs the Automation permission. On GNOME and KDE under Wayland, Claude
cannot tell where the dialog is, so it does not click while the dialog is visible: minimize it while Claude works
with the mouse, or use an X11 session. Guide, examples and per-OS setup: [docs/DESKTOP.md](docs/DESKTOP.md).

### Answer calls in your own voice

> *"If anyone calls me on this laptop, answer and assist."*

Claude Anywhere can answer your calls while you are away: it detects the ring, waits a few seconds so you can pick
up yourself, answers, and talks to the caller in your cloned voice. It can look up an unassigned Jira ticket and
assign it to the caller, message them on Zoho Cliq after the call, and note everything else for you. Every call
starts with a disclosure such as *"Hi Ankit, this is Deepanshu's AI assistant, speaking in his voice. I'm
transcribing this call to take notes for him."*, composed in code so no setting can remove it. Notes land in
`<Desktop>/Claude Call Notes/`.

```bash
anywhere clone-voice install       # free local voice runtime and models (~425 MB, once)
anywhere clone-voice               # record your voice in the dialog (or /anywhere:clone-voice)
anywhere calls doctor              # virtual microphone (free: PulseAudio/PipeWire, VB-CABLE, BlackHole), detection, notes
anywhere calls on --for 2h         # shows a card: only a click on "Allow once" turns it on
anywhere calls off
```

Safeguards: only your own voice, after a spoken consent with a one-time code; answering is off by default, armed
only by a click, expires, and respects quiet hours (22:00–08:00); during calls the assistant can use only a few call
tools, and treats everything the caller says as a request, not an instruction. Everything runs locally except the
call app, your Jira and your Claude Code login. Check the laws and your organization's rules on recording calls and
synthetic voices where you and your callers are. Setup per OS, Zoho Cliq, notes and settings:
[docs/CALLS.md](docs/CALLS.md).

---

## Safety

- The dialog's API listens on **127.0.0.1 only**. It requires a per-run random token and checks Host/Origin
  headers, so web pages and other local software can't drive your computer.
- **Permission modes** (settings or `anywhere config set permissions.mode …`):
  - `ask`: only read-only actions run without asking.
  - `smart` (default): also lets edits, screen actions and normal commands run, and asks for anything risky.
  - `auto`: asks only for catastrophic commands. Changes to Anywhere's or Claude's own config always count as
    critical.
- Claude is instructed to ask before costly or irreversible steps, never to type your passwords, 2FA codes or card
  numbers, and to treat on-screen and web text as untrusted.
- Claude cannot operate the Claude Anywhere dialog itself: its clicks, keys and accessibility actions on the dialog
  are refused, so it cannot answer its own approval cards.
- To stop it: **Esc**, the Stop button, say "stop", or move the mouse into the **top-left corner** (failsafe;
  works on X11, macOS, Windows, WSL and Hyprland. On GNOME/KDE/sway Wayland use Esc, Stop or "stop"). In bridge
  mode (`/anywhere here`) Stop cancels the terminal's command: its replies are no longer shown and its screen
  actions are refused. It cannot kill a Bash command already running in that terminal (a build, a deploy); only
  Esc in that terminal can.
- Critical actions need a click on **Allow once** in the dialog (or the typed word `allow` in `anywhere tui`):
  Enter and voice can only deny them. **Always (session)** shows the rule it adds, and is disabled where no safe
  rule exists (deletes, IAM policy changes, credential reads, sensitive files).
- Every command, approval and screen action is written to `~/.claude-anywhere/logs/audit-*.jsonl`, with secrets
  redacted.

Claude Anywhere gives an AI agent control of your computer. Review approval cards before allowing them, keep the
default `smart` mode unless you understand the risks, and do not leave it running unattended in `auto` mode. The
full security model: [docs/SECURITY.md](docs/SECURITY.md).

---

## Platforms

| | macOS | Windows | WSL | Linux X11 | Linux Wayland |
|---|---|---|---|---|---|
| Screen and input | ✓ (grant permissions) | ✓ built-in PowerShell | ✓ via Windows | ✓ `xdotool` + `wmctrl` + `xclip` + ImageMagick | ◐ `ydotool` 1.0+, `grim`, `wl-clipboard` (sway/Hyprland window control) |
| Dialog | Chrome, Edge, Brave app window or Electron | Edge app window (always present) or Electron | Windows Edge | Chromium-family app window or Electron | same |
| Voice | ✓ | ✓ | ✓ | ✓ | ✓ |

Per-OS setup and permissions: [docs/PLATFORMS.md](docs/PLATFORMS.md).

---

## Configuration

`anywhere config set <key> <value>` (stored in `~/.claude-anywhere/config.json`), or use the ⚙ settings drawer.

| Key | Default | Meaning |
|---|---|---|
| `permissions.mode` | `smart` | `ask` · `smart` · `auto` |
| `permissions.alwaysAllow` / `alwaysAsk` | `[]` | Rules such as `"Bash(npm test*)"`, `"mcp__anywhere__click"` |
| `engine.model` | (Claude Code default) | e.g. `opus`, `sonnet`, `haiku` |
| `engine.chrome` | `false` | Enable Claude in Chrome (`--chrome`) for logged-in browser automation |
| `engine.claudePath` | auto | Path to the `claude` binary |
| `ui.host` | `auto` | `electron` · `app` · `browser` · `tui` · `none` |
| `ui.alwaysOnTop`, `ui.hotkey` | `true`, `CommandOrControl+Shift+Space` | Electron and app-window behaviour |
| `voice.stt` / `voice.tts` | `auto` | `browser` · `server` · `off` |
| `voice.language`, `voice.handsFree`, `voice.wakeWord` | `en-US`, `false`, `hey claude` | |
| `voice.sttProvider` | `auto` | Server speech-to-text provider |
| `voice.sttBaseUrl`, `voice.sttApiKey`, `voice.sttModel` | (empty) | A custom OpenAI-compatible speech-to-text endpoint |
| `voice.ttsEngine` | `auto` | `piper` · `browser` · `os` (auto = Piper when installed) |
| `voice.piperVoice` | `en_US-lessac-medium` | The Piper voice (`anywhere voice use …`) |
| `voice.announce.done` / `.permission` / `.question` / `.error`, `voice.chime` | `true` | What is said aloud, and the chime before it |
| `jira.baseUrl`, `jira.email`, `jira.apiToken` | (empty) | Jira connection (`anywhere jira setup`); the token is never shown |
| `voice.clone.enabled`, `voice.clone.engine` | `false`, `pocket` | Your cloned voice (set by the enrollment; `zipvoice` is the slower quality voice) |
| `calls.apps`, `calls.answerAfterSec`, `calls.quietHours` | all five apps, `8`, `22:00`–`08:00` | Which call apps are answered, after how long, and never when ([docs/CALLS.md](docs/CALLS.md)) |
| `calls.ownerName`, `calls.ownerPronoun`, `calls.greeting` | (Jira/OS name), `their`, (empty) | How the greeting names you; the disclosure is always kept |
| `calls.notesDir`, `calls.cliq.mode` | (Desktop), `gui` | Where call notes go; `api` after `anywhere calls cliq setup` |
| `workspace.roots` | `[]` | Folders searched first for repositories when Claude asks where to work |
| `context.attachDesktopContext` | `true` | Send the active window, editors, browser tabs, git and cloud CLI state with each command |
| `computer.maxWidth` / `maxHeight` | `1366` / `768` | Screenshot size sent to the model |
| `computer.failsafe` | `true` | Top-left-corner emergency stop |
| `port` | `47120` | Local API port (falls back to a random port if busy) |

Environment variables: `ANYWHERE_HOME`, `ANYWHERE_CLAUDE_PATH`, `ANYWHERE_BROWSER`, `ANYWHERE_ELECTRON`,
`ANYWHERE_DRIVER`, `ANYWHERE_STT_API_KEY` / `ANYWHERE_STT_BASE_URL` / `ANYWHERE_STT_MODEL`,
`GROQ_API_KEY`, `OPENAI_API_KEY`, `ANYWHERE_PIPER_PATH`, `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`,
`ANYWHERE_PYTHON`, `ANYWHERE_CLONE_ASSET_BASE` / `ANYWHERE_CLONE_UV_BASE` (download mirrors for the voice runtime),
`ANYWHERE_CLONE_WSL=linux`, `ANYWHERE_DEBUG=1`, and `ANYWHERE_UNICODE=1` / `ANYWHERE_ASCII=1`.

`anywhere tui` and the `anywhere` CLI use ASCII symbols unless the locale (`LC_ALL`, `LC_CTYPE`, then `LANG`) is
UTF-8: on Linux an unset locale means ASCII, while macOS defaults to Unicode. `ANYWHERE_UNICODE=1` forces the
symbols and `ANYWHERE_ASCII=1` forces ASCII.

---

## How it works

```
/anywhere ─► skills/anywhere/run.js ─► anywhere daemon (127.0.0.1, token)
                                         ├─ dialog UI (Electron | Chrome --app | browser | TUI) ◄─ SSE
                                         ├─ claude -p --input-format stream-json …  (your Claude Code)
                                         │     └─ MCP server "anywhere": screenshot · click · type · key ·
                                         │        windows · open · clipboard · context · ask_user · notify ·
                                         │        read_browser_tab · jira_* · find_repos · switch_project ·
                                         │        ui_* · find_text · apps · browsers · batch_actions
                                         ├─ approvals (--permission-prompt-tool) · questions · bridge queue
                                         ├─ voice (server STT, Piper/OS TTS, announcer) · desktop context · audit log
                                         └─ calls: ring detection · voice sidecar (clone TTS, local STT) · virtual mic ·
                                            claude -p haiku with call-only tools · notes on the Desktop
```

| Folder | Contents |
|---|---|
| `bin/` | The `anywhere` CLI entry point and shims |
| `src/daemon/` | The local daemon: HTTP/SSE API, Claude Code engine adapter, sessions, approvals, voice, UI host |
| `src/mcp/` | The `anywhere` MCP server and its tools |
| `src/os/` | Screen, input, window, accessibility and OCR drivers for macOS, Windows/WSL and Linux, plus a mock driver |
| `src/ui/`, `src/tui/`, `src/electron/` | The dialog (web UI), the terminal dialog, and the optional Electron shell |
| `src/calls/`, `src/voice/clone/` | Call answering and the voice clone runtime |
| `src/integrations/`, `src/context/`, `src/cli/`, `src/shared/` | Jira client, desktop context, CLI commands, shared modules |
| `skills/` | The `/anywhere` and `/anywhere:clone-voice` skills |
| `.claude-plugin/` | The Claude Code plugin and marketplace manifests |
| `scripts/` | Installers, the test runner and the syntax check |
| `test/` | The `node:test` suite |
| `docs/` | Guides and the architecture contract |

---

## Troubleshooting

- **Nothing opens**: run `anywhere show`, or open the URL from `anywhere url`. Check `anywhere doctor` and
  `anywhere logs -n 80`.
- **"claude not found"**: run `anywhere config set engine.claudePath "$(which claude)"`, then `anywhere restart`.
- **Clicks land in the wrong place or nothing happens on macOS**: grant Accessibility and Screen Recording to your
  terminal or VS Code, then restart it.
- **Linux**: `sudo apt install xdotool wmctrl xclip imagemagick x11-xserver-utils` (X11). On Wayland, input needs
  ydotool 1.0 or newer (Debian 12 and Ubuntu up to 24.04 ship 0.1.8, which doesn't work); see
  [docs/PLATFORMS.md](docs/PLATFORMS.md).
- **Voice button greyed out**: use Chrome or Edge, or set `GROQ_API_KEY` or `OPENAI_API_KEY` (see
  [docs/VOICE.md](docs/VOICE.md)).
- **No spoken announcements**: check `anywhere voice status` (engine, voice, audio player) and Settings → Voice →
  Speak answers; `anywhere voice test` plays a sample.
- **Jira**: `anywhere jira test` explains a failed connection (wrong token, SSO, proxy); see
  [docs/JIRA.md](docs/JIRA.md).
- **Calls**: `anywhere calls doctor` checks the voice runtime, the virtual microphone, ring detection and the notes
  folder, and `anywhere calls test-audio` tests the audio in your browser; see [docs/CALLS.md](docs/CALLS.md).

---

## Documentation

| Guide | Contents |
|---|---|
| [docs/PLATFORMS.md](docs/PLATFORMS.md) | Per-OS setup, permissions and limitations |
| [docs/SECURITY.md](docs/SECURITY.md) | The security model: API protection, approvals, risk classes, dialog protections |
| [docs/VOICE.md](docs/VOICE.md) | Speech input and output, Piper voices, announcements |
| [docs/JIRA.md](docs/JIRA.md) | Connecting Jira and the ticket workflow |
| [docs/DESKTOP.md](docs/DESKTOP.md) | The desktop assistant: app controls, screen text, apps, windows, browsers |
| [docs/CALLS.md](docs/CALLS.md) | The voice clone and answering calls |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The module contract for contributors |
| [docs/PLAN.md](docs/PLAN.md), [docs/CALLS-DESIGN.md](docs/CALLS-DESIGN.md) | Design plans with the decisions and their rationale |

---

## Reporting bugs

Found a bug? Open an issue at <https://github.com/patel-deepanshu/claude-anywhere/issues> with:

- what you did, what you expected, and what happened (the exact error message);
- your OS and version (on Linux: X11 or Wayland, and your desktop), `node --version` and `claude --version`, and
  how you installed Claude Anywhere;
- the output of `anywhere doctor` and the last lines of `anywhere logs -n 80`.

Remove anything private before posting, and never share `~/.claude-anywhere/daemon.json`, `config.json` or the
files in `~/.claude-anywhere/run/` (they hold access tokens). **Security vulnerabilities** should be reported
privately, not in a public issue: see [CONTRIBUTING.md](CONTRIBUTING.md#reporting-security-issues).

---

## Contributing

Contributions are welcome: bug fixes, platform support, documentation, tests and ideas. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for the process (fork, branch, test, pull request) and the coding guidelines.
Every contributor is credited: your commits keep your authorship, and merged contributions are listed in
[CONTRIBUTORS.md](CONTRIBUTORS.md) and the [changelog](CHANGELOG.md).

---

## Development

```bash
git clone https://github.com/patel-deepanshu/claude-anywhere
cd claude-anywhere
npm test                     # about 1,800 node:test tests (Node 18+); no network, display or audio device needed
npm run lint                 # node scripts/check-syntax.js
claude plugin validate .     # the plugin and marketplace manifests
ANYWHERE_DRIVER=mock node bin/anywhere.js computer screenshot --out /tmp/s.png
ANYWHERE_LIVE_DESKTOP=1 node scripts/test.js --test-name-pattern=live-desktop   # drives YOUR real desktop
```

There are no npm dependencies to install. CI (`.github/workflows/ci.yml`) runs the suite on Linux, macOS and
Windows with Node 18 and 22. It also compiles the Win32 helper under Windows PowerShell 5.1, and drives the real
desktops of the Windows and macOS runners (Notepad and TextEdit: screenshots, mouse, unicode typing, windows,
clipboard, CLI and MCP) and an Xvfb X11 desktop.

The repository is both the plugin (`.claude-plugin/`) and its marketplace.

---

## Author and credits

Claude Anywhere was created by **Deepanshu Patel** ([@patel-deepanshu](https://github.com/patel-deepanshu)), who
maintains the project. Contributors are listed in [CONTRIBUTORS.md](CONTRIBUTORS.md).

Claude Anywhere works with these free and open-source projects, used only when you choose to install or enable
them: [Piper](https://github.com/rhasspy/piper) (text to speech; the release binaries are MIT, and the `piper-tts`
package used on macOS and as a fallback comes from [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl)
under GPL-3.0-or-later), [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
with Kyutai Pocket TTS and Moonshine models (voice clone and speech recognition),
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) (optional local speech recognition),
[tesseract](https://github.com/tesseract-ocr/tesseract) (optional screen text on Linux) and
[Electron](https://www.electronjs.org/) (optional dialog window). Each is distributed under its own license.

---

## License

Claude Anywhere is released under the [MIT License](LICENSE).

Copyright (c) 2026 Deepanshu Patel
