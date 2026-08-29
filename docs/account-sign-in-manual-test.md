# Account Sign-In — Manual Verification (the deploy gate)

**Branch:** `feat/account-sign-in`
**Status when this was written:** everything automatable is GREEN — daemon unit suite 14/14 (`node --test panel/daemon/test/`), the CDP panel state-machine test PASSES (`node scripts/test-panel-auth.mjs`), and the whole-branch code review is clean. The one thing left is this manual OAuth happy-path, which can't be scripted (real browser + human approval).

**DO NOT push `feat/account-sign-in` to `main` until this passes.** Pushing `main` releases to all installed panels (the auto-update check keys on `version.json`), so this gate is non-negotiable.

---

## Prerequisites

1. **Gaffer panel open in After Effects.**
2. **The daemon must be running the NEW branch code.** The daemon that runs during normal use may predate this feature (it won't handle the new `auth_status` / `sign_in` messages). To restart it onto current code:
   - Find it: `pgrep -fl "gaffer-daemon|daemon/index.js"`
   - Kill it: `pkill -f "gaffer-daemon|daemon/index.js"`
   - Reload the Gaffer panel in AE — it auto-respawns the daemon from `panel/daemon/index.js` (the new code). Confirm in `/tmp/gaffer-daemon.log`.
   - (Or run it in the foreground for live logs: `cd panel/daemon && node index.js`.)

## The test

1. **Sign out the CLI** (so the panel starts from a signed-out state): `claude auth logout`. Verify: `claude auth status --json` → `"loggedIn": false`.
2. **Reload the Gaffer panel.** Expected: the whole-panel **sign-in card** appears; the chat input and send are disabled.
3. **Click "Sign in with Claude."** Expected: a browser window opens for the Claude OAuth flow (`claude auth login --claudeai`, spawned by the daemon). The panel shows "Complete sign-in in your browser…" with a **Cancel**.
4. **Complete sign-in in the browser.** Expected: within ~2s of finishing, the card dismisses, chat enables, and the **account chip** in the "More" drawer shows `email · org · plan`.
5. **(Optional) Console path:** sign out again, reload, click **"Use Anthropic Console"** — expect the same flow via `--console`.
6. **Sign out from the panel:** open "More", click **Sign out** on the account chip. Expected: the sign-in card returns.

## The one open design question this run settles (deferred review item #2)

The whole design pivots on **how `claude auth login` behaves when spawned by the daemon (no TTY):**

- **If it opens the browser and, on completion, saves credentials and exits 0** → the happy path above works end-to-end and #2 is a non-issue. Close #2 as "not needed."
- **If instead the browser never opens, or the panel shows "Sign-in failed" while the browser flow is still incomplete, or `claude auth login` exits immediately** → the login needed a TTY, and the **guided-fallback** (surface the login URL / command for manual completion; keep polling `auth status`) must be implemented before shipping — OR the spec re-scoped to defer it. `signIn()` already computes a `degraded` flag for this case; it's just not surfaced yet (`index.js` drops it; `sign_in_started` carries no URL).

**Record exactly what happened at step 3–4** — that observation is the deciding input.

## If the test passes → release steps

1. Restore the release hook: `mv .git/hooks/post-commit.sdd-disabled .git/hooks/post-commit`
2. Bump `panel/version.json` `version` `0.6.1` → `0.6.2`; add a `CHANGELOG.md` entry.
3. Commit (the restored hook stamps the commit hash into `version.json`).
4. Merge `feat/account-sign-in` → `main` and push. The update banner then offers `0.6.2` to installs.

## Note on the disabled hook

During the subagent build the post-commit hook (which auto-stamps `version.json` on every commit) was renamed to `.git/hooks/post-commit.sdd-disabled` so per-commit stamping wouldn't churn `version.json` or drift the SHAs. It stays disabled until the release step above restores it. If you abandon the branch, restore it too.
