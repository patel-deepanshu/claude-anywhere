#!/usr/bin/env bash
# Claude Anywhere bootstrap installer for macOS, Linux and WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/patel-deepanshu/claude-anywhere/main/scripts/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --hotkey --electron      # pass options to `anywhere install`
#
# Clones (or updates) the repository into ${ANYWHERE_HOME:-~/.claude-anywhere}/app, runs
# `node app/bin/anywhere.js install "$@"`, and links the `anywhere` command into ~/.local/bin.
#
# Environment: ANYWHERE_HOME, ANYWHERE_REPO, ANYWHERE_BRANCH, ANYWHERE_BIN_DIR, ANYWHERE_NO_LINK=1.

set -eu
# pipefail is not in every POSIX sh; enable it where available.
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

REPO_URL="${ANYWHERE_REPO:-https://github.com/patel-deepanshu/claude-anywhere}"
BRANCH="${ANYWHERE_BRANCH:-main}"
STATE_DIR="${ANYWHERE_HOME:-$HOME/.claude-anywhere}"
APP_DIR="$STATE_DIR/app"
BIN_DIR="${ANYWHERE_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE_MAJOR=18
MIN_NODE_MINOR=17

say() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Print how to install a package on this OS.
install_hint() {
  what="$1"
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)
      if [ "$what" = node ]; then say "  brew install node        (or the LTS installer from https://nodejs.org)"
      else say "  xcode-select --install   (or: brew install git)"; fi ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        if [ "$what" = node ]; then say "  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs"
        else say "  sudo apt-get install -y git"; fi
      elif command -v dnf >/dev/null 2>&1; then say "  sudo dnf install -y $( [ "$what" = node ] && echo nodejs || echo git )"
      elif command -v pacman >/dev/null 2>&1; then say "  sudo pacman -S --needed $( [ "$what" = node ] && echo nodejs npm || echo git )"
      elif command -v zypper >/dev/null 2>&1; then say "  sudo zypper install -y $( [ "$what" = node ] && echo nodejs20 || echo git )"
      elif command -v apk >/dev/null 2>&1; then say "  sudo apk add $( [ "$what" = node ] && echo nodejs npm || echo git )"
      else say "  Install $what with your package manager."; fi
      if [ "$what" = node ]; then
        say "  or with nvm: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install --lts"
      fi ;;
    *) say "  Install $what, then run this script again." ;;
  esac
}

check_requirements() {
  if ! command -v git >/dev/null 2>&1; then
    say "git is required but was not found. Install it:" >&2
    install_hint git >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    say "Node.js $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer is required but 'node' was not found. Install it:" >&2
    install_hint node >&2
    exit 1
  fi
  if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>$MIN_NODE_MAJOR||(a===$MIN_NODE_MAJOR&&b>=$MIN_NODE_MINOR)?0:1)"; then
    say "Node.js $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer is required (found $(node --version)). Upgrade it:" >&2
    install_hint node >&2
    exit 1
  fi
}

fetch_app() {
  mkdir -p "$STATE_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    step "Updating $APP_DIR"
    git -C "$APP_DIR" pull --ff-only --quiet || fail "could not update $APP_DIR (local changes?). Fix it or remove the folder, then retry."
  elif [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    fail "$APP_DIR exists but is not a git checkout. Move it away and run this script again."
  else
    step "Downloading Claude Anywhere into $APP_DIR"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR" || fail "git clone of $REPO_URL failed."
  fi
  chmod +x "$APP_DIR/bin/anywhere" "$APP_DIR/bin/anywhere.js" 2>/dev/null || true
}

link_cli() {
  if [ "${ANYWHERE_NO_LINK:-}" = 1 ]; then return 0; fi
  mkdir -p "$BIN_DIR" || { say "Could not create $BIN_DIR; skipping the 'anywhere' command link."; return 0; }
  ln -sf "$APP_DIR/bin/anywhere" "$BIN_DIR/anywhere" || { say "Could not link $BIN_DIR/anywhere."; return 0; }
  case ":$PATH:" in
    *":$BIN_DIR:"*) say "Linked the 'anywhere' command: $BIN_DIR/anywhere" ;;
    *)
      say "Linked $BIN_DIR/anywhere. Add it to your PATH to use 'anywhere' in a terminal:"
      say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile   (zsh: ~/.zshrc)" ;;
  esac
}

main() {
  check_requirements
  fetch_app
  step "Installing the /anywhere skill and MCP tools"
  node "$APP_DIR/bin/anywhere.js" install "$@"
  link_cli
  say ""
  say "Done. Restart Claude Code, then type /anywhere in any project."
}

# Everything runs from main so a partially downloaded script never executes.
main "$@"
