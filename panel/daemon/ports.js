// Single source for the daemon's loopback ports and MCP URL.
export const WS_PORT = 9823;
export const MCP_PORT = 9824;
export function mcpUrl() {
  return 'http://127.0.0.1:' + MCP_PORT + '/mcp';
}
