# Changelog

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
