# Gaffer update script (Windows) — downloads latest tarball, replaces files,
# preserves chat history, restarts daemon.
$ErrorActionPreference = "Stop"

$panelDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$daemonDir = "$panelDir\daemon"
$tmpDir = Join-Path $env:TEMP "gaffer-update-$PID"
$repo = "spendolas/gaffer-ae"
$logPath = Join-Path $env:TEMP "gaffer-update.log"

Start-Transcript -Path $logPath -Append
Write-Host "=== Update started: $(Get-Date) ==="

# Get latest commit hash
$apiResponse = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/commits/main"
$latestCommit = $apiResponse.sha
if (-not $latestCommit) {
    Write-Error "Could not fetch latest commit"
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

# Kill daemon
Write-Host "Stopping daemon..."
Get-Process -Name "gaffer-daemon" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*daemon\index.js*" } | Stop-Process -Force
Start-Sleep -Seconds 1

# Replace files (preserve user data)
Write-Host "Replacing files..."
robocopy "$extracted\panel" $panelDir /E /PURGE `
    /XF chat-history.json gaffer-daemon gaffer-daemon.exe `
    /XD node_modules dist | Out-Null

# Restore chat history
if ($backup -and (Test-Path $backup)) {
    Copy-Item $backup "$panelDir\chat-history.json" -Force
}

# npm install
Write-Host "Installing daemon dependencies..."
Push-Location $daemonDir
& npm install --production
Pop-Location

# Write new version.json
@{
    version = "0.2.0"
    commit = $latestCommit
} | ConvertTo-Json | Set-Content "$panelDir\version.json"

# Cleanup
Remove-Item -Recurse -Force $tmpDir

Write-Host "=== Update complete: $(Get-Date) ==="
Write-Output "ok:$latestCommit"
Stop-Transcript
