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

  root.GafferUpdateState = {
    UPDATE_ASSETS: UPDATE_ASSETS,
    isNewerVersion: isNewerVersion,
    parseRelease: parseRelease,
    parseReleaseCache: parseReleaseCache,
    readReleaseResponse: readReleaseResponse,
    decideUpdate: decideUpdate,
    shouldReloadAfterUpdate: shouldReloadAfterUpdate,
    updateVerdict: updateVerdict
  };
})(window);
