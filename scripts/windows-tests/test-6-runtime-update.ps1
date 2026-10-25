# test-6-runtime-update.ps1
# ======================================================================
# End-to-end test for the runtime step of panel\daemon\update.ps1 (the
# zero-dependency install, spec sections 6 to 8), against scratch installs.
# Windows only, Windows PowerShell 5.1 (the gaffer-winvm test VM). Companion
# of test-5-update-ps1.ps1, which still covers the lock, download and sync
# contracts.
#
# Every case builds a NEW-layout install (the release zip expanded, with a
# daemon\runtime folder, old daemon\node_modules leftovers and user data) under
# a path with a space and an accent, then runs update.ps1 from inside it with
# GAFFER_UPDATE_ASSET pointing at a test asset: -ReleaseZip with the
# update.ps1, stop-daemon.ps1 and fetch-runtime.ps1 from -UpdateScriptDir
# put in (the updater runs the ARCHIVE's fetch-runtime.ps1). The runtime is
# never fetched from nodejs.org: fetch-runtime.ps1's GAFFER_FETCH_* test seams
# point it at a local zip of -NodeExe (served as a file:// URL, pins written
# to match) or at an unreachable address.
#
# Cases:
#   1  runtime unchanged: no download (sources unreachable), runtime\node.exe
#      hash, size and mtime and both stamps unchanged; runtime survives
#      robocopy /PURGE; the old daemon\node_modules is removed by the sync;
#      user data kept; no npm step; ok:<version>.
#   2  runtime changed (installed VERSION is older): staged before the daemon
#      is stopped, swapped in, stamps match the pins, no runtime.new or
#      runtime.old left, ok:<version>.
#   2b runtime changed while a node.exe runs from the old runtime: the swap
#      still succeeds (rename aside), the locked runtime.old is left, logged
#      and survives /PURGE; the next update (process gone) removes it.
#   3  stage failure (both sources fail the checksum): err:runtime, exit 1,
#      the whole install byte-identical (runtime and node_modules included),
#      no runtime.new, the daemon never stopped, temp folders gone.
#   3b an archive without fetch-runtime.ps1: err:runtime, install untouched.
#   4a killed between the two renames (GAFFER_UPDATE_TEST_SWAP_GATE): the
#      install is left with runtime.old and no runtime; the next update
#      restores runtime.old first, then installs the new runtime, ok:.
#   4b the same state with a CURRENT runtime.old and unreachable sources: the
#      next update restores it and finds it current (no download), the
#      runtime is byte-identical to before.
#   4c the same state, but the restore cannot rename runtime.old back (this
#      script holds a file inside it open without delete sharing, which
#      blocks a directory rename): err:runtime-swap, exit 1, before anything
#      is downloaded, the install byte-identical, lock and temp cleaned up.
#   5a repair (update.ps1 -Repair, the panel's Repair button) at the SAME
#      version with a current runtime: fetch-runtime.ps1 gets -Force, the
#      runtime is downloaded and swapped in as a new folder, version.json
#      keeps its content, ok:<version>.
#   5b a damaged runtime (node.exe truncated) at the same version, plain
#      update: the stamp check fails, so the runtime is re-provisioned.
#   5c a repair whose download fails: err:runtime, exit 1, install
#      byte-identical, the daemon never stopped.
#
# update.ps1 stops whatever listens on port 9823, so this refuses to run
# while a Gaffer daemon is up (close After Effects first), unless
# -ShimDaemonStop is given: each scratch install then gets a no-op
# stop-daemon.ps1 and the live daemon is left alone.
#
# Inputs:
#   -UpdateScriptDir  folder with the NEW update.ps1, stop-daemon.ps1 and
#                     fetch-runtime.ps1 (for example <repo>\panel\daemon)
#   -ReleaseZip       gaffer-update-win.zip from scripts/package-release.sh
#                     (zero-dependency layout: daemon\daemon.mjs and
#                     daemon\runtime-pins.json inside)
#   -NodeExe          a node.exe to serve as the runtime (default: node.exe
#                     on PATH). An official one is OpenJS-signed, so the
#                     Authenticode check runs for real; any other is served
#                     with GAFFER_FETCH_SKIP_CODESIGN=1 (logged as NOTE).
#   -ShimDaemonStop   leave a running daemon alone (see above)
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\test-6-runtime-update.ps1 -UpdateScriptDir <dir> -ReleaseZip <zip> [-NodeExe <node.exe>] [-ShimDaemonStop]
#
# Expected output: one "PASS: ..." line per check, no "FAIL:" line, and the
# last line "ALL PASS" (exit 0). Any failure prints "FAIL: ..." with the log
# path and ends with "<n> FAILURE(S)" (exit 1). Takes a few minutes: every
# runtime change copies and hashes a node.exe of about 90 MB, and the first
# smoke run of each fresh copy is scanned by Defender.
param(
    [Parameter(Mandatory = $true)][string] $UpdateScriptDir,
    [Parameter(Mandatory = $true)][string] $ReleaseZip,
    [string] $NodeExe = "",
    [switch] $ShimDaemonStop
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:fails = 0
function Pass([string] $m) { Write-Host "PASS: $m" }
function Fail([string] $m) { Write-Host "FAIL: $m"; $script:fails++ }
function Note([string] $m) { Write-Host "NOTE: $m" }

Write-Host "PowerShell $($PSVersionTable.PSVersion)"
if (-not $ShimDaemonStop -and (Get-NetTCPConnection -LocalPort 9823 -State Listen -ErrorAction SilentlyContinue)) {
    Write-Host "ABORT: something is listening on port 9823 (a running Gaffer daemon). Close After Effects first,"
    Write-Host "or re-run with -ShimDaemonStop to leave the daemon alone."
    exit 2
}
foreach ($f in @("update.ps1", "stop-daemon.ps1", "fetch-runtime.ps1")) {
    if (-not (Test-Path -LiteralPath (Join-Path $UpdateScriptDir $f) -PathType Leaf)) { Write-Host "ABORT: $f not found in $UpdateScriptDir"; exit 2 }
}
if (-not (Select-String -LiteralPath (Join-Path $UpdateScriptDir "update.ps1") -Pattern "fetch-runtime.ps1" -SimpleMatch -Quiet)) {
    Write-Host "ABORT: $UpdateScriptDir\update.ps1 has no runtime step (still the npm updater)"
    exit 2
}
if (-not $NodeExe) {
    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $NodeExe = $cmd.Source }
}
if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { Write-Host "ABORT: no node.exe; pass -NodeExe"; exit 2 }
if ($ShimDaemonStop) { Write-Host "-ShimDaemonStop set: Stop-Daemon is a no-op in every scratch install" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$accent = [string] [char] 0x00E9
$scratch = Join-Path $env:TEMP ("gaffer-rt-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$tmp = Join-Path $scratch "tmp"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$logPath = Join-Path $tmp "gaffer-update.log"
$lockPath = Join-Path $tmp "gaffer-update.lock"
$unreachable = "http://127.0.0.1:9/"
$fetchVars = @("GAFFER_FETCH_TEST", "GAFFER_FETCH_PINS", "GAFFER_FETCH_PLATFORM", "GAFFER_FETCH_BASE_OFFICIAL", "GAFFER_FETCH_BASE_MIRROR", "GAFFER_FETCH_SKIP_CODESIGN")

function Get-Sha([string] $path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Ascii([string] $path, [string] $text) { [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false))) }

# ---------- Fixture runtime: a zip of -NodeExe under the pinned member path ----------
$nodeVersion = (& $NodeExe --version).Trim()
$plat = "win-x64"
$top = "node-$nodeVersion-$plat"
$member = "$top/node.exe"
$archiveName = "$top.zip"
$fx = Join-Path $scratch "fixture"
New-Item -ItemType Directory -Path (Join-Path $fx "src\$top"), (Join-Path $fx "serve") -Force | Out-Null
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $fx "src\$top\node.exe")
$binBytes = (Get-Item -LiteralPath $NodeExe).Length
$binSha = Get-Sha $NodeExe
$servedZip = Join-Path $fx "serve\$archiveName"
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
& $tar -a -c -f $servedZip -C (Join-Path $fx "src") $member
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $servedZip)) { Write-Host "ABORT: could not build the fixture zip with tar.exe"; exit 2 }
$archiveSha = Get-Sha $servedZip
$goodBase = ([System.Uri] ((Join-Path $fx "serve") + "\")).AbsoluteUri
$skipCodesign = ""
$sig = Get-AuthenticodeSignature -LiteralPath $NodeExe
if ($sig.Status -ne "Valid" -or -not $sig.SignerCertificate -or $sig.SignerCertificate.Subject -notmatch "OpenJS Foundation") {
    $skipCodesign = "1"
    Note "$NodeExe is not OpenJS-signed (status $($sig.Status)); the Authenticode check is skipped in this run"
}
Write-Host "Fixture runtime: $nodeVersion, $binBytes bytes, sha256 $binSha"

function New-Pins([string] $path, [string] $archiveShaPin) {
    $pins = @{ node = @{
        version = $nodeVersion; codename = "Test"
        official = "https://example.invalid/official/"; mirror = "https://example.invalid/mirror/"
        platforms = @{ $plat = @{ archive = $archiveName; archiveSha256 = $archiveShaPin; member = $member; binaryBytes = $binBytes; binarySha256 = $binSha } }
        signing = @{ darwinTeamId = "HX7739G8FX"; windowsSigner = "OpenJS Foundation" }
    } }
    Write-Ascii $path ($pins | ConvertTo-Json -Depth 6)
}
$goodPins = Join-Path $scratch "pins-good.json"
$badPins = Join-Path $scratch "pins-badhash.json"
New-Pins $goodPins $archiveSha
New-Pins $badPins ("0" * 64)
$currentLine = "$nodeVersion $plat"

# ---------- Test assets: the release zip with the new scripts put in ----------
function New-Asset([string] $zipPath, [switch] $NoFetchScript) {
    $src = Join-Path $scratch ("asset-src-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
    Expand-Archive -LiteralPath $ReleaseZip -DestinationPath $src -Force
    if (-not (Test-Path -LiteralPath (Join-Path $src "daemon\daemon.mjs"))) {
        Note "the release zip has no daemon\daemon.mjs (not a zero-dependency build); a stub is added for this test"
        Write-Ascii (Join-Path $src "daemon\daemon.mjs") "// test stub`n"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $src "daemon\runtime-pins.json"))) {
        Note "the release zip has no daemon\runtime-pins.json; the test pins are copied in"
        Copy-Item -LiteralPath $goodPins -Destination (Join-Path $src "daemon\runtime-pins.json")
    }
    foreach ($f in @("update.ps1", "stop-daemon.ps1", "fetch-runtime.ps1")) {
        Copy-Item -LiteralPath (Join-Path $UpdateScriptDir $f) -Destination (Join-Path $src "daemon\$f") -Force
    }
    if ($NoFetchScript) { Remove-Item -LiteralPath (Join-Path $src "daemon\fetch-runtime.ps1") -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($src, $zipPath)
    Remove-Item -LiteralPath $src -Recurse -Force
}
$asset = Join-Path $scratch "gaffer-update-win.zip"
$assetNoFetch = Join-Path $scratch "gaffer-update-win-nofetch.zip"
New-Asset $asset
New-Asset $assetNoFetch -NoFetchScript
$expected = Join-Path $scratch "expected"
Expand-Archive -LiteralPath $asset -DestinationPath $expected -Force
$wantOk = "ok:" + ((Get-Content -LiteralPath (Join-Path $expected "version.json") -Raw | ConvertFrom-Json).version)
$assetHasLock = Test-Path -LiteralPath (Join-Path $expected "daemon\package-lock.json")

# ---------- Installs ----------
$userFiles = @("chat-history.json", "chat-history-26.0.json", ".gaffer-config.json", ".gaffer-usage-buffer.json", ".gaffer-icons\notion.svg")
# A runtime folder as fetch-runtime.ps1 leaves it, with $versionLine in VERSION.
function New-Runtime([string] $dir, [string] $versionLine) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $dir "node.exe") -Force
    Write-Ascii (Join-Path $dir "VERSION") "$versionLine`n"
    Write-Ascii (Join-Path $dir "VERIFIED") "$binBytes $binSha`n"
}
# A zero-dependency install with a runtime ($versionLine; "" for none), the
# node_modules and package-lock.json an 0.11.x install left, and user data.
function New-TestInstall([string] $name, [string] $versionLine) {
    $dir = Join-Path $scratch "Program Data $accent\$name\com.gaffer.panel"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Expand-Archive -LiteralPath $asset -DestinationPath $dir -Force
    Write-Ascii (Join-Path $dir "version.json") '{ "version": "0.0.1", "commit": "old" }'
    if ($ShimDaemonStop) {
        Write-Ascii (Join-Path $dir "daemon\stop-daemon.ps1") "function Stop-Daemon { param([int[]] `$ProcIds = `$null) }`r`n"
    }
    New-Item -ItemType Directory -Path (Join-Path $dir "daemon\node_modules\ws") -Force | Out-Null
    Write-Ascii (Join-Path $dir "daemon\node_modules\ws\index.js") "module.exports = 1;`n"
    if (-not $assetHasLock) { Write-Ascii (Join-Path $dir "daemon\package-lock.json") "{}`n" }
    Write-Ascii (Join-Path $dir "chat-history.json") '{"messages":["legacy"]}'
    Write-Ascii (Join-Path $dir "chat-history-26.0.json") '{"messages":["ae26"]}'
    Write-Ascii (Join-Path $dir ".gaffer-config.json") '{"installId":"legacy"}'
    Write-Ascii (Join-Path $dir ".gaffer-usage-buffer.json") '[{"event":"unsent"}]'
    New-Item -ItemType Directory -Path (Join-Path $dir ".gaffer-icons") -Force | Out-Null
    Write-Ascii (Join-Path $dir ".gaffer-icons\notion.svg") '<svg id="cached"/>'
    if ($versionLine) { New-Runtime (Join-Path $dir "daemon\runtime") $versionLine }
    return $dir
}

# Every file under $dir with its hash (runtime and node_modules included).
function Get-TreeHash([string] $dir) {
    $lines = Get-ChildItem -LiteralPath $dir -Recurse -File -Force |
        Sort-Object FullName |
        ForEach-Object { $_.FullName.Substring($dir.Length) + " " + $_.Length + " " + (Get-Sha $_.FullName) }
    return ($lines -join "`n")
}
# node.exe hash, size and mtime plus both stamps.
function Get-RuntimeFingerprint([string] $dir) {
    $rt = Join-Path $dir "daemon\runtime"
    $exe = Join-Path $rt "node.exe"
    if (-not (Test-Path -LiteralPath $exe)) { return "no runtime" }
    $item = Get-Item -LiteralPath $exe
    $v = [System.IO.File]::ReadAllText((Join-Path $rt "VERSION"))
    $s = [System.IO.File]::ReadAllText((Join-Path $rt "VERIFIED"))
    return "$(Get-Sha $exe) $($item.Length) $($item.LastWriteTimeUtc.Ticks) | $v | $s"
}
function Get-UserHashes([string] $dir) {
    $h = @{}
    foreach ($f in $userFiles) { $h[$f] = Get-Sha (Join-Path $dir $f) }
    return $h
}
function Test-UserData([string] $dir, $before, [string] $label) {
    foreach ($f in $userFiles) {
        $p = Join-Path $dir $f
        if ((Test-Path -LiteralPath $p) -and ((Get-Sha $p) -eq $before[$f])) { Pass "$label`: $f preserved" } else { Fail "$label`: $f lost or changed" }
    }
}

# Sets the fetch-runtime seams for the updater (and its child) to see.
function Set-FetchEnv([string] $base, [string] $pins) {
    $env:GAFFER_FETCH_TEST = "1"
    $env:GAFFER_FETCH_PINS = $pins
    $env:GAFFER_FETCH_PLATFORM = $plat
    $env:GAFFER_FETCH_BASE_OFFICIAL = $base
    $env:GAFFER_FETCH_BASE_MIRROR = $base
    if ($skipCodesign) { $env:GAFFER_FETCH_SKIP_CODESIGN = "1" } else { Remove-Item -LiteralPath "Env:\GAFFER_FETCH_SKIP_CODESIGN" -ErrorAction SilentlyContinue }
}
function Clear-FetchEnv { foreach ($v in $fetchVars) { Remove-Item -LiteralPath "Env:\$v" -ErrorAction SilentlyContinue } }

# Runs update.ps1 inside $dir to completion (fresh log), returns the exit
# code. -Repair runs it the way the panel's Repair button does.
function Invoke-Update([string] $dir, [string] $assetPath, [switch] $Repair) {
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $env:GAFFER_UPDATE_ASSET = $assetPath
    $env:TEMP = $tmp
    $updArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $dir "daemon\update.ps1"))
    if ($Repair) { $updArgs += "-Repair" }
    & powershell.exe @updArgs | Out-Null
    return $LASTEXITCODE
}
function Read-Log {
    if (Test-Path -LiteralPath $logPath) { return [string] (Get-Content -LiteralPath $logPath -Raw) }
    return ""
}
function Get-LastLogLine {
    if (-not (Test-Path -LiteralPath $logPath)) { return "" }
    $lines = Get-Content -LiteralPath $logPath | Where-Object { $_ -ne "" }
    # Start-Transcript appends its own footer after the script's last line.
    $body = $lines | Where-Object { $_ -notmatch '^\*{10,}' -and $_ -notmatch '^(Windows PowerShell transcript end|End time:)' }
    if ($body) { return [string] ($body | Select-Object -Last 1) }
    return ""
}
function Test-Clean([string] $dir, [string] $label) {
    foreach ($d in @("runtime.new", "runtime.old")) {
        if (Test-Path -LiteralPath (Join-Path $dir "daemon\$d")) { Fail "$label`: daemon\$d left behind" } else { Pass "$label`: no daemon\$d" }
    }
    if (Get-ChildItem -LiteralPath $tmp -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "gaffer-update-*" -or $_.Name -like "gaffer-runtime-*" }) { Fail "$label`: temp folders left in $tmp" } else { Pass "$label`: temp folders cleaned up" }
    if (Test-Path -LiteralPath $lockPath) { Fail "$label`: update lock left behind" } else { Pass "$label`: update lock released" }
}

$realTemp = $env:TEMP
$holdProc = $null
$gated = $null
try {
    # ---------- Case 1: runtime unchanged ----------
    $c1 = New-TestInstall "case1" $currentLine
    $fp = Get-RuntimeFingerprint $c1
    $users = Get-UserHashes $c1
    Set-FetchEnv $unreachable $goodPins
    $code = Invoke-Update $c1 $asset
    $log = Read-Log
    if ($code -eq 0) { Pass "1: update.ps1 exited 0" } else { Fail "1: update.ps1 exited $code (log: $logPath)" }
    $last = Get-LastLogLine
    if ($last -eq $wantOk) { Pass "1: log ends with $wantOk" } else { Fail "1: last log line: $last" }
    if ($log -match "(?m)^runtime:current\s*$") { Pass "1: fetch-runtime.ps1 reported runtime:current" } else { Fail "1: no runtime:current line in the log" }
    if ($log -notmatch "runtime: downloading") { Pass "1: no runtime download was attempted" } else { Fail "1: a runtime download was attempted" }
    if ((Get-RuntimeFingerprint $c1) -eq $fp) { Pass "1: runtime\node.exe hash, size, mtime and both stamps unchanged (survived robocopy /PURGE)" } else { Fail "1: runtime changed: $(Get-RuntimeFingerprint $c1)" }
    if (Test-Path -LiteralPath (Join-Path $c1 "daemon\node_modules")) { Fail "1: old daemon\node_modules still there" } else { Pass "1: old daemon\node_modules removed by the sync" }
    if (-not $assetHasLock) {
        if (Test-Path -LiteralPath (Join-Path $c1 "daemon\package-lock.json")) { Fail "1: old daemon\package-lock.json still there" } else { Pass "1: old daemon\package-lock.json removed by the sync" }
    }
    if ($log -notmatch "Installing daemon dependencies") { Pass "1: no dependency install step" } else { Fail "1: the npm step still runs" }
    if ((Get-Sha (Join-Path $c1 "version.json")) -eq (Get-Sha (Join-Path $expected "version.json"))) { Pass "1: version.json is the release's" } else { Fail "1: version.json is not the release's" }
    if ((Get-Sha (Join-Path $c1 "daemon\daemon.mjs")) -eq (Get-Sha (Join-Path $expected "daemon\daemon.mjs"))) { Pass "1: daemon.mjs replaced" } else { Fail "1: daemon.mjs not replaced" }
    Test-UserData $c1 $users "1"
    Test-Clean $c1 "1"

    # ---------- Case 2: runtime changed ----------
    $c2 = New-TestInstall "case2" "v0.0.1 $plat"
    $users = Get-UserHashes $c2
    Set-FetchEnv $goodBase $goodPins
    $code = Invoke-Update $c2 $asset
    $log = Read-Log
    if ($code -eq 0) { Pass "2: update.ps1 exited 0" } else { Fail "2: update.ps1 exited $code (log: $logPath)" }
    $last = Get-LastLogLine
    if ($last -eq $wantOk) { Pass "2: log ends with $wantOk" } else { Fail "2: last log line: $last" }
    $iStaged = $log.IndexOf("runtime:installed $currentLine")
    $iStop = $log.IndexOf("Stopping daemon...")
    $iSwap = $log.IndexOf("Swapping in the new runtime...")
    $iSync = $log.IndexOf("Replacing files...")
    if ($iStaged -ge 0 -and $iStaged -lt $iStop -and $iStop -lt $iSwap -and $iSwap -lt $iSync) { Pass "2: order in the log: staged, daemon stopped, swap, sync" } else { Fail "2: log order staged=$iStaged stop=$iStop swap=$iSwap sync=$iSync" }
    $rt2 = Join-Path $c2 "daemon\runtime"
    if ((Test-Path -LiteralPath (Join-Path $rt2 "node.exe")) -and (Get-Sha (Join-Path $rt2 "node.exe")) -eq $binSha) { Pass "2: runtime\node.exe is the pinned binary" } else { Fail "2: runtime\node.exe missing or wrong" }
    if ([System.IO.File]::ReadAllText((Join-Path $rt2 "VERSION")) -eq "$currentLine`n") { Pass "2: runtime\VERSION names $currentLine" } else { Fail "2: runtime\VERSION is '$([System.IO.File]::ReadAllText((Join-Path $rt2 'VERSION')))'" }
    if ([System.IO.File]::ReadAllText((Join-Path $rt2 "VERIFIED")) -eq "$binBytes $binSha`n") { Pass "2: runtime\VERIFIED is '<size> <sha256>'" } else { Fail "2: runtime\VERIFIED is wrong" }
    if (Test-Path -LiteralPath (Join-Path $c2 "daemon\node_modules")) { Fail "2: old daemon\node_modules still there" } else { Pass "2: old daemon\node_modules removed" }
    Test-UserData $c2 $users "2"
    Test-Clean $c2 "2"

    # ---------- Case 2b: runtime changed while a node.exe runs from the old runtime ----------
    $c2b = New-TestInstall "case2b" "v0.0.1 $plat"
    $oldExe = Join-Path $c2b "daemon\runtime\node.exe"
    # No space in the -e argument: Start-Process joins arguments unquoted.
    $holdProc = Start-Process -FilePath $oldExe -ArgumentList @("-e", "setTimeout(function(){},600000)") -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    if (-not $holdProc.HasExited) { Pass "2b: a node.exe is running from the old runtime (pid $($holdProc.Id))" } else { Fail "2b: the stand-in node.exe exited at once" }
    Set-FetchEnv $goodBase $goodPins
    $code = Invoke-Update $c2b $asset
    $log = Read-Log
    if ($code -eq 0 -and (Get-LastLogLine) -eq $wantOk) { Pass "2b: the swap succeeded next to a running node.exe, $wantOk" } else { Fail "2b: exit $code, last line $(Get-LastLogLine) (log: $logPath)" }
    if ((Get-Sha (Join-Path $c2b "daemon\runtime\node.exe")) -eq $binSha -and [System.IO.File]::ReadAllText((Join-Path $c2b "daemon\runtime\VERSION")) -eq "$currentLine`n") { Pass "2b: the new runtime is in place" } else { Fail "2b: the new runtime is not in place" }
    if (-not $holdProc.HasExited) { Pass "2b: the running node.exe was not stopped by the update" } else { Fail "2b: the running node.exe was stopped" }
    if (Test-Path -LiteralPath (Join-Path $c2b "daemon\runtime.old\node.exe")) { Pass "2b: the locked runtime.old was left in place and survived robocopy /PURGE" } else { Fail "2b: runtime.old\node.exe is gone (was the process really running from it?)" }
    if ($log -match "runtime\.old is still in use, it will be removed by the next update") { Pass "2b: the locked runtime.old is logged" } else { Fail "2b: no 'still in use' line in the log" }
    Stop-Process -Id $holdProc.Id -Force -ErrorAction SilentlyContinue
    $holdProc.WaitForExit(10000) | Out-Null
    $holdProc = $null
    Start-Sleep -Milliseconds 500
    $fp = Get-RuntimeFingerprint $c2b
    Set-FetchEnv $unreachable $goodPins
    $code = Invoke-Update $c2b $asset
    if ($code -eq 0 -and (Get-LastLogLine) -eq $wantOk) { Pass "2b: the next update (runtime current) ends $wantOk" } else { Fail "2b: next update exit $code, last line $(Get-LastLogLine)" }
    if (Test-Path -LiteralPath (Join-Path $c2b "daemon\runtime.old")) { Fail "2b: runtime.old still there after the next update" } else { Pass "2b: the next update removed the leftover runtime.old" }
    if ((Get-RuntimeFingerprint $c2b) -eq $fp) { Pass "2b: the runtime was not touched by the next update" } else { Fail "2b: the runtime changed in the next update" }

    # ---------- Case 3: stage failure leaves the install untouched ----------
    $c3 = New-TestInstall "case3" "v0.0.1 $plat"
    $before = Get-TreeHash $c3
    Set-FetchEnv $goodBase $badPins
    $code = Invoke-Update $c3 $asset
    $log = Read-Log
    if ($code -eq 1) { Pass "3: update.ps1 exited 1" } else { Fail "3: update.ps1 exited $code, expected 1" }
    $last = Get-LastLogLine
    if ($last -eq "err:runtime") { Pass "3: log ends with err:runtime" } else { Fail "3: last log line: $last" }
    if ($log -match "ERROR: runtime staging failed: could not download the Node runtime from nodejs\.org or the Gaffer mirror") { Pass "3: the ERROR line carries fetch-runtime.ps1's own reason" } else { Fail "3: no ERROR line with the staging reason" }
    if ($log -match "official download failed, using the mirror") { Pass "3: the mirror was tried after the official source" } else { Fail "3: no mirror attempt in the log" }
    if ($log -notmatch "Stopping daemon\.\.\.") { Pass "3: the daemon was never stopped" } else { Fail "3: the daemon was stopped before the failure" }
    if ((Get-TreeHash $c3) -eq $before) { Pass "3: the whole install is byte-identical (runtime and node_modules included)" } else { Fail "3: the install changed" }
    Test-Clean $c3 "3"

    # ---------- Case 3b: an archive without fetch-runtime.ps1 ----------
    $c3b = New-TestInstall "case3b" $currentLine
    $before = Get-TreeHash $c3b
    Set-FetchEnv $unreachable $goodPins
    $code = Invoke-Update $c3b $assetNoFetch
    if ($code -eq 1 -and (Get-LastLogLine) -eq "err:runtime") { Pass "3b: an archive without fetch-runtime.ps1 ends with err:runtime" } else { Fail "3b: exit $code, last line $(Get-LastLogLine)" }
    if ((Get-TreeHash $c3b) -eq $before) { Pass "3b: install untouched" } else { Fail "3b: the install changed" }

    # ---------- Case 4a: killed between the two renames, then recovered ----------
    $c4 = New-TestInstall "case4a" "v0.0.1 $plat"
    Set-FetchEnv $goodBase $goodPins
    $gate = Join-Path $scratch "swap-gate"
    Remove-Item -LiteralPath $gate, "$gate.ready" -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $env:GAFFER_UPDATE_ASSET = $asset
    $env:TEMP = $tmp
    $env:GAFFER_UPDATE_TEST_SWAP_GATE = $gate
    try {
        $gated = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + (Join-Path $c4 "daemon\update.ps1") + '"')) -WindowStyle Hidden -PassThru
    } finally { Remove-Item -LiteralPath "Env:\GAFFER_UPDATE_TEST_SWAP_GATE" -ErrorAction SilentlyContinue }
    $reached = $false
    for ($i = 0; $i -lt 1800; $i++) {
        if (Test-Path -LiteralPath "$gate.ready") { $reached = $true; break }
        if ($gated.HasExited) { break }
        Start-Sleep -Milliseconds 100
    }
    if ($reached) { Pass "4a: the updater reached the gate between the renames" } else { Fail "4a: the updater never reached the swap gate (log: $logPath)" }
    $gatedPid = $gated.Id
    Stop-Process -Id $gatedPid -Force -ErrorAction SilentlyContinue
    $gated.WaitForExit(10000) | Out-Null
    $gated = $null
    # A killed updater cannot clean its own temp folder; that is expected.
    Remove-Item -LiteralPath (Join-Path $tmp "gaffer-update-$gatedPid") -Recurse -Force -ErrorAction SilentlyContinue
    $rt4 = Join-Path $c4 "daemon\runtime"
    if (-not (Test-Path -LiteralPath $rt4) -and (Test-Path -LiteralPath (Join-Path $c4 "daemon\runtime.old\node.exe"))) { Pass "4a: killed state: runtime.old and no runtime" } else { Fail "4a: unexpected state after the kill (runtime present: $(Test-Path -LiteralPath $rt4))" }
    # The killed updater's lock (dead pid) is taken over by the next one.
    $code = Invoke-Update $c4 $asset
    $log = Read-Log
    if ($log -match "Restored daemon\\runtime from runtime\.old") { Pass "4a: the next update restored runtime.old first" } else { Fail "4a: no restore line in the log" }
    if ($code -eq 0 -and (Get-LastLogLine) -eq $wantOk) { Pass "4a: the next update ends $wantOk" } else { Fail "4a: exit $code, last line $(Get-LastLogLine) (log: $logPath)" }
    if ((Test-Path -LiteralPath (Join-Path $rt4 "node.exe")) -and [System.IO.File]::ReadAllText((Join-Path $rt4 "VERSION")) -eq "$currentLine`n") { Pass "4a: the new runtime is in place" } else { Fail "4a: the new runtime is not in place" }
    Test-Clean $c4 "4a"

    # ---------- Case 4b: a current runtime.old, unreachable sources ----------
    $c4b = New-TestInstall "case4b" $currentLine
    $fp = Get-RuntimeFingerprint $c4b
    [System.IO.Directory]::Move((Join-Path $c4b "daemon\runtime"), (Join-Path $c4b "daemon\runtime.old"))
    Set-FetchEnv $unreachable $goodPins
    $code = Invoke-Update $c4b $asset
    $log = Read-Log
    if ($log -match "Restored daemon\\runtime from runtime\.old") { Pass "4b: runtime.old restored" } else { Fail "4b: no restore line in the log" }
    if ($log -match "(?m)^runtime:current\s*$" -and $log -notmatch "runtime: downloading") { Pass "4b: the restored runtime is current, nothing downloaded" } else { Fail "4b: the restored runtime was not taken as current" }
    if ($code -eq 0 -and (Get-LastLogLine) -eq $wantOk) { Pass "4b: ends $wantOk" } else { Fail "4b: exit $code, last line $(Get-LastLogLine)" }
    if ((Get-RuntimeFingerprint $c4b) -eq $fp) { Pass "4b: the runtime is byte-identical to before the interrupted swap" } else { Fail "4b: the runtime differs" }
    Test-Clean $c4b "4b"

    # ---------- Case 4c: the restore of runtime.old fails ----------
    $c4c = New-TestInstall "case4c" $currentLine
    [System.IO.Directory]::Move((Join-Path $c4c "daemon\runtime"), (Join-Path $c4c "daemon\runtime.old"))
    $before = Get-TreeHash $c4c
    Set-FetchEnv $unreachable $goodPins
    # FileShare.Read without Delete: Windows refuses to rename a folder that
    # holds a file open like this (a running node.exe would not block it).
    $held = [System.IO.File]::Open((Join-Path $c4c "daemon\runtime.old\VERSION"), [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        $code = Invoke-Update $c4c $asset
    } finally { $held.Dispose() }
    $log = Read-Log
    if ($code -eq 1 -and (Get-LastLogLine) -eq "err:runtime-swap") { Pass "4c: a failed restore of runtime.old ends with err:runtime-swap, exit 1" } else { Fail "4c: exit $code, last line $(Get-LastLogLine) (log: $logPath; if the restore succeeded, the open file did not block the folder rename)" }
    if ($log -match "ERROR: could not restore daemon\\runtime from runtime\.old") { Pass "4c: the log names the failed restore" } else { Fail "4c: no 'could not restore' ERROR line in the log" }
    if ($log -notmatch "(?m)^Downloading ") { Pass "4c: nothing was downloaded" } else { Fail "4c: the updater went on to download after the failed restore" }
    if ((Get-TreeHash $c4c) -eq $before) { Pass "4c: install untouched (runtime.old still there, no runtime)" } else { Fail "4c: the install changed" }
    if (Get-ChildItem -LiteralPath $tmp -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "gaffer-update-*" }) { Fail "4c: temp folders left in $tmp" } else { Pass "4c: temp folders cleaned up" }
    if (Test-Path -LiteralPath $lockPath) { Fail "4c: update lock left behind" } else { Pass "4c: update lock released" }

    # ---------- Case 5a: repair re-provisions a current runtime at the same version ----------
    $c5 = New-TestInstall "case5a" $currentLine
    Copy-Item -LiteralPath (Join-Path $expected "version.json") -Destination (Join-Path $c5 "version.json") -Force
    $verBefore = Get-Sha (Join-Path $c5 "version.json")
    # A file only the OLD runtime folder has: gone once a fresh folder is swapped in.
    Write-Ascii (Join-Path $c5 "daemon\runtime\old-folder-marker.txt") "old`n"
    $users = Get-UserHashes $c5
    Set-FetchEnv $goodBase $goodPins
    $code = Invoke-Update $c5 $asset -Repair
    $log = Read-Log
    if ($code -eq 0 -and (Get-LastLogLine) -eq $wantOk) { Pass "5a: repair at the same version ends $wantOk" } else { Fail "5a: exit $code, last line $(Get-LastLogLine) (log: $logPath)" }
    if ($log -match "Repair mode: ") { Pass "5a: the log records repair mode" } else { Fail "5a: no 'Repair mode' line in the log" }
    if ($log -match "runtime: -Force: re-provisioning" -and $log -match "runtime:installed $([regex]::Escape($currentLine))") { Pass "5a: fetch-runtime.ps1 ran with -Force and staged the runtime" } else { Fail "5a: no -Force re-provisioning in the log" }
    if (-not (Test-Path -LiteralPath (Join-Path $c5 "daemon\runtime\old-folder-marker.txt")) -and (Get-Sha (Join-Path $c5 "daemon\runtime\node.exe")) -eq $binSha) { Pass "5a: a fresh runtime folder with the pinned node.exe is in place" } else { Fail "5a: the old runtime folder is still there" }
    if ((Get-Sha (Join-Path $c5 "version.json")) -eq $verBefore) { Pass "5a: version.json content unchanged (same release)" } else { Fail "5a: version.json changed" }
    Test-UserData $c5 $users "5a"
    Test-Clean $c5 "5a"

    # ---------- Case 5b: a damaged runtime at the same version, plain update ----------
    $c5b = New-TestInstall "case5b" $currentLine
    Copy-Item -LiteralPath (Join-Path $expected "version.json") -Destination (Join-Path $c5b "version.json") -Force
    Write-Ascii (Join-Path $c5b "daemon\runtime\node.exe") "truncated"
    Set-FetchEnv $goodBase $goodPins
    $code = Invoke-Update $c5b $asset
    if ($code -eq 0 -and (Get-LastLogLine) -eq $wantOk) { Pass "5b: plain update of a damaged runtime ends $wantOk" } else { Fail "5b: exit $code, last line $(Get-LastLogLine) (log: $logPath)" }
    if ((Get-Sha (Join-Path $c5b "daemon\runtime\node.exe")) -eq $binSha) { Pass "5b: the stamp check failed and the runtime was re-provisioned" } else { Fail "5b: runtime\node.exe is still damaged" }
    Test-Clean $c5b "5b"

    # ---------- Case 5c: a repair whose download fails ----------
    $c5c = New-TestInstall "case5c" $currentLine
    $before = Get-TreeHash $c5c
    Set-FetchEnv $unreachable $goodPins
    $code = Invoke-Update $c5c $asset -Repair
    $log = Read-Log
    if ($code -eq 1 -and (Get-LastLogLine) -eq "err:runtime") { Pass "5c: a failed repair download ends with err:runtime, exit 1" } else { Fail "5c: exit $code, last line $(Get-LastLogLine)" }
    if ($log -notmatch "Stopping daemon\.\.\.") { Pass "5c: the daemon was never stopped" } else { Fail "5c: the daemon was stopped before the failure" }
    if ((Get-TreeHash $c5c) -eq $before) { Pass "5c: install untouched" } else { Fail "5c: the install changed" }
    Test-Clean $c5c "5c"
} finally {
    if ($holdProc -and -not $holdProc.HasExited) { Stop-Process -Id $holdProc.Id -Force -ErrorAction SilentlyContinue }
    if ($gated -and -not $gated.HasExited) { Stop-Process -Id $gated.Id -Force -ErrorAction SilentlyContinue }
    $env:TEMP = $realTemp
    Remove-Item -LiteralPath "Env:\GAFFER_UPDATE_ASSET" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Env:\GAFFER_UPDATE_TEST_SWAP_GATE" -ErrorAction SilentlyContinue
    Clear-FetchEnv
    Start-Sleep -Milliseconds 500
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:fails -eq 0) { Write-Host "ALL PASS"; exit 0 } else { Write-Host "$($script:fails) FAILURE(S)"; exit 1 }
