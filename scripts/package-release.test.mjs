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
