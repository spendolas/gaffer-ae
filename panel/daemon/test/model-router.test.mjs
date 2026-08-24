import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel } from '../model-router.js';

test('downshifts a short non-build question to haiku + low effort', () => {
  var a = chooseModel('what did you do?', { model: 'opus', effort: 'medium' });
  assert.equal(a.model, 'haiku');
  assert.equal(a.effort, 'low');
  assert.equal(a.downshifted, true);
  assert.equal(chooseModel('thanks!', { model: 'opus' }).model, 'haiku');
});

test('does NOT downshift build/expression tasks', () => {
  for (var msg of [
    'add a wiggle to the selected layer',
    'write an expression that loops the position',
    'animate the logo scaling in with overshoot',
  ]) {
    var r = chooseModel(msg, { model: 'opus', effort: 'medium' });
    assert.equal(r.model, 'opus');
    assert.equal(r.effort, 'medium'); // effort preserved when not downshifting
    assert.equal(r.downshifted, false);
  }
});

test('does not downshift long/detailed messages even without build verbs', () => {
  var long = 'here is a lot of context '.repeat(20);
  var r = chooseModel(long, { model: 'opus' });
  assert.equal(r.model, 'opus');
  assert.equal(r.downshifted, false);
});

test('never overrides an explicit pinned version id', () => {
  var r = chooseModel('hi', { model: 'claude-opus-4-8', effort: 'high' });
  assert.equal(r.model, 'claude-opus-4-8');
  assert.equal(r.effort, 'high');
  assert.equal(r.downshifted, false);
});

test('a bare alias on a trivial turn downshifts (context is dropped by caller)', () => {
  // The panel sends model:"opus" + variant:"1m" for a bare-alias 1M pick, so
  // chooseModel sees just "opus" here and downshifts; the caller drops the 1M.
  var r = chooseModel('hi', { model: 'opus', effort: 'high' });
  assert.equal(r.model, 'haiku');
  assert.equal(r.effort, 'low');
  assert.equal(r.downshifted, true);
});

test('never upshifts — haiku stays haiku on a heavy turn', () => {
  var r = chooseModel('add a wiggle', { model: 'haiku', effort: 'medium' });
  assert.equal(r.model, 'haiku');
  assert.equal(r.effort, 'medium');
  assert.equal(r.downshifted, false);
});

test('already at the floor (haiku + low) on a trivial turn is a no-op', () => {
  var r = chooseModel('hi', { model: 'haiku', effort: 'low' });
  assert.equal(r.model, 'haiku');
  assert.equal(r.effort, 'low');
  assert.equal(r.downshifted, false); // nothing changed → no log, no [1m] drop
});

test('messages containing code fences or tool mentions are not trivial', () => {
  assert.equal(chooseModel('why did ```var x``` fail?', { model: 'opus' }).downshifted, false);
  assert.equal(chooseModel('did mcp__gaffer__runJSX work?', { model: 'opus' }).downshifted, false);
});
