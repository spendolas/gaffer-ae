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
