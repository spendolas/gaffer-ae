import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextTokensFromUsage,
  shouldCompactSession,
  compactThreshold,
  resolveSessionId,
  sessionIdForTurn,
  compactionSummarizerModel,
  ChatHandler,
} from '../chat-handler.js';

// Variant-aware compaction thresholds (mirror chat-handler.js). Standard (200K
// window) must trip BELOW its wall or it never fires; 1m (1M window) trips high
// so an opted-in large session isn't compacted at half capacity.
var THRESHOLD_STD = 150000;
var THRESHOLD_1M = 800000;

test('missing / empty usage is 0-safe', () => {
  assert.equal(contextTokensFromUsage(undefined), 0);
  assert.equal(contextTokensFromUsage(null), 0);
  assert.equal(contextTokensFromUsage({}), 0);
});

test('sums uncached input + cache reads + cache writes', () => {
  assert.equal(
    contextTokensFromUsage({ input_tokens: 12, cache_read_input_tokens: 314000, cache_creation_input_tokens: 1822 }),
    315834
  );
});

test('individual missing fields do not throw', () => {
  assert.equal(contextTokensFromUsage({ cache_read_input_tokens: 300000 }), 300000);
  assert.equal(contextTokensFromUsage({ input_tokens: 5 }), 5);
});

test('THE BUG: input_tokens alone never trips the gate; the real total does', () => {
  // A warm-cache turn past a 1m session's wall: tiny uncached slice, huge cache.
  var usage = { input_tokens: 12, cache_read_input_tokens: 820000, cache_creation_input_tokens: 1822 };
  // Old (buggy) gate read input_tokens only -> 12, never >= threshold -> dead code.
  assert.ok(usage.input_tokens < THRESHOLD_1M, 'uncached slice stays tiny under caching');
  // Fixed gate reads the real total -> over the 1m threshold -> compaction fires.
  assert.ok(shouldCompactSession(contextTokensFromUsage(usage), '1m'), 'real context size trips the gate');
});

// ── Variant-aware thresholds ─────────────────────────────────────────
test('compactThreshold: 1m sessions get the high wall, everyone else the low one', () => {
  assert.equal(compactThreshold('1m'), THRESHOLD_1M);
  assert.equal(compactThreshold(undefined), THRESHOLD_STD, 'no variant = standard');
  assert.equal(compactThreshold('standard'), THRESHOLD_STD);
  assert.equal(compactThreshold(''), THRESHOLD_STD);
});

test('standard (200K window) compacts before its wall — flat 500K would NEVER fire', () => {
  // A standard opus window is ~200K, so a 500K gate could never trip: compaction
  // was silently dead for non-1m sessions. The 150K gate fires with headroom.
  assert.equal(shouldCompactSession(160000, 'standard'), true, '160K standard compacts');
  assert.equal(shouldCompactSession(THRESHOLD_STD, 'standard'), true, 'exactly 150K (inclusive)');
  assert.equal(shouldCompactSession(140000, 'standard'), false, '140K does not');
  // The regression the flat-500K release introduced:
  assert.equal(160000 < 500000, true, 'proof: 160K < a flat 500K gate -> never compacts');
});

test('1m (1M window) compacts near its wall, not at half capacity', () => {
  assert.equal(shouldCompactSession(820000, '1m'), true, '820K 1m compacts');
  assert.equal(shouldCompactSession(THRESHOLD_1M, '1m'), true, 'exactly 800K (inclusive)');
  assert.equal(shouldCompactSession(500000, '1m'), false, '500K 1m is only half-full, no compact');
});

test('shouldCompactSession is 0-safe on a fresh session', () => {
  assert.equal(shouldCompactSession(0, '1m'), false);
  assert.equal(shouldCompactSession(undefined, 'standard'), false);
});

// ── Session-reset latch (the compaction LOOP bug) ────────────────────
// After a compaction the daemon nulls its sessionId, but the panel keeps
// echoing the OLD id on the next turn (msg.sessionId), which resurrected the
// just-abandoned huge session and re-compacted it every turn — summaries
// discarded, cache re-read from scratch. resolveSessionId refuses to resume the
// specifically-abandoned id so the fresh session (and its summary) takes.
test('resolveSessionId: a normal echoed id resumes; current is the fallback', () => {
  assert.equal(resolveSessionId('sess-A', 'sess-A', null), 'sess-A', 'panel id wins');
  assert.equal(resolveSessionId(null, 'sess-A', null), 'sess-A', 'falls back to current');
  assert.equal(resolveSessionId(undefined, undefined, null), null, 'nothing -> fresh');
});

test('resolveSessionId: the just-abandoned id is refused -> fresh session', () => {
  // Panel still holds the compacted session's id and re-sends it.
  assert.equal(resolveSessionId('big-abandoned', 'big-abandoned', 'big-abandoned'), null,
    'the abandoned id does NOT resurrect the compacted session');
  // A different live id is unaffected by the latch.
  assert.equal(resolveSessionId('other', 'other', 'big-abandoned'), 'other',
    'only the specific abandoned id is refused');
});

// ── Clear chat starts genuinely fresh (sessionIdForTurn) ─────────────
// clearChat() nulls the panel's own id but the daemon holds its session; without
// an explicit signal the next message resumes the old (large) session behind an
// empty window. newConversation forces fresh regardless of what's echoed/held.
test('sessionIdForTurn: normal turns resume as resolveSessionId would', () => {
  assert.equal(sessionIdForTurn(false, 'sess-A', 'sess-A', null), 'sess-A', 'echoed id resumes');
  assert.equal(sessionIdForTurn(false, null, 'held-B', null), 'held-B', 'falls back to held');
  assert.equal(sessionIdForTurn(false, 'gone', 'gone', 'gone'), null, 'abandoned id still refused');
});

test('sessionIdForTurn: Clear chat (newConversation) forces a fresh session', () => {
  // The real bug: after Clear chat the panel sends no id, but the daemon still
  // holds the big one. newConversation must win over that held id.
  assert.equal(sessionIdForTurn(true, null, 'held-big-session', null), null,
    'clear chat does NOT resume the daemon-held session');
  // And it wins even over an id the panel still echoes (defense-in-depth).
  assert.equal(sessionIdForTurn(true, 'still-echoed', 'held-big-session', null), null,
    'clear chat ignores any echoed id too');
});

// ── Compaction reuses the leading (warm-cache) model when safe ───────
// Fake capability lookup mirroring modelCapability's shape.
var CAP = {
  'claude-opus-4-8': { oneM: true, contextWindows: [200000, 1000000] },
  'claude-sonnet-5': { oneM: true, contextWindows: [200000, 1000000] },
  'claude-haiku-4-5': { oneM: false, contextWindows: [200000] },
};
function capLookup(id) { return CAP[String(id || '').replace(/\[1m\]$/, '')] || null; }

test('compactionSummarizerModel: reuses the leading 1m model when its window clears the session', () => {
  // opus[1m] led an 800K session -> its 1M window clears 800K+headroom -> reuse
  // (warm cache = cache-read, not a cold write on a fresh sonnet).
  assert.equal(compactionSummarizerModel('claude-opus-4-8[1m]', 800000, capLookup), 'claude-opus-4-8[1m]');
});

test('compactionSummarizerModel: falls back to sonnet-5 when the leading window is too small', () => {
  // The guard case Future named: a smaller-window model led right before a large
  // session compacted (a manual switch can still cause this with autoModel gone).
  assert.equal(compactionSummarizerModel('claude-haiku-4-5', 500000, capLookup), 'claude-sonnet-5', 'haiku 200K cannot read 500K');
  // A standard (no [1m]) opus caps at 200K; a ~190K session leaves no headroom.
  assert.equal(compactionSummarizerModel('claude-opus-4-8', 190000, capLookup), 'claude-sonnet-5', 'standard window too tight');
  // But a standard model on a small session is safely reused.
  assert.equal(compactionSummarizerModel('claude-opus-4-8', 150000, capLookup), 'claude-opus-4-8', 'reuse when there is headroom');
});

test('compactionSummarizerModel: unknown / missing leading model falls back safely', () => {
  assert.equal(compactionSummarizerModel(null, 500000, capLookup), 'claude-sonnet-5');
  assert.equal(compactionSummarizerModel('mystery-model', 100000, capLookup), 'claude-sonnet-5', 'no capability -> fallback');
});

// ── The compaction gate must measure CURRENT window occupancy, not per-turn
//    CUMULATIVE spend (2026-09-12 live regression) ─────────────────────────
// A heavy-tool-call turn on an ~80K context: each Gaffer tool round-trip
// re-reads the full context from cache, so the stream-json `result` event's
// usage (which SUMS every internal step) is a large multiple of the real
// window. Telemetry showed ~357K cache_read/turn while no real session ever
// exceeded ~87K, yet compaction fired. The gate must read the last assistant
// step's usage (true occupancy), never the result event's cumulative usage.
function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(m); } }; }

test('compaction gate: uses last-assistant occupancy, NOT the result event cumulative usage', () => {
  var h = new ChatHandler();
  h._lastVariant = '1m'; // 800K threshold
  var sock = fakeSocket();

  // Assistant steps; context grows to ~80,802 by the final step (true occupancy).
  h._processEvent({ type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: 40000, cache_creation_input_tokens: 500 }, content: [{ type: 'text', text: 'step 1' }] } }, sock);
  h._processEvent({ type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: 80000, cache_creation_input_tokens: 800 }, content: [{ type: 'text', text: 'final' }] } }, sock);

  // The result event's usage is CUMULATIVE over the turn (~825K) — correct for
  // COST, but it must NOT drive the occupancy gate.
  h._processEvent({ type: 'result', subtype: 'success', session_id: 's1', result: 'done', usage: { input_tokens: 20, cache_read_input_tokens: 820000, cache_creation_input_tokens: 5000 } }, sock);

  assert.equal(h.lastContextTokens, 80802, 'gate must reflect the last assistant step occupancy (~80K)');
  assert.equal(shouldCompactSession(h.lastContextTokens, h._lastVariant), false, 'an 80K window must NOT trip the 800K 1m gate');
  // The cumulative figure is the wrong value that WOULD have fired the gate.
  assert.equal(shouldCompactSession(contextTokensFromUsage({ input_tokens: 20, cache_read_input_tokens: 820000, cache_creation_input_tokens: 5000 }), '1m'), true, 'cumulative usage is the gate-tripping value the old code used');
});

test('compaction gate: a real assistant step overwrites any stale prior value', () => {
  var h = new ChatHandler();
  h.lastContextTokens = 900000; // stale huge value from a prior turn/session
  var sock = fakeSocket();
  h._processEvent({ type: 'assistant', message: { usage: { input_tokens: 1, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'x' }] } }, sock);
  assert.equal(h.lastContextTokens, 50001, 'the current turn occupancy replaces a stale leaked value');
});
