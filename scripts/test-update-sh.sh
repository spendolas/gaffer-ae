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
# while a live one holds the lock, an abandoned lock (dead pid) is taken over,
# a live holder older than 15 minutes is stopped and taken over, a seconds-old
# lock with no pid yet counts as busy while an older one without a pid is
# taken over, two updaters taking over the same stale lock yield exactly one
# winner, the lock is gone after success and after a failure, and the
# dev-install refusal still ends the log with err:dev-install.
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
# A long-lived process whose command line contains "update.sh", which is what
# the lock's liveness check looks for. Prints its pid.
start_fake_updater() {
  mkdir -p "$SCRATCH/fake"
  printf '#!/bin/bash\nsleep 300\n' > "$SCRATCH/fake/update.sh"
  bash "$SCRATCH/fake/update.sh" >/dev/null 2>&1 &
  echo $!
}
# Kill the fake updater and its sleep, and give the kernel a beat to reap it
# so kill -0 (the lock's liveness check) no longer sees it.
stop_fake_updater() {
  pkill -P "$1" 2>/dev/null || true
  kill "$1" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
  sleep 0.3
}

# Fake release asset from the committed tree
(cd "$REPO_ROOT" && bash scripts/package-release.sh 9.9.9 feedfacecafe "$SCRATCH/dist" >/dev/null)
ASSET="$SCRATCH/dist/gaffer-update-mac.tar.gz"

new_install() {
  local dir="$1"
  mkdir -p "$dir"
  (cd "$REPO_ROOT" && git archive "$OLD_REF:panel") | tar -x -C "$dir"
  # Pre-seed node_modules (excluded from the sync) so npm install stays local and quick
  cp -R "$REPO_ROOT/panel/daemon/node_modules" "$dir/daemon/node_modules"
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

for junk in gaffer.tar.gz gaffer.zip gaffer-update-mac.tar.gz extract version.json.tmp stale-file-from-old-release.txt; do
  if [ -e "$INSTALL/$junk" ]; then fail "$junk left in the panel dir"; else pass "no $junk in the panel dir"; fi
done

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

# ---------- Case 4: an abandoned lock (dead pid) is taken over ----------
STALE_INSTALL="$SCRATCH/Application Support/stale/com.gaffer.panel"
new_install "$STALE_INSTALL"
# A pid that was alive a moment ago and is now gone
DEAD_PID="$(start_fake_updater)"
stop_fake_updater "$DEAD_PID"
mkdir -p "$LOCK_DIR" && echo "$DEAD_PID" > "$LOCK_DIR/pid"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$STALE_INSTALL/daemon/update.sh"; then
  pass "update.sh took over the dead-pid lock and exited 0"
else
  fail "update.sh did not take over the dead-pid lock (log: $LOG)"
fi
if grep -q "Taking over an abandoned update lock (pid $DEAD_PID)" "$LOG"; then pass "log records the takeover"; else fail "no takeover line in the log"; fi
if [ "$(tail -n1 "$LOG")" = "ok:9.9.9" ]; then pass "takeover run ends with ok:9.9.9"; else fail "takeover run last log line: $(tail -n1 "$LOG")"; fi
if [ -e "$LOCK_DIR" ]; then fail "lock left behind after the takeover run"; else pass "lock released after the takeover run"; fi

# ---------- Case 5: a lock older than 15 minutes is taken over even with a live pid ----------
OLD_INSTALL="$SCRATCH/Application Support/old-lock/com.gaffer.panel"
new_install "$OLD_INSTALL"
FAKE_PID="$(start_fake_updater)"
mkdir -p "$LOCK_DIR" && echo "$FAKE_PID" > "$LOCK_DIR/pid"
touch -t "$(date -v-20M +%Y%m%d%H%M.%S 2>/dev/null || date -d '20 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR"
if PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$OLD_INSTALL/daemon/update.sh"; then
  pass "update.sh took over the 20 minute old lock and exited 0"
else
  fail "update.sh did not take over the 20 minute old lock (log: $LOG)"
fi
if [ -e "$LOCK_DIR" ]; then fail "lock left behind after the old-lock run"; else pass "lock released after the old-lock run"; fi
if grep -q "Stopping an update that has run for over 15 minutes (pid $FAKE_PID)" "$LOG"; then pass "log records stopping the stuck holder"; else fail "no stop line for the stuck holder in the log"; fi
# Reap it (the harness is its parent) so kill -0 reports the truth.
wait "$FAKE_PID" 2>/dev/null || true
if kill -0 "$FAKE_PID" 2>/dev/null; then fail "stuck holder (pid $FAKE_PID) is still alive after the takeover"; else pass "stuck holder was stopped before the takeover"; fi
stop_fake_updater "$FAKE_PID"

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
# Both find the dead pid at the same moment. The rename-based takeover lets
# only one of them remove the stale lock; the other must then see the
# winner's fresh lock and exit busy, never delete it.
RACE_A="$SCRATCH/Application Support/race-a/com.gaffer.panel"
RACE_B="$SCRATCH/Application Support/race-b/com.gaffer.panel"
new_install "$RACE_A"
new_install "$RACE_B"
DEAD_PID="$(start_fake_updater)"
stop_fake_updater "$DEAD_PID"
mkdir -p "$LOCK_DIR" && echo "$DEAD_PID" > "$LOCK_DIR/pid"
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" "$LOCK_DIR"
: > "$LOG"
set +e
( PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$RACE_A/daemon/update.sh"; echo $? > "$SCRATCH/race-a.exit" ) &
( PATH="$UPDATE_PATH" GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$RACE_B/daemon/update.sh"; echo $? > "$SCRATCH/race-b.exit" ) &
wait
set -e
RACE_EXITS="$(printf '%s\n' "$(cat "$SCRATCH/race-a.exit")" "$(cat "$SCRATCH/race-b.exit")" | sort | tr '\n' ' ')"
if [ "$RACE_EXITS" = "0 3 " ]; then pass "racing takeovers exited 0 and 3 (one winner, one busy)"; else fail "racing takeovers exited: $RACE_EXITS (expected one 0 and one 3)"; fi
if [ "$(grep -c '^ok:9.9.9$' "$LOG")" = "1" ]; then pass "exactly one racing updater installed the release"; else fail "$(grep -c '^ok:9.9.9$' "$LOG") racing updaters installed the release"; fi
if [ "$(grep -c '^busy:already-running$' "$LOG")" = "1" ]; then pass "exactly one racing updater exited busy"; else fail "$(grep -c '^busy:already-running$' "$LOG") racing updaters exited busy"; fi
if [ -e "$LOCK_DIR" ]; then fail "lock left behind after the racing takeovers"; else pass "lock released after the racing takeovers"; fi
if ls "$TMPDIR" | grep -q 'gaffer-update.lock.stale'; then fail "stale lock copy left behind"; else pass "no stale lock copy left behind"; fi

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

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL PASS"; else echo "$FAILS FAILURE(S)"; exit 1; fi
