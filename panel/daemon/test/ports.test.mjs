import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WS_PORT, MCP_PORT, DEFAULT_WS_PORT, DEFAULT_MCP_PORT, mcpUrl, resolvePort, portsFromEnv } from '../ports.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('port values and MCP url', () => {
  assert.equal(DEFAULT_WS_PORT, 9823);
  assert.equal(DEFAULT_MCP_PORT, 9824);
  // The suite itself may run under a port override (never in practice, but
  // the assertion must not depend on the caller's shell).
  const expect = portsFromEnv(process.env);
  assert.equal(WS_PORT, expect.ws);
  assert.equal(MCP_PORT, expect.mcp);
  assert.equal(mcpUrl(), 'http://127.0.0.1:' + MCP_PORT + '/mcp');
});

test('resolvePort honours only a plain integer from 1 to 65535', () => {
  assert.equal(resolvePort(undefined, 9823), 9823);
  assert.equal(resolvePort('', 9823), 9823);
  assert.equal(resolvePort('27831', 9823), 27831);
  assert.equal(resolvePort('1', 9823), 1);
  assert.equal(resolvePort('65535', 9823), 65535);
  for (const bad of ['0', '65536', '70000', 'abc', '9824x', ' 9824', '9824 ', '-1', '1e4', '0x10', '12.5', '123456', '09824', '00080', '+9824']) {
    assert.equal(resolvePort(bad, 9823), 9823, 'should ignore ' + JSON.stringify(bad));
  }
});

test('portsFromEnv: the overrides count only next to GAFFER_TEST=1 (never in production)', () => {
  assert.deepEqual(portsFromEnv({ GAFFER_WS_PORT: '27831', GAFFER_MCP_PORT: '27832' }), { ws: 9823, mcp: 9824 });
  assert.deepEqual(portsFromEnv({ GAFFER_TEST: 'true', GAFFER_WS_PORT: '27831', GAFFER_MCP_PORT: '27832' }), { ws: 9823, mcp: 9824 });
  assert.deepEqual(portsFromEnv({ GAFFER_TEST: '1', GAFFER_WS_PORT: '27831', GAFFER_MCP_PORT: '27832' }), { ws: 27831, mcp: 27832 });
  assert.deepEqual(portsFromEnv({ GAFFER_TEST: '1', GAFFER_WS_PORT: 'nope' }), { ws: 9823, mcp: 9824 });
  assert.deepEqual(portsFromEnv(undefined), { ws: 9823, mcp: 9824 });
});

test('GAFFER_WS_PORT / GAFFER_MCP_PORT reach the exported ports and mcpUrl() (with GAFFER_TEST=1 only)', () => {
  const url = pathToFileURL(fileURLToPath(new URL('../ports.js', import.meta.url))).href;
  const script = "import(" + JSON.stringify(url) + ").then(m => console.log(JSON.stringify([m.WS_PORT, m.MCP_PORT, m.mcpUrl()])))";
  const run = (env) => JSON.parse(execFileSync(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, { GAFFER_TEST: '', GAFFER_WS_PORT: '', GAFFER_MCP_PORT: '' }, env),
    encoding: 'utf8', windowsHide: true,
  }));
  assert.deepEqual(run({ GAFFER_TEST: '1', GAFFER_WS_PORT: '27831', GAFFER_MCP_PORT: '27832' }), [27831, 27832, 'http://127.0.0.1:27832/mcp']);
  assert.deepEqual(run({ GAFFER_WS_PORT: '27831', GAFFER_MCP_PORT: '27832' }), [9823, 9824, 'http://127.0.0.1:9824/mcp'], 'ignored without GAFFER_TEST=1');
  assert.deepEqual(run({ GAFFER_TEST: '1', GAFFER_WS_PORT: 'nope', GAFFER_MCP_PORT: '99999' }), [9823, 9824, 'http://127.0.0.1:9824/mcp']);
  assert.deepEqual(run({}), [9823, 9824, 'http://127.0.0.1:9824/mcp']);
});

test('chat-handler builds --mcp-config from mcpUrl(), no hardcoded port', () => {
  const src = read('../chat-handler.js');
  assert.ok(/import \{[^}]*\bmcpUrl\b[^}]*\} from '\.\/ports\.js'/.test(src), 'chat-handler must import mcpUrl');
  assert.ok(src.includes('url: mcpUrl()'), 'mcp-config must use mcpUrl()');
  assert.ok(!src.includes('9824'), 'no hardcoded 9824 in chat-handler');
});

test('index.js takes ports from ports.js', () => {
  const src = read('../index.js');
  assert.ok(src.includes("from './ports.js'"));
  assert.ok(!/var (WS|MCP)_PORT = 98/.test(src));
});
