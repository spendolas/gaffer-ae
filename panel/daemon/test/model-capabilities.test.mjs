import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelCapability, modelCatalogOptions } from '../chat-handler.js';

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

test('live Anthropic catalog supplies versions, context, and per-model effort', () => {
  const result = modelCatalogOptions({ data: [
    {
      id: 'claude-opus-5', display_name: 'Claude Opus 5', max_input_tokens: 1000000,
      max_tokens: 128000, capabilities: { effort: {
        supported: true, low: { supported: true }, medium: { supported: true },
        high: { supported: true }, xhigh: { supported: true }, max: { supported: true },
      } },
    },
    {
      id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', max_input_tokens: 1000000,
      max_tokens: 128000, capabilities: { effort: {
        supported: true, low: { supported: true }, medium: { supported: true },
        high: { supported: true }, xhigh: { supported: false }, max: { supported: true },
      } },
    },
    {
      id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_input_tokens: 200000,
      max_tokens: 64000, capabilities: { effort: { supported: false } },
    },
  ] });
  assert.deepEqual(result.models, ['opus', 'haiku']);
  assert.deepEqual(result.versions.opus, ['claude-opus-5', 'claude-opus-4-6']);
  assert.deepEqual(result.capabilitiesByModel.opus.efforts,
    ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(result.capabilitiesByModel['claude-opus-4-6'].efforts,
    ['low', 'medium', 'high', 'max']);
  assert.equal(result.capabilitiesByModel.opus.oneM, true);
  assert.equal(result.capabilitiesByModel.haiku.oneM, false);
  assert.deepEqual(result.capabilitiesByModel.haiku.efforts, []);
  assert.equal(result.capabilitySource, 'anthropic-v1-models');
  assert.equal(result.live, true);
});
