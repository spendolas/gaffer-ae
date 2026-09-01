import { wrapSlice } from '../safety.js';
import { runChunkLoop } from '../chunk-driver.js';

// Approved defaults (see docs/superpowers/specs/2026-09-01-portioned-jsx-execution-design.md).
var DEFAULT_SLICE_MS = 300;      // per-slice time budget in AE
var DEFAULT_MAX_MS = 300000;     // overall ceiling: 5 minutes
var DEFAULT_MAX_SLICES = 2000;   // overall ceiling: slice count

/**
 * runJSXLoop — portioned/iterative ExtendScript execution.
 *
 * The agent supplies a `step` function body that does ONE unit of work and
 * returns the next cursor. The daemon drives it in small, time-bounded slices
 * (one undo group each, "Gaffer: <label> (part k)"), so a big bulk operation
 * never hangs AE. State (the cursor) lives in the daemon and round-trips as
 * JSON, so it survives a failed slice and is fully testable.
 *
 * `ctx` carries the daemon runtime seams: `ctx.bridge` (to stream progress as
 * chat_event, which the panel already renders) and `ctx.isCancelled` (bound to
 * the existing chat-cancel flag).
 */
export function register(server, queue, z, ctx) {
  ctx = ctx || {};
  server.registerTool(
    'runJSXLoop',
    {
      description:
        'Run bulk or iterative ExtendScript in After Effects WITHOUT hanging AE. ' +
        'You provide a "step" function body that does ONE small unit of work and ' +
        'returns the next cursor; the daemon calls it repeatedly in short ' +
        'time-bounded slices, letting AE stay responsive between them. Use this ' +
        'for many layers/keyframes/precomps or any long loop. Use plain runJSX ' +
        'for small one-shot operations. The whole run produces N labeled undo ' +
        'steps ("Gaffer: <label> (part k)"), one per slice. Returns a JSON ' +
        'summary { done, totalProcessed, cursor, reason } where reason is ' +
        'done | cancelled | capped | error.',
      inputSchema: {
        label: z.string().describe('Short label for the undo steps and progress (e.g. "Recolor layers").'),
        step: z.string().describe(
          'A JS function EXPRESSION body, ES3 only (var/function; no arrow/let/const/template literals). ' +
          'Signature: function (cursor) { ... return { cursor: <next>, done: <bool>, result: <optional> }; }. ' +
          'First call receives cursor = null. Do ONE unit of work per call; return the next cursor and ' +
          'whether the WHOLE operation is done. Keep each unit small. Optional per-unit "result" is accumulated. ' +
          'The cursor round-trips as JSON, so keep it JSON-serializable (indices, ids, arrays, plain objects).'
        ),
        sliceMs: z.number().optional().describe('Per-slice time budget in ms (default 300). Larger = fewer round-trips but less responsive AE.'),
        maxMs: z.number().optional().describe('Overall time ceiling in ms (default 300000 = 5 min). Stops with reason "capped".'),
        maxSlices: z.number().optional().describe('Overall slice-count ceiling (default 2000). Stops with reason "capped".'),
        aeVersion: z.string().optional().describe('Target AE version when multiple instances are open (e.g. "26.0"). Omit if only one AE is open.'),
      },
    },
    async ({ label, step, sliceMs, maxMs, maxSlices, aeVersion }) => {
      try {
        var effSliceMs = Number(sliceMs) > 0 ? Number(sliceMs) : DEFAULT_SLICE_MS;
        var effMaxMs = Number(maxMs) > 0 ? Number(maxMs) : DEFAULT_MAX_MS;
        var effMaxSlices = Number(maxSlices) > 0 ? Number(maxSlices) : DEFAULT_MAX_SLICES;

        // Each slice: JSON-inject the current cursor, wrap it, and run it through
        // the SAME serialized queue/bridge path runJSX uses (aeVersion routes it).
        var runSlice = function (cursor, part) {
          var cursorJSON = JSON.stringify(typeof cursor === 'undefined' ? null : cursor);
          var wrapped = wrapSlice(step, cursorJSON, label, effSliceMs, part);
          return queue.enqueuePreWrapped(wrapped, aeVersion);
        };

        // Stream progress to the panel using the chat_event message it already
        // renders (showChatNotice). No em-dashes in user-facing copy.
        var onProgress = function (p) {
          if (ctx.bridge && typeof ctx.bridge.sendToPanel === 'function') {
            ctx.bridge.sendToPanel(
              { type: 'chat_event', event: 'jsx_loop_progress', message: p.label + ': ' + p.totalProcessed + ' done' },
              aeVersion
            );
          }
        };

        var isCancelled = typeof ctx.isCancelled === 'function' ? ctx.isCancelled : function () { return false; };

        var summary = await runChunkLoop({
          runSlice: runSlice,
          label: label,
          initialCursor: null,
          sliceMs: effSliceMs,
          maxMs: effMaxMs,
          maxSlices: effMaxSlices,
          onProgress: onProgress,
          isCancelled: isCancelled,
          now: Date.now,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(summary) }],
          isError: summary.reason === 'error',
        };
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }],
          isError: true,
        };
      }
    }
  );
}
