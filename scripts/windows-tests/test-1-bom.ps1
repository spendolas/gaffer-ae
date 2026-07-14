# test-1-bom.ps1
# ======================================================================
# Reproduces Windows-PowerShell-5.1's mishandling of non-ASCII characters
# in .ps1 files, as seen in Gaffer's update.ps1 line 87 (em-dash inside a
# Write-Error message).
#
# The test writes two synthetic scripts of identical structure:
#   1. with an em-dash
#   2. same script but ASCII-only (em-dash replaced with '--')
# Both are UTF-8 without a BOM (git's default; how most editors save).
#
# The scripts are run under PS 5.1 and their exit + output are compared.
#
# Expected on Windows PowerShell 5.1:
#   Non-ASCII script -> either a ParserError with a bogus "Missing
#                       closing '}'" message pointing at a line where
#                       braces are actually balanced, OR silent
#                       corruption of the visible string (em-dash bytes
#                       displayed as garbage Windows-1252 characters).
#                       Which of the two symptoms surfaces depends on
#                       byte offsets and file length -- larger files
#                       (like the real update.ps1, ~110 lines) tend to
#                       hit the ParserError path.
#   ASCII-only script -> parses and runs cleanly.
#
# Cause: PS 5.1 reads BOM-less scripts as Windows-1252. UTF-8 em-dash
# bytes (E2 80 94) get read as three W1252 characters, which can throw
# the tokenizer off enough to lose track of brace nesting.
#
# Fix recommendation for maintainers: keep .ps1 files ASCII-only, or
# save them explicitly as UTF-16 LE (PS 5.1's native encoding). UTF-8
# with BOM works for some files but the behaviour is not reliable across
# PS 5.1 sub-versions.
#
# This outer test script is intentionally ASCII-only so it runs
# regardless of BOM/encoding.
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\test-1-bom.ps1

$nonAscii = "$env:TEMP\gaffer-encoding-test-non-ascii.ps1"
$asciiOnly = "$env:TEMP\gaffer-encoding-test-ascii.ps1"

# Payload -- mirrors Gaffer's update.ps1 shape at the failing point.
$srcNonAscii = @'
$ErrorActionPreference = "Stop"
$logPath = Join-Path $env:TEMP "gaffer-encoding-test.log"
Start-Transcript -Path $logPath -Append

$nodeDirs = @(
    "$env:ProgramFiles\nodejs",
    "${env:ProgramFiles(x86)}\nodejs",
    "$env:APPDATA\npm",
    "$env:LOCALAPPDATA\Programs\nodejs"
) | Where-Object { $_ -and (Test-Path $_) }
foreach ($d in $nodeDirs) { $env:Path = "$d;$env:Path" }
$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCmd) { $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source }
if (-not $npmCmd) {
    Write-Error "npm not found in known Node.js locations or PATH — run this script from a terminal once"
    Stop-Transcript
    exit 1
}
Write-Host "OK — npm at: $npmCmd"
Stop-Transcript
'@

# Same script, ASCII-only.
$srcAscii = $srcNonAscii `
    -replace '—', '--' `
    -replace '–', '-'

# Write both as UTF-8 without a BOM.
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($nonAscii, $srcNonAscii, $utf8NoBom)
[System.IO.File]::WriteAllText($asciiOnly, $srcAscii, $utf8NoBom)

$ps51 = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$b1 = [System.IO.File]::ReadAllBytes($nonAscii)
$b2 = [System.IO.File]::ReadAllBytes($asciiOnly)

Write-Host "======================================================================"
Write-Host "PowerShell 5.1 host: $ps51"
Write-Host ""
Write-Host "Non-ASCII script size: $((Get-Item $nonAscii).Length) bytes"
Write-Host "ASCII-only  script size: $((Get-Item $asciiOnly).Length) bytes"
Write-Host ("First three bytes:  non-ASCII= {0:X2} {1:X2} {2:X2}  |  ASCII= {3:X2} {4:X2} {5:X2}" -f $b1[0], $b1[1], $b1[2], $b2[0], $b2[1], $b2[2])
Write-Host "(No BOM present in either.)"
Write-Host ""

Write-Host "--- Running non-ASCII script (contains em-dash) ---"
& $ps51 -NoProfile -ExecutionPolicy Bypass -File $nonAscii 2>&1 | ForEach-Object { "  $_" }
Write-Host "  exit code: $LASTEXITCODE"
Write-Host ""

Write-Host "--- Running ASCII-only script (em-dash replaced with '--') ---"
& $ps51 -NoProfile -ExecutionPolicy Bypass -File $asciiOnly 2>&1 | ForEach-Object { "  $_" }
Write-Host "  exit code: $LASTEXITCODE"
Write-Host "======================================================================"

Remove-Item $nonAscii, $asciiOnly -ErrorAction SilentlyContinue
