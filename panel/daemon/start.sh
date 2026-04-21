#!/bin/bash
# Gaffer daemon launcher — called by CEP panel via system.callSystem()
DIR="$(cd "$(dirname "$0")" && pwd)"

# Find node
for n in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
  [ -x "$n" ] && NODE="$n" && break
done

if [ -z "$NODE" ]; then
  NODE="$(which node 2>/dev/null)"
fi

if [ -z "$NODE" ]; then
  echo "error:node not found" >&2
  exit 1
fi

cd "$DIR"
nohup "$NODE" index.js > /tmp/gaffer-daemon.log 2>&1 &
echo "pid:$!"
