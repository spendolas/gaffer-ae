# GitHub Releases distribution: design spec

**Date:** 2026-10-06
**Status:** Approved design, pending implementation
**Feature:** Ship installs and updates from GitHub Releases with uploaded assets instead of the `main` branch archive.

## Goal

1. Count installs and updates without Gaffer sending any data. Only uploaded release assets have a `download_count`; the auto-generated source archive has none.
2. Installs and updates come from a deliberate, tagged release, never from whatever is on `main` mid-work.
3. Cutting a release stays one push: bump `panel/version.json`, add a `CHANGELOG.md` entry, push. A gate ensures ordinary commits never release.

## Non-goals

- No compile or precompile step. Assets are plain archives of `panel/`; the daemon runs from source and `npm install --production` still runs on the user's machine.
- No code signing.
- No change to dev installs (git checkout): the updater stays disabled there.
- No change to telemetry. Counting uses public GitHub data only.

## Background

- **Install.** `README.md` step 3 (lines 64-77) downloads `archive/refs/heads/main.tar.gz` and extracts `gaffer-ae-main/panel` with `--strip-components=2`; Windows downloads `main.zip`, expands to `%TEMP%\gaffer-extract`, copies `gaffer-ae-main\panel\*`. `scripts/install-mac.sh` and `scripts/install-win.ps1` install from a local checkout and download nothing.
- **Update check.** `panel/main.js` `checkForUpdate()` (2588-2634) fetches `raw.githubusercontent.com/spendolas/gaffer-ae/main/panel/version.json` and reports "up to date" when `remote.commit === versionData.commit || !isNewerVersion(remote.version, versionData.version)` (2614).
- **Commit-keyed update state in `main.js`:** `dismissedUpdateCommit` / `availableUpdateCommit` (155-156), persisted into the chat-history payload (794) and restored (876-885); the `window.__gaffer.setUpdateAvailable(commit)` review seam (1976-1979, called by `design/scripts/panel-capture.mjs:278` with `'feedface'`); dev-install reset (2517); `loadVersion()` reconcile (2548) and post-update verdict comparing `versionData.commit` to `gafferUpdateAttempt.target` (2557-2569); `runUpdate()` storing `target: availableUpdateCommit` (2706-2709) and reloading as soon as the on-disk `commit` differs from `startCommit` (2716-2728); `dismissUpdate()` (2815-2823); `syncSettingsUpdateButton()` (3653-3664).
- **Update scripts.** `panel/daemon/update.sh` and `update.ps1` fetch main's `version.json` (`update.sh` 50-51 parses `commit` with `grep -o '"commit": *"[^"]*"'`; `update.ps1` 29-30 uses `Invoke-RestMethod ... .commit`), download the `main` archive, back up chat history and the legacy `.gaffer-config.json`, stop the daemon, sync with `rsync -a --delete` (excludes `chat-history.json`, `chat-history-*.json`, `.gaffer-config.json`, `daemon/node_modules`, `daemon/dist`) or `robocopy /E /PURGE /XF ... /XD node_modules dist`, restore, `npm install --production`, stop the daemon again, then stamp `version.json`. Both sync steps copy the archive's `version.json` early.
- **Daemon self-reload.** On end-user installs the daemon polls the raw content of `version.json` and exits when it changes (`panel/daemon/dev-reload.js` `readVersionSignature`, wired in `panel/daemon/index.js` 195-228). The panel then relaunches it.
- **Live bug.** `panel/version.json` has carried `"commit": "401c1ec"` on every release from v0.10.2 to v0.10.8, so the check above says "up to date" for every client on 0.10.2 or later. Auto-update is silently broken for them. Clients below 0.10.2 have a different commit and are still offered updates.
- **Commit stamping hook.** The amend-on-commit hook that used to write `commit` lives only at `.git/hooks/post-commit.sdd-disabled` in the owner's checkout. It is not tracked in the repo.
- **GitHub state.** No tags and no releases exist (`releases/latest` returns 404). Workflows: `.github/workflows/windows-tests.yml` (path-filtered Windows checks) and `traffic-snapshot.yml` (weekly, appends to `docs/traffic-snapshots.jsonl` with the `TRAFFIC_PAT` secret).
- **Panel tests.** `main.js` has no unit tests; it is a plain `<script>` in `panel/index.html` (line 1880). Panel-adjacent tests live in `panel/daemon/test/` and read panel files from disk (for example `input-overlay-order.test.mjs`).

## Design

### 1. Release workflow, `.github/workflows/release.yml`

**Triggers.** `push` to `main` with `paths: [panel/version.json]`. `workflow_dispatch` with input `dry_run` (boolean, default `true`).

**Workflow settings.** Top-level `permissions: contents: read`. `concurrency: { group: release, cancel-in-progress: false }`.

**Job `build`** (ubuntu-latest, `contents: read`). Checks out `github.sha` with `fetch-depth: 0` (tags needed), sets up Node 20, then:

1. Read `V` from `panel/version.json` with `jq -r .version`. Fail if empty.
2. Collect release state for `v$V` with `gh release view v$V --json isDraft,assets` (`GH_TOKEN: ${{ github.token }}`; treat "not found" as absent) and all tags with `git tag -l 'v*'`. A read-only token cannot see drafts; the publish job re-checks with a write token.
3. Run `node scripts/release-gate.mjs` with `V`, the tag list, the release state and `CHANGELOG.md`. It writes `action=skip|create|recover` to `$GITHUB_OUTPUT` and writes `notes.md`. Rules, in order:
   - Release `v$V` exists, is published and has all four assets: `skip`, exit 0. This also makes a push that only changes `commit` a no-op.
   - Release `v$V` exists (draft, or published with any asset missing): `recover`. The version check below is not applied.
   - Otherwise `V` must be strictly greater than every existing `v*` tag other than `v$V` itself, else fail. Comparison: numeric `major.minor.patch` first; when equal, a final release is greater than a prerelease, and two prereleases compare by suffix with `sort -V` semantics. (A plain `sort -V` sorts `0.11.0` before `0.11.0-beta`, which would block a final release after its beta.)
   - For `create` and `recover`: `CHANGELOG.md` must contain a line matching `^## v<V>( |$)` (V regex-escaped). Fail if missing. `notes.md` is that section's body: the lines after the heading up to, not including, the next line starting with `## `.
   - Result `create` when all checks pass.
4. If `action` is `skip` and this is not a dry run, stop here (remaining steps are conditioned on it).
5. `cd panel/daemon && npm ci && npm test`. `node scripts/check-ps-encoding.mjs`. `node --test scripts/release-gate.test.mjs`. Any failure fails the run.
6. Build, no compile:
   ```bash
   mkdir -p stage dist
   git archive HEAD:panel | tar -x -C stage          # panel/ contents at archive root, tracked files only
   jq -n --arg v "$V" --arg c "$GITHUB_SHA" '{version: $v, commit: $c}' > stage/version.json
   tar -czf dist/gaffer-install-mac.tar.gz -C stage .
   (cd stage && zip -qr ../dist/gaffer-install-win.zip .)
   cp dist/gaffer-install-mac.tar.gz dist/gaffer-update-mac.tar.gz
   cp dist/gaffer-install-win.zip   dist/gaffer-update-win.zip
   ```
   The packaged `version.json` has exactly the keys `version` and `commit`; `commit` is the full SHA of the pushed commit. Install and update assets are byte-identical per OS and differ only by filename, so `download_count` separates them.
7. Upload `dist/*` and `notes.md` with `actions/upload-artifact` (name `gaffer-release`). On a dry run this is the only output.

**Job `publish`** (`needs: build`, `permissions: contents: write`). Runs only when `github.ref == 'refs/heads/main'`, the run is not a dry run (`github.event_name == 'push' || inputs.dry_run == false`) and `action` is `create` or `recover`. Downloads the artifact, re-queries `gh release view v$V` with the write token (which sees drafts) and re-runs `release-gate.mjs` on that state, so a draft left by an earlier run is recovered instead of duplicated. Then:

- `create`: `gh release create v$V --draft --target $GITHUB_SHA --title v$V --notes-file notes.md [--prerelease] dist/*`, then `gh release edit v$V --draft=false`. A draft is invisible to `releases/latest` and creates no tag, so users never see a partial release.
- `recover`: `gh release upload v$V dist/* --clobber`; if the release is a draft, then `gh release edit v$V --draft=false`. No manual tag deletion is ever needed.
- `--prerelease` is passed when `V` contains `-` (for example `0.12.0-beta.1`).

A manual `workflow_dispatch` with `dry_run: false` on `main` is the retry path for a failed publish.

### 2. Clients

**README installer** (`README.md` step 3). macOS:
```bash
INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
mkdir -p "$INSTALL_DIR"
curl -sL https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-mac.tar.gz | tar -xz -C "$INSTALL_DIR"
```
Windows (PowerShell 5.1): `Invoke-WebRequest` `.../releases/latest/download/gaffer-install-win.zip` to `$env:TEMP\gaffer-install.zip`, `Expand-Archive` to `$env:TEMP\gaffer-extract`, `Copy-Item -Recurse -Force "$env:TEMP\gaffer-extract\*" $installDir`, remove both temp paths. No `gaffer-ae-main\panel` segment.

**Update scripts** (`panel/daemon/update.sh`, `update.ps1`). New order:

1. Dev-checkout refusal, unchanged.
2. Download `https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-update-mac.tar.gz` (Windows: `gaffer-update-win.zip`) into `$TMP_DIR`. Extract into the subfolder `$TMP_DIR/extract` (Windows `$tmpDir\extract`), never into `$TMP_DIR` itself, so the downloaded archive is never synced into the panel dir. Fail if `extract/version.json` or `extract/daemon/index.js` is missing.
3. Read `version` and `commit` from `extract/version.json` (same `grep` / `ConvertFrom-Json` style as today). No fetch of `raw.githubusercontent.com`.
4. Back up chat history and `.gaffer-config.json`, stop the daemon: unchanged.
5. Sync from `extract/` with every existing exclude plus the panel-root `version.json`: rsync `--exclude '/version.json'` (stays non-`--inplace`); robocopy `/XF ... version.json` (the only tracked `version.json`; `node_modules` is already `/XD`).
6. Restore, `npm install --production`, final daemon stop: unchanged.
7. Last step: copy `extract/version.json` to `version.json.tmp` in the panel dir and rename it over `version.json` (`mv` / `Move-Item -Force`). Then clean up and print `ok:<version>`.

Writing `version.json` last matters because the panel reloads, and the daemon self-restarts, as soon as that file changes. Syncing it early would reload the panel and boot a daemon on a half-updated tree.

**Panel update check** (`panel/main.js`, logic in a new `panel/update-state.js`):

- `checkForUpdate()` fetches `https://api.github.com/repos/spendolas/gaffer-ae/releases/latest` with `cache: 'no-store'` and header `Accept: application/vnd.github+json`. (api.github.com answers with `access-control-allow-origin: *`; release-asset downloads redirect to `release-assets.githubusercontent.com` without that header, so the panel never fetches assets.)
- ETag: localStorage key `gafferReleaseCache` holds `{ etag, version, commit, hasAsset }`. Send `If-None-Match: <etag>` when present. On 304 use the cached fields. On 200 parse `tag_name` (strip a leading `v`) as `version`, `target_commitish` as the display commit, `hasAsset` = `assets` contains `gaffer-update-mac.tar.gz` (macOS) or `gaffer-update-win.zip` (Windows), and store the new ETag.
- 403, 429 and 404 mean "no update info": leave the current banner and CTA state as is and do not call `markUpdateChecked()`. A manual "Check now" shows a neutral modal, "Could not check for updates right now, try again later.", never "Update check failed". Other failures keep today's behavior.
- Decision: an update is available when `hasAsset && isNewerVersion(remote.version, versionData.version)`. The commit decides nothing. "Up to date" shows `v<version>`. "Local version unknown" now triggers on a missing `versionData.version`.
- Re-key all update state to the version string: `availableUpdateCommit` → `availableUpdateVersion`; `dismissedUpdateCommit` → `dismissedUpdateVersion` (persisted under the new key; the old key is ignored on load); `gafferUpdateAttempt.target` stores the version and the post-update verdict compares `versionData.version`; `loadVersion()` reconcile compares versions; `syncSettingsUpdateButton()` shows the CTA when `availableUpdateVersion && isNewerVersion(availableUpdateVersion, versionData.version) && !window.__gafferUpdating`; `runUpdate()`'s poll reloads when the on-disk `version` differs from the version at start; `setUpdateAvailable(version)` takes a version, and `design/scripts/panel-capture.mjs` passes `'99.0.0'` instead of `'feedface'`. The commit stays only as the label in `loadVersion()`.
- `panel/update-state.js` holds the pure functions (`isNewerVersion`, `parseRelease(json, os)`, `decideUpdate(remote, local, dismissed)`, `shouldReloadAfterUpdate(startVersion, diskJson)`, `updateVerdict(attempt, localVersion, now)`), assigns them to `window.GafferUpdateState`, and is loaded by a `<script>` tag before `main.js`. ES5 style to match `main.js`.

**Dev installs.** Unchanged: `detectDevInstall()` still disables the updater.

### 3. Counting

Extend `traffic-snapshot.yml`'s fetch step: `gh api --paginate "repos/${{ github.repository }}/releases?per_page=100" | jq -s add` and add to each snapshot line a `releases` field (`[{tag, prerelease, assets: [{name, download_count}]}]`) plus `installs` (sum of `download_count` over assets named `gaffer-install-*`) and `updates` (same for `gaffer-update-*`). The releases endpoint is public; it runs under the existing `GH_TOKEN` only because the step already sets it.

Counts are eventually consistent and include retries, HEAD requests and CDN noise, and `releases/latest/download` goes through two redirect hops. Only week-over-week deltas are meaningful.

### 4. Docs and cleanup

- `CLAUDE.md` "Releasing": a release is bump `panel/version.json` `version` + `CHANGELOG.md` heading `## v<version> - <date>` + push; the workflow gates, builds and publishes. `commit` in main's `version.json` is legacy, kept only for pre-0.11 clients, and no longer maintained by hand after Push B. Add `release.yml` and `scripts/release-gate.mjs` to the repo layout notes.
- `README.md` "Updating": the panel checks the latest GitHub release; the update script downloads the release asset. Add a note that networks behind a proxy must allow `api.github.com` and `release-assets.githubusercontent.com` in addition to `github.com`.
- Delete `.git/hooks/post-commit.sdd-disabled` from the owner's checkout. It is untracked, so this is a local action, not part of the commit.

## Rollout and compatibility

**Invariants until pre-0.11 clients are gone:** `main` keeps `panel/version.json` at the same path with exactly the keys `{ "version", "commit" }`, and the `main` archive layout `gaffer-ae-main/panel/` does not change. Old clients update straight from `main` the moment a bump lands, whether or not the release gate passes, so the gate cannot protect them. The two-push sequence does.

**Push A.** `version` 0.11.0, the new clients (README, both update scripts, panel check, `update-state.js`), `release.yml`, `release-gate.mjs` and tests, the traffic extension, docs, and the `CHANGELOG.md` entry. `commit` stays `401c1ec`. Effects:
- Clients on 0.10.2 to 0.10.8 still see "up to date" (commit equal), so nobody runs an old script against an unverified release.
- Clients below 0.10.2 are offered 0.11.0 from `main` and land on the new client, possibly before the release exists. The new client treats the 404 as "no update info", so they see nothing.
- The workflow publishes v0.11.0. Verify install and update from the real assets (Testing, 1 and 2) before Push B.

**Push B.** Change only `commit` in main's `version.json` to a fresh value (not `401c1ec`). The workflow sees release v0.11.0 complete and skips. Clients on 0.10.2 to 0.10.8 are now offered 0.11.0, update through their old installed script (which reads `main`), and land on the new client, whose `releases/latest` call already resolves.

**CHANGELOG note for v0.11.0:** this one hop runs the old update script, so per-version chat history can be lost once for clients below 0.10.8, and the panel may reload before the update finishes (see Risks). Updates after this one are safe.

## Testing

**Gate unit tests** (`scripts/release-gate.test.mjs`, pure inputs): published release with all four assets → `skip`; draft release → `recover`; published release missing one asset → `recover`; tag `v$V` exists without a release → `create` (the comparison ignores `v$V` itself; `gh release create` attaches to the existing tag); `V` equal to or lower than the highest other tag → fail; `0.11.0` after `0.11.0-beta.1` → allowed; `0.11.0-beta.1` after `0.11.0` → fail; missing `## v<V>` heading → fail; `## v0.11.0` does not match `V = 0.11.01`; notes extraction stops at the next `## `.

**Workflow tests** (on a fork or a scratch branch with `dry_run`): failing `npm test` and a non-ASCII `.ps1` each fail the build job; a dry run produces the four assets plus `notes.md` and creates no tag or release; deleting one asset from a test release and re-running with `dry_run: false` recovers it via `--clobber`.

**Panel unit tests** (`panel/daemon/test/update-state.test.mjs`): load `panel/update-state.js` into `node:vm` with a stub `window` and test `parseRelease` (tag prefix, missing asset, 304 path), `decideUpdate` (newer / equal / older / dismissed), `shouldReloadAfterUpdate` (same version, new version, half-written JSON), `updateVerdict`. The wiring in `main.js` is verified manually.

**Manual, from dry-run artifacts:**
1. Fresh install from `gaffer-install-mac.tar.gz` on macOS, and from `gaffer-install-win.zip` on the Windows test VM `gaffer-winvm`, following the README steps. Panel loads, daemon starts, version label shows `v0.11.0 (<sha7>)`.
2. On a 0.10.8 install, run the new `update.sh` (and `update.ps1` on the VM) pointed at the artifact. Assert: no panel reload or daemon start before `npm install` finishes (watch `/tmp/gaffer-update.log` timestamps against the panel reload); no `gaffer.tar.gz`, `gaffer.zip`, `extract/` or `version.json.tmp` in the panel dir; `chat-history*.json` preserved and the per-user `config.json` (outside the extension dir) untouched; `version.json` mtime is the newest in the panel dir and its `commit` is the stamped SHA.
3. Unstick hop: install 0.10.8 (commit `401c1ec`), copy the old `update.sh` and point its `REPO` at a fork whose `main` has the Push A tree with a fresh `commit`; run it; confirm it lands on 0.11.0 and the new panel's `releases/latest` call succeeds (against the fork's release).
4. In the panel: banner appears for an older local version, dismiss persists across reload, Settings CTA follows availability, a forced 403 shows no error modal, a second check sends `If-None-Match` and handles 304.

## Risks and accepted tradeoffs

- **Early reload during the old-script hop (Push B, and below-0.10.2 clients in Push A).** Old scripts sync main's `version.json` before `npm install`, so old panels may reload early and start a daemon on a half-updated tree. The old scripts' final daemon stop and the daemon's `version.json` watcher bring up a clean daemon afterwards. One-time; the new scripts fix it.
- **Below-0.10.2 clients can reach 0.11.0 before its release exists.** Small group; the new client is silent on 404 and self-heals once the release is published.
- **Rate limit.** 60 requests per hour per IP unauthenticated. ETag revalidation (304s do not count) and silent 403/429 handling keep shared office IPs from surfacing errors.
- **Proxies.** Networks that allowed only `github.com`, `codeload.github.com` and `raw.githubusercontent.com` must now also allow `api.github.com` and `release-assets.githubusercontent.com`.
- **Unchanged by this design:** supply-chain exposure (same repo, same branch, owner-only push); file exec bits (the panel spawns `node index.js` and runs scripts via `bash <path>`); self-overwrite of a running update script (safe while rsync stays non-`--inplace` and PowerShell `-File` parses the whole script first); `releases/latest` returns the newest non-draft, non-prerelease release, so prereleases are never auto-offered.
- **Download counts are noisy.** Weekly deltas only.

## Files touched

- [ ] `.github/workflows/release.yml` (new)
- [ ] `scripts/release-gate.mjs` (new), `scripts/release-gate.test.mjs` (new)
- [ ] `.github/workflows/traffic-snapshot.yml`
- [ ] `panel/daemon/update.sh`
- [ ] `panel/daemon/update.ps1` (ASCII-only, UTF-8 BOM, PowerShell 5.1)
- [ ] `panel/update-state.js` (new), `panel/index.html` (script tag)
- [ ] `panel/main.js`
- [ ] `panel/daemon/test/update-state.test.mjs` (new)
- [ ] `design/scripts/panel-capture.mjs` (seam argument)
- [ ] `panel/version.json` (0.11.0 in Push A; `commit` only in Push B)
- [ ] `CHANGELOG.md` (`## v0.11.0` entry)
- [ ] `README.md` (install step 3, "Updating", proxy note)
- [ ] `CLAUDE.md` ("Releasing", repo layout)
- [ ] Local only: delete `.git/hooks/post-commit.sdd-disabled`
