# Gaffer

An After Effects automation agent. Chat with Claude directly inside an AE panel — Claude controls After Effects by writing ExtendScript via MCP tools.

## Quick Start

Open Claude Code and say:

> Install Gaffer from https://github.com/spendolas/gaffer-ae

Claude will handle the rest. Then restart After Effects and open **Window > Extensions > Gaffer**.

## Prerequisites

- After Effects 2022+
- Claude Code CLI ([install](https://claude.ai/code)) — on Windows use the native installer or desktop app, not `npm install -g` (the daemon can't launch npm's script shims)
- Node.js 18+ ([install](https://nodejs.org))
- No git required

---

## Install Instructions for Claude

<details>
<summary>Claude: read this section when asked to install Gaffer.</summary>

### Rules for Claude

Before you begin, read these rules. They apply to every step below.

- Follow the steps in order. Do not skip, reorder, or combine steps.
- Do not improvise. If a step seems wrong for this system, stop and ask the user rather than deviating.
- Do not install prerequisites the user is missing (Node.js, Claude Code, After Effects). If a prerequisite is missing, stop and tell the user what to install, with a link. Resume only after they confirm it's installed.
- Do not add shell aliases, modify the user's PATH, or change any config outside the paths explicitly named in these steps.
- If any step fails, stop. Report the exact error. Do not retry with modifications unless the user asks you to.
- After the install completes, run the verification step. Do not skip it.

### What to do

1. **Check prerequisites.** Run these checks and report the results to the user before proceeding:

   - `node --version` — must be 18 or higher
   - `claude --version` — must be present and authenticated (if the command errors or prompts for login, it is not ready)
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

3. **Download and extract** directly into the CEP extensions directory (no repo clone needed):
   ```bash
   # macOS
   INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
   mkdir -p "$INSTALL_DIR"
   curl -sL https://github.com/spendolas/gaffer-ae/archive/refs/heads/main.tar.gz | tar -xz --strip-components=2 -C "$INSTALL_DIR" gaffer-ae-main/panel
   
   # Windows (PowerShell)
   $installDir = "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel"
   New-Item -ItemType Directory -Path $installDir -Force | Out-Null
   Invoke-WebRequest -Uri "https://github.com/spendolas/gaffer-ae/archive/refs/heads/main.zip" -OutFile "$env:TEMP\gaffer.zip"
   Expand-Archive -Path "$env:TEMP\gaffer.zip" -DestinationPath "$env:TEMP\gaffer-extract" -Force
   Copy-Item -Recurse -Force "$env:TEMP\gaffer-extract\gaffer-ae-main\panel\*" $installDir
   Remove-Item -Recurse -Force "$env:TEMP\gaffer.zip", "$env:TEMP\gaffer-extract"
   ```

4. **Install daemon dependencies:**
   ```bash
   # macOS
   cd "$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel/daemon" && npm install --production
   
   # Windows
   Push-Location "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel\daemon"
   npm install --production
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

6. **Pin the claude binary path** so the daemon doesn't have to guess at runtime (AE-spawned subprocesses inherit a stripped PATH):
   ```bash
   # macOS
   CLAUDE_PATH="$(command -v claude)"
   INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
   if [ -n "$CLAUDE_PATH" ] && [ -x "$CLAUDE_PATH" ]; then
     printf '{"claudeBin":"%s"}\n' "$CLAUDE_PATH" > "$INSTALL_DIR/.gaffer-config.json"
   else
     echo "WARNING: claude not found on PATH, skipping config pin"
   fi

   # Windows (PowerShell) — pin ONLY a real .exe; npm shims (.ps1/.cmd)
   # cannot be spawned by the daemon and must not be pinned
   $cmd = Get-Command claude -ErrorAction SilentlyContinue
   $installDir = "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel"
   if ($cmd -and $cmd.Source -and $cmd.Source -match '\.exe$') {
     @{claudeBin=$cmd.Source} | ConvertTo-Json -Compress | Set-Content "$installDir\.gaffer-config.json"
   } else {
     Write-Host "No claude.exe on PATH - skipping pin; the daemon discovers standalone, WinGet, and desktop-app installs on its own"
   }
   ```

7. **Register the MCP server with Claude Code:**
   ```bash
   claude mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp
   ```

8. **Tell the user:** "Restart After Effects. Open Window > Extensions > Gaffer. The daemon starts automatically when the panel loads."

   Note: Gaffer's MCP tools are only available while the panel is open in After Effects. If you run `claude` in a terminal without AE open, the tools will appear disconnected. Open AE first.

9. **Verify the install.** After the user has restarted After Effects and confirmed the panel is visible under Window > Extensions > Gaffer, run these checks:

   a. `claude mcp list` — confirm `gaffer` appears and shows as connected. If not connected, the panel is probably not open in AE yet. Ask the user to confirm the panel is open.

   b. Ask Claude to call `getProjectSummary` via the Gaffer MCP. If it returns a valid JSON response describing the project, the install is working end-to-end. If it errors, check the troubleshooting section.

   Report the result to the user: "Gaffer is installed and verified" or "Gaffer is installed but verification failed — see troubleshooting."

### Troubleshooting

- **Panel doesn't appear in AE menu:** PlayerDebugMode not set, or AE needs full restart (not just panel reload).
- **Panel shows "Disconnected":** Daemon failed to start. Check `/tmp/gaffer-daemon.log` (macOS) or `%TEMP%\gaffer-daemon.log` (Windows). Usually a missing `npm install`.
- **MCP tools not available:** Run `claude mcp add` step again. Verify with `claude mcp list`.
- **MCP tools show as disconnected in `claude mcp list`:** Most common cause — the Gaffer panel is not open in After Effects. Open AE, then open Window > Extensions > Gaffer, then re-run `claude mcp list`. If the panel is open and it still shows disconnected, check the panel's connection indicator. If the panel also shows disconnected, the daemon failed to start — see "Panel shows Disconnected" above.
- **Install says my Node version is too old:** Gaffer requires Node 18+. Check with `node --version`. If you manage Node with nvm or fnm, switch to a supported version before re-running the install. Otherwise install from [nodejs.org](https://nodejs.org).
- **Install stops at prerequisites check but I have everything:** The check runs commands directly. If `claude` or `node` aren't on your shell's PATH, the check fails even if they're installed. Open a fresh terminal, run `which node` and `which claude` (macOS) or `where.exe node` and `where.exe claude` (Windows) to confirm. Fix PATH before re-running.
- **`claude` errors or asks me to log in:** Gaffer doesn't install authentication. Run `claude` once manually, complete the login flow, confirm it works, then re-run the Gaffer install.
- **Broken after reinstall:** If you chose "reinstall" and it's still broken, manually remove the extensions directory (path in step 2), then re-run the install fresh.
- **Chat fails with `Error: claude cli not found` despite Claude being installed:** The daemon couldn't locate the `claude` binary. Override discovery by writing `<extension-dir>/.gaffer-config.json` with `{"claudeBin": "/full/path/to/claude"}`. Find your path with `which claude` from a terminal.

</details>

---

## Updating (instructions for Claude)

- **v0.2.0 or newer:** the panel checks `panel/version.json` on `main` and shows an update banner — the user clicks Update and the bundled `panel/daemon/update.sh` (macOS) / `update.ps1` (Windows) handles everything: stops the daemon, replaces files, preserves `chat-history.json`, reinstalls deps.
- **v0.1.0 (no banner, no updater):** re-run the installer from a fresh checkout — download/clone this repo, then run `scripts/install-mac.sh` or `scripts/install-win.ps1`. The installer stops any running daemon, preserves the user's `chat-history.json`, and installs daemon dependencies into the deployed extension. Ask the user to restart After Effects afterwards.
- If an update fails, the panel says so and the updater log has details: `/tmp/gaffer-update.log` (macOS) / `%TEMP%\gaffer-update.log` (Windows). The update script can also be run manually from the extension's `daemon/` folder.
- Never update a dev install (extension dir symlinked to a git checkout) with these scripts — use `git pull`.

---

## What it does

The panel auto-starts a local daemon that connects Claude to After Effects via MCP.

- **Chat in the panel** — ask Claude to modify your AE project directly
- **Use Claude Code** — any `claude` session sees the Gaffer MCP tools automatically

### Chat features

- **Drop or paste images** into the panel — claude reads them as visual input. Click any thumbnail to zoom.
- **MCP server tiles** in the activity drawer — one tile per Connected MCP server (Grip, Notion, Figma, ...) with brand icons and color-coded states: enabled, available, needs-auth (click to authorize), failed. Selection is stored locally, never committed.
- **Model, context, and effort selects** — discovered from your installed `claude` CLI, not hardcoded: model aliases (Fable / Opus / Sonnet / Haiku), context window (Latest, 1M, or pinned versions like 4.6), and reasoning effort (Low through Max).
- **Self-healing sessions** — if the CLI's session storage is wiped (CLI updates, re-auth), the panel detects the dead session and retries on a fresh one automatically.

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
| `listExpressionControls` | Slider/Checkbox/Color/Point/Layer/Dropdown controls — returns ready-to-use bindRef strings |
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
| `listTextLayers` | Every text layer's content + type styling (font, size, fill/stroke, box bounds) — active comp or whole project |
| `getLayerEffects` | One layer's full effect stack with parameter values, keyframe counts, expressions |
| `getShapeContents` | Structured shape-layer contents tree + all masks; optional raw vertex data |
| `getProjectTree` | Full project-panel hierarchy: folders, comps, footage, solids with parent ids |
| `getProjectSettings` | AE version, color depth/space, expression engine, GPU acceleration, time display |

### Architecture

```
Panel (CEP in AE) <-WebSocket-> Daemon (Node.js) <-MCP HTTP-> Claude
```

Every mutation is wrapped in an undo group prefixed "Gaffer:" — always Cmd+Z safe.
