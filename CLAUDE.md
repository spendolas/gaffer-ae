# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Gaffer

Gaffer is an After Effects automation agent. Claude controls AE by writing ExtendScript and executing it via MCP tools. Three components: **Claude Code CLI** (or Claude Hub) → **Gaffer Daemon** (Node.js, MCP server) → **Gaffer Panel** (CEP extension in AE) → After Effects.

The spec lives in `Gaffer_Handoff.md` — it is the authoritative design document.

## Architecture

```
Claude Code / Claude Hub
    │  MCP over HTTP/SSE
    ▼
Gaffer Daemon (Node.js, long-running)
  - MCP tool definitions (server name: "gaffer")
  - Serialized execution queue (mutex — no concurrent AE calls)
  - JSX safety wrapping (undo groups, try/catch, JSON return)
    │  WebSocket ws://127.0.0.1:9823
    ▼
Gaffer Panel (CEP extension in AE)
  - Dumb pipe: receives JSX string, calls CSInterface.evalScript, returns result
    │  evalScript
    ▼
After Effects
```

**Key design decisions:**
- One daemon = one serialized queue. Multiple `claude -p` processes connect to same daemon, no races.
- HTTP/SSE transport (not stdio) because multiple clients connect concurrently.
- Panel is intentionally dumb — all logic lives in the daemon. If you're adding logic to the panel beyond "execute and return," stop and reconsider.
- All MCP tools namespaced as `mcp__gaffer__<toolname>`.

## Build Phases

The project is built in six sequential phases. **Stop at each phase boundary**, report, wait for user verification before proceeding.

1. **Panel skeleton** — CEP panel loads in AE, WebSocket bridge to daemon, evalScript wrapper
2. **Daemon + runJSX** — Node.js MCP server, WebSocket server, serialized queue, safety wrapper
3. **QoL tools** — `getProjectSummary`, `listEffectMatchNames` (cached)
4. **System prompt + CLAUDE.md** — AE-specific system prompt so Claude writes correct ExtendScript
5. **Claude Hub integration** — agent templates (Operator, Director, Expression Debugger), tool scoping docs
6. **(Optional) Screenshot tool** — `captureActiveComp` for visual feedback

## Repo Layout (target)

```
gaffer/
├── panel/          # CEP extension (loads in AE)
│   ├── CSXS/manifest.xml
│   ├── index.html, main.js, host.jsx, .debug
├── daemon/         # Node.js MCP server
│   ├── index.js, mcp-server.js, panel-bridge.js, queue.js, safety.js
│   └── tools/      # runJSX.js, projectSummary.js, effectMatchNames.js
├── prompts/        # System prompt (gaffer.md) + project CLAUDE.md template
├── docs/           # Setup guides, Claude Hub integration docs
```

## Commands

```bash
# Start daemon (from daemon/)
node daemon/index.js

# Install daemon dependencies
cd daemon && npm install

# Register in Claude config (~/.claude.json) as "gaffer"
# Then test with:
claude -p "run 1+1 in AE"
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
- `CSInterface.evalScript` returns strings only. `"undefined"` is literal. Use `EvalScript_ErrMessage` to detect errors.

## Safety Invariants

- **Every `runJSX` call wrapped in undo group** prefixed "Gaffer:". Non-negotiable.
- **60s timeout** on any single `runJSX` call.
- **Serialization at daemon level** — daemon must not send concurrent messages to panel.
- Panel disconnect mid-call → reject pending promise with clear error, never hang.
- Never render, save, close, or delete unless explicitly asked.

## Dependencies (keep minimal)

Daemon: `@modelcontextprotocol/sdk`, `ws`, optionally `express`. Ask before adding others.

## CEP Development Notes

- Target CEP version 11 (AE 2022+). Extension ID: `com.gaffer.panel`.
- Dev loading requires `PlayerDebugMode = 1` in CEP plist and a `.debug` file.
- Include local copy of `CSInterface.js`.
