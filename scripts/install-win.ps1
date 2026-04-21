$ErrorActionPreference = "Stop"

$extensionId = "com.gaffer.panel"
$installDir = "$env:APPDATA\Adobe\CEP\extensions\$extensionId"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$panelDir = "$repoDir\panel"

Write-Host "=== Gaffer Installer (Windows) ==="

# 1. Check Claude CLI
Write-Host "Checking prerequisites..."
$claudeBin = $null
$candidates = @(
    "$env:LOCALAPPDATA\Programs\claude-code\claude.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\claude.exe"
)
foreach ($c in $candidates) {
    if (Test-Path $c) { $claudeBin = $c; break }
}
if (-not $claudeBin) {
    $claudeBin = (Get-Command claude -ErrorAction SilentlyContinue).Source
}
if (-not $claudeBin) {
    Write-Host "ERROR: Claude Code CLI not found. Install from https://claude.ai/code"
    exit 1
}
Write-Host "  Claude CLI: $claudeBin"

# Check binary
$daemonBin = "$panelDir\daemon\gaffer-daemon.exe"
if (-not (Test-Path $daemonBin)) {
    Write-Host "ERROR: gaffer-daemon.exe not found. Run build.sh --all first."
    exit 1
}
Write-Host "  Daemon binary: found"

# 2. Copy extension
Write-Host "Installing extension to $installDir..."
if (Test-Path $installDir) { Remove-Item -Recurse -Force $installDir }
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

# Copy panel files (exclude dev artifacts)
robocopy "$panelDir" "$installDir" /E /XD node_modules dist /XF package-lock.json .debug | Out-Null

# 3. Write config
Write-Host "Writing config..."
@{claudeBin = $claudeBin} | ConvertTo-Json | Set-Content "$installDir\.gaffer-config.json"

# 4. Registry: PlayerDebugMode
Write-Host "Setting PlayerDebugMode in registry..."
foreach ($ver in @("11", "12")) {
    $key = "HKCU:\Software\Adobe\CSXS.$ver"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name "PlayerDebugMode" -Value 1 -Type DWord
}

# 5. Register MCP server
Write-Host "Registering Gaffer MCP server..."
& $claudeBin mcp add --transport http -s user gaffer "http://127.0.0.1:9824/mcp" 2>$null

Write-Host ""
Write-Host "=== Installation complete ==="
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart After Effects"
Write-Host "  2. Open Window > Extensions > Gaffer"
Write-Host "  3. The daemon starts automatically when the panel loads"
Write-Host ""
