// Tests for panel/daemon/fetch-runtime.sh (spec section 3, macOS).
//
// Every test builds its own fake Node archive (a shell script called "node"
// that prints the pinned version), its own fake runtime-pins.json, and serves
// both through file:// URLs via the GAFFER_FETCH_TEST seams. No network, no
// codesign (GAFFER_FETCH_SKIP_CODESIGN=1), TMPDIR pointed at a per-test folder
// so stray temp files are visible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync,
  readdirSync, rmSync, chmodSync, utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'fetch-runtime.sh');
const VERSION = 'v99.1.2';
const PLAT = 'darwin-x64';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Builds a sandbox with spaces in its path:
//   <root>/srv official/   archive served as the official source
//   <root>/srv mirror/     archive served as the mirror
//   <root>/daemon dir/     the --into target
//   <root>/tmp/            TMPDIR for the script
//   <root>/pins.json
function sandbox({ binBody, version = VERSION, binaryShaOverride } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gaffer fetch rt '));
  const build = join(root, 'build');
  const top = `node-${version}-${PLAT}`;
  mkdirSync(join(build, top, 'bin'), { recursive: true });
  mkdirSync(join(build, top, 'lib'), { recursive: true });
  const body = binBody ?? `#!/bin/sh\necho ${version}\n`;
  writeFileSync(join(build, top, 'bin', 'node'), body);
  chmodSync(join(build, top, 'bin', 'node'), 0o755);
  writeFileSync(join(build, top, 'lib', 'other.txt'), 'must not be extracted\n');
  writeFileSync(join(build, top, 'README.md'), 'must not be extracted\n');
  const archiveName = `${top}.tar.gz`;
  const archive = join(root, archiveName);
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', build, top]);
  const archiveBuf = readFileSync(archive);
  const binBuf = Buffer.from(body);

  const official = join(root, 'srv official');
  const mirror = join(root, 'srv mirror');
  mkdirSync(official);
  mkdirSync(mirror);
  writeFileSync(join(official, archiveName), archiveBuf);
  writeFileSync(join(mirror, archiveName), archiveBuf);

  const into = join(root, 'daemon dir');
  mkdirSync(into);
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);

  const pins = {
    node: {
      version,
      codename: 'Test',
      official: 'https://example.invalid/official/',
      mirror: 'https://example.invalid/mirror/',
      platforms: {
        'darwin-x64': {
          archive: archiveName,
          archiveSha256: sha256(archiveBuf),
          member: `${top}/bin/node`,
          binaryBytes: binBuf.length,
          binarySha256: binaryShaOverride ?? sha256(binBuf),
        },
        'darwin-arm64': {
          archive: 'node-other-darwin-arm64.tar.gz',
          archiveSha256: '0'.repeat(64),
          member: 'node-other-darwin-arm64/bin/node',
          binaryBytes: 1,
          binarySha256: '1'.repeat(64),
        },
      },
      signing: { darwinTeamId: 'HX7739G8FX', windowsSigner: 'OpenJS Foundation' },
    },
  };
  const pinsPath = join(root, 'pins.json');
  writeFileSync(pinsPath, JSON.stringify(pins, null, 2));

  return {
    root, into, tmp, official, mirror, archiveName, archiveBuf, binBuf, pins, pinsPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function urlOf(dir) {
  return 'file://' + encodeURI(dir) + '/';
}

function run(sb, args = [], envExtra = {}) {
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: sb.root,
    TMPDIR: sb.tmp,
    GAFFER_FETCH_TEST: '1',
    GAFFER_FETCH_PINS: sb.pinsPath,
    GAFFER_FETCH_BASE_OFFICIAL: urlOf(sb.official),
    GAFFER_FETCH_BASE_MIRROR: urlOf(sb.mirror),
    GAFFER_FETCH_SKIP_CODESIGN: '1',
    GAFFER_FETCH_PLATFORM: PLAT,
    ...envExtra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync('/bin/bash', [SCRIPT, '--into', sb.into, ...args], {
    env, encoding: 'utf8', timeout: 60000,
  });
  const lines = r.stdout.trim().split('\n');
  return { ...r, lines, last: lines[lines.length - 1] };
}

function listTree(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      out.push(r);
      if (e.isDirectory()) walk(join(d, e.name), r);
    }
  })(dir, '');
  return out.sort();
}

function snapshot(dir) {
  const m = {};
  for (const p of listTree(dir)) {
    const full = join(dir, p);
    const st = statSync(full);
    m[p] = st.isDirectory() ? 'dir' : sha256(readFileSync(full)) + ' ' + st.mtimeMs;
  }
  return m;
}

function installOld(sb) {
  // A previously installed (older) runtime the failure tests must not touch.
  const rt = join(sb.into, 'runtime');
  mkdirSync(rt);
  writeFileSync(join(rt, 'node'), '#!/bin/sh\necho v1.0.0\n');
  chmodSync(join(rt, 'node'), 0o755);
  writeFileSync(join(rt, 'VERSION'), `v1.0.0 ${PLAT}`);
  writeFileSync(join(rt, 'VERIFIED'), `${statSync(join(rt, 'node')).size} ${'a'.repeat(64)}`);
}

test('good path installs the binary, stamps it, prints runtime:installed', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const r = run(sb);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`);
  const node = join(sb.into, 'runtime', 'node');
  assert.deepEqual(readFileSync(node), sb.binBuf);
  assert.ok(statSync(node).mode & 0o100, 'exec bit set');
  assert.equal(readFileSync(join(sb.into, 'runtime', 'VERSION'), 'utf8').trim(), `${VERSION} ${PLAT}`);
  assert.equal(readFileSync(join(sb.into, 'runtime', 'VERIFIED'), 'utf8').trim(),
    `${sb.binBuf.length} ${sha256(sb.binBuf)}`);
  // Only the binary was extracted, and the work folders are gone.
  assert.deepEqual(listTree(sb.into), ['runtime', 'runtime/VERIFIED', 'runtime/VERSION', 'runtime/node']);
  assert.deepEqual(readdirSync(sb.tmp), [], 'temp folder removed');
  assert.ok(!r.stdout.includes('using the mirror'));
});

test('good path replaces an older runtime and removes runtime.old', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  installOld(sb);
  const r = run(sb);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout + r.stderr);
  assert.deepEqual(readFileSync(join(sb.into, 'runtime', 'node')), sb.binBuf);
  assert.deepEqual(listTree(sb.into), ['runtime', 'runtime/VERIFIED', 'runtime/VERSION', 'runtime/node']);
});

test('a stale runtime.old from an earlier run does not break the swap', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  installOld(sb);
  mkdirSync(join(sb.into, 'runtime.old'));
  writeFileSync(join(sb.into, 'runtime.old', 'node'), 'stale');
  const r = run(sb);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout + r.stderr);
  assert.deepEqual(listTree(sb.into), ['runtime', 'runtime/VERIFIED', 'runtime/VERSION', 'runtime/node']);
});

test('wrong archive hash on official, mirror succeeds', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  writeFileSync(join(sb.official, sb.archiveName), Buffer.concat([sb.archiveBuf, Buffer.from('x')]));
  const r = run(sb);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('runtime: official download failed, using the mirror'), r.stdout);
  assert.deepEqual(readFileSync(join(sb.into, 'runtime', 'node')), sb.binBuf);
  assert.deepEqual(readdirSync(sb.tmp), []);
});

test('official unreachable, mirror succeeds', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  rmSync(join(sb.official, sb.archiveName));
  const r = run(sb);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('runtime: official download failed, using the mirror'));
});

test('wrong hash on both sources gives err:runtime and leaves runtime/ untouched', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  installOld(sb);
  const before = snapshot(sb.into);
  writeFileSync(join(sb.official, sb.archiveName), 'garbage');
  writeFileSync(join(sb.mirror, sb.archiveName), 'more garbage');
  const r = run(sb);
  assert.notEqual(r.status, 0);
  assert.equal(r.last, 'err:runtime');
  assert.deepEqual(snapshot(sb.into), before);
  assert.deepEqual(readdirSync(sb.tmp), []);
});

test('truncated download is rejected on both sources', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  installOld(sb);
  const before = snapshot(sb.into);
  const half = sb.archiveBuf.subarray(0, Math.floor(sb.archiveBuf.length / 2));
  writeFileSync(join(sb.official, sb.archiveName), half);
  writeFileSync(join(sb.mirror, sb.archiveName), half);
  const r = run(sb);
  assert.equal(r.last, 'err:runtime', r.stdout);
  assert.deepEqual(snapshot(sb.into), before);
  assert.deepEqual(readdirSync(sb.tmp), []);
});

test('an HTML error page served as the archive is rejected', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const html = '<!DOCTYPE html><html><body><h1>Service Unavailable</h1></body></html>\n';
  writeFileSync(join(sb.official, sb.archiveName), html);
  writeFileSync(join(sb.mirror, sb.archiveName), html);
  const r = run(sb);
  assert.equal(r.last, 'err:runtime', r.stdout);
  assert.ok(!existsSync(join(sb.into, 'runtime')));
  assert.ok(!existsSync(join(sb.into, 'runtime.new')));
});

test('both sources unreachable gives err:runtime', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  rmSync(join(sb.official, sb.archiveName));
  rmSync(join(sb.mirror, sb.archiveName));
  const r = run(sb);
  assert.equal(r.last, 'err:runtime');
  assert.deepEqual(listTree(sb.into), []);
  assert.deepEqual(readdirSync(sb.tmp), []);
});

test('binary with the wrong size or hash is rejected', (t) => {
  const sb = sandbox({ binaryShaOverride: 'b'.repeat(64) });
  t.after(sb.cleanup);
  const r = run(sb);
  assert.equal(r.last, 'err:runtime', r.stdout);
  assert.deepEqual(listTree(sb.into), []);
});

test('placeholder binarySha256 skips the hash check with a log line, still checks size', (t) => {
  const sb = sandbox({ binaryShaOverride: 'PENDING-FIRST-ACCEPTANCE-RUN' });
  t.after(sb.cleanup);
  const r = run(sb);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout + r.stderr);
  assert.match(r.stdout, /binary hash not pinned yet/);
  // The stamp records the real hash, never the placeholder.
  assert.equal(readFileSync(join(sb.into, 'runtime', 'VERIFIED'), 'utf8').trim(),
    `${sb.binBuf.length} ${sha256(sb.binBuf)}`);

  const sb2 = sandbox({ binaryShaOverride: 'PENDING-FIRST-ACCEPTANCE-RUN' });
  t.after(sb2.cleanup);
  sb2.pins.node.platforms[PLAT].binaryBytes += 1;
  writeFileSync(sb2.pinsPath, JSON.stringify(sb2.pins));
  const r2 = run(sb2);
  assert.equal(r2.last, 'err:runtime', r2.stdout);
});

test('smoke run reporting the wrong version is rejected', (t) => {
  const body = '#!/bin/sh\necho v0.0.1\n';
  const sb = sandbox({ binBody: body });
  t.after(sb.cleanup);
  const r = run(sb);
  assert.equal(r.last, 'err:runtime', r.stdout);
  assert.deepEqual(listTree(sb.into), []);
});

test('skip when current: prints runtime:current and does not touch the file', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  assert.equal(run(sb).last, `runtime:installed ${VERSION} ${PLAT}`);
  const node = join(sb.into, 'runtime', 'node');
  const past = new Date((Math.floor(Date.now() / 1000) - 3600) * 1000);
  utimesSync(node, past, past);
  const before = snapshot(sb.into);
  // Remove the sources: a current runtime must never hit the network.
  rmSync(join(sb.official, sb.archiveName));
  rmSync(join(sb.mirror, sb.archiveName));
  const r = run(sb);
  assert.equal(r.status, 0);
  assert.equal(r.last, 'runtime:current');
  assert.deepEqual(snapshot(sb.into), before);
  assert.equal(statSync(node).mtimeMs, past.getTime());
  assert.deepEqual(readdirSync(sb.tmp), []);
});

test('a stamp whose size does not match the file re-provisions', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  run(sb);
  writeFileSync(join(sb.into, 'runtime', 'node'), 'truncated');
  const r = run(sb);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout);
  assert.deepEqual(readFileSync(join(sb.into, 'runtime', 'node')), sb.binBuf);
});

test('a VERSION for another platform re-provisions', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  run(sb);
  writeFileSync(join(sb.into, 'runtime', 'VERSION'), `${VERSION} darwin-arm64`);
  const r = run(sb);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout);
});

test('--stage-only leaves a verified runtime.new and does not swap', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  installOld(sb);
  const oldRt = snapshot(join(sb.into, 'runtime'));
  const r = run(sb, ['--stage-only']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`);
  assert.match(r.stdout, /staged/);
  assert.deepEqual(snapshot(join(sb.into, 'runtime')), oldRt, 'runtime/ untouched');
  assert.deepEqual(readFileSync(join(sb.into, 'runtime.new', 'node')), sb.binBuf);
  assert.equal(readFileSync(join(sb.into, 'runtime.new', 'VERSION'), 'utf8').trim(), `${VERSION} ${PLAT}`);
  assert.ok(!existsSync(join(sb.into, 'runtime.old')));
  assert.deepEqual(readdirSync(sb.tmp), []);
});

test('--stage-only failure removes runtime.new', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  mkdirSync(join(sb.into, 'runtime.new'));
  writeFileSync(join(sb.into, 'runtime.new', 'leftover'), 'x');
  writeFileSync(join(sb.official, sb.archiveName), 'garbage');
  writeFileSync(join(sb.mirror, sb.archiveName), 'garbage');
  const r = run(sb, ['--stage-only']);
  assert.equal(r.last, 'err:runtime');
  assert.ok(!existsSync(join(sb.into, 'runtime.new')));
});

test('--stage-only on a current runtime prints runtime:current', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  run(sb);
  const r = run(sb, ['--stage-only']);
  assert.equal(r.last, 'runtime:current');
  assert.ok(!existsSync(join(sb.into, 'runtime.new')));
});

test('path with spaces in every argument works and nothing lands outside --into and TMPDIR', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const before = listTree(sb.root).filter((p) => !p.startsWith('daemon dir') && !p.startsWith('tmp'));
  const r = run(sb);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout + r.stderr);
  const after = listTree(sb.root).filter((p) => !p.startsWith('daemon dir') && !p.startsWith('tmp'));
  assert.deepEqual(after, before);
  assert.ok(sb.into.includes(' '));
});

test('platform key is honoured (unknown platform fails cleanly)', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const r = run(sb, [], { GAFFER_FETCH_PLATFORM: 'darwin-sparc' });
  assert.equal(r.last, 'err:runtime');
  assert.deepEqual(listTree(sb.into), []);
});

test('a missing --into directory fails cleanly', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const env = { ...process.env, TMPDIR: sb.tmp, GAFFER_FETCH_TEST: '1', GAFFER_FETCH_PINS: sb.pinsPath };
  const r = spawnSync('/bin/bash', [SCRIPT, '--into', join(sb.root, 'nope')], { env, encoding: 'utf8' });
  assert.equal(r.stdout.trim().split('\n').pop(), 'err:runtime');
  assert.ok(!existsSync(join(sb.root, 'nope')));
});

test('test seams are ignored without GAFFER_FETCH_TEST=1', (t) => {
  // Without the flag the script must read the real runtime-pins.json next to
  // it, so a runtime stamped for the real pin is "current" (no network).
  const sb = sandbox();
  t.after(sb.cleanup);
  const real = readFileSync(join(HERE, '..', 'runtime-pins.json'), 'utf8');
  const realVer = JSON.parse(real).node.version;
  let arm = '';
  try { arm = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  const realPlat = arm === '1' ? 'darwin-arm64' : 'darwin-x64';
  const rt = join(sb.into, 'runtime');
  mkdirSync(rt);
  writeFileSync(join(rt, 'node'), 'x'.repeat(10));
  writeFileSync(join(rt, 'VERSION'), `${realVer} ${realPlat}`);
  writeFileSync(join(rt, 'VERIFIED'), `10 ${'c'.repeat(64)}`);
  const r = run(sb, [], { GAFFER_FETCH_TEST: undefined });
  assert.equal(r.last, 'runtime:current', r.stdout + r.stderr);
});

test('HTTP 503 HTML error page from official falls back to the mirror (curl --fail)', async (t) => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const sb = sandbox();
  t.after(sb.cleanup);
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><body>Not Found</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/dist/`;
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: sb.root, TMPDIR: sb.tmp,
    GAFFER_FETCH_TEST: '1', GAFFER_FETCH_PINS: sb.pinsPath,
    GAFFER_FETCH_BASE_OFFICIAL: base, GAFFER_FETCH_BASE_MIRROR: urlOf(sb.mirror),
    GAFFER_FETCH_SKIP_CODESIGN: '1', GAFFER_FETCH_PLATFORM: PLAT,
  };
  const out = await new Promise((resolve) => {
    const c = spawn('/bin/bash', [SCRIPT, '--into', sb.into], { env });
    let s = '';
    c.stdout.on('data', (d) => { s += d; });
    c.on('close', () => resolve(s));
  });
  const last = out.trim().split('\n').pop();
  assert.equal(last, `runtime:installed ${VERSION} ${PLAT}`, out);
  assert.ok(out.includes('runtime: official download failed, using the mirror'));
  assert.equal(hits, 1, '404 is not retried');
});
