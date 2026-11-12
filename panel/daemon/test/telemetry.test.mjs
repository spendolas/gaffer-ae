import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

// A personalised, filterable id for anything the test suite sends — never a
// random UUID, so it reads as obviously-not-a-real-install in the sheet, the
// same way "dev-machine" does for manual dev runs.
var TEST_INSTALL_ID = 'test-suite';

// Isolated, throwaway config + buffer files for this run only — the suite
// used to read/write the real .gaffer-config.json directly (comment removed
// below used to say "no path-injection seam"). An interrupted run could
// leave the real file blanked mid-test, and the real installId would get
// silently regenerated on the next real chat turn. Point telemetry.js at
// these instead, before it's ever imported.
var runTag = process.pid + '-' + Date.now();
var CONFIG_PATH = join(tmpdir(), 'gaffer-test-config-' + runTag + '.json');
var BUFFER_PATH = join(tmpdir(), 'gaffer-test-buffer-' + runTag + '.json');
process.env.GAFFER_CONFIG_PATH = CONFIG_PATH;
process.env.GAFFER_BUFFER_PATH = BUFFER_PATH;

var server = http.createServer(function (req, res) {
  var body = '';
  req.on('data', function (c) { body += c; });
  req.on('end', function () {
    server.lastBody = body;
    // A test may park a promise here to hold the response open.
    var hold = server.holdUntil || Promise.resolve();
    server.holdUntil = null;
    hold.then(function () {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
});
await new Promise(function (resolve) { server.listen(0, resolve); });
process.env.GAFFER_TELEMETRY_URL = 'http://127.0.0.1:' + server.address().port;

var telemetry = await import('../telemetry.js');

function clearBuffer() {
  try { if (existsSync(BUFFER_PATH)) unlinkSync(BUFFER_PATH); } catch (e) {}
}

test('recordUsage buffers even when telemetry is disabled', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: false }));
  clearBuffer();

  telemetry.recordUsage({
    model: 'claude-sonnet-5', requestedModel: 'claude-opus-4-8',
    inputTokens: 100, outputTokens: 50, costUsd: 0.01,
  });

  var buffer = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
  assert.ok(buffer.byModel['claude-sonnet-5::claude-opus-4-8'], 'composite key present');
  assert.equal(buffer.byModel['claude-sonnet-5::claude-opus-4-8'].turns, 1);
  assert.equal(telemetry.isEnabled(), false);
});

test('recordUsage falls back to model as requestedModel when absent (no downshift)', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: false }));
  clearBuffer();

  telemetry.recordUsage({ model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 5 });

  var buffer = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
  assert.ok(buffer.byModel['claude-sonnet-5::claude-sonnet-5']);
});

test('flush() does not send while disabled, and keeps the buffer', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: false }));
  writeFileSync(BUFFER_PATH, JSON.stringify({ date: '2020-01-01', byModel: { 'a::a': { turns: 1 } } }));
  server.lastBody = null;

  var sent = await telemetry.flush();

  assert.equal(sent, false);
  assert.equal(server.lastBody, null, 'no HTTP request made while disabled');
  assert.ok(existsSync(BUFFER_PATH), 'buffer preserved for later send');
});

test('flush() sends the composite-keyed payload and clears the buffer on success', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: true }));
  writeFileSync(BUFFER_PATH, JSON.stringify({
    date: '2020-01-01',
    byModel: { 'claude-sonnet-5::claude-opus-4-8': { turns: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.02 } },
  }));
  server.lastBody = null;

  var sent = await telemetry.flush();

  assert.equal(sent, true);
  var payload = JSON.parse(server.lastBody);
  assert.equal(payload.date, '2020-01-01');
  assert.equal(payload.installId, TEST_INSTALL_ID);
  assert.ok(payload.sentAt, 'sentAt included');
  assert.ok(payload.byModel['claude-sonnet-5::claude-opus-4-8']);
  assert.equal(existsSync(BUFFER_PATH), false, 'buffer cleared after confirmed send');
});

test('flush() is a no-op on an empty buffer', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: true }));
  clearBuffer();
  server.lastBody = null;

  var sent = await telemetry.flush();

  assert.equal(sent, false);
  assert.equal(server.lastBody, null);
});

// Anything that smells like a filesystem path, a home folder or an account.
// Applied to the whole serialized payload: the endpoint is public and
// unauthenticated, so the version string and a closed enum are all that may
// leave the machine about the Claude binary.
var PATH_LIKE = /\/(Users|Volumes|home|private|opt|usr)\/|[A-Za-z]:\\|AppData|\\\\Users\\\\|\.app\b|claude-code\/|@/;

test('recordUsage stores only x.y.z and a closed enum for the Claude Code fields', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: false }));
  clearBuffer();

  telemetry.recordUsage({ model: 'haiku', cliVersion: '2.1.289 (Claude Code)', cliSource: 'desktop-app', inputTokens: 1 });
  var b = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8')).byModel['haiku::haiku'];
  assert.equal(b.cliVersion, '2.1.289');
  assert.equal(b.cliSource, 'desktop-app');

  // Garbage in: a path as the version, a path as the source. Neither is stored,
  // and the earlier good values are kept (last-seen, like aeVersion).
  telemetry.recordUsage({ model: 'haiku', cliVersion: '/Users/me/.local/bin/claude', cliSource: '/Users/me/claude.app', inputTokens: 1 });
  b = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8')).byModel['haiku::haiku'];
  assert.equal(b.cliVersion, '2.1.289');
  assert.equal(b.cliSource, 'desktop-app');

  // Nothing known at all: 'unknown', never undefined.
  telemetry.recordUsage({ model: 'opus', inputTokens: 1 });
  var o = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8')).byModel['opus::opus'];
  assert.equal(o.cliVersion, 'unknown');
  assert.equal(o.cliSource, 'unknown');
});

test('sanitizers: version regex and length cap, source enum, step mapping', () => {
  assert.equal(telemetry.sanitizeCliVersion('2.1.293'), '2.1.293');
  assert.equal(telemetry.sanitizeCliVersion('  2.1.293 (Claude Code)\n'), '2.1.293');
  assert.equal(telemetry.sanitizeCliVersion('2.1.293-beta.1+d96fccce310b'), '2.1.293');
  assert.equal(telemetry.sanitizeCliVersion('v2.1.293'), '2.1.293', 'a leading v is tolerated');
  assert.equal(telemetry.sanitizeCliVersion('vv2.1.293'), 'unknown');
  assert.equal(telemetry.sanitizeCliVersion('2.1.2934567'), 'unknown', 'an over-long patch is not truncated into a version');
  assert.equal(telemetry.sanitizeCliVersion('2.1.29345'), '2.1.29345', 'five digits is still inside the cap');
  assert.equal(telemetry.sanitizeCliVersion('2.1'), 'unknown');
  assert.equal(telemetry.sanitizeCliVersion('unknown'), 'unknown');
  assert.equal(telemetry.sanitizeCliVersion(null), 'unknown');
  assert.equal(telemetry.sanitizeCliVersion({ toString: function () { return '2.1.1'; } }), 'unknown');
  assert.equal(telemetry.sanitizeCliVersion('12345.1.1'), 'unknown', 'component length cap');
  assert.ok(telemetry.sanitizeCliVersion('2.1.293' + new Array(500).join('x')).length <= 16);

  ['desktop-app', 'standalone', 'config-pin', 'path', 'unknown'].forEach(function (s) {
    assert.equal(telemetry.sanitizeCliSource(s), s);
  });
  assert.equal(telemetry.sanitizeCliSource('desktop app'), 'unknown');
  assert.equal(telemetry.sanitizeCliSource(undefined), 'unknown');
  assert.equal(telemetry.sanitizeCliSource(['path']), 'unknown');

  assert.equal(telemetry.cliSourceFromStep('desktop app'), 'desktop-app');
  assert.equal(telemetry.cliSourceFromStep('known location'), 'standalone');
  assert.equal(telemetry.cliSourceFromStep('config'), 'config-pin');
  assert.equal(telemetry.cliSourceFromStep('PATH'), 'path');
  assert.equal(telemetry.cliSourceFromStep('login shell'), 'path');
  assert.equal(telemetry.cliSourceFromStep('something new'), 'unknown');
  assert.equal(telemetry.cliSourceFromStep(null), 'unknown');
});

test('recordTurnKind counts known kinds and text_fallback per day, drops the rest', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: false }));
  clearBuffer();

  telemetry.recordTurnKind('stale_session', 'structure');
  telemetry.recordTurnKind('stale_session', 'text');
  telemetry.recordTurnKind('too_long', 'structure');
  telemetry.recordTurnKind('ok', 'structure');
  telemetry.recordTurnKind('/Users/me/secret', 'structure');
  telemetry.recordTurnKind(undefined, 'none');
  telemetry.recordTurnKind('api_error', 'text');

  var buffer = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
  assert.deepEqual(buffer.errorKinds, { stale_session: 2, too_long: 1, api_error: 1, text_fallback: 2 });
  assert.equal(telemetry.isEnabled(), false);
});

test('recordTurnKind on a buffer written by an older daemon (no errorKinds) just adds the map', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: false }));
  writeFileSync(BUFFER_PATH, JSON.stringify({ date: new Date().toISOString().slice(0, 10), byModel: { 'a::a': { turns: 1 } } }));
  telemetry.recordTurnKind('auth', 'structure');
  var buffer = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
  assert.deepEqual(buffer.errorKinds, { auth: 1 });
  assert.equal(buffer.byModel['a::a'].turns, 1, 'existing data kept');
});

test('flush() payload carries cliVersion, cliSource and errorKinds and nothing path-like', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: true }));
  clearBuffer();
  // A fake turn as chat-handler records it: a result event's usage plus the
  // version from the init event, then one classified failure.
  telemetry.recordUsage({
    model: 'haiku', requestedModel: 'haiku', aeVersion: '25.0',
    cliVersion: '2.1.289', cliSource: 'desktop-app',
    inputTokens: 10, outputTokens: 5, costUsd: 0.001,
  });
  telemetry.recordTurnKind('auth', 'structure');
  // Poison the on-disk map directly: a free-form key must not get through.
  var raw = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
  raw.errorKinds['/Users/me'] = 3;
  raw.errorKinds.too_long = 'not a number';
  writeFileSync(BUFFER_PATH, JSON.stringify(raw));
  server.lastBody = null;

  var sent = await telemetry.flush();

  assert.equal(sent, true);
  var payload = JSON.parse(server.lastBody);
  var bucket = payload.byModel['haiku::haiku'];
  assert.equal(bucket.cliVersion, '2.1.289');
  assert.equal(bucket.cliSource, 'desktop-app');
  assert.equal(bucket.aeVersion, '25.0');
  assert.deepEqual(payload.errorKinds, { auth: 1 });
  assert.equal(PATH_LIKE.test(server.lastBody), false, 'no path-like string anywhere in the payload: ' + server.lastBody);
  assert.equal(existsSync(BUFFER_PATH), false, 'buffer cleared after confirmed send');
});

test('flush() while opted out sends nothing even with the new fields buffered', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: false }));
  clearBuffer();
  telemetry.recordUsage({ model: 'haiku', cliVersion: '2.1.289', cliSource: 'desktop-app', inputTokens: 1 });
  telemetry.recordTurnKind('too_long', 'structure');
  server.lastBody = null;

  var sent = await telemetry.flush();

  assert.equal(sent, false);
  assert.equal(server.lastBody, null, 'no HTTP request made while disabled');
  assert.ok(existsSync(BUFFER_PATH), 'buffer preserved for later send');
  clearBuffer();
});

test('flush() re-sanitizes cliVersion and cliSource per bucket, so a hand-edited buffer cannot smuggle text', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: true }));
  writeFileSync(BUFFER_PATH, JSON.stringify({
    date: '2020-01-01',
    byModel: {
      'haiku::haiku': { turns: 1, cliVersion: '/Users/me/.local/bin/claude 2.1.1', cliSource: '/Users/me/claude.app', aeVersion: '25.0' },
      'opus::opus': { turns: 2, cliVersion: 'v2.1.300 (Claude Code)', cliSource: 'standalone' },
      'junk::junk': 'not an object',
    },
  }));
  server.lastBody = null;

  var sent = await telemetry.flush();

  assert.equal(sent, true);
  var payload = JSON.parse(server.lastBody);
  assert.deepEqual(payload.byModel['haiku::haiku'], { turns: 1, cliVersion: 'unknown', cliSource: 'unknown', aeVersion: '25.0' });
  assert.deepEqual(payload.byModel['opus::opus'], { turns: 2, cliVersion: '2.1.300', cliSource: 'standalone' });
  assert.equal('junk::junk' in payload.byModel, false);
  assert.equal(PATH_LIKE.test(server.lastBody), false, 'no path-like string anywhere in the payload: ' + server.lastBody);
});

test('flush() re-sanitizes byModel keys to the endpoint pattern and keeps at most ten models', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: true }));
  var big = {};
  for (var i = 0; i < 14; i++) big['m' + i + '::m' + i] = { turns: i + 1 };
  big['Claude-Opus-4-8[1m]::claude-opus-4-8'] = { turns: 100 };
  big['=HYPERLINK("http://example.test")::a'] = { turns: 50 };
  big['__proto__'] = { turns: 1 };
  writeFileSync(BUFFER_PATH, JSON.stringify({ date: '2020-01-01', byModel: big }));
  server.lastBody = null;

  var sent = await telemetry.flush();

  assert.equal(sent, true);
  var payload = JSON.parse(server.lastBody);
  var keys = Object.keys(payload.byModel);
  assert.ok(keys.length <= 10, 'at most ten models: ' + keys.length);
  keys.forEach(function (k) {
    assert.match(k, /^[a-z0-9.\-]{1,40}(::[a-z0-9.\-]{1,40})?$/, 'key matches the endpoint pattern: ' + k);
  });
  assert.ok('claude-opus-4-8-1m::claude-opus-4-8' in payload.byModel, 'a model name with brackets is normalised, not dropped');
  assert.ok('hyperlink-http-example.test::a' in payload.byModel, 'a formula-looking key is reduced to its safe characters');
  assert.equal(payload.byModel['claude-opus-4-8-1m::claude-opus-4-8'].turns, 100, 'the busiest models are the ones kept');
  assert.equal(keys.some(function (k) { return k.indexOf('proto') !== -1 && Object.prototype.hasOwnProperty.call(payload.byModel, '__proto__'); }), false);
});

test('flush() sends only the known bucket fields, cleans aeVersion and the counters, and replaces a bad date', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: true }));
  writeFileSync(BUFFER_PATH, JSON.stringify({
    date: '=1+1',
    byModel: {
      'a::a': { turns: 3, inputTokens: 5, outputTokens: -4, cacheReadTokens: '7', cacheCreationTokens: 1e30, costUsd: 0.25, aeVersion: '26.0.1.12345678901', note: '=HYPERLINK("x")', path: '/Users/me/x' },
      'b::b': { turns: 1, aeVersion: '25.0' },
      'c::c': { turns: 1, aeVersion: '=1+1' },
      'd::d': { turns: 1, aeVersion: 'unknown' },
    },
  }));
  server.lastBody = null;

  var sent = await telemetry.flush();

  assert.equal(sent, true);
  var payload = JSON.parse(server.lastBody);
  assert.match(payload.date, /^\d{4}-\d{2}-\d{2}$/, 'a bad buffer date is replaced, not sent');
  var a = payload.byModel['a::a'];
  assert.deepEqual(Object.keys(a).sort(), ['aeVersion', 'cacheCreationTokens', 'cacheReadTokens', 'cliSource', 'cliVersion', 'costUsd', 'inputTokens', 'outputTokens', 'turns']);
  assert.equal(a.aeVersion, 'unknown', 'too long for the endpoint');
  assert.equal(a.outputTokens, 0, 'negative reads as 0');
  assert.equal(a.cacheReadTokens, 0, 'a string is not a count');
  assert.ok(a.cacheCreationTokens <= 1e10, 'clamped to the endpoint bound');
  assert.equal(a.turns, 3);
  assert.equal(payload.byModel['b::b'].aeVersion, '25.0');
  assert.equal(payload.byModel['c::c'].aeVersion, 'unknown');
  assert.equal(payload.byModel['d::d'].aeVersion, 'unknown');
  assert.ok(!/HYPERLINK|\/Users\//.test(server.lastBody), 'unknown fields are not sent');
});

test('flush() folds the models past the ten-model cap into one other bucket, so the day\'s totals stay right', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: true }));
  var big = {};
  var total = 0;
  for (var i = 0; i < 14; i++) { big['m' + i + '::m' + i] = { turns: i + 1, inputTokens: 10 * (i + 1) }; total += i + 1; }
  writeFileSync(BUFFER_PATH, JSON.stringify({ date: '2020-01-01', byModel: big }));
  server.lastBody = null;

  await telemetry.flush();

  var payload = JSON.parse(server.lastBody);
  var keys = Object.keys(payload.byModel);
  assert.equal(keys.length, 10);
  assert.ok(keys.indexOf('other::other') !== -1, 'an other bucket exists');
  var sumTurns = 0, sumInput = 0;
  keys.forEach(function (k) { sumTurns += payload.byModel[k].turns; sumInput += payload.byModel[k].inputTokens; });
  assert.equal(sumTurns, total, 'turns add up to the day');
  assert.equal(sumInput, total * 10, 'tokens add up to the day');
  assert.ok('m13::m13' in payload.byModel && !('m0::m0' in payload.byModel), 'the busiest stay, the least busy are folded');
  keys.forEach(function (k) { assert.match(k, /^[a-z0-9.\-]{1,40}(::[a-z0-9.\-]{1,40})?$/); });
});

test('sanitizeModelKey: lower case, safe characters only, 40 per half, merged when two keys collapse to one', () => {
  assert.equal(telemetry.sanitizeModelKey('claude-sonnet-5::claude-opus-4-8'), 'claude-sonnet-5::claude-opus-4-8');
  assert.equal(telemetry.sanitizeModelKey('Claude Opus 4.8'), 'claude-opus-4.8');
  assert.equal(telemetry.sanitizeModelKey('a'.repeat(60) + '::' + 'b'.repeat(60)), 'a'.repeat(40) + '::' + 'b'.repeat(40));
  assert.equal(telemetry.sanitizeModelKey('::'), 'unknown::unknown');
  assert.equal(telemetry.sanitizeModelKey(''), 'unknown');
  assert.equal(telemetry.sanitizeModelKey('x::y::z'), 'x::y-z');
  assert.equal(telemetry.sanitizeModelKey(null), null);
  assert.equal(telemetry.sanitizeModelKey(5), null);
  assert.equal(telemetry.sanitizeModelKey('-=x-'), 'x');
});

test('resolveTelemetryUrl: the endpoint override is honoured for a loopback address only', () => {
  var real = telemetry.DEFAULT_TELEMETRY_URL;
  assert.match(real, /^https:\/\/script\.google\.com\//);
  assert.equal(telemetry.resolveTelemetryUrl(undefined), real);
  assert.equal(telemetry.resolveTelemetryUrl(''), real);
  assert.equal(telemetry.resolveTelemetryUrl('http://127.0.0.1:9/'), 'http://127.0.0.1:9/');
  assert.equal(telemetry.resolveTelemetryUrl('http://localhost:8080/x'), 'http://localhost:8080/x');
  assert.equal(telemetry.resolveTelemetryUrl('http://[::1]:7/'), 'http://[::1]:7/');
  assert.equal(telemetry.resolveTelemetryUrl('https://127.0.0.1:7/'), 'https://127.0.0.1:7/');
  for (var bad of ['https://example.test/collect', 'http://evil.example/', 'http://127.0.0.1.evil.example/', 'http://localhost.evil.example/', 'ftp://127.0.0.1/', 'not a url', 'http://user@evil.example@127.0.0.1/']) {
    assert.equal(telemetry.resolveTelemetryUrl(bad), real, 'ignored: ' + bad);
  }
});

test('day rollover: a flush of yesterday does not delete the new day already written to the buffer', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: true }));
  writeFileSync(BUFFER_PATH, JSON.stringify({ date: '2020-01-01', byModel: { 'a::a': { turns: 1 } } }));
  server.lastBody = null;
  // Hold the HTTP response until the new day's turn has been recorded, the
  // way a real rollover interleaves: the flush is in flight while the turn
  // that triggered it writes today's bucket to the same file.
  var release;
  server.holdUntil = new Promise(function (r) { release = r; });

  var flushing = telemetry.flush();
  await new Promise(function (r) { setTimeout(r, 20); });
  telemetry.recordUsage({ model: 'haiku', inputTokens: 1 });
  var today = new Date().toISOString().slice(0, 10);
  assert.equal(JSON.parse(readFileSync(BUFFER_PATH, 'utf-8')).date, today, 'today is on disk while the flush is in flight');
  release();

  var sent = await flushing;
  assert.equal(sent, true);
  assert.equal(JSON.parse(server.lastBody).date, '2020-01-01', 'yesterday was what went out');
  assert.ok(existsSync(BUFFER_PATH), 'today\'s buffer survived the flush');
  var after = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
  assert.equal(after.date, today);
  assert.equal(after.byModel['haiku::haiku'].turns, 1);

  // And the plain case still clears: a flush of today's own buffer removes it.
  server.lastBody = null;
  assert.equal(await telemetry.flush(), true);
  assert.equal(existsSync(BUFFER_PATH), false);
});

test('flush() sends a day that only has errorKinds (a turn that died before any result event)', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID, shareUsageStats: true }));
  clearBuffer();
  telemetry.recordTurnKind('unknown_error', 'none');
  server.lastBody = null;

  var sent = await telemetry.flush();

  assert.equal(sent, true);
  var payload = JSON.parse(server.lastBody);
  assert.deepEqual(payload.byModel, {});
  assert.deepEqual(payload.errorKinds, { unknown_error: 1 });
});

test('getInstallId leaves a pre-existing installId untouched, generates one only if absent', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: 'dev-machine' }));
  assert.equal(telemetry.getInstallId(), 'dev-machine');

  writeFileSync(CONFIG_PATH, JSON.stringify({}));
  var generated = telemetry.getInstallId();
  assert.ok(generated && generated.length > 0);
  var config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  assert.equal(config.installId, generated, 'generated id persisted');
});

test('setEnabled / isEnabled round-trip through the config file', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ installId: TEST_INSTALL_ID }));
  telemetry.setEnabled(false);
  assert.equal(telemetry.isEnabled(), false);
  telemetry.setEnabled(true);
  assert.equal(telemetry.isEnabled(), true);
});

test.after(() => {
  server.close();
  try { if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH); } catch (e) {}
  clearBuffer();
});
