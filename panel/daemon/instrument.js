/**
 * Loop guard: static pre-flight + source instrumentation for agent-authored
 * ExtendScript, so a fat/unbounded loop can no longer freeze After Effects.
 *
 * WHY: ExtendScript runs synchronously on AE's single UI thread and cannot be
 * interrupted from the daemon (the 60s bridge timeout only rejects the daemon
 * promise; AE keeps churning). There is no AE-side yield/interrupt/Esc for an
 * arbitrary script. The only thread-free defense is cooperative and injected
 * into the code BEFORE it runs (the loop-protect technique, adapted for ES3).
 *
 * WHAT preflight() does:
 *   1. Parse the source with acorn (ecmaVersion 3, then 5; allowReserved).
 *   2. Reject a provably-infinite loop up front, with an actionable message.
 *   3. Otherwise splice `__gafferTick();` into every loop body and function
 *      body, and a re-throw guard into every catch clause. The tick (defined by
 *      the safety wrapper) accumulates $.hiresTimer and throws a tagged object
 *      once a single synchronous burst passes a freeze ceiling, which the
 *      wrapper turns into a clean, resumable stop instead of a frozen app.
 *
 * The transform is surgical: acorn gives byte offsets, and we only INSERT at
 * those offsets (never re-emit the whole source), so nothing but the guard
 * calls change. Parsing is ~sub-ms for a few-KB script (parse-once at
 * admission, not per slice), well under the AE round-trip it rides on.
 *
 * The injected code is ES3 (var/function; no Date.now, no arrow/const/let).
 *
 * Escape hatch: set env GAFFER_DISABLE_LOOPGUARD to make preflight a pass-through
 * (no parse, no instrumentation, no rejection).
 */
import { Parser } from 'acorn';

export var guardEnabled = !process.env.GAFFER_DISABLE_LOOPGUARD;

var LOOP_TYPES = {
  ForStatement: true,
  WhileStatement: true,
  DoWhileStatement: true,
  ForInStatement: true,
  ForOfStatement: true, // ES6; won't appear under ecmaVersion 3/5 but harmless to cover
};
var FN_TYPES = { FunctionDeclaration: true, FunctionExpression: true };

var TICK = ' __gafferTick(); ';

// Agent-facing messages. No em-dashes in user-facing copy (project rule).
var MSG_INFINITE =
  'This script contains a loop that never ends (for example while(true) with no break or return). ' +
  'It was blocked because it would freeze After Effects. Add an exit condition, or use runJSXLoop ' +
  'to do the work in small resumable steps.';
var MSG_UNPARSEABLE_LOOP =
  'Could not analyze this script for safety and it contains a loop that may freeze After Effects. ' +
  'Simplify it to plain ES3, or use runJSXLoop for iterative work.';

// Parse `source` as a Program (raw runJSX code) or, when asExpression, as a
// single parenthesized expression (a `function (cursor){...}` step body, which
// is illegal at statement position). Returns { ast, prefix } or null on failure.
// `prefix` is how many chars were prepended, so offsets map back to `source`.
function tryParse(source, asExpression) {
  var text = asExpression ? '(' + source + ')' : source;
  var prefix = asExpression ? 1 : 0;
  var versions = [3, 5];
  for (var i = 0; i < versions.length; i++) {
    try {
      var ast = Parser.parse(text, { ecmaVersion: versions[i], allowReserved: true });
      return { ast: ast, prefix: prefix };
    } catch (e) {
      /* try next version */
    }
  }
  return null;
}

// Depth-tracking walk: visit(node, loopDepth) for every node; loopDepth is the
// number of loop ancestors (so a loop node's own depth is loopDepth+1).
function walk(node, visit, depth) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, depth);
  var childDepth = depth + (LOOP_TYPES[node.type] ? 1 : 0);
  for (var key in node) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    var child = node[key];
    if (child && typeof child.type === 'string') {
      walk(child, visit, childDepth);
    } else if (child && typeof child.length === 'number') {
      for (var i = 0; i < child.length; i++) {
        if (child[i] && typeof child[i].type === 'string') walk(child[i], visit, childDepth);
      }
    }
  }
}

function isTruthyLiteral(test) {
  return !!(test && test.type === 'Literal' && test.value);
}

// A loop is treated as provably-infinite only when its condition is a truthy
// literal (or absent, for `for(;;)`) AND its body has no break/return/throw
// anywhere. Conservative on purpose: it never false-flags a loop that has any
// exit token (L2 instrumentation catches the ones this misses).
function isProvablyInfinite(loop) {
  var alwaysTrue =
    (loop.type === 'ForStatement' && loop.test == null) ||
    isTruthyLiteral(loop.test);
  if (!alwaysTrue) return false;
  var hasExit = false;
  walk(loop.body, function (n) {
    if (n.type === 'BreakStatement' || n.type === 'ReturnStatement' || n.type === 'ThrowStatement') {
      hasExit = true;
    }
  }, 0);
  return !hasExit;
}

// Insert edits (each { pos, text } in parsed-text coords) into `source`,
// applied high offset first so earlier positions stay valid.
function applyEdits(source, edits, prefix) {
  edits.sort(function (a, b) { return b.pos - a.pos; });
  var out = source;
  for (var i = 0; i < edits.length; i++) {
    var p = edits[i].pos - prefix;
    if (p < 0) p = 0;
    if (p > out.length) p = out.length;
    out = out.slice(0, p) + edits[i].text + out.slice(p);
  }
  return out;
}

// Collect the guard-injection edits for one loop/function/catch body.
function bodyEdits(node, bodyKey, headText, edits) {
  var body = node[bodyKey];
  if (!body) return;
  if (body.type === 'BlockStatement') {
    // Insert right after the opening brace.
    edits.push({ pos: body.start + 1, text: headText });
  } else {
    // Single-statement (or empty) body: wrap it in a block so the guard runs.
    edits.push({ pos: body.start, text: '{' + headText });
    edits.push({ pos: body.end, text: ' }' });
  }
}

/**
 * Pre-flight one piece of agent JSX.
 *
 * @param {string} source  raw runJSX code, or a runJSXLoop step function body
 * @param {object} opts     { asExpression?: boolean }
 * @returns {{ action:'run'|'reject', code?:string, message?:string, telemetry:object }}
 */
export function preflight(source, opts) {
  opts = opts || {};
  var src = String(source == null ? '' : source);

  if (!guardEnabled) {
    return { action: 'run', code: src, telemetry: { guarded: false } };
  }

  var parsed = tryParse(src, !!opts.asExpression);
  if (!parsed) {
    var looksLikeLoop = /\b(for|while|do)\b/.test(src);
    if (looksLikeLoop) {
      return { action: 'reject', message: MSG_UNPARSEABLE_LOOP, telemetry: { parseError: true, hasLoop: true } };
    }
    // No loop keyword: safe to run un-instrumented (this class can't freeze).
    return { action: 'run', code: src, telemetry: { parseError: true, hasLoop: false } };
  }

  var loopCount = 0;
  var maxDepth = 0;
  var infinite = false;
  var edits = [];

  walk(parsed.ast, function (node, depth) {
    if (LOOP_TYPES[node.type]) {
      loopCount++;
      if (depth + 1 > maxDepth) maxDepth = depth + 1;
      if (!infinite && isProvablyInfinite(node)) infinite = true;
      bodyEdits(node, 'body', TICK, edits);
    } else if (FN_TYPES[node.type]) {
      // Function entry tick catches recursion and long call chains.
      bodyEdits(node, 'body', TICK, edits);
    } else if (node.type === 'CatchClause' && node.param && node.param.name) {
      // Re-throw the budget signal so a user try/catch can't swallow the abort.
      var p = node.param.name;
      var guard = ' if (' + p + ' && ' + p + '.__gafferBudget) throw ' + p + '; ';
      bodyEdits(node, 'body', guard, edits);
    }
  }, 0);

  var telemetry = { guarded: true, hasLoop: loopCount > 0, loopCount: loopCount, maxDepth: maxDepth };

  if (infinite) {
    telemetry.infinite = true;
    return { action: 'reject', message: MSG_INFINITE, telemetry: telemetry };
  }

  var code = edits.length ? applyEdits(src, edits, parsed.prefix) : src;
  telemetry.instrumented = edits.length > 0;
  return { action: 'run', code: code, telemetry: telemetry };
}
