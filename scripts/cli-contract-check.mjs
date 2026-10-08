#!/usr/bin/env node
// Does the installed `claude` still speak the language Gaffer's chat layer
// expects? Run weekly by .github/workflows/cli-contract.yml against the
// latest npm release, signed out and with no API key, so every probe is $0:
//
//   1. `--version` prints x.y.z.
//   2. `--help` still lists every flag chat-handler.js passes, and the
//      --effort choices cover every level Gaffer can request.
//   3. `-p ... --resume <zero uuid>` yields the structured stale-session
//      shape and cli-contract.js classifies it stale_session via=structure.
//   4. A signed-out `-p` turn yields an init event with claude_code_version,
//      an auth failure classified auth via=structure, and init / assistant /
//      result envelopes that still parse the way chat-handler reads them.
//
// Exit 1 with a summary on any mismatch (the job fails, the maintainer gets
// the email). Plain Node, no dependencies beyond the repo's own
// panel/daemon/cli-contract.js.
//
// Usage:
//   node scripts/cli-contract-check.mjs [--bin /path/to/claude] [--out <dir>] [--config-dir <dir>]
//   CLAUDE_BIN=/path/to/claude node scripts/cli-contract-check.mjs
// With neither --bin nor CLAUDE_BIN, `claude` is taken from PATH (what CI
// does).
//
// Isolation, so a run can never become a signed-in paid turn: the child
// always gets a fresh empty temp dir as CLAUDE_CONFIG_DIR and a fresh temp
// HOME (and USERPROFILE), whatever the caller's shell has exported. An
// exported CLAUDE_CONFIG_DIR is ignored; another config dir is accepted only
// through the explicit --config-dir flag, and the run refuses to start if
// that dir holds a .credentials.json. API keys, OAuth tokens and the
// Bedrock/Vertex/base-URL switches are removed from the child environment.
// Every -p probe's result is then checked: a turn that succeeds, or reports
// total_cost_usd above zero, aborts the run with exit 1 before the next
// probe, so the "this costs $0" claim is enforced by the check itself rather
// than assumed from how a given CLI version treats the OS keychain. (The
// isolated run was exercised against the desktop app's 2.1.293 binary on
// macOS when this was written; the enforcement is what carries it forward.)

import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newTurnState, observe, classify, LAST_VERIFIED, versionStatus } from '../panel/daemon/cli-contract.js';

// Environment that could sign the child in, point it at a paid backend or
// route it through a cloud provider. Removed from the child env, always.
export var SCRUBBED_ENV = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
];

// Flags chat-handler.js passes on every chat spawn (handleChat), the
// compaction spawn and the resume path. `-p` is listed as "-p, --print".
export var REQUIRED_FLAGS = [
  '-p', '--output-format', '--verbose', '--dangerously-skip-permissions',
  '--effort', '--mcp-config', '--allowedTools', '--append-system-prompt',
  '--resume', '--model',
];

// Every effort level Gaffer can hand to --effort (chat-handler.js
// MODEL_DISCOVERY_EFFORTS / ALL_EFFORTS). Kept in sync by hand; the test
// file asserts it against chat-handler's exported list.
export var GAFFER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export var ZERO_UUID = '00000000-0000-4000-8000-000000000000';

// Per-probe time limit (the workflow adds a 15 minute cap on the whole job).
// Env-overridable so the test file can prove the kill path in seconds.
var SPAWN_TIMEOUT_MS = Number(process.env.GAFFER_CLI_CONTRACT_TIMEOUT_MS) > 0
  ? Number(process.env.GAFFER_CLI_CONTRACT_TIMEOUT_MS) : 90000;
// After SIGTERM on a timed-out probe, how long before SIGKILL follows.
var KILL_GRACE_MS = 5000;
var MAX_BUFFER = 16 * 1024 * 1024;

// ---------- pure helpers (unit-tested in cli-contract-check.test.mjs) ----------

// The x.y.z a `--version` run printed, or null. Tolerates a warning line
// before the version and a trailing "(Claude Code)".
export function parseVersionLine(stdout) {
  var lines = String(stdout || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var m = /^\s*v?(\d+\.\d+\.\d+)/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

// A flag counts as listed when it appears in --help as its own token: at a
// line start or after whitespace or a comma, followed by whitespace, a comma
// or the end. So "--allowedTools, --allowed-tools <tools...>" lists both,
// and "--output-format" does not satisfy a search for "--output".
export function helpListsFlag(helpText, flag) {
  var esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[\\s,])' + esc + '(?=[\\s,=]|$)', 'm').test(String(helpText || ''));
}

export function missingFlags(helpText, flags) {
  return (flags || REQUIRED_FLAGS).filter(function (f) { return !helpListsFlag(helpText, f); });
}

// The choices printed after `--effort <level>` in --help, e.g.
// "(low, medium, high, xhigh, max)" on the following line. Empty when the
// flag or its parenthesised list is missing.
export function parseEffortChoices(helpText) {
  var m = /--effort\s+<[^>]*>[\s\S]{0,400}?\(([^)]*)\)/.exec(String(helpText || ''));
  if (!m) return [];
  return m[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

export function missingEfforts(choices, wanted) {
  return (wanted || GAFFER_EFFORTS).filter(function (e) { return choices.indexOf(e) === -1; });
}

// stream-json stdout into events, the way chat-handler's line reader does:
// one JSON object per non-empty line, non-JSON lines collected separately.
export function parseStreamLines(stdout) {
  var events = [], badLines = [];
  String(stdout || '').split('\n').forEach(function (line) {
    if (!line.trim()) return;
    try { events.push(JSON.parse(line)); } catch (e) { badLines.push(line.slice(0, 200)); }
  });
  return { events: events, badLines: badLines };
}

function firstOf(events, pred) {
  for (var i = 0; i < events.length; i++) if (pred(events[i])) return events[i];
  return null;
}

// Shape checks on the three envelopes chat-handler reads fields from. Returns
// a list of problems (empty when all good). Only the fields Gaffer actually
// touches are checked; new fields are fine, missing ones are not.
export function envelopeProblems(events, opts) {
  opts = opts || {};
  var out = [];
  var init = firstOf(events, function (e) { return e && e.type === 'system' && e.subtype === 'init'; });
  var assistant = firstOf(events, function (e) { return e && e.type === 'assistant'; });
  var result = firstOf(events, function (e) { return e && e.type === 'result'; });

  if (opts.expectInit !== false) {
    if (!init) out.push('no system/init event');
    else {
      if (typeof init.claude_code_version !== 'string' || !/^\d+\.\d+\.\d+/.test(init.claude_code_version)) {
        out.push('system/init.claude_code_version is not an x.y.z string: ' + JSON.stringify(init.claude_code_version));
      }
      if (!Array.isArray(init.mcp_servers)) out.push('system/init.mcp_servers is not an array');
    }
  }
  if (opts.expectAssistant !== false) {
    if (!assistant) out.push('no assistant event');
    else {
      if (!assistant.message || !Array.isArray(assistant.message.content)) out.push('assistant.message.content is not an array');
      if (!assistant.message || typeof assistant.message.usage !== 'object' || assistant.message.usage === null) out.push('assistant.message.usage missing');
      if (opts.expectAssistantError && typeof assistant.error !== 'string') out.push('assistant.error missing on an API failure');
      if (opts.expectAssistantError && assistant.is_api_error_message !== true) out.push('assistant.is_api_error_message is not true on an API failure');
    }
  }
  if (!result) out.push('no result event');
  else {
    if (typeof result.subtype !== 'string') out.push('result.subtype is not a string');
    if (typeof result.is_error !== 'boolean') out.push('result.is_error is not a boolean');
    if (typeof result.session_id !== 'string') out.push('result.session_id is not a string');
    if (typeof result.num_turns !== 'number') out.push('result.num_turns is not a number');
    if (result.is_error && result.result !== undefined && typeof result.result !== 'string') out.push('result.result is not a string');
    if (result.errors !== undefined && !Array.isArray(result.errors)) out.push('result.errors is not an array');
  }
  return out;
}

// Replays a captured run through the real classifier.
export function classifyCapture(events, exitCode, stderr, resuming) {
  var st = newTurnState(resuming);
  events.forEach(function (e) { observe(st, e); });
  return { st: st, verdict: classify(st, exitCode, stderr) };
}

// Signs that a probe was not the $0 signed-out failure it must be: a result
// that succeeded (the child is signed in somewhere) or that reports money
// spent. Any entry here aborts the run before the next probe.
export function paidTurnProblems(events) {
  var out = [];
  var result = firstOf(events, function (e) { return e && e.type === 'result'; });
  if (!result) return out;
  if (result.is_error === false) out.push('the turn SUCCEEDED (subtype=' + result.subtype + '): this run is signed in or has a backend configured');
  var cost = result.total_cost_usd;
  if (typeof cost === 'number' && cost > 0) out.push('result reports total_cost_usd=' + cost + ': this probe cost money');
  return out;
}

// The config dir the child gets: a fresh temp dir unless --config-dir named
// one. Returns {dir, refusal}; refusal is set when the chosen dir holds
// credentials, and the run must not start.
export function chooseConfigDir(flagDir, exists) {
  exists = exists || existsSync;
  var dir = flagDir ? resolve(flagDir) : mkdtempSync(join(tmpdir(), 'gaffer-cli-contract-cfg-'));
  var creds = join(dir, '.credentials.json');
  if (exists(creds)) {
    return { dir: dir, refusal: 'REFUSING to run: ' + creds + ' exists, so a -p probe would be a signed-in paid turn. Pass a config dir without credentials, or none.' };
  }
  return { dir: dir, refusal: null };
}

// The child environment: the caller's env with the sign-in and backend
// switches removed, and HOME, USERPROFILE and CLAUDE_CONFIG_DIR pointed at
// the throwaway dirs. An exported CLAUDE_CONFIG_DIR never reaches the child.
export function childEnv(baseEnv, homeDir, configDir) {
  var env = Object.assign({}, baseEnv);
  SCRUBBED_ENV.forEach(function (k) { delete env[k]; });
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

// ---------- process plumbing ----------

function run(bin, args, opts) {
  opts = opts || {};
  return new Promise(function (done) {
    var child;
    try {
      child = execFile(bin, args, {
        env: opts.env || process.env,
        cwd: opts.cwd,
        timeout: SPAWN_TIMEOUT_MS,
        // A CLI that ignores SIGTERM must not hang the job.
        killSignal: 'SIGKILL',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf-8',
      }, function (err, stdout, stderr) {
        done({
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          signal: err && err.signal ? err.signal : null,
          timedOut: !!(err && err.killed),
          spawnError: err && typeof err.code === 'string' ? err.code : null,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      });
    } catch (e) {
      return done({ code: null, signal: null, timedOut: false, spawnError: e.message, stdout: '', stderr: '' });
    }
    if (opts.stdin !== undefined && child && child.stdin) {
      child.stdin.on('error', function () {});
      child.stdin.end(opts.stdin);
    }
  });
}

// `claude --help` exits before a PIPED stdout is fully flushed: through
// execFile the 2.1.286 to 2.1.294 help text stops after about 230 of 311
// lines, and --verbose happens to sit in the lost tail. A file redirect gets
// all of it (file writes are synchronous), so long outputs go through a
// temp file instead of a pipe.
function runToFile(bin, args, opts) {
  opts = opts || {};
  return new Promise(function (done) {
    var outPath = join(mkdtempSync(join(tmpdir(), 'gaffer-cli-contract-out-')), 'stdout.txt');
    var fd;
    try { fd = openSync(outPath, 'w'); } catch (e) {
      return done({ code: null, signal: null, timedOut: false, spawnError: e.message, stdout: '', stderr: '' });
    }
    var stderr = '', finished = false, timedOut = false, timer = null, killTimer = null, lastResort = null;
    function end(res) {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(lastResort);
      try { closeSync(fd); } catch (e) { /* already closed */ }
      try { res.stdout = readFileSync(outPath, 'utf-8'); } catch (e) { res.stdout = ''; }
      res.stderr = stderr;
      res.timedOut = timedOut;
      done(res);
    }
    var child;
    try {
      child = spawn(bin, args, { env: opts.env || process.env, cwd: opts.cwd, stdio: ['ignore', fd, 'pipe'], windowsHide: true });
    } catch (e) {
      return end({ code: null, signal: null, timedOut: false, spawnError: e.message });
    }
    child.stderr.on('data', function (c) { stderr += c.toString(); });
    child.on('error', function (e) { end({ code: null, signal: null, timedOut: false, spawnError: e.code || e.message }); });
    child.on('close', function (code, signal) { end({ code: code, signal: signal, timedOut: false, spawnError: null }); });
    // On timeout: SIGTERM, then SIGKILL after a grace period for a CLI that
    // ignores SIGTERM, then give up waiting for 'close' shortly after that
    // (a stdout fd inherited by a grandchild could otherwise hold it open).
    timer = setTimeout(function () {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (e) { /* gone */ }
      killTimer = setTimeout(function () {
        try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
        lastResort = setTimeout(function () {
          end({ code: null, signal: 'SIGKILL', timedOut: true, spawnError: null });
        }, 1000);
      }, KILL_GRACE_MS);
    }, SPAWN_TIMEOUT_MS);
  });
}

function parseArgs(argv) {
  var out = { bin: process.env.CLAUDE_BIN || 'claude', out: null, configDir: null };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--bin' && argv[i + 1]) out.bin = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (argv[i] === '--config-dir' && argv[i + 1]) out.configDir = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

function save(dir, name, r) {
  if (!dir) return;
  try {
    writeFileSync(join(dir, name + '.out'), r.stdout);
    writeFileSync(join(dir, name + '.err'), r.stderr);
  } catch (e) { /* captures are a convenience */ }
}

export async function main(argv) {
  var opts = parseArgs(argv);
  if (opts.help) {
    console.log('usage: node scripts/cli-contract-check.mjs [--bin <claude>] [--out <capture dir>] [--config-dir <dir without credentials>]');
    return 0;
  }
  var failures = [];
  var notes = [];
  function check(name, ok, detail) {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ': ' + detail : ''));
    if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
  }
  // A probe that turned out to be signed in or to cost money: say so loudly
  // and stop before the next probe could do the same.
  function abortIfPaid(name, events) {
    var problems = paidTurnProblems(events);
    if (!problems.length) return false;
    problems.forEach(function (p) { check(name + ' is a $0 signed-out failure', false, p); });
    console.log('');
    console.log('ABORTING: a probe was not the signed-out $0 failure this check relies on. No further probes were run.');
    return true;
  }

  // Signed-out environment: fresh temp HOME and config dir, never the
  // caller's (an exported CLAUDE_CONFIG_DIR is ignored on purpose).
  var chosen = chooseConfigDir(opts.configDir);
  if (chosen.refusal) {
    console.log(chosen.refusal);
    return 1;
  }
  var configDir = chosen.dir;
  var homeDir = mkdtempSync(join(tmpdir(), 'gaffer-cli-contract-home-'));
  var cwd = mkdtempSync(join(tmpdir(), 'gaffer-cli-contract-cwd-'));
  var env = childEnv(process.env, homeDir, configDir);
  if (opts.out) { try { mkdirSync(opts.out, { recursive: true }); } catch (e) { /* fine */ } }

  console.log('binary: ' + opts.bin);
  console.log('config dir: ' + configDir + (opts.configDir ? ' (from --config-dir, no credentials file)' : ' (fresh, signed out)'));
  console.log('home: ' + homeDir + ' (fresh)');
  console.log('tested range in cli-contract.js: ' + LAST_VERIFIED.min + ' to ' + LAST_VERIFIED.max);

  // 1. --version
  var ver = await run(opts.bin, ['--version'], { env: env, cwd: cwd });
  save(opts.out, 'version', ver);
  if (ver.spawnError) {
    check('--version runs', false, 'could not run ' + opts.bin + ' (' + ver.spawnError + ')');
    return finish(failures, notes, null);
  }
  var version = parseVersionLine(ver.stdout);
  check('--version prints x.y.z', !!version, version || JSON.stringify(ver.stdout.slice(0, 200)));
  if (version) {
    var status = versionStatus(version);
    notes.push('claude ' + version + ' is ' + (status === 'ok' ? 'inside' : status + ' than') + ' the tested range ' + LAST_VERIFIED.min + ' to ' + LAST_VERIFIED.max);
  }

  // 2. --help flags and effort choices
  var help = await runToFile(opts.bin, ['--help'], { env: env, cwd: cwd });
  save(opts.out, 'help', help);
  check('--help runs', help.code === 0 && help.stdout.length > 0, 'exit=' + help.code + ' ' + help.stdout.split('\n').length + ' lines');
  var missing = missingFlags(help.stdout);
  check('--help lists every flag Gaffer passes', missing.length === 0, missing.length ? 'missing ' + missing.join(', ') : REQUIRED_FLAGS.length + ' flags present');
  var choices = parseEffortChoices(help.stdout);
  var missingE = missingEfforts(choices);
  check('--effort choices cover Gaffer levels', choices.length > 0 && missingE.length === 0,
    choices.length ? 'help lists (' + choices.join(', ') + ')' + (missingE.length ? ', missing ' + missingE.join(', ') : '') : 'no choices parsed from help');

  // 3. bad --resume: structured stale-session shape, no credentials needed
  var resume = await run(opts.bin, ['-p', '--output-format', 'stream-json', '--verbose', '--resume', ZERO_UUID], { env: env, cwd: cwd, stdin: 'hi' });
  save(opts.out, 'resume', resume);
  if (resume.timedOut) check('bad --resume finishes', false, 'timed out after ' + SPAWN_TIMEOUT_MS + ' ms');
  else {
    var rp = parseStreamLines(resume.stdout);
    if (abortIfPaid('bad --resume', rp.events)) return finish(failures, notes, version);
    check('bad --resume stdout is JSON lines', rp.badLines.length === 0 && rp.events.length > 0, rp.badLines.length ? 'non-JSON: ' + rp.badLines[0] : rp.events.length + ' event(s)');
    var rc = classifyCapture(rp.events, resume.code, resume.stderr, true);
    check('bad --resume classifies stale_session via structure', rc.verdict.kind === 'stale_session' && rc.verdict.via === 'structure',
      'kind=' + rc.verdict.kind + ' via=' + rc.verdict.via + ' exit=' + resume.code);
    var rprob = envelopeProblems(rp.events, { expectInit: false, expectAssistant: false });
    check('bad --resume result envelope parses', rprob.length === 0, rprob.join('; '));
  }

  // 4. signed-out turn: init with version, auth failure, envelopes
  var turn = await run(opts.bin, ['-p', '--output-format', 'stream-json', '--verbose'], { env: env, cwd: cwd, stdin: 'hi' });
  save(opts.out, 'signed-out', turn);
  if (turn.timedOut) check('signed-out turn finishes', false, 'timed out after ' + SPAWN_TIMEOUT_MS + ' ms (did it wait for a login?)');
  else {
    var tp = parseStreamLines(turn.stdout);
    if (abortIfPaid('signed-out turn', tp.events)) return finish(failures, notes, version);
    check('signed-out turn stdout is JSON lines', tp.badLines.length === 0 && tp.events.length > 0, tp.badLines.length ? 'non-JSON: ' + tp.badLines[0] : tp.events.length + ' event(s)');
    var tc = classifyCapture(tp.events, turn.code, turn.stderr, false);
    check('signed-out turn reports claude_code_version in init', !!tc.st.cliVersion, tc.st.cliVersion || 'none');
    if (tc.st.cliVersion && version) {
      check('init version matches --version', parseVersionLine(tc.st.cliVersion) === version, tc.st.cliVersion + ' vs ' + version);
    }
    check('signed-out turn classifies auth via structure', tc.verdict.kind === 'auth' && tc.verdict.via === 'structure',
      'kind=' + tc.verdict.kind + ' via=' + tc.verdict.via + ' exit=' + turn.code + (tc.st.assistantError ? ' assistant.error=' + tc.st.assistantError : ''));
    var tprob = envelopeProblems(tp.events, { expectAssistantError: true });
    check('init / assistant / result envelopes parse', tprob.length === 0, tprob.join('; '));
    if (Object.keys(tc.st.unknownTypes).length) notes.push('unknown event types seen (ignored by Gaffer): ' + Object.keys(tc.st.unknownTypes).join(', '));
  }

  // Informational: stream-json without --verbose. Gaffer always passes
  // --verbose, so a change here is worth a note, not a failure.
  var nov = await run(opts.bin, ['-p', '--output-format', 'stream-json'], { env: env, cwd: cwd, stdin: 'hi' });
  save(opts.out, 'no-verbose', nov);
  if (abortIfPaid('stream-json without --verbose', parseStreamLines(nov.stdout).events)) return finish(failures, notes, version);
  notes.push('stream-json without --verbose: exit ' + nov.code + (/requires --verbose/.test(nov.stderr) ? ', still requires --verbose' : ', NO LONGER says it requires --verbose (harmless, Gaffer passes it anyway)'));

  return finish(failures, notes, version);
}

function finish(failures, notes, version) {
  console.log('');
  notes.forEach(function (n) { console.log('note: ' + n); });
  if (failures.length) {
    console.log('');
    console.log('CLI CONTRACT CHECK FAILED against claude ' + (version || 'unknown') + ' (' + failures.length + ' problem' + (failures.length === 1 ? '' : 's') + '):');
    failures.forEach(function (f) { console.log('  - ' + f); });
    console.log('Gaffer\'s chat layer may misread this CLI. Compare the captures with panel/daemon/test/fixtures/cli and update cli-contract.js.');
    return 1;
  }
  console.log('CLI contract check passed against claude ' + (version || 'unknown') + '.');
  return 0;
}

// Run only when invoked directly (the test file imports the helpers).
var invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(function (code) { process.exit(code); }, function (e) {
    console.error('cli-contract-check crashed: ' + (e && e.stack || e));
    process.exit(1);
  });
}
