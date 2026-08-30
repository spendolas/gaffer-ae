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

# Stop whatever holds the daemon's WebSocket port (9823) — reliable regardless
# of how it was launched (`node index.js`, `env node index.js`, or the SEA
# binary). The old pattern kills (pkill -f "node.*daemon/index.js") never matched
# the real `node index.js` cmdline, so every update left a stale daemon running.
# Graceful first: SIGTERM lets a v0.9.5+ daemon drain in-flight work then exit;
# SIGKILL only if it outlives the window.
stop_daemon() {
  local pids i
  pids="$(lsof -nP -iTCP:9823 -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    pkill -f "gaffer-daemon" 2>/dev/null || true   # SEA binary fallback
    return 0
  fi
  echo "Stopping daemon (pids: $pids)"
  kill -TERM $pids 2>/dev/null || true
  # Wait for a graceful drain — past the 60s JSX cap the daemon honours.
  for i in $(seq 1 140); do
    lsof -nP -iTCP:9823 -sTCP:LISTEN -t >/dev/null 2>&1 || { echo "Daemon stopped."; return 0; }
    sleep 0.5
  done
  echo "Daemon did not exit in time — forcing."
  kill -KILL $(lsof -nP -iTCP:9823 -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true
}

# Never overwrite a development checkout — a dev install symlinks the panel
# out of a git repo; rsync --delete would clobber uncommitted work.
if [ -d "$PANEL_DIR/../.git" ] || [ -d "$PANEL_DIR/.git" ]; then
  echo "ERROR: panel dir is inside a git repo (dev install) — refusing to update. Use git pull instead."
  echo "err:dev-install"
  exit 1
fi

# Get latest version info from raw version.json
REMOTE_VERSION=$(curl -s "https://raw.githubusercontent.com/$REPO/main/panel/version.json")
LATEST_COMMIT=$(echo "$REMOTE_VERSION" | grep -o '"commit": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
if [ -z "$LATEST_COMMIT" ]; then
  echo "ERROR: Could not fetch latest version.json"
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

# Stop existing daemon (panel will detect disconnect and continue)
echo "Stopping daemon..."
stop_daemon

# Sync new files into panel dir (overwrite, but preserve user data)
echo "Replacing files..."
rsync -a --delete \
  --exclude 'chat-history.json' \
  --exclude 'daemon/node_modules' \
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

# Stop any daemon that respawned from the half-copied tree during the update
# (the panel pauses auto-start now, but belt and braces) — the panel reloads
# when version.json changes and boots a clean daemon.
stop_daemon

# Write new version.json — version comes from the downloaded tarball,
# only the commit is stamped (rsync already copied the tarball's file,
# but stamp explicitly in case the tarball's commit field is stale).
LATEST_VERSION=$(grep -o '"version": *"[^"]*"' "$EXTRACTED/panel/version.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
cat > "$PANEL_DIR/version.json" << EOF
{
  "version": "${LATEST_VERSION:-0.0.0}",
  "commit": "$LATEST_COMMIT"
}
EOF

# Cleanup
cd /
rm -rf "$TMP_DIR"

echo "=== Update complete: $(date) ==="
echo "ok:$LATEST_COMMIT"
