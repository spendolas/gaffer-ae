import './isolate-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Guard against the test suite polluting real telemetry again. Any test that
// loads one of the modules below (they record usage into the telemetry buffer,
// read the per-install config and can POST to the telemetry URL) must isolate
// its environment BEFORE that module is evaluated: either by importing
// ./isolate-env.mjs ahead of it, or by assigning GAFFER_CONFIG_PATH and
// GAFFER_BUFFER_PATH itself and then loading the module with a dynamic
// import(). A plain env assignment above a STATIC import does not count:
// static imports are hoisted and evaluate before the assignment runs.

var TEST_DIR = dirname(fileURLToPath(import.meta.url));
var SENSITIVE = ['chat-handler', 'chat-registry', 'telemetry', 'index'];
var SENSITIVE_PATH = '\\.\\.\\/(?:' + SENSITIVE.join('|') + ')\\.js';
var STATIC_RE = new RegExp('\\bimport\\s*(?:[\\w$*{}\\s,]+?\\s*from\\s*)?[\'"]' + SENSITIVE_PATH + '[\'"]');
var DYNAMIC_RE = new RegExp('\\bimport\\(\\s*[\'"]' + SENSITIVE_PATH + '[\'"]\\s*\\)');
var ISOLATE_RE = /\bimport\s+['"]\.\/isolate-env\.mjs['"]/;
var CONFIG_RE = /process\.env\.GAFFER_CONFIG_PATH\s*=[^=]/;
var BUFFER_RE = /process\.env\.GAFFER_BUFFER_PATH\s*=[^=]/;

function indexOfMatch(src, re) {
  var m = re.exec(src);
  return m ? m.index : -1;
}

// Returns null when `src` is isolated correctly, else a one-line reason.
export function isolationProblem(src) {
  var staticAt = indexOfMatch(src, STATIC_RE);
  var dynamicAt = indexOfMatch(src, DYNAMIC_RE);
  if (staticAt === -1 && dynamicAt === -1) return null;
  var isolateAt = indexOfMatch(src, ISOLATE_RE);

  if (staticAt !== -1) {
    if (isolateAt === -1) {
      return 'statically imports a telemetry-touching module without importing ./isolate-env.mjs';
    }
    if (isolateAt > staticAt) {
      return 'imports ./isolate-env.mjs after a telemetry-touching module; move it above';
    }
    return null;
  }

  if (isolateAt !== -1 && isolateAt < dynamicAt) return null;
  var configAt = indexOfMatch(src, CONFIG_RE);
  var bufferAt = indexOfMatch(src, BUFFER_RE);
  if (configAt === -1 || configAt > dynamicAt) {
    return 'dynamically imports a telemetry-touching module without setting GAFFER_CONFIG_PATH first';
  }
  if (bufferAt === -1 || bufferAt > dynamicAt) {
    return 'dynamically imports a telemetry-touching module without setting GAFFER_BUFFER_PATH first';
  }
  return null;
}

test('every test that loads chat-handler, chat-registry, telemetry or index isolates its env first', () => {
  var files = readdirSync(TEST_DIR).filter((f) => /\.test\.mjs$/.test(f)).sort();
  assert.ok(files.length > 10, 'expected to scan the daemon test files, found ' + files.length);
  var problems = [];
  files.forEach((f) => {
    var problem = isolationProblem(readFileSync(join(TEST_DIR, f), 'utf8'));
    if (problem) problems.push(f + ': ' + problem);
  });
  assert.deepEqual(problems, [], 'unisolated test files:\n  ' + problems.join('\n  '));
});

test('the checker catches the unsafe shapes and accepts the safe ones', () => {
  assert.equal(isolationProblem("import { test } from 'node:test';\nimport { ChatHandler } from '../chat-handler.js';\n"),
    'statically imports a telemetry-touching module without importing ./isolate-env.mjs');
  assert.equal(isolationProblem("import {\n  a,\n  ChatHandler,\n} from '../chat-handler.js';\nimport './isolate-env.mjs';\n"),
    'imports ./isolate-env.mjs after a telemetry-touching module; move it above');
  // Env assignment above a static import is hoisted away: still unsafe.
  assert.equal(isolationProblem("process.env.GAFFER_CONFIG_PATH = 'x';\nprocess.env.GAFFER_BUFFER_PATH = 'y';\nimport * as t from '../telemetry.js';\n"),
    'statically imports a telemetry-touching module without importing ./isolate-env.mjs');
  assert.equal(isolationProblem("var t = await import('../telemetry.js');\nprocess.env.GAFFER_CONFIG_PATH = 'x';\n"),
    'dynamically imports a telemetry-touching module without setting GAFFER_CONFIG_PATH first');
  assert.equal(isolationProblem("process.env.GAFFER_CONFIG_PATH = 'x';\nvar t = await import('../chat-registry.js');\n"),
    'dynamically imports a telemetry-touching module without setting GAFFER_BUFFER_PATH first');

  assert.equal(isolationProblem("import './isolate-env.mjs';\nimport { ChatHandler } from '../chat-handler.js';\n"), null);
  assert.equal(isolationProblem("import './isolate-env.mjs';\nvar m = await import('../index.js');\n"), null);
  assert.equal(isolationProblem("process.env.GAFFER_CONFIG_PATH = 'x';\nprocess.env.GAFFER_BUFFER_PATH = 'y';\nvar t = await import('../telemetry.js');\n"), null);
  assert.equal(isolationProblem("import { wrapInSafety } from '../safety.js';\n"), null);
  // A comparison is not an assignment.
  assert.equal(isolationProblem("if (process.env.GAFFER_CONFIG_PATH === 'x') {}\nvar t = await import('../telemetry.js');\n"),
    'dynamically imports a telemetry-touching module without setting GAFFER_CONFIG_PATH first');
});

test('isolate-env points telemetry at a loopback address, never the real sheet', () => {
  var url = new URL(process.env.GAFFER_TELEMETRY_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].indexOf(url.hostname) !== -1,
    'GAFFER_TELEMETRY_URL must be loopback, got ' + url.href);
  assert.ok(!/script\.google\.com/i.test(url.href), 'GAFFER_TELEMETRY_URL points at the real endpoint');
  var apiBase = new URL(process.env.ANTHROPIC_BASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].indexOf(apiBase.hostname) !== -1,
    'ANTHROPIC_BASE_URL must be loopback in tests, got ' + apiBase.href);
});

test('isolate-env keeps the config, buffer and model cache away from the real install and the repo', () => {
  ['GAFFER_CONFIG_PATH', 'GAFFER_BUFFER_PATH', 'GAFFER_MODEL_CACHE_PATH'].forEach((name) => {
    var p = process.env[name];
    assert.ok(p, name + ' must be set');
    assert.ok(!/Application Support[\\/]Gaffer|[\\/]Gaffer[\\/]config\.json$/.test(p), name + ' points at a real install: ' + p);
    assert.ok(p.indexOf(join(TEST_DIR, '..', '..') + sep) !== 0, name + ' points inside the repo: ' + p);
  });
  // When this module owns the files they live under the OS temp dir.
  if (process.env.GAFFER_BUFFER_PATH.indexOf('gaffer-test-buffer-') !== -1) {
    assert.ok(process.env.GAFFER_BUFFER_PATH.indexOf(tmpdir()) === 0);
  }
});
