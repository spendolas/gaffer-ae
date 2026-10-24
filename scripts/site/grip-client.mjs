// A minimal client for the local Grip daemon (the MCP bridge to Figma, http://127.0.0.1:7778/mcp), for dev
// scripts that read a Figma file. The Grip plugin must be open in the Figma file. Not used by the site.
const DEFAULT_URL = process.env.GRIP_URL || 'http://127.0.0.1:7778/mcp';
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

export async function connectGrip(url = DEFAULT_URL) {
  async function rpc(body, session) {
    const res = await fetch(url, { method: 'POST', headers: { ...HEADERS, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body) });
    const text = await res.text();
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop();
    return { session: res.headers.get('mcp-session-id'), json: data ? JSON.parse(data) : null };
  }
  let init;
  try {
    init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gaffer-site-scripts', version: '1' } } });
  } catch (err) {
    throw new Error(`cannot reach Grip at ${url} (${err.cause?.code ?? err.message}); start the Grip daemon and open the Grip plugin in the Figma file`);
  }
  const session = init.session;
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  let id = 1;
  // call(tool, args) returns the parsed JSON text of the tool's reply (or the raw text when it is not JSON).
  return async function call(tool, args = {}) {
    const r = await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }, session);
    const out = r.json?.result;
    const text = out?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(r.json);
    if (out?.isError) throw new Error(`${tool}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
}
