// Run from the repo root: node --test scripts/runtime-pins.test.mjs
// Pins panel/daemon/runtime-pins.json to the values in spec section 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pins = JSON.parse(readFileSync(fileURLToPath(new URL('../panel/daemon/runtime-pins.json', import.meta.url)), 'utf8'));
const V = 'v24.22.1';

test('top level shape: only "node"', () => {
  assert.deepEqual(Object.keys(pins), ['node']);
  assert.deepEqual(Object.keys(pins.node).sort(), ['codename', 'mirror', 'official', 'platforms', 'signing', 'version']);
});

test('version, codename and base URLs', () => {
  assert.equal(pins.node.version, V);
  assert.equal(pins.node.codename, 'Krypton');
  assert.equal(pins.node.official, 'https://nodejs.org/dist/' + V + '/');
  assert.equal(pins.node.mirror, 'https://github.com/spendolas/gaffer-ae/releases/download/node-' + V + '/');
});

test('signing identities', () => {
  assert.deepEqual(pins.node.signing, { darwinTeamId: 'HX7739G8FX', windowsSigner: 'OpenJS Foundation' });
});

const expected = {
  'darwin-x64': {
    archive: 'node-v24.22.1-darwin-x64.tar.gz',
    archiveSha256: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
    member: 'node-v24.22.1-darwin-x64/bin/node',
    binaryBytes: 125715808,
    binarySha256: 'cc6f41f72e3eb4460154952e56a35afdd96b6995cea51cd25e637355a2955a51',
  },
  'darwin-arm64': {
    archive: 'node-v24.22.1-darwin-arm64.tar.gz',
    archiveSha256: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
    member: 'node-v24.22.1-darwin-arm64/bin/node',
    binaryBytes: 122545856,
    binarySha256: 'PENDING-FIRST-ACCEPTANCE-RUN',
  },
  'win-x64': {
    archive: 'node-v24.22.1-win-x64.zip',
    archiveSha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
    member: 'node-v24.22.1-win-x64/node.exe',
    binaryBytes: 93915464,
    binarySha256: 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5',
  },
};

test('exactly the three supported platforms', () => {
  assert.deepEqual(Object.keys(pins.node.platforms).sort(), Object.keys(expected).sort());
});

for (const [plat, want] of Object.entries(expected)) {
  test('platform ' + plat + ' equals the spec', () => {
    assert.deepEqual(pins.node.platforms[plat], want);
  });
}

test('every real hash is 64 lowercase hex; the only placeholder is the arm64 binary hash', () => {
  for (const [plat, p] of Object.entries(pins.node.platforms)) {
    assert.match(p.archiveSha256, /^[0-9a-f]{64}$/, plat + ' archiveSha256');
    if (p.binarySha256 === 'PENDING-FIRST-ACCEPTANCE-RUN') assert.equal(plat, 'darwin-arm64');
    else assert.match(p.binarySha256, /^[0-9a-f]{64}$/, plat + ' binarySha256');
  }
});
