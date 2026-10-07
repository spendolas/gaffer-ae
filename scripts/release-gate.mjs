#!/usr/bin/env node
// Release gate for .github/workflows/release.yml. Decides whether the
// version in panel/version.json should be released (create), finished
// (recover) or left alone (skip), and extracts the CHANGELOG section that
// becomes the release notes. Pure logic is exported for
// scripts/release-gate.test.mjs; the CLI at the bottom is what the workflow runs.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_ASSETS = [
  'gaffer-install-mac.tar.gz',
  'gaffer-install-win.zip',
  'gaffer-update-mac.tar.gz',
  'gaffer-update-win.zip',
];

export class GateError extends Error {}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

// "0.11.0-beta.1" -> { nums: [0, 11, 0], pre: "beta.1" }; anything else -> null.
export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v));
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null };
}

// `sort -V` style: digit runs compare as numbers, everything else as text.
function comparePre(a, b) {
  const ca = a.match(/\d+|\D+/g);
  const cb = b.match(/\d+|\D+/g);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const x = ca[i];
    const y = cb[i];
    const bothNum = /^\d/.test(x) && /^\d/.test(y);
    if (bothNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ca.length === cb.length ? 0 : (ca.length < cb.length ? -1 : 1);
}

// -1, 0 or 1. Numeric major.minor.patch first; on a tie a final release is
// greater than any prerelease of it.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new GateError(`cannot compare "${a}" and "${b}"`);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePre(pa.pre, pb.pre);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Body of the "## v<version>" section: the lines after the heading up to,
// not including, the next line starting with "## ". Leading and trailing
// blank lines are dropped. null when the heading is missing.
export function extractNotes(changelog, version) {
  const lines = String(changelog).split(/\r?\n/);
  const heading = new RegExp('^## v' + escapeRegExp(version) + '( |$)');
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break;
    body.push(lines[i]);
  }
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return body.join('\n') + '\n';
}

export function isCompleteRelease(release) {
  if (!release || release.isDraft) return false;
  const names = (release.assets || []).map((a) => a.name);
  return REQUIRED_ASSETS.every((n) => names.includes(n));
}

// version: string from panel/version.json. tags: array of tag names.
// release: { isDraft, assets: [{ name }] } from `gh release view`, or null.
// changelog: CHANGELOG.md text. Returns { action, notes }; throws GateError.
export function decide({ version, tags, release, changelog }) {
  if (!parseVersion(version)) {
    throw new GateError(`panel/version.json version "${version}" is not major.minor.patch[-prerelease]`);
  }
  if (isCompleteRelease(release)) return { action: 'skip', notes: null };
  let action = 'recover';
  if (!release) {
    for (const tag of tags) {
      if (!tag.startsWith('v')) continue;
      const tagVersion = tag.slice(1);
      if (tagVersion === version || !parseVersion(tagVersion)) continue;
      if (compareVersions(version, tagVersion) <= 0) {
        throw new GateError(`version ${version} is not greater than existing tag ${tag}`);
      }
    }
    action = 'create';
  }
  const notes = extractNotes(changelog, version);
  if (notes === null) throw new GateError(`CHANGELOG.md has no "## v${version}" heading`);
  // An empty section would publish a release with blank notes.
  if (notes.trim() === '') throw new GateError(`CHANGELOG.md has a heading for v${version} but no notes under it`);
  return { action, notes };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new GateError(`bad argument "${argv[i]}"`);
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['version', 'tags-file', 'release-file', 'changelog', 'notes-out']) {
    if (!out[k]) throw new GateError(`missing --${k}`);
  }
  return out;
}

export function main(argv, env) {
  const args = parseArgs(argv);
  const tags = readFileSync(args['tags-file'], 'utf8').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  const releaseText = readFileSync(args['release-file'], 'utf8').trim();
  const release = releaseText === '' ? null : JSON.parse(releaseText);
  const changelog = readFileSync(args.changelog, 'utf8');
  const { action, notes } = decide({ version: args.version, tags, release, changelog });
  if (notes !== null) writeFileSync(args['notes-out'], notes);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `action=${action}\n`);
  console.log(`release-gate: v${args.version} -> ${action}`);
  return action;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (e) {
    console.error('release-gate: ' + e.message);
    process.exit(1);
  }
}
