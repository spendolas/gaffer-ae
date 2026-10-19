// Test-only environment isolation. Import this FIRST in any test file that
// loads chat-handler.js, chat-registry.js, telemetry.js or index.js, directly
// or through another module:
//
//   import './isolate-env.mjs';
//   import { ChatHandler } from '../chat-handler.js';
//
// Why first: telemetry.js reads GAFFER_BUFFER_PATH and GAFFER_TELEMETRY_URL
// at import time and config-path.js resolves GAFFER_CONFIG_PATH on first use,
// and ESM evaluates static imports in source order, so only an import placed
// before theirs is guaranteed to run before they look. A test that drives a
// real ChatHandler records usage and turn kinds into the telemetry buffer;
// without this file a test run wrote the repo's real .gaffer-usage-buffer.json
// (model claude-nope-9, aeVersion test, errorKinds auth/model/too_long), read
// the owner's real per-install config (installId dev-machine) and, on a day
// rollover, POSTed that junk to the real telemetry sheet.
//
// Every variable is set only when the environment did not already set it, so
// a test that seeds its own paths or runs its own local telemetry server
// (telemetry.test.mjs) keeps control. The throwaway files are removed when the
// process exits. Node's test runner also executes this file on its own during
// discovery (test/**/*.mjs); it defines no tests and exits quietly.

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';

var runTag = process.pid + '-' + Date.now();
var owned = [];

// Sets `name` to a throwaway file under the OS temp dir unless it is already
// set. Returns true when this module owns (and will delete) the file.
function claimPath(name, fileName) {
  if (process.env[name]) return false;
  var p = join(tmpdir(), fileName);
  process.env[name] = p;
  owned.push(p);
  return true;
}

if (claimPath('GAFFER_CONFIG_PATH', 'gaffer-test-config-' + runTag + '.json')) {
  // A fixed, filterable id (the same one telemetry.test.mjs seeds) instead of
  // letting getInstallId() mint a random UUID that would read as a real
  // install if a row ever leaked. shareUsageStats is left unset on purpose so
  // isEnabled() keeps its default and no test sees a different toggle state.
  try {
    writeFileSync(process.env.GAFFER_CONFIG_PATH, JSON.stringify({ installId: 'test-suite' }));
  } catch (e) { /* the file is optional: readConfig() treats a missing file as {} */ }
}
claimPath('GAFFER_BUFFER_PATH', 'gaffer-test-buffer-' + runTag + '.json');
// ChatHandler's persisted model-catalog cache would otherwise land in the
// repo's panel dir (.gaffer-model-cache.json).
claimPath('GAFFER_MODEL_CACHE_PATH', 'gaffer-test-model-cache-' + runTag + '.json');

// TCP port 9 is the discard service; nothing listens there on a dev machine,
// so an accidental send fails fast (ECONNREFUSED) and harmlessly instead of
// reaching the real sheet.
export var DEAD_LOOPBACK_URL = 'http://127.0.0.1:9/';
if (!process.env.GAFFER_TELEMETRY_URL) process.env.GAFFER_TELEMETRY_URL = DEAD_LOOPBACK_URL;

// Live model discovery (chat-handler.js fetchModelCatalog) otherwise reads
// the developer's real Claude Code OAuth token and spends it on a real
// /v1/models call from inside the test suite. Pointing the API base at the
// same dead port makes it fail fast into the 'network' fallback the tests
// already handle, and shaves seconds off the run. Unlike the paths above this
// one is forced, not defaulted: a shell that already exports
// ANTHROPIC_BASE_URL (Claude Code sessions do) must not re-point the suite at
// a real API, and no daemon test spawns the real CLI, so nothing needs it.
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';

process.on('exit', function () {
  owned.forEach(function (p) {
    try { if (existsSync(p)) unlinkSync(p); } catch (e) { /* ignore */ }
  });
});

export var isolatedPaths = {
  configPath: process.env.GAFFER_CONFIG_PATH,
  bufferPath: process.env.GAFFER_BUFFER_PATH,
  modelCachePath: process.env.GAFFER_MODEL_CACHE_PATH,
  owned: owned.slice(),
};
