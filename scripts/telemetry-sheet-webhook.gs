// Gaffer usage telemetry — Apps Script Web App endpoint.
//
// Temporary stand-in destination for daemon usage telemetry, until a real
// backend exists. Appends one row per (date, installId, model) to whichever
// Sheet this script is bound to.
//
// Manual deployment (one-time, must be done by a human in Google's own UI —
// no agent or script can do this step, it requires your Google auth):
//   1. Create a new Google Sheet (sheets.new).
//   2. Extensions > Apps Script.
//   3. Delete the default boilerplate code in the editor, paste this file's
//      contents in instead.
//   4. Deploy > New deployment > gear icon > select type "Web app".
//   5. Execute as: Me. Who has access: Anyone.
//   6. Click Deploy, authorize the requested permissions when prompted.
//   7. Copy the Web app URL it gives you.
//   8. Set GAFFER_TELEMETRY_URL to that URL wherever the daemon reads its
//      environment (see panel/daemon/telemetry.js).
//
// Payload shape expected, sent by telemetry.js's flush(). byModel is keyed
// by a composite "actualModel::requestedModel" string (not actual model
// alone) — Scrooge/autoModel can downshift the same actual model from
// different originally-requested models, and those need to stay
// distinguishable for measuring Scrooge's effect.
// sentAt is a fresh ISO timestamp generated at flush time — a single
// calendar date can legitimately produce more than one row (day-close,
// a mid-day disconnect/crash, end-of-day), and sentAt is what lets a
// later reader tell those apart (Key decision 5):
//   { date, sentAt, installId, gafferVersion, os,
//     byModel: { "<model>::<requestedModel>": {
//       turns, inputTokens, outputTokens, cacheReadTokens,
//       cacheCreationTokens, costUsd, aeVersion, cliVersion, cliSource } },
//     errorKinds: { stale_session, too_long, auth, model, api_error,
//                   unknown_error, text_fallback } }   // counts, optional
//
// Unknown fields are harmless: this script reads named keys only, so a
// daemon that sends more than the deployed copy knows about still gets its
// rows appended (the extra keys are simply not written). That is how
// gafferVersion/os/aeVersion (Gaffer 0.10.6) and cliVersion/cliSource/
// errorKinds (0.11.3) were added daemon-side first.
//
// Input rules (the endpoint's URL ships in every client, so anyone can post
// to it): doPost validates every field before it writes anything. A post that
// fails any rule is dropped and still answered "ok", so a probe learns
// nothing. The rules: installId a UUID, date a real YYYY-MM-DD, sentAt an ISO
// timestamp, gafferVersion/os/aeVersion/cliVersion/cliSource short patterns
// or the cliSource enum, model keys ^[a-z0-9.-]{1,40}(::[a-z0-9.-]{1,40})?$,
// counters finite numbers within bounds, at most 10 models, a body of at most
// 8 KB. Cells that could start a formula get a leading apostrophe. Posts are
// rate limited per install (CacheService), appends run under the script lock,
// and the sheet stops growing at MAX_ROWS with one "cap reached" row.
//
// Limits: RATE_LIMIT_POSTS (20) accepted posts per installId per fixed 6 hour
// window; GLOBAL_POSTS_PER_HOUR (100) and GLOBAL_POSTS_PER_DAY (1000) accepted
// posts from all installs together (the installId is chosen by the sender, so
// the global quota is what bounds a flood); MAX_ROWS (100000) rows in the
// sheet, then one "(cap reached)" row and nothing more. A dropped post is
// answered "ok" like any other. If the sheet's last row says "(cap reached)",
// data was dropped: clear old rows and the script resumes.
//
// Deployed-copy maintenance when new fields land: paste the new version of
// this file into the Apps Script editor and Deploy > Manage deployments >
// edit > New version. NEVER "New deployment": that makes a new URL, and the
// URL is baked into every installed daemon. The header row is only written on an EMPTY sheet, so
// on an existing sheet type the new header cells in by hand, in the same
// order as the appendRow below (new columns are always appended at the end
// so older rows stay aligned).

var MAX_BODY_CHARS = 8192;
var MAX_MODELS = 10;
var MAX_ROWS = 100000;          // header included; one "cap reached" row is written past it
var RATE_LIMIT_POSTS = 20;      // posts per installId per fixed window
var RATE_WINDOW_SECONDS = 21600; // CacheService's longest TTL (6 hours)
var GLOBAL_POSTS_PER_HOUR = 100; // accepted posts from all installs together, per UTC hour
var GLOBAL_POSTS_PER_DAY = 1000; // and per UTC day (a few hundred legitimate posts a day at most)
var CAP_MARK = '(cap reached)';

var HEADER = [
  'date', 'sentAt', 'installId', 'model', 'requestedModel', 'turns',
  'inputTokens', 'outputTokens', 'cacheReadTokens',
  'cacheCreationTokens', 'costUsd',
  'gafferVersion', 'os', 'aeVersion', 'cliVersion', 'cliSource', 'errorKinds',
];

var UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
var SENT_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
var SEMVER_RE = /^(\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z][0-9A-Za-z.-]{0,19})?|unknown)$/;
var OS_RE = /^[a-z0-9]{1,16} [A-Za-z0-9._+-]{1,40}$/;
var AE_VERSION_RE = /^[A-Za-z0-9._-]{1,16}$/;
var CLI_VERSION_RE = /^(\d{1,4}\.\d{1,4}\.\d{1,5}|unknown)$/;
var CLI_SOURCES = ['desktop-app', 'standalone', 'config-pin', 'path', 'unknown'];
var MODEL_KEY_RE = /^[a-z0-9.\-]{1,40}(::[a-z0-9.\-]{1,40})?$/;
var ERROR_KIND_RE = /^[a-z_]{1,24}$/;
var MAX_ERROR_KINDS = 12;
var MAX_COUNT = { turns: 1e6, inputTokens: 1e10, outputTokens: 1e10, cacheReadTokens: 1e10, cacheCreationTokens: 1e10, costUsd: 1e6 };
var COUNTERS = ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd'];

// The clock, as a function so a test can move it.
function nowMs() {
  return new Date().getTime();
}

function reply() {
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Optional string field: absent reads as '', present must be a string that
// matches. Returns null when it does not (the whole post is then dropped).
function optionalString(v, test) {
  if (v === undefined) return '';
  if (typeof v !== 'string' || !test(v)) return null;
  return v;
}

function validDate(v) {
  var m = typeof v === 'string' ? DATE_RE.exec(v) : null;
  if (!m) return false;
  var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// The checked copy of a POST body, or null when anything is wrong. Pure: no
// SpreadsheetApp, so scripts/telemetry-sheet-webhook.test.mjs can run it under
// Node with hostile input. Only the fields this script knows are copied;
// everything else in the body is ignored.
function validatePayload(body) {
  if (!isPlainObject(body)) return null;
  if (typeof body.installId !== 'string' || !UUID_RE.test(body.installId)) return null;
  if (!validDate(body.date)) return null;
  var sentAt = optionalString(body.sentAt, function (s) { return SENT_AT_RE.test(s); });
  var gafferVersion = optionalString(body.gafferVersion, function (s) { return SEMVER_RE.test(s); });
  var os = optionalString(body.os, function (s) { return OS_RE.test(s); });
  if (sentAt === null || gafferVersion === null || os === null) return null;

  var rawModels = body.byModel === undefined ? {} : body.byModel;
  if (!isPlainObject(rawModels)) return null;
  var keys = Object.keys(rawModels);
  if (keys.length > MAX_MODELS) return null;
  var models = [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (!MODEL_KEY_RE.test(key)) return null;
    var b = rawModels[key];
    if (!isPlainObject(b)) return null;
    var clean = { key: key };
    for (var c = 0; c < COUNTERS.length; c++) {
      var name = COUNTERS[c];
      var v = b[name];
      if (v === undefined) v = 0;
      if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > MAX_COUNT[name]) return null;
      clean[name] = v;
    }
    clean.aeVersion = optionalString(b.aeVersion, function (s) { return AE_VERSION_RE.test(s); });
    clean.cliVersion = optionalString(b.cliVersion, function (s) { return CLI_VERSION_RE.test(s); });
    clean.cliSource = optionalString(b.cliSource, function (s) { return CLI_SOURCES.indexOf(s) !== -1; });
    if (clean.aeVersion === null || clean.cliVersion === null || clean.cliSource === null) return null;
    models.push(clean);
  }

  var errorKinds = {};
  var errorCount = 0;
  if (body.errorKinds !== undefined) {
    if (!isPlainObject(body.errorKinds)) return null;
    var ek = Object.keys(body.errorKinds);
    if (ek.length > MAX_ERROR_KINDS) return null;
    for (var j = 0; j < ek.length; j++) {
      var n = body.errorKinds[ek[j]];
      if (!ERROR_KIND_RE.test(ek[j]) || typeof n !== 'number' || n !== Math.floor(n) || n < 0 || n > 1e6) return null;
      errorKinds[ek[j]] = n;
      errorCount++;
    }
  }

  return {
    date: body.date, sentAt: sentAt, installId: body.installId, gafferVersion: gafferVersion, os: os,
    models: models, errorKinds: errorCount > 0 ? JSON.stringify(errorKinds) : '',
  };
}

// A cell that could start a spreadsheet formula (= + - @, or a tab or
// carriage return in front of one) gets a leading apostrophe, so it is shown
// as text and never evaluated. Numbers and ordinary text pass unchanged.
function safeCell(v) {
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) return "'" + v;
  return v;
}

function rowsForClean(p) {
  var rows = [];
  for (var i = 0; i < p.models.length; i++) {
    var m = p.models[i];
    var parts = m.key.split('::');
    var model = parts[0] || '';
    var requestedModel = parts[1] || model; // no downshift: same as model
    rows.push([
      p.date, p.sentAt, p.installId, model, requestedModel,
      m.turns, m.inputTokens, m.outputTokens, m.cacheReadTokens, m.cacheCreationTokens, m.costUsd,
      p.gafferVersion, p.os, m.aeVersion, m.cliVersion, m.cliSource,
      rows.length === 0 ? p.errorKinds : '',
    ]);
  }
  if (rows.length === 0 && p.errorKinds !== '' && p.errorKinds !== '{}') {
    rows.push([
      p.date, p.sentAt, p.installId, '(none)', '(none)',
      0, 0, 0, 0, 0, 0,
      p.gafferVersion, p.os, '', '', '',
      p.errorKinds,
    ]);
  }
  return rows.map(function (r) { return r.map(safeCell); });
}

// The rows one POST appends, in header order, from a raw (unchecked) body: it
// is validated first, so a bad body yields no rows. Pure (no SpreadsheetApp).
//
// errorKinds is install-wide for the day, not per model, so it is written on
// the FIRST row of a POST only. Writing it on every row would make a
// SUM over the column count the same failures once per model. Older
// daemons (before 0.11.3) send no errorKinds at all: the column is then
// empty, as before.
//
// A day with failures but no completed turn (every turn died before a result
// event) arrives with an empty byModel and a non-empty errorKinds. It still
// gets one row, with model "(none)" and zero counters, so the failures are
// not dropped on the floor: the daemon deletes its buffer once the POST
// returns, whatever this script did with it.
function rowsForPayload(body) {
  var clean = validatePayload(body);
  return clean ? rowsForClean(clean) : [];
}

// True while this install is under its post limit for the current fixed
// window (a 6 hour bucket of the clock, so later posts do not extend it).
// Best effort: a cache that cannot be read or written never blocks a post.
// Called under the script lock, so the count cannot race.
function underRateLimit(installId) {
  try {
    var cache = CacheService.getScriptCache();
    var bucket = Math.floor(nowMs() / (RATE_WINDOW_SECONDS * 1000));
    var key = 'rl_' + installId.toLowerCase() + '_' + bucket;
    var n = Number(cache.get(key)) || 0;
    if (n >= RATE_LIMIT_POSTS) return false;
    cache.put(key, String(n + 1), RATE_WINDOW_SECONDS);
  } catch (err) { /* best effort */ }
  return true;
}

// The global quota covers what the per-install limit cannot: a sender picks
// its own installId, so fresh ids dodge that limit. Accepted posts from all
// installs together are counted per UTC hour (CacheService) and per UTC day
// (script properties, a cache cannot hold a value that long). Best effort, and
// called under the script lock like underRateLimit.
function underGlobalQuota() {
  try {
    var hour = Math.floor(nowMs() / 3600000);
    if ((Number(CacheService.getScriptCache().get('g_h_' + hour)) || 0) >= GLOBAL_POSTS_PER_HOUR) return false;
  } catch (err) { /* best effort */ }
  try {
    var day = Math.floor(nowMs() / 86400000);
    var parts = String(PropertiesService.getScriptProperties().getProperty('q_day') || '').split(':');
    if (Number(parts[0]) === day && (Number(parts[1]) || 0) >= GLOBAL_POSTS_PER_DAY) return false;
  } catch (err) { /* best effort */ }
  return true;
}

function countGlobalPost() {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'g_h_' + Math.floor(nowMs() / 3600000);
    cache.put(key, String((Number(cache.get(key)) || 0) + 1), 3700);
  } catch (err) { /* best effort */ }
  try {
    var props = PropertiesService.getScriptProperties();
    var day = Math.floor(nowMs() / 86400000);
    var parts = String(props.getProperty('q_day') || '').split(':');
    var n = Number(parts[0]) === day ? (Number(parts[1]) || 0) : 0;
    props.setProperty('q_day', day + ':' + (n + 1));
  } catch (err) { /* best effort */ }
}

function appendRows(sheet, rows, sample) {
  var last = sheet.getLastRow();
  if (last === 0) {
    sheet.appendRow(HEADER);
    last = 1;
  }
  if (last >= MAX_ROWS) {
    // The sheet is full: one marker row, once, and nothing more.
    if (sheet.getRange(last, 4).getValue() !== CAP_MARK) {
      sheet.appendRow([sample.date, sample.sentAt, sample.installId, CAP_MARK, CAP_MARK, 0, 0, 0, 0, 0, 0, '', '', '', '', '', ''].map(safeCell));
    }
    return;
  }
  rows = rows.slice(0, MAX_ROWS - last);
  if (rows.length === 0) return;
  sheet.getRange(last + 1, 1, rows.length, HEADER.length).setValues(rows);
}

function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_BODY_CHARS) return reply();
    var body;
    try { body = JSON.parse(raw); } catch (err) { return reply(); }
    var clean = validatePayload(body);
    if (!clean) return reply();
    var rows = rowsForClean(clean);
    if (rows.length === 0) return reply();

    var lock = LockService.getScriptLock();
    try { lock.waitLock(10000); } catch (err) { return reply(); }
    try {
      if (!underGlobalQuota() || !underRateLimit(clean.installId)) return reply();
      countGlobalPost();
      appendRows(SpreadsheetApp.getActiveSpreadsheet().getActiveSheet(), rows, clean);
    } finally {
      lock.releaseLock();
    }
  } catch (err) { /* never answer with anything but "ok" */ }
  return reply();
}
