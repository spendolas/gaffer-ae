import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maxSourceMtime, isDevInstall, shouldReload } from '../dev-reload.js';

function seconds(t) { return new Date(t * 1000); }

test('maxSourceMtime: returns the newest .js mtime, recursing subdirs', () => {
  var dir = mkdtempSync(join(tmpdir(), 'devreload-'));
  writeFileSync(join(dir, 'a.js'), '1'); utimesSync(join(dir, 'a.js'), seconds(1000), seconds(1000));
  mkdirSync(join(dir, 'tools'));
  writeFileSync(join(dir, 'tools', 'b.js'), '2'); utimesSync(join(dir, 'tools', 'b.js'), seconds(5000), seconds(5000));
  assert.equal(maxSourceMtime(dir), 5000 * 1000); // newest, from the subdir
});

test('maxSourceMtime: ignores node_modules/test/dist and dotfiles and non-js', () => {
  var dir = mkdtempSync(join(tmpdir(), 'devreload-'));
  writeFileSync(join(dir, 'real.js'), '1'); utimesSync(join(dir, 'real.js'), seconds(1000), seconds(1000));
  for (var noise of ['node_modules', 'test', 'dist']) {
    mkdirSync(join(dir, noise));
    var f = join(dir, noise, 'x.js'); writeFileSync(f, '2'); utimesSync(f, seconds(9000), seconds(9000));
  }
  writeFileSync(join(dir, '.gaffer-cache.js'), '3'); utimesSync(join(dir, '.gaffer-cache.js'), seconds(9000), seconds(9000));
  writeFileSync(join(dir, 'notes.md'), '4'); utimesSync(join(dir, 'notes.md'), seconds(9000), seconds(9000));
  assert.equal(maxSourceMtime(dir), 1000 * 1000); // only real.js counts
});

test('isDevInstall: true when a .git sits at panelDir/.. or panelDir', () => {
  var repo = mkdtempSync(join(tmpdir(), 'devreload-repo-'));
  mkdirSync(join(repo, '.git'));
  var panel = join(repo, 'panel'); mkdirSync(panel);
  assert.equal(isDevInstall(panel), true);        // .git one level up
  var flat = mkdtempSync(join(tmpdir(), 'devreload-flat-'));
  mkdirSync(join(flat, '.git'));
  assert.equal(isDevInstall(flat), true);          // .git at the dir itself
});

test('isDevInstall: false for a plain install (no .git)', () => {
  var plain = mkdtempSync(join(tmpdir(), 'devreload-plain-'));
  mkdirSync(join(plain, 'panel'));
  assert.equal(isDevInstall(join(plain, 'panel')), false);
});

test('shouldReload: fires only when changed AND settled AND idle', () => {
  var base = { baseline: 1000, currentMax: 2000, lastChangeAt: 100, settleMs: 1500, idle: true };
  assert.equal(shouldReload(base, 100 + 1500), true);            // settled + idle
  assert.equal(shouldReload({ ...base, idle: false }, 100 + 1500), false); // busy → defer
  assert.equal(shouldReload(base, 100 + 1499), false);          // not settled yet
  assert.equal(shouldReload({ ...base, currentMax: 1000 }, 1e9), false);   // no change
});
