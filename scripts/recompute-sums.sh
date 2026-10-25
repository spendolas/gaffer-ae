#!/usr/bin/env bash
# Rewrites <dir>/SHA256SUMS.txt over the four release archives in <dir>,
# in the same order and format scripts/package-release.sh writes
# (`shasum -a 256` lines: "<sha256>  <name>").
#
# Used by .github/workflows/release.yml when it recovers a PUBLISHED release:
# packaging is not byte-reproducible, so after re-uploading a missing archive
# the sums must be recomputed over the archives as they now sit on the
# release, not taken from the new build.
#
# Usage: scripts/recompute-sums.sh <dir>
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: $0 <dir with the four release archives>" >&2
  exit 2
fi
DIR="$1"
ARCHIVES=(gaffer-install-mac.tar.gz gaffer-install-win.zip gaffer-update-mac.tar.gz gaffer-update-win.zip)

for a in "${ARCHIVES[@]}"; do
  if [ ! -f "$DIR/$a" ] || [ ! -s "$DIR/$a" ]; then
    echo "recompute-sums: missing or empty archive: $a" >&2
    exit 1
  fi
done

# Write to a temp name first so a failure never leaves a partial sums file.
(cd "$DIR" && shasum -a 256 "${ARCHIVES[@]}" > SHA256SUMS.txt.tmp && mv SHA256SUMS.txt.tmp SHA256SUMS.txt)
cat "$DIR/SHA256SUMS.txt"
