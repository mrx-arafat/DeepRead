#!/usr/bin/env bash
# Installs DeepRead on macOS, Linux or Windows (inside WSL):
#
#   curl -fsSL https://raw.githubusercontent.com/mrx-arafat/DeepRead/main/scripts/install.sh | bash
#
# It checks for git, finds Node.js 24 or newer (or downloads a private copy just for DeepRead, without sudo and
# without touching any other Node.js), offers an optional AI helper, downloads DeepRead to ~/DeepRead (or updates
# it), installs its packages, builds it, and adds the `deepread` command. Run it again any time to update.
#
# Settings: DEEPREAD_DIR (where DeepRead goes), DEEPREAD_REPO (where it is downloaded from), DEEPREAD_NODE_DIR
# (where the private Node.js goes, default ~/.local/share/deepread/node).
set -euo pipefail

REPO="${DEEPREAD_REPO:-https://github.com/mrx-arafat/DeepRead.git}"
DIR="${DEEPREAD_DIR:-$HOME/DeepRead}"
NODE_DIR="${DEEPREAD_NODE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/deepread/node}"
NODE_MIN=24
PORT="${DEEPREAD_PORT:-8787}"
INSTALL_LINE="curl -fsSL https://raw.githubusercontent.com/mrx-arafat/DeepRead/main/scripts/install.sh | bash"
# The PATH the reader's own terminal uses, kept before this script changes it, so messages can say what they will see.
USER_PATH="$PATH"

if [ -t 1 ]; then BOLD=$'\033[1m'; BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else BOLD=""; BLUE=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi
say() { printf '%s›%s %s\n' "$BLUE" "$RESET" "$1"; }
good() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }

# Every failure says what went wrong, then the one line to copy, then what happens next, so nobody is left stuck.
# Usage: fail "what went wrong" ["line to copy" ["what happens next" ["second line to copy"]]]
fail() {
  printf '\n%s✗%s %s\n' "$RED" "$RESET" "$1" >&2
  if [ -n "${2:-}" ]; then printf '  Copy this line, paste it here, and press Enter:\n\n      %s\n\n' "$2" >&2; fi
  if [ -n "${3:-}" ]; then printf '  %s\n' "$3" >&2; fi
  if [ -n "${4:-}" ]; then printf '\n      %s\n' "$4" >&2; fi
  printf '\n' >&2
  exit 1
}

# Shows a path with ~ for the home folder, which is shorter and is what people see in Finder or Files.
pretty() { case "$1" in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }

# The first `$1` command found in the PATH list `$2`. Looks at the folders directly, so shell functions and aliases
# with the same name do not count.
find_in_path() {
  local dir old_ifs="$IFS"
  IFS=:
  for dir in $2; do
    if [ -n "$dir" ] && [ -f "$dir/$1" ] && [ -x "$dir/$1" ]; then IFS="$old_ifs"; printf '%s' "$dir/$1"; return 0; fi
  done
  IFS="$old_ifs"
  return 1
}

# Runs a command but gives up after 10 seconds, so a helper that waits for something cannot stall the installer.
# macOS has no `timeout` command, hence this small stand-in. Input is closed: the installer itself arrives on it.
quick() {
  local pid watcher status=0
  "$@" < /dev/null &
  pid=$!
  ( sleep 10; kill "$pid" ) > /dev/null 2>&1 &
  watcher=$!
  wait "$pid" 2> /dev/null || status=$?
  kill "$watcher" 2> /dev/null || true
  wait "$watcher" 2> /dev/null || true
  return "$status"
}

# The script usually arrives through a pipe, so questions are read from the terminal itself. With no terminal
# (an unattended run) every answer is no: nothing is installed or started that was not asked for.
ask() {
  local answer=""
  { : > /dev/tty; } 2> /dev/null || return 1
  printf '%s?%s %s ' "$YELLOW" "$RESET" "$1" > /dev/tty
  read -r answer < /dev/tty || return 1
  case "${answer:-$2}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# Prints the reader's pick from a numbered list, or `$2` when they just press Enter or there is no terminal.
choose() {
  local answer=""
  if { : > /dev/tty; } 2> /dev/null; then
    printf '%s?%s %s ' "$YELLOW" "$RESET" "$1" > /dev/tty
    read -r answer < /dev/tty || answer=""
  fi
  printf '%s' "${answer:-$2}"
}

# --- Node.js -------------------------------------------------------------------------------------------------------

# The Node.js version `$1` reports, like 24.21.0, or nothing if it does not run here (wrong processor, broken copy,
# a version manager shim with no version chosen).
node_version() { quick "$1" -p 'process.versions.node' 2> /dev/null || true; }

# A version like 24.21.0 as one number, so versions compare with plain arithmetic (bash 3.2 has no sort -V).
version_number() {
  local major minor patch
  IFS=. read -r major minor patch <<< "$1"
  printf '%d' "$(( ${major:-0} * 1000000 + ${minor:-0} * 1000 + ${patch:-0} ))"
}

# Every place a Node.js is commonly installed, even when the reader's terminal does not see it: their PATH first,
# then Homebrew, nvm, fnm, volta, asdf, mise, and DeepRead's own private copy. One path per line.
node_candidates() {
  local dir prefix old_ifs="$IFS"
  IFS=:
  for dir in $USER_PATH; do [ -n "$dir" ] && printf '%s\n' "$dir/node"; done
  IFS="$old_ifs"
  for prefix in "$(brew --prefix 2> /dev/null || true)" /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
    [ -n "$prefix" ] || continue
    printf '%s\n' "$prefix/opt/node/bin/node" "$prefix/bin/node" "$prefix/opt/node@"*/bin/node
  done
  printf '%s\n' \
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME/Library/Application Support/fnm/node-versions/"*/installation/bin/node \
    "$HOME"/.volta/tools/image/node/*/bin/node \
    "$HOME"/.asdf/installs/nodejs/*/bin/node \
    "$HOME"/.local/share/mise/installs/node/*/bin/node \
    "$NODE_DIR/bin/node"
}

# Sets NODE and NODE_VERSION to the newest usable Node.js 24 or newer, or returns 1 if there is none.
# Usable means it runs here and has npm and npx next to it, which DeepRead's setup needs.
find_node() {
  local candidate version number best=0 seen=$'\n'
  NODE=""; NODE_VERSION=""
  while IFS= read -r candidate; do
    case "$seen" in *$'\n'"$candidate"$'\n'*) continue ;; esac
    seen="$seen$candidate"$'\n'
    [ -f "$candidate" ] && [ -x "$candidate" ] || continue
    [ -x "$(dirname "$candidate")/npm" ] && [ -x "$(dirname "$candidate")/npx" ] || continue
    version="$(node_version "$candidate")"
    case "$version" in [0-9]*.[0-9]*) ;; *) continue ;; esac
    [ "${version%%.*}" -ge "$NODE_MIN" ] || continue
    number="$(version_number "$version")"
    # Strictly newer only: on a tie the earlier place wins, and the reader's own PATH comes first.
    if [ "$number" -gt "$best" ]; then best="$number"; NODE="$candidate"; NODE_VERSION="$version"; fi
  done <<< "$(node_candidates)"
  [ -n "$NODE" ]
}

# Downloads the latest Node.js $NODE_MIN from nodejs.org into $NODE_DIR, checks its fingerprint, and replaces any
# older copy there in one step. This changes nothing else on the computer: no sudo, no Homebrew, no PATH edits.
download_node() {
  local os arch base list line file version sum actual unpacked
  case "$(uname -s)" in Darwin) os=darwin ;; *) os=linux ;; esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) arch="" ;;
  esac
  # A Terminal running under Rosetta reports an Intel processor on an Apple Silicon Mac; the native build is faster.
  if [ "$os" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2> /dev/null || true)" = 1 ]; then arch=arm64; fi
  if [ -z "$arch" ]; then
    fail "DeepRead can get Node.js by itself only on Intel or Apple Silicon Macs and on 64-bit Linux, and this computer's processor is $(uname -m). Install Node.js $NODE_MIN or newer from https://nodejs.org/en/download first. Then:" \
      "$INSTALL_LINE" "The installer finds that Node.js and carries on."
  fi

  base="https://nodejs.org/dist/latest-v$NODE_MIN.x"
  list="$(curl -fsSL "$base/SHASUMS256.txt" 2> /dev/null)" ||
    fail "Could not reach nodejs.org to get Node.js. Check that this computer is online. Then:" "$INSTALL_LINE" "The installer tries again."
  # .tar.gz first: every system can unpack it, while .tar.xz needs the xz tool, which many lack.
  line="$(printf '%s\n' "$list" | grep -E "  node-v[0-9.]+-$os-$arch\.tar\.gz\$" | head -n 1 || true)"
  if [ -z "$line" ] && command -v xz > /dev/null 2>&1; then
    line="$(printf '%s\n' "$list" | grep -E "  node-v[0-9.]+-$os-$arch\.tar\.xz\$" | head -n 1 || true)"
  fi
  [ -n "$line" ] || fail "nodejs.org has no Node.js $NODE_MIN download for this computer ($os, $arch). Install Node.js $NODE_MIN or newer from https://nodejs.org/en/download first. Then:" \
    "$INSTALL_LINE" "The installer finds that Node.js and carries on."
  sum="${line%% *}"
  file="${line##* }"
  version="${file#node-v}"; version="${version%%-*}"

  say "Getting Node.js $version, the engine DeepRead runs on (about 55 MB, kept just for DeepRead in $(pretty "$NODE_DIR"); nothing else on this computer changes)..."
  mkdir -p "$(dirname "$NODE_DIR")"
  # Unpacked next to its final place, so the last step is a quick rename on the same disk.
  WORK="$(mktemp -d "$(dirname "$NODE_DIR")/.node-download.XXXXXX")"
  # A stable folder from the exact version, so the file cannot change between reading the list and downloading.
  local progress=-sS
  if [ -t 2 ]; then progress=--progress-bar; fi
  curl -fL "$progress" -o "$WORK/$file" "https://nodejs.org/dist/v$version/$file" ||
    fail "The Node.js download stopped. Check that this computer is online. Then:" "$INSTALL_LINE" "The installer starts the download again."

  if command -v shasum > /dev/null 2>&1; then actual="$(shasum -a 256 "$WORK/$file" | awk '{print $1}')"
  elif command -v sha256sum > /dev/null 2>&1; then actual="$(sha256sum "$WORK/$file" | awk '{print $1}')"
  else
    fail "This computer has no tool to check the Node.js download (shasum or sha256sum). Install Node.js $NODE_MIN or newer from https://nodejs.org/en/download first. Then:" \
      "$INSTALL_LINE" "The installer finds that Node.js and carries on."
  fi
  [ "$actual" = "$sum" ] ||
    fail "The Node.js download arrived damaged (its fingerprint does not match the one nodejs.org publishes), so DeepRead did not use it." \
      "$INSTALL_LINE" "The installer downloads a fresh copy."

  case "$file" in *.tar.gz) tar -xzf "$WORK/$file" -C "$WORK" ;; *) tar -xJf "$WORK/$file" -C "$WORK" ;; esac ||
    fail "Could not unpack Node.js into $(pretty "$NODE_DIR"). Make sure the disk has at least 200 MB free. Then:" "$INSTALL_LINE" "The installer tries again."
  unpacked="$WORK/${file%.tar.*}"
  if [ -z "$(node_version "$unpacked/bin/node")" ]; then
    fail "The Node.js that DeepRead downloaded does not run on this system (official builds need glibc 2.28 or newer, which Alpine and very old Linux versions lack). Install Node.js $NODE_MIN or newer with your system's package manager (https://nodejs.org/en/download/package-manager) first. Then:" \
      "$INSTALL_LINE" "The installer finds that Node.js and carries on."
  fi
  if [ -e "$NODE_DIR" ]; then mv "$NODE_DIR" "$WORK/old"; fi
  mv "$unpacked" "$NODE_DIR"
  rm -rf "$WORK"
  WORK=""
}

# --- AI helpers ----------------------------------------------------------------------------------------------------

# The first of `$@` that is a working program, verified by asking its version. Prints its path.
first_working() {
  local candidate
  for candidate in "$@"; do
    [ -n "$candidate" ] && [ -f "$candidate" ] && [ -x "$candidate" ] || continue
    if quick "$candidate" --version > /dev/null 2>&1; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

find_claude() {
  first_working "$(find_in_path claude "$PATH" || true)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" \
    "$(dirname "$NODE")/claude" /opt/homebrew/bin/claude /usr/local/bin/claude
}

find_codex() {
  first_working "$(find_in_path codex "$PATH" || true)" "$HOME/.local/bin/codex" "$(dirname "$NODE")/codex" \
    "${NPM_BIN:-}" /opt/homebrew/bin/codex /usr/local/bin/codex
}

# What the reader types to run `$1` (found at `$2`): its plain name if their terminal finds that same program,
# else its full path, which works right away.
how_to_run() {
  if [ "$(find_in_path "$1" "$USER_PATH" || true)" = "$2" ]; then printf '%s' "$1"; else pretty "$2"; fi
}

# Codex installed next to a Node.js the reader's terminal does not see would be unreachable for them, and its
# launcher needs that Node.js. A small `codex` command in ~/.local/bin (where `deepread` also goes) fixes both.
link_codex() {
  local target="$1" bin="$HOME/.local/bin"
  [ "$(find_in_path codex "$USER_PATH" || true)" = "$target" ] && return 0
  [ -e "$bin/codex" ] && return 0
  mkdir -p "$bin"
  printf '#!/bin/sh\n# Codex for DeepRead, written by its installer: runs Codex with the Node.js it was installed with.\nPATH="%s:$PATH"; export PATH\nexec "%s" "$@"\n' \
    "$(dirname "$NODE")" "$target" > "$bin/codex"
  chmod 755 "$bin/codex"
}

# --- The install ---------------------------------------------------------------------------------------------------

# Everything runs from here, called on the last line, so a download cut off halfway never runs half a script.
main() {
  printf '\n%sDeepRead installer%s\n' "$BOLD" "$RESET"
  printf 'This sets up DeepRead on this computer. It takes a few minutes.\n\n'

  local wsl=""
  case "$(uname -s)" in
    Darwin) OS=mac ;;
    Linux) OS=linux; if grep -qi microsoft /proc/version 2> /dev/null; then wsl=1; fi ;;
    MINGW* | MSYS* | CYGWIN*)
      printf '\n%s✗%s On Windows, DeepRead runs inside WSL (Linux for Windows). Open PowerShell as administrator, then copy this line, paste it there, and press Enter:\n\n      wsl --install\n\n  Restart the computer, open Ubuntu from the Start menu, and paste the DeepRead install line there.\n\n' "$RED" "$RESET" >&2
      exit 1 ;;
    *) fail "DeepRead's installer works on Mac, Linux and Windows (inside WSL), and this computer runs $(uname -s)." ;;
  esac

  # 1. git, which downloads DeepRead. On a Mac without Apple's developer tools, `git` exists but only shows a
  # prompt, so it counts only if it actually runs.
  if ! git --version > /dev/null 2>&1; then
    if [ "$OS" = mac ]; then
      fail "DeepRead needs git, a free tool from Apple that downloads it, and this Mac does not have it yet." \
        "xcode-select --install" "A window opens: click Install and wait until it finishes. Then install DeepRead again with the same line as before:" "$INSTALL_LINE"
    fi
    local get_git="sudo apt-get install -y git"
    if command -v dnf > /dev/null 2>&1; then get_git="sudo dnf install -y git"
    elif command -v pacman > /dev/null 2>&1; then get_git="sudo pacman -S --noconfirm git"
    elif command -v zypper > /dev/null 2>&1; then get_git="sudo zypper install -y git"; fi
    fail "DeepRead needs git, a free tool that downloads it, and this computer does not have it yet." \
      "$get_git" "It asks for your password (nothing shows while you type it). Then install DeepRead again:" "$INSTALL_LINE"
  fi
  good "git $(git --version | awk '{print $3}'), the tool that downloads DeepRead"

  # 2. Node.js, the engine DeepRead runs on. Never Homebrew: `brew upgrade` also upgrades unrelated programs, and an
  # older Node.js earlier on the PATH would still win afterwards. Any good copy anywhere is used as it is.
  WORK=""
  trap '[ -z "${WORK:-}" ] || rm -rf "$WORK"' EXIT
  trap 'exit 130' INT TERM
  if ! find_node; then
    download_node
    find_node || fail "Node.js was downloaded to $(pretty "$NODE_DIR") but does not start." "$INSTALL_LINE" "The installer downloads it again."
  fi
  good "Node.js $NODE_VERSION, the engine DeepRead runs on"
  local first_node first_version=""
  first_node="$(find_in_path node "$USER_PATH" || true)"
  if [ "$first_node" != "$NODE" ]; then
    if [ -n "$first_node" ]; then first_version="$(node_version "$first_node")"; fi
    if [ -n "$first_version" ]; then
      say "DeepRead uses the Node.js in $(pretty "$(dirname "$NODE")"); the Node.js $first_version you already had stays as it is."
    else
      say "DeepRead uses the Node.js in $(pretty "$(dirname "$NODE")")."
    fi
  fi
  # From here on, npm, npx and anything they start find this same Node.js. ~/.local/bin holds `deepread` and the
  # usual Claude Code install; it goes last so it never hides the reader's own programs.
  PATH="$(dirname "$NODE"):$PATH"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$PATH:$HOME/.local/bin" ;; esac
  export PATH
  export DEEPREAD_NODE="$NODE"
  export npm_config_update_notifier=false

  # 3. An AI helper, for explanations. Optional: reading and listening work without one.
  local claude codex helpers=""
  claude="$(find_claude || true)"
  codex="$(find_codex || true)"
  if [ -n "$claude" ]; then helpers="Claude Code"; fi
  if [ -n "$codex" ]; then helpers="${helpers:+$helpers and }Codex"; fi
  if [ -n "$helpers" ]; then
    good "AI helper for explanations: $helpers"
  else
    if command -v agy > /dev/null 2>&1; then
      warn "Antigravity is installed, but DeepRead does not use it: asked from a script, it runs commands on your computer, so text in a book could make it act."
    fi
    warn "No AI helper found. It is optional: reading, listening and quick word translations work without one."
    printf '  To explain words and passages, DeepRead can use one of these, signed in with your own subscription:\n\n'
    printf '    1) Claude Code    with Claude Pro or Max\n'
    printf '    2) Codex          with ChatGPT Plus or Pro\n'
    printf '    3) None for now   you can add one any time later\n\n'
    case "$(choose "Type 1, 2 or 3 and press Enter (just Enter means 3):" 3)" in
      1)
        say "Installing Claude Code..."
        curl -fsSL https://claude.ai/install.sh | bash || true
        claude="$(find_claude || true)"
        if [ -n "$claude" ]; then
          good "Claude Code is installed. Sign in once before asking for explanations: copy this line into a terminal window, press Enter, and follow the steps:"
          printf '\n      %s auth login\n\n' "$(how_to_run claude "$claude")"
        else
          warn "Claude Code did not install. To try again later, copy this line into a terminal window and press Enter:"
          printf '\n      curl -fsSL https://claude.ai/install.sh | bash\n\n'
        fi
        ;;
      2)
        say "Installing Codex..."
        local npm="$(dirname "$NODE")/npm" prefix
        prefix="$("$npm" prefix -g 2> /dev/null || true)"
        # A system Node.js (in /usr) keeps global packages in a folder only an administrator can change; then Codex
        # goes to ~/.local instead, which needs no sudo.
        if [ -n "$prefix" ] && [ -w "$prefix" ] && { [ ! -e "$prefix/lib" ] || [ -w "$prefix/lib" ]; }; then
          NPM_BIN="$prefix/bin"
          "$npm" install -g --no-fund --no-audit --loglevel=error @openai/codex < /dev/null || true
        else
          NPM_BIN="$HOME/.local/bin"
          "$npm" install -g --prefix "$HOME/.local" --no-fund --no-audit --loglevel=error @openai/codex < /dev/null || true
        fi
        NPM_BIN="$NPM_BIN/codex"
        codex="$(find_codex || true)"
        if [ -n "$codex" ]; then
          link_codex "$codex"
          if [ -x "$HOME/.local/bin/codex" ]; then codex="$HOME/.local/bin/codex"; fi
          good "Codex is installed. Sign in once before asking for explanations: copy this line into a terminal window, press Enter, and choose Sign in with ChatGPT:"
          printf '\n      %s login\n\n' "$(how_to_run codex "$codex")"
        else
          warn "Codex did not install. To try again later, copy this line into a terminal window and press Enter:"
          printf '\n      "%s" install -g @openai/codex\n\n' "$npm"
        fi
        ;;
      *) say "No AI helper for now. To add one later, see https://github.com/mrx-arafat/DeepRead#ai-helpers" ;;
    esac
  fi

  # 4. DeepRead itself. No password prompt can appear: DeepRead is public, and a prompt here would only hang.
  export GIT_TERMINAL_PROMPT=0
  if [ -d "$DIR/.git" ]; then
    say "Updating DeepRead in $(pretty "$DIR")..."
    git -C "$DIR" pull --ff-only --quiet < /dev/null ||
      fail "Could not update DeepRead in $(pretty "$DIR"). Check that this computer is online. Then:" "$INSTALL_LINE" \
        "If it fails again, files inside $(pretty "$DIR") were changed by hand; ask for help at https://github.com/mrx-arafat/DeepRead/issues"
  elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2> /dev/null)" ]; then
    fail "The folder $(pretty "$DIR") already exists and is not DeepRead, so the installer leaves it alone. To put DeepRead in a folder called DeepRead-app instead:" \
      "curl -fsSL https://raw.githubusercontent.com/mrx-arafat/DeepRead/main/scripts/install.sh | DEEPREAD_DIR=\"\$HOME/DeepRead-app\" bash" \
      "DeepRead then goes into DeepRead-app in your home folder."
  else
    say "Downloading DeepRead to $(pretty "$DIR")..."
    git clone --depth 1 --quiet "$REPO" "$DIR" < /dev/null ||
      fail "Could not download DeepRead. Check that this computer is online. Then:" "$INSTALL_LINE" "The installer tries again."
  fi
  good "DeepRead is in $(pretty "$DIR")"

  # 5. Packages, the reader, and the `deepread` command, set up with the Node.js chosen above.
  "$NODE" "$DIR/scripts/deepread.mjs" setup < /dev/null ||
    fail "Setting up DeepRead did not finish (the lines above say why). Check that this computer is online. Then:" "$INSTALL_LINE" "The installer picks up where it stopped."

  # How to start, in steps anyone can follow. The note about a new window only shows when it is really needed.
  local start="deepread" reopen
  if [ "$(find_in_path deepread "$USER_PATH" || true)" != "$HOME/.local/bin/deepread" ]; then
    if [ "$OS" = mac ]; then reopen="close this Terminal window and open Terminal again"
    elif [ -n "$wsl" ]; then reopen="close this window and open Ubuntu (or your Linux) again from the Start menu"
    else reopen="close this terminal window and open a new one"; fi
    start="~/.local/bin/deepread"
  fi
  printf '\n%sHow to use DeepRead%s\n' "$BOLD" "$RESET"
  printf '  1. Start it: type  %s  and press Enter.\n' "$start"
  if [ "$start" != deepread ]; then printf '     (After you %s, just  deepread  works too.)\n' "$reopen"; fi
  printf '  2. Your browser opens DeepRead at http://127.0.0.1:%s. Click "Add a book (PDF)" to begin.\n' "$PORT"
  if grep -qiE '^[[:space:]]*DEEPREAD_STORAGE[[:space:]]*=[[:space:]]*["'"'"']?r2' "$DIR/.env.local" 2>/dev/null; then
    printf '     Your books and notes are kept in your Cloudflare R2 bucket (set in %s).\n' "$(pretty "$DIR/.env.local")"
  else
    printf '     Your books and notes stay on this computer, in %s.\n' "$(pretty "$DIR/data")"
  fi
  printf '  3. Keep the terminal window open while you read. To stop DeepRead, click that window and press Control+C.\n'
  printf '  4. To get the latest version later: type  %s update  and press Enter.\n\n' "$start"

  if ask "Start DeepRead now? (press Enter for yes, or type n and press Enter for no)" Y; then
    exec "$NODE" "$DIR/scripts/deepread.mjs"
  fi
}

main "$@"
