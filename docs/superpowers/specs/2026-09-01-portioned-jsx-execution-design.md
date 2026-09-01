# Portioned JSX Execution (`runJSXLoop`) — Design

Date: 2026-09-01
Status: Design (pending review)
Branch: feat/account-sign-in

## Problem

`runJSX` runs the agent's ExtendScript **synchronously on AE's single UI
thread** (daemon → WebSocket → panel `cs.evalScript(code)`). A long script
blocks AE for its entire duration — the UI beachballs and cannot repaint or
respond. ExtendScript **cannot be interrupted or yielded mid-script**, and the
existing 60s timeout only rejects the *daemon's* promise; AE keeps executing the
script regardless, so the hang outlasts the timeout.

The only way to keep AE responsive is to run **small scripts** and return
control to AE's event loop between them. Gaffer cannot mechanically split an
opaque JSX string (it can't know a safe cut point inside the agent's loop), so
"portioning" must happen at the operation level via a primitive the agent
targets.

## Goals

- Bulk operations (many layers / keyframes / precomps, long iterations) run
  without hanging AE — the UI stays responsive throughout.
- Progress is visible; the run is cancellable; a runaway loop is bounded.
- Small operations keep using plain `runJSX` unchanged (single call, single
  undo group).

## Non-goals

- Interrupting or killing a script already executing in AE (not possible).
- Auto-splitting arbitrary opaque JSX (not possible/safe).
- Parallel AE execution (AE is single-threaded; the queue serializes).

## Key decisions (agreed)

1. **Resumable-step driver**, not a declarative batch primitive or
   guidance-only. The agent provides a step function; the daemon drives it.
2. **N labeled undo steps** for a chunked op (one undo group per slice). An
   undo group cannot span separate `evalScript` calls, and holding one open
   across calls triggers the "undo mismatch" dialogs the safety wrap prevents.
   Each slice is `Gaffer: <label> (part k)`. Only `runJSXLoop` behaves this way;
   `runJSX` stays single-undo.
3. **The daemon (Node) owns all orchestration**; AE only ever runs a small,
   time-bounded burst and returns a cursor. This is the core leverage: every
   hard part (loop, state, timing, resilience, reporting, ceiling) is Node's.

## Architecture

```
agent → runJSXLoop(label, step, opts)      [MCP tool]
          │
          ▼
     Chunk driver (daemon, Node)            ← owns loop, cursor, timing, cancel,
          │  repeat per slice:                aggregation, ceiling, retry
          │    queue.enqueue(sliceWrapper(step, cursor))  ← existing serialized queue
          │        │  WebSocket
          │        ▼
          │   panel cs.evalScript(slice)     ← one undo group, time-budgeted
          │        │                            while-loop over step(cursor)
          │        ▼
          │   AE runs ~sliceMs of work, returns { cursor, done, processed, result }
          │  ← AE's event loop breathes between slices (repaint, stay responsive)
          ▼
     aggregate → return { done, totalProcessed, results?, reason }
```

### Components

- **`tools/runJSXLoop.js`** (new MCP tool, `mcp__gaffer__runJSXLoop`).
  Agent-facing inputs:
  - `label` (string) — undo-group / progress label.
  - `step` (string, JSX) — a function body `(cursor) => ({ cursor, done, result? })`.
    First invocation receives `cursor = null`. It does **one unit** of work and
    returns the next cursor and whether the whole op is done. Optional `result`
    is accumulated.
  - `sliceMs` (number, optional, default ~300) — per-slice time budget.
  - `maxMs` / `maxSlices` (optional) — overall ceiling (daemon-enforced).
  - `aeVersion` (optional) — existing multi-instance routing.

- **`chunk-driver.js`** (new daemon module). Pure, testable core: given a
  `runSlice(cursor)` function (which wraps queue+bridge) plus opts, it loops —
  calls `runSlice`, advances the cursor from the returned value, emits progress,
  honors cancel + ceiling, aggregates results, and resolves with a summary.
  Bridge/queue/now/onProgress injected for tests (mirrors the existing
  `_fetchCatalog` / queue seam pattern).

- **`safety.js`** — add `wrapSlice(stepBody, cursorJSON, label, sliceMs, part)`:
  builds the slice's JSX. Shape:
  ```js
  (function () {
    app.beginUndoGroup("Gaffer: <label> (part k)");
    try {
      var step = <stepBody>;              // function (cursor) {...}
      var cursor = <cursorJSON>;          // JSON-injected from the daemon
      var t0 = $.hiresTimer;              // microseconds
      var processed = 0, done = false, out;
      do {
        out = step(cursor);
        cursor = out.cursor; done = !!out.done; processed++;
        // accumulate out.result if present
      } while (!done && ($.hiresTimer - t0) / 1000 < <sliceMs>);
      return JSON.stringify({ ok: true, cursor: cursor, done: done, processed: processed, result: ... });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.toString(), line: e.line || null });
    } finally { app.endUndoGroup(); }
  })();
  ```
  Reuses the existing nested-undo-group stripping on `stepBody`.

- **`index.js`** — register the tool; wire `onRunJSXLoop` to the driver, passing
  the queue, a progress callback (streams to the panel), and the cancel flag.

- **`prompts/gaffer.md`** — guidance: use `runJSXLoop` for bulk/iterative work
  (many layers/keyframes/precomps, big loops); plain `runJSX` for small ops.
  Keep each `step` unit small and idempotent w.r.t. the cursor.

### Data flow / cursor

The **cursor round-trips as JSON**: the daemon holds it and injects it into each
slice; the slice returns the next cursor. State lives in the daemon, not in AE
globals — robust across a failed/retried slice, and explicit. (ExtendScript
globals do persist across `evalScript` in the CEP engine, but round-trip is
chosen for resilience + testability.)

### Timing / responsiveness

- Each slice self-caps at `sliceMs` via `$.hiresTimer`.
- Between slices, the daemon's loop returns to Node's event loop and the panel's
  `evalScript` callback returns to AE's event loop → AE repaints and stays
  responsive.
- Daemon-owned levers (start simple, all live in Node): overall `maxMs`/
  `maxSlices` ceiling; optional small inter-slice breather; optional adaptive
  budget from measured round-trip; optional retry of a slice lost to a transient
  panel disconnect (cursor is held, so re-send is safe).

### Error handling

- A slice returning `ok:false` (step threw) → driver stops, resolves with
  `{ done:false, totalProcessed, reason:'error', error, cursor }`. Completed
  slices remain (cleanly undoable per decision 2).
- Ceiling hit → `{ done:false, reason:'capped', cursor, totalProcessed }`.
- Cancel → `{ done:false, reason:'cancelled', cursor, totalProcessed }` after the
  current slice commits.
- Per-slice 60s timeout still applies but is effectively unreachable (slices are
  ~`sliceMs`); it becomes a stuck-slice backstop.

### Cancellation + progress

- Progress: after each slice the daemon emits a `chat_event`/progress message
  (`<label>: <totalProcessed> done`) to the panel.
- Cancel: reuses the existing chat-cancel path; the driver checks the flag
  between slices and stops after the current one.

## Testing

Unit-test `chunk-driver.js` against a stubbed `runSlice` (no AE):
- Slices in order; cursor threaded correctly; stops on `done`.
- Progress callback fires per slice with the right counts.
- Cancel-between-slices stops promptly, returns `cancelled` + partial + cursor.
- Error slice stops with `error` + partial + cursor.
- Ceiling (`maxMs`/`maxSlices`) stops with `capped`.
- `wrapSlice` builds valid JSX with the right undo-group label and budget
  (string assertions).
Keep the existing 76 daemon tests green.

## Rollout / compatibility

- Additive: new tool + new module; `runJSX`, the queue, and `wrapInSafety` are
  unchanged for existing callers.
- Ships to users in the next version bump (not a v0.9.6 re-stamp).

## Open items for review

- Default `sliceMs` (proposed 300) and default overall ceiling (proposed e.g.
  `maxMs` 5 min) — confirm values.
- Whether to implement adaptive cadence + transient-retry now or leave as
  daemon-side follow-ups (YAGNI: core loop first).
