// Run from the repo root: node --test scripts/third-party-notices.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./third-party-notices.mjs', import.meta.url));

// Builds a fixture: <root>/node_modules/<pkgs> plus a meta.json whose inputs
// reference one file per package, the way esbuild's metafile does.
function fixture(pkgs) {
  const root = mkdtempSync(join(tmpdir(), 'gaffer-notices-'));
  const nm = join(root, 'node_modules');
  const inputs = { 'index.js': { bytes: 1, imports: [] } };
  for (const p of pkgs) {
    const rel = p.nestedIn ? 'node_modules/' + p.nestedIn + '/node_modules/' : 'node_modules/';
    const dir = join(nm, '..', rel, p.name);
    mkdirSync(join(dir, 'lib'), { recursive: true });
    const pj = { name: p.name, version: p.version };
    if (p.license !== undefined) pj.license = p.license;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pj));
    writeFileSync(join(dir, 'lib', 'x.js'), '');
    if (p.licenseFile) writeFileSync(join(dir, p.licenseFile), p.licenseText || 'License text for ' + p.name);
    inputs[rel + p.name + '/lib/x.js'] = { bytes: 1, imports: [] };
  }
  const meta = join(root, 'meta.json');
  writeFileSync(meta, JSON.stringify({ inputs, outputs: {} }));
  return { root, nm, meta, out: join(root, 'THIRD-PARTY-NOTICES.txt') };
}
const run = (f) => spawnSync(process.execPath, [script, f.meta, f.nm, f.out], { encoding: 'utf8' });

test('allowed licenses (incl. scoped name and a nested package) produce a notices file', () => {
  const f = fixture([
    { name: 'alpha', version: '1.0.0', license: 'MIT', licenseFile: 'LICENSE', licenseText: 'ALPHA-MIT-TEXT' },
    { name: '@scope/beta', version: '2.1.0', license: 'ISC', licenseFile: 'LICENSE.md' },
    { name: 'gamma', version: '3.0.0', license: { type: 'BSD-3-Clause' }, licenseFile: 'license' },
    { name: 'alpha', version: '9.9.9', nestedIn: 'delta', license: 'BSD-2-Clause', licenseFile: 'LICENSE', licenseText: 'NESTED-ALPHA-TEXT' },
    { name: 'delta', version: '0.1.0', license: '(MIT OR Apache-2.0)', licenseFile: 'LICENSE-MIT' },
  ]);
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(f.out, 'utf8');
  for (const s of ['alpha 1.0.0', '@scope/beta 2.1.0', 'gamma 3.0.0', 'delta 0.1.0', 'ALPHA-MIT-TEXT', 'alpha 9.9.9', 'NESTED-ALPHA-TEXT', 'Node.js', 'https://github.com/nodejs/node/blob/main/LICENSE']) {
    assert.ok(text.includes(s), 'missing ' + s);
  }
  assert.ok(!/[–—]/.test(text.split('ALPHA-MIT-TEXT')[0].slice(0, 400)), 'no typographic dashes in our own header');
});

test('a package with no license file fails the build and writes nothing', () => {
  const f = fixture([{ name: 'nolic', version: '1.0.0', license: 'MIT' }]);
  const r = run(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nolic/);
  assert.match(r.stderr, /license file/i);
  assert.ok(!existsSync(f.out));
});

test('a license outside the allowlist fails the build', () => {
  const f = fixture([{ name: 'gpl-thing', version: '1.0.0', license: 'GPL-3.0', licenseFile: 'LICENSE' }]);
  const r = run(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /gpl-thing/);
  assert.match(r.stderr, /GPL-3\.0/);
  assert.ok(!existsSync(f.out));
});

test('a package with no license field fails the build', () => {
  const f = fixture([{ name: 'nofield', version: '1.0.0', licenseFile: 'LICENSE' }]);
  const r = run(f);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nofield/);
});

test('usage error without arguments', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage/i);
});

// bundle-daemon.sh hygiene seam: `--hygiene-only <file>` runs just the pattern check.
const bundleScript = fileURLToPath(new URL('./bundle-daemon.sh', import.meta.url));
const hygiene = (content) => {
  const f = join(mkdtempSync(join(tmpdir(), 'gaffer-hyg-')), 'daemon.mjs');
  writeFileSync(f, content);
  return spawnSync('bash', [bundleScript, '--hygiene-only', f], { encoding: 'utf8' });
};

test('hygiene: clean content passes', () => {
  assert.equal(hygiene('const a = 1;\n').status, 0);
});
for (const [label, bad] of [
  ['/Users/', 'var p = "/Users/someone/x";'],
  ['/home/', 'var p = "/home/someone/x";'],
  ['C:\\Users single backslash', 'var p = "C:\\Users\\x";'],
  ['C:\\\\Users escaped double backslash', 'var p = "C:\\\\Users\\\\x";'],
  ['sk-ant-', 'var k = "sk-ant-api03-abc";'],
  ['ghp_', 'var k = "ghp_abc";'],
  ['-----BEGIN', 'var k = "-----BEGIN PRIVATE KEY-----";'],
]) {
  test('hygiene: ' + label + ' fails the check', () => {
    const r = hygiene(bad);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /hygiene check failed/);
  });
}
