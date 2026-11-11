// Shared assertions for the chat lockdown tests. Defines no tests (Node's
// runner executes it once during discovery and exits quietly).
import assert from 'node:assert/strict';

// Flags whose next token is a value. Any other non-flag token in the argument
// list would be a positional, and the variadic options swallow a trailing
// positional, so the prompt must never be one.
var VALUE_FLAGS = ['--model', '--output-format', '--input-format', '--effort', '--tools',
  '--mcp-config', '--setting-sources', '--resume', '--append-system-prompt'];

export function value(args, flag) { return args[args.indexOf(flag) + 1]; }

export function assertNoPositional(args) {
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (a.indexOf('-') === 0) continue;
    assert.ok(i > 0 && VALUE_FLAGS.indexOf(args[i - 1]) !== -1,
      'token "' + String(a).slice(0, 30) + '" at ' + i + ' is a positional');
  }
}

// The lockdown every chat or compaction spawn must carry. Used by the unit
// tests here and by the handler tests in chat-handler-lockdown.test.mjs.
export function assertLockdown(args, opts) {
  opts = opts || {};
  assert.ok(args.indexOf('--tools') !== -1, 'missing --tools');
  assert.equal(value(args, '--tools'), '', '--tools must name no built-in tool');
  assert.ok(args.indexOf('--strict-mcp-config') !== -1, 'missing --strict-mcp-config');
  assert.ok(args.indexOf('--setting-sources') !== -1, 'missing --setting-sources');
  assert.equal(value(args, '--setting-sources'), '', 'no settings source may load');
  assert.ok(args.indexOf('--disable-slash-commands') !== -1, 'missing --disable-slash-commands');
  assert.equal(args.indexOf('--allowedTools'), -1);
  assert.equal(args.indexOf('--disallowedTools'), -1);
  assert.ok(args.indexOf('--dangerously-skip-permissions') !== -1, 'bypass stays by design');
  if (opts.mcp === false) assert.equal(args.indexOf('--mcp-config'), -1, 'compaction has no MCP at all');
  else assert.ok(args.indexOf('--mcp-config') !== -1, 'missing --mcp-config');
  assertNoPositional(args);
}

