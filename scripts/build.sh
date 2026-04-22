#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_DIR="$REPO_DIR/panel/daemon"

echo "=== Gaffer Build ==="

# Check esbuild
cd "$DAEMON_DIR"
if ! npx esbuild --version &>/dev/null 2>&1; then
  echo "Installing esbuild..."
  npm install --save-dev esbuild
fi

# 1. Bundle ESM → CJS
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

# 2. Generate SEA blob
echo "Generating SEA blob..."
cat > dist/sea-config.json << EOF
{
  "main": "$DAEMON_DIR/dist/bundle.cjs",
  "output": "$DAEMON_DIR/dist/sea-prep.blob"
}
EOF
node --experimental-sea-config dist/sea-config.json

# 3. Detect platform and download matching Node binary
ARCH=$(uname -m)
OS=$(uname -s)

if [ "$OS" = "Darwin" ]; then
  if [ "$ARCH" = "arm64" ]; then
    PLATFORM="darwin-arm64"
  else
    PLATFORM="darwin-x64"
  fi
elif [ "$OS" = "Linux" ]; then
  PLATFORM="linux-x64"
else
  echo "ERROR: Unsupported platform $OS/$ARCH"
  exit 1
fi

NODE_VERSION="v20.14.0"
NODE_URL="https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$PLATFORM.tar.gz"

if [ ! -f "dist/node-$PLATFORM" ]; then
  echo "Downloading Node.js $NODE_VERSION for $PLATFORM..."
  curl -sL "$NODE_URL" | tar -xz --strip-components=2 -C dist "node-$NODE_VERSION-$PLATFORM/bin/node"
  mv dist/node "dist/node-$PLATFORM"
fi

# 4. Inject SEA blob into Node binary
echo "Building standalone binary..."
cp "dist/node-$PLATFORM" gaffer-daemon
codesign --remove-signature gaffer-daemon 2>/dev/null || true
npx postject gaffer-daemon NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA
codesign --sign - gaffer-daemon 2>/dev/null || true

echo ""
echo "=== Build complete ==="
echo "Binary: $(du -h gaffer-daemon | cut -f1) ($(file gaffer-daemon | cut -d: -f2))"
