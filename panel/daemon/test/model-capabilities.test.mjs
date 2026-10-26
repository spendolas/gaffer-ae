import './isolate-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelCapability, createGafferModelCatalog, ChatHandler } from '../chat-handler.js';
import { MODEL_CACHE_TTL_MS } from '../vendor/claude-model-catalog/index.mjs';

// The cache ladder (fresh disk cache, live fetch, stale same-account fallback,
// fail closed) now lives in the vendored claude-model-catalog module. These
// tests keep the intent of the pre-module Gaffer tests, driven through a
// ChatHandler with an injected catalog: fetch, credential, account identity
// and clock are all injected, so nothing here touches the network, the
// Keychain or the real install's cache. The adapter itself is covered in
// model-catalog-adapter.test.mjs.

// A tiny /v1/models answer. The module's catalogFromModels turns it into the
// panel payload { models: ['opus', 'sonnet'], ... }.
const LIVE_MODELS = { data: [
  { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', max_input_tokens: 1000000, max_tokens: 128000,
    capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true } } } },
  { id: 'claude-sonnet-4-8', display_name: 'Claude Sonnet 4.8', max_input_tokens: 1000000, max_tokens: 128000,
    capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true } } } },
] };
const HAIKU_ONLY = { data: [{ id: 'claude-haiku-4-5-20251001', max_input_tokens: 200000 }] };

const T0 = 1_700_000_000_000;
const TTL_MS = MODEL_CACHE_TTL_MS;

// A fetch that answers `body` (or fails with `status`) and counts its calls.
// `fetcher.body` / `fetcher.status` can be swapped mid-test.
function fetcher(body, status) {
  const f = async (url, opts) => {
    f.calls++;
    if (f.status) return { ok: false, status: f.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => f.body };
  };
  f.calls = 0; f.body = body; f.status = status || 0;
  return f;
}

// Every ChatHandler under test gets an isolated temp cache file, a stub
// account identity, a credential that is valid for an hour from the clock,
// and a controllable clock.
function makeHandler(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-model-cache-'));
  const cacheFilePath = overrides.cacheFilePath || join(dir, '.gaffer-model-cache.json');
  const clock = overrides.clock || { t: T0 };
  const fetch = overrides.fetch || fetcher(LIVE_MODELS);
  const catalog = createGafferModelCatalog({
    cacheFile: cacheFilePath,
    readAccountId: () => (overrides.accountId === undefined ? 'user@example.com' : overrides.accountId),
    readCredential: async () => ({ kind: 'bearer', token: 'tok', expiresAt: clock.t + 3600_000 }),
    fetch,
    now: () => clock.t,
    log: () => {},
  });
  const handler = new ChatHandler({ modelCatalog: catalog });
  return { handler, catalog, fetch, cacheFilePath, dir, clock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('model discovery serves the cached catalog when a live fetch fails (stale cache)', async () => {
  const { handler, fetch, clock, cleanup } = makeHandler();
  try {
    // 1) A live fetch caches the catalog (memory + disk) and returns it live.
    const live = await handler.listModelOptions();
    assert.equal(live.live, true);
    assert.deepEqual(live.models, ['opus', 'sonnet']);

    // 2) Age the cache past TTL so a live fetch is attempted, then make it fail
    //    (unauthorized): the prior catalog is served, flagged cached, not
    //    failing closed.
    clock.t += TTL_MS + 1;
    fetch.status = 401;
    const cached = await handler.listModelOptions();
    assert.equal(cached.live, true, 'cached catalog still presents as usable');
    assert.equal(cached.modelAccess, 'cached');
    assert.deepEqual(cached.models, ['opus', 'sonnet']);
  } finally { cleanup(); }
});

test('an expiring token skips the fetch and serves the stale cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-model-cache-'));
  try {
    const file = join(dir, '.gaffer-model-cache.json');
    const clock = { t: T0 };
    let expiresAt = T0 + 3600_000;
    const fetch = fetcher(LIVE_MODELS);
    const handler = new ChatHandler({ modelCatalog: createGafferModelCatalog({
      cacheFile: file, readAccountId: () => 'user@example.com', fetch, now: () => clock.t, log: () => {},
      readCredential: async () => ({ kind: 'bearer', token: 'tok', expiresAt }),
    }) });
    await handler.listModelOptions();
    clock.t += TTL_MS + 1;
    expiresAt = clock.t + 10_000; // inside the 30s margin: the CLI will refresh it on its next call
    const out = await handler.listModelOptions();
    assert.equal(fetch.calls, 1, 'no request spent on a token about to expire');
    assert.equal(out.modelAccess, 'cached');
    assert.deepEqual(out.models, ['opus', 'sonnet']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('model discovery fails closed when a fetch fails with no cache present', async () => {
  const { handler, fetch, cleanup } = makeHandler();
  try {
    fetch.status = 500;
    const out = await handler.listModelOptions();
    assert.equal(out.live, false);
    assert.deepEqual(out.models, []);
    assert.equal(out.modelAccess, 'network');
  } finally { cleanup(); }
});

test('fresh persisted cache (within TTL, matching account) is served WITHOUT a fetch', async () => {
  const { handler, fetch, clock, cleanup } = makeHandler();
  try {
    await handler.listModelOptions();
    assert.equal(fetch.calls, 1);

    // Advance within the TTL, then open again: the fetcher must NOT be called.
    clock.t += TTL_MS - 1000;
    const out = await handler.listModelOptions();
    assert.equal(fetch.calls, 1, 'fresh cache served without invoking the fetcher');
    assert.equal(out.fromCache, true, 'cache-hit flagged so the panel can skip the spinner');
    assert.equal(out.live, true);
    assert.equal(out.modelAccess, 'ready');
    assert.deepEqual(out.models, ['opus', 'sonnet']);
  } finally { cleanup(); }
});

test('stale persisted cache (past TTL) triggers a live fetch and re-persists', async () => {
  const { handler, fetch, cacheFilePath, clock, cleanup } = makeHandler();
  try {
    await handler.listModelOptions();
    const firstFetchedAt = JSON.parse(readFileSync(cacheFilePath, 'utf8')).fetchedAt;

    clock.t += TTL_MS + 1; // now stale
    const out = await handler.listModelOptions();
    assert.equal(fetch.calls, 2, 'stale cache forces a fresh fetch');
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
  const clock = { t: T0 };
  try {
    const a = makeHandler({ cacheFilePath, clock, accountId: 'a@example.com' });
    await a.handler.listModelOptions();

    // Account B, same file, cache still within TTL: must NOT reuse A's catalog.
    const b = makeHandler({ cacheFilePath, clock, accountId: 'b@example.com', fetch: fetcher(HAIKU_ONLY) });
    const out = await b.handler.listModelOptions();
    assert.equal(b.fetch.calls, 1, 'foreign-account cache is not served; a fetch happens');
    assert.deepEqual(out.models, ['haiku']);

    // And a live-fetch FAILURE for account C must not fall back to anyone's catalog.
    clock.t += TTL_MS + 1;
    const c = makeHandler({ cacheFilePath, clock, accountId: 'zzz@example.com', fetch: fetcher(null, 403) });
    const failed = await c.handler.listModelOptions();
    assert.equal(failed.live, false, 'no cross-account fallback on fetch failure');
    assert.equal(failed.modelAccess, 'unauthorized');
    assert.deepEqual(failed.models, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unknown account identity never matches a cache (always goes live)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-model-cache-'));
  const cacheFilePath = join(dir, '.gaffer-model-cache.json');
  try {
    const h1 = makeHandler({ cacheFilePath, accountId: null });
    await h1.handler.listModelOptions();
    const h2 = makeHandler({ cacheFilePath, accountId: null });
    await h2.handler.listModelOptions();
    assert.equal(h2.fetch.calls, 1, 'identity unknown: fetch rather than trust the file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('persistence round-trip: a fresh ChatHandler loads the on-disk cache without fetching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-model-cache-'));
  const cacheFilePath = join(dir, '.gaffer-model-cache.json');
  try {
    // Instance 1 fetches and persists.
    const h1 = makeHandler({ cacheFilePath });
    await h1.handler.listModelOptions();
    assert.ok(existsSync(cacheFilePath));

    // Instance 2 (simulating a daemon restart) reads the on-disk cache. Its
    // fetcher throws to prove no network call is made.
    const h2 = makeHandler({ cacheFilePath, clock: { t: T0 + 60000 },
      fetch: async () => { throw new Error('should not fetch on a fresh persisted cache'); } });
    const out = await h2.handler.listModelOptions();
    assert.equal(out.fromCache, true);
    assert.deepEqual(out.models, ['opus', 'sonnet']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt persisted cache is tolerated (treated as no cache)', async () => {
  const { handler, fetch, cacheFilePath, cleanup } = makeHandler();
  try {
    writeFileSync(cacheFilePath, '{ not valid json', 'utf8');
    const out = await handler.listModelOptions();
    assert.equal(fetch.calls, 1, 'a corrupt file forces a fetch rather than throwing');
    assert.deepEqual(out.models, ['opus', 'sonnet']);
  } finally { cleanup(); }
});

test('invalidateModelCache clears memory and disk so the next open refetches', async () => {
  const { handler, fetch, cacheFilePath, cleanup } = makeHandler();
  try {
    await handler.listModelOptions();
    assert.ok(existsSync(cacheFilePath));

    handler.invalidateModelCache();
    assert.equal(existsSync(cacheFilePath), false, 'disk cache removed');
    assert.equal(handler.modelCatalog.peek(), null, 'in-memory cache cleared');
    assert.equal(handler.liveModelCapabilities, null);

    const out = await handler.listModelOptions();
    assert.equal(fetch.calls, 2, 'a fresh fetch after invalidation');
    assert.deepEqual(out.models, ['opus', 'sonnet']);
  } finally { cleanup(); }
});

test('future-dated cache (clock skew) is treated as stale, not infinitely fresh', async () => {
  const { handler, fetch, cacheFilePath, clock, cleanup } = makeHandler();
  try {
    // Hand-write a cache (module format) whose fetchedAt is in the future.
    writeFileSync(cacheFilePath, JSON.stringify({
      catalog: { families: ['opus'], versions: { opus: [{ id: 'claude-opus-4-8', family: 'opus', efforts: [] }] } },
      fetchedAt: clock.t + 10 * TTL_MS, accountId: 'user@example.com',
    }), 'utf8');
    await handler.listModelOptions();
    assert.equal(fetch.calls, 1, 'a future timestamp is stale: live fetch');
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

test('live Anthropic catalog supplies versions, context, and per-model effort', async () => {
  const { handler, cleanup } = makeHandler({ fetch: fetcher({ data: [
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
  ] }) });
  try {
    const result = await handler.listModelOptions();
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
  } finally { cleanup(); }
});
