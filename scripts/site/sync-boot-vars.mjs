// Keeps the inline boot-vars block in site/index.html equal to the CSS variables
// that configToCssVars(defaults) produces. The block lets the first paint be fully
// styled before the module script runs. After changing config defaults, run:
//   node scripts/site/sync-boot-vars.mjs        (rewrite the block)
//   node scripts/site/sync-boot-vars.mjs --check (exit 1 when out of date)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaults, configToCssVars } from '../../site/js/config.js';

export const BEGIN = '/* boot-vars:begin */';
export const END = '/* boot-vars:end */';

export function renderBlock(vars) {
  const lines = Object.entries(vars).map(([name, value]) => `    ${name}: ${value};`);
  return `${BEGIN}\n    :root {\n${lines.map((l) => '  ' + l).join('\n')}\n    }\n    ${END}`;
}

// Returns the html with the block between the markers replaced, or null when the markers are missing.
export function syncHtml(html, vars) {
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return html.slice(0, start) + renderBlock(vars) + html.slice(end + END.length);
}

export function isInSync(html, vars) {
  return syncHtml(html, vars) === html;
}

const indexUrl = new URL('../../site/index.html', import.meta.url);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = readFileSync(indexUrl, 'utf8');
  const vars = configToCssVars(defaults);
  const next = syncHtml(html, vars);
  if (next === null) {
    console.error('boot-vars markers not found in site/index.html');
    process.exit(1);
  }
  const count = Object.keys(vars).length;
  if (process.argv.includes('--check')) {
    if (next === html) console.log(`boot-vars up to date (${count} variables)`);
    else { console.error('boot-vars out of date: run node scripts/site/sync-boot-vars.mjs'); process.exit(1); }
  } else if (next === html) {
    console.log(`boot-vars already up to date (${count} variables)`);
  } else {
    writeFileSync(indexUrl, next);
    console.log(`boot-vars rewritten (${count} variables)`);
  }
}
