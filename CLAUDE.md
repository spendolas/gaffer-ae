# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Gaffer

Gaffer is an After Effects automation agent. Claude controls AE by writing ExtendScript and executing it via MCP tools. The panel includes a chat UI for direct interaction from within AE.

The spec lives in `docs/Gaffer_Handoff.md` — the original design document. Public repo: `github.com/spendolas/gaffer-ae` (end users install and update from GitHub Release assets, no git clone; pre-0.11 clients still read `main`).

## Architecture

```
Claude Code / Claude Hub / Panel Chat
    │  MCP over Streamable HTTP (:9824)
    ▼
Gaffer Daemon (one esbuild bundle daemon.mjs, run by the pinned official
              Node 24 binary in daemon/runtime/; dev checkouts: system node + index.js)
  - MCP tools: runJSX + 24 typed tools (project/comp/layer discovery,
    expression dump, keyframe inspection, layer/effect search, footage
    relink, render queue add, frame/layer capture, Figma import)
  - Chat handler: spawns claude -p, streams response to panel
  - Serialized execution queue (mutex — no concurrent AE calls)
  - JSX safety wrapping (undo groups, try/catch, JSON return)
    │  WebSocket ws://127.0.0.1:9823
    ▼
Gaffer Panel (CEP extension in AE) — one per AE instance, keyed by aeVersion
  - Chat UI + evalScript bridge
  - Auto-starts daemon: cp.spawn via daemon-launch.js resolveDaemonLaunch
    (fallback: ExtendScript system.callSystem() -> start.sh / start.ps1)
    │  evalScript
    ▼
After Effects
```

**Key design decisions:**
- One daemon = one serialized queue. Multiple clients share the same daemon, no races.
- Streamable HTTP transport for MCP (not stdio) because multiple clients connect.
- Panel auto-starts the daemon on load: `spawnViaNode()` in `main.js` asks `daemon-launch.js` (`resolveDaemonLaunch`) for `runtime/node daemon.mjs` (size-checked against `runtime/VERIFIED`), or a system node for dev installs and 0.11.x installs mid-migration. A runtime that exists but fails the check is an error, never a silent fallback to system node. `spawnViaExtendScript()` (`system.callSystem()` running `start.sh` / `start.ps1`, which mirror the same rules) is the fallback when CEP Node integration is missing.
- **Zero-dependency install:** end users need only After Effects and Claude. No npm runs on a user machine (install or update). The runtime is the official, unmodified Node binary from nodejs.org (mirror: GitHub release `node-v<version>`), verified by SHA-256 and vendor signature; never modify, re-sign or strip it, and never add `daemon/runtime` to PATH. Every daemon listener binds 127.0.0.1 explicitly.
- All MCP tools namespaced as `mcp__gaffer__<toolname>`.
- **Multi-AE-instance:** each panel registers with the daemon by `aeVersion`; every MCP tool takes an optional `aeVersion` param to route. With one instance connected it's implicit; with several and no param, the call errors listing available versions (`panel-bridge.js`).

## Repo Layout

```
gaffer/
├── .github/workflows/        # release.yml (gate, build, smoke, publish releases), node-runtime-check.yml (weekly Node pin check), cli-contract.yml, traffic-snapshot.yml, windows-tests.yml
├── panel/                    # CEP extension (single deployable folder)
│   ├── CSXS/manifest.xml
│   ├── index.html, main.js   # Chat UI + WebSocket client + auto-start + settings/update UI
│   ├── daemon-launch.js       # Pure launch logic: resolveDaemonLaunch, cleanDaemonEnv, launch notices
│   ├── update-state.js        # Pure update-check logic (GitHub Releases), tested from daemon/test
│   ├── host.jsx, .debug
│   ├── version.json           # {version, commit}: release version; packaged copies carry the full release SHA
│   ├── lib/CSInterface.js
│   ├── daemon/               # Node.js MCP server (lives inside panel); ships as one bundle
│   │   ├── index.js, mcp-server.js, panel-bridge.js, ports.js
│   │   ├── queue.js, safety.js
│   │   ├── chat-handler.js, claude-binary.js
│   │   ├── runtime-pins.json      # Single source of truth: Node version, URLs, SHA-256s, sizes, signing identities
│   │   ├── fetch-runtime.sh, fetch-runtime.ps1  # Download, verify and swap in the pinned runtime (installers, updaters)
│   │   ├── start.sh, start.ps1    # ExtendScript-route launchers, mirror resolveDaemonLaunch
│   │   ├── launch.cjs             # Detached spawn helper used by start.ps1
│   │   ├── update.sh, update.ps1  # One-click update from the latest GitHub release asset (stages the runtime when pins change, no npm)
│   │   ├── stop-daemon.ps1        # Stops whatever listens on :9823 (Windows)
│   │   ├── tools/                 # One file per typed MCP tool (24) + figma-translator.js helper
│   │   ├── runtime/               # Pinned Node binary + VERSION/VERIFIED stamps (installed, never checked in)
│   │   └── daemon.mjs             # esbuild bundle (built by CI or build.sh, never checked in)
│   └── prompts/gaffer.md      # System prompt for the panel chat agent
├── scripts/
│   ├── build.sh               # Local dev build: esbuild bundle -> panel/daemon/daemon.mjs
│   ├── bundle-daemon.sh       # Bundle + third-party notices + hygiene + npm audit (CI)
│   ├── third-party-notices.mjs
│   ├── release-gate.mjs       # Release gate for .github/workflows/release.yml (skip/create/recover + notes)
│   ├── package-release.sh     # Builds the four release archives + SHA256SUMS.txt from panel/
│   ├── node-runtime-check.mjs # Weekly runtime pin checker (node-runtime-check.yml)
│   ├── readme-pins.mjs        # Generates the README runtime steps from runtime-pins.json (--write)
│   ├── install-mac.sh, install-win.ps1  # Dev installers from a checkout
│   └── gaffer-cli.sh          # CLI wrapper
├── docs/                      # Spec, Claude Hub integration, bug reports
├── assets/                    # Local-only store (untracked): fonts/AdobeClean.zip (licensed), fonts/SourceSans3 (OFL, staged for bundling), Knowledge/ (AE SDK/CEP reference archives)
├── CHANGELOG.md
└── README.md                  # Includes step-by-step install instructions written FOR Claude (runtime steps generated)
```

## Commands

```bash
# Dev: npm stays out of $HOME (cache, logs, userconfig inside the repo)
export npm_config_cache="$PWD/.npm-cache" npm_config_logs_dir="$PWD/.npm-cache/_logs" npm_config_userconfig="$PWD/.npmrc-dev"
cd panel/daemon && npm ci && node index.js   # start the daemon from source (system Node 20+)

# Build the bundle locally (esbuild) -> panel/daemon/daemon.mjs
./scripts/build.sh

# Provision the pinned runtime into a daemon folder (what installers/updaters do)
bash panel/daemon/fetch-runtime.sh --into <daemon-dir>

# Dev install from a checkout (end users follow README.md instead)
./scripts/install-mac.sh    # Mac: symlink + npm install (system Node)
# or install-win.ps1        # Windows: symlink + npm, or a copy + fetch-runtime when symlinks fail

# Regenerate / check the README runtime steps after editing runtime-pins.json
node scripts/readme-pins.mjs --write
node scripts/readme-pins.mjs

# CLI usage (daemon must be running)
./scripts/gaffer-cli.sh "add a wiggle to the selected layer"

# Register MCP server with Claude Code
claude mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp
```

Tests/linters: `node scripts/check-ps-encoding.mjs` (every .ps1 must be ASCII-only + UTF-8 BOM; run before any release touching PowerShell). Daemon: `cd panel/daemon && node --test`. Release tooling (the same list `release.yml` runs): `node --test scripts/release-gate.test.mjs scripts/package-release.test.mjs scripts/traffic-snapshot.test.mjs scripts/release-docs.test.mjs scripts/cli-contract-check.test.mjs scripts/updater-scripts.test.mjs scripts/telemetry-sheet-webhook.test.mjs scripts/runtime-pins.test.mjs scripts/third-party-notices.test.mjs scripts/node-runtime-check.test.mjs scripts/smoke/smoke.test.mjs` (`release-docs.test.mjs` fails when the README's runtime URLs, hashes or Team ID drift from `runtime-pins.json`). Updater end-to-end: `bash scripts/test-update-sh.sh` (close the Gaffer panel first). `scripts/windows-tests/` holds a field-contributed Windows repro harness (encoding, console-flash, detached-spawn) plus `test-5-update-ps1.ps1` (updater end-to-end); runs on a Windows machine only.

## Releasing

- A release is: bump `version` in `panel/version.json`, add a `CHANGELOG.md` section headed `## v<version> - <date>` (bold one-line summary, then plain-language bullets), push to `main`. `.github/workflows/release.yml` runs `scripts/release-gate.mjs` (skip, create or recover), the tests and `scripts/package-release.sh`, then publishes release `v<version>` with five assets: `gaffer-install-mac.tar.gz`, `gaffer-install-win.zip`, `gaffer-update-mac.tar.gz`, `gaffer-update-win.zip` and `SHA256SUMS.txt` (the README install verifies the package against it). Before publishing, the `build` job (Node 24) bundles `daemon.mjs`, writes `THIRD-PARTY-NOTICES.txt`, runs the hygiene checks and `npm audit`, and the `smoke` job runs the packaged bundle on the official runtime on macOS arm64, macOS Intel and Windows. A push that does not change `version` publishes nothing. A version with a `-` suffix (`0.12.0-beta.1`) becomes a prerelease, which the panel never offers.
- **What ships:** `daemon/daemon.mjs` (the bundle), the one-line shim `daemon/index.js` and a dependency-free `daemon/package.json`, never `node_modules`, a source map, tests or daemon source modules. Keep the shim and the dependency-free `package.json` in every release while 0.11.x clients exist: their old updater requires `daemon/index.js` and runs `npm install --omit=dev`. The runtime is not in the package; installers and updaters fetch it.
- **Runtime pins:** `panel/daemon/runtime-pins.json` is the only place the Node version, URLs, SHA-256s, sizes and signing identities live. After changing it, run `node scripts/readme-pins.mjs --write`. A release that changes the pinned version makes the updater download the new runtime once. The mirror is a normal versioned GitHub release `node-v<version>` on `spendolas/gaffer-ae` with the official archives byte for byte plus `SHASUMS256.txt` and `.sig`, created with `gh release create node-v<version> --latest=false` (without `--latest=false` it becomes "latest" and breaks every `releases/latest` URL and the panel's update check). `.github/workflows/node-runtime-check.yml` runs weekly (Monday 08:30 UTC) and fails on a newer security release of the pinned line, a pinned hash that differs from nodejs.org, a mirror that differs from the official archives, or `releases/latest` pointing at a non-`v*` tag.
- Dry run: `gh workflow run release.yml -f dry_run=true`, then `gh run download <run-id> -n gaffer-release`. Retry a failed publish with `gh workflow run release.yml -f dry_run=false` on `main`.
- The panel checks `releases/latest` on api.github.com and `update.sh` / `update.ps1` download the matching `gaffer-update-*` asset. The `commit` field in `main`'s `panel/version.json` is legacy, kept only for pre-0.11 clients that still read `main`, and is not maintained by hand any more. Until those clients are gone, keep `panel/version.json` at that path with exactly the keys `version` and `commit`, and keep the `main` archive layout `gaffer-ae-main/panel/` unchanged.
- Download counts: the weekly traffic snapshot adds `releases`, `installs` and `updates` to `docs/traffic-snapshots.jsonl`. Only week-over-week changes mean anything.
- Deployed installs live at `~/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel` (Mac) / `%APPDATA%\Adobe\CEP\extensions\com.gaffer.panel` (Win). Daemon logs: `/tmp/gaffer-daemon.log` / `%TEMP%\gaffer-daemon.log`.
- Per-install config (`installId`, `claudeBin`, `shareUsageStats`) lives OUTSIDE the extension dir so no install/update path can wipe it: `~/Library/Application Support/Gaffer/config.json` (Mac) / `%APPDATA%\Gaffer\config.json` (Win). One source of truth: `panel/daemon/config-path.js` (`getConfigPath()`; `GAFFER_CONFIG_PATH` env overrides for tests; first access migrates a legacy `<extension-dir>/.gaffer-config.json` forward). Never compute this path anywhere else.

## Chat Handler (`chat-handler.js`)

- Spawns `claude -p --model <opus|sonnet|haiku> --output-format stream-json --dangerously-skip-permissions`, allowlisting only `mcp__gaffer__*` tools plus per-install user-selected MCP servers (the multi-select is per-install state, never committed).
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

Daemon: `@modelcontextprotocol/sdk`, `ws`, `zod`. Express comes transitively via MCP SDK. Daemon is ESM (`"type": "module"`); the build bundles it into one ESM file, `daemon.mjs` (with a `createRequire` banner for the CommonJS dependencies), which the pinned Node 24 runtime runs. Bundled licenses must stay in the `third-party-notices.mjs` allowlist (MIT, ISC, BSD, Apache-2.0, 0BSD).

## CEP Development Notes

- **PowerShell scripts (`*.ps1`) must be ASCII-only with a UTF-8 BOM.** Windows PowerShell 5.1 reads BOM-less files as Windows-1252 — a single em-dash in a comment produces phantom parse errors ("missing brace"). No typographic dashes/quotes in .ps1 files, ever.
- **Node child processes on Windows need `windowsHide: true`** (every spawn/execFile/execSync) — console-subsystem children flash a visible cmd window otherwise, and `detached: true` requires real file-handle stdio (with `stdio: 'ignore'` the child dies silently on Win11).


- Target CEP 12 (AE 2022+). Extension ID: `com.gaffer.panel`.
- Dev loading requires `PlayerDebugMode = 1` for CSXS.11, CSXS.12 and CSXS.13 (AE 2022 to 2026+; the installers and README set all three).
- The panel uses CEP's Node integration (`require('child_process')` etc.) for the daemon spawn and file access, always inside try/catch: when it is missing, OS operations go through ExtendScript `system.callSystem()` instead.
- Keyboard shortcuts (Delete, Cmd+C/V/X/Z) must be registered via `cs.registerKeyEventsInterest()`.
