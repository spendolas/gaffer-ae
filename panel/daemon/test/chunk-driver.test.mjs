import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChunkLoop } from '../chunk-driver.js';

// A stubbed runSlice that walks a counter cursor to `total`, doing `perSlice`
// units per slice. Returns the same JSON string shape wrapSlice produces.
function counterSlicer(total, perSlice) {
  return function (cursor, part) {
    var n = cursor && typeof cursor.n === 'number' ? cursor.n : 0;
    var processed = 0;
    while (processed < perSlice && n < total) { n++; processed++; }
    var done = n >= total;
    return Promise.resolve(JSON.stringify({ ok: true, cursor: { n: n }, done: done, processed: processed, part: part }));
  };
}

test('drives slices in order, threads the cursor, stops on done', async () => {
  var seenParts = [];
  var slicer = counterSlicer(10, 4);
  var out = await runChunkLoop({
    runSlice: function (cursor, part) { seenParts.push(part); return slicer(cursor, part); },
    label: 'Count', sliceMs: 300, maxMs: 999999, maxSlices: 100,
    now: () => 0,
  });
  assert.equal(out.done, true);
  assert.equal(out.reason, 'done');
  assert.equal(out.totalProcessed, 10);
  assert.deepEqual(out.cursor, { n: 10 });
  assert.deepEqual(seenParts, [1, 2, 3], '4+4+2 = three slices, parts 1..3');
});

test('fires onProgress once per committed slice with running totals', async () => {
  var progress = [];
  var out = await runChunkLoop({
    runSlice: counterSlicer(6, 2),
    label: 'Recolor', sliceMs: 300, maxMs: 999999, maxSlices: 100,
    onProgress: (p) => progress.push(p),
    now: () => 0,
  });
  assert.equal(out.totalProcessed, 6);
  assert.deepEqual(progress, [
    { label: 'Recolor', totalProcessed: 2, part: 1 },
    { label: 'Recolor', totalProcessed: 4, part: 2 },
    { label: 'Recolor', totalProcessed: 6, part: 3 },
  ]);
});

test('cancel between slices stops after the current slice, returns partial + cursor', async () => {
  var cancelAfter = 2;
  var calls = 0;
  var out = await runChunkLoop({
    runSlice: counterSlicer(100, 5),
    label: 'Big', sliceMs: 300, maxMs: 999999, maxSlices: 100,
    isCancelled: () => { calls++; return calls >= cancelAfter; },
    now: () => 0,
  });
  assert.equal(out.done, false);
  assert.equal(out.reason, 'cancelled');
  assert.equal(out.totalProcessed, 10, 'two slices of 5 committed before cancel took effect');
  assert.deepEqual(out.cursor, { n: 10 });
});

test('an error slice (ok:false) stops with reason error + partial + cursor', async () => {
  var n = 0;
  var out = await runChunkLoop({
    runSlice: function () {
      n++;
      if (n === 3) return Promise.resolve(JSON.stringify({ ok: false, error: 'Object is invalid', line: 12, cursor: { n: 20 }, processed: 7 }));
      return Promise.resolve(JSON.stringify({ ok: true, cursor: { n: n * 10 }, done: false, processed: 10 }));
    },
    label: 'X', sliceMs: 300, maxMs: 999999, maxSlices: 100,
    now: () => 0,
  });
  assert.equal(out.done, false);
  assert.equal(out.reason, 'error');
  assert.equal(out.error, 'Object is invalid');
  assert.equal(out.totalProcessed, 27, 'two good slices (20) + the failed slice partial (7) are all credited');
  assert.deepEqual(out.cursor, { n: 20 }, 'cursor from the failed slice is surfaced');
});

test('a rejected runSlice (transient disconnect) surfaces as error, never throws', async () => {
  var n = 0;
  var out = await runChunkLoop({
    runSlice: function () {
      n++;
      if (n === 2) return Promise.reject(new Error('Panel disconnected'));
      return Promise.resolve(JSON.stringify({ ok: true, cursor: { n: n }, done: false, processed: 1 }));
    },
    label: 'X', sliceMs: 300, maxMs: 999999, maxSlices: 100,
    now: () => 0,
  });
  assert.equal(out.reason, 'error');
  assert.equal(out.error, 'Panel disconnected');
  assert.equal(out.totalProcessed, 1);
});

test('maxSlices ceiling stops with reason capped', async () => {
  var out = await runChunkLoop({
    runSlice: counterSlicer(1000, 1),
    label: 'X', sliceMs: 300, maxMs: 999999, maxSlices: 3,
    now: () => 0,
  });
  assert.equal(out.done, false);
  assert.equal(out.reason, 'capped');
  assert.equal(out.totalProcessed, 3, 'exactly maxSlices slices ran');
});

test('maxMs ceiling stops with reason capped (driven via now)', async () => {
  var clock = { t: 0 };
  var out = await runChunkLoop({
    runSlice: function (cursor) {
      clock.t += 120; // each slice "takes" 120ms
      var n = cursor && cursor.n ? cursor.n : 0;
      return Promise.resolve(JSON.stringify({ ok: true, cursor: { n: n + 1 }, done: false, processed: 1 }));
    },
    label: 'X', sliceMs: 300, maxMs: 300, maxSlices: 1000,
    now: () => clock.t,
  });
  assert.equal(out.reason, 'capped');
  assert.equal(out.totalProcessed, 3, 'slices at t=120,240,360; capped when elapsed >= 300');
});

test('accumulates per-unit results across slices when present', async () => {
  var n = 0;
  var out = await runChunkLoop({
    runSlice: function () {
      n++;
      return Promise.resolve(JSON.stringify({ ok: true, cursor: { n: n }, done: n >= 3, processed: 1, result: ['r' + n] }));
    },
    label: 'X', sliceMs: 300, maxMs: 999999, maxSlices: 100,
    now: () => 0,
  });
  assert.equal(out.done, true);
  assert.deepEqual(out.results, ['r1', 'r2', 'r3']);
});

test('resolves the required summary shape and never throws for a normal stop', async () => {
  var out = await runChunkLoop({
    runSlice: counterSlicer(2, 5),
    label: 'X', sliceMs: 300, maxMs: 999999, maxSlices: 100,
    now: () => 0,
  });
  for (var k of ['done', 'totalProcessed', 'cursor', 'reason']) {
    assert.ok(Object.prototype.hasOwnProperty.call(out, k), 'summary has ' + k);
  }
});
