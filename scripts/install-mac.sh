#!/bin/bash
set -euo pipefail

EXTENSION_ID="com.gaffer.panel"
INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXTENSION_ID"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PANEL_DIR="$REPO_DIR/panel"

echo "=== Gaffer Installer (macOS) ==="

# 1. Check Claude CLI
echo "Checking prerequisites..."
CLAUDE_BIN=""
for candidate in /usr/local/bin/claude "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do
  if [ -x "$candidate" ]; then
    CLAUDE_BIN="$candidate"
    break
  fi
done
if [ -z "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
fi
if [ -z "$CLAUDE_BIN" ]; then
  echo "ERROR: Claude Code CLI not found. Install from https://claude.ai/code"
  exit 1
fi
echo "  Claude CLI: $CLAUDE_BIN"

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

# 5. Register MCP server
echo "Registering Gaffer MCP server..."
"$CLAUDE_BIN" mcp add --transport http -s user gaffer "http://127.0.0.1:9824/mcp" 2>/dev/null || true

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Restart After Effects"
echo "  2. Open Window > Extensions > Gaffer"
echo "  3. The daemon starts automatically when the panel loads"
echo ""
