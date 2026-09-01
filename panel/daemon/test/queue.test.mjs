import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../queue.js';

// Flush the microtask queue so deferred send() callbacks and settle handlers run.
function flush() { return new Promise((r) => setTimeout(r, 0)); }

// A bridge whose send() resolves/rejects only when we say so, so we can inspect
// isIdle() while a JSX call is genuinely in flight. The queue serializes, so at
// most one send() is pending at a time; each pushes a resolver when it runs.
function deferredBridge() {
  var resolvers = [];
  return {
    calls: 0,
    send() { this.calls++; return new Promise((resolve, reject) => resolvers.push({ resolve, reject })); },
    finish(i, err) { err ? resolvers[i].reject(err) : resolvers[i].resolve('ok'); },
  };
}

test('queue.isIdle: true at rest, false while a JSX call is in flight', async () => {
  var bridge = deferredBridge();
  var q = new Queue(bridge);
  assert.equal(q.isIdle(), true);

  var task = q.enqueue('layer.name;', 'Gaffer: test', true, null);
  assert.equal(q.isIdle(), false, 'in flight the moment it is enqueued');

  await flush();               // send() runs
  bridge.finish(0);
  await task;
  await flush();               // settle handler runs
  assert.equal(q.isIdle(), true, 'idle again after completion');
});

test('queue.isIdle: a rejected JSX call still returns the queue to idle', async () => {
  var bridge = deferredBridge();
  var q = new Queue(bridge);
  var task = q.enqueue('bad code', 'Gaffer: test', false, null);
  assert.equal(q.isIdle(), false);

  await flush();
  bridge.finish(0, new Error('boom'));
  await task.catch(() => {});   // caller sees the rejection…
  await flush();
  assert.equal(q.isIdle(), true, '…but the chain drains and idle is restored');
});

test('queue.enqueuePreWrapped: sends the code verbatim (no wrapInSafety re-wrap)', async () => {
  var sent = [];
  var bridge = {
    send(code, target) { sent.push({ code: code, target: target }); return Promise.resolve('ok'); },
  };
  var q = new Queue(bridge);
  var slice = '(function(){ app.beginUndoGroup("Gaffer: X (part 1)"); return "1"; })();';
  var task = q.enqueuePreWrapped(slice, '26.0');
  assert.equal(q.isIdle(), false, 'counted in flight');
  await task;
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].code, slice, 'bridge received the slice unchanged');
  assert.equal(sent[0].target, '26.0', 'aeVersion target routed through');
  assert.equal(q.isIdle(), true, 'idle after drain');
});

test('queue.isIdle: counts every queued call, idle only when all drain', async () => {
  var bridge = deferredBridge();
  var q = new Queue(bridge);
  var a = q.enqueue('a;', 'Gaffer: a', true, null);
  var b = q.enqueue('b;', 'Gaffer: b', true, null);
  assert.equal(q.isIdle(), false, 'both counted immediately');

  await flush();                // only a's send runs (serialized)
  bridge.finish(0);
  await a;
  await flush();                // a drains; b's send now runs
  assert.equal(q.isIdle(), false, 'second still in flight');

  bridge.finish(1);
  await b;
  await flush();
  assert.equal(q.isIdle(), true);
});
