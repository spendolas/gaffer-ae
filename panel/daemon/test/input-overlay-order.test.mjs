// The stack above the chat input has one correct order, from the input row
// upward: reply quote tray -> update banner -> attachment preview. It is pinned
// by CSS `order` (not markup position) so a markup move can't silently change
// what the user sees — this test guards the pinning itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(
  fileURLToPath(new URL('../../index.html', import.meta.url)),
  'utf8'
);

function overlayOrder(selector) {
  const re = new RegExp(
    '\\.input-overlays\\s*>\\s*\\' + selector + '\\s*\\{[^}]*order:\\s*(\\d+)'
  );
  const m = html.match(re);
  assert.ok(m, 'no `order` pinned for .input-overlays > ' + selector);
  return Number(m[1]);
}

test('input overlays stack quotes closest to the input, attachments furthest', () => {
  const paste = overlayOrder('.paste-preview-row');
  const banner = overlayOrder('.update-banner');
  const quotes = overlayOrder('.reply-quotes');

  // Flex column: a lower `order` sits higher in the stack, i.e. further from
  // the input row.
  assert.ok(paste < banner, 'attachment preview must sit above the update banner');
  assert.ok(banner < quotes, 'update banner must sit above the reply quote tray');
});

test('all three overlays live in the .input-overlays container', () => {
  const container = html.match(/<div class="input-overlays">([\s\S]*?)\n    <\/div>/);
  assert.ok(container, 'could not find the .input-overlays markup block');
  for (const id of ['pastePreviewRow', 'updateBanner', 'replyQuotes']) {
    assert.ok(container[1].includes(id), id + ' is not inside .input-overlays');
  }
});
