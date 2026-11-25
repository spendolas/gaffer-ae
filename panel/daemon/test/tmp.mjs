// Temp-dir convention for tests: never call mkdtempSync(join(tmpdir(), ...))
// directly. Use tmpDir(prefix) from here. Every dir it hands out is removed
// when the test file finishes (node:test `after` hook, with a process-exit
// fallback), so a run leaves nothing behind in os.tmpdir(). tmp-convention.test.mjs
// enforces this.
import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

var made = [];

// Windows: a daemon child can still hold a handle when the hook runs, so retry.
export function rmTmp(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { /* best effort */ }
}

export function cleanupTmp() {
  while (made.length) rmTmp(made.pop());
}

export function tmpDir(prefix) {
  var dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// Registered at import time so it lands on the file's root context, not on
// whichever test happens to be running when tmpDir() is first called.
after(cleanupTmp);
process.on('exit', cleanupTmp);
