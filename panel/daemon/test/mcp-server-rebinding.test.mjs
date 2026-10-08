import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from '../mcp-server.js';

// A real MCP HTTP server on an ephemeral loopback port (never 9824), with a
// queue stub: these tests exercise the transport and header policy, not AE.
var queue = { enqueue: async () => '"stub"', isIdle: () => true };
var app = await startMcpServer(0, queue, {});
var port = app.httpServer.address().port;
var url = 'http://127.0.0.1:' + port + '/mcp';
after(() => new Promise((r) => app.httpServer.close(r)));

var INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

// Raw node:http, not fetch: undici drops a caller-supplied Host header, and the
// DNS-rebinding tests must actually send a foreign one.
function post(headers) {
  return new Promise((resolve, reject) => {
    var body = JSON.stringify(INIT);
    var req = http.request({
      host: '127.0.0.1', port: port, path: '/mcp', method: 'POST',
      headers: Object.assign({
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        accept: 'application/json, text/event-stream',
      }, headers || {}),
    }, (res) => {
      var chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a real MCP client (no Origin, loopback Host) completes initialize and lists tools', async () => {
  var client = new Client({ name: 'gaffer-test', version: '0' });
  var transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  var tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === 'runJSX'));
  await client.close();
});

test('localhost Host header is accepted', async () => {
  var res = await post({ host: 'localhost:' + port });
  assert.equal(res.status, 200);
  assert.ok(res.headers['mcp-session-id']);
});

test('a foreign Host header (DNS rebinding) is refused with 403', async () => {
  var res = await post({ host: 'evil.example:' + port });
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.text).error.message, /Invalid Host/);
});

test('a browser Origin is refused with 403', async () => {
  var res = await post({ origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.text).error.message, /Browser origins/);
});

test('GET without a session still gets the regular 400, not a rebinding error', async () => {
  var res = await fetch(url, { headers: { accept: 'text/event-stream' } });
  assert.equal(res.status, 400);
});
