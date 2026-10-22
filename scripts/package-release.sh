#!/bin/bash
# Builds the four GitHub Release archives plus SHA256SUMS.txt from the
# committed panel/ tree and the esbuild bundle (scripts/bundle-daemon.sh).
# Used by .github/workflows/release.yml and by local tests.
#
# GAFFER_BUNDLE_SCRIPT overrides the bundle step (tests stub it; the real one
# needs `npm ci`). GAFFER_SKIP_AUDIT=1 is passed through to the real one.
#
# Usage (from the repo root): bash scripts/package-release.sh <version> <commit> <out-dir>
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: bash scripts/package-release.sh <version> <commit> <out-dir>" >&2
  exit 2
fi
VERSION="$1"
COMMIT="$2"
OUT_DIR="$3"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-stage-XXXXXX")"
# mktemp creates the dir 0700; the tar's "./" entry copies that mode, so give
# it a normal directory mode before anything is staged.
chmod 755 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
rm -f "$OUT_DIR"/SHA256SUMS.txt "$OUT_DIR"/gaffer-install-mac.tar.gz "$OUT_DIR"/gaffer-install-win.zip \
      "$OUT_DIR"/gaffer-update-mac.tar.gz "$OUT_DIR"/gaffer-update-win.zip

# 1. panel/ contents at the archive root, tracked files only
git archive HEAD:panel | tar -x -C "$STAGE"
# Dev and test leftovers never ship. git archive never sees .remember or
# node_modules; the explicit rule protects a future switch to copying the
# working tree. update.sh/update.ps1 sync with delete, so an existing install
# loses its old copies on the next update.
rm -rf "$STAGE/daemon/test" "$STAGE/daemon/test-fixtures" "$STAGE/daemon/node_modules" \
       "$STAGE/daemon/package-lock.json" "$STAGE/.remember" "$STAGE/daemon/.remember"
# Every daemon source module is inside the bundle; only index.js (replaced by
# the shim below) and launch.cjs stay as files.
find "$STAGE/daemon" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) \
  ! -name index.js ! -name launch.cjs -delete
find "$STAGE/daemon" -type d -empty -delete

# 2. The bundle (daemon.mjs, THIRD-PARTY-NOTICES.txt), then the shim and the
# dependency-free package.json. A 0.11.x updater requires daemon/index.js and
# runs `npm install --omit=dev`; the shim keeps it working and the empty
# dependency set makes npm succeed. npm does not prune the old node_modules of
# a real install (measured: it trusts its hidden lockfile and leaves the tree);
# nothing runs from it, and the next new-updater sync deletes it.
bash "${GAFFER_BUNDLE_SCRIPT:-$REPO_ROOT/scripts/bundle-daemon.sh}" "$STAGE"
printf "import './daemon.mjs';\n" > "$STAGE/daemon/index.js"
printf '{"name":"gaffer-daemon","private":true,"type":"module"}\n' > "$STAGE/daemon/package.json"

# 3. Stamp version.json
jq -n --arg v "$VERSION" --arg c "$COMMIT" '{version: $v, commit: $c}' > "$STAGE/version.json"

# 4. Assertions: a stage that breaks the layout contract must not become a release.
fail() { echo "ERROR: stage assertion failed: $1" >&2; exit 1; }
[ -f "$STAGE/daemon/daemon.mjs" ] || fail "daemon/daemon.mjs missing"
[ -f "$STAGE/THIRD-PARTY-NOTICES.txt" ] || fail "THIRD-PARTY-NOTICES.txt missing"
[ -f "$STAGE/daemon/runtime-pins.json" ] || fail "daemon/runtime-pins.json missing"
[ -z "$(find "$STAGE" -name node_modules -print -quit)" ] || fail "node_modules present"
[ -z "$(find "$STAGE" -name '*.map' -print -quit)" ] || fail ".map file present"
[ -z "$(find "$STAGE" -name package-lock.json -print -quit)" ] || fail "package-lock.json present"
[ -z "$(find "$STAGE" \( -name .remember -o -name test -o -name test-fixtures \) -print -quit)" ] || fail "test or .remember dir present"
EXTRA="$(find "$STAGE/daemon" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) ! -name daemon.mjs ! -name index.js ! -name launch.cjs)"
[ -z "$EXTRA" ] || fail "code modules beside daemon.mjs: $EXTRA"
[ "$(cat "$STAGE/daemon/index.js")" = "import './daemon.mjs';" ] || fail "index.js is not the shim"
[ "$(cat "$STAGE/daemon/package.json")" = '{"name":"gaffer-daemon","private":true,"type":"module"}' ] || fail "daemon/package.json is not the dependency-free one"

# 5. Archives (names unchanged) and SHA256SUMS.txt over them.
tar -czf "$OUT_DIR/gaffer-install-mac.tar.gz" -C "$STAGE" .
(cd "$STAGE" && zip -qr "$OUT_DIR/gaffer-install-win.zip" .)
cp "$OUT_DIR/gaffer-install-mac.tar.gz" "$OUT_DIR/gaffer-update-mac.tar.gz"
cp "$OUT_DIR/gaffer-install-win.zip" "$OUT_DIR/gaffer-update-win.zip"

(cd "$OUT_DIR" && shasum -a 256 gaffer-install-mac.tar.gz gaffer-install-win.zip gaffer-update-mac.tar.gz gaffer-update-win.zip > SHA256SUMS.txt)

echo "Built v$VERSION ($COMMIT) into $OUT_DIR"
