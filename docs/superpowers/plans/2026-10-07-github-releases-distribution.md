# GitHub Releases Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Gaffer installs and updates from tagged GitHub Releases with four uploaded assets, published by a gated workflow, and move the panel's update check and both update scripts onto those releases.
**Architecture:** A `release.yml` workflow runs a pure Node gate (`scripts/release-gate.mjs`) on every `panel/version.json` change, builds four plain archives of `panel/` with `scripts/package-release.sh`, and publishes them as a release through a draft. The panel's update check moves to `api.github.com/.../releases/latest` with its decision logic in a new testable `panel/update-state.js`; `update.sh` / `update.ps1` download the release asset and write `version.json` last. Rollout is three pushes: an inert Push 0 (workflow only), Push A (v0.11.0 + new clients) and Push B (legacy `commit` field only, which unsticks clients on 0.10.2 to 0.10.8).
**Tech Stack:** GitHub Actions (ubuntu-latest, Node 20, `gh`, `jq`, `zip`), Node `node:test`, bash + rsync (macOS), Windows PowerShell 5.1 + robocopy, ES5 panel JavaScript in CEP, VirtualBox `VBoxManage guestcontrol` for the Windows VM.
**Spec:** docs/superpowers/specs/2026-10-06-github-releases-distribution-design.md

## Global Constraints

- Panel scripts (`panel/update-state.js`, `panel/main.js`) are plain ES5 `<script>` files: `var` and `function` only, no `let`/`const`, arrow functions, template literals, destructuring, Promises you create yourself, or modules. `fetch(...).then(...)` is fine (main.js already uses it).
- Every `.ps1` file is ASCII-only with a UTF-8 BOM and runs on Windows PowerShell 5.1: no `??`, no ternary `? :`, no `ConvertFrom-Json -AsHashtable`, no `pwsh`-only cmdlets; unzip with `Expand-Archive`. Run `node scripts/check-ps-encoding.mjs` after `git add` (the lint only sees files listed by `git ls-files`).
- Node child processes on Windows need `windowsHide: true`. This plan adds no new spawns in panel or daemon code; do not remove the existing flags.
- User-facing copy (panel strings, README, CHANGELOG) has no em-dashes or en-dashes; use commas, colons or periods.
- Release asset names are exactly `gaffer-install-mac.tar.gz`, `gaffer-install-win.zip`, `gaffer-update-mac.tar.gz`, `gaffer-update-win.zip`. Install and update assets are byte-identical per OS.
- Every `version.json` (in the repo and in the assets) has exactly the keys `{ "version", "commit" }`. Packaged copies carry `commit` = the full SHA of the released commit.
- Until pre-0.11 clients are gone, `main` keeps `panel/version.json` at the same path with exactly `{ "version", "commit" }`, and the `main` archive layout `gaffer-ae-main/panel/` does not change.
- Release tags are `v<version>`. A version containing `-` (for example `0.12.0-beta.1`) is published with `--prerelease`.
- Both update scripts write `version.json` LAST via `version.json.tmp` + rename. `rsync` stays non-`--inplace`.
- Daemon tests run with a bare `cd panel/daemon && node --test` (no path argument: a directory argument breaks on Node 22+, a glob breaks on Node 20). A single daemon test file can be run as `cd panel/daemon && node --test test/<name>.test.mjs`. Repo-root tests run by explicit file path from the repo root: `node --test scripts/release-gate.test.mjs`. Baseline today: 165 daemon tests pass.
- Git: stage explicit paths only (`git add <path> ...`). The working tree has unrelated untracked files (a screenshot, `.aep` files, `exports/`, `docs/2026-09-15-*.md`): never add them, never `git add -A` or `git add .`. Never `--no-verify`. Never run `git config`; commits use the identity already configured in this repo (`spendolas@users.noreply.github.com`). Every commit message ends with the trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- `assets/` is gitignored. Never reference it in public files and never force-add it. `docs/` is public.
- Never stop a running Gaffer daemon, AE, or any server without the owner's OK. The update scripts stop whatever listens on port 9823, so the test scripts in this plan refuse to run while something listens there.
- Every push to `main`, every `gh workflow run`, branch push, release edit or release deletion is a manual step that needs the owner's go-ahead. The plan marks each one **MANUAL**.

## Review Focus

- **Install path with a space** (every real macOS install lives under `Application Support`): the updater must quote every path and land the update. Pinned by `scripts/test-update-sh.sh` (installs under `.../Application Support/com.gaffer.panel`, Task 8) and `scripts/windows-tests/test-5-update-ps1.ps1` (`...\Application Data\com.gaffer.panel`, Task 9).
- **Broken or 404 download** (proxy page, truncated file, release yanked): the updater must exit non-zero before touching the install, so `version.json` never changes and the panel never reloads into a half tree. Pinned by case 2 of `scripts/test-update-sh.sh` (Task 8) and of `test-5-update-ps1.ps1` (Task 9).
- **Leftover commit-keyed update attempt from a pre-0.11 panel** (the Push B hop reloads into the new panel with `gafferUpdateAttempt.target` = a commit hash): must be cleared silently, never "Update did not complete". Pinned by `updateVerdict: a commit-keyed attempt left by a pre-0.11 panel is cleared silently` in `panel/daemon/test/update-state.test.mjs` (Task 6).
- **GitHub rate limit (403 / 429) and no release yet (404)** on a shared office IP or before v0.11.0 exists: no error modal, no banner change, no "last checked" stamp. Pinned by `readReleaseResponse: 403, 429 and 404 are "no update info"` (Task 6) and `rate limits and missing releases show the neutral message` in `panel/daemon/test/update-wiring.test.mjs` (Task 7).
- **Release without this platform's update asset** (an upload still running, or a `recover` in progress): a Windows panel must not offer an update whose `gaffer-update-win.zip` is missing, even if the mac asset is there. Pinned by `parseRelease: hasAsset is per platform` and `decideUpdate: missing platform asset is never offered` (Task 6).

---

## Spec Clarifications and Additions

Read these first. Each one is a place where this plan goes beyond, or pins down, the spec.

1. **Push 0 (sequencing the dry run).** A workflow's `workflow_dispatch` only works once the workflow file exists on the default branch, so the spec's dry run cannot run before `release.yml` is on `main`. This plan adds an inert **Push 0** (Task 5) that lands `release.yml`, `scripts/release-gate.mjs` + tests, `scripts/package-release.sh` + test and the traffic-snapshot extension on `main` WITHOUT touching `panel/version.json`, so the `paths: [panel/version.json]` push trigger cannot fire. Then `gh workflow run release.yml -f dry_run=true` runs against `main` (version 0.10.8, no tags, no release): the gate says `action=create`, the build job uploads the artifact, and the publish job is skipped because it is a dry run. Only after the four assets and `notes.md` are verified does any version bump happen.
2. **`scripts/package-release.sh`** holds the spec's build commands (step 6) verbatim so the workflow, the local simulation and the updater tests all build assets the same way. The workflow calls it.
3. **`scripts/traffic-snapshot.jq`** holds the snapshot's jq program so it can be unit tested; the workflow passes it with `jq -f`.
4. **Test files not named in the spec:** `scripts/package-release.test.mjs`, `scripts/traffic-snapshot.test.mjs`, `scripts/release-docs.test.mjs`, `scripts/test-update-sh.sh`, `scripts/windows-tests/test-5-update-ps1.ps1`, `panel/daemon/test/update-wiring.test.mjs`. The workflow's test step runs the first two next to `release-gate.test.mjs`.
5. **`panel/update-state.js` has two more pure functions** than the spec lists: `parseReleaseCache(raw)` and `readReleaseResponse(status, json, etag, cache, os)`, so the ETag/304 path and the 403/429/404 handling are unit tested instead of living untested in `main.js`. `decideUpdate` returns `{ state, showBanner }` with `state` one of `'local-unknown' | 'up-to-date' | 'available'`.
6. **"Local version unknown"** fires when `versionData.version` does not look like `major.minor.patch`. The spec says "missing", but `main.js` defaults `versionData` to `{ version: 'dev' }`, so a literal missing check would never fire and a panel without `version.json` would be offered every release.
7. **`updateVerdict`** returns `'stale'` (clear silently) for an attempt whose `target` is not a version string (a commit hash written by a pre-0.11 panel), and `'failed'` only when the target is still newer than the local version (landing on an even newer release is not a failure).
8. **`GAFFER_UPDATE_ASSET`** environment override in both update scripts (a URL or a local file path; default is the `releases/latest/download` URL). The spec's Testing 2 ("pointed at the artifact") needs it.
9. **Unstick-hop test** (spec Testing 3) is a local simulation: the old v0.10.8 `update.sh` with its two GitHub URLs patched to a local `python3 -m http.server`. No fork is created. A fork is only the fallback if the local simulation cannot run.
10. **Small hardening while rewriting the scripts:** `curl -f` (update.sh and the README) so an HTTP error is a failure, not an HTML file; PowerShell `-UseBasicParsing`, `$ProgressPreference = "SilentlyContinue"`, a robocopy exit-code check (8 and up fails), and an explicit timestamp on `version.json.tmp` (Copy-Item keeps the archive's old timestamp, which would break the "written last" check). The README Windows block removes a stale `gaffer-extract` folder first.
11. **Touched user-facing strings lose their em-dashes** (`Update did not complete. The updater log has details: ...`).
12. On a dry run whose gate says `skip`, the gate writes no `notes.md`, so that artifact holds only `dist/`.

## Before you start

- [ ] Confirm the baseline and commit this plan:

```bash
git status --short          # expect only the known untracked files listed in Global Constraints
git log origin/main..HEAD --oneline   # expect no output (nothing unpushed)
(cd panel/daemon && node --test 2>&1 | grep -E '^# (tests|pass|fail)')
# expect: # tests 165 / # pass 165 / # fail 0
git add docs/superpowers/plans/2026-10-07-github-releases-distribution.md
git commit -m "docs: GitHub Releases distribution implementation plan" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

All commands run from the repo root unless a step says otherwise. Scratch files go in `S="${TMPDIR:-/tmp}/gaffer-rel"` (create it with `mkdir -p "$S"` when a step needs it).

---

### Task 1: Release gate

**Files:**
- Create: `scripts/release-gate.mjs`
- Test: `scripts/release-gate.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `REQUIRED_ASSETS: string[]` (the four asset names), `class GateError extends Error`.
  - `parseVersion(v: string) -> { nums: [number, number, number], pre: string | null } | null`
  - `compareVersions(a: string, b: string) -> -1 | 0 | 1` (throws `GateError` on unparseable input)
  - `extractNotes(changelog: string, version: string) -> string | null`
  - `isCompleteRelease(release: { isDraft, assets: [{ name }] } | null) -> boolean`
  - `decide({ version, tags, release, changelog }) -> { action: 'skip' | 'create' | 'recover', notes: string | null }` (throws `GateError`)
  - CLI used by the workflow: `node scripts/release-gate.mjs --version <V> --tags-file <file> --release-file <file> --changelog <file> --notes-out <file>`. `--release-file` holds `gh release view --json isDraft,assets` output or `null`. Appends `action=<action>` to `$GITHUB_OUTPUT` when set, prints `release-gate: v<V> -> <action>`, writes notes for `create`/`recover`, exits 1 with `release-gate: <reason>` on a gate failure.

- [ ] **Step 1: Write the failing test**

Create `scripts/release-gate.test.mjs`:

```javascript
// Run from the repo root: node --test scripts/release-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, compareVersions, extractNotes, GateError, REQUIRED_ASSETS } from './release-gate.mjs';

const CHANGELOG = [
  '# Changelog',
  '',
  '## v0.11.0 - 2026-10-07',
  '',
  '**Installs and updates now come from GitHub Releases.**',
  '',
  '- First bullet.',
  '',
  '## v0.11.0-beta.1 - 2026-10-01',
  '',
  '- Beta notes.',
  '',
  '## v0.10.8 - 2026-10-06',
  '',
  '- Older notes.',
  '',
].join('\n');

const allAssets = () => REQUIRED_ASSETS.map((name) => ({ name }));

test('published release with all four assets -> skip', () => {
  const r = decide({ version: '0.11.0', tags: ['v0.11.0'], release: { isDraft: false, assets: allAssets() }, changelog: '' });
  assert.equal(r.action, 'skip');
});

test('draft release -> recover', () => {
  const r = decide({ version: '0.11.0', tags: [], release: { isDraft: true, assets: allAssets() }, changelog: CHANGELOG });
  assert.equal(r.action, 'recover');
});

test('published release missing one asset -> recover', () => {
  const assets = allAssets().filter((a) => a.name !== 'gaffer-update-win.zip');
  const r = decide({ version: '0.11.0', tags: ['v0.11.0'], release: { isDraft: false, assets }, changelog: CHANGELOG });
  assert.equal(r.action, 'recover');
});

test('recover skips the version check even when a higher tag exists', () => {
  const r = decide({ version: '0.11.0', tags: ['v0.12.0'], release: { isDraft: true, assets: [] }, changelog: CHANGELOG });
  assert.equal(r.action, 'recover');
});

test('first release, no tags at all -> create', () => {
  const r = decide({ version: '0.11.0', tags: [], release: null, changelog: CHANGELOG });
  assert.equal(r.action, 'create');
});

test('tag v$V exists without a release -> create (own tag ignored)', () => {
  const r = decide({ version: '0.11.0', tags: ['v0.10.8', 'v0.11.0'], release: null, changelog: CHANGELOG });
  assert.equal(r.action, 'create');
});

test('V equal to another tag (different spelling) -> fail', () => {
  assert.throws(
    () => decide({ version: '0.11.0', tags: ['v0.11.00'], release: null, changelog: CHANGELOG }),
    (e) => e instanceof GateError && /not greater than existing tag v0\.11\.00/.test(e.message),
  );
});

test('V lower than the highest other tag -> fail', () => {
  assert.throws(
    () => decide({ version: '0.10.8', tags: ['v0.11.0'], release: null, changelog: CHANGELOG }),
    (e) => e instanceof GateError && /not greater than existing tag v0\.11\.0/.test(e.message),
  );
});

test('0.11.0 after 0.11.0-beta.1 -> allowed', () => {
  const r = decide({ version: '0.11.0', tags: ['v0.11.0-beta.1'], release: null, changelog: CHANGELOG });
  assert.equal(r.action, 'create');
});

test('0.11.0-beta.1 after 0.11.0 -> fail', () => {
  assert.throws(
    () => decide({ version: '0.11.0-beta.1', tags: ['v0.11.0'], release: null, changelog: CHANGELOG }),
    GateError,
  );
});

test('prerelease suffixes compare like sort -V (beta.2 < beta.10)', () => {
  assert.equal(compareVersions('0.12.0-beta.2', '0.12.0-beta.10'), -1);
  assert.equal(compareVersions('0.12.0-beta.10', '0.12.0-beta.2'), 1);
  assert.equal(compareVersions('0.12.0-alpha.9', '0.12.0-beta.1'), -1);
  assert.equal(compareVersions('0.12.0', '0.12.0-rc.1'), 1);
  assert.equal(compareVersions('0.10.10', '0.10.9'), 1);
});

test('non-version tags are ignored', () => {
  const r = decide({ version: '0.11.0', tags: ['vnext', 'release-1', 'v1'], release: null, changelog: CHANGELOG });
  assert.equal(r.action, 'create');
});

test('malformed version in panel/version.json -> fail', () => {
  assert.throws(() => decide({ version: '0.11', tags: [], release: null, changelog: CHANGELOG }), GateError);
  assert.throws(() => decide({ version: '', tags: [], release: null, changelog: CHANGELOG }), GateError);
});

test('missing ## v<V> heading -> fail', () => {
  assert.throws(
    () => decide({ version: '0.11.1', tags: [], release: null, changelog: CHANGELOG }),
    (e) => e instanceof GateError && /no "## v0\.11\.1" heading/.test(e.message),
  );
});

test('## v0.11.0 does not match V = 0.11.01', () => {
  assert.equal(extractNotes(CHANGELOG, '0.11.01'), null);
  assert.throws(() => decide({ version: '0.11.01', tags: [], release: null, changelog: CHANGELOG }), GateError);
});

test('## v0.11.0-beta.1 does not satisfy V = 0.11.0', () => {
  const only = '# Changelog\n\n## v0.11.0-beta.1 - 2026-10-01\n\n- Beta.\n';
  assert.equal(extractNotes(only, '0.11.0'), null);
});

test('heading with nothing after the version also matches', () => {
  assert.equal(extractNotes('## v0.11.0\n- a\n', '0.11.0'), '- a\n');
});

test('notes extraction stops at the next "## " heading', () => {
  const notes = extractNotes(CHANGELOG, '0.11.0');
  assert.equal(notes, '**Installs and updates now come from GitHub Releases.**\n\n- First bullet.\n');
  assert.ok(!notes.includes('Beta notes'));
});

test('notes extraction handles CRLF line endings', () => {
  const notes = extractNotes(CHANGELOG.replace(/\n/g, '\r\n'), '0.11.0');
  assert.equal(notes, '**Installs and updates now come from GitHub Releases.**\n\n- First bullet.\n');
});

test('CLI writes action to GITHUB_OUTPUT and notes.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-gate-'));
  writeFileSync(join(dir, 'tags.txt'), 'v0.10.0\n');
  writeFileSync(join(dir, 'release.json'), 'null\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG);
  writeFileSync(join(dir, 'out.txt'), '');
  const script = fileURLToPath(new URL('./release-gate.mjs', import.meta.url));
  execFileSync(process.execPath, [
    script, '--version', '0.11.0',
    '--tags-file', join(dir, 'tags.txt'),
    '--release-file', join(dir, 'release.json'),
    '--changelog', join(dir, 'CHANGELOG.md'),
    '--notes-out', join(dir, 'notes.md'),
  ], { env: { ...process.env, GITHUB_OUTPUT: join(dir, 'out.txt') } });
  assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'action=create\n');
  assert.match(readFileSync(join(dir, 'notes.md'), 'utf8'), /^\*\*Installs and updates/);
});

test('CLI exits 1 with a readable message when the gate fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-gate-'));
  writeFileSync(join(dir, 'tags.txt'), 'v0.12.0\n');
  writeFileSync(join(dir, 'release.json'), 'null\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG);
  const script = fileURLToPath(new URL('./release-gate.mjs', import.meta.url));
  let err;
  try {
    execFileSync(process.execPath, [
      script, '--version', '0.11.0',
      '--tags-file', join(dir, 'tags.txt'),
      '--release-file', join(dir, 'release.json'),
      '--changelog', join(dir, 'CHANGELOG.md'),
      '--notes-out', join(dir, 'notes.md'),
    ], { stdio: 'pipe' });
  } catch (e) { err = e; }
  assert.ok(err, 'expected a non-zero exit');
  assert.equal(err.status, 1);
  assert.match(String(err.stderr), /release-gate: version 0\.11\.0 is not greater than existing tag v0\.12\.0/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/release-gate.test.mjs`
Expected: FAIL, the file errors with `ERR_MODULE_NOT_FOUND` (`Cannot find module '.../scripts/release-gate.mjs'`), `# fail 1`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/release-gate.mjs`:

```javascript
#!/usr/bin/env node
// Release gate for .github/workflows/release.yml. Decides whether the
// version in panel/version.json should be released (create), finished
// (recover) or left alone (skip), and extracts the CHANGELOG section that
// becomes the release notes. Pure logic is exported for
// scripts/release-gate.test.mjs; the CLI at the bottom is what the workflow runs.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_ASSETS = [
  'gaffer-install-mac.tar.gz',
  'gaffer-install-win.zip',
  'gaffer-update-mac.tar.gz',
  'gaffer-update-win.zip',
];

export class GateError extends Error {}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

// "0.11.0-beta.1" -> { nums: [0, 11, 0], pre: "beta.1" }; anything else -> null.
export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v));
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null };
}

// `sort -V` style: digit runs compare as numbers, everything else as text.
function comparePre(a, b) {
  const ca = a.match(/\d+|\D+/g);
  const cb = b.match(/\d+|\D+/g);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const x = ca[i];
    const y = cb[i];
    const bothNum = /^\d/.test(x) && /^\d/.test(y);
    if (bothNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ca.length === cb.length ? 0 : (ca.length < cb.length ? -1 : 1);
}

// -1, 0 or 1. Numeric major.minor.patch first; on a tie a final release is
// greater than any prerelease of it.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new GateError(`cannot compare "${a}" and "${b}"`);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePre(pa.pre, pb.pre);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Body of the "## v<version>" section: the lines after the heading up to,
// not including, the next line starting with "## ". Leading and trailing
// blank lines are dropped. null when the heading is missing.
export function extractNotes(changelog, version) {
  const lines = String(changelog).split(/\r?\n/);
  const heading = new RegExp('^## v' + escapeRegExp(version) + '( |$)');
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break;
    body.push(lines[i]);
  }
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return body.join('\n') + '\n';
}

export function isCompleteRelease(release) {
  if (!release || release.isDraft) return false;
  const names = (release.assets || []).map((a) => a.name);
  return REQUIRED_ASSETS.every((n) => names.includes(n));
}

// version: string from panel/version.json. tags: array of tag names.
// release: { isDraft, assets: [{ name }] } from `gh release view`, or null.
// changelog: CHANGELOG.md text. Returns { action, notes }; throws GateError.
export function decide({ version, tags, release, changelog }) {
  if (!parseVersion(version)) {
    throw new GateError(`panel/version.json version "${version}" is not major.minor.patch[-prerelease]`);
  }
  if (isCompleteRelease(release)) return { action: 'skip', notes: null };
  let action = 'recover';
  if (!release) {
    for (const tag of tags) {
      if (!tag.startsWith('v')) continue;
      const tagVersion = tag.slice(1);
      if (tagVersion === version || !parseVersion(tagVersion)) continue;
      if (compareVersions(version, tagVersion) <= 0) {
        throw new GateError(`version ${version} is not greater than existing tag ${tag}`);
      }
    }
    action = 'create';
  }
  const notes = extractNotes(changelog, version);
  if (notes === null) throw new GateError(`CHANGELOG.md has no "## v${version}" heading`);
  return { action, notes };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new GateError(`bad argument "${argv[i]}"`);
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['version', 'tags-file', 'release-file', 'changelog', 'notes-out']) {
    if (!out[k]) throw new GateError(`missing --${k}`);
  }
  return out;
}

export function main(argv, env) {
  const args = parseArgs(argv);
  const tags = readFileSync(args['tags-file'], 'utf8').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  const releaseText = readFileSync(args['release-file'], 'utf8').trim();
  const release = releaseText === '' ? null : JSON.parse(releaseText);
  const changelog = readFileSync(args.changelog, 'utf8');
  const { action, notes } = decide({ version: args.version, tags, release, changelog });
  if (notes !== null) writeFileSync(args['notes-out'], notes);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `action=${action}\n`);
  console.log(`release-gate: v${args.version} -> ${action}`);
  return action;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (e) {
    console.error('release-gate: ' + e.message);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/release-gate.test.mjs`
Expected: `# tests 21`, `# pass 21`, `# fail 0`.

Also check the real CHANGELOG through the CLI (version 0.10.8 has a heading, no tags exist):

```bash
mkdir -p "${TMPDIR:-/tmp}/gaffer-rel" && S="${TMPDIR:-/tmp}/gaffer-rel"
git tag -l 'v*' > "$S/tags.txt"; echo null > "$S/release.json"
node scripts/release-gate.mjs --version 0.10.8 --tags-file "$S/tags.txt" --release-file "$S/release.json" --changelog CHANGELOG.md --notes-out "$S/notes.md"
head -1 "$S/notes.md"
```

Expected: `release-gate: v0.10.8 -> create`, then `**Updating or reinstalling Gaffer no longer deletes your chat history.**`.

- [ ] **Step 5: Commit**

```bash
git add scripts/release-gate.mjs scripts/release-gate.test.mjs
git commit -m "feat(release): release gate for the GitHub Releases workflow" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Release asset packager

**Files:**
- Create: `scripts/package-release.sh`
- Test: `scripts/package-release.test.mjs`

**Interfaces:**
- Consumes: nothing (needs `git`, `tar`, `zip`, `jq` on PATH; all exist on macOS and ubuntu-latest).
- Produces: `bash scripts/package-release.sh <version> <commit> <out-dir>`, run from the repo root. Writes exactly the four assets into `<out-dir>` from the COMMITTED `panel/` tree (`git archive HEAD:panel`), with `version.json` replaced by `{"version": <version>, "commit": <commit>}`. Used by Task 4 (workflow), Task 8 and Task 9 (updater tests).

- [ ] **Step 1: Write the failing test**

Create `scripts/package-release.test.mjs`:

```javascript
// Run from the repo root: node --test scripts/package-release.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'gaffer-pkg-'));
execFileSync('bash', ['scripts/package-release.sh', '9.9.9', 'deadbeefcafe', out], { cwd: repoRoot, stdio: 'pipe' });

test('builds exactly the four release assets', () => {
  assert.deepEqual(readdirSync(out).sort(), [
    'gaffer-install-mac.tar.gz',
    'gaffer-install-win.zip',
    'gaffer-update-mac.tar.gz',
    'gaffer-update-win.zip',
  ]);
});

test('install and update assets are byte-identical per OS', () => {
  assert.ok(readFileSync(join(out, 'gaffer-install-mac.tar.gz')).equals(readFileSync(join(out, 'gaffer-update-mac.tar.gz'))));
  assert.ok(readFileSync(join(out, 'gaffer-install-win.zip')).equals(readFileSync(join(out, 'gaffer-update-win.zip'))));
});

test('mac archive has panel/ contents at its root, not under gaffer-ae-main/panel', () => {
  const list = execFileSync('tar', ['-tzf', join(out, 'gaffer-update-mac.tar.gz')], { encoding: 'utf8' }).split('\n');
  assert.ok(list.includes('./version.json'));
  assert.ok(list.includes('./daemon/index.js'));
  assert.ok(list.includes('./CSXS/manifest.xml'));
  assert.ok(!list.some((p) => p.includes('gaffer-ae-main') || p.startsWith('./panel/')));
  assert.ok(!list.some((p) => p.includes('node_modules')));
});

test('win zip has panel/ contents at its root', () => {
  const list = execFileSync('unzip', ['-Z1', join(out, 'gaffer-update-win.zip')], { encoding: 'utf8' }).split('\n');
  assert.ok(list.includes('version.json'));
  assert.ok(list.includes('daemon/index.js'));
  assert.ok(!list.some((p) => p.startsWith('panel/')));
});

test('packaged version.json has exactly version and commit', () => {
  const json = execFileSync('tar', ['-xzOf', join(out, 'gaffer-update-mac.tar.gz'), './version.json'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(json), { version: '9.9.9', commit: 'deadbeefcafe' });
  const zipJson = execFileSync('unzip', ['-p', join(out, 'gaffer-update-win.zip'), 'version.json'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(zipJson), { version: '9.9.9', commit: 'deadbeefcafe' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/package-release.test.mjs`
Expected: FAIL, the file errors at load with `bash: scripts/package-release.sh: No such file or directory` (`Command failed: bash scripts/package-release.sh ...`), `# fail 1`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/package-release.sh`:

```bash
#!/bin/bash
# Builds the four GitHub Release assets from the committed panel/ tree.
# No compile step: each asset is a plain archive of panel/ with a stamped
# version.json. Used by .github/workflows/release.yml and by local tests.
#
# Usage (from the repo root): bash scripts/package-release.sh <version> <commit> <out-dir>
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: bash scripts/package-release.sh <version> <commit> <out-dir>" >&2
  exit 2
fi
VERSION="$1"
COMMIT="$2"
OUT_DIR="$3"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-stage-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
rm -f "$OUT_DIR"/gaffer-install-mac.tar.gz "$OUT_DIR"/gaffer-install-win.zip \
      "$OUT_DIR"/gaffer-update-mac.tar.gz "$OUT_DIR"/gaffer-update-win.zip

# panel/ contents at the archive root, tracked files only
git archive HEAD:panel | tar -x -C "$STAGE"
jq -n --arg v "$VERSION" --arg c "$COMMIT" '{version: $v, commit: $c}' > "$STAGE/version.json"

tar -czf "$OUT_DIR/gaffer-install-mac.tar.gz" -C "$STAGE" .
(cd "$STAGE" && zip -qr "$OUT_DIR/gaffer-install-win.zip" .)
cp "$OUT_DIR/gaffer-install-mac.tar.gz" "$OUT_DIR/gaffer-update-mac.tar.gz"
cp "$OUT_DIR/gaffer-install-win.zip" "$OUT_DIR/gaffer-update-win.zip"

echo "Built v$VERSION ($COMMIT) into $OUT_DIR"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/package-release.test.mjs`
Expected: `# tests 5`, `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/package-release.sh scripts/package-release.test.mjs
git commit -m "feat(release): package the four release assets from panel/" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Download counts in the weekly traffic snapshot

**Files:**
- Create: `scripts/traffic-snapshot.jq`
- Modify: `.github/workflows/traffic-snapshot.yml:36-49` (the "Fetch traffic data and append snapshot" step)
- Test: `scripts/traffic-snapshot.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `jq -nc --arg ts <utc> --argjson clones <json> --argjson views <json> --argjson releases <json array> -f scripts/traffic-snapshot.jq` prints one JSON line `{timestamp, clones, views, releases: [{tag, prerelease, assets: [{name, download_count}]}], installs, updates}`; drafts are excluded.

- [ ] **Step 1: Write the failing test**

Create `scripts/traffic-snapshot.test.mjs`:

```javascript
// Run from the repo root: node --test scripts/traffic-snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const program = fileURLToPath(new URL('./traffic-snapshot.jq', import.meta.url));

function snapshot(releases) {
  const line = execFileSync('jq', [
    '-nc',
    '--arg', 'ts', '2026-10-12T09:00:00Z',
    '--argjson', 'clones', '{"count":3}',
    '--argjson', 'views', '{"count":7}',
    '--argjson', 'releases', JSON.stringify(releases),
    '-f', program,
  ], { encoding: 'utf8' });
  assert.equal(line.trim().split('\n').length, 1, 'must be exactly one JSONL line');
  return JSON.parse(line);
}

const asset = (name, download_count) => ({ name, download_count, size: 1, url: 'x' });

test('no releases yet: empty list and zero counts', () => {
  const s = snapshot([]);
  assert.deepEqual(s.releases, []);
  assert.equal(s.installs, 0);
  assert.equal(s.updates, 0);
  assert.deepEqual(s.clones, { count: 3 });
  assert.equal(s.timestamp, '2026-10-12T09:00:00Z');
});

test('sums installs and updates across releases and skips drafts', () => {
  const s = snapshot([
    { tag_name: 'v0.11.1', prerelease: false, draft: false, assets: [
      asset('gaffer-install-mac.tar.gz', 5), asset('gaffer-install-win.zip', 2),
      asset('gaffer-update-mac.tar.gz', 40), asset('gaffer-update-win.zip', 9) ] },
    { tag_name: 'v0.12.0-beta.1', prerelease: true, draft: false, assets: [
      asset('gaffer-install-mac.tar.gz', 1), asset('gaffer-update-mac.tar.gz', 0) ] },
    { tag_name: 'v0.12.0', prerelease: false, draft: true, assets: [
      asset('gaffer-install-mac.tar.gz', 100) ] },
  ]);
  assert.equal(s.installs, 8);
  assert.equal(s.updates, 49);
  assert.deepEqual(s.releases.map((r) => r.tag), ['v0.11.1', 'v0.12.0-beta.1']);
  assert.deepEqual(s.releases[1], { tag: 'v0.12.0-beta.1', prerelease: true, assets: [
    { name: 'gaffer-install-mac.tar.gz', download_count: 1 },
    { name: 'gaffer-update-mac.tar.gz', download_count: 0 } ] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/traffic-snapshot.test.mjs`
Expected: FAIL, both tests error with `jq: error: Could not open .../scripts/traffic-snapshot.jq: No such file or directory`, `# fail 2`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/traffic-snapshot.jq`:

```
# One line of docs/traffic-snapshots.jsonl. Inputs (all via --arg/--argjson):
#   $ts        UTC timestamp string
#   $clones    GET repos/{repo}/traffic/clones
#   $views     GET repos/{repo}/traffic/views
#   $releases  every page of GET repos/{repo}/releases, merged into one array
# Drafts are left out. installs/updates sum download_count over the assets
# named gaffer-install-* and gaffer-update-* across all releases.
($releases
  | map(select(.draft | not))
  | map({tag: .tag_name, prerelease: .prerelease,
         assets: [.assets[] | {name, download_count}]})) as $r
| ([$r[].assets[]]) as $all
| {timestamp: $ts, clones: $clones, views: $views, releases: $r,
   installs: ([$all[] | select(.name | startswith("gaffer-install-")) | .download_count] | add // 0),
   updates: ([$all[] | select(.name | startswith("gaffer-update-")) | .download_count] | add // 0)}
```

In `.github/workflows/traffic-snapshot.yml`, in the `run:` block of the step `Fetch traffic data and append snapshot`, replace the lines from `views=$(gh api "repos/${{ github.repository }}/traffic/views")` through `>> docs/traffic-snapshots.jsonl` (lines 42-49) with:

```yaml
          views=$(gh api "repos/${{ github.repository }}/traffic/views")
          # Release download counts (installs vs updates). This endpoint is
          # public; it only runs under TRAFFIC_PAT because this step sets it.
          releases=$(gh api --paginate "repos/${{ github.repository }}/releases?per_page=100" | jq -s 'add // []')
          timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
          jq -nc \
            --arg ts "$timestamp" \
            --argjson clones "$clones" \
            --argjson views "$views" \
            --argjson releases "$releases" \
            -f scripts/traffic-snapshot.jq \
            >> docs/traffic-snapshots.jsonl
```

Leave `GH_TOKEN: ${{ secrets.TRAFFIC_PAT }}`, the `clones=` line and the commit step unchanged.

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test scripts/traffic-snapshot.test.mjs
ruby -ryaml -e 'y = YAML.load_file(ARGV[0]); run = y["jobs"]["snapshot"]["steps"].find { |s| s["name"] == "Fetch traffic data and append snapshot" }["run"]; abort("missing") unless run.include?("-f scripts/traffic-snapshot.jq") && run.include?("--argjson releases"); puts "traffic-snapshot.yml OK"' .github/workflows/traffic-snapshot.yml
gh api --paginate "repos/spendolas/gaffer-ae/releases?per_page=100" | jq -s 'add // []' -c
```

Expected: `# tests 2`, `# pass 2`, `# fail 0`; `traffic-snapshot.yml OK`; `[]` (no releases exist yet).

- [ ] **Step 5: Commit**

```bash
git add scripts/traffic-snapshot.jq scripts/traffic-snapshot.test.mjs .github/workflows/traffic-snapshot.yml
git commit -m "feat(traffic): record release download counts in the weekly snapshot" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Test: the Ruby structure check and the local build-job simulation in Steps 2 and 4.

**Interfaces:**
- Consumes: the gate CLI (Task 1), `bash scripts/package-release.sh <version> <commit> <out-dir>` (Task 2), the three test files from Tasks 1 to 3.
- Produces: workflow `Release` with job outputs `action` and `version`; the artifact `gaffer-release` containing `dist/<four assets>` and `notes.md`; on a real run, release `v<version>`.

- [ ] **Step 1: Write the failing test**

The test is this structure check (actionlint is not installed; Ruby is):

```bash
ruby -ryaml -e 'y = YAML.load_file(ARGV[0]); on = y["on"] || y[true]; abort("bad triggers") unless on["push"]["paths"] == ["panel/version.json"] && on["workflow_dispatch"]["inputs"]["dry_run"]["default"] == true; abort("bad jobs") unless y["jobs"].keys == ["build", "publish"] && y["jobs"]["publish"]["needs"] == "build" && y["jobs"]["publish"]["permissions"] == {"contents" => "write"} && y["permissions"] == {"contents" => "read"} && y["concurrency"] == {"group" => "release", "cancel-in-progress" => false}; puts "release.yml OK"' .github/workflows/release.yml
```

(`y["on"] || y[true]`: Ruby's YAML reads the bare key `on` as the boolean `true`.)

- [ ] **Step 2: Run test to verify it fails**

Run the command from Step 1.
Expected: FAIL with `No such file or directory @ rb_sysopen - .github/workflows/release.yml (Errno::ENOENT)`.

- [ ] **Step 3: Write minimal implementation**

Create `.github/workflows/release.yml`:

```yaml
name: Release

# Publishes a GitHub Release with four uploaded assets when
# panel/version.json changes on main. scripts/release-gate.mjs decides
# create / recover / skip, so a push that does not bump the version (or
# only touches the legacy commit field) is a no-op. Manual runs default to a
# dry run that only uploads a workflow artifact named gaffer-release.
on:
  push:
    branches: [main]
    paths: [panel/version.json]
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run: build and upload the artifact only, never publish'
        type: boolean
        default: true

permissions:
  contents: read

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      action: ${{ steps.gate.outputs.action }}
      version: ${{ steps.version.outputs.version }}
    env:
      # 'true' only for a manual run with dry_run checked; 'false' on push.
      DRY_RUN: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.sha }}
          fetch-depth: 0   # tags are needed by the gate

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Read version
        id: version
        run: |
          set -euo pipefail
          V="$(jq -r '.version // empty' panel/version.json)"
          if [ -z "$V" ]; then echo "panel/version.json has no version"; exit 1; fi
          echo "version=$V" >> "$GITHUB_OUTPUT"
          echo "V=$V" >> "$GITHUB_ENV"

      # A read-only token cannot see drafts; the publish job re-checks with a
      # write token before it touches anything.
      - name: Collect release state
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          git tag -l 'v*' > tags.txt
          if gh release view "v$V" --json isDraft,assets > release.json 2> gh-err.txt; then
            echo "Release v$V exists."
          elif grep -qi 'release not found' gh-err.txt; then
            echo 'null' > release.json
          else
            cat gh-err.txt
            exit 1
          fi

      - name: Release gate
        id: gate
        run: node scripts/release-gate.mjs --version "$V" --tags-file tags.txt --release-file release.json --changelog CHANGELOG.md --notes-out notes.md

      - name: Tests
        if: steps.gate.outputs.action != 'skip' || env.DRY_RUN == 'true'
        run: |
          set -euo pipefail
          (cd panel/daemon && npm ci && npm test)
          node scripts/check-ps-encoding.mjs
          node --test scripts/release-gate.test.mjs scripts/package-release.test.mjs scripts/traffic-snapshot.test.mjs

      - name: Build assets
        if: steps.gate.outputs.action != 'skip' || env.DRY_RUN == 'true'
        run: bash scripts/package-release.sh "$V" "$GITHUB_SHA" dist

      - name: Upload artifact
        if: steps.gate.outputs.action != 'skip' || env.DRY_RUN == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: gaffer-release
          path: |
            dist/
            notes.md
          if-no-files-found: error

  publish:
    needs: build
    if: >-
      github.ref == 'refs/heads/main'
      && (github.event_name == 'push' || inputs.dry_run == false)
      && (needs.build.outputs.action == 'create' || needs.build.outputs.action == 'recover')
    runs-on: ubuntu-latest
    permissions:
      contents: write
    env:
      V: ${{ needs.build.outputs.version }}
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.sha }}
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: actions/download-artifact@v4
        with:
          name: gaffer-release
          path: artifact

      # The write token sees drafts, so a draft left by an earlier failed run
      # is recovered here instead of duplicated.
      - name: Re-check release state with the write token
        run: |
          set -euo pipefail
          git tag -l 'v*' > tags.txt
          if gh release view "v$V" --json isDraft,assets > release.json 2> gh-err.txt; then
            echo "Release v$V exists."
          elif grep -qi 'release not found' gh-err.txt; then
            echo 'null' > release.json
          else
            cat gh-err.txt
            exit 1
          fi

      - name: Release gate
        id: gate
        run: node scripts/release-gate.mjs --version "$V" --tags-file tags.txt --release-file release.json --changelog CHANGELOG.md --notes-out notes.md

      - name: Publish
        env:
          ACTION: ${{ steps.gate.outputs.action }}
        run: |
          set -euo pipefail
          ls -l artifact/dist
          PRE=""
          case "$V" in *-*) PRE="--prerelease" ;; esac
          if [ "$ACTION" = "create" ]; then
            # A draft is invisible to releases/latest and creates no tag, so
            # users never see a release with assets still uploading.
            gh release create "v$V" --draft --target "$GITHUB_SHA" --title "v$V" --notes-file notes.md $PRE artifact/dist/*
            gh release edit "v$V" --draft=false
          elif [ "$ACTION" = "recover" ]; then
            gh release upload "v$V" artifact/dist/* --clobber
            if [ "$(jq -r '.isDraft' release.json)" = "true" ]; then
              gh release edit "v$V" --draft=false
            fi
          else
            echo "Nothing to publish (action=$ACTION)."
          fi
```

- [ ] **Step 4: Run test to verify it passes**

Run the Step 1 command. Expected: `release.yml OK`.

Then simulate the build job's shell steps against a scratch clone of the committed tree (commit Tasks 1 to 3 first; they are). This uses the real `npm ci`, so it needs network:

```bash
W="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-wf-XXXXXX")"
git clone -q . "$W/repo"
cd "$W/repo"
export GITHUB_OUTPUT="$W/out.txt" GITHUB_SHA="$(git rev-parse HEAD)"; : > "$GITHUB_OUTPUT"
V="$(jq -r '.version // empty' panel/version.json)"
git tag -l 'v*' > tags.txt
if gh release view "v$V" --repo spendolas/gaffer-ae --json isDraft,assets > release.json 2> gh-err.txt; then echo "Release v$V exists."; elif grep -qi 'release not found' gh-err.txt; then echo 'null' > release.json; else cat gh-err.txt; fi
node scripts/release-gate.mjs --version "$V" --tags-file tags.txt --release-file release.json --changelog CHANGELOG.md --notes-out notes.md
(cd panel/daemon && npm ci --silent && npm test 2>&1 | grep -E '^# (tests|pass|fail)')
node scripts/check-ps-encoding.mjs > /dev/null && echo "ps encoding OK"
node --test scripts/release-gate.test.mjs scripts/package-release.test.mjs scripts/traffic-snapshot.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)'
bash scripts/package-release.sh "$V" "$GITHUB_SHA" dist
ls dist; cat "$GITHUB_OUTPUT"; tar -xzOf dist/gaffer-update-mac.tar.gz ./version.json
cd / && rm -rf "$W"
```

Expected, in order: `release-gate: v0.10.8 -> create`; `# tests 165`, `# pass 165`, `# fail 0`; `ps encoding OK`; `# tests 28`, `# pass 28`, `# fail 0`; `Built v0.10.8 (<40-char sha>) into .../dist`; the four asset names; `action=create`; a `version.json` with `"version": "0.10.8"` and `"commit": "<the same 40-char sha>"`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(release): release workflow (gate, build, publish)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Push 0, land the inert release tooling and dry-run it

**Files:**
- No file changes. Pushes the commits of Tasks 1 to 4 (and the plan commit).

**Interfaces:**
- Consumes: everything from Tasks 1 to 4.
- Produces: `release.yml` on `main`, dispatchable; a verified dry-run artifact.

- [ ] **Step 1: Verify what will be pushed (the "failing test" is any unexpected path)**

```bash
git fetch origin
git status -sb | head -1                 # expect: ## main...origin/main [ahead 5]
git log origin/main..HEAD --oneline      # expect exactly 5 commits: the plan, Tasks 1, 2, 3, 4
git diff origin/main --name-only
git diff origin/main --name-only | grep -c '^panel/' || true
```

Expected `git diff --name-only`, exactly:

```
.github/workflows/release.yml
.github/workflows/traffic-snapshot.yml
docs/superpowers/plans/2026-10-07-github-releases-distribution.md
scripts/package-release.sh
scripts/package-release.test.mjs
scripts/release-gate.mjs
scripts/release-gate.test.mjs
scripts/traffic-snapshot.jq
scripts/traffic-snapshot.test.mjs
```

and `0` for the `panel/` count. If `git status` says `behind` (the weekly traffic bot pushed), run `git pull --rebase origin main` and repeat this step. If `panel/version.json` appears, STOP: pushing it would fire the release trigger.

- [ ] **Step 2: MANUAL, push (owner's go-ahead required)**

```bash
git push origin main
gh run list --workflow release.yml --limit 5
```

Expected: the push succeeds and `gh run list` shows no runs (the push did not touch `panel/version.json`).

- [ ] **Step 3: MANUAL, dry run on main**

```bash
gh workflow run release.yml -f dry_run=true
sleep 10
RUN_ID="$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
gh run view "$RUN_ID" --log | grep 'release-gate:'
```

Expected: the run succeeds; jobs `build success` and `publish skipped`; log line `release-gate: v0.10.8 -> create`.

- [ ] **Step 4: Verify the artifact**

```bash
S="${TMPDIR:-/tmp}/gaffer-rel"; rm -rf "$S/dryrun"; mkdir -p "$S/dryrun"
gh run download "$RUN_ID" -n gaffer-release -D "$S/dryrun"
ls "$S/dryrun" "$S/dryrun/dist"
cmp "$S/dryrun/dist/gaffer-install-mac.tar.gz" "$S/dryrun/dist/gaffer-update-mac.tar.gz" && echo "mac assets identical"
cmp "$S/dryrun/dist/gaffer-install-win.zip" "$S/dryrun/dist/gaffer-update-win.zip" && echo "win assets identical"
tar -xzOf "$S/dryrun/dist/gaffer-update-mac.tar.gz" ./version.json
git rev-parse origin/main
unzip -p "$S/dryrun/dist/gaffer-update-win.zip" version.json
tar -tzf "$S/dryrun/dist/gaffer-install-mac.tar.gz" | grep -c 'gaffer-ae-main' || true
head -1 "$S/dryrun/notes.md"
gh release list --repo spendolas/gaffer-ae
git ls-remote --tags origin
```

Expected: `dist` and `notes.md` at the top; the four assets in `dist`; both "identical" lines; both `version.json` copies show `"version": "0.10.8"` and `"commit"` equal to `git rev-parse origin/main`; `0` archive paths containing `gaffer-ae-main`; the v0.10.8 bold summary line; `gh release list` and `git ls-remote --tags` print nothing (no release, no tag).

- [ ] **Step 5: MANUAL, negative workflow checks on a scratch branch (spec "Workflow tests")**

The publish job only runs for `refs/heads/main`, and `windows-tests.yml` only triggers on `main`, so a scratch branch is safe.

```bash
git switch -c ci/release-negative
cat > panel/daemon/test/zz-forced-failure.test.mjs <<'EOF'
import { test } from 'node:test';
test('forced failure for the release workflow check', () => { throw new Error('forced'); });
EOF
git add panel/daemon/test/zz-forced-failure.test.mjs
git commit -m "test: forced failure (scratch branch, never merged)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push -u origin ci/release-negative
gh workflow run release.yml --ref ci/release-negative -f dry_run=true
sleep 10; RUN_ID="$(gh run list --workflow release.yml --branch ci/release-negative --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status; echo "exit=$?"
```

Expected: the run fails in step `Tests` (`not ok ... forced failure`), `exit=1`.

```bash
git rm -q panel/daemon/test/zz-forced-failure.test.mjs
printf '\xef\xbb\xbf# caf\xc3\xa9\n' > scripts/zz-non-ascii.ps1
git add scripts/zz-non-ascii.ps1
git commit -m "test: non-ASCII ps1 (scratch branch, never merged)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push
gh workflow run release.yml --ref ci/release-negative -f dry_run=true
sleep 10; RUN_ID="$(gh run list --workflow release.yml --branch ci/release-negative --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status; echo "exit=$?"
gh run view "$RUN_ID" --log | grep 'zz-non-ascii'
```

Expected: the run fails in step `Tests` with `FAIL  scripts/zz-non-ascii.ps1  [1 non-ASCII bytes, first at 9]`, `exit=1`.

Clean up:

```bash
git switch main
git push origin --delete ci/release-negative
git branch -D ci/release-negative
git status --short     # only the known untracked files
```

- [ ] **Step 6: Optional MANUAL check of the traffic extension**

```bash
gh workflow run traffic-snapshot.yml
sleep 10; RUN_ID="$(gh run list --workflow traffic-snapshot.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status
git pull --rebase origin main
tail -1 docs/traffic-snapshots.jsonl | jq -c '{releases, installs, updates}'
```

Expected: `{"releases":[],"installs":0,"updates":0}`. (The bot commits to `main`; the `git pull --rebase` keeps local `main` current.)

---

### Task 6: Panel update logic

**Files:**
- Create: `panel/update-state.js`
- Test: `panel/daemon/test/update-state.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces `window.GafferUpdateState` with:
  - `UPDATE_ASSETS = { mac: 'gaffer-update-mac.tar.gz', win: 'gaffer-update-win.zip' }`
  - `isNewerVersion(remoteVer, localVer) -> boolean` (moved verbatim from `main.js`)
  - `parseRelease(json, os) -> { version, commit, hasAsset } | null` (`os` is `'mac'` or `'win'`)
  - `parseReleaseCache(raw: string | null) -> { etag, version, commit, hasAsset } | null`
  - `readReleaseResponse(status, json, etag, cache, os) -> { kind: 'release', release, cache } | { kind: 'no-info' } | { kind: 'error', message }`
  - `decideUpdate(remote, local, dismissed) -> { state: 'local-unknown' | 'up-to-date' | 'available', showBanner: boolean }`
  - `shouldReloadAfterUpdate(startVersion, diskJson: string) -> boolean`
  - `updateVerdict(attempt, localVersion, now) -> 'none' | 'stale' | 'ok' | 'failed'`

- [ ] **Step 1: Write the failing test**

Create `panel/daemon/test/update-state.test.mjs`:

```javascript
// panel/update-state.js is a plain browser script (ES5, assigns
// window.GafferUpdateState). Load it into a node:vm context with a stub
// window, the same way the panel's <script> tag would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../../update-state.js', import.meta.url)), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: 'update-state.js' });
const U = sandbox.window.GafferUpdateState;
// vm objects come from another realm: compare plain copies with deepEqual.
const plain = (o) => JSON.parse(JSON.stringify(o));

const MAC = 'gaffer-update-mac.tar.gz';
const WIN = 'gaffer-update-win.zip';
const release = (tag, names) => ({
  tag_name: tag,
  target_commitish: '0123456789abcdef0123456789abcdef01234567',
  assets: names.map((name) => ({ name, download_count: 0 })),
});

test('exposes the API on window.GafferUpdateState', () => {
  for (const fn of ['isNewerVersion', 'parseRelease', 'parseReleaseCache', 'readReleaseResponse',
    'decideUpdate', 'shouldReloadAfterUpdate', 'updateVerdict']) {
    assert.equal(typeof U[fn], 'function', fn);
  }
});

test('isNewerVersion: strict semver greater-than, garbage is never newer', () => {
  assert.equal(U.isNewerVersion('0.11.0', '0.10.8'), true);
  assert.equal(U.isNewerVersion('0.10.10', '0.10.9'), true);
  assert.equal(U.isNewerVersion('0.11.0', '0.11.0'), false);
  assert.equal(U.isNewerVersion('0.10.8', '0.11.0'), false);
  assert.equal(U.isNewerVersion(null, '0.11.0'), false);
  assert.equal(U.isNewerVersion('', '0.11.0'), false);
});

test('parseRelease: strips the v prefix and reads target_commitish', () => {
  const r = U.parseRelease(release('v0.11.0', [MAC, WIN]), 'mac');
  assert.deepEqual(plain(r), { version: '0.11.0', commit: '0123456789abcdef0123456789abcdef01234567', hasAsset: true });
  assert.equal(U.parseRelease(release('0.11.0', [MAC]), 'mac').version, '0.11.0');
});

test('parseRelease: hasAsset is per platform', () => {
  assert.equal(U.parseRelease(release('v0.11.0', [MAC]), 'mac').hasAsset, true);
  assert.equal(U.parseRelease(release('v0.11.0', [MAC]), 'win').hasAsset, false);
  assert.equal(U.parseRelease(release('v0.11.0', [WIN]), 'win').hasAsset, true);
  assert.equal(U.parseRelease(release('v0.11.0', ['gaffer-install-mac.tar.gz']), 'mac').hasAsset, false);
  assert.equal(U.parseRelease({ tag_name: 'v0.11.0' }, 'mac').hasAsset, false);
});

test('parseRelease: no tag -> null', () => {
  assert.equal(U.parseRelease(null, 'mac'), null);
  assert.equal(U.parseRelease({ message: 'Not Found' }, 'mac'), null);
  assert.equal(U.parseRelease({ tag_name: '' }, 'mac'), null);
});

test('parseReleaseCache: valid, corrupt and incomplete caches', () => {
  const good = JSON.stringify({ etag: 'W/"abc"', version: '0.11.0', commit: 'abc', hasAsset: true });
  assert.deepEqual(plain(U.parseReleaseCache(good)), { etag: 'W/"abc"', version: '0.11.0', commit: 'abc', hasAsset: true });
  assert.equal(U.parseReleaseCache(null), null);
  assert.equal(U.parseReleaseCache(''), null);
  assert.equal(U.parseReleaseCache('{not json'), null);
  assert.equal(U.parseReleaseCache(JSON.stringify({ version: '0.11.0' })), null);
  assert.equal(U.parseReleaseCache(JSON.stringify({ etag: 'x' })), null);
});

test('readReleaseResponse: 200 parses and returns a cache entry when an ETag came back', () => {
  const out = U.readReleaseResponse(200, release('v0.11.0', [MAC]), 'W/"e1"', null, 'mac');
  assert.equal(out.kind, 'release');
  assert.equal(out.release.version, '0.11.0');
  assert.deepEqual(plain(out.cache), { etag: 'W/"e1"', version: '0.11.0', commit: '0123456789abcdef0123456789abcdef01234567', hasAsset: true });
  assert.equal(U.readReleaseResponse(200, release('v0.11.0', [MAC]), null, null, 'mac').cache, null);
});

test('readReleaseResponse: 304 path uses the cached release', () => {
  const cache = { etag: 'W/"e1"', version: '0.11.0', commit: 'abc', hasAsset: true };
  const out = U.readReleaseResponse(304, null, null, cache, 'mac');
  assert.equal(out.kind, 'release');
  assert.deepEqual(plain(out.release), { version: '0.11.0', commit: 'abc', hasAsset: true });
  assert.equal(out.cache, null);
  assert.equal(U.readReleaseResponse(304, null, null, null, 'mac').kind, 'no-info');
});

test('readReleaseResponse: 403, 429 and 404 are "no update info", not errors', () => {
  for (const status of [403, 429, 404]) {
    assert.equal(U.readReleaseResponse(status, { message: 'x' }, null, null, 'mac').kind, 'no-info', String(status));
  }
});

test('readReleaseResponse: other failures are errors', () => {
  assert.deepEqual(plain(U.readReleaseResponse(500, null, null, null, 'mac')), { kind: 'error', message: 'HTTP 500' });
  assert.deepEqual(plain(U.readReleaseResponse(200, { nope: 1 }, null, null, 'mac')), { kind: 'error', message: 'Invalid release response' });
});

test('decideUpdate: newer / equal / older / dismissed', () => {
  const remote = { version: '0.11.0', commit: 'x', hasAsset: true };
  assert.deepEqual(plain(U.decideUpdate(remote, '0.10.8', null)), { state: 'available', showBanner: true });
  assert.deepEqual(plain(U.decideUpdate(remote, '0.11.0', null)), { state: 'up-to-date', showBanner: false });
  assert.deepEqual(plain(U.decideUpdate(remote, '0.12.0', null)), { state: 'up-to-date', showBanner: false });
  assert.deepEqual(plain(U.decideUpdate(remote, '0.10.8', '0.11.0')), { state: 'available', showBanner: false });
  assert.deepEqual(plain(U.decideUpdate(remote, '0.10.8', '0.10.9')), { state: 'available', showBanner: true });
});

test('decideUpdate: missing platform asset is never offered', () => {
  const remote = { version: '0.11.0', commit: 'x', hasAsset: false };
  assert.equal(U.decideUpdate(remote, '0.10.8', null).state, 'up-to-date');
});

test('decideUpdate: unknown local version', () => {
  const remote = { version: '0.11.0', commit: 'x', hasAsset: true };
  assert.equal(U.decideUpdate(remote, null, null).state, 'local-unknown');
  assert.equal(U.decideUpdate(remote, '', null).state, 'local-unknown');
  assert.equal(U.decideUpdate(remote, 'dev', null).state, 'local-unknown');
});

test('shouldReloadAfterUpdate: same version, new version, half-written JSON', () => {
  assert.equal(U.shouldReloadAfterUpdate('0.10.8', '{"version":"0.10.8","commit":"401c1ec"}'), false);
  assert.equal(U.shouldReloadAfterUpdate('0.10.8', '{"version":"0.11.0","commit":"abc"}'), true);
  assert.equal(U.shouldReloadAfterUpdate('0.10.8', '{"version":"0.11'), false);
  assert.equal(U.shouldReloadAfterUpdate('0.10.8', ''), false);
  assert.equal(U.shouldReloadAfterUpdate('0.10.8', '{"commit":"abc"}'), false);
});

test('updateVerdict: none, ok, failed, stale', () => {
  const now = 1000000000;
  assert.equal(U.updateVerdict(null, '0.11.0', now), 'none');
  assert.equal(U.updateVerdict({ target: '0.11.0', at: now - 1000 }, '0.11.0', now), 'ok');
  assert.equal(U.updateVerdict({ target: '0.11.0', at: now - 1000 }, '0.11.1', now), 'ok');
  assert.equal(U.updateVerdict({ target: '0.11.0', at: now - 1000 }, '0.10.8', now), 'failed');
  assert.equal(U.updateVerdict({ target: '0.11.0', at: now - 11 * 60 * 1000 }, '0.10.8', now), 'stale');
  assert.equal(U.updateVerdict({ target: null, at: now }, '0.10.8', now), 'stale');
});

test('updateVerdict: a commit-keyed attempt left by a pre-0.11 panel is cleared silently', () => {
  const now = 1000000000;
  assert.equal(U.updateVerdict({ target: '401c1ec', at: now - 1000 }, '0.11.0', now), 'stale');
  assert.equal(U.updateVerdict({ target: '9f8e7d6c5b4a', at: now - 1000 }, '0.11.0', now), 'stale');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd panel/daemon && node --test test/update-state.test.mjs`
Expected: FAIL, the file errors at load with `ENOENT: no such file or directory, open '.../panel/update-state.js'`, `# fail 1`.

- [ ] **Step 3: Write minimal implementation**

Create `panel/update-state.js` (the `isNewerVersion` body and comment are copied verbatim from `panel/main.js:2573-2586`):

```javascript
// Pure update-check logic for the panel, kept out of main.js so it can be
// unit tested (panel/daemon/test/update-state.test.mjs loads this file into
// node:vm with a stub window). Plain ES5, no DOM, no network, no storage.
// Loaded by a <script> tag in index.html BEFORE main.js.
(function (root) {
  'use strict';

  var UPDATE_ASSETS = { mac: 'gaffer-update-mac.tar.gz', win: 'gaffer-update-win.zip' };
  var ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
  var VERSION_LIKE = /^\d+\.\d+\.\d+/;

  // True only when remoteVer is a STRICTLY newer semver than localVer. The update
  // banner must gate on this, not on a bare commit mismatch: a differing commit
  // can be an equal or OLDER release, and offering that as an "update" prompts a
  // downgrade (seen: a 0.10.0 install told to "update" to 0.9.9). Missing/garbled
  // versions compare as not-newer, so a bad remote never nags.
  function isNewerVersion(remoteVer, localVer) {
    function parts(v) { return String(v == null ? '' : v).split('.').map(function (n) { return parseInt(n, 10) || 0; }); }
    var r = parts(remoteVer), l = parts(localVer);
    for (var i = 0; i < Math.max(r.length, l.length); i++) {
      var a = r[i] || 0, b = l[i] || 0;
      if (a !== b) return a > b;
    }
    return false;
  }

  // GitHub "latest release" JSON -> { version, commit, hasAsset }, or null
  // when the payload has no usable tag. os is 'mac' or 'win'; hasAsset says
  // whether THIS platform's update asset is attached.
  function parseRelease(json, os) {
    if (!json || typeof json.tag_name !== 'string' || !json.tag_name) return null;
    var wanted = UPDATE_ASSETS[os];
    var assets = json.assets && json.assets.length ? json.assets : [];
    var hasAsset = false;
    for (var i = 0; i < assets.length; i++) {
      if (assets[i] && assets[i].name === wanted) { hasAsset = true; break; }
    }
    return {
      version: json.tag_name.replace(/^v/, ''),
      commit: typeof json.target_commitish === 'string' ? json.target_commitish : null,
      hasAsset: hasAsset
    };
  }

  // localStorage gafferReleaseCache string -> { etag, version, commit, hasAsset }
  // or null when absent, unparseable or missing the etag/version.
  function parseReleaseCache(raw) {
    if (!raw) return null;
    var c;
    try { c = JSON.parse(raw); } catch (e) { return null; }
    if (!c || typeof c.etag !== 'string' || !c.etag || typeof c.version !== 'string' || !c.version) return null;
    return { etag: c.etag, version: c.version, commit: typeof c.commit === 'string' ? c.commit : null, hasAsset: c.hasAsset === true };
  }

  // One fetch of releases/latest -> what main.js should do next.
  //   { kind: 'release', release: {version, commit, hasAsset}, cache: <obj or null> }
  //   { kind: 'no-info' }   403 / 429 / 404 / 304-without-cache: change nothing, say nothing alarming
  //   { kind: 'error', message }
  // cache in the result is what to store under gafferReleaseCache (null = leave as is).
  function readReleaseResponse(status, json, etag, cache, os) {
    if (status === 304) {
      if (!cache) return { kind: 'no-info' };
      return { kind: 'release', release: { version: cache.version, commit: cache.commit, hasAsset: cache.hasAsset }, cache: null };
    }
    if (status === 403 || status === 429 || status === 404) return { kind: 'no-info' };
    if (status !== 200) return { kind: 'error', message: 'HTTP ' + status };
    var release = parseRelease(json, os);
    if (!release) return { kind: 'error', message: 'Invalid release response' };
    var nextCache = etag
      ? { etag: etag, version: release.version, commit: release.commit, hasAsset: release.hasAsset }
      : null;
    return { kind: 'release', release: release, cache: nextCache };
  }

  // remote: parsed release (or null). local: versionData.version.
  // dismissed: the version whose banner the user dismissed (or null).
  //   state 'local-unknown' | 'up-to-date' | 'available'; showBanner only when available and not dismissed.
  function decideUpdate(remote, local, dismissed) {
    if (!local || !VERSION_LIKE.test(String(local))) return { state: 'local-unknown', showBanner: false };
    if (!remote || !remote.hasAsset || !isNewerVersion(remote.version, local)) {
      return { state: 'up-to-date', showBanner: false };
    }
    return { state: 'available', showBanner: remote.version !== dismissed };
  }

  // Poll check during an update: reload only once the on-disk version.json
  // parses and carries a version different from the one we started on.
  function shouldReloadAfterUpdate(startVersion, diskJson) {
    var v;
    try { v = JSON.parse(diskJson).version; } catch (e) { return false; }
    if (typeof v !== 'string' || !v) return false;
    return v !== startVersion;
  }

  // Post-reload verdict for localStorage gafferUpdateAttempt { target, at }.
  //   'none'   no attempt recorded
  //   'stale'  too old, or written by a pre-0.11 panel (target is a commit): clear silently
  //   'ok'     the local version reached the target (or went past it)
  //   'failed' the target is still newer than the local version
  function updateVerdict(attempt, localVersion, now) {
    if (!attempt) return 'none';
    if (!attempt.target || typeof attempt.at !== 'number' || now - attempt.at >= ATTEMPT_WINDOW_MS) return 'stale';
    if (!VERSION_LIKE.test(String(attempt.target))) return 'stale';
    return isNewerVersion(attempt.target, localVersion) ? 'failed' : 'ok';
  }

  root.GafferUpdateState = {
    UPDATE_ASSETS: UPDATE_ASSETS,
    isNewerVersion: isNewerVersion,
    parseRelease: parseRelease,
    parseReleaseCache: parseReleaseCache,
    readReleaseResponse: readReleaseResponse,
    decideUpdate: decideUpdate,
    shouldReloadAfterUpdate: shouldReloadAfterUpdate,
    updateVerdict: updateVerdict
  };
})(window);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd panel/daemon && node --test test/update-state.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)'
node --test 2>&1 | grep -E '^# (tests|pass|fail)'
```

Expected: `# tests 16`, `# pass 16`, `# fail 0`; full suite `# tests 181`, `# pass 181`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add panel/update-state.js panel/daemon/test/update-state.test.mjs
git commit -m "feat(panel): pure update-state logic for GitHub Releases" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Panel wiring (main.js, index.html, capture seam)

**Files:**
- Modify: `panel/main.js` (line ranges below are for the unmodified file: 2, 155-156, 794, 876-885, 1974-1979, 2476, 2517, 2546-2548, 2555-2569, 2573-2634, 2688, 2702-2707, 2716, 2723-2725, 2742, 2816-2817, 3656-3662)
- Modify: `panel/index.html:1880` (script tags)
- Modify: `design/scripts/panel-capture.mjs:272-278`
- Test: `panel/daemon/test/update-wiring.test.mjs`

**Interfaces:**
- Consumes: `window.GafferUpdateState` from Task 6 (all eight members).
- Produces: `main.js` state `availableUpdateVersion` / `dismissedUpdateVersion` (persisted in the chat-history payload as `dismissedUpdateVersion`), localStorage `gafferReleaseCache`, the review seam `window.__gaffer.setUpdateAvailable(version)`.

- [ ] **Step 1: Write the failing test**

Create `panel/daemon/test/update-wiring.test.mjs`:

```javascript
// main.js has no unit harness (plain <script>, one big IIFE). These
// text-level checks pin the GitHub Releases update wiring so a later edit
// cannot quietly bring back the commit-keyed check against main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const html = read('../../index.html');
const main = read('../../main.js');
const capture = read('../../../design/scripts/panel-capture.mjs');

test('index.html loads update-state.js before main.js', () => {
  const state = html.indexOf('<script src="update-state.js"></script>');
  const mainTag = html.indexOf('<script src="main.js"></script>');
  assert.ok(state !== -1, 'no <script src="update-state.js"> tag');
  assert.ok(mainTag !== -1, 'no <script src="main.js"> tag');
  assert.ok(state < mainTag, 'update-state.js must load before main.js');
});

test('main.js no longer keys update state on the commit', () => {
  for (const gone of ['availableUpdateCommit', 'dismissedUpdateCommit', 'startCommit',
    'raw.githubusercontent.com/spendolas/gaffer-ae/main/panel/version.json', 'function isNewerVersion']) {
    assert.ok(!main.includes(gone), 'main.js still contains ' + gone);
  }
});

test('main.js checks the latest GitHub release through GafferUpdateState', () => {
  for (const needed of ['window.GafferUpdateState',
    "'https://api.github.com/repos/spendolas/gaffer-ae/releases/latest'",
    "'gafferReleaseCache'", "'If-None-Match'", "'application/vnd.github+json'",
    'UpdateState.readReleaseResponse(', 'UpdateState.decideUpdate(',
    'UpdateState.shouldReloadAfterUpdate(', 'UpdateState.updateVerdict(',
    'dismissedUpdateVersion: dismissedUpdateVersion']) {
    assert.ok(main.includes(needed), 'main.js is missing ' + needed);
  }
});

test('rate limits and missing releases show the neutral message, never "Update check failed"', () => {
  assert.ok(main.includes("'Could not check for updates right now, try again later.'"));
  const noInfo = main.match(/if \(out\.kind === 'no-info'\) \{([\s\S]*?)\n        \}/);
  assert.ok(noInfo, 'no no-info branch in checkForUpdate');
  assert.ok(!noInfo[1].includes('markUpdateChecked'), 'no-info must not record a check');
  assert.ok(!noInfo[1].includes('Update check failed'));
});

test('update copy in main.js has no em or en dashes', () => {
  for (const line of main.split('\n')) {
    if (/Update did not complete|Could not check for updates|Gaffer is up to date|Update available, v/.test(line)) {
      assert.ok(!/[\u2013\u2014]/.test(line), 'dash in: ' + line.trim());
    }
  }
});

test('panel-capture forces the update-available state with a version', () => {
  assert.ok(capture.includes("setUpdateAvailable('99.0.0')"));
  assert.ok(!capture.includes("setUpdateAvailable('feedface')"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd panel/daemon && node --test test/update-wiring.test.mjs`
Expected: `# tests 6`, `# pass 0`, `# fail 6` (no script tag, old names present, new names missing, no neutral message, an em-dash in the old "Update did not complete" copy, `'feedface'` in panel-capture).

- [ ] **Step 3: Write minimal implementation**

`panel/index.html`: replace line 1880 `  <script src="main.js"></script>` with:

```html
  <script src="update-state.js"></script>
  <script src="main.js"></script>
```

`design/scripts/panel-capture.mjs`: replace the two comment lines 272-273 (above `'update-available': function () {`) with:

```javascript
    // Update CTA: only appears when a check has confirmed a newer release.
    // Force an available version (dev seam) to capture the shown state.
```

and in line 278 change `window.__gaffer.setUpdateAvailable('feedface')` to `window.__gaffer.setUpdateAvailable('99.0.0')`.

`panel/main.js`, edit by edit. Line numbers are for the unmodified file, so apply the edits from the bottom of the file up (M17 first), or match on the quoted text with your editor. Where an old block contains an em-dash, it is identified by its line range and its first and last lines.

M1. After line 2 (`  var cs = new CSInterface();`) insert:

```javascript
  // Pure update-check logic (panel/update-state.js, loaded before this file).
  var UpdateState = window.GafferUpdateState;
```

M2. Replace lines 155-156 (`  var dismissedUpdateCommit = null;` and `  var availableUpdateCommit = null; // independent of whether its banner was dismissed`) with:

```javascript
  var dismissedUpdateVersion = null;
  var availableUpdateVersion = null; // independent of whether its banner was dismissed
```

M3. In `saveChat()`, replace line 794 `      dismissedUpdateCommit: dismissedUpdateCommit,` with:

```javascript
      dismissedUpdateVersion: dismissedUpdateVersion,
```

M4. In `restoreChat()`, replace lines 876-885 (from `        if (data.dismissedUpdateCommit) {` to its closing `        }`) with:

```javascript
        if (typeof data.dismissedUpdateVersion === 'string' && data.dismissedUpdateVersion) {
          // Remember only WHICH banner the user dismissed, so a completed check
          // can keep that banner suppressed. Do NOT resurrect availability from
          // it: the Update CTA must appear only after a fresh check confirms a
          // newer release (unknown != update-available, same rule as the
          // account card / model discovery). Seeding availableUpdateVersion here
          // flashed the Settings Update CTA on every reload until the async
          // check (or dev-detect) resolved. The commit-keyed field that
          // pre-0.11 panels saved is ignored on purpose.
          dismissedUpdateVersion = data.dismissedUpdateVersion;
        }
```

M5. Replace lines 1974-1979 (from the comment `// Update-CTA review hook` through the closing `      };` of `window.__gaffer.setUpdateAvailable`) with:

```javascript
      // Update-CTA review hook: set the confirmed-available release version so
      // the update-available state can be captured without hitting the network.
      window.__gaffer.setUpdateAvailable = function (version) {
        availableUpdateVersion = version || null;
        syncSettingsUpdateButton();
      };
```

M6. After line 2476 (`  var versionData = { version: 'dev', commit: null };`) insert:

```javascript
  var RELEASES_LATEST_URL = 'https://api.github.com/repos/spendolas/gaffer-ae/releases/latest';
  var RELEASE_CACHE_KEY = 'gafferReleaseCache';
```

M7. In `detectDevInstall()`, replace line 2517 `      availableUpdateCommit = null;` with:

```javascript
      availableUpdateVersion = null;
```

M8. In `loadVersion()`, replace lines 2546-2548 (the two comment lines starting `// An update remembered from a dismissed banner` and the line `if (availableUpdateCommit === versionData.commit) availableUpdateCommit = null;`) with:

```javascript
          // An update remembered from a dismissed banner may since have been
          // installed outside this panel. Reconcile it against the local version.
          if (availableUpdateVersion && !UpdateState.isNewerVersion(availableUpdateVersion, versionData.version)) {
            availableUpdateVersion = null;
          }
```

M9. In `loadVersion()`, replace lines 2555-2569 (from `      // Post-update verdict: if we attempted an update just before this` through `      } catch (e) { /* ignore */ }`) with:

```javascript
      // Post-update verdict: if we attempted an update just before this
      // reload and the local version did not reach the target, the script
      // failed, so say so. A commit-keyed attempt from a pre-0.11 panel is
      // cleared without a message (updateVerdict returns 'stale').
      try {
        var attempt = JSON.parse(localStorage.getItem('gafferUpdateAttempt') || 'null');
        var verdict = UpdateState.updateVerdict(attempt, versionData.version, Date.now());
        if (verdict !== 'none') localStorage.removeItem('gafferUpdateAttempt');
        if (verdict === 'failed') {
          showChatNotice('Update did not complete. The updater log has details: '
            + '%TEMP%\\gaffer-update.log (Windows) / /tmp/gaffer-update.log (macOS). '
            + 'You can also run the update script manually from the daemon folder.');
        }
      } catch (e) { /* ignore */ }
```

M10. Replace lines 2573-2634 (from `  // True only when remoteVer is a STRICTLY newer semver than localVer.` through the closing `  }` of `checkForUpdate`; this deletes `isNewerVersion`, which now lives in `update-state.js`) with:

```javascript
  function checkForUpdate(silent) {
    if (isDevInstall) {
      availableUpdateVersion = null;
      updateBannerEl.classList.remove('visible');
      syncSettingsUpdateButton();
      markUpdateChecked();
      if (!silent) showModal('Dev install (git checkout), the panel updater is disabled. Pull changes with git instead.');
      return;
    }
    // Ask GitHub for the latest published release. Revalidate with the ETag
    // from the last answer: a 304 does not count against the 60 per hour
    // unauthenticated limit. 403 / 429 (rate limit) and 404 (no release yet)
    // mean "no update info": leave the banner and CTA alone, and do not
    // record a check.
    var cache = null;
    try { cache = UpdateState.parseReleaseCache(localStorage.getItem(RELEASE_CACHE_KEY)); } catch (e) { cache = null; }
    var headers = { 'Accept': 'application/vnd.github+json' };
    if (cache) headers['If-None-Match'] = cache.etag;
    fetch(RELEASES_LATEST_URL, { cache: 'no-store', headers: headers })
      .then(function (r) {
        if (r.status !== 200) return { status: r.status, json: null, etag: null };
        return r.json().then(
          function (json) { return { status: 200, json: json, etag: r.headers.get('ETag') }; },
          function () { return { status: 200, json: null, etag: null }; }
        );
      })
      .then(function (res) {
        var out = UpdateState.readReleaseResponse(res.status, res.json, res.etag, cache, isMacOS() ? 'mac' : 'win');
        if (out.kind === 'no-info') {
          if (!silent) showModal('Could not check for updates right now, try again later.');
          return;
        }
        if (out.kind === 'error') throw new Error(out.message);
        if (out.cache) {
          try { localStorage.setItem(RELEASE_CACHE_KEY, JSON.stringify(out.cache)); } catch (e) { /* ignore */ }
        }
        markUpdateChecked();
        var decision = UpdateState.decideUpdate(out.release, versionData.version, dismissedUpdateVersion);
        if (decision.state === 'local-unknown') {
          if (!silent) showModal('Local version unknown. Reinstall to enable updates.');
          return;
        }
        // Up to date unless the release is a genuinely NEWER version with this
        // platform's update asset attached. An equal or older release must
        // never surface as an available update (that offered a downgrade).
        if (decision.state === 'up-to-date') {
          availableUpdateVersion = null;
          updateBannerEl.classList.remove('visible');
          syncSettingsUpdateButton();
          if (!silent) showModal('Gaffer is up to date (v' + versionData.version + ')');
          return;
        }
        // Availability is durable for the session; banner dismissal is only a
        // presentation preference and must never remove the Settings safeguard.
        availableUpdateVersion = out.release.version;
        syncSettingsUpdateButton();
        if (!decision.showBanner) return;
        resetUpdateBannerButtons();
        updateTextEl.textContent = 'Update available, v' + out.release.version;
        updateBannerEl.classList.add('visible');
        syncSettingsUpdateButton();
      }).catch(function (e) {
        markUpdateChecked();
        if (!silent) showModal('Update check failed: ' + e.message);
      });
  }
```

M11. In `runUpdate()`, replace line 2688 `      availableUpdateCommit = null;` with:

```javascript
      availableUpdateVersion = null;
```

M12. In `reloadAfterUpdate()`, replace lines 2702-2707 (from `      // The updater needs ~30-60s (download + npm). Poll the on-disk` through `          target: availableUpdateCommit || null,`) with:

```javascript
      // The updater needs ~30-60s (download + npm). Poll the on-disk
      // version.json and reload ONLY once its version moves. The updater
      // writes that file last, so reloading earlier would load half-copied
      // files and flag a false failure.
      try {
        localStorage.setItem('gafferUpdateAttempt', JSON.stringify({
          target: availableUpdateVersion || null,
```

M13. Replace line 2716 `      var startCommit = versionData.commit;` with:

```javascript
      var startVersion = versionData.version;
```

M14. Replace lines 2723-2725 (`          var commit = null;`, the `try { commit = JSON.parse(result).commit; }` line, and `          if (commit && commit !== startCommit) {`) with:

```javascript
          if (UpdateState.shouldReloadAfterUpdate(startVersion, result)) {
```

M15. Replace line 2742 (the `showChatNotice('Update did not complete` line inside the 180 s timeout branch; keep line 2743) with:

```javascript
            showChatNotice('Update did not complete. The updater log has details: '
```

M16. In `dismissUpdate()`, replace lines 2816-2817 with:

```javascript
    if (availableUpdateVersion) {
      dismissedUpdateVersion = availableUpdateVersion;
```

M17. In `syncSettingsUpdateButton()`, replace lines 3656-3662 (the three comment lines starting `// Show ONLY when a completed check`, `var localCommit = ...`, and the three-line `var available = ...` expression) with:

```javascript
    // Show ONLY when a completed check has confirmed an available release
    // newer than the local version. Pre-check / in-flight / up-to-date all
    // leave availableUpdateVersion null (or not newer than local) -> no CTA.
    var available = !!availableUpdateVersion
      && UpdateState.isNewerVersion(availableUpdateVersion, versionData && versionData.version)
      && !window.__gafferUpdating;
```

Then check nothing commit-keyed is left:

```bash
grep -n 'UpdateCommit\|startCommit\|function isNewerVersion\|raw.githubusercontent.com/spendolas/gaffer-ae/main/panel' panel/main.js
```

Expected: no output.

- [ ] **Step 4: Run test to verify it passes**

```bash
node --check panel/main.js && node --check panel/update-state.js && echo "syntax OK"
cd panel/daemon && node --test test/update-wiring.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)'
node --test 2>&1 | grep -E '^# (tests|pass|fail)'
```

Expected: `syntax OK`; `# tests 6`, `# pass 6`, `# fail 0`; full suite `# tests 187`, `# pass 187`, `# fail 0`.

Manual wiring check in the owner's dev panel (it is a symlink to this repo, so it loads the working tree; the updater itself stays disabled on a dev install, so the network paths are verified after the release exists, in Task 11). With After Effects open and the Gaffer panel visible (ask the owner):

```bash
node design/scripts/panel-capture.mjs
```

Expected: it prints `captured update-available (...)` among the states and ends with `panel reloaded to restore real state` (a `main.js` load error would stop it at `audit seam not available`). Open `design/refs/panel/state-update-available.png` (untracked output): the Settings view shows the **Update** button.

- [ ] **Step 5: Commit**

```bash
git add panel/main.js panel/index.html design/scripts/panel-capture.mjs panel/daemon/test/update-wiring.test.mjs
git commit -m "feat(panel): check the latest GitHub release, key update state on version" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: macOS updater (`update.sh`)

**Files:**
- Modify: `panel/daemon/update.sh` (full rewrite of lines 1-154)
- Test: `scripts/test-update-sh.sh`

**Interfaces:**
- Consumes: `bash scripts/package-release.sh` (Task 2); the committed `panel/` tree (Tasks 6 and 7 are committed, so the fake asset is the new client).
- Produces: `update.sh` honoring `GAFFER_UPDATE_ASSET` (URL or local path; default `https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-update-mac.tar.gz`), last log line `ok:<version>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-update-sh.sh`:

```bash
#!/bin/bash
# End-to-end test for panel/daemon/update.sh against a scratch install.
#
# Builds a fake release asset from the committed tree with
# scripts/package-release.sh, lays down a v0.10.8 install (git commit
# ce16c2f) under a path WITH A SPACE (real installs live under
# "Application Support"), seeds user data, runs the working-tree update.sh
# from inside that install with GAFFER_UPDATE_ASSET pointing at the asset,
# and checks the result. A second case feeds it a broken download and checks
# that nothing in the install changed.
#
# update.sh stops whatever listens on port 9823, so this refuses to run while
# a Gaffer daemon is up. Close the Gaffer panel (or get the owner's OK to stop
# the daemon) first.
#
# Usage (from the repo root): bash scripts/test-update-sh.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OLD_REF="ce16c2f"   # release: v0.10.8
FAILS=0

fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }
pass() { echo "PASS: $*"; }

if lsof -nP -iTCP:9823 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "ABORT: something is listening on port 9823 (a running Gaffer daemon)."
  echo "update.sh would stop it. Close the Gaffer panel first, then re-run."
  exit 2
fi

if ! grep -q 'GAFFER_UPDATE_ASSET' "$REPO_ROOT/panel/daemon/update.sh"; then
  echo "FAIL: panel/daemon/update.sh does not honor GAFFER_UPDATE_ASSET (still the main-archive updater)"
  exit 1
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-update-test-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export TMPDIR="$SCRATCH/tmp"
mkdir -p "$TMPDIR"

# Fake release asset from the committed tree
(cd "$REPO_ROOT" && bash scripts/package-release.sh 9.9.9 feedfacecafe "$SCRATCH/dist" >/dev/null)
ASSET="$SCRATCH/dist/gaffer-update-mac.tar.gz"

new_install() {
  local dir="$1"
  mkdir -p "$dir"
  (cd "$REPO_ROOT" && git archive "$OLD_REF:panel") | tar -x -C "$dir"
  # Pre-seed node_modules (excluded from the sync) so npm install stays local and quick
  cp -R "$REPO_ROOT/panel/daemon/node_modules" "$dir/daemon/node_modules"
  # The update.sh under test is the WORKING TREE copy
  cp "$REPO_ROOT/panel/daemon/update.sh" "$dir/daemon/update.sh"
  echo '{"messages":["legacy"]}' > "$dir/chat-history.json"
  echo '{"messages":["ae26"]}' > "$dir/chat-history-26.0.json"
  echo '{"installId":"legacy"}' > "$dir/.gaffer-config.json"
  echo '[{"event":"unsent"}]' > "$dir/.gaffer-usage-buffer.json"
  mkdir -p "$dir/.gaffer-icons"
  echo '<svg id="cached"/>' > "$dir/.gaffer-icons/notion.svg"
  echo 'stale' > "$dir/stale-file-from-old-release.txt"
}

# ---------- Case 1: a good release asset ----------
INSTALL="$SCRATCH/Application Support/com.gaffer.panel"
new_install "$INSTALL"
(cd "$INSTALL" && shasum chat-history.json chat-history-26.0.json .gaffer-config.json .gaffer-usage-buffer.json .gaffer-icons/notion.svg) > "$SCRATCH/user-data.sha"

if GAFFER_UPDATE_ASSET="$ASSET" npm_config_audit=false npm_config_fund=false bash "$INSTALL/daemon/update.sh"; then
  pass "update.sh exited 0"
else
  fail "update.sh exited non-zero (log: $TMPDIR/gaffer-update.log)"
  cat "$TMPDIR/gaffer-update.log" || true
fi

if [ "$(cat "$INSTALL/version.json")" = "$(tar -xzOf "$ASSET" ./version.json)" ]; then
  pass "version.json is the release's stamped file"
else
  fail "version.json is not the release's: $(cat "$INSTALL/version.json")"
fi

if (cd "$INSTALL" && shasum -c "$SCRATCH/user-data.sha" >/dev/null 2>&1); then
  pass "chat history, legacy config, usage buffer and icon cache preserved byte for byte"
else
  fail "user data changed:"; (cd "$INSTALL" && shasum -c "$SCRATCH/user-data.sha") || true
fi

for junk in gaffer.tar.gz gaffer.zip gaffer-update-mac.tar.gz extract version.json.tmp stale-file-from-old-release.txt; do
  if [ -e "$INSTALL/$junk" ]; then fail "$junk left in the panel dir"; else pass "no $junk in the panel dir"; fi
done

if tar -xzOf "$ASSET" ./main.js | cmp -s - "$INSTALL/main.js" && [ -f "$INSTALL/daemon/index.js" ]; then
  pass "release files landed (main.js matches the asset)"
else
  fail "main.js in the install does not match the asset"
fi

NEWER="$(find "$INSTALL" -type f -newer "$INSTALL/version.json" | head -5)"
if [ -z "$NEWER" ]; then
  pass "version.json is the newest file in the panel dir (written last)"
else
  fail "files written after version.json: $NEWER"
fi

if grep -q 'ok:9.9.9' "$TMPDIR/gaffer-update.log"; then pass "log ends with ok:9.9.9"; else fail "no ok:9.9.9 in the log"; fi
if ls "$TMPDIR" | grep -q '^gaffer-update-[0-9]'; then fail "temp dir not cleaned up"; else pass "temp dir cleaned up"; fi

# ---------- Case 2: a broken download changes nothing ----------
BROKEN_INSTALL="$SCRATCH/Application Support/broken/com.gaffer.panel"
new_install "$BROKEN_INSTALL"
echo '<html>Not Found</html>' > "$SCRATCH/not-a-release.tar.gz"
BEFORE="$(cd "$BROKEN_INSTALL" && find . -path ./daemon/node_modules -prune -o -type f -print0 | sort -z | xargs -0 shasum)"
if GAFFER_UPDATE_ASSET="$SCRATCH/not-a-release.tar.gz" bash "$BROKEN_INSTALL/daemon/update.sh"; then
  fail "update.sh exited 0 on a broken download"
else
  pass "update.sh exited non-zero on a broken download"
fi
AFTER="$(cd "$BROKEN_INSTALL" && find . -path ./daemon/node_modules -prune -o -type f -print0 | sort -z | xargs -0 shasum)"
if [ "$BEFORE" = "$AFTER" ]; then pass "broken download left the install untouched"; else fail "broken download modified the install"; fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL PASS"; else echo "$FAILS FAILURE(S)"; exit 1; fi
```

- [ ] **Step 2: Run test to verify it fails**

Make sure the Gaffer panel is closed (the script refuses otherwise), then run: `bash scripts/test-update-sh.sh`
Expected: `FAIL: panel/daemon/update.sh does not honor GAFFER_UPDATE_ASSET (still the main-archive updater)`, exit code 1.

- [ ] **Step 3: Write minimal implementation**

Replace the whole of `panel/daemon/update.sh` with:

```bash
#!/bin/bash
# Gaffer update script: downloads the latest GitHub release asset, replaces
# panel files, preserves user data, restarts daemon.
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_DIR="$PANEL_DIR/daemon"
TMP_DIR="${TMPDIR:-/tmp}/gaffer-update-$$"
EXTRACT_DIR="$TMP_DIR/extract"
ASSET_NAME="gaffer-update-mac.tar.gz"
# GAFFER_UPDATE_ASSET overrides the download source with another URL or a
# local file path. Only scripts/test-update-sh.sh and pre-release checks set it.
ASSET_SOURCE="${GAFFER_UPDATE_ASSET:-https://github.com/spendolas/gaffer-ae/releases/latest/download/$ASSET_NAME}"

LOG="${TMPDIR:-/tmp}/gaffer-update.log"
exec >> "$LOG" 2>&1
echo "=== Update started: $(date) ==="

# Stop whatever holds the daemon's WebSocket port (9823), reliable regardless
# of how it was launched (`node index.js`, `env node index.js`, or the SEA
# binary). The old pattern kills (pkill -f "node.*daemon/index.js") never matched
# the real `node index.js` cmdline, so every update left a stale daemon running.
# Graceful first: SIGTERM lets a v0.9.5+ daemon drain in-flight work then exit;
# SIGKILL only if it outlives the window.
stop_daemon() {
  local pids i
  pids="$(lsof -nP -iTCP:9823 -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    pkill -f "gaffer-daemon" 2>/dev/null || true   # SEA binary fallback
    return 0
  fi
  echo "Stopping daemon (pids: $pids)"
  kill -TERM $pids 2>/dev/null || true
  # Wait for a graceful drain, past the 60s JSX cap the daemon honours.
  for i in $(seq 1 140); do
    lsof -nP -iTCP:9823 -sTCP:LISTEN -t >/dev/null 2>&1 || { echo "Daemon stopped."; return 0; }
    sleep 0.5
  done
  echo "Daemon did not exit in time, forcing."
  kill -KILL $(lsof -nP -iTCP:9823 -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true
}

# Never overwrite a development checkout, a dev install symlinks the panel
# out of a git repo; rsync --delete would clobber uncommitted work.
if [ -d "$PANEL_DIR/../.git" ] || [ -d "$PANEL_DIR/.git" ]; then
  echo "ERROR: panel dir is inside a git repo (dev install), refusing to update. Use git pull instead."
  echo "err:dev-install"
  exit 1
fi

# The temp dir goes away however the script exits.
trap 'cd /; rm -rf "$TMP_DIR"' EXIT

# Download the release asset and extract it into a SUBFOLDER of TMP_DIR, so
# the downloaded archive itself is never synced into the panel dir.
mkdir -p "$EXTRACT_DIR"
echo "Downloading $ASSET_SOURCE"
case "$ASSET_SOURCE" in
  http://*|https://*) curl -fsSL "$ASSET_SOURCE" -o "$TMP_DIR/$ASSET_NAME" ;;
  *) cp "$ASSET_SOURCE" "$TMP_DIR/$ASSET_NAME" ;;
esac
tar -xzf "$TMP_DIR/$ASSET_NAME" -C "$EXTRACT_DIR"
if [ ! -f "$EXTRACT_DIR/version.json" ] || [ ! -f "$EXTRACT_DIR/daemon/index.js" ]; then
  echo "ERROR: downloaded archive is not a Gaffer release (missing version.json or daemon/index.js)"
  exit 1
fi

# Version and commit come from the archive's own version.json, which the
# release workflow stamps. Nothing is read from raw.githubusercontent.com.
json_field() {
  grep -o "\"$1\": *\"[^\"]*\"" "$2" | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true
}
LATEST_VERSION="$(json_field version "$EXTRACT_DIR/version.json")"
LATEST_COMMIT="$(json_field commit "$EXTRACT_DIR/version.json")"
if [ -z "$LATEST_VERSION" ]; then
  echo "ERROR: release version.json has no version"
  exit 1
fi
echo "Release: v$LATEST_VERSION ($LATEST_COMMIT)"

# Backup chat history, legacy single file plus per-AE-version files
# (chat-history-<aeVersion>.json, e.g. chat-history-26.0.json)
BACKUP=""
if [ -f "$PANEL_DIR/chat-history.json" ]; then
  BACKUP="$TMP_DIR/chat-history.backup.json"
  cp "$PANEL_DIR/chat-history.json" "$BACKUP"
fi
HISTORY_BACKUP_DIR="$TMP_DIR/chat-history-backups"
mkdir -p "$HISTORY_BACKUP_DIR"
shopt -s nullglob
for f in "$PANEL_DIR"/chat-history-*.json; do
  cp "$f" "$HISTORY_BACKUP_DIR/"
done
shopt -u nullglob

# Backup .gaffer-config.json (claudeBin, installId, shareUsageStats, etc.):
# without this it's silently wiped by rsync --delete on every update.
CONFIG_BACKUP=""
if [ -f "$PANEL_DIR/.gaffer-config.json" ]; then
  CONFIG_BACKUP="$TMP_DIR/gaffer-config.backup.json"
  cp "$PANEL_DIR/.gaffer-config.json" "$CONFIG_BACKUP"
fi

# Stop existing daemon (panel will detect disconnect and continue)
echo "Stopping daemon..."
stop_daemon

# Sync new files into panel dir (overwrite, but preserve user data).
# version.json is excluded here and written LAST (below): the panel reloads
# and the daemon self-restarts the moment it changes. The usage-stats buffer
# and icon cache are not in the archive; excluding them also protects them
# from --delete. Stays non --inplace so this running script is never
# overwritten in place.
echo "Replacing files..."
rsync -a --delete \
  --exclude 'chat-history.json' \
  --exclude 'chat-history-*.json' \
  --exclude '.gaffer-config.json' \
  --exclude 'daemon/node_modules' \
  --exclude 'daemon/dist' \
  --exclude '/version.json' \
  --exclude '/.gaffer-usage-buffer.json' \
  --exclude '/.gaffer-icons' \
  "$EXTRACT_DIR/" "$PANEL_DIR/"

# Restore chat history
if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
  cp "$BACKUP" "$PANEL_DIR/chat-history.json"
fi
shopt -s nullglob
for f in "$HISTORY_BACKUP_DIR"/chat-history-*.json; do
  cp "$f" "$PANEL_DIR/"
done
shopt -u nullglob

# Restore .gaffer-config.json
if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
  cp "$CONFIG_BACKUP" "$PANEL_DIR/.gaffer-config.json"
fi

# npm install in daemon
echo "Installing daemon dependencies..."
cd "$DAEMON_DIR"
for n in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
  [ -x "$n" ] && NODE="$n" && break
done
[ -z "${NODE:-}" ] && NODE="$(which node 2>/dev/null)"
if [ -n "${NODE:-}" ]; then
  NPM_DIR="$(dirname "$NODE")"
  PATH="$NPM_DIR:$PATH" npm install --production
fi

# Stop any daemon that respawned from the half-copied tree during the update
# (the panel pauses auto-start now, but belt and braces), the panel reloads
# when version.json changes and boots a clean daemon.
stop_daemon

# LAST step: put the release's version.json in place with an atomic rename,
# so the panel and daemon only ever see the old file or the complete new one.
cp "$EXTRACT_DIR/version.json" "$PANEL_DIR/version.json.tmp"
mv -f "$PANEL_DIR/version.json.tmp" "$PANEL_DIR/version.json"

echo "=== Update complete: $(date) ==="
echo "ok:$LATEST_VERSION"
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bash -n panel/daemon/update.sh && echo "syntax OK"
bash scripts/test-update-sh.sh
```

Expected: `syntax OK`, then 15 `PASS:` lines (exit 0, release's `version.json`, user data preserved, six "no ... in the panel dir" lines, release files landed, `version.json` newest, `ok:9.9.9` in the log, temp dir cleaned, broken download exits non-zero, broken download left the install untouched) and `ALL PASS`. It takes about 15 seconds.

- [ ] **Step 5: Commit**

```bash
git add panel/daemon/update.sh scripts/test-update-sh.sh
git commit -m "feat(update): update.sh installs the latest release asset, version.json last" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Windows updater (`update.ps1`)

**Files:**
- Modify: `panel/daemon/update.ps1` (full rewrite of lines 1-138; keep the UTF-8 BOM)
- Test: `scripts/windows-tests/test-5-update-ps1.ps1` (ASCII-only, UTF-8 BOM)

**Interfaces:**
- Consumes: `bash scripts/package-release.sh` (Task 2), `panel/daemon/stop-daemon.ps1` (unchanged).
- Produces: `update.ps1` honoring `GAFFER_UPDATE_ASSET` (default `https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-update-win.zip`), last output line `ok:<version>`; the helper file `$S/gc.sh` used again in Tasks 11 and 12.

- [ ] **Step 1: Write the failing test**

Create `scripts/windows-tests/test-5-update-ps1.ps1` with a UTF-8 BOM. Write the content below, then prepend the BOM and check it:

```powershell
# test-5-update-ps1.ps1
# ======================================================================
# End-to-end test for panel\daemon\update.ps1 against a scratch install,
# the Windows twin of scripts/test-update-sh.sh. Run it on a Windows box
# (the gaffer-winvm test VM) under Windows PowerShell 5.1.
#
# Lays down a v0.10.8 install (from -OldInstallZip) under a path WITH A
# SPACE, seeds user data, runs the update.ps1 from -UpdateScriptDir inside
# that install with GAFFER_UPDATE_ASSET pointing at -ReleaseZip, and checks
# the result. A second case feeds it a broken download and checks that
# nothing in the install changed.
#
# update.ps1 stops whatever listens on port 9823, so this refuses to run
# while a Gaffer daemon is up (close After Effects first).
#
# Inputs, built on the Mac (see the implementation plan):
#   -UpdateScriptDir  folder with the NEW update.ps1 and stop-daemon.ps1
#   -OldInstallZip    git archive --format=zip -o old-install.zip ce16c2f:panel
#   -ReleaseZip       gaffer-update-win.zip from scripts/package-release.sh
#   -NodeDir          optional folder holding node.exe / npm.cmd to put on PATH
#
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\test-5-update-ps1.ps1 -UpdateScriptDir <dir> -OldInstallZip <zip> -ReleaseZip <zip> [-NodeDir <dir>]
param(
    [Parameter(Mandatory = $true)][string] $UpdateScriptDir,
    [Parameter(Mandatory = $true)][string] $OldInstallZip,
    [Parameter(Mandatory = $true)][string] $ReleaseZip,
    [string] $NodeDir = ""
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:fails = 0
function Pass([string] $m) { Write-Host "PASS: $m" }
function Fail([string] $m) { Write-Host "FAIL: $m"; $script:fails++ }

Write-Host "PowerShell $($PSVersionTable.PSVersion)"
if (Get-NetTCPConnection -LocalPort 9823 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "ABORT: something is listening on port 9823 (a running Gaffer daemon). Close After Effects first."
    exit 2
}
if (-not (Select-String -Path (Join-Path $UpdateScriptDir "update.ps1") -Pattern "GAFFER_UPDATE_ASSET" -Quiet)) {
    Write-Host "FAIL: update.ps1 does not honor GAFFER_UPDATE_ASSET (still the main-archive updater)"
    exit 1
}
if ($NodeDir) { $env:Path = "$NodeDir;$env:Path" }

$scratch = Join-Path $env:TEMP ("gaffer-update-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path "$scratch\tmp" -Force | Out-Null
$expected = Join-Path $scratch "expected"
Expand-Archive -Path $ReleaseZip -DestinationPath $expected -Force

function New-TestInstall([string] $dir) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Expand-Archive -Path $OldInstallZip -DestinationPath $dir -Force
    Copy-Item (Join-Path $UpdateScriptDir "update.ps1") (Join-Path $dir "daemon\update.ps1") -Force
    Copy-Item (Join-Path $UpdateScriptDir "stop-daemon.ps1") (Join-Path $dir "daemon\stop-daemon.ps1") -Force
    Set-Content -LiteralPath (Join-Path $dir "chat-history.json") -Value '{"messages":["legacy"]}'
    Set-Content -LiteralPath (Join-Path $dir "chat-history-26.0.json") -Value '{"messages":["ae26"]}'
    Set-Content -LiteralPath (Join-Path $dir ".gaffer-config.json") -Value '{"installId":"legacy"}'
    Set-Content -LiteralPath (Join-Path $dir ".gaffer-usage-buffer.json") -Value '[{"event":"unsent"}]'
    New-Item -ItemType Directory -Path (Join-Path $dir ".gaffer-icons") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $dir ".gaffer-icons\notion.svg") -Value '<svg id="cached"/>'
    Set-Content -LiteralPath (Join-Path $dir "stale-file-from-old-release.txt") -Value 'stale'
}

function Get-TreeHash([string] $dir) {
    $lines = Get-ChildItem -LiteralPath $dir -Recurse -File -Force |
        Where-Object { $_.FullName -notlike "*\node_modules\*" } |
        Sort-Object FullName |
        ForEach-Object { $_.FullName.Substring($dir.Length) + " " + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    return ($lines -join "`n")
}

function Invoke-Update([string] $dir, [string] $asset) {
    $env:GAFFER_UPDATE_ASSET = $asset
    $env:TEMP = "$scratch\tmp"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir "daemon\update.ps1") | Out-Null
    return $LASTEXITCODE
}

$realTemp = $env:TEMP
try {
    # ---------- Case 1: a good release asset ----------
    $install = Join-Path $scratch "Application Data\com.gaffer.panel"
    New-TestInstall $install
    $userFiles = @("chat-history.json", "chat-history-26.0.json", ".gaffer-config.json", ".gaffer-usage-buffer.json", ".gaffer-icons\notion.svg")
    $before = @{}
    foreach ($f in $userFiles) { $before[$f] = (Get-FileHash -LiteralPath (Join-Path $install $f)).Hash }

    $code = Invoke-Update $install $ReleaseZip
    if ($code -eq 0) { Pass "update.ps1 exited 0" } else { Fail "update.ps1 exited $code (log: $scratch\tmp\gaffer-update.log)" }

    $gotVersion = Get-Content -LiteralPath (Join-Path $install "version.json") -Raw
    $wantVersion = Get-Content -LiteralPath (Join-Path $expected "version.json") -Raw
    if ($gotVersion -eq $wantVersion) { Pass "version.json is the release's stamped file" } else { Fail "version.json is not the release's: $gotVersion" }

    foreach ($f in $userFiles) {
        $p = Join-Path $install $f
        if ((Test-Path -LiteralPath $p) -and ((Get-FileHash -LiteralPath $p).Hash -eq $before[$f])) { Pass "$f preserved" } else { Fail "$f lost or changed" }
    }

    foreach ($junk in @("gaffer.zip", "gaffer-update-win.zip", "extract", "version.json.tmp", "stale-file-from-old-release.txt")) {
        if (Test-Path -LiteralPath (Join-Path $install $junk)) { Fail "$junk left in the panel dir" } else { Pass "no $junk in the panel dir" }
    }

    $gotMain = (Get-FileHash -LiteralPath (Join-Path $install "main.js")).Hash
    $wantMain = (Get-FileHash -LiteralPath (Join-Path $expected "main.js")).Hash
    if ($gotMain -eq $wantMain) { Pass "release files landed (main.js matches the asset)" } else { Fail "main.js does not match the asset" }

    $vj = Get-Item -LiteralPath (Join-Path $install "version.json")
    $newer = Get-ChildItem -LiteralPath $install -Recurse -File -Force | Where-Object { $_.LastWriteTimeUtc -gt $vj.LastWriteTimeUtc }
    if (-not $newer) { Pass "version.json is the newest file in the panel dir (written last)" } else { Fail "files written after version.json: $(($newer | Select-Object -First 5 | ForEach-Object { $_.FullName }) -join ', ')" }

    $log = Get-Content -LiteralPath "$scratch\tmp\gaffer-update.log" -Raw
    $wantOk = "ok:" + ((Get-Content -LiteralPath (Join-Path $expected "version.json") -Raw | ConvertFrom-Json).version)
    if ($log -match [regex]::Escape($wantOk)) { Pass "log contains $wantOk" } else { Fail "no $wantOk in the log" }
    if (Get-ChildItem -LiteralPath "$scratch\tmp" -Directory -Filter "gaffer-update-*" -ErrorAction SilentlyContinue) { Fail "temp dir not cleaned up" } else { Pass "temp dir cleaned up" }

    # ---------- Case 2: a broken download changes nothing ----------
    $broken = Join-Path $scratch "Application Data\broken\com.gaffer.panel"
    New-TestInstall $broken
    $notZip = Join-Path $scratch "not-a-release.zip"
    Set-Content -LiteralPath $notZip -Value '<html>Not Found</html>'
    $beforeTree = Get-TreeHash $broken
    $code = Invoke-Update $broken $notZip
    if ($code -ne 0) { Pass "update.ps1 exited non-zero on a broken download" } else { Fail "update.ps1 exited 0 on a broken download" }
    if ((Get-TreeHash $broken) -eq $beforeTree) { Pass "broken download left the install untouched" } else { Fail "broken download modified the install" }
} finally {
    $env:TEMP = $realTemp
    Remove-Item Env:\GAFFER_UPDATE_ASSET -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:fails -eq 0) { Write-Host "ALL PASS"; exit 0 } else { Write-Host "$($script:fails) FAILURE(S)"; exit 1 }
```

```bash
f=scripts/windows-tests/test-5-update-ps1.ps1
[ "$(head -c 3 "$f" | xxd -p)" = "efbbbf" ] || { printf '\xef\xbb\xbf' | cat - "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
head -c 3 "$f" | xxd -p
git add "$f" && node scripts/check-ps-encoding.mjs
```

Expected: `efbbbf`, and every line of the lint starts with `PASS`, including `PASS  scripts/windows-tests/test-5-update-ps1.ps1`.

- [ ] **Step 2: Run test to verify it fails**

The test's first assertion is the `GAFFER_UPDATE_ASSET` guard. Check it locally (a full VM run comes in Step 4):

```bash
grep -c 'GAFFER_UPDATE_ASSET' panel/daemon/update.ps1 || true
```

Expected: `0`, so the test would stop with `FAIL: update.ps1 does not honor GAFFER_UPDATE_ASSET (still the main-archive updater)`.

- [ ] **Step 3: Write minimal implementation**

Replace the whole of `panel/daemon/update.ps1` with the content below, keeping it ASCII-only, then restore the BOM if your editor dropped it:

```powershell
# Gaffer update script (Windows): downloads the latest GitHub release asset,
# replaces panel files, preserves user data, restarts daemon.
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only with a UTF-8
# BOM (node scripts/check-ps-encoding.mjs).
$ErrorActionPreference = "Stop"
# PS 5.1 redraws a progress bar per downloaded chunk, which makes
# Invoke-WebRequest many times slower. Nothing here reads it.
$ProgressPreference = "SilentlyContinue"

$panelDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$daemonDir = "$panelDir\daemon"
$tmpDir = Join-Path $env:TEMP "gaffer-update-$PID"
$extractDir = Join-Path $tmpDir "extract"
$assetName = "gaffer-update-win.zip"
# GAFFER_UPDATE_ASSET overrides the download source with another URL or a
# local file path. Only scripts\windows-tests\test-5-update-ps1.ps1 and
# pre-release checks set it.
$assetSource = "https://github.com/spendolas/gaffer-ae/releases/latest/download/$assetName"
if ($env:GAFFER_UPDATE_ASSET) { $assetSource = $env:GAFFER_UPDATE_ASSET }
$logPath = Join-Path $env:TEMP "gaffer-update.log"

Start-Transcript -Path $logPath -Append
Write-Host "=== Update started: $(Get-Date) ==="

# Stop-Daemon lives in its own file (dot-sourced) so it stays plain-function-only
# and can be unit-tested in isolation - see scripts/windows-tests/test-4-stop-daemon-stray-pid.ps1
. "$PSScriptRoot\stop-daemon.ps1"

# Never overwrite a development checkout - a dev install points the panel
# at a git repo; /PURGE would clobber uncommitted work.
if ((Test-Path (Join-Path (Split-Path -Parent $panelDir) ".git")) -or (Test-Path "$panelDir\.git")) {
    Write-Error "panel dir is inside a git repo (dev install) - refusing to update. Use git pull instead."
    Write-Output "err:dev-install"
    Stop-Transcript
    exit 1
}

# Every failure after this point goes through here: log, clean up, exit 1.
# The panel dir is untouched until the robocopy step, and version.json is
# only replaced at the very end.
function Exit-Update([string] $message) {
    Write-Host "ERROR: $message"
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
    Stop-Transcript
    exit 1
}

# Download the release asset and extract it into a SUBFOLDER of tmpDir, so
# the downloaded zip itself is never copied into the panel dir.
New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
$zipPath = Join-Path $tmpDir $assetName
Write-Host "Downloading $assetSource"
try {
    if (Test-Path -LiteralPath $assetSource -PathType Leaf) {
        Copy-Item -LiteralPath $assetSource -Destination $zipPath
    } else {
        Invoke-WebRequest -Uri $assetSource -OutFile $zipPath -UseBasicParsing
    }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
} catch {
    Exit-Update "download or extract failed: $($_.Exception.Message)"
}
if (-not (Test-Path "$extractDir\version.json") -or -not (Test-Path "$extractDir\daemon\index.js")) {
    Exit-Update "downloaded archive is not a Gaffer release (missing version.json or daemon\index.js)"
}

# Version and commit come from the archive's own version.json, which the
# release workflow stamps. Nothing is read from raw.githubusercontent.com.
try {
    $release = Get-Content "$extractDir\version.json" -Raw | ConvertFrom-Json
} catch {
    Exit-Update "release version.json is not valid JSON"
}
$latestVersion = $release.version
$latestCommit = $release.commit
if (-not $latestVersion) { Exit-Update "release version.json has no version" }
Write-Host "Release: v$latestVersion ($latestCommit)"

# Backup chat history - legacy single file plus per-AE-version files
# (chat-history-<aeVersion>.json, e.g. chat-history-26.0.json)
$backup = $null
if (Test-Path "$panelDir\chat-history.json") {
    $backup = Join-Path $tmpDir "chat-history.backup.json"
    Copy-Item "$panelDir\chat-history.json" $backup
}
$historyBackupDir = Join-Path $tmpDir "chat-history-backups"
New-Item -ItemType Directory -Path $historyBackupDir -Force | Out-Null
Get-ChildItem -Path $panelDir -Filter "chat-history-*.json" -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item $_.FullName $historyBackupDir }

# Backup .gaffer-config.json (claudeBin, installId, shareUsageStats, etc.) -
# without this it is silently wiped by robocopy /PURGE on every update.
$configBackup = $null
if (Test-Path "$panelDir\.gaffer-config.json") {
    $configBackup = Join-Path $tmpDir "gaffer-config.backup.json"
    Copy-Item "$panelDir\.gaffer-config.json" $configBackup
}

# Stop daemon
Write-Host "Stopping daemon..."
Stop-Daemon

# Replace files (preserve user data). version.json is excluded here and
# written LAST (below): the panel reloads and the daemon self-restarts the
# moment it changes. The usage-stats buffer and the icon cache are not in the
# archive; excluding them also protects them from /PURGE.
Write-Host "Replacing files..."
robocopy $extractDir $panelDir /E /PURGE `
    /XF chat-history.json chat-history-*.json .gaffer-config.json version.json .gaffer-usage-buffer.json `
    /XD node_modules dist .gaffer-icons | Out-Null
# robocopy exit codes 0-7 are success variants; 8 and up mean a copy failed.
if ($LASTEXITCODE -ge 8) { Exit-Update "robocopy failed (exit $LASTEXITCODE)" }

# Restore chat history
if ($backup -and (Test-Path $backup)) {
    Copy-Item $backup "$panelDir\chat-history.json" -Force
}
Get-ChildItem -Path $historyBackupDir -Filter "chat-history-*.json" -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item $_.FullName "$panelDir\" -Force }

# Restore .gaffer-config.json
if ($configBackup -and (Test-Path $configBackup)) {
    Copy-Item $configBackup "$panelDir\.gaffer-config.json" -Force
}

# npm install - CEP spawns this script with a STRIPPED PATH, so bare `npm`
# doesn't resolve when launched from the panel's Update button (manual
# terminal runs never hit this - which is why they always worked).
Write-Host "Installing daemon dependencies..."
$nodeDirs = @(
    "$env:ProgramFiles\nodejs",
    "${env:ProgramFiles(x86)}\nodejs",
    "$env:APPDATA\npm",
    "$env:LOCALAPPDATA\Programs\nodejs",
    "$env:NVM_SYMLINK"
) | Where-Object { $_ -and (Test-Path $_) }
foreach ($d in $nodeDirs) { $env:Path = "$d;$env:Path" }
$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCmd) { $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source }
if (-not $npmCmd) {
    Exit-Update "npm not found in known Node.js locations or PATH - run this script from a terminal once"
}
Write-Host "  npm: $npmCmd"
Push-Location $daemonDir
try { & $npmCmd install --production } catch {}
$npmExit = $LASTEXITCODE
Pop-Location
if ($npmExit -ne 0) {
    Exit-Update "npm install failed (exit $npmExit)"
}

# Stop any daemon that respawned mid-update (panel reloads on version.json
# change and boots a clean one)
Stop-Daemon

# LAST step: put the release's version.json in place with a rename, so the
# panel and daemon only ever see the old file or the complete new one.
# Copy-Item keeps the archive's timestamp, so stamp it as written now.
$versionTmp = "$panelDir\version.json.tmp"
Copy-Item "$extractDir\version.json" $versionTmp -Force
(Get-Item -LiteralPath $versionTmp).LastWriteTime = Get-Date
Move-Item -LiteralPath $versionTmp -Destination "$panelDir\version.json" -Force

# Cleanup
Remove-Item -Recurse -Force $tmpDir

Write-Host "=== Update complete: $(Get-Date) ==="
Write-Output "ok:$latestVersion"
Stop-Transcript
```

```bash
f=panel/daemon/update.ps1
[ "$(head -c 3 "$f" | xxd -p)" = "efbbbf" ] || { printf '\xef\xbb\xbf' | cat - "$f" > "$f.tmp" && mv "$f.tmp" "$f"; }
node scripts/check-ps-encoding.mjs
```

Expected: every line `PASS`, including `PASS  panel/daemon/update.ps1`.

- [ ] **Step 4: Run test to verify it passes (MANUAL, Windows VM `gaffer-winvm`)**

Build the inputs on the Mac:

```bash
S="${TMPDIR:-/tmp}/gaffer-rel"; rm -rf "$S/vm" "$S/vmdist"; mkdir -p "$S/vm"
# The asset is built from the COMMITTED tree (Tasks 6 to 8 are committed by now).
bash scripts/package-release.sh 9.9.9 feedfacecafe "$S/vmdist"
git archive --format=zip -o "$S/vm/old-install.zip" ce16c2f:panel
cp "$S/vmdist/gaffer-update-win.zip" panel/daemon/update.ps1 panel/daemon/stop-daemon.ps1 scripts/windows-tests/test-5-update-ps1.ps1 "$S/vm/"
ls "$S/vm"
```

Expected: `gaffer-update-win.zip  old-install.zip  stop-daemon.ps1  test-5-update-ps1.ps1  update.ps1`.

Create the guest-control helper. This is the ONLY place the VM password appears. `<VM password>` is a secret, not a TODO: replace it in this local file with the `gaffer` account password from the existing Windows VM test setup notes, and never commit or paste it anywhere else.

```bash
S="${TMPDIR:-/tmp}/gaffer-rel"
cat > "$S/gc.sh" <<'EOF'
gc() { VBoxManage guestcontrol gaffer-winvm --username gaffer --password '<VM password>' "$@"; }
EOF
chmod 600 "$S/gc.sh"
```

Make sure the VM is running and After Effects is NOT running inside it (the test refuses while port 9823 is in use):

```bash
VBoxManage list runningvms | grep gaffer-winvm || VBoxManage startvm gaffer-winvm --type gui
```

(After a cold boot, guest control can take a minute, and on a fresh boot sometimes needs one guest reboot before it answers.)

Copy and run:

```bash
S="${TMPDIR:-/tmp}/gaffer-rel"; source "$S/gc.sh"
gc mkdir --parents 'C:\Users\gaffer\gaffer-rel'
gc copyto --target-directory 'C:\Users\gaffer\gaffer-rel' "$S/vm/update.ps1" "$S/vm/stop-daemon.ps1" "$S/vm/test-5-update-ps1.ps1" "$S/vm/gaffer-update-win.zip" "$S/vm/old-install.zip"
gc run --timeout 900000 --exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -- powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\gaffer\gaffer-rel\test-5-update-ps1.ps1' -UpdateScriptDir 'C:\Users\gaffer\gaffer-rel' -OldInstallZip 'C:\Users\gaffer\gaffer-rel\old-install.zip' -ReleaseZip 'C:\Users\gaffer\gaffer-rel\gaffer-update-win.zip' -NodeDir 'C:\Users\gaffer\node-v24.19.0-win-x64'
echo "exit=$?"
```

Expected: first line `PowerShell 5.1.<build>`; then `PASS:` lines for: exit 0, release's `version.json`, the five user files preserved, five "no ... in the panel dir" lines, release files landed, `version.json` newest, `ok:9.9.9` in the log, temp dir cleaned, broken download exits non-zero, broken download left the install untouched; then `ALL PASS` and `exit=0`. The npm install inside the test needs the VM's internet access (about a minute).

If it prints `ABORT: something is listening on port 9823`, close After Effects in the VM and run it again. If a `FAIL:` line appears, read `%TEMP%\gaffer-update-test-*\tmp\gaffer-update.log` before the test's cleanup by re-running with the `finally` cleanup line commented out locally (do not commit that change).

- [ ] **Step 5: Commit**

```bash
git add panel/daemon/update.ps1 scripts/windows-tests/test-5-update-ps1.ps1
node scripts/check-ps-encoding.mjs
git commit -m "feat(update): update.ps1 installs the latest release asset, version.json last" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs and the v0.11.0 changelog entry

**Files:**
- Modify: `README.md:63-77` (install step 3), `README.md:166-171` ("Updating" section)
- Modify: `CLAUDE.md:44`, `CLAUDE.md:47`, `CLAUDE.md:49`, `CLAUDE.md:56`, `CLAUDE.md:61`, `CLAUDE.md:90`, `CLAUDE.md:94`
- Modify: `CHANGELOG.md:2` (new entry above `## v0.10.8`)
- Test: `scripts/release-docs.test.mjs`

**Interfaces:**
- Consumes: `extractNotes` and `decide` from `scripts/release-gate.mjs` (Task 1).
- Produces: a `## v0.11.0` CHANGELOG heading the gate accepts (required before Push A).

- [ ] **Step 1: Write the failing test**

Create `scripts/release-docs.test.mjs`:

```javascript
// Run from the repo root: node --test scripts/release-docs.test.mjs
// Pins the user-facing install/update docs and the v0.11.0 changelog entry
// to the GitHub Releases flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractNotes, decide } from './release-gate.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const readme = read('../README.md');
const changelog = read('../CHANGELOG.md');
const claudeMd = read('../CLAUDE.md');
const DASHES = /[\u2013\u2014]/;

function section(text, startRe, endRe) {
  const start = text.search(startRe);
  assert.ok(start !== -1, 'section not found: ' + startRe);
  const rest = text.slice(start);
  const end = rest.slice(1).search(endRe);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

test('README install step 3 downloads the latest release assets', () => {
  const step3 = section(readme, /^3\. \*\*Download and extract\*\*/m, /^4\. /m);
  assert.ok(step3.includes('https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-mac.tar.gz'));
  assert.ok(step3.includes('https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-win.zip'));
  assert.ok(!step3.includes('archive/refs/heads/main'));
  assert.ok(!step3.includes('gaffer-ae-main'));
  assert.ok(!step3.includes('--strip-components'));
  assert.ok(!DASHES.test(step3), 'no em or en dashes in install step 3');
});

test('README Updating section describes releases and the proxy hosts', () => {
  const updating = section(readme, /^## Updating/m, /^---$/m);
  assert.ok(updating.includes('api.github.com'));
  assert.ok(updating.includes('release-assets.githubusercontent.com'));
  assert.ok(updating.includes('gaffer-update-mac.tar.gz'));
  assert.ok(updating.includes('gaffer-update-win.zip'));
  assert.ok(!DASHES.test(updating), 'no em or en dashes in the Updating section');
});

test('CHANGELOG has a v0.11.0 entry the release gate accepts', () => {
  const notes = extractNotes(changelog, '0.11.0');
  assert.ok(notes, 'no "## v0.11.0" heading');
  assert.match(notes, /^\*\*.+\*\*\n/, 'entry starts with a bold one-line summary');
  assert.ok(notes.includes('older than v0.10.8'), 'entry carries the one-time old-script caveat');
  assert.ok(!DASHES.test(notes), 'no em or en dashes in the v0.11.0 entry');
  const r = decide({ version: '0.11.0', tags: [], release: null, changelog });
  assert.equal(r.action, 'create');
});

test('CLAUDE.md Releasing describes the workflow, not hand-stamped commits', () => {
  const releasing = section(claudeMd, /^## Releasing/m, /^## /m);
  assert.ok(releasing.includes('.github/workflows/release.yml'));
  assert.ok(releasing.includes('scripts/release-gate.mjs'));
  assert.ok(!releasing.includes('(version + commit)'));
  const layout = section(claudeMd, /^## Repo Layout/m, /^## /m);
  assert.ok(layout.includes('release-gate.mjs'), 'repo layout lists the gate');
  assert.ok(layout.includes('release.yml'), 'repo layout lists the release workflow');
  assert.ok(layout.includes('update-state.js'), 'repo layout lists update-state.js');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/release-docs.test.mjs`
Expected: `# tests 4`, `# pass 0`, `# fail 4`.

- [ ] **Step 3: Write minimal implementation**

`README.md`: replace lines 63-77 (from `3. **Download and extract** directly into the CEP extensions directory (no repo clone needed):` through the closing code fence before `4. **Install daemon dependencies:**`) with:

````markdown
3. **Download and extract** the latest release directly into the CEP extensions directory (no repo clone needed):
   ```bash
   # macOS
   INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
   mkdir -p "$INSTALL_DIR"
   curl -fsSL https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-mac.tar.gz | tar -xz -C "$INSTALL_DIR"

   # Windows (PowerShell)
   $installDir = "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel"
   New-Item -ItemType Directory -Path $installDir -Force | Out-Null
   Remove-Item -Recurse -Force "$env:TEMP\gaffer-extract" -ErrorAction SilentlyContinue
   Invoke-WebRequest -Uri "https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-win.zip" -OutFile "$env:TEMP\gaffer-install.zip" -UseBasicParsing
   Expand-Archive -Path "$env:TEMP\gaffer-install.zip" -DestinationPath "$env:TEMP\gaffer-extract" -Force
   Copy-Item -Recurse -Force "$env:TEMP\gaffer-extract\*" $installDir
   Remove-Item -Recurse -Force "$env:TEMP\gaffer-install.zip", "$env:TEMP\gaffer-extract"
   ```
````

`README.md`: replace lines 166-171 (from `## Updating (instructions for Claude)` through the bullet starting `- Never update a dev install`) with:

````markdown
## Updating (instructions for Claude)

- **v0.11.0 or newer:** the panel checks the latest GitHub release (`https://api.github.com/repos/spendolas/gaffer-ae/releases/latest`) and shows an update banner when it is newer than the installed version. The user clicks Update and the bundled `panel/daemon/update.sh` (macOS) / `update.ps1` (Windows) downloads the release asset (`gaffer-update-mac.tar.gz` / `gaffer-update-win.zip`), stops the daemon, replaces files, keeps chat history, settings, unsent usage statistics and the icon cache, reinstalls deps, and writes `version.json` last so the panel reloads only once everything is in place.
- **v0.2.0 to v0.10.8:** the panel checks `panel/version.json` on `main` and shows the same banner. That one update to v0.11.0 still runs the older update script; every update after it comes from releases as described above.
- **v0.1.0 (no banner, no updater):** re-run the installer from a fresh checkout: download or clone this repo, then run `scripts/install-mac.sh` or `scripts/install-win.ps1`. The installer stops any running daemon, preserves the user's chat history, and installs daemon dependencies into the deployed extension. Ask the user to restart After Effects afterwards.
- If an update fails, the panel says so and the updater log has details: `/tmp/gaffer-update.log` (macOS) / `%TEMP%\gaffer-update.log` (Windows). The update script can also be run manually from the extension's `daemon/` folder.
- Never update a dev install (extension dir symlinked to a git checkout) with these scripts. Use `git pull`.
- **Networks behind a proxy or firewall:** besides `github.com`, allow `api.github.com` (update check) and `release-assets.githubusercontent.com` (downloads), or the update check and the install and update downloads fail.
````

`CHANGELOG.md`: insert this block after line 2 (the blank line under `# Changelog`), so it sits above `## v0.10.8 - 2026-10-06`. Use the date of the day you push; the gate only matches the `## v0.11.0 ` prefix.

```markdown
## v0.11.0 - 2026-10-07

**Auto-update works again, and installs and updates now come from tagged GitHub Releases.**

- Since v0.10.2 the update check compared a build stamp that never changed, so every panel on v0.10.2 or newer said "up to date" no matter what was released. The panel now asks GitHub for the latest release and compares version numbers, so new versions show up again.
- Installs and updates now download a finished release package instead of whatever happened to be on the main branch at that moment.
- Updates now also keep your unsent usage statistics and the cached MCP server icons, and the panel only reloads once every file is in place.
- If your network only allows certain sites, it now also needs to reach `api.github.com` and `release-assets.githubusercontent.com`, in addition to `github.com`.
- One catch: this one update still runs the update script from the version you already have. On versions older than v0.10.8 that can lose per-window chat history once, and the panel may reload before the update has finished. If it looks stuck, wait a minute and reopen the panel. Updates after this one are safe.
```

`CLAUDE.md` (line numbers for the unmodified file; apply bottom-up):

- Replace line 94 (the bullet starting `- Bump \`panel/version.json\` (version + commit)`) with these four bullets:

```markdown
- A release is: bump `version` in `panel/version.json`, add a `CHANGELOG.md` section headed `## v<version> - <date>` (bold one-line summary, then plain-language bullets), push to `main`. `.github/workflows/release.yml` runs `scripts/release-gate.mjs` (skip, create or recover), the tests and `scripts/package-release.sh`, then publishes release `v<version>` with four assets: `gaffer-install-mac.tar.gz`, `gaffer-install-win.zip`, `gaffer-update-mac.tar.gz`, `gaffer-update-win.zip`. A push that does not change `version` publishes nothing. A version with a `-` suffix (`0.12.0-beta.1`) becomes a prerelease, which the panel never offers.
- Dry run: `gh workflow run release.yml -f dry_run=true`, then `gh run download <run-id> -n gaffer-release`. Retry a failed publish with `gh workflow run release.yml -f dry_run=false` on `main`.
- The panel checks `releases/latest` on api.github.com and `update.sh` / `update.ps1` download the matching `gaffer-update-*` asset. The `commit` field in `main`'s `panel/version.json` is legacy, kept only for pre-0.11 clients that still read `main`, and is not maintained by hand any more. Until those clients are gone, keep `panel/version.json` at that path with exactly the keys `version` and `commit`, and keep the `main` archive layout `gaffer-ae-main/panel/` unchanged.
- Download counts: the weekly traffic snapshot adds `releases`, `installs` and `updates` to `docs/traffic-snapshots.jsonl`. Only week-over-week changes mean anything.
```

- Replace line 90 (the line starting `Tests/linters:`) with:

```markdown
Tests/linters: `node scripts/check-ps-encoding.mjs` (every .ps1 must be ASCII-only + UTF-8 BOM; run before any release touching PowerShell). Release tooling: `node --test scripts/release-gate.test.mjs scripts/package-release.test.mjs scripts/traffic-snapshot.test.mjs scripts/release-docs.test.mjs`. Updater end-to-end: `bash scripts/test-update-sh.sh` (close the Gaffer panel first). `scripts/windows-tests/` holds a field-contributed Windows repro harness (encoding, console-flash, detached-spawn) plus `test-5-update-ps1.ps1` (updater end-to-end); runs on a Windows machine only.
```

- After line 61 (`│   ├── build.sh ...`) insert:

```
│   ├── release-gate.mjs       # Release gate for .github/workflows/release.yml (skip/create/recover + notes)
│   ├── package-release.sh     # Builds the four release assets from panel/
```

- Replace line 56 (`│   │   ├── update.sh, update.ps1  # One-click update from GitHub tarball`) with:

```
│   │   ├── update.sh, update.ps1  # One-click update from the latest GitHub release asset
```

- Replace line 49 (`│   ├── version.json ...`) with:

```
│   ├── version.json           # {version, commit}: release version; packaged copies carry the full release SHA
```

- After line 47 (`│   ├── index.html, main.js ...`) insert:

```
│   ├── update-state.js        # Pure update-check logic (GitHub Releases), tested from daemon/test
```

- After line 44 (`gaffer/`) insert:

```
├── .github/workflows/        # release.yml (gate, build, publish releases), traffic-snapshot.yml, windows-tests.yml
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test scripts/release-docs.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)'
LC_ALL=C grep -n $'\xe2\x80[\x93\x94]' CHANGELOG.md | head -3
```

Expected: `# tests 4`, `# pass 4`, `# fail 0`. The grep shows only lines from OLDER changelog entries (line numbers greater than the end of the new v0.11.0 entry), none inside it.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md CHANGELOG.md scripts/release-docs.test.mjs
git commit -m "docs: install and update from GitHub Releases, v0.11.0 changelog" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Push A, release v0.11.0 and verify it

**Files:**
- Modify: `panel/version.json:2` (`"version"` only)

**Interfaces:**
- Consumes: everything above.
- Produces: GitHub release `v0.11.0` with four assets; `main` at version 0.11.0 with `"commit": "401c1ec"` still in place.

- [ ] **Step 1: Pre-push checks (the "failing test" is any red line here)**

```bash
(cd panel/daemon && node --test 2>&1 | grep -E '^# (tests|pass|fail)')
node --test scripts/release-gate.test.mjs scripts/package-release.test.mjs scripts/traffic-snapshot.test.mjs scripts/release-docs.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)'
node scripts/check-ps-encoding.mjs
bash scripts/test-update-sh.sh | tail -1
```

Expected: `# tests 187 / # pass 187 / # fail 0`; `# tests 32 / # pass 32 / # fail 0`; every lint line `PASS`; `ALL PASS`.

- [ ] **Step 2: Bump the version**

In `panel/version.json`, change only `"version": "0.10.8"` to `"version": "0.11.0"`. Leave `"commit": "401c1ec"` untouched.

```bash
git diff panel/version.json
S="${TMPDIR:-/tmp}/gaffer-rel"; mkdir -p "$S"; echo null > "$S/release.json"; git tag -l 'v*' > "$S/tags.txt"
node scripts/release-gate.mjs --version 0.11.0 --tags-file "$S/tags.txt" --release-file "$S/release.json" --changelog CHANGELOG.md --notes-out "$S/notes.md"
```

Expected diff, exactly:

```
-  "version": "0.10.8",
+  "version": "0.11.0",
```

and `release-gate: v0.11.0 -> create`.

```bash
git add panel/version.json
git commit -m "release: v0.11.0 - installs and updates come from GitHub Releases" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Local unstick-hop simulation (spec Testing 3, no fork)**

Runs the real v0.10.8 `update.sh` against a local server that plays `main` after Push B: `raw/version.json` = version 0.11.0 with a fresh commit, `main.tar.gz` = `git archive --prefix=gaffer-ae-main/ HEAD` (the same layout GitHub serves). The old script stops whatever listens on 9823, so the Gaffer panel must be closed.

```bash
lsof -nP -iTCP:9823 -sTCP:LISTEN -t >/dev/null 2>&1 && echo "ABORT: a Gaffer daemon is running, close the panel first"
HOP="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-hop-XXXXXX")"
mkdir -p "$HOP/srv/raw" "$HOP/tmp" "$HOP/Application Support/com.gaffer.panel"
printf '{\n  "version": "0.11.0",\n  "commit": "b0b0b0b"\n}\n' > "$HOP/srv/raw/version.json"
git archive --format=tar.gz --prefix=gaffer-ae-main/ -o "$HOP/srv/main.tar.gz" HEAD
INSTALL="$HOP/Application Support/com.gaffer.panel"
git archive ce16c2f:panel | tar -x -C "$INSTALL"
cp -R panel/daemon/node_modules "$INSTALL/daemon/node_modules"
echo '{"messages":["ae26"]}' > "$INSTALL/chat-history-26.0.json"
sed -i '' \
  -e 's#https://raw.githubusercontent.com/$REPO/main/panel/version.json#http://127.0.0.1:8765/raw/version.json#' \
  -e 's#https://github.com/$REPO/archive/refs/heads/main.tar.gz#http://127.0.0.1:8765/main.tar.gz#' \
  "$INSTALL/daemon/update.sh"
grep -c '127.0.0.1:8765' "$INSTALL/daemon/update.sh"
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$HOP/srv" > "$HOP/http.log" 2>&1 &
SRV=$!; sleep 1
TMPDIR="$HOP/tmp" npm_config_audit=false npm_config_fund=false bash "$INSTALL/daemon/update.sh"; echo "exit=$?"
kill "$SRV"
cat "$INSTALL/version.json"
tail -1 "$HOP/tmp/gaffer-update.log"
ls "$INSTALL/update-state.js"
grep -c 'GAFFER_UPDATE_ASSET' "$INSTALL/daemon/update.sh"
cat "$INSTALL/chat-history-26.0.json"
rm -rf "$HOP"
```

Expected: no ABORT line; `2` (both URLs patched); `exit=0`; `version.json` = `{"version": "0.11.0", "commit": "b0b0b0b"}` (pretty-printed); `ok:b0b0b0b`; `update-state.js` exists; `2` (the new `update.sh` landed); `{"messages":["ae26"]}`. If port 8765 is taken, use another port in all three places. Fallback only if this cannot run: a fork whose `main` has this tree with a fresh `commit`, and the old `update.sh` with `REPO` pointed at it.

- [ ] **Step 4: MANUAL, push A (owner's go-ahead required)**

```bash
git fetch origin
git status -sb | head -1
git log origin/main..HEAD --oneline
git diff origin/main --name-only
git diff origin/main -- panel/version.json
```

Expected: ahead by 6 commits (Tasks 6, 7, 8, 9, 10 and the release commit); names, exactly:

```
CHANGELOG.md
CLAUDE.md
README.md
design/scripts/panel-capture.mjs
panel/daemon/test/update-state.test.mjs
panel/daemon/test/update-wiring.test.mjs
panel/daemon/update.ps1
panel/daemon/update.sh
panel/index.html
panel/main.js
panel/update-state.js
panel/version.json
scripts/release-docs.test.mjs
scripts/test-update-sh.sh
scripts/windows-tests/test-5-update-ps1.ps1
```

and the `version.json` diff shows only the `version` line (`"commit": "401c1ec"` unchanged). If behind, `git pull --rebase origin main` first. Then:

```bash
git push origin main
```

- [ ] **Step 5: Verify the published release**

```bash
sleep 15
RUN_ID="$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
gh release view v0.11.0 --json tagName,isDraft,isPrerelease,targetCommitish,assets --jq '{tagName, isDraft, isPrerelease, targetCommitish, assets: [.assets[].name]}'
git rev-parse origin/main
curl -s https://api.github.com/repos/spendolas/gaffer-ae/releases/latest | jq -r '.tag_name, .assets[].name'
curl -sIL https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-update-mac.tar.gz | grep -iE '^(HTTP|location)'
S="${TMPDIR:-/tmp}/gaffer-rel"; rm -rf "$S/real"; mkdir -p "$S/real"
gh release download v0.11.0 -D "$S/real"
tar -xzOf "$S/real/gaffer-update-mac.tar.gz" ./version.json
gh run list --workflow windows-tests.yml --limit 1
```

Expected: run succeeds, `build success` and `publish success`; release `isDraft:false`, `isPrerelease:false`, `targetCommitish` = `git rev-parse origin/main`, four assets; the API answers `v0.11.0` plus the four names; the redirect chain ends in `HTTP/2 200`; the asset's `version.json` = `0.11.0` + the full Push A SHA; the Windows checks run for this push is green.

- [ ] **Step 6: MANUAL, recover path (spec Workflow tests)**

Do this right away, before announcing the release (the asset's download count restarts at zero):

```bash
gh release delete-asset v0.11.0 gaffer-update-win.zip -y
gh workflow run release.yml -f dry_run=false
sleep 10; RUN_ID="$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep 'release-gate:'
gh release view v0.11.0 --json assets --jq '[.assets[].name] | sort'
```

Expected: `release-gate: v0.11.0 -> recover` (twice: build and publish jobs); the four asset names again.

- [ ] **Step 7: MANUAL, macOS fresh install from the real asset and in-panel checks (spec Testing 1, 2 and 4)**

The owner's CEP extensions folder holds a dev symlink to this repo. With the owner's OK: quit After Effects, stop the running daemon, and move the symlink OUT of the extensions folder (a renamed copy inside it would register a second extension with the same ID):

```bash
EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"
kill $(lsof -nP -iTCP:9823 -sTCP:LISTEN -t) 2>/dev/null || true     # owner OK required
mv "$EXT/com.gaffer.panel" "$HOME/gaffer-panel-devlink.bak"
INSTALL_DIR="$EXT/com.gaffer.panel"
mkdir -p "$INSTALL_DIR"
curl -fsSL https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-mac.tar.gz | tar -xz -C "$INSTALL_DIR"
(cd "$INSTALL_DIR/daemon" && npm install --production)
cat "$INSTALL_DIR/version.json"
```

Expected: `version.json` = `0.11.0` + the full Push A SHA. Open After Effects, then Window > Extensions > Gaffer. Expected: the panel loads, `lsof -nP -iTCP:9823 -sTCP:LISTEN` shows the daemon, and Settings shows `v0.11.0 (<first 7 of the SHA>)`. Settings > Check now shows `Gaffer is up to date (v0.11.0)`.

Now make the installed panel look older so the update path runs for real, and seed user data:

```bash
INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
sed -i '' 's/"version": "0.11.0"/"version": "0.10.9"/' "$INSTALL_DIR/version.json"
echo '{"messages":["probe"]}' > "$INSTALL_DIR/chat-history-probe.json"
[ -f "$INSTALL_DIR/.gaffer-usage-buffer.json" ] || echo '[]' > "$INSTALL_DIR/.gaffer-usage-buffer.json"
mkdir -p "$INSTALL_DIR/.gaffer-icons" && echo '<svg id="probe"/>' > "$INSTALL_DIR/.gaffer-icons/probe.svg"
(cd "$INSTALL_DIR" && shasum chat-history-probe.json .gaffer-usage-buffer.json .gaffer-icons/probe.svg) > "${TMPDIR:-/tmp}/gaffer-rel/mac-user.sha"
```

Close and reopen the panel (Window > Extensions > Gaffer). Expected: the banner `Update available, v0.11.0` appears; Dismiss hides it; close and reopen the panel: the banner stays hidden, but Settings still shows the **Update** button.

Run the CDP probe (ETag, If-None-Match + 304, forced 403). Create `$S/update-probe.mjs` with this content:

```javascript
// Drives the update check of a RUNNING, NON-DEV Gaffer panel over CDP
// (port 13870 from panel/.debug) and checks: ETag cache, If-None-Match + 304,
// and a forced 403 that must show the neutral modal and not record a check.
// Usage: node update-probe.mjs <path-to-repo>/panel/daemon/node_modules/ws/index.js
const wsPath = process.argv[2];
const { pathToFileURL } = await import('node:url');
const { default: WebSocket } = await import(pathToFileURL(wsPath).href);
const PORT = 13870;
const URL_PART = 'api.github.com/repos/spendolas/gaffer-ae/releases/latest';
const NEUTRAL = 'Could not check for updates right now, try again later.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const pass = (m) => console.log('PASS: ' + m);
const fail = (m) => { console.log('FAIL: ' + m); fails++; };

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /gaffer/i.test((t.url || '') + (t.title || '')));
if (!page) { console.log('no gaffer page target on port ' + PORT); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
let id = 0;
const pending = new Map();
const listeners = [];
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  for (const l of listeners) l(m);
});
const rpc = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => (await rpc('Runtime.evaluate', { expression, returnByValue: true })).result.result.value;

let mode = 'continue';
const seen = [];
listeners.push(async (m) => {
  if (m.method === 'Fetch.requestPaused') {
    const h = m.params.request.headers || {};
    const inm = Object.keys(h).find((k) => k.toLowerCase() === 'if-none-match');
    seen.push({ type: 'request', ifNoneMatch: inm ? h[inm] : null });
    if (mode === 'force403') {
      await rpc('Fetch.fulfillRequest', {
        requestId: m.params.requestId, responseCode: 403,
        responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from('{"message":"API rate limit exceeded"}').toString('base64'),
      });
    } else {
      await rpc('Fetch.continueRequest', { requestId: m.params.requestId });
    }
  }
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes(URL_PART)) {
    seen.push({ type: 'response', status: m.params.response.status });
  }
});
await rpc('Runtime.enable');
await rpc('Network.enable');
await rpc('Fetch.enable', { patterns: [{ urlPattern: '*' + URL_PART + '*', requestStage: 'Request' }] });

async function checkNow() {
  seen.length = 0;
  await evalJs("document.getElementById('alertModal').hidden = true; 'ok'");
  await evalJs("document.getElementById('setCheckNowBtn').click(); 'ok'");
  await sleep(4000);
  return {
    modalShown: await evalJs("!document.getElementById('alertModal').hidden"),
    modalText: await evalJs("document.getElementById('alertModalBody').textContent"),
    lastCheck: await evalJs("localStorage.getItem('gafferLastUpdateCheckAt')"),
    cache: await evalJs("localStorage.getItem('gafferReleaseCache')"),
    banner: await evalJs("document.getElementById('updateBanner').classList.contains('visible')"),
    seen: seen.slice(),
  };
}

// 1. Real check: 200 (or 304 if a cache exists already), cache stored.
const first = await checkNow();
console.log('check 1:', JSON.stringify(first.seen), 'banner=' + first.banner);
if (first.cache && JSON.parse(first.cache).etag) pass('gafferReleaseCache holds an etag'); else fail('no gafferReleaseCache after a real check');

// 2. Second real check revalidates with If-None-Match and gets 304.
const second = await checkNow();
const req2 = second.seen.find((s) => s.type === 'request');
const res2 = second.seen.find((s) => s.type === 'response');
if (req2 && req2.ifNoneMatch && req2.ifNoneMatch === JSON.parse(first.cache).etag) pass('second check sent If-None-Match with the cached etag'); else fail('second check did not send the cached etag: ' + JSON.stringify(second.seen));
if (res2 && res2.status === 304) pass('second check got 304'); else fail('second check status: ' + (res2 && res2.status));
if (second.banner === first.banner) pass('304 path kept the same banner state (' + second.banner + ')'); else fail('banner changed on 304');

// 3. Forced 403: neutral modal, no recorded check, banner untouched.
mode = 'force403';
const third = await checkNow();
if (third.modalShown && third.modalText === NEUTRAL) pass('403 shows the neutral modal'); else fail('403 modal: shown=' + third.modalShown + ' text=' + third.modalText);
if (third.lastCheck === second.lastCheck) pass('403 did not record a check'); else fail('403 changed gafferLastUpdateCheckAt');
if (third.banner === second.banner) pass('403 left the banner as it was'); else fail('403 changed the banner');

await evalJs("document.getElementById('alertModal').hidden = true; 'ok'");
await rpc('Fetch.disable');
ws.close();
console.log(fails ? fails + ' FAILURE(S)' : 'ALL PASS');
process.exit(fails ? 1 : 0);
```

```bash
S="${TMPDIR:-/tmp}/gaffer-rel"
node "$S/update-probe.mjs" "$(pwd)/panel/daemon/node_modules/ws/index.js"
```

Expected: `PASS: gafferReleaseCache holds an etag`, `PASS: second check sent If-None-Match with the cached etag`, `PASS: second check got 304`, `PASS: 304 path kept the same banner state (...)`, `PASS: 403 shows the neutral modal`, `PASS: 403 did not record a check`, `PASS: 403 left the banner as it was`, `ALL PASS`.

Now click **Update** in Settings. Expected: the banner reads `Updating...`, the panel reloads by itself after about a minute, shows `v0.11.0 (<sha7>)`, and NO "Update did not complete" notice appears. Then:

```bash
INSTALL_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"
tail -3 /tmp/gaffer-update.log 2>/dev/null || tail -3 "${TMPDIR:-/tmp}/gaffer-update.log"
(cd "$INSTALL_DIR" && shasum -c "${TMPDIR:-/tmp}/gaffer-rel/mac-user.sha")
ls "$INSTALL_DIR" | grep -E 'gaffer-update|extract|version.json.tmp' || echo "no leftovers"
find "$INSTALL_DIR" -type f -newer "$INSTALL_DIR/version.json" | head -3
cat "$INSTALL_DIR/version.json"
```

Expected: the log ends with `ok:0.11.0`; all three files `OK`; `no leftovers`; the `find` prints nothing; `version.json` = `0.11.0` + the full SHA. (The panel spawns the updater with `TMPDIR` from its environment; look in both log locations.)

Restore the dev setup (owner OK to stop the daemon again):

```bash
EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"
kill $(lsof -nP -iTCP:9823 -sTCP:LISTEN -t) 2>/dev/null || true     # owner OK required
rm -rf "$EXT/com.gaffer.panel"
mv "$HOME/gaffer-panel-devlink.bak" "$EXT/com.gaffer.panel"
ls -la "$EXT" | grep com.gaffer.panel
```

Expected: `com.gaffer.panel -> .../Gaffer/panel` (the symlink is back). Reopen the panel; it is the dev install again.

- [ ] **Step 8: MANUAL, Windows fresh install and update from the real assets (VM)**

Update from a 0.10.8 install to the REAL release zip, with the Task 9 test (After Effects closed in the VM):

```bash
S="${TMPDIR:-/tmp}/gaffer-rel"; source "$S/gc.sh"; mkdir -p "$S/vm"
git archive --format=zip -o "$S/vm/old-install.zip" ce16c2f:panel
cp panel/daemon/update.ps1 panel/daemon/stop-daemon.ps1 scripts/windows-tests/test-5-update-ps1.ps1 "$S/vm/"
cp "$S/real/gaffer-update-win.zip" "$S/vm/gaffer-update-win.zip"
gc copyto --target-directory 'C:\Users\gaffer\gaffer-rel' "$S/vm/update.ps1" "$S/vm/stop-daemon.ps1" "$S/vm/test-5-update-ps1.ps1" "$S/vm/gaffer-update-win.zip" "$S/vm/old-install.zip"
gc run --timeout 900000 --exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -- powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\gaffer\gaffer-rel\test-5-update-ps1.ps1' -UpdateScriptDir 'C:\Users\gaffer\gaffer-rel' -OldInstallZip 'C:\Users\gaffer\gaffer-rel\old-install.zip' -ReleaseZip 'C:\Users\gaffer\gaffer-rel\gaffer-update-win.zip' -NodeDir 'C:\Users\gaffer\node-v24.19.0-win-x64'
```

Expected: `ALL PASS`, with `ok:0.11.0` in the log line.

Fresh install with the README commands. Create `$S/vm/readme-install.ps1` (a scratch file, never committed; it moves the VM's current install OUT of the extensions folder first):

```powershell
$ErrorActionPreference = "Stop"
$env:Path = "C:\Users\gaffer\node-v24.19.0-win-x64;$env:Path"
Write-Host "APPDATA=$env:APPDATA TEMP=$env:TEMP"
$installDir = "$env:APPDATA\Adobe\CEP\extensions\com.gaffer.panel"
if (Test-Path $installDir) { Move-Item $installDir ("$env:USERPROFILE\gaffer-panel-backup-" + (Get-Date -Format yyyyMMddHHmmss)) }
# README step 3, Windows block
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Remove-Item -Recurse -Force "$env:TEMP\gaffer-extract" -ErrorAction SilentlyContinue
Invoke-WebRequest -Uri "https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-win.zip" -OutFile "$env:TEMP\gaffer-install.zip" -UseBasicParsing
Expand-Archive -Path "$env:TEMP\gaffer-install.zip" -DestinationPath "$env:TEMP\gaffer-extract" -Force
Copy-Item -Recurse -Force "$env:TEMP\gaffer-extract\*" $installDir
Remove-Item -Recurse -Force "$env:TEMP\gaffer-install.zip", "$env:TEMP\gaffer-extract"
# README step 4
Push-Location "$installDir\daemon"
npm install --production
Pop-Location
Get-Content "$installDir\version.json"
Test-Path "$installDir\daemon\index.js"
```

```bash
S="${TMPDIR:-/tmp}/gaffer-rel"; source "$S/gc.sh"
gc copyto --target-directory 'C:\Users\gaffer\gaffer-rel' "$S/vm/readme-install.ps1"
gc run --profile --timeout 900000 --exe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -- powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\gaffer\gaffer-rel\readme-install.ps1'
```

Expected: `APPDATA=C:\Users\gaffer\AppData\Roaming ...` (if `VBoxManage` rejects `--profile`, drop it and check this line still shows the real profile paths); `version.json` with `0.11.0` and the full SHA; `True`. Then in the VirtualBox window (manual, GUI): start After Effects through Explorer, open Window > Extensions > Gaffer. Expected: the panel loads, the daemon starts, Settings shows `v0.11.0 (<sha7>)`.

---

### Task 12: Push B, unstick 0.10.2 to 0.10.8 clients, then clean up

**Files:**
- Modify: `panel/version.json:3` (`"commit"` only)

**Interfaces:**
- Consumes: release `v0.11.0` from Task 11 (must be complete: four assets, not a draft).
- Produces: `main`'s `panel/version.json` with a fresh `commit`, which makes every pre-0.11 client on 0.10.2 to 0.10.8 see an update.

- [ ] **Step 1: Pre-check (the "failing test")**

```bash
gh release view v0.11.0 --json isDraft,assets --jq '{isDraft, n: (.assets | length)}'
curl -s https://api.github.com/repos/spendolas/gaffer-ae/releases/latest | jq -r .tag_name
```

Expected: `{"isDraft":false,"n":4}` and `v0.11.0`. If not, STOP: fix the release first (`gh workflow run release.yml -f dry_run=false`), because Push B sends clients straight to the new panel.

- [ ] **Step 2: Change only the commit field**

```bash
git fetch origin && git status -sb | head -1     # if behind: git pull --rebase origin main
NEW="$(git log -1 --format=%h --abbrev=7 -- panel/version.json)"
echo "$NEW"
sed -i '' "s/\"commit\": \"401c1ec\"/\"commit\": \"$NEW\"/" panel/version.json
git diff panel/version.json
```

Expected: `$NEW` is the 7-character hash of the Task 11 release commit (anything but `401c1ec`); the diff is exactly:

```
-  "commit": "401c1ec"
+  "commit": "<NEW>"
```

```bash
git add panel/version.json
git commit -m "chore: refresh the legacy version.json commit so pre-0.11 clients update" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git log origin/main..HEAD --oneline        # exactly this one commit
git diff origin/main --stat                # 1 file changed, 1 insertion(+), 1 deletion(-)
```

- [ ] **Step 3: MANUAL, push B (owner's go-ahead required)**

```bash
git push origin main
sleep 15
RUN_ID="$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log | grep 'release-gate:'
gh run view "$RUN_ID" --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
gh release list
```

Expected: `release-gate: v0.11.0 -> skip`; `build success` (its Tests, Build and Upload steps skipped) and `publish skipped`; still exactly one release, `v0.11.0`.

- [ ] **Step 4: Post-checks, the real hop**

`main` now serves the new `commit` (the raw CDN can lag up to about 5 minutes):

```bash
curl -s "https://raw.githubusercontent.com/spendolas/gaffer-ae/main/panel/version.json"
```

Expected: `"version": "0.11.0"` and `"commit": "<NEW>"`.

Real old-script hop on the Mac, against real GitHub, in a scratch install (the panel must be closed; the old script stops whatever listens on 9823):

```bash
lsof -nP -iTCP:9823 -sTCP:LISTEN -t >/dev/null 2>&1 && echo "ABORT: a Gaffer daemon is running, close the panel first"
HOP="$(mktemp -d "${TMPDIR:-/tmp}/gaffer-hop-XXXXXX")"; mkdir -p "$HOP/tmp" "$HOP/Application Support/com.gaffer.panel"
INSTALL="$HOP/Application Support/com.gaffer.panel"
git archive ce16c2f:panel | tar -x -C "$INSTALL"
cp -R panel/daemon/node_modules "$INSTALL/daemon/node_modules"
TMPDIR="$HOP/tmp" npm_config_audit=false npm_config_fund=false bash "$INSTALL/daemon/update.sh"; echo "exit=$?"
cat "$INSTALL/version.json"; tail -1 "$HOP/tmp/gaffer-update.log"; ls "$INSTALL/update-state.js"
rm -rf "$HOP"
```

Expected: `exit=0`; `version.json` = `0.11.0` + `<NEW>`; `ok:<NEW>`; `update-state.js` exists.

Real hop on Windows: the VM's own Gaffer install (restored or reinstalled at 0.10.2 to 0.10.8 if Task 11 replaced it: put back the `gaffer-panel-backup-*` folder from Task 11 Step 8 if it was in that range) shows `Update available, v0.11.0` after Settings > Check now; click Update. Expected: the panel lands on `v0.11.0 (<sha7>)`, with no "Update did not complete" notice on the new panel.

If a stuck-client hop does not land, check in this order:
1. `curl` of raw `version.json` still shows `401c1ec`: CDN cache, wait 5 minutes and check again.
2. `/tmp/gaffer-update.log` or `%TEMP%\gaffer-update.log` shows a download error: the network blocks `codeload.github.com` or `raw.githubusercontent.com`; the README proxy note applies.
3. It landed on 0.11.0 but the new panel never offers later updates: `curl -s https://api.github.com/repos/spendolas/gaffer-ae/releases/latest | jq -r .tag_name`. A 404 means the release is missing or a draft: run `gh workflow run release.yml -f dry_run=false`.
4. "Update did not complete" appears on the new panel right after the hop: `updateVerdict` treated a commit-keyed attempt as a version; re-run `cd panel/daemon && node --test test/update-state.test.mjs` and inspect `localStorage.gafferUpdateAttempt` in the panel over CDP.
5. Lost chat history on a client below 0.10.8: expected once (documented in the v0.11.0 changelog entry).

- [ ] **Step 5: Rollback (only if a release is bad)**

- Prefer fixing forward: commit the fix, bump to `0.11.1` with a `## v0.11.1 - <date>` CHANGELOG entry, push. The gate creates `v0.11.1` and `releases/latest` moves to it.
- To pull a bad release immediately, MANUAL with the owner's go-ahead: `gh release delete v0.11.0 --cleanup-tag -y` (deletes the release and its tag; download counts for it are lost). `gh release edit v0.11.0 --prerelease` instead hides it from `releases/latest` but keeps it downloadable by tag.
- Clients degrade safely: new panels get a 404 from `releases/latest`, treat it as "no update info" and show nothing; `update.sh` / `update.ps1` fail their download (`curl -f` / `Invoke-WebRequest`) and exit before touching the install; the README install fails at the download step.
- Pre-0.11 clients follow `main`, not releases. To stop them, revert the version bump on `main`: `git revert <release commit>` and push. That push touches `panel/version.json`, so the release workflow runs; if the `v0.11.0` tag still exists, the gate fails (`0.10.8` is not greater than `v0.11.0`), which is expected and publishes nothing. Clients already on 0.11.0 are never downgraded (`isNewerVersion` is strictly greater-than).

- [ ] **Step 6: Local cleanup**

```bash
rm -f .git/hooks/post-commit.sdd-disabled
ls .git/hooks | grep sdd || echo "hook removed"
rm -rf "${TMPDIR:-/tmp}/gaffer-rel"
git status --short
```

Expected: `hook removed` (the file was untracked, so nothing to commit); `git status` shows only the known untracked files. The VM password in `gaffer-rel/gc.sh` is gone with the folder.
