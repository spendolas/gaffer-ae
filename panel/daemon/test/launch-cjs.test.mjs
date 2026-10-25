// Tests for panel/daemon/launch.cjs (spec section 5), the spawner start.ps1
// runs as `& $node launch.cjs <kind> <entry>`, and static checks for
// start.ps1 itself (no Windows PowerShell here; the live run is on the VM).
//
// launch.cjs runs for real with this node: it must spawn the entry detached
// with the log (appended) as stdout/stderr, a cleaned env, print
// pid:<N> runtime|node, and exit without the daemon holding the caller's
// pipe (a caller that reads stdout to EOF returns at once). The fake daemon
// writes a marker and, with FAKE_STAY=1, stays up on an ephemeral loopback
// port; nothing binds 9823/9824 and the log is a sandbox file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync, realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH = join(HERE, '..', 'launch.cjs');
const START_PS1 = join(HERE, '..', 'start.ps1');

const FAKE_DAEMON = `
import('node:fs').then(async (fs) => {
  const path = await import('node:path');
  console.log('fake daemon stdout line');
  fs.writeFileSync(path.join(process.cwd(), 'marker-' + process.pid + '.json'), JSON.stringify({
    pid: process.pid, argv: process.argv, cwd: process.cwd(), env: process.env, execPath: process.execPath,
  }));
  fs.writeFileSync(path.join(process.cwd(), 'marker.json'), String(process.pid));
  if (process.env.FAKE_STAY === '1') {
    const net = await import('node:net');
    const srv = net.createServer().listen(0, '127.0.0.1');
    setTimeout(() => { srv.close(); process.exit(0); }, 20000);
  }
});
`;

const roots = [];
const spawned = [];
process.on('exit', () => {
  for (const pid of spawned) { try { process.kill(pid); } catch { /* gone */ } }
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'gaffer launch cjs '));
  roots.push(root);
  const dir = join(root, 'Applicätion Support', 'com.gaffer.panel', 'daemon');
  mkdirSync(dir, { recursive: true });
  copyFileSync(LAUNCH, join(dir, 'launch.cjs'));
  writeFileSync(join(dir, 'daemon.mjs'), FAKE_DAEMON);
  writeFileSync(join(dir, 'index.js'), FAKE_DAEMON);
  return { root, dir, log: join(root, 'daemon log.txt') };
}

function run(sb, args, extraEnv = {}) {
  const env = { ...process.env, GAFFER_TEST: '1', GAFFER_DAEMON_LOG: sb.log, ...extraEnv };
  const t0 = Date.now();
  // spawnSync with pipes: returns only when stdout and stderr hit EOF, i.e.
  // when every holder of the write end (including a leaked daemon) closed it.
  const r = spawnSync(process.execPath, [join(sb.dir, 'launch.cjs'), ...args], {
    cwd: sb.root, env, encoding: 'utf8', timeout: 15000,
  });
  const m = /pid:(\d+)/.exec(r.stdout || '');
  if (m) spawned.push(Number(m[1]));
  return { ...r, ms: Date.now() - t0 };
}

async function marker(sb, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const p = join(sb.dir, 'marker.json');
    if (existsSync(p)) {
      const f = join(sb.dir, `marker-${readFileSync(p, 'utf8')}.json`);
      if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* partial */ } }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test('spawns daemon.mjs with this node, prints pid:<N> runtime, exits before the daemon', async () => {
  const sb = sandbox();
  const r = run(sb, ['runtime', 'daemon.mjs'], { FAKE_STAY: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^pid:\d+ runtime\r?\n?$/);
  assert.ok(r.ms < 5000, `caller reading stdout to EOF waited ${r.ms} ms`);
  const mk = await marker(sb);
  assert.ok(mk, 'fake daemon ran');
  const pid = Number(/pid:(\d+)/.exec(r.stdout)[1]);
  assert.equal(mk.pid, pid);
  assert.equal(mk.execPath, process.execPath, 'runs on the node that ran launch.cjs');
  assert.match(mk.argv[1], /daemon\.mjs$/);
  assert.equal(realpathSync(mk.cwd), realpathSync(sb.dir), 'cwd is the daemon dir, not the caller cwd');
  assert.doesNotThrow(() => process.kill(pid, 0), 'daemon still alive after the launcher exited');
  process.kill(pid);
});

test('kind node with index.js', async () => {
  const sb = sandbox();
  const r = run(sb, ['node', 'index.js']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^pid:\d+ node$/);
  assert.match((await marker(sb)).argv[1], /index\.js$/);
});

test('log is opened in append mode and receives the daemon output', async () => {
  const sb = sandbox();
  writeFileSync(sb.log, 'earlier line\n');
  run(sb, ['runtime', 'daemon.mjs']);
  assert.ok(await marker(sb));
  const end = Date.now() + 3000;
  while (Date.now() < end && !/fake daemon stdout line/.test(readFileSync(sb.log, 'utf8'))) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const log = readFileSync(sb.log, 'utf8');
  assert.match(log, /^earlier line\n/, 'not truncated');
  assert.match(log, /launching daemon via runtime/);
  assert.match(log, /fake daemon stdout line/);
});

test('hostile NODE_OPTIONS / NODE_PATH / NODE_EXTRA_CA_CERTS never reach the daemon', async () => {
  const sb = sandbox();
  const evil = join(sb.root, 'evil.cjs');
  writeFileSync(evil, `require('fs').writeFileSync(${JSON.stringify(join(sb.root, 'pwned-'))} + process.pid, 'x');`);
  const r = run(sb, ['runtime', 'daemon.mjs'], {
    NODE_OPTIONS: `--require ${JSON.stringify(evil)}`, // JSON-escaped: NODE_OPTIONS treats a backslash inside quotes as an escape (Windows paths)
    NODE_PATH: join(sb.root, 'evil modules'),
    NODE_EXTRA_CA_CERTS: '/corp/ca.pem',
    GAFFER_CLAUDE_EXTRA_CA_CERTS: '',
  });
  assert.equal(r.status, 0, r.stderr);
  const mk = await marker(sb);
  assert.equal(mk.env.NODE_OPTIONS, undefined);
  assert.equal(mk.env.NODE_PATH, undefined);
  assert.equal(mk.env.NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(existsSync(join(sb.root, 'pwned-' + mk.pid)), false, 'payload never ran in the daemon');
});

test('bad arguments: err line, nonzero exit, nothing spawned', async () => {
  const sb = sandbox();
  for (const args of [[], ['bogus', 'daemon.mjs'], ['runtime', '../evil.js'], ['node']]) {
    const r = run(sb, args);
    assert.notEqual(r.status, 0, JSON.stringify(args));
    assert.match(r.stdout.trim(), /^err:/);
  }
  assert.equal(await marker(sb, 400), null);
});

test('cleanEnv matches GafferLaunch.cleanDaemonEnv on win32 and POSIX', () => {
  const require = createRequire(import.meta.url);
  const { cleanEnv } = require(LAUNCH);
  const src = readFileSync(join(HERE, '..', '..', 'daemon-launch.js'), 'utf8');
  const box = { window: {} };
  vm.runInNewContext(src, box);
  const ref = box.window.GafferLaunch.cleanDaemonEnv;
  const plain = (o) => JSON.parse(JSON.stringify(o));
  const cases = [
    { PATH: 'x', node_options: '--require evil', Node_Path: '/m', NODE_EXTRA_CA_CERTS: '/ca.pem', USERPROFILE: 'u' },
    { PATH: 'x', NODE_OPTIONS: 'a', NODE_EXTRA_CA_CERTS: '/ca.pem', GAFFER_CLAUDE_EXTRA_CA_CERTS: '/mine' },
    { PATH: 'x', NODE_EXTRA_CA_CERTS: '' },
    { HOME: '/h', node_options: 'kept on posix' },
  ];
  for (const env of cases) {
    for (const plat of ['win32', 'darwin']) {
      assert.deepEqual(plain(cleanEnv(env, plat)), plain(ref(env, plat)), `${plat} ${JSON.stringify(env)}`);
    }
  }
});

test('launch.cjs source: detached, windowsHide, explicit stdio, plain CommonJS', () => {
  const src = readFileSync(LAUNCH, 'utf8');
  assert.match(src, /detached:\s*true/);
  assert.match(src, /windowsHide:\s*true/);
  assert.match(src, /stdio:\s*\[\s*'ignore',\s*fd,\s*fd\s*\]/);
  assert.match(src, /openSync\([^)]*'a'\)/);
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.match(src, /GAFFER_TEST === '1' && process\.env\.GAFFER_DAEMON_LOG/, 'log seam gated on GAFFER_TEST=1');
});

// ---- start.ps1, static (PowerShell 5.1 cannot run here) ----

const ps1Buf = readFileSync(START_PS1);
const ps1 = ps1Buf.toString('utf8').replace(/^﻿/, '');
const ps1Code = ps1.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

test('start.ps1: UTF-8 BOM and ASCII only', () => {
  assert.deepEqual([...ps1Buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
  const bad = [...ps1Buf.subarray(3)].findIndex((b) => b > 127);
  assert.equal(bad, -1, `non-ASCII byte at ${bad + 3}`);
});

test('start.ps1: runs launch.cjs, never Start-Process redirection, no SEA binary branch', () => {
  assert.doesNotMatch(ps1Code, /Start-Process/i);
  assert.doesNotMatch(ps1Code, /-Redirect/i);
  assert.doesNotMatch(ps1, /GAFFER_USE_BINARY/);
  assert.doesNotMatch(ps1Code, /gaffer-daemon\.exe/);
  assert.match(ps1Code, /&\s*\$\w+\s+\S*launch\.cjs/i);
});

test('start.ps1: mirrors resolveDaemonLaunch (paths, stamp, pins, codes)', () => {
  for (const s of [
    'runtime\\node.exe', 'daemon.mjs', 'index.js', 'VERIFIED', 'runtime-pins.json', 'win-x64',
    'binaryBytes', 'binarySha256', 'Get-FileHash', "'runtime-damaged'", "'runtime-missing'", "Write-Output ('err:' + $code)",
    'nodejs\\node.exe', 'Programs\\nodejs\\node.exe', "'runtime'", "'node'",
  ]) {
    assert.ok(ps1Code.includes(s), `start.ps1 mentions ${s}`);
  }
  // Order of the system-node candidates: ProgramFiles, then LOCALAPPDATA, then PATH.
  const pf = ps1Code.search(/ProgramFiles/);
  const la = ps1Code.search(/LOCALAPPDATA/);
  const path = ps1Code.search(/env:PATH/i);
  assert.ok(pf > -1 && la > pf && path > la, 'candidate order');
  // The launcher itself must not hand NODE_OPTIONS etc. to launch.cjs.
  for (const v of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS']) {
    assert.match(ps1Code, new RegExp(`Remove-Item[^\\n]*Env:${v}`), `clears ${v} before running node`);
  }
  assert.match(ps1Code, /GAFFER_CLAUDE_EXTRA_CA_CERTS/);
  // A damaged runtime never falls through to the system node: the runtime
  // branch only ever launches the runtime or stops.
  const branch = ps1Code.slice(ps1Code.indexOf('if (Test-Path -LiteralPath $bin)'), ps1Code.indexOf('} else {', ps1Code.indexOf('if (Test-Path -LiteralPath $bin)')));
  assert.match(branch, /Test-BundledRuntime/);
  assert.doesNotMatch(branch, /Find-SystemNode/);
  // Forward slashes from CSInterface become backslashes.
  assert.match(ps1Code, /-replace\s+'\/',\s*'\\'/);
  // Placeholder rule mirrors daemon-launch.js: only the exact literal skips
  // the hash and writes no stamp; any other non-sha256 pin is damaged.
  assert.match(ps1Code, /\$sha -ceq 'PENDING-FIRST-ACCEPTANCE-RUN'/);
  assert.match(ps1Code, /no stamp written/);
  assert.match(ps1Code, /'pinned sha256 for win-x64 is not a sha256 \(' \+ \$sha \+ '\)'/);
  assert.ok(!ps1Code.includes('unhashed'), 'no unhashed stamp');
  const ph = ps1Code.indexOf("-ceq 'PENDING-FIRST-ACCEPTANCE-RUN'");
  const phBlock = ps1Code.slice(ph, ps1Code.indexOf('}', ph));
  assert.match(phBlock, /return/, 'placeholder branch returns before the stamp write');
  // Caught cmdlet failures must be terminating.
  assert.match(ps1Code, /Get-Item -LiteralPath \$bin -ErrorAction Stop/);
  assert.match(ps1Code, /Get-FileHash -LiteralPath \$bin -Algorithm SHA256 -ErrorAction Stop/);
  assert.match(ps1Code, /ConvertFrom-Json -ErrorAction Stop/);
  // Stamp compared as a digit string, never an [int64] cast.
  assert.doesNotMatch(ps1Code, /\[int64\]\s*\$Matches/);
  assert.match(ps1Code, /\$stamped -cne \(\[string\] \$size\)/);
  // launch.cjs outcome checked: no pid line or a bad exit ends in err:launch-failed.
  assert.match(ps1Code, /\$global:LASTEXITCODE = \$null/);
  assert.match(ps1Code, /Write-Output 'err:launch-failed'/);
  // Handle inheritance cleared before running node (VM: the caller's pipes
  // otherwise reach the detached daemon and callSystem never sees EOF).
  const clear = ps1Code.indexOf('SetHandleInformation([IntPtr]$h, 1, 0)');
  assert.ok(clear > -1, 'clears HANDLE_FLAG_INHERIT on every handle');
  assert.match(ps1Code, /\[DllImport\("kernel32\.dll"\)\] public static extern bool SetHandleInformation/);
  assert.ok(clear < ps1Code.indexOf('& $node'), 'before & $node');
  // Notes are written while a daemon holds the log.
  const wn = ps1Code.slice(ps1Code.indexOf('function Write-Note'), ps1Code.indexOf('function Stop-Launch'));
  assert.match(wn, /\[IO\.FileShare\]::ReadWrite/);
  assert.match(wn, /\[IO\.FileMode\]::Append/);
  assert.doesNotMatch(wn, /AppendAllText/);
  assert.doesNotMatch(wn, /catch \{ \}\s*\n\}/, 'failure not silently swallowed');
  // Test seam gated.
  assert.match(ps1Code, /\$env:GAFFER_TEST -eq '1' -and \$env:GAFFER_DAEMON_LOG/);
  // Output uses Write-Output (stdout), never Write-Host / Write-Error for the contract line.
  assert.doesNotMatch(ps1Code, /Write-(Host|Error)[^\n]*err:/);
});

test('start.ps1: swap window mirrors resolveDaemonLaunch (err:runtime-updating, nothing started, bounded by swap-wait-expired)', () => {
  // The argument is read at script scope ($args inside a function would be the function's).
  assert.match(ps1Code, /^\$swapWaitExpired = \(\$args\.Count -gt 0 -and \[string\] \$args\[0\] -eq 'swap-wait-expired'\)$/m);
  const at = ps1Code.indexOf('if (-not $swapWaitExpired -and -not (Test-Path -LiteralPath $bin)) {');
  assert.ok(at > -1, 'swap-window block');
  const block = ps1Code.slice(at, ps1Code.indexOf('\n}\n', at) + 3);
  assert.ok(block.includes("Test-Path -LiteralPath (Join-Path $dir 'runtime.old')"), 'checks runtime.old');
  assert.ok(block.includes("Test-Path -LiteralPath (Join-Path $dir 'runtime.new')"), 'checks runtime.new');
  assert.match(block, /Stop-Launch 'runtime-updating' \('no runtime but '/, 'prints err:runtime-updating and exits 1 (Stop-Launch)');
  assert.doesNotMatch(block, /Find-SystemNode|launch\.cjs|& \$node/, 'starts nothing');
  // Before the runtime / system-node decision, after the functions it calls.
  assert.ok(at > ps1Code.indexOf('function Stop-Launch'), 'Stop-Launch defined first');
  assert.ok(at < ps1Code.indexOf('if (Test-Path -LiteralPath $bin) {'), 'before the system-node branch');
  assert.ok(at < ps1Code.indexOf('$node = Find-SystemNode'), 'before the probe');
  // Header contract lists the new line.
  assert.match(ps1, /\| err:runtime-updating \(not an error: retry shortly\)/);
});

test('start.ps1: PowerShell 5.1 syntax (no PowerShell 7 operators)', () => {
  const bad = [[/&&|\|\|/, 'pipeline chain operator'], [/\?\?/, 'null-coalescing'], [/\s\?\s[^\n]*\s:\s/, 'ternary'], [/\?\.|\?\[/, 'null-conditional']];
  for (const [re, what] of bad) {
    const hit = ps1Code.split('\n').find((l) => re.test(l.replace(/"[^"]*"|'[^']*'/g, '""')));
    assert.ok(!hit, what + ': ' + (hit || '').trim());
  }
});

test('start.ps1: parses under pwsh when it is installed', (t) => {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0) { t.skip('pwsh not installed; the Windows VM run is the parse check'); return; }
  const cmd = "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('" +
    START_PS1.replace(/'/g, "''") + "', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }";
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
