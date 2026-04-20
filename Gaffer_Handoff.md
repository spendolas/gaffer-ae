# Gaffer — Claude Code Handoff Brief

*Gaffer is an After Effects automation agent. On a film set, the gaffer is the crew member who executes the director's vision — skilled, technical, hands-on. Here, you're the director, Claude is the gaffer, and After Effects is the set.*

---

## Context

You are building Gaffer: an integration that lets Claude control Adobe After Effects by executing ExtendScript, driven from Claude Code CLI and optionally from an existing multi-agent orchestrator called **Claude Hub** (described below). The user has a Claude subscription; Gaffer must ride that subscription (no separate API key).

This brief gives you the architecture, the build order, acceptance criteria per phase, and the gotchas that will bite you if you don't know about them upfront. Work phase by phase. At the end of each phase, stop, report, and wait for the user to verify before moving to the next.

---

## Final architecture

Three components on the user's machine:

```
┌─────────────────────────┐
│  Claude Code CLI        │  (already installed, authenticated)
│  or Claude Hub agent    │
└────────────┬────────────┘
             │ MCP over HTTP/SSE
             ▼
┌─────────────────────────┐
│  Gaffer Daemon          │  (long-running Node.js process)
│  - MCP tool definitions │
│  - serialized queue     │
│  - JSX safety wrapping  │
└────────────┬────────────┘
             │ local WebSocket (ws://127.0.0.1:PORT)
             ▼
┌─────────────────────────┐
│  Gaffer Panel (in AE)   │  (CEP extension)
│  - WebSocket client     │
│  - CSInterface.evalScript│
└────────────┬────────────┘
             │ evalScript
             ▼
┌─────────────────────────┐
│  After Effects          │
└─────────────────────────┘
```

**Why this shape:**
- One long-running daemon = one serialized queue into AE, no races when multiple agents call tools concurrently.
- HTTP/SSE transport (not stdio) because multiple `claude -p` processes will connect to the same daemon.
- CEP panel as bridge because it has native `CSInterface.evalScript`; the panel is dumb (just a pipe), all logic lives in the daemon.

**MCP tool namespace:** all tools are exposed as `mcp__gaffer__<toolname>`, e.g. `mcp__gaffer__runJSX`.

---

## Build order (six phases)

### Phase 1 — Gaffer Panel skeleton + evalScript bridge

**Goal:** a CEP panel that loads in AE, opens a WebSocket to `ws://127.0.0.1:9823`, receives JSX strings, executes them via `CSInterface.evalScript`, returns results.

**Deliverables:**
- `panel/CSXS/manifest.xml` — extension manifest, target AE 2024+, panel type, extension id `com.gaffer.panel`
- `panel/index.html` — minimal UI: Gaffer wordmark, connection status LED, last-executed JSX, last result, a "reconnect" button
- `panel/main.js` — WebSocket client + evalScript wrapper (promisified)
- `panel/host.jsx` — any pre-loaded ExtendScript helpers (empty for now, we'll fill in phase 3)
- `panel/.debug` — enables CEP debug mode so you can load unsigned extensions during dev

**Acceptance criteria:**
- Panel appears in AE under Window → Extensions → Gaffer
- Panel shows "connected" when daemon is running, "disconnected" when not
- Panel automatically reconnects with exponential backoff
- Sending a JSON message `{"id": "abc", "code": "1 + 1"}` over the WebSocket returns `{"id": "abc", "ok": true, "result": "2"}`
- Syntax errors in JSX return `{"id": "abc", "ok": false, "error": "...", "line": N}`
- Errors in the WebSocket handler never crash the panel; log and keep running

**Critical gotchas:**
- `CSInterface.evalScript` is callback-based and returns a string. Wrap it in a Promise. The result is always a string; use `EvalScript_ErrMessage` constant to detect errors. Don't trust `undefined` — evalScript returns the literal string `"undefined"`.
- CEP panels need to load `CSInterface.js` from the CEP framework — it's at `CEP_Resource_Public/CSInterface.js` or include a local copy.
- For dev loading, set `PlayerDebugMode = 1` in the CEP plist/registry, and create a `.debug` file with the extension's debug config. Without this AE will reject the unsigned extension.
- Target CEP version 11 for AE 2022+. Manifest needs correct `<RequiredRuntime>` and `<Host>` entries for AEFT.

**Don't do yet:** any UI beyond status, any chat interface, any handling of the MCP protocol. This phase is pure bridge.

---

### Phase 2 — Gaffer Daemon, runJSX tool only

**Goal:** a Node.js daemon that exposes `runJSX` as an MCP tool over HTTP/SSE, forwards calls to the Gaffer Panel over WebSocket, returns results.

**Deliverables:**
- `daemon/package.json` — dependencies: `@modelcontextprotocol/sdk`, `ws`, `express` (or native `http`); name the package `gaffer-daemon`
- `daemon/index.js` — entry point, spawns MCP server and WebSocket server
- `daemon/mcp-server.js` — MCP tool definitions and handlers; server name is `gaffer`
- `daemon/panel-bridge.js` — WebSocket server that accepts connection from the panel, maintains a request/response map keyed by message ID
- `daemon/queue.js` — serialized execution queue (mutex on AE calls)
- `daemon/safety.js` — JSX wrapping (undo groups, try/catch, JSON return)

**Tool definition:**
```
name: runJSX
description: Execute ExtendScript in After Effects. Returns the value of the last expression as a string, or a structured error. Use this to inspect project state, read/write layer properties, create layers, set expressions, apply effects.
inputSchema: { code: string, undoLabel?: string }
```

**Safety wrapper (applied to every runJSX call):**
```javascript
(function() {
  app.beginUndoGroup("Gaffer: " + (undoLabel || truncate(code, 40)));
  try {
    var __result = (function() { /* user code */ })();
    return JSON.stringify({ ok: true, result: String(__result) });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.toString(), line: e.line || null });
  } finally {
    app.endUndoGroup();
  }
})();
```

Every Gaffer action appears in the user's AE undo history prefixed with "Gaffer:" so it's easy to spot and revert.

**Acceptance criteria:**
- `node daemon/index.js` starts Gaffer, logs "Gaffer daemon: MCP on http://localhost:PORT/mcp, panel bridge on ws://localhost:9823"
- Panel connects automatically when AE is open
- Registering Gaffer in `~/.claude.json` as `gaffer` and running `claude -p "run 1+1 in AE"` results in Claude calling `mcp__gaffer__runJSX`, the daemon forwarding to the panel, the panel executing, and Claude receiving "2"
- Two concurrent `claude -p` processes calling `runJSX` do NOT interleave — their JSX executes one after the other (verify with a test script that writes to a file with a delay)
- If the panel is disconnected, `runJSX` returns a clean error ("Gaffer Panel not connected — is After Effects open?") rather than hanging
- Timeout: any single `runJSX` call that takes longer than 60s is abandoned and returns a timeout error

**Critical gotchas:**
- MCP SDK evolves fast; check `@modelcontextprotocol/sdk` docs for the current HTTP/SSE transport API. If the SDK only supports stdio at time of build, fall back to running the daemon in stdio mode for phase 2 and revisit HTTP in phase 4 when Claude Hub integration needs it.
- Serialize at the daemon level, not the panel level. Panel should process messages in FIFO order but the daemon must not send concurrent messages expecting concurrent execution.
- Generate unique message IDs (UUIDs or counter) for request/response matching on the WebSocket.
- When the panel disconnects mid-call, reject the pending promise with a clear error. Don't let it hang.

**Don't do yet:** other tools, Claude Hub integration, system prompt.

---

### Phase 3 — Quality-of-life tools

**Goal:** add `getProjectSummary` and `listEffectMatchNames` to reduce exploratory round-trips.

**`mcp__gaffer__getProjectSummary` returns:**
```json
{
  "activeItem": {
    "name": "Main Comp",
    "width": 1920, "height": 1080,
    "frameRate": 23.976,
    "duration": 10.0,
    "numLayers": 12,
    "selectedLayerIndices": [3, 4]
  },
  "selectedLayers": [
    { "index": 3, "name": "BG_plate", "type": "FootageLayer", "enabled": true, "inPoint": 0, "outPoint": 10 },
    { "index": 4, "name": "overlay", "type": "ShapeLayer", "enabled": true, "inPoint": 0, "outPoint": 10 }
  ],
  "projectPath": "/path/to/project.aep",
  "numItems": 45
}
```

**`mcp__gaffer__listEffectMatchNames` returns:** cached list of all effect match names the running AE instance knows about, grouped by category (Blur, Color Correction, Distort, etc.). Build this by walking `app.effects` on first call and caching in the daemon process memory. Accepts optional `category` filter string.

**Deliverables:**
- `daemon/tools/projectSummary.js` — ExtendScript source + wrapper that runs it via the queue
- `daemon/tools/effectMatchNames.js` — same pattern, with in-memory cache
- `panel/host.jsx` gets the helper functions pre-loaded so tool calls are small and fast

**Acceptance criteria:**
- `claude -p "what's selected in AE"` → Claude calls `getProjectSummary`, answers concisely
- `claude -p "what's the match name for Gaussian Blur"` → Claude calls `listEffectMatchNames` with category filter, finds `ADBE Gaussian Blur 2`
- Both tools return within 500ms on a normal project
- `listEffectMatchNames` cache is invalidated if the daemon restarts; otherwise reused across calls

**Don't do yet:** anything else.

---

### Phase 4 — System prompt + CLAUDE.md

**Goal:** ship the AE-specific system prompt so Claude writes correct ExtendScript on first try more often.

**Deliverables:**
- `prompts/gaffer.md` — the full system prompt (content specified below)
- `prompts/CLAUDE.md` — a template the user can drop into their project directory for project-specific conventions
- `daemon/README.md` with instructions for loading the prompt: either via a wrapper script that invokes `claude -p --append-system-prompt "$(cat prompts/gaffer.md)" "$@"`, or by documenting how to add it to a Claude Hub agent's system prompt.

**System prompt contents (use this verbatim, it's been tuned):**

```
You are Gaffer, an After Effects automation agent. You control After Effects
by writing ExtendScript and executing it via the runJSX tool. You have one
escape hatch (runJSX) and a few helpers (getProjectSummary,
listEffectMatchNames).

Your relationship to the user is that of a gaffer to a director: you execute
their vision with technical skill. They say what they want; you figure out
how. You ask when direction is unclear, you flag when something isn't
possible, and you never improvise beyond what was asked.

## How to work

1. Before acting, inspect. Call getProjectSummary first on any non-trivial task.
   Do not guess project state — read it.
2. Work in small steps. Prefer many small runJSX calls over one giant script.
   Exception: operations that must be atomic for undo coherence.
3. Verify after mutating. After setting expressions, check prop.expressionError.
   After creating layers, read back to confirm.
4. When you don't know an effect's match name, call listEffectMatchNames before
   guessing. Match names != display names.

## ExtendScript rules (this is ES3, not modern JS)

- No let, no const, no arrow functions, no template literals, no destructuring,
  no Promises, no async/await. Use var and function expressions.
- Concatenate strings with +.
- No Array.prototype.includes, .find, .flat. Use indexOf and loops.
- JSON is available. Use JSON.stringify for structured returns.
- The last expression's value is what runJSX returns.

## After Effects API gotchas

- comp.layer(n) is 1-indexed. selectedLayers IS 0-indexed. Yes, inconsistent.
- Prefer match names: .property("ADBE Transform Group").property("ADBE Position")
  over display names.
- Time is seconds (float), not frames. Convert with comp.frameDuration.
- Expressions: prop.expression = "..."; check prop.expressionError after.
- Effects: layer.Effects.addProperty("ADBE Gaussian Blur 2"). Display names
  often don't work.
- Create comp: app.project.items.addComp(name, w, h, par, duration, fps)
- Create solid: comp.layers.addSolid(color, name, w, h, par, duration)

## Error handling

- Every runJSX call is wrapped in try/catch and undo group by Gaffer.
  You get { ok, result, error, line } back.
- On error, read the message carefully. Common: "Object is invalid" (bad
  index or deleted item), "Cannot set value" (wrong shape), "Expression
  disabled" (check expressionError).
- If an operation fails, do NOT retry unchanged. Inspect why, adjust.

## Output

- One sentence before acting, describing what you're about to do.
- After the task, summarize what changed.
- If blocked, say so and explain why.

## Things you do NOT do

- Never render (app.project.renderQueue.render) or spawn aerender.
- Never save or close the project.
- Never delete layers/comps/footage unless explicitly asked.
- Never modify existing user expressions unless the task is about that
  specific expression.
```

**Acceptance criteria:**
- With the system prompt loaded, 5 varied test prompts produce working ExtendScript on first try at least 4 of 5 times. Test prompts:
  1. "Add a wiggle(2, 30) expression to the position of the selected layer"
  2. "Create a new 1920x1080 comp at 24fps called 'Test' and add a red solid filling it"
  3. "For each selected layer, add a Gaussian Blur effect with blurriness 20"
  4. "Report the name, width, height, and frame rate of the active comp"
  5. "Set keyframes on opacity: 0% at time 0, 100% at time 1s, on the selected layer"

**Don't do yet:** Claude Hub integration.

---

### Phase 5 — Claude Hub integration

**Goal:** make Gaffer usable from Claude Hub rooms, with appropriate per-agent tool scoping.

**Reference:** Claude Hub is a local multi-agent orchestrator that spawns `claude -p` per agent turn, with per-agent `--allowedTools` settings, stores state in JSON files, and runs on Express (port 3000). It's already installed.

**Deliverables:**
- `docs/claude-hub-setup.md` explaining the one-time setup:
  1. Ensure Gaffer is registered in `~/.claude.json` as `gaffer` so all `claude -p` invocations see it
  2. Add Gaffer tool names to the appropriate Claude Hub agents' `allowedTools`: `mcp__gaffer__runJSX`, `mcp__gaffer__getProjectSummary`, `mcp__gaffer__listEffectMatchNames`
  3. Gate `mcp__gaffer__runJSX` behind Claude Hub rooms that have write access enabled (since it mutates the project)
- `docs/claude-hub-agent-templates.md` with three ready-to-use agent configs:
  - **Gaffer (Operator)** — allowedTools includes all three Gaffer tools. System prompt = our Gaffer system prompt + "You are the hands-on operator. You make changes to the AE project. Explain what you did after each action so the Director can review."
  - **Director** — allowedTools includes `getProjectSummary` only (read-only AE awareness). System prompt: role as creative lead, reviews Gaffer's work, gives direction, decides what's done.
  - **Expression Debugger** — allowedTools includes all three. System prompt: specialist in AE expression debugging, called in when expressions misbehave.

**Acceptance criteria:**
- Creating a Claude Hub room with all three agents and write access enabled, sending "add a subtle wiggle to the selected layer and tell the Director when you're done" results in: Gaffer calls `getProjectSummary`, calls `runJSX` with the wiggle, @mentions Director; Director reviews, responds.
- Creating a room without write access → Gaffer cannot call `runJSX` (tool is not in allowedTools), falls back to suggesting code for the user to run.
- Two agents in a handoff chain both calling `runJSX` in quick succession → daemon queue serializes correctly, no interleaving.

**Critical gotcha:** Claude Hub's `--session-id`/`--resume` handling interacts with MCP tool state. MCP tool definitions are per-invocation, not persisted in sessions, so this should Just Work, but verify that tool availability is consistent across resumed sessions.

**Don't do yet:** the screenshot tool.

---

### Phase 6 — (Optional) Screenshot tool for visual feedback

**Goal:** let non-operator agents (like Director) actually see what Gaffer did, not just read text descriptions.

**Deliverable:** a `mcp__gaffer__captureActiveComp` tool that renders the current frame of the active comp to a PNG at a temp path and returns the path. Uses `comp.saveFrameToPng()` (AE 2023+) or falls back to adding a render queue item, rendering, removing it.

**Acceptance criteria:**
- Tool returns a valid PNG path within 5 seconds for a standard 1080p comp
- Director agent, given the tool in allowedTools + Read on the temp directory, can view the rendered frame and give visual feedback
- No leftover render queue items after the tool runs

**This phase is optional.** Ship phases 1-5 and evaluate whether visual feedback is actually the bottleneck before building this.

---

## Repo layout when done

```
gaffer/
├── panel/
│   ├── CSXS/manifest.xml
│   ├── index.html
│   ├── main.js
│   ├── host.jsx
│   └── .debug
├── daemon/
│   ├── package.json
│   ├── index.js
│   ├── mcp-server.js
│   ├── panel-bridge.js
│   ├── queue.js
│   ├── safety.js
│   └── tools/
│       ├── runJSX.js
│       ├── projectSummary.js
│       └── effectMatchNames.js
├── prompts/
│   ├── gaffer.md
│   └── CLAUDE.md
├── docs/
│   ├── setup.md
│   ├── claude-hub-setup.md
│   └── claude-hub-agent-templates.md
└── README.md
```

---

## Ground rules for the build

- **Stop at the end of each phase.** Summarize what was built, what was tested, and what the user should verify before continuing.
- **Don't scope-creep.** If something tempting but off-plan comes up (streaming JSX output, a fancy UI, agent memory persistence), note it in a TODO and move on.
- **Test each phase before moving on.** Phase acceptance criteria are non-negotiable.
- **Ask before installing non-trivial dependencies.** The daemon should have a small footprint. `ws`, `@modelcontextprotocol/sdk`, and maybe `express` is the expected max.
- **The Gaffer Panel stays dumb.** All logic, all tool definitions, all safety wrapping lives in the daemon. If you find yourself adding logic to the panel beyond "execute this string and return the result," stop and reconsider.
- **Undo groups wrap everything.** Non-negotiable. A buggy agent turn must not leave a user's AE project in a broken state that can't be Cmd-Z'd away. Every undo entry is prefixed with "Gaffer:" so the user can always see what came from the agent.

---

## Open questions for the user before you start

1. Which OS — macOS, Windows, or both? Affects CEP debug setup and binary paths.
2. Which AE version(s) to target? Affects CEP vs UXP choice and which APIs are available.
3. Is Claude Hub already running and configured, or does the setup doc need to cover installing it too?
4. Preferred port numbers for the MCP daemon and the WebSocket bridge, or should they auto-pick?
5. Should Gaffer auto-start (launchd/login item) or be manually started per session?

Ask these upfront. Don't guess.
