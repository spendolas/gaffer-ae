# Gaffer runtime provisioning (Windows): downloads the official Node.js
# runtime pinned in runtime-pins.json, verifies it and installs it as
# <daemon-dir>\runtime\node.exe. Windows twin of fetch-runtime.sh, same
# contract (spec section 3 of the zero-dependency install design).
#
# Usage (Windows PowerShell 5.1 or later):
#   powershell -NoProfile -ExecutionPolicy Bypass -File fetch-runtime.ps1 [-Into <daemon-dir>] [-StageOnly]
#
#   -Into       the daemon folder to provision (default: this script's folder)
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
# the temp folder %TEMP%\gaffer-runtime-<guid>, which is always removed.
#
# Test seams, honoured only when GAFFER_FETCH_TEST=1 (same names as
# fetch-runtime.sh):
#   GAFFER_FETCH_BASE_OFFICIAL  replaces the official base URL (file:// or http allowed)
#   GAFFER_FETCH_BASE_MIRROR    replaces the mirror base URL
#   GAFFER_FETCH_PINS           replaces the pins file path
#   GAFFER_FETCH_SKIP_CODESIGN  1 skips the Authenticode check (test archives are unsigned)
#   GAFFER_FETCH_PLATFORM       forces the platform key
#   GAFFER_FETCH_NO_TAR         1 skips tar.exe and uses the .NET zip fallback (Windows only seam)
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

# Set once the swap has moved the old runtime aside, so a failure after that
# point puts it back.
$script:movedAside = $false

function Remove-Tree([string] $path) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Exit-Fail([string] $message) {
    Write-Step "ERROR: $message"
    Remove-Tree $tmpDir
    Remove-Tree $newDir
    if ($script:movedAside -and -not (Test-Path -LiteralPath $runtimeDir) -and (Test-Path -LiteralPath $oldDir)) {
        try { [System.IO.Directory]::Move($oldDir, $runtimeDir); Write-Step "restored the previous runtime" } catch {}
    }
    Write-Output "err:runtime"
    exit 1
}

function Get-Sha256([string] $path) {
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Runs a native program in $workDir with stderr folded into the log. Native
# stderr must not become a terminating error under $ErrorActionPreference =
# "Stop" on PS 5.1; the assignment below is local to this function. Returns
# the exit code.
#
# Why a working directory: curl.exe and tar.exe receive their arguments in
# the ANSI code page, so a path with characters outside it (an accented or
# non-Latin user name in %TEMP% or %APPDATA%) can arrive mangled. PowerShell
# starts native programs in the current location through the Unicode API,
# so the download is written by relative name inside the temp folder and
# tar extracts relative to runtime.new. If tar still cannot read the archive
# path, the .NET zip reader takes over.
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
    # runtime: put it back. Otherwise runtime.old is a leftover that was
    # locked last time (a node.exe still running from it): delete it now.
    if ((Test-Path -LiteralPath $oldDir) -and -not (Test-Path -LiteralPath $runtimeDir)) {
        try {
            [System.IO.Directory]::Move($oldDir, $runtimeDir)
            Write-Step "restored runtime from runtime.old (an earlier swap was interrupted)"
        } catch {
            Write-Step "could not restore runtime.old: $($_.Exception.Message)"
        }
    }
    if (Test-Path -LiteralPath $oldDir) {
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
    [void][System.IO.Directory]::CreateDirectory($tmpDir)
    $archivePath = Join-Path $tmpDir $archive

    $curl = Join-Path $env:SystemRoot "System32\curl.exe"
    if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) {
        $cmd = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { $curl = $cmd.Source } else { Exit-Fail "curl.exe not found (it ships with Windows 10 1803 and later)" }
    }
    $proto = "=https"
    if ($testMode) { $proto = "=https,http,file" }

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
        $curlArgs = @("--fail", "--silent", "--show-error", "--ssl-no-revoke", "--proto", $proto, "--location",
            "--connect-timeout", "20", "--max-time", "600", "--retry", "3", "--retry-delay", "2",
            "-o", $archive, $url)
        $code = Invoke-Native $tmpDir $curl $curlArgs
        if ($code -ne 0 -or -not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
            $lastProblem = "the $($src.name) download failed (curl exit $code)"
            Write-Step $lastProblem
            Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
            continue
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
            if ($tarOut -ne $newExe) { Move-Item -LiteralPath $tarOut -Destination $newExe -Force }
            $topDir = Join-Path $newDir (($member -split '/')[0])
            if ($topDir -ne $newExe) { Remove-Tree $topDir }
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
        Remove-Tree $tmpDir
        Write-Step "staged in $newDir"
        Write-Output "runtime:installed $version $platform"
        exit 0
    }

    # ---- 8. Swap -------------------------------------------------------
    if (Test-Path -LiteralPath $runtimeDir) {
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
    if (Test-Path -LiteralPath $oldDir) {
        Remove-Tree $oldDir
        if (Test-Path -LiteralPath $oldDir) { Write-Step "runtime.old is in use, it will be removed on the next run" }
    }

    # ---- 9. Clean up ---------------------------------------------------
    Remove-Tree $tmpDir
    Write-Step "installed in $runtimeDir"
    Write-Output "runtime:installed $version $platform"
    exit 0
} catch {
    Exit-Fail "unexpected failure: $($_.Exception.Message)"
}
