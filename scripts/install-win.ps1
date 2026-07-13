$ErrorActionPreference = "Stop"

$extensionId = "com.gaffer.panel"
$installDir = "$env:APPDATA\Adobe\CEP\extensions\$extensionId"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$panelDir = "$repoDir\panel"

Write-Host "=== Gaffer Installer (Windows) ==="

# 1. Check prerequisites
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
    Write-Host "ERROR: Claude Code CLI not found."
    Write-Host "Install the native build first:  irm https://claude.ai/install.ps1 | iex"
    Write-Host "(the npm package's shims cannot be launched by the Gaffer daemon)"
    exit 1
}
Write-Host "  Claude CLI: $claudeBin"

$nodeVersion = & node --version 2>$null
if (-not $nodeVersion) {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org"
    exit 1
}
Write-Host "  Node.js: $nodeVersion"

# 2. Stop any running daemon — a live process holds its cwd inside the old
# install (blocks Remove-Item) and would keep serving stale code after update
Write-Host "Stopping any running daemon..."
Get-Process -Name "gaffer-daemon" -ErrorAction SilentlyContinue | Stop-Process -Force
# match by COMMAND LINE — Get-Process .Path is node.exe and never matches the script
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*daemon*index.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# 3. Symlink extension (or copy on systems without symlink support),
# preserving chat history across reinstalls (the 0.1.0 -> latest path)
$historyBackup = $null
if (Test-Path "$installDir\chat-history.json") {
    $historyBackup = Join-Path $env:TEMP "gaffer-chat-history-$PID.json"
    Copy-Item "$installDir\chat-history.json" $historyBackup
}
Write-Host "Installing extension to $installDir..."
if (Test-Path $installDir) { Remove-Item -Recurse -Force $installDir }
try {
    New-Item -ItemType SymbolicLink -Path $installDir -Target $panelDir -Force | Out-Null
    Write-Host "  (symlinked)"
} catch {
    # Symlinks may require admin on some Windows configs — fall back to copy
    robocopy "$panelDir" "$installDir" /E /XD node_modules dist /XF package-lock.json .debug | Out-Null
    Write-Host "  (copied)"
}
if ($historyBackup -and (Test-Path $historyBackup)) {
    Copy-Item $historyBackup "$installDir\chat-history.json" -Force
    Remove-Item $historyBackup -Force
    Write-Host "  (chat history preserved)"
}

# 4. Install daemon dependencies INTO THE DEPLOYED install — installing into
# the source checkout leaves a copied install without node_modules and the
# daemon can never start (symlinked installs resolve to the same place)
Write-Host "Installing daemon dependencies..."
Push-Location "$installDir\daemon"
& npm install --production
Pop-Location

# 5. Registry: PlayerDebugMode
Write-Host "Setting PlayerDebugMode in registry..."
foreach ($ver in @("11", "12")) {
    $key = "HKCU:\Software\Adobe\CSXS.$ver"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name "PlayerDebugMode" -Value 1 -Type DWord
}

# 6. Register MCP server
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
