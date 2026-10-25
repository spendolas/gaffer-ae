// Keeps the no-JavaScript video wall in site/index.html equal to the clips in site/items.json (the manifest
// build-manifest.mjs makes). The infinite grid needs JavaScript, but a <video autoplay muted loop> plays
// without any, so inside <noscript> the page shows a fixed full-bleed wall of the clips (their poster frame shows
// where a browser will not autoplay). H.264 only: choosing HEVC needs a script. After a clip is added or removed:
//   node scripts/site/build-manifest.mjs && node scripts/site/sync-nojs-wall.mjs        (rewrite the block)
//   node scripts/site/sync-nojs-wall.mjs --check                                        (exit 1 when out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- nojs-wall:begin -->';
export const END = '<!-- nojs-wall:end -->';

const bare = (p) => p.split('?')[0]; // the page is served without the ?v= cache stamps the script adds

// The wall: ROWS centred rows of TILES_PER_ROW tiles, each row a rotation of the clip list (offset like the
// live grid's rows), tile height a share of the window height. A centred flex row overflows equally on both
// sides, so any window width crops evenly; 16 tiles per row cover windows up to about 5:1. The two tiles in
// the middle of every row play video (about ten at once); every other tile is its clip's poster frame, and
// the repeats share the same few poster files, so the download stays small.
export const ROWS = 5;
export const TILES_PER_ROW = 16;
export const ROW_SHIFTS = [0, 3, 6, 1, 4];
const MIDDLE = [TILES_PER_ROW / 2 - 1, TILES_PER_ROW / 2];

export function wallRows(items) {
  const n = items.length;
  return Array.from({ length: ROWS }, (_, r) => Array.from({ length: TILES_PER_ROW }, (_, i) => ({
    item: items[(i + ROW_SHIFTS[r % ROW_SHIFTS.length]) % n],
    video: MIDDLE.includes(i),
  })));
}

const tile = ({ item, video }) => video
  ? `<video class="nojs-tile" width="${item.width}" height="${item.height}" src="${bare(item.video)}" poster="${bare(item.poster)}" autoplay muted loop playsinline preload="auto" disablepictureinpicture disableremoteplayback tabindex="-1"></video>`
  : `<img class="nojs-tile" width="${item.width}" height="${item.height}" src="${bare(item.poster)}" alt="">`;

export function renderBlock(items) {
  const rows = wallRows(items).map((row) => `      <div class="nojs-row">\n${row.map((t) => `        ${tile(t)}`).join('\n')}\n      </div>`);
  return `${BEGIN}
  <noscript>
    <style>
      .nojs-wall { position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; padding-top: var(--grid-gap, 16px); box-sizing: border-box; }
      .nojs-row { display: flex; flex-wrap: nowrap; justify-content: center; gap: var(--grid-gap, 16px); margin-bottom: var(--grid-gap, 16px); }
      .nojs-tile { flex: none; height: 26vh; width: auto; border-radius: var(--grid-radius, 32px); object-fit: cover; }
      .nojs-wall::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to top, var(--color-stage) 8%, transparent 32%), radial-gradient(ellipse 105% 68% at 50% 100%, var(--color-stage) 35%, transparent 100%); opacity: 0.9; }
    </style>
    <div class="nojs-wall" aria-hidden="true">
${rows.join('\n')}
    </div>
  </noscript>
  ${END}`;
}

// Returns the html with the block between the markers replaced, or null when the markers are missing.
export function syncHtml(html, items) {
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return html.slice(0, start) + renderBlock(items) + html.slice(end + END.length);
}

const indexUrl = new URL('../../site/index.html', import.meta.url);
const itemsUrl = new URL('../../site/items.json', import.meta.url);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = readFileSync(indexUrl, 'utf8');
  const items = JSON.parse(readFileSync(itemsUrl, 'utf8'));
  const next = syncHtml(html, items);
  if (next === null) { console.error('nojs-wall markers not found in site/index.html'); process.exit(1); }
  if (process.argv.includes('--check')) {
    if (next === html) console.log(`nojs wall up to date (${items.length} clips)`);
    else { console.error('nojs wall out of date: run node scripts/site/sync-nojs-wall.mjs'); process.exit(1); }
  } else if (next === html) console.log(`nojs wall already up to date (${items.length} clips)`);
  else { writeFileSync(indexUrl, next); console.log(`nojs wall rewritten (${items.length} clips)`); }
}
