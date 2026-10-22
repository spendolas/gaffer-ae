# Gaffer update script (Windows): downloads the latest GitHub release asset,
# stages the pinned Node runtime when the release needs a new one (with the
# archive's own fetch-runtime.ps1), replaces panel files, preserves user
# data, restarts daemon. No npm: the daemon is one bundled file (daemon.mjs)
# run by daemon\runtime\node.exe.
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
#   err:<code>              failed (err:dev-install, err:lock, err:download,
#                           err:sync, err:runtime) after an ERROR line
#                           (err:runtime before the swap: install untouched)
#   busy:already-running    another updater holds the lock; this one did nothing
# Exit codes: 0 ok, 1 failed, 3 busy.

# Single-updater lock. Two updaters interleaving (the panel's "Force stop &
# retry" after its 180s give-up, or a manual run next to the panel's) would
# robocopy over each other and corrupt the install, so the whole run holds
# $lockPath, a file created atomically (FileMode CreateNew) holding this PID.
# A lock whose PID is dead or is not a plausible updater (see
# Get-LockHolderProcess) is abandoned and taken over; a lock older than 15
# minutes whose holder is still a live updater is a stuck updater, which is
# stopped first (its whole process tree, not just the shell), then taken
# over, but ONLY when the holder's command line names update.ps1: a holder
# recognised by its process name alone may be a person's whole PowerShell
# window (an update run as ".\update.ps1" inside it carries that window's
# pid), and stopping it would take VS Code, After Effects or anything else
# started from that window down with it. Such a holder is busy while its
# lock is young and, once the lock is past the stuck age, is reported with
# err:lock and left alone; the same goes for a holder that is an ancestor of
# this very process. A lock under 30 seconds old with no readable pid
# belongs to an updater between its CreateNew and its pid write, and counts
# as busy.
#
# Clock safety: every age is UTC now minus the file's UTC write time, never
# local wall-clock (a DST fall-back would make a healthy lock read an hour
# in the future). The clock can still step (w32time, a VM resume, a network
# TEMP with its own clock), so a negative age up to 300 s is treated like
# age 0. Only a lock (or takeover marker) dated more than 300 s in the
# future is a leftover from before the clock moved backwards and counts as
# stale instead of fresh, and that shortcut only ever applies to a lock with
# no pid or a dead pid: a LIVE updater holder is never stopped on a negative
# age alone, its lock is busy until it is really over 15 minutes old.
#
# Takeovers are serialized by a second CreateNew file, $takeoverPath: only
# its holder may stop or remove a lock, and it re-reads the lock's pid inside
# the mutex and only removes the lock if that pid is still the one it judged
# stale. Without this, updater B (which read the stale pid a moment earlier)
# could remove updater A's fresh lock. The finally at the bottom, in turn,
# only deletes a lock whose file still holds THIS pid, so a losing updater
# can never delete the winner's lock on its way out. A takeover marker older
# than 60 seconds was left by a crashed updater; it is cleared by renaming it
# away (atomic, so of two updaters that both saw it stale exactly one clears
# it and goes on, the other exits busy) and only then re-created.
# panel\main.js reads the same lock to decide whether an updater is still
# running; keep the path in sync.
$lockPath = Join-Path $env:TEMP "gaffer-update.lock"
$takeoverPath = "$lockPath.takeover"
$script:haveLock = $false
$script:haveTakeover = $false
# A live holder whose lock is this old (seconds) is a stuck updater.
$stuckAfter = 900
# Test-only gates, set only by scripts\windows-tests\test-5-update-ps1.ps1
# to make the takeover races deterministic. Each names a file: the script
# writes "<file>.ready" when it reaches the gate, then waits (up to 60s)
# until <file> exists.
#   GAFFER_UPDATE_TEST_GATE         after reading a stale lock's pid, before
#                                   entering the takeover mutex
#   GAFFER_UPDATE_TEST_MARKER_GATE  after judging the takeover marker stale,
#                                   before renaming it away
#   GAFFER_UPDATE_TEST_HOLD_GATE    right after the lock is acquired
#   GAFFER_UPDATE_TEST_SWAP_GATE    between the two runtime renames (runtime
#                                   moved aside, runtime.new not yet in), so
#                                   the harness can kill an updater there
# GAFFER_UPDATE_TEST_STUCK_AFTER (whole seconds) lowers the 15 minute stuck
# age so the harness can stage a stuck holder that really is older than its
# lock (the pid-reuse guard below rejects a holder created after the lock,
# so a backdated lock can no longer stand in for a long run). Honoured only
# next to GAFFER_UPDATE_ASSET (the harness sets both, the panel sets
# neither), digits only, 1 to 86400; TryParse so a huge value cannot throw.
# GAFFER_UPDATE_TEST_FAIL_LIST (same gate, any value) makes the first
# descendant listing fail so the harness can exercise the taskkill path.
$stuckOverride = 0
if ($env:GAFFER_UPDATE_ASSET -and "$env:GAFFER_UPDATE_TEST_STUCK_AFTER" -match '^\d+$' -and
    [int]::TryParse($env:GAFFER_UPDATE_TEST_STUCK_AFTER, [ref] $stuckOverride) -and
    $stuckOverride -ge 1 -and $stuckOverride -le 86400) { $stuckAfter = $stuckOverride }
$script:testFailList = [bool] ($env:GAFFER_UPDATE_ASSET -and $env:GAFFER_UPDATE_TEST_FAIL_LIST)
# Seconds since the file was last written, UTC against UTC.
function Get-FileAgeSeconds($item) { return ([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalSeconds }
function Wait-TestGate([string] $gate) {
    if (-not $gate) { return }
    try { [System.IO.File]::WriteAllText("$gate.ready", "$PID") } catch {}
    for ($i = 0; $i -lt 600; $i++) {
        if (Test-Path -LiteralPath $gate) { return }
        Start-Sleep -Milliseconds 100
    }
}

# The Win32_Process of a live, plausible updater holding the lock, or $null.
# A process is a plausible holder when it is a PowerShell (powershell.exe or
# pwsh.exe) that was created no later than 5 s after the lock was written.
# The panel spawns the script as daemon\update.ps1, its ExtendScript
# fallback as daemon/update.ps1, but a person who runs ".\update.ps1" inside
# an interactive PowerShell leaves no script path in the process's command
# line at all, so the command line cannot be required. Whether the command
# line names update.ps1 is recorded separately (Stoppable): only such a
# holder is ever stopped as stuck, a name-only holder may be the person's
# whole PowerShell window. The creation time is what rules out pid reuse:
# Windows hands a dead process's pid to a new one quickly, and that new
# process was necessarily created AFTER the dead updater wrote the lock, so
# it fails the test whatever its name. The 5 s slack covers the two
# timestamps' granularity; the comparison is UTC against UTC.
# A lock written more than 5 s in the FUTURE means the clock moved since it
# was written and the creation-time comparison means nothing: any live
# process with that pid is then a holder (busy), and never Stoppable; only
# the dead-pid and no-pid shortcuts take such a lock over.
# This very process never counts as a holder (a lock carrying our own pid is
# a leftover from a pid reuse).
# When the process query itself fails (WMI down, a timeout), nothing can be
# verified: if Get-Process still sees the pid, the lock is reported busy
# (Unverified), never abandoned, since a wrong "abandoned" would start a
# second updater next to a live one.
function Get-LockHolderProcess([string] $holder, [DateTime] $lockWrittenUtc) {
    $holderPid = 0
    if (-not [int]::TryParse($holder, [ref] $holderPid) -or $holderPid -le 0) { return $null }
    if ($holderPid -eq $PID) { return $null }
    $proc = $null
    $queryFailed = $false
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $holderPid" -OperationTimeoutSec 15 -ErrorAction Stop
    } catch {
        $queryFailed = $true
    }
    if ($queryFailed) {
        if (Get-Process -Id $holderPid -ErrorAction SilentlyContinue) {
            return [pscustomobject] @{ ProcessId = $holderPid; CreationDate = $null; Unverified = $true; Stoppable = $false }
        }
        return $null
    }
    if (-not $proc) { return $null }
    $lockUtc = $lockWrittenUtc.ToUniversalTime()
    $lockAhead = (($lockUtc - [DateTime]::UtcNow).TotalSeconds -gt 5)
    $nameOk = ("$($proc.Name)" -match '^(powershell|pwsh)\.exe$')
    $scriptOk = ("$($proc.CommandLine)" -match '(^|[\\/\s"''])update\.ps1')
    if ($lockAhead) {
        return [pscustomobject] @{ ProcessId = $holderPid; CreationDate = $proc.CreationDate; Unverified = $false; Stoppable = $false }
    }
    if (-not ($nameOk -or $scriptOk)) { return $null }
    if (-not $proc.CreationDate) { return $null }
    $createdUtc = ([DateTime] $proc.CreationDate).ToUniversalTime()
    if ($createdUtc -gt $lockUtc.AddSeconds(5)) { return $null }
    return [pscustomobject] @{ ProcessId = $holderPid; CreationDate = $proc.CreationDate; Unverified = $false; Stoppable = $scriptOk }
}

# The holder $proc, re-read right now: "same" (same pid, same creation
# time), "gone" (exited, or the pid now belongs to something else) or
# "unverified" (the process query failed while the pid is alive; nothing
# may be concluded, least of all "gone").
function Get-LockHolderState($proc, [DateTime] $lockWrittenUtc) {
    if (-not $proc) { return "gone" }
    $now = Get-LockHolderProcess "$($proc.ProcessId)" $lockWrittenUtc
    if (-not $now) { return "gone" }
    if ($now.Unverified) { return "unverified" }
    if ("$($now.CreationDate)" -eq "$($proc.CreationDate)") { return "same" }
    return "gone"
}

# The pids above this process: its parent, the parent's parent and so on,
# from Win32_Process. The walk follows a parent only while it was created
# before its child (a ParentProcessId can point at a process that merely
# inherited a long-gone parent's pid). Throws when the query fails, so the
# caller treats the holder as busy rather than guessing.
function Get-AncestorProcessIds {
    $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 15 -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, CreationDate)
    $byId = @{}
    foreach ($p in $all) { $byId[[int] $p.ProcessId] = $p }
    $chain = @()
    $cur = $byId[[int] $PID]
    for ($i = 0; $i -lt 64 -and $cur; $i++) {
        $parentId = [int] $cur.ParentProcessId
        if ($parentId -le 0 -or $parentId -eq [int] $cur.ProcessId -or $chain -contains $parentId) { break }
        $parent = $byId[$parentId]
        if (-not $parent) { break }
        if ($cur.CreationDate -and $parent.CreationDate -and $parent.CreationDate -gt $cur.CreationDate) { break }
        $chain += $parentId
        $cur = $parent
    }
    return @($chain)
}

# Every process below the holder, any depth, from one Win32_Process
# snapshot, as {ProcessId, CreationDate} objects. A child is only followed
# when it was created after its parent: Windows reuses pids, so a
# ParentProcessId can point at a process that merely inherited the pid of a
# long-gone parent, and taskkill /T follows those. With $createdBefore set,
# only processes created up to that instant count: after the holder has
# been stopped, its pid can go to a new process whose children would
# otherwise appear as the holder's. $protect lists pids never to return
# (this updater's own parent chain). GAFFER_UPDATE_TEST_FAIL_LIST (harness
# only) makes the first call fail.
function Get-DescendantProcessIds([int] $rootPid, $rootCreated, $createdBefore, [int[]] $protect) {
    if ($script:testFailList) { $script:testFailList = $false; throw "GAFFER_UPDATE_TEST_FAIL_LIST" }
    $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 15 -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, CreationDate)
    $found = @{}
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@{ Id = $rootPid; Created = $rootCreated })
    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        foreach ($p in $all) {
            if ($p.ParentProcessId -ne $cur.Id -or $p.ProcessId -eq $rootPid -or $p.ProcessId -eq $PID -or $found.ContainsKey($p.ProcessId)) { continue }
            if ($protect -and ($protect -contains [int] $p.ProcessId)) { continue }
            if ($cur.Created -and $p.CreationDate -and $p.CreationDate -lt $cur.Created) { continue }
            # Residual risk, left for a later release: two clocks are compared
            # here (Win32_Process CreationDate against this process's UtcNow),
            # and CreationDate arrives as local time, so for the one hour of a
            # DST fall-back a child's time can read an hour off.
            if ($createdBefore -and $p.CreationDate -and ([DateTime] $p.CreationDate).ToUniversalTime() -gt $createdBefore) { continue }
            $found[$p.ProcessId] = [pscustomobject] @{ ProcessId = [int] $p.ProcessId; CreationDate = $p.CreationDate }
            $queue.Enqueue(@{ Id = $p.ProcessId; Created = $p.CreationDate })
        }
    }
    return @($found.Values)
}

# End the holder AND every process it started (its curl.exe, robocopy, the
# fetch-runtime.ps1 child, and whatever those started); ending only the shell would orphan those.
# Order: (1) while the holder is still alive, list its descendants from
# Win32_Process (parent pid plus creation order, see above); (2) if that
# listing failed, taskkill /T /F the holder right now, while it is alive,
# since taskkill needs the live tree, and skip the rest; (3) otherwise note
# the instant, stop the holder, list its descendants once more accepting
# only processes created before that instant (an orphan keeps its
# ParentProcessId, and a new process that inherits the holder's pid cannot
# have children older than the stop), then stop the union, youngest first.
# A forced stop gives the holder no chance to run its finally, so its lock
# stays for the caller to take over; the closing pause lets the file system
# settle before the lock is re-read. $protect lists pids never to stop.
function Stop-LockHolder($proc, [int[]] $protect) {
    $holderPid = [int] $proc.ProcessId
    Write-Host "Stopping an update that has run for over 15 minutes (pid $holderPid)"
    # A flag, not a null test on the array: in PowerShell an empty array
    # compared with $null yields an empty (falsy) result, and a holder with
    # no descendants would wrongly take the taskkill path.
    $listed = $false
    $kids = @()
    try { $kids = @(Get-DescendantProcessIds $holderPid $proc.CreationDate $null $protect); $listed = $true } catch { $listed = $false }
    if (-not $listed) {
        Write-Host "  could not list the stuck update's processes, using taskkill /T"
        $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
        $ErrorActionPreference = "Continue"
        & $taskkill /PID $holderPid /T /F 2>&1 | Out-Null
        $ErrorActionPreference = "Stop"
    } else {
        $stopAt = [DateTime]::UtcNow
        Stop-Process -Id $holderPid -Force -ErrorAction SilentlyContinue
        # Anything a child started between the first listing and the stop.
        $more = @()
        try { $more = @(Get-DescendantProcessIds $holderPid $proc.CreationDate $stopAt $protect) } catch {}
        $tree = @{}
        foreach ($k in ($kids + $more)) { $tree[$k.ProcessId] = $k }
        $order = @($tree.Values | Sort-Object -Property CreationDate -Descending)
        Write-Host "  stopping the stuck update and its $($order.Count) descendant process(es)"
        foreach ($k in $order) { Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue }
    }
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

# Serialize takeovers. $false when another live updater is mid-takeover, or
# when another updater cleared the same stale marker first. A stale marker
# (60 seconds or older, or dated over 300 s in the future) is cleared by
# renaming it to a name only this process uses: the rename is atomic, so of
# several updaters that all judged it stale exactly one succeeds. The
# renamed file's own age is checked once more: had a fresh marker slipped
# in between the age check and the rename, the rename would have stolen a
# live updater's mutex, so a young one is put back and this updater yields.
#
# Residual risk, left as is: the put-back is not atomic. While the renamed
# fresh marker is away (between this updater's Move-Item and its move
# back), a third updater can create a marker of its own; the put-back then
# sees a marker in place, discards the renamed one, and two updaters believe
# they hold the mutex. It takes three updaters racing within milliseconds,
# and the lock takeover inside the mutex still re-reads the lock's pid and
# only removes the lock it judged stale, so harm also needs those two to
# interleave within the few instructions between that re-read and the
# removal.
function Test-MarkerStale([double] $age) { return ($age -ge 60 -or $age -lt -300) }
function Enter-TakeoverMutex {
    if (New-PidFile $takeoverPath) { $script:haveTakeover = $true; return $true }
    $item = Get-Item -LiteralPath $takeoverPath -ErrorAction SilentlyContinue
    if (-not $item) { return $false }
    $age = Get-FileAgeSeconds $item
    if (-not (Test-MarkerStale $age)) { return $false }
    Wait-TestGate $env:GAFFER_UPDATE_TEST_MARKER_GATE
    $stale = "$takeoverPath.stale.$PID"
    try {
        Move-Item -LiteralPath $takeoverPath -Destination $stale -ErrorAction Stop
    } catch {
        Write-Host "Another update cleared the stale takeover marker first, leaving it to finish."
        return $false
    }
    $moved = Get-Item -LiteralPath $stale -ErrorAction SilentlyContinue
    if ($moved) { $age = Get-FileAgeSeconds $moved }
    if (-not (Test-MarkerStale $age)) {
        Write-Host "The takeover marker was renewed by another update meanwhile, putting it back."
        if (-not (Test-Path -LiteralPath $takeoverPath)) {
            try { Move-Item -LiteralPath $stale -Destination $takeoverPath -ErrorAction Stop } catch { Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue }
        } else {
            Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue
        }
        return $false
    }
    if ($age -lt -300) {
        Write-Host "Removing a takeover marker dated in the future (the clock moved back since it was left)"
    } else {
        Write-Host "Removing a takeover marker left by a crashed updater ($([int] $age) s old)"
    }
    Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue
    if (New-PidFile $takeoverPath) { $script:haveTakeover = $true; return $true }
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
    $lockWrittenUtc = $lockItem.LastWriteTimeUtc
    $lockAge = Get-FileAgeSeconds $lockItem
    # No readable pid in a lock under 30 s old (up to 300 s of clock skew
    # tolerated): an updater between its CreateNew and its pid write.
    $holderPid = 0
    $holderParses = ([int]::TryParse($holder, [ref] $holderPid) -and $holderPid -gt 0)
    if (-not $holderParses -and $lockAge -ge -300 -and $lockAge -lt 30) {
        Write-Host "Another update is starting up (its lock is seconds old), leaving it to finish."
        Write-Output "busy:already-running"
        Stop-Transcript
        exit 3
    }
    $proc = Get-LockHolderProcess $holder $lockWrittenUtc
    if ($proc -and $proc.Unverified) {
        Write-Host "Could not inspect the process holding the lock (pid $holder), but it is alive: leaving it to finish."
        Write-Output "busy:already-running"
        Stop-Transcript
        exit 3
    }
    # A live updater holder is busy unless its lock is really old; a lock
    # dated in the future is never "old", so it is busy as well.
    $lockIsOld = ($lockAge -ge $stuckAfter)
    if ($proc -and -not $lockIsOld) {
        Write-Host "Another update is already running (pid $holder), leaving it to finish."
        Write-Output "busy:already-running"
        Stop-Transcript
        exit 3
    }
    # A live holder past the stuck age. Two kinds are never stopped, and
    # since nothing else can free their lock, this run ends with err:lock:
    # a holder on this process's own parent chain (stopping it would stop
    # this updater too), and a holder recognised by its process name only
    # (a person's PowerShell window, see Get-LockHolderProcess).
    $ancestors = @()
    if ($proc) {
        try { $ancestors = @(Get-AncestorProcessIds) } catch {
            Write-Host "Could not inspect this process's own parent chain, leaving the update holding the lock (pid $holder) to finish."
            Write-Output "busy:already-running"
            Stop-Transcript
            exit 3
        }
        if ($ancestors -contains [int] $proc.ProcessId) {
            Write-Host "This update was started from the terminal that holds the lock. Close that window and try again."
            Write-Output "err:lock"
            Stop-Transcript
            exit 1
        }
        if (-not $proc.Stoppable) {
            Write-Host "An update started by hand in PowerShell (pid $holder) has held the lock for over 15 minutes. Close that window or press Ctrl+C in it."
            Write-Output "err:lock"
            Stop-Transcript
            exit 1
        }
    }
    if (-not $proc -and $holderParses -and (Get-Process -Id $holderPid -ErrorAction SilentlyContinue)) {
        Write-Host "The lock's pid $holder belongs to a process that is not the update that wrote the lock (another program, or a process started after the lock was written: pid reused)."
    }
    if ($tries -gt 3) {
        Write-Host "ERROR: could not take the update lock at $lockPath"
        Write-Output "err:lock"
        Stop-Transcript
        exit 1
    }
    Wait-TestGate $env:GAFFER_UPDATE_TEST_GATE
    if (-not (Enter-TakeoverMutex)) {
        Write-Host "Another update is taking over the abandoned lock, leaving it to finish."
        Write-Output "busy:already-running"
        Stop-Transcript
        exit 3
    }
    # Inside the mutex: the lock may have been taken over (and re-created)
    # since the pid was read. Only act on the lock we judged stale.
    $nowHolder = Read-LockHolder
    if (-not (Test-Path -LiteralPath $lockPath)) {
        Write-Host "The abandoned lock was released meanwhile, retrying."
        Exit-TakeoverMutex; continue
    }
    if ($nowHolder -ne $holder) {
        $label = $nowHolder
        if (-not $label) { $label = "unknown" }
        Write-Host "The abandoned lock now belongs to pid $label, rechecking."
        Exit-TakeoverMutex; continue
    }
    if ($proc) {
        # Re-read the holder itself inside the mutex: stop it only if it is
        # still the same live updater (same pid, same creation time), never
        # a process that took its pid meanwhile. A re-read that could not
        # inspect the process proves nothing, least of all that it is gone.
        $state = Get-LockHolderState $proc $lockWrittenUtc
        if ($state -eq "unverified") {
            Write-Host "Could not inspect the process holding the lock (pid $($proc.ProcessId)), but it is alive: leaving it to finish."
            Exit-TakeoverMutex
            Write-Output "busy:already-running"
            Stop-Transcript
            exit 3
        }
        if ($state -eq "same") {
            Stop-LockHolder $proc $ancestors
            $nowHolder = Read-LockHolder
            if ((Test-Path -LiteralPath $lockPath) -and $nowHolder -ne $holder) {
                $label = $nowHolder
                if (-not $label) { $label = "unknown" }
                Write-Host "The abandoned lock now belongs to pid $label, rechecking."
                Exit-TakeoverMutex; continue
            }
        } else {
            Write-Host "The stuck update (pid $($proc.ProcessId)) is already gone, not stopping it."
        }
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
Wait-TestGate $env:GAFFER_UPDATE_TEST_HOLD_GATE

# From here on the lock is held, so everything runs inside this try: the
# finally releases the lock on every way out, exit calls included.
try {

# Stop-Daemon lives in its own file (dot-sourced) so it stays plain-function-only
# and can be unit-tested in isolation - see scripts/windows-tests/test-4-stop-daemon-stray-pid.ps1
. "$PSScriptRoot\stop-daemon.ps1"

# Every failure after this point goes through here: log, clean up, exit 1.
# $code, when given, ends the log with err:<code> after the ERROR line (the
# last-line contract above); the exit code stays 1 either way.
# The panel dir is untouched until the robocopy step, and version.json is
# only replaced at the very end.
function Exit-Update([string] $message, [string] $code = "") {
    Write-Host "ERROR: $message"
    if ($code) { Write-Output "err:$code" }
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
    Stop-Transcript
    exit 1
}

# The bundled Node runtime (spec sections 3 and 6). daemon\runtime holds
# node.exe plus VERSION ("<version> <platform>") and VERIFIED ("<size>
# <sha256>"); fetch-runtime.ps1 -StageOnly leaves a verified, stamped copy in
# runtime.new. All three live inside daemon\ so every rename stays on one
# volume. A running node.exe cannot be overwritten or deleted, but its folder
# can be renamed, so the swap is two renames and never a copy.
$runtimeDir = Join-Path $daemonDir "runtime"
$runtimeNew = Join-Path $daemonDir "runtime.new"
$runtimeOld = Join-Path $daemonDir "runtime.old"

function Remove-Tree([string] $path) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
}

# $true when $dir\node.exe exists and its size equals the first field of
# $dir\VERIFIED (the launcher's size check).
function Test-RuntimeStamp([string] $dir) {
    $exe = Join-Path $dir "node.exe"
    $stamp = Join-Path $dir "VERIFIED"
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath $stamp -PathType Leaf)) { return $false }
    try {
        $fields = @(([System.IO.File]::ReadAllText($stamp)).Trim() -split '\s+')
        return ($fields.Count -ge 1 -and $fields[0] -eq [string] (Get-Item -LiteralPath $exe).Length)
    } catch { return $false }
}

# The GAFFER_FETCH_* seams of fetch-runtime.ps1 (local archives, skipped
# signature check) are for the test harness only, which always sets
# GAFFER_UPDATE_ASSET. Anywhere else a stray one is dropped before the child
# that would read it starts, so a real update always verifies for real.
if (-not $env:GAFFER_UPDATE_ASSET) {
    foreach ($seam in @("GAFFER_FETCH_TEST", "GAFFER_FETCH_BASE_OFFICIAL", "GAFFER_FETCH_BASE_MIRROR", "GAFFER_FETCH_PINS",
        "GAFFER_FETCH_SKIP_CODESIGN", "GAFFER_FETCH_PLATFORM", "GAFFER_FETCH_NO_TAR", "GAFFER_FETCH_NO_CURL")) {
        Remove-Item -LiteralPath "Env:\$seam" -ErrorAction SilentlyContinue
    }
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
# budget, checked before every body read (a read may block for 20s, so the
# last one is only started while at least 20s of the budget remain), so the
# worst case stays at about 90 + 150 = 240s, under the curl-only worst case
# of 270s, then extract + the runtime step + robocopy. The runtime step is
# instant when the runtime is current (no network call); a release that
# changes the Node pin adds a download of about 30 MB with fetch-runtime.ps1's
# own limits. The panel (main.js
# waitForUpdatedVersion) gives up after 180s but extends once by 180s while
# this lock is held, a 360s window; a worst-case download plus a runtime
# download on a slow link can outlive it, and then the panel offers "Force stop & retry",
# whose second updater exits busy against this lock, so a slow run is never
# corrupted, only late. Only a 404 or 410 from curl (the asset is not there)
# is final: any other 4xx (403, 407, 429) is what a proxy intercepting
# curl.exe answers, so those fall back like a connection failure. The .NET
# path has nothing left to fall back to, so every 4xx is final there. Both
# carry the status in parentheses like Invoke-WebRequest's error did.
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
                if ($status -eq 404 -or $status -eq 410) { $finalError = "The remote server returned an error: ($status)." }
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
# 20s stall and only started while 20s of the 150s budget remain, 4xx final,
# otherwise up to 3 attempts as long as a retry can start within 110s.
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
                    while ($true) {
                        # A read may block for ReadWriteTimeout (20s): only
                        # start one while that much of the budget remains.
                        if (((Get-Date) - $started).TotalSeconds -gt 130) { throw "download exceeded its 150s budget" }
                        $n = $in.Read($buf, 0, $buf.Length)
                        if ($n -le 0) { break }
                        $out.Write($buf, 0, $n)
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

    # Recovery first (spec 6.8): an updater stopped between the two runtime
    # renames leaves runtime.old and no runtime. Rename it back when it
    # passes the size check; one that does not is left to the runtime step
    # below, which provisions a fresh runtime and clears it.
    if (-not (Test-Path -LiteralPath $runtimeDir) -and (Test-Path -LiteralPath $runtimeOld)) {
        if (Test-RuntimeStamp $runtimeOld) {
            try {
                [System.IO.Directory]::Move($runtimeOld, $runtimeDir)
                Write-Host "Restored daemon\runtime from runtime.old (an earlier update stopped between its two renames)"
            } catch {
                Write-Host "Could not restore daemon\runtime from runtime.old: $($_.Exception.Message)"
            }
        } else {
            Write-Host "Found daemon\runtime.old without a runtime, but it fails the size check; the runtime step provisions a new one"
        }
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
        Exit-Update "download or extract failed: $($_.Exception.Message)" "download"
    }
    # New archives always carry daemon\daemon.mjs (and, for 0.11.x updaters,
    # the daemon\index.js shim too); the runtime step needs the archive's own
    # fetch-runtime.ps1 and runtime-pins.json.
    if (-not (Test-Path -LiteralPath "$extractDir\version.json" -PathType Leaf) -or -not (Test-Path -LiteralPath "$extractDir\daemon\daemon.mjs" -PathType Leaf)) {
        Exit-Update "downloaded archive is not a Gaffer release (missing version.json or daemon\daemon.mjs)"
    }
    $fetchScript = Join-Path $extractDir "daemon\fetch-runtime.ps1"
    if (-not (Test-Path -LiteralPath $fetchScript -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $extractDir "daemon\runtime-pins.json") -PathType Leaf)) {
        Exit-Update "the release has no runtime provisioning (missing daemon\fetch-runtime.ps1 or daemon\runtime-pins.json)" "runtime"
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

    # Runtime step, BEFORE any file is replaced and while the daemon still
    # runs (spec 6.2). The archive's fetch-runtime.ps1 compares daemon\runtime
    # (VERSION and the VERIFIED size) with the archive's pins: current means
    # no network call at all; otherwise it downloads, verifies (SHA-256,
    # size, Authenticode, a smoke run that also warms up Defender) and
    # leaves the stamped result in runtime.new. Any other outcome deletes
    # runtime.new and ends with err:runtime, the install untouched.
    # It runs as a child of the same PowerShell host, sharing this console
    # (hidden when the panel started the update), so no window opens. -Into
    # is $daemonDir, which never ends in a backslash (PowerShell quotes an
    # argument with spaces, and a trailing backslash would escape the quote).
    Write-Host "Checking the Node runtime..."
    $psExe = Join-Path $PSHOME "powershell.exe"
    if (-not (Test-Path -LiteralPath $psExe -PathType Leaf)) { $psExe = Join-Path $PSHOME "pwsh.exe" }
    $fetchOut = @()
    $fetchExit = -1
    $ErrorActionPreference = "Continue"
    try { $fetchOut = @(& $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $fetchScript -StageOnly -Into $daemonDir 2>&1) }
    catch { $fetchOut = @("could not start fetch-runtime.ps1: $($_.Exception.Message)") }
    $fetchExit = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    $fetchLines = @($fetchOut | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    foreach ($line in $fetchLines) { Write-Host $line }
    $fetchLast = ""
    if ($fetchLines.Count -gt 0) { $fetchLast = $fetchLines[$fetchLines.Count - 1] }
    $stagedRuntime = $false
    if ($fetchExit -eq 0 -and $fetchLast -eq "runtime:current") {
        Write-Host "  the runtime is current, nothing to swap"
    } elseif ($fetchExit -eq 0 -and $fetchLast -match '^runtime:installed \S+ \S+$') {
        # Staged, swap needed. VERSION and VERIFIED are already inside.
        if (-not (Test-RuntimeStamp $runtimeNew) -or -not (Test-Path -LiteralPath (Join-Path $runtimeNew "VERSION") -PathType Leaf)) {
            Remove-Tree $runtimeNew
            Exit-Update "fetch-runtime.ps1 reported a staged runtime, but daemon\runtime.new is incomplete. Your current version still works." "runtime"
        }
        $stagedRuntime = $true
    } else {
        Remove-Tree $runtimeNew
        Exit-Update "could not download Gaffer's runtime (fetch-runtime.ps1 exit $fetchExit, last line '$fetchLast'). Your current version still works." "runtime"
    }

    # Stop daemon. It must be down before the swap (spec 6.3).
    Write-Host "Stopping daemon..."
    Stop-Daemon

    # Swap the runtime: rename the current one aside, rename runtime.new
    # into place, delete the old one. A runtime.old that is still there is a
    # leftover locked by a node.exe that was running from it; with the
    # daemon stopped it can usually go now. If it cannot, nothing has been
    # replaced yet, so the update stops with err:runtime rather than mixing
    # runtimes.
    if ($stagedRuntime) {
        Write-Host "Swapping in the new runtime..."
        Remove-Tree $runtimeOld
        if (Test-Path -LiteralPath $runtimeOld) {
            Remove-Tree $runtimeNew
            Exit-Update "daemon\runtime.old is still in use by a running node.exe; close After Effects and update again. Your current version still works." "runtime"
        }
        $hadRuntime = Test-Path -LiteralPath $runtimeDir
        if ($hadRuntime) {
            try { [System.IO.Directory]::Move($runtimeDir, $runtimeOld) } catch {
                $reason = $_.Exception.Message
                Remove-Tree $runtimeNew
                Exit-Update "could not move the current runtime aside: $reason. Your current version still works." "runtime"
            }
        }
        Wait-TestGate $env:GAFFER_UPDATE_TEST_SWAP_GATE
        try { [System.IO.Directory]::Move($runtimeNew, $runtimeDir) } catch {
            $reason = $_.Exception.Message
            if ($hadRuntime -and -not (Test-Path -LiteralPath $runtimeDir)) {
                try { [System.IO.Directory]::Move($runtimeOld, $runtimeDir) } catch {}
            }
            Remove-Tree $runtimeNew
            Exit-Update "could not move the new runtime into place: $reason" "runtime"
        }
        Remove-Tree $runtimeOld
        if (Test-Path -LiteralPath $runtimeOld) { Write-Host "  daemon\runtime.old is still in use, it will be removed by the next update" }
        Write-Host "  daemon\runtime is now $($fetchLast.Substring('runtime:installed '.Length))"
    }

    # Replace files (preserve user data). version.json is excluded here and
    # written LAST (below): the panel reloads and the daemon self-restarts the
    # moment it changes. The usage-stats buffer and the icon cache are not in the
    # archive; excluding them also protects them from /PURGE.
    # The runtime folders are not in the archive either: without /XD for
    # them /PURGE deletes daemon\runtime (proven). /XD matches a folder name
    # at any depth; nothing else in the package is called runtime*.
    # node_modules is deliberately NOT excluded any more, so /PURGE removes
    # the old dependency tree a 0.11.x install left behind.
    Write-Host "Replacing files..."
    # /R:2 /W:2: two retries, two seconds apart, on a file that is briefly
    # locked (an indexer, a daemon not yet gone), instead of robocopy's
    # default of a million retries at 30 seconds each.
    robocopy $extractDir $panelDir /E /PURGE /R:2 /W:2 `
        /XF chat-history.json chat-history-*.json .gaffer-config.json version.json .gaffer-usage-buffer.json `
        /XD runtime runtime.new runtime.old dist .gaffer-icons | Out-Null
    # robocopy exit codes 0-7 are success variants; 8 and up mean a copy failed.
    if ($LASTEXITCODE -ge 8) { Exit-Update "robocopy failed (exit $LASTEXITCODE)" "sync" }

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

    # No dependency install step: the release ships the daemon as one bundled
    # file and its runtime is handled above.

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
