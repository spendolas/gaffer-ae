// Panel side of the daemon connection's authentication, kept out of main.js so
// it can be unit tested (panel/daemon/test/panel-bridge-auth-client.test.mjs
// loads this file into node:vm with a stub window). Plain ES5, no require, no
// DOM: file reads, randomness and the WebSocket stay in main.js.
// Loaded by a <script> tag in index.html BEFORE main.js.
//
// The daemon writes a fresh secret to <user data>/Gaffer/bridge-token on every
// start. The panel never sends it: both sides prove they know it with an HMAC
// over fresh nonces (formulas in panel/daemon/bridge-token.js). Until the
// daemon's proof verifies, createHandshake().handle() hands nothing to the
// panel, so a process that merely listens on the port can neither run
// ExtendScript through the panel nor feed it chat or settings messages.
(function (root) {
  'use strict';

  var LABEL = 'gaffer-bridge-v1';
  var HEX64 = /^[0-9a-f]{64}$/;
  // How long the panel waits for the daemon's challenge, then for its proof,
  // before treating the connection as not Gaffer's daemon.
  var HANDSHAKE_TIMEOUT_MS = 3000;
  // After the panel gives up and shows its notice it keeps trying at this pace
  // (the token file is read again each time), so it recovers by itself once the
  // cause is fixed. No security cost: there is no fallback to a tokenless path.
  var SLOW_RETRY_MS = 30000;

  // ── SHA-256 / HMAC-SHA256 (FIPS 180-4, RFC 2104), over UTF-8 bytes ──
  // CEP without Node integration has no crypto module and crypto.subtle is
  // async, so the gate uses this small synchronous implementation; the tests
  // check it against node:crypto.
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8Bytes(str) {
    var s = unescape(encodeURIComponent(String(str)));
    var out = new Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  // bytes: array of 0..255. Returns an array of 32 bytes.
  function sha256Bytes(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length;
    var padded = bytes.slice();
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0);
    var hi = Math.floor((len * 8) / 4294967296);
    var lo = (len * 8) >>> 0;
    padded.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
      (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var w = new Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      var t;
      for (t = 0; t < 16; t++) {
        var j = off + t * 4;
        w[t] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) | 0;
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = [];
    for (var i = 0; i < 8; i++) out.push((h[i] >>> 24) & 255, (h[i] >>> 16) & 255, (h[i] >>> 8) & 255, h[i] & 255);
    return out;
  }

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  function hmacSha256Hex(key, message) {
    var k = utf8Bytes(key);
    if (k.length > 64) k = sha256Bytes(k);
    while (k.length < 64) k.push(0);
    var ipad = [], opad = [];
    for (var i = 0; i < 64; i++) { ipad.push(k[i] ^ 0x36); opad.push(k[i] ^ 0x5c); }
    var inner = sha256Bytes(ipad.concat(utf8Bytes(message)));
    return toHex(sha256Bytes(opad.concat(inner)));
  }

  function clientProof(token, serverNonce, clientNonce) {
    return hmacSha256Hex(token, LABEL + ' client ' + serverNonce + ' ' + clientNonce);
  }
  function serverProof(token, clientNonce, serverNonce) {
    return hmacSha256Hex(token, LABEL + ' server ' + clientNonce + ' ' + serverNonce);
  }

  // Constant-time-ish string equality for two proofs of the same expected
  // length (the panel only ever compares the daemon's proof to its own).
  function sameHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== 64 || b.length !== 64) return false;
    var diff = 0;
    for (var i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // ── Token file ──
  // userDataDir is CSInterface's SystemPath.USER_DATA: ~/Library/Application
  // Support on macOS, %APPDATA% on Windows, the same folders the daemon's
  // config-path.js uses. Forward slashes work for Node fs and cep.fs on both.
  function tokenPath(userDataDir) {
    return String(userDataDir == null ? '' : userDataDir).replace(/[\/\\]+$/, '') + '/Gaffer/bridge-token';
  }
  function parseToken(text) {
    if (typeof text !== 'string') return null;
    var t = text.replace(/^\s+|\s+$/g, '');
    return HEX64.test(t) ? t : null;
  }
  function isValidToken(t) { return typeof t === 'string' && HEX64.test(t); }

  // Is a token file safe to read? On macOS/Linux it must belong to the current
  // user and not be group or world accessible (the daemon writes it 0600 in an
  // owner-only folder); anything else could have been placed by someone else.
  // Windows has no such bits: the per-user %APPDATA% folder is the boundary.
  // stat is { uid, mode } from fstat; uid is process.getuid() (undefined on Windows).
  function tokenFileTrusted(stat, uid, platform) {
    if (platform === 'win32') return true;
    if (!stat || typeof uid !== 'number') return false;
    if (stat.uid !== uid) return false;
    return (stat.mode & 63) === 0; // 0o077: no group or other permission bits
  }

  // Which notice to show after giving up. A daemon that never sent a challenge
  // is one from before the connection was authenticated, still running from an
  // earlier install; Repair stops it. Anything else: reload first, Repair next.
  function giveUpCode(handshakeState) {
    return handshakeState === 'await-challenge' ? 'bridge-old-daemon' : 'bridge-auth';
  }

  // ── Gate ──
  // States: await-challenge -> await-server-proof -> trusted, or failed.
  // handle(raw) -> { send, deliver, trusted, failed }
  //   send     string to put on the socket (our proof), or null
  //   deliver  the raw message for the panel's normal handler, or null; non-null
  //            only once trusted, so nothing reaches evalScript or the UI before
  //   trusted  true on the call that completes the handshake
  //   failed   reason string on the call that fails it ('no-token', 'bad-challenge',
  //            'bad-server-proof'); the caller closes the socket
  function createHandshake(opts) {
    var token = opts && opts.token;
    var randomHex = opts && opts.randomHex;
    var state = 'await-challenge';
    var serverNonce = null;
    var clientNonce = null;

    function out(o) {
      return { send: o.send || null, deliver: o.deliver || null, trusted: !!o.trusted, failed: o.failed || null };
    }
    function fail(reason) { state = 'failed'; return out({ failed: reason }); }
    function parse(raw) {
      if (typeof raw !== 'string') return null;
      try { var m = JSON.parse(raw); return m && typeof m === 'object' ? m : null; } catch (e) { return null; }
    }

    return {
      state: function () { return state; },
      handle: function (raw) {
        if (state === 'failed') return out({});
        if (state === 'trusted') {
          var m = parse(raw);
          // Handshake types never go to the panel handler, so a later
          // challenge cannot reset or fake anything.
          if (!m || m.type === 'auth_challenge' || m.type === 'auth_ok') return out({});
          return out({ deliver: raw });
        }
        var msg = parse(raw);
        if (state === 'await-challenge') {
          if (!msg || msg.type !== 'auth_challenge') return out({}); // drop; wait for the challenge
          if (!isValidToken(token)) return fail('no-token');
          if (typeof msg.nonce !== 'string' || !HEX64.test(msg.nonce)) return fail('bad-challenge');
          serverNonce = msg.nonce;
          clientNonce = randomHex();
          state = 'await-server-proof';
          return out({ send: JSON.stringify({ type: 'auth', nonce: clientNonce, proof: clientProof(token, serverNonce, clientNonce) }) });
        }
        // await-server-proof: only the daemon's proof is accepted
        if (!msg || msg.type !== 'auth_ok') return out({});
        if (!sameHex(msg.proof, serverProof(token, clientNonce, serverNonce))) return fail('bad-server-proof');
        state = 'trusted';
        return out({ trusted: true });
      }
    };
  }

  // What the panel does when authentication fails: the token may simply be the
  // previous daemon's (a restart), so re-read the file once and reconnect; a
  // second failure in a row means repair, and the panel stops retrying.
  function createRetryPolicy() {
    var failures = 0;
    return {
      onAuthFailure: function () {
        failures++;
        return failures === 1 ? { reread: true, giveUp: false } : { reread: false, giveUp: true };
      },
      onTrusted: function () { failures = 0; }
    };
  }

  root.GafferBridgeAuth = {
    HANDSHAKE_TIMEOUT_MS: HANDSHAKE_TIMEOUT_MS,
    SLOW_RETRY_MS: SLOW_RETRY_MS,
    tokenFileTrusted: tokenFileTrusted,
    giveUpCode: giveUpCode,
    hmacSha256Hex: hmacSha256Hex,
    clientProof: clientProof,
    serverProof: serverProof,
    tokenPath: tokenPath,
    parseToken: parseToken,
    isValidToken: isValidToken,
    createHandshake: createHandshake,
    createRetryPolicy: createRetryPolicy
  };
})(typeof window !== 'undefined' ? window : this);
