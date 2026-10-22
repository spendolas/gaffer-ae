#!/bin/bash
# End-to-end test for panel/daemon/update.sh against a scratch install.
#
# Builds a fake release asset from the committed tree with
# scripts/package-release.sh, lays down a v0.10.8 install (git commit
# ce16c2f) under a path WITH A SPACE (real installs live under
# "Application Support"), seeds user data, runs the working-tree update.sh
# from inside that install with GAFFER_UPDATE_ASSET pointing at the asset,
# and checks the result. A second case feeds it a broken download and checks
# that nothing in the install changed.
#
# Further cases cover the single-updater lock: a second updater exits busy
# while a live one holds the lock (also when that one was started by hand as
# "cd daemon; bash update.sh"; a my-update.sh holder is not an updater), an
# abandoned lock (dead pid) is taken over (a stale takeover marker is cleared
# on the way, a fresh one means busy, two updaters clearing the same stale
# marker yield one winner, a fresh marker renamed by mistake is put back), a
# live holder whose lock is older than the stuck age is stopped together
# with its child and grandchild and taken over, both when it leads its own
# process group and when it does not (the stuck age is lowered to 3 s with
# GAFFER_UPDATE_TEST_STUCK_AFTER and the lock aged for real, because a
# holder younger than its lock is a reused pid), a holder started after the
# lock was written is a reused pid, not stopped, its lock abandoned, a lock
# dated in the future with a live holder is busy (the holder is not
# stopped) while one with a dead pid is taken over, a lock dated within the
# 300 s skew tolerance is young, a holder that vanished just before the stop
# is not signalled, a seconds-old lock with no pid yet counts as busy while
# an older one without a pid is taken over, two updaters taking over the
# same stale lock yield exactly one winner (the gated one is rejected by the
# re-read inside the mutex and leaves the winner's lock alone), an updater
# whose lock was replaced under it leaves the replacement alone on exit, the
# lock is gone after success and after a failure, a broken download ends the
# log with err:download, an unwritable panel dir ends it with err:sync, the
# stuck-age knob is ignored without GAFFER_UPDATE_ASSET, at 0 and at a huge
# value (no crash), and the dev-install refusal still ends the log with
# err:dev-install. The races are made deterministic with the script's
# GAFFER_UPDATE_TEST_*_GATE files, never with sleeps.
#
# Runtime cases (zero-dependency install, spec sections 6 to 8): the release
# asset is repacked with FAKE runtime pins (a tiny shell script stands in for
# the Node binary) and fetch-runtime.sh's GAFFER_FETCH_TEST seams serve it
# from file:// folders, so no case touches nodejs.org, codesign or sysctl
# (the new cases avoid macOS-only tools, but CI does not run this harness;
# it is run by hand, on macOS so far). Two installs have accented folder
# names, like real paths can. Covered: an old-layout install (v0.10.8,
# node_modules, no runtime) gets its runtime provisioned and node_modules
# removed by the sync; runtime unchanged (no download attempted, the binary's
# hash and mtime unchanged through rsync --delete); runtime changed (new
# pins); a failed stage ends with err:runtime and leaves the install byte
# for byte as it was, daemon never stopped; an updater killed between the two
# swap renames is recovered by the next run; runtime.old restored at start
# (and a damaged one is not); an archive without daemon/daemon.mjs (pre-bundle
# layout) is refused; repair (update.sh --repair, the panel's Repair button)
# at the same version downloads a current runtime again and swaps in a fresh
# folder, a damaged runtime at the same version is re-provisioned by a plain
# update (stamp check), a repair whose download fails ends with err:runtime
# and leaves the install untouched; the shipped v0.11.3 updater still accepts the new
# archive (index.js shim, npm with no dependencies; a missing v0.11.3 tag
# or npm is a FAILURE unless GAFFER_TEST_ALLOW_NO_TAG=1, so ALL PASS never
# hides that case; scripts/updater-scripts.test.mjs checks the same in CI).
# GAFFER_TEST_REAL_RUNTIME=1 (off by default, macOS only, about 54 MB) adds
# one integration case that provisions the REAL pinned runtime from
# nodejs.org with the signature check on.
#
# update.sh stops whatever listens on port 9823, so this refuses to run while
# a Gaffer daemon is up. Close the Gaffer panel (or get the owner's OK to stop
# the daemon) first. To run next to a live daemon without touching it, set
# GAFFER_TEST_SHIM_DAEMON_STOP=1: the updater then runs with no-op lsof/pkill
# shims on its PATH, so its stop_daemon finds nothing to stop. Everything else
# (download, rsync, npm install, lock) is exercised for real.
#
# Usage (from the repo root): bash scripts/test-update-sh.sh
#   or: GAFFER_TEST_SHIM_DAEMON_STOP=1 bash scripts/test-update-sh.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OLD_REF="ce16c2f"   # release: v0.10.8
FAILS=0
SHIM_DAEMON_STOP="${GAFFER_TEST_SHIM_DAEMON_STOP:-}"

fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }
pass() { echo "PASS: $*"; }

if [ -z "$SHIM_DAEMON_STOP" ] && lsof -nP -iTCP:9823 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "ABORT: something is listening on port 9823 (a running Gaffer daemon)."
  echo "update.sh would stop it. Close the Gaffer panel first, then re-run,"
  echo "or re-run with GAFFER_TEST_SHIM_DAEMON_STOP=1 to leave the daemon alone."
  exit 2
fi

if ! grep -q 'GAFFER_UPDATE_ASSET' "$REPO_ROOT/panel/daemon/update.sh"; then
  echo "FAIL: panel/daemon/update.sh does not honor GAFFER_UPDATE_ASSET (still the main-archive updater)"
  exit 1
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-update-test-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export TMPDIR="$SCRATCH/tmp"
mkdir -p "$TMPDIR"

# Run update.sh with the PATH an end user's CEP-spawned update gets, not the
# developer's: system dirs only, plus the directory of this machine's node so
# npm still resolves. On a Mac that puts /usr/bin/rsync (openrsync) first,
# which is the rsync real installs use; a Homebrew rsync on the developer PATH
# would hide openrsync-only problems.
NODE_BIN_DIR="$(dirname "$(command -v node)")"
UPDATE_PATH="/usr/bin:/bin:/usr/sbin:/sbin:$NODE_BIN_DIR"
RSYNC_IN_USE="$(PATH="$UPDATE_PATH" command -v rsync || true)"
echo "update.sh will run with PATH=$UPDATE_PATH (rsync: ${RSYNC_IN_USE:-none})"
if [ "$RSYNC_IN_USE" != "/usr/bin/rsync" ]; then
  echo "WARN: rsync does not resolve to /usr/bin/rsync under the pinned PATH"
fi
if [ -n "$SHIM_DAEMON_STOP" ]; then
  # No-op lsof (prints nothing, exit 1 = no listener) and pkill, ahead of the
  # real ones, so update.sh's stop_daemon never reaches a live daemon.
  SHIM_DIR="$SCRATCH/shim"
  mkdir -p "$SHIM_DIR"
  printf '#!/bin/bash\nexit 1\n' > "$SHIM_DIR/lsof"
  printf '#!/bin/bash\nexit 0\n' > "$SHIM_DIR/pkill"
  chmod +x "$SHIM_DIR/lsof" "$SHIM_DIR/pkill"
  UPDATE_PATH="$SHIM_DIR:$UPDATE_PATH"
  echo "GAFFER_TEST_SHIM_DAEMON_STOP set: lsof/pkill shimmed, the live daemon is left alone"
fi

LOCK_DIR="$TMPDIR/gaffer-update.lock"
LOG="$TMPDIR/gaffer-update.log"
tree_hash() { (cd "$1" && find . -path ./daemon/node_modules -prune -o -type f -print0 | sort -z | xargs -0 shasum); }
# A long-lived process whose command line runs a daemon/update.sh, which is
# what the lock's liveness check looks for. Like a real stuck updater it has
# a long-lived child (its curl, rsync or npm) which in turn has a child (a
# grandchild sleep), and records their pids in $SCRATCH/fake/child.pid and
# grandchild.pid. Prints its own pid. Modes:
#   (none)   started like a job of this harness: it does NOT lead its own
#            process group, so update.sh must signal its descendants one by one
#   leader   started through perl's setsid(), so it leads its own session and
#            process group like the panel's detached spawn
#   manual   started as "cd daemon; bash update.sh", the command line a person
#            produces by hand (no daemon/ in it)
#   other    a my-update.sh, which must NOT count as an updater
start_fake_updater() {
  local mode="${1:-}" name="update.sh" dir="$SCRATCH/fake/daemon" i
  [ "$mode" = "other" ] && name="my-update.sh"
  mkdir -p "$dir"
  rm -f "$SCRATCH/fake/child.pid" "$SCRATCH/fake/grandchild.pid"
  cat > "$dir/$name" <<EOF
#!/bin/bash
bash -c 'sleep 300 & echo \$! > "$SCRATCH/fake/grandchild.pid"; wait' &
echo \$! > "$SCRATCH/fake/child.pid"
wait
EOF
  case "$mode" in
    leader) perl -e 'use POSIX; POSIX::setsid(); exec @ARGV' bash "$dir/$name" >/dev/null 2>&1 & ;;
    manual) (cd "$dir" && exec bash "$name") >/dev/null 2>&1 & ;;
    *) bash "$dir/$name" >/dev/null 2>&1 & ;;
  esac
  local pid=$!
  for i in $(seq 1 50); do
    [ -s "$SCRATCH/fake/child.pid" ] && [ -s "$SCRATCH/fake/grandchild.pid" ] && break
    sleep 0.1
  done
  echo "$pid"
}
fake_updater_child() { cat "$SCRATCH/fake/child.pid" 2>/dev/null || true; }
fake_updater_grandchild() { cat "$SCRATCH/fake/grandchild.pid" 2>/dev/null || true; }
# Kill the fake updater, its child and grandchild, and give the kernel a beat
# to reap it so kill -0 (the lock's liveness check) no longer sees it.
stop_fake_updater() {
  local gc c
  gc="$(fake_updater_grandchild)"; c="$(fake_updater_child)"
  [ -n "$gc" ] && kill "$gc" 2>/dev/null || true
  [ -n "$c" ] && kill "$c" 2>/dev/null || true
  pkill -P "$1" 2>/dev/null || true
  kill "$1" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
  sleep 0.3
}
# Wait (up to 30s) until a file exists, or until a condition holds.
wait_for_file() {
  local i
  for i in $(seq 1 300); do [ -e "$1" ] && return 0; sleep 0.1; done
  fail "timed out waiting for $1"; return 1
}
wait_until() {
  local i
  for i in $(seq 1 300); do eval "$1" && return 0; sleep 0.1; done
  fail "timed out waiting until: $1"; return 1
}
count_in_log() { grep -c -- "$1" "$LOG" 2>/dev/null || true; }
# The stuck cases run update.sh with the 15 minute stuck age lowered to this
# and let the lock age for real: a holder younger than its lock is a reused
# pid to update.sh now, so a backdated lock would be abandoned, not stopped.
STUCK_AFTER=3
age_lock_past_stuck() { sleep $((STUCK_AFTER + 1)); }

# Fake release asset from the committed tree. The bundle's npm audit needs
# the network; the harness skips it unless the caller says otherwise.
(cd "$REPO_ROOT" && GAFFER_SKIP_AUDIT="${GAFFER_SKIP_AUDIT:-1}" bash scripts/package-release.sh 9.9.9 feedfacecafe "$SCRATCH/dist" >/dev/null)
REAL_ASSET="$SCRATCH/dist/gaffer-update-mac.tar.gz"

# ---------- Fake runtimes ----------
# make_fake_runtime <version>: a node-<v>-darwin-x64.tar.gz whose bin/node is
# a shell script printing <version>, served from $SRV, plus a pins file for
# it at $SCRATCH/pins-<version>.json. Portable: tar, shasum and wc only.
FAKE_PLAT="darwin-x64"
SRV="$SCRATCH/srv"
NOWHERE="file://$SCRATCH/nowhere/"
mkdir -p "$SRV"
make_fake_runtime() {
  local ver="$1" top build bytes bsha asha
  top="node-$ver-$FAKE_PLAT"
  build="$SCRATCH/build-$ver"
  mkdir -p "$build/$top/bin"
  printf '#!/bin/sh\necho %s\n' "$ver" > "$build/$top/bin/node"
  chmod 755 "$build/$top/bin/node"
  echo "not extracted" > "$build/$top/README.md"
  COPYFILE_DISABLE=1 tar -czf "$SRV/$top.tar.gz" -C "$build" "$top"
  bytes="$(wc -c < "$build/$top/bin/node" | tr -d ' ')"
  bsha="$(shasum -a 256 "$build/$top/bin/node" | awk '{print $1}')"
  asha="$(shasum -a 256 "$SRV/$top.tar.gz" | awk '{print $1}')"
  cat > "$SCRATCH/pins-$ver.json" <<EOF
{
  "node": {
    "version": "$ver",
    "codename": "Test",
    "official": "https://example.invalid/official/",
    "mirror": "https://example.invalid/mirror/",
    "platforms": {
      "$FAKE_PLAT": { "archive": "$top.tar.gz", "archiveSha256": "$asha", "member": "$top/bin/node", "binaryBytes": $bytes, "binarySha256": "$bsha" }
    },
    "signing": { "darwinTeamId": "TESTTEAMID", "windowsSigner": "Test" }
  }
}
EOF
}
RT_V1="v90.0.1"
RT_V2="v90.0.2"
make_fake_runtime "$RT_V1"
make_fake_runtime "$RT_V2"
# repack_asset <pins> <out> [drop-path]: the real asset with its
# daemon/runtime-pins.json replaced (and optionally one path removed).
repack_asset() {
  local dir="$SCRATCH/repack-$$-$RANDOM"
  mkdir -p "$dir"
  tar -xzf "$REAL_ASSET" -C "$dir"
  cp "$1" "$dir/daemon/runtime-pins.json"
  [ -z "${3:-}" ] || rm -rf "$dir/$3"
  COPYFILE_DISABLE=1 tar -czf "$2" -C "$dir" .
  rm -rf "$dir"
}
ASSET="$SCRATCH/dist/gaffer-update-v1.tar.gz"
ASSET_V2="$SCRATCH/dist/gaffer-update-v2.tar.gz"
ASSET_NO_BUNDLE="$SCRATCH/dist/gaffer-update-no-bundle.tar.gz"
repack_asset "$SCRATCH/pins-$RT_V1.json" "$ASSET"
repack_asset "$SCRATCH/pins-$RT_V2.json" "$ASSET_V2"
repack_asset "$SCRATCH/pins-$RT_V1.json" "$ASSET_NO_BUNDLE" daemon/daemon.mjs
# Every updater run below inherits these: the archive's fetch-runtime.sh
# fetches the fake runtimes from $SRV, never from the network, and skips the
# Apple signature check (the fake binary is a shell script).
export GAFFER_FETCH_TEST=1
export GAFFER_FETCH_PLATFORM="$FAKE_PLAT"
export GAFFER_FETCH_SKIP_CODESIGN=1
export GAFFER_FETCH_BASE_OFFICIAL="file://$SRV/"
export GAFFER_FETCH_BASE_MIRROR="file://$SRV/"
# Nothing from npm (the v0.11.3 updater case) lands in the home directory.
export npm_config_cache="$SCRATCH/npm-cache"
export npm_config_userconfig="$SCRATCH/npm-cache/no-userconfig"
export npm_config_update_notifier=false
export npm_config_audit=false
export npm_config_fund=false

file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
file_sha() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
full_tree_hash() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 shasum); }
# seed_runtime <install> <version>: a provisioned runtime, as fetch-runtime.sh
# (the repo copy) leaves it after a full run.
seed_runtime() {
  GAFFER_FETCH_PINS="$SCRATCH/pins-$2.json" bash "$REPO_ROOT/panel/daemon/fetch-runtime.sh" --into "$1/daemon" > "$SCRATCH/seed.out" 2>&1 \
    || { echo "harness: could not seed a runtime:"; cat "$SCRATCH/seed.out"; exit 1; }
}

new_install() {
  local dir="$1"
  mkdir -p "$dir"
  (cd "$REPO_ROOT" && git archive "$OLD_REF:panel") | tar -x -C "$dir"
  # An old install's dependency tree (0.11.x and earlier ran npm install).
  # The sync no longer excludes it, so it must be gone after an update.
  mkdir -p "$dir/daemon/node_modules/ws/lib"
  echo '{"name":"ws"}' > "$dir/daemon/node_modules/ws/package.json"
  echo 'module.exports = 1;' > "$dir/daemon/node_modules/ws/lib/index.js"
  # The update.sh under test is the WORKING TREE copy
  cp "$REPO_ROOT/panel/daemon/update.sh" "$dir/daemon/update.sh"
  echo '{"messages":["legacy"]}' > "$dir/chat-history.json"
  echo '{"messages":["ae26"]}' > "$dir/chat-history-26.0.json"
  echo '{"installId":"legacy"}' > "$dir/.gaffer-config.json"
  echo '[{"event":"unsent"}]' > "$dir/.gaffer-usage-buffer.json"
  mkdir -p "$dir/.gaffer-icons"
  echo '<svg id="cached"/>' > "$dir/.gaffer-icons/notion.svg"
  echo 'stale' > "$dir/stale-file-from-old-release.txt"
}

# ---------- Case 1: a good release asset ----------
INSTALL="$SCRATCH/Application Support/com.gaffer.panel"
new_install "$INSTALL"
(cd "$INSTALL" && shasum chat-history.json chat-history-26.0.json .gaffer-config.json .gaffer-usage-buffer.json .gaffer-icons/notion.svg) > "$SCRATCH/user-data.sha"

if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$INSTALL/daemon/update.sh"; then
  pass "update.sh exited 0"
else
  fail "update.sh exited non-zero (log: $TMPDIR/gaffer-update.log)"
  cat "$TMPDIR/gaffer-update.log" || true
fi

if [ "$(cat "$INSTALL/version.json")" = "$(tar -xzOf "$ASSET" ./version.json)" ]; then
  pass "version.json is the release's stamped file"
else
  fail "version.json is not the release's: $(cat "$INSTALL/version.json")"
fi

if (cd "$INSTALL" && shasum -c "$SCRATCH/user-data.sha" >/dev/null 2>&1); then
  pass "chat history, legacy config, usage buffer and icon cache preserved byte for byte"
else
  fail "user data changed:"; (cd "$INSTALL" && shasum -c "$SCRATCH/user-data.sha") || true
fi

# daemon/test and daemon/test-fixtures shipped with releases up to v0.11.2,
# daemon/node_modules with every release up to 0.11.x; all are absent from
# the asset now, so rsync --delete must remove them.
for junk in gaffer.tar.gz gaffer.zip gaffer-update-mac.tar.gz extract version.json.tmp stale-file-from-old-release.txt daemon/test daemon/test-fixtures daemon/node_modules daemon/runtime.new daemon/runtime.old; do
  if [ -e "$INSTALL/$junk" ]; then fail "$junk left in the panel dir"; else pass "no $junk in the panel dir"; fi
done
# The old-layout install had no runtime: the update provisions it.
if [ "$(cat "$INSTALL/daemon/runtime/VERSION" 2>/dev/null)" = "$RT_V1 $FAKE_PLAT" ] && [ "$("$INSTALL/daemon/runtime/node" --version 2>/dev/null)" = "$RT_V1" ]; then
  pass "old-layout install got the pinned runtime ($RT_V1 $FAKE_PLAT)"
else
  fail "old-layout install has no working runtime (VERSION: $(cat "$INSTALL/daemon/runtime/VERSION" 2>/dev/null || echo missing))"
fi
if [ -f "$INSTALL/daemon/runtime/VERIFIED" ] && [ "$(awk '{print $1}' "$INSTALL/daemon/runtime/VERIFIED")" = "$(wc -c < "$INSTALL/daemon/runtime/node" | tr -d ' ')" ]; then pass "runtime VERIFIED stamp matches the binary size"; else fail "runtime VERIFIED stamp missing or wrong"; fi
if grep -q "^runtime:installed $RT_V1 $FAKE_PLAT$" "$LOG" && [ -f "$INSTALL/daemon/daemon.mjs" ]; then pass "log records the staged runtime and daemon.mjs landed"; else fail "no runtime:installed line or no daemon.mjs"; fi

if tar -xzOf "$ASSET" ./main.js | cmp -s - "$INSTALL/main.js" && [ -f "$INSTALL/daemon/index.js" ]; then
  pass "release files landed (main.js matches the asset)"
else
  fail "main.js in the install does not match the asset"
fi

NEWER="$(find "$INSTALL" -type f -newer "$INSTALL/version.json" | head -5)"
if [ -z "$NEWER" ]; then
  pass "version.json is the newest file in the panel dir (written last)"
else
  fail "files written after version.json: $NEWER"
fi

if [ "$(tail -n1 "$TMPDIR/gaffer-update.log")" = "ok:9.9.9" ]; then pass "log ends with ok:9.9.9"; else fail "last log line is not ok:9.9.9: $(tail -n1 "$TMPDIR/gaffer-update.log")"; fi
if ls "$TMPDIR" | grep -q '^gaffer-update-[0-9]'; then fail "temp dir not cleaned up"; else pass "temp dir cleaned up"; fi
if [ -e "$LOCK_DIR" ]; then fail "update lock left behind after success"; else pass "update lock released after success"; fi

# ---------- Case 2: a broken download changes nothing ----------
BROKEN_INSTALL="$SCRATCH/Application Support/broken/com.gaffer.panel"
new_install "$BROKEN_INSTALL"
echo '<html>Not Found</html>' > "$SCRATCH/not-a-release.tar.gz"
BEFORE="$(cd "$BROKEN_INSTALL" && find . -path ./daemon/node_modules -prune -o -type f -print0 | sort -z | xargs -0 shasum)"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$SCRATCH/not-a-release.tar.gz" bash "$BROKEN_INSTALL/daemon/update.sh"; then
  fail "update.sh exited 0 on a broken download"
else
  pass "update.sh exited non-zero on a broken download"
fi
AFTER="$(cd "$BROKEN_INSTALL" && find . -path ./daemon/node_modules -prune -o -type f -print0 | sort -z | xargs -0 shasum)"
if [ "$BEFORE" = "$AFTER" ]; then pass "broken download left the install untouched"; else fail "broken download modified the install"; fi
if [ -e "$LOCK_DIR" ]; then fail "update lock left behind after a failed update"; else pass "update lock released after a failed update"; fi
# tar's own complaint must not be the last line: the panel reads ok:/err:.
if [ "$(tail -n1 "$LOG")" = "err:download" ]; then pass "broken download ends the log with err:download"; else fail "broken download last log line: $(tail -n1 "$LOG")"; fi
if grep -q "^ERROR: download or extract failed" "$LOG"; then pass "broken download logs an ERROR line"; else fail "no ERROR line for the broken download"; fi

# ---------- Case 2b: a failing rsync ends the log with err:sync ----------
# The panel dir is made unwritable, so rsync can neither delete the stale
# file nor create new ones; under plain set -e rsync's own complaint would
# be the last log line.
# Root ignores directory permissions, so the case cannot fail rsync there.
if [ "$(id -u)" = "0" ]; then
  echo "SKIP: case 2b (running as root, chmod a-w does not stop rsync)"
else
SYNC_INSTALL="$SCRATCH/Application Support/sync-fail/com.gaffer.panel"
new_install "$SYNC_INSTALL"
: > "$LOG"
chmod a-w "$SYNC_INSTALL"
set +e
PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$SYNC_INSTALL/daemon/update.sh"
SYNC_EXIT=$?
set -e
chmod u+w "$SYNC_INSTALL"
if [ "$SYNC_EXIT" -eq 1 ]; then pass "update.sh exited 1 when rsync failed"; else fail "update.sh exited $SYNC_EXIT when rsync failed, expected 1"; fi
if [ "$(tail -n1 "$LOG")" = "err:sync" ]; then pass "failed rsync ends the log with err:sync"; else fail "failed rsync last log line: $(tail -n1 "$LOG")"; fi
if grep -q "^ERROR: replacing the panel files failed (rsync)" "$LOG"; then pass "failed rsync logs an ERROR line"; else fail "no ERROR line for the failed rsync"; fi
if [ -e "$LOCK_DIR" ]; then fail "update lock left behind after the failed rsync"; else pass "update lock released after the failed rsync"; fi
fi

# ---------- Case R1: runtime unchanged, no download, the binary untouched by rsync --delete ----------
# The installed runtime matches the archive's pins. The download bases point
# nowhere, so any download attempt would fail the run with err:runtime.
RT_SAME="$SCRATCH/Application Support/rt-sàme/com.gaffer.panel"
new_install "$RT_SAME"
seed_runtime "$RT_SAME" "$RT_V1"
RT_SHA_BEFORE="$(file_sha "$RT_SAME/daemon/runtime/node")"
RT_MTIME_BEFORE="$(file_mtime "$RT_SAME/daemon/runtime/node")"
RT_STAMPS_BEFORE="$(cat "$RT_SAME/daemon/runtime/VERSION" "$RT_SAME/daemon/runtime/VERIFIED")"
sleep 1   # an rsync rewrite would now show as a newer mtime
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" GAFFER_FETCH_BASE_OFFICIAL="$NOWHERE" GAFFER_FETCH_BASE_MIRROR="$NOWHERE" bash "$RT_SAME/daemon/update.sh"; then
  pass "runtime unchanged: update.sh exited 0"
else
  fail "runtime unchanged: update.sh failed (log: $(tail -n5 "$LOG" | tr '\n' '|'))"
fi
if [ "$(tail -n1 "$LOG")" = "ok:9.9.9" ]; then pass "runtime unchanged: log ends with ok:9.9.9"; else fail "runtime unchanged: last log line: $(tail -n1 "$LOG")"; fi
if grep -q '^runtime:current$' "$LOG"; then pass "runtime unchanged: log records runtime:current"; else fail "runtime unchanged: no runtime:current line"; fi
if grep -q 'runtime: downloading\|runtime: need ' "$LOG"; then fail "runtime unchanged: a download was attempted"; else pass "runtime unchanged: no download attempted"; fi
if [ "$(file_sha "$RT_SAME/daemon/runtime/node")" = "$RT_SHA_BEFORE" ] && [ "$(file_mtime "$RT_SAME/daemon/runtime/node")" = "$RT_MTIME_BEFORE" ]; then
  pass "runtime unchanged: binary hash and mtime unchanged (survived rsync --delete)"
else
  fail "runtime unchanged: the binary was rewritten or removed"
fi
if [ "$(cat "$RT_SAME/daemon/runtime/VERSION" "$RT_SAME/daemon/runtime/VERIFIED" 2>/dev/null)" = "$RT_STAMPS_BEFORE" ]; then pass "runtime unchanged: VERSION and VERIFIED kept"; else fail "runtime unchanged: stamps changed"; fi
if [ -e "$RT_SAME/daemon/node_modules" ]; then fail "runtime unchanged: old node_modules survived the sync"; else pass "runtime unchanged: old node_modules removed by the sync"; fi

# ---------- Case R2: runtime changed (new pins) is staged, swapped and cleaned up ----------
RT_NEWPIN="$SCRATCH/Application Support/rt-new/com.gaffer.panel"
new_install "$RT_NEWPIN"
seed_runtime "$RT_NEWPIN" "$RT_V1"
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET_V2" bash "$RT_NEWPIN/daemon/update.sh"; then
  pass "runtime changed: update.sh exited 0"
else
  fail "runtime changed: update.sh failed (log: $(tail -n5 "$LOG" | tr '\n' '|'))"
fi
if [ "$(tail -n1 "$LOG")" = "ok:9.9.9" ]; then pass "runtime changed: log ends with ok:9.9.9"; else fail "runtime changed: last log line: $(tail -n1 "$LOG")"; fi
if [ "$(cat "$RT_NEWPIN/daemon/runtime/VERSION" 2>/dev/null)" = "$RT_V2 $FAKE_PLAT" ] && [ "$("$RT_NEWPIN/daemon/runtime/node" --version 2>/dev/null)" = "$RT_V2" ]; then
  pass "runtime changed: the new runtime ($RT_V2) is in place"
else
  fail "runtime changed: runtime is not $RT_V2 (VERSION: $(cat "$RT_NEWPIN/daemon/runtime/VERSION" 2>/dev/null || echo missing))"
fi
if [ ! -e "$RT_NEWPIN/daemon/runtime.new" ] && [ ! -e "$RT_NEWPIN/daemon/runtime.old" ]; then pass "runtime changed: no runtime.new or runtime.old left"; else fail "runtime changed: runtime.new or runtime.old left behind"; fi
# Staged while the daemon still ran: the stage line comes before the stop.
STAGE_LINE="$(grep -n "^runtime:installed $RT_V2" "$LOG" | head -1 | cut -d: -f1 || true)"
STOP_LINE="$(grep -n '^Stopping daemon' "$LOG" | head -1 | cut -d: -f1 || true)"
if [ -n "$STAGE_LINE" ] && [ -n "$STOP_LINE" ] && [ "$STAGE_LINE" -lt "$STOP_LINE" ]; then pass "runtime changed: staged before the daemon was stopped"; else fail "runtime changed: stage line $STAGE_LINE, stop line $STOP_LINE"; fi
NEWER="$(find "$RT_NEWPIN" -type f -newer "$RT_NEWPIN/version.json" | head -5)"
if [ -z "$NEWER" ]; then pass "runtime changed: version.json still written last"; else fail "runtime changed: files written after version.json: $NEWER"; fi

# ---------- Case R3: a failed stage ends with err:runtime and leaves the install untouched ----------
RT_FAIL="$SCRATCH/Application Support/rt-fàil/com.gaffer.panel"
new_install "$RT_FAIL"
seed_runtime "$RT_FAIL" "$RT_V1"
BEFORE="$(full_tree_hash "$RT_FAIL")"
: > "$LOG"
set +e
PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET_V2" GAFFER_FETCH_BASE_OFFICIAL="$NOWHERE" GAFFER_FETCH_BASE_MIRROR="$NOWHERE" bash "$RT_FAIL/daemon/update.sh"
RT_FAIL_EXIT=$?
set -e
if [ "$RT_FAIL_EXIT" -eq 1 ]; then pass "stage failure: update.sh exited 1"; else fail "stage failure: update.sh exited $RT_FAIL_EXIT, expected 1"; fi
if [ "$(tail -n1 "$LOG")" = "err:runtime" ]; then pass "stage failure: log ends with err:runtime"; else fail "stage failure: last log line: $(tail -n1 "$LOG")"; fi
if grep -q '^ERROR: ' "$LOG"; then pass "stage failure: logs an ERROR line"; else fail "stage failure: no ERROR line"; fi
if [ "$BEFORE" = "$(full_tree_hash "$RT_FAIL")" ]; then pass "stage failure: install byte for byte unchanged (runtime and node_modules included)"; else fail "stage failure: the install changed"; fi
if [ -e "$RT_FAIL/daemon/runtime.new" ]; then fail "stage failure: runtime.new left behind"; else pass "stage failure: no runtime.new left"; fi
if grep -q '^Stopping daemon' "$LOG"; then fail "stage failure: the daemon was stopped although nothing was installed"; else pass "stage failure: the daemon was never stopped"; fi
if [ -e "$LOCK_DIR" ]; then fail "stage failure: lock left behind"; else pass "stage failure: lock released"; fi

# ---------- Case R4: an updater killed between the two swap renames is recovered ----------
# GAFFER_UPDATE_TEST_SWAP_GATE holds the updater right after runtime ->
# runtime.old; it is then killed with SIGKILL (no trap runs). The next run
# must put runtime.old back first, then update normally.
RT_KILL="$SCRATCH/Application Support/rt-kill/com.gaffer.panel"
new_install "$RT_KILL"
seed_runtime "$RT_KILL" "$RT_V1"
: > "$LOG"
rm -f "$SCRATCH/gate-swap" "$SCRATCH/gate-swap.ready"
( PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET_V2" GAFFER_UPDATE_TEST_SWAP_GATE="$SCRATCH/gate-swap" bash "$RT_KILL/daemon/update.sh" ) &
SWAP_SUB=$!
if wait_for_file "$SCRATCH/gate-swap.ready"; then
  SWAP_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  [ -n "$SWAP_PID" ] && kill -KILL "$SWAP_PID" 2>/dev/null || true
fi
wait "$SWAP_SUB" 2>/dev/null || true
rm -rf "$TMPDIR/gaffer-update-${SWAP_PID:-none}"
if [ ! -e "$RT_KILL/daemon/runtime" ] && [ -f "$RT_KILL/daemon/runtime.old/node" ]; then pass "killed mid-swap: runtime moved aside, not yet replaced"; else fail "killed mid-swap: unexpected state ($(ls "$RT_KILL/daemon" | grep runtime | tr '\n' ' ' || true))"; fi
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET_V2" bash "$RT_KILL/daemon/update.sh"; then
  pass "after a mid-swap kill: the next update exited 0"
else
  fail "after a mid-swap kill: the next update failed (log: $(tail -n5 "$LOG" | tr '\n' '|'))"
fi
if grep -q 'Restoring daemon/runtime from runtime.old' "$LOG"; then pass "after a mid-swap kill: runtime.old was put back first"; else fail "after a mid-swap kill: no restore line in the log"; fi
if [ "$(cat "$RT_KILL/daemon/runtime/VERSION" 2>/dev/null)" = "$RT_V2 $FAKE_PLAT" ] && [ ! -e "$RT_KILL/daemon/runtime.old" ] && [ ! -e "$RT_KILL/daemon/runtime.new" ]; then
  pass "after a mid-swap kill: runtime $RT_V2 in place, no leftovers"
else
  fail "after a mid-swap kill: runtime state wrong ($(ls "$RT_KILL/daemon" | grep runtime | tr '\n' ' ' || true))"
fi
rm -rf "$LOCK_DIR"

# ---------- Case R4b: runtime.old with no runtime is restored without a download ----------
RT_RESTORE="$SCRATCH/Application Support/rt-restore/com.gaffer.panel"
new_install "$RT_RESTORE"
seed_runtime "$RT_RESTORE" "$RT_V1"
RT_SHA_BEFORE="$(file_sha "$RT_RESTORE/daemon/runtime/node")"
mv "$RT_RESTORE/daemon/runtime" "$RT_RESTORE/daemon/runtime.old"
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" GAFFER_FETCH_BASE_OFFICIAL="$NOWHERE" GAFFER_FETCH_BASE_MIRROR="$NOWHERE" bash "$RT_RESTORE/daemon/update.sh"; then
  pass "runtime.old restore: update.sh exited 0 with no download possible"
else
  fail "runtime.old restore: update.sh failed (log: $(tail -n5 "$LOG" | tr '\n' '|'))"
fi
if [ "$(file_sha "$RT_RESTORE/daemon/runtime/node")" = "$RT_SHA_BEFORE" ] && [ ! -e "$RT_RESTORE/daemon/runtime.old" ]; then pass "runtime.old restore: the same binary is back at runtime/node"; else fail "runtime.old restore: runtime not restored"; fi

# ---------- Case R4c: a damaged runtime.old is not restored, a fresh runtime is provisioned ----------
RT_DAMAGED="$SCRATCH/Application Support/rt-damaged/com.gaffer.panel"
new_install "$RT_DAMAGED"
seed_runtime "$RT_DAMAGED" "$RT_V1"
mv "$RT_DAMAGED/daemon/runtime" "$RT_DAMAGED/daemon/runtime.old"
printf '#!/bin/sh\n' > "$RT_DAMAGED/daemon/runtime.old/node"   # truncated
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$RT_DAMAGED/daemon/update.sh"; then
  pass "damaged runtime.old: update.sh exited 0"
else
  fail "damaged runtime.old: update.sh failed (log: $(tail -n5 "$LOG" | tr '\n' '|'))"
fi
if grep -q 'Restoring daemon/runtime from runtime.old' "$LOG"; then fail "damaged runtime.old: it was restored"; else pass "damaged runtime.old: not restored"; fi
if [ "$("$RT_DAMAGED/daemon/runtime/node" --version 2>/dev/null)" = "$RT_V1" ] && [ ! -e "$RT_DAMAGED/daemon/runtime.old" ]; then pass "damaged runtime.old: a fresh runtime was provisioned and runtime.old removed"; else fail "damaged runtime.old: runtime state wrong ($(ls "$RT_DAMAGED/daemon" | grep runtime | tr '\n' ' ' || true))"; fi

# ---------- Case R6: repair (--repair, the panel's Repair button) at the same version ----------
# The runtime is current, yet --repair downloads it again (fetch-runtime.sh
# --force) and swaps in a fresh folder; the release's files are synced and
# version.json keeps its content.
RT_REPAIR="$SCRATCH/Application Support/rt-répair/com.gaffer.panel"
new_install "$RT_REPAIR"
seed_runtime "$RT_REPAIR" "$RT_V1"
tar -xzf "$ASSET" -C "$SCRATCH" ./version.json 2>/dev/null || tar -xzf "$ASSET" -C "$SCRATCH" version.json
cp "$SCRATCH/version.json" "$RT_REPAIR/version.json"
VER_BEFORE="$(file_sha "$RT_REPAIR/version.json")"
echo old > "$RT_REPAIR/daemon/runtime/old-folder-marker.txt"
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$RT_REPAIR/daemon/update.sh" --repair; then
  pass "repair: update.sh --repair exited 0"
else
  fail "repair: update.sh --repair failed (log: $(tail -n5 "$LOG" | tr '\n' '|'))"
fi
if [ "$(tail -n1 "$LOG")" = "ok:9.9.9" ]; then pass "repair: log ends with ok:9.9.9"; else fail "repair: last log line: $(tail -n1 "$LOG")"; fi
if grep -q '^Repair mode: ' "$LOG" && grep -q '^runtime: --force: re-provisioning' "$LOG"; then pass "repair: logged, and fetch-runtime.sh ran with --force"; else fail "repair: no repair or --force line in the log"; fi
if [ ! -e "$RT_REPAIR/daemon/runtime/old-folder-marker.txt" ] && [ "$("$RT_REPAIR/daemon/runtime/node" --version 2>/dev/null)" = "$RT_V1" ] && [ ! -e "$RT_REPAIR/daemon/runtime.old" ] && [ ! -e "$RT_REPAIR/daemon/runtime.new" ]; then
  pass "repair: a fresh runtime folder is in place, no leftovers"
else
  fail "repair: runtime state wrong ($(ls "$RT_REPAIR/daemon/runtime" | tr '\n' ' ' || true))"
fi
if [ "$(file_sha "$RT_REPAIR/version.json")" = "$VER_BEFORE" ]; then pass "repair: version.json content unchanged (same release)"; else fail "repair: version.json changed"; fi
if [ -e "$LOCK_DIR" ]; then fail "repair: lock left behind"; else pass "repair: lock released"; fi

# ---------- Case R7: a damaged runtime at the same version, plain update ----------
# No --repair: the stamp check alone (size against VERIFIED) re-provisions it.
RT_TRUNC="$SCRATCH/Application Support/rt-trunc/com.gaffer.panel"
new_install "$RT_TRUNC"
seed_runtime "$RT_TRUNC" "$RT_V1"
cp "$SCRATCH/version.json" "$RT_TRUNC/version.json"
printf '#!/bin/sh\n' > "$RT_TRUNC/daemon/runtime/node"   # truncated
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$RT_TRUNC/daemon/update.sh" && [ "$(tail -n1 "$LOG")" = "ok:9.9.9" ]; then
  pass "damaged runtime, same version: plain update ends ok:9.9.9"
else
  fail "damaged runtime, same version: last log line: $(tail -n1 "$LOG")"
fi
if [ "$("$RT_TRUNC/daemon/runtime/node" --version 2>/dev/null)" = "$RT_V1" ]; then pass "damaged runtime, same version: the stamp check re-provisioned it"; else fail "damaged runtime, same version: runtime still damaged"; fi

# ---------- Case R8: a repair whose download fails leaves the install untouched ----------
RT_REPFAIL="$SCRATCH/Application Support/rt-repfail/com.gaffer.panel"
new_install "$RT_REPFAIL"
seed_runtime "$RT_REPFAIL" "$RT_V1"
BEFORE="$(full_tree_hash "$RT_REPFAIL")"
: > "$LOG"
set +e
PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" GAFFER_FETCH_BASE_OFFICIAL="$NOWHERE" GAFFER_FETCH_BASE_MIRROR="$NOWHERE" bash "$RT_REPFAIL/daemon/update.sh" --repair
REPFAIL_EXIT=$?
set -e
if [ "$REPFAIL_EXIT" -eq 1 ] && [ "$(tail -n1 "$LOG")" = "err:runtime" ]; then pass "failed repair: exit 1, log ends with err:runtime"; else fail "failed repair: exit $REPFAIL_EXIT, last log line: $(tail -n1 "$LOG")"; fi
if [ "$BEFORE" = "$(full_tree_hash "$RT_REPFAIL")" ]; then pass "failed repair: install byte for byte unchanged"; else fail "failed repair: the install changed"; fi
if grep -q '^Stopping daemon' "$LOG"; then fail "failed repair: the daemon was stopped"; else pass "failed repair: the daemon was never stopped"; fi

# ---------- Case R5: an archive without daemon/daemon.mjs (pre-bundle layout) is refused ----------
RT_NOBUNDLE="$SCRATCH/Application Support/rt-no-bundle/com.gaffer.panel"
new_install "$RT_NOBUNDLE"
BEFORE="$(full_tree_hash "$RT_NOBUNDLE")"
: > "$LOG"
set +e
PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET_NO_BUNDLE" bash "$RT_NOBUNDLE/daemon/update.sh"
NB_EXIT=$?
set -e
if [ "$NB_EXIT" -eq 1 ]; then pass "pre-bundle archive: refused (exit 1)"; else fail "pre-bundle archive: exit $NB_EXIT, expected 1"; fi
if grep -q '^ERROR: downloaded archive is not a Gaffer release (missing version.json or daemon/daemon.mjs)$' "$LOG"; then pass "pre-bundle archive: the ERROR line names daemon/daemon.mjs"; else fail "pre-bundle archive: last lines: $(tail -n2 "$LOG" | tr '\n' '|')"; fi
if [ "$BEFORE" = "$(full_tree_hash "$RT_NOBUNDLE")" ] && [ ! -e "$RT_NOBUNDLE/daemon/runtime" ]; then pass "pre-bundle archive: install untouched"; else fail "pre-bundle archive: install changed"; fi

# ---------- Case 3: a second updater exits busy while a live one holds the lock ----------
BUSY_INSTALL="$SCRATCH/Application Support/busy/com.gaffer.panel"
new_install "$BUSY_INSTALL"
FAKE_PID="$(start_fake_updater)"
# Each command tolerates an already-gone process: under set -e a failing
# command in the EXIT trap would turn an ALL PASS run into exit 1.
trap 'pkill -P "$FAKE_PID" 2>/dev/null || true; kill "$FAKE_PID" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
mkdir -p "$LOCK_DIR" && echo "$FAKE_PID" > "$LOCK_DIR/pid"
BEFORE="$(tree_hash "$BUSY_INSTALL")"
set +e
PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$BUSY_INSTALL/daemon/update.sh"
BUSY_EXIT=$?
set -e
if [ "$BUSY_EXIT" -eq 3 ]; then pass "second updater exited 3 while the lock was held"; else fail "second updater exited $BUSY_EXIT, expected 3"; fi
if [ "$(tail -n1 "$LOG")" = "busy:already-running" ]; then pass "log ends with busy:already-running"; else fail "last log line is not busy:already-running: $(tail -n1 "$LOG")"; fi
if [ "$BEFORE" = "$(tree_hash "$BUSY_INSTALL")" ]; then pass "second updater left the install untouched"; else fail "second updater modified the install"; fi
if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$FAKE_PID" ]; then pass "live lock kept its holder's pid"; else fail "live lock was removed or rewritten"; fi
stop_fake_updater "$FAKE_PID"
rm -rf "$LOCK_DIR"

# ---------- Case 3b: a holder started by hand ("cd daemon; bash update.sh") is an updater too ----------
# Its command line is "bash update.sh", no daemon/ in it.
MANUAL_INSTALL="$SCRATCH/Application Support/manual/com.gaffer.panel"
new_install "$MANUAL_INSTALL"
FAKE_PID="$(start_fake_updater manual)"
trap 'pkill -P "$FAKE_PID" 2>/dev/null || true; kill "$FAKE_PID" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
if ps -o command= -p "$FAKE_PID" | grep -q '^bash update\.sh$'; then pass "manual holder's command line is 'bash update.sh'"; else fail "manual holder's command line is: $(ps -o command= -p "$FAKE_PID")"; fi
mkdir -p "$LOCK_DIR" && echo "$FAKE_PID" > "$LOCK_DIR/pid"
: > "$LOG"
set +e
PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$MANUAL_INSTALL/daemon/update.sh"
MANUAL_EXIT=$?
set -e
if [ "$MANUAL_EXIT" -eq 3 ]; then pass "second updater exited 3 while a hand-started 'bash update.sh' holds the lock"; else fail "second updater exited $MANUAL_EXIT against a hand-started holder, expected 3"; fi
if grep -q "Another update is already running (pid $FAKE_PID)" "$LOG"; then pass "log names the hand-started holder as a running update"; else fail "hand-started holder was not recognised as an updater"; fi
if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$FAKE_PID" ]; then pass "hand-started holder's lock kept its pid"; else fail "hand-started holder's lock was removed or rewritten"; fi
stop_fake_updater "$FAKE_PID"
rm -rf "$LOCK_DIR"

# ---------- Case 3c: a my-update.sh holder is NOT an updater, its lock is abandoned ----------
OTHER_INSTALL="$SCRATCH/Application Support/other-name/com.gaffer.panel"
new_install "$OTHER_INSTALL"
FAKE_PID="$(start_fake_updater other)"
trap 'pkill -P "$FAKE_PID" 2>/dev/null || true; kill "$FAKE_PID" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
mkdir -p "$LOCK_DIR" && echo "$FAKE_PID" > "$LOCK_DIR/pid"
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$OTHER_INSTALL/daemon/update.sh"; then
  pass "update.sh took over a lock held by a live my-update.sh and exited 0"
else
  fail "update.sh did not take over the my-update.sh lock (log: $LOG)"
fi
if grep -q "Taking over an abandoned update lock (pid $FAKE_PID)" "$LOG"; then pass "log records the takeover from the my-update.sh holder"; else fail "no takeover line for the my-update.sh holder"; fi
if kill -0 "$FAKE_PID" 2>/dev/null; then pass "the my-update.sh process was left running (not ours to stop)"; else fail "the my-update.sh process was stopped"; fi
stop_fake_updater "$FAKE_PID"
rm -rf "$LOCK_DIR"

# ---------- Case 4: an abandoned lock (dead pid) is taken over ----------
# Also: a takeover marker older than 60 seconds (left by a crashed updater)
# does not block the takeover; it is removed.
STALE_INSTALL="$SCRATCH/Application Support/stale/com.gaffer.panel"
new_install "$STALE_INSTALL"
# A pid that was alive a moment ago and is now gone
DEAD_PID="$(start_fake_updater)"
stop_fake_updater "$DEAD_PID"
mkdir -p "$LOCK_DIR" && echo "$DEAD_PID" > "$LOCK_DIR/pid"
mkdir -p "$LOCK_DIR.takeover"
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR.takeover"
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$STALE_INSTALL/daemon/update.sh"; then
  pass "update.sh took over the dead-pid lock and exited 0"
else
  fail "update.sh did not take over the dead-pid lock (log: $LOG)"
fi
if grep -q "Taking over an abandoned update lock (pid $DEAD_PID)" "$LOG"; then pass "log records the takeover"; else fail "no takeover line in the log"; fi
if grep -q "Removing a takeover marker left by a crashed updater" "$LOG"; then pass "log records removing the stale takeover marker"; else fail "no stale takeover marker line in the log"; fi
if [ "$(tail -n1 "$LOG")" = "ok:9.9.9" ]; then pass "takeover run ends with ok:9.9.9"; else fail "takeover run last log line: $(tail -n1 "$LOG")"; fi
if [ -e "$LOCK_DIR" ]; then fail "lock left behind after the takeover run"; else pass "lock released after the takeover run"; fi
if [ -e "$LOCK_DIR.takeover" ]; then fail "takeover marker left behind after the takeover run"; else pass "takeover marker released after the takeover run"; fi

# ---------- Case 4b: a fresh takeover marker means another updater is mid-takeover ----------
MIDTAKE_INSTALL="$SCRATCH/Application Support/mid-takeover/com.gaffer.panel"
new_install "$MIDTAKE_INSTALL"
mkdir -p "$LOCK_DIR" && echo "$DEAD_PID" > "$LOCK_DIR/pid"
mkdir -p "$LOCK_DIR.takeover" && echo 99999 > "$LOCK_DIR.takeover/pid"
BEFORE="$(tree_hash "$MIDTAKE_INSTALL")"
set +e
PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$MIDTAKE_INSTALL/daemon/update.sh"
MIDTAKE_EXIT=$?
set -e
if [ "$MIDTAKE_EXIT" -eq 3 ]; then pass "updater exited 3 while another one holds the takeover marker"; else fail "updater exited $MIDTAKE_EXIT with a fresh takeover marker present, expected 3"; fi
if grep -q "Another update is taking over the abandoned lock" "$LOG"; then pass "log records the takeover in progress"; else fail "no takeover-in-progress line in the log"; fi
if [ -d "$LOCK_DIR.takeover" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$DEAD_PID" ]; then pass "fresh takeover marker and the lock left for their owner"; else fail "fresh takeover marker or lock was removed"; fi
if [ "$BEFORE" = "$(tree_hash "$MIDTAKE_INSTALL")" ]; then pass "mid-takeover run left the install untouched"; else fail "mid-takeover run modified the install"; fi
rm -rf "$LOCK_DIR" "$LOCK_DIR.takeover"

# ---------- Case 4c: two updaters clearing the same stale takeover marker yield one winner ----------
# B judges the marker stale and stops at its marker gate. A then clears it
# (an atomic rename), takes over the dead-pid lock and goes on with the
# update. B, released, must fail its own rename (the marker is gone), exit
# busy and clear nothing, instead of renaming away whatever marker is there.
MRACE_A="$SCRATCH/Application Support/marker-race-a/com.gaffer.panel"
MRACE_B="$SCRATCH/Application Support/marker-race-b/com.gaffer.panel"
new_install "$MRACE_A"
new_install "$MRACE_B"
mkdir -p "$LOCK_DIR" && echo "$DEAD_PID" > "$LOCK_DIR/pid"
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR"
mkdir -p "$LOCK_DIR.takeover"
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR.takeover"
: > "$LOG"
rm -f "$SCRATCH/mgate-b" "$SCRATCH/mgate-b.ready"
set +e
( PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" GAFFER_UPDATE_TEST_MARKER_GATE="$SCRATCH/mgate-b" bash "$MRACE_B/daemon/update.sh"; echo $? > "$SCRATCH/mrace-b.exit" ) &
wait_for_file "$SCRATCH/mgate-b.ready"
( PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$MRACE_A/daemon/update.sh"; echo $? > "$SCRATCH/mrace-a.exit" ) &
wait_until '[ -n "$(cat "$LOCK_DIR/pid" 2>/dev/null)" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" != "$DEAD_PID" ] && [ ! -d "$LOCK_DIR.takeover" ]'
touch "$SCRATCH/mgate-b"
wait
set -e
if [ "$(cat "$SCRATCH/mrace-a.exit")" = "0" ] && [ "$(cat "$SCRATCH/mrace-b.exit")" = "3" ]; then pass "marker race: the first exited 0, the gated one exited 3 (busy)"; else fail "marker race exited A=$(cat "$SCRATCH/mrace-a.exit") B=$(cat "$SCRATCH/mrace-b.exit") (expected A=0, B=3)"; fi
if [ "$(count_in_log 'Removing a takeover marker left by a crashed updater')" = "1" ]; then pass "exactly one updater cleared the stale marker"; else fail "$(count_in_log 'Removing a takeover marker left by a crashed updater') updaters cleared the stale marker"; fi
if [ "$(count_in_log 'Another update cleared the stale takeover marker first')" = "1" ]; then pass "the gated updater was rejected by its failed marker rename"; else fail "the gated updater was not rejected by the marker rename ($(count_in_log 'Another update cleared the stale takeover marker first') lines)"; fi
if [ "$(count_in_log '^ok:9.9.9$')" = "1" ]; then pass "exactly one marker-race updater installed the release"; else fail "$(count_in_log '^ok:9.9.9$') marker-race updaters installed the release"; fi
if ls "$TMPDIR" | grep -q 'gaffer-update.lock.takeover.stale'; then fail "renamed stale marker left behind"; else pass "no renamed stale marker left behind"; fi
if [ -e "$LOCK_DIR" ] || [ -e "$LOCK_DIR.takeover" ]; then fail "lock or marker left behind after the marker race"; else pass "lock and marker released after the marker race"; fi

# ---------- Case 5: a lock older than the stuck age is taken over even with a live pid ----------
# The holder here does not lead its own process group (it is a job of this
# harness), so update.sh must find its child AND grandchild itself.
OLD_INSTALL="$SCRATCH/Application Support/old-lock/com.gaffer.panel"
new_install "$OLD_INSTALL"
FAKE_PID="$(start_fake_updater)"
trap 'pkill -P "$FAKE_PID" 2>/dev/null || true; kill "$FAKE_PID" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
if [ "$(ps -o pgid= -p "$FAKE_PID" | tr -d ' ')" != "$FAKE_PID" ]; then pass "fake holder does not lead its own process group"; else fail "fake holder leads its own process group, the per-process branch is not exercised"; fi
mkdir -p "$LOCK_DIR" && echo "$FAKE_PID" > "$LOCK_DIR/pid"
age_lock_past_stuck
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" GAFFER_UPDATE_TEST_STUCK_AFTER="$STUCK_AFTER" npm_config_audit=false npm_config_fund=false bash "$OLD_INSTALL/daemon/update.sh"; then
  pass "update.sh took over the stuck holder's lock and exited 0"
else
  fail "update.sh did not take over the stuck holder's lock (log: $LOG)"
fi
if [ -e "$LOCK_DIR" ]; then fail "lock left behind after the old-lock run"; else pass "lock released after the old-lock run"; fi
if grep -q "Stopping an update that has run for over 15 minutes (pid $FAKE_PID)" "$LOG"; then pass "log records stopping the stuck holder"; else fail "no stop line for the stuck holder in the log"; fi
if grep -q "Sending TERM to the stuck update (pid $FAKE_PID) and its 2 descendant process(es) one by one" "$LOG"; then pass "per-process branch ran and found both descendants"; else fail "per-process branch line missing or wrong count: $(grep 'Sending TERM' "$LOG" || true)"; fi
# Reap it (the harness is its parent) so kill -0 reports the truth.
wait "$FAKE_PID" 2>/dev/null || true
if kill -0 "$FAKE_PID" 2>/dev/null; then fail "stuck holder (pid $FAKE_PID) is still alive after the takeover"; else pass "stuck holder was stopped before the takeover"; fi
# The holder's child (its curl, rsync or npm) and grandchild must go with it, not be orphaned.
FAKE_CHILD="$(fake_updater_child)"
FAKE_GRANDCHILD="$(fake_updater_grandchild)"
if [ -n "$FAKE_CHILD" ] && ! kill -0 "$FAKE_CHILD" 2>/dev/null; then pass "stuck holder's child (pid $FAKE_CHILD) was stopped too"; else fail "stuck holder's child (pid ${FAKE_CHILD:-unknown}) is still alive after the takeover"; kill "$FAKE_CHILD" 2>/dev/null || true; fi
if [ -n "$FAKE_GRANDCHILD" ] && ! kill -0 "$FAKE_GRANDCHILD" 2>/dev/null; then pass "stuck holder's grandchild (pid $FAKE_GRANDCHILD) was stopped too"; else fail "stuck holder's grandchild (pid ${FAKE_GRANDCHILD:-unknown}) is still alive after the takeover"; kill "$FAKE_GRANDCHILD" 2>/dev/null || true; fi
stop_fake_updater "$FAKE_PID"

# ---------- Case 5g: the stuck-age knob is ignored unless the harness really set it ----------
# Same staging as case 5 (live holder, lock aged past 3 s), but the knob
# must NOT bite: without GAFFER_UPDATE_ASSET (a stray variable in a real
# environment), at 0, and at a value too big for an integer. Each run must
# exit busy with the holder alive. Were the first honoured, it would stop
# the holder and then download the real latest release into this scratch
# install; a wrong result here changes nothing outside $SCRATCH.
KNOB_INSTALL="$SCRATCH/Application Support/knob/com.gaffer.panel"
new_install "$KNOB_INSTALL"
FAKE_PID="$(start_fake_updater)"
trap 'pkill -P "$FAKE_PID" 2>/dev/null || true; kill "$FAKE_PID" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
mkdir -p "$LOCK_DIR" && echo "$FAKE_PID" > "$LOCK_DIR/pid"
age_lock_past_stuck
for knob in "no-asset:$STUCK_AFTER" "asset:0" "asset:99999999999999999999999"; do
  value="${knob#*:}"
  : > "$LOG"
  set +e
  if [ "${knob%%:*}" = "no-asset" ]; then
    PATH="$UPDATE_PATH" GAFFER_UPDATE_TEST_STUCK_AFTER="$value" bash "$KNOB_INSTALL/daemon/update.sh"
  else
    PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" GAFFER_UPDATE_TEST_STUCK_AFTER="$value" bash "$KNOB_INSTALL/daemon/update.sh"
  fi
  KNOB_EXIT=$?
  set -e
  if [ "$KNOB_EXIT" -eq 3 ]; then pass "knob $knob: updater exited 3 (busy), the knob was ignored"; else fail "knob $knob: updater exited $KNOB_EXIT, expected 3 (log: $(tail -n3 "$LOG" | tr '\n' '|'))"; fi
  if [ "$(tail -n1 "$LOG")" = "busy:already-running" ]; then pass "knob $knob: log ends with busy:already-running"; else fail "knob $knob: last log line: $(tail -n1 "$LOG")"; fi
  if kill -0 "$FAKE_PID" 2>/dev/null; then pass "knob $knob: the live holder (pid $FAKE_PID) was left alone"; else fail "knob $knob: the live holder was stopped"; fi
done
if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$FAKE_PID" ]; then pass "knob runs left the live lock in place"; else fail "knob runs removed or rewrote the live lock"; fi
stop_fake_updater "$FAKE_PID"
rm -rf "$LOCK_DIR"

# ---------- Case 5e: a stuck holder that leads its own process group is stopped as a group ----------
# The panel spawns update.sh detached, so this is the shape real stuck
# updaters have; perl's setsid() reproduces it.
LEADER_INSTALL="$SCRATCH/Application Support/leader-lock/com.gaffer.panel"
new_install "$LEADER_INSTALL"
FAKE_PID="$(start_fake_updater leader)"
trap 'pkill -P "$FAKE_PID" 2>/dev/null || true; kill "$FAKE_PID" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
if [ "$(ps -o pgid= -p "$FAKE_PID" | tr -d ' ')" = "$FAKE_PID" ]; then pass "setsid fake holder leads its own process group"; else fail "setsid fake holder does not lead its own process group (pgid $(ps -o pgid= -p "$FAKE_PID"))"; fi
mkdir -p "$LOCK_DIR" && echo "$FAKE_PID" > "$LOCK_DIR/pid"
age_lock_past_stuck
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" GAFFER_UPDATE_TEST_STUCK_AFTER="$STUCK_AFTER" npm_config_audit=false npm_config_fund=false bash "$LEADER_INSTALL/daemon/update.sh"; then
  pass "update.sh took over the group-leading stuck holder's lock and exited 0"
else
  fail "update.sh did not take over the group-leading holder's lock (log: $LOG)"
fi
if grep -q "Sending TERM to the stuck update's process group (pgid $FAKE_PID)" "$LOG"; then pass "process-group branch ran"; else fail "process-group branch line missing: $(grep 'Sending TERM' "$LOG" || true)"; fi
wait "$FAKE_PID" 2>/dev/null || true
FAKE_CHILD="$(fake_updater_child)"
FAKE_GRANDCHILD="$(fake_updater_grandchild)"
if ! kill -0 "$FAKE_PID" 2>/dev/null && [ -n "$FAKE_CHILD" ] && ! kill -0 "$FAKE_CHILD" 2>/dev/null && [ -n "$FAKE_GRANDCHILD" ] && ! kill -0 "$FAKE_GRANDCHILD" 2>/dev/null; then
  pass "group-leading holder, its child and grandchild were all stopped"
else
  fail "group kill left something alive (holder $FAKE_PID child ${FAKE_CHILD:-?} grandchild ${FAKE_GRANDCHILD:-?})"
fi
stop_fake_updater "$FAKE_PID"

# ---------- Case 5f: a stuck holder that vanished just before the stop is not signalled ----------
# The updater reads the live holder, stops at its gate; the holder exits
# meanwhile; the re-read inside the mutex must find it gone and skip the
# stop (a pid reused by an unrelated process would otherwise be killed).
GONE_INSTALL="$SCRATCH/Application Support/gone-holder/com.gaffer.panel"
new_install "$GONE_INSTALL"
FAKE_PID="$(start_fake_updater)"
trap 'pkill -P "$FAKE_PID" 2>/dev/null || true; kill "$FAKE_PID" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
mkdir -p "$LOCK_DIR" && echo "$FAKE_PID" > "$LOCK_DIR/pid"
age_lock_past_stuck
: > "$LOG"
rm -f "$SCRATCH/gate-gone" "$SCRATCH/gate-gone.ready"
set +e
( PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" GAFFER_UPDATE_TEST_GATE="$SCRATCH/gate-gone" GAFFER_UPDATE_TEST_STUCK_AFTER="$STUCK_AFTER" npm_config_audit=false npm_config_fund=false bash "$GONE_INSTALL/daemon/update.sh"; echo $? > "$SCRATCH/gone.exit" ) &
wait_for_file "$SCRATCH/gate-gone.ready"
stop_fake_updater "$FAKE_PID"
touch "$SCRATCH/gate-gone"
wait
set -e
if [ "$(cat "$SCRATCH/gone.exit")" = "0" ]; then pass "update.sh took over the lock of a holder that vanished at the gate"; else fail "update.sh exited $(cat "$SCRATCH/gone.exit") after the holder vanished (log: $LOG)"; fi
if grep -q "The stuck update (pid $FAKE_PID) is already gone, not stopping it." "$LOG"; then pass "log records that the vanished holder was not signalled"; else fail "no 'already gone' line for the vanished holder"; fi
if grep -q "Stopping an update that has run for over 15 minutes" "$LOG"; then fail "update.sh tried to stop a holder that was already gone"; else pass "no stop was attempted on the vanished holder"; fi

# ---------- Case 5b: a seconds-old lock with no pid yet is busy, not abandoned ----------
# An updater between its mkdir and its pid write looks exactly like this.
YOUNG_INSTALL="$SCRATCH/Application Support/young-lock/com.gaffer.panel"
new_install "$YOUNG_INSTALL"
mkdir -p "$LOCK_DIR"
BEFORE="$(tree_hash "$YOUNG_INSTALL")"
set +e
PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$YOUNG_INSTALL/daemon/update.sh"
YOUNG_EXIT=$?
set -e
if [ "$YOUNG_EXIT" -eq 3 ]; then pass "updater exited 3 on a seconds-old lock without a pid"; else fail "updater exited $YOUNG_EXIT on a seconds-old lock without a pid, expected 3"; fi
if [ "$(tail -n1 "$LOG")" = "busy:already-running" ]; then pass "young-lock run ends with busy:already-running"; else fail "young-lock run last log line: $(tail -n1 "$LOG")"; fi
if [ -d "$LOCK_DIR" ] && [ ! -e "$LOCK_DIR/pid" ]; then pass "young lock left in place for its owner"; else fail "young lock was removed or rewritten"; fi
if [ "$BEFORE" = "$(tree_hash "$YOUNG_INSTALL")" ]; then pass "young-lock run left the install untouched"; else fail "young-lock run modified the install"; fi
rm -rf "$LOCK_DIR"

# ---------- Case 5c: a lock without a pid that is minutes old is abandoned ----------
NOPID_INSTALL="$SCRATCH/Application Support/nopid-lock/com.gaffer.panel"
new_install "$NOPID_INSTALL"
mkdir -p "$LOCK_DIR"
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$NOPID_INSTALL/daemon/update.sh"; then
  pass "update.sh took over the 2 minute old pid-less lock and exited 0"
else
  fail "update.sh did not take over the 2 minute old pid-less lock (log: $LOG)"
fi
if grep -q "Taking over an abandoned update lock (pid unknown)" "$LOG"; then pass "log records the pid-less takeover"; else fail "no pid-less takeover line in the log"; fi
if [ -e "$LOCK_DIR" ]; then fail "lock left behind after the pid-less takeover"; else pass "lock released after the pid-less takeover"; fi

# ---------- Case 5d: two updaters taking over the same stale lock yield one winner ----------
# B reads the dead pid and stops at its gate (GAFFER_UPDATE_TEST_GATE) before
# entering the takeover mutex. A then takes over and holds a fresh lock. B,
# released, must re-read the pid inside the mutex, see it is no longer the
# stale one, re-loop, find A's live lock and exit busy, never deleting A's
# lock on its way out. The log must show that exact path: the mutex was
# free, so B is not rejected by the takeover-in-progress check.
RACE_A="$SCRATCH/Application Support/race-a/com.gaffer.panel"
RACE_B="$SCRATCH/Application Support/race-b/com.gaffer.panel"
new_install "$RACE_A"
new_install "$RACE_B"
DEAD_PID="$(start_fake_updater)"
stop_fake_updater "$DEAD_PID"
mkdir -p "$LOCK_DIR" && echo "$DEAD_PID" > "$LOCK_DIR/pid"
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR"
: > "$LOG"
rm -f "$SCRATCH/gate-b" "$SCRATCH/gate-b.ready"
set +e
( PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" GAFFER_UPDATE_TEST_GATE="$SCRATCH/gate-b" npm_config_audit=false npm_config_fund=false bash "$RACE_B/daemon/update.sh"; echo $? > "$SCRATCH/race-b.exit" ) &
wait_for_file "$SCRATCH/gate-b.ready"
( PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$RACE_A/daemon/update.sh"; echo $? > "$SCRATCH/race-a.exit" ) &
wait_until '[ -n "$(cat "$LOCK_DIR/pid" 2>/dev/null)" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" != "$DEAD_PID" ] && [ ! -d "$LOCK_DIR.takeover" ]'
A_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
touch "$SCRATCH/gate-b"
wait
set -e
if [ "$(cat "$SCRATCH/race-a.exit")" = "0" ] && [ "$(cat "$SCRATCH/race-b.exit")" = "3" ]; then pass "racing takeovers: the first exited 0, the gated one exited 3 (busy)"; else fail "racing takeovers exited A=$(cat "$SCRATCH/race-a.exit") B=$(cat "$SCRATCH/race-b.exit") (expected A=0, B=3)"; fi
if [ "$(count_in_log '^ok:9.9.9$')" = "1" ]; then pass "exactly one racing updater installed the release"; else fail "$(count_in_log '^ok:9.9.9$') racing updaters installed the release"; fi
if [ "$(count_in_log '^busy:already-running$')" = "1" ]; then pass "exactly one racing updater exited busy"; else fail "$(count_in_log '^busy:already-running$') racing updaters exited busy"; fi
if [ "$(count_in_log 'Taking over an abandoned update lock')" = "1" ]; then pass "exactly one takeover happened"; else fail "$(count_in_log 'Taking over an abandoned update lock') takeovers happened (the gated updater must not take over the winner's lock)"; fi
if [ "$(count_in_log "The abandoned lock now belongs to pid $A_PID, rechecking.")" = "1" ]; then pass "the gated updater was rejected by the pid re-read inside the mutex"; else fail "no re-read rejection line for pid $A_PID in the log"; fi
if [ "$(count_in_log "Another update is already running (pid $A_PID)")" = "1" ]; then pass "the gated updater then saw the winner's live lock"; else fail "the gated updater did not report the winner's live lock"; fi
if grep -q "Another update is taking over the abandoned lock" "$LOG"; then fail "the gated updater was rejected by the takeover-in-progress check instead (wrong path)"; else pass "the gated updater was not rejected by the takeover-in-progress check"; fi
if [ -e "$LOCK_DIR" ]; then fail "lock left behind after the racing takeovers"; else pass "lock released after the racing takeovers"; fi
if [ -e "$LOCK_DIR.takeover" ]; then fail "takeover marker left behind after the racing takeovers"; else pass "no takeover marker left behind"; fi
if ls "$TMPDIR" | grep -q 'gaffer-update.lock.stale'; then fail "stale lock copy left behind"; else pass "no stale lock copy left behind"; fi

# ---------- Case 7: a lock dated in the future (clock moved back) with a LIVE holder is busy ----------
# A clock step, NTP or a network TMPDIR can date a healthy updater's lock in
# the future. Its holder is alive and is an update.sh, so the lock is busy
# and the holder must not be stopped: a negative age alone never kills.
FUTURE_INSTALL="$SCRATCH/Application Support/future-lock/com.gaffer.panel"
new_install "$FUTURE_INSTALL"
FAKE_PID="$(start_fake_updater)"
trap 'pkill -P "$FAKE_PID" 2>/dev/null || true; kill "$FAKE_PID" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
FUTURE_STAMP="$(date -v+1d +%Y%m%d%H%M.%S 2>/dev/null || date -d '1 day' +%Y%m%d%H%M.%S)"
mkdir -p "$LOCK_DIR" && echo "$FAKE_PID" > "$LOCK_DIR/pid"
touch -t "$FUTURE_STAMP" "$LOCK_DIR"
BEFORE="$(tree_hash "$FUTURE_INSTALL")"
: > "$LOG"
set +e
PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$FUTURE_INSTALL/daemon/update.sh"
FUTURE_EXIT=$?
set -e
if [ "$FUTURE_EXIT" -eq 3 ]; then pass "updater exited 3 on a future-dated lock with a live holder"; else fail "updater exited $FUTURE_EXIT on a future-dated lock with a live holder, expected 3"; fi
if grep -q "Another update is already running (pid $FAKE_PID)" "$LOG"; then pass "future-dated lock's live holder was reported as running"; else fail "future-dated lock's live holder was not reported as running"; fi
if grep -q "Stopping an update" "$LOG"; then fail "future-dated lock's live holder was stopped on the negative age alone"; else pass "no stop was attempted on the future-dated lock's live holder"; fi
if kill -0 "$FAKE_PID" 2>/dev/null; then pass "future-dated lock's live holder (pid $FAKE_PID) is still alive"; else fail "future-dated lock's live holder was killed"; fi
if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$FAKE_PID" ]; then pass "future-dated live lock kept its holder's pid"; else fail "future-dated live lock was removed or rewritten"; fi
if [ "$BEFORE" = "$(tree_hash "$FUTURE_INSTALL")" ]; then pass "future-dated live-lock run left the install untouched"; else fail "future-dated live-lock run modified the install"; fi
stop_fake_updater "$FAKE_PID"
rm -rf "$LOCK_DIR"

# ---------- Case 7b: a lock and marker dated in the future with a DEAD pid are stale ----------
# Nothing alive holds them, and a mtime over 300 s ahead cannot be "young"
# or "fresh": both are leftovers from before the clock moved back.
FUTURE_DEAD_INSTALL="$SCRATCH/Application Support/future-dead/com.gaffer.panel"
new_install "$FUTURE_DEAD_INSTALL"
DEAD_PID="$(start_fake_updater)"
stop_fake_updater "$DEAD_PID"
mkdir -p "$LOCK_DIR" && echo "$DEAD_PID" > "$LOCK_DIR/pid"
touch -t "$FUTURE_STAMP" "$LOCK_DIR"
mkdir -p "$LOCK_DIR.takeover"
touch -t "$FUTURE_STAMP" "$LOCK_DIR.takeover"
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$FUTURE_DEAD_INSTALL/daemon/update.sh"; then
  pass "update.sh took over the future-dated dead-pid lock and exited 0"
else
  fail "update.sh did not take over the future-dated dead-pid lock (log: $LOG)"
fi
if grep -q "Taking over an abandoned update lock (pid $DEAD_PID)" "$LOG"; then pass "future-dated dead-pid lock was taken over"; else fail "no takeover line for the future-dated dead-pid lock"; fi
if grep -q "Removing a takeover marker dated in the future" "$LOG"; then pass "future-dated takeover marker was cleared"; else fail "future-dated takeover marker was not cleared"; fi
if [ -e "$LOCK_DIR" ] || [ -e "$LOCK_DIR.takeover" ]; then fail "lock or marker left behind after the future-dated run"; else pass "lock and marker released after the future-dated run"; fi

# ---------- Case 7c: a pid-less lock dated within the skew tolerance is young ----------
# 100 s ahead is what a stepped clock produces, not a leftover: busy.
SKEW_INSTALL="$SCRATCH/Application Support/skew-lock/com.gaffer.panel"
new_install "$SKEW_INSTALL"
mkdir -p "$LOCK_DIR"
touch -t "$(date -v+100S +%Y%m%d%H%M.%S 2>/dev/null || date -d '100 seconds' +%Y%m%d%H%M.%S)" "$LOCK_DIR"
: > "$LOG"
set +e
PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$SKEW_INSTALL/daemon/update.sh"
SKEW_EXIT=$?
set -e
if [ "$SKEW_EXIT" -eq 3 ]; then pass "updater exited 3 on a pid-less lock dated 100 s ahead"; else fail "updater exited $SKEW_EXIT on a pid-less lock dated 100 s ahead, expected 3"; fi
if [ -d "$LOCK_DIR" ]; then pass "lock dated 100 s ahead left in place for its owner"; else fail "lock dated 100 s ahead was removed"; fi
rm -rf "$LOCK_DIR"

# ---------- Case 7d: a holder started after the lock was written is a reused pid ----------
# The lock is 2 minutes old; the live update.sh holding its pid is seconds
# old, so it cannot be the updater that wrote the lock. The lock is
# abandoned and taken over; the process is left alone (not ours to stop).
REUSE_INSTALL="$SCRATCH/Application Support/pid-reuse/com.gaffer.panel"
new_install "$REUSE_INSTALL"
mkdir -p "$LOCK_DIR"
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR"
FAKE_PID="$(start_fake_updater)"
trap 'pkill -P "$FAKE_PID" 2>/dev/null || true; kill "$FAKE_PID" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT
# Writing the pid file would refresh the dir's mtime: write, then backdate again.
echo "$FAKE_PID" > "$LOCK_DIR/pid"
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR"
: > "$LOG"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$REUSE_INSTALL/daemon/update.sh"; then
  pass "update.sh took over the lock whose pid was reused and exited 0"
else
  fail "update.sh did not take over the reused-pid lock (log: $LOG)"
fi
if grep -q "The lock's pid $FAKE_PID now belongs to a process started after the lock was written (pid reused)" "$LOG"; then pass "log explains the reused pid"; else fail "no pid-reuse line in the log"; fi
if grep -q "Taking over an abandoned update lock (pid $FAKE_PID)" "$LOG"; then pass "reused-pid lock was taken over as abandoned"; else fail "no takeover line for the reused-pid lock"; fi
if grep -q "Stopping an update" "$LOG"; then fail "the process that reused the pid was stopped"; else pass "no stop was attempted on the process that reused the pid"; fi
if kill -0 "$FAKE_PID" 2>/dev/null; then pass "the process that reused the pid (pid $FAKE_PID) is still alive"; else fail "the process that reused the pid was killed"; fi
stop_fake_updater "$FAKE_PID"
if [ -e "$LOCK_DIR" ]; then fail "lock left behind after the reused-pid run"; else pass "lock released after the reused-pid run"; fi

# ---------- Case 7e: a fresh marker renamed by mistake is put back ----------
# B judges the stale marker stale and stops at its marker gate. The marker
# is then replaced by a fresh one (another updater's). B, released, renames
# that fresh marker, re-checks its age, puts it back and exits busy.
PUTBACK_INSTALL="$SCRATCH/Application Support/put-back/com.gaffer.panel"
new_install "$PUTBACK_INSTALL"
mkdir -p "$LOCK_DIR" && echo "$DEAD_PID" > "$LOCK_DIR/pid"
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR"
mkdir -p "$LOCK_DIR.takeover"
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR.takeover"
BEFORE="$(tree_hash "$PUTBACK_INSTALL")"
: > "$LOG"
rm -f "$SCRATCH/mgate-pb" "$SCRATCH/mgate-pb.ready"
set +e
( PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" GAFFER_UPDATE_TEST_MARKER_GATE="$SCRATCH/mgate-pb" bash "$PUTBACK_INSTALL/daemon/update.sh"; echo $? > "$SCRATCH/putback.exit" ) &
wait_for_file "$SCRATCH/mgate-pb.ready"
rm -rf "$LOCK_DIR.takeover" && mkdir "$LOCK_DIR.takeover" && echo 99999 > "$LOCK_DIR.takeover/pid"
touch "$SCRATCH/mgate-pb"
wait
set -e
if [ "$(cat "$SCRATCH/putback.exit")" = "3" ]; then pass "updater exited 3 after renaming a fresh marker by mistake"; else fail "updater exited $(cat "$SCRATCH/putback.exit") after the fresh marker, expected 3"; fi
if grep -q "The takeover marker was renewed by another update meanwhile, putting it back." "$LOG"; then pass "log records the put-back"; else fail "no put-back line in the log"; fi
if [ -d "$LOCK_DIR.takeover" ] && [ "$(cat "$LOCK_DIR.takeover/pid" 2>/dev/null)" = "99999" ]; then pass "the fresh marker is back in place with its owner's pid"; else fail "the fresh marker was not put back"; fi
if ls "$TMPDIR" | grep -q 'gaffer-update.lock.takeover.stale'; then fail "renamed marker left behind after the put-back"; else pass "no renamed marker left behind after the put-back"; fi
if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$DEAD_PID" ]; then pass "the put-back run left the lock alone"; else fail "the put-back run removed or rewrote the lock"; fi
if [ "$BEFORE" = "$(tree_hash "$PUTBACK_INSTALL")" ]; then pass "the put-back run left the install untouched"; else fail "the put-back run modified the install"; fi
rm -rf "$LOCK_DIR" "$LOCK_DIR.takeover"

# ---------- Case 8: an updater whose lock was replaced under it leaves the replacement alone ----------
# A holds the lock and stops at its hold gate; the lock's pid file is then
# rewritten with another updater's pid (as a takeover would); A is released
# and exits (a broken asset ends it quickly). A's exit trap must leave the
# lock, now someone else's, in place.
HOLD_INSTALL="$SCRATCH/Application Support/hold-lock/com.gaffer.panel"
new_install "$HOLD_INSTALL"
rm -f "$SCRATCH/gate-hold" "$SCRATCH/gate-hold.ready"
set +e
( PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$SCRATCH/not-a-release.tar.gz" GAFFER_UPDATE_TEST_HOLD_GATE="$SCRATCH/gate-hold" bash "$HOLD_INSTALL/daemon/update.sh"; echo $? > "$SCRATCH/hold.exit" ) &
wait_for_file "$SCRATCH/gate-hold.ready"
HOLD_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
echo 424242 > "$LOCK_DIR/pid"
touch "$SCRATCH/gate-hold"
wait
set -e
if [ -n "$HOLD_PID" ] && [ "$HOLD_PID" != "424242" ]; then pass "updater A held the lock at its gate (pid $HOLD_PID)"; else fail "updater A did not hold the lock at its gate"; fi
if [ "$(cat "$SCRATCH/hold.exit")" != "0" ]; then pass "updater A exited (non-zero, broken asset) after its lock was replaced"; else fail "updater A exited 0 on a broken asset"; fi
if [ -d "$LOCK_DIR" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "424242" ]; then pass "A's exit left the replacement lock (pid 424242) in place"; else fail "A's exit removed or rewrote the replacement lock"; fi
rm -rf "$LOCK_DIR"

# ---------- Case 6: the dev-install refusal still ends the log with err:dev-install ----------
DEV_INSTALL="$SCRATCH/dev-checkout/panel"
new_install "$DEV_INSTALL"
mkdir -p "$SCRATCH/dev-checkout/.git"
BEFORE="$(tree_hash "$DEV_INSTALL")"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$DEV_INSTALL/daemon/update.sh"; then
  fail "update.sh exited 0 on a dev install"
else
  pass "update.sh refused a dev install"
fi
if [ "$(tail -n1 "$LOG")" = "err:dev-install" ]; then pass "log ends with err:dev-install"; else fail "last log line is not err:dev-install: $(tail -n1 "$LOG")"; fi
if [ "$BEFORE" = "$(tree_hash "$DEV_INSTALL")" ]; then pass "dev install left untouched"; else fail "dev install was modified"; fi
if [ -e "$LOCK_DIR" ]; then fail "lock left behind after the dev-install refusal"; else pass "lock released after the dev-install refusal"; fi

# ---------- Case M1: the shipped v0.11.3 updater still accepts the new archive (spec 7) ----------
# Existing users run THEIR updater for the first zero-dependency release. It
# requires daemon/index.js (the shim) and runs npm install --omit=dev, which
# must succeed on the dependency-free package.json. Needs npm on PATH.
OLD_UPDATER_REF="v0.11.3"
if git -C "$REPO_ROOT" rev-parse -q --verify "$OLD_UPDATER_REF^{commit}" >/dev/null && command -v npm >/dev/null 2>&1; then
  MIG_INSTALL="$SCRATCH/Application Support/migrate-0.11.3/com.gaffer.panel"
  new_install "$MIG_INSTALL"
  # Like a real 0.11.x install: npm 7+ leaves its hidden lockfile in
  # node_modules. With it npm 10 does not prune the old tree (a real v0.11.3
  # tree kept all 95 packages, npm 10.8.1), so the NOTE below is the
  # expected outcome. Written a second later: npm trusts it only when it is
  # newer than the folders it lists.
  sleep 1
  printf '%s\n' '{"name":"gaffer-daemon","lockfileVersion":3,"requires":true,"packages":{"node_modules/ws":{"version":"8.0.0","resolved":"https://registry.npmjs.org/ws/-/ws-8.0.0.tgz","license":"MIT"}}}' > "$MIG_INSTALL/daemon/node_modules/.package-lock.json"
  git -C "$REPO_ROOT" show "$OLD_UPDATER_REF:panel/daemon/update.sh" > "$MIG_INSTALL/daemon/update.sh"
  : > "$LOG"
  if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$MIG_INSTALL/daemon/update.sh"; then
    pass "v0.11.3 updater: accepted the new archive and exited 0"
  else
    fail "v0.11.3 updater: failed on the new archive (log: $(tail -n5 "$LOG" | tr '\n' '|'))"
  fi
  if [ "$(tail -n1 "$LOG")" = "ok:9.9.9" ]; then pass "v0.11.3 updater: log ends with ok:9.9.9"; else fail "v0.11.3 updater: last log line: $(tail -n1 "$LOG")"; fi
  if [ "$(cat "$MIG_INSTALL/daemon/index.js" 2>/dev/null)" = "import './daemon.mjs';" ] && [ -f "$MIG_INSTALL/daemon/daemon.mjs" ]; then pass "v0.11.3 updater: index.js shim and daemon.mjs in place"; else fail "v0.11.3 updater: shim or bundle missing"; fi
  if [ ! -e "$MIG_INSTALL/daemon/runtime" ]; then pass "v0.11.3 updater: no runtime yet (system node until the next update)"; else fail "v0.11.3 updater: a runtime appeared"; fi
  if [ -z "$(find "$MIG_INSTALL/daemon/node_modules" -name package.json 2>/dev/null | head -1)" ]; then pass "v0.11.3 updater: npm pruned the old dependency tree"; else echo "NOTE: v0.11.3 updater left node_modules in place (acceptance case A9 decides; the next new-updater sync removes it)"; fi
  # ... and the next update, now with the new updater, provisions the runtime
  # and removes whatever is left of node_modules.
  cp "$REPO_ROOT/panel/daemon/update.sh" "$MIG_INSTALL/daemon/update.sh"
  : > "$LOG"
  if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" bash "$MIG_INSTALL/daemon/update.sh" \
     && [ "$(cat "$MIG_INSTALL/daemon/runtime/VERSION" 2>/dev/null)" = "$RT_V1 $FAKE_PLAT" ] && [ ! -e "$MIG_INSTALL/daemon/node_modules" ]; then
    pass "after v0.11.3: the new updater provisioned the runtime and removed node_modules"
  else
    fail "after v0.11.3: the new updater did not finish the migration (log: $(tail -n5 "$LOG" | tr '\n' '|'))"
  fi
else
  if [ "${GAFFER_TEST_ALLOW_NO_TAG:-}" = "1" ]; then
    echo "SKIP: v0.11.3 updater case (tag $OLD_UPDATER_REF or npm not available, GAFFER_TEST_ALLOW_NO_TAG=1)"
  else
    fail "v0.11.3 updater case could not run: tag $OLD_UPDATER_REF or npm missing (fetch tags, or set GAFFER_TEST_ALLOW_NO_TAG=1 to skip it knowingly)"
  fi
fi

# ---------- Case INT: real runtime from nodejs.org (opt-in) ----------
# GAFFER_TEST_REAL_RUNTIME=1, macOS only: the unmodified release asset (real
# pins), no fetch seams, signature check on. Downloads about 54 MB.
if [ "${GAFFER_TEST_REAL_RUNTIME:-}" = "1" ] && [ "$(uname -s)" = "Darwin" ]; then
  REAL_INSTALL="$SCRATCH/Application Support/real-runtime/com.gaffer.panel"
  new_install "$REAL_INSTALL"
  : > "$LOG"
  if env -u GAFFER_FETCH_TEST -u GAFFER_FETCH_PLATFORM -u GAFFER_FETCH_SKIP_CODESIGN -u GAFFER_FETCH_BASE_OFFICIAL -u GAFFER_FETCH_BASE_MIRROR \
       PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$REAL_ASSET" bash "$REAL_INSTALL/daemon/update.sh"; then
    pass "real runtime: update.sh exited 0"
  else
    fail "real runtime: update.sh failed (log: $(tail -n8 "$LOG" | tr '\n' '|'))"
  fi
  REAL_VER="$(grep -o '"version": *"v[^"]*"' "$REPO_ROOT/panel/daemon/runtime-pins.json" | head -1 | sed 's/.*"\(v[^"]*\)"$/\1/')"
  if [ "$("$REAL_INSTALL/daemon/runtime/node" --version 2>/dev/null)" = "$REAL_VER" ] && grep -q 'signature verified' "$LOG"; then pass "real runtime: $REAL_VER installed with a verified signature"; else fail "real runtime: runtime not $REAL_VER or signature not verified"; fi
else
  echo "SKIP: real-runtime integration case (set GAFFER_TEST_REAL_RUNTIME=1 on macOS to run it)"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL PASS"; else echo "$FAILS FAILURE(S)"; exit 1; fi
