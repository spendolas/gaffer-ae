// Run from the repo root: node --test scripts/release-docs.test.mjs
// Pins the user-facing install/update docs, the changelog entries and
// CLAUDE.md to the GitHub Releases flow and the zero-dependency install
// (spec docs/superpowers/specs/2026-10-22-zero-dependency-install-design.md,
// sections 9 to 11). The README's runtime URLs, hashes and Team ID must equal
// panel/daemon/runtime-pins.json (scripts/readme-pins.mjs renders them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractNotes, decide } from './release-gate.mjs';
import { checkReadme, renderRuntimeSteps, writeRuntimeSteps, BEGIN_MARK, END_MARK, CURL_OPTS } from './readme-pins.mjs';

// Same download budget as panel/daemon/fetch-runtime.sh and fetch-runtime.ps1.
const CURL_FLAGS = '-fsSL --proto \'=https\' --connect-timeout 20 --speed-limit 10240 --speed-time 60 --max-time 1800 --retry-max-time 1800 --retry 3 --retry-delay 2';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const readme = read('../README.md');
const changelog = read('../CHANGELOG.md');
const claudeMd = read('../CLAUDE.md');
const pins = JSON.parse(read('../panel/daemon/runtime-pins.json'));
const DASHES = /[–—]/;

function section(text, startRe, endRe) {
  const start = text.search(startRe);
  assert.ok(start !== -1, 'section not found: ' + startRe);
  const rest = text.slice(start);
  const end = rest.slice(1).search(endRe);
  return end === -1 ? rest : rest.slice(0, end + 1);
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const install = section(readme, /^## Install Instructions for Claude/m, /^<\/details>/m);
const step = (n) => section(install, new RegExp('^' + n + '\\. \\*\\*', 'm'), new RegExp('^(' + (n + 1) + '\\. |### )', 'm'));

// ---- One download budget: README (CURL_OPTS) and both fetch-runtime scripts ----

test('the README curl budget equals the defaults in fetch-runtime.sh and fetch-runtime.ps1', () => {
  const n = (flag) => {
    const m = CURL_OPTS.match(new RegExp('--' + flag + ' (\\d+)(?:\\s|$)'));
    assert.ok(m, 'CURL_OPTS has --' + flag);
    return m[1];
  };
  const v = { connect: n('connect-timeout'), limit: n('speed-limit'), speed: n('speed-time'), max: n('max-time'), retryMax: n('retry-max-time'), retry: n('retry'), delay: n('retry-delay') };
  assert.equal(v.retryMax, v.max, 'README: --retry-max-time equals --max-time, like the scripts');
  assert.ok(CURL_OPTS.includes("--proto '=https'"));

  const sh = read('../panel/daemon/fetch-runtime.sh');
  assert.ok(sh.includes('\nSPEED_TIME=' + v.speed + '\n'), 'fetch-runtime.sh SPEED_TIME default');
  assert.ok(sh.includes('\nMAX_TIME=' + v.max + '\n'), 'fetch-runtime.sh MAX_TIME default');
  const shCurl = sh.slice(sh.indexOf('  curl --fail'), sh.indexOf('-o "$TMP/$ARCHIVE"')).replace(/\\\n\s*/g, ' ');
  for (const s of ['--proto "$PROTO"', '--connect-timeout ' + v.connect, '--speed-limit ' + v.limit, '--speed-time "$SPEED_TIME"',
    '--max-time "$MAX_TIME"', '--retry-max-time "$MAX_TIME"', '--retry ' + v.retry + ' ', '--retry-delay ' + v.delay]) {
    assert.ok(shCurl.includes(s), 'fetch-runtime.sh curl line lacks ' + s + ': ' + shCurl);
  }
  assert.ok(/\n {2}PROTO="=https"\n/.test(sh), 'fetch-runtime.sh is https-only outside test mode');

  const ps1 = read('../panel/daemon/fetch-runtime.ps1');
  assert.ok(ps1.includes('$speedTime = ' + v.speed + '\r\n') || ps1.includes('$speedTime = ' + v.speed + '\n'), 'fetch-runtime.ps1 $speedTime default');
  assert.ok(ps1.includes('$maxTime = ' + v.max + '\r\n') || ps1.includes('$maxTime = ' + v.max + '\n'), 'fetch-runtime.ps1 $maxTime default');
  const psCurl = ps1.slice(ps1.indexOf('$curlArgs = @('), ps1.indexOf('"-o", $archive'));
  for (const s of ['"--connect-timeout", "' + v.connect + '"', '"--speed-limit", "' + v.limit + '"', '"--speed-time", [string] $speedTime',
    '"--max-time", [string] $maxTime', '"--retry-max-time", [string] $maxTime', '"--retry", "' + v.retry + '"', '"--retry-delay", "' + v.delay + '"']) {
    assert.ok(psCurl.includes(s), 'fetch-runtime.ps1 curl args lack ' + s);
  }
});

// ---- README runtime values come from runtime-pins.json ----

test('README runtime steps equal the rendering of runtime-pins.json, and nothing drifts', () => {
  assert.deepEqual(checkReadme(readme, pins), []);
});

test('the drift check fails when a pin changes and the README does not', () => {
  const plat = Object.keys(pins.node.platforms)[0];
  const cases = [
    (p) => { p.node.platforms[plat].archiveSha256 = 'f'.repeat(64); },
    (p) => { p.node.official = 'https://nodejs.org/dist/v24.99.0/'; },
    (p) => { p.node.mirror = 'https://github.com/spendolas/gaffer-ae/releases/download/node-v0/'; },
    (p) => { p.node.signing.darwinTeamId = 'AAAAAAAAAA'; },
    (p) => { p.node.signing.windowsSigner = 'Someone Else'; },
    (p) => { p.node.version = 'v24.99.0'; },
    (p) => { p.node.platforms[plat].member = p.node.platforms[plat].member.replace(/node$/, 'nodejs'); },
    (p) => { p.node.platforms['win-x64'].member = 'node-v24.22.1-win-x64/bin/node.exe'; },
    (p) => { p.node.platforms[plat].archive = p.node.platforms[plat].archive.replace('.tar.gz', '.tar.xz'); },
    (p) => { p.node.platforms['win-x64'].archive = 'node-v24.22.1-win-x64.7z'; },
  ];
  for (const mutate of cases) {
    const p = clone(pins);
    mutate(p);
    assert.notDeepEqual(checkReadme(readme, p), [], 'a changed pin went unnoticed: ' + mutate);
  }
});

test('the drift check fails when the README is edited by hand', () => {
  const sha = pins.node.platforms['win-x64'].archiveSha256;
  const mutations = [
    readme.replace(sha, sha.slice(0, -1) + (sha.endsWith('0') ? '1' : '0')),
    readme.replace('TeamIdentifier=' + pins.node.signing.darwinTeamId, 'TeamIdentifier=ZZZZZZZZZZ'),
    readme.replace(pins.node.official, 'https://nodejs.org/dist/v1.0.0/'),
    readme.replace(BEGIN_MARK, ''),
    // A stray value outside the generated block is caught too.
    readme + '\nSee https://nodejs.org/dist/v1.2.3/node-v1.2.3-darwin-x64.tar.gz\n',
    readme + '\nMirror: https://github.com/spendolas/gaffer-ae/releases/download/node-v1.2.3/x.zip\n',
    // Under the pinned base but not a pinned archive.
    readme + '\nSee ' + pins.node.official + 'SHASUMS256.txt\n',
    readme + '\nSee ' + pins.node.mirror + 'other.zip\n',
    readme + '\n' + 'a'.repeat(64) + '\n',
    readme + '\nTeamIdentifier=ABCDEFGHIJ\n',
    readme + '\nnode-v9.9.9-win-x64.zip\n',
  ];
  for (const text of mutations) {
    assert.notEqual(text, readme, 'mutation did not apply');
    assert.notDeepEqual(checkReadme(text, pins), [], 'a hand edit went unnoticed');
  }
});

test('writeRuntimeSteps regenerates the block and is idempotent', () => {
  assert.equal(writeRuntimeSteps(readme, pins), readme);
  const p = clone(pins);
  p.node.platforms['darwin-x64'].archiveSha256 = 'e'.repeat(64);
  const updated = writeRuntimeSteps(readme, p);
  assert.ok(updated.includes('e'.repeat(64)));
  assert.deepEqual(checkReadme(updated, p), []);
  assert.ok(renderRuntimeSteps(pins).includes(END_MARK) === false, 'markers stay outside the rendered body');
});

test('every pinned platform has its official URL, mirror URL, SHA-256 and extract member in the README', () => {
  const n = pins.node;
  for (const [key, p] of Object.entries(n.platforms)) {
    assert.ok(readme.includes(n.official + p.archive), key + ' official URL');
    assert.ok(readme.includes(n.mirror + p.archive), key + ' mirror URL');
    assert.ok(readme.includes(p.archiveSha256), key + ' archive SHA-256');
    assert.ok(readme.includes(p.member), key + ' extract member');
  }
  assert.ok(readme.includes('TeamIdentifier=' + n.signing.darwinTeamId));
  assert.ok(readme.includes(n.signing.windowsSigner));
});

// ---- README install steps (spec 9, decision D1, agent-trial wording) ----

test('README install steps follow the spec 9 order', () => {
  const titles = [...install.matchAll(/^(\d+)\. \*\*([^*]+)\*\*/gm)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(titles.map((t) => t[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const want = [/prerequisites/i, /existing install/i, /platform/i, /Gaffer package/i, /Download the Node\.js runtime/i,
    /SHA-256/i, /Extract only/i, /signature/i, /developer mode/i, /Find Claude/i, /Register/i, /Restart After Effects and verify/i];
  titles.forEach(([n, title], i) => assert.match(title, want[i], 'step ' + n + ' title: ' + title));
});

test('README has no Node.js prerequisite, no npm step and no Node troubleshooting', () => {
  assert.ok(!readme.includes('Node.js 20+ ([install]'), 'Node prerequisite still listed');
  assert.ok(!install.includes('node --version'), 'install still checks a system node');
  assert.ok(!/npm install/.test(install), 'install section still runs npm');
  assert.ok(!install.includes('Install daemon dependencies'), 'npm step still present');
  assert.ok(!install.includes('Install says my Node version is too old'), 'Node troubleshooting entry still present');
  assert.ok(!install.includes('which node'), 'troubleshooting still checks a system node');
  assert.ok(!install.includes('Usually a missing `npm install`'));
  // The only node the install runs is the runtime it downloaded.
  assert.ok(!/^\s*node -e/m.test(install), 'a bare node -e remains');
});

test('README rules block carries the agent-trial wording', () => {
  const rules = section(install, /^### Rules for Claude/m, /^### /m);
  assert.ok(rules.includes('Do not install Node.js any other way (Homebrew, nvm, npm, installers).'));
  assert.ok(rules.includes('Do not change proxy, certificate or network settings, do not turn off certificate checks, and do not ask the user to approve that either.'));
  assert.ok(rules.includes('unless the step itself names a fallback'));
  assert.ok(rules.includes('If both downloads fail, stop and tell the user.'));
  assert.ok(!rules.includes('(Node.js, Claude Code, After Effects)'), 'Node is no longer a prerequisite to install');
});

test('README step 3 detects the platform read-only', () => {
  const s = step(3);
  assert.ok(s.includes('sysctl -n hw.optional.arm64'));
  assert.ok(s.includes('$env:PROCESSOR_ARCHITECTURE'));
  assert.ok(!/\buname -m`? (to|for)/.test(s));
});

test('README step 4 downloads the latest release package and verifies it against SHA256SUMS.txt', () => {
  const s = step(4);
  const base = 'https://github.com/spendolas/gaffer-ae/releases/latest/download/';
  assert.ok(s.includes(base + 'gaffer-install-mac.tar.gz'));
  assert.ok(s.includes(base + 'gaffer-install-win.zip'));
  assert.ok(s.includes(base + 'SHA256SUMS.txt'));
  assert.ok(s.includes('shasum -a 256 -c -'));
  assert.ok(s.includes('Get-FileHash'));
  assert.equal(CURL_OPTS, CURL_FLAGS);
  assert.equal(s.split('curl ' + CURL_FLAGS + ' -o ').length - 1, 2, 'both macOS downloads use the shared flags');
  assert.equal(s.split('curl.exe ' + CURL_FLAGS + ' -o ').length - 1, 2, 'both Windows downloads use the shared flags');
  assert.ok(!/--max-time 600\b/.test(readme), 'old download budget left in the README');
  assert.ok(!readme.includes('--proto =https'), 'zsh expands a bare =https; it must be quoted');
  assert.ok(s.includes('tar.exe -xf'));
  assert.ok(!s.includes('Expand-Archive'), 'Windows extracts with tar.exe');
  assert.ok(!s.includes('Invoke-WebRequest'), 'PowerShell 5.1 web cmdlets stall on the progress bar');
  assert.ok(!s.includes('archive/refs/heads/main'));
  assert.ok(!s.includes('gaffer-ae-main'));
  // A curl | tar pipeline exits 0 when the download fails (tar is last and
  // succeeds on empty input), so the install must download to a file first.
  assert.ok(!s.includes('| tar'), 'macOS install must not pipe curl into tar');
  assert.ok(s.includes('mkdir -p "$DL" "$INSTALL_DIR"'));
  assert.ok(s.includes('-C "$INSTALL_DIR"'));
});

test('README steps 5 to 8 carry the trigger sentence, the extract command and the signature checks', () => {
  assert.ok(step(5).includes('If that download fails, for example because your network blocks nodejs.org, download the same file from Gaffer\'s mirror:'));
  assert.ok(step(5).includes('The mirror is byte-identical: its SHA-256 equals the value in nodejs.org\'s SHASUMS256.txt for this file.'));
  assert.ok(step(5).includes('curl ' + CURL_FLAGS + ' -o '));
  assert.ok(step(5).includes('curl.exe ' + CURL_FLAGS + ' -o '));
  assert.ok(!/--ssl-no-revoke|--insecure|\s-k\s/.test(readme), 'README never weakens TLS checks');
  assert.ok(step(7).includes('--strip-components=2'));
  assert.ok(step(7).includes('Delete the archive and any download folder you created'));
  const s8 = step(8);
  assert.ok(s8.includes('codesign --verify --strict'));
  assert.ok(s8.includes('codesign -dv'));
  assert.ok(s8.includes('Get-AuthenticodeSignature'));
  assert.ok(s8.includes('If nodejs.org is unreachable, the code signature is the independent check.'));
  assert.ok(s8.includes('--version'));
  assert.ok(s8.includes('The Gaffer folder was left without a runtime; nothing was installed anywhere else.'));
  assert.ok(!s8.includes('Nothing was installed.'), 'step 4 already installed the package');
});

test('README step 9 describes the developer-mode flag as a user preference', () => {
  const s = step(9);
  assert.ok(s.includes('a user preference that lets After Effects load extensions that are not signed through Adobe; it installs nothing'));
  assert.ok(s.includes('PlayerDebugMode'));
});

test('README step 10 pins Claude with the downloaded runtime, not a system node', () => {
  const s = step(10);
  assert.ok(s.includes('"$INSTALL_DIR/daemon/runtime/node" -e'));
  assert.ok(s.includes('"claudeBin"'));
});

test('README step 11 registers the MCP server by default, with disclosure and a removal command (decision D1)', () => {
  const s = step(11);
  assert.ok(s.includes('mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp'));
  assert.ok(!/\(optional\)/i.test(s.split('\n')[0]), 'registration is on by default');
  assert.ok(s.includes('~/.claude.json'), 'names the file it writes');
  assert.ok(s.includes('claude mcp remove gaffer -s user'), 'one-line removal command');
});

test('README troubleshooting covers Windows revocation-lookup failures without weakening checks', () => {
  const t = section(install, /^### Troubleshooting/m, /^<\/details>/m);
  assert.ok(t.includes('CRYPT_E_REVOCATION_OFFLINE'));
  assert.ok(t.includes('curl exit 35'));
  assert.ok(t.includes('network administrator'));
});

test('README has no em or en dashes anywhere', () => {
  assert.ok(!DASHES.test(readme));
});

test('README Updating section describes releases, the runtime and the proxy hosts', () => {
  const updating = section(readme, /^## Updating/m, /^---$/m);
  assert.ok(updating.includes('api.github.com'));
  assert.ok(updating.includes('release-assets.githubusercontent.com'));
  assert.ok(updating.includes('nodejs.org'));
  assert.ok(updating.includes('gaffer-update-mac.tar.gz'));
  assert.ok(updating.includes('gaffer-update-win.zip'));
  assert.ok(!updating.includes('reinstalls deps'), 'updates no longer run npm');
  assert.ok(!DASHES.test(updating), 'no em or en dashes in the Updating section');
});

// ---- CHANGELOG ----

test('CHANGELOG has a v0.11.0 entry the release gate accepts', () => {
  const notes = extractNotes(changelog, '0.11.0');
  assert.ok(notes, 'no "## v0.11.0" heading');
  assert.match(notes, /^\*\*.+\*\*\n/, 'entry starts with a bold one-line summary');
  assert.ok(notes.includes('older than v0.10.8'), 'entry carries the one-time old-script caveat');
  assert.ok(!DASHES.test(notes), 'no em or en dashes in the v0.11.0 entry');
  const r = decide({ version: '0.11.0', tags: [], release: null, changelog });
  assert.equal(r.action, 'create');
});

test('CHANGELOG v0.11.2 carries the plain-language security notice and no stale download claim', () => {
  const notes = extractNotes(changelog, '0.11.2');
  assert.ok(notes, 'no "## v0.11.2" heading');
  assert.ok(notes.includes('**Security:** in versions before v0.11.2, Gaffer\'s background service accepted connections from other devices on your network and from web pages open in your browser, not only from the After Effects panel.'));
  assert.ok(notes.includes('close the Gaffer panel when you are on a network you do not trust.'));
  assert.ok(!notes.includes('gives up after about two minutes'), 'updater bullet still claims a two minute give-up');
  assert.ok(!DASHES.test(notes), 'no em or en dashes in the v0.11.2 entry');
});

test('CHANGELOG Unreleased section is plain bullets, no dated release heading', () => {
  const unreleased = section(changelog, /^## Unreleased$/m, /^## v/m);
  assert.ok(/^- /m.test(unreleased));
  assert.ok(!DASHES.test(unreleased));
  assert.ok(changelog.indexOf('## Unreleased') < changelog.indexOf('## v0.11.3'));
});

// ---- CLAUDE.md ----

test('CLAUDE.md Releasing describes the workflow, not hand-stamped commits', () => {
  const releasing = section(claudeMd, /^## Releasing/m, /^## /m);
  assert.ok(releasing.includes('.github/workflows/release.yml'));
  assert.ok(releasing.includes('scripts/release-gate.mjs'));
  assert.ok(!releasing.includes('(version + commit)'));
  const layout = section(claudeMd, /^## Repo Layout/m, /^## /m);
  assert.ok(layout.includes('release-gate.mjs'), 'repo layout lists the gate');
  assert.ok(layout.includes('release.yml'), 'repo layout lists the release workflow');
  assert.ok(layout.includes('update-state.js'), 'repo layout lists update-state.js');
  assert.ok(!claudeMd.includes('install/update from the `main` tarball'), 'CLAUDE.md no longer says users get code from the main tarball');
  assert.ok(claudeMd.includes('install and update from GitHub Release assets'));
});

test('CLAUDE.md describes the bundle, the pinned runtime and five release assets', () => {
  const releasing = section(claudeMd, /^## Releasing/m, /^## /m);
  assert.ok(releasing.includes('SHA256SUMS.txt'), 'fifth asset');
  assert.ok(/five assets/.test(releasing));
  assert.ok(releasing.includes('node-runtime-check.yml'));
  assert.ok(releasing.includes('--latest=false'), 'mirror release rule');
  const layout = section(claudeMd, /^## Repo Layout/m, /^## /m);
  for (const f of ['runtime-pins.json', 'fetch-runtime.sh', 'fetch-runtime.ps1', 'launch.cjs', 'daemon-launch.js', 'bundle-daemon.sh', 'readme-pins.mjs', 'node-runtime-check.yml']) {
    assert.ok(layout.includes(f), 'repo layout lists ' + f);
  }
  assert.ok(!/\bSEA\b/.test(claudeMd), 'no SEA binary any more');
  assert.ok(claudeMd.includes('CSXS.11, CSXS.12 and CSXS.13'), 'PlayerDebugMode versions match the installers');
  assert.ok(claudeMd.includes('daemon.mjs'));
  assert.ok(claudeMd.includes('ASCII-only with a UTF-8 BOM'), '.ps1 rules unchanged');
});
