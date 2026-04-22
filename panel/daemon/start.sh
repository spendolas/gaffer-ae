#!/bin/bash
# Gaffer daemon launcher — called by CEP panel via system.callSystem()
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Prefer compiled binary if it exists
if [ -x "$DIR/gaffer-daemon" ]; then
  nohup "$DIR/gaffer-daemon" > /tmp/gaffer-daemon.log 2>&1 &
  echo "pid:$! binary"
  exit 0
fi

# Fall back to node
for n in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
  [ -x "$n" ] && NODE="$n" && break
done
[ -z "$NODE" ] && NODE="$(which node 2>/dev/null)"

if [ -z "$NODE" ]; then
  echo "error:node not found" >&2
  exit 1
fi

nohup "$NODE" index.js > /tmp/gaffer-daemon.log 2>&1 &
echo "pid:$! node"
