import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faderAlpha, grainAt, parseHex, faderParams, renderFaderPixels } from '../../site/js/fader.js';

test('faderAlpha is solid inside the softness radius, 0 on and beyond the rim, and eases between', () => {
  assert.equal(faderAlpha(0, 0.18), 1);
  assert.equal(faderAlpha(0.18, 0.18), 1);
  assert.equal(faderAlpha(1, 0.18), 0);
  assert.equal(faderAlpha(1.4, 0.18), 0);
  assert.ok(Math.abs(faderAlpha(0.18 + (1 - 0.18) / 2, 0.18) - 0.5) < 1e-9, 'halfway through the fall is half alpha');
  let prev = 1;
  for (let r = 0; r <= 1.0001; r += 0.01) {
    const a = faderAlpha(r, 0.18);
    assert.ok(a <= prev + 1e-12, `non-increasing at ${r}`);
    prev = a;
  }
  assert.equal(faderAlpha(0.3, 0), faderAlpha(0.3, -5), 'softness clamps at 0');
  assert.equal(faderAlpha(0.99, 1), 1, 'softness 1 is a hard edge (solid right up to the rim)');
});

test('grainAt is deterministic, in [0, 1) and unbiased', () => {
  let sum = 0;
  const n = 200000;
  for (let i = 0; i < n; i++) {
    const g = grainAt(i % 1000, Math.floor(i / 1000));
    assert.ok(g >= 0 && g < 1);
    sum += g;
  }
  assert.ok(Math.abs(sum / n - 0.5) < 0.005, `mean ${sum / n}`);
  assert.equal(grainAt(12, 34), grainAt(12, 34));
  assert.notEqual(grainAt(12, 34), grainAt(34, 12));
});

test('parseHex reads #RGB and #RRGGBB and falls back to the stage black', () => {
  assert.deepEqual(parseHex('#4A7DC9'), [74, 125, 201]);
  assert.deepEqual(parseHex('#fa0'), [255, 170, 0]);
  assert.deepEqual(parseHex('red'), [18, 18, 18]);
  assert.deepEqual(parseHex('rgb(1,2,3)'), [18, 18, 18]);
});

test('faderParams picks the phone set at 600 px and below', () => {
  const f = { width: 6050, height: 1830, offset: -284, widthCompact: 1560, heightCompact: 980, offsetCompact: 0, softness: 0, grain: 1.5 };
  assert.deepEqual(faderParams(f, '#121212', 1440), { width: 6050, height: 1830, offset: -284, softness: 0, grain: 1.5, color: '#121212' });
  assert.deepEqual(faderParams(f, '#121212', 600), { width: 1560, height: 980, offset: 0, softness: 0, grain: 1.5, color: '#121212' });
  assert.equal(faderParams(f, '#121212', 601).width, 6050);
});

const P = { width: 800, height: 600, offset: 300, softness: 0.2, grain: 1, color: '#102030' };

test('renderFaderPixels: solid and coloured at the centre, fully transparent outside the ellipse', () => {
  const w = 1000, h = 800;
  const px = renderFaderPixels(w, h, P);
  assert.equal(px.length, w * h * 4);
  const at = (x, y) => Array.from(px.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
  // Centre (500, h - 300): alpha 255 within 1 level of dither, colour #102030.
  const c = at(500, h - 300);
  assert.ok(c[3] >= 254, `centre alpha ${c[3]}`);
  assert.deepEqual(c.slice(0, 3), [0x10, 0x20, 0x30]);
  assert.deepEqual(at(10, 10), [0, 0, 0, 0], 'far outside');
  assert.deepEqual(at(500, h - 300 - 305), [0, 0, 0, 0], 'just above the ellipse top (ry = 300)');
  assert.deepEqual(at(500 + 405, h - 300), [0, 0, 0, 0], 'just right of the ellipse (rx = 400)');
});

test('renderFaderPixels: the ellipse is centred offset px above the bottom edge and a negative offset sinks it', () => {
  const w = 600, h = 400;
  const alphaAt = (px, x, y) => px[(y * w + x) * 4 + 3];
  const up = renderFaderPixels(w, h, { ...P, width: 400, height: 200, offset: 150, grain: 0 });
  assert.equal(alphaAt(up, 300, h - 150), 255);
  assert.equal(alphaAt(up, 300, h - 1), 0, 'the bottom edge is below the ellipse');
  const down = renderFaderPixels(w, h, { ...P, width: 400, height: 200, offset: -20, grain: 0 });
  // Centre 20 px below the bottom edge, ry 100: the top 80 px of the ellipse show, and the centre does not.
  assert.ok(alphaAt(down, 300, h - 1) > 0, 'the part above the centre shows at the bottom of the screen');
  assert.equal(alphaAt(down, 300, h - 85), 0, 'above the ellipse top (80 px up) there is nothing');
});

test('the dither is unbiased: the mean alpha of a flat patch equals the undithered alpha', () => {
  // The ellipse radius puts the 20 x 20 patch at r of about 0.6, where the ramp is gently sloped.
  const w = 200, h = 200;
  const params = { width: 2 * 200 / 0.6, height: 2 * 200 / 0.6, offset: h / 2, softness: 0, color: '#000000' };
  const meanOf = (grain) => {
    const px = renderFaderPixels(w, h, { ...params, grain });
    let sum = 0, n = 0;
    for (let y = 90; y < 110; y++) for (let x = 90; x < 110; x++) { sum += px[(y * w + x) * 4 + 3]; n++; }
    return sum / n;
  };
  const flat = meanOf(0);
  assert.ok(flat > 200 && flat < 255, `a patch with real slope (${flat})`);
  assert.ok(Math.abs(flat - meanOf(2)) < 1, `dithered ${meanOf(2)} vs flat ${flat}`);
});

test('the grain breaks up banding: far shorter runs of equal alpha along a slow ramp', () => {
  const w = 1400, h = 60;
  // A very wide ellipse: alpha falls slowly across the row, so without grain it steps in long flat runs.
  const params = { width: 14000, height: 40000, offset: 30, softness: 0, color: '#000000' };
  const runs = (grain) => {
    const px = renderFaderPixels(w, h, { ...params, grain });
    const y = 30;
    let longest = 1, cur = 1;
    for (let x = 1; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] === px[(y * w + x - 1) * 4 + 3]) cur++; else { longest = Math.max(longest, cur); cur = 1; }
    }
    return Math.max(longest, cur);
  };
  const plain = runs(0);
  const dithered = runs(2);
  assert.ok(plain >= 10, `without grain the steps are wide (longest run ${plain})`);
  assert.ok(dithered < plain / 2, `with grain they break up (longest run ${dithered} vs ${plain})`);
});

test('the same inputs give the same pixels, and a 1440x900 viewport fills in well under half a second', () => {
  const a = renderFaderPixels(300, 200, P);
  const b = renderFaderPixels(300, 200, P);
  assert.deepEqual(a, b);
  const t0 = performance.now();
  renderFaderPixels(1440, 900, { width: 6050, height: 1830, offset: -284, softness: 0, grain: 1.5, color: '#121212' });
  assert.ok(performance.now() - t0 < 500, `took ${Math.round(performance.now() - t0)} ms`);
});

test('debounced runs once, after the last call', async () => {
  const { debounced } = await import('../../site/js/fader.js');
  let n = 0;
  const f = debounced(() => { n++; }, 20);
  f(); f(); f();
  assert.equal(n, 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(n, 1);
});
