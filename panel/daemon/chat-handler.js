import { spawn, execFile } from 'node:child_process';
import { findClaudeBinary } from './claude-binary.js';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
// session-pruner.js intentionally not imported: mid-session pruning was disabled
// (2026-09-07, root cause 2) because it invalidates the prompt cache. See below.
import * as telemetry from './telemetry.js';

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

// Persisted model-catalog cache TTL. A day is well within a single work
// session's relevance yet short enough that newly available models surface on
// the next day's first Settings open even for a user who never chats (chat's
// background refresh keeps active users current within the day). See
// ChatHandler.listModelOptions / _loadPersistedCache.
var MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Derive a stable per-account identity for keying the persisted cache — from
// FILES ONLY, never a subprocess, so a cache-hit open stays fast (a spawned
// `claude auth status` would add ~500ms and defeat the whole point of skipping
// the network). NEVER a raw token on disk.
//   - Explicit API-key / bearer installs: a salted-free sha256 *fingerprint* of
//     the key (stable — API keys don't rotate; the raw key never leaves memory).
//   - OAuth installs: the account identity Claude Code persists in ~/.claude.json
//     (accountUuid preferred — stable and PII-free; email/org uuid as fallbacks).
// null => identity unknown; callers then decline to serve a persisted catalog as
// "fresh" (they fall back to a live fetch) and never cross-serve accounts.
function accountIdFromEnvAndConfig(env) {
  var explicit = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  if (explicit) {
    try { return 'key:' + createHash('sha256').update(String(explicit)).digest('hex').slice(0, 16); }
    catch (e) { return null; }
  }
  var candidates = [];
  if (env.CLAUDE_CONFIG_DIR) candidates.push(join(env.CLAUDE_CONFIG_DIR, '.claude.json'));
  candidates.push(join(homedir(), '.claude.json'));
  for (var i = 0; i < candidates.length; i++) {
    try {
      var acc = JSON.parse(readFileSync(candidates[i], 'utf8')).oauthAccount;
      if (acc) {
        if (acc.accountUuid) return 'uuid:' + String(acc.accountUuid);
        if (acc.emailAddress) return 'email:' + String(acc.emailAddress);
        if (acc.organizationUuid) return 'org:' + String(acc.organizationUuid);
      }
    } catch (e) { /* missing/corrupt — try the next candidate */ }
  }
  return null;
}

// A persisted cache belongs to the current account only when both identities
// are known AND equal. Unknown identity (either side null) never matches — a
// different account must never inherit the previous account's catalog.
function accountMatches(persisted, currentAccountId) {
  return !!(persisted && currentAccountId != null
    && persisted.accountId != null && persisted.accountId === currentAccountId);
}

// Parse the Claude Code OAuth blob into { token, expiresAt }. expiresAt (ms
// epoch) lets discovery detect a stale access token BEFORE calling the API, so
// an expired token falls back to the cached catalog instead of eating a 401.
function parseOauthBlob(raw) {
  try {
    var o = JSON.parse(String(raw || '')).claudeAiOauth;
    return o && o.accessToken
      ? { token: String(o.accessToken), expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : 0 }
      : null;
  } catch (e) { return null; }
}

function readCredentialFileToken(env) {
  try {
    var configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return parseOauthBlob(readFileSync(join(configDir, '.credentials.json'), 'utf8'));
  } catch (e) { return null; }
}

function readMacKeychainToken(env) {
  return new Promise(function (resolve) {
    if (process.platform !== 'darwin') return resolve(null);
    var args = ['find-generic-password'];
    if (env.USER) args.push('-a', env.USER);
    args.push('-s', 'Claude Code-credentials', '-w');
    execFile('/usr/bin/security', args, { env: env, timeout: 10000, windowsHide: true }, function (err, stdout) {
      resolve(err ? null : parseOauthBlob(stdout));
    });
  });
}

// The daemon does NOT own the OAuth token lifecycle — the Claude Code CLI
// refreshes the access token when IT makes an API call (e.g. a chat spawn), and
// exposes no refresh/models command. So the token is only valid in the window
// after recent CLI use (~8h), and a background daemon can't refresh it without
// impersonating Claude Code's OAuth client. Discovery therefore reads the token
// fresh each time WITH its expiry; expiry handling lives in fetchModelCatalog.
async function readModelDiscoveryCredential(env) {
  // Explicit credentials win, and are the only supported route for API-key
  // installs. Treated as non-expiring (no OAuth expiry to track).
  if (env.ANTHROPIC_API_KEY) return { kind: 'api-key', token: String(env.ANTHROPIC_API_KEY), expiresAt: 0 };
  if (env.ANTHROPIC_AUTH_TOKEN) return { kind: 'bearer', token: String(env.ANTHROPIC_AUTH_TOKEN), expiresAt: 0 };
  var blob = await readMacKeychainToken(env);
  if (!blob) blob = readCredentialFileToken(env);
  return blob ? { kind: 'bearer', token: blob.token, expiresAt: blob.expiresAt } : null;
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
  // Don't spend a request on a token we already know is expired — the CLI
  // refreshes it on its next API call (e.g. a chat). Report 'token-expired' so
  // the caller serves the cached catalog and tries live again later. A 30s skew
  // buffer avoids racing the exact expiry instant.
  if (credential.expiresAt && credential.expiresAt <= Date.now() + 30000) {
    return { catalog: null, reason: 'token-expired' };
  }
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

// When the running session crosses this many context tokens we summarize it and
// start fresh on the next turn. The threshold is WINDOW-AWARE: it must sit
// below the session's own context window or the gate never fires. A flat 500K
// (the 0.10.0 first cut) was wrong both ways — a 200K-window session can never
// reach 500K, so compaction was silently dead for it, and a 1M-window session
// got compacted at half its capacity. There's no user-facing 1M toggle anymore
// (1M is just whatever a model's real window is), so the gate reads the
// model's actual detected window instead of a variant flag:
//   - 200K window: 150K — fires with headroom before the wall.
//   - 1M window: 850K — leaves ~150K of headroom below the wall and clears
//     the summarizer's own headroom.
var COMPACT_THRESHOLD_STANDARD = 150000;
var COMPACT_THRESHOLD_1M = 850000;
export function compactThreshold(windowSize) {
  return windowSize >= 1000000 ? COMPACT_THRESHOLD_1M : COMPACT_THRESHOLD_STANDARD;
}

// Headroom the summarizer needs on top of the session it re-reads: its own
// ~400-word summary output + prompt + measurement slop. Small in absolute terms.
var COMPACT_SUMMARIZER_HEADROOM = 20000;

// Pick the model to summarize a session for compaction: ALWAYS the model that
// actually led the conversation, or nothing at all. Its cache is already warm,
// so the summarizer gets a cache-READ instead of a cold cache-WRITE.
//
// There is deliberately NO fallback to a different model. Summarizing on some
// other model would resume this session under a model whose cache is empty
// (caches are model-scoped), cold-writing the ENTIRE session at that model's
// write rate — measured at ~62K of cache_creation on one real fallback. So the
// fallback was both silent (the user's conversation quietly changed models) and
// expensive exactly when it fired. Returning null instead means compaction is
// skipped; the session then grows until the existing context-overflow path
// resets it, which is rare (the thresholds sit well inside each model's window)
// and at least tells the user what happened.
// Pure + capLookup-injected for test.
export function compactionSummarizerModel(lastModel, lastContextTokens, capLookup) {
  if (!lastModel) return null;
  var cap = capLookup ? capLookup(lastModel) : null;
  var windows = (cap && cap.contextWindows) || [];
  // No more opt-in: a model's real window is always whichever is largest.
  var effective = windows.length === 0 ? 0 : Math.max.apply(null, windows);
  return effective >= (lastContextTokens || 0) + COMPACT_SUMMARIZER_HEADROOM
    ? lastModel
    : null;
}

// Pure gate for the compaction decision, window-aware — exported so a test can
// prove the behavior (200K window fires at 150K, 1M window only near 800K)
// rather than re-asserting a constant.
export function shouldCompactSession(contextTokens, windowSize) {
  return (contextTokens || 0) >= compactThreshold(windowSize);
}

// Resolve which session id a turn should resume. Normally the panel-supplied id
// wins, falling back to the daemon's own. THE EXCEPTION: a compaction nulls the
// daemon's sessionId, but the panel keeps echoing the OLD id on the next turn —
// which resurrected the just-compacted huge session and re-compacted it every
// turn (summaries discarded, full cache re-read). So an id equal to the
// specifically-abandoned one is refused, forcing the fresh session (and its
// carried-forward summary) to take. Only that exact id is refused; any other
// live id is unaffected.
export function resolveSessionId(msgSessionId, currentSessionId, abandonedId) {
  var id = msgSessionId || currentSessionId || null;
  if (id && abandonedId && id === abandonedId) return null;
  return id;
}

// Which session a turn resumes. An explicit "start fresh" (Clear chat sets
// newConversation) forces a brand-new session regardless of any id the panel
// still echoes — otherwise Clear chat is cosmetic and the next message silently
// resumes the old session. Any other turn defers to resolveSessionId.
export function sessionIdForTurn(newConversation, msgSessionId, currentSessionId, abandonedId) {
  if (newConversation) return null;
  return resolveSessionId(msgSessionId, currentSessionId, abandonedId);
}

// Real total context a single API call processed = uncached input + tokens read
// from cache + tokens written to cache. The compaction gate MUST use this, not
// usage.input_tokens alone: input_tokens is only the uncached slice, which stays
// in the single digits to low tens once prompt caching is warm, so it never
// reaches COMPACT_THRESHOLD_TOKENS. Gating on it left the guard dead and let one
// session grow for 8 days / 437M cumulative cache-read tokens without a reset.
// See docs/2026-09-07-session-cost-investigation.md (root cause 1).
export function contextTokensFromUsage(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
}

// System-prompt additions describing the user's enabled connectors, appended after
// gaffer.md on a new conversation. Fixes a discovery gap: Grip's tool names are
// generic (get_document/get_page/search_nodes) and rarely mention Figma, so with a
// REST Figma connector also enabled the model reached for the REST one, found it
// unauthenticated, and wrongly told the user it had no Figma access — while Grip was
// connected to the open file the whole time. Naming Grip as THE live Figma connection
// fixes it; and since the panel has its own sign-in and no terminal, the model must
// never give /mcp / CLI advice for an unauthenticated connector. Pure + exported for test.
export function connectorPromptAdditions(enabledMcps) {
  var enabled = Array.isArray(enabledMcps) ? enabledMcps.filter(Boolean) : [];
  var out = '';
  if (enabled.indexOf('grip') !== -1) {
    out += '\n\n## Figma\n\nGrip is the live connection to the open Figma file and is the '
      + 'preferred way to work with Figma. Use Grip\'s tools for anything involving Figma: it '
      + 'sees unsaved and unpublished state and can edit the canvas. A REST-based Figma '
      + 'connector, if also enabled, only reads published data and cannot write, so prefer '
      + 'Grip for the document the user is looking at. If Grip reports no plugin connected, '
      + 'tell the user to run the Grip plugin in Figma, not that you have no Figma access.\n';
  }
  if (enabled.length) {
    out += '\n\n## Connectors\n\nIf an enabled connector turns out to be unauthenticated or '
      + 'unreachable, tell the user to open Gaffer Settings to connect it. Do NOT suggest '
      + 'running /mcp or any command-line step: this panel has its own sign-in and no terminal.\n';
  }
  return out;
}

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

export class ChatHandler {
  constructor(opts) {
    opts = opts || {};
    this.activeProcess = null;
    this.sessionId = null;
    this.lastContextTokens = 0;
    this.compactedSummary = null;
    this.compacting = false;
    this.claudeBin = null;
    this.envForSpawn = null;
    this.liveModelCapabilities = null;
    // Last catalog that came back live from the account. Served as a fallback
    // when the OAuth token is momentarily expired (the daemon can't refresh it;
    // the CLI does on its next API call). It IS real entitlement proof — it was
    // fetched live from this account — so serving it isn't the "stale CLI alias"
    // problem the fail-closed rule guards against.
    this.cachedCatalog = null;
    // Persisted TTL cache of the model catalog: { catalog, fetchedAt, accountId }
    // written next to .gaffer-config.json (same panel dir), so a fresh catalog
    // survives daemon restarts (frequent since v0.9.5's restart-on-update) and
    // avoids a network round-trip on Settings open. Path is injectable for
    // tests (and via env) so tests never touch the real install's cache.
    this._cacheFilePath = opts.cacheFilePath
      || process.env.GAFFER_MODEL_CACHE_PATH
      || join(PANEL_DIR, '.gaffer-model-cache.json');
    // Injection seams (tests): fetch, account identity, and clock.
    this._fetchCatalog = opts.fetchCatalog || null; // else module fetchModelCatalog
    this._accountIdFn = opts.accountIdFn || null;    // else resolve from disk config
    this._now = opts.now || Date.now;                // clock for TTL/fetchedAt
  }

  // Resolve a stable identity for the currently signed-in account from disk
  // (fast — no subprocess, no network) so keying the cache never slows a
  // cache-hit open. Never throws — null on any failure, which callers treat as
  // "can't confirm the account" (go live, don't serve a persisted catalog as
  // fresh, never cross-serve accounts).
  async _resolveAccountId() {
    if (this._accountIdFn) {
      try { return await this._accountIdFn(); } catch (e) { return null; }
    }
    return accountIdFromEnvAndConfig(augmentedEnv());
  }

  // Read the persisted cache. Tolerant of a missing/corrupt/foreign file:
  // any problem => null (treated as no cache). Returns
  // { catalog, fetchedAt, accountId } or null.
  _loadPersistedCache() {
    try {
      var obj = JSON.parse(readFileSync(this._cacheFilePath, 'utf8'));
      if (!obj || typeof obj !== 'object') return null;
      if (!obj.catalog || typeof obj.catalog !== 'object') return null;
      if (typeof obj.fetchedAt !== 'number' || !isFinite(obj.fetchedAt)) return null;
      return {
        catalog: obj.catalog,
        fetchedAt: obj.fetchedAt,
        accountId: obj.accountId != null ? String(obj.accountId) : null,
      };
    } catch (e) { return null; }
  }

  // Persist a freshly fetched catalog. Best-effort: a read-only/again-Dropbox'd
  // fs just means the next open refetches. Never throws.
  _writePersistedCache(catalog, accountId) {
    try {
      writeFileSync(this._cacheFilePath, JSON.stringify({
        catalog: catalog,
        fetchedAt: this._now(),
        accountId: accountId != null ? String(accountId) : null,
      }), 'utf8');
    } catch (e) { /* best-effort */ }
  }

  // A persisted cache is fresh when it belongs to the current account and its
  // fetchedAt is within the TTL. Clock skew defense: a non-finite or future
  // (negative age) timestamp counts as stale, never as infinitely fresh.
  _isPersistedCacheFresh(persisted, currentAccountId) {
    if (!accountMatches(persisted, currentAccountId)) return false;
    var age = this._now() - persisted.fetchedAt;
    return age >= 0 && age <= MODEL_CACHE_TTL_MS;
  }

  // Drop the persisted + in-memory cache. Called on sign-in/sign-out so a
  // different account never sees the previous account's models.
  invalidateModelCache() {
    this.cachedCatalog = null;
    this.liveModelCapabilities = null;
    try { unlinkSync(this._cacheFilePath); } catch (e) { /* already gone */ }
  }

  // Discover the account's currently callable models from Anthropic's live
  // catalog. Live when the token is valid; on a momentary expiry it serves the
  // last live catalog (refreshed automatically the next time the token is
  // valid, e.g. right after a chat — see refreshCatalogInBackground).
  async listModelOptions() {
    var currentAccountId = await this._resolveAccountId();
    var persisted = this._loadPersistedCache();

    // 1) Fresh persisted cache for THIS account → resolve straight from disk,
    //    no network. `fromCache:true` lets the panel skip the spinner (a
    //    disk+WS round-trip is single-digit ms). Presents as a normal live
    //    catalog (modelAccess 'ready') so the picker is identical to a fetch.
    if (this._isPersistedCacheFresh(persisted, currentAccountId)) {
      this.cachedCatalog = persisted.catalog;
      this.liveModelCapabilities = persisted.catalog.capabilitiesByModel;
      return Object.assign({}, persisted.catalog, {
        live: true, modelAccess: 'ready', fromCache: true,
      });
    }

    // 2) Stale/missing/foreign-account cache → live fetch. `_fetchCatalog` is an
    //    injection seam for tests; defaults to the live fetch.
    var result = await (this._fetchCatalog || fetchModelCatalog)(augmentedEnv());
    if (result && result.catalog) {
      this.liveModelCapabilities = result.catalog.capabilitiesByModel;
      this.cachedCatalog = result.catalog;
      this._writePersistedCache(result.catalog, currentAccountId);
      return result.catalog;
    }

    // 3) Live fetch failed (token expired / unauthorized / network). Serve a
    //    usable cache if we have one — the in-memory catalog, or the persisted
    //    one for THIS account even if slightly past TTL — flagged cached rather
    //    than failing closed. (The persisted match keeps working across a daemon
    //    restart that emptied the in-memory catalog.)
    var fallback = this.cachedCatalog
      || (accountMatches(persisted, currentAccountId) ? persisted.catalog : null);
    if (fallback) {
      this.cachedCatalog = fallback;
      this.liveModelCapabilities = fallback.capabilitiesByModel;
      return Object.assign({}, fallback, {
        live: true, modelAccess: 'cached', cached: true,
      });
    }
    // 4) No live catalog ever, and none cached. Fail closed: don't surface CLI
    //    aliases the account may not be entitled to. Settings shows retry; the
    //    next chat refreshes the token and discovery goes live.
    this.liveModelCapabilities = null;
    return {
      models: [], efforts: [], effortsByModel: {}, capabilitiesByModel: {},
      versions: {}, capabilitySource: 'unavailable', entitlement: 'unknown',
      live: false, modelAccess: result && result.reason ? result.reason : 'unavailable',
    };
  }

  // After the CLI makes an API call the OAuth token is fresh again; opportunist-
  // ically refresh the cached catalog so a later Settings open (with a possibly
  // expired token) still shows current models. Fire-and-forget, throttled.
  refreshCatalogInBackground() {
    var now = Date.now();
    if (this._catalogRefreshInFlight) return;
    if (this._lastCatalogRefresh && now - this._lastCatalogRefresh < 60000) return;
    this._catalogRefreshInFlight = true;
    this._lastCatalogRefresh = now;
    // Resolve the account first so the write-through keys the persisted cache
    // to the current identity — keeping active users current on disk without
    // ever blocking a Settings open on a fetch.
    Promise.resolve(this._resolveAccountId()).then((accountId) => {
      return fetchModelCatalog(augmentedEnv()).then((result) => {
        if (result && result.catalog) {
          this.cachedCatalog = result.catalog;
          this.liveModelCapabilities = result.catalog.capabilitiesByModel;
          this._writePersistedCache(result.catalog, accountId);
        }
      });
    }).catch(() => {}).finally(() => { this._catalogRefreshInFlight = false; });
  }

  async handleChat(msg, socket) {
    this.cancel();
    this._lastEmit = null;
    this._toolNames = {};
    // Reset per-turn context occupancy so the compaction gate can only ever read
    // a value THIS turn actually measured (repopulated from assistant-step usage
    // in _processEvent). Structurally prevents a stale value from a prior turn or
    // a dropped session — sessionId is nulled in several paths that historically
    // did not clear this — from leaking into the gate.
    this.lastContextTokens = 0;

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

    // Keep the default consistent for older panels and headless callers
    // that omit advanced settings: Opus Latest at Medium effort.
    var model = msg.model || 'opus';
    // Chat always runs on exactly the requested model/effort — no automatic
    // switching. requestedModel mirrors the final model for telemetry.
    var requestedModel = model;
    var effort = msg.effort || 'medium';
    // Validate advanced controls against the same model matrix sent to
    // Settings. This is a server-side guard for stale panels or hand-crafted
    // websocket messages; the UI also hides unsupported choices. Account/plan
    // entitlement remains Claude's decision and may still reject a valid
    // capability at request time.
    var capability = (this.liveModelCapabilities && this.liveModelCapabilities[model])
      || modelCapability(model, null);
    if (effort && capability.efforts.indexOf(effort) === -1) effort = null;
    // Retained (not just local vars) so the 'result' event handler below can
    // read them for telemetry once the turn completes.
    this._lastModel = model;
    this._lastRequestedModel = requestedModel;
    // The compaction gate reads the model's real context window (no more 1M
    // opt-in toggle — a model's window is just whatever it actually supports).
    this._lastWindow = Math.max.apply(null, capability.contextWindows);
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

    // Tell the model what its enabled connectors are for (Grip is the live Figma
    // connection) and that unauthenticated connectors are a Settings problem, not a
    // /mcp one. Pure + exported so a test can prove the copy. Only appended on a new
    // conversation, below, same as the rest of the system prompt.
    systemPrompt += connectorPromptAdditions(enabled);

    // An explicit "start fresh" from the panel (Clear chat) unconditionally
    // drops the daemon's held session BEFORE resolveSessionId runs — distinct
    // from an absent id, which just means the panel hasn't loaded one yet and
    // should resume what the daemon holds. Without this, Clear chat is cosmetic:
    // the daemon keeps its id and the next message silently resumes the old
    // (possibly huge) session behind an empty window.
    if (msg.newConversation) {
      this.sessionId = null;
      this._abandonedSessionId = null;
    }
    // sessionIdForTurn forces fresh on newConversation (Clear chat); otherwise
    // resolveSessionId refuses the just-abandoned id so a fresh (summarized)
    // session takes instead of the panel re-echoing the huge one back.
    var sessionId = sessionIdForTurn(msg.newConversation, msg.sessionId, this.sessionId, this._abandonedSessionId);
    if (!sessionId) this.sessionId = null; // honor the reset even if the panel re-sent the old id
    // Latch is one-shot: once we've gone fresh past the abandoned id, forget it.
    if (this._abandonedSessionId && (msg.sessionId === this._abandonedSessionId || !sessionId)) {
      this._abandonedSessionId = null;
    }
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
    // for tracing what a panel selection maps to.
    console.log('Gaffer chat spawn: --model ' + model
      + (effort && EFFORTS.indexOf(effort) !== -1 ? ' --effort ' + effort : ' (no --effort)')
      + ' | window=' + this._lastWindow
      + ' resume=' + (sessionId ? 'yes' : 'new'));

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
          socket.send(JSON.stringify({ type: 'chat_event', message: 'Previous session expired, starting a fresh one.' }));
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
      // The chat just made an API call, so the CLI refreshed the OAuth token.
      // Opportunistically refresh the cached model catalog while it's valid, so
      // a later Settings open still shows current models even if the token has
      // since lapsed. Fire-and-forget, throttled.
      this.refreshCatalogInBackground();
      // Image-pruning DISABLED (2026-09-07). pruneSessionFile() rewrote old
      // image blocks in the transcript to shed their tokens, but rewriting any
      // earlier message changes the cached prompt prefix and INVALIDATES the
      // cache for everything after it, forcing a full, cache-write-priced
      // rewrite of the downstream context that costs far more than the image
      // tokens it saved (measured: one prune was followed by a call writing
      // 280,132 fresh tokens). Session growth is now bounded by the compaction
      // gate below (fixed in the same change), so mid-session pruning is all
      // cost and no benefit. See docs/2026-09-07-session-cost-investigation.md
      // (root cause 2). To revisit, prune only in a way that never rewrites an
      // already-cached prefix; session-pruner.js stays as the reference impl.
      // If the session is approaching the context wall, summarize it now in
      // the background so the next user turn can start fresh with continuity.
      if (this.sessionId && shouldCompactSession(this.lastContextTokens, this._lastWindow) && !this.compacting) {
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

    // Track CURRENT context-window occupancy from each assistant step's own
    // usage (input + cache_read + cache_creation of THIS step). This is the live
    // window size the compaction gate needs. It is deliberately NOT taken from
    // the `result` event, whose usage is CUMULATIVE across every tool round-trip
    // in the turn — each round-trip re-reads the full context from cache, so on a
    // multi-tool turn the result usage is a large multiple of the real window and
    // spuriously trips the gate (fired compaction at ~80K real context in the
    // 2026-09-12 regression). The last assistant step's usage is the true
    // occupancy. See docs/2026-09-07-session-cost-investigation.md.
    if (event.type === 'assistant' && event.message && event.message.usage) {
      this.lastContextTokens = contextTokensFromUsage(event.message.usage);
    }

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
              error: 'Conversation too long for the model. Session reset, your next message starts a fresh context.',
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
          error: 'Conversation too long for the model. Session reset, your next message starts a fresh context.',
        }));
        return;
      }
      this.sessionId = event.session_id || this.sessionId;
      // NOTE: lastContextTokens is intentionally NOT set here. The `result`
      // event's usage is CUMULATIVE across the whole turn (every tool
      // round-trip's cache reads summed), which over-counts the real window on a
      // multi-tool turn and spuriously trips the compaction gate. Occupancy is
      // tracked per assistant step at the top of _processEvent instead. The
      // cumulative figure IS correct for cost, so telemetry below still uses it.
      // Usage telemetry — model name + token counts + cost estimate only,
      // never prompt/response content. Always recorded regardless of the
      // sharing toggle (telemetry.js decides whether to actually send it);
      // errors inside recordUsage are caught there and never reach here.
      try {
        var usage = event.usage || {};
        telemetry.recordUsage({
          model: this._lastModel,
          requestedModel: this._lastRequestedModel,
          aeVersion: socket && socket._gafferKey,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheCreationTokens: usage.cache_creation_input_tokens,
          costUsd: event.total_cost_usd,
        });
      } catch (e) {
        console.error('Gaffer telemetry: recordUsage call failed (ignored)', e.message);
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
    var resumingId = this.sessionId;
    // Summarize on the model that led the conversation, or not at all — never
    // silently on another model (see compactionSummarizerModel).
    var self = this;
    var summarizer = compactionSummarizerModel(this._lastModel, this.lastContextTokens, function (id) {
      return (self.liveModelCapabilities && self.liveModelCapabilities[id]) || modelCapability(id, null);
    });
    if (!summarizer) {
      // The conversation outgrew what its own model can re-read in one call.
      // Skipping beats both a doomed full-context call and a silent model swap;
      // the session continues until the context-overflow path resets it.
      console.log('Gaffer compact: skipped — ' + (this._lastModel || 'unknown model')
        + ' cannot re-read ' + this.lastContextTokens + ' tokens, and we never summarize on another model');
      return;
    }
    this.compacting = true;
    console.log('Gaffer compact: summarizing on ' + summarizer + ' (leading model, warm cache)');
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({
        type: 'chat_event',
        event: 'compacting',
        message: 'Summarizing older messages to keep this conversation fast and cheap…',
      }));
    }

    var args = ['-p', '--model', summarizer, '--resume', resumingId, '--dangerously-skip-permissions'];
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
        // Drop the bloated session so the next chat starts fresh; the summary
        // will be prepended to the next user message. Remember the abandoned id:
        // the panel still holds it and will re-send it next turn, so
        // resolveSessionId must refuse it or the huge session is resurrected and
        // re-compacted every turn (the loop that burned ~$6/turn).
        this._abandonedSessionId = resumingId;
        this.sessionId = null;
        this.lastContextTokens = 0;
        if (socket && socket.readyState === 1) {
          socket.send(JSON.stringify({
            type: 'chat_event',
            event: 'compacted',
            message: 'Conversation compacted. Continuing with summary.',
            // Tell the panel the session was reset so it stops echoing the dead
            // id (defense-in-depth; the daemon latch already refuses it).
            sessionId: null,
          }));
        }
      } else {
        if (socket && socket.readyState === 1) {
          socket.send(JSON.stringify({
            type: 'chat_event',
            event: 'compact_failed',
            message: 'Could not compact conversation, context will reset on overflow.',
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
