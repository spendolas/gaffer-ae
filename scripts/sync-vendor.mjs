// npm run sync-vendor [name]  (from panel/daemon)
//
// Refreshes panel/daemon/vendor/<module> from each shared module's canonical
// repo: the module's own scripts/vendor.mjs copies the files and writes
// VENDORED_FROM.json. Each vendor dir is owned by its module, so it is cleared
// first and files removed upstream do not linger. Exits 1 when a module repo
// is not on disk (see scripts/vendor-sources.mjs for how it is found).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MODULES, vendorDir, findSource } from './vendor-sources.mjs';

const only = process.argv[2];
const mods = MODULES.filter((m) => !only || m.name === only);
if (!mods.length) {
  console.error('unknown module: ' + only + ' (known: ' + MODULES.map((m) => m.name).join(', ') + ')');
  process.exit(1);
}

let missing = 0;
for (const mod of mods) {
  const src = findSource(mod);
  if (!src) {
    console.error(mod.name + ' not found. Clone spendolas/' + mod.name + ' into ../../' + mod.name
      + ' (the Tools folder next to "AE Tools") or set ' + mod.env + '.');
    missing++;
    continue;
  }
  const dest = vendorDir(mod.name);
  fs.rmSync(dest, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(src, 'scripts', 'vendor.mjs'), dest], { stdio: 'inherit' });
}
process.exit(missing ? 1 : 0);
