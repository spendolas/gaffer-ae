import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { parseRange, contentType, createServer } from './serve.mjs';

test('parseRange: closed, open and suffix forms', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-0', 1000), { start: 0, end: 0 });
});

test('parseRange: clamping and unsatisfiable', () => {
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=2000-3000', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-0', 0), 'unsatisfiable');
  assert.equal(parseRange('bytes=-5', 0), 'unsatisfiable');
});

test('parseRange: ignored headers', () => {
  for (const h of [undefined, '', 'garbage', 'bytes=', 'bytes=-', 'bytes=a-b', 'items=0-5', 'bytes=0-1,5-6', 'bytes=5-2', 'bytes 0-5']) {
    assert.equal(parseRange(h, 1000), null, String(h));
  }
});

test('contentType maps known extensions and falls back', () => {
  assert.equal(contentType('a/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('x.CSS'), 'text/css; charset=utf-8');
  assert.equal(contentType('x.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('x.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('x.json'), 'application/json; charset=utf-8');
  assert.match(contentType('x.md'), /^text\/markdown/);
  assert.equal(contentType('x.svg'), 'image/svg+xml; charset=utf-8');
  assert.equal(contentType('x.jpeg'), 'image/jpeg');
  assert.equal(contentType('x.woff2'), 'font/woff2');
  assert.equal(contentType('x.mp4'), 'video/mp4');
  assert.equal(contentType('x.webm'), 'video/webm');
  assert.equal(contentType('x.xml'), 'application/xml; charset=utf-8');
  assert.equal(contentType('x.bin'), 'application/octet-stream');
  assert.equal(contentType('noext'), 'application/octet-stream');
  assert.equal(contentType('x.constructor'), 'application/octet-stream');
});

async function start(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-test-'));
  const root = path.join(tmp, 'root');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'SECRET');
  const data = Buffer.alloc(100000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 255;
  fs.writeFileSync(path.join(root, 'blob.bin'), data);
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
  const server = createServer(root);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { port: server.address().port, data };
}

function request(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('full GET: 200, Accept-Ranges, length, body', async (t) => {
  const { port, data } = await start(t);
  const r = await request(port, '/blob.bin');
  assert.equal(r.status, 200);
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.equal(r.headers['content-length'], String(data.length));
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.equal(r.headers['content-type'], 'application/octet-stream');
  assert.ok(r.body.equals(data));
});

test('/ serves index.html; directory without index is 404', async (t) => {
  const { port } = await start(t);
  const r = await request(port, '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(r.body.toString(), '<h1>hi</h1>');
  assert.equal((await request(port, '/sub/')).status, 404);
});

test('Range bytes=0-99 gives 206 with exact slice', async (t) => {
  const { port, data } = await start(t);
  const r = await request(port, '/blob.bin', { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 0-99/${data.length}`);
  assert.equal(r.headers['content-length'], '100');
  assert.ok(r.body.equals(data.subarray(0, 100)));
});

test('suffix and open-ended ranges', async (t) => {
  const { port, data } = await start(t);
  const s = await request(port, '/blob.bin', { headers: { Range: 'bytes=-50' } });
  assert.equal(s.status, 206);
  assert.equal(s.headers['content-range'], `bytes ${data.length - 50}-${data.length - 1}/${data.length}`);
  assert.ok(s.body.equals(data.subarray(data.length - 50)));
  const o = await request(port, '/blob.bin', { headers: { Range: 'bytes=99900-' } });
  assert.equal(o.status, 206);
  assert.ok(o.body.equals(data.subarray(99900)));
});

test('unsatisfiable range gives 416', async (t) => {
  const { port, data } = await start(t);
  const r = await request(port, '/blob.bin', { headers: { Range: `bytes=${data.length}-` } });
  assert.equal(r.status, 416);
  assert.equal(r.headers['content-range'], `bytes */${data.length}`);
});

test('multi-range gets the full 200', async (t) => {
  const { port, data } = await start(t);
  const r = await request(port, '/blob.bin', { headers: { Range: 'bytes=0-1,5-6' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.equals(data));
});

test('HEAD returns headers only, also with Range', async (t) => {
  const { port, data } = await start(t);
  const h = await request(port, '/blob.bin', { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(h.headers['content-length'], String(data.length));
  assert.equal(h.body.length, 0);
  const r = await request(port, '/blob.bin', { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-length'], '10');
  assert.equal(r.body.length, 0);
});

test('path traversal never returns outside content', async (t) => {
  const { port } = await start(t);
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2f..%2fetc/passwd', '/..%2fsecret.txt', '/sub/..%5c..%5csecret.txt', '/%00', '/..\\secret.txt']) {
    const r = await request(port, p);
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!r.body.toString().includes('SECRET'), p);
  }
  // raw (unnormalized) request line
  const raw = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /../secret.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => (buf += d));
    s.on('close', () => resolve(buf));
  });
  assert.ok(!raw.includes('SECRET'));
});

test('missing file is 404', async (t) => {
  const { port } = await start(t);
  assert.equal((await request(port, '/nope.txt')).status, 404);
});

test('client aborting mid-stream does not crash the server', async (t) => {
  const { port, data } = await start(t);
  await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /blob.bin HTTP/1.1\r\nHost: x\r\n\r\n'));
    s.once('data', () => { s.destroy(); resolve(); });
  });
  const r = await request(port, '/blob.bin', { headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.ok(r.body.equals(data.subarray(0, 10)));
});

test('cacheStatic gives media and fonts a max-age and leaves html and js no-cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-cache-'));
  fs.mkdirSync(path.join(dir, 'media'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'media', 'a.mp4'), 'x'.repeat(100));
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'x');
  fs.writeFileSync(path.join(dir, 'index.html'), 'x');
  const server = createServer(dir, { cacheStatic: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/media/a.mp4`)).headers.get('cache-control'), 'public, max-age=3600');
    assert.equal((await fetch(`${base}/media/a.mp4`, { headers: { Range: 'bytes=0-9' } })).headers.get('cache-control'), 'public, max-age=3600');
    assert.equal((await fetch(`${base}/js/a.js`)).headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(`${base}/index.html`)).headers.get('cache-control'), 'no-cache');
  } finally { server.close(); }
});

test('contentType serves the web manifest as application/manifest+json', () => {
  assert.equal(contentType('site.webmanifest'), 'application/manifest+json; charset=utf-8');
});
