import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../instrument.js';

// --- helpers ---------------------------------------------------------------

// Build a runnable function from an instrumented step body (asExpression path),
// injecting a __gafferTick via closure so we can observe/steer it.
function buildStep(instrumented, tick) {
  // eslint-disable-next-line no-new-func
  var factory = new Function('__gafferTick', 'return (' + instrumented + ');');
  return factory(tick);
}

// Run instrumented raw code with a tick stub and a trailing `return <expr>`.
function runRaw(instrumented, tick, returnExpr) {
  // eslint-disable-next-line no-new-func
  var fn = new Function('__gafferTick', instrumented + '\n; return (' + returnExpr + ');');
  return fn(tick);
}

var countTick = function () { var n = { calls: 0 }; var f = function () { n.calls++; }; f.state = n; return f; };

// --- passthrough / no-loop -------------------------------------------------

test('no loop: runs unchanged, hasLoop false', () => {
  var src = 'var x = comp.layer(1); x.opacity.setValue(50);';
  var pf = preflight(src, { asExpression: false });
  assert.equal(pf.action, 'run');
  assert.equal(pf.code, src, 'source untouched when there is nothing to guard');
  assert.equal(pf.telemetry.hasLoop, false);
  assert.equal(pf.telemetry.instrumented, false);
});

// --- loop instrumentation --------------------------------------------------

test('for loop (block): injects __gafferTick as first body statement', () => {
  var pf = preflight('for (var i = 0; i < n; i++) { doThing(i); }', { asExpression: false });
  assert.equal(pf.action, 'run');
  assert.ok(pf.code.indexOf('__gafferTick();') !== -1, 'tick injected');
  assert.equal(pf.telemetry.loopCount, 1);
  assert.equal(pf.telemetry.maxDepth, 1);
  // Tick must precede the original first statement.
  assert.ok(pf.code.indexOf('__gafferTick();') < pf.code.indexOf('doThing(i)'), 'tick is first');
});

test('while / do-while / for-in all get a tick', () => {
  ['while (c) { a(); }', 'do { a(); } while (c);', 'for (var k in o) { a(k); }'].forEach((src) => {
    var pf = preflight(src, { asExpression: false });
    assert.ok(pf.code.indexOf('__gafferTick();') !== -1, 'tick injected into ' + src);
    assert.equal(pf.telemetry.loopCount, 1);
  });
});

test('non-block body: wrapped in a block with the tick', () => {
  var pf = preflight('for (var i = 0; i < 3; i++) doThing(i);', { asExpression: false });
  assert.equal(pf.action, 'run');
  assert.ok(pf.code.indexOf('{ __gafferTick();') !== -1, 'single-statement body wrapped');
  // Still valid JS.
  assert.doesNotThrow(() => new Function('__gafferTick', 'doThing', 'n', pf.code));
});

test('empty-statement body: wrapped, stays valid', () => {
  var pf = preflight('while (poke());', { asExpression: false });
  assert.ok(pf.code.indexOf('__gafferTick();') !== -1);
  assert.doesNotThrow(() => new Function('__gafferTick', 'poke', pf.code));
});

test('nested loops: both instrumented, depth reported', () => {
  var pf = preflight('for (var i=0;i<n;i++){ for (var j=0;j<m;j++){ a(i,j); } }', { asExpression: false });
  var ticks = pf.code.split('__gafferTick();').length - 1;
  assert.equal(ticks, 2, 'a tick per loop');
  assert.equal(pf.telemetry.loopCount, 2);
  assert.equal(pf.telemetry.maxDepth, 2);
});

test('labeled loop: label preserved, body instrumented', () => {
  var pf = preflight('outer: for (var i=0;i<n;i++){ if (i>2) continue outer; a(i); }', { asExpression: false });
  assert.ok(/outer:\s*for/.test(pf.code), 'label kept on the loop');
  assert.ok(pf.code.indexOf('__gafferTick();') !== -1, 'tick injected');
});

// --- try/catch re-throw guard ---------------------------------------------

test('catch clause: re-throws the budget signal first', () => {
  var pf = preflight('try { for (var i=0;i<n;i++){ a(i); } } catch (err) { swallow(err); }', { asExpression: false });
  assert.ok(pf.code.indexOf('if (err && err.__gafferBudget) throw err;') !== -1, 're-throw guard injected with the real param name');
});

// --- function-entry tick (recursion) --------------------------------------

test('function body gets a tick even without a loop', () => {
  var pf = preflight('function f(x){ return f(x+1); }', { asExpression: false });
  assert.ok(pf.code.indexOf('__gafferTick();') !== -1, 'recursion checkpoint injected');
  assert.equal(pf.telemetry.hasLoop, false);
  assert.equal(pf.telemetry.instrumented, true);
});

// --- provably-infinite rejection ------------------------------------------

test('while(true) with no break/return/throw is rejected', () => {
  var pf = preflight('while (true) { tick++; }', { asExpression: false });
  assert.equal(pf.action, 'reject');
  assert.ok(/never ends/.test(pf.message));
  assert.equal(pf.telemetry.infinite, true);
});

test('for(;;) with no exit is rejected', () => {
  assert.equal(preflight('for (;;) { a(); }', { asExpression: false }).action, 'reject');
});

test('while(true) WITH a break is allowed (instrumented, not rejected)', () => {
  var pf = preflight('while (true) { if (done) break; a(); }', { asExpression: false });
  assert.equal(pf.action, 'run');
  assert.ok(pf.code.indexOf('__gafferTick();') !== -1);
});

test('for(;;) with a return in a function is allowed', () => {
  var pf = preflight('function (c) { for (;;) { return { done: true }; } }', { asExpression: true });
  assert.equal(pf.action, 'run');
});

// --- asExpression (step body) path ----------------------------------------

test('step body: instrumented, offsets map back correctly', () => {
  var body = 'function (cursor) { var i = cursor ? cursor.i : 1; for (var k = 0; k < 3; k++) { noop(); } return { cursor: { i: i + 1 }, done: i >= 5 }; }';
  var pf = preflight(body, { asExpression: true });
  assert.equal(pf.action, 'run');
  assert.ok(pf.code.indexOf('function (cursor)') === 0, 'output still starts with the function (no leaked wrapper paren)');
  assert.ok(pf.code.indexOf('__gafferTick();') !== -1, 'loop + function ticks injected');
  // Two ticks: function entry + the inner for.
  assert.equal(pf.code.split('__gafferTick();').length - 1, 2);
});

// --- semantic equivalence (the important one) -----------------------------

test('instrumented loop computes the same result and fires ticks', () => {
  var body = 'function (n) { var s = 0; for (var i = 0; i < n; i++) { s += i; } return s; }';
  var pf = preflight(body, { asExpression: true });
  var tick = countTick();
  var fn = buildStep(pf.code, tick);
  assert.equal(fn(5), 10, '0+1+2+3+4 == 10, semantics preserved');
  // 1 function-entry tick + 5 loop-body ticks.
  assert.equal(tick.state.calls, 6, 'tick fired per function entry and per iteration');
});

test('a throwing tick aborts the loop mid-run (tick really is in the body)', () => {
  var body = 'function (n) { var s = 0; for (var i = 0; i < n; i++) { s += i; } return s; }';
  var pf = preflight(body, { asExpression: true });
  var calls = 0;
  var throwingTick = function () { calls++; if (calls >= 3) throw { __gafferBudget: true, ms: 9999 }; };
  var fn = buildStep(pf.code, throwingTick);
  assert.throws(() => fn(1000000), (e) => e && e.__gafferBudget === true, 'budget throw unwinds the loop');
});

test('raw code path: instrumented code runs and preserves result', () => {
  var pf = preflight('var s = 0; for (var i = 0; i < 4; i++) { s += i; }', { asExpression: false });
  var tick = countTick();
  assert.equal(runRaw(pf.code, tick, 's'), 6, '0+1+2+3 == 6');
  assert.equal(tick.state.calls, 4, 'one tick per iteration (no enclosing function here)');
});

// --- parse-failure fallback ladder ----------------------------------------

test('unparseable + loop keyword: rejected', () => {
  var pf = preflight('for (var i = 0; i <', { asExpression: false });
  assert.equal(pf.action, 'reject');
  assert.ok(/Could not analyze/.test(pf.message));
  assert.equal(pf.telemetry.parseError, true);
});

test('unparseable + no loop keyword: runs raw un-instrumented', () => {
  var pf = preflight('var x = ;', { asExpression: false });
  assert.equal(pf.action, 'run');
  assert.equal(pf.code, 'var x = ;', 'passed through unchanged');
  assert.equal(pf.telemetry.parseError, true);
  assert.equal(pf.telemetry.hasLoop, false);
});
