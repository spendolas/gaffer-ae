// Turns a captured frame (a PNG file the capture tools asked After Effects to
// write) into MCP image content, so the chat agent sees it directly and needs
// no file-reading tool. Large frames are scaled down first: the model does not
// use the extra pixels, and a big PNG costs tokens and can exceed the API's
// per-image size limit.

import { readFileSync } from 'node:fs';
import { fitPng, pngSize } from './png-scale.js';

export var MAX_IMAGE_EDGE = 1568;
export var MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

function sniffMediaType(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length > 12 && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Reads an image file and returns { mediaType, data (base64), width?, height? }
// ready to send, or null when it cannot be sent: unreadable, not an image, or
// over the size budget and not a PNG that can be shrunk. Never throws.
export function loadImageForModel(path) {
  try {
    var buf = readFileSync(path);
    var type = sniffMediaType(buf);
    if (!type) return null;
    if (type === 'image/png') {
      var fit = fitPng(buf, { maxEdge: MAX_IMAGE_EDGE, maxBytes: MAX_IMAGE_BYTES });
      if (fit) return { mediaType: type, data: fit.data.toString('base64'), width: fit.width, height: fit.height };
      if (buf.length <= MAX_IMAGE_BYTES && pngSize(buf)) return { mediaType: type, data: buf.toString('base64') };
      return null;
    }
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return { mediaType: type, data: buf.toString('base64') };
  } catch (e) {
    return null;
  }
}

// MCP content for a successful capture: the result as text, then the frame as
// an image block. If the frame cannot be loaded the text says so instead of
// pointing at a file the agent has no way to open.
export function captureContent(inner) {
  var img = inner && inner.path ? loadImageForModel(inner.path) : null;
  // When the frame was scaled down, say what size the image actually is (the
  // comp's own width and height stay in the result for reference).
  var shown = inner;
  if (img && img.width && inner && typeof inner.width === 'number' && (img.width !== inner.width || img.height !== inner.height)) {
    shown = Object.assign({}, inner, { imageSize: { width: img.width, height: img.height } });
  }
  var text = JSON.stringify(shown, null, 2);
  if (!img) {
    return [{ type: 'text', text: text + '\n\nThe captured frame could not be attached as an image.' }];
  }
  return [
    { type: 'text', text: text },
    { type: 'image', data: img.data, mimeType: img.mediaType },
  ];
}
