# Install Gaffer

<!-- Generated from README.md by scripts/site/build-install-md.mjs. Do not edit by hand. -->

Gaffer is an After Effects automation agent: a panel inside After Effects where Claude controls the
project by writing ExtendScript through MCP tools. Source and releases: https://github.com/spendolas/gaffer-ae

This page is the install procedure, written for Claude to carry out for a user who asked it to
"Install Gaffer by following https://gafferae.com/install.md". Nothing here is pinned to a version:
every download is the latest GitHub release.

## Requirements

- After Effects 2022 or later (macOS or Windows)
- Claude: either the [Claude desktop app](https://claude.com/download) (it bundles Claude Code, no separate install needed) or the standalone [Claude Code](https://claude.ai/code) CLI. On Windows use the desktop app or the native installer, not `npm install -g` (the daemon can't launch npm's script shims)
- Node.js 20 or later ([install](https://nodejs.org))
- No git required

## First: confirm you are running on the user's own computer

Gaffer installs into After Effects on the user's own computer, so these steps only work when you run directly on that computer, with its real file system. They do not work from a sandbox, a virtual machine or a cloud session: for example Claude Cowork (it runs commands in a Linux virtual machine), Claude Code on the web, or a container.

Check and report it before anything else:

- macOS: `uname -s` prints `Darwin`.
- Windows (PowerShell): `$env:OS` prints `Windows_NT`.

If it prints `Linux` or anything else, or you know you are in a sandbox, STOP. Do not install anything and do not try to work around it. Tell the user: "I'm running in a sandbox, not on your computer, so I can't install Gaffer from here. Open Claude Code on your Mac or PC (the Code tab in the Claude desktop app, or `claude` in a terminal) and give it the same prompt."

## Rules for Claude

Before you begin, read these rules. They apply to every step below.

- Follow the steps in order. Do not skip, reorder, or combine steps.
- Do not improvise. If a step seems wrong for this system, stop and ask the user rather than deviating.
- Do not install prerequisites the user is missing (Node.js, Claude Code, After Effects). If a prerequisite is missing, stop and tell the user what to install, with a link. Resume only after they confirm it's installed.
- Do not add shell aliases, modify the user's PATH, or change any config outside the paths explicitly named in these steps.
- If any step fails, stop. Report the exact error. Do not retry with modifications unless the user asks you to.
- After the install completes, run the verification step. Do not skip it.

## What to do

1. **Check prerequisites.** Run these checks and report the results to the user before proceeding:

   - `node --version` — must be 20 or higher
   - Claude: either the Claude desktop app is installed (step 6 shows where its bundled Claude Code lives) or `claude --version` works in a terminal. At least one must be present. Gaffer itself does not need the standalone CLI. Sign-in is NOT required at install time: the Gaffer panel has its own Sign in button, so do not stop if the desktop app's copy reports "Not logged in" or the CLI prompts for login. Only a missing Claude is a blocker.
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

3. **Download and extract** the latest release directly into the CEP extensions directory (no repo clone needed):
   ```bash
   # macOS
   INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
   mkdir -p "$INSTALL_DIR"
   ARCHIVE="${TMPDIR:-/tmp}/gaffer-install.tar.gz"
   curl -fsSL https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-mac.tar.gz -o "$ARCHIVE" && tar -xzf "$ARCHIVE" -C "$INSTALL_DIR" && rm -f "$ARCHIVE"

   # Windows (PowerShell)
   $installDir = "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel"
   New-Item -ItemType Directory -Path $installDir -Force | Out-Null
   Remove-Item -Recurse -Force "$env:TEMP\gaffer-extract" -ErrorAction SilentlyContinue
   Invoke-WebRequest -Uri "https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-win.zip" -OutFile "$env:TEMP\gaffer-install.zip" -UseBasicParsing
   Expand-Archive -Path "$env:TEMP\gaffer-install.zip" -DestinationPath "$env:TEMP\gaffer-extract" -Force
   Copy-Item -Recurse -Force "$env:TEMP\gaffer-extract\*" $installDir
   Remove-Item -Recurse -Force "$env:TEMP\gaffer-install.zip", "$env:TEMP\gaffer-extract"
   ```

4. **Install daemon dependencies:**
   ```bash
   # macOS
   cd "$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel/daemon" && npm install --omit=dev
   
   # Windows
   Push-Location "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel\daemon"
   npm install --omit=dev
   Pop-Location
   ```

5. **Enable unsigned CEP extensions:**
   ```bash
   # macOS — covers AE 2022 (CSXS 11), 2025 (CSXS 12), 2026+ (CSXS 13+)
   for v in 11 12 13; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
   
   # Windows (PowerShell)
   foreach ($v in @("11","12","13")) { 
     $k = "HKCU:\Software\Adobe\CSXS.$v"
     if (!(Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
     Set-ItemProperty -Path $k -Name PlayerDebugMode -Value 1 -Type DWord
   }
   ```

6. **Find Claude and decide whether to pin it.** The daemon looks for Claude on its own at runtime, in this order: a pin in Gaffer's per-user config, then the Claude desktop app's bundled Claude Code (newest version), then a standalone `claude` CLI. The pin, if any, goes into Gaffer's per-user config file, which lives OUTSIDE the extension directory (`~/Library/Application Support/Gaffer/config.json` on macOS, `%APPDATA%\Gaffer\config.json` on Windows) so reinstalls and updates never touch it. That file also holds the install's anonymous `installId` and settings, so MERGE into it, never overwrite it.

   a. Detect both copies and report what you found, with versions:
   ```bash
   # macOS
   APP_CLAUDE="$(ls -t "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -n 1)"
   CLI_CLAUDE="$(command -v claude 2>/dev/null || true)"
   # zsh prints "alias claude=..." or a function name for a shell-managed install; only an absolute path counts.
   case "$CLI_CLAUDE" in /*) ;; *) CLI_CLAUDE="";; esac
   [ -n "$APP_CLAUDE" ] && echo "Desktop app Claude Code: $APP_CLAUDE ($("$APP_CLAUDE" --version 2>/dev/null))"
   [ -n "$CLI_CLAUDE" ] && echo "Standalone CLI: $CLI_CLAUDE ($("$CLI_CLAUDE" --version 2>/dev/null))"

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
   - **Both found:** show the user both paths and versions. Explain that the desktop app's copy updates itself along with the app, while the CLI is whatever they installed and update themselves. Ask which one Gaffer should use, then pin the MODE (not a path) by merging `"claudeBin": "app"` or `"claudeBin": "cli"` into the config file:
   ```bash
   # macOS: replace MODE with app or cli
   MODE="app"
   CONFIG_DIR="$HOME/Library/Application Support/Gaffer"
   mkdir -p "$CONFIG_DIR"
   node -e 'const fs=require("fs");const p=process.argv[1];let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){};c.claudeBin=process.argv[2];fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")' "$CONFIG_DIR/config.json" "$MODE"

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

   Note the paths step 6 printed: later steps need them, and shell variables do not carry over between your separate command runs.

7. **Register the MCP server with Claude Code (optional).** This registration is only for using Gaffer's tools from Claude Code OUTSIDE After Effects (a `claude` session in a terminal). The panel's own chat does not need it: it passes its MCP config to Claude inline. Use the standalone `claude` if step 6 found one; otherwise run the desktop app's copy with the same arguments. Both read the same user config, so registering once is enough. Shell variables from step 6 do not persist between your command runs, so the snippet below re-derives the binary (or paste the literal path step 6 printed):
   ```bash
   # macOS
   APP_CLAUDE="$(ls -t "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -n 1)"
   CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
   case "$CLAUDE_BIN" in /*) ;; *) CLAUDE_BIN="$APP_CLAUDE";; esac
   [ -n "$CLAUDE_BIN" ] && "$CLAUDE_BIN" mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp

   # Windows (PowerShell)
   $appClaude = Get-ChildItem "$env:APPDATA\Claude\claude-code" -Recurse -Filter claude.exe -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
   $cmd = Get-Command claude -ErrorAction SilentlyContinue
   $claudeBin = if ($cmd -and $cmd.Source -and $cmd.Source -match '\.exe$') { $cmd.Source } elseif ($appClaude) { $appClaude } else { $null }
   if ($claudeBin) { & $claudeBin mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp }
   ```
   If neither a CLI nor a runnable desktop app copy is available here, note that to the user ("Gaffer's tools will not be registered for Claude Code in a terminal; the panel chat still works") and CONTINUE with step 8. Do not stop.

8. **Tell the user:** "Restart After Effects. Open Window > Extensions > Gaffer. The daemon starts automatically when the panel loads."

   Note: Gaffer's MCP tools are only available while the panel is open in After Effects. If you run `claude` in a terminal without AE open, the tools will appear disconnected. Open AE first.

9. **Verify the install.** After the user has restarted After Effects and confirmed the panel is visible under Window > Extensions > Gaffer, run these checks:

   a. Only if step 7 registered the server: run `mcp list` with the same binary as step 7. Shell variables do not persist between your command runs, so re-derive it (macOS: `"$(ls -t "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -n 1)" mcp list` for the desktop app's copy, or `claude mcp list` for a standalone CLI; Windows: the `Get-ChildItem` line from step 7, then `& $claudeBin mcp list`) or use the literal path step 6 printed. Confirm `gaffer` appears and shows as connected. If not connected, the panel is probably not open in AE yet. Ask the user to confirm the panel is open. If step 7 was skipped, skip this check too.

   b. Ask Claude to call `getProjectSummary` via the Gaffer MCP. If it returns a valid JSON response describing the project, the install is working end-to-end. If it errors, check the troubleshooting section.

   Report the result to the user: "Gaffer is installed and verified" or "Gaffer is installed but verification failed, see troubleshooting."

## Troubleshooting

- **Panel doesn't appear in AE menu:** PlayerDebugMode not set, or AE needs full restart (not just panel reload).
- **Panel shows "Disconnected":** Daemon failed to start. Check `/tmp/gaffer-daemon.log` (macOS) or `%TEMP%\gaffer-daemon.log` (Windows). Usually a missing `npm install`.
- **MCP tools not available in a terminal Claude Code session:** Run the step 7 registration again (`<claude binary> mcp add ...`, where the binary is the standalone `claude` if you have one, otherwise the desktop app's copy from step 6; `claude` alone may not be on PATH). Verify with `<claude binary> mcp list`. The panel chat does not need this registration.
- **MCP tools show as disconnected in `mcp list`:** Most common cause: the Gaffer panel is not open in After Effects. Open AE, then open Window > Extensions > Gaffer, then re-run `mcp list` with the same binary. If the panel is open and it still shows disconnected, check the panel's connection indicator. If the panel also shows disconnected, the daemon failed to start, see "Panel shows Disconnected" above.
- **Install says my Node version is too old:** Gaffer requires Node 20+. Check with `node --version`. If you manage Node with nvm or fnm, switch to a supported version before re-running the install. Otherwise install from [nodejs.org](https://nodejs.org).
- **Install stops at prerequisites check but I have everything:** The check runs commands directly. If `claude` or `node` aren't on your shell's PATH, the check fails even if they're installed. Open a fresh terminal, run `which node` and `which claude` (macOS) or `where.exe node` and `where.exe claude` (Windows) to confirm. Fix PATH before re-running.
- **`claude` errors or asks me to log in:** Gaffer doesn't install authentication, but it does not need you to be signed in at install time either. Finish the install, open the panel and use its Sign in button. If you prefer, run `claude` once manually and complete the login flow instead.
- **Broken after reinstall:** If you chose "reinstall" and it's still broken, manually remove the extensions directory (path in step 2), then re-run the install fresh. Your per-install settings and anonymous install identity live outside that directory (`~/Library/Application Support/Gaffer/config.json` on macOS, `%APPDATA%\Gaffer\config.json` on Windows) and survive the deletion; only remove that folder too if you want a completely clean slate.
- **Chat fails with `Error: claude cli not found` despite Claude being installed:** The daemon looks for the Claude desktop app's bundled Claude Code first, then a standalone `claude` CLI. If neither is installed, install the desktop app from https://claude.com/download or Claude Code from https://claude.ai/code. If one is installed but not found, the error message lists where the daemon looked. You can steer it by adding `"claudeBin"` to `~/Library/Application Support/Gaffer/config.json` (macOS) or `%APPDATA%\Gaffer\config.json` (Windows), keeping any other keys already in the file: `"app"` uses only the desktop app's copy, `"cli"` uses only a standalone CLI, and a full path (for example from `which claude`) uses exactly that binary. Do not pin the desktop app's own path, it changes with every app update. The daemon log prints the exact config path on startup (`Gaffer: config at ...`) and which Claude it picked (`Gaffer: claude found ...`).
