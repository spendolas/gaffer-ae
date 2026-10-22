$ErrorActionPreference = "Stop"

$extensionId = "com.gaffer.panel"
$installDir = "$env:APPDATA\Adobe\CEP\extensions\$extensionId"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$panelDir = "$repoDir\panel"

Write-Host "=== Gaffer Installer (Windows) ==="
# Developer installer from a checkout. A symlinked install runs the daemon
# from source with the system Node.js (npm install below). When symlinks are
# not allowed the panel is copied instead; a copy that carries a built
# daemon\daemon.mjs (scripts/build.sh) gets the pinned Node runtime from
# daemon\fetch-runtime.ps1 and needs no Node.js at all. End users follow
# README.md, which needs neither Node.js nor npm.

# 1. Look for a runnable Claude. The panel chat works with either the Claude
# desktop app's bundled Claude Code or a standalone CLI (the daemon finds
# whichever is present at runtime, see panel\daemon\claude-binary.js), so a
# missing Claude is a warning here, not a failed install.
Write-Host "Checking prerequisites..."

# Runs a native command and returns its exit code. Under the script's
# $ErrorActionPreference = "Stop", stderr text from a native command that
# succeeded (claude prints notices there) would otherwise terminate the
# install; the preference set here is local to this function.
function Invoke-Native([string] $exe, [string[]] $arguments) {
    $ErrorActionPreference = "Continue"
    # A launch that fails outright leaves $LASTEXITCODE untouched, so a stale
    # 0 from an earlier call would read as success. Reset it first.
    $global:LASTEXITCODE = -1
    $null = & $exe @arguments 2>&1
    return $LASTEXITCODE
}

$claudeBin = $null
$claudeKind = $null
$npmShim = $null
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
    # only a real .exe: the npm package's .cmd / .ps1 shims cannot be launched by the daemon
    if ($cmd -and $cmd.Source -and ($cmd.Source -like "*.exe")) { $claudeBin = $cmd.Source }
    elseif ($cmd -and $cmd.Source -and (($cmd.Source -like "*.cmd") -or ($cmd.Source -like "*.ps1"))) { $npmShim = $cmd.Source }
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
if (-not $claudeBin -and $npmShim) {
    Write-Host "Found the npm install of Claude Code, but Gaffer needs the native build or the Claude desktop app: irm https://claude.ai/install.ps1 | iex, or https://claude.com/download"
    Write-Host "  (npm shim: $npmShim)"
    Write-Host "  Installing the panel anyway; install one of them before opening Gaffer."
} elseif (-not $claudeBin) {
    Write-Host "WARNING: no Claude found. Gaffer chat needs the Claude desktop app or Claude Code:"
    Write-Host "  Claude desktop app: https://claude.com/download"
    Write-Host "  Claude Code (CLI):  https://claude.ai/code  (native build: irm https://claude.ai/install.ps1 | iex)"
    Write-Host "  Installing the panel anyway; install one of them before opening Gaffer."
} elseif ($claudeKind -eq "app") {
    Write-Host "  Claude (desktop app): $claudeBin"
} else {
    Write-Host "  Claude CLI: $claudeBin"
}

# Node.js is checked only where it is needed (the npm path below).
function Assert-SystemNode {
    $nodeVersion = & node --version 2>$null
    if (-not $nodeVersion) {
        Write-Host "ERROR: this install runs the daemon from source and needs Node.js 20+ and npm."
        Write-Host "  To install Gaffer without Node.js, follow the install steps in README.md instead."
        exit 1
    }
    Write-Host "  Node.js: $nodeVersion"
}

# npm's cache, logs and userconfig stay inside the repo, so nothing lands in
# the developer's profile (spec section 9). The previous values come back
# afterwards because a dot-sourced run shares the caller's environment.
function Invoke-DevNpmInstall([string] $daemonDir) {
    Assert-SystemNode
    $saved = @{}
    $npmEnv = @{
        npm_config_cache = "$repoDir\.npm-cache"
        npm_config_logs_dir = "$repoDir\.npm-cache\_logs"
        npm_config_userconfig = "$repoDir\.npmrc-dev"
    }
    foreach ($k in $npmEnv.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
        [Environment]::SetEnvironmentVariable($k, $npmEnv[$k], "Process")
    }
    try {
        Write-Host "Installing daemon dependencies..."
        Push-Location $daemonDir
        try { & npm install --omit=dev } finally { Pop-Location }
    } finally {
        foreach ($k in $npmEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], "Process") }
    }
}

# 2. Stop any running daemon - a live process holds its cwd inside the old
# install (blocks Remove-Item) and would keep serving stale code after update
Write-Host "Stopping any running daemon..."
Get-Process -Name "gaffer-daemon" -ErrorAction SilentlyContinue | Stop-Process -Force
# Whatever listens on the daemon port (runtime\node.exe daemon.mjs or a
# system node with index.js), same helper as update.ps1.
$stopHelper = Join-Path $panelDir "daemon\stop-daemon.ps1"
if (Test-Path $stopHelper -PathType Leaf) {
    try { . $stopHelper; Stop-Daemon } catch { Write-Host "  (could not stop the daemon by port: $($_.Exception.Message))" }
}
# match by COMMAND LINE - Get-Process .Path is node.exe and never matches the script
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { ($_.CommandLine -like "*daemon*index.js*") -or ($_.CommandLine -like "*daemon*daemon.mjs*") } |
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
$installKind = "symlink"
try {
    New-Item -ItemType SymbolicLink -Path $installDir -Target $panelDir -Force | Out-Null
    Write-Host "  (symlinked)"
} catch {
    # Symlinks may require admin on some Windows configs - fall back to copy.
    # Never copy a checkout's runtime folders or local session history; the
    # copy gets its own verified runtime below.
    $installKind = "copy"
    robocopy "$panelDir" "$installDir" /E /XD node_modules dist .remember runtime runtime.new runtime.old /XF package-lock.json .debug | Out-Null
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

# 4. Daemon code and runtime, INTO THE DEPLOYED install (symlinked installs
# resolve to the checkout itself).
#   symlink:                npm install, system node runs index.js
#   copy with daemon.mjs:   fetch-runtime.ps1 provisions the pinned runtime, no Node.js needed
#   copy without daemon.mjs: npm install like a symlink (run scripts/build.sh first to avoid it)
$deployedDaemon = "$installDir\daemon"
if ($installKind -eq "copy" -and (Test-Path "$deployedDaemon\daemon.mjs" -PathType Leaf)) {
    Write-Host "Installing the pinned Node runtime..."
    # A separate PowerShell process: fetch-runtime.ps1 ends with exit, and its
    # last output line is the contract (runtime:current / runtime:installed / err:runtime).
    $psExe = (Get-Process -Id $PID).Path
    # Continue inside the block: under "Stop", a stderr line from the child
    # would end this installer before the contract line is read.
    $fetchOut = & {
        $ErrorActionPreference = "Continue"
        & $psExe -NoProfile -ExecutionPolicy Bypass -File "$deployedDaemon\fetch-runtime.ps1" -Into $deployedDaemon 2>&1
    }
    $fetchOut | ForEach-Object { Write-Host "  $_" }
    $last = [string] ($fetchOut | Select-Object -Last 1)
    if ($last -notmatch '^runtime:(current|installed)') {
        Write-Host "ERROR: could not install Gaffer's Node runtime (see the lines above). Check the network and run this installer again."
        exit 1
    }
} else {
    if ($installKind -eq "copy") {
        Write-Host "  This checkout has no daemon\daemon.mjs (scripts/build.sh builds it), so the copy runs from source with npm."
    }
    Invoke-DevNpmInstall $deployedDaemon
}

# 5. Registry: PlayerDebugMode
Write-Host "Setting PlayerDebugMode in registry..."
# A user preference that lets AE load extensions not signed through Adobe.
foreach ($ver in @("11", "12", "13")) {
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
    try { $answers = ((Invoke-Native $claudeBin @("--version")) -eq 0) } catch { $answers = $false }
    if ($answers) { $registerMcp = $true }
    else { Write-Host "Skipping MCP server registration (the desktop app's Claude Code did not answer --version)." }
} else {
    $registerMcp = $true
}
if ($registerMcp) {
    # A reinstall: registering again would only warn about the existing entry.
    $already = $false
    try { $already = ((Invoke-Native $claudeBin @("mcp", "get", "gaffer")) -eq 0) } catch { $already = $false }
    if ($already) { Write-Host "  Gaffer MCP server already registered with Claude Code."; $registerMcp = $false }
}
if ($registerMcp) {
    Write-Host "Registering Gaffer MCP server..."
    Write-Host "  This adds an entry named gaffer to your Claude Code user settings (%USERPROFILE%\.claude.json)."
    Write-Host "  To remove it later: claude mcp remove gaffer -s user"
    $registered = $false
    try {
        $registered = ((Invoke-Native $claudeBin @("mcp", "add", "--transport", "http", "-s", "user", "gaffer", "http://127.0.0.1:9824/mcp")) -eq 0)
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
