# Atom registry — DS ↔ Code (atomic-design parity map)

Figma file `tc5ASMCGihXdPgtaMxub8t`, page Gaffer. Source of truth for the
level-keyed parity model:

- **Pass 0 — tokens**: Figma variables ↔ `:root` custom props (checked once).
- **Pass 1 — atoms** (this file): each Figma component SET ↔ exactly one code
  construct. Verify the DEFAULT variant's intrinsic props + each variant as a
  delta from default. Every property an atom owns is checked HERE, once.
- **Pass 2 — composition + LAYOUT + override**: molecules/organisms get TWO
  checks, with a bounded traversal. Layout is first-class here — a molecule with
  perfect atoms can still be visually wrong because its container auto-layout
  drifted, and layout errors CASCADE down the frame chain.

  **Traversal rule (keeps Pass 2 bounded):** descend through **FRAME** nodes
  (auto-layout containers); **STOP at INSTANCE** nodes (atoms — verified in
  Pass 1). Work scales with the layout skeleton, not node count.

  **At each container FRAME:** `layoutMode`→flex-direction · `itemSpacing`→gap ·
  `counterAxisSpacing`→row-gap · `padding` per-side · `primaryAxisAlignItems`→
  justify-content · `counterAxisAlignItems`→align-items · `layoutWrap`→flex-wrap ·
  `layoutSizingHorizontal/Vertical` (FIXED/HUG/FILL)→width/height · min/max · bg.

  **At each direct CHILD of a frame** (participation layer the harness misses —
  this is the Dropdown-label class of bug): `layoutGrow`→flex-grow ·
  `layoutAlign: STRETCH`→align-self · `layoutSizing: FILL`→flex/width ·
  `layoutPositioning: ABSOLUTE`→position+x/y.

  **On INSTANCE children:** override-diff ONLY — `overrides[].overriddenFields`
  + `componentProperties` vs code delta. No re-drill. Empty overrides ⇒ auto-pass.

A property is checked at exactly ONE level: intrinsic→atom, variant-delta→atom
variant, container-layout→the frame that owns it, child-participation→that frame,
instance-override→composition. Nothing is drilled twice.

**Reproduce structure generically — never hard-code layout.** A fix is
reproducing Figma's auto-layout semantics (a Left Block with grow:1 + a Controls
slot), NOT pinning element X beside label Y or a fixed pixel position. The same
structural pattern recurs across rows (account rows, sounds row, etc.) — reuse a
shared class pair, don't invent a per-row rule. If the correct fix names a
specific element or a magic offset, it's a hack; express it as flex-grow /
structure / tokens so it holds for any label, width, or content.

Status legend: ⬜ unverified · ✅ verified default+variants · ⚠️ finding open.

## Atoms (in scope — the Gaffer panel)

| # | Atom (Figma set) | id | Variant axes | Code construct | Variant→code mapping | Status |
|---|---|---|---|---|---|---|
| A1 | Icon | 246:4094 | Icon (21: Brush…Galaxy) | `icons.js` keys | each variant = one icon key (path data) | ✅ 21/21 exact (viewBox+path); no missing keys; no Lucide |
| A2 | Button | 183:1054 | Type{Icon,Text,Prompt} × Purpose{Default,Informed,Danger,Hollow} × State{Default,Hover,Disabled} | `.icon-btn` / `.text-btn` / `.send-btn`+`.stop-btn` (Prompt) | Purpose: Default=base, `.informed`, `.danger`, `.hollow`; State: `:hover`, `:disabled` | ✅ 26/27 exact; fixed text-btn.danger:hover→text-light. Figma-side anomalies (code correct, flag to fix in Figma): Text/Danger/Disabled 452:5749 label=accent/blue (s/b red); Prompt/Danger/Disabled 193:1352 uses Hover colors |
| A3 | Toggle | 284:1298 | Selected{false,true} × Size{Small,Big} | `.toggle` | Selected→`:checked`/`.on`; Size→small default / big modifier | ✅ 4/4 variants exact (track/knob/radius/fills/travel 8·12px). +cursor:pointer on all variants (no disabled state yet) — folded into wiring impl |
| A4 | Checkbox | 183:1052 | state{checked,unchecked} | — | — | ⛔ DEPRECATED (user-confirmed) — not used in the panel anymore; DS legacy. No code counterpart expected; excluded from parity |
| A5 | Pill (tool call) | 183:1053 | state{default,done,error,running} + text | tool-pill class | state→color modifier | ✅ 3/3 states (running/done/error) parity; 2 minor informational (dead CSS tokens, orphaned Figma `default` variant) |
| A6 | Dropdown | 195:1373 | state{closed,open,hover} | `.select-btn` (closed) + `.select-popup` (open) | closed=base, open=`.select-popup` shown, hover=`:hover` | ⚠️→✅ closed default FIXED (label fill+left, 54d2304); open/hover variants still ⬜; label token text-dimmer≈text-muted both #888 (minor) |
| A7 | InputField | 183:1068 | state{default,disabled,focused} | `.chat-input` / textarea | state→`:disabled`/`:focus` | ✅ 15 exact; FIXED typed-text color →text-light-2 #CCC |
| A10 | LED (conn status) | 183:1050 | state{red,amber,green} | conn LED | state→color | ✅ 3/3 states parity |
| A11 | StatusDot (MCP) | 183:1051 | status{auth,connected,failed} | — | — | ⛔ DEPRECATED (user-confirmed) — not used in the panel anymore; DS legacy. `.mcp-tile` recolor is the live approach; blue "connected" stands. Excluded from parity |
| A13 | CodeInline | 185:1156 | — | `.code-inline` (+ `.beta-badge` reuse) | — | ✅ full parity incl. correct beta-badge partial reuse |
| A8 | Toast | 464:10032 | Type{Info,Success,Warning,Error,Neutral} + label + trailing icon | `.toast` | Type→`.info/.success/.warning/.error/.neutral` | ✅ 5/5 types exact (composited tints, shadow stack, label, trailing-icon color) |
| A9 | Bubble | 183:1055 | role{user,assistant,error} × hasImages × withCopy | `.chat-msg` | role→`.user/.assistant/.error`; hasImages/withCopy→structural | ✅ 27 exact (bg/border/radius/pad/width/text/copy/image, all roles+deltas). Deferred hygiene (non-parity): stale margin comment on .chat-msg.assistant; misnamed --color-bubble-assistant-border (toast-repurposed) |
| A10 | LED (conn status) | 183:1050 | state{red,amber,green} | status LED (TBD grep) | state→color | ⬜ |
| A11 | StatusDot (MCP) | 183:1051 | status{auth,connected,failed} | mcp status dot (TBD grep) | status→color | ⬜ |
| A12 | ImageChip | 176:940 | Show Close (bool) | `.account-avatar` + paste chip | image fill override; Show Close→× btn | ✅ (avatars re-verified this session; paste chip earlier) |
| A13 | CodeInline | 185:1156 | — | `.code-inline` (also reused by `.beta-badge`) | — | ✅ verified (see A13 row above) |
| A14 | EffortSlider (ModelSelect) | 484:30131 | value (dot count = model's efforts) | `.effort-slider` (`.e-dot`/`.e-circ` + overlay `.e-fill`/`.e-thumb`/`.e-knob`) | value→thumb px + on-dots | ✅ CLEAN atomic pass — every atom exact: track `#000000@.5` r8 h28, off-circle `#666666` 4×4 r999, on-circle/knob `#4D9DF7`, fill `#4A7DC9@.2` r8, thumb 18/knob 16×24 r6. Structural divergence (intentional, generic-repro): Figma flows the handle as a flex slot between dots (dots reflow); code keeps 5 evenly-spaced dots + an ABSOLUTE thumb overlay so the drag can free-follow + ease-to-dot (flex-insert teleports/can't animate). data-fig anchors on e-fill/e-thumb/e-knob will read a width delta in diff-parity (Figma's 224px clipped-rect fill technique ≠ code's growing-width fill) — known, accepted per the atom-registry generic-repro principle. |

## Molecules / organisms (Pass 2 — override-diff only, no drill)

| Node | id | Kind | Composed of atoms | Notes |
|---|---|---|---|---|
| InputRow | 195:1429 | molecule | InputField + Button(send/stop) | mode{idle,busy,typed} |
| ActivitySettingsRow | 185:1193 | molecule | Dropdown + Toggle + Button | kind{model,mcps,update} |
| ActivityLog | 191:1343 | organism | ActivitySettingsRow×n | expanded{false,true} |
| Menu item | 478:12980 | molecule | per-Section mix | Section{Update,Scrooge,Sounds,Account CLI,Account API,Models} + Hovered |
| SelectedTextActions | 507:40583 | molecule | Button(hollow)×2 | the CTA pill; container glue verified this session |
| Toast stack | 480:23820 | organism | Toast×n | — |
| Bubble variants | 195:1388/1380 | molecule | Bubble + ImageChip/CopyBtn | override: hasImages/withCopy |
| PastePreviewRow | 185:1163 | molecule | ImageChip×n | — |
| UpdateBanner | 191:1271 | molecule | Button + Text | — |
| Reply Quote | 428:3200 | molecule | Button + Text + wave | — |
| DropOverlay | 191:1275 | organism | — | — |
| ImgLightbox | 191:1276 | organism | — | — |
| SettingsFullScreen | 447:4826 | organism | Settings Header + Menu items | 360×600 screen |
| Panel | 210:1480 | template | everything | assembled mock |

## Canonical settings-row structure — Stubs/Menu item `475:10304`

The SINGLE source-of-truth component every settings block instantiates (except
the model-picker row). All settings rows must reproduce THIS skeleton — not
per-section bespoke markup:

```
Menu item (VERTICAL, pad 12, gap 12, HUG height)
├─ Row (HORIZONTAL, gap 16, FILL)
│  ├─ Left Block (grow:1, gap 8)
│  │  ├─ ImageChip? (58×58 — account avatar)
│  │  └─ Text (grow:1, VERTICAL)
│  │     ├─ Line 1 (HORIZONTAL, gap 8): Main Label + Badge? + Sound Selector?
│  │     ├─ Secondary (HORIZONTAL, gap 2): Pt1 · Pt2 · Pt3 (bullet-separated)
│  │     └─ Multiline? (TEXT, FILL — e.g. Scrooge description)
│  └─ Controls (hug, gap 4): Toggle? / Button1? / Button2?
└─ Row 2? (HORIZONTAL, gap 8): Button + version(grow:1, FILL) + Controls(Toggle/Buttons)
```

Per section, the component-property booleans on 475:10304 toggle which parts
show (Image Chip / Badge / Toggle / Buttons / Sound Selector / Multiline / Row 2)
and the text props fill labels. Key placements the flat code got wrong:
the **Sound Selector sits in Line 1 of the Left Block** (beside the label), the
**Toggle sits in the Controls slot** (right). Code should have ONE reusable
Left-Block(grow:1) + Controls(hug) row structure. Model picker = exception.

## Models section — its OWN grid `484:27797` (the row-skeleton EXCEPTION)

Section=Models does NOT use the Left-Block/Controls row skeleton. It's a Figma
`layoutMode: GRID` (→ CSS `display: grid`): Rows frame (pad 12, gap 8) holds two
GRID rows whose COLUMNS ALIGN:

```
Row A (484:34406, GRID, gap 8, FILL): [Text col: "Models" label] | [Models drops (grow:1): 2 Dropdowns, each grow:1/FILL, gap 4]
Row B (484:31247, GRID, gap 8, FILL): [Text col: "Effort" Pt.1 + value] | [effort slider ModelSelect 484:30131 (grow:1)]
```

The label column aligns with the label column; the control column (dropdowns)
aligns with the control column (effort slider). Reproduce as a real 2-column CSS
grid (label col + control col, gap 8) shared across the two rows — NOT flex. The
two model dropdowns split the control column evenly (each grow:1). Follow this
grid; do not force Models into the 475:10304 skeleton.

## Out of scope — AE motion/curve-editor surface (NOT the panel)

Set 3:34, Curve Preset Slot 3:143, Set Name 3:119, Handle Circle 3:187,
Handle Line 3:186, Handle 3:198, Curve Preset 3:445, type=Start/End 3:196/3:215,
Curve=01/02 3:444/3:443. These belong to the motion tool; excluded from panel
parity (motion vs panel separation).

## Pass-1 order
Start A6 Dropdown (flagged label-placement defect), then A2 Button (most-reused),
A3 Toggle, A8 Toast, A9 Bubble, A7 InputField, A1 Icon, A5 Pill, A10 LED,
A11 StatusDot. A12 ImageChip / A13 CodeInline already largely covered.
