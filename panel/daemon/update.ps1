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
# A lock whose PID is dead or is not a daemon\update.ps1 is abandoned and
# taken over; a lock older than 15 minutes whose holder is still an
# update.ps1 is a stuck updater, which is stopped first (its whole process
# tree, not just the shell), then taken over.
#
# Takeovers are serialized by a second CreateNew file, $takeoverPath: only
# its holder may stop or remove a lock, and it re-reads the lock's pid inside
# the mutex and only removes the lock if that pid is still the one it judged
# stale. Without this, updater B (which read the stale pid a moment earlier)
# could remove updater A's fresh lock. The finally at the bottom, in turn,
# only deletes a lock whose file still holds THIS pid, so a losing updater
# can never delete the winner's lock on its way out. A takeover marker older
# than 60 seconds was left by a crashed updater and is removed.
# panel\main.js reads the same lock to decide whether an updater is still
# running; keep the path in sync.
$lockPath = Join-Path $env:TEMP "gaffer-update.lock"
$takeoverPath = "$lockPath.takeover"
$script:haveLock = $false
$script:haveTakeover = $false
# GAFFER_UPDATE_TEST_DELAY_MS widens the window between reading a stale
# lock's pid and entering the takeover mutex. Only
# scripts\windows-tests\test-5-update-ps1.ps1 sets it, to make the takeover
# race deterministic.
$testDelayMs = 0
if ($env:GAFFER_UPDATE_TEST_DELAY_MS) { [int]::TryParse($env:GAFFER_UPDATE_TEST_DELAY_MS, [ref] $testDelayMs) | Out-Null }

# The Win32_Process of a live daemon\update.ps1 holder, or $null. This very
# process never counts as a holder (a lock carrying our own pid is a leftover
# from a pid reuse). The process start time is not compared with the lock's
# age: the path match already rules out the common pid-reuse cases.
function Get-LockHolderProcess([string] $holder) {
    $holderPid = 0
    if (-not [int]::TryParse($holder, [ref] $holderPid) -or $holderPid -le 0) { return $null }
    if ($holderPid -eq $PID) { return $null }
    $proc = $null
    try { $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $holderPid" -ErrorAction SilentlyContinue } catch {}
    if (-not $proc -or -not ($proc.CommandLine -like "*daemon\update.ps1*")) { return $null }
    return $proc
}

# taskkill /T /F ends the holder AND every process it started (its curl.exe,
# robocopy, npm); Stop-Process would end only the shell and orphan those.
# Then a short wait for the process to go away. /F gives the holder no
# chance to run its finally, so its lock stays for the caller to take over;
# the closing pause lets the file system settle before the lock is re-read.
function Stop-LockHolder([int] $holderPid) {
    Write-Host "Stopping an update that has run for over 15 minutes (pid $holderPid)"
    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    $ErrorActionPreference = "Continue"
    & $taskkill /PID $holderPid /T /F 2>&1 | Out-Null
    $ErrorActionPreference = "Stop"
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-Process -Id $holderPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
    Start-Sleep -Milliseconds 500
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

# Create $path with CreateNew and this pid in it. $true when we created it.
function New-PidFile([string] $path) {
    $fs = $null
    try {
        # The static File.Open, not New-Object FileStream: PS 5.1 reports a
        # failing constructor inside New-Object as a MethodInvocationException,
        # which a typed catch may not match. The catch is untyped for the same
        # reason: ANY failure while the file exists means another updater
        # created it first (CreateNew lost the race).
        $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        $bytes = [System.Text.Encoding]::ASCII.GetBytes("$PID")
        $fs.Write($bytes, 0, $bytes.Length)
        $fs.Dispose()
        return $true
    } catch {
        if ($fs) { try { $fs.Dispose() } catch {} }
        return $false
    }
}

# Serialize takeovers. $false when another live updater is mid-takeover.
function Enter-TakeoverMutex {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        if (New-PidFile $takeoverPath) { $script:haveTakeover = $true; return $true }
        $item = Get-Item -LiteralPath $takeoverPath -ErrorAction SilentlyContinue
        if (-not $item) { continue }
        $age = ((Get-Date) - $item.LastWriteTime).TotalSeconds
        if ($age -ge 60) {
            Write-Host "Removing a takeover marker left by a crashed updater ($([int] $age) s old)"
            Remove-Item -LiteralPath $takeoverPath -Force -ErrorAction SilentlyContinue
            continue
        }
        return $false
    }
    return $false
}
function Exit-TakeoverMutex {
    if ($script:haveTakeover) {
        Remove-Item -LiteralPath $takeoverPath -Force -ErrorAction SilentlyContinue
        $script:haveTakeover = $false
    }
}

$tries = 0
while (-not $script:haveLock) {
    if (New-PidFile $lockPath) { $script:haveLock = $true; break }
    $tries++
    $lockItem = Get-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue
    if (-not $lockItem) {
        # No lock file: it was released between our attempt and now, or
        # the lock cannot be created here at all. Retry, bounded.
        if ($tries -gt 3) {
            Write-Host "ERROR: could not create the update lock at $lockPath"
            Write-Output "err:lock"
            Stop-Transcript
            exit 1
        }
        continue
    }
    $holder = Read-LockHolder
    $proc = Get-LockHolderProcess $holder
    $lockIsOld = (((Get-Date) - $lockItem.LastWriteTime).TotalMinutes -ge 15)
    if ($proc -and -not $lockIsOld) {
        Write-Host "Another update is already running (pid $holder), leaving it to finish."
        Write-Output "busy:already-running"
        Stop-Transcript
        exit 3
    }
    if ($tries -gt 3) {
        Write-Host "ERROR: could not take the update lock at $lockPath"
        Write-Output "err:lock"
        Stop-Transcript
        exit 1
    }
    if ($testDelayMs -gt 0) { Start-Sleep -Milliseconds $testDelayMs }
    if (-not (Enter-TakeoverMutex)) {
        Write-Host "Another update is taking over the abandoned lock, leaving it to finish."
        Write-Output "busy:already-running"
        Stop-Transcript
        exit 3
    }
    # Inside the mutex: the lock may have been taken over (and re-created)
    # since the pid was read. Only act on the lock we judged stale.
    $nowHolder = Read-LockHolder
    if (-not (Test-Path -LiteralPath $lockPath) -or $nowHolder -ne $holder) { Exit-TakeoverMutex; continue }
    if ($proc) {
        Stop-LockHolder ([int] $proc.ProcessId)
        $nowHolder = Read-LockHolder
        if ((Test-Path -LiteralPath $lockPath) -and $nowHolder -ne $holder) { Exit-TakeoverMutex; continue }
    }
    if (Test-Path -LiteralPath $lockPath) {
        $holderLabel = $holder
        if (-not $holderLabel) { $holderLabel = "unknown" }
        Write-Host "Taking over an abandoned update lock (pid $holderLabel)"
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
    # Still inside the mutex: the taker gets the lock, nobody can slip in
    # between the removal and the re-creation.
    if (New-PidFile $lockPath) { $script:haveLock = $true }
    Exit-TakeoverMutex
}

# From here on the lock is held, so everything runs inside this try: the
# finally releases the lock on every way out, exit calls included.
try {

# Stop-Daemon lives in its own file (dot-sourced) so it stays plain-function-only
# and can be unit-tested in isolation - see scripts/windows-tests/test-4-stop-daemon-stray-pid.ps1
. "$PSScriptRoot\stop-daemon.ps1"

# Every failure after this point goes through here: log, clean up, exit 1.
# The panel dir is untouched until the robocopy step, and version.json is
# only replaced at the very end.
function Exit-Update([string] $message) {
    Write-Host "ERROR: $message"
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
    Stop-Transcript
    exit 1
}

# Download budget: the asset is a few MB. The download goes first through the
# curl.exe Windows ships (Windows 10 1803+, a Schannel build), with the same
# limits as update.sh: an attempt is abandoned when the connection takes over
# 15s or the speed stays under 2 KB/s for 20s, --max-time caps each attempt
# at 150s (which also fails any link slower than asset size / 150s, about
# 20 KB/s for a 3 MB asset), curl retries such timeouts twice, and
# --retry-max-time 120 only lets a retry START while less than 120s have
# passed. Worst case for curl alone: the first attempt dies just under 120s,
# the second runs its full 150s, no third starts: about 270s.
#
# curl.exe does not read the WinINET proxy (Internet Options, PAC scripts),
# and its Schannel build fails the handshake when certificate revocation
# cannot be checked. Both are everyday conditions behind a corporate proxy,
# so a curl failure that is not a final 4xx answer falls back to .NET's
# HttpWebRequest, which honours the system proxy with the user's default
# credentials. HttpWebRequest is used directly, not through
# Invoke-WebRequest, because only the raw response stream lets a stalled body
# be bounded: ReadWriteTimeout applies to every Read, while
# Invoke-WebRequest -TimeoutSec bounds only the response headers on PS 5.1.
# The fallback only runs when curl gave up within 90s and has its own 150s
# budget, so the worst case stays at about 90 + 150 = 240s, under the
# curl-only worst case of 270s, then extract + robocopy + npm. The panel
# (main.js waitForUpdatedVersion) gives up after 180s but extends once by
# 180s while this lock is held, a 360s window; a worst-case download plus a
# slow npm install can outlive it, and then the panel offers "Force stop &
# retry", whose second updater exits busy against this lock, so a slow run
# is never corrupted, only late. A 4xx answer (404 on a missing asset) is
# final on both paths: curl does not retry it, there is no fallback, and the
# error carries the status in parentheses like Invoke-WebRequest's did.
#
# --ssl-no-revoke: the asset's integrity rests on the TLS certificate chain
# for github.com, which stays fully validated; only the OCSP/CRL revocation
# lookup is skipped. That lookup failing (blocked by an inspecting proxy) is
# the commonest curl.exe failure on managed Windows, and the .NET fallback
# does not check revocation either (HttpWebRequest's default), so the flag
# is not a downgrade from the path curl would otherwise fall back to.
# Supported by every Schannel curl since 7.44; Windows ships 7.55 or newer.
#
# GAFFER_UPDATE_CURL replaces the curl.exe path (a failing stand-in exercises
# the fallback). Only scripts\windows-tests\test-5-update-ps1.ps1 sets it.
function Get-ReleaseAsset([string] $uri, [string] $outFile) {
    $curl = Join-Path $env:SystemRoot "System32\curl.exe"
    if ($env:GAFFER_UPDATE_CURL) { $curl = $env:GAFFER_UPDATE_CURL }
    if (Test-Path -LiteralPath $curl -PathType Leaf) {
        $curlStarted = Get-Date
        $curlFailure = $null
        $finalError = $null
        try {
            # Native stderr must not become a terminating error under the
            # script's $ErrorActionPreference = "Stop"; this assignment is
            # local to the function.
            $ErrorActionPreference = "Continue"
            $output = & $curl -f -L -sS --ssl-no-revoke --connect-timeout 15 --speed-limit 2048 --speed-time 20 --max-time 150 --retry 2 --retry-max-time 120 -o $outFile $uri 2>&1
            $code = $LASTEXITCODE
            $ErrorActionPreference = "Stop"
            if ($code -eq 0) { return }
            $text = ($output | ForEach-Object { "$_" }) -join " "
            if ($code -eq 22 -and $text -match "returned error: (\d{3})") {
                $status = [int] $Matches[1]
                if ($status -ge 400 -and $status -lt 500) { $finalError = "The remote server returned an error: ($status)." }
            }
            if (-not $finalError) { $curlFailure = "curl.exe exit $code : $text" }
        } catch {
            $curlFailure = "curl.exe could not run: $($_.Exception.Message)"
        }
        $ErrorActionPreference = "Stop"
        if ($finalError) { throw $finalError }
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        $curlSeconds = ((Get-Date) - $curlStarted).TotalSeconds
        if ($curlSeconds -ge 90) {
            throw "$curlFailure (no time left for the system proxy path after $([int] $curlSeconds)s)"
        }
        Write-Host "  curl.exe could not download the asset ($curlFailure), trying the system proxy path"
    }
    Get-ReleaseAssetViaSystemProxy $uri $outFile
}

# The .NET path: system proxy (WinINET settings, PAC) with the user's default
# credentials, 15s to connect and get headers, every body read bounded to a
# 20s stall, the whole thing to 150s, 4xx final, otherwise up to 3 attempts
# as long as a retry can start within 110s.
function Get-ReleaseAssetViaSystemProxy([string] $uri, [string] $outFile) {
    try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12 } catch {}
    try { [System.Net.WebRequest]::DefaultWebProxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials } catch {}
    $started = Get-Date
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            $req = [System.Net.WebRequest]::Create($uri)
            $req.Timeout = 15000
            $req.ReadWriteTimeout = 20000
            $req.AllowAutoRedirect = $true
            $req.UserAgent = "gaffer-update"
            $resp = $req.GetResponse()
            try {
                $in = $resp.GetResponseStream()
                $out = [System.IO.File]::Create($outFile)
                try {
                    $buf = New-Object byte[] 65536
                    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                        $out.Write($buf, 0, $n)
                        if (((Get-Date) - $started).TotalSeconds -ge 150) { throw "download exceeded its 150s budget" }
                    }
                } finally {
                    $out.Dispose()
                    $in.Dispose()
                }
            } finally { $resp.Close() }
            return
        } catch {
            Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
            # A .NET method's WebException arrives wrapped in a
            # MethodInvocationException; look at both levels for the status.
            $status = 0
            try { $status = [int] $_.Exception.Response.StatusCode } catch {}
            if ($status -eq 0) { try { $status = [int] $_.Exception.InnerException.Response.StatusCode } catch {} }
            if ($status -ge 400 -and $status -lt 500) { throw "The remote server returned an error: ($status)." }
            $reason = $_.Exception.Message
            if ($_.Exception.InnerException) { $reason = $_.Exception.InnerException.Message }
            $elapsed = ((Get-Date) - $started).TotalSeconds
            if ($attempt -ge 3 -or $elapsed -ge 110) { throw "system proxy download failed: $reason" }
            Write-Host "  download attempt $attempt failed ($reason), retrying"
            Start-Sleep -Seconds 2
        }
    }
}

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
    # /R:2 /W:2: two retries, two seconds apart, on a file that is briefly
    # locked (an indexer, a daemon not yet gone), instead of robocopy's
    # default of a million retries at 30 seconds each.
    robocopy $extractDir $panelDir /E /PURGE /R:2 /W:2 `
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
    # Only ever delete a lock that is still ours: a stuck run that was taken
    # over must not delete its successor's lock on the way out.
    Exit-TakeoverMutex
    if ($script:haveLock -and ((Read-LockHolder) -eq "$PID")) { Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }
}
