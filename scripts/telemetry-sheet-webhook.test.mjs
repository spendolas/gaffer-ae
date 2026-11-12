// Run from the repo root: node --test scripts/telemetry-sheet-webhook.test.mjs
// The Apps Script telemetry endpoint, run under Node with fakes for
// SpreadsheetApp, ContentService, CacheService and LockService. The .gs file
// is plain ES5 with those globals, so it evaluates as a function body here.
// Pins: one row per model, errorKinds only on the first row of a POST, a row
// for an error-only day, backward compatibility with payloads from older
// daemons, and the input rules: every field is validated before anything is
// written, anything else is dropped without a reply that tells a probe so,
// text that could start a spreadsheet formula is neutralised, posts are rate
// limited per install, appends run under a lock, and the sheet has a row cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./telemetry-sheet-webhook.gs', import.meta.url)), 'utf8');

function load({ preload = 0, failLock = false, noCache = false } = {}) {
  const rows = [];
  for (let i = 0; i < preload; i++) rows.push(['x']);
  const sheet = {
    getLastRow: () => rows.length,
    appendRow: (r) => { rows.push(r); },
    getRange: (row, col, n, width) => ({
      getValue: () => (rows[row - 1] || [])[col - 1],
      setValues: (vals) => { vals.forEach((v, i) => { rows[row - 1 + i] = v; }); },
    }),
  };
  const SpreadsheetApp = { getActiveSpreadsheet: () => ({ getActiveSheet: () => sheet }) };
  const ContentService = {
    MimeType: { TEXT: 'text' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
  };
  const store = {};
  const CacheService = { getScriptCache: () => {
    if (noCache) throw new Error('cache unavailable');
    return { get: (k) => (k in store ? store[k] : null), put: (k, v) => { store[k] = String(v); } };
  } };
  const lockState = { acquired: 0, released: 0 };
  const LockService = { getScriptLock: () => ({
    waitLock: () => { if (failLock) throw new Error('lock timeout'); lockState.acquired++; },
    releaseLock: () => { lockState.released++; },
  }) };
  const api = new Function('SpreadsheetApp', 'ContentService', 'CacheService', 'LockService', src
    + '\nreturn { doPost: doPost, rowsForPayload: rowsForPayload, validatePayload: validatePayload, MAX_ROWS: MAX_ROWS, RATE_LIMIT_POSTS: RATE_LIMIT_POSTS, MAX_MODELS: MAX_MODELS, MAX_BODY_CHARS: MAX_BODY_CHARS };')(SpreadsheetApp, ContentService, CacheService, LockService);
  return {
    rows, store, lockState, api,
    post: (body) => api.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }),
    rowsForPayload: api.rowsForPayload,
  };
}

const HEADER = ['date', 'sentAt', 'installId', 'model', 'requestedModel', 'turns', 'inputTokens', 'outputTokens',
  'cacheReadTokens', 'cacheCreationTokens', 'costUsd', 'gafferVersion', 'os', 'aeVersion', 'cliVersion', 'cliSource', 'errorKinds'];
const COL = Object.fromEntries(HEADER.map((h, i) => [h, i]));

const ID = '3f2b8a52-0d4e-4c55-9a77-1b8d5e6f7a90';
const base = { date: '2026-10-08', sentAt: '2026-10-08T10:00:00.000Z', installId: ID, gafferVersion: '0.11.3', os: 'darwin 25.0.0' };

test('the .gs file is ES5 Apps Script (no import/export, no let/const, no arrows)', () => {
  assert.ok(!/^\s*(import|export)\b/m.test(src));
  assert.ok(!/\b(let|const)\s/.test(src));
  assert.ok(!/=>/.test(src));
});

test('header row on an empty sheet, then one row per model, every row as wide as the header', () => {
  const s = load();
  const out = s.post({ ...base, byModel: {
    'claude-haiku-4-5::claude-haiku-4-5': { turns: 3, inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheCreationTokens: 2, costUsd: 0.01, aeVersion: '25.0', cliVersion: '2.1.293', cliSource: 'desktop-app' },
    'claude-sonnet-5::claude-opus-4-8': { turns: 1, inputTokens: 7, outputTokens: 3, costUsd: 0.2 },
  } });
  assert.equal(out.text, 'ok');
  assert.deepEqual(s.rows[0], HEADER);
  assert.equal(s.rows.length, 3);
  s.rows.forEach((r) => assert.equal(r.length, HEADER.length));
  const haiku = s.rows[1];
  assert.equal(haiku[COL.model], 'claude-haiku-4-5');
  assert.equal(haiku[COL.requestedModel], 'claude-haiku-4-5');
  assert.equal(haiku[COL.turns], 3);
  assert.equal(haiku[COL.cliVersion], '2.1.293');
  assert.equal(haiku[COL.cliSource], 'desktop-app');
  assert.equal(haiku[COL.errorKinds], '', 'no errorKinds sent: column empty');
  const sonnet = s.rows[2];
  assert.equal(sonnet[COL.model], 'claude-sonnet-5');
  assert.equal(sonnet[COL.requestedModel], 'claude-opus-4-8', 'composite key keeps the requested model');
  assert.equal(sonnet[COL.cacheReadTokens], 0, 'missing counters read as 0');
  assert.equal(sonnet[COL.aeVersion], '');
  // A second POST on a non-empty sheet writes no second header.
  s.post({ ...base, byModel: { 'a::a': { turns: 1 } } });
  assert.equal(s.rows.length, 4);
  assert.equal(s.rows[3][COL.model], 'a');
});

test('errorKinds is written on the first row of a POST only, so a SUM over the column counts each failure once', () => {
  const s = load();
  const errorKinds = { auth: 2, stale_session: 1 };
  s.post({ ...base, byModel: { 'a::a': { turns: 1 }, 'b::b': { turns: 1 }, 'c::c': { turns: 1 } }, errorKinds });
  const data = s.rows.slice(1);
  assert.equal(data.length, 3);
  assert.deepEqual(JSON.parse(data[0][COL.errorKinds]), errorKinds);
  assert.equal(data[1][COL.errorKinds], '');
  assert.equal(data[2][COL.errorKinds], '');
  // The next POST (another day or a later send) carries its own errorKinds on its own first row.
  s.post({ ...base, sentAt: '2026-10-08T23:00:00.000Z', byModel: { 'a::a': { turns: 1 } }, errorKinds: { too_long: 1 } });
  assert.deepEqual(JSON.parse(s.rows[4][COL.errorKinds]), { too_long: 1 });
});

test('a day with only errorKinds (empty byModel) gets one "(none)" row with zero counters, instead of nothing', () => {
  const s = load();
  s.post({ ...base, byModel: {}, errorKinds: { unknown_error: 1 } });
  assert.equal(s.rows.length, 2, 'header plus one row');
  const r = s.rows[1];
  assert.equal(r.length, HEADER.length);
  assert.equal(r[COL.date], '2026-10-08');
  assert.equal(r[COL.installId], ID);
  assert.equal(r[COL.model], '(none)');
  assert.equal(r[COL.requestedModel], '(none)');
  ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd'].forEach((c) => assert.equal(r[COL[c]], 0, c));
  assert.equal(r[COL.gafferVersion], '0.11.3');
  assert.equal(r[COL.os], 'darwin 25.0.0');
  assert.deepEqual(JSON.parse(r[COL.errorKinds]), { unknown_error: 1 });
  // A byModel that is missing entirely (not just empty) behaves the same.
  const s2 = load();
  s2.post({ ...base, errorKinds: { auth: 1 } });
  assert.equal(s2.rows.length, 2);
  assert.equal(s2.rows[1][COL.model], '(none)');
});

test('backward compatible: payloads from older daemons (no errorKinds, no cli fields) still write their rows and nothing else', () => {
  const s = load();
  // Gaffer 0.10.x shape: no gafferVersion/os/aeVersion either.
  s.post({ date: '2026-09-01', sentAt: '2026-09-01T10:00:00.000Z', installId: ID, byModel: { 'claude-sonnet-5::claude-sonnet-5': { turns: 4, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.5 } } });
  assert.equal(s.rows.length, 2);
  const r = s.rows[1];
  assert.equal(r.length, HEADER.length);
  assert.equal(r[COL.turns], 4);
  assert.equal(r[COL.gafferVersion], '');
  assert.equal(r[COL.cliVersion], '');
  assert.equal(r[COL.errorKinds], '');
  // Empty everything: no data row (nothing to record), no crash.
  s.post({ date: '2026-09-01', installId: ID, byModel: {} });
  s.post({ date: '2026-09-01', installId: ID, byModel: {}, errorKinds: {} });
  s.post({});
  assert.equal(s.rows.length, 2);
});

test('the values the daemon really sends pass: unknown versions, a Windows os string, an aeVersion of unknown, a prerelease version', () => {
  const s = load();
  s.post({ ...base, gafferVersion: 'unknown', os: 'win32 10.0.22631', byModel: { 'claude-opus-4-8::claude-opus-4-8': { turns: 1, aeVersion: 'unknown', cliVersion: 'unknown', cliSource: 'unknown' } } });
  s.post({ ...base, gafferVersion: '0.12.0-beta.1', os: 'linux 6.8.0-45-generic', byModel: { 'a.b-c::d': { turns: 1, aeVersion: '26.0' } } });
  assert.equal(s.rows.length, 3, 'header and two rows');
  assert.equal(s.rows[1][COL.gafferVersion], 'unknown');
  assert.equal(s.rows[2][COL.gafferVersion], '0.12.0-beta.1');
});

// ---- input rules: everything is validated before anything is written ----

// A post that must be dropped: the reply is the same "ok" as for a good one
// (a probe learns nothing) and nothing reaches the sheet, not even the header.
function assertDropped(label, body, opts) {
  const s = load(opts);
  const out = s.post(body);
  assert.equal(out.text, 'ok', label + ': same reply as a good post');
  assert.equal(s.rows.length, 0, label + ': nothing written');
  assert.equal(s.lockState.acquired, 0, label + ': no lock taken for a bad post');
}

test('a malformed body answers "ok" and writes nothing: bad JSON, not an object, empty, no body at all', () => {
  assertDropped('bad json', '{not json');
  assertDropped('empty', '');
  assertDropped('array', '[]');
  assertDropped('null', 'null');
  assertDropped('string', '"hello"');
  assertDropped('number', '5');
  const s = load();
  assert.equal(s.api.doPost({}).text, 'ok');
  assert.equal(s.api.doPost({ postData: {} }).text, 'ok');
  assert.equal(s.api.doPost(undefined).text, 'ok');
  assert.equal(s.rows.length, 0);
});

test('installId must be a UUID', () => {
  for (const bad of ['test-suite', '', 'x'.repeat(200), '=HYPERLINK("http://example.test","x")', '3f2b8a52-0d4e-4c55-9a77-1b8d5e6f7a9', '3f2b8a52-0d4e-4c55-9a77-1b8d5e6f7a90 ', null, 5, {}, []]) {
    assertDropped('installId ' + JSON.stringify(bad), { ...base, installId: bad, byModel: { 'a::a': { turns: 1 } } });
  }
  assertDropped('missing installId', { date: base.date, sentAt: base.sentAt, byModel: { 'a::a': { turns: 1 } } });
  const s = load();
  s.post({ ...base, installId: ID.toUpperCase(), byModel: { 'a::a': { turns: 1 } } });
  assert.equal(s.rows.length, 2, 'an upper-case UUID is still a UUID');
});

test('date must be YYYY-MM-DD and a real day; sentAt must be an ISO timestamp', () => {
  for (const bad of ['2026-13-01', '2026-02-30', '26-10-08', '2026-10-8', '2026/10/08', '2026-10-08T10:00:00Z', '=1+1', '', null, 20261008, { a: 1 }]) {
    assertDropped('date ' + JSON.stringify(bad), { ...base, date: bad, byModel: { 'a::a': { turns: 1 } } });
  }
  assertDropped('missing date', { installId: ID, sentAt: base.sentAt, byModel: { 'a::a': { turns: 1 } } });
  for (const bad of ['yesterday', '=cmd|calc', '2026-10-08 10:00:00', '2026-10-08T10:00:00Z; DROP', 'x'.repeat(100), 7, {}]) {
    assertDropped('sentAt ' + JSON.stringify(bad), { ...base, sentAt: bad, byModel: { 'a::a': { turns: 1 } } });
  }
});

test('gafferVersion, os, aeVersion, cliVersion and cliSource must match short patterns or an enum', () => {
  const bad = [
    ['gafferVersion', '=1+1'], ['gafferVersion', '0.12'], ['gafferVersion', 'x'.repeat(50)], ['gafferVersion', 5], ['gafferVersion', {}],
    ['os', '=HYPERLINK("x")'], ['os', 'darwin'], ['os', 'x'.repeat(200)], ['os', '@SUM(1)'], ['os', 'darwin 25\n=1+1'], ['os', 7],
  ];
  for (const [k, v] of bad) assertDropped(k + ' ' + JSON.stringify(v), { ...base, [k]: v, byModel: { 'a::a': { turns: 1 } } });
  const bucketBad = [
    ['aeVersion', '=1+1'], ['aeVersion', 'x'.repeat(40)], ['aeVersion', '25.0 26.0'], ['aeVersion', 25],
    ['cliVersion', '2.1'], ['cliVersion', '/Users/me/claude'], ['cliVersion', '=1+1'], ['cliVersion', 'x'.repeat(80)],
    ['cliSource', 'somewhere-else'], ['cliSource', '/usr/bin/claude'], ['cliSource', '=1+1'], ['cliSource', 3],
  ];
  for (const [k, v] of bucketBad) assertDropped(k + ' ' + JSON.stringify(v), { ...base, byModel: { 'a::a': { turns: 1, [k]: v } } });
  for (const src of ['desktop-app', 'standalone', 'config-pin', 'path', 'unknown']) {
    const s = load();
    s.post({ ...base, byModel: { 'a::a': { turns: 1, cliSource: src } } });
    assert.equal(s.rows[1][COL.cliSource], src);
  }
});

test('model keys must match the model pattern, with an optional ::requested half', () => {
  const bad = ['=HYPERLINK("http://example.test")::a', 'a::b::c', 'A::a', 'a b::a', '::a', 'a::', 'x'.repeat(41) + '::a', 'a::' + 'x'.repeat(41),
    '__proto__', 'a[1m]::a', '@SUM(1)', '', 'a\n::a', 'a::=1+1', 'モデル::a'];
  for (const key of bad) {
    assertDropped('key ' + JSON.stringify(key), { ...base, byModel: { [key]: { turns: 1 } } });
  }
  const ok = ['a', 'claude-opus-4-8', 'claude-opus-4-8::claude-sonnet-5', 'x'.repeat(40) + '::' + 'y'.repeat(40), 'a.b-c::d.e-f'];
  for (const key of ok) {
    const s = load();
    s.post({ ...base, byModel: { [key]: { turns: 1 } } });
    assert.equal(s.rows.length, 2, 'accepted: ' + key);
  }
  // A bucket that is not an object is wrong, not "tolerated".
  assertDropped('null bucket', { ...base, byModel: { 'a::a': null } });
  assertDropped('string bucket', { ...base, byModel: { 'a::a': 'text' } });
  assertDropped('array bucket', { ...base, byModel: { 'a::a': [1, 2] } });
  assertDropped('byModel as an array', { ...base, byModel: [{ turns: 1 }] });
  assertDropped('byModel as a string', { ...base, byModel: 'a::a' });
});

test('counters must be finite, non-negative numbers within bounds', () => {
  const bad = [-1, '5', '=1+1', 1e30, Infinity, null, true, {}, [], 1e12];
  for (const field of ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd']) {
    for (const v of bad) assertDropped(field + ' ' + String(v), { ...base, byModel: { 'a::a': { turns: 1, [field]: v } } });
  }
  // JSON cannot carry Infinity or NaN, but a hand-built string can: 1e999 parses to Infinity.
  assertDropped('1e999', '{"date":"2026-10-08","sentAt":"2026-10-08T10:00:00.000Z","installId":"' + ID + '","byModel":{"a::a":{"turns":1e999}}}');
  const s = load();
  s.post({ ...base, byModel: { 'a::a': { turns: 1000, inputTokens: 5e8, outputTokens: 5e8, cacheReadTokens: 5e9, cacheCreationTokens: 1e8, costUsd: 1234.5 } } });
  assert.equal(s.rows.length, 2, 'realistic large day passes');
});

test('at most 10 models per post, and a body of at most 8 KB', () => {
  const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['m' + i + '::m' + i, { turns: 1 }]));
  const s = load();
  s.post({ ...base, byModel: many(10) });
  assert.equal(s.rows.length, 11, 'ten models pass');
  assertDropped('eleven models', { ...base, byModel: many(11) });
  assertDropped('a thousand models', { ...base, byModel: many(1000) });
  assertDropped('oversize body', JSON.stringify({ ...base, byModel: { 'a::a': { turns: 1 } }, filler: 'x'.repeat(9000) }));
  assertDropped('oversize body, huge field', JSON.stringify({ ...base, os: 'x'.repeat(100000), byModel: {} }));
  const edge = JSON.stringify({ ...base, byModel: { 'a::a': { turns: 1 } } });
  assert.ok(edge.length < 8192);
  const s2 = load();
  assert.equal(s2.api.MAX_BODY_CHARS, 8192);
  assert.equal(s2.api.MAX_MODELS, 10);
});

test('errorKinds: a closed shape, small counts, few keys; the sheet gets a rebuilt copy, never the raw text', () => {
  for (const bad of [{ auth: -1 }, { auth: 1.5 }, { auth: '2' }, { auth: 1e9 }, { '=1+1': 1 }, { 'a b': 1 }, 'text', [1], { auth: { x: 1 } },
    Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, 1]))]) {
    assertDropped('errorKinds ' + JSON.stringify(bad).slice(0, 40), { ...base, byModel: { 'a::a': { turns: 1 } }, errorKinds: bad });
  }
  const s = load();
  s.post({ ...base, byModel: { 'a::a': { turns: 1 } }, errorKinds: { auth: 2, stale_session: 1, text_fallback: 0 } });
  assert.deepEqual(JSON.parse(s.rows[1][COL.errorKinds]), { auth: 2, stale_session: 1, text_fallback: 0 });
});

test('unknown extra fields are ignored, not stored and not a reason to drop', () => {
  const s = load();
  s.post({ ...base, extra: '=1+1', byModel: { 'a::a': { turns: 1, note: '=HYPERLINK("x")' } } });
  assert.equal(s.rows.length, 2);
  assert.ok(!JSON.stringify(s.rows).includes('HYPERLINK'));
});

test('text that could start a spreadsheet formula is neutralised in every cell', () => {
  const s = load();
  // These pass validation (a leading - is allowed by the model pattern) and must still never start a formula.
  s.post({ ...base, byModel: { '-1::-2': { turns: 1 }, '--x::-y': { turns: 1 } } });
  const data = s.rows.slice(1);
  assert.equal(data.length, 2);
  for (const r of data) {
    for (const cell of r) {
      if (typeof cell === 'string' && cell !== '') assert.ok(!/^[=+\-@\t\r]/.test(cell), 'cell starts like a formula: ' + JSON.stringify(cell));
    }
  }
  assert.equal(data[0][COL.model], "'-1");
  assert.equal(data[0][COL.requestedModel], "'-2");
  // Ordinary text is left alone.
  assert.equal(load().rowsForPayload({ ...base, byModel: { 'claude-opus-4-8::claude-opus-4-8': { turns: 1 } } })[0][COL.model], 'claude-opus-4-8');
  // The helper neutralises each starter, for any future column that takes free text.
  const f = new Function(src + '\nreturn typeof safeCell === "function" ? safeCell : null;')();
  assert.ok(f, 'safeCell exists');
  for (const starter of ['=1+1', '+1', '-1', '@SUM(1)', '\t=1', '\r=1']) assert.equal(f(starter), "'" + starter);
  assert.equal(f('plain'), 'plain');
  assert.equal(f(5), 5);
  assert.equal(f(''), '');
});

test('posts are rate limited per installId; another install is not affected', () => {
  const s = load();
  const limit = s.api.RATE_LIMIT_POSTS;
  assert.ok(limit >= 6 && limit <= 100, 'a sane limit: ' + limit);
  for (let i = 0; i < limit + 5; i++) s.post({ ...base, byModel: { 'a::a': { turns: 1 } } });
  assert.equal(s.rows.length, 1 + limit, 'header plus exactly the allowed posts');
  const other = '11111111-2222-4333-8444-555555555555';
  s.post({ ...base, installId: other, byModel: { 'a::a': { turns: 1 } } });
  assert.equal(s.rows.length, 2 + limit, 'a different install still gets through');
  assert.ok(Object.keys(s.store).every((k) => !k.includes('=')), 'cache keys carry only the validated id');
});

test('a cache that is unavailable does not stop a post (the limit is best effort)', () => {
  const s = load({ noCache: true });
  assert.equal(s.post({ ...base, byModel: { 'a::a': { turns: 1 } } }).text, 'ok');
  assert.equal(s.rows.length, 2);
});

test('appends run under the script lock, released on every path; a lock that cannot be taken drops the post quietly', () => {
  const s = load();
  s.post({ ...base, byModel: { 'a::a': { turns: 1 } } });
  assert.equal(s.lockState.acquired, 1);
  assert.equal(s.lockState.released, 1);
  const limited = load();
  for (let i = 0; i < limited.api.RATE_LIMIT_POSTS + 2; i++) limited.post({ ...base, byModel: { 'a::a': { turns: 1 } } });
  assert.equal(limited.lockState.acquired, limited.lockState.released, 'a rate-limited post still releases the lock');
  assertDropped('lock timeout', { ...base, byModel: { 'a::a': { turns: 1 } } }, { failLock: true });
  const failed = load({ failLock: true });
  assert.equal(failed.post({ ...base, byModel: { 'a::a': { turns: 1 } } }).text, 'ok');
  assert.equal(failed.lockState.released, 0, 'no release for a lock never taken');
});

test('a total row cap: past it nothing is appended and one "cap reached" row is written, once', () => {
  const s = load({ preload: 5 });
  const cap = s.api.MAX_ROWS;
  assert.ok(cap >= 10000 && cap <= 1000000, 'cap: ' + cap);
  const full = load({ preload: cap });
  full.post({ ...base, byModel: { 'a::a': { turns: 1 } } });
  assert.equal(full.rows.length, cap + 1, 'exactly one row past the cap');
  const mark = full.rows[cap];
  assert.equal(mark.length, HEADER.length);
  assert.equal(mark[COL.model], '(cap reached)');
  full.post({ ...base, byModel: { 'a::a': { turns: 1 } } });
  full.post({ ...base, installId: '11111111-2222-4333-8444-555555555555', byModel: { 'a::a': { turns: 1 } } });
  assert.equal(full.rows.length, cap + 1, 'no second marker, no more data');
  // A post that would cross the cap is cut at it.
  const near = load({ preload: cap - 1 });
  near.post({ ...base, byModel: { 'a::a': { turns: 1 }, 'b::b': { turns: 1 }, 'c::c': { turns: 1 } } });
  assert.equal(near.rows.length, cap, 'filled to the cap and no further');
  near.post({ ...base, byModel: { 'a::a': { turns: 1 } } });
  assert.equal(near.rows[cap][COL.model], '(cap reached)');
});

test('rowsForPayload validates too: a bad payload yields no rows, a good one the usual rows', () => {
  const s = load();
  assert.deepEqual(s.rowsForPayload({ ...base, byModel: { '=1+1::a': { turns: 1 } } }), []);
  assert.deepEqual(s.rowsForPayload(null), []);
  assert.deepEqual(s.rowsForPayload('x'), []);
  const rows = s.rowsForPayload({ ...base, byModel: { 'a::a': { turns: 2 }, 'c::c': { turns: 2 } } });
  assert.equal(rows.length, 2);
  rows.forEach((r) => assert.equal(r.length, HEADER.length));
});

test('hostile prototype and nesting tricks do not get through or crash the script', () => {
  const s = load();
  assert.equal(s.post('{"__proto__":{"polluted":true},"date":"2026-10-08","sentAt":"2026-10-08T10:00:00.000Z","installId":"' + ID + '","byModel":{"__proto__":{"turns":1}}}').text, 'ok');
  assert.equal(s.rows.length, 0);
  assert.equal({}.polluted, undefined);
  assert.equal(s.post('{"a":'.repeat(2000)).text, 'ok');
  assert.equal(s.post('['.repeat(5000)).text, 'ok');
  assert.equal(s.rows.length, 0);
});
