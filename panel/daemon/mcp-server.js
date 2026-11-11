import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { closeToolInputs } from './closed-object.js';
import { register as registerProjectSummary } from './tools/projectSummary.js';
import { register as registerEffectMatchNames } from './tools/effectMatchNames.js';
import { register as registerCaptureActiveComp } from './tools/captureActiveComp.js';
import { register as registerImportFromFigma } from './tools/importFromFigma.js';
import { register as registerListFonts } from './tools/listFonts.js';
import { register as registerListCompositions } from './tools/listCompositions.js';
import { register as registerGetSelectedLayers } from './tools/getSelectedLayers.js';
import { register as registerListFootage } from './tools/listFootage.js';
import { register as registerListExpressions } from './tools/listExpressions.js';
import { register as registerListExpressionControls } from './tools/listExpressionControls.js';
import { register as registerGetRenderQueue } from './tools/getRenderQueue.js';
import { register as registerGetLayerKeyframes } from './tools/getLayerKeyframes.js';
import { register as registerFindLayers } from './tools/findLayers.js';
import { register as registerWhereUsed } from './tools/whereUsed.js';
import { register as registerCaptureFrame } from './tools/captureFrame.js';
import { register as registerCaptureLayer } from './tools/captureLayer.js';
import { register as registerRelinkFootage } from './tools/relinkFootage.js';
import { register as registerAddToRenderQueue } from './tools/addToRenderQueue.js';
import { register as registerListMarkers } from './tools/listMarkers.js';
import { register as registerListTextLayers } from './tools/listTextLayers.js';
import { register as registerGetLayerEffects } from './tools/getLayerEffects.js';
import { register as registerGetShapeContents } from './tools/getShapeContents.js';
import { register as registerGetProjectTree } from './tools/getProjectTree.js';
import { register as registerGetProjectSettings } from './tools/getProjectSettings.js';
import { register as registerRunJSXLoop } from './tools/runJSXLoop.js';
import { preflight, guardEnabled } from './instrument.js';
import { wrapInSafety } from './safety.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The Gaffer version the MCP handshake reports as serverInfo.version: the
// panel's version.json next to this daemon folder (stamped by the release
// build). Any problem reading it yields 'unknown'; this must never throw at
// startup. Exported for the unit test.
export function readGafferVersion(versionJsonPath) {
  try {
    var p = versionJsonPath || fileURLToPath(new URL('../version.json', import.meta.url));
    var v = JSON.parse(readFileSync(p, 'utf-8')).version;
    return typeof v === 'string' && v.trim() ? v.trim() : 'unknown';
  } catch (e) {
    return 'unknown';
  }
}
var GAFFER_VERSION = readGafferVersion();

// Compact, opt-out telemetry for the loop guard: log only when there is a loop,
// a parse problem, or a rejection, so it stays quiet for ordinary calls.
function logGuard(tool, telemetry, action) {
  if (!telemetry) return;
  if (telemetry.hasLoop || telemetry.parseError || action === 'reject') {
    console.log('[loopguard] ' + tool + ' ' + action + ' ' + JSON.stringify(telemetry));
  }
}

// A browser web page always sends an http(s) Origin on cross-site requests;
// MCP clients send none. Exported so the policy can be unit-tested.
export function rejectBrowserOrigin(req, res, next) {
  var origin = req.headers.origin;
  if (origin && /^https?:\/\//i.test(String(origin))) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Browser origins are not allowed: ' + origin },
      id: null,
    });
    return;
  }
  next();
}

// Final Express error handler: a JSON-RPC error with a fixed message, never
// the error's own text, stack or file paths (those go to the daemon log only).
// 4xx errors from the body parser keep their status.
export function mcpErrorHandler(err, req, res, next) {
  // The log keeps the first lines of the stack for diagnosis; the response
  // below never carries any of it.
  console.error('Gaffer: MCP request error:', err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : (err && err.message) || 'unknown');
  if (res.headersSent) { next(err); return; }
  var status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  var code = -32603;
  var message = 'Internal error';
  if (status !== 500) {
    code = err.type === 'entity.parse.failed' ? -32700 : -32600;
    message = code === -32700 ? 'Parse error' : status === 413 ? 'Request too large' : 'Invalid request';
  }
  res.status(status).json({ jsonrpc: '2.0', error: { code: code, message: message }, id: null });
}

// Session bookkeeping (ctx overrides exist for tests). One daemon serves a few
// long-lived MCP clients (Claude Code, Hub) plus one short-lived session per
// panel chat turn, and none of them can be told apart from the server side.
// So the rules never touch a live client:
//   - a session with a request in flight or an open event stream is never
//     evicted or expired (an open stream means the client is still there);
//   - over the cap, only sessions idle for at least sessionEvictMinIdleMs are
//     eviction candidates, least recently used first; if none qualifies the
//     cap is simply exceeded for a while;
//   - a session idle (no request, no stream) for sessionIdleMs is closed.
// The cap is high and the expiry long: sessions are small, and an MCP client
// that finds its session gone has to re-initialize.
export var MCP_SESSION_DEFAULTS = {
  maxSessions: 256,
  sessionIdleMs: 12 * 60 * 60 * 1000,
  sessionEvictMinIdleMs: 5 * 60 * 1000,
  sessionSweepMs: 60 * 1000,
};

/**
 * Creates and starts the MCP HTTP server.
 * Each HTTP session gets its own McpServer instance, but all share
 * the same queue (critical for serialized AE access).
 */
export function startMcpServer(port, queue, ctx) {
  ctx = ctx || {};
  var app = express();

  // DNS-rebinding protection, ahead of the body parser so a refused request
  // is never parsed. The server only binds 127.0.0.1, so the only way a
  // remote page reaches it is a browser whose DNS resolved some other
  // hostname to loopback: that request carries the foreign Host and an
  // http(s) Origin. The SDK middleware checks the Host hostname (port-agnostic:
  // 127.0.0.1, localhost, [::1]); the second check refuses any web-page Origin,
  // since no legitimate client (Claude Code, Claude Hub, the daemon's own chat
  // spawn) is a browser page and none sends one.
  app.use(hostHeaderValidation(['127.0.0.1', 'localhost', '[::1]']));
  app.use(rejectBrowserOrigin);
  app.use(express.json());

  // Map of active transports by session ID, with the last time each was used
  var transports = {};
  var lastSeen = {};
  var inFlight = {};
  var maxSessions = ctx.maxSessions != null ? ctx.maxSessions : MCP_SESSION_DEFAULTS.maxSessions;
  var sessionIdleMs = ctx.sessionIdleMs != null ? ctx.sessionIdleMs : MCP_SESSION_DEFAULTS.sessionIdleMs;
  var evictMinIdleMs = ctx.sessionEvictMinIdleMs != null ? ctx.sessionEvictMinIdleMs : MCP_SESSION_DEFAULTS.sessionEvictMinIdleMs;
  var sessionSweepMs = ctx.sessionSweepMs != null ? ctx.sessionSweepMs : MCP_SESSION_DEFAULTS.sessionSweepMs;

  function touch(sid) { lastSeen[sid] = Date.now(); }
  // Count a request (or an event stream) as in flight until its response ends.
  function track(sid, res) {
    inFlight[sid] = (inFlight[sid] || 0) + 1;
    var done = false;
    var end = function () {
      if (done) return;
      done = true;
      inFlight[sid] = Math.max(0, (inFlight[sid] || 1) - 1);
      touch(sid);
    };
    res.on('close', end);
    res.on('finish', end);
  }
  function dropSession(sid) {
    var t = transports[sid];
    delete transports[sid];
    delete lastSeen[sid];
    delete inFlight[sid];
    if (t) { try { t.close(); } catch (e) { /* already closed */ } }
  }
  function idleFor(sid, now) { return (inFlight[sid] ? 0 : now - (lastSeen[sid] || 0)); }
  function enforceSessionCap() {
    var ids = Object.keys(transports);
    if (ids.length <= maxSessions) return;
    var now = Date.now();
    var candidates = ids.filter(function (sid) { return !inFlight[sid] && idleFor(sid, now) >= evictMinIdleMs; });
    candidates.sort(function (a, b) { return (lastSeen[a] || 0) - (lastSeen[b] || 0); });
    for (var i = 0; i < candidates.length && Object.keys(transports).length > maxSessions; i++) dropSession(candidates[i]);
  }
  var sweepTimer = setInterval(function () {
    var now = Date.now();
    Object.keys(transports).forEach(function (sid) {
      if (!inFlight[sid] && now - (lastSeen[sid] || 0) > sessionIdleMs) dropSession(sid);
    });
  }, sessionSweepMs);
  if (sweepTimer.unref) sweepTimer.unref();

  function createServer() {
    var server = new McpServer(
      { name: 'gaffer', version: GAFFER_VERSION },
      { capabilities: { logging: {} } }
    );
    closeToolInputs(server, z);

    server.registerTool(
      'runJSX',
      {
        description:
          'Execute a SMALL, one-shot ExtendScript in After Effects: reads, inspecting state, or a single quick edit (one or a few layers, properties, expressions, effects). Returns the last expression value as a string, or a structured error. Do NOT use this for bulk or iterative work — a script that loops over many layers/keyframes/precomps/footage runs synchronously on AE\'s single UI thread and FREEZES the app until it finishes (no progress, no cancel, and it can outlast the 60s timeout). For anything that loops or touches many items, use runJSXLoop instead: it portions the work into short time-bounded slices so AE stays responsive, shows progress, and is cancellable, at ~no extra total time.',
        inputSchema: {
          code: z.string().describe('ExtendScript code to execute in After Effects'),
          undoLabel: z.string().optional().describe('Label for the undo group in AE history'),
          aeVersion: z.string().optional().describe('Target AE version when multiple instances are open (e.g. "26.0", "25.6.4"). Omit if only one AE is open.'),
        },
      },
      async ({ code, undoLabel, aeVersion }) => {
        try {
          // Loop guard: reject a provably-infinite loop up front; otherwise run
          // the instrumented source so any loop self-aborts instead of freezing AE.
          var pf = preflight(code, { asExpression: false });
          logGuard('runJSX', pf.telemetry, pf.action);
          if (pf.action === 'reject') {
            return {
              content: [{ type: 'text', text: JSON.stringify({ ok: false, error: pf.message }) }],
              isError: true,
            };
          }
          var wrapped = wrapInSafety(pf.code, undoLabel, false, { guard: guardEnabled });
          var result = await queue.enqueuePreWrapped(wrapped, aeVersion);
          return { content: [{ type: 'text', text: result }] };
        } catch (e) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }],
            isError: true,
          };
        }
      }
    );

    registerProjectSummary(server, queue, z);
    registerEffectMatchNames(server, queue, z);
    registerCaptureActiveComp(server, queue, z);
    registerImportFromFigma(server, queue, z);
    registerListFonts(server, queue, z);
    registerListCompositions(server, queue, z);
    registerGetSelectedLayers(server, queue, z);
    registerListFootage(server, queue, z);
    registerListExpressions(server, queue, z);
    registerListExpressionControls(server, queue, z);
    registerGetRenderQueue(server, queue, z);
    registerGetLayerKeyframes(server, queue, z);
    registerFindLayers(server, queue, z);
    registerWhereUsed(server, queue, z);
    registerCaptureFrame(server, queue, z);
    registerCaptureLayer(server, queue, z);
    registerRelinkFootage(server, queue, z);
    registerAddToRenderQueue(server, queue, z);
    registerListMarkers(server, queue, z);
    registerListTextLayers(server, queue, z);
    registerGetLayerEffects(server, queue, z);
    registerGetShapeContents(server, queue, z);
    registerGetProjectTree(server, queue, z);
    registerGetProjectSettings(server, queue, z);
    registerRunJSXLoop(server, queue, z, ctx);

    return server;
  }

  // POST /mcp — new session init or existing session messages
  app.post('/mcp', async (req, res) => {
    var sessionId = req.headers['mcp-session-id'];

    if (sessionId && transports[sessionId]) {
      touch(sessionId);
      track(sessionId, res);
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // New session
    var transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
        touch(sid);
        enforceSessionCap();
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        delete lastSeen[transport.sessionId];
        delete inFlight[transport.sessionId];
      }
    };

    var server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET /mcp — SSE stream for session
  app.get('/mcp', async (req, res) => {
    var sessionId = req.headers['mcp-session-id'];
    if (sessionId && transports[sessionId]) {
      touch(sessionId);
      track(sessionId, res);
      await transports[sessionId].handleRequest(req, res);
    } else {
      res.status(400).json({ error: 'Invalid or missing session ID' });
    }
  });

  // DELETE /mcp — close session
  app.delete('/mcp', async (req, res) => {
    var sessionId = req.headers['mcp-session-id'];
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
    } else {
      res.status(400).json({ error: 'Invalid or missing session ID' });
    }
  });

  // Last: any error from the middleware or handlers above.
  app.use(mcpErrorHandler);

  app.mcpSessionCount = function () { return Object.keys(transports).length; };

  return new Promise((resolve, reject) => {
    // Express 5 passes a listen error to this callback (and the server also
    // emits 'error'); reject here so EADDRINUSE reaches the caller instead of
    // throwing a TypeError on server.address() == null.
    var server = app.listen(port, '127.0.0.1', (err) => {
      if (err) return reject(err);
      var addr = server.address();
      console.log('Gaffer: MCP on http://' + addr.address + ':' + addr.port + '/mcp');
      app.httpServer = server; // lets a test instance (port 0) read its port and close
      server.on('close', function () { clearInterval(sweepTimer); });
      resolve(app);
    });
    server.on('error', reject);
  });
}
