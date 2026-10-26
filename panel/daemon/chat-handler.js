import { spawn, execFile } from 'node:child_process';
import { findClaudeBinary, lastClaudeLookup } from './claude-binary.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpUrl } from './ports.js';
// session-pruner.js intentionally not imported: mid-session pruning was disabled
// (2026-09-07, root cause 2) because it invalidates the prompt cache. See below.
import * as telemetry from './telemetry.js';
import { newTurnState, observe, classify, userMessage as turnUserMessage, versionDetail, versionNotice } from './cli-contract.js';
// Vendored shared module (panel/daemon/vendor, see CLAUDE.md): live model
// discovery. Change it in its own repo, then `npm run sync-vendor`.
import { createModelCatalog, EFFORT_LEVELS } from './vendor/claude-model-catalog/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The "Claude Code is outside the tested range" notice goes out at most once
// per panel socket: a second AE instance has its own socket and gets its own
// copy, and a panel that reconnects (new socket) is told again once. The
// daemon log line goes out once per version string per daemon life, whatever
// the panels do, so the log stays readable.
var cliVersionNoticedSockets = new WeakSet();
var cliVersionLogged = {};
export function resetCliVersionNoticeForTests() {
  cliVersionNoticedSockets = new WeakSet();
  cliVersionLogged = {};
}

// After the first init event that names a CLI version: if it is outside
// LAST_VERIFIED, log once and send one chat_event notice (the panel renders
// it as an ordinary chat notice). A patch a little above the tested max is
// the normal state of most installs, so it only gets the log line. Warn
// only: never blocks, never changes the spawn, never throws; an unknown or
// unparsable version shows nothing. The per-socket flag is set only after
// the send went through, so a closed socket does not swallow the notice.
function maybeNoticeCliVersion(version, socket) {
  if (!version) return;
  try {
    var d = versionDetail(version);
    if (d.status === 'unknown') return;
    var outOfRange = d.status === 'newer' || d.status === 'older';
    if (!outOfRange && !d.aboveMax) return;
    if (!cliVersionLogged[d.shown]) {
      cliVersionLogged[d.shown] = true;
      console.log(outOfRange
        ? 'Gaffer chat: Claude Code ' + d.shown + ' is ' + d.status + ' than the tested range, notifying each panel once'
        : 'Gaffer chat: Claude Code ' + d.shown + ' is a few patches above the tested range, no notice shown');
    }
    if (!outOfRange) return;
    if (!socket || typeof socket !== 'object' || cliVersionNoticedSockets.has(socket)) return;
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify({ type: 'chat_event', event: 'cli_version', message: versionNotice(version) }));
    cliVersionNoticedSockets.add(socket);
  } catch (e) { /* a notice must never affect the turn */ }
}

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

// Live model discovery runs on the vendored claude-model-catalog module
// (panel/daemon/vendor/claude-model-catalog, synced with `npm run sync-vendor`,
// never edited here): GET /v1/models with the Claude Code credential, a
// per-account 24h cache on disk, a stale same-account fallback, fail closed.
// Gaffer keeps three things on its side: where the cache file lives, the
// adapter below that turns the module's catalog into the panel's models
// payload (so panel/main.js is unchanged), and modelCapability(), the
// hardcoded fallback table used before the first discovery.

// Disposable cache in the panel dir (unlike the per-install config, which
// lives in the OS app-data folder) so a fresh catalog survives daemon restarts
// and a Settings open skips the network. Read at call time so a test's
// GAFFER_MODEL_CACHE_PATH applies.
export function modelCacheFilePath() {
  return process.env.GAFFER_MODEL_CACHE_PATH || join(PANEL_DIR, '.gaffer-model-cache.json');
}

// The catalog Gaffer uses: the module with Gaffer's cache file, Gaffer's
// sanitised env (so the credential and account resolve the same way the CLI
// child does) and the daemon log. No userAgent: the module sends none, and the
// old spoofed "claude-code/2.1.236" header is gone on purpose. `overrides`
// (fetch, readCredential, readAccountId, now, log, cacheFile) are the test
// seams; production passes nothing. A key set to undefined is dropped, so
// `{ cacheFile: undefined }` keeps the default cache file.
export function createGafferModelCatalog(overrides) {
  var o = {};
  Object.keys(overrides || {}).forEach(function (k) {
    if (overrides[k] !== undefined) o[k] = overrides[k];
  });
  return createModelCatalog(Object.assign({
    cacheFile: modelCacheFilePath(),
    env: augmentedEnv,
    // The module calls this on every failed live fetch with the reason and the
    // HTTP status or exception message, never the token. The message can echo
    // ANTHROPIC_BASE_URL through a fetch error, so URL userinfo is scrubbed.
    log: function (level, message) {
      var line = 'Gaffer: ' + scrubLogMessage(message);
      if (level === 'warn' || level === 'error') console.warn(line); else console.log(line);
    },
  }, o));
}

// Strips `user:pass@` from any URL-looking text (scheme://userinfo@host) so a
// base URL that carries credentials never reaches the daemon log.
export function scrubLogMessage(message) {
  return String(message).replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');
}

// Module catalog { families, versions: { family: [entry newest first] } } with
// entry { id, family, label, displayName, maxInputTokens, maxOutputTokens,
// oneM, efforts } to the panel's models payload: the same fields the old
// modelCatalogOptions produced from the raw /v1/models rows. The family alias
// (opus, sonnet, ...) maps to its newest version's capability object, the
// same object, as before. Pure; null for a null or malformed catalog.
export function catalogToPanel(catalog) {
  if (!catalog || !Array.isArray(catalog.families) || !catalog.versions || typeof catalog.versions !== 'object') return null;
  var versions = {};
  var capabilitiesByModel = {};
  var effortsByModel = {};
  var families = catalog.families.slice();
  Object.keys(catalog.versions).forEach(function (family) {
    if (families.indexOf(family) === -1) families.push(family);
  });
  families.forEach(function (family) {
    // The cache file is on disk and may be hand edited or truncated: an entry
    // that is not an object with a string id is skipped, never thrown on.
    var entries = (Array.isArray(catalog.versions[family]) ? catalog.versions[family] : []).filter(function (entry) {
      return !!entry && typeof entry === 'object' && typeof entry.id === 'string';
    });
    versions[family] = entries.map(function (entry) { return entry.id; });
    entries.forEach(function (entry) {
      var efforts = Array.isArray(entry.efforts) ? entry.efforts.slice() : [];
      var cap = {
        oneM: !!entry.oneM,
        contextWindows: entry.oneM ? [200000, 1000000] : [200000],
        efforts: efforts,
        source: 'anthropic-v1-models',
        entitlement: 'account-server',
        modelId: entry.id,
        displayName: entry.displayName || entry.id,
        maxInputTokens: entry.maxInputTokens || null,
        maxOutputTokens: entry.maxOutputTokens || null,
      };
      capabilitiesByModel[entry.id] = cap;
      effortsByModel[entry.id] = efforts;
    });
    if (entries.length) {
      capabilitiesByModel[family] = capabilitiesByModel[entries[0].id];
      effortsByModel[family] = effortsByModel[entries[0].id];
    }
  });
  var efforts = EFFORT_LEVELS.filter(function (level) {
    return Object.keys(effortsByModel).some(function (key) { return effortsByModel[key].indexOf(level) !== -1; });
  });
  return {
    models: families,
    efforts: efforts,
    effortsByModel: effortsByModel,
    capabilitiesByModel: capabilitiesByModel,
    versions: versions,
    capabilitySource: 'anthropic-v1-models',
    entitlement: 'account-server',
    live: true,
  };
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
    console.log('Gaffer: icon fetch: ' + found + '/' + misses.length + ' resolved');
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
  return claudeChildEnv({ ...process.env, PATH: pathParts.join(':') }, process.platform);
}

// Decision D7 (zero-dependency install): the launchers strip
// NODE_EXTRA_CA_CERTS from the daemon and pass the original value on as
// GAFFER_CLAUDE_EXTRA_CA_CERTS. Claude Code honours NODE_EXTRA_CA_CERTS
// behind TLS-inspecting corporate proxies, so restore it here, in a copy used
// only for claude children; the stash variable itself never reaches the
// child and the daemon's own env is untouched. With no (or an empty) stash
// the env is returned as is, so a dev run that set NODE_EXTRA_CA_CERTS
// directly keeps it. Names match case-insensitively on win32.
var CA_VAR = 'NODE_EXTRA_CA_CERTS';
var CA_STASH = 'GAFFER_CLAUDE_EXTRA_CA_CERTS';
export function claudeChildEnv(env, platform) {
  var isWin = (platform || process.platform) === 'win32';
  var same = function (a, b) { return isWin ? String(a).toUpperCase() === b : a === b; };
  var out = {};
  var stash;
  for (var k of Object.keys(env || {})) {
    if (same(k, CA_STASH)) { if (stash === undefined) stash = env[k]; continue; }
    out[k] = env[k];
  }
  if (stash === undefined || stash === '') return out;
  for (var key of Object.keys(out)) {
    if (same(key, CA_VAR)) delete out[key];
  }
  out[CA_VAR] = stash;
  return out;
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
    // The model catalog (vendored claude-model-catalog, see
    // createGafferModelCatalog). Account-level state, so index.js builds ONE
    // and hands it to every per-panel handler; a handler built without one
    // (tests, headless use) gets its own on the Gaffer cache file
    // (GAFFER_MODEL_CACHE_PATH, else the panel dir). cacheFilePath is a seam
    // so a test never touches the real cache; left out, the default applies.
    this.modelCatalog = opts.modelCatalog || createGafferModelCatalog(
      opts.cacheFilePath ? { cacheFile: opts.cacheFilePath } : {});
    // Set after a discovery that failed closed, so the panel's Retry ("Try
    // again") forces a live fetch past any cache instead of re-serving it.
    this._modelsRetryPending = false;
    // Memo of catalogToPanel() keyed on the catalog object identity, for the
    // liveModelCapabilities getter (read on every chat turn).
    this._panelCatalogFor = null;
    this._panelCatalog = null;
    // Process seams (tests drive a fake child instead of a real `claude`).
    // Production: node's spawn and the real binary lookup, unchanged.
    this._spawn = opts.spawn || spawn;
    this._findClaudeBinary = opts.findClaudeBinary || findClaudeBinary;
    // Which lookup step found the binary and its `--version` line (telemetry
    // and the spawn log). Never the path.
    this._lastClaudeLookup = opts.lastClaudeLookup || lastClaudeLookup;
    // Classifier state of the turn in flight, so the result handler can read
    // the CLI version the init event reported.
    this._turnState = null;
    // Called with the socket when a turn fails because Claude is not signed in,
    // so the owner (index.js) can re-push the account card's auth status.
    this._onAuthError = opts.onAuthError || null;
  }

  // { version, source } of the binary the last lookup settled on, for logs
  // and telemetry: the version as `--version` printed it (or 'unknown') and
  // the telemetry source enum. Never throws, never includes the path.
  _claudeLookupInfo() {
    var info = null;
    try { info = this._lastClaudeLookup(); } catch (e) { info = null; }
    return {
      version: (info && info.version) || 'unknown',
      source: telemetry.cliSourceFromStep(info && info.step),
    };
  }

  // The last discovered catalog as the panel payload (memoised per catalog
  // object), or null before the first discovery. The module's peek() is the
  // last catalog this daemon fetched or read from disk: real entitlement proof
  // from this account, so the effort guard and the compaction summarizer read
  // it before falling back to modelCapability()'s table.
  // Never throws: this is read on the chat path outside any try, and a bad
  // catalog must degrade to the fallback table, not kill the daemon.
  _panelCatalogNow() {
    try {
      var catalog = this.modelCatalog.peek();
      if (!catalog) return null;
      if (catalog !== this._panelCatalogFor) {
        this._panelCatalogFor = catalog;
        this._panelCatalog = catalogToPanel(catalog);
      }
      return this._panelCatalog;
    } catch (e) {
      return null;
    }
  }

  // Per-model capability map from the live catalog, or null (callers then use
  // modelCapability()). Read-only: the catalog owns the state. Never throws.
  get liveModelCapabilities() {
    try {
      var panel = this._panelCatalogNow();
      return panel && panel.capabilitiesByModel ? panel.capabilitiesByModel : null;
    } catch (e) {
      return null;
    }
  }

  // Sign-in / sign-out: forget everything tied to the old account (memory and
  // the disk cache) so a different account never sees the previous account's
  // models. The catalog is shared across panels, so one call covers them all.
  invalidateModelCache() {
    this.modelCatalog.invalidate();
    this._modelsRetryPending = false;
  }

  // Discover the account's currently callable models from Anthropic's live
  // catalog (module cache ladder: fresh same-account disk cache, else live
  // fetch, else a stale same-account cache, else fail closed) and map the
  // result to the panel's models payload:
  //   ready   -> live catalog, modelAccess 'ready', fromCache when served
  //              from disk (the panel skips the spinner)
  //   cached  -> the stale same-account fallback after a failed fetch,
  //              modelAccess 'cached', cached: true; still usable
  //   other   -> the empty payload with modelAccess = the failure reason
  //              (no-credential, token-expired, unauthorized, network,
  //              invalid-response); the panel shows "Try again"
  // `force` (or a pending Retry after a failure) bypasses a fresh cache.
  async listModelOptions(opts) {
    var force = !!((opts && opts.force) || this._modelsRetryPending);
    var r = await this.modelCatalog.get({ force: force });
    var usable = r.status === 'ready' || r.status === 'cached';
    this._modelsRetryPending = !usable;
    if (r.status === 'ready') {
      var ready = Object.assign(catalogToPanel(r.catalog), { modelAccess: 'ready' });
      if (r.fromCache) ready.fromCache = true;
      return ready;
    }
    if (r.status === 'cached') {
      return Object.assign(catalogToPanel(r.catalog), { modelAccess: 'cached', cached: true });
    }
    // Fail closed: don't surface CLI aliases the account may not be entitled
    // to. Settings shows Retry; the next chat refreshes the token and the
    // background refresh goes live.
    return {
      models: [], efforts: [], effortsByModel: {}, capabilitiesByModel: {},
      versions: {}, capabilitySource: 'unavailable', entitlement: 'unknown',
      live: false, modelAccess: r.status || 'unavailable',
    };
  }

  // After the CLI makes an API call the OAuth token is fresh again; opportunist-
  // ically refresh the cached catalog so a later Settings open (with a possibly
  // expired token) still shows current models. Fire-and-forget; the module
  // throttles it to once per 60s and never rejects.
  refreshCatalogInBackground() {
    var self = this;
    var p;
    try { p = this.modelCatalog.refreshInBackground(); } catch (e) { return; }
    // A refresh that produced a catalog resolves the panel's pending Retry:
    // the next list_models may serve the cache again.
    Promise.resolve(p).then(function () {
      try { if (self.modelCatalog.peek()) self._modelsRetryPending = false; } catch (e) { /* keep the flag */ }
    }).catch(function () {});
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
      var claudeBin = await this._findClaudeBinary();
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
    args.push('--mcp-config', JSON.stringify({ mcpServers: { gaffer: { type: 'http', url: mcpUrl() } } }));

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
    var lookup = this._claudeLookupInfo();
    console.log('Gaffer chat spawn: --model ' + model
      + (effort && EFFORTS.indexOf(effort) !== -1 ? ' --effort ' + effort : ' (no --effort)')
      + ' | window=' + this._lastWindow
      + ' resume=' + (sessionId ? 'yes' : 'new')
      + ' cli=' + lookup.version + ' source=' + lookup.source);

    // Cache for the background compaction call.
    this.claudeBin = claudeBin;
    this.envForSpawn = env;

    // Prepend a continuity briefing if we just compacted the previous session.
    var userMessage = msg.message;
    if (this.compactedSummary && !sessionId) {
      userMessage = "[Continuity from previous compacted session]\n" + this.compactedSummary + "\n\n[New message]\n" + userMessage;
      this.compactedSummary = null;
    }

    var child = this._spawn(claudeBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env,
      windowsHide: true, // console-subsystem children flash a cmd window otherwise
    });
    this.activeProcess = child;

    child.stdin.write(userMessage);
    child.stdin.end();

    var buffer = '';
    var stderrBuf = '';
    var self = this;
    // Per-turn classifier state (cli-contract.js). Every parsed event is
    // observed before Gaffer's own handling; at close, classify() decides what
    // the turn was from structured fields first, CLI text second.
    var st = newTurnState(!!sessionId);
    this._turnState = st;
    var loggedBadLine = false;

    // One stdout line. A JSON parse failure is not an event and is ignored
    // (logged once per turn); an exception inside event handling is a Gaffer
    // bug or a shape change and is logged with the event type, never allowed
    // to kill the turn. The two failures used to share one silent catch.
    var handleLine = (line) => {
      var event;
      try {
        event = JSON.parse(line);
      } catch (e) {
        if (!loggedBadLine) {
          loggedBadLine = true;
          console.log('Gaffer chat: ignoring non-JSON stdout line: ' + line.slice(0, 200));
        }
        return;
      }
      observe(st, event);
      if (st.sawInit && st.cliVersion) maybeNoticeCliVersion(st.cliVersion, socket);
      try {
        this._processEvent(event, socket);
      } catch (e) {
        console.error('Gaffer chat: event handling failed for type=' + (event && event.type)
          + ': ' + (e && e.message ? e.message : e));
      }
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      var lines = buffer.split('\n');
      buffer = lines.pop();
      for (var line of lines) {
        if (line.trim()) handleLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      console.error('Gaffer chat stderr:', chunk.toString().substring(0, 200));
    });

    child.on('close', (code) => {
      this.activeProcess = null;
      // Process remaining buffer
      if (buffer.trim()) handleLine(buffer);
      // A spawn failure already reported itself from the 'error' handler.
      if (child._spawnErrored) return;

      // Exactly one outcome per turn. A user cancel (SIGTERM) is not a failure
      // and is never classified; it ends with chat_done as before.
      var verdict = child._userCancelled ? { kind: 'ok', via: 'none' } : classify(st, code, stderrBuf);
      if (!child._userCancelled) {
        console.log('Gaffer chat: turn=' + verdict.kind + ' via=' + verdict.via
          + ' cli=' + (st.cliVersion || 'unknown') + ' exit=' + code
          // A successful result followed by a non-zero or null exit: the
          // turn is still ok, but the odd exit is worth a trace.
          + (verdict.kind === 'ok' && verdict.exitCode !== undefined ? ' okDespiteExit=' + verdict.exitCode : ''));
        // Per-day failure counters (kind + text_fallback), never the text.
        if (verdict.kind !== 'ok') telemetry.recordTurnKind(verdict.kind, verdict.via);
      }

      // Self-heal a dead --resume: the CLI's session storage can be wiped
      // by CLI updates or re-auth, leaving our persisted sessionId pointing
      // nowhere. The classifier reads the structured shape of a failed resume
      // (text only as fallback), and _processEvent never adopts a session id
      // from an error result, so the dead id cannot be persisted. Retry once
      // fresh (history text is preserved panel-side).
      if (verdict.kind === 'stale_session' && sessionId && !msg.__retriedFreshSession) {
        console.log('Gaffer: stale session ' + sessionId + ': retrying fresh');
        self.sessionId = null;
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'chat_event', message: 'Previous session expired, starting a fresh one.' }));
        }
        var retryMsg = Object.assign({}, msg, { sessionId: null, __retriedFreshSession: true });
        self.handleChat(retryMsg, socket);
        return; // the retry emits its own chat_done/chat_error
      }
      if (verdict.kind === 'too_long') {
        // Context overflow: drop the session so the next resume does not hit
        // the same wall. The user keeps chatting in a fresh context.
        this.sessionId = null;
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({
            type: 'chat_error',
            error: 'Conversation too long for the model. Session reset, your next message starts a fresh context.',
          }));
        }
        return;
      }
      if (verdict.kind !== 'ok') {
        // auth, model, api_error, unknown_error, or a stale_session we cannot
        // retry: the CLI's failure reaches the panel as an error, never as a
        // reply and never as an empty bubble.
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'chat_error', error: turnUserMessage(verdict) }));
        }
        if (verdict.kind === 'auth' && typeof this._onAuthError === 'function') {
          try { this._onAuthError(socket); } catch (e) { /* status re-push is best-effort */ }
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
      child._spawnErrored = true; // a following 'close' must not report a second outcome
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

    // An API failure (bad model, signed out, prompt too long) arrives as an
    // assistant event flagged is_api_error_message whose text is the CLI's raw
    // error. That text must not stream into the bubble; the close handler
    // reports the turn as an error with friendly copy (cli-contract.js).
    var apiErrorText = event.type === 'assistant' && event.is_api_error_message === true;
    if (event.type === 'assistant' && event.message && event.message.content) {
      for (var block of event.message.content) {
        if (block.type === 'text' && block.text && !apiErrorText) {
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
      // Error results (failed resume, overflow, signed out, bad model) echo a
      // session id that must never be adopted or persisted: a failed resume
      // echoes the dead id, and an overflowed session would hit the same wall.
      // What the failure was is decided once, at process close, by classify().
      var isErrorResult = event.is_error === true;
      if (!isErrorResult) this.sessionId = event.session_id || this.sessionId;
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
        // Claude Code version: the stream's own init event first, the
        // lookup's `--version` line as fallback. telemetry.js reduces either
        // to "x.y.z" and the source to a closed enum before storing.
        var lookupInfo = this._claudeLookupInfo();
        telemetry.recordUsage({
          model: this._lastModel,
          requestedModel: this._lastRequestedModel,
          aeVersion: socket && socket._gafferKey,
          cliVersion: (this._turnState && this._turnState.cliVersion) || lookupInfo.version,
          cliSource: lookupInfo.source,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheCreationTokens: usage.cache_creation_input_tokens,
          costUsd: event.total_cost_usd,
        });
      } catch (e) {
        console.error('Gaffer telemetry: recordUsage call failed (ignored)', e.message);
      }
      // Final result text — send if we haven't streamed it yet. Never for an
      // error result: its `result` is the CLI's error text, not a reply (the
      // close handler sends the one chat_error for the turn instead).
      if (!isErrorResult && event.result && event.subtype === 'success') {
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
      console.log('Gaffer compact: skipped: ' + (this._lastModel || 'unknown model')
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
            ? 'login timed out (5 min): browser flow not completed'
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
