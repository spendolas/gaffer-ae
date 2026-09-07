import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextTokensFromUsage } from '../chat-handler.js';

// Mirrors COMPACT_THRESHOLD_TOKENS in chat-handler.js (not exported).
var THRESHOLD = 150000;

test('missing / empty usage is 0-safe', () => {
  assert.equal(contextTokensFromUsage(undefined), 0);
  assert.equal(contextTokensFromUsage(null), 0);
  assert.equal(contextTokensFromUsage({}), 0);
});

test('sums uncached input + cache reads + cache writes', () => {
  assert.equal(
    contextTokensFromUsage({ input_tokens: 12, cache_read_input_tokens: 314000, cache_creation_input_tokens: 1822 }),
    315834
  );
});

test('individual missing fields do not throw', () => {
  assert.equal(contextTokensFromUsage({ cache_read_input_tokens: 300000 }), 300000);
  assert.equal(contextTokensFromUsage({ input_tokens: 5 }), 5);
});

test('THE BUG: input_tokens alone never trips the gate; the real total does', () => {
  // A warm-cache turn from the real transcript: tiny uncached slice, huge cache.
  var usage = { input_tokens: 12, cache_read_input_tokens: 314000, cache_creation_input_tokens: 1822 };
  // Old (buggy) gate read input_tokens only -> 12, never >= 150000 -> dead code.
  assert.ok(usage.input_tokens < THRESHOLD, 'uncached slice stays tiny under caching');
  // Fixed gate reads the real total -> well over the threshold -> compaction fires.
  assert.ok(contextTokensFromUsage(usage) >= THRESHOLD, 'real context size trips the gate');
});

test('a genuinely small session does NOT trip the gate (no over-compaction)', () => {
  // Early in a fresh session: modest cache, well under the wall.
  var usage = { input_tokens: 400, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1200 };
  assert.ok(contextTokensFromUsage(usage) < THRESHOLD, 'small sessions are left alone');
});
