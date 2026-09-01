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

export function wrapInSafety(code, undoLabel, readOnly) {
  if (readOnly) {
    return `(function() {
  try {
    var __result = eval(${JSON.stringify(code)});
    return JSON.stringify({ ok: true, result: String(__result != null ? __result : "undefined") });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.toString(), line: e.line || null });
  }
})();`;
  }
  var stripped = stripNestedUndoGroups(code);
  var label = undoLabel || stripped.substring(0, 40).replace(/[\r\n]/g, ' ');
  return `(function() {
  app.beginUndoGroup("Gaffer: ${escapeForJSX(label)}");
  try {
    var __result = eval(${JSON.stringify(stripped)});
    return JSON.stringify({ ok: true, result: String(__result != null ? __result : "undefined") });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.toString(), line: e.line || null });
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
  return '(function () {\n' +
    '  app.beginUndoGroup("Gaffer: ' + safeLabel + ' (part ' + partNum + ')");\n' +
    '  var cursor = ' + cursorJSON + ';\n' +
    '  try {\n' +
    '    var step = ' + stripped + ';\n' +
    '    var processed = 0, done = false, out, hasResult = false, results = [];\n' +
    '    $.hiresTimer;\n' +                        // prime (discard first read)
    '    var elapsedUs = 0;\n' +
    '    do {\n' +
    '      out = step(cursor);\n' +
    '      cursor = (out && typeof out.cursor !== "undefined") ? out.cursor : null;\n' +
    '      done = !!(out && out.done);\n' +
    '      processed++;\n' +
    '      if (out && typeof out.result !== "undefined") { hasResult = true; results.push(out.result); }\n' +
    '      elapsedUs += $.hiresTimer;\n' +          // += microseconds since last access
    '    } while (!done && (elapsedUs / 1000) < ' + budget + ');\n' +
    '    var payload = { ok: true, cursor: cursor, done: done, processed: processed };\n' +
    '    if (hasResult) { payload.result = results; }\n' +
    '    return JSON.stringify(payload);\n' +
    '  } catch (e) {\n' +
    '    return JSON.stringify({ ok: false, error: e.toString(), line: e.line || null, cursor: cursor });\n' +
    '  } finally {\n' +
    '    app.endUndoGroup();\n' +
    '  }\n' +
    '})();';
}
