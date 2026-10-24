import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { variants, buildIco } from './build-icons.mjs';

const site = fileURLToPath(new URL('../../site/', import.meta.url));
const read = (f) => readFileSync(site + f);
const TILE = [0xED, 0xFF, 0x2C]; // #EDFF2C, the lime tile in the Figma source

// A small PNG decoder (8-bit, RGB or RGBA, not interlaced): enough to look at real pixels.
function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let pos = 8, width = 0, height = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8, '8-bit'); type = data[9]; assert.equal(data[12], 0, 'not interlaced'); }
    if (name === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  assert.ok(type === 6 || type === 2, `colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      px[o] = line[x * bpp]; px[o + 1] = line[x * bpp + 1]; px[o + 2] = line[x * bpp + 2]; px[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, at: (x, y) => Array.from(px.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)), px };
}

test('the PNG icons have the exact sizes the platforms expect', () => {
  for (const [file, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['icon-512-maskable.png', 512]]) {
    const png = decodePng(read(file));
    assert.equal(png.width, size, file);
    assert.equal(png.height, size, file);
  }
});

test('favicon.ico holds 16, 32 and 48 px images, each a PNG of that size', () => {
  const ico = read('favicon.ico');
  assert.equal(ico.readUInt16LE(2), 1, 'type: icon');
  const n = ico.readUInt16LE(4);
  assert.equal(n, 3);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    const size = ico[e];
    const len = ico.readUInt32LE(e + 8), off = ico.readUInt32LE(e + 12);
    const png = decodePng(ico.subarray(off, off + len));
    assert.equal(png.width, size);
    assert.equal(png.height, size);
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 32, 48]);
});

test('apple-touch-icon is opaque and full bleed (iOS rounds it itself; transparency would turn black)', () => {
  const png = decodePng(read('apple-touch-icon.png'));
  for (let i = 3; i < png.px.length; i += 4) assert.equal(png.px[i], 255, 'every pixel opaque');
  assert.deepEqual(png.at(0, 0).slice(0, 3), TILE, 'the corner is tile colour, not rounded');
});

test('the rounded icons have transparent corners and the lime tile inside', () => {
  for (const file of ['icon-192.png', 'icon-512.png']) {
    const png = decodePng(read(file));
    assert.equal(png.at(0, 0)[3], 0, `${file} corner is transparent`);
    assert.deepEqual(png.at(Math.floor(png.width / 2), Math.floor(png.height * 0.05)).slice(0, 3), TILE, `${file} tile colour`);
    assert.equal(png.at(Math.floor(png.width / 2), Math.floor(png.height * 0.05))[3], 255);
  }
});

test('the maskable icon is full bleed and keeps the whole glyph inside the 80% safe circle', () => {
  const png = decodePng(read('icon-512-maskable.png'));
  for (let i = 3; i < png.px.length; i += 4) assert.equal(png.px[i], 255, 'opaque everywhere (the platform supplies the shape)');
  const c = png.width / 2, limit = 0.4 * png.width + 1; // the safe zone is a circle of diameter 80%
  let farthest = 0, dark = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, g, b] = png.at(x, y);
      if (r + g + b < 3 * 110) { dark++; farthest = Math.max(farthest, Math.hypot(x + 0.5 - c, y + 0.5 - c)); }
    }
  }
  assert.ok(dark > 1000, 'the glyph is there');
  assert.ok(farthest <= limit, `glyph reaches ${farthest.toFixed(1)} px from the centre, safe radius ${limit}`);
});

test('icon.svg is the tile variant of the Figma source, and every variant keeps the brand colours', () => {
  assert.equal(read('icon.svg').toString(), variants.tile);
  for (const v of Object.values(variants)) {
    assert.match(v, /fill="#EDFF2C"/);
    assert.equal((v.match(/<path /g) || []).length, 1, 'the glyph is one merged path');
    assert.equal((v.match(/fill="#2C2C2C"/g) || []).length, 1);
    assert.equal((v.match(/M/g) || []).length, 3, 'with its three shapes as subpaths');
  }
  assert.doesNotMatch(variants.bleed, /rx=/, 'the full-bleed variant has square corners');
});

test('buildIco lays out its directory and images consistently', () => {
  const a = Buffer.from('aaaa'), b = Buffer.from('bbbbbb');
  const ico = buildIco([{ size: 16, data: a }, { size: 32, data: b }]);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico.readUInt32LE(6 + 12), 6 + 32);
  assert.equal(ico.subarray(6 + 32, 6 + 32 + 4).toString(), 'aaaa');
  assert.equal(ico.subarray(ico.readUInt32LE(6 + 16 + 12)).toString(), 'bbbbbb');
});

test('site.webmanifest points at real icons of the declared sizes, and index.html links the icons and the manifest', () => {
  const m = JSON.parse(read('site.webmanifest').toString());
  assert.equal(m.name, 'Gaffer');
  assert.equal(m.theme_color, '#121212');
  assert.equal(m.background_color, '#121212');
  for (const icon of m.icons) {
    const png = decodePng(read(icon.src.slice(1)));
    assert.equal(`${png.width}x${png.height}`, icon.sizes, icon.src);
  }
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  const html = read('index.html').toString();
  for (const link of ['<link rel="icon" href="/favicon.ico" sizes="48x48">', '<link rel="icon" href="/icon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="manifest" href="/site.webmanifest">']) {
    assert.ok(html.includes(link), link);
  }
});
