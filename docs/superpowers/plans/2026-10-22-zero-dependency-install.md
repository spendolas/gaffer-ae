# Zero-dependency install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gaffer installs, runs and updates on a machine with only After Effects and Claude: one esbuild bundle (`daemon.mjs`) run by the official, unmodified Node 24 binary fetched into `daemon/runtime/`.

**Architecture:** CI bundles the daemon into one file and ships it with a one-line `index.js` shim and a dependency-free `package.json` (old 0.11.x updaters still need both). The panel launches `runtime/node daemon.mjs` (size-checked against a `VERIFIED` stamp), falling back to a system Node only for dev installs and 0.11.x installs mid-migration. A `fetch-runtime` script pair downloads from nodejs.org (mirror fallback), verifies SHA-256 and the vendor signature, and swaps the runtime in atomically. Updaters stop running npm and exclude `runtime/` from their sync.

**Tech Stack:** Node 24 (esbuild, node:test), bash, PowerShell 5.1 (ASCII + UTF-8 BOM), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-22-zero-dependency-install-design.md` (binding authority; section numbers below refer to it). Acceptance plan: `docs/superpowers/plans/2026-10-22-zero-dependency-acceptance-test.md`.

## Global Constraints

- Nothing is pushed, no version bump, no `CHANGELOG.md` section for a release, no `gh` write calls. Branch `feat/zero-dep-install`, commits local only.
- Commit identity `spendolas@users.noreply.github.com`; end every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- `.ps1` files: ASCII only, UTF-8 BOM; run `node scripts/check-ps-encoding.mjs`. Every Node child process on Windows sets `windowsHide: true`.
- No em or en dashes in user-facing copy (README, panel text, error messages, CHANGELOG). Comments exempt.
- ExtendScript rules do not apply to panel/daemon JS, but `panel/main.js` and `panel/*.js` loaded by `index.html` stay ES5-style like the existing file.
- The runtime binary is never modified, re-signed, stripped or SEA-injected. Never add the runtime dir to PATH.
- Every daemon listener binds 127.0.0.1 explicitly.
- Never kill or restart a running server (the owner's Gaffer daemon on :9823/:9824 is live; tests must use other ports or mocks and must not touch it).
- Tests use `isolate-env.mjs` style isolation (see `panel/daemon/test/isolate-env.mjs`): never the real config, telemetry or `~/.claude`.
- No npm cache or config may land in the home directory from dev tooling (use `npm_config_cache` etc., spec section 9).
- Error/status contract strings (exact): `runtime:current`, `runtime:installed <version> <platform>`, `err:runtime`, `err:runtime-damaged`, `err:runtime-missing`, `pid:<N> runtime|node`, `ok:<version>`, `busy:already-running`.
- Pin values (version, URLs, SHA-256s, sizes, Team ID) come only from `panel/daemon/runtime-pins.json`, exactly as in spec section 2. The darwin-arm64 `binarySha256` is not fully known: use the literal placeholder `"PENDING-FIRST-ACCEPTANCE-RUN"` and make the code treat a placeholder as "skip the binary-hash check, still check size and signature" with a log line.
- PoC reference material (copy ideas and verified code, do not depend on it at runtime): scratchpad `/private/tmp/claude-501/-Volumes-Origami-Users-spendolas-Library-CloudStorage-Dropbox-Tools-AE-Tools-Gaffer/1910bfc5-4a96-4619-8b6f-3bbfb17d82d1/scratchpad/` subfolders `poc-ae/changes.diff` (Mac panel change), `poc-ae-win/changes-vs-mac-poc.diff`, `poc-ae-win/guest-scripts/`, `poc-mac/`, `ci-poc/branch-files/` (the CI smoke scripts and parity checks), `bundle/daemon.mjs`.

## Review Focus

- A runtime that exists but fails the check must never silently fall back to system node (spec 4).
- `rsync --delete` / `robocopy /PURGE` must never delete `daemon/runtime`, `runtime.new`, `runtime.old` (spec 6.5).
- An updater failure before the runtime swap leaves the install byte-identical and prints `err:runtime` (spec 6.2).
- A 0.11.x updater given the new archive must still pass its `daemon/index.js` check and its `npm install --omit=dev` must succeed on the dependency-free `package.json` (spec 7).
- A path with spaces and accents (the owner's extension path contains "Application Support"; Windows paths use backslashes after normalisation) works in every launcher.

---

### Task 1: Small bug fixes (spec 12)

**Files:**
- Create: `panel/daemon/ports.js`
- Modify: `panel/daemon/index.js` (use ports.js), `panel/daemon/mcp-server.js` (~219-221 listen callback), `panel/daemon/chat-handler.js` (~892 hardcoded MCP URL), `panel/daemon/test/update-wiring.test.mjs` (line 12)
- Test: `panel/daemon/test/ports.test.mjs`, `panel/daemon/test/mcp-server-listen-error.test.mjs`

**Interfaces:**
- Produces: `ports.js` exports `WS_PORT = 9823`, `MCP_PORT = 9824`, `mcpUrl()` returning `http://127.0.0.1:9824/mcp`. Honour existing env overrides if `index.js` already has any (read it first and keep behaviour).

- [ ] Write failing tests: ports values; starting the MCP server twice on one test port rejects with an error whose `code` is `EADDRINUSE` (no TypeError); `chat-handler` builds `--mcp-config` from `mcpUrl()`.
- [ ] Implement per spec section 12 (`app.listen(port, host, (err) => { if (err) return reject(err); ... })`, verify against the Express 5 API in `node_modules`). `index.js`'s existing "port in use, daemon already running, exiting" path must now be reachable (exit 0).
- [ ] `update-wiring.test.mjs`: skip the panel-capture assertion when `design/` is absent.
- [ ] Run `cd panel/daemon && npm ci && node --test` (use a tmp npm cache per Global Constraints). All green. Commit: `fix(daemon): graceful EADDRINUSE, single source for ports, packaged-tree test`.

### Task 2: Runtime pins and bundle pipeline (spec 1, 2, 10 packaging part)

**Files:**
- Create: `panel/daemon/runtime-pins.json`, `scripts/bundle-daemon.sh`, `scripts/third-party-notices.mjs`, `scripts/third-party-notices.test.mjs`, `scripts/runtime-pins.test.mjs`
- Modify: `scripts/package-release.sh`, `scripts/package-release.test.mjs`, `scripts/release-gate.mjs` + `scripts/release-gate.test.mjs` (five assets incl. `SHA256SUMS.txt`), `scripts/build.sh` (remove SEA), `.gitignore` (`panel/daemon/runtime*/`, `panel/daemon/daemon.mjs`, `.npm-cache/`, `.npmrc-dev`), `panel/daemon/package.json` (drop `@yao-pkg/pkg`; keep esbuild devDependency; refresh lockfile)

**Interfaces:**
- Produces: `runtime-pins.json` exactly per spec section 2; `scripts/bundle-daemon.sh <stage-dir>` writes `<stage>/daemon/daemon.mjs` (esbuild flags and createRequire banner from spec 1), writes `meta.json` and the source map OUTSIDE the stage; `scripts/third-party-notices.mjs <meta.json> <node_modules> <out>` fails on missing license file or license outside the allowlist; hygiene checks (no `/Users/`, `/home/`, `C:\\Users`, secret patterns) and `npm audit --omit=dev --audit-level=high` run inside `bundle-daemon.sh` or a sibling `scripts/bundle-checks.sh`.
- `package-release.sh` produces the four existing archive names plus `SHA256SUMS.txt`, with the staging order and assertions of spec section 10 (shim `index.js` = `import './daemon.mjs';`, dependency-free `package.json` = `{"name":"gaffer-daemon","private":true,"type":"module"}`, `THIRD-PARTY-NOTICES.txt` at the extension root, no `node_modules`/`.map`/`package-lock.json`/`test`/`.remember`, no daemon `.js` module beside `daemon.mjs` except `index.js` and `launch.cjs`; `fetch-runtime.*`, `start.*`, `update.*`, `stop-daemon.ps1`, `runtime-pins.json`, `launch.cjs` are kept).
- Consumes: nothing from earlier tasks.

- [ ] Tests first: `runtime-pins.test.mjs` asserts the JSON shape and every pinned value equals spec section 2; notices test covers allowed, missing-license and disallowed-license cases with a fixture; package tests assert the staging assertions with a temp stage and a stubbed bundle step (the real bundle needs `npm ci`).
- [ ] Implement; build the real bundle once locally with `bash scripts/bundle-daemon.sh` and confirm one file 2.4 to 2.6 MB, then `bash scripts/package-release.sh` and inspect the archives (list contents, assert layout).
- [ ] Update the four release-tooling test files named in `CLAUDE.md` Commands and run them: `node --test scripts/release-gate.test.mjs scripts/package-release.test.mjs scripts/traffic-snapshot.test.mjs scripts/release-docs.test.mjs` plus the new ones. Commit.

### Task 3: `fetch-runtime.sh` (spec 3, macOS)

**Files:**
- Create: `panel/daemon/fetch-runtime.sh`, `panel/daemon/test/fetch-runtime-sh.test.mjs`

**Interfaces:**
- Consumes: `runtime-pins.json` (Task 2). Usage: `fetch-runtime.sh [--into <daemon-dir>] [--stage-only]`. `--stage-only` runs steps 1 to 7 into `<daemon-dir>/runtime.new` and stops (the updater swaps later); without it, runs steps 1 to 9. Output last line: `runtime:current`, `runtime:installed <ver> <plat>`, or `err:runtime`; progress lines before it. Test seams (env, honoured only when `GAFFER_FETCH_TEST=1`): `GAFFER_FETCH_BASE_OFFICIAL`, `GAFFER_FETCH_BASE_MIRROR` override the base URLs (so tests serve `file://` or a loopback http server), `GAFFER_FETCH_PINS` overrides the pins file, `GAFFER_FETCH_SKIP_CODESIGN=1` skips signature checks for non-Apple test archives, `GAFFER_FETCH_PLATFORM` forces the platform key.
- Produces: no pins parsing dependency on jq (use `sed`/`grep` or `/usr/bin/python3`-free awk; a stock Mac has no jq or node).

- [ ] Implement steps 1 to 9 of spec section 3 exactly (platform via `sysctl -n hw.optional.arm64`; skip check on `VERSION` and `VERIFIED`; curl flags; official first then mirror with the log line `runtime: official download failed, using the mirror`; archive SHA-256; extract only the binary with the strip-components command; size + SHA-256 + `codesign --verify --strict` + TeamIdentifier; `--version` smoke; swap via `runtime.old` and `runtime.new`; temp folder removed).
- [ ] Tests (node:test, spawning bash): good path with a tiny fake archive and fake pins (tar of a shell-script "node" printing the pinned version); wrong archive hash then mirror succeeds; wrong hash on both gives `err:runtime` and leaves `runtime/` untouched; truncated download; HTML error page; skip-when-current prints `runtime:current` and does not touch the file (mtime unchanged); `--stage-only` leaves `runtime.new` and no swap; path with spaces; no stray files outside `--into` and the temp dir.
- [ ] Then run it for real once against the real official URL into a scratch dir (not the extensions folder) with no test seams: record version, size and codesign output in the commit message body. Commit.

### Task 4: `fetch-runtime.ps1` (spec 3, Windows)

**Files:**
- Create: `panel/daemon/fetch-runtime.ps1` (ASCII + BOM), `panel/daemon/test/fetch-runtime-ps1.test.mjs` (runs only when `process.platform === 'win32'`, else skipped with a reason; also a cross-platform static test that the file is ASCII with BOM and contains the required strings)

**Interfaces:** same contract and last-line outputs as Task 3. Parameters `-Into`, `-StageOnly`; same test seams as env vars. Use `curl.exe` (never `Invoke-WebRequest`; any PowerShell web call sets `$ProgressPreference = 'SilentlyContinue'`), `Get-FileHash -Algorithm SHA256`, `tar.exe -xf` with a `[System.IO.Compression.ZipFile]` fallback reading one entry, `Get-AuthenticodeSignature` (`Valid`, subject contains `OpenJS Foundation`), `windowsHide` irrelevant here, run the `--version` smoke as the Defender warm-up. A locked leftover `runtime.old` is deleted on the next run. Never write outside `-Into` and the temp folder.

- [ ] Implement; run `node scripts/check-ps-encoding.mjs`; parse-check the script on the Mac if `pwsh` exists, otherwise note that the VM run is the check (the controller does the VM run in a later phase).
- [ ] Commit.

### Task 5: Panel launch (spec 4)

**Files:**
- Create: `panel/daemon-launch.js` (pure ES5 functions, loaded before `main.js` by a `<script>` tag in `index.html`, exposes `window.GafferLaunch` and `module.exports` when `module` exists, following the `update-state.js` pattern), `panel/daemon/test/daemon-launch.test.mjs` (loads the file into `node:vm` like `update-state.test.mjs`)
- Modify: `panel/main.js` (`spawnViaNode` becomes the three functions using GafferLaunch), `panel/index.html` (script tag), `panel/CSXS/manifest.xml` only if needed

**Interfaces:**
- Produces in `GafferLaunch`: `resolveDaemonLaunch({ daemonDir, platform, fs, pins, env, detectDev })` returns `{ bin, args, cwd, kind }` or `{ error }` with codes `runtime-damaged` | `runtime-missing`; `cleanDaemonEnv(env, platform)` (deletes `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, case-insensitive on win32; per decision D7 stash the original `NODE_EXTRA_CA_CERTS` into `GAFFER_CLAUDE_EXTRA_CA_CERTS`); `normalizeWinPath(p)`; `launchDaemon` stays in `main.js` (it needs `cp`/`fs`) and uses `cp.spawn(bin, args, { cwd, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env })`.
- All filesystem access goes through the injected `fs` so tests use a fake. Rules exactly as spec section 4: stamp check by size, stamp-less first run hashes once against `binarySha256` (skip hash if the pin is the placeholder) and writes the stamp, damaged runtime never falls back to system node, `chmod 755` self-heal on macOS, dev install and `runtime/`-absent fall back to the system node probe (Windows candidates in the spec order), `daemon.mjs` preferred over `index.js` when present, notices for `{ error }` (texts from the spec Failure modes table).
- Consumes: pins format from Task 2.

- [ ] Tests first covering every branch above plus Windows forward-slash path normalisation and case-insensitive `node_options` removal.
- [ ] Port the working PoC code from `poc-ae/changes.diff` and `poc-ae-win/changes-vs-mac-poc.diff`; remove the `STRICT` switch and `ports.js` bits that Task 1 already did.
- [ ] Run the daemon suite and the two new tests. Commit.

### Task 6: Launchers (spec 5)

**Files:**
- Modify: `panel/daemon/start.sh`, `panel/daemon/start.ps1` (ASCII + BOM)
- Create: `panel/daemon/launch.cjs`, `panel/daemon/test/start-sh.test.mjs`, `panel/daemon/test/launch-cjs.test.mjs`

**Interfaces:**
- `start.sh` / `start.ps1` mirror `resolveDaemonLaunch` and keep the contract `pid:<N> runtime`, `pid:<N> node`, `err:runtime-damaged`, `err:runtime-missing`. Remove the `GAFFER_USE_BINARY` branch. `start.sh` uses `env -u NODE_OPTIONS -u NODE_PATH -u NODE_EXTRA_CA_CERTS nohup ... >> /tmp/gaffer-daemon.log 2>&1 &`; stamp-less first run hashes with `shasum -a 256` and reads the pin with `grep`/`sed`.
- `launch.cjs` (about 30 lines, plain CommonJS, runs on the runtime or any Node): opens the daemon log in append mode, spawns `daemon.mjs` detached with `windowsHide: true`, `stdio: ['ignore', fd, fd]` and a cleaned env, prints `pid:<N> runtime|node` (kind passed as an argument) and exits. `start.ps1` runs `& $node launch.cjs` and does not use `Start-Process -Redirect*`.

- [ ] Tests: start.sh with a fake runtime and fake `daemon.mjs` (a script that listens and writes a marker), stamp present, stamp absent, wrong size, missing runtime with and without a system node on PATH, hostile `NODE_OPTIONS` cleared (the fake daemon prints its env), paths with spaces; launch.cjs spawns detached and does not inherit the caller's pipe (caller reading stdout to EOF returns).
- [ ] `node scripts/check-ps-encoding.mjs`. Commit.

### Task 7: `update.sh` (spec 6, 7)

**Files:**
- Modify: `panel/daemon/update.sh`, `scripts/test-update-sh.sh`, `scripts/updater-scripts.test.mjs`

**Interfaces:**
- Consumes: `fetch-runtime.sh --stage-only` from the archive being installed (extract the archive first, then run the archive's copy), `runtime-pins.json`.
- Behaviour exactly per spec 6: archive check requires `version.json` and `daemon/daemon.mjs`; runtime step before any file is replaced (stage while the daemon still runs; failure prints `err:runtime`, deletes `runtime.new`, install untouched); stop daemon; swap runtime; rsync with `--exclude '/daemon/runtime' --exclude '/daemon/runtime.new' --exclude '/daemon/runtime.old'` and WITHOUT the `node_modules` exclude; remove the npm block and `err:npm`; `version.json` last; recovery at start renames `runtime.old` back when `runtime` is missing and `runtime.old` passes the size check. Lock, `ok:`, `busy:`, existing `err:` codes unchanged. `GAFFER_UPDATE_ASSET` and the existing test knobs keep working.

- [ ] Extend `scripts/test-update-sh.sh` (the end-to-end updater test, read it first) with: runtime unchanged (no network call, runtime mtime and hash unchanged), runtime changed (new pins), stage failure leaves install untouched, killed-between-renames recovery, runtime survives rsync `--delete`, old `node_modules` removed by the sync, an archive from the OLD layout still accepted. Use the local-file test seams, never the real nodejs.org except one explicitly named integration case guarded by an env flag.
- [ ] Run `bash scripts/test-update-sh.sh` (close the Gaffer panel first is a manual precaution; the script must not touch the live install) and the node tests. Commit.

### Task 8: `update.ps1` (spec 6, 7, Windows)

**Files:**
- Modify: `panel/daemon/update.ps1` (ASCII + BOM), `scripts/updater-scripts.test.mjs` (static assertions), `scripts/windows-tests/` (add `test-6-runtime-update.ps1`, field-style, runs on Windows only)

**Interfaces:** same behaviour as Task 7 using `fetch-runtime.ps1 -StageOnly`; `robocopy ... /XD runtime runtime.new runtime.old`; no npm block, no Node directory probes; rename-aside swap (a running `node.exe` cannot be overwritten, renaming works); the daemon is stopped before the swap; keep the process-tree and hand-run-terminal rules from v0.11.3 untouched.

- [ ] Implement, `node scripts/check-ps-encoding.mjs`, static tests green. The live Windows run is a controller step on the VM later. Commit.

### Task 9: Installers, README, docs (spec 9)

**Files:**
- Modify: `scripts/install-mac.sh`, `scripts/install-win.ps1` (ASCII + BOM; robocopy `/XD .remember runtime`), `README.md`, `CLAUDE.md` (architecture, layout, commands, releasing), `scripts/release-docs.test.mjs`
- Do NOT touch `CHANGELOG.md` beyond an `## Unreleased` bullet list; do NOT touch the landing-page worktree.

**Interfaces:** README step order and wording exactly per spec 9 (platform detect, package download with `SHA256SUMS.txt` verification, Node download from nodejs.org with the trigger sentence for the mirror fallback, SHA-256, extract-only-the-binary with the exact commands and delete the archive, signature step, developer-mode flag described as a user preference, find and optionally pin Claude using `"$INSTALL_DIR/daemon/runtime/node" -e`, `claude mcp add` stays ON by default (owner decision D1, with a plain disclosure that it writes to the user's Claude config and a one-line removal command), restart and verify). The final V5 wording refinements from the second agent trial apply: curl line with `--connect-timeout 20 --max-time 600`, "delete the archive and any download folder you created", rules block "do not install Node any other way ... do not change proxy or network settings ... do not turn off certificate checks, and do not ask the user to approve that either. If both downloads fail, stop and tell the user." URLs, hashes and the Team ID in the README are generated from `runtime-pins.json` by a small script `scripts/readme-pins.mjs` or checked by `release-docs.test.mjs` (the test must fail when they drift).
- `install-mac.sh` / `install-win.ps1`: copy installs call `fetch-runtime`; symlinked dev installs keep `npm install` with the isolated npm env vars from spec 9.

- [ ] Tests first for the README/pins equality check. Implement. Remove the README Node prerequisite, the npm step and the Node troubleshooting entries. Run the release-docs and encoding checks. Commit.

### Task 10: CI (spec 10)

**Files:**
- Modify: `.github/workflows/release.yml`
- Create: `.github/workflows/node-runtime-check.yml`, `scripts/node-runtime-check.mjs`, `scripts/node-runtime-check.test.mjs`, `scripts/smoke/` (port from `ci-poc/branch-files/`)

**Interfaces:** `build` job on Node 24 runs tests, bundle, notices, hygiene, audit, package; uploads `meta.json` and the source map as artifact `gaffer-debug` (30 days). New `smoke` job (`needs: build`) on `macos-15`, `macos-15-intel`, `windows-latest` downloads the official Node per platform, verifies against the pins, extracts the single binary, checks the signature, starts the packaged `daemon.mjs` with a stripped PATH and no `node_modules`, runs the parity script (handshake, MCP initialize, tools/list hash, runJSX capture hash, undo-group stripping, 60 s timeout) and the daemon test suite with that runtime. `publish` needs both jobs and uploads five assets. Weekly `node-runtime-check.yml` (Monday 08:30 UTC plus manual, read-only) per spec 10. The parity expected hashes are P8's (`68693916...8223`, `db239664...7faf`, spec section "Proof evidence"). `node-runtime-check.mjs` is a pure, unit-tested checker (index.json security-release logic, hash comparison, mirror comparison, releases/latest guard) with network calls injected.

- [ ] Tests for the checker with fixtures. Validate workflow YAML (`actionlint` if present, else `node -e` YAML parse via a tiny script; do not add dependencies to the repo). Do NOT run `gh workflow run` (controller does the dry run). Commit.

### Task 11: Final integration check

**Files:** none new.

- [ ] Run everything runnable locally: `cd panel/daemon && node --test`, the four release tooling tests plus new ones, `node scripts/check-ps-encoding.mjs`, `bash scripts/test-update-sh.sh`, `bash scripts/package-release.sh` then unpack the update archive into a scratch dir and start `runtime/node daemon.mjs` (fetched by `fetch-runtime.sh` into the scratch) on alternate ports if ports are configurable, else skip the live start and state why. Fix what fails. Commit any fixes. Report exact counts.
