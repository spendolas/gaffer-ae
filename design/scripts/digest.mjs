#!/usr/bin/env node
// Figma parity audit — Phase C digester.
// Consumes the raw walk JSON + css-inventory and emits:
//   design/tokens.json            — token map w/ proposed CSS custom props
//   design/refs/json/token-deltas.json — figma token vs current code literals
//   design/refs/json/spec-<slug>.json  — flattened per-node style spec per walk root
//   design/refs/json/flags.json   — non-CSS-expressible props, overflow gaps, constraint map
// Prints a compact summary only.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFS = join(__dirname, '..', 'refs');
const J = (f) => JSON.parse(readFileSync(join(REFS, 'json', f), 'utf8'));

// ── tokens.json ──
const collections = J('variables.json');
const vars = collections[0].variables;
const varById = {};
const tokens = vars.map((v) => {
  const value = Object.values(v.valuesByMode)[0];
  const cssProp = '--' + v.name.replace(/\//g, '-');
  varById[v.id] = { name: v.name, value, cssProp };
  return { figma: v.name, id: v.id, type: v.resolvedType, value, cssProp };
});
writeFileSync(join(REFS, '..', 'tokens.json'), JSON.stringify({ collection: collections[0].name, tokens }, null, 2));

// ── token deltas vs code color census ──
const inv = JSON.parse(readFileSync(join(REFS, 'panel', 'css-inventory.json'), 'utf8'));
const codeColors = {};
for (const file of Object.keys(inv.colorCensus)) {
  for (const [color, locs] of Object.entries(inv.colorCensus[file])) {
    (codeColors[color] = codeColors[color] || []).push(...locs);
  }
}
function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length < 6) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function parseColor(s) {
  if (s.startsWith('#')) return hexToRgb(s);
  const m = s.match(/rgba?\(([^)]*)\)/);
  if (m) { const p = m[1].split(',').map(Number); return p.slice(0, 3); }
  return null;
}
const dist = (a, b) => Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
const deltas = [];
for (const t of tokens) {
  if (t.type !== 'COLOR') continue;
  const rgb = hexToRgb(t.value.hex);
  const matches = [];
  for (const [color, locs] of Object.entries(codeColors)) {
    const crgb = parseColor(color);
    if (!crgb) continue;
    const d = dist(rgb, crgb);
    if (d < 60) matches.push({ color, distance: Math.round(d), locations: locs.slice(0, 6), exact: d === 0 });
  }
  matches.sort((a, b) => a.distance - b.distance);
  deltas.push({ token: t.figma, hex: t.value.hex, opacity: t.value.opacity, matches: matches.slice(0, 4) });
}
writeFileSync(join(REFS, 'json', 'token-deltas.json'), JSON.stringify(deltas, null, 2));

// ── per-walk spec digests + flags ──
const flags = { nonCss: [], overflow: [], blend: [], constraints: {} };
function resolveFill(node) {
  const bound = node.boundVariables && node.boundVariables.fills;
  const varName = bound && bound[0] && varById[bound[0].variableId] ? varById[bound[0].variableId].name : null;
  const f = Array.isArray(node.fills) && node.fills[0] && node.fills[0].visible !== false ? node.fills[0] : null;
  const raw = f && f.type === 'SOLID' && f.color
    ? '#' + [f.color.r, f.color.g, f.color.b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('') + (f.opacity != null && f.opacity !== 1 ? '@' + f.opacity.toFixed(2) : '')
    : f ? f.type : null;
  return varName ? varName + ' (' + raw + ')' : raw;
}
function digestNode(n, out, depth, path) {
  // Hidden layers must not masquerade as design spec (assistant-bubble
  // borders, default-hidden overlays). Record top-level hidden components
  // as stubs so state-conditional elements stay discoverable, then stop.
  if (n.visible === false) {
    out.push({ id: n.id, name: n.name, type: n.type, depth, hidden: true });
    return;
  }
  const entry = {
    id: n.id, name: n.name, type: n.type, depth,
    w: n.width != null ? Math.round(n.width * 100) / 100 : null,
    h: n.height != null ? Math.round(n.height * 100) / 100 : null,
  };
  if (n.layoutMode && n.layoutMode !== 'NONE') {
    entry.layout = {
      dir: n.layoutMode, gap: n.itemSpacing,
      pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
      sizingH: n.layoutSizingHorizontal, sizingV: n.layoutSizingVertical,
      align: n.primaryAxisAlignItems + '/' + n.counterAxisAlignItems,
    };
  }
  const fill = resolveFill(n);
  if (fill) entry.fill = fill;
  if (n.strokes && n.strokes.length && n.strokes[0].visible !== false && (n.strokeWeight || 0) > 0) {
    const s = n.strokes[0];
    const sc = s.color ? '#' + [s.color.r, s.color.g, s.color.b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('') : s.type;
    const sBound = n.boundVariables && n.boundVariables.strokes;
    const sVar = sBound && sBound[0] && varById[sBound[0].variableId] ? varById[sBound[0].variableId].name : null;
    entry.stroke = (sVar ? sVar + ' ' : '') + sc + ' w' + n.strokeWeight + ' ' + (n.strokeAlign || '');
    if (n.strokeAlign && n.strokeAlign !== 'INSIDE') flags.nonCss.push({ id: n.id, name: n.name, prop: 'strokeAlign=' + n.strokeAlign, path });
  }
  if (n.cornerRadius != null && n.cornerRadius !== 0) entry.radius = n.cornerRadius;
  if (n.topLeftRadius != null && (n.topLeftRadius || n.topRightRadius || n.bottomLeftRadius || n.bottomRightRadius) && n.cornerRadius == null) {
    entry.radius = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
  }
  if (n.cornerSmoothing) { entry.cornerSmoothing = n.cornerSmoothing; flags.nonCss.push({ id: n.id, name: n.name, prop: 'cornerSmoothing=' + n.cornerSmoothing, path }); }
  if (n.blendMode && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH') flags.blend.push({ id: n.id, name: n.name, blend: n.blendMode, path });
  if (n.effects && n.effects.length) {
    entry.effects = n.effects.filter((e) => e.visible !== false).map((e) => e.type + (e.radius != null ? ' r' + e.radius : '') + (e.spread ? ' s' + e.spread : ''));
    if (entry.effects.some((e) => e.startsWith('BACKGROUND_BLUR'))) flags.nonCss.push({ id: n.id, name: n.name, prop: 'backgroundBlur', path });
    if (!entry.effects.length) delete entry.effects;
  }
  if (n.type === 'TEXT') {
    entry.text = {
      chars: (n.characters || '').slice(0, 60),
      font: n.fontName ? n.fontName.family + ' ' + n.fontName.style : null,
      size: n.fontSize,
      lh: n.lineHeight && n.lineHeight.unit !== 'AUTO' ? Math.round((n.lineHeight.unit === 'PERCENT' ? n.fontSize * n.lineHeight.value / 100 : n.lineHeight.value) * 10) / 10 : 'auto',
      ls: n.letterSpacing && n.letterSpacing.value ? n.letterSpacing.value + n.letterSpacing.unit : 0,
      resize: n.textAutoResize, align: n.textAlignHorizontal,
      truncation: n.textTruncation || null, maxLines: n.maxLines || null,
    };
    if (!n.textTruncation || n.textTruncation === 'DISABLED') flags.overflow.push({ id: n.id, name: n.name, path, resize: n.textAutoResize });
  }
  if (n.constraints) {
    const key = n.constraints.horizontal + '/' + n.constraints.vertical;
    flags.constraints[key] = (flags.constraints[key] || 0) + 1;
  }
  out.push(entry);
  for (const c of n.children || []) digestNode(c, out, depth + 1, path + '/' + (c.name || c.id));
}

const summary = {};
for (const f of readdirSync(join(REFS, 'json'))) {
  if (!f.startsWith('walk-')) continue;
  const slug = f.replace(/^walk-|\.json$/g, '');
  const out = [];
  digestNode(J(f), out, 0, slug);
  writeFileSync(join(REFS, 'json', 'spec-' + slug + '.json'), JSON.stringify(out, null, 1));
  summary[slug] = out.length;
}
writeFileSync(join(REFS, 'json', 'flags.json'), JSON.stringify(flags, null, 2));

console.log(JSON.stringify({
  tokens: tokens.length,
  colorTokensWithExactCodeMatch: deltas.filter((d) => d.matches[0] && d.matches[0].exact).length,
  colorTokensNoCodeMatch: deltas.filter((d) => !d.matches.length).length,
  specNodes: summary,
  nonCssFlags: flags.nonCss.length,
  blendFlags: flags.blend.length,
  overflowUnspecified: flags.overflow.length,
}));
