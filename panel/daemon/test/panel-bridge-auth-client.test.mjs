// panel/bridge-auth.js is a plain browser script (ES5, assigns
// window.GafferBridgeAuth). Load it into a node:vm context the way the panel's
// <script> tag would. It holds everything the panel decides about the daemon
// connection: the HMAC, the token path, and the gate that drops every message
// until the daemon has proved it knows the token.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';
import { WebSocket } from 'ws';
import { PanelBridge } from '../panel-bridge.js';
import { newBridgeToken, clientProof, serverProof } from '../bridge-token.js';
import { defaultConfigDir } from '../config-path.js';

const source = readFileSync(fileURLToPath(new URL('../../bridge-auth.js', import.meta.url)), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: 'bridge-auth.js' });
const A = sandbox.window.GafferBridgeAuth;
const rnd = () => randomBytes(32).toString('hex');
const plain = (o) => JSON.parse(JSON.stringify(o)); // objects made inside the vm context are not same-realm

test('the panel HMAC-SHA256 matches node:crypto (short, 64-byte, long and unicode keys; empty and long messages)', () => {
  const keys = ['', 'k', 'ab'.repeat(32), 'k'.repeat(64), 'k'.repeat(65), 'long'.repeat(100), 'ключ-漢字'];
  const msgs = ['', 'a', 'abc'.repeat(100), 'gaffer-bridge-v1 client ' + 'ab'.repeat(32) + ' ' + 'cd'.repeat(32), 'z'.repeat(55), 'z'.repeat(56), 'z'.repeat(64), 'знак'];
  for (const k of keys) for (const m of msgs) {
    assert.equal(A.hmacSha256Hex(k, m), createHmac('sha256', k).update(m).digest('hex'), JSON.stringify([k.length, m.length]));
  }
});

test('the panel proofs equal the daemon proofs', () => {
  const t = newBridgeToken(); const sn = rnd(); const cn = rnd();
  assert.equal(A.clientProof(t, sn, cn), clientProof(t, sn, cn));
  assert.equal(A.serverProof(t, cn, sn), serverProof(t, cn, sn));
});

test('token path = <USER_DATA>/Gaffer/bridge-token, the same directory the daemon uses', () => {
  assert.equal(A.tokenPath('/Users/x/Library/Application Support'), '/Users/x/Library/Application Support/Gaffer/bridge-token');
  assert.equal(A.tokenPath('C:/Users/x/AppData/Roaming/'), 'C:/Users/x/AppData/Roaming/Gaffer/bridge-token');
  // Drift guard against config-path.js defaultConfigDir (mac + Windows layouts).
  const mac = defaultConfigDir('darwin', {}, '/Users/x');
  assert.equal(A.tokenPath('/Users/x/Library/Application Support'), join(mac, 'bridge-token').replace(/\\/g, '/'));
  const win = defaultConfigDir('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\Users\\x').replace(/\\/g, '/');
  assert.equal(A.tokenPath('C:/Users/x/AppData/Roaming'), win + '/bridge-token');
});

test('isValidToken: exactly 64 hex chars after trimming a newline', () => {
  assert.equal(A.isValidToken('ab'.repeat(32)), true);
  assert.equal(A.parseToken('ab'.repeat(32) + '\n'), 'ab'.repeat(32));
  assert.equal(A.parseToken('short'), null);
  assert.equal(A.parseToken(null), null);
  assert.equal(A.parseToken('zz'.repeat(32)), null);
});

function newHandshake(token) { return A.createHandshake({ token: token, randomHex: rnd }); }

test('handshake: challenge -> auth message -> verified auth_ok -> trusted; later messages are delivered', () => {
  const t = newBridgeToken();
  const h = newHandshake(t);
  assert.equal(h.state(), 'await-challenge');
  const sn = rnd();
  const r1 = h.handle(JSON.stringify({ type: 'auth_challenge', nonce: sn, v: 1 }));
  assert.equal(r1.deliver, null);
  const sent = JSON.parse(r1.send);
  assert.equal(sent.type, 'auth');
  assert.equal(sent.proof, clientProof(t, sn, sent.nonce));
  assert.equal(h.state(), 'await-server-proof');
  const r2 = h.handle(JSON.stringify({ type: 'auth_ok', proof: serverProof(t, sent.nonce, sn) }));
  assert.equal(r2.trusted, true);
  assert.equal(h.state(), 'trusted');
  const raw = JSON.stringify({ type: 'chat_chunk', text: 'hi' });
  assert.equal(h.handle(raw).deliver, raw);
});

test('a server that cannot prove itself never gets anything delivered or evaluated', () => {
  const t = newBridgeToken();
  const stranger = JSON.stringify({ id: 'x', code: '$.sleep(1)' });
  const chunk = JSON.stringify({ type: 'chat_chunk', text: 'x' });
  const noise = [stranger, chunk, JSON.stringify({ type: 'mcps', servers: [] }), JSON.stringify({ type: 'mcp_icons', icons: {} }),
    JSON.stringify({ type: 'auth_status', loggedIn: true }), JSON.stringify({ type: 'models', models: [] }),
    JSON.stringify({ type: 'share_usage_stats', enabled: true }), JSON.stringify({ type: 'daemon_reloading' }),
    JSON.stringify({ type: 'chat_event', event: 'x' }), 'not json', '{"id":1', ''];

  // 1. a listener that skips the challenge entirely
  let h = newHandshake(t);
  for (const m of noise) { const r = h.handle(m); assert.equal(r.deliver, null); assert.equal(r.send || null, null); }
  assert.notEqual(h.state(), 'trusted');

  // 2. a listener that challenges, answers with a wrong proof, then floods
  h = newHandshake(t);
  const sn = rnd();
  const sent = JSON.parse(h.handle(JSON.stringify({ type: 'auth_challenge', nonce: sn })).send);
  const bad = h.handle(JSON.stringify({ type: 'auth_ok', proof: serverProof(newBridgeToken(), sent.nonce, sn) }));
  assert.equal(bad.trusted, false);
  assert.equal(bad.failed, 'bad-server-proof');
  assert.equal(h.state(), 'failed');
  for (const m of noise) assert.equal(h.handle(m).deliver, null);

  // 3. a listener that reflects our own proof back
  h = newHandshake(t);
  const sn3 = rnd();
  const sent3 = JSON.parse(h.handle(JSON.stringify({ type: 'auth_challenge', nonce: sn3 })).send);
  assert.equal(h.handle(JSON.stringify({ type: 'auth_ok', proof: sent3.proof })).failed, 'bad-server-proof');

  // 4. auth_ok without a proof / with a malformed one / before any challenge
  h = newHandshake(t);
  assert.equal(h.handle(JSON.stringify({ type: 'auth_ok', proof: 'a'.repeat(64) })).deliver, null);
  assert.notEqual(h.state(), 'trusted');
  h = newHandshake(t);
  h.handle(JSON.stringify({ type: 'auth_challenge', nonce: rnd() }));
  assert.equal(h.handle(JSON.stringify({ type: 'auth_ok' })).failed, 'bad-server-proof');
});

test('a malformed challenge fails the handshake', () => {
  for (const bad of [{ type: 'auth_challenge' }, { type: 'auth_challenge', nonce: 'short' }, { type: 'auth_challenge', nonce: 7 }]) {
    const h = newHandshake(newBridgeToken());
    const r = h.handle(JSON.stringify(bad));
    assert.equal(r.send || null, null);
    assert.equal(r.failed, 'bad-challenge');
  }
});

test('after trusted, handshake message types are not delivered and a second challenge cannot reset trust', () => {
  const t = newBridgeToken();
  const h = newHandshake(t);
  const sn = rnd();
  const sent = JSON.parse(h.handle(JSON.stringify({ type: 'auth_challenge', nonce: sn })).send);
  h.handle(JSON.stringify({ type: 'auth_ok', proof: serverProof(t, sent.nonce, sn) }));
  assert.equal(h.handle(JSON.stringify({ type: 'auth_challenge', nonce: rnd() })).deliver, null);
  assert.equal(h.state(), 'trusted');
});

test('a handshake without a token can never reach trusted', () => {
  const h = A.createHandshake({ token: null, randomHex: rnd });
  const r = h.handle(JSON.stringify({ type: 'auth_challenge', nonce: rnd() }));
  assert.equal(r.failed, 'no-token');
  assert.equal(h.state(), 'failed');
});

test('what the panel does with auth failures: re-read once, then stop and show repair', () => {
  const p = A.createRetryPolicy();
  assert.deepEqual(plain(p.onAuthFailure()), { reread: true, giveUp: false });
  assert.deepEqual(plain(p.onAuthFailure()), { reread: false, giveUp: true });
  p.onTrusted();
  assert.deepEqual(plain(p.onAuthFailure()), { reread: true, giveUp: false }, 'a success resets the count');
});

test('tokenFileTrusted: owned by the current user and not group or world accessible (skipped on Windows)', () => {
  const ok = { uid: 501, mode: 0o100600 };
  assert.equal(A.tokenFileTrusted(ok, 501, 'darwin'), true);
  assert.equal(A.tokenFileTrusted({ uid: 502, mode: 0o100600 }, 501, 'darwin'), false, 'another user owns it');
  assert.equal(A.tokenFileTrusted({ uid: 501, mode: 0o100644 }, 501, 'darwin'), false, 'world readable');
  assert.equal(A.tokenFileTrusted({ uid: 501, mode: 0o100660 }, 501, 'darwin'), false, 'group accessible');
  assert.equal(A.tokenFileTrusted({ uid: 0, mode: 0o100666 }, undefined, 'win32'), true, 'Windows relies on the per-user folder');
  assert.equal(A.tokenFileTrusted(null, 501, 'darwin'), false);
  assert.equal(A.tokenFileTrusted(ok, undefined, 'darwin'), false, 'no uid on a unix platform: do not trust');
});

test('giveUpCode: no challenge ever arrived means an older daemon, otherwise a reload is the first step', () => {
  const never = newHandshake(newBridgeToken());
  assert.equal(A.giveUpCode(never.state()), 'bridge-old-daemon');
  const t = newBridgeToken(); const h = newHandshake(t);
  h.handle(JSON.stringify({ type: 'auth_challenge', nonce: rnd() }));
  assert.equal(A.giveUpCode(h.state()), 'bridge-auth');
  assert.equal(A.giveUpCode('failed'), 'bridge-auth');
  assert.ok(A.SLOW_RETRY_MS >= 10000 && A.SLOW_RETRY_MS <= 60000);
});

// ── Panel logic against the real daemon bridge ──

const bridges = []; const sockets = [];
after(() => { for (const s of sockets) { try { s.terminate(); } catch (e) { /* ignore */ } } for (const b of bridges) b.stop(); });

// Runs the panel-side gate against a real WebSocket server. `evaluated` records
// every {id, code} the gate would hand to evalScript.
async function panelConnect(port, token) {
  const h = A.createHandshake({ token: token, randomHex: rnd });
  const evaluated = []; const delivered = [];
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  sockets.push(ws);
  const state = { trusted: false, failed: null, closeCode: null };
  ws.on('message', (d) => {
    const r = h.handle(d.toString());
    if (r.send) ws.send(r.send);
    if (r.failed) { state.failed = r.failed; ws.close(); }
    if (r.trusted) { state.trusted = true; ws.send(JSON.stringify({ type: 'register', aeVersion: '25.6' })); }
    if (r.deliver) {
      delivered.push(r.deliver);
      const m = JSON.parse(r.deliver);
      if (m.id && m.code) evaluated.push(m);
    }
  });
  await new Promise((res) => { ws.on('close', (c) => { state.closeCode = c; res(); }); ws.on('open', () => setTimeout(res, 250)); });
  await new Promise((r) => setTimeout(r, 100));
  return { ws, evaluated, delivered, state };
}

test('panel gate + real bridge: right token reaches trusted and JSX is evaluated', async () => {
  const token = newBridgeToken();
  const b = new PanelBridge(0, { token }); await b.start(); bridges.push(b);
  const p = await panelConnect(b.port, token);
  assert.equal(p.state.trusted, true);
  assert.deepEqual(b.listVersions(), ['25.6']);
  b.send('app.version', '25.6').catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(p.evaluated.length, 1);
  assert.equal(p.evaluated[0].code, 'app.version');
});

test('panel gate + real bridge: wrong token on the panel side never trusts and the daemon never sends it JSX', async () => {
  const b = new PanelBridge(0, { token: newBridgeToken() }); await b.start(); bridges.push(b);
  const p = await panelConnect(b.port, newBridgeToken());
  assert.equal(p.state.trusted, false);
  assert.deepEqual(b.listVersions(), []);
  assert.equal(p.evaluated.length, 0);
});

test('panel gate + fake server on the port: nothing is evaluated even if it floods JSX requests', async () => {
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.on('listening', r));
  wss.on('connection', (s) => {
    s.send(JSON.stringify({ type: 'auth_challenge', nonce: rnd(), v: 1 }));
    s.send(JSON.stringify({ id: '1', code: '$.sleep(1)' }));
    s.on('message', () => {
      // never knows the token: answers with a made-up proof, then keeps pushing code
      s.send(JSON.stringify({ type: 'auth_ok', proof: rnd() }));
      s.send(JSON.stringify({ id: '2', code: '$.sleep(1)' }));
      s.send(JSON.stringify({ type: 'chat_chunk', text: '<img src=x onerror=alert(1)>' }));
    });
  });
  try {
    const p = await panelConnect(wss.address().port, newBridgeToken());
    assert.equal(p.state.trusted, false);
    assert.equal(p.state.failed, 'bad-server-proof');
    assert.equal(p.evaluated.length, 0);
    assert.equal(p.delivered.length, 0);
  } finally { wss.close(); }
});

// ── Wiring in the panel files ──

const panelFile = (name) => readFileSync(fileURLToPath(new URL('../../' + name, import.meta.url)), 'utf8');

test('index.html loads bridge-auth.js before main.js', () => {
  const html = panelFile('index.html');
  const tag = html.indexOf('<script src="bridge-auth.js"></script>');
  assert.ok(tag !== -1, 'no <script src="bridge-auth.js"> tag');
  assert.ok(tag < html.indexOf('<script src="main.js"></script>'), 'bridge-auth.js must load before main.js');
});

test('main.js: after giving up the panel keeps a slow retry and clears the notice on success', () => {
  const main = panelFile('main.js');
  assert.ok(/setTimeout\(function \(\) \{[^}]*connect\(\);[^}]*\}, BridgeAuth\.SLOW_RETRY_MS\)/.test(main), 'slow retry timer');
  assert.ok(/showLaunchError\(BridgeAuth\.giveUpCode\(/.test(main));
  assert.ok(/function onBridgeTrusted[\s\S]{0,900}clearBridgeNotice\(\)/.test(main));
  assert.ok(!/bridgeAuthGaveUp\s*=\s*true/.test(main), 'no permanent give-up flag');
});

test('main.js: the token read refuses a file that is not ours (fstat on the opened file)', () => {
  const main = panelFile('main.js');
  assert.ok(/fstatSync\(/.test(main) && /tokenFileTrusted\(/.test(main));
});

test('main.js: the socket reaches `ws` only through the gate, and messages only through it', () => {
  const main = panelFile('main.js');
  assert.ok(!/\bws\s*=\s*new WebSocket/.test(main), '`ws` must not be assigned an unauthenticated socket');
  assert.ok(/function onBridgeTrusted\(sock\)\s*\{\s*ws = sock;/.test(main));
  // handleMessage is defined once and called once: from the gate's onmessage
  assert.equal((main.match(/\bhandleMessage\(/g) || []).length, 2);
  assert.ok(/sock\.onmessage[\s\S]{0,400}hs\.handle\(evt\.data\)/.test(main));
  assert.ok(!/\.onmessage\s*=\s*handleMessage/.test(main));
  // a second consecutive authentication failure stops the retry loop and offers Repair
});

test('the bridge-auth launch notice offers Repair, uses no dashes, and Settings treats it as repairable', () => {
  const launch = { window: {} };
  vm.runInNewContext(panelFile('daemon-launch.js'), launch, { filename: 'daemon-launch.js' });
  const notice = launch.window.GafferLaunch.launchNotice('bridge-auth');
  assert.match(notice, /^Reload the Gaffer panel\./);
  assert.match(notice, /Repair/);
  assert.ok(!/[–—]/.test(notice));
  assert.notEqual(notice, launch.window.GafferLaunch.launchNotice('launch-failed'));
  const upd = { window: {} };
  vm.runInNewContext(panelFile('update-state.js'), upd, { filename: 'update-state.js' });
  assert.equal(upd.window.GafferUpdateState.isRepairableLaunchError('bridge-auth'), true);
  const old = launch.window.GafferLaunch.launchNotice('bridge-old-daemon');
  assert.match(old, /older Gaffer/i);
  assert.match(old, /Repair/);
  assert.ok(!/[\u2013\u2014]/.test(old));
  assert.equal(upd.window.GafferUpdateState.isRepairableLaunchError('bridge-old-daemon'), true);
});
