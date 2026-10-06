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
