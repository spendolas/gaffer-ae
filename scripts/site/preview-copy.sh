#!/usr/bin/env bash
# Builds the clean copy of the site used for a public PREVIEW (no dev panel, no dev files) and points its
# install prompt at the preview's own address, because https://gafferae.com/install.md does not exist
# until the real deploy. The source in site/ is never touched: only the copy is rewritten.
#
# Usage: bash scripts/site/preview-copy.sh <out-dir> <public-base-url>
#   e.g. bash scripts/site/preview-copy.sh ~/preview-site https://your-preview-host.example
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <out-dir> <public-base-url>" >&2
  exit 2
fi
OUT="$1"
BASE="${2%/}"
case "$BASE" in https://*|http://*) ;; *) echo "error: base url must start with http:// or https://" >&2; exit 2 ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

node "$ROOT/scripts/site/build-manifest.mjs" >/dev/null
mkdir -p "$OUT"
rsync -a --delete "$ROOT/site/" "$OUT/"

OLD='https://gafferae.com/install.md'
NEW="$BASE/install.md"
# The same URL in its three spellings: plain (prompt text, JS constant) and percent-encoded (the claude:// link).
ENC_OLD='https%3A%2F%2Fgafferae.com%2Finstall.md'
ENC_NEW="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$NEW")"
for f in index.html js/dock.js install.md; do
  python3 - "$OUT/$f" "$OLD" "$NEW" "$ENC_OLD" "$ENC_NEW" <<'PY'
import sys
p, old, new, eold, enew = sys.argv[1:]
s = open(p, encoding='utf-8').read()
n = s.count(old) + s.count(eold)
s = s.replace(old, new).replace(eold, enew)
open(p, 'w', encoding='utf-8').write(s)
print(f"{p}: {n} replacement(s)")
PY
done
# A preview must never be indexed, and its link-preview tags should point at the preview's own files (the real
# domain does not serve them yet), so the share image can be tested before launch.
python3 - "$OUT/index.html" "$BASE" <<'PY'
import sys
p, base = sys.argv[1:]
s = open(p, encoding='utf-8').read()
s = s.replace('content="index, follow, max-image-preview:large"', 'content="noindex, nofollow"')
s = s.replace('https://gafferae.com/', base + '/')
open(p, 'w', encoding='utf-8').write(s)
print(f"{p}: noindex, social tags point at {base}")
PY
echo "preview copy in $OUT, install prompt points at $NEW"
