import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { z } from 'zod';
import { encodePng, pngSize } from '../png-scale.js';
import { loadImageForModel, captureContent, imageSize, MAX_IMAGE_EDGE, MAX_UNSCALED_EDGE } from '../capture-image.js';
import { register as registerFrame } from '../tools/captureFrame.js';
import { register as registerLayer } from '../tools/captureLayer.js';
import { register as registerComp } from '../tools/captureActiveComp.js';
import { tmpDir } from './tmp.mjs';

function flat(w, h) {
  var px = new Uint8Array(w * h * 4);
  for (var i = 0; i < w * h; i++) { px[i * 4] = 10; px[i * 4 + 1] = 120; px[i * 4 + 2] = 220; px[i * 4 + 3] = 255; }
  return px;
}

async function pngFile(w, h) {
  var dir = tmpDir('gaffer-test-cap-');
  var p = join(dir, 'frame.png');
  writeFileSync(p, await encodePng(flat(w, h), w, h));
  return p;
}

function fileWith(bytes, name) {
  var dir = tmpDir('gaffer-test-cap-');
  var p = join(dir, name || 'x.bin');
  writeFileSync(p, bytes);
  return p;
}

// A PNG whose header claims w x h (grayscale 8-bit) with a tiny stream.
function claimedPng(w, h, interlace) {
  function chunk(type, data) {
    var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  }
  var ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[12] = interlace ? 1 : 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(64))), chunk('IEND', Buffer.alloc(0))]);
}

function jpegHeader(w, h) {
  var b = Buffer.alloc(30);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0; b.writeUInt16BE(17, 4); b[6] = 8; b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9);
  return b;
}
function gifHeader(w, h) { var b = Buffer.alloc(20); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; }
function webpVp8x(w, h) {
  var b = Buffer.alloc(40); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8X', 12);
  var cw = w - 1, ch = h - 1;
  b[24] = cw & 255; b[25] = (cw >> 8) & 255; b[26] = (cw >> 16) & 255; b[27] = ch & 255; b[28] = (ch >> 8) & 255; b[29] = (ch >> 16) & 255;
  return b;
}

test('loadImageForModel: a small png passes through, a big one is scaled to the edge limit', async () => {
  var small = await loadImageForModel(await pngFile(64, 32));
  assert.equal(small.mediaType, 'image/png');
  assert.deepEqual(pngSize(Buffer.from(small.data, 'base64')), { width: 64, height: 32 });
  var big = await loadImageForModel(await pngFile(3200, 1800));
  var size = pngSize(Buffer.from(big.data, 'base64'));
  assert.equal(Math.max(size.width, size.height), MAX_IMAGE_EDGE);
});

test('loadImageForModel: a missing or non-image file is an error result, never a throw', async () => {
  assert.ok((await loadImageForModel(join(tmpdir(), 'gaffer-does-not-exist.png'))).error);
  assert.ok((await loadImageForModel(fileWith('not an image'))).error);
});

test('loadImageForModel: an image that is too large and cannot be scaled is dropped with a reason', async () => {
  // 20000 x 20000 grayscale png (over the decode budget)
  var huge = await loadImageForModel(fileWith(claimedPng(20000, 20000, false), 'a.png'));
  assert.match(huge.error, /20000 by 20000/);
  // interlaced 9000 px wide png
  var inter = await loadImageForModel(fileWith(claimedPng(9000, 4, true), 'b.png'));
  assert.match(inter.error, /too large/);
  // an interlaced png that is already small is fine as is
  var ok = await loadImageForModel(fileWith(claimedPng(100, 100, true), 'c.png'));
  assert.equal(ok.error, undefined);
  assert.equal(ok.mediaType, 'image/png');
});

test('loadImageForModel: jpeg, gif and webp dimensions are checked', async () => {
  var okJpeg = await loadImageForModel(fileWith(jpegHeader(1200, 800), 'a.jpg'));
  assert.equal(okJpeg.mediaType, 'image/jpeg');
  assert.deepEqual([okJpeg.width, okJpeg.height], [1200, 800]);
  assert.match((await loadImageForModel(fileWith(jpegHeader(MAX_UNSCALED_EDGE + 1, 100), 'b.jpg'))).error, /too large/);
  assert.match((await loadImageForModel(fileWith(gifHeader(9000, 10), 'c.gif'))).error, /too large/);
  assert.match((await loadImageForModel(fileWith(webpVp8x(8001, 10), 'd.webp'))).error, /too large/);
  assert.equal((await loadImageForModel(fileWith(webpVp8x(800, 600), 'e.webp'))).mediaType, 'image/webp');
  // a jpeg whose size cannot be read is not sent
  assert.match((await loadImageForModel(fileWith(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(40)]), 'f.jpg'))).error, /size/);
});

test('imageSize: reads jpeg, gif and webp headers', () => {
  assert.deepEqual(imageSize(jpegHeader(640, 480), 'image/jpeg'), { width: 640, height: 480 });
  assert.deepEqual(imageSize(gifHeader(32, 16), 'image/gif'), { width: 32, height: 16 });
  assert.deepEqual(imageSize(webpVp8x(300, 200), 'image/webp'), { width: 300, height: 200 });
  assert.equal(imageSize(Buffer.alloc(4), 'image/jpeg'), null);
});

test('captureContent: text then an MCP image block; a failed load says why, with no file path to chase', async () => {
  var f = await pngFile(50, 50);
  var good = await captureContent({ ok: true, path: 'ignored', width: 50, height: 50 }, f);
  assert.equal(good[0].type, 'text');
  assert.equal(good[1].type, 'image');
  assert.equal(good[1].mimeType, 'image/png');
  assert.equal(Buffer.from(good[1].data, 'base64').subarray(1, 4).toString(), 'PNG');
  var bad = await captureContent({ ok: true }, join(tmpdir(), 'gaffer-nope.png'));
  assert.equal(bad.length, 1);
  assert.match(bad[0].text, /could not be attached as an image: /);
  var tooBig = await captureContent({ ok: true }, fileWith(claimedPng(20000, 20000, false), 'big.png'));
  assert.match(tooBig[0].text, /20000 by 20000/);
});

// Drives each registered capture tool with a fake server and queue.
function toolHandler(register, name, inner) {
  var handlers = {};
  var server = { registerTool: function (n, def, fn) { handlers[n] = fn; } };
  var seen = { jsx: null };
  var queue = { enqueue: async function (jsx) { seen.jsx = jsx; return JSON.stringify({ ok: true, result: JSON.stringify(inner) }); } };
  register(server, queue, z);
  var h = handlers[name];
  h.seen = seen;
  return h;
}

[
  ['captureFrame', registerFrame, {}],
  ['captureLayer', registerLayer, { layerIndex: 1 }],
  ['captureActiveComp', registerComp, {}],
].forEach(function (row) {
  test(row[0] + ': returns the frame as MCP image content, read from the path the daemon chose', async (t) => {
    // The frame is written where the daemon asked After Effects to write it
    // (the path inside the JSX it sent), not where the reply says.
    var handlers = {};
    var seenJsx = null;
    var server = { registerTool: function (n, def, fn) { handlers[n] = fn; } };
    var png = await encodePng(flat(2400, 1200), 2400, 1200);
    var queue = {
      enqueue: async function (jsx) {
        seenJsx = jsx;
        // the path is one string literal (backslashes and quotes are escaped)
        var m = /new File\(("(?:[^"\\]|\\.)*")\)/.exec(jsx);
        var outPath = JSON.parse(m[1]);
        writeFileSync(outPath, png);
        // the capture tools write into the real OS temp folder; leave nothing there
        t.after(function () { rmSync(outPath, { force: true }); });
        // a reply pointing somewhere else entirely
        return JSON.stringify({ ok: true, result: JSON.stringify({ ok: true, path: '/etc/hosts', width: 2400, height: 1200 }) });
      },
    };
    row[1](server, queue, z);
    var res = await handlers[row[0]](row[2]);
    assert.notEqual(res.isError, true);
    var img = res.content.filter(function (c) { return c.type === 'image'; });
    assert.equal(img.length, 1);
    assert.equal(img[0].mimeType, 'image/png');
    var size = pngSize(Buffer.from(img[0].data, 'base64'));
    assert.ok(Math.max(size.width, size.height) <= MAX_IMAGE_EDGE);
    assert.deepEqual(JSON.parse(res.content[0].text).imageSize, { width: size.width, height: size.height });
    assert.equal(JSON.parse(res.content[0].text).width, 2400);
  });

  test(row[0] + ': a reply that points at some other file does not make the daemon read it', async () => {
    var inner = { ok: true, path: join(tmpDir('gaffer-test-cap-'), 'other.png'), width: 10, height: 10 };
    writeFileSync(inner.path, await encodePng(flat(10, 10), 10, 10));
    var res = await toolHandler(row[1], row[0], inner)(row[2]);
    assert.equal(res.content.filter(function (c) { return c.type === 'image'; }).length, 0);
    assert.match(res.content[0].text, /could not be attached/);
  });

  test(row[0] + ': an After Effects error stays a text error with no image', async () => {
    var res = await toolHandler(row[1], row[0], { error: 'No active composition' })(row[2]);
    assert.equal(res.isError, true);
    assert.equal(res.content.filter(function (c) { return c.type === 'image'; }).length, 0);
  });
});
