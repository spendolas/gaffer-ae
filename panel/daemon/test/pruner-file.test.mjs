import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneSessionFile, findTranscript } from '../session-pruner.js';

function bigImageTranscript(sessionId, nImages) {
  var lines = [];
  for (var i = 0; i < nImages; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't' + i, name: 'Read', input: { file_path: '/tmp/f' + i + '.png' } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 't' + i, type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(60 * 1024) } }] }] } }));
  }
  return lines.join('\n') + '\n';
}

test('rewrites a large file, writes .bak, result still valid JSONL', () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-prune-'));
  var file = join(dir, 'sess.jsonl');
  writeFileSync(file, bigImageTranscript('sess', 12));
  var before = statSync(file).size;
  var res = pruneSessionFile('sess', { file, keepRecent: 3 });
  assert.ok(res && res.stubbed === 9);
  assert.ok(existsSync(file + '.bak'));
  var after = statSync(file).size;
  assert.ok(after < before / 2); // most bytes gone
  for (var line of readFileSync(file, 'utf8').split('\n')) { if (line.trim()) JSON.parse(line); } // all parse
  assert.equal(readFileSync(file + '.bak', 'utf8').length, before); // bak is the original
});

test('skips files under the floor', () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-prune-'));
  var file = join(dir, 'small.jsonl');
  writeFileSync(file, JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
  assert.equal(pruneSessionFile('small', { file }), null);
  assert.equal(existsSync(file + '.bak'), false);
});

test('no-op when there is nothing to stub (returns null, no write)', () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-prune-'));
  var file = join(dir, 'notext.jsonl');
  writeFileSync(file, (JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(600 * 1024) }] } }) + '\n'));
  assert.equal(pruneSessionFile('notext', { file, keepRecent: 0 }), null);
  assert.equal(existsSync(file + '.bak'), false);
});

test('missing file returns null, never throws', () => {
  assert.equal(pruneSessionFile('nope', { file: '/does/not/exist.jsonl' }), null);
});

test('findTranscript scans project dirs incl. spaced paths', () => {
  var home = mkdtempSync(join(tmpdir(), 'gaffer-home-'));
  var proj = join(home, '.claude', 'projects', '-Some-Path-With Space');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'uuid-123.jsonl'), '{}\n');
  var found = findTranscript('uuid-123', { home });
  assert.equal(found, join(proj, 'uuid-123.jsonl'));
});
