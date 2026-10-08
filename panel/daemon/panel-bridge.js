import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const TIMEOUT_MS = 60000;
const UNKNOWN_VERSION = 'unknown';

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
 *    attacker.example whose DNS points at 127.0.0.1 still sends its own host).
 *  - A browser web page always sends an http(s) Origin; the CEP panel sends
 *    a file-ish origin, "null", or nothing. Only the web-page form is refused,
 *    everything else is allowed so no CEP/Chromium quirk can lock the panel out.
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
  if (origin && /^https?:\/\//i.test(String(origin))) {
    return { ok: false, reason: 'browser origin refused: ' + origin };
  }
  return { ok: true };
}

/**
 * WebSocket server that bridges daemon ↔ Gaffer Panels in AE.
 * Multiple panels can connect (one per AE instance), keyed by aeVersion.
 * send(code, target) routes to the right panel.
 */
export class PanelBridge {
  constructor(port) {
    this.port = port;
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
      this.wss = new WebSocketServer({
        host: BIND_HOST,
        port: this.port,
        // ws calls the two-argument form asynchronously and lets us pick the
        // HTTP status for the abort (the one-argument form always answers 401).
        verifyClient: function (info, done) {
          var verdict = checkPanelHandshake(info.req.headers, self.port);
          if (verdict.ok) { done(true); return; }
          console.log('Gaffer: refused panel connection, ' + verdict.reason);
          done(false, 403, 'Forbidden');
        },
      });
      this.wss.once('error', reject);
      this.wss.once('listening', () => {
        this.wss.removeListener('error', reject);
        this._setupConnectionHandler();
        var addr = this.wss.address();
        this.port = addr.port; // resolves an ephemeral port: 0 request (tests)
        console.log('Gaffer: panel bridge on ws://' + addr.address + ':' + addr.port);
        resolve();
      });
    });
  }

  _registerSocket(socket, aeVersion, projectPath) {
    var key = aeVersion || UNKNOWN_VERSION;
    var existing = this.panels.get(key);
    if (existing && existing.socket !== socket) {
      console.log('Gaffer: replacing existing panel for AE ' + key);
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
  }

  _setupConnectionHandler() {
    this.wss.on('error', (e) => console.error('Gaffer: WS server error', e.message));

    this.wss.on('connection', (socket) => {
      // Mark socket as pending until register arrives. Fall back to UNKNOWN
      // if no register message comes (legacy panels).
      socket._gafferKey = null;

      socket.on('message', (data) => {
        try {
          var msg = JSON.parse(data.toString());

          // Register: first message from new panel
          if (msg.type === 'register') {
            this._registerSocket(socket, msg.aeVersion, msg.projectPath);
            return;
          }

          // If still no key, treat as UNKNOWN now (legacy panel)
          if (!socket._gafferKey) {
            this._registerSocket(socket, UNKNOWN_VERSION, null);
          }

          if (msg.type === 'chat') {
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

          // Legacy: JSX response (no type field)
          var entry = this.pending.get(msg.id);
          if (!entry) return;

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
    if (this.wss) this.wss.close();
  }
}
