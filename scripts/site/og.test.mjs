import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../../site/', import.meta.url));

// JPEG size from its first SOFn marker.
function jpegSize(buf) {
  assert.equal(buf.readUInt16BE(0), 0xFFD8, 'JPEG signature');
  let pos = 2;
  while (pos < buf.length) {
    assert.equal(buf[pos], 0xFF, 'marker');
    const marker = buf[pos + 1];
    const len = buf.readUInt16BE(pos + 2);
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  throw new Error('no SOF marker');
}

test('og.jpg is exactly 1200 x 630 and small enough for every platform', () => {
  const buf = readFileSync(site + 'og.jpg');
  assert.deepEqual(jpegSize(buf), { width: 1200, height: 630 });
  assert.ok(buf.length < 1024 * 1024, `${buf.length} bytes (under 1 MB)`);
  assert.ok(buf.length > 20 * 1024, 'not an empty image');
});
