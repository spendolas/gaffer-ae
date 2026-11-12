# test-8: the update.ps1 refusals, on real Windows PowerShell 5.1. Each case runs
# update.ps1 from a scratch install (the release zip expanded, a no-op
# stop-daemon.ps1) with GAFFER_UPDATE_ASSET pointing at a local copy of the
# zip, and checks that it ends with the right code AND leaves the install
# byte for byte as it was:
#   A  one hex digit of the published hash changed        -> err:verify
#   B  no SHA256SUMS.txt beside the asset                  -> err:verify
#   C  the same version again, a plain update              -> err:version
#   D  a zip with a ..\ entry (valid hash for that zip)    -> err:archive
# The scratch folder is removed at the end. Nothing here touches a real install
# or a running daemon. -ReleaseZip must sit beside the SHA256SUMS.txt that
# package-release.sh wrote (a zero-dependency build, like test-5 and test-6).
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\test-8-update-verify.ps1 -ReleaseZip <gaffer-update-win.zip>
param(
    [Parameter(Mandatory = $true)][string] $ReleaseZip
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Join-Path $env:TEMP ("gaffer-t8-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
if (Test-Path $root) { Remove-Item $root -Recurse -Force }
New-Item -ItemType Directory -Path $root | Out-Null
$zip = $ReleaseZip
$sumLine = (Get-Content (Join-Path (Split-Path -Parent $ReleaseZip) "SHA256SUMS.txt") | Where-Object { $_ -match "gaffer-update-win\.zip$" } | Select-Object -First 1)
$goodHash = ($sumLine -split "\s+")[0]
function New-Install([string] $name, [string] $version) {
    $dir = Join-Path $root "$name\Application Support\com.gaffer.panel"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Expand-Archive -Path $zip -DestinationPath $dir -Force
    Set-Content -LiteralPath (Join-Path $dir "daemon\stop-daemon.ps1") -Value 'function Stop-Daemon { param([int[]] $ProcIds = $null) }'
    $vj = Get-Content -LiteralPath (Join-Path $dir "version.json") -Raw | ConvertFrom-Json
    $script:releaseVersion = $vj.version
    if ($version) { $vj.version = $version; [IO.File]::WriteAllText((Join-Path $dir "version.json"), ($vj | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) }
    return $dir
}
function Snapshot([string] $dir) { (Get-ChildItem -LiteralPath $dir -Recurse -File | Sort-Object FullName | ForEach-Object { $_.FullName.Substring($dir.Length) + "|" + $_.Length + "|" + $_.LastWriteTimeUtc.Ticks }) -join "`n" }
function Run-Update([string] $dir, [string] $asset, [string[]] $extra) {
    $tmp = Join-Path (Split-Path -Parent $dir) "tmp"
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    Remove-Item (Join-Path $tmp "gaffer-update.log") -Force -ErrorAction SilentlyContinue
    $env:GAFFER_UPDATE_ASSET = $asset
    $env:TEMP = $tmp
    Remove-Item Env:\GAFFER_UPDATE_TEST_UNVERIFIED -ErrorAction SilentlyContinue
    $a = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $dir "daemon\update.ps1")) + $extra
    & powershell.exe @a | Out-Null
    $code = $LASTEXITCODE
    $last = (Get-Content (Join-Path $tmp "gaffer-update.log") | Where-Object { $_ -match "^(ok|err):" } | Select-Object -Last 1)
    return @($code, $last)
}
function Check([string] $name, [string] $dir, [string] $asset, [string] $want, [string[]] $extra) {
    $before = Snapshot $dir
    $r = Run-Update $dir $asset $extra
    $after = Snapshot $dir
    $ok = ($r[0] -eq 1 -and $r[1] -eq $want)
    Write-Host ("{0}: {1} (exit {2}, last line '{3}', want '{4}')" -f ($(if ($ok) { "PASS" } else { "FAIL" })), $name, $r[0], $r[1], $want)
    if ($before -eq $after) { Write-Host "PASS: $name`: install untouched" } else { Write-Host "FAIL: $name`: install CHANGED" }
}
# --- A: one hex digit of the published hash changed
$a = Join-Path $root "A-assets"; New-Item -ItemType Directory -Path $a | Out-Null
Copy-Item $zip (Join-Path $a "gaffer-update-win.zip")
$flipped = ($(if ($goodHash[0] -eq "0") { "1" } else { "0" })) + $goodHash.Substring(1)
Set-Content -LiteralPath (Join-Path $a "SHA256SUMS.txt") -Value "$flipped  gaffer-update-win.zip" -Encoding ASCII
Check "A: changed digit in SHA256SUMS.txt" (New-Install "A" "0.12.1") (Join-Path $a "gaffer-update-win.zip") "err:verify"
# --- B: no sums file at all (no test switch)
$b = Join-Path $root "B-assets"; New-Item -ItemType Directory -Path $b | Out-Null
Copy-Item $zip (Join-Path $b "gaffer-update-win.zip")
Check "B: SHA256SUMS.txt missing" (New-Install "B" "0.12.1") (Join-Path $b "gaffer-update-win.zip") "err:verify"
# --- C: same version again, valid sums
$c = Join-Path $root "C-assets"; New-Item -ItemType Directory -Path $c | Out-Null
Copy-Item $zip (Join-Path $c "gaffer-update-win.zip")
Set-Content -LiteralPath (Join-Path $c "SHA256SUMS.txt") -Value "$goodHash  gaffer-update-win.zip" -Encoding ASCII
$instC = New-Install "C" $null
Check "C: same version, plain update" $instC (Join-Path $c "gaffer-update-win.zip") "err:version"
# --- D: archive with a .. entry, valid sums for that archive
$d = Join-Path $root "D-assets"; New-Item -ItemType Directory -Path $d | Out-Null
$dz = Join-Path $d "gaffer-update-win.zip"
Copy-Item $zip $dz
Add-Type -AssemblyName System.IO.Compression
$fs = [IO.File]::Open($dz, "Open", "ReadWrite")
$za = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Update)
$e = $za.CreateEntry("../evil.txt"); $sw = New-Object IO.StreamWriter($e.Open()); $sw.Write("x"); $sw.Dispose(); $za.Dispose(); $fs.Dispose()
$dh = (Get-FileHash -Algorithm SHA256 $dz).Hash.ToLower()
Set-Content -LiteralPath (Join-Path $d "SHA256SUMS.txt") -Value "$dh  gaffer-update-win.zip" -Encoding ASCII
Check "D: archive with a ..\ entry" (New-Install "D" "0.12.1") $dz "err:archive"
if (Test-Path (Join-Path $root "D\Application Support\evil.txt")) { Write-Host "FAIL: D: evil.txt was written outside the install" } else { Write-Host "PASS: D: nothing written outside the install" }

Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
