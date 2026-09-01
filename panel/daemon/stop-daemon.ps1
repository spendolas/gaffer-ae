# Stop-Daemon - stops whatever holds the daemon WebSocket port (9823),
# reliable no matter how it launched. The old command-line match
# ("*daemon*index.js*") never matched the real "node.exe index.js" cmdline,
# so every update left a stale daemon running.
#
# Force (/F) from the first attempt - a headless node console process often
# doesn't honor a graceful close on Windows at all (two separate field
# failures, 2026-09-01, both a plain "taskkill /PID x /T" that never
# terminated its target). Graceful-first existed to protect an in-flight MCP
# job, but the panel already refuses to launch an update while chatBusy
# (main.js runUpdate), so nothing is running by the time Stop-Daemon gets
# called - there's nothing left for a graceful attempt to protect.
#
# taskkill's stderr write (e.g. "process could not be terminated", or "not
# found" on a PID that raced to exit) gets promoted to a script-terminating
# error under $ErrorActionPreference = "Stop", regardless of the 2>$null
# redirect - a single failed taskkill must not abort the whole update, so
# that call is wrapped. The poll-then-Stop-Process fallback below stays as
# defense in depth for the rare case even /F can't touch (e.g. access denied).
#
# -ProcIds lets a test inject PIDs directly instead of querying the live
# port; production calls (update.ps1) always call Stop-Daemon with no args.
function Stop-Daemon {
    param([int[]] $ProcIds = $null)
    $procIds = $ProcIds
    if (-not $procIds) {
        try {
            $procIds = Get-NetTCPConnection -LocalPort 9823 -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique
        } catch {}
    }
    if (-not $procIds -or $procIds.Count -eq 0) {
        Get-Process -Name "gaffer-daemon" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        return
    }
    foreach ($procId in $procIds) {
        Write-Host "Stopping daemon (pid: $procId)"
        try { & taskkill /PID $procId /F /T 2>$null | Out-Null } catch {}
    }
    for ($i = 0; $i -lt 20; $i++) {
        $still = Get-NetTCPConnection -LocalPort 9823 -State Listen -ErrorAction SilentlyContinue
        if (-not $still) { Write-Host "Daemon stopped."; return }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "Daemon did not exit in time - forcing."
    try {
        Get-NetTCPConnection -LocalPort 9823 -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    } catch {}
}
