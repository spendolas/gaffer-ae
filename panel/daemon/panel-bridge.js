import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const TIMEOUT_MS = 60000;
const UNKNOWN_VERSION = 'unknown';

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
  }

  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port });
      this.wss.once('error', reject);
      this.wss.once('listening', () => {
        this.wss.removeListener('error', reject);
        this._setupConnectionHandler();
        console.log(`Gaffer: panel bridge on ws://127.0.0.1:${this.port}`);
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
            if (this.onChatCancel) this.onChatCancel();
            return;
          }

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

  stop() {
    if (this.wss) this.wss.close();
  }
}
