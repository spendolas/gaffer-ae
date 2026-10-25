import './isolate-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Decision D7: the launcher strips NODE_EXTRA_CA_CERTS from the daemon and
// stashes it as GAFFER_CLAUDE_EXTRA_CA_CERTS; the chat handler restores it as
// NODE_EXTRA_CA_CERTS only in the env handed to the claude child, never leaks
// the stash variable itself, and leaves the daemon's own env alone.

var { ChatHandler, augmentedEnv, claudeChildEnv } = await import('../chat-handler.js');

test('claudeChildEnv restores the stashed CA bundle and drops the stash var', () => {
  var base = { PATH: '/usr/bin', HOME: '/h', GAFFER_CLAUDE_EXTRA_CA_CERTS: '/corp/ca.pem' };
  var out = claudeChildEnv(base, 'darwin');
  assert.equal(out.NODE_EXTRA_CA_CERTS, '/corp/ca.pem');
  assert.ok(!('GAFFER_CLAUDE_EXTRA_CA_CERTS' in out));
  assert.equal(out.HOME, '/h');
  assert.equal(base.GAFFER_CLAUDE_EXTRA_CA_CERTS, '/corp/ca.pem', 'input not mutated');
  assert.ok(!('NODE_EXTRA_CA_CERTS' in base), 'input not mutated');
});

test('claudeChildEnv: unset stays unset', () => {
  var out = claudeChildEnv({ PATH: '/usr/bin' }, 'darwin');
  assert.ok(!('NODE_EXTRA_CA_CERTS' in out));
  assert.ok(!('GAFFER_CLAUDE_EXTRA_CA_CERTS' in out));
});

test('claudeChildEnv: an empty stash restores nothing', () => {
  var out = claudeChildEnv({ GAFFER_CLAUDE_EXTRA_CA_CERTS: '' }, 'darwin');
  assert.ok(!('NODE_EXTRA_CA_CERTS' in out));
  assert.ok(!('GAFFER_CLAUDE_EXTRA_CA_CERTS' in out));
});

test('claudeChildEnv: no stash keeps a NODE_EXTRA_CA_CERTS a dev run set directly', () => {
  var out = claudeChildEnv({ NODE_EXTRA_CA_CERTS: '/dev.pem' }, 'darwin');
  assert.equal(out.NODE_EXTRA_CA_CERTS, '/dev.pem');
});

test('claudeChildEnv on win32 matches names case-insensitively', () => {
  var out = claudeChildEnv({ Path: 'C:\\W', gaffer_claude_extra_ca_certs: 'C:\\ca.pem', node_extra_ca_certs: 'C:\\old.pem' }, 'win32');
  var keys = Object.keys(out).map(function (k) { return k.toUpperCase(); });
  assert.equal(keys.indexOf('GAFFER_CLAUDE_EXTRA_CA_CERTS'), -1);
  assert.equal(keys.filter(function (k) { return k === 'NODE_EXTRA_CA_CERTS'; }).length, 1);
  assert.equal(out.NODE_EXTRA_CA_CERTS, 'C:\\ca.pem');
});

test('augmentedEnv applies the restore and leaves process.env unchanged', () => {
  var prevStash = process.env.GAFFER_CLAUDE_EXTRA_CA_CERTS;
  var prevCa = process.env.NODE_EXTRA_CA_CERTS;
  process.env.GAFFER_CLAUDE_EXTRA_CA_CERTS = '/corp/ca.pem';
  delete process.env.NODE_EXTRA_CA_CERTS;
  try {
    var env = augmentedEnv();
    assert.equal(env.NODE_EXTRA_CA_CERTS, '/corp/ca.pem');
    assert.ok(!('GAFFER_CLAUDE_EXTRA_CA_CERTS' in env));
    assert.equal(process.env.GAFFER_CLAUDE_EXTRA_CA_CERTS, '/corp/ca.pem', 'daemon env unchanged');
    assert.equal(process.env.NODE_EXTRA_CA_CERTS, undefined, 'daemon env unchanged');
  } finally {
    if (prevStash === undefined) delete process.env.GAFFER_CLAUDE_EXTRA_CA_CERTS; else process.env.GAFFER_CLAUDE_EXTRA_CA_CERTS = prevStash;
    if (prevCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = prevCa;
  }
});

// Through the real spawn seam: the chat turn's claude child gets the bundle.
function fakeChild() {
  var child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = function () {};
  return child;
}

test('the chat turn spawns claude with NODE_EXTRA_CA_CERTS restored and no stash var', async () => {
  var prevStash = process.env.GAFFER_CLAUDE_EXTRA_CA_CERTS;
  var prevCa = process.env.NODE_EXTRA_CA_CERTS;
  process.env.GAFFER_CLAUDE_EXTRA_CA_CERTS = '/corp/ca.pem';
  delete process.env.NODE_EXTRA_CA_CERTS;
  var spawns = [];
  var handler = new ChatHandler({
    cacheFilePath: '/nonexistent/gaffer-test-model-cache.json',
    findClaudeBinary: async function () { return '/fake/claude'; },
    lastClaudeLookup: function () { return null; },
    spawn: function (bin, args, opts) {
      var child = fakeChild();
      spawns.push({ bin: bin, args: args, opts: opts, child: child });
      return child;
    },
  });
  var sock = { readyState: 1, sent: [], _gafferKey: 'test', send: function (m) { sock.sent.push(m); } };
  var origLog = console.log;
  console.log = function () {};
  try {
    await handler.handleChat({ message: 'hi', model: 'haiku' }, sock);
    assert.equal(spawns.length, 1, 'claude was spawned');
    var env = spawns[0].opts.env;
    assert.equal(env.NODE_EXTRA_CA_CERTS, '/corp/ca.pem');
    assert.ok(!('GAFFER_CLAUDE_EXTRA_CA_CERTS' in env));
    assert.equal(process.env.NODE_EXTRA_CA_CERTS, undefined, 'daemon env unchanged');
    spawns[0].child.emit('close', 0);
    await new Promise(function (r) { setImmediate(r); });
  } finally {
    console.log = origLog;
    if (prevStash === undefined) delete process.env.GAFFER_CLAUDE_EXTRA_CA_CERTS; else process.env.GAFFER_CLAUDE_EXTRA_CA_CERTS = prevStash;
    if (prevCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = prevCa;
  }
});
