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

// readUpdateLogSince's slice logic, with an injected fs-like object:
// statSync(path) -> { size }, openSync/readSync/closeSync as in node:fs.
function fakeFs(content, { statError, readError } = {}) {
  const buf = Buffer.from(content, 'utf8');
  const calls = { closed: 0 };
  return {
    calls,
    statSync() { if (statError) throw statError; return { size: buf.length }; },
    openSync() { if (readError) throw readError; return 7; },
    readSync(fd, out, off, len, pos) { return buf.copy(out, off, pos, pos + len); },
    closeSync() { calls.closed++; },
  };
}
const alloc = (n) => Buffer.alloc(n);

test('readUpdateLogSlice: only what the log gained since the start offset', () => {
  const fs = fakeFs('old run\nok:0.11.0\n=== new ===\nerr:runtime\n');
  assert.equal(U.readUpdateLogSlice(fs, '/x.log', 'old run\nok:0.11.0\n'.length, alloc), '=== new ===\nerr:runtime\n');
  assert.equal(fs.calls.closed, 1, 'the file is closed');
  assert.equal(U.readUpdateLogSlice(fakeFs('abc'), '/x.log', 3, alloc), '', 'nothing new yet');
});

test('readUpdateLogSlice: a log shorter than the offset (replaced) is read from its start', () => {
  assert.equal(U.readUpdateLogSlice(fakeFs('ok:0.12.0\n'), '/x.log', 5000, alloc), 'ok:0.12.0\n');
});

test('readUpdateLogSlice: at most the last 64 KB', () => {
  const big = 'x'.repeat(100000) + '\nok:0.12.0\n';
  const out = U.readUpdateLogSlice(fakeFs(big), '/x.log', 0, alloc);
  assert.equal(out.length, 65536);
  assert.ok(out.endsWith('\nok:0.12.0\n'));
});

test('readUpdateLogSlice: no log file yet is empty, any other failure is unreadable (null)', () => {
  const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
  const eacces = Object.assign(new Error('nope'), { code: 'EACCES' });
  assert.equal(U.readUpdateLogSlice(fakeFs('', { statError: enoent }), '/x.log', 0, alloc), '');
  assert.equal(U.readUpdateLogSlice(fakeFs('', { statError: eacces }), '/x.log', 0, alloc), null);
  assert.equal(U.readUpdateLogSlice(fakeFs('ok:1.0.0\n', { readError: eacces }), '/x.log', 0, alloc), null);
  assert.equal(U.readUpdateLogSlice(null, '/x.log', 0, alloc), null);
  assert.equal(U.readUpdateLogSlice(fakeFs('a'), null, 0, alloc), null);
});

test('updateFailureText err:runtime-swap: the install may be unfinished, points at Repair, no dashes', () => {
  const log = '/var/folders/x/T/gaffer-update.log';
  const u = plain(U.updateFailureText('update', 'runtime-swap', log));
  assert.equal(u.banner, 'Update did not complete');
  assert.equal(u.notice, 'Update did not complete. Your Gaffer folder may be in an unfinished state. Open Settings and click Repair, or reinstall.');
  const r = plain(U.updateFailureText('repair', 'runtime-swap', log));
  assert.equal(r.banner, 'Repair did not complete');
  assert.equal(r.notice, 'Repair did not complete. Your Gaffer folder may be in an unfinished state. Open Settings and click Repair, or reinstall.');
  assert.ok(!/[–—]/.test(u.notice + r.notice));
  assert.ok(!/still works/.test(u.notice + r.notice), 'never claims the current version still works');
});

test('failureNeedsRepair: only err:runtime-swap leaves the install needing a Repair', () => {
  assert.equal(U.failureNeedsRepair('runtime-swap'), true);
  for (const c of ['runtime', 'download', 'sync', 'lock', 'dev-install', null, undefined]) assert.equal(U.failureNeedsRepair(c), false, String(c));
});

test('updateWaitStep: err:runtime-swap fails at once with its own code', () => {
  assert.deepEqual(plain(U.updateWaitStep({ mode: 'update', startVersion: '0.12.0', diskJson: '{"version":"0.12.0"}', logText: 'ERROR: x\nerr:runtime-swap\n', exited: true })),
    { action: 'fail', code: 'runtime-swap' });
});

test('updateFailureText err:archive: the download was not a Gaffer release, own text per mode, no dashes', () => {
  const log = '/var/folders/x/T/gaffer-update.log';
  const u = plain(U.updateFailureText('update', 'archive', log));
  assert.equal(u.banner, 'Update failed');
  assert.equal(u.notice, 'Update failed: the downloaded update was not a valid Gaffer release. Your current version still works.');
  const r = plain(U.updateFailureText('repair', 'archive', log));
  assert.equal(r.banner, 'Repair failed');
  assert.equal(r.notice, 'Repair failed: the downloaded update was not a valid Gaffer release. Open the updater log for details, or reinstall.');
  assert.ok(!/[–—]/.test(u.notice + u.banner + r.notice + r.banner));
  assert.equal(U.failureNeedsRepair('archive'), false, 'nothing was changed, no Repair needed');
});

test('updateFailureText err:internal (the updaters\' catch-all) gets the generic text naming the log', () => {
  const log = '/var/folders/x/T/gaffer-update.log';
  assert.deepEqual(plain(U.updateFailureText('update', 'internal', log)), { banner: 'Update did not complete', notice: 'Update did not complete. The updater log has details: ' + log + '.' });
  assert.deepEqual(plain(U.updateFailureText('repair', 'internal', log)), { banner: 'Repair did not complete', notice: 'Repair did not complete. The updater log has details: ' + log + '.' });
  assert.equal(U.failureNeedsRepair('internal'), false);
});

test('updateWaitStep: err:archive and err:internal fail at once with their code', () => {
  for (const code of ['archive', 'internal']) {
    assert.deepEqual(plain(U.updateWaitStep({ mode: 'repair', startVersion: '0.12.0', diskJson: '{"version":"0.12.0"}', logText: 'ERROR: x\nerr:' + code + '\n', exited: false })),
      { action: 'fail', code });
  }
});

// A stuck updater taken over by a newer one (update.sh stop_lock_holder
// TERMs it) prints err:stopped into the shared log while the taker carries
// on: that must not end the wait, the taker's result follows.
test('updateWaitStep: err:stopped followed by the taker\'s ok: later in the slice reloads', () => {
  const log = 'ERROR: the updater was stopped by SIGTERM before it reported a result\nerr:stopped\nStopping an update...\nok:0.12.1\n';
  assert.deepEqual(plain(U.updateWaitStep({ mode: 'update', startVersion: '0.12.0', diskJson: '{"version":"0.12.0"}', logText: log, exited: true })), { action: 'reload' });
});

test('updateWaitStep: err:stopped alone keeps waiting while an updater is alive (the give-up not reached)', () => {
  const log = 'ERROR: the updater was stopped by SIGTERM before it reported a result\nerr:stopped\n';
  for (const mode of ['update', 'repair']) {
    for (const exited of [true, false]) {
      assert.deepEqual(plain(U.updateWaitStep({ mode, startVersion: '0.12.0', diskJson: '{"version":"0.12.0"}', logText: log, exited, giveUp: false })), { action: 'wait' }, mode + ' exited=' + exited);
    }
  }
  assert.deepEqual(plain(U.updateWaitStep({ mode: 'update', startVersion: '0.12.0', diskJson: '{"version":"0.12.1"}', logText: log, exited: true })), { action: 'reload' }, 'version.json moved: reload');
});

test('updateWaitStep: err:stopped alone at the give-up fails with the generic text', () => {
  const log = 'ERROR: the updater was stopped by SIGTERM before it reported a result\nerr:stopped\n';
  const step = plain(U.updateWaitStep({ mode: 'update', startVersion: '0.12.0', diskJson: '{"version":"0.12.0"}', logText: log, exited: true, giveUp: true }));
  assert.deepEqual(step, { action: 'fail', code: 'stopped' });
  const p = '/var/folders/x/T/gaffer-update.log';
  assert.deepEqual(plain(U.updateFailureText('update', step.code, p)), plain(U.updateFailureText('update', null, p)));
  assert.deepEqual(plain(U.updateFailureText('repair', 'stopped', p)), plain(U.updateFailureText('repair', null, p)));
  assert.equal(U.failureNeedsRepair('stopped'), false);
});

test('updateWaitStep: giveUp does not change any other err: or ok: result', () => {
  assert.deepEqual(plain(U.updateWaitStep({ mode: 'update', startVersion: '0.12.0', diskJson: '{"version":"0.12.0"}', logText: 'ERROR: x\nerr:internal\n', exited: false, giveUp: false })), { action: 'fail', code: 'internal' });
  assert.deepEqual(plain(U.updateWaitStep({ mode: 'update', startVersion: '0.12.0', diskJson: '{"version":"0.12.0"}', logText: 'err:stopped\nERROR: y\nerr:sync\n', exited: false })), { action: 'fail', code: 'sync' }, 'the taker failing is reported');
});

// ---- toasts for an update or repair (live AE test 2026-10-24) ----
// With the daemon down the welcome screen covers the chat, so the chat
// notice and the update banner are invisible; toasts sit above it. One
// toast key ('daemon') is shared by the launch error and the update/repair
// toasts, so each replaces the last instead of stacking.
test('updateToast start: a persistent neutral toast with the run\'s wording, keyed with the launch error', () => {
  assert.deepEqual(plain(U.updateToast('start', 'repair')), { key: 'daemon', type: 'neutral', text: "Repairing Gaffer's runtime...", duration: 0, action: null });
  assert.deepEqual(plain(U.updateToast('start', 'update')), { key: 'daemon', type: 'neutral', text: 'Updating Gaffer...', duration: 0, action: null });
});

test('updateToast ok: a short success toast before the reload', () => {
  const r = plain(U.updateToast('ok', 'repair'));
  assert.equal(r.type, 'success');
  assert.equal(r.text, 'Gaffer is repaired');
  assert.equal(r.key, 'daemon');
  assert.ok(r.duration > 0 && r.duration <= 6000, 'short, not persistent');
  assert.equal(plain(U.updateToast('ok', 'update')).text, 'Gaffer is updated');
  assert.ok(U.RELOAD_AFTER_OK_MS >= 800 && U.RELOAD_AFTER_OK_MS <= 3000, 'the reload waits just long enough to read it');
});

test('updateToast fail: a persistent error toast with exactly the chat notice text; repair failures offer Settings', () => {
  const log = '/var/folders/x/T/gaffer-update.log';
  for (const mode of ['update', 'repair']) {
    for (const code of ['archive', 'runtime', 'runtime-swap', 'internal', 'download', null]) {
      const t = plain(U.updateToast('fail', mode, code, log));
      assert.equal(t.type, 'error');
      assert.equal(t.duration, 0, 'persistent until dismissed');
      assert.equal(t.key, 'daemon');
      assert.equal(t.text, U.updateFailureText(mode, code, log).notice, mode + ' ' + code);
      assert.ok(!/[–—]/.test(t.text));
      assert.equal(t.action, mode === 'repair' || code === 'runtime-swap' ? 'settings' : null, mode + ' ' + code);
    }
  }
  assert.equal(plain(U.updateToast('fail', 'repair', 'archive', log)).text, 'Repair failed: the downloaded update was not a valid Gaffer release. Open the updater log for details, or reinstall.');
  assert.equal(U.updateToast('bogus', 'update'), null);
});

test('launchErrorToast: persistent, same key as the update toasts, Open Settings only when Repair can fix it', () => {
  assert.deepEqual(plain(U.launchErrorToast('runtime-damaged', 'Gaffer\'s runtime is damaged.')), { key: 'daemon', type: 'error', text: "Gaffer's runtime is damaged.", duration: 0, action: 'settings' });
  assert.equal(plain(U.launchErrorToast('no-claude', 'x')).action, null);
  assert.equal(U.launchErrorToast('runtime-blocked', 'x').key, U.updateToast('start', 'repair').key, 'Repair starting replaces the launch error toast');
});
