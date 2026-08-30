import { spawn, execFile } from 'node:child_process';
import { findClaudeBinary } from './claude-binary.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pruneSessionFile } from './session-pruner.js';
import { scoreMessage, classifyTurn, tierToSelection } from './model-router.js';

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
  'mcp__gaffer__listMarkers',
  'mcp__gaffer__listTextLayers',
  'mcp__gaffer__getLayerEffects',
  'mcp__gaffer__getShapeContents',
  'mcp__gaffer__getProjectTree',
  'mcp__gaffer__getProjectSettings',
];

// Claude Code's public model-config matrix is more precise than the CLI's
// single global `--effort` help line. Keep this compatibility data here so the
// Settings response can gate model-specific controls instead of pretending
// every model supports every option. Account/plan entitlement is still a
// separate server-side decision; `source` below makes that explicit.
var MODEL_CAPABILITY_SOURCE = 'claude-code-model-config';
var ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
var NO_XHIGH_EFFORTS = ['low', 'medium', 'high', 'max'];

var MODEL_DISCOVERY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function readCredentialFileToken(env) {
  try {
    var configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    var raw = readFileSync(join(configDir, '.credentials.json'), 'utf8');
    var parsed = JSON.parse(raw);
    return parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken
      ? String(parsed.claudeAiOauth.accessToken) : '';
  } catch (e) { return ''; }
}

function readMacKeychainToken(env) {
  return new Promise(function (resolve) {
    if (process.platform !== 'darwin') return resolve('');
    var args = ['find-generic-password'];
    if (env.USER) args.push('-a', env.USER);
    args.push('-s', 'Claude Code-credentials', '-w');
    execFile('/usr/bin/security', args, { env: env, timeout: 10000, windowsHide: true }, function (err, stdout) {
      if (err) return resolve('');
      try {
        var parsed = JSON.parse(String(stdout || ''));
        resolve(parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken
          ? String(parsed.claudeAiOauth.accessToken) : '');
      } catch (e) { resolve(''); }
    });
  });
}

// Cache the resolved credential for the daemon's lifetime. The mac Keychain
// read (`security -w`) is the fragile step: from a background daemon a repeat
// read can wedge on an ACL prompt that never displays, which stranded the panel
// on the loading spinner on the SECOND settings open. Reading once and reusing
// the token means every later refresh skips the Keychain entirely. Cleared on an
// auth failure (401/403) so a rotated/expired token gets re-read.
var cachedModelCredential = null;
function clearModelCredentialCache() { cachedModelCredential = null; }
async function readModelDiscoveryCredential(env) {
  // Explicit credentials win, and are the only supported route for API-key
  // installs. OAuth credentials stay in the OS/file store and are never
  // persisted or logged by Gaffer. Env creds are cheap; don't cache them.
  if (env.ANTHROPIC_API_KEY) return { kind: 'api-key', token: String(env.ANTHROPIC_API_KEY) };
  if (env.ANTHROPIC_AUTH_TOKEN) return { kind: 'bearer', token: String(env.ANTHROPIC_AUTH_TOKEN) };
  if (cachedModelCredential) return cachedModelCredential;
  var token = await readMacKeychainToken(env);
  if (!token) token = readCredentialFileToken(env);
  cachedModelCredential = token ? { kind: 'bearer', token: token } : null;
  return cachedModelCredential;
}

export function modelCatalogOptions(payload) {
  if (!payload || !Array.isArray(payload.data)) return null;
  var rows = payload.data.filter(function (row) {
    return row && typeof row.id === 'string' && /^claude-[a-z]+-/.test(row.id);
  });
  if (!rows.length) return null;
  var versions = {};
  var capabilitiesByModel = {};
  var effortsByModel = {};
  var seen = {};
  var addFamilyVersion = function (id) {
    var match = /^claude-([a-z]+)-/.exec(id);
    if (!match) return '';
    var family = match[1];
    if (!versions[family]) versions[family] = [];
    if (!seen[id]) { seen[id] = true; versions[family].push(id); }
    return family;
  };
  rows.forEach(function (row) {
    var id = row.id;
    var family = addFamilyVersion(id);
    var effort = row.capabilities && row.capabilities.effort;
    var supportedEfforts = [];
    if (effort && effort.supported === true) {
      var declaresLevels = MODEL_DISCOVERY_EFFORTS.some(function (level) {
        return Object.prototype.hasOwnProperty.call(effort, level);
      });
      supportedEfforts = MODEL_DISCOVERY_EFFORTS.filter(function (level) {
        return declaresLevels ? effort[level] && effort[level].supported === true : true;
      });
    }
    var oneM = Number(row.max_input_tokens) >= 1000000;
    var cap = {
      oneM: oneM,
      contextWindows: oneM ? [200000, 1000000] : [200000],
      efforts: supportedEfforts,
      source: 'anthropic-v1-models',
      entitlement: 'account-server',
      modelId: id,
      displayName: typeof row.display_name === 'string' ? row.display_name : id,
      maxInputTokens: Number(row.max_input_tokens) || null,
      maxOutputTokens: Number(row.max_tokens) || null,
    };
    capabilitiesByModel[id] = cap;
    effortsByModel[id] = supportedEfforts;
    // The family alias resolves to the first (newest) API row below.
    if (family && !capabilitiesByModel[family]) {
      capabilitiesByModel[family] = cap;
      effortsByModel[family] = supportedEfforts;
    }
  });
  var versionNumber = function (id) {
    return id.replace(/^claude-[a-z]+-/, '').split('-').map(function (part) {
      return parseInt(part, 10) || 0;
    });
  };
  Object.keys(versions).forEach(function (family) {
    versions[family].sort(function (a, b) {
      var x = versionNumber(a), y = versionNumber(b);
      for (var i = 0; i < Math.max(x.length, y.length); i++) {
        if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0);
      }
      return 0;
    });
    var newest = versions[family][0];
    if (newest && capabilitiesByModel[newest]) {
      capabilitiesByModel[family] = capabilitiesByModel[newest];
      effortsByModel[family] = effortsByModel[newest];
    }
  });
  var preferredOrder = ['fable', 'opus', 'sonnet', 'haiku', 'mythos'];
  var models = preferredOrder.filter(function (family) { return versions[family] && versions[family].length; });
  Object.keys(versions).forEach(function (family) {
    if (models.indexOf(family) === -1) models.push(family);
  });
  var efforts = [];
  Object.keys(effortsByModel).forEach(function (key) {
    effortsByModel[key].forEach(function (level) { if (efforts.indexOf(level) === -1) efforts.push(level); });
  });
  efforts = MODEL_DISCOVERY_EFFORTS.filter(function (level) { return efforts.indexOf(level) !== -1; });
  return {
    models: models,
    efforts: efforts,
    effortsByModel: effortsByModel,
    capabilitiesByModel: capabilitiesByModel,
    versions: versions,
    capabilitySource: 'anthropic-v1-models',
    entitlement: 'account-server',
    live: true,
  };
}

async function fetchModelCatalog(env) {
  var credential = await readModelDiscoveryCredential(env);
  if (!credential) return { catalog: null, reason: 'no-credential' };
  var base = String(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  var url = base + '/v1/models?limit=1000';
  var headers = {
    'User-Agent': 'claude-code/2.1.236',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
  };
  if (credential.kind === 'api-key') headers['x-api-key'] = credential.token;
  else headers.Authorization = 'Bearer ' + credential.token;
  try {
    var response = await fetch(url, { headers: headers, signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      console.warn('Gaffer: live model discovery returned HTTP ' + response.status);
      // A rejected token may be stale/rotated — drop the cache so the next
      // attempt re-reads the credential instead of reusing the bad one.
      if (response.status === 401 || response.status === 403) clearModelCredentialCache();
      return { catalog: null, reason: response.status === 401 || response.status === 403 ? 'unauthorized' : 'network' };
    }
    var catalog = modelCatalogOptions(await response.json());
    return { catalog: catalog, reason: catalog ? 'ready' : 'invalid-response' };
  } catch (e) {
    console.warn('Gaffer: live model discovery failed: ' + (e && e.message ? e.message : e));
    return { catalog: null, reason: 'network' };
  }
}

export function modelCapability(model, versions) {
  var raw = String(model || '').replace(/\[1m\]$/, '');
  var id = raw;
  if (/^[a-z][a-z0-9]*$/.test(raw) && versions && versions[raw] && versions[raw][0]) {
    id = versions[raw][0];
  }
  var m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  var family = m ? m[1] : raw;
  var major = m ? parseInt(m[2], 10) : 0;
  var minor = m && m[3] ? parseInt(m[3], 10) : 0;
  var efforts = [];
  var oneM = false;

  if (family === 'fable' || family === 'mythos') {
    efforts = major >= 5 ? ALL_EFFORTS : [];
    oneM = major >= 5;
  } else if (family === 'opus') {
    oneM = major >= 5 || (major === 4 && minor >= 6);
    efforts = major >= 5 || (major === 4 && minor >= 7) ? ALL_EFFORTS
      : (major === 4 && minor === 6 ? NO_XHIGH_EFFORTS : []);
  } else if (family === 'sonnet') {
    oneM = major >= 5 || (major === 4 && minor >= 6);
    efforts = major >= 5 ? ALL_EFFORTS
      : (major === 4 && minor === 6 ? NO_XHIGH_EFFORTS : []);
  }

  // A bare alias can be returned before the state file has a version. The
  // current aliases still have documented family-level behavior; use it as a
  // fallback while keeping unknown/new families conservative.
  if (!m) {
    if (family === 'fable' || family === 'mythos' || family === 'opus' || family === 'sonnet') {
      efforts = ALL_EFFORTS; oneM = true;
    }
  }
  return {
    oneM: oneM,
    contextWindows: oneM ? [200000, 1000000] : [200000],
    efforts: efforts.slice(),
    source: MODEL_CAPABILITY_SOURCE,
    entitlement: 'plan-dependent',
  };
}

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
// Resolution order: bundled brand SVG → cached vector → background
// simple-icons CDN fetch → the panel falls back to a monogram tile.
// Vectors only — favicons were removed (inconsistent, bad experience).
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
  // sniff magic bytes — /favicon.ico very often serves PNG, and a wrong
  // declared mime on a data: URL breaks decoding in some CEF builds
  var mime;
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
  else if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
  else if (buf.length > 6 && buf.slice(0, 4).toString() === 'GIF8') mime = 'image/gif';
  else if (buf.length > 12 && buf.slice(8, 12).toString() === 'WEBP') mime = 'image/webp';
  else if (buf.length > 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) mime = 'image/x-icon';
  else if (/\.svg$/i.test(file) || /^\s*<(\?xml|svg)/i.test(buf.slice(0, 100).toString())) mime = 'image/svg+xml';
  else mime = /\.png$/i.test(file) ? 'image/png' : /\.(jpe?g)$/i.test(file) ? 'image/jpeg' : 'image/x-icon';
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
  // vectors only — favicon caching removed (bad tile experience)
  try {
    var p = join(ICON_CACHE_DIR, iconSlug(id) + '.svg');
    var buf = readFileSync(p);
    if (buf.length > 0) return toDataUrl(p, buf);
  } catch (e) { /* miss */ }
  return null;
}

// one-time hygiene: drop legacy favicon cache files from pre-vector installs
var prunedLegacyIcons = false;
function pruneLegacyIcons() {
  if (prunedLegacyIcons) return;
  prunedLegacyIcons = true;
  try {
    for (var f of readdirSync(ICON_CACHE_DIR)) {
      if (/\.(ico|png)$/i.test(f)) unlinkSync(join(ICON_CACHE_DIR, f));
    }
  } catch (e) { /* cache dir may not exist */ }
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
    if (!hit) misses.push(s);
  }
  pruneLegacyIcons();
  if (!misses.length || typeof onIcons !== 'function') return;
  Promise.allSettled(misses.map(function (s) {
    // brand vectors only (simple-icons CDN — flat, single-color, identical
    // on every install; nothing redistributed by this repo); no vector ->
    // the panel shows the two-letter monogram
    return fetchSimpleIcon(s.id, s.displayName).then(function (svg) {
      return svg ? { id: s.id, icon: svg } : null;
    });
  })).then(function (results) {
    var icons = {};
    var found = 0;
    for (var r of results) {
      if (r.status === 'fulfilled' && r.value) { icons[r.value.id] = r.value.icon; found++; }
    }
    console.log('Gaffer: icon fetch — ' + found + '/' + misses.length + ' resolved');
    if (found) onIcons(icons);
  });
}

// simple-icons CDN: monochrome brand vectors by slug (normName happens to
// match their slug scheme for most brands). Slug ladder recovers names
// with decorative suffixes — "Zoom for Claude" isn't a brand, "zoom" is.
// All candidates 404 = brand unknown -> the panel's monogram.
async function fetchSimpleIcon(id, displayName) {
  var base = String(displayName).replace(/^claude\.ai\s+/i, '').replace(/\(.*\)/, '').trim();
  var firstWord = normName(base.split(/\s+/)[0]);
  var candidates = [
    normName(base),
    normName(base.replace(/\s+for\s+.*$/i, '')), // "Zoom for Claude" -> zoom
    firstWord.length >= 3 ? firstWord : '',      // last resort; short tokens risk wrong brands
  ].filter(function (s, i, arr) { return s && arr.indexOf(s) === i; });
  for (var slug of candidates) {
    try {
      var res = await fetch('https://cdn.simpleicons.org/' + slug, {
        redirect: 'follow',
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      var text = await res.text();
      if (text.indexOf('<svg') === -1) continue;
      // fill with currentColor so the panel's tile color drives the glyph
      text = text.replace('<svg', '<svg fill="currentColor"');
      var buf = Buffer.from(text);
      mkdirSync(ICON_CACHE_DIR, { recursive: true });
      var file = join(ICON_CACHE_DIR, iconSlug(id) + '.svg');
      writeFileSync(file, buf);
      return toDataUrl(file, buf);
    } catch (e) { /* try next candidate */ }
  }
  return null;
}

// CEP launches the daemon with a stripped PATH. Augment it so claude can
// find node/npm and spawn stdio MCP servers (e.g. grip uses bare `node`).
export function augmentedEnv() {
  var extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  var pathParts = (process.env.PATH || '').split(':');
  for (var p of extraPaths) {
    if (pathParts.indexOf(p) === -1) pathParts.push(p);
  }
  return { ...process.env, PATH: pathParts.join(':') };
}

// One-shot classifier runner for the autoModel middle band: haiku, hermetic,
// fresh session. Returns (prompt) => Promise<stdout>. Never rejects — resolves
// '' on timeout/error so classifyTurn falls back to 'complex' (no downshift).
//
// --safe-mode strips every customization (hooks, plugins, skills, LSP, auto
// memory, CLAUDE.md) but KEEPS keychain auth — unlike --bare, which skips the
// keychain and then demands ANTHROPIC_API_KEY. So the classifier stays on the
// user's subscription with nothing bleeding in. classifierEnv() also kills the
// blocking non-essential startup round-trips (update check / telemetry / error
// reporting), trimming a few seconds off cold-start. Measured ~4–7s (was ~7–15s).
//
// Not warm, not API-direct, by design: a resident stream-json session shares one
// conversation and haiku drifts from classifying into chatting (context poison),
// and the CLI inits lazily on first message so an idle process pre-pays nothing.
// A direct Messages-API call with the subscription OAuth token IS ~1s and works,
// but was declined — it's a grey-area use of the token and could face an end-user
// keychain-access prompt. Staying on the CLI keeps auth boring and universal.
var CLASSIFY_TIMEOUT_MS = 20000;
// augmentedEnv + non-essential-traffic off. Scoped to the classifier subprocess
// only — the main chat keeps telemetry/updates. Documented Claude Code vars.
function classifierEnv() {
  return {
    ...augmentedEnv(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
}
function makeClassifyRun(claudeBin) {
  return function (prompt) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (!done) { done = true; resolve(v); } };
      try {
        var child = spawn(claudeBin, [
          '-p', '--model', 'haiku',
          '--safe-mode', // strip customizations, keep keychain auth (not --bare)
          '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
          '--dangerously-skip-permissions',
        ], { stdio: ['pipe', 'pipe', 'pipe'], env: classifierEnv(), windowsHide: true });
        var out = '';
        var timer = setTimeout(function () { try { child.kill('SIGTERM'); } catch (e) {} finish(''); }, CLASSIFY_TIMEOUT_MS);
        child.stdout.on('data', function (c) { out += c.toString(); });
        child.on('close', function () { clearTimeout(timer); finish(out); });
        child.on('error', function () { clearTimeout(timer); finish(''); });
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (e) { finish(''); }
    });
  };
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
    this.liveModelCapabilities = null;
  }

  // Discover the account's currently callable models from Anthropic's live
  // catalog. This runs afresh for every authorized Settings open; no cached
  // CLI/session model list is treated as entitlement proof.
  async listModelOptions() {
    var result = await fetchModelCatalog(augmentedEnv());
    if (result && result.catalog) {
      this.liveModelCapabilities = result.catalog.capabilitiesByModel;
      return result.catalog;
    }
    // No live catalog means no entitlement proof. Fail closed: do not surface
    // CLI aliases or historical versions that the account may not be allowed
    // to call. Chat keeps its safe Opus 4.8 default, while Settings presents
    // an explicit retry state.
    this.liveModelCapabilities = null;
    return {
      models: [], efforts: [], effortsByModel: {}, capabilitiesByModel: {},
      versions: {}, capabilitySource: 'unavailable', entitlement: 'unknown',
      live: false, modelAccess: result && result.reason ? result.reason : 'unavailable',
    };
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

    // Keep the trust-first default consistent for older panels and headless
    // callers that omit advanced settings: Opus 4.8 at Medium effort.
    var model = msg.model || 'claude-opus-4-8';
    var effort = msg.effort || 'medium';
    // Optional, off by default: a two-stage classifier lightens the turn.
    // Stage 1 is a free local score; the ambiguous middle escalates to one
    // cheap haiku call. trivial → haiku/low + drop 1M; moderate → sonnet/medium
    // (keeps 1M); complex → unchanged. Never upshifts, never touches a pinned
    // id. Logged so the lever can be measured before it earns its keep.
    var autoDownshifted = false;
    if (msg.autoModel) {
      // Stage 1: free local score. Stage 2 (haiku) only on the ambiguous
      // middle — logged with its verdict + latency so the lever can be
      // evaluated from real usage before it earns its keep.
      var tier = scoreMessage(msg.message);
      if (tier === 'unsure') {
        var _t0 = Date.now();
        tier = await classifyTurn(msg.message, { run: makeClassifyRun(claudeBin) });
        console.log('[automodel] classify unsure -> ' + tier + ' in ' + (Date.now() - _t0) + 'ms');
      }
      var sel = tierToSelection(tier, { model: model, effort: effort, variant: msg.variant });
      if (sel.downshifted) {
        console.log('[automodel] ' + tier + ': ' + model + '/' + (effort || '-')
          + (msg.variant === '1m' ? '/1m' : '')
          + ' -> ' + sel.model + '/' + (sel.effort || '-')
          + (sel.dropContext && msg.variant === '1m' ? ' (1m dropped)' : ''));
        model = sel.model;
        effort = sel.effort;
        autoDownshifted = sel.dropContext;
      }
    }
    // Validate advanced controls against the same model matrix sent to
    // Settings. This is a server-side guard for stale panels or hand-crafted
    // websocket messages; the UI also hides unsupported choices. Account/plan
    // entitlement remains Claude's decision and may still reject a valid
    // capability at request time.
    var capabilityKey = String(model || '').replace(/\[1m\]$/, '');
    var capability = (this.liveModelCapabilities && this.liveModelCapabilities[capabilityKey])
      || modelCapability(model, null);
    if (msg.variant === '1m' && !autoDownshifted && !capability.oneM) {
      if (socket.readyState === 1) socket.send(JSON.stringify({
        type: 'chat_error',
        error: '1M context is not supported by ' + model + '.',
      }));
      return;
    }
    if (effort && capability.efforts.indexOf(effort) === -1) effort = null;
    // Context-window variant: Claude Code encodes 1M as a [1m] model suffix.
    // Skip it when autoModel deliberately downshifted to a non-1M model.
    if (msg.variant === '1m' && !autoDownshifted) model += '[1m]';
    var args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    var EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (effort && EFFORTS.indexOf(effort) !== -1 && capability.efforts.indexOf(effort) !== -1) args.push('--effort', effort);
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
    // Resolved model/effort actually handed to the CLI this turn — the record
    // for tracing what a panel selection maps to (and what autoModel changed).
    console.log('Gaffer chat spawn: --model ' + model
      + (effort && EFFORTS.indexOf(effort) !== -1 ? ' --effort ' + effort : ' (no --effort)')
      + ' | variant=' + (msg.variant || 'standard')
      + ' resume=' + (sessionId ? 'yes' : 'new')
      + ' autoModel=' + (msg.autoModel ? 'on' : 'off'));

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
      windowsHide: true, // console-subsystem children flash a cmd window otherwise
    });
    this.activeProcess = child;

    child.stdin.write(userMessage);
    child.stdin.end();

    var buffer = '';
    var lastText = '';
    var stderrBuf = '';
    var sawOutput = false;
    var self = this;

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      var lines = buffer.split('\n');
      buffer = lines.pop();

      for (var line of lines) {
        if (!line.trim()) continue;
        try {
          var event = JSON.parse(line);
          sawOutput = true;
          this._processEvent(event, socket);
        } catch (e) { /* not JSON, skip */ }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      console.error('Gaffer chat stderr:', chunk.toString().substring(0, 200));
    });

    child.on('close', (code) => {
      this.activeProcess = null;
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          var event = JSON.parse(buffer);
          sawOutput = true;
          this._processEvent(event, socket);
        } catch (e) { /* ignore */ }
      }
      // Self-heal a dead --resume: the CLI's session storage can be wiped
      // by CLI updates or re-auth, leaving our persisted sessionId pointing
      // nowhere. On a failed resume the CLI emits a stream-json `result`
      // event with is_error (so sawOutput flips true) AND prints
      // "No conversation found" on stderr, then exits non-zero — it looked
      // like a silent empty turn that also KEPT the stale id, looping
      // forever. Key on the stderr signal (a failed resume can never carry a
      // real reply) and retry once fresh (history text is preserved panel-side).
      if (sessionId && !msg.__retriedFreshSession
          && /no conversation found/i.test(stderrBuf)) {
        console.log('Gaffer: stale session ' + sessionId + ' — retrying fresh');
        self.sessionId = null;
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'chat_event', message: 'Previous session expired — starting a fresh one.' }));
        }
        var retryMsg = Object.assign({}, msg, { sessionId: null, __retriedFreshSession: true });
        self.handleChat(retryMsg, socket);
        return; // the retry emits its own chat_done/chat_error
      }
      // Never end a turn silently: no output + non-zero exit = surfaced error
      if (!sawOutput && code !== 0 && !child._userCancelled) {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({
            type: 'chat_error',
            error: (stderrBuf.trim() || ('claude exited with code ' + code)).slice(0, 300),
          }));
        }
        return;
      }
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'chat_done', sessionId: this.sessionId }));
      }
      // Shed replayed image payloads from the persisted transcript before the
      // next --resume. Safe window: this turn's process has exited. Skipped
      // while a background compaction holds the session. Never throws.
      // MUST stay synchronous: the atomic rewrite's safety vs. the next
      // --resume and vs. a background compaction (_compactSession, which also
      // resumes this session) depends on blocking the event loop until the
      // rename completes — an async rewrite would reopen a read-during-write
      // window. Do not convert to fs.promises.
      if (this.sessionId && !this.compacting) {
        pruneSessionFile(this.sessionId);
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
      windowsHide: true,
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
      this.activeProcess._userCancelled = true; // close handler: not an error
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
      execFile(claudeBin, ['mcp', 'list'], { timeout: 45000, env: env, windowsHide: true }, function (err, stdout) {
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
      execFile(claudeBin, ['mcp', 'login', id], { timeout: 300000, env: env, windowsHide: true }, function (err, stdout, stderr) {
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
