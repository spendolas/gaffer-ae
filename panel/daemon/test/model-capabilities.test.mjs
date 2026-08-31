import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelCapability, modelCatalogOptions, ChatHandler } from '../chat-handler.js';

const LIVE_CATALOG = {
  models: ['opus', 'sonnet'], efforts: ['low', 'high'], effortsByModel: { opus: ['low', 'high'] },
  capabilitiesByModel: { opus: { oneM: true } }, versions: { opus: ['claude-opus-4-8'] },
  capabilitySource: 'anthropic-v1-models', entitlement: 'account-server', live: true,
};

// Every ChatHandler under test gets an isolated temp cache file, a stub account
// identity, and a controllable clock so no test touches the real install cache,
// spawns `claude auth status`, or depends on wall-clock time.
function makeHandler(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-model-cache-'));
  const cacheFilePath = join(dir, '.gaffer-model-cache.json');
  const clock = { t: overrides.t0 || 1_700_000_000_000 };
  const handler = new ChatHandler({
    cacheFilePath,
    accountIdFn: overrides.accountIdFn || (async () => 'user@example.com'),
    now: () => clock.t,
    ...(overrides.fetchCatalog ? { fetchCatalog: overrides.fetchCatalog } : {}),
  });
  return { handler, cacheFilePath, dir, clock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const TTL_MS = 24 * 60 * 60 * 1000;

test('model discovery serves the cached catalog when a live fetch fails (stale cache)', async () => {
  const { handler, clock, cleanup } = makeHandler();
  try {
    // 1) A live fetch caches the catalog (memory + disk) and returns it live.
    handler._fetchCatalog = async () => ({ catalog: LIVE_CATALOG, reason: 'ready' });
    const live = await handler.listModelOptions();
    assert.equal(live.live, true);
    assert.deepEqual(live.models, ['opus', 'sonnet']);

    // 2) Age the cache past TTL so a live fetch is attempted, then make it fail
    //    (token expired): the prior catalog is served, flagged cached, not
    //    failing closed.
    clock.t += TTL_MS + 1;
    handler._fetchCatalog = async () => ({ catalog: null, reason: 'token-expired' });
    const cached = await handler.listModelOptions();
    assert.equal(cached.live, true, 'cached catalog still presents as usable');
    assert.equal(cached.modelAccess, 'cached');
    assert.deepEqual(cached.models, ['opus', 'sonnet']);
  } finally { cleanup(); }
});

test('model discovery fails closed when a fetch fails with no cache present', async () => {
  const { handler, cleanup } = makeHandler();
  try {
    handler._fetchCatalog = async () => ({ catalog: null, reason: 'token-expired' });
    const out = await handler.listModelOptions();
    assert.equal(out.live, false);
    assert.deepEqual(out.models, []);
    assert.equal(out.modelAccess, 'token-expired');
  } finally { cleanup(); }
});

test('fresh persisted cache (within TTL, matching account) is served WITHOUT a fetch', async () => {
  const { handler, clock, cleanup } = makeHandler();
  try {
    // Prime the persisted cache with one live fetch.
    let calls = 0;
    handler._fetchCatalog = async () => { calls++; return { catalog: LIVE_CATALOG, reason: 'ready' }; };
    await handler.listModelOptions();
    assert.equal(calls, 1);

    // Advance within the TTL, then open again: the fetcher must NOT be called.
    clock.t += TTL_MS - 1000;
    const out = await handler.listModelOptions();
    assert.equal(calls, 1, 'fresh cache served without invoking the fetcher');
    assert.equal(out.fromCache, true, 'cache-hit flagged so the panel can skip the spinner');
    assert.equal(out.live, true);
    assert.equal(out.modelAccess, 'ready');
    assert.deepEqual(out.models, ['opus', 'sonnet']);
  } finally { cleanup(); }
});

test('stale persisted cache (past TTL) triggers a live fetch and re-persists', async () => {
  const { handler, cacheFilePath, clock, cleanup } = makeHandler();
  try {
    let calls = 0;
    handler._fetchCatalog = async () => { calls++; return { catalog: LIVE_CATALOG, reason: 'ready' }; };
    await handler.listModelOptions();
    const firstFetchedAt = JSON.parse(readFileSync(cacheFilePath, 'utf8')).fetchedAt;

    clock.t += TTL_MS + 1; // now stale
    const out = await handler.listModelOptions();
    assert.equal(calls, 2, 'stale cache forces a fresh fetch');
    assert.equal(out.fromCache, undefined, 'a live fetch is not a cache hit');
    const rewritten = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
    assert.equal(rewritten.fetchedAt, clock.t, 're-persisted with the new fetch time');
    assert.notEqual(rewritten.fetchedAt, firstFetchedAt);
  } finally { cleanup(); }
});

test('account mismatch ignores the cached catalog and fetches', async () => {
  // First handler (account A) writes a fresh cache to the shared file.
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-model-cache-'));
  const cacheFilePath = join(dir, '.gaffer-model-cache.json');
  const clock = { t: 1_700_000_000_000 };
  try {
    const a = new ChatHandler({ cacheFilePath, accountIdFn: async () => 'a@example.com', now: () => clock.t });
    a._fetchCatalog = async () => ({ catalog: LIVE_CATALOG, reason: 'ready' });
    await a.listModelOptions();

    // Account B, same file, cache still within TTL — must NOT reuse A's catalog.
    let bCalls = 0;
    const bCatalog = Object.assign({}, LIVE_CATALOG, { models: ['haiku'] });
    const b = new ChatHandler({ cacheFilePath, accountIdFn: async () => 'b@example.com', now: () => clock.t });
    b._fetchCatalog = async () => { bCalls++; return { catalog: bCatalog, reason: 'ready' }; };
    const out = await b.listModelOptions();
    assert.equal(bCalls, 1, 'foreign-account cache is not served; a fetch happens');
    assert.deepEqual(out.models, ['haiku']);

    // And a live-fetch FAILURE for account B must not fall back to A's catalog.
    clock.t += TTL_MS + 1;
    const b2 = new ChatHandler({ cacheFilePath, accountIdFn: async () => 'zzz@example.com', now: () => clock.t });
    b2._fetchCatalog = async () => ({ catalog: null, reason: 'unauthorized' });
    const failed = await b2.listModelOptions();
    assert.equal(failed.live, false, 'no cross-account fallback on fetch failure');
    assert.deepEqual(failed.models, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('persistence round-trip: a fresh ChatHandler loads the on-disk cache without fetching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-model-cache-'));
  const cacheFilePath = join(dir, '.gaffer-model-cache.json');
  const clock = { t: 1_700_000_000_000 };
  try {
    // Instance 1 fetches and persists.
    const h1 = new ChatHandler({ cacheFilePath, accountIdFn: async () => 'user@example.com', now: () => clock.t });
    h1._fetchCatalog = async () => ({ catalog: LIVE_CATALOG, reason: 'ready' });
    await h1.listModelOptions();
    assert.ok(existsSync(cacheFilePath));

    // Instance 2 (simulating a daemon restart) reads the on-disk cache. Its
    // fetcher throws to prove no network call is made.
    const h2 = new ChatHandler({ cacheFilePath, accountIdFn: async () => 'user@example.com', now: () => clock.t + 60000 });
    h2._fetchCatalog = async () => { throw new Error('should not fetch on a fresh persisted cache'); };
    const out = await h2.listModelOptions();
    assert.equal(out.fromCache, true);
    assert.deepEqual(out.models, ['opus', 'sonnet']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt persisted cache is tolerated (treated as no cache)', async () => {
  const { handler, cacheFilePath, cleanup } = makeHandler();
  try {
    writeFileSync(cacheFilePath, '{ not valid json', 'utf8');
    let calls = 0;
    handler._fetchCatalog = async () => { calls++; return { catalog: LIVE_CATALOG, reason: 'ready' }; };
    const out = await handler.listModelOptions();
    assert.equal(calls, 1, 'a corrupt file forces a fetch rather than throwing');
    assert.deepEqual(out.models, ['opus', 'sonnet']);
  } finally { cleanup(); }
});

test('invalidateModelCache clears memory and disk so the next open refetches', async () => {
  const { handler, cacheFilePath, cleanup } = makeHandler();
  try {
    let calls = 0;
    handler._fetchCatalog = async () => { calls++; return { catalog: LIVE_CATALOG, reason: 'ready' }; };
    await handler.listModelOptions();
    assert.ok(existsSync(cacheFilePath));

    handler.invalidateModelCache();
    assert.equal(existsSync(cacheFilePath), false, 'disk cache removed');
    assert.equal(handler.cachedCatalog, null, 'in-memory cache cleared');

    const out = await handler.listModelOptions();
    assert.equal(calls, 2, 'a fresh fetch after invalidation');
    assert.deepEqual(out.models, ['opus', 'sonnet']);
  } finally { cleanup(); }
});

test('future-dated cache (clock skew) is treated as stale, not infinitely fresh', async () => {
  const { handler, cacheFilePath, clock, cleanup } = makeHandler();
  try {
    // Hand-write a cache whose fetchedAt is in the future relative to the clock.
    writeFileSync(cacheFilePath, JSON.stringify({
      catalog: LIVE_CATALOG, fetchedAt: clock.t + 10 * TTL_MS, accountId: 'user@example.com',
    }), 'utf8');
    let calls = 0;
    handler._fetchCatalog = async () => { calls++; return { catalog: LIVE_CATALOG, reason: 'ready' }; };
    await handler.listModelOptions();
    assert.equal(calls, 1, 'a future timestamp is stale → live fetch');
  } finally { cleanup(); }
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
