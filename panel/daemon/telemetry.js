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

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

var __dirname = dirname(fileURLToPath(import.meta.url));
var CONFIG_PATH = join(__dirname, '..', '.gaffer-config.json');
var BUFFER_PATH = join(__dirname, '..', '.gaffer-usage-buffer.json');
// Real, deployed, verified-working Apps Script Web App (temporary stand-in
// for gaffer-billing — see assets/plans/2026-09-07-usage-telemetry-design.md).
// Env-var overridable so swapping the destination later is a one-line change.
var TELEMETRY_URL = process.env.GAFFER_TELEMETRY_URL
  || 'https://script.google.com/macros/s/AKfycbx4aKRz_jB1EXe0JkZz4m4SNdGvCt7nIWCoWtXQKsd0EJ8pM4iyJ8LJMZ0qmEVUiCuE/exec';

// In-flight flush guard — a simple boolean lock so overlapping flush
// triggers (e.g. last-panel-disconnect and SIGTERM firing close together)
// can't both read the same on-disk buffer and send it twice.
var flushInProgress = false;

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); }
  catch (e) { return {}; }
}

function writeConfig(patch) {
  var current = readConfig();
  var next = Object.assign({}, current, patch);
  try { writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2)); }
  catch (e) { console.error('Gaffer telemetry: failed to write config', e.message); }
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

function emptyBuffer() {
  return { date: todayKey(), byModel: {} };
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
    buffer.byModel[key] = bucket;

    writeBuffer(buffer);
  } catch (e) {
    // Telemetry must never affect the chat flow.
    console.error('Gaffer telemetry: recordUsage failed (ignored)', e.message);
  }
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
      if (!buffer.byModel || Object.keys(buffer.byModel).length === 0) { resolve(false); return; }

      flushInProgress = true;

      var payload = JSON.stringify({
        date: buffer.date,
        sentAt: new Date().toISOString(),
        installId: getInstallId(),
        byModel: buffer.byModel,
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
          // the sheet stored it.
          try { if (existsSync(BUFFER_PATH)) unlinkSync(BUFFER_PATH); }
          catch (e) { /* ignore */ }
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
