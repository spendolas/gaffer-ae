// Per-start secret that authenticates the local panel connection.
//
// The daemon writes a fresh random token to <config dir>/bridge-token on every
// start (same per-user directory as config.json; the directory always comes
// from getConfigPath(), it is never computed here). The panel reads the file
// and proves it knows the token with an HMAC over fresh nonces, in both
// directions, so the secret itself never crosses the socket:
//
//   daemon -> panel   { type: 'auth_challenge', nonce: S }
//   panel  -> daemon  { type: 'auth', nonce: C, proof: HMAC(token, 'gaffer-bridge-v1 client ' + S + ' ' + C) }
//   daemon -> panel   { type: 'auth_ok', proof: HMAC(token, 'gaffer-bridge-v1 server ' + C + ' ' + S) }
//
// The labels keep a proof from being reflected back as the other side's, and
// the nonces keep one from being replayed on another connection. The panel
// side of this lives in panel/bridge-auth.js (browser script, same formulas;
// panel-bridge-auth-client.test.mjs pins the two together).

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { writeFileSync, renameSync, mkdirSync, readFileSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigPath } from './config-path.js';

export var TOKEN_FILENAME = 'bridge-token';
var TOKEN_RE = /^[0-9a-f]{64}$/;
var PROOF_RE = /^[0-9a-f]{64}$/;
var LABEL = 'gaffer-bridge-v1';

export function bridgeTokenPath() {
  return join(dirname(getConfigPath()), TOKEN_FILENAME);
}

export function newBridgeToken() {
  return randomBytes(32).toString('hex');
}

export function isValidToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

// Temp file in the same directory, mode 0600 from creation, then rename, so a
// reader never sees a partial token and the final file never has wider
// permissions than the temp file (a rename keeps the new file's mode even when
// an older, wider file was being replaced). Windows: the per-user %APPDATA%
// folder is the access boundary and the mode bits are ignored.
// The rename can fail briefly on Windows while an antivirus scanner, the file
// indexer or a reader has the old token open (EPERM / EACCES / EBUSY). Try a
// few times, a short pause apart, before giving up; anything else is final.
export var RENAME_TRIES = 5;
export var RENAME_DELAY_MS = 100;
var TRANSIENT_RENAME = ['EPERM', 'EACCES', 'EBUSY'];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from, to, io) {
  var rename = (io && io.rename) || renameSync;
  var sleep = (io && io.sleep) || sleepSync;
  for (var attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_TRIES || TRANSIENT_RENAME.indexOf(e && e.code) === -1) throw e;
      sleep(RENAME_DELAY_MS);
    }
  }
}

// `io` ({ rename, sleep }) is a test seam for the retry.
export function writeBridgeToken(token, path, io) {
  if (!isValidToken(token)) throw new Error('bridge token must be 64 hex characters');
  var target = path || bridgeTokenPath();
  var dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The token's directory is the Gaffer app-data folder: keep it owner-only so
  // nobody else can swap the file (best effort; Windows has no mode bits).
  if (process.platform !== 'win32') { try { chmodSync(dir, 0o700); } catch (e) { /* not ours to change */ } }
  var tmp = join(dir, '.' + TOKEN_FILENAME + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp');
  try {
    writeFileSync(tmp, token, { mode: 0o600, flag: 'wx' });
    try { chmodSync(tmp, 0o600); } catch (e) { /* not supported on this platform */ }
    renameWithRetry(tmp, target, io);
  } catch (e) {
    try { unlinkSync(tmp); } catch (e2) { /* already gone */ }
    throw e;
  }
  return target;
}

export function readBridgeToken(path) {
  try {
    var t = readFileSync(path || bridgeTokenPath(), 'utf8').trim();
    return isValidToken(t) ? t : null;
  } catch (e) {
    return null;
  }
}

function mac(token, side, first, second) {
  return createHmac('sha256', token).update(LABEL + ' ' + side + ' ' + first + ' ' + second).digest('hex');
}

// What the panel sends: proof over (server nonce, client nonce).
export function clientProof(token, serverNonce, clientNonce) {
  return mac(token, 'client', serverNonce, clientNonce);
}

// What the daemon answers: proof over (client nonce, server nonce).
export function serverProof(token, clientNonce, serverNonce) {
  return mac(token, 'server', clientNonce, serverNonce);
}

// Constant-time comparison of two hex proofs. Anything that is not a 64-char
// hex string (wrong type, wrong length, non-hex) is simply "no match": the
// length check comes first because timingSafeEqual throws on unequal lengths.
export function proofMatches(expected, got) {
  if (typeof expected !== 'string' || typeof got !== 'string') return false;
  if (!PROOF_RE.test(expected) || !PROOF_RE.test(got)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(got, 'hex'));
}
