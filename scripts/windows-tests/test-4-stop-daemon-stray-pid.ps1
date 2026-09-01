# test-4-stop-daemon-stray-pid.ps1
# ======================================================================
# Regression test for the 2026-09-01 Windows update-abort bug: taskkill's
# stderr write (e.g. "process could not be terminated") gets promoted to a
# script-terminating error under $ErrorActionPreference = "Stop", even
# through a 2>$null redirect. A single un-killable PID in Stop-Daemon's
# loop crashed the entire update.ps1 mid-run, leaving files half-replaced.
#
# Deterministic repro: pass Stop-Daemon a PID that is guaranteed not to
# exist (999999). `taskkill /PID 999999 /T` reliably fails with "not
# found" on any Windows box - no timing race, no OS-specific process
# quirks needed to trigger the same code path.
#
# Expected: Stop-Daemon returns normally, no exception propagates, and the
# whole call completes in well under the 10s force-kill fallback window
# (nothing is actually listening on 9823, so the poll loop exits on its
# first check).
#
# CI-gating: this test sets $LASTEXITCODE / exit code, unlike tests 1-3
# which are diagnostic/eyeball-only.
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\test-4-stop-daemon-stray-pid.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$stopDaemonPath = Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $here)) "panel\daemon") "stop-daemon.ps1"

if (-not (Test-Path $stopDaemonPath)) {
    Write-Host "FAIL: could not find stop-daemon.ps1 at $stopDaemonPath"
    exit 1
}

. $stopDaemonPath

Write-Host "Calling Stop-Daemon -ProcIds @(999999) - a PID guaranteed not to exist..."
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$threw = $false
$errMsg = $null
try {
    Stop-Daemon -ProcIds @(999999)
} catch {
    $threw = $true
    $errMsg = $_.Exception.Message
}
$sw.Stop()

Write-Host "Elapsed: $($sw.Elapsed.TotalSeconds) s"

if ($threw) {
    Write-Host "FAIL: Stop-Daemon threw an exception instead of absorbing the taskkill error."
    Write-Host "      $errMsg"
    exit 1
}

if ($sw.Elapsed.TotalSeconds -ge 9) {
    Write-Host "FAIL: Stop-Daemon took $($sw.Elapsed.TotalSeconds)s - fell through to the 10s force-kill"
    Write-Host "      fallback instead of exiting on the first empty poll. Logic regression upstream"
    Write-Host "      of the taskkill fix (Get-NetTCPConnection check)."
    exit 1
}

Write-Host "PASS: Stop-Daemon absorbed the un-killable-PID error and returned normally."
exit 0
