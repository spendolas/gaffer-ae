import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrap, damp, warpPoint, insetQuad, homography, cardSize, COMPACT_MAX_WIDTH,
  buildRing, hash01, aspectFor, rowShiftFactor, rowSpeedScale,
  stepSpeed, velocityBow, speedReference, MAX_EFFECTIVE_BOW,
  rowFadeWeight, rowFadeOpacity,
} from '../../site/js/math.js';
import { firstWorldRow } from '../../site/js/rows.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// Applies a matrix3d(...) string to a local point and returns the projected point.
function applyMatrix3d(str, x, y) {
  const m = str.match(/^matrix3d\((.*)\)$/)[1].split(',').map(Number);
  assert.equal(m.length, 16);
  const X = m[0] * x + m[4] * y + m[12];
  const Y = m[1] * x + m[5] * y + m[13];
  const W = m[3] * x + m[7] * y + m[15];
  return { x: X / W, y: Y / W };
}

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

const noWarp = { halfW: 400, halfH: 300, bow: 0, cursor: { x: 0, y: 0 }, bulge: 0, bulgeWeight: 1, reach2: 1e4 };

test('wrapStaysInRange', () => {
  for (const v of [-1000, -250.5, -1, 0, 1, 99.9, 100, 101, 250, 1e4]) {
    const r = wrap(-50, 100, v);
    assert.ok(r >= -50 && r < 100, `wrap(-50,100,${v}) = ${r}`);
  }
  near(wrap(0, 10, 13), 3);
  near(wrap(0, 10, -3), 7);
  near(wrap(5, 15, 5), 5);
});

test('dampConvergesAndIsFrameRateIndependent', () => {
  const one = damp(0, 100, 0.1, 1 / 30);
  const two = damp(damp(0, 100, 0.1, 1 / 60), 100, 0.1, 1 / 60);
  near(one, two, 1e-9);
  let v = 0;
  for (let i = 0; i < 600; i++) v = damp(v, 100, 0.1, 1 / 60);
  near(v, 100, 1e-6);
  assert.equal(damp(5, 5, 0.1, 1 / 60), 5);
});

test('warpIsIdentityAtZeroBowAndBulge', () => {
  for (const [x, y] of [[0, 0], [120, -80], [-400, 300], [33.3, 250]]) {
    const p = warpPoint(x, y, noWarp);
    near(p.x, x);
    near(p.y, y);
  }
});

test('warpSpreadsRimByOnePlusBow', () => {
  const o = { ...noWarp, bow: 0.15 };
  const edge = warpPoint(o.halfW, 0, o);
  near(edge.x, o.halfW * 1.15);
  near(edge.y, 0);
  const corner = warpPoint(o.halfW, o.halfH, o);
  near(corner.x, o.halfW * 1.3);
  near(corner.y, o.halfH * 1.3);
  const centre = warpPoint(0, 0, o);
  near(centre.x, 0);
  near(centre.y, 0);
});

test('insetKeepsGapConstant', () => {
  const o = { ...noWarp, bow: 0.15 };
  const P = 100, gap = 10;
  const box = (x0, y0) => ({
    tl: warpPoint(x0, y0, o),
    tr: warpPoint(x0 + P, y0, o),
    bl: warpPoint(x0, y0 + P, o),
    br: warpPoint(x0 + P, y0 + P, o),
  });
  // Horizontal neighbours share the edge x = 100; vertical neighbours share y = 100.
  const a = insetQuad(box(0, 0), gap);
  const b = insetQuad(box(P, 0), gap);
  const below = insetQuad(box(0, P), gap);
  near(dist(a.tr, b.tl), gap, 0.1);
  near(dist(a.br, b.bl), gap, 0.1);
  near(dist(a.bl, below.tl), gap, 0.1);
  near(dist(a.br, below.tr), gap, 0.1);

  // Exact on an unwarped box: every corner moves gap/2 along both own edges.
  const flat = insetQuad({ tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, bl: { x: 0, y: 100 }, br: { x: 100, y: 100 } }, gap);
  near(flat.tl.x, 5); near(flat.tl.y, 5);
  near(flat.br.x, 95); near(flat.br.y, 95);
});

test('homographyMapsUnitRectToItself', () => {
  const w = 200;
  const q = { tl: { x: 0, y: 0 }, tr: { x: w, y: 0 }, bl: { x: 0, y: w }, br: { x: w, y: w } };
  const m = homography(w, q).match(/^matrix3d\((.*)\)$/)[1].split(',').map(Number);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  m.forEach((v, i) => near(v, identity[i]));

  const moved = { tl: { x: 30, y: 40 }, tr: { x: 30 + w, y: 40 }, bl: { x: 30, y: 40 + w }, br: { x: 30 + w, y: 40 + w } };
  const t = homography(w, moved).match(/^matrix3d\((.*)\)$/)[1].split(',').map(Number);
  near(t[12], 30); near(t[13], 40);
  near(t[0], 1); near(t[5], 1); near(t[3], 0); near(t[7], 0);
});

test('homographyMapsCornersOntoQuad', () => {
  const w = 160;
  const q = {
    tl: { x: 12, y: 8 }, tr: { x: 190, y: -14 },
    bl: { x: -6, y: 175 }, br: { x: 210, y: 150 },
  };
  const m = homography(w, q);
  for (const [lx, ly, key] of [[0, 0, 'tl'], [w, 0, 'tr'], [0, w, 'bl'], [w, w, 'br']]) {
    const p = applyMatrix3d(m, lx, ly);
    near(p.x, q[key].x, 1e-6);
    near(p.y, q[key].y, 1e-6);
  }
});

test('cardSizeIsTileWhenItFitsElseViewportOverColumns', () => {
  const g = { tile: 240, gap: 16, columns: 3 };
  assert.equal(cardSize(1440, g), 240);
  // Tile changes the card across its whole range on desktop.
  assert.equal(cardSize(1440, { ...g, tile: 120 }), 120);
  assert.equal(cardSize(1440, { ...g, tile: 300 }), 300);
  assert.equal(cardSize(1440, { ...g, tile: 480 }), Math.round(1440 / 3 - 16));
  // Without columnsCompact the phone falls back to columns.
  assert.equal(cardSize(390, g), Math.round(390 / 3 - 16));
  // Never collapses to nothing.
  assert.equal(cardSize(390, { ...g, columnsCompact: 10 }), 40);
  assert.equal(cardSize(10, g), 40);
});

test('cardSizeUsesColumnsCompactUpToTheBreakpointAndColumnsAbove', () => {
  const g = { tile: 400, gap: 16, columns: 4, columnsCompact: 2 };
  assert.equal(COMPACT_MAX_WIDTH, 600);
  // A 390px phone: two across, 390 / 2 - 16.
  assert.equal(cardSize(390, g), 179);
  assert.equal(cardSize(320, g), 144);
  // Boundary: 600 is still a phone, 601 uses the desktop column count.
  assert.equal(cardSize(600, g), 284);
  assert.equal(cardSize(601, g), Math.round(601 / 4 - 16));
  // Unchanged above the breakpoint, and tile still caps it.
  assert.equal(cardSize(800, g), 184);
  assert.equal(cardSize(1440, g), 344);
  assert.equal(cardSize(1920, g), 400);
  assert.equal(cardSize(1440, { ...g, columnsCompact: 1 }), 344, 'compact count is ignored on desktop');
  // columnsCompact clamps the card between the full width and the sanity minimum.
  assert.equal(cardSize(390, { ...g, columnsCompact: 1 }), 374);
  assert.equal(cardSize(390, { ...g, columnsCompact: 4 }), 82);
  const sizes = [1, 2, 3, 4].map((columnsCompact) => cardSize(390, { ...g, columnsCompact }));
  assert.equal(new Set(sizes).size, sizes.length);
  // Every columns value on desktop gives a different card.
  const d = [2, 3, 4, 5, 6].map((columns) => cardSize(1440, { ...g, tile: 480, columns }));
  assert.equal(new Set(d).size, d.length);
  assert.equal(cardSize(1440, { ...g, columns: 100 }), 40);
});

test('homographyMapsANonSquareCardOntoQuad', () => {
  const w = 300, h = 120;
  // Identity for a w x h rect onto itself.
  const rect = { tl: { x: 0, y: 0 }, tr: { x: w, y: 0 }, bl: { x: 0, y: h }, br: { x: w, y: h } };
  const id = homography(w, rect, h).match(/^matrix3d\((.*)\)$/)[1].split(',').map(Number);
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((v, i) => near(id[i], v));
  const q = {
    tl: { x: 12, y: 8 }, tr: { x: 330, y: -14 },
    bl: { x: -6, y: 135 }, br: { x: 350, y: 150 },
  };
  const m = homography(w, q, h);
  for (const [lx, ly, key] of [[0, 0, 'tl'], [w, 0, 'tr'], [0, h, 'bl'], [w, h, 'br']]) {
    const p = applyMatrix3d(m, lx, ly);
    near(p.x, q[key].x, 1e-6);
    near(p.y, q[key].y, 1e-6);
  }
});

test('insetQuadUsesASeparateVerticalGap', () => {
  const flat = { tl: { x: 0, y: 0 }, tr: { x: 200, y: 0 }, bl: { x: 0, y: 100 }, br: { x: 200, y: 100 } };
  const q = insetQuad(flat, 10, 30);
  near(q.tl.x, 5); near(q.tl.y, 15);
  near(q.tr.x, 195); near(q.tr.y, 15);
  near(q.bl.x, 5); near(q.bl.y, 85);
  near(q.br.x, 195); near(q.br.y, 85);
  // gapY defaults to gap.
  assert.deepEqual(insetQuad(flat, 10), insetQuad(flat, 10, 10));
});

const ringWidth = (ring, widths, gap) => ring.reduce((s, i) => s + widths[i] + gap, 0);
const noAdjacentRepeat = (ring) => ring.every((v, k) => v !== ring[(k + 1) % ring.length]);

test('buildRingIsDeterministic', () => {
  const args = { count: 8, widths: [100, 200, 150, 90, 300, 120, 100, 240], row: 3, seed: 7, minWidth: 4000, gap: 4 };
  assert.deepEqual(buildRing(args), buildRing({ ...args }));
});

test('buildRingUsesAllItemsWhenTwelveOrFewer', () => {
  for (let count = 2; count <= 12; count++) {
    const widths = Array.from({ length: count }, (_, i) => 100 + i * 10);
    const ring = buildRing({ count, widths, row: 1, seed: 1, minWidth: 0, gap: 4 });
    assert.equal(ring.length, count);
    assert.deepEqual([...ring].sort((a, b) => a - b), [...Array(count).keys()]);
  }
});

test('buildRingCapsDistinctItemsAtTwelveAndVariesTheSubsetByRow', () => {
  const count = 40;
  const widths = new Array(count).fill(100);
  const subsets = new Set();
  for (let row = 0; row < 6; row++) {
    const ring = buildRing({ count, widths, row, seed: 1, minWidth: 5000, gap: 4 });
    const distinct = new Set(ring);
    assert.equal(distinct.size, 12, `row ${row}`);
    for (const i of distinct) assert.ok(i >= 0 && i < count);
    subsets.add([...distinct].sort((a, b) => a - b).join());
  }
  assert.ok(subsets.size > 1, 'rows use different subsets');
});

test('buildRingRepeatsUntilWideEnoughWithoutAdjacentRepeats', () => {
  for (let count = 2; count <= 15; count++) {
    for (let row = 0; row < 8; row++) {
      const widths = Array.from({ length: count }, (_, i) => 60 + ((i * 37) % 200));
      const minWidth = 3000;
      const ring = buildRing({ count, widths, row, seed: 5, minWidth, gap: 4 });
      assert.ok(ringWidth(ring, widths, 4) >= minWidth, `count ${count} row ${row} too narrow`);
      assert.ok(noAdjacentRepeat(ring), `count ${count} row ${row}: ${ring}`);
    }
  }
});

test('buildRingHandlesZeroAndOneItem', () => {
  assert.deepEqual(buildRing({ count: 0, widths: [], row: 0, seed: 1, minWidth: 1000, gap: 4 }), []);
  const one = buildRing({ count: 1, widths: [100], row: 2, seed: 1, minWidth: 1000, gap: 4 });
  assert.ok(one.length >= 10);
  assert.ok(one.every((i) => i === 0));
  assert.ok(ringWidth(one, [100], 4) >= 1000);
  // Zero-width items never loop forever.
  assert.deepEqual(buildRing({ count: 1, widths: [0], row: 0, seed: 1, minWidth: 1000, gap: 0 }), [0]);
});

test('buildRingGivesDifferentRowsDifferentOrders', () => {
  const widths = new Array(8).fill(100);
  const orders = new Set();
  for (let row = 0; row < 6; row++) orders.add(buildRing({ count: 8, widths, row, seed: 1, minWidth: 0, gap: 4 }).join());
  assert.ok(orders.size > 1);
  // The seed reshuffles.
  assert.notDeepEqual(
    [0, 1, 2, 3].map((row) => buildRing({ count: 8, widths, row, seed: 1 }).join()),
    [0, 1, 2, 3].map((row) => buildRing({ count: 8, widths, row, seed: 2 }).join()),
  );
});

test('buildRingCopesWithExtremeWidths', () => {
  const widths = [500, 50]; // a 5:1 and a 1:2 tile at height 100
  for (let row = 0; row < 6; row++) {
    const ring = buildRing({ count: 2, widths, row, seed: 1, minWidth: 2600, gap: 4 });
    assert.ok(ringWidth(ring, widths, 4) >= 2600);
    assert.ok(noAdjacentRepeat(ring), String(ring));
    assert.ok(ring.includes(0) && ring.includes(1));
  }
});

test('hash01IsUniformInUnitIntervalAndSeeded', () => {
  const vals = Array.from({ length: 200 }, (_, r) => hash01(r, 1));
  assert.ok(vals.every((v) => v >= 0 && v < 1));
  assert.equal(hash01(5, 3), hash01(5, 3));
  assert.notEqual(hash01(5, 3), hash01(5, 4));
  assert.notEqual(hash01(5, 3, 0), hash01(5, 3, 1));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  assert.ok(mean > 0.35 && mean < 0.65, `mean ${mean}`);
});

test('aspectForClampsNativeAndIsOneWhenSquare', () => {
  const g = { aspectMode: 'native', aspectMin: 0.5, aspectMax: 2.4 };
  near(aspectFor({ width: 1920, height: 1080 }, g), 1920 / 1080);
  assert.equal(aspectFor({ width: 5000, height: 1000 }, g), 2.4);
  assert.equal(aspectFor({ width: 100, height: 1000 }, g), 0.5);
  assert.equal(aspectFor({ width: 480, height: 480 }, g), 1);
  assert.equal(aspectFor({}, g), 1, 'missing size falls back to square');
  assert.equal(aspectFor({ width: 0, height: 10 }, g), 1);
  assert.equal(aspectFor(null, g), 1);
  assert.equal(aspectFor({ width: 1920, height: 1080 }, { ...g, aspectMode: 'square' }), 1);
});

test('rowShiftFactorFollowsTheMode', () => {
  assert.deepEqual([0, 1, 2, 3, -1].map((r) => rowShiftFactor('alternate', r, 1)), [0, 1, 0, 1, 1]);
  assert.deepEqual([0, 1, 2, 5].map((r) => rowShiftFactor('step', r, 1)), [0, 1, 2, 5]);
  for (let r = 0; r < 20; r++) {
    const f = rowShiftFactor('random', r, 1);
    assert.ok(f >= 0 && f < 1);
    assert.equal(f, rowShiftFactor('random', r, 1));
  }
  assert.equal(rowShiftFactor('bogus', 3, 1), 0);
});

test('rowSpeedScaleStaysWithinRowSpeedAndIsOneAtZero', () => {
  const scales = [];
  for (let r = 0; r < 30; r++) {
    assert.equal(rowSpeedScale(r, 1, 0), 1);
    const s = rowSpeedScale(r, 1, 0.3);
    assert.ok(s >= 0.7 && s <= 1.3, `row ${r}: ${s}`);
    scales.push(s);
  }
  assert.ok(new Set(scales).size > 1, 'rows differ');
});



// The R alive world rows at one pan, top to bottom (rows.js firstWorldRow).
const placed = (R, py, panY) => {
  const first = firstWorldRow(panY, py, R);
  return Array.from({ length: R }, (_, i) => ({ world: first + i, top: (first + i) * py - panY }));
};

test('aliveWorldRowsAreConsecutiveAndInsideTheWindowAtAnyPan', () => {
  const py = 324;
  for (const R of [5, 6, 11]) {
    for (const panY of [0, 77, -1234.5, 5000, py * R * 3 + 10, -py * R * 7 - 3, 1e6 + 3, -1e6 - 17]) {
      const rows = placed(R, py, panY);
      rows.forEach((r) => {
        assert.ok(r.top >= -R * py / 2 && r.top < R * py / 2, `top in window R ${R} pan ${panY}`);
        assert.ok(Number.isInteger(r.world));
        near(r.world * py - panY, r.top, 1e-6 * Math.max(1, Math.abs(panY)));
      });
      for (let k = 1; k < rows.length; k++) {
        assert.equal(rows[k].world, rows[k - 1].world + 1, `R ${R} pan ${panY}: consecutive world rows`);
      }
    }
  }
});

test('shiftModesFollowWorldRowsAcrossTheWrap', () => {
  const py = 100;
  for (const R of [5, 6, 11]) {
    // Pan through several wraps; at every step consecutive rows keep the pattern.
    for (let panY = -3000; panY <= 3000; panY += 37) {
      const rows = placed(R, py, panY);
      for (let k = 1; k < rows.length; k++) {
        const a = rows[k - 1].world, b = rows[k].world;
        assert.notEqual(rowShiftFactor('alternate', a, 1), rowShiftFactor('alternate', b, 1), `alternate R ${R} pan ${panY}`);
        assert.ok(rowShiftFactor('step', b, 1) > rowShiftFactor('step', a, 1), `step R ${R} pan ${panY}`);
      }
    }
  }
  // Random is a fixed value per world row and seed, negative rows included.
  for (const w of [-40, -3, 0, 7, 1000]) {
    assert.equal(rowShiftFactor('random', w, 4), rowShiftFactor('random', w, 4));
    const f = rowShiftFactor('random', w, 4);
    assert.ok(f >= 0 && f < 1);
  }
  assert.deepEqual([-3, -2, -1].map((w) => rowShiftFactor('alternate', w, 1)), [1, 0, 1]);
});

test('velocityBowIsRestingAtZeroLagOrZeroGain', () => {
  assert.equal(velocityBow(0.01, 0.4, 0), 0.01);
  assert.equal(velocityBow(0.01, 0, 1), 0.01);
  assert.equal(velocityBow(0.01, 0, 0.7), 0.01);
  // Zero lag drives the signal to exactly zero.
  assert.equal(stepSpeed(0, 0, 320, 0.12, 1 / 60), 0);
});

test('velocityBowIsMonotoneInSpeedAndClampedAtFullSpeed', () => {
  let prev = -Infinity;
  for (const s of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
    const b = velocityBow(0.01, 0.4, s);
    assert.ok(b > prev);
    prev = b;
  }
  near(velocityBow(0.01, 0.4, 1), 0.41);
  assert.equal(velocityBow(0.01, 0.4, 5), velocityBow(0.01, 0.4, 1));
  // The signal target is lag / ref, clamped to [0, 1].
  const settled = (lag) => { let v = 0; for (let i = 0; i < 2000; i++) v = stepSpeed(v, lag, 320, 0.12, 1 / 60); return v; };
  near(settled(160), 0.5, 1e-3);
  assert.equal(settled(320), 1);
  assert.equal(settled(5000), 1);
  assert.ok(settled(80) < settled(160));
  assert.equal(stepSpeed(0.5, 100, 0, 0.12, 1 / 60) <= 0.5, true, 'no reference: no speed');
});

test('velocityBowIsCappedAtTheSliderMaximum', () => {
  assert.equal(MAX_EFFECTIVE_BOW, 0.5);
  assert.equal(velocityBow(0.5, 0.6, 1), 0.5);
  assert.equal(velocityBow(0.3, 0.6, 1), 0.5);
  near(velocityBow(0.1, 0.3, 1), 0.4);
  // A stored resting bow above the cap is not raised by speed.
  assert.equal(velocityBow(0.8, 0.6, 1), 0.8);
  assert.equal(velocityBow(0.8, 0, 0), 0.8);
});

test('speedReferenceIsHalfTheShortSideWithAFloor', () => {
  assert.equal(speedReference(1440, 900), 450);
  assert.equal(speedReference(390, 844), 195);
  assert.equal(speedReference(10, 10), 120);
  assert.equal(speedReference(0, 0), 120);
  assert.equal(speedReference(NaN, 900), 120);
});

test('speedSmoothingConvergesAndIsFrameRateIndependent', () => {
  const one = stepSpeed(0, 200, 320, 0.12, 1 / 30);
  const two = stepSpeed(stepSpeed(0, 200, 320, 0.12, 1 / 60), 200, 320, 0.12, 1 / 60);
  near(one, two, 1e-9);
  // Decays to exactly zero (so the grid can go quiet), faster with a higher rate.
  let slow = 1, fast = 1, nSlow = 0, nFast = 0;
  while (slow !== 0 && nSlow < 10000) { slow = stepSpeed(slow, 0, 320, 0.05, 1 / 60); nSlow++; }
  while (fast !== 0 && nFast < 10000) { fast = stepSpeed(fast, 0, 320, 0.3, 1 / 60); nFast++; }
  assert.equal(slow, 0);
  assert.equal(fast, 0);
  assert.ok(nFast < nSlow);
});

// Row fade ------------------------------------------------------------------

const zone = (top, bottom, strength = 1) => ({ top, bottom, strength });

test('rowFadeWeight is the share of the tile inside the zone', () => {
  const z = [zone(100, 200)];
  assert.equal(rowFadeWeight(120, 180, z, 40), 1); // fully inside
  assert.equal(rowFadeWeight(100, 200, z, 40), 1); // exactly the zone
  assert.equal(rowFadeWeight(50, 300, z, 0), 100 / 250); // tile covers the zone: zone share of the tile
  assert.equal(rowFadeWeight(150, 250, z, 0), 0.5); // half overlapping, hard band
  assert.equal(rowFadeWeight(180, 280, z, 0), 0.2);
  assert.equal(rowFadeWeight(200, 300, z, 0), 0); // touching is not overlap
  assert.equal(rowFadeWeight(0, 100, z, 0), 0);
  assert.equal(rowFadeWeight(200.5, 300, z, 0), 0);
  assert.equal(rowFadeWeight(-100, 99, z, 0), 0);
});

test('rowFadeWeight with a spread is feathered but about the overlap fraction', () => {
  const z = [zone(100, 200)];
  // Half overlapping a 400 px tile (the default size): half from the band plus a small feather share.
  const half = rowFadeWeight(200, 600, [zone(0, 400)], 40);
  assert.ok(half > 0.5 && half < 0.6, `${half}`);
  // A tile just touching still picks up a little feather; clear by the spread weighs exactly 0.
  const touch = rowFadeWeight(200, 300, z, 40);
  assert.ok(touch > 0 && touch < 0.25, `${touch}`);
  assert.equal(rowFadeWeight(240, 340, z, 40), 0);
  assert.equal(rowFadeWeight(300, 400, z, 40), 0);
  assert.equal(rowFadeWeight(-100, 60, z, 40), 0);
  assert.equal(rowFadeWeight(-140, -40, z, 40), 0);
});

test('rowFadeWeight is continuous and monotone as a tile moves away from the zone', () => {
  const z = [zone(100, 200)];
  for (const spread of [0, 40, 120]) {
    let prev = 1;
    for (let d = -50; d <= 300; d += 2.5) { // from the tile exactly on the zone (weight 1) to far below
      const below = rowFadeWeight(150 + d, 250 + d, z, spread); // moving down
      const above = rowFadeWeight(50 - d, 150 - d, z, spread); // mirror image, moving up
      near(below, above);
      assert.ok(below <= prev + 1e-12, `spread ${spread}: not monotone at ${d}`);
      assert.ok(Math.abs(prev - below) < 0.12, `spread ${spread}: jump at ${d}`);
      prev = below;
    }
  }
});

test('rowFadeWeight matches a brute-force integral of the coverage profile', () => {
  const z = [zone(100, 200)];
  const S = (t) => t * t * (3 - 2 * t);
  const c = (y, s) => (y >= 100 && y <= 200 ? 1 : y < 100 ? Math.max(0, 1 - S(Math.min(1, (100 - y) / s))) : Math.max(0, 1 - S(Math.min(1, (y - 200) / s))));
  for (const [y0, y1, s] of [[150, 250, 40], [210, 310, 60], [60, 160, 30], [0, 400, 80], [195, 205, 50]]) {
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += c(y0 + ((i + 0.5) / n) * (y1 - y0), s);
    near(rowFadeWeight(y0, y1, z, s), sum / n, 1e-4);
  }
});

test('rowFadeWeight scales by strength and takes the max over zones', () => {
  assert.equal(rowFadeWeight(150, 160, [zone(100, 200, 0.4)], 40), 0.4);
  near(rowFadeWeight(150, 250, [zone(100, 200, 0.5)], 0), 0.25);
  const two = [zone(100, 200, 0.3), zone(400, 500, 1)];
  assert.equal(rowFadeWeight(150, 160, two, 40), 0.3); // inside the weak zone, far from the strong one
  assert.equal(rowFadeWeight(420, 430, two, 40), 1);
  assert.equal(rowFadeWeight(150, 450, two, 0), Math.max(0.3 * 50 / 300, 50 / 300)); // spans parts of both: the larger share wins
  assert.equal(rowFadeWeight(450, 550, two, 0), 0.5);
});

test('rowFadeWeight ignores zero-strength zones and degenerate input', () => {
  assert.equal(rowFadeWeight(150, 160, [zone(100, 200, 0)], 40), 0);
  assert.equal(rowFadeWeight(150, 160, [], 40), 0);
  assert.equal(rowFadeWeight(150, 160, null, 40), 0);
  assert.equal(rowFadeWeight(NaN, 160, [zone(100, 200)], 40), 0);
  assert.equal(rowFadeWeight(150, Infinity, [zone(100, 200)], 40), 0);
  assert.equal(rowFadeWeight(150, 160, [zone(NaN, 200)], 40), 0);
  assert.equal(rowFadeWeight(150, 160, [zone(100, 200, NaN)], 40), 0);
  assert.equal(rowFadeWeight(150, 160, [zone(100, 200, 7)], 40), 1); // strength clamped to 1
  assert.equal(rowFadeWeight(180, 120, [zone(100, 200)], 40), 1); // reversed extent is swapped
  assert.equal(rowFadeWeight(150, 160, [zone(200, 100)], 40), 1); // reversed zone is swapped
  assert.equal(rowFadeWeight(200.5, 300, [zone(100, 200)], -50), 0); // negative spread acts as 0
  assert.equal(rowFadeWeight(200.5, 300, [zone(100, 200)], NaN), 0);
  assert.equal(rowFadeWeight(150, 150, [zone(100, 200)], 40), 1); // zero-height tile: the profile at its point
  assert.equal(rowFadeWeight(250, 250, [zone(100, 200)], 40), 0);
});

test('rowFadeOpacity maps weight 0 to 1 and weight 1 to rowOpacity, linearly, clamped', () => {
  assert.equal(rowFadeOpacity(0, 0.25), 1);
  assert.equal(rowFadeOpacity(1, 0.25), 0.25);
  near(rowFadeOpacity(0.5, 0.25), 0.625);
  assert.equal(rowFadeOpacity(1, 0), 0);
  assert.equal(rowFadeOpacity(1, 1), 1);
  assert.equal(rowFadeOpacity(2, 0.25), 0.25);
  assert.equal(rowFadeOpacity(-1, 0.25), 1);
  assert.equal(rowFadeOpacity(NaN, 0.25), 1);
  assert.equal(rowFadeOpacity(1, NaN), 1);
});

test('idleDirection: same is always +1, alternate flips odd world rows (negatives too), random is seeded +-1', async () => {
  const { idleDirection } = await import('../../site/js/math.js');
  for (const r of [-3, 0, 5]) assert.equal(idleDirection('same', r, 1), 1);
  assert.deepEqual([-2, -1, 0, 1, 2].map((r) => idleDirection('alternate', r, 1)), [1, -1, 1, -1, 1]);
  const dirs = Array.from({ length: 40 }, (_, r) => idleDirection('random', r, 7));
  assert.ok(dirs.every((d) => d === 1 || d === -1) && dirs.includes(1) && dirs.includes(-1));
  assert.deepEqual(dirs, Array.from({ length: 40 }, (_, r) => idleDirection('random', r, 7)));
});

test('coastVelocity decays per 60fps frame, is frame-rate independent, and snaps to 0', async () => {
  const { coastVelocity } = await import('../../site/js/math.js');
  assert.ok(Math.abs(coastVelocity(1000, 0.95, 1 / 60) - 950) < 1e-6);
  const two = coastVelocity(coastVelocity(1000, 0.9, 1 / 120), 0.9, 1 / 120);
  assert.ok(Math.abs(two - coastVelocity(1000, 0.9, 1 / 60)) < 1e-6);
  assert.equal(coastVelocity(5.2, 0.9, 1 / 60), 0);
  assert.equal(coastVelocity(-4, 0.99, 1 / 60), 0);
  assert.ok(coastVelocity(-1000, 0.95, 1 / 60) < 0);
});

test('governFrame: stays full on a steady 120 Hz, locks to 60 when 120 cannot hold, cuts quality when under ~42 fps', async () => {
  const { newGovernor, governFrame } = await import('../../site/js/math.js');
  const steady = newGovernor();
  for (let i = 0; i < 600; i++) governFrame(steady, 8.3);
  assert.equal(steady.halfRate, false);
  assert.equal(steady.lowQuality, false);
  const dipping = newGovernor();
  for (let i = 0; i < 40; i++) governFrame(dipping, 8.3); // the display proves it can do 120
  for (let i = 0; i < 300; i++) governFrame(dipping, 13.5); // then sustained ~74 fps
  assert.equal(dipping.halfRate, true);
  assert.equal(dipping.lowQuality, false);
  const plain60 = newGovernor();
  for (let i = 0; i < 600; i++) governFrame(plain60, 16.7);
  assert.equal(plain60.halfRate, false, 'a 60 Hz display is never locked down');
  const slow = newGovernor();
  for (let i = 0; i < 400; i++) governFrame(slow, 40);
  assert.equal(slow.lowQuality, true);
  const gap = newGovernor();
  for (let i = 0; i < 400; i++) governFrame(gap, 3000);
  assert.equal(gap.lowQuality, false, 'a long gap is not a slow frame');
});

test('buildRingMinPassesGivesAtLeastThatManyPassesAndKeepsTheFirstPassStable', () => {
  const widths = [100, 150, 120, 90];
  const one = buildRing({ count: 4, widths, row: 3, seed: 1, minWidth: 0, gap: 4 });
  const two = buildRing({ count: 4, widths, row: 3, seed: 1, minWidth: 0, gap: 4, minPasses: 2 });
  const three = buildRing({ count: 4, widths, row: 3, seed: 1, minWidth: 0, gap: 4, minPasses: 3 });
  assert.equal(one.length, 4);
  assert.equal(two.length, 8);
  assert.equal(three.length, 12);
  assert.deepEqual(two.slice(0, 4), one, 'the first pass is the same shuffle');
  // The width requirement still wins when it needs more passes than minPasses.
  const wide = buildRing({ count: 4, widths, row: 3, seed: 1, minWidth: 5000, gap: 4, minPasses: 2 });
  assert.ok(wide.length > 8);
  // Same arguments, same ring.
  assert.deepEqual(two, buildRing({ count: 4, widths, row: 3, seed: 1, minWidth: 0, gap: 4, minPasses: 2 }));
});
