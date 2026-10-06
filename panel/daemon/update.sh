#!/bin/bash
# Gaffer update script: downloads the latest GitHub release asset, replaces
# panel files, preserves user data, restarts daemon.
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_DIR="$PANEL_DIR/daemon"
TMP_DIR="${TMPDIR:-/tmp}/gaffer-update-$$"
EXTRACT_DIR="$TMP_DIR/extract"
ASSET_NAME="gaffer-update-mac.tar.gz"
# GAFFER_UPDATE_ASSET overrides the download source with another URL or a
# local file path. Only scripts/test-update-sh.sh and pre-release checks set it.
ASSET_SOURCE="${GAFFER_UPDATE_ASSET:-https://github.com/spendolas/gaffer-ae/releases/latest/download/$ASSET_NAME}"

LOG="${TMPDIR:-/tmp}/gaffer-update.log"
exec >> "$LOG" 2>&1
echo "=== Update started: $(date) ==="

# Stop whatever holds the daemon's WebSocket port (9823), reliable regardless
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
  # Wait for a graceful drain, past the 60s JSX cap the daemon honours.
  for i in $(seq 1 140); do
    lsof -nP -iTCP:9823 -sTCP:LISTEN -t >/dev/null 2>&1 || { echo "Daemon stopped."; return 0; }
    sleep 0.5
  done
  echo "Daemon did not exit in time, forcing."
  kill -KILL $(lsof -nP -iTCP:9823 -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true
}

# Never overwrite a development checkout, a dev install symlinks the panel
# out of a git repo; rsync --delete would clobber uncommitted work.
if [ -d "$PANEL_DIR/../.git" ] || [ -d "$PANEL_DIR/.git" ]; then
  echo "ERROR: panel dir is inside a git repo (dev install), refusing to update. Use git pull instead."
  echo "err:dev-install"
  exit 1
fi

# The temp dir goes away however the script exits.
trap 'cd /; rm -rf "$TMP_DIR"' EXIT

# Download the release asset and extract it into a SUBFOLDER of TMP_DIR, so
# the downloaded archive itself is never synced into the panel dir.
mkdir -p "$EXTRACT_DIR"
echo "Downloading $ASSET_SOURCE"
case "$ASSET_SOURCE" in
  http://*|https://*) curl -fsSL "$ASSET_SOURCE" -o "$TMP_DIR/$ASSET_NAME" ;;
  *) cp "$ASSET_SOURCE" "$TMP_DIR/$ASSET_NAME" ;;
esac
tar -xzf "$TMP_DIR/$ASSET_NAME" -C "$EXTRACT_DIR"
if [ ! -f "$EXTRACT_DIR/version.json" ] || [ ! -f "$EXTRACT_DIR/daemon/index.js" ]; then
  echo "ERROR: downloaded archive is not a Gaffer release (missing version.json or daemon/index.js)"
  exit 1
fi

# Version and commit come from the archive's own version.json, which the
# release workflow stamps. Nothing is read from raw.githubusercontent.com.
json_field() {
  grep -o "\"$1\": *\"[^\"]*\"" "$2" | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true
}
LATEST_VERSION="$(json_field version "$EXTRACT_DIR/version.json")"
LATEST_COMMIT="$(json_field commit "$EXTRACT_DIR/version.json")"
if [ -z "$LATEST_VERSION" ]; then
  echo "ERROR: release version.json has no version"
  exit 1
fi
echo "Release: v$LATEST_VERSION ($LATEST_COMMIT)"

# Backup chat history, legacy single file plus per-AE-version files
# (chat-history-<aeVersion>.json, e.g. chat-history-26.0.json)
BACKUP=""
if [ -f "$PANEL_DIR/chat-history.json" ]; then
  BACKUP="$TMP_DIR/chat-history.backup.json"
  cp "$PANEL_DIR/chat-history.json" "$BACKUP"
fi
HISTORY_BACKUP_DIR="$TMP_DIR/chat-history-backups"
mkdir -p "$HISTORY_BACKUP_DIR"
shopt -s nullglob
for f in "$PANEL_DIR"/chat-history-*.json; do
  cp "$f" "$HISTORY_BACKUP_DIR/"
done
shopt -u nullglob

# Backup .gaffer-config.json (claudeBin, installId, shareUsageStats, etc.):
# without this it's silently wiped by rsync --delete on every update.
CONFIG_BACKUP=""
if [ -f "$PANEL_DIR/.gaffer-config.json" ]; then
  CONFIG_BACKUP="$TMP_DIR/gaffer-config.backup.json"
  cp "$PANEL_DIR/.gaffer-config.json" "$CONFIG_BACKUP"
fi

# Stop existing daemon (panel will detect disconnect and continue)
echo "Stopping daemon..."
stop_daemon

# Sync new files into panel dir (overwrite, but preserve user data).
# version.json is excluded here and written LAST (below): the panel reloads
# and the daemon self-restarts the moment it changes. The usage-stats buffer
# and icon cache are not in the archive; excluding them also protects them
# from --delete. Stays non --inplace so this running script is never
# overwritten in place.
echo "Replacing files..."
rsync -a --delete \
  --exclude 'chat-history.json' \
  --exclude 'chat-history-*.json' \
  --exclude '.gaffer-config.json' \
  --exclude 'daemon/node_modules' \
  --exclude 'daemon/dist' \
  --exclude '/version.json' \
  --exclude '/.gaffer-usage-buffer.json' \
  --exclude '/.gaffer-icons' \
  "$EXTRACT_DIR/" "$PANEL_DIR/"

# Restore chat history
if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
  cp "$BACKUP" "$PANEL_DIR/chat-history.json"
fi
shopt -s nullglob
for f in "$HISTORY_BACKUP_DIR"/chat-history-*.json; do
  cp "$f" "$PANEL_DIR/"
done
shopt -u nullglob

# Restore .gaffer-config.json
if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
  cp "$CONFIG_BACKUP" "$PANEL_DIR/.gaffer-config.json"
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
# (the panel pauses auto-start now, but belt and braces), the panel reloads
# when version.json changes and boots a clean daemon.
stop_daemon

# LAST step: put the release's version.json in place with an atomic rename,
# so the panel and daemon only ever see the old file or the complete new one.
cp "$EXTRACT_DIR/version.json" "$PANEL_DIR/version.json.tmp"
mv -f "$PANEL_DIR/version.json.tmp" "$PANEL_DIR/version.json"

echo "=== Update complete: $(date) ==="
echo "ok:$LATEST_VERSION"
