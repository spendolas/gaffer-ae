import { PanelBridge } from './panel-bridge.js';
import { Queue } from './queue.js';
import { startMcpServer } from './mcp-server.js';

var WS_PORT = 9823;
var MCP_PORT = 9824;

var bridge = new PanelBridge(WS_PORT);
bridge.start();

var queue = new Queue(bridge);
startMcpServer(MCP_PORT, queue);

console.log(
  `Gaffer daemon: MCP on http://127.0.0.1:${MCP_PORT}/mcp, panel bridge on ws://127.0.0.1:${WS_PORT}`
);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nGaffer: shutting down');
  bridge.stop();
  process.exit(0);
});
