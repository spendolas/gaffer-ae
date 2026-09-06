// Gaffer usage telemetry — Apps Script Web App endpoint.
//
// Temporary stand-in destination for daemon usage telemetry, until the real
// gaffer-billing backend exists (see
// assets/plans/2026-09-07-usage-telemetry-design.md). Appends one row per
// (date, installId, model) to whichever Sheet this script is bound to.
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
// Payload shape expected, sent by telemetry.js's flush():
//   { date, installId, byModel: { <model>: { turns, inputTokens,
//     outputTokens, cacheReadTokens, cacheCreationTokens, costUsd } } }

function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'date', 'installId', 'model', 'turns', 'inputTokens',
      'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd',
    ]);
  }

  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('bad json').setMimeType(ContentService.MimeType.TEXT);
  }

  var date = body.date || '';
  var installId = body.installId || '';
  var byModel = body.byModel || {};

  for (var model in byModel) {
    var m = byModel[model];
    sheet.appendRow([
      date,
      installId,
      model,
      m.turns || 0,
      m.inputTokens || 0,
      m.outputTokens || 0,
      m.cacheReadTokens || 0,
      m.cacheCreationTokens || 0,
      m.costUsd || 0,
    ]);
  }

  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}
