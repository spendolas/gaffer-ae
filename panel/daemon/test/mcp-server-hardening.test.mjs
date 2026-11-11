import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMcpServer, mcpErrorHandler } from '../mcp-server.js';

// Real MCP HTTP servers on ephemeral loopback ports (never 9824) with a queue
// stub: these tests cover error responses and session bookkeeping, not AE.
var queue = { enqueue: async () => '"stub"', isIdle: () => true };
var apps = [];
after(() => Promise.all(apps.map((a) => new Promise((r) => a.httpServer.close(r)))));
async function start(ctx) {
  var app = await startMcpServer(0, queue, ctx || {});
  apps.push(app);
  app.port = app.httpServer.address().port;
  return app;
}

var INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

function post(app, body, headers) {
  return new Promise((resolve, reject) => {
    var raw = typeof body === 'string' ? body : JSON.stringify(body);
    var req = http.request({
      host: '127.0.0.1', port: app.port, path: '/mcp', method: 'POST',
      headers: Object.assign({
        'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
        accept: 'application/json, text/event-stream',
      }, headers || {}),
    }, (res) => {
      var chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}
var init = async (app) => (await post(app, INIT)).headers['mcp-session-id'];
var listTools = (app, sid) => post(app, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' });
var wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a malformed body gets a JSON-RPC error with no stack, paths or module names', async () => {
  var app = await start();
  var r = await post(app, '{"jsonrpc": ');
  assert.equal(r.status, 400);
  var j = JSON.parse(r.text);
  assert.equal(j.jsonrpc, '2.0');
  assert.equal(j.id, null);
  assert.equal(typeof j.error.code, 'number');
  assert.equal(typeof j.error.message, 'string');
  assert.ok(!/node_modules|\/Users\/|\/private\/|\bat \w|\.js:\d+|stack/i.test(r.text), r.text);
});

test('mcpErrorHandler: 4xx keeps its status, anything else is a generic 500, never the message or stack', () => {
  function run(err, sent) {
    var out = {};
    var res = {
      headersSent: !!sent,
      status(c) { out.status = c; return this; },
      json(b) { out.body = b; return this; },
    };
    var nexted = null;
    var logs = []; var orig = console.error; console.error = (...a) => logs.push(a.join(' '));
    try { mcpErrorHandler(err, {}, res, (e) => { nexted = e; }); } finally { console.error = orig; }
    if (!sent && err.status === undefined) { assert.ok(logs.join('\n').includes('/Users/someone/x.js'), 'the daemon log keeps the stack'); }
    return { out, nexted, logs };
  }
  var secret = new Error('boom at /Users/someone/Library/Extensions/daemon/x.js:12'); secret.stack = 'Error: boom\n    at /Users/someone/x.js:1:1';
  var a = run(secret);
  assert.equal(a.out.status, 500);
  assert.deepEqual(a.out.body, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  assert.ok(!JSON.stringify(a.out.body).includes('someone'));
  var tooBig = Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' });
  assert.equal(run(tooBig).out.status, 413);
  var parse = Object.assign(new SyntaxError('Unexpected token'), { status: 400, type: 'entity.parse.failed' });
  var p = run(parse);
  assert.equal(p.out.status, 400);
  assert.equal(p.out.body.error.code, -32700);
  var late = run(secret, true);
  assert.equal(late.out.status, undefined);
  assert.equal(late.nexted, secret, 'after headers are sent Express must close the connection itself');
});

test('session cap: past maxSessions the least recently used session is dropped, the newest works', async () => {
  var app = await start({ maxSessions: 3, sessionEvictMinIdleMs: 0 });
  var ids = [];
  for (var i = 0; i < 5; i++) ids.push(await init(app));
  assert.ok(app.mcpSessionCount() <= 3, 'count ' + app.mcpSessionCount());
  assert.equal((await listTools(app, ids[4])).status, 200);
  assert.notEqual((await listTools(app, ids[0])).status, 200, 'oldest was evicted');
});

test('a session that is used stays; the idle one is evicted first', async () => {
  var app = await start({ maxSessions: 2, sessionEvictMinIdleMs: 0 });
  var a = await init(app); var b = await init(app);
  await wait(15);
  assert.equal((await listTools(app, a)).status, 200); // a is now the most recently used
  var c = await init(app);
  assert.equal(app.mcpSessionCount(), 2);
  assert.equal((await listTools(app, a)).status, 200);
  assert.notEqual((await listTools(app, b)).status, 200);
  assert.equal((await listTools(app, c)).status, 200);
});

test('idle expiry: a session nobody has used for sessionIdleMs is closed', async () => {
  var app = await start({ sessionIdleMs: 150, sessionSweepMs: 40 });
  var a = await init(app);
  assert.equal(app.mcpSessionCount(), 1);
  await wait(450);
  assert.equal(app.mcpSessionCount(), 0);
  assert.notEqual((await listTools(app, a)).status, 200);
});

test('activity keeps a session past the idle limit', async () => {
  var app = await start({ sessionIdleMs: 250, sessionSweepMs: 40 });
  var a = await init(app);
  for (var i = 0; i < 6; i++) { await wait(80); assert.equal((await listTools(app, a)).status, 200); }
  assert.equal(app.mcpSessionCount(), 1);
});

function openStream(app, sid) {
  // A GET /mcp event stream, the way an MCP client holds one open for its session.
  return new Promise((resolve, reject) => {
    var req = http.request({ host: '127.0.0.1', port: app.port, path: '/mcp', method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' } }, (res) => {
      resolve({ status: res.statusCode, close: () => { req.destroy(); res.destroy(); } });
    });
    req.on('error', () => {});
    req.end();
  });
}

test('a session with an open stream is never evicted by the cap or expired as idle', async () => {
  var app = await start({ maxSessions: 2, sessionEvictMinIdleMs: 0, sessionIdleMs: 150, sessionSweepMs: 40 });
  var live = await init(app);
  var stream = await openStream(app, live);
  assert.equal(stream.status, 200);
  var others = [];
  for (var i = 0; i < 4; i++) others.push(await init(app));
  await wait(450);
  assert.equal((await listTools(app, live)).status, 200, 'the session with a stream survives the cap and the idle sweep');
  stream.close();
});

test('eviction prefers sessions idle for a while: a just-used session is not dropped to make room', async () => {
  var app = await start({ maxSessions: 2, sessionEvictMinIdleMs: 60000 });
  var a = await init(app); var b = await init(app); var c = await init(app);
  // all three are younger than the minimum idle time, so nothing is evicted yet
  assert.equal(app.mcpSessionCount(), 3);
  assert.equal((await listTools(app, a)).status, 200);
});

test('defaults: a generous cap and a long idle expiry', async () => {
  var d = (await import('../mcp-server.js')).MCP_SESSION_DEFAULTS;
  assert.ok(d.maxSessions >= 256);
  assert.ok(d.sessionIdleMs >= 6 * 60 * 60 * 1000);
  assert.ok(d.sessionEvictMinIdleMs >= 60 * 1000);
});
