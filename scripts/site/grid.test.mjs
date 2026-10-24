import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureZones, fadeCard, rowFadeTarget } from '../../site/js/grid.js';

// A fake element whose box is fixed (left/width only matter for the zero-size check).
const box = (top, bottom, width = 100) => ({ getBoundingClientRect: () => ({ top, bottom, height: bottom - top, left: 0, right: width, width }) });
const view = { top: 0, bottom: 900 };

test('measureZones returns the headline box and the union of the dock pill and note', () => {
  const zones = measureZones({ headline: [box(574, 762)], dock: [box(799, 856), box(864, 876)] }, view);
  assert.deepEqual(zones, [
    { kind: 'headline', top: 574, bottom: 762 },
    { kind: 'dock', top: 799, bottom: 876 },
  ]);
});

test('measureZones ignores zero-sized boxes, empty kinds and zones outside the viewport', () => {
  assert.deepEqual(measureZones({ headline: [box(500, 500)], dock: [box(800, 850, 0)] }, view), []);
  assert.deepEqual(measureZones({ headline: [], dock: [box(800, 850), box(0, 0, 0)] }, view), [{ kind: 'dock', top: 800, bottom: 850 }]);
  assert.deepEqual(measureZones({ headline: [box(900, 950)], dock: [box(-80, 0)] }, view), [], 'touching the edge from outside is outside');
  assert.deepEqual(measureZones({ headline: [box(880, 950)] }, view), [{ kind: 'headline', top: 880, bottom: 950 }], 'partly inside counts');
  assert.deepEqual(measureZones({}, view), []);
  assert.deepEqual(measureZones(undefined, view), []);
});

test('measureZones keeps overlapping zones (phone headline over the dock)', () => {
  const zones = measureZones({ headline: [box(783, 844)], dock: [box(743, 820)] }, { top: 0, bottom: 844 });
  assert.deepEqual(zones, [{ kind: 'headline', top: 783, bottom: 844 }, { kind: 'dock', top: 743, bottom: 820 }]);
});

// Fake card: records every opacity write.
function card() {
  const writes = [];
  const style = {};
  Object.defineProperty(style, 'opacity', { set: (v) => writes.push(v), get: () => writes.at(-1) ?? '' });
  return { el: { style }, op: 1, writes };
}

test('fadeCard writes only when the value moves by more than 0.01', () => {
  const c = card();
  assert.equal(fadeCard(c, 0.25), true);
  assert.deepEqual(c.writes, ['0.25']);
  assert.equal(fadeCard(c, 0.255), false);
  assert.equal(fadeCard(c, 0.259), false);
  assert.equal(fadeCard(c, 0.241), false);
  assert.equal(fadeCard(c, 0.27), true);
  assert.deepEqual(c.writes, ['0.25', '0.27']);
  assert.equal(c.op, 0.27);
});

test('fadeCard resets to the stylesheet value when the target is 1, even from within 0.01', () => {
  const c = card();
  fadeCard(c, 0.995);
  assert.deepEqual(c.writes, []); // within 0.01 of the start (1)
  fadeCard(c, 0.5);
  fadeCard(c, 0.995);
  fadeCard(c, 1);
  assert.deepEqual(c.writes, ['0.5', '0.995', '']);
  assert.equal(fadeCard(c, 1), false, 'already reset');
});

test('fadeCard writes nothing on repeated identical frames (idle stays write-free)', () => {
  const c = card();
  fadeCard(c, 0.4);
  const before = c.writes.length;
  for (let i = 0; i < 120; i++) fadeCard(c, 0.4);
  assert.equal(c.writes.length, before);
});

// rowFadeTarget: the opacity a near card should have, from its quad in stage-centred px.
const quad = (y0, y1) => ({ tl: { x: 0, y: y0 }, tr: { x: 10, y: y0 + 2 }, bl: { x: 0, y: y1 - 2 }, br: { x: 10, y: y1 } });
const fader = (o = {}) => ({ mode: 'rows', rowOpacity: 0.25, rowSpread: 0, headlineStrength: 1, dockStrength: 1, ...o });

test('rowFadeTarget dims a tile by its overlap with the band and leaves the rest at 1', () => {
  const zones = [{ top: 100, bottom: 200, strength: 1 }];
  assert.equal(rowFadeTarget(quad(110, 190), zones, fader()), 0.25); // fully inside the band
  assert.equal(rowFadeTarget(quad(150, 250), zones, fader()), 0.625); // half overlapping: halfway
  assert.equal(rowFadeTarget(quad(201, 300), zones, fader()), 1);
  const feathered = rowFadeTarget(quad(210, 310), zones, fader({ rowSpread: 40 })); // 10 px clear: a little feather
  assert.ok(feathered < 1 && feathered > 0.85, `${feathered}`);
  assert.equal(rowFadeTarget(quad(240, 340), zones, fader({ rowSpread: 40 })), 1); // clear by the spread
});

test('rowFadeTarget uses the quad extremes, not just the top-left corner', () => {
  const zones = [{ top: 100, bottom: 200, strength: 1 }];
  // tl.y 190 but tr.y 150: the extent starts at 150, half inside the band (not 10 of 60 from tl alone).
  assert.equal(rowFadeTarget({ tl: { x: 0, y: 190 }, tr: { x: 1, y: 150 }, bl: { x: 0, y: 250 }, br: { x: 1, y: 250 } }, zones, fader()), 0.625);
});

test('rowFadeTarget is 1 in ellipse and off modes and for a card with no quad', () => {
  const zones = [{ top: 100, bottom: 200, strength: 1 }];
  assert.equal(rowFadeTarget(quad(150, 250), zones, fader({ mode: 'ellipse' })), 1);
  assert.equal(rowFadeTarget(quad(150, 250), zones, fader({ mode: 'off' })), 1);
  assert.equal(rowFadeTarget(quad(150, 250), zones, fader({ mode: 'both' })), 0.625);
  assert.equal(rowFadeTarget(null, zones, fader()), 1);
});

test('a frame of fake cards: parked cards are untouched, a mode switch resets the faded ones', () => {
  const zones = [{ top: 100, bottom: 200, strength: 1 }];
  const cards = [
    { ...card(), quad: quad(150, 250) },
    { ...card(), quad: quad(500, 600) },
    { ...card(), quad: null }, // parked
  ];
  // Same loop shape as grid.js writeCards: parked cards are skipped before any opacity work.
  const frame = (f) => cards.reduce((n, c) => (c.quad && fadeCard(c, rowFadeTarget(c.quad, zones, f)) ? n + 1 : n), 0);
  assert.equal(frame(fader()), 1);
  assert.deepEqual(cards.map((c) => c.writes), [['0.625'], [], []]);
  assert.equal(frame(fader()), 0, 'unchanged geometry: no writes');
  assert.equal(frame(fader({ mode: 'ellipse' })), 1);
  assert.deepEqual(cards.map((c) => c.writes), [['0.625', ''], [], []]);
  assert.equal(frame(fader({ mode: 'off' })), 0);
});
