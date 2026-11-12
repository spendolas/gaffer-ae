// Lightweight, privacy-conscious usage telemetry: model name + token counts +
// estimated cost only — never prompt/response content. Gated on the
// `shareUsageStats` config flag so the panel's toggle and this module agree
// on one source of truth (the config file), not two separate states.
//
// TEMP (dev/testing phase only): defaults to enabled so real usage data can
// be validated before the toggle ships to real users. THIS MUST FLIP TO
// DEFAULT-DISABLED BEFORE PUBLIC RELEASE — ship it on by default and it's
// collecting real users' data without their consent.
var DEFAULT_ENABLED = true; // TEMP — see note above. Flip to false pre-release.

import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { platform as osPlatform, release as osRelease } from 'node:os';
import { getConfigPath } from './config-path.js';

var __dirname = dirname(fileURLToPath(import.meta.url));
// The per-install config (installId, shareUsageStats, claudeBin) lives in the
// OS app-data folder, outside the extension directory — see config-path.js
// for the location, the GAFFER_CONFIG_PATH test override, and the one-time
// migration from the old in-install-dir file. Resolved lazily via
// getConfigPath() so the migration runs on first real access.
// BUFFER_PATH is env-var overridable for the same reason (tests point it at a
// throwaway file so an interrupted run never blanks the real one).
var BUFFER_PATH = process.env.GAFFER_BUFFER_PATH || join(__dirname, '..', '.gaffer-usage-buffer.json');
// Real, deployed, verified-working Apps Script Web App (temporary stand-in
// until a real backend exists). GAFFER_TELEMETRY_URL redirects it for tests
// and local runs, and is honoured for a loopback address only (127.0.0.1,
// localhost, [::1], no credentials in the URL): anywhere else the variable is
// ignored, so a stray environment value can never send usage data to another
// host.
export var DEFAULT_TELEMETRY_URL = 'https://script.google.com/macros/s/AKfycbx4aKRz_jB1EXe0JkZz4m4SNdGvCt7nIWCoWtXQKsd0EJ8pM4iyJ8LJMZ0qmEVUiCuE/exec';
export function resolveTelemetryUrl(override) {
  if (typeof override !== 'string' || !override) return DEFAULT_TELEMETRY_URL;
  var u;
  try { u = new URL(override); } catch (e) { return DEFAULT_TELEMETRY_URL; }
  var loopback = ['127.0.0.1', 'localhost', '[::1]'].indexOf(u.hostname) !== -1;
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !loopback || u.username || u.password) return DEFAULT_TELEMETRY_URL;
  return override;
}
var TELEMETRY_URL = resolveTelemetryUrl(process.env.GAFFER_TELEMETRY_URL);

// In-flight flush guard — a simple boolean lock so overlapping flush
// triggers (e.g. last-panel-disconnect and SIGTERM firing close together)
// can't both read the same on-disk buffer and send it twice.
var flushInProgress = false;

function readConfig() {
  try { return JSON.parse(readFileSync(getConfigPath(), 'utf-8')); }
  catch (e) { return {}; }
}

function writeConfig(patch) {
  var current = readConfig();
  var next = Object.assign({}, current, patch);
  // Write to a temp file then rename over the real one — a rename is atomic
  // on the same filesystem, so a crash/kill mid-write (or a sync tool like
  // Dropbox touching the file at the wrong moment) can never leave the real
  // config half-written or truncated. A corrupted config previously read as
  // "{}" (see readConfig's catch) and silently wiped installId + every other
  // saved setting on the next write.
  var configPath = getConfigPath();
  var tmpPath = configPath + '.tmp-' + process.pid + '-' + Date.now();
  try {
    writeFileSync(tmpPath, JSON.stringify(next, null, 2));
    renameSync(tmpPath, configPath);
  } catch (e) {
    console.error('Gaffer telemetry: failed to write config', e.message);
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch (e2) { /* ignore */ }
  }
}

export function isEnabled() {
  var config = readConfig();
  return typeof config.shareUsageStats === 'boolean' ? config.shareUsageStats : DEFAULT_ENABLED;
}

export function setEnabled(enabled) {
  writeConfig({ shareUsageStats: !!enabled });
}

// Anonymous per-install ID — random, non-personal, never tied to an
// email/account. Generated once and persisted; a pre-existing value (e.g.
// hand-edited on a dev machine) is left untouched.
export function getInstallId() {
  var config = readConfig();
  if (config.installId) return config.installId;
  var id = randomUUID();
  writeConfig({ installId: id });
  return id;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

// Static per-process facts, read/computed once and reused on every flush.
var cachedGafferVersion = null;
function getGafferVersion() {
  if (cachedGafferVersion) return cachedGafferVersion;
  try {
    var data = JSON.parse(readFileSync(join(__dirname, '..', 'version.json'), 'utf-8'));
    cachedGafferVersion = data.version || 'unknown';
  } catch (e) { cachedGafferVersion = 'unknown'; }
  return cachedGafferVersion;
}

var OS_INFO = osPlatform() + ' ' + osRelease();

// Claude Code version as sent to telemetry: the leading x.y.z of whatever
// string we were handed ("2.1.289 (Claude Code)" from `--version`, or
// `claude_code_version` from the stream's init event), else 'unknown'. Only
// those digits ever leave the machine: no build hash, no path, no suffix. A
// leading "v" is tolerated; a component longer than the cap is not a version
// at all (the lookahead stops "2.1.2934567" from passing as "2.1.29345").
var CLI_VERSION_RE = /^v?(\d{1,4}\.\d{1,4}\.\d{1,5})(?!\d)/;
export function sanitizeCliVersion(v) {
  if (typeof v !== 'string') return 'unknown';
  var m = CLI_VERSION_RE.exec(v.trim());
  return m ? m[1] : 'unknown';
}

// Where the binary came from, as a closed enum. Anything else (a new lookup
// step, a typo, an object) collapses to 'unknown' so the endpoint can never
// receive a path or a folder name under this key.
var CLI_SOURCES = ['desktop-app', 'standalone', 'config-pin', 'path', 'unknown'];
export function sanitizeCliSource(s) {
  return CLI_SOURCES.indexOf(s) !== -1 ? s : 'unknown';
}

// Maps claude-binary.js's lookup step (the string found() logs) onto the
// telemetry enum. 'known location' is a fixed standalone install path;
// PATH and login-shell hits are both "whatever the shell would run".
export function cliSourceFromStep(step) {
  switch (step) {
    case 'desktop app': return 'desktop-app';
    case 'known location': return 'standalone';
    case 'config': return 'config-pin';
    case 'PATH':
    case 'login shell': return 'path';
    default: return 'unknown';
  }
}

// Turn outcomes counted per day (cli-contract.js kinds plus text_fallback,
// which marks a verdict that needed the CLI's human text because the
// structured fields had drifted). A closed list: the counter map is sent as
// is, so no free-form key may ever reach it.
var TURN_KINDS = ['stale_session', 'too_long', 'auth', 'model', 'api_error', 'unknown_error', 'text_fallback'];

function emptyBuffer() {
  return { date: todayKey(), byModel: {}, errorKinds: {} };
}

function readBuffer() {
  try {
    var buffer = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8'));
    if (!buffer || typeof buffer !== 'object' || !buffer.byModel) return emptyBuffer();
    return buffer;
  } catch (e) { return emptyBuffer(); }
}

function writeBuffer(buffer) {
  try { writeFileSync(BUFFER_PATH, JSON.stringify(buffer)); }
  catch (e) { console.error('Gaffer telemetry: failed to write usage buffer', e.message); }
}

// Records one completed chat turn's usage. Always buffers regardless of the
// toggle (Key decision 6) — turning sharing off stops sending, not
// recording. Never pass prompt/response text — only numeric fields belong
// here.
export function recordUsage(entry) {
  if (!entry || !entry.model) return;

  try {
    var buffer = readBuffer();
    var today = todayKey();
    if (buffer.date !== today) {
      // Day rolled over — flush what's there before starting a fresh bucket.
      flush(buffer);
      buffer = emptyBuffer();
    }

    var requestedModel = entry.requestedModel || entry.model;
    var key = entry.model + '::' + requestedModel;

    var bucket = buffer.byModel[key] || {
      turns: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    };
    bucket.turns += 1;
    bucket.inputTokens += entry.inputTokens || 0;
    bucket.outputTokens += entry.outputTokens || 0;
    bucket.cacheReadTokens += entry.cacheReadTokens || 0;
    bucket.cacheCreationTokens += entry.cacheCreationTokens || 0;
    bucket.costUsd += entry.costUsd || 0;
    // Last-seen AE version for this model pair today — not aggregated, just
    // enough to see which AE version a model pairing ran on.
    bucket.aeVersion = entry.aeVersion || bucket.aeVersion || 'unknown';
    // Last-seen Claude Code version and where the binary came from, same
    // pattern. Both pass through a sanitizer so only "x.y.z" and a closed
    // enum are ever stored: never the path, never a folder hash.
    var cliVersion = sanitizeCliVersion(entry.cliVersion);
    bucket.cliVersion = cliVersion !== 'unknown' ? cliVersion : (bucket.cliVersion || 'unknown');
    var cliSource = sanitizeCliSource(entry.cliSource);
    bucket.cliSource = cliSource !== 'unknown' ? cliSource : (bucket.cliSource || 'unknown');
    buffer.byModel[key] = bucket;

    writeBuffer(buffer);
  } catch (e) {
    // Telemetry must never affect the chat flow.
    console.error('Gaffer telemetry: recordUsage failed (ignored)', e.message);
  }
}

// Counts one classified failed turn for today (cli-contract.js verdict). `ok`
// turns are not counted here (recordUsage already counts turns); unknown
// kinds are dropped rather than stored. `via === 'text'` additionally bumps
// text_fallback, the "our structural knowledge is stale" signal. Buffers
// regardless of the toggle, like recordUsage.
export function recordTurnKind(kind, via) {
  try {
    var keys = [];
    if (TURN_KINDS.indexOf(kind) !== -1) keys.push(kind);
    if (via === 'text') keys.push('text_fallback');
    if (!keys.length) return;

    var buffer = readBuffer();
    var today = todayKey();
    if (buffer.date !== today) {
      flush(buffer);
      buffer = emptyBuffer();
    }
    if (!buffer.errorKinds || typeof buffer.errorKinds !== 'object') buffer.errorKinds = {};
    keys.forEach(function (k) { buffer.errorKinds[k] = (buffer.errorKinds[k] || 0) + 1; });
    writeBuffer(buffer);
  } catch (e) {
    console.error('Gaffer telemetry: recordTurnKind failed (ignored)', e.message);
  }
}

// The errorKinds map restricted to the closed key list with integer values,
// so a hand-edited or corrupted buffer can never smuggle a free-form key out.
function cleanErrorKinds(map) {
  var out = {};
  if (!map || typeof map !== 'object') return out;
  TURN_KINDS.forEach(function (k) {
    var n = map[k];
    if (typeof n === 'number' && isFinite(n) && n > 0) out[k] = Math.floor(n);
  });
  return out;
}

// One half of a model key as the receiving sheet accepts it: lower case,
// only [a-z0-9.-], no leading or trailing - or ., at most 40 characters.
// Anything else becomes a dash; nothing left reads as "unknown".
function sanitizeModelPart(part) {
  var p = String(part).toLowerCase().replace(/[^a-z0-9.\-]+/g, '-').replace(/-{2,}/g, '-');
  p = p.replace(/^[-.]+/, '').slice(0, 40).replace(/[-.]+$/, '');
  return p || 'unknown';
}

// A byModel key ("<model>" or "<model>::<requested model>") reduced to the
// pattern the sheet endpoint checks, ^[a-z0-9.-]{1,40}(::[a-z0-9.-]{1,40})?$.
// Only the first :: separates the halves. null for a key that is not a string.
export function sanitizeModelKey(key) {
  if (typeof key !== 'string') return null;
  var at = key.indexOf('::');
  if (at === -1) return sanitizeModelPart(key);
  return sanitizeModelPart(key.slice(0, at)) + '::' + sanitizeModelPart(key.slice(at + 2));
}

var MAX_MODELS_PER_SEND = 10;
var COUNTER_FIELDS = ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd'];
// The bounds the receiving endpoint accepts: a counter above its bound would
// make it drop the whole post, so a corrupted value is clamped instead.
var COUNTER_MAX = { turns: 1e6, inputTokens: 1e10, outputTokens: 1e10, cacheReadTokens: 1e10, cacheCreationTokens: 1e10, costUsd: 1e6 };
var AE_VERSION_RE = /^[A-Za-z0-9._-]{1,16}$/;
var OTHER_KEY = 'other::other';

// A counter as a finite number within the endpoint's bounds, else 0.
function cleanCounter(field, v) {
  if (typeof v !== 'number' || !isFinite(v) || v < 0) return 0;
  return Math.min(v, COUNTER_MAX[field]);
}

// An AE version as the endpoint accepts it, else 'unknown'.
export function sanitizeAeVersion(v) {
  return typeof v === 'string' && AE_VERSION_RE.test(v) ? v : 'unknown';
}

// The buffer's date as YYYY-MM-DD for a real calendar day, else today's.
function cleanDate(d) {
  var m = typeof d === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) : null;
  if (m) {
    var t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3]) return d;
  }
  return todayKey();
}

function addCounters(target, src) {
  COUNTER_FIELDS.forEach(function (f) {
    if (src[f] !== undefined || target[f] !== undefined) {
      target[f] = Math.min((target[f] || 0) + (src[f] || 0), COUNTER_MAX[f]);
    }
  });
}

// The byModel map as it is sent. Only the known bucket fields are copied
// (the counters, aeVersion, cliVersion, cliSource), each re-cleaned: keys
// re-run through sanitizeModelKey (two keys that collapse to one are added
// together), counters bounded, aeVersion, cliVersion and cliSource through
// their sanitizers. Anything else in a bucket is dropped, so a hand-edited or
// corrupted buffer can never smuggle free text out (recordUsage sanitizes on
// the way in; this is the belt to that brace). At most ten entries go out:
// the nine busiest models plus one "other::other" bucket holding the rest, so
// the day's totals stay right.
function cleanByModel(map) {
  var out = Object.create(null);
  if (!map || typeof map !== 'object') return {};
  Object.keys(map).forEach(function (rawKey) {
    var b = map[rawKey];
    if (!b || typeof b !== 'object') return;
    var key = sanitizeModelKey(rawKey);
    if (!key) return;
    var copy = {};
    COUNTER_FIELDS.forEach(function (f) { if (b[f] !== undefined) copy[f] = cleanCounter(f, b[f]); });
    if (b.aeVersion !== undefined) copy.aeVersion = sanitizeAeVersion(b.aeVersion);
    copy.cliVersion = sanitizeCliVersion(b.cliVersion);
    copy.cliSource = sanitizeCliSource(b.cliSource);
    var prev = out[key];
    if (prev) {
      addCounters(prev, copy);
      if (prev.aeVersion === undefined || prev.aeVersion === 'unknown') { if (copy.aeVersion !== undefined) prev.aeVersion = copy.aeVersion; }
      if (prev.cliVersion === 'unknown') prev.cliVersion = copy.cliVersion;
      if (prev.cliSource === 'unknown') prev.cliSource = copy.cliSource;
      return;
    }
    out[key] = copy;
  });
  var keys = Object.keys(out).sort(function (a, b) { return (out[b].turns || 0) - (out[a].turns || 0); });
  var result = {};
  if (keys.length <= MAX_MODELS_PER_SEND) {
    keys.forEach(function (k) { result[k] = out[k]; });
    return result;
  }
  keys.slice(0, MAX_MODELS_PER_SEND - 1).forEach(function (k) { result[k] = out[k]; });
  var other = result[OTHER_KEY] || { cliVersion: 'unknown', cliSource: 'unknown', aeVersion: 'unknown' };
  keys.slice(MAX_MODELS_PER_SEND - 1).forEach(function (k) { addCounters(other, out[k]); });
  result[OTHER_KEY] = other;
  return result;
}

// Deletes the on-disk buffer only while it still holds the flushed day. A
// buffer whose date moved on (or that cannot be read) is left alone.
function clearBufferIfDate(date) {
  try {
    if (!existsSync(BUFFER_PATH)) return;
    var current = null;
    try { current = JSON.parse(readFileSync(BUFFER_PATH, 'utf-8')); } catch (e) { current = null; }
    if (current && typeof current === 'object' && current.date !== date) return;
    unlinkSync(BUFFER_PATH);
  } catch (e) { /* ignore */ }
}

// POSTs the day's aggregate and clears the local buffer, but only once the
// send is confirmed. Gated on isEnabled() — off just means "keep buffering,
// don't send" (Key decision 6): data survives and goes out in full once
// re-enabled. Safe to call with no argument (reads the on-disk buffer) or
// with an already-loaded buffer (the day-rollover path above).
export function flush(buffer) {
  return new Promise(function (resolve) {
    try {
      if (flushInProgress) { resolve(false); return; }
      if (!isEnabled()) { resolve(false); return; }

      buffer = buffer || readBuffer();
      var errorKinds = cleanErrorKinds(buffer.errorKinds);
      var byModel = cleanByModel(buffer.byModel);
      var hasModels = Object.keys(byModel).length > 0;
      if (!hasModels && Object.keys(errorKinds).length === 0) { resolve(false); return; }
      var flushedDate = buffer.date;

      flushInProgress = true;

      // Field inventory (the receiving sheet reads only what it knows and
      // ignores the rest, so adding a key here never breaks delivery):
      // date, sentAt, installId, gafferVersion, os, byModel{turns, tokens,
      // costUsd, aeVersion, cliVersion, cliSource}, errorKinds{kind: count}.
      // Nothing in here may ever be a path, a hostname, a user name or text
      // from the CLI or the chat.
      var payload = JSON.stringify({
        date: cleanDate(buffer.date),
        sentAt: new Date().toISOString(),
        installId: getInstallId(),
        gafferVersion: getGafferVersion(),
        os: OS_INFO,
        byModel: byModel,
        errorKinds: errorKinds,
      });

      var isHttps = TELEMETRY_URL.indexOf('https:') === 0;
      var req = (isHttps ? httpsRequest : httpRequest)(TELEMETRY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000,
      }, function (res) {
        res.resume();
        res.on('end', function () {
          // Clear only once the request was actually sent without a
          // connection error — a best-effort "sent" signal, not a guarantee
          // the sheet stored it. And clear only the day that was sent: a
          // day-rollover flush runs while recordUsage/recordTurnKind may
          // already have written the new day's first turn to the same file,
          // and deleting that would lose it.
          clearBufferIfDate(flushedDate);
          flushInProgress = false;
          resolve(true);
        });
      });
      req.on('timeout', function () { req.destroy(new Error('timeout')); });
      req.on('error', function (e) {
        // Best-effort only — never let telemetry delivery affect the chat
        // flow. The buffer isn't cleared on failure, so today's data
        // survives to the next flush attempt.
        console.error('Gaffer telemetry: flush failed (will retry later)', e.message);
        flushInProgress = false;
        resolve(false);
      });
      req.end(payload);
    } catch (e) {
      console.error('Gaffer telemetry: flush failed (ignored)', e.message);
      flushInProgress = false;
      resolve(false);
    }
  });
}
