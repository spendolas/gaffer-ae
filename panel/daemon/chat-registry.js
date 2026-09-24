// Per-panel chat isolation.
//
// The daemon used to keep ONE shared ChatHandler, so every connected AE instance
// shared session id, active process, token counts, model/variant, and compaction
// state. Verified consequences: a fresh panel could resume another panel's
// session (sessionIdForTurn falls back to the daemon's held id); any panel's Stop
// cancelled whatever turn was running; the single activeProcess slot let
// concurrent turns orphan each other; and one panel's usage could compact
// another's conversation. Panel-side, chat-history.json lived in the shared
// extension folder so panels overwrote each other's history (scoped separately).
//
// This keys a ChatHandler by the bridge key (aeVersion) — infrastructure that
// already exists — so each panel gets its own isolated conversation state. It is
// the smallest stopgap that fixes the realistic live bug (two AE versions sharing
// one conversation), and is meant to be replaced, not fought, when a real
// per-conversation identity arrives.
//
// KNOWN, ACCEPTED LIMITATION: two AE instances of the SAME version collide on the
// bridge key and evict each other — CEP exposes no per-panel-instance identity, so
// "multiple panels" really means "multiple AE instances", and same-version ones
// are indistinguishable here. Out of scope for this stopgap.
export function createChatRegistry(makeHandler) {
  var handlers = new Map();
  return {
    // Get (or lazily create) the handler for a bridge key. The same key always
    // returns the same handler, so a panel reconnect resumes that panel's session.
    for(key) {
      var k = key || 'unknown';
      var h = handlers.get(k);
      if (!h) { h = makeHandler(k); handlers.set(k, h); }
      return h;
    },
    // Is ANY panel mid-turn? The dev-reload gate and the SIGTERM drain must never
    // cut a turn running on any key, not just one.
    anyBusy() {
      for (var h of handlers.values()) if (h.activeProcess) return true;
      return false;
    },
    // Apply fn to every live handler — for account-level effects that span all
    // panels (model-cache invalidation on sign-in/out, cancel-all on shutdown).
    each(fn) { for (var h of handlers.values()) fn(h); },
    keys() { return Array.from(handlers.keys()); },
    size() { return handlers.size; },
  };
}
