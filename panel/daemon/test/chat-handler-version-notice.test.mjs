import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';

// The one-per-daemon-life "Claude Code is outside the tested range" notice,
// driven through a real ChatHandler with a fake child: sent once as a
// chat_event, only when the init event's version is out of range, never for
// an unknown version, and never in place of the turn's own outcome.

var runTag = process.pid + '-' + Date.now();
process.env.GAFFER_CONFIG_PATH = join(tmpdir(), 'gaffer-vn-config-' + runTag + '.json');
process.env.GAFFER_BUFFER_PATH = join(tmpdir(), 'gaffer-vn-buffer-' + runTag + '.json');

var { ChatHandler, resetCliVersionNoticeForTests } = await import('../chat-handler.js');

function fakeChild() {
  var child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = function () {};
  return child;
}

function fakeSocket() {
  var sock = { readyState: 1, sent: [], _gafferKey: 'test' };
  sock.send = function (m) { sock.sent.push(JSON.parse(m)); };
  sock.notices = function () {
    return sock.sent.filter(function (m) { return m.type === 'chat_event' && m.event === 'cli_version'; });
  };
  return sock;
}

function harness() {
  var spawns = [];
  var handler = new ChatHandler({
    cacheFilePath: '/nonexistent/gaffer-test-model-cache.json',
    findClaudeBinary: async function () { return '/fake/claude'; },
    lastClaudeLookup: function () { return null; },
    spawn: function (bin, args) {
      var child = fakeChild();
      spawns.push({ bin: bin, args: args, child: child });
      return child;
    },
  });
  return { handler: handler, spawns: spawns };
}

function nextTick() { return new Promise(function (r) { setImmediate(r); }); }

// A minimal successful stream for a given CLI version (null: init without one).
function okStream(version) {
  var init = { type: 'system', subtype: 'init', mcp_servers: [] };
  if (version !== null) init.claude_code_version = version;
  return [
    JSON.stringify(init),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 1 } } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's-1', result: 'Done.', usage: {} }),
  ].join('\n') + '\n';
}

function quiet(fn) {
  var lines = [];
  var origLog = console.log, origErr = console.error;
  console.log = function () { lines.push([].slice.call(arguments).join(' ')); };
  console.error = function () { lines.push([].slice.call(arguments).join(' ')); };
  return Promise.resolve().then(fn).then(function () {
    console.log = origLog; console.error = origErr; return lines;
  }, function (e) {
    console.log = origLog; console.error = origErr; throw e;
  });
}

async function turn(h, sock, stdout) {
  await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
  var child = h.spawns[h.spawns.length - 1].child;
  child.stdout.emit('data', Buffer.from(stdout));
  child.emit('close', 0);
  await nextTick();
}

test('in-range version: no notice, turn completes normally', async () => {
  resetCliVersionNoticeForTests();
  var h = harness(), sock = fakeSocket();
  await quiet(function () { return turn(h, sock, okStream('2.1.289')); });
  assert.equal(sock.notices().length, 0);
  assert.equal(sock.sent.filter(function (m) { return m.type === 'chat_done'; }).length, 1);
});

test('newer version: exactly one notice per daemon life, across turns, handlers and sockets', async () => {
  resetCliVersionNoticeForTests();
  var h = harness(), sock = fakeSocket();
  var lines = await quiet(function () { return turn(h, sock, okStream('2.1.310')); });
  var n = sock.notices();
  assert.equal(n.length, 1);
  assert.match(n[0].message, /tested with Claude Code 2\.1\.236 to 2\.1\.293/);
  assert.match(n[0].message, /2\.1\.310, which is newer/);
  assert.equal(/[–—]/.test(n[0].message), false, 'no dashes in panel copy');
  assert.equal(lines.filter(function (l) { return /is newer than the tested range/.test(l); }).length, 1, 'one daemon log line');
  // The turn itself still ends with its own outcome, after the notice.
  var types = sock.sent.map(function (m) { return m.type; });
  assert.ok(types.indexOf('chat_event') < types.indexOf('chat_done'));
  assert.equal(sock.sent.filter(function (m) { return m.type === 'chat_done'; }).length, 1);
  assert.equal(sock.sent.filter(function (m) { return m.type === 'chat_error'; }).length, 0);

  // Second turn on the same handler: silent.
  await quiet(function () { return turn(h, sock, okStream('2.1.310')); });
  assert.equal(sock.notices().length, 1);
  // Another handler (another AE instance) on another socket: still silent.
  var h2 = harness(), sock2 = fakeSocket();
  await quiet(function () { return turn(h2, sock2, okStream('2.1.310')); });
  assert.equal(sock2.notices().length, 0);
});

test('older version: one notice saying older', async () => {
  resetCliVersionNoticeForTests();
  var h = harness(), sock = fakeSocket();
  await quiet(function () { return turn(h, sock, okStream('2.1.100')); });
  var n = sock.notices();
  assert.equal(n.length, 1);
  assert.match(n[0].message, /2\.1\.100, which is older/);
});

test('unknown or missing version: nothing, and the flag is not consumed', async () => {
  resetCliVersionNoticeForTests();
  var h = harness(), sock = fakeSocket();
  await quiet(function () { return turn(h, sock, okStream(null)); });
  await quiet(function () { return turn(h, sock, okStream('weird build')); });
  await quiet(function () { return turn(h, sock, okStream('')); });
  assert.equal(sock.notices().length, 0);
  // A later init that does name an out-of-range version still gets the one notice.
  await quiet(function () { return turn(h, sock, okStream('2.1.400')); });
  assert.equal(sock.notices().length, 1);
});

test('a stream with no init event (failed resume shape) never notifies', async () => {
  resetCliVersionNoticeForTests();
  var h = harness(), sock = fakeSocket();
  var stdout = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, errors: ['No conversation found with session ID: x'] }) + '\n';
  await quiet(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    var child = h.spawns[0].child;
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 1);
    await nextTick();
  });
  assert.equal(sock.notices().length, 0);
});

test('the spawn args are identical whether or not the version is out of range', async () => {
  resetCliVersionNoticeForTests();
  // Two turns each (the second resumes the adopted session), compared pairwise.
  var a = harness(), sa = fakeSocket();
  await quiet(function () { return turn(a, sa, okStream('2.1.289')); });
  await quiet(function () { return turn(a, sa, okStream('2.1.289')); });
  var b = harness(), sb = fakeSocket();
  await quiet(function () { return turn(b, sb, okStream('2.1.999')); });
  await quiet(function () { return turn(b, sb, okStream('2.1.999')); });
  assert.deepEqual(b.spawns[0].args, a.spawns[0].args);
  assert.deepEqual(b.spawns[1].args, a.spawns[1].args);
  assert.ok(b.spawns[1].args.indexOf('--resume') !== -1, 'second turn resumes in both');
});

test.after(() => {
  [process.env.GAFFER_CONFIG_PATH, process.env.GAFFER_BUFFER_PATH].forEach(function (p) {
    try { if (existsSync(p)) unlinkSync(p); } catch (e) {}
  });
});
