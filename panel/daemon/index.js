import { PanelBridge } from './panel-bridge.js';
import { Queue } from './queue.js';
import { startMcpServer } from './mcp-server.js';
import { ChatHandler } from './chat-handler.js';

var WS_PORT = 9823;
var MCP_PORT = 9824;

var bridge = new PanelBridge(WS_PORT);

// Handle port conflicts — if daemon is already running, exit gracefully
bridge.start().catch((err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Gaffer: port ' + WS_PORT + ' in use — daemon already running. Exiting.');
    process.exit(0);
  }
  console.error('Gaffer: failed to start panel bridge', err);
  process.exit(1);
});

var chatHandler = new ChatHandler();
bridge.onChat = (msg, socket) => chatHandler.handleChat(msg, socket);
bridge.onChatCancel = () => chatHandler.cancel();

var queue = new Queue(bridge);

startMcpServer(MCP_PORT, queue).catch((err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Gaffer: port ' + MCP_PORT + ' in use — daemon already running. Exiting.');
    process.exit(0);
  }
  console.error('Gaffer: failed to start MCP server', err);
  process.exit(1);
});

console.log(
  `Gaffer daemon: MCP on http://127.0.0.1:${MCP_PORT}/mcp, panel bridge on ws://127.0.0.1:${WS_PORT}`
);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nGaffer: shutting down');
  chatHandler.cancel();
  bridge.stop();
  process.exit(0);
});
