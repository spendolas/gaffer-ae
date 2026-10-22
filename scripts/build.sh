#!/bin/bash
# Local dev build: bundles the daemon with esbuild (no SEA binary any more).
# The release pipeline uses scripts/bundle-daemon.sh directly via
# scripts/package-release.sh; this wrapper leaves a gitignored
# panel/daemon/daemon.mjs so you can try the bundle with a plain `node daemon.mjs`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_DIR="$REPO_DIR/panel/daemon"
STAGE="$DAEMON_DIR/dist/stage"

echo "=== Gaffer Build ==="
[ -d "$DAEMON_DIR/node_modules" ] || (cd "$DAEMON_DIR" && npm ci)
rm -rf "$STAGE"
GAFFER_SKIP_AUDIT="${GAFFER_SKIP_AUDIT:-1}" bash "$SCRIPT_DIR/bundle-daemon.sh" "$STAGE"
cp "$STAGE/daemon/daemon.mjs" "$DAEMON_DIR/daemon.mjs"
echo "=== Build complete: $DAEMON_DIR/daemon.mjs ($(du -h "$DAEMON_DIR/daemon.mjs" | cut -f1)) ==="
