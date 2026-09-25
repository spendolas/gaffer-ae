// Single source of truth for where Gaffer's per-install config file lives
// (installId, claudeBin, shareUsageStats). Both telemetry.js and
// claude-binary.js import getConfigPath() from here — there used to be two
// independent path computations that could (and did) drift: only one of them
// honored the GAFFER_CONFIG_PATH test override.
//
// The file deliberately lives OUTSIDE the CEP extension directory, in the
// normal per-user app-data location. Every install/reinstall/update path
// (tarball re-extract, rm -rf + re-symlink, rsync --delete, robocopy /MIR)
// rewrites the extension directory, and when the config sat inside it a
// reinstalling EXISTING user came back with a fresh installId and read as a
// brand-new install in telemetry. Out here, no install-path code can reach it.
//
//   macOS:    ~/Library/Application Support/Gaffer/config.json
//   Windows:  %APPDATA%\Gaffer\config.json
//   other:    $XDG_CONFIG_HOME/gaffer/config.json (or ~/.config/gaffer/)
//
// GAFFER_CONFIG_PATH (env) overrides the default entirely — the test suite
// points it at a throwaway file so a test run never touches the real config.
// The override means "use exactly this file": no directory creation, no
// legacy migration.

import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

var __dirname = dirname(fileURLToPath(import.meta.url));

export var CONFIG_FILENAME = 'config.json';

// Where the config lived before it moved out of the install directory
// (<extension-dir>/.gaffer-config.json). Kept only for the one-time
// migration below; nothing writes here any more.
export var LEGACY_CONFIG_PATH = join(__dirname, '..', '.gaffer-config.json');

// Pure + injectable so a test can assert each platform's layout without
// running on it. Windows follows the codebase's existing %APPDATA% convention
// (see claude-binary.js desktopAppCli).
export function defaultConfigDir(platform, env, home) {
  platform = platform || process.platform;
  env = env || process.env;
  home = home || homedir();
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Gaffer');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Gaffer');
  }
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'gaffer');
}

// Makes sure the config's directory exists and, exactly once, carries an
// existing in-install-dir config forward to the new location so real users'
// installId / claudeBin / shareUsageStats aren't orphaned by the move (which
// would cause the very "looks like a new install" problem the move fixes).
// Copy, not move: the old file is left in place, harmless and unread, so the
// update scripts' legacy backup/restore stays a no-op safety net for one more
// release. Never throws — a failure here must not stop the daemon; the
// callers' readConfig() simply sees "{}" as before.
// Returns true when a migration actually happened.
export function prepareConfigLocation(targetPath, legacyPath) {
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
  } catch (e) {
    console.error('Gaffer config: could not create ' + dirname(targetPath) + ': ' + e.message);
  }
  try {
    if (!existsSync(targetPath) && legacyPath && existsSync(legacyPath)) {
      copyFileSync(legacyPath, targetPath);
      console.log('Gaffer config: migrated ' + legacyPath + ' -> ' + targetPath);
      return true;
    }
  } catch (e) {
    console.error('Gaffer config: migration from ' + legacyPath + ' failed: ' + e.message);
  }
  return false;
}

var resolved = null;

// Resolved once per process; the first call creates the directory and runs
// the legacy migration. Cheap after that.
export function getConfigPath() {
  if (resolved) return resolved;
  var override = process.env.GAFFER_CONFIG_PATH;
  if (override) {
    resolved = override;
    return resolved;
  }
  var path = join(defaultConfigDir(), CONFIG_FILENAME);
  prepareConfigLocation(path, LEGACY_CONFIG_PATH);
  resolved = path;
  return resolved;
}
