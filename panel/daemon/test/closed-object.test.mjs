import './isolate-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closedObject, closeToolInputs } from '../closed-object.js';
import { register as registerImportFromFigma } from '../tools/importFromFigma.js';

// zod 4 leaves additionalProperties off a plain z.object; the tools/list
// contract (zod 3 era) advertised every object as closed. These pin that.

async function listAndClient() {
  const server = closeToolInputs(new McpServer({ name: 't', version: '0' }), z);
  server.registerTool('echo', { description: 'e', inputSchema: { code: z.string(), n: z.number().optional() } },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }));
  registerImportFromFigma(server, { enqueue: async () => 'ok' }, z);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(b);
  return { client, tools: (await client.listTools()).tools };
}

function everyObjectClosed(node, path, out) {
  if (Array.isArray(node)) { node.forEach((n, i) => everyObjectClosed(n, path + '[' + i + ']', out)); return out; }
  if (node && typeof node === 'object') {
    if (node.type === 'object' && node.additionalProperties !== false) out.push(path);
    for (const k of Object.keys(node)) everyObjectClosed(node[k], path + '.' + k, out);
  }
  return out;
}

test('closedObject advertises additionalProperties:false but still strips unknown keys', () => {
  const s = closedObject(z, { a: z.string() });
  assert.equal(z.toJSONSchema(s, { io: 'input' }).additionalProperties, false);
  assert.deepEqual(s.parse({ a: 'x', extra: 1 }), { a: 'x' });
});

test('tools/list: every object in a raw-shape tool and in importFromFigma is closed', async () => {
  const { client, tools } = await listAndClient();
  try {
    assert.deepEqual(tools.map((t) => t.name).sort(), ['echo', 'importFromFigma']);
    for (const t of tools) assert.deepEqual(everyObjectClosed(t.inputSchema, t.name, []), [], t.name);
    const fig = tools.find((t) => t.name === 'importFromFigma').inputSchema;
    assert.deepEqual(fig.required, ['layers']);
    const layer = fig.definitions[fig.properties.layers.items.$ref.split('/').pop()];
    assert.deepEqual(layer.properties.children.items, fig.properties.layers.items, 'children recurse to the layer schema directly');
    assert.deepEqual(layer.properties.type.enum, ['RECTANGLE', 'ELLIPSE', 'PATH', 'TEXT', 'FRAME', 'GROUP']);
  } finally { await client.close(); }
});

test('tool calls: unknown keys stripped, missing required field rejected', async () => {
  const { client } = await listAndClient();
  try {
    const ok = await client.callTool({ name: 'echo', arguments: { code: 'x', extra: 1 } });
    assert.equal(ok.content[0].text, '{"code":"x"}');
    const bad = await client.callTool({ name: 'echo', arguments: { n: 1 } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Input validation error/);
  } finally { await client.close(); }
});
