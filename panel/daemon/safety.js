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
  var label = undoLabel || code.substring(0, 40).replace(/[\r\n]/g, ' ');
  return `(function() {
  app.beginUndoGroup("Gaffer: ${escapeForJSX(label)}");
  try {
    var __result = eval(${JSON.stringify(code)});
    return JSON.stringify({ ok: true, result: String(__result != null ? __result : "undefined") });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.toString(), line: e.line || null });
  } finally {
    app.endUndoGroup();
  }
})();`;
}
