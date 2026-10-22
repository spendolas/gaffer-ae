// panel/daemon-launch.js is a plain browser script (ES5, assigns
// window.GafferLaunch). Load it into a node:vm context with a stub window,
// the same way the panel's <script> tag would, and drive every branch of
// resolveDaemonLaunch through a fake fs (no real files, no spawn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../../daemon-launch.js', import.meta.url)), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: 'daemon-launch.js' });
const L = sandbox.window.GafferLaunch;
const plain = (o) => JSON.parse(JSON.stringify(o));

const SHA_X64 = 'cc6f41f72e3eb4460154952e56a35afdd96b6995cea51cd25e637355a2955a51';
const SHA_WIN = 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5';
const PLACEHOLDER = 'PENDING-FIRST-ACCEPTANCE-RUN';
// Same shape as panel/daemon/runtime-pins.json (spec section 2).
const PINS = {
  node: {
    version: 'v24.22.1',
    platforms: {
      'darwin-x64': { binaryBytes: 125715808, binarySha256: SHA_X64 },
      'darwin-arm64': { binaryBytes: 122545856, binarySha256: PLACEHOLDER },
      'win-x64': { binaryBytes: 93915464, binarySha256: SHA_WIN },
    },
  },
};

// Fake fs: files is { path: { size, mode, content } }. Directories are implied
// by any file under them. Records writes and chmods.
function fakeFs(files) {
  const writes = {};
  const chmods = [];
  const fs = {
    existsSync(p) {
      if (files[p]) return true;
      const pre = p.replace(/[\\/]+$/, '');
      return Object.keys(files).some((k) => k.startsWith(pre + '/') || k.startsWith(pre + '\\'));
    },
    statSync(p) {
      const f = files[p];
      if (!f) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
      return { size: f.size, mode: f.mode == null ? 0o100755 : f.mode };
    },
    readFileSync(p) {
      const f = files[p];
      if (!f || f.content == null) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
      return f.content;
    },
    writeFileSync(p, data) {
      if (files.__readOnly) throw new Error('EACCES: ' + p);
      writes[p] = String(data);
    },
    chmodSync(p, mode) { chmods.push([p, mode]); if (files.__noChmod) throw new Error('EPERM'); },
  };
  return { fs, writes, chmods };
}

const MAC_DIR = '/Users/x/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel/daemon';
const MAC_BIN = MAC_DIR + '/runtime/node';
const MAC_STAMP = MAC_DIR + '/runtime/VERIFIED';
const MAC_BUNDLE = MAC_DIR + '/daemon.mjs';
const MAC_INDEX = MAC_DIR + '/index.js';

function mac(files, extra) {
  const { fs, writes, chmods } = fakeFs(files);
  let hashed = 0;
  const opts = Object.assign({
    daemonDir: MAC_DIR, platform: 'darwin', fs, pins: PINS, env: { PATH: '/usr/bin:/bin' },
    detectDev: () => false,
    hashFile: () => { hashed++; return SHA_X64; },
  }, extra || {});
  const r = L.resolveDaemonLaunch(opts);
  return { r: plain(r), writes, chmods, hashed: () => hashed };
}

test('exposes the API on window.GafferLaunch', () => {
  for (const fn of ['resolveDaemonLaunch', 'cleanDaemonEnv', 'normalizeWinPath', 'launchNotice']) {
    assert.equal(typeof L[fn], 'function', fn);
  }
});

test('also exports through module.exports when module exists', () => {
  const sb = { window: {}, module: { exports: {} } };
  vm.runInNewContext(source, sb);
  assert.equal(typeof sb.module.exports.resolveDaemonLaunch, 'function');
});

// ── runtime present, stamp present ──

test('stamp present and size matches: runtime + daemon.mjs, no hashing', () => {
  const { r, hashed } = mac({
    [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 },
    [MAC_STAMP]: { content: '125715808 ' + SHA_X64 + '\n' },
  });
  assert.equal(r.kind, 'runtime');
  assert.equal(r.bin, MAC_BIN);
  assert.deepEqual(r.args, ['daemon.mjs']);
  assert.equal(r.cwd, MAC_DIR);
  assert.equal(hashed(), 0);
});

test('stamp in the PoC size= form is also read', () => {
  const { r } = mac({
    [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 },
    [MAC_STAMP]: { content: 'size=125715808\nsha256=' + SHA_X64 + '\n' },
  });
  assert.equal(r.kind, 'runtime');
});

test('stamp present but size differs (truncated): runtime-damaged, never system node', () => {
  const { r } = mac({
    [MAC_BIN]: { size: 1000 }, [MAC_BUNDLE]: { size: 10 },
    [MAC_STAMP]: { content: '125715808 ' + SHA_X64 },
    '/opt/homebrew/bin/node': { size: 1 }, [MAC_INDEX]: { size: 1 },
  });
  assert.equal(r.error, 'runtime-damaged');
  assert.equal(r.bin, undefined);
});

test('runtime present but daemon.mjs missing: runtime-damaged, never system node', () => {
  const { r } = mac({
    [MAC_BIN]: { size: 125715808 }, [MAC_STAMP]: { content: '125715808 ' + SHA_X64 },
    '/opt/homebrew/bin/node': { size: 1 }, [MAC_INDEX]: { size: 1 },
  });
  assert.equal(r.error, 'runtime-damaged');
});

// ── exec bit (macOS) ──

test('macOS: exec bit lost with a matching stamp is restored with chmod 755 and logged', () => {
  const { r, chmods } = mac({
    [MAC_BIN]: { size: 125715808, mode: 0o100644 }, [MAC_BUNDLE]: { size: 10 },
    [MAC_STAMP]: { content: '125715808 ' + SHA_X64 },
  });
  assert.equal(r.kind, 'runtime');
  assert.deepEqual(chmods, [[MAC_BIN, 0o755]]);
  assert.ok(r.notes.some((n) => /exec/i.test(n) && /755/.test(n)), JSON.stringify(r.notes));
});

test('macOS: executable binary is not chmodded', () => {
  const { chmods } = mac({
    [MAC_BIN]: { size: 125715808, mode: 0o100755 }, [MAC_BUNDLE]: { size: 10 },
    [MAC_STAMP]: { content: '125715808 ' + SHA_X64 },
  });
  assert.deepEqual(chmods, []);
});

test('macOS: chmod failure is runtime-damaged', () => {
  const { r } = mac({
    [MAC_BIN]: { size: 125715808, mode: 0o100644 }, [MAC_BUNDLE]: { size: 10 },
    [MAC_STAMP]: { content: '125715808 ' + SHA_X64 }, __noChmod: true,
  });
  assert.equal(r.error, 'runtime-damaged');
});

test('Windows never chmods', () => {
  const D = 'C:\\G\\daemon';
  const { fs, chmods } = fakeFs({
    [D + '\\runtime\\node.exe']: { size: 93915464, mode: 0o100666 }, [D + '\\daemon.mjs']: { size: 1 },
    [D + '\\runtime\\VERIFIED']: { content: '93915464 ' + SHA_WIN },
  });
  const r = L.resolveDaemonLaunch({ daemonDir: D, platform: 'win32', fs, pins: PINS, env: {}, detectDev: () => false });
  assert.equal(r.kind, 'runtime');
  assert.deepEqual(chmods, []);
});

// ── stamp-less first run (README install) ──

test('no stamp: hashes once against the pin, writes the stamp, uses the runtime', () => {
  const { r, writes, hashed } = mac({ [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 } });
  assert.equal(r.kind, 'runtime');
  assert.equal(hashed(), 1);
  assert.equal(writes[MAC_STAMP], '125715808 ' + SHA_X64 + '\n');
});

test('no stamp, hash mismatch: runtime-damaged, no stamp written', () => {
  const { r, writes } = mac({ [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 } },
    { hashFile: () => 'f'.repeat(64) });
  assert.equal(r.error, 'runtime-damaged');
  assert.equal(writes[MAC_STAMP], undefined);
});

test('no stamp, size matches no pin for the platform: runtime-damaged without hashing', () => {
  const { r, hashed } = mac({ [MAC_BIN]: { size: 5 }, [MAC_BUNDLE]: { size: 10 } });
  assert.equal(r.error, 'runtime-damaged');
  assert.equal(hashed(), 0);
});

test('no stamp, placeholder pin (darwin-arm64): skips the hash, logs it, still checks size', () => {
  const { r, writes, hashed } = mac({ [MAC_BIN]: { size: 122545856 }, [MAC_BUNDLE]: { size: 10 } });
  assert.equal(r.kind, 'runtime');
  assert.equal(hashed(), 0);
  assert.ok(r.notes.some((n) => /placeholder|pending/i.test(n)), JSON.stringify(r.notes));
  assert.equal(writes[MAC_STAMP], undefined, "no stamp for a placeholder pin, so a later run re-evaluates");
});

test("no stamp, pin that is neither 64 hex nor the exact placeholder: runtime-damaged", () => {
  for (const bad of ["pending", "PENDING-FIRST-ACCEPTANCE-RUN ", "<6f320694...f329>", "", null]) {
    const pins = { node: { platforms: { "darwin-x64": { binaryBytes: 125715808, binarySha256: bad } } } };
    const { r, writes, hashed } = mac({ [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 } }, { pins });
    assert.equal(r.error, "runtime-damaged", String(bad));
    assert.equal(hashed(), 0);
    assert.equal(writes[MAC_STAMP], undefined);
  }
});

test('no stamp and no pins available: runtime-damaged (cannot verify)', () => {
  const { r } = mac({ [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 } }, { pins: null });
  assert.equal(r.error, 'runtime-damaged');
});

test('no stamp, hash ok but stamp write fails: still uses the runtime and logs', () => {
  const { r } = mac({ [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 }, __readOnly: true });
  assert.equal(r.kind, 'runtime');
  assert.ok(r.notes.some((n) => /stamp/i.test(n)));
});

test('garbled stamp is treated as absent and re-verified by hash', () => {
  const { r, hashed, writes } = mac({
    [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 }, [MAC_STAMP]: { content: 'garbage' },
  });
  assert.equal(r.kind, 'runtime');
  assert.equal(hashed(), 1);
  assert.equal(writes[MAC_STAMP], '125715808 ' + SHA_X64 + '\n');
});

test('hashFile throwing is runtime-damaged', () => {
  const { r } = mac({ [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 } },
    { hashFile: () => { throw new Error('EIO'); } });
  assert.equal(r.error, 'runtime-damaged');
});

// ── no runtime: system node probe ──

test('runtime/ absent, packaged tree: system node with daemon.mjs (preferred over index.js)', () => {
  const { r } = mac({ '/usr/local/bin/node': { size: 1 }, [MAC_BUNDLE]: { size: 1 }, [MAC_INDEX]: { size: 1 } });
  assert.equal(r.kind, 'node');
  assert.equal(r.bin, '/usr/local/bin/node');
  assert.deepEqual(r.args, ['daemon.mjs']);
  assert.equal(r.cwd, MAC_DIR);
});

test('runtime/ absent, no daemon.mjs (0.11.x mid-migration): system node with index.js', () => {
  const { r } = mac({ '/opt/homebrew/bin/node': { size: 1 }, [MAC_INDEX]: { size: 1 } });
  assert.equal(r.kind, 'node');
  assert.equal(r.bin, '/opt/homebrew/bin/node');
  assert.deepEqual(r.args, ['index.js']);
});

test('macOS candidate order: homebrew, then /usr/local, then /usr/bin', () => {
  const all = { '/opt/homebrew/bin/node': { size: 1 }, '/usr/local/bin/node': { size: 1 }, '/usr/bin/node': { size: 1 }, [MAC_INDEX]: { size: 1 } };
  assert.equal(mac(all).r.bin, '/opt/homebrew/bin/node');
  delete all['/opt/homebrew/bin/node'];
  assert.equal(mac(all).r.bin, '/usr/local/bin/node');
  delete all['/usr/local/bin/node'];
  assert.equal(mac(all).r.bin, '/usr/bin/node');
});

test('macOS: falls back to a node on PATH after the fixed candidates', () => {
  const { r } = mac({ '/Users/x/.nvm/bin/node': { size: 1 }, [MAC_INDEX]: { size: 1 } },
    { env: { PATH: '/nope:/Users/x/.nvm/bin' } });
  assert.equal(r.bin, '/Users/x/.nvm/bin/node');
});

test('runtime binary deleted (runtime/ dir still there) falls to the probe', () => {
  const { r } = mac({ [MAC_STAMP]: { content: '125715808 ' + SHA_X64 }, '/usr/bin/node': { size: 1 }, [MAC_BUNDLE]: { size: 1 } });
  assert.equal(r.kind, 'node');
  assert.equal(r.bin, '/usr/bin/node');
});

test('no runtime and no system node: runtime-missing', () => {
  const { r } = mac({ [MAC_INDEX]: { size: 1 } }, { env: {} });
  assert.equal(r.error, 'runtime-missing');
});

test('dev install uses the system node with index.js even when a runtime and a stale daemon.mjs exist', () => {
  const { r } = mac({
    [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 }, [MAC_INDEX]: { size: 1 },
    [MAC_STAMP]: { content: '125715808 ' + SHA_X64 }, '/opt/homebrew/bin/node': { size: 1 },
  }, { detectDev: () => true });
  assert.equal(r.kind, 'node');
  assert.equal(r.bin, '/opt/homebrew/bin/node');
  assert.deepEqual(r.args, ['index.js']);
});

test('detectDev throwing counts as not dev', () => {
  const { r } = mac({ [MAC_BIN]: { size: 125715808 }, [MAC_BUNDLE]: { size: 10 }, [MAC_STAMP]: { content: '125715808 x' } },
    { detectDev: () => { throw new Error('boom'); } });
  assert.equal(r.kind, 'runtime');
});

// ── Windows ──

const WIN_EXT_FWD = 'C:/Users/Ana Lu\u00eds/AppData/Roaming/Adobe/CEP/extensions/com.gaffer.panel';
const WIN_DIR = 'C:\\Users\\Ana Lu\u00eds\\AppData\\Roaming\\Adobe\\CEP\\extensions\\com.gaffer.panel\\daemon';

function win(files, extra) {
  const { fs, writes } = fakeFs(files);
  const opts = Object.assign({
    daemonDir: WIN_EXT_FWD + '/daemon', platform: 'win32', fs, pins: PINS,
    env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local', Path: 'C:\\Windows' },
    detectDev: () => false, hashFile: () => SHA_WIN,
  }, extra || {});
  return { r: plain(L.resolveDaemonLaunch(opts)), writes };
}

test('Windows: forward-slash extension path is normalised to backslashes for bin and cwd', () => {
  const { r } = win({
    [WIN_DIR + '\\runtime\\node.exe']: { size: 93915464 }, [WIN_DIR + '\\daemon.mjs']: { size: 1 },
    [WIN_DIR + '\\runtime\\VERIFIED']: { content: '93915464 ' + SHA_WIN + '\r\n' },
  });
  assert.equal(r.kind, 'runtime');
  assert.equal(r.bin, WIN_DIR + '\\runtime\\node.exe');
  assert.equal(r.cwd, WIN_DIR);
  assert.deepEqual(r.args, ['daemon.mjs']);
  assert.ok(!/\//.test(r.bin + r.cwd));
});

test('Windows: stamp-less run hashes against the win-x64 pin and writes the stamp', () => {
  const { r, writes } = win({ [WIN_DIR + '\\runtime\\node.exe']: { size: 93915464 }, [WIN_DIR + '\\daemon.mjs']: { size: 1 } });
  assert.equal(r.kind, 'runtime');
  assert.equal(writes[WIN_DIR + '\\runtime\\VERIFIED'], '93915464 ' + SHA_WIN + '\n');
});

test('Windows: damaged runtime never falls back even with a system node installed', () => {
  const { r } = win({
    [WIN_DIR + '\\runtime\\node.exe']: { size: 0 }, [WIN_DIR + '\\daemon.mjs']: { size: 1 },
    [WIN_DIR + '\\runtime\\VERIFIED']: { content: '93915464 ' + SHA_WIN },
    'C:\\Program Files\\nodejs\\node.exe': { size: 1 },
  });
  assert.equal(r.error, 'runtime-damaged');
});

test('Windows probe order: ProgramFiles, then LOCALAPPDATA, then node on PATH', () => {
  const PF = 'C:\\Program Files\\nodejs\\node.exe';
  const LA = 'C:\\Users\\A\\AppData\\Local\\Programs\\nodejs\\node.exe';
  const PA = 'C:\\tools\\node.exe';
  const files = { [PF]: { size: 1 }, [LA]: { size: 1 }, [PA]: { size: 1 }, [WIN_DIR + '\\index.js']: { size: 1 } };
  const env = { programfiles: 'C:\\Program Files', LocalAppData: 'C:\\Users\\A\\AppData\\Local', PATH: 'C:\\Windows;C:\\tools' };
  assert.equal(win(files, { env }).r.bin, PF);
  delete files[PF];
  assert.equal(win(files, { env }).r.bin, LA);
  delete files[LA];
  const r = win(files, { env }).r;
  assert.equal(r.bin, PA);
  assert.equal(r.kind, 'node');
  assert.deepEqual(r.args, ['index.js']);
  assert.equal(r.cwd, WIN_DIR);
});

test('Windows: no runtime and no node anywhere: runtime-missing', () => {
  const { r } = win({ [WIN_DIR + '\\index.js']: { size: 1 } });
  assert.equal(r.error, 'runtime-missing');
});

test('normalizeWinPath: slashes to backslashes, trailing separators dropped, drive root kept', () => {
  assert.equal(L.normalizeWinPath('C:/Users/a b/ext/'), 'C:\\Users\\a b\\ext');
  assert.equal(L.normalizeWinPath('C:\\x\\\\'), 'C:\\x');
  assert.equal(L.normalizeWinPath('C:/'), 'C:\\');
  assert.equal(L.normalizeWinPath('\\\\server/share/x'), '\\\\server\\share\\x');
});

// ── cleanDaemonEnv ──

test('cleanDaemonEnv removes the Node knobs, keeps the rest, stashes the CA bundle (D7)', () => {
  const env = { NODE_OPTIONS: '--require /evil.js', NODE_PATH: '/x', NODE_EXTRA_CA_CERTS: '/corp.pem', HOME: '/Users/x', USER: 'x', PATH: '/usr/bin' };
  const out = plain(L.cleanDaemonEnv(env, 'darwin'));
  assert.deepEqual(out, { HOME: '/Users/x', USER: 'x', PATH: '/usr/bin', GAFFER_CLAUDE_EXTRA_CA_CERTS: '/corp.pem' });
  assert.equal(env.NODE_OPTIONS, '--require /evil.js', 'input is not mutated');
});

test('cleanDaemonEnv: no CA bundle, no stash key', () => {
  const out = plain(L.cleanDaemonEnv({ HOME: '/h' }, 'darwin'));
  assert.deepEqual(out, { HOME: '/h' });
});

test('cleanDaemonEnv on win32 is case-insensitive (node_options removed)', () => {
  const out = plain(L.cleanDaemonEnv({ node_options: '-r x', Node_Path: 'y', node_extra_ca_certs: 'C:\\ca.pem', Path: 'C:\\Windows', APPDATA: 'a', USERPROFILE: 'u', USERNAME: 'n' }, 'win32'));
  assert.deepEqual(out, { Path: 'C:\\Windows', APPDATA: 'a', USERPROFILE: 'u', USERNAME: 'n', GAFFER_CLAUDE_EXTRA_CA_CERTS: 'C:\\ca.pem' });
});

test('cleanDaemonEnv on POSIX is case-sensitive (a lower-case name is a different variable)', () => {
  const out = plain(L.cleanDaemonEnv({ node_options: 'keep', NODE_OPTIONS: 'drop' }, 'darwin'));
  assert.deepEqual(out, { node_options: 'keep' });
});

// ── notices ──

test('launchNotice: Failure-modes texts, no em or en dashes', () => {
  assert.equal(L.launchNotice('runtime-damaged'), "Gaffer's runtime is damaged. Open Settings and click Repair, or reinstall.");
  assert.equal(L.launchNotice('runtime-missing'), "Gaffer's runtime is missing. Open Settings and click Repair, or reinstall.");
  assert.match(L.launchNotice('launch-failed'), /^Gaffer could not start its daemon\./);
  for (const c of ['runtime-damaged', 'runtime-missing', 'launch-failed', 'other']) assert.ok(!/[\u2013\u2014]/.test(L.launchNotice(c)));
});

// ── main.js / index.html wiring (text-level, main.js has no unit harness) ──

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('index.html loads daemon-launch.js before main.js', () => {
  const html = read('../../index.html');
  const tag = html.indexOf('<script src="daemon-launch.js"></script>');
  const mainTag = html.indexOf('<script src="main.js"></script>');
  assert.ok(tag !== -1, 'no <script src="daemon-launch.js"> tag');
  assert.ok(tag < mainTag, 'daemon-launch.js must load before main.js');
});

test('main.js launches through GafferLaunch with the spec spawn shape', () => {
  const main = read('../../main.js');
  for (const needed of ['window.GafferLaunch', 'Launch.resolveDaemonLaunch(', 'Launch.cleanDaemonEnv(',
    'Launch.launchNotice(', 'function launchDaemon(', 'detached: true', 'windowsHide: true',
    "stdio: ['ignore', fd, fd]", 'runtime-pins.json']) {
    assert.ok(main.includes(needed), 'main.js is missing ' + needed);
  }
  assert.ok(!/STRICT/.test(main), 'the PoC STRICT switch must not ship');
  const start = main.slice(main.indexOf('function startDaemon()'));
  assert.ok(start.indexOf("setStatus('starting'") < start.indexOf('spawnViaNode()'), 'starting status must show before the first-run hash');
  const launch = main.slice(main.indexOf('function launchDaemon('), main.indexOf('function showLaunchError('));
  assert.ok(/finally\s*\{[^}]*closeSync\(fd\)/.test(launch), 'log fd closed in finally');
  assert.ok(main.includes("showLaunchError('launch-failed')"), 'unexpected exceptions show a notice');
});

// ── Gatekeeper kill (Failure modes: "Gatekeeper kills the runtime (exit 137)") ──

test('gatekeeperKilled: SIGKILL or exit 137 of the bundled runtime soon after launch on macOS', () => {
  assert.equal(typeof L.gatekeeperKilled, 'function');
  assert.equal(L.gatekeeperKilled({ platform: 'darwin', kind: 'runtime', code: null, signal: 'SIGKILL', elapsedMs: 300 }), true);
  assert.equal(L.gatekeeperKilled({ platform: 'darwin', kind: 'runtime', code: 137, signal: null, elapsedMs: 1200 }), true);
  assert.equal(L.gatekeeperKilled({ platform: 'darwin', kind: 'runtime', code: null, signal: 'SIGKILL', elapsedMs: L.GATEKEEPER_WINDOW_MS }), true);
});

test('gatekeeperKilled: every other exit keeps today\'s behaviour', () => {
  const base = { platform: 'darwin', kind: 'runtime', code: null, signal: 'SIGKILL', elapsedMs: 300 };
  const no = (o) => assert.equal(L.gatekeeperKilled(Object.assign({}, base, o)), false, JSON.stringify(o));
  no({ elapsedMs: L.GATEKEEPER_WINDOW_MS + 1 });          // late: a user or OOM kill, not Gatekeeper
  no({ platform: 'win32' });
  no({ platform: 'linux' });
  no({ kind: 'node' });                                     // a system node is not Gaffer's runtime
  no({ signal: null, code: 0 });                            // port in use, already running
  no({ signal: null, code: 1 });
  no({ signal: 'SIGTERM' });
  no({ signal: null, code: 137, elapsedMs: NaN });
  assert.equal(L.gatekeeperKilled(null), false);
});

test('launchNotice runtime-blocked: the Failure-modes text, no em or en dashes', () => {
  assert.equal(L.launchNotice('runtime-blocked'), "macOS blocked Gaffer's runtime. Open Settings and click Repair, or reinstall Gaffer.");
  assert.ok(!/[\u2013\u2014]/.test(L.launchNotice('runtime-blocked')));
});

test('main.js watches the spawned runtime for a Gatekeeper kill without holding it', () => {
  const main = read('../../main.js');
  const launch = main.slice(main.indexOf('function launchDaemon('), main.indexOf('function showLaunchError('));
  assert.ok(/child\.on\('exit'/.test(launch), 'an exit listener on the ChildProcess');
  assert.ok(launch.includes('Launch.gatekeeperKilled('), 'the pure verdict decides');
  assert.ok(launch.includes('child.unref()'), 'the daemon still outlives the panel');
  assert.ok(launch.includes("showLaunchError('runtime-blocked')"), 'the notice is shown');
  assert.ok(/appendDaemonLog\(fs, \[[^\]]*runtime-blocked/.test(launch), 'a log line is written');
});

// ── whole-branch review fixes ──

test('launchNotice launch-failed: names the Repair button, no em or en dashes', () => {
  assert.equal(L.launchNotice('launch-failed'), 'Gaffer could not start its daemon. Open Settings and click Repair, or reinstall.');
});

test('spawnFailureCode: an exec failure of the bundled runtime names the runtime', () => {
  assert.equal(typeof L.spawnFailureCode, 'function');
  for (const code of ['EBADARCH', 'ENOEXEC', 'EACCES']) {
    assert.equal(L.spawnFailureCode({ code }, 'runtime'), 'runtime-damaged', code);
  }
  // libuv has no name for these: Node throws code "Unknown system error -N".
  assert.equal(L.spawnFailureCode({ code: 'Unknown system error -8', errno: -8 }, 'runtime'), 'runtime-damaged');
  assert.equal(L.spawnFailureCode({ code: 'Unknown system error -86', errno: -86 }, 'runtime'), 'runtime-damaged');
});

test('spawnFailureCode: anything else, or a system node, is launch-failed', () => {
  assert.equal(L.spawnFailureCode({ code: 'ENOENT' }, 'runtime'), 'launch-failed');
  assert.equal(L.spawnFailureCode({ code: 'EBADARCH' }, 'node'), 'launch-failed');
  assert.equal(L.spawnFailureCode({ code: 'EACCES' }, 'node'), 'launch-failed');
  assert.equal(L.spawnFailureCode(new Error('x'), 'runtime'), 'launch-failed');
  assert.equal(L.spawnFailureCode(null, 'runtime'), 'launch-failed');
});

test('gatekeeperKilled: a kill the panel made itself is not Gatekeeper', () => {
  assert.equal(L.gatekeeperKilled({ platform: 'darwin', kind: 'runtime', code: null, signal: 'SIGKILL', elapsedMs: 300, panelKilled: true }), false);
  assert.equal(L.gatekeeperKilled({ platform: 'darwin', kind: 'runtime', code: 137, signal: null, elapsedMs: 300, panelKilled: false }), true);
});

test('swap window: runtime missing next to runtime.old is a retry, never a system node', () => {
  const { r } = mac({ [MAC_DIR + '/runtime.old/node']: { size: 1 }, '/usr/local/bin/node': { size: 1 }, [MAC_BUNDLE]: { size: 1 } });
  assert.equal(r.retry, 'runtime-swapping');
  assert.equal(r.error, undefined);
  assert.equal(r.bin, undefined);
  assert.ok(r.notes.some((n) => /runtime\.old/.test(n)), r.notes.join('\n'));
});

test('swap window: runtime missing next to runtime.new is a retry too (Windows as well)', () => {
  assert.equal(mac({ [MAC_DIR + '/runtime.new/node']: { size: 1 }, '/usr/local/bin/node': { size: 1 }, [MAC_BUNDLE]: { size: 1 } }).r.retry, 'runtime-swapping');
  const { r } = win({ [WIN_DIR + '\\runtime.old\\node.exe']: { size: 1 }, 'C:\\Program Files\\nodejs\\node.exe': { size: 1 } });
  assert.equal(r.retry, 'runtime-swapping');
});

test('swap window: once the wait has expired the old probe applies', () => {
  const { r } = mac({ [MAC_DIR + '/runtime.old/node']: { size: 1 }, '/usr/local/bin/node': { size: 1 }, [MAC_BUNDLE]: { size: 1 } },
    { swapWaitExpired: true });
  assert.equal(r.retry, undefined);
  assert.equal(r.kind, 'node');
  assert.equal(r.bin, '/usr/local/bin/node');
});

test('swap window: a dev install never waits', () => {
  const { r } = mac({ [MAC_DIR + '/runtime.old/node']: { size: 1 }, '/opt/homebrew/bin/node': { size: 1 }, [MAC_INDEX]: { size: 1 } },
    { detectDev: () => true });
  assert.equal(r.retry, undefined);
  assert.equal(r.kind, 'node');
});

test('main.js: a spawn that fails at exec shows a repairable notice and never claims started', () => {
  const main = read('../../main.js');
  const launch = main.slice(main.indexOf('function launchDaemon('), main.indexOf('function showLaunchError('));
  assert.ok(launch.includes('Launch.spawnFailureCode('), 'the error handler maps the errno');
  assert.ok(/function spawnFailed\(e\) \{[^}]*showLaunchError\(code\)/.test(launch), 'a failed spawn shows a notice');
  assert.ok(/child\.on\('error'[\s\S]*?spawnFailed\(e\)/.test(launch), 'the error handler reports it');
  assert.ok(/appendDaemonLog\(fs, \['daemon not launched: err:'/.test(launch), 'the error handler logs the failure');
  const spawn = main.slice(main.indexOf('function spawnViaNode('), main.indexOf('function spawnViaExtendScript('));
  assert.ok(/!child \|\| !child\.pid/.test(spawn), 'a spawn without a pid is not started');
  assert.ok(/cp\.spawn\([\s\S]*?\} catch \(e\) \{[^}]*spawnFailed\(e\);\s*return null;/.test(launch), 'a synchronous spawn throw (ENOEXEC, EBADARCH) is reported too');
  assert.ok(spawn.includes('launch.retry'), 'the swap-window retry is handled');
  assert.ok(spawn.includes('swapWaitExpired'), 'the retry is bounded');
});

test('main.js: a panel-made kill suppresses the Gatekeeper notice', () => {
  const main = read('../../main.js');
  const launch = main.slice(main.indexOf('function launchDaemon('), main.indexOf('function showLaunchError('));
  assert.ok(launch.includes('panelKilled:'), 'gatekeeperKilled is told about panel kills');
  const stop = main.slice(main.indexOf('function forceStopDaemonPort('));
  assert.ok(/daemonKilledByPanelAt = Date\.now\(\)/.test(stop.slice(0, 600)), 'forceStopDaemonPort records its kill');
});

// ── dev checkout detection (reviewer B: Windows symlinked dev install) ──

function devFs(existing, realpaths) {
  return {
    existsSync: (p) => existing.includes(p),
    realpathSync: (p) => { if (realpaths[p]) return realpaths[p]; const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; },
  };
}

test('isDevCheckout on Windows: a symlinked extension resolves to the checkout, whose parent has .git', () => {
  assert.equal(typeof L.isDevCheckout, 'function');
  const ext = 'C:/Users/A/AppData/Roaming/Adobe/CEP/extensions/com.gaffer.panel';
  const fs = devFs(['D:\\src\\gaffer\\.git'], { 'C:\\Users\\A\\AppData\\Roaming\\Adobe\\CEP\\extensions\\com.gaffer.panel': 'D:\\src\\gaffer\\panel' });
  assert.equal(L.isDevCheckout(fs, ext, 'win32'), true);
});

test('isDevCheckout on Windows: a real (packaged) folder is not dev, and the lexical .. is never used', () => {
  const ext = 'C:\\Users\\A\\AppData\\Roaming\\Adobe\\CEP\\extensions\\com.gaffer.panel';
  // A packaged (real) folder: no .git next to it.
  assert.equal(L.isDevCheckout(devFs([], { [ext]: ext }), ext, 'win32'), false);
  // A .git next to the link (lexical ..) must not count: only the target's parent does.
  const fs = devFs(['C:\\Users\\A\\AppData\\Roaming\\Adobe\\CEP\\extensions\\.git'], { [ext]: 'D:\\pkg\\gaffer\\panel' });
  assert.equal(L.isDevCheckout(fs, ext, 'win32'), false);
  assert.equal(L.isDevCheckout(devFs([], {}), ext, 'win32'), false, 'realpath failing is not dev');
  assert.equal(L.isDevCheckout({ existsSync: () => true }, ext, 'win32'), false, 'no realpathSync is not dev');
});

test('isDevCheckout on macOS keeps the kernel-resolved <ext>/../.git test', () => {
  const ext = '/Users/x/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel';
  assert.equal(L.isDevCheckout(devFs([ext + '/../.git'], {}), ext, 'darwin'), true);
  assert.equal(L.isDevCheckout(devFs([], {}), ext, 'darwin'), false);
});

test('main.js decides dev through GafferLaunch.isDevCheckout on every platform', () => {
  const main = read('../../main.js');
  const fn = main.slice(main.indexOf('function isDevCheckoutSync('), main.indexOf('function readRuntimePins('));
  assert.ok(fn.includes('Launch.isDevCheckout(fs, extPath, process.platform)'), fn);
  assert.ok(!fn.includes("=== 'win32') return false"), 'Windows is no longer never-dev');
});
