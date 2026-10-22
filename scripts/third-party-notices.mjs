// Writes THIRD-PARTY-NOTICES.txt for the bundled daemon. No dependencies.
//
// Usage: node scripts/third-party-notices.mjs <meta.json> <node_modules> <out>
//
// <meta.json> is esbuild's metafile. Every input under a node_modules segment
// is a bundled package; its name, version, license field and license file are
// read from <node_modules>. The build fails (exit 1, nothing written) on a
// package with no license file, no license field, or a license outside the
// allowlist.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const ALLOWED = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD'];

// Package names bundled in the metafile: the segment(s) after the LAST
// "node_modules/" (handles nested installs and @scoped names).
export function bundledPackages(meta) {
  const names = new Set();
  for (const file of Object.keys(meta.inputs || {})) {
    const norm = file.replace(/\\/g, '/');
    const i = norm.lastIndexOf('node_modules/');
    if (i === -1) continue;
    const rest = norm.slice(i + 'node_modules/'.length).split('/');
    names.add(rest[0].startsWith('@') ? rest[0] + '/' + rest[1] : rest[0]);
  }
  return [...names].sort();
}

// For nested installs the first-level path is not enough; resolve the
// on-disk directory from the exact input path instead.
function packageDirs(meta, nodeModules) {
  const dirs = new Map();
  for (const file of Object.keys(meta.inputs || {})) {
    const norm = file.replace(/\\/g, '/');
    const i = norm.lastIndexOf('node_modules/');
    if (i === -1) continue;
    const prefix = norm.slice(0, i + 'node_modules/'.length);
    const rest = norm.slice(i + 'node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? rest[0] + '/' + rest[1] : rest[0];
    // Map the metafile prefix onto the node_modules dir we were handed.
    const base = prefix === 'node_modules/' ? nodeModules : join(nodeModules, '..', prefix);
    dirs.set(prefix + name, join(base, name));
  }
  return dirs;
}

function licenseString(pj) {
  let l = pj.license;
  if (l && typeof l === 'object') l = l.type;
  if (!l && Array.isArray(pj.licenses)) l = pj.licenses.map((x) => x.type || x).join(' OR ');
  return typeof l === 'string' ? l : '';
}

// SPDX expression: "A OR B" passes if any alternative passes; "A AND B" needs both.
export function licenseAllowed(expr) {
  const clean = expr.replace(/[()]/g, ' ').trim();
  if (!clean) return false;
  return clean.split(/\s+OR\s+/i).some((alt) => alt.split(/\s+AND\s+/i).every((id) => ALLOWED.includes(id.trim())));
}

function findLicenseFile(dir) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((n) => /^(licen[sc]e|copying|notice)([-._].*)?$/i.test(n));
  const pick = names.find((n) => /^licen[sc]e/i.test(n)) || names[0];
  return pick ? join(dir, pick) : null;
}

export function buildNotices(meta, nodeModules) {
  const problems = [];
  const entries = [];
  for (const [key, dir] of [...packageDirs(meta, nodeModules)].sort((a, b) => a[0].localeCompare(b[0]))) {
    let pj;
    try { pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
    catch { problems.push(key + ': package.json not found in ' + dir); continue; }
    const name = pj.name || key;
    const license = licenseString(pj);
    const file = findLicenseFile(dir);
    if (!file) problems.push(name + ' ' + pj.version + ': no license file found in ' + dir);
    if (!license) problems.push(name + ' ' + pj.version + ': no license field in package.json');
    else if (!licenseAllowed(license)) problems.push(name + ' ' + pj.version + ': license "' + license + '" is outside the allowlist (' + ALLOWED.join(', ') + ')');
    if (file && license) entries.push({ name, version: pj.version, license, text: readFileSync(file, 'utf8').trim() });
  }
  if (problems.length) return { problems };
  const out = [];
  out.push('Gaffer third-party notices');
  out.push('');
  out.push('The Gaffer daemon bundles the open source packages listed below.');
  out.push('Gaffer also downloads the Node.js runtime on first use (MIT license,');
  out.push('https://github.com/nodejs/node/blob/main/LICENSE). Node.js is not part of this package.');
  out.push('');
  for (const e of entries) {
    out.push('='.repeat(78));
    out.push(e.name + ' ' + e.version + ' (' + e.license + ')');
    out.push('='.repeat(78));
    out.push(e.text);
    out.push('');
  }
  return { text: out.join('\n'), count: entries.length };
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [metaPath, nodeModules, outPath] = process.argv.slice(2);
  if (!metaPath || !nodeModules || !outPath) {
    console.error('usage: node scripts/third-party-notices.mjs <meta.json> <node_modules> <out>');
    process.exit(2);
  }
  const res = buildNotices(JSON.parse(readFileSync(metaPath, 'utf8')), nodeModules);
  if (res.problems) {
    console.error('third-party notices failed:');
    for (const p of res.problems) console.error('  ' + p);
    process.exit(1);
  }
  writeFileSync(outPath, res.text);
  console.log('Wrote ' + outPath + ' (' + res.count + ' packages, ' + Math.round(res.text.length / 1024) + ' KB)');
}
