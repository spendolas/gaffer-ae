# Gaffer

An After Effects automation agent. Claude controls AE by writing ExtendScript, driven from a chat UI inside the AE panel or from Claude Code CLI.

## Prerequisites

- **After Effects** 2025 or 2026
- **Claude Code CLI** — [install](https://claude.ai/code)
- **Node.js** 18+ — [install](https://nodejs.org)

## Install

### macOS

```bash
git clone <repo-url> gaffer
cd gaffer
./scripts/install-mac.sh
```

### Windows

```powershell
git clone <repo-url> gaffer
cd gaffer
powershell -ExecutionPolicy Bypass -File scripts\install-win.ps1
```

Then restart After Effects and open **Window > Extensions > Gaffer**.

## What it does

The panel auto-starts a local daemon that connects Claude to After Effects via MCP. You can:

- **Chat in the panel** — ask Claude to modify your AE project directly
- **Use CLI** — `./scripts/gaffer-cli.sh "add a wiggle to the selected layer"`
- **Use Claude Code** — any `claude` session sees the Gaffer MCP tools automatically

## MCP Tools

| Tool | Description |
|------|-------------|
| `runJSX` | Execute ExtendScript in AE (undo-grouped, try/caught) |
| `getProjectSummary` | Active comp, selected layers, project path |
| `listEffectMatchNames` | All effects grouped by category (cached) |
| `captureActiveComp` | Screenshot current frame as PNG |

## How it works

```
Panel (CEP in AE) ←WebSocket→ Daemon (Node.js) ←MCP HTTP→ Claude
```

- Panel auto-starts the daemon on load
- Daemon serializes all AE calls (no races)
- Every mutation is wrapped in an undo group prefixed "Gaffer:"
- Chat spawns `claude -p` with a tuned AE system prompt

## Development

```bash
# Start daemon manually (instead of auto-start)
cd panel/daemon && npm install && node index.js

# Register MCP server with Claude Code
claude mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp
```

Panel is symlinked during install, so edits to `panel/` are live. Reload the panel in AE to pick up changes (or use the Reload button in the panel).

## Optional: Build standalone binary

Compiles the daemon into a single executable (no Node.js needed at runtime):

```bash
./scripts/build.sh
```

Requires Node.js at build time. The binary is platform-specific (macOS/Windows/Linux). The panel's launcher script prefers the binary if present, falls back to `node`.
