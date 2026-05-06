# Gaffer AE — Panel cannot auto-start daemon on Apple Silicon (M2)

**Repo:** https://github.com/spendolas/gaffer-ae
**Affected version:** v0.2.0 (commit `b7ffb28446cfeac0fa923a13dbfb7ecb69d894f1`)
**Severity:** Blocking on affected hardware — install completes successfully, panel loads, but never reaches the "Connected" state, so no MCP tools are usable.

---

## TL;DR

On Apple Silicon Macs, the panel's `startDaemon()` calls `system.callSystem("bash .../start.sh")` via ExtendScript and the daemon never starts — no log file is written, no port is bound, no error is reported. Replacing the `system.callSystem` invocation with a direct Node `child_process.spawn` (the manifest already enables `--enable-nodejs --mixed-context`) fixes it on Apple Silicon and is functionally equivalent on Intel.

---

## Environment

| Field | Value |
|---|---|
| OS | macOS (Darwin 25.4.0) |
| Architecture | arm64 (Apple M2) |
| AE versions installed | 2025 (25.6) and 2026 (26.0, 26.2) |
| Node | v25.9.0 (arm64, Homebrew at `/opt/homebrew/bin/node`) |
| Claude Code | 2.1.118 |
| Gaffer install path | `~/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel` |

A second machine — Intel Mac running the same AE version — installs and runs Gaffer correctly with the same install procedure. The only delta between the working and failing machine is CPU architecture (and consequently the Homebrew prefix: `/usr/local/bin` vs `/opt/homebrew/bin`).

---

## Reproduction

1. Follow the README install instructions exactly (no deviations).
2. Restart AE.
3. Open `Window > Extensions > Gaffer`.

**Expected:** panel shows "Connected" within ~2 seconds.
**Actual:** panel stays at "Starting..." → "Disconnected", forever.

---

## Investigation

### What we observed

- `/tmp/gaffer-daemon.log` did **not exist** after panel load — so `start.sh` never reached its `nohup ... > /tmp/gaffer-daemon.log` redirect (or never ran at all).
- `lsof -i :9824` and `lsof -i :9823` showed nothing — daemon never bound either port.
- The `evalScript` callback in the patched panel did fire (we added a `console.log`), so CEP did call into ExtendScript. The failure is downstream of `system.callSystem`.

### Manual confirmation that the daemon itself is fine

Running the launcher script directly from a terminal works perfectly:

```
$ cd ~/Library/Application\ Support/Adobe/CEP/extensions/com.gaffer.panel/daemon
$ bash start.sh
pid:48106 node

$ cat /tmp/gaffer-daemon.log
Gaffer daemon: MCP on http://127.0.0.1:9824/mcp, panel bridge on ws://127.0.0.1:9823
Gaffer: panel bridge on ws://127.0.0.1:9823
Gaffer: MCP on http://127.0.0.1:9824/mcp

$ lsof -i :9824
node 48106 user TCP localhost:9824 (LISTEN)
```

After the daemon was started this way, **the panel reconnected immediately** and showed "Connected". This proves:

- The downloaded code is intact.
- `npm install` produced working `node_modules` for arm64.
- The daemon binds the right ports and the panel WebSocket reconnect logic is fine.
- The single failure point is the panel's *spawning* of the daemon.

### Root cause hypothesis

`system.callSystem` from ExtendScript on Apple Silicon AE 2025/2026 is not reliably executing the `bash .../start.sh` command. The lack of any log output and the lack of any error makes this look like a silent failure inside the ExtendScript-to-shell bridge — likely a hardened-runtime / sandboxing / entitlements interaction that differs between Intel and Apple Silicon AE. We did not chase the exact Adobe-side reason because the fix below sidesteps the issue entirely and is preferable on its own merits (cross-platform, no shell quoting, structured errors).

---

## Fix

Spawn the daemon directly from the panel using Node's `child_process.spawn`. The manifest already declares:

```xml
<CEFCommandLine>
  <Parameter>--enable-nodejs</Parameter>
  <Parameter>--mixed-context</Parameter>
</CEFCommandLine>
```

so `require('child_process')` is available inside `main.js`. This eliminates the `system.callSystem` round-trip and works identically on macOS (Intel + Apple Silicon) and Windows.

### Diff for `panel/main.js`

Replace the body of `startDaemon()`:

```js
function startDaemon() {
  if (daemonStartAttempted) return;
  daemonStartAttempted = true;
  setStatus('starting', 'Starting daemon...');

  var extPath = cs.getSystemPath(SystemPath.EXTENSION);
  var daemonDir = extPath + '/daemon';

  // Spawn directly via Node (manifest enables --enable-nodejs --mixed-context).
  // Avoids ExtendScript system.callSystem, which fails silently on
  // Apple Silicon AE without producing a daemon log.
  try {
    var cp = require('child_process');
    var fs = require('fs');
    var isWin = process.platform === 'win32';

    var nodeBin = null;
    var candidates = isWin
      ? ['node.exe', 'node']
      : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      try {
        if (isWin || (c.charAt(0) === '/' && fs.existsSync(c))) {
          nodeBin = c;
          break;
        }
      } catch (e) { /* keep looking */ }
    }
    if (!nodeBin) nodeBin = isWin ? 'node' : '/usr/bin/env';
    var args = (nodeBin === '/usr/bin/env') ? ['node', 'index.js'] : ['index.js'];

    var logPath = isWin
      ? (process.env.TEMP || 'C:\\Windows\\Temp') + '\\gaffer-daemon.log'
      : '/tmp/gaffer-daemon.log';
    var out = fs.openSync(logPath, 'a');
    var err = fs.openSync(logPath, 'a');

    var child = cp.spawn(nodeBin, args, {
      cwd: daemonDir,
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
    });
    child.on('error', function (e) {
      console.error('Gaffer: daemon spawn error', e);
    });
    child.unref();
    console.log('Gaffer: daemon spawned, pid=' + child.pid + ' via ' + nodeBin);
  } catch (e) {
    console.error('Gaffer: startDaemon failed (Node integration unavailable?):', e);
  }
}
```

### Why this is safe / equivalent

- **Detachment:** `detached: true` + `child.unref()` + `stdio: ['ignore', logFd, logFd]` makes the daemon outlive the panel — same outcome as `nohup ... &`.
- **Logging:** writes to the same `/tmp/gaffer-daemon.log` (or `%TEMP%\gaffer-daemon.log`) the existing `start.sh` and `start.ps1` scripts use, so existing troubleshooting docs ("check `/tmp/gaffer-daemon.log`") still apply.
- **Node discovery:** mirrors the existing fallback list in `start.sh` (`/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`) and adds `/usr/bin/env node` as a last resort so users with non-standard installs (nvm/fnm/Volta) still work as long as `node` is on PATH.
- **Error reporting:** failures now surface in CEP DevTools (`console.error`), which the existing code path swallows because `system.callSystem` returns a string and never throws.

### Verified locally

Tested on the affected M2 machine after applying the diff above:

1. Killed the manually-started daemon (ports 9823/9824 freed).
2. Reloaded the panel via the in-panel reload button.
3. Within ~1s the panel transitioned `Starting... → Connected`.
4. `/tmp/gaffer-daemon.log` was created, `lsof -i :9824` showed `node` listening.
5. `claude mcp list` showed `gaffer ✓ Connected`.

---

## Secondary issues to consider

These are not blocking but were noticed during debugging:

### 1. `runUpdate()` in `panel/main.js` has the same `system.callSystem` pattern

The in-panel update flow uses the identical broken pattern:

```js
'if (isWin) return system.callSystem("powershell -ExecutionPolicy Bypass -File \\"" + dir + "/update.ps1\\"");'
+ 'return system.callSystem("bash \\"" + dir + "/update.sh\\"");'
```

Once a v0.1.0 user on Apple Silicon manually upgrades to v0.2.0, the in-panel "Update" button will silently fail for them too. Recommend porting `runUpdate()` to `child_process.spawnSync` (with a real exit-code/stderr surface) for the same reasons.

### 2. CSXS PlayerDebugMode coverage in the README

The README install enables unsigned-extension mode for `com.adobe.CSXS.11` and `com.adobe.CSXS.12` only. AE 2026 (26.x) is shipping panels under newer CSXS runtime versions — the install should also enable `CSXS.13` (and ideally probe forward). On the test machine this didn't block anything because the panel happened to load under CSXS.12, but a future AE point release may not be so forgiving.

Suggested patch to README step 5:

```bash
for v in 11 12 13; do
  defaults write com.adobe.CSXS.$v PlayerDebugMode 1
done
```

(and matching Windows registry loop).

### 3. Panel registers with daemon as `aeVersion: 'unknown'`

After the spawn fix, `/tmp/gaffer-daemon.log` shows on cold start:

```
Gaffer: panel connected (AE unknown)
```

`main.js` derives the AE version from `cs.getHostEnvironment()`:

```js
var hostEnv = (function () {
  try { return JSON.parse(cs.getHostEnvironment()); } catch (e) { return {}; }
})();
var aeVersion = (hostEnv.appVersion || 'unknown').split('x')[0];
```

Either `cs.getHostEnvironment()` is throwing (parsed-as-`{}`) or it's returning a payload without an `appVersion` field on this build of AE. On the affected machine: AE 2025 (25.6) and AE 2026 (26.0 / 26.2) — at least one of these doesn't expose `appVersion` the way the parser expects. Worth verifying which AE versions populate which fields, since `aeVersion` is sent to the daemon's `register` message and presumably used for routing or version-gated tool behavior:

```js
ws.send(JSON.stringify({ type: 'register', aeVersion: aeVersion }));
```

Quick fix idea: also fall back to `hostEnv.appName + '/' + hostEnv.appLocale` or read the full env blob and pick whichever AE field is actually populated. Logging the raw `cs.getHostEnvironment()` output once on connect would make this trivial to diagnose on the affected machine.

### 4. CEP panel manifest declares `AutoVisible=true`

This means the panel loads and runs at AE startup. Combined with `--enable-nodejs`, an early failure in panel JS can cause AE startup hangs or — on the test machine with a pre-existing AE configuration issue — appeared to contribute to startup crashes. Once the AE-side issue was fixed and the panel was patched, AE launches cleanly with the panel auto-visible. Worth flagging in case future panel JS changes are sensitive to startup-time evaluation.

---

## Suggested test plan for the fix

1. **Apple Silicon Mac, AE 2025:** clean install → panel connects within 2s → `claude mcp list` shows connected → `getProjectSummary` returns valid JSON.
2. **Apple Silicon Mac, AE 2026:** same as above.
3. **Intel Mac, AE 2025:** clean install → behavior identical to before (regression check).
4. **Windows, AE 2025:** clean install → panel spawns daemon via `node.exe` → connects.
5. **Daemon-survives-panel-close:** open panel, confirm connected, close panel → confirm daemon process still running and listening on 9823/9824 (parity with current `nohup &` behavior).
6. **Daemon-restart-after-crash:** kill the daemon process while panel is open → panel detects disconnect → `daemonStartAttempted` is reset (existing logic) → panel respawns daemon successfully.

---

## Appendix: install state on the affected machine, before the patch

```
Panel files: ~/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel
  CSXS/manifest.xml  (Host AEFT [22,99.9], CSXS 12.0, AutoVisible=true,
                      CEFCommandLine: --enable-nodejs --mixed-context)
  daemon/  (with node_modules from `npm install --production`, 92 packages)
  host.jsx, index.html, main.js, lib/, prompts/, version.json (v0.2.0)

PlayerDebugMode: set on CSXS.11 and CSXS.12 (per README)
MCP registration: claude mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp
  (registered in ~/.claude.json)

Symptom: panel loads, shows "Disconnected".
  /tmp/gaffer-daemon.log: does not exist
  lsof -i :9824 / :9823: nothing listening
  Manual `bash daemon/start.sh`: succeeds, daemon binds ports, panel
    immediately reconnects.
```
