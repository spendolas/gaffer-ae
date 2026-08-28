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
// Iterate ALL variable collections and ALL modes — never assume one of either.
const collections = J('variables.json');
const varById = {};
const tokens = [];
for (const coll of collections) {
  for (const v of coll.variables || []) {
    const modeVals = Object.values(v.valuesByMode || {});
    const value = modeVals[0];
    const cssProp = '--' + v.name.replace(/\//g, '-');
    // Surface (don't silently pick mode 0) when a variable forks across modes.
    const multiMode = modeVals.length > 1 && modeVals.some((m) => JSON.stringify(m) !== JSON.stringify(value));
    varById[v.id] = { name: v.name, value, cssProp };
    tokens.push({ figma: v.name, id: v.id, type: v.resolvedType, value, cssProp,
      collection: coll.name,
      ...(multiMode ? { modes: v.valuesByMode } : {}) });
  }
}
writeFileSync(join(REFS, '..', 'tokens.json'),
  JSON.stringify({ collection: collections[0] && collections[0].name,
    collections: collections.map((c) => c.name), tokens }, null, 2));

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
// grip's export_node flattens a colour to {hex,opacity}; the plugin API shape is
// {color:{r,g,b},opacity}. Handle both so a format change can't silently blank
// every colour (it did: paints were emitting "(SOLID)" with no hex).
function colHex(c) {
  if (!c) return null;
  if (typeof c.hex === 'string') return c.hex.toUpperCase();
  if (c.r != null) return '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  return null;
}
// A paint's hex + its own opacity, both export shapes.
function paintHexOp(p) {
  const hex = typeof p.hex === 'string' ? p.hex.toUpperCase() : colHex(p.color);
  return hex ? hex + (p.opacity != null && p.opacity !== 1 ? '@' + p.opacity.toFixed(2) : '') : null;
}
// Bound variable for a paint: per-paint boundVariable (walk) OR node.boundVariables[kind][i] (API).
function paintVar(p, node, kind, i) {
  const id = (p && p.boundVariable && p.boundVariable.id)
    || (node.boundVariables && node.boundVariables[kind] && node.boundVariables[kind][i] && node.boundVariables[kind][i].variableId);
  return id && varById[id] ? varById[id].name : null;
}
// Format one paint → "token/name (#rrggbb@op)" | "#rrggbb@op" | "<TYPE>".
function paintStr(p, varName) {
  const raw = p && p.type === 'SOLID' ? (paintHexOp(p) || p.type) : p ? p.type : null;
  return varName ? varName + ' (' + raw + ')' : raw;
}
// ALL visible fills, bottom→top (Figma paints render fills[0] at the BOTTOM).
// A layered surface (base + rest-overlay) needs every layer, not fills[0] —
// the code paints it as `linear-gradient(overlay), base`, so the diff derives
// background-color from fills[0] and background-image from fills[1..].
function resolveFills(node) {
  if (!Array.isArray(node.fills)) return [];
  const out = [];
  node.fills.forEach((f, i) => {
    if (!f || f.visible === false) return;
    out.push({ str: paintStr(f, paintVar(f, node, 'fills', i)), type: f.type, blend: f.blendMode !== 'NORMAL' ? f.blendMode : null });
  });
  return out;
}
// Back-compat scalar: the bottom (base) fill string.
function resolveFill(node) { const fs = resolveFills(node); return fs.length ? fs[0].str : null; }
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
    // visible child count — gap is only observable with ≥2 children, so the
    // diff gates its gap assertion on this (avoids flagging vestigial spacing).
    kids: (n.children || []).filter((c) => c.visible !== false).length,
  };
  if (n.layoutMode && n.layoutMode !== 'NONE') {
    entry.layout = {
      dir: n.layoutMode, gap: n.itemSpacing,
      pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
      sizingH: n.layoutSizingHorizontal, sizingV: n.layoutSizingVertical,
      align: n.primaryAxisAlignItems + '/' + n.counterAxisAlignItems,
    };
    if (n.layoutWrap === 'WRAP') { entry.layout.wrap = true; if (n.counterAxisSpacing) entry.layout.crossGap = n.counterAxisSpacing; }
    if (n.itemReverseZIndex) entry.layout.reverseZ = true;   // flips child paint order
  }
  // How this node participates in its PARENT's auto-layout (independent of its
  // own layoutMode). ABSOLUTE children escape flow → need position, not flex.
  if (n.layoutPositioning === 'ABSOLUTE') {
    entry.abs = { x: Math.round(n.x), y: Math.round(n.y) };   // → position:absolute; left/top
  } else {
    if (n.layoutGrow) entry.grow = n.layoutGrow;               // → flex-grow
    if (n.layoutAlign === 'STRETCH') entry.stretch = true;     // → align-self:stretch
  }
  const fills = resolveFills(n);
  if (fills.length) {
    entry.fill = fills[0].str;              // base (bottom) — back-compat scalar
    if (fills.length > 1) entry.fills = fills.map((f) => f.str); // layered → all, bottom→top
    fills.forEach((f) => { if (f.blend) flags.blend.push({ id: n.id, name: n.name, blend: 'fill:' + f.blend, path }); });
  }
  // Layer opacity (e.g. State=Disabled dims the whole component to .4).
  if (n.opacity != null && n.opacity !== 1) entry.opacity = Math.round(n.opacity * 100) / 100;
  // clipsContent → overflow:hidden. Emit both true/false; a container that
  // should clip (scroll mask, rounded-corner clip) rendering visible = a real bug.
  if (typeof n.clipsContent === 'boolean' && (n.layoutMode == null || n.layoutMode === 'NONE' ? n.clipsContent : true))
    entry.clip = n.clipsContent;
  if (n.rotation) entry.rotation = Math.round(n.rotation * 100) / 100;   // transform: rotate()
  if (n.targetAspectRatio && n.targetAspectRatio.x && n.targetAspectRatio.y)
    entry.aspect = Math.round((n.targetAspectRatio.x / n.targetAspectRatio.y) * 1000) / 1000;
  for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'])
    if (n[k] != null) (entry.size = entry.size || {})[k] = n[k];
  const sides = [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight];
  const anySide = sides.some((w) => (w || 0) > 0);
  // EVERY visible stroke paint (eye-closed ones are not applied). Geometry
  // (weight/align/dash/cap/join) is shared by the node; colours stack.
  const strokeColors = [];
  (n.strokes || []).forEach((s, i) => {
    if (!s || s.visible === false) return;
    const sc = paintHexOp(s) || s.type;
    const sVar = paintVar(s, n, 'strokes', i);
    strokeColors.push(sVar ? sVar + ' (' + sc + ')' : sc);
  });
  if (strokeColors.length && ((n.strokeWeight || 0) > 0 || anySide)) {
    const uniform = sides.every((w) => w === sides[0]);
    entry.stroke = {
      color: strokeColors[0],                              // base (diff compares border-color)
      ...(strokeColors.length > 1 ? { colors: strokeColors } : {}), // all stacked paints
      w: uniform ? (n.strokeWeight || sides[0]) : sides,
      align: n.strokeAlign || 'INSIDE',
      dash: Array.isArray(n.dashPattern) && n.dashPattern.length ? n.dashPattern : null, // → border-style dashed/dotted
      cap: n.strokeCap && n.strokeCap !== 'NONE' ? n.strokeCap : null,
      join: n.strokeJoin && n.strokeJoin !== 'MITER' ? n.strokeJoin : null,
    };
    if (n.strokeAlign && n.strokeAlign !== 'INSIDE') flags.nonCss.push({ id: n.id, name: n.name, prop: 'strokeAlign=' + n.strokeAlign, path });
  }
  if (n.cornerRadius != null && n.cornerRadius !== 0) entry.radius = n.cornerRadius;
  if (n.topLeftRadius != null && (n.topLeftRadius || n.topRightRadius || n.bottomLeftRadius || n.bottomRightRadius) && n.cornerRadius == null) {
    entry.radius = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
  }
  if (n.cornerSmoothing) { entry.cornerSmoothing = n.cornerSmoothing; flags.nonCss.push({ id: n.id, name: n.name, prop: 'cornerSmoothing=' + n.cornerSmoothing, path }); }
  if (n.blendMode && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH') flags.blend.push({ id: n.id, name: n.name, blend: n.blendMode, path });
  if (n.effects && n.effects.length) {
    // Structured so the diff can derive box-shadow: type(inset?), offset x/y,
    // blur radius, spread, colour. DROP_SHADOW→box-shadow, INNER_SHADOW→inset.
    entry.effects = n.effects.filter((e) => e.visible !== false).map((e) => ({
      type: e.type,
      x: e.offset ? Math.round(e.offset.x) : 0,
      y: e.offset ? Math.round(e.offset.y) : 0,
      blur: e.radius != null ? e.radius : 0,
      spread: e.spread || 0,
      color: e.color ? colHex(e.color) + (e.color.opacity != null && e.color.opacity !== 1 ? '@' + e.color.opacity.toFixed(2) : '') : null,
    }));
    if (entry.effects.some((e) => e.type === 'BACKGROUND_BLUR')) flags.nonCss.push({ id: n.id, name: n.name, prop: 'backgroundBlur', path });
    if (!entry.effects.length) delete entry.effects;
  }
  if (n.type === 'TEXT') {
    // A text-range fill overrides the layer fill on the actual glyphs — the
    // rendered color is textRangeFills, not fills[0]. Missing this made the
    // reply-quote text read as #C2C0BC (layer default) when it paints #888888.
    // Iterate ALL range fills — a text node can carry mixed-colour ranges.
    const trf = (n.boundVariables && n.boundVariables.textRangeFills) || [];
    const rangeFills = [];
    for (const t of trf) {
      const v = t && varById[t.variableId];
      if (!v) continue;
      const op = v.value && v.value.opacity != null && v.value.opacity !== 1 ? '@' + v.value.opacity.toFixed(2) : '';
      rangeFills.push(v.name + ' (' + v.value.hex + op + ')');
    }
    const uniqRange = [...new Set(rangeFills)];
    if (uniqRange.length) {
      entry.fill = uniqRange[0];                                   // dominant glyph colour
      if (uniqRange.length > 1) entry.textFills = uniqRange;       // mixed ranges → flag all
    }
    entry.text = {
      chars: (n.characters || '').slice(0, 60),
      font: n.fontName ? n.fontName.family + ' ' + n.fontName.style : null,
      size: n.fontSize,
      lh: n.lineHeight && n.lineHeight.unit !== 'AUTO' ? Math.round((n.lineHeight.unit === 'PERCENT' ? n.fontSize * n.lineHeight.value / 100 : n.lineHeight.value) * 10) / 10 : 'auto',
      ls: n.letterSpacing && n.letterSpacing.value ? n.letterSpacing.value + n.letterSpacing.unit : 0,
      weight: n.fontWeight || (n.fontName ? n.fontName.style : null),
      resize: n.textAutoResize, align: n.textAlignHorizontal,
      valign: n.textAlignVertical && n.textAlignVertical !== 'TOP' ? n.textAlignVertical : null, // → align-items on the text box
      case: n.textCase && n.textCase !== 'ORIGINAL' ? n.textCase : null,                          // → text-transform
      decoration: n.textDecoration && n.textDecoration !== 'NONE' ? n.textDecoration : null,      // → text-decoration
      paraSpacing: n.paragraphSpacing || null, paraIndent: n.paragraphIndent || null,
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
