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
// Deployed-copy maintenance when new fields land: paste the new version of
// this file into the Apps Script editor and Deploy > Manage deployments >
// edit > New version. The header row is only written on an EMPTY sheet, so
// on an existing sheet type the new header cells in by hand, in the same
// order as the appendRow below (new columns are always appended at the end
// so older rows stay aligned).

function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'date', 'sentAt', 'installId', 'model', 'requestedModel', 'turns',
      'inputTokens', 'outputTokens', 'cacheReadTokens',
      'cacheCreationTokens', 'costUsd',
      'gafferVersion', 'os', 'aeVersion', 'cliVersion', 'cliSource', 'errorKinds',
    ]);
  }

  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('bad json').setMimeType(ContentService.MimeType.TEXT);
  }

  var date = body.date || '';
  var sentAt = body.sentAt || '';
  var installId = body.installId || '';
  var byModel = body.byModel || {};
  var gafferVersion = body.gafferVersion || '';
  var os = body.os || '';
  // Per-day failure counters are install-wide, not per model; stored once as
  // a JSON string on each of the day's rows (empty when none were sent).
  var errorKinds = body.errorKinds && typeof body.errorKinds === 'object'
    ? JSON.stringify(body.errorKinds) : '';

  for (var key in byModel) {
    var parts = key.split('::');
    var model = parts[0] || '';
    var requestedModel = parts[1] || model; // no downshift → same as model
    var m = byModel[key];
    sheet.appendRow([
      date,
      sentAt,
      installId,
      model,
      requestedModel,
      m.turns || 0,
      m.inputTokens || 0,
      m.outputTokens || 0,
      m.cacheReadTokens || 0,
      m.cacheCreationTokens || 0,
      m.costUsd || 0,
      gafferVersion,
      os,
      m.aeVersion || '',
      m.cliVersion || '',
      m.cliSource || '',
      errorKinds,
    ]);
  }

  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}
