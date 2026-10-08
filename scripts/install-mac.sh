#!/bin/bash
set -euo pipefail

EXTENSION_ID="com.gaffer.panel"
INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXTENSION_ID"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PANEL_DIR="$REPO_DIR/panel"

echo "=== Gaffer Installer (macOS) ==="

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

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "  Node.js: $(node --version)"

# 2. Symlink extension (edits to panel/ are live)
echo "Installing extension to $INSTALL_DIR..."
if [ -e "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
fi
ln -sf "$PANEL_DIR" "$INSTALL_DIR"

# 3. Install daemon dependencies
echo "Installing daemon dependencies..."
cd "$PANEL_DIR/daemon" && npm install --production 2>&1 | tail -3

# 4. Set PlayerDebugMode
echo "Setting PlayerDebugMode..."
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1

# 5. Register MCP server (only used by Claude Code outside AE; the panel chat
# passes its own MCP config and does not need this). Skip when there is no
# Claude, or when the desktop app copy does not run from the command line.
if [ -z "$CLAUDE_BIN" ]; then
  echo "Skipping MCP server registration (no Claude found)."
elif [ "$CLAUDE_KIND" = "app" ] && ! "$CLAUDE_BIN" --version >/dev/null 2>&1; then
  echo "Skipping MCP server registration (the desktop app's Claude Code did not answer --version)."
else
  echo "Registering Gaffer MCP server..."
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
