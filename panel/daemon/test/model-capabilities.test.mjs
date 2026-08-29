import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelCapability } from '../chat-handler.js';

test('model capabilities gate 1M and effort by Claude model generation', () => {
  assert.deepEqual(modelCapability('claude-haiku-4-5-20251001', null), {
    oneM: false,
    contextWindows: [200000],
    efforts: [],
    source: 'claude-code-model-config',
    entitlement: 'plan-dependent',
  });
  assert.deepEqual(modelCapability('claude-sonnet-4-6', null).efforts,
    ['low', 'medium', 'high', 'max']);
  assert.deepEqual(modelCapability('claude-opus-4-7', null).efforts,
    ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(modelCapability('claude-opus-4-6', null).oneM, true);
});

test('bare aliases resolve against the freshest discovered version', () => {
  const versions = { opus: ['claude-opus-4-6', 'claude-opus-4-7'] };
  assert.deepEqual(modelCapability('opus', versions).efforts,
    ['low', 'medium', 'high', 'max']);
});
