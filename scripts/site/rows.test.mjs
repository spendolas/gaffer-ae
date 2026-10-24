// Resize harness for the grid's row model. It replays a window resize step by step against the pure row
// model (rows.js) and checks the two things that make a resize feel smooth:
//   1. rows are created and destroyed only beyond the viewport edges, and every row that stays keeps its
//      clips, its order and its place;
//   2. a width change (tiles scale) moves each visible tile by exactly the scale factor, with the same
//      clips on screen.
// The same checks run against `legacy` (the old slot-based model) to prove the harness catches the jump.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wrap, buildRing, rowShiftFactor, rowSpeedScale } from '../../site/js/math.js';
import { defaults } from '../../site/js/config.js';
import { gridMetrics, firstWorldRow, rowModel, panScale, windowLeft, MIN_PASSES } from '../../site/js/rows.js';

const items = JSON.parse(readFileSync(new URL('../../site/items.json', import.meta.url), 'utf8'));
const cfg = { ...defaults.grid, columns: 5, tile: 400 };
const SEED = cfg.seed;

// ---- the new model, as the grid uses it -------------------------------------------------------
const current = {
  name: 'current',
  metrics: (vw, vh) => gridMetrics(vw, vh, cfg, items),
  // world row -> { ring, tiles: [{ idx, x }] } with x the screen x of the tile's left edge at (panX).
  alive(m, panY) {
    const first = firstWorldRow(panY, m.py, m.R);
    return Array.from({ length: m.R }, (_, i) => first + i);
  },
  row(m, world, vw, panX) {
    const model = rowModel(world, m, items.length, SEED);
    const minX = windowLeft(vw / 2, m.maxP);
    const shift = rowShiftFactor(cfg.shiftMode, world, SEED) * cfg.rowShift * model.avgW;
    const pan = panX * rowSpeedScale(world, SEED, cfg.rowSpeed);
    return { ring: model.ring, tiles: model.ring.map((idx, k) => ({ idx, k, x: wrap(minX, minX + model.W, model.xs[k] + shift - pan), w: model.ws[k] })) };
  },
};

// ---- the old model: rows keyed by slot, centred wrap windows ---------------------------------
// (The old placement function, kept here only so the harness can show the jump the old model had.)
function placeRow(slot, R, py, panY) {
  const span = R * py;
  const by = slot * py - panY;
  const top = wrap(-span / 2, span / 2, by);
  return { top, world: slot - Math.round((by - top) / span) * R };
}

const legacy = {
  name: 'legacy',
  metrics: (vw, vh) => gridMetrics(vw, vh, cfg, items),
  alive(m, panY) {
    return Array.from({ length: m.R }, (_, slot) => placeRow(slot, m.R, m.py, panY).world);
  },
  row(m, world, vw, panX) {
    // The slot showing this world row at the current R.
    const slot = ((world % m.R) + m.R) % m.R;
    const ring = buildRing({ count: items.length, widths: m.widths, row: slot, seed: SEED, minWidth: m.minWidth, gap: m.gap });
    let W = 0;
    const xs = ring.map((idx) => { const x = W; W += m.widths[idx] + m.gap; return x; });
    const avgW = ring.reduce((s, i) => s + m.widths[i], 0) / ring.length;
    const shift = rowShiftFactor(cfg.shiftMode, world, SEED) * cfg.rowShift * avgW;
    const pan = panX * rowSpeedScale(slot, SEED, cfg.rowSpeed);
    return { ring, tiles: ring.map((idx, k) => ({ idx, k, x: wrap(-W / 2, W / 2, xs[k] + shift - pan), w: m.widths[idx] })) };
  },
};

// Visible tiles of a row on a vw wide stage, as "idx@x" in screen order.
const visibleTiles = (row, vw) => row.tiles.filter((t) => t.x < vw / 2 && t.x + t.w > -vw / 2).sort((a, b) => a.x - b.x);

// One resize step from state a to size (vw2, vh2): pans scale like grid.js layout() does.
function step(model, a, vw2, vh2) {
  const m2 = model.metrics(vw2, vh2);
  const { kx, ky } = panScale({ px: a.m.H + a.m.gap, py: a.m.py }, { px: m2.H + m2.gap, py: m2.py });
  return { vw: vw2, vh: vh2, m: m2, panX: a.panX * kx, panY: a.panY * ky };
}
const start = (model, vw, vh, panX, panY) => ({ vw, vh, m: model.metrics(vw, vh), panX, panY });

// Compare two consecutive states: returns a list of problems.
function compare(model, a, b) {
  const problems = [];
  const aliveA = new Set(model.alive(a.m, a.panY));
  const aliveB = new Set(model.alive(b.m, b.panY));
  const vhMin = Math.min(a.vh, b.vh);
  const top = (s, w) => w * s.m.py - s.panY;
  for (const w of new Set([...aliveA, ...aliveB])) {
    const inA = aliveA.has(w);
    const inB = aliveB.has(w);
    if (inA && inB) continue;
    // A row created or destroyed must be wholly beyond the viewport in both states.
    const s = inA ? a : b;
    const t = top(s, w);
    const other = inA ? b : a;
    const t2 = top(other, w);
    for (const [tt, st] of [[t, s], [t2, other]]) {
      if (tt < Math.min(st.vh, vhMin) / 2 && tt + st.m.py > -Math.min(st.vh, vhMin) / 2) problems.push(`row ${w} popped inside the viewport (y ${Math.round(tt)})`);
    }
  }
  for (const w of aliveA) {
    if (!aliveB.has(w)) continue;
    const ra = model.row(a.m, w, a.vw, a.panX);
    const rb = model.row(b.m, w, b.vw, b.panX);
    const va = visibleTiles(ra, a.vw);
    const vb = visibleTiles(rb, b.vw);
    // Every tile visible in both states keeps its clip and moves by the scale factor.
    const k = (b.m.H + b.m.gap) / (a.m.H + a.m.gap);
    // A ring position k holds the same clip in both states, or the row changed under us.
    if (ra.ring.length !== rb.ring.length || ra.ring.some((idx, k) => idx !== rb.ring[k])) { problems.push(`row ${w} changed its ring`); continue; }
    const byK = new Map(vb.map((t) => [t.k, t]));
    for (const t of va) {
      const mate = byK.get(t.k);
      if (!mate) continue; // left or entered at an edge
      const expect = t.x * k;
      // A tile far from the centre moves by k times its distance; allow rounding of tile widths.
      if (Math.abs(mate.x - expect) > 6) {
        problems.push(`row ${w} tile ${t.idx} jumped: ${Math.round(t.x)} -> ${Math.round(mate.x)} (expected ${Math.round(expect)})`);
        break;
      }
    }
    // The tile covering the stage centre must be the same clip.
    const centre = (r) => r.tiles.find((t) => t.x <= 0 && t.x + t.w + cfg.gap > 0)?.k; // pitch, so the gap counts
    // (Tile widths are rounded to whole pixels, so a tile edge within 8 px of the centre may flip.)
    const edgeDistance = Math.min(...ra.tiles.flatMap((t) => [Math.abs(t.x), Math.abs(t.x + t.w + cfg.gap)]));
    if (edgeDistance > 8 && centre(ra) !== centre(rb)) problems.push(`row ${w} centre tile changed ${centre(ra)} -> ${centre(rb)}`);
  }
  return problems;
}

function sweep(model, { from, to, stepBy, along, fixed, panX = 321, panY = 777 }) {
  let s = along === 'height' ? start(model, fixed, from, panX, panY) : start(model, from, fixed, panX, panY);
  const all = [];
  for (let v = from + stepBy; v <= to; v += stepBy) {
    const next = along === 'height' ? step(model, s, fixed, v) : step(model, s, v, fixed);
    for (const p of compare(model, s, next)) all.push(`${along} ${s[along === 'height' ? 'vh' : 'vw']}->${v}: ${p}`);
    s = next;
  }
  return all;
}

test('growing and shrinking the window height creates and destroys rows only beyond the viewport (current model)', () => {
  const problems = sweep(current, { from: 400, to: 1600, stepBy: 3, along: 'height', fixed: 1500 });
  assert.deepEqual(problems.slice(0, 5), []);
});

test('the legacy slot-based model fails the same height sweep (the harness sees the old jump)', () => {
  const problems = sweep(legacy, { from: 400, to: 1600, stepBy: 3, along: 'height', fixed: 1500 });
  assert.ok(problems.length > 0, 'expected the old model to jump when R changes');
});

test('changing the window width scales every visible tile by the tile scale, with the same clips (current model)', () => {
  // 1500..2600 spans the tile-size change at 2080 (5 columns), 360..590 stays under the compact limit.
  for (const range of [{ from: 700, to: 2600 }, { from: 360, to: 590 }, { from: 620, to: 1100 }]) {
    const problems = sweep(current, { ...range, stepBy: 7, along: 'width', fixed: 900 });
    assert.deepEqual(problems.slice(0, 5), [], `width ${range.from}..${range.to}`);
  }
});

test('the legacy model also fails the width sweep, and the compact breakpoint is still one expected rebuild', () => {
  const legacyProblems = sweep(legacy, { from: 700, to: 2600, stepBy: 7, along: 'width', fixed: 900 });
  assert.ok(legacyProblems.length > 0, 'expected the old model to jump on a width change');
  // Across 600 -> 601 the column count changes (2 -> 5): the tile size jumps, but the clips and their
  // order per row must not.
  const a = start(current, 600, 900, 100, 200);
  const b = step(current, a, 601, 900);
  assert.notEqual(a.m.H, b.m.H, 'the compact breakpoint changes the tile size');
  for (const w of current.alive(a.m, a.panY)) {
    if (!current.alive(b.m, b.panY).includes(w)) continue;
    assert.deepEqual(rowModel(w, a.m, items.length, SEED).ring, rowModel(w, b.m, items.length, SEED).ring, `row ${w}`);
  }
});

test('a row ring depends on its world row, not on the viewport: same order at every width up to 3200', () => {
  for (const w of [-7, -1, 0, 1, 2, 13, 40]) {
    const base = rowModel(w, current.metrics(1440, 900), items.length, SEED).ring;
    for (let vw = 320; vw <= 3200; vw += 40) {
      assert.deepEqual(rowModel(w, current.metrics(vw, 900), items.length, SEED).ring, base, `row ${w} at ${vw}`);
    }
  }
});

test('every ring has at least MIN_PASSES passes and is a viewport plus two widest tiles wide', () => {
  for (const vw of [320, 390, 800, 1440, 2560, 3840]) {
    const m = current.metrics(vw, 900);
    const model = rowModel(3, m, items.length, SEED);
    assert.ok(model.ring.length >= MIN_PASSES * Math.min(items.length, 12), `passes at ${vw}`);
    assert.ok(model.W >= m.minWidth, `wide enough at ${vw}`);
  }
});

test('firstWorldRow matches a brute-force scan of the centred window', () => {
  for (const [py, R] of [[416, 5], [300, 7], [199.5, 9]]) {
    for (let panY = -3000; panY <= 3000; panY += 37.3) {
      const first = firstWorldRow(panY, py, R);
      const span = R * py;
      const inWindow = (w) => { const y = w * py - panY; return y >= -span / 2 && y < span / 2; };
      assert.ok(inWindow(first) && !inWindow(first - 1), `first at ${panY}`);
      assert.ok(inWindow(first + R - 1) && !inWindow(first + R), `last at ${panY}`);
    }
  }
});

test('the wrap window always holds the viewport plus a widest tile each side', () => {
  for (const vw of [320, 390, 800, 1440, 2560, 3840]) {
    const m = current.metrics(vw, 900);
    const model = rowModel(2, m, items.length, SEED);
    const minX = windowLeft(vw / 2, m.maxP);
    assert.equal(minX, -(vw / 2 + m.maxP));
    assert.ok(minX + model.W >= vw / 2 + m.maxP, `window right edge at ${vw}`);
  }
});

test('rows come and go one at a time, at the top or bottom edge only, as the height changes', () => {
  let s = start(current, 1500, 400, 0, 0);
  let seenAdd = 0;
  let seenRemove = 0;
  for (let vh = 403; vh <= 1600; vh += 3) {
    const n = step(current, s, 1500, vh);
    const a = new Set(current.alive(s.m, s.panY));
    const b = new Set(current.alive(n.m, n.panY));
    const added = [...b].filter((w) => !a.has(w));
    const removed = [...a].filter((w) => !b.has(w));
    assert.ok(added.length <= 2 && removed.length <= 1, `at ${vh}: +${added.length} -${removed.length}`);
    // Alive rows stay one contiguous run.
    const sorted = [...b].sort((x, y) => x - y);
    assert.equal(sorted[sorted.length - 1] - sorted[0] + 1, sorted.length);
    seenAdd += added.length;
    seenRemove += removed.length;
    s = n;
  }
  assert.ok(seenAdd > 0, 'the sweep grew the grid');
  // Scrolling: one world row leaves at one edge and one arrives at the other per row pitch.
  const m = current.metrics(1400, 900);
  let prev = new Set(current.alive(m, 0));
  for (let panY = 5; panY <= m.py * 6; panY += 5) {
    const now = new Set(current.alive(m, panY));
    const gone = [...prev].filter((w) => !now.has(w));
    const came = [...now].filter((w) => !prev.has(w));
    assert.ok(gone.length <= 1 && came.length <= 1, `pan ${panY}`);
    prev = now;
  }
});
