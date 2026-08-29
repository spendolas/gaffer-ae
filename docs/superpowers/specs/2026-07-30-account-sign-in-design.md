# Account Sign-In — Design Spec

**Date:** 2026-07-30
**Status:** Approved design, pending implementation
**Feature:** Let a user sign in to their Claude account from within the Gaffer panel (Hub/VS-Code-style), instead of having to authenticate the Claude CLI out of band.

## Deploy gate (non-negotiable)

**This feature must NOT be pushed to `main` / released until tests confirm the flow actually works** — the state machine under test plus at least one manual happy-path OAuth verification. Local commits are fine; the `git push` that triggers the end-user update banner is gated on passing verification.

## Problem

Gaffer spawns `claude -p …` and assumes the CLI is already authenticated. A user who has not run `claude auth login` (or set an API key) elsewhere gets an opaque `chat_error` from stderr with no path forward. We want an in-panel sign-in.

## Verified CLI facts (installed: Claude Code v2.1.212)

- **`claude auth status --json`** → read-only, cross-platform (works with the macOS Keychain). Shape:
  ```json
  { "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
    "email": "…", "orgId": "…", "orgName": "…", "subscriptionType": "team" }
  ```
- **`claude auth login`** — "Sign in to your Anthropic account". Flags: `--claudeai` (subscription, default), `--console` (Anthropic Console / API billing), `--email <email>`, `--sso`. Opens the browser and **auto-saves credentials** (Keychain / `~/.claude/.credentials.json`); later `claude -p` spawns pick them up. Gaffer never handles a token.
- **`claude auth logout`** — signs out.
- **Uncertainty (untestable here — this machine is already logged in):** whether `claude auth login` needs a TTY when spawned by the daemon. The design is deliberately robust to both outcomes (see §Login-driving mechanism).

## Scope

- Login methods exposed: **Subscription** (`--claudeai`, primary) **+ Console** (`--console`, secondary). SSO deferred.
- No token storage or handling by Gaffer — the CLI owns credentials.

## Components

### Daemon — new `auth.js` module (keeps `chat-handler.js` from growing further)
- `authStatus()` → runs `claude auth status --json`; returns `{ loggedIn, authMethod, email, orgName, subscriptionType }`. On failure/parse error → `{ loggedIn: null }` (**indeterminate — never used to lock a user out**).
- `signIn(mode)` — `mode ∈ {'claudeai','console'}` → spawns `claude auth login --claudeai|--console`, then polls `authStatus()` (~2s interval, 5-min cap) until `loggedIn:true`. Returns final status.
- `signOut()` → `claude auth logout`.
- `cancelSignIn()` → kills the in-flight login child and stops the poll.

### Panel
- **Sign-in card** — a whole-panel takeover when signed out (a signed-out user can't chat or use any control, so the card overlays the entire panel — anchored to `body`; decision 2026-07-31). Two buttons: **"Sign in with Claude"** (subscription) and **"Use Anthropic Console"** (API billing). In-progress state: "Complete sign-in in your browser…" + spinner + **Cancel**, plus the login URL with a copy button if the CLI printed one.
- **Account chip + Sign out** — in the "More" drawer once signed in; shows `email · orgName · subscriptionType` from `auth status`.

## Protocol (new WS messages; matches existing typed set)

- Panel→daemon: `auth_status` (request), `sign_in {mode}`, `sign_out`, `cancel_sign_in`
- Daemon→panel: `auth_status {loggedIn, email, orgName, plan, authMethod}`, `sign_in_started {url?}`, `sign_in_done {ok, error?}`

## Data flow

1. **Detect** — on WS connect, panel sends `auth_status`; daemon replies.
   - `loggedIn:false` → show sign-in card, chat disabled.
   - `loggedIn:true` → normal; account chip in drawer.
   - `loggedIn:null` (indeterminate) → **do not block**; let chat proceed (preserves today's behavior).
2. **Sign in** — button → `sign_in{mode}` → daemon spawns `claude auth login` (browser opens) → `sign_in_started{url?}` → daemon polls `auth status` until `loggedIn` (or 5-min timeout) → `sign_in_done{ok:true}` + fresh `auth_status` → card dismisses, chat enables.
3. **Sign out / expiry** — `sign_out` → logout → card returns. If a later `claude -p` chat fails with an auth error (login expired mid-session), daemon re-checks `auth status` and, if now signed out, surfaces the card.

## Login-driving mechanism (the one real risk)

Plain `spawn` of `claude auth login` — **no PTY dependency, no token handling**. The browser→localhost OAuth callback saves credentials independent of the terminal. **If** the child exits without success (i.e. it genuinely required a TTY), the daemon **degrades gracefully to "guided" mode**: it surfaces the login URL/command for the user to complete manually, rather than hard-failing. Dependency-free and robust to the TTY uncertainty.

## Chat gating

Input enable becomes `wsConnected && authLoggedIn !== false`. Indeterminate (`null`) does not lock out.

## Error handling

- Login child errors / 5-min timeout → `sign_in_done{ok:false, error}` → panel shows error + retry.
- Cancel → kill child + stop poll → back to signed-out card.
- `auth status` unparseable → `loggedIn:null` → do not block.
- Mid-session auth error from `claude -p` → re-check status → surface card only on a definitive `loggedIn:false`.

## Security

Gaffer only ever invokes `claude auth {login,logout,status}`. It never sees, stores, or logs a credential or token — the CLI owns the credential store (Keychain / `.credentials.json`).

## Testing plan (gates the deploy)

Automated (CLI mocked via a stub `claude` on PATH / injected binary path):
- `authStatus()` parses valid JSON; returns `loggedIn:null` on non-JSON / non-zero exit.
- Signed-out status → panel shows the card and disables chat.
- `signIn('claudeai')` / `signIn('console')` invoke the correct `auth login` flag.
- Poll loop: resolves on `loggedIn:true`; times out at the cap; `cancelSignIn()` stops it and kills the child.
- Chat gating: input disabled iff `authLoggedIn === false`.
- Graceful-degradation branch: child exit without success → guided fallback emitted (not a hard error).

Manual (once, cannot be scripted — needs a signed-out account + real browser):
- Real `--claudeai` happy path end to end: card → browser → poll → chat enabled.

**Only after the automated suite passes and the manual happy path is confirmed does the feature get pushed.**

## Out of scope

- SSO login (`--sso`).
- Any token capture/storage (`setup-token` path rejected).
- Per-MCP-server OAuth (already exists via `claude mcp login`; untouched).
