// test-3-detached-isolation.js
// ────────────────────────────────────────────────────────────────────────
// Reproduces the Gaffer runUpdate silent-fail behaviour by isolating which
// child_process.spawn option is at fault.
//
// Runs 8 spawns of the same PowerShell one-liner — every combination of
// { detached, stdio: 'ignore', windowsHide } — each with a distinct label.
// The child appends its label + timestamp to a marker file. After all 8,
// we read the marker to see which combos actually ran.
//
// Expected on Node v24 + Windows 11:
//   Every spawn reports exit=0 (Node thinks they all succeeded).
//   The marker file contains only 4 lines — the 4 combos that DON'T include
//   detached: true:
//     • none
//     • stdio_ignore
//     • windowsHide
//     • stdio_ignore+windowsHide
//   The 4 combos containing `detached: true` are missing → they exited
//   cleanly without running the child command.
//
// If you don't see this asymmetry on your Node version, the regression may
// be limited to specific majors (Node v24.13.1 confirmed affected).

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const MARKER = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'gaffer-spawn-isolation-marker.txt');

function makeArgs(label) {
  return [
    '-NoProfile',
    '-Command',
    `Add-Content -Path '${MARKER}' -Value ('${label} @ ' + (Get-Date -Format o))`,
  ];
}

try { fs.unlinkSync(MARKER); } catch (e) { /* first run */ }

const combos = [
  ['none',                     {}],
  ['detached',                 { detached: true }],
  ['stdio_ignore',             { stdio: 'ignore' }],
  ['windowsHide',              { windowsHide: true }],
  ['detached+stdio_ignore',    { detached: true, stdio: 'ignore' }],
  ['detached+windowsHide',     { detached: true, windowsHide: true }],
  ['stdio_ignore+windowsHide', { stdio: 'ignore', windowsHide: true }],
  ['all_three',                { detached: true, stdio: 'ignore', windowsHide: true }],
];

function runOne(label, opts) {
  return new Promise((resolve) => {
    const child = cp.spawn(PS, makeArgs(label), opts);
    child.on('error', (e) => console.log(`[${label}] SPAWN ERROR:`, e.message));
    child.on('exit', (code) => console.log(`[${label}] exit=${code}`));
    if (opts.detached) child.unref();
    setTimeout(resolve, 2500);
  });
}

(async () => {
  console.log(`node ${process.versions.node} on ${process.platform} ${process.arch}`);
  console.log(`marker: ${MARKER}\n`);

  for (const [label, opts] of combos) {
    await runOne(label, opts);
  }

  console.log('\n=== marker file contents (each line = a combo that actually ran) ===');
  try {
    process.stdout.write(fs.readFileSync(MARKER, 'utf8'));
  } catch (e) {
    console.log('(no marker file — nothing ran)');
  }

  console.log('\n=== summary ===');
  let markerText = '';
  try { markerText = fs.readFileSync(MARKER, 'utf8'); } catch (e) {}
  for (const [label] of combos) {
    const ran = markerText.includes(`${label} @`);
    console.log(`  ${ran ? '✅' : '❌'} ${label}`);
  }
})();
