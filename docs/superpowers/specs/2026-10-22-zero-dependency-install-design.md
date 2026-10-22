# Zero-dependency install: design spec

**Changes since the first draft (2026-10-22, second commit):**

- Proof evidence: P5 (real AE on the Mac) filled in; new rows P6 (real AE on the Windows VM, including a real chat turn), P7 (Windows Firewall test) and P8 (GitHub hosted runners, full record). P4 gains the trial cost and the Opus objections.
- Section 2: the arm64 binary hash is partly known (first 8 and last 4 hex digits); the first acceptance run records the full value.
- Section 4: Windows path normalisation, Windows system-node fallback candidates, case-insensitive `NODE_*` cleaning, which launch route each platform really uses, and the daemon's parent process and lifetime.
- Section 11 and D2: host the mirror on a normal versioned release, never a "trial" one.
- Security model: the firewall note is replaced by the tested Windows Firewall result and a loopback-only rule for every listener.
- Failure modes: stale Claude login row.
- Open risks: real AE on Windows and Windows chat through the bundled runtime are now proven and removed; the remaining unproven items are listed with their cases.
- Rollout gates: evidence list updated; G5 now covers A1 to A26.
- Acceptance plan: new environment step E6 (fresh Claude sign-in) and VM notes in E4; new cases A23 to A26 (Windows first launch with no firewall prompt and loopback-only listeners, Windows visual check, daemon lifetime across panel and AE close, Windows path normalisation); A1, A2, A4, A14, A18 and A20 extended; plan gate G4 includes A23 and A24.

**Date:** 2026-10-22
**Status:** Design decided and proven by proof-of-concept runs, pending implementation. Owner decisions listed at the end.
**Feature:** Install, run and update Gaffer on a machine that has only After Effects and Claude. No Node.js, no npm, nothing else pre-installed, and nothing installed outside Gaffer's own folders.

## Goal

1. A user machine with only After Effects and Claude (the Claude desktop app or the standalone Claude Code) can install, run and update Gaffer. The README step "Node.js 20+" disappears.
2. Nothing lands on the user's machine outside the CEP extension folder, Gaffer's settings folder and temp logs.
3. The install instructions stay something a Claude agent executes without suspicion: every download comes from its original source, with a clearly worded fallback.
4. Updates stay small (about 2.2 MB) and never re-download the runtime unless its version changes.

## Non-goals

- No change to how Claude is found or launched (`claude-binary.js`, `chat-handler.js` spawn flags).
- No ZXP signing of the extension. The CEP developer-mode flag stays (see Owner constraints, rule 3). Signing is a separate project, listed under decisions.
- No modified Node binary: no SEA injection, no re-signing, no stripping. `scripts/build.sh` SEA output is retired, not revived.
- No change to dev installs beyond keeping them working with a system Node.
- No change to telemetry, the update check in `panel/update-state.js`, or the release gate's skip/create/recover logic beyond its asset list.

## Owner constraints as testable rules

Each rule has a check in the acceptance test plan (`docs/superpowers/plans/2026-10-22-zero-dependency-acceptance-test.md`).

1. **Strict zero dependencies.** With `node` and `npm` absent from the machine (not only from PATH), a fresh install by a clean Claude agent following the README completes, the panel connects, a chat turn with a tool call succeeds, and an update succeeds. Fails if any step invokes `node`, `npm`, `npx`, Homebrew, nvm, fnm, winget, choco or an installer package.
2. **Nothing outside the allowed set.** A before/after footprint diff (files, registry, PATH, shell profiles, launch agents, scheduled tasks) after install, use, update and uninstall shows changes only in: the extension folder (`~/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel`, `%APPDATA%\Adobe\CEP\extensions\com.gaffer.panel`), Gaffer's settings folder (`~/Library/Application Support/Gaffer`, `%APPDATA%\Gaffer`) and temp logs (`/tmp/gaffer-*`, `$TMPDIR/gaffer-*`, `%TEMP%\gaffer-*`). No `~/.npm`, no `~/.npmrc`, no `%APPDATA%\npm`, no `%LOCALAPPDATA%\npm-cache`, no PATH edit.
3. **One named exception: the CEP developer-mode flag.** `defaults write com.adobe.CSXS.<v> PlayerDebugMode 1` on macOS and `HKCU\Software\Adobe\CSXS.<v>\PlayerDebugMode = 1` on Windows, for v in 11, 12, 13. It is a user preference, not software. The README names it as such.
4. **Host-application data is not Gaffer's footprint, but it is reported.** Files that After Effects, CEP or Claude write on their own behalf (AE preferences, CEP caches and logs, Claude's session files under `~/.claude` from chat turns) are listed separately in every footprint diff. The one install step that writes into Claude's config, `claude mcp add`, is a decision for the owner (see Decisions, D1).
5. **Original source first.** The Node runtime is downloaded from `https://nodejs.org/dist/`. A byte-identical mirror on GitHub Releases is used only when the official download fails, and the instructions say so in those words.
6. **Release verification order.** Before any version-bump push to `main`: dry-run the release workflow, run the full Linux test set, and do the real update on a Mac install and on the Windows VM using only published-style assets. Never after.

## Background

- **Launch today.** `panel/main.js` `startDaemon()` (line 451) calls `spawnViaNode()` (391-429) first: it probes `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`, else `/usr/bin/env node` (Windows: bare `node`), and spawns `index.js` detached with the log opened for append. Only when CEP Node integration is missing does it fall back to `spawnViaExtendScript()` (432-449), which runs `bash start.sh` or `powershell -File start.ps1` through `system.callSystem()`.
- **Launchers today.** `panel/daemon/start.sh` probes the same three node paths, then `command -v node`, and prints `pid:N node` or `error:node not found`. `start.ps1` probes `Program Files\nodejs` and `LOCALAPPDATA\Programs\nodejs`, then uses `Start-Process ... -RedirectStandardOutput`, which inherits handles (a parent reading the output to EOF hangs) and truncates the log on a double start. Both still carry a `GAFFER_USE_BINARY` branch for the SEA binary.
- **Install today.** `README.md` requires Node.js 20+ (line 17, check at line 42), runs `npm install --omit=dev` (step 4, lines 81-90) and pins the Claude mode with `node -e` (line 135). The current install has 95 packages, 24 MB, 3,431 files in `daemon/node_modules`. `scripts/install-mac.sh` (57-72) and `install-win.ps1` (81-86, 138) also require Node and run npm.
- **Update today.** `update.sh` refuses an archive without `daemon/index.js` (442), syncs with `rsync -a --delete` (497) and runs `npm install --omit=dev` after the files are replaced. `update.ps1` does the same (697, `robocopy /E /PURGE` at 745, npm at 763-785). A failing npm leaves a half-updated install (`err:npm`).
- **Packaging today.** `scripts/package-release.sh` archives `git archive HEAD:panel` minus `daemon/test` and `daemon/test-fixtures`. `.github/workflows/release.yml` builds on ubuntu-latest with Node 20 (line 45). Node 20 is effectively end-of-life.
- **Pre-existing bugs found by the proofs.**
  - `mcp-server.js` 219-220: Express 5's `app.listen` callback receives the error, then the code reads `server.address()`, which is `null`, and the daemon dies with a TypeError on EADDRINUSE instead of the graceful "port in use, exiting" in `index.js` 191-196. This hits every double start and every `version.json` reload race.
  - `chat-handler.js` 892 hardcodes `http://127.0.0.1:9824/mcp` for the `--mcp-config` it hands to Claude, separately from `MCP_PORT` in `index.js` 15.
  - `panel/daemon/test/update-wiring.test.mjs` line 12 reads `../../../design/scripts/panel-capture.mjs`, outside `panel/`, so the suite fails when run from a packaged tree (the 1 of 316 failure on the VM).

## Architecture

```
  User machine (only AE + Claude installed)
  +--------------------------------------------------------------------+
  | After Effects                                                      |
  |   CEPHtmlEngine: Gaffer panel (main.js)                            |
  |     resolveDaemonLaunch()                                          |
  |       1. <ext>/daemon/runtime/node  daemon.mjs   (size + stamp ok) |
  |       2. dev install only: system node  index.js                   |
  |     launchDaemon(): detached, windowsHide, append log,             |
  |                     cleanDaemonEnv() drops NODE_OPTIONS etc.       |
  |            |                                                       |
  |            v                                                       |
  |   <ext>/daemon/runtime/node  (official Node 24 LTS, unmodified,    |
  |                               vendor signed, never on PATH)        |
  |     runs <ext>/daemon/daemon.mjs  (one esbuild bundle, 2.5 MB)     |
  |       MCP :9824, panel bridge :9823, spawns claude -p              |
  +--------------------------------------------------------------------+
        ^ first install and runtime changes only            ^ every update
        |                                                   |
  nodejs.org/dist/v24.22.1/  (official, first)      github.com/spendolas/gaffer-ae
  GitHub release node-v24.22.1 (mirror, fallback)     releases/latest: gaffer-*-mac/win
        both verified against the SHA-256 pinned in runtime-pins.json
```

The extension folder after a fresh install:

```
com.gaffer.panel/
  CSXS/ index.html main.js update-state.js host.jsx icons/ fonts/ prompts/ lib/ version.json ...
  THIRD-PARTY-NOTICES.txt
  daemon/
    daemon.mjs            bundle of index.js and all production dependencies
    index.js              one-line shim: import './daemon.mjs';  (for 0.11.x updaters)
    package.json          {"name":"gaffer-daemon","private":true,"type":"module"}
    runtime-pins.json     pinned Node version, URLs, hashes, sizes, signer ids
    start.sh start.ps1 stop-daemon.ps1 update.sh update.ps1
    fetch-runtime.sh fetch-runtime.ps1
    runtime/
      node | node.exe     the official binary, the only file taken from the archive
      VERSION             e.g. "v24.22.1 darwin-x64"
      VERIFIED            "<size> <sha256>" written after verification
```

## Design

### 1. Bundle (CI only)

- `scripts/bundle-daemon.sh` (replaces the SEA part of `scripts/build.sh`) runs, in `panel/daemon` after `npm ci`:
  `esbuild index.js --bundle --platform=node --format=esm --target=node24 --outfile=<stage>/daemon/daemon.mjs --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" --metafile=<ci>/meta.json --sourcemap=linked`
  Keep the createRequire banner: CommonJS dependencies (ws, express) call `require` inside an ESM bundle.
- Result: one file, 2.4 to 2.6 MB (0.55 MB gzipped). 77 bundled packages (`@modelcontextprotocol/sdk`, `ws`, `zod`, `acorn`, Express transitively), all MIT, ISC or BSD.
- The source map (4.1 MB, embeds build paths) is uploaded as a CI artifact only, never shipped. The launcher adds `--enable-source-maps` only if `daemon.mjs.map` sits next to the bundle, which in practice means a developer copied it in.
- `scripts/third-party-notices.mjs` (new, no dependencies) reads `meta.json`, collects each bundled package's name, version and license file from `node_modules`, and writes `THIRD-PARTY-NOTICES.txt` (about 100 KB). It fails the build on a package with no license file or a license outside an allowlist (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD). The notices also name Node.js (MIT, https://github.com/nodejs/node/blob/main/LICENSE) as the runtime the installer downloads.
- Hygiene checks fail the build when `daemon.mjs` contains `/Users/`, `/home/` or `C:\\Users`, or matches secret patterns (`ghp_`, `github_pat_`, `sk-ant-`, `AKIA`, `-----BEGIN`).
- `npm audit --omit=dev --audit-level=high` runs on the bundle's dependency set and fails the build on high or critical findings.

### 2. Runtime pins, `panel/daemon/runtime-pins.json` (new)

One source of truth for the runtime, read by the fetch scripts, the launchers, the README test and the weekly check.

```json
{
  "node": {
    "version": "v24.22.1",
    "codename": "Krypton",
    "official": "https://nodejs.org/dist/v24.22.1/",
    "mirror": "https://github.com/spendolas/gaffer-ae/releases/download/node-v24.22.1/",
    "platforms": {
      "darwin-x64":   { "archive": "node-v24.22.1-darwin-x64.tar.gz",
                        "archiveSha256": "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
                        "member": "node-v24.22.1-darwin-x64/bin/node",
                        "binaryBytes": 125715808,
                        "binarySha256": "cc6f41f72e3eb4460154952e56a35afdd96b6995cea51cd25e637355a2955a51" },
      "darwin-arm64": { "archive": "node-v24.22.1-darwin-arm64.tar.gz",
                        "archiveSha256": "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
                        "member": "node-v24.22.1-darwin-arm64/bin/node",
                        "binaryBytes": 122545856,
                        "binarySha256": "<6f320694...f329, full value from the first acceptance run>" },
      "win-x64":      { "archive": "node-v24.22.1-win-x64.zip",
                        "archiveSha256": "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5",
                        "member": "node-v24.22.1-win-x64/node.exe",
                        "binaryBytes": 93915464,
                        "binarySha256": "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5" }
    },
    "signing": { "darwinTeamId": "HX7739G8FX", "windowsSigner": "OpenJS Foundation" }
  }
}
```

Archive sizes: 54.4 MB (mac x64), 53.1 MB (mac arm64), 37.7 MB (win-x64). The arm64 binary hash is the one value not yet fully recorded: the runner run (P8) logged only its first 8 and last 4 hex digits (`6f320694...f329`) and its size (122,545,856 bytes). The first acceptance run (case A18) records the full value, the implementation pins it, and the weekly check confirms it.

### 3. Provisioning, `panel/daemon/fetch-runtime.sh` and `fetch-runtime.ps1` (new)

Used by the updaters, by `install-mac.sh` / `install-win.ps1`, and documented step by step in the README (the README spells the commands out instead of calling the script, because the agent trials showed agents trust explicit, inspectable commands). Steps:

1. **Platform.** macOS: `sysctl -n hw.optional.arm64` equals `1` means `darwin-arm64`, else `darwin-x64` (`uname -m` lies under Rosetta). Windows: `win-x64` (Windows ARM policy is decision D5).
2. **Skip check.** If `runtime/VERSION` equals `<version> <platform>` from the pins and `runtime/VERIFIED` matches the file's size, print `runtime:current` and stop. `VERSION` is the only key for "download or not".
3. **Download** to `$TMPDIR/gaffer-runtime-XXXX/` (Windows `%TEMP%\gaffer-runtime-<guid>\`): `curl --fail --proto =https --location --connect-timeout 20 --max-time 600 --retry 3 --retry-delay 2 -o <archive> <official><archive>`; on failure, the same against `<mirror><archive>`, and the log says `runtime: official download failed, using the mirror`. Windows uses `curl.exe` (ships with Windows 10 1803 and later). Never `Invoke-WebRequest` with its progress bar on: PowerShell 5.1 stalls. Any PowerShell web call sets `$ProgressPreference = 'SilentlyContinue'` first.
4. **Verify the archive** SHA-256 against `archiveSha256` (`shasum -a 256`, `Get-FileHash -Algorithm SHA256`). Mismatch: delete, try the mirror if not yet tried, else `err:runtime`.
5. **Extract only the binary** into `daemon/runtime.new/`: macOS `tar -xzf <archive> -C runtime.new --strip-components=2 node-v24.22.1-<plat>/bin/node`. Windows `tar.exe -xf <archive> -C runtime.new node-v24.22.1-win-x64/node.exe` then move it up one level (tar.exe takes 0.5 s, three times faster than `Expand-Archive`); fallback `[System.IO.Compression.ZipFile]` reading just that entry.
6. **Verify the binary:** size equals `binaryBytes`, SHA-256 equals `binarySha256`; macOS `codesign --verify --strict runtime.new/node` passes and `codesign -dv` reports `TeamIdentifier=HX7739G8FX`; Windows `Get-AuthenticodeSignature` reports `Valid` and a signer subject containing `OpenJS Foundation`.
7. **Smoke run** `runtime.new/node --version` equals the pinned version. On Windows this is also the Defender warm-up: the first execution of a fresh 94 MB `node.exe` takes about 5.6 s under real-time protection, later ones about 85 ms.
8. **Swap** (see section 6 for the stop-first rule): rename `runtime` to `runtime.old`, rename `runtime.new` to `runtime`, write `runtime/VERSION` and `runtime/VERIFIED` (`<size> <sha256>`), delete `runtime.old` (on Windows a locked leftover is deleted on the next run).
9. Delete the temp folder and archive. Print `runtime:installed <version> <platform>`.

`runtime.new` lives inside `daemon/` so both renames stay on one volume and are atomic. Nothing is written anywhere else.

### 4. Launch, `panel/main.js`

`spawnViaNode()` becomes three functions (the PoC panel's names):

- `resolveDaemonLaunch(daemonDir)` returns `{ bin, args, kind }` or `{ error }`:
  1. If `runtime/node` (`node.exe`) and `daemon.mjs` exist: read `runtime/VERIFIED`. If the stamp is present and the file size matches it, return `{ bin: runtime, args: ['daemon.mjs'], kind: 'runtime' }`. If the stamp is absent (README install), hash the binary once against `binarySha256` for the platform in `runtime-pins.json`, write the stamp on a match, and use it (one-time cost 0.7 to 3.2 s). A size or hash mismatch returns `{ error: 'runtime-damaged' }`. On macOS, a binary whose size and stamp match but has lost its exec bit gets `chmod 755` and a log line.
  2. If `runtime/` does not exist: dev install (`detectDevInstall()`) or a 0.11.x install mid-migration (section 7). Use the system node probe that exists today, with `daemon.mjs` when present, else `index.js`. Return `kind: 'node'`. No node found: `{ error: 'runtime-missing' }`. On Windows the candidates mirror `start.ps1`, in this order: `%ProgramFiles%\nodejs\node.exe`, `%LOCALAPPDATA%\Programs\nodejs\node.exe`, then bare `node` (today's panel tries only bare `node`).
  A runtime that exists but fails the check never falls back to the system node.
- **Windows path normalisation.** CSInterface returns the extension path with forward slashes (`C:/Users/...`). `resolveDaemonLaunch` converts it to backslashes before it builds the runtime path, the `daemon.mjs` argument and the `cwd`, so the command line reads `...\daemon\runtime\node.exe daemon.mjs` (found while building the Windows PoC panel; acceptance case A26).
- `cleanDaemonEnv()` copies `process.env` and deletes `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`. On Windows, environment names are case-insensitive, so the match is case-insensitive there (`node_options` is removed too). Everything else stays: Claude needs `USER` and `HOME` (a stripped env made `claude auth status` report "not signed in"); on Windows `PATH`, `APPDATA`, `USERNAME` and `USERPROFILE` stay (P6: 46 variables kept, `claude.exe` worked with the cleaned env). The runtime dir is never added to PATH. See decision D7 for corporate CA certificates.
- `launchDaemon(launch)` keeps today's spawn shape: `cp.spawn(bin, args, { cwd: daemonDir, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env })` with `fd` opened in append mode on the log.
- On `{ error }`, `startDaemon()` logs the code and shows a panel notice instead of "Starting daemon..." (texts in Failure modes). `spawnViaExtendScript()` stays the fallback when CEP Node integration is missing.
- **Which route really runs.** In the real AE runs on both platforms (P5, P6) the panel started the daemon through `spawnViaNode` (`cp.spawn` with the runtime). `start.sh` and `start.ps1` run only on the ExtendScript fallback route, so they are rarely exercised in the field and need their own acceptance coverage (A14, A16).
- **Parent and lifetime.** The daemon is spawned detached but keeps a live parent: AE's `CEPHtmlEngine` (Windows: `CEPHtmlEngine.exe`, the renderer process, session 1), not pid 1. By design the daemon survives a panel close and the next panel load reuses it; in an earlier Mac session it also kept running after AE quit. Whether it should outlive AE, and what each platform actually does, is checked in acceptance case A25.

### 5. Launchers, `start.sh` and `start.ps1`

Both mirror `resolveDaemonLaunch` exactly and keep the output contract `pid:<N> runtime`, `pid:<N> node`, or `err:<code>` (`err:runtime-damaged`, `err:runtime-missing`). The `GAFFER_USE_BINARY` branch is removed. Both are only the fallback for the ExtendScript route (section 4, "Which route really runs"); the panel's normal route on Mac and Windows is `spawnViaNode`.

- `start.sh`: `env -u NODE_OPTIONS -u NODE_PATH -u NODE_EXTRA_CA_CERTS nohup "$NODE" daemon.mjs >> /tmp/gaffer-daemon.log 2>&1 &`. The stamp-less first run hashes with `shasum -a 256` and reads the pin with `grep`/`sed` (no jq on a stock Mac).
- `start.ps1`: does not use `Start-Process -Redirect*`. It runs `& $node launch.cjs` (new, about 30 lines, plain CommonJS so it runs on the runtime or a system node), which opens `%TEMP%\gaffer-daemon.log` in append mode, spawns `daemon.mjs` with `detached: true`, `windowsHide: true`, `stdio: ['ignore', fd, fd]` and the cleaned env, prints `pid:<N> runtime|node` and exits. Node passes only the named handles to the child, so the caller's pipe is never inherited. This removes the hang and the log truncation. File stays ASCII-only with a UTF-8 BOM.

### 6. Updaters, `update.sh` and `update.ps1`

Contracts kept: the single-updater lock, `ok:<version>`, `busy:already-running`, existing `err:` codes. Changes:

1. Archive check: require `version.json` and `daemon/daemon.mjs` (new archives always also carry `daemon/index.js`, so old and new checks both pass).
2. **Runtime step before any file is replaced.** Read the archive's `daemon/runtime-pins.json`. If the installed `runtime/VERSION` differs (or is absent, or the stamp check fails), run the archive's `fetch-runtime` steps 1 to 7 into `daemon/runtime.new` while the daemon still runs. Failure: delete `runtime.new`, print `err:runtime`, exit. The install is untouched.
3. Stop the daemon (existing stop logic). It must be stopped before the swap: a running `node.exe` cannot be overwritten or deleted, while renaming it aside works.
4. Swap the runtime (step 8). Then sync files.
5. Sync excludes gain the runtime folders: rsync `--exclude '/daemon/runtime' --exclude '/daemon/runtime.new' --exclude '/daemon/runtime.old'`; robocopy `/XD runtime runtime.new runtime.old` (proven: without them `--delete` and `/PURGE` delete the runtime). The `daemon/node_modules` exclude is removed on purpose, so the next sync deletes the 24 MB leftover tree.
6. **No npm.** The npm block and `err:npm` are removed from both scripts, as are the Node directory probes in `update.ps1`.
7. `version.json` is still written last.
8. Recovery at start: if `runtime` is missing and `runtime.old` passes the size check, rename it back before anything else (an updater killed between the two renames).

### 7. Migration from 0.11.x

Today's updaters (0.11.0 to 0.11.3) are what existing users run for their next update, and they cannot be changed. They refuse an archive without `daemon/index.js` and run `npm install --omit=dev` after the sync. So every release, for as long as 0.11.x clients exist (same invariant as `panel/version.json`):

- ships `daemon/index.js` as the one-line shim `import './daemon.mjs';`
- ships the dependency-free `daemon/package.json` above. npm then has nothing to install and succeeds. Measured in the integration check (npm 10.8.1, real 0.11.3 install): npm does NOT prune the old `node_modules`; it leaves the 24 MB tree in place. That is harmless, because nothing runs from it once `daemon.mjs` is bundled, and the next new-updater sync (which no longer excludes `node_modules`) deletes it.

| Who | Their updater | What happens | Node used afterwards |
|---|---|---|---|
| Existing user on 0.11.x, before R1 | old | nothing changes | system Node (README required it) |
| Existing user, update 0.11.x to R1 (first zero-dependency release, proposed v0.12.0) | old 0.11.x script | index.js check passes, files synced, npm runs with no dependencies, `version.json` written | system Node runs `daemon.mjs` (proven). Panel shows nothing new; the log says `launch: system node (no runtime yet)` |
| Same user, update R1 to R2 | new R1 script | runtime downloaded once (about 54 MB), verified, swapped; 2.2 MB package synced | bundled runtime. Strict zero-dependency from here on |
| User who skips R1 and goes 0.11.x to R2 | old | same as the R1 row | system Node until R3 |
| Fresh install at R1 or later | README / install page | package plus runtime, no Node anywhere | bundled runtime from the first launch |
| Fresh install before R1 | old README | needs Node, as today | system Node |
| Dev install (symlinked checkout) | updater refuses (unchanged) | developer runs `npm install` in the checkout | system Node + `index.js` |

Decision D6 offers a way to give existing users the runtime on R1's first launch instead of one release later.

### 8. Update flows

- **Runtime unchanged (the normal case).** Download the 2.2 MB update asset, verify, compare `runtime/VERSION` with the pins: equal, so no network call to nodejs.org or the mirror. Stop daemon, sync (runtime excluded), write `version.json`. The runtime file's hash, size and mtime are unchanged.
- **Runtime changed** (a release bumps `runtime-pins.json`, for example a Node security release). Download update asset, stage and verify the new runtime while the daemon still runs, stop daemon, swap runtime, sync, write `version.json`, delete `runtime.old`, warm up on Windows. Any failure before the swap leaves the install exactly as it was and prints `err:runtime`. Total download about 56 MB once.
- **Daemon self-restart.** Unchanged: the daemon never respawns itself. On a `version.json` content change it broadcasts `daemon_reloading` and exits; the panel relaunches it through `resolveDaemonLaunch`. The PoC showed the relaunch through the runtime 6 s after a forced change on the Mac (P5) and 6.7 s on Windows (P6, old daemon gone after 5.9 s), with the panel reconnecting.

### 9. Install paths

- **README** (`README.md` "What to do"): prerequisites drop Node (line 17 and the check at 42). New step order:
  1. Prerequisites: After Effects 2022 or later, Claude.
  2. Existing install check (unchanged).
  3. Detect the platform. Read-only, so the first permission prompt is small: `sysctl -n hw.optional.arm64` (macOS), `$env:PROCESSOR_ARCHITECTURE` (Windows).
  4. Download the Gaffer package with `curl -fsSL` / `curl.exe -fsSL`, verify it against `SHA256SUMS.txt` from the same release, extract (Windows `tar.exe -xf`, not `Expand-Archive`).
  5. Download the Node runtime from nodejs.org, the exact URL for the platform. The trigger sentence for the fallback: "If that download fails, for example because your network blocks nodejs.org, download the same file from Gaffer's mirror: <mirror URL>. The mirror is byte-identical: its SHA-256 equals the value in nodejs.org's SHASUMS256.txt for this file."
  6. Verify the SHA-256 against the value written on the page.
  7. Extract only the binary with the exact command, then delete the archive.
  8. Verify the signature as a numbered step: `codesign --verify --strict` and `codesign -dv` showing `TeamIdentifier=HX7739G8FX` (Node.js Foundation); Windows `Get-AuthenticodeSignature` showing `Valid` and `OpenJS Foundation`. "If nodejs.org is unreachable, the code signature is the independent check." Then `node --version` from the runtime path (the Windows warm-up).
  9. Enable the CEP developer-mode flag, named as "a user preference that lets After Effects load extensions that are not signed through Adobe; it installs nothing".
  10. Find Claude and optionally pin it. The `node -e` merge (line 135) becomes `"$INSTALL_DIR/daemon/runtime/node" -e '...'`, so even this step needs no system Node.
  11. MCP registration, per decision D1.
  12. Restart AE, verify.
  The rules block gains: "Do not install Node.js any other way (Homebrew, nvm, npm, installers) and do not change proxy or network settings. If both downloads fail, stop and tell the user." The step 4 npm block and the troubleshooting entries about Node (184-188) go away.
- **Website install page.** Generated by `scripts/site/build-install-md.mjs` on the `feat/landing-page` branch, not on `main`. Follow-up for that session: read URLs, hashes and the Team ID from `panel/daemon/runtime-pins.json` and the release's `SHA256SUMS.txt`, never hand-copied, and use the README step order and wording above.
- **`scripts/install-mac.sh` / `install-win.ps1`** (dev, from a checkout): keep the symlink (Mac) and copy (Windows), drop the Node requirement for the copy case by calling `fetch-runtime` when the install is a copy, and keep `npm install` only for the symlinked dev case. Any npm call in dev tooling sets `npm_config_cache=<repo>/.npm-cache`, `npm_config_logs_dir=<repo>/.npm-cache/_logs` and `npm_config_userconfig=<repo>/.npmrc-dev` so nothing lands in the developer's home either. `install-win.ps1` robocopy gains `/XD .remember runtime`.

### 10. Release and CI build

`scripts/package-release.sh` new staging order:

1. `git archive HEAD:panel | tar -x -C "$STAGE"`, remove `daemon/test`, `daemon/test-fixtures`, `daemon/node_modules`, `daemon/package-lock.json`, `.remember` (git archive never sees it today; the explicit rule protects a future switch to copying the working tree), and every daemon `.js` source module except `index.js` and `launch.cjs`, since they are inside the bundle.
2. Write `daemon/daemon.mjs` (from step 1 of section 1), the shim `daemon/index.js`, the dependency-free `daemon/package.json`, `THIRD-PARTY-NOTICES.txt`.
3. Stamp `version.json` (unchanged).
4. Assert: no `node_modules`, no `.map`, no `package-lock.json`, no `test` dir, no `.remember`; the stage starts `daemon.mjs` with no other `.js` modules beside it.
5. Build the four archives (unchanged names) and `SHA256SUMS.txt` over them.

`.github/workflows/release.yml`:

- `build` job: Node 24 instead of 20; after the tests, run bundle, notices, hygiene, `npm audit`, package. Upload `meta.json` and the source map as a separate CI artifact (`gaffer-debug`, 30-day retention).
- New `smoke` job (`needs: build`), matrix `macos-15` (arm64), `macos-15-intel`, `windows-latest`: download the official Node archive per platform, verify against the pins, extract the single binary, check the signature, start the packaged `daemon.mjs` with PATH stripped and no `node_modules`, run the parity script (handshake, MCP initialize, tools/list hash equals source, runJSX capture hash equals source, undo-group stripping, 60 s timeout), run the daemon suite from the checkout with that runtime. These are the PoC's R1 to R8 runs, made permanent. `publish` needs both jobs.
- `publish`: uploads five assets (`SHA256SUMS.txt` added). `scripts/release-gate.mjs` "all assets present" list grows to five.

New `.github/workflows/node-runtime-check.yml`, weekly (Monday 08:30 UTC) and manual, read-only like `cli-contract.yml`:

- Fetch `https://nodejs.org/dist/index.json`; fail when an entry on the pinned major line is newer than the pin and has `security: true`, or when the line's `lts` field is false.
- Fetch the pinned version's `SHASUMS256.txt`, verify its GPG signature with the Node release keys, and fail if any pinned `archiveSha256` differs.
- Download the mirror assets and fail if any byte differs from the official archive.
- Fail if `releases/latest` resolves to a tag that is not a Gaffer `v*` release (guards against the mirror release becoming "latest").

`scripts/release-docs.test.mjs` gains: every URL, hash and Team ID in `README.md` equals `runtime-pins.json`.

### 11. Mirror

A normal versioned GitHub release `node-v24.22.1` on `spendolas/gaffer-ae`, created with `gh release create node-v24.22.1 --latest=false`, carrying the three official archives byte for byte plus nodejs.org's `SHASUMS256.txt` and `SHASUMS256.txt.sig`. Release notes: "Byte-identical copy of the official Node.js v24.22.1 archives from https://nodejs.org/dist/v24.22.1/, for networks that cannot reach nodejs.org. Gaffer's installer uses it only if the official download fails. Verify with SHASUMS256.txt." `--latest=false` is required: GitHub otherwise marks the newest release as latest, which would break every `releases/latest/download/gaffer-*` URL and the panel's update check. The tag does not match `v*`, so `release-gate.mjs` ignores it. Its `download_count` doubles as a measure of how often the fallback is used. The node mirror has the Node.js license inside each archive, which covers redistribution. The agent trials (P4) used a temporary mirror; the real one must be a normal versioned release named after the Node version, never labelled as a test or trial, because agents judge the source partly by how it looks (Opus called the trial mirror "not an official source").

### 12. Bug fixes in the same change

- `panel/daemon/ports.js` (new): `WS_PORT = 9823`, `MCP_PORT = 9824`, `mcpUrl()`. Used by `index.js` and `chat-handler.js` 892.
- `mcp-server.js`: `app.listen(port, host, (err) => { if (err) return reject(err); ... })`, so EADDRINUSE reaches `index.js`'s "port in use, daemon already running, exiting" and the process exits 0.
- `update-wiring.test.mjs`: skip the panel-capture assertion when `design/` is absent, so the suite passes from a packaged tree.

## Security model and trust chain

1. **Gaffer package.** Built by CI from `main` (owner-only push), published as release assets, with `SHA256SUMS.txt`. Same trust as today; the checksum adds transport integrity and gives agents something to verify.
2. **Pins.** `runtime-pins.json` travels inside the package, so trusting the package means trusting the pinned hashes. The weekly job checks those hashes against nodejs.org's GPG-signed `SHASUMS256.txt`.
3. **Runtime bytes.** The archive hash pins exact bytes, so the mirror cannot change the binary: a compromised mirror can only fail the hash check.
4. **Vendor signature.** Independent of us: Apple Developer ID "Node.js Foundation", Team ID HX7739G8FX, hardened runtime; Authenticode "OpenJS Foundation", Microsoft timestamp. The binary is never modified, so the signature stays valid. Proven: a stripped signature is killed by Gatekeeper with exit 137, which is why "never modify" is a rule, not a preference.
5. **Stamp.** `VERIFIED` guards against corruption and truncation (proven: truncated and tampered copies rejected), not against an attacker who can already write to the user's folders. The launcher checks size only, because hashing 125 MB costs 0.7 to 3.2 s per launch.
6. **Environment.** `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS` are cleared: a hostile or broken `NODE_OPTIONS` executed a preload, opened an inspector, or stopped Node starting while the launcher reported success.
7. **No PATH exposure.** The runtime is called by absolute path only, so no other program picks it up.
8. **Out of scope** (unchanged from today): a compromised GitHub account, malware running as the user.

**Firewall (tested, P7).** Windows Firewall keys its rules to the program path, and `runtime\node.exe` is a new path. Tested on the VM with the firewall on for Domain, Private and Public and `NotifyOnListen` True:

- A `node.exe` at a new path that listens only on 127.0.0.1 gets no "Do you want to allow public and private networks to access this app?" prompt and no firewall rule. The real daemon bundle (127.0.0.1 only) did not trigger one either.
- A `node.exe` listening on 0.0.0.0, or with no address (all interfaces, `::`), does trigger the prompt, and when the prompt is dismissed or left unanswered Windows creates two block rules for that exact path.

Consequences:

1. The zero-dependency design shows no firewall prompt on Windows because the daemon binds only 127.0.0.1 (true since v0.11.2; before that the panel WebSocket listened on all interfaces, so every Windows user would have seen this prompt at the first daemon start).
2. Regression guard: the acceptance test asserts that every listener of the daemon is loopback-only and that no firewall prompt appears on the first launch on a clean Windows machine (case A23).
3. Rule: any future listener (a diagnostics port, `--inspect`, a dev server) must bind 127.0.0.1 explicitly. Never rely on a default address.
4. Stale auto-created block rules for deleted paths are harmless, but removing them needs admin rights, so Gaffer never tries.

On macOS this is not proven: the application firewall was off on the test Mac, and the owner's personal firewall asked once, for the Claude binary. Third-party Mac firewalls (Little Snitch, LuLu) also key rules to the program path, so `runtime/node` may prompt once there (its outbound calls are the update check and telemetry); case A20 records it. Separately, the desktop app's bundled `claude` lives in a versioned folder that changes on every Claude app update, so such users already see a new prompt after each Claude update (true since v0.11.2).

## Failure modes

| Failure | Where | What the user sees | Recovery |
|---|---|---|---|
| nodejs.org blocked, mirror fine | install, update | install: agent says it used the mirror and verified the hash and signature. update: nothing; log line | none needed |
| Both sources unreachable | install | agent stops: "Could not download the Node runtime from nodejs.org or Gaffer's mirror. Check your network and try again." | retry later |
| Both sources unreachable | update | panel: "Update failed: could not download Gaffer's runtime. Your current version still works." (`err:runtime`) | retry later; install untouched |
| Hash mismatch | install, update | as above, with "the download did not match the expected checksum" | retry; nothing installed |
| Signature check fails | install, update | "The Node runtime's signature could not be verified. Nothing was installed." | stop, report |
| Disk full during staging | update | `err:runtime`, install untouched | free space |
| Runtime truncated or wrong size at launch | panel | "Gaffer's runtime is damaged. Open Settings and run Update to repair it, or reinstall." Status stays disconnected, no silent fallback | update (the stamp check fails, so the updater re-provisions even when the version is current) |
| Runtime deleted (for example by antivirus) | panel | "Gaffer's runtime is missing. Open Settings and run Update, or reinstall." (when no system node exists) | same |
| Exec bit lost (macOS) | panel | nothing; launcher restores it and logs it | automatic |
| Gatekeeper kills the runtime (exit 137) | panel | "macOS blocked Gaffer's runtime. Reinstall Gaffer." plus the log line | reinstall |
| Port already in use (double start, reload race) | daemon | nothing; second daemon logs "port 9824 in use, daemon already running, exiting" and exits 0; panel connects to the first | automatic |
| Hostile `NODE_OPTIONS` | launch | nothing; variable cleared | automatic |
| Updater killed between renames | update | next update or launch finds `runtime.old`, restores it | automatic |
| Wrong-architecture runtime (Mac migrated Intel to Apple Silicon) | launch | runs under Rosetta if installed; else the damaged/missing notice | updater re-provisions because `VERSION` names the platform |
| Stale Claude login (expired OAuth token, failed refresh) | panel open | the sign-in screen: the daemon's auth-status call makes the claude CLI try a token refresh, and a failed refresh leaves empty tokens in `.credentials.json` (seen on the VM 13 s after daemon start) | sign in to Claude again. Not caused by the runtime; acceptance prep E6 signs in freshly |
| Panel or daemon listener on a non-loopback address | first launch, Windows | Windows Firewall prompt; unanswered, two block rules for the path | prevented by the loopback-only rule (Security model, Firewall); case A23 guards it |

## Size and speed

| Measure | Today | Zero-dependency |
|---|---|---|
| Update download | 903 KB archive plus a 24 MB npm install (95 packages, 3,431 files) | 2.16 MB archive, no npm |
| First install download (mac x64) | 903 KB plus npm, plus a separate Node install | about 56.5 MB (54.4 MB Node archive plus package) |
| On disk | 24 MB `node_modules` plus system Node | 2.5 MB bundle plus 125.7 MB (mac x64), 122.5 MB (mac arm64) or 93.9 MB (win-x64) runtime |
| Time to listening, Mac Intel | 680 ms | 460 ms |
| Daemon RSS, Mac Intel | 95 MB | 81 MB |
| Time to first listen, Windows VM | 12.3 s | 1.1 s |
| Longest path under the extension, Windows | 109 chars | 26 chars |

## Rollback

Users install updates when the panel offers them, and the offer only goes to a newer version, so rollback is always a roll forward:

- **Bad bundle or panel code, runtime unchanged.** Revert on `main`, bump the patch version, push through the full verification order. The updater replaces `daemon.mjs` and the panel files; the runtime stays because its `VERSION` is unchanged. Users who never took the bad release see nothing.
- **Bad runtime pin.** The fix release pins the previous good Node version. `VERSION` differs, so the updater re-provisions it (a downgrade is just another runtime change).
- **Broken publish.** Delete the release assets only with the owner's explicit approval; the gate's `recover` path republishes. The previous release stays the latest until a newer one is complete, because publishing goes through a draft.
- **Emergency for existing users.** Because the shim and the dependency-free `package.json` stay in every release, a 0.11.x client can always take the roll-forward release with its old updater.

## Proof evidence

| # | Where | What ran | Result |
|---|---|---|---|
| P1 | Mac Intel PoC, 14 tests | build; run with `env -i` and no `node_modules`; signature kept; paths with spaces and accents; truncated and tampered copies rejected; parity bundle vs source (handshake, 403s, register/auth_status, MCP initialize, tools/list with 26 tools, runJSX and runJSXLoop JSX to a mock panel including acorn undo-group stripping, 60 s timeout); chat turn end to end both variants; launcher cases; fresh-HOME footprint; daemon suite under Node 24 and 20; self-restart and atomic bundle swap; source maps; sizes; licenses; download routine vs wrong hash, truncation, HTML error page, no network; quarantine on the whole tree; stripped signature | all pass. Build 0 errors, outputs byte-identical, 324/324 tests, only Gaffer's config dir created, 460 vs 680 ms, 81 vs 95 MB RSS, 77 packages all MIT/ISC/BSD, quarantine runs, stripped signature exit 137 |
| P2 | Windows 11 Home VM, Defender on, 10 tests | single `node.exe` from the zip via `tar.exe`; Authenticode; Mark-of-the-Web from curl.exe, Invoke-WebRequest, WebClient; PATH stripped to System32; parity; time to listen; Defender/SmartScreen events; update locking; path lengths; footprint; unit tests | all pass. 0.5 s extract, signature Valid, no MotW from any of the three, tool list sha256 `68693916750f82147194bef71e6c39926e8b8886004662567653b2d1feab8223` (36,641 bytes), runJSX capture sha256 `db239664e741baa4ca260e0b29251f91fbc910c67c478529dc941d2b76717faf` (2,465 bytes), 1.1 s vs 12.3 s, no events, 26 vs 109 char paths, nothing outside the test folder, 315/316 (one packaging artifact, fixed in section 12) |
| P3 | GitHub runners macos-15 (M1), macos-15-intel, windows-latest | R1 to R8 on a throwaway branch (deleted) | all pass with identical tool-list and JSX hashes, 324/324 on all three, arm64 binary is arm64 and signed. Gatekeeper UI and Defender real-time not exercised. Full record of the same run in P8 |
| P4 | Clean Claude sessions, Sonnet and Opus, Claude Code auto and manual mode, node and npm hidden, nodejs.org blocked via a dead proxy | 10 clean-session runs, install with and without mirror wording | 6 of 6 auto runs offered the mirror used it with the hash verified; Sonnet never objected; Opus always accepted, but ran `codesign` unprompted and said the mirror was "not an official source" and that "the hash came in the same instructions"; with no fallback (V4) both models stopped and reported, none improvised; 0 of 10 runs attempted any install outside the working folder; Opus noted the missing package checksum; in manual mode the download was the first approval prompt and both agents stopped there and printed the commands. Total spend $0.66 |
| P5 | Real After Effects 2026 (26.0), owner's Intel Mac on macOS 26, PoC panel in strict mode (system-node fallback disabled by a `daemon/runtime/STRICT` file) | panel's own `spawnViaNode`, MCP call, chat turn, forced reload | the panel launched `<ext>/daemon/runtime/node daemon.mjs`; daemon executable was the runtime, no file from any system node tree open (`lsof`), no `NODE_*` in env (`ps -E`), `USER`/`HOME` present; parent CEPHtmlEngine (detached, but a live parent, not pid 1); log lines in order; `claude found (desktop app)` 2.1.308; MCP initialize `serverInfo` showed the PoC version; `getProjectSummary` answered in real AE ("No active composition"); chat turn with a tool call `turn=ok via=structure` (Claude 2.1.308, opus); changing the content of `version.json` made the daemon exit and the panel relaunch it through the runtime in about 6 s (`serverInfo` changed to the new version), panel reconnected. Panel viewport 350x500 at devicePixelRatio 2, fonts confirmed loaded via the CEP debug port. A first-run display distortion was an AE/CEF resize quirk fixed by nudging the dock, unrelated |
| P6 | Real After Effects 26.5, Windows 11 Home VM, Defender real-time ON, stock firewall, Windows PoC panel in strict mode | panel's own spawn, process and network checks, MCP call, real chat turn, forced reload, Defender and SmartScreen events, staged restore and live-panel swap | runtime `daemon\runtime\node.exe` v24.22.1, 93,915,464 bytes, sha256 `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5`, Authenticode Valid, OpenJS Foundation. Daemon exe = the runtime, command line `runtime\node.exe daemon.mjs`, parent `CEPHtmlEngine.exe` (renderer), session 1, no window owned by the daemon; listens only on 127.0.0.1:9823 and :9824 (0 non-loopback); 46 env variables, no `NODE_*`, `PATH`, `APPDATA`, `USERNAME`, `USERPROFILE` intact; log lines in order, `claude found (known location)` standalone 2.1.268; error log 0 bytes; MCP initialize `serverInfo` PoC version; `getProjectSummary` answered "No active composition". Forced restart via `version.json` content change: old daemon gone after 5.9 s, new daemon on 9823 after 6.7 s, again through the runtime, panel reconnected. Defender 0 detections, 0 SmartScreen events; one Windows error-reporting event RADAR_PRE_LEAK_64 for AfterFX.exe (AE's own memory-use monitor, unrelated to Node or Gaffer). The owner signed in to Claude in the VM and ran a real chat turn with a tool through the panel: `chat spawn: --model opus --effort medium ... cli=2.1.268 source=standalone`, then `turn=ok via=structure exit=0`; the answer used the tool and matched the empty project, so the cleaned env (`NODE_*` removed) did not break `claude.exe`. The panel showed as a floating panel window in AE. No console window flash was reported, but the owner did not watch the VM screen during the first launch: "no console flash" on Windows rests on the earlier automated EnumWindows and screenshot test (W4 in the Windows PoC runs) until case A24 checks it by eye. Staged restore steps and the live-panel swap worked as designed (the live `com.gaffer.panel` must be moved out of the CEP extensions folder: a leftover sibling folder with the same bundle id can be loaded twice) |
| P7 | Windows 11 Home VM, Windows Firewall on for Domain, Private and Public, `NotifyOnListen` True | a fresh `node.exe` path listening on 127.0.0.1; the real daemon bundle; a `node.exe` listening on 0.0.0.0 and on no address (all interfaces, `::`) | 127.0.0.1 only: no prompt, no rule (both the test listener and the real daemon). 0.0.0.0 or no address: the "allow public and private networks" prompt appeared (owner saw it, screenshots), and dismissing or not answering it made Windows create two block rules for that exact path. See Security model, Firewall |
| P8 | GitHub hosted runners: macos-15 (Apple M1 arm64, macOS 15.7.9), macos-15-intel (x86_64), windows-latest (Windows Server 2025), one throwaway branch (deleted), run https://github.com/spendolas/gaffer-ae/actions/runs/39806281902 | R1 to R8 | all pass on all three. arm64 archive 53,062,778 bytes, sha256 `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7` verified; extracted arm64 `node` 122,545,856 bytes, Mach-O arm64, sha256 `6f320694...f329` (only the first 8 and last 4 hex digits were logged; the first acceptance run records the full value), signed Developer ID Node.js Foundation HX7739G8FX with hardened runtime. A quarantined binary runs directly and via `/bin/bash -c` with `env -i` on both Macs (Gatekeeper assessments enabled, but no logged-in GUI session, so the dialog path is not exercised). Unit tests 324/324 under the bundled Node 24 on all three. tools/list sha256 `68693916750f82147194bef71e6c39926e8b8886004662567653b2d1feab8223` (36,641 bytes, 26 tools) and runJSX capture sha256 `db239664e741baa4ca260e0b29251f91fbc910c67c478529dc941d2b76717faf` (2,465 bytes), identical on arm64, Intel, Windows, the owner's Intel Mac and the Windows VM. Startup 172 to 294 ms arm64, 547 to 685 ms Intel, 214 to 258 ms Windows. Footprint: nothing Gaffer-named outside the workspace (Windows: only CryptnetUrlCache entries created by `Get-AuthenticodeSignature` itself). Defender real-time was OFF on the runner, so first-run scan latency is measured only on the VM (5.6 s for the first run of a fresh 94 MB `node.exe` with Defender ON, section 3 step 7) |

## Open risks and how each closes before release

Proven since the first draft and removed from this table: real AE on Windows with the bundled runtime, including a real chat turn with a tool (P6), and the Windows Firewall behaviour for a loopback-only daemon (P7). Still unproven:

| Risk | Closed by |
|---|---|
| Real Apple Silicon hardware with a real AE launch and the Gatekeeper dialog (runners have no GUI session, P8) | acceptance case A4 on an Apple Silicon Mac (owner or a tester) before the bump push |
| Browser-downloaded Gaffer package with real quarantine propagation through Archive Utility | case A17 with Safari and Archive Utility |
| Installer flow end to end by a real Claude agent against the NEW release assets (only the runtime-download step was tested, with a temporary pre-release that has since been deleted) | cases A1 to A3 against a temporary prerelease of the candidate |
| Windows 10, Windows ARM, third-party antivirus | Windows 10: a second VM or a tester, case A1 on it. ARM: decision D5. AV: one tester with a common suite; until then a known risk in the release notes |
| Roaming or redirected `%APPDATA%` carrying a 94 MB `node.exe` | decision D8; documented in README troubleshooting either way |
| Firewall prompt on Mac with a third-party firewall (the application firewall was off on the test Mac; the owner's personal firewall asked once, for the Claude binary) | case A20 (note only, Little Snitch or LuLu if available). Windows is covered by P7 and guarded by case A23 |
| Fallback-mirror wording under a silent DNS failure or TLS interception (only a dead proxy was tested) | case A19 variants b and c |
| "No console window flash" on Windows seen by a human (P6 first launch was not watched; only the automated W4 test covers it) | case A24 |
| Daemon lifetime when the panel closes and when AE quits (survives panel close by design; behaviour on AE quit not verified on either platform with the runtime) | case A25 |
| Who owns Node security releases | decision D3; the weekly job makes the need visible |
| Existing users reach strict zero-dependency only one release later | by design; decision D6 offers a first-launch provisioning path |
| Corporate users who rely on `NODE_EXTRA_CA_CERTS` for Claude | decision D7 |

## Decisions needed from the owner

- **D1. MCP registration.** `claude mcp add -s user` writes into the user's Claude config (`~/.claude.json`), outside the allowed set, and the panel does not need it (it passes its MCP config inline). Proposal: make README step 11 opt-in ("only if you want Gaffer's tools in a terminal Claude session"), off by default, and have `install-mac.sh` ask instead of doing it.
- **D2. Mirror.** Ship it (proposal: yes, section 11) or not, and where: a `node-v<version>` release on `spendolas/gaffer-ae` (proposal), a separate repo such as `spendolas/gaffer-runtime`, or assets on each Gaffer release (bloats every release, no). Whatever the location, it is a normal versioned release, never one labelled test or trial (section 11).
- **D3. Node line policy and owner.** Proposal: stay on the current LTS line (24 today); take every security release of that line within 7 days of the weekly job failing; move to the next LTS when it enters Active LTS and has been out three months. Who acts on the weekly failure email: the owner, or a scheduled agent that prepares the bump PR for the owner to review.
- **D4. ZXP signing** to drop the developer-mode flag: separate project, yes or no, and when.
- **D5. Architecture.** macOS: hardware arch via `hw.optional.arm64` (proposal). Windows ARM: refuse with a clear message (proposal for R1), or use `win-x64` under emulation, or pin `win-arm64` too (more pins, one more CI runner).
- **D6. Existing users' runtime timing.** By design they get the runtime on R2. Alternative: R1's panel, on its first launch without a runtime on a non-dev install, runs the new `fetch-runtime` in the background and switches on the next launch. Faster, but a 54 MB download the user did not click for.
- **D7. Corporate CA certificates.** Clearing `NODE_EXTRA_CA_CERTS` from the daemon also removes it from the `claude` child, and Claude Code honours it behind TLS-inspecting proxies. Proposal: the launcher passes the original value as `GAFFER_CLAUDE_EXTRA_CA_CERTS`, and `chat-handler.js` restores it as `NODE_EXTRA_CA_CERTS` only in the Claude child's env.
- **D8. Windows roaming profiles.** Accept `%APPDATA%` (roaming) for the runtime, as the extension folder already is, or allow a third location `%LOCALAPPDATA%\Gaffer\runtime` for the runtime only. The second keeps 94 MB out of roaming sync but widens the allowed set.
- **D9. Package checksums on the README.** CI computes `SHA256SUMS.txt` after the push, so `main`'s README cannot quote it unless packaging becomes reproducible (fixed mtimes, sorted entries, `gzip -n`). Proposal: README tells the agent to verify against the release's `SHA256SUMS.txt`; the site install page, built after each release, quotes the values.
- **D10. Version number** of R1. Proposal: v0.12.0.

## Rollout: one release

Everything ships in R1: bundle, runtime pins, fetch scripts, launchers, updaters, README, CI, notices, bug fixes. Splitting it does not help:

- Prebuilt dependencies alone (shipping `node_modules` or the bundle without the runtime) remove npm but still need Node on the machine, so the README still says "install Node.js" and requirement 1 is not met for anyone. It also changes the updater contract once for the bundle and again for the runtime, two migrations instead of one.
- The runtime alone, without the bundle, would still need `npm install` to produce `node_modules`, which needs npm, which the runtime-only download does not include.
- Only the combination removes the prerequisite. The one staging that cannot be avoided, existing users getting the runtime one release later, comes from their old updater, not from a choice of rollout.

Verification order (owner constraint 6), all before the version-bump push to `main`:

| Gate | What | Who runs it | Evidence |
|---|---|---|---|
| G1 | `gh workflow run release.yml -f dry_run=true` on the release branch; `build` and `smoke` green; download the `gaffer-release` artifact | agent in the repo | run URL, artifact SHA-256 list, smoke matrix hashes equal to the P8 values (tools/list `68693916...8223`, runJSX capture `db239664...7faf`) or an explained difference, the full arm64 `binarySha256` |
| G2 | full Linux test set (the dry run's ubuntu `build` job, plus the same commands in a `node:24` container locally) | agent | job log, local output |
| G3 | real update on a Mac: v0.11.3 install to the candidate with the old updater, then candidate to a synthetic candidate+1 with the new updater, both using only the dry-run assets | agent drives, owner present for AE | `ok:` lines, marker diffs, runtime hashes, panel screenshot |
| G4 | same on `gaffer-winvm` | agent via `guestcontrol`, owner approves | same, plus the listener list (loopback only), the firewall rule check and the owner's note that no firewall prompt or console window appeared (A23, A24) |
| G5 | acceptance cases A1 to A26 that are marked "release gate" in the plan | agent and owner | completed results table, with a fresh Claude sign-in recorded for every chat case (plan E6) |

Then the push: bump `panel/version.json`, add the `CHANGELOG.md` section, push to `main`. The workflow publishes; nothing is tested for the first time after that point.

## Files touched

- [ ] `panel/main.js` (`resolveDaemonLaunch` with Windows path normalisation and the `start.ps1` fallback candidates, `cleanDaemonEnv` case-insensitive on Windows, `launchDaemon`, notices)
- [ ] `panel/daemon/start.sh`, `start.ps1` (ASCII, BOM), `launch.cjs` (new)
- [ ] `panel/daemon/update.sh`, `update.ps1` (ASCII, BOM)
- [ ] `panel/daemon/fetch-runtime.sh`, `fetch-runtime.ps1` (new, ASCII, BOM), `runtime-pins.json` (new)
- [ ] `panel/daemon/ports.js` (new), `index.js`, `mcp-server.js`, `chat-handler.js`
- [ ] `panel/daemon/package.json` (drop `@yao-pkg/pkg`; dev package stays, packaged one is generated)
- [ ] `panel/daemon/test/update-wiring.test.mjs`, new tests for launch resolution, env cleaning, fetch-runtime and the listen fix
- [ ] `scripts/bundle-daemon.sh` (new), `scripts/third-party-notices.mjs` (new), `scripts/build.sh` (SEA removed)
- [ ] `scripts/package-release.sh`, `scripts/package-release.test.mjs`, `scripts/release-gate.mjs` (five assets), `scripts/release-docs.test.mjs`
- [ ] `scripts/install-mac.sh`, `scripts/install-win.ps1`
- [ ] `.github/workflows/release.yml`, `.github/workflows/node-runtime-check.yml` (new)
- [ ] `.gitignore` (`panel/daemon/runtime*/`, `panel/daemon/daemon.mjs`, `.npm-cache/`)
- [ ] `README.md`, `CLAUDE.md` (architecture, layout, releasing), `CHANGELOG.md`
- [ ] Follow-up on `feat/landing-page`: `scripts/site/build-install-md.mjs`
- [ ] Owner action: create the `node-v24.22.1` mirror release with `--latest=false` (after D2)
