/**
 * Chunk driver for `runJSXLoop` — the daemon-side orchestrator for portioned
 * JSX execution. AE only ever runs one small, time-bounded slice at a time
 * (via the injected `runSlice`, which rides the serialized queue/bridge). This
 * pure module owns everything hard: the outer loop, cursor threading, progress,
 * cancellation, result aggregation, and the overall ceiling.
 *
 * Between slices control returns to Node's event loop and the panel's
 * evalScript callback returns to AE's event loop, so AE repaints and stays
 * responsive throughout a long bulk operation.
 *
 * Injectable seams (mirrors the queue / _fetchCatalog test pattern):
 *   runSlice(cursor, part) -> Promise<string|object>  one slice's JSON result
 *   now() -> ms                                        wall clock for maxMs
 *   onProgress({ label, totalProcessed, part })        called per committed slice
 *   isCancelled() -> boolean                           checked between slices
 *
 * Resolves a summary { done, totalProcessed, cursor, reason } (+ optional
 * `results` / `error`). reason is one of: done | cancelled | capped | error.
 * NEVER throws for a normal stop.
 *
 * Future daemon-side levers (deliberately omitted now — YAGNI; the seams are
 * here to add them without touching AE or the slice wrapper):
 *   - adaptive per-slice cadence from measured round-trip time,
 *   - a small inter-slice breather,
 *   - transient-disconnect retry of a lost slice (the cursor is held here, so
 *     re-sending the same slice is safe and idempotent w.r.t. the cursor).
 */
export async function runChunkLoop(opts) {
  var runSlice = opts.runSlice;
  var label = opts.label;
  var cursor = (typeof opts.initialCursor === 'undefined') ? null : opts.initialCursor;
  var maxMs = opts.maxMs;
  var maxSlices = opts.maxSlices;
  var onProgress = opts.onProgress;
  var isCancelled = opts.isCancelled;
  var now = opts.now || Date.now;

  var totalProcessed = 0;
  var results = [];
  var hasResults = false;
  var part = 1;
  var startTime = now();

  function finish(done, reason, extra) {
    var summary = { done: done, totalProcessed: totalProcessed, cursor: cursor, reason: reason };
    if (hasResults) summary.results = results;
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] != null) summary[k] = extra[k];
      }
    }
    return summary;
  }

  while (true) {
    var raw;
    try {
      raw = await runSlice(cursor, part);
    } catch (e) {
      // Abnormal (e.g. panel disconnect mid-slice). Not a normal stop; surface
      // it as an error with whatever partial we have. Transient-retry is a
      // future lever — the cursor is held, so a lost slice is safe to re-send.
      return finish(false, 'error', { error: (e && e.message) || String(e) });
    }

    var parsed;
    try {
      parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
    } catch (e2) {
      return finish(false, 'error', { error: 'Unparseable slice result: ' + ((e2 && e2.message) || String(e2)) });
    }

    // Step threw inside AE. Completed slices remain — each is its own undo step.
    if (!parsed || parsed.ok === false) {
      if (parsed && typeof parsed.cursor !== 'undefined') cursor = parsed.cursor;
      return finish(false, 'error', {
        error: (parsed && parsed.error) || 'Slice failed',
        line: (parsed && parsed.line) || null,
      });
    }

    totalProcessed += (parsed.processed || 0);
    cursor = (typeof parsed.cursor !== 'undefined') ? parsed.cursor : null;
    if (typeof parsed.result !== 'undefined') {
      hasResults = true;
      results = results.concat(parsed.result);
    }

    if (onProgress) {
      // Progress reporting must never break the loop.
      try { onProgress({ label: label, totalProcessed: totalProcessed, part: part }); } catch (e3) { /* ignore */ }
    }

    if (parsed.done) return finish(true, 'done', null);

    // ── between slices: honor cancel, then the overall ceiling ──
    if (isCancelled && isCancelled()) return finish(false, 'cancelled', null);
    if (maxSlices && part >= maxSlices) return finish(false, 'capped', null);
    if (maxMs && (now() - startTime) >= maxMs) return finish(false, 'capped', null);

    part++;
  }
}
