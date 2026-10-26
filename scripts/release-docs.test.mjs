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
    /SHA-256/i, /Extract only/i, /signature/i, /unsigned CEP extensions/i, /Find Claude/i, /Register/i, /Restart After Effects and verify/i];
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

test('README step 1 looks for After Effects itself before asking', () => {
  const s = step(1);
  assert.ok(s.includes('ls -d "/Applications/Adobe After Effects"* 2>/dev/null'));
  assert.ok(s.includes('Get-ChildItem "C:\\Program Files\\Adobe" -Directory -Filter "Adobe After Effects*"'));
  assert.ok(s.includes('Ask the user only if nothing 2022 or later is found.'));
  assert.ok(!s.includes('Confirm with the user that After Effects'));
});

test('README step 3 detects the platform read-only', () => {
  const s = step(3);
  assert.ok(s.includes('sysctl -n hw.optional.arm64'));
  assert.ok(s.includes('$env:PROCESSOR_ARCHITECTURE'));
  assert.ok(s.includes("prints `sysctl: unknown oid 'hw.optional.arm64'`: that is expected and means Intel"));
  assert.ok(s.includes('Do not ask the user to confirm the platform.'));
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
  assert.ok(s.includes('-C "$INSTALL_DIR"'));
  // The install folder is created only after the checksum passed (an empty
  // folder is not an install), on both platforms.
  assert.ok(s.indexOf('mkdir -p "$INSTALL_DIR"') > s.indexOf('shasum -a 256 -c -'), 'macOS creates the install folder after the checksum');
  assert.ok(s.indexOf('New-Item -ItemType Directory -Path $installDir') > s.indexOf('does not match SHA256SUMS.txt'), 'Windows creates the install folder after the checksum');
  assert.ok(s.includes('a partial folder is not an install'));
  // Sequencing window: until the first release with SHA256SUMS.txt is
  // published, releases/latest has no checksum file. Wait and retry, never
  // work around it.
  assert.ok(s.includes('If only the `SHA256SUMS.txt` download fails with HTTP 404'));
  assert.ok(s.includes('a new Gaffer release is still being published'));
  assert.ok(s.includes('wait 2 minutes (`sleep 120` on macOS, `Start-Sleep -Seconds 120` on Windows), then run this step again unchanged. Retry up to 5 times.'));
  assert.ok(s.includes('a download fails in any way other than the `SHA256SUMS.txt` 404 described in the next paragraph, stop'), 'the general stop sentence must not contradict the wait and retry');
  assert.ok(s.includes('do not skip the checksum'));
  assert.ok(s.includes('If it still fails after the 5th retry, stop and tell the user.'));
});

test('README downloads into new private folders, never a fixed name in a shared temp directory', () => {
  assert.ok(!readme.includes('gaffer-download'), 'fixed download folder name left in the README');
  assert.equal(install.split('mktemp -d "${TMPDIR:-/tmp}/gaffer-').length - 1, 3, 'step 4 and both macOS step 5 blocks use mktemp -d');
  assert.equal(install.split('[guid]::NewGuid().ToString("N")').length - 1, 2, 'step 4 and the Windows step 5 block use a GUID folder');
  for (const n of [6, 7]) assert.ok(step(n).includes('<download folder step 5 printed>'), 'step ' + n + ' takes the folder step 5 printed');
  assert.ok(step(5).includes('prints its path; steps 6 and 7 need that path'));
});

test('README Windows blocks fail one way: throw, never a printed warning that lets the block go on', () => {
  for (const n of [4, 5, 6, 7]) assert.ok(!/Write-Host "(Download|Extract) failed/.test(step(n)), 'step ' + n + ' prints a failure and continues');
  assert.ok(step(5).includes('throw "Download failed (curl exit $LASTEXITCODE). From nodejs.org: use Gaffer\'s mirror'));
  assert.ok(step(7).includes('throw "Extract failed (tar exit $LASTEXITCODE)"'));
});

test('README tells an agent in bash to run the Windows blocks in PowerShell', () => {
  const rules = section(install, /^### Rules for Claude/m, /^### /m);
  assert.ok(rules.includes('Run each Windows block in PowerShell. If your shell is bash, run it as `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ...` or save it to a .ps1 file and run that'));
  assert.ok(rules.includes('step 4 names a wait and retry'));
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
  assert.ok(s.includes("After Effects' developer setting for panels that are not signed by Adobe. It applies to all unsigned panels on this computer, not just Gaffer, and it installs nothing"));
  assert.ok(s.includes('PlayerDebugMode'));
});

test('README step 10 pins Claude with the downloaded runtime, not a system node', () => {
  const s = step(10);
  assert.ok(s.includes('"$INSTALL_DIR/daemon/runtime/node" -e'));
  assert.ok(s.includes('"claudeBin"'));
});

// Windows fresh-install trial: Claude Code's command guard blocked step 4
// ("Remove-Item on system path '\s+' is blocked") because the block mixed a
// Remove-Item with a -split '\s+' regex. Every delete is its own small block.
const psBlocks = (text) => [...text.matchAll(/```powershell\n([\s\S]*?)```/g)].map((m) => m[1]);

test('README Windows blocks keep every Remove-Item in its own block, away from regexes and other commands', () => {
  const blocks = psBlocks(install);
  assert.ok(blocks.length > 8, 'found the Windows blocks');
  assert.ok(!install.includes("'\\s+'"), 'no \\s+ regex left in the install section');
  const deletes = blocks.filter((b) => b.includes('Remove-Item'));
  assert.ok(deletes.length >= 3, 'step 4 and step 7 delete in their own blocks');
  for (const b of deletes) {
    const lines = b.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.equal(lines.filter((l) => l.includes('Remove-Item')).length, 1, 'one Remove-Item per block:\n' + b);
    for (const l of lines) {
      assert.ok(/^\$\w+ = "[^"]*"$/.test(l) || /^Remove-Item -LiteralPath \$\w+ -Recurse -Force$/.test(l), 'a delete block holds only a path variable and the delete:\n' + b);
    }
  }
  // Step 4 compares the checksum without a regex split.
  const s4 = step(4);
  assert.ok(s4.includes(".Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[0]"));
  assert.ok(!s4.includes('-split'), 'step 4 has no regex split');
  assert.ok(s4.includes('$dl = "<download folder step 4 printed>"'));
  assert.ok(step(7).includes('$dl = "<download folder step 5 printed>"\n   Remove-Item -LiteralPath $dl -Recurse -Force'));
});

test('README rules say each block is its own command', () => {
  const rules = section(install, /^### Rules for Claude/m, /^### /m);
  assert.ok(rules.includes('Each code block is its own command: run it on its own, and do not merge blocks or add commands to them.'));
});

test('README step 11 says the registration may be blocked and what to do then', () => {
  const s = step(11);
  assert.ok(s.includes('may block this command, because it writes a lasting entry into the user\'s settings'));
  assert.ok(s.includes('show the user the exact command'));
  assert.ok(s.includes('it is optional because the panel\'s own chat works without it'));
  assert.ok(s.includes('continue with step 12'));
  assert.ok(step(12).includes('or was blocked and the user has not run the command, skip this check too'));
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

test('CHANGELOG top section is plain bullets (Unreleased, or the dated release entry with a bold summary)', () => {
  const top = /^## Unreleased$/m.test(changelog)
    ? section(changelog, /^## Unreleased$/m, /^## v/m)
    : section(changelog, /^## v0\.12\.0 - \d{4}-\d{2}-\d{2}$/m, /^## v0\.11\.3/m);
  assert.ok(/^- /m.test(top));
  assert.ok(!DASHES.test(top));
  if (!/^## Unreleased$/m.test(changelog)) assert.ok(/^\*\*[^*]+\*\*$/m.test(top), 'the release entry has a bold one-line summary');
  assert.ok(changelog.indexOf('## v0.11.3') > 0);
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

// ---- Developer installers (spec 9): install-win.ps1 test switches, windows-tests/test-7 ----
// The behaviour runs on Windows only (scripts/windows-tests/test-7-install-win.ps1).

const raw = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const readNoBom = (rel) => raw(rel).toString('utf8').replace(/^\uFEFF/, '');
const win = readNoBom('./install-win.ps1');
const t7 = readNoBom('./windows-tests/test-7-install-win.ps1');
const SWITCHES = ['-ExtensionsDir', '-NoSymlink', '-NoStopDaemon', '-NoRegistry', '-NoMcp'];

// Text between the first occurrence of `start` and the next line at column 0
// that starts with `stop` (a regex), for checking what a branch encloses.
function between(text, start, stop) {
  const i = text.indexOf(start);
  assert.ok(i !== -1, 'not found: ' + start);
  const rest = text.slice(i);
  const j = rest.slice(start.length).search(stop);
  return j === -1 ? rest : rest.slice(0, start.length + j);
}

test('install-win.ps1 and test-7 are ASCII with a UTF-8 BOM', () => {
  for (const rel of ['./install-win.ps1', './windows-tests/test-7-install-win.ps1']) {
    const b = raw(rel);
    assert.deepEqual([...b.subarray(0, 3)], [0xef, 0xbb, 0xbf], rel + ' BOM');
    assert.ok(![...b.subarray(3)].some((c) => c > 0x7e || (c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09)), rel + ' ASCII only');
  }
});

test('install-win.ps1 declares the test switches with defaults that keep the old behaviour', () => {
  const param = between(win, 'param(', /^\)/m);
  assert.match(param, /\[string\] \$ExtensionsDir = ""/);
  for (const s of ['NoSymlink', 'NoStopDaemon', 'NoRegistry', 'NoMcp']) assert.match(param, new RegExp('\\[switch\\] \\$' + s + '\\b'));
  assert.ok(win.indexOf('param(') < win.indexOf('$ErrorActionPreference = "Stop"'), 'param block comes first');
  assert.ok(win.includes('if (-not $ExtensionsDir) { $ExtensionsDir = "$env:APPDATA\\Adobe\\CEP\\extensions" }'), 'default is the real CEP extensions folder');
  assert.ok(win.includes('$installDir = Join-Path $ExtensionsDir $extensionId'));
  for (const s of SWITCHES) assert.ok(win.split('\n').slice(0, 30).join('\n').includes(s), 'header usage documents ' + s);
});

test('every side effect sits behind its switch', () => {
  const stop = between(win, 'if ($NoStopDaemon) {', /^\}\s*$/m);
  assert.ok(stop.includes('Stop-Daemon') && stop.includes('Stop-Process') && stop.includes('gaffer-daemon'), 'daemon stop is inside the -NoStopDaemon branch');
  assert.equal(win.split('Stop-Process').length - 1, (stop.split('Stop-Process').length - 1), 'no Stop-Process outside the guarded block');
  const reg = between(win, 'if ($NoRegistry) {', /^\}\s*$/m);
  assert.ok(reg.includes('PlayerDebugMode') && reg.includes('Set-ItemProperty'));
  assert.equal(win.split('Set-ItemProperty').length - 1, 1, 'only the guarded registry write');
  const mcpStart = win.indexOf('if ($NoMcp) {');
  assert.ok(mcpStart !== -1);
  assert.ok(mcpStart < win.indexOf('"mcp", "get", "gaffer"') && mcpStart < win.indexOf('"mcp", "add"'), 'mcp get/add come after the -NoMcp gate');
  assert.match(win.slice(mcpStart), /^if \(\$NoMcp\) \{[\s\S]*?\} elseif \(-not \$claudeBin\) \{/, '-NoMcp leaves $registerMcp false');
  assert.ok(win.includes('if ($NoSymlink) {\n    $installKind = "copy"'), '-NoSymlink forces the copy path');
});

test('install-win.ps1 copy path: robocopy excludes, failure check, link-safe removal, LiteralPath', () => {
  assert.ok(win.includes('robocopy "$panelDir" "$installDir" /E /XD node_modules dist .remember runtime runtime.new runtime.old /XF package-lock.json .debug'));
  assert.ok(win.includes('if ($LASTEXITCODE -ge 8) {'), 'robocopy failure stops the install');
  assert.ok(win.includes('[System.IO.Directory]::Delete($installDir, $false)'), 'a symlinked install is unlinked, not recursively deleted');
  assert.ok(win.includes('Remove-Item -LiteralPath $installDir -Recurse -Force'));
  assert.ok(!/Remove-Item -Recurse -Force \$installDir/.test(win), 'no wildcard-path recursive delete of the install');
  assert.ok(win.includes('-File "$deployedDaemon\\fetch-runtime.ps1" -Into $deployedDaemon'));
  assert.ok(win.includes("if ($last -notmatch '^runtime:(current|installed)') {"));
});

test('test-7 runs the installer with every side-effect switch, TEMP in scratch, both layouts', () => {
  assert.ok(t7.includes('-ExtensionsDir $extDir -NoSymlink -NoStopDaemon -NoRegistry -NoMcp'));
  assert.ok(t7.includes('$env:TEMP = $tmp; $env:TMP = $tmp'));
  assert.ok(t7.includes('Case A: packaged release layout') && t7.includes('Case B: checkout layout'));
  assert.ok(/REAL DOWNLOAD/.test(t7), 'header says the runtime is really downloaded');
  for (const s of ['registry CSXS.$v PlayerDebugMode', '.claude.json', 'real extension folder', 'port 9823 listener', 'real %TEMP% gaffer-* entries']) {
    assert.ok(t7.includes(s), 'outside-scratch snapshot covers ' + s);
  }
  for (const p of ['node_modules\\x\\index.js', 'daemon\\dist\\stage\\x.txt', '.remember\\x.md', 'daemon\\runtime.new\\node.exe', 'daemon\\runtime.old\\node.exe', 'daemon\\package-lock.json']) {
    assert.ok(t7.includes(p), 'test-7 plants ' + p);
  }
  assert.ok(t7.includes('Select-String -LiteralPath $installer -Pattern "NoRegistry"'), 'refuses to run an installer without the switches');
});

test('README documents none of the installer test switches as user steps', () => {
  for (const s of SWITCHES) assert.ok(!readme.includes(s), 'README mentions ' + s);
  assert.ok(!readme.includes('test-7-install-win'));
});
