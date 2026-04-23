# Gaffer

An After Effects automation agent. Chat with Claude directly inside an AE panel — Claude controls After Effects by writing ExtendScript via MCP tools.

## Quick Start

Open Claude Code and say:

> Install Gaffer from https://github.com/spendolas/gaffer-ae

Claude will handle the rest. Then restart After Effects and open **Window > Extensions > Gaffer**.

## Prerequisites

- After Effects 2022+
- Claude Code CLI ([install](https://claude.ai/code))
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
   # macOS
   defaults write com.adobe.CSXS.11 PlayerDebugMode 1
   defaults write com.adobe.CSXS.12 PlayerDebugMode 1
   
   # Windows (PowerShell)
   foreach ($v in @("11","12")) { 
     $k = "HKCU:\Software\Adobe\CSXS.$v"
     if (!(Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
     Set-ItemProperty -Path $k -Name PlayerDebugMode -Value 1 -Type DWord
   }
   ```

6. **Register the MCP server with Claude Code:**
   ```bash
   claude mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp
   ```

7. **Tell the user:** "Restart After Effects. Open Window > Extensions > Gaffer. The daemon starts automatically when the panel loads."

   Note: Gaffer's MCP tools are only available while the panel is open in After Effects. If you run `claude` in a terminal without AE open, the tools will appear disconnected. Open AE first.

8. **Verify the install.** After the user has restarted After Effects and confirmed the panel is visible under Window > Extensions > Gaffer, run these checks:

   a. `claude mcp list` — confirm `gaffer` appears and shows as connected. If not connected, the panel is probably not open in AE yet. Ask the user to confirm the panel is open.

   b. Ask Claude to call `getProjectSummary` via the Gaffer MCP. If it returns a valid JSON response describing the project, the install is working end-to-end. If it errors, check the troubleshooting section.

   Report the result to the user: "Gaffer is installed and verified" or "Gaffer is installed but verification failed — see troubleshooting."

### Troubleshooting

- **Panel doesn't appear in AE menu:** PlayerDebugMode not set, or AE needs full restart (not just panel reload).
- **Panel shows "Disconnected":** Daemon failed to start. Check `/tmp/gaffer-daemon.log` (macOS) or `%TEMP%\gaffer-daemon.log` (Windows). Usually a missing `npm install`.
- **MCP tools not available:** Run `claude mcp add` step again. Verify with `claude mcp list`.

</details>

---

## What it does

The panel auto-starts a local daemon that connects Claude to After Effects via MCP.

- **Chat in the panel** — ask Claude to modify your AE project directly
- **Use Claude Code** — any `claude` session sees the Gaffer MCP tools automatically

### MCP Tools

| Tool | Description |
|------|-------------|
| `runJSX` | Execute ExtendScript in AE (undo-grouped, try/caught) |
| `getProjectSummary` | Active comp, selected layers, project path |
| `listEffectMatchNames` | All effects grouped by category (cached) |
| `captureActiveComp` | Screenshot current frame as PNG |

### Architecture

```
Panel (CEP in AE) <-WebSocket-> Daemon (Node.js) <-MCP HTTP-> Claude
```

Every mutation is wrapped in an undo group prefixed "Gaffer:" — always Cmd+Z safe.
