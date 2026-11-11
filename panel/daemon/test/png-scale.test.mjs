import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { encodePng, decodePng, scaleRgba, fitPng, pngSize } from '../png-scale.js';

function gradient(w, h, alpha) {
  var px = new Uint8Array(w * h * 4);
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var o = (y * w + x) * 4;
    px[o] = (x * 7) & 255; px[o + 1] = (y * 5) & 255; px[o + 2] = ((x + y) * 3) & 255;
    px[o + 3] = alpha ? ((x * 11 + y) & 255) : 255;
  }
  return px;
}

test('encode then decode round trips, for every PNG filter type, opaque and with alpha', () => {
  [false, true].forEach(function (alpha) {
    var src = gradient(37, 23, alpha);
    for (var f = 0; f <= 4; f++) {
      var png = encodePng(src, 37, 23, { filter: f });
      var back = decodePng(png);
      assert.ok(back, 'filter ' + f);
      assert.equal(back.width, 37);
      assert.equal(back.height, 23);
      assert.deepEqual(Buffer.from(back.rgba), Buffer.from(src), 'filter ' + f + ' alpha=' + alpha);
    }
    var adaptive = decodePng(encodePng(src, 37, 23));
    assert.deepEqual(Buffer.from(adaptive.rgba), Buffer.from(src));
  });
});

test('decodes a PNG written independently (8-bit RGB, filter 0, via node:zlib)', () => {
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
  var img = decodePng(png);
  assert.deepEqual(pngSize(png), { width: 4, height: 2 });
  assert.equal(img.rgba[0], 0); assert.equal(img.rgba[1], 10); assert.equal(img.rgba[2], 20); assert.equal(img.rgba[3], 255);
  assert.equal(img.rgba[(1 * 4 + 1) * 4], 31, 'row 1, pixel 1, R');
});

test('decodePng: not a png, truncated and interlaced inputs return null instead of throwing', () => {
  assert.equal(decodePng(Buffer.from('hello')), null);
  assert.equal(decodePng(null), null);
  var png = encodePng(gradient(8, 8), 8, 8);
  assert.equal(decodePng(png.subarray(0, 40)), null);
  var inter = Buffer.from(png); inter[28] = 1;
  assert.equal(decodePng(inter), null);
});

test('scaleRgba: averages boxes and keeps a flat colour flat', () => {
  var flat = new Uint8Array(8 * 8 * 4).fill(0);
  for (var i = 0; i < 64; i++) { flat[i * 4] = 200; flat[i * 4 + 1] = 100; flat[i * 4 + 2] = 50; flat[i * 4 + 3] = 255; }
  var small = scaleRgba(flat, 8, 8, 3, 3);
  for (var j = 0; j < 9; j++) assert.deepEqual(Array.from(small.subarray(j * 4, j * 4 + 4)), [200, 100, 50, 255]);
  // 2x2 black/white checker averages to mid grey
  var chk = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  var one = scaleRgba(chk, 2, 2, 1, 1);
  assert.ok(Math.abs(one[0] - 128) <= 1);
});

test('scaleRgba: transparent pixels do not drag colour toward black', () => {
  var px = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]); // one opaque red, one clear black
  var one = scaleRgba(px, 2, 1, 1, 1);
  assert.equal(one[0], 255);
  assert.ok(one[3] >= 127 && one[3] <= 128);
});

test('fitPng: a small png comes back untouched, a big one is scaled to the longest edge', () => {
  var small = encodePng(gradient(40, 30), 40, 30);
  var r = fitPng(small, { maxEdge: 100 });
  assert.equal(r.scaled, false);
  assert.equal(r.data, small);

  var big = encodePng(gradient(400, 200), 400, 200);
  var s = fitPng(big, { maxEdge: 100 });
  assert.equal(s.scaled, true);
  assert.equal(s.width, 100);
  assert.equal(s.height, 50);
  assert.deepEqual(pngSize(s.data), { width: 100, height: 50 });
});

test('fitPng: keeps shrinking until the byte budget is met', () => {
  var noisy = new Uint8Array(600 * 600 * 4);
  var seed = 1;
  for (var i = 0; i < noisy.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noisy[i] = i % 4 === 3 ? 255 : (seed >> 16) & 255; }
  var png = encodePng(noisy, 600, 600);
  var r = fitPng(png, { maxEdge: 600, maxBytes: 300000 });
  assert.ok(r.scaled);
  assert.ok(r.data.length <= 300000, 'got ' + r.data.length);
});

test('fitPng: undecodable png yields null so the caller can decide', () => {
  var png = encodePng(gradient(50, 50), 50, 50);
  var inter = Buffer.from(png); inter[28] = 1;
  assert.equal(fitPng(inter, { maxEdge: 10 }), null);
  assert.equal(fitPng(Buffer.from('nope'), {}), null);
});
