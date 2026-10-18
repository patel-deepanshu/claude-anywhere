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

`anywhere install` asks macOS to show these permission prompts. Skip that with `--no-permissions`.

Shortcuts that open the right pane:
`open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"` and
`open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"`.

Notes:
- Typing uses the active keyboard layout. With a non-Latin layout, set `ANYWHERE_DARWIN_TYPING=paste`.
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
| Mouse and keyboard | `ydotool` (needs the `ydotoold` service and access to `/dev/uinput`), or `wtype` (keyboard only) |
| Windows | sway (`swaymsg`), Hyprland (`hyprctl`). GNOME and KDE: no window listing or focus |
| Clipboard | `wl-clipboard` |

Tips:
- Pointer acceleration can make `ydotool` clicks land off target. Use a flat acceleration profile.
- If a task only involves X11 apps, logging into an "Xorg" session gives full support.

## Headless or SSH

With no display, the dialog can't open a window, so run `anywhere tui` for the terminal dialog. Screen
control isn't available, but Claude Code's normal tools are.
