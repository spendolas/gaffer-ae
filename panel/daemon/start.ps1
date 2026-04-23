# Gaffer daemon launcher (Windows) — called by CEP panel via system.callSystem()
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

# Prefer compiled binary
if (Test-Path "$dir\gaffer-daemon.exe") {
    Start-Process -FilePath "$dir\gaffer-daemon.exe" -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\gaffer-daemon.log" -RedirectStandardError "$env:TEMP\gaffer-daemon-err.log"
    Write-Output "binary"
    exit 0
}

# Fall back to node
$nodePaths = @(
    "C:\Program Files\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:ProgramFiles\nodejs\node.exe"
)
$node = $null
foreach ($p in $nodePaths) {
    if (Test-Path $p) { $node = $p; break }
}
if (-not $node) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $node) {
    Write-Error "node not found"
    exit 1
}

Start-Process -FilePath $node -ArgumentList "index.js" -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\gaffer-daemon.log" -RedirectStandardError "$env:TEMP\gaffer-daemon-err.log"
Write-Output "node"
