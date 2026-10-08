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
  assert.ok(sh.includes('lock_is_young() { [ "$(dir_age_seconds "$LOCK_DIR")" -lt 30 ]; }'), 'young means under 30 seconds');
});

test('update.sh serializes takeovers with a second mkdir mutex and re-checks the pid inside it', () => {
  assert.ok(sh.includes('TAKEOVER_DIR="$LOCK_DIR.takeover"'));
  assert.ok(sh.includes('if mkdir "$TAKEOVER_DIR" 2>/dev/null; then HAVE_TAKEOVER=1; return 0; fi'), 'takeover mutex is an atomic mkdir');
  assert.ok(sh.includes('[ "$age" -ge 60 ]'), 'a takeover marker older than 60s is stale');
  assert.ok(sh.includes('Another update is taking over the abandoned lock'), 'a held takeover mutex means busy');
  const inside = sh.split('take_takeover_mutex; then')[1].split('release_takeover_mutex\n      return 0')[0];
  assert.ok(inside.includes('now_holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"'), 'pid is re-read inside the mutex');
  assert.ok(inside.includes('[ "$now_holder" != "$holder" ]'), 'only the lock judged stale is removed');
  assert.ok(inside.indexOf('stop_lock_holder "$holder"') < inside.indexOf('mv "$LOCK_DIR" "$stale"'), 'the holder is stopped inside the mutex, before the rename');
  assert.ok(inside.includes('if mkdir "$LOCK_DIR" 2>/dev/null; then\n      echo "$$" > "$LOCK_DIR/pid"'), 'the taker creates its lock while still holding the mutex');
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
  assert.ok(sh.includes("ps -axo pid=,ppid= 2>/dev/null | awk -v p=\"$pid\" '$2 == p { print $1 }'"), 'otherwise signals the children one by one (via ps, not the shimmable pkill)');
  assert.ok(!/pkill[^\n]*-P "\$pid"/.test(sh), 'pkill -P is a no-op under the harness shim and the daemon-stop path');
  assert.ok(sh.includes('signal_holder_tree "$pid" TERM'));
  assert.ok(sh.includes('signal_holder_tree "$pid" KILL'));
  assert.ok(!sh.includes('kill -TERM "$pid"'), 'no longer signals only the shell');
  assert.ok(sh.includes('if lock_holder_is_updater "$holder"; then\n      stop_lock_holder "$holder"'));
});

test('update.sh never treats its own pid as a holder and matches the daemon path', () => {
  assert.ok(sh.includes('[ "$pid" != "$$" ] || return 1'));
  assert.ok(sh.includes("grep -q 'daemon/update\\.sh'"), 'holder match is the daemon path, not any update.sh');
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
  assert.ok(ps1.includes('if ($age -ge 60) {'), 'a takeover marker older than 60s is stale');
  assert.ok(ps1.includes('Another update is taking over the abandoned lock'), 'a held takeover marker means busy');
  const inside = ps1.split('if (-not (Enter-TakeoverMutex)) {')[1].split('Exit-TakeoverMutex\n}')[0];
  assert.ok(inside.includes('$nowHolder = Read-LockHolder'), 'pid is re-read inside the mutex');
  assert.ok(inside.includes('$nowHolder -ne $holder) { Exit-TakeoverMutex; continue }'), 'only the lock judged stale is removed');
  assert.ok(inside.indexOf('Stop-LockHolder ([int] $proc.ProcessId)') < inside.indexOf('Remove-Item -LiteralPath $lockPath'), 'the holder is stopped inside the mutex, before the removal');
  assert.ok(inside.includes('if (New-PidFile $lockPath) { $script:haveLock = $true }'), 'the taker creates its lock while still holding the mutex');
});

test('update.ps1 stops a stuck holder with taskkill /T and opens its try/finally right after the lock', () => {
  assert.ok(ps1.includes('& $taskkill /PID $holderPid /T /F'), 'kills the whole tree, not just the shell');
  assert.ok(!ps1.includes('Stop-Process -Id $holderPid'), 'Stop-Process would orphan the holder\'s children');
  assert.ok(ps1.includes('if ($proc) {\n        Stop-LockHolder ([int] $proc.ProcessId)'));
  const tryAt = ps1.indexOf('\ntry {');
  const dotSource = ps1.indexOf('. "$PSScriptRoot\\stop-daemon.ps1"');
  const lockLoopEnd = ps1.lastIndexOf('$script:haveLock = $true');
  assert.ok(tryAt !== -1 && dotSource !== -1 && lockLoopEnd !== -1);
  assert.ok(lockLoopEnd < tryAt, 'try opens after the lock is taken');
  assert.ok(tryAt < dotSource, 'try opens before stop-daemon.ps1 is dot-sourced');
  assert.ok(ps1.includes('if ($script:haveLock -and ((Read-LockHolder) -eq "$PID")) { Remove-Item -LiteralPath $lockPath'), 'finally only deletes a lock that still holds this pid');
});

test('update.ps1 never treats its own pid as a holder and matches the daemon path', () => {
  assert.ok(ps1.includes('if ($holderPid -eq $PID) { return $null }'));
  assert.ok(ps1.includes('$proc.CommandLine -like "*daemon\\update.ps1*"'), 'holder match is the daemon path, not any update.ps1');
});

test('update.ps1 downloads with curl.exe first and falls back to the system proxy path on any non-4xx failure', () => {
  assert.ok(ps1.includes('Join-Path $env:SystemRoot "System32\\curl.exe"'));
  const line = ps1.split('\n').find((l) => l.includes('& $curl -f -L -sS'));
  assert.ok(line, 'no curl.exe download line');
  for (const flag of ['--ssl-no-revoke', '--connect-timeout 15', '--speed-limit 2048', '--speed-time 20', '--max-time 150', '--retry 2', '--retry-max-time 120']) {
    assert.ok(line.includes(flag), 'curl.exe line is missing ' + flag);
  }
  assert.ok(ps1.includes('if ($status -ge 400 -and $status -lt 500) { $finalError = "The remote server returned an error: ($status)." }'), '4xx from curl is final and keeps the "(404)" shape the log check relies on');
  assert.ok(ps1.includes('if ($curlSeconds -ge 90) {'), 'no fallback once curl has used 90s of the budget');
  assert.ok(ps1.includes('trying the system proxy path'), 'the fallback is logged');
  assert.ok(ps1.includes('function Get-ReleaseAssetViaSystemProxy('), 'the .NET fallback exists');
  assert.ok(ps1.includes('[System.Net.WebRequest]::DefaultWebProxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials'));
  assert.ok(ps1.includes('$req.ReadWriteTimeout = 20000'), 'a stalled body is bounded per read');
  assert.ok(ps1.includes('.TotalSeconds -ge 150) { throw "download exceeded its 150s budget" }'), 'the fallback has a hard total budget');
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
