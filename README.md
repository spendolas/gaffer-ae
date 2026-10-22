# Gaffer

An After Effects automation agent. Chat with Claude directly inside an AE panel: Claude controls After Effects by writing ExtendScript via MCP tools.

## Quick Start

Open Claude Code and say:

> Install Gaffer from https://github.com/spendolas/gaffer-ae

Claude will handle the rest. Then restart After Effects and open **Window > Extensions > Gaffer**.

## Prerequisites

- After Effects 2022+
- Claude: either the [Claude desktop app](https://claude.com/download) (it bundles Claude Code, no separate install needed) or the standalone [Claude Code](https://claude.ai/code) CLI. On Windows use the desktop app or the native installer, not `npm install -g` (the daemon can't launch npm's script shims)
- Nothing else: no Node.js, no npm, no git. The install downloads the official Node.js runtime from nodejs.org into Gaffer's own folder and verifies it; nothing is installed system-wide.

---

## Install Instructions for Claude

<details>
<summary>Claude: read this section when asked to install Gaffer.</summary>

### Rules for Claude

Before you begin, read these rules. They apply to every step below.

- Follow the steps in order. Do not skip, reorder, or combine steps.
- Do not improvise. If a step seems wrong for this system, stop and ask the user rather than deviating.
- Do not install prerequisites the user is missing (Claude, After Effects). If a prerequisite is missing, stop and tell the user what to install, with a link. Resume only after they confirm it's installed.
- Do not install Node.js any other way (Homebrew, nvm, npm, installers). Gaffer does not use a system Node.js; step 5 downloads its own copy into Gaffer's folder. Do not add that folder to PATH.
- Do not change proxy or network settings, do not turn off certificate checks, and do not ask the user to approve that either. If both downloads fail, stop and tell the user.
- Do not add shell aliases, modify the user's PATH, or change any config outside the paths explicitly named in these steps.
- Shell variables do not carry over between your separate command runs, so every block below sets the paths it needs.
- If any step fails, stop. Report the exact error. Do not retry with modifications unless the user asks you to.
- After the install completes, run the verification step. Do not skip it.

### What to do

1. **Check prerequisites.** Run these checks and report the results to the user before proceeding:

   - Claude: either the Claude desktop app is installed (step 10 shows where its bundled Claude Code lives) or `claude --version` works in a terminal. At least one must be present. Gaffer itself does not need the standalone CLI. Sign-in is NOT required at install time: the Gaffer panel has its own Sign in button, so do not stop if the desktop app's copy reports "Not logged in" or the CLI prompts for login. Only a missing Claude is a blocker.
   - Confirm with the user that After Effects 2022 or later is installed

   If any prerequisite is missing or not ready, STOP. Tell the user what's missing and link them to the install page. Do not proceed until the user confirms all prerequisites are ready.

2. **Check for existing install.** Look for an existing install at the extensions path:

   ```bash
   # macOS
   EXISTING="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"

   # Windows
   $existing = "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel"
   ```

   If the directory exists, tell the user: "Gaffer appears to already be installed at \<path\>. Reinstalling will overwrite it. Proceed?" Wait for their confirmation.

   - If they confirm: remove the directory, then proceed to step 3.
   - If they decline: stop and exit cleanly.

3. **Detect the platform.** This step only reads.

   ```bash
   # macOS
   if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then echo darwin-arm64; else echo darwin-x64; fi
   ```

   ```powershell
   # Windows (PowerShell)
   $env:PROCESSOR_ARCHITECTURE
   ```

   On macOS the command prints the platform name used in steps 5 to 8 (`darwin-arm64` for Apple Silicon, `darwin-x64` for Intel). Do not use `uname -m` instead: it reports `x86_64` in a terminal running under Rosetta on Apple Silicon. On Windows, `AMD64` or `ARM64` means the platform is `win-x64` (Windows on ARM runs it under its x64 emulation). Anything else (`x86`): stop and tell the user that Gaffer needs 64-bit Windows.

4. **Download the Gaffer package, verify it, and extract it** into the CEP extensions directory. The package and its checksum file come from the same GitHub release.

   ```bash
   # macOS
   INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
   DL="${TMPDIR:-/tmp}/gaffer-download"
   rm -rf "$DL" && mkdir -p "$DL" "$INSTALL_DIR" && cd "$DL" \
     && curl -fsSL --connect-timeout 20 --max-time 600 -o gaffer-install-mac.tar.gz https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-mac.tar.gz \
     && curl -fsSL --connect-timeout 20 --max-time 600 -o SHA256SUMS.txt https://github.com/spendolas/gaffer-ae/releases/latest/download/SHA256SUMS.txt \
     && grep ' gaffer-install-mac.tar.gz$' SHA256SUMS.txt | shasum -a 256 -c - \
     && tar -xzf gaffer-install-mac.tar.gz -C "$INSTALL_DIR" \
     && rm -f gaffer-install-mac.tar.gz SHA256SUMS.txt
   ```

   ```powershell
   # Windows (PowerShell)
   $installDir = "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel"
   $dl = "$env:TEMP\gaffer-download"
   Remove-Item -Recurse -Force $dl -ErrorAction SilentlyContinue
   New-Item -ItemType Directory -Path $dl, $installDir -Force | Out-Null
   curl.exe -fsSL --connect-timeout 20 --max-time 600 -o "$dl\gaffer-install-win.zip" https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-win.zip
   if ($LASTEXITCODE -ne 0) { throw "Download of gaffer-install-win.zip failed (curl exit $LASTEXITCODE)" }
   curl.exe -fsSL --connect-timeout 20 --max-time 600 -o "$dl\SHA256SUMS.txt" https://github.com/spendolas/gaffer-ae/releases/latest/download/SHA256SUMS.txt
   if ($LASTEXITCODE -ne 0) { throw "Download of SHA256SUMS.txt failed (curl exit $LASTEXITCODE)" }
   $want = ((Get-Content "$dl\SHA256SUMS.txt" | Where-Object { $_ -match ' gaffer-install-win\.zip$' }) -split '\s+')[0]
   $got = (Get-FileHash "$dl\gaffer-install-win.zip" -Algorithm SHA256).Hash.ToLower()
   if (-not $want -or $got -ne $want) { throw "gaffer-install-win.zip does not match SHA256SUMS.txt" }
   tar.exe -xf "$dl\gaffer-install-win.zip" -C $installDir
   if ($LASTEXITCODE -ne 0) { throw "Extract failed (tar exit $LASTEXITCODE)" }
   Remove-Item -Force "$dl\gaffer-install-win.zip", "$dl\SHA256SUMS.txt"
   ```

   On macOS the checksum line must print `gaffer-install-mac.tar.gz: OK`. If a download fails or the checksum does not match, stop and report it; do not extract the package.

<!-- runtime-pins:begin. Generated from panel/daemon/runtime-pins.json by scripts/readme-pins.mjs; edit the script, then run: node scripts/readme-pins.mjs --write -->
5. **Download the Node.js runtime.** Gaffer runs on the official Node.js v24.22.1 from nodejs.org, kept as a single file inside Gaffer's own folder. Nothing is installed system-wide and nothing is added to PATH. Run only the block for the platform step 3 printed.

   **`darwin-arm64`** (macOS, Apple Silicon)

   ```bash
   DL="${TMPDIR:-/tmp}/gaffer-download"
   mkdir -p "$DL" && curl -fsSL --connect-timeout 20 --max-time 600 -o "$DL/node-v24.22.1-darwin-arm64.tar.gz" https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz
   ```

   If that download fails, for example because your network blocks nodejs.org, download the same file from Gaffer's mirror: `https://github.com/spendolas/gaffer-ae/releases/download/node-v24.22.1/node-v24.22.1-darwin-arm64.tar.gz`. The mirror is byte-identical: its SHA-256 equals the value in nodejs.org's SHASUMS256.txt for this file.

   **`darwin-x64`** (macOS, Intel)

   ```bash
   DL="${TMPDIR:-/tmp}/gaffer-download"
   mkdir -p "$DL" && curl -fsSL --connect-timeout 20 --max-time 600 -o "$DL/node-v24.22.1-darwin-x64.tar.gz" https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-x64.tar.gz
   ```

   If that download fails, for example because your network blocks nodejs.org, download the same file from Gaffer's mirror: `https://github.com/spendolas/gaffer-ae/releases/download/node-v24.22.1/node-v24.22.1-darwin-x64.tar.gz`. The mirror is byte-identical: its SHA-256 equals the value in nodejs.org's SHASUMS256.txt for this file.

   **`win-x64`** (Windows)

   ```powershell
   $dl = "$env:TEMP\gaffer-download"
   New-Item -ItemType Directory -Path $dl -Force | Out-Null
   curl.exe -fsSL --connect-timeout 20 --max-time 600 -o "$dl\node-v24.22.1-win-x64.zip" https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip
   if ($LASTEXITCODE -ne 0) { Write-Host "Download failed (curl exit $LASTEXITCODE)" }
   ```

   If that download fails, for example because your network blocks nodejs.org, download the same file from Gaffer's mirror: `https://github.com/spendolas/gaffer-ae/releases/download/node-v24.22.1/node-v24.22.1-win-x64.zip`. The mirror is byte-identical: its SHA-256 equals the value in nodejs.org's SHASUMS256.txt for this file.

   For the mirror, run the same command with the mirror URL in place of the nodejs.org URL, and tell the user that you used the mirror. If the mirror download fails too, stop and tell the user: "Could not download the Node runtime from nodejs.org or Gaffer's mirror. Check your network and try again."

6. **Verify the SHA-256 of the Node.js download.** It must equal the value written here for your platform.

   **`darwin-arm64`** (macOS, Apple Silicon) expected SHA-256 `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7`

   ```bash
   cd "${TMPDIR:-/tmp}/gaffer-download" && echo "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7  node-v24.22.1-darwin-arm64.tar.gz" | shasum -a 256 -c -
   ```

   It must print `node-v24.22.1-darwin-arm64.tar.gz: OK`.

   **`darwin-x64`** (macOS, Intel) expected SHA-256 `d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035`

   ```bash
   cd "${TMPDIR:-/tmp}/gaffer-download" && echo "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035  node-v24.22.1-darwin-x64.tar.gz" | shasum -a 256 -c -
   ```

   It must print `node-v24.22.1-darwin-x64.tar.gz: OK`.

   **`win-x64`** (Windows) expected SHA-256 `d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5`

   ```powershell
   $got = (Get-FileHash "$env:TEMP\gaffer-download\node-v24.22.1-win-x64.zip" -Algorithm SHA256).Hash.ToLower()
   if ($got -eq "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5") { "SHA-256 OK" } else { "SHA-256 MISMATCH: $got" }
   ```

   It must print `SHA-256 OK`.

   On a mismatch, delete the downloaded file. If it came from nodejs.org, download it once from the mirror (step 5) and check again. If the mirror's copy does not match either, stop and tell the user that the download did not match the expected checksum. Never extract an archive that failed this check.

7. **Extract only the `node` binary into Gaffer's folder, then delete the archive.** The archive also contains npm and other tools; Gaffer needs only the one file.

   **`darwin-arm64`** (macOS, Apple Silicon)

   ```bash
   INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
   DL="${TMPDIR:-/tmp}/gaffer-download"
   mkdir -p "$INSTALL_DIR/daemon/runtime" && tar -xzf "$DL/node-v24.22.1-darwin-arm64.tar.gz" -C "$INSTALL_DIR/daemon/runtime" --strip-components=2 node-v24.22.1-darwin-arm64/bin/node && rm -rf "$DL"
   ```

   **`darwin-x64`** (macOS, Intel)

   ```bash
   INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
   DL="${TMPDIR:-/tmp}/gaffer-download"
   mkdir -p "$INSTALL_DIR/daemon/runtime" && tar -xzf "$DL/node-v24.22.1-darwin-x64.tar.gz" -C "$INSTALL_DIR/daemon/runtime" --strip-components=2 node-v24.22.1-darwin-x64/bin/node && rm -rf "$DL"
   ```

   **`win-x64`** (Windows)

   ```powershell
   $installDir = "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel"
   $dl = "$env:TEMP\gaffer-download"
   $rt = "$installDir\daemon\runtime"
   New-Item -ItemType Directory -Path $rt -Force | Out-Null
   tar.exe -xf "$dl\node-v24.22.1-win-x64.zip" -C $rt node-v24.22.1-win-x64/node.exe
   if ($LASTEXITCODE -eq 0) {
     Move-Item -Force "$rt\node-v24.22.1-win-x64\node.exe" "$rt\node.exe"
     Remove-Item -Recurse -Force "$rt\node-v24.22.1-win-x64", $dl
   } else { Write-Host "Extract failed (tar exit $LASTEXITCODE)" }
   ```

   The result is one file: `daemon/runtime/node` (Windows: `daemon\runtime\node.exe`) inside the install folder. Delete the archive and any download folder you created, including empty ones.

8. **Verify the runtime's code signature, then run it once.** If nodejs.org is unreachable, the code signature is the independent check. It shows the file was signed by the Node.js project and not changed since.

   **`darwin-arm64`** (macOS, Apple Silicon)

   ```bash
   RT="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel/daemon/runtime"
   codesign --verify --strict "$RT/node" \
     && codesign -dv "$RT/node" 2>&1 | grep -x "TeamIdentifier=HX7739G8FX" \
     && "$RT/node" --version | grep -x "v24.22.1" \
     && printf '%s\n' "v24.22.1 darwin-arm64" > "$RT/VERSION"
   ```

   It must print `TeamIdentifier=HX7739G8FX` (the Node.js Foundation's Apple Developer ID) and then `v24.22.1`. The last command records the verified version only when every check passed.

   **`darwin-x64`** (macOS, Intel)

   ```bash
   RT="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel/daemon/runtime"
   codesign --verify --strict "$RT/node" \
     && codesign -dv "$RT/node" 2>&1 | grep -x "TeamIdentifier=HX7739G8FX" \
     && "$RT/node" --version | grep -x "v24.22.1" \
     && printf '%s\n' "v24.22.1 darwin-x64" > "$RT/VERSION"
   ```

   It must print `TeamIdentifier=HX7739G8FX` (the Node.js Foundation's Apple Developer ID) and then `v24.22.1`. The last command records the verified version only when every check passed.

   **`win-x64`** (Windows)

   ```powershell
   $rt = "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel\daemon\runtime"
   $sig = Get-AuthenticodeSignature "$rt\node.exe"
   "$($sig.Status) | $($sig.SignerCertificate.Subject)"
   if ($sig.Status -eq "Valid" -and $sig.SignerCertificate.Subject -like "*OpenJS Foundation*") {
     $ver = & "$rt\node.exe" --version
     $ver
     if ($ver -eq "v24.22.1") { Set-Content -LiteralPath "$rt\VERSION" -Value "v24.22.1 win-x64" -Encoding Ascii }
   }
   ```

   The first line must start with `Valid` and name `OpenJS Foundation`, and the second must be `v24.22.1`. The first run can take several seconds while Windows Defender scans the new file; later runs are fast. The verified version is recorded only when every check passed.

   If the signature check or the version check fails, delete the `daemon/runtime` folder, stop and tell the user: "The Node runtime's signature could not be verified. Nothing was installed."
<!-- runtime-pins:end -->

9. **Turn on the CEP developer mode flag.** This is a user preference that lets After Effects load extensions that are not signed through Adobe; it installs nothing. Tell the user that in one sentence, then set it:
   ```bash
   # macOS: covers AE 2022 (CSXS 11), 2025 (CSXS 12), 2026+ (CSXS 13+)
   for v in 11 12 13; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
   ```

   ```powershell
   # Windows (PowerShell)
   foreach ($v in @("11","12","13")) {
     $k = "HKCU:\Software\Adobe\CSXS.$v"
     if (!(Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
     Set-ItemProperty -Path $k -Name PlayerDebugMode -Value 1 -Type DWord
   }
   ```

10. **Find Claude and decide whether to pin it.** The daemon looks for Claude on its own at runtime, in this order: a pin in Gaffer's per-user config, then the Claude desktop app's bundled Claude Code (newest version), then a standalone `claude` CLI. The pin, if any, goes into Gaffer's per-user config file, which lives OUTSIDE the extension directory (`~/Library/Application Support/Gaffer/config.json` on macOS, `%APPDATA%\Gaffer\config.json` on Windows) so reinstalls and updates never touch it. That file also holds the install's anonymous `installId` and settings, so MERGE into it, never overwrite it.

    a. Detect both copies and report what you found, with versions:
    ```bash
    # macOS
    APP_CLAUDE="$(ls -t "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -n 1)"
    CLI_CLAUDE="$(command -v claude 2>/dev/null || true)"
    # zsh prints "alias claude=..." or a function name for a shell-managed install; only an absolute path counts.
    case "$CLI_CLAUDE" in /*) ;; *) CLI_CLAUDE="";; esac
    [ -n "$APP_CLAUDE" ] && echo "Desktop app Claude Code: $APP_CLAUDE ($("$APP_CLAUDE" --version 2>/dev/null))"
    [ -n "$CLI_CLAUDE" ] && echo "Standalone CLI: $CLI_CLAUDE ($("$CLI_CLAUDE" --version 2>/dev/null))"
    ```

    ```powershell
    # Windows (PowerShell). Only a real .exe counts as the CLI; npm shims (.ps1/.cmd)
    # cannot be spawned by the daemon.
    $appClaude = Get-ChildItem "$env:APPDATA\Claude\claude-code" -Recurse -Filter claude.exe -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    $cliClaude = if ($cmd -and $cmd.Source -and $cmd.Source -match '\.exe$') { $cmd.Source } else { $null }
    if ($appClaude) { Write-Host "Desktop app Claude Code: $appClaude ($(& $appClaude --version))" }
    if ($cliClaude) { Write-Host "Standalone CLI: $cliClaude ($(& $cliClaude --version))" }
    ```

    b. Decide:
    - **Neither found:** STOP. Tell the user to install the Claude desktop app from https://claude.com/download (recommended, it keeps its Claude Code up to date by itself) or Claude Code from https://claude.ai/code, then come back. Do not continue until one is installed.
    - **Only one found:** do NOT pin anything. The daemon finds it on its own.
    - **Both found:** show the user both paths and versions. Explain that the desktop app's copy updates itself along with the app, while the CLI is whatever they installed and update themselves. Ask which one Gaffer should use, then pin the MODE (not a path) by merging `"claudeBin": "app"` or `"claudeBin": "cli"` into the config file. On macOS this uses the Node.js runtime from step 7, so no system Node.js is needed:
    ```bash
    # macOS: replace MODE with app or cli
    MODE="app"
    INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
    CONFIG_DIR="$HOME/Library/Application Support/Gaffer"
    mkdir -p "$CONFIG_DIR"
    "$INSTALL_DIR/daemon/runtime/node" -e 'const fs=require("fs");const p=process.argv[1];let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};c.claudeBin=process.argv[2];fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")' "$CONFIG_DIR/config.json" "$MODE"
    ```

    ```powershell
    # Windows (PowerShell): replace MODE with app or cli
    $mode = "app"
    $configDir = "$env:APPDATA\Gaffer"
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    $configPath = "$configDir\config.json"
    $cfg = @{}
    if (Test-Path $configPath) {
      (Get-Content $configPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value }
    }
    $cfg.claudeBin = $mode
    $cfg | ConvertTo-Json -Compress | Set-Content $configPath
    ```
    Never pin the desktop app's full path: it contains a version folder and breaks on the app's next update. A full path is only for a standalone binary in an unusual location, and then only if the user asks for it.

    Note the paths step 10 printed: later steps need them.

11. **Register Gaffer's tools with Claude Code.** This lets a `claude` session in a terminal use Gaffer's tools while After Effects is open. The panel's own chat does not need it: it passes its MCP config to Claude inline. Before you run it, tell the user in one sentence: this adds one entry named `gaffer` to their Claude Code user settings (`~/.claude.json` on macOS, `%USERPROFILE%\.claude.json` on Windows), and `claude mcp remove gaffer -s user` removes it again. Use the standalone `claude` if step 10 found one; otherwise run the desktop app's copy with the same arguments. Both read the same user config, so registering once is enough. The snippet below re-derives the binary (or paste the literal path step 10 printed):
    ```bash
    # macOS
    APP_CLAUDE="$(ls -t "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -n 1)"
    CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
    case "$CLAUDE_BIN" in /*) ;; *) CLAUDE_BIN="$APP_CLAUDE";; esac
    [ -n "$CLAUDE_BIN" ] && "$CLAUDE_BIN" mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp
    ```

    ```powershell
    # Windows (PowerShell)
    $appClaude = Get-ChildItem "$env:APPDATA\Claude\claude-code" -Recurse -Filter claude.exe -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    $claudeBin = if ($cmd -and $cmd.Source -and $cmd.Source -match '\.exe$') { $cmd.Source } elseif ($appClaude) { $appClaude } else { $null }
    if ($claudeBin) { & $claudeBin mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp }
    ```
    If the user says they do not want the entry, skip this step and step 12a. If neither a CLI nor a runnable desktop app copy is available here, note that to the user ("Gaffer's tools will not be registered for Claude Code in a terminal; the panel chat still works") and CONTINUE with step 12. Do not stop.

12. **Restart After Effects and verify.** Tell the user: "Restart After Effects. Open Window > Extensions > Gaffer. The daemon starts automatically when the panel loads."

    Note: Gaffer's MCP tools are only available while the panel is open in After Effects. If you run `claude` in a terminal without AE open, the tools will appear disconnected. Open AE first.

    After the user has restarted After Effects and confirmed the panel is visible under Window > Extensions > Gaffer, run these checks:

    a. Only if step 11 registered the server: run `mcp list` with the same binary as step 11. Re-derive it (macOS: `"$(ls -t "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -n 1)" mcp list` for the desktop app's copy, or `claude mcp list` for a standalone CLI; Windows: the `Get-ChildItem` line from step 11, then `& $claudeBin mcp list`) or use the literal path step 10 printed. Confirm `gaffer` appears and shows as connected. If not connected, the panel is probably not open in AE yet. Ask the user to confirm the panel is open. If step 11 was skipped, skip this check too.

    b. Ask Claude to call `getProjectSummary` via the Gaffer MCP. If it returns a valid JSON response describing the project, the install is working end-to-end. If it errors, check the troubleshooting section.

    Report the result to the user: "Gaffer is installed and verified" or "Gaffer is installed but verification failed, see troubleshooting."

### Troubleshooting

- **Panel doesn't appear in AE menu:** PlayerDebugMode not set, or AE needs full restart (not just panel reload).
- **Panel shows "Disconnected":** Daemon failed to start. Check `/tmp/gaffer-daemon.log` (macOS) or `%TEMP%\gaffer-daemon.log` (Windows). Also check that `daemon/runtime/node` (Windows: `daemon\runtime\node.exe`) exists in the install folder; if it is missing, repeat steps 5 to 8.
- **Panel says Gaffer's runtime is damaged or missing:** the Node.js runtime file in the install folder is not the verified one (for example antivirus removed or changed it). Open Settings and run Update, or reinstall.
- **Panel says "macOS blocked Gaffer's runtime":** reinstall Gaffer. If it happens again, check whether security software on the Mac blocks programs inside `~/Library/Application Support`.
- **The Node.js download fails from both nodejs.org and the mirror:** the network blocks both. Gaffer needs `nodejs.org` or `github.com` with `release-assets.githubusercontent.com` once at install time, and again only when an update changes the Node.js version. Ask the network administrator to allow one of them; do not work around certificate errors.
- **Windows with a roaming profile:** the runtime (about 94 MB) lives in the extension folder under `%APPDATA%`, which roams. If roaming sync is slow, ask your administrator to exclude `%APPDATA%\Adobe\CEP\extensions\com.gaffer.panel\daemon\runtime`.
- **MCP tools not available in a terminal Claude Code session:** Run the step 11 registration again (`<claude binary> mcp add ...`, where the binary is the standalone `claude` if you have one, otherwise the desktop app's copy from step 10; `claude` alone may not be on PATH). Verify with `<claude binary> mcp list`. The panel chat does not need this registration.
- **MCP tools show as disconnected in `mcp list`:** Most common cause: the Gaffer panel is not open in After Effects. Open AE, then open Window > Extensions > Gaffer, then re-run `mcp list` with the same binary. If the panel is open and it still shows disconnected, check the panel's connection indicator. If the panel also shows disconnected, the daemon failed to start, see "Panel shows Disconnected" above.
- **Install stops at prerequisites check but I have everything:** The check runs commands directly. If `claude` isn't on your shell's PATH, the check fails even if it is installed. Open a fresh terminal, run `which claude` (macOS) or `where.exe claude` (Windows) to confirm. The desktop app's copy is found by step 10 without PATH.
- **`claude` errors or asks me to log in:** Gaffer doesn't install authentication, but it does not need you to be signed in at install time either. Finish the install, open the panel and use its Sign in button. If you prefer, run `claude` once manually and complete the login flow instead.
- **Remove the Claude Code registration:** `claude mcp remove gaffer -s user` (or the desktop app's copy from step 10 with the same arguments). The panel chat keeps working.
- **Broken after reinstall:** If you chose "reinstall" and it's still broken, manually remove the extensions directory (path in step 2), then re-run the install fresh. Your per-install settings and anonymous install identity live outside that directory (`~/Library/Application Support/Gaffer/config.json` on macOS, `%APPDATA%\Gaffer\config.json` on Windows) and survive the deletion; only remove that folder too if you want a completely clean slate.
- **Chat fails with `Error: claude cli not found` despite Claude being installed:** The daemon looks for the Claude desktop app's bundled Claude Code first, then a standalone `claude` CLI. If neither is installed, install the desktop app from https://claude.com/download or Claude Code from https://claude.ai/code. If one is installed but not found, the error message lists where the daemon looked. You can steer it by adding `"claudeBin"` to `~/Library/Application Support/Gaffer/config.json` (macOS) or `%APPDATA%\Gaffer\config.json` (Windows), keeping any other keys already in the file: `"app"` uses only the desktop app's copy, `"cli"` uses only a standalone CLI, and a full path (for example from `which claude`) uses exactly that binary. Do not pin the desktop app's own path, it changes with every app update. The daemon log prints the exact config path on startup (`Gaffer: config at ...`) and which Claude it picked (`Gaffer: claude found ...`).

</details>

---

## Updating (instructions for Claude)

- **v0.11.0 or newer:** the panel checks the latest GitHub release (`https://api.github.com/repos/spendolas/gaffer-ae/releases/latest`) and shows an update banner when it is newer than the installed version. The user clicks Update and the bundled `panel/daemon/update.sh` (macOS) / `update.ps1` (Windows) downloads the release asset (`gaffer-update-mac.tar.gz` / `gaffer-update-win.zip`), stops the daemon, replaces files, keeps chat history, settings, unsent usage statistics, the icon cache and the Node.js runtime, and writes `version.json` last so the panel reloads only once everything is in place. Updates no longer run npm. When a release changes the pinned Node.js version, the updater first downloads and verifies the new runtime from nodejs.org (or Gaffer's mirror), and the install stays as it was if that fails.
- **Updating from v0.11.x:** that one update still runs the older update script, which keeps using a system Node.js until the next update installs Gaffer's own runtime.
- **v0.2.0 to v0.10.8:** the panel checks `panel/version.json` on `main` and shows the same banner. That one update to v0.11.0 still runs the older update script; every update after it comes from releases as described above.
- **v0.1.0 (no banner, no updater):** reinstall with the install steps above, or re-run the installer from a fresh checkout: download or clone this repo, then run `scripts/install-mac.sh` or `scripts/install-win.ps1`. The installer from a checkout is for developers: it runs the daemon from source, so it needs Node 20+ and npm. Ask the user to restart After Effects afterwards.
- If an update fails, the panel says so and the updater log has details: `/tmp/gaffer-update.log` (macOS) / `%TEMP%\gaffer-update.log` (Windows). The update script can also be run manually from the extension's `daemon/` folder.
- Never update a dev install (extension dir symlinked to a git checkout) with these scripts. Use `git pull`.
- **Networks behind a proxy or firewall:** besides `github.com`, allow `api.github.com` (update check) and `release-assets.githubusercontent.com` (downloads), or the update check and the install and update downloads fail. The Node.js runtime comes from `nodejs.org`, with Gaffer's GitHub mirror as the fallback.

---

## What it does

The panel auto-starts a local daemon that connects Claude to After Effects via MCP.

- **Chat in the panel:** ask Claude to modify your AE project directly
- **Use Claude Code:** any `claude` session sees the Gaffer MCP tools automatically

### Chat features

- **Drop or paste images** into the panel: claude reads them as visual input. Click any thumbnail to zoom.
- **MCP server tiles** in the activity drawer: one tile per Connected MCP server (Grip, Notion, Figma, ...) with brand icons and color-coded states: enabled, available, needs-auth (click to authorize), failed. Selection is stored locally, never committed.
- **Model, context, and effort selects:** discovered from your installed `claude` CLI, not hardcoded: model aliases (Fable / Opus / Sonnet / Haiku), context window (Latest, 1M, or pinned versions like 4.6), and reasoning effort (Low through Max).
- **Self-healing sessions:** if the CLI's session storage is wiped (CLI updates, re-auth), the panel detects the dead session and retries on a fresh one automatically.

### MCP Tools

| Tool | Description |
|------|-------------|
| `runJSX` | Execute ExtendScript in AE (undo-grouped, try/caught) |
| `getProjectSummary` | Active comp, selected layers, project path |
| `getSelectedLayers` | Detailed snapshot of selected layers (transform values, keyframe presence, expressions) |
| `listCompositions` | All comps in the project, with dims/fps/duration |
| `listFootage` | All footage items, including missing-media flag |
| `listFonts` | Installed fonts (postScriptName) for text layer creation |
| `listEffectMatchNames` | All effects grouped by category (cached) |
| `listExpressions` | Recursive dump of every expression in the active comp |
| `listExpressionControls` | Slider/Checkbox/Color/Point/Layer/Dropdown controls; returns ready-to-use bindRef strings |
| `getRenderQueue` | Render queue state (status per item, output paths) |
| `getLayerKeyframes` | Keyframe times/values/interpolation for one property |
| `findLayers` | Search layers across the project by name regex, effect, or expression substring |
| `whereUsed` | Find every comp + layer that uses a given footage or precomp item |
| `captureActiveComp` | Screenshot current frame as PNG |
| `captureFrame` | PNG of any comp at any time |
| `captureLayer` | Render a single layer in isolation (auto solo + restore) |
| `relinkFootage` | Repoint a missing or existing footage item to a new file |
| `addToRenderQueue` | Queue a comp for render with output path + template (does not start the render) |
| `importFromFigma` | Deterministic Figma → AE layer translation |
| `listMarkers` | Comp + layer markers with time, duration, comment, chapter/url/cue-point |
| `listTextLayers` | Every text layer's content + type styling (font, size, fill/stroke, box bounds), active comp or whole project |
| `getLayerEffects` | One layer's full effect stack with parameter values, keyframe counts, expressions |
| `getShapeContents` | Structured shape-layer contents tree + all masks; optional raw vertex data |
| `getProjectTree` | Full project-panel hierarchy: folders, comps, footage, solids with parent ids |
| `getProjectSettings` | AE version, color depth/space, expression engine, GPU acceleration, time display |

### Claude Code skill (optional)

`skills/gaffer/SKILL.md` is a field guide distilled from real Gaffer sessions: tool selection, ExtendScript survival rules, shape/expression techniques. Installing it makes any Claude Code session sharper with the Gaffer tools:

```bash
mkdir -p ~/.claude/skills/gaffer && curl -sL https://raw.githubusercontent.com/spendolas/gaffer-ae/main/skills/gaffer/SKILL.md -o ~/.claude/skills/gaffer/SKILL.md
```

### Architecture

```
Panel (CEP in AE) <-WebSocket-> Daemon (Gaffer's own Node.js runtime) <-MCP HTTP-> Claude
```

Every mutation is wrapped in an undo group prefixed "Gaffer:", so it is always Cmd+Z safe.
