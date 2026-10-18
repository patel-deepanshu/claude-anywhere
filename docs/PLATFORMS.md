# Platform setup

`anywhere doctor` checks everything on this page for the machine you run it on and prints the exact
fix for each problem. Run it first.

## macOS (13+; Apple Silicon and Intel)

| Feature | Mechanism |
|---|---|
| Screenshots | `screencapture -x -D <display>` |
| Mouse and keyboard | A JXA helper (`osascript -l JavaScript`) posting CoreGraphics events; System Events for typing |
| Windows | `CGWindowListCopyWindowInfo`, plus `NSRunningApplication` and AXRaise for focus |
| Clipboard | `pbcopy` / `pbpaste` |
| Dialog | Chrome, Edge, Brave, Chromium or Vivaldi `--app` window, or Electron |
| Speech | `say` |

**Permissions.** Grant these to *the app that launches Claude Code*: Terminal, iTerm2, VS Code, Cursor,
or Electron if you use it.
1. **System Settings → Privacy & Security → Accessibility**, needed for clicks and typing.
2. **System Settings → Privacy & Security → Screen Recording**, needed for screenshots and window titles.
3. Quit and reopen that app.

Run in an interactive terminal, `anywhere install` asks macOS to show these permission prompts (skip
that with `--no-permissions`); so does the one-liner (`curl … | bash`), which hands the installer your
terminal.
`/anywhere setup` (Claude's Bash tool has no terminal) and the plugin install can't show them and print the
shortcuts below instead. After those, grant both permissions with the shortcuts, or run `anywhere install`
once in Terminal, then run `anywhere doctor` to confirm.

Shortcuts that open the right pane:
`open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"` and
`open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"`.

Notes:
- Typing uses System Events keystrokes on plain ASCII layouts. Under an input method or a non-Latin layout,
  text is pasted automatically. On layouts with dead keys (U.S. International, German, French...), text
  containing quotes, backticks, carets or tildes is pasted. Shortcuts press the key that types the character
  on the active layout, using the Command keymap for Cmd shortcuts, so Dvorak - QWERTY ⌘ and non-Latin
  layouts keep QWERTY positions. `ANYWHERE_DARWIN_TYPING=paste` forces pasting.
- macOS can't set a global hotkey from a script. `anywhere install --hotkey` creates
  `~/Applications/Claude Anywhere.app`; bind it in **Shortcuts → Run App**. Alternatively, use
  `anywhere install --electron` and press Cmd+Shift+Space.

## Windows 10 / 11

| Feature | Mechanism |
|---|---|
| Everything on screen | One persistent Windows PowerShell 5.1 host (`src/os/win32-host.ps1`) with Win32 P/Invoke: `SendInput`, `EnumWindows`, `SetForegroundWindow`, per-monitor DPI awareness, and `Graphics.CopyFromScreen` |
| Dialog | Microsoft Edge `--app` window (Edge ships with Windows), or Electron |
| Speech | System.Speech (SAPI) |

There's nothing to install. Notes:
- Windows UIPI blocks input into **elevated (administrator) windows** unless Claude Code itself runs elevated.
- The secure desktop (UAC prompts, the lock screen) can't be captured or controlled. Claude will ask you to handle those.
- `anywhere install --hotkey` adds a Start Menu shortcut, **Claude Anywhere**, with the hotkey **Ctrl+Alt+F12**. It isn't Ctrl+Alt+letter because Windows reports AltGr as Ctrl+Alt, which would break typing on European layouts.

## WSL 2

The daemon and Claude Code run inside Linux, while the desktop they control is Windows:
- Screen, input and windows go through `powershell.exe` and the same Windows host. The script is copied to `%TEMP%`.
- The dialog opens in Windows Edge or Chrome. WSL forwards `localhost` to Windows by default.
- Linux GUI apps (WSLg) can be launched with `open`.

If `powershell.exe` isn't on your PATH, enable WSL interop (`/etc/wsl.conf` → `[interop] enabled=true`).

## Linux, X11

Install the helpers:

| Distro | Command |
|---|---|
| Debian, Ubuntu | `sudo apt install xdotool wmctrl xclip imagemagick x11-xserver-utils` |
| Fedora | `sudo dnf install xdotool wmctrl xclip ImageMagick xrandr` |
| Arch | `sudo pacman -S xdotool wmctrl xclip imagemagick xorg-xrandr` |

Screenshots try `maim`, `import`, `ffmpeg -f x11grab`, `scrot`, `xwd`, and `gnome-screenshot`, in that order.
For voice output, install `speech-dispatcher` or `espeak-ng`.

## Linux, Wayland (best effort)

Wayland deliberately restricts global input and screen capture.

| Feature | Supported via |
|---|---|
| Screenshots | `grim` (wlroots: sway, Hyprland), `gnome-screenshot`, `spectacle` (KDE) |
| Mouse and keyboard | `ydotool` **1.0 or newer**, with the `ydotoold` service running and access to `/dev/uinput`. `wtype` can also type, on wlroots compositors (sway, Hyprland) only |
| Windows | sway (`swaymsg`), Hyprland (`hyprctl`). GNOME and KDE: no window listing or focus |
| Clipboard | `wl-clipboard` |
| Top-left-corner failsafe | Hyprland only (`hyprctl cursorpos`). GNOME, KDE, sway: unavailable, the pointer position cannot be read; stop with Esc, Stop or "stop" |

Tips:
- Debian 12 and Ubuntu up to 24.04 package ydotool 0.1.8, which is too old and is rejected. Remove the
  distro package, build 1.x from [github.com/ReimuNotMoe/ydotool](https://github.com/ReimuNotMoe/ydotool),
  and start `ydotoold`.
- `wtype` isn't used on GNOME, which lacks the virtual-keyboard protocol it needs. On GNOME, input
  works only through ydotool 1.x.
- Pointer acceleration can make `ydotool` clicks land off target. Use a flat acceleration profile.
- If a task only involves X11 apps, logging into an "Xorg" session gives full support.

## Headless or SSH

With no display, the dialog can't open a window. Run `anywhere tui` for the terminal dialog (where
`anywhere` is not on your PATH, `node <install dir>/bin/anywhere.js tui`; `/anywhere` and `/anywhere doctor`
print the exact command, and `anywhere install` links `~/.local/bin/anywhere` on macOS, Linux and WSL), or
open the web dialog on your own computer through an SSH tunnel. In an SSH session, `anywhere start` prints
the `ssh -L` line to use. The URL that `anywhere start` and
`anywhere url` print points at the remote machine's 127.0.0.1, so forward that port **with the same
port number on both ends**:

```bash
anywhere url                               # on the remote machine: http://127.0.0.1:<port>/?token=…
ssh -L <port>:127.0.0.1:<port> user@host   # on your computer; then open that URL locally
```

The daemon accepts only `127.0.0.1:<port>` or `localhost:<port>` for its own port as the Host, which
blocks DNS rebinding. A tunnel from a different local port, such as `-L 8080:127.0.0.1:47120`, gets
`Forbidden host`. If port 47120 was busy, the daemon picked another one, so take the port from
`anywhere url`, or pin it with `anywhere config set port <n>`.

Screen control isn't available without a display, but Claude Code's normal tools are.
