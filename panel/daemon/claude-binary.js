import { accessSync, readFileSync, readdirSync, constants } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getConfigPath } from './config-path.js';

var cached = null;

// Claude Code installed via the desktop app lives under
// %APPDATA%\Claude\claude-code, in one folder per version, and the app
// rewrites that layout on its own schedule:
//   <= 2.1.209  <version>\claude.exe
//   >= 2.1.286  <version>\<build hash>\claude.exe
// Hardcoding one depth broke us twice (v0.5.12 added the folder at all, then
// 2.1.286 added the hash level), so instead of guessing a single layout we list
// claude.exe candidates up to DESKTOP_APP_MAX_DEPTH levels below each version
// folder; findClaudeBinary() keeps the first one that actually runs.
var DESKTOP_APP_MAX_DEPTH = 3;
var DESKTOP_APP_MAX_DIRS_PER_LEVEL = 50;

function desktopAppRoot(appData) {
  return join(appData, 'Claude', 'claude-code');
}

// Version folders newest first. Numeric compare, because plain text puts
// 2.1.9 above 2.1.121.
function desktopAppVersions(appData) {
  if (!appData) return [];
  try {
    return readdirSync(desktopAppRoot(appData), { withFileTypes: true })
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

// Candidate claude.exe paths for the desktop-app install, best first: newest
// version first, and inside a version the <hash> folders, then the old direct
// path, then anything deeper. Paths are not checked for existence here.
export function desktopAppCandidates(appData) {
  var out = [];
  desktopAppVersions(appData).forEach(function (v) {
    var vdir = join(desktopAppRoot(appData), v);
    var levels = [];
    var cur = [vdir];
    for (var depth = 1; depth <= DESKTOP_APP_MAX_DEPTH; depth++) {
      cur = foldersBelow(cur);
      levels.push(cur);
    }
    [].concat(levels[0], [vdir], levels[1], levels[2]).forEach(function (d) {
      out.push(join(d, 'claude.exe'));
    });
  });
  return out;
}

// The "not found" error, built from what the lookup actually saw so a bug
// report explains itself instead of sending the user to a config file blind.
export function formatNotFoundMessage(diag, configPath) {
  diag = diag || {};
  var checked = [];
  if (diag.desktopBase) {
    var versions = diag.desktopVersions || [];
    checked.push(versions.length
      ? 'the Claude desktop app folder ' + diag.desktopBase + ' (versions ' + versions.slice(0, 3).join(', ') + ', but no runnable claude.exe inside)'
      : 'the Claude desktop app folder ' + diag.desktopBase + ' (not found or empty)');
  }
  var lines = diag.pathLines || [];
  checked.push(lines.length
    ? 'PATH (found ' + lines.join(', ') + ', but none is a real .exe, and npm shims cannot be spawned)'
    : 'PATH (nothing named claude)');
  return 'Claude CLI not found. Gaffer looked in: ' + checked.join('; ') + '. '
    + 'Install the native build from https://claude.ai/code, or point Gaffer at your binary via '
    + configPath + ': {"claudeBin": "C:/full/path/claude.exe"}';
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

// Remember a resolved binary and say in the daemon log which step found it,
// so "which claude is Gaffer running?" never needs guessing.
function found(step, path) {
  cached = path;
  console.log('Gaffer: claude found (' + step + '): ' + path);
  return path;
}

export async function findClaudeBinary() {
  // the desktop-app CLI path changes on every auto-update — re-resolve if
  // the cached binary vanished mid-daemon-life
  if (cached) {
    try { accessSync(cached, constants.X_OK); return cached; }
    catch (e) { cached = null; }
  }

  // What the lookup saw, for the "not found" message and the daemon log.
  var diag = { desktopBase: null, desktopVersions: [], pathLines: [] };

  // 1. Per-install config file — `claudeBin` pinned by the README install
  // step or hand-edited by the user. Same file telemetry.js owns; the path
  // comes from config-path.js so the two can never disagree.
  try {
    var config = JSON.parse(readFileSync(getConfigPath(), 'utf-8'));
    if (config.claudeBin) {
      accessSync(config.claudeBin, constants.X_OK);
      return found('config', config.claudeBin);
    }
  } catch (e) { /* not found */ }

  // 2. Known locations
  if (process.platform === 'win32' && process.env.APPDATA) {
    diag.desktopBase = desktopAppRoot(process.env.APPDATA);
    diag.desktopVersions = desktopAppVersions(process.env.APPDATA);
  }
  var candidates = process.platform === 'win32'
    ? win32ClaudeCandidates().concat(desktopAppCandidates(process.env.APPDATA))
    : [
        '/opt/homebrew/bin/claude',  // Apple Silicon Homebrew
        '/usr/local/bin/claude',     // Intel Homebrew
        join(process.env.HOME || '', '.local', 'bin', 'claude'),
        join(process.env.HOME || '', '.claude', 'local', 'claude'),
      ];

  for (var c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return found('known location', c);
    } catch (e) { /* next */ }
  }

  // 3. PATH lookup with augmented PATH (AE-spawned subprocesses inherit
  // a stripped PATH that often excludes Homebrew + user bins).
  try {
    var cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    var augmented = process.platform === 'win32'
      ? process.env.PATH || ''
      : ['/opt/homebrew/bin', '/usr/local/bin', join(process.env.HOME || '', '.local', 'bin'), process.env.PATH || ''].filter(Boolean).join(':');
    var lines = execSync(cmd, {
      encoding: 'utf-8',
      windowsHide: true,
      env: Object.assign({}, process.env, { PATH: augmented }),
    }).trim().split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    diag.pathLines = lines;
    var result;
    if (process.platform === 'win32') {
      // npm-installed CLIs surface as shims (bare sh script, .cmd, .ps1) that
      // Node's spawn() can't execute — only a real .exe is usable here
      result = lines.filter(function (l) { return /\.exe$/i.test(l); })[0];
    } else {
      result = lines[0];
    }
    if (result) return found('PATH', result);
  } catch (e) { /* not on PATH */ }

  // 4. Login shell — last resort for nvm/fnm/Volta and other shell-managed installs.
  // Login shell sources .zshrc/.bash_profile so PATH includes user customizations.
  if (process.platform !== 'win32') {
    try {
      var shell = process.env.SHELL || '/bin/sh';
      var shellResult = execSync('"' + shell + '" -lc "command -v claude"', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim().split('\n')[0];
      if (shellResult) return found('login shell', shellResult);
    } catch (e) { /* shell didn't find it either */ }
  }

  console.error('Gaffer: claude lookup failed: ' + JSON.stringify(diag));
  throw new Error(formatNotFoundMessage(diag, getConfigPath()));
}
