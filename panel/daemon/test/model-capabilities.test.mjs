import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelCapability, modelCatalogOptions, ChatHandler } from '../chat-handler.js';

test('model discovery serves the cached catalog when the token is momentarily expired', async () => {
  const handler = new ChatHandler();
  const liveCatalog = {
    models: ['opus', 'sonnet'], efforts: ['low', 'high'], effortsByModel: { opus: ['low', 'high'] },
    capabilitiesByModel: { opus: { oneM: true } }, versions: { opus: ['claude-opus-4-8'] },
    capabilitySource: 'anthropic-v1-models', entitlement: 'account-server', live: true,
  };
  // 1) A live fetch caches the catalog and returns it live.
  handler._fetchCatalog = async () => ({ catalog: liveCatalog, reason: 'ready' });
  const live = await handler.listModelOptions();
  assert.equal(live.live, true);
  assert.deepEqual(live.models, ['opus', 'sonnet']);

  // 2) Token now expired: no live catalog, but the cached one is served (usable,
  //    flagged cached) instead of failing closed.
  handler._fetchCatalog = async () => ({ catalog: null, reason: 'token-expired' });
  const cached = await handler.listModelOptions();
  assert.equal(cached.live, true, 'cached catalog still presents as usable');
  assert.equal(cached.modelAccess, 'cached');
  assert.deepEqual(cached.models, ['opus', 'sonnet']);
});

test('model discovery fails closed when expired with no cached catalog', async () => {
  const handler = new ChatHandler();
  handler._fetchCatalog = async () => ({ catalog: null, reason: 'token-expired' });
  const out = await handler.listModelOptions();
  assert.equal(out.live, false);
  assert.deepEqual(out.models, []);
  assert.equal(out.modelAccess, 'token-expired');
});

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
