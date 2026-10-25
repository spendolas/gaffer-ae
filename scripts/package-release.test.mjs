// Run from the repo root: node --test scripts/package-release.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const stub = join(repoRoot, 'scripts/test-fixtures/stub-bundle.sh');
const build = (outDir, extraEnv = {}) =>
  execFileSync('bash', ['scripts/package-release.sh', '9.9.9', 'deadbeefcafe', outDir], {
    cwd: repoRoot, stdio: 'pipe', env: { ...process.env, GAFFER_BUNDLE_SCRIPT: stub, ...extraEnv },
  });
const out = mkdtempSync(join(tmpdir(), 'gaffer-pkg-'));
build(out);
const macList = () => execFileSync('tar', ['-tzf', join(out, 'gaffer-update-mac.tar.gz')], { encoding: 'utf8' }).split('\n').filter(Boolean);
const winList = () => execFileSync('unzip', ['-Z1', join(out, 'gaffer-update-win.zip')], { encoding: 'utf8' }).split('\n').filter(Boolean);
const macFile = (p) => execFileSync('tar', ['-xzOf', join(out, 'gaffer-update-mac.tar.gz'), './' + p], { encoding: 'utf8' });

test('builds the four release assets plus SHA256SUMS.txt', () => {
  assert.deepEqual(readdirSync(out).sort(), [
    'SHA256SUMS.txt',
    'gaffer-install-mac.tar.gz',
    'gaffer-install-win.zip',
    'gaffer-update-mac.tar.gz',
    'gaffer-update-win.zip',
  ]);
});

test('SHA256SUMS.txt lists each archive with its real digest (sha256sum format)', () => {
  const lines = readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})  (gaffer-[a-z]+-(?:mac\.tar\.gz|win\.zip))$/);
    assert.ok(m, 'bad line: ' + line);
    assert.equal(createHash('sha256').update(readFileSync(join(out, m[2]))).digest('hex'), m[1]);
  }
});

test('install and update assets are byte-identical per OS', () => {
  assert.ok(readFileSync(join(out, 'gaffer-install-mac.tar.gz')).equals(readFileSync(join(out, 'gaffer-update-mac.tar.gz'))));
  assert.ok(readFileSync(join(out, 'gaffer-install-win.zip')).equals(readFileSync(join(out, 'gaffer-update-win.zip'))));
});

test('mac archive has panel/ contents at its root, not under gaffer-ae-main/panel', () => {
  const list = macList();
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

// The daemon's unit tests and fixtures are tracked under panel/ but are not
// part of the product: no archive ships them.
const isTestPath = (p) => /^(\.\/)?daemon\/(test|test-fixtures)(\/|$)/.test(p) || /\.test\.mjs$/.test(p);
for (const name of ['gaffer-install-mac.tar.gz', 'gaffer-update-mac.tar.gz']) {
  test(name + ' ships no daemon/test or daemon/test-fixtures paths', () => {
    const list = execFileSync('tar', ['-tzf', join(out, name)], { encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.deepEqual(list.filter(isTestPath), []);
    assert.ok(list.includes('./daemon/index.js'));
    assert.ok(list.includes('./daemon/daemon.mjs'));
  });
}
for (const name of ['gaffer-install-win.zip', 'gaffer-update-win.zip']) {
  test(name + ' ships no daemon/test or daemon/test-fixtures paths', () => {
    const list = execFileSync('unzip', ['-Z1', join(out, name)], { encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.deepEqual(list.filter(isTestPath), []);
    assert.ok(list.includes('daemon/index.js'));
    assert.ok(list.includes('daemon/daemon.mjs'));
  });
}

test('packaged version.json has exactly version and commit', () => {
  const json = execFileSync('tar', ['-xzOf', join(out, 'gaffer-update-mac.tar.gz'), './version.json'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(json), { version: '9.9.9', commit: 'deadbeefcafe' });
  const zipJson = execFileSync('unzip', ['-p', join(out, 'gaffer-update-win.zip'), 'version.json'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(zipJson), { version: '9.9.9', commit: 'deadbeefcafe' });
});

// ---- zero-dependency layout (spec section 10) ----
const layoutChecks = (list, prefix) => {
  const has = (p) => list.includes(prefix + p);
  assert.ok(has('daemon/daemon.mjs'));
  assert.ok(has('THIRD-PARTY-NOTICES.txt'));
  assert.ok(has('daemon/runtime-pins.json'));
  for (const kept of ['daemon/start.sh', 'daemon/start.ps1', 'daemon/update.sh', 'daemon/update.ps1', 'daemon/stop-daemon.ps1']) {
    assert.ok(has(kept), 'kept: ' + kept);
  }
  assert.ok(!list.some((p) => /node_modules/.test(p)), 'no node_modules');
  assert.ok(!list.some((p) => /\.map$/.test(p)), 'no .map');
  assert.ok(!list.some((p) => /package-lock\.json$/.test(p)), 'no lockfile');
  assert.ok(!list.some((p) => /(^|\/)\.remember(\/|$)/.test(p)), 'no .remember');
  assert.ok(!list.some((p) => /(^|\/)test(-fixtures)?(\/|$)/.test(p)), 'no test dirs');
  const daemonCode = list.filter((p) => p.startsWith(prefix + 'daemon/') && /\.(js|mjs|cjs)$/.test(p)).map((p) => p.slice((prefix + 'daemon/').length));
  const allowed = ['daemon.mjs', 'index.js', 'launch.cjs'];
  assert.deepEqual(daemonCode.filter((p) => !allowed.includes(p)), [], 'only daemon.mjs, index.js, launch.cjs');
};
test('mac archive layout: bundle, notices, no source modules, no dev leftovers', () => layoutChecks(macList(), './'));
test('win archive layout: bundle, notices, no source modules, no dev leftovers', () => layoutChecks(winList(), ''));

test('daemon/index.js is the one-line shim a 0.11.x updater still accepts', () => {
  assert.equal(macFile('daemon/index.js'), "import './daemon.mjs';\n");
});

test('daemon/package.json is dependency free', () => {
  const pj = JSON.parse(macFile('daemon/package.json'));
  assert.deepEqual(pj, { name: 'gaffer-daemon', private: true, type: 'module' });
});

test('runtime-pins.json inside the archive is the committed one', () => {
  const pins = JSON.parse(macFile('daemon/runtime-pins.json'));
  assert.equal(pins.node.version, 'v24.22.1');
});

// A bundle step that leaves a forbidden file behind must fail the build.
for (const extra of ['daemon/daemon.mjs.map', 'daemon/node_modules/x/index.js', 'daemon/package-lock.json', 'daemon/extra-module.js']) {
  test('assertion fires when the bundle step leaves ' + extra, () => {
    const bad = mkdtempSync(join(tmpdir(), 'gaffer-pkg-bad-'));
    assert.throws(() => build(bad, { STUB_EXTRA: extra }));
    assert.ok(!readdirSync(bad).some((n) => n.startsWith('gaffer-install')), 'no archives written on failure');
  });
}
