// Run from the repo root: node --test scripts/smoke/smoke.test.mjs
// Pure parts of the smoke harness (parity.mjs, run-smoke.mjs). The harness
// itself runs against a real daemon in .github/workflows/release.yml (smoke).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parityArgs, evaluate, PROBE_CODE, PROBE_UNDO_LABEL } from './parity.mjs';
import {
  parseArgs as smokeArgs, strippedEnv, checkBinaryAgainstPin, teamIdFromCodesign,
  parseTapCounts, compareParity, findNodeModules, PLACEHOLDER_PIN,
  nonLoopbackAddresses, listenAddrsFromLsof, listenersLoopbackOnly,
} from './run-smoke.mjs';

const baseline = JSON.parse(readFileSync(fileURLToPath(new URL('./parity-baseline.json', import.meta.url)), 'utf8'));

function goodSteps() {
  return {
    ws_no_origin: { status: 101, upgraded: true },
    ws_evil_origin: { status: 403 },
    ws_foreign_host: { status: 403 },
    auth_status_reply: { type: 'auth_status' },
    share_usage_stats_reply: { type: 'share_usage_stats', enabled: false },
    mcp_evil_origin: { status: 403 },
    mcp_foreign_host: { status: 403 },
    mcp_initialize: { status: 200, sessionId: true, serverInfo: { name: 'gaffer', version: '0.12.0' } },
    mcp_tools_list: { status: 200, count: 26 },
    tools_sha256: { sha256: baseline.toolsSha256, bytes: 36641 },
    mcp_runJSX: { status: 200, result: { content: [{ type: 'text', text: '{"ok":true}' }] } },
    jsx_captured: { captured: true, sha256: baseline.jsxSha256, agentUndoGroupStripped: true, gafferUndoGroupPresent: true, guardPresent: true },
    runjsx_timeout: { status: 200, elapsedMs: 60001, isError: true, text: '{"ok":false,"error":"runJSX timed out after 60s"}' },
    runjsx_after_timeout: { status: 200, result: { content: [] } },
  };
}
const allOpts = { auth: true, timeoutCheck: true, expectVersion: '0.12.0', expectToolsSha: baseline.toolsSha256, expectJsxSha: baseline.jsxSha256, expectToolCount: 26 };

test('parity: the PoC probe inputs are unchanged (the P8 hashes depend on them)', () => {
  assert.equal(PROBE_CODE, 'app.beginUndoGroup("agent group");\nvar comp = app.project.activeItem;\nvar a = 1 + 41;\napp.endUndoGroup();\na');
  assert.equal(PROBE_UNDO_LABEL, 'poc probe');
  assert.equal(baseline.toolsSha256, '68693916750f82147194bef71e6c39926e8b8886004662567653b2d1feab8223');
  assert.equal(baseline.jsxSha256, 'db239664e741baa4ca260e0b29251f91fbc910c67c478529dc941d2b76717faf');
});

test('parity: all good passes', () => {
  assert.deepEqual(evaluate(goodSteps(), allOpts), []);
});

test('parity: each broken rule is reported', () => {
  const cases = [
    ['ws_evil_origin', { status: 101 }, /foreign Origin/],
    ['ws_foreign_host', { status: 101 }, /foreign Host/],
    ['ws_no_origin', { status: 403 }, /without Origin/],
    ['auth_status_reply', null, /auth_status/],
    ['mcp_initialize', { status: 200, sessionId: true, serverInfo: { version: '0.11.3' } }, /serverInfo.version/],
    ['tools_sha256', { sha256: 'x' }, /tools\/list sha256/],
    ['mcp_tools_list', { status: 200, count: 25 }, /count 25/],
    ['jsx_captured', Object.assign({}, goodSteps().jsx_captured, { agentUndoGroupStripped: false }), /undo group reached the panel/],
    ['jsx_captured', Object.assign({}, goodSteps().jsx_captured, { gafferUndoGroupPresent: false }), /"Gaffer: " undo group/],
    ['jsx_captured', Object.assign({}, goodSteps().jsx_captured, { guardPresent: false }), /loop guard/],
    ['jsx_captured', Object.assign({}, goodSteps().jsx_captured, { sha256: 'y' }), /capture sha256/],
    ['jsx_captured', { captured: false }, /never received/],
    ['mcp_runJSX', { status: 200, result: { isError: true } }, /runJSX through the mock panel failed/],
    ['runjsx_timeout', { status: 200, elapsedMs: 3000, isError: true, text: 'timed out after 60s' }, /after 3000 ms/],
    ['runjsx_timeout', { status: 200, elapsedMs: 60000, isError: false, text: '42' }, /did not fail/],
    ['runjsx_after_timeout', { status: 200, result: { isError: true } }, /queue stuck/],
  ];
  for (const [key, value, re] of cases) {
    const s = goodSteps(); s[key] = value;
    const f = evaluate(s, allOpts);
    assert.equal(f.length, 1, key + ': ' + JSON.stringify(f));
    assert.match(f[0], re);
  }
});

test('parity: optional checks are skipped when not asked for', () => {
  const s = goodSteps();
  delete s.runjsx_timeout; delete s.runjsx_after_timeout; s.auth_status_reply = 'skipped';
  s.tools_sha256 = { sha256: 'other' }; s.jsx_captured.sha256 = 'other';
  assert.deepEqual(evaluate(s, { auth: false, timeoutCheck: false }), []);
});

test('parity: argument parsing refuses the live daemon ports', () => {
  assert.throws(() => parityArgs(['--ws-port', '9823', '--mcp-port', '27832', '--out', 'x']), /default port 9823/);
  assert.throws(() => parityArgs(['--ws-port', '27831', '--mcp-port', '9824', '--out', 'x']), /default port 9824/);
  assert.throws(() => parityArgs(['--ws-port', '27831', '--mcp-port', '27832']), /--out/);
  const o = parityArgs(['--ws-port', '27831', '--mcp-port', '27832', '--out', 'x', '--timeout-check', '--no-auth', '--expect-tool-count', '26']);
  assert.equal(o.timeoutCheck, true); assert.equal(o.auth, false); assert.equal(o.expectToolCount, 26);
});

test('run-smoke: argument parsing', () => {
  const base = ['--ext', 'e', '--out', 'o', '--platform', 'win-x64', '--ws-port', '27831', '--mcp-port', '27832', '--source-daemon', 'd'];
  assert.equal(smokeArgs(base).platform, 'win-x64');
  assert.throws(() => smokeArgs(base.map((a) => (a === 'win-x64' ? 'linux-x64' : a))), /--platform/);
  assert.throws(() => smokeArgs(base.map((a) => (a === '27832' ? '9824' : a))), /default port/);
  assert.throws(() => smokeArgs(base.map((a) => (a === '27832' ? '27831' : a))), /must differ/);
  assert.throws(() => smokeArgs(base.slice(0, -2)), /--source-daemon/);
  assert.equal(smokeArgs(base.slice(0, -2).concat(['--no-suite'])).suite, false);
});

test('run-smoke: stripped env has no node on PATH and keeps only the listed variables', () => {
  const mac = strippedEnv('darwin-arm64', { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/r', USER: 'r', TMPDIR: '/t', NODE_OPTIONS: '--require x', SECRET: 's' }, { GAFFER_WS_PORT: '1' });
  assert.deepEqual(mac, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/r', USER: 'r', TMPDIR: '/t', GAFFER_WS_PORT: '1' });
  const win = strippedEnv('win-x64', { Path: 'C:\\hostedtoolcache\\node;C:\\Windows', SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\T', node_options: 'x', USERPROFILE: 'C:\\U' });
  assert.equal(win.PATH, 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  assert.equal(win.SystemRoot, 'C:\\Windows');
  assert.equal(win.TEMP, 'C:\\T');
  assert.equal(win.USERPROFILE, 'C:\\U');
  assert.ok(!('node_options' in win) && !('Path' in win));
});

test('run-smoke: binary checked against the pins', () => {
  const pins = JSON.parse(readFileSync(fileURLToPath(new URL('../../panel/daemon/runtime-pins.json', import.meta.url)), 'utf8'));
  const p = pins.node.platforms['win-x64'];
  const good = { size: p.binaryBytes, sha256: p.binarySha256, version: pins.node.version, arch: 'x64' };
  assert.equal(checkBinaryAgainstPin(pins, 'win-x64', good).ok, true);
  assert.match(checkBinaryAgainstPin(pins, 'win-x64', Object.assign({}, good, { size: 1 })).problems[0], /size/);
  assert.match(checkBinaryAgainstPin(pins, 'win-x64', Object.assign({}, good, { sha256: 'bad' })).problems[0], /sha256/);
  assert.match(checkBinaryAgainstPin(pins, 'win-x64', Object.assign({}, good, { version: 'v24.0.0' })).problems[0], /--version/);
  assert.match(checkBinaryAgainstPin(pins, 'darwin-arm64', Object.assign({}, good, { size: pins.node.platforms['darwin-arm64'].binaryBytes, sha256: pins.node.platforms['darwin-arm64'].binarySha256 })).problems[0], /arch x64 != arm64/);
  const ph = JSON.parse(JSON.stringify(pins)); ph.node.platforms['win-x64'].binarySha256 = PLACEHOLDER_PIN;
  const r = checkBinaryAgainstPin(ph, 'win-x64', Object.assign({}, good, { sha256: 'anything' }));
  assert.equal(r.ok, true); assert.match(r.notes[0], /placeholder/);
  assert.equal(checkBinaryAgainstPin(pins, 'linux-x64', good).ok, false);
});

test('run-smoke: TeamIdentifier and TAP counters', () => {
  assert.equal(teamIdFromCodesign('Executable=/x/node\nIdentifier=node\nTeamIdentifier=HX7739G8FX\nRuntime Version=14.0.0\n'), 'HX7739G8FX');
  assert.equal(teamIdFromCodesign('TeamIdentifier=not set'), 'not');
  assert.equal(teamIdFromCodesign('code object is not signed at all'), null);
  assert.deepEqual(parseTapCounts('ok 1 - a\n# tests 464\n# suites 0\n# pass 463\n# fail 0\n# cancelled 0\n# skipped 1\n'), { tests: 464, pass: 463, fail: 0, cancelled: 0, skipped: 1 });
  assert.equal(parseTapCounts('garbage').tests, null);
});

test('run-smoke: packaged vs source is the gate, the baseline only warns', () => {
  const s = (tools, jsx, count) => ({ tools_sha256: { sha256: tools }, jsx_captured: { sha256: jsx }, mcp_tools_list: { count } });
  const same = compareParity(s('a', 'b', 26), s('a', 'b', 26), { toolsSha256: 'a', jsxSha256: 'b', toolCount: 26 });
  assert.deepEqual([same.fails, same.warns], [[], []]);
  const drift = compareParity(s('a', 'b', 26), s('a2', 'b', 26), null);
  assert.equal(drift.fails.length, 1); assert.match(drift.fails[0], /tools\/list sha256 differs/);
  const jsx = compareParity(s('a', 'b', 26), s('a', 'b2', 27), null);
  assert.equal(jsx.fails.length, 2);
  const moved = compareParity(s('n', 'm', 27), s('n', 'm', 27), { toolsSha256: 'a', jsxSha256: 'b', toolCount: 26 });
  assert.deepEqual(moved.fails, []); assert.equal(moved.warns.length, 3);
  const sized = (tb, jb) => ({ tools_sha256: { sha256: 'a', bytes: tb }, jsx_captured: { sha256: 'b', length: jb }, mcp_tools_list: { count: 26 } });
  const full = { toolsSha256: 'a', jsxSha256: 'b', toolCount: 26, toolsBytes: 36641, jsxBytes: 2465 };
  assert.deepEqual(compareParity(sized(36641, 2465), null, full).warns, []);
  const w = compareParity(sized(36000, 2400), null, full).warns;
  assert.equal(w.length, 2); assert.match(w[0], /tools\/list size 36000/); assert.match(w[1], /capture size 2400/);
});

test('run-smoke: non-loopback addresses from os.networkInterfaces()', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }, { address: 'fe80::1', family: 'IPv6', internal: true }],
    en0: [{ address: 'fe80::1c2:3ff:fe4:5', family: 'IPv6', internal: false }, { address: '192.168.1.20', family: 'IPv4', internal: false }, { address: '2001:db8::5', family: 'IPv6', internal: false }],
    utun: [{ address: '10.0.0.2', family: 4, internal: false }],
  };
  assert.deepEqual(nonLoopbackAddresses(ifaces), ['192.168.1.20', '2001:db8::5', '10.0.0.2']);
  assert.deepEqual(nonLoopbackAddresses({}), []);
});

test('run-smoke: listener rule over lsof / Get-NetTCPConnection output', () => {
  const addrs = listenAddrsFromLsof('p123\nf20\nn127.0.0.1:27831\nf21\nn127.0.0.1:27832\n');
  assert.deepEqual(addrs, ['127.0.0.1:27831', '127.0.0.1:27832']);
  assert.deepEqual(listenersLoopbackOnly(addrs, [27831, 27832]), []);
  assert.match(listenersLoopbackOnly(['*:27831', '127.0.0.1:27832'], [27831, 27832]).join(), /listener on \*:27831.*no 127\.0\.0\.1:27831/);
  assert.match(listenersLoopbackOnly(['127.0.0.1:27831', '0.0.0.0:27832'], [27831, 27832]).join(), /0\.0\.0\.0:27832/);
  assert.match(listenersLoopbackOnly(['[::1]:27831', '127.0.0.1:27832'], [27831, 27832]).join(), /listener on \[::1\]:27831/);
  assert.match(listenersLoopbackOnly([], [27831, 27832]).join(), /no 127\.0\.0\.1:27831/);
});

test('run-smoke: node_modules found inside the tree and in parents', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaffer-smoke-nm-'));
  try {
    const ext = join(root, 'a b', 'com.gaffer.panel');
    mkdirSync(join(ext, 'daemon', 'runtime'), { recursive: true });
    assert.deepEqual(findNodeModules(ext).filter((p) => p.startsWith(root)), []);
    mkdirSync(join(ext, 'daemon', 'node_modules', 'ws'), { recursive: true });
    mkdirSync(join(root, 'node_modules'));
    const hits = findNodeModules(ext).filter((p) => p.startsWith(root));
    assert.deepEqual(hits.sort(), [join(ext, 'daemon', 'node_modules'), join(root, 'node_modules')].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run-smoke starts the daemon with GAFFER_TEST=1, so its port overrides are honoured', () => {
  const src = readFileSync(new URL('./run-smoke.mjs', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes('const daemonEnv = strippedEnv('));
  assert.ok(line, 'no daemonEnv line');
  assert.ok(line.includes("GAFFER_TEST: '1'") && line.includes('GAFFER_WS_PORT') && line.includes('GAFFER_MCP_PORT'), line);
});
