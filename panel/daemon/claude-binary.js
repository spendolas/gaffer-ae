import { accessSync, readFileSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

var cached = null;

export async function findClaudeBinary() {
  if (cached) return cached;

  // 1. Config file (written by installer)
  try {
    var configPath = join(__dirname, '..', '.gaffer-config.json');
    var config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.claudeBin) {
      accessSync(config.claudeBin, constants.X_OK);
      cached = config.claudeBin;
      return cached;
    }
  } catch (e) { /* not found */ }

  // 2. Known locations
  var candidates = process.platform === 'win32'
    ? [
        join(process.env.LOCALAPPDATA || '', 'Programs', 'claude-code', 'claude.exe'),
        join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
      ]
    : [
        '/opt/homebrew/bin/claude',  // Apple Silicon Homebrew
        '/usr/local/bin/claude',     // Intel Homebrew
        join(process.env.HOME || '', '.local', 'bin', 'claude'),
        join(process.env.HOME || '', '.claude', 'local', 'claude'),
      ];

  for (var c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      cached = c;
      return cached;
    } catch (e) { /* next */ }
  }

  // 3. PATH lookup with augmented PATH (AE-spawned subprocesses inherit
  // a stripped PATH that often excludes Homebrew + user bins).
  try {
    var cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    var augmented = process.platform === 'win32'
      ? process.env.PATH || ''
      : ['/opt/homebrew/bin', '/usr/local/bin', join(process.env.HOME || '', '.local', 'bin'), process.env.PATH || ''].filter(Boolean).join(':');
    var result = execSync(cmd, {
      encoding: 'utf-8',
      env: Object.assign({}, process.env, { PATH: augmented }),
    }).trim().split('\n')[0];
    if (result) {
      cached = result;
      return cached;
    }
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
      if (shellResult) {
        cached = shellResult;
        return cached;
      }
    } catch (e) { /* shell didn't find it either */ }
  }

  throw new Error('Claude CLI not found. Install from https://claude.ai/code');
}
