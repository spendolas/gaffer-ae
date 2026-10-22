# Gaffer runtime provisioning (Windows): downloads the official Node.js
# runtime pinned in runtime-pins.json, verifies it and installs it as
# <daemon-dir>\runtime\node.exe. Windows twin of fetch-runtime.sh, same
# contract (spec section 3 of the zero-dependency install design).
#
# Usage (Windows PowerShell 5.1 or later):
#   powershell -NoProfile -ExecutionPolicy Bypass -File fetch-runtime.ps1 [-Into <daemon-dir>] [-StageOnly]
#
#   -Into       the daemon folder to provision (default: this script's folder).
#               Through -File, do not end a quoted -Into with a backslash:
#               "C:\x\daemon\" reaches the script as C:\x\daemon" (the \"
#               escapes the quote). Write "C:\x\daemon" instead.
#   -StageOnly  steps 1 to 7 only: leave the verified runtime in
#               <daemon-dir>\runtime.new and stop (the updater swaps it in
#               after it has stopped the daemon)
#
# Last output line (the contract; progress lines "runtime: ..." come before):
#   runtime:current                         already installed, nothing done
#   runtime:installed <version> <platform>  installed (or staged, -StageOnly)
#   err:runtime                             failed after a "runtime: ERROR" line
# Exit codes: 0 for runtime:current and runtime:installed, 1 for err:runtime.
#
# Nothing is written outside -Into (runtime, runtime.new, runtime.old) and
# the temp folder %TEMP%\gaffer-runtime-<guid>. The whole run sits in one
# try/finally, which PowerShell also runs on exit, Ctrl+C and a stopped
# in-process caller: the temp folder is always removed, a runtime.new is
# kept only after a successful -StageOnly run, and a runtime moved aside by
# an interrupted swap is put back.
#
# Downloads: curl.exe first; when curl fails, the same URL again through
# .NET HttpWebRequest with the system proxy (WinINET settings, PAC) and the
# user's default network credentials, like update.ps1. Official source
# first, then the mirror, each verified against the pinned SHA-256.
#
# Download budget (a deliberate change from spec section 3 step 3, which says
# --max-time 600, same as fetch-runtime.sh): a 38 MB archive cannot finish in
# 600 s on a slow link, and curl retries a timed-out attempt, so 600 s capped
# attempts cost up to about 4 x 600 s per source without ever succeeding.
# Instead an attempt aborts only when it stalls (below 10 KB/s for 60 s:
# --speed-limit 10240 --speed-time 60), each attempt is capped at 1800 s, and
# --retry-max-time 1800 stops new retries after 30 minutes on one source.
# --connect-timeout 20 --retry 3 --retry-delay 2 are as in the spec. The
# system proxy path uses the same numbers (see Get-ViaSystemProxy).
#
# Stale temp sweep: a killed run cannot clean up and would leak up to 38 MB,
# so a run that downloads first removes %TEMP%\gaffer-runtime-<32 hex>
# folders older than 24 h (exact name pattern, folders only, errors ignored).
#
# Test seams, honoured only when GAFFER_FETCH_TEST=1 (same names as
# fetch-runtime.sh):
#   GAFFER_FETCH_BASE_OFFICIAL  replaces the official base URL (file:// or http allowed)
#   GAFFER_FETCH_BASE_MIRROR    replaces the mirror base URL
#   GAFFER_FETCH_PINS           replaces the pins file path
#   GAFFER_FETCH_SKIP_CODESIGN  1 skips the Authenticode check (test archives are unsigned)
#   GAFFER_FETCH_PLATFORM       forces the platform key
#   GAFFER_FETCH_NO_TAR         1 skips tar.exe and uses the .NET zip fallback (Windows only seam)
#   GAFFER_FETCH_SPEED_TIME     seconds below 10 KB/s before an attempt aborts (digits only)
#   GAFFER_FETCH_MAX_TIME       per-attempt and per-source retry budget, seconds (digits only)
#   GAFFER_FETCH_NO_CURL        1 treats every curl.exe attempt as failed, so the system proxy
#                               path runs (file:// sources work there through FileWebRequest;
#                               Windows only seam)
#
# Keep this file ASCII-only with a UTF-8 BOM (node scripts/check-ps-encoding.mjs).

param(
    [string] $Into = "",
    [switch] $StageOnly
)

$ErrorActionPreference = "Stop"
# No PowerShell web cmdlet is used (downloads go through curl.exe), but the
# progress bar stalls PS 5.1 if anything ever draws one.
$ProgressPreference = "SilentlyContinue"

function Write-Step([string] $text) { Write-Host "runtime: $text" }

$testMode = ($env:GAFFER_FETCH_TEST -eq "1")
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

if (-not $Into) { $Into = $scriptDir }
$Into = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Into)
$Into = $Into.TrimEnd('\', '/')

$runtimeDir = Join-Path $Into "runtime"
$newDir = Join-Path $Into "runtime.new"
$oldDir = Join-Path $Into "runtime.old"

$tempRoot = $env:TEMP
if (-not $tempRoot -or -not (Test-Path -LiteralPath $tempRoot -PathType Container)) { $tempRoot = [System.IO.Path]::GetTempPath() }
$tmpDir = Join-Path $tempRoot ("gaffer-runtime-" + [guid]::NewGuid().ToString("N"))

# Set once the swap has moved the old runtime aside, so a failure or an
# interruption after that point puts it back (in the finally block).
$script:movedAside = $false
# Set when runtime.new must survive the run: after a successful -StageOnly
# (the updater swaps it in) and after a successful swap (it no longer exists).
$script:keepNew = $false

function Remove-Tree([string] $path) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Cleanup (temp folder, runtime.new, putting a moved-aside runtime back) is
# done by the finally block around the whole run, which also runs on exit.
function Exit-Fail([string] $message) {
    Write-Step "ERROR: $message"
    # Put a moved-aside runtime back here so the log says so before the
    # last line; the finally block repeats this silently for interruptions.
    if ($script:movedAside -and -not (Test-Path -LiteralPath $runtimeDir) -and (Test-Path -LiteralPath $oldDir)) {
        try { [System.IO.Directory]::Move($oldDir, $runtimeDir); $script:movedAside = $false; Write-Step "restored the previous runtime" } catch {}
    }
    Write-Output "err:runtime"
    exit 1
}

# Reads the size field of a VERIFIED stamp ("<size> <sha256>"); "" if absent.
function Get-StampSize([string] $dir) {
    $stamp = Join-Path $dir "VERIFIED"
    if (-not (Test-Path -LiteralPath $stamp -PathType Leaf)) { return "" }
    $fields = ([System.IO.File]::ReadAllText($stamp)).Trim() -split '\s+'
    return [string] $fields[0]
}

function Get-Sha256([string] $path) {
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Runs a native program in $workDir with stderr folded into the log. Native
# stderr must not become a terminating error under $ErrorActionPreference =
# "Stop" on PS 5.1; the assignment below is local to this function. Returns
# the exit code.
#
# Why a working directory: curl.exe and tar.exe may receive their arguments
# in the ANSI code page, so a path with characters outside it (an accented
# or non-Latin user name in %TEMP% or %APPDATA%) can arrive mangled.
# PowerShell starts native programs in the current location through the
# Unicode API, so curl writes the download by relative name inside the temp
# folder and tar extracts relative to runtime.new. tar still receives the
# archive's absolute path; if that arrives mangled, tar fails and the .NET
# zip reader takes over.
function Invoke-Native([string] $workDir, [string] $exe, [string[]] $arguments) {
    $ErrorActionPreference = "Continue"
    Push-Location -LiteralPath $workDir -ErrorAction Stop
    try {
        & $exe @arguments 2>&1 | ForEach-Object { Write-Host ("runtime:   " + $_.ToString()) }
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    return $exitCode
}

# The system proxy path, used when curl.exe fails (mirrors
# Get-ReleaseAssetViaSystemProxy in update.ps1): TLS 1.2, the WinINET proxy
# (Internet Options, PAC) with the user's default network credentials, 20 s
# to connect and get headers like curl's --connect-timeout. Stall abort like
# curl's --speed-limit 10240 --speed-time <speedTime>: one read blocking for
# <speedTime> s fails (ReadWriteTimeout), and so does a trickle that brings
# under 10 KB/s over any <speedTime> s window. <maxTime> s in total for all
# attempts together (a read is only started while <speedTime> s of the
# budget remain). Up to 4 attempts (curl's first plus --retry 3), 2 s apart,
# while within the budget; a 4xx answer is final. Outside test mode only
# https is accepted, also after redirects. Returns "" on success, else the
# reason.
function Get-ViaSystemProxy([string] $uri, [string] $outFile, [bool] $allowAnyScheme, [int] $speedTime, [int] $maxTime) {
    if (-not $allowAnyScheme -and -not $uri.StartsWith("https://")) { return "refusing a non-https URL" }
    try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12 } catch {}
    try { [System.Net.WebRequest]::DefaultWebProxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials } catch {}
    $started = Get-Date
    $attempt = 0
    while ($true) {
        $attempt++
        $reason = ""
        $final = $false
        try {
            $req = [System.Net.WebRequest]::Create($uri)
            $req.Timeout = 20000
            # file:// gives a FileWebRequest (test mode), which has none of these.
            if ($req -is [System.Net.HttpWebRequest]) {
                $req.ReadWriteTimeout = $speedTime * 1000
                $req.AllowAutoRedirect = $true
                $req.UserAgent = "gaffer-fetch-runtime"
            }
            $resp = $req.GetResponse()
            try {
                if (-not $allowAnyScheme -and $resp.ResponseUri.Scheme -ne "https") { throw "redirected to a non-https URL" }
                $in = $resp.GetResponseStream()
                $out = [System.IO.File]::Create($outFile)
                try {
                    $buf = New-Object byte[] 65536
                    $windowStart = Get-Date
                    $windowBytes = 0
                    while ($true) {
                        if (((Get-Date) - $started).TotalSeconds -gt ($maxTime - $speedTime)) { throw "download exceeded its $maxTime s budget" }
                        $n = $in.Read($buf, 0, $buf.Length)
                        if ($n -le 0) { break }
                        $out.Write($buf, 0, $n)
                        $windowBytes += $n
                        $windowSeconds = ((Get-Date) - $windowStart).TotalSeconds
                        if ($windowSeconds -ge $speedTime) {
                            if ($windowBytes -lt (10240 * $windowSeconds)) { throw "download stalled (under 10 KB/s for $speedTime s)" }
                            $windowStart = Get-Date
                            $windowBytes = 0
                        }
                    }
                } finally {
                    $out.Dispose()
                    $in.Dispose()
                }
            } finally { $resp.Close() }
            return ""
        } catch {
            Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
            # A .NET method's WebException arrives wrapped in a
            # MethodInvocationException; look at both levels for the status.
            $status = 0
            try { $status = [int] $_.Exception.Response.StatusCode } catch {}
            if ($status -eq 0) { try { $status = [int] $_.Exception.InnerException.Response.StatusCode } catch {} }
            $reason = $_.Exception.Message
            if ($_.Exception.InnerException) { $reason = $_.Exception.InnerException.Message }
            if ($status -ge 400 -and $status -lt 500) { $final = $true; $reason = "the server answered $status" }
        }
        $elapsed = ((Get-Date) - $started).TotalSeconds
        if ($final -or $attempt -ge 4 -or ($elapsed + 2) -ge $maxTime) { return "system proxy download failed: $reason" }
        Write-Step "system proxy attempt $attempt failed ($reason), retrying"
        Start-Sleep -Seconds 2
    }
}

try {
    if (-not (Test-Path -LiteralPath $Into -PathType Container)) { Exit-Fail "daemon folder not found: $Into" }

    # ---- Pins ----------------------------------------------------------
    $pinsPath = Join-Path $scriptDir "runtime-pins.json"
    if ($testMode -and $env:GAFFER_FETCH_PINS) { $pinsPath = $env:GAFFER_FETCH_PINS }
    if (-not (Test-Path -LiteralPath $pinsPath -PathType Leaf)) { Exit-Fail "pins file not found: $pinsPath" }
    $pins = ([System.IO.File]::ReadAllText($pinsPath) | ConvertFrom-Json).node
    $version = [string] $pins.version
    $official = [string] $pins.official
    $mirror = [string] $pins.mirror
    $signer = [string] $pins.signing.windowsSigner

    # ---- 1. Platform ---------------------------------------------------
    # Windows ARM runs the x64 build under emulation (decision D5).
    $platform = "win-x64"
    if ($testMode -and $env:GAFFER_FETCH_PLATFORM) { $platform = $env:GAFFER_FETCH_PLATFORM }
    $entryProp = $pins.platforms.PSObject.Properties[$platform]
    if (-not $entryProp) { Exit-Fail "no pinned runtime for platform $platform" }
    $entry = $entryProp.Value
    $archive = [string] $entry.archive
    $archiveSha = ([string] $entry.archiveSha256).ToLowerInvariant()
    $member = [string] $entry.member
    $binaryBytes = [int64] $entry.binaryBytes
    $binarySha = ([string] $entry.binarySha256).ToLowerInvariant()
    if (-not $archive -or -not $archiveSha -or -not $member -or $binaryBytes -le 0 -or -not $binarySha -or -not $version -or -not $signer) {
        Exit-Fail "pins file is incomplete for $platform"
    }
    if ($archive -match '[\\/]|\.\.') { Exit-Fail "bad archive name in pins" }
    if ($member -match '\\|\.\.|^/|:' -or $member -notmatch '^[^/]+/[^/]+\.exe$') { Exit-Fail "bad member path in pins" }
    $binaryName = Split-Path -Leaf ($member -replace '/', '\')
    $expectedVersionLine = "$version $platform"

    if ($testMode) {
        if ($env:GAFFER_FETCH_BASE_OFFICIAL) { $official = $env:GAFFER_FETCH_BASE_OFFICIAL }
        if ($env:GAFFER_FETCH_BASE_MIRROR) { $mirror = $env:GAFFER_FETCH_BASE_MIRROR }
    }
    if (-not $official.EndsWith("/")) { $official = $official + "/" }
    if (-not $mirror.EndsWith("/")) { $mirror = $mirror + "/" }

    # ---- Leftovers from an earlier run ----------------------------------
    # An updater killed between the two renames leaves runtime.old and no
    # runtime: put it back, but only when its binary still matches its own
    # VERIFIED size (spec 6.8). runtime.old is deleted only while a runtime
    # exists: then it is a leftover that was locked last time (a node.exe
    # still running from it). Without a runtime it is never deleted.
    if ((Test-Path -LiteralPath $oldDir) -and -not (Test-Path -LiteralPath $runtimeDir)) {
        $oldExe = Join-Path $oldDir $binaryName
        $oldStamp = Get-StampSize $oldDir
        $oldOk = $false
        if ($oldStamp -and (Test-Path -LiteralPath $oldExe -PathType Leaf)) {
            $oldOk = ([string] (Get-Item -LiteralPath $oldExe).Length) -eq $oldStamp
        }
        if ($oldOk) {
            try {
                [System.IO.Directory]::Move($oldDir, $runtimeDir)
                Write-Step "restored runtime from runtime.old (an earlier swap was interrupted)"
            } catch {
                Write-Step "could not restore runtime.old, leaving it in place: $($_.Exception.Message)"
            }
        } else {
            Write-Step "runtime.old does not pass its size check, leaving it in place"
        }
    }
    if ((Test-Path -LiteralPath $oldDir) -and (Test-Path -LiteralPath $runtimeDir)) {
        Remove-Tree $oldDir
        if (Test-Path -LiteralPath $oldDir) { Write-Step "runtime.old is still in use, it will be removed on the next run" }
        else { Write-Step "removed a leftover runtime.old" }
    }
    Remove-Tree $newDir

    # ---- 2. Skip check -------------------------------------------------
    # VERSION is the only key for "download or not"; VERIFIED guards against
    # a truncated or replaced binary (size only, like the launcher).
    $curExe = Join-Path $runtimeDir $binaryName
    $curVersionFile = Join-Path $runtimeDir "VERSION"
    $curVerifiedFile = Join-Path $runtimeDir "VERIFIED"
    if ((Test-Path -LiteralPath $curExe -PathType Leaf) -and (Test-Path -LiteralPath $curVersionFile -PathType Leaf) -and (Test-Path -LiteralPath $curVerifiedFile -PathType Leaf)) {
        $curVersion = ([System.IO.File]::ReadAllText($curVersionFile)).Trim()
        $stampFields = ([System.IO.File]::ReadAllText($curVerifiedFile)).Trim() -split '\s+'
        $curSize = (Get-Item -LiteralPath $curExe).Length
        if ($curVersion -eq $expectedVersionLine -and $stampFields.Count -ge 1 -and $stampFields[0] -eq [string] $curSize) {
            Write-Step "$expectedVersionLine already installed"
            Write-Output "runtime:current"
            exit 0
        }
        Write-Step "installed runtime is '$curVersion' (size $curSize), want '$expectedVersionLine'"
    } elseif (Test-Path -LiteralPath $runtimeDir) {
        Write-Step "installed runtime is incomplete (missing $binaryName, VERSION or VERIFIED)"
    }

    # ---- 3. Download, 4. verify the archive ----------------------------
    # Stale temp sweep (see header): exact name, folders only, over 24 h old.
    try {
        $cutoff = (Get-Date).ToUniversalTime().AddHours(-24)
        foreach ($stale in [System.IO.Directory]::GetDirectories($tempRoot, "gaffer-runtime-*")) {
            $staleName = [System.IO.Path]::GetFileName($stale)
            if ($staleName -cmatch '^gaffer-runtime-[0-9a-f]{32}$' -and [System.IO.Directory]::GetLastWriteTimeUtc($stale) -lt $cutoff) {
                Remove-Tree $stale
            }
        }
    } catch {}
    [void][System.IO.Directory]::CreateDirectory($tmpDir)
    $archivePath = Join-Path $tmpDir $archive

    $curl = Join-Path $env:SystemRoot "System32\curl.exe"
    if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) {
        $cmd = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { $curl = $cmd.Source } else { Exit-Fail "curl.exe not found (it ships with Windows 10 1803 and later)" }
    }
    $proto = "=https"
    if ($testMode) { $proto = "=https,http,file" }
    $skipCurl = ($testMode -and $env:GAFFER_FETCH_NO_CURL -eq "1")
    $speedTime = 60
    $maxTime = 1800
    if ($testMode -and $env:GAFFER_FETCH_SPEED_TIME -match '^[0-9]+$') { $speedTime = [int] $env:GAFFER_FETCH_SPEED_TIME }
    if ($testMode -and $env:GAFFER_FETCH_MAX_TIME -match '^[0-9]+$') { $maxTime = [int] $env:GAFFER_FETCH_MAX_TIME }

    # --ssl-no-revoke: same reasoning as update.ps1. The TLS chain is still
    # fully validated, only the OCSP/CRL lookup that inspecting proxies block
    # is skipped, and the archive is pinned by SHA-256 below in any case.
    $sources = @(@{ name = "official"; base = $official }, @{ name = "mirror"; base = $mirror })
    $gotArchive = $false
    $lastProblem = ""
    for ($i = 0; $i -lt $sources.Count; $i++) {
        $src = $sources[$i]
        if ($i -gt 0) { Write-Step "official download failed, using the mirror" }
        $url = $src.base + $archive
        Write-Step "downloading $url"
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
        $curlArgs = @("--fail", "--proto", $proto, "--location", "--connect-timeout", "20",
            "--speed-limit", "10240", "--speed-time", [string] $speedTime,
            "--max-time", [string] $maxTime, "--retry-max-time", [string] $maxTime,
            "--retry", "3", "--retry-delay", "2", "--silent", "--show-error", "--ssl-no-revoke",
            "-o", $archive, $url)
        $curlStarted = Get-Date
        if ($skipCurl) {
            $code = "skipped (test mode)"
        } else {
            $code = Invoke-Native $tmpDir $curl $curlArgs
        }
        if ($code -ne 0 -or -not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
            Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
            $curlSeconds = [int] ((Get-Date) - $curlStarted).TotalSeconds
            if ($curlSeconds -ge [Math]::Min(300, $maxTime)) {
                # curl got far enough to spend real time: the link is slow or
                # stalling, not blocked, and the proxy path would only double
                # the wait.
                $lastProblem = "the $($src.name) download failed (curl exit $code after $curlSeconds s)"
                Write-Step $lastProblem
                continue
            }
            Write-Step "curl.exe could not download it (exit $code), trying the system proxy path"
            $proxyProblem = Get-ViaSystemProxy $url $archivePath $testMode $speedTime $maxTime
            if ($proxyProblem -or -not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
                $lastProblem = "the $($src.name) download failed (curl exit $code; $proxyProblem)"
                Write-Step $lastProblem
                Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
                continue
            }
            Write-Step "downloaded through the system proxy path"
        }
        $gotSha = Get-Sha256 $archivePath
        if ($gotSha -ne $archiveSha) {
            $lastProblem = "the $($src.name) download did not match the expected checksum (got $gotSha, size $((Get-Item -LiteralPath $archivePath).Length))"
            Write-Step $lastProblem
            Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
            continue
        }
        Write-Step "archive checksum ok ($($src.name))"
        $gotArchive = $true
        break
    }
    if (-not $gotArchive) { Exit-Fail "could not download the Node runtime from nodejs.org or the Gaffer mirror: $lastProblem" }

    # ---- 5. Extract only the binary into runtime.new -------------------
    [void][System.IO.Directory]::CreateDirectory($newDir)
    $newExe = Join-Path $newDir $binaryName
    $extracted = $false
    $tar = Join-Path $env:SystemRoot "System32\tar.exe"
    $useTar = (Test-Path -LiteralPath $tar -PathType Leaf)
    if ($testMode -and $env:GAFFER_FETCH_NO_TAR -eq "1") { $useTar = $false }
    if ($useTar) {
        $code = Invoke-Native $newDir $tar @("-xf", $archivePath, $member)
        $tarOut = Join-Path $newDir ($member -replace '/', '\')
        if ($code -eq 0 -and (Test-Path -LiteralPath $tarOut -PathType Leaf)) {
            # The member is always <folder>/<name>.exe (checked above).
            [System.IO.File]::Move($tarOut, $newExe)
            Remove-Tree (Join-Path $newDir (($member -split '/')[0]))
            $extracted = $true
            Write-Step "extracted $member with tar.exe"
        } else {
            Write-Step "tar.exe could not extract $member (exit $code), using the .NET zip reader"
            Get-ChildItem -LiteralPath $newDir -Force | ForEach-Object { Remove-Tree $_.FullName }
        }
    }
    if (-not $extracted) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
        $hasEntry = $false
        try {
            $zipEntry = $zip.GetEntry($member)
            if ($zipEntry) {
                $hasEntry = $true
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($zipEntry, $newExe, $true)
            }
        } finally {
            # Dispose before any exit so the archive is not locked when the
            # temp folder is removed.
            $zip.Dispose()
        }
        if (-not $hasEntry) { Exit-Fail "the archive has no $member" }
        Write-Step "extracted $member with the .NET zip reader"
    }
    if (-not (Test-Path -LiteralPath $newExe -PathType Leaf)) { Exit-Fail "extraction produced no $binaryName" }

    # ---- 6. Verify the binary ------------------------------------------
    $newSize = (Get-Item -LiteralPath $newExe).Length
    if ($newSize -ne $binaryBytes) { Exit-Fail "$binaryName is $newSize bytes, expected $binaryBytes" }
    $newSha = Get-Sha256 $newExe
    # A value that is not 64 hex digits is the placeholder
    # (PENDING-FIRST-ACCEPTANCE-RUN): skip the hash, keep size and signature.
    if ($binarySha -notmatch '^[0-9a-f]{64}$') {
        Write-Step "binary SHA-256 not pinned yet ($($entry.binarySha256)), skipping the binary hash check (size and signature still checked); got $newSha"
    } elseif ($newSha -ne $binarySha) {
        Exit-Fail "$binaryName SHA-256 is $newSha, expected $binarySha"
    } else {
        Write-Step "binary size and SHA-256 ok"
    }
    if ($testMode -and $env:GAFFER_FETCH_SKIP_CODESIGN -eq "1") {
        Write-Step "signature check skipped (test mode)"
    } else {
        $sig = Get-AuthenticodeSignature -LiteralPath $newExe
        $subject = ""
        if ($sig.SignerCertificate) { $subject = [string] $sig.SignerCertificate.Subject }
        if ($sig.Status -ne "Valid" -or $subject.IndexOf($signer, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Exit-Fail "The Node runtime's signature could not be verified (status $($sig.Status), signer '$subject'). Nothing was installed."
        }
        Write-Step "Authenticode signature valid, signer $subject"
    }

    # ---- 7. Smoke run (also the Defender warm-up) ----------------------
    # The first run of a fresh node.exe is scanned by real-time protection
    # (about 5.6 s); later runs take about 85 ms. Variables that change how
    # Node starts are cleared for this run only, as the launcher does.
    $saved = @{}
    foreach ($name in @("NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS")) {
        $saved[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process")
        [System.Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $ErrorActionPreference = "Continue"
        $smokeOut = & $newExe --version 2>&1
        $smokeCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = "Stop"
        foreach ($name in $saved.Keys) { [System.Environment]::SetEnvironmentVariable($name, $saved[$name], "Process") }
    }
    $smoke = ((@($smokeOut) | ForEach-Object { [string] $_ }) -join " ").Trim()
    Write-Step "$binaryName --version printed '$smoke' (exit $smokeCode, $($watch.ElapsedMilliseconds) ms)"
    if ($smokeCode -ne 0 -or $smoke -ne $version) { Exit-Fail "smoke run failed: expected $version" }

    # Stamps travel with the staged folder, so a later swap (here or in the
    # updater) is two renames and never leaves an unstamped runtime.
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path $newDir "VERSION"), "$expectedVersionLine`n", $enc)
    [System.IO.File]::WriteAllText((Join-Path $newDir "VERIFIED"), "$newSize $newSha`n", $enc)

    if ($StageOnly) {
        $script:keepNew = $true
        Write-Step "staged in $newDir"
        Write-Output "runtime:installed $version $platform"
        exit 0
    }

    # ---- 8. Swap -------------------------------------------------------
    if (Test-Path -LiteralPath $runtimeDir) {
        # A runtime.old still here was locked at the start; one more try,
        # since the rename below needs the name.
        if (Test-Path -LiteralPath $oldDir) { Remove-Tree $oldDir }
        if (Test-Path -LiteralPath $oldDir) { Exit-Fail "runtime.old is still in use and blocks the swap; stop the daemon and try again" }
        try {
            [System.IO.Directory]::Move($runtimeDir, $oldDir)
            $script:movedAside = $true
        } catch {
            Exit-Fail "could not move the current runtime aside (is the daemon still running?): $($_.Exception.Message)"
        }
    }
    try {
        [System.IO.Directory]::Move($newDir, $runtimeDir)
    } catch {
        Exit-Fail "could not move runtime.new into place: $($_.Exception.Message)"
    }
    $script:movedAside = $false
    $script:keepNew = $true
    if (Test-Path -LiteralPath $oldDir) {
        Remove-Tree $oldDir
        if (Test-Path -LiteralPath $oldDir) { Write-Step "runtime.old is in use, it will be removed on the next run" }
    }

    # ---- 9. Clean up (temp folder: finally block) ---------------------
    Write-Step "installed in $runtimeDir"
    Write-Output "runtime:installed $version $platform"
    exit 0
} catch {
    Exit-Fail "unexpected failure: $($_.Exception.Message)"
} finally {
    # Runs on success, on every Exit-Fail, on exit 0 and on Ctrl+C. Silent:
    # the contract line has already been printed.
    Remove-Tree $tmpDir
    if ($script:movedAside -and -not (Test-Path -LiteralPath $runtimeDir) -and (Test-Path -LiteralPath $oldDir)) {
        try { [System.IO.Directory]::Move($oldDir, $runtimeDir) } catch {}
    }
    if (-not $script:keepNew) { Remove-Tree $newDir }
}
