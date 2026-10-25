import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncHtml, wallRows, renderBlock, ROWS, TILES_PER_ROW, BEGIN, END } from './sync-nojs-wall.mjs';

const site = fileURLToPath(new URL('../../site/', import.meta.url));
const html = readFileSync(join(site, 'index.html'), 'utf8');
const items = JSON.parse(readFileSync(join(site, 'items.json'), 'utf8'));
const block = html.slice(html.indexOf(BEGIN), html.indexOf(END) + END.length);

test('the no-JS wall in index.html is in step with the clips (run node scripts/site/sync-nojs-wall.mjs when this fails)', () => {
  assert.ok(html.includes(BEGIN) && html.includes(END));
  assert.equal(syncHtml(html, items), html);
});

test('the wall is ROWS full rows, every clip plays somewhere, and the rest are poster frames', () => {
  const rows = wallRows(items);
  assert.equal(rows.length, ROWS);
  for (const row of rows) assert.equal(row.length, TILES_PER_ROW);
  const playing = new Set(rows.flat().filter((t) => t.video).map((t) => t.item.id));
  assert.deepEqual([...playing].sort(), items.map((i) => i.id).sort(), 'all clips play at least once, in the middle of a row');
  assert.equal((block.match(/<video /g) || []).length, rows.flat().filter((t) => t.video).length);
  assert.equal((block.match(/<img /g) || []).length, rows.flat().filter((t) => !t.video).length);
  assert.equal((block.match(/class="nojs-row"/g) || []).length, ROWS);
});

test('the wall works without scripts: muted looping autoplay, decorative, no script, only files that exist', () => {
  assert.doesNotMatch(block, /<script/);
  assert.match(block, /^\s*<!-- nojs-wall:begin -->\s*<noscript>/);
  assert.match(block, /<div class="nojs-wall" aria-hidden="true">/);
  for (const v of block.match(/<video [^>]*>/g)) {
    for (const attr of ['autoplay', 'muted', 'loop', 'playsinline']) assert.ok(v.includes(` ${attr}`), `${attr}: ${v}`);
  }
  for (const m of block.matchAll(/(?:src|poster)="([^"]+)"/g)) {
    assert.doesNotMatch(m[1], /\?/, 'no cache stamps: the page is served as is');
    if (!m[1].includes('_generated')) assert.ok(existsSync(join(site, m[1])), m[1]); // posters are generated at deploy
  }
  assert.ok(renderBlock(items).length > 5000);
});
