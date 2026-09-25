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
