#!/bin/bash
# Gaffer daemon launcher — called by CEP panel.
# Prefer node over compiled binary because binary may be stale (not
# replaced by update.sh). Set GAFFER_USE_BINARY=1 to force binary.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Find node first (always available if user installed Gaffer per README)
for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$n" ] && NODE="$n" && break
done
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null)"

# Prefer binary only if explicitly requested via env var
if [ -n "$GAFFER_USE_BINARY" ] && [ -x "$DIR/gaffer-daemon" ]; then
  nohup "$DIR/gaffer-daemon" > /tmp/gaffer-daemon.log 2>&1 &
  echo "pid:$! binary"
  exit 0
fi

if [ -z "$NODE" ]; then
  echo "error:node not found" >&2
  exit 1
fi

nohup "$NODE" index.js > /tmp/gaffer-daemon.log 2>&1 &
echo "pid:$! node"
