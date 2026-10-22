// Single source for the daemon's loopback ports and MCP URL.
//
// GAFFER_WS_PORT / GAFFER_MCP_PORT override the defaults, so the CI smoke
// harness (scripts/smoke/) can start a packaged daemon next to a developer's
// running one without colliding. Test seam only: honoured only when
// GAFFER_TEST=1 is also set (the panel's launch passes its environment
// through, and a stray variable there must never move a real daemon off the
// ports the panel and Claude connect to). An override is honoured only when
// it is a plain decimal integer from 1 to 65535; anything else (empty, "abc",
// "0", "09824", "9824x", "70000") is ignored and the default stays.
export const DEFAULT_WS_PORT = 9823;
export const DEFAULT_MCP_PORT = 9824;

export function resolvePort(raw, fallback) {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,4}$/.test(raw)) return fallback;
  var n = Number(raw);
  return n >= 1 && n <= 65535 ? n : fallback;
}

export function portsFromEnv(env) {
  var e = env || {};
  if (e.GAFFER_TEST !== '1') return { ws: DEFAULT_WS_PORT, mcp: DEFAULT_MCP_PORT };
  return { ws: resolvePort(e.GAFFER_WS_PORT, DEFAULT_WS_PORT), mcp: resolvePort(e.GAFFER_MCP_PORT, DEFAULT_MCP_PORT) };
}

var PORTS = portsFromEnv(process.env);
export const WS_PORT = PORTS.ws;
export const MCP_PORT = PORTS.mcp;
export function mcpUrl() {
  return 'http://127.0.0.1:' + MCP_PORT + '/mcp';
}
