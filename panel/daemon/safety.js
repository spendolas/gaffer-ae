/**
 * Wraps user ExtendScript in try/catch + JSON return.
 * Mutating ops also wrap in undo group ("Gaffer: ..." prefix).
 * Read-only ops skip undo group for ~5-10ms savings per call.
 */

function escapeForJSX(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// Strip nested app.beginUndoGroup/endUndoGroup calls — AE doesn't support
// nesting and unmatched pairs leak into the undo stack, causing "undo
// mismatch" dialogs on later cmd-z. The outer safety wrap is the only group.
function stripNestedUndoGroups(code) {
  return code
    .replace(/app\s*\.\s*beginUndoGroup\s*\([^)]*\)\s*;?/g, '')
    .replace(/app\s*\.\s*endUndoGroup\s*\(\s*\)\s*;?/g, '');
}

// Freeze ceiling (ms) for a single synchronous burst of a guarded runJSX. If an
// instrumented loop/recursion runs past this inside one call, __gafferTick throws
// a tagged object and we return a clean error instead of a frozen app. Override
// with GAFFER_RUNJSX_GUARD_MS. runJSXLoop derives its own ceiling from sliceMs.
var RUNJSX_GUARD_MS = Number(process.env.GAFFER_RUNJSX_GUARD_MS) > 0
  ? Number(process.env.GAFFER_RUNJSX_GUARD_MS)
  : 2000;

// Agent-facing abort copy (no em-dashes — project rule).
var RUNJSX_ABORT_MSG =
  'Stopped a script that ran past the safety ceiling without finishing, likely a large or ' +
  'unbounded loop, so After Effects stays responsive. Break it into smaller steps, or use ' +
  'runJSXLoop for bulk or iterative work.';

// The guard prelude injected into a guarded wrapper: shared microsecond
// accumulator + the __gafferTick() the instrumented code calls. Primed once.
// Amortized: the timer is sampled every 256 ticks so hot loops aren't slowed.
function guardPrelude(guardMs) {
  return (
    '  var __gEl = 0, __gc = 0, __gGuardMs = ' + guardMs + ';\n' +
    '  function __gafferTick(){ if ((++__gc & 255) === 0) { __gEl += $.hiresTimer; ' +
    'if (__gEl / 1000 > __gGuardMs) throw { __gafferBudget: true, ms: __gEl / 1000 }; } }\n' +
    '  $.hiresTimer;\n'
  );
}

// The extra catch branch (before the generic one) that turns a budget abort
// into a clean, actionable error rather than a raw exception.
function budgetCatchBranch() {
  return (
    '    if (e && e.__gafferBudget) { return JSON.stringify({ ok: false, error: ' +
    JSON.stringify(RUNJSX_ABORT_MSG) + ' + " (~" + Math.round(e.ms) + "ms)", line: null, budgetAbort: true }); }\n'
  );
}

export function wrapInSafety(code, undoLabel, readOnly, opts) {
  opts = opts || {};
  var guard = !!opts.guard;
  var pre = guard ? guardPrelude(RUNJSX_GUARD_MS) : '';
  var cat = guard ? budgetCatchBranch() : '';
  if (readOnly) {
    return `(function() {
${pre}  try {
    var __result = eval(${JSON.stringify(code)});
    return JSON.stringify({ ok: true, result: String(__result != null ? __result : "undefined") });
  } catch (e) {
${cat}    return JSON.stringify({ ok: false, error: e.toString(), line: e.line || null });
  }
})();`;
  }
  var stripped = stripNestedUndoGroups(code);
  var label = undoLabel || stripped.substring(0, 40).replace(/[\r\n]/g, ' ');
  return `(function() {
  app.beginUndoGroup("Gaffer: ${escapeForJSX(label)}");
${pre}  try {
    var __result = eval(${JSON.stringify(stripped)});
    return JSON.stringify({ ok: true, result: String(__result != null ? __result : "undefined") });
  } catch (e) {
${cat}    return JSON.stringify({ ok: false, error: e.toString(), line: e.line || null });
  } finally {
    app.endUndoGroup();
  }
})();`;
}

/**
 * Builds one time-budgeted "slice" of a portioned run for `runJSXLoop`.
 * The agent supplies `stepBody` — a JS function expression `(cursor) =>
 * ({ cursor, done, result? })` that does ONE unit of work. This wrapper opens a
 * single undo group "Gaffer: <label> (part k)", then runs a do/while loop that
 * calls step(cursor) repeatedly until the op is done or the per-slice time
 * budget (`sliceMs`, default 300ms) elapses, threading the cursor forward and
 * counting `processed` units. It returns a JSON string exactly like
 * wrapInSafety does, so it rides the existing queue/bridge/evalScript path with
 * no panel change. The daemon (chunk-driver.js) owns the outer loop, cursor
 * state, aggregation, cancel, and the overall ceiling.
 *
 * The generated JSX is ES3 (var/function only) per the ExtendScript rules.
 *
 * TIMER NOTE: `$.hiresTimer` returns microseconds SINCE ITS LAST ACCESS (not
 * since engine start — verified live in AE). So we prime it once (discard that
 * first read) and ACCUMULATE the per-iteration deltas into `elapsedUs`; reading
 * it once per iteration is essential. The naive `t0 = $.hiresTimer; ...
 * $.hiresTimer - t0` pattern is WRONG here and would misfire the budget.
 */
export function wrapSlice(stepBody, cursorJSON, label, sliceMs, part) {
  var stripped = stripNestedUndoGroups(String(stepBody));
  var safeLabel = escapeForJSX(String(label == null ? '' : label));
  var budget = Number(sliceMs) > 0 ? Number(sliceMs) : 300;
  var partNum = Number(part) > 0 ? Math.floor(Number(part)) : 1;
  // Freeze ceiling for ONE step call. Above the per-slice budget so a healthy
  // multi-step slice (which the do/while stops at `budget`) never trips; only a
  // single step that blows past this (a fat inner loop) throws the budget signal.
  var guardMs = Math.max(3 * budget, 1000);
  return '(function () {\n' +
    '  app.beginUndoGroup("Gaffer: ' + safeLabel + ' (part ' + partNum + ')");\n' +
    '  var cursor = ' + cursorJSON + ';\n' +
    // Shared microsecond accumulator: fed both by the do/while (between steps)
    // and by __gafferTick (inside an instrumented step). One reader of
    // $.hiresTimer per site keeps the "since last access" deltas coherent.
    '  var __gEl = 0, __gc = 0, __gGuardMs = ' + guardMs + ';\n' +
    '  function __gafferTick(){ if ((++__gc & 255) === 0) { __gEl += $.hiresTimer; ' +
    'if (__gEl / 1000 > __gGuardMs) throw { __gafferBudget: true, ms: __gEl / 1000 }; } }\n' +
    '  var processed = 0;\n' +                       // declared outside try so the catch can report partial progress
    '  try {\n' +
    '    var step = ' + stripped + ';\n' +
    '    var done = false, out, hasResult = false, results = [];\n' +
    '    $.hiresTimer;\n' +                        // prime (discard first read)
    '    do {\n' +
    '      out = step(cursor);\n' +
    '      cursor = (out && typeof out.cursor !== "undefined") ? out.cursor : null;\n' +
    '      done = !!(out && out.done);\n' +
    '      processed++;\n' +
    '      if (out && typeof out.result !== "undefined") { hasResult = true; results.push(out.result); }\n' +
    '      __gEl += $.hiresTimer;\n' +              // += microseconds since last access
    '    } while (!done && (__gEl / 1000) < ' + budget + ');\n' +
    '    var payload = { ok: true, cursor: cursor, done: done, processed: processed, elapsedMs: __gEl / 1000 };\n' +
    '    if (hasResult) { payload.result = results; }\n' +
    '    return JSON.stringify(payload);\n' +
    '  } catch (e) {\n' +
    '    if (e && e.__gafferBudget) {\n' +
    '      return JSON.stringify({ ok: false, error: "This step ran past the safety ceiling (~" + Math.round(e.ms) + "ms) inside one call, likely a large inner loop. Do ONE small unit of work per step and return the next cursor so the daemon can portion it.", line: null, cursor: cursor, processed: processed, budgetAbort: true });\n' +
    '    }\n' +
    '    return JSON.stringify({ ok: false, error: e.toString(), line: e.line || null, cursor: cursor, processed: processed });\n' +
    '  } finally {\n' +
    '    app.endUndoGroup();\n' +
    '  }\n' +
    '})();';
}
