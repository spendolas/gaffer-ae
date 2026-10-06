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

# Stop-Daemon lives in its own file (dot-sourced) so it stays plain-function-only
# and can be unit-tested in isolation - see scripts/windows-tests/test-4-stop-daemon-stray-pid.ps1
. "$PSScriptRoot\stop-daemon.ps1"

# Never overwrite a development checkout - a dev install points the panel
# at a git repo; /PURGE would clobber uncommitted work.
if ((Test-Path (Join-Path (Split-Path -Parent $panelDir) ".git")) -or (Test-Path "$panelDir\.git")) {
    Write-Error "panel dir is inside a git repo (dev install) - refusing to update. Use git pull instead."
    Write-Output "err:dev-install"
    Stop-Transcript
    exit 1
}

# Every failure after this point goes through here: log, clean up, exit 1.
# The panel dir is untouched until the robocopy step, and version.json is
# only replaced at the very end.
function Exit-Update([string] $message) {
    Write-Host "ERROR: $message"
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
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
        Invoke-WebRequest -Uri $assetSource -OutFile $zipPath -UseBasicParsing
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

# LAST step: put the release's version.json in place with a rename, so the
# panel and daemon only ever see the old file or the complete new one.
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
