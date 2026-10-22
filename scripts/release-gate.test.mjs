// Run from the repo root: node --test scripts/release-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requiredAssets, decide, compareVersions, extractNotes, GateError, REQUIRED_ASSETS } from './release-gate.mjs';

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

test('published release with all five assets -> skip', () => {
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

test('the required asset list is the four archives plus SHA256SUMS.txt', () => {
  assert.deepEqual([...REQUIRED_ASSETS].sort(), [
    'SHA256SUMS.txt',
    'gaffer-install-mac.tar.gz',
    'gaffer-install-win.zip',
    'gaffer-update-mac.tar.gz',
    'gaffer-update-win.zip',
  ]);
});

const four = () => requiredAssets('0.11.3').map((name) => ({ name }));

test('v0.11.3 published with four assets (no SHA256SUMS.txt) -> skip', () => {
  assert.equal(requiredAssets('0.11.3').length, 4);
  const r = decide({ version: '0.11.3', tags: ['v0.11.3'], release: { isDraft: false, assets: four() }, changelog: '' });
  assert.equal(r.action, 'skip');
});

test('0.12.0 with four assets -> recover', () => {
  const r = decide({ version: '0.12.0', tags: ['v0.12.0'], release: { isDraft: false, assets: four() }, changelog: CHANGELOG.replace('0.11.0', '0.12.0') });
  assert.equal(r.action, 'recover');
});

test('requiredAssets compares the numeric version only: a 0.12.0 prerelease needs SHA256SUMS.txt', () => {
  assert.equal(requiredAssets('0.12.0-beta.1').length, 5);
  assert.ok(requiredAssets('0.12.0-beta.1').includes('SHA256SUMS.txt'));
  assert.equal(requiredAssets('0.11.4-beta.1').length, 4);
  assert.equal(requiredAssets('0.12.0').length, 5);
  assert.equal(requiredAssets('0.11.3').length, 4);
  assert.equal(requiredAssets('1.0.0-rc.1').length, 5);
});

test('0.12.0-beta.1 published with four assets -> recover (missing SHA256SUMS.txt)', () => {
  const r = decide({ version: '0.12.0-beta.1', tags: ['v0.12.0-beta.1'], release: { isDraft: false, assets: four() }, changelog: CHANGELOG.replace('0.11.0-beta.1', '0.12.0-beta.1') });
  assert.equal(r.action, 'recover');
});

test('0.12.0 with five assets -> skip', () => {
  const r = decide({ version: '0.12.0', tags: ['v0.12.0'], release: { isDraft: false, assets: allAssets() }, changelog: '' });
  assert.equal(r.action, 'skip');
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

test('## v<V> heading with no notes under it -> fail (create and recover)', () => {
  const empty = '# Changelog\n\n## v0.11.1 - 2026-10-08\n\n\n## v0.11.0 - 2026-10-07\n\n- Older.\n';
  const wantErr = (e) => e instanceof GateError && /heading for v0\.11\.1 but no notes under it/.test(e.message);
  assert.throws(() => decide({ version: '0.11.1', tags: [], release: null, changelog: empty }), wantErr);
  assert.throws(() => decide({ version: '0.11.1', tags: [], release: { isDraft: true, assets: [] }, changelog: empty }), wantErr);
  // A heading that is the last line of the file is empty too.
  assert.throws(() => decide({ version: '0.11.1', tags: [], release: null, changelog: '## v0.11.1' }), wantErr);
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
