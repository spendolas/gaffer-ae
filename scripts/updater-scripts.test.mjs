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

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
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
  assert.ok(young.includes('[ "$age" -ge 0 ] && [ "$age" -lt 30 ]'), 'young means under 30 seconds (and not dated in the future)');
});

test('update.sh serializes takeovers with a second mkdir mutex and re-checks the pid inside it', () => {
  assert.ok(sh.includes('TAKEOVER_DIR="$LOCK_DIR.takeover"'));
  assert.ok(sh.includes('if mkdir "$TAKEOVER_DIR" 2>/dev/null; then HAVE_TAKEOVER=1; return 0; fi'), 'takeover mutex is an atomic mkdir');
  assert.ok(sh.includes('marker_is_stale() { [ "$1" -ge 60 ] || [ "$1" -lt 0 ]; }'), 'a takeover marker older than 60s, or dated in the future, is stale');
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
  assert.ok(sh.includes('[ "$age" -ge 900 ] || [ "$age" -lt 0 ]'), 'a lock older than 15 minutes or dated in the future is old');
  assert.ok(sh.includes('[ "$age" -ge 0 ] && [ "$age" -lt 30 ]'), 'a future-dated lock is never young');
  assert.ok(!sh.includes('-mmin +15'), 'find -mmin cannot see a future mtime');
  for (const gate of ['GAFFER_UPDATE_TEST_GATE', 'GAFFER_UPDATE_TEST_MARKER_GATE', 'GAFFER_UPDATE_TEST_HOLD_GATE']) {
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
  assert.ok(ps1.includes('function Test-MarkerStale([double] $age) { return ($age -ge 60 -or $age -lt 0) }'), 'a takeover marker older than 60s, or dated in the future, is stale');
  assert.ok(ps1.includes('Another update is taking over the abandoned lock'), 'a held takeover marker means busy');
  const inside = ps1.split('if (-not (Enter-TakeoverMutex)) {')[1].split('Exit-TakeoverMutex\n}')[0];
  assert.ok(inside.includes('$nowHolder = Read-LockHolder'), 'pid is re-read inside the mutex');
  assert.ok(inside.includes('if ($nowHolder -ne $holder) {'), 'only the lock judged stale is removed');
  assert.ok(inside.includes('The abandoned lock now belongs to pid $label, rechecking.'), 'the re-read rejection is logged so the harness can tell the path');
  assert.ok(inside.includes('if (Test-SameProcess $proc) {\n            Stop-LockHolder $proc'), 'the holder (pid and creation time) is re-read inside the mutex right before it is stopped');
  assert.ok(inside.includes('is already gone, not stopping it.'), 'a holder that vanished at the gate is logged, not signalled');
  assert.ok(inside.indexOf('Stop-LockHolder $proc') < inside.indexOf('Remove-Item -LiteralPath $lockPath'), 'the holder is stopped inside the mutex, before the removal');
  assert.ok(inside.includes('if (New-PidFile $lockPath) { $script:haveLock = $true }'), 'the taker creates its lock while still holding the mutex');
  assert.ok(ps1.includes('return ("$($now.CreationDate)" -eq "$($proc.CreationDate)")'), 'same pid is not enough, the creation time must match too');
});

test('update.ps1 clears a stale takeover marker by atomic rename and treats future-dated locks as stale', () => {
  const fn = ps1.split('function Enter-TakeoverMutex {')[1].split('\nfunction Exit-TakeoverMutex')[0];
  assert.ok(fn.includes('$stale = "$takeoverPath.stale.$PID"'));
  assert.ok(fn.includes('Move-Item -LiteralPath $takeoverPath -Destination $stale -ErrorAction Stop'), 'the stale marker is renamed, not removed in place');
  assert.ok(fn.includes('Another update cleared the stale takeover marker first'), 'a failed rename means another updater won');
  assert.ok(fn.includes('putting it back'), 'a fresh marker renamed by mistake is put back');
  assert.ok(!fn.includes('Remove-Item -LiteralPath $takeoverPath'), 'the live marker path is never removed in place inside the mutex entry');
  assert.ok(ps1.includes('$lockIsOld = ($lockAge -ge 900 -or $lockAge -lt 0)'), 'a lock older than 15 minutes or dated in the future is old');
  assert.ok(!ps1.includes('.TotalMinutes -ge 15'), 'the old minutes-only check cannot see a future write time');
  for (const gate of ['GAFFER_UPDATE_TEST_GATE', 'GAFFER_UPDATE_TEST_MARKER_GATE', 'GAFFER_UPDATE_TEST_HOLD_GATE']) {
    assert.ok(ps1.includes('Wait-TestGate $env:' + gate), 'deterministic test gate ' + gate);
  }
  assert.ok(!ps1.includes('GAFFER_UPDATE_TEST_DELAY_MS'), 'the sleep-based race hook is gone');
});

test('update.ps1 stops a stuck holder through Win32_Process descendants, taskkill /T only as fallback, and opens its try/finally right after the lock', () => {
  assert.ok(ps1.includes('function Get-DescendantProcessIds([int] $rootPid, $rootCreated) {'));
  assert.ok(ps1.includes('if ($cur.Created -and $p.CreationDate -and $p.CreationDate -lt $cur.Created) { continue }'), 'a child older than its parent is a stale parent pid, not a descendant');
  assert.ok(ps1.includes('$queue.Enqueue(@{ Id = $p.ProcessId; Created = $p.CreationDate })'), 'descendants are followed to any depth');
  const stop = ps1.split('function Stop-LockHolder($proc) {')[1].split('\n}\n')[0];
  assert.ok(stop.includes('foreach ($k in $kids) { Stop-Process -Id $k -Force -ErrorAction SilentlyContinue }'), 'descendants are stopped one by one');
  assert.ok(stop.indexOf('foreach ($k in $kids)') < stop.indexOf('Stop-Process -Id $holderPid -Force'), 'descendants first, then the holder');
  assert.ok(stop.includes('& $taskkill /PID $holderPid /T /F'), 'taskkill /T /F stays as the fallback');
  assert.ok(stop.indexOf('} else {') < stop.indexOf('& $taskkill'), 'taskkill runs only when the enumeration failed');
  assert.ok(stop.includes('descendant process(es)'), 'the enumeration is logged');
  const tryAt = ps1.indexOf('\ntry {');
  const dotSource = ps1.indexOf('. "$PSScriptRoot\\stop-daemon.ps1"');
  const lockLoopEnd = ps1.lastIndexOf('$script:haveLock = $true');
  assert.ok(tryAt !== -1 && dotSource !== -1 && lockLoopEnd !== -1);
  assert.ok(lockLoopEnd < tryAt, 'try opens after the lock is taken');
  assert.ok(tryAt < dotSource, 'try opens before stop-daemon.ps1 is dot-sourced');
  assert.ok(ps1.includes('if ($script:haveLock -and ((Read-LockHolder) -eq "$PID")) { Remove-Item -LiteralPath $lockPath'), 'finally only deletes a lock that still holds this pid');
});

test('update.ps1 never treats its own pid as a holder and matches the daemon path with either slash', () => {
  assert.ok(ps1.includes('if ($holderPid -eq $PID) { return $null }'));
  assert.ok(ps1.includes('"$($proc.CommandLine)" -match "daemon[\\\\/]update\\.ps1"'), 'holder match accepts daemon\\update.ps1 and daemon/update.ps1');
  assert.ok(!ps1.includes('-like "*daemon\\update.ps1*"'), 'the backslash-only wildcard match is gone');
  const re = /daemon[\\/]update\.ps1/;
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

test('every npm install uses --omit=dev; npm 10 (Node 20) deprecated --production', () => {
  const readme = read('../README.md');
  for (const [name, text] of [['update.sh', sh], ['update.ps1', ps1], ['install-mac.sh', installMac], ['install-win.ps1', installWin], ['README.md', readme]]) {
    assert.ok(!/--production\b/.test(text), name + ' still passes --production');
  }
  for (const [name, text] of [['update.sh', sh], ['update.ps1', ps1], ['install-mac.sh', installMac], ['install-win.ps1', installWin]]) {
    assert.match(text, /npm(\.cmd|Cmd)?[^\n]* install --omit=dev/, name + ' installs with --omit=dev');
  }
  // The flag needs npm 7+; the daemon's Node floor (20, which ships npm 10) guarantees it.
  const pkg = JSON.parse(read('../panel/daemon/package.json'));
  assert.equal(pkg.engines.node, '>=20');
  assert.match(readme, /Node 20\+/);
});
