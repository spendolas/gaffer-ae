// Model discovery runs on the vendored claude-model-catalog module. These
// tests pin the Gaffer side of that seam:
//   1. catalogToPanel: the module's catalog becomes the SAME models payload the
//      old hand-written modelCatalogOptions produced, so panel/main.js is
//      untouched. Where the module intentionally differs (version sort ignores
//      8-digit date stamps, duplicate ids dropped, mythos in the family order)
//      the tests accept the module and say so.
//   2. the catalog Gaffer builds: no User-Agent, the oauth beta header only
//      with Bearer, a token never in a log line, one account's cache never
//      served to another, an old-format cache file ignored and overwritten.
//   3. ChatHandler wiring: status to panel state, Retry forces a fetch past a
//      fresh cache, a completed CLI turn refreshes in the background, sign-in
//      and sign-out invalidate.
// Everything goes through an injected fetch and fixtures: no network, no
// Keychain, no real credential.
import './isolate-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogToPanel, createGafferModelCatalog, scrubLogMessage, ChatHandler, modelCapability } from '../chat-handler.js';
import { catalogFromModels } from '../vendor/claude-model-catalog/index.mjs';

// Trimmed real /v1/models rows (2026-09-24 probe), deliberately out of order,
// the same fixture the module's own tests use, plus a dated opus row that
// shares its version with an undated one.
const EFF_ALL = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } };
const EFF_NO_XHIGH = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } };
const EFF_NONE = { supported: false, low: { supported: false }, medium: { supported: false }, high: { supported: false }, xhigh: { supported: false }, max: { supported: false } };
const MODELS = {
  data: [
    { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: EFF_NO_XHIGH } },
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: EFF_ALL } },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_input_tokens: 200000, max_tokens: 64000, capabilities: { effort: EFF_NONE } },
    { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', max_input_tokens: 200000, max_tokens: 64000, capabilities: { effort: EFF_ALL } },
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: EFF_ALL } },
    { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: EFF_ALL } },
    { id: 'not-a-claude-model', display_name: 'Junk' },
  ],
};
const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];

// ---- 1. the adapter ----------------------------------------------------------

test('catalogToPanel produces every field the old modelCatalogOptions did', () => {
  const p = catalogToPanel(catalogFromModels(MODELS));
  assert.deepEqual(Object.keys(p).sort(),
    ['capabilitiesByModel', 'capabilitySource', 'efforts', 'effortsByModel', 'entitlement', 'live', 'models', 'versions'].sort());
  assert.deepEqual(p.models, ['fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(p.versions, {
    fable: ['claude-fable-5-1'],
    opus: ['claude-opus-5-5', 'claude-opus-4-6', 'claude-opus-4-5-20251101'],
    sonnet: ['claude-sonnet-5'],
    haiku: ['claude-haiku-4-5-20251001'],
  });
  assert.deepEqual(p.efforts, ALL, 'union of every model\'s efforts, in canonical order');
  assert.equal(p.capabilitySource, 'anthropic-v1-models');
  assert.equal(p.entitlement, 'account-server');
  assert.equal(p.live, true);
});

test('capabilitiesByModel carries the per-model shape the panel and the effort guard read', () => {
  const p = catalogToPanel(catalogFromModels(MODELS));
  assert.deepEqual(p.capabilitiesByModel['claude-opus-4-6'], {
    oneM: true,
    contextWindows: [200000, 1000000],
    efforts: ['low', 'medium', 'high', 'max'],
    source: 'anthropic-v1-models',
    entitlement: 'account-server',
    modelId: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
  });
  assert.deepEqual(p.capabilitiesByModel['claude-haiku-4-5-20251001'].contextWindows, [200000]);
  assert.equal(p.capabilitiesByModel['claude-haiku-4-5-20251001'].oneM, false);
  assert.deepEqual(p.capabilitiesByModel['claude-haiku-4-5-20251001'].efforts, []);
  assert.deepEqual(p.effortsByModel['claude-opus-4-6'], ['low', 'medium', 'high', 'max']);
  assert.deepEqual(p.effortsByModel['claude-haiku-4-5-20251001'], []);
});

test('the family alias maps to its newest version (same object, as before)', () => {
  const p = catalogToPanel(catalogFromModels(MODELS));
  assert.equal(p.capabilitiesByModel.opus, p.capabilitiesByModel['claude-opus-5-5']);
  assert.equal(p.effortsByModel.opus, p.effortsByModel['claude-opus-5-5']);
  assert.equal(p.capabilitiesByModel.haiku.modelId, 'claude-haiku-4-5-20251001');
  assert.deepEqual(p.capabilitiesByModel.opus.efforts, ALL);
});

test('old test intent kept: a live catalog supplies versions, context and per-model effort', () => {
  // The exact rows the old modelCatalogOptions test used.
  const p = catalogToPanel(catalogFromModels({ data: [
    { id: 'claude-opus-5', display_name: 'Claude Opus 5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: EFF_ALL } },
    { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: EFF_NO_XHIGH } },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_input_tokens: 200000, max_tokens: 64000, capabilities: { effort: { supported: false } } },
  ] }));
  assert.deepEqual(p.models, ['opus', 'haiku']);
  assert.deepEqual(p.versions.opus, ['claude-opus-5', 'claude-opus-4-6']);
  assert.deepEqual(p.capabilitiesByModel.opus.efforts, ALL);
  assert.deepEqual(p.capabilitiesByModel['claude-opus-4-6'].efforts, ['low', 'medium', 'high', 'max']);
  assert.equal(p.capabilitiesByModel.opus.oneM, true);
  assert.equal(p.capabilitiesByModel.haiku.oneM, false);
  assert.deepEqual(p.capabilitiesByModel.haiku.efforts, []);
  assert.equal(p.capabilitySource, 'anthropic-v1-models');
  assert.equal(p.live, true);
});

test('accepted module differences: date stamps ignored in the sort, duplicates dropped, mythos in family order', () => {
  // Old modelCatalogOptions parsed the 8-digit date stamp as a fourth version
  // part, so claude-opus-4-5-20251101 sorted above claude-opus-4-5. The module
  // ignores the stamp: equal versions keep the API's order (first row wins).
  //
  // CHANGELOG note (version sort fix): the old sort compared the date stamp
  // as a version number, so claude-opus-4-20250514 ([4, 20250514]) ranked
  // ABOVE claude-opus-4-1-20250805 ([4, 1, 20250805]) and the opus alias
  // (newest version first) could point at the older model. The module sorts
  // on [4] vs [4, 1] only, so 4.1 wins; the same holds for sonnet.
  //
  // CHANGELOG note (unknown account): when the account id cannot be resolved
  // (no ~/.claude.json identity, no env key) a catalog held in memory from an
  // earlier fetch is no longer served as "cached" when the token has expired;
  // the panel shows Try again instead. Deliberate: the module never serves a
  // cache to an unknown account, which is what prevents cross-account serving.
  // Old code also kept a duplicate id once per family list but re-counted it
  // in capabilities; the module keeps the first occurrence only. Mythos now
  // sits after haiku in the picker order instead of among "other" families.
  const p = catalogToPanel(catalogFromModels({ data: [
    { id: 'claude-mythos-1', max_input_tokens: 1000000, capabilities: { effort: EFF_ALL } },
    { id: 'claude-zeta-2' },
    { id: 'claude-opus-4-5', display_name: 'Undated first' },
    { id: 'claude-opus-4-5-20251101', display_name: 'Dated second' },
    { id: 'claude-opus-4-5', display_name: 'Duplicate' },
    { id: 'claude-haiku-4-5' },
  ] }));
  assert.deepEqual(p.versions.opus, ['claude-opus-4-5', 'claude-opus-4-5-20251101']);
  assert.equal(p.capabilitiesByModel['claude-opus-4-5'].displayName, 'Undated first');
  assert.deepEqual(p.models, ['opus', 'haiku', 'mythos', 'zeta']);
});

test('the version sort no longer ranks a dated major above a later minor (opus 4 vs 4.1)', () => {
  const p = catalogToPanel(catalogFromModels({ data: [
    { id: 'claude-opus-4-20250514' },
    { id: 'claude-opus-4-1-20250805' },
    { id: 'claude-sonnet-4-20250514' },
    { id: 'claude-sonnet-4-5-20250929' },
  ] }));
  assert.deepEqual(p.versions.opus, ['claude-opus-4-1-20250805', 'claude-opus-4-20250514']);
  assert.equal(p.capabilitiesByModel.opus.modelId, 'claude-opus-4-1-20250805');
  assert.equal(p.capabilitiesByModel.sonnet.modelId, 'claude-sonnet-4-5-20250929');
});

test('catalogToPanel skips entries that are not objects with a string id (hand-edited cache)', () => {
  const p = catalogToPanel({ families: ['opus', 'haiku'], versions: {
    opus: [null, 7, 'claude-opus-4-8', { id: 42 }, { id: 'claude-opus-4-8', oneM: true }],
    haiku: [undefined],
  } });
  // A family with no valid entry is dropped, as v0.12.0 listed only families
  // with at least one version (the panel would otherwise offer a bare alias).
  assert.deepEqual(p.models, ['opus']);
  assert.deepEqual(p.versions, { opus: ['claude-opus-4-8'] });
  assert.equal(p.capabilitiesByModel.opus.modelId, 'claude-opus-4-8');
  assert.equal(p.capabilitiesByModel.haiku, undefined);
  assert.deepEqual(p.efforts, []);
});

test('catalogToPanel lists only families with a valid version and skips non-string family names', () => {
  const p = catalogToPanel({ families: ['opus', 42, null, 'ghost', ''], versions: {
    opus: [{ id: 'claude-opus-4-8' }],
    ghost: [],
    extra: [{ id: 'claude-extra-1' }],
    bad: 'not a list',
  } });
  assert.deepEqual(p.models, ['opus', 'extra']);
  assert.deepEqual(Object.keys(p.versions), ['opus', 'extra']);
  assert.deepEqual(Object.keys(p.effortsByModel).sort(), ['claude-extra-1', 'claude-opus-4-8', 'extra', 'opus']);
});

test('scrubLogMessage turns a quoted invalid header value (token with a newline) into a generic line', () => {
  const token = 'sk-ant-oat01-first\nsecond-line';
  const undici = 'model catalog: live fetch failed (network): request failed: Headers.append: "Bearer ' + token + '" is an invalid header value.';
  assert.equal(scrubLogMessage(undici), 'model catalog: live fetch failed (network): invalid credential');
  const bare = 'request failed: TypeError: Invalid value "' + token + '" for header "Authorization"';
  const out = scrubLogMessage(bare);
  assert.equal(out, 'model catalog: live fetch failed: invalid credential');
  for (const m of [undici, bare]) assert.ok(!scrubLogMessage(m).includes('first'), scrubLogMessage(m));
  assert.equal(scrubLogMessage('x-api-key rejected: abc'), 'model catalog: live fetch failed: invalid credential');
  assert.equal(scrubLogMessage('model catalog: live fetch failed (unauthorized): HTTP 401'),
    'model catalog: live fetch failed (unauthorized): HTTP 401', 'ordinary lines pass through');
});

test('a fetch that throws an invalid-header error logs the generic line, never the token', async () => {
  const c = tmpCache();
  const warned = [];
  const orig = console.warn;
  console.warn = (m) => warned.push(String(m));
  const token = 'oat-with\nnewline';
  try {
    await gafferCatalog({ cacheFile: c.file, readCredential: async () => ({ kind: 'bearer', token, expiresAt: NOW + 3600_000 }),
      fetch: async (url, opts) => { throw new TypeError('Headers.append: "' + opts.headers.Authorization + '" is an invalid header value.'); } }).get();
  } finally { console.warn = orig; c.cleanup(); }
  assert.equal(warned.length, 1);
  assert.equal(warned[0], 'Gaffer: model catalog: live fetch failed (network): invalid credential');
});

test('catalogToPanel is null for a null or malformed catalog, never throws', () => {
  assert.equal(catalogToPanel(null), null);
  assert.equal(catalogToPanel(undefined), null);
  assert.equal(catalogToPanel({}), null);
  assert.equal(catalogToPanel({ families: 'x', versions: {} }), null);
  assert.equal(catalogFromModels({ data: [{ id: 'gpt-x' }] }), null, 'the module refuses an empty catalog');
});

test('modelCapability (the Gaffer-side fallback table) is unchanged', () => {
  assert.deepEqual(modelCapability('claude-haiku-4-5-20251001', null), {
    oneM: false, contextWindows: [200000], efforts: [], source: 'claude-code-model-config', entitlement: 'plan-dependent',
  });
  assert.deepEqual(modelCapability('claude-opus-4-6', null).efforts, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(modelCapability('opus', { opus: ['claude-opus-4-6', 'claude-opus-4-7'] }).efforts, ['low', 'medium', 'high', 'max']);
});

// ---- 2. the catalog Gaffer builds -----------------------------------------------

const NOW = 1_800_000_000_000;
const BEARER = { kind: 'bearer', token: 'oat-secret-token', expiresAt: NOW + 3600_000 };
const API_KEY = { kind: 'api-key', token: 'api-secret-key', expiresAt: 0 };

function tmpCache() {
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-catalog-'));
  return { dir, file: join(dir, '.gaffer-model-cache.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function okFetch(body = MODELS) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => body }; };
  fn.calls = calls;
  return fn;
}
function statusFetch(status) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: false, status, json: async () => ({}) }; };
  fn.calls = calls;
  return fn;
}

// A Gaffer catalog with every I/O edge injected. `cacheFile` is required so a
// test never reaches the isolated-but-shared GAFFER_MODEL_CACHE_PATH.
function gafferCatalog(over) {
  return createGafferModelCatalog(Object.assign({
    readCredential: async () => BEARER,
    readAccountId: () => 'uuid:acct-1',
    fetch: okFetch(),
    now: () => NOW,
  }, over));
}

test('the live fetch sends no User-Agent (the old code spoofed claude-code/2.1.236)', async () => {
  const c = tmpCache();
  try {
    const f = okFetch();
    const r = await gafferCatalog({ cacheFile: c.file, fetch: f }).get();
    assert.equal(r.status, 'ready');
    assert.equal(f.calls.length, 1);
    const headers = f.calls[0].opts.headers;
    assert.equal(headers['User-Agent'], undefined);
    assert.equal(headers['user-agent'], undefined);
    assert.ok(!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent'));
    assert.match(f.calls[0].url, /\/v1\/models\?limit=1000$/);
  } finally { c.cleanup(); }
});

test('the oauth beta header goes out only with a Bearer credential', async () => {
  const c = tmpCache();
  try {
    const bearer = okFetch();
    await gafferCatalog({ cacheFile: c.file, fetch: bearer }).get();
    assert.equal(bearer.calls[0].opts.headers.Authorization, 'Bearer oat-secret-token');
    assert.equal(bearer.calls[0].opts.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(bearer.calls[0].opts.headers['x-api-key'], undefined);

    const key = okFetch();
    await gafferCatalog({ cacheFile: c.file, fetch: key, readCredential: async () => API_KEY }).get({ force: true });
    assert.equal(key.calls[0].opts.headers['x-api-key'], 'api-secret-key');
    assert.equal(key.calls[0].opts.headers.Authorization, undefined);
    assert.equal(key.calls[0].opts.headers['anthropic-beta'], undefined, 'no oauth beta on an API key');
    assert.equal(key.calls[0].opts.headers['anthropic-version'], '2023-06-01');
  } finally { c.cleanup(); }
});

test('the daemon log line on a failed fetch names the reason and never the token', async () => {
  const c = tmpCache();
  const lines = [];
  const log = (level, message) => lines.push({ level, message: String(message) });
  try {
    await gafferCatalog({ cacheFile: c.file, log, fetch: statusFetch(500) }).get();
    await gafferCatalog({ cacheFile: c.file, log, fetch: statusFetch(401) }).get();
    await gafferCatalog({ cacheFile: c.file, log, fetch: async () => { throw new Error('offline'); } }).get();
    await gafferCatalog({ cacheFile: c.file, log, readCredential: async () => null }).get();
    assert.equal(lines.length, 4);
    assert.match(lines[0].message, /network.*500/);
    assert.match(lines[1].message, /unauthorized.*401/);
    assert.match(lines[2].message, /offline/);
    assert.match(lines[3].message, /no-credential/);
    for (const l of lines) {
      assert.ok(!l.message.includes('oat-secret-token'), 'token in log: ' + l.message);
      assert.ok(!/[–—]/.test(l.message), 'no em or en dash in a log line: ' + l.message);
    }
  } finally { c.cleanup(); }
});

test('scrubLogMessage strips userinfo from URL-looking text and leaves the rest alone', () => {
  assert.equal(scrubLogMessage('request failed: fetch https://me:s3cret@proxy.corp/v1/models?limit=1000'),
    'request failed: fetch https://proxy.corp/v1/models?limit=1000');
  assert.equal(scrubLogMessage('http://tok@127.0.0.1:9/x and HTTP://a:b@h'), 'http://127.0.0.1:9/x and HTTP://h');
  assert.equal(scrubLogMessage('HTTP 500'), 'HTTP 500');
  assert.equal(scrubLogMessage('mail me@example.com'), 'mail me@example.com');
  assert.equal(scrubLogMessage(undefined), 'undefined');
});

test('a failed fetch never logs credentials embedded in ANTHROPIC_BASE_URL', async () => {
  const c = tmpCache();
  const warned = [];
  const orig = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    await gafferCatalog({ cacheFile: c.file, baseUrl: 'https://me:s3cret@proxy.corp',
      fetch: async (url) => { throw new Error('connect failed for ' + url); } }).get();
  } finally { console.warn = orig; c.cleanup(); }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /proxy\.corp\/v1\/models/);
  assert.ok(!warned[0].includes('s3cret'), warned[0]);
  assert.ok(!warned[0].includes('me:'), warned[0]);
});

test('the default logger writes one Gaffer-prefixed console.warn line per failed fetch, without the token', async () => {
  const c = tmpCache();
  const warned = [];
  const orig = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    await gafferCatalog({ cacheFile: c.file, fetch: statusFetch(503) }).get();
  } finally { console.warn = orig; c.cleanup(); }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /^Gaffer: /);
  assert.match(warned[0], /503/);
  assert.ok(!warned[0].includes('oat-secret-token'));
  assert.ok(!/[–—]/.test(warned[0]));
});

test('a successful fetch persists the catalog (not the token) to the Gaffer cache file', async () => {
  const c = tmpCache();
  try {
    await gafferCatalog({ cacheFile: c.file }).get();
    const raw = readFileSync(c.file, 'utf8');
    assert.ok(!raw.includes('oat-secret-token'));
    const disk = JSON.parse(raw);
    assert.equal(disk.accountId, 'uuid:acct-1');
    assert.equal(disk.fetchedAt, NOW);
    assert.deepEqual(disk.catalog.families, ['fable', 'opus', 'sonnet', 'haiku']);
  } finally { c.cleanup(); }
});

test('one account\'s cache is never served to another account, even when its fetch fails', async () => {
  const c = tmpCache();
  try {
    await gafferCatalog({ cacheFile: c.file }).get();
    // Account B, same file, cache still fresh: a fetch happens and B gets its own models.
    const bFetch = okFetch({ data: [{ id: 'claude-haiku-4-5-20251001', max_input_tokens: 200000 }] });
    const b = await gafferCatalog({ cacheFile: c.file, readAccountId: () => 'uuid:acct-2', fetch: bFetch }).get();
    assert.equal(bFetch.calls.length, 1);
    assert.deepEqual(catalogToPanel(b.catalog).models, ['haiku']);
    // Account C with a failing fetch must not fall back to anyone's cache.
    const r = await gafferCatalog({ cacheFile: c.file, readAccountId: () => 'uuid:acct-3', fetch: statusFetch(401) }).get();
    assert.equal(r.status, 'unauthorized');
    assert.equal(r.catalog, null);
  } finally { c.cleanup(); }
});

test('an old-format (pre module) cache file is ignored and overwritten', async () => {
  const c = tmpCache();
  try {
    // The 0.12.0 daemon wrote { catalog: <panel payload>, fetchedAt, accountId }:
    // a panel payload has models/versions but no families, so it fails the
    // module's shape check and must not be served.
    writeFileSync(c.file, JSON.stringify({
      catalog: { models: ['opus'], versions: { opus: ['claude-opus-4-8'] }, efforts: [], effortsByModel: {}, capabilitiesByModel: {} },
      fetchedAt: NOW, accountId: 'uuid:acct-1',
    }));
    const f = okFetch();
    const r = await gafferCatalog({ cacheFile: c.file, fetch: f }).get();
    assert.equal(f.calls.length, 1, 'the old file is not a fresh cache');
    assert.equal(r.status, 'ready');
    assert.equal(r.fromCache, false);
    const disk = JSON.parse(readFileSync(c.file, 'utf8'));
    assert.deepEqual(disk.catalog.families, ['fable', 'opus', 'sonnet', 'haiku'], 'overwritten in the module format');
  } finally { c.cleanup(); }
});

test('a cacheFile override of undefined keeps the default cache file', async () => {
  try { rmSync(process.env.GAFFER_MODEL_CACHE_PATH, { force: true }); } catch (e) { /* absent */ }
  await createGafferModelCatalog({ cacheFile: undefined, readCredential: async () => BEARER,
    readAccountId: () => 'uuid:x', fetch: okFetch(), now: () => NOW }).get();
  assert.ok(existsSync(process.env.GAFFER_MODEL_CACHE_PATH), 'written to the default path');
  rmSync(process.env.GAFFER_MODEL_CACHE_PATH, { force: true });
});

test('a bare new ChatHandler({}) reads and writes the disk cache at GAFFER_MODEL_CACHE_PATH', async () => {
  // No injected edges here, so the real account-id read runs: point it at a
  // throwaway CLAUDE_CONFIG_DIR whose .claude.json names a test account, and
  // seed a fresh module-format cache for that account. A fresh same-account
  // cache is served BEFORE any credential read or fetch, so the test never
  // touches the Keychain or the network.
  const dir = mkdtempSync(join(tmpdir(), 'gaffer-bare-handler-'));
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  const file = process.env.GAFFER_MODEL_CACHE_PATH;
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'bare-test-acct' } }));
    writeFileSync(file, JSON.stringify({ catalog: catalogFromModels(MODELS), fetchedAt: Date.now(), accountId: 'uuid:bare-test-acct' }));
    const h = new ChatHandler({});
    const out = await h.listModelOptions();
    assert.equal(out.modelAccess, 'ready');
    assert.equal(out.fromCache, true, 'served from the default cache file, no fetch');
    assert.deepEqual(out.models, ['fable', 'opus', 'sonnet', 'haiku']);
    // The same handler's invalidate removes that file: the write side goes
    // through the same path (the "cacheFile undefined" test above covers the
    // write with injected edges).
    h.invalidateModelCache();
    assert.equal(existsSync(file), false);
  } finally {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    rmSync(dir, { recursive: true, force: true });
    rmSync(file, { force: true });
  }
});

test('the cache file defaults to GAFFER_MODEL_CACHE_PATH, which the test isolation sets', async () => {
  const f = okFetch();
  const r = await createGafferModelCatalog({ readCredential: async () => BEARER, readAccountId: () => 'uuid:x', fetch: f, now: () => NOW }).get();
  assert.equal(r.status, 'ready');
  assert.ok(existsSync(process.env.GAFFER_MODEL_CACHE_PATH));
  createGafferModelCatalog({ readCredential: async () => BEARER, readAccountId: () => 'uuid:x', fetch: f, now: () => NOW }).invalidate();
  assert.ok(!existsSync(process.env.GAFFER_MODEL_CACHE_PATH));
});

// ---- 3. ChatHandler wiring -------------------------------------------------------

function handlerWith(catalog) {
  return new ChatHandler({ modelCatalog: catalog, findClaudeBinary: async () => '/fake/claude', lastClaudeLookup: () => null });
}

const EMPTY_PAYLOAD = {
  models: [], efforts: [], effortsByModel: {}, capabilitiesByModel: {}, versions: {},
  capabilitySource: 'unavailable', entitlement: 'unknown', live: false,
};

test('ready (live) maps to the live panel payload with modelAccess ready and no fromCache', async () => {
  const c = tmpCache();
  try {
    const out = await handlerWith(gafferCatalog({ cacheFile: c.file })).listModelOptions();
    assert.equal(out.live, true);
    assert.equal(out.modelAccess, 'ready');
    assert.equal(out.fromCache, undefined, 'a live fetch is not a cache hit');
    assert.deepEqual(out.models, ['fable', 'opus', 'sonnet', 'haiku']);
    assert.equal(out.capabilitySource, 'anthropic-v1-models');
    assert.equal(out.entitlement, 'account-server');
  } finally { c.cleanup(); }
});

test('ready (fresh disk cache) is served without a fetch and flagged fromCache', async () => {
  const c = tmpCache();
  try {
    await gafferCatalog({ cacheFile: c.file }).get();
    const f = okFetch();
    const out = await handlerWith(gafferCatalog({ cacheFile: c.file, fetch: f, now: () => NOW + 3600_000 })).listModelOptions();
    assert.equal(f.calls.length, 0);
    assert.equal(out.fromCache, true);
    assert.equal(out.live, true);
    assert.equal(out.modelAccess, 'ready');
    assert.deepEqual(out.models, ['fable', 'opus', 'sonnet', 'haiku']);
  } finally { c.cleanup(); }
});

test('cached (stale fallback after a failed fetch) keeps live true and modelAccess cached', async () => {
  const c = tmpCache();
  try {
    let fetchImpl = okFetch();
    const h = handlerWith(gafferCatalog({ cacheFile: c.file, fetch: (u, o) => fetchImpl(u, o) }));
    await h.listModelOptions();
    fetchImpl = statusFetch(401);
    const out = await h.listModelOptions({ force: true });
    assert.equal(out.live, true, 'a cached catalog still presents as usable');
    assert.equal(out.modelAccess, 'cached');
    assert.equal(out.cached, true);
    assert.deepEqual(out.models, ['fable', 'opus', 'sonnet', 'haiku']);
  } finally { c.cleanup(); }
});

for (const [status, over] of [
  ['no-credential', { readCredential: async () => null }],
  ['token-expired', { readCredential: async () => ({ kind: 'bearer', token: 't', expiresAt: NOW + 1000 }) }],
  ['unauthorized', { fetch: statusFetch(403) }],
  ['network', { fetch: statusFetch(500) }],
  ['invalid-response', { fetch: okFetch({ data: [{ id: 'gpt-x' }] }) }],
]) {
  test('failure status ' + status + ' fails closed with the empty payload and modelAccess ' + status, async () => {
    const c = tmpCache();
    try {
      const out = await handlerWith(gafferCatalog(Object.assign({ cacheFile: c.file }, over))).listModelOptions();
      assert.deepEqual(out, Object.assign({}, EMPTY_PAYLOAD, { modelAccess: status }));
    } finally { c.cleanup(); }
  });
}

test('Retry after a failure forces a fetch even past a fresh same-account cache', async () => {
  const c = tmpCache();
  try {
    let fetchImpl = statusFetch(500);
    const calls = [];
    const h = handlerWith(gafferCatalog({ cacheFile: c.file, fetch: (u, o) => { calls.push(u); return fetchImpl(u, o); } }));
    assert.equal((await h.listModelOptions()).modelAccess, 'network');
    assert.equal(calls.length, 1);
    // Another daemon (or process) writes a fresh cache for this account in the
    // meantime. A plain open would serve it; the panel's Retry must go live.
    await gafferCatalog({ cacheFile: c.file }).get();
    fetchImpl = okFetch();
    const out = await h.listModelOptions();
    assert.equal(calls.length, 2, 'the retry bypassed the fresh cache');
    assert.equal(out.modelAccess, 'ready');
    assert.equal(out.fromCache, undefined);
    // Once the answer is usable, the next open may use the cache again.
    await h.listModelOptions();
    assert.equal(calls.length, 2);
  } finally { c.cleanup(); }
});

test('an explicit force bypasses a fresh cache; invalidate forgets memory and disk', async () => {
  const c = tmpCache();
  try {
    const f = okFetch();
    const h = handlerWith(gafferCatalog({ cacheFile: c.file, fetch: f }));
    await h.listModelOptions();
    await h.listModelOptions();
    assert.equal(f.calls.length, 1);
    await h.listModelOptions({ force: true });
    assert.equal(f.calls.length, 2);
    h.invalidateModelCache();
    assert.equal(existsSync(c.file), false, 'disk cache removed');
    assert.equal(h.liveModelCapabilities, null, 'in-memory capabilities cleared');
    await h.listModelOptions();
    assert.equal(f.calls.length, 3, 'a fresh fetch after invalidation');
  } finally { c.cleanup(); }
});

test('liveModelCapabilities follows the last catalog and feeds the effort guard', async () => {
  const c = tmpCache();
  try {
    const h = handlerWith(gafferCatalog({ cacheFile: c.file }));
    assert.equal(h.liveModelCapabilities, null, 'nothing known before the first discovery');
    await h.listModelOptions();
    assert.deepEqual(h.liveModelCapabilities['claude-opus-4-6'].efforts, ['low', 'medium', 'high', 'max']);
    assert.equal(h.liveModelCapabilities.opus, h.liveModelCapabilities['claude-opus-5-5']);
    assert.deepEqual(h.liveModelCapabilities.opus.contextWindows, [200000, 1000000]);
  } finally { c.cleanup(); }
});

test('a completed CLI turn triggers refreshInBackground on the catalog', async () => {
  const c = tmpCache();
  try {
    const f = okFetch();
    let t = NOW;
    const catalog = gafferCatalog({ cacheFile: c.file, fetch: f, now: () => t });
    let refreshes = 0;
    const origRefresh = catalog.refreshInBackground;
    catalog.refreshInBackground = function () { refreshes++; return origRefresh.apply(this, arguments); };
    const spawns = [];
    const h = new ChatHandler({
      modelCatalog: catalog,
      findClaudeBinary: async () => '/fake/claude',
      lastClaudeLookup: () => null,
      spawn: (bin, args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write() {}, end() {} };
        child.kill = () => {};
        spawns.push(child);
        return child;
      },
    });
    const sock = { readyState: 1, sent: [], _gafferKey: 'test', send(m) { sock.sent.push(JSON.parse(m)); } };
    const origLog = console.log;
    console.log = () => {};
    try {
      await h.handleChat({ message: 'hi', model: 'haiku' }, sock);
      const stdout = [
        JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.289', mcp_servers: [], session_id: 's-1' }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 5 }, content: [{ type: 'text', text: 'done' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 's-1', result: 'done', usage: { input_tokens: 5, output_tokens: 2 } }),
      ].join('\n') + '\n';
      spawns[0].stdout.emit('data', Buffer.from(stdout));
      spawns[0].emit('close', 0);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    } finally { console.log = origLog; }
    assert.equal(sock.sent.filter((m) => m.type === 'chat_done').length, 1);
    assert.equal(refreshes, 1, 'refreshInBackground called once after chat_done');
    assert.equal(f.calls.length, 1, 'the background refresh fetched live');
    // The module throttles a second refresh inside 60s.
    h.refreshCatalogInBackground();
    assert.equal(f.calls.length, 1);
  } finally { c.cleanup(); }
});

function fakeSpawnHandler(catalog, spawns) {
  return new ChatHandler({
    modelCatalog: catalog,
    findClaudeBinary: async () => '/fake/claude',
    lastClaudeLookup: () => null,
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write() {}, end() {} };
      child.kill = () => {};
      spawns.push(child);
      return child;
    },
  });
}

test('a shape-valid cache file with a null entry: list is sane, the getter does not throw, a chat turn runs', async () => {
  const c = tmpCache();
  try {
    writeFileSync(c.file, JSON.stringify({
      catalog: { families: ['opus'], versions: { opus: [null] } }, fetchedAt: NOW, accountId: 'uuid:acct-1',
    }));
    const spawns = [];
    const h = fakeSpawnHandler(gafferCatalog({ cacheFile: c.file }), spawns);
    const out = await h.listModelOptions();
    assert.equal(out.modelAccess, 'ready');
    assert.equal(out.fromCache, true, 'the module accepted the file; Gaffer must cope with its entries');
    // The one family has no valid entry, so the payload lists no model at
    // all (the panel then shows Try again rather than a bare alias).
    assert.deepEqual(out.models, []);
    assert.deepEqual(out.versions, {});
    assert.deepEqual(out.capabilitiesByModel, {});
    assert.doesNotThrow(() => h.liveModelCapabilities);
    assert.deepEqual(h.liveModelCapabilities, {});
    const sock = { readyState: 1, sent: [], _gafferKey: 'test', send(m) { sock.sent.push(JSON.parse(m)); } };
    const origLog = console.log;
    console.log = () => {};
    try {
      await h.handleChat({ message: 'hi', model: 'opus', effort: 'high' }, sock);
    } finally { console.log = origLog; }
    assert.equal(spawns.length, 1, 'the turn reached the spawn (fallback table used)');
    assert.equal(sock.sent.filter((m) => m.type === 'chat_error').length, 0);
  } finally { c.cleanup(); }
});

test('a catalog whose peek() throws leaves liveModelCapabilities null and the turn alive', async () => {
  const spawns = [];
  const h = fakeSpawnHandler({
    get: async () => ({ status: 'network', catalog: null }),
    peek: () => { throw new Error('boom'); },
    invalidate() {}, refreshInBackground: () => Promise.resolve(),
  }, spawns);
  assert.equal(h.liveModelCapabilities, null);
  const sock = { readyState: 1, sent: [], _gafferKey: 'test', send() {} };
  const origLog = console.log;
  console.log = () => {};
  try { await h.handleChat({ message: 'hi', model: 'haiku' }, sock); } finally { console.log = origLog; }
  assert.equal(spawns.length, 1);
});

test('a successful background refresh clears the pending Retry so the next open may use the cache', async () => {
  const c = tmpCache();
  try {
    let fetchImpl = statusFetch(500);
    const f = (u, o) => fetchImpl(u, o);
    let t = NOW;
    const h = handlerWith(gafferCatalog({ cacheFile: c.file, fetch: f, now: () => t }));
    assert.equal((await h.listModelOptions()).modelAccess, 'network');
    assert.equal(h._modelsRetryPending, true);
    // The CLI turn completes, the token is fresh, the background refresh succeeds.
    fetchImpl = okFetch();
    h.refreshCatalogInBackground();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h._modelsRetryPending, false);
    // Now a plain open serves the fresh cache without another fetch.
    const calls = [];
    fetchImpl = (u, o) => { calls.push(u); return okFetch()(u, o); };
    const out = await h.listModelOptions();
    assert.equal(out.modelAccess, 'ready');
    assert.equal(out.fromCache, true);
    assert.equal(calls.length, 0);
  } finally { c.cleanup(); }
});

test('handlers share one catalog: a sign-out invalidate on one is seen by all', async () => {
  const c = tmpCache();
  try {
    const f = okFetch();
    const shared = gafferCatalog({ cacheFile: c.file, fetch: f });
    const a = handlerWith(shared);
    const b = handlerWith(shared);
    await a.listModelOptions();
    assert.ok(b.liveModelCapabilities, 'b sees a\'s discovery through the shared catalog');
    b.invalidateModelCache();
    assert.equal(a.liveModelCapabilities, null);
    assert.equal(existsSync(c.file), false);
  } finally { c.cleanup(); }
});
