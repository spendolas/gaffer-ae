import { spawn, execFile } from 'node:child_process';
import { findClaudeBinary } from './claude-binary.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

var GAFFER_TOOLS = [
  'mcp__gaffer__runJSX',
  'mcp__gaffer__getProjectSummary',
  'mcp__gaffer__listEffectMatchNames',
  'mcp__gaffer__captureActiveComp',
  'mcp__gaffer__importFromFigma',
  'mcp__gaffer__listFonts',
  'mcp__gaffer__listCompositions',
  'mcp__gaffer__getSelectedLayers',
  'mcp__gaffer__listFootage',
  'mcp__gaffer__listExpressions',
  'mcp__gaffer__listExpressionControls',
  'mcp__gaffer__getRenderQueue',
  'mcp__gaffer__getLayerKeyframes',
  'mcp__gaffer__findLayers',
  'mcp__gaffer__whereUsed',
  'mcp__gaffer__captureFrame',
  'mcp__gaffer__captureLayer',
  'mcp__gaffer__relinkFootage',
  'mcp__gaffer__addToRenderQueue',
];

// Build a human-readable label for tool pills. Strips mcp__gaffer__ prefix
// and appends a hint from the tool's input args.
function shortToolLabel(name, input) {
  var n = (name || 'tool').replace(/^mcp__gaffer__/, '');
  if (!input || typeof input !== 'object') return n;

  var hint = '';
  if (typeof input.undoLabel === 'string' && input.undoLabel) {
    hint = input.undoLabel;
  } else if (typeof input.code === 'string' && input.code) {
    hint = input.code.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
  } else if (typeof input.category === 'string' && input.category) {
    hint = input.category;
  } else if (Array.isArray(input.layers)) {
    hint = input.layers.length + ' layers';
  }
  return hint ? n + ': ' + hint : n;
}

export class ChatHandler {
  constructor() {
    this.activeProcess = null;
    this.sessionId = null;
  }

  async handleChat(msg, socket) {
    this.cancel();
    this._lastEmit = null;
    this._toolNames = {};

    try {
      var claudeBin = await findClaudeBinary();
    } catch (e) {
      socket.send(JSON.stringify({ type: 'chat_error', error: e.message }));
      return;
    }

    var promptPath = join(__dirname, '..', 'prompts', 'gaffer.md');
    var systemPrompt;
    try {
      systemPrompt = readFileSync(promptPath, 'utf-8');
    } catch (e) {
      socket.send(JSON.stringify({ type: 'chat_error', error: 'gaffer.md not found: ' + promptPath }));
      return;
    }

    // If panel reported its AE version, inject it so Claude routes tool calls correctly
    if (msg.aeVersion) {
      systemPrompt += '\n\n## Connected AE\n\nYou are connected to After Effects ' + msg.aeVersion + '. When calling Gaffer tools that accept an aeVersion parameter, pass "' + msg.aeVersion + '". This routes the call to the correct AE instance.\n';
    }

    var model = msg.model || 'opus';
    var args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];

    // Build allowedTools for every call so MCP toggle changes apply
    // immediately, even on resumed sessions.
    var enabled = Array.isArray(msg.enabledMcps) ? msg.enabledMcps.filter(Boolean) : [];
    var extra = enabled.map(function (id) {
      // Claude transforms server names to tool prefixes: spaces/dots/dashes → underscores
      return 'mcp__' + id.replace(/[\s.\-]/g, '_') + '__*';
    });
    var allowed = GAFFER_TOOLS.concat(extra).join(',');
    args.push('--allowedTools', allowed);
    console.log('Gaffer chat args: enabledMcps=' + JSON.stringify(enabled) + ' allowed=' + allowed);

    var sessionId = msg.sessionId || this.sessionId;
    if (sessionId) {
      args.push('--resume', sessionId);
      this.sessionId = sessionId;
    } else {
      // New conversation also gets the system prompt
      args.push('--append-system-prompt', systemPrompt);
    }

    // Augment PATH so claude can spawn stdio MCP servers (e.g. grip uses
    // bare `node`). Daemon launched from CEP panel may have minimal PATH.
    var extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
    var currentPath = process.env.PATH || '';
    var pathParts = currentPath.split(':');
    for (var p of extraPaths) {
      if (pathParts.indexOf(p) === -1) pathParts.push(p);
    }
    var augmentedEnv = { ...process.env, PATH: pathParts.join(':') };
    console.log('Gaffer chat PATH: ' + augmentedEnv.PATH);

    var child = spawn(claudeBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: augmentedEnv,
    });
    this.activeProcess = child;

    child.stdin.write(msg.message);
    child.stdin.end();

    var buffer = '';
    var lastText = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      var lines = buffer.split('\n');
      buffer = lines.pop();

      for (var line of lines) {
        if (!line.trim()) continue;
        try {
          var event = JSON.parse(line);
          this._processEvent(event, socket);
        } catch (e) { /* not JSON, skip */ }
      }
    });

    child.stderr.on('data', (chunk) => {
      console.error('Gaffer chat stderr:', chunk.toString().substring(0, 200));
    });

    child.on('close', (code) => {
      this.activeProcess = null;
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          var event = JSON.parse(buffer);
          this._processEvent(event, socket);
        } catch (e) { /* ignore */ }
      }
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'chat_done', sessionId: this.sessionId }));
      }
    });

    child.on('error', (err) => {
      this.activeProcess = null;
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'chat_error', error: err.message }));
      }
    });
  }

  _processEvent(event, socket) {
    if (socket.readyState !== 1) return;

    if (event.type === 'assistant' && event.message && event.message.content) {
      for (var block of event.message.content) {
        if (block.type === 'text' && block.text) {
          var prefix = (this._lastEmit === 'text' || this._lastEmit === 'tool')
            ? '\n\n'
            : '';
          socket.send(JSON.stringify({ type: 'chat_chunk', text: prefix + block.text }));
          this._lastEmit = 'text';
          // Remember tool name keyed by id for matching tool_result later
          this._toolNames = this._toolNames || {};
        }
        if (block.type === 'tool_use') {
          this._toolNames = this._toolNames || {};
          this._toolNames[block.id] = shortToolLabel(block.name, block.input);
          socket.send(JSON.stringify({
            type: 'chat_tool_use',
            tool: this._toolNames[block.id],
            status: 'running',
            id: block.id,
          }));
          this._lastEmit = 'tool';
        }
      }
    }

    // tool_result blocks arrive in 'user' events from the Claude streaming format
    if (event.type === 'user' && event.message && event.message.content) {
      for (var block of event.message.content) {
        if (block.type === 'tool_result') {
          this._toolNames = this._toolNames || {};
          var label = this._toolNames[block.tool_use_id] || 'tool';
          socket.send(JSON.stringify({
            type: 'chat_tool_use',
            tool: label,
            status: block.is_error ? 'error' : 'done',
            id: block.tool_use_id,
          }));
          this._lastEmit = 'tool';
        }
      }
    }

    if (event.type === 'result') {
      this.sessionId = event.session_id || this.sessionId;
      // Final result text — send if we haven't streamed it yet
      if (event.result && event.subtype === 'success') {
        socket.send(JSON.stringify({ type: 'chat_result', text: event.result }));
      }
    }
  }

  cancel() {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }

  /**
   * List registered MCP servers. Returns array of { id, displayName, status }
   * for servers that are Connected. gaffer is filtered out (built-in).
   */
  async listMcps() {
    var claudeBin;
    try {
      claudeBin = await findClaudeBinary();
    } catch (e) {
      return { error: e.message, servers: [] };
    }

    var extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
    var pathParts = (process.env.PATH || '').split(':');
    for (var p of extraPaths) {
      if (pathParts.indexOf(p) === -1) pathParts.push(p);
    }
    var augmentedEnv = { ...process.env, PATH: pathParts.join(':') };

    return new Promise(function (resolve) {
      execFile(claudeBin, ['mcp', 'list'], { timeout: 8000, env: augmentedEnv }, function (err, stdout) {
        if (err) {
          resolve({ error: err.message, servers: [] });
          return;
        }
        var servers = [];
        var lines = stdout.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || line.indexOf(':') === -1) continue;
          // "<id>: <url-or-cmd> - <status>"
          var firstColon = line.indexOf(':');
          var id = line.substring(0, firstColon).trim();
          var rest = line.substring(firstColon + 1);
          var lastDash = rest.lastIndexOf(' - ');
          if (lastDash === -1) continue;
          var status = rest.substring(lastDash + 3).trim();
          if (id === 'gaffer') continue;
          var displayName = id.replace(/^claude\.ai /, '');
          servers.push({ id: id, displayName: displayName, status: status });
        }
        resolve({ servers: servers });
      });
    });
  }
}
