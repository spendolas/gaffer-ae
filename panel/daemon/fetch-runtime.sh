#!/bin/bash
# fetch-runtime.sh [--into <daemon-dir>] [--stage-only] [--force]
#
# Puts the pinned, official, unmodified Node runtime at <daemon-dir>/runtime/node
# (spec section 3). Pins come from runtime-pins.json next to this script.
#
#   steps 1-7: platform, skip check, download (official, then mirror), archive
#              SHA-256, extract only bin/node into runtime.new, verify size,
#              SHA-256 and the Apple signature, smoke run --version.
#   steps 8-9: swap runtime -> runtime.old, runtime.new -> runtime, delete
#              runtime.old and the temp folder.
#
# --stage-only stops after step 7 and leaves a verified runtime.new (with its
# VERSION and VERIFIED stamps already written) for the updater to swap in.
#
# --force skips the step 2 skip check: a runtime that looks current is
# downloaded and verified again and swapped in as a new file. The updater's
# repair mode (update.sh --repair, from the panel's Repair button) uses it for
# a runtime the launch refused although its stamps match (macOS killing it at
# exec, an exec bit chmod could not restore).
#
# Output: progress lines, then exactly one last line:
#   runtime:current | runtime:installed <version> <platform> | err:runtime
#
# Writes only inside <daemon-dir> (runtime.new, runtime, runtime.old) and one
# mktemp folder under $TMPDIR that is always removed. Needs only stock macOS
# tools (bash 3.2, curl, shasum, tar, codesign, sed, grep): no jq, no node.
#
# Test seams, honoured only when GAFFER_FETCH_TEST=1:
#   GAFFER_FETCH_PINS            pins file path
#   GAFFER_FETCH_BASE_OFFICIAL   official base URL (may be file:// or http://)
#   GAFFER_FETCH_BASE_MIRROR     mirror base URL
#   GAFFER_FETCH_PLATFORM        platform key (darwin-x64, darwin-arm64)
#   GAFFER_FETCH_SKIP_CODESIGN=1 skip the signature checks (fake archives)
#   GAFFER_FETCH_SPEED_TIME      seconds below 10 KB/s before an attempt aborts
#   GAFFER_FETCH_MAX_TIME        per-attempt and per-source retry budget, seconds
#
# Download budget (a deliberate change from spec section 3 step 3, which says
# --max-time 600): a 54 MB archive cannot finish in 600 s on a slow link, and
# curl retries a timed-out attempt, so 600 s capped attempts cost up to about
# 4 x 600 s per source without ever succeeding. Instead an attempt aborts only
# when it stalls (below 10 KB/s for 60 s: --speed-limit/--speed-time), each
# attempt is capped at 1800 s, and --retry-max-time 1800 stops new retries
# after 30 minutes on one source. --connect-timeout 20 --retry 3
# --retry-delay 2 are as in the spec.
set -u
# Stock tools only: never a Homebrew/conda curl, tar or shasum.
PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INTO="$SCRIPT_DIR"
STAGE_ONLY=0
FORCE=0
PLACEHOLDER="PENDING-FIRST-ACCEPTANCE-RUN"

say() { echo "runtime: $*"; }
die() { [ $# -gt 0 ] && say "$*"; echo "err:runtime"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --into) [ $# -ge 2 ] || die "--into needs a folder"; INTO="$2"; shift 2 ;;
    --stage-only) STAGE_ONLY=1; shift ;;
    --force) FORCE=1; shift ;;
    *) die "unknown argument $1" ;;
  esac
done

[ -d "$INTO" ] || die "folder not found: $INTO"
INTO=$(CDPATH= cd -- "$INTO" && pwd) || die "cannot open $INTO"

TEST_MODE=0
[ "${GAFFER_FETCH_TEST:-}" = "1" ] && TEST_MODE=1

PINS="$SCRIPT_DIR/runtime-pins.json"
[ "$TEST_MODE" = 1 ] && [ -n "${GAFFER_FETCH_PINS:-}" ] && PINS="$GAFFER_FETCH_PINS"
[ -f "$PINS" ] || die "pins file not found: $PINS"

# ---- pins (flat JSON read with grep/sed; the file is ours and simple) ----
PINS_FLAT=$(tr '\n\r\t' '   ' < "$PINS")

# pin_str <text> <key>: first "key": "value" in <text>
pin_str() {
  printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 \
    | sed 's/.*:[[:space:]]*"\([^"]*\)"$/\1/'
}
# pin_num <text> <key>: first "key": 123 in <text>
pin_num() {
  printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*[0-9][0-9]*" | head -n 1 \
    | sed 's/.*:[[:space:]]*//'
}

# ---- step 1: platform ----
if [ "$TEST_MODE" = 1 ] && [ -n "${GAFFER_FETCH_PLATFORM:-}" ]; then
  PLAT="$GAFFER_FETCH_PLATFORM"
elif [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  PLAT="darwin-arm64"   # uname -m says x86_64 under Rosetta, sysctl does not
else
  PLAT="darwin-x64"
fi
case "$PLAT" in *[!a-z0-9-]*|"") die "bad platform key" ;; esac

VER=$(pin_str "$PINS_FLAT" version)
BASE_OFFICIAL=$(pin_str "$PINS_FLAT" official)
BASE_MIRROR=$(pin_str "$PINS_FLAT" mirror)
TEAM_ID=$(pin_str "$PINS_FLAT" darwinTeamId)
PLAT_BLOCK=$(printf '%s' "$PINS_FLAT" | grep -o "\"$PLAT\"[[:space:]]*:[[:space:]]*{[^}]*}" | head -n 1)
[ -n "$PLAT_BLOCK" ] || die "no pin for platform $PLAT"
ARCHIVE=$(pin_str "$PLAT_BLOCK" archive)
ARCHIVE_SHA=$(pin_str "$PLAT_BLOCK" archiveSha256)
MEMBER=$(pin_str "$PLAT_BLOCK" member)
BIN_BYTES=$(pin_num "$PLAT_BLOCK" binaryBytes)
BIN_SHA=$(pin_str "$PLAT_BLOCK" binarySha256)

[ -n "$VER" ] && [ -n "$BASE_OFFICIAL" ] && [ -n "$BASE_MIRROR" ] && [ -n "$TEAM_ID" ] \
  && [ -n "$ARCHIVE" ] && [ -n "$ARCHIVE_SHA" ] && [ -n "$MEMBER" ] && [ -n "$BIN_BYTES" ] \
  && [ -n "$BIN_SHA" ] || die "pins file is incomplete for $PLAT"
case "$ARCHIVE" in */*|*..*) die "bad archive name in pins" ;; esac
case "$MEMBER" in /*|*..*|*/*/*/*) die "bad member path in pins" ;; */*/node) ;; *) die "bad member path in pins" ;; esac

if [ "$TEST_MODE" = 1 ]; then
  [ -n "${GAFFER_FETCH_BASE_OFFICIAL:-}" ] && BASE_OFFICIAL="$GAFFER_FETCH_BASE_OFFICIAL"
  [ -n "${GAFFER_FETCH_BASE_MIRROR:-}" ] && BASE_MIRROR="$GAFFER_FETCH_BASE_MIRROR"
  PROTO="=https,http,file"
else
  PROTO="=https"
fi
SPEED_TIME=60
MAX_TIME=1800
if [ "$TEST_MODE" = 1 ]; then
  case "${GAFFER_FETCH_SPEED_TIME:-}" in ''|*[!0-9]*) ;; *) SPEED_TIME="$GAFFER_FETCH_SPEED_TIME" ;; esac
  case "${GAFFER_FETCH_MAX_TIME:-}" in ''|*[!0-9]*) ;; *) MAX_TIME="$GAFFER_FETCH_MAX_TIME" ;; esac
fi

RT="$INTO/runtime"
RT_NEW="$INTO/runtime.new"
RT_OLD="$INTO/runtime.old"
WANT_STAMP="$VER $PLAT"

# GNU stat first: on Linux (CI) 'stat -f' means filesystem status.
file_size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null; }
file_sha() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  else sha256sum "$1" 2>/dev/null | awk '{print $1}'; fi
}
# size_ok <dir>: <dir>/node exists and its size equals the first field of <dir>/VERIFIED
size_ok() {
  [ -f "$1/node" ] && [ -f "$1/VERIFIED" ] || return 1
  local want
  want=$(awk '{print $1; exit}' "$1/VERIFIED" 2>/dev/null)
  [ -n "$want" ] && [ "$want" = "$(file_size "$1/node")" ]
}

# Recovery (spec 6.8): a run killed between the two renames leaves no
# runtime but a good runtime.old. Put it back before anything else.
if [ ! -e "$RT" ] && [ ! -L "$RT" ] && size_ok "$RT_OLD"; then
  mv "$RT_OLD" "$RT" && say "restored runtime from runtime.old"
fi

# ---- step 2: skip check (VERSION is the only key for "download or not") ----
if [ "$FORCE" = 1 ]; then
  say "--force: re-provisioning $WANT_STAMP whatever is installed"
elif [ -f "$RT/VERSION" ] && [ "$(cat "$RT/VERSION" 2>/dev/null)" = "$WANT_STAMP" ] && size_ok "$RT"; then
  # A stale staged runtime.new must not be swapped in later by an updater.
  rm -rf "$RT_NEW"
  echo "runtime:current"
  exit 0
fi

# ---- temp folder and cleanup ----
# A SIGKILLed run cannot clean up and would leak up to 54 MB: sweep our own
# temp folders (exact name pattern, owned by this user, older than 24 h).
find "${TMPDIR:-/tmp}" -mindepth 1 -maxdepth 1 -type d -name 'gaffer-runtime-??????' \
  -user "$(id -u)" -mtime +0 -exec rm -rf {} + 2>/dev/null

TMP=$(mktemp -d "${TMPDIR:-/tmp}/gaffer-runtime-XXXXXX") || die "cannot create a temp folder"
CHILD=""
DONE=0
SWAPPING=0
cleanup() {
  [ -n "$CHILD" ] && kill "$CHILD" 2>/dev/null
  rm -rf "$TMP"
  # A failed or interrupted run never leaves a half-staged runtime.new, except
  # mid-swap: then runtime.new is the verified runtime and must survive (the
  # next run restores runtime.old if runtime is missing).
  [ "$DONE" = 1 ] || [ "$SWAPPING" = 1 ] || rm -rf "$RT_NEW"
}
on_signal() { cleanup; echo "err:runtime"; trap - EXIT; exit "$1"; }
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap cleanup EXIT

say "need $VER $PLAT"
rm -rf "$RT_NEW" || die "cannot clear $RT_NEW"

# ---- step 3 and 4: download, verify the archive hash ----
# download <base>: fetch <base><archive> to $TMP and check its SHA-256.
# curl runs in the background and is waited on so INT/TERM reach the trap now.
download() {
  rm -f "$TMP/$ARCHIVE"
  curl --fail --proto "$PROTO" --location --connect-timeout 20 \
       --speed-limit 10240 --speed-time "$SPEED_TIME" --max-time "$MAX_TIME" --retry-max-time "$MAX_TIME" \
       --retry 3 --retry-delay 2 --silent --show-error \
       -o "$TMP/$ARCHIVE" "$1$ARCHIVE" 2>"$TMP/curl.err" &
  CHILD=$!; wait "$CHILD"; local rc=$?; CHILD=""
  if [ "$rc" != 0 ]; then
    say "download from $1 failed (curl exit $rc): $(head -c 300 "$TMP/curl.err" | tr '\n' ' ')"
    rm -f "$TMP/$ARCHIVE"
    return 1
  fi
  local got
  got=$(file_sha "$TMP/$ARCHIVE")
  if [ "$got" != "$ARCHIVE_SHA" ]; then
    say "download from $1 did not match the expected checksum (got $got, $(file_size "$TMP/$ARCHIVE") bytes)"
    rm -f "$TMP/$ARCHIVE"
    return 1
  fi
  return 0
}

say "downloading $ARCHIVE"
if ! download "$BASE_OFFICIAL"; then
  say "official download failed, using the mirror"
  download "$BASE_MIRROR" || die "could not download a verified runtime from nodejs.org or the mirror"
fi
say "archive checksum verified"

# ---- step 5: extract only the binary into runtime.new ----
mkdir "$RT_NEW" || die "cannot create $RT_NEW"
if ! tar -xzf "$TMP/$ARCHIVE" -C "$RT_NEW" --strip-components=2 "$MEMBER" 2>"$TMP/tar.err"; then
  die "extract failed: $(head -c 200 "$TMP/tar.err" | tr '\n' ' ')"
fi
BIN="$RT_NEW/node"
[ -f "$BIN" ] && [ ! -L "$BIN" ] || die "the archive has no $MEMBER"
rm -f "$TMP/$ARCHIVE"

# ---- step 6: verify the binary ----
got_size=$(file_size "$BIN")
[ "$got_size" = "$BIN_BYTES" ] || die "binary size $got_size, expected $BIN_BYTES"
got_bsha=$(file_sha "$BIN")
if [ "$BIN_SHA" = "$PLACEHOLDER" ]; then
  say "binary hash not pinned yet, checking size and signature only (sha256 $got_bsha)"
else
  [ "$got_bsha" = "$BIN_SHA" ] || die "binary checksum $got_bsha, expected $BIN_SHA"
fi
if [ "$TEST_MODE" = 1 ] && [ "${GAFFER_FETCH_SKIP_CODESIGN:-}" = "1" ]; then
  say "signature check skipped (test mode)"
else
  /usr/bin/codesign --verify --strict "$BIN" 2>"$TMP/cs.err" \
    || die "signature could not be verified: $(head -c 200 "$TMP/cs.err" | tr '\n' ' ')"
  team=$(/usr/bin/codesign -dv "$BIN" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -n 1)
  [ "$team" = "$TEAM_ID" ] || die "signature team is '$team', expected $TEAM_ID"
  say "signature verified (TeamIdentifier=$team)"
fi
chmod 755 "$BIN" || die "cannot set the exec bit"

# ---- step 7: smoke run ----
got_ver=$("$BIN" --version 2>"$TMP/run.err" </dev/null) \
  || die "runtime does not run on this machine: $(head -c 200 "$TMP/run.err" | tr '\n' ' ')"
[ "$got_ver" = "$VER" ] || die "runtime reports '$got_ver', expected $VER"

# Stamps travel inside runtime.new, so the swap below is two renames and a
# staged runtime.new is complete on its own.
printf '%s\n' "$WANT_STAMP" > "$RT_NEW/VERSION" || die "cannot write VERSION"
printf '%s %s\n' "$got_size" "$got_bsha" > "$RT_NEW/VERIFIED" || die "cannot write VERIFIED"

if [ "$STAGE_ONLY" = 1 ]; then
  DONE=1
  say "staged in runtime.new"
  echo "runtime:installed $VER $PLAT"
  exit 0
fi

# ---- step 8: swap ----
if [ -e "$RT" ] || [ -L "$RT" ]; then
  rm -rf "$RT_OLD" || die "cannot clear $RT_OLD"
  # From here a signal keeps runtime.new (cleanup checks SWAPPING).
  SWAPPING=1
  mv "$RT" "$RT_OLD" || { SWAPPING=0; die "cannot move the old runtime aside"; }
fi
SWAPPING=1
if ! mv "$RT_NEW" "$RT"; then
  [ -e "$RT_OLD" ] && mv "$RT_OLD" "$RT"
  SWAPPING=0
  die "cannot move the new runtime into place"
fi
DONE=1
rm -rf "$RT_OLD"

# ---- step 9: temp folder removed by the EXIT trap ----
echo "runtime:installed $VER $PLAT"
exit 0
