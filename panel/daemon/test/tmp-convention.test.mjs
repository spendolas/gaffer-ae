import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir, cleanupTmp } from './tmp.mjs';

var HERE = dirname(fileURLToPath(import.meta.url));
var SCRIPTS = join(HERE, '..', '..', '..', 'scripts');

test('tmpDir dirs are removed by cleanupTmp, even with files inside', () => {
  var d = tmpDir('gaffer-convention-');
  writeFileSync(join(d, 'x.txt'), 'x');
  assert.ok(existsSync(d));
  cleanupTmp();
  assert.equal(existsSync(d), false);
});

// isolate-env.mjs is exempt: it runs before any test framework hook exists
// (it is imported first, and the runner also loads it on its own) and removes
// its one directory itself on process exit.
var EXEMPT = ['tmp.mjs', 'tmp-convention.test.mjs', 'isolate-env.mjs'];

function testsIn(dir) {
  return readdirSync(dir).filter(function (f) { return /\.test\.mjs$/.test(f); }).map(function (f) { return join(dir, f); });
}

test('no test creates temp dirs directly (use tmpDir from ./tmp.mjs)', () => {
  var files = readdirSync(HERE).filter(function (f) { return /\.mjs$/.test(f) && EXEMPT.indexOf(f) === -1; })
    .map(function (f) { return join(HERE, f); })
    .concat(testsIn(SCRIPTS), testsIn(join(SCRIPTS, 'smoke')));
  var offenders = files.filter(function (f) { return /mkdtempSync\(/.test(readFileSync(f, 'utf8')); });
  assert.deepEqual(offenders, []);
});
