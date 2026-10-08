import { accessSync, statSync, readFileSync, readdirSync, constants } from 'node:fs';
import { join, relative, win32 as pathWin32, posix as pathPosix } from 'node:path';
import { execSync, execFile } from 'node:child_process';
import { getConfigPath } from './config-path.js';

// { path, version, step, desktopRoot?, desktopVersion? } of the binary the
// last lookup settled on. desktopRoot/desktopVersion are set only for a
// desktop-app hit, so the cache check can notice a newer app version folder.
var cached = null;
// The lookup in progress, if any, so concurrent callers (index.js startup,
// listMcps, a chat turn and sign-in all call findClaudeBinary around the same
// moment) share one health check instead of spawning `--version` four times.
var inflight = null;

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

// Multiline: a binary may print a warning line (a Node deprecation notice,
// an update hint) before the version, and that must not reject it.
var VERSION_RE = /^\d+\.\d+\.\d+/m;
var HEALTH_TIMEOUT_MS = 5000;
// A cold start of the desktop app's copy (first run after an update, a slow
// disk, antivirus scanning a fresh exe) can take longer than 5 s. A timed-out
// candidate gets one more try with this budget before being accepted unseen.
var HEALTH_RETRY_TIMEOUT_MS = 20000;
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

// Numeric version-folder compare (plain text puts 2.1.9 above 2.1.121).
// Positive when a is newer than b.
function compareVersions(a, b) {
  var x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (var i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

// Version folders newest first.
function versionsBelow(root) {
  if (!root) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(function (e) { return e.isDirectory(); })
      .map(function (e) { return e.name; })
      .sort(function (a, b) { return compareVersions(b, a); });
  } catch (e) { return []; }
}

// The desktop app install root for this platform, or null where there is none.
function desktopRootFor(platform, env) {
  if (platform === 'win32' && env.APPDATA) return desktopAppRoot(env.APPDATA);
  if (platform === 'darwin' && env.HOME) return macDesktopAppRoot(env.HOME);
  return null;
}

// The version folder a desktop-app candidate path sits under, or null.
function desktopVersionOf(root, path) {
  if (!root || !path) return null;
  var rel = relative(root, path);
  if (!rel || rel.indexOf('..') === 0) return null;
  var first = rel.split(/[\\/]/)[0];
  return first || null;
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

// The environment the health check runs in: the same shape chat-handler's
// augmentedEnv() gives the real chat spawn, plus the candidate's own folder
// first. CEP hands the daemon a stripped PATH, and the desktop app's binary
// needs its own folder (and node for some installs) on PATH to even print a
// version, so checking it with the bare env would reject a binary the chat
// spawn runs fine. Built here, not imported from chat-handler.js, because that
// module imports this one (an import cycle).
export function healthCheckEnv(candidate, platform, env) {
  platform = platform || process.platform;
  env = env || process.env;
  // Split with the target platform's rules so a Windows path is handled
  // correctly even when this runs (in a test) on a POSIX host.
  var parts = [(platform === 'win32' ? pathWin32 : pathPosix).dirname(candidate)];
  if (platform !== 'win32') {
    parts.push('/opt/homebrew/bin', '/usr/local/bin', pathPosix.join(env.HOME || '', '.local', 'bin'));
  }
  if (env.PATH) parts.push(env.PATH);
  return Object.assign({}, env, { PATH: parts.join(platform === 'win32' ? ';' : ':') });
}

// The first line of stdout that starts with a version number, trimmed.
function versionLine(stdout) {
  var lines = String(stdout || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (/^\d+\.\d+\.\d+/.test(l)) return l;
  }
  return null;
}

// execFile's timeout kills the child with SIGTERM and reports killed: true;
// an ETIMEDOUT code is how some wrappers surface the same thing.
function isTimeout(err) {
  return !!(err && (err.killed === true || err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM'));
}

// A candidate counts only if it is a regular file, executable, and answers
// `--version` with something like 2.1.289. `claude.app` on Mac is a directory
// (passes X_OK), a half-written exe is zero bytes, a wrong PATH hit may be a
// shell script: all of those fail here and are skipped, never returned.
//
// A health-check TIMEOUT on a regular executable is different: the binary is
// real, it is just slow to start (cold cache, antivirus, first run after an
// update). Skipping it silently would make the whole lookup fail on a machine
// where Claude works. So a timeout gets one retry with a longer budget, and if
// that also times out the candidate is accepted with version "unknown" and a
// log line says so. Any other failure still skips the candidate.
//   ctx (optional): { platform, env } for the health-check environment.
export function checkCandidate(path, deps, ctx) {
  deps = deps || realDeps();
  ctx = ctx || {};
  var env = healthCheckEnv(path, ctx.platform, ctx.env);
  return new Promise(function (resolve) {
    try {
      if (!deps.statSync(path).isFile()) return resolve({ ok: false, reason: 'not a regular file' });
      deps.accessSync(path, constants.X_OK);
    } catch (e) {
      return resolve({ ok: false, reason: e && e.code === 'ENOENT' ? 'missing' : 'not executable' });
    }
    function attempt(timeoutMs, isRetry) {
      try {
        deps.execFile(path, ['--version'], { timeout: timeoutMs, windowsHide: true, encoding: 'utf-8', env: env }, function (err, stdout) {
          if (err && isTimeout(err)) {
            if (!isRetry) {
              deps.warn('Gaffer: claude --version timed out after ' + timeoutMs + ' ms, retrying once with ' + HEALTH_RETRY_TIMEOUT_MS + ' ms: ' + path);
              return attempt(HEALTH_RETRY_TIMEOUT_MS, true);
            }
            deps.warn('Gaffer: claude --version timed out twice, accepting the binary with version unknown: ' + path);
            return resolve({ ok: true, version: 'unknown', timedOut: true });
          }
          if (err) return resolve({ ok: false, reason: '--version failed: ' + (err.code || err.message) });
          var v = VERSION_RE.test(String(stdout || '')) ? versionLine(stdout) : null;
          if (!v) return resolve({ ok: false, reason: '--version gave no version number' });
          resolve({ ok: true, version: v });
        });
      } catch (e) {
        resolve({ ok: false, reason: '--version failed: ' + e.message });
      }
    }
    attempt(HEALTH_TIMEOUT_MS, false);
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
    var r = await checkCandidate(p, deps, { platform: platform, env: env });
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

function stillUsable(path, deps) {
  try { return deps.statSync(path).isFile() && (deps.accessSync(path, constants.X_OK), true); }
  catch (e) { return false; }
}

// Cheap cache validity check, no spawn (this runs on every chat turn and auth
// refresh): the binary must still be there, and for a desktop-app hit no
// NEWER version folder may have appeared since (the app auto-updates while
// the daemon lives, and the old folder can linger for a while, so "still
// usable" alone would keep us on the stale copy). One readdir of the version
// folders is all the newer-version check costs.
function cacheStillValid(deps) {
  if (!cached) return false;
  if (!stillUsable(cached.path, deps)) return false;
  if (cached.step === STEP_APP && cached.desktopRoot && cached.desktopVersion) {
    var newest = versionsBelow(cached.desktopRoot)[0];
    if (newest && compareVersions(newest, cached.desktopVersion) > 0) {
      deps.log('Gaffer: a newer Claude desktop app version folder appeared (' + newest + ' > ' + cached.desktopVersion + '), looking up claude again');
      return false;
    }
  }
  return true;
}

// Test-only: forget the cached hit and any in-flight lookup.
export function resetClaudeLookupForTests() {
  cached = null;
  inflight = null;
}

// Resolves the path of a working claude binary, or throws a not-found error
// that lists what was checked. Cached after the first hit; concurrent calls
// share one lookup. `opts` exists for tests only: { platform, env, config,
// deps, desktopCandidates } override the real process, config and fs/exec.
export async function findClaudeBinary(opts) {
  opts = opts || {};
  var deps = opts.deps || realDeps();
  if (cacheStillValid(deps)) return cached.path;
  cached = null;
  if (inflight) return inflight;

  inflight = lookup(opts, deps);
  // Clear the in-flight slot however the lookup ends, so a failed lookup is
  // retried next call and a success is served from the cache.
  var clear = function () { inflight = null; };
  inflight.then(clear, clear);
  return inflight;
}

async function lookup(opts, deps) {
  var platform = opts.platform || process.platform;
  var env = opts.env || process.env;
  var config = opts.config || readConfig();
  var desktopRoot = desktopRootFor(platform, env);
  var diag = { desktopBase: desktopRoot, desktopVersions: desktopRoot ? versionsBelow(desktopRoot) : [], pathLines: [] };

  var hit = await resolveClaude({
    platform: platform, env: env, config: config, diag: diag, deps: deps,
    desktopCandidates: opts.desktopCandidates,
  });
  if (hit) {
    cached = { path: hit.path, version: hit.version, step: hit.step };
    if (hit.step === STEP_APP) {
      cached.desktopRoot = desktopRoot;
      cached.desktopVersion = desktopVersionOf(desktopRoot, hit.path);
    }
    deps.log('Gaffer: claude found (' + hit.step + '): ' + hit.path + ' (' + hit.version + ')');
    return hit.path;
  }

  deps.warn('Gaffer: claude lookup failed: ' + JSON.stringify(diag));
  throw new Error(formatNotFoundMessage(diag, getConfigPath()));
}
