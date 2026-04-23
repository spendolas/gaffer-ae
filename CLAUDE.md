# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Gaffer

Gaffer is an After Effects automation agent. Claude controls AE by writing ExtendScript and executing it via MCP tools. The panel includes a chat UI for direct interaction from within AE.

The spec lives in `Gaffer_Handoff.md` — the original design document.

## Architecture

```
Claude Code / Claude Hub / Panel Chat
    │  MCP over Streamable HTTP (:9824)
    ▼
Gaffer Daemon (Node.js or standalone SEA binary)
  - MCP tools: runJSX, getProjectSummary, listEffectMatchNames, captureActiveComp
  - Chat handler: spawns claude -p, streams response to panel
  - Serialized execution queue (mutex — no concurrent AE calls)
  - JSX safety wrapping (undo groups, try/catch, JSON return)
    │  WebSocket ws://127.0.0.1:9823
    ▼
Gaffer Panel (CEP extension in AE)
  - Chat UI + evalScript bridge
  - Auto-starts daemon via system.callSystem()
    │  evalScript
    ▼
After Effects
```

**Key design decisions:**
- One daemon = one serialized queue. Multiple clients share the same daemon, no races.
- Streamable HTTP transport for MCP (not stdio) because multiple clients connect.
- Panel auto-starts daemon on load via ExtendScript `system.callSystem()`.
- All MCP tools namespaced as `mcp__gaffer__<toolname>`.

## Repo Layout

```
gaffer/
├── panel/                    # CEP extension (single deployable folder)
│   ├── CSXS/manifest.xml
│   ├── index.html, main.js   # Chat UI + WebSocket client + auto-start
│   ├── host.jsx, .debug
│   ├── lib/CSInterface.js
│   ├── daemon/               # Node.js MCP server (lives inside panel)
│   │   ├── index.js, mcp-server.js, panel-bridge.js
│   │   ├── queue.js, safety.js
│   │   ├── chat-handler.js, claude-binary.js
│   │   ├── start.sh, start.ps1  # OS-specific launchers
│   │   ├── tools/
│   │   │   ├── projectSummary.js, effectMatchNames.js, captureActiveComp.js
│   │   └── gaffer-daemon      # Compiled SEA binary (built, not checked in)
│   └── prompts/gaffer.md      # System prompt
├── scripts/
│   ├── build.sh               # esbuild + Node.js SEA compilation
│   ├── install-mac.sh, install-win.ps1
│   └── gaffer-cli.sh          # CLI wrapper
├── docs/                      # Claude Hub integration
└── Gaffer_Handoff.md          # Original spec
```

## Commands

```bash
# Dev: start daemon manually
cd panel/daemon && node index.js

# Build standalone binary (requires esbuild, postject)
./scripts/build.sh

# Install for end users
./scripts/install-mac.sh    # Mac
# or install-win.ps1        # Windows

# CLI usage (daemon must be running)
./scripts/gaffer-cli.sh "add a wiggle to the selected layer"

# Register MCP server with Claude Code
claude mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp
```

## ExtendScript Rules (ES3 — not modern JS)

- No `let`, `const`, arrow functions, template literals, destructuring, Promises, async/await. Use `var` and `function`.
- No `Array.prototype.includes`, `.find`, `.flat`. Use `indexOf` and loops.
- `JSON` is available. Use `JSON.stringify` for structured returns.
- String concatenation with `+` only.

## AE API Gotchas

- `comp.layer(n)` is **1-indexed**. `selectedLayers` is **0-indexed**.
- Use match names, not display names: `.property("ADBE Transform Group")`.
- Time is seconds (float), not frames. Convert with `comp.frameDuration`.
- Expressions: set `prop.expression = "..."`, then check `prop.expressionError`.
- Effects: `layer.Effects.addProperty("ADBE Gaussian Blur 2")` — display names often fail.

## Safety Invariants

- **Every `runJSX` call wrapped in undo group** prefixed "Gaffer:". Non-negotiable.
- **60s timeout** on any single `runJSX` call.
- **Serialization at daemon level** — daemon must not send concurrent messages to panel.
- Panel disconnect mid-call → reject pending promise with clear error, never hang.
- Never render, save, close, or delete unless explicitly asked.

## Dependencies

Daemon: `@modelcontextprotocol/sdk`, `ws`, `zod`. Express comes transitively via MCP SDK.

## CEP Development Notes

- Target CEP 12 (AE 2022+). Extension ID: `com.gaffer.panel`.
- Dev loading requires `PlayerDebugMode = 1` for both CSXS.11 and CSXS.12.
- `require()` is NOT available in panel context despite `--enable-nodejs` — use `system.callSystem()` for OS operations.
- Keyboard shortcuts (Delete, Cmd+C/V/X/Z) must be registered via `cs.registerKeyEventsInterest()`.
