# Gaffer AE — Daemon cannot find `claude` CLI on Apple Silicon

**Repo:** https://github.com/spendolas/gaffer-ae
**Affected version:** v0.2.0 (commit `b7ffb28446cfeac0fa923a13dbfb7ecb69d894f1`), tested after the daemon-spawn fix from the previous report was applied.
**Severity:** Blocking on Apple Silicon. Panel connects fine, but the first chat message fails immediately with `Error: claude cli not found`.

---

## Environment

| Field | Value |
|---|---|
| OS | macOS (Darwin 25.4.0) |
| Architecture | arm64 (Apple M2) |
| AE versions installed | 2025 (25.6) and 2026 (26.0, 26.2) |
| Claude Code | 2.1.118, installed at `/opt/homebrew/bin/claude` (symlink → `/opt/homebrew/Caskroom/claude-code/2.1.118/claude`) |
| Gaffer install path | `~/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel` |

A second Mac — Intel, same install procedure — works correctly. The only relevant delta is the Homebrew prefix: `/usr/local/bin` vs `/opt/homebrew/bin`.

---

## Symptom

Panel loads and shows "Connected", but the moment the user sends a chat message, the panel shows:

```
Error: claude cli not found
```

…even though `claude` is obviously installed (it's how Gaffer was installed in the first place).

## Root cause

`daemon/claude-binary.js` known-locations list (lines 30–34):

```js
: [
    '/usr/local/bin/claude',
    join(process.env.HOME || '', '.local', 'bin', 'claude'),
    join(process.env.HOME || '', '.claude', 'local', 'claude'),
  ];
```

On Apple Silicon, Homebrew installs `claude` at `/opt/homebrew/bin/claude` — not in this list. The PATH-lookup fallback then runs `which claude`, but the daemon was spawned by the panel which was spawned by AE, so `process.env.PATH` is the macOS default `/usr/bin:/bin:/usr/sbin:/sbin` — `/opt/homebrew/bin` isn't there. So both lookups miss and the daemon throws `Claude CLI not found`.

This is the same root-cause family as the daemon-spawn fix already deployed: any code path that hard-codes `/usr/local`-style paths or relies on shell-resolved `PATH` will silently break on Apple Silicon Macs, because (a) Homebrew's prefix differs and (b) AE-spawned subprocesses inherit a stripped PATH.

## Fix

### Primary — diff for `daemon/claude-binary.js`

```diff
   var candidates = process.platform === 'win32'
     ? [
         join(process.env.LOCALAPPDATA || '', 'Programs', 'claude-code', 'claude.exe'),
         join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
       ]
     : [
+        '/opt/homebrew/bin/claude',
         '/usr/local/bin/claude',
         join(process.env.HOME || '', '.local', 'bin', 'claude'),
         join(process.env.HOME || '', '.claude', 'local', 'claude'),
       ];
```

That alone fixes Apple Silicon Homebrew installs.

### Recommended hardenings

1. **Augment `PATH` before the `which`/`where` fallback.** Users with non-standard installs (nvm/fnm/Volta wrappers, custom prefixes) currently fail because the daemon's inherited PATH is minimal. Prepend the standard locations:

   ```js
   var augmentedPath = [
     '/opt/homebrew/bin',
     '/usr/local/bin',
     join(process.env.HOME || '', '.local', 'bin'),
     process.env.PATH || '',
   ].filter(Boolean).join(':');
   var result = execSync(cmd, {
     encoding: 'utf-8',
     env: { ...process.env, PATH: augmentedPath },
   }).trim().split('\n')[0];
   ```

2. **Document the existing config-file escape hatch.** `claude-binary.js` already reads `<panel>/.gaffer-config.json` with a `claudeBin` field as the highest-priority lookup, but this isn't mentioned anywhere in the README or troubleshooting. Anyone with a non-standard layout currently has no signposted way to recover without editing source. Suggest adding a one-liner to the README troubleshooting section, e.g.:

   > **`Error: claude cli not found` despite Claude being installed:** create `<panel>/.gaffer-config.json` with `{"claudeBin": "/full/path/to/claude"}` to override discovery.

## Verified locally on the affected M2

- Wrote `~/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel/.gaffer-config.json` with `{"claudeBin": "/opt/homebrew/bin/claude"}` — chat worked immediately on next daemon restart.
- Patched `claude-binary.js` per the diff above and removed the config file — chat still worked, confirming the candidates-list fix alone is sufficient on a stock Apple Silicon Homebrew install.

## Suggested test plan

1. **Apple Silicon, AE 2025/2026, stock Homebrew install:** clean install → first chat message succeeds (no "claude cli not found").
2. **Intel Mac, AE 2025:** regression check — first chat message still works.
3. **Windows, AE 2025:** regression check — first chat message still works.
4. **Non-standard `claude` install:** put `claude` at a path outside the candidates list and outside the inherited PATH → daemon should still find it (via the PATH-augmentation hardening above) or be recoverable via a documented `.gaffer-config.json` (validates the docs change).

## Appendix: relevant runtime data

```
claude binary location: /opt/homebrew/bin/claude
                        -> /opt/homebrew/Caskroom/claude-code/2.1.118/claude

Daemon process.env.PATH (inherited from AE): /usr/bin:/bin:/usr/sbin:/sbin
User's interactive shell PATH (for reference): /opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:...

claude-binary.js candidates (current): /usr/local/bin/claude, ~/.local/bin/claude, ~/.claude/local/claude
claude-binary.js candidates (after fix): /opt/homebrew/bin/claude, /usr/local/bin/claude, ~/.local/bin/claude, ~/.claude/local/claude
```
