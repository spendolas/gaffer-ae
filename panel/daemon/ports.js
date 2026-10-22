// Single source for the daemon's loopback ports and MCP URL.
//
// GAFFER_WS_PORT / GAFFER_MCP_PORT override the defaults, so the CI smoke
// harness (scripts/smoke/) can start a packaged daemon next to a developer's
// running one without colliding. An override is honoured only when it is a
// plain decimal integer from 1 to 65535; anything else (empty, "abc", "0",
// "9824x", "70000") is ignored and the default stays.
export const DEFAULT_WS_PORT = 9823;
export const DEFAULT_MCP_PORT = 9824;

export function resolvePort(raw, fallback) {
  if (typeof raw !== 'string' || !/^[0-9]{1,5}$/.test(raw)) return fallback;
  var n = Number(raw);
  return n >= 1 && n <= 65535 ? n : fallback;
}

export const WS_PORT = resolvePort(process.env.GAFFER_WS_PORT, DEFAULT_WS_PORT);
export const MCP_PORT = resolvePort(process.env.GAFFER_MCP_PORT, DEFAULT_MCP_PORT);
export function mcpUrl() {
  return 'http://127.0.0.1:' + MCP_PORT + '/mcp';
}
