#!/usr/bin/env node
// Smoke test of a PACKAGED Gaffer daemon on the pinned Node runtime: the
// permanent form of the zero-dependency PoC runs R1 to R5 (spec section 10,
// proof rows P3/P8). Run by .github/workflows/release.yml (job "smoke") on
// macos-15, macos-15-intel and windows-latest, with the runtime itself:
//
//   <ext>/daemon/runtime/node scripts/smoke/run-smoke.mjs \
//     --ext <unpacked update archive> --platform <darwin-arm64|darwin-x64|win-x64> \
//     --out <results dir> --ws-port <n> --mcp-port <n> \
//     [--source-daemon <checkout>/panel/daemon] [--baseline scripts/smoke/parity-baseline.json] \
//     [--timeout-check] [--no-suite] [--no-auth]
//
// --no-auth skips the probe's auth_status message (local runs: it would run
// the developer's real `claude auth status`). CI has no claude, so it keeps it.
//
// The runtime must already be in <ext>/daemon/runtime (the workflow runs the
// packaged fetch-runtime script first). Checks, each a row in results.md:
//   R1 runtime: VERSION stamp, --version, arch, size and SHA-256 against
//      <ext>/daemon/runtime-pins.json, code signature (codesign + TeamIdentifier,
//      or Authenticode Valid + signer subject)
//   R3 package: no node_modules in the extension or any parent folder, the
//      index.js shim; `node` not resolvable on the stripped PATH; test ports
//      free; packaged daemon.mjs reaches listening with a stripped environment
//   R4 parity.mjs against the packaged daemon (and the 60 s timeout when
//      --timeout-check); with --source-daemon, the same probe against the
//      checkout's index.js on the same runtime, and the tools/list and runJSX
//      capture hashes must be equal; parity-baseline.json mismatches are a
//      warning (the tool surface may change on purpose)
//   R5 the daemon test suite from --source-daemon, run by the runtime with
//      the stripped environment (skipped with --no-suite)
// Exit 0 when no row is FAIL.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLACEHOLDER_PIN = 'PENDING-FIRST-ACCEPTANCE-RUN';

// ---------- pure helpers (scripts/smoke/run-smoke.test.mjs) ----------

export function parseArgs(argv) {
  const o = { timeoutCheck: false, suite: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error('missing value for ' + a); return argv[++i]; };
    if (a === '--ext') o.ext = next();
    else if (a === '--platform') o.platform = next();
    else if (a === '--out') o.out = next();
    else if (a === '--ws-port') o.wsPort = Number(next());
    else if (a === '--mcp-port') o.mcpPort = Number(next());
    else if (a === '--source-daemon') o.sourceDaemon = next();
    else if (a === '--baseline') o.baseline = next();
    else if (a === '--timeout-check') o.timeoutCheck = true;
    else if (a === '--no-suite') o.suite = false;
    else if (a === '--no-auth') o.noAuth = true;
    else throw new Error('unknown argument ' + a);
  }
  if (!o.ext || !o.out) throw new Error('--ext and --out are required');
  if (['darwin-arm64', 'darwin-x64', 'win-x64'].indexOf(o.platform) === -1) throw new Error('--platform must be darwin-arm64, darwin-x64 or win-x64');
  for (const k of ['wsPort', 'mcpPort']) {
    if (!Number.isInteger(o[k]) || o[k] < 1024 || o[k] > 65535) throw new Error('--ws-port and --mcp-port must be ports from 1024 to 65535');
    if (o[k] === 9823 || o[k] === 9824) throw new Error('refusing the default port ' + o[k] + ': it belongs to a live Gaffer daemon');
  }
  if (o.wsPort === o.mcpPort) throw new Error('--ws-port and --mcp-port must differ');
  if (o.suite && !o.sourceDaemon) throw new Error('the daemon suite needs --source-daemon (or pass --no-suite)');
  return o;
}

// A minimal environment with no Node anywhere on PATH. Only the variables a
// real launch keeps (spec section 4: HOME/USER on macOS; the Windows system
// set), plus the caller's extras (isolation paths, ports).
export function strippedEnv(platform, env, extra) {
  const out = {};
  if (platform === 'win-x64') {
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    out.PATH = [root + '\\System32', root, root + '\\System32\\Wbem', root + '\\System32\\WindowsPowerShell\\v1.0'].join(';');
    for (const k of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'ComSpec', 'PATHEXT', 'SystemDrive', 'USERNAME', 'ProgramData']) {
      const hit = Object.keys(env).find((n) => n.toLowerCase() === k.toLowerCase());
      if (hit && env[hit]) out[k] = env[hit];
    }
  } else {
    out.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    for (const k of ['HOME', 'USER', 'TMPDIR']) if (env[k]) out[k] = env[k];
  }
  return Object.assign(out, extra || {});
}

// The pin entry for a platform, and the checks a binary must pass against it.
export function checkBinaryAgainstPin(pins, platform, actual) {
  const p = pins && pins.node && pins.node.platforms && pins.node.platforms[platform];
  if (!p) return { ok: false, problems: ['no pin for ' + platform] };
  const problems = [];
  const notes = [];
  if (actual.size !== p.binaryBytes) problems.push('size ' + actual.size + ' != pinned ' + p.binaryBytes);
  if (p.binarySha256 === PLACEHOLDER_PIN) notes.push('binarySha256 is the placeholder, hash ' + actual.sha256 + ' not compared');
  else if (actual.sha256 !== p.binarySha256) problems.push('sha256 ' + actual.sha256 + ' != pinned ' + p.binarySha256);
  if (actual.version !== pins.node.version) problems.push('--version ' + JSON.stringify(actual.version) + ' != ' + pins.node.version);
  const wantArch = platform === 'darwin-arm64' ? 'arm64' : 'x64';
  if (actual.arch !== wantArch) problems.push('process.arch ' + actual.arch + ' != ' + wantArch);
  return { ok: problems.length === 0, problems, notes };
}

// `codesign -dv` writes its report to stderr: TeamIdentifier=XXXXXXXXXX.
export function teamIdFromCodesign(text) {
  const m = /^TeamIdentifier=(\S+)/m.exec(String(text || ''));
  return m ? m[1] : null;
}

// "# tests 324" style counters from a TAP report (node --test --test-reporter=tap).
export function parseTapCounts(text) {
  const get = (k) => { const m = new RegExp('^# ' + k + ' (\\d+)', 'm').exec(String(text || '')); return m ? Number(m[1]) : null; };
  return { tests: get('tests'), pass: get('pass'), fail: get('fail'), cancelled: get('cancelled'), skipped: get('skipped') };
}

// Packaged vs source vs baseline hashes. Equal packaged/source is the gate;
// a baseline difference is a warning only.
export function compareParity(packaged, source, baseline) {
  const fails = [], warns = [];
  const pick = (s) => ({ tools: s && s.tools_sha256 && s.tools_sha256.sha256, jsx: s && s.jsx_captured && s.jsx_captured.sha256, count: s && s.mcp_tools_list && s.mcp_tools_list.count,
    toolsBytes: s && s.tools_sha256 && s.tools_sha256.bytes, jsxBytes: s && s.jsx_captured && s.jsx_captured.length });
  const P = pick(packaged);
  if (source) {
    const S = pick(source);
    if (P.tools !== S.tools) fails.push('tools/list sha256 differs: packaged ' + P.tools + ', source ' + S.tools);
    if (P.jsx !== S.jsx) fails.push('runJSX capture sha256 differs: packaged ' + P.jsx + ', source ' + S.jsx);
    if (P.count !== S.count) fails.push('tool count differs: packaged ' + P.count + ', source ' + S.count);
  }
  if (baseline) {
    if (baseline.toolsSha256 && P.tools !== baseline.toolsSha256) warns.push('tools/list sha256 ' + P.tools + ' differs from parity-baseline.json ' + baseline.toolsSha256 + ' (fine if the tool surface changed on purpose; update the baseline)');
    if (baseline.jsxSha256 && P.jsx !== baseline.jsxSha256) warns.push('runJSX capture sha256 ' + P.jsx + ' differs from parity-baseline.json ' + baseline.jsxSha256 + ' (fine if safety.js changed on purpose; update the baseline)');
    if (baseline.toolCount && P.count !== baseline.toolCount) warns.push('tool count ' + P.count + ' differs from parity-baseline.json ' + baseline.toolCount);
    if (baseline.toolsBytes && P.toolsBytes !== baseline.toolsBytes) warns.push('tools/list size ' + P.toolsBytes + ' bytes differs from parity-baseline.json ' + baseline.toolsBytes);
    if (baseline.jsxBytes && P.jsxBytes !== baseline.jsxBytes) warns.push('runJSX capture size ' + P.jsxBytes + ' bytes differs from parity-baseline.json ' + baseline.jsxBytes);
  }
  return { fails, warns, hashes: P };
}

// Folders named node_modules in `dir`'s tree and in every ancestor of it
// (Node's resolver would walk up into those).
export function findNodeModules(dir, fsImpl) {
  const f = fsImpl || fs;
  const hits = [];
  const walk = (d) => {
    let entries;
    try { entries = f.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.name === 'node_modules') hits.push(p); else walk(p);
    }
  };
  walk(dir);
  let up = path.dirname(path.resolve(dir));
  for (;;) {
    const cand = path.join(up, 'node_modules');
    try { if (f.statSync(cand).isDirectory()) hits.push(cand); } catch (e) { /* absent */ }
    const parent = path.dirname(up);
    if (parent === up) break;
    up = parent;
  }
  return hits;
}

// Every non-loopback, non-link-local address from os.networkInterfaces().
// A daemon bound to 127.0.0.1 must refuse connections on all of them.
export function nonLoopbackAddresses(ifaces) {
  const out = [];
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      if (!a || a.internal) continue;
      if (a.family === 'IPv4' || a.family === 4) { if (!a.address.startsWith('127.')) out.push(a.address); }
      else if (a.family === 'IPv6' || a.family === 6) {
        if (a.address === '::1' || /^fe80:/i.test(a.address) || /%/.test(a.address)) continue; // loopback / link-local need a scope id
        out.push(a.address);
      }
    }
  }
  return out;
}

// Local addresses of LISTEN sockets from `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -Fn`
// ("n127.0.0.1:27831", "n[::1]:27831", "n*:27831").
export function listenAddrsFromLsof(text) {
  return String(text || '').split(/\r?\n/).filter((l) => l.startsWith('n')).map((l) => l.slice(1).trim()).filter(Boolean);
}

// The listener rule: every listening socket is on 127.0.0.1, and both test
// ports are among them.
export function listenersLoopbackOnly(addrs, ports) {
  const problems = [];
  for (const a of addrs) {
    const host = a.replace(/:(\d+)$/, '');
    if (host !== '127.0.0.1') problems.push('listener on ' + a);
  }
  for (const p of ports) if (!addrs.some((a) => a === '127.0.0.1:' + p)) problems.push('no 127.0.0.1:' + p + ' listener');
  return problems;
}

// ---------- runner ----------

function connectsVia(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

function samePath(a, b, win) {
  const norm = (p) => { let r = p; try { r = fs.realpathSync(p); } catch (e) { /* keep */ } return win ? r.toLowerCase() : r; };
  return !!a && !!b && norm(a) === norm(b);
}

function sha256File(p) {
  const h = createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)); }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
    s.setTimeout(2000, () => { s.destroy(); resolve(true); });
  });
}

async function waitListening(ports, child, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) return { ok: false, why: 'daemon exited with code ' + child.exitCode };
    let all = true;
    for (const p of ports) if (await portFree(p)) { all = false; break; }
    if (all) return { ok: true, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ok: false, why: 'not listening after ' + timeoutMs + ' ms' };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve('already exited');
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 10000);
    child.once('exit', (code, sig) => { clearTimeout(t); resolve('exited (' + (sig || code) + ')'); });
    try { child.kill('SIGTERM'); } catch (e) { clearTimeout(t); resolve('kill failed: ' + e.message); }
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  fs.mkdirSync(o.out, { recursive: true });
  const isWin = o.platform === 'win-x64';
  const ext = path.resolve(o.ext);
  const daemonDir = path.join(ext, 'daemon');
  const runtime = path.join(daemonDir, 'runtime', isWin ? 'node.exe' : 'node');
  const results = [];
  const row = (check, item, result, evidence) => {
    results.push({ check, item, result, evidence: String(evidence == null ? '' : evidence) });
    console.log('[' + result + '] ' + check + ' ' + item + (evidence ? ': ' + String(evidence).slice(0, 400) : ''));
  };
  const PF = (ok) => (ok ? 'PASS' : 'FAIL');
  const state = path.join(o.out, 'state');
  fs.mkdirSync(state, { recursive: true });
  const isolation = {
    GAFFER_TELEMETRY_URL: 'http://127.0.0.1:9/',
    GAFFER_CONFIG_PATH: path.join(state, 'config.json'),
    GAFFER_BUFFER_PATH: path.join(state, 'buffer.json'),
    GAFFER_MODEL_CACHE_PATH: path.join(state, 'model-cache.json'),
  };
  const daemonEnv = strippedEnv(o.platform, process.env, Object.assign({}, isolation, { GAFFER_TEST: '1', GAFFER_WS_PORT: String(o.wsPort), GAFFER_MCP_PORT: String(o.mcpPort) }));
  const run = (cmd, args, opts) => spawnSync(cmd, args, Object.assign({ encoding: 'utf8', windowsHide: true, timeout: 120000 }, opts || {}));

  // ---- R1 runtime
  if (!fs.existsSync(runtime)) { row('R1', 'runtime binary present', 'FAIL', runtime); return finish(o, results); }
  const pins = JSON.parse(fs.readFileSync(path.join(daemonDir, 'runtime-pins.json'), 'utf8'));
  const stamp = (() => { try { return fs.readFileSync(path.join(daemonDir, 'runtime', 'VERSION'), 'utf8').trim(); } catch (e) { return null; } })();
  row('R1', 'runtime/VERSION stamp', PF(stamp === pins.node.version + ' ' + o.platform), stamp);
  const ver = run(runtime, ['-p', 'process.version + " " + process.arch'], { env: strippedEnv(o.platform, process.env) });
  const [rv, ra] = String(ver.stdout || '').trim().split(' ');
  const actual = { size: fs.statSync(runtime).size, sha256: sha256File(runtime), version: rv, arch: ra };
  const pinCheck = checkBinaryAgainstPin(pins, o.platform, actual);
  row('R1', 'binary vs runtime-pins.json (size, sha256, --version, arch)', PF(pinCheck.ok), JSON.stringify(actual) + ' ' + pinCheck.problems.concat(pinCheck.notes).join('; '));
  if (o.platform.startsWith('darwin')) {
    const v = run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', runtime]);
    row('R1', 'codesign --verify --strict', PF(v.status === 0), 'exit ' + v.status + ' ' + (v.stderr || '').trim());
    const d = run('/usr/bin/codesign', ['-dv', '--verbose=2', runtime]);
    fs.writeFileSync(path.join(o.out, 'codesign-dv.txt'), (d.stderr || '') + (d.stdout || ''));
    const team = teamIdFromCodesign(d.stderr);
    row('R1', 'codesign TeamIdentifier', PF(team === pins.node.signing.darwinTeamId), team);
  } else {
    const ps = '$s = Get-AuthenticodeSignature -LiteralPath $env:GAFFER_SMOKE_BIN; ' +
      '[Console]::Out.WriteLine([string]$s.Status); [Console]::Out.WriteLine([string]$s.SignerCertificate.Subject)';
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const s = run(path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ps],
      { env: Object.assign({}, process.env, { GAFFER_SMOKE_BIN: runtime }) });
    const [status, subject] = String(s.stdout || '').split(/\r?\n/);
    fs.writeFileSync(path.join(o.out, 'authenticode.txt'), (s.stdout || '') + (s.stderr || ''));
    row('R1', 'Authenticode Valid + signer', PF(status === 'Valid' && String(subject).indexOf(pins.node.signing.windowsSigner) !== -1), status + ' / ' + subject);
  }

  // ---- R3 package and stripped start
  const nm = findNodeModules(ext);
  row('R3', 'no node_modules in the extension or its parents', PF(nm.length === 0), nm.join('; ') || 'none');
  const shim = (() => { try { return fs.readFileSync(path.join(daemonDir, 'index.js'), 'utf8').trim(); } catch (e) { return null; } })();
  row('R3', 'daemon/index.js is the shim, daemon.mjs present', PF(shim === "import './daemon.mjs';" && fs.existsSync(path.join(daemonDir, 'daemon.mjs'))), shim);
  const which = isWin
    ? run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), ['node'], { env: daemonEnv })
    : run('/bin/sh', ['-c', 'command -v node'], { env: daemonEnv });
  row('R3', '`node` not resolvable on the stripped PATH', PF(which.status !== 0), 'exit ' + which.status + ' ' + String(which.stdout || '').trim() + ' PATH=' + daemonEnv.PATH);
  const free = (await portFree(o.wsPort)) && (await portFree(o.mcpPort));
  row('R3', 'test ports free before start', PF(free), o.wsPort + '/' + o.mcpPort);
  if (!free) return finish(o, results);

  const startDaemon = async (cwd, entry, label) => {
    const logPath = path.join(o.out, label + '-daemon.log');
    const fd = fs.openSync(logPath, 'w');
    const child = spawn(runtime, [entry], { cwd, env: daemonEnv, stdio: ['ignore', fd, fd], windowsHide: true });
    fs.closeSync(fd);
    const w = await waitListening([o.wsPort, o.mcpPort], child, 30000);
    return { child, w, logPath };
  };
  const probe = (label, extraArgs) => {
    const prefix = path.join(o.out, label);
    const r = run(runtime, [path.join(HERE, 'parity.mjs'), '--ws-port', String(o.wsPort), '--mcp-port', String(o.mcpPort), '--out', prefix].concat(o.noAuth ? ['--no-auth'] : [], extraArgs),
      { env: strippedEnv(o.platform, process.env), timeout: 300000 });
    fs.writeFileSync(prefix + '.out', (r.stdout || '') + (r.stderr || ''));
    let summary = null;
    try { summary = JSON.parse(fs.readFileSync(prefix + '-summary.json', 'utf8')); } catch (e) { /* fatal */ }
    return { status: r.status, summary, tail: String(r.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | ') + ' ' + String(r.stderr || '').trim().slice(0, 300) };
  };

  const pk = await startDaemon(daemonDir, 'daemon.mjs', 'packaged');
  row('R3', 'packaged daemon.mjs reaches listening (stripped env, runtime)', PF(pk.w.ok), (pk.w.ok ? pk.w.ms + ' ms' : pk.w.why) + '; log: ' + fs.readFileSync(pk.logPath, 'utf8').slice(0, 300));
  if (pk.w.ok) {
    const pid = pk.child.pid;
    // Executable of the listening process (spawned by absolute path, but a
    // wrapper or a re-exec would show here).
    let exe = null;
    if (isWin) {
      const q = run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.WriteLine((Get-Process -Id ' + pid + ').Path)']);
      exe = String(q.stdout || '').trim();
    } else {
      const q = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']);
      const first = String(q.stdout || '').split(/\r?\n/).find((l) => l.startsWith('n'));
      exe = first ? first.slice(1) : null;
    }
    row('R3', 'process executable is the runtime node', PF(samePath(exe, runtime, isWin)), 'pid ' + pid + ': ' + exe);
    // Listener rule (Global Constraint: every listener binds 127.0.0.1), two ways.
    let addrs = [];
    if (isWin) {
      const q = run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetTCPConnection -State Listen -OwningProcess ' + pid + ' | ForEach-Object { [Console]::Out.WriteLine($_.LocalAddress + ":" + $_.LocalPort) }']);
      addrs = String(q.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } else {
      addrs = listenAddrsFromLsof(run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']).stdout);
    }
    const lp = listenersLoopbackOnly(addrs, [o.wsPort, o.mcpPort]);
    row('R3', 'listening sockets loopback only (' + (isWin ? 'Get-NetTCPConnection' : 'lsof') + ')', PF(lp.length === 0), addrs.join(' ') + (lp.length ? '; ' + lp.join('; ') : ''));
    const ext4 = nonLoopbackAddresses(os.networkInterfaces());
    const reached = [];
    for (const host of ext4) for (const p of [o.wsPort, o.mcpPort]) if (await connectsVia(host, p)) reached.push(host + ':' + p);
    row('R3', 'test ports refuse connections on non-loopback addresses', PF(reached.length === 0),
      ext4.length ? 'tried ' + ext4.join(', ') + (reached.length ? '; REACHABLE: ' + reached.join(', ') : '; all refused') : 'no non-loopback address on this machine, nothing to try');
  }
  let packaged = null;
  if (pk.w.ok) {
    const expectVersion = JSON.parse(fs.readFileSync(path.join(ext, 'version.json'), 'utf8')).version;
    const pr = probe('packaged', ['--expect-version', expectVersion].concat(o.timeoutCheck ? ['--timeout-check'] : []));
    packaged = pr.summary && pr.summary.steps;
    row('R4', 'parity.mjs vs packaged daemon (handshake, initialize, tools/list, runJSX, undo-group strip' + (o.timeoutCheck ? ', 60 s timeout' : '') + ')',
      PF(pr.status === 0), pr.tail + (pr.summary && pr.summary.failures && pr.summary.failures.length ? ' FAILURES: ' + pr.summary.failures.join('; ') : ''));
  }
  row('R3', 'packaged daemon stop', 'INFO', await stopChild(pk.child));

  let source = null;
  const freeAgain = (await portFree(o.wsPort)) && (await portFree(o.mcpPort));
  if (o.sourceDaemon && packaged && !freeAgain) row('R4', 'test ports free again before the source daemon', 'FAIL', o.wsPort + '/' + o.mcpPort);
  if (o.sourceDaemon && packaged && freeAgain) {
    const sd = await startDaemon(path.resolve(o.sourceDaemon), 'index.js', 'source');
    row('R4', 'source index.js reaches listening (same runtime)', PF(sd.w.ok), sd.w.ok ? sd.w.ms + ' ms' : sd.w.why + '; log: ' + fs.readFileSync(sd.logPath, 'utf8').slice(0, 300));
    if (sd.w.ok) {
      const sr = probe('source', []);
      source = sr.summary && sr.summary.steps;
      row('R4', 'parity.mjs vs source daemon', PF(sr.status === 0), sr.tail);
    }
    row('R4', 'source daemon stop', 'INFO', await stopChild(sd.child));
  }
  if (packaged) {
    let baseline = null;
    if (o.baseline) baseline = JSON.parse(fs.readFileSync(o.baseline, 'utf8'));
    const cmp = compareParity(packaged, source, baseline);
    if (o.sourceDaemon) row('R4', 'packaged hashes equal source hashes', PF(source !== null && cmp.fails.length === 0), cmp.fails.join('; ') || JSON.stringify(cmp.hashes));
    row('R4', 'hashes vs parity-baseline.json (P8)', cmp.warns.length ? 'WARN' : 'PASS', cmp.warns.join('; ') || JSON.stringify(cmp.hashes));
    cmp.warns.forEach((w) => console.log('::warning::' + w));
  }

  // ---- R5 daemon suite on the runtime, stripped env
  if (o.suite) {
    const t0 = Date.now();
    const suiteEnv = strippedEnv(o.platform, process.env, isolation);
    const r = run(runtime, ['--test', '--test-reporter=tap'], { cwd: path.resolve(o.sourceDaemon), env: suiteEnv, timeout: 1200000, maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(path.join(o.out, 'unit-tests.log'), (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || ''));
    const c = parseTapCounts(r.stdout);
    const fails = String(r.stdout || '').split(/\r?\n/).filter((l) => /^\s*not ok /.test(l)).slice(0, 20).join('; ');
    row('R5', 'daemon test suite (node --test) on the runtime', PF(r.status === 0 && c.fail === 0 && c.tests > 0),
      'exit ' + r.status + ' in ' + (Date.now() - t0) + ' ms; tests ' + c.tests + ' pass ' + c.pass + ' fail ' + c.fail + ' skipped ' + c.skipped + (fails ? '; ' + fails : ''));
  }
  return finish(o, results);
}

function finish(o, results) {
  const lines = ['## Smoke ' + o.platform + ' (' + process.version + ', ' + process.arch + ')', '', '| Check | Item | Result | Evidence |', '|---|---|---|---|'];
  for (const r of results) lines.push('| ' + r.check + ' | ' + r.item + ' | ' + r.result + ' | ' + r.evidence.replace(/\|/g, '/').replace(/\r?\n/g, ' ').slice(0, 600) + ' |');
  fs.writeFileSync(path.join(o.out, 'results.md'), lines.join('\n') + '\n\n');
  const failed = results.filter((r) => r.result === 'FAIL');
  console.log(failed.length ? 'smoke: ' + failed.length + ' FAIL row(s)' : 'smoke: all rows passed');
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => { console.error('smoke: ' + (e && e.stack || e)); process.exitCode = 1; });
}
