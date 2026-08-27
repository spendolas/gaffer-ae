// Build panel/icons.js (the GafferIcons map) from design/refs/svg/icon-<key>.svg,
// which are exported straight from the Figma "Icon" COMPONENT_SET (page Gaffer,
// node 246:4094) via grip. Re-run after re-exporting:
//   node design/scripts/build-icons.mjs
//
// Normalization → the panel convention: 16x16 viewBox, no width/height (CSS
// sizes .gicon), the single design colour (#DDDDDD = text/light) swapped for
// currentColor so the glyph inherits its context, collapsed to one line.
// `star` is the LED glyph (12x12), not part of the Icon set — preserved here.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SVG_DIR = join(__dirname, '..', 'refs', 'svg');
const OUT = join(__dirname, '..', '..', 'panel', 'icons.js');

const STAR = '<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 0C6 3.31371 8.68629 6 12 6C8.68629 6 6 8.68629 6 12C6 8.68629 3.31371 6 0 6C3.31371 6 6 3.31371 6 0Z" fill="currentColor"/></svg>';

function normalize(svg) {
  return svg
    .replace(/\s+width="[^"]*"/i, '')
    .replace(/\s+height="[^"]*"/i, '')
    .replace(/#DDDDDD/gi, 'currentColor')
    .replace(/>\s+</g, '><')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Only the clean icon-<key>.svg files (letters only) — skips the legacy
// icon-<name>.<nodeid>.svg exports and the type-* button sources.
const files = readdirSync(SVG_DIR).filter((f) => /^icon-[A-Za-z]+\.svg$/.test(f));
const icons = {};
for (const f of files) {
  const key = f.replace(/^icon-/, '').replace(/\.svg$/, '');
  const svg = normalize(readFileSync(join(SVG_DIR, f), 'utf8'));
  if (!/^<svg[\s\S]*<\/svg>$/.test(svg)) throw new Error('malformed SVG for ' + key + ': ' + svg.slice(0, 60));
  icons[key] = svg;
}
icons.star = STAR;

const keys = Object.keys(icons).sort();
const body = keys.map((k) => '  ' + k + ': ' + JSON.stringify(icons[k]) + ',').join('\n');
const out =
  '// Generated from design/refs/svg/icon-*.svg (Figma "Icon" set 246:4094, page Gaffer)\n' +
  '// by design/scripts/build-icons.mjs — do not hand-edit. Re-run after re-exporting.\n' +
  '// 16x16 viewBox (star 12x12), stroke/fill = currentColor.\n' +
  'var GafferIcons = {\n' + body + '\n};\n';
writeFileSync(OUT, out);
console.log('wrote ' + OUT + ' — ' + keys.length + ' icons: ' + keys.join(', '));
