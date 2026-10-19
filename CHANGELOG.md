# Changelog

All notable changes to Claude Anywhere are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once releases are published.

This changelog was compiled from the project's Git history. No version has been tagged or released yet; the
package version is `0.1.0`.

## [Unreleased]

### Added

- **`/anywhere` dialog for Claude Code**: a local daemon (HTTP and server-sent events on `127.0.0.1`, with a
  per-run token, Host/Origin checks and single-use launch codes) that runs a headless Claude Code session and
  shows a floating dialog (Electron, a Chromium-family app window, a browser tab, or the terminal dialog
  `anywhere tui`) with a streaming transcript, a tool timeline, approval and question cards, and settings.
- **Computer-use MCP server** (`anywhere`): screenshots, mouse, keyboard, windows, opening apps and URLs,
  clipboard, desktop context, `ask_user` and `notify_user`, through OS drivers for macOS (JXA/CoreGraphics),
  Windows and WSL (a persistent PowerShell/Win32 host) and Linux (X11 and Wayland), plus a mock driver.
- **Approvals**: a risk classifier (low, medium, high, critical) for shell commands, file edits and screen
  actions, with `ask`, `smart` and `auto` permission modes; critical actions can only be allowed by a click in
  the dialog.
- **Bridge mode** (`/anywhere here`): the current Claude Code terminal session takes the dialog's commands.
- **Voice**: speech input (Web Speech API, OpenAI-compatible or Groq servers, or local whisper.cpp), spoken
  answers, push-to-talk and hands-free mode with a wake word.
- **Natural voice announcements**: optional Piper neural text-to-speech (free and offline,
  `anywhere voice install`) that says when work is done, when a permission or question needs you, and when
  something failed.
- **Jira ticket workflow**: reads the ticket from the open browser tab (`read_browser_tab`) or the Jira REST API
  (Cloud and Data Center, `anywhere jira setup`), asks which repository and folder to work in (`find_repos`,
  `switch_project`), creates the ticket branch, and moves the ticket to In Progress after asking.
- **Voice clone and AI-answered calls**: `/anywhere:clone-voice` records the user's own voice after a spoken
  consent with a one-time code, entirely on the computer; `anywhere calls on` (armed only by a click) answers
  Zoho Cliq, Google Meet, Teams, Slack and Zoom calls in that voice with a mandatory AI disclosure, can assign a
  Jira ticket to the caller and message them on Zoho Cliq, and writes call notes to the Desktop.
- **Desktop assistant**: accessibility-tree element tools (`ui_find`, `ui_tree`, `ui_click`, `ui_set_value`) on
  macOS AX, Windows UI Automation and Linux AT-SPI; on-device text recognition (`find_text`,
  `read_screen_text`, `wait_for`) with Apple Vision, Windows OCR or tesseract; installed apps (`list_apps`,
  `launch_app`, `quit_app`), window placement (`set_window`), browser bookmarks and tabs (`browser_bookmarks`,
  `browser_open`, `browser_tabs`, `browser_switch_tab`), `batch_actions` and `screenshotAfter`; the
  `anywhere desktop …` commands.
- **CLI** (`anywhere`): `start`, `stop`, `status`, `show`, `send`, `tui`, `doctor`, `install`, `uninstall`,
  `config`, `logs`, `computer …`, `voice …`, `jira …`, `clone-voice …`, `calls …` and `desktop …`.
- **Packaging**: the Claude Code plugin and marketplace manifests, the personal skill, and install scripts for
  macOS, Linux (`scripts/install.sh`) and Windows (`scripts/install.ps1`).
- **Extension hooks**: feature modules add MCP tools (`src/mcp/tools-*.js`), daemon routes
  (`src/daemon/routes-*.js`) and CLI commands (`src/cli/*.js`) without changing the core.
- **Tests and CI**: a `node:test` suite that needs no network, display or audio device, a failing-test recap at
  the end of the run, and CI on Linux, macOS and Windows with Node 18 and 22, a Windows PowerShell 5.1 compile
  check, and live desktop jobs on Xvfb, Windows and macOS runners.
- **Documentation**: the README, guides in `docs/` (platforms, security, voice, Jira, calls, desktop assistant)
  and the architecture contract.
- **Release files**: `CONTRIBUTING.md`, `CONTRIBUTORS.md`, this changelog, and screenshots in `docs/images/`.

### Security

- Three rounds of review and live end-to-end testing hardened the permission classifier (command wrappers,
  `git`/`sed`/`find -exec` escapes, shell text typed into terminals, PowerShell and `cmd.exe` forms, credential
  and token readers), required a real click for critical approvals (enforced by the daemon), kept the API token
  off browser command lines, and gave the engine its own token that cannot answer approval cards or change
  settings.
- Claude cannot operate the Claude Anywhere dialog itself: clicks, keys and accessibility actions on the dialog
  (including its window frame) are refused, `set_window` refuses it, and `quit_app` never ends the dialog's
  browser. On GNOME and KDE Wayland, where the dialog cannot be located, input waits while the dialog is visible.
  Settings that loosen approvals are refused while Claude is working.
- `browser_open` only starts known browsers; `launch_app` and `open` judge terminals and shells given by display
  name, and command-line flags such as `-e`, `-c`, `-Command` and `/c`, as the commands they run; reading the
  daemon's token files through interpreter code needs approval.
- The voice clone requires a consent recording checked against the speaker; calls can only be armed by a click,
  always start with an AI disclosure, and callers can trigger only allowlisted actions.

### Fixed

- Windows: LF checkouts through `.gitattributes`, clipboard access without an owner window (other apps' copies
  no longer stall), clipboard restore after a multi-line paste, readable PowerShell CLIXML errors, terminal
  detection through the focused window's process.
- macOS: screen-capture permission detection through functions bound by name, layout-aware shortcuts,
  symlinked home folders in the permission classifier.
- Linux: X11 window stacking and frame geometry, ydotool 0.1.x support, platform-correct tests.
- Tests: retries for temporary-folder removal on Windows, platform-correct Unicode and path tests, robust
  headless Chromium start.

[Unreleased]: https://github.com/patel-deepanshu/claude-anywhere/commits/main
