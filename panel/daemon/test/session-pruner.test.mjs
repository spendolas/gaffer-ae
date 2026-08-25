import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneTranscriptLines } from '../session-pruner.js';

// Helpers to build realistic transcript lines.
function toolUseLine(id, path) {
  return JSON.stringify({ type: 'assistant', uuid: 'a-' + id, message: { role: 'assistant', content: [
    { type: 'tool_use', id, name: 'Read', input: { file_path: path } },
  ] } });
}
function imageResultLine(id, kb) {
  var data = 'A'.repeat(kb * 1024); // base64-ish filler
  return JSON.stringify({ type: 'user', uuid: 'u-' + id, toolUseResult: { note: 'bookkeeping' }, message: { role: 'user', content: [
    { tool_use_id: id, type: 'tool_result', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ] },
  ] } });
}

test('stubs image blocks in tool_result arrays outside the recency window', () => {
  var lines = [];
  for (var i = 0; i < 10; i++) { lines.push(toolUseLine('t' + i, '/tmp/f' + i + '.png')); lines.push(imageResultLine('t' + i, 20)); }
  var res = pruneTranscriptLines(lines, { keepRecent: 3 });
  assert.equal(res.images, 10);
  assert.equal(res.kept, 3);
  assert.equal(res.stubbed, 7);
  assert.equal(res.lines.length, lines.length); // line count invariant
});

test('stubbed block becomes a text pointer naming the path, image gone', () => {
  var lines = [toolUseLine('x1', '/tmp/frame.png'), imageResultLine('x1', 50)];
  var res = pruneTranscriptLines(lines, { keepRecent: 0 });
  var obj = JSON.parse(res.lines[1]);
  var block = obj.message.content[0].content[0];
  assert.equal(block.type, 'text');
  assert.equal(block.source, undefined);
  assert.match(block.text, /elided by Gaffer/);
  assert.match(block.text, /\/tmp\/frame\.png/);
  assert.equal(obj.message.content[0].tool_use_id, 'x1'); // pairing preserved
});

test('keeps the most recent K images byte-for-byte', () => {
  var lines = [toolUseLine('a', '/a.png'), imageResultLine('a', 20), toolUseLine('b', '/b.png'), imageResultLine('b', 20)];
  var res = pruneTranscriptLines(lines, { keepRecent: 1 });
  var kept = JSON.parse(res.lines[3]).message.content[0].content[0];
  assert.equal(kept.type, 'image'); // newest survives
  var stubbed = JSON.parse(res.lines[1]).message.content[0].content[0];
  assert.equal(stubbed.type, 'text');
});

test('non-image tool_results and text blocks are untouched', () => {
  var textLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } });
  var res = pruneTranscriptLines([textLine], { keepRecent: 0 });
  assert.equal(res.stubbed, 0);
  assert.equal(res.lines[0], textLine); // verbatim
});

test('malformed lines pass through verbatim', () => {
  var res = pruneTranscriptLines(['not json{{{', ''], { keepRecent: 0 });
  assert.equal(res.lines[0], 'not json{{{');
  assert.equal(res.lines[1], '');
  assert.equal(res.stubbed, 0);
});

test('bare inline image block is stubbed too', () => {
  var line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(20480) } }] } });
  var res = pruneTranscriptLines([line], { keepRecent: 0 });
  assert.equal(res.stubbed, 1);
  assert.equal(JSON.parse(res.lines[0]).message.content[0].type, 'text');
});

test('keepRecent >= images.length stubs nothing, all images kept', () => {
  var lines = [toolUseLine('a', '/a.png'), imageResultLine('a', 20), toolUseLine('b', '/b.png'), imageResultLine('b', 20)];
  var res = pruneTranscriptLines(lines, { keepRecent: 5 });
  assert.equal(res.images, 2);
  assert.equal(res.kept, 2);
  assert.equal(res.stubbed, 0);
  assert.equal(res.lines.length, lines.length);
  // All lines should be byte-for-byte identical since nothing was touched
  for (var i = 0; i < lines.length; i++) {
    assert.equal(res.lines[i], lines[i], 'line ' + i + ' should be unchanged');
  }
});

test('untouched lines with tricky numbers round-trip byte-for-byte', () => {
  var trickyLine = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"n"}]},"n":123456789012345678}';
  var lines = [toolUseLine('a', '/a.png'), imageResultLine('a', 20), trickyLine];
  var res = pruneTranscriptLines(lines, { keepRecent: 0 });
  assert.equal(res.lines[2], trickyLine, 'untouched line with bigint must be byte-for-byte identical');
  assert.equal(res.stubbed, 1);
});
