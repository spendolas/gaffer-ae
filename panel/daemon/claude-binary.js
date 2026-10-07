import { accessSync, statSync, readFileSync, readdirSync, constants } from 'node:fs';
import { join } from 'node:path';
import { execSync, execFile } from 'node:child_process';
import { getConfigPath } from './config-path.js';

// { path, version } of the binary the last lookup settled on.
var cached = null;

export var INSTALL_LINKS = {
  desktop: 'https://claude.com/download',
  cli: 'https://claude.ai/code',
};

// Lookup order (decided by the owner, see docs/superpowers/plans/2026-10-07):
//   1. config pin   (`claudeBin` in the per-install config: "app", "cli" or a path)
//   2. desktop app  (the Claude desktop app's bundled Claude Code, newest first)
//   3. standalone   (known install locations, PATH, login shell)
// Designers often have no CLI at all, and the desktop app's copy updates
// itself, so it wins over a standalone CLI that may be months old.
var STEP_CONFIG = 'config';
var STEP_APP = 'desktop app';
var STEP_KNOWN = 'known location';
var STEP_PATH = 'PATH';
var STEP_SHELL = 'login shell';

var VERSION_RE = /^\d+\.\d+\.\d+/;
var HEALTH_TIMEOUT_MS = 5000;
var PATH_LOOKUP_TIMEOUT_MS = 5000;

// Claude Code installed via the desktop app lives under
// %APPDATA%\Claude\claude-code (Windows) or
// ~/Library/Application Support/Claude/claude-code (Mac), in one folder per
// version, and the app rewrites that layout on its own schedule:
//   <= 2.1.209  <version>\claude.exe
//   >= 2.1.286  <version>\<build hash>\claude.exe
//   Mac         <version>/<build hash>/claude.app/Contents/MacOS/claude
// Hardcoding one depth broke us twice (v0.5.12 added the folder at all, then
// 2.1.286 added the hash level), so instead of guessing a single layout we list
// candidates up to DESKTOP_APP_MAX_DEPTH levels below each version folder;
// the lookup keeps the first one that actually runs.
var DESKTOP_APP_MAX_DEPTH = 3;
var DESKTOP_APP_MAX_DIRS_PER_LEVEL = 50;

function desktopAppRoot(appData) {
  return join(appData, 'Claude', 'claude-code');
}

function macDesktopAppRoot(home) {
  return join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
}

// Version folders newest first. Numeric compare, because plain text puts
// 2.1.9 above 2.1.121.
function versionsBelow(root) {
  if (!root) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(function (e) { return e.isDirectory(); })
      .map(function (e) { return e.name; })
      .sort(function (a, b) {
        var x = a.split('.').map(Number), y = b.split('.').map(Number);
        for (var i = 0; i < Math.max(x.length, y.length); i++) {
          if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0);
        }
        return 0;
      });
  } catch (e) { return []; }
}

function desktopAppVersions(appData) {
  return appData ? versionsBelow(desktopAppRoot(appData)) : [];
}

// Sub-folders one level below every folder in `dirs` (files ignored, never
// throws, capped so a runaway folder cannot blow up the list).
function foldersBelow(dirs) {
  var out = [];
  dirs.forEach(function (d) {
    try {
      readdirSync(d, { withFileTypes: true }).forEach(function (e) {
        if (e.isDirectory()) out.push(join(d, e.name));
      });
    } catch (e) { /* unreadable: skip */ }
  });
  return out.slice(0, DESKTOP_APP_MAX_DIRS_PER_LEVEL);
}

// Candidate binary paths under a desktop-app install root, best first: newest
// version first, and inside a version the <hash> folders, then the old direct
// path, then anything deeper. `leaf` is the path from a folder to the binary.
// Paths are not checked for existence here.
function scanDesktopApp(root, leaf) {
  var out = [];
  if (!root) return out;
  versionsBelow(root).forEach(function (v) {
    var vdir = join(root, v);
    var levels = [];
    var cur = [vdir];
    for (var depth = 1; depth <= DESKTOP_APP_MAX_DEPTH; depth++) {
      cur = foldersBelow(cur);
      levels.push(cur);
    }
    [].concat(levels[0], [vdir], levels[1], levels[2]).forEach(function (d) {
      out.push(join.apply(null, [d].concat(leaf)));
    });
  });
  return out;
}

// Windows: claude.exe candidates under %APPDATA%\Claude\claude-code.
export function desktopAppCandidates(appData) {
  return appData ? scanDesktopApp(desktopAppRoot(appData), ['claude.exe']) : [];
}

// Mac: the binary inside claude.app under
// ~/Library/Application Support/Claude/claude-code. Note claude.app itself is
// a directory that passes an X_OK check, which is why the health check below
// insists on a regular file.
export function macDesktopAppCandidates(home) {
  return home ? scanDesktopApp(macDesktopAppRoot(home), ['claude.app', 'Contents', 'MacOS', 'claude']) : [];
}

// The "not found" error, built from what the lookup actually saw so a bug
// report explains itself instead of sending the user to a config file blind.
export function formatNotFoundMessage(diag, configPath) {
  diag = diag || {};
  var checked = [];
  if (diag.desktopBase) {
    var versions = diag.desktopVersions || [];
    checked.push(versions.length
      ? 'the Claude desktop app folder ' + diag.desktopBase + ' (versions ' + versions.slice(0, 3).join(', ') + ', but no runnable Claude Code inside)'
      : 'the Claude desktop app folder ' + diag.desktopBase + ' (not found or empty)');
  }
  var lines = diag.pathLines || [];
  checked.push(lines.length
    ? 'PATH (found ' + lines.join(', ') + ', but none is a runnable binary, and npm shims cannot be spawned)'
    : 'PATH (nothing named claude)');
  return 'Claude CLI not found. Gaffer looked in: ' + checked.join('; ') + '. '
    + 'Install the Claude desktop app from ' + INSTALL_LINKS.desktop
    + ' or Claude Code from ' + INSTALL_LINKS.cli
    + ', or point Gaffer at your binary via ' + configPath
    + ': {"claudeBin": "app"}, {"claudeBin": "cli"} or {"claudeBin": "/full/path/to/claude"}';
}

// Fixed (non-desktop-app) Windows install locations, newest-first by likelihood.
// The native installer (`irm https://claude.ai/install.ps1 | iex`) — Anthropic's
// recommended install — drops claude.exe under %USERPROFILE%\.local\bin, and it
// is NOT on PATH by default, so it MUST be probed here or a fresh Windows install
// reads as "Claude CLI not found". The others cover an older Programs install and
// WinGet's shim link. Pure + env-injected so a test can assert the set.
export function win32ClaudeCandidates(env) {
  env = env || process.env;
  return [
    join(env.USERPROFILE || '', '.local', 'bin', 'claude.exe'),
    join(env.LOCALAPPDATA || '', 'Programs', 'claude-code', 'claude.exe'),
    join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
  ];
}

function unixClaudeCandidates(env) {
  return [
    '/opt/homebrew/bin/claude',  // Apple Silicon Homebrew
    '/usr/local/bin/claude',     // Intel Homebrew
    join(env.HOME || '', '.local', 'bin', 'claude'),
    join(env.HOME || '', '.claude', 'local', 'claude'),
  ];
}

// The ordered lookup as data, so the priority can be asserted without real
// binaries. Each entry is { step, path } for a fixed path or { step } for a
// step that has to run a command (PATH, login shell). `pinned` marks the
// entries the config pin allows; when a pin is set and none of its entries
// works, the lookup logs that and continues over the unpinned ones.
//   opts: { platform, env, config, desktopCandidates? }
export function resolveOrder(opts) {
  opts = opts || {};
  var platform = opts.platform || process.platform;
  var env = opts.env || process.env;
  var config = opts.config || {};
  var pin = typeof config.claudeBin === 'string' && config.claudeBin.trim() ? config.claudeBin.trim() : null;
  var mode = pin === 'app' || pin === 'cli' ? pin : (pin ? 'path' : null);

  var app = opts.desktopCandidates || (
    platform === 'win32' ? desktopAppCandidates(env.APPDATA)
      : platform === 'darwin' ? macDesktopAppCandidates(env.HOME)
      : []);
  var known = platform === 'win32' ? win32ClaudeCandidates(env) : unixClaudeCandidates(env);

  var out = [];
  if (mode === 'path') out.push({ step: STEP_CONFIG, path: pin, pinned: true });
  app.forEach(function (p) { out.push({ step: STEP_APP, path: p, pinned: mode === 'app' }); });
  known.forEach(function (p) { out.push({ step: STEP_KNOWN, path: p, pinned: mode === 'cli' }); });
  out.push({ step: STEP_PATH, pinned: mode === 'cli' });
  if (platform !== 'win32') out.push({ step: STEP_SHELL, pinned: mode === 'cli' });
  return out;
}

// Real-process dependencies, overridable in tests.
function realDeps() {
  return {
    statSync: statSync,
    accessSync: accessSync,
    execSync: execSync,
    execFile: execFile,
    log: function (line) { console.log(line); },
    warn: function (line) { console.error(line); },
  };
}

// A candidate counts only if it is a regular file, executable, and answers
// `--version` with something like 2.1.289 within 5 s. `claude.app` on Mac is a
// directory (passes X_OK), a half-written exe is zero bytes, a wrong PATH hit
// may be a shell script: all of those fail here and are skipped, never returned.
export function checkCandidate(path, deps) {
  deps = deps || realDeps();
  return new Promise(function (resolve) {
    try {
      if (!deps.statSync(path).isFile()) return resolve({ ok: false, reason: 'not a regular file' });
      deps.accessSync(path, constants.X_OK);
    } catch (e) {
      return resolve({ ok: false, reason: e && e.code === 'ENOENT' ? 'missing' : 'not executable' });
    }
    try {
      deps.execFile(path, ['--version'], { timeout: HEALTH_TIMEOUT_MS, windowsHide: true, encoding: 'utf-8' }, function (err, stdout) {
        if (err) return resolve({ ok: false, reason: '--version failed: ' + (err.code || err.message) });
        var m = VERSION_RE.exec(String(stdout || '').trim());
        if (!m) return resolve({ ok: false, reason: '--version gave no version number' });
        resolve({ ok: true, version: String(stdout).trim().split('\n')[0] });
      });
    } catch (e) {
      resolve({ ok: false, reason: '--version failed: ' + e.message });
    }
  });
}

// `which claude` / `where claude` on an augmented PATH (AE-spawned subprocesses
// inherit a stripped PATH that often excludes Homebrew + user bins). Returns
// the lines it printed; on Windows only real .exe hits are usable because npm
// shims (.cmd, .ps1, bare sh) cannot be spawned.
function pathLookup(platform, env, deps, diag) {
  try {
    var cmd = platform === 'win32' ? 'where claude' : 'which claude';
    var augmented = platform === 'win32'
      ? env.PATH || ''
      : ['/opt/homebrew/bin', '/usr/local/bin', join(env.HOME || '', '.local', 'bin'), env.PATH || ''].filter(Boolean).join(':');
    var lines = deps.execSync(cmd, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: PATH_LOOKUP_TIMEOUT_MS,
      env: Object.assign({}, env, { PATH: augmented }),
    }).trim().split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    diag.pathLines = lines;
    return platform === 'win32' ? lines.filter(function (l) { return /\.exe$/i.test(l); }) : lines;
  } catch (e) { return []; }
}

// Login shell: last resort for nvm/fnm/Volta and other shell-managed installs,
// since -l sources .zshrc/.bash_profile. `command -v` happily prints
// `alias claude='...'` or a function name, so only an absolute path counts.
function loginShellLookup(env, deps) {
  try {
    var shell = env.SHELL || '/bin/sh';
    var line = deps.execSync('"' + shell + '" -lc "command -v claude"', {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim().split('\n')[0].trim();
    return /^\//.test(line) ? [line] : [];
  } catch (e) { return []; }
}

// One full lookup, no cache: walks resolveOrder(), health-checks each
// candidate in turn and returns { path, version, step } for the first that
// works, or null. `opts` as for resolveOrder, plus `deps` for tests.
export async function resolveClaude(opts) {
  opts = opts || {};
  var platform = opts.platform || process.platform;
  var env = opts.env || process.env;
  var deps = opts.deps || realDeps();
  var config = opts.config || {};
  var order = resolveOrder({ platform: platform, env: env, config: config, desktopCandidates: opts.desktopCandidates });
  var diag = opts.diag || {};
  var tried = {};

  async function tryPath(step, p) {
    if (tried[p]) return null;
    tried[p] = true;
    var r = await checkCandidate(p, deps);
    if (r.ok) return { step: step, path: p, version: r.version };
    // Missing fixed-location candidates are the normal case; only say
    // something when a file was there but did not work.
    if (r.reason !== 'missing') deps.warn('Gaffer: claude candidate skipped (' + step + '): ' + p + ' (' + r.reason + ')');
    return null;
  }

  async function walk(entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var paths = e.path ? [e.path]
        : e.step === STEP_PATH ? pathLookup(platform, env, deps, diag)
        : loginShellLookup(env, deps);
      for (var j = 0; j < paths.length; j++) {
        var hit = await tryPath(e.step, paths[j]);
        if (hit) return hit;
      }
    }
    return null;
  }

  var pinned = order.filter(function (e) { return e.pinned; });
  if (pinned.length) {
    var hit = await walk(pinned);
    if (hit) return hit;
    deps.warn('Gaffer: pinned claudeBin ' + JSON.stringify(config.claudeBin) + ' not usable, falling back to automatic lookup');
  }
  return walk(order.filter(function (e) { return !e.pinned; }));
}

function readConfig() {
  try { return JSON.parse(readFileSync(getConfigPath(), 'utf-8')) || {}; }
  catch (e) { return {}; }
}

function stillUsable(path) {
  try { return statSync(path).isFile() && (accessSync(path, constants.X_OK), true); }
  catch (e) { return false; }
}

export async function findClaudeBinary() {
  // The desktop-app copy moves on every auto-update; re-resolve if the cached
  // binary vanished mid-daemon-life. An access check, not a `--version`
  // spawn: this runs on every chat turn and auth refresh.
  if (cached) {
    if (stillUsable(cached.path)) return cached.path;
    cached = null;
  }

  var env = process.env;
  var diag = { desktopBase: null, desktopVersions: [], pathLines: [] };
  if (process.platform === 'win32' && env.APPDATA) {
    diag.desktopBase = desktopAppRoot(env.APPDATA);
    diag.desktopVersions = desktopAppVersions(env.APPDATA);
  } else if (process.platform === 'darwin' && env.HOME) {
    diag.desktopBase = macDesktopAppRoot(env.HOME);
    diag.desktopVersions = versionsBelow(diag.desktopBase);
  }

  var hit = await resolveClaude({ platform: process.platform, env: env, config: readConfig(), diag: diag });
  if (hit) {
    cached = { path: hit.path, version: hit.version };
    console.log('Gaffer: claude found (' + hit.step + '): ' + hit.path + ' (' + hit.version + ')');
    return hit.path;
  }

  console.error('Gaffer: claude lookup failed: ' + JSON.stringify(diag));
  throw new Error(formatNotFoundMessage(diag, getConfigPath()));
}
