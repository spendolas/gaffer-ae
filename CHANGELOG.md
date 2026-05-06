# Changelog

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
