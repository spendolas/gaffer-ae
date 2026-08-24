// Conservative "lighten a trivial turn" heuristic for the optional autoModel
// toggle. On a clearly-trivial turn it drops model → haiku, effort → low, and
// (via the caller) context → standard. It never upshifts, and never overrides
// an explicit pinned version id (claude-*) — a deliberate exact choice. A bad
// downshift makes the user redo work (costing more), so the trivial test is
// narrow. The `downshifted` flag tells the caller whether anything changed
// (so it can drop the [1m] suffix and log only real downshifts).
var HEAVY = /\b(build|create|animate|add|make|expression|keyframe|rig|wiggle|precomp|composition|import|render|effect|shape|mask|morph|transition|loop|stagger|parent|null|track|stabilize|export)\b/i;

export function chooseModel(message, requested) {
  requested = requested || {};
  var model = requested.model || 'opus';
  var effort = requested.effort;

  // Leave an explicit pinned version id exactly as requested (respect the pin).
  if (model.indexOf('claude-') === 0) return { model: model, effort: effort, downshifted: false };

  var text = String(message || '').trim();
  var trivial = text.length > 0 && text.length <= 200 && !HEAVY.test(text) && !/```|mcp__/.test(text);
  if (!trivial) return { model: model, effort: effort, downshifted: false };

  // Trivial turn: lighten model + effort together (context is dropped by the
  // caller). `downshifted` is false only if we were already at the floor, so
  // an already-light turn is a genuine no-op (no log, no [1m] drop needed).
  var changed = model !== 'haiku' || effort !== 'low';
  return { model: 'haiku', effort: 'low', downshifted: changed };
}
