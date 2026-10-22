# test-7-install-win.ps1
# ======================================================================
# End-to-end test for scripts\install-win.ps1 (the developer installer,
# zero-dependency install spec section 9) against scratch folders only.
# Windows only, Windows PowerShell 5.1 (the gaffer-winvm test VM).
#
# install-win.ps1 runs with every side-effect switch set:
#   -ExtensionsDir <scratch>  -NoSymlink  -NoStopDaemon  -NoRegistry  -NoMcp
# and with TEMP/TMP pointed at the scratch folder, so it must not touch the
# real CEP extensions folder, the registry, ~/.claude.json, a running daemon
# or the real %TEMP%.
#
# REAL DOWNLOAD: the copy installs fetch the pinned Node runtime through
# daemon\fetch-runtime.ps1 from nodejs.org (or Gaffer's mirror), about 38 MB
# per case, two cases. The VM needs internet access.
#
# Cases:
#   A  packaged release layout: <scratch>\pkg\panel is -ReleaseZip extracted,
#      <scratch>\pkg\scripts\install-win.ps1 is the installer under test. A
#      chat-history-26.0.json is planted in the target first.
#      Expect: exit 0; version.json, CSXS\manifest.xml, daemon\daemon.mjs in
#      the install; daemon\runtime\node.exe with the pinned size, Authenticode
#      Valid (OpenJS Foundation), --version = pinned version; runtime\VERSION =
#      "<version> win-x64"; runtime\VERIFIED present; no runtime.new,
#      runtime.old or node_modules; the chat history file preserved.
#   B  checkout layout: <scratch>\co\panel is a copy of -RepoDir\panel (no
#      node_modules) plus daemon\daemon.mjs from the release (as if
#      scripts/build.sh had run), with planted items the copy must exclude:
#      node_modules, daemon\node_modules, daemon\dist, .remember,
#      daemon\runtime (a fake node.exe), daemon\runtime.new,
#      daemon\runtime.old, daemon\package-lock.json, .debug.
#      Expect: exit 0; none of the planted items in the install; the
#      runtime is the real pinned node.exe (not the fake); checkout sources
#      such as daemon\mcp-server.js present.
#   Outside the scratch folder, before vs after both cases:
#      HKCU\Software\Adobe\CSXS.11/12/13 PlayerDebugMode unchanged;
#      %USERPROFILE%\.claude.json unchanged (hash, or still absent);
#      %APPDATA%\Gaffer\config.json unchanged; the real
#      %APPDATA%\Adobe\CEP\extensions\com.gaffer.panel unchanged (or still
#      absent); whatever listened on port 9823 still listens with the same
#      PID; node.exe processes that existed before still exist; no new
#      gaffer-* entries in the real %TEMP%; npm profile folders
#      (%APPDATA%\npm, %LOCALAPPDATA%\npm-cache, %USERPROFILE%\.npmrc)
#      unchanged.
#
# Inputs:
#   -ReleaseZip  gaffer-install-win.zip from scripts/package-release.sh or a
#                release dry run (zero-dependency layout: daemon\daemon.mjs,
#                daemon\fetch-runtime.ps1, daemon\runtime-pins.json inside)
#   -RepoDir     the checkout holding scripts\install-win.ps1 and panel\
#                (default: two folders up from this script)
#   -Keep        keep the scratch folder for inspection
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\test-7-install-win.ps1 -ReleaseZip <zip> [-RepoDir <checkout>] [-Keep]
#
# Expected output: one "PASS: ..." line per check, no "FAIL:" line, and the
# last line "ALL PASS" (exit 0). Any failure prints "FAIL: ..." and ends
# with "<n> FAILURE(S)" (exit 1). Setup problems print "ABORT: ..." (exit 2).
#
# Keep this file ASCII-only with a UTF-8 BOM (node scripts/check-ps-encoding.mjs).
param(
    [Parameter(Mandatory = $true)][string] $ReleaseZip,
    [string] $RepoDir = "",
    [switch] $Keep
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:fails = 0
function Pass([string] $m) { Write-Host "PASS: $m" }
function Fail([string] $m) { Write-Host "FAIL: $m"; $script:fails++ }
function Check([bool] $ok, [string] $m) { if ($ok) { Pass $m } else { Fail $m } }

Write-Host "PowerShell $($PSVersionTable.PSVersion)"
if (-not $RepoDir) { $RepoDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath) }
$RepoDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RepoDir)
$installer = Join-Path $RepoDir "scripts\install-win.ps1"
foreach ($f in @($installer, (Join-Path $RepoDir "panel\main.js"))) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Write-Host "ABORT: $f not found (pass -RepoDir <checkout>)"; exit 2 }
}
if (-not (Select-String -LiteralPath $installer -Pattern "NoRegistry" -SimpleMatch -Quiet)) {
    Write-Host "ABORT: $installer has no -NoRegistry switch (old installer); refusing to run it"
    exit 2
}
if (-not (Test-Path -LiteralPath $ReleaseZip -PathType Leaf)) { Write-Host "ABORT: release zip not found: $ReleaseZip"; exit 2 }
$ReleaseZip = (Resolve-Path -LiteralPath $ReleaseZip).Path

$tar = Join-Path $env:SystemRoot "System32\tar.exe"
$psExe = (Get-Process -Id $PID).Path
$accent = [string] [char] 0x00E9
$realTemp = $env:TEMP
$scratch = Join-Path $realTemp ("gaffer t7 " + $accent + " " + [guid]::NewGuid().ToString("N").Substring(0, 8))
$tmp = Join-Path $scratch "tmp"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Write-Host "Scratch: $scratch"

function Get-Sha([string] $path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Text([string] $path, [string] $text) { [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false))) }
function New-Plant([string] $path) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    Write-Text $path "planted"
}

# ---------- Snapshot of everything outside the scratch folder ----------
function Get-FileState([string] $path) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { return "file " + (Get-Sha $path) }
    if (Test-Path -LiteralPath $path -PathType Container) {
        $items = Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue
        $stamp = (Get-Item -LiteralPath $path -Force).LastWriteTimeUtc.Ticks
        return "dir " + $stamp + " " + (@($items).Count)
    }
    return "absent"
}
function Get-Snapshot {
    $s = [ordered] @{}
    foreach ($v in @("11", "12", "13")) {
        $key = "HKCU:\Software\Adobe\CSXS.$v"
        $val = "absent"
        if (Test-Path -LiteralPath $key) {
            $p = Get-ItemProperty -LiteralPath $key -Name PlayerDebugMode -ErrorAction SilentlyContinue
            if ($p) { $val = [string] $p.PlayerDebugMode }
        }
        $s["registry CSXS.$v PlayerDebugMode"] = $val
    }
    $s["~\.claude.json"] = Get-FileState (Join-Path $env:USERPROFILE ".claude.json")
    $s["Gaffer config.json"] = Get-FileState (Join-Path $env:APPDATA "Gaffer\config.json")
    $s["real extension folder"] = Get-FileState (Join-Path $env:APPDATA "Adobe\CEP\extensions\com.gaffer.panel")
    $s["%APPDATA%\npm"] = Get-FileState (Join-Path $env:APPDATA "npm")
    $s["%LOCALAPPDATA%\npm-cache"] = Get-FileState (Join-Path $env:LOCALAPPDATA "npm-cache")
    $s["~\.npmrc"] = Get-FileState (Join-Path $env:USERPROFILE ".npmrc")
    $listen = @(Get-NetTCPConnection -LocalPort 9823 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Sort-Object)
    $s["port 9823 listener"] = ($listen -join ",")
    $tempGaffer = @(Get-ChildItem -LiteralPath $realTemp -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "gaffer-*" } | Select-Object -ExpandProperty Name | Sort-Object)
    $s["real %TEMP% gaffer-* entries"] = ($tempGaffer -join "|")
    return $s
}
$before = Get-Snapshot
$nodePidsBefore = @(Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

# ---------- Fixtures ----------
$pkgPanel = Join-Path $scratch "pkg\panel"
New-Item -ItemType Directory -Path $pkgPanel, (Join-Path $scratch "pkg\scripts") -Force | Out-Null
& $tar -xf $ReleaseZip -C $pkgPanel
if ($LASTEXITCODE -ne 0) { Write-Host "ABORT: tar.exe could not extract $ReleaseZip"; exit 2 }
foreach ($f in @("version.json", "daemon\daemon.mjs", "daemon\fetch-runtime.ps1", "daemon\runtime-pins.json")) {
    if (-not (Test-Path -LiteralPath (Join-Path $pkgPanel $f) -PathType Leaf)) { Write-Host "ABORT: the release zip has no $f (not a zero-dependency package)"; exit 2 }
}
Copy-Item -LiteralPath $installer -Destination (Join-Path $scratch "pkg\scripts\install-win.ps1")
$pins = ([System.IO.File]::ReadAllText((Join-Path $pkgPanel "daemon\runtime-pins.json")) | ConvertFrom-Json).node
$pinVersion = [string] $pins.version
$pinBytes = [int64] $pins.platforms."win-x64".binaryBytes

$coRoot = Join-Path $scratch "co"
$coPanel = Join-Path $coRoot "panel"
New-Item -ItemType Directory -Path (Join-Path $coRoot "scripts") -Force | Out-Null
robocopy (Join-Path $RepoDir "panel") $coPanel /E /XD node_modules runtime runtime.new runtime.old dist .remember | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "ABORT: could not copy the checkout panel (robocopy $LASTEXITCODE)"; exit 2 }
Copy-Item -LiteralPath (Join-Path $pkgPanel "daemon\daemon.mjs") -Destination (Join-Path $coPanel "daemon\daemon.mjs") -Force
Copy-Item -LiteralPath $installer -Destination (Join-Path $coRoot "scripts\install-win.ps1")
$planted = @(
    "node_modules\x\index.js",
    "daemon\node_modules\x\index.js",
    "daemon\dist\stage\x.txt",
    ".remember\x.md",
    "daemon\runtime\node.exe",
    "daemon\runtime\VERSION",
    "daemon\runtime.new\node.exe",
    "daemon\runtime.old\node.exe",
    "daemon\package-lock.json",
    ".debug"
)
foreach ($p in $planted) { New-Plant (Join-Path $coPanel $p) }

# ---------- Runner ----------
function Invoke-Installer([string] $root, [string] $extDir) {
    $saved = @{ TEMP = $env:TEMP; TMP = $env:TMP }
    $env:TEMP = $tmp; $env:TMP = $tmp
    try {
        $out = & {
            $ErrorActionPreference = "Continue"
            & $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\install-win.ps1") -ExtensionsDir $extDir -NoSymlink -NoStopDaemon -NoRegistry -NoMcp 2>&1
        }
        $code = $LASTEXITCODE
    } finally {
        $env:TEMP = $saved.TEMP; $env:TMP = $saved.TMP
    }
    $log = Join-Path $scratch ("install-" + (Split-Path -Leaf $root) + ".log")
    ($out | ForEach-Object { [string] $_ }) -join "`r`n" | Set-Content -LiteralPath $log -Encoding Ascii
    Write-Host "  installer exit $code, log $log"
    return $code
}

function Test-Runtime([string] $label, [string] $inst) {
    $rt = Join-Path $inst "daemon\runtime"
    $exe = Join-Path $rt "node.exe"
    Check (Test-Path -LiteralPath $exe -PathType Leaf) "$label runtime\node.exe present"
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
        Check ((Get-Item -LiteralPath $exe).Length -eq $pinBytes) "$label runtime\node.exe has the pinned size $pinBytes"
        $sig = Get-AuthenticodeSignature -LiteralPath $exe
        Check ($sig.Status -eq "Valid" -and $sig.SignerCertificate.Subject -match "OpenJS Foundation") "$label runtime signature Valid, OpenJS Foundation"
        $v = (& $exe --version | Out-String).Trim()
        Check ($v -eq $pinVersion) "$label runtime --version is $pinVersion (got $v)"
    }
    $verFile = Join-Path $rt "VERSION"
    $ver = ""
    if (Test-Path -LiteralPath $verFile) { $ver = ([System.IO.File]::ReadAllText($verFile)).Trim() }
    Check ($ver -eq "$pinVersion win-x64") "$label runtime\VERSION is '$pinVersion win-x64' (got '$ver')"
    Check (Test-Path -LiteralPath (Join-Path $rt "VERIFIED") -PathType Leaf) "$label runtime\VERIFIED present"
    foreach ($d in @("daemon\runtime.new", "daemon\runtime.old", "daemon\node_modules")) {
        Check (-not (Test-Path -LiteralPath (Join-Path $inst $d))) "$label no $d"
    }
}

# ---------- Case A: packaged release layout ----------
Write-Host "== Case A: packaged release layout"
$extA = Join-Path $scratch "ext A"
$instA = Join-Path $extA "com.gaffer.panel"
New-Item -ItemType Directory -Path $instA -Force | Out-Null
Write-Text (Join-Path $instA "chat-history-26.0.json") '{"kept":true}'
$codeA = Invoke-Installer (Join-Path $scratch "pkg") $extA
Check ($codeA -eq 0) "A installer exit 0"
foreach ($f in @("version.json", "CSXS\manifest.xml", "daemon\daemon.mjs", "daemon\fetch-runtime.ps1")) {
    Check (Test-Path -LiteralPath (Join-Path $instA $f) -PathType Leaf) "A install has $f"
}
Check (-not ((Get-Item -LiteralPath $instA -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) "A install is a copy, not a link"
Test-Runtime "A" $instA
$hist = Join-Path $instA "chat-history-26.0.json"
Check ((Test-Path -LiteralPath $hist) -and ([System.IO.File]::ReadAllText($hist) -eq '{"kept":true}')) "A per-version chat history preserved"

# ---------- Case B: checkout layout ----------
Write-Host "== Case B: checkout layout"
$extB = Join-Path $scratch "ext B"
$instB = Join-Path $extB "com.gaffer.panel"
$codeB = Invoke-Installer $coRoot $extB
Check ($codeB -eq 0) "B installer exit 0"
foreach ($p in $planted) {
    if ($p -like "daemon\runtime\*") { continue }
    Check (-not (Test-Path -LiteralPath (Join-Path $instB $p))) "B copy excludes $p"
}
foreach ($d in @("node_modules", ".remember", "daemon\dist")) {
    Check (-not (Test-Path -LiteralPath (Join-Path $instB $d))) "B copy has no $d folder"
}
Check (Test-Path -LiteralPath (Join-Path $instB "daemon\mcp-server.js") -PathType Leaf) "B install carries checkout sources (daemon\mcp-server.js)"
$fakeRt = Join-Path $instB "daemon\runtime\node.exe"
Check (-not ((Test-Path -LiteralPath $fakeRt) -and ([System.IO.File]::ReadAllText($fakeRt) -eq "planted"))) "B runtime is not the checkout's planted node.exe"
Test-Runtime "B" $instB

# ---------- Nothing outside the scratch folder changed ----------
Write-Host "== Outside the scratch folder"
$after = Get-Snapshot
foreach ($k in $before.Keys) {
    Check ($before[$k] -eq $after[$k]) "unchanged: $k ($($before[$k]) -> $($after[$k]))"
}
$gone = @($nodePidsBefore | Where-Object { -not (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
Check ($gone.Count -eq 0) "no node.exe that ran before was stopped (gone: $($gone -join ','))"

if ($Keep) { Write-Host "Kept: $scratch" }
else { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }

if ($script:fails -eq 0) { Write-Host "ALL PASS"; exit 0 }
Write-Host "$($script:fails) FAILURE(S)"
exit 1
