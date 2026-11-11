import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { encodePng, decodePng, scaleRgba, fitPng, pngSize, MAX_DECODE_PIXELS } from '../png-scale.js';

function gradient(w, h, alpha) {
  var px = new Uint8Array(w * h * 4);
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var o = (y * w + x) * 4;
    px[o] = (x * 7) & 255; px[o + 1] = (y * 5) & 255; px[o + 2] = ((x + y) * 3) & 255;
    px[o + 3] = alpha ? ((x * 11 + y) & 255) : 255;
  }
  return px;
}

test('encode then decode round trips, for every PNG filter type, opaque and with alpha', async () => {
  for (var alpha of [false, true]) {
    var src = gradient(37, 23, alpha);
    for (var f = 0; f <= 4; f++) {
      var png = await encodePng(src, 37, 23, { filter: f });
      var back = await decodePng(png);
      assert.ok(back, 'filter ' + f);
      assert.equal(back.width, 37);
      assert.equal(back.height, 23);
      assert.deepEqual(Buffer.from(back.rgba), Buffer.from(src), 'filter ' + f + ' alpha=' + alpha);
    }
    var adaptive = await decodePng(await encodePng(src, 37, 23));
    assert.deepEqual(Buffer.from(adaptive.rgba), Buffer.from(src));
  }
});

test('decodes a PNG written independently (8-bit RGB, filter 0, via node:zlib)', async () => {
  var w = 4, h = 2, rows = [];
  for (var y = 0; y < h; y++) { rows.push(Buffer.from([0])); rows.push(Buffer.from(Array.from({ length: w * 3 }, function (_, i) { return i * 10 + y; }))); }
  var idat = deflateSync(Buffer.concat(rows));
  function chunk(type, data) {
    var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    var body = Buffer.concat([Buffer.from(type), data]);
    // CRC is not checked by the decoder, a zero CRC is enough here.
    return Buffer.concat([len, body, Buffer.alloc(4)]);
  }
  var ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  var png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  var img = await decodePng(png);
  assert.deepEqual(pngSize(png), { width: 4, height: 2 });
  assert.equal(img.rgba[0], 0); assert.equal(img.rgba[1], 10); assert.equal(img.rgba[2], 20); assert.equal(img.rgba[3], 255);
  assert.equal(img.rgba[(1 * 4 + 1) * 4], 31, 'row 1, pixel 1, R');
});

test('decodePng: not a png, truncated and interlaced inputs return null instead of throwing', async () => {
  assert.equal(await decodePng(Buffer.from('hello')), null);
  assert.equal(await decodePng(null), null);
  var png = await encodePng(gradient(8, 8), 8, 8);
  assert.equal(await decodePng(png.subarray(0, 40)), null);
  var inter = Buffer.from(png); inter[28] = 1;
  assert.equal(await decodePng(inter), null);
});

test('scaleRgba: averages boxes and keeps a flat colour flat', async () => {
  var flat = new Uint8Array(8 * 8 * 4).fill(0);
  for (var i = 0; i < 64; i++) { flat[i * 4] = 200; flat[i * 4 + 1] = 100; flat[i * 4 + 2] = 50; flat[i * 4 + 3] = 255; }
  var small = await scaleRgba(flat, 8, 8, 3, 3);
  for (var j = 0; j < 9; j++) assert.deepEqual(Array.from(small.subarray(j * 4, j * 4 + 4)), [200, 100, 50, 255]);
  // 2x2 black/white checker averages to mid grey
  var chk = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  var one = await scaleRgba(chk, 2, 2, 1, 1);
  assert.ok(Math.abs(one[0] - 128) <= 1);
});

test('scaleRgba: transparent pixels do not drag colour toward black', async () => {
  var px = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]); // one opaque red, one clear black
  var one = await scaleRgba(px, 2, 1, 1, 1);
  assert.equal(one[0], 255);
  assert.ok(one[3] >= 127 && one[3] <= 128);
});

test('fitPng: a small png comes back untouched, a big one is scaled to the longest edge', async () => {
  var small = await encodePng(gradient(40, 30), 40, 30);
  var r = await fitPng(small, { maxEdge: 100 });
  assert.equal(r.scaled, false);
  assert.equal(r.data, small);

  var big = await encodePng(gradient(400, 200), 400, 200);
  var s = await fitPng(big, { maxEdge: 100 });
  assert.equal(s.scaled, true);
  assert.equal(s.width, 100);
  assert.equal(s.height, 50);
  assert.deepEqual(pngSize(s.data), { width: 100, height: 50 });
});

test('fitPng: keeps shrinking until the byte budget is met', async () => {
  var noisy = new Uint8Array(600 * 600 * 4);
  var seed = 1;
  for (var i = 0; i < noisy.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noisy[i] = i % 4 === 3 ? 255 : (seed >> 16) & 255; }
  var png = await encodePng(noisy, 600, 600);
  var r = await fitPng(png, { maxEdge: 600, maxBytes: 300000 });
  assert.ok(r.scaled);
  assert.ok(r.data.length <= 300000, 'got ' + r.data.length);
});

test('fitPng: undecodable png yields null so the caller can decide', async () => {
  var png = await encodePng(gradient(50, 50), 50, 50);
  var inter = Buffer.from(png); inter[28] = 1;
  assert.equal(await fitPng(inter, { maxEdge: 10 }), null);
  assert.equal(await fitPng(Buffer.from('nope'), {}), null);
});

// ---- Bounded work: oversized and decompression-bomb inputs ----------------

// A PNG whose header claims w x h pixels (8-bit RGBA) with `idatRaw` as the
// uncompressed scanline data. The CRC is not checked by the decoder.
function claimingPng(w, h, idatRaw) {
  function chunk(type, data) {
    var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  }
  var ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(idatRaw)), chunk('IEND', Buffer.alloc(0))]);
}

test('a header that claims more than the pixel budget is refused before anything is inflated', async () => {
  var rssBefore = process.memoryUsage().rss;
  var t0 = Date.now();
  // 16384 x 16384 claimed, a 1 KB file: must not allocate or inflate 1 GB
  var tiny = claimingPng(16384, 16384, Buffer.alloc(64));
  assert.equal(await decodePng(tiny), null);
  assert.equal(await fitPng(tiny, { maxEdge: 1568 }), null);
  // just over the budget
  var side = Math.ceil(Math.sqrt(MAX_DECODE_PIXELS)) + 1;
  assert.equal(await decodePng(claimingPng(side, side, Buffer.alloc(64))), null);
  assert.ok(Date.now() - t0 < 500, 'refused fast, took ' + (Date.now() - t0) + ' ms');
  assert.ok(process.memoryUsage().rss - rssBefore < 150 * 1024 * 1024, 'no large allocation');
});

test('a decompression bomb (data far larger than the header implies) is cut off, not inflated', async () => {
  // header says 100 x 100 (40 KB of scanlines), the stream inflates to 300 MB of zeros
  var bomb = claimingPng(100, 100, Buffer.alloc(300 * 1024 * 1024));
  assert.ok(bomb.length < 1024 * 1024, 'the file itself is small');
  if (global.gc) global.gc();
  var before = process.memoryUsage().rss;
  var t0 = Date.now();
  assert.equal(await decodePng(bomb), null);
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms');
  assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024, 'inflate output stayed capped');
});

test('decoding a large frame yields to the event loop (other work keeps running)', async () => {
  var w = 2400, h = 1600;
  var png = await encodePng(gradient(w, h), w, h);
  var gaps = [], last = Date.now();
  var timer = setInterval(function () { var now = Date.now(); gaps.push(now - last); last = now; }, 5);
  var r = await fitPng(png, { maxEdge: 1000 });
  clearInterval(timer);
  assert.ok(r && r.scaled);
  assert.ok(gaps.length > 5, 'timer ran during the work');
  assert.ok(Math.max.apply(null, gaps) < 400, 'longest stall ' + Math.max.apply(null, gaps) + ' ms');
});
