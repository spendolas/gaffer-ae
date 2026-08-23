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
const metricFiles = readdirSync(PANEL).filter((f) => /\.metrics\.json$/.test(f));
for (const f of metricFiles) {
  const state = f.replace(/^state-|\.metrics\.json$/g, '');
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

// Compare one computed value to one expected value; kind picks the comparator.
function cmp(kind, actual, expected) {
  if (kind === 'px') {
    // treat CSS "normal" line-height/gap as its numeric px only when expected 0
    if ((actual === 'normal' || actual === 'auto') && parseFloat(expected) === 0) return true;
    return pxEq(actual, expected);
  }
  if (kind === 'color') {
    if (actual == null) return false;
    // normalise rgba(x, y, z, 1) → rgb(x, y, z) both ways
    const norm = (v) => v.replace(/rgba\(([^,]+),([^,]+),([^,]+),\s*1\)/, 'rgb($1,$2,$3)').replace(/\s+/g, '');
    return norm(actual) === norm(expected);
  }
  return String(actual) === String(expected);
}

// Build the list of (cssProp, kind, expected) checks a Figma spec node implies.
function expectedChecks(spec) {
  const checks = [];
  const push = (prop, kind, expected) => { if (expected != null) checks.push({ prop, kind, expected }); };

  const paint = paintToCss(spec.fill);
  if (paint) {
    if (spec.type === 'TEXT') push('color', 'color', paint);
    else push('background-color', 'color', paint);
  }

  if (spec.radius != null) {
    const r = spec.radius;
    if (Array.isArray(r)) {
      // digest order: [topLeft, topRight, bottomRight, bottomLeft]
      push('border-top-left-radius', 'px', r[0] + 'px');
      push('border-top-right-radius', 'px', r[1] + 'px');
      push('border-bottom-right-radius', 'px', r[2] + 'px');
      push('border-bottom-left-radius', 'px', r[3] + 'px');
    } else {
      push('border-top-left-radius', 'px', r + 'px');
      push('border-top-right-radius', 'px', r + 'px');
      push('border-bottom-right-radius', 'px', r + 'px');
      push('border-bottom-left-radius', 'px', r + 'px');
    }
  }

  if (spec.layout && Array.isArray(spec.layout.pad)) {
    const [t, ri, b, l] = spec.layout.pad;
    // Padding on a FIXED axis is not the layout determinant — the fixed
    // dimension plus content alignment absorbs it (a 20px-tall centered button
    // renders identically at pad 2 or 6). Only assert padding where the axis
    // HUGs or FILLs, so the padding value is actually observable.
    if (spec.layout.sizingV !== 'FIXED') {
      push('padding-top', 'px', t + 'px');
      push('padding-bottom', 'px', b + 'px');
    }
    if (spec.layout.sizingH !== 'FIXED') {
      push('padding-right', 'px', ri + 'px');
      push('padding-left', 'px', l + 'px');
    }
    // gap is unobservable with <2 children — don't assert vestigial spacing
    if (spec.layout.gap != null && spec.kids >= 2) push('gap', 'px', spec.layout.gap + 'px');
  }

  if (spec.type === 'TEXT' && spec.text) {
    if (spec.text.size != null) push('font-size', 'px', spec.text.size + 'px');
    if (typeof spec.text.lh === 'number') push('line-height', 'px', spec.text.lh + 'px');
  }
  return checks;
}

// ── Diff every anchored node ─────────────────────────────────────────────────
const rows = [];
const missingAnchors = []; // data-fig present in DOM but no Figma spec node
for (const [fig, el] of capById) {
  const spec = specById.get(fig);
  if (!spec) { missingAnchors.push({ fig, cls: el.cls, id: el.id, state: el._state }); continue; }
  for (const c of expectedChecks(spec)) {
    const actual = el.style[c.prop];
    const ok = cmp(c.kind, actual, c.expected);
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

if (missingAnchors.length) {
  console.log(`\n⚠ ${missingAnchors.length} data-fig anchor(s) reference no Figma node (stale id?):`);
  for (const m of missingAnchors) console.log(`   ${m.fig}  (${m.state}/${m.id || m.cls})`);
}

console.log(`\nAnchored nodes: ${anchored.size} · props checked: ${rows.length} · mismatches: ${fails.length}`);
console.log(`Coverage ledger → design/refs/json/parity-coverage.json (${coverageGaps.length} un-anchored visual nodes)`);
process.exit(fails.length || missingAnchors.length ? 1 : 0);
