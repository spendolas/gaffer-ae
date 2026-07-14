// test-2-console-flash.js
// ────────────────────────────────────────────────────────────────────────
// Demonstrates the missing-windowsHide behaviour visually.
//
// Spawns a PowerShell child that sleeps for 4 seconds — first with default
// options, then with { windowsHide: true }. Watch your desktop during the
// two waits.
//
// Expected on Windows:
//   Round 1 (no options)   → a PowerShell console window pops up for ~4 s
//   Round 2 (windowsHide)  → no window, silent

const cp = require('child_process');
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const args = ['-NoProfile', '-Command', 'Start-Sleep -Seconds 4'];

function run(label, opts) {
  return new Promise((resolve) => {
    console.log(`\n${label}`);
    console.log('  starting (~4s)...');
    const start = Date.now();
    const child = cp.spawn(PS, args, opts);
    child.on('error', (e) => console.log('  spawn error:', e.message));
    child.on('exit', (code) => {
      console.log(`  done in ${Date.now() - start}ms, exit=${code}`);
      resolve();
    });
  });
}

(async () => {
  await run('Round 1/2: no options — a console window WILL appear', {});
  await run('Round 2/2: { windowsHide: true } — no window should appear', { windowsHide: true });
})();
