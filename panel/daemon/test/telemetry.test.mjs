import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

var __dirname = dirname(fileURLToPath(import.meta.url));
var PANEL_DIR = join(__dirname, '..', '..');
var CONFIG_PATH = join(PANEL_DIR, '.gaffer-config.json');
var BUFFER_PATH = join(PANEL_DIR, '.gaffer-usage-buffer.json');

// telemetry.js resolves its file paths (and reads GAFFER_TELEMETRY_URL) at
// import time, so point it at a throwaway local HTTP server before the
// first import, and snapshot/restore the real config + buffer files around
// every test — this module intentionally has no path-injection seam, it
// always talks to the real per-install files.
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

function snapshot(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}
function restore(path, content) {
  if (content === null) { try { if (existsSync(path)) unlinkSync(path); } catch (e) {} }
  else writeFileSync(path, content);
}

test('recordUsage buffers even when telemetry is disabled', async () => {
  var configBefore = snapshot(CONFIG_PATH);
  var bufferBefore = snapshot(BUFFER_PATH);
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ installId: 'test-install', shareUsageStats: false }));
    if (existsSync(BUFFER_PATH)) unlinkSync(BUFFER_PATH);

    telemetry.recordUsage({
      model: 'claude-sonnet-5', requestedModel: 'claude-opus-4-8',
      inputTokens: 100, outputTokens: 50, costUsd: 0.01,
    });

    var buffer = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
    assert.ok(buffer.byModel['claude-sonnet-5::claude-opus-4-8'], 'composite key present');
    assert.equal(buffer.byModel['claude-sonnet-5::claude-opus-4-8'].turns, 1);
    assert.equal(telemetry.isEnabled(), false);
  } finally {
    restore(CONFIG_PATH, configBefore);
    restore(BUFFER_PATH, bufferBefore);
  }
});

test('recordUsage falls back to model as requestedModel when absent (no downshift)', async () => {
  var configBefore = snapshot(CONFIG_PATH);
  var bufferBefore = snapshot(BUFFER_PATH);
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ installId: 'test-install', shareUsageStats: false }));
    if (existsSync(BUFFER_PATH)) unlinkSync(BUFFER_PATH);

    telemetry.recordUsage({ model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 5 });

    var buffer = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
    assert.ok(buffer.byModel['claude-sonnet-5::claude-sonnet-5']);
  } finally {
    restore(CONFIG_PATH, configBefore);
    restore(BUFFER_PATH, bufferBefore);
  }
});

test('flush() does not send while disabled, and keeps the buffer', async () => {
  var configBefore = snapshot(CONFIG_PATH);
  var bufferBefore = snapshot(BUFFER_PATH);
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ installId: 'test-install', shareUsageStats: false }));
    writeFileSync(BUFFER_PATH, JSON.stringify({ date: '2020-01-01', byModel: { 'a::a': { turns: 1 } } }));
    server.lastBody = null;

    var sent = await telemetry.flush();

    assert.equal(sent, false);
    assert.equal(server.lastBody, null, 'no HTTP request made while disabled');
    assert.ok(existsSync(BUFFER_PATH), 'buffer preserved for later send');
  } finally {
    restore(CONFIG_PATH, configBefore);
    restore(BUFFER_PATH, bufferBefore);
  }
});

test('flush() sends the composite-keyed payload and clears the buffer on success', async () => {
  var configBefore = snapshot(CONFIG_PATH);
  var bufferBefore = snapshot(BUFFER_PATH);
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ installId: 'test-install', shareUsageStats: true }));
    writeFileSync(BUFFER_PATH, JSON.stringify({
      date: '2020-01-01',
      byModel: { 'claude-sonnet-5::claude-opus-4-8': { turns: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.02 } },
    }));
    server.lastBody = null;

    var sent = await telemetry.flush();

    assert.equal(sent, true);
    var payload = JSON.parse(server.lastBody);
    assert.equal(payload.date, '2020-01-01');
    assert.equal(payload.installId, 'test-install');
    assert.ok(payload.sentAt, 'sentAt included');
    assert.ok(payload.byModel['claude-sonnet-5::claude-opus-4-8']);
    assert.equal(existsSync(BUFFER_PATH), false, 'buffer cleared after confirmed send');
  } finally {
    restore(CONFIG_PATH, configBefore);
    restore(BUFFER_PATH, bufferBefore);
  }
});

test('flush() is a no-op on an empty buffer', async () => {
  var configBefore = snapshot(CONFIG_PATH);
  var bufferBefore = snapshot(BUFFER_PATH);
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ installId: 'test-install', shareUsageStats: true }));
    if (existsSync(BUFFER_PATH)) unlinkSync(BUFFER_PATH);
    server.lastBody = null;

    var sent = await telemetry.flush();

    assert.equal(sent, false);
    assert.equal(server.lastBody, null);
  } finally {
    restore(CONFIG_PATH, configBefore);
    restore(BUFFER_PATH, bufferBefore);
  }
});

test('getInstallId leaves a pre-existing installId untouched, generates one only if absent', async () => {
  var configBefore = snapshot(CONFIG_PATH);
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ installId: 'dev-machine' }));
    assert.equal(telemetry.getInstallId(), 'dev-machine');

    writeFileSync(CONFIG_PATH, JSON.stringify({}));
    var generated = telemetry.getInstallId();
    assert.ok(generated && generated.length > 0);
    var config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    assert.equal(config.installId, generated, 'generated id persisted');
  } finally {
    restore(CONFIG_PATH, configBefore);
  }
});

test('setEnabled / isEnabled round-trip through the config file', async () => {
  var configBefore = snapshot(CONFIG_PATH);
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ installId: 'test-install' }));
    telemetry.setEnabled(false);
    assert.equal(telemetry.isEnabled(), false);
    telemetry.setEnabled(true);
    assert.equal(telemetry.isEnabled(), true);
  } finally {
    restore(CONFIG_PATH, configBefore);
  }
});

test.after(() => { server.close(); });
