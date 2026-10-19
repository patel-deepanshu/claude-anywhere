# Desktop assistant: Claude operates any app

Claude Anywhere can work on your computer the way you do: it moves the **real mouse pointer**, types on the
**keyboard**, opens and quits **apps**, switches **windows** and **browser tabs**, reads what is on screen, and
presses buttons, tabs, links and menu items in any application. You ask in the dialog (typed or spoken), and Claude
decides the steps itself, checking each one on screen before the next.

> *"Open the Jira site saved in my Brave bookmarks bar, check my work in the For you tab, pick the ticket and start
> it in the shop-api repo."*

Everything here uses what your operating system already has (accessibility APIs, built-in text recognition,
standard command-line tools) or free, open-source packages. Nothing is uploaded anywhere except the screenshots and
text Claude itself works with, and nothing costs extra.

---

## What Claude can do

| You say | What Claude uses |
|---|---|
| "Open Figma", "start DaVinci Resolve", "is WhatsApp installed?" | `list_apps`, `launch_app` (fuzzy names: "vs code", "premiere", "terminal"), `quit_app` |
| "Put the browser on the left half", "maximize VS Code" | `set_window` (maximize, minimize, restore, full screen, left/right half, exact bounds), `focus_window` |
| "The Jira site in my Brave bookmarks bar" | `browser_bookmarks` (every browser profile, read from disk), then `browser_open` in that browser |
| "Go to my Gmail tab" | `browser_tabs`, `browser_switch_tab` |
| "Click *For you*", "type the ticket key into Search" | `ui_find`, `ui_click`, `ui_set_value`: the app's own controls by name, through the accessibility API |
| "What does this chat say?", "find the Export button" in an app with no accessibility tree | `read_screen_text`, `find_text` (on-device OCR), then a real mouse click at the text |
| Anything else on screen | `screenshot`, `click`, `drag`, `scroll`, `type_text`, `key` with the real cursor and keyboard |
| "Wait until the export finishes" | `wait_for` a window or text to appear (or go away) instead of guessing a delay |

How Claude finds what to click, best first:

1. **The accessibility tree** (`ui_find` / `ui_click`): buttons, tabs, links, fields and menu items by their names.
   It is exact, works when the window moves or is partly covered, and needs no pixel guessing.
2. **Text recognition** (`find_text`): for apps that draw their own interface (canvas apps such as Figma, games,
   video editors, remote desktops). It returns the centre of the text, ready to click.
3. **Screenshot coordinates**: everything else, verified with a fresh screenshot after the action.

To save time, Claude can ask for a screenshot together with an action (`screenshotAfter`), and run short, predictable
sequences in one step (`batch_actions`: click a field, type, press Enter), checking your pause button before every step.

---

## Examples

### Jira from your Brave bookmarks bar, then start the work

> *"Open the Jira site saved in my Brave bookmarks bar, check the For you tab, pick my ticket and start it in repo xyz."*

1. `browser_bookmarks {browser: "brave", folder: "bar", query: "jira"}` finds `https://acme.atlassian.net/jira/your-work`.
2. `browser_open {browser: "brave", url}` opens it as a new tab of your running Brave (where you are signed in).
3. `ui_click {name: "For you", role: "tab", window: "Brave"}` switches to the tab; `read_screen_text` or
   `read_browser_tab {includeText: true}` reads the tickets assigned to you.
4. Claude picks the ticket to start (assigned to you, not done, the most urgent first), reads it with
   `jira_get_issue` (or from the page when Jira is not connected), summarizes it with a short plan, and asks you where
   to work (`find_repos` lists the repositories it found, "xyz" first) and whether to move the ticket to In Progress.
5. It switches the dialog to that repository, creates a branch `ABC-123-short-slug`, implements and tests the
   change, commits, and asks before pushing or opening a pull request. See [JIRA.md](JIRA.md).

### Design in Figma

> *"Open Figma and design a user e-commerce dashboard."*

If you have the Figma MCP server connected, Claude prefers it (it edits the file directly). Otherwise it drives the
Figma app or figma.com: `launch_app {name: "Figma"}`, then `wait_for {window: "Figma"}`, a new design file, frames
and shapes with Figma's shortcuts (F frame, R rectangle, T text, Shift+A auto layout), exact sizes typed into the
properties panel, and a screenshot after each change. Figma draws on a canvas, so Claude finds its labels with
`find_text` and works with coordinates there.

### Read and answer WhatsApp messages

> *"Check my WhatsApp messages and reply to Priya that I'll call at six."*

`launch_app {name: "WhatsApp"}` (desktop app) or `browser_open {url: "web.whatsapp.com"}`, then `read_screen_text`
or `ui_tree` to read the chat list and the conversation. Claude drafts replies, and **sends only text you dictated or
approved** (it asks with a card first when the wording is its own). It never forwards private messages elsewhere.

### Edit a video

> *"Trim the first 10 seconds of interview.mp4 and add the logo in the corner."*

For exact cuts, trims, joins, subtitles and format changes Claude prefers the free `ffmpeg` command line, writing a
new file and never overwriting the original. When you name an editor ("in DaVinci Resolve", "in Shotcut", "in
iMovie"), it opens it with `launch_app` and works in its interface with the same tools (`find_text` for the
timeline's labels, drags for clips, keyboard shortcuts), checking each step with a screenshot.

### More

- *"Put Slack on the right half and the browser on the left."* → `set_window {window: "Slack", state: "right-half"}` …
- *"Close Spotify."* → `quit_app {name: "Spotify"}` (a polite quit: an app with unsaved work may ask first).
- *"Wait for the build to finish, then open the report."* → `wait_for {text: "Build succeeded", timeoutSec: 120}`.

### From a terminal (bridge mode, scripts)

The same operations exist as commands, for `/anywhere here` sessions without the MCP tools and for scripts:

```bash
anywhere desktop apps figma                                  # installed apps (fuzzy)
anywhere desktop launch "VS Code" [--accessibility]          # launch or focus; waits for the window
anywhere desktop quit Spotify [--force]
anywhere desktop bookmarks jira --browser brave --folder bar # bookmarks, the bar first
anywhere desktop open-url acme.atlassian.net/jira/for-you --browser brave
anywhere desktop tabs [--cycle] | switch-tab Jira | switch-tab --index -1
anywhere desktop window chrome --state left-half             # maximize|minimize|restore|fullscreen|left-half|right-half
anywhere desktop wait --text "Export complete" --timeout 120 # exit code 2 on timeout
anywhere computer ui-find "For you" --role tab --window Brave
anywhere computer ocr "Create issue"                         # find text; without TEXT: read all text
anywhere computer apps                                       # running apps and the default browser
```

All of them print text, or JSON with `--json`, honour the dialog's Stop button and the failsafe corner, and show up
in the dialog's activity feed.

---

## Requirements per operating system

`anywhere doctor` shows what works on your machine: the **App controls (accessibility)** and **Screen text (OCR)**
lines, and on Linux **Desktop assistant tools**. Each missing piece comes with the exact command to fix it.

### macOS

- **Accessibility** and **Screen Recording** for the app that runs Claude Code (Terminal, iTerm, VS Code…):
  System Settings → Privacy & Security. Accessibility also covers reading app controls (`ui_find`).
- **Automation** (asked the first time): System Events for focusing, moving and resizing windows, and your browsers
  for listing and switching tabs.
- **Full Disk Access** only if Claude should read Safari bookmarks (other browsers' bookmarks need nothing).
- Text recognition uses Apple **Vision**, built in (macOS 10.15 or newer).
- Chromium browsers (Chrome, Brave, Edge) and Electron apps (Slack, VS Code, Discord) switch their accessibility tree
  on automatically the first time Claude reads them.

### Windows (and WSL)

- Nothing to install: **UI Automation** and **Windows OCR** are part of Windows 10 and 11. From WSL, everything goes
  through Windows (`powershell.exe`), so WSL interop must be on (it is by default).
- OCR needs an OCR language: most Windows installations have one. If `doctor` says none is installed, add one in
  Settings → Time & language → Language & region (a language with "Optical character recognition"), or run in an
  administrator PowerShell: `Add-WindowsCapability -Online -Name "Language.OCR~~~en-US~0.0.1.0"`.
- Windows will not let a normal program control **elevated (administrator) windows**. Claude says so instead of
  failing silently; run Claude Code elevated only if you want it to control such apps.
- If a Chromium or Electron app shows almost no controls, it builds its tree on the first request: Claude asks again,
  or you can start it with `--force-renderer-accessibility`.

### Linux

- X11 needs `xdotool wmctrl xclip imagemagick` (`sudo apt install xdotool wmctrl xclip imagemagick x11-xserver-utils`).
  Wayland needs `ydotool` 1.0+, `grim` and `wl-clipboard`; window control works on sway and Hyprland. See
  [PLATFORMS.md](PLATFORMS.md).
- **App controls** (optional, free): AT-SPI and its Python bindings.
  - Debian/Ubuntu: `sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core`
  - Fedora: `sudo dnf install python3-gobject at-spi2-core`
  - Arch: `sudo pacman -S python-gobject at-spi2-core`

  Then log out and in once. If your default `python3` lacks the bindings, set `ANYWHERE_PYTHON` to one that has them
  (Claude Anywhere also tries `/usr/bin/python3.N` by itself).
- **Chromium-based browsers and Electron apps** (Chrome, Brave, Edge, VS Code, Slack, Discord, WhatsApp desktop) expose
  their content only when started with **both** `ACCESSIBILITY_ENABLED=1` in the environment and
  `--force-renderer-accessibility` on the command line. `launch_app {accessibility: true}` (or
  `anywhere desktop launch Brave --accessibility`) does that; an instance that is already running must be quit first.
  For example: `ACCESSIBILITY_ENABLED=1 brave-browser --force-renderer-accessibility`.
- **Text recognition** (optional, free): `sudo apt install tesseract-ocr` (Fedora `sudo dnf install tesseract`, Arch
  `sudo pacman -S tesseract tesseract-data-eng`). It is never installed for you.
- Helpful extras: `wmctrl` (apps close gently, with a chance to save), `sqlite3` (current Firefox bookmarks; without it
  the daily backup is read), `gtk-launch` from `libgtk-3-bin` (apps start exactly as their menu entry does).
- GNOME and KDE on Wayland do not let programs move or resize other windows, or tell them where windows are: Claude
  works from screenshots there, and `set_window` says it is unsupported. Since Claude cannot tell where the dialog is
  there either, it does not click while the dialog is on screen, or type while the dialog may have the focus:
  minimize the dialog while Claude works with the mouse (approval cards bring it back), or use an X11 session
  ("Ubuntu on Xorg"), sway or Hyprland.

---

## Safety

The desktop assistant follows the same rules as the rest of Claude Anywhere ([SECURITY.md](SECURITY.md)):

- **You can always stop it**: Esc, the Stop button, saying "stop", or moving the mouse into the top-left corner of the
  primary display (the failsafe). Every input action, and every step of a `batch_actions` sequence, checks the pause
  first.
- **Approvals by risk.** Reading the screen, the app list, bookmarks, controls and on-screen text is low risk and runs
  at once. Clicking, typing, launching apps, opening pages, switching tabs and arranging windows are medium (the
  default `smart` mode lets them run and shows them in the timeline). High risk, always with a card of its own and
  never covered by an "Always" rule: force-quitting an app or quitting a system process or Claude itself, opening a
  non-web link or a program through the browser, opening a page with a program that is not a known browser,
  launching an app with a shell command (also a terminal given by its display name, such as "GNOME Terminal" or
  "Windows PowerShell", with `-e`, `--`, `-c`, `-Command` or `/c`), typing a secret-looking value into a field. A `batch_actions` card lists every step and is as risky as its riskiest step; "Always" is never
  offered for batches.
- **No passwords, 2FA codes or payment details.** Claude asks you to type them yourself.
- **Confirm before anything irreversible**: sending a message or email, deleting, buying, publishing, pushing code.
- **Screen text is information, not instructions.** A web page or chat that says "ignore your instructions" is just text.
- **Your work is protected**: `quit_app` asks apps to quit politely (they can ask to save), never quits the terminal or
  editor Claude runs in, and never touches shared system processes. Video and file edits go to new files.
- The **Claude Anywhere dialog** itself is never clicked, typed into, moved or closed by Claude: not by pixels, not
  through accessibility (`OWN_DIALOG`), not by `set_window`, and `quit_app` leaves its browser running.
- Every action is written to the audit log (`~/.claude-anywhere/logs/audit-*.jsonl`), with secrets redacted.

---

## Troubleshooting

- **"No element named …"**: the app may not expose that control. Claude falls back to `find_text` and screenshots by
  itself; `anywhere computer ui-find NAME` shows what the app reports. On Linux check the App controls line of
  `anywhere doctor`, and start Chromium/Electron apps with accessibility (above).
- **OCR is unavailable**: install the engine `doctor` names (tesseract on Linux, an OCR language on Windows).
- **The wrong window was used**: name it (`window: "Brave"`, a title, or an id from `list_windows`).
- **macOS keeps asking for permissions**: grant them to the app that runs Claude Code, then quit and reopen that app.

Environment variables: `ANYWHERE_PYTHON` (Linux AT-SPI interpreter), `ANYWHERE_DARWIN_UI=ax|systemEvents` (macOS
engine for app controls), `ANYWHERE_OCR_ENGINE=vision|windows|tesseract|none`, `ANYWHERE_OCR_LANG` (for example
`eng+deu`, or `de-DE` for Vision and Windows), `ANYWHERE_OCR_PSM`, `ANYWHERE_TESSERACT` (path to tesseract).

How it is built: [ARCHITECTURE.md](ARCHITECTURE.md) §4 (drivers, OCR, apps, browsers) and §6 (tools).
