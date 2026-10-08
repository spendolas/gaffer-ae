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
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
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
  assert.equal(telemetry.sanitizeCliVersion('v2.1.293'), 'unknown');
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
