#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_DIR="$REPO_DIR/panel/daemon"

echo "=== Gaffer Build ==="

# Check tools
if ! command -v bun &>/dev/null; then
  echo "ERROR: bun not found. Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

cd "$DAEMON_DIR"

# 1. Install deps if needed
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install 2>&1 | tail -3
fi

# 2. Install esbuild if needed
if ! npx esbuild --version &>/dev/null 2>&1; then
  npm install --save-dev esbuild
fi

# 3. Bundle ESM → CJS
echo "Bundling daemon..."
mkdir -p dist
npx esbuild index.js \
  --bundle \
  --platform=node \
  --format=cjs \
  --outfile=dist/bundle.cjs \
  --banner:js='var __import_meta_url = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : undefined;' \
  --define:import.meta.url=__import_meta_url

echo "Bundle: $(du -h dist/bundle.cjs | cut -f1)"

# 4. Compile with bun
echo "Compiling standalone binary..."
rm -f gaffer-daemon
bun build dist/bundle.cjs --compile --outfile gaffer-daemon

echo "Binary: $(du -h gaffer-daemon | cut -f1)"

# 5. Cross-compile for other targets if requested
if [ "${1:-}" = "--all" ]; then
  echo "Cross-compiling..."
  bun build dist/bundle.cjs --compile --target=bun-linux-x64 --outfile dist/gaffer-daemon-linux-x64 2>/dev/null || echo "  linux-x64: skipped (may need bun update)"
  bun build dist/bundle.cjs --compile --target=bun-windows-x64 --outfile dist/gaffer-daemon-win-x64.exe 2>/dev/null || echo "  win-x64: skipped (may need bun update)"
  ls -lh dist/gaffer-daemon-* 2>/dev/null
fi

echo ""
echo "=== Build complete ==="
echo "Binary at: $DAEMON_DIR/gaffer-daemon"
