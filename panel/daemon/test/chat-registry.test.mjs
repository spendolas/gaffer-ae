import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatRegistry } from '../chat-registry.js';
import { ChatHandler } from '../chat-handler.js';

test('registry: same key returns the same handler; different keys are isolated instances', () => {
  const made = [];
  const reg = createChatRegistry((k) => { const h = { key: k, activeProcess: null }; made.push(h); return h; });
  const a1 = reg.for('26.0'); const a2 = reg.for('26.0'); const b = reg.for('25.0');
  assert.equal(a1, a2, 'same key -> same handler (a reconnect resumes that panel session)');
  assert.notEqual(a1, b, 'different keys -> different handlers');
  assert.equal(reg.size(), 2);
  assert.deepEqual(reg.keys().sort(), ['25.0', '26.0']);
  assert.equal(made.length, 2, 'exactly one handler created per distinct key');
});

test('registry: null/empty key folds to a single fallback handler', () => {
  const reg = createChatRegistry(() => ({ activeProcess: null }));
  assert.equal(reg.for(null), reg.for(undefined));
  assert.equal(reg.for(''), reg.for(null));
  assert.equal(reg.size(), 1);
});

test('registry: anyBusy is true iff SOME handler has an active process', () => {
  const reg = createChatRegistry(() => ({ activeProcess: null }));
  reg.for('A'); const b = reg.for('B');
  assert.equal(reg.anyBusy(), false);
  b.activeProcess = { kill() {} };
  assert.equal(reg.anyBusy(), true, 'one busy key makes the daemon busy');
  b.activeProcess = null;
  assert.equal(reg.anyBusy(), false);
});

test('registry: each applies to every live handler', () => {
  const reg = createChatRegistry(() => ({ n: 0 }));
  reg.for('A'); reg.for('B'); reg.for('C');
  reg.each((h) => { h.n++; });
  let total = 0; reg.each((h) => { total += h.n; });
  assert.equal(reg.size(), 3);
  assert.equal(total, 3);
});

// ── Behavioral: real ChatHandlers stay isolated per key ──

test('isolation: a fresh panel on key B does NOT resume key A session', () => {
  const reg = createChatRegistry(() => new ChatHandler());
  const a = reg.for('26.0');
  a.sessionId = 'A-session-123';   // key A is mid-conversation
  const b = reg.for('25.0');       // a different AE version connects fresh
  assert.equal(b.sessionId, null, 'key B starts with no session and cannot inherit A');
  assert.notEqual(a, b);
  assert.equal(a.sessionId, 'A-session-123', 'A is untouched by B connecting');
});

test('isolation: Stop on one key cancels only that key turn', () => {
  const reg = createChatRegistry(() => new ChatHandler());
  const a = reg.for('26.0'); const b = reg.for('25.0');
  const pA = { killed: false, _userCancelled: false, kill() { this.killed = true; } };
  const pB = { killed: false, _userCancelled: false, kill() { this.killed = true; } };
  a.activeProcess = pA; b.activeProcess = pB;
  a.cancel();                      // Stop pressed in panel A
  assert.equal(a.activeProcess, null, 'A process slot cleared');
  assert.equal(pA.killed, true, 'A process was killed');
  assert.equal(b.activeProcess, pB, 'B process slot is untouched');
  assert.equal(pB.killed, false, 'B process was NOT killed by A Stop');
});

test('isolation: concurrent turns on different keys keep separate process slots', () => {
  const reg = createChatRegistry(() => new ChatHandler());
  const a = reg.for('26.0'); const b = reg.for('25.0');
  const pA = { kill() {} }; const pB = { kill() {} };
  a.activeProcess = pA; b.activeProcess = pB;   // two turns running at once
  assert.equal(a.activeProcess, pA);
  assert.equal(b.activeProcess, pB, 'B keeps its own process ref, no single-slot orphaning');
  assert.equal(reg.anyBusy(), true);
});
