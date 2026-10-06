# test-5-update-ps1.ps1
# ======================================================================
# End-to-end test for panel\daemon\update.ps1 against a scratch install,
# the Windows twin of scripts/test-update-sh.sh. Run it on a Windows box
# (the gaffer-winvm test VM) under Windows PowerShell 5.1.
#
# Lays down a v0.10.8 install (from -OldInstallZip) under a path WITH A
# SPACE, seeds user data, runs the update.ps1 from -UpdateScriptDir inside
# that install with GAFFER_UPDATE_ASSET pointing at -ReleaseZip, and checks
# the result. A second case feeds it a broken download and checks that
# nothing in the install changed.
#
# update.ps1 stops whatever listens on port 9823, so this refuses to run
# while a Gaffer daemon is up (close After Effects first).
#
# Inputs, built on the Mac (see the implementation plan):
#   -UpdateScriptDir  folder with the NEW update.ps1 and stop-daemon.ps1
#   -OldInstallZip    git archive --format=zip -o old-install.zip ce16c2f:panel
#   -ReleaseZip       gaffer-update-win.zip from scripts/package-release.sh
#   -NodeDir          optional folder holding node.exe / npm.cmd to put on PATH
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\test-5-update-ps1.ps1 -UpdateScriptDir <dir> -OldInstallZip <zip> -ReleaseZip <zip> [-NodeDir <dir>]
param(
    [Parameter(Mandatory = $true)][string] $UpdateScriptDir,
    [Parameter(Mandatory = $true)][string] $OldInstallZip,
    [Parameter(Mandatory = $true)][string] $ReleaseZip,
    [string] $NodeDir = ""
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:fails = 0
function Pass([string] $m) { Write-Host "PASS: $m" }
function Fail([string] $m) { Write-Host "FAIL: $m"; $script:fails++ }

Write-Host "PowerShell $($PSVersionTable.PSVersion)"
if (Get-NetTCPConnection -LocalPort 9823 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "ABORT: something is listening on port 9823 (a running Gaffer daemon). Close After Effects first."
    exit 2
}
if (-not (Select-String -Path (Join-Path $UpdateScriptDir "update.ps1") -Pattern "GAFFER_UPDATE_ASSET" -Quiet)) {
    Write-Host "FAIL: update.ps1 does not honor GAFFER_UPDATE_ASSET (still the main-archive updater)"
    exit 1
}
if ($NodeDir) { $env:Path = "$NodeDir;$env:Path" }

$scratch = Join-Path $env:TEMP ("gaffer-update-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path "$scratch\tmp" -Force | Out-Null
$expected = Join-Path $scratch "expected"
Expand-Archive -Path $ReleaseZip -DestinationPath $expected -Force

function New-TestInstall([string] $dir) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Expand-Archive -Path $OldInstallZip -DestinationPath $dir -Force
    Copy-Item (Join-Path $UpdateScriptDir "update.ps1") (Join-Path $dir "daemon\update.ps1") -Force
    Copy-Item (Join-Path $UpdateScriptDir "stop-daemon.ps1") (Join-Path $dir "daemon\stop-daemon.ps1") -Force
    Set-Content -LiteralPath (Join-Path $dir "chat-history.json") -Value '{"messages":["legacy"]}'
    Set-Content -LiteralPath (Join-Path $dir "chat-history-26.0.json") -Value '{"messages":["ae26"]}'
    Set-Content -LiteralPath (Join-Path $dir ".gaffer-config.json") -Value '{"installId":"legacy"}'
    Set-Content -LiteralPath (Join-Path $dir ".gaffer-usage-buffer.json") -Value '[{"event":"unsent"}]'
    New-Item -ItemType Directory -Path (Join-Path $dir ".gaffer-icons") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $dir ".gaffer-icons\notion.svg") -Value '<svg id="cached"/>'
    Set-Content -LiteralPath (Join-Path $dir "stale-file-from-old-release.txt") -Value 'stale'
}

function Get-TreeHash([string] $dir) {
    $lines = Get-ChildItem -LiteralPath $dir -Recurse -File -Force |
        Where-Object { $_.FullName -notlike "*\node_modules\*" } |
        Sort-Object FullName |
        ForEach-Object { $_.FullName.Substring($dir.Length) + " " + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    return ($lines -join "`n")
}

function Invoke-Update([string] $dir, [string] $asset) {
    $env:GAFFER_UPDATE_ASSET = $asset
    $env:TEMP = "$scratch\tmp"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir "daemon\update.ps1") | Out-Null
    return $LASTEXITCODE
}

$realTemp = $env:TEMP
try {
    # ---------- Case 1: a good release asset ----------
    $install = Join-Path $scratch "Application Data\com.gaffer.panel"
    New-TestInstall $install
    $userFiles = @("chat-history.json", "chat-history-26.0.json", ".gaffer-config.json", ".gaffer-usage-buffer.json", ".gaffer-icons\notion.svg")
    $before = @{}
    foreach ($f in $userFiles) { $before[$f] = (Get-FileHash -LiteralPath (Join-Path $install $f)).Hash }

    $code = Invoke-Update $install $ReleaseZip
    if ($code -eq 0) { Pass "update.ps1 exited 0" } else { Fail "update.ps1 exited $code (log: $scratch\tmp\gaffer-update.log)" }

    $gotVersion = Get-Content -LiteralPath (Join-Path $install "version.json") -Raw
    $wantVersion = Get-Content -LiteralPath (Join-Path $expected "version.json") -Raw
    if ($gotVersion -eq $wantVersion) { Pass "version.json is the release's stamped file" } else { Fail "version.json is not the release's: $gotVersion" }

    foreach ($f in $userFiles) {
        $p = Join-Path $install $f
        if ((Test-Path -LiteralPath $p) -and ((Get-FileHash -LiteralPath $p).Hash -eq $before[$f])) { Pass "$f preserved" } else { Fail "$f lost or changed" }
    }

    foreach ($junk in @("gaffer.zip", "gaffer-update-win.zip", "extract", "version.json.tmp", "stale-file-from-old-release.txt")) {
        if (Test-Path -LiteralPath (Join-Path $install $junk)) { Fail "$junk left in the panel dir" } else { Pass "no $junk in the panel dir" }
    }

    $gotMain = (Get-FileHash -LiteralPath (Join-Path $install "main.js")).Hash
    $wantMain = (Get-FileHash -LiteralPath (Join-Path $expected "main.js")).Hash
    if ($gotMain -eq $wantMain) { Pass "release files landed (main.js matches the asset)" } else { Fail "main.js does not match the asset" }

    $vj = Get-Item -LiteralPath (Join-Path $install "version.json")
    $newer = Get-ChildItem -LiteralPath $install -Recurse -File -Force | Where-Object { $_.LastWriteTimeUtc -gt $vj.LastWriteTimeUtc }
    if (-not $newer) { Pass "version.json is the newest file in the panel dir (written last)" } else { Fail "files written after version.json: $(($newer | Select-Object -First 5 | ForEach-Object { $_.FullName }) -join ', ')" }

    $log = Get-Content -LiteralPath "$scratch\tmp\gaffer-update.log" -Raw
    $wantOk = "ok:" + ((Get-Content -LiteralPath (Join-Path $expected "version.json") -Raw | ConvertFrom-Json).version)
    if ($log -match [regex]::Escape($wantOk)) { Pass "log contains $wantOk" } else { Fail "no $wantOk in the log" }
    if (Get-ChildItem -LiteralPath "$scratch\tmp" -Directory -Filter "gaffer-update-*" -ErrorAction SilentlyContinue) { Fail "temp dir not cleaned up" } else { Pass "temp dir cleaned up" }

    # ---------- Case 2: a broken download changes nothing ----------
    $broken = Join-Path $scratch "Application Data\broken\com.gaffer.panel"
    New-TestInstall $broken
    $notZip = Join-Path $scratch "not-a-release.zip"
    Set-Content -LiteralPath $notZip -Value '<html>Not Found</html>'
    $beforeTree = Get-TreeHash $broken
    $code = Invoke-Update $broken $notZip
    if ($code -ne 0) { Pass "update.ps1 exited non-zero on a broken download" } else { Fail "update.ps1 exited 0 on a broken download" }
    if ((Get-TreeHash $broken) -eq $beforeTree) { Pass "broken download left the install untouched" } else { Fail "broken download modified the install" }
} finally {
    $env:TEMP = $realTemp
    Remove-Item Env:\GAFFER_UPDATE_ASSET -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:fails -eq 0) { Write-Host "ALL PASS"; exit 0 } else { Write-Host "$($script:fails) FAILURE(S)"; exit 1 }
