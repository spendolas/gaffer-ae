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
const DASHES = /[–—]/;

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
  // A curl | tar pipeline exits 0 when the download fails (tar is last and
  // succeeds on empty input), so the install must download to a file first.
  assert.ok(!step3.includes('| tar'), 'macOS install must not pipe curl into tar');
  assert.ok(step3.includes('mkdir -p "$INSTALL_DIR"'));
  assert.ok(step3.includes('curl -fsSL'));
  assert.ok(step3.includes('-C "$INSTALL_DIR"'));
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
  assert.ok(!claudeMd.includes('install/update from the `main` tarball'), 'CLAUDE.md no longer says users get code from the main tarball');
  assert.ok(claudeMd.includes('install and update from GitHub Release assets'));
});

test('README asks for Node 20+ everywhere (the MCP SDK loads @hono/node-server, which needs node >=20)', () => {
  assert.ok(!/Node(\.js)? 18\+|must be 18|requires Node 18/.test(readme), 'README still mentions Node 18');
  assert.ok(readme.includes('Node.js 20+'));
  assert.ok(readme.includes('must be 20 or higher'));
  assert.ok(readme.includes('requires Node 20+'));
  const pkg = JSON.parse(read('../panel/daemon/package.json'));
  assert.equal(pkg.engines && pkg.engines.node, '>=20');
});

test('CHANGELOG v0.11.2 carries the plain-language security notice and no stale download claim', () => {
  const notes = extractNotes(changelog, '0.11.2');
  assert.ok(notes, 'no "## v0.11.2" heading');
  assert.ok(notes.includes('**Security:** in versions before v0.11.2, Gaffer\'s background service accepted connections from other devices on your network and from web pages open in your browser, not only from the After Effects panel.'));
  assert.ok(notes.includes('close the Gaffer panel when you are on a network you do not trust.'));
  assert.ok(!notes.includes('gives up after about two minutes'), 'updater bullet still claims a two minute give-up');
  assert.ok(!DASHES.test(notes), 'no em or en dashes in the v0.11.2 entry');
});
