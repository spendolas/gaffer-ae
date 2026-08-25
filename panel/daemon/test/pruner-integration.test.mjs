import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneSessionFile } from '../session-pruner.js';

test('resumed transcript stays API-valid after prune: pairing intact, images gone', () => {
  var lines = [];
  // 8 capture->read image cycles, interleaved with agent text (must survive).
  for (var i = 0; i < 8; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'checking frame ' + i }, { type: 'tool_use', id: 'r' + i, name: 'Read', input: { file_path: '/tmp/frame' + i + '.png' } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'r' + i, type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(80 * 1024) } }] }] } }));
  }
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-int-'));
  var file = join(dir, 'sess.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');

  var res = pruneSessionFile('sess', { file, keepRecent: 2 });
  assert.equal(res.stubbed, 6);

  var out = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  // Every tool_result still has its matching tool_use id (pairing preserved).
  var useIds = new Set(), resultIds = new Set();
  for (var o of out) for (var b of o.message.content) {
    if (b.type === 'tool_use') useIds.add(b.id);
    if (b.type === 'tool_result') resultIds.add(b.tool_use_id);
  }
  for (var id of resultIds) assert.ok(useIds.has(id), 'result ' + id + ' still paired');
  // Agent text blocks all survive.
  var texts = out.flatMap(o => o.message.content).filter(b => b.type === 'text' && /checking frame/.test(b.text));
  assert.equal(texts.length, 8);
  // Only 2 images remain inline.
  var imgs = out.flatMap(o => o.message.content).flatMap(b => Array.isArray(b.content) ? b.content : []).filter(c => c.type === 'image');
  assert.equal(imgs.length, 2);
});
