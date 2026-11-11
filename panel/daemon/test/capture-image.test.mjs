import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { encodePng, pngSize } from '../png-scale.js';
import { loadImageForModel, captureContent, MAX_IMAGE_EDGE } from '../capture-image.js';
import { register as registerFrame } from '../tools/captureFrame.js';
import { register as registerLayer } from '../tools/captureLayer.js';
import { register as registerComp } from '../tools/captureActiveComp.js';

function flat(w, h) {
  var px = new Uint8Array(w * h * 4);
  for (var i = 0; i < w * h; i++) { px[i * 4] = 10; px[i * 4 + 1] = 120; px[i * 4 + 2] = 220; px[i * 4 + 3] = 255; }
  return px;
}

function pngFile(w, h) {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-test-cap-'));
  var p = join(dir, 'frame.png');
  writeFileSync(p, encodePng(flat(w, h), w, h));
  return p;
}

test('loadImageForModel: small png passes through, big png is scaled to the edge limit', () => {
  var small = loadImageForModel(pngFile(64, 32));
  assert.equal(small.mediaType, 'image/png');
  assert.deepEqual(pngSize(Buffer.from(small.data, 'base64')), { width: 64, height: 32 });
  var big = loadImageForModel(pngFile(3200, 1800));
  var size = pngSize(Buffer.from(big.data, 'base64'));
  assert.equal(Math.max(size.width, size.height), MAX_IMAGE_EDGE);
});

test('loadImageForModel: a missing or non-image file is null, never a throw', () => {
  assert.equal(loadImageForModel(join(tmpdir(), 'gaffer-does-not-exist.png')), null);
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-test-cap-'));
  var p = join(dir, 'x.png');
  writeFileSync(p, 'not an image');
  assert.equal(loadImageForModel(p), null);
});

test('captureContent: text then an MCP image block; a failed load says so in text, with no file path to chase', () => {
  var good = captureContent({ ok: true, path: pngFile(50, 50), width: 50, height: 50 });
  assert.equal(good[0].type, 'text');
  assert.equal(good[1].type, 'image');
  assert.equal(good[1].mimeType, 'image/png');
  assert.equal(Buffer.from(good[1].data, 'base64').subarray(1, 4).toString(), 'PNG');
  var bad = captureContent({ ok: true, path: join(tmpdir(), 'gaffer-nope.png') });
  assert.equal(bad.length, 1);
  assert.match(bad[0].text, /could not be attached as an image/);
});

// Drives each registered capture tool with a fake server and queue.
function toolHandler(register, name, inner) {
  var handlers = {};
  var server = { registerTool: function (n, def, fn) { handlers[n] = fn; } };
  var queue = { enqueue: async function () { return JSON.stringify({ ok: true, result: JSON.stringify(inner) }); } };
  register(server, queue, z);
  return handlers[name];
}

[
  ['captureFrame', registerFrame, {}],
  ['captureLayer', registerLayer, { layerIndex: 1 }],
  ['captureActiveComp', registerComp, {}],
].forEach(function (row) {
  test(row[0] + ': returns the frame as MCP image content', async () => {
    var inner = { ok: true, path: pngFile(2400, 1200), width: 2400, height: 1200 };
    var res = await toolHandler(row[1], row[0], inner)(row[2]);
    assert.notEqual(res.isError, true);
    var img = res.content.filter(function (c) { return c.type === 'image'; });
    assert.equal(img.length, 1);
    assert.equal(img[0].mimeType, 'image/png');
    var size = pngSize(Buffer.from(img[0].data, 'base64'));
    assert.ok(Math.max(size.width, size.height) <= MAX_IMAGE_EDGE);
    assert.equal(JSON.parse(res.content[0].text).ok, true);
    // the text says what size the (scaled) image is, next to the comp's own size
    assert.deepEqual(JSON.parse(res.content[0].text).imageSize, { width: size.width, height: size.height });
    assert.equal(JSON.parse(res.content[0].text).width, 2400);
  });

  test(row[0] + ': an After Effects error stays a text error with no image', async () => {
    var res = await toolHandler(row[1], row[0], { error: 'No active composition' })(row[2]);
    assert.equal(res.isError, true);
    assert.equal(res.content.filter(function (c) { return c.type === 'image'; }).length, 0);
  });
});
