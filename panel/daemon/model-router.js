// Two-stage "lighten a turn" classifier for the optional autoModel toggle.
//
// Stage 1 (scoreMessage) is a free, local feature score that confidently calls
// the extremes — 'trivial' or 'complex' — and returns 'unsure' for the middle.
// Stage 2 (classifyTurn) only fires on 'unsure': one cheap haiku call with no
// MCP and no system prompt, returning trivial|moderate|complex. So the extra
// call happens on a minority of turns, never on the confident ones.
//
// tierToSelection maps a tier onto (model, effort, context), and it NEVER
// upshifts past the user's pick and never touches a pinned version id or any
// model off the reasoning ladder. A bad downshift makes the user redo work
// (costing more), so stage 1 only downshifts when confident and stage 2's
// failure fallback is 'complex' (no downshift).

// Authoring/action VERBS → this turn is doing real work. Verbs only: domain
// NOUNS (comp, opacity, easing, layer…) appear in plain inspection questions,
// so they must not force 'complex'. Ambiguous verbs (scale/rotate/trim) are
// kept because a false 'complex' is the safe error (just no downshift); a
// false 'trivial' is the dangerous one.
var MUTATE = /\b(build|create|animate|add|make|set|change|move|rig|keyframe|precomp|import|render|morph|stagger|parent|track|stabilize|export|duplicate|delete|remove|trim|offset|apply|scale|rotate|enable|disable|toggle|replace|convert|wiggle|nudge|snap|align|distribute|reveal)\b/i;
// Expression syntax in the message → an authoring spec.
var EXPR = /(wiggle|thiscomp|thislayer|valueattime|loopout|loopin|seedrandom|linear|ease)\s*\(|\.\s*property\s*\(/i;
// Numbers with units → a concrete spec, not chit-chat.
var UNITS = /\b\d+(\.\d+)?\s*(px|pt|%|deg|degrees?|frames?|fps|s|sec|seconds?|ms|x)\b/i;
// Greetings / acknowledgements, and explicit meta (recap/status/undo). Only
// these count as trivial — a bare question word (is/how/why/which) can open a
// real inspection task, so those fall to 'unsure' for the classifier to judge.
var GREETING = /^(hi|hey|hello|yo|sup|thanks|thank you|ty|cheers|ok|okay|k|got it|nice|cool|great|perfect|awesome|nvm|never ?mind)\b/i;
var META = /\b(what did you (do|change|say)|what have you done|recap|status|undo|redo)\b/i;
// Interrogative / lookup openers → a reading-and-answering turn (with no
// authoring verb, checked first). These are the bulk of what used to fall to
// 'unsure'; a lookup/explanation is sonnet-sized, so score it 'moderate'
// locally and skip the classifier. A false 'moderate' only costs opus→sonnet
// (mild), never the dangerous opus→haiku.
var QUESTION = /^(what|how|why|which|where|when|who|whose|is|are|was|were|do|does|did|can|could|should|would|will|list|show|tell|explain|describe|find|check|count|any|has|have|look|closer)\b/i;
// A very short statement is a light aside/lookup, not multi-step authoring.
var SHORT_WORDS = 12;

// Stage 1: free local score. 'trivial' | 'moderate' | 'complex' | 'unsure'.
export function scoreMessage(message) {
  var raw = String(message || '');
  var text = raw.trim();
  if (!text) return 'trivial';
  // Hard COMPLEX — authoring, visual, or spec signals.
  if (/\[image:/i.test(raw)) return 'complex';   // an attached frame/reference
  if (/```|mcp__/.test(raw)) return 'complex';    // code fence or tool payload
  if (EXPR.test(raw)) return 'complex';           // expression syntax
  if (MUTATE.test(raw)) return 'complex';         // authoring/action verb
  var words = text.split(/\s+/).length;
  if (words > 40) return 'complex';               // long, multi-step
  // Hard TRIVIAL — short greeting/ack or meta, no numeric spec.
  if (text.length <= 80 && !UNITS.test(text) && (GREETING.test(text) || META.test(text))) return 'trivial';
  // Confident MODERATE — a question or short lookup with no authoring verb:
  // reading/answering work, routes to sonnet without a classifier spawn.
  if (text.indexOf('?') >= 0 || QUESTION.test(text)) return 'moderate';
  if (words <= SHORT_WORDS) return 'moderate';    // short aside/lookup
  // Genuinely ambiguous — a mid-length, verbless, question-less statement.
  return 'unsure';
}

var CLASSIFY_PROMPT = 'You are triaging a request sent to an After Effects automation assistant. '
  + 'Judge how much reasoning it needs and reply with ONE word only: trivial, moderate, or complex.\n'
  + 'trivial = a greeting, acknowledgement, or simple status/recap question.\n'
  + 'moderate = a small lookup, a short explanation, or a single simple edit.\n'
  + 'complex = building or animating, expressions, multi-step work, or anything visual.\n\nRequest:\n';

// Stage 2: cheap haiku classification, only for the 'unsure' middle. `run` is
// injected (chat-handler supplies a haiku spawn; tests supply a fake) so this
// module never spawns directly. Any failure → 'complex' (safe: no downshift).
export async function classifyTurn(message, opts) {
  opts = opts || {};
  var run = opts.run;
  if (typeof run !== 'function') return 'complex';
  try {
    var out = await run(CLASSIFY_PROMPT + String(message || '').slice(0, 2000));
    var m = String(out || '').toLowerCase().match(/\b(trivial|moderate|complex)\b/);
    return m ? m[1] : 'complex';
  } catch (e) {
    return 'complex';
  }
}

// score → (classify if unsure) → final tier.
export async function resolveTier(message, opts) {
  var s = scoreMessage(message);
  if (s !== 'unsure') return s;
  return await classifyTurn(message, opts);
}

var MODEL_RANK = { haiku: 0, sonnet: 1, opus: 2 };
var EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
var RANK_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

// Map a tier onto a concrete selection given what the user picked. Never
// upshifts past the user's model/effort; leaves pinned ids and off-ladder
// models (e.g. fable, claude-*) untouched. Only a 'trivial' turn sheds 1M.
export function tierToSelection(tier, requested) {
  requested = requested || {};
  var reqModel = requested.model || 'opus';
  var reqEffort = requested.effort;
  var variant = requested.variant;

  if (!(reqModel in MODEL_RANK)) {
    return { model: reqModel, effort: reqEffort, dropContext: false, downshifted: false };
  }

  var tierModel = tier === 'trivial' ? 'haiku' : tier === 'moderate' ? 'sonnet' : reqModel;
  // never upshift — cap the target at the user's pick
  var model = MODEL_RANK[tierModel] <= MODEL_RANK[reqModel] ? tierModel : reqModel;

  var effort;
  if (tier === 'complex') {
    effort = reqEffort; // leave the user's effort alone
  } else {
    var tRank = tier === 'trivial' ? 0 : 1; // low or medium
    var rRank = (reqEffort in EFFORT_RANK) ? EFFORT_RANK[reqEffort] : null;
    effort = (rRank === null) ? RANK_EFFORT[tRank] : RANK_EFFORT[Math.min(tRank, rRank)];
  }

  var dropContext = tier === 'trivial'; // only a trivial turn drops the 1M suffix
  var downshifted = model !== reqModel || effort !== reqEffort || (dropContext && variant === '1m');
  return { model: model, effort: effort, dropContext: dropContext, downshifted: downshifted };
}
