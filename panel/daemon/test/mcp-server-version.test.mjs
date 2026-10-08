import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, readGafferVersion } from '../mcp-server.js';

// The MCP handshake must report the real Gaffer version (panel/version.json),
// never a hardcoded placeholder. Ephemeral port, queue stub, no AE.
var expected = JSON.parse(readFileSync(new URL('../../version.json', import.meta.url), 'utf-8')).version;

test('readGafferVersion reads panel/version.json next to the daemon folder', () => {
  assert.equal(readGafferVersion(), expected);
  assert.match(expected, /^\d+\.\d+\.\d+/);
});

test('readGafferVersion falls back to unknown on any read or parse problem', () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-ver-'));
  assert.equal(readGafferVersion(join(dir, 'missing.json')), 'unknown');
  writeFileSync(join(dir, 'bad.json'), '{not json');
  assert.equal(readGafferVersion(join(dir, 'bad.json')), 'unknown');
  writeFileSync(join(dir, 'no-version.json'), JSON.stringify({ commit: 'abc' }));
  assert.equal(readGafferVersion(join(dir, 'no-version.json')), 'unknown');
  writeFileSync(join(dir, 'blank.json'), JSON.stringify({ version: '  ' }));
  assert.equal(readGafferVersion(join(dir, 'blank.json')), 'unknown');
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ version: '1.2.3', commit: 'abc' }));
  assert.equal(readGafferVersion(join(dir, 'ok.json')), '1.2.3');
});

test('MCP initialize reports the Gaffer version as serverInfo.version', async () => {
  var queue = { enqueue: async () => '"stub"', isIdle: () => true };
  var app = await startMcpServer(0, queue, {});
  after(() => new Promise((r) => app.httpServer.close(r)));
  var url = new URL('http://127.0.0.1:' + app.httpServer.address().port + '/mcp');
  var client = new Client({ name: 'version-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    var info = client.getServerVersion();
    assert.equal(info.name, 'gaffer');
    assert.equal(info.version, expected);
    assert.notEqual(info.version, '0.1.0');
  } finally {
    await client.close();
  }
});
