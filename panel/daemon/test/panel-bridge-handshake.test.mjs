import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { PanelBridge, checkPanelHandshake } from '../panel-bridge.js';

// The bridge under test listens on an ephemeral loopback port, never on the
// real 9823, so these tests run next to a live daemon.
var bridge = new PanelBridge(0);
await bridge.start();
var port = bridge.port;
after(() => bridge.stop());

// Resolves { accepted: true } on open, or { accepted: false, status } when the
// server aborts the upgrade with an HTTP status.
function attempt(headers) {
  return new Promise((resolve) => {
    var ws = new WebSocket('ws://127.0.0.1:' + port, { headers: headers || {} });
    ws.on('open', () => { ws.close(); resolve({ accepted: true }); });
    ws.on('unexpected-response', (req, res) => {
      resolve({ accepted: false, status: res.statusCode });
      req.destroy();
    });
    ws.on('error', (e) => resolve({ accepted: false, error: e.message }));
  });
}

test('bridge binds 127.0.0.1 only', () => {
  var addr = bridge.wss.address();
  assert.equal(addr.address, '127.0.0.1');
  assert.equal(addr.port, port);
});

test('no Origin header (ws client default) is accepted', async () => {
  assert.deepEqual(await attempt(), { accepted: true });
});

test('file:// Origin (CEP panel) is accepted', async () => {
  assert.deepEqual(await attempt({ Origin: 'file:///x/index.html' }), { accepted: true });
});

test('Origin "null" is accepted', async () => {
  assert.deepEqual(await attempt({ Origin: 'null' }), { accepted: true });
});

test('a web page Origin is refused with HTTP 403', async () => {
  var r = await attempt({ Origin: 'https://evil.example' });
  assert.equal(r.accepted, false);
  assert.equal(r.status, 403);
  var r2 = await attempt({ Origin: 'http://localhost:8080' });
  assert.equal(r2.accepted, false);
  assert.equal(r2.status, 403);
});

test('a foreign Host header (DNS rebinding) is refused with HTTP 403', async () => {
  var r = await attempt({ Host: 'evil.example:' + port });
  assert.equal(r.accepted, false);
  assert.equal(r.status, 403);
});

test('localhost Host is accepted', async () => {
  assert.deepEqual(await attempt({ Host: 'localhost:' + port }), { accepted: true });
});

test('a refused handshake does not register a panel', async () => {
  await attempt({ Origin: 'https://evil.example' });
  assert.equal(bridge.listVersions().length, 0);
});

test('checkPanelHandshake: policy table', () => {
  var p = 9823;
  assert.equal(checkPanelHandshake({ host: '127.0.0.1:9823' }, p).ok, true);
  assert.equal(checkPanelHandshake({ host: 'LOCALHOST:9823' }, p).ok, true);
  assert.equal(checkPanelHandshake({ host: '[::1]:9823' }, p).ok, true);
  assert.equal(checkPanelHandshake({ host: '127.0.0.1:9823', origin: 'file:///a' }, p).ok, true);
  assert.equal(checkPanelHandshake({ host: '127.0.0.1:9823', origin: 'null' }, p).ok, true);
  assert.equal(checkPanelHandshake({ host: '127.0.0.1:9823', origin: 'HTTPS://x.y' }, p).ok, false);
  assert.equal(checkPanelHandshake({ host: '127.0.0.1:9824' }, p).ok, false, 'wrong port');
  assert.equal(checkPanelHandshake({ host: 'evil.example:9823' }, p).ok, false);
  assert.equal(checkPanelHandshake({}, p).ok, false, 'missing Host');
});
