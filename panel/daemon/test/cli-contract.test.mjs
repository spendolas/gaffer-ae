import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newTurnState, observe, classify, userMessage, LAST_VERIFIED } from '../cli-contract.js';

// Each fixture is a scrubbed stream-json capture from a real `claude -p` run
// (standalone 2.1.236 and the desktop app's 2.1.289), replayed through the
// classifier exactly as chat-handler feeds it: one parsed event per line,
// then the exit code and stderr at close.

var FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli');
var KINDS = ['ok', 'stale_session', 'too_long', 'auth', 'model', 'api_error', 'unknown_error'];

function loadEvents(name) {
  return readFileSync(join(FIX, name + '.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
}
function loadStderr(name) {
  return readFileSync(join(FIX, name + '.stderr.txt'), 'utf8');
}

// Replays a fixture; `mutate(events, stderr)` may alter the stream before replay.
function replay(name, mutate) {
  var events = loadEvents(name);
  var stderr = loadStderr(name);
  var resuming = /^resume-/.test(name);
  var exitCode = /^ok-/.test(name) ? 0 : 1;
  if (mutate) { var r = mutate(events, stderr); if (typeof r === 'string') stderr = r; }
  var st = newTurnState(resuming);
  events.forEach(function (e) { observe(st, e); });
  return { st: st, verdict: classify(st, exitCode, stderr) };
}

['236', '289'].forEach(function (v) {
  test('ok-' + v + ': success turn classifies ok and records the CLI version from init', () => {
    var r = replay('ok-' + v);
    assert.equal(r.verdict.kind, 'ok');
    assert.equal(r.st.cliVersion, '2.1.' + v);
    assert.equal(r.st.sawResult, true);
  });

  test('resume-' + v + ': failed --resume is stale_session via structure', () => {
    var r = replay('resume-' + v);
    assert.equal(r.verdict.kind, 'stale_session');
    assert.equal(r.verdict.via, 'structure');
  });

  test('resume-' + v + ': reworded text still classifies via structure', () => {
    var r = replay('resume-' + v, function (events) {
      events.forEach(function (e) { if (e.type === 'result') e.errors = ['Session has gone away, sorry']; });
      return 'Session has gone away, sorry';
    });
    assert.equal(r.verdict.kind, 'stale_session');
    assert.equal(r.verdict.via, 'structure');
  });

  test('resume-' + v + ': with structure blocked, the text fallback still catches it', () => {
    var r = replay('resume-' + v, function (events) {
      events.forEach(function (e) { if (e.type === 'result') { e.num_turns = 1; e.errors = ['No conversation found']; } });
      return 'No conversation found';
    });
    assert.equal(r.verdict.kind, 'stale_session');
    assert.equal(r.verdict.via, 'text');
  });

  test('big-' + v + ': prompt too long is too_long via terminal_reason', () => {
    var r = replay('big-' + v);
    assert.equal(r.verdict.kind, 'too_long');
    assert.equal(r.verdict.via, 'structure');
  });

  test('badmodel-' + v + ': unknown model is model via structure', () => {
    var r = replay('badmodel-' + v);
    assert.equal(r.verdict.kind, 'model');
    assert.equal(r.verdict.via, 'structure');
    assert.equal(r.st.assistantApiError, true);
  });
});

test('a successful reply that mentions context length or prompt too long stays ok', () => {
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289', mcp_servers: [] });
  observe(st, { type: 'result', subtype: 'success', is_error: false, num_turns: 2,
    result: 'Done. I trimmed the layer to match the comp context, so its length is now 5s. Note the prompt is too long for one line.' });
  var v = classify(st, 0, '');
  assert.equal(v.kind, 'ok');
});

// A success result followed by an odd exit (the CLI tripping on its way out,
// or a signal) is still a success: the reply already reached the panel.
[1, null].forEach(function (code) {
  test('success result with exit ' + code + ' stays ok via structure and exposes the exit code', () => {
    var st = newTurnState(true);
    observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289', mcp_servers: [] });
    observe(st, { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 's-1', result: 'Done.' });
    var v = classify(st, code, 'some stderr noise\n');
    assert.equal(v.kind, 'ok');
    assert.equal(v.via, 'structure');
    assert.equal(v.exitCode, code);
  });
});

test('success result with exit 0 carries no exitCode field', () => {
  var st = newTurnState(false);
  observe(st, { type: 'result', subtype: 'success', is_error: false, result: 'Done.' });
  var v = classify(st, 0, '');
  assert.equal(v.kind, 'ok');
  assert.equal('exitCode' in v, false);
});

test('a success reply saying "prompt is too long" with exit 1 stays ok and never hits the text fallback', () => {
  var st = newTurnState(true);
  observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289' });
  observe(st, { type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    result: 'Your prompt is too long for one title, so I split it. No conversation found with that name.' });
  var v = classify(st, 1, 'No conversation found\n');
  assert.equal(v.kind, 'ok');
  assert.equal(v.via, 'structure');
  assert.equal(v.exitCode, 1);
});

test('no result and a null exit code says claude was stopped unexpectedly, not "code null"', () => {
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289' });
  var v = classify(st, null, '');
  assert.equal(v.kind, 'unknown_error');
  assert.equal(v.text, 'claude was stopped unexpectedly');
  assert.equal(userMessage(v).indexOf('null'), -1);
});

test('init then exit 1 with no result is unknown_error carrying stderr', () => {
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289' });
  var v = classify(st, 1, 'boom\n');
  assert.equal(v.kind, 'unknown_error');
  assert.equal(v.via, 'none');
  assert.ok(v.text.indexOf('boom') !== -1);
  assert.equal(st.sawResult, false);
});

test('init then exit 1 with empty stderr mentions the exit code', () => {
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init' });
  var v = classify(st, 1, '');
  assert.equal(v.kind, 'unknown_error');
  assert.ok(/1/.test(v.text));
  assert.ok(userMessage(v).indexOf('1') !== -1);
});

test('unknown event types, unknown terminal_reason and {code,message} errors never throw', () => {
  var st = newTurnState(false);
  assert.doesNotThrow(function () {
    observe(st, { type: 'wibble' });
    observe(st, { type: 'wibble', payload: 1 });
    observe(st, { type: 'system', subtype: 'init', mcp_servers: 'not-an-array' });
    observe(st, { type: 'assistant' });
    observe(st, { type: 'assistant', message: null });
    observe(st, {});
    observe(st, { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'something_new',
      api_error_status: 503, errors: [{ code: 'overloaded', message: 'Overloaded, try again' }, null, 42] });
  });
  assert.equal(st.unknownTypes.wibble, 2);
  var v = classify(st, 1, '');
  assert.equal(v.kind, 'api_error');
  assert.equal(v.via, 'structure');
  assert.equal(v.reason, 'something_new');
  assert.equal(v.status, 503);
  assert.ok(v.text.indexOf('Overloaded, try again') !== -1);
  assert.ok(userMessage(v).indexOf('Overloaded, try again') !== -1);
});

test('observe tolerates non-object and null input', () => {
  var st = newTurnState(false);
  assert.doesNotThrow(function () {
    observe(st, null);
    observe(st, undefined);
    observe(st, 'string');
    observe(st, 7);
    observe(null, { type: 'result' });
  });
});

test('authentication_failed maps to auth and the copy points at Gaffer Sign in', () => {
  var st = newTurnState(false);
  observe(st, { type: 'system', subtype: 'init', claude_code_version: '2.1.289' });
  observe(st, { type: 'assistant', error: 'authentication_failed', is_api_error_message: true,
    message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
  observe(st, { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error',
    api_error_status: null, result: 'Not logged in · Please run /login' });
  var v = classify(st, 1, '');
  assert.equal(v.kind, 'auth');
  assert.equal(v.via, 'structure');
  var msg = userMessage(v);
  assert.ok(msg.indexOf('Sign in') !== -1);
  assert.equal(msg.indexOf('/login'), -1);
});

test('too_long via text when terminal_reason is missing but the text says so', () => {
  var st = newTurnState(false);
  observe(st, { type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long · the request is huge' });
  var v = classify(st, 1, '');
  assert.equal(v.kind, 'too_long');
  assert.equal(v.via, 'text');
});

test('api_error and unknown_error copy trims the CLI text to 400 chars and handles empty text', () => {
  var long = new Array(600).join('x');
  var a = userMessage({ kind: 'api_error', via: 'structure', text: long });
  assert.ok(a.indexOf(long) === -1);
  assert.ok(a.indexOf(long.slice(0, 400)) !== -1);
  var empty = userMessage({ kind: 'api_error', via: 'structure', text: '' });
  assert.ok(empty.length > 10);
  var u = userMessage({ kind: 'unknown_error', via: 'none', text: '' });
  assert.ok(u.length > 10);
});

test('userMessage has no em or en dashes for any kind, and never throws', () => {
  KINDS.forEach(function (k) {
    var msg = userMessage({ kind: k, via: 'structure', text: 'some cli text' });
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 0, k + ' has copy');
    assert.equal(/[–—]/.test(msg), false, k + ' has no dashes');
  });
  assert.equal(typeof userMessage({ kind: 'nope' }), 'string');
  assert.equal(typeof userMessage(null), 'string');
});

test('LAST_VERIFIED is the fixture range', () => {
  assert.deepEqual(LAST_VERIFIED, { min: '2.1.236', max: '2.1.289' });
});
