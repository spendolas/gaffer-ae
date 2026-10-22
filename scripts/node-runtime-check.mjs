#!/usr/bin/env node
// Weekly check of the pinned Node runtime (spec section 10), run by
// .github/workflows/node-runtime-check.yml, read-only and with no secrets:
//
//   1. nodejs.org/dist/index.json: fail when a release on the pinned major
//      line is newer than the pin and has security: true, when the line's
//      newest release is not LTS (lts: false), or when the pin is missing.
//   2. The pinned version's SHASUMS256.txt (its GPG signature is verified by
//      the workflow with the Node release keys before this runs and passed in
//      with --shasums-file): fail when any pinned archiveSha256 differs or is
//      missing.
//   3. Mirror (Gaffer's node-v<version> release): every pinned archive,
//      SHASUMS256.txt and SHASUMS256.txt.sig must be byte-identical to the
//      official file (same SHA-256 and size) and the archives must also match
//      the pins.
//   4. releases/latest of the Gaffer repo must be a Gaffer v<x.y.z> release,
//      never the node-v* mirror release.
//
// Usage:
//   node scripts/node-runtime-check.mjs [--pins panel/daemon/runtime-pins.json]
//        [--shasums-file <verified SHASUMS256.txt>] [--repo spendolas/gaffer-ae]
//        [--skip-mirror]
// Without --shasums-file the file is fetched here and the summary says its
// signature was NOT verified by this run (local use only).
// Exit 1 with a list of failures, 0 when all checks pass.
//
// All network access goes through the injected `net` object
// ({ getText(url), getJson(url), hashUrl(url) -> { sha256, bytes } }), so
// node-runtime-check.test.mjs drives every rule with fixtures.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ---------- pure helpers ----------

// "v24.22.1" -> [24, 22, 1]; null for anything else.
export function parseVersion(v) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// Rule 1 over the parsed index.json array.
export function checkIndex(index, pins) {
  const failures = [], notes = [];
  const pin = pins.node.version;
  const pv = parseVersion(pin);
  if (!pv) return { failures: ['pinned version ' + JSON.stringify(pin) + ' is not vX.Y.Z'], notes };
  if (!Array.isArray(index)) return { failures: ['index.json is not an array'], notes };
  const line = index.filter((e) => { const v = parseVersion(e && e.version); return v && v[0] === pv[0]; });
  if (!line.some((e) => e.version === pin)) failures.push('pinned ' + pin + ' is not listed in index.json');
  if (!line.length) return { failures: failures.concat(['no releases on the v' + pv[0] + ' line in index.json']), notes };
  const newer = line.filter((e) => compareVersions(e.version, pin) > 0).sort((a, b) => compareVersions(b.version, a.version));
  const sec = newer.filter((e) => e.security === true);
  if (sec.length) {
    failures.push('security release(s) newer than the pin ' + pin + ': ' + sec.map((e) => e.version + (e.date ? ' (' + e.date + ')' : '')).join(', ') +
      '. Bump panel/daemon/runtime-pins.json (and the mirror release) to ' + newer[0].version + ' or later.');
  } else if (newer.length) {
    notes.push('newer non-security release(s) on the line: ' + newer.map((e) => e.version).join(', '));
  }
  const newest = newer.length ? newer[0] : line.find((e) => e.version === pin) || line[0];
  if (newest.lts === false || newest.lts == null) failures.push('the v' + pv[0] + ' line is not LTS (newest ' + newest.version + ' has lts: ' + JSON.stringify(newest.lts) + ')');
  else if (pins.node.codename && newest.lts !== pins.node.codename) notes.push('LTS codename is ' + newest.lts + ', pins say ' + pins.node.codename);
  return { failures, notes };
}

// SHASUMS256.txt lines "<hex>  <file>" into { file: hex }.
export function parseShasums(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

// Rule 2.
export function checkShasums(text, pins) {
  const failures = [];
  const sums = parseShasums(text);
  for (const [plat, p] of Object.entries(pins.node.platforms)) {
    const got = sums[p.archive];
    if (!got) failures.push(plat + ': ' + p.archive + ' is not listed in SHASUMS256.txt');
    else if (got !== p.archiveSha256) failures.push(plat + ': pinned archiveSha256 ' + p.archiveSha256 + ' differs from SHASUMS256.txt ' + got);
  }
  return { failures };
}

// Rule 3 for one file: both sides as { sha256, bytes } (or { error }).
export function compareMirrorFile(name, official, mirror, pinnedSha) {
  const failures = [];
  if (!official || official.error) failures.push(name + ': official download failed: ' + (official && official.error));
  if (!mirror || mirror.error) failures.push(name + ': mirror download failed: ' + (mirror && mirror.error));
  if (failures.length) return failures;
  if (official.sha256 !== mirror.sha256 || official.bytes !== mirror.bytes) {
    failures.push(name + ': mirror differs from the official file (official ' + official.sha256 + ' ' + official.bytes + ' bytes, mirror ' + mirror.sha256 + ' ' + mirror.bytes + ' bytes)');
  }
  if (pinnedSha && mirror.sha256 !== pinnedSha) failures.push(name + ': mirror sha256 ' + mirror.sha256 + ' differs from the pin ' + pinnedSha);
  return failures;
}

// Rule 4 over the releases/latest JSON.
export function checkLatest(latest) {
  const tag = latest && latest.tag_name;
  if (!/^v\d+\.\d+\.\d+$/.test(String(tag || ''))) {
    return { failures: ['releases/latest resolves to ' + JSON.stringify(tag) + ', not a Gaffer v<x.y.z> release. Re-mark the newest Gaffer release as latest (the node mirror must stay --latest=false).'] };
  }
  return { failures: [] };
}

export async function runCheck({ pins, net, shasumsText, repo, skipMirror }) {
  const failures = [], notes = [];
  const add = (r) => { failures.push(...(r.failures || [])); notes.push(...(r.notes || [])); };
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { failures.push(label + ': ' + (e && e.message || e)); return undefined; } };

  const index = await safe('index.json', () => net.getJson('https://nodejs.org/dist/index.json'));
  if (index !== undefined) add(checkIndex(index, pins));

  let sums = shasumsText;
  if (sums == null) {
    sums = await safe('SHASUMS256.txt', () => net.getText(pins.node.official + 'SHASUMS256.txt'));
    notes.push('SHASUMS256.txt signature NOT verified by this run (no --shasums-file)');
  }
  if (sums !== undefined) add(checkShasums(sums, pins));

  if (!skipMirror) {
    const files = Object.values(pins.node.platforms).map((p) => ({ name: p.archive, pinned: p.archiveSha256 }))
      .concat([{ name: 'SHASUMS256.txt' }, { name: 'SHASUMS256.txt.sig' }]);
    for (const f of files) {
      const official = await net.hashUrl(pins.node.official + f.name).catch((e) => ({ error: e.message }));
      const mirror = await net.hashUrl(pins.node.mirror + f.name).catch((e) => ({ error: e.message }));
      failures.push(...compareMirrorFile(f.name, official, mirror, f.pinned));
    }
  }

  const latest = await safe('releases/latest', () => net.getJson('https://api.github.com/repos/' + repo + '/releases/latest'));
  if (latest !== undefined) add(checkLatest(latest));
  return { failures, notes };
}

// ---------- real network ----------

const UA = { 'User-Agent': 'gaffer-node-runtime-check' };
export const realNet = {
  async getText(url) {
    const r = await fetch(url, { headers: UA, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.text();
  },
  async getJson(url) {
    const h = Object.assign({ Accept: 'application/json' }, UA);
    // The workflow's read-only job token, only to lift the anonymous
    // api.github.com rate limit shared by hosted runners. Never sent elsewhere.
    if (process.env.GITHUB_TOKEN && url.startsWith('https://api.github.com/')) h.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
    const r = await fetch(url, { headers: h, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.json();
  },
  // Streams the body through SHA-256 so 50 MB archives never sit in memory.
  async hashUrl(url) {
    const r = await fetch(url, { headers: UA, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    const h = createHash('sha256');
    let bytes = 0;
    for await (const chunk of r.body) { h.update(chunk); bytes += chunk.length; }
    return { sha256: h.digest('hex'), bytes };
  },
};

function parseArgs(argv) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const o = { pins: resolve(here, '../panel/daemon/runtime-pins.json'), repo: 'spendolas/gaffer-ae', skipMirror: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pins') o.pins = argv[++i];
    else if (a === '--shasums-file') o.shasumsFile = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--skip-mirror') o.skipMirror = true;
    else throw new Error('unknown argument ' + a);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const pins = JSON.parse(readFileSync(o.pins, 'utf8'));
  const shasumsText = o.shasumsFile ? readFileSync(o.shasumsFile, 'utf8') : null;
  const { failures, notes } = await runCheck({ pins, net: realNet, shasumsText, repo: o.repo, skipMirror: o.skipMirror });
  console.log('Pinned Node ' + pins.node.version + ' (' + pins.node.codename + ')');
  notes.forEach((n) => console.log('note: ' + n));
  if (failures.length) {
    failures.forEach((f) => console.log('FAIL: ' + f));
    process.exitCode = 1;
  } else {
    console.log('node runtime check: all checks passed');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => { console.error('node-runtime-check: ' + (e && e.stack || e)); process.exitCode = 1; });
}
