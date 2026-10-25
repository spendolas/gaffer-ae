#!/bin/bash
set -euo pipefail

EXTENSION_ID="com.gaffer.panel"
INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXTENSION_ID"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PANEL_DIR="$REPO_DIR/panel"

echo "=== Gaffer Installer (macOS) ==="
# Developer installer: links this checkout into the CEP extensions folder and
# runs the daemon from source, so it needs Node.js 20+ and npm. End users
# follow README.md instead, which needs neither (it downloads the pinned
# runtime into the extension folder, the same steps as daemon/fetch-runtime.sh).
# There is no copy mode on macOS: the install is always a symlink, so the
# runtime is never fetched here.

# 1. Look for a runnable Claude. The panel chat works with either the Claude
# desktop app's bundled Claude Code or a standalone CLI (the daemon finds
# whichever is present at runtime, see panel/daemon/claude-binary.js), so a
# missing Claude is a warning here, not a failed install.
echo "Checking prerequisites..."
CLAUDE_BIN=""
CLAUDE_KIND=""
for candidate in /usr/local/bin/claude "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do
  if [ -x "$candidate" ]; then
    CLAUDE_BIN="$candidate"
    break
  fi
done
if [ -z "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
fi
if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_KIND="cli"
else
  # Desktop app copy: ~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude
  # (newest version folder first; the hash level is absent in older layouts).
  APP_ROOT="$HOME/Library/Application Support/Claude/claude-code"
  if [ -d "$APP_ROOT" ]; then
    while IFS= read -r version_dir; do
      [ -n "$version_dir" ] || continue
      found="$(find "$APP_ROOT/$version_dir" -maxdepth 7 -type f -path '*/claude.app/Contents/MacOS/claude' 2>/dev/null | head -n 1 || true)"
      if [ -n "$found" ] && [ -x "$found" ]; then
        CLAUDE_BIN="$found"
        CLAUDE_KIND="app"
        break
      fi
    done < <(ls -1 "$APP_ROOT" 2>/dev/null | sort -t. -k1,1nr -k2,2nr -k3,3nr)
  fi
fi
if [ -z "$CLAUDE_BIN" ]; then
  echo "WARNING: no Claude found. Gaffer chat needs the Claude desktop app or Claude Code:"
  echo "  Claude desktop app: https://claude.com/download"
  echo "  Claude Code (CLI):  https://claude.ai/code"
  echo "  Installing the panel anyway; install one of them before opening Gaffer."
elif [ "$CLAUDE_KIND" = "app" ]; then
  echo "  Claude (desktop app): $CLAUDE_BIN"
else
  echo "  Claude CLI: $CLAUDE_BIN"
fi

if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
  echo "ERROR: this developer install runs the daemon from source and needs Node.js 20+ and npm."
  echo "  To install Gaffer without Node.js, follow the install steps in README.md instead."
  exit 1
fi
echo "  Node.js: $(node --version)"

# 2. Symlink extension (edits to panel/ are live)
echo "Installing extension to $INSTALL_DIR..."
if [ -e "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
fi
ln -sf "$PANEL_DIR" "$INSTALL_DIR"

# 3. Install daemon dependencies (symlinked dev install: system node runs
# index.js from the checkout). npm's cache, logs and userconfig stay inside
# the repo so nothing lands in the developer's home directory (spec 9).
echo "Installing daemon dependencies..."
export npm_config_cache="$REPO_DIR/.npm-cache"
export npm_config_logs_dir="$REPO_DIR/.npm-cache/_logs"
export npm_config_userconfig="$REPO_DIR/.npmrc-dev"
cd "$PANEL_DIR/daemon" && npm install --omit=dev 2>&1 | tail -3

# 4. Set PlayerDebugMode
echo "Setting PlayerDebugMode..."
# A user preference that lets AE load extensions not signed through Adobe.
for v in 11 12 13; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done

# 5. Register MCP server (only used by Claude Code outside AE; the panel chat
# passes its own MCP config and does not need this). Skip when there is no
# Claude, or when the desktop app copy does not run from the command line.
if [ -z "$CLAUDE_BIN" ]; then
  echo "Skipping MCP server registration (no Claude found)."
elif [ "$CLAUDE_KIND" = "app" ] && ! "$CLAUDE_BIN" --version >/dev/null 2>&1; then
  echo "Skipping MCP server registration (the desktop app's Claude Code did not answer --version)."
elif "$CLAUDE_BIN" mcp get gaffer >/dev/null 2>&1; then
  # A reinstall: registering again would only warn about the existing entry.
  echo "  Gaffer MCP server already registered with Claude Code."
else
  echo "Registering Gaffer MCP server..."
  echo "  This adds an entry named gaffer to your Claude Code user settings (~/.claude.json)."
  echo "  To remove it later: claude mcp remove gaffer -s user"
  if ! "$CLAUDE_BIN" mcp add --transport http -s user gaffer "http://127.0.0.1:9824/mcp" >/dev/null 2>&1; then
    echo "WARNING: could not register the Gaffer MCP server with Claude Code. The panel still works;"
    echo "  to use Gaffer tools from Claude Code outside AE, run:"
    echo "  claude mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp"
  fi
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Restart After Effects"
echo "  2. Open Window > Extensions > Gaffer"
echo "  3. The daemon starts automatically when the panel loads"
echo ""
