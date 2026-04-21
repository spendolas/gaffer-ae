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
    this.pending = new Map(); // id → { resolve, reject, timer }
    this.wss = null;
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (socket) => {
      // Replace existing connection — CEP may open multiple WebSocket
      // connections (mixed-context, panel reload, etc.)
      if (this.ws) {
        console.log('Gaffer: replacing existing panel connection');
        try { this.ws.close(); } catch (e) { /* ignore */ }
      }

      console.log('Gaffer: panel connected');
      this.ws = socket;

      socket.on('message', (data) => {
        try {
          var msg = JSON.parse(data.toString());
          var entry = this.pending.get(msg.id);
          if (!entry) return;

          clearTimeout(entry.timer);
          this.pending.delete(msg.id);

          if (msg.ok === false) {
            entry.resolve(JSON.stringify({ ok: false, error: msg.error, line: msg.line }));
          } else {
            // msg.result is the raw evalScript return (already JSON from safety wrapper)
            entry.resolve(msg.result);
          }
        } catch (e) {
          console.error('Gaffer: bad message from panel', e);
        }
      });

      socket.on('close', () => {
        // Only act if this is still the active socket (not a replaced one)
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

    console.log(`Gaffer: panel bridge on ws://127.0.0.1:${this.port}`);
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

  stop() {
    if (this.wss) {
      this.wss.close();
    }
  }
}
