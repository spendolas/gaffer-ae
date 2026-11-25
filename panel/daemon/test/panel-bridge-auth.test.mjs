import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { PanelBridge } from '../panel-bridge.js';
import { newBridgeToken, clientProof, serverProof } from '../bridge-token.js';
import { IssuedSessions } from '../issued-sessions.js';
import { tmpDir } from './tmp.mjs';

// Every bridge here listens on an ephemeral loopback port with a throwaway
// token, never on 9823, so the suite runs next to a live daemon.

var bridges = [];
var sockets = [];
after(() => { for (var s of sockets) { try { s.terminate(); } catch (e) { /* ignore */ } } for (var b of bridges) b.stop(); });

async function startBridge(opts) {
  var o = Object.assign({ token: newBridgeToken(), authTimeoutMs: 400 }, opts || {});
  var b = new PanelBridge(o.port || 0, o);
  await b.start();
  bridges.push(b);
  b.testToken = o.token;
  return b;
}

// A scripted client: collects every JSON message and the close event.
function open(bridge, headers) {
  var ws = new WebSocket('ws://127.0.0.1:' + bridge.port, { headers: headers || {} });
  sockets.push(ws);
  var c = { ws: ws, inbox: [], waiters: [], closed: null, closeCode: null, rejected: null };
  // A hung socket fails the assertion ('timeout') instead of hanging the run.
  c.closedP = new Promise((res) => {
    var guard = setTimeout(() => res('timeout'), 4000);
    ws.on('close', (code) => { clearTimeout(guard); c.closed = true; c.closeCode = code; res(code); });
    ws.on('unexpected-response', (req, r) => { c.rejected = r.statusCode; c.closed = true; clearTimeout(guard); req.destroy(); res('http-' + r.statusCode); });
    ws.on('error', () => { /* surfaced via close/unexpected-response */ });
  });
  ws.on('message', (d) => {
    var m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
    c.inbox.push(m);
    c.waiters = c.waiters.filter((w) => { if (w.type === m.type) { w.res(m); return false; } return true; });
  });
  c.opened = new Promise((res) => { ws.on('open', res); ws.on('close', res); });
  c.next = (type, ms) => new Promise((res, rej) => {
    var hit = c.inbox.find((m) => m.type === type);
    if (hit) return res(hit);
    var t = setTimeout(() => rej(new Error('timeout waiting for ' + type)), ms || 1500);
    c.waiters.push({ type: type, res: (m) => { clearTimeout(t); res(m); } });
  });
  c.send = (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
  return c;
}

// Full handshake as the real panel does it. Returns { c, challenge, ok, cn }.
async function connectAuthed(bridge, token, headers) {
  var c = open(bridge, headers);
  await c.opened;
  var ch = await c.next('auth_challenge');
  var cn = randomBytes(32).toString('hex');
  c.send({ type: 'auth', nonce: cn, proof: clientProof(token || bridge.testToken, ch.nonce, cn) });
  var ok = await c.next('auth_ok');
  return { c: c, challenge: ch, ok: ok, cn: cn };
}

var tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));

test('the server challenges first: a fresh 64-hex nonce per connection, nothing else sent', async () => {
  var b = await startBridge();
  var a = open(b); var z = open(b);
  var ca = await a.next('auth_challenge'); var cz = await z.next('auth_challenge');
  assert.match(ca.nonce, /^[0-9a-f]{64}$/);
  assert.notEqual(ca.nonce, cz.nonce);
  assert.deepEqual(Object.keys(ca).sort(), ['nonce', 'type', 'v']);
  assert.equal(a.inbox.length, 1);
});

test('right proof: auth_ok carries a server proof the panel can verify; the token never crosses the wire', async () => {
  var b = await startBridge();
  var { c, challenge, ok, cn } = await connectAuthed(b);
  assert.equal(ok.proof, serverProof(b.testToken, cn, challenge.nonce));
  var wire = JSON.stringify(c.inbox) + JSON.stringify({ cn });
  assert.equal(wire.indexOf(b.testToken), -1);
});

test('wrong proof, wrong-length proof, non-hex proof, missing proof: closed 4401, bridge keeps serving', async () => {
  var b = await startBridge();
  var good = connectAuthed(b);
  var variants = [
    (ch, cn) => ({ type: 'auth', nonce: cn, proof: clientProof(newBridgeToken(), ch.nonce, cn) }),
    (ch, cn) => ({ type: 'auth', nonce: cn, proof: clientProof(b.testToken, ch.nonce, cn).slice(0, 60) }),
    (ch, cn) => ({ type: 'auth', nonce: cn, proof: clientProof(b.testToken, ch.nonce, cn) + '00' }),
    (ch, cn) => ({ type: 'auth', nonce: cn, proof: 'zz'.repeat(32) }),
    (ch, cn) => ({ type: 'auth', nonce: cn }),
    (ch, cn) => ({ type: 'auth', proof: clientProof(b.testToken, ch.nonce, cn) }),
    (ch, cn) => ({ type: 'auth', nonce: cn, proof: 7 }),
    (ch, cn) => ({ type: 'auth', nonce: 'short', proof: clientProof(b.testToken, ch.nonce, 'short') }),
    (ch, cn) => ({ type: 'auth', nonce: cn, proof: clientProof(b.testToken, cn, ch.nonce) }), // swapped order
    (ch, cn) => ({ type: 'auth', nonce: cn, proof: serverProof(b.testToken, cn, ch.nonce) }), // reflected label
  ];
  for (var i = 0; i < variants.length; i++) {
    var c = open(b);
    await c.opened;
    var ch = await c.next('auth_challenge');
    c.send(variants[i](ch, randomBytes(32).toString('hex')));
    assert.equal(await c.closedP, 4401, 'variant ' + i);
    assert.equal(c.inbox.some((m) => m.type === 'auth_ok'), false, 'variant ' + i);
  }
  await good;
  assert.equal(b.listVersions().length, 0);
  var again = await connectAuthed(b);
  assert.ok(again.ok);
});

test('a proof computed against someone else\'s nonce does not replay on another connection', async () => {
  var b = await startBridge();
  var one = open(b); await one.opened;
  var ch1 = await one.next('auth_challenge');
  var cn = randomBytes(32).toString('hex');
  var proof = clientProof(b.testToken, ch1.nonce, cn);
  var two = open(b); await two.opened;
  await two.next('auth_challenge');
  two.send({ type: 'auth', nonce: cn, proof: proof });
  assert.equal(await two.closedP, 4401);
});

test('Origin "null" without a proof gets nothing and cannot register, chat or list', async () => {
  var chats = []; var lists = 0;
  var b = await startBridge();
  b.onChat = (m) => chats.push(m);
  b.onListModels = () => { lists++; };
  var c = open(b, { Origin: 'null' });
  await c.opened;
  await c.next('auth_challenge');
  c.send({ type: 'register', aeVersion: '25.6' });
  c.send({ type: 'chat', message: 'run it' });
  c.send({ type: 'list_models' });
  assert.equal(await c.closedP, 4401);
  assert.equal(b.listVersions().length, 0);
  assert.equal(chats.length, 0);
  assert.equal(lists, 0);
  assert.deepEqual(c.inbox.map((m) => m.type), ['auth_challenge']);
});

test('no proof within the deadline: closed 4401', async () => {
  var b = await startBridge({ authTimeoutMs: 120 });
  var c = open(b);
  await c.opened;
  assert.equal(await c.closedP, 4401);
});

test('pre-auth frames are cut off at the ws layer: a large frame is refused (1009) before it is buffered', async () => {
  var b = await startBridge({ authTimeoutMs: 3000 });
  var c = open(b); await c.opened; await c.next('auth_challenge');
  var t0 = Date.now();
  c.send(Buffer.alloc(8 * 1024 * 1024, 1)); // binary, 8 MB
  assert.equal(await c.closedP, 1009);
  assert.ok(Date.now() - t0 < 2000);
  var d = open(b); await d.opened; await d.next('auth_challenge');
  d.send(JSON.stringify({ type: 'auth', nonce: 'a'.repeat(5000), proof: 'b' }));
  assert.ok([1009, 4401].includes(await d.closedP));
});

test('after auth the frame limit is raised to maxPayload (a result larger than the pre-auth limit goes through)', async () => {
  var b = await startBridge({ maxPayload: 2 * 1024 * 1024 });
  var a = await connectAuthed(b); a.c.send({ type: 'register', aeVersion: '25.6' }); await tick();
  var p = b.send('big', '25.6');
  var req = await new Promise((res) => a.c.ws.once('message', (d) => res(JSON.parse(d.toString()))));
  a.c.send({ id: req.id, result: 'r'.repeat(300000) });
  assert.equal((await p).length, 300000);
});

test('regression: an unauthenticated second client cannot take over an AE version', async () => {
  var b = await startBridge();
  var real = await connectAuthed(b);
  real.c.send({ type: 'register', aeVersion: '25.6' });
  await tick();
  assert.deepEqual(b.listVersions(), ['25.6']);
  var stranger = open(b, { Origin: 'null' });
  await stranger.opened; await stranger.next('auth_challenge');
  stranger.send({ type: 'register', aeVersion: '25.6', projectPath: '/other' });
  assert.equal(await stranger.closedP, 4401);
  await tick();
  assert.deepEqual(b.listVersions(), ['25.6']);
  assert.equal(real.c.closed, null, 'the real panel is still connected');
  // and the real panel still receives JSX
  var p = b.send('1+1', '25.6');
  var req = await new Promise((res) => real.c.ws.once('message', (d) => res(JSON.parse(d.toString()))));
  assert.equal(req.code, '1+1');
  real.c.send({ id: req.id, result: '2' });
  assert.equal(await p, '2');
});

test('a second AUTHENTICATED client for the same version replaces the first, and it is logged', async () => {
  var b = await startBridge();
  var logs = [];
  var orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    var first = await connectAuthed(b); first.c.send({ type: 'register', aeVersion: '25.6' }); await tick();
    var second = await connectAuthed(b); second.c.send({ type: 'register', aeVersion: '25.6' }); await tick(120);
  } finally { console.log = orig; }
  await first.c.closedP;
  assert.equal(first.c.closed, true);
  assert.equal(second.c.closed, null);
  assert.deepEqual(b.listVersions(), ['25.6']);
  assert.ok(logs.some((l) => /replacing .*panel for AE 25\.6/.test(l)), logs.join('\n'));
});

test('JSX responses are only accepted from the socket the request went to', async () => {
  var b = await startBridge();
  var a = await connectAuthed(b); a.c.send({ type: 'register', aeVersion: '25.6' });
  var z = await connectAuthed(b); z.c.send({ type: 'register', aeVersion: '24.2' });
  await tick();
  assert.deepEqual(b.listVersions().sort(), ['24.2', '25.6']);
  var p = b.send('x', '25.6');
  var req = await new Promise((res) => a.c.ws.once('message', (d) => res(JSON.parse(d.toString()))));
  // the other authenticated panel guesses the id and tries to answer
  z.c.send({ id: req.id, result: 'wrong-source' });
  await tick();
  assert.equal(b.pending.size, 1, 'still waiting for the right panel');
  a.c.send({ id: req.id, result: 'real' });
  assert.equal(await p, 'real');
});

test('two AE versions route independently', async () => {
  var b = await startBridge();
  var a = await connectAuthed(b); a.c.send({ type: 'register', aeVersion: '25.6' });
  var z = await connectAuthed(b); z.c.send({ type: 'register', aeVersion: '24.2' });
  await tick();
  var pa = b.send('A', '25.6'); var pz = b.send('Z', '24.2');
  var ra = await new Promise((res) => a.c.ws.once('message', (d) => res(JSON.parse(d.toString()))));
  var rz = await new Promise((res) => z.c.ws.once('message', (d) => res(JSON.parse(d.toString()))));
  assert.equal(ra.code, 'A'); assert.equal(rz.code, 'Z');
  a.c.send({ id: ra.id, result: 'ra' }); z.c.send({ id: rz.id, result: 'rz' });
  assert.equal(await pa, 'ra'); assert.equal(await pz, 'rz');
  await assert.rejects(() => b.send('?'), /Multiple AE instances/);
});

test('valid chat reaches onChat sanitized (unknown fields dropped); hooks get the authed socket', async () => {
  var got = [];
  var b = await startBridge();
  b.onChat = (m, s) => got.push({ m, s });
  var { c } = await connectAuthed(b);
  c.send({ type: 'register', aeVersion: '25.6' });
  c.send({ type: 'chat', message: 'hello', model: 'opus', effort: 'high', aeVersion: '25.6', enabledMcps: ['grip'], newConversation: true, sneaky: { a: 1 } });
  await tick();
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].m, { type: 'chat', message: 'hello', model: 'opus', effort: 'high', aeVersion: '25.6', enabledMcps: ['grip'], newConversation: true });
  assert.equal(got[0].s._gafferKey, '25.6');
});

test('an authenticated panel is never disconnected for a bad message: a bad chat gets a chat_error, other bad messages are dropped', async () => {
  var chats = []; var hooks = [];
  var b = await startBridge({ maxPayload: 4 * 1024 * 1024 });
  b.onChat = (m) => chats.push(m);
  b.onAuthMcp = () => hooks.push('auth_mcp');
  b.onListModels = () => hooks.push('list_models');
  var logs = []; var orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  var badChats = [
    { type: 'chat', message: 'x', model: '--dangerously-skip-permissions' },
    { type: 'chat', message: 'x', model: '-p' },
    { type: 'chat', message: 'x'.repeat(250000) },
    { type: 'chat', message: 'x', enabledMcps: Array(40).fill('a') },
    { type: 'chat', message: 'x', enabledMcps: ['a,Bash,b'] },
    { type: 'chat', message: 'x', enabledMcps: ['-a'] },
    { type: 'chat', message: 'x', enabledMcps: ['a'.repeat(300)] },
    { type: 'chat', message: 'x', aeVersion: '25.6"\n## Heading' },
    { type: 'chat', message: 'x', sessionId: '--resume' },
    { type: 'chat', message: { toString: 1 } },
  ];
  var other = [
    { type: 'nope' }, { type: 'auth_mcp', id: '--config' }, { type: 'list_models', junk: 'x'.repeat(2 * 1024 * 1024) },
    [1, 2, 3], 'plain text, not json', { type: 'sign_in', mode: 'bogus' },
  ];
  try {
    var { c } = await connectAuthed(b);
    for (var m of badChats) {
      c.inbox.length = 0;
      c.send(JSON.stringify(m));
      var err = await c.next('chat_error');
      assert.ok(typeof err.error === 'string' && err.error.length > 5);
      assert.ok(!/[\u2013\u2014]/.test(err.error));
    }
    for (var o of other) c.send(typeof o === 'string' ? o : JSON.stringify(o));
    c.send(Buffer.from([1, 2, 3])); // binary frame
    await tick(150);
  } finally { console.log = orig; }
  assert.equal(c.closed, null, 'the socket is still open');
  assert.equal(chats.length, 0);
  assert.deepEqual(hooks, []);
  assert.ok(logs.filter((l) => /rejected message/.test(l)).length >= badChats.length + other.length);
  assert.ok(logs.every((l) => l.indexOf('## Heading') === -1 && l.indexOf('Bash') === -1), 'log lines do not echo content');
  // and the same socket still chats normally afterwards
  c.send({ type: 'chat', message: 'fine', enabledMcps: ['claude.ai S&P Global'], effort: 'minimal' });
  await tick();
  assert.equal(chats.length, 1);
  assert.equal(chats[0].effort, undefined, 'an unknown effort is dropped, not an error');
  assert.deepEqual(chats[0].enabledMcps, ['claude.ai S&P Global']);
});

test('the four hidden Settings API-key message types are accepted and ignored', async () => {
  var hooks = [];
  var b = await startBridge();
  b.onChat = () => hooks.push('chat');
  var { c } = await connectAuthed(b);
  for (var t of ['api_connect', 'api_disconnect', 'api_add_key', 'api_forget']) c.send({ type: t, key: 'sk-test' });
  await tick(100);
  assert.equal(c.closed, null);
  assert.deepEqual(hooks, []);
  assert.equal(c.inbox.some((m) => m.type === 'chat_error'), false);
});

test('a chat naming a model outside the live list gets a chat_error, not a closed socket', async () => {
  var chats = [];
  var b = await startBridge();
  b.onChat = (m) => chats.push(m);
  b.isModelAllowed = (model) => model === 'opus';
  var { c } = await connectAuthed(b);
  c.send({ type: 'chat', message: 'x', model: 'claude-made-up-1' });
  var err = await c.next('chat_error');
  assert.match(err.error, /model/i);
  assert.equal(c.closed, null);
  c.send({ type: 'chat', message: 'x', model: 'opus' });
  await tick();
  assert.equal(chats.length, 1);
});

test('auth_mcp passes on a valid id and is dropped to the hook sanitized', async () => {
  var got = [];
  var b = await startBridge();
  b.onAuthMcp = (m) => got.push(m);
  var { c } = await connectAuthed(b);
  c.send({ type: 'auth_mcp', id: 'claude.ai Gmail', extra: 1 });
  await tick();
  assert.deepEqual(got, [{ type: 'auth_mcp', id: 'claude.ai Gmail' }]);
});

test('sessions: an id the panel makes up is dropped; one the daemon issued in chat_done is kept', async () => {
  var chats = [];
  var b = await startBridge();
  b.onChat = (m, s) => {
    chats.push(m);
    // what the chat handler does when a turn finishes
    s.send(JSON.stringify({ type: 'chat_done', sessionId: '3f2b8c1e-5d4a-4e6b-9a7c-0123456789ab' }));
  };
  var { c } = await connectAuthed(b);
  c.send({ type: 'chat', message: 'one', sessionId: '3f2b8c1e-5d4a-4e6b-9a7c-0123456789ab' });
  await tick();
  assert.equal(chats[0].sessionId, undefined, 'not yet issued by this daemon');
  await c.next('chat_done');
  c.send({ type: 'chat', message: 'two', sessionId: '3f2b8c1e-5d4a-4e6b-9a7c-0123456789ab' });
  await tick();
  assert.equal(chats[1].sessionId, '3f2b8c1e-5d4a-4e6b-9a7c-0123456789ab');
});

test('IssuedSessions: bounded, UUID-only, survives a restart through its file (0600)', async () => {
  var { rmSync, statSync } = await import('node:fs');
  var { tmpdir } = await import('node:os');
  var { join } = await import('node:path');
  var dir = tmpDir('gaffer-issued-');
  try {
    var f = join(dir, 'issued-sessions.json');
    var a = new IssuedSessions(f, 3);
    var ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
    ids.forEach((i) => a.add(i));
    a.add('not-a-uuid'); a.add(undefined); a.add(5);
    assert.equal(a.has(ids[0]), false, 'oldest evicted at the cap');
    assert.equal(a.has(ids[3]), true);
    assert.equal(a.has('not-a-uuid'), false);
    var b2 = new IssuedSessions(f, 3);
    assert.equal(b2.has(ids[3]), true, 'a restarted daemon still knows what it issued');
    assert.equal(b2.has(ids[0]), false);
    if (process.platform !== 'win32') assert.equal(statSync(f).mode & 0o777, 0o600);
    var broken = new IssuedSessions(join(dir, 'missing', 'nope.json'), 3);
    broken.add(ids[0]);
    assert.equal(broken.has(ids[0]), true, 'a failed write never throws');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new authenticated registration tells the daemon (so a held session is not inherited)', async () => {
  var seen = [];
  var b = await startBridge();
  b.onPanelRegistered = (key, socket, info) => seen.push({ key, replaced: info.replaced });
  var a = await connectAuthed(b); a.c.send({ type: 'register', aeVersion: '25.6' });
  await tick();
  var z = await connectAuthed(b); z.c.send({ type: 'register', aeVersion: '25.6' });
  await tick();
  assert.deepEqual(seen, [{ key: '25.6', replaced: false }, { key: '25.6', replaced: true }]);
});

test('connection caps: pre-auth sockets have their own cap, so held unauthenticated sockets cannot take every slot', async () => {
  var b = await startBridge({ maxConnections: 5, maxPreAuthConnections: 2, authTimeoutMs: 5000 });
  var held = [open(b), open(b)];
  await Promise.all(held.map((h) => h.opened));
  var extra = open(b);
  assert.equal(await extra.closedP, 'http-503', 'a third pre-auth socket is refused');
  // authenticated panels are not blocked by those two pre-auth sockets? they need a pre-auth slot only briefly:
  held[0].ws.terminate(); await held[0].closedP; await tick();
  var a1 = await connectAuthed(b); a1.c.send({ type: 'register', aeVersion: '25.6' });
  var a2 = await connectAuthed(b); a2.c.send({ type: 'register', aeVersion: '24.2' });
  var a3 = await connectAuthed(b); a3.c.send({ type: 'register', aeVersion: '23.0' });
  await tick();
  assert.equal(b.listVersions().length, 3);
  // total cap: 3 authenticated + 1 pre-auth held = 4 of 5; one more authenticated fits, then it is full
  var a4 = await connectAuthed(b);
  var full = open(b);
  assert.equal(await full.closedP, 'http-503', 'total cap reached');
});

test('maxPayload: a frame over the limit closes the connection (1009) and the bridge survives', async () => {
  var b = await startBridge({ maxPayload: 64 * 1024 });
  var { c } = await connectAuthed(b);
  c.send(JSON.stringify({ type: 'chat', message: 'x'.repeat(100 * 1024) }));
  assert.equal(await c.closedP, 1009);
  assert.ok((await connectAuthed(b)).ok);
});

test('typed messages over the typed cap are rejected even when under maxPayload; JSX results may be larger', async () => {
  var b = await startBridge({ maxPayload: 8 * 1024 * 1024, maxTypedBytes: 4096 });
  b.onListModels = () => {};
  var a = await connectAuthed(b); a.c.send({ type: 'register', aeVersion: '25.6' }); await tick();
  var p = b.send('big', '25.6');
  var req = await new Promise((res) => a.c.ws.once('message', (d) => res(JSON.parse(d.toString()))));
  a.c.send({ id: req.id, result: 'r'.repeat(100000) });
  assert.equal((await p).length, 100000);
  var hits = 0; b.onListModels = () => { hits++; };
  var z = await connectAuthed(b);
  z.c.send({ type: 'list_models', pad: 'x'.repeat(10000) });
  await tick(100);
  assert.equal(hits, 0, 'dropped');
  assert.equal(z.c.closed, null, 'and the socket stays open');
});

test('daemon restart then reconnect: the old token no longer works, the new one does, on the same port', async () => {
  var b1 = await startBridge();
  var port = b1.port; var t1 = b1.testToken;
  var a = await connectAuthed(b1); a.c.send({ type: 'register', aeVersion: '25.6' });
  await tick();
  b1.stop();
  await a.c.closedP; // stop() drops live clients
  var b2 = await startBridge({ port: port });
  assert.equal(b2.port, port);
  var stale = open(b2); await stale.opened;
  var ch = await stale.next('auth_challenge');
  var cn = randomBytes(32).toString('hex');
  stale.send({ type: 'auth', nonce: cn, proof: clientProof(t1, ch.nonce, cn) });
  assert.equal(await stale.closedP, 4401);
  var fresh = await connectAuthed(b2);
  fresh.c.send({ type: 'register', aeVersion: '25.6' });
  await tick();
  assert.deepEqual(b2.listVersions(), ['25.6']);
});

test('the bridge refuses to start without a token', async () => {
  var b = new PanelBridge(0, {});
  await assert.rejects(() => b.start(), /token/i);
  var b2 = new PanelBridge(0, { token: 'short' });
  await assert.rejects(() => b2.start(), /token/i);
});

test('legacy path: a panel that authenticates but never registers is keyed UNKNOWN on its first message', async () => {
  var b = await startBridge();
  b.onListModels = () => {};
  var { c } = await connectAuthed(b);
  c.send({ type: 'list_models' });
  await tick();
  assert.deepEqual(b.listVersions(), ['unknown']);
});

test('a non-panel client never gets keyed, replaces a key, or reaches any control hook', async () => {
  var hits = [];
  var b = await startBridge();
  for (var h of ['onChat', 'onChatCancel', 'onListMcps', 'onListModels', 'onAuthMcp', 'onAuthStatus', 'onSignIn', 'onSignOut', 'onCancelSignIn', 'onGetShareUsageStats', 'onSetShareUsageStats']) {
    b[h] = () => hits.push(h);
  }
  var real = await connectAuthed(b);
  real.c.send({ type: 'register', aeVersion: '25.6' });
  await tick();
  for (var round = 0; round < 3; round++) {
    var other = open(b, { Origin: 'null' });
    await other.opened; await other.next('auth_challenge');
    for (var m of [{ type: 'sign_out' }, { type: 'sign_in', mode: 'console' }, { type: 'auth_status' }, { type: 'list_mcps' },
      { type: 'auth_mcp', id: 'x' }, { type: 'chat_cancel' }, { type: 'set_share_usage_stats', enabled: false },
      { type: 'register', aeVersion: '25.6' }, { type: 'register', aeVersion: '24.2' }]) other.send(m);
    assert.equal(await other.closedP, 4401);
  }
  assert.deepEqual(hits, []);
  assert.deepEqual(b.listVersions(), ['25.6']);
  assert.equal(real.c.closed, null);
});

test('upgrade path: with no ledger file yet, the first session id each AE version presents is accepted once', async () => {
  var { rmSync } = await import('node:fs');
  var { tmpdir } = await import('node:os');
  var { join } = await import('node:path');
  var dir = tmpDir('gaffer-bootstrap-');
  try {
    var file = join(dir, 'issued-sessions.json');
    var chats = [];
    var b = await startBridge({ sessions: new IssuedSessions(file) });
    b.onChat = (m, s) => chats.push({ id: m.sessionId, key: s._gafferKey });
    var A = '11111111-1111-4111-8111-111111111111';
    var B = '22222222-2222-4222-8222-222222222222';
    var C = '33333333-3333-4333-8333-333333333333';
    var a = await connectAuthed(b); a.c.send({ type: 'register', aeVersion: '25.6' });
    var z = await connectAuthed(b); z.c.send({ type: 'register', aeVersion: '24.2' });
    await tick();
    a.c.send({ type: 'chat', message: '1', sessionId: A });
    a.c.send({ type: 'chat', message: '2', sessionId: B }); // a second, different, unissued id for the same key
    a.c.send({ type: 'chat', message: '3', sessionId: A }); // the accepted one still works
    z.c.send({ type: 'chat', message: '4', sessionId: C }); // another key bootstraps on its own
    await tick(120);
    assert.deepEqual(chats.map((c) => c.id), [A, undefined, A, C]);
    // a restarted daemon (the file now exists) no longer bootstraps
    var b2 = await startBridge({ sessions: new IssuedSessions(file) });
    var seen = [];
    b2.onChat = (m) => seen.push(m.sessionId);
    var r = await connectAuthed(b2); r.c.send({ type: 'register', aeVersion: '25.6' });
    await tick();
    r.c.send({ type: 'chat', message: 'x', sessionId: '44444444-4444-4444-8444-444444444444' });
    r.c.send({ type: 'chat', message: 'y', sessionId: A });
    await tick(100);
    assert.deepEqual(seen, [undefined, A]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('trackSessionIds records a session id the moment the chat handler takes it, not only at chat_done', async () => {
  var { trackSessionIds } = await import('../issued-sessions.js');
  var led = new IssuedSessions(null);
  var handler = { sessionId: null };
  trackSessionIds(handler, led);
  var id = '55555555-5555-4555-8555-555555555555';
  handler.sessionId = id;
  assert.equal(handler.sessionId, id);
  assert.equal(led.has(id), true);
  handler.sessionId = null;
  assert.equal(handler.sessionId, null);
  handler.sessionId = 'not-a-uuid';
  assert.equal(led.has('not-a-uuid'), false);
});

test('the Origin of an authenticated panel connection is logged once per distinct value', async () => {
  var b = await startBridge();
  var logs = []; var orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    await connectAuthed(b, null, { Origin: 'null' });
    await connectAuthed(b, null, { Origin: 'null' });
    await connectAuthed(b, null, { Origin: 'file:///x/index.html' });
    await connectAuthed(b);
  } finally { console.log = orig; }
  var lines = logs.filter((l) => /panel origin/.test(l));
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.ok(lines.some((l) => /: null$/.test(l)));
  assert.ok(lines.some((l) => /\(none\)/.test(l)));
});

test('half-open HTTP upgrades are dropped by the header timeout', async () => {
  var net = await import('node:net');
  var b = await startBridge({ headersTimeoutMs: 300 });
  var sock = net.connect(b.port, '127.0.0.1');
  sock.on('error', () => {});
  sock.resume(); // read the server's 408 and the close
  sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:' + b.port + '\r\nUpgrade: websocket\r\n'); // never finishes the headers
  var closed = await new Promise((res) => { sock.on('close', () => res(true)); setTimeout(() => res(false), 4000); });
  assert.equal(closed, true);
});

test('plain HTTP requests to the bridge port get 426, not a hang', async () => {
  var http = await import('node:http');
  var b = await startBridge();
  var status = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: b.port, path: '/' }, (r) => { r.resume(); res(r.statusCode); }).on('error', rej));
  assert.equal(status, 426);
});
