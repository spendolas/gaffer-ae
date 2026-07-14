# Gaffer — Windows repro harness

Contributed by a Windows field tester (via their Claude) alongside the
2026-07 compatibility findings — see CHANGELOG v0.5.11–v0.5.13 for the
fixes these tests validate. Run before releases that touch child_process
spawns, PowerShell scripts, or the update flow.

Small, self-contained tests for the three "silently fails on Windows" issues in the handoff doc (fixes shipped in v0.5.11–v0.5.13). Nothing here touches your Gaffer install — the tests write to `%TEMP%` only.

**Requirements**
- Windows 10 / 11
- Windows PowerShell 5.1 (the default `powershell.exe`, not `pwsh`)
- Node.js (any recent version; the `detached` regression in test 3 was seen on Node v24.13.1 specifically — earlier majors may not repro)

**How to run**

Open a terminal in this folder, then:

```powershell
# Issue 1 — PowerShell 5.1 encoding
powershell -NoProfile -ExecutionPolicy Bypass -File .\test-1-bom.ps1

# Issue 2 — child_process console-window visibility on Windows
node .\test-2-console-flash.js

# Issue 3 — detached: true silent-fail on Node v24 + Windows 11
node .\test-3-detached-isolation.js
```

Expected outcomes are in each test's header comment.

**What each test proves**

| Test | Demonstrates |
|---|---|
| `test-1-bom.ps1` | PS 5.1 fails to parse a UTF-8 no-BOM script with any non-ASCII character; adding a BOM fixes it |
| `test-2-console-flash.js` | Node `child_process.spawn` on Windows shows a console window unless `windowsHide: true` is passed |
| `test-3-detached-isolation.js` | Every combination of spawn options that includes `detached: true` on Node v24 + Windows 11 returns a valid PID + exits code 0 but never actually runs the child command |
