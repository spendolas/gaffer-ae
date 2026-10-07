# Claude Lookup and CLI Contract Implementation Plan (v0.11.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Let Gaffer run on the Claude desktop app's bundled Claude Code (Mac and Windows) or a standalone CLI, never break on Claude Code message rewording, and tell users how to install Claude when neither exists.

**Architecture:** (1) A pure `cli-contract.js` classifies every chat turn from structured fields first, text second, and `chat-handler.js` uses it. (2) `claude-binary.js` gets a new priority order, a Mac desktop-app scan, pin modes, a health check and install links. (3) Panel copy, README install step, CHANGELOG and version bump.

**Tech Stack:** Node ESM daemon, `node --test`, plain ES5-style JS in the daemon (match surrounding style: `var`, `function`).

**Design inputs (read before starting):**
- `/private/tmp/claude-501/-Volumes-Origami-Users-spendolas-Library-CloudStorage-Dropbox-Tools-AE-Tools-Gaffer/1910bfc5-4a96-4619-8b6f-3bbfb17d82d1/scratchpad/cli-drift-design.md` (evidence and the `cli-contract.js` sketch, sections 1, 2, 3 D1 and D4)
- Fixtures already copied to `panel/daemon/test/fixtures/cli/` (`ok|resume|big|badmodel` x `236|289`, each `.jsonl` + `.stderr.txt`)

## Global Constraints

- No em or en dashes in any user-facing copy (UI strings, error messages, CHANGELOG, README prose). Comments exempt.
- Windows: every child process uses `windowsHide: true`. `.ps1` files not touched in this plan.
- Never change flags or spawn arguments of the chat turn in this release (no flag probing).
- Branch `feat/claude-lookup-v0112` sits on top of the unreleased v0.11.1 commits (`311e91d`, `8b195a1`). `panel/version.json` is currently `0.11.1`; this plan bumps to `0.11.2` and leaves the legacy `commit` field untouched (`401c1ec`).
- Do NOT push, tag, or run `gh`. Commits only, on this branch.
- Binary priority (decided by the owner): pinned `claudeBin` first; then the Claude desktop app's copy (newest version first); then standalone CLI (known locations, PATH, login shell); then error. The CLI-first alternative was reviewed and rejected by the owner: designers often have no CLI, and the app copy updates itself.
- Pin modes: `config.claudeBin` may be `"app"`, `"cli"`, or an explicit path (legacy, still accepted).
- Desktop app install link: `https://claude.com/download` (verified HTTP 200). CLI install link: `https://claude.ai/code` (existing link, keep).
- Daemon chat messages must never be silently swallowed: an unrecognized failure reaches the panel with the CLI's own text.

## Review Focus

- Old-layout and standalone-CLI Windows/Mac users still resolve a working binary (no regression).
- A failed/zero-byte/dir candidate (`claude.app` directory, broken exe) is skipped, not returned.
- A normal Claude reply containing "context" and "length" must not reset the session.
- Error results (signed out, bad model, too long) never render as normal replies, and never save the dead session id.
- A process that exits without a `result` event never produces an empty bubble.
- Shell alias text (`alias claude=...`) from the login-shell step must never be treated as a path.

---

### Task 1: `cli-contract.js` classifier and fixture tests

**Files:**
- Create: `panel/daemon/cli-contract.js`
- Create: `panel/daemon/test/cli-contract.test.mjs`
- Fixtures (already present): `panel/daemon/test/fixtures/cli/*`

**Interfaces:**
- Produces (used by Task 2):
  - `newTurnState(resuming: boolean) -> state`
  - `observe(state, event) -> void` (never throws on any object input)
  - `classify(state, exitCode: number|null, stderr: string) -> { kind, via, text?, status?, reason? }` where `kind` is one of `ok | stale_session | too_long | auth | model | api_error | unknown_error` and `via` one of `structure | text | none`
  - `userMessage(verdict) -> string` friendly panel copy per kind (no dashes; `auth` tells the user to use Gaffer's Sign in, never "/login"; `api_error` and `unknown_error` include the CLI's own text trimmed to 400 chars; empty text gets a generic sentence)
  - `LAST_VERIFIED = { min: '2.1.236', max: '2.1.289' }` (exported constant only, unused in this release)

- [ ] **Step 1: Write failing tests** `cli-contract.test.mjs` replaying each fixture (parse `.jsonl` line by line into `observe`, read `.stderr.txt`, exit code 0 for `ok-*`, 1 otherwise, `resuming` true only for `resume-*`):
  - `ok-236`, `ok-289`: `kind ok`, `st.cliVersion` set from init (`claude_code_version`)
  - `resume-*`: `stale_session`, `via structure`; same fixture with the stderr and `errors` text replaced by a reworded string: still `stale_session` via structure (structure does not need text); with structure blocked (set `num_turns: 1`) and text "No conversation found": `stale_session`, `via text`
  - `big-*`: `too_long`, `via structure` (`terminal_reason prompt_too_long`)
  - `badmodel-*`: `model`, `via structure`
  - synthetic: success result (`is_error: false`) whose `result` text contains "match the comp context, so its length is now 5s" and "prompt is too long": `ok`
  - synthetic: events `system/init` then no result, exit 1, stderr "boom": `unknown_error`, text includes "boom"; same with empty stderr: text mentions the exit code
  - synthetic: unknown event types and an unknown `terminal_reason`, `errors` as `{code,message}` objects: no throw, `api_error` with that text
  - synthetic: assistant event with `error: 'authentication_failed'` plus an `is_error` result: `auth`, and `userMessage` contains "Sign in" and not "/login"
  - `userMessage` contains no `–` or `—` for every kind
- [ ] **Step 2:** `cd panel/daemon && node --test test/cli-contract.test.mjs` and confirm it fails (module missing)
- [ ] **Step 3: Implement `cli-contract.js`** following the sketch in design doc section 3 D1 (`KNOWN_TYPES` = `system, assistant, user, result, rate_limit_event, stream_event`); record `st.assistantApiError = true` when an assistant event has `is_api_error_message`; text fallback only on failed turns
- [ ] **Step 4:** run the new test file plus the full suite `cd panel/daemon && node --test`; all green
- [ ] **Step 5: Commit** `feat(daemon): classify chat turns from structured CLI fields` (fixtures included)

---

### Task 2: Wire the classifier into `chat-handler.js`

**Files:**
- Modify: `panel/daemon/chat-handler.js` (spawn/stream/close region around lines 900-1120, plus `_processEvent`)
- Create: `panel/daemon/test/chat-handler-contract.test.mjs`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: no new exports. Behavior changes below.

Required changes (read the surrounding code first; keep today's behavior wherever not listed):
- [ ] Create a turn state with `newTurnState(!!resumeId)` per spawn; call `observe` for every parsed event before existing handling.
- [ ] Do not adopt or persist `result.session_id` when `result.is_error` is true.
- [ ] Send `chat_result` only when `result.is_error !== true`. On an error result, defer to the close handler (below) so exactly one outcome is sent.
- [ ] Remove the `/context.*length/i` check, the dead `error_max_tokens` check, and the anchored `^prompt is too long` assistant-text check. Do not stream assistant text blocks whose event has `is_api_error_message: true` into the bubble.
- [ ] On process close (not cancelled), call `classify` once and act: `ok` unchanged; `stale_session` keeps today's retry-once with a fresh session; `too_long` keeps today's overflow reset and message; `auth`, `model`, `api_error`, `unknown_error` send the existing chat error message type with `userMessage(verdict)`; `auth` also re-pushes the auth status the way sign-in state is refreshed elsewhere (find the existing call; if none is cheap to reuse, skip and note it).
- [ ] Replace the `sawOutput` guard with `st.sawResult`: process closed without a `result` event and not cancelled becomes an error via `classify` (never an empty bubble).
- [ ] Split the stdout `try/catch`: JSON parse failures are ignored (log first 200 chars once per turn); exceptions inside event handling are logged with the event type and do not kill the turn.
- [ ] One log line per turn: `Gaffer chat: turn=<kind> via=<structure|text|none> cli=<version|unknown> exit=<code>`; additionally a one-time `Gaffer chat spawn: cli=<version>` is NOT needed (version arrives from init).
- [ ] Tests (fake child process and fake socket; look at existing chat-handler tests for the harness pattern and reuse it): replay `ok-289` (one chat_result, session adopted), `resume-289` (retry once, dead id not saved), `big-289` (overflow reset message, CLI error text not in any chunk), `badmodel-289` (error message, no chat_result, session not adopted), the "context length" success reply (session kept), and init-then-exit-1-no-result (error message sent, not empty).
- [ ] Run full daemon suite, then commit `fix(daemon): read chat failures from structured CLI fields, never show errors as replies`

---

### Task 3: New Claude lookup order, pin modes, health check, install links

**Files:**
- Modify: `panel/daemon/claude-binary.js`
- Modify: `panel/daemon/test/claude-binary-desktop.test.mjs` (extend) and create `panel/daemon/test/claude-binary-order.test.mjs`
- Modify: `panel/daemon/index.js` only if the not-found error handling there needs the new links (check how `claudeAvailable` and the panel message are produced)

**Interfaces:**
- Consumes: existing `desktopAppCandidates(appData)`, `formatNotFoundMessage(diag, configPath)`, `win32ClaudeCandidates(env)`.
- Produces (exported, pure/injectable for tests):
  - `macDesktopAppCandidates(home)`: for each version folder (numeric newest first, reuse `desktopAppVersions`-style logic against `<home>/Library/Application Support/Claude/claude-code`), per `<hash>` folder (and direct, and deeper levels, same capped scan as Windows), the path `<dir>/claude.app/Contents/MacOS/claude`.
  - `resolveOrder(opts) -> candidate list` or an equivalent injectable structure so the priority order is unit-testable without real binaries: opts `{ platform, env, config, fsAccess, run }`. Keep it simple; the point is the order is asserted in a test.
  - `INSTALL_LINKS = { desktop: 'https://claude.com/download', cli: 'https://claude.ai/code' }`
  - `findClaudeBinary()` keeps its signature (async, returns a path string, throws on not found).

Required behavior:
- [ ] Order: (1) config pin; (2) desktop app candidates (win32: `desktopAppCandidates(APPDATA)`; darwin: `macDesktopAppCandidates(HOME)`; linux: none); (3) standalone: win32 `win32ClaudeCandidates()`, others the four known paths; then PATH lookup, then login shell (non-Windows).
- [ ] Pin modes: `claudeBin === 'app'` restricts to step 2 candidates; `'cli'` restricts to step 3; any other string is a path (legacy). A pin that cannot be satisfied is logged (`Gaffer: pinned claudeBin <value> not usable, falling back to automatic lookup`) and lookup continues automatically. Never silent.
- [ ] Health check: a candidate is accepted only if it is a regular file (`statSync(...).isFile()`; `claude.app` directory must never pass), executable, and `execFile(path, ['--version'], { timeout: 5000, windowsHide: true })` succeeds with stdout matching `/^\d+\.\d+\.\d+/`. Failure: skip, log one line naming the path and reason. Only the winning candidate is spawned, in order (no comparing versions). Cache the winner and its version string; log `Gaffer: claude found (<step>): <path> (<version>)`.
- [ ] PATH lookup gets a 5000 ms timeout. Login-shell step: ignore any result that does not look like an absolute path (fixes `alias claude=...` text being returned as a path).
- [ ] Not found: throw `formatNotFoundMessage(...)` whose tail now says to install the Claude desktop app from `INSTALL_LINKS.desktop` or the CLI from `INSTALL_LINKS.cli`, keeping the config-file escape hatch; still no dashes. Update existing message tests.
- [ ] Tests: order (pin beats app beats cli, with fake fs/exec); pin modes `app`, `cli`, path, unusable pin falls through with log; directory and non-matching `--version` skipped; alias-text login shell result ignored; Mac scan ordering/hash layout with a real temp tree; Windows tests from v0.11.1 still pass.
- [ ] Run full daemon suite; commit `feat(daemon): use the Claude desktop app's Claude Code first, then the standalone CLI`

---

### Task 4: Panel copy, README install step, CHANGELOG, version bump

**Files:**
- Modify: `panel/main.js` (the `showNoCliModal` copy near line 1405 and its `openClaudeCodeDocs` target; check where else "Claude Code CLI" is user-facing, e.g. auth card empty states, and keep wording consistent)
- Modify: `README.md` (install step 6 and the troubleshooting bullet about `claude cli not found`)
- Modify: `CHANGELOG.md`, `panel/version.json`
- Maybe modify: `panel/prompts/gaffer.md` is NOT touched.

- [ ] Panel no-Claude modal: copy (no dashes) like "Gaffer needs Claude to work. Install the Claude desktop app or Claude Code, then reopen this panel." with two actions: "Get Claude app" opening `https://claude.com/download` and "Get Claude Code" opening `https://claude.ai/code`. Reuse how `openClaudeCodeDocs` opens URLs (CEP `openURLInDefaultBrowser`); if the modal only supports one button, make the primary button the desktop app and add a secondary text link for the CLI using the existing modal facilities; if that needs new markup/styling, keep it minimal and report it. Do not change Figma-parity-sensitive styles beyond what is needed.
- [ ] README step 6 rewritten for the installing Claude: detect (a) the desktop-app copy (mac `~/Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude`, win `%APPDATA%\Claude\claude-code\...\claude.exe`, newest) and (b) a standalone CLI (`command -v claude` / `Get-Command claude`, real `.exe` only on Windows). Rules: only one found, do not pin, the daemon finds it; both found, show both paths and versions (`<path> --version`), explain the app copy updates itself and the CLI is whatever the user installed, ask which, then merge `claudeBin` = `"app"` or `"cli"` into `config.json` with the existing merge-never-overwrite snippets (adapt them: mode strings, not paths); neither found, give both install links and stop until the user installs one. Never pin a version-specific desktop-app path. Update the troubleshooting bullet: mention both install options and the `"app"`/`"cli"`/path values.
- [ ] CHANGELOG `## v0.11.2 - 2026-10-07`: plain-language bullets (no dashes): Gaffer now works with the Claude desktop app alone, no separate CLI install needed (Mac and Windows); it prefers the desktop app's Claude Code and falls back to a standalone CLI; clearer install instructions when neither is found; chat errors (signed out, model unavailable, conversation too long) now show as proper errors instead of odd replies; fixed a bug where a normal answer mentioning context length could reset the conversation; chat no longer ends with an empty bubble when Claude stops unexpectedly. Keep the existing `## v0.11.1` entry below it, unchanged.
- [ ] `panel/version.json`: `version` `0.11.1` -> `0.11.2`, `commit` untouched.
- [ ] Run: `cd panel/daemon && node --test`, `node scripts/release-gate.mjs` (expect `v0.11.2 -> create`, it may need `--help`/env; follow how earlier tasks ran it, see the local ledger), root-level script tests (`ls scripts/*.test.* scripts/test-*` and run what exists), and `node --check panel/main.js`.
- [ ] Commit `release: v0.11.2 - works with the Claude desktop app, sturdier chat errors`
