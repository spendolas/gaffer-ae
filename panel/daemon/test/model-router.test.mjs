import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMessage, classifyTurn, resolveTier, tierToSelection } from '../model-router.js';

// ── Stage 1: free feature score ───────────────────────────────────────
test('scoreMessage: confident trivial', () => {
  for (var m of ['hi', 'thanks!', 'what did you do?', 'ok cool', 'undo that']) {
    assert.equal(scoreMessage(m), 'trivial', m);
  }
});

test('scoreMessage: confident complex', () => {
  for (var m of [
    'add a wiggle to the selected layer',
    'animate the logo scaling in with overshoot',
    'write an expression: wiggle(2, 30)',
    'match this [image: /tmp/ref.png]',
    'set opacity to 50%',
    'why did ```var x``` fail?',
    'did mcp__gaffer__runJSX work?',
  ]) {
    assert.equal(scoreMessage(m), 'complex', m);
  }
});

test('scoreMessage: ambiguous middle → unsure', () => {
  for (var m of [
    'is the spinner comp using the right easing?',
    'tell me about the layers in this project',
    'which of those two looks closer to the reference',
  ]) {
    assert.equal(scoreMessage(m), 'unsure', m);
  }
});

// ── Stage 2: cheap classifier (injected run, never spawns) ────────────
test('classifyTurn: parses the one-word verdict', async () => {
  var run = async () => 'moderate\n';
  assert.equal(await classifyTurn('whatever', { run }), 'moderate');
});

test('classifyTurn: unparseable output → complex (safe)', async () => {
  assert.equal(await classifyTurn('x', { run: async () => 'I think this is tricky' }), 'complex');
});

test('classifyTurn: runner throws → complex (safe)', async () => {
  assert.equal(await classifyTurn('x', { run: async () => { throw new Error('boom'); } }), 'complex');
});

test('classifyTurn: no runner → complex (safe)', async () => {
  assert.equal(await classifyTurn('x', {}), 'complex');
});

test('resolveTier: confident score never calls the runner', async () => {
  var called = false;
  var run = async () => { called = true; return 'moderate'; };
  assert.equal(await resolveTier('add a wiggle', { run }), 'complex');
  assert.equal(await resolveTier('hi', { run }), 'trivial');
  assert.equal(called, false); // extremes resolved free
});

test('resolveTier: unsure escalates to the runner', async () => {
  var run = async () => 'moderate';
  assert.equal(await resolveTier('tell me about the layers in this project', { run }), 'moderate');
});

// ── Tier → selection: ladder, never-upshift, context ──────────────────
test('trivial floors to haiku / low and drops 1M', () => {
  var s = tierToSelection('trivial', { model: 'opus', effort: 'high', variant: '1m' });
  assert.deepEqual(s, { model: 'haiku', effort: 'low', dropContext: true, downshifted: true });
});

test('moderate → sonnet / medium, keeps context', () => {
  var s = tierToSelection('moderate', { model: 'opus', effort: 'high', variant: '1m' });
  assert.equal(s.model, 'sonnet');
  assert.equal(s.effort, 'medium');
  assert.equal(s.dropContext, false); // moderate keeps 1M
  assert.equal(s.downshifted, true);
});

test('complex leaves the user pick untouched', () => {
  var s = tierToSelection('complex', { model: 'opus', effort: 'high', variant: '1m' });
  assert.deepEqual(s, { model: 'opus', effort: 'high', dropContext: false, downshifted: false });
});

test('never upshifts: base sonnet, complex tier stays sonnet', () => {
  assert.equal(tierToSelection('complex', { model: 'sonnet', effort: 'medium' }).model, 'sonnet');
});

test('never upshifts: base haiku stays haiku on every tier', () => {
  for (var t of ['trivial', 'moderate', 'complex']) {
    assert.equal(tierToSelection(t, { model: 'haiku', effort: 'low' }).model, 'haiku', t);
  }
});

test('never upshifts effort: base low + moderate stays low', () => {
  var s = tierToSelection('moderate', { model: 'opus', effort: 'low' });
  assert.equal(s.effort, 'low'); // moderate targets medium but base low caps it
});

test('respects pinned version ids and off-ladder models', () => {
  var p = tierToSelection('trivial', { model: 'claude-opus-4-8', effort: 'high', variant: '1m' });
  assert.deepEqual(p, { model: 'claude-opus-4-8', effort: 'high', dropContext: false, downshifted: false });
  var f = tierToSelection('trivial', { model: 'fable', effort: 'medium' });
  assert.equal(f.model, 'fable');
  assert.equal(f.downshifted, false);
});

test('already at the floor on a trivial turn is a no-op', () => {
  var s = tierToSelection('trivial', { model: 'haiku', effort: 'low', variant: 'standard' });
  assert.equal(s.downshifted, false);
});
