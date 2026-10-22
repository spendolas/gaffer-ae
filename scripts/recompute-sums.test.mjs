// Run from the repo root: node --test scripts/recompute-sums.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'recompute-sums.sh');
const ARCHIVES = ['gaffer-install-mac.tar.gz', 'gaffer-install-win.zip', 'gaffer-update-mac.tar.gz', 'gaffer-update-win.zip'];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-sums-'));
  ARCHIVES.forEach((n, i) => writeFileSync(join(dir, n), 'archive ' + i + ' ' + n + '\n'));
  return dir;
}
const run = (dir) => spawnSync('bash', [script, dir], { encoding: 'utf8' });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

test('writes "<sha256>  <name>" for the four archives, in package-release.sh order', () => {
  const dir = fixture();
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    const want = ARCHIVES.map((n) => sha(join(dir, n)) + '  ' + n).join('\n') + '\n';
    assert.equal(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8'), want);
    assert.ok(!existsSync(join(dir, 'SHA256SUMS.txt.tmp')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replaces a stale SHA256SUMS.txt with hashes of the archives as they are now', () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, 'SHA256SUMS.txt'), '0'.repeat(64) + '  gaffer-install-mac.tar.gz\n');
    writeFileSync(join(dir, 'gaffer-update-win.zip'), 'rebuilt, different bytes\n');
    assert.equal(run(dir).status, 0);
    const lines = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[3], sha(join(dir, 'gaffer-update-win.zip')) + '  gaffer-update-win.zip');
    assert.ok(!lines.some((l) => l.startsWith('0'.repeat(64))));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('is shasum -c compatible', () => {
  const dir = fixture();
  try {
    assert.equal(run(dir).status, 0);
    const c = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS.txt'], { cwd: dir, encoding: 'utf8' });
    assert.equal(c.status, 0, c.stdout + c.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing or empty archive fails and leaves no sums file', () => {
  for (const damage of ['missing', 'empty']) {
    const dir = fixture();
    try {
      const p = join(dir, 'gaffer-install-win.zip');
      if (damage === 'missing') rmSync(p); else writeFileSync(p, '');
      const r = run(dir);
      assert.notEqual(r.status, 0, damage);
      assert.match(r.stderr, /missing or empty archive: gaffer-install-win\.zip/);
      assert.ok(!existsSync(join(dir, 'SHA256SUMS.txt')), damage);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('no argument or a non-directory is a usage error', () => {
  assert.equal(spawnSync('bash', [script], { encoding: 'utf8' }).status, 2);
  assert.equal(run(join(tmpdir(), 'gaffer-sums-does-not-exist')).status, 2);
});

test('uses the same archive list and order as package-release.sh', () => {
  const pkg = readFileSync(join(here, 'package-release.sh'), 'utf8');
  assert.ok(pkg.includes('shasum -a 256 ' + ARCHIVES.join(' ') + ' > SHA256SUMS.txt'), 'package-release.sh sums line changed; update recompute-sums.sh to match');
  const src = readFileSync(script, 'utf8');
  assert.ok(src.includes('ARCHIVES=(' + ARCHIVES.join(' ') + ')'));
});

test('release.yml recovers a published release by recomputing SHA256SUMS.txt over the final assets', () => {
  const wf = readFileSync(join(here, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const publish = wf.split('\n  publish:\n')[1];
  assert.ok(publish, 'publish job not found');
  // A dry run never reaches the publish job.
  assert.match(publish, /&& \(github\.event_name == 'push' \|\| inputs\.dry_run == false\)/);
  const published = publish.split('# Published release:')[1].split('\n            fi\n')[0];
  assert.ok(published, 'published-release branch not found');
  assert.match(published, /if \[ "\$n" = "SHA256SUMS\.txt" \]; then\s*continue/, 'the build\'s sums file must not be uploaded');
  const up = published.indexOf('gh release upload "v$V" "$f"');
  const dl = published.indexOf('gh release download "v$V" --dir "$FINAL"');
  const re = published.indexOf('bash scripts/recompute-sums.sh "$FINAL"');
  const clob = published.indexOf('gh release upload "v$V" "$FINAL/SHA256SUMS.txt" --clobber');
  assert.ok(up !== -1 && dl > up && re > dl && clob > re, 'order must be: upload missing, download final, recompute, upload sums --clobber');
  for (const a of ARCHIVES) assert.ok(published.includes('-p ' + a), 'final download misses ' + a);
  // Only the sums file is ever clobbered on a published release.
  assert.equal((published.match(/--clobber/g) || []).length, 1);
  assert.ok(wf.includes('scripts/recompute-sums.test.mjs'), 'release.yml does not run this test');
});
