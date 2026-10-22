# Gaffer daemon launcher (Windows), called by the CEP panel only on the
# ExtendScript fallback route (spawnViaExtendScript in panel/main.js); the
# normal route is spawnViaNode. Mirrors resolveDaemonLaunch in
# panel/daemon-launch.js exactly (zero-dependency install spec, sections 4
# and 5). Windows is never a dev install.
#   1. runtime\node.exe exists: it must pass the check (daemon.mjs present,
#      size equals the runtime\VERIFIED stamp, or on a stamp-less first run
#      size and sha256 match the win-x64 pin in runtime-pins.json, then the
#      stamp is written). A runtime that fails the check is NEVER bypassed
#      with a system node.
#   2. No runtime: system node (%ProgramFiles%, %LOCALAPPDATA%\Programs, then
#      PATH) with daemon.mjs when present, else index.js.
# The spawn itself is launch.cjs (detached, hidden, log appended, cleaned
# env); Start-Process with redirection hung the caller and truncated the log.
# Output contract, one line on stdout (panel/main.js parses it):
#   pid:<N> runtime | pid:<N> node | err:runtime-damaged | err:runtime-missing
# Keep this file ASCII-only with a UTF-8 BOM (Windows PowerShell 5.1).
# Test seam: GAFFER_DAEMON_LOG moves the log, only when GAFFER_TEST=1.

# CSInterface paths arrive with forward slashes; work on one native path.
$dir = (Split-Path -Parent $MyInvocation.MyCommand.Path) -replace '/', '\'
$dir = $dir.TrimEnd('\')
if ($dir -match '^[A-Za-z]:$') { $dir += '\' }
Set-Location -LiteralPath $dir

$log = Join-Path $env:TEMP 'gaffer-daemon.log'
if ($env:GAFFER_TEST -eq '1' -and $env:GAFFER_DAEMON_LOG) { $log = $env:GAFFER_DAEMON_LOG }
$bin = Join-Path $dir 'runtime\node.exe'
$bundle = Join-Path $dir 'daemon.mjs'
$stamp = Join-Path $dir 'runtime\VERIFIED'
$pinsPath = Join-Path $dir 'runtime-pins.json'

function Write-Note([string] $text) {
    $line = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + ' Gaffer start.ps1: ' + $text + "`r`n"
    # FileShare.ReadWrite: a running daemon holds the log open for writing
    # (launch.cjs hands it the handle), and AppendAllText's FileShare.Read
    # makes the open fail. If the log still cannot be written, the note goes
    # to stderr instead of vanishing (stdout carries only the contract line).
    $fs = $null
    try {
        $fs = New-Object IO.FileStream($log, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $b = [Text.Encoding]::UTF8.GetBytes($line)
        $fs.Write($b, 0, $b.Length)
    } catch {
        try { [Console]::Error.Write($line) } catch { }
    } finally {
        if ($fs) { $fs.Dispose() }
    }
}

function Stop-Launch([string] $code, [string] $reason) {
    if ($reason) { Write-Note ('runtime: ' + $reason) }
    $suffix = ''
    if ($reason) { $suffix = ' (' + $reason + ')' }
    Write-Note ('daemon not launched: err:' + $code + $suffix)
    Write-Output ('err:' + $code)
    exit 1
}

# Recorded size from the stamp as a digit string, $null when absent,
# unreadable or garbled. Spec form "<size> <sha256>"; the PoC wrote
# "size=<n>" lines, read both. Compared as text (leading zeros dropped), so a
# 20+ digit stamp is a mismatch, never an [int64] overflow.
function Get-StampSize {
    if (-not (Test-Path -LiteralPath $stamp -PathType Leaf)) { return $null }
    try { $raw = [IO.File]::ReadAllText($stamp) } catch { return $null }
    $digits = $null
    if ($raw -match '^\s*(\d+)(?:\s|$)') { $digits = $Matches[1] }
    elseif ($raw -match 'size=(\d+)') { $digits = $Matches[1] }
    if ($null -eq $digits) { return $null }
    $digits = $digits.TrimStart('0')
    if (-not $digits) { $digits = '0' }
    return $digits
}

function Test-BundledRuntime {
    if (-not (Test-Path -LiteralPath $bundle)) { Stop-Launch 'runtime-damaged' 'daemon.mjs missing next to the runtime' }
    try { $size = [int64] (Get-Item -LiteralPath $bin -ErrorAction Stop).Length }
    catch { Stop-Launch 'runtime-damaged' ('cannot stat runtime: ' + $_.Exception.Message) }

    $stamped = Get-StampSize
    if ($null -ne $stamped) {
        if ($stamped -cne ([string] $size)) { Stop-Launch 'runtime-damaged' ('runtime size ' + $size + ' does not match the stamp ' + $stamped) }
        return
    }
    # Stamp-less first run (README install): verify once against the pin.
    $pin = $null
    try {
        $pins = [IO.File]::ReadAllText($pinsPath) | ConvertFrom-Json -ErrorAction Stop
        $p = $pins.node.platforms.'win-x64'
        if ($p -and ([string] $p.binaryBytes) -ceq ([string] $size)) { $pin = $p }
    } catch { $pin = $null }
    if (-not $pin) { Stop-Launch 'runtime-damaged' ('no stamp and runtime size ' + $size + ' matches no pinned binary') }
    $sha = [string] $pin.binarySha256
    if ($sha -ceq 'PENDING-FIRST-ACCEPTANCE-RUN') {
        # Only this exact literal skips the hash. No stamp is written, so a
        # later stamp-less run re-evaluates once the real pin ships.
        Write-Note 'runtime: pinned sha256 for win-x64 is the placeholder PENDING-FIRST-ACCEPTANCE-RUN, skipping the hash check, size matched, no stamp written'
        return
    }
    if ($sha -notmatch '^[0-9a-fA-F]{64}$') {
        Stop-Launch 'runtime-damaged' ('pinned sha256 for win-x64 is not a sha256 (' + $sha + ')')
    }
    try { $got = (Get-FileHash -LiteralPath $bin -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
    catch { Stop-Launch 'runtime-damaged' ('cannot hash runtime: ' + $_.Exception.Message) }
    if ($got -ne $sha.ToLowerInvariant()) { Stop-Launch 'runtime-damaged' ('runtime sha256 ' + $got + ' does not match the pin for win-x64') }
    Write-Note 'runtime: first run, sha256 matches the pin for win-x64'
    try {
        [IO.File]::WriteAllText($stamp, ([string] $size) + ' ' + $got + "`n")
        Write-Note ('runtime: wrote stamp ' + $stamp)
    } catch {
        Write-Note ('runtime: could not write the stamp (' + $_.Exception.Message + '), will verify again next launch')
    }
}

# Same candidates and order as findSystemNode in daemon-launch.js.
function Find-SystemNode {
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += (($env:ProgramFiles -replace '/', '\').TrimEnd('\') + '\nodejs\node.exe') }
    if ($env:LOCALAPPDATA) { $candidates += (($env:LOCALAPPDATA -replace '/', '\').TrimEnd('\') + '\Programs\nodejs\node.exe') }
    if ($env:PATH) {
        foreach ($d in ($env:PATH -split ';')) {
            if (-not $d) { continue }
            $d = (($d.Trim('"')) -replace '/', '\').TrimEnd('\')
            if (-not $d) { continue }
            $candidates += ($d + '\node.exe')
        }
    }
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

# Decision D7: pass the original CA bundle on for the claude child only, then
# clear the three variables so neither launch.cjs nor the daemon sees them.
if ($env:NODE_EXTRA_CA_CERTS -and ($null -eq $env:GAFFER_CLAUDE_EXTRA_CA_CERTS)) {
    $env:GAFFER_CLAUDE_EXTRA_CA_CERTS = $env:NODE_EXTRA_CA_CERTS
}
Remove-Item -LiteralPath Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item -LiteralPath Env:NODE_PATH -ErrorAction SilentlyContinue
Remove-Item -LiteralPath Env:NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $bin) {
    Test-BundledRuntime
    $node = $bin
    $entry = 'daemon.mjs'
    $kind = 'runtime'
} else {
    Write-Note ('runtime: no bundled runtime at ' + $bin + ', probing for a system node')
    $node = Find-SystemNode
    if (-not $node) { Stop-Launch 'runtime-missing' 'no bundled runtime and no system node found' }
    $entry = 'index.js'
    if (Test-Path -LiteralPath $bundle) { $entry = 'daemon.mjs' }
    $kind = 'node'
}

# launch.cjs prints the contract line (pid:<N> runtime|node) and exits at
# once; the daemon holds only the log, never this script's stdout. Capture
# its output so a node that could not start (no output, a stale or null
# $LASTEXITCODE) still ends in one contract line.
# This PowerShell holds inheritable copies of the caller's stdout/stderr
# pipes (the console host duplicates its std handles). & $node would pass
# them to launch.cjs and libuv on to the detached daemon, so a caller
# reading this script's output to EOF (system.callSystem) would wait for the
# daemon to exit (seen on the Windows VM). Clear the inherit flag on every
# handle first; the pipes PowerShell creates for & $node below are made
# after this, so the capture still works.
try {
    Add-Type -Namespace GafferLaunch -Name NoInherit -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool SetHandleInformation(IntPtr h, int mask, int flags);'
    for ($h = 4; $h -lt 65536; $h += 4) { [void][GafferLaunch.NoInherit]::SetHandleInformation([IntPtr]$h, 1, 0) }
} catch { Write-Note ('could not clear handle inheritance: ' + $_.Exception.Message) }
$global:LASTEXITCODE = $null
$out = $null
$started = $true
try { $out = & $node "$dir\launch.cjs" $kind $entry 2>$null }
catch { $started = $false; Write-Note ('daemon not launched: node could not start: ' + $_.Exception.Message) }
$code = $LASTEXITCODE
$line = $null
foreach ($l in @($out)) { if ([string] $l -match '^(pid:\d+ (runtime|node)|err:[a-z-]+)\s*$') { $line = ([string] $l).Trim() } }
if ($started -and $line -and $line.StartsWith('pid:') -and $code -eq 0) {
    Write-Output $line
    exit 0
}
if ($line -and $line.StartsWith('err:')) { Write-Output $line; exit 1 }
Write-Note ('daemon not launched: err:launch-failed (launch.cjs exit ' + $code + ', output: ' + (@($out) -join ' ') + ')')
Write-Output 'err:launch-failed'
exit 1
