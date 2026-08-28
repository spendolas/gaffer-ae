# Atom registry — DS ↔ Code (atomic-design parity map)

Figma file `tc5ASMCGihXdPgtaMxub8t`, page Gaffer. Source of truth for the
level-keyed parity model:

- **Pass 0 — tokens**: Figma variables ↔ `:root` custom props (checked once).
- **Pass 1 — atoms** (this file): each Figma component SET ↔ exactly one code
  construct. Verify the DEFAULT variant's intrinsic props + each variant as a
  delta from default. Every property an atom owns is checked HERE, once.
- **Pass 2 — composition/override**: molecules/organisms are NOT drilled. For
  each instance, diff only Figma's `overrides[].overriddenFields` +
  `componentProperties` against the code's applied delta; verify the container
  frame's own glue (padding/gap/justify/bg). Empty overrides ⇒ auto-pass.

A property is checked at exactly ONE level: intrinsic→atom, variant-delta→atom
variant, glue+override→composition. Nothing is drilled twice.

Status legend: ⬜ unverified · ✅ verified default+variants · ⚠️ finding open.

## Atoms (in scope — the Gaffer panel)

| # | Atom (Figma set) | id | Variant axes | Code construct | Variant→code mapping | Status |
|---|---|---|---|---|---|---|
| A1 | Icon | 246:4094 | Icon (21: Brush…Galaxy) | `icons.js` keys | each variant = one icon key (path data) | ⬜ |
| A2 | Button | 183:1054 | Type{Icon,Text,Prompt} × Purpose{Default,Informed,Danger,Hollow} × State{Default,Hover,Disabled} | `.icon-btn` / `.text-btn` / `.send-btn`+`.stop-btn` (Prompt) | Purpose: Default=base, `.informed`, `.danger`, `.hollow`; State: `:hover`, `:disabled` | ⬜ |
| A3 | Toggle | 284:1298 | Selected{false,true} × Size{Small,Big} | `.toggle` | Selected→`:checked`/`.on`; Size→small default / big modifier | ⬜ |
| A4 | Checkbox | 183:1052 | state{checked,unchecked} | native `<input type=checkbox>` (MCP rows) | state→`:checked` | ⬜ |
| A5 | Pill (tool call) | 183:1053 | state{default,done,error,running} + text | tool-pill class (TBD: grep busy-pills) | state→color modifier | ⬜ |
| A6 | Dropdown | 195:1373 | state{closed,open,hover} | `.select-btn` (closed) + `.select-popup` (open) | closed=base, open=`.select-popup` shown, hover=`:hover` | ⬜ **FLAGGED: label placement** |
| A7 | InputField | 183:1068 | state{default,disabled,focused} | `.chat-input` / textarea | state→`:disabled`/`:focus` | ⬜ |
| A8 | Toast | 464:10032 | Type{Info,Success,Warning,Error,Neutral} + label + trailing icon | `.toast` | Type→`.info/.success/.warning/.error/.neutral` | ⬜ |
| A9 | Bubble | 183:1055 | role{user,assistant,error} × hasImages × withCopy | `.chat-msg` | role→`.user/.assistant/.error`; hasImages/withCopy→structural | ⬜ |
| A10 | LED (conn status) | 183:1050 | state{red,amber,green} | status LED (TBD grep) | state→color | ⬜ |
| A11 | StatusDot (MCP) | 183:1051 | status{auth,connected,failed} | mcp status dot (TBD grep) | status→color | ⬜ |
| A12 | ImageChip | 176:940 | Show Close (bool) | `.account-avatar` + paste chip | image fill override; Show Close→× btn | ✅ (avatars re-verified this session; paste chip earlier) |
| A13 | CodeInline | 185:1156 | — | `.code-inline` (also reused by `.beta-badge`) | — | ⚠️ beta-badge reuse fixed this session; verify base |

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

## Out of scope — AE motion/curve-editor surface (NOT the panel)

Set 3:34, Curve Preset Slot 3:143, Set Name 3:119, Handle Circle 3:187,
Handle Line 3:186, Handle 3:198, Curve Preset 3:445, type=Start/End 3:196/3:215,
Curve=01/02 3:444/3:443. These belong to the motion tool; excluded from panel
parity (motion vs panel separation).

## Pass-1 order
Start A6 Dropdown (flagged label-placement defect), then A2 Button (most-reused),
A3 Toggle, A8 Toast, A9 Bubble, A7 InputField, A1 Icon, A5 Pill, A10 LED,
A11 StatusDot. A12 ImageChip / A13 CodeInline already largely covered.
