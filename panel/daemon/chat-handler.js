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

// When the running session crosses this many input tokens we summarize it
// and start fresh on the next turn. ~75% of the 200K Opus context — leaves
// headroom so the summarizing call itself doesn't hit the wall.
var COMPACT_THRESHOLD_TOKENS = 150000;

var COMPACT_PROMPT = "Summarize this entire conversation as a continuity briefing for yourself in a fresh session. Preserve: the user's project context, their goals, key decisions made, tools used and what they returned, the current state of the After Effects project, and any unfinished work. Be specific, ~400 words max. Output the summary directly with no preamble.";

// CEP launches the daemon with a stripped PATH. Augment it so claude can
// find node/npm and spawn stdio MCP servers (e.g. grip uses bare `node`).
function augmentedEnv() {
  var extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  var pathParts = (process.env.PATH || '').split(':');
  for (var p of extraPaths) {
    if (pathParts.indexOf(p) === -1) pathParts.push(p);
  }
  return { ...process.env, PATH: pathParts.join(':') };
}

export class ChatHandler {
  constructor() {
    this.activeProcess = null;
    this.sessionId = null;
    this.lastInputTokens = 0;
    this.compactedSummary = null;
    this.compacting = false;
    this.claudeBin = null;
    this.envForSpawn = null;
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
      // Claude transforms server names to tool prefixes: spaces/dots/dashes/colons → underscores
      return 'mcp__' + id.replace(/[\s.\-:]/g, '_') + '__*';
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

    var env = augmentedEnv();
    console.log('Gaffer chat PATH: ' + env.PATH);

    // Cache for the background compaction call.
    this.claudeBin = claudeBin;
    this.envForSpawn = env;

    // Prepend a continuity briefing if we just compacted the previous session.
    var userMessage = msg.message;
    if (this.compactedSummary && !sessionId) {
      userMessage = "[Continuity from previous compacted session]\n" + this.compactedSummary + "\n\n[New message]\n" + userMessage;
      this.compactedSummary = null;
    }

    var child = spawn(claudeBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env,
    });
    this.activeProcess = child;

    child.stdin.write(userMessage);
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
      // If the session is approaching the context wall, summarize it now in
      // the background so the next user turn can start fresh with continuity.
      if (this.sessionId && this.lastInputTokens >= COMPACT_THRESHOLD_TOKENS && !this.compacting) {
        this._compactSession(socket);
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
          // Some Claude CLI builds surface context-overflow as a plain
          // assistant text "Prompt is too long" instead of an error event.
          // Catch it here too and treat it as a session-reset signal.
          if (/^prompt is too long\.?$/i.test(block.text.trim())) {
            this.sessionId = null;
            socket.send(JSON.stringify({
              type: 'chat_error',
              error: 'Conversation too long for the model. Session reset — your next message starts a fresh context.',
            }));
            return;
          }
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
      // Detect context-overflow before adopting the session id — the next
      // resume would just hit the same wall. Drop the session so the user
      // can keep chatting; their next message starts a fresh context.
      var resultText = (event.result || '').toString();
      var isTooLong = event.subtype === 'error_max_tokens'
        || /prompt is too long/i.test(resultText)
        || /context.*length/i.test(resultText);
      if (isTooLong) {
        this.sessionId = null;
        socket.send(JSON.stringify({
          type: 'chat_error',
          error: 'Conversation too long for the model. Session reset — your next message starts a fresh context.',
        }));
        return;
      }
      this.sessionId = event.session_id || this.sessionId;
      // Track the input-token total reported by the CLI so we can compact
      // the session before the next turn would breach the context window.
      if (event.usage && typeof event.usage.input_tokens === 'number') {
        this.lastInputTokens = event.usage.input_tokens;
      }
      // Final result text — send if we haven't streamed it yet
      if (event.result && event.subtype === 'success') {
        socket.send(JSON.stringify({ type: 'chat_result', text: event.result }));
      }
    }
  }

  // Summarize the current session in the background and store the result so
  // the next user turn can start a fresh session without losing continuity.
  // We re-use --resume so claude has the full context to summarize, then
  // null out the sessionId so the next turn starts new.
  _compactSession(socket) {
    if (!this.claudeBin) return;
    this.compacting = true;
    var resumingId = this.sessionId;
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({
        type: 'chat_event',
        event: 'compacting',
        message: 'Compacting conversation to fit context window…',
      }));
    }

    var args = ['-p', '--model', 'haiku', '--resume', resumingId, '--dangerously-skip-permissions'];
    var child = spawn(this.claudeBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.envForSpawn,
    });
    var out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      console.error('Gaffer compact stderr:', chunk.toString().substring(0, 200));
    });
    child.stdin.write(COMPACT_PROMPT);
    child.stdin.end();

    child.on('close', (code) => {
      this.compacting = false;
      if (code === 0 && out.trim()) {
        this.compactedSummary = out.trim();
        // Drop the bloated session so the next chat starts fresh; the
        // summary will be prepended to the next user message.
        this.sessionId = null;
        this.lastInputTokens = 0;
        if (socket && socket.readyState === 1) {
          socket.send(JSON.stringify({
            type: 'chat_event',
            event: 'compacted',
            message: 'Conversation compacted. Continuing with summary.',
          }));
        }
      } else {
        if (socket && socket.readyState === 1) {
          socket.send(JSON.stringify({
            type: 'chat_event',
            event: 'compact_failed',
            message: 'Could not compact conversation — context will reset on overflow.',
          }));
        }
      }
    });
    child.on('error', (err) => {
      this.compacting = false;
      console.error('Gaffer compact error:', err.message);
    });
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

    var env = augmentedEnv();

    return new Promise(function (resolve) {
      // Health check runs per registered server — with many claude.ai
      // connectors the full list takes 10s+, so give generous headroom.
      execFile(claudeBin, ['mcp', 'list'], { timeout: 45000, env: env }, function (err, stdout) {
        if (err) {
          var reason = err.killed ? 'timed out listing MCP servers (45s)' : err.message;
          console.error('Gaffer listMcps failed: ' + reason);
          resolve({ error: reason, servers: [] });
          return;
        }
        var servers = [];
        var lines = stdout.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          // "<id>: <url-or-cmd> - <status>" — split on colon-space, not the
          // first colon: plugin-scoped ids contain colons (plugin:foo:bar).
          var sep = line.indexOf(': ');
          if (!line || sep === -1) continue;
          var id = line.substring(0, sep).trim();
          var rest = line.substring(sep + 2);
          var lastDash = rest.lastIndexOf(' - ');
          if (lastDash === -1) continue;
          var status = rest.substring(lastDash + 3).trim();
          if (id === 'gaffer') continue;
          var displayName = id.replace(/^claude\.ai /, '');
          // "plugin:telegram:telegram" → "telegram (plugin)"
          if (displayName.indexOf('plugin:') === 0) {
            displayName = displayName.split(':')[1] + ' (plugin)';
          }
          servers.push({ id: id, displayName: displayName, status: status });
        }
        resolve({ servers: servers });
      });
    });
  }

  /**
   * Authenticate an MCP server via `claude mcp login <id>` — opens the
   * user's browser for the OAuth flow. Resolves { ok } or { ok, error }.
   */
  async authMcp(id) {
    if (!id) return { ok: false, error: 'no server id' };
    var claudeBin;
    try {
      claudeBin = await findClaudeBinary();
    } catch (e) {
      return { ok: false, error: e.message };
    }

    var env = augmentedEnv();
    console.log('Gaffer: mcp login "' + id + '"');

    return new Promise(function (resolve) {
      // 5 min: covers the user completing browser OAuth; abandoned flows die.
      execFile(claudeBin, ['mcp', 'login', id], { timeout: 300000, env: env }, function (err, stdout, stderr) {
        if (err) {
          var reason = err.killed
            ? 'login timed out (5 min) — browser flow not completed'
            : ((stderr || '').trim() || err.message);
          console.error('Gaffer: mcp login failed for "' + id + '": ' + reason);
          resolve({ ok: false, error: reason });
          return;
        }
        resolve({ ok: true });
      });
    });
  }
}
