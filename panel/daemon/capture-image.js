// Turns a captured frame (a PNG file the capture tools asked After Effects to
// write) or a pasted image into MCP / API image content, so the chat agent
// sees it directly and needs no file-reading tool. Frames are scaled down
// first: the model does not use the extra pixels, and a big image costs
// tokens and can exceed the API's size limits. An image that is too large and
// cannot be scaled is never sent: the caller gets a reason instead.

import { readFile } from 'node:fs/promises';
import { fitPng, pngSize } from './png-scale.js';

export var MAX_IMAGE_EDGE = 1568;
export var MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
// Largest side for a format Gaffer cannot scale (JPEG, GIF, WebP, or a PNG it
// cannot decode). Well under the API's hard per-image limit.
export var MAX_UNSCALED_EDGE = 4000;
// Files bigger than this are not even read.
var MAX_READ_BYTES = 40 * 1024 * 1024;

function sniffMediaType(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// { width, height } from the header of a JPEG, GIF or WebP, or null.
export function imageSize(buf, type) {
  try {
    if (type === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === 'image/jpeg') {
      var i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        var marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        var len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (type === 'image/webp') {
      var fourcc = buf.toString('latin1', 12, 16);
      if (fourcc === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (fourcc === 'VP8L') {
        var b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fourcc === 'VP8X') {
        return { width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1, height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
      }
    }
  } catch (e) { /* fall through */ }
  return null;
}

// Reads an image file and returns { mediaType, data (base64), width, height }
// ready to send, or { error } with a short reason when it must not be sent:
// unreadable, not an image, or too large and not scalable. Never throws.
export async function loadImageForModel(path) {
  try {
    var buf = await readFile(path);
    if (buf.length > MAX_READ_BYTES) return { error: 'the file is too large' };
    var type = sniffMediaType(buf);
    if (!type) return { error: 'the file is not a supported image' };
    var size = type === 'image/png' ? pngSize(buf) : imageSize(buf, type);
    if (!size || !size.width || !size.height) return { error: 'the image size could not be read' };

    if (type === 'image/png') {
      var fit = await fitPng(buf, { maxEdge: MAX_IMAGE_EDGE, maxBytes: MAX_IMAGE_BYTES });
      if (fit) return { mediaType: type, data: fit.data.toString('base64'), width: fit.width, height: fit.height };
      // Could not be scaled (interlaced, very large, unusual format): only
      // sent as is when it is already small.
    }
    var longest = Math.max(size.width, size.height);
    if (longest > (type === 'image/png' ? MAX_IMAGE_EDGE : MAX_UNSCALED_EDGE)) {
      return { error: 'the image is ' + size.width + ' by ' + size.height + ' pixels, too large to attach' };
    }
    if (buf.length > MAX_IMAGE_BYTES) return { error: 'the image file is too large to attach' };
    return { mediaType: type, data: buf.toString('base64'), width: size.width, height: size.height };
  } catch (e) {
    return { error: 'the file could not be read' };
  }
}

// MCP content for a successful capture: the result as text, then the frame as
// an image block. `file` is the path Gaffer itself asked After Effects to
// write; the path in the reply from After Effects is never read. If the frame
// cannot be loaded the text says why instead of pointing at a file the agent
// has no way to open.
export async function captureContent(inner, file) {
  var img = file ? await loadImageForModel(file) : { error: 'no frame file' };
  var shown = inner;
  if (!img.error && img.width && inner && typeof inner.width === 'number' && (img.width !== inner.width || img.height !== inner.height)) {
    shown = Object.assign({}, inner, { imageSize: { width: img.width, height: img.height } });
  }
  var text = JSON.stringify(shown, null, 2);
  if (img.error) {
    return [{ type: 'text', text: text + '\n\nThe captured frame could not be attached as an image: ' + img.error + '.' }];
  }
  return [
    { type: 'text', text: text },
    { type: 'image', data: img.data, mimeType: img.mediaType },
  ];
}
