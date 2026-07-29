---
name: gaffer
description: Field guide for driving After Effects through Gaffer's MCP tools — tool selection, ExtendScript survival rules, and animation techniques learned from real sessions. Use whenever working with After Effects via mcp__gaffer__* tools.
---

# Gaffer — After Effects agent field guide

You drive After Effects through Gaffer's MCP tools: 24 typed read/utility
tools plus `runJSX`, the universal escape hatch. Everything below is
distilled from real production sessions.

## Tool selection

Read with typed tools, write with runJSX. Typed calls are pre-debugged and
return structured JSON — never hand-write discovery JSX that a typed tool
covers:

- Project shape: `getProjectSummary` (start here), `getProjectTree`
  (folder hierarchy), `getProjectSettings` (color depth, GPU, engine)
- Comp contents: `listCompositions`, `getSelectedLayers`, `findLayers`
  (regex/effect/expression search), `whereUsed`
- Deep reads: `getLayerEffects` (full effect stack + values),
  `getShapeContents` (shape tree + masks; `includePoints` for vertices),
  `getLayerKeyframes`, `listExpressions` (+ `onlyErrors`),
  `listExpressionControls`, `listMarkers`, `listTextLayers`, `listFootage`,
  `listFonts`, `listEffectMatchNames`
- Eyes: `captureActiveComp`, `captureFrame` (any comp/time),
  `captureLayer` (auto solo + restore)
- Safe mutations: `relinkFootage`, `addToRenderQueue` (queues only —
  NEVER start a render unless explicitly asked)

## Non-negotiable safety rules

- **Never call `app.beginUndoGroup` / `app.endUndoGroup` in runJSX code.**
  Gaffer's wrapper provides the only undo group; nesting causes AE's
  "undo mismatch" dialog.
- **Patch in place; never delete-and-recreate to fix one aspect.** A failed
  runJSX that gets retried after delete+create stacks duplicate layers.
  Read current state, modify the delta.
- Read existing expressions before editing them — make minimal targeted
  changes, never overwrite wholesale unless asked.
- Never render, save, close, or delete project items unless explicitly asked.

## ExtendScript survival (ES3)

- `var` and `function` only — no let/const/arrows/templates/destructuring/
  Promises. `indexOf` + loops, not `.includes`/`.find`. `JSON.stringify`
  for returns.
- `comp.layer(n)` is 1-indexed; `selectedLayers` is 0-indexed.
- Match names over display names: `.property("ADBE Transform Group")`.
  Unknown effect? `listEffectMatchNames` first — never guess match names,
  property paths, or API ids. Probe or look up.
- Time is seconds (float). Convert frames with `comp.frameDuration`.
- After setting an expression, check `prop.expressionError`.
- After mutating, read back (or capture a frame) to confirm — don't trust
  a clean return alone.

## Keyframing and expressions

- When keyframing a property at time T on request, also drop a baseline key
  at t=0 holding the current value — otherwise nothing animates before T.
- In expressions that scale a property's own value, use the `value` keyword
  rather than hard-coding the current number, so the underlying slider or
  property stays canonical.
- "Settle without bounce" style requests usually mean critical damping
  (fast response, damping = 1), not spring overshoot.

## Shape layers

- **Contents order inside a Vector Group: Path first, then Stroke, then
  Fill.** `addProperty` appends to the END — after adding a path to a
  group that already has paint, call `moveTo(1)` on the new path.
- Effects on shape layers clip at the shape's bounding box. For glows and
  other effects that need to breathe, add an invisible bounds-expander
  rectangle to the group before applying the effect.
- Rim/neon glows: stack several copies of the SAME thin stroke with
  increasing blur — never build a glow from strokes of increasing width.
- Trim Paths: Start/End clamp to 0–100%. For rotating arcs/spinners, put
  the rotation in **Offset** and the arc length in **End**.
- Rounded corners / squircles: prefer a Roundness value in pixels plus a
  smoothing treatment over percentage-of-max-radius approaches.

## Effects and rendering quirks

- Drop Shadow opacity is 0–255 internally: multiply the intended percent
  by 2.55.
- Layer-reference inputs (displacement maps, Form layer maps, etc.) must
  sample **Effects and Masks**, not Source — Source ignores everything
  applied to the referenced layer.
- Guide layers render as invisible inside nested precomps, layer maps, and
  exports. If a precomp looks fine in its own viewer but empty where it's
  used, check for the guide-layer flag first.
- When adding to the render queue, keep AE's default output module preset
  unless the user asks otherwise.

## Working from visual references

- Before matching a reference image, pixel-sample its actual colors —
  don't eyeball. Perceived brightness in backlit/glassy references usually
  comes from saturation, not white.
- After any visual change, capture a frame and look at it. The capture
  tools are cheap; wrong-looking output that "ran fine" is not done.
