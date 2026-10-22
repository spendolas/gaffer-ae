// Pure update-check logic for the panel, kept out of main.js so it can be
// unit tested (panel/daemon/test/update-state.test.mjs loads this file into
// node:vm with a stub window). Plain ES5, no DOM, no network, no storage.
// Loaded by a <script> tag in index.html BEFORE main.js.
(function (root) {
  'use strict';

  var UPDATE_ASSETS = { mac: 'gaffer-update-mac.tar.gz', win: 'gaffer-update-win.zip' };
  var ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
  var VERSION_LIKE = /^\d+\.\d+\.\d+/;

  // True only when remoteVer is a STRICTLY newer semver than localVer. The update
  // banner must gate on this, not on a bare commit mismatch: a differing commit
  // can be an equal or OLDER release, and offering that as an "update" prompts a
  // downgrade (seen: a 0.10.0 install told to "update" to 0.9.9). Missing/garbled
  // versions compare as not-newer, so a bad remote never nags.
  function isNewerVersion(remoteVer, localVer) {
    function parts(v) { return String(v == null ? '' : v).split('.').map(function (n) { return parseInt(n, 10) || 0; }); }
    var r = parts(remoteVer), l = parts(localVer);
    for (var i = 0; i < Math.max(r.length, l.length); i++) {
      var a = r[i] || 0, b = l[i] || 0;
      if (a !== b) return a > b;
    }
    return false;
  }

  // GitHub "latest release" JSON -> { version, commit, hasAsset }, or null
  // when the payload has no usable tag. os is 'mac' or 'win'; hasAsset says
  // whether THIS platform's update asset is attached.
  function parseRelease(json, os) {
    if (!json || typeof json.tag_name !== 'string' || !json.tag_name) return null;
    var wanted = UPDATE_ASSETS[os];
    var assets = json.assets && json.assets.length ? json.assets : [];
    var hasAsset = false;
    for (var i = 0; i < assets.length; i++) {
      if (assets[i] && assets[i].name === wanted) { hasAsset = true; break; }
    }
    return {
      version: json.tag_name.replace(/^v/, ''),
      commit: typeof json.target_commitish === 'string' ? json.target_commitish : null,
      hasAsset: hasAsset
    };
  }

  // localStorage gafferReleaseCache string -> { etag, version, commit, hasAsset }
  // or null when absent, unparseable or missing the etag/version.
  function parseReleaseCache(raw) {
    if (!raw) return null;
    var c;
    try { c = JSON.parse(raw); } catch (e) { return null; }
    if (!c || typeof c.etag !== 'string' || !c.etag || typeof c.version !== 'string' || !c.version) return null;
    return { etag: c.etag, version: c.version, commit: typeof c.commit === 'string' ? c.commit : null, hasAsset: c.hasAsset === true };
  }

  // One fetch of releases/latest -> what main.js should do next.
  //   { kind: 'release', release: {version, commit, hasAsset}, cache: <obj or null> }
  //   { kind: 'no-info' }   403 / 429 / 404 / 304-without-cache: change nothing, say nothing alarming
  //   { kind: 'error', message }
  // cache in the result is what to store under gafferReleaseCache (null = leave as is).
  function readReleaseResponse(status, json, etag, cache, os) {
    if (status === 304) {
      if (!cache) return { kind: 'no-info' };
      return { kind: 'release', release: { version: cache.version, commit: cache.commit, hasAsset: cache.hasAsset }, cache: null };
    }
    if (status === 403 || status === 429 || status === 404) return { kind: 'no-info' };
    if (status !== 200) return { kind: 'error', message: 'HTTP ' + status };
    var release = parseRelease(json, os);
    if (!release) return { kind: 'error', message: 'Invalid release response' };
    var nextCache = etag
      ? { etag: etag, version: release.version, commit: release.commit, hasAsset: release.hasAsset }
      : null;
    return { kind: 'release', release: release, cache: nextCache };
  }

  // remote: parsed release (or null). local: versionData.version.
  // dismissed: the version whose banner the user dismissed (or null).
  //   state 'local-unknown' | 'up-to-date' | 'available'; showBanner only when available and not dismissed.
  function decideUpdate(remote, local, dismissed) {
    if (!local || !VERSION_LIKE.test(String(local))) return { state: 'local-unknown', showBanner: false };
    if (!remote || !remote.hasAsset || !isNewerVersion(remote.version, local)) {
      return { state: 'up-to-date', showBanner: false };
    }
    return { state: 'available', showBanner: remote.version !== dismissed };
  }

  // Poll check during an update: reload only once the on-disk version.json
  // parses and carries a version different from the one we started on.
  function shouldReloadAfterUpdate(startVersion, diskJson) {
    var v;
    try { v = JSON.parse(diskJson).version; } catch (e) { return false; }
    if (typeof v !== 'string' || !v) return false;
    return v !== startVersion;
  }

  // Post-reload verdict for localStorage gafferUpdateAttempt { target, at }.
  //   'none'   no attempt recorded
  //   'stale'  too old, or written by a pre-0.11 panel (target is a commit): clear silently
  //   'ok'     the local version reached the target (or went past it)
  //   'failed' the target is still newer than the local version
  function updateVerdict(attempt, localVersion, now) {
    if (!attempt) return 'none';
    if (!attempt.target || typeof attempt.at !== 'number' || now - attempt.at >= ATTEMPT_WINDOW_MS) return 'stale';
    if (!VERSION_LIKE.test(String(attempt.target))) return 'stale';
    return isNewerVersion(attempt.target, localVersion) ? 'failed' : 'ok';
  }

  // ---- Repair mode and the updater's result line ----
  // Launch notices (daemon-launch.js) that send the user to Settings, plus the
  // Gatekeeper block: a repair (updater --repair / -Repair) re-downloads the
  // runtime into a fresh folder and re-syncs the release's files, which is
  // what each of these needs.
  var REPAIRABLE = ['runtime-damaged', 'runtime-missing', 'runtime-blocked', 'launch-failed'];
  function isRepairableLaunchError(code) {
    return typeof code === 'string' && REPAIRABLE.indexOf(code) !== -1;
  }

  // What the Settings Update button offers. o = { available, repairable,
  // updating, dev }. 'update' when a newer release is confirmed (a repair
  // rides along with it), 'repair' when only the launch needs one, null to
  // hide. A dev install never repairs (runUpdate refuses it anyway).
  function settingsUpdateAction(o) {
    o = o || {};
    if (o.updating) return null;
    if (o.available) return 'update';
    if (o.repairable && !o.dev) return 'repair';
    return null;
  }

  // The updater's result lines (update.sh / update.ps1 last-line contract):
  // ok:<version>, err:<code>, busy:already-running. text is what the updater
  // log gained since this run started. Returns the LAST one as
  // { kind: 'ok', version } | { kind: 'err', code } | { kind: 'busy' }, or
  // null. Tolerates a PowerShell transcript: CRLF, a BOM, UTF-16 bytes read
  // as UTF-8 (NULs) and the footer written after the result line.
  var RESULT_LINE = /^(?:ok:(\S+)|err:([a-z][a-z0-9-]*)|(busy:already-running))$/;
  function lastUpdaterResult(text) {
    if (typeof text !== 'string' || !text) return null;
    var lines = text.replace(/\u0000/g, '').replace(/﻿/g, '').split(/\r\n|\r|\n/);
    for (var i = lines.length - 1; i >= 0; i--) {
      var m = RESULT_LINE.exec(lines[i].replace(/^\s+|\s+$/g, ''));
      if (!m) continue;
      if (m[1]) return { kind: 'ok', version: m[1] };
      if (m[2]) return { kind: 'err', code: m[2] };
      return { kind: 'busy' };
    }
    return null;
  }

  // One poll while an update or repair runs. o = { mode: 'update'|'repair',
  // startVersion, diskJson (version.json as read), logText (log gained since
  // the start, or null when the panel cannot read it), exited (the updater
  // the panel started has exited) }. Returns { action: 'reload' } |
  // { action: 'fail', code } | { action: 'wait' }.
  //   err:<code>  fail at once (never reload on a failure)
  //   ok:<v>      reload (a repair keeps the version, so this is its signal)
  //   version.json moved: reload (no readable log, the pre-0.12 signal)
  //   busy        wait: another updater runs, its result lands in the same log
  //   exited with a readable log and no result line: fail, no code
  //   exited, log unreadable: a repair reloads (the fresh panel re-checks the
  //   runtime), an update keeps waiting for the version or the give-up
  function updateWaitStep(o) {
    var r = lastUpdaterResult(o.logText);
    if (r && r.kind === 'err') return { action: 'fail', code: r.code };
    if (r && r.kind === 'ok') return { action: 'reload' };
    if (shouldReloadAfterUpdate(o.startVersion, o.diskJson)) return { action: 'reload' };
    if (r && r.kind === 'busy') return { action: 'wait' };
    if (o.exited) {
      if (typeof o.logText === 'string') return { action: 'fail', code: null };
      if (o.mode === 'repair') return { action: 'reload' };
    }
    return { action: 'wait' };
  }

  // Banner and chat-notice text for a failed update or repair. err:runtime
  // has its own text (spec Failure modes, "Both sources unreachable /
  // update"); every other code, or none, gets the generic text naming the
  // updater log (logPath when known, else both platforms' usual place).
  function updateFailureText(mode, code, logPath) {
    var repair = mode === 'repair';
    if (code === 'runtime') {
      return repair
        ? { banner: 'Repair failed', notice: "Repair failed: could not download Gaffer's runtime. Check your network and try again." }
        : { banner: 'Update failed', notice: "Update failed: could not download Gaffer's runtime. Your current version still works." };
    }
    var where = logPath ? logPath : '%TEMP%\\gaffer-update.log (Windows) / /tmp/gaffer-update.log (macOS)';
    var head = repair ? 'Repair did not complete' : 'Update did not complete';
    return { banner: head, notice: head + '. The updater log has details: ' + where + '.' };
  }

  root.GafferUpdateState = {
    UPDATE_ASSETS: UPDATE_ASSETS,
    isRepairableLaunchError: isRepairableLaunchError,
    settingsUpdateAction: settingsUpdateAction,
    lastUpdaterResult: lastUpdaterResult,
    updateWaitStep: updateWaitStep,
    updateFailureText: updateFailureText,
    isNewerVersion: isNewerVersion,
    parseRelease: parseRelease,
    parseReleaseCache: parseReleaseCache,
    readReleaseResponse: readReleaseResponse,
    decideUpdate: decideUpdate,
    shouldReloadAfterUpdate: shouldReloadAfterUpdate,
    updateVerdict: updateVerdict
  };
})(window);
