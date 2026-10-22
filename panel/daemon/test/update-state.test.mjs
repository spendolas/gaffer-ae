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

// ---- Repair mode and the updater's result line (Task 13) ----

test('exposes the repair and result-line API', () => {
  for (const fn of ['isRepairableLaunchError', 'settingsUpdateAction', 'lastUpdaterResult',
    'updateWaitStep', 'updateFailureText']) {
    assert.equal(typeof U[fn], 'function', fn);
  }
});

test('isRepairableLaunchError: the launch notices that point at Settings, plus the Gatekeeper block', () => {
  for (const c of ['runtime-damaged', 'runtime-missing', 'runtime-blocked', 'launch-failed']) {
    assert.equal(U.isRepairableLaunchError(c), true, c);
  }
  for (const c of [null, undefined, '', 'launch-usage', 'something-else']) {
    assert.equal(U.isRepairableLaunchError(c), false, String(c));
  }
});

test('settingsUpdateAction: Update when a newer release exists, Repair when only the runtime needs it, nothing while updating or on a dev install', () => {
  const base = { available: false, repairable: false, updating: false, dev: false };
  assert.equal(U.settingsUpdateAction(base), null);
  assert.equal(U.settingsUpdateAction({ ...base, available: true }), 'update');
  assert.equal(U.settingsUpdateAction({ ...base, repairable: true }), 'repair');
  // A newer release repairs too (the runtime step re-provisions); the label stays Update.
  assert.equal(U.settingsUpdateAction({ ...base, available: true, repairable: true }), 'update');
  assert.equal(U.settingsUpdateAction({ ...base, available: true, repairable: true, updating: true }), null);
  assert.equal(U.settingsUpdateAction({ ...base, repairable: true, dev: true }), null);
  assert.equal(U.settingsUpdateAction({ ...base, available: true, dev: true }), 'update', 'dev keeps today\'s Update CTA rule (runUpdate explains)');
});

test('lastUpdaterResult: the last ok:, err: or busy: line wins, progress lines and fetch-runtime lines do not count', () => {
  assert.equal(U.lastUpdaterResult(''), null);
  assert.equal(U.lastUpdaterResult(null), null);
  assert.equal(U.lastUpdaterResult('=== Update started ===\nDownloading x\n'), null);
  assert.deepEqual(plain(U.lastUpdaterResult('=== Update started ===\nRelease: v0.12.0\n=== Update complete ===\nok:0.12.0\n')),
    { kind: 'ok', version: '0.12.0' });
  assert.deepEqual(plain(U.lastUpdaterResult('runtime: ERROR: both sources failed\nerr:runtime\nERROR: could not stage\nerr:runtime\n')),
    { kind: 'err', code: 'runtime' });
  assert.deepEqual(plain(U.lastUpdaterResult('Another update is already running (pid 4), leaving it to finish.\nbusy:already-running\n')),
    { kind: 'busy' });
  // A busy run followed by the other updater finishing: its ok: is newer.
  assert.deepEqual(plain(U.lastUpdaterResult('busy:already-running\nReplacing files...\nok:0.12.0\n')),
    { kind: 'ok', version: '0.12.0' });
  // runtime:current / runtime:installed are fetch-runtime progress, not results.
  assert.equal(U.lastUpdaterResult('runtime:current\nruntime:installed v24.1.0 darwin-arm64\n'), null);
  // Not at line start: not a result.
  assert.equal(U.lastUpdaterResult('note: err:runtime is printed on failure\n'), null);
});

test('lastUpdaterResult: Windows transcripts (CRLF, BOM, UTF-16 NULs, footer after the result)', () => {
  const t = '﻿**********************\r\nWindows PowerShell transcript start\r\nok:0.12.0\r\n**********************\r\nWindows PowerShell transcript end\r\nEnd time: 20261022\r\n';
  assert.deepEqual(plain(U.lastUpdaterResult(t)), { kind: 'ok', version: '0.12.0' });
  const utf16ish = 'e\u0000r\u0000r\u0000:\u0000r\u0000u\u0000n\u0000t\u0000i\u0000m\u0000e\u0000\r\u0000\n\u0000';
  assert.deepEqual(plain(U.lastUpdaterResult(utf16ish)), { kind: 'err', code: 'runtime' });
  assert.deepEqual(plain(U.lastUpdaterResult('  err:sync  \r\n')), { kind: 'err', code: 'sync' });
});

test('updateWaitStep: ok reloads, err fails at once, a version change reloads, busy and silence wait', () => {
  const step = (o) => plain(U.updateWaitStep({ mode: 'update', startVersion: '0.11.0', diskJson: '{"version":"0.11.0"}', logText: '', exited: false, ...o }));
  assert.deepEqual(step({}), { action: 'wait' });
  assert.deepEqual(step({ logText: 'ok:0.12.0\n' }), { action: 'reload' });
  assert.deepEqual(step({ logText: 'ERROR: x\nerr:runtime\n' }), { action: 'fail', code: 'runtime' });
  assert.deepEqual(step({ logText: 'ERROR: x\nerr:download\n', exited: true }), { action: 'fail', code: 'download' });
  assert.deepEqual(step({ diskJson: '{"version":"0.12.0"}' }), { action: 'reload' });
  assert.deepEqual(step({ logText: 'busy:already-running\n', exited: true }), { action: 'wait' });
  // Exited with a readable log but no result line (a bare ERROR line, a crash): failed, no code.
  assert.deepEqual(step({ logText: 'ERROR: downloaded archive is not a Gaffer release\n', exited: true }), { action: 'fail', code: null });
  // Log unreadable (no CEP Node): today's behaviour, wait for the version or the give-up.
  assert.deepEqual(step({ logText: null, exited: true }), { action: 'wait' });
  // An err: from the updater wins over a version.json that moved (it cannot, but never reload on a failure).
  assert.deepEqual(step({ logText: 'err:sync\n', diskJson: '{"version":"0.12.0"}' }), { action: 'fail', code: 'sync' });
});

test('updateWaitStep in repair mode: the version never changes, ok: is the signal; an unreadable log reloads once the updater exited', () => {
  const step = (o) => plain(U.updateWaitStep({ mode: 'repair', startVersion: '0.12.0', diskJson: '{"version":"0.12.0"}', logText: '', exited: false, ...o }));
  assert.deepEqual(step({}), { action: 'wait' });
  assert.deepEqual(step({ logText: 'ok:0.12.0\n' }), { action: 'reload' });
  assert.deepEqual(step({ logText: 'err:runtime\n' }), { action: 'fail', code: 'runtime' });
  assert.deepEqual(step({ logText: null, exited: false }), { action: 'wait' });
  assert.deepEqual(step({ logText: null, exited: true }), { action: 'reload' }, 'the reloaded panel re-checks the runtime');
});

test('updateFailureText: the spec text for err:runtime, the generic text with the real log path otherwise, no dashes', () => {
  const log = '/var/folders/x/T/gaffer-update.log';
  const rt = plain(U.updateFailureText('update', 'runtime', log));
  assert.equal(rt.notice, "Update failed: could not download Gaffer's runtime. Your current version still works.");
  assert.equal(rt.banner, 'Update failed');
  for (const code of ['download', 'sync', 'lock', 'dev-install', null]) {
    const g = plain(U.updateFailureText('update', code, log));
    assert.equal(g.banner, 'Update did not complete');
    assert.equal(g.notice, 'Update did not complete. The updater log has details: ' + log + '.');
  }
  const rr = plain(U.updateFailureText('repair', 'runtime', log));
  assert.equal(rr.banner, 'Repair failed');
  assert.equal(rr.notice, "Repair failed: could not download Gaffer's runtime. Check your network and try again.");
  const rg = plain(U.updateFailureText('repair', 'sync', log));
  assert.equal(rg.banner, 'Repair did not complete');
  assert.equal(rg.notice, 'Repair did not complete. The updater log has details: ' + log + '.');
  // Without a known path: today's two-platform hint.
  assert.match(U.updateFailureText('update', 'sync', null).notice, /%TEMP%\\gaffer-update\.log \(Windows\)/);
  for (const mode of ['update', 'repair']) {
    for (const code of ['runtime', 'sync', null]) {
      const t = U.updateFailureText(mode, code, log);
      assert.ok(!/[–—]/.test(t.notice + t.banner), 'dash in ' + mode + ' ' + code);
    }
  }
});
