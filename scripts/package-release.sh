#!/bin/bash
# Builds the four GitHub Release assets from the committed panel/ tree.
# No compile step: each asset is a plain archive of panel/ with a stamped
# version.json. Used by .github/workflows/release.yml and by local tests.
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

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-stage-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
rm -f "$OUT_DIR"/gaffer-install-mac.tar.gz "$OUT_DIR"/gaffer-install-win.zip \
      "$OUT_DIR"/gaffer-update-mac.tar.gz "$OUT_DIR"/gaffer-update-win.zip

# panel/ contents at the archive root, tracked files only
git archive HEAD:panel | tar -x -C "$STAGE"
jq -n --arg v "$VERSION" --arg c "$COMMIT" '{version: $v, commit: $c}' > "$STAGE/version.json"

tar -czf "$OUT_DIR/gaffer-install-mac.tar.gz" -C "$STAGE" .
(cd "$STAGE" && zip -qr "$OUT_DIR/gaffer-install-win.zip" .)
cp "$OUT_DIR/gaffer-install-mac.tar.gz" "$OUT_DIR/gaffer-update-mac.tar.gz"
cp "$OUT_DIR/gaffer-install-win.zip" "$OUT_DIR/gaffer-update-win.zip"

echo "Built v$VERSION ($COMMIT) into $OUT_DIR"
