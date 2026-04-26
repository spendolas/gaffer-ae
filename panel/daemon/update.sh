#!/bin/bash
# Gaffer update script — downloads latest tarball, replaces panel files,
# preserves chat history, restarts daemon.
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_DIR="$PANEL_DIR/daemon"
TMP_DIR="${TMPDIR:-/tmp}/gaffer-update-$$"
REPO="spendolas/gaffer-ae"

LOG="${TMPDIR:-/tmp}/gaffer-update.log"
exec >> "$LOG" 2>&1
echo "=== Update started: $(date) ==="

# Get latest commit hash
LATEST_COMMIT=$(curl -s "https://api.github.com/repos/$REPO/commits/main" | grep -o '"sha": "[^"]*' | head -1 | cut -d'"' -f4)
if [ -z "$LATEST_COMMIT" ]; then
  echo "ERROR: Could not fetch latest commit"
  exit 1
fi
echo "Latest commit: $LATEST_COMMIT"

# Download tarball
mkdir -p "$TMP_DIR"
cd "$TMP_DIR"
echo "Downloading tarball..."
curl -sL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" -o gaffer.tar.gz
tar -xzf gaffer.tar.gz
EXTRACTED="$TMP_DIR/gaffer-ae-main"

if [ ! -d "$EXTRACTED/panel" ]; then
  echo "ERROR: Extracted archive missing panel/"
  exit 1
fi

# Backup chat-history.json
BACKUP=""
if [ -f "$PANEL_DIR/chat-history.json" ]; then
  BACKUP="$TMP_DIR/chat-history.backup.json"
  cp "$PANEL_DIR/chat-history.json" "$BACKUP"
fi

# Kill existing daemon (panel will detect disconnect and continue)
echo "Stopping daemon..."
pkill -f "gaffer-daemon" 2>/dev/null || true
pkill -f "node.*daemon/index.js" 2>/dev/null || true
sleep 1

# Sync new files into panel dir (overwrite, but preserve user data)
echo "Replacing files..."
rsync -a --delete \
  --exclude 'chat-history.json' \
  --exclude 'daemon/node_modules' \
  --exclude 'daemon/gaffer-daemon' \
  --exclude 'daemon/dist' \
  "$EXTRACTED/panel/" "$PANEL_DIR/"

# Restore chat history
if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
  cp "$BACKUP" "$PANEL_DIR/chat-history.json"
fi

# npm install in daemon
echo "Installing daemon dependencies..."
cd "$DAEMON_DIR"
for n in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
  [ -x "$n" ] && NODE="$n" && break
done
[ -z "${NODE:-}" ] && NODE="$(which node 2>/dev/null)"
if [ -n "${NODE:-}" ]; then
  NPM_DIR="$(dirname "$NODE")"
  PATH="$NPM_DIR:$PATH" npm install --production
fi

# Write new version.json
cat > "$PANEL_DIR/version.json" << EOF
{
  "version": "0.2.0",
  "commit": "$LATEST_COMMIT"
}
EOF

# Cleanup
cd /
rm -rf "$TMP_DIR"

echo "=== Update complete: $(date) ==="
echo "ok:$LATEST_COMMIT"
