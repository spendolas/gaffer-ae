# test-5-update-ps1.ps1
# ======================================================================
# End-to-end test for panel\daemon\update.ps1 against a scratch install,
# the Windows twin of scripts/test-update-sh.sh. Run it on a Windows box
# (the gaffer-winvm test VM) under Windows PowerShell 5.1.
#
# Lays down a v0.10.8 install (from -OldInstallZip) under a path WITH A
# SPACE, seeds user data, runs the update.ps1 from -UpdateScriptDir inside
# that install with GAFFER_UPDATE_ASSET pointing at -ReleaseZip, and checks
# the result. A second case feeds it a broken download and a third a 404
# URL (the branch real users take); both check that nothing in the install
# changed. Case 3b makes curl.exe fail and checks the system proxy fallback
# downloads the real latest release; 3c does the same with a 403 from curl
# (a proxy answer, not a missing asset). Cases 4 to 9 cover the
# single-updater lock: a second updater exits busy while a live one holds
# the lock (also when that one was launched with a forward-slash path, as
# the panel's ExtendScript fallback does, and when it was started by hand
# from inside the daemon folder with no daemon\ in its command line), a
# holder created after the lock was written is a reused pid (not stopped,
# its lock abandoned), an abandoned lock (dead pid, or a minutes-old file
# with no pid in it) is taken over (a stale takeover marker is cleared on
# the way, a fresh one means busy, two updaters clearing the same stale
# marker yield one winner, a fresh marker renamed by mistake is put back),
# a seconds-old file with no pid in it is busy, two updaters taking over the
# same stale lock yield one winner (the gated one is rejected by the pid
# re-read inside the mutex), a live holder whose lock is older than the
# stuck age is stopped together with its child and grandchild and taken over
# (the stuck age is lowered to 3 s with GAFFER_UPDATE_TEST_STUCK_AFTER and
# the lock aged for real, because a holder younger than its lock is a
# reused pid), a lock dated in the future with a live holder is busy (the
# holder is not stopped) while one with a dead pid is taken over, a holder
# that vanished just before the stop is not signalled, an updater whose lock
# was replaced under it leaves the replacement alone on exit, the lock is
# gone after every run, and the dev-install refusal still ends the log with
# err:dev-install. Cases 6e to 6h cover the stop's limits: a holder
# recognised by its process name only (a person's PowerShell window, no
# update.ps1 in its command line) past the stuck age is never stopped and
# the run ends with err:lock, a failed descendant listing goes through
# taskkill /T while the holder is alive and still ends the whole tree, a
# holder that is this updater's own parent is refused with err:lock, and
# the stuck-age knob is ignored without GAFFER_UPDATE_ASSET, at 0 and at a
# huge value. A broken download ends the log with err:download. The races
# are made deterministic with update.ps1's GAFFER_UPDATE_TEST_*_GATE files,
# never with sleeps.
#
# update.ps1 stops whatever listens on port 9823, so this refuses to run
# while a Gaffer daemon is up (close After Effects first). To run next to a
# live daemon without touching it, pass -ShimDaemonStop: each scratch
# install then gets a no-op stop-daemon.ps1 instead of the real one, so the
# updater's Stop-Daemon finds nothing to stop (the twin of the Mac harness's
# GAFFER_TEST_SHIM_DAEMON_STOP). Everything else (download, runtime step,
# robocopy, lock) is exercised for real.
#
# Zero-dependency updater: there is no npm step any more. Every successful
# run stages the Node runtime (the old install has none), so this harness
# never lets the updater reach nodejs.org: it sets fetch-runtime.ps1's
# GAFFER_FETCH_* test seams for every run (update.ps1 passes them on because
# GAFFER_UPDATE_ASSET is set) to a local zip of -NodeExe served as a file://
# URL, with pins written to match. The runtime step itself is covered in
# depth by test-6-runtime-update.ps1.
#
# Inputs, built on the Mac (see the implementation plan):
#   -UpdateScriptDir  folder with the NEW update.ps1, stop-daemon.ps1 and
#                     fetch-runtime.ps1
#   -OldInstallZip    git archive --format=zip -o old-install.zip ce16c2f:panel
#   -ReleaseZip       gaffer-update-win.zip from scripts/package-release.sh,
#                     which MUST be a zero-dependency build (daemon\daemon.mjs,
#                     daemon\fetch-runtime.ps1 and daemon\runtime-pins.json
#                     inside): the new updater refuses any other archive
#   -NodeExe          a node.exe served as the runtime (default: node.exe on
#                     PATH); an OpenJS-signed one keeps the Authenticode
#                     check on, any other runs with it skipped (NOTE line)
#   -ShimDaemonStop   leave a running daemon alone (see above)
#
# Cases 3b and 3c download the LATEST PUBLISHED release through the system
# proxy path. While that release is still a pre-zero-dependency one, the new
# updater refuses it after the download (no daemon\daemon.mjs); those cases
# then check the refusal instead of ok: and say so in a NOTE line.
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\test-5-update-ps1.ps1 -UpdateScriptDir <dir> -OldInstallZip <zip> -ReleaseZip <zip> [-NodeExe <node.exe>] [-ShimDaemonStop]
param(
    [Parameter(Mandatory = $true)][string] $UpdateScriptDir,
    [Parameter(Mandatory = $true)][string] $OldInstallZip,
    [Parameter(Mandatory = $true)][string] $ReleaseZip,
    [string] $NodeExe = "",
    [switch] $ShimDaemonStop
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:fails = 0
function Pass([string] $m) { Write-Host "PASS: $m" }
function Fail([string] $m) { Write-Host "FAIL: $m"; $script:fails++ }

Write-Host "PowerShell $($PSVersionTable.PSVersion)"
if (-not $ShimDaemonStop -and (Get-NetTCPConnection -LocalPort 9823 -State Listen -ErrorAction SilentlyContinue)) {
    Write-Host "ABORT: something is listening on port 9823 (a running Gaffer daemon). Close After Effects first,"
    Write-Host "or re-run with -ShimDaemonStop to leave the daemon alone."
    exit 2
}
if ($ShimDaemonStop) { Write-Host "-ShimDaemonStop set: Stop-Daemon is a no-op in every scratch install, the live daemon is left alone" }
if (-not (Select-String -Path (Join-Path $UpdateScriptDir "update.ps1") -Pattern "GAFFER_UPDATE_ASSET" -Quiet)) {
    Write-Host "FAIL: update.ps1 does not honor GAFFER_UPDATE_ASSET (still the main-archive updater)"
    exit 1
}
if (-not $NodeExe) {
    $nodeCmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCmd) { $NodeExe = $nodeCmd.Source }
}
if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { Write-Host "ABORT: no node.exe for the runtime fixture; pass -NodeExe"; exit 2 }

$scratch = Join-Path $env:TEMP ("gaffer-update-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path "$scratch\tmp" -Force | Out-Null
$expected = Join-Path $scratch "expected"
Expand-Archive -Path $ReleaseZip -DestinationPath $expected -Force
foreach ($need in @("daemon\daemon.mjs", "daemon\fetch-runtime.ps1", "daemon\runtime-pins.json")) {
    if (-not (Test-Path -LiteralPath (Join-Path $expected $need))) { Write-Host "ABORT: -ReleaseZip is not a zero-dependency build (no $need)"; exit 2 }
}

# Runtime fixture: a zip of -NodeExe under the pinned member path, served as a
# file:// URL, and pins that match it. Set for every run below (each child
# PowerShell inherits it); removed in the finally at the bottom.
$fxVersion = (& $NodeExe --version).Trim()
$fxTop = "node-$fxVersion-win-x64"
$fxDir = Join-Path $scratch "runtime-fixture"
New-Item -ItemType Directory -Path (Join-Path $fxDir "src\$fxTop"), (Join-Path $fxDir "serve") -Force | Out-Null
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $fxDir "src\$fxTop\node.exe")
$fxZip = Join-Path $fxDir "serve\$fxTop.zip"
& (Join-Path $env:SystemRoot "System32\tar.exe") -a -c -f $fxZip -C (Join-Path $fxDir "src") "$fxTop/node.exe"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fxZip)) { Write-Host "ABORT: could not build the runtime fixture zip with tar.exe"; exit 2 }
$fxPins = @{ node = @{
    version = $fxVersion; codename = "Test"
    official = "https://example.invalid/official/"; mirror = "https://example.invalid/mirror/"
    platforms = @{ "win-x64" = @{
        archive = "$fxTop.zip"; archiveSha256 = (Get-FileHash -LiteralPath $fxZip -Algorithm SHA256).Hash.ToLowerInvariant()
        member = "$fxTop/node.exe"; binaryBytes = (Get-Item -LiteralPath $NodeExe).Length
        binarySha256 = (Get-FileHash -LiteralPath $NodeExe -Algorithm SHA256).Hash.ToLowerInvariant() } }
    signing = @{ darwinTeamId = "HX7739G8FX"; windowsSigner = "OpenJS Foundation" }
} }
$fxPinsPath = Join-Path $fxDir "pins.json"
[System.IO.File]::WriteAllText($fxPinsPath, ($fxPins | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
$fxBase = ([System.Uri] ((Join-Path $fxDir "serve") + "\")).AbsoluteUri
$env:GAFFER_FETCH_TEST = "1"
$env:GAFFER_FETCH_PINS = $fxPinsPath
$env:GAFFER_FETCH_PLATFORM = "win-x64"
$env:GAFFER_FETCH_BASE_OFFICIAL = $fxBase
$env:GAFFER_FETCH_BASE_MIRROR = $fxBase
$fxSig = Get-AuthenticodeSignature -LiteralPath $NodeExe
if ($fxSig.Status -ne "Valid" -or -not $fxSig.SignerCertificate -or $fxSig.SignerCertificate.Subject -notmatch "OpenJS Foundation") {
    $env:GAFFER_FETCH_SKIP_CODESIGN = "1"
    Write-Host "NOTE: $NodeExe is not OpenJS-signed (status $($fxSig.Status)); the Authenticode check is skipped"
}
Write-Host "Runtime fixture: $fxVersion from $NodeExe (served from $fxBase)"

function New-TestInstall([string] $dir) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Expand-Archive -Path $OldInstallZip -DestinationPath $dir -Force
    Copy-Item (Join-Path $UpdateScriptDir "update.ps1") (Join-Path $dir "daemon\update.ps1") -Force
    # update.ps1 runs the ARCHIVE's fetch-runtime.ps1; this copy only keeps
    # the installed folder consistent with the scripts under test.
    Copy-Item (Join-Path $UpdateScriptDir "fetch-runtime.ps1") (Join-Path $dir "daemon\fetch-runtime.ps1") -Force
    if ($ShimDaemonStop) {
        # Same signature as the real one; finds nothing to stop.
        Set-Content -LiteralPath (Join-Path $dir "daemon\stop-daemon.ps1") -Value "function Stop-Daemon { param([int[]] `$ProcIds = `$null) }"
    } else {
        Copy-Item (Join-Path $UpdateScriptDir "stop-daemon.ps1") (Join-Path $dir "daemon\stop-daemon.ps1") -Force
    }
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

# $extraEnv holds env vars only this one run should see (the stuck-age
# override); they are set for the run and removed right after. -NoAsset
# runs update.ps1 the way the panel does, without GAFFER_UPDATE_ASSET (the
# real download URL), for the cases that must end before any download.
function Invoke-Update([string] $dir, [string] $asset, [hashtable] $extraEnv = @{}, [switch] $NoAsset) {
    if ($NoAsset) { Remove-Item Env:\GAFFER_UPDATE_ASSET -ErrorAction SilentlyContinue } else { $env:GAFFER_UPDATE_ASSET = $asset }
    $env:TEMP = "$scratch\tmp"
    foreach ($k in $extraEnv.Keys) { Set-Item -Path "Env:\$k" -Value $extraEnv[$k] }
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir "daemon\update.ps1") | Out-Null
        return $LASTEXITCODE
    } finally {
        foreach ($k in $extraEnv.Keys) { Remove-Item -Path "Env:\$k" -ErrorAction SilentlyContinue }
    }
}
# The stuck cases run update.ps1 with the 15 minute stuck age lowered to
# this and let the lock age for real: a holder created after its lock is a
# reused pid to update.ps1 now, so a backdated lock would be abandoned, not
# stopped.
$stuckAfter = 3
function Wait-LockPastStuck { Start-Sleep -Seconds ($stuckAfter + 1) }

# The lock update.ps1 holds for its run (same TEMP Invoke-Update points it at).
$lockPath = "$scratch\tmp\gaffer-update.lock"
$logPath = "$scratch\tmp\gaffer-update.log"
function Get-LastLogLine {
    if (-not (Test-Path -LiteralPath $logPath)) { return "" }
    $lines = Get-Content -LiteralPath $logPath | Where-Object { $_ -ne "" }
    # Start-Transcript appends its own footer after the script's last line.
    $body = $lines | Where-Object { $_ -notmatch '^\*{10,}' -and $_ -notmatch '^(Windows PowerShell transcript end|End time:)' }
    if ($body) { return [string] ($body | Select-Object -Last 1) }
    return ""
}
# A long-lived process whose command line contains "daemon\update.ps1",
# which is what the lock's liveness check looks for. Like a real stuck
# updater it has a long-lived child (its curl.exe, robocopy or runtime step) which in
# turn has a child (a grandchild sleep), and records their pids in
# $scratch\fake\child.pid and grandchild.pid. -ForwardSlash launches it by
# a "daemon/update.ps1" path, as the panel's ExtendScript fallback does;
# -Bare launches it as "-File update.ps1" from inside the daemon folder, as
# a person does by hand, so no daemon\ appears in its command line.
# Returns the process.
function Start-FakeUpdater([switch] $ForwardSlash, [switch] $Bare) {
    New-Item -ItemType Directory -Path "$scratch\fake\daemon" -Force | Out-Null
    Remove-Item -LiteralPath "$scratch\fake\child.pid", "$scratch\fake\grandchild.pid" -Force -ErrorAction SilentlyContinue
    $childScript = "$scratch\fake\child.ps1"
    $childBody = @(
        '$g = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 300") -WindowStyle Hidden -PassThru',
        "[System.IO.File]::WriteAllText('$scratch\fake\grandchild.pid', `"`$(`$g.Id)`")",
        'Start-Sleep -Seconds 300'
    )
    Set-Content -LiteralPath $childScript -Value ($childBody -join "`r`n")
    $body = @(
        "`$child = Start-Process -FilePath `"powershell.exe`" -ArgumentList @(`"-NoProfile`", `"-ExecutionPolicy`", `"Bypass`", `"-File`", `"$childScript`") -WindowStyle Hidden -PassThru",
        "[System.IO.File]::WriteAllText('$scratch\fake\child.pid', `"`$(`$child.Id)`")",
        'Start-Sleep -Seconds 300'
    )
    Set-Content -LiteralPath "$scratch\fake\daemon\update.ps1" -Value ($body -join "`r`n")
    $scriptPath = "$scratch\fake\daemon\update.ps1"
    if ($ForwardSlash) { $scriptPath = $scriptPath.Replace('\', '/') }
    if ($Bare) {
        $p = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "update.ps1") -WorkingDirectory "$scratch\fake\daemon" -WindowStyle Hidden -PassThru
    } else {
        $p = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath) -WindowStyle Hidden -PassThru
    }
    for ($i = 0; $i -lt 80; $i++) {
        if ((Test-Path -LiteralPath "$scratch\fake\child.pid") -and (Test-Path -LiteralPath "$scratch\fake\grandchild.pid")) { break }
        Start-Sleep -Milliseconds 250
    }
    return $p
}
function Get-FakePid([string] $name) {
    if (-not (Test-Path -LiteralPath "$scratch\fake\$name.pid")) { return 0 }
    return [int] (Get-Content -LiteralPath "$scratch\fake\$name.pid" -Raw).Trim()
}
function Get-FakeUpdaterChildId { return (Get-FakePid "child") }
function Get-FakeUpdaterGrandchildId { return (Get-FakePid "grandchild") }
function Stop-FakeUpdater($p) {
    if (-not $p) { return }
    $childId = Get-FakeUpdaterChildId
    $grandchildId = Get-FakeUpdaterGrandchildId
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    if ($childId -gt 0) { Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue }
    if ($grandchildId -gt 0) { Stop-Process -Id $grandchildId -Force -ErrorAction SilentlyContinue }
    $p.WaitForExit(5000) | Out-Null
}
$fake = $null
# Cases 6e and 6g: a plain PowerShell standing in for a person's window, and
# a wrapper that runs the updater as its child; both are stopped on the way
# out if a case aborted before stopping them.
$window = $null
$wrapper = $null

# Start update.ps1 in $dir detached, its stdout (Write-Host lines included)
# captured in $outFile so each racer's output can be judged on its own (two
# concurrent Start-Transcript -Append writers overwrite each other's lines).
# $extraEnv holds env vars only this one process should see; they are set
# for the spawn and removed right after. Start-Process does not quote list
# arguments: the install paths contain a space, so -File is quoted by hand.
function Start-Updater([string] $dir, [string] $outFile, [hashtable] $extraEnv) {
    $env:GAFFER_UPDATE_ASSET = $ReleaseZip
    $env:TEMP = "$scratch\tmp"
    foreach ($k in $extraEnv.Keys) { Set-Item -Path "Env:\$k" -Value $extraEnv[$k] }
    try {
        $p = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + (Join-Path $dir "daemon\update.ps1") + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput $outFile
        # PS 5.1: a -PassThru process reports no ExitCode unless its handle
        # was cached while it was alive.
        $null = $p.Handle
        return $p
    } finally {
        foreach ($k in $extraEnv.Keys) { Remove-Item -Path "Env:\$k" -ErrorAction SilentlyContinue }
    }
}
# Waits (up to 10 minutes) and returns the exit code; the parameterless
# WaitForExit() is what makes ExitCode readable.
function Wait-Updater($p) {
    $p.WaitForExit(600000) | Out-Null
    $p.WaitForExit()
    return $p.ExitCode
}
function Wait-ForFile([string] $path) {
    for ($i = 0; $i -lt 300; $i++) {
        if (Test-Path -LiteralPath $path) { return $true }
        Start-Sleep -Milliseconds 100
    }
    Fail "timed out waiting for $path"
    return $false
}
function Read-Out([string] $path) {
    if (Test-Path -LiteralPath $path) { return [string] (Get-Content -LiteralPath $path -Raw) }
    return ""
}
function Read-Lock {
    if (Test-Path -LiteralPath $lockPath) { return (Get-Content -LiteralPath $lockPath -Raw -ErrorAction SilentlyContinue).Trim() }
    return ""
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

    # daemon\test and daemon\test-fixtures shipped with releases up to v0.11.2
    # and are absent from the asset now: robocopy /PURGE must remove them.
    foreach ($junk in @("gaffer.zip", "gaffer-update-win.zip", "extract", "version.json.tmp", "stale-file-from-old-release.txt", "daemon\test", "daemon\test-fixtures")) {
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
    if (Test-Path -LiteralPath $lockPath) { Fail "update lock left behind after success" } else { Pass "update lock released after success" }

    # ---------- Case 2: a broken download changes nothing ----------
    $broken = Join-Path $scratch "Application Data\broken\com.gaffer.panel"
    New-TestInstall $broken
    $notZip = Join-Path $scratch "not-a-release.zip"
    Set-Content -LiteralPath $notZip -Value '<html>Not Found</html>'
    $beforeTree = Get-TreeHash $broken
    $code = Invoke-Update $broken $notZip
    if ($code -ne 0) { Pass "update.ps1 exited non-zero on a broken download" } else { Fail "update.ps1 exited 0 on a broken download" }
    if ((Get-TreeHash $broken) -eq $beforeTree) { Pass "broken download left the install untouched" } else { Fail "broken download modified the install" }
    if (Test-Path -LiteralPath $lockPath) { Fail "update lock left behind after a failed update" } else { Pass "update lock released after a failed update" }
    # The panel and a reader rely on the last line: err:download after the ERROR line, like Mac.
    $last = Get-LastLogLine
    if ($last -eq "err:download") { Pass "broken download ends the log with err:download" } else { Fail "broken download last log line: $last" }
    $logBroken = Get-Content -LiteralPath $logPath -Raw
    if ($logBroken -match "ERROR: download or extract failed") { Pass "broken download logs an ERROR line" } else { Fail "no ERROR line for the broken download" }

    # ---------- Case 3: a 404 URL changes nothing (exercises the URL branch) ----------
    # Cases 1 and 2 hand update.ps1 a local file. Real users always hit the
    # URL branch: Test-Path must treat "https://..." as not-a-file without
    # raising, and Invoke-WebRequest's 404 must land in the catch. Needs
    # internet access (GitHub only; the runtime never comes from the net).
    $missing = Join-Path $scratch "Application Data\missing\com.gaffer.panel"
    New-TestInstall $missing
    $notFoundUrl = "https://github.com/spendolas/gaffer-ae/releases/download/v0.0.0/nope.zip"
    $beforeTree = Get-TreeHash $missing
    # Start-Transcript appends, so drop the log from cases 1 and 2 first: the
    # 404 check below must only see this run's output.
    $logPath = "$scratch\tmp\gaffer-update.log"
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $missing $notFoundUrl
    if ($code -ne 0) { Pass "update.ps1 exited non-zero on a 404 URL" } else { Fail "update.ps1 exited 0 on a 404 URL" }
    if ((Get-TreeHash $missing) -eq $beforeTree) { Pass "404 URL left the install untouched" } else { Fail "404 URL modified the install" }
    # A non-zero exit alone would also pass if Test-Path threw on the URL or
    # the network was down. Only the server's 404 proves the download ran:
    # PS 5.1 reports "The remote server returned an error: (404) Not Found."
    $log404 = ""
    if (Test-Path -LiteralPath $logPath) { $log404 = Get-Content -LiteralPath $logPath -Raw }
    if ($log404 -match "\(404\)") { Pass "update.ps1 reached the download and got the server's 404" } else { Fail "update.ps1 did not reach the download (offline or URL branch broke); log: $logPath" }
    $last = Get-LastLogLine
    if ($last -eq "err:download") { Pass "404 run ends the log with err:download" } else { Fail "404 run last log line: $last" }
    # A 404 is final: curl.exe must not hand it to the system proxy path.
    if ($log404 -notmatch "trying the system proxy path") { Pass "404 from curl.exe did not fall back to the system proxy path" } else { Fail "404 from curl.exe fell back to the system proxy path" }

    # Judges a run against the latest PUBLISHED release (cases 3b, 3c). A
    # zero-dependency release must install (ok:, daemon\daemon.mjs). A
    # pre-zero-dependency one is refused by the new updater after its
    # download: that still proves the system proxy path fetched it.
    function Test-LatestOutcome([int] $code, [string] $log, [string] $dir, [string] $label) {
        if ($log -match "missing version\.json or daemon\\daemon\.mjs") {
            Write-Host "NOTE: $label`: the latest published release is not a zero-dependency build; checking the refusal instead of ok:"
            if ($code -ne 0 -and $log -notmatch "download or extract failed") { Pass "$label`: the system proxy path downloaded the latest release, the new updater refused its old layout" } else { Fail "$label`: exit $code, the download did not complete; log: $logPath" }
            return
        }
        if ($code -eq 0) { Pass "$label`: system proxy path downloaded the latest release and update.ps1 exited 0" } else { Fail "$label`: update.ps1 exited $code on the system proxy path (offline?); log: $logPath" }
        $lastLine = Get-LastLogLine
        if ($lastLine -match "^ok:\d+\.\d+\.\d+") { Pass "$label`: ends with $lastLine" } else { Fail "$label`: last log line: $lastLine" }
        if (Test-Path -LiteralPath (Join-Path $dir "daemon\daemon.mjs")) { Pass "$label`: installed the release files" } else { Fail "$label`: left no daemon\daemon.mjs" }
    }

    # ---------- Case 3b: a curl.exe failure falls back to the system proxy path ----------
    # curl.exe ignores the WinINET proxy and fails on blocked revocation
    # checks, so a non-4xx curl failure must fall back to the .NET download.
    # GAFFER_UPDATE_CURL points update.ps1 at a stand-in that fails like a
    # curl that cannot connect (exit 7); the fallback then downloads the real
    # latest release asset from GitHub (see Test-LatestOutcome for what is
    # expected of it).
    $fallback = Join-Path $scratch "Application Data\fallback\com.gaffer.panel"
    New-TestInstall $fallback
    $fakeCurl = Join-Path $scratch "curl-fail.cmd"
    Set-Content -LiteralPath $fakeCurl -Value "@echo curl: (7) Failed to connect 1>&2`r`n@exit /b 7"
    $latestUrl = "https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-update-win.zip"
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $env:GAFFER_UPDATE_CURL = $fakeCurl
    try { $code = Invoke-Update $fallback $latestUrl } finally { Remove-Item Env:\GAFFER_UPDATE_CURL -ErrorAction SilentlyContinue }
    $logFallback = ""
    if (Test-Path -LiteralPath $logPath) { $logFallback = Get-Content -LiteralPath $logPath -Raw }
    if ($logFallback -match "curl\.exe could not download the asset \(curl\.exe exit 7") { Pass "curl.exe failure (exit 7) was logged and handed to the system proxy path" } else { Fail "no fallback line in the log; log: $logPath" }
    Test-LatestOutcome $code $logFallback $fallback "fallback run"
    if (Test-Path -LiteralPath $lockPath) { Fail "update lock left behind after the fallback run" } else { Pass "update lock released after the fallback run" }

    # ---------- Case 3c: a 403 from curl.exe is a proxy answer, not a missing asset: fall back ----------
    # Only 404 and 410 are final. A proxy that intercepts curl.exe answers
    # 403 or 407, and the .NET path (system proxy, user credentials) may
    # well get through, so such a status must fall back like exit 7 did.
    $forbidden = Join-Path $scratch "Application Data\forbidden\com.gaffer.panel"
    New-TestInstall $forbidden
    $fakeCurl403 = Join-Path $scratch "curl-403.cmd"
    # Redirect first: "echo ... 403 1>&2" would echo a trailing space, and
    # a parenthesised echo trips over the "(22)" in the message.
    Set-Content -LiteralPath $fakeCurl403 -Value "@>&2 echo curl: (22) The requested URL returned error: 403`r`n@exit /b 22"
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $env:GAFFER_UPDATE_CURL = $fakeCurl403
    try { $code = Invoke-Update $forbidden $latestUrl } finally { Remove-Item Env:\GAFFER_UPDATE_CURL -ErrorAction SilentlyContinue }
    $log403 = ""
    if (Test-Path -LiteralPath $logPath) { $log403 = Get-Content -LiteralPath $logPath -Raw }
    if ($log403 -match "curl\.exe could not download the asset \(curl\.exe exit 22 : curl: \(22\) The requested URL returned error: 403\s*\), trying the system proxy path") { Pass "403 from curl.exe was handed to the system proxy path" } else { Fail "403 from curl.exe did not fall back; log: $logPath" }
    Test-LatestOutcome $code $log403 $forbidden "403 run"
    if (Test-Path -LiteralPath $lockPath) { Fail "update lock left behind after the 403 run" } else { Pass "update lock released after the 403 run" }

    # ---------- Case 4: a second updater exits busy while a live one holds the lock ----------
    $busy = Join-Path $scratch "Application Data\busy\com.gaffer.panel"
    New-TestInstall $busy
    $fake = Start-FakeUpdater
    Start-Sleep -Seconds 1
    [System.IO.File]::WriteAllText($lockPath, "$($fake.Id)", [System.Text.Encoding]::ASCII)
    $beforeTree = Get-TreeHash $busy
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $busy $ReleaseZip
    if ($code -eq 3) { Pass "second updater exited 3 while the lock was held" } else { Fail "second updater exited $code, expected 3" }
    $last = Get-LastLogLine
    if ($last -eq "busy:already-running") { Pass "log ends with busy:already-running" } else { Fail "last log line is not busy:already-running: $last" }
    if ((Get-TreeHash $busy) -eq $beforeTree) { Pass "second updater left the install untouched" } else { Fail "second updater modified the install" }
    $holder = ""
    if (Test-Path -LiteralPath $lockPath) { $holder = (Get-Content -LiteralPath $lockPath -Raw).Trim() }
    if ($holder -eq "$($fake.Id)") { Pass "live lock kept its holder's pid" } else { Fail "live lock was removed or rewritten (now: '$holder')" }
    Stop-FakeUpdater $fake
    $fake = $null
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue

    # ---------- Case 4b: a holder launched by a forward-slash path is an updater too ----------
    # The panel's ExtendScript fallback runs ".../daemon/update.ps1"; its
    # command line has no backslash before update.ps1.
    $slash = Join-Path $scratch "Application Data\slash\com.gaffer.panel"
    New-TestInstall $slash
    $fake = Start-FakeUpdater -ForwardSlash
    Start-Sleep -Seconds 1
    $fakeCmd = ""
    try { $fakeCmd = "$((Get-CimInstance Win32_Process -Filter "ProcessId = $($fake.Id)").CommandLine)" } catch {}
    if ($fakeCmd -match "daemon/update\.ps1" -and $fakeCmd -notmatch "daemon\\update\.ps1") { Pass "forward-slash holder's command line reads daemon/update.ps1" } else { Fail "forward-slash holder's command line is: $fakeCmd" }
    [System.IO.File]::WriteAllText($lockPath, "$($fake.Id)", [System.Text.Encoding]::ASCII)
    $beforeTree = Get-TreeHash $slash
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $slash $ReleaseZip
    if ($code -eq 3) { Pass "second updater exited 3 while a forward-slash holder holds the lock" } else { Fail "second updater exited $code against a forward-slash holder, expected 3" }
    $logSlash = ""
    if (Test-Path -LiteralPath $logPath) { $logSlash = Get-Content -LiteralPath $logPath -Raw }
    if ($logSlash -match [regex]::Escape("Another update is already running (pid $($fake.Id))")) { Pass "log names the forward-slash holder as a running update" } else { Fail "forward-slash holder was not recognised as an updater" }
    if ((Get-TreeHash $slash) -eq $beforeTree) { Pass "forward-slash run left the install untouched" } else { Fail "forward-slash run modified the install" }
    if ((Read-Lock) -eq "$($fake.Id)") { Pass "forward-slash holder's lock kept its pid" } else { Fail "forward-slash holder's lock was removed or rewritten" }
    Stop-FakeUpdater $fake
    $fake = $null
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue

    # ---------- Case 4c: a holder started by hand from inside the daemon folder is an updater too ----------
    # "powershell -File update.ps1" with the daemon folder as the working
    # directory: no daemon\ in the command line. It is a live PowerShell
    # created before the lock was written, which is what counts now.
    $bare = Join-Path $scratch "Application Data\bare\com.gaffer.panel"
    New-TestInstall $bare
    $fake = Start-FakeUpdater -Bare
    Start-Sleep -Seconds 1
    $fakeCmd = ""
    try { $fakeCmd = "$((Get-CimInstance Win32_Process -Filter "ProcessId = $($fake.Id)").CommandLine)" } catch {}
    if ($fakeCmd -notmatch "daemon[\\/]update\.ps1" -and $fakeCmd -match "update\.ps1") { Pass "hand-started holder's command line has no daemon folder in it" } else { Fail "hand-started holder's command line is: $fakeCmd" }
    [System.IO.File]::WriteAllText($lockPath, "$($fake.Id)", [System.Text.Encoding]::ASCII)
    $beforeTree = Get-TreeHash $bare
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $bare $ReleaseZip
    if ($code -eq 3) { Pass "second updater exited 3 while a hand-started holder holds the lock" } else { Fail "second updater exited $code against a hand-started holder, expected 3" }
    $logBare = ""
    if (Test-Path -LiteralPath $logPath) { $logBare = Get-Content -LiteralPath $logPath -Raw }
    if ($logBare -match [regex]::Escape("Another update is already running (pid $($fake.Id))")) { Pass "log names the hand-started holder as a running update" } else { Fail "hand-started holder was not recognised as an updater" }
    if ((Get-TreeHash $bare) -eq $beforeTree) { Pass "hand-started run left the install untouched" } else { Fail "hand-started run modified the install" }
    if ((Read-Lock) -eq "$($fake.Id)") { Pass "hand-started holder's lock kept its pid" } else { Fail "hand-started holder's lock was removed or rewritten" }
    if (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue) { Pass "hand-started holder is still alive" } else { Fail "hand-started holder was stopped" }
    Stop-FakeUpdater $fake
    $fake = $null
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue

    # ---------- Case 4d: a holder created after the lock was written is a reused pid ----------
    # The lock is 2 minutes old; the live PowerShell holding its pid (a real
    # daemon\update.ps1 command line, even) is seconds old, so it cannot be
    # the updater that wrote the lock. The lock is abandoned and taken over;
    # the process is left alone (not ours to stop).
    $reuse = Join-Path $scratch "Application Data\pid-reuse\com.gaffer.panel"
    New-TestInstall $reuse
    $fake = Start-FakeUpdater
    Start-Sleep -Seconds 1
    [System.IO.File]::WriteAllText($lockPath, "$($fake.Id)", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $lockPath).LastWriteTime = (Get-Date).AddMinutes(-2)
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $reuse $ReleaseZip
    if ($code -eq 0) { Pass "update.ps1 took over the lock whose pid was reused and exited 0" } else { Fail "update.ps1 exited $code on a reused-pid lock (log: $logPath)" }
    $logReuse = ""
    if (Test-Path -LiteralPath $logPath) { $logReuse = Get-Content -LiteralPath $logPath -Raw }
    if ($logReuse -match [regex]::Escape("The lock's pid $($fake.Id) belongs to a process that is not the update that wrote the lock")) { Pass "log explains the reused pid" } else { Fail "no pid-reuse line in the log" }
    if ($logReuse -match [regex]::Escape("Taking over an abandoned update lock (pid $($fake.Id))")) { Pass "reused-pid lock was taken over as abandoned" } else { Fail "no takeover line for the reused-pid lock" }
    if ($logReuse -notmatch "Stopping an update") { Pass "no stop was attempted on the process that reused the pid" } else { Fail "the process that reused the pid was stopped" }
    if (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue) { Pass "the process that reused the pid (pid $($fake.Id)) is still alive" } else { Fail "the process that reused the pid was killed" }
    Stop-FakeUpdater $fake
    $fake = $null
    if (Test-Path -LiteralPath $lockPath) { Fail "lock left behind after the reused-pid run" } else { Pass "lock released after the reused-pid run" }

    # ---------- Case 5: an abandoned lock (dead pid) is taken over ----------
    # Also: a takeover marker older than 60 seconds (left by a crashed
    # updater) does not block the takeover; it is removed.
    $stale = Join-Path $scratch "Application Data\stale\com.gaffer.panel"
    New-TestInstall $stale
    $dead = Start-FakeUpdater
    Stop-FakeUpdater $dead
    Start-Sleep -Milliseconds 300
    [System.IO.File]::WriteAllText($lockPath, "$($dead.Id)", [System.Text.Encoding]::ASCII)
    $takeoverPath = "$lockPath.takeover"
    [System.IO.File]::WriteAllText($takeoverPath, "99999", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $takeoverPath).LastWriteTime = (Get-Date).AddMinutes(-2)
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $stale $ReleaseZip
    if ($code -eq 0) { Pass "update.ps1 took over the dead-pid lock and exited 0" } else { Fail "update.ps1 exited $code on a dead-pid lock (log: $logPath)" }
    $logStale = ""
    if (Test-Path -LiteralPath $logPath) { $logStale = Get-Content -LiteralPath $logPath -Raw }
    if ($logStale -match [regex]::Escape("Taking over an abandoned update lock (pid $($dead.Id))")) { Pass "log records the takeover" } else { Fail "no takeover line in the log" }
    if ($logStale -match "Removing a takeover marker left by a crashed updater") { Pass "log records removing the stale takeover marker" } else { Fail "no stale takeover marker line in the log" }
    $last = Get-LastLogLine
    if ($last -eq $wantOk) { Pass "takeover run ends with $wantOk" } else { Fail "takeover run last log line: $last" }
    if (Test-Path -LiteralPath $lockPath) { Fail "lock left behind after the takeover run" } else { Pass "lock released after the takeover run" }
    if (Test-Path -LiteralPath $takeoverPath) { Fail "takeover marker left behind after the takeover run" } else { Pass "takeover marker released after the takeover run" }

    # ---------- Case 5b: a fresh takeover marker means another updater is mid-takeover ----------
    $midTake = Join-Path $scratch "Application Data\mid-takeover\com.gaffer.panel"
    New-TestInstall $midTake
    [System.IO.File]::WriteAllText($lockPath, "$($dead.Id)", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($takeoverPath, "99999", [System.Text.Encoding]::ASCII)
    $beforeTree = Get-TreeHash $midTake
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $midTake $ReleaseZip
    if ($code -eq 3) { Pass "updater exited 3 while another one holds the takeover marker" } else { Fail "updater exited $code with a fresh takeover marker present, expected 3" }
    $logMid = ""
    if (Test-Path -LiteralPath $logPath) { $logMid = Get-Content -LiteralPath $logPath -Raw }
    if ($logMid -match "Another update is taking over the abandoned lock") { Pass "log records the takeover in progress" } else { Fail "no takeover-in-progress line in the log" }
    $holder = ""
    if (Test-Path -LiteralPath $lockPath) { $holder = (Get-Content -LiteralPath $lockPath -Raw).Trim() }
    if ((Test-Path -LiteralPath $takeoverPath) -and ($holder -eq "$($dead.Id)")) { Pass "fresh takeover marker and the lock left for their owner" } else { Fail "fresh takeover marker or lock was removed" }
    if ((Get-TreeHash $midTake) -eq $beforeTree) { Pass "mid-takeover run left the install untouched" } else { Fail "mid-takeover run modified the install" }
    Remove-Item -LiteralPath $lockPath, $takeoverPath -Force -ErrorAction SilentlyContinue

    # ---------- Case 5c: two updaters taking over the same stale lock yield one winner ----------
    # B reads the dead pid and stops at its gate (GAFFER_UPDATE_TEST_GATE)
    # before entering the takeover mutex. A then takes over and holds a fresh
    # lock. B, released, must re-read the pid inside the mutex, see it is no
    # longer the stale one, re-loop, find A's live lock and exit busy, never
    # deleting A's lock on its way out. Each racer's stdout is captured on
    # its own, so the exact rejection path is asserted: the mutex was free,
    # so B is not rejected by the takeover-in-progress check.
    $raceA = Join-Path $scratch "Application Data\race-a\com.gaffer.panel"
    $raceB = Join-Path $scratch "Application Data\race-b\com.gaffer.panel"
    New-TestInstall $raceA
    New-TestInstall $raceB
    $beforeTreeB = Get-TreeHash $raceB
    [System.IO.File]::WriteAllText($lockPath, "$($dead.Id)", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $lockPath).LastWriteTime = (Get-Date).AddMinutes(-2)
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $gateB = "$scratch\gate-b"
    Remove-Item -LiteralPath $gateB, "$gateB.ready" -Force -ErrorAction SilentlyContinue
    $pB = Start-Updater $raceB "$scratch\race-b.out" @{ GAFFER_UPDATE_TEST_GATE = $gateB }
    Wait-ForFile "$gateB.ready" | Out-Null
    $pA = Start-Updater $raceA "$scratch\race-a.out" @{}
    $aPid = ""
    for ($i = 0; $i -lt 300; $i++) {
        $aPid = Read-Lock
        if ($aPid -and $aPid -ne "$($dead.Id)" -and -not (Test-Path -LiteralPath $takeoverPath)) { break }
        Start-Sleep -Milliseconds 100
    }
    [System.IO.File]::WriteAllText($gateB, "go")
    $codeA = Wait-Updater $pA
    $codeB = Wait-Updater $pB
    $outA = Read-Out "$scratch\race-a.out"
    $outB = Read-Out "$scratch\race-b.out"
    if ($codeA -eq 0 -and $codeB -eq 3) { Pass "racing takeovers: the first exited 0, the gated one exited 3 (busy)" } else { Fail "racing takeovers exited A=$($codeA) B=$($codeB) (expected A=0, B=3)" }
    if ($outA -match [regex]::Escape("Taking over an abandoned update lock (pid $($dead.Id))")) { Pass "the first racing updater took over the dead-pid lock" } else { Fail "the first racing updater did not record the takeover" }
    if ($outB -match [regex]::Escape("The abandoned lock now belongs to pid $aPid, rechecking.")) { Pass "the gated updater was rejected by the pid re-read inside the mutex" } else { Fail "no re-read rejection line for pid $aPid in the gated updater's output: $outB" }
    if ($outB -match [regex]::Escape("Another update is already running (pid $aPid)")) { Pass "the gated updater then saw the winner's live lock" } else { Fail "the gated updater did not report the winner's live lock" }
    if ($outB -notmatch "Another update is taking over the abandoned lock") { Pass "the gated updater was not rejected by the takeover-in-progress check" } else { Fail "the gated updater was rejected by the takeover-in-progress check instead (wrong path)" }
    if ($outB -notmatch "Taking over an abandoned update lock") { Pass "the gated updater took nothing over" } else { Fail "the gated updater took over the winner's lock" }
    $gotA = Get-Content -LiteralPath (Join-Path $raceA "version.json") -Raw
    if ($gotA -eq $wantVersion) { Pass "the first racing updater installed the release" } else { Fail "the first racing updater did not install the release: $gotA" }
    if ((Get-TreeHash $raceB) -eq $beforeTreeB) { Pass "the gated racing updater left its install untouched" } else { Fail "the gated racing updater modified its install (it must not take over the winner's lock)" }
    if (Test-Path -LiteralPath $lockPath) { Fail "lock left behind after the racing takeovers" } else { Pass "lock released after the racing takeovers" }
    if (Test-Path -LiteralPath $takeoverPath) { Fail "takeover marker left behind after the racing takeovers" } else { Pass "no takeover marker left behind" }

    # ---------- Case 5d: two updaters clearing the same stale takeover marker yield one winner ----------
    # B judges the marker stale and stops at its marker gate. A then clears
    # it (an atomic rename), takes over the dead-pid lock and goes on. B,
    # released, must fail its own rename (the marker is gone), exit busy and
    # clear nothing.
    $mraceA = Join-Path $scratch "Application Data\marker-race-a\com.gaffer.panel"
    $mraceB = Join-Path $scratch "Application Data\marker-race-b\com.gaffer.panel"
    New-TestInstall $mraceA
    New-TestInstall $mraceB
    [System.IO.File]::WriteAllText($lockPath, "$($dead.Id)", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $lockPath).LastWriteTime = (Get-Date).AddMinutes(-2)
    [System.IO.File]::WriteAllText($takeoverPath, "99999", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $takeoverPath).LastWriteTime = (Get-Date).AddMinutes(-2)
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $mgateB = "$scratch\mgate-b"
    Remove-Item -LiteralPath $mgateB, "$mgateB.ready" -Force -ErrorAction SilentlyContinue
    $pB = Start-Updater $mraceB "$scratch\mrace-b.out" @{ GAFFER_UPDATE_TEST_MARKER_GATE = $mgateB }
    Wait-ForFile "$mgateB.ready" | Out-Null
    $pA = Start-Updater $mraceA "$scratch\mrace-a.out" @{}
    for ($i = 0; $i -lt 300; $i++) {
        $aPid = Read-Lock
        if ($aPid -and $aPid -ne "$($dead.Id)" -and -not (Test-Path -LiteralPath $takeoverPath)) { break }
        Start-Sleep -Milliseconds 100
    }
    [System.IO.File]::WriteAllText($mgateB, "go")
    $codeA = Wait-Updater $pA
    $codeB = Wait-Updater $pB
    $outA = Read-Out "$scratch\mrace-a.out"
    $outB = Read-Out "$scratch\mrace-b.out"
    if ($codeA -eq 0 -and $codeB -eq 3) { Pass "marker race: the first exited 0, the gated one exited 3 (busy)" } else { Fail "marker race exited A=$($codeA) B=$($codeB) (expected A=0, B=3)" }
    if ($outA -match "Removing a takeover marker left by a crashed updater") { Pass "the first updater cleared the stale marker" } else { Fail "the first updater did not clear the stale marker: $outA" }
    if ($outB -match "Another update cleared the stale takeover marker first") { Pass "the gated updater was rejected by its failed marker rename" } else { Fail "the gated updater was not rejected by the marker rename: $outB" }
    if ($outB -notmatch "Removing a takeover marker") { Pass "the gated updater cleared nothing" } else { Fail "the gated updater also cleared a marker" }
    if (Get-ChildItem -LiteralPath "$scratch\tmp" -Filter "gaffer-update.lock.takeover.stale.*" -ErrorAction SilentlyContinue) { Fail "renamed stale marker left behind" } else { Pass "no renamed stale marker left behind" }
    if ((Test-Path -LiteralPath $lockPath) -or (Test-Path -LiteralPath $takeoverPath)) { Fail "lock or marker left behind after the marker race" } else { Pass "lock and marker released after the marker race" }

    # ---------- Case 5e: a fresh marker renamed by mistake is put back ----------
    # B judges the stale marker stale and stops at its marker gate. The
    # marker is then replaced by a fresh one (another updater's). B,
    # released, renames that fresh marker, re-checks its age, puts it back
    # and exits busy, leaving the lock alone.
    $putBack = Join-Path $scratch "Application Data\put-back\com.gaffer.panel"
    New-TestInstall $putBack
    [System.IO.File]::WriteAllText($lockPath, "$($dead.Id)", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $lockPath).LastWriteTime = (Get-Date).AddMinutes(-2)
    [System.IO.File]::WriteAllText($takeoverPath, "99999", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $takeoverPath).LastWriteTime = (Get-Date).AddMinutes(-2)
    $beforeTree = Get-TreeHash $putBack
    $mgatePb = "$scratch\mgate-pb"
    Remove-Item -LiteralPath $mgatePb, "$mgatePb.ready" -Force -ErrorAction SilentlyContinue
    $pP = Start-Updater $putBack "$scratch\putback.out" @{ GAFFER_UPDATE_TEST_MARKER_GATE = $mgatePb }
    Wait-ForFile "$mgatePb.ready" | Out-Null
    Remove-Item -LiteralPath $takeoverPath -Force
    [System.IO.File]::WriteAllText($takeoverPath, "88888", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($mgatePb, "go")
    $codeP = Wait-Updater $pP
    $outP = Read-Out "$scratch\putback.out"
    if ($codeP -eq 3) { Pass "updater exited 3 after renaming a fresh marker by mistake" } else { Fail "updater exited $($codeP) after the fresh marker, expected 3: $outP" }
    if ($outP -match [regex]::Escape("The takeover marker was renewed by another update meanwhile, putting it back.")) { Pass "log records the put-back" } else { Fail "no put-back line: $outP" }
    $markerNow = ""
    if (Test-Path -LiteralPath $takeoverPath) { $markerNow = (Get-Content -LiteralPath $takeoverPath -Raw).Trim() }
    if ($markerNow -eq "88888") { Pass "the fresh marker is back in place with its owner's pid" } else { Fail "the fresh marker was not put back (now: '$markerNow')" }
    if (Get-ChildItem -LiteralPath "$scratch\tmp" -Filter "gaffer-update.lock.takeover.stale.*" -ErrorAction SilentlyContinue) { Fail "renamed marker left behind after the put-back" } else { Pass "no renamed marker left behind after the put-back" }
    if ((Read-Lock) -eq "$($dead.Id)") { Pass "the put-back run left the lock alone" } else { Fail "the put-back run removed or rewrote the lock" }
    if ((Get-TreeHash $putBack) -eq $beforeTree) { Pass "the put-back run left the install untouched" } else { Fail "the put-back run modified the install" }
    Remove-Item -LiteralPath $lockPath, $takeoverPath -Force -ErrorAction SilentlyContinue

    # ---------- Case 6: a lock older than the stuck age is taken over even with a live pid ----------
    # The holder, its child and its grandchild must all be stopped, found
    # through Win32_Process, not taskkill /T. The lock ages for real past
    # the lowered stuck age, so the holder (started earlier) predates it.
    $oldLock = Join-Path $scratch "Application Data\old-lock\com.gaffer.panel"
    New-TestInstall $oldLock
    $fake = Start-FakeUpdater
    Start-Sleep -Seconds 1
    [System.IO.File]::WriteAllText($lockPath, "$($fake.Id)", [System.Text.Encoding]::ASCII)
    Wait-LockPastStuck
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $oldLock $ReleaseZip @{ GAFFER_UPDATE_TEST_STUCK_AFTER = "$stuckAfter" }
    if ($code -eq 0) { Pass "update.ps1 took over the stuck holder's lock and exited 0" } else { Fail "update.ps1 exited $code on the stuck holder's lock (log: $logPath)" }
    if (Test-Path -LiteralPath $lockPath) { Fail "lock left behind after the old-lock run" } else { Pass "lock released after the old-lock run" }
    $logOld = ""
    if (Test-Path -LiteralPath $logPath) { $logOld = Get-Content -LiteralPath $logPath -Raw }
    if ($logOld -match [regex]::Escape("Stopping an update that has run for over 15 minutes (pid $($fake.Id))")) { Pass "log records stopping the stuck holder" } else { Fail "no stop line for the stuck holder in the log" }
    if ($logOld -match "stopping the stuck update and its (\d+) descendant process\(es\)" -and [int] $Matches[1] -ge 2) { Pass "descendants were enumerated through Win32_Process ($($Matches[1]) found)" } else { Fail "no descendant enumeration line (or fewer than 2 found) in the log" }
    if ($logOld -notmatch "using taskkill /T") { Pass "taskkill /T fallback was not needed" } else { Fail "the taskkill /T fallback ran" }
    if (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue) { Fail "stuck holder (pid $($fake.Id)) is still alive after the takeover" } else { Pass "stuck holder was stopped before the takeover" }
    # The holder's child (its curl.exe, robocopy or runtime step) and grandchild must go with it, not be orphaned.
    $childId = Get-FakeUpdaterChildId
    $grandchildId = Get-FakeUpdaterGrandchildId
    if ($childId -gt 0 -and -not (Get-Process -Id $childId -ErrorAction SilentlyContinue)) { Pass "stuck holder's child (pid $childId) was stopped too" } else { Fail "stuck holder's child (pid $childId) is still alive after the takeover" }
    if ($grandchildId -gt 0 -and -not (Get-Process -Id $grandchildId -ErrorAction SilentlyContinue)) { Pass "stuck holder's grandchild (pid $grandchildId) was stopped too" } else { Fail "stuck holder's grandchild (pid $grandchildId) is still alive after the takeover" }
    Stop-FakeUpdater $fake
    $fake = $null

    # ---------- Case 6e: a hand-run holder (process name only) past the stuck age is never stopped ----------
    # An update run as ".\update.ps1" inside an open PowerShell carries that
    # window's pid and leaves no update.ps1 in its command line. Past the
    # stuck age it must not be force-stopped (that would end the person's
    # terminal and everything started from it): the run reports it, ends
    # with err:lock, touches nothing and leaves the lock in place.
    $handRun = Join-Path $scratch "Application Data\hand-run\com.gaffer.panel"
    New-TestInstall $handRun
    $window = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 300") -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 1
    $windowCmd = ""
    try { $windowCmd = "$((Get-CimInstance Win32_Process -Filter "ProcessId = $($window.Id)").CommandLine)" } catch {}
    if ($windowCmd -notmatch "update\.ps1" -and $windowCmd -match "powershell") { Pass "hand-run holder's command line names no update.ps1" } else { Fail "hand-run holder's command line is: $windowCmd" }
    [System.IO.File]::WriteAllText($lockPath, "$($window.Id)", [System.Text.Encoding]::ASCII)
    Wait-LockPastStuck
    $beforeTree = Get-TreeHash $handRun
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $handRun $ReleaseZip @{ GAFFER_UPDATE_TEST_STUCK_AFTER = "$stuckAfter" }
    if ($code -eq 1) { Pass "updater exited 1 against a stuck hand-run holder" } else { Fail "updater exited $code against a stuck hand-run holder, expected 1" }
    $last = Get-LastLogLine
    if ($last -eq "err:lock") { Pass "stuck hand-run holder run ends with err:lock" } else { Fail "stuck hand-run holder run last log line: $last" }
    $logHand = ""
    if (Test-Path -LiteralPath $logPath) { $logHand = Get-Content -LiteralPath $logPath -Raw }
    if ($logHand -match [regex]::Escape("An update started by hand in PowerShell (pid $($window.Id)) has held the lock for over 15 minutes. Close that window or press Ctrl+C in it.")) { Pass "log explains the hand-run holder" } else { Fail "no hand-run explanation in the log" }
    if ($logHand -notmatch "Stopping an update") { Pass "no stop was attempted on the hand-run holder" } else { Fail "a stop was attempted on the hand-run holder" }
    if (Get-Process -Id $window.Id -ErrorAction SilentlyContinue) { Pass "hand-run holder (pid $($window.Id)) is still alive" } else { Fail "hand-run holder was killed" }
    if ((Read-Lock) -eq "$($window.Id)") { Pass "hand-run holder's lock was left in place" } else { Fail "hand-run holder's lock was removed or rewritten (now: '$(Read-Lock)')" }
    if ((Get-TreeHash $handRun) -eq $beforeTree) { Pass "hand-run holder run left the install untouched" } else { Fail "hand-run holder run modified the install" }
    Stop-Process -Id $window.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue

    # ---------- Case 6f: a failed descendant listing goes through taskkill /T while the holder is alive ----------
    # GAFFER_UPDATE_TEST_FAIL_LIST makes the first listing fail; taskkill /T
    # needs the live tree (it follows parent pids), so it must run before
    # the holder is stopped, and the whole tree must still be gone after.
    $failList = Join-Path $scratch "Application Data\fail-list\com.gaffer.panel"
    New-TestInstall $failList
    $fake = Start-FakeUpdater
    Start-Sleep -Seconds 1
    [System.IO.File]::WriteAllText($lockPath, "$($fake.Id)", [System.Text.Encoding]::ASCII)
    Wait-LockPastStuck
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $failList $ReleaseZip @{ GAFFER_UPDATE_TEST_STUCK_AFTER = "$stuckAfter"; GAFFER_UPDATE_TEST_FAIL_LIST = "1" }
    if ($code -eq 0) { Pass "update.ps1 took over the stuck holder's lock through the taskkill path and exited 0" } else { Fail "update.ps1 exited $code on the taskkill path (log: $logPath)" }
    $logFail = ""
    if (Test-Path -LiteralPath $logPath) { $logFail = Get-Content -LiteralPath $logPath -Raw }
    if ($logFail -match "could not list the stuck update's processes, using taskkill /T") { Pass "the failed listing was logged and taskkill /T ran" } else { Fail "no taskkill fallback line in the log" }
    if ($logFail -notmatch "descendant process\(es\)") { Pass "no Win32_Process stop ran after the failed listing" } else { Fail "a Win32_Process stop ran next to the taskkill path" }
    if (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue) { Fail "stuck holder (pid $($fake.Id)) survived the taskkill path" } else { Pass "taskkill path stopped the stuck holder" }
    $childId = Get-FakeUpdaterChildId
    $grandchildId = Get-FakeUpdaterGrandchildId
    if ($childId -gt 0 -and -not (Get-Process -Id $childId -ErrorAction SilentlyContinue)) { Pass "taskkill path stopped the holder's child (pid $childId)" } else { Fail "holder's child (pid $childId) survived the taskkill path" }
    if ($grandchildId -gt 0 -and -not (Get-Process -Id $grandchildId -ErrorAction SilentlyContinue)) { Pass "taskkill path stopped the holder's grandchild (pid $grandchildId)" } else { Fail "holder's grandchild (pid $grandchildId) survived the taskkill path" }
    if (Test-Path -LiteralPath $lockPath) { Fail "lock left behind after the taskkill-path run" } else { Pass "lock released after the taskkill-path run" }
    Stop-FakeUpdater $fake
    $fake = $null

    # ---------- Case 6g: a holder on this updater's own parent chain is refused ----------
    # A wrapper PowerShell whose command line names update.ps1 (so it would
    # otherwise be stoppable) holds the lock and runs the updater as its
    # child. The updater must recognise its own parent and refuse with
    # err:lock instead of stopping it (which would stop the updater too).
    $parentCase = Join-Path $scratch "Application Data\parent-holder\com.gaffer.panel"
    New-TestInstall $parentCase
    New-Item -ItemType Directory -Path "$scratch\wrap\daemon" -Force | Out-Null
    $wrapGo = "$scratch\wrap\go"
    $wrapOut = "$scratch\wrap\updater.out"
    Remove-Item -LiteralPath $wrapGo, $wrapOut -Force -ErrorAction SilentlyContinue
    $wrapBody = @(
        "for (`$i = 0; `$i -lt 600; `$i++) { if (Test-Path -LiteralPath '$wrapGo') { break }; Start-Sleep -Milliseconds 100 }",
        "& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$parentCase\daemon\update.ps1' *> '$wrapOut'",
        'exit $LASTEXITCODE'
    )
    Set-Content -LiteralPath "$scratch\wrap\daemon\update.ps1" -Value ($wrapBody -join "`r`n")
    $env:GAFFER_UPDATE_ASSET = $ReleaseZip
    $env:TEMP = "$scratch\tmp"
    $env:GAFFER_UPDATE_TEST_STUCK_AFTER = "$stuckAfter"
    try {
        $wrapper = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$scratch\wrap\daemon\update.ps1") -WindowStyle Hidden -PassThru
        $null = $wrapper.Handle
    } finally { Remove-Item Env:\GAFFER_UPDATE_TEST_STUCK_AFTER -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    [System.IO.File]::WriteAllText($lockPath, "$($wrapper.Id)", [System.Text.Encoding]::ASCII)
    Wait-LockPastStuck
    $beforeTree = Get-TreeHash $parentCase
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    [System.IO.File]::WriteAllText($wrapGo, "go")
    $codeW = Wait-Updater $wrapper
    $outW = Read-Out $wrapOut
    if ($codeW -eq 1) { Pass "updater exited 1 when its own parent held the lock (the parent lived to report it)" } else { Fail "updater run under its lock-holding parent exited $($codeW), expected 1: $outW" }
    if ($outW -match [regex]::Escape("This update was started from the terminal that holds the lock. Close that window and try again.")) { Pass "log explains the parent-chain refusal" } else { Fail "no parent-chain refusal line: $outW" }
    $last = Get-LastLogLine
    if ($last -eq "err:lock") { Pass "parent-chain refusal ends with err:lock" } else { Fail "parent-chain refusal last log line: $last" }
    if ($outW -notmatch "Stopping an update") { Pass "no stop was attempted on the updater's own parent" } else { Fail "a stop was attempted on the updater's own parent" }
    if ((Read-Lock) -eq "$($wrapper.Id)") { Pass "the parent's lock was left in place" } else { Fail "the parent's lock was removed or rewritten (now: '$(Read-Lock)')" }
    if ((Get-TreeHash $parentCase) -eq $beforeTree) { Pass "parent-chain refusal left the install untouched" } else { Fail "parent-chain refusal modified the install" }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue

    # ---------- Case 6h: the stuck-age knob is ignored unless the harness really set it ----------
    # Same staging as case 6 (live script-named holder, lock aged past 3 s),
    # but the knob must NOT bite: without GAFFER_UPDATE_ASSET (a stray
    # variable in a real environment), at 0, and at a value too big for an
    # integer (which must not throw). Each run exits busy, holder alive.
    $knob = Join-Path $scratch "Application Data\knob\com.gaffer.panel"
    New-TestInstall $knob
    $fake = Start-FakeUpdater
    Start-Sleep -Seconds 1
    [System.IO.File]::WriteAllText($lockPath, "$($fake.Id)", [System.Text.Encoding]::ASCII)
    Wait-LockPastStuck
    foreach ($case in @(@{ Name = "no-asset:$stuckAfter"; Value = "$stuckAfter"; NoAsset = $true }, @{ Name = "asset:0"; Value = "0"; NoAsset = $false }, @{ Name = "asset:huge"; Value = "99999999999999999999999"; NoAsset = $false })) {
        Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
        if ($case.NoAsset) {
            $code = Invoke-Update $knob $ReleaseZip @{ GAFFER_UPDATE_TEST_STUCK_AFTER = $case.Value } -NoAsset
        } else {
            $code = Invoke-Update $knob $ReleaseZip @{ GAFFER_UPDATE_TEST_STUCK_AFTER = $case.Value }
        }
        if ($code -eq 3) { Pass "knob $($case.Name): updater exited 3 (busy), the knob was ignored" } else { Fail "knob $($case.Name): updater exited $code, expected 3 (log: $logPath)" }
        $last = Get-LastLogLine
        if ($last -eq "busy:already-running") { Pass "knob $($case.Name): log ends with busy:already-running" } else { Fail "knob $($case.Name): last log line: $last" }
        if (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue) { Pass "knob $($case.Name): the live holder (pid $($fake.Id)) was left alone" } else { Fail "knob $($case.Name): the live holder was stopped" }
    }
    if ((Read-Lock) -eq "$($fake.Id)") { Pass "knob runs left the live lock in place" } else { Fail "knob runs removed or rewrote the live lock" }
    Stop-FakeUpdater $fake
    $fake = $null
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue

    # ---------- Case 6b: a stuck holder that vanished just before the stop is not signalled ----------
    # The updater reads the live holder, stops at its gate; the holder exits
    # meanwhile; the re-read inside the mutex must find it gone and skip the
    # stop (a pid reused by an unrelated process would otherwise be killed).
    $gone = Join-Path $scratch "Application Data\gone-holder\com.gaffer.panel"
    New-TestInstall $gone
    $fake = Start-FakeUpdater
    Start-Sleep -Seconds 1
    [System.IO.File]::WriteAllText($lockPath, "$($fake.Id)", [System.Text.Encoding]::ASCII)
    Wait-LockPastStuck
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $gateGone = "$scratch\gate-gone"
    Remove-Item -LiteralPath $gateGone, "$gateGone.ready" -Force -ErrorAction SilentlyContinue
    $pG = Start-Updater $gone "$scratch\gone.out" @{ GAFFER_UPDATE_TEST_GATE = $gateGone; GAFFER_UPDATE_TEST_STUCK_AFTER = "$stuckAfter" }
    Wait-ForFile "$gateGone.ready" | Out-Null
    Stop-FakeUpdater $fake
    $goneId = $fake.Id
    $fake = $null
    Start-Sleep -Milliseconds 500
    [System.IO.File]::WriteAllText($gateGone, "go")
    $codeG = Wait-Updater $pG
    $outG = Read-Out "$scratch\gone.out"
    if ($codeG -eq 0) { Pass "update.ps1 took over the lock of a holder that vanished at the gate" } else { Fail "update.ps1 exited $($codeG) after the holder vanished: $outG" }
    if ($outG -match [regex]::Escape("The stuck update (pid $goneId) is already gone, not stopping it.")) { Pass "log records that the vanished holder was not signalled" } else { Fail "no 'already gone' line for the vanished holder: $outG" }
    if ($outG -notmatch "Stopping an update that has run for over 15 minutes") { Pass "no stop was attempted on the vanished holder" } else { Fail "update.ps1 tried to stop a holder that was already gone" }
    if (Test-Path -LiteralPath $lockPath) { Fail "lock left behind after the vanished-holder run" } else { Pass "lock released after the vanished-holder run" }

    # ---------- Case 6c: a lock dated in the future (clock moved back) with a LIVE holder is busy ----------
    # A clock step, w32time or a network TEMP can date a healthy updater's
    # lock in the future. Its holder is alive and a plausible updater, so
    # the lock is busy and the holder must not be stopped: a negative age
    # alone never kills.
    $future = Join-Path $scratch "Application Data\future-lock\com.gaffer.panel"
    New-TestInstall $future
    $fake = Start-FakeUpdater
    Start-Sleep -Seconds 1
    [System.IO.File]::WriteAllText($lockPath, "$($fake.Id)", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $lockPath).LastWriteTime = (Get-Date).AddDays(1)
    $beforeTree = Get-TreeHash $future
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $future $ReleaseZip
    if ($code -eq 3) { Pass "updater exited 3 on a future-dated lock with a live holder" } else { Fail "updater exited $code on a future-dated lock with a live holder, expected 3" }
    $logFuture = ""
    if (Test-Path -LiteralPath $logPath) { $logFuture = Get-Content -LiteralPath $logPath -Raw }
    if ($logFuture -match [regex]::Escape("Another update is already running (pid $($fake.Id))")) { Pass "future-dated lock's live holder was reported as running" } else { Fail "future-dated lock's live holder was not reported as running" }
    if ($logFuture -notmatch "Stopping an update") { Pass "no stop was attempted on the future-dated lock's live holder" } else { Fail "future-dated lock's live holder was stopped on the negative age alone" }
    if (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue) { Pass "future-dated lock's live holder (pid $($fake.Id)) is still alive" } else { Fail "future-dated lock's live holder was killed" }
    if ((Read-Lock) -eq "$($fake.Id)") { Pass "future-dated live lock kept its holder's pid" } else { Fail "future-dated live lock was removed or rewritten" }
    if ((Get-TreeHash $future) -eq $beforeTree) { Pass "future-dated live-lock run left the install untouched" } else { Fail "future-dated live-lock run modified the install" }
    Stop-FakeUpdater $fake
    $fake = $null
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue

    # ---------- Case 6d: a lock and marker dated in the future with a DEAD pid are stale ----------
    # Nothing alive holds them, and a write time over 300 s ahead cannot be
    # fresh: both are leftovers from before the clock moved back.
    $futureDead = Join-Path $scratch "Application Data\future-dead\com.gaffer.panel"
    New-TestInstall $futureDead
    [System.IO.File]::WriteAllText($lockPath, "$($dead.Id)", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $lockPath).LastWriteTime = (Get-Date).AddDays(1)
    [System.IO.File]::WriteAllText($takeoverPath, "99999", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $takeoverPath).LastWriteTime = (Get-Date).AddDays(1)
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $futureDead $ReleaseZip
    if ($code -eq 0) { Pass "update.ps1 took over the future-dated dead-pid lock and exited 0" } else { Fail "update.ps1 exited $code on a future-dated dead-pid lock (log: $logPath)" }
    $logFutureDead = ""
    if (Test-Path -LiteralPath $logPath) { $logFutureDead = Get-Content -LiteralPath $logPath -Raw }
    if ($logFutureDead -match [regex]::Escape("Taking over an abandoned update lock (pid $($dead.Id))")) { Pass "future-dated dead-pid lock was taken over" } else { Fail "no takeover line for the future-dated dead-pid lock" }
    if ($logFutureDead -match "Removing a takeover marker dated in the future") { Pass "future-dated takeover marker was cleared" } else { Fail "future-dated takeover marker was not cleared" }
    if ((Test-Path -LiteralPath $lockPath) -or (Test-Path -LiteralPath $takeoverPath)) { Fail "lock or marker left behind after the future-dated run" } else { Pass "lock and marker released after the future-dated run" }

    # ---------- Case 7: a seconds-old lock file with no pid in it is busy, a minutes-old one is abandoned ----------
    # An updater between its CreateNew and its pid write looks like the
    # first. Also the regression case for the lock acquisition itself: with
    # the lock file present, the CreateNew failure must land in the catch,
    # not end the script (a leftover file would then block every later
    # update).
    $noPid = Join-Path $scratch "Application Data\no-pid\com.gaffer.panel"
    New-TestInstall $noPid
    [System.IO.File]::WriteAllText($lockPath, "not-a-pid", [System.Text.Encoding]::ASCII)
    $beforeTree = Get-TreeHash $noPid
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $noPid $ReleaseZip
    if ($code -eq 3) { Pass "updater exited 3 on a seconds-old lock without a pid" } else { Fail "updater exited $code on a seconds-old lock without a pid, expected 3" }
    $last = Get-LastLogLine
    if ($last -eq "busy:already-running") { Pass "young pid-less lock run ends with busy:already-running" } else { Fail "young pid-less lock run last log line: $last" }
    if ((Read-Lock) -eq "not-a-pid") { Pass "young pid-less lock left in place for its owner" } else { Fail "young pid-less lock was removed or rewritten" }
    if ((Get-TreeHash $noPid) -eq $beforeTree) { Pass "young pid-less lock run left the install untouched" } else { Fail "young pid-less lock run modified the install" }
    (Get-Item -LiteralPath $lockPath).LastWriteTime = (Get-Date).AddMinutes(-2)
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $noPid $ReleaseZip
    if ($code -eq 0) { Pass "update.ps1 took over the pid-less lock and exited 0" } else { Fail "update.ps1 exited $code on a pid-less lock (log: $logPath)" }
    $logNoPid = ""
    if (Test-Path -LiteralPath $logPath) { $logNoPid = Get-Content -LiteralPath $logPath -Raw }
    if ($logNoPid -match [regex]::Escape("Taking over an abandoned update lock (pid not-a-pid)")) { Pass "log records the pid-less takeover" } else { Fail "no pid-less takeover line in the log" }
    if (Test-Path -LiteralPath $lockPath) { Fail "lock left behind after the pid-less takeover" } else { Pass "lock released after the pid-less takeover" }

    # ---------- Case 8: the dev-install refusal still ends the log with err:dev-install ----------
    $dev = Join-Path $scratch "dev-checkout\panel"
    New-TestInstall $dev
    New-Item -ItemType Directory -Path (Join-Path $scratch "dev-checkout\.git") -Force | Out-Null
    $beforeTree = Get-TreeHash $dev
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $dev $ReleaseZip
    if ($code -ne 0) { Pass "update.ps1 refused a dev install" } else { Fail "update.ps1 exited 0 on a dev install" }
    $last = Get-LastLogLine
    if ($last -eq "err:dev-install") { Pass "log ends with err:dev-install" } else { Fail "last log line is not err:dev-install: $last" }
    if ((Get-TreeHash $dev) -eq $beforeTree) { Pass "dev install left untouched" } else { Fail "dev install was modified" }
    if (Test-Path -LiteralPath $lockPath) { Fail "lock left behind after the dev-install refusal" } else { Pass "lock released after the dev-install refusal" }

    # ---------- Case 9: an updater whose lock was replaced under it leaves the replacement alone ----------
    # A holds the lock and stops at its hold gate; the lock file is then
    # rewritten with another updater's pid (as a takeover would); A is
    # released and exits (a broken asset ends it quickly). A's finally must
    # leave the lock, now someone else's, in place.
    $hold = Join-Path $scratch "Application Data\hold-lock\com.gaffer.panel"
    New-TestInstall $hold
    $gateHold = "$scratch\gate-hold"
    Remove-Item -LiteralPath $gateHold, "$gateHold.ready" -Force -ErrorAction SilentlyContinue
    $pH = Start-Updater $hold "$scratch\hold.out" @{ GAFFER_UPDATE_TEST_HOLD_GATE = $gateHold; GAFFER_UPDATE_ASSET = $notZip }
    Wait-ForFile "$gateHold.ready" | Out-Null
    $holdPid = Read-Lock
    [System.IO.File]::WriteAllText($lockPath, "424242", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($gateHold, "go")
    $codeH = Wait-Updater $pH
    if ($holdPid -and $holdPid -ne "424242") { Pass "updater A held the lock at its gate (pid $holdPid)" } else { Fail "updater A did not hold the lock at its gate (lock read: '$holdPid')" }
    if ($codeH -ne 0) { Pass "updater A exited (non-zero, broken asset) after its lock was replaced" } else { Fail "updater A exited 0 on a broken asset" }
    if ((Test-Path -LiteralPath $lockPath) -and ((Read-Lock) -eq "424242")) { Pass "A's exit left the replacement lock (pid 424242) in place" } else { Fail "A's exit removed or rewrote the replacement lock (now: '$(Read-Lock)')" }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
} finally {
    if ($fake) { Stop-FakeUpdater $fake }
    foreach ($p in @($window, $wrapper)) { if ($p -and (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
    $env:TEMP = $realTemp
    Remove-Item Env:\GAFFER_UPDATE_ASSET -ErrorAction SilentlyContinue
    Remove-Item Env:\GAFFER_UPDATE_CURL -ErrorAction SilentlyContinue
    foreach ($v in @("GAFFER_FETCH_TEST", "GAFFER_FETCH_PINS", "GAFFER_FETCH_PLATFORM", "GAFFER_FETCH_BASE_OFFICIAL", "GAFFER_FETCH_BASE_MIRROR", "GAFFER_FETCH_SKIP_CODESIGN")) { Remove-Item "Env:\$v" -ErrorAction SilentlyContinue }
    foreach ($g in @("GAFFER_UPDATE_TEST_GATE", "GAFFER_UPDATE_TEST_MARKER_GATE", "GAFFER_UPDATE_TEST_HOLD_GATE", "GAFFER_UPDATE_TEST_STUCK_AFTER", "GAFFER_UPDATE_TEST_FAIL_LIST")) { Remove-Item "Env:\$g" -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:fails -eq 0) { Write-Host "ALL PASS"; exit 0 } else { Write-Host "$($script:fails) FAILURE(S)"; exit 1 }
