#!/usr/bin/env bash
# Installs DeepRead on macOS, Linux or Windows (inside WSL):
#
#   curl -fsSL https://raw.githubusercontent.com/mrx-arafat/DeepRead/main/scripts/install.sh | bash
#
# It checks for git and Node.js, downloads DeepRead to ~/DeepRead (or updates it), installs its packages, builds it,
# and adds the `deepread` command. Run it again any time to update. Set DEEPREAD_DIR to install somewhere else.
set -euo pipefail

REPO="${DEEPREAD_REPO:-https://github.com/mrx-arafat/DeepRead.git}"
DIR="${DEEPREAD_DIR:-$HOME/DeepRead}"
NODE_MIN=24

if [ -t 1 ]; then BOLD=$'\033[1m'; BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else BOLD=""; BLUE=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi
say() { printf '%s›%s %s\n' "$BLUE" "$RESET" "$1"; }
good() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail() { printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# The script usually arrives through a pipe, so questions are read from the terminal itself. With no terminal
# (an unattended run) every answer is no: nothing is installed or started that was not asked for.
ask() {
  local answer=""
  { : > /dev/tty; } 2> /dev/null || return 1
  printf '%s?%s %s ' "$YELLOW" "$RESET" "$1" > /dev/tty
  read -r answer < /dev/tty || return 1
  case "${answer:-$2}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

printf '\n%sDeepRead installer%s\n\n' "$BOLD" "$RESET"

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux ;;
  *) fail "This installer runs on macOS and Linux. On Windows, install WSL (https://learn.microsoft.com/windows/wsl/install), open Ubuntu, and run it there." ;;
esac

# 1. git
if ! command -v git > /dev/null 2>&1; then
  if [ "$OS" = mac ]; then fail "git is missing. Run: xcode-select --install   then run this installer again."
  else fail "git is missing. Install it (on Ubuntu or Debian: sudo apt install git), then run this installer again."; fi
fi
good "git $(git --version | awk '{print $3}')"

# 2. Node.js
node_major() { command -v node > /dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2> /dev/null || echo 0; }
if [ "$(node_major)" -lt "$NODE_MIN" ]; then
  if [ "$OS" = mac ] && command -v brew > /dev/null 2>&1 && ask "DeepRead needs Node.js $NODE_MIN or newer. Install it with Homebrew now? [Y/n]" Y; then
    if brew list node > /dev/null 2>&1; then brew upgrade node; else brew install node; fi
    hash -r
  fi
  if [ "$(node_major)" -lt "$NODE_MIN" ]; then
    fail "DeepRead needs Node.js $NODE_MIN or newer. Install the LTS version from https://nodejs.org/en/download, open a new terminal, and run this installer again."
  fi
fi
good "Node.js $(node --version)"

# 3. An AI helper, for explanations. Optional: reading and listening work without one.
# Plain strings, not arrays: macOS runs this with bash 3.2.
helpers=""
if command -v claude > /dev/null 2>&1; then helpers="Claude Code"; fi
if command -v codex > /dev/null 2>&1; then helpers="${helpers:+$helpers and }Codex"; fi
if [ -n "$helpers" ]; then
  good "AI helper: $helpers"
else
  warn "No AI helper found. DeepRead explains words and passages with Claude Code (Claude Pro or Max) or Codex (ChatGPT Plus or Pro)."
  if ask "Install Claude Code now? [y/N]" N; then
    curl -fsSL https://claude.ai/install.sh | bash || warn "Claude Code did not install. See https://code.claude.com/docs/en/setup"
    export PATH="$HOME/.local/bin:$PATH"
    warn "Sign in once: open a new terminal, run  claude  and follow the steps."
  elif ask "Install Codex instead? [y/N]" N; then
    npm install -g @openai/codex || warn "Codex did not install. See https://github.com/openai/codex"
    warn "Sign in once: open a new terminal, run  codex  and choose Sign in with ChatGPT."
  else
    say "Skipped. You can add one later; see https://github.com/mrx-arafat/DeepRead#ai-helpers"
  fi
fi

# 4. DeepRead itself
if [ -d "$DIR/.git" ]; then
  say "Updating DeepRead in $DIR..."
  git -C "$DIR" pull --ff-only --quiet || fail "Could not update $DIR. If you changed its files yourself, undo those changes and try again."
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2> /dev/null)" ]; then
  fail "$DIR already exists and is not DeepRead. Move it away, or choose another folder: DEEPREAD_DIR=~/somewhere/DeepRead"
else
  say "Downloading DeepRead to $DIR..."
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi
good "DeepRead is in $DIR"

# 5. Packages, the reader, and the `deepread` command
node "$DIR/scripts/deepread.mjs" setup

if ask "Start DeepRead now? [Y/n]" Y; then
  exec node "$DIR/scripts/deepread.mjs"
fi
