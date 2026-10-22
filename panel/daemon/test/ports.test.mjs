import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WS_PORT, MCP_PORT, mcpUrl } from '../ports.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('port values and MCP url', () => {
  assert.equal(WS_PORT, 9823);
  assert.equal(MCP_PORT, 9824);
  assert.equal(mcpUrl(), 'http://127.0.0.1:9824/mcp');
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
