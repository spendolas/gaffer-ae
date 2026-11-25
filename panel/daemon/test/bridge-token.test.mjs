import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync as realRename, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { tmpDir } from './tmp.mjs';

// The config directory is a scratch one: getConfigPath() honors this override
// (read at first call), so nothing here can touch the real per-install config.
var scratch = tmpDir('gaffer-bridge-token-');
process.env.GAFFER_CONFIG_PATH = join(scratch, 'cfg', 'config.json');
after(() => rmSync(scratch, { recursive: true, force: true }));

var T = await import('../bridge-token.js');

test('token path sits next to config.json (directory from getConfigPath)', () => {
  assert.equal(T.bridgeTokenPath(), join(dirname(process.env.GAFFER_CONFIG_PATH), 'bridge-token'));
});

test('newBridgeToken: 32 random bytes as 64 hex chars, different every call', () => {
  var a = T.newBridgeToken();
  var b = T.newBridgeToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('writeBridgeToken creates the directory, writes the token, mode 0600, no temp file left', () => {
  var token = T.newBridgeToken();
  var p = T.writeBridgeToken(token);
  assert.equal(p, T.bridgeTokenPath());
  assert.equal(readFileSync(p, 'utf8'), token);
  if (process.platform !== 'win32') {
    assert.equal(statSync(p).mode & 0o777, 0o600);
  }
  assert.deepEqual(readdirSync(dirname(p)).filter((n) => n !== 'bridge-token'), []);
  assert.equal(T.readBridgeToken(), token);
});

test('the token directory is owner-only (0700), including one that already existed wider', () => {
  if (process.platform === 'win32') return;
  var d = dirname(T.bridgeTokenPath());
  assert.equal(statSync(d).mode & 0o777, 0o700);
  var wide = join(scratch, 'wide');
  mkdirSync(wide, { mode: 0o755 });
  T.writeBridgeToken(T.newBridgeToken(), join(wide, 'bridge-token'));
  assert.equal(statSync(wide).mode & 0o777, 0o700);
});

test('writeBridgeToken rotates: a second write replaces the first, mode stays 0600', () => {
  var first = T.newBridgeToken();
  var second = T.newBridgeToken();
  T.writeBridgeToken(first);
  T.writeBridgeToken(second);
  assert.equal(T.readBridgeToken(), second);
  if (process.platform !== 'win32') {
    assert.equal(statSync(T.bridgeTokenPath()).mode & 0o777, 0o600);
  }
});

test('writeBridgeToken tightens a pre-existing wide-open file (mode comes from the new file, not the old)', () => {
  var p = T.bridgeTokenPath();
  writeFileSync(p, 'old', { mode: 0o644 });
  T.writeBridgeToken(T.newBridgeToken());
  if (process.platform !== 'win32') assert.equal(statSync(p).mode & 0o777, 0o600);
});

function transient(code) { var e = new Error(code + ': simulated'); e.code = code; return e; }

test('writeBridgeToken retries a transient rename failure (5 tries, 100 ms apart) and then succeeds', () => {
  var token = T.newBridgeToken();
  var calls = 0;
  var sleeps = [];
  var target = join(dirname(T.bridgeTokenPath()), 'retry-token');
  T.writeBridgeToken(token, target, {
    rename: (from, to) => { calls++; if (calls < 5) throw transient(calls % 2 ? 'EPERM' : 'EACCES'); return realRename(from, to); },
    sleep: (ms) => sleeps.push(ms),
  });
  assert.equal(calls, 5);
  assert.deepEqual(sleeps, [100, 100, 100, 100]);
  assert.equal(readFileSync(target, 'utf8'), token);
  assert.deepEqual(readdirSync(dirname(target)).filter((n) => n.endsWith('.tmp')), []);
});

test('writeBridgeToken gives up after 5 failed renames, rethrows, and leaves no temp file', () => {
  var calls = 0;
  var target = join(dirname(T.bridgeTokenPath()), 'giveup-token');
  assert.throws(() => T.writeBridgeToken(T.newBridgeToken(), target, {
    rename: () => { calls++; throw transient('EBUSY'); },
    sleep: () => {},
  }), (e) => e.code === 'EBUSY');
  assert.equal(calls, 5);
  assert.deepEqual(readdirSync(dirname(target)).filter((n) => n.endsWith('.tmp')), []);
});

test('writeBridgeToken does not retry an error that is not transient', () => {
  var calls = 0;
  var target = join(dirname(T.bridgeTokenPath()), 'nonretry-token');
  assert.throws(() => T.writeBridgeToken(T.newBridgeToken(), target, {
    rename: () => { calls++; throw transient('ENOSPC'); },
    sleep: () => { throw new Error('must not sleep'); },
  }), (e) => e.code === 'ENOSPC');
  assert.equal(calls, 1);
});

test('writeBridgeToken refuses a malformed token', () => {
  assert.throws(() => T.writeBridgeToken('short'));
  assert.throws(() => T.writeBridgeToken('z'.repeat(64)));
});

test('readBridgeToken returns null for a missing or malformed file', () => {
  var p = join(scratch, 'nope', 'bridge-token');
  assert.equal(T.readBridgeToken(p), null);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'not a token');
  assert.equal(T.readBridgeToken(p), null);
});

test('proofs are HMAC-SHA256 over a labelled, ordered nonce pair', () => {
  var token = 'ab'.repeat(32);
  var sn = '11'.repeat(32);
  var cn = '22'.repeat(32);
  var cp = T.clientProof(token, sn, cn);
  var sp = T.serverProof(token, cn, sn);
  assert.equal(cp, createHmac('sha256', token).update('gaffer-bridge-v1 client ' + sn + ' ' + cn).digest('hex'));
  assert.equal(sp, createHmac('sha256', token).update('gaffer-bridge-v1 server ' + cn + ' ' + sn).digest('hex'));
  assert.notEqual(cp, sp, 'a proof cannot be reflected back as the other side');
  assert.notEqual(T.clientProof(token, cn, sn), cp, 'nonce order matters');
});

test('proofMatches: constant-time compare, safe on any input', () => {
  var good = T.clientProof('cd'.repeat(32), '11'.repeat(32), '22'.repeat(32));
  assert.equal(T.proofMatches(good, good), true);
  assert.equal(T.proofMatches(good, good.slice(0, -1) + (good.endsWith('0') ? '1' : '0')), false);
  assert.equal(T.proofMatches(good, good.slice(0, 62)), false, 'shorter');
  assert.equal(T.proofMatches(good, good + '00'), false, 'longer');
  assert.equal(T.proofMatches(good, ''), false);
  assert.equal(T.proofMatches(good, undefined), false);
  assert.equal(T.proofMatches(good, null), false);
  assert.equal(T.proofMatches(good, 42), false);
  assert.equal(T.proofMatches(good, 'zz'.repeat(32)), false, 'not hex');
  assert.equal(T.proofMatches(good, { toString() { return good; } }), false, 'not a string');
});
