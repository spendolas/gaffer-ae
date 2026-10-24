// The fader, drawn procedurally into one canvas with the noise baked into its alpha.
//
// Why not a CSS gradient: an 8-bit alpha ramp bands, and Safari does not dither gradients. Why not a
// noise layer on top: that is extra full-size masked layers for the compositor to blend every frame while
// the grid moves. Why not a pre-made bitmap: the ellipse is tuned live (colour, softness, size, offset,
// separate phone values), its pixels depend on the viewport, and a fixed bitmap stretched to the ellipse
// would stretch its grain into blotches. So the page computes the ramp in floating point, adds the noise
// BEFORE rounding to 8 bits (a true dither: the average stays exact, the steps break up), and puts the
// result in a single canvas, one layer with nothing to composite but itself.
//
// The canvas covers the viewport at CSS-pixel resolution (about 330k pixels on a phone, 1.3M on a laptop,
// a few ms to fill) and the browser scales it up; one canvas pixel is two or three device pixels, which is
// still far finer than the bands.

// Alpha (0..1) at normalised elliptical distance r from the centre (0 at the centre, 1 on the ellipse).
// Solid up to `softness`, then eased out along a smoothstep to 0 at r = 1: the same shape as the old
// gradient's stops.
export function faderAlpha(r, softness) {
  if (!(r < 1)) return 0;
  const s = Math.min(1, Math.max(0, softness));
  if (r <= s) return 1;
  const u = (r - s) / (1 - s);
  return 1 - u * u * (3 - 2 * u);
}

// Deterministic noise in [0, 1) for a pixel: an integer hash, so the grain is the same on every redraw and
// never shimmers when the fader is redrawn on a resize.
export function grainAt(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// '#RRGGBB' (or '#RGB') to [r, g, b]; anything else (a colour name, rgb()) falls back to the stage black.
export function parseHex(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
  if (!m) return [18, 18, 18];
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// The ellipse parameters in force at this viewport width: the phone set at 600 px and below.
export function faderParams(fader, color, vw, compactMax = 600) {
  const compact = vw <= compactMax;
  return {
    width: compact ? fader.widthCompact : fader.width,
    height: compact ? fader.heightCompact : fader.height,
    offset: compact ? fader.offsetCompact : fader.offset,
    softness: fader.softness,
    grain: fader.grain,
    color,
  };
}

// RGBA pixels (Uint8ClampedArray, w * h * 4, straight alpha) for a w x h viewport: the ellipse of
// width x height centred `offset` px above the bottom edge, in `color`, alpha dithered by `grain` levels
// of 8-bit alpha (0 = none, 1 = the textbook one-level dither). Pixels outside the ellipse are fully
// transparent and cost one row range test.
export function renderFaderPixels(w, h, { width, height, offset, softness, grain = 1, color = '#121212' }) {
  const out = new Uint8ClampedArray(w * h * 4);
  const [cr, cg, cb] = Array.isArray(color) ? color : parseHex(color);
  const rx = Math.max(1, width / 2);
  const ry = Math.max(1, height / 2);
  const cx = w / 2;
  const cy = h - offset;
  const amp = Math.max(0, grain);
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5 - cy) / ry;
    if (Math.abs(dy) >= 1) continue; // this row is wholly outside the ellipse
    const span = rx * Math.sqrt(1 - dy * dy); // half-width of the ellipse on this row
    const x0 = Math.max(0, Math.floor(cx - span));
    const x1 = Math.min(w - 1, Math.ceil(cx + span));
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const a = faderAlpha(Math.sqrt(dx * dx + dy * dy), softness) * 255;
      if (a <= 0) continue;
      // Noise centred on zero, up to +-amp/2 levels, added before the rounding: dithering.
      const v = Math.round(a + (grainAt(x, y) - 0.5) * amp);
      if (v <= 0) continue;
      const i = (y * w + x) * 4;
      out[i] = cr;
      out[i + 1] = cg;
      out[i + 2] = cb;
      out[i + 3] = v > 255 ? 255 : v;
    }
  }
  return out;
}

// A trailing debounce: the returned function runs fn `ms` after the last call.
export function debounced(fn, ms) {
  let timer = 0;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; fn(); }, ms);
  };
}

// Draws the fader into `canvas` for a vw x vh viewport. Returns the pixel work done (for the dev readout).
export function drawFader(canvas, vw, vh, params) {
  const w = Math.max(1, Math.round(vw));
  const h = Math.max(1, Math.round(vh));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  const t0 = performance.now();
  ctx.putImageData(new ImageData(renderFaderPixels(w, h, params), w, h), 0, 0);
  return performance.now() - t0;
}
