#!/bin/bash
# Gaffer update script: downloads the latest GitHub release asset, stages the
# pinned Node runtime it names (only when that changed), replaces panel files,
# preserves user data, restarts daemon. No npm, no system Node.
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_DIR="$PANEL_DIR/daemon"
TMP_DIR="${TMPDIR:-/tmp}/gaffer-update-$$"
EXTRACT_DIR="$TMP_DIR/extract"
ASSET_NAME="gaffer-update-mac.tar.gz"
# GAFFER_UPDATE_ASSET overrides the download source with another URL or a
# local file path. Only scripts/test-update-sh.sh and pre-release checks set it.
# It also enables the test seams below: GAFFER_UPDATE_TEST_* and the
# GAFFER_FETCH_* variables passed on to fetch-runtime.sh.
ASSET_SOURCE="${GAFFER_UPDATE_ASSET:-https://github.com/spendolas/gaffer-ae/releases/latest/download/$ASSET_NAME}"

LOG="${TMPDIR:-/tmp}/gaffer-update.log"
exec >> "$LOG" 2>&1
echo "=== Update started: $(date) ==="

# Last log line contract (the only channel back to a human or a tool):
#   ok:<version>            installed
#   err:<code>              failed, always right after an ERROR line. Codes:
#                           err:dev-install, err:lock, err:download, err:runtime, err:sync, err:runtime-swap, err:archive, err:internal, err:stopped
#                           err:dev-install: the panel is a git checkout, refused
#                           err:lock: the update lock could not be created or taken
#                           err:download: the asset could not be fetched or unpacked
#                           err:archive: it unpacked, but is not a Gaffer release (no version.json,
#                           no daemon/daemon.mjs, or no version in version.json); the install is untouched
#                           err:runtime: the runtime could not be staged, the install is untouched
#                           err:runtime-swap: recovering or swapping the runtime failed after the
#                           daemon was stopped (or an earlier run left it half done): the install may be unfinished
#                           err:sync: replacing the panel files (or restoring user data, or writing
#                           version.json) failed: the install may be unfinished
#                           err:internal: the catch-all. Any other way out (a command failing under
#                           set -e, the temp folder or a backup that cannot be written, a disk full)
#                           before a result line was printed.
#                           err:stopped: SIGTERM, SIGINT or SIGHUP arrived before a result line was
#                           printed. Usually a newer updater took over a stuck run (stop_lock_holder)
#                           and will print its own result after this line, so a panel keeps waiting.
#   busy:already-running    another updater holds the lock; this one did nothing
# Exit codes: 0 ok, 1 failed, 3 busy (128 + n when stopped by signal n).
# Every result line goes through result_line, so the EXIT trap knows one was
# printed; a failure prints "ERROR: ..." then result_line "err:<code>" then
# exits. Only SIGKILL (nothing can trap it) ends a run without a result line.

# ---- result line and exit trap ----
RESULT_LINE=""
CAUGHT_SIGNAL=""
result_line() { RESULT_LINE="$1"; echo "$1"; }
# Removes the temp dir, a held takeover mutex and the lock, however the
# script exits. Silent (its output would land after the result line) and
# safe at any point, even before the lock functions are defined.
cleanup() {
  cd /
  if [ -n "${TMP_DIR:-}" ]; then rm -rf "$TMP_DIR"; fi
  if declare -F release_takeover_mutex >/dev/null; then release_takeover_mutex; fi
  # Only ever delete a lock that is still ours: a stuck run that was taken
  # over must not delete its successor's lock on the way out.
  if [ -n "${HAVE_LOCK:-}" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK_DIR"; fi
}
# The catch-all: a run that ends without having printed ok:, err: or busy:
# (whatever the exit status, a zero one included) gets an ERROR line and
# err:internal (err:stopped when a signal ended it), and a non-zero status.
# One that printed its result line gets nothing after it.
on_exit() {
  local rc=$?
  trap - EXIT
  { cleanup; } >/dev/null 2>&1 || true
  if [ -z "$RESULT_LINE" ]; then
    if [ -n "$CAUGHT_SIGNAL" ]; then
      echo "ERROR: the updater was stopped by SIG$CAUGHT_SIGNAL before it reported a result"
      echo "err:stopped"
    else
      echo "ERROR: the updater stopped unexpectedly (exit $rc) before it reported a result"
      echo "err:internal"
    fi
    [ "$rc" -ne 0 ] || rc=1
  fi
  exit "$rc"
}
# bash 3.2 runs the EXIT trap on SIGTERM with $? 0, so each signal is turned
# into an exit with the usual 128 + n status first.
on_signal() { CAUGHT_SIGNAL="$1"; exit "$2"; }
trap on_exit EXIT
trap 'on_signal TERM 143' TERM
trap 'on_signal INT 130' INT
trap 'on_signal HUP 129' HUP
# ---- end result line and exit trap ----

# --repair (the panel's Repair button, shown while the daemon launch is
# refused because the runtime is damaged, missing or blocked): the runtime
# is downloaded and verified again even when its stamps say it is current
# (the archive's fetch-runtime.sh gets --force), then the release's files are
# synced as in any update. The version need not change; the panel waits for
# ok:<version>. A plain update already re-provisions a runtime whose stamp
# check fails; --repair also covers one that passes it but still will not
# run. Unknown arguments are logged and ignored, as before this option.
REPAIR=""
for arg in "$@"; do
  case "$arg" in
    --repair) REPAIR=1 ;;
    *) echo "Ignoring unknown argument: $arg" ;;
  esac
done
if [ -n "$REPAIR" ]; then echo "Repair mode: the runtime is downloaded again even if it looks current"; fi

# Single-updater lock. Two updaters interleaving (the panel's "Force stop &
# retry" after its 180s give-up, or a manual run next to the panel's) would
# rsync over each other and corrupt the install, so the whole run holds
# $LOCK_DIR, created atomically with mkdir and holding this PID. A lock whose
# PID is dead or is not an update.sh is abandoned and taken over; a lock
# older than 15 minutes whose holder is still an update.sh is a stuck updater,
# which is stopped first (the whole process tree, not just its shell), then
# taken over. A lock younger than 30 seconds with no pid yet belongs to an
# updater between its mkdir and its pid write, and counts as busy.
#
# Clock safety: an age is wall-clock now minus the lock's mtime, and the
# clock can step (NTP, a VM resume, a network TMPDIR with its own clock), so
# a healthy lock can read a few seconds or minutes into the future. A
# negative age up to 300 s is treated like age 0. Only a lock (or takeover
# marker) dated more than 300 s in the future is a leftover from before the
# clock moved backwards and counts as stale instead of young, and that
# shortcut only ever applies to a lock with no pid or a dead pid: a LIVE
# updater holder is never stopped on a negative age alone, its lock is busy
# until it is really over 15 minutes old.
#
# Takeovers are serialized by a second mkdir mutex, $TAKEOVER_DIR: only its
# holder may stop or remove a lock, and it re-reads the lock's pid inside the
# mutex and only removes the lock if that pid is still the one it judged
# stale. Without this, updater B (which read the stale pid a moment earlier)
# could rename away updater A's fresh lock. The EXIT trap, in turn, only
# deletes a lock whose pid file still holds THIS pid, so a losing updater can
# never delete the winner's lock on its way out. A takeover marker older than
# 60 seconds was left by a crashed updater; it is cleared by renaming it away
# (atomic, so of two updaters that both saw it stale exactly one clears it
# and goes on, the other exits busy) and only then re-created.
# panel/main.js reads the same lock to decide whether an updater is still
# running; keep the path and layout in sync.
LOCK_DIR="${TMPDIR:-/tmp}/gaffer-update.lock"
TAKEOVER_DIR="$LOCK_DIR.takeover"
HAVE_LOCK=""
HAVE_TAKEOVER=""
# A live holder whose lock is this old (seconds) is a stuck updater.
STUCK_AFTER=900
# Test-only gates, set only by scripts/test-update-sh.sh to make the takeover
# races deterministic. Each names a file: the script touches "<file>.ready"
# when it reaches the gate, then waits (up to 60s) until <file> exists.
#   GAFFER_UPDATE_TEST_GATE         after reading a stale lock's pid, before
#                                   entering the takeover mutex
#   GAFFER_UPDATE_TEST_MARKER_GATE  after judging the takeover marker stale,
#                                   before renaming it away
#   GAFFER_UPDATE_TEST_HOLD_GATE    right after the lock is acquired
#   GAFFER_UPDATE_TEST_SWAP_GATE    between the two runtime renames (the
#                                   harness kills the updater there)
# Like the stuck-age knob below, the gates count only next to
# GAFFER_UPDATE_ASSET (the harness sets both, the panel sets neither): a
# stray gate variable in a real environment never pauses an update.
# GAFFER_UPDATE_TEST_STUCK_AFTER (whole seconds) lowers the 15 minute stuck
# age so the harness can stage a stuck holder that really is older than its
# lock (the pid-reuse guard below rejects a holder younger than the lock, so
# a backdated lock can no longer stand in for a long run). Honoured only
# next to GAFFER_UPDATE_ASSET (the harness sets both, the panel sets
# neither), digits only, 1 to 86400 (at most 5 digits, so the comparison
# never sees a number too big for the shell).
case "${GAFFER_UPDATE_TEST_STUCK_AFTER:-}" in
  ''|*[!0-9]*) ;;
  *)
    if [ -n "${GAFFER_UPDATE_ASSET:-}" ] && [ "${#GAFFER_UPDATE_TEST_STUCK_AFTER}" -le 5 ] \
       && [ "$((10#$GAFFER_UPDATE_TEST_STUCK_AFTER))" -ge 1 ] && [ "$((10#$GAFFER_UPDATE_TEST_STUCK_AFTER))" -le 86400 ]; then
      STUCK_AFTER="$((10#$GAFFER_UPDATE_TEST_STUCK_AFTER))"
    fi ;;
esac
# fetch-runtime.sh's own test seams (GAFFER_FETCH_*: file:// sources, a fake
# pins file, no signature check) reach it through this script's environment.
# Like the stuck-age knob they count only next to GAFFER_UPDATE_ASSET: a stray
# variable in a real environment must never weaken the runtime checks.
if [ -z "${GAFFER_UPDATE_ASSET:-}" ]; then
  unset GAFFER_FETCH_TEST GAFFER_FETCH_PINS GAFFER_FETCH_BASE_OFFICIAL GAFFER_FETCH_BASE_MIRROR GAFFER_FETCH_PLATFORM GAFFER_FETCH_SKIP_CODESIGN
fi
test_gate() {
  local gate="$1" i
  [ -n "$gate" ] || return 0
  [ -n "${GAFFER_UPDATE_ASSET:-}" ] || return 0
  : > "$gate.ready"
  for i in $(seq 1 600); do
    [ -e "$gate" ] && return 0
    sleep 0.1
  done
  return 0
}
# Fails (prints nothing) when the path cannot be stat'ed: a lock that
# vanished mid-check must not read as mtime 0, a huge age and a false
# "pid reused". Callers decide what a missing age means for them.
dir_age_seconds() {
  local mtime now
  mtime="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)" || return 1
  case "$mtime" in ''|*[!0-9]*) return 1 ;; esac
  now="$(date +%s)"
  echo $((now - mtime))
}
# ps etime ("mm:ss", "hh:mm:ss" or "dd-hh:mm:ss") as whole seconds. Fails on
# anything else, so the caller can skip the age comparison.
etime_seconds() {
  local et="$1" days=0 a b c
  et="${et//[[:space:]]/}"
  case "$et" in *-*) days="${et%%-*}"; et="${et#*-}" ;; esac
  IFS=: read -r a b c <<< "$et"
  if [ -z "$c" ]; then c="$b"; b="$a"; a=0; fi
  case "$days$a$b$c" in ''|*[!0-9]*) return 1 ;; esac
  [ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] || return 1
  echo $(( 10#$days * 86400 + 10#$a * 3600 + 10#$b * 60 + 10#$c ))
}
# True when the pid is alive, is not this very process, its command line
# runs an update.sh, and it already existed when the lock was written.
# The panel spawns the script as daemon/update.sh, a person may run
# "cd daemon; bash update.sh". The name must stand alone (a leading start,
# space or slash, a trailing space or end), so my-update.sh or update.sh.bak
# do not count. Pid-reuse guard: a process that took over a dead updater's
# pid was started AFTER that updater wrote the lock, so its age (ps etime)
# must be at least the lock's age, less 5 s of slack for the two clocks and
# the whole-second etime. The guard is skipped when the lock's age is
# negative (the clock stepped, nothing to compare against), the lock cannot
# be stat'ed (it vanished meanwhile) or etime cannot be parsed; the name
# match alone decides then.
HOLDER_PID_REUSED=""
lock_holder_is_updater() {
  local pid="$1" lock_age proc_age
  HOLDER_PID_REUSED=""
  [ -n "$pid" ] || return 1
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$pid" != "$$" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -o command= -p "$pid" 2>/dev/null | grep -Eq '(^|[[:space:]/])update\.sh([[:space:]]|$)' || return 1
  if lock_age="$(dir_age_seconds "$LOCK_DIR")" && [ "$lock_age" -ge 0 ] && proc_age="$(etime_seconds "$(ps -o etime= -p "$pid" 2>/dev/null)")"; then
    if [ "$proc_age" -lt $((lock_age - 5)) ]; then HOLDER_PID_REUSED=1; return 1; fi
  fi
  return 0
}
# A live holder's lock older than the stuck age. A negative age never
# counts here: a live holder is busy, however the clock reads; so is a
# lock whose age cannot be read.
lock_is_old() {
  local age
  age="$(dir_age_seconds "$LOCK_DIR")" || return 1
  [ "$age" -ge "$STUCK_AFTER" ]
}
# Under 30 s old, up to 300 s of clock skew tolerated; beyond that a future
# date is a leftover from before the clock moved back, and not young. A
# lock whose age cannot be read is not young either (the takeover path
# then finds it gone and retries).
lock_is_young() {
  local age
  age="$(dir_age_seconds "$LOCK_DIR")" || return 1
  [ "$age" -ge -300 ] && [ "$age" -lt 30 ]
}
# Every process below the holder, any depth, from one ps snapshot: each
# process is walked up its parent chain and printed when that chain reaches
# the holder. One snapshot, not a pkill -P per level: pkill is what the
# daemon-stop path uses and what the test harness shims away.
descendant_pids() {
  ps -axo pid=,ppid= 2>/dev/null | awk -v root="$1" '
    { parent[$1] = $2 }
    END {
      for (p in parent) {
        q = p; hops = 0
        while ((q in parent) && q != root && hops < 1000) { q = parent[q]; hops++ }
        if (q == root && p != root) print p
      }
    }'
}
# Signal the holder and everything it started. The panel spawns update.sh
# detached, so the holder normally leads its own process group and the whole
# group gets the signal in one call (a child forked meanwhile is in the
# group too); otherwise the holder is frozen with SIGSTOP first, so it
# cannot start anything between the snapshot and the signal, then every
# descendant (its curl, rsync or runtime download, and whatever those started) is
# signalled one by one, then the holder, which is then resumed so it acts
# on the signal (a stopped process only acts on SIGKILL). Killing only the
# shell would leave those running, and a bash waiting on a foreground child
# does not even act on SIGTERM until that child exits.
signal_holder_tree() {
  local pid="$1" sig="$2" pgid kids n
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then
    echo "Sending $sig to the stuck update's process group (pgid $pgid)"
    kill "-$sig" -- "-$pid" 2>/dev/null || true
  else
    kill -STOP "$pid" 2>/dev/null || true
    kids="$(descendant_pids "$pid")"
    n=0
    for child in $kids; do
      kill "-$sig" "$child" 2>/dev/null || true
      n=$((n + 1))
    done
    echo "Sending $sig to the stuck update (pid $pid) and its $n descendant process(es) one by one"
    kill "-$sig" "$pid" 2>/dev/null || true
    kill -CONT "$pid" 2>/dev/null || true
  fi
}
# TERM first, a short wait, then KILL. kill -0 keeps answering for a zombie
# whose parent has not reaped it yet, so the wait is bounded, not a condition.
# Once the holder is gone its EXIT trap has already run (a pre-fix holder's
# trap deletes the lock unconditionally); the final pause lets the file
# system settle before the caller re-reads the lock.
stop_lock_holder() {
  local pid="$1" i
  echo "Stopping an update that has run for over 15 minutes (pid $pid)"
  signal_holder_tree "$pid" TERM
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.3
  done
  if kill -0 "$pid" 2>/dev/null; then
    signal_holder_tree "$pid" KILL
  fi
  sleep 0.5
}
# Serialize takeovers. Returns 1 when another live updater is mid-takeover,
# or when another updater cleared the same stale marker first. A stale
# marker (60 seconds or older, or dated over 300 s in the future) is cleared
# by renaming it to a name only this process uses: the rename is atomic, so
# of several updaters that all judged it stale exactly one succeeds. The
# renamed directory's own age is checked once more: had a fresh marker
# slipped in between the age check and the rename, the rename would have
# stolen a live updater's mutex, so a young one is put back and this updater
# yields.
#
# Residual risk, left as is: the put-back is not atomic. While the renamed
# fresh marker is away (between this updater's mv and its mv back), a third
# updater can mkdir a marker of its own; the put-back then sees a marker in
# place, discards the renamed one, and two updaters believe they hold the
# mutex. It takes three updaters racing within milliseconds, and the lock
# takeover inside the mutex still re-reads the lock's pid and only removes
# the lock it judged stale, so harm also needs those two to interleave
# within the few instructions between that re-read and the rename.
marker_is_stale() { [ "$1" -ge 60 ] || [ "$1" -lt -300 ]; }
take_takeover_mutex() {
  local age stale
  if mkdir "$TAKEOVER_DIR" 2>/dev/null; then HAVE_TAKEOVER=1; return 0; fi
  [ -d "$TAKEOVER_DIR" ] || return 1
  age="$(dir_age_seconds "$TAKEOVER_DIR")" || return 1
  marker_is_stale "$age" || return 1
  test_gate "${GAFFER_UPDATE_TEST_MARKER_GATE:-}"
  stale="$TAKEOVER_DIR.stale.$$"
  if ! mv "$TAKEOVER_DIR" "$stale" 2>/dev/null; then
    echo "Another update cleared the stale takeover marker first, leaving it to finish."
    return 1
  fi
  age="$(dir_age_seconds "$stale")" || age=0
  if ! marker_is_stale "$age"; then
    echo "The takeover marker was renewed by another update meanwhile, putting it back."
    if [ ! -e "$TAKEOVER_DIR" ]; then mv "$stale" "$TAKEOVER_DIR" 2>/dev/null || rm -rf "$stale"; else rm -rf "$stale"; fi
    return 1
  fi
  if [ "$age" -lt -300 ]; then
    echo "Removing a takeover marker dated in the future (the clock moved back since it was left)"
  else
    echo "Removing a takeover marker left by a crashed updater ($age s old)"
  fi
  rm -rf "$stale"
  if mkdir "$TAKEOVER_DIR" 2>/dev/null; then HAVE_TAKEOVER=1; return 0; fi
  return 1
}
release_takeover_mutex() {
  if [ -n "$HAVE_TAKEOVER" ]; then rmdir "$TAKEOVER_DIR" 2>/dev/null || true; HAVE_TAKEOVER=""; fi
}
# The lock dir is ours (just created); a pid that cannot be written (a full
# or read-only TMPDIR) leaves no usable lock, so it is removed again.
write_lock_pid() {
  if ! echo "$$" > "$LOCK_DIR/pid"; then
    rm -rf "$LOCK_DIR"
    echo "ERROR: could not write the update lock at $LOCK_DIR (disk full or read-only?)"
    result_line "err:lock"
    exit 1
  fi
}
acquire_lock() {
  local tries=0 holder now_holder stale was_updater
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ ! -e "$LOCK_DIR" ]; then
      # Released between our mkdir and now (or mkdir cannot work here): retry, bounded.
      tries=$((tries + 1))
      if [ "$tries" -gt 3 ]; then
        echo "ERROR: could not create the update lock at $LOCK_DIR"
        result_line "err:lock"
        exit 1
      fi
      continue
    fi
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -z "$holder" ] && lock_is_young; then
      echo "Another update is starting up (its lock is seconds old), leaving it to finish."
      result_line "busy:already-running"
      exit 3
    fi
    # A live updater holder is busy unless its lock is really old; a lock
    # dated in the future is never "old", so it is busy as well.
    if lock_holder_is_updater "$holder" && ! lock_is_old; then
      echo "Another update is already running (pid $holder), leaving it to finish."
      result_line "busy:already-running"
      exit 3
    fi
    if [ -n "$HOLDER_PID_REUSED" ]; then
      echo "The lock's pid $holder now belongs to a process started after the lock was written (pid reused), not to the update that wrote it."
    fi
    tries=$((tries + 1))
    if [ "$tries" -gt 3 ]; then
      echo "ERROR: could not take the update lock at $LOCK_DIR"
      result_line "err:lock"
      exit 1
    fi
    # Was the holder a live updater when judged (then it is only here because
    # the lock is old)? Decides whether a vanished holder is worth a log line.
    was_updater=""
    if lock_holder_is_updater "$holder"; then was_updater=1; fi
    test_gate "${GAFFER_UPDATE_TEST_GATE:-}"
    if ! take_takeover_mutex; then
      echo "Another update is taking over the abandoned lock, leaving it to finish."
      result_line "busy:already-running"
      exit 3
    fi
    # Inside the mutex: the lock may have been taken over (and re-created)
    # since the pid was read. Only act on the lock we judged stale.
    now_holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ ! -d "$LOCK_DIR" ]; then
      echo "The abandoned lock was released meanwhile, retrying."
      release_takeover_mutex
      continue
    fi
    if [ "$now_holder" != "$holder" ]; then
      echo "The abandoned lock now belongs to pid ${now_holder:-unknown}, rechecking."
      release_takeover_mutex
      continue
    fi
    # Re-read the holder itself inside the mutex: stop it only if it is still
    # a live updater right now, never a process that took its pid meanwhile.
    if lock_holder_is_updater "$holder"; then
      stop_lock_holder "$holder"
      now_holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
      if [ -d "$LOCK_DIR" ] && [ "$now_holder" != "$holder" ]; then
        echo "The abandoned lock now belongs to pid ${now_holder:-unknown}, rechecking."
        release_takeover_mutex
        continue
      fi
    elif [ -n "$was_updater" ]; then
      echo "The stuck update (pid $holder) is already gone, not stopping it."
    fi
    if [ -d "$LOCK_DIR" ]; then
      echo "Taking over an abandoned update lock (pid ${holder:-unknown})"
      stale="$LOCK_DIR.stale.$$"
      if mv "$LOCK_DIR" "$stale" 2>/dev/null; then
        rm -rf "$stale"
      fi
    fi
    # Still inside the mutex: the taker gets the lock, nobody can slip in
    # between the removal and the re-creation.
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      write_lock_pid
      HAVE_LOCK=1
      release_takeover_mutex
      return 0
    fi
    release_takeover_mutex
  done
  write_lock_pid
  HAVE_LOCK=1
}
# The lock and the temp dir go away however the script exits: the EXIT trap
# (on_exit, near the top) runs cleanup, and was set before the lock is taken
# so no exit path can leak it; a busy exit never held it.
acquire_lock
test_gate "${GAFFER_UPDATE_TEST_HOLD_GATE:-}"

# Stop whatever holds the daemon's WebSocket port (9823), reliable regardless
# of how it was launched (`node index.js`, `env node index.js`, or the
# bundled runtime running daemon.mjs). Nothing else is stopped: no process
# name patterns (a pattern also matches unrelated command lines, such as a
# `tail -f /tmp/gaffer-daemon.log`).
# Graceful first: SIGTERM lets a v0.9.5+ daemon drain in-flight work then exit;
# SIGKILL only if it outlives the window.
stop_daemon() {
  local pids i
  pids="$(lsof -nP -iTCP:9823 -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -n "$pids" ] || return 0
  echo "Stopping daemon (pids: $pids)"
  kill -TERM $pids 2>/dev/null || true
  # Wait for a graceful drain, past the 60s JSX cap the daemon honours.
  for i in $(seq 1 140); do
    lsof -nP -iTCP:9823 -sTCP:LISTEN -t >/dev/null 2>&1 || { echo "Daemon stopped."; return 0; }
    sleep 0.5
  done
  echo "Daemon did not exit in time, forcing."
  kill -KILL $(lsof -nP -iTCP:9823 -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true
}

# Never overwrite a development checkout, a dev install symlinks the panel
# out of a git repo; rsync --delete would clobber uncommitted work.
if [ -d "$PANEL_DIR/../.git" ] || [ -d "$PANEL_DIR/.git" ]; then
  echo "ERROR: panel dir is inside a git repo (dev install), refusing to update. Use git pull instead."
  result_line "err:dev-install"
  exit 1
fi

# ---- runtime step (spec 6) ----
# The daemon runs on a pinned, official Node binary at daemon/runtime/node
# (with VERSION "<version> <platform>" and VERIFIED "<size> <sha256>" next to
# it). The release's own fetch-runtime.sh decides from the release's
# runtime-pins.json whether it is current; if not it downloads, verifies and
# stages the new one in daemon/runtime.new while the daemon still runs. Only
# after the daemon is stopped is it swapped in with two renames on one
# volume: runtime -> runtime.old, runtime.new -> runtime, then runtime.old
# is deleted. An updater killed between the renames leaves runtime.old and
# no runtime; the next run puts it back first (recover_runtime).
#
# Sizes come from GNU stat first, then BSD stat: on Linux `stat -f` means
# "file system status" and prints something else without failing.
file_size_bytes() {
  local n
  n="$(stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null)" || return 1
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  echo "$n"
}
# True when <dir>/node is a regular file whose size equals the size recorded
# in <dir>/VERIFIED (the same check the panel makes before it launches it).
runtime_dir_ok() {
  local dir="$1" want have
  [ -f "$dir/node" ] && [ ! -L "$dir/node" ] || return 1
  want="$(awk '{print $1; exit}' "$dir/VERIFIED" 2>/dev/null || true)"
  case "$want" in ''|*[!0-9]*) return 1 ;; esac
  have="$(file_size_bytes "$dir/node")" || return 1
  [ "$have" = "$want" ]
}
# Runs before anything else is fetched or changed. A runtime.old that fails
# the size check is not restored; the stage below then provisions a fresh
# runtime and the swap clears it.
recover_runtime() {
  local rt="$DAEMON_DIR/runtime"
  if [ ! -e "$rt" ] && [ ! -L "$rt" ] && [ -d "$rt.old" ]; then
    if runtime_dir_ok "$rt.old"; then
      echo "Restoring daemon/runtime from runtime.old (an earlier update stopped between its two renames)"
      mv "$rt.old" "$rt" || return 1
    else
      echo "Found daemon/runtime.old with no runtime, but it fails the size check, not restoring it"
    fi
  fi
  if [ -e "$rt.new" ] || [ -L "$rt.new" ]; then
    echo "Removing a leftover daemon/runtime.new"
    rm -rf "$rt.new" || return 1
  fi
  if { [ -e "$rt" ] || [ -L "$rt" ]; } && { [ -e "$rt.old" ] || [ -L "$rt.old" ]; }; then
    echo "Removing a leftover daemon/runtime.old"
    rm -rf "$rt.old" || return 1
  fi
  return 0
}
# Runs the ARCHIVE's fetch-runtime.sh (the release being installed knows its
# own pins). Its last line decides: runtime:current, nothing to do;
# runtime:installed <version> <platform>, a verified runtime.new with its
# stamps is staged and the swap is needed; anything else is a failure, and
# runtime.new is deleted so the install is exactly as it was.
RUNTIME_STAGED=""
stage_runtime() {
  local script="$EXTRACT_DIR/daemon/fetch-runtime.sh" out="$TMP_DIR/fetch-runtime.out" rc=0 last
  RUNTIME_STAGED=""
  if [ ! -f "$script" ] || [ ! -f "$EXTRACT_DIR/daemon/runtime-pins.json" ]; then
    echo "The release has no daemon/fetch-runtime.sh or daemon/runtime-pins.json"
    return 1
  fi
  echo "Checking Gaffer's runtime..."
  bash "$script" --stage-only --into "$DAEMON_DIR" ${REPAIR:+--force} > "$out" 2>&1 || rc=$?
  cat "$out"
  last="$(tail -n 1 "$out")"
  if [ "$rc" = 0 ] && [ "$last" = "runtime:current" ]; then
    return 0
  fi
  if [ "$rc" = 0 ]; then
    case "$last" in
      "runtime:installed "*)
        if runtime_dir_ok "$DAEMON_DIR/runtime.new"; then RUNTIME_STAGED=1; return 0; fi
        echo "fetch-runtime.sh reported a staged runtime, but runtime.new fails the size check" ;;
    esac
  fi
  rm -rf "$DAEMON_DIR/runtime.new"
  return 1
}
# Called with the daemon stopped: a running binary cannot be replaced on
# Windows, and on macOS nothing should exec a half-moved runtime.
swap_runtime() {
  local rt="$DAEMON_DIR/runtime"
  [ -n "$RUNTIME_STAGED" ] || return 0
  rm -rf "$rt.old" || return 1
  if [ -e "$rt" ] || [ -L "$rt" ]; then
    mv "$rt" "$rt.old" || return 1
  fi
  test_gate "${GAFFER_UPDATE_TEST_SWAP_GATE:-}"
  if ! mv "$rt.new" "$rt"; then
    if [ -e "$rt.old" ] && [ ! -e "$rt" ]; then mv "$rt.old" "$rt" || true; fi
    return 1
  fi
  rm -rf "$rt.old" || true
  echo "Runtime swapped in: $(cat "$rt/VERSION" 2>/dev/null || true)"
}
# ---- end runtime step ----

if ! recover_runtime; then
  echo "ERROR: could not repair daemon/runtime from an earlier interrupted update"
  result_line "err:runtime-swap"
  exit 1
fi

# Download the release asset and extract it into a SUBFOLDER of TMP_DIR, so
# the downloaded archive itself is never synced into the panel dir.
# Download budget: the asset is a few MB. An attempt is abandoned when the
# connection takes over 15s or the speed stays under 2 KB/s for 20s (a hung
# proxy, a dropped link), and --max-time caps each attempt at 150s, which
# also fails any link slower than asset size / 150s (about 20 KB/s for a
# 3 MB asset). curl retries such timeouts twice, but --retry-max-time 120
# only lets a retry START while less than 120s have passed since the first
# attempt began. Worst case: the first attempt dies just under 120s, the
# second runs its full 150s, no third starts: about 270s of download, then
# extract, the runtime step and rsync. The runtime step downloads nothing
# when the runtime is current (the normal case); when the pins changed it
# fetches about 54 MB under fetch-runtime.sh's own limits. The panel
# (main.js waitForUpdatedVersion) gives up after 180s but extends once by
# 180s while this lock is held, a 360s window; a worst-case download or a
# runtime download on a slow link can outlive it, and then the panel offers
# "Force stop & retry", whose second updater exits busy against this lock,
# so a slow run is never corrupted, only late. A 4xx answer (404 on a
# missing asset) is final: curl does not retry it.
if ! mkdir -p "$EXTRACT_DIR"; then
  echo "ERROR: could not create the temporary folder $EXTRACT_DIR (disk full or read-only?)"
  result_line "err:internal"
  exit 1
fi
echo "Downloading $ASSET_SOURCE"
# Wrapped so a curl or tar failure (which under set -e would end the script
# with curl's own message as the last log line) still ends the log with an
# ERROR line and err:download, the contract the panel and a reader rely on.
download_and_extract() {
  case "$ASSET_SOURCE" in
    http://*|https://*) curl -fsSL --connect-timeout 15 --speed-limit 2048 --speed-time 20 --max-time 150 --retry 2 --retry-max-time 120 "$ASSET_SOURCE" -o "$TMP_DIR/$ASSET_NAME" || return 1 ;;
    *) cp "$ASSET_SOURCE" "$TMP_DIR/$ASSET_NAME" || return 1 ;;
  esac
  tar -xzf "$TMP_DIR/$ASSET_NAME" -C "$EXTRACT_DIR" || return 1
}
if ! download_and_extract; then
  echo "ERROR: download or extract failed"
  result_line "err:download"
  exit 1
fi
# New archives always carry daemon/daemon.mjs (the bundle) and daemon/index.js
# (the one-line shim 0.11.x updaters check for), so both generations of the
# check pass on them. A pre-bundle archive has no daemon.mjs and nothing to
# run it with here: refused.
if [ ! -f "$EXTRACT_DIR/version.json" ] || [ ! -f "$EXTRACT_DIR/daemon/daemon.mjs" ]; then
  echo "ERROR: downloaded archive is not a Gaffer release (missing version.json or daemon/daemon.mjs)"
  result_line "err:archive"
  exit 1
fi

# Version and commit come from the archive's own version.json, which the
# release workflow stamps. Nothing is read from raw.githubusercontent.com.
json_field() {
  grep -o "\"$1\": *\"[^\"]*\"" "$2" | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true
}
LATEST_VERSION="$(json_field version "$EXTRACT_DIR/version.json")"
LATEST_COMMIT="$(json_field commit "$EXTRACT_DIR/version.json")"
if [ -z "$LATEST_VERSION" ]; then
  echo "ERROR: release version.json has no version"
  result_line "err:archive"
  exit 1
fi
echo "Release: v$LATEST_VERSION ($LATEST_COMMIT)"

# Before any file of the install is replaced, with the daemon still running.
if ! stage_runtime; then
  echo "ERROR: could not stage Gaffer's runtime, nothing was changed"
  result_line "err:runtime"
  exit 1
fi

# Backup chat history, legacy single file plus per-AE-version files
# (chat-history-<aeVersion>.json, e.g. chat-history-26.0.json), and
# .gaffer-config.json (claudeBin, installId, shareUsageStats, etc.): without
# this it's silently wiped by rsync --delete on every update. Wrapped like
# download_and_extract: nothing has changed yet, a backup that cannot be
# written (a full disk) ends the run with err:internal before anything does.
BACKUP=""
HISTORY_BACKUP_DIR="$TMP_DIR/chat-history-backups"
CONFIG_BACKUP=""
backup_user_data() {
  local f
  if [ -f "$PANEL_DIR/chat-history.json" ]; then
    BACKUP="$TMP_DIR/chat-history.backup.json"
    cp "$PANEL_DIR/chat-history.json" "$BACKUP" || return 1
  fi
  mkdir -p "$HISTORY_BACKUP_DIR" || return 1
  for f in "$PANEL_DIR"/chat-history-*.json; do
    [ -e "$f" ] || continue
    cp "$f" "$HISTORY_BACKUP_DIR/" || return 1
  done
  if [ -f "$PANEL_DIR/.gaffer-config.json" ]; then
    CONFIG_BACKUP="$TMP_DIR/gaffer-config.backup.json"
    cp "$PANEL_DIR/.gaffer-config.json" "$CONFIG_BACKUP" || return 1
  fi
}
if ! backup_user_data; then
  echo "ERROR: could not back up the chat history and settings to the temporary folder (disk full?), nothing was changed"
  result_line "err:internal"
  exit 1
fi

# Stop existing daemon (panel will detect disconnect and continue)
echo "Stopping daemon..."
stop_daemon

if ! swap_runtime; then
  echo "ERROR: could not move the new runtime into place"
  result_line "err:runtime-swap"
  exit 1
fi

# Sync new files into panel dir (overwrite, but preserve user data).
# version.json is excluded here and written LAST (below): the panel reloads
# and the daemon self-restarts the moment it changes. The usage-stats buffer
# and icon cache are not in the archive; excluding them also protects them
# from --delete. The runtime folders are not in the archive either and are
# excluded (anchored to daemon/) so --delete never removes them; the old
# daemon/node_modules is NOT excluded any more, so the sync deletes the
# leftover tree from 0.11.x and earlier. Stays non --inplace so this running script is never
# overwritten in place.
echo "Replacing files..."
# Wrapped like download_and_extract: under set -e a failing rsync would end
# the script with rsync's own message as the last log line.
sync_files() {
  rsync -a --delete \
    --exclude 'chat-history.json' \
    --exclude 'chat-history-*.json' \
    --exclude '.gaffer-config.json' \
    --exclude '/daemon/runtime' \
    --exclude '/daemon/runtime.new' \
    --exclude '/daemon/runtime.old' \
    --exclude 'daemon/dist' \
    --exclude '/version.json' \
    --exclude '/.gaffer-usage-buffer.json' \
    --exclude '/.gaffer-icons' \
    "$EXTRACT_DIR/" "$PANEL_DIR/" || return 1
}
if ! sync_files; then
  echo "ERROR: replacing the panel files failed (rsync)"
  result_line "err:sync"
  exit 1
fi

# Restore chat history and .gaffer-config.json. rsync excluded them, so a
# failure here leaves them as they were; it still ends with err:sync, the
# files were replaced and the run is not finished.
restore_user_data() {
  local f
  if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$PANEL_DIR/chat-history.json" || return 1
  fi
  for f in "$HISTORY_BACKUP_DIR"/chat-history-*.json; do
    [ -e "$f" ] || continue
    cp "$f" "$PANEL_DIR/" || return 1
  done
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$PANEL_DIR/.gaffer-config.json" || return 1
  fi
}
if ! restore_user_data; then
  echo "ERROR: could not restore the chat history and settings after replacing the panel files"
  result_line "err:sync"
  exit 1
fi

# Stop any daemon that respawned from the half-copied tree during the update
# (the panel pauses auto-start now, but belt and braces), the panel reloads
# when version.json changes and boots a clean daemon.
stop_daemon

# LAST step: put the release's version.json in place with an atomic rename,
# so the panel and daemon only ever see the old file or the complete new one.
if ! { cp "$EXTRACT_DIR/version.json" "$PANEL_DIR/version.json.tmp" && mv -f "$PANEL_DIR/version.json.tmp" "$PANEL_DIR/version.json"; }; then
  rm -f "$PANEL_DIR/version.json.tmp"
  echo "ERROR: could not write version.json after replacing the panel files"
  result_line "err:sync"
  exit 1
fi

echo "=== Update complete: $(date) ==="
result_line "ok:$LATEST_VERSION"
