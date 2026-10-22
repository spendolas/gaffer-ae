#!/bin/bash
# Gaffer daemon launcher (macOS), called by the CEP panel only on the
# ExtendScript fallback route (spawnViaExtendScript in panel/main.js); the
# normal route is spawnViaNode. Mirrors resolveDaemonLaunch in
# panel/daemon-launch.js exactly (zero-dependency install spec, sections 4
# and 5):
#   1. Dev checkout (<panel>/../.git exists): system node with index.js.
#   2. runtime/node exists: it must pass the check (daemon.mjs present, size
#      equals the runtime/VERIFIED stamp, or on a stamp-less first run the
#      size and sha256 match runtime-pins.json, then the stamp is written).
#      A runtime that fails the check is NEVER bypassed with a system node.
#   3. No runtime: system node (fixed candidates, then PATH) with daemon.mjs
#      when present, else index.js.
# Output contract, one line on stdout (panel/main.js parses it):
#   pid:<N> runtime | pid:<N> node | err:runtime-damaged | err:runtime-missing
# Decisions and notes go to the daemon log, like the panel's.
#
# Test seams (panel/daemon/test/start-sh.test.mjs): GAFFER_DAEMON_LOG moves
# the log; GAFFER_START_TEST_NODE_CANDIDATES (set, even empty) replaces the
# fixed system-node candidates.

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || { echo "err:runtime-missing"; exit 1; }
LOG="${GAFFER_DAEMON_LOG:-/tmp/gaffer-daemon.log}"
BIN="$DIR/runtime/node"
BUNDLE="$DIR/daemon.mjs"
STAMP="$DIR/runtime/VERIFIED"
PINS="$DIR/runtime-pins.json"
OS="$(uname -s 2>/dev/null)"

note() {
  printf '%s Gaffer start.sh: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG" 2>/dev/null
}

fail() { # $1 = error code, $2 = reason (optional)
  [ -n "$2" ] && note "runtime: $2"
  note "daemon not launched: err:$1${2:+ ($2)}"
  echo "err:$1"
  exit 1
}

# Value of "<field>" inside the "<platform>" object of runtime-pins.json.
# The file is pretty-printed, one key per line (no jq on a stock Mac).
pin_field() { # $1 = platform key, $2 = field
  sed -n "/\"$1\"[[:space:]]*:/,/}/p" "$PINS" 2>/dev/null \
    | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" \
    | head -n 1 | tr -d '[:space:]'
}

# Recorded size from the stamp, empty when absent, unreadable or garbled.
# Spec form "<size> <sha256>"; the PoC wrote "size=<n>" lines, read both.
stamp_size() {
  local raw
  [ -f "$STAMP" ] || return 0
  raw="$(cat "$STAMP" 2>/dev/null)" || return 0
  if [[ $raw =~ ^[[:space:]]*([0-9]+)([[:space:]]|$) ]]; then
    echo "${BASH_REMATCH[1]}"
  elif [[ $raw =~ size=([0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

check_runtime() {
  [ -e "$BUNDLE" ] || fail runtime-damaged "daemon.mjs missing next to the runtime"
  local size stamped
  size="$(wc -c < "$BIN" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$size" ] || fail runtime-damaged "cannot stat runtime"

  stamped="$(stamp_size)"
  if [ -n "$stamped" ]; then
    [ "$((10#$stamped))" = "$size" ] || fail runtime-damaged "runtime size $size does not match the stamp $((10#$stamped))"
  else
    # Stamp-less first run (README install): verify once against the pin.
    # On macOS both darwin entries are candidates and the size picks one.
    local key="" k sha got recorded
    if [ "$OS" = "Darwin" ]; then
      for k in darwin-arm64 darwin-x64; do
        if [ "$(pin_field "$k" binaryBytes)" = "$size" ]; then key="$k"; break; fi
      done
    fi
    [ -n "$key" ] || fail runtime-damaged "no stamp and runtime size $size matches no pinned binary"
    sha="$(pin_field "$key" binarySha256)"
    if ! [[ $sha =~ ^[0-9a-fA-F]{64}$ ]]; then
      note "runtime: pinned sha256 for $key is a placeholder ($sha), skipping the hash check, size matched"
      recorded="unhashed"
    else
      got="$(shasum -a 256 "$BIN" 2>/dev/null | cut -d ' ' -f 1 | tr 'A-F' 'a-f')"
      [ -n "$got" ] || fail runtime-damaged "cannot hash runtime"
      [ "$got" = "$(printf '%s' "$sha" | tr 'A-F' 'a-f')" ] || fail runtime-damaged "runtime sha256 $got does not match the pin for $key"
      recorded="$got"
      note "runtime: first run, sha256 matches the pin for $key"
    fi
    if printf '%s %s\n' "$size" "$recorded" > "$STAMP" 2>/dev/null; then
      note "runtime: wrote stamp $STAMP"
    else
      note "runtime: could not write the stamp, will verify again next launch"
    fi
  fi

  # macOS: a binary whose size checks out but lost its exec bit (copied by a
  # tool that drops modes) gets it back.
  if [ "$OS" = "Darwin" ] && [ ! -x "$BIN" ]; then
    chmod 755 "$BIN" 2>/dev/null || fail runtime-damaged "runtime is not executable and chmod failed"
    note "runtime: exec bit was missing, restored with chmod 755"
  fi
}

# Same candidates and order as findSystemNode: fixed paths, then PATH.
find_system_node() {
  local c d IFS
  if [ -n "${GAFFER_START_TEST_NODE_CANDIDATES+set}" ]; then
    IFS=':'; set -- $GAFFER_START_TEST_NODE_CANDIDATES; unset IFS
  else
    set -- /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node
  fi
  for c in "$@"; do
    [ -n "$c" ] && [ -e "$c" ] && { echo "$c"; return 0; }
  done
  IFS=':'
  for d in $PATH; do
    [ -n "$d" ] || continue
    c="${d%/}/node"
    [ -e "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

# Decision D7: the original CA bundle goes on as GAFFER_CLAUDE_EXTRA_CA_CERTS
# so the chat handler can restore it for the claude child only.
if [ -n "$NODE_EXTRA_CA_CERTS" ] && [ -z "${GAFFER_CLAUDE_EXTRA_CA_CERTS+set}" ]; then
  export GAFFER_CLAUDE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS"
fi

DEV=""
[ -e "$DIR/../../.git" ] && DEV=1

if [ -z "$DEV" ] && [ -e "$BIN" ]; then
  check_runtime
  NODE="$BIN"; ENTRY="daemon.mjs"; KIND="runtime"
else
  if [ -n "$DEV" ]; then
    note "runtime: dev install, using the system node with index.js"
  else
    note "runtime: no bundled runtime at $BIN, probing for a system node"
  fi
  NODE="$(find_system_node)" || fail runtime-missing "no bundled runtime and no system node found"
  # A dev checkout runs its live sources; a packaged tree prefers the bundle.
  if [ -z "$DEV" ] && [ -e "$BUNDLE" ]; then ENTRY="daemon.mjs"; else ENTRY="index.js"; fi
  KIND="node"
fi

note "launching daemon via $KIND: $NODE $ENTRY (cwd $DIR)"
# env -u: NODE_OPTIONS / NODE_PATH / NODE_EXTRA_CA_CERTS could inject code or
# flags, pull modules from a system Node tree, or change TLS trust. Background
# job of a non-interactive shell: stdin is /dev/null, stdout and stderr go to
# the log, so the caller's pipe is never inherited.
env -u NODE_OPTIONS -u NODE_PATH -u NODE_EXTRA_CA_CERTS nohup "$NODE" "$ENTRY" >> "$LOG" 2>&1 &
echo "pid:$! $KIND"
