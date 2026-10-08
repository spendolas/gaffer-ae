import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_FLAGS, GAFFER_EFFORTS, ZERO_UUID, SCRUBBED_ENV,
  parseVersionLine, helpListsFlag, missingFlags, parseEffortChoices, missingEfforts,
  parseStreamLines, envelopeProblems, classifyCapture, paidTurnProblems, chooseConfigDir, childEnv,
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
    // Every invocation appends its argv and the env it saw to a log file the
    // test names through GAFFER_FAKE_LOG (which the script passes through).
    'if (process.env.GAFFER_FAKE_LOG) {',
    '  fs.appendFileSync(process.env.GAFFER_FAKE_LOG, JSON.stringify({ args: args, env: process.env }) + "\\n");',
    '}',
    'function out(s, code) { fs.writeSync(1, s); process.exitCode = code; }',
    // A result edited in place: the auth capture with one field changed.
    'function authWith(patch) {',
    '  return AUTH.split("\\n").filter(Boolean).map(function (l) {',
    '    var e = JSON.parse(l); if (e.type === "result") Object.assign(e, patch); return JSON.stringify(e);',
    '  }).join("\\n") + "\\n";',
    '}',
    // Ignore SIGTERM and sleep: only SIGKILL ends this.
    'function hang() { process.on("SIGTERM", function () {}); setInterval(function () {}, 1000); }',
    'if (args[0] === "--version") { if (mode === "hangversion") hang(); else out(mode === "noversion" ? "Claude Code\\n" : "2.1.293 (Claude Code)\\n", 0); }',
    'else if (args[0] === "--help") { if (mode === "hanghelp") { fs.writeSync(1, "partial help\\n"); hang(); } else out(mode === "noflag" ? HELP.replace("  --verbose", "  --loud") : HELP, 0); }',
    'else if (args.indexOf("--resume") !== -1) {',
    '  if (mode === "resumetext") { var e = JSON.parse(RESUME.trim()); e.num_turns = 1; out(JSON.stringify(e) + "\\n", 1); fs.writeSync(2, RESUME_ERR); }',
    '  else if (mode === "paidresume") { var p = JSON.parse(RESUME.trim()); p.total_cost_usd = 0.0123; out(JSON.stringify(p) + "\\n", 1); }',
    '  else { out(RESUME, 1); fs.writeSync(2, RESUME_ERR); }',
    '}',
    'else if (args.indexOf("--verbose") === -1) { fs.writeSync(2, "Error: When using --print, --output-format=stream-json requires --verbose\\n"); process.exitCode = 1; }',
    'else if (mode === "noauth") { out(AUTH.replace("authentication_failed", "something_else"), 1); }',
    'else if (mode === "paid") { out(authWith({ total_cost_usd: 0.004 }), 1); }',
    'else if (mode === "okturn") { out(authWith({ is_error: false, subtype: "success", result: "Hello!" }), 0); }',
    'else { out(AUTH, 1); }',
  ].join('\n');
  var p = join(dir, 'claude');
  writeFileSync(p, src);
  chmodSync(p, 493); // 0755
  return p;
}

function runScript(bin, extra) {
  extra = extra || {};
  var args = [SCRIPT, '--bin', bin].concat(extra.args || []);
  var env = Object.assign({}, process.env, extra.env || {});
  return new Promise(function (done) {
    var started = Date.now();
    execFile(process.execPath, args, { encoding: 'utf-8', timeout: 60000, env: env }, function (err, stdout, stderr) {
      done({ code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '', ms: Date.now() - started });
    });
  });
}

// The fake's invocation log: one {args, env} per call, in order.
function readFakeLog(path) {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); }); }
  catch (e) { return []; }
}

function isProbe(call, flag) { return call.args.indexOf(flag) !== -1; }

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

// ---- isolation: the child can never be a signed-in paid turn ----

test('isolation: an exported CLAUDE_CONFIG_DIR, HOME, API keys and backend switches never reach the child', { skip: !canExecFake }, async () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-cc-fake-'));
  var exportedCfg = join(dir, 'exported-config');
  mkdirSync(exportedCfg);
  writeFileSync(join(exportedCfg, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"not-real"}}');
  var log = join(dir, 'calls.jsonl');
  var r = await runScript(writeFakeClaude(dir, 'ok'), { env: {
    GAFFER_FAKE_LOG: log,
    CLAUDE_CONFIG_DIR: exportedCfg,
    HOME: join(dir, 'exported-home'),
    ANTHROPIC_API_KEY: 'sk-ant-not-real',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example',
  } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /config dir: .* \(fresh, signed out\)/);
  assert.match(r.stdout, /home: .* \(fresh\)/);
  var calls = readFakeLog(log);
  assert.ok(calls.length >= 5, 'every probe ran: ' + calls.length);
  calls.forEach(function (c) {
    assert.notEqual(c.env.CLAUDE_CONFIG_DIR, exportedCfg, 'exported CLAUDE_CONFIG_DIR ignored');
    assert.ok(c.env.CLAUDE_CONFIG_DIR && c.env.CLAUDE_CONFIG_DIR.indexOf('gaffer-cli-contract-cfg-') !== -1, 'fresh temp config dir: ' + c.env.CLAUDE_CONFIG_DIR);
    assert.ok(c.env.HOME && c.env.HOME.indexOf('gaffer-cli-contract-home-') !== -1, 'fresh temp HOME: ' + c.env.HOME);
    assert.equal(c.env.USERPROFILE, c.env.HOME);
    SCRUBBED_ENV.forEach(function (k) { assert.equal(k in c.env, false, k + ' removed from the child env'); });
  });
  // One run, one config dir and one home, shared by all probes.
  assert.equal(new Set(calls.map(function (c) { return c.env.CLAUDE_CONFIG_DIR; })).size, 1);
  assert.equal(new Set(calls.map(function (c) { return c.env.HOME; })).size, 1);
});

test('isolation: --config-dir is honoured when it holds no credentials', { skip: !canExecFake }, async () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-cc-fake-'));
  var cfg = join(dir, 'plain-config');
  mkdirSync(cfg);
  writeFileSync(join(cfg, 'settings.json'), '{}');
  var log = join(dir, 'calls.jsonl');
  var r = await runScript(writeFakeClaude(dir, 'ok'), { args: ['--config-dir', cfg], env: { GAFFER_FAKE_LOG: log } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /from --config-dir, no credentials file/);
  var calls = readFakeLog(log);
  assert.ok(calls.length >= 5);
  calls.forEach(function (c) { assert.equal(c.env.CLAUDE_CONFIG_DIR, cfg); });
});

test('isolation: --config-dir with a .credentials.json refuses to run before any probe', { skip: !canExecFake }, async () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-cc-fake-'));
  var cfg = join(dir, 'signed-in-config');
  mkdirSync(cfg);
  writeFileSync(join(cfg, '.credentials.json'), '{}');
  var log = join(dir, 'calls.jsonl');
  var r = await runScript(writeFakeClaude(dir, 'ok'), { args: ['--config-dir', cfg], env: { GAFFER_FAKE_LOG: log } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /REFUSING to run: .*\.credentials\.json exists/);
  assert.equal(/PASS |FAIL /.test(r.stdout), false, 'no probe ran');
  assert.deepEqual(readFakeLog(log), [], 'the binary was never invoked');
});

test('chooseConfigDir and childEnv (pure): fresh dir by default, refusal on credentials, env scrubbed', () => {
  var fresh = chooseConfigDir(null, function () { return false; });
  assert.equal(fresh.refusal, null);
  assert.ok(fresh.dir.indexOf('gaffer-cli-contract-cfg-') !== -1);
  var named = chooseConfigDir('/some/dir', function (p) { return p === join('/some/dir', '.credentials.json'); });
  assert.match(named.refusal, /REFUSING/);
  assert.equal(chooseConfigDir('/other/dir', function () { return false; }).refusal, null);
  var env = childEnv({ PATH: '/bin', HOME: '/real', CLAUDE_CONFIG_DIR: '/real/.claude', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1', KEEP: 'me' }, '/tmp/h', '/tmp/c');
  assert.deepEqual(env, { PATH: '/bin', KEEP: 'me', HOME: '/tmp/h', USERPROFILE: '/tmp/h', CLAUDE_CONFIG_DIR: '/tmp/c' });
  assert.deepEqual(SCRUBBED_ENV.slice().sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']);
});

test('paidTurnProblems (pure): quiet on the $0 failure captures, loud on cost or success', () => {
  assert.deepEqual(paidTurnProblems(parseStreamLines(fixture('auth-293').stdout).events), []);
  assert.deepEqual(paidTurnProblems(parseStreamLines(fixture('resume-293').stdout).events), []);
  assert.deepEqual(paidTurnProblems([]), []);
  assert.deepEqual(paidTurnProblems([{ type: 'result', is_error: true, total_cost_usd: 0 }]), []);
  var cost = paidTurnProblems([{ type: 'result', is_error: true, total_cost_usd: 0.002 }]);
  assert.equal(cost.length, 1);
  assert.match(cost[0], /total_cost_usd=0\.002/);
  var ok = paidTurnProblems([{ type: 'result', is_error: false, subtype: 'success', total_cost_usd: 0 }]);
  assert.equal(ok.length, 1);
  assert.match(ok[0], /SUCCEEDED/);
  assert.equal(paidTurnProblems([{ type: 'result', is_error: false, total_cost_usd: 1 }]).length, 2);
});

test('abort: a probe that reports total_cost_usd > 0 fails loudly and stops before the next probe', { skip: !canExecFake }, async () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-cc-fake-'));
  var log = join(dir, 'calls.jsonl');
  var r = await runScript(writeFakeClaude(dir, 'paidresume'), { env: { GAFFER_FAKE_LOG: log } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL bad --resume is a \$0 signed-out failure: result reports total_cost_usd=0\.0123/);
  assert.match(r.stdout, /ABORTING: a probe was not the signed-out \$0 failure/);
  assert.match(r.stdout, /CLI CONTRACT CHECK FAILED/);
  var calls = readFakeLog(log);
  assert.ok(calls.some(function (c) { return isProbe(c, '--resume'); }), 'the resume probe ran');
  assert.equal(calls.filter(function (c) { return isProbe(c, '-p') && !isProbe(c, '--resume'); }).length, 0, 'no later -p probe ran after the abort');
});

test('abort: a signed-out turn that costs money or succeeds fails loudly', { skip: !canExecFake }, async () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-cc-fake-'));
  var paid = await runScript(writeFakeClaude(dir, 'paid'));
  assert.equal(paid.code, 1, paid.stdout + paid.stderr);
  assert.match(paid.stdout, /FAIL signed-out turn is a \$0 signed-out failure: result reports total_cost_usd=0\.004/);
  assert.match(paid.stdout, /ABORTING/);
  var dir2 = mkdtempSync(join(tmpdir(), 'gaffer-cc-fake-'));
  var log = join(dir2, 'calls.jsonl');
  var ok = await runScript(writeFakeClaude(dir2, 'okturn'), { env: { GAFFER_FAKE_LOG: log } });
  assert.equal(ok.code, 1, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /the turn SUCCEEDED \(subtype=success\)/);
  assert.match(ok.stdout, /ABORTING/);
  // The informational no-verbose probe, which would be the third -p turn, never ran.
  var pTurns = readFakeLog(log).filter(function (c) { return isProbe(c, '-p'); });
  assert.equal(pTurns.length, 2, 'resume probe and signed-out turn only');
});

// ---- timeouts: a CLI that ignores SIGTERM cannot hang the job ----

['hangversion', 'hanghelp'].forEach(function (mode) {
  test('timeout: a fake claude whose ' + (mode === 'hangversion' ? '--version (execFile path)' : '--help (file-redirect path)') + ' ignores SIGTERM is killed and the check finishes', { skip: !canExecFake }, async () => {
    var dir = mkdtempSync(join(tmpdir(), 'gaffer-cc-fake-'));
    var r = await runScript(writeFakeClaude(dir, mode), { env: { GAFFER_CLI_CONTRACT_TIMEOUT_MS: '1500' } });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /CLI CONTRACT CHECK FAILED/);
    // 1.5 s timeout, 5 s SIGTERM grace, 1 s last resort, plus the other probes: well under the 60 s harness limit.
    assert.ok(r.ms < 30000, 'finished in ' + r.ms + ' ms');
    if (mode === 'hangversion') assert.match(r.stdout, /FAIL --version prints x\.y\.z/);
    else assert.match(r.stdout, /FAIL --help runs: exit=null/);
  });
});

test('ZERO_UUID is the nil-style id the fixtures were captured with', () => {
  assert.equal(ZERO_UUID, '00000000-0000-4000-8000-000000000000');
  assert.ok(fixture('resume-293').stderr.indexOf(ZERO_UUID) !== -1);
});
