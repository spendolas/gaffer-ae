# Token optimization — design

**Branch:** `feat/token-optimization`
**Date:** 2026-08-24
**Status:** approved, pre-implementation

## Why

Gaffer panel chat replays the entire session transcript on every turn (via
`claude -p --resume`). The transcript grows without bound, so per-turn input
tokens climb across a session. This branch cuts that growth at its measured
source.

Prior art: Claude Hub did the same work (`session-pruner.js`, design
`2026-08-07-session-context-pruner-design.md`). The **method** transfers; the
numbers do not. Everything below is downstream of measuring Gaffer's own
sessions — not of porting Hub's conclusions.

## Measurement (Phase 0 — done before any design)

Analyzer: throwaway `analyze-session.mjs`, grouped one real panel session by
content type, splitting API-bound (`message.content` blocks, replayed every
turn) from local bookkeeping (`toolUseResult`, `cwd`, uuids — never sent).

Session `35253671-…` (real panel chat, daemon cwd → `…-panel-daemon`
project dir), 1801 lines:

| | size | share |
|---|---|---|
| Disk total | 18.03 MB | |
| — bookkeeping (never sent) | 9.58 MB | 53% of disk |
| — **API-bound** (replayed every turn) | **8.45 MB** | 47% of disk |

API-bound broken down by block type:

| block type | size | share of API-bound |
|---|---|---|
| `user:tool_result` | 7.46 MB | **88.2%** |
| `assistant:thinking` | 0.67 MB | 7.9% |
| `assistant:tool_use` | 0.25 MB | 2.9% |
| `assistant:text` | 0.07 MB | 0.9% |
| `user:text` (human messages) | ~0 | 0.0% |

`tool_result` by tool:

| tool | size | share | calls |
|---|---|---|---|
| **`Read`** | **7.24 MB** | **85.6%** | 60× (of which img 7.23 MB) |
| everything else combined | <0.15 MB | <1.8% | — |

**Finding:** the majority category is **image blocks inside `Read` tool_results
— 85.6% of API-bound, 59 PNG blocks.** All 59 are files on disk:

- `gaffer-frame-*.png`, `gaffer-paste-*.png` in `/var/folders/.../T/` — AE frame
  captures. `captureFrame` returns a *path*; the agent then `Read`s it, and
  *that* inlines ~122 KB of base64 which is replayed on every subsequent turn.
- `/tmp/figma-spinner-*.png`, `/tmp/light-v*.png`, `/tmp/ae-*.png` — comparison
  / reference frames, same mechanism.

Every one is re-derivable — re-`Read` (or re-`captureFrame`) is one tool call
away. Identical shape to Hub's PDFs, identical ~85% share.

**Mechanism nuance vs the porting notes:** the cost is `Read`-of-PNG, *not*
`captureFrame` returning inline (its results are 0.3%). So the pruner keys on
`image` blocks in *any* tool_result, tool-agnostic — not on a Gaffer tool name.

### Real serialized shapes (enumerated from data, not inferred)

Line (transcript entry) top-level keys:
`parentUuid, isSidechain, promptId, type, message, uuid, timestamp,
toolUseResult, sourceToolAssistantUUID, userType, entrypoint, cwd, sessionId,
version, gitBranch`.

- `message` = `{ role, content }`.
- tool_result block = `{ tool_use_id, type:'tool_result', content:[…] }`.
- image block = `{ type:'image', source:{ type:'base64', media_type:'image/png',
  data:'<base64>' } }`, sitting inside `tool_result.content[]`.
- path recoverable: `tool_use_id` → the assistant `tool_use` block's
  `input.file_path`.

## Design

Three levers. **A** is the measured core and is isolated from **B**/**C** so a
weak lever can be dropped without touching it.

### A. Session-pruner (measured 86% core) — always on

**New module:** `panel/daemon/session-pruner.js`.

**Trigger:** called from `chat-handler.js` in `child.on('close')` — after the
turn's process has exited, before the next `--resume`. Only window with no live
process holding the file. Gated by a size floor (skip if API-bound < 512 KB).

**Detect:** walk `message.content[]`. Heavy block = `image` block in either:
1. inside a `tool_result.content[]` array (measured 100% of cases), or
2. a bare inline `image` block (defensive; unseen but cheap).

**Recency window:** keep the most recent **K image blocks byte-for-byte**
(default `K = 6`, configurable), stub every older one. Preserves the current
visual-iteration context; kills the long tail replayed dozens of times.

**Stub in place (keep skeleton):** mutate the image block to
`{ type:'text', text:'[122 KB image/png elided by Gaffer — Read <path> again if
you need it, or re-run captureFrame]' }`, path resolved via `tool_use_id`. Same
index, same array, `tool_use_id` untouched → the API request stays structurally
valid (paired `tool_use`/`tool_result` preserved). Line count preserved exactly.

Wording names both recovery routes because `gaffer-frame-*`/`gaffer-paste-*`
live in macOS temp (`/var/folders/.../T/`), which the OS may purge — if the
file is gone, `captureFrame` regenerates it. (Moving captures to a stable cache
dir is a deliberate non-goal here — noted as follow-up.)

**Safe-apply (ported from Hub, non-negotiable — worst case is "nothing
happened"):**

- **Never throws.** Unreadable file, missing session, malformed line → return
  `null`. A pruner failure must never take down a turn.
- **Validate before swapping.** Every line that parsed going in must parse
  coming out; line count must match; else abandon the write.
- **`.bak` + temp-file + `rename`.** A crash mid-write cannot leave a
  half-written transcript.
- **Skip small files** (< 512 KB API-bound) and no-op runs.
- **Locate transcript by scanning** `~/.claude/projects/*/<id>.jsonl` for the
  UUID — never derive the dir from `cwd` (undocumented encoding, breaks on
  spaces; this repo's own path has one). Session ids are UUIDs → filename match
  is unambiguous.
- **One log line per run**, so the effect is observable:
  `[prune] <id> 8.4MB -> 1.2MB | imgs stubbed 53 kept 6`.

Malformed lines pass through verbatim rather than being "fixed".

**Note on disk vs API:** only `message.content` images cost API tokens. The
`toolUseResult` bookkeeping copy (part of the 53% never sent) is left alone for
API purposes; optionally stubbing it too is disk hygiene only and out of scope
unless trivial.

### B. Prompt conciseness lever — always on

Append a short directive to `panel/prompts/gaffer.md`: prefer concise prose,
don't narrate every intermediate step, and **don't re-`Read` an image already
in context**. Text blocks are <1% directly, but this reduces *new* image Reads,
which compounds with A. Zero risk.

### C. Dynamic model/effort — behind a toggle (default off)

Setting `autoModel` persisted in `.gaffer-config.json` (same store as the MCP
multiselect; never committed).

- **Off (default):** current behaviour — honor explicit `msg.model` / `msg.effort`.
- **On:** daemon applies a **conservative local heuristic** to the user message
  before spawn. Only *downshifts* when confident (short question; no
  build/animate/create/expression/keyframe verbs; follow-ups like "undo that",
  "what did you do"). Otherwise falls back to the user's model. **Never
  upshifts, never overrides an explicit non-default pick.**
- **No extra LLM router call** (would add latency + its own tokens). Pure local
  heuristic.
- **Every decision logged** (`[automodel] "…" -> haiku (trivial)`), because —
  unlike A — this lever is *unmeasured*. Logging is how it earns its place: we
  measure its real effect after shipping and drop it if it doesn't pay.

Honesty note: C mixes a price-lever (cost per token) with A/B's count-lever
(tokens per turn). It ships gated and logged specifically so it can't quietly
degrade quality on real (hard) AE tasks — a bad downshift makes the user redo
work, costing *more* tokens.

## Testing

TDD, Hub-parity rigor. Each test written and shown failing before its
implementation.

- **Rewriter unit tests:** each real block shape, *including the array-image
  `tool_result` case that burned Hub* (a pruner that silently prunes nothing is
  worse than none). Recency window keeps exactly K, stubs the rest. Path
  resolution via `tool_use_id`. Line count invariant.
- **File-layer tests:** `.bak` written; temp+rename atomicity; validation
  rejects a corrupting rewrite; small files skipped; scan-locate finds a UUID
  under a spaced path.
- **Integration test:** boot the pruner against a fixture transcript, resume the
  rewritten file (fake CLI + redirected HOME), confirm the model still recalls
  earlier context with the image bytes gone.
- **Heuristic (C) tests:** trivial messages downshift; build/expression messages
  do not; explicit non-default model is never overridden.

## Rollout

- A (pruner) + B (prompt) = default on.
- C (model lever) = toggle, default off.

## Rejected alternatives (per the data)

- **Strip `assistant:thinking`** — 7.9% ceiling, and it's the continuity-cheap
  category that makes a multi-turn task survivable. This is exactly the "chase
  the 2%" mistake the Hub notes warn against.
- **Summarise the conversation** — human + agent prose combined is <1%.
- **Stub `captureFrame` returns** — already tiny (0.3%); the cost is the `Read`,
  not the capture.
- **Scope MCP tool schemas per call** (Hub item #6) — a real lever, but its cost
  lives in the *request*, not the `.jsonl` transcript, so this measurement can't
  see it. Needs its own measurement first; separate branch.

## Files

- `panel/daemon/session-pruner.js` — new, the rewriter + safe-apply layer.
- `panel/daemon/chat-handler.js` — call the pruner in `child.on('close')`;
  read `autoModel`; apply heuristic when on.
- `panel/prompts/gaffer.md` — conciseness directive.
- `panel/main.js` + settings store — `autoModel` toggle (config-only, no new
  visible chrome beyond the existing settings surface).
- `test/session-pruner.test.mjs`, `test/session-pruner-file.test.mjs`,
  `test/pruner-integration.test.mjs`, `test/automodel.test.mjs` — new.
