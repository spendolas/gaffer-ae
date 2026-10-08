// Run from the repo root: node --test scripts/telemetry-sheet-webhook.test.mjs
// The Apps Script telemetry endpoint, run under Node with a fake
// SpreadsheetApp and ContentService. The .gs file is plain ES5 with two
// globals, so it evaluates as a function body here. Pins: one row per model,
// errorKinds only on the first row of a POST, a row for an error-only day,
// and backward compatibility with payloads from older daemons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./telemetry-sheet-webhook.gs', import.meta.url)), 'utf8');

function load() {
  const rows = [];
  const sheet = {
    getLastRow: () => rows.length,
    appendRow: (r) => { rows.push(r); },
  };
  const SpreadsheetApp = { getActiveSpreadsheet: () => ({ getActiveSheet: () => sheet }) };
  const ContentService = {
    MimeType: { TEXT: 'text' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
  };
  const api = new Function('SpreadsheetApp', 'ContentService', src + '\nreturn { doPost: doPost, rowsForPayload: rowsForPayload };')(SpreadsheetApp, ContentService);
  return { rows, post: (body) => api.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }), rowsForPayload: api.rowsForPayload };
}

const HEADER = ['date', 'sentAt', 'installId', 'model', 'requestedModel', 'turns', 'inputTokens', 'outputTokens',
  'cacheReadTokens', 'cacheCreationTokens', 'costUsd', 'gafferVersion', 'os', 'aeVersion', 'cliVersion', 'cliSource', 'errorKinds'];
const COL = Object.fromEntries(HEADER.map((h, i) => [h, i]));

const base = { date: '2026-10-08', sentAt: '2026-10-08T10:00:00Z', installId: 'test-suite', gafferVersion: '0.11.3', os: 'darwin 25.0' };

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
  s.post({ ...base, sentAt: '2026-10-08T23:00:00Z', byModel: { 'a::a': { turns: 1 } }, errorKinds: { too_long: 1 } });
  assert.deepEqual(JSON.parse(s.rows[4][COL.errorKinds]), { too_long: 1 });
});

test('a day with only errorKinds (empty byModel) gets one "(none)" row with zero counters, instead of nothing', () => {
  const s = load();
  s.post({ ...base, byModel: {}, errorKinds: { unknown_error: 1 } });
  assert.equal(s.rows.length, 2, 'header plus one row');
  const r = s.rows[1];
  assert.equal(r.length, HEADER.length);
  assert.equal(r[COL.date], '2026-10-08');
  assert.equal(r[COL.installId], 'test-suite');
  assert.equal(r[COL.model], '(none)');
  assert.equal(r[COL.requestedModel], '(none)');
  ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd'].forEach((c) => assert.equal(r[COL[c]], 0, c));
  assert.equal(r[COL.gafferVersion], '0.11.3');
  assert.equal(r[COL.os], 'darwin 25.0');
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
  s.post({ date: '2026-09-01', sentAt: 'x', installId: 'old', byModel: { 'claude-sonnet-5::claude-sonnet-5': { turns: 4, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.5 } } });
  assert.equal(s.rows.length, 2);
  const r = s.rows[1];
  assert.equal(r.length, HEADER.length);
  assert.equal(r[COL.turns], 4);
  assert.equal(r[COL.gafferVersion], '');
  assert.equal(r[COL.cliVersion], '');
  assert.equal(r[COL.errorKinds], '');
  // Empty everything: no data row (nothing to record), no crash.
  s.post({ date: '2026-09-01', byModel: {} });
  s.post({ date: '2026-09-01', byModel: {}, errorKinds: {} });
  s.post({});
  assert.equal(s.rows.length, 2);
});

test('bad JSON answers "bad json" after the header, without throwing', () => {
  const s = load();
  const out = s.post('{not json');
  assert.equal(out.text, 'bad json');
  assert.equal(s.rows.length, 1, 'header only');
});

test('rowsForPayload tolerates junk bucket values', () => {
  const s = load();
  const rows = s.rowsForPayload({ ...base, byModel: { 'a::a': null, 'b::b': 'text', 'c::c': { turns: 2 } } });
  assert.equal(rows.length, 3);
  rows.forEach((r) => assert.equal(r.length, HEADER.length));
  assert.equal(rows[0][COL.turns], 0);
  assert.equal(rows[2][COL.turns], 2);
});
