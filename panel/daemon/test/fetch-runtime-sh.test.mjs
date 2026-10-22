// Tests for panel/daemon/fetch-runtime.sh (spec section 3, macOS).
//
// Every test builds its own fake Node archive (a shell script called "node"
// that prints the pinned version), its own fake runtime-pins.json, and serves
// both through file:// URLs via the GAFFER_FETCH_TEST seams. No network, no
// codesign (GAFFER_FETCH_SKIP_CODESIGN=1), TMPDIR pointed at a per-test folder
// so stray temp files are visible.

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync,
  readdirSync, rmSync, chmodSync, utimesSync, copyFileSync, renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'fetch-runtime.sh');
const VERSION = 'v99.1.2';
const PLAT = 'darwin-x64';

// fetch-runtime.sh is the macOS script (bash, POSIX paths); Windows has
// fetch-runtime.ps1 and its own test. Every test in this file goes through
// this wrapper so the whole file is skipped on win32 (module load only does
// path joins, which are safe there).
const SKIP = process.platform === 'win32' ? 'bash script, macOS/Linux only' : false;
function test(name, fn) {
  return nodeTest(name, { skip: SKIP }, fn);
}

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

test('binary with the wrong hash is rejected', (t) => {
  const sb = sandbox({ binaryShaOverride: 'b'.repeat(64) });
  t.after(sb.cleanup);
  const r = run(sb);
  assert.equal(r.last, 'err:runtime', r.stdout);
  assert.match(r.stdout, /binary checksum/);
  assert.deepEqual(listTree(sb.into), []);
});

test('binary with the wrong size is rejected', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  sb.pins.node.platforms[PLAT].binaryBytes += 1;
  writeFileSync(sb.pinsPath, JSON.stringify(sb.pins));
  const r = run(sb);
  assert.equal(r.last, 'err:runtime', r.stdout);
  assert.match(r.stdout, /binary size/);
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

// The platform the script detects with no seam: sysctl on macOS, and on
// Linux (no hw.optional.arm64) the darwin-x64 fallback.
function detectedPlatform() {
  let arm = '';
  try {
    arm = execFileSync('sysctl', ['-n', 'hw.optional.arm64'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    }).toString().trim();
  } catch {}
  return arm === '1' ? 'darwin-arm64' : 'darwin-x64';
}

// A copy of the script beside its own "real" pins whose sources are closed
// loopback ports, so a regression that ignored the flag check can never
// reach nodejs.org: at worst it fails fast against 127.0.0.1.
function isolatedScript(sb, realVer) {
  const dir = join(sb.root, 'script dir');
  mkdirSync(dir);
  copyFileSync(SCRIPT, join(dir, 'fetch-runtime.sh'));
  const real = JSON.parse(JSON.stringify(sb.pins));
  real.node.version = realVer;
  real.node.official = 'https://127.0.0.1:9/official/';
  real.node.mirror = 'https://127.0.0.1:9/mirror/';
  real.node.platforms['darwin-arm64'] = { ...real.node.platforms[PLAT] };
  writeFileSync(join(dir, 'runtime-pins.json'), JSON.stringify(real, null, 2));
  return join(dir, 'fetch-runtime.sh');
}

function runScript(script, sb, envExtra) {
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: sb.root, TMPDIR: sb.tmp,
    GAFFER_FETCH_PINS: sb.pinsPath,
    GAFFER_FETCH_BASE_OFFICIAL: urlOf(sb.official),
    GAFFER_FETCH_BASE_MIRROR: urlOf(sb.mirror),
    GAFFER_FETCH_SKIP_CODESIGN: '1',
    GAFFER_FETCH_PLATFORM: 'darwin-sparc',
    ...envExtra,
  };
  const r = spawnSync('/bin/bash', [script, '--into', sb.into], { env, encoding: 'utf8', timeout: 30000 });
  return { ...r, last: r.stdout.trim().split('\n').pop() };
}

test('test seams are ignored without GAFFER_FETCH_TEST=1 (pins, platform)', (t) => {
  // Without the flag the script reads the pins next to it and detects the
  // platform itself, so a runtime stamped for those is "current". Honouring
  // GAFFER_FETCH_PINS (other version) or GAFFER_FETCH_PLATFORM (darwin-sparc)
  // would not be.
  const sb = sandbox();
  t.after(sb.cleanup);
  const script = isolatedScript(sb, 'v77.0.0');
  const rt = join(sb.into, 'runtime');
  mkdirSync(rt);
  writeFileSync(join(rt, 'node'), 'x'.repeat(10));
  writeFileSync(join(rt, 'VERSION'), `v77.0.0 ${detectedPlatform()}`);
  writeFileSync(join(rt, 'VERIFIED'), `10 ${'c'.repeat(64)}`);
  const r = runScript(script, sb, {});
  assert.equal(r.last, 'runtime:current', r.stdout + r.stderr);
});

test('test seams are ignored without GAFFER_FETCH_TEST=1 (base URLs, codesign skip)', (t) => {
  // No runtime: the script must try the pinned 127.0.0.1 sources (closed
  // port, fails fast), never the file:// bases from the seam variables.
  const sb = sandbox();
  t.after(sb.cleanup);
  const script = isolatedScript(sb, VERSION);
  const t0 = Date.now();
  const r = runScript(script, sb, { GAFFER_FETCH_PLATFORM: undefined });
  assert.equal(r.last, 'err:runtime', r.stdout + r.stderr);
  assert.match(r.stdout, /https:\/\/127\.0\.0\.1:9\/official\//);
  assert.match(r.stdout, /official download failed, using the mirror/);
  assert.ok(!r.stdout.includes('file://'), r.stdout);
  assert.ok(Date.now() - t0 < 20000, 'fails fast');
  assert.deepEqual(listTree(sb.into), []);
});

test('recovery: runtime missing and a good runtime.old is restored (spec 6.8)', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  run(sb);
  // Simulate a kill between the two renames.
  renameSync(join(sb.into, 'runtime'), join(sb.into, 'runtime.old'));
  mkdirSync(join(sb.into, 'runtime.new'));
  writeFileSync(join(sb.into, 'runtime.new', 'node'), 'staged');
  rmSync(join(sb.official, sb.archiveName));
  rmSync(join(sb.mirror, sb.archiveName));
  const r = run(sb);
  assert.equal(r.last, 'runtime:current', r.stdout + r.stderr);
  assert.match(r.stdout, /restored runtime from runtime.old/);
  assert.deepEqual(readFileSync(join(sb.into, 'runtime', 'node')), sb.binBuf);
  assert.deepEqual(listTree(sb.into), ['runtime', 'runtime/VERIFIED', 'runtime/VERSION', 'runtime/node']);
});

test('recovery does not restore a runtime.old that fails the size check', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  mkdirSync(join(sb.into, 'runtime.old'));
  writeFileSync(join(sb.into, 'runtime.old', 'node'), 'short');
  writeFileSync(join(sb.into, 'runtime.old', 'VERIFIED'), `999 ${'d'.repeat(64)}`);
  writeFileSync(join(sb.into, 'runtime.old', 'VERSION'), `${VERSION} ${PLAT}`);
  const r = run(sb);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout);
  assert.ok(!r.stdout.includes('restored'));
  assert.deepEqual(readFileSync(join(sb.into, 'runtime', 'node')), sb.binBuf);
  assert.ok(!existsSync(join(sb.into, 'runtime.old')));
});

test('--stage-only on a current runtime removes a stale runtime.new', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  run(sb);
  mkdirSync(join(sb.into, 'runtime.new'));
  writeFileSync(join(sb.into, 'runtime.new', 'node'), 'stale');
  const r = run(sb, ['--stage-only']);
  assert.equal(r.last, 'runtime:current');
  assert.ok(!existsSync(join(sb.into, 'runtime.new')));
});

// --force (the updater's repair mode): a runtime that looks current is
// downloaded and verified again, into a fresh folder (a new file, so a binary
// macOS refuses to run, Gatekeeper exit 137, is really replaced).
test('--force re-provisions a current runtime into a fresh file', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  run(sb);
  const node = join(sb.into, 'runtime', 'node');
  const inoBefore = statSync(node).ino;
  const r = run(sb, ['--force']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`);
  assert.match(r.stdout, /runtime: --force: re-provisioning/);
  assert.deepEqual(readFileSync(node), sb.binBuf);
  assert.notEqual(statSync(node).ino, inoBefore, 'the binary is a new file');
  assert.deepEqual(listTree(sb.into), ['runtime', 'runtime/VERIFIED', 'runtime/VERSION', 'runtime/node']);
});

test('--force --stage-only stages runtime.new even when the runtime is current', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  run(sb);
  const before = snapshot(join(sb.into, 'runtime'));
  const r = run(sb, ['--stage-only', '--force']);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout + r.stderr);
  assert.deepEqual(snapshot(join(sb.into, 'runtime')), before, 'runtime/ untouched');
  assert.deepEqual(readFileSync(join(sb.into, 'runtime.new', 'node')), sb.binBuf);
});

test('--force with both sources down fails and leaves the current runtime untouched', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  run(sb);
  const before = snapshot(sb.into);
  rmSync(join(sb.official, sb.archiveName));
  rmSync(join(sb.mirror, sb.archiveName));
  const r = run(sb, ['--stage-only', '--force']);
  assert.equal(r.last, 'err:runtime');
  assert.deepEqual(snapshot(sb.into), before);
});

for (const [sig, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${sig} during the download cleans up and exits ${code}`, async (t) => {
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    const sb = sandbox();
    t.after(sb.cleanup);
    installOld(sb);
    const before = snapshot(sb.into);
    let resolveHit;
    const hit = new Promise((r) => { resolveHit = r; });
    // A server that starts a response and never finishes it.
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-length': '1000000' });
      res.write('partial');
      resolveHit();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.closeAllConnections?.(); server.close(); });
    const env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: sb.root, TMPDIR: sb.tmp,
      GAFFER_FETCH_TEST: '1', GAFFER_FETCH_PINS: sb.pinsPath,
      GAFFER_FETCH_BASE_OFFICIAL: `http://127.0.0.1:${server.address().port}/`,
      GAFFER_FETCH_BASE_MIRROR: urlOf(sb.mirror),
      GAFFER_FETCH_SKIP_CODESIGN: '1', GAFFER_FETCH_PLATFORM: PLAT,
    };
    const c = spawn('/bin/bash', [SCRIPT, '--into', sb.into], { env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    const closed = new Promise((r) => c.on('close', (codeV) => r(codeV)));
    await hit;
    await new Promise((r) => setTimeout(r, 200));
    c.kill(sig);
    const exit = await closed;
    assert.equal(exit, code, out);
    assert.equal(out.trim().split('\n').pop(), 'err:runtime');
    assert.deepEqual(snapshot(sb.into), before);
    assert.deepEqual(readdirSync(sb.tmp), []);
  });
}

test('HTTP 404 HTML error page from official falls back to the mirror (curl --fail)', async (t) => {
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

test('a stalled official download gives up within the budget and falls to the mirror', async (t) => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const sb = sandbox();
  t.after(sb.cleanup);
  let hits = 0;
  // Headers, a few bytes, then nothing: below 10 KB/s forever.
  const server = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-length': '50000000' });
    res.write('stall');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: sb.root, TMPDIR: sb.tmp,
    GAFFER_FETCH_TEST: '1', GAFFER_FETCH_PINS: sb.pinsPath,
    GAFFER_FETCH_BASE_OFFICIAL: `http://127.0.0.1:${server.address().port}/`,
    GAFFER_FETCH_BASE_MIRROR: urlOf(sb.mirror),
    GAFFER_FETCH_SKIP_CODESIGN: '1', GAFFER_FETCH_PLATFORM: PLAT,
    GAFFER_FETCH_SPEED_TIME: '1', GAFFER_FETCH_MAX_TIME: '4',
  };
  const t0 = Date.now();
  const out = await new Promise((resolve) => {
    const c = spawn('/bin/bash', [SCRIPT, '--into', sb.into], { env });
    let s = '';
    c.stdout.on('data', (d) => { s += d; });
    c.on('close', () => resolve(s));
  });
  const secs = (Date.now() - t0) / 1000;
  assert.equal(out.trim().split('\n').pop(), `runtime:installed ${VERSION} ${PLAT}`, out);
  assert.ok(out.includes('runtime: official download failed, using the mirror'), out);
  assert.match(out, /curl exit 28/);
  assert.ok(hits >= 1, 'official was tried');
  // Retries stop once GAFFER_FETCH_MAX_TIME (4 s) has passed on one source.
  assert.ok(secs < 15, `gave up in ${secs}s`);
  assert.deepEqual(readdirSync(sb.tmp), []);
});

test('stale gaffer-runtime temp folders older than a day are swept, others kept', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const old = join(sb.tmp, 'gaffer-runtime-AbC123');
  const fresh = join(sb.tmp, 'gaffer-runtime-XyZ789');
  const otherName = join(sb.tmp, 'gaffer-runtime-keep-me');
  const otherFile = join(sb.tmp, 'gaffer-runtime-Zz9999.txt');
  for (const d of [old, fresh, otherName]) {
    mkdirSync(d);
    writeFileSync(join(d, 'node.tar.gz'), 'partial');
  }
  writeFileSync(otherFile, 'not a dir');
  const twoDays = new Date(Date.now() - 2 * 86400 * 1000);
  for (const p of [old, otherName, otherFile]) utimesSync(p, twoDays, twoDays);
  const r = run(sb);
  assert.equal(r.last, `runtime:installed ${VERSION} ${PLAT}`, r.stdout + r.stderr);
  assert.deepEqual(readdirSync(sb.tmp).sort(),
    ['gaffer-runtime-XyZ789', 'gaffer-runtime-Zz9999.txt', 'gaffer-runtime-keep-me']);
});
