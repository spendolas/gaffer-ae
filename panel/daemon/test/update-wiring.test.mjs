// main.js has no unit harness (plain <script>, one big IIFE). These
// text-level checks pin the GitHub Releases update wiring so a later edit
// cannot quietly bring back the commit-keyed check against main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const html = read('../../index.html');
const main = read('../../main.js');
const capture = read('../../../design/scripts/panel-capture.mjs');

test('index.html loads update-state.js before main.js', () => {
  const state = html.indexOf('<script src="update-state.js"></script>');
  const mainTag = html.indexOf('<script src="main.js"></script>');
  assert.ok(state !== -1, 'no <script src="update-state.js"> tag');
  assert.ok(mainTag !== -1, 'no <script src="main.js"> tag');
  assert.ok(state < mainTag, 'update-state.js must load before main.js');
});

test('main.js no longer keys update state on the commit', () => {
  for (const gone of ['availableUpdateCommit', 'dismissedUpdateCommit', 'startCommit',
    'raw.githubusercontent.com/spendolas/gaffer-ae/main/panel/version.json', 'function isNewerVersion']) {
    assert.ok(!main.includes(gone), 'main.js still contains ' + gone);
  }
});

test('main.js checks the latest GitHub release through GafferUpdateState', () => {
  for (const needed of ['window.GafferUpdateState',
    "'https://api.github.com/repos/spendolas/gaffer-ae/releases/latest'",
    "'gafferReleaseCache'", "'If-None-Match'", "'application/vnd.github+json'",
    'UpdateState.readReleaseResponse(', 'UpdateState.decideUpdate(',
    'UpdateState.shouldReloadAfterUpdate(', 'UpdateState.updateVerdict(',
    'dismissedUpdateVersion: dismissedUpdateVersion']) {
    assert.ok(main.includes(needed), 'main.js is missing ' + needed);
  }
});

test('rate limits and missing releases show the neutral message, never "Update check failed"', () => {
  assert.ok(main.includes("'Could not check for updates right now, try again later.'"));
  const noInfo = main.match(/if \(out\.kind === 'no-info'\) \{([\s\S]*?)\n        \}/);
  assert.ok(noInfo, 'no no-info branch in checkForUpdate');
  assert.ok(!noInfo[1].includes('markUpdateChecked'), 'no-info must not record a check');
  assert.ok(!noInfo[1].includes('Update check failed'));
});

test('a failed check that sent If-None-Match clears the release cache (refusal is never sticky)', () => {
  const failed = main.indexOf("'Update check failed: '");
  assert.ok(failed !== -1, 'no "Update check failed" message in main.js');
  const catchStart = main.lastIndexOf('.catch(function (e) {', failed);
  assert.ok(catchStart !== -1, 'no .catch before the failure message');
  const block = main.slice(catchStart, failed);
  assert.ok(block.includes("headers['If-None-Match']"), '.catch does not look at the If-None-Match header');
  assert.ok(block.includes('localStorage.removeItem(RELEASE_CACHE_KEY)'), '.catch does not clear the release cache');
  assert.match(block, /try \{ localStorage\.removeItem\(RELEASE_CACHE_KEY\); \} catch/, 'cache removal is not wrapped in try/catch');
});

test('update copy in main.js has no em or en dashes', () => {
  for (const line of main.split('\n')) {
    if (/Update did not complete|Could not check for updates|Gaffer is up to date|Update available, v/.test(line)) {
      assert.ok(!/[–—]/.test(line), 'dash in: ' + line.trim());
    }
  }
});

test('panel-capture forces the update-available state with a version', () => {
  assert.ok(capture.includes("setUpdateAvailable('99.0.0')"));
  assert.ok(!capture.includes("setUpdateAvailable('feedface')"));
});
