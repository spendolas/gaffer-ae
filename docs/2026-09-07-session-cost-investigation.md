# Investigation: Why a Simple Gaffer Task Cost $10

Date: 2026-09-07
Status: Root causes confirmed via direct transcript evidence, fixes not yet
implemented.

## Plain-language summary

A test task ("create a comp, apply an effect, open it, select a layer")
showed costs ranging from $0.33 to over $10 for what should be a cheap,
simple operation. The investigation found **the tool itself was not the
problem** — Gaffer's own prompt and its 26 tool definitions together are
tiny (~8,500 tokens, a rounding error). The real cause is a **genuine bug**:
the daemon's safety mechanism that's supposed to reset a conversation
before it grows too large has been silently broken the entire time,
measuring the wrong number. As a result, one single chat session had been
kept alive continuously for **8 days** (293 turns, over 1,000 individual
API calls) without ever resetting — and every single message in that
window paid to re-read the *entire* accumulated 8-day history, cheaply
per-token, but at a scale (300,000+ tokens per API call) that adds up to
real money. On top of that, a second mechanism meant to *save* money (an
image-pruning step) turned out to *cost* more than it saves, because it
accidentally invalidates the cache and forces expensive full rewrites.
Neither of these is "just what AI costs" — both are fixable bugs in
Gaffer's own code.

## The mechanism, confirmed

The $10 test's actual raw numbers (`cache_read_input_tokens=935,368`,
`cache_creation_input_tokens=1,822`) are not one giant request — they're
the **sum of 2-4 separate API calls in that turn**, each individually
reading back roughly 314,000 tokens of accumulated conversation history.
This was confirmed directly from the real session transcript on disk
(`~/.claude/projects/.../74a4d687-....jsonl`), not inferred.

That one session ID has been resumed continuously since **2026-08-30**,
across **293 human turns** and **1,098 individual API requests** — 437
million cumulative cache-read tokens and 21.6 million cache-creation
tokens over its life, in a 25.3MB transcript file. It has never been
reset once.

## Root cause 1 (primary): the compaction safety guard is broken

`chat-handler.js` has a mechanism meant to prevent exactly this: once a
session's context approaches a threshold (150,000 tokens), it's supposed
to summarize and reset to a fresh session. The bug: the value it checks
(`this.lastInputTokens`, from `event.usage.input_tokens`) is the
**uncached** portion of that specific API call only — which stays in the
single digits to low tens once caching kicks in (12-24 in the tests that
started this investigation). It can never reach 150,000, no matter how
large the real accumulated session gets. The guard is dead code — it has
never fired, and the session has grown unbounded for over a week.

**Fix direction**: gate on the sum of `input + cache_read +
cache_creation` (the real total context size), not `input_tokens` alone.

## Root cause 2: the session pruner (meant to save money) costs more than it saves

A separate mechanism (`session-pruner.js`) strips old image data out of
the transcript once it exceeds 512KB, replacing early image blocks with
small stubs — intended to save the token cost of large image payloads.
The problem: rewriting *any* earlier message changes the prompt prefix
from that point forward, which **invalidates the cache for everything
after it** — forcing a full, expensive rewrite (at the 1.25-2x cache-write
premium) of everything downstream of the edit, just to save a comparably
small amount of image-token cost.

Measured impact: across this session's 1,098 calls, only 51 of them (4.6%)
had large cache-creation events — but those 51 calls account for **92% of
all cache-creation tokens ever spent in this session's history** (19.9M of
21.6M). One confirmed instance: a prune at 01:14:57 was followed at
01:17:05 by a call reading only ~31K tokens from cache but **writing
280,132 fresh tokens** — a direct, measured consequence of the prune.

**Fix direction**: the pruner's cost-benefit is backwards for a
long-lived, cache-heavy session — either don't prune mid-session (defer
to the same reset point as root cause 1's fix), or find a pruning
strategy that doesn't rewrite the middle of an already-cached prefix.

## Root cause 3 (contributing): mid-session model switching

Gaffer's `autoModel`/"Scrooge" feature can pick a different model per turn
based on message classification. Caches are model-scoped — every model
switch forces a full cache rewrite. Confirmed directly: this one session's
transcript shows calls across `claude-sonnet-4-5`, `claude-opus-4-7`
(1,034 calls), `claude-haiku-4-5` (2 calls), and `claude-fable-5` (58
calls, alone accounting for 1.16M cache-creation tokens).

This is a real cost, but likely secondary to root causes 1-2, and may be
an acceptable tradeoff of the feature (worth a separate look, not
necessarily "broken").

## What's actually filling the ~314K-token-per-call context

Ruled out, with real measurements:
- **Tool/schema definitions**: Gaffer's own 26 tools + system prompt
  measure to ~7,500-8,500 tokens. Grip's (a third-party MCP, unrelated to
  this investigation's original task) 41 tools measure to ~6,050 tokens,
  via direct extraction of its real schemas, not estimation. Combined,
  even with a full third-party MCP server included, this is **under 3%**
  of the observed per-call cost. An earlier claim in this investigation
  (that Grip's tools explained a ~307K-token difference between two
  tests) is now confirmed wrong — Grip's actual footprint is roughly 50x
  too small to explain that gap. The real explanation is normal variance
  between two points in the same ever-growing, never-reset session.
- **Images**: Gaffer's own capture tools return small JSON path/dimension
  records, not image data (confirmed by reading all 26 tool
  implementations). Images enter history only when the agent separately
  reads a captured file via Claude Code's built-in `Read` tool — measured
  at roughly 10,000 tokens worth kept after pruning. A minor slice.

What actually dominates (measured, from the real transcript content):
**the agent's own accumulated ExtendScript code**, written into `runJSX`
tool calls over the session's 293 turns (46% of content) plus that tool's
results (17%), plus assistant text, `runJSXLoop`, and `Bash` usage
(remainder). None of this is unusually large *content* — it's simply
never been rotated out, because of root cause 1.

## Bottom line

Not "that's just what AI costs" — the underlying `--resume`-rereads-full-
history-from-cache behavior is Claude Code's normal, intended design, and
is fine for a session of reasonable length. Gaffer's own safety net for
keeping sessions at a reasonable length has been broken since it was
written, letting real sessions grow unbounded (this one: 8 days and
counting) — and a second, unrelated cost-saving mechanism has been making
the problem actively worse every time it fires. Both are concrete,
fixable bugs in this codebase, not an inherent limitation.

## Method notes / confidence

This report is a synthesis of three independent investigations run in
parallel: (1) a full code trace of `chat-handler.js` plus every tool
implementation, cross-referenced directly against the real session
transcript on disk — the strongest evidence, since it's measured from
actual production data, not inferred; (2) research into Claude Code CLI's
own documented behavior (confirms `--resume` resends full history by
design, cache-scoped per model — general mechanism confirmed, though a
few specific claims from official docs, like exact built-in system-prompt
token counts, weren't independently re-verified and should be treated as
sourced-but-unconfirmed); (3) direct token measurement of Gaffer's own and
Grip's real tool schemas (ruled out tool definitions as a meaningful cost
driver, with real numbers, not estimates).

Two items remain genuinely unresolved, flagged by the code-trace
investigation as outside this repo's visibility: 18 of the 51 large
cache-rewrite events had no known prune trigger and a short idle gap
(candidate: some CLI-internal history mutation on `--resume`, unverified);
and whether `--allowedTools` actually filters which tool schemas the model
sees at all, versus only gating permission to call them (conflicting
signals between sources, not resolved here, and — per the tool-schema
measurement — not load-bearing for the cost conclusion regardless of the
answer).

## Not investigated here, worth a separate look

- Whether `autoModel`/Scrooge's actual measured savings (from cheaper
  models on simple turns) outweigh the cache-invalidation cost of
  switching models mid-session (root cause 3) — a real tradeoff, not
  addressed by this investigation.
- A concrete session-reset policy: how often, on what trigger, and
  whether users should be able to see/control when a session resets.
