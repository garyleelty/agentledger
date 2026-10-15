#!/bin/sh
# Install agentledger without npm.
#
#   curl -fsSL https://raw.githubusercontent.com/garyleelty/agentledger/main/install.sh | sh
#
# Clones the repo into ~/.agentledger and symlinks the CLI into
# ~/.local/bin (creating it if needed). Prints what to add to your PATH
# if ~/.local/bin is not already there.

set -e

# HTTPS is the default, but it is the transport a filtered network or a
# corporate proxy is most likely to break. If it fails, retry over SSH before
# giving up — a user behind a block should not be left with nothing.
REPO="${AGENTLEDGER_REPO:-https://github.com/garyleelty/agentledger.git}"
REPO_SSH="git@github.com:garyleelty/agentledger.git"
DEST="${AGENTLEDGER_HOME:-$HOME/.agentledger}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || err "$1 is required but not installed."; }

need git
need node

# Node 22.5+ is the real floor: the OpenCode lane reads a SQLite database and
# node:sqlite's DatabaseSync landed in 22.5. Advertising 18 here would let a
# user install and then silently lose that lane.
node_ok=$(node -e 'const v=process.versions.node.split(".").map(Number);process.stdout.write(String(v[0]*100+v[1]))')
[ "$node_ok" -ge 2205 ] 2>/dev/null || err "Node 22.5+ required (node:sqlite), found $(node -v)."

if [ -d "$DEST/.git" ]; then
  say "==> updating existing install at $DEST"
  git -C "$DEST" pull --ff-only || say "    (pull failed, using existing checkout)"
else
  say "==> cloning into $DEST"
  git clone --depth 1 "$REPO" "$DEST" 2>/dev/null \
    || git clone --depth 1 "$REPO_SSH" "$DEST" \
    || err "could not clone agentledger over HTTPS or SSH. If you are behind a filter, try: AGENTLEDGER_REPO=git@github.com:garyleelty/agentledger.git"
fi

chmod +x "$DEST/bin/agentledger.js"

mkdir -p "$BIN_DIR"
ln -sf "$DEST/bin/agentledger.js" "$BIN_DIR/agentledger"
ln -sf "$DEST/bin/agentledger.js" "$BIN_DIR/aledger"

say "==> installed"
say "    $BIN_DIR/agentledger"
say "    $BIN_DIR/aledger"

case ":$PATH:" in
  *":$BIN_DIR:"*) say "==> ready. run: agentledger" ;;
  *)
    say ""
    say "==> $BIN_DIR is not on your PATH. Add it:"
    say ""
    case "$(basename "$(ps -p $$ -o comm= 2>/dev/null || echo sh)")" in
      *zsh*) say "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
      *bash*) say "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
      *) say "    export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
    esac
    ;;
esac
