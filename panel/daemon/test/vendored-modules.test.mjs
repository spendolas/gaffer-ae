// Each vendored shared module under panel/daemon/vendor/ must be the copy its
// canonical repo's scripts/vendor.mjs produced (never hand-edited) and must
// still match that repo's working copy, so drift fails here instead of
// shipping silently. The drift check is skipped, with a reason, when the
// canonical repo is not on disk (CI, other machines); the stamp and export
// checks always run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULES, vendorDir, findSource } from '../../../scripts/vendor-sources.mjs';

const EXPECT = {
  'claude-model-catalog': {
    has: ['createModelCatalog', 'catalogFromModels', 'resolveModel', 'parseOauthBlob', 'versionLabel',
      'readCredentialFromEnv', 'accountIdFromEnv'],
    // Fetch-only: the claude -p turn classifier lives in claude-cli-contract,
    // which Gaffer has not adopted (panel/daemon/cli-contract.js stays).
    lacks: ['classify', 'observe', 'newTurnState', 'suggestableFamilies'],
  },
};

test('vendor-sources lists exactly the adopted modules', () => {
  assert.deepEqual(MODULES.map((m) => m.name), Object.keys(EXPECT));
  for (const m of MODULES) assert.match(m.env, /^[A-Z_]+_DIR$/);
});

for (const mod of MODULES) {
  const dir = vendorDir(mod.name);

  test(mod.name + ': vendor dir lives under panel/daemon/vendor', () => {
    assert.equal(path.basename(path.dirname(dir)), 'vendor');
    assert.equal(path.basename(path.dirname(path.dirname(dir))), 'daemon');
  });

  test(mod.name + ': VENDORED_FROM.json names a real commit of a clean tree', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'VENDORED_FROM.json'), 'utf8'));
    assert.equal(meta.name, mod.name);
    assert.match(meta.version, /^\d+\.\d+\.\d+/);
    assert.match(meta.commit, /^[0-9a-f]{40}$/, 'sync from a committed module tree, never a dirty one');
    assert.equal(meta.dirty, undefined);
    assert.equal(new Date(Date.parse(meta.vendoredAt)).toISOString(), meta.vendoredAt);
  });

  test(mod.name + ': the ESM entry exposes the expected exports', async () => {
    // A file URL, not a path: on Windows `import('C:\\...')` fails (ESM only
    // takes URLs or relative specifiers).
    const m = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
    for (const n of EXPECT[mod.name].has) assert.equal(typeof m[n], 'function', n);
    for (const n of EXPECT[mod.name].lacks) assert.equal(m[n], undefined, n);
  });

  test(mod.name + ': matches its canonical repo (else: npm run sync-vendor)', (t) => {
    const src = findSource(mod);
    if (!src) {
      t.skip('canonical repo not on disk (set ' + mod.env + ' to check drift)');
      return;
    }
    let out = '';
    let ok = true;
    try {
      out = execFileSync(process.execPath, [path.join(src, 'scripts', 'check-vendored.mjs'), dir],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      ok = false;
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    assert.ok(ok, out.trim());
  });
}
