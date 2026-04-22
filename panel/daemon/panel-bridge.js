import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const TIMEOUT_MS = 60000;

/**
 * WebSocket server that bridges daemon ↔ Gaffer Panel in AE.
 * Accepts one panel connection. Provides send(code) → Promise<string>.
 */
export class PanelBridge {
  constructor(port) {
    this.port = port;
    this.ws = null;
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

  _setupConnectionHandler() {
    this.wss.on('error', (e) => console.error('Gaffer: WS server error', e.message));

    this.wss.on('connection', (socket) => {
      if (this.ws) {
        console.log('Gaffer: replacing existing panel connection');
        // Reject pending requests from old socket
        for (var [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Panel reconnected — old request abandoned'));
        }
        this.pending.clear();
        try { this.ws.close(); } catch (e) { /* ignore */ }
      }

      console.log('Gaffer: panel connected');
      this.ws = socket;

      socket.on('message', (data) => {
        try {
          var msg = JSON.parse(data.toString());

          // Typed messages (chat protocol)
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
        if (this.ws === socket) {
          console.log('Gaffer: panel disconnected');
          this.ws = null;
          for (var [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error('Gaffer Panel disconnected — is After Effects open?'));
          }
          this.pending.clear();
        }
      });

      socket.on('error', (e) => {
        console.error('Gaffer: panel socket error', e.message);
      });
    });
  }

  send(code) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('Gaffer Panel not connected — is After Effects open?'));
        return;
      }

      var id = randomUUID();
      var timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('runJSX timed out after 60s'));
      }, TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, code }));
    });
  }

  sendToPanel(msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  stop() {
    if (this.wss) this.wss.close();
  }
}
