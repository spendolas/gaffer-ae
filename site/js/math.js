// Pure grid math and the row rings. No DOM, no dependencies.
// Point = {x, y}; Quad = {tl, tr, bl, br} of Points.

// Wraps v into [min, max), correct for negatives.
export function wrap(min, max, v) {
  const r = max - min;
  return min + ((((v - min) % r) + r) % r);
}

// Frame-rate-independent damping toward a target.
export function damp(from, to, rate, dt) {
  return from + (to - from) * (1 - (1 - rate) ** (dt * 60));
}

// Pincushion bow plus a gaussian shove away from the cursor.
export function warpPoint(px, py, o) {
  const nx = px / o.halfW;
  const ny = py / o.halfH;
  const f = 1 + o.bow * (nx * nx + ny * ny);
  const wx = px * f;
  const wy = py * f;
  const dx = wx - o.cursor.x;
  const dy = wy - o.cursor.y;
  const push = o.bulge * o.bulgeWeight * Math.exp(-(dx * dx + dy * dy) / o.reach2);
  return { x: wx + dx * push, y: wy + dy * push };
}

// Offset vector of length `d` along the unit direction from p toward `to`.
function along(p, to, d) {
  const len = Math.hypot(to.x - p.x, to.y - p.y);
  if (!len) return { x: 0, y: 0 };
  return { x: ((to.x - p.x) / len) * d, y: ((to.y - p.y) / len) * d };
}

// Each corner moves gap/2 along its horizontal edge and gapY/2 along its
// vertical edge, so two neighbours that share a lattice point end up gap
// apart side by side and gapY apart one above the other.
export function insetQuad(q, gap, gapY = gap) {
  const hx = gap / 2;
  const hy = gapY / 2;
  // a: the corner's horizontal neighbour, b: its vertical neighbour.
  const corner = (p, a, b) => {
    const da = along(p, a, hx);
    const db = along(p, b, hy);
    return { x: p.x + da.x + db.x, y: p.y + da.y + db.y };
  };
  return {
    tl: corner(q.tl, q.tr, q.bl),
    tr: corner(q.tr, q.tl, q.br),
    bl: corner(q.bl, q.br, q.tl),
    br: corner(q.br, q.bl, q.tr),
  };
}

// Rect (0,0)-(w,ht) to quad homography as a matrix3d string.
// Unit-square solution pre-scaled by w across and ht down; translation carried
// in the matrix (use transform-origin: top left).
export function homography(w, q, ht = w) {
  const q0 = q.tl, q1 = q.tr, q2 = q.bl, q3 = q.br;
  const dx1 = q1.x - q3.x, dy1 = q1.y - q3.y;
  const dx2 = q2.x - q3.x, dy2 = q2.y - q3.y;
  const sx = q0.x - q1.x - q2.x + q3.x;
  const sy = q0.y - q1.y - q2.y + q3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = den ? (sx * dy2 - dx2 * sy) / den : 0;
  const h = den ? (dx1 * sy - sx * dy1) / den : 0;
  const a = q1.x - q0.x + g * q1.x, b = q2.x - q0.x + h * q2.x;
  const d = q1.y - q0.y + g * q1.y, e = q2.y - q0.y + h * q2.y;
  return `matrix3d(${a / w}, ${d / w}, 0, ${g / w}, ${b / ht}, ${e / ht}, 0, ${h / ht}, 0, 0, 1, 0, ${q0.x}, ${q0.y}, 0, 1)`;
}

// Velocity bow. The speed signal is the pan lag (px between the pan target
// and the damped pan, both axes) over a reference length `ref` (px that count
// as full speed), clamped to [0, 1], then damped at `rate` and snapped once
// within eps of its target, so it decays to exactly 0.
export function stepSpeed(signal, lag, ref, rate, dt, eps = 0.001) {
  const target = ref > 0 ? Math.min(1, Math.max(0, lag / ref)) : 0;
  const v = damp(signal, target, rate, dt);
  return Math.abs(target - v) < eps ? target : v;
}

// Speed reference in px: half the viewport's short side, so the feel does not
// depend on the tile or columns settings. Never below MIN_SPEED_REF, so it is
// never 0 or NaN.
const MIN_SPEED_REF = 120;
export function speedReference(viewportWidth, viewportHeight) {
  const ref = 0.5 * Math.min(viewportWidth, viewportHeight);
  return Number.isFinite(ref) ? Math.max(MIN_SPEED_REF, ref) : MIN_SPEED_REF;
}

// Largest effective dome bow. Above it, straight-edge seams between shifted rows show.
export const MAX_EFFECTIVE_BOW = 0.5;

// Effective dome bow: the resting bow plus `gain` at full speed, capped at
// MAX_EFFECTIVE_BOW. A resting bow already above the cap is never raised nor
// lowered.
export function velocityBow(bow, gain, signal) {
  const raw = bow + gain * Math.min(1, Math.max(0, signal));
  return Math.min(raw, Math.max(bow, MAX_EFFECTIVE_BOW));
}

// Widest viewport (px) that counts as a phone: grid.columnsCompact applies up to
// and including it. Keep in step with the compact dock breakpoint,
// `@media (max-width: 600px)` in site/css/site.css.
export const COMPACT_MAX_WIDTH = 600;

// Card edge in px: grid.tile when the viewport fits at least that many columns of
// them, otherwise viewportWidth / columns - gap (so the column count is the
// minimum number across). The count is grid.columnsCompact on phones (width <=
// COMPACT_MAX_WIDTH) and grid.columns above. Never below MIN_CARD.
const MIN_CARD = 40;
export function cardSize(viewportWidth, { tile, gap, columns, columnsCompact = columns }) {
  const across = viewportWidth <= COMPACT_MAX_WIDTH ? columnsCompact : columns;
  return Math.round(Math.max(MIN_CARD, Math.min(tile, viewportWidth / across - gap)));
}

// Seeded integer hash of three integers, uniform in [0, 2^32).
function hash(a, b, seed) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// Seeded value in [0, 1) for a row; salt keeps independent uses uncorrelated.
export function hash01(row, seed, salt = 0) {
  return hash(row, salt, seed) / 4294967296;
}

// Small seeded PRNG (mulberry32), values in [0, 1).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const noRepeats = (ring) => ring.every((v, k) => v !== ring[(k + 1) % ring.length]);

// Tile aspect (width / height) of an item: its own shape clamped to
// [aspectMin, aspectMax] in 'native' mode, 1 in 'square' mode or when the
// item has no usable size.
export function aspectFor(item, { aspectMode, aspectMin, aspectMax }) {
  if (aspectMode !== 'native' || !item || !(item.width > 0 && item.height > 0)) return 1;
  return Math.min(aspectMax, Math.max(aspectMin, item.width / item.height));
}

// The ring of one row slot: an array of item indices, laid left to right and
// repeating forever (the row's horizontal period). widths[i] is item i's tile
// width; each tile also takes one gap.
//  - The row's own seeded shuffle of all items; more than maxDistinct items
//    keeps only the first maxDistinct (so each row shows a different subset).
//  - Further shuffled passes of that subset are appended until the ring is at
//    least minWidth wide.
//  - The same item never sits next to itself, across the seam included, when
//    the subset has two or more items (best effort; always holds for 2 or 3+).
// count 0 gives [], one item repeats. Deterministic for its arguments.
export function buildRing({ count, widths, row, seed, minWidth = 0, gap = 0, maxDistinct = 12, minPasses = 1 }) {
  if (!(count > 0)) return [];
  const rand = rng(hash(row, 0x51ed, seed));
  const subset = shuffle([...Array(count).keys()], rand).slice(0, Math.min(count, maxDistinct));
  const passWidth = subset.reduce((s, i) => s + widths[i] + gap, 0);
  const ring = [...subset];
  if (!(passWidth > 0)) return ring;
  let total = passWidth;
  let passes = 1;
  while (total < minWidth || passes < minPasses) {
    passes++;
    const pass = shuffle([...subset], rand);
    // A pass holds distinct items, so swapping its first two fixes the join.
    if (pass.length > 1 && pass[0] === ring[ring.length - 1]) [pass[0], pass[1]] = [pass[1], pass[0]];
    ring.push(...pass);
    total += passWidth;
  }
  const n = ring.length;
  if (subset.length > 1 && ring[n - 1] === ring[0]) {
    // Seam: swap the last tile with an earlier one that keeps every join clean.
    for (let i = n - 2; i > 0; i--) {
      [ring[i], ring[n - 1]] = [ring[n - 1], ring[i]];
      if (noRepeats(ring)) break;
      [ring[i], ring[n - 1]] = [ring[n - 1], ring[i]];
    }
  }
  return ring;
}

// How many rowShift steps a row is offset by, from its WORLD row index (so the
// pattern survives the vertical wrap): 'alternate' 0 or 1 for even or odd rows,
// 'step' the row index itself, 'random' a seeded value in [0, 1).
export function rowShiftFactor(mode, row, seed) {
  if (mode === 'alternate') return ((row % 2) + 2) % 2;
  if (mode === 'step') return row;
  if (mode === 'random') return hash01(row, seed, 2);
  return 0;
}

// Idle drift direction, +1 or -1, from the WORLD row (like rowShiftFactor, so it is stable across the
// vertical wrap): 'same' every row +1, 'alternate' odd rows reversed, 'random' seeded per row.
export function idleDirection(mode, row, seed) {
  if (mode === 'alternate') return ((row % 2) + 2) % 2 ? -1 : 1;
  if (mode === 'random') return hash01(row, seed, 4) < 0.5 ? -1 : 1;
  return 1;
}

// Coast after a drag release: the fling velocity (px/s) decays by `friction` per frame at 60fps
// (frame-rate independent), and snaps to exactly 0 below MIN_COAST px/s so the grid comes to rest.
const MIN_COAST = 5;
export function coastVelocity(v, friction, dt) {
  const next = v * friction ** (dt * 60);
  return Math.abs(next) < MIN_COAST ? 0 : next;
}

// Frame-rate governor, fed one raw rAF interval (ms) per INTERACTIVE frame (drag, fling, scroll; never
// idle frames). It keeps a smoothed interval and the fastest recent one (the display's refresh), and
// decides, once and for good (a stable frame rate beats a flickering one):
//   halfRate:   the display runs ~120 Hz but sustained frames take over 11.5 ms (under ~87 fps), so
//               the grid steps every other frame, a locked 60.
//   lowQuality: sustained frames over 24 ms (under ~42 fps), so fewer videos play at once.
export function newGovernor() {
  return { avg: 16.7, min: 50, slow: 0, over: 0, halfRate: false, lowQuality: false };
}
export function governFrame(g, raw) {
  if (!(raw > 0) || raw > 250) return g; // a gap (tab switch, long pause), not a frame
  g.avg += (raw - g.avg) * 0.05;
  g.min = raw < g.min ? raw : g.min + 0.002; // the fastest interval, drifting up slowly
  const display120 = g.min < 10.5;
  g.slow = !g.halfRate && display120 && g.avg > 11.5 ? g.slow + 1 : 0;
  if (g.slow >= 90) g.halfRate = true;
  g.over = !g.lowQuality && g.avg > 24 ? g.over + 1 : 0;
  if (g.over >= 60) g.lowQuality = true;
  return g;
}

// Parallax: the multiplier on the horizontal pan for a row slot, in
// [1 - rowSpeed, 1 + rowSpeed]; 1 for every row when rowSpeed is 0.
export function rowSpeedScale(row, seed, rowSpeed) {
  return 1 + (hash01(row, seed, 3) * 2 - 1) * rowSpeed;
}

// Row fade. A zone is a vertical band {top, bottom, strength} (the headline
// block, the dock); y0..y1 is a tile's vertical extent in the same
// coordinates. Each zone has a coverage profile c(y): 1 inside the band,
// easing to 0 over `spread` px beyond each edge along a smoothstep (spread 0
// is a hard band). The zone's weight for a tile is strength times the mean of
// c over the tile's height, i.e. the share of the tile that lies in the band,
// feathered at the edges:
//   - a tile fully inside the band weighs `strength`;
//   - with spread 0, a tile half inside weighs half, a touching one 0;
//   - weight is continuous and only ever falls as the tile moves away, and is
//     exactly 0 once the tile is `spread` px or more clear of the band.
// The mean is the exact integral of c (the smoothstep integrates in closed
// form), not a sample. The result is the max over zones, in [0, 1]. Vertical
// only: a tile's horizontal position never matters. Non-finite input weighs 0.

// Integral of the smoothstep ramp S(t) = t^2 (3 - 2t) from 0 to t is G(t).
const smoothIntegral = (t) => t * t * t - (t * t * t * t) / 2;

// Cumulative integral of the coverage profile of band [a, b] from -infinity to y.
function coverageIntegral(y, a, b, s) {
  if (s === 0) return Math.min(Math.max(y, a), b) - a;
  if (y <= a - s) return 0;
  if (y <= a) {
    const u = (a - y) / s; // 1 at the outer edge of the feather, 0 at the band
    return s * ((1 - u) - 0.5 + smoothIntegral(u));
  }
  if (y <= b) return 0.5 * s + (y - a);
  const head = 0.5 * s + (b - a);
  if (y <= b + s) {
    const v = (y - b) / s;
    return head + s * (v - smoothIntegral(v));
  }
  return head + 0.5 * s;
}

export function rowFadeWeight(y0, y1, zones, spread) {
  if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Array.isArray(zones)) return 0;
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  const s = Number.isFinite(spread) && spread > 0 ? spread : 0;
  let best = 0;
  for (const z of zones) {
    const strength = Math.min(1, z.strength);
    if (!(strength > 0) || !Number.isFinite(z.top) || !Number.isFinite(z.bottom)) continue;
    const a = Math.min(z.top, z.bottom);
    const b = Math.max(z.top, z.bottom);
    let cover;
    if (hi > lo) cover = (coverageIntegral(hi, a, b, s) - coverageIntegral(lo, a, b, s)) / (hi - lo);
    else cover = hi >= a && hi <= b ? 1 : 0; // a zero-height tile: the profile at its point
    const w = strength * Math.min(1, Math.max(0, cover));
    if (w > best) best = w;
  }
  return best;
}

// Card opacity for a row-fade weight: 1 at weight 0, rowOpacity at weight 1,
// linear between. Both inputs clamped to [0, 1]; non-finite input means no fade.
export function rowFadeOpacity(weight, rowOpacity) {
  if (!Number.isFinite(weight) || !Number.isFinite(rowOpacity)) return 1;
  const w = Math.min(1, Math.max(0, weight));
  const floor = Math.min(1, Math.max(0, rowOpacity));
  return 1 - w * (1 - floor);
}
