'use strict';
// Detached daemon spawner for start.ps1 (spec section 5):
//   & $node launch.cjs <runtime|node> <daemon.mjs|index.js>
// Runs on the bundled runtime or any system Node (plain CommonJS). Spawns the
// entry with the same node, detached, hidden, stdout/stderr appended to the
// daemon log, cleaned env; prints pid:<N> <kind> and exits. Node hands the
// child only the named handles, so the caller's pipe is never inherited
// (Start-Process -Redirect* hung the caller and truncated the log).
// GAFFER_DAEMON_LOG moves the log (tests).
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const STRIPPED = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS'];
const CA_STASH = 'GAFFER_CLAUDE_EXTRA_CA_CERTS';

// Same rules as cleanDaemonEnv in panel/daemon-launch.js (names are
// case-insensitive on win32; the CA bundle is passed on for claude, D7).
function cleanEnv(env, platform) {
  const isWin = platform === 'win32';
  const norm = (k) => (isWin ? String(k).toUpperCase() : String(k));
  const out = {};
  let ca;
  for (const k of Object.keys(env)) {
    if (STRIPPED.includes(norm(k))) { if (norm(k) === 'NODE_EXTRA_CA_CERTS' && ca === undefined) ca = env[k]; continue; }
    out[k] = env[k];
  }
  if (ca !== undefined && ca !== '' && !Object.keys(out).some((k) => norm(k) === CA_STASH)) out[CA_STASH] = ca;
  return out;
}

function main() {
  const [kind, entry] = process.argv.slice(2);
  if (!['runtime', 'node'].includes(kind) || !['daemon.mjs', 'index.js'].includes(entry)) {
    console.log('err:launch-usage');
    return 2;
  }
  const log = process.env.GAFFER_DAEMON_LOG || path.join(process.env.TEMP || os.tmpdir(), 'gaffer-daemon.log');
  const fd = fs.openSync(log, 'a');
  fs.writeSync(fd, `${new Date().toISOString()} Gaffer launch.cjs: launching daemon via ${kind}: ${process.execPath} ${entry} (cwd ${__dirname})\n`);
  const child = cp.spawn(process.execPath, [entry], {
    cwd: __dirname,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: cleanEnv(process.env, process.platform),
  });
  child.on('error', () => {}); // reported below through the missing pid
  child.unref();
  fs.closeSync(fd);
  if (!child.pid) { console.log('err:launch-failed'); return 1; }
  console.log(`pid:${child.pid} ${kind}`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) {
    console.log('err:launch-failed');
    console.error(e && e.message);
    process.exitCode = 1;
  }
}
module.exports = { cleanEnv };
