import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfigDir, prepareConfigLocation, CONFIG_FILENAME } from '../config-path.js';

// The per-install config must live OUTSIDE the CEP extension directory —
// every install/update path rewrites that directory, and a config inside it
// made a reinstalling existing user look like a brand-new install.
// These pin the per-platform layout and the one-time legacy migration.

function norm(p) { return p.split(sep).join('/'); }

test('darwin config dir is ~/Library/Application Support/Gaffer', () => {
  var dir = defaultConfigDir('darwin', {}, '/Users/gaffer');
  assert.equal(norm(dir), '/Users/gaffer/Library/Application Support/Gaffer');
});

test('win32 config dir follows %APPDATA% (the codebase convention)', () => {
  var dir = defaultConfigDir('win32', { APPDATA: 'C:\\Users\\gaffer\\AppData\\Roaming' }, 'C:\\Users\\gaffer');
  assert.ok(/AppData[\\/]Roaming[\\/]Gaffer$/.test(dir), 'got ' + dir);
});

test('win32 falls back to <home>/AppData/Roaming when APPDATA is unset', () => {
  var dir = defaultConfigDir('win32', {}, 'C:\\Users\\gaffer');
  assert.ok(/gaffer[\\/]AppData[\\/]Roaming[\\/]Gaffer$/.test(dir), 'got ' + dir);
});

test('linux config dir honors XDG_CONFIG_HOME, else ~/.config', () => {
  assert.equal(norm(defaultConfigDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/g')), '/xdg/gaffer');
  assert.equal(norm(defaultConfigDir('linux', {}, '/home/g')), '/home/g/.config/gaffer');
});

test('config dir is never inside the extension (panel) directory', () => {
  var panelDir = norm(join(import.meta.dirname || '.', '..', '..'));
  ['darwin', 'win32', 'linux'].forEach(function (p) {
    var dir = norm(defaultConfigDir(p, {}, '/Users/gaffer'));
    assert.ok(dir.indexOf(panelDir) !== 0, p + ' dir ' + dir + ' must not sit under ' + panelDir);
  });
});

test('prepareConfigLocation creates the directory and copies a legacy config forward once', () => {
  var root = mkdtempSync(join(tmpdir(), 'gaffer-config-path-'));
  try {
    var legacy = join(root, 'panel', '.gaffer-config.json');
    var target = join(root, 'appdata', 'Gaffer', CONFIG_FILENAME);
    prepareConfigLocation(join(root, 'panel', 'x'), null); // just to create panel/
    writeFileSync(legacy, JSON.stringify({ installId: 'existing-user', claudeBin: '/x/claude', shareUsageStats: false }));

    var migrated = prepareConfigLocation(target, legacy);
    assert.equal(migrated, true, 'first run migrates');
    assert.ok(existsSync(target), 'new file exists');
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf-8')),
      { installId: 'existing-user', claudeBin: '/x/claude', shareUsageStats: false });
    assert.ok(existsSync(legacy), 'legacy file is left in place (copy, not move)');

    // Second run: the new file wins, even if the legacy one has diverged.
    writeFileSync(legacy, JSON.stringify({ installId: 'stale' }));
    assert.equal(prepareConfigLocation(target, legacy), false, 'no re-migration');
    assert.equal(JSON.parse(readFileSync(target, 'utf-8')).installId, 'existing-user');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareConfigLocation with no legacy file just ensures the directory', () => {
  var root = mkdtempSync(join(tmpdir(), 'gaffer-config-path-'));
  try {
    var target = join(root, 'a', 'b', CONFIG_FILENAME);
    var migrated = prepareConfigLocation(target, join(root, 'nope', '.gaffer-config.json'));
    assert.equal(migrated, false);
    assert.ok(existsSync(join(root, 'a', 'b')), 'directory created');
    assert.ok(!existsSync(target), 'no file invented');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
