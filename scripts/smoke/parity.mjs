#!/usr/bin/env node
// Behavioural parity probe for a running Gaffer daemon (ported from the
// zero-dependency install PoC, CI run 39806281902, proof rows P3/P8).
//
//   node scripts/smoke/parity.mjs --ws-port <n> --mcp-port <n> --out <prefix>
//        [--expect-version <v>] [--expect-tools-sha <hex>] [--expect-jsx-sha <hex>]
//        [--expect-tool-count <n>] [--timeout-check] [--no-auth]
//
// Plays the panel over the WebSocket bridge and an MCP client over Streamable
// HTTP, then asserts:
//   - WS handshake policy: no Origin 101, foreign Origin 403, foreign Host 403
//   - register + share_usage_stats (and auth_status unless --no-auth) replies
//   - MCP foreign Origin / foreign Host 403; initialize with a session id and
//     serverInfo.version == --expect-version
//   - tools/list: count and sha256 of the pretty JSON (written to <prefix>-tools.json)
//   - runJSX through the mock panel: the agent's own undo group is stripped,
//     the "Gaffer: " group and the loop guard are present; sha256 of the exact
//     JSX the daemon sent (written to <prefix>-jsx.txt)
//   - --timeout-check: a runJSX the panel never answers fails with
//     "timed out after 60s" after 55 to 80 s, and the next call still works
//
// The probe code, undo label and mock answers are the PoC's, byte for byte,
// so the hashes compare with P8 (scripts/smoke/parity-baseline.json).
// No dependencies: node:http plus the global WebSocket (Node 22+). Never
// point it at the default ports 9823/9824 (a developer's live daemon).
// Exit 0 when every assertion holds, 1 otherwise; <prefix>-summary.json
// records every step either way.
import http from 'node:http';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROBE_CODE = 'app.beginUndoGroup("agent group");\nvar comp = app.project.activeItem;\nvar a = 1 + 41;\napp.endUndoGroup();\na';
export const PROBE_UNDO_LABEL = 'poc probe';
// A runJSX whose request the mock panel deliberately never answers.
export const NO_ANSWER_MARKER = '__gaffer_smoke_no_answer__';

export function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

export function parseArgs(argv) {
  const o = { auth: true, timeoutCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error('missing value for ' + a); return argv[++i]; };
    if (a === '--ws-port') o.wsPort = Number(next());
    else if (a === '--mcp-port') o.mcpPort = Number(next());
    else if (a === '--out') o.out = next();
    else if (a === '--expect-version') o.expectVersion = next();
    else if (a === '--expect-tools-sha') o.expectToolsSha = next();
    else if (a === '--expect-jsx-sha') o.expectJsxSha = next();
    else if (a === '--expect-tool-count') o.expectToolCount = Number(next());
    else if (a === '--timeout-check') o.timeoutCheck = true;
    else if (a === '--no-auth') o.auth = false;
    else throw new Error('unknown argument ' + a);
  }
  for (const k of ['wsPort', 'mcpPort']) {
    if (!Number.isInteger(o[k]) || o[k] < 1 || o[k] > 65535) throw new Error('--' + k.replace('Port', '-port') + ' must be a port number');
    if (o[k] === 9823 || o[k] === 9824) throw new Error('refusing the default port ' + o[k] + ': it belongs to a live Gaffer daemon');
  }
  if (!o.out) throw new Error('--out <prefix> is required');
  return o;
}

// The pass/fail rules over the recorded steps. Pure, so the decision is
// testable without a daemon. Returns a list of failure strings.
export function evaluate(steps, opts) {
  const f = [];
  const st = (k) => steps[k] || {};
  if (st('ws_no_origin').status !== 101) f.push('WS handshake without Origin did not upgrade (want 101): ' + JSON.stringify(steps.ws_no_origin));
  if (st('ws_evil_origin').status !== 403) f.push('WS handshake with a foreign Origin was not refused (want 403): ' + JSON.stringify(steps.ws_evil_origin));
  if (st('ws_foreign_host').status !== 403) f.push('WS handshake with a foreign Host was not refused (want 403): ' + JSON.stringify(steps.ws_foreign_host));
  if (opts.auth && !(steps.auth_status_reply && steps.auth_status_reply.type === 'auth_status')) f.push('no auth_status reply');
  if (!(steps.share_usage_stats_reply && steps.share_usage_stats_reply.type === 'share_usage_stats')) f.push('no share_usage_stats reply');
  if (st('mcp_evil_origin').status !== 403) f.push('MCP request with a foreign Origin was not refused (want 403)');
  if (st('mcp_foreign_host').status !== 403) f.push('MCP request with a foreign Host was not refused (want 403)');
  const init = st('mcp_initialize');
  if (init.status !== 200 || !init.sessionId) f.push('MCP initialize failed: ' + JSON.stringify(init));
  if (opts.expectVersion && !(init.serverInfo && init.serverInfo.version === opts.expectVersion)) {
    f.push('serverInfo.version ' + JSON.stringify(init.serverInfo && init.serverInfo.version) + ' != ' + opts.expectVersion);
  }
  const list = st('mcp_tools_list');
  if (list.status !== 200 || !(list.count > 0)) f.push('tools/list failed: ' + JSON.stringify({ status: list.status, count: list.count }));
  if (opts.expectToolCount && list.count !== opts.expectToolCount) f.push('tools/list count ' + list.count + ' != ' + opts.expectToolCount);
  if (opts.expectToolsSha && st('tools_sha256').sha256 !== opts.expectToolsSha) f.push('tools/list sha256 ' + st('tools_sha256').sha256 + ' != ' + opts.expectToolsSha);
  const run = st('mcp_runJSX');
  if (run.status !== 200 || !run.result || run.result.isError) f.push('runJSX through the mock panel failed: ' + JSON.stringify(run).slice(0, 300));
  const jsx = st('jsx_captured');
  if (!jsx.captured) f.push('the mock panel never received the runJSX code');
  else {
    if (jsx.agentUndoGroupStripped !== true) f.push("the agent's own undo group reached the panel (must be stripped)");
    if (jsx.gafferUndoGroupPresent !== true) f.push('the "Gaffer: " undo group is missing from the wrapped JSX');
    if (jsx.guardPresent !== true) f.push('the loop guard (__gafferTick) is missing from the wrapped JSX');
    if (opts.expectJsxSha && jsx.sha256 !== opts.expectJsxSha) f.push('runJSX capture sha256 ' + jsx.sha256 + ' != ' + opts.expectJsxSha);
  }
  if (opts.timeoutCheck) {
    const t = st('runjsx_timeout');
    if (!(t.isError === true && /timed out after 60s/.test(String(t.text)))) f.push('unanswered runJSX did not fail with "timed out after 60s": ' + JSON.stringify(t).slice(0, 300));
    else if (!(t.elapsedMs >= 55000 && t.elapsedMs <= 80000)) f.push('unanswered runJSX failed after ' + t.elapsedMs + ' ms (want 55000 to 80000)');
    const after = st('runjsx_after_timeout');
    if (after.status !== 200 || !after.result || after.result.isError) f.push('runJSX after the timeout failed (queue stuck?): ' + JSON.stringify(after).slice(0, 300));
  }
  return f;
}

function rawUpgrade(port, extraHeaders, hostOverride) {
  return new Promise((resolve) => {
    const headers = Object.assign({
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
    }, extraHeaders);
    const opts = { host: '127.0.0.1', port, path: '/', method: 'GET', headers };
    if (hostOverride) { opts.setHost = false; headers.Host = hostOverride; }
    const req = http.request(opts, (res) => { resolve({ status: res.statusCode }); res.resume(); req.destroy(); });
    req.on('upgrade', (res, socket) => { resolve({ status: res.statusCode, upgraded: true }); socket.destroy(); });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(5000, () => { resolve({ error: 'timeout' }); req.destroy(); });
    req.end();
  });
}

function httpPost(port, path, body, headers, hostOverride, timeoutMs) {
  return new Promise((resolve) => {
    const h = Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, headers || {});
    const data = JSON.stringify(body);
    h['Content-Length'] = Buffer.byteLength(data);
    const opts = { host: '127.0.0.1', port, path, method: 'POST', headers: h };
    if (hostOverride) { opts.setHost = false; h.Host = hostOverride; }
    const req = http.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        const ct = String(res.headers['content-type'] || '');
        try {
          if (ct.includes('text/event-stream')) {
            const msgs = buf.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5).trim()));
            json = msgs.length === 1 ? msgs[0] : msgs;
          } else if (buf.trim()) json = JSON.parse(buf);
        } catch (e) { json = { parseError: e.message, raw: buf.slice(0, 500) }; }
        resolve({ status: res.statusCode, contentType: ct, sessionId: res.headers['mcp-session-id'], json, raw: buf });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(timeoutMs || 20000, () => { resolve({ error: 'timeout' }); req.destroy(); });
    req.end(data);
  });
}

export async function runProbe(o) {
  const summary = { wsPort: o.wsPort, mcpPort: o.mcpPort, steps: {} };
  const t0 = Date.now();
  const log = (k, v) => { summary.steps[k] = v; console.log(k + ': ' + JSON.stringify(v)); };
  const WS = o.wsPort, MCP = o.mcpPort;

  // 1. WebSocket handshake policy
  log('ws_no_origin', await rawUpgrade(WS, {}));
  log('ws_evil_origin', await rawUpgrade(WS, { Origin: 'https://evil.example' }));
  log('ws_foreign_host', await rawUpgrade(WS, {}, 'evil.example:' + WS));
  log('ws_null_origin', await rawUpgrade(WS, { Origin: 'null' }));

  // 2. Mock panel: register like panel/main.js
  const ws = new WebSocket('ws://127.0.0.1:' + WS);
  const received = [];
  let capturedJsx = null;
  const waitFor = (pred, ms) => new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const hit = received.find(pred);
      if (hit || Date.now() - start > ms) { clearInterval(iv); resolve(hit || null); }
    }, 25);
  });
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(String(ev.data)); } catch (e) { received.push({ bad: String(ev.data) }); return; }
    received.push(msg);
    if (msg.id && msg.code) {
      if (String(msg.code).indexOf(NO_ANSWER_MARKER) !== -1) return; // the timeout check
      if (capturedJsx === null) capturedJsx = msg.code;
      ws.send(JSON.stringify({ id: msg.id, result: JSON.stringify({ ok: true, result: '42' }) }));
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws error')); });
  ws.send(JSON.stringify({ type: 'register', aeVersion: '99.0' }));
  if (o.auth) ws.send(JSON.stringify({ type: 'auth_status' }));
  ws.send(JSON.stringify({ type: 'get_share_usage_stats' }));
  if (!o.auth) log('auth_status_reply', 'skipped (--no-auth)');
  else log('auth_status_reply', await waitFor((m) => m.type === 'auth_status', 15000));
  log('share_usage_stats_reply', await waitFor((m) => m.type === 'share_usage_stats', 5000));

  // 3. MCP over Streamable HTTP
  log('mcp_evil_origin', (({ status, json }) => ({ status, json }))(await httpPost(MCP, '/mcp', { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }, { Origin: 'https://evil.example' })));
  log('mcp_foreign_host', (({ status, json, raw }) => ({ status, json: json || String(raw || '').slice(0, 200) }))(await httpPost(MCP, '/mcp', { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }, {}, 'evil.example:' + MCP)));
  const init = await httpPost(MCP, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'poc-probe', version: '0' } } });
  const sid = init.sessionId;
  const res = (r) => r.json && r.json.result;
  log('mcp_initialize', { status: init.status, sessionId: !!sid, serverInfo: res(init) && res(init).serverInfo, protocolVersion: res(init) && res(init).protocolVersion });
  log('mcp_initialized_notification', { status: (await httpPost(MCP, '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid })).status });
  const list = await httpPost(MCP, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': sid });
  const tools = res(list) && res(list).tools;
  log('mcp_tools_list', { status: list.status, count: tools ? tools.length : null, names: tools ? tools.map((t) => t.name) : null });
  const toolsText = JSON.stringify(tools, null, 2) + '\n';
  fs.writeFileSync(o.out + '-tools.json', toolsText);
  log('tools_sha256', { sha256: sha256(toolsText), bytes: Buffer.byteLength(toolsText) });

  const call = await httpPost(MCP, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'runJSX', arguments: { code: PROBE_CODE, undoLabel: PROBE_UNDO_LABEL } } }, { 'mcp-session-id': sid });
  log('mcp_runJSX', { status: call.status, result: res(call) });
  fs.writeFileSync(o.out + '-jsx.txt', capturedJsx == null ? '(nothing captured)\n' : capturedJsx);
  log('jsx_captured', { captured: capturedJsx != null, length: capturedJsx ? capturedJsx.length : 0,
    sha256: capturedJsx ? sha256(capturedJsx) : null,
    agentUndoGroupStripped: capturedJsx ? !/beginUndoGroup\("agent group"\)/.test(capturedJsx) : null,
    gafferUndoGroupPresent: capturedJsx ? /app\.beginUndoGroup\("Gaffer: /.test(capturedJsx) : null,
    guardPresent: capturedJsx ? /__gafferTick/.test(capturedJsx) : null });

  // A typed read-only tool through the mock panel as well (informational).
  const proj = await httpPost(MCP, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'getProjectSummary', arguments: {} } }, { 'mcp-session-id': sid });
  log('mcp_getProjectSummary', { status: proj.status, isError: res(proj) && res(proj).isError, textHead: res(proj) && res(proj).content && String(res(proj).content[0].text).slice(0, 120) });

  if (o.timeoutCheck) {
    const t1 = Date.now();
    const slow = await httpPost(MCP, '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'runJSX', arguments: { code: '"' + NO_ANSWER_MARKER + '"', undoLabel: 'smoke timeout' } } }, { 'mcp-session-id': sid }, null, 120000);
    const r = res(slow);
    log('runjsx_timeout', { status: slow.status, elapsedMs: Date.now() - t1, isError: r && r.isError, text: r && r.content && String(r.content[0].text).slice(0, 200), error: slow.error });
    const again = await httpPost(MCP, '/mcp', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'runJSX', arguments: { code: '1 + 1', undoLabel: 'smoke after timeout' } } }, { 'mcp-session-id': sid });
    log('runjsx_after_timeout', { status: again.status, result: res(again) });
  }

  const del = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: MCP, path: '/mcp', method: 'DELETE', headers: { 'mcp-session-id': sid } }, (r) => { resolve(r.statusCode); r.resume(); });
    req.on('error', (e) => resolve('err ' + e.message)); req.end();
  });
  log('mcp_session_delete', { status: del });
  ws.close();
  summary.elapsedMs = Date.now() - t0;
  summary.nodeVersion = process.version;
  summary.execPath = process.execPath;
  return summary;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error('parity: ' + e.message); process.exit(2); }
  let summary;
  try { summary = await runProbe(o); }
  catch (e) {
    console.error('parity: probe failed: ' + (e && e.stack || e));
    fs.writeFileSync(o.out + '-summary.json', JSON.stringify({ fatal: String(e) }, null, 2) + '\n');
    process.exit(1);
  }
  const failures = evaluate(summary.steps, o);
  summary.failures = failures;
  fs.writeFileSync(o.out + '-summary.json', JSON.stringify(summary, null, 2) + '\n');
  console.log('tools/list sha256 ' + summary.steps.tools_sha256.sha256 + ' (' + summary.steps.tools_sha256.bytes + ' bytes, ' + summary.steps.mcp_tools_list.count + ' tools)');
  console.log('runJSX capture sha256 ' + summary.steps.jsx_captured.sha256 + ' (' + summary.steps.jsx_captured.length + ' bytes)');
  if (failures.length) {
    failures.forEach((x) => console.log('FAIL ' + x));
    console.log('parity: ' + failures.length + ' failure(s) in ' + summary.elapsedMs + ' ms');
    setTimeout(() => process.exit(1), 200);
  } else {
    console.log('parity: all checks passed in ' + summary.elapsedMs + ' ms');
    setTimeout(() => process.exit(0), 200);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
