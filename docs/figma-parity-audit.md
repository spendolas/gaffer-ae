# Figma → Panel Parity Audit (v2 — post-review)

Source of truth: Figma file **Plugin Dev**, page **Gaffer** (173:2), via grip.
Everything under `MCP_IGNORE` (174:843) is excluded by decision.
v2: corrected after a three-way adversarial review of v1 against the raw walks — key fixes: assistant bubbles have **no border**, bubble body type is **14/16**, the update banner is a **bottom-docked overlay pill**, the "LED" is a **12×12 star**, MCP tiles are **equal-fill**, and Fable **is** designed. Data caveat that caused v1's errors: `spec-*.json` digests originally included hidden layers; regenerated with visibility handling (hidden nodes are now `{hidden:true}` stubs — full detail for them lives in `walk-*.json`).

| Data | Path | Producer |
|---|---|---|
| Design tokens (machine-readable) | `design/tokens.json` | `design/scripts/digest.mjs` |
| Full node walks (6 roots, zero truncation, incl. hidden layers + visibility flags) | `design/refs/json/walk-*.json` | `design/scripts/figma-extract.mjs` |
| Flattened per-node specs (visible only) | `design/refs/json/spec-*.json` | `digest.mjs` |
| Token↔code color deltas | `design/refs/json/token-deltas.json` | `digest.mjs` |
| Non-CSS props / overflow / constraints flags | `design/refs/json/flags.json` | `digest.mjs` |
| PNG @2x refs (116) + icon SVGs, keyed by node id | `design/refs/png/`, `design/refs/svg/` | `figma-extract.mjs` |
| Current CSS + JS-style inventory | `design/refs/panel/css-inventory.json` | `design/scripts/css-inventory.mjs` |
| Live panel baseline: 11 states, screenshots + computed styles | `design/refs/panel/state-*.{png,metrics.json}`, `env.json` | `design/scripts/panel-capture.mjs` |

Component anchors: Organisms 188:1206 (ChatMessages 191:1272, InputArea 191:1273, ActivitySummary 191:1274, DropOverlay 191:1275, ImgLightbox 191:1276, ActivityLog set 191:1343, UpdateBanner 191:1271) · Molecules 185:1091 (Bubble set 183:1055, InputRow set 195:1429, ActivitySettingsRow set 185:1193, PastePreviewRow 185:1163, BubbleImagesRow 185:1164, MarkdownTable 185:1166) · Atoms 187:1205 · Template 188:1207 · Panel instance 284:2052 (507×1001) · States Board 173:292 (17 cells) · MCP picker cell 173:506.

---

## 1. Global policies

1. **CSS baseline: Chromium 99.0.4844.84 (verified live).** No `:has()`, container queries, CSS nesting, or `color-mix()`. Custom properties + flexbox. Captured at dpr 2, viewport 505×999 (≈ the 507×1001 Figma Panel instance — numeric comparison valid).
2. **Theme policy: fixed dark**, single mode. Ignore AE brightness slider.
3. **Responsive (definitive, from the 360 vs 507 instances):**
   - Panel = vertical stack, gap 0, clips, bg `bg/panel`. **ChatMessages is the only vertical grower**; banner/input/activity heights fixed (34/52/40 collapsed).
   - ChatMessages stretches full width. **Assistant bubble stays FIXED 300px** (does not stretch; inner markdown blocks track it at 284). **User bubble HUGs with no max-width in the file** → code policy needed: cap at min(hug, panel−48px); with images it reaches ~88% (280px image + pad).
   - InputArea FILL; InputField FILL; 32×32 send button fixed, **bottom-anchored** as the field grows (48→80/96h). PastePreviewRow is fixed-348 in the file (oversight) — stretch it in code.
   - ActivitySummary is SPACE_BETWEEN: Status+Clear+Reload group sits **left**, "More/Less" pinned **right** (beware: Figma layer names are inverted — `activity-right` is the left group).
   - The three ModelSelects are **equal-FILL** across the row width. MCP tiles: min-width ~45px, **row scrolls horizontally** (user-confirmed; the file's FILL sizing reflects the 8-tile example, not an anti-scroll intent).
   - DropOverlay/ImgLightbox are absolute, fixed 360×600 in the file — implement as `inset: 0` full-panel overlays.
   - No design exists below 360px; treat 360 as min sensible width.
4. **Overflow: no truncation rules anywhere in the file** (218 visible text nodes). Policy: single-line UI labels get ellipsis; chat/markdown wraps.
5. **Scrollbars: none designed.** Spec: 6px overlay `::-webkit-scrollbar`, thumb `--color-border-input`, transparent track, on chat log / code blocks / tables.
6. **Effects: ZERO file-wide** — no shadows, no blurs, flat design throughout (even the floating banner pill and overlays). Remaining non-CSS flags: `strokeAlign=CENTER` on icon vectors (ship as SVG, moot) and one `cornerSmoothing=0.6` icon (ignore).
7. **Icons: inline SVG** from atoms `Icon=` {Refresh, Up, Stop, Check, Close, Copy, Chevron Down, Chevron Up, Drop, Brush} (`design/refs/svg/`), 16×16, 1px center-stroke `currentColor` (Stop is a filled square, not stroked). Replace all unicode glyphs.

## 2. Typography

Design font **Adobe Clean**; code font **SF Mono** (fallback Consolas). Corrected scale:

| Role | Font | Size/LH |
|---|---|---|
| **Bubble body (user/assistant/error), blockquote, input text/placeholder** | Adobe Clean Regular (placeholder: **Italic**) | **14/16** |
| Banner text, markdown table cells, code inline/block | AC Regular / SF Mono | 12/16 |
| Table headers, emphasis | Adobe Clean ExtraBold | 12/16 |
| UI labels (settings, status, hints, buttons) | Adobe Clean Regular | 10/15 (10/10 in tight rows) |
| ValueLines (lastJsx/lastResult) | SF Mono Regular | 10/15 |
| Pill labels | SF Mono Regular | 9/13.5 |
| MCP monogram tiles | Adobe Clean **Bold SemiCondensed** | 16/16 |

⚠️ **Font-file gap:** `AdobeClean.zip` contains Regular/Bold/Black/Cond weights — **Italic and Bold SemiCondensed are not confirmed present**. Check the zip before step 1; fallbacks: synthetic italic (CSS `font-style`), Bold for monograms. Licensing: font files stay untracked.

## 3. Design tokens → CSS custom properties

`design/tokens.json` = all 47. 25 match code exactly. The 10 color deltas (see v1 table, unchanged — `token-deltas.json`): bg/input #121212, bg/banner #173658, border/banner #5876B2, text/code #FFBB4E, accent/blue #4D9DF7, accent/green #3DC17F, accent/amber #D09726, bubble/assistant-bg transparent, btn/primary-bg #4A7DC9, btn/danger-bg #EC4848. Plus `bubble/user-bg` #000 (vs current #3a3a5a).

**Unbound colors used in the design but missing from the token set** — tokenize during step 1 (proposed names):
| Proposed token | Value | Used by |
|---|---|---|
| `color/bubble/error-bg` | #CC4444 @ 0.50 | error bubble fill |
| `color/bubble/error-text` | #EE8888 | error bubble text |
| `color/code/inline-bg` | #D8B070 @ 0.20 | CodeInline chip bg |
| `color/code/block-text` | #D8D8D8 | CodeBlock body text |
| `color/mcp/tile-glyph` | #E8EEFA | MCP tile brand glyphs |
| `color/text/placeholder` | #777 @ 0.5 | input placeholder |

⚠️ **Checkbox atom is unfinished**: checked #0078D4 / unchecked #FFF, both off-palette and unbound — and the state cells use the **Toggle** atom for auto-check anyway. Skip Checkbox; use Toggle.

## 4. Per-surface spec vs current code

### 4.1 Chat bubbles (Bubble set 183:1055)
- **User**: bg `#000` (`bubble/user-bg`), radius **[16,16,2,16]**, pad 8 (inner text pad 0/4), text `text/light` **14/16**, HUG width right-aligned (max-width = code policy, §1.3). Current: #3a3a5a, r6, 13px.
- **Assistant**: **NO visible chrome** — **user-confirmed intentional**. Fill transparent, stroke hidden; renders as plain text on panel bg. **Fixed 300px wide.** Text `text/light-2` 14/16. Remove the current border+bg.
- **Error role** (`176:934`): 180×32 hug, radius [16,16,16,2], **bg #CC4444 @ 0.50, text #EE8888** 14/16 (sample: "[Error: claude cli not found]"). Replaces/augments current `.chat-notice` for errors.
- **hasImages variants**: pad becomes **[8,8,12,8]** (bottom 12), BubbleImagesRow 280×180 images r8; user bubble reaches ~88% width.
- **ToolPillsRow renders INSIDE the assistant bubble**, stacked between text and CopyBtn (bubble internal gap 12). Current code renders pills inline in text flow — placement change.
- **TypingIndicator** (215:2620): 24×12, pad 4, gap 2, three 4×4 dots `text/dimmest` — inside the assistant bubble during busy (Cell: Busy shows a 40×28 bubble containing only it). Current `.typing-indicator` exists — restyle + relocate.
- **CopyBtn**: icon button 24×24 r8 bg `border/default`, Copy icon 16×16 (current: text link).
- Row gap 8; ChatMessages container pad **[8,12,8,12]**, no fill, clips.

### 4.2 InputArea (191:1273; InputRow set 195:1429)
- Organism: vertical, **gap 6, pad [2,6,2,6]**, FILL×HUG.
- **InputField**: pill r24, bg `bg/input` #121212, h48 (grows 80/96 multiline), pad 8, text 14/16. Send button 32×32 r16 embedded, **bottom-anchored** in the field.
- **Placeholder varies by connection state**: Disconnected/Starting → **"Gaffer"**, AC Regular, #777@0.5; Connected → italic prompt (e.g. "Animate the states of my Figma boards"), same color.
- **Send button state matrix** (from Connection cells — richer than the Button atom set):
  | State | Fill | Icon |
  |---|---|---|
  | Disconnected/Starting | `bg/panel` @ 0.40 | none |
  | Connected, empty input | `btn/primary-bg` @ 0.40 | Up |
  | Typed | `btn/primary-bg` @ 1 | Up |
  | Busy | `btn/danger-bg` #EC4848 | filled 12×12 square (Stop) |
  Busy also clears the field back to the italic placeholder.
- **Disabled treatment (all Button atoms): whole-node opacity 0.4**, fills unchanged.
- PastePreviewRow (185:1163): hidden by default; chips 56×56 r8, CloseBtn 16×16 r8 bg `btn/icon-bg` #000@0.7 with 12×12 Close icon (0.75px stroke); row pad 0/16 gap 4; stretch the row in code (fixed-348 is a file oversight).
- Input hint line: dropped in the design (confirm removal at implementation).

### 4.3 Tool pills (Pill atom set)
16h, r8, pad 1/6, SF Mono 9/13.5. Label colors: running `accent/amber`, done `accent/green`, error `accent/red` on fills `pill/running|done|error` (already token-matched). `state=default` gray pill for generic labels. Row gap 2. Placement: inside assistant bubble (§4.1).

### 4.4 ActivityLog (set 191:1343) / ActivitySummary (191:1274)
- Collapsed 40h (pad [4,0,4,0]); expanded pad [4,0,0,0]. **Expanded = 144h**: summary 32 + mcps 48 + model 30 + version 30. **Actions rows (lastJsx/lastResult): user decision — hidden behind a code debug toggle**, shown only when they carry value (spec when shown: 360×46 frame pad 8, ValueLines 344×15 FILL, **SF Mono 10/15** `text/dimmer`).
- Summary: SPACE_BETWEEN. Left: Status (star-LED + "Connected" 10/10 `text/dimmer` — text color constant across states, **only the LED color changes**) + ClearBtn/ReloadBtn (icon buttons 24×24 r8 bg `border/default`, Brush/Refresh icons). Right: **"More"/"Less" label 10px `text/dimmer` + chevron down/up**.
- **The status "LED" renders as a 12×12 four-pointed star** (the 8×8 circle layer is hidden) in `accent/red|amber|green`. Current: 7×7 css circle.
- Rows are `ActivitySettingsRow` variant **`general`** (30h, pad [6,8,4,8], gap 12) except `mcps` (48h, pad [4,0,4,0]):
  1. MCP tiles row (§4.6)
  2. Model row: leading **"Model:" label 10/15 `text/dimmer`**, then **three ModelSelect dropdowns, equal-FILL** (101×20 base, r8, bg `border/input`, chevron): model / "Latest • 1M" variant / "Medium" effort. **ModelSelect open popup**: 65×80 r8 bg `border/input` pad [0,2], options 20h pad 6 — **Fable, Opus, Sonnet, Haiku** (Fable IS designed); selected option bg `btn/primary-bg` r6.
  3. Version row: version 10/15 `text/dimmest` · FILL spacer · **Toggle atom 24×12 r16** for auto-check (On: track `accent/blue`, handle `text/light` 12×8 r4; Off: track `bg/input`, handle `text/dimmest`) + label 10/15 · CheckNow text button (hug, 61×20 in situ, r8 bg `border/input`, label 10/10 `text/light-2`).

### 4.5 UpdateBanner (191:1271)
**Bottom-docked overlay**, hidden by default: floats over the last 34px of the chat, **flush above InputArea** (radius [16,16,0,0] meets the input area). Container 360×34 pad [4,6,0,6]; **pill 255×32 horizontally centered**, pad **[6,6,6,12]** (L12), **gap 40** between text and actions. Text 12/16 `accent/blue`; UpdateBtn 46×20 r8 bg `btn/primary-bg` with label 10/10 in **`bg/panel`** (dark-on-blue); DismissBtn 20×20 r8 transparent, Close icon in `btn/primary-bg`. No shadow. Current: full-width top bar — position, shape, and colors all change.

### 4.6 MCP row (ActivitySettingsRow `kind=mcps` 185:1192; Cell: MCP picker open 173:506)
The tiles row IS the picker ("open" = ActivityLog expanded). Tiles 40h × ~45w (min-width 45; may relax toward equal-fill only when few servers), gap 0, brand glyph 16–24px in **#E8EEFA**, monogram fallback (AC Bold SemiCond 16, e.g. "DS"). **The row scrolls horizontally** — user-confirmed intent; the file simply shows no overflow example (8 tiles). Keep the sort from current code (enabled → connected → auth → failed) so active servers sit in the visible viewport; thin overlay scrollbar per §1.5. Fill encodes state — **user-confirmed semantics v2 (overrides the file's layer names; green is dropped — it competed with blue)**:
- **Enabled** (in the chat allowlist) → `accent/blue`
- **Available** (connected, not enabled) → **no fill** (the file's transparent "Off" styling — availability needs no signal)
- Needs auth → `accent/amber`
- Error/failed → `accent/red`
- `accent/green` is NOT used on tiles.
**Every tile has a hover state**; none drawn in the file → subtle treatment (e.g. fill brightness +12%, or a faint `border/default` fill on the no-bg available tiles), same rule everywhere incl. monograms.

**Icon acquisition pipeline** (user-requested): resolution order per server —
1. **Bundled collection**: brand SVGs already in the Figma file (grip, Notion, Box, Spotify, Hugging Face, Three.js, Autodesk — exported in `design/refs/svg/`; ship in `panel/icons/`).
2. **Fetched from the server**: daemon-side (panel CEF shouldn't fetch cross-origin) — during `listMcps`, for servers without a bundled icon, derive the vendor domain from the MCP URL (`claude mcp list` provides it, e.g. `mcp.notion.com`), fetch the site favicon (`https://<domain>/favicon.ico`, or parse `<link rel="icon">` off the root page), cache to disk (e.g. `panel/.gaffer-icons/<server-id>.png`, gitignored), and hand the panel a data URL alongside the server entry in the `mcps` ws message. Fetch once, refresh only on cache miss.
3. **Monogram fallback**: first letters of the display name, AC Bold SemiCond 16, when nothing resolvable.
Functionality carried from current code: click-to-toggle, needs-auth click → `claude mcp login` (existing `auth_mcp` plumbing), refresh, error row. Auth-pending visual: not designed — suggest amber tile pulse.
`MCPChipInline` (185:1161) and `MCPSettingsRow` (185:1162): **user-confirmed legacy** — skip both.

### 4.7 DropOverlay (191:1275)
`inset:0` overlay, bg `overlay/drop` #233C64@0.85, centered vertical stack gap 8: **"Drop here" text (10/15, `border/banner` #5876B2) ABOVE the Drop icon** (16px, same color). No border (current dashed border goes away).

### 4.8 ImgLightbox (191:1276)
`inset:0`, bg `overlay/lightbox` #000@0.85, image r8, centered. Current: no radius.

### 4.9 Connection states (States Board Row: Connection)
Between Disconnected/Starting/Connected only three things change: **star-LED color** (red/amber/green), **input placeholder** ("Gaffer" vs italic prompt), **send button** (§4.2 matrix). Status text stays 10/10 `text/dimmer`. Connected-idle chat is genuinely empty — no welcome/empty state designed.

### 4.10 Markdown (atoms + Markdown cells)
- **CodeInline**: chip r8 pad 4/8, **bg #D8B070 @ 0.20** (translucent amber), text `text/code` #FFBB4E, SF Mono 12/16.
- **CodeBlock**: r8 pad 4/8, bg `bg/input`, **text #D8D8D8** (gray — NOT the amber token), SF Mono 12/16, no border. FILL width.
- **Blockquote**: left rule 2px `text/hint` #555 (current code already matches), pad 4/0 gap 8, text `text/muted` 14/16.
- **MarkdownTable**: r8 container, bg `bg/input`, rows 24h, cell pad 4/8, header **AC ExtraBold 12/16 `text/strong`**, body 12/16 `text/strong`, **zebra striping `bg/table-row` #000@0.2 on the FIRST data row** (odd rows), and a **column divider: right-edge stroke in `bg/panel` #232323 on first-column cells** (reads as a panel-colored gap between columns). No outer borders.
- **Coverage gap vs marked.js**: hr, images-in-markdown, h4–h6, deep nested lists undesigned — extrapolate from tokens (flagged, low risk).

### 4.11 Template (188:1207) / Panel instance (284:2052)
Child order: **ChatMessages (grow) → UpdateBanner (hidden overlay, out of flow) → InputArea → ActivityLog**; DropOverlay + ImgLightbox absolute on top. In-flow children sum exactly to panel height. Use the 507 instance for integration checks (§1.3 responsive map).

## 5. Functionality gaps

**Designed but not built:**
1. MCP icon-tile row incl. brand icons + monogram fallback (§4.6)
2. Input pill with embedded bottom-anchored send + typed/busy/connection-state matrix (§4.2)
3. Error-role bubble (exact spec now in §4.1)
4. Icon-button system (Clear/Reload/CheckNow/Dismiss/Copy)
5. ModelSelect custom dropdown with open popup (options incl. Fable — designed, contra v1)
6. **Model row extra selects** — scoped 2026-07-10, both CLI flags verified live (`--effort low|medium|high|xhigh|max`; `--model "opus[1m]"`): panel enables the two disabled selects (reuse the ModelSelect popup), persists `effort`/`variant` in chat-history, sends `effort` in the ws chat message; daemon whitelists and appends `--effort` (~5 lines in `chat-handler.js`); variant composes into the model string panel-side (no daemon change). No flag sent unless user picks — behavior unchanged by default. ~40 lines total + one daemon restart; bundle with step 6's daemon work.
7. "More/Less" chevron summary affordance
8. Markdown table striping + column dividers, borderless
9. Update banner as bottom-docked centered pill
10. Star-shaped status LED
11. State-dependent input placeholder ("Gaffer" / italic prompt)

**Built but not designed** (keep functional; style with tokens):
1. "+N need auth" collapse — superseded: the tiles row scrolls (§4.6); drop the collapse, keep the sort
2. Auth-pending "authorizing…" state (suggest amber pulse)
3. MCP list error message row
4. Dev-install badge + disabled-updater alert
5. Input hint line (design drops it — confirm)
6. Compacting/compacted notices (style within notice/error bubble family)

**All open items resolved (user, 2026-07-10):** assistant bubbles borderless · tile fills v2: **blue=Enabled, no-bg=Available** (green dropped), amber=auth, red=error, all with hover · MCPSettingsRow/MCPChipInline legacy, skip · Actions rows behind a debug toggle · Checkbox atom skipped in favor of Toggle.

## 6. Implementation backlog (ordered)

1. **Fonts + tokens**: check zip for Italic/BoldSemiCond weights; `@font-face` (untracked); `:root` from `design/tokens.json` **+ the 6 unbound-color tokens (§3)**; replace all literals (locations in `css-inventory.json`).
2. **Icon system**: inline SVGs, replace glyphs (incl. 12×12 star LED).
3. **Bubbles + markdown** (§4.1, §4.10) — includes pill/typing relocation into bubbles, error bubble, borderless assistant (after designer confirm).
4. **InputArea pill** (§4.2) — full send-button state matrix + state-dependent placeholder + paste chips.
5. **ActivityLog stack** (§4.4) — More/Less, star LED, icon buttons, Toggle, 3× ModelSelect (UI first; variant/effort plumbing can trail).
6. **MCP tiles row** (§4.6) — scrolling row + icon pipeline (bundled SVGs → daemon favicon fetch/cache → monogram). Daemon work: favicon fetcher in `chat-handler.js`/`listMcps`, icon cache dir, data URLs in the `mcps` message.
7. **UpdateBanner pill (bottom-docked), DropOverlay, Lightbox** (§4.5, 4.7, 4.8).
8. **Template integration** against Panel instance + States Board; re-run `panel-capture.mjs`; numeric diff per state vs `spec-*.json` (±1px, exact tokens).

## 7. Verification

### Pipeline (2026-08-23 — node-level auto-diff)

The audit is no longer a hand-picked assertion list. Run, in order (grip + AE
panel both open):

```
node design/scripts/figma-extract.mjs   # auto-discovers roots, walks to disk
node design/scripts/css-inventory.mjs
node design/scripts/digest.mjs           # walk-*.json → spec-*.json + tokens
node design/scripts/panel-capture.mjs    # live CDP capture (:13870)
node design/scripts/diff-parity.mjs      # node-level diff + coverage ledger
node design/scripts/verify-parity.mjs    # legacy curated guard (still useful)
```

**`figma-extract.mjs` auto-discovers roots** — it enumerates the Gaffer page +
the Components section every run and **hard-fails on any unrecognised top-level
surface**, so new design work can't hide from the audit behind a frozen list.
Add each new surface to `EXTRA_ROOTS` (diffed) or `NON_SURFACE` (reference art).
Walks now stream to disk via `export_node format:JSON` (grip's 120KB read cap
makes `get_node` unusable for full trees).

**`diff-parity.mjs` is the anti-cherry-pick tool.** For every panel element
carrying `data-fig="<figmaId>"`, it derives the expected CSS from that Figma
node's spec and diffs **all** deterministic props (bg/text color, per-corner
radius, padding, gap, font-size, line-height) — nothing picked by hand. It gates
out unobservable checks (gap with <2 children; padding on a FIXED axis, absorbed
by fixed size + centering). It also writes `parity-coverage.json`: every visible
Figma node with paint/text/radius but no anchor, so unimplemented surfaces show
up as explicit gaps. `panel-capture.mjs` records each element's `data-fig` and
neutralises the user's A-/A+ chat zoom (`--chat-text` → 1) so numbers are scale-
independent.

Anchored & green (2026-08-23): the whole **InputArea 427:3058** — reply-quote
tray (Pill/Wave/text 427:3102–3105), UpdateBanner, InputField+send, paste
tray/chip/close — 14 nodes / 82 props, 0 mismatches. Add `data-fig` anchors to
extend coverage to bubbles/markdown/activity as those surfaces are revisited.

**Reply-quote tray — canonical component `428:3200` "Reply Quote" (COMPONENT).**
⚠️ `427:3102` (inside `InputArea 427:3058`) is a **stale draft FRAME** — it lacks
the DismissBtn and has different colours; do not anchor to it. Always anchor the
COMPONENT. The tray is anchored to the 428-series (Pill 428:3186, Quote Wrapper
428:3187, Wave 428:3188, banner-text 428:3198, DismissBtn 428:3201).

- Pill `bubble/user-bg` #000, radius [16,16,0,0] (docks flush like the banner),
  VERTICAL gap 12, pad [8,6,8,12].
- Quote Wrapper HORIZONTAL, counterAxis **CENTER** → CSS `align-items:center`
  (text centered in the row); wave `align-self:stretch` (V:FILL); DismissBtn
  `align-self:flex-start` (its Alignment Wrapper 428:3224 is MIN/top). Getting
  this wrong = a 2px top offset the property diff can't see.
- Wave = vertical sine left-rule (5px, period 12, round caps) tiled `repeat-y`,
  stroke **`text/dimmer` #888** (180:962).
- banner-text 12/16 glyphs are **`text/hint` #555** — a **text-range fill**
  (`textRangeFills` → 180:965) overrides the layer default (`text/strong dimmed`
  #C2C0BC). `digest.mjs` resolves textRangeFills for TEXT so the diff's expected
  color is the painted one. Scales with the A-/A+ zoom (`--chat-text`).
- DismissBtn (×) 20×20 r8, icon stroke `text/hint` #555 — **it IS in the design**
  (the "no ×" conclusion came from the stale draft 427:3102).
- Multi-quote (stacked wrappers • 01/• 02) is designed. Every row's removal
  animates: the row collapses (`.removing` → max-height/opacity 0) and eats its
  vanishing 12px flex gap via a JS-set negative margin (top, or bottom for the
  first row); the tray max-height animates to a **measured** resting height, so
  first/middle/last all collapse with no clip and no end-snap.

**Tool limitation surfaced here:** `diff-parity.mjs` checks computed *properties*,
not rendered *position/alignment*. Both the draft-vs-canonical mixup and the 2px
center-vs-top-align offset passed the property diff — caught only by overlaying
the render on Figma. When pixel-overlaying, verify alignment by geometry, and
always confirm you anchored the COMPONENT, not a draft frame of the same name.

### Legacy guard

`verify-parity.mjs` — 55/55 curated numeric assertions still pass (bubbles,
markdown, pills, input row, chat bleed/fader geometry, banner, paste tray/chips,
overlays, status) and all color tokens match `:root`. Two stale assertions fixed
2026-08-23: inline-code height heuristic (`<20`→`<30`, font drift) and the table
header color (the v2 note said `text/strong` #fafafa; the fresh walk shows
MarkdownTable headers 185:1150/1151 are `text/light-2` SemiBold — panel was
already correct).

Post-audit design deltas already implemented: input-section rework (in-flow →
out-of-flow overlay stack, gradient Chat Fader 290:9686, banner 290:8929
in-section, PastePreviewRow tray 185:1163, ImageChip 80px 176:940), host-driven
panel bg (AppSkinInfo), chat-behind-input scroll.

- Walks: zero truncation (manifest). Annotations: none. Measurements API: unsupported (spacing from autolayout — complete).
- **Adversarial review completed**: 3 independent sweeps (States Board cells / Atoms+Molecules / Template+instance) against v1 found 30+ discrepancies; all folded into v2. Root cause (hidden-layer flattening in digests) fixed in `digest.mjs`; spec files regenerated (states-board 1890→986 visible nodes).
- States Board ↔ code-state mapping complete; cell-by-cell verdicts in the review outputs.
- Live baseline captured (11 states, Chrome 99, dpr 2). Re-run after implementation; diff rects/styles per state against `spec-*.json`.
- When in doubt during implementation: `walk-*.json` is ground truth (has visibility flags, raw paints, constraints); `spec-*.json` is the convenience view; PNGs are the visual referee.
