# Gaffer update script (Windows) - downloads latest tarball, replaces files,
# preserves chat history, restarts daemon.
$ErrorActionPreference = "Stop"

$panelDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$daemonDir = "$panelDir\daemon"
$tmpDir = Join-Path $env:TEMP "gaffer-update-$PID"
$repo = "spendolas/gaffer-ae"
$logPath = Join-Path $env:TEMP "gaffer-update.log"

Start-Transcript -Path $logPath -Append
Write-Host "=== Update started: $(Get-Date) ==="

# Stop whatever holds the daemon WebSocket port (9823) - reliable no matter how
# it launched. The old command-line match ("*daemon*index.js*") never matched the
# real "node.exe index.js" cmdline, so every update left a stale daemon running.
# Graceful first (taskkill without /F, and the v0.9.5+ in-process watcher drains
# when the port stays busy briefly); force only as a last resort. Note: a hidden
# node console process may not honor a graceful close on Windows, so an in-flight
# MCP job can still be cut here - the panel blocks updates during a chat turn.
function Stop-Daemon {
    $procIds = @()
    try {
        $procIds = Get-NetTCPConnection -LocalPort 9823 -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    } catch {}
    if (-not $procIds -or $procIds.Count -eq 0) {
        Get-Process -Name "gaffer-daemon" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        return
    }
    foreach ($procId in $procIds) {
        Write-Host "Stopping daemon (pid: $procId)"
        & taskkill /PID $procId /T 2>$null | Out-Null
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

# Never overwrite a development checkout - a dev install points the panel
# at a git repo; /PURGE would clobber uncommitted work.
if ((Test-Path (Join-Path (Split-Path -Parent $panelDir) ".git")) -or (Test-Path "$panelDir\.git")) {
    Write-Error "panel dir is inside a git repo (dev install) - refusing to update. Use git pull instead."
    Write-Output "err:dev-install"
    Stop-Transcript
    exit 1
}

# Get latest version info from raw version.json
$remoteVersion = Invoke-RestMethod -Uri "https://raw.githubusercontent.com/$repo/main/panel/version.json"
$latestCommit = $remoteVersion.commit
if (-not $latestCommit) {
    Write-Error "Could not fetch latest version.json"
    exit 1
}
Write-Host "Latest commit: $latestCommit"

# Download zip
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$zipPath = Join-Path $tmpDir "gaffer.zip"
Write-Host "Downloading..."
Invoke-WebRequest -Uri "https://github.com/$repo/archive/refs/heads/main.zip" -OutFile $zipPath
Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force
$extracted = Join-Path $tmpDir "gaffer-ae-main"

if (-not (Test-Path "$extracted\panel")) {
    Write-Error "Extracted archive missing panel/"
    exit 1
}

# Backup chat-history.json
$backup = $null
if (Test-Path "$panelDir\chat-history.json") {
    $backup = Join-Path $tmpDir "chat-history.backup.json"
    Copy-Item "$panelDir\chat-history.json" $backup
}

# Stop daemon
Write-Host "Stopping daemon..."
Stop-Daemon

# Replace files (preserve user data)
Write-Host "Replacing files..."
robocopy "$extracted\panel" $panelDir /E /PURGE `
    /XF chat-history.json `
    /XD node_modules dist | Out-Null

# Restore chat history
if ($backup -and (Test-Path $backup)) {
    Copy-Item $backup "$panelDir\chat-history.json" -Force
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
    Write-Error "npm not found in known Node.js locations or PATH - run this script from a terminal once"
    Stop-Transcript
    exit 1
}
Write-Host "  npm: $npmCmd"
Push-Location $daemonDir
& $npmCmd install --production
Pop-Location

# Stop any daemon that respawned mid-update (panel reloads on version.json
# change and boots a clean one)
Stop-Daemon

# Write new version.json - version comes from the downloaded tarball
$latestVersion = (Get-Content "$extracted\panel\version.json" | ConvertFrom-Json).version
if (-not $latestVersion) { $latestVersion = "0.0.0" }
@{
    version = $latestVersion
    commit = $latestCommit
} | ConvertTo-Json | Set-Content "$panelDir\version.json"

# Cleanup
Remove-Item -Recurse -Force $tmpDir

Write-Host "=== Update complete: $(Get-Date) ==="
Write-Output "ok:$latestCommit"
Stop-Transcript
