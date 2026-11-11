// Shared assertions for the chat lockdown tests. Defines no tests (Node's
// runner executes it once during discovery and exits quietly).
import assert from 'node:assert/strict';

var UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// Flags whose next token is a separate value.
var VALUE_FLAGS = ['--model', '--output-format', '--input-format', '--effort', '--tools',
  '--mcp-config', '--setting-sources', '--append-system-prompt'];
// Flags that take no value.
var BARE_FLAGS = ['-p', '--verbose', '--dangerously-skip-permissions', '--strict-mcp-config', '--disable-slash-commands'];
// --resume takes an OPTIONAL value, so it is only ever passed attached.
var RESUME_RE = new RegExp('^--resume=' + UUID + '$', 'i');

export function value(args, flag) { return args[args.indexOf(flag) + 1]; }

// The session id carried by the attached --resume=<id> token, or null.
export function resumeId(args) {
  var t = args.filter(function (a) { return a.indexOf('--resume') === 0; });
  if (!t.length) return null;
  assert.equal(t.length, 1, 'one --resume');
  assert.match(t[0], RESUME_RE);
  return t[0].slice('--resume='.length);
}

// Every token is a known flag, the value of a known value flag, or an
// attached --resume=<uuid>. A token that looks like an option and is none of
// those (for example an injected --tools=Bash) fails, and so does a positional.
export function assertNoPositional(args) {
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    var prev = i > 0 ? args[i - 1] : null;
    if (prev !== null && VALUE_FLAGS.indexOf(prev) !== -1) continue; // a value, even an empty or dash-led one
    if (BARE_FLAGS.indexOf(a) !== -1 || VALUE_FLAGS.indexOf(a) !== -1 || RESUME_RE.test(a)) continue;
    assert.fail('unexpected token "' + String(a).slice(0, 40) + '" at ' + i);
  }
  // a value flag must not be the last token
  assert.equal(VALUE_FLAGS.indexOf(args[args.length - 1]), -1, 'dangling value flag');
}

function count(args, flag) { return args.filter(function (a) { return a === flag; }).length; }

// The lockdown every chat or compaction spawn must carry. Used by the unit
// tests here and by the handler tests in chat-handler-lockdown.test.mjs.
export function assertLockdown(args, opts) {
  opts = opts || {};
  assert.equal(count(args, '--tools'), 1, 'exactly one --tools');
  assert.equal(value(args, '--tools'), '', '--tools must name no built-in tool');
  assert.equal(count(args, '--strict-mcp-config'), 1, 'exactly one --strict-mcp-config');
  assert.equal(count(args, '--setting-sources'), 1, 'exactly one --setting-sources');
  assert.equal(value(args, '--setting-sources'), '', 'no settings source may load');
  assert.equal(count(args, '--disable-slash-commands'), 1);
  assert.equal(count(args, '--dangerously-skip-permissions'), 1, 'bypass stays by design');
  ['--allowedTools', '--disallowedTools', '--settings', '--add-dir', '--plugin-dir', '--agents'].forEach(function (f) {
    assert.equal(args.some(function (a) { return a === f || a.indexOf(f + '=') === 0; }), false, f);
  });
  // no =-form variant of any option other than the attached --resume=<id>
  args.forEach(function (a) {
    if (a.indexOf('--') === 0 && a.indexOf('=') !== -1) assert.match(a, RESUME_RE, 'unexpected =-form option');
  });
  if (opts.mcp === false) assert.equal(count(args, '--mcp-config'), 0, 'compaction has no MCP at all');
  else assert.equal(count(args, '--mcp-config'), 1, 'exactly one --mcp-config');
  assertNoPositional(args);
}
