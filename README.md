# Gaffer

An After Effects automation agent. Chat with Claude directly inside an AE panel — Claude controls After Effects by writing ExtendScript via MCP tools.

## Quick Start

Open Claude Code and say:

> Install Gaffer from https://github.com/spendolas/gaffer-ae

Claude will handle the rest. Then restart After Effects and open **Window > Extensions > Gaffer**.

## Prerequisites

- After Effects 2025 or 2026
- Claude Code CLI ([install](https://claude.ai/code))
- Node.js 18+ ([install](https://nodejs.org))

---

## Install Instructions for Claude

<details>
<summary>Claude: read this section when asked to install Gaffer.</summary>

### What to do

1. **Check prerequisites** — verify `node` and `claude` are on PATH. If not, tell the user what's missing.

2. **Clone the repo** to a permanent location (the extension symlinks here, so it must persist):
   ```bash
   # macOS
   git clone https://github.com/spendolas/gaffer-ae.git "$HOME/.gaffer"
   
   # Windows
   git clone https://github.com/spendolas/gaffer-ae.git "$env:USERPROFILE\.gaffer"
   ```

3. **Install daemon dependencies:**
   ```bash
   cd "$HOME/.gaffer/panel/daemon" && npm install --production
   ```

4. **Symlink the panel into the CEP extensions directory:**
   ```bash
   # macOS
   ln -sf "$HOME/.gaffer/panel" "$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
   
   # Windows (PowerShell, may need admin)
   New-Item -ItemType SymbolicLink -Path "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel" -Target "$env:USERPROFILE\.gaffer\panel" -Force
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
