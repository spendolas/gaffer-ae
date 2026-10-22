#!/bin/bash
# Bundles the daemon into one ESM file and runs the build-time checks.
# Replaces the old SEA step of build.sh. Needs `npm ci` done in panel/daemon.
#
# Usage (from anywhere): bash scripts/bundle-daemon.sh <stage-dir>
#
# Writes:
#   <stage>/daemon/daemon.mjs         the bundle (the only code file that ships)
#   <stage>/THIRD-PARTY-NOTICES.txt   licenses of every bundled package
# Writes OUTSIDE the stage (never shipped), in $GAFFER_DEBUG_DIR (default: a new temp dir):
#   meta.json, daemon.mjs.map         CI uploads these as the gaffer-debug artifact
#
# Checks (any failure exits non-zero):
#   - license allowlist / missing license file (scripts/third-party-notices.mjs)
#   - hygiene: no developer paths or secret patterns inside daemon.mjs
#   - npm audit --omit=dev --audit-level=high, unless GAFFER_SKIP_AUDIT=1
#     (local runs without network; CI leaves it on)
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: bash scripts/bundle-daemon.sh <stage-dir>" >&2
  exit 2
fi
STAGE="$1"
mkdir -p "$STAGE/daemon"
STAGE="$(cd "$STAGE" && pwd)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_DIR="$REPO_DIR/panel/daemon"
ESBUILD="$DAEMON_DIR/node_modules/.bin/esbuild"

if [ ! -x "$ESBUILD" ]; then
  echo "ERROR: $ESBUILD not found. Run 'npm ci' in panel/daemon first." >&2
  exit 1
fi

DEBUG_DIR="${GAFFER_DEBUG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/gaffer-debug-XXXXXX")}"
mkdir -p "$DEBUG_DIR"
DEBUG_DIR="$(cd "$DEBUG_DIR" && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-bundle-XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "Bundling daemon..."
# The createRequire banner is required: ws and express are CommonJS and call
# require() inside an ESM bundle.
(cd "$DAEMON_DIR" && "$ESBUILD" index.js \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile="$BUILD_DIR/daemon.mjs" \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
  --metafile="$DEBUG_DIR/meta.json" \
  --sourcemap=linked --log-level=warning)

# Source map stays out of the stage: it embeds build paths and is 4 MB.
cp "$BUILD_DIR/daemon.mjs.map" "$DEBUG_DIR/daemon.mjs.map"
cp "$BUILD_DIR/daemon.mjs" "$STAGE/daemon/daemon.mjs"
echo "Bundle: $(wc -c < "$STAGE/daemon/daemon.mjs" | tr -d ' ') bytes"

echo "Hygiene checks..."
BUNDLE="$STAGE/daemon/daemon.mjs"
# Fixed-string patterns first (developer paths), then secret shapes.
for pat in '/Users/' '/home/' 'C:\\Users' 'ghp_' 'github_pat_' 'sk-ant-' 'AKIA' '-----BEGIN'; do
  if grep -qF -- "$pat" "$BUNDLE"; then
    echo "ERROR: hygiene check failed, daemon.mjs contains '$pat':" >&2
    grep -nF -- "$pat" "$BUNDLE" | cut -c1-200 | head -5 >&2
    exit 1
  fi
done

echo "Third-party notices..."
node "$SCRIPT_DIR/third-party-notices.mjs" "$DEBUG_DIR/meta.json" "$DAEMON_DIR/node_modules" "$STAGE/THIRD-PARTY-NOTICES.txt"

if [ "${GAFFER_SKIP_AUDIT:-0}" = "1" ]; then
  echo "npm audit: SKIPPED (GAFFER_SKIP_AUDIT=1, local run only)"
else
  echo "npm audit..."
  (cd "$DAEMON_DIR" && npm audit --omit=dev --audit-level=high)
fi

echo "Debug artifacts (not shipped): $DEBUG_DIR"
