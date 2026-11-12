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
#   - hygiene: no developer paths or secret patterns inside daemon.mjs (package-release.sh
#     also scans the whole staged package, see --stage-hygiene-only)
#   - npm audit --omit=dev --audit-level=high, unless GAFFER_SKIP_AUDIT=1
#     (local runs without network; CI leaves it on)
set -euo pipefail

# Nothing from dev tooling may land in the home directory (npm cache, logs, userconfig).
_REPO="$(cd "$(dirname "$0")/.." && pwd)"
export npm_config_cache="${npm_config_cache:-$_REPO/.npm-cache}"
export npm_config_logs_dir="${npm_config_logs_dir:-$_REPO/.npm-cache/_logs}"
export npm_config_userconfig="${npm_config_userconfig:-$_REPO/.npm-cache/no-userconfig}"

# Hygiene patterns: developer paths (C:\Users in both the single and the
# escaped double-backslash form, /Volumes/) and secret shapes (GitHub, Anthropic,
# AWS, Google, Slack, Figma and npm token prefixes, private key headers).
# Sourced by the test too. These are checked inside daemon.mjs.
HYGIENE_PATTERNS=('/Users/' '/home/' '/Volumes/' 'C:\Users' 'C:\\Users' 'ghp_' 'github_pat_' 'sk-ant-' 'AKIA' 'AIza' 'xox' 'figd_' 'npm_' '-----BEGIN')
# The same scan over every text file of the staged package (package-release.sh
# runs it). /Users/, /home/ and sk-ant- are not in this list: the panel's own
# files carry harmless examples of them (a sample path in a comment, a masked
# sample key in the settings mock-up).
STAGE_HYGIENE_PATTERNS=('/Volumes/' 'C:\Users' 'C:\\Users' 'ghp_' 'github_pat_' 'AKIA' 'AIza' 'xox' 'figd_' 'npm_' '-----BEGIN')
hygiene_check() {
  local file="$1" pat
  for pat in "${HYGIENE_PATTERNS[@]}"; do
    if grep -qF -- "$pat" "$file"; then
      echo "ERROR: hygiene check failed, $(basename "$file") contains '$pat':" >&2
      grep -nF -- "$pat" "$file" | cut -c1-200 | head -5 >&2
      return 1
    fi
  done
}
stage_hygiene_check() {
  local dir="$1" pat hit
  for pat in "${STAGE_HYGIENE_PATTERNS[@]}"; do
    hit="$(grep -rIlF -- "$pat" "$dir" 2>/dev/null | head -5 || true)"
    if [ -n "$hit" ]; then
      echo "ERROR: hygiene check failed, the staged package contains '$pat' in:" >&2
      echo "$hit" | sed "s#^$dir/##" >&2
      return 1
    fi
  done
}
# Test seam: `bash bundle-daemon.sh --hygiene-only <file>`.
if [ "${1:-}" = "--hygiene-only" ]; then hygiene_check "$2"; exit $?; fi
# Test seam and package-release.sh step: `bash bundle-daemon.sh --stage-hygiene-only <dir>`.
if [ "${1:-}" = "--stage-hygiene-only" ]; then stage_hygiene_check "$2"; exit $?; fi

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
hygiene_check "$BUNDLE"

echo "Third-party notices..."
node "$SCRIPT_DIR/third-party-notices.mjs" "$DEBUG_DIR/meta.json" "$DAEMON_DIR/node_modules" "$STAGE/THIRD-PARTY-NOTICES.txt"

if [ "${GAFFER_SKIP_AUDIT:-0}" = "1" ]; then
  echo "npm audit: SKIPPED (GAFFER_SKIP_AUDIT=1, local run only)"
else
  echo "npm audit..."
  (cd "$DAEMON_DIR" && npm audit --omit=dev --audit-level=high)
fi

echo "Debug artifacts (not shipped): $DEBUG_DIR"
