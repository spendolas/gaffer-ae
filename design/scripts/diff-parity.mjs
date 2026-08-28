#!/usr/bin/env node
// Figma parity audit — node-level auto-diff (replaces the 58 hand-authored
// assertions in verify-parity.mjs with a mechanical, non-cherry-picked check).
//
// For every panel element carrying a data-fig="<figmaId>" anchor (captured by
// panel-capture.mjs), this derives the EXPECTED CSS from that Figma node's spec
// (design/refs/json/spec-*.json) and diffs it against the live computed style.
// Every deterministic visual property is compared — nothing is picked by hand.
//
// It also writes a coverage ledger: every visible Figma node that carries a
// paint/stroke/text/radius but has NO anchor is listed, so an unimplemented
// surface shows up as an explicit gap instead of silently passing.
//
// Usage: node design/scripts/diff-parity.mjs
// Exits non-zero if any anchored node mismatches.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_DIR = join(__dirname, '..', 'refs', 'json');
const PANEL = join(__dirname, '..', 'refs', 'panel');
const J = (dir, f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

// ── Load Figma specs: figmaId → spec entry ──────────────────────────────────
const specById = new Map();
const specFiles = readdirSync(JSON_DIR).filter((f) => f.startsWith('spec-'));
for (const f of specFiles) {
  for (const n of J(JSON_DIR, f)) {
    if (!specById.has(n.id)) specById.set(n.id, { ...n, _root: f.replace(/^spec-|\.json$/g, '') });
  }
}

// ── Load captured panel states: figmaId → best captured element ─────────────
// A fig id can be captured in several states (e.g. an element present but empty
// elsewhere). Keep the instance with the largest painted area = most rendered.
const capById = new Map();
// Interactive / forced states capture :hover, :active, :focus and the
// disabled/offline variants — these must NOT feed the DEFAULT-spec diff (a
// pressed button's fill compared to the default fill is a false mismatch). They
// belong to their own Figma State= variants (matched separately). Resting states
// only here.
const NON_DEFAULT_STATES = new Set(['hover', 'active', 'focus', 'disabled', 'offline']);
const metricFiles = readdirSync(PANEL).filter((f) => /\.metrics\.json$/.test(f));
for (const f of metricFiles) {
  const state = f.replace(/^state-|\.metrics\.json$/g, '');
  if (NON_DEFAULT_STATES.has(state)) continue;
  for (const el of J(PANEL, f)) {
    if (!el.fig) continue;
    const area = (el.rect.w || 0) * (el.rect.h || 0);
    const prev = capById.get(el.fig);
    if (!prev || area > prev._area) capById.set(el.fig, { ...el, _area: area, _state: state });
  }
}

// ── Figma value → expected CSS ──────────────────────────────────────────────
function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
// resolveFill() emits "token/name (#rrggbb@op)" | "#rrggbb@op" | "IMAGE" | …
function paintToCss(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/#([0-9a-fA-F]{6})(?:@([0-9.]+))?\s*\)?\s*$/);
  if (!m) return null; // non-solid paint (image/gradient) — not diffable here
  const [r, g, b] = hexToRgb(m[1]);
  const op = m[2] != null ? parseFloat(m[2]) : 1;
  return op === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${op})`;
}
const pxEq = (a, b, tol = 1) => Math.abs(parseFloat(a) - parseFloat(b)) <= tol;
const WEIGHTS = { thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };
const weightOf = (w) => { if (w == null) return null; const k = String(w).toLowerCase().replace(/\s|italic/g, ''); return WEIGHTS[k] || (/^\d+$/.test(w) ? +w : null); };
// "Source Sans 3 SemiBold" → "Source Sans 3"
const famOf = (f) => f ? f.replace(/\s+(Thin|Extra ?Light|Ultra ?Light|Light|Regular|Normal|Book|Medium|Semi ?Bold|Demi ?Bold|Bold|Extra ?Bold|Ultra ?Bold|Black|Heavy)(\s+Italic)?$/i, '').trim() : null;
// Figma letterSpacing "value+unit" → px (PERCENT is relative to font size).
function lsPx(ls, size) {
  if (ls == null || ls === 0 || ls === '0') return 0;
  const m = String(ls).match(/^(-?[\d.]+)(PERCENT|PIXELS)?$/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] === 'PERCENT' ? (size ? Math.round((v / 100) * size * 100) / 100 : null) : v;
}
const ALIGN = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between', BASELINE: 'baseline' };

// Compare one computed value to one expected value; kind picks the comparator.
function cmp(kind, actual, expected) {
  if (actual == null) return false;
  if (kind === 'px') {
    if ((actual === 'normal' || actual === 'auto') && parseFloat(expected) === 0) return true;
    return pxEq(actual, expected);
  }
  if (kind === 'num') return Math.abs(parseFloat(actual) - parseFloat(expected)) <= 0.02;
  if (kind === 'color') {
    // Fully-transparent colours are equal regardless of RGB (alpha 0 = invisible):
    // panel `transparent` (rgba(0,0,0,0)) == Figma #121212@0 (rgba(18,18,18,0)).
    const a0 = (v) => /rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*0\s*\)/.test(v);
    if (a0(actual) && a0(expected)) return true;
    const norm = (v) => v.replace(/rgba\(([^,]+),([^,]+),([^,]+),\s*1\)/, 'rgb($1,$2,$3)').replace(/\s+/g, '');
    return norm(actual) === norm(expected);
  }
  if (kind === 'contains') return String(actual).toLowerCase().includes(String(expected).toLowerCase());
  if (kind === 'weight') return String(parseInt(actual, 10)) === String(expected);
  if (kind === 'present') { // expected 'yes' | 'no'
    const has = actual && actual !== 'none' && actual !== 'normal' && parseFloat(actual) !== 0;
    return expected === 'yes' ? !!has : !has;
  }
  if (kind === 'shadow') return !!(actual && actual !== 'none');
  if (kind === 'align') { // Figma MIN ≈ CSS default 'normal'/'flex-start'/'start'
    const g = (v) => ({ normal: 'start', 'flex-start': 'start', start: 'start', 'flex-end': 'end', end: 'end' }[v] || v);
    return g(actual) === g(expected);
  }
  if (kind === 'selfalign') return actual === 'auto' || actual === 'stretch' || actual === 'normal'; // auto inherits parent stretch
  return String(actual) === String(expected);
}

// Build the list of (cssProp, kind, expected[, src]) checks a Figma spec implies.
function expectedChecks(spec) {
  const checks = [];
  const push = (prop, kind, expected, src) => { if (expected != null) checks.push({ prop, kind, expected, src: src || 'style' }); };

  // ── Fill: base colour + layered overlays ──
  const paint = paintToCss(spec.fill);
  if (paint) {
    if (spec.type === 'TEXT') push('color', 'color', paint);
    // bg/panel is host-adaptive at runtime (main.js overrides --color-bg-panel
    // with AE's appSkinInfo panel colour), so its rendered value legitimately
    // differs from the static Figma #232323 — don't assert the exact hex.
    else if (!/bg\/panel\b/.test(spec.fill || '')) push('background-color', 'color', paint);
  }
  // Layered surface (base + rest-overlay) → an overlay must paint via background-image.
  if (Array.isArray(spec.fills) && spec.fills.length > 1 && spec.type !== 'TEXT') push('background-image', 'present', 'yes');
  if (spec.opacity != null) push('opacity', 'num', spec.opacity);

  // ── Radius (per corner) ──
  if (spec.radius != null) {
    const r = spec.radius;
    const corners = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
    const vals = Array.isArray(r) ? r : [r, r, r, r]; // digest array order: [tl,tr,br,bl]
    corners.forEach((c, i) => push(c, 'px', vals[i] + 'px'));
  }

  // ── Stroke → border (per side, colour, style) ──
  if (spec.stroke) {
    const col = paintToCss(spec.stroke.color);
    const w = spec.stroke.w;
    const widths = Array.isArray(w) ? w : [w, w, w, w]; // t,r,b,l
    const style = spec.stroke.dash ? (spec.stroke.dash[0] <= 2 ? 'dotted' : 'dashed') : 'solid';
    ['top', 'right', 'bottom', 'left'].forEach((side, i) => {
      if ((widths[i] || 0) > 0) {
        push(`border-${side}-width`, 'px', widths[i] + 'px');
        if (col) push(`border-${side}-color`, 'color', col);
        push(`border-${side}-style`, 'exact', style);
      }
    });
  }

  // ── Effects → box-shadow (presence; ordering/format too volatile to string-match) ──
  if (Array.isArray(spec.effects) && spec.effects.some((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')) {
    push('box-shadow', 'shadow', 'yes');
    if (spec.effects.some((e) => e.type === 'INNER_SHADOW')) push('box-shadow', 'contains', 'inset');
  }

  // ── Layout: padding, gap, flex direction/alignment ──
  if (spec.layout) {
    if (Array.isArray(spec.layout.pad)) {
      const [t, ri, b, l] = spec.layout.pad;
      if (spec.layout.sizingV !== 'FIXED') { push('padding-top', 'px', t + 'px'); push('padding-bottom', 'px', b + 'px'); }
      if (spec.layout.sizingH !== 'FIXED') { push('padding-right', 'px', ri + 'px'); push('padding-left', 'px', l + 'px'); }
    }
    if (spec.layout.gap != null && spec.kids >= 2) push('gap', 'px', spec.layout.gap + 'px');
    if (spec.layout.dir) {
      // Flex-family checks are gated in the diff loop to code elements that ARE
      // flex — a Figma auto-layout is often achieved with block+other in code,
      // so asserting flex on a block element is a false positive, not a bug.
      // flex-direction is only observable with ≥2 children (a single centered child looks the same either way).
      if (spec.kids >= 2) push('flex-direction', 'exact', spec.layout.dir === 'VERTICAL' ? 'column' : 'row');
      // Alignment is only observable when the axis has free space (not HUG-sized) —
      // justify on the main axis, align-items on the cross axis.
      const isVert = spec.layout.dir === 'VERTICAL';
      const mainHug = (isVert ? spec.layout.sizingV : spec.layout.sizingH) === 'HUG';
      const crossHug = (isVert ? spec.layout.sizingH : spec.layout.sizingV) === 'HUG';
      const [primary, counter] = String(spec.layout.align || '/').split('/');
      if (ALIGN[primary] && !mainHug) push('justify-content', 'align', ALIGN[primary]);
      if (ALIGN[counter] && !crossHug) push('align-items', 'align', ALIGN[counter]);
    }
  }
  // Node participating in parent flex.
  // NB: Figma layoutGrow (fill) and layoutAlign=STRETCH are deliberately NOT
  // asserted (flex-grow / align-self) — both are fill MECHANISMS the code can
  // achieve many ways (width:100%, stretch, center-on-hug), and STRETCH is
  // routinely overridden by a HUG-sized axis. Actual size/fill is verified by
  // the geometry (w/h) checks instead, which compare the rendered result.

  // ── Size clamps + fixed geometry (compared against captured rect) ──
  if (spec.size) for (const [k, css] of [['minWidth', 'min-width'], ['maxWidth', 'max-width'], ['minHeight', 'min-height'], ['maxHeight', 'max-height']])
    if (spec.size[k] != null) push(css, 'px', spec.size[k] + 'px');
  if (spec.layout && spec.layout.sizingH === 'FIXED' && spec.w != null) push('w', 'px', spec.w, 'rect');
  if (spec.layout && spec.layout.sizingV === 'FIXED' && spec.h != null) push('h', 'px', spec.h, 'rect');

  // ── Text ──
  if (spec.type === 'TEXT' && spec.text) {
    const T = spec.text;
    if (T.size != null) push('font-size', 'px', T.size + 'px');
    if (typeof T.lh === 'number') push('line-height', 'px', T.lh + 'px');
    const fam = famOf(T.font); if (fam) push('font-family', 'contains', fam);
    const wt = weightOf(T.weight || (T.font ? T.font.split(' ').pop() : null)); if (wt) push('font-weight', 'weight', wt);
    const ls = lsPx(T.ls, T.size); if (ls != null && ls !== 0) push('letter-spacing', 'px', ls + 'px');
    if (T.case) push('text-transform', 'exact', { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize', SMALL_CAPS: 'uppercase' }[T.case] || 'none');
    if (T.decoration) push('text-decoration-line', 'contains', { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' }[T.decoration] || 'none');
  }
  return checks;
}

// Intentional, approved deviations from the Figma spec — cases where the panel
// deliberately differs (a design defect we corrected). Keyed {figId: {cssProp:
// reason}}. A deviating check is reported separately, not counted as a failure,
// so the tool stays green while the divergence stays visible and documented.
const DEVIATIONS = {
  // (none — the reply tray keeps Figma's 24px padding; it lands flush with the
  // input by living inside the shared 6px-inset .input-overlays container.)
};

// ── Diff every anchored node ─────────────────────────────────────────────────
const rows = [];
const deviations = []; // intentional, allow-listed differences
const missingAnchors = []; // data-fig present in DOM but no Figma spec node
for (const [fig, el] of capById) {
  const spec = specById.get(fig);
  if (!spec) { missingAnchors.push({ fig, cls: el.cls, id: el.id, state: el._state }); continue; }
  // Structural: an anchored node that Figma paints/texts but the panel collapses
  // to a 0×0 box in every captured state is a real "not rendered" failure, not a pass.
  if (el.box0 && (spec.fill || spec.stroke || spec.type === 'TEXT' || spec.radius != null)) {
    rows.push({ fig, name: spec.name, state: el._state, sel: el.id || el.cls || el.tag, prop: 'render', ok: false, actual: '0×0 box', expected: 'visible' });
  }
  const FLEXQ = new Set(['justify-content', 'align-items', 'flex-direction', 'flex-grow', 'align-self']);
  const codeIsFlex = /flex/.test(el.style.display || '');
  for (const c of expectedChecks(spec)) {
    // A Figma auto-layout achieved with block/inline in code is not a bug — only
    // compare flex properties where the code element is genuinely a flex box.
    if (FLEXQ.has(c.prop) && !codeIsFlex) continue;
    // position:fixed elements are sized by inset (full-viewport overlays), not by
    // an intrinsic w/h — their size ≠ the Figma artboard frame, so skip geometry.
    if (c.src === 'rect' && el.style.position === 'fixed') continue;
    // Geometry checks read the captured rect; everything else reads computed style.
    const actual = c.src === 'rect' ? (el.rect ? el.rect[c.prop] : null) : el.style[c.prop];
    const ok = cmp(c.kind, actual, c.expected);
    const reason = DEVIATIONS[fig] && DEVIATIONS[fig][c.prop];
    if (!ok && reason) {
      deviations.push({ fig, name: spec.name, prop: c.prop, actual, expected: c.expected, reason });
      continue; // approved divergence — not a failure
    }
    rows.push({ fig, name: spec.name, state: el._state, sel: el.id || el.cls || el.tag, prop: c.prop, ok, actual, expected: c.expected });
  }
}

// ── Coverage ledger: visible Figma nodes with paint/text/radius but no anchor ─
const anchored = new Set(capById.keys());
const coverageGaps = [];
for (const [id, spec] of specById) {
  if (spec.hidden) continue;
  if (anchored.has(id)) continue;
  const visual = spec.fill || spec.stroke || spec.radius != null || (spec.type === 'TEXT');
  if (!visual) continue;
  coverageGaps.push({ id, name: spec.name, type: spec.type, root: spec._root,
    fill: spec.fill || null, text: spec.type === 'TEXT' && spec.text ? `${spec.text.size}/${spec.text.lh}` : null });
}
writeFileSync(join(JSON_DIR, 'parity-coverage.json'), JSON.stringify({
  anchoredNodes: anchored.size,
  checkedProps: rows.length,
  coverageGapCount: coverageGaps.length,
  coverageGaps,
  missingAnchors,
}, null, 2));

// ── Report ───────────────────────────────────────────────────────────────────
const fails = rows.filter((r) => !r.ok);
const byNode = new Map();
for (const r of rows) { if (!byNode.has(r.fig)) byNode.set(r.fig, []); byNode.get(r.fig).push(r); }

for (const [fig, list] of byNode) {
  const bad = list.filter((r) => !r.ok);
  const head = `${bad.length ? 'FAIL' : 'PASS'}  ${fig}  ${list[0].name}  [${list[0].state}/${list[0].sel}]`;
  console.log(head);
  for (const r of bad) console.log(`        ✗ ${r.prop}: actual ${JSON.stringify(r.actual)}  expected ${r.expected}`);
}

if (deviations.length) {
  console.log(`\n◆ ${deviations.length} intentional deviation(s) from Figma (allow-listed):`);
  for (const d of deviations) console.log(`   ${d.fig} ${d.name} · ${d.prop}: ${d.actual} (Figma ${d.expected}) — ${d.reason}`);
}

if (missingAnchors.length) {
  console.log(`\n⚠ ${missingAnchors.length} data-fig anchor(s) reference no Figma node (stale id?):`);
  for (const m of missingAnchors) console.log(`   ${m.fig}  (${m.state}/${m.id || m.cls})`);
}

console.log(`\nAnchored nodes: ${anchored.size} · props checked: ${rows.length} · mismatches: ${fails.length} · deviations: ${deviations.length}`);
console.log(`Coverage ledger → design/refs/json/parity-coverage.json (${coverageGaps.length} un-anchored visual nodes)`);
process.exit(fails.length || missingAnchors.length ? 1 : 0);
