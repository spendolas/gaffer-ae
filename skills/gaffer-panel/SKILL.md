---
name: gaffer-panel
description: >-
  Field guide for CODING THE GAFFER PANEL itself — the CEP extension front-end
  (index.html, its single <style>, tokens, main.js) and the daemon. Use when
  building or porting a UI component from the Figma design system, editing panel
  CSS or design tokens, running the Figma↔panel parity check, building a
  preview/demo harness, or working around CEP/Chromium quirks. This is panel
  software engineering — NOT the After Effects motion work the `gaffer` skill
  covers. Keep the two separate; never merge them.
---

# Gaffer Panel — CEP front-end field guide

For coding the panel and daemon, not for driving After Effects (that's the
`gaffer` motion skill — keep them separate).

**Stack:** the panel is one `panel/index.html` with a single `<style>` block;
design tokens are CSS custom properties (`--color-*`, `--radius-*`,
`--space-*`). No React, no Tailwind, no build step for the UI. Runtime is CEP
**Chromium ~99**. The Figma design system is read/written through the **grip**
MCP; a node-level parity pipeline diffs Figma against the coded panel.

## Design tokens & Figma sync

- **grip's file binding drops between messages.** Call `set_active_file` FIRST
  in every grip message, batched with the reads/writes that follow it.
- Tokens flow Figma → `design/tokens.json` (via the digest step) → the
  `:root` CSS vars in `index.html`. Keep the three in sync; never eyeball —
  run the parity diff.
- **Figma layers can have multiple fills.** Read all of `fills[]`, not
  `fills[0]` — a rest overlay is often a second fill layered over a base.
- **Derived tokens:** Figma can't alias a variable *with* an opacity applied,
  so a token like `btn-primary-ghost` (#4A7DC9 @0.2) is stored as a concrete
  hex@opacity value. When you add a derived token in code, create the matching
  Figma variable too, and rebind the hard-coded fills that used the raw value.
- **No composite colors.** Don't bake `#292929` for "border@.4 over panel" —
  layer it: `linear-gradient(var(--overlay), var(--overlay)), var(--base)`, so
  the transparency stays real and survives a token change.
- Watch out for a `replace_all` on an rgba value also rewriting the token
  *definition* into a self-reference (`--x: var(--x)`) — it resolves to
  nothing and the fill renders invisible.

## Building a component from Figma

- **Figma "states" are not variants to bake.** Hover/focus/pressed/disabled
  are live browser states — drive them in CSS (`:hover:not(:disabled)`,
  `:focus-visible`, `:disabled { opacity: .4 }`), never as a static class
  snapshot of a Figma state layer. A disabled control must not respond to
  hover — guard EVERY hover rule with `:not(:disabled)`.
- **Pick the element by behavior, not by looks:**
  - *Toggle* → visually-hidden native `<input type="checkbox">` (add
    `role="switch"` for on/off semantics) + a sibling visual span driven by
    `input:checked ~ .visual`, `input:disabled ~ .visual`,
    `input:focus-visible ~ .visual`. Space toggles for free.
  - *Action* → `<button>` if it does something, `<a href>` if it goes
    somewhere — never swapped. Icon-only button MUST carry an `aria-label`.
    Loading = `aria-busy` + content `opacity:0` (keep the box size), not
    `display:none`.
  - *Disclosure* → trigger gets `aria-expanded` + `aria-controls`; panel
    `role="region"` + `aria-labelledby`.
  - *Overlay / Toast* → live region: `role="alert"` (urgent) / `role="status"`
    (confirmation). Auto-dismiss ≥5s, pause the countdown on hover/focus and
    resume on leave/blur (WCAG 2.2.1), always a visible dismiss button. Modal
    `<dialog>.showModal()` traps focus natively — store
    `document.activeElement` before open, refocus it on close, and lock body
    scroll (`overflow:hidden`) while open.
- **Repeated icon buttons need contextual labels.** Three "Dismiss" buttons
  are indistinguishable to a screen reader — use
  `aria-label="Dismiss: {title}"`.
- **Timed dismiss:** don't rebuild the `setTimeout` on every state change or
  the countdown restarts and never fires — key the timer off stable state.
- **Every visual value comes from a token.** If a Figma value has no token,
  add the token AND its Figma variable — never inline a raw hex/px in a
  component rule. Distinct from a valid-but-primitive token: reach for the
  semantic token, not the palette color.
- **Transition specific properties** (`transition: background .15s, color .15s`),
  never `transition: all` — it animates layout and thrashes.
- Component owns no external layout (margin/width) — the parent places it.

## Preview / demo harness

When building a states page to verify a component against Figma:

- **Scope the real styles, isolate the chrome.** Inject the panel's ACTUAL
  `<style>` so cells render true production CSS — never mock values (a faked
  preview is a lie and will be caught). Apply DS tokens only inside the
  preview stage; give the harness chrome its own neutral styling (dark
  `#0d0d0d`/`#111`, system font) with prefixed classes so it can't collide
  with panel rules. Add a reset
  (`html,body{height:auto!important;overflow:visible!important;display:block!important}`)
  because the panel's `<style>` sets a flex / overflow-hidden body that
  collapses a standalone page.
- **Lay states out as a grid**: variants down rows, Default·Hover·Disabled
  across columns — exactly the Figma states layout, nothing extra.
- **Prefer real interaction over faked classes.** Ship the page so disabled
  buttons can actually be hovered (proving `:not(:disabled)` holds) and
  toggles actually flip (CSS-only `:checked`, so it works even in a static
  CSP snapshot — no JS needed). Toggle-style controls: a `<button>` with an
  `::after` thumb; put `pointer-events:none` on `::after` so it can't
  intercept the click.
- **Harness controls worth having** (CSS-only where possible): background
  switch (panel-bg ↔ light, to verify ghost/transparent fills composite on
  both grounds), force-disabled, show-focus-rings, responsive-width presets
  (320/768/1024/full), RTL, long-text overflow. A side-by-side static Figma
  reference image beside the live render is the strongest check — grip exports
  one frame, so pair it with the coded version.
- **Optional specs table** per variant: three columns — CSS class / token
  (`--var`) / resolved value — to make token→value drift obvious.
- **Always screenshot the rendered harness before claiming it works.** Files
  inside the project folder navigate + screenshot in the Browser pane;
  external/scratchpad files render as static snapshots (CSS/`:checked` still
  work, JS is CSP-blocked).

## Reviewing a component (QA)

Audit across five dimensions, then rank findings Critical → Warning →
Suggestion:

1. **Structure/props** — correct native element for the archetype?
2. **Styles & tokens** — every value from a token? no hard-coded hex/px?
3. **Interaction states** — CSS state selectors, not baked variants? disabled
   guarded?
4. **Accessibility** — native semantics, keyboard, aria-label on icon-only,
   live regions on toasts?
5. **Architecture** — no external-layout opinions? no composite colors?

If a finding applies to ALL components (not just one), it's **systemic** —
promote it into this skill rather than fixing only the instance.

## CEP / Chromium quirks

- **Chromium ~99**: no `color-mix()`, no relative-color syntax — layer
  translucent fills with stacked `linear-gradient` instead.
- **`grid-template-rows: 0fr → 1fr` does NOT interpolate** (needs Chrome 107+).
  For expand/collapse, animate `max-height` (or opacity/transform). Never
  animate `height:auto`.
- **`require()` is unavailable** in panel context despite `--enable-nodejs`;
  use `system.callSystem()` for OS operations.
- Keyboard shortcuts (Delete, Cmd+C/V/X/Z) must be registered via
  `cs.registerKeyEventsInterest()`.
- **Panel reload only reloads the UI.** Daemon-side code needs a daemon
  restart (long-lived node process) — check daemon start-time before assuming
  a code bug.
- PowerShell `.ps1` files must be ASCII-only with a UTF-8 BOM; Node child
  processes on Windows need `windowsHide: true`.
