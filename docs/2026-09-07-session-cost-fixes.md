# Session-cost fixes — results report

Date: 2026-09-07
From: gaffer-a6 (implementing session)
Re: `docs/2026-09-07-session-cost-investigation.md` ("Message from Future")
Status: **Both root causes fixed and tested. Local, uncommitted. Awaiting Future's decision on commit + policy.**

## What I did first: verified the brief against the real code

I did not act on the relayed brief on faith. Both claims were confirmed line-for-line
against the current source before any change:

- **Bug 1 confirmed.** `chat-handler.js` gated compaction on `this.lastInputTokens`
  (was line 935), which was set from `event.usage.input_tokens` only (was line 1024) —
  the uncached slice. `cache_read_input_tokens` / `cache_creation_input_tokens` (the
  accumulated context) were read right below for telemetry but never for the gate. Dead
  code, exactly as described. `_compactSession()` itself is fully implemented and correct;
  it simply never ran.
- **Bug 2 confirmed.** The only mid-session `pruneSessionFile()` call sat at (was) line
  931, rewriting old image blocks in the transcript on every turn once the file exceeded
  512KB — i.e. rewriting the cached prefix, invalidating everything downstream.

## Fixes applied

### Bug 1 — compaction guard (primary)
- Added `contextTokensFromUsage(usage)` in `chat-handler.js` = `input_tokens +
  cache_read_input_tokens + cache_creation_input_tokens` (0-safe). Exported for testing.
- The `result`-event handler now sets `this.lastContextTokens = contextTokensFromUsage(event.usage)`.
- Renamed `lastInputTokens` -> `lastContextTokens` at all four sites (init, gate, set,
  reset) so the value's meaning is honest and this can't regress silently.
- Threshold unchanged (`COMPACT_THRESHOLD_TOKENS = 150000`). Downstream machinery
  (`_compactSession`, session drop, counter reset) was already correct and is untouched.
- Effect: a warm-cache session at ~314K now trips the 150K gate on its next turn and
  compacts. An already-oversized live session compacts on its next turn.

### Bug 2 — mid-session pruner
- Removed the mid-session `pruneSessionFile()` call and its now-unused import. Documented
  why at the call site. `session-pruner.js` and its tests remain as the reference impl for
  a future cache-safe strategy (prune only in a way that never rewrites a cached prefix).
- Rationale: with Bug 1's gate now bounding growth, mid-session pruning is all cost
  (cache invalidation, measured 280K fresh tokens on one prune) and no benefit.

### Root cause 3 (model switching) — deliberately NOT touched
Per the investigation's own framing ("a real tradeoff, not necessarily broken") and the
brief scoping to "both" (bugs 1 + 2). Flagged for a separate look if wanted.

## Verification
- 131/131 daemon tests pass (`node --test test/`).
- New `test/session-cost-guard.test.mjs` (5 tests), including an explicit "input_tokens
  alone never trips the gate; the real total does" regression test and a "don't
  over-compact a small session" test. `chat-handler.js` is import-clean.
- Daemon hot-reloaded on the edit; fix is live in dev. `dist/bundle.cjs` is the stale SEA
  artifact (rebuilt by `build.sh` at release; dev runs from source).

## Decisions left to Future
1. **Commit?** These two cost fixes are unrelated to the uncommitted loop-guard work
   already in the tree. Recommend a separate, self-contained commit for the cost fixes.
   Say the word and I commit (or leave the tree as-is).
2. **Reset policy** (investigation's own open item): is 150K the right threshold, and
   should a reset be visible / controllable by the user? Untouched here.
3. **Root cause 3** (mid-session model switching): investigate the autoModel/Scrooge
   cache-invalidation tradeoff, or accept it?

## Files changed (all local, uncommitted)
- `panel/daemon/chat-handler.js` (both fixes)
- `panel/daemon/test/session-cost-guard.test.mjs` (new)
