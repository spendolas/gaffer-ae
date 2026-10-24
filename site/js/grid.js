// The infinite domed grid (the no-GL technique): plain DOM, one matrix3d per
// visible card per frame, written only while something moves.
//
// Rows. Every row has the same height H (cardSize in math.js: min(grid.tile,
// viewportWidth / columns - gap), never below 40px; columns is grid.columnsCompact
// up to 600px wide and grid.columns above, the minimum number of square tiles
// across, so a phone gets about that many while desktop gets grid.tile). A tile is H tall and
// round(H * aspect) wide (aspectFor: the clip's own shape clamped in 'native'
// mode, 1 in 'square' mode). A row is identified by its WORLD index on the infinite vertical axis
// (rows.js): row w sits at y = w * (H + rowGap) - panY, and the R = ceil(vh / (H + rowGap)) + 2 rows
// whose y falls in the centred window [-R*py/2, R*py/2) are alive, each owning one card per ring tile
// (the +2 is load-bearing: a row is created and destroyed a whole row beyond the viewport, so rim
// cards never pop). A row's ring (buildRing: a seeded shuffle of its world index, at most 12 distinct
// clips, MIN_PASSES passes, wider if the screen needs it) and its wrap window depend on the world row and
// the viewport edge only, never on R or on the viewport width, so a resize adds or removes rows at the
// edges and leaves every other row, clip and tile where it was (scripts/site/rows.test.mjs replays
// resizes against this model). Tiles never change clip while panning horizontally; a row that scrolls
// out is released to a card pool and a new one is built at the other edge.
// Each row is offset by its static stagger (rowShift x rowShiftFactor of its
// world row x the row's average tile width) and pans horizontally at its own parallax speed
// (rowSpeedScale of the world row); vertical pan is shared.
//
// The dome bow is motion.bow at rest plus motion.bowVelocity x a smoothed
// speed signal (pan lag over half the viewport short side, damped at motion.bowSmooth), so
// fast pans bow harder and ease back; off under reduced motion.
//
// Per card, per moving frame: wrap its period box (tile + gap across, H +
// rowGap down) into the window, warp the four corners (dome + cursor bulge),
// inset by half the gaps, then solve the rect-to-quad homography. Horizontal
// neighbours share warped corners exactly; shifted rows do not, so a hair-thin
// seam between rows is accepted. Cards have no hover state.
//
// Row fade (fader.mode 'rows' or 'both'): the headline block and the dock are
// two vertical bands, measured from the DOM on layout, resize and
// refreshZones() (never per frame). In the geometry pass each near card's
// opacity follows how close its warped quad's vertical extent is to a band
// (rowFadeWeight in math.js), written only when it moves by more than 0.01,
// so an idle page still writes nothing (unless motion.idle drift is on: then every frame re-warps).
//
// Config is read from getConfig() every frame: the layout keys re-tile, row
// shift/speed and the motion values apply on the next frame. Colours, radius
// and shadow are CSS variables and need nothing from here.

import {
  wrap, damp, warpPoint, insetQuad, homography, rowShiftFactor, rowSpeedScale, idleDirection, coastVelocity, newGovernor, governFrame,
  stepSpeed, velocityBow, speedReference, rowFadeWeight, rowFadeOpacity,
} from './math.js';
import { gridMetrics, firstWorldRow, rowModel, panScale, windowLeft } from './rows.js';
import { createVideoPool } from './media.js';
import { faderShowsRows } from './config.js';

const MAX_PLAYING = 12;
const TORCH_STOPS = 12;
const CURSOR_RATE = 0.15;
const BULGE_RATE = 0.1;
const CALM_LAG = 40; // px of pan lag that halves the bulge while travelling
const BUSY_LAG = 0.4; // pan lag, as a share of the speed reference, above which new videos are held back
const IDLE_STEP_MS = 33; // idle drift steps at about 30 fps
const HALF_RATE_MS = 14; // locked 60 on a 120 Hz display
const LOW_QUALITY_PLAYING = 6; // videos playing at once once the frame rate cannot hold
const BUSY_HOLD_MS = 60; // how long the grid must be calm before held-back videos start
const PARK = 'translate3d(-99999px, -99999px, 0)';

const smooth = (t) => t * t * (3 - 2 * t);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Damp and snap once close, so motion settles to exactly still.
function settle(from, to, rate, dt, eps) {
  const v = damp(from, to, rate, dt);
  return Math.abs(to - v) < eps ? to : v;
}

// Config keys that change the tiling, and those that only move rows.
const layoutKeyOf = (g) => [g.tile, g.gap, g.columns, g.columnsCompact, g.rowGap, g.aspectMode, g.aspectMin, g.aspectMax, g.seed].join();
const rowKeyOf = (g) => [g.rowShift, g.shiftMode, g.rowSpeed, g.seed].join();

// Row-fade bands from the DOM: per kind ('headline', 'dock'), the union of
// its elements' boxes, in viewport px, as [{kind, top, bottom}]. Zero-sized
// boxes are skipped; a kind with no box or wholly outside view {top, bottom}
// gives no zone.
export function measureZones(sources, view) {
  const zones = [];
  for (const [kind, els] of Object.entries(sources ?? {})) {
    let top = Infinity;
    let bottom = -Infinity;
    for (const el of els ?? []) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    }
    if (top < bottom && bottom > view.top && top < view.bottom) zones.push({ kind, top, bottom });
  }
  return zones;
}

// Target opacity of a near card: its warped quad's vertical extent against the
// bands ({top, bottom, strength} in the quad's coordinates). 1 when the mode
// has no row fade or the card has no quad.
export function rowFadeTarget(q, zones, fader) {
  if (!q || !faderShowsRows(fader.mode)) return 1;
  const y0 = Math.min(q.tl.y, q.tr.y);
  const y1 = Math.max(q.bl.y, q.br.y);
  return rowFadeOpacity(rowFadeWeight(y0, y1, zones, fader.rowSpread), fader.rowOpacity);
}

// Writes a card's opacity when it moved by more than 0.01 since the last
// write, or returns to exactly 1 (the stylesheet's value, written as '').
// c.op holds the last written value. Returns whether it wrote.
export function fadeCard(c, target) {
  if (target === c.op || (Math.abs(target - c.op) <= 0.01 && target !== 1)) return false;
  c.op = target;
  c.el.style.opacity = target === 1 ? '' : String(Math.round(target * 1000) / 1000);
  return true;
}

function offsetQuad(q, dx, dy) {
  const o = (p) => ({ x: p.x + dx, y: p.y + dy });
  return { tl: o(q.tl), tr: o(q.tr), bl: o(q.bl), br: o(q.br) };
}

export function createGrid(stage, { items = [], getConfig, zones: zoneSources = {} }) {
  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
  const hoverMq = matchMedia('(hover: hover)'); // mouse or pen; otherwise touch
  const pool = createVideoPool({ blobCache: true, max: MAX_PLAYING, reducedMotion: () => reducedMq.matches });

  const layer = document.createElement('div');
  layer.className = 'grid';
  const torch = document.createElement('div');
  torch.className = 'torch';
  stage.append(layer, torch);

  let cards = [];
  let geo = null;
  const pan = { x: 0, y: 0, tx: 0, ty: 0 };
  // Idle drift: a steady sideways offset (px) added to the pan before each row's parallax scale, so
  // an untouched grid keeps the same row-by-row drift a scroll gives. Never touches lag or the bow.
  let idleX = 0;
  // Fling velocity (px/s of pan target) sampled from the drag, then coasted after release (motion.coast).
  const fling = { x: 0, y: 0, t: 0 };
  const cursor = { x: 0, y: 0, tx: 0, ty: 0, present: false, weight: 0 };
  const torchState = { x: NaN, y: NaN, r: NaN, edge: NaN, shade: NaN };
  let speed = 0; // velocity-bow signal in [0, 1]
  let zones = []; // row-fade bands in viewport px (measureZones)
  let zoneRaf = 0;
  let fadeKey = '';
  let touchMode = !hoverMq.matches;
  let drag = null;
  let dirty = true;
  let forceVisible = true;
  let motionKey = '';
  let generation = 0;
  let destroyed = false;
  let last = performance.now();
  let owed = 0; // ms of skipped frames carried into the next step
  const gov = newGovernor();
  let loweredCap = false;
  let raf = 0;

  function makeCard() {
    const el = document.createElement('div');
    el.className = 'card';
    el.style.transform = PARK;
    layer.append(el);
    return { el, x: 0, w: 0, p: 0, item: undefined, near: false, inView: false, parked: true, quad: null, cx: 0, cy: 0, op: 1 };
  }

  // Card bookkeeping. A row is keyed by its WORLD index (rows.js): it owns one card per ring tile, taken
  // from a free pool, and gives them back when it leaves the alive window (a whole row beyond the
  // viewport). Nothing here depends on the number of rows R, so a resize that changes R only adds or
  // removes rows at the two edges.
  const active = new Map(); // world row -> { world, cards, W, avgW }
  const freeCards = [];

  function acquireCard() {
    const reused = freeCards.pop();
    if (reused) return reused;
    const c = makeCard();
    cards.push(c);
    return c;
  }

  function releaseCard(c) {
    c.quad = null;
    c.near = false;
    c.inView = false;
    c.parked = false; // the next write parks it
    freeCards.push(c);
  }

  function dropRow(row) {
    for (const c of row.cards) releaseCard(c);
    row.cards.length = 0;
    active.delete(row.world);
  }

  // Lays a row's cards out on its ring model: cards are reused by ring position, so re-applying the same
  // ring at a new tile size changes sizes only (no clip swaps).
  function applyRow(row, model, m) {
    while (row.cards.length > model.ring.length) releaseCard(row.cards.pop());
    while (row.cards.length < model.ring.length) row.cards.push(acquireCard());
    model.ring.forEach((idx, k) => {
      const c = row.cards[k];
      c.x = model.xs[k];
      c.w = model.ws[k];
      c.p = c.w + m.gap;
      if (c.sw !== c.w || c.sh !== m.H) {
        c.sw = c.w;
        c.sh = m.H;
        c.el.style.width = `${c.w}px`;
        c.el.style.height = `${m.H}px`;
      }
      if (items[idx] !== c.item) {
        c.item = items[idx];
        pool.register(c.el, c.item);
      }
    });
    row.W = model.W;
    row.avgW = model.avgW;
  }

  // Keeps exactly the rows firstWorldRow .. + R - 1 alive for the current pan. force re-applies every row
  // (a layout change). Returns whether any card changed hands.
  function ensureRows(force) {
    const { R, metrics } = geo;
    const first = firstWorldRow(pan.y, geo.py, R);
    if (!force && geo.first === first) return false;
    geo.first = first;
    for (const row of [...active.values()]) {
      if (row.world < first || row.world >= first + R) dropRow(row);
    }
    const seed = getConfig().grid.seed;
    for (let w = first; w < first + R; w++) {
      let row = active.get(w);
      if (row && !force) continue;
      if (!row) { row = { world: w, cards: [], W: 0, avgW: 0 }; active.set(w, row); }
      applyRow(row, rowModel(w, metrics, items.length, seed), metrics);
    }
    forceVisible = true;
    return true;
  }

  // Measures the stage and (re)builds the metrics. Cheap no-op when nothing changed.
  function layout() {
    const cfg = getConfig().grid;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const { gap, rowGap } = cfg;
    const metrics = gridMetrics(r.width, r.height, cfg, items);
    const { H, py, R, maxP } = metrics;
    const layoutKey = layoutKeyOf(cfg);
    const key = [r.width, r.height, H, R, layoutKey].join();
    if (geo && geo.key === key) {
      geo.left = r.left;
      geo.top = r.top;
      return;
    }
    if (geo) {
      // Keep the pan at the same place within the repeat across a re-tile: scale by the change of the
      // horizontal pitch (H + gap) and of the row pitch, so the world row and tile at the centre stay.
      const { kx, ky } = panScale({ px: geo.px, py: geo.py }, { px: H + gap, py });
      pan.x *= kx; pan.tx *= kx; pan.y *= ky; pan.ty *= ky;
      // A drag in progress keeps its anchor in the same scale, or the next
      // move jumps by (k - 1) * anchor (resize or rotation mid-drag).
      if (drag) { drag.px *= kx; drag.py *= ky; }
    }
    geo = {
      key, layoutKey, H, speedRef: speedReference(r.width, r.height), gap, rowGap, py, px: H + gap, R, maxP, metrics,
      first: NaN,
      left: r.left, top: r.top,
      halfW: r.width / 2, halfH: r.height / 2,
      vh: r.height,
    };
    ensureRows(true);
    dirty = true;
    forceVisible = true;
  }

  // Re-reads the row-fade bands and forces one geometry pass (one-off writes
  // even when idle). Called on layout paths only, never per frame.
  function measure() {
    if (!geo) return;
    zones = measureZones(zoneSources, { top: geo.top, bottom: geo.top + geo.vh });
    dirty = true;
  }

  // For config changes that move the headline or dock: measure on the next
  // frame, once however many calls arrive before it.
  function refreshZones() {
    if (zoneRaf || destroyed) return;
    zoneRaf = requestAnimationFrame(() => {
      zoneRaf = 0;
      if (!destroyed) measure();
    });
  }

  // motion.shade is the dim strength, motion.edge the soft edge as a multiple
  // of the hole radius; the gradient is rebuilt only when r or edge change.
  function updateTorch(m) {
    const { halfW, halfH, py } = geo;
    if (m.shade !== torchState.shade) { torchState.shade = m.shade; torch.style.opacity = String(m.shade); }
    // Shade 0 hides the torch exactly like a zero radius: nothing is written.
    const r = m.shade > 0 ? Math.round(Math.max(0, m.vignette) * py * (touchMode ? 2 : 1)) : 0;
    if (r !== torchState.r || m.edge !== torchState.edge) {
      torchState.r = r;
      torchState.edge = m.edge;
      if (r <= 0) {
        torch.style.display = 'none';
        // Forget the position so it is written again when the torch returns.
        torchState.x = NaN;
        torchState.y = NaN;
      } else {
        const edge = r * Math.max(1, m.edge);
        const stops = [];
        for (let i = 0; i <= TORCH_STOPS; i++) {
          const t = i / TORCH_STOPS;
          stops.push(`rgb(0 0 0 / ${smooth(t).toFixed(4)}) ${Math.round(r + t * (edge - r))}px`);
        }
        const mask = `radial-gradient(circle at var(--fx) var(--fy), ${stops.join(', ')})`;
        torch.style.display = '';
        torch.style.maskImage = mask;
        torch.style.webkitMaskImage = mask;
      }
    }
    if (torchState.r <= 0) return; // hidden: a moving cursor writes nothing
    const x = Math.round(touchMode ? halfW : cursor.x + halfW);
    const y = Math.round(touchMode ? halfH : cursor.y + halfH);
    if (x !== torchState.x) { torchState.x = x; torch.style.setProperty('--fx', `${x}px`); }
    if (y !== torchState.y) { torchState.y = y; torch.style.setProperty('--fy', `${y}px`); }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const raw = now - last;
    last = now;
    // Adaptive rate: full refresh while the user interacts (drag, fling, scroll, bulge), 30 fps for
    // pure idle drift, and a locked 60 on a 120 Hz display that cannot hold it (governFrame).
    const interacting = !!drag || fling.x !== 0 || fling.y !== 0 || pan.x !== pan.tx || pan.y !== pan.ty
      || speed !== 0 || cursor.weight !== 0 || dirty;
    if (interacting) {
      governFrame(gov, raw);
      if (gov.lowQuality && !loweredCap) { loweredCap = true; pool.setCap(LOW_QUALITY_PLAYING); }
    }
    owed += raw;
    const wait = interacting ? (gov.halfRate ? HALF_RATE_MS : 0) : IDLE_STEP_MS;
    if (owed < wait - 1) return;
    const dt = clamp(owed / 1000, 0, 0.1);
    owed = 0;
    step(dt);
  }

  // One tick. Only a geometry pass (pan moved, bulge visibly moved, config or
  // layout changed) re-warps the near cards and writes their transforms.
  // Idle, or a cursor moving where it cannot change the picture, writes
  // nothing to the cards.
  // Fast movement (a big lag behind the target, or a fling coasting) holds back new videos; they start
  // BUSY_HOLD_MS after it calms, so a flick never spins up decoders mid-scroll.
  let busyTimer = 0;
  let busyOn = false;
  function updateBusy(fast) {
    if (fast) {
      clearTimeout(busyTimer);
      busyTimer = 0;
      if (!busyOn) { busyOn = true; pool.setBusy(true); }
    } else if (busyOn && !busyTimer) {
      busyTimer = setTimeout(() => { busyTimer = 0; busyOn = false; pool.setBusy(false); }, BUSY_HOLD_MS);
    }
  }

  function step(dt) {
    const cfg = getConfig();
    const m = cfg.motion;
    const g = cfg.grid;
    if (!geo || geo.layoutKey !== layoutKeyOf(g)) layout();
    if (!geo) return;

    const reduced = reducedMq.matches;
    const mk = [m.bow, m.bulge, m.reach, reduced, touchMode, rowKeyOf(g)].join();
    if (mk !== motionKey) {
      motionKey = mk;
      dirty = true;
      forceVisible = true;
    }
    const f = cfg.fader;
    const fk = [f.mode, f.rowOpacity, f.rowSpread, f.headlineStrength, f.dockStrength].join();
    if (fk !== fadeKey) {
      fadeKey = fk;
      dirty = true;
    }

    // Coast: after a release the pan target keeps moving at the fling velocity, which decays by m.coast.
    if (!drag && (fling.x || fling.y)) {
      if (reduced || !(m.coast > 0)) { fling.x = 0; fling.y = 0; } else {
        pan.tx += fling.x * dt;
        pan.ty += fling.y * dt;
        fling.x = coastVelocity(fling.x, m.coast, dt);
        fling.y = coastVelocity(fling.y, m.coast, dt);
      }
    }
    const glide = reduced ? 1 : clamp(m.glide, 0.01, 1);
    const px = pan.x;
    const py = pan.y;
    pan.x = settle(pan.x, pan.tx, glide, dt, 0.05);
    pan.y = settle(pan.y, pan.ty, glide, dt, 0.05);
    const lag = Math.hypot(pan.tx - pan.x, pan.ty - pan.y);

    // Velocity bow: lag over half the viewport's short side counts as full speed. Off (exactly
    // the resting bow, no extra frames) when bowVelocity is 0 or motion is reduced.
    const s0 = speed;
    speed = reduced || !m.bowVelocity ? 0 : stepSpeed(speed, lag, geo.speedRef, m.bowSmooth, dt);
    const bow = reduced ? 0 : velocityBow(m.bow, m.bowVelocity, speed);
    updateBusy(lag > geo.speedRef * BUSY_LAG);

    const cx0 = cursor.x;
    const cy0 = cursor.y;
    const w0 = cursor.weight;
    cursor.x = settle(cursor.x, cursor.tx, CURSOR_RATE, dt, 0.05);
    cursor.y = settle(cursor.y, cursor.ty, CURSOR_RATE, dt, 0.05);
    const bulgeOn = cursor.present && !touchMode && !reduced && !drag && m.bulge !== 0;
    cursor.weight = settle(cursor.weight, bulgeOn ? 1 / (1 + lag / CALM_LAG) : 0, BULGE_RATE, dt, 0.001);

    updateTorch(m);

    // The damped cursor only matters while the bulge is showing.
    const bulgeShows = (cursor.weight > 0 || w0 > 0) && m.bulge !== 0 && !reduced;
    const idleOn = !reduced && m.idle > 0;
    if (idleOn) idleX += m.idle * dt;
    const geometry = dirty || idleOn || pan.x !== px || pan.y !== py || cursor.weight !== w0 || speed !== s0
      || (bulgeShows && (cursor.x !== cx0 || cursor.y !== cy0));
    if (!geometry) return;
    dirty = false;
    warpAll(m, g, reduced, bow);
    writeCards(f);
  }

  function warpAll(m, g, reduced, bow) {
    const { halfW, halfH, py, gap, rowGap, maxP } = geo;
    ensureRows(false); // a row crossing the alive window is dropped and a new one built, beyond the viewport
    const reach = Math.max(1, m.reach * py);
    const wo = {
      halfW, halfH,
      bow,
      bulge: reduced ? 0 : m.bulge,
      bulgeWeight: cursor.weight,
      reach2: reach * reach,
      cursor: { x: cursor.x, y: cursor.y },
    };

    let visChanged = forceVisible;
    forceVisible = false;
    const minX0 = windowLeft(halfW, maxP);
    for (const row of active.values()) {
      const world = row.world;
      const T = world * py - pan.y;
      // Pad the write tests by one row / one widest tile so a fast card never
      // lands inside the viewport on its first write.
      const rowNear = T < halfH + py && T + py > -halfH - py;
      // The shift follows the world row, so alternate/step/random stay
      // continuous across the vertical wrap; it changes only as a row wraps,
      // which happens off-screen.
      const shift = rowShiftFactor(g.shiftMode, world, g.seed) * g.rowShift * row.avgW;
      const panX = (pan.x + idleX * idleDirection(m.idleMode, world, g.seed)) * rowSpeedScale(world, g.seed, g.rowSpeed);
      const minX = minX0; // anchored to the viewport, so a longer ring never moves a visible tile
      for (const c of row.cards) {
        const L = wrap(minX, minX + row.W, c.x + shift - panX);
        const near = rowNear && L < halfW + maxP && L + c.p > -halfW - maxP;
        c.quad = near
          ? insetQuad({
            tl: warpPoint(L, T, wo),
            tr: warpPoint(L + c.p, T, wo),
            bl: warpPoint(L, T + py, wo),
            br: warpPoint(L + c.p, T + py, wo),
          }, gap, rowGap)
          : null;
        // In view = the warped quad (what is drawn) touches the viewport; the
        // dome spreads rim cards outward, so the flat box would over-count.
        const q = c.quad;
        const inView = !!q
          && Math.min(q.tl.x, q.bl.x) < halfW && Math.max(q.tr.x, q.br.x) > -halfW
          && Math.min(q.tl.y, q.tr.y) < halfH && Math.max(q.bl.y, q.br.y) > -halfH;
        if (near !== c.near || inView !== c.inView) visChanged = true;
        c.near = near;
        c.inView = inView;
        c.cx = L + c.p / 2;
        c.cy = T + py / 2;
      }
    }

    if (visChanged) {
      const inView = cards.filter((c) => c.inView)
        .sort((a, b) => (a.cx * a.cx + a.cy * a.cy) - (b.cx * b.cx + b.cy * b.cy))
        .map((c) => c.el);
      pool.setVisible(inView, cards.filter((c) => c.near).map((c) => c.el));
    }
  }

  // After a geometry pass: every near card gets its transform and its row-fade
  // opacity, a card that left the near area gets one parking write (and no
  // opacity write; it gets the right one when it comes back).
  function writeCards(f) {
    const { halfW, halfH, H, top } = geo;
    // The bands in the quads' coordinates (stage centre origin), with strengths.
    const bands = faderShowsRows(f.mode)
      ? zones.map((z) => ({
        top: z.top - top - halfH,
        bottom: z.bottom - top - halfH,
        strength: z.kind === 'headline' ? f.headlineStrength : f.dockStrength,
      }))
      : [];
    for (const c of cards) {
      if (!c.quad) {
        if (!c.parked) { c.parked = true; c.el.style.transform = PARK; }
        continue;
      }
      c.parked = false;
      c.el.style.transform = homography(c.w, offsetQuad(c.quad, halfW, halfH), H);
      fadeCard(c, rowFadeTarget(c.quad, bands, f));
    }
  }

  // Input ------------------------------------------------------------------

  function setMode(pointerType) {
    const touch = pointerType === 'touch';
    if (touch !== touchMode) {
      touchMode = touch;
      dirty = true;
    }
  }

  function onWheel(e) {
    // ctrl + wheel is a trackpad pinch (or ctrl + scroll): let the browser zoom the page.
    if (e.ctrlKey) return;
    e.preventDefault();
    if (!geo) return;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? geo.vh : 1;
    pan.tx += e.deltaX * k;
    pan.ty += e.deltaY * k;
  }

  // Pinch zoom. While the page is zoomed in, one finger must pan the zoomed view (the browser does that when
  // touch-action allows it), so the grid stops taking touch drags until the zoom is back to 1.
  let zoomedIn = false;
  const vv = window.visualViewport;
  function onViewportZoom() {
    const next = !!vv && vv.scale > 1.02;
    if (next === zoomedIn) return;
    zoomedIn = next;
    stage.style.touchAction = next ? 'pan-x pan-y pinch-zoom' : '';
  }
  vv?.addEventListener('resize', onViewportZoom);

  function onPointerDown(e) {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (zoomedIn && e.pointerType !== 'mouse') return;
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch { /* capture is a bonus; window listeners carry the drag */ }
    setMode(e.pointerType);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pan.tx, py: pan.ty };
    fling.x = 0; fling.y = 0; fling.t = performance.now();
    stage.classList.add('is-dragging');
    dirty = true;
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const ntx = drag.px - (e.clientX - drag.x);
    const nty = drag.py - (e.clientY - drag.y);
    const now = performance.now();
    const dtm = (now - fling.t) / 1000;
    if (dtm > 0.004) {
      fling.x = fling.x * 0.5 + ((ntx - pan.tx) / dtm) * 0.5;
      fling.y = fling.y * 0.5 + ((nty - pan.ty) / dtm) * 0.5;
      fling.t = now;
    }
    pan.tx = ntx;
    pan.ty = nty;
  }

  function onDragEnd(e) {
    if (!drag || e.pointerId !== drag.id) return;
    // A finger held still before lifting is not a fling.
    if (e.type === 'pointercancel' || performance.now() - fling.t > 80) { fling.x = 0; fling.y = 0; }
    drag = null;
    stage.classList.remove('is-dragging');
    dirty = true;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
  }

  // Cursor for bulge and flashlight. Over anything that is not the
  // stage (the dock) the cursor counts as absent.
  function onPointerMove(e) {
    setMode(e.pointerType);
    if (!geo) return;
    cursor.tx = e.clientX - geo.left - geo.halfW;
    cursor.ty = e.clientY - geo.top - geo.halfH;
    // e.target can be the window or document for synthetic or captured events: contains() throws on non-Nodes.
    const present = e.pointerType !== 'touch' && e.target instanceof Node && stage.contains(e.target);
    if (present && !cursor.present) {
      // Re-entering: no glide in from wherever the cursor left.
      cursor.x = cursor.tx;
      cursor.y = cursor.ty;
    }
    if (present !== cursor.present) dirty = true;
    cursor.present = present;
  }

  function onPointerLeave() {
    cursor.present = false;
    dirty = true;
  }

  function onKey(e) {
    if (!geo || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
    const { px, py } = geo;
    switch (e.key) {
      case 'ArrowLeft': pan.tx -= px; break;
      case 'ArrowRight': pan.tx += px; break;
      case 'ArrowUp': pan.ty -= py; break;
      case 'ArrowDown': pan.ty += py; break;
      case ' ': pan.ty += (e.shiftKey ? -0.8 : 0.8) * geo.vh; break;
      default: return;
    }
    e.preventDefault();
  }

  // Resize -------------------------------------------------------------------

  // Rotation fires several resizes that interleave at the await; only the
  // latest run may write geometry.
  async function resize() {
    const gen = ++generation;
    await new Promise((r) => requestAnimationFrame(r));
    if (gen !== generation || destroyed) return;
    layout();
    measure(); // the headline and dock move at the compact breakpoint
    step(0); // draw the new geometry now, not one frame late
  }

  const ro = new ResizeObserver(() => { resize(); });
  ro.observe(stage);
  // The row-fade bands change size when fonts arrive or the copy changes.
  const zoneRo = new ResizeObserver(() => { refreshZones(); });
  for (const els of Object.values(zoneSources)) for (const el of els) zoneRo.observe(el);
  document.fonts?.ready.then(() => refreshZones());
  window.addEventListener('orientationchange', resize);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('pointerdown', onPointerDown);
  // No image menu over the grid; the dock, toast and panels keep theirs.
  const onContextMenu = (e) => { if (e.target instanceof Node && stage.contains(e.target)) e.preventDefault(); };
  document.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointermove', onPointerMove);
  document.documentElement.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('keydown', onKey);

  // First layout and one synchronous tick, so the near cards already hold
  // their posters when createGrid returns.
  layout();
  measure();
  step(0);
  raf = requestAnimationFrame(frame);

  // Settles once the posters of the cards near the viewport have loaded or
  // failed (no cap here; the caller races it against its own timeout).
  const ready = Promise.all(cards
    .filter((c) => c.near)
    .map((c) => pool.poster(c.el))
    .filter(Boolean)
    .map((img) => new Promise((resolve) => {
      // load/error, not decode(): decode() can stall while the page is not
      // being rendered (background tab), which would always hit the cap.
      if (img.complete) return resolve();
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }))).then(() => {});

  function destroy() {
    destroyed = true;
    cancelAnimationFrame(raf);
    cancelAnimationFrame(zoneRaf);
    ro.disconnect();
    zoneRo.disconnect();
    window.removeEventListener('orientationchange', resize);
    stage.removeEventListener('wheel', onWheel);
    vv?.removeEventListener('resize', onViewportZoom);
    stage.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('pointermove', onPointerMove);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('keydown', onKey);
    if (drag) onDragEnd({ pointerId: drag.id });
    pool.destroy();
    layer.remove();
    torch.remove();
    cards = [];
  }

  return { destroy, resize, refreshZones, ready };
}
