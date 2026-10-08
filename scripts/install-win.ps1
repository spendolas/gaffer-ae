$ErrorActionPreference = "Stop"

$extensionId = "com.gaffer.panel"
$installDir = "$env:APPDATA\Adobe\CEP\extensions\$extensionId"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$panelDir = "$repoDir\panel"

Write-Host "=== Gaffer Installer (Windows) ==="

# 1. Look for a runnable Claude. The panel chat works with either the Claude
# desktop app's bundled Claude Code or a standalone CLI (the daemon finds
# whichever is present at runtime, see panel\daemon\claude-binary.js), so a
# missing Claude is a warning here, not a failed install.
Write-Host "Checking prerequisites..."
$claudeBin = $null
$claudeKind = $null
$candidates = @(
    "$env:USERPROFILE\.local\bin\claude.exe",
    "$env:LOCALAPPDATA\Programs\claude-code\claude.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\claude.exe"
)
foreach ($c in $candidates) {
    if (Test-Path $c -PathType Leaf) { $claudeBin = $c; break }
}
if (-not $claudeBin) {
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    # only a real .exe: the npm package's .cmd shims cannot be launched by the daemon
    if ($cmd -and $cmd.Source -and ($cmd.Source -like "*.exe")) { $claudeBin = $cmd.Source }
}
if ($claudeBin) {
    $claudeKind = "cli"
} else {
    # Desktop app copy: %APPDATA%\Claude\claude-code\<version>\<hash>\claude.exe
    # (newest version folder first; the hash level is absent in older layouts).
    $appRoot = "$env:APPDATA\Claude\claude-code"
    if (Test-Path $appRoot -PathType Container) {
        $versionDirs = Get-ChildItem -Path $appRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object -Descending -Property @{ Expression = {
                $v = $null
                if ([version]::TryParse($_.Name, [ref]$v)) { $v } else { [version]"0.0" }
            } }
        foreach ($vdir in $versionDirs) {
            $exe = Get-ChildItem -Path $vdir.FullName -Recurse -Depth 3 -Filter "claude.exe" -File -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($exe) { $claudeBin = $exe.FullName; $claudeKind = "app"; break }
        }
    }
}
if (-not $claudeBin) {
    Write-Host "WARNING: no Claude found. Gaffer chat needs the Claude desktop app or Claude Code:"
    Write-Host "  Claude desktop app: https://claude.com/download"
    Write-Host "  Claude Code (CLI):  https://claude.ai/code  (native build: irm https://claude.ai/install.ps1 | iex)"
    Write-Host "  Installing the panel anyway; install one of them before opening Gaffer."
} elseif ($claudeKind -eq "app") {
    Write-Host "  Claude (desktop app): $claudeBin"
} else {
    Write-Host "  Claude CLI: $claudeBin"
}

$nodeVersion = & node --version 2>$null
if (-not $nodeVersion) {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org"
    exit 1
}
Write-Host "  Node.js: $nodeVersion"

# 2. Stop any running daemon - a live process holds its cwd inside the old
# install (blocks Remove-Item) and would keep serving stale code after update
Write-Host "Stopping any running daemon..."
Get-Process -Name "gaffer-daemon" -ErrorAction SilentlyContinue | Stop-Process -Force
# match by COMMAND LINE - Get-Process .Path is node.exe and never matches the script
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*daemon*index.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# 3. Symlink extension (or copy on systems without symlink support),
# preserving chat history across reinstalls (the 0.1.0 -> latest path) -
# both the legacy single file and per-AE-version files
# (chat-history-<aeVersion>.json, e.g. chat-history-26.0.json)
$historyBackup = $null
if (Test-Path "$installDir\chat-history.json") {
    $historyBackup = Join-Path $env:TEMP "gaffer-chat-history-$PID.json"
    Copy-Item "$installDir\chat-history.json" $historyBackup
}
$historyBackupDir = Join-Path $env:TEMP "gaffer-chat-history-versions-$PID"
New-Item -ItemType Directory -Path $historyBackupDir -Force | Out-Null
Get-ChildItem -Path $installDir -Filter "chat-history-*.json" -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item $_.FullName $historyBackupDir }
Write-Host "Installing extension to $installDir..."
if (Test-Path $installDir) { Remove-Item -Recurse -Force $installDir }
try {
    New-Item -ItemType SymbolicLink -Path $installDir -Target $panelDir -Force | Out-Null
    Write-Host "  (symlinked)"
} catch {
    # Symlinks may require admin on some Windows configs - fall back to copy
    robocopy "$panelDir" "$installDir" /E /XD node_modules dist /XF package-lock.json .debug | Out-Null
    Write-Host "  (copied)"
}
if ($historyBackup -and (Test-Path $historyBackup)) {
    Copy-Item $historyBackup "$installDir\chat-history.json" -Force
    Remove-Item $historyBackup -Force
    Write-Host "  (chat history preserved)"
}
$restoredVersioned = Get-ChildItem -Path $historyBackupDir -Filter "chat-history-*.json" -ErrorAction SilentlyContinue
if ($restoredVersioned) {
    $restoredVersioned | ForEach-Object { Copy-Item $_.FullName "$installDir\" -Force }
    Write-Host "  (per-version chat history preserved)"
}
Remove-Item -Recurse -Force $historyBackupDir -ErrorAction SilentlyContinue

# 4. Install daemon dependencies INTO THE DEPLOYED install - installing into
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

# 6. Register MCP server (only used by Claude Code outside AE; the panel chat
# passes its own MCP config and does not need this). Skip when there is no
# Claude, or when the desktop app copy does not run from the command line.
# Native command failures must never abort the install, so they are caught.
$registerMcp = $false
if (-not $claudeBin) {
    Write-Host "Skipping MCP server registration (no Claude found)."
} elseif ($claudeKind -eq "app") {
    $answers = $false
    try {
        $null = & $claudeBin --version 2>&1
        $answers = ($LASTEXITCODE -eq 0)
    } catch { $answers = $false }
    if ($answers) { $registerMcp = $true }
    else { Write-Host "Skipping MCP server registration (the desktop app's Claude Code did not answer --version)." }
} else {
    $registerMcp = $true
}
if ($registerMcp) {
    Write-Host "Registering Gaffer MCP server..."
    $registered = $false
    try {
        $null = & $claudeBin mcp add --transport http -s user gaffer "http://127.0.0.1:9824/mcp" 2>&1
        $registered = ($LASTEXITCODE -eq 0)
    } catch { $registered = $false }
    if (-not $registered) {
        Write-Host "WARNING: could not register the Gaffer MCP server with Claude Code. The panel still works;"
        Write-Host "  to use Gaffer tools from Claude Code outside AE, run:"
        Write-Host "  claude mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp"
    }
}

Write-Host ""
Write-Host "=== Installation complete ==="
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart After Effects"
Write-Host "  2. Open Window > Extensions > Gaffer"
Write-Host "  3. The daemon starts automatically when the panel loads"
Write-Host ""
