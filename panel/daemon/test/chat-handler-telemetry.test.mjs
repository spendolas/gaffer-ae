import './isolate-env.mjs';
import { noopModelCatalog } from './test-catalog.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// A real ChatHandler turn (fake `claude` child, fake socket) and what it
// leaves in the telemetry buffer: the Claude Code version from the stream's
// init event, the lookup source as a closed enum, the failure counters, and
// never the binary's path. The buffer and config are throwaway files, set
// before telemetry.js is first imported (chat-handler imports it).

var runTag = process.pid + '-' + Date.now();
var CONFIG_PATH = join(tmpdir(), 'gaffer-ct-config-' + runTag + '.json');
var BUFFER_PATH = join(tmpdir(), 'gaffer-ct-buffer-' + runTag + '.json');
process.env.GAFFER_CONFIG_PATH = CONFIG_PATH;
process.env.GAFFER_BUFFER_PATH = BUFFER_PATH;
writeFileSync(CONFIG_PATH, JSON.stringify({ installId: 'test-suite', shareUsageStats: false }));

var { ChatHandler } = await import('../chat-handler.js');

var FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli');
var FAKE_PATH = '/Users/someone/Library/Application Support/Claude/claude-code/2.1.289/1a416eb22c68/claude.app/Contents/MacOS/claude';

function fixture(name) {
  return {
    stdout: readFileSync(join(FIX, name + '.jsonl'), 'utf8'),
    stderr: readFileSync(join(FIX, name + '.stderr.txt'), 'utf8'),
  };
}

function fakeChild() {
  var child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = function () {};
  return child;
}

function fakeSocket() {
  var sock = { readyState: 1, sent: [], _gafferKey: '25.0' };
  sock.send = function (m) { sock.sent.push(JSON.parse(m)); };
  return sock;
}

function harness(lookup) {
  var spawns = [];
  var handler = new ChatHandler({
    modelCatalog: noopModelCatalog(), // no Keychain or network after a finished turn
    findClaudeBinary: async function () { return FAKE_PATH; },
    lastClaudeLookup: lookup,
    spawn: function (bin, args) {
      var child = fakeChild();
      spawns.push({ bin: bin, args: args, child: child });
      return child;
    },
  });
  return { handler: handler, spawns: spawns };
}

function nextTick() { return new Promise(function (r) { setImmediate(r); }); }

function finish(child, fx, code) {
  child.stdout.emit('data', Buffer.from(fx.stdout));
  if (fx.stderr) child.stderr.emit('data', Buffer.from(fx.stderr));
  child.emit('close', code);
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

function clearBuffer() {
  try { if (existsSync(BUFFER_PATH)) unlinkSync(BUFFER_PATH); } catch (e) {}
}

var PATH_LIKE = /\/(Users|Volumes|home|private|opt|usr)\/|[A-Za-z]:\\|AppData|\.app\b|1a416eb22c68/;

test('a successful turn records cliVersion from init and cliSource from the lookup step', async () => {
  clearBuffer();
  var h = harness(function () { return { step: 'desktop app', version: '2.1.289 (Claude Code)' }; });
  var sock = fakeSocket();
  var lines = await quiet(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    finish(h.spawns[0].child, fixture('ok-289'), 0);
    await nextTick();
  });
  var buffer = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
  var bucket = buffer.byModel['haiku::haiku'];
  assert.ok(bucket, 'usage recorded');
  assert.equal(bucket.cliVersion, '2.1.289');
  assert.equal(bucket.cliSource, 'desktop-app');
  assert.equal(bucket.aeVersion, '25.0');
  assert.deepEqual(buffer.errorKinds || {}, {}, 'ok turns are not failure-counted');
  assert.equal(PATH_LIKE.test(readFileSync(BUFFER_PATH, 'utf-8')), false, 'no path in the buffer');
  var spawnLine = lines.filter(function (l) { return /^Gaffer chat spawn:/.test(l); })[0];
  assert.match(spawnLine, / cli=2\.1\.289 \(Claude Code\) source=desktop-app$/);
  assert.equal(PATH_LIKE.test(spawnLine), false);
});

test('a failed turn (not signed in shape) bumps errorKinds and still records the version', async () => {
  clearBuffer();
  var h = harness(function () { return { step: 'known location', version: '2.1.236 (Claude Code)' }; });
  var sock = fakeSocket();
  // badmodel-289 is a $0 failure capture: init (version), assistant error, error result.
  await quiet(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    finish(h.spawns[0].child, fixture('badmodel-289'), 1);
    await nextTick();
  });
  var buffer = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
  assert.deepEqual(buffer.errorKinds, { model: 1 });
  var bucket = buffer.byModel['haiku::haiku'];
  assert.equal(bucket.cliVersion, '2.1.289', 'init version wins over the lookup line');
  assert.equal(bucket.cliSource, 'standalone');
});

test('a stream with no init event falls back to the lookup version; a broken lookup gives unknown', async () => {
  clearBuffer();
  var h = harness(function () { return { step: 'PATH', version: '2.1.286 (Claude Code)' }; });
  var sock = fakeSocket();
  await quiet(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku', sessionId: '00000000-0000-4000-8000-000000000000' }, sock);
    // resume-289: a single error result, no init. The retry spawns a second
    // child; leave it hanging, the first result is what we check.
    finish(h.spawns[0].child, fixture('resume-289'), 1);
    await nextTick(); await nextTick();
  });
  var buffer = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
  assert.equal(buffer.byModel['haiku::haiku'].cliVersion, '2.1.286');
  assert.equal(buffer.byModel['haiku::haiku'].cliSource, 'path');
  assert.deepEqual(buffer.errorKinds, { stale_session: 1 });

  clearBuffer();
  var h2 = harness(function () { throw new Error('lookup exploded'); });
  var sock2 = fakeSocket();
  await quiet(async function () {
    await h2.handler.handleChat({ message: 'hi', model: 'haiku' }, sock2);
    finish(h2.spawns[0].child, { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's1', usage: { input_tokens: 1 } }) + '\n', stderr: '' }, 0);
    await nextTick();
  });
  var b2 = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
  assert.equal(b2.byModel['haiku::haiku'].cliVersion, 'unknown');
  assert.equal(b2.byModel['haiku::haiku'].cliSource, 'unknown');
  assert.equal(sock2.sent.filter(function (m) { return m.type === 'chat_done'; }).length, 1, 'the turn itself is unaffected');
});

test.after(() => {
  clearBuffer();
  try { if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH); } catch (e) {}
});
