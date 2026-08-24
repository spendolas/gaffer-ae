# Changelog

## v0.7.0 — 2026-08-24

**Quote a chat message and reply to it.**

- **Copy or reply on selection** — select any text in the conversation and a small floating control appears: copy it, or reply-quote it. The reply stages the snippet above the input.
- **Reply-quote tray** — staged quotes sit in a pill above the composer, each with a wavy rule marker, matched 1:1 to the Figma design. Quote several at once; the × to unstage appears on hover and every removal animates cleanly. The tray tracks the A−/A+ text size.
- **Styling preserved** — a quoted snippet keeps its original formatting (inline code, bold, links), even when the selection spans multiple messages (surrounding UI is stripped out, not carried in).
- **Carried to Gaffer** — staged quotes are sent along as tagged context so Gaffer knows exactly what you're replying to, and they're stored with the message so they re-render on reload.
- Dev footer now shows the live git HEAD rather than the frozen release commit.

_Internal:_ a node-level Figma↔panel parity pipeline (`design/scripts`) — auto-discovering extractor, `data-fig` anchoring, and a property diff with a coverage ledger — replaces the hand-authored assertion list.

## v0.6.1 — 2026-07-30

**Panel polish — chat text sizing, reply sounds, and a colour pass.**

- **Adjustable chat text size** — an A−/A+ control in the activity bar scales the whole conversation *and* the composer together, 80%–160%, remembered across reloads. Tapping it never expands the drawer.
- **Reply sounds** (off by default) — an optional cue when Gaffer finishes while the panel is unfocused, chosen from a small set in the settings; a quiet radio tick when you enable/disable an MCP server; and a distinct error cue. It self-silences after a few unattended cues so nothing chirps all night.
- **Table-row hover** — hovering a markdown table row now highlights it.
- **Text colours matched to the design** — bold and headings, table header/data cells, code blocks, and the input placeholder now track their Figma tokens, with new warm `strong` / `strong-dimmed` emphasis colours (bold reads warm-and-heavy rather than glaring; bold inside a blockquote dims to suit).

## v0.6.0 — 2026-07-29

**Six new discovery tools** — the typed tool surface now covers essentially everything AE exposes for reading (mutations stay in `runJSX`, where the undo-group safety lives):

- `listMarkers` — comp + layer markers (time, duration, comment, chapter/url/cue-point)
- `listTextLayers` — text contents + type styling across the active comp or the whole project
- `getLayerEffects` — a layer's full effect stack with values, keyframe counts, and expressions
- `getShapeContents` — the shape-layer contents tree and all masks, with optional raw vertex data
- `getProjectTree` — the real project-panel hierarchy (folders, comps, footage, solids, parent ids)
- `getProjectSettings` — AE version/build, color depth and working space, expression engine, GPU acceleration, time display

All six verified end-to-end against a live AE fixture (12/12 assertions).

## v0.5.13 — 2026-07-14

Refinements from the Windows field handoff (thanks to the reporter's isolation harness):

- **Update spawn drops `detached` on Windows** — every flag combination containing it silently kills the child on Node v24/Win11 (verified isolation table); the child survives panel reloads regardless. macOS keeps its proven behavior.
- **Desktop-app CLI version dirs sort numerically** — lexicographic order put 2.1.9 above 2.1.121; the newest CLI is now actually picked, and a vanished cached binary (the version dir churns on every CLI auto-update) triggers re-discovery instead of dead spawns.
- `start.ps1` gets the same ASCII + UTF-8 BOM treatment as the other PowerShell scripts.

## v0.5.12 — 2026-07-14

All four Windows findings from the field, upstreamed:

- **The update-mechanism regression, solved** — the updater script had picked up typographic dashes in comments; Windows PowerShell 5.1 reads BOM-less files as Windows-1252 and fails parsing on them. Both .ps1 scripts are now ASCII-only with a UTF-8 BOM (and the repo rules forbid reintroducing this).
- **Updater spawn hardened** — `detached` + `stdio: 'ignore'` silently kills the child on some Node/Windows combos; the updater now logs to a file handle like the daemon spawn always did (`%TEMP%\gaffer-update-spawn.log`).
- **CLI discovery finds desktop-app installs** — `%APPDATA%\Claude\claude-code\<version>\claude.exe` is now scanned (newest first); previously only the standalone/WinGet paths were checked.
- Console windows hidden on all CLI child processes (shipped in 0.5.11, noted here for the set).

## v0.5.11 — 2026-07-14

- **No more cmd window flashes on Windows** — every CLI child process (`claude mcp list` on drawer expand, model discovery, auth, chat itself) now runs with a hidden console. Killing the flashed window used to kill the underlying command and error the MCP row.

## v0.5.10 — 2026-07-14

- Update banner hides its buttons while an update runs — just "Updating…" until the panel reloads itself

## v0.5.9 — 2026-07-14

- **Copy button fixed on Windows** — the clipboard fallback shelled out to macOS-only `pbcopy`, popping an AE error dialog ("cannot find the file specified"). Copy now uses the browser's synchronous clipboard command — no shell, works identically on both platforms.

## v0.5.8 — 2026-07-14

- **The Windows one-click update root cause** — `update.ps1` called bare `npm`, but the panel's Update button spawns PowerShell with CEP's stripped PATH, so npm never resolved and the script died before finishing (manual terminal runs always worked, which hid it). The updater now resolves npm from the standard Node.js install locations, like the macOS script always did.

## v0.5.7 — 2026-07-14

One-click update flow, actually end-to-end:

- **Panel waits for the updater to finish** — it polls the on-disk version and reloads only when the commit moves (previously it reloaded after 2s while the updater was still downloading, showing a false "did not complete" notice and never picking up the new code)
- **No daemon respawn mid-update** — the panel paused restarting the daemon while files are being replaced (a half-copied daemon grabbed the port and could lock node_modules during npm install); both updaters also stop any straggler daemon right before finishing
- Banner shows "Updating…" with the button disabled while the update runs

## v0.5.6 — 2026-07-14

- Update banner renders above the chat fader (was washed by the gradient)
- Update-flow verification release — first one-click update expected to succeed end-to-end on Windows

## v0.5.5 — 2026-07-14

- **MCP tiles redesigned (final form)** — fixed 48×40 rounded tiles: enabled = dark inset with blue glyph, available = bare with muted glyph, needs-auth/error = amber/red with dark glyph. Attention colors only where action is needed.
- **Vector-or-monogram icons** — the favicon pipeline is gone (inconsistent, platform-fragile); tiles show flat brand vectors from the simple-icons CDN (smarter name matching recovers e.g. Zoom) or a two-letter monogram. Trademark-removed brands (Slack, Adobe) intentionally wear monograms.
- **Tooltips carry state detail** — second line shows Connected / Available / Click to authorise / Authorising… / Error with the actual error title.
- **Windows: the Update button works** — spawn failures were silent (async error event never handled) so the updater never launched; now falls back properly and uses an absolute PowerShell path.

## v0.5.4 — 2026-07-14

Windows update-flow fixes:

- **Old daemon survived updates on Windows** — the process filter matched executable paths (always `node.exe`), so the stale daemon kept running and the reloaded panel reconnected to old code. Both the updater and installer now match by command line.
- **Failed updates are no longer silent** — if the updater dies before finishing, the panel says so after reload (with the log location) instead of just re-showing the update banner
- PowerShell runs with `-NoProfile` (user profiles can break or slow the updater)

## v0.5.3 — 2026-07-14

- **Stale-session self-heal** — when the Claude CLI's session storage is wiped (CLI updates, re-auth), the panel's saved session ID pointed nowhere and chats silently hung. The daemon now detects the dead `--resume`, notifies the panel, and retries once on a fresh session automatically — history text is preserved. Failed chats can no longer end silently: any zero-output error surfaces in the chat.
- **Brand-vector icons for everyone** — MCP tiles fetch flat single-color brand icons from the simple-icons CDN first (favicon fallback stays), so end-user installs get the same crisp glyphs as dev machines
- Icon cache probe no longer aborts on the first missing extension (icons were re-fetched every daemon start)

## v0.5.2 — 2026-07-14

Windows MCP tile rendering fixes:

- **Flat-glyph masking on Windows** — mask analysis now decodes icons via an origin-clean bitmap path, dodging the CEF builds that taint `file://` canvases (masks silently never computed there, leaving raw colored favicons)
- **Correct image types** — favicons are content-sniffed (many `/favicon.ico` files are really PNG); wrong declared types could break decoding
- **No more broken-image tiles** — undecodable icons fall back to the two-letter monogram instead of a broken image with alt text

## v0.5.1 — 2026-07-14

Clean-install simulation fixes (Windows focus):

- **npm-installed CLI shims can't be spawned** — binary discovery now only accepts a real `claude.exe` on Windows and otherwise fails with an actionable error (native installer command + `.gaffer-config.json` override)
- **Chat no longer depends on the installer's MCP registration** — the gaffer server is passed inline on every chat call, so chat works even if `claude mcp add` never ran (e.g. CLI installed after the panel)
- Installer's missing-CLI error now shows the actual install command

## v0.5.0 — 2026-07-14

- **Typography ships to everyone** — Source Sans 3 + Source Code Pro (both open-license) are now bundled, so end users get the designed type instead of system-font fallbacks. Adobe Clean is retired from the stack; dev and user machines render identically.
- **Type polish** — SemiBold weight cap across headings/bold/table headers, −2% tracking on code, monogram tiles restyled, chat notices unified with the hint style, deep markdown headings (h5/h6) clamp to the h4 size instead of leaking browser defaults.
- **Windows installer fixes** — installing over an existing setup now stops the running daemon and preserves chat history; the non-symlink fallback previously deployed a daemon without its dependencies (it could never start) — fixed. Model-version discovery also no longer depends on `$HOME` (unset on Windows).
- **Updating docs** — README now covers the update path, including manual updates from v0.1.0.

## v0.4.0 — 2026-07-14

Full visual redesign — the panel now matches the Gaffer design system 1:1 (verified numerically against the Figma spec, 55/55 checks).

- **New design system** — Adobe Clean typography, 47 design tokens, SVG icon set, restyled bubbles/markdown/code, pill input with animated send, floating status star with hover descriptions (status, clear, reload)
- **Panel background follows AE** — reads the host theme (and the brightness slider) instead of a fixed color
- **Chat scrolls behind the input** — with a gradient fader masking messages as they pass under; attachments tray and update banner float above the chat without ever shifting your scroll position
- **MCP server tiles** — color-coded states (blue enabled, amber needs-auth, red failed), brand icons with automatic favicon fetch + flat single-color conversion, usage-based ordering, hover tooltips
- **Model controls, discovered from your CLI** — model, context (Latest / 1M / pinned versions like 4.6) and reasoning effort selects; options come from the installed `claude` CLI, not hardcoded lists
- **Quieter tool activity** — tool chips reduced to a line of color-coded status dashes (name on hover); thinking dots return whenever the agent goes quiet mid-turn
- **Image attachments polish** — 80px ratio-preserving paste chips in a docked tray, redesigned drop overlay and lightbox
- **Fixes** — model dropdown clipping, MCP logo flicker and filled-blob icons, mixed-font line heights, scrollbar stopping at the input edge

## v0.3.0 — 2026-05-06

- **Per-install MCP multi-select** — pick which Connected MCP servers (Grip, Notion, Figma, etc.) the chat agent has access to, via the activity bar. Persisted per install, never committed to the repo.
- **14 new MCP tools** for AE introspection, search, capture, and render-queue work:
  - Discovery: `listFonts`, `listCompositions`, `getSelectedLayers`, `listFootage`, `listExpressions`, `listExpressionControls`, `getRenderQueue`, `getLayerKeyframes`
  - Search: `findLayers` (regex/effect/expression), `whereUsed`
  - Capture: `captureFrame` (any time, any comp), `captureLayer` (auto solo/restore)
  - Modify: `relinkFootage`, `addToRenderQueue` (queues only — never starts a render)
- **Image paste/drop input** — drop images anywhere on the panel or paste in the textarea. Full-panel "Drop image here" overlay, click-to-zoom lightbox, persisted thumbnails so bubbles survive panel reload.
- **Apple Silicon / minimal-PATH fix** — daemon augments PATH on the `claude` subprocess so stdio MCP servers (e.g. grip's bare `node` command) can spawn under CEP's stripped environment.
- **Cleaner tool pills** — dedupe by tool_use_id, descriptive labels, color states (running/done/error), proper transitions.

## v0.2.0 — 2026-04-24

- **Model picker** in panel — choose between Opus (default), Sonnet, Haiku per session
- **Auto-update check** — panel detects newer commits on `main`, shows update banner, one-click update
- **Settings UI** in activity bar — model dropdown, auto-check toggle, Check now button, version display
- **`importFromFigma` MCP tool** — deterministic Figma→AE layer translation
- Figma→AE translation rules added to `gaffer.md` (text positioning, shape contents order, drop shadow direction, squircle handling, @2x rules)

**Note for v0.1.0 users:** First-time update from v0.1.0 must be done manually via Claude Code. Tell Claude: "Update Gaffer from https://github.com/spendolas/gaffer-ae". Future updates auto-check from the panel.

## v0.1.0 — 2026-04-23

- Initial public release
- CEP panel with chat UI, daemon auto-start
- MCP tools: `runJSX`, `getProjectSummary`, `listEffectMatchNames`, `captureActiveComp`
- Install scripts for macOS and Windows
- README with download-from-tarball install (no git clone needed)
- Hardened install instructions with rules for Claude, idempotency guard, verification step
