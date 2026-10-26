// The shared modules Gaffer vendors under panel/daemon/vendor/, and where
// their canonical repos live on this machine. Per module: $<ENV>, then the
// sibling Tools folder of the main Gaffer checkout (Gaffer is
// .../Tools/AE Tools/Gaffer, the modules are .../Tools/<name>), resolved
// through git's common dir so a worktree finds it too. findSource() returns
// null when the repo is not on disk (CI, other machines).
//
// Rule: change a module in its own repo (npm test, commit), then run
// `npm run sync-vendor` in panel/daemon and commit the vendor dir. Never edit
// the vendored copy; test/vendored-modules.test.mjs fails on drift.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MODULES = [
  { name: 'claude-model-catalog', env: 'CLAUDE_MODEL_CATALOG_DIR' }, // model discovery (fetch-only)
];

export function vendorDir(name) {
  return path.join(REPO, 'panel', 'daemon', 'vendor', name);
}

export function findSource(mod) {
  const candidates = [];
  if (process.env[mod.env]) candidates.push(process.env[mod.env]);
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // <main checkout>/.git -> <main checkout>/../../<module>
    candidates.push(path.join(path.dirname(common), '..', '..', mod.name));
  } catch (e) { /* not a git checkout */ }
  candidates.push(path.join(REPO, '..', '..', mod.name));
  return candidates.find((d) => fs.existsSync(path.join(d, 'scripts', 'vendor.mjs'))) || null;
}
