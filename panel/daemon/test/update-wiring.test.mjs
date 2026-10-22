// main.js has no unit harness (plain <script>, one big IIFE). These
// text-level checks pin the GitHub Releases update wiring so a later edit
// cannot quietly bring back the commit-keyed check against main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const html = read('../../index.html');
const main = read('../../main.js');
// design/ is not part of the packaged tree; skip the capture assertion there.
const capturePath = '../../../design/scripts/panel-capture.mjs';
const hasDesign = existsSync(fileURLToPath(new URL(capturePath, import.meta.url)));
const capture = hasDesign ? read(capturePath) : '';

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
    'UpdateState.updateWaitStep(', 'UpdateState.updateVerdict(',
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
    if (/Update did not complete|Could not check for updates|Gaffer is up to date|Update available, v|still running|Still updating/.test(line)) {
      assert.ok(!/[–—]/.test(line), 'dash in: ' + line.trim());
    }
  }
});

test('Force stop & retry never launches a second updater next to a live one', () => {
  // Both scripts hold <tmp>/gaffer-update.lock for their run; the panel reads
  // the same lock (pid file, 15 minute takeover age) before forcing.
  const sh = read('../update.sh');
  const ps1 = read('../update.ps1');
  for (const script of [sh, ps1]) {
    assert.ok(script.includes('gaffer-update.lock'), 'updater script has no gaffer-update.lock');
    assert.ok(script.includes('busy:already-running'), 'updater script never reports busy:already-running');
  }
  assert.ok(main.includes("'gaffer-update.lock'") || main.includes('gaffer-update.lock'), 'main.js does not know the lock path');
  assert.ok(main.includes('15 * 60 * 1000'), 'main.js does not apply the 15 minute takeover age');
  const force = main.indexOf('function forceStopAndRetryUpdate()');
  assert.ok(force !== -1, 'no forceStopAndRetryUpdate');
  const body = main.slice(force, main.indexOf('function runUpdate()', force));
  assert.ok(body.indexOf('runningUpdaterPid()') !== -1, 'force path does not check for a running updater');
  assert.ok(body.indexOf('runningUpdaterPid()') < body.indexOf('forceStopDaemonPort('), 'force path kills the daemon port before checking the lock');
  assert.ok(body.includes('waitForUpdatedVersion('), 'force path does not fall back to waiting');
});

test('download timeouts in both updater scripts fit inside the panel give-up', () => {
  const sh = read('../update.sh');
  const ps1 = read('../update.ps1');
  const curl = sh.match(/curl [^\n]*--max-time (\d+)[^\n]*--retry (\d+)[^\n]*--retry-max-time (\d+)/);
  assert.ok(curl, 'update.sh curl line lost its --max-time / --retry / --retry-max-time');
  assert.ok(Number(curl[3]) <= 120, 'curl --retry-max-time exceeds 120s');
  assert.ok(!/--max-time 600/.test(sh));
  const winCurl = ps1.match(/& \$curl [^\n]*--max-time (\d+)[^\n]*--retry (\d+)[^\n]*--retry-max-time (\d+)/);
  assert.ok(winCurl, 'update.ps1 curl.exe line lost its --max-time / --retry / --retry-max-time');
  assert.ok(Number(winCurl[3]) <= 120, 'curl.exe --retry-max-time exceeds 120s');
  // The system-proxy fallback (HttpWebRequest) only starts when curl gave up
  // within 90s and has its own 150s budget, checked BEFORE each body read:
  // a read may block for ReadWriteTimeout, so the last one may only start
  // while that much budget remains. 90 + 150 stays under the curl-only
  // worst case of 270s.
  assert.ok(/\$curlSeconds -ge 90/.test(ps1), 'update.ps1 lost the 90s cut-off for starting the fallback');
  const readCutoff = ps1.match(/TotalSeconds -gt (\d+)\) \{ throw "download exceeded its (\d+)s budget"/);
  assert.ok(readCutoff, 'update.ps1 fallback lost its hard total budget');
  const readTimeout = ps1.match(/\$req\.ReadWriteTimeout = (\d+)/);
  assert.ok(readTimeout, 'update.ps1 fallback lost its per-read stall bound');
  assert.equal(Number(readCutoff[1]) + Number(readTimeout[1]) / 1000, Number(readCutoff[2]), 'the last read may start only while one read timeout of the budget remains');
  assert.ok(90 + Number(readCutoff[2]) <= 270, 'fallback worst case exceeds the curl-only worst case');
  assert.ok(/\$elapsed -ge 110/.test(ps1), 'update.ps1 has no total download deadline');
  assert.ok(main.includes('waited >= 180000'), 'panel give-up moved; re-check the script timeouts against it');
});

test('panel-capture forces the update-available state with a version', { skip: !hasDesign && 'design/ absent (packaged tree)' }, () => {
  assert.ok(capture.includes("setUpdateAvailable('99.0.0')"));
  assert.ok(!capture.includes("setUpdateAvailable('feedface')"));
});

// ---- Task 13: repair path and the updater's result line ----

const fnBody = (name) => {
  const start = main.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'no function ' + name);
  const next = main.indexOf('\n  function ', start + 1);
  return main.slice(start, next === -1 ? undefined : next);
};

test('a refused launch remembers its code and refreshes the Settings button; a new launch clears it', () => {
  const show = fnBody('showLaunchError');
  assert.ok(show.includes('daemonLaunchCode = code'), 'showLaunchError does not keep the code');
  assert.ok(show.includes('syncSettingsUpdateButton()'), 'showLaunchError does not refresh the Settings button');
  assert.ok(fnBody('startDaemon').includes('daemonLaunchCode = null'), 'startDaemon does not clear the code');
});

test('the Settings button follows settingsUpdateAction and reads Repair for a repair', () => {
  const sync = fnBody('syncSettingsUpdateButton');
  assert.ok(sync.includes('UpdateState.settingsUpdateAction('), 'not driven by settingsUpdateAction');
  assert.ok(sync.includes('UpdateState.isRepairableLaunchError(daemonLaunchCode)'));
  assert.ok(sync.includes("'Repair'") && sync.includes("'Update'"), 'no Repair / Update label switch');
});

test('runUpdate passes the repair flag to both updaters on both routes', () => {
  const run = fnBody('runUpdate');
  assert.ok(run.includes("'--repair'"), 'Node route: no --repair for update.sh');
  assert.ok(run.includes("'-Repair'"), 'Node route: no -Repair for update.ps1');
  assert.ok(run.includes(' --repair'), 'ExtendScript route: no --repair for update.sh');
  assert.ok(run.includes(' -Repair'), 'ExtendScript route: no -Repair for update.ps1');
  assert.ok(run.includes('beginUpdateRun('), 'runUpdate does not record the log offset before starting the updater');
  assert.ok(run.indexOf('beginUpdateRun(') < run.indexOf('cp.spawn('), 'the log offset must be taken before the spawn');
  assert.ok(/child\.on\('exit', function \(\) \{ run\.exited = true; \}\)/.test(run), 'the Node route does not mark the updater as exited');
});

test('the wait reads the updater log through updateWaitStep and shows updateFailureText', () => {
  const wait = fnBody('waitForUpdatedVersion');
  assert.ok(wait.includes('UpdateState.updateWaitStep('), 'wait does not use updateWaitStep');
  assert.ok(wait.includes('readUpdateLogSince('), 'wait does not read the updater log');
  assert.ok(wait.includes("step.action === 'fail'"), 'wait ignores err: results');
  assert.ok(fnBody('showUpdateFailure').includes('UpdateState.updateFailureText('));
  assert.ok(!wait.includes('UpdateState.shouldReloadAfterUpdate('), 'the version check now lives in updateWaitStep');
});

test('the panel reads the same log file the updaters write', () => {
  const p = fnBody('updaterLogPath');
  assert.ok(p.includes("'\\\\gaffer-update.log'") && p.includes('process.env.TEMP'), 'Windows path is not %TEMP%\\gaffer-update.log');
  assert.ok(p.includes("'/gaffer-update.log'") && p.includes('process.env.TMPDIR'), 'macOS path is not ${TMPDIR:-/tmp}/gaffer-update.log');
  assert.ok(read('../update.sh').includes('LOG="${TMPDIR:-/tmp}/gaffer-update.log"'));
  assert.ok(read('../update.ps1').includes('$logPath = Join-Path $env:TEMP "gaffer-update.log"'));
});

test('readUpdateLogSince delegates to the pure slice, and the wait also checks the ExtendScript output for a result line', () => {
  assert.ok(fnBody('readUpdateLogSince').includes('UpdateState.readUpdateLogSlice('));
  const wait = fnBody('waitForUpdatedVersion');
  assert.ok(wait.includes('!UpdateState.lastUpdaterResult(logText)') && wait.includes('UpdateState.lastUpdaterResult(run.output)'),
    'a log with no result line must fall back to the callSystem output');
});

test('err:runtime-swap leaves the panel offering Repair (Settings button and the next run)', () => {
  assert.ok(/if \(UpdateState\.failureNeedsRepair\(code\)\) \{\s*updateLeftUnfinished = true;/.test(fnBody('showUpdateFailure')), 'showUpdateFailure does not remember an unfinished install');
  assert.ok(fnBody('syncSettingsUpdateButton').includes('UpdateState.isRepairableLaunchError(daemonLaunchCode) || updateLeftUnfinished'));
  assert.ok(fnBody('updateRunPlan').includes('UpdateState.isRepairableLaunchError(daemonLaunchCode) || updateLeftUnfinished'));
});
