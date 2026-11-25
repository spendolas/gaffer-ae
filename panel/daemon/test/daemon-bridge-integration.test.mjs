// A scratch daemon (index.js) on ephemeral ports with a scratch config
// directory: the token file is written once the bridge listens, rotates on every
// start, is not replaced by a second daemon that loses the port race, and a
// real panel handshake against the daemon works end to end. Never touches the
// real 9823/9824 or the real per-install config.
import './isolate-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { clientProof, serverProof } from '../bridge-token.js';
import { tmpDir } from './tmp.mjs';

var scratch = tmpDir('gaffer-daemon-it-');
var tokenFile = join(scratch, 'cfg', 'bridge-token');
var children = [];
after(() => {
  for (var c of children) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }
  rmSync(scratch, { recursive: true, force: true });
});

function freePort() {
  return new Promise((res) => {
    var s = createServer();
    s.listen(0, '127.0.0.1', () => { var p = s.address().port; s.close(() => res(p)); });
  });
}

var wsPort = await freePort();
var mcpPort = await freePort();
var daemonJs = fileURLToPath(new URL('../index.js', import.meta.url));

function startDaemon() {
  var env = Object.assign({}, process.env, {
    GAFFER_TEST: '1', GAFFER_WS_PORT: String(wsPort), GAFFER_MCP_PORT: String(mcpPort),
    GAFFER_CONFIG_PATH: join(scratch, 'cfg', 'config.json'),
    GAFFER_BUFFER_PATH: join(scratch, 'buffer.json'),
    GAFFER_MODEL_CACHE_PATH: join(scratch, 'model-cache.json'),
    GAFFER_TELEMETRY_URL: 'http://127.0.0.1:9/', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  });
  var child = spawn(process.execPath, [daemonJs], { env: env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.push(child);
  var out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  var exited = new Promise((res) => child.on('exit', (code) => res(code)));
  var ready = new Promise((res, rej) => {
    var t = setTimeout(() => rej(new Error('daemon did not publish its token in time:\n' + out)), 15000);
    var poll = setInterval(() => {
      if (/panel connection token written/.test(out)) { clearTimeout(t); clearInterval(poll); res(); }
    }, 50);
    exited.then((code) => { clearTimeout(t); clearInterval(poll); rej(new Error('daemon exited early (' + code + '):\n' + out)); });
  });
  ready.catch(() => {}); // a daemon that exits on purpose (port taken) is not an unhandled rejection
  return { child, exited, ready, output: () => out };
}

async function handshake(token) {
  var ws = new WebSocket('ws://127.0.0.1:' + wsPort);
  var msgs = [];
  var closed = new Promise((res) => ws.on('close', (c) => res(c)));
  ws.on('error', () => {});
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  await new Promise((res) => ws.on('open', res));
  var until = async (type) => { for (var i = 0; i < 100; i++) { var m = msgs.find((x) => x.type === type); if (m) return m; await new Promise((r) => setTimeout(r, 30)); } return null; };
  var ch = await until('auth_challenge');
  var cn = randomBytes(32).toString('hex');
  ws.send(JSON.stringify({ type: 'auth', nonce: cn, proof: clientProof(token, ch.nonce, cn) }));
  var ok = await Promise.race([until('auth_ok'), closed.then(() => null)]);
  return { ws, ok, ch, cn, msgs, closed, token };
}

var first;
test('the daemon publishes a 0600 token only once the bridge listens, and a panel handshake against it works', async () => {
  first = startDaemon();
  await first.ready;
  assert.ok(existsSync(tokenFile));
  var token = readFileSync(tokenFile, 'utf8');
  assert.match(token, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.ok(first.output().indexOf(token) === -1, 'the token is never logged');
  var h = await handshake(token);
  assert.ok(h.ok, 'auth_ok received');
  assert.equal(h.ok.proof, serverProof(token, h.cn, h.ch.nonce));
  h.ws.send(JSON.stringify({ type: 'register', aeVersion: '25.6' }));
  h.ws.send(JSON.stringify({ type: 'get_share_usage_stats' }));
  for (var i = 0; i < 100 && !h.msgs.some((m) => m.type === 'share_usage_stats'); i++) await new Promise((r) => setTimeout(r, 30));
  assert.ok(h.msgs.some((m) => m.type === 'share_usage_stats'), 'an authenticated panel gets answers');
  h.ws.close();
});

test('a second daemon that loses the port race exits without replacing the running daemon\'s token', async () => {
  var before = readFileSync(tokenFile, 'utf8');
  var second = startDaemon();
  var code = await second.exited;
  assert.equal(code, 0);
  assert.equal(readFileSync(tokenFile, 'utf8'), before);
  assert.match(second.output(), /already running/);
  // and the first daemon still authenticates that token
  var h = await handshake(before);
  assert.ok(h.ok);
  h.ws.close();
});

test('restart: the token rotates, the old one is refused, the new one works', async () => {
  var old = readFileSync(tokenFile, 'utf8');
  first.child.kill('SIGINT');
  await first.exited;
  var next = startDaemon();
  await next.ready;
  var fresh = readFileSync(tokenFile, 'utf8');
  assert.notEqual(fresh, old);
  var stale = await handshake(old);
  assert.equal(stale.ok, null);
  assert.equal(await stale.closed, 4401);
  var good = await handshake(fresh);
  assert.ok(good.ok);
  good.ws.close();
  next.child.kill('SIGINT');
  await next.exited;
});
