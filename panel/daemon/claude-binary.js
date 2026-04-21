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
        '/usr/local/bin/claude',
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

  // 3. PATH lookup
  try {
    var cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    var result = execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0];
    if (result) {
      cached = result;
      return cached;
    }
  } catch (e) { /* not on PATH */ }

  throw new Error('Claude CLI not found. Install from https://claude.ai/code');
}
