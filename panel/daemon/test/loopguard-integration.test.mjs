import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../instrument.js';
import { wrapSlice, wrapInSafety } from '../safety.js';

// Execute a generated slice/wrapper (an IIFE returning a JSON string) with
// stubs for the ExtendScript globals. `hiresDelta` is the microseconds each
// `$.hiresTimer` access reports (models "since last access"): a big value makes
// the freeze guard trip on its next sample, a tiny one lets work finish.
function runJSX(jsx, hiresDelta) {
  var app = { beginUndoGroup: function () {}, endUndoGroup: function () {} };
  var dollar = { _d: hiresDelta };
  Object.defineProperty(dollar, 'hiresTimer', { get: function () { return this._d; } });
  // eslint-disable-next-line no-new-func
  var fn = new Function('app', '$', 'JSON', 'return ' + jsx);
  return JSON.parse(fn(app, dollar, JSON));
}

test('runJSXLoop chain: a fat inner loop self-aborts with a budget error', () => {
  var step = 'function (cursor) { var s = 0; for (var i = 0; i < 1000000; i++) { s += i; } return { cursor: null, done: true }; }';
  var pf = preflight(step, { asExpression: true });
  assert.equal(pf.action, 'run', 'not rejected up front (loop is bounded, just huge)');
  var jsx = wrapSlice(pf.code, 'null', 'Fat step', 300, 1); // guardMs = max(3*300,1000) = 1000
  var out = runJSX(jsx, 2000000); // 2000ms per timer access > 1000ms ceiling
  assert.equal(out.ok, false);
  assert.equal(out.budgetAbort, true, 'freeze guard fired inside the step');
  assert.ok(/safety ceiling/.test(out.error), 'actionable message');
  assert.ok(typeof out.processed === 'number', 'partial count carried for resume');
});

test('runJSXLoop chain: a healthy step completes normally', () => {
  var step = 'function (cursor) { var i = cursor ? cursor.i : 0; return { cursor: { i: i + 1 }, done: (i + 1) >= 3 }; }';
  var pf = preflight(step, { asExpression: true });
  var jsx = wrapSlice(pf.code, 'null', 'Healthy', 300, 1);
  var out = runJSX(jsx, 1000); // 1ms per access, never trips
  assert.equal(out.ok, true);
  assert.equal(out.done, true);
  assert.equal(out.processed, 3, 'ran three units to completion in one slice');
});

test('runJSX chain: a fat raw loop self-aborts instead of freezing', () => {
  var raw = 'var s = 0; for (var i = 0; i < 1000000; i++) { s += i; }';
  var pf = preflight(raw, { asExpression: false });
  assert.equal(pf.action, 'run');
  var jsx = wrapInSafety(pf.code, 'Fat raw', false, { guard: true }); // RUNJSX_GUARD_MS = 2000
  var out = runJSX(jsx, 5000000); // 5000ms per access > 2000ms ceiling
  assert.equal(out.ok, false);
  assert.equal(out.budgetAbort, true);
  assert.ok(/safety ceiling/.test(out.error));
});

test('runJSX chain: a small mutating op runs unchanged and returns its result', () => {
  var raw = 'var x = 41; x + 1';
  var pf = preflight(raw, { asExpression: false });
  var jsx = wrapInSafety(pf.code, 'Small', false, { guard: true });
  var out = runJSX(jsx, 1000);
  assert.equal(out.ok, true);
  assert.equal(out.result, '42');
});

test('guarded wrapInSafety still closes its undo group on a budget abort', () => {
  // The finally must run even when the guard throws, or AE would be left with an
  // open "Gaffer:" undo group. We assert endUndoGroup fired via a spy.
  var raw = 'while (poke) { spin(); }'; // bounded only by the guard
  var pf = preflight('var poke = true; function spin(){}; for (var i=0;i<1000000;i++){ spin(); }', { asExpression: false });
  var jsx = wrapInSafety(pf.code, 'Spin', false, { guard: true });
  var closed = 0;
  var app = { beginUndoGroup: function () {}, endUndoGroup: function () { closed++; } };
  var dollar = {}; Object.defineProperty(dollar, 'hiresTimer', { get: function () { return 5000000; } });
  // eslint-disable-next-line no-new-func
  var fn = new Function('app', '$', 'JSON', 'return ' + jsx);
  var out = JSON.parse(fn(app, dollar, JSON));
  assert.equal(out.budgetAbort, true);
  assert.equal(closed, 1, 'undo group closed via finally despite the abort');
});
