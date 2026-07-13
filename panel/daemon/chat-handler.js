import { spawn, execFile } from 'node:child_process';
import { findClaudeBinary } from './claude-binary.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
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

// ── MCP tile icons ──────────────────────────────────────────────────
// Resolution order (audit §4.6): bundled brand SVG → cached favicon →
// background favicon fetch (vendor domain from the server URL) → the
// panel falls back to a monogram tile.
var PANEL_DIR = join(__dirname, '..');
var BUNDLED_ICON_DIR = join(PANEL_DIR, 'icons', 'mcp');
var ICON_CACHE_DIR = join(PANEL_DIR, '.gaffer-icons');

function normName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function iconSlug(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function toDataUrl(file, buf) {
  var mime = /\.svg$/i.test(file) ? 'image/svg+xml'
    : /\.png$/i.test(file) ? 'image/png'
    : /\.(jpe?g)$/i.test(file) ? 'image/jpeg'
    : 'image/x-icon';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

var bundledIcons = null; // normName → dataUrl, lazy
function loadBundledIcons() {
  if (bundledIcons) return bundledIcons;
  bundledIcons = {};
  try {
    for (var f of readdirSync(BUNDLED_ICON_DIR)) {
      if (!/\.svg$/i.test(f)) continue;
      bundledIcons[normName(f.replace(/\.svg$/i, ''))] = toDataUrl(f, readFileSync(join(BUNDLED_ICON_DIR, f)));
    }
  } catch (e) { /* dir may not exist on end-user installs */ }
  return bundledIcons;
}

function cachedIcon(id) {
  try {
    for (var ext of ['.svg', '.png', '.ico']) {
      var p = join(ICON_CACHE_DIR, iconSlug(id) + ext);
      var buf = readFileSync(p);
      if (buf.length > 0) return toDataUrl(p, buf);
    }
  } catch (e) { /* miss */ }
  return null;
}

async function fetchFavicon(id, target) {
  var host;
  try { host = new URL(target).hostname; } catch (e) { return null; }
  var candidates = [host];
  var apex = host.replace(/^[^.]+\./, '');
  if (apex !== host && apex.indexOf('.') !== -1) candidates.push(apex);
  for (var domain of candidates) {
    try {
      var res = await fetch('https://' + domain + '/favicon.ico', {
        redirect: 'follow',
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      var buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 32) continue; // empty/placeholder
      mkdirSync(ICON_CACHE_DIR, { recursive: true });
      var file = join(ICON_CACHE_DIR, iconSlug(id) + '.ico');
      writeFileSync(file, buf);
      return toDataUrl(file, buf);
    } catch (e) { /* try next */ }
  }
  return null;
}

// Assign icons from bundled/cache synchronously; fetch the rest in the
// background and report them via onIcons({ id: dataUrl }).
function resolveIcons(servers, onIcons) {
  var bundled = loadBundledIcons();
  var misses = [];
  for (var s of servers) {
    var norm = normName(s.displayName);
    var hit = null;
    for (var key of Object.keys(bundled)) {
      if (norm === key || norm.indexOf(key) === 0) { hit = bundled[key]; break; }
    }
    if (!hit) hit = cachedIcon(s.id);
    s.icon = hit;
    if (!hit && /^https?:\/\//.test(s.target || '')) misses.push(s);
  }
  if (!misses.length || typeof onIcons !== 'function') return;
  Promise.allSettled(misses.map(function (s) {
    return fetchFavicon(s.id, s.target).then(function (dataUrl) {
      return dataUrl ? { id: s.id, icon: dataUrl } : null;
    });
  })).then(function (results) {
    var icons = {};
    var found = 0;
    for (var r of results) {
      if (r.status === 'fulfilled' && r.value) { icons[r.value.id] = r.value.icon; found++; }
    }
    console.log('Gaffer: favicon fetch — ' + found + '/' + misses.length + ' resolved');
    if (found) onIcons(icons);
  });
}

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
    this.modelOptions = null; // cached discovery result
  }

  // Discover what the installed CLI offers — no hardcoded lists in the
  // panel. Parses `claude --help`: the --effort enum is explicit
  // ("(low, medium, high, xhigh, max)"); the --model description names the
  // current aliases as quoted examples. 'haiku' works but isn't listed in
  // the examples, so a floor of known-good aliases is unioned in.
  async listModelOptions() {
    if (this.modelOptions) return this.modelOptions;
    var self = this;
    var help = await new Promise(async function (resolve) {
      try {
        var bin = await findClaudeBinary();
        execFile(bin, ['--help'], { env: augmentedEnv(), timeout: 15000 }, function (err, stdout) {
          resolve(String(stdout || ''));
        });
      } catch (e) { resolve(''); }
    });
    var models = [];
    var modelBlock = help.match(/--model <model>[\s\S]*?(?=\n\s+-{1,2}[a-z])/i);
    if (modelBlock) {
      var m, re = /'([a-z][a-z0-9]*)'/g; // bare aliases only, not 'claude-*' ids
      while ((m = re.exec(modelBlock[0]))) {
        if (models.indexOf(m[1]) === -1) models.push(m[1]);
      }
    }
    for (var base of ['opus', 'sonnet', 'haiku']) {
      if (models.indexOf(base) === -1) models.push(base);
    }
    var efforts = [];
    var effortBlock = help.match(/--effort <level>[\s\S]*?\(([a-z, ]+)\)/i);
    if (effortBlock) efforts = effortBlock[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!efforts.length) efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    // Pinnable versions: full model ids the CLI accepts (verified:
    // `--model claude-opus-4-6` works; version aliases don't exist).
    // Enumerated from the CLI's own state file (~/.claude.json — server
    // -pushed model options + feature cache), so the list tracks CLI
    // updates instead of being hardcoded here.
    var versions = {};
    try {
      var stateRaw = readFileSync(join(homedir(), '.claude.json'), 'utf8');
      var seen = {};
      var vm, vre = /claude-([a-z]+)-[0-9][0-9a-z-]*/g;
      while ((vm = vre.exec(stateRaw))) {
        var id = vm[0].replace(/-$/, '');
        // versions only — numeric segments (opt. date), not entitlement
        // ids like claude-fable-5-promotional-access
        if (!/^claude-[a-z]+(-\d+)+$/.test(id)) continue;
        if (seen[id]) continue;
        seen[id] = true;
        (versions[vm[1]] = versions[vm[1]] || []).push(id);
      }
      var vnum = function (id) {
        return id.replace(/^claude-[a-z]+-/, '').split('-')
          .map(function (n) { return parseInt(n, 10) || 0; });
      };
      for (var fam in versions) {
        versions[fam].sort(function (a, b) {
          var x = vnum(a), y = vnum(b);
          for (var i = 0; i < Math.max(x.length, y.length); i++) {
            if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0);
          }
          return 0;
        });
      }
    } catch (e) { /* no state file — versions stay empty */ }
    self.modelOptions = { models: models, efforts: efforts, versions: versions };
    return self.modelOptions;
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
    // Context-window variant: 1M suffix, passed through for ANY model
    // (probed live: opus/sonnet/fable accept [1m]; haiku returns a clear
    // API 400 about subscription availability). Never silently strip —
    // an unsupported combo must surface its error in chat.
    if (msg.variant === '1m') model += '[1m]';
    var args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    var EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (msg.effort && EFFORTS.indexOf(msg.effort) !== -1) args.push('--effort', msg.effort);
    // Register the gaffer MCP server inline — chat must work even when the
    // installer's `claude mcp add` step never ran (e.g. CLI installed after
    // the panel). Merges with any user-scope registration of the same name.
    args.push('--mcp-config', JSON.stringify({ mcpServers: { gaffer: { type: 'http', url: 'http://127.0.0.1:9824/mcp' } } }));

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
   * List registered MCP servers. Returns array of
   * { id, displayName, status, target, icon } — icon is a data URL from the
   * bundled brand set or the favicon cache; misses are fetched in the
   * background and delivered via the onIcons callback.
   */
  async listMcps(onIcons) {
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
          var target = rest.substring(0, lastDash).trim(); // url or command
          var displayName = id.replace(/^claude\.ai /, '');
          // "plugin:telegram:telegram" → "telegram (plugin)"
          if (displayName.indexOf('plugin:') === 0) {
            displayName = displayName.split(':')[1] + ' (plugin)';
          }
          servers.push({ id: id, displayName: displayName, status: status, target: target });
        }
        resolveIcons(servers, onIcons);
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
