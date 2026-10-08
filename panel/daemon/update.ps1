# Gaffer update script (Windows): downloads the latest GitHub release asset,
# replaces panel files, preserves user data, restarts daemon.
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only with a UTF-8
# BOM (node scripts/check-ps-encoding.mjs).
$ErrorActionPreference = "Stop"
# PS 5.1 redraws a progress bar per downloaded chunk, which makes
# Invoke-WebRequest many times slower. Nothing here reads it.
$ProgressPreference = "SilentlyContinue"

$panelDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$daemonDir = "$panelDir\daemon"
$tmpDir = Join-Path $env:TEMP "gaffer-update-$PID"
$extractDir = Join-Path $tmpDir "extract"
$assetName = "gaffer-update-win.zip"
# GAFFER_UPDATE_ASSET overrides the download source with another URL or a
# local file path. Only scripts\windows-tests\test-5-update-ps1.ps1 and
# pre-release checks set it.
$assetSource = "https://github.com/spendolas/gaffer-ae/releases/latest/download/$assetName"
if ($env:GAFFER_UPDATE_ASSET) { $assetSource = $env:GAFFER_UPDATE_ASSET }
$logPath = Join-Path $env:TEMP "gaffer-update.log"

Start-Transcript -Path $logPath -Append
Write-Host "=== Update started: $(Get-Date) ==="

# Last log line contract (the only channel back to a human or a tool):
#   ok:<version>            installed
#   err:<code>              failed (err:dev-install, err:lock) or an ERROR line
#   busy:already-running    another updater holds the lock; this one did nothing
# Exit codes: 0 ok, 1 failed, 3 busy.

# Single-updater lock. Two updaters interleaving (the panel's "Force stop &
# retry" after its 180s give-up, or a manual run next to the panel's) would
# robocopy over each other and corrupt the install, so the whole run holds
# $lockPath, a file created atomically (FileMode CreateNew) holding this PID.
# A lock whose PID is dead, is not an update.ps1, or that is older than 15
# minutes is considered abandoned and taken over. panel\main.js reads the same
# lock to decide whether an updater is still running; keep the path in sync.
$lockPath = Join-Path $env:TEMP "gaffer-update.lock"
$script:haveLock = $false

function Test-LockHolderRunning([string] $holder) {
    $holderPid = 0
    if (-not [int]::TryParse($holder, [ref] $holderPid) -or $holderPid -le 0) { return $false }
    $proc = $null
    try { $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $holderPid" -ErrorAction SilentlyContinue } catch {}
    if (-not $proc -or -not ($proc.CommandLine -like "*update.ps1*")) { return $false }
    $age = (Get-Date) - (Get-Item -LiteralPath $lockPath).LastWriteTime
    return ($age.TotalMinutes -lt 15)
}

function Read-LockHolder {
    try {
        $fs = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $reader = New-Object System.IO.StreamReader($fs)
            return $reader.ReadToEnd().Trim()
        } finally { $fs.Dispose() }
    } catch { return "" }
}

$tries = 0
while (-not $script:haveLock) {
    try {
        $fs = New-Object System.IO.FileStream($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        try {
            $bytes = [System.Text.Encoding]::ASCII.GetBytes("$PID")
            $fs.Write($bytes, 0, $bytes.Length)
        } finally { $fs.Dispose() }
        $script:haveLock = $true
    } catch [System.IO.IOException] {
        $holder = Read-LockHolder
        if (Test-LockHolderRunning $holder) {
            Write-Host "Another update is already running (pid $holder), leaving it to finish."
            Write-Output "busy:already-running"
            Stop-Transcript
            exit 3
        }
        $tries++
        if ($tries -gt 3) {
            Write-Host "ERROR: could not take the update lock at $lockPath"
            Write-Output "err:lock"
            Stop-Transcript
            exit 1
        }
        if (-not $holder) { $holder = "unknown" }
        Write-Host "Taking over an abandoned update lock (pid $holder)"
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
}

# Stop-Daemon lives in its own file (dot-sourced) so it stays plain-function-only
# and can be unit-tested in isolation - see scripts/windows-tests/test-4-stop-daemon-stray-pid.ps1
. "$PSScriptRoot\stop-daemon.ps1"

# Every failure after this point goes through here: log, clean up, exit 1.
# The panel dir is untouched until the robocopy step, and version.json is
# only replaced at the very end. The lock is released by the finally below,
# which PowerShell runs on exit as well.
function Exit-Update([string] $message) {
    Write-Host "ERROR: $message"
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
    Stop-Transcript
    exit 1
}

# Download budget: the asset is a few MB. Each attempt gets 35s, two retries,
# and no attempt starts once 110s have passed, so a hung download dies in
# about 110s at worst, inside the panel's 180s give-up (main.js
# reloadAfterUpdate) rather than outliving it. A 4xx answer (404 on a missing
# asset) is final and is not retried.
function Get-ReleaseAsset([string] $uri, [string] $outFile) {
    $started = Get-Date
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            Invoke-WebRequest -Uri $uri -OutFile $outFile -UseBasicParsing -TimeoutSec 35
            return
        } catch {
            $status = 0
            try { $status = [int] $_.Exception.Response.StatusCode } catch {}
            $elapsed = ((Get-Date) - $started).TotalSeconds
            if (($status -ge 400 -and $status -lt 500) -or $attempt -ge 3 -or $elapsed -ge 110) { throw }
            Write-Host "  download attempt $attempt failed ($($_.Exception.Message)), retrying"
            Start-Sleep -Seconds 2
        }
    }
}

try {
    # Never overwrite a development checkout - a dev install points the panel
    # at a git repo; /PURGE would clobber uncommitted work.
    # Write-Host, not Write-Error: under $ErrorActionPreference = "Stop" the
    # latter terminates the script before the err: line is written.
    if ((Test-Path (Join-Path (Split-Path -Parent $panelDir) ".git")) -or (Test-Path "$panelDir\.git")) {
        Write-Host "ERROR: panel dir is inside a git repo (dev install) - refusing to update. Use git pull instead."
        Write-Output "err:dev-install"
        Stop-Transcript
        exit 1
    }

    # Download the release asset and extract it into a SUBFOLDER of tmpDir, so
    # the downloaded zip itself is never copied into the panel dir.
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    $zipPath = Join-Path $tmpDir $assetName
    Write-Host "Downloading $assetSource"
    try {
        if (Test-Path -LiteralPath $assetSource -PathType Leaf) {
            Copy-Item -LiteralPath $assetSource -Destination $zipPath
        } else {
            Get-ReleaseAsset $assetSource $zipPath
        }
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    } catch {
        Exit-Update "download or extract failed: $($_.Exception.Message)"
    }
    if (-not (Test-Path "$extractDir\version.json") -or -not (Test-Path "$extractDir\daemon\index.js")) {
        Exit-Update "downloaded archive is not a Gaffer release (missing version.json or daemon\index.js)"
    }

    # Version and commit come from the archive's own version.json, which the
    # release workflow stamps. Nothing is read from raw.githubusercontent.com.
    try {
        $release = Get-Content "$extractDir\version.json" -Raw | ConvertFrom-Json
    } catch {
        Exit-Update "release version.json is not valid JSON"
    }
    $latestVersion = $release.version
    $latestCommit = $release.commit
    if (-not $latestVersion) { Exit-Update "release version.json has no version" }
    Write-Host "Release: v$latestVersion ($latestCommit)"

    # Backup chat history - legacy single file plus per-AE-version files
    # (chat-history-<aeVersion>.json, e.g. chat-history-26.0.json)
    $backup = $null
    if (Test-Path "$panelDir\chat-history.json") {
        $backup = Join-Path $tmpDir "chat-history.backup.json"
        Copy-Item "$panelDir\chat-history.json" $backup
    }
    $historyBackupDir = Join-Path $tmpDir "chat-history-backups"
    New-Item -ItemType Directory -Path $historyBackupDir -Force | Out-Null
    Get-ChildItem -Path $panelDir -Filter "chat-history-*.json" -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item $_.FullName $historyBackupDir }

    # Backup .gaffer-config.json (claudeBin, installId, shareUsageStats, etc.) -
    # without this it is silently wiped by robocopy /PURGE on every update.
    $configBackup = $null
    if (Test-Path "$panelDir\.gaffer-config.json") {
        $configBackup = Join-Path $tmpDir "gaffer-config.backup.json"
        Copy-Item "$panelDir\.gaffer-config.json" $configBackup
    }

    # Stop daemon
    Write-Host "Stopping daemon..."
    Stop-Daemon

    # Replace files (preserve user data). version.json is excluded here and
    # written LAST (below): the panel reloads and the daemon self-restarts the
    # moment it changes. The usage-stats buffer and the icon cache are not in the
    # archive; excluding them also protects them from /PURGE.
    Write-Host "Replacing files..."
    robocopy $extractDir $panelDir /E /PURGE `
        /XF chat-history.json chat-history-*.json .gaffer-config.json version.json .gaffer-usage-buffer.json `
        /XD node_modules dist .gaffer-icons | Out-Null
    # robocopy exit codes 0-7 are success variants; 8 and up mean a copy failed.
    if ($LASTEXITCODE -ge 8) { Exit-Update "robocopy failed (exit $LASTEXITCODE)" }

    # Restore chat history
    if ($backup -and (Test-Path $backup)) {
        Copy-Item $backup "$panelDir\chat-history.json" -Force
    }
    Get-ChildItem -Path $historyBackupDir -Filter "chat-history-*.json" -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item $_.FullName "$panelDir\" -Force }

    # Restore .gaffer-config.json
    if ($configBackup -and (Test-Path $configBackup)) {
        Copy-Item $configBackup "$panelDir\.gaffer-config.json" -Force
    }

    # npm install - CEP spawns this script with a STRIPPED PATH, so bare `npm`
    # doesn't resolve when launched from the panel's Update button (manual
    # terminal runs never hit this - which is why they always worked).
    Write-Host "Installing daemon dependencies..."
    $nodeDirs = @(
        "$env:ProgramFiles\nodejs",
        "${env:ProgramFiles(x86)}\nodejs",
        "$env:APPDATA\npm",
        "$env:LOCALAPPDATA\Programs\nodejs",
        "$env:NVM_SYMLINK"
    ) | Where-Object { $_ -and (Test-Path $_) }
    foreach ($d in $nodeDirs) { $env:Path = "$d;$env:Path" }
    $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npmCmd) { $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source }
    if (-not $npmCmd) {
        Exit-Update "npm not found in known Node.js locations or PATH - run this script from a terminal once"
    }
    Write-Host "  npm: $npmCmd"
    Push-Location $daemonDir
    try { & $npmCmd install --production } catch {}
    $npmExit = $LASTEXITCODE
    Pop-Location
    if ($npmExit -ne 0) {
        Exit-Update "npm install failed (exit $npmExit)"
    }

    # Stop any daemon that respawned mid-update (panel reloads on version.json
    # change and boots a clean one)
    Stop-Daemon

    # LAST step: put the release's version.json in place by copying it to a temp
    # name first and then moving it over the old file. The content is complete
    # before the move, so the panel and daemon only ever see the old file or the
    # complete new one, never a half-written one. (Move-Item -Force is a delete
    # then a move on Windows, not an atomic rename.)
    # Copy-Item keeps the archive's timestamp, so stamp it as written now.
    $versionTmp = "$panelDir\version.json.tmp"
    Copy-Item "$extractDir\version.json" $versionTmp -Force
    (Get-Item -LiteralPath $versionTmp).LastWriteTime = Get-Date
    Move-Item -LiteralPath $versionTmp -Destination "$panelDir\version.json" -Force

    # Cleanup
    Remove-Item -Recurse -Force $tmpDir

    Write-Host "=== Update complete: $(Get-Date) ==="
    Write-Output "ok:$latestVersion"
    Stop-Transcript
} finally {
    # Runs on every way out of the block above, including the exit calls.
    if ($script:haveLock) { Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }
}
