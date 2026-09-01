import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapSlice } from '../safety.js';

var STEP = 'function (cursor) { var n = cursor ? cursor.n : 0; return { cursor: { n: n + 1 }, done: n + 1 >= 5 }; }';

test('wrapSlice: labels the undo group with the part number', () => {
  var jsx = wrapSlice(STEP, 'null', 'Recolor layers', 300, 3);
  assert.ok(jsx.includes('app.beginUndoGroup("Gaffer: Recolor layers (part 3)")'), 'undo group opens with part-numbered label');
  assert.ok(jsx.includes('app.endUndoGroup()'), 'undo group closes');
});

test('wrapSlice: injects the budget and uses $.hiresTimer', () => {
  var jsx = wrapSlice(STEP, 'null', 'x', 250, 1);
  assert.ok(jsx.includes('$.hiresTimer'), 'uses $.hiresTimer');
  assert.ok(jsx.includes('< 250'), 'budget value injected into the loop condition');
});

test('wrapSlice: default budget is 300 when sliceMs missing/invalid', () => {
  assert.ok(wrapSlice(STEP, 'null', 'x').includes('< 300'));
  assert.ok(wrapSlice(STEP, 'null', 'x', 0, 1).includes('< 300'));
  assert.ok(wrapSlice(STEP, 'null', 'x', -5, 1).includes('< 300'));
});

test('wrapSlice: injects the cursor JSON verbatim', () => {
  var jsx = wrapSlice(STEP, '{"n":7}', 'x', 300, 2);
  assert.ok(jsx.includes('var cursor = {"n":7};'), 'cursor JSON injected as a JS literal');
  assert.ok(wrapSlice(STEP, 'null', 'x', 300, 1).includes('var cursor = null;'), 'first cursor is null');
});

test('wrapSlice: embeds the step body and returns a JSON string', () => {
  var jsx = wrapSlice(STEP, 'null', 'x', 300, 1);
  assert.ok(jsx.includes('var step = ' + STEP), 'step body embedded');
  assert.ok(jsx.includes('JSON.stringify'), 'returns JSON');
  assert.ok(jsx.includes('"processed"') || jsx.includes('processed:'), 'reports processed count');
});

test('wrapSlice: the error path also reports cursor + processed (partial progress)', () => {
  var jsx = wrapSlice(STEP, 'null', 'x', 300, 1);
  // processed is declared outside the try so the catch can read it.
  assert.ok(/var processed = 0;\s*\n\s*try/.test(jsx), 'processed declared before try');
  var errReturn = jsx.slice(jsx.indexOf('ok: false'));
  assert.ok(errReturn.indexOf('cursor: cursor') !== -1, 'error payload carries the resume cursor');
  assert.ok(errReturn.indexOf('processed: processed') !== -1, 'error payload carries the partial count');
});

test('wrapSlice: strips nested undo groups from the step body', () => {
  var withGroup = 'function (c) { app.beginUndoGroup("inner"); var r = { cursor: null, done: true }; app.endUndoGroup(); return r; }';
  var jsx = wrapSlice(withGroup, 'null', 'x', 300, 1);
  // Only the wrapper's own group survives.
  var opens = jsx.split('beginUndoGroup').length - 1;
  var closes = jsx.split('endUndoGroup').length - 1;
  assert.equal(opens, 1, 'exactly one beginUndoGroup (the wrapper)');
  assert.equal(closes, 1, 'exactly one endUndoGroup (the wrapper)');
});

test('wrapSlice: escapes quotes in the label', () => {
  var jsx = wrapSlice(STEP, 'null', 'say "hi"', 300, 1);
  assert.ok(jsx.includes('app.beginUndoGroup("Gaffer: say \\"hi\\" (part 1)")'));
});

test('wrapSlice: output is syntactically valid JavaScript', () => {
  // new Function parses without executing; app/$ are just free identifiers.
  assert.doesNotThrow(() => new Function(wrapSlice(STEP, '{"n":1}', 'Label', 300, 4)));
});
