// Run from the repo root: node --test scripts/updater-scripts.test.mjs
// Text-level pins for the updater and installer scripts. Their behavior is
// exercised end to end by scripts/test-update-sh.sh (macOS) and
// scripts/windows-tests/test-5-update-ps1.ps1 (Windows VM); these checks
// keep the specific fixes from the v0.11.2 review from quietly regressing
// on the platform a developer is not running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
// Runs a snippet of update.sh (a function or a case block, cut out by its
// first and last line) under bash with the given environment, and returns
// {status, stdout}. Lets the pure shell pieces be checked for behavior, not
// just text, on any platform with bash.
function runShSnippet(text, first, last, body, env) {
  const start = text.indexOf(first);
  const end = text.indexOf(last, start);
  assert.ok(start !== -1 && end !== -1, 'snippet not found: ' + first);
  const snippet = text.slice(start, end + last.length);
  const r = spawnSync('bash', ['-c', 'set -euo pipefail\n' + snippet + '\n' + body], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}
const sh = read('../panel/daemon/update.sh');
const ps1 = read('../panel/daemon/update.ps1');
const mainJs = read('../panel/main.js');
const installMac = read('../scripts/install-mac.sh');
const installWin = read('../scripts/install-win.ps1');

test('update.sh download limits bound stalls and slow links, and the comment is honest about the panel window', () => {
  const line = sh.split('\n').find((l) => l.includes('curl -fsSL'));
  assert.ok(line, 'no curl download line');
  for (const flag of ['--connect-timeout 15', '--speed-limit 2048', '--speed-time 20', '--max-time 150', '--retry 2', '--retry-max-time 120']) {
    assert.ok(line.includes(flag), 'curl line is missing ' + flag);
  }
  assert.ok(!line.includes('--max-time 35'));
  assert.ok(sh.includes('360s'), 'comment reasons about the panel window (180s plus one extension)');
  assert.ok(sh.includes('fails any link slower than asset size / 150s'), 'comment admits --max-time also fails slow links');
  assert.ok(!sh.includes('so the whole run has 360s'), 'comment no longer claims the whole run fits the panel window');
  assert.ok(sh.includes('can outlive it'), 'comment says a slow run can outlive the panel window');
});

test('update.sh takes over a stale lock by atomic rename and treats a seconds-old pid-less lock as busy', () => {
  assert.ok(sh.includes('mv "$LOCK_DIR" "$stale"'), 'takeover is not a rename');
  assert.ok(sh.includes('stale="$LOCK_DIR.stale.$$"'));
  assert.ok(!/^\s*rm -rf "\$LOCK_DIR"\s*$/m.test(sh.split('cleanup()')[0]), 'acquire_lock still deletes the lock dir in place');
  assert.ok(sh.includes('lock_is_young'));
  assert.ok(sh.includes('[ -z "$holder" ] && lock_is_young'));
  const young = sh.split('lock_is_young() {')[1].split('\n}\n')[0];
  assert.ok(young.includes('[ "$age" -ge -300 ] && [ "$age" -lt 30 ]'), 'young means under 30 seconds, up to 300 s of clock skew tolerated');
});

test('update.sh never stops a live holder on a negative age, tolerates 300 s of skew, and guards against pid reuse by process age', () => {
  const old = sh.split('lock_is_old() {')[1].split('\n}\n')[0];
  assert.ok(old.includes('[ "$age" -ge "$STUCK_AFTER" ]'), 'old means older than the stuck age');
  assert.ok(!old.includes('-lt 0'), 'a negative age never makes a lock old (a live holder stays busy)');
  assert.ok(sh.includes('STUCK_AFTER=900'), 'the stuck age is 15 minutes');
  assert.ok(sh.includes('if [ -n "${GAFFER_UPDATE_ASSET:-}" ] && [ "${#GAFFER_UPDATE_TEST_STUCK_AFTER}" -le 5 ]'), 'the harness may lower it, only next to GAFFER_UPDATE_ASSET and with at most 5 digits');
  assert.ok(sh.includes('STUCK_AFTER="$((10#$GAFFER_UPDATE_TEST_STUCK_AFTER))"'), 'the override is read as decimal');
  assert.ok(sh.includes('marker_is_stale() { [ "$1" -ge 60 ] || [ "$1" -lt -300 ]; }'), 'a marker is stale past 60 s or more than 300 s in the future');
  assert.ok(sh.includes('if [ "$age" -lt -300 ]; then\n    echo "Removing a takeover marker dated in the future'), 'the future-dated log line follows the same tolerance');
  assert.ok(!/\[ "\$age" -lt 0 \]/.test(sh), 'no bare negative-age rule is left');
  const holder = sh.split('lock_holder_is_updater() {')[1].split('\n}\n')[0];
  assert.ok(holder.includes('etime_seconds "$(ps -o etime= -p "$pid" 2>/dev/null)"'), 'process age comes from ps etime');
  assert.ok(holder.includes('if lock_age="$(dir_age_seconds "$LOCK_DIR")" && [ "$lock_age" -ge 0 ]'), 'the age comparison is skipped for a lock dated in the future or one that cannot be stat\'ed');
  assert.ok(holder.includes('if [ "$proc_age" -lt $((lock_age - 5)) ]; then HOLDER_PID_REUSED=1; return 1; fi'), 'a process younger than the lock (less 5 s) is a reused pid, not the holder');
  assert.ok(holder.indexOf("grep -Eq '(^|[[:space:]/])update\\.sh([[:space:]]|$)' || return 1") < holder.indexOf('etime_seconds'), 'the name match still comes first');
  assert.ok(sh.includes('(pid reused), not to the update that wrote it.'), 'a reused pid is logged before the takeover');
  // The etime parser accepts the three formats ps prints and nothing else.
  const et = sh.split('etime_seconds() {')[1].split('\n}\n')[0];
  assert.ok(et.includes('case "$et" in *-*) days="${et%%-*}"; et="${et#*-}" ;; esac'), 'dd-hh:mm:ss');
  assert.ok(et.includes('if [ -z "$c" ]; then c="$b"; b="$a"; a=0; fi'), 'mm:ss');
  assert.ok(et.includes('10#$days * 86400 + 10#$a * 3600 + 10#$b * 60 + 10#$c'), 'leading zeros are decimal, not octal');
});

test('update.sh honours the stuck-age knob only next to GAFFER_UPDATE_ASSET, for 1 to 86400, and never crashes on a huge value (run under bash)', () => {
  const run = (env) => runShSnippet(sh, 'case "${GAFFER_UPDATE_TEST_STUCK_AFTER:-}" in', '\nesac', 'echo "$STUCK_AFTER"', { STUCK_AFTER: '900', ...env });
  assert.equal(run({ GAFFER_UPDATE_ASSET: '/x.tgz', GAFFER_UPDATE_TEST_STUCK_AFTER: '3' }).stdout, '3', 'harness setting honoured');
  assert.equal(run({ GAFFER_UPDATE_TEST_STUCK_AFTER: '3' }).stdout, '900', 'a stray knob without GAFFER_UPDATE_ASSET is ignored');
  assert.equal(run({ GAFFER_UPDATE_ASSET: '/x.tgz', GAFFER_UPDATE_TEST_STUCK_AFTER: '0' }).stdout, '900', 'zero is ignored');
  assert.equal(run({ GAFFER_UPDATE_ASSET: '/x.tgz', GAFFER_UPDATE_TEST_STUCK_AFTER: '86401' }).stdout, '900', 'over a day is ignored');
  const huge = run({ GAFFER_UPDATE_ASSET: '/x.tgz', GAFFER_UPDATE_TEST_STUCK_AFTER: '99999999999999999999999999' });
  assert.equal(huge.status, 0, 'a huge value does not crash: ' + huge.stderr);
  assert.equal(huge.stdout, '900', 'a huge value is ignored');
  assert.equal(run({ GAFFER_UPDATE_ASSET: '/x.tgz', GAFFER_UPDATE_TEST_STUCK_AFTER: '3x' }).stdout, '900', 'non-digits are ignored');
  assert.equal(run({ GAFFER_UPDATE_ASSET: '/x.tgz', GAFFER_UPDATE_TEST_STUCK_AFTER: '007' }).stdout, '7', 'leading zeros are decimal');
});

test('update.sh dir_age_seconds fails, rather than reporting a huge age, when the path cannot be stat\'ed (run under bash)', () => {
  const missing = runShSnippet(sh, 'dir_age_seconds() {', '\n}', 'if dir_age_seconds /nonexistent/gaffer-lock; then echo "ok:$?"; else echo "fail:$?"; fi', {});
  assert.equal(missing.stdout, 'fail:1', 'a missing path is a failure, not age 0 or a huge age');
  const present = runShSnippet(sh, 'dir_age_seconds() {', '\n}', 'dir_age_seconds /', {});
  assert.equal(present.status, 0);
  assert.match(present.stdout, /^-?\d+$/, 'an existing path yields a whole number of seconds');
  assert.ok(sh.includes('if lock_age="$(dir_age_seconds "$LOCK_DIR")" && [ "$lock_age" -ge 0 ]'), 'the pid-reuse guard is skipped when the lock cannot be stat\'ed');
  assert.ok(sh.includes('age="$(dir_age_seconds "$LOCK_DIR")" || return 1\n  [ "$age" -ge "$STUCK_AFTER" ]'), 'an unreadable lock age is never old');
  assert.ok(sh.includes('age="$(dir_age_seconds "$LOCK_DIR")" || return 1\n  [ "$age" -ge -300 ] && [ "$age" -lt 30 ]'), 'an unreadable lock age is never young');
  assert.ok(sh.includes('age="$(dir_age_seconds "$TAKEOVER_DIR")" || return 1'), 'an unreadable marker age yields');
  assert.ok(!sh.includes('|| echo 0)"'), 'no mtime 0 fallback is left');
});

test('update.sh ends a failed rsync step with an ERROR line and err:sync, and has no npm step any more', () => {
  assert.ok(sh.includes('sync_files() {'));
  const sync = sh.split('sync_files() {')[1].split('\n}\n')[0];
  assert.ok(sync.includes('"$EXTRACT_DIR/" "$PANEL_DIR/" || return 1'), 'rsync failure returns, not set -e exit');
  assert.ok(sh.includes('if ! sync_files; then\n  echo "ERROR: replacing the panel files failed (rsync)"\n  echo "err:sync"\n  exit 1\nfi'));
  assert.ok(!sh.includes('install_deps'), 'the npm block is gone');
  assert.ok(!/\bnpm\b/.test(sh.replace(/^\s*#.*$/gm, '')), 'no npm call outside comments');
  assert.ok(!sh.includes('err:npm'), 'err:npm is gone from the script and its contract comment');
  assert.ok(sh.includes('err:dev-install, err:lock, err:download, err:runtime, err:sync'), 'the contract comment names the codes');
});

// ---- zero-dependency install: the runtime step (spec 6, 7) ----
const RT_FIRST = '# ---- runtime step (spec 6) ----';
const RT_LAST = '# ---- end runtime step ----';
// Runs the runtime block of update.sh in a fresh temp folder ($T) with
// DAEMON_DIR, EXTRACT_DIR and TMP_DIR inside it and a no-op test_gate.
function runRuntime(setup, body, env = {}) {
  const pre = 'T="$(mktemp -d)"; trap \'rm -rf "$T"\' EXIT\nDAEMON_DIR="$T/install/daemon"; EXTRACT_DIR="$T/extract"; TMP_DIR="$T/tmp"\nmkdir -p "$DAEMON_DIR" "$EXTRACT_DIR/daemon" "$TMP_DIR"\ntest_gate() { :; }\n';
  return runShSnippet(sh, RT_FIRST, RT_LAST, pre + setup + '\n' + body, env);
}
// A runtime folder as fetch-runtime.sh leaves it: node, VERSION, VERIFIED "<size> <sha>".
const mkRuntime = (dir, body = 'binary-v1') => `mkdir -p "${dir}"; printf '%s' '${body}' > "${dir}/node"; echo "v1 darwin-x64" > "${dir}/VERSION"; echo "$(wc -c < "${dir}/node" | tr -d ' ') abc" > "${dir}/VERIFIED"`;

test('update.sh checks the archive for daemon/daemon.mjs and orders recovery, stage, stop, swap, sync, version.json', () => {
  assert.ok(sh.includes('if [ ! -f "$EXTRACT_DIR/version.json" ] || [ ! -f "$EXTRACT_DIR/daemon/daemon.mjs" ]; then'));
  assert.ok(sh.includes('missing version.json or daemon/daemon.mjs'));
  const main = sh.slice(sh.indexOf(RT_LAST));
  const at = (s) => { const i = main.indexOf(s); assert.ok(i !== -1, 'missing: ' + s); return i; };
  assert.ok(at('if ! recover_runtime; then') < at('if ! download_and_extract; then'), 'recovery runs before anything else is fetched');
  assert.ok(at('if ! download_and_extract; then') < at('if ! stage_runtime; then'), 'the archive is extracted first, its own fetch-runtime.sh runs');
  assert.ok(at('if ! stage_runtime; then') < at('stop_daemon\n'), 'staged while the daemon still runs');
  assert.ok(at('stop_daemon\n') < at('if ! swap_runtime; then'), 'stopped before the swap');
  assert.ok(at('if ! swap_runtime; then') < at('if ! sync_files; then'), 'swap, then sync');
  assert.ok(at('if ! sync_files; then') < at('mv -f "$PANEL_DIR/version.json.tmp" "$PANEL_DIR/version.json"'), 'version.json last');
  assert.ok(sh.includes('if ! stage_runtime; then\n  echo "ERROR: could not stage Gaffer\'s runtime, nothing was changed"\n  echo "err:runtime"\n  exit 1\nfi'));
  const block = sh.slice(sh.indexOf(RT_FIRST), sh.indexOf(RT_LAST));
  assert.ok(block.includes('bash "$script" --stage-only --into "$DAEMON_DIR"'), 'runs the ARCHIVE copy of fetch-runtime.sh, stage only');
  assert.ok(block.includes('local script="$EXTRACT_DIR/daemon/fetch-runtime.sh"'));
  assert.ok(!/stat -f %z "\$1"[^\n]*\|\| stat -c/.test(sh), 'GNU stat first: BSD-only stat -f means something else on Linux');
});

test('update.sh sync keeps daemon/runtime, runtime.new and runtime.old through --delete and removes node_modules (run under bash with rsync)', () => {
  const sync = sh.split('sync_files() {')[1].split('\n}\n')[0];
  for (const ex of ["--exclude '/daemon/runtime'", "--exclude '/daemon/runtime.new'", "--exclude '/daemon/runtime.old'"]) assert.ok(sync.includes(ex), ex);
  assert.ok(!sync.includes('node_modules'), 'the node_modules exclude is gone, so the sync deletes the old tree');
  const r = runShSnippet(sh, 'sync_files() {', '\n}', [
    'T="$(mktemp -d)"; trap \'rm -rf "$T"\' EXIT; EXTRACT_DIR="$T/x"; PANEL_DIR="$T/p"',
    'mkdir -p "$EXTRACT_DIR/daemon" "$PANEL_DIR/daemon/node_modules/ws" "$PANEL_DIR/daemon/sub"',
    'echo new > "$EXTRACT_DIR/daemon/daemon.mjs"; echo x > "$PANEL_DIR/daemon/node_modules/ws/index.js"',
    'for d in runtime runtime.new runtime.old; do mkdir -p "$PANEL_DIR/daemon/$d"; echo bin > "$PANEL_DIR/daemon/$d/node"; done',
    'mkdir -p "$PANEL_DIR/daemon/sub/runtime"; echo nested > "$PANEL_DIR/daemon/sub/runtime/x"',
    'sync_files',
    'for p in daemon/runtime/node daemon/runtime.new/node daemon/runtime.old/node daemon/node_modules daemon/sub daemon/daemon.mjs; do if [ -e "$PANEL_DIR/$p" ]; then echo "$p:yes"; else echo "$p:no"; fi; done',
  ].join('\n'), {});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split('\n'), ['daemon/runtime/node:yes', 'daemon/runtime.new/node:yes', 'daemon/runtime.old/node:yes', 'daemon/node_modules:no', 'daemon/sub:no', 'daemon/daemon.mjs:yes'], 'anchored excludes: only the daemon/ runtime folders are kept');
});

test('update.sh recover_runtime restores runtime.old only when runtime is missing and the size check passes (run under bash)', () => {
  const state = 'for d in runtime runtime.new runtime.old; do if [ -e "$DAEMON_DIR/$d" ]; then printf "%s " "$d"; fi; done; echo; cat "$DAEMON_DIR/runtime/node" 2>/dev/null || true';
  const ok = runRuntime(mkRuntime('$DAEMON_DIR/runtime.old') + '; mkdir -p "$DAEMON_DIR/runtime.new"', 'recover_runtime; ' + state);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Restoring daemon\/runtime from runtime.old/);
  assert.match(ok.stdout, /\nruntime \nbinary-v1$/, 'restored, leftover runtime.new removed: ' + ok.stdout);
  const damaged = runRuntime(mkRuntime('$DAEMON_DIR/runtime.old') + '; printf x > "$DAEMON_DIR/runtime.old/node"', 'recover_runtime; ' + state);
  assert.equal(damaged.status, 0, damaged.stderr);
  assert.doesNotMatch(damaged.stdout, /Restoring/);
  assert.match(damaged.stdout, /fails the size check/);
  assert.match(damaged.stdout, /\nruntime\.old$/, 'damaged runtime.old left for the swap to clear: ' + damaged.stdout);
  const both = runRuntime(mkRuntime('$DAEMON_DIR/runtime') + '; ' + mkRuntime('$DAEMON_DIR/runtime.old', 'old'), 'recover_runtime; ' + state);
  assert.match(both.stdout, /\nruntime \nbinary-v1$/, 'a leftover runtime.old next to a runtime is removed: ' + both.stdout);
  const clean = runRuntime(mkRuntime('$DAEMON_DIR/runtime'), 'recover_runtime; ' + state);
  assert.equal(clean.stdout, 'runtime \nbinary-v1', 'nothing to do, nothing logged');
});

test('update.sh stage_runtime reads the last line of fetch-runtime.sh: current, installed, or err:runtime with runtime.new removed (run under bash)', () => {
  // A fake archive fetch-runtime.sh: logs its args to $T/args, optionally
  // stages a valid runtime.new in its --into folder, prints lines, exits rc.
  const fake = (lines, rc = 0, stage = true) => `echo '{}' > "$EXTRACT_DIR/daemon/runtime-pins.json"
cat > "$EXTRACT_DIR/daemon/fetch-runtime.sh" <<'EOF'
echo "args: $*" >> "$(dirname "$0")/../../args"
${stage ? mkRuntime('$3/runtime.new') : ':'}
${lines.map((l) => `echo '${l}'`).join('\n')}
exit ${rc}
EOF`;
  const show = 'if stage_runtime; then echo "rc:0 staged:${RUNTIME_STAGED:-no}"; else echo "rc:1"; fi; [ -e "$DAEMON_DIR/runtime.new" ] && echo new:yes || echo new:no; cat "$T/args"';
  const cur = runRuntime(fake(['runtime:current'], 0, false), show);
  assert.equal(cur.status, 0, cur.stderr);
  assert.match(cur.stdout, /rc:0 staged:no\nnew:no\nargs: --stage-only --into .*\/install\/daemon$/);
  const inst = runRuntime(fake(['runtime: staged in runtime.new', 'runtime:installed v2 darwin-x64']), show);
  assert.match(inst.stdout, /rc:0 staged:1\nnew:yes/, inst.stdout + inst.stderr);
  const err = runRuntime(fake(['runtime: download failed', 'err:runtime'], 1, true), show);
  assert.match(err.stdout, /rc:1\nnew:no/, 'failure removes runtime.new: ' + err.stdout);
  const liar = runRuntime(fake(['runtime:installed v2 darwin-x64'], 0, false), show);
  assert.match(liar.stdout, /rc:1\nnew:no/, 'an "installed" with no valid runtime.new is a failure: ' + liar.stdout);
  const odd = runRuntime(fake(['something else'], 0, false), show);
  assert.match(odd.stdout, /rc:1/, 'an unknown last line is a failure');
  const none = runRuntime('', show.replace('; cat "$T/args"', ''));
  assert.match(none.stdout, /rc:1/, 'an archive without fetch-runtime.sh fails the runtime step');
});

test('update.sh swap_runtime renames runtime aside, moves runtime.new in, then deletes runtime.old (run under bash)', () => {
  const state = 'for d in runtime runtime.new runtime.old; do if [ -e "$DAEMON_DIR/$d" ]; then printf "%s " "$d"; fi; done; echo; cat "$DAEMON_DIR/runtime/node"';
  const swap = runRuntime(mkRuntime('$DAEMON_DIR/runtime') + '; ' + mkRuntime('$DAEMON_DIR/runtime.new', 'binary-v2'), 'RUNTIME_STAGED=1; swap_runtime; ' + state);
  assert.equal(swap.status, 0, swap.stderr);
  assert.match(swap.stdout, /\nruntime \nbinary-v2$/, swap.stdout);
  const fresh = runRuntime(mkRuntime('$DAEMON_DIR/runtime.new', 'binary-v2'), 'RUNTIME_STAGED=1; swap_runtime; ' + state);
  assert.match(fresh.stdout, /\nruntime \nbinary-v2$/, 'no runtime yet (0.11.x install): one rename');
  const idle = runRuntime(mkRuntime('$DAEMON_DIR/runtime'), 'RUNTIME_STAGED=""; swap_runtime; ' + state);
  assert.equal(idle.stdout, 'runtime \nbinary-v1', 'nothing staged, nothing touched');
  const block = sh.slice(sh.indexOf('swap_runtime() {'), sh.indexOf(RT_LAST));
  assert.ok(block.indexOf('mv "$rt" "$rt.old"') < block.indexOf('test_gate "${GAFFER_UPDATE_TEST_SWAP_GATE:-}"'));
  assert.ok(block.indexOf('test_gate "${GAFFER_UPDATE_TEST_SWAP_GATE:-}"') < block.indexOf('mv "$rt.new" "$rt"'), 'the swap gate sits between the two renames');
});

test('update.sh drops the GAFFER_FETCH_* test seams unless the harness set GAFFER_UPDATE_ASSET (run under bash)', () => {
  const first = 'if [ -z "${GAFFER_UPDATE_ASSET:-}" ]; then\n  unset GAFFER_FETCH_TEST';
  const run = (env) => runShSnippet(sh, first, '\nfi', 'echo "${GAFFER_FETCH_TEST:-unset} ${GAFFER_FETCH_SKIP_CODESIGN:-unset} ${GAFFER_FETCH_BASE_OFFICIAL:-unset}"', env);
  const seams = { GAFFER_FETCH_TEST: '1', GAFFER_FETCH_SKIP_CODESIGN: '1', GAFFER_FETCH_BASE_OFFICIAL: 'file:///x/' };
  assert.equal(run(seams).stdout, 'unset unset unset', 'a stray seam in a real environment is ignored');
  assert.equal(run({ ...seams, GAFFER_UPDATE_ASSET: '/x.tgz' }).stdout, '1 1 file:///x/', 'the harness keeps them');
});

test('update.ps1 still ends a failed download, robocopy or npm step with an ERROR line and its err: code', () => {
  assert.ok(ps1.includes('function Exit-Update([string] $message, [string] $code = "") {'));
  assert.ok(ps1.includes('if ($code) { Write-Output "err:$code" }'), 'the code line follows the ERROR line');
  assert.ok(ps1.includes('Exit-Update "download or extract failed: $($_.Exception.Message)" "download"'), 'a failed download ends with err:download like Mac');
  assert.ok(ps1.includes('Exit-Update "robocopy failed (exit $LASTEXITCODE)" "sync"'));
});

test('update.sh freezes a non-leader holder before snapshotting its descendants and resumes it after the signal', () => {
  const fn = sh.split('signal_holder_tree() {')[1].split('\n}\n')[0];
  const stop = fn.indexOf('kill -STOP "$pid"');
  const snap = fn.indexOf('kids="$(descendant_pids "$pid")"');
  const sig = fn.indexOf('kill "-$sig" "$pid"');
  const cont = fn.indexOf('kill -CONT "$pid"');
  assert.ok(stop !== -1 && snap !== -1 && sig !== -1 && cont !== -1);
  assert.ok(stop < snap && snap < sig && sig < cont, 'STOP, snapshot, signal descendants and holder, CONT');
  assert.ok(fn.includes('kill "-$sig" -- "-$pid"'), 'the process-group branch is unchanged');
  assert.ok(fn.indexOf('kill "-$sig" -- "-$pid"') < stop, 'the group branch does not freeze (one call reaches the whole group)');
});

test('update.sh ends a failed download or extract with an ERROR line and err:download', () => {
  assert.ok(sh.includes('download_and_extract() {'));
  const fn = sh.split('download_and_extract() {')[1].split('\n}\n')[0];
  assert.ok(/curl -fsSL[^\n]* \|\| return 1 ;;/.test(fn), 'curl failure returns, not set -e exit');
  assert.ok(fn.includes('tar -xzf "$TMP_DIR/$ASSET_NAME" -C "$EXTRACT_DIR" || return 1'), 'tar failure returns too');
  assert.ok(sh.includes('if ! download_and_extract; then\n  echo "ERROR: download or extract failed"\n  echo "err:download"\n  exit 1\nfi'));
  assert.ok(sh.includes('err:dev-install, err:lock, err:download'), 'the contract comment names the new code');
});

test('update.sh serializes takeovers with a second mkdir mutex and re-checks the pid inside it', () => {
  assert.ok(sh.includes('TAKEOVER_DIR="$LOCK_DIR.takeover"'));
  assert.ok(sh.includes('if mkdir "$TAKEOVER_DIR" 2>/dev/null; then HAVE_TAKEOVER=1; return 0; fi'), 'takeover mutex is an atomic mkdir');
  assert.ok(sh.includes('marker_is_stale() { [ "$1" -ge 60 ] || [ "$1" -lt -300 ]; }'), 'a takeover marker older than 60s, or dated over 300 s in the future, is stale');
  assert.ok(sh.includes('Another update is taking over the abandoned lock'), 'a held takeover mutex means busy');
  const inside = sh.split('take_takeover_mutex; then')[1].split('release_takeover_mutex\n      return 0')[0];
  assert.ok(inside.includes('now_holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"'), 'pid is re-read inside the mutex');
  assert.ok(inside.includes('[ "$now_holder" != "$holder" ]'), 'only the lock judged stale is removed');
  assert.ok(inside.includes('if lock_holder_is_updater "$holder"; then\n      stop_lock_holder "$holder"'), 'the holder itself is re-read inside the mutex right before it is stopped');
  assert.ok(inside.includes('is already gone, not stopping it.'), 'a holder that vanished at the gate is logged, not signalled');
  assert.ok(inside.indexOf('stop_lock_holder "$holder"') < inside.indexOf('mv "$LOCK_DIR" "$stale"'), 'the holder is stopped inside the mutex, before the rename');
  assert.ok(inside.includes('if mkdir "$LOCK_DIR" 2>/dev/null; then\n      echo "$$" > "$LOCK_DIR/pid"'), 'the taker creates its lock while still holding the mutex');
  assert.ok(inside.includes('The abandoned lock now belongs to pid ${now_holder:-unknown}, rechecking.'), 'the re-read rejection is logged so the harness can tell the path');
});

test('update.sh clears a stale takeover marker by atomic rename and treats future-dated locks as stale', () => {
  const fn = sh.split('take_takeover_mutex() {')[1].split('\n}\n')[0];
  assert.ok(fn.includes('stale="$TAKEOVER_DIR.stale.$$"'));
  assert.ok(fn.includes('if ! mv "$TAKEOVER_DIR" "$stale" 2>/dev/null; then'), 'the stale marker is renamed, not removed in place');
  assert.ok(fn.includes('Another update cleared the stale takeover marker first'), 'a failed rename means another updater won');
  assert.ok(fn.includes('cleared the stale takeover marker first, leaving it to finish."\n    return 1'), 'a failed rename yields');
  assert.ok(fn.includes('putting it back'), 'a fresh marker renamed by mistake is put back');
  assert.ok(!/^\s*rm -rf "\$TAKEOVER_DIR"\s*$/m.test(sh), 'the live marker path is never rm -rf\'d');
  assert.ok(sh.includes('[ "$age" -ge "$STUCK_AFTER" ]'), 'a lock older than the stuck age is old');
  assert.ok(sh.includes('[ "$age" -ge -300 ] && [ "$age" -lt 30 ]'), 'a lock dated over 300 s in the future is never young');
  assert.ok(!sh.includes('-mmin +15'), 'find -mmin cannot see a future mtime');
  for (const gate of ['GAFFER_UPDATE_TEST_GATE', 'GAFFER_UPDATE_TEST_MARKER_GATE', 'GAFFER_UPDATE_TEST_HOLD_GATE', 'GAFFER_UPDATE_TEST_SWAP_GATE']) {
    assert.ok(sh.includes('test_gate "${' + gate + ':-}"'), 'deterministic test gate ' + gate);
  }
  assert.ok(!sh.includes('GAFFER_UPDATE_TEST_DELAY'), 'the sleep-based race hook is gone');
});

test('update.sh exit trap only deletes a lock that still holds its own pid', () => {
  assert.ok(sh.includes('if [ -n "$HAVE_LOCK" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK_DIR"; fi'));
  assert.ok(sh.includes('release_takeover_mutex\n  # Only ever delete'), 'trap also releases a held takeover mutex');
});

test('update.sh stops a stuck holder and its whole process tree before taking over', () => {
  assert.ok(sh.includes('stop_lock_holder()'));
  assert.ok(sh.includes('signal_holder_tree()'));
  assert.ok(sh.includes('pgid="$(ps -o pgid= -p "$pid"'), 'checks whether the holder leads its own process group');
  assert.ok(sh.includes('kill "-$sig" -- "-$pid"'), 'signals the whole group when the holder leads it');
  assert.ok(sh.includes('descendant_pids() {'), 'otherwise signals every descendant, any depth');
  assert.ok(sh.includes('ps -axo pid=,ppid= 2>/dev/null | awk -v root="$1"'), 'descendants come from one ps snapshot (not the shimmable pkill)');
  assert.ok(sh.includes('while ((q in parent) && q != root && hops < 1000)'), 'each process is walked up to the holder, so grandchildren count');
  assert.ok(sh.includes('kids="$(descendant_pids "$pid")"'));
  assert.ok(sh.includes("Sending $sig to the stuck update's process group (pgid $pgid)"), 'the group branch is logged');
  assert.ok(sh.includes('descendant process(es) one by one'), 'the per-process branch is logged');
  assert.ok(!/pkill[^\n]*-P "\$pid"/.test(sh), 'pkill -P is a no-op under the harness shim and the daemon-stop path');
  assert.ok(sh.includes('signal_holder_tree "$pid" TERM'));
  assert.ok(sh.includes('signal_holder_tree "$pid" KILL'));
  assert.ok(!sh.includes('kill -TERM "$pid"'), 'no longer signals only the shell');
  assert.ok(sh.includes('if lock_holder_is_updater "$holder"; then\n      stop_lock_holder "$holder"'));
});

test('update.sh never treats its own pid as a holder and matches update.sh as a whole word', () => {
  assert.ok(sh.includes('[ "$pid" != "$$" ] || return 1'));
  const re = "grep -Eq '(^|[[:space:]/])update\\.sh([[:space:]]|$)'";
  assert.ok(sh.includes(re), 'holder match is a word-bounded update.sh (daemon path or a hand-run "bash update.sh")');
  const pattern = new RegExp('(^|[\\s/])update\\.sh(\\s|$)');
  for (const cmd of ['bash /x/daemon/update.sh', 'bash update.sh', '/bin/bash ./update.sh', 'sh daemon/update.sh --x']) assert.ok(pattern.test(cmd), 'should match: ' + cmd);
  for (const cmd of ['bash my-update.sh', 'bash update.sh.bak', 'bash update.shx', 'bash daemon/update.ps1']) assert.ok(!pattern.test(cmd), 'should not match: ' + cmd);
});

test('update.ps1 takes the lock with the static File.Open and an untyped catch', () => {
  assert.ok(ps1.includes('[System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)'));
  assert.ok(!ps1.includes('New-Object System.IO.FileStream'), 'New-Object FileStream surfaces as MethodInvocationException on PS 5.1');
  assert.ok(!ps1.includes('catch [System.IO.IOException]'), 'typed catch may never match on PS 5.1');
  assert.ok(ps1.includes('Get-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue'));
  assert.ok(ps1.includes('if (-not $lockItem) {'), 'a missing lock file must retry, not throw');
});

test('update.ps1 serializes takeovers with a CreateNew marker and re-checks the pid inside it', () => {
  assert.ok(ps1.includes('$takeoverPath = "$lockPath.takeover"'));
  assert.ok(ps1.includes('if (New-PidFile $takeoverPath) { $script:haveTakeover = $true; return $true }'));
  assert.ok(ps1.includes('function Test-MarkerStale([double] $age) { return ($age -ge 60 -or $age -lt -300) }'), 'a takeover marker older than 60s, or dated over 300 s in the future, is stale');
  assert.ok(ps1.includes('Another update is taking over the abandoned lock'), 'a held takeover marker means busy');
  const inside = ps1.split('if (-not (Enter-TakeoverMutex)) {')[1].split('Exit-TakeoverMutex\n}')[0];
  assert.ok(inside.includes('$nowHolder = Read-LockHolder'), 'pid is re-read inside the mutex');
  assert.ok(inside.includes('if ($nowHolder -ne $holder) {'), 'only the lock judged stale is removed');
  assert.ok(inside.includes('The abandoned lock now belongs to pid $label, rechecking.'), 'the re-read rejection is logged so the harness can tell the path');
  assert.ok(inside.includes('$state = Get-LockHolderState $proc $lockWrittenUtc'), 'the holder (pid and creation time) is re-read inside the mutex');
  assert.ok(inside.includes('if ($state -eq "same") {\n            Stop-LockHolder $proc $ancestors'), 'only the same live updater is stopped, never its pid\'s new owner, never this updater\'s own parent chain');
  assert.ok(inside.includes('if ($state -eq "unverified") {\n            Write-Host "Could not inspect the process holding the lock (pid $($proc.ProcessId)), but it is alive: leaving it to finish."\n            Exit-TakeoverMutex\n            Write-Output "busy:already-running"'), 'an Unverified re-read inside the mutex releases the mutex and exits busy, it never takes over');
  assert.ok(inside.indexOf('$state -eq "unverified"') < inside.indexOf('$state -eq "same"'), 'unverified is handled before the stop');
  assert.ok(inside.includes('is already gone, not stopping it.'), 'a holder that vanished at the gate is logged, not signalled');
  assert.ok(inside.indexOf('Stop-LockHolder $proc') < inside.indexOf('Remove-Item -LiteralPath $lockPath'), 'the holder is stopped inside the mutex, before the removal');
  assert.ok(inside.includes('if (New-PidFile $lockPath) { $script:haveLock = $true }'), 'the taker creates its lock while still holding the mutex');
  const state = ps1.split('function Get-LockHolderState($proc, [DateTime] $lockWrittenUtc) {')[1].split('\n}\n')[0];
  assert.ok(state.includes('if ($now.Unverified) { return "unverified" }'), 'an unverified re-read is reported as such, not as gone');
  assert.ok(state.includes('if ("$($now.CreationDate)" -eq "$($proc.CreationDate)") { return "same" }'), 'same pid is not enough, the creation time must match too');
  assert.ok(!ps1.includes('Test-SameProcess'), 'the boolean re-read (which read unverified as gone) is gone');
});

test('update.ps1 never stops a hand-run holder or its own parent chain, and ends such a stuck lock with err:lock', () => {
  const fn = ps1.split('function Get-LockHolderProcess([string] $holder, [DateTime] $lockWrittenUtc) {')[1].split('\n}\n')[0];
  assert.ok(fn.includes("$scriptOk = (\"$($proc.CommandLine)\" -match '(^|[\\\\/\\s\"''])update\\.ps1')"), 'whether the command line names update.ps1 is recorded separately');
  assert.ok(fn.includes('return [pscustomobject] @{ ProcessId = $holderPid; CreationDate = $proc.CreationDate; Unverified = $false; Stoppable = $scriptOk }'), 'only a script-named holder is Stoppable');
  assert.ok(fn.includes('if (-not ($nameOk -or $scriptOk)) { return $null }'), 'a name-only holder still counts as a holder (busy)');
  assert.ok(!fn.includes('$pathOk'), 'the old path-only flag is gone');
  // The regex matches what the panel, its ExtendScript fallback and a "-File update.ps1" produce, and not a bare powershell.exe.
  const re = /(^|[\\/\s"'])update\.ps1/;
  for (const cmd of ['powershell -File C:\\x\\daemon\\update.ps1', 'powershell -File C:/x/daemon/update.ps1', 'powershell -File update.ps1', 'powershell -File "C:\\Program Files\\x\\update.ps1"', "pwsh -File 'C:\\x\\update.ps1'"]) assert.ok(re.test(cmd), 'should match: ' + cmd);
  for (const cmd of ['"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"', 'powershell -NoProfile -Command Start-Sleep -Seconds 300', 'powershell -File my-update.ps1', 'powershell -File daemon\\update.sh']) assert.ok(!re.test(cmd), 'should not match: ' + cmd);
  const loop = ps1.split('$lockIsOld = ($lockAge -ge $stuckAfter)')[1].split('Wait-TestGate $env:GAFFER_UPDATE_TEST_GATE')[0];
  assert.ok(loop.includes('try { $ancestors = @(Get-AncestorProcessIds) } catch {'), 'this updater\'s own parent chain is built from Win32_Process');
  assert.ok(loop.includes('if ($ancestors -contains [int] $proc.ProcessId) {\n            Write-Host "This update was started from the terminal that holds the lock. Close that window and try again."\n            Write-Output "err:lock"'), 'a holder on the parent chain is refused with err:lock');
  assert.ok(loop.includes('if (-not $proc.Stoppable) {\n            Write-Host "An update started by hand in PowerShell (pid $holder) has held the lock for over 15 minutes. Close that window or press Ctrl+C in it."\n            Write-Output "err:lock"'), 'a name-only holder past the stuck age is refused with err:lock, never stopped');
  assert.ok(loop.indexOf('$ancestors -contains') < loop.indexOf('-not $proc.Stoppable'), 'the parent-chain refusal comes first');
  assert.ok(ps1.includes('Stop-LockHolder $proc $ancestors'), 'the parent chain is passed to the stop as protected pids');
  const desc = ps1.split('function Get-DescendantProcessIds([int] $rootPid, $rootCreated, $createdBefore, [int[]] $protect) {')[1].split('\n}\n')[0];
  assert.ok(desc.includes('if ($protect -and ($protect -contains [int] $p.ProcessId)) { continue }'), 'protected pids are never listed as descendants');
  assert.ok(desc.includes('-or $p.ProcessId -eq $PID -or'), 'this very process is never listed as a descendant');
  const anc = ps1.split('function Get-AncestorProcessIds {')[1].split('\n}\n')[0];
  assert.ok(anc.includes('if ($cur.CreationDate -and $parent.CreationDate -and $parent.CreationDate -gt $cur.CreationDate) { break }'), 'a parent younger than its child is a reused pid, the walk stops');
  assert.ok(anc.includes('Get-CimInstance Win32_Process -OperationTimeoutSec 15 -ErrorAction Stop'), 'a failed query throws, so the caller exits busy instead of guessing');
  assert.ok(loop.includes('Could not inspect this process\'s own parent chain'), 'a failed ancestor query means busy');
  assert.ok(ps1.includes('$lockAhead = (($lockUtc - [DateTime]::UtcNow).TotalSeconds -gt 5)'), 'a lock written over 5 s in the future is flagged');
  assert.ok(fn.includes('if ($lockAhead) {\n        return [pscustomobject] @{ ProcessId = $holderPid; CreationDate = $proc.CreationDate; Unverified = $false; Stoppable = $false }\n    }'), 'any live pid under a future-dated lock is a busy, never-stoppable holder');
  assert.ok(fn.indexOf('if ($lockAhead)') < fn.indexOf('if (-not ($nameOk -or $scriptOk))'), 'the future-dated rule comes before the name test');
});

test('update.ps1 clears a stale takeover marker by atomic rename and treats future-dated locks as stale', () => {
  const fn = ps1.split('function Enter-TakeoverMutex {')[1].split('\nfunction Exit-TakeoverMutex')[0];
  assert.ok(fn.includes('$stale = "$takeoverPath.stale.$PID"'));
  assert.ok(fn.includes('Move-Item -LiteralPath $takeoverPath -Destination $stale -ErrorAction Stop'), 'the stale marker is renamed, not removed in place');
  assert.ok(fn.includes('Another update cleared the stale takeover marker first'), 'a failed rename means another updater won');
  assert.ok(fn.includes('putting it back'), 'a fresh marker renamed by mistake is put back');
  assert.ok(!fn.includes('Remove-Item -LiteralPath $takeoverPath'), 'the live marker path is never removed in place inside the mutex entry');
  assert.ok(ps1.includes('$lockIsOld = ($lockAge -ge $stuckAfter)'), 'a lock older than the stuck age is old; a negative age never is');
  assert.ok(!ps1.includes('.TotalMinutes -ge 15'), 'the old minutes-only check cannot see a future write time');
  for (const gate of ['GAFFER_UPDATE_TEST_GATE', 'GAFFER_UPDATE_TEST_MARKER_GATE', 'GAFFER_UPDATE_TEST_HOLD_GATE']) {
    assert.ok(ps1.includes('Wait-TestGate $env:' + gate), 'deterministic test gate ' + gate);
  }
  assert.ok(!ps1.includes('GAFFER_UPDATE_TEST_DELAY_MS'), 'the sleep-based race hook is gone');
});

test('update.ps1 stops a stuck holder through Win32_Process descendants, taskkill /T only as fallback, and opens its try/finally right after the lock', () => {
  assert.ok(ps1.includes('function Get-DescendantProcessIds([int] $rootPid, $rootCreated, $createdBefore, [int[]] $protect) {'));
  assert.ok(ps1.includes('if ($cur.Created -and $p.CreationDate -and $p.CreationDate -lt $cur.Created) { continue }'), 'a child older than its parent is a stale parent pid, not a descendant');
  assert.ok(ps1.includes('$queue.Enqueue(@{ Id = $p.ProcessId; Created = $p.CreationDate })'), 'descendants are followed to any depth');
  assert.ok(ps1.includes('if ($createdBefore -and $p.CreationDate -and ([DateTime] $p.CreationDate).ToUniversalTime() -gt $createdBefore) { continue }'), 'after the stop only processes created before it count (a recycled pid\'s new children never do)');
  const stop = ps1.split('function Stop-LockHolder($proc, [int[]] $protect) {')[1].split('\n}\n')[0];
  const firstList = stop.indexOf('Get-DescendantProcessIds $holderPid $proc.CreationDate $null $protect');
  const taskkill = stop.indexOf('& $taskkill /PID $holderPid /T /F');
  const stopAt = stop.indexOf('$stopAt = [DateTime]::UtcNow');
  const stopHolder = stop.indexOf('Stop-Process -Id $holderPid -Force');
  const secondList = stop.indexOf('Get-DescendantProcessIds $holderPid $proc.CreationDate $stopAt $protect');
  assert.ok(firstList !== -1 && taskkill !== -1 && stopAt !== -1 && stopHolder !== -1 && secondList !== -1);
  assert.ok(firstList < taskkill && taskkill < stopAt && stopAt < stopHolder && stopHolder < secondList, 'order: list while alive, taskkill (alive) on a failed listing, else note the instant, stop the holder, re-list once with the instant');
  assert.ok(stop.includes('if (-not $listed) {\n        Write-Host "  could not list the stuck update\'s processes, using taskkill /T"'), 'taskkill runs only when the enumeration failed, and before anything is stopped');
  assert.ok(stop.includes('$order = @($tree.Values | Sort-Object -Property CreationDate -Descending)'), 'the union of both passes is stopped youngest first');
  assert.ok(stop.includes('foreach ($k in $order) { Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue }'), 'descendants are stopped one by one');
  assert.ok(stop.includes('$more = @()'), 'a second pass catches what a child started between the listing and the stop');
  assert.ok(stop.includes('descendant process(es)'), 'the enumeration is logged');
  assert.ok(ps1.includes('if ($script:testFailList) { $script:testFailList = $false; throw "GAFFER_UPDATE_TEST_FAIL_LIST" }'), 'the harness can make the first listing fail');
  assert.ok(ps1.includes('$script:testFailList = [bool] ($env:GAFFER_UPDATE_ASSET -and $env:GAFFER_UPDATE_TEST_FAIL_LIST)'), 'that knob is gated like the stuck-age knob');
  assert.ok(ps1.includes('Residual risk, left for a later release: two clocks are compared'), 'the deferred clock risks are noted next to the reuse guard');
  const tryAt = ps1.indexOf('\ntry {');
  const dotSource = ps1.indexOf('. "$PSScriptRoot\\stop-daemon.ps1"');
  const lockLoopEnd = ps1.lastIndexOf('$script:haveLock = $true');
  assert.ok(tryAt !== -1 && dotSource !== -1 && lockLoopEnd !== -1);
  assert.ok(lockLoopEnd < tryAt, 'try opens after the lock is taken');
  assert.ok(tryAt < dotSource, 'try opens before stop-daemon.ps1 is dot-sourced');
  assert.ok(ps1.includes('if ($script:haveLock -and ((Read-LockHolder) -eq "$PID")) { Remove-Item -LiteralPath $lockPath'), 'finally only deletes a lock that still holds this pid');
});

test('update.ps1 computes every age in UTC and tolerates 300 s of skew', () => {
  assert.ok(ps1.includes('function Get-FileAgeSeconds($item) { return ([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalSeconds }'));
  assert.ok(!ps1.includes('(Get-Date) - $item.LastWriteTime'), 'no local wall-clock age (DST fall-back would read an hour into the future)');
  assert.ok(!ps1.includes('(Get-Date) - $moved.LastWriteTime'));
  assert.ok(!ps1.includes('(Get-Date) - $lockItem.LastWriteTime'));
  assert.ok(ps1.includes('$lockAge = Get-FileAgeSeconds $lockItem'));
  assert.ok(ps1.includes('$age = Get-FileAgeSeconds $item'));
  assert.ok(ps1.includes('if ($moved) { $age = Get-FileAgeSeconds $moved }'), 'the put-back re-check is UTC too');
  assert.ok(ps1.includes('if ($age -lt -300) {\n        Write-Host "Removing a takeover marker dated in the future'), 'the future-dated log line follows the same tolerance');
  assert.ok(!/\$lockAge -lt 0\b/.test(ps1) && !/\$age -lt 0\)/.test(ps1), 'no bare negative-age rule is left');
  assert.ok(ps1.includes('$stuckAfter = 900'), 'the stuck age is 15 minutes');
  assert.ok(ps1.includes("if ($env:GAFFER_UPDATE_ASSET -and \"$env:GAFFER_UPDATE_TEST_STUCK_AFTER\" -match '^\\d+$' -and\n    [int]::TryParse($env:GAFFER_UPDATE_TEST_STUCK_AFTER, [ref] $stuckOverride) -and\n    $stuckOverride -ge 1 -and $stuckOverride -le 86400) { $stuckAfter = $stuckOverride }"), 'the harness may lower it: only next to GAFFER_UPDATE_ASSET, digits only, 1 to 86400, TryParse so a huge value cannot throw');
  assert.ok(!ps1.includes('[int] $env:GAFFER_UPDATE_TEST_STUCK_AFTER'), 'no bare [int] cast of the knob (a huge value would throw before the try)');
});

test('update.ps1 treats a seconds-old lock with no readable pid as busy', () => {
  assert.ok(ps1.includes('$holderParses = ([int]::TryParse($holder, [ref] $holderPid) -and $holderPid -gt 0)'));
  assert.ok(ps1.includes('if (-not $holderParses -and $lockAge -ge -300 -and $lockAge -lt 30) {\n        Write-Host "Another update is starting up (its lock is seconds old), leaving it to finish."'), 'under 30 s (300 s of skew tolerated) means busy, as on macOS');
  assert.ok(ps1.indexOf('Another update is starting up') < ps1.indexOf('$proc = Get-LockHolderProcess $holder $lockWrittenUtc'), 'the young rule runs before the holder lookup');
});

test('update.ps1 recognises a holder by process name and creation time, keeps the path match, and never abandons a lock it could not inspect', () => {
  const fn = ps1.split('function Get-LockHolderProcess([string] $holder, [DateTime] $lockWrittenUtc) {')[1].split('\n}\n')[0];
  assert.ok(fn.includes('Get-CimInstance Win32_Process -Filter "ProcessId = $holderPid" -OperationTimeoutSec 15 -ErrorAction Stop'), 'the holder query has a timeout and surfaces failures');
  assert.ok(fn.includes('$queryFailed = $true'));
  assert.ok(fn.includes('if (Get-Process -Id $holderPid -ErrorAction SilentlyContinue) {\n            return [pscustomobject] @{ ProcessId = $holderPid; CreationDate = $null; Unverified = $true; Stoppable = $false }'), 'a failed query with a live pid is Unverified, not $null');
  assert.ok(fn.includes("$nameOk = (\"$($proc.Name)\" -match '^(powershell|pwsh)\\.exe$')"), 'a powershell.exe or pwsh.exe counts (a hand-run .\\update.ps1 has no script path in its command line)');
  assert.ok(fn.includes('if (-not ($nameOk -or $scriptOk)) { return $null }'));
  assert.ok(fn.includes('$createdUtc = ([DateTime] $proc.CreationDate).ToUniversalTime()'));
  assert.ok(fn.includes('if ($createdUtc -gt $lockUtc.AddSeconds(5)) { return $null }'), 'created after the lock was written (plus 5 s) is a reused pid, whatever the name or path');
  assert.ok(fn.indexOf('if (-not ($nameOk -or $scriptOk))') < fn.indexOf('$createdUtc'), 'the creation-time condition applies to both forms');
  assert.ok(ps1.includes('if ($proc -and $proc.Unverified) {\n        Write-Host "Could not inspect the process holding the lock (pid $holder), but it is alive: leaving it to finish."\n        Write-Output "busy:already-running"'), 'Unverified means busy');
  assert.ok(fn.includes('Unverified = $true; Stoppable = $false'), 'an Unverified holder is never stoppable');
  assert.ok(ps1.includes('pid reused).'), 'a live non-holder pid is logged before the takeover');
  for (const line of ps1.split('\n').filter((l) => l.includes('Get-CimInstance'))) {
    assert.ok(line.includes('-OperationTimeoutSec 15'), 'every WMI/CIM call has a 15 s timeout: ' + line.trim());
  }
});

test('update.ps1 never treats its own pid as a holder and matches the script name with either slash', () => {
  assert.ok(ps1.includes('if ($holderPid -eq $PID) { return $null }'));
  assert.ok(!ps1.includes('-like "*daemon\\update.ps1*"'), 'the backslash-only wildcard match is gone');
  assert.ok(!ps1.includes('daemon[\\\\/]update\\.ps1'), 'the daemon-folder-only match is gone (a "-File update.ps1" names the script too)');
  const re = /(^|[\\/\s"'])update\.ps1/;
  assert.ok(re.test('powershell -File C:\\x\\daemon\\update.ps1'));
  assert.ok(re.test('powershell -File C:/x/daemon/update.ps1'));
  assert.ok(!re.test('powershell -File C:/x/daemon/update.sh'));
  assert.ok(!re.test('powershell -File C:/x/my-daemon-update.ps1'));
});

test('download budgets pin the panel windows: 180s give-up plus one 180s extension', () => {
  assert.ok(mainJs.includes('} else if (waited >= 180000) {'), 'the panel gives up after 180s');
  assert.ok(mainJs.includes('if (!extended && runningUpdaterPid()) {\n            extended = true;\n            waited = 0;'), 'the panel extends exactly once, by another 180s');
  for (const [name, text] of [['update.sh', sh], ['update.ps1', ps1]]) {
    // Comments wrap: join continuation lines before looking for the phrase.
    const prose = text.replace(/\n#\s*/g, ' ');
    assert.ok(prose.includes('gives up after 180s but extends once by 180s while this lock is held, a 360s window'), name + ' comment names the panel window (180s plus one 180s extension, 360s)');
  }
  assert.ok(ps1.includes('$req.ReadWriteTimeout = 20000'));
  assert.ok(ps1.includes('if (((Get-Date) - $started).TotalSeconds -gt 130) { throw "download exceeded its 150s budget" }'), 'a read (up to 20s) only starts while 20s of the 150s budget remain');
  assert.ok(ps1.includes('if ($curlSeconds -ge 90) {'), 'the fallback only starts when curl gave up within 90s');
  assert.ok(ps1.includes('about 90 + 150 = 240s'), 'comment states the true worst case, 90 + 150');
  assert.ok(ps1.includes('checked before every body read'), 'comment says how the budget is enforced');
});

test('update.ps1 downloads with curl.exe first and falls back to the system proxy path on any non-4xx failure', () => {
  assert.ok(ps1.includes('Join-Path $env:SystemRoot "System32\\curl.exe"'));
  const line = ps1.split('\n').find((l) => l.includes('& $curl -f -L -sS'));
  assert.ok(line, 'no curl.exe download line');
  for (const flag of ['--ssl-no-revoke', '--connect-timeout 15', '--speed-limit 2048', '--speed-time 20', '--max-time 150', '--retry 2', '--retry-max-time 120']) {
    assert.ok(line.includes(flag), 'curl.exe line is missing ' + flag);
  }
  assert.ok(ps1.includes('if ($status -eq 404 -or $status -eq 410) { $finalError = "The remote server returned an error: ($status)." }'), 'only 404 and 410 from curl are final (and keep the "(404)" shape the log check relies on); 403/407 from a proxy fall back');
  assert.ok(!ps1.includes('if ($status -ge 400 -and $status -lt 500) { $finalError'), 'the any-4xx-is-final rule is gone from the curl path');
  assert.ok(ps1.includes('if ($status -ge 400 -and $status -lt 500) { throw "The remote server returned an error: ($status)." }'), 'the .NET path has nothing to fall back to, so every 4xx is final there');
  assert.ok(ps1.includes('if ($curlSeconds -ge 90) {'), 'no fallback once curl has used 90s of the budget');
  assert.ok(ps1.includes('trying the system proxy path'), 'the fallback is logged');
  assert.ok(ps1.includes('function Get-ReleaseAssetViaSystemProxy('), 'the .NET fallback exists');
  assert.ok(ps1.includes('[System.Net.WebRequest]::DefaultWebProxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials'));
  assert.ok(ps1.includes('$req.ReadWriteTimeout = 20000'), 'a stalled body is bounded per read');
  assert.ok(ps1.includes('throw "download exceeded its 150s budget"'), 'the fallback has a hard total budget');
  assert.ok(!ps1.includes('.TotalSeconds -ge 150) { throw'), 'the budget is checked before a read, not after one that may have overrun it');
  assert.ok(!ps1.includes('Invoke-WebRequest -Uri'), 'Invoke-WebRequest cannot bound a stalled body on PS 5.1');
  assert.ok(ps1.includes('if (Test-Path -LiteralPath $assetSource -PathType Leaf)'), 'GAFFER_UPDATE_ASSET local path still honored');
  assert.ok(ps1.includes('about 90 + 150 = 240s'), 'comment states the recomputed worst case');
  assert.ok(!ps1.includes('so the whole run has 360s'), 'comment no longer claims the whole run fits the panel window');
});

test('update.ps1 robocopy retries briefly instead of for hours', () => {
  const line = ps1.split('\n').find((l) => l.includes('robocopy $extractDir $panelDir'));
  assert.ok(line && line.includes('/R:2 /W:2'), 'robocopy is missing /R:2 /W:2');
});

test('installers skip MCP registration when gaffer is already registered', () => {
  assert.ok(installMac.includes('"$CLAUDE_BIN" mcp get gaffer >/dev/null 2>&1'));
  assert.ok(installMac.indexOf('mcp get gaffer') < installMac.indexOf('mcp add --transport http'));
  assert.ok(installWin.includes('@("mcp", "get", "gaffer")'));
  assert.ok(installWin.indexOf('"mcp", "get", "gaffer"') < installWin.indexOf('"mcp", "add"'));
});

test('install-win.ps1 runs claude through a Continue-preference wrapper and names the npm shim case', () => {
  assert.ok(installWin.includes('function Invoke-Native('));
  assert.ok(installWin.includes('$ErrorActionPreference = "Continue"'));
  assert.ok(installWin.includes('$global:LASTEXITCODE = -1\n    $null = & $exe @arguments 2>&1'), 'a failed launch must not reuse a stale exit code');
  assert.ok(!/\n\s*\$null = & \$claudeBin/.test(installWin), 'a bare & $claudeBin call remains outside Invoke-Native');
  assert.ok(installWin.includes('Found the npm install of Claude Code, but Gaffer needs the native build or the Claude desktop app: irm https://claude.ai/install.ps1 | iex, or https://claude.com/download'));
  assert.ok(installWin.includes('($cmd.Source -like "*.cmd") -or ($cmd.Source -like "*.ps1")'));
});

test('the v0.11.3 changelog entry states the measured size saving, the tested-version heads-up and the updater claims without overstating, and has no em or en dashes', () => {
  const changelog = read('../CHANGELOG.md');
  const entry = changelog.split('## v0.11.3')[1].split('\n## ')[0];
  assert.ok(entry.includes('outside the versions Gaffer was tested with.**'), 'headline matches the bullet (outside, not only newer)');
  assert.ok(entry.includes('about 6 to 9 percent smaller'), 'Mac 6.5 percent, Windows 8.7 percent measured');
  assert.ok(entry.includes('Updates are safer in rare situations: a stuck update is now stopped completely, including the programs it started, before a new one takes over, an update started by hand is recognised too (and is never force-stopped together with your PowerShell window), and a healthy update is no longer stopped after the clock changes. If a network proxy blocks the first download method, Windows now tries the system proxy instead of giving up.'));
  assert.ok(!/[\u2013\u2014]/.test(entry), 'no em or en dashes in the entry');
  for (const [name, text] of [['update.sh', sh], ['update.ps1', ps1]]) {
    assert.ok(!/[\u2013\u2014]/.test(text), name + ' has no em or en dashes (log lines are user-facing)');
  }
});

test('every npm install uses --omit=dev; npm 10 (Node 20) deprecated --production', () => {
  const readme = read('../README.md');
  for (const [name, text] of [['update.sh', sh], ['update.ps1', ps1], ['install-mac.sh', installMac], ['install-win.ps1', installWin], ['README.md', readme]]) {
    assert.ok(!/--production\b/.test(text), name + ' still passes --production');
  }
  // update.sh no longer runs npm at all (zero-dependency install, spec 6.6).
  for (const [name, text] of [['update.ps1', ps1], ['install-mac.sh', installMac], ['install-win.ps1', installWin]]) {
    assert.match(text, /npm(\.cmd|Cmd)?[^\n]* install --omit=dev/, name + ' installs with --omit=dev');
  }
  // The flag needs npm 7+; the daemon's Node floor (20, which ships npm 10) guarantees it.
  const pkg = JSON.parse(read('../panel/daemon/package.json'));
  assert.equal(pkg.engines.node, '>=20');
  assert.match(readme, /Node 20\+/);
});
