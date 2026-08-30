// Daemon self-restart: the daemon watches for a code change and steps aside
// (exits) once idle, so the panel's reconnect path boots a fresh daemon from
// the new code. Kills the recurring "stale daemon" confusion (a panel reload
// only reloads the UI, never the daemon, and update.sh's kill historically
// missed the `node index.js` process).
//   - Dev install (git checkout): watches *.js source mtimes.
//   - End-user install: watches version.json content — an update rewrites it,
//     so the running daemon notices and relaunches into the new code even if
//     update.sh's own stop is skipped or fails.
//
// This module is the pure, testable core: max-mtime scan, version signature,
// dev-install check, and the reload decision. The wiring (poll timer,
// broadcast, process.exit) lives in index.js.
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

var SKIP_DIRS = { 'node_modules': 1, 'test': 1, 'test-fixtures': 1, 'dist': 1, 'coverage': 1 };

// Max mtime (ms) of any *.js under `dir`, skipping build/test/dep noise and
// dotfiles/dotdirs (e.g. .gaffer-icons). fs fns injectable for tests.
export function maxSourceMtime(dir, opts) {
  opts = opts || {};
  var readdirFn = opts.readdirSync || readdirSync;
  var statFn = opts.statSync || statSync;
  var max = 0;
  function walk(d) {
    var entries;
    try { entries = readdirFn(d, { withFileTypes: true }); } catch (e) { return; }
    for (var i = 0; i < entries.length; i++) {
      var ent = entries[i];
      var name = ent.name;
      if (name.charAt(0) === '.') continue;
      var full = join(d, name);
      if (ent.isDirectory()) { if (!SKIP_DIRS[name]) walk(full); continue; }
      if (!/\.js$/.test(name)) continue;
      try { var m = statFn(full).mtimeMs; if (m > max) max = m; } catch (e) { /* skip */ }
    }
  }
  walk(dir);
  return max;
}

// Version signature for end-user installs: the raw version.json content. An
// update rewrites this file (new version + commit), so a change means the
// on-disk code no longer matches what this daemon booted with. Returns '' when
// absent/unreadable so a transient read miss never looks like a change.
export function readVersionSignature(panelDir, opts) {
  opts = opts || {};
  var readFileFn = opts.readFileSync || readFileSync;
  try { return String(readFileFn(join(panelDir, 'version.json'), 'utf8')); }
  catch (e) { return ''; }
}

// A dev install symlinks the panel out of a git repo (mirrors update.sh's
// refusal check): a .git at the panel dir or one level up.
export function isDevInstall(panelDir, opts) {
  opts = opts || {};
  var existsFn = opts.existsSync || existsSync;
  return !!(existsFn(join(panelDir, '..', '.git')) || existsFn(join(panelDir, '.git')));
}

// Reload iff the code changed since boot, the change has settled (no further
// write within settleMs — a branch switch or update touches many files at
// once), and the daemon is idle (no in-flight turn/sign-in/JSX — never
// interrupt real work). "Changed" is either an explicit `state.changed` flag
// (version-signature path, string compare) or, for the dev mtime path, a
// currentMax that has advanced past the boot baseline.
export function shouldReload(state, now) {
  var changed = typeof state.changed === 'boolean'
    ? state.changed
    : state.currentMax > state.baseline;
  if (!changed) return false;
  if (!state.idle) return false;
  if (now - state.lastChangeAt < state.settleMs) return false;
  return true;
}
