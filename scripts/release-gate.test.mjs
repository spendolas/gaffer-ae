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
