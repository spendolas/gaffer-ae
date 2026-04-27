import { spawn } from 'node:child_process';
import { findClaudeBinary } from './claude-binary.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

var TOOLS = 'mcp__gaffer__runJSX,mcp__gaffer__getProjectSummary,mcp__gaffer__listEffectMatchNames,mcp__gaffer__captureActiveComp';

export class ChatHandler {
  constructor() {
    this.activeProcess = null;
    this.sessionId = null;
  }

  async handleChat(msg, socket) {
    this.cancel();

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

    var model = msg.model || 'opus';
    var args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];

    // Use sessionId from panel (persists across daemon restarts via chat-history.json)
    var sessionId = msg.sessionId || this.sessionId;
    if (sessionId) {
      args.push('--resume', sessionId);
      this.sessionId = sessionId;
    } else {
      // New conversation
      args.push(
        '--append-system-prompt', systemPrompt,
        '--allowedTools', TOOLS
      );
    }

    var child = spawn(claudeBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
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
          socket.send(JSON.stringify({ type: 'chat_chunk', text: block.text }));
        }
        if (block.type === 'tool_use') {
          socket.send(JSON.stringify({
            type: 'chat_tool_use',
            tool: block.name || 'unknown',
            status: 'running',
          }));
        }
        if (block.type === 'tool_result') {
          socket.send(JSON.stringify({
            type: 'chat_tool_use',
            tool: block.name || 'unknown',
            status: block.is_error ? 'error' : 'done',
          }));
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
}
