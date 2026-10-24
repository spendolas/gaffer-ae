// The grid's row model, pure (no DOM), so a resize can be tested without a browser.
//
// A row is identified by its WORLD index w, an integer on the infinite vertical axis: row w sits at
// y = w * py - panY (stage-centre origin, py = H + rowGap). The rows the grid keeps alive at any pan are
// the R consecutive world rows whose y falls in the centred window [-R*py/2, R*py/2), with
// R = ceil(vh / py) + 2 (the +2 is the rim slack: a row is created and destroyed a whole row beyond the
// viewport, so it never pops in view). Because a row's content depends only on w (never on a slot
// number or on R), a resize that changes R adds or removes rows only at the two edges; every row that
// stays keeps its clips and its place.
//
// Horizontally a row is a ring of tiles with a fixed MIN_PASSES shuffled passes (buildRing), so its
// tile order does not depend on the viewport width either, until a screen needs more than that.

import { buildRing, aspectFor, cardSize } from './math.js';

export const MIN_PASSES = 2;

// Everything the grid derives from the stage size and the grid config.
export function gridMetrics(vw, vh, cfg, items) {
  const H = cardSize(vw, cfg);
  const py = H + cfg.rowGap;
  const R = Math.ceil(vh / py) + 2;
  const widths = items.map((it) => Math.max(1, Math.round(H * aspectFor(it, cfg))));
  const maxP = (widths.length ? Math.max(...widths) : H) + cfg.gap;
  return { H, py, R, widths, maxP, minWidth: vw + 2 * maxP, gap: cfg.gap };
}

// The first (smallest) world row alive at vertical pan panY; rows first .. first + R - 1 are alive.
export function firstWorldRow(panY, py, R) {
  return Math.ceil((panY - (R * py) / 2) / py);
}

// One row: its ring (item indices), each tile's x offset along the ring, the ring's width W and the
// average tile width. Deterministic for (world, items, widths, seed): the order never depends on vw.
export function rowModel(world, m, count, seed) {
  const ring = buildRing({
    count, widths: m.widths, row: world, seed, minWidth: m.minWidth, gap: m.gap, minPasses: MIN_PASSES,
  });
  const xs = [];
  const ws = [];
  let W = 0;
  let sum = 0;
  for (const idx of ring) {
    xs.push(W);
    ws.push(m.widths[idx]);
    W += m.widths[idx] + m.gap;
    sum += m.widths[idx];
  }
  return { world, ring, xs, ws, W, avgW: ring.length ? sum / ring.length : 0 };
}

// The pan keeps its place within the repeat across a re-tile: it scales by the change of the horizontal
// pitch (H + gap) and of the row pitch. Returns the scale factors.
export function panScale(from, to) {
  return { kx: to.px / from.px, ky: to.py / from.py };
}

// Left edge of the horizontal wrap window. Anchored to the viewport (not to the ring width), so a ring
// that gains a pass on a resize keeps every visible tile exactly where it was: the window always
// starts one widest tile left of the viewport and is at least a viewport plus two widest tiles long.
export function windowLeft(halfW, maxP) {
  return -(halfW + maxP);
}
