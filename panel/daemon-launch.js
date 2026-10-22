// Pure daemon-launch decisions for the panel (zero-dependency install design,
// spec section 4), kept out of main.js so they can be unit tested
// (panel/daemon/test/daemon-launch.test.mjs loads this file into node:vm with
// a stub window). Plain ES5, no spawn, no require: every filesystem access
// goes through the injected fs, hashing through the injected hashFile.
// Loaded by a <script> tag in index.html BEFORE main.js. main.js keeps the
// side effects (launchDaemon: open the log, cp.spawn).
(function (root) {
  'use strict';

  var REAL_SHA256 = /^[0-9a-f]{64}$/i;
  var PENDING_PIN = 'PENDING-FIRST-ACCEPTANCE-RUN';
  var STRIPPED_ENV = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS'];
  var CA_STASH = 'GAFFER_CLAUDE_EXTRA_CA_CERTS';
  var NOTICES = {
    'runtime-damaged': "Gaffer's runtime is damaged. Open Settings and run Update to repair it, or reinstall.",
    'runtime-missing': "Gaffer's runtime is missing. Open Settings and run Update, or reinstall.",
    'launch-failed': 'Gaffer could not start its daemon. Open Settings and run Update, or reinstall.'
  };

  // CSInterface returns the extension path with forward slashes on Windows
  // ("C:/Users/..."). The daemon's command line and cwd must be one native
  // path, so convert before building anything from it (acceptance case A26).
  // Trailing separators are dropped, except a drive root keeps its one.
  function normalizeWinPath(p) {
    var s = String(p == null ? '' : p).replace(/\//g, '\\');
    s = s.replace(/\\+$/, '');
    if (/^[A-Za-z]:$/.test(s)) s += '\\';
    return s;
  }

  // Environment lookup; Windows names are case-insensitive.
  function getEnv(env, name, isWin) {
    if (!env) return undefined;
    if (!isWin) return env[name];
    if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
    var want = name.toUpperCase();
    for (var k in env) {
      if (Object.prototype.hasOwnProperty.call(env, k) && String(k).toUpperCase() === want) return env[k];
    }
    return undefined;
  }

  // Copy of env without NODE_OPTIONS / NODE_PATH / NODE_EXTRA_CA_CERTS (they
  // could inject code or flags, resolve modules from a system Node tree, or
  // change TLS trust for the daemon). Case-insensitive on win32, exact on
  // POSIX. Everything else stays (Claude needs USER/HOME; on Windows PATH,
  // APPDATA, USERNAME, USERPROFILE). Decision D7: the original CA bundle is
  // passed on as GAFFER_CLAUDE_EXTRA_CA_CERTS so the chat handler can restore
  // it for the claude child only (corporate TLS-inspecting proxies).
  function cleanDaemonEnv(env, platform) {
    var isWin = platform === 'win32';
    var out = {};
    var ca;
    for (var k in env) {
      if (!Object.prototype.hasOwnProperty.call(env, k)) continue;
      var key = isWin ? String(k).toUpperCase() : String(k);
      if (STRIPPED_ENV.indexOf(key) !== -1) {
        if (key === 'NODE_EXTRA_CA_CERTS' && ca === undefined) ca = env[k];
        continue;
      }
      out[k] = env[k];
    }
    if (ca !== undefined && ca !== '' && getEnv(out, CA_STASH, isWin) === undefined) out[CA_STASH] = ca;
    return out;
  }

  function launchNotice(code) {
    return NOTICES[code] || NOTICES['launch-failed'];
  }

  function exists(fs, p) {
    try { return !!fs.existsSync(p); } catch (e) { return false; }
  }

  // runtime/VERIFIED -> recorded size, or null when absent/unreadable/garbled.
  // Spec form is "<size> <sha256>"; the PoC wrote "size=<n>" lines, read both.
  function readStampSize(fs, stampPath) {
    var raw;
    try { raw = String(fs.readFileSync(stampPath, 'utf8')); } catch (e) { return null; }
    var m = raw.match(/^\s*(\d+)(?:\s|$)/) || raw.match(/size=(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  // The pinned platform entry for a binary of this size. On macOS both darwin
  // entries are candidates and the size picks one, so an x64 AE under Rosetta
  // still finds the arm64 pin (and the reverse); sizes differ per platform.
  function pinFor(pins, platform, size) {
    var plats = pins && pins.node && pins.node.platforms;
    if (!plats) return null;
    var keys = platform === 'win32' ? ['win-x64'] : platform === 'darwin' ? ['darwin-arm64', 'darwin-x64'] : [];
    for (var i = 0; i < keys.length; i++) {
      var p = plats[keys[i]];
      if (p && p.binaryBytes === size) return { key: keys[i], pin: p };
    }
    return null;
  }

  // Bundled runtime check. Returns { ok: true } or { ok: false, reason }.
  function checkRuntime(o, bin, bundle, stampPath, notes) {
    var fs = o.fs;
    if (!exists(fs, bundle)) return { ok: false, reason: 'daemon.mjs missing next to the runtime' };
    var size;
    try { size = fs.statSync(bin).size; } catch (e) { return { ok: false, reason: 'cannot stat runtime: ' + (e && e.message) }; }

    var stamped = readStampSize(fs, stampPath);
    if (stamped !== null) {
      if (stamped !== size) return { ok: false, reason: 'runtime size ' + size + ' does not match the stamp ' + stamped };
    } else {
      // Stamp-less first run (README install): verify once against the pin.
      var match = pinFor(o.pins, o.platform, size);
      if (!match) return { ok: false, reason: 'no stamp and runtime size ' + size + ' matches no pinned binary' };
      var sha = match.pin.binarySha256;
      if (sha === PENDING_PIN) {
        // Only this exact literal skips the hash (the darwin-arm64 value is
        // recorded by the first acceptance run). No stamp is written, so a
        // later stamp-less run re-evaluates once the real pin ships.
        notes.push('runtime: pinned sha256 for ' + match.key + ' is the placeholder ' + PENDING_PIN + ', skipping the hash check, size matched, no stamp written');
      } else if (!REAL_SHA256.test(String(sha))) {
        return { ok: false, reason: 'pinned sha256 for ' + match.key + ' is not a sha256 (' + sha + ')' };
      } else {
        var got;
        try { got = String(o.hashFile(bin)).toLowerCase(); } catch (e) { return { ok: false, reason: 'cannot hash runtime: ' + (e && e.message) }; }
        if (got !== String(sha).toLowerCase()) return { ok: false, reason: 'runtime sha256 ' + got + ' does not match the pin for ' + match.key };
        notes.push('runtime: first run, sha256 matches the pin for ' + match.key);
        try { fs.writeFileSync(stampPath, size + ' ' + got + '\n'); notes.push('runtime: wrote stamp ' + stampPath); }
        catch (e) { notes.push('runtime: could not write the stamp (' + (e && e.message) + '), will verify again next launch'); }
      }
    }

    // macOS: a binary whose size checks out but lost its exec bit (copied by
    // a tool that drops modes) gets it back.
    if (o.platform === 'darwin') {
      var mode = 0;
      try { mode = fs.statSync(bin).mode; } catch (e) {}
      if ((mode & 73) === 0) { // 0o111
        try { fs.chmodSync(bin, 493); } // 0o755
        catch (e) { return { ok: false, reason: 'runtime is not executable and chmod failed: ' + (e && e.message) }; }
        notes.push('runtime: exec bit was missing, restored with chmod 755');
      }
    }
    return { ok: true };
  }

  // System node probe, same candidates and order as start.sh / start.ps1,
  // then any node on PATH. Returns a path or null.
  function findSystemNode(o, isWin) {
    var fs = o.fs, env = o.env || {};
    var candidates = [];
    var exe = isWin ? 'node.exe' : 'node';
    if (isWin) {
      var pf = getEnv(env, 'ProgramFiles', true);
      var la = getEnv(env, 'LOCALAPPDATA', true);
      if (pf) candidates.push(normalizeWinPath(pf) + '\\nodejs\\node.exe');
      if (la) candidates.push(normalizeWinPath(la) + '\\Programs\\nodejs\\node.exe');
    } else {
      candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
    }
    var path = getEnv(env, 'PATH', isWin);
    if (path) {
      var dirs = String(path).split(isWin ? ';' : ':');
      for (var d = 0; d < dirs.length; d++) {
        if (!dirs[d]) continue;
        var dir = isWin ? normalizeWinPath(dirs[d].replace(/^"|"$/g, '')) : dirs[d].replace(/\/+$/, '');
        candidates.push(dir + (isWin ? '\\' : '/') + exe);
      }
    }
    for (var i = 0; i < candidates.length; i++) {
      if (exists(fs, candidates[i])) return candidates[i];
    }
    return null;
  }

  // resolveDaemonLaunch({ daemonDir, platform, fs, pins, env, detectDev, hashFile })
  //   -> { bin, args, cwd, kind: 'runtime'|'node', notes }   or   { error, reason, notes }
  // error is 'runtime-damaged' (runtime present but fails the check: NEVER
  // falls back to a system node) or 'runtime-missing' (no runtime binary and
  // no system node). notes are log lines for the daemon log.
  function resolveDaemonLaunch(o) {
    var isWin = o.platform === 'win32';
    var sep = isWin ? '\\' : '/';
    var daemonDir = isWin ? normalizeWinPath(o.daemonDir) : String(o.daemonDir).replace(/\/+$/, '');
    var notes = [];
    var bin = daemonDir + sep + 'runtime' + sep + (isWin ? 'node.exe' : 'node');
    var bundle = daemonDir + sep + 'daemon.mjs';
    var stampPath = daemonDir + sep + 'runtime' + sep + 'VERIFIED';

    var dev = false;
    try { dev = !!(o.detectDev && o.detectDev()); } catch (e) { dev = false; }

    if (!dev && exists(o.fs, bin)) {
      var chk = checkRuntime(o, bin, bundle, stampPath, notes);
      if (!chk.ok) {
        notes.push('runtime: ' + chk.reason);
        return { error: 'runtime-damaged', reason: chk.reason, notes: notes };
      }
      return { bin: bin, args: ['daemon.mjs'], cwd: daemonDir, kind: 'runtime', notes: notes };
    }

    // Dev install, or no runtime binary (0.11.x mid-migration, or deleted).
    if (dev) notes.push('runtime: dev install, using the system node with index.js');
    else notes.push('runtime: no bundled runtime at ' + bin + ', probing for a system node');
    var node = findSystemNode(o, isWin);
    if (!node) return { error: 'runtime-missing', reason: 'no bundled runtime and no system node found', notes: notes };
    // A dev checkout runs its live sources (a gitignored daemon.mjs from
    // build.sh may be stale); a packaged tree prefers the bundle.
    var entry = (!dev && exists(o.fs, bundle)) ? 'daemon.mjs' : 'index.js';
    return { bin: node, args: [entry], cwd: daemonDir, kind: 'node', notes: notes };
  }

  var api = {
    resolveDaemonLaunch: resolveDaemonLaunch,
    cleanDaemonEnv: cleanDaemonEnv,
    normalizeWinPath: normalizeWinPath,
    launchNotice: launchNotice
  };
  root.GafferLaunch = api;
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
})(window);
