import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_FLAGS, GAFFER_EFFORTS, ZERO_UUID,
  parseVersionLine, helpListsFlag, missingFlags, parseEffortChoices, missingEfforts,
  parseStreamLines, envelopeProblems, classifyCapture,
} from './cli-contract-check.mjs';

// The pure helpers of the weekly CLI contract check, plus one end-to-end run
// of the script against a fake `claude` (a small node program) in both its
// passing and failing shapes, so the exit codes are proven without a real
// CLI or network. Fixtures: the scrubbed real captures in
// panel/daemon/test/fixtures/cli.

var HERE = dirname(fileURLToPath(import.meta.url));
var REPO = join(HERE, '..');
var FIX = join(REPO, 'panel', 'daemon', 'test', 'fixtures', 'cli');
var SCRIPT = join(HERE, 'cli-contract-check.mjs');

function fixture(name) {
  return {
    stdout: readFileSync(join(FIX, name + '.jsonl'), 'utf8'),
    stderr: readFileSync(join(FIX, name + '.stderr.txt'), 'utf8'),
  };
}

var HELP = [
  'Usage: claude [options] [command] [prompt]',
  '',
  'Options:',
  '  --allowedTools, --allowed-tools <tools...>  Comma or space-separated list',
  '  --append-system-prompt <prompt>       Append a system prompt to the default',
  '  --dangerously-skip-permissions        Bypass all permission checks.',
  '  --effort <level>                      Effort level for the current session',
  '                                        (low, medium, high, xhigh, max)',
  '  --mcp-config <configs...>             Load MCP servers from JSON files or',
  '  --model <model>                       Model for the current session.',
  '  --output-format <format>              Output format (only works with --print):',
  '  -p, --print                           Print response and exit',
  '  -r, --resume [value]                  Resume a conversation by session ID',
  '  --verbose                             Override verbose mode setting',
].join('\n');

test('parseVersionLine: leading x.y.z, warning lines, v prefix, nothing', () => {
  assert.equal(parseVersionLine('2.1.294 (Claude Code)\n'), '2.1.294');
  assert.equal(parseVersionLine('(node) warning\n2.1.236 (Claude Code)'), '2.1.236');
  assert.equal(parseVersionLine('v2.1.1'), '2.1.1');
  assert.equal(parseVersionLine(''), null);
  assert.equal(parseVersionLine('Claude Code'), null);
  assert.equal(parseVersionLine(null), null);
});

test('helpListsFlag: whole tokens only, aliases on one line, prefixes do not count', () => {
  REQUIRED_FLAGS.forEach(function (f) { assert.equal(helpListsFlag(HELP, f), true, f); });
  assert.equal(helpListsFlag(HELP, '--output'), false, 'prefix of --output-format');
  assert.equal(helpListsFlag(HELP, '--allowed-tools'), true, 'second alias after a comma');
  assert.equal(helpListsFlag(HELP, '--frobnicate'), false);
  assert.equal(helpListsFlag('', '-p'), false);
  assert.equal(helpListsFlag('  -p, --print', '-p'), true);
  assert.equal(helpListsFlag('  --print-p', '-p'), false);
});

test('missingFlags: empty on the full help, names what is gone', () => {
  assert.deepEqual(missingFlags(HELP), []);
  var noVerbose = HELP.split('\n').filter(function (l) { return l.indexOf('--verbose') === -1; }).join('\n');
  assert.deepEqual(missingFlags(noVerbose), ['--verbose']);
  assert.deepEqual(missingFlags('nothing here'), REQUIRED_FLAGS);
  assert.deepEqual(missingFlags(HELP, ['--model', '--nope']), ['--nope']);
});

test('parseEffortChoices / missingEfforts: the parenthesised list after --effort', () => {
  assert.deepEqual(parseEffortChoices(HELP), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(missingEfforts(parseEffortChoices(HELP)), []);
  var dropped = HELP.replace('xhigh, ', '');
  assert.deepEqual(missingEfforts(parseEffortChoices(dropped)), ['xhigh']);
  assert.deepEqual(parseEffortChoices('no such flag'), []);
  assert.deepEqual(missingEfforts([]), GAFFER_EFFORTS);
  // The real help texts of every version with fixtures parse the same way.
  var real = '  --effort <level>                      Effort level for the current session\n'
    + '                                        (low, medium, high, xhigh, max)\n'
    + '  --environment <environment_id>        Create a new cloud session (ccpool_...)';
  assert.deepEqual(parseEffortChoices(real), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('GAFFER_EFFORTS matches the effort list chat-handler.js hands to --effort', () => {
  var src = readFileSync(join(REPO, 'panel', 'daemon', 'chat-handler.js'), 'utf8');
  var m = /var EFFORTS = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'chat-handler.js declares the EFFORTS list used for --effort');
  var declared = m[1].split(',').map(function (s) { return s.trim().replace(/^'|'$/g, ''); }).filter(Boolean);
  assert.deepEqual(declared, GAFFER_EFFORTS);
});

test('parseStreamLines: JSON per line, blank lines skipped, junk collected', () => {
  var r = parseStreamLines('{"type":"a"}\n\n{"type":"b"}\nnot json\n');
  assert.deepEqual(r.events.map(function (e) { return e.type; }), ['a', 'b']);
  assert.deepEqual(r.badLines, ['not json']);
  assert.deepEqual(parseStreamLines(''), { events: [], badLines: [] });
});

['236', '289', '293'].forEach(function (v) {
  test('real resume-' + v + ' capture: stale_session via structure, result envelope ok', () => {
    var fx = fixture('resume-' + v);
    var events = parseStreamLines(fx.stdout).events;
    var r = classifyCapture(events, 1, fx.stderr, true);
    assert.equal(r.verdict.kind, 'stale_session');
    assert.equal(r.verdict.via, 'structure');
    assert.deepEqual(envelopeProblems(events, { expectInit: false, expectAssistant: false }), []);
  });
});

test('real auth-293 capture: auth via structure, all three envelopes ok, version recorded', () => {
  var fx = fixture('auth-293');
  var events = parseStreamLines(fx.stdout).events;
  var r = classifyCapture(events, 1, fx.stderr, false);
  assert.equal(r.verdict.kind, 'auth');
  assert.equal(r.verdict.via, 'structure');
  assert.equal(r.st.cliVersion, '2.1.293');
  assert.deepEqual(envelopeProblems(events, { expectAssistantError: true }), []);
});

test('envelopeProblems names each drifted field and never throws on junk', () => {
  var problems = envelopeProblems([
    { type: 'system', subtype: 'init', claude_code_version: 42, mcp_servers: 'x' },
    { type: 'assistant', message: { content: 'text' } },
    { type: 'result', subtype: 7, is_error: 'yes', session_id: null, num_turns: '1', errors: 'oops' },
  ], { expectAssistantError: true });
  ['claude_code_version', 'mcp_servers', 'assistant.message.content', 'assistant.message.usage',
    'assistant.error', 'is_api_error_message', 'result.subtype', 'result.is_error', 'result.session_id',
    'result.num_turns', 'result.errors'].forEach(function (field) {
    assert.ok(problems.some(function (p) { return p.indexOf(field) !== -1; }), 'reports ' + field + ' in ' + JSON.stringify(problems));
  });
  assert.deepEqual(envelopeProblems([]), ['no system/init event', 'no assistant event', 'no result event']);
  assert.doesNotThrow(function () { envelopeProblems([null, 1, 'x', {}]); });
});

// ---- end to end against a fake claude ----

// A node program that answers --version, --help and the two -p probes the way
// the real CLI does (shapes lifted from the 2.1.293 captures). MODE, read
// from a sidecar file, breaks one thing at a time.
function writeFakeClaude(dir, mode) {
  var fx = {
    resume: fixture('resume-293'),
    auth: fixture('auth-293'),
  };
  var src = [
    '#!/usr/bin/env node',
    'var fs = require("fs");',
    'var mode = ' + JSON.stringify(mode) + ';',
    'var args = process.argv.slice(2);',
    'var HELP = ' + JSON.stringify(HELP) + ';',
    'var RESUME = ' + JSON.stringify(fx.resume.stdout) + ';',
    'var RESUME_ERR = ' + JSON.stringify(fx.resume.stderr) + ';',
    'var AUTH = ' + JSON.stringify(fx.auth.stdout) + ';',
    'function out(s, code) { fs.writeSync(1, s); process.exitCode = code; }',
    'if (args[0] === "--version") { out(mode === "noversion" ? "Claude Code\\n" : "2.1.293 (Claude Code)\\n", 0); }',
    'else if (args[0] === "--help") { out(mode === "noflag" ? HELP.replace("  --verbose", "  --loud") : HELP, 0); }',
    'else if (args.indexOf("--resume") !== -1) {',
    '  if (mode === "resumetext") { var e = JSON.parse(RESUME.trim()); e.num_turns = 1; out(JSON.stringify(e) + "\\n", 1); fs.writeSync(2, RESUME_ERR); }',
    '  else { out(RESUME, 1); fs.writeSync(2, RESUME_ERR); }',
    '}',
    'else if (args.indexOf("--verbose") === -1) { fs.writeSync(2, "Error: When using --print, --output-format=stream-json requires --verbose\\n"); process.exitCode = 1; }',
    'else if (mode === "noauth") { out(AUTH.replace("authentication_failed", "something_else"), 1); }',
    'else { out(AUTH, 1); }',
  ].join('\n');
  var p = join(dir, 'claude');
  writeFileSync(p, src);
  chmodSync(p, 493); // 0755
  return p;
}

function runScript(bin) {
  return new Promise(function (done) {
    execFile(process.execPath, [SCRIPT, '--bin', bin], { encoding: 'utf-8', timeout: 60000 }, function (err, stdout, stderr) {
      done({ code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

var canExecFake = process.platform !== 'win32';

test('end to end: a conforming fake claude passes with exit 0 and prints the version', { skip: !canExecFake }, async () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-cc-fake-'));
  var r = await runScript(writeFakeClaude(dir, 'ok'));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS --version prints x\.y\.z: 2\.1\.293/);
  assert.match(r.stdout, /passed against claude 2\.1\.293/);
  assert.equal(/FAIL /.test(r.stdout), false);
  assert.match(r.stdout, /still requires --verbose/);
});

[
  ['noflag', /missing --verbose/],
  ['noversion', /--version prints x\.y\.z/],
  ['resumetext', /stale_session via structure: kind=stale_session via=text/],
  ['noauth', /classifies auth via structure: kind=api_error/],
].forEach(function (row) {
  test('end to end: fake claude with ' + row[0] + ' drift fails with exit 1 and names it', { skip: !canExecFake }, async () => {
    var dir = mkdtempSync(join(tmpdir(), 'gaffer-cc-fake-'));
    var r = await runScript(writeFakeClaude(dir, row[0]));
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /CLI CONTRACT CHECK FAILED/);
    assert.match(r.stdout, row[1]);
  });
});

test('end to end: a missing binary fails with exit 1 and says it could not run', { skip: !canExecFake }, async () => {
  var r = await runScript('/nonexistent/claude-' + process.pid);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /could not run/);
});

test('ZERO_UUID is the nil-style id the fixtures were captured with', () => {
  assert.equal(ZERO_UUID, '00000000-0000-4000-8000-000000000000');
  assert.ok(fixture('resume-293').stderr.indexOf(ZERO_UUID) !== -1);
});
