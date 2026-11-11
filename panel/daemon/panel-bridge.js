import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID, randomBytes } from 'node:crypto';
import { isValidToken, clientProof, serverProof, proofMatches } from './bridge-token.js';
import { validateClientMessage, isModelAllowed, chatErrorText, MAX_TYPED_BYTES, MAX_PREAUTH_BYTES, PREAUTH_MAX_PAYLOAD } from './bridge-messages.js';
import { IssuedSessions } from './issued-sessions.js';

const TIMEOUT_MS = 60000;
const UNKNOWN_VERSION = 'unknown';

// Close code for a connection that did not prove it knows the token (or ran
// out of time to). A message refused AFTER authentication never closes the
// socket: a panel that already proved itself is told (chat) or the message is
// dropped, so one odd input cannot take the connection down.
export const CLOSE_AUTH = 4401;

const DEFAULT_AUTH_TIMEOUT_MS = 1500;
// Total sockets, and the share of them that may still be unauthenticated: a
// client that only opens sockets cannot take every slot from a panel.
const DEFAULT_MAX_CONNECTIONS = 16;
const DEFAULT_MAX_PREAUTH_CONNECTIONS = 8;
// Half-open HTTP upgrades are not WebSocket clients yet; bound how long one
// may take to send its headers.
const DEFAULT_HEADERS_TIMEOUT_MS = 5000;
// A JSX result is whatever a script returned (a project dump can be large), so
// the frame ceiling after authentication is generous; every other message type
// is held to MAX_TYPED_BYTES after it parses. Before the proof verifies a socket
// gets only PREAUTH_MAX_PAYLOAD per frame and may send nothing but the
// handshake (MAX_PREAUTH_BYTES).
const DEFAULT_MAX_PAYLOAD = 64 * 1024 * 1024;

// The panel dials ws://127.0.0.1:<port> (panel/main.js WS_URL), so the bridge
// binds that one address: never 0.0.0.0 (the ws default when no host is given,
// which exposed the socket to the LAN) and no ::1 listener either, since no
// client in the repo uses "localhost" for this port.
const BIND_HOST = '127.0.0.1';

/**
 * Decide whether a WebSocket upgrade may become a panel connection.
 * Pure function over the request headers so it can be unit-tested.
 *
 *  - Host must name this loopback listener (DNS-rebinding defense: a page on
 *    other.example whose DNS points at 127.0.0.1 still sends its own host).
 *  - Origin is a second layer behind the token proof: only an absent Origin,
 *    "null" or a file:// Origin (what the CEP panel can send) passes. Web
 *    pages, browser extensions and any other scheme are refused.
 *
 * Returns { ok: true } or { ok: false, reason }.
 */
export function checkPanelHandshake(headers, port) {
  var host = headers && headers.host;
  var allowedHosts = ['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port];
  if (!host || allowedHosts.indexOf(String(host).toLowerCase()) === -1) {
    return { ok: false, reason: 'Host header not a local address: ' + (host || '(missing)') };
  }
  var origin = headers.origin;
  if (origin && String(origin) !== 'null' && !/^file:\/\//i.test(String(origin))) {
    return { ok: false, reason: 'origin refused: ' + origin };
  }
  return { ok: true };
}

/**
 * WebSocket server that bridges daemon ↔ Gaffer Panels in AE.
 * Multiple panels can connect (one per AE instance), keyed by aeVersion.
 * send(code, target) routes to the right panel.
 */
export class PanelBridge {
  /**
   * opts.token           64-hex secret every panel must prove it knows (required)
   * opts.authTimeoutMs   how long a new connection has to prove it
   * opts.maxConnections  cap on simultaneous sockets, authenticated or not
   * opts.maxPreAuthConnections  cap on sockets that have not authenticated yet
   * opts.headersTimeoutMs  how long an HTTP upgrade may take to send its headers
   * opts.maxPayload      ws frame ceiling once authenticated (JSX results ride on it)
   * opts.maxTypedBytes   ceiling for every non-JSX-response message
   * opts.sessions        IssuedSessions ledger (in memory when omitted)
   */
  constructor(port, opts) {
    opts = opts || {};
    this.port = port;
    this._token = opts.token;
    this.authTimeoutMs = opts.authTimeoutMs || DEFAULT_AUTH_TIMEOUT_MS;
    this.maxConnections = opts.maxConnections || DEFAULT_MAX_CONNECTIONS;
    this.maxPreAuthConnections = opts.maxPreAuthConnections || DEFAULT_MAX_PREAUTH_CONNECTIONS;
    this.headersTimeoutMs = opts.headersTimeoutMs || DEFAULT_HEADERS_TIMEOUT_MS;
    this._originsSeen = new Set();
    // AE versions whose first unknown session id was accepted (ledger bootstrap)
    this._bootstrapped = new Set();
    this.maxPayload = opts.maxPayload || DEFAULT_MAX_PAYLOAD;
    this.maxTypedBytes = opts.maxTypedBytes || MAX_TYPED_BYTES;
    this.sessions = opts.sessions || new IssuedSessions(null);
    // Chat model membership (live list or alias); index.js points this at the
    // chat handler's live catalog. Default: aliases and claude- ids.
    this.isModelAllowed = function (model) { return isModelAllowed(model, null); };
    // Fired after an authenticated registration: (key, socket, { replaced }).
    this.onPanelRegistered = null;
    // aeVersion → { socket, projectPath, connectedAt }
    this.panels = new Map();
    // requestId → { resolve, reject, timer, socket }
    this.pending = new Map();
    this.wss = null;
    this.onChat = null;
    this.onChatCancel = null;
    this.onListMcps = null;
    this.onListModels = null;
    this.onGetShareUsageStats = null;
    this.onSetShareUsageStats = null;
    // Fired when the panel registry drops to zero — the real-world moment
    // matching "AE closed," even though the daemon process itself survives
    // (it's designed to keep running across multiple AE instances).
    this.onLastPanelDisconnected = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      var self = this;
      if (!isValidToken(this._token)) {
        reject(new Error('panel bridge needs a bridge token (64 hex characters)'));
        return;
      }
      // Our own http server (instead of letting ws create one) so the header
      // timeouts apply and a plain HTTP request gets an answer.
      this.server = http.createServer({ connectionsCheckingInterval: Math.min(1000, this.headersTimeoutMs) }, function (req, res) {
        res.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('Upgrade Required');
      });
      this.server.headersTimeout = this.headersTimeoutMs;
      this.server.requestTimeout = this.headersTimeoutMs;
      this.server.keepAliveTimeout = 1000;
      this.wss = new WebSocketServer({
        server: this.server,
        // Unauthenticated sockets get a tiny frame limit (the handshake is
        // about 200 bytes); it is raised per socket once the proof verifies.
        maxPayload: PREAUTH_MAX_PAYLOAD,
        // ws calls the two-argument form asynchronously and lets us pick the
        // HTTP status for the abort (the one-argument form always answers 401).
        verifyClient: function (info, done) {
          var verdict = checkPanelHandshake(info.req.headers, self.port);
          if (!verdict.ok) {
            console.log('Gaffer: refused panel connection, ' + verdict.reason);
            done(false, 403, 'Forbidden');
            return;
          }
          var total = 0;
          var preAuth = 0;
          if (self.wss) {
            for (var c of self.wss.clients) { total++; if (!c._gafferAuthed) preAuth++; }
          }
          if (total >= self.maxConnections || preAuth >= self.maxPreAuthConnections) {
            console.log('Gaffer: refused panel connection, too many open connections');
            done(false, 503, 'Busy');
            return;
          }
          done(true);
        },
      });
      // ws re-emits its http server's errors on the wss: take both so a port
      // that is already in use rejects start() instead of throwing.
      this.wss.once('error', reject);
      this.server.once('error', reject);
      this.server.once('listening', () => {
        this.server.removeListener('error', reject);
        this.wss.removeListener('error', reject);
        this.server.on('error', (e) => console.error('Gaffer: bridge server error', e.message));
        this._setupConnectionHandler();
        var addr = this.server.address();
        this.port = addr.port; // resolves an ephemeral port: 0 request (tests)
        console.log('Gaffer: panel bridge on ws://' + addr.address + ':' + addr.port);
        resolve();
      });
      this.server.listen(this.port, BIND_HOST);
    });
  }

  _registerSocket(socket, aeVersion, projectPath) {
    var key = aeVersion || UNKNOWN_VERSION;
    // The same socket moving to another key (a second register) frees the old one.
    var prevKey = socket._gafferKey;
    if (prevKey && prevKey !== key) {
      var prev = this.panels.get(prevKey);
      if (prev && prev.socket === socket) this.panels.delete(prevKey);
    }
    var existing = this.panels.get(key);
    var replaced = !!(existing && existing.socket !== socket);
    if (replaced) {
      // Only authenticated sockets reach this point, so this is a second
      // genuine panel for the same AE version (e.g. two AE instances of one
      // version, or a panel reload that raced its old socket's close).
      console.log('Gaffer: replacing existing authenticated panel for AE ' + key);
      // Reject pending requests targeting the old socket
      for (var [id, entry] of this.pending) {
        if (entry.socket === existing.socket) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Panel reconnected — old request abandoned'));
          this.pending.delete(id);
        }
      }
      try { existing.socket.close(); } catch (e) { /* ignore */ }
    }
    this.panels.set(key, { socket: socket, projectPath: projectPath || null, connectedAt: Date.now() });
    socket._gafferKey = key;
    console.log('Gaffer: panel connected (AE ' + key + (projectPath ? ', ' + projectPath : '') + ')');
    if (this.onPanelRegistered) {
      try { this.onPanelRegistered(key, socket, { replaced: replaced }); } catch (e) { console.error('Gaffer: onPanelRegistered failed:', e.message); }
    }
  }

  // Close a socket and make sure it really goes away: a peer that never answers
  // the close frame must not keep holding one of the connection slots.
  _closeSocket(socket, code, reason) {
    try { socket.close(code, reason); } catch (e) { /* ignore */ }
    var t = setTimeout(() => { try { socket.terminate(); } catch (e) { /* ignore */ } }, 1000);
    if (t.unref) t.unref();
  }

  // A message refused after authentication never closes the socket. One log
  // line (field paths and issue codes only, never content). A refused chat is
  // answered with a chat_error so the panel stops waiting for a reply; any other
  // refused message is dropped.
  _refuseMessage(socket, reason, msg) {
    console.log('Gaffer: rejected message from panel (' + reason + '), ignored');
    if (msg && typeof msg === 'object' && msg.type === 'chat') {
      try { socket.send(JSON.stringify({ type: 'chat_error', error: chatErrorText(reason) })); } catch (e) { /* closed */ }
    }
  }

  // Until the panel proves it knows the token the only thing accepted is the
  // one 'auth' message answering our challenge; everything else closes the
  // connection. Returns nothing: success flips socket._gafferAuthed.
  _handleHandshake(socket, data) {
    if (data.length > MAX_PREAUTH_BYTES) {
      console.log('Gaffer: refused panel connection, oversized message before authentication');
      this._closeSocket(socket, CLOSE_AUTH, 'authentication required');
      return;
    }
    var msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { msg = null; }
    var clientNonce = msg && typeof msg === 'object' ? msg.nonce : null;
    var good = msg && msg.type === 'auth' && typeof clientNonce === 'string' && /^[0-9a-f]{64}$/.test(clientNonce)
      && proofMatches(clientProof(this._token, socket._gafferNonce, clientNonce), msg.proof);
    if (!good) {
      console.log('Gaffer: refused panel connection, authentication failed');
      this._closeSocket(socket, CLOSE_AUTH, 'authentication failed');
      return;
    }
    clearTimeout(socket._gafferAuthTimer);
    socket._gafferAuthed = true;
    // Authenticated: lift the pre-auth frame limit (JSX results can be large).
    // ws keeps the limit on the socket's receiver; the bridge test suite pins
    // this against the installed ws so an upgrade that moves it fails loudly.
    if (socket._receiver && typeof socket._receiver._maxPayload === 'number') {
      socket._receiver._maxPayload = this.maxPayload;
    } else {
      console.error('Gaffer: cannot raise the frame limit for an authenticated panel');
    }
    // Log what Origin the real panel connection sends (once per distinct value).
    var origin = socket._gafferOrigin === undefined ? '(none)' : socket._gafferOrigin;
    if (!this._originsSeen.has(origin) && this._originsSeen.size < 8) {
      this._originsSeen.add(origin);
      console.log('Gaffer: panel origin seen: ' + origin);
    }
    // Track the session ids this daemon issues (chat_done) so a panel can only
    // ask to resume one of those. A cheap prefix test keeps streaming chunks
    // from being parsed on the way out.
    var sessions = this.sessions;
    var rawSend = socket.send.bind(socket);
    socket.send = function (payload) {
      if (typeof payload === 'string' && payload.charCodeAt(0) === 123 && payload.indexOf('{"type":"chat_done"') === 0) {
        try { sessions.add(JSON.parse(payload).sessionId); } catch (e) { /* not json */ }
      }
      return rawSend.apply(null, arguments);
    };
    rawSend(JSON.stringify({ type: 'auth_ok', proof: serverProof(this._token, clientNonce, socket._gafferNonce) }));
  }

  _setupConnectionHandler() {
    this.wss.on('error', (e) => console.error('Gaffer: WS server error', e.message));

    this.wss.on('connection', (socket, req) => {
      socket._gafferOrigin = req && req.headers ? req.headers.origin : undefined;
      // Not a panel until the proof verifies; not registered until it then
      // says which AE it is (or sends any message, as a legacy panel does).
      socket._gafferKey = null;
      socket._gafferAuthed = false;
      socket._gafferNonce = randomBytes(32).toString('hex');
      socket._gafferAuthTimer = setTimeout(() => {
        if (!socket._gafferAuthed) {
          console.log('Gaffer: refused panel connection, no authentication in time');
          this._closeSocket(socket, CLOSE_AUTH, 'authentication timeout');
        }
      }, this.authTimeoutMs);
      try { socket.send(JSON.stringify({ type: 'auth_challenge', nonce: socket._gafferNonce, v: 1 })); } catch (e) { /* closed already */ }

      socket.on('message', (data, isBinary) => {
        try {
          if (!socket._gafferAuthed) { this._handleHandshake(socket, data); return; }
          if (isBinary) { this._refuseMessage(socket, '(message): binary frame', null); return; }

          var parsed;
          try { parsed = JSON.parse(data.toString()); } catch (e) { this._refuseMessage(socket, '(message): not json', null); return; }
          // JSX results (no type) may be large; every other message is small.
          if (parsed && typeof parsed === 'object' && parsed.type !== undefined && data.length > this.maxTypedBytes) {
            this._refuseMessage(socket, '(message): too large', parsed);
            return;
          }
          var checked = validateClientMessage(parsed, {
            isIssuedSession: (id) => {
              if (this.sessions.has(id)) return true;
              // Upgrade path: with no ledger file yet, the first id each AE
              // version presents is taken as one the previous daemon issued.
              var key = socket._gafferKey || UNKNOWN_VERSION;
              if (this.sessions.bootstrap && !this._bootstrapped.has(key)) {
                this._bootstrapped.add(key);
                this.sessions.add(id);
                return true;
              }
              return false;
            },
          });
          if (!checked.ok) { this._refuseMessage(socket, checked.reason, parsed); return; }
          var msg = checked.msg;
          if (checked.droppedSessionId) console.log('Gaffer: ignored a chat session id this daemon did not issue');

          // Register: first message from a new panel
          if (msg.type === 'register') {
            this._registerSocket(socket, msg.aeVersion, msg.projectPath);
            return;
          }

          // If still no key, treat as UNKNOWN now (legacy panel)
          if (!socket._gafferKey) {
            this._registerSocket(socket, UNKNOWN_VERSION, null);
          }

          if (msg.type === 'chat') {
            if (!this.isModelAllowed(msg.model, socket)) {
              socket.send(JSON.stringify({ type: 'chat_error', error: 'That model is not available to this account. Pick another model in Settings.' }));
              return;
            }
            if (this.onChat) this.onChat(msg, socket);
            return;
          }
          if (msg.type === 'chat_cancel') {
            // Pass the socket so the cancel routes to that panel's chat handler
            // only (per-key isolation) — Stop in one panel must not kill another's turn.
            if (this.onChatCancel) this.onChatCancel(socket);
            return;
          }
          if (msg.type === 'list_mcps') {
            if (this.onListMcps) this.onListMcps(socket);
            return;
          }
          if (msg.type === 'list_models') {
            if (this.onListModels) this.onListModels(socket);
            return;
          }
          if (msg.type === 'auth_mcp') {
            if (this.onAuthMcp) this.onAuthMcp(msg, socket);
            return;
          }
          if (msg.type === 'auth_status') { if (this.onAuthStatus) this.onAuthStatus(socket); return; }
          if (msg.type === 'sign_in') { if (this.onSignIn) this.onSignIn(msg, socket); return; }
          if (msg.type === 'sign_out') { if (this.onSignOut) this.onSignOut(socket); return; }
          if (msg.type === 'cancel_sign_in') { if (this.onCancelSignIn) this.onCancelSignIn(); return; }
          if (msg.type === 'get_share_usage_stats') { if (this.onGetShareUsageStats) this.onGetShareUsageStats(socket); return; }
          if (msg.type === 'set_share_usage_stats') { if (this.onSetShareUsageStats) this.onSetShareUsageStats(msg, socket); return; }

          // Any other typed message has no handler here (the hidden API-key
          // buttons, for one): ignore it rather than read it as a JSX reply.
          if (msg.type !== undefined) return;

          // JSX response (no type field). Only the socket the request went to
          // may answer it; any other connection's reply is ignored.
          var entry = this.pending.get(msg.id);
          if (!entry) return;
          if (entry.socket !== socket) {
            console.log('Gaffer: ignored a JSX response from a connection the request was not sent to');
            return;
          }

          clearTimeout(entry.timer);
          this.pending.delete(msg.id);

          if (msg.ok === false) {
            entry.resolve(JSON.stringify({ ok: false, error: msg.error, line: msg.line }));
          } else {
            entry.resolve(msg.result);
          }
        } catch (e) {
          console.error('Gaffer: bad message from panel', e);
        }
      });

      socket.on('close', () => {
        clearTimeout(socket._gafferAuthTimer);
        var key = socket._gafferKey;
        if (key && this.panels.get(key) && this.panels.get(key).socket === socket) {
          console.log('Gaffer: panel disconnected (AE ' + key + ')');
          this.panels.delete(key);
          if (this.panels.size === 0 && this.onLastPanelDisconnected) this.onLastPanelDisconnected();
        }
        // Reject pending requests for this socket
        for (var [id, entry] of this.pending) {
          if (entry.socket === socket) {
            clearTimeout(entry.timer);
            entry.reject(new Error('Gaffer Panel disconnected — is After Effects open?'));
            this.pending.delete(id);
          }
        }
      });

      socket.on('error', (e) => {
        console.error('Gaffer: panel socket error', e.message);
      });
    });
  }

  _resolveTarget(target) {
    // Returns the socket to send to, or throws.
    if (target) {
      var entry = this.panels.get(target);
      if (!entry) {
        throw new Error('AE ' + target + ' not connected. Available: ' + this.listVersions().join(', '));
      }
      return entry.socket;
    }
    // No target specified
    if (this.panels.size === 0) {
      throw new Error('Gaffer Panel not connected — is After Effects open?');
    }
    if (this.panels.size === 1) {
      // Pick the only one
      var only;
      for (var v of this.panels.values()) { only = v; break; }
      return only.socket;
    }
    throw new Error('Multiple AE instances connected. Specify aeVersion: ' + this.listVersions().join(', '));
  }

  listVersions() {
    return Array.from(this.panels.keys());
  }

  send(code, target) {
    return new Promise((resolve, reject) => {
      var socket;
      try {
        socket = this._resolveTarget(target);
      } catch (e) {
        reject(e);
        return;
      }
      if (!socket || socket.readyState !== 1) {
        reject(new Error('Panel socket not ready'));
        return;
      }

      var id = randomUUID();
      var timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('runJSX timed out after 60s'));
      }, TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer, socket: socket });
      socket.send(JSON.stringify({ id, code }));
    });
  }

  sendToPanel(msg, target) {
    var socket;
    try {
      socket = this._resolveTarget(target);
    } catch (e) {
      return false;
    }
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  // Fire-and-forget a message to every connected panel (e.g. daemon_reloading).
  broadcast(msg) {
    var data = JSON.stringify(msg);
    for (var entry of this.panels.values()) {
      var s = entry.socket;
      if (s && s.readyState === 1) { try { s.send(data); } catch (e) { /* ignore */ } }
    }
  }

  stop() {
    if (!this.wss) return;
    // Drop live connections too (ws only stops accepting new ones on close),
    // so a restarted bridge never leaves a socket authenticated to the old token.
    for (var c of this.wss.clients) { try { c.terminate(); } catch (e) { /* ignore */ } }
    this.wss.close();
    if (this.server) { try { this.server.close(); } catch (e) { /* not listening */ } }
  }
}
