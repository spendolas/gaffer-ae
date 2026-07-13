# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Gaffer

Gaffer is an After Effects automation agent. Claude controls AE by writing ExtendScript and executing it via MCP tools. The panel includes a chat UI for direct interaction from within AE.

The spec lives in `docs/Gaffer_Handoff.md` — the original design document. Public repo: `github.com/spendolas/gaffer-ae` (end users install/update from the `main` tarball, no git clone).

## Architecture

```
Claude Code / Claude Hub / Panel Chat
    │  MCP over Streamable HTTP (:9824)
    ▼
Gaffer Daemon (Node.js or standalone SEA binary)
  - MCP tools: runJSX + 18 typed tools (project/comp/layer discovery,
    expression dump, keyframe inspection, layer/effect search, footage
    relink, render queue add, frame/layer capture, Figma import)
  - Chat handler: spawns claude -p, streams response to panel
  - Serialized execution queue (mutex — no concurrent AE calls)
  - JSX safety wrapping (undo groups, try/catch, JSON return)
    │  WebSocket ws://127.0.0.1:9823
    ▼
Gaffer Panel (CEP extension in AE) — one per AE instance, keyed by aeVersion
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
- **Multi-AE-instance:** each panel registers with the daemon by `aeVersion`; every MCP tool takes an optional `aeVersion` param to route. With one instance connected it's implicit; with several and no param, the call errors listing available versions (`panel-bridge.js`).

## Repo Layout

```
gaffer/
├── panel/                    # CEP extension (single deployable folder)
│   ├── CSXS/manifest.xml
│   ├── index.html, main.js   # Chat UI + WebSocket client + auto-start + settings/update UI
│   ├── host.jsx, .debug
│   ├── version.json           # {version, commit} — drives panel auto-update check
│   ├── lib/CSInterface.js
│   ├── daemon/               # Node.js MCP server (lives inside panel)
│   │   ├── index.js, mcp-server.js, panel-bridge.js
│   │   ├── queue.js, safety.js
│   │   ├── chat-handler.js, claude-binary.js
│   │   ├── start.sh, start.ps1    # OS launchers (prefer node over SEA binary)
│   │   ├── update.sh, update.ps1  # One-click update from GitHub tarball
│   │   ├── tools/                 # One file per typed MCP tool (18) + figma-translator.js helper
│   │   └── gaffer-daemon          # Compiled SEA binary (built, not checked in)
│   └── prompts/gaffer.md      # System prompt for the panel chat agent
├── scripts/
│   ├── build.sh               # esbuild bundle → Node.js SEA compilation
│   ├── install-mac.sh, install-win.ps1
│   └── gaffer-cli.sh          # CLI wrapper
├── docs/                      # Spec, Claude Hub integration, bug reports
├── Knowledge/                 # Local-only AE SDK/CEP reference archives (untracked)
├── assets/                    # Local-only asset store (untracked) — fonts/AdobeClean.zip (licensed), fonts/SourceSans3 (OFL, staged for bundling)
├── CHANGELOG.md
└── README.md                  # Includes step-by-step install instructions written FOR Claude
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

There are no tests or linters in this repo.

## Releasing

- Bump `panel/version.json` (version + commit) and add a `CHANGELOG.md` entry — the panel's auto-update check compares raw `version.json` on GitHub `main` against the local copy.
- Deployed installs live at `~/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel` (Mac) / `%APPDATA%\Adobe\CEP\extensions\com.gaffer.panel` (Win). Daemon logs: `/tmp/gaffer-daemon.log` / `%TEMP%\gaffer-daemon.log`.

## Chat Handler (`chat-handler.js`)

- Spawns `claude -p --model <opus|sonnet|haiku> --output-format stream-json --dangerously-skip-permissions`, allowlisting only `mcp__gaffer__*` tools plus per-install user-selected MCP servers (multi-select persisted in `.gaffer-config.json`, never committed).
- Augments PATH on the subprocess — CEP launches with a stripped environment, so stdio MCP servers (bare `node` commands) fail without it.
- Context-window overflow → session reset with a user-facing message; conversation titles summarized via a separate `--model haiku --resume` call.

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

- **Every mutating `runJSX` call wrapped in undo group** prefixed "Gaffer:". Non-negotiable. Read-only typed tools skip the undo group (see `safety.js`).
- The safety wrap **strips `app.beginUndoGroup`/`endUndoGroup` from agent JSX** — AE can't nest undo groups; unmatched pairs cause "undo mismatch" dialogs. The wrapper's group is the only group.
- **60s timeout** on any single `runJSX` call.
- **Serialization at daemon level** — daemon must not send concurrent messages to a panel.
- Panel disconnect mid-call → reject pending promise with clear error, never hang.
- Never render, save, close, or delete unless explicitly asked (`addToRenderQueue` queues only — never starts a render).

## Dependencies

Daemon: `@modelcontextprotocol/sdk`, `ws`, `zod`. Express comes transitively via MCP SDK. Daemon is ESM (`"type": "module"`); build bundles to CJS for SEA.

## CEP Development Notes

- Target CEP 12 (AE 2022+). Extension ID: `com.gaffer.panel`.
- Dev loading requires `PlayerDebugMode = 1` for both CSXS.11 and CSXS.12.
- `require()` is NOT available in panel context despite `--enable-nodejs` — use `system.callSystem()` for OS operations.
- Keyboard shortcuts (Delete, Cmd+C/V/X/Z) must be registered via `cs.registerKeyEventsInterest()`.
