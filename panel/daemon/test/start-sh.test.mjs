// Tests for panel/daemon/start.sh (spec section 5): the ExtendScript-route
// launcher must reach the same verdict as resolveDaemonLaunch
// (panel/daemon-launch.js) and keep the output contract
//   pid:<N> runtime | pid:<N> node | err:runtime-damaged | err:runtime-missing
//
// Every test builds a sandbox whose path has spaces and accents (the real
// extension path contains "Application Support"):
//   <root>/Applicätion Support/com.gaffer.panel/daemon/   start.sh + fakes
//   <root>/sys bin/node                                    fake system node
//   <root>/tools/                                          the only PATH dir
// The fake runtime and fake system node are shell scripts that exec the real
// node with FAKE_BIN=runtime|system, and the fake daemon.mjs / index.js write
// a marker (pid, argv, cwd, env) instead of starting a real daemon: nothing
// binds 9823/9824. The log goes to the sandbox via GAFFER_DAEMON_LOG, never
// /tmp/gaffer-daemon.log. The fixed system-node candidates (/opt/homebrew/...)
// are replaced through GAFFER_START_TEST_NODE_CANDIDATES so "no system node"
// is testable on a Mac that has one.
//
// bash only: skipped on Windows (start.ps1 is covered statically in
// launch-cjs.test.mjs and live on the VM).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync,
  copyFileSync, chmodSync, symlinkSync, rmSync, realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'start.sh');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const PLACEHOLDER = 'PENDING-FIRST-ACCEPTANCE-RUN';
const TOOLS = ['dirname', 'wc', 'tr', 'shasum', 'cut', 'grep', 'sed', 'cat', 'chmod', 'env', 'nohup', 'date', 'head', 'printf', 'uname'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Fake daemon entry: records who ran it, then exits (or stays up on an
// ephemeral loopback port when FAKE_STAY=1, to prove the caller's pipe is
// not inherited). Valid as CJS (.js without package.json) and ESM (.mjs).
const FAKE_DAEMON = `
import('node:fs').then(async (fs) => {
  const path = await import('node:path');
  console.log('fake daemon stdout line');
  fs.writeFileSync(path.join(process.cwd(), 'marker-' + process.pid + '.json'), JSON.stringify({
    pid: process.pid, argv: process.argv, cwd: process.cwd(), env: process.env,
  }));
  fs.writeFileSync(path.join(process.cwd(), 'marker.json'), String(process.pid));
  if (process.env.FAKE_STAY === '1') {
    const net = await import('node:net');
    const srv = net.createServer().listen(0, '127.0.0.1');
    setTimeout(() => { srv.close(); process.exit(0); }, 20000);
  }
});
`;

function fakeNode(file, tag) {
  writeFileSync(file, `#!/bin/sh\nFAKE_BIN=${tag}; export FAKE_BIN\nexec "${process.execPath}" "$@"\n`);
  chmodSync(file, 0o755);
  return readFileSync(file);
}

function toolsDir(root) {
  const dir = join(root, 'tools');
  mkdirSync(dir);
  for (const t of TOOLS) {
    let p = '';
    try { p = execFileSync('/bin/sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(); } catch { /* builtin only */ }
    if (p.startsWith('/')) symlinkSync(p, join(dir, t));
  }
  return dir;
}

// opts: runtime (default true), bundle (daemon.mjs, default true),
// index (index.js, default true), stamp (string | null), pinSha ('real' |
// 'wrong' | 'placeholder'), pinSize ('match' | 'other'), sysNode (default
// false), dev (default false)
function sandbox(opts = {}) {
  const o = { runtime: true, bundle: true, index: true, stamp: null, pinSha: 'real', pinSize: 'match', sysNode: false, dev: false, ...opts };
  const root = mkdtempSync(join(tmpdir(), 'gaffer start sh '));
  roots.push(root);
  const repo = join(root, 'Applicätion Support');
  const ext = join(repo, 'com.gaffer.panel');
  const dir = join(ext, 'daemon');
  mkdirSync(dir, { recursive: true });
  if (o.dev) mkdirSync(join(repo, '.git'));
  copyFileSync(SCRIPT, join(dir, 'start.sh'));
  if (o.bundle) writeFileSync(join(dir, 'daemon.mjs'), FAKE_DAEMON);
  if (o.index) writeFileSync(join(dir, 'index.js'), FAKE_DAEMON);

  let size = 0;
  let sha = '';
  if (o.runtime) {
    mkdirSync(join(dir, 'runtime'));
    const buf = fakeNode(join(dir, 'runtime', 'node'), 'runtime');
    size = buf.length;
    sha = sha256(buf);
    if (o.stamp !== null) writeFileSync(join(dir, 'runtime', 'VERIFIED'), o.stamp.replace('<size>', String(size)).replace('<sha>', sha));
  }
  const pinSha = o.pinSha === 'real' ? sha : o.pinSha === 'wrong' ? 'f'.repeat(64) : PLACEHOLDER;
  const pinBytes = o.pinSize === 'match' ? size : size + 1;
  // Same layout as the committed runtime-pins.json (pretty-printed).
  writeFileSync(join(dir, 'runtime-pins.json'), JSON.stringify({
    node: {
      version: 'v24.22.1',
      platforms: {
        'darwin-x64': { archive: 'x.tar.gz', binaryBytes: 999, binarySha256: 'a'.repeat(64) },
        'darwin-arm64': { archive: 'y.tar.gz', binaryBytes: pinBytes, binarySha256: pinSha },
        'win-x64': { archive: 'z.zip', binaryBytes: pinBytes, binarySha256: pinSha },
      },
    },
  }, null, 2) + '\n');

  const sysbin = join(root, 'sys bin');
  mkdirSync(sysbin);
  if (o.sysNode) fakeNode(join(sysbin, 'node'), 'system');

  const log = join(root, 'daemon log.txt');
  const tools = toolsDir(root);
  return { root, ext, dir, sysbin, log, tools, size, sha };
}

const spawned = [];
const roots = [];
function run(sb, extraEnv = {}) {
  const env = {
    HOME: sb.root,
    PATH: sb.tools + ':' + sb.sysbin,
    GAFFER_DAEMON_LOG: sb.log,
    GAFFER_START_TEST_NODE_CANDIDATES: '',
    ...extraEnv,
  };
  const t0 = Date.now();
  const r = spawnSync('/bin/bash', [join(sb.dir, 'start.sh')], { env, encoding: 'utf8', timeout: 15000 });
  const ms = Date.now() - t0;
  const m = /pid:(\d+)/.exec(r.stdout || '');
  if (m) spawned.push(Number(m[1]));
  return { ...r, ms };
}

async function marker(sb, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const p = join(sb.dir, 'marker.json');
    if (existsSync(p)) {
      const pid = readFileSync(p, 'utf8');
      const f = join(sb.dir, `marker-${pid}.json`);
      if (pid && existsSync(f)) {
        try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* partial write */ }
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

const logText = (sb) => (existsSync(sb.log) ? readFileSync(sb.log, 'utf8') : '');
const opts = { skip: IS_WIN ? 'bash launcher, not run on Windows' : false };

process.on('exit', () => {
  for (const pid of spawned) { try { process.kill(pid); } catch { /* gone */ } }
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test('stamp present and size matches: launches the runtime with daemon.mjs', opts, async () => {
  const sb = sandbox({ stamp: '<size> <sha>\n' });
  const r = run(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^pid:\d+ runtime$/);
  const mk = await marker(sb);
  assert.ok(mk, 'fake daemon ran');
  assert.equal(String(mk.pid), /pid:(\d+)/.exec(r.stdout)[1], 'printed pid is the daemon pid');
  assert.equal(mk.env.FAKE_BIN, 'runtime');
  assert.match(mk.argv[1], /daemon\.mjs$/);
  assert.equal(mk.cwd, realpathSync(sb.dir));
  const log = logText(sb);
  assert.match(log, /fake daemon stdout line/, 'daemon stdout goes to the log');
  assert.match(log, /launching daemon via runtime/);
});

test('legacy size=<n> stamp is accepted', opts, async () => {
  const sb = sandbox({ stamp: 'size=<size>\nsha256=<sha>\n' });
  const r = run(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^pid:\d+ runtime$/);
  assert.ok(await marker(sb));
});

test('stamp size mismatch: err:runtime-damaged, never falls back to a system node', opts, async () => {
  const sb = sandbox({ stamp: '12345 abc\n', sysNode: true });
  const r = run(sb);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.trim(), 'err:runtime-damaged');
  assert.equal(await marker(sb, 600), null, 'nothing launched');
  assert.match(logText(sb), /does not match the stamp 12345/);
  assert.match(logText(sb), /daemon not launched: err:runtime-damaged/);
});

test('runtime present but daemon.mjs missing: err:runtime-damaged', opts, async () => {
  const sb = sandbox({ stamp: '<size> <sha>\n', bundle: false, sysNode: true });
  const r = run(sb);
  assert.equal(r.stdout.trim(), 'err:runtime-damaged');
  assert.equal(await marker(sb, 600), null);
});

test('stamp absent, size and sha256 match the pin: launches and writes the stamp', opts, async () => {
  const sb = sandbox({ stamp: null });
  const r = run(sb);
  if (!IS_MAC) {
    // resolveDaemonLaunch only knows darwin and win32 pins.
    assert.equal(r.stdout.trim(), 'err:runtime-damaged');
    return;
  }
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^pid:\d+ runtime$/);
  assert.equal(readFileSync(join(sb.dir, 'runtime', 'VERIFIED'), 'utf8'), `${sb.size} ${sb.sha}\n`);
  assert.ok(await marker(sb));
  assert.match(logText(sb), /first run, sha256 matches the pin for darwin-arm64/);
});

test('stamp absent, sha256 does not match the pin: damaged, no stamp written', opts, async () => {
  const sb = sandbox({ stamp: null, pinSha: 'wrong', sysNode: true });
  const r = run(sb);
  assert.equal(r.stdout.trim(), 'err:runtime-damaged');
  assert.equal(existsSync(join(sb.dir, 'runtime', 'VERIFIED')), false);
  assert.equal(await marker(sb, 600), null);
});

test('stamp absent, size matches no pin: damaged', opts, async () => {
  const sb = sandbox({ stamp: null, pinSize: 'other' });
  const r = run(sb);
  assert.equal(r.stdout.trim(), 'err:runtime-damaged');
  assert.match(logText(sb), /matches no pinned binary/);
});

test('stamp absent, placeholder pin sha: skips the hash, records unhashed', opts, async () => {
  const sb = sandbox({ stamp: null, pinSha: 'placeholder' });
  const r = run(sb);
  if (!IS_MAC) { assert.equal(r.stdout.trim(), 'err:runtime-damaged'); return; }
  assert.match(r.stdout.trim(), /^pid:\d+ runtime$/);
  assert.equal(readFileSync(join(sb.dir, 'runtime', 'VERIFIED'), 'utf8'), `${sb.size} unhashed\n`);
  assert.match(logText(sb), /is a placeholder \(PENDING-FIRST-ACCEPTANCE-RUN\)/);
  assert.ok(await marker(sb));
});

test('macOS: lost exec bit is restored with chmod 755', { skip: IS_MAC ? false : 'darwin only' }, async () => {
  const sb = sandbox({ stamp: '<size> <sha>\n' });
  chmodSync(join(sb.dir, 'runtime', 'node'), 0o644);
  const r = run(sb);
  assert.match(r.stdout.trim(), /^pid:\d+ runtime$/);
  assert.equal(statSync(join(sb.dir, 'runtime', 'node')).mode & 0o777, 0o755);
  assert.match(logText(sb), /exec bit was missing, restored with chmod 755/);
  assert.ok(await marker(sb));
});

test('runtime missing, system node on PATH: pid:<N> node with daemon.mjs', opts, async () => {
  const sb = sandbox({ runtime: false, sysNode: true });
  const r = run(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^pid:\d+ node$/);
  const mk = await marker(sb);
  assert.equal(mk.env.FAKE_BIN, 'system');
  assert.match(mk.argv[1], /daemon\.mjs$/);
  assert.match(logText(sb), /no bundled runtime at .*probing for a system node/);
});

test('runtime missing, no daemon.mjs: system node runs index.js', opts, async () => {
  const sb = sandbox({ runtime: false, bundle: false, sysNode: true });
  const r = run(sb);
  assert.match(r.stdout.trim(), /^pid:\d+ node$/);
  const mk = await marker(sb);
  assert.match(mk.argv[1], /index\.js$/);
});

test('runtime missing, fixed candidate probed before PATH', opts, async () => {
  const sb = sandbox({ runtime: false, sysNode: true });
  const fixed = join(sb.root, 'fixed dir', 'node');
  mkdirSync(dirname(fixed));
  fakeNode(fixed, 'fixed');
  const r = run(sb, { GAFFER_START_TEST_NODE_CANDIDATES: fixed });
  assert.match(r.stdout.trim(), /^pid:\d+ node$/);
  assert.equal((await marker(sb)).env.FAKE_BIN, 'fixed');
});

test('runtime missing and no system node: err:runtime-missing', opts, async () => {
  const sb = sandbox({ runtime: false, sysNode: false });
  const r = run(sb);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.trim(), 'err:runtime-missing');
  assert.match(logText(sb), /daemon not launched: err:runtime-missing/);
});

test('dev checkout (.git next to the panel): system node with index.js even with a runtime', opts, async () => {
  const sb = sandbox({ stamp: '<size> <sha>\n', sysNode: true, dev: true });
  const r = run(sb);
  assert.match(r.stdout.trim(), /^pid:\d+ node$/);
  const mk = await marker(sb);
  assert.equal(mk.env.FAKE_BIN, 'system');
  assert.match(mk.argv[1], /index\.js$/);
});

test('hostile NODE_OPTIONS / NODE_PATH / NODE_EXTRA_CA_CERTS are cleared; CA passed on for claude', opts, async () => {
  const sb = sandbox({ stamp: '<size> <sha>\n' });
  const evil = join(sb.root, 'evil.cjs');
  writeFileSync(evil, `require('fs').writeFileSync(${JSON.stringify(join(sb.root, 'pwned'))}, 'x');`);
  const r = run(sb, {
    NODE_OPTIONS: `--require "${evil}"`,
    NODE_PATH: join(sb.root, 'evil modules'),
    NODE_EXTRA_CA_CERTS: '/corp/ca.pem',
    KEEP_ME: 'yes',
  });
  assert.match(r.stdout.trim(), /^pid:\d+ runtime$/);
  const mk = await marker(sb);
  assert.equal(mk.env.NODE_OPTIONS, undefined);
  assert.equal(mk.env.NODE_PATH, undefined);
  assert.equal(mk.env.NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(mk.env.GAFFER_CLAUDE_EXTRA_CA_CERTS, '/corp/ca.pem');
  assert.equal(mk.env.KEEP_ME, 'yes', 'other variables stay');
  assert.equal(mk.env.HOME, sb.root);
  assert.equal(existsSync(join(sb.root, 'pwned')), false, 'NODE_OPTIONS payload never ran');
});

test('an existing GAFFER_CLAUDE_EXTRA_CA_CERTS is not overwritten', opts, async () => {
  const sb = sandbox({ stamp: '<size> <sha>\n' });
  run(sb, { NODE_EXTRA_CA_CERTS: '/corp/ca.pem', GAFFER_CLAUDE_EXTRA_CA_CERTS: '/mine.pem' });
  const mk = await marker(sb);
  assert.equal(mk.env.GAFFER_CLAUDE_EXTRA_CA_CERTS, '/mine.pem');
});

test('the log is appended, never truncated', opts, async () => {
  const sb = sandbox({ stamp: '<size> <sha>\n' });
  writeFileSync(sb.log, 'earlier line\n');
  run(sb);
  assert.ok(await marker(sb));
  await new Promise((r) => setTimeout(r, 200));
  assert.match(logText(sb), /^earlier line\n/);
});

test('the caller reading stdout to EOF returns while the daemon keeps running', opts, async () => {
  const sb = sandbox({ stamp: '<size> <sha>\n' });
  const r = run(sb, { FAKE_STAY: '1' });
  assert.match(r.stdout.trim(), /^pid:\d+ runtime$/);
  assert.ok(r.ms < 5000, `start.sh returned after ${r.ms} ms`);
  const mk = await marker(sb);
  assert.ok(mk);
  const pid = Number(/pid:(\d+)/.exec(r.stdout)[1]);
  assert.doesNotThrow(() => process.kill(pid, 0), 'daemon still alive after the launcher returned');
  process.kill(pid);
});

test('static: the GAFFER_USE_BINARY / SEA binary branch is gone', opts, () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /GAFFER_USE_BINARY/);
  assert.doesNotMatch(src, /gaffer-daemon"/);
  assert.match(src, /env -u NODE_OPTIONS -u NODE_PATH -u NODE_EXTRA_CA_CERTS nohup/);
  assert.match(src, /\/tmp\/gaffer-daemon\.log/);
  assert.match(src, /shasum -a 256/);
});
