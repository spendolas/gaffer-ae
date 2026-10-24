#!/usr/bin/env node
// Dev-only static server with HTTP Range support: node scripts/site/serve.mjs [--dir site] [--port 8000] [--bind 127.0.0.1]
// Use this for local previews instead of `python3 -m http.server`: Safari needs 206 range responses to play video.
// If-Range is ignored (a range request always gets 206); multi-range requests get the full 200.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function contentType(file) {
  const ext = path.extname(String(file)).slice(1).toLowerCase();
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : 'application/octet-stream';
}

// Returns { start, end } (inclusive), 'unsatisfiable', or null (ignore the header, serve everything).
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // wrong unit, garbage, multi-range
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (b !== '' && Number(b) < start) return null; // invalid syntax: ignore
  if (start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  return { start, end };
}

function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache', ...extra });
  res.end(body);
}

// Map a request URL to a file path inside root, or return a status number to refuse.
async function resolveFile(root, rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://x').pathname);
  } catch {
    return 400;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return 400;
  const target = path.resolve(root, '.' + pathname);
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  if (!inside(target)) return 403;
  try {
    const real = await fs.promises.realpath(target);
    if (!inside(real)) return 403;
    return real;
  } catch {
    return 404;
  }
}

// cacheStatic (public preview): clips, posters and fonts are cacheable for an hour, so the same clip on
// many tiles, or a tile that leaves and re-enters the grid, is not downloaded again.
export function createServer(rootDir, { cacheStatic = false } = {}) {
  const root = fs.realpathSync(path.resolve(rootDir));
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      let file = await resolveFile(root, req.url);
      if (typeof file === 'number') return send(res, file, file === 403 ? 'Forbidden' : file === 400 ? 'Bad Request' : 'Not Found');
      let st = await fs.promises.stat(file);
      if (st.isDirectory()) {
        file = path.join(file, 'index.html');
        try { st = await fs.promises.stat(file); } catch { return send(res, 404, 'Not Found'); }
      }
      if (!st.isFile()) return send(res, 404, 'Not Found');
      const size = st.size;
      const headers = {
        'Content-Type': contentType(file),
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheStatic && /^(media|fonts)\//.test(path.relative(root, file).split(path.sep).join('/')) ? 'public, max-age=3600' : 'no-cache',
        'Last-Modified': st.mtime.toUTCString(),
        ETag: `W/"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      };
      const range = parseRange(req.headers.range, size);
      if (range === 'unsatisfiable') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
        return res.end();
      }
      let status = 200;
      let opts;
      if (range) {
        status = 206;
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
        headers['Content-Length'] = range.end - range.start + 1;
        opts = { start: range.start, end: range.end };
      } else {
        headers['Content-Length'] = size;
      }
      if (req.method === 'HEAD' || (size === 0 && status === 200)) {
        res.writeHead(status, headers);
        return res.end();
      }
      const stream = fs.createReadStream(file, opts);
      stream.once('open', () => {
        res.writeHead(status, headers);
        stream.pipe(res);
      });
      stream.once('error', () => {
        if (!res.headersSent) send(res, 404, 'Not Found');
        else res.destroy();
      });
      res.once('close', () => stream.destroy());
    } catch {
      if (!res.headersSent) send(res, 500, 'Internal Server Error');
      else res.destroy();
    }
  });
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const args = process.argv.slice(2);
  const opt = { dir: 'site', port: '8000', bind: '127.0.0.1', preview: '0' }; // preview 1: cacheable static files (for a public preview)
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i].replace(/^--/, '');
    if (!(k in opt) || args[i + 1] === undefined) {
      console.error('usage: node scripts/site/serve.mjs [--dir site] [--port 8000] [--bind 127.0.0.1] [--preview 1]');
      process.exit(2);
    }
    opt[k] = args[i + 1];
  }
  const dir = path.resolve(repoRoot, opt.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`serve: directory not found: ${dir}`);
    process.exit(1);
  }
  const port = Number(opt.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`serve: invalid port: ${opt.port}`);
    process.exit(2);
  }
  const server = createServer(dir, { cacheStatic: opt.preview === '1' });
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `serve: port ${port} is already in use on ${opt.bind}` : `serve: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, opt.bind, () => {
    const shown = opt.bind === '0.0.0.0' ? 'localhost' : opt.bind;
    console.log(`Serving ${path.relative(repoRoot, dir) || '.'} at http://${shown}:${server.address().port}/ (bind ${opt.bind})`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
