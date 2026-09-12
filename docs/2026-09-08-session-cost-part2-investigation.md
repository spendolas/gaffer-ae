# Session cost, part 2 — why a "cheap" task still costs real money

Date: 2026-09-08
Status: **Investigation complete, findings verified. No fixes applied yet — draft for review.**
Builds on: `docs/2026-09-07-session-cost-investigation.md` (root causes 1-2, fixed in PR #2)
and `docs/2026-09-07-session-cost-fixes.md`. Root causes 1-2 (dead compaction guard,
cache-invalidating mid-session pruner) are shipped. This is what's left.

## Why this exists

PR #2 and #3 fixed the two bugs that let sessions grow unbounded. But real
usage-telemetry data (a live Google Sheet, fed by `panel/daemon/telemetry.js`)
kept showing real, uncomfortable numbers even after those fixes — a few turns
of ordinary "create a comp, apply an effect" work landing at several dollars
of *notional* API-equivalent cost per session. This doc is the investigation
into what's actually driving that, run across three independent angles (a
peer implementing session, a background research agent, and direct
verification against real transcripts), then cross-checked and corrected
against each other and against the real data.

**On "notional": the panel runs on the user's Claude subscription via
keychain OAuth, not a metered API key — nobody is being billed $58 today.**
But `telemetry.js` computes `costUsd` straight from Claude Code's own
`total_cost_usd`, which is the standard published Anthropic API rate. That's
exactly the rate a token-relay/metered-billing user (the frozen
`token-relay-billing-design.md` plan) would actually be charged. So this is
real, faithful COGS preview, not an inflated scare number — worth fixing
before that plan unfreezes, not just a curiosity.

## The real data (one dev install, 2026-09-07/08)

```
model        requestedModel  turns  cacheReadTok  cacheCreationTok  cost
opus-4-7     opus-4-7        5      2,519,667     871,470           $10.06
opus-4-7     opus-4-7        2      964,395       281,613           $3.31
opus-4-7     opus-4-7        2      935,368       1,822             $0.49
opus-4-7     opus-4-7        1      627,913       639               $0.33
opus[1m]     opus            4      30,155,482    795,389           $25.02  ← compaction-loop bug (fixed, PR #2)
sonnet[1m]   opus            1      329,960       280,635           $1.79   ← model-switch cache rewrite
sonnet[1m]   opus            1      332,513       283,150           $1.81   ← model-switch cache rewrite
opus[1m]     opus[1m]        2      3,854,162     411,852           $6.58
sonnet[1m]   opus[1m]        1      311,857       33,938             $0.32   ← model-switch cache rewrite
sonnet[1m]   opus[1m]        3      1,003,041     134,726            $1.24   ← model-switch cache rewrite
opus[1m]     opus[1m]        3      7,684,973     241,826            $7.49
```

Total across this sheet so far: **~$58.43**, all from one dev install's
testing.

## Findings, verified

### 1. Missing `--strict-mcp-config` — free fix, unanimous, do first

`chat-handler.js`'s main chat spawn passes `--mcp-config` with only the
`gaffer` server, but never `--strict-mcp-config`. Confirmed directly: the
classifier subprocess elsewhere in the same file (a separate, correctly
isolated call) *does* pass it. Without it, `--mcp-config` **adds to**
rather than replaces the user's globally-registered MCP servers.

Real transcripts show every AE session — even pure "create a comp" tasks
with zero relevance — carrying a listing of every other connected MCP
server's tools (Figma/`grip`, Box, Google Drive, Notion, Design Systems —
~120+ unwanted tool schemas), recurring in cache-read history every turn.
This also means the panel's per-server MCP toggle is **cosmetic for cost**
today: turning a server off in the UI stops the model from *calling* it, not
from paying to have its schema loaded and re-billed every turn.

**Fix, revised after empirical testing — gate on `enabledMcps`, don't add
the flag unconditionally.** The first version of this fix ("always add
`--strict-mcp-config`, and separately copy any user-enabled server's real
config into the inline `--mcp-config` so opted-in servers like Grip/Notion
still work") was tested live and **breaks every OAuth'd remote server**:

A controlled test (same binary/env/user, only `--strict-mcp-config` +
inline config differed) showed the registered path successfully calling a
real Notion tool (listed the user's actual private pages), while the
strict+inline path with an identical `{type, url}` entry for `notion`
failed outright — *"Notion MCP server requires authentication... cannot run
OAuth flow"* non-interactively. Under strict mode, an inline server entry
is treated as brand-new regardless of name/url match; it does not inherit
the credential the CLI already stored for that server's normal
registration. (Plugin-scoped servers, `plugin:<name>:<server>`, were
separately confirmed via Anthropic's own docs to never survive this
construction at all, for a different reason — their registration can't be
expressed as a plain config entry.)

Copying the live OAuth token into inline config headers as a workaround was
considered and rejected — fragile (tokens expire/refresh) and it means the
daemon handling raw OAuth tokens directly, which the api_auth_security
concerns already flag as something to avoid.

**Actual fix: gate `--strict-mcp-config` on whether `enabledMcps` is
empty.**
- `enabledMcps` empty (the default/common case — confirmed to be exactly
  where the $58 came from) → add `--strict-mcp-config`, inline config is
  `gaffer` only (a local `127.0.0.1` HTTP server, no OAuth involved, so no
  risk). Full win, zero downside.
- `enabledMcps` non-empty (user explicitly opted a server in, e.g. for a
  Figma→animate→Box→Notion workflow) → don't use strict mode; fall back to
  today's registered-server path and accept the schema bloat for that
  session, since the user asked for cross-tool capability, not minimal
  footprint.

This captures the free win for the case that actually produced the real
cost data, without breaking the workflow the toggle exists to support.

### 2. Compaction's own cold-restart tax — ~31K tokens, every single compaction

The single largest identified line item, confirmed structurally and via
real transcript numbers. `_compactSession` sets `sessionId = null`; the
*next* call takes the branch with `--append-system-prompt` and **no
`--resume`** — i.e. a genuinely brand-new Claude Code session, not just a
cleared conversation. That pays the full cold-boot tax fresh, all billed as
`cache_creation` instead of cheap `cache_read`:

| Source | ~tokens |
|---|---|
| Skill index | ~3,735 |
| Deferred-MCP-tools listing | ~3,884 |
| `SessionStart` hook stdout (incl. full `using-superpowers` skill body) | ~4,583 |
| Agent listing | ~517 |
| MCP instructions | ~252 |
| CLAUDE.md (project + global) | ~2,688 |
| Continuity summary itself | ~720 |
| System prompt + ~24 gaffer tool schemas + built-ins (inferred, not directly visible) | ~14,000 |
| **Total** | **~31,000** |

Verified directly against real usage events in `f0f7b223-*.jsonl`: the
first post-compaction call shows `cache_creation_input_tokens: 31,405`
against only `24,903` carried over as `cache_read`. The same chain shows it
happening **twice** (once per compaction observed) — ~63K tokens just from
restarting, in one session.

**The irony**: compaction exists to bound cost, but restarting isn't free,
and it recurs every time compaction fires. This doesn't invalidate raising
the threshold (500K/800K, already shipped) — it does mean compaction
frequency matters as its own cost variable, not just a free safety net.

**Nothing to fix here per se** — this is inherent to how a fresh Claude Code
session bootstraps. Worth knowing when reasoning about compaction frequency,
and it strengthens the case for #3 below (reuse the leading model, at least
recovering the one avoidable multiplier on top of this fixed tax).

### 3. Compaction hardcodes `sonnet-5` regardless of the leading model — avoidable extra cost, fixable

`_compactSession` always spawns `COMPACT_SUMMARIZER_MODEL` (`claude-sonnet-5`)
for the summarization call, never the model that was actually leading the
conversation. Since caches are model-scoped, resuming on a *different*
model than what built the cache forces the same full-rewrite penalty as any
Scrooge downshift — on top of the cold-restart tax in #2, this adds a
second, avoidable multiplier.

`this._lastModel` (the model that just led the conversation) is already
tracked and available at the exact point `_compactSession` is invoked — used
for telemetry two lines above the call site. Sonnet-5 was chosen originally
for context-window headroom ("must be comfortably above the compaction
threshold"), but the variant-aware thresholds (150K under a 200K window,
800K under a 1M window) already guarantee that headroom for whatever model
is leading, in the common case.

**Fix: pass `this._lastModel` instead of the hardcoded constant.** Watch for
the edge case where a downshift landed the conversation on a small-window
model right before compaction fires.

### 4. `runJSX` tool content was undercounted, not absent — corrects, doesn't add to, the mystery

The original per-session tool-vs-non-tool split (18.3% tool-attributable /
81.7% "unattributed") only counted `Read`/`captureFrame` results. It missed
`mcp__gaffer__runJSX`'s own tool *input* (the ExtendScript code Claude
writes, ~6,000 tokens across 23 calls in the sampled session) and its
*result* (JSON property dumps from AE, ~14,600 tokens) — real, tool-shaped
content that isn't prose and isn't images either.

Folding this in, real tool-attributable growth in the sampled session is
closer to **45-50%**, not 18.3%. Not a new bloat source — a correction to
how much of the already-known growth is tool-related.

**Not independently actionable yet** — this is measurement, not a bug. Worth
factoring into any future prompt/tool-output-size work (e.g. does
`runJSX`'s result need to return the full property-tree dump every time, or
could it be more selective?), but no concrete fix proposed here.

### 5. Captured-frame images — real number, smaller than first estimated

Confirmed: **~985 tokens/capture average** (real observed deltas: 985, 932,
1099, 838, 1079, 1562, 1496, 1003 — consistent with Anthropic's
resolution-based image tokenization for the comp sizes captured, not a
byte-count estimate). An earlier bad estimate (~40,000 tokens/image) was
based on base64 byte count, which massively overstates real image token
cost — corrected. 17-19 captures/session ≈ 12-17K tokens total. Real, but a
minority contributor, not the dominant one originally assumed.

### 6. Model-switch cache invalidation (root cause 3) — confirmed, fires in both directions

Already flagged in the original investigation as "worth a separate look,
not necessarily broken." Now confirmed via the real transcript to fire in
**both directions**: a Scrooge downshift to a cheaper model triggers a full
rewrite (the $1.79/$1.81/$0.32/$1.24 rows), *and* a re-classification back
up to a more capable model does the same (verified directly: at the exact
call where a 23,532-token cache-creation spike appears, the model field
switches `claude-sonnet-5` → `claude-opus-5`). This was initially
misdiagnosed as a distinct "mid-turn steering interruption" bug — verified
against the real `model` field in the transcript and corrected: it's the
same root-cause-3 mechanism, not a new one.

The 100K size-gate (already shipped) only suppresses *downshifts* above
100K context — it does nothing about a re-classification pushing back
*up*, which pays the same rewrite cost regardless of direction.

**Open, not yet decided**: does the gate need to also suppress upshifts
above the same threshold, or is an upshift (paying more per-token but for a
turn that presumably needs the stronger model) an acceptable cost since it's
presumably rarer and the correctness need is real? Judgment call, not
resolved here.

### 7. The classifier's own cost is invisible in telemetry

Confirmed directly in both `chat-handler.js` and `telemetry.js` — an
existing code comment in both files says outright: *"classifierSpawned:
stage-2 haiku fired (its own token cost is not otherwise recorded)."*
Telemetry only counts a boolean fire-count, never the actual tokens/cost of
that haiku sub-call. Small in absolute terms, but a real, currently
unmeasured cost.

**Fix: record the classifier sub-call's actual usage, not just whether it
fired.**

### 8. "Clear chat" is cosmetic-only — real bug, already queued to `session-cost`

`ChatHandler` is a single long-lived singleton (`index.js:27`) for the
entire daemon process lifetime. `clearChat()` in the panel wipes the UI and
the panel's own local `currentSessionId`, but sends no distinct "start
fresh" signal to the daemon. The next message sends `sessionId: null`, and
`resolveSessionId(msg.sessionId, this.sessionId, ...)` falls back to the
daemon's still-held `this.sessionId` — so the very next message after
"Clear chat" silently resumes the exact same accumulated session, full
cache-read cost and all, while the user sees an empty chat window.

**Fix: the clear-chat message needs an explicit flag the daemon honors
unconditionally** (e.g. `newConversation: true`), rather than relying on an
absent/falsy id that's indistinguishable from "panel just hasn't loaded a
session yet."

### 9. `clear_tool_uses_20250919` (Anthropic context editing) — simulated against real data, makes cost *worse*

Investigated as a candidate fix for image/tool-result bloat once a direct
API migration was on the table. Verified against Anthropic's own docs first
(not a secondhand summary): it's server-side, deterministic, and does
genuinely reduce `input_tokens` — but it **invalidates the prompt cache at
the cleared point**, same as any mid-history edit, requiring a `clear_at_least`
gate sized to make each invalidation "worth it."

Simulated two configurations against the real 60-call chain from
`f0f7b223-*.jsonl` (unit cost = `cache_read×0.1 + cache_creation×1.25`,
real baseline 759,184 units):

- **Aggressive** (trigger=10K, keep=3, clear_at_least=2K): fires 8/60 calls,
  each firing rewrites the *entire* ~100K+ prefix to reclaim only 1-3K
  tokens. **+123.5% cost.**
- **Conservative** (trigger=50K, keep=5, clear_at_least=15K): fires once,
  near the end, same full-prefix rewrite to reclaim ~15-17K. **+16.3% cost.**

**Verdict: not a fix for Gaffer's workload, at any threshold tried.** The
mechanism only clears tool_use/tool_result content, but (per finding #4)
that's a minority share of what's actually growing — every firing pays the
full rewrite penalty against the *whole* prefix regardless of how little it
reclaims. No tuning found that makes this net-positive for this workload.

## Ranked recommendations

1. **`--strict-mcp-config`** — free, zero risk, do regardless of anything
   else. (Already known, still #1.)
2. **Reuse the leading model for compaction's summarizer** — free, removes
   one avoidable multiplier on top of the (unavoidable) cold-restart tax.
3. **Record the classifier's real usage in telemetry** — small, but closes
   a real blind spot.
4. **Fix "Clear chat"** — already queued, not a cost-*driver* fix but a
   correctness one with real cost side-effects.
5. **Reconsider whether the 100K size-gate should also cover upshifts**,
   given root cause 3 now confirmed to fire both directions — open decision,
   not yet resolved.
6. **Do not pursue `clear_tool_uses_20250919`** for this workload — tested,
   makes things worse.
7. **Model/effort defaults and the `MUTATE` regex** (from the parallel
   investigation, not re-litigated in depth here): Opus/medium as the
   default for mechanical authoring tasks is a deliberate, reasoned
   tradeoff (false-"complex" is the safe error), not a bug — a real
   judgment call on risk vs. savings, not something to silently change.

## Not resolved here, still open

- Whether compaction frequency under the new 500K/800K thresholds will make
  the ~31K cold-restart tax a meaningful recurring cost in practice, or a
  rare one — depends on real usage patterns not yet measured post-fix.
- The upshift-gate question in #6 above.
- Whether `runJSX`'s result payload size (finding #4) is itself reducible
  without losing functionality — not investigated.
