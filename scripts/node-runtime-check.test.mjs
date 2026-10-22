// Run from the repo root: node --test scripts/node-runtime-check.test.mjs
// Every rule of the weekly runtime check, driven by fixtures through an
// injected fake network (no real requests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runCheck, checkIndex, checkShasums, parseShasums, checkLatest, compareMirrorFile, compareVersions,
} from './node-runtime-check.mjs';

const pins = JSON.parse(readFileSync(fileURLToPath(new URL('../panel/daemon/runtime-pins.json', import.meta.url)), 'utf8'));
const PIN = pins.node.version;
const P = pins.node.platforms;
const SIG_HASH = { sha256: 'a'.repeat(64), bytes: 566 };
const SUMS_HASH = { sha256: 'b'.repeat(64), bytes: 6123 };

// index.json as nodejs.org serves it: newest first, lts false or a codename.
function indexFixture(extra) {
  return (extra || []).concat([
    { version: 'v25.2.0', date: '2026-10-14', lts: false, security: true },
    { version: PIN, date: '2026-09-30', lts: 'Krypton', security: false },
    { version: 'v24.22.0', date: '2026-09-10', lts: 'Krypton', security: true },
    { version: 'v22.30.0', date: '2026-10-01', lts: 'Jod', security: true },
  ]);
}
function shasumsFixture(overrides) {
  const lines = ['0'.repeat(64) + '  node-' + PIN + '-headers.tar.gz'];
  for (const p of Object.values(P)) lines.push(((overrides || {})[p.archive] || p.archiveSha256) + '  ' + p.archive);
  lines.push('1'.repeat(64) + '  node-' + PIN + '-linux-x64.tar.xz');
  return lines.join('\n') + '\n';
}

// A fake network: official and mirror files by URL, JSON documents by URL.
function fakeNet(opts) {
  opts = opts || {};
  const hashes = {};
  for (const p of Object.values(P)) {
    hashes[pins.node.official + p.archive] = { sha256: p.archiveSha256, bytes: 50000000 };
    hashes[pins.node.mirror + p.archive] = { sha256: p.archiveSha256, bytes: 50000000 };
  }
  for (const base of [pins.node.official, pins.node.mirror]) {
    hashes[base + 'SHASUMS256.txt'] = SUMS_HASH;
    hashes[base + 'SHASUMS256.txt.sig'] = SIG_HASH;
  }
  Object.assign(hashes, opts.hashes || {});
  const json = {
    'https://nodejs.org/dist/index.json': opts.index || indexFixture(),
    'https://api.github.com/repos/spendolas/gaffer-ae/releases/latest': opts.latest || { tag_name: 'v0.12.0', name: 'v0.12.0' },
  };
  const calls = [];
  return {
    calls,
    async getJson(url) { calls.push(url); if (!(url in json)) throw new Error('HTTP 404 for ' + url); return json[url]; },
    async getText(url) { calls.push(url); if (url === pins.node.official + 'SHASUMS256.txt') return opts.shasums || shasumsFixture(); throw new Error('HTTP 404 for ' + url); },
    async hashUrl(url) { calls.push(url); if (opts.missing && opts.missing.indexOf(url) !== -1) throw new Error('HTTP 404 for ' + url); if (!(url in hashes)) throw new Error('HTTP 404 for ' + url); return hashes[url]; },
  };
}
const run = (net, extra) => runCheck(Object.assign({ pins, net, shasumsText: shasumsFixture(), repo: 'spendolas/gaffer-ae', skipMirror: false }, extra || {}));

test('happy path passes and fetches every mirror file', async () => {
  const net = fakeNet();
  const r = await run(net);
  assert.deepEqual(r.failures, []);
  for (const p of Object.values(P)) assert.ok(net.calls.includes(pins.node.mirror + p.archive));
  assert.ok(net.calls.includes(pins.node.mirror + 'SHASUMS256.txt.sig'));
  assert.ok(!r.notes.some((n) => /NOT verified/.test(n)), 'the verified file is used, not refetched');
});

test('a security release newer than the pin on the pinned line fails', async () => {
  const r = await run(fakeNet({ index: indexFixture([{ version: 'v24.23.0', date: '2026-10-20', lts: 'Krypton', security: true }]) }));
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /security release\(s\) newer than the pin v24\.22\.1: v24\.23\.0/);
});

test('newer non-security releases and other lines only produce notes', async () => {
  const r = await run(fakeNet({ index: indexFixture([{ version: 'v24.23.0', lts: 'Krypton', security: false }]) }));
  assert.deepEqual(r.failures, []);
  assert.ok(r.notes.some((n) => /v24\.23\.0/.test(n)));
});

test('a non-LTS line, or a pin missing from index.json, fails', () => {
  const notLts = checkIndex([{ version: 'v24.22.2', lts: false, security: false }, { version: PIN, lts: false }], pins);
  assert.match(notLts.failures.join(), /not LTS/);
  const missing = checkIndex([{ version: 'v24.22.2', lts: 'Krypton', security: false }], pins);
  assert.match(missing.failures.join(), /not listed in index\.json/);
  assert.match(checkIndex({}, pins).failures[0], /not an array/);
});

test('version ordering is numeric, not lexical', () => {
  assert.equal(compareVersions('v24.100.0', 'v24.22.1'), 1);
  assert.equal(compareVersions('v24.22.10', 'v24.22.9'), 1);
  assert.equal(compareVersions('v24.22.1', 'v24.22.1'), 0);
});

test('hash drift against SHASUMS256.txt fails', async () => {
  const drifted = shasumsFixture({ [P['win-x64'].archive]: 'f'.repeat(64) });
  const r = await run(fakeNet(), { shasumsText: drifted });
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /win-x64: pinned archiveSha256 d2046d28.* differs from SHASUMS256\.txt f{64}/);
  const gone = checkShasums(shasumsFixture().split('\n').filter((l) => !l.includes('darwin-arm64')).join('\n'), pins);
  assert.match(gone.failures[0], /darwin-arm64: .* is not listed/);
});

test('SHASUMS256.txt parsing accepts the binary-mode asterisk and CRLF', () => {
  assert.deepEqual(parseShasums('AB'.repeat(32) + ' *x.zip\r\n' + 'junk\n'), { 'x.zip': 'ab'.repeat(32) });
});

test('without --shasums-file the file is fetched and the summary says it is unverified', async () => {
  const net = fakeNet();
  const r = await run(net, { shasumsText: null });
  assert.deepEqual(r.failures, []);
  assert.ok(net.calls.includes(pins.node.official + 'SHASUMS256.txt'));
  assert.ok(r.notes.some((n) => /NOT verified/.test(n)));
});

test('a mirror byte mismatch fails', async () => {
  const a = P['darwin-x64'].archive;
  const r = await run(fakeNet({ hashes: { [pins.node.mirror + a]: { sha256: 'e'.repeat(64), bytes: 50000000 } } }));
  assert.equal(r.failures.length, 2, r.failures.join('\n'));
  assert.match(r.failures[0], /darwin-x64\.tar\.gz: mirror differs from the official file/);
  assert.match(r.failures[1], /mirror sha256 e{64} differs from the pin/);
  const truncated = await run(fakeNet({ hashes: { [pins.node.mirror + 'SHASUMS256.txt.sig']: { sha256: SIG_HASH.sha256, bytes: 100 } } }));
  assert.match(truncated.failures.join(), /SHASUMS256\.txt\.sig: mirror differs/);
});

test('a missing mirror file fails', async () => {
  const url = pins.node.mirror + P['win-x64'].archive;
  const r = await run(fakeNet({ missing: [url] }));
  assert.match(r.failures.join(), /win-x64\.zip: mirror download failed: HTTP 404/);
  assert.deepEqual(compareMirrorFile('x', { sha256: 'a', bytes: 1 }, { sha256: 'a', bytes: 1 }, 'a'), []);
});

test('--skip-mirror skips the mirror downloads', async () => {
  const net = fakeNet({ missing: [pins.node.mirror + P['win-x64'].archive] });
  const r = await run(net, { skipMirror: true });
  assert.deepEqual(r.failures, []);
  assert.ok(!net.calls.some((u) => u.startsWith(pins.node.mirror)));
});

test('releases/latest resolving to the mirror (or any non-v* tag) fails', async () => {
  const r = await run(fakeNet({ latest: { tag_name: 'node-v24.22.1' } }));
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /releases\/latest resolves to "node-v24\.22\.1"/);
  for (const bad of [undefined, '', 'v0.12', 'v0.12.0-beta.1', 'release-1']) assert.equal(checkLatest({ tag_name: bad }).failures.length, 1, String(bad));
  assert.deepEqual(checkLatest({ tag_name: 'v0.12.0' }).failures, []);
});

test('a network error on index.json or releases/latest is a failure, not a crash', async () => {
  const net = fakeNet();
  net.getJson = async (url) => { throw new Error('getaddrinfo ENOTFOUND for ' + url); };
  const r = await run(net);
  assert.equal(r.failures.length, 2);
  assert.match(r.failures[0], /^index\.json: getaddrinfo/);
  assert.match(r.failures[1], /^releases\/latest: getaddrinfo/);
});
