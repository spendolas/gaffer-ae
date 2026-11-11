// Dependency-free PNG decode, box-filter downscale and encode, used to shrink
// captured frames and pasted screenshots before they are handed to the chat
// agent as image content (a large PNG costs tokens and can exceed the API's
// per-image limit). Zero npm dependencies: node:zlib only.
//
// Scope: non-interlaced PNGs at 8 or 16 bits per channel (gray, gray+alpha,
// RGB, RGBA, indexed 8-bit). Anything else decodes to null and the caller
// decides what to do (pass the original through or skip the image).

import { inflateSync, deflateSync } from 'node:zlib';

var SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  var c = 0xffffffff;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// { width, height } from the IHDR of a PNG buffer, or null. No decoding.
export function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || buf.compare(SIGNATURE, 0, 8, 0, 8) !== 0) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

var CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  var p = a + b - c;
  var pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

// Decodes to { width, height, rgba: Uint8Array } or null when the file is not
// a PNG this module handles. Never throws.
export function decodePng(buf) {
  try {
    var size = pngSize(buf);
    if (!size) return null;
    var width = size.width, height = size.height;
    if (!width || !height || width > 16384 || height > 16384) return null;
    var depth = buf[24], colorType = buf[25], interlace = buf[28];
    if (interlace !== 0 || (depth !== 8 && depth !== 16) || !CHANNELS[colorType]) return null;
    if (colorType === 3 && depth !== 8) return null;
    var channels = CHANNELS[colorType];
    var bytesPer = channels * (depth / 8);

    var pos = 8, idat = [], plte = null, trns = null;
    while (pos + 8 <= buf.length) {
      var len = buf.readUInt32BE(pos);
      var type = buf.toString('latin1', pos + 4, pos + 8);
      var data = buf.subarray(pos + 8, pos + 8 + len);
      if (type === 'IDAT') idat.push(data);
      else if (type === 'PLTE') plte = data;
      else if (type === 'tRNS') trns = data;
      else if (type === 'IEND') break;
      pos += 12 + len;
    }
    if (!idat.length) return null;
    var raw = inflateSync(Buffer.concat(idat));
    var stride = width * bytesPer;
    if (raw.length < (stride + 1) * height) return null;

    // Unfilter in place into `px`, one row at a time.
    var px = Buffer.alloc(stride * height);
    for (var y = 0; y < height; y++) {
      var f = raw[y * (stride + 1)];
      var src = y * (stride + 1) + 1;
      var dst = y * stride;
      var up = dst - stride;
      for (var x = 0; x < stride; x++) {
        var v = raw[src + x];
        var a = x >= bytesPer ? px[dst + x - bytesPer] : 0;
        var b = y > 0 ? px[up + x] : 0;
        var c = (y > 0 && x >= bytesPer) ? px[up + x - bytesPer] : 0;
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) v += paeth(a, b, c);
        else if (f !== 0) return null;
        px[dst + x] = v & 0xff;
      }
    }

    var out = new Uint8Array(width * height * 4);
    var step = depth / 8; // bytes per sample
    for (var i = 0; i < width * height; i++) {
      var o = i * 4, p = i * bytesPer;
      if (colorType === 6) {
        out[o] = px[p]; out[o + 1] = px[p + step]; out[o + 2] = px[p + 2 * step]; out[o + 3] = px[p + 3 * step];
      } else if (colorType === 2) {
        out[o] = px[p]; out[o + 1] = px[p + step]; out[o + 2] = px[p + 2 * step]; out[o + 3] = 255;
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = px[p]; out[o + 3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = px[p]; out[o + 3] = px[p + step];
      } else { // indexed
        var idx = px[p];
        if (!plte || idx * 3 + 2 >= plte.length) return null;
        out[o] = plte[idx * 3]; out[o + 1] = plte[idx * 3 + 1]; out[o + 2] = plte[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    return { width: width, height: height, rgba: out };
  } catch (e) {
    return null;
  }
}

// Area-average downscale with alpha-weighted (premultiplied) colour so
// transparent pixels do not darken edges. Returns a new rgba array.
export function scaleRgba(rgba, width, height, nw, nh) {
  var out = new Uint8Array(nw * nh * 4);
  var sx = width / nw, sy = height / nh;
  for (var y = 0; y < nh; y++) {
    var y0 = y * sy, y1 = (y + 1) * sy;
    var iy0 = Math.floor(y0), iy1 = Math.min(height, Math.ceil(y1));
    for (var x = 0; x < nw; x++) {
      var x0 = x * sx, x1 = (x + 1) * sx;
      var ix0 = Math.floor(x0), ix1 = Math.min(width, Math.ceil(x1));
      var r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (var yy = iy0; yy < iy1; yy++) {
        var wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (var xx = ix0; xx < ix1; xx++) {
          var w = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx));
          var p = (yy * width + xx) * 4;
          var pa = rgba[p + 3] * w;
          r += rgba[p] * pa; g += rgba[p + 1] * pa; b += rgba[p + 2] * pa;
          a += pa; wsum += w;
        }
      }
      var o = (y * nw + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = wsum > 0 ? Math.round(a / wsum) : 0;
    }
  }
  return out;
}

// Encodes rgba as a PNG. RGB (type 2) when every pixel is opaque, RGBA (6)
// otherwise. Adaptive per-row filtering unless opts.filter (0 to 4) forces one
// (used by tests to exercise every unfilter path).
export function encodePng(rgba, width, height, opts) {
  var forced = opts && typeof opts.filter === 'number' ? opts.filter : null;
  var opaque = true;
  for (var i = 3; i < rgba.length; i += 4) { if (rgba[i] !== 255) { opaque = false; break; } }
  var bpp = opaque ? 3 : 4;
  var stride = width * bpp;
  var rows = Buffer.alloc((stride + 1) * height);
  var cur = Buffer.alloc(stride);
  var prev = Buffer.alloc(stride);
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      var s = (y * width + x) * 4, d = x * bpp;
      cur[d] = rgba[s]; cur[d + 1] = rgba[s + 1]; cur[d + 2] = rgba[s + 2];
      if (!opaque) cur[d + 3] = rgba[s + 3];
    }
    var best = null, bestScore = Infinity, bestType = 0;
    for (var t = 0; t <= 4; t++) {
      if (forced !== null && t !== forced) continue;
      var line = Buffer.alloc(stride), score = 0;
      for (var k = 0; k < stride; k++) {
        var a = k >= bpp ? cur[k - bpp] : 0, b = prev[k], c = k >= bpp ? prev[k - bpp] : 0;
        var pred = t === 0 ? 0 : t === 1 ? a : t === 2 ? b : t === 3 ? ((a + b) >> 1) : paeth(a, b, c);
        var v = (cur[k] - pred) & 0xff;
        line[k] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = line; bestType = t; }
    }
    rows[y * (stride + 1)] = bestType;
    best.copy(rows, y * (stride + 1) + 1);
    var tmp = prev; prev = cur; cur = tmp;
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shrinks a PNG so its longest side is at most maxEdge and the file is at most
// maxBytes. Returns the original buffer untouched when it already fits.
// Result { data, width, height, scaled } or null when the PNG cannot be
// decoded (the caller then passes it through or skips it).
export function fitPng(buf, opts) {
  var maxEdge = (opts && opts.maxEdge) || 1568;
  var maxBytes = (opts && opts.maxBytes) || 3.5 * 1024 * 1024;
  var size = pngSize(buf);
  if (!size) return null;
  if (Math.max(size.width, size.height) <= maxEdge && buf.length <= maxBytes) {
    return { data: buf, width: size.width, height: size.height, scaled: false };
  }
  var img = decodePng(buf);
  if (!img) return null;
  var edge = Math.min(maxEdge, Math.max(img.width, img.height));
  for (var attempt = 0; attempt < 6; attempt++) {
    var k = edge / Math.max(img.width, img.height);
    var nw = Math.max(1, Math.round(img.width * k)), nh = Math.max(1, Math.round(img.height * k));
    var data = (nw === img.width && nh === img.height) ? encodePng(img.rgba, nw, nh)
      : encodePng(scaleRgba(img.rgba, img.width, img.height, nw, nh), nw, nh);
    if (data.length <= maxBytes || edge <= 256) return { data: data, width: nw, height: nh, scaled: true };
    edge = Math.floor(edge * 0.75);
  }
  return null;
}
