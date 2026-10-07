import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatHandler } from '../chat-handler.js';

// Drives a real ChatHandler.handleChat through a fake `claude` child process
// (injected spawn) and a fake panel socket, replaying the scrubbed stream-json
// fixtures in test/fixtures/cli exactly as the CLI would emit them: raw stdout
// lines, stderr text, then an exit code. Asserts the panel-facing contract:
// exactly one outcome per turn, no error text ever rendered as a reply, dead
// session ids never persisted, and no empty bubble when the CLI dies.

var FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli');

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
  child.stdin = { written: '', write(s) { this.written += s; }, end() {} };
  child.killed = null;
  child.kill = function (sig) { child.killed = sig; };
  return child;
}

function fakeSocket() {
  var sock = { readyState: 1, sent: [], _gafferKey: 'test' };
  sock.send = function (m) { sock.sent.push(JSON.parse(m)); };
  sock.ofType = function (t) { return sock.sent.filter(function (m) { return m.type === t; }); };
  return sock;
}

// Builds a handler whose spawn hands back fake children in order. Each spawn
// call is recorded ({ args, child }) so a test can inspect --resume etc.
function harness(authHook) {
  var spawns = [];
  var handler = new ChatHandler({
    cacheFilePath: '/nonexistent/gaffer-test-model-cache.json',
    findClaudeBinary: async function () { return '/fake/claude'; },
    spawn: function (bin, args) {
      var child = fakeChild();
      spawns.push({ bin: bin, args: args, child: child });
      return child;
    },
    onAuthError: authHook || null,
  });
  return { handler: handler, spawns: spawns };
}

function nextTick() { return new Promise(function (r) { setImmediate(r); }); }

// Emits a capture into a fake child the way a pipe would: stdout in two
// chunks split mid-line (proves line buffering), then stderr, then close.
function finish(child, stdout, stderr, code) {
  var cut = Math.floor(stdout.length / 2);
  child.stdout.emit('data', Buffer.from(stdout.slice(0, cut)));
  child.stdout.emit('data', Buffer.from(stdout.slice(cut)));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', code);
}

function outcomes(sock) {
  return sock.sent.filter(function (m) {
    return m.type === 'chat_result' || m.type === 'chat_error' || m.type === 'chat_done';
  });
}

// Silence the handler's console chatter inside tests but keep the lines so the
// per-turn log format can be asserted.
function captureLogs(fn) {
  var lines = [];
  var origLog = console.log, origErr = console.error;
  console.log = function () { lines.push([].slice.call(arguments).join(' ')); };
  console.error = function () { lines.push([].slice.call(arguments).join(' ')); };
  return Promise.resolve().then(fn).then(function (r) {
    console.log = origLog; console.error = origErr; return { result: r, lines: lines };
  }, function (e) {
    console.log = origLog; console.error = origErr; throw e;
  });
}

test('ok-289: one chat_result, chat_done, session adopted, one turn log line', async () => {
  var h = harness();
  var sock = fakeSocket();
  var fx = fixture('ok-289');
  var r = await captureLogs(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0].args.indexOf('--resume'), -1);
    finish(h.spawns[0].child, fx.stdout, fx.stderr, 0);
    await nextTick();
  });
  var results = sock.ofType('chat_result');
  assert.equal(results.length, 1);
  assert.equal(sock.ofType('chat_error').length, 0);
  assert.equal(sock.ofType('chat_done').length, 1);
  assert.equal(h.handler.sessionId, '00000000-0000-4000-8000-000000000000');
  assert.equal(sock.ofType('chat_done')[0].sessionId, '00000000-0000-4000-8000-000000000000');
  // Tool pills went running then done for the one tool call in the capture.
  var pills = sock.ofType('chat_tool_use');
  assert.ok(pills.length >= 2);
  assert.equal(pills[0].status, 'running');
  assert.equal(pills[pills.length - 1].status, 'done');
  var turnLines = r.lines.filter(function (l) { return /^Gaffer chat: turn=/.test(l); });
  assert.equal(turnLines.length, 1);
  assert.match(turnLines[0], /^Gaffer chat: turn=ok via=structure cli=2\.1\.289 exit=0$/);
});

test('resume-289: stale session retries exactly once fresh, dead id never saved', async () => {
  var h = harness();
  var sock = fakeSocket();
  var dead = '00000000-0000-4000-8000-000000000000';
  var fx = fixture('resume-289');
  await captureLogs(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku', sessionId: dead }, sock);
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0].args[h.spawns[0].args.indexOf('--resume') + 1], dead);
    finish(h.spawns[0].child, fx.stdout, fx.stderr, 1);
    // The retry's handleChat awaits findClaudeBinary before spawning.
    await nextTick(); await nextTick();
    assert.equal(h.spawns.length, 2, 'retried once');
    assert.equal(h.spawns[1].args.indexOf('--resume'), -1, 'retry is a fresh session');
    assert.equal(h.handler.sessionId, null, 'dead id dropped before the retry');
    // The retry also fails with the same (dead) shape: must NOT loop again.
    finish(h.spawns[1].child, fx.stdout, fx.stderr, 1);
    await nextTick(); await nextTick();
  });
  assert.equal(h.spawns.length, 2, 'no third spawn');
  assert.equal(sock.ofType('chat_result').length, 0);
  assert.notEqual(h.handler.sessionId, dead);
  // Panel got the expiry notice from the first attempt and exactly one error
  // from the second (nothing else could have carried a reply).
  assert.equal(sock.ofType('chat_event').length, 1);
  var errs = sock.ofType('chat_error');
  assert.equal(errs.length, 1);
  assert.equal(sock.ofType('chat_done').length, 0);
  assert.ok(errs[0].error.length > 0);
});

test('resume-289 followed by a good turn: retry succeeds and adopts the new id', async () => {
  var h = harness();
  var sock = fakeSocket();
  var dead = 'dead-dead-dead';
  var bad = fixture('resume-289');
  var good = fixture('ok-289');
  await captureLogs(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku', sessionId: dead }, sock);
    finish(h.spawns[0].child, bad.stdout, bad.stderr, 1);
    await nextTick(); await nextTick();
    finish(h.spawns[1].child, good.stdout, good.stderr, 0);
    await nextTick();
  });
  assert.equal(sock.ofType('chat_result').length, 1);
  assert.equal(sock.ofType('chat_error').length, 0);
  assert.equal(sock.ofType('chat_done').length, 1);
  assert.equal(h.handler.sessionId, '00000000-0000-4000-8000-000000000000');
});

test('big-289: overflow resets the session with the existing message, CLI error text never streams', async () => {
  var h = harness();
  var sock = fakeSocket();
  var fx = fixture('big-289');
  h.handler.sessionId = 'live-session';
  var r = await captureLogs(async function () {
    await h.handler.handleChat({ message: 'huge', model: 'haiku', sessionId: 'live-session' }, sock);
    finish(h.spawns[0].child, fx.stdout, fx.stderr, 1);
    await nextTick();
  });
  var out = outcomes(sock);
  assert.equal(out.length, 1, 'exactly one outcome');
  assert.equal(out[0].type, 'chat_error');
  assert.match(out[0].error, /Conversation too long for the model\. Session reset/);
  assert.equal(h.handler.sessionId, null, 'session dropped');
  sock.ofType('chat_chunk').forEach(function (c) {
    assert.equal(/prompt is too long/i.test(c.text), false, 'raw CLI error not in a chunk');
  });
  assert.equal(sock.ofType('chat_result').length, 0);
  assert.ok(r.lines.some(function (l) { return /turn=too_long via=structure/.test(l); }));
});

test('badmodel-289: error message, no chat_result, no chunk, session not adopted', async () => {
  var h = harness();
  var sock = fakeSocket();
  var fx = fixture('badmodel-289');
  await captureLogs(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'claude-nope-9' }, sock);
    finish(h.spawns[0].child, fx.stdout, fx.stderr, 1);
    await nextTick();
  });
  var out = outcomes(sock);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'chat_error');
  assert.match(out[0].error, /model is not available/);
  assert.equal(/[–—]/.test(out[0].error), false, 'no dashes in user copy');
  assert.equal(sock.ofType('chat_chunk').length, 0, 'api error text not streamed as a reply');
  assert.equal(h.handler.sessionId, null, 'dead session id not adopted');
});

test('auth failure: error points at Sign in and re-pushes auth status once', async () => {
  var pushed = [];
  var h = harness(function (socket) { pushed.push(socket); });
  var sock = fakeSocket();
  var stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.289', mcp_servers: [], session_id: 'x' }),
    JSON.stringify({ type: 'assistant', error: 'authentication_failed', is_api_error_message: true,
      message: { role: 'assistant', model: '<synthetic>', usage: { input_tokens: 0 },
        content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error',
      api_error_status: null, num_turns: 1, session_id: 'x', result: 'Not logged in · Please run /login' }),
  ].join('\n') + '\n';
  await captureLogs(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    finish(h.spawns[0].child, stdout, '', 1);
    await nextTick();
  });
  var out = outcomes(sock);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'chat_error');
  assert.match(out[0].error, /Sign in/);
  assert.equal(out[0].error.indexOf('/login'), -1);
  assert.equal(sock.ofType('chat_chunk').length, 0);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0], sock);
  assert.equal(h.handler.sessionId, null);
});

test('a normal reply mentioning context length keeps the session and is a reply', async () => {
  var h = harness();
  var sock = fakeSocket();
  var text = 'Done. I trimmed the layer to match the comp context, so its length is now 5s. The prompt is too long for one line.';
  var stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.289', mcp_servers: [], session_id: 's-1' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 5 },
      content: [{ type: 'text', text: text }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 's-1',
      result: text, usage: { input_tokens: 5, output_tokens: 20 }, total_cost_usd: 0.001 }),
  ].join('\n') + '\n';
  await captureLogs(async function () {
    await h.handler.handleChat({ message: 'trim it', model: 'haiku', sessionId: 's-1' }, sock);
    finish(h.spawns[0].child, stdout, '', 0);
    await nextTick();
  });
  assert.equal(sock.ofType('chat_error').length, 0);
  assert.equal(sock.ofType('chat_chunk').length, 1);
  assert.equal(sock.ofType('chat_result').length, 1);
  assert.equal(sock.ofType('chat_done').length, 1);
  assert.equal(h.handler.sessionId, 's-1', 'session kept');
});

test('init then exit 1 with no result: an error with text, never an empty bubble', async () => {
  var h = harness();
  var sock = fakeSocket();
  var stdout = JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.289', mcp_servers: [] }) + '\n'
    + JSON.stringify({ type: 'system', subtype: 'hook_started' }) + '\n';
  var r = await captureLogs(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    finish(h.spawns[0].child, stdout, 'boom: something broke\n', 1);
    await nextTick();
  });
  var out = outcomes(sock);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'chat_error');
  assert.ok(out[0].error.length > 0);
  assert.match(out[0].error, /boom: something broke/);
  assert.ok(r.lines.some(function (l) { return /turn=unknown_error via=none cli=2\.1\.289 exit=1/.test(l); }));
});

test('exit 0 without a result event is still an error (never chat_done with nothing)', async () => {
  var h = harness();
  var sock = fakeSocket();
  var stdout = JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.289' }) + '\n';
  await captureLogs(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    finish(h.spawns[0].child, stdout, '', 0);
    await nextTick();
  });
  var out = outcomes(sock);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'chat_error');
  assert.match(out[0].error, /exited with code 0/);
});

test('user cancel (SIGTERM) is not reported as an error', async () => {
  var h = harness();
  var sock = fakeSocket();
  var stdout = JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.289' }) + '\n';
  await captureLogs(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    var child = h.spawns[0].child;
    child.stdout.emit('data', Buffer.from(stdout));
    h.handler.cancel();
    assert.equal(child.killed, 'SIGTERM');
    child.emit('close', null);
    await nextTick();
  });
  assert.equal(sock.ofType('chat_error').length, 0);
  assert.equal(sock.ofType('chat_done').length, 1);
});

test('non-JSON stdout lines are ignored and a throwing event handler does not kill the turn', async () => {
  var h = harness();
  var sock = fakeSocket();
  // A malformed assistant event (content is not iterable) throws inside
  // _processEvent; the turn must still finish normally on the later result.
  var stdout = 'Some banner the CLI printed\n'
    + JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.289' }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1 }, content: 42 } }) + '\n'
    + JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 's-9', result: 'ok' }) + '\n';
  var r = await captureLogs(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    finish(h.spawns[0].child, stdout, '', 0);
    await nextTick();
  });
  assert.equal(sock.ofType('chat_error').length, 0);
  assert.equal(sock.ofType('chat_result').length, 1);
  assert.equal(sock.ofType('chat_done').length, 1);
  assert.equal(h.handler.sessionId, 's-9');
  assert.ok(r.lines.some(function (l) { return /ignoring non-JSON stdout line: Some banner/.test(l); }));
  assert.ok(r.lines.some(function (l) { return /event handling failed for type=assistant/.test(l); }));
});

test('spawn error reports one chat_error even if close follows', async () => {
  var h = harness();
  var sock = fakeSocket();
  await captureLogs(async function () {
    await h.handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    var child = h.spawns[0].child;
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', null);
    await nextTick();
  });
  var out = outcomes(sock);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'chat_error');
  assert.match(out[0].error, /ENOENT/);
});
