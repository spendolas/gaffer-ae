import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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

/**
 * Creates and starts the MCP HTTP server.
 * Each HTTP session gets its own McpServer instance, but all share
 * the same queue (critical for serialized AE access).
 */
export function startMcpServer(port, queue) {
  var app = express();
  app.use(express.json());

  // Map of active transports by session ID
  var transports = {};

  function createServer() {
    var server = new McpServer(
      { name: 'gaffer', version: '0.1.0' },
      { capabilities: { logging: {} } }
    );

    server.registerTool(
      'runJSX',
      {
        description:
          'Execute ExtendScript in After Effects. Returns the value of the last expression as a string, or a structured error. Use this to inspect project state, read/write layer properties, create layers, set expressions, apply effects.',
        inputSchema: {
          code: z.string().describe('ExtendScript code to execute in After Effects'),
          undoLabel: z.string().optional().describe('Label for the undo group in AE history'),
          aeVersion: z.string().optional().describe('Target AE version when multiple instances are open (e.g. "26.0", "25.6.4"). Omit if only one AE is open.'),
        },
      },
      async ({ code, undoLabel, aeVersion }) => {
        try {
          var result = await queue.enqueue(code, undoLabel, false, aeVersion);
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

    return server;
  }

  // POST /mcp — new session init or existing session messages
  app.post('/mcp', async (req, res) => {
    var sessionId = req.headers['mcp-session-id'];

    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // New session
    var transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
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

  return new Promise((resolve, reject) => {
    var server = app.listen(port, '127.0.0.1', () => {
      console.log(`Gaffer: MCP on http://127.0.0.1:${port}/mcp`);
      resolve(app);
    });
    server.on('error', reject);
  });
}
