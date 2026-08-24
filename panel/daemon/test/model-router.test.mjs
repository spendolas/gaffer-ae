import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel } from '../model-router.js';

test('downshifts a short non-build question to haiku', () => {
  assert.equal(chooseModel('what did you do?', { model: 'opus' }).model, 'haiku');
  assert.equal(chooseModel('thanks!', { model: 'opus' }).model, 'haiku');
});

test('does NOT downshift build/expression tasks', () => {
  assert.equal(chooseModel('add a wiggle to the selected layer', { model: 'opus' }).model, 'opus');
  assert.equal(chooseModel('write an expression that loops the position', { model: 'opus' }).model, 'opus');
  assert.equal(chooseModel('animate the logo scaling in with overshoot', { model: 'opus' }).model, 'opus');
});

test('does not downshift long/detailed messages even without build verbs', () => {
  var long = 'here is a lot of context '.repeat(20);
  assert.equal(chooseModel(long, { model: 'opus' }).model, 'opus');
});

test('never touches pinned ids or 1m variants', () => {
  assert.equal(chooseModel('hi', { model: 'claude-opus-4-8' }).model, 'claude-opus-4-8');
  assert.equal(chooseModel('hi', { model: 'opus[1m]' }).model, 'opus[1m]');
});

test('never upshifts — haiku stays haiku', () => {
  assert.equal(chooseModel('add a wiggle', { model: 'haiku' }).model, 'haiku');
});

test('messages containing code fences or tool mentions are not trivial', () => {
  assert.equal(chooseModel('why did ```var x``` fail?', { model: 'opus' }).model, 'opus');
});
