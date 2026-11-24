// Run from the repo root: node --test scripts/runtime-pins.test.mjs
// Pins panel/daemon/runtime-pins.json to the values in spec section 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pins = JSON.parse(readFileSync(fileURLToPath(new URL('../panel/daemon/runtime-pins.json', import.meta.url)), 'utf8'));
const V = 'v24.22.3';

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
    archive: 'node-v24.22.3-darwin-x64.tar.gz',
    archiveSha256: '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
    member: 'node-v24.22.3-darwin-x64/bin/node',
    binaryBytes: 125755312,
    binarySha256: '796184b9a19ed300b1ba7cd0f7e49558fee9fc0f05080bb036025490a5a2edf3',
  },
  'darwin-arm64': {
    archive: 'node-v24.22.3-darwin-arm64.tar.gz',
    archiveSha256: 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
    member: 'node-v24.22.3-darwin-arm64/bin/node',
    binaryBytes: 122586000,
    binarySha256: 'ba7073582822078d8c90bca3facacc46690bc5366fab4b815aeef9148cd6e854',
  },
  'win-x64': {
    archive: 'node-v24.22.3-win-x64.zip',
    archiveSha256: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
    member: 'node-v24.22.3-win-x64/node.exe',
    binaryBytes: 93944648,
    binarySha256: '86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6',
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
    if (p.binarySha256 === 'ba7073582822078d8c90bca3facacc46690bc5366fab4b815aeef9148cd6e854') assert.equal(plat, 'darwin-arm64');
    else assert.match(p.binarySha256, /^[0-9a-f]{64}$/, plat + ' binarySha256');
  }
});
