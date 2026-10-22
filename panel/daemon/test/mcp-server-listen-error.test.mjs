import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcpServer } from '../mcp-server.js';

var queue = { enqueue: async () => '"stub"', isIdle: () => true };

test('starting the MCP server twice on one port rejects with EADDRINUSE', async () => {
  var first = await startMcpServer(0, queue, {});
  var port = first.httpServer.address().port;
  try {
    await assert.rejects(
      () => startMcpServer(port, queue, {}),
      (err) => {
        assert.equal(err.code, 'EADDRINUSE');
        assert.ok(!(err instanceof TypeError));
        return true;
      }
    );
  } finally {
    await new Promise((r) => first.httpServer.close(r));
  }
});
