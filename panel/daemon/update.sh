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

# Last log line contract (the only channel back to a human or a tool):
#   ok:<version>            installed
#   err:<code>              failed (err:dev-install, err:lock) or a bare ERROR line
#   busy:already-running    another updater holds the lock; this one did nothing
# Exit codes: 0 ok, 1 failed, 3 busy.

# Single-updater lock. Two updaters interleaving (the panel's "Force stop &
# retry" after its 180s give-up, or a manual run next to the panel's) would
# rsync over each other and corrupt the install, so the whole run holds
# $LOCK_DIR, created atomically with mkdir and holding this PID. A lock whose
# PID is dead or is not an update.sh is abandoned and taken over; a lock older
# than 15 minutes whose holder is still an update.sh is a stuck updater, which
# is stopped first, then taken over. A lock younger than 30 seconds with no
# pid yet belongs to an updater between its mkdir and its pid write, and
# counts as busy. The takeover itself is an atomic rename, so two updaters
# finding the same stale lock cannot each remove the other's fresh one.
# panel/main.js reads the same lock to decide whether an updater is still
# running; keep the path and layout in sync.
LOCK_DIR="${TMPDIR:-/tmp}/gaffer-update.lock"
HAVE_LOCK=""
# True when the pid is alive and its command line is an update.sh.
lock_holder_is_updater() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  ps -o command= -p "$pid" 2>/dev/null | grep -q 'update\.sh'
}
# -mmin +15 prints the dir only when it is older than 15 minutes
lock_is_old() { [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +15 2>/dev/null)" ]; }
lock_is_young() {
  local mtime now
  mtime="$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  [ $((now - mtime)) -lt 30 ]
}
# TERM first, a short wait, then KILL. kill -0 keeps answering for a zombie
# whose parent has not reaped it yet, so the wait is bounded, not a condition.
stop_lock_holder() {
  local pid="$1" i
  echo "Stopping an update that has run for over 15 minutes (pid $pid)"
  kill -TERM "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.3
  done
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.3
}
acquire_lock() {
  local tries=0 holder stale
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ ! -e "$LOCK_DIR" ]; then
      # Released between our mkdir and now (or mkdir cannot work here): retry, bounded.
      tries=$((tries + 1))
      if [ "$tries" -gt 3 ]; then
        echo "ERROR: could not create the update lock at $LOCK_DIR"
        echo "err:lock"
        exit 1
      fi
      continue
    fi
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -z "$holder" ] && lock_is_young; then
      echo "Another update is starting up (its lock is seconds old), leaving it to finish."
      echo "busy:already-running"
      exit 3
    fi
    if lock_holder_is_updater "$holder" && ! lock_is_old; then
      echo "Another update is already running (pid $holder), leaving it to finish."
      echo "busy:already-running"
      exit 3
    fi
    tries=$((tries + 1))
    if [ "$tries" -gt 3 ]; then
      echo "ERROR: could not take the update lock at $LOCK_DIR"
      echo "err:lock"
      exit 1
    fi
    if lock_holder_is_updater "$holder"; then
      stop_lock_holder "$holder"
    fi
    echo "Taking over an abandoned update lock (pid ${holder:-unknown})"
    # Rename, then delete the copy. Only one of several takers can win the
    # rename; the others fall through to mkdir and find the winner's lock.
    stale="$LOCK_DIR.stale.$$"
    if mv "$LOCK_DIR" "$stale" 2>/dev/null; then
      rm -rf "$stale"
    fi
  done
  echo "$$" > "$LOCK_DIR/pid"
  HAVE_LOCK=1
}
cleanup() {
  cd /
  rm -rf "$TMP_DIR"
  if [ -n "$HAVE_LOCK" ]; then rm -rf "$LOCK_DIR"; fi
}
# The lock and the temp dir go away however the script exits. Set before the
# lock is taken so no exit path can leak it; a busy exit never held it.
trap cleanup EXIT
acquire_lock

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

# Download the release asset and extract it into a SUBFOLDER of TMP_DIR, so
# the downloaded archive itself is never synced into the panel dir.
# Download budget: the asset is a few MB, and the limits bound STALLS, not a
# slow but moving transfer. An attempt is abandoned when the connection takes
# over 15s or the speed stays under 2 KB/s for 20s (a hung proxy, a dropped
# link), and --max-time caps each attempt at 150s. curl retries such
# timeouts twice, but --retry-max-time 120 only lets a retry START while
# less than 120s have passed since the first attempt began. Worst case: the
# first attempt dies just under 120s, the second runs its full 150s, no
# third starts: about 270s of download, then extract + rsync + npm. The
# panel (main.js waitForUpdatedVersion) gives up after 180s but extends once
# by 180s while this lock is held, so the whole run has 360s. A 4xx answer
# (404 on a missing asset) is final: curl does not retry it.
mkdir -p "$EXTRACT_DIR"
echo "Downloading $ASSET_SOURCE"
case "$ASSET_SOURCE" in
  http://*|https://*) curl -fsSL --connect-timeout 15 --speed-limit 2048 --speed-time 20 --max-time 150 --retry 2 --retry-max-time 120 "$ASSET_SOURCE" -o "$TMP_DIR/$ASSET_NAME" ;;
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
