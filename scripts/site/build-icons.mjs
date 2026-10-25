// Builds every site icon from scripts/site/icon-source.svg (the mark exported from Figma):
//   site/icon.svg              the tile as a vector, for the browser tab
//   site/favicon.ico           16, 32 and 48 px PNGs in one ICO
//   site/apple-touch-icon.png  180 px, full-bleed and opaque (iOS rounds it itself)
//   site/icon-192.png          192 px, rounded tile on transparent corners
//   site/icon-512.png          512 px, same
//   site/icon-512-maskable.png 512 px, full-bleed, glyph kept inside the central 80% safe circle
// The icons are committed; run this only when the mark changes:  node scripts/site/build-icons.mjs
// It needs Google Chrome (chrome-shot.mjs rasterises, so the PNGs are exactly what a browser draws).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withChrome } from './chrome-shot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(join(root, 'scripts/site/icon-source.svg'), 'utf8');
const MASKABLE_SCALE = 0.85; // keeps the glyph's farthest point inside the 80% safe circle (see icons.test.mjs)

// Pieces of the exported SVG: the tile rect and the glyph paths.
const rect = source.match(/<rect [^>]*\/>/)[0];
// Figma exports the outlined glyph as one <path> per closed shape; they do not overlap and share a fill, so
// they are merged into a single <path> (three subpaths) for a tidier file with no change to the drawing.
const glyphPaths = [...source.matchAll(/<path d="([^"]+)" fill="([^"]+)"\/>/g)];
const GLYPH_FILL = glyphPaths[0][2];
if (!glyphPaths.length || glyphPaths.some((m) => m[2] !== GLYPH_FILL)) throw new Error('icon-source.svg: expected glyph paths with one shared fill');
const glyph = `<path d="${glyphPaths.map((m) => m[1]).join(' ')}" fill="${GLYPH_FILL}"/>`;
const TILE = rect.match(/fill="([^"]+)"/)[1];

const iconMeta = JSON.parse(readFileSync(join(root, 'scripts/site/asset-meta.json'), 'utf8')).files['icon.svg'];
const svgDoc = (inner) => `<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">\n<title>${iconMeta.title}</title>\n<desc>${iconMeta.description}</desc>\n${inner}\n</svg>\n`;
export const variants = {
  tile: svgDoc(`${rect}\n${glyph}`),
  bleed: svgDoc(`<rect width="512" height="512" fill="${TILE}"/>\n${glyph}`),
  maskable: svgDoc(`<rect width="512" height="512" fill="${TILE}"/>\n<g transform="translate(256 256) scale(${MASKABLE_SCALE}) translate(-256 -256)">\n${glyph}\n</g>`),
};

// ICO with PNG images inside (supported by every current browser).
export function buildIco(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.data)]);
}

async function main() {
  const out = (name, data) => { writeFileSync(join(root, 'site', name), data); console.log(`wrote site/${name} (${data.length} bytes)`); };
  await withChrome(async ({ shot }) => {
    // The SVG sits in a page with a transparent background, so the corners of the rounded tile stay clear.
    const render = (svg, size) => shot({
      html: `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`,
      width: size, height: size, transparent: true, settleMs: 400,
    });
    out('icon.svg', variants.tile);
    out('apple-touch-icon.png', await render(variants.bleed, 180));
    out('icon-192.png', await render(variants.tile, 192));
    out('icon-512.png', await render(variants.tile, 512));
    out('icon-512-maskable.png', await render(variants.maskable, 512));
    const ico = [];
    for (const size of [16, 32, 48]) ico.push({ size, data: await render(variants.tile, size) });
    out('favicon.ico', buildIco(ico));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
