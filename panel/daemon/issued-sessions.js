// Ledger of the chat session ids this daemon has handed to a panel (the
// sessionId in each chat_done). A panel may only ask to resume an id that is on
// it, so a client cannot name some other session and have the daemon resume it.
//
// Persisted next to the config (mode 0600, bounded) because a daemon restart
// is routine (updates, dev reloads) and the panel keeps echoing its last id
// across it; without the file a restart would silently end every conversation.
// Persistence is best effort: a write that fails never throws, the ledger just
// stays in memory.

import { writeFileSync, renameSync, readFileSync, mkdirSync, chmodSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export var DEFAULT_CAP = 500;

export class IssuedSessions {
  constructor(filePath, cap) {
    this.filePath = filePath || null;
    this.cap = cap || DEFAULT_CAP;
    this.ids = []; // oldest first
    // Upgrade path: with no ledger file on disk yet (first start of this
    // version, or a write that never succeeded), the ids the previous daemon
    // issued are unknown. `bootstrap` lets the bridge accept the first id each
    // AE version presents, once, so existing conversations carry over. A purely
    // in-memory ledger (no file) never bootstraps.
    this.bootstrap = !!(this.filePath && !existsSync(this.filePath));
    this._load();
  }

  _load() {
    if (!this.filePath) return;
    try {
      var data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(data)) {
        this.ids = data.filter(function (x) { return typeof x === 'string' && UUID_RE.test(x); }).slice(-this.cap);
      }
    } catch (e) { /* missing or unreadable: start empty */ }
  }

  has(id) {
    return typeof id === 'string' && this.ids.indexOf(id.toLowerCase()) !== -1;
  }

  add(id) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return;
    id = id.toLowerCase();
    var at = this.ids.indexOf(id);
    if (at !== -1) {
      if (at === this.ids.length - 1) return;
      this.ids.splice(at, 1);
    }
    this.ids.push(id);
    if (this.ids.length > this.cap) this.ids = this.ids.slice(-this.cap);
    this._save();
  }

  _save() {
    if (!this.filePath) return;
    var tmp = null;
    try {
      var dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      tmp = join(dir, '.issued-sessions.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp');
      writeFileSync(tmp, JSON.stringify(this.ids), { mode: 0o600, flag: 'wx' });
      try { chmodSync(tmp, 0o600); } catch (e) { /* not supported here */ }
      renameSync(tmp, this.filePath);
    } catch (e) {
      if (tmp) { try { unlinkSync(tmp); } catch (e2) { /* ignore */ } }
    }
  }
}

/**
 * Record every session id a chat handler takes, at the moment it takes it (the
 * stream's result event), instead of waiting for chat_done to be sent: a panel
 * that reloaded mid-turn, or a send that failed, then still leaves the id on the
 * ledger. Wraps `handler.sessionId` in an accessor; the handler's own code is
 * untouched. Returns the handler.
 */
export function trackSessionIds(handler, sessions) {
  var current = handler.sessionId;
  Object.defineProperty(handler, 'sessionId', {
    configurable: true,
    enumerable: true,
    get: function () { return current; },
    set: function (v) {
      current = v;
      if (typeof v === 'string') sessions.add(v);
    },
  });
  return handler;
}
