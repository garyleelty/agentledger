#!/bin/sh
# Install agentledger without npm.
#
#   curl -fsSL https://raw.githubusercontent.com/garyleelty/agentledger/main/install.sh | sh
#
# Clones the repo into ~/.agentledger and symlinks the CLI into
# ~/.local/bin (creating it if needed). Prints what to add to your PATH
# if ~/.local/bin is not already there.

set -e

REPO="https://github.com/garyleelty/agentledger.git"
DEST="${AGENTLEDGER_HOME:-$HOME/.agentledger}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || err "$1 is required but not installed."; }

need git
need node

node_ok=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[ "$node_ok" -ge 18 ] 2>/dev/null || err "Node 18+ required, found $(node -v)."

if [ -d "$DEST/.git" ]; then
  say "==> updating existing install at $DEST"
  git -C "$DEST" pull --ff-only || say "    (pull failed, using existing checkout)"
else
  say "==> cloning into $DEST"
  git clone --depth 1 "$REPO" "$DEST"
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
