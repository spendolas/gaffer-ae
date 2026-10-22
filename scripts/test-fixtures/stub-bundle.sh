#!/bin/bash
# Test stand-in for scripts/bundle-daemon.sh (the real bundle needs npm ci).
# Same contract: bundle-daemon.sh <stage-dir> writes <stage>/daemon/daemon.mjs
# and <stage>/THIRD-PARTY-NOTICES.txt. STUB_EXTRA names one extra stage-relative
# file to plant, so tests can prove package-release.sh's assertions fire.
set -euo pipefail
STAGE="$1"
mkdir -p "$STAGE/daemon"
echo "// stub bundle" > "$STAGE/daemon/daemon.mjs"
echo "stub notices" > "$STAGE/THIRD-PARTY-NOTICES.txt"
if [ -n "${STUB_EXTRA:-}" ]; then
  mkdir -p "$(dirname "$STAGE/$STUB_EXTRA")"
  echo x > "$STAGE/$STUB_EXTRA"
fi
