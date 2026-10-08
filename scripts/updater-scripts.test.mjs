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

test('update.sh download limits bound stalls, not total time, and stay inside the panel window', () => {
  const line = sh.split('\n').find((l) => l.includes('curl -fsSL'));
  assert.ok(line, 'no curl download line');
  for (const flag of ['--connect-timeout 15', '--speed-limit 2048', '--speed-time 20', '--max-time 150', '--retry 2', '--retry-max-time 120']) {
    assert.ok(line.includes(flag), 'curl line is missing ' + flag);
  }
  assert.ok(!line.includes('--max-time 35'));
  assert.ok(sh.includes('360s'), 'comment reasons about the panel window (180s plus one extension)');
});

test('update.sh takes over a stale lock by atomic rename and treats a seconds-old pid-less lock as busy', () => {
  assert.ok(sh.includes('mv "$LOCK_DIR" "$stale"'), 'takeover is not a rename');
  assert.ok(sh.includes('stale="$LOCK_DIR.stale.$$"'));
  assert.ok(!/^\s*rm -rf "\$LOCK_DIR"\s*$/m.test(sh.split('cleanup()')[0]), 'acquire_lock still deletes the lock dir in place');
  assert.ok(sh.includes('lock_is_young'));
  assert.ok(sh.includes('[ -z "$holder" ] && lock_is_young'));
  assert.match(sh, /\[ \$\(\(now - mtime\)\) -lt 30 \]/, 'young means under 30 seconds');
});

test('update.sh stops a live holder older than 15 minutes before taking over', () => {
  assert.ok(sh.includes('stop_lock_holder()'));
  assert.ok(sh.includes('kill -TERM "$pid"'));
  assert.ok(sh.includes('kill -KILL "$pid"'));
  assert.ok(sh.includes('if lock_holder_is_updater "$holder"; then\n      stop_lock_holder "$holder"'));
});

test('update.ps1 takes the lock with the static File.Open and an untyped catch', () => {
  assert.ok(ps1.includes('[System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)'));
  assert.ok(!ps1.includes('New-Object System.IO.FileStream'), 'New-Object FileStream surfaces as MethodInvocationException on PS 5.1');
  assert.ok(!ps1.includes('catch [System.IO.IOException]'), 'typed catch may never match on PS 5.1');
  assert.ok(ps1.includes('Get-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue'));
  assert.ok(ps1.includes('if (-not $lockItem) {'), 'a missing lock file must retry, not throw');
});

test('update.ps1 stops a stuck holder and opens its try/finally right after the lock', () => {
  assert.ok(ps1.includes('Stop-Process -Id $holderPid -Force'));
  assert.ok(ps1.includes('if ($proc) { Stop-LockHolder ([int] $proc.ProcessId) }'));
  const tryAt = ps1.indexOf('\ntry {');
  const dotSource = ps1.indexOf('. "$PSScriptRoot\\stop-daemon.ps1"');
  const lockLoopEnd = ps1.indexOf('$script:haveLock = $true');
  assert.ok(tryAt !== -1 && dotSource !== -1 && lockLoopEnd !== -1);
  assert.ok(lockLoopEnd < tryAt, 'try opens after the lock is taken');
  assert.ok(tryAt < dotSource, 'try opens before stop-daemon.ps1 is dot-sourced');
  assert.ok(ps1.includes('if ($script:haveLock) { Remove-Item -LiteralPath $lockPath'));
});

test('update.ps1 downloads with the system curl.exe (stall limits) and falls back to Invoke-WebRequest', () => {
  assert.ok(ps1.includes('Join-Path $env:SystemRoot "System32\\curl.exe"'));
  const line = ps1.split('\n').find((l) => l.includes('& $curl -f -L -sS'));
  assert.ok(line, 'no curl.exe download line');
  for (const flag of ['--connect-timeout 15', '--speed-limit 2048', '--speed-time 20', '--max-time 150', '--retry 2', '--retry-max-time 120']) {
    assert.ok(line.includes(flag), 'curl.exe line is missing ' + flag);
  }
  assert.ok(ps1.includes('Invoke-WebRequest -Uri $uri -OutFile $outFile -UseBasicParsing'), 'fallback for a Windows without curl.exe');
  assert.ok(ps1.includes('The remote server returned an error: ($($Matches[1])).'), '4xx keeps the "(404)" shape the log check relies on');
  assert.ok(ps1.includes('if (Test-Path -LiteralPath $assetSource -PathType Leaf)'), 'GAFFER_UPDATE_ASSET local path still honored');
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
  assert.ok(!/\n\s*\$null = & \$claudeBin/.test(installWin), 'a bare & $claudeBin call remains outside Invoke-Native');
  assert.ok(installWin.includes('Found the npm install of Claude Code, but Gaffer needs the native build or the Claude desktop app: irm https://claude.ai/install.ps1 | iex, or https://claude.com/download'));
  assert.ok(installWin.includes('($cmd.Source -like "*.cmd") -or ($cmd.Source -like "*.ps1")'));
});
