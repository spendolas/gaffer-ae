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
# changed. Cases 4 to 8 cover the single-updater lock: a second updater exits
# busy while a live one holds the lock, an abandoned lock (dead pid, or a
# file with no pid in it) is taken over, a live holder older than 15 minutes
# is stopped and taken over, the lock is gone after every run, and the
# dev-install refusal still ends the log with err:dev-install.
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
# A long-lived process whose command line contains "update.ps1", which is
# what the lock's liveness check looks for. Returns the process.
function Start-FakeUpdater {
    New-Item -ItemType Directory -Path "$scratch\fake" -Force | Out-Null
    Set-Content -LiteralPath "$scratch\fake\update.ps1" -Value 'Start-Sleep -Seconds 300'
    return Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$scratch\fake\update.ps1") -WindowStyle Hidden -PassThru
}
$fake = $null

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

    # ---------- Case 3: a 404 URL changes nothing (exercises the URL branch) ----------
    # Cases 1 and 2 hand update.ps1 a local file. Real users always hit the
    # URL branch: Test-Path must treat "https://..." as not-a-file without
    # raising, and Invoke-WebRequest's 404 must land in the catch. Needs
    # internet access, like the npm install in Case 1.
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
    Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue
    $fake.WaitForExit(5000) | Out-Null
    $fake = $null
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue

    # ---------- Case 5: an abandoned lock (dead pid) is taken over ----------
    $stale = Join-Path $scratch "Application Data\stale\com.gaffer.panel"
    New-TestInstall $stale
    $dead = Start-FakeUpdater
    Stop-Process -Id $dead.Id -Force -ErrorAction SilentlyContinue
    $dead.WaitForExit(5000) | Out-Null
    Start-Sleep -Milliseconds 300
    [System.IO.File]::WriteAllText($lockPath, "$($dead.Id)", [System.Text.Encoding]::ASCII)
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $stale $ReleaseZip
    if ($code -eq 0) { Pass "update.ps1 took over the dead-pid lock and exited 0" } else { Fail "update.ps1 exited $code on a dead-pid lock (log: $logPath)" }
    $logStale = ""
    if (Test-Path -LiteralPath $logPath) { $logStale = Get-Content -LiteralPath $logPath -Raw }
    if ($logStale -match [regex]::Escape("Taking over an abandoned update lock (pid $($dead.Id))")) { Pass "log records the takeover" } else { Fail "no takeover line in the log" }
    $last = Get-LastLogLine
    if ($last -eq $wantOk) { Pass "takeover run ends with $wantOk" } else { Fail "takeover run last log line: $last" }
    if (Test-Path -LiteralPath $lockPath) { Fail "lock left behind after the takeover run" } else { Pass "lock released after the takeover run" }

    # ---------- Case 6: a lock older than 15 minutes is taken over even with a live pid ----------
    $oldLock = Join-Path $scratch "Application Data\old-lock\com.gaffer.panel"
    New-TestInstall $oldLock
    $fake = Start-FakeUpdater
    Start-Sleep -Seconds 1
    [System.IO.File]::WriteAllText($lockPath, "$($fake.Id)", [System.Text.Encoding]::ASCII)
    (Get-Item -LiteralPath $lockPath).LastWriteTime = (Get-Date).AddMinutes(-20)
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $code = Invoke-Update $oldLock $ReleaseZip
    if ($code -eq 0) { Pass "update.ps1 took over the 20 minute old lock and exited 0" } else { Fail "update.ps1 exited $code on a 20 minute old lock (log: $logPath)" }
    if (Test-Path -LiteralPath $lockPath) { Fail "lock left behind after the old-lock run" } else { Pass "lock released after the old-lock run" }
    $logOld = ""
    if (Test-Path -LiteralPath $logPath) { $logOld = Get-Content -LiteralPath $logPath -Raw }
    if ($logOld -match [regex]::Escape("Stopping an update that has run for over 15 minutes (pid $($fake.Id))")) { Pass "log records stopping the stuck holder" } else { Fail "no stop line for the stuck holder in the log" }
    if (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue) { Fail "stuck holder (pid $($fake.Id)) is still alive after the takeover" } else { Pass "stuck holder was stopped before the takeover" }
    Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue
    $fake.WaitForExit(5000) | Out-Null
    $fake = $null

    # ---------- Case 7: a lock file with no pid in it is abandoned ----------
    # Also the regression case for the lock acquisition itself: with the
    # lock file present, the CreateNew failure must land in the catch, not
    # end the script (a leftover file would then block every later update).
    $noPid = Join-Path $scratch "Application Data\no-pid\com.gaffer.panel"
    New-TestInstall $noPid
    [System.IO.File]::WriteAllText($lockPath, "not-a-pid", [System.Text.Encoding]::ASCII)
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
} finally {
    if ($fake) { Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue }
    $env:TEMP = $realTemp
    Remove-Item Env:\GAFFER_UPDATE_ASSET -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:fails -eq 0) { Write-Host "ALL PASS"; exit 0 } else { Write-Host "$($script:fails) FAILURE(S)"; exit 1 }
