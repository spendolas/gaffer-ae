// Conservative model downshift for the optional autoModel toggle. Only ever
// picks a CHEAPER model on clearly-trivial turns; never upshifts, never
// overrides a pinned version id or a [1m] context variant. A bad downshift
// makes the user redo work (costing more), so the trivial test is narrow.
var HEAVY = /\b(build|create|animate|add|make|expression|keyframe|rig|wiggle|precomp|composition|import|render|effect|shape|mask|morph|transition|loop|stagger|parent|null|track|stabilize|export)\b/i;

export function chooseModel(message, requested) {
  requested = requested || {};
  var model = requested.model || 'opus';
  var effort = requested.effort;

  // Leave pinned ids and 1M-context variants exactly as requested.
  if (model.indexOf('claude-') === 0 || /\[1m\]/.test(model)) return { model: model, effort: effort };

  var text = String(message || '').trim();
  var trivial = text.length > 0 && text.length <= 200 && !HEAVY.test(text) && !/```|mcp__/.test(text);

  if (trivial && model !== 'haiku') {
    return { model: 'haiku', effort: effort };
  }
  return { model: model, effort: effort };
}
