// Dev-only auto-reload: on a dev install, the daemon watches its own source
// files and steps aside (exits) when they change, so the panel's reconnect
// path boots a fresh daemon from the new code. Kills the recurring "stale
// daemon" confusion (a panel reload only reloads the UI, never the daemon).
// End users (no repo) never trigger this; they restart via update.sh.
//
// This module is the pure, testable core: max-mtime scan, dev-install check,
// and the reload decision. The wiring (poll timer, broadcast, process.exit)
// lives in index.js.
import { readdirSync, statSync, existsSync } from 'node:fs';
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

// A dev install symlinks the panel out of a git repo (mirrors update.sh's
// refusal check): a .git at the panel dir or one level up.
export function isDevInstall(panelDir, opts) {
  opts = opts || {};
  var existsFn = opts.existsSync || existsSync;
  return !!(existsFn(join(panelDir, '..', '.git')) || existsFn(join(panelDir, '.git')));
}

// Reload iff sources changed since boot, the change has settled (no further
// write within settleMs — a branch switch touches many files at once), and the
// daemon is idle (no in-flight turn/sign-in — never interrupt real work).
export function shouldReload(state, now) {
  if (!(state.currentMax > state.baseline)) return false;
  if (!state.idle) return false;
  if (now - state.lastChangeAt < state.settleMs) return false;
  return true;
}
